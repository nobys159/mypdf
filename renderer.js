const { ipcRenderer } = require('electron');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
require('pdfjs-dist/legacy/build/pdf.worker.entry.js');
const { PDFDocument, degrees } = require('pdf-lib');

const pdfjsBasePath = pathToFileURL(path.join(__dirname, 'node_modules', 'pdfjs-dist')).href + '/';
const SIGNATURE_DETAILS_KEYWORD_PREFIX = 'mypdf-signature-details:';

pdfjsLib.GlobalWorkerOptions.workerSrc = pathToFileURL(
  require.resolve('pdfjs-dist/legacy/build/pdf.worker.js')
).href;

const state = {
  filePath: null,
  pdfBytes: null,
  pdfDoc: null,
  pageNum: 1,
  scale: 1.2,
  placeMode: false,
  placements: [],
  pageOrder: [],
  pages: new Map(),
  // map pageId -> array of signature annotation objects {rect, annotation, id}
  signatureFields: new Map(),
  showSignaturePlaceholders: true,
  signedPath: null,
  signerFieldContext: null,
  signedSignatureDetails: [],
  hasDigitalSignature: false
};

ipcRenderer.on('open-file', async (_event, filePath) => {
  if (!filePath) return;
  try {
    await loadPdf(filePath);
  } catch (e) {
    setStatus(`Failed to open file: ${e.message}`);
  }
});

const viewerPane = document.getElementById('viewerPane');
const viewerContainer = document.getElementById('viewerContainer');
const thumbList = document.getElementById('thumbList');
const organizerPane = document.getElementById('organizerPane');
const signaturePane = document.getElementById('signaturePane');
const signatureCanvas = document.getElementById('signaturePad');
const signatureCtx = signatureCanvas.getContext('2d');

const ui = {
  openBtn: document.getElementById('openBtn'),
  prevBtn: document.getElementById('prevBtn'),
  nextBtn: document.getElementById('nextBtn'),
  zoomInBtn: document.getElementById('zoomIn'),
  zoomOutBtn: document.getElementById('zoomOut'),
  placeBtn: document.getElementById('placeBtn'),
  clearLastBtn: document.getElementById('clearLastBtn'),
  clearAllBtn: document.getElementById('clearAllBtn'),
  saveBtn: document.getElementById('saveBtn'),
  printBtn: document.getElementById('printBtn'),
  pageInfo: document.getElementById('pageInfo'),
  status: document.getElementById('status'),
  signMarkedBtn: document.getElementById('signMarkedBtn'),
  clearSignatureBtn: document.getElementById('clearSignatureBtn'),
  signerModal: document.getElementById('signerModal'),
  closeSignerModalBtn: document.getElementById('closeSignerModalBtn'),
  signerFieldInfo: document.getElementById('signerFieldInfo'),
  signedResult: document.getElementById('signedResult'),
  signatureDetailsModal: document.getElementById('signatureDetailsModal'),
  closeSignatureDetailsBtn: document.getElementById('closeSignatureDetailsBtn'),
  signatureDetailsBody: document.getElementById('signatureDetailsBody'),
  certificateSelect: document.getElementById('certificateSelect'),
  refreshCertsBtn: document.getElementById('refreshCertsBtn'),
  signWithCertBtn: document.getElementById('signWithCertBtn'),
  openSignedFileBtn: document.getElementById('openSignedFileBtn'),
  closeOrganizerBtn: document.getElementById('closeOrganizerBtn'),
  openOrganizerRibbon: document.getElementById('openOrganizerRibbon'),
  closeSignatureBtn: document.getElementById('closeSignatureBtn'),
  openSignatureRibbon: document.getElementById('openSignatureRibbon')
};

let renderToken = 0;
let signatureDrawing = false;
let signatureHasInk = false;
let pdfWorker = null;

function setStatus(message) {
  ui.status.textContent = message;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function normalizeRotation(rotation) {
  return ((rotation % 360) + 360) % 360;
}

function getPdfJsPageRotation(page) {
  return Number.isFinite(page.rotate) ? page.rotate : 0;
}

function getSuggestedSavePath() {
  if (!state.filePath) return 'organized.pdf';
  const parsed = path.parse(state.filePath);
  return path.join(parsed.dir, `${parsed.name}_organized.pdf`);
}

function getEntryIndex(pageId) {
  return state.pageOrder.findIndex((entry) => entry.id === pageId);
}

function getCurrentEntry() {
  return state.pageOrder[state.pageNum - 1] || null;
}

function updatePageInfo() {
  if (!state.pdfDoc || state.pageOrder.length === 0) {
    ui.pageInfo.textContent = 'Page - / -';
    return;
  }
  ui.pageInfo.textContent = `Page ${state.pageNum} / ${state.pageOrder.length}`;
}

function updateButtons() {
  const hasPdf = !!state.pdfDoc && state.pageOrder.length > 0;
  ui.prevBtn.disabled = !hasPdf || state.pageNum <= 1;
  ui.nextBtn.disabled = !hasPdf || state.pageNum >= state.pageOrder.length;
  ui.zoomOutBtn.disabled = !hasPdf;
  ui.zoomInBtn.disabled = !hasPdf;
  ui.placeBtn.disabled = !hasPdf || !signatureHasInk;
  ui.signMarkedBtn.disabled = !hasPdf;
  ui.clearLastBtn.disabled = !hasPdf || state.placements.length === 0;
  ui.clearAllBtn.disabled = !hasPdf || state.placements.length === 0;
  ui.saveBtn.disabled = !hasPdf || state.hasDigitalSignature;
  ui.saveBtn.title = state.hasDigitalSignature
    ? 'Signed PDFs must not be rewritten. Use the signed output file.'
    : 'Save PDF';
  ui.placeBtn.classList.toggle('active', state.placeMode);

  for (const pageView of state.pages.values()) {
    const hasFields = (state.signatureFields.get(pageView.entry.id) || []).length > 0;
    const hasSignedDetails = state.signedSignatureDetails.some((item) => item.pageId === pageView.entry.id);
    pageView.overlayCanvas.style.pointerEvents = state.placeMode || hasFields || hasSignedDetails ? 'auto' : 'none';
    pageView.overlayCanvas.style.cursor = state.placeMode ? 'crosshair' : hasFields || hasSignedDetails ? 'pointer' : 'default';
  }

  for (const item of thumbList.querySelectorAll('.thumbItem')) {
    item.classList.toggle('active', item.dataset.pageId === getCurrentEntry()?.id);
  }
}

function setPaneOpen(pane, ribbon, isOpen) {
  pane.hidden = !isOpen;
  ribbon.hidden = isOpen;
}

function clearCanvas(ctx, canvas) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}

function clearViewer() {
  viewerContainer.replaceChildren();
  state.pages.clear();
}

function closeCurrentPdf() {
  renderToken += 1;
  state.filePath = null;
  state.pdfBytes = null;
  state.pdfDoc = null;
  state.pageNum = 1;
  state.placeMode = false;
  state.placements = [];
  state.pageOrder = [];
  state.signatureFields.clear();
  state.signedPath = null;
  state.signerFieldContext = null;
  state.signedSignatureDetails = [];
  state.hasDigitalSignature = false;
  clearViewer();
  thumbList.replaceChildren();
  if (ui.signedResult) ui.signedResult.textContent = '';
  if (ui.openSignedFileBtn) ui.openSignedFileBtn.disabled = true;
  setStatus('Open a PDF to begin');
  updatePageInfo();
  updateButtons();
}

function createPageView(entry, width, height, viewport) {
  const shell = document.createElement('div');
  shell.className = 'pageShell';
  shell.dataset.pageId = entry.id;
  shell.style.width = `${width}px`;
  shell.style.height = `${height}px`;

  const canvas = document.createElement('canvas');
  canvas.className = 'pdfCanvas';
  canvas.width = width;
  canvas.height = height;
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;

  const svgLayer = document.createElement('div');
  svgLayer.className = 'svgLayer';
  svgLayer.style.width = `${width}px`;
  svgLayer.style.height = `${height}px`;

  const overlayCanvas = document.createElement('canvas');
  overlayCanvas.className = 'annotCanvas';
  overlayCanvas.width = width;
  overlayCanvas.height = height;
  overlayCanvas.style.width = `${width}px`;
  overlayCanvas.style.height = `${height}px`;
  overlayCanvas.style.pointerEvents = state.placeMode ? 'auto' : 'none';
  overlayCanvas.style.cursor = state.placeMode ? 'crosshair' : 'default';

  overlayCanvas.addEventListener('pointerdown', async (event) => {
    if (state.placeMode && state.pdfDoc) {
      event.preventDefault();
      await addPlacement(entry.id, event.offsetX, event.offsetY);
      state.placeMode = false;
      updateButtons();
      return;
    }

    // If not in placement mode, clicking on a placeholder should trigger interactive signing
    if (!state.pdfDoc) return;
    try {
      if (await handleSignedSignatureClick(entry.id, event.offsetX, event.offsetY)) {
        event.preventDefault();
        return;
      }
      const handled = await handlePlaceholderClick(entry.id, event.offsetX, event.offsetY);
      if (handled) {
        event.preventDefault();
      }
    } catch (err) {
      console.error('Placeholder click handler error', err);
    }
  });

  shell.append(canvas, svgLayer, overlayCanvas);
  viewerContainer.append(shell);

  const pageView = {
    entry,
    shell,
    canvas,
    ctx: canvas.getContext('2d'),
    svgLayer,
    overlayCanvas,
    overlayCtx: overlayCanvas.getContext('2d'),
    viewport,
    pageSize: { width: width / state.scale, height: height / state.scale }
  };
  state.pages.set(entry.id, pageView);
  return pageView;
}

function canvasHasVisibleContent(canvas, ctx) {
  if (canvas.width === 0 || canvas.height === 0) return false;

  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  let visiblePixels = 0;

  for (let index = 0; index < data.length; index += 4) {
    const r = data[index];
    const g = data[index + 1];
    const b = data[index + 2];
    const a = data[index + 3];

    if (a !== 0 && (r < 248 || g < 248 || b < 248)) {
      visiblePixels += 1;
      if (visiblePixels > 50) return true;
    }
  }

  return false;
}

async function renderSvgFallback(page, viewport, pageView) {
  const operatorList = await page.getOperatorList({
    intent: 'display',
    annotationMode: pdfjsLib.AnnotationMode.ENABLE
  });
  const svgGraphics = new pdfjsLib.SVGGraphics(page.commonObjs, page.objs);
  const svg = await svgGraphics.getSVG(operatorList, viewport);

  pageView.svgLayer.replaceChildren(svg);
  pageView.svgLayer.style.display = 'block';
  pageView.canvas.style.visibility = 'hidden';
}

async function loadImage(src) {
  const image = new Image();
  await new Promise((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = reject;
    image.src = src;
  });
  return image;
}

function placementToScreen(placement, pageView) {
  const points = [
    pageView.viewport.convertToViewportPoint(placement.xPt, placement.yPt),
    pageView.viewport.convertToViewportPoint(placement.xPt + placement.widthPt, placement.yPt),
    pageView.viewport.convertToViewportPoint(placement.xPt, placement.yPt + placement.heightPt),
    pageView.viewport.convertToViewportPoint(placement.xPt + placement.widthPt, placement.yPt + placement.heightPt)
  ];
  const xs = points.map((point) => point[0]);
  const ys = points.map((point) => point[1]);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);

  return {
    x: minX,
    y: minY,
    w: Math.max(...xs) - minX,
    h: Math.max(...ys) - minY
  };
}

function pointInRect(x, y, rx, ry, rw, rh) {
  return x >= rx && x <= rx + rw && y >= ry && y <= ry + rh;
}

function getSignatureFieldCount() {
  let count = 0;
  for (const fields of state.signatureFields.values()) {
    count += fields.length;
  }
  return count;
}

function setSignerResult(message, linkPath = null) {
  if (!ui.signedResult) return;
  ui.signedResult.textContent = message || '';
  state.signedPath = linkPath;
  if (ui.openSignedFileBtn) ui.openSignedFileBtn.disabled = !linkPath;
}

function getCommonNameFromSubject(subject) {
  if (!subject) return 'Unknown';
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
    .split(/[;,\s]+/)
    .map((keyword) => keyword.trim())
    .filter(Boolean);
}

function encodeSignatureDetails(details) {
  return `${SIGNATURE_DETAILS_KEYWORD_PREFIX}${Buffer.from(JSON.stringify(details), 'utf8').toString('base64')}`;
}

function decodeSignatureDetailsKeywords(keywords) {
  const details = [];
  const text = normalizeKeywords(keywords).join(' ');
  const regex = new RegExp(`${SIGNATURE_DETAILS_KEYWORD_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([A-Za-z0-9+/=]+)`, 'g');
  let match;
  while ((match = regex.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(Buffer.from(match[1], 'base64').toString('utf8'));
      if (parsed && Number.isInteger(parsed.pageIndex) && parsed.displayRect) {
        details.push(parsed);
      }
    } catch (error) {
      console.warn('Failed to parse stored signature details', error);
    }
  }
  return details;
}

function hasEmbeddedDigitalSignature(pdfBytes) {
  if (!pdfBytes || pdfBytes.length === 0) return false;
  const text = Buffer.from(pdfBytes).toString('latin1');
  return /\/Type\s*\/Sig\b/.test(text)
    && /\/ByteRange\s*\[\s*\d+\s+\d+\s+\d+\s+\d+\s*\]/.test(text)
    && /\/Contents\s*<[\s0-9A-Fa-f]+>/.test(text);
}

async function readStoredSignatureDetails(pdfBytes) {
  try {
    const pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
    return decodeSignatureDetailsKeywords(pdfDoc.getKeywords());
  } catch (error) {
    console.warn('Failed to read stored signature details', error);
    return [];
  }
}

function mapStoredSignatureDetails(storedDetails) {
  return storedDetails
    .map((details) => {
      const entry = state.pageOrder[details.pageIndex];
      if (!entry) return null;
      return {
        ...details,
        pageId: entry.id,
        signatureType: details.signatureType || inferSignatureType(details.subject),
        signerName: details.signerName || getCommonNameFromSubject(details.subject),
        signedAt: details.signedAt ? new Date(details.signedAt).toLocaleString() : ''
      };
    })
    .filter(Boolean);
}

function getSignatureDetailKeywordsForExport() {
  const details = [];
  for (const detail of state.signedSignatureDetails) {
    const outputPageIndex = state.pageOrder.findIndex((entry) => entry.id === detail.pageId);
    if (outputPageIndex < 0) continue;
    const { pageId, ...storedDetail } = detail;
    details.push({
      ...storedDetail,
      pageIndex: outputPageIndex
    });
  }
  return details.map(encodeSignatureDetails);
}

function expandSignatureRect(rect, pageSize) {
  const pageWidth = pageSize.width;
  const pageHeight = pageSize.height;
  const targetWidth = Math.min(Math.max(rect.width * 1.45, 170), pageWidth - 24);
  const targetHeight = Math.min(Math.max(rect.height * 2.25, 58), pageHeight - 24);
  const centerX = rect.x + rect.width / 2;
  const centerY = rect.y + rect.height / 2;
  let x = centerX - targetWidth / 2;
  let y = centerY - targetHeight / 2;

  x = Math.min(Math.max(12, x), pageWidth - targetWidth - 12);
  y = Math.min(Math.max(12, y), pageHeight - targetHeight - 12);

  return { x, y, width: targetWidth, height: targetHeight };
}

function pdfRectToScreen(rect, pageView) {
  const pts = [
    pageView.viewport.convertToViewportPoint(rect.x, rect.y + rect.height),
    pageView.viewport.convertToViewportPoint(rect.x + rect.width, rect.y),
    pageView.viewport.convertToViewportPoint(rect.x, rect.y),
    pageView.viewport.convertToViewportPoint(rect.x + rect.width, rect.y + rect.height)
  ];
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return {
    x: minX,
    y: minY,
    w: Math.max(...xs) - minX,
    h: Math.max(...ys) - minY
  };
}

function setDetailsRow(label, value) {
  const row = document.createElement('div');
  row.className = 'detailsRow';
  const labelEl = document.createElement('div');
  labelEl.className = 'detailsLabel';
  labelEl.textContent = label;
  const valueEl = document.createElement('div');
  valueEl.className = 'detailsValue';
  valueEl.textContent = value || '-';
  row.append(labelEl, valueEl);
  ui.signatureDetailsBody.appendChild(row);
}

function formatVerificationStatus(verification) {
  if (!verification) return 'Checking...';
  if (!verification.success) return `Verification failed: ${verification.error || 'Unknown error'}`;
  if (!verification.integrityValid) return `Invalid: ${verification.error || 'signature check failed'}`;
  if (verification.expectedThumbprint && !verification.thumbprintMatches) {
    return 'Invalid: signer certificate does not match stored signature details';
  }
  return verification.trusted
    ? 'Authentic and trusted'
    : 'Authentic, but certificate trust could not be fully validated';
}

function showSignatureDetails(details, verification = null) {
  ui.signatureDetailsBody.replaceChildren();
  setDetailsRow('Status', 'Signed');
  setDetailsRow('Verification', formatVerificationStatus(verification));
  setDetailsRow('Sign type', details.signatureType);
  setDetailsRow('Signer', details.signerName);
  setDetailsRow('Signed on', details.signedAt);
  setDetailsRow('Field', details.label);
  setDetailsRow('Certificate', details.subject);
  setDetailsRow('Issuer', details.issuer);
  setDetailsRow('Thumbprint', details.thumbprint);
  setDetailsRow('Store', details.store);
  if (verification?.error && verification.integrityValid) {
    setDetailsRow('Trust note', verification.error);
  }
  ui.signatureDetailsModal.hidden = false;
}

async function verifyAndShowSignatureDetails(details) {
  showSignatureDetails(details);
  try {
    const verification = await ipcRenderer.invoke('verify-pdf-signature', state.filePath, details.thumbprint);
    showSignatureDetails(details, verification);
  } catch (error) {
    showSignatureDetails(details, {
      success: false,
      integrityValid: false,
      trusted: false,
      error: error.message || String(error)
    });
  }
}

async function handleSignedSignatureClick(pageId, screenX, screenY) {
  const pageView = state.pages.get(pageId);
  if (!pageView) return false;
  const details = state.signedSignatureDetails.filter((item) => item.pageId === pageId);
  for (const item of details) {
    const screenRect = pdfRectToScreen(item.displayRect, pageView);
    if (pointInRect(screenX, screenY, screenRect.x, screenRect.y, screenRect.w, screenRect.h)) {
      await verifyAndShowSignatureDetails(item);
      return true;
    }
  }
  return false;
}

async function openSignerUtility(fieldLabel = null, fieldContext = null) {
  if (!state.pdfDoc) {
    setStatus('Open a PDF first');
    return;
  }

  state.signerFieldContext = fieldContext;
  const fieldCount = getSignatureFieldCount();
  const fieldText = fieldLabel
    ? `Ready to sign field: ${fieldLabel}`
    : fieldCount > 0
      ? `Detected ${fieldCount} signature field${fieldCount === 1 ? '' : 's'} in this PDF.`
      : 'No signature fields were detected. The signer can still apply a document-level digital signature.';

  ui.signerFieldInfo.textContent = fieldText;
  ui.signerModal.hidden = false;
  setSignerResult('');

  if (ui.certificateSelect.options.length <= 1) {
    await refreshCerts();
  }

  ui.certificateSelect.focus();
}

async function handlePlaceholderClick(pageId, screenX, screenY) {
  const pageView = state.pages.get(pageId);
  if (!pageView) return false;
  const fields = state.signatureFields.get(pageId) || [];
  for (let i = 0; i < fields.length; i += 1) {
    const fld = fields[i];
    const pts = [
      pageView.viewport.convertToViewportPoint(fld.rect.x, fld.rect.y + fld.rect.height),
      pageView.viewport.convertToViewportPoint(fld.rect.x + fld.rect.width, fld.rect.y),
      pageView.viewport.convertToViewportPoint(fld.rect.x, fld.rect.y),
      pageView.viewport.convertToViewportPoint(fld.rect.x + fld.rect.width, fld.rect.y + fld.rect.height)
    ];
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    const w = Math.max(...xs) - minX;
    const h = Math.max(...ys) - minY;
    if (pointInRect(screenX, screenY, minX, minY, w, h)) {
      const label = fld.annotation && fld.annotation.fieldName ? fld.annotation.fieldName : `Signature ${i + 1}`;
      // Try to show embedded signature details if present in the PDF
      try {
        if (state.filePath) {
          const details = await ipcRenderer.invoke('get-all-signature-details', state.filePath);
          if (details && !details.error && Array.isArray(details) && details.length > 0) {
            showSignatureDetailsModal(details);
            return true;
          }
        }
      } catch (err) {
        console.warn('Failed to fetch signature details', err);
      }

      await openSignerUtility(label, {
        label,
        pageIndex: pageView.entry.sourcePageNum - 1,
        rect: { ...fld.rect }
      });
      return true;
    }
  }
  return false;
}

function showSignatureDetailsModal(details) {
  const existing = document.getElementById('sigDetailsModal');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'sigDetailsModal';
  overlay.style.position = 'fixed';
  overlay.style.left = '0';
  overlay.style.top = '0';
  overlay.style.right = '0';
  overlay.style.bottom = '0';
  overlay.style.background = 'rgba(0,0,0,0.45)';
  overlay.style.zIndex = '9999';
  overlay.style.display = 'flex';
  overlay.style.alignItems = 'center';
  overlay.style.justifyContent = 'center';

  const box = document.createElement('div');
  box.style.background = '#fff';
  box.style.borderRadius = '8px';
  box.style.padding = '16px';
  box.style.width = '720px';
  box.style.maxHeight = '80vh';
  box.style.overflow = 'auto';
  box.style.boxShadow = '0 8px 24px rgba(0,0,0,0.25)';

  const title = document.createElement('h3');
  title.textContent = 'Signature Details';
  box.appendChild(title);

  details.forEach((d, idx) => {
    const section = document.createElement('div');
    section.style.padding = '8px 0';
    if (idx > 0) section.style.borderTop = '1px solid #eee';

    const header = document.createElement('div');
    header.style.fontWeight = '600';
    header.style.marginBottom = '6px';
    header.textContent = `Signature ${idx + 1}`;
    section.appendChild(header);

    const kv = [
      ['Thumbprint', d.Thumbprint || d.thumbprint || ''],
      ['Subject', d.Subject || d.subject || ''],
      ['Issuer', d.Issuer || d.issuer || ''],
      ['Serial', d.SerialNumber || d.serialNumber || ''],
      ['Signed On', d.SignedOn || d.signedOn || ''],
      ['Error', d.Error || d.error || '']
    ];

    kv.forEach(([k, v]) => {
      const row = document.createElement('div');
      row.style.margin = '2px 0';
      row.innerHTML = `<strong>${k}:</strong> ${v || '<i>n/a</i>'}`;
      section.appendChild(row);
    });

    box.appendChild(section);
  });

  const close = document.createElement('button');
  close.textContent = 'Close';
  close.style.marginTop = '10px';
  close.addEventListener('click', () => overlay.remove());
  box.appendChild(close);

  overlay.appendChild(box);
  document.body.appendChild(overlay);
}

async function redrawOverlay(pageId) {
  const pageView = state.pages.get(pageId);
  if (!pageView) return;

  clearCanvas(pageView.overlayCtx, pageView.overlayCanvas);

  // draw signature placeholders (if any)
  if (state.showSignaturePlaceholders) {
    const fields = state.signatureFields.get(pageId) || [];
    for (let i = 0; i < fields.length; i += 1) {
      const fld = fields[i];
      // convert pdf rect to screen coordinates
      const pts = [
        pageView.viewport.convertToViewportPoint(fld.rect.x, fld.rect.y + fld.rect.height),
        pageView.viewport.convertToViewportPoint(fld.rect.x + fld.rect.width, fld.rect.y),
        pageView.viewport.convertToViewportPoint(fld.rect.x, fld.rect.y),
        pageView.viewport.convertToViewportPoint(fld.rect.x + fld.rect.width, fld.rect.y + fld.rect.height)
      ];
      const xs = pts.map((p) => p[0]);
      const ys = pts.map((p) => p[1]);
      const minX = Math.min(...xs);
      const minY = Math.min(...ys);
      const w = Math.max(...xs) - minX;
      const h = Math.max(...ys) - minY;

      pageView.overlayCtx.save();
      pageView.overlayCtx.strokeStyle = 'rgba(220,20,60,0.95)';
      pageView.overlayCtx.lineWidth = Math.max(2, Math.min(4, Math.max(1, Math.min(w, h) * 0.03)));
      pageView.overlayCtx.setLineDash([6, 4]);
      pageView.overlayCtx.strokeRect(minX, minY, w, h);

      // draw identification text above the rect (or inside if space)
      const label = fld.annotation && fld.annotation.fieldName ? fld.annotation.fieldName : `Signature ${i + 1}`;
      const fontSize = Math.max(10, Math.min(16, Math.floor(Math.min(14, w * 0.08))));
      pageView.overlayCtx.font = `${fontSize}px sans-serif`;
      pageView.overlayCtx.fillStyle = 'rgba(220,20,60,0.95)';
      const textWidth = pageView.overlayCtx.measureText(label).width;
      const textX = minX + 4;
      const textY = minY - 6;
      if (textY > fontSize + 2) {
        pageView.overlayCtx.fillText(label, textX, textY - 2);
      } else {
        // place inside the rect if not enough space above
        pageView.overlayCtx.fillText(label, textX, minY + fontSize + 2);
      }
      pageView.overlayCtx.restore();
    }
  }

  const currentPlacements = state.placements.filter((placement) => placement.pageId === pageId);
  for (const placement of currentPlacements) {
    const image = await loadImage(placement.src);
    const { x, y, w, h } = placementToScreen(placement, pageView);
    pageView.overlayCtx.drawImage(image, x, y, w, h);
  }
}

async function redrawAllOverlays() {
  for (const pageId of state.pages.keys()) {
    await redrawOverlay(pageId);
  }
}

async function renderSinglePage(entry, token) {
  const page = await state.pdfDoc.getPage(entry.sourcePageNum);
  if (token !== renderToken) return;

  const viewport = page.getViewport({
    scale: state.scale,
    rotation: normalizeRotation(getPdfJsPageRotation(page) + entry.rotation)
  });
  const [x1, y1, x2, y2] = page.view;
  const pageView = createPageView(entry, viewport.width, viewport.height, viewport);
  pageView.pageSize = { width: x2 - x1, height: y2 - y1 };

  clearCanvas(pageView.ctx, pageView.canvas);
  clearCanvas(pageView.overlayCtx, pageView.overlayCanvas);
  pageView.svgLayer.replaceChildren();
  pageView.svgLayer.style.display = 'none';
  pageView.canvas.style.visibility = 'visible';

  await page.render({
    canvasContext: pageView.ctx,
    viewport,
    intent: 'display',
    annotationMode: pdfjsLib.AnnotationMode.ENABLE
  }).promise;

  if (token !== renderToken) return;
  if (!canvasHasVisibleContent(pageView.canvas, pageView.ctx)) {
    await renderSvgFallback(page, viewport, pageView);
    setStatus(`Loaded ${path.basename(state.filePath)} (fallback renderer)`);
  }
  await redrawOverlay(entry.id);
}

async function renderDocument() {
  if (!state.pdfDoc) return;
  const token = ++renderToken;
  clearViewer();

  try {
    for (const entry of state.pageOrder) {
      await renderSinglePage(entry, token);
      if (token !== renderToken) return;
    }
    renderOrganizer();
    // detect and store signature placeholders, then redraw overlays to show them
    await populateSignatureFields();
    await redrawAllOverlays();
    updatePageInfo();
    updateButtons();
    updateCurrentPageFromScroll();
  } catch (error) {
    setStatus(`Failed to render page: ${error.message}`);
  }
}

async function renderThumbnail(entry, canvas) {
  const page = await state.pdfDoc.getPage(entry.sourcePageNum);
  const rotation = normalizeRotation(getPdfJsPageRotation(page) + entry.rotation);
  const baseViewport = page.getViewport({ scale: 1, rotation });
  const scale = 104 / baseViewport.width;
  const viewport = page.getViewport({ scale, rotation });
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  canvas.style.width = `${viewport.width}px`;
  canvas.style.height = `${viewport.height}px`;
  await page.render({
    canvasContext: canvas.getContext('2d'),
    viewport,
    intent: 'display',
    annotationMode: pdfjsLib.AnnotationMode.ENABLE
  }).promise;
}

function renderOrganizer() {
  thumbList.replaceChildren();

  state.pageOrder.forEach((entry, index) => {
    const item = document.createElement('div');
    item.className = 'thumbItem';
    item.draggable = true;
    item.dataset.pageId = entry.id;
    item.classList.toggle('active', index + 1 === state.pageNum);

    const canvas = document.createElement('canvas');
    canvas.className = 'thumbCanvas';

    const meta = document.createElement('div');
    meta.className = 'thumbMeta';

    const label = document.createElement('span');
    label.textContent = `${index + 1}`;

    const actions = document.createElement('div');
    actions.className = 'thumbActions';

    const rotateLeft = document.createElement('button');
    rotateLeft.type = 'button';
    rotateLeft.title = 'Rotate left';
    rotateLeft.textContent = 'L';

    const rotateRight = document.createElement('button');
    rotateRight.type = 'button';
    rotateRight.title = 'Rotate right';
    rotateRight.textContent = 'R';

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.title = 'Delete page';
    deleteBtn.textContent = 'X';
    deleteBtn.disabled = state.pageOrder.length <= 1;

    actions.append(rotateLeft, rotateRight, deleteBtn);
    meta.append(label, actions);
    item.append(canvas, meta);
    thumbList.append(item);

    renderThumbnail(entry, canvas).catch((error) => {
      console.error(`Failed to render thumbnail ${index + 1}`, error);
    });

    item.addEventListener('click', () => scrollToPage(index + 1));
    item.addEventListener('dragstart', (event) => {
      item.classList.add('dragging');
      event.dataTransfer.setData('text/plain', entry.id);
      event.dataTransfer.effectAllowed = 'move';
    });
    item.addEventListener('dragend', () => item.classList.remove('dragging'));
    item.addEventListener('dragover', (event) => {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
    });
    item.addEventListener('drop', async (event) => {
      event.preventDefault();
      const draggedId = event.dataTransfer.getData('text/plain');
      await reorderPage(draggedId, entry.id);
    });

    rotateLeft.addEventListener('click', async (event) => {
      event.stopPropagation();
      await rotatePage(entry.id, -90);
    });
    rotateRight.addEventListener('click', async (event) => {
      event.stopPropagation();
      await rotatePage(entry.id, 90);
    });
    deleteBtn.addEventListener('click', async (event) => {
      event.stopPropagation();
      await deletePage(entry.id);
    });
  });
}

async function reorderPage(draggedId, targetId) {
  if (!draggedId || draggedId === targetId) return;
  const from = getEntryIndex(draggedId);
  const to = getEntryIndex(targetId);
  if (from < 0 || to < 0) return;

  const [entry] = state.pageOrder.splice(from, 1);
  const insertAt = from < to ? to - 1 : to;
  state.pageOrder.splice(insertAt, 0, entry);
  state.pageNum = getEntryIndex(entry.id) + 1;
  setStatus('Page order updated');
  await renderDocument();
  scrollToPage(state.pageNum);
}

async function rotatePage(pageId, delta) {
  const entry = state.pageOrder.find((candidate) => candidate.id === pageId);
  if (!entry) return;

  entry.rotation = normalizeRotation(entry.rotation + delta);
  state.pageNum = getEntryIndex(pageId) + 1;
  setStatus(`Rotated page ${state.pageNum}`);
  await renderDocument();
  scrollToPage(state.pageNum);
}

async function deletePage(pageId) {
  if (state.pageOrder.length <= 1) return;
  const index = getEntryIndex(pageId);
  if (index < 0) return;

  state.pageOrder.splice(index, 1);
  state.placements = state.placements.filter((placement) => placement.pageId !== pageId);
  state.pageNum = clamp(Math.min(index + 1, state.pageOrder.length), 1, state.pageOrder.length);
  setStatus('Page deleted');
  await renderDocument();
  scrollToPage(state.pageNum);
}

async function loadPdf(filePath) {
  const bytes = fs.readFileSync(filePath);
  state.filePath = filePath;
  state.pdfBytes = bytes;
  state.hasDigitalSignature = hasEmbeddedDigitalSignature(bytes);
  try {
    if (!pdfWorker) {
      pdfWorker = new pdfjsLib.PDFWorker({ name: 'pdf-viewer' });
    }
    state.pdfDoc = await pdfjsLib.getDocument({
      data: new Uint8Array(bytes),
      worker: pdfWorker,
      cMapUrl: `${pdfjsBasePath}cmaps/`,
      standardFontDataUrl: `${pdfjsBasePath}standard_fonts/`,
      useSystemFonts: true,
      useWorkerFetch: false,
      disableFontFace: false,
      enableXfa: true,
      isOffscreenCanvasSupported: false,
      maxImageSize: -1,
      canvasMaxAreaInBytes: -1
    }).promise;
    state.pageNum = 1;
    state.placements = [];
    state.placeMode = false;
    state.signatureFields.clear();
    state.signedPath = null;
    state.signerFieldContext = null;
    state.signedSignatureDetails = [];
    setSignerResult('');
    state.pageOrder = Array.from({ length: state.pdfDoc.numPages }, (_value, index) => ({
      id: `page-${index + 1}-${Date.now()}`,
      sourcePageNum: index + 1,
      rotation: 0
    }));
    state.signedSignatureDetails = mapStoredSignatureDetails(await readStoredSignatureDetails(bytes));
    setStatus(`Loaded ${path.basename(filePath)}`);
    updateButtons();
    updatePageInfo();
    await renderDocument();
  } catch (error) {
    state.pdfDoc = null;
    state.pageOrder = [];
    state.placements = [];
    state.placeMode = false;
    state.signatureFields.clear();
    state.signedPath = null;
    state.signerFieldContext = null;
    state.signedSignatureDetails = [];
    setSignerResult('');
    clearViewer();
    thumbList.replaceChildren();
    setStatus(`Failed to load PDF: ${error.message}`);
    updateButtons();
    updatePageInfo();
  }
}

function getSignatureBounds() {
  const { width, height } = signatureCanvas;
  const imageData = signatureCtx.getImageData(0, 0, width, height).data;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4 + 3;
      if (imageData[index] === 0) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }

  if (maxX < 0) return null;

  const padding = 6;
  return {
    x: clamp(minX - padding, 0, width - 1),
    y: clamp(minY - padding, 0, height - 1),
    width: clamp(maxX - minX + 1 + padding * 2, 1, width),
    height: clamp(maxY - minY + 1 + padding * 2, 1, height)
  };
}

function captureSignatureDataUrl() {
  const bounds = getSignatureBounds();
  if (!bounds) return null;

  const trimmed = document.createElement('canvas');
  trimmed.width = bounds.width;
  trimmed.height = bounds.height;
  const tctx = trimmed.getContext('2d');
  tctx.drawImage(
    signatureCanvas,
    bounds.x,
    bounds.y,
    bounds.width,
    bounds.height,
    0,
    0,
    bounds.width,
    bounds.height
  );

  return trimmed.toDataURL('image/png');
}

function isSignatureAnnotation(annotation) {
  if (!annotation || !Array.isArray(annotation.rect)) return false;

  if (annotation.fieldType === 'Sig') return true;

  const widgetType = pdfjsLib.AnnotationType?.WIDGET;
  const isWidget = widgetType ? annotation.annotationType === widgetType : true;
  const searchableText = [
    annotation.fieldName,
    annotation.alternativeText,
    annotation.name,
    annotation.title,
    annotation.contents
  ]
    .filter(Boolean)
    .join(' ');

  return isWidget && /\bsig(nature)?\b/i.test(searchableText);
}

function normalizePdfRect(rect) {
  const [x1, y1, x2, y2] = rect.map(Number);
  if (![x1, y1, x2, y2].every(Number.isFinite)) return null;

  return {
    x: Math.min(x1, x2),
    y: Math.min(y1, y2),
    width: Math.abs(x2 - x1),
    height: Math.abs(y2 - y1)
  };
}

function fitSignatureInPdfRect(rect, signatureBounds) {
  const padding = Math.min(8, rect.width * 0.12, rect.height * 0.18);
  const availableWidth = Math.max(1, rect.width - padding * 2);
  const availableHeight = Math.max(1, rect.height - padding * 2);
  const signatureAspect = signatureBounds.width / Math.max(1, signatureBounds.height);
  const rectAspect = availableWidth / availableHeight;
  let width = availableWidth;
  let height = availableHeight;

  if (signatureAspect > rectAspect) {
    height = width / signatureAspect;
  } else {
    width = height * signatureAspect;
  }

  return {
    xPt: rect.x + (rect.width - width) / 2,
    yPt: rect.y + (rect.height - height) / 2,
    widthPt: width,
    heightPt: height
  };
}

async function findSignatureFields() {
  const fields = [];

  for (const entry of state.pageOrder) {
    const page = await state.pdfDoc.getPage(entry.sourcePageNum);
    const annotations = await page.getAnnotations({ intent: 'display' });

    for (const annotation of annotations) {
      if (!isSignatureAnnotation(annotation)) continue;
      const rect = normalizePdfRect(annotation.rect);
      if (!rect || rect.width < 4 || rect.height < 4) continue;
      fields.push({ entry, rect, annotation });
    }
  }

  return fields;
}

async function populateSignatureFields() {
  state.signatureFields.clear();
  try {
    const fields = await findSignatureFields();
    for (const f of fields) {
      const pageId = f.entry.id;
      const arr = state.signatureFields.get(pageId) || [];
      arr.push({ rect: f.rect, annotation: f.annotation });
      state.signatureFields.set(pageId, arr);
    }
  } catch (err) {
    console.warn('Failed to populate signature fields:', err);
  }
}

async function signMarkedAreas() {
  if (!state.pdfDoc) return;

  const signatureBounds = getSignatureBounds();
  const signatureSrc = captureSignatureDataUrl();
  if (!signatureBounds || !signatureSrc) {
    setStatus('Draw a signature first');
    updateButtons();
    return;
  }

  try {
    const fields = await findSignatureFields();
    if (fields.length === 0) {
      setStatus('No marked signature areas found');
      return;
    }

    state.placements = state.placements.filter((placement) => !placement.markedArea);

    for (const { entry, rect } of fields) {
      state.placements.push({
        pageId: entry.id,
        ...fitSignatureInPdfRect(rect, signatureBounds),
        src: signatureSrc,
        markedArea: true
      });
    }

    state.placeMode = false;
    updateButtons();
    await redrawAllOverlays();

    const firstPageIndex = getEntryIndex(fields[0].entry.id) + 1;
    scrollToPage(firstPageIndex);
    setStatus(`Signed ${fields.length} marked area${fields.length === 1 ? '' : 's'}`);
  } catch (error) {
    setStatus(`Could not sign marked areas: ${error.message}`);
  }
}

function updateSignatureState() {
  signatureHasInk = !!getSignatureBounds();
  updateButtons();
}

function startSignatureStroke(event) {
  event.preventDefault();
  signatureDrawing = true;
  signatureCanvas.setPointerCapture(event.pointerId);
  signatureCtx.beginPath();
  signatureCtx.moveTo(event.offsetX, event.offsetY);
}

function continueSignatureStroke(event) {
  if (!signatureDrawing) return;
  event.preventDefault();
  signatureCtx.lineTo(event.offsetX, event.offsetY);
  signatureCtx.stroke();
  signatureHasInk = true;
  updateButtons();
}

function endSignatureStroke() {
  signatureDrawing = false;
  updateSignatureState();
}

async function addPlacement(pageId, screenX, screenY) {
  const pageView = state.pages.get(pageId);
  const signatureSrc = captureSignatureDataUrl();
  if (!pageView || !signatureSrc) {
    setStatus('Draw a signature first');
    return;
  }

  const [pdfX, pdfY] = pageView.viewport.convertToPdfPoint(screenX, screenY);
  const targetWidthPt = 140;
  const targetHeightPt = 56;
  const widthPt = targetWidthPt;
  const heightPt = targetHeightPt;
  const maxX = Math.max(0, pageView.pageSize.width - widthPt);
  const maxY = Math.max(0, pageView.pageSize.height - heightPt);
  const xPt = clamp(pdfX - widthPt / 2, 0, maxX);
  const yPt = clamp(pdfY - heightPt / 2, 0, maxY);

  state.placements.push({
    pageId,
    xPt,
    yPt,
    widthPt,
    heightPt,
    src: signatureSrc
  });

  const index = getEntryIndex(pageId) + 1;
  setStatus(`Placed signature on page ${index}`);
  updateButtons();
  await redrawOverlay(pageId);
}

async function exportSignedPdf() {
  if (!state.pdfBytes || state.pageOrder.length === 0) return;
  if (state.hasDigitalSignature) {
    setStatus('Signed PDFs cannot be rewritten without invalidating the digital certificate.');
    return;
  }

  const outputPath = await ipcRenderer.invoke('show-save-dialog', getSuggestedSavePath());
  if (!outputPath) return;

  const sourcePdf = await PDFDocument.load(state.pdfBytes);
  const outputPdf = await PDFDocument.create();
  const embeddedImages = new Map();

  for (const entry of state.pageOrder) {
    const [copiedPage] = await outputPdf.copyPages(sourcePdf, [entry.sourcePageNum - 1]);
    const currentRotation = copiedPage.getRotation().angle || 0;
    copiedPage.setRotation(degrees(normalizeRotation(currentRotation + entry.rotation)));
    outputPdf.addPage(copiedPage);

    for (const placement of state.placements.filter((candidate) => candidate.pageId === entry.id)) {
      let embedded = embeddedImages.get(placement.src);
      if (!embedded) {
        embedded = await outputPdf.embedPng(dataUrlToBytes(placement.src));
        embeddedImages.set(placement.src, embedded);
      }

      copiedPage.drawImage(embedded, {
        x: placement.xPt,
        y: placement.yPt,
        width: placement.widthPt,
        height: placement.heightPt
      });
    }
  }

  const existingKeywords = normalizeKeywords(sourcePdf.getKeywords())
    .filter((keyword) => !keyword.startsWith(SIGNATURE_DETAILS_KEYWORD_PREFIX));
  outputPdf.setKeywords([...existingKeywords, ...getSignatureDetailKeywordsForExport()]);

  const outputBytes = await outputPdf.save();
  fs.writeFileSync(outputPath, Buffer.from(outputBytes));
  setStatus(`Saved ${path.basename(outputPath)}`);
}

function dataUrlToBytes(dataUrl) {
  const [, base64] = dataUrl.split(',');
  return Uint8Array.from(Buffer.from(base64, 'base64'));
}

function scrollToPage(pageIndex) {
  const entry = state.pageOrder[pageIndex - 1];
  if (!entry) return;
  const pageView = state.pages.get(entry.id);
  if (!pageView) return;
  pageView.shell.scrollIntoView({ behavior: 'smooth', block: 'start' });
  state.pageNum = pageIndex;
  updatePageInfo();
  updateButtons();
}

function updateCurrentPageFromScroll() {
  if (!state.pdfDoc || state.pages.size === 0) return;

  const paneTop = viewerPane.getBoundingClientRect().top;
  let nearestPage = state.pageNum;
  let nearestDistance = Infinity;

  state.pageOrder.forEach((entry, index) => {
    const pageView = state.pages.get(entry.id);
    if (!pageView) return;
    const rect = pageView.shell.getBoundingClientRect();
    const distance = Math.abs(rect.top - paneTop - 18);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestPage = index + 1;
    }
  });

  if (nearestPage !== state.pageNum) {
    state.pageNum = nearestPage;
    updatePageInfo();
    updateButtons();
  }
}

ui.openBtn.addEventListener('click', async () => {
  const filePath = await ipcRenderer.invoke('show-open-dialog');
  if (!filePath) return;
  await loadPdf(filePath);
});

ipcRenderer.on('menu-open-pdf', async () => {
  const filePath = await ipcRenderer.invoke('show-open-dialog');
  if (!filePath) return;
  await loadPdf(filePath);
});

ipcRenderer.on('menu-close-pdf', () => {
  closeCurrentPdf();
});

document.getElementById('fileInput').addEventListener('change', async (event) => {
  const [file] = event.target.files;
  if (!file) return;
  await loadPdf(file.path);
});

ui.prevBtn.addEventListener('click', () => {
  if (!state.pdfDoc || state.pageNum <= 1) return;
  scrollToPage(state.pageNum - 1);
});

ui.nextBtn.addEventListener('click', () => {
  if (!state.pdfDoc || state.pageNum >= state.pageOrder.length) return;
  scrollToPage(state.pageNum + 1);
});

ui.zoomInBtn.addEventListener('click', async () => {
  if (!state.pdfDoc) return;
  state.scale = Math.min(4, state.scale + 0.2);
  await renderDocument();
  scrollToPage(state.pageNum);
});

ui.zoomOutBtn.addEventListener('click', async () => {
  if (!state.pdfDoc) return;
  state.scale = Math.max(0.5, state.scale - 0.2);
  await renderDocument();
  scrollToPage(state.pageNum);
});

ui.placeBtn.addEventListener('click', () => {
  if (!state.pdfDoc || !signatureHasInk) return;
  state.placeMode = !state.placeMode;
  setStatus(state.placeMode ? 'Click the PDF to place the signature' : 'Placement mode off');
  updateButtons();
});

ui.clearLastBtn.addEventListener('click', async () => {
  state.placements.pop();
  setStatus('Removed the last placement');
  updateButtons();
  await redrawAllOverlays();
});

ui.clearAllBtn.addEventListener('click', async () => {
  state.placements = [];
  setStatus('Removed all placements');
  updateButtons();
  await redrawAllOverlays();
});

ui.saveBtn.addEventListener('click', exportSignedPdf);

ui.printBtn.addEventListener('click', () => window.print());

ui.signMarkedBtn.addEventListener('click', () => {
  openSignerUtility();
});

ui.clearSignatureBtn.addEventListener('click', () => {
  signatureCtx.clearRect(0, 0, signatureCanvas.width, signatureCanvas.height);
  signatureHasInk = false;
  state.placeMode = false;
  setStatus('Signature pad cleared');
  updateButtons();
});

ui.closeOrganizerBtn.addEventListener('click', () => {
  setPaneOpen(organizerPane, ui.openOrganizerRibbon, false);
});

ui.openOrganizerRibbon.addEventListener('click', () => {
  setPaneOpen(organizerPane, ui.openOrganizerRibbon, true);
});

ui.closeSignatureBtn.addEventListener('click', () => {
  setPaneOpen(signaturePane, ui.openSignatureRibbon, false);
});

ui.openSignatureRibbon.addEventListener('click', () => {
  setPaneOpen(signaturePane, ui.openSignatureRibbon, true);
});

ui.closeSignerModalBtn.addEventListener('click', () => {
  ui.signerModal.hidden = true;
});

ui.signerModal.addEventListener('pointerdown', (event) => {
  if (event.target === ui.signerModal) {
    ui.signerModal.hidden = true;
  }
});

ui.closeSignatureDetailsBtn.addEventListener('click', () => {
  ui.signatureDetailsModal.hidden = true;
});

ui.signatureDetailsModal.addEventListener('pointerdown', (event) => {
  if (event.target === ui.signatureDetailsModal) {
    ui.signatureDetailsModal.hidden = true;
  }
});

// Certificate store listing and signing actions
async function refreshCerts() {
  ui.certificateSelect.innerHTML = '';
  ui.certificateSelect.disabled = true;
  ui.refreshCertsBtn.disabled = true;
  setSignerResult('');
  setStatus('Loading certificates...');
  try {
    const res = await ipcRenderer.invoke('list-windows-certs');
    ui.refreshCertsBtn.disabled = false;
    ui.certificateSelect.disabled = false;
    if (!res) {
      setSignerResult('No signing certificates found in Windows personal certificate stores.');
      setStatus('No certificates found');
      return;
    }
    if (res.error) {
      setSignerResult('Certificate listing error: ' + res.error);
      setStatus('Error: ' + res.error);
      return;
    }
    const certs = Array.isArray(res) ? res : [res];
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = certs.length > 0 ? 'Select a certificate...' : 'No signing certificates found';
    ui.certificateSelect.appendChild(placeholder);
    if (certs.length === 0) {
      ui.certificateSelect.disabled = true;
      setSignerResult('No certificates with private keys were found in CurrentUser or LocalMachine personal stores.');
      setStatus('No certificates found');
      return;
    }
    certs.forEach((c) => {
      const store = c.Store || 'CurrentUser';
      const friendly = c.FriendlyName ? `${c.FriendlyName} - ` : '';
      const text = `${friendly}${c.Subject} [${store}]`;
      const opt = document.createElement('option');
      opt.value = `${store}|${c.Thumbprint}`;
      opt.title = `Thumbprint: ${c.Thumbprint}`;
      opt.dataset.subject = c.Subject || '';
      opt.dataset.issuer = c.Issuer || '';
      opt.dataset.store = store;
      opt.dataset.thumbprint = c.Thumbprint || '';
      opt.textContent = text;
      ui.certificateSelect.appendChild(opt);
    });
    setStatus(`Found ${certs.length} certificate(s)`);
  } catch (err) {
    ui.refreshCertsBtn.disabled = false;
    ui.certificateSelect.disabled = false;
    const message = err.message || String(err);
    setSignerResult('Certificate listing error: ' + message);
    setStatus('Error listing certs: ' + message);
  }
}

ui.refreshCertsBtn.addEventListener('click', refreshCerts);
// load certs immediately
refreshCerts();

ui.signWithCertBtn.addEventListener('click', async () => {
  if (!state.filePath) {
    const choose = await ipcRenderer.invoke('show-open-dialog');
    if (!choose) return;
    await loadPdf(choose);
  }
  const thumb = ui.certificateSelect.value;
  if (!thumb) { setStatus('Select a certificate'); return; }
  setStatus('Signing with certificate...');
  setSignerResult('Signing...');
  ui.signWithCertBtn.disabled = true;
  try {
    const selectedOption = ui.certificateSelect.selectedOptions[0];
    const selectedSubject = selectedOption?.dataset.subject || selectedOption?.textContent || '';
    const signedAtIso = new Date().toISOString();
    const signatureType = inferSignatureType(selectedSubject);
    const appearance = state.signerFieldContext
      ? {
          ...state.signerFieldContext,
          subject: selectedSubject,
          issuer: selectedOption?.dataset.issuer || '',
          thumbprint: selectedOption?.dataset.thumbprint || '',
          store: selectedOption?.dataset.store || '',
          signerName: getCommonNameFromSubject(selectedSubject),
          signedAt: signedAtIso,
          signatureType
        }
      : null;
    const res = await ipcRenderer.invoke('sign-pdf-with-thumbprint', state.filePath, thumb, appearance);
    if (res && res.success) {
      const signedContext = state.signerFieldContext;
      const pageId = signedContext ? state.pageOrder[signedContext.pageIndex]?.id : null;
      const signedDetails = signedContext && pageId
        ? {
            pageId,
            label: signedContext.label,
            rect: signedContext.rect,
            displayRect: expandSignatureRect(signedContext.rect, state.pages.get(pageId)?.pageSize || { width: 612, height: 792 }),
            signerName: getCommonNameFromSubject(selectedSubject),
            subject: selectedSubject,
            issuer: selectedOption?.dataset.issuer || '',
            thumbprint: selectedOption?.dataset.thumbprint || '',
            store: selectedOption?.dataset.store || '',
            signedAt: new Date(signedAtIso).toLocaleString(),
            signatureType
          }
        : null;
      setSignerResult(`Signed file: ${res.path}`, res.path);
      await loadPdf(res.path);
      if (signedDetails) {
        const newEntry = state.pageOrder[signedContext.pageIndex];
        signedDetails.pageId = newEntry?.id || signedDetails.pageId;
        state.signedSignatureDetails = [signedDetails];
        await redrawAllOverlays();
        updateButtons();
      }
      ui.signerModal.hidden = false;
      setSignerResult(`Signed file: ${res.path}`, res.path);
      setStatus('Signing succeeded');
    } else {
      const message = res && res.error ? res.error : 'unknown';
      setSignerResult(`Signing failed: ${message}`);
      setStatus('Signing failed: ' + message);
    }
  } catch (err) {
    const message = err.message || String(err);
    setSignerResult(`Signing error: ${message}`);
    setStatus('Signing error: ' + message);
  } finally {
    ui.signWithCertBtn.disabled = false;
  }
});

ui.openSignedFileBtn.addEventListener('click', () => {
  if (!state.signedPath) return;
  require('electron').shell.openPath(state.signedPath);
});

signatureCanvas.addEventListener('pointerdown', startSignatureStroke);
signatureCanvas.addEventListener('pointermove', continueSignatureStroke);
signatureCanvas.addEventListener('pointerup', endSignatureStroke);
signatureCanvas.addEventListener('pointercancel', endSignatureStroke);
signatureCanvas.addEventListener('pointerleave', endSignatureStroke);
viewerPane.addEventListener('scroll', updateCurrentPageFromScroll);

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !ui.signatureDetailsModal.hidden) {
    ui.signatureDetailsModal.hidden = true;
    return;
  }

  if (event.key === 'Escape' && !ui.signerModal.hidden) {
    ui.signerModal.hidden = true;
    return;
  }

  if (event.key === 'Escape' && state.placeMode) {
    state.placeMode = false;
    updateButtons();
    setStatus('Placement mode off');
  }
});

function setupSignaturePad() {
  signatureCtx.lineCap = 'round';
  signatureCtx.lineJoin = 'round';
  signatureCtx.strokeStyle = '#111';
  signatureCtx.lineWidth = 3;
  resizeSignaturePad();
}

function resizeSignaturePad() {
  const width = signatureCanvas.clientWidth;
  const height = signatureCanvas.clientHeight;
  if (width === 0 || height === 0) return;
  signatureCanvas.width = width;
  signatureCanvas.height = height;
  signatureCtx.lineCap = 'round';
  signatureCtx.lineJoin = 'round';
  signatureCtx.strokeStyle = '#111';
  signatureCtx.lineWidth = 3;
  signatureCtx.clearRect(0, 0, signatureCanvas.width, signatureCanvas.height);
  signatureHasInk = false;
  updateButtons();
}

setupSignaturePad();
window.addEventListener('resize', resizeSignaturePad);
updatePageInfo();
updateButtons();
setStatus('Open a PDF to begin');
// Ensure signature panel is collapsed on startup
try {
  setPaneOpen(signaturePane, ui.openSignatureRibbon, false);
} catch (e) {
  console.warn('Could not set signature pane state on startup', e);
}
