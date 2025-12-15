/* Layering Tool Mobile - app.js
   Mobile-first HTML Canvas layer tool: import, move (pan/pinch/rotate), brush erase/restore with offset,
   persistent brush indicator, undo/redo, export PNG, layers list (select/reorder/visibility/delete).
*/
(() => {
  'use strict';

  // ---------- DOM ----------
  const canvas = document.getElementById('canvas');

  const btnImport = document.getElementById('btnImport');
  const fileInput = document.getElementById('fileInput');
  const btnSave = document.getElementById('btnSave');
  const btnFlip = document.getElementById('btnFlip');

  const sliderOpacity = document.getElementById('sliderOpacity');
  const valOpacity = document.getElementById('valOpacity');

  const curtain = document.getElementById('curtain');
  const btnCurtainToggle = document.getElementById('btnCurtainToggle');
  const chevron = document.getElementById('chevron');

  const btnUndo = document.getElementById('btnUndo');
  const btnRedo = document.getElementById('btnRedo');

  const btnTool = document.getElementById('btnTool');
  const toolName = document.getElementById('toolName');
  const btnLayers = document.getElementById('btnLayers');

  const sliderBrushSize = document.getElementById('sliderBrushSize');
  const sliderHardness = document.getElementById('sliderHardness');
  const sliderStrength = document.getElementById('sliderStrength');

  const valBrushSize = document.getElementById('valBrushSize');
  const valHardness = document.getElementById('valHardness');
  const valStrength = document.getElementById('valStrength');

  const toggleIndicator = document.getElementById('toggleIndicator');

  const toggleMagic = document.getElementById('toggleMagic');
  const magicControls = document.getElementById('magicControls');
  const sliderMagicTol = document.getElementById('sliderMagicTol');
  const valMagicTol = document.getElementById('valMagicTol');

  const layersModal = document.getElementById('layersModal');
  const layersBackdrop = document.getElementById('layersBackdrop');
  const btnCloseLayers = document.getElementById('btnCloseLayers');
  const layersList = document.getElementById('layersList');

  const toastEl = document.getElementById('toast');

  // Crop modal
  const cropModal = document.getElementById('cropModal');
  const cropBackdrop = document.getElementById('cropBackdrop');
  const cropCanvas = document.getElementById('cropCanvas');
  const cropTitle = document.getElementById('cropTitle');
  const cropHint = document.getElementById('cropHint');
  const btnCropCancel = document.getElementById('btnCropCancel');
  const btnCropOk = document.getElementById('btnCropOk');

  // ---------- Canvas sizing ----------
  const ctx = canvas.getContext('2d', { alpha: true, desynchronized: true });

  let dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
  let viewW = 0;
  let viewH = 0;

  // View (camera) transform for zooming/panning the whole workspace (does not change layers)
  const camera = {
    scale: 1,
    tx: 0,
    ty: 0
  };
  const MIN_VIEW_SCALE = 0.5;
  const MAX_VIEW_SCALE = 8;


  function resizeCanvas() {
    dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    const r = canvas.getBoundingClientRect();
    viewW = r.width;
    viewH = r.height;

    const w = Math.max(1, Math.floor(viewW * dpr));
    const h = Math.max(1, Math.floor(viewH * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      scheduleRender();
    }
  }

  window.addEventListener('resize', resizeCanvas, { passive: true });

  // ---------- Checkerboard pattern ----------
  let checkerPattern = null;
  function makeCheckerPattern() {
    const size = 24; // CSS pixels
    const c = document.createElement('canvas');
    c.width = size;
    c.height = size;
    const cctx = c.getContext('2d');

    cctx.fillStyle = '#1a1a1a';
    cctx.fillRect(0, 0, size, size);

    cctx.fillStyle = '#232323';
    cctx.fillRect(0, 0, size / 2, size / 2);
    cctx.fillRect(size / 2, size / 2, size / 2, size / 2);

    checkerPattern = ctx.createPattern(c, 'repeat');
  }

  // ---------- State ----------
  const Tool = Object.freeze({ MOVE: 'move', ERASE: 'erase', RESTORE: 'restore', ZOOM: 'zoom' });

  /** @type {'move'|'erase'|'restore'|'zoom'} */
  let tool = Tool.MOVE;

  /** @type {Array<Layer>} */
  const layers = [];
  let activeLayerId = null;
  let layerCounter = 0;

  const undoStack = [];
  const redoStack = [];
  const MAX_HISTORY = 30;

  // Brush settings
  let brushSize = Number(sliderBrushSize.value); // diameter in screen px
  let hardness = Number(sliderHardness.value) / 100; // 0..1
  let strength = Number(sliderStrength.value) / 100; // 0..1
  let magicEnabled = false;
  let magicTol = Number(sliderMagicTol?.value ?? 25); // 0..100
  let offsetPx = 0; // PC: no offset needed (mouse cursor is precise)
  let indicatorOn = toggleIndicator.checked;

  // Brush indicator position (screen/canvas coords)
  let indicatorDot = { x: viewW * 0.5, y: viewH * 0.5 };
  let indicatorHasPos = false;

  // Pointer tracking
  /** @type {Map<number, {x:number,y:number}>} */
  const pointers = new Map();

  // Move gesture
  let moveGesture = {
    active: false,
    mode: 'none', // 'one'|'two'|'rotateHandle'
    startRotAngle: 0
    startLayer: null,
    startTransform: null,
    startPointer: null,
    startPointerW: null,
    startCenter: null,
    startCenterW: null,
    startDist: 0,
    startAngle: 0
  };

  // Zoom/pan gesture (camera)
  let zoomGesture = {
    active: false,
    mode: 'none', // 'one'|'two'|'rotateHandle'
    startRotAngle: 0
    startPointer: null, // screen
    startTx: 0,
    startTy: 0,
    startScale: 1,
    startMid: null, // screen
    startWorldMid: null, // world
    startDist: 0
  };


  // Brush stroke
  let brushStroke = {
    active: false,
    pointerId: null,
    lastCenter: null,
    bbox: null, // {x0,y0,x1,y1} in mask coords (integer, inclusive-exclusive)
    beforePatch: null, // {x,y,w,h,data:ImageData}
    bboxCaptured: null // for incremental capture bookkeeping
  };

  // Rendering
  let rafScheduled = false;
  let renderDirty = true;

  function scheduleRender() {
    renderDirty = true;
    if (rafScheduled) return;
    rafScheduled = true;
    requestAnimationFrame(() => {
      rafScheduled = false;
      if (renderDirty) render();
    });
  }

  // ---------- Utilities ----------
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.remove('hidden');
    window.clearTimeout(toast.__t);
    toast.__t = window.setTimeout(() => toastEl.classList.add('hidden'), 1800);
  }

  
  // ---------- Crop controller ----------
  const CropController = (() => {
    const c = cropCanvas;
    const cctx = c.getContext('2d', { alpha: true, desynchronized: true });

    let dprCrop = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    let view = { w: 0, h: 0 };

    let sourceCanvas = null;

    // Display transform: image -> cropCanvas (CSS px)
    let fit = { scale: 1, ox: 0, oy: 0 };

    // Crop rect in source pixel coords
    let rect = { x: 0, y: 0, w: 1, h: 1 };

    // Pointer drag state
    let dragging = false;
    let dragMode = 'none'; // 'move' | 'n'|'s'|'e'|'w'|'ne'|'nw'|'se'|'sw'
    let start = { px: 0, py: 0, rect: null };

    const HANDLE_R = 16; // px in view space
    const MIN_SIZE = 12; // source px

    function open({ canvas, title, hint }) {
      sourceCanvas = canvas;
      cropTitle.textContent = title || 'Crop';
      cropHint.textContent = hint || 'Dra i hörn eller kanter för att cropa. Dra i rutan för att flytta.';
      cropModal.classList.remove('hidden');

      resize();
      resetRectToFull();
      draw();
    }

    function close() {
      cropModal.classList.add('hidden');
      sourceCanvas = null;
      dragging = false;
      dragMode = 'none';
    }

    function resize() {
      dprCrop = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
      const r = c.getBoundingClientRect();
      view.w = r.width;
      view.h = r.height;

      const w = Math.max(1, Math.floor(view.w * dprCrop));
      const h = Math.max(1, Math.floor(view.h * dprCrop));
      if (c.width !== w || c.height !== h) {
        c.width = w;
        c.height = h;
      }
      computeFit();
    }

    function computeFit() {
      if (!sourceCanvas) return;
      const iw = sourceCanvas.width;
      const ih = sourceCanvas.height;

      const s = Math.min(view.w / iw, view.h / ih);
      const ox = (view.w - iw * s) / 2;
      const oy = (view.h - ih * s) / 2;
      fit = { scale: s, ox, oy };
    }

    function resetRectToFull() {
      if (!sourceCanvas) return;
      rect = { x: 0, y: 0, w: sourceCanvas.width, h: sourceCanvas.height };
    }

    function clampRect() {
      if (!sourceCanvas) return;
      const iw = sourceCanvas.width;
      const ih = sourceCanvas.height;

      rect.w = Math.max(MIN_SIZE, rect.w);
      rect.h = Math.max(MIN_SIZE, rect.h);

      rect.x = clamp(rect.x, 0, iw - rect.w);
      rect.y = clamp(rect.y, 0, ih - rect.h);

      rect.w = clamp(rect.w, MIN_SIZE, iw - rect.x);
      rect.h = clamp(rect.h, MIN_SIZE, ih - rect.y);
    }

    function viewToImage(px, py) {
      const ix = (px - fit.ox) / fit.scale;
      const iy = (py - fit.oy) / fit.scale;
      return { x: ix, y: iy };
    }

    function imageToView(ix, iy) {
      return { x: fit.ox + ix * fit.scale, y: fit.oy + iy * fit.scale };
    }

    function rectView() {
      const p0 = imageToView(rect.x, rect.y);
      const p1 = imageToView(rect.x + rect.w, rect.y + rect.h);
      return { x: p0.x, y: p0.y, w: p1.x - p0.x, h: p1.y - p0.y };
    }

    function hitTest(px, py) {
      const rv = rectView();

      const left = rv.x;
      const right = rv.x + rv.w;
      const top = rv.y;
      const bottom = rv.y + rv.h;

      const nearL = Math.abs(px - left) <= HANDLE_R;
      const nearR = Math.abs(px - right) <= HANDLE_R;
      const nearT = Math.abs(py - top) <= HANDLE_R;
      const nearB = Math.abs(py - bottom) <= HANDLE_R;

      const inside = (px >= left && px <= right && py >= top && py <= bottom);

      if (nearL && nearT) return 'nw';
      if (nearR && nearT) return 'ne';
      if (nearL && nearB) return 'sw';
      if (nearR && nearB) return 'se';
      if (nearT && inside) return 'n';
      if (nearB && inside) return 's';
      if (nearL && inside) return 'w';
      if (nearR && inside) return 'e';
      if (inside) return 'move';
      return 'none';
    }

    function draw() {
      if (!sourceCanvas) return;
      computeFit();

      cctx.clearRect(0, 0, c.width, c.height);

      cctx.save();
      cctx.setTransform(dprCrop, 0, 0, dprCrop, 0, 0);
      cctx.imageSmoothingEnabled = true;
      cctx.imageSmoothingQuality = 'high';

      cctx.fillStyle = '#0f0f0f';
      cctx.fillRect(0, 0, view.w, view.h);

      cctx.drawImage(sourceCanvas, fit.ox, fit.oy, sourceCanvas.width * fit.scale, sourceCanvas.height * fit.scale);

      const rv = rectView();

      // Darken outside
      cctx.fillStyle = 'rgba(0,0,0,0.45)';
      cctx.fillRect(0, 0, view.w, Math.max(0, rv.y));
      cctx.fillRect(0, rv.y, Math.max(0, rv.x), rv.h);
      cctx.fillRect(rv.x + rv.w, rv.y, Math.max(0, view.w - (rv.x + rv.w)), rv.h);
      cctx.fillRect(0, rv.y + rv.h, view.w, Math.max(0, view.h - (rv.y + rv.h)));

      // Outline
      cctx.strokeStyle = '#3aa0ff';
      cctx.lineWidth = 2;
      cctx.strokeRect(rv.x, rv.y, rv.w, rv.h);

      // Corner handles
      const handle = (hx, hy) => {
        cctx.fillStyle = 'rgba(58,160,255,0.95)';
        cctx.beginPath();
        cctx.arc(hx, hy, 6, 0, Math.PI * 2);
        cctx.fill();
        cctx.strokeStyle = 'rgba(0,0,0,0.55)';
        cctx.lineWidth = 2;
        cctx.stroke();
      };
      handle(rv.x, rv.y);
      handle(rv.x + rv.w, rv.y);
      handle(rv.x, rv.y + rv.h);
      handle(rv.x + rv.w, rv.y + rv.h);

      cctx.restore();
    }

    function eventToPoint(ev) {
      const r = c.getBoundingClientRect();
      return { x: (ev.clientX - r.left), y: (ev.clientY - r.top) };
    }

    function onDown(e) {
      if (e.target !== c) return;
      e.preventDefault();

      const pt = eventToPoint(e);
      const mode = hitTest(pt.x, pt.y);
      if (mode === 'none') return;

      dragging = true;
      dragMode = mode;
      start.px = pt.x;
      start.py = pt.y;
      start.rect = { ...rect };
      c.setPointerCapture(e.pointerId);
    }

    function onMove(e) {
      if (!dragging) return;
      if (e.target !== c) return;
      e.preventDefault();

      const pt = eventToPoint(e);

      const a = viewToImage(start.px, start.py);
      const b = viewToImage(pt.x, pt.y);
      const dx = b.x - a.x;
      const dy = b.y - a.y;

      rect = { ...start.rect };

      if (dragMode === 'move') {
        rect.x += dx;
        rect.y += dy;
      } else {
        if (dragMode.includes('w')) { rect.x += dx; rect.w -= dx; }
        if (dragMode.includes('e')) { rect.w += dx; }
        if (dragMode.includes('n')) { rect.y += dy; rect.h -= dy; }
        if (dragMode.includes('s')) { rect.h += dy; }

        if (dragMode === 'w') { rect.x += dx; rect.w -= dx; }
        if (dragMode === 'e') { rect.w += dx; }
        if (dragMode === 'n') { rect.y += dy; rect.h -= dy; }
        if (dragMode === 's') { rect.h += dy; }
      }

      if (rect.w < 0) { rect.x += rect.w; rect.w = Math.abs(rect.w); }
      if (rect.h < 0) { rect.y += rect.h; rect.h = Math.abs(rect.h); }

      clampRect();
      draw();
    }

    function onUp(e) {
      if (!dragging) return;
      e.preventDefault();
      dragging = false;
      dragMode = 'none';
    }

    function getRect() { return { ...rect }; }

    c.addEventListener('pointerdown', onDown, { passive: false });
    c.addEventListener('pointermove', onMove, { passive: false });
    c.addEventListener('pointerup', onUp, { passive: false });
    c.addEventListener('pointercancel', onUp, { passive: false });

    window.addEventListener('resize', () => {
      if (cropModal.classList.contains('hidden')) return;
      resize();
      draw();
    }, { passive: true });

    return { open, close, resize, draw, getRect, resetRectToFull };
  })();

function getActiveLayer() {
    if (!activeLayerId) return null;
    return layers.find(l => l.id === activeLayerId) || null;
  }

  function syncOpacityUI() {
    const layer = getActiveLayer();
    if (!sliderOpacity || !valOpacity) return;
    if (!layer) {
      sliderOpacity.disabled = true;
      sliderOpacity.value = '100';
      valOpacity.textContent = '100%';
      return;
    }
    sliderOpacity.disabled = false;
    const v = Math.round(clamp(layer.opacity, 0, 1) * 100);
    sliderOpacity.value = String(v);
    valOpacity.textContent = `${v}%`;
  }

  function setActiveLayer(id) {
    activeLayerId = id;
    clearOtherSrcCaches(id);
    syncOpacityUI();
    scheduleRender();
    renderLayersList();
  }

  function setTool(nextTool) {
    tool = nextTool;
    toolName.textContent = tool === Tool.MOVE ? 'Move' : (tool === Tool.ERASE ? 'Erase' : (tool === Tool.RESTORE ? 'Restore' : 'Zoom'));
    updateFlipButtonVisibility();
    scheduleRender();
  }


  function updateFlipButtonVisibility() {
    if (!btnFlip) return;
    const show = (tool === Tool.MOVE) && layers.length > 0;
    btnFlip.classList.toggle('hidden', !show);
  }

  function cycleTool() {
    if (tool === Tool.MOVE) setTool(Tool.ERASE);
    else if (tool === Tool.ERASE) setTool(Tool.RESTORE);
    else if (tool === Tool.RESTORE) setTool(Tool.ZOOM);
    else setTool(Tool.MOVE);
  }

  function updateUndoRedoButtons() {
    btnUndo.disabled = undoStack.length === 0;
    btnRedo.disabled = redoStack.length === 0;
  }

  function pushHistory(action) {
    undoStack.push(action);
    if (undoStack.length > MAX_HISTORY) undoStack.shift();
    redoStack.length = 0;
    updateUndoRedoButtons();
  }


  // Debounced history recording for wheel-based transforms (scale/rotate)
  let wheelCommitTimer = null;
  let wheelCommitStart = null; // { layerId, x, y, scale, rot }

  function recordWheelTransform(layer) {
    if (!layer) return;

    if (!wheelCommitStart || wheelCommitStart.layerId !== layer.id) {
      wheelCommitStart = { layerId: layer.id, x: layer.x, y: layer.y, scale: layer.scale, rot: layer.rot };
    }

    if (wheelCommitTimer) clearTimeout(wheelCommitTimer);
    wheelCommitTimer = setTimeout(() => {
      const l = findLayerById(wheelCommitStart.layerId);
      if (!l) {
        wheelCommitStart = null;
        return;
      }

      const before = { x: wheelCommitStart.x, y: wheelCommitStart.y, scale: wheelCommitStart.scale, rot: wheelCommitStart.rot };
      const after = { x: l.x, y: l.y, scale: l.scale, rot: l.rot };

      const changed =
        Math.abs(after.x - before.x) > 0.5 ||
        Math.abs(after.y - before.y) > 0.5 ||
        Math.abs(after.scale - before.scale) > 0.0005 ||
        Math.abs(after.rot - before.rot) > 0.0005;

      if (changed) {
        pushHistory({ type: 'move', layerId: l.id, before, after });
        renderLayersList();
      }

      wheelCommitStart = null;
    }, 180);
  }

  function findLayerById(id) {
    return layers.find(l => l.id === id) || null;
  }

  function eventToCanvasPoint(e) {
    const r = canvas.getBoundingClientRect();
    const x = (e.clientX - r.left);
    const y = (e.clientY - r.top);
    return { x, y };
  }

  function dist(a, b) {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return Math.hypot(dx, dy);
  }

  function angle(a, b) {
    return Math.atan2(b.y - a.y, b.x - a.x);
  }

  function screenToWorld(p) {
    return {
      x: (p.x - camera.tx) / Math.max(0.0001, camera.scale),
      y: (p.y - camera.ty) / Math.max(0.0001, camera.scale)
    };
  }

  function clampViewScale(s) {
    return clamp(s, MIN_VIEW_SCALE, MAX_VIEW_SCALE);
  }


  function unionBBox(b, rect) {
    if (!b) return { x0: rect.x0, y0: rect.y0, x1: rect.x1, y1: rect.y1 };
    return {
      x0: Math.min(b.x0, rect.x0),
      y0: Math.min(b.y0, rect.y0),
      x1: Math.max(b.x1, rect.x1),
      y1: Math.max(b.y1, rect.y1)
    };
  }

  function rectFromCenter(cx, cy, r, w, h) {
    const x0 = clamp(Math.floor(cx - r - 2), 0, w);
    const y0 = clamp(Math.floor(cy - r - 2), 0, h);
    const x1 = clamp(Math.ceil(cx + r + 2), 0, w);
    const y1 = clamp(Math.ceil(cy + r + 2), 0, h);
    return { x0, y0, x1, y1 };
  }

  // Incrementally capture the "before" mask pixels for areas we are about to modify.
  // We keep a single growing bbox and a single ImageData storing the original pixels for that bbox.
  function captureBeforeIfNeeded(layer, newBBox) {
    const mctx = layer.maskCtx;

    if (!brushStroke.beforePatch) {
      // First time, capture entire bbox
      const w = newBBox.x1 - newBBox.x0;
      const h = newBBox.y1 - newBBox.y0;
      const data = mctx.getImageData(newBBox.x0, newBBox.y0, w, h);
      brushStroke.beforePatch = { x: newBBox.x0, y: newBBox.y0, w, h, data };
      brushStroke.bboxCaptured = { ...newBBox };
      return;
    }

    const old = brushStroke.bboxCaptured;
    const patch = brushStroke.beforePatch;

    // If newBBox is inside old, nothing to capture
    if (newBBox.x0 >= old.x0 && newBBox.y0 >= old.y0 && newBBox.x1 <= old.x1 && newBBox.y1 <= old.y1) {
      return;
    }

    // Expand patch ImageData to union
    const union = unionBBox(old, newBBox);
    const newW = union.x1 - union.x0;
    const newH = union.y1 - union.y0;
    const newData = mctx.createImageData(newW, newH);

    // Copy old patch into newData
    const dx = old.x0 - union.x0;
    const dy = old.y0 - union.y0;
    blitImageData(patch.data, newData, dx, dy);

    // Helper: capture a rectangle and blit into newData
    const captureRect = (rx0, ry0, rx1, ry1) => {
      const w = rx1 - rx0;
      const h = ry1 - ry0;
      if (w <= 0 || h <= 0) return;
      const d = mctx.getImageData(rx0, ry0, w, h);
      blitImageData(d, newData, rx0 - union.x0, ry0 - union.y0);
    };

    // Capture newly added stripes (avoid double capture by careful ranges)
    // Top stripe
    if (union.y0 < old.y0) captureRect(union.x0, union.y0, union.x1, old.y0);
    // Bottom stripe
    if (union.y1 > old.y1) captureRect(union.x0, old.y1, union.x1, union.y1);
    // Middle vertical range not including top/bottom
    const midY0 = Math.max(old.y0, union.y0);
    const midY1 = Math.min(old.y1, union.y1);

    // Left stripe
    if (union.x0 < old.x0) captureRect(union.x0, midY0, old.x0, midY1);
    // Right stripe
    if (union.x1 > old.x1) captureRect(old.x1, midY0, union.x1, midY1);

    brushStroke.beforePatch = { x: union.x0, y: union.y0, w: newW, h: newH, data: newData };
    brushStroke.bboxCaptured = { ...union };
  }

  function blitImageData(src, dst, dx, dy) {
    // src and dst are ImageData
    const sw = src.width, sh = src.height;
    const dw = dst.width;
    const s = src.data;
    const d = dst.data;

    for (let y = 0; y < sh; y++) {
      const sy = y * sw * 4;
      const dyRow = (y + dy) * dw * 4 + dx * 4;
      d.set(s.subarray(sy, sy + sw * 4), dyRow);
    }
  }

  // ---------- Layer model ----------
  /**
   * @typedef {Object} Layer
   * @property {string} id
   * @property {string} name
   * @property {number} x
   * @property {number} y
   * @property {number} scale
   * @property {number} rot
   * @property {number} opacity
   * @property {boolean} visible
   * @property {HTMLCanvasElement} srcCanvas
   * @property {CanvasRenderingContext2D} srcCtx
   * @property {HTMLCanvasElement} maskCanvas
   * @property {CanvasRenderingContext2D} maskCtx
   * @property {HTMLCanvasElement} compCanvas
   * @property {CanvasRenderingContext2D} compCtx
   * @property {boolean} compDirty
   * @property {number} w
   * @property {number} h
   */

  function makeLayerFromCanvas(srcCanvas, name) {
    const w = srcCanvas.width;
    const h = srcCanvas.height;

    const layer = {
      id: `layer_${Date.now()}_${Math.random().toString(16).slice(2)}`,
      name,
      x: viewW * 0.5,
      y: viewH * 0.5,
      scale: 1,
      rot: 0,
      flipX: 1,
      flipY: 1,
      opacity: 1,
      visible: true,
      srcCanvas,
      srcCtx: srcCanvas.getContext('2d', { alpha: true, willReadFrequently: true }),
      maskCanvas: document.createElement('canvas'),
      maskCtx: null,
      compCanvas: document.createElement('canvas'),
      compCtx: null,
      compDirty: true,
      w,
      h,
      thumbUrl: '',
      thumbDirty: true
    };

    layer.maskCanvas.width = w;
    layer.maskCanvas.height = h;
    layer.maskCtx = layer.maskCanvas.getContext('2d', { alpha: true, willReadFrequently: true });
    layer.maskCtx.clearRect(0, 0, w, h);
    layer.maskCtx.fillStyle = 'rgba(255,255,255,1)';
    layer.maskCtx.fillRect(0, 0, w, h);

    layer.compCanvas.width = w;
    layer.compCanvas.height = h;
    layer.compCtx = layer.compCanvas.getContext('2d', { alpha: true, willReadFrequently: true });

    // Initial auto-scale to fit screen (60-80%)
    const fitScale = Math.min((viewW * 0.75) / w, (viewH * 0.75) / h, 1);
    layer.scale = fitScale;

    return layer;
  }

  function updateLayerComposite(layer) {
    const cctx = layer.compCtx;
    cctx.clearRect(0, 0, layer.w, layer.h);
    cctx.globalCompositeOperation = 'source-over';
    cctx.drawImage(layer.srcCanvas, 0, 0);
    cctx.globalCompositeOperation = 'destination-in';
    cctx.drawImage(layer.maskCanvas, 0, 0);
    cctx.globalCompositeOperation = 'source-over';
    layer.compDirty = false;
    layer.thumbDirty = true;
  }

  // ---------- Coordinate transforms ----------
  function canvasToLayerPixel(layer, cx, cy) {
    // layer transform uses layer.x/y as center in canvas coords (world coords, CSS pixels).
    const dx = cx - layer.x;
    const dy = cy - layer.y;

    // Inverse rotate first (rotation is after scale in the forward transform)
    const r = -layer.rot;
    const cos = Math.cos(r);
    const sin = Math.sin(r);

    const rdx = dx * cos - dy * sin;
    const rdy = dx * sin + dy * cos;

    // Inverse scale (include flips)
    const sx = (layer.scale || 1) * (layer.flipX || 1);
    const sy = (layer.scale || 1) * (layer.flipY || 1);

    const lx = rdx / (Math.abs(sx) < 0.000001 ? 1 : sx);
    const ly = rdy / (Math.abs(sy) < 0.000001 ? 1 : sy);

    const u = lx + layer.w / 2;
    const v = ly + layer.h / 2;

    return { u, v };
  }

  function isPointInsideLayer(layer, cx, cy) {
    const p = canvasToLayerPixel(layer, cx, cy);
    return (p.u >= 0 && p.v >= 0 && p.u < layer.w && p.v < layer.h);
  }

  function pickTopmostLayerAt(cx, cy) {
    // Topmost is last in layers array
    for (let i = layers.length - 1; i >= 0; i--) {
      const layer = layers[i];
      if (!layer.visible) continue;
      if (!layer.compDirty) {
        if (isPointInsideLayer(layer, cx, cy)) return layer;
      } else {
        // If dirty, we still approximate with bounds
        const p = canvasToLayerPixel(layer, cx, cy);
        if (p.u >= 0 && p.v >= 0 && p.u < layer.w && p.v < layer.h) return layer;
      }
    }
    return null;
  }

  // ---------- Brush painting ----------
  function brushCenterFromDot(dot) {
    return { x: dot.x, y: dot.y - offsetPx };
  }

  
  function ensureSrcCache(layer) {
    if (layer._srcCache && layer._srcCache.data) return;
    try {
      const img = layer.srcCtx.getImageData(0, 0, layer.w, layer.h);
      layer._srcCache = img;
    } catch (e) {
      layer._srcCache = null;
    }
  }

  function clearOtherSrcCaches(keepId) {
    for (const l of layers) {
      if (l.id !== keepId) l._srcCache = null;
    }
  }

  function sampleRefColor(layer, x, y) {
    // 3x3 average for stability
    ensureSrcCache(layer);
    const src = layer._srcCache ? layer._srcCache.data : null;
    if (!src) return { r: 0, g: 0, b: 0 };

    let rs = 0, gs = 0, bs = 0, n = 0;
    for (let oy = -1; oy <= 1; oy++) {
      const yy = clamp(y + oy, 0, layer.h - 1);
      for (let ox = -1; ox <= 1; ox++) {
        const xx = clamp(x + ox, 0, layer.w - 1);
        const i = (yy * layer.w + xx) * 4;
        rs += src[i];
        gs += src[i + 1];
        bs += src[i + 2];
        n++;
      }
    }
    return { r: rs / n, g: gs / n, b: bs / n };
  }

  function applyMagicDab(layer, p, r, mode, dabBBox) {
    ensureSrcCache(layer);
    const src = layer._srcCache ? layer._srcCache.data : null;
    if (!src) return;

    // Guard: keep responsive on very large dabs
    const MAX_MAGIC_R = 280; // layer pixels
    if (r > MAX_MAGIC_R) {
      // Fall back to normal brush behavior for extreme sizes
      const mctx = layer.maskCtx;
      mctx.save();
      mctx.globalCompositeOperation = (mode === Tool.ERASE) ? 'destination-out' : 'source-over';

      const a = strength;
      const inner = r * clamp(hardness, 0.001, 1);
      const g = mctx.createRadialGradient(p.u, p.v, inner, p.u, p.v, r);
      if (mode === Tool.ERASE) {
        g.addColorStop(0, `rgba(0,0,0,${a})`);
        g.addColorStop(1, 'rgba(0,0,0,0)');
      } else {
        g.addColorStop(0, `rgba(255,255,255,${a})`);
        g.addColorStop(1, 'rgba(255,255,255,0)');
      }
      mctx.fillStyle = g;
      mctx.beginPath();
      mctx.arc(p.u, p.v, r, 0, Math.PI * 2);
      mctx.fill();
      mctx.restore();
      return;
    }

    const cx = clamp(Math.round(p.u), 0, layer.w - 1);
    const cy = clamp(Math.round(p.v), 0, layer.h - 1);

    const x0 = dabBBox.x0, y0 = dabBBox.y0;
    const w = dabBBox.x1 - dabBBox.x0;
    const h = dabBBox.y1 - dabBBox.y0;
    if (w <= 0 || h <= 0) return;

    // Read mask patch
    const mctx = layer.maskCtx;
    const maskImg = mctx.getImageData(x0, y0, w, h);
    const md = maskImg.data;

    const ref = sampleRefColor(layer, cx, cy);

    const tol = clamp(magicTol, 0, 100) / 100;
    const maxDist2 = 255 * 255 * 3;
    const thr2 = maxDist2 * tol * tol; // squared mapping for finer control at low values

    const r2 = r * r;
    const hh = clamp(hardness, 0, 1);
    const denom = Math.max(0.0001, 1 - hh);

    const visited = new Uint8Array(w * h);
    const stack = new Int32Array(w * h);
    let sp = 0;

    const sx = cx - x0;
    const sy = cy - y0;
    if (sx < 0 || sy < 0 || sx >= w || sy >= h) return;

    stack[sp++] = sy * w + sx;

    const push = (nx, ny) => {
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) return;
      const ni = ny * w + nx;
      if (visited[ni]) return;
      stack[sp++] = ni;
    };

    while (sp > 0) {
      const li = stack[--sp];
      if (visited[li]) continue;
      visited[li] = 1;

      const lx = li % w;
      const ly = (li / w) | 0;
      const gx = x0 + lx;
      const gy = y0 + ly;

      const dx = gx - p.u;
      const dy = gy - p.v;
      const d2 = dx * dx + dy * dy;
      if (d2 > r2) continue;

      const si = (gy * layer.w + gx) * 4;
      const dr = src[si] - ref.r;
      const dg = src[si + 1] - ref.g;
      const db = src[si + 2] - ref.b;
      const cd2 = dr * dr + dg * dg + db * db;
      if (cd2 > thr2) continue;

      // Feather falloff (same semantics as current gradient brush)
      const d = Math.sqrt(d2);
      const t = d / Math.max(0.0001, r);
      let fall = 1;
      if (hh >= 0.9999) {
        fall = 1;
      } else if (t <= hh) {
        fall = 1;
      } else {
        fall = clamp(1 - (t - hh) / denom, 0, 1);
      }

      const ea = clamp(strength * fall, 0, 1);
      if (ea > 0) {
        const mi = li * 4;
        const da = md[mi + 3] / 255;

        let outA = da;
        if (mode === Tool.ERASE) outA = da * (1 - ea);
        else outA = ea + da * (1 - ea);

        md[mi] = 255;
        md[mi + 1] = 255;
        md[mi + 2] = 255;
        md[mi + 3] = Math.round(clamp(outA, 0, 1) * 255);
      }

      // 8-connected neighbors, but only expand from matching pixels (this pixel)
      push(lx - 1, ly);
      push(lx + 1, ly);
      push(lx, ly - 1);
      push(lx, ly + 1);
      push(lx - 1, ly - 1);
      push(lx + 1, ly - 1);
      push(lx - 1, ly + 1);
      push(lx + 1, ly + 1);
    }

    mctx.putImageData(maskImg, x0, y0);
  }

function applyBrushAt(layer, centerCanvas, mode) {
    // Convert to layer pixel coords
    const p = canvasToLayerPixel(layer, centerCanvas.x, centerCanvas.y);

    const radiusScreen = brushSize * 0.5; // in screen px
    const radiusPx = radiusScreen / Math.max(0.0001, layer.scale); // in layer pixels
    const r = radiusPx;

    // If outside, skip
    if (p.u < -r || p.v < -r || p.u > layer.w + r || p.v > layer.h + r) return;

    // Track bbox for undo (in mask coords)
    const dabBBox = rectFromCenter(p.u, p.v, r, layer.w, layer.h);
    brushStroke.bbox = unionBBox(brushStroke.bbox, dabBBox);

    // Capture "before" pixels for newly modified areas
    captureBeforeIfNeeded(layer, brushStroke.bbox);

    // Magic brush: contiguous color-match within the brush circle
    if (magicEnabled && (mode === Tool.ERASE || mode === Tool.RESTORE)) {
      applyMagicDab(layer, p, r, mode, dabBBox);
      layer.compDirty = true;
      return;
    }

    // Draw dab into mask
    const mctx = layer.maskCtx;
    mctx.save();
    mctx.globalCompositeOperation = (mode === Tool.ERASE) ? 'destination-out' : 'source-over';

    const g = mctx.createRadialGradient(p.u, p.v, Math.max(0, r * hardness), p.u, p.v, Math.max(0.0001, r));
    const a = strength;
    if (mode === Tool.ERASE) {
      g.addColorStop(0, `rgba(0,0,0,${a})`);
      g.addColorStop(1, 'rgba(0,0,0,0)');
    } else {
      g.addColorStop(0, `rgba(255,255,255,${a})`);
      g.addColorStop(1, 'rgba(255,255,255,0)');
    }

    mctx.fillStyle = g;
    mctx.beginPath();
    mctx.arc(p.u, p.v, r, 0, Math.PI * 2);
    mctx.fill();
    mctx.restore();

    layer.compDirty = true;
  }

  function applyBrushInterpolated(layer, fromCenter, toCenter, mode) {
    const r = (brushSize * 0.5) / Math.max(0.0001, layer.scale);
    const step = Math.max(1, r * 0.35);
    const dx = toCenter.x - fromCenter.x;
    const dy = toCenter.y - fromCenter.y;
    const len = Math.hypot(dx, dy);
    const n = Math.max(1, Math.ceil(len / step));

    for (let i = 1; i <= n; i++) {
      const t = i / n;
      const cx = fromCenter.x + dx * t;
      const cy = fromCenter.y + dy * t;
      applyBrushAt(layer, { x: cx, y: cy }, mode);
    }
  }

  function finalizeBrushStroke(layer) {
    if (!brushStroke.bbox || !brushStroke.beforePatch) return;

    const beforePatch = brushStroke.beforePatch;
    const x = beforePatch.x;
    const y = beforePatch.y;
    const w = beforePatch.w;
    const h = beforePatch.h;

    const after = layer.maskCtx.getImageData(x, y, w, h);

    const action = {
      type: 'mask',
      layerId: layer.id,
      bbox: { x, y, w, h },
      before: beforePatch.data,
      after
    };

    pushHistory(action);
  }

  // ---------- Undo / Redo ----------
  function doUndo() {
    const action = undoStack.pop();
    if (!action) return;
    redoStack.push(action);

    if (action.type === 'move') {
      const layer = findLayerById(action.layerId);
      if (layer) {
        layer.x = action.before.x;
        layer.y = action.before.y;
        layer.scale = action.before.scale;
        layer.rot = action.before.rot;
      }
    } else if (action.type === 'flip') {
      const layer = findLayerById(action.layerId);
      if (layer) {
        layer.flipX = action.before.flipX;
        layer.flipY = action.before.flipY;
        layer.thumbDirty = true;
      }
    } else if (action.type === 'opacity') {
      const layer = findLayerById(action.layerId);
      if (layer) {
        layer.opacity = clamp(action.before, 0, 1);
      }
    } else if (action.type === 'mask') {
      const layer = findLayerById(action.layerId);
      if (layer) {
        const b = action.bbox;
        layer.maskCtx.putImageData(action.before, b.x, b.y);
        layer.compDirty = true;
      }
    }

    syncOpacityUI();
    updateUndoRedoButtons();
    scheduleRender();
    renderLayersList();
  }

  function doRedo() {
    const action = redoStack.pop();
    if (!action) return;
    undoStack.push(action);

    if (action.type === 'move') {
      const layer = findLayerById(action.layerId);
      if (layer) {
        layer.x = action.after.x;
        layer.y = action.after.y;
        layer.scale = action.after.scale;
        layer.rot = action.after.rot;
      }
    } else if (action.type === 'flip') {
      const layer = findLayerById(action.layerId);
      if (layer) {
        layer.flipX = action.after.flipX;
        layer.flipY = action.after.flipY;
        layer.thumbDirty = true;
      }
    } else if (action.type === 'opacity') {
      const layer = findLayerById(action.layerId);
      if (layer) {
        layer.opacity = clamp(action.after, 0, 1);
      }
    } else if (action.type === 'mask') {
      const layer = findLayerById(action.layerId);
      if (layer) {
        const b = action.bbox;
        layer.maskCtx.putImageData(action.after, b.x, b.y);
        layer.compDirty = true;
      }
    }

    syncOpacityUI();
    updateUndoRedoButtons();
    scheduleRender();
    renderLayersList();
  }

  // ---------- Rendering ----------
  function drawCheckerboard() {
    if (!checkerPattern) makeCheckerPattern();
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Apply view transform
    ctx.translate(camera.tx, camera.ty);
    ctx.scale(camera.scale, camera.scale);

    // Fill the currently visible world rect so the pattern covers the screen
    const worldX = (-camera.tx) / Math.max(0.0001, camera.scale);
    const worldY = (-camera.ty) / Math.max(0.0001, camera.scale);
    const worldW = viewW / Math.max(0.0001, camera.scale);
    const worldH = viewH / Math.max(0.0001, camera.scale);

    ctx.fillStyle = checkerPattern;
    ctx.fillRect(worldX, worldY, worldW, worldH);
    ctx.restore();
  }

  function drawLayers() {
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Apply view transform (camera)
    ctx.translate(camera.tx, camera.ty);
    ctx.scale(camera.scale, camera.scale);

    for (const layer of layers) {
      if (!layer.visible) continue;
      if (layer.compDirty) updateLayerComposite(layer);

      ctx.save();
      ctx.translate(layer.x, layer.y);
      ctx.rotate(layer.rot);
      ctx.scale(layer.scale * (layer.flipX || 1), layer.scale * (layer.flipY || 1));
      ctx.globalAlpha = layer.opacity;
      ctx.drawImage(layer.compCanvas, -layer.w / 2, -layer.h / 2);
      ctx.restore();
    }

    ctx.restore();
  }

  function getRotateHandleWorld(layer) {
    const gap = 34 / Math.max(0.0001, camera.scale); // ~34px on screen
    const r = 12 / Math.max(0.0001, camera.scale);   // ~12px on screen

    const cos = Math.cos(layer.rot);
    const sin = Math.sin(layer.rot);

    // bottom center in layer local space: (0, +h/2)
    const bx = layer.x + (0 * cos - (layer.h / 2) * sin) * layer.scale;
    const by = layer.y + (0 * sin + (layer.h / 2) * cos) * layer.scale;

    // down direction from rotation of local +Y
    const dx = -sin;
    const dy = cos;

    return { x: bx + dx * gap, y: by + dy * gap, r };
  }

  function drawMoveOverlay() {
    if (tool !== Tool.MOVE) return;
    const layer = getActiveLayer();
    if (!layer) return;

    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Apply camera transform (world -> screen)
    ctx.translate(camera.tx, camera.ty);
    ctx.scale(camera.scale, camera.scale);

    // Active outline
    ctx.save();
    ctx.translate(layer.x, layer.y);
    ctx.rotate(layer.rot);
    ctx.scale(layer.scale * (layer.flipX || 1), layer.scale * (layer.flipY || 1));
    ctx.strokeStyle = 'rgba(120, 180, 255, 0.85)';
    ctx.lineWidth = 2 / Math.max(0.0001, camera.scale);
    ctx.strokeRect(-layer.w / 2, -layer.h / 2, layer.w, layer.h);
    ctx.restore();

    // Rotation handle
    const h = getRotateHandleWorld(layer);

    // Also draw a line from the bottom edge towards the handle
    const cos = Math.cos(layer.rot);
    const sin = Math.sin(layer.rot);
    const bx = layer.x + (0 * cos - (layer.h / 2) * sin) * layer.scale;
    const by = layer.y + (0 * sin + (layer.h / 2) * cos) * layer.scale;

    ctx.strokeStyle = 'rgba(255,255,255,0.75)';
    ctx.lineWidth = 2 / Math.max(0.0001, camera.scale);
    ctx.beginPath();
    ctx.moveTo(bx, by);
    ctx.lineTo(h.x, h.y);
    ctx.stroke();

    ctx.fillStyle = 'rgba(25,25,25,0.92)';
    ctx.strokeStyle = 'rgba(120, 180, 255, 0.95)';
    ctx.lineWidth = 2 / Math.max(0.0001, camera.scale);
    ctx.beginPath();
    ctx.arc(h.x, h.y, h.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.font = `${Math.max(10, 12 / Math.max(0.0001, camera.scale))}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('⟳', h.x, h.y + (0.5 / Math.max(0.0001, camera.scale)));

    ctx.restore();
  }


  function drawBrushIndicator() {
    if (!indicatorOn) return;
    if (tool === Tool.MOVE || tool === Tool.ZOOM) return;
    const layer = getActiveLayer();
    if (!layer) return;
    if (!indicatorHasPos) return;

    const dot = indicatorDot;
    const center = brushCenterFromDot(dot);
    const outerR = (brushSize * 0.5) * camera.scale;
    const innerR = outerR * hardness;

    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Line between dot and center when offset > 0
    if (offsetPx > 0.5) {
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(dot.x, dot.y);
      ctx.lineTo(center.x, center.y);
      ctx.stroke();
    }

    // Outer circle (blue)
    ctx.strokeStyle = '#3aa0ff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(center.x, center.y, outerR, 0, Math.PI * 2);
    ctx.stroke();

    // Inner circle (grey)
    ctx.strokeStyle = '#9b9b9b';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(center.x, center.y, innerR, 0, Math.PI * 2);
    ctx.stroke();

    // Dot (red) at finger point
    ctx.fillStyle = '#ff3b3b';
    ctx.beginPath();
    ctx.arc(dot.x, dot.y, 4.5, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }

  function render() {
    renderDirty = false;

    // Clear fully
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Checkerboard background
    drawCheckerboard();

    // Composition
    drawLayers();

    // Move overlay (active outline + rotate handle)
    drawMoveOverlay();

    // Overlay indicator
    drawBrushIndicator();
  }

  
  // ---------- Crop flow (promise wrapper around CropController) ----------
  const CropFlow = {
    active: false,
    _resolve: null,
    _reject: null,
    start({ sourceCanvas, title, hint }) {
      this.active = true;
      CropController.open({ canvas: sourceCanvas, title: title || 'Crop', hint: hint || '' });

      return new Promise((resolve, reject) => {
        this._resolve = resolve;
        this._reject = reject;
      });
    },
    cancel() {
      if (!this.active) return;
      const rej = this._reject;
      this._resolve = null;
      this._reject = null;
      this.active = false;
      CropController.close();
      if (rej) rej(new Error('Crop cancelled'));
    },
    confirm() {
      if (!this.active) return;
      const res = this._resolve;
      const rect = CropController.getRect();
      this._resolve = null;
      this._reject = null;
      this.active = false;
      CropController.close();
      if (res) res({ rect });
    }
  };

// ---------- Import ----------
  async function fileToBitmap(file) {
    // Best effort: respect EXIF orientation
    if ('createImageBitmap' in window) {
      try {
        return await createImageBitmap(file, { imageOrientation: 'from-image' });
      } catch {
        // fallback below
      }
    }

    // Fallback: FileReader -> Image
    const dataUrl = await new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onerror = () => reject(new Error('FileReader error'));
      fr.onload = () => resolve(String(fr.result));
      fr.readAsDataURL(file);
    });

    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('Image load error'));
      i.src = dataUrl;
    });

    // Convert to bitmap-like
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const cctx = c.getContext('2d');
    cctx.drawImage(img, 0, 0);
    return c;
  }

  function drawScaledToCanvas(bitmap, maxDim) {
    const bw = bitmap.width || bitmap.naturalWidth || bitmap.videoWidth || bitmap.displayWidth || bitmap.bitmapWidth || 0;
    const bh = bitmap.height || bitmap.naturalHeight || bitmap.videoHeight || bitmap.displayHeight || bitmap.bitmapHeight || 0;

    const w0 = bw || bitmap.width;
    const h0 = bh || bitmap.height;

    const scale = Math.min(1, maxDim / Math.max(w0, h0));
    const w = Math.max(1, Math.round(w0 * scale));
    const h = Math.max(1, Math.round(h0 * scale));

    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const cctx = c.getContext('2d', { alpha: true });

    cctx.imageSmoothingEnabled = true;
    cctx.imageSmoothingQuality = 'high';
    cctx.drawImage(bitmap, 0, 0, w, h);

    return c;
  }

  async function importFiles(fileList) {
    if (!fileList || fileList.length === 0) return;

    const maxDim = clamp(Math.floor(Math.max(viewW, viewH) * 2.2), 1024, 2048);

    for (const file of fileList) {
      try {
        const bitmap = await fileToBitmap(file);
        const scaledCanvas = drawScaledToCanvas(bitmap, maxDim);

        let rect;
        try {
          const result = await CropFlow.start({
            sourceCanvas: scaledCanvas,
            title: 'Crop before import',
            hint: 'Justera rutan, tryck OK för att lägga in som nytt lager.'
          });
          rect = result.rect;
        } catch {
          continue;
        }

        const cropCanvas2 = document.createElement('canvas');
        cropCanvas2.width = Math.max(1, Math.floor(rect.w));
        cropCanvas2.height = Math.max(1, Math.floor(rect.h));
        const cc2 = cropCanvas2.getContext('2d', { alpha: true });
        cc2.imageSmoothingEnabled = true;
        cc2.imageSmoothingQuality = 'high';
        cc2.drawImage(
          scaledCanvas,
          rect.x, rect.y, rect.w, rect.h,
          0, 0, cropCanvas2.width, cropCanvas2.height
        );

        layerCounter += 1;
        const name = `Layer ${layerCounter}`;
        const layer = makeLayerFromCanvas(cropCanvas2, name);
        layers.push(layer);
        setActiveLayer(layer.id);

        toast(`Importerade: ${name}`);
      } catch (err) {
        console.error(err);
        toast('Kunde inte importera en av bilderna');
      }
    }

    scheduleRender();
    renderLayersList();
  }

  // ---------- Export ----------
  async function exportPNG() {
    if (layers.length === 0) {
      toast('Inga lager att exportera');
      return;
    }

    const full = document.createElement('canvas');
    full.width = canvas.width;
    full.height = canvas.height;
    const fctx = full.getContext('2d', { alpha: true });

    fctx.clearRect(0, 0, full.width, full.height);

    fctx.save();
    fctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    for (const layer of layers) {
      if (!layer.visible) continue;
      if (layer.compDirty) updateLayerComposite(layer);

      fctx.save();
      fctx.translate(layer.x, layer.y);
      fctx.rotate(layer.rot);
      fctx.scale(layer.scale * (layer.flipX || 1), layer.scale * (layer.flipY || 1));
      fctx.globalAlpha = layer.opacity;
      fctx.drawImage(layer.compCanvas, -layer.w / 2, -layer.h / 2);
      fctx.restore();
    }

    fctx.restore();

    let rect;
    try {
      const res = await CropFlow.start({
        sourceCanvas: full,
        title: 'Crop before export',
        hint: 'Justera rutan för slutlig export, tryck OK för att spara PNG.'
      });
      rect = res.rect;
    } catch {
      return;
    }

    const out = document.createElement('canvas');
    out.width = Math.max(1, Math.floor(rect.w));
    out.height = Math.max(1, Math.floor(rect.h));
    const octx = out.getContext('2d', { alpha: true });
    octx.clearRect(0, 0, out.width, out.height);
    octx.drawImage(full, rect.x, rect.y, rect.w, rect.h, 0, 0, out.width, out.height);

    const blob = await new Promise((resolve) => out.toBlob(resolve, 'image/png'));
    if (!blob) {
      toast('Export misslyckades');
      return;
    }

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'layering-tool.png';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);

    toast('Export klar (PNG)');
  }

  // ---------- Layers UI ----------
  function openLayers() {
    layersModal.classList.remove('hidden');
    renderLayersList();
  }

  function closeLayers() {
    layersModal.classList.add('hidden');
  }

  function moveLayerIndex(from, to) {
    if (from === to) return;
    const l = layers.splice(from, 1)[0];
    layers.splice(to, 0, l);
    scheduleRender();
    renderLayersList();
  }

  function deleteLayer(id) {
    const idx = layers.findIndex(l => l.id === id);
    if (idx < 0) return;
    layers.splice(idx, 1);

    if (activeLayerId === id) {
      const newActive = layers.length ? layers[layers.length - 1].id : null;
      activeLayerId = newActive;
    }

    scheduleRender();
    renderLayersList();
  }

  function makeThumbDataUrl(layer) {
    if (!layer.thumbDirty && layer.thumbUrl) return layer.thumbUrl;

    const t = document.createElement('canvas');
    const max = 80;
    const s = Math.min(1, max / Math.max(layer.w, layer.h));
    t.width = Math.max(1, Math.floor(layer.w * s));
    t.height = Math.max(1, Math.floor(layer.h * s));
    const tctx = t.getContext('2d', { alpha: true });

    if (layer.compDirty) updateLayerComposite(layer);

    tctx.save();
    tctx.translate(t.width / 2, t.height / 2);
    tctx.scale(layer.flipX || 1, layer.flipY || 1);
    tctx.drawImage(layer.compCanvas, -t.width / 2, -t.height / 2, t.width, t.height);
    tctx.restore();

    try {
      layer.thumbUrl = t.toDataURL('image/png');
    } catch {
      layer.thumbUrl = '';
    }
    layer.thumbDirty = false;
    return layer.thumbUrl;
  }

  function renderLayersList() {
    layersList.innerHTML = '';

    if (layers.length === 0) {
      const empty = document.createElement('div');
      empty.style.padding = '16px';
      empty.style.color = '#bdbdbd';
      empty.textContent = 'Inga lager ännu. Tryck Import för att lägga till bilder.';
      layersList.appendChild(empty);
      return;
    }

    // Display topmost first in list
    const shown = [...layers].reverse();

    for (const layer of shown) {
      const item = document.createElement('div');
      item.className = 'layer-item' + (layer.id === activeLayerId ? ' active' : '');
      item.tabIndex = 0;

      const thumb = document.createElement('img');
      thumb.className = 'layer-thumb';
      thumb.alt = '';
      thumb.src = makeThumbDataUrl(layer);

      const main = document.createElement('div');
      main.className = 'layer-main';

      const title = document.createElement('div');
      title.className = 'layer-title';
      title.textContent = layer.name + (layer.visible ? '' : ' (hidden)');

      const actions = document.createElement('div');
      actions.className = 'layer-actions';

      const btnSelect = document.createElement('button');
      btnSelect.className = 'smallbtn';
      btnSelect.type = 'button';
      btnSelect.textContent = (layer.id === activeLayerId) ? 'Active' : 'Select';
      btnSelect.addEventListener('click', () => setActiveLayer(layer.id));

      const btnEye = document.createElement('button');
      btnEye.className = 'smallbtn';
      btnEye.type = 'button';
      btnEye.textContent = layer.visible ? 'Eye' : 'Eye off';
      btnEye.addEventListener('click', () => {
        layer.visible = !layer.visible;
        scheduleRender();
        renderLayersList();
      });

      const idxReal = layers.findIndex(l => l.id === layer.id);
      const btnUp = document.createElement('button');
      btnUp.className = 'smallbtn';
      btnUp.type = 'button';
      btnUp.textContent = 'Up';
      btnUp.disabled = idxReal >= layers.length - 1; // topmost cannot go further up
      btnUp.addEventListener('click', () => moveLayerIndex(idxReal, idxReal + 1));

      const btnDown = document.createElement('button');
      btnDown.className = 'smallbtn';
      btnDown.type = 'button';
      btnDown.textContent = 'Down';
      btnDown.disabled = idxReal <= 0; // bottommost cannot go further down
      btnDown.addEventListener('click', () => moveLayerIndex(idxReal, idxReal - 1));

      const btnExp = document.createElement('button');
      btnExp.className = 'smallbtn';
      btnExp.type = 'button';
      btnExp.textContent = 'Export';
      btnExp.addEventListener('click', async () => {
        if (layer.compDirty) updateLayerComposite(layer);

        const out = document.createElement('canvas');
        out.width = layer.w;
        out.height = layer.h;
        const octx = out.getContext('2d', { alpha: true });
        octx.clearRect(0, 0, out.width, out.height);
        octx.save();
        octx.translate(out.width / 2, out.height / 2);
        octx.scale(layer.flipX || 1, layer.flipY || 1);
        octx.drawImage(layer.compCanvas, -out.width / 2, -out.height / 2);
        octx.restore();

        const blob = await new Promise((resolve) => out.toBlob(resolve, 'image/png'));
        if (!blob) {
          toast('Layer export misslyckades');
          return;
        }

        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${layer.name.replace(/\s+/g, '_').toLowerCase()}.png`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);

        toast('Layer exporterad (PNG)');
      });

      const btnDel = document.createElement('button');
      btnDel.className = 'smallbtn danger';
      btnDel.type = 'button';
      btnDel.textContent = 'Delete';
      btnDel.addEventListener('click', () => deleteLayer(layer.id));

      actions.appendChild(btnSelect);
      actions.appendChild(btnEye);
      actions.appendChild(btnUp);
      actions.appendChild(btnDown);
      actions.appendChild(btnExp);
      actions.appendChild(btnDel);

      main.appendChild(title);
      main.appendChild(actions);

      item.appendChild(thumb);
      item.appendChild(main);

      item.addEventListener('click', (ev) => {
        // clicking inside buttons should not double-select
        if (ev.target && ev.target.tagName === 'BUTTON') return;
        setActiveLayer(layer.id);
      });

      layersList.appendChild(item);
    }
    updateFlipButtonVisibility();
  }

  // ---------- Curtain ----------
  let curtainCollapsed = false;
  function setCurtainCollapsed(collapsed) {
    curtainCollapsed = collapsed;
    curtain.classList.toggle('collapsed', collapsed);
    curtain.classList.toggle('expanded', !collapsed);
    chevron.textContent = collapsed ? '▴' : '▾';
    btnCurtainToggle.setAttribute('aria-label', collapsed ? 'Expandera panel' : 'Kollapsa panel');
  }

  // ---------- Pointer handling ----------
  function onPointerDown(e) {
    // Ignore when interacting with UI elements (they have their own handlers)
    if (e.target !== canvas) return;

    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);

    const pt = eventToCanvasPoint(e);
    pointers.set(e.pointerId, pt);

    // Update brush indicator dot position whenever user touches canvas
    indicatorDot = { x: pt.x, y: pt.y };
    indicatorHasPos = true;

    const active = getActiveLayer();

    if (tool === Tool.ZOOM) {
      zoomGesture.active = true;

      if (pointers.size === 1) {
        // Rotation handle drag (mouse)
        if (moveGesture.mode === 'rotateHandle') {
          const st = moveGesture.startTransform;
          const ptW = screenToWorld(pt);
          const a = Math.atan2(ptW.y - layer.y, ptW.x - layer.x);
          const da = a - moveGesture.startRotAngle;
          layer.rot = st.rot + da;
          layer.thumbDirty = true;
          scheduleRender();
          return;
        }

        zoomGesture.mode = 'one';
        zoomGesture.startPointer = { x: pt.x, y: pt.y };
        zoomGesture.startTx = camera.tx;
        zoomGesture.startTy = camera.ty;
      } else if (pointers.size >= 2) {
        const pts = [...pointers.values()].slice(0, 2);
        const mid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };

        zoomGesture.mode = 'two';
        zoomGesture.startScale = camera.scale;
        zoomGesture.startTx = camera.tx;
        zoomGesture.startTy = camera.ty;
        zoomGesture.startMid = mid;
        zoomGesture.startDist = dist(pts[0], pts[1]);
        zoomGesture.startWorldMid = {
          x: (mid.x - camera.tx) / Math.max(0.0001, camera.scale),
          y: (mid.y - camera.ty) / Math.max(0.0001, camera.scale)
        };
      }

      scheduleRender();
      return;
    }

    if (tool === Tool.MOVE) {
      // Move always affects the currently active layer (selected in Layers)
      const layer = getActiveLayer();
      if (!layer) return;

      moveGesture.active = true;

      if (pointers.size === 1) {
        // PC: rotation handle (mouse). If user clicks it, rotate instead of move.
        if (e.pointerType === 'mouse') {
          const ptW = screenToWorld(pt);
          const h = getRotateHandleWorld(layer);
          if (dist(ptW, h) <= h.r + (6 / Math.max(0.0001, camera.scale))) {
            moveGesture.mode = 'rotateHandle';
            moveGesture.startLayer = layer;
            moveGesture.startTransform = { x: layer.x, y: layer.y, scale: layer.scale, rot: layer.rot };
            moveGesture.startRotAngle = Math.atan2(ptW.y - layer.y, ptW.x - layer.x);
            scheduleRender();
            return;
          }
        }

        moveGesture.mode = 'one';
        moveGesture.startLayer = layer;
        moveGesture.startTransform = { x: layer.x, y: layer.y, scale: layer.scale, rot: layer.rot };
        moveGesture.startPointer = { x: pt.x, y: pt.y };
          moveGesture.startPointerW = screenToWorld(pt);
      } else if (pointers.size === 2) {
        const pts = [...pointers.values()];
        const c = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
        moveGesture.mode = 'two';
        moveGesture.startLayer = layer;
        moveGesture.startTransform = { x: layer.x, y: layer.y, scale: layer.scale, rot: layer.rot };
        moveGesture.startCenter = c;
          moveGesture.startCenterW = screenToWorld(c);
        moveGesture.startDist = dist(pts[0], pts[1]);
        moveGesture.startAngle = angle(pts[0], pts[1]);
      }

      scheduleRender();
      return;
    }

    // Brush tools
    if (!active) return;

    brushStroke.active = true;
    brushStroke.pointerId = e.pointerId;
    const _centerS0 = brushCenterFromDot(indicatorDot);
    const _centerW0 = screenToWorld(_centerS0);
    brushStroke.lastCenter = _centerW0;
    brushStroke.bbox = null;
    brushStroke.beforePatch = null;
    brushStroke.bboxCaptured = null;

    // Apply first dab immediately
    applyBrushAt(active, brushStroke.lastCenter, tool);
    scheduleRender();
  }

  function onPointerMove(e) {
    if (e.target !== canvas) return;
    if (!pointers.has(e.pointerId)) return;

    e.preventDefault();
    const pt = eventToCanvasPoint(e);
    pointers.set(e.pointerId, pt);

    // Always update indicator dot in real time for the active pointer
    if (tool === Tool.ERASE || tool === Tool.RESTORE) {
      if (brushStroke.active && brushStroke.pointerId === e.pointerId) {
        indicatorDot = { x: pt.x, y: pt.y };
        indicatorHasPos = true;
      }
    } else {
      // Move: use primary pointer as dot position just for consistency (indicator not shown)
      indicatorDot = { x: pt.x, y: pt.y };
      indicatorHasPos = true;
    }

    const layer = getActiveLayer();
    if (!layer) {
      scheduleRender();
      return;
    }

    if (tool === Tool.ZOOM) {
      if (!zoomGesture.active) return;

      if (pointers.size === 1) {
        if (zoomGesture.mode !== 'one') {
          zoomGesture.mode = 'one';
          zoomGesture.startPointer = { x: pt.x, y: pt.y };
          zoomGesture.startTx = camera.tx;
          zoomGesture.startTy = camera.ty;
        }
        const sp = zoomGesture.startPointer;
        camera.tx = zoomGesture.startTx + (pt.x - sp.x);
        camera.ty = zoomGesture.startTy + (pt.y - sp.y);
        scheduleRender();
        return;
      }

      if (pointers.size >= 2) {
        const pts = [...pointers.values()].slice(0, 2);
        const mid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };

        if (zoomGesture.mode !== 'two') {
          zoomGesture.mode = 'two';
          zoomGesture.startScale = camera.scale;
          zoomGesture.startTx = camera.tx;
          zoomGesture.startTy = camera.ty;
          zoomGesture.startMid = mid;
          zoomGesture.startDist = dist(pts[0], pts[1]);
          zoomGesture.startWorldMid = {
            x: (mid.x - camera.tx) / Math.max(0.0001, camera.scale),
            y: (mid.y - camera.ty) / Math.max(0.0001, camera.scale)
          };
        }

        const newDist = dist(pts[0], pts[1]);
        const ratio = (zoomGesture.startDist > 0.0001) ? (newDist / zoomGesture.startDist) : 1;
        const newScale = clampViewScale(zoomGesture.startScale * ratio);

        camera.scale = newScale;
        camera.tx = mid.x - zoomGesture.startWorldMid.x * newScale;
        camera.ty = mid.y - zoomGesture.startWorldMid.y * newScale;

        scheduleRender();
        return;
      }

      return;
    }

    if (tool === Tool.MOVE) {
      if (!moveGesture.active) return;

      if (pointers.size === 1) {
        if (moveGesture.mode !== 'one') {
          // Re-init single-finger drag
          moveGesture.mode = 'one';
          moveGesture.startLayer = layer;
          moveGesture.startTransform = { x: layer.x, y: layer.y, scale: layer.scale, rot: layer.rot };
          moveGesture.startPointer = { x: pt.x, y: pt.y };
          moveGesture.startPointerW = screenToWorld(pt);
        }
        const spW = moveGesture.startPointerW;
        const st = moveGesture.startTransform;
        const ptW = screenToWorld(pt);
        const dx = ptW.x - spW.x;
        const dy = ptW.y - spW.y;
        layer.x = st.x + dx;
        layer.y = st.y + dy;
        scheduleRender();
        return;
      }

      if (pointers.size >= 2) {
        const pts = [...pointers.values()].slice(0, 2);
        const c = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };

        if (moveGesture.mode !== 'two') {
          moveGesture.mode = 'two';
          moveGesture.startLayer = layer;
          moveGesture.startTransform = { x: layer.x, y: layer.y, scale: layer.scale, rot: layer.rot };
          moveGesture.startCenter = c;
          moveGesture.startCenterW = screenToWorld(c);
          moveGesture.startDist = dist(pts[0], pts[1]);
          moveGesture.startAngle = angle(pts[0], pts[1]);
        }

        const st = moveGesture.startTransform;
        const cW = screenToWorld(c);
        const dcx = cW.x - moveGesture.startCenterW.x;
        const dcy = cW.y - moveGesture.startCenterW.y;

        const newDist = dist(pts[0], pts[1]);
        const newAngle = angle(pts[0], pts[1]);
        const s = (moveGesture.startDist > 0.0001) ? (newDist / moveGesture.startDist) : 1;
        const dr = newAngle - moveGesture.startAngle;

        layer.x = st.x + dcx;
        layer.y = st.y + dcy;
        layer.scale = clamp(st.scale * s, 0.05, 50);
        layer.rot = st.rot + dr;

        scheduleRender();
        return;
      }

      return;
    }

    // Brush tools
    if (!brushStroke.active || brushStroke.pointerId !== e.pointerId) return;

    const centerS = brushCenterFromDot(indicatorDot);
    const centerW = screenToWorld(centerS);
    applyBrushInterpolated(layer, brushStroke.lastCenter, centerW, tool);
    brushStroke.lastCenter = centerW;
    scheduleRender();
  }

  function onPointerUpOrCancel(e) {
    if (!pointers.has(e.pointerId)) return;
    e.preventDefault();

    pointers.delete(e.pointerId);

    const layer = getActiveLayer();

    if (tool === Tool.ZOOM) {
      if (!zoomGesture.active) return;

      if (pointers.size === 0) {
        zoomGesture.active = false;
        zoomGesture.mode = 'none';
        zoomGesture.startPointer = null;
        zoomGesture.startMid = null;
        zoomGesture.startWorldMid = null;
      } else {
        // keep active until all pointers released
      }

      scheduleRender();
      return;
    }

    if (tool === Tool.MOVE) {
      if (!moveGesture.active || !layer) return;

      // If gesture ends completely, record move action if changed
      if (pointers.size === 0) {
        const st = moveGesture.startTransform;
        const changed =
          Math.abs(layer.x - st.x) > 0.5 ||
          Math.abs(layer.y - st.y) > 0.5 ||
          Math.abs(layer.scale - st.scale) > 0.0005 ||
          Math.abs(layer.rot - st.rot) > 0.0005;

        if (changed) {
          pushHistory({
            type: 'move',
            layerId: layer.id,
            before: { ...st },
            after: { x: layer.x, y: layer.y, scale: layer.scale, rot: layer.rot }
          });
        }
        moveGesture.active = false;
        moveGesture.mode = 'none';
        moveGesture.startLayer = null;
        moveGesture.startTransform = null;
        moveGesture.startPointer = null;
        moveGesture.startCenter = null;
      } else {
        // Transition: from two to one pointer, restart baseline
        if (pointers.size === 1) {
          const pt = [...pointers.values()][0];
          moveGesture.mode = 'one';
          moveGesture.startTransform = { x: layer.x, y: layer.y, scale: layer.scale, rot: layer.rot };
          moveGesture.startPointer = { x: pt.x, y: pt.y };
          moveGesture.startPointerW = screenToWorld(pt);
        }
      }

      updateUndoRedoButtons();
      scheduleRender();
      return;
    }

    // Brush tools
    if (brushStroke.active && brushStroke.pointerId === e.pointerId && layer) {
      finalizeBrushStroke(layer);

      // Reset stroke state
      brushStroke.active = false;
      brushStroke.pointerId = null;
      brushStroke.lastCenter = null;
      brushStroke.bbox = null;
      brushStroke.beforePatch = null;
      brushStroke.bboxCaptured = null;

      updateUndoRedoButtons();
      scheduleRender();
      return;
    }
  }

  // ---------- UI event wiring ----------
  btnImport.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const files = [...(fileInput.files || [])];
    fileInput.value = '';
    await importFiles(files);
  });

  btnSave.addEventListener('click', exportPNG);

  btnTool.addEventListener('click', cycleTool);

  btnFlip.addEventListener('click', () => {
    const layer = getActiveLayer();
    if (!layer) return;

    const before = { flipX: layer.flipX || 1, flipY: layer.flipY || 1 };

    // Horizontal mirror (left-right)
    layer.flipX = (layer.flipX || 1) * -1;

    layer.thumbDirty = true;

    const after = { flipX: layer.flipX, flipY: layer.flipY || 1 };

    pushHistory({
      type: 'flip',
      layerId: layer.id,
      before,
      after
    });

    scheduleRender();
    renderLayersList();
  });

  btnLayers.addEventListener('click', openLayers);
  btnCloseLayers.addEventListener('click', closeLayers);
  layersBackdrop.addEventListener('click', closeLayers);

  // Crop modal handlers (used by import and export flows)
  cropBackdrop.addEventListener('click', () => {
    if (CropFlow.active) CropFlow.cancel();
  });
  btnCropCancel.addEventListener('click', () => {
    if (CropFlow.active) CropFlow.cancel();
  });
  btnCropOk.addEventListener('click', () => {
    if (CropFlow.active) CropFlow.confirm();
  });

  btnCurtainToggle.addEventListener('click', () => setCurtainCollapsed(!curtainCollapsed));

  btnUndo.addEventListener('click', doUndo);
  btnRedo.addEventListener('click', doRedo);

  sliderBrushSize.addEventListener('input', () => {
    brushSize = Number(sliderBrushSize.value);
    valBrushSize.textContent = String(brushSize);
    scheduleRender();
  });

  sliderHardness.addEventListener('input', () => {
    hardness = Number(sliderHardness.value) / 100;
    valHardness.textContent = `${Math.round(hardness * 100)}%`;
    scheduleRender();
  });

  sliderStrength.addEventListener('input', () => {
    strength = Number(sliderStrength.value) / 100;
    valStrength.textContent = `${Math.round(strength * 100)}%`;
    scheduleRender();
  });

  // Magic brush (works with Erase/Restore)
  if (toggleMagic && sliderMagicTol) {
    const syncMagicUI = () => {
      magicEnabled = !!toggleMagic.checked;
      magicTol = Number(sliderMagicTol.value);
      if (valMagicTol) valMagicTol.textContent = `${Math.round(magicTol)}%`;
      if (magicControls) magicControls.classList.toggle('hidden', !magicEnabled);
      scheduleRender();
    };

    toggleMagic.addEventListener('change', syncMagicUI);
    sliderMagicTol.addEventListener('input', () => {
      magicTol = Number(sliderMagicTol.value);
      if (valMagicTol) valMagicTol.textContent = `${Math.round(magicTol)}%`;
      scheduleRender();
    });

    // initial
    magicTol = Number(sliderMagicTol.value);
    if (valMagicTol) valMagicTol.textContent = `${Math.round(magicTol)}%`;
    if (magicControls) magicControls.classList.toggle('hidden', !toggleMagic.checked);
  }
scheduleRender();
  });

  let opacityDragStart = null;

  sliderOpacity.addEventListener('pointerdown', () => {
    const layer = getActiveLayer();
    if (!layer) return;
    opacityDragStart = { layerId: layer.id, value: layer.opacity };
  }, { passive: true });

  sliderOpacity.addEventListener('input', () => {
    const layer = getActiveLayer();
    if (!layer) return;
    const v = Number(sliderOpacity.value);
    layer.opacity = clamp(v / 100, 0, 1);
    valOpacity.textContent = `${Math.round(layer.opacity * 100)}%`;
    scheduleRender();
  });

  sliderOpacity.addEventListener('change', () => {
    const layer = getActiveLayer();
    if (!layer) return;

    const after = layer.opacity;
    let before = after;
    if (opacityDragStart && opacityDragStart.layerId === layer.id) before = opacityDragStart.value;

    if (Math.abs(after - before) > 0.0001) {
      pushHistory({
        type: 'opacity',
        layerId: layer.id,
        before,
        after
      });
    }
    opacityDragStart = null;
    updateUndoRedoButtons();
    renderLayersList();
  });


  toggleIndicator.addEventListener('change', () => {
    indicatorOn = toggleIndicator.checked;
    scheduleRender();
  });

  // Pointer events on canvas
  canvas.addEventListener('pointerdown', onPointerDown, { passive: false });
  canvas.addEventListener('pointermove', onPointerMove, { passive: false });
  canvas.addEventListener('pointerup', onPointerUpOrCancel, { passive: false });
  canvas.addEventListener('pointercancel', onPointerUpOrCancel, { passive: false });

// Prevent right-click menu on canvas (avoids accidental interruptions)
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  // Mouse wheel controls (PC):
  // - Move tool: wheel = scale active layer, Shift+wheel = rotate
  // - Zoom tool: wheel = zoom view around mouse pointer
  canvas.addEventListener('wheel', (e) => {
    if (tool !== Tool.MOVE && tool !== Tool.ZOOM) return;

    e.preventDefault();

    const pt = eventToCanvasPoint(e);
    const ptW = screenToWorld(pt);

    // Wheel direction: deltaY > 0 means "scroll down"
    const sign = (e.deltaY > 0) ? -1 : 1;

    // ~7% per notch
    const step = 1 + (0.07 * sign);

    if (tool === Tool.ZOOM) {
      const oldScale = camera.scale;
      const newScale = clampViewScale(oldScale * step);

      camera.scale = newScale;
      // keep ptW under cursor
      camera.tx = pt.x - ptW.x * newScale;
      camera.ty = pt.y - ptW.y * newScale;

      scheduleRender();
      return;
    }

    // Tool.MOVE
    const layer = getActiveLayer();
    if (!layer) return;

    if (e.shiftKey) {
      // ~2 degrees per notch
      layer.rot += (2 * Math.PI / 180) * sign;
      layer.thumbDirty = true;
      scheduleRender();
      recordWheelTransform(layer);
      return;
    }

    const next = clamp(layer.scale * step, 0.05, 50);
    layer.scale = next;
    layer.thumbDirty = true;
    scheduleRender();
    recordWheelTransform(layer);
  }, { passive: false });
  // Prevent accidental page gestures when touching canvas
  document.addEventListener('gesturestart', (e) => e.preventDefault(), { passive: false });
  document.addEventListener('gesturechange', (e) => e.preventDefault(), { passive: false });
  document.addEventListener('gestureend', (e) => e.preventDefault(), { passive: false });

  // ---------- PWA (optional) ----------
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js').catch(() => {});
    });
  }

  // ---------- Init ----------
  function init() {
    resizeCanvas();
    makeCheckerPattern();
    setTool(Tool.MOVE);
    setCurtainCollapsed(false);

    // set labels
    valBrushSize.textContent = String(brushSize);
    valHardness.textContent = `${Math.round(hardness * 100)}%`;
    valStrength.textContent = `${Math.round(strength * 100)}%`;
// start indicator position at center (helps user see it immediately in brush modes)
    indicatorDot = { x: viewW * 0.5, y: viewH * 0.62 };
    indicatorHasPos = true;

    updateUndoRedoButtons();
    renderLayersList();
    scheduleRender();
  }

  init();
})();
