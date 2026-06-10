const { app, BrowserWindow, dialog, ipcMain, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const signer = require('node-signpdf').default;
const { plainAddPlaceholder } = require('node-signpdf/dist/helpers');
const { spawnSync } = require('child_process');

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
    const pdfWithPlaceholder = plainAddPlaceholder({ pdfBuffer, reason: 'Signed by mypdf', signatureLength: 8192 });

    // Sign the PDF
    const signedPdf = signer.sign(pdfWithPlaceholder, p12Buffer, { passphrase: passphrase || '' });

    const outPath = pdfPath.replace(/\.pdf$/i, '-signed.pdf');
    fs.writeFileSync(outPath, signedPdf);
    return { success: true, path: outPath };
  } catch (err) {
    return { success: false, error: err.message || String(err) };
  }
});

// List available certificates in CurrentUser\My that have private keys
ipcMain.handle('list-windows-certs', async () => {
  try {
    const winPs = path.join(process.env.windir || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const ps = `Get-ChildItem Cert:\\CurrentUser\\My | Where-Object { $_.HasPrivateKey } | Select-Object Thumbprint, Subject, NotAfter, FriendlyName | ConvertTo-Json -Depth 2`;
    const res = spawnSync(winPs, ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8' });
    if (res.error) throw res.error;
    if (res.status !== 0) {
      // Provide clearer message when Cert: provider is unavailable
      const stderr = res.stderr || res.stdout || '';
      if (/DriveNotFoundException|Cannot find drive/i.test(stderr)) {
        throw new Error('PowerShell Cert: drive not found. Ensure Windows PowerShell is available on this system.');
      }
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

// Sign PDF using a certificate thumbprint from the Windows store (CurrentUser\My)
ipcMain.handle('sign-pdf-with-thumbprint', async (_event, pdfPath, thumbprint) => {
  try {
    if (!pdfPath || !thumbprint) throw new Error('Missing pdfPath or thumbprint');

    const pdfBuffer = fs.readFileSync(pdfPath);

    // Add placeholder
    const pdfWithPlaceholder = plainAddPlaceholder({ pdfBuffer, reason: 'Signed by mypdf', signatureLength: 16384 });

    // Read ByteRange from the PDF
    const pdfStr = pdfWithPlaceholder.toString('binary');
    const byteRangeMatch = /\/ByteRange \[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/.exec(pdfStr);
    if (!byteRangeMatch) throw new Error('ByteRange not found');
    const ranges = byteRangeMatch.slice(1).map((v) => parseInt(v, 10));
    const [a, b, c, d] = ranges;

    // Build the data that needs to be signed (concatenate the two ranges)
    const part1 = pdfWithPlaceholder.slice(a, a + b);
    const part2 = pdfWithPlaceholder.slice(c, c + d);
    const dataToSign = Buffer.concat([part1, part2]);

    // Write dataToSign to temp file and prepare output sig file
    const tmp = os.tmpdir();
    const dataPath = path.join(tmp, `mypdf-data-${Date.now()}.bin`);
    const sigPath = path.join(tmp, `mypdf-sig-${Date.now()}.bin`);
    const psPath = path.join(tmp, `mypdf-sign-${Date.now()}.ps1`);
    fs.writeFileSync(dataPath, dataToSign);

    // PowerShell script to compute SignedCms (detached) using cert thumbprint
    const psScript = `Param($dataPath, $thumbprint, $outPath)
$bytes = [System.IO.File]::ReadAllBytes($dataPath)
$cert = Get-ChildItem Cert:\\CurrentUser\\My | Where-Object { $_.Thumbprint -eq $thumbprint } | Select-Object -First 1
if ($null -eq $cert) { Write-Error "Certificate not found"; exit 2 }
$contentInfo = New-Object System.Security.Cryptography.Pkcs.ContentInfo -ArgumentList (,@($bytes))
$signedCms = New-Object System.Security.Cryptography.Pkcs.SignedCms -ArgumentList $contentInfo, $false
$cmsSigner = New-Object System.Security.Cryptography.Pkcs.CmsSigner $cert
$signedCms.ComputeSignature($cmsSigner)
[System.IO.File]::WriteAllBytes($outPath, $signedCms.Encode())
"`;
    fs.writeFileSync(psPath, psScript, { encoding: 'utf8' });

    const winPs = path.join(process.env.windir || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const psExec = spawnSync(winPs, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', psPath, dataPath, thumbprint, sigPath], { encoding: 'utf8' });
    if (psExec.error) throw psExec.error;
    if (psExec.status !== 0) {
      const stderr = psExec.stderr || psExec.stdout || '';
      throw new Error(stderr || 'PowerShell signing failed');
    }

    const signature = fs.readFileSync(sigPath);

    // Replace placeholder in PDF (/Contents <...>) with the PKCS#7 signature (hex) padded
    const contentsTag = '/Contents <';
    const idx = pdfWithPlaceholder.indexOf(contentsTag);
    if (idx === -1) throw new Error('/Contents tag not found');
    const start = pdfWithPlaceholder.indexOf('<', idx) + 1;
    const end = pdfWithPlaceholder.indexOf('>', start);
    if (start === -1 || end === -1) throw new Error('Malformed Contents placeholder');
    const placeholderLen = end - start;
    const sigHex = signature.toString('hex');
    if (sigHex.length > placeholderLen) throw new Error('Signature too large for placeholder');
    const padded = sigHex + '0'.repeat(placeholderLen - sigHex.length);

    // Create final PDF buffer
    const before = pdfWithPlaceholder.slice(0, start);
    const after = pdfWithPlaceholder.slice(end);
    const finalPdf = Buffer.concat([Buffer.from(before, 'binary'), Buffer.from(padded, 'ascii'), Buffer.from(after, 'binary')]);

    const outPath = pdfPath.replace(/\.pdf$/i, '-signed.pdf');
    fs.writeFileSync(outPath, finalPdf);

    // Clean up temp files
    try { fs.unlinkSync(dataPath); fs.unlinkSync(sigPath); fs.unlinkSync(psPath); } catch (e) {}

    return { success: true, path: outPath };
  } catch (err) {
    return { success: false, error: err.message || String(err) };
  }
});
