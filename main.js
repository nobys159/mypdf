const { app, BrowserWindow, dialog, ipcMain, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const signer = require('node-signpdf').default;
const { plainAddPlaceholder, findByteRange } = require('node-signpdf/dist/helpers');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const { spawnSync } = require('child_process');

const SIGNATURE_DETAILS_KEYWORD_PREFIX = 'mypdf-signature-details:';

function findQpdfCmd() {
  try {
    // Prefer repository vendor qpdf during development
    const repoRoot = path.join(__dirname, 'vendor', 'qpdf');
    const repoBundled = path.join(repoRoot, process.platform === 'win32' ? 'win64\\qpdf.exe' : 'qpdf');
    if (repoBundled && fs.existsSync(repoBundled)) return repoBundled;
    // Also check for extracted release folders that place the runtime under a nested bin directory
    try {
      const win64Dir = path.join(repoRoot, 'win64');
      if (fs.existsSync(win64Dir)) {
        const entries = fs.readdirSync(win64Dir);
        for (const e of entries) {
          const candidate = path.join(win64Dir, e, 'bin', process.platform === 'win32' ? 'qpdf.exe' : 'qpdf');
          if (fs.existsSync(candidate)) return candidate;
        }
      }
    } catch (e) {
      // ignore
    }
    const bundled = path.join(process.resourcesPath || '', 'qpdf', process.platform === 'win32' ? 'qpdf.exe' : 'qpdf');
    if (bundled && fs.existsSync(bundled)) return bundled;
  } catch (e) {
    // ignore
  }
  return 'qpdf';
}

const debugLogPath = path.join(os.tmpdir(), 'mypdf-argv.log');

function appendArgLog(label, argv) {
  try {
    const time = new Date().toISOString();
    const lines = [`[${time}] ${label}`];
    for (let i = 0; i < argv.length; i++) {
      lines.push(`${i}: ${argv[i]}`);
    }
    lines.push('');
    fs.appendFileSync(debugLogPath, lines.join(os.EOL));
  } catch (e) {
    // ignore logging errors
  }
}

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.loadFile('index.html');
}

function findPdfArg(argv) {
  if (!Array.isArray(argv)) return null;
  for (const arg of argv) {
    try {
      if (typeof arg === 'string' && arg.toLowerCase().endsWith('.pdf') && fs.existsSync(arg)) {
        return path.resolve(arg);
      }
    } catch (e) {
      // ignore
    }
  }
  return null;
}

function createMenu() {
  const template = [
    {
      label: 'File',
      submenu: [
        {
          label: 'Open PDF',
          accelerator: 'CmdOrCtrl+O',
          click: () => {
            mainWindow?.webContents.send('menu-open-pdf');
          }
        },
        {
          label: 'Close PDF',
          accelerator: 'CmdOrCtrl+W',
          click: () => {
            mainWindow?.webContents.send('menu-close-pdf');
          }
        },
        { type: 'separator' },
        process.platform === 'darwin' ? { role: 'close' } : { role: 'quit' }
      ]
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    { role: 'help' }
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

const gotLock = app.requestSingleInstanceLock();

if (!gotLock) {
  app.quit();
} else {
  appendArgLog('startup', process.argv || []);
  app.whenReady().then(() => {
    createMenu();
    createWindow();

    // If launched with a PDF argument, open it after the window loads
    const initialPdf = findPdfArg(process.argv);
    if (initialPdf) {
      mainWindow.webContents.once('did-finish-load', () => {
        mainWindow.webContents.send('open-file', initialPdf);
      });
    }

    app.on('activate', function () {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  // Handle when another instance is launched (e.g., user double-clicks a file or uses Open with...)
  app.on('second-instance', (event, argv) => {
    appendArgLog('second-instance', argv || []);
    const pdf = findPdfArg(argv);
    if (pdf && mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
      mainWindow.webContents.send('open-file', pdf);
    }
  });
}

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') app.quit();
});

// Return details for all embedded CMS signatures found in the PDF
ipcMain.handle('get-all-signature-details', async (_event, pdfPath) => {
  try {
    if (!pdfPath) throw new Error('Missing pdfPath');
    const psPath = path.join(__dirname, 'scripts', 'get_signature_details.ps1');
    const winPs = path.join(process.env.windir || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const res = spawnSync(winPs, ['-NoProfile', '-NonInteractive', '-File', psPath, pdfPath], { encoding: 'utf8' });
    if (res.error) throw res.error;
    if (res.status !== 0) {
      const stderr = res.stderr || res.stdout || '';
      throw new Error(stderr || 'PowerShell error');
    }
    const out = (res.stdout || '').trim() || '[]';
    try {
      return JSON.parse(out);
    } catch (e) {
      return { error: 'Failed to parse signature details: ' + e.message };
    }
  } catch (err) {
    return { error: err.message || String(err) };
  }
});


ipcMain.handle('show-open-dialog', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [{ name: 'PDF', extensions: ['pdf'] }]
  });
  if (canceled) return null;
  return filePaths[0];
});

ipcMain.handle('show-save-dialog', async (_event, defaultPath) => {
  const { canceled, filePath } = await dialog.showSaveDialog({
    defaultPath,
    filters: [{ name: 'PDF', extensions: ['pdf'] }]
  });
  if (canceled) return null;
  return filePath;
});

ipcMain.handle('select-pfx', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [{ name: 'PFX', extensions: ['p12', 'pfx'] }]
  });
  if (canceled) return null;
  return filePaths[0];
});

ipcMain.handle('sign-pdf', async (_event, pdfPath, pfxPath, passphrase) => {
  try {
    if (!pdfPath || !pfxPath) throw new Error('Missing pdf or pfx path');
    const pdfBuffer = fs.readFileSync(pdfPath);
    const p12Buffer = fs.readFileSync(pfxPath);

    // Add a placeholder for the signature
    let pdfWithPlaceholder;
    try {
      pdfWithPlaceholder = plainAddPlaceholder({ pdfBuffer, reason: 'Signed by mypdf', signatureLength: 8192 });
    } catch (err) {
      // try qpdf fallback
      try {
        const qpdfCmd = findQpdfCmd();
        const qpdfCheck = spawnSync(qpdfCmd, ['--version'], { encoding: 'utf8' });
        if (!qpdfCheck || qpdfCheck.status !== 0) throw new Error('qpdf not available');
        const tmp = os.tmpdir();
        const converted = path.join(tmp, `mypdf-qpdf-${Date.now()}.pdf`);
        const qres = spawnSync(qpdfCmd, ['--qdf', '--object-streams=disable', pdfPath, converted], { encoding: 'utf8' });
        try { fs.appendFileSync(debugLogPath, `qpdf rewrite output:\n${qres.stdout||''}\n${qres.stderr||''}${os.EOL}`); } catch (e) {}
        if (qres.error || qres.status !== 0) throw new Error('qpdf rewrite failed: ' + (qres.stderr || qres.stdout || ''));
        const convertedBuf = fs.readFileSync(converted);
        pdfWithPlaceholder = plainAddPlaceholder({ pdfBuffer: convertedBuf, reason: 'Signed by mypdf', signatureLength: 8192 });
      } catch (qerr) {
        throw new Error(`Could not add signature placeholder: ${err.message}. qpdf fallback failed: ${qerr.message}`);
      }
    }

    // Sign the PDF
    const signedPdf = signer.sign(pdfWithPlaceholder, p12Buffer, { passphrase: passphrase || '' });

    const outPath = pdfPath.replace(/\.pdf$/i, '-signed.pdf');
    fs.writeFileSync(outPath, signedPdf);
    return { success: true, path: outPath };
  } catch (err) {
    return { success: false, error: err.message || String(err) };
  }
});

function parseCertificateSelection(selection) {
  if (!selection || typeof selection !== 'string') {
    return { store: 'CurrentUser', thumbprint: selection };
  }

  const parts = selection.split('|');
  if (parts.length === 2) {
    return {
      store: parts[0] === 'LocalMachine' ? 'LocalMachine' : 'CurrentUser',
      thumbprint: parts[1]
    };
  }

  return { store: 'CurrentUser', thumbprint: selection };
}

function preparePdfForExternalSignature(pdfBuffer) {
  const { byteRangePlaceholder } = findByteRange(pdfBuffer);
  if (!byteRangePlaceholder) {
    throw new Error('Empty ByteRange placeholder not found after placeholder insertion');
  }

  const byteRangePos = pdfBuffer.indexOf(byteRangePlaceholder);
  const byteRangeEnd = byteRangePos + byteRangePlaceholder.length;
  const contentsTagPos = pdfBuffer.indexOf('/Contents ', byteRangeEnd);
  if (contentsTagPos < 0) throw new Error('/Contents placeholder not found');

  const placeholderStart = pdfBuffer.indexOf('<', contentsTagPos);
  const placeholderEnd = pdfBuffer.indexOf('>', placeholderStart);
  if (placeholderStart < 0 || placeholderEnd < 0) {
    throw new Error('/Contents placeholder is malformed');
  }

  const placeholderLengthWithBrackets = placeholderEnd + 1 - placeholderStart;
  const placeholderLength = placeholderLengthWithBrackets - 2;
  const byteRange = [
    0,
    placeholderStart,
    placeholderStart + placeholderLengthWithBrackets,
    pdfBuffer.length - (placeholderStart + placeholderLengthWithBrackets)
  ];

  let actualByteRange = `/ByteRange [${byteRange.join(' ')}]`;
  if (actualByteRange.length > byteRangePlaceholder.length) {
    throw new Error('ByteRange placeholder is too short');
  }
  actualByteRange += ' '.repeat(byteRangePlaceholder.length - actualByteRange.length);

  const pdfWithByteRange = Buffer.concat([
    pdfBuffer.slice(0, byteRangePos),
    Buffer.from(actualByteRange, 'ascii'),
    pdfBuffer.slice(byteRangeEnd)
  ]);

  return {
    pdfWithByteRange,
    byteRange,
    placeholderStart,
    placeholderEnd,
    placeholderLength,
    dataToSign: Buffer.concat([
      pdfWithByteRange.slice(byteRange[0], byteRange[0] + byteRange[1]),
      pdfWithByteRange.slice(byteRange[2], byteRange[2] + byteRange[3])
    ])
  };
}

function readDerLength(buffer) {
  if (!buffer || buffer.length < 2 || buffer[0] !== 0x30) return buffer.length;
  const firstLengthByte = buffer[1];
  if (firstLengthByte < 0x80) return Math.min(buffer.length, 2 + firstLengthByte);
  const lengthByteCount = firstLengthByte & 0x7f;
  if (buffer.length < 2 + lengthByteCount) return buffer.length;
  let length = 0;
  for (let index = 0; index < lengthByteCount; index += 1) {
    length = (length << 8) + buffer[2 + index];
  }
  return Math.min(buffer.length, 2 + lengthByteCount + length);
}

function extractPdfSignatures(pdfBuffer) {
  const pdfText = pdfBuffer.toString('binary');
  const byteRangeRegex = /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/g;
  const signatures = [];
  let match;

  while ((match = byteRangeRegex.exec(pdfText)) !== null) {
    const byteRange = match.slice(1).map((value) => parseInt(value, 10));
    const byteRangeEnd = match.index + match[0].length;
    const contentsMatch = /\/Contents\s*<([0-9A-Fa-f\s]+)>/.exec(pdfText.slice(byteRangeEnd));
    if (!contentsMatch) continue;

    const signatureHex = contentsMatch[1].replace(/\s/g, '');
    const paddedSignature = Buffer.from(signatureHex, 'hex');
    const signature = paddedSignature.slice(0, readDerLength(paddedSignature));
    const [a, b, c, d] = byteRange;
    signatures.push({
      byteRange,
      signature,
      signedData: Buffer.concat([
        pdfBuffer.slice(a, a + b),
        pdfBuffer.slice(c, c + d)
      ])
    });
  }

  return signatures;
}

function verifyCmsSignature(signedData, signature) {
  const tmp = os.tmpdir();
  const dataPath = path.join(tmp, `mypdf-verify-data-${Date.now()}.bin`);
  const sigPath = path.join(tmp, `mypdf-verify-sig-${Date.now()}.bin`);
  const psPath = path.join(tmp, `mypdf-verify-${Date.now()}.ps1`);
  fs.writeFileSync(dataPath, signedData);
  fs.writeFileSync(sigPath, signature);

  const psScript = `Param($dataPath, $sigPath)
$ErrorActionPreference = "Stop"
try {
  Add-Type -AssemblyName System.Security
  $bytes = [System.IO.File]::ReadAllBytes($dataPath)
  $sig = [System.IO.File]::ReadAllBytes($sigPath)
  $contentInfo = [System.Security.Cryptography.Pkcs.ContentInfo]::new([byte[]]$bytes)
  $signedCms = [System.Security.Cryptography.Pkcs.SignedCms]::new($contentInfo, $true)
  $signedCms.Decode($sig)
  $integrityValid = $false
  $trusted = $false
  $errorMessage = ""
  try {
    # First verify signature integrity (do not require chain validation).
    $signedCms.CheckSignature($false)
    $integrityValid = $true
  } catch {
    $errorMessage = $_.Exception.Message
  }
  if ($integrityValid) {
    try {
      # Then attempt to validate the signing certificate chain/trust.
      $signedCms.CheckSignature($true)
      $trusted = $true
    } catch {
      if ([string]::IsNullOrWhiteSpace($errorMessage)) {
        $errorMessage = $_.Exception.Message
      }
    }
  }
  $cert = $null
  if ($signedCms.SignerInfos.Count -gt 0) {
    $cert = $signedCms.SignerInfos[0].Certificate
  }
  if ($null -eq $cert -and $signedCms.Certificates.Count -gt 0) {
    $cert = $signedCms.Certificates[0]
  }
  [PSCustomObject]@{
    integrityValid = $integrityValid
    trusted = $trusted
    error = $errorMessage
    subject = if ($cert) { $cert.Subject } else { "" }
    issuer = if ($cert) { $cert.Issuer } else { "" }
    thumbprint = if ($cert) { ($cert.Thumbprint -replace "\\s", "") } else { "" }
    notBefore = if ($cert) { $cert.NotBefore } else { "" }
    notAfter = if ($cert) { $cert.NotAfter } else { "" }
  } | ConvertTo-Json -Depth 3
} catch {
  [PSCustomObject]@{
    integrityValid = $false
    trusted = $false
    error = $_.Exception.Message
    subject = ""
    issuer = ""
    thumbprint = ""
    notBefore = ""
    notAfter = ""
  } | ConvertTo-Json -Depth 3
  exit 1
}
`;
  fs.writeFileSync(psPath, psScript, { encoding: 'utf8' });

  try {
    const winPs = path.join(process.env.windir || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const result = spawnSync(winPs, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', psPath, dataPath, sigPath], { encoding: 'utf8' });
    const output = (result.stdout || '').trim();
    if (!output) {
      // write debug artifacts to help diagnose signature mismatches
      try {
        const dbgFile = path.join(tmp, `mypdf-verify-dbg-${Date.now()}.txt`);
        const crypto = require('crypto');
        const hash = crypto.createHash('sha256').update(signedData).digest('hex');
        const sigHex = Buffer.from(signature || []).toString('hex');
        const dbg = [
          `signedDataPath=${dataPath}`,
          `signaturePath=${sigPath}`,
          `sha256(signedData)=${hash}`,
          `signatureHexLen=${sigHex.length}`,
          `stderr=${result.stderr || ''}`
        ].join('\n');
        fs.writeFileSync(dbgFile, dbg, { encoding: 'utf8' });
        return { integrityValid: false, trusted: false, error: result.stderr || result.error?.message || 'Verification failed', debug: dbgFile };
      } catch (e) {
        return { integrityValid: false, trusted: false, error: result.stderr || result.error?.message || 'Verification failed' };
      }
    }
    return JSON.parse(output);
  } finally {
    try { fs.unlinkSync(dataPath); fs.unlinkSync(sigPath); fs.unlinkSync(psPath); } catch (e) {}
  }
}

// Dump signature extraction debug info for a PDF (byte ranges, lengths)
ipcMain.handle('dump-signature-debug', async (_event, pdfPath) => {
  try {
    if (!pdfPath) throw new Error('Missing pdfPath');
    const buf = fs.readFileSync(pdfPath);
    const sigs = extractPdfSignatures(buf);
    const out = sigs.map((s, idx) => ({
      index: idx,
      byteRange: s.byteRange,
      signatureLength: s.signature ? s.signature.length : 0,
      signedDataLength: s.signedData ? s.signedData.length : 0
    }));
    return out;
  } catch (err) {
    return { error: err.message || String(err) };
  }
});

function getCommonNameFromCertificateSubject(subject) {
  if (!subject || typeof subject !== 'string') return 'Selected certificate';
  const match = /(?:^|,\s*)CN=([^,]+)/i.exec(subject);
  return match ? match[1].trim() : subject.split(',')[0].trim();
}

function inferSignatureType(subject) {
  if (!subject) return 'Unknown';
  if (/(?:^|,\s*)O=/i.test(subject) || /OID\.2\.5\.4\.10=/i.test(subject)) {
    return 'Organizational';
  }
  return 'Individual';
}

function normalizeKeywords(keywords) {
  if (!keywords) return [];
  if (Array.isArray(keywords)) return keywords.filter(Boolean);
  return String(keywords)
    .split(/[;,]/)
    .map((keyword) => keyword.trim())
    .filter(Boolean);
}

function encodeSignatureDetails(details) {
  return `${SIGNATURE_DETAILS_KEYWORD_PREFIX}${Buffer.from(JSON.stringify(details), 'utf8').toString('base64')}`;
}

function fitTextSize(text, maxWidth, font, startingSize, minimumSize) {
  let size = startingSize;
  while (size > minimumSize && font.widthOfTextAtSize(text, size) > maxWidth) {
    size -= 0.5;
  }
  return size;
}

function trimTextToWidth(text, maxWidth, font, size) {
  if (font.widthOfTextAtSize(text, size) <= maxWidth) return text;
  const ellipsis = '...';
  let trimmed = text;
  while (trimmed.length > 1 && font.widthOfTextAtSize(`${trimmed}${ellipsis}`, size) > maxWidth) {
    trimmed = trimmed.slice(0, -1);
  }
  return `${trimmed}${ellipsis}`;
}

function expandSignatureRect(rect, page) {
  const pageWidth = page.getWidth();
  const pageHeight = page.getHeight();
  const targetWidth = Math.min(Math.max(rect.width * 1.45, 170), pageWidth - 24);
  const targetHeight = Math.min(Math.max(rect.height * 2.25, 58), pageHeight - 24);
  const centerX = rect.x + rect.width / 2;
  const centerY = rect.y + rect.height / 2;
  let x = centerX - targetWidth / 2;
  let y = centerY - targetHeight / 2;

  x = Math.min(Math.max(12, x), pageWidth - targetWidth - 12);
  y = Math.min(Math.max(12, y), pageHeight - targetHeight - 12);

  return {
    x,
    y,
    width: targetWidth,
    height: targetHeight
  };
}

async function addVisibleSignatureAppearance(pdfBuffer, appearance) {
  if (!appearance || !appearance.rect || !Number.isInteger(appearance.pageIndex)) {
    return pdfBuffer;
  }

  const pdfDoc = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true });
  const page = pdfDoc.getPage(appearance.pageIndex);
  if (!page) return pdfBuffer;

  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const rect = expandSignatureRect(appearance.rect, page);
  const padding = Math.max(6, Math.min(10, rect.width * 0.06, rect.height * 0.16));
  const x = rect.x + padding;
  const y = rect.y + padding;
  const width = Math.max(1, rect.width - padding * 2);
  const height = Math.max(1, rect.height - padding * 2);
  const signerName = getCommonNameFromCertificateSubject(appearance.subject);
  const dateText = new Date().toLocaleString([], {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });
  const statusText = 'Digitally signed';
  const lineGap = Math.max(2, Math.min(5, height * 0.1));
  const statusSize = fitTextSize(statusText, width, font, Math.min(8, height * 0.18), 5);
  const nameSize = fitTextSize(signerName, width, boldFont, Math.min(12, height * 0.28), 6);
  const dateSize = fitTextSize(dateText, width, font, Math.min(8, height * 0.18), 5);
  const fittedStatus = trimTextToWidth(statusText, width, font, statusSize);
  const fittedName = trimTextToWidth(signerName, width, boldFont, nameSize);
  const fittedDate = trimTextToWidth(dateText, width, font, dateSize);
  const totalTextHeight = statusSize + lineGap + nameSize + lineGap + dateSize;
  const topY = y + Math.max(0, (height - totalTextHeight) / 2) + dateSize + lineGap + nameSize + lineGap;

  page.drawRectangle({
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
    borderColor: rgb(0.18, 0.35, 0.62),
    borderWidth: 0.75,
    color: rgb(0.96, 0.99, 1)
  });
  page.drawText(fittedStatus, {
    x,
    y: topY,
    size: statusSize,
    font,
    color: rgb(0.18, 0.35, 0.62)
  });
  page.drawText(fittedName, {
    x,
    y: topY - nameSize - lineGap,
    size: nameSize,
    font: boldFont,
    color: rgb(0.06, 0.12, 0.2)
  });
  page.drawText(fittedDate, {
    x,
    y: topY - nameSize - lineGap - dateSize - lineGap,
    size: dateSize,
    font,
    color: rgb(0.2, 0.28, 0.38)
  });

  const signedAt = appearance.signedAt || new Date().toISOString();
  const signatureDetails = {
    version: 1,
    label: appearance.label || 'Signature',
    pageIndex: appearance.pageIndex,
    rect: appearance.rect,
    displayRect: rect,
    signerName,
    subject: appearance.subject || '',
    issuer: appearance.issuer || '',
    thumbprint: appearance.thumbprint || '',
    store: appearance.store || '',
    signedAt,
    signatureType: appearance.signatureType || inferSignatureType(appearance.subject)
  };
  const keywords = normalizeKeywords(pdfDoc.getKeywords());
  keywords.push(encodeSignatureDetails(signatureDetails));
  pdfDoc.setKeywords(keywords);

  return Buffer.from(await pdfDoc.save({ useObjectStreams: false }));
}

// List available certificates that have private keys in common Windows personal stores.
ipcMain.handle('list-windows-certs', async () => {
  try {
    const winPs = path.join(process.env.windir || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const ps = `
$locations = @('CurrentUser', 'LocalMachine')
$items = foreach ($location in $locations) {
  $store = New-Object System.Security.Cryptography.X509Certificates.X509Store(
    'My',
    [System.Security.Cryptography.X509Certificates.StoreLocation]::$location
  )
  try {
    $store.Open([System.Security.Cryptography.X509Certificates.OpenFlags]::ReadOnly)
    foreach ($cert in $store.Certificates) {
      if ($cert.HasPrivateKey) {
        [PSCustomObject]@{
          Store = $location
          Thumbprint = ($cert.Thumbprint -replace '\\s', '')
          Subject = $cert.Subject
          NotAfter = $cert.NotAfter
          FriendlyName = $cert.FriendlyName
          Issuer = $cert.Issuer
        }
      }
    }
  } finally {
    $store.Close()
  }
}
@($items) | ConvertTo-Json -Depth 3
`;
    const res = spawnSync(winPs, ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8' });
    if (res.error) throw res.error;
    if (res.status !== 0) {
      const stderr = res.stderr || res.stdout || '';
      throw new Error(stderr || 'PowerShell error');
    }
    const out = res.stdout.trim();
    if (!out) return [];
    const parsed = JSON.parse(out);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch (err) {
    return { error: err.message || String(err) };
  }
});

ipcMain.handle('verify-pdf-signature', async (_event, pdfPath, expectedThumbprint) => {
  try {
    if (!pdfPath) throw new Error('Missing PDF path');
    const signatures = extractPdfSignatures(fs.readFileSync(pdfPath));
    if (signatures.length === 0) {
      return { success: false, integrityValid: false, trusted: false, error: 'No digital signature found in this PDF.' };
    }

    const normalizedExpected = expectedThumbprint ? String(expectedThumbprint).replace(/\s/g, '').toUpperCase() : '';
    let fallback = null;
    for (const signature of signatures) {
      const verified = verifyCmsSignature(signature.signedData, signature.signature);
      const normalizedActual = verified.thumbprint ? String(verified.thumbprint).replace(/\s/g, '').toUpperCase() : '';
      const result = {
        success: true,
        signatureCount: signatures.length,
        expectedThumbprint: normalizedExpected,
        thumbprintMatches: normalizedExpected ? normalizedActual === normalizedExpected : true,
        ...verified
      };
      if (!fallback) fallback = result;
      if (!normalizedExpected || normalizedActual === normalizedExpected) return result;
    }

    return fallback || { success: false, integrityValid: false, trusted: false, error: 'Unable to verify signature.' };
  } catch (err) {
    return { success: false, integrityValid: false, trusted: false, error: err.message || String(err) };
  }
});

// Sign PDF using a certificate thumbprint from a Windows personal certificate store.
ipcMain.handle('sign-pdf-with-thumbprint', async (_event, pdfPath, certificateSelection, appearance) => {
  try {
    const { store, thumbprint } = parseCertificateSelection(certificateSelection);
    if (!pdfPath || !thumbprint) throw new Error('Missing pdfPath or thumbprint');

    const pdfBuffer = await addVisibleSignatureAppearance(fs.readFileSync(pdfPath), appearance);
    let pdfWithPlaceholder;
    try {
      pdfWithPlaceholder = plainAddPlaceholder({ pdfBuffer, reason: 'Signed by mypdf', signatureLength: 32768 });
    } catch (err) {
      try {
        const qpdfCmd = findQpdfCmd();
        const qpdfCheck = spawnSync(qpdfCmd, ['--version'], { encoding: 'utf8' });
        if (!qpdfCheck || qpdfCheck.status !== 0) throw new Error('qpdf not available');
        const tmp = os.tmpdir();
        const converted = path.join(tmp, `mypdf-qpdf-${Date.now()}.pdf`);
        const qres = spawnSync(qpdfCmd, ['--qdf', '--object-streams=disable', pdfPath, converted], { encoding: 'utf8' });
        try {
          const dbg = `qpdf stdout:\n${qres.stdout || ''}\nqpdf stderr:\n${qres.stderr || ''}`;
          fs.appendFileSync(debugLogPath, dbg + os.EOL);
        } catch (e) {}
        if (qres.error || qres.status !== 0) throw new Error('qpdf rewrite failed: ' + (qres.stderr || qres.stdout || ''));
        pdfWithPlaceholder = plainAddPlaceholder({
          pdfBuffer: fs.readFileSync(converted),
          reason: 'Signed by mypdf',
          signatureLength: 32768
        });
      } catch (qerr) {
        throw new Error(`Could not add signature placeholder: ${err.message}. qpdf fallback failed: ${qerr.message}`);
      }
    }

    const prepared = preparePdfForExternalSignature(pdfWithPlaceholder);

    // Write dataToSign to temp file and prepare output sig file
    const tmp = os.tmpdir();
    const dataPath = path.join(tmp, `mypdf-data-${Date.now()}.bin`);
    const sigPath = path.join(tmp, `mypdf-sig-${Date.now()}.bin`);
    const psPath = path.join(tmp, `mypdf-sign-${Date.now()}.ps1`);
    fs.writeFileSync(dataPath, prepared.dataToSign);

    // PowerShell script to compute SignedCms (detached) using cert thumbprint
const psScript = `Param($dataPath, $thumbprint, $store, $outPath)
$ErrorActionPreference = "Stop"
try {
  Add-Type -AssemblyName System.Security
  $bytes = [System.IO.File]::ReadAllBytes($dataPath)
  $normalizedThumbprint = $thumbprint -replace "\\s", ""
  $storeLocation = if ($store -eq "LocalMachine") {
    [System.Security.Cryptography.X509Certificates.StoreLocation]::LocalMachine
  } else {
    [System.Security.Cryptography.X509Certificates.StoreLocation]::CurrentUser
  }
  $certStore = New-Object System.Security.Cryptography.X509Certificates.X509Store('My', $storeLocation)
  $cert = $null
  try {
    $certStore.Open([System.Security.Cryptography.X509Certificates.OpenFlags]::ReadOnly)
    foreach ($candidate in $certStore.Certificates) {
      if (($candidate.Thumbprint -replace "\\s", "") -eq $normalizedThumbprint) {
        $cert = $candidate
        break
      }
    }
  } finally {
    $certStore.Close()
  }
  if ($null -eq $cert) { throw "Certificate not found" }
  if (-not $cert.HasPrivateKey) { throw "Certificate does not have a private key" }
  $contentInfo = [System.Security.Cryptography.Pkcs.ContentInfo]::new([byte[]]$bytes)
  $signedCms = [System.Security.Cryptography.Pkcs.SignedCms]::new($contentInfo, $true)
  $cmsSigner = [System.Security.Cryptography.Pkcs.CmsSigner]::new($cert)
  $cmsSigner.IncludeOption = [System.Security.Cryptography.X509Certificates.X509IncludeOption]::WholeChain
  $cmsSigner.DigestAlgorithm = [System.Security.Cryptography.Oid]::new("2.16.840.1.101.3.4.2.1")
  $signedCms.ComputeSignature($cmsSigner, $false)
  [System.IO.File]::WriteAllBytes($outPath, $signedCms.Encode())
  if (-not (Test-Path -LiteralPath $outPath)) {
    throw "Signing did not create the output signature file."
  }
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
`;
    fs.writeFileSync(psPath, psScript, { encoding: 'utf8' });

    const winPs = path.join(process.env.windir || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const psExec = spawnSync(winPs, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', psPath, dataPath, thumbprint, store, sigPath], { encoding: 'utf8' });
    if (psExec.error) throw psExec.error;
    if (psExec.status !== 0) {
      const stderr = psExec.stderr || psExec.stdout || '';
      throw new Error(stderr || 'PowerShell signing failed');
    }

    if (!fs.existsSync(sigPath)) {
      const stderr = psExec.stderr || psExec.stdout || '';
      throw new Error(stderr || 'Signing did not create the signature output file');
    }

    const signature = fs.readFileSync(sigPath);
    const sigHex = signature.toString('hex');
    if (sigHex.length > prepared.placeholderLength) {
      throw new Error(`Signature too large for placeholder: ${sigHex.length} > ${prepared.placeholderLength}`);
    }
    const padded = sigHex + '0'.repeat(prepared.placeholderLength - sigHex.length);

    const finalPdf = Buffer.concat([
      prepared.pdfWithByteRange.slice(0, prepared.placeholderStart + 1),
      Buffer.from(padded, 'ascii'),
      prepared.pdfWithByteRange.slice(prepared.placeholderEnd)
    ]);

    const outPath = pdfPath.replace(/\.pdf$/i, '-signed.pdf');
    fs.writeFileSync(outPath, finalPdf);

    // Clean up temp files
    try { fs.unlinkSync(dataPath); fs.unlinkSync(sigPath); fs.unlinkSync(psPath); } catch (e) {}

    return { success: true, path: outPath };
  } catch (err) {
    return { success: false, error: err.message || String(err) };
  }
});
