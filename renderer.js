const { ipcRenderer } = require('electron');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
require('pdfjs-dist/legacy/build/pdf.worker.entry.js');
const { PDFDocument, degrees } = require('pdf-lib');

const pdfjsBasePath = pathToFileURL(path.join(__dirname, 'node_modules', 'pdfjs-dist')).href + '/';

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
  pages: new Map()
};

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
  ui.signMarkedBtn.disabled = !hasPdf || !signatureHasInk;
  ui.clearLastBtn.disabled = !hasPdf || state.placements.length === 0;
  ui.clearAllBtn.disabled = !hasPdf || state.placements.length === 0;
  ui.saveBtn.disabled = !hasPdf;
  ui.placeBtn.classList.toggle('active', state.placeMode);

  for (const pageView of state.pages.values()) {
    pageView.overlayCanvas.style.pointerEvents = state.placeMode ? 'auto' : 'none';
    pageView.overlayCanvas.style.cursor = state.placeMode ? 'crosshair' : 'default';
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
  clearViewer();
  thumbList.replaceChildren();
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

  overlayCanvas.addEventListener('pointerdown', async (event) => {
    if (!state.placeMode || !state.pdfDoc) return;
    event.preventDefault();
    await addPlacement(entry.id, event.offsetX, event.offsetY);
    state.placeMode = false;
    updateButtons();
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

async function redrawOverlay(pageId) {
  const pageView = state.pages.get(pageId);
  if (!pageView) return;

  clearCanvas(pageView.overlayCtx, pageView.overlayCanvas);
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
    state.pageOrder = Array.from({ length: state.pdfDoc.numPages }, (_value, index) => ({
      id: `page-${index + 1}-${Date.now()}`,
      sourcePageNum: index + 1,
      rotation: 0
    }));
    setStatus(`Loaded ${path.basename(filePath)}`);
    updateButtons();
    updatePageInfo();
    await renderDocument();
  } catch (error) {
    state.pdfDoc = null;
    state.pageOrder = [];
    state.placements = [];
    state.placeMode = false;
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
      fields.push({ entry, rect });
    }
  }

  return fields;
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

ui.signMarkedBtn.addEventListener('click', signMarkedAreas);

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

signatureCanvas.addEventListener('pointerdown', startSignatureStroke);
signatureCanvas.addEventListener('pointermove', continueSignatureStroke);
signatureCanvas.addEventListener('pointerup', endSignatureStroke);
signatureCanvas.addEventListener('pointercancel', endSignatureStroke);
signatureCanvas.addEventListener('pointerleave', endSignatureStroke);
viewerPane.addEventListener('scroll', updateCurrentPageFromScroll);

window.addEventListener('keydown', (event) => {
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
