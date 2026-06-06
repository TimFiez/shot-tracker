/* ════════════════════════════════════════════════════════
   Shot Tracker — app.js  (data model v2, save UX v2)

   DATA MODEL:
     sessions[]  — name, dist, notes, date, targets[]
     targets[]   — label, imgSrc, imgW/H, pxPerInch, poa, shots[]

   SAVE BUTTON STATES:
     'clean'   — saved, no changes     → quiet green outline
     'dirty'   — unsaved changes exist → amber + pulse
     'saving'  — just saved            → solid green (2 s flash) → clean

   KEY INVARIANT:
     calMode is ALWAYS checked first in handleDown() in an isolated
     branch that always returns. setMode() is never called from within
     the cal branch until AFTER calMode=false is set.
════════════════════════════════════════════════════════ */

/* ── Canvas state ── */
var calMode = false, calPoints = [], pxPerInch = null;
var mode = 'poa';
var currentImg = null, imgNaturalW = 0, imgNaturalH = 0;
var poa = null, shots = [];
var dragTarget = null, selectedTarget = null, isDragging = false;
var HIT_R = 20;

/* ── App state ── */
var sessions = [];
var activeSessionIdx = -1;
var activeTargetIdx  = -1;

/* ── Save button state ── */
/* 'none' = no target loaded, 'dirty' = unsaved, 'clean' = saved */
var saveState = 'none';
var _saveFlashTimer = null;

/* ── Canvas elements ── */
var dCv  = document.getElementById('dCanvas');
var dCx  = dCv.getContext('2d');
var mCv  = document.getElementById('mCanvas');
var mCx  = mCv.getContext('2d');
var compCv = document.getElementById('compCanvas');
var compCx = compCv.getContext('2d');

/* ── Settings ── */
var settings = { storageMode: 'local', calDefault: 1 };
function loadSettings() {
  try { var s = localStorage.getItem('st_settings'); if (s) settings = Object.assign(settings, JSON.parse(s)); } catch(e) {}
}
function saveSettings() {
  try { localStorage.setItem('st_settings', JSON.stringify(settings)); } catch(e) {}
}
loadSettings();

/* ── IndexedDB ── */
var DB_NAME = 'shot-tracker', DB_VER = 2, db = null;
function openDB() {
  return new Promise(function(resolve) {
    try {
      var req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = function(e) {
        var d = e.target.result;
        if (d.objectStoreNames.contains('sessions')) d.deleteObjectStore('sessions');
        d.createObjectStore('sessions', { keyPath: 'id', autoIncrement: true });
      };
      req.onsuccess = function(e) { db = e.target.result; resolve(true); };
      req.onerror = function() { resolve(false); };
    } catch(e) { resolve(false); }
  });
}
function dbSave() {
  if (!db) return;
  var tx = db.transaction('sessions', 'readwrite');
  var store = tx.objectStore('sessions');
  store.clear();
  sessions.forEach(function(s, i) { store.add(Object.assign({}, s, { id: i + 1 })); });
}
function dbLoad() {
  return new Promise(function(resolve) {
    if (!db) { resolve([]); return; }
    var tx = db.transaction('sessions', 'readonly');
    var req = tx.objectStore('sessions').getAll();
    req.onsuccess = function(e) { resolve(e.target.result || []); };
    req.onerror = function() { resolve([]); };
  });
}

/* ── Toast ── */
var _tt = null;
function toast(msg) {
  var t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  if (_tt) clearTimeout(_tt);
  _tt = setTimeout(function() { t.classList.remove('show'); }, 2600);
}

/* ── Helpers ── */
function isMobile() { return window.innerWidth <= 640; }
function fmt(v, d) { d = d == null ? 3 : d; return v == null ? '—' : parseFloat(v).toFixed(d); }
function getRefDistVal() {
  var el = document.getElementById(isMobile() ? 'mRefDist' : 'dRefDist');
  return el ? parseFloat(el.value) || 1 : 1;
}
function genId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

/* ── Data constructors ── */
function newSession(name, dist, notes) {
  return { id: genId(), name: name || 'New session', dist: dist || 100, notes: notes || '', createdAt: new Date().toISOString(), targets: [] };
}
function newTarget(label, imgSrc, imgW, imgH) {
  return { id: genId(), label: label || 'Target 1', imgSrc: imgSrc, imgW: imgW, imgH: imgH, pxPerInch: null, poa: null, shots: [], savedAt: new Date().toISOString() };
}

/* ════════════════════════════════════════
   SAVE BUTTON STATE MACHINE
   markDirty()  — call whenever canvas changes (shot added, poa moved, cal done)
   markClean()  — call after a successful save
   markNone()   — call when canvas is cleared (no target loaded)
════════════════════════════════════════ */
function markDirty() {
  if (_saveFlashTimer) { clearTimeout(_saveFlashTimer); _saveFlashTimer = null; }
  saveState = 'dirty';
  applySaveButtonStyle();
}
function markClean() {
  saveState = 'saving'; /* flash green solid */
  applySaveButtonStyle();
  if (_saveFlashTimer) clearTimeout(_saveFlashTimer);
  _saveFlashTimer = setTimeout(function() {
    saveState = 'clean';
    applySaveButtonStyle();
    _saveFlashTimer = null;
  }, 2000);
}
function markNone() {
  if (_saveFlashTimer) { clearTimeout(_saveFlashTimer); _saveFlashTimer = null; }
  saveState = 'none';
  applySaveButtonStyle();
}

function applySaveButtonStyle() {
  /* Applies to both the step-bar save step (rendered dynamically) and
     the sidebar "Save target" button (id=dSaveTargetBtn / mSaveTargetBtn) */
  updateStepBar(); /* re-renders step bar including save step style */
  updateSidebarSaveBtn();
}

function updateSidebarSaveBtn() {
  ['dSaveTargetBtn','mSaveTargetBtn'].forEach(function(id) {
    var el = document.getElementById(id); if (!el) return;
    el.className = 'btn ' + saveBtnClass();
    el.style.animation = saveState === 'dirty' ? 'savePulse 2s ease-in-out infinite' : '';
  });
}

function saveBtnClass() {
  if (saveState === 'dirty')  return 'btn-save-dirty';
  if (saveState === 'saving') return 'btn-save-saving';
  if (saveState === 'clean')  return 'btn-save-clean';
  return 'btn-save-none'; /* no target loaded */
}

/* Step bar save step gets its own color treatment based on saveState */
function saveBtnStepState() {
  if (saveState === 'dirty')  return 'dirty';
  if (saveState === 'saving' || saveState === 'clean') return 'done';
  return 'pending';
}

/* ── Canvas geometry ── */
function getScale(cv) { return imgNaturalW > 0 ? cv.width / imgNaturalW : 1; }
function sizeCanvas(cv, wrap) {
  var ww = wrap.clientWidth - 2, wh = wrap.clientHeight - 2;
  if (ww <= 0 || wh <= 0) return;
  var asp = imgNaturalW / imgNaturalH, cw = ww, ch = ww / asp;
  if (ch > wh) { ch = wh; cw = wh * asp; }
  cv.width = Math.floor(cw); cv.height = Math.floor(ch);
}
function getPt(cv, cx, cy) {
  var r = cv.getBoundingClientRect(), sc = getScale(cv);
  return { nx: ((cx - r.left) * (cv.width / r.width)) / sc,
           ny: ((cy - r.top)  * (cv.height / r.height)) / sc };
}

/* ── Drawing ── */
function renderBoth() { renderOn(dCv, dCx); renderOn(mCv, mCx); }
function renderOn(cv, cx) {
  if (!currentImg) return;
  var sc = getScale(cv);
  cx.clearRect(0, 0, cv.width, cv.height);
  cx.drawImage(currentImg, 0, 0, cv.width, cv.height);
  calPoints.forEach(function(p, i) { drawCalPt(cx, p.nx * sc, p.ny * sc, String(i + 1)); });
  if (calPoints.length === 2) {
    cx.save(); cx.strokeStyle = '#f59e0b'; cx.lineWidth = 1.5; cx.setLineDash([5, 3]);
    cx.beginPath(); cx.moveTo(calPoints[0].nx * sc, calPoints[0].ny * sc);
    cx.lineTo(calPoints[1].nx * sc, calPoints[1].ny * sc); cx.stroke();
    cx.setLineDash([]); cx.restore();
  }
  var st = computeStats(shots, poa, pxPerInch, imgNaturalW);
  if (st && shots.length >= 2 && pxPerInch)
    drawR95(cx, (poa.nx + st.centroidX_px) * sc, (poa.ny + st.centroidY_px) * sc, st.r95 * pxPerInch * sc, st.r95);
  if (poa) drawPOA(cx, poa.nx * sc, poa.ny * sc, selectedTarget && selectedTarget.type === 'poa');
  if (st && shots.length >= 2)
    drawCentroid(cx, (poa.nx + st.centroidX_px) * sc, (poa.ny + st.centroidY_px) * sc);
  shots.forEach(function(s, i) {
    drawShot(cx, s.nx * sc, s.ny * sc, i + 1, '#3b82f6',
             selectedTarget && selectedTarget.type === 'shot' && selectedTarget.idx === i);
  });
}
function drawCalPt(c, x, y, l) {
  c.save(); c.strokeStyle = '#f59e0b'; c.fillStyle = '#f59e0b'; c.lineWidth = 2;
  c.beginPath(); c.arc(x, y, 8, 0, Math.PI * 2); c.stroke();
  c.font = 'bold 11px sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(l, x, y); c.restore();
}
function drawPOA(c, x, y, sel) {
  var r = 10; c.save(); c.strokeStyle = sel ? '#f97316' : '#22c55e'; c.lineWidth = sel ? 2.5 : 2;
  if (sel) { c.shadowColor = '#f97316'; c.shadowBlur = 6; }
  c.beginPath(); c.moveTo(x - r, y); c.lineTo(x + r, y); c.stroke();
  c.beginPath(); c.moveTo(x, y - r); c.lineTo(x, y + r); c.stroke();
  c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.stroke(); c.restore();
}
function drawCentroid(c, x, y) {
  c.save(); c.strokeStyle = '#f97316'; c.fillStyle = 'rgba(249,115,22,0.15)'; c.lineWidth = 1.5;
  c.beginPath(); c.arc(x, y, 5, 0, Math.PI * 2); c.fill(); c.stroke();
  c.strokeStyle = '#f97316'; c.lineWidth = 1;
  c.beginPath(); c.moveTo(x - 8, y); c.lineTo(x + 8, y); c.stroke();
  c.beginPath(); c.moveTo(x, y - 8); c.lineTo(x, y + 8); c.stroke(); c.restore();
}
function drawShot(c, x, y, n, col, sel, r) {
  r = r || 7; c.save();
  if (sel) { c.shadowColor = '#f97316'; c.shadowBlur = 8; }
  c.fillStyle = sel ? '#f97316' : col; c.globalAlpha = 0.82;
  c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill();
  c.globalAlpha = 1; c.strokeStyle = sel ? '#f97316' : '#fff'; c.lineWidth = sel ? 2 : 1.5;
  c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.stroke();
  c.fillStyle = '#fff'; c.font = 'bold ' + (r < 6 ? 8 : 10) + 'px sans-serif';
  c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(n, x, y); c.restore();
}
function drawR95(c, cx, cy, rPx, rIn) {
  if (rPx < 2) return;
  c.save();
  c.beginPath(); c.arc(cx, cy, rPx, 0, Math.PI * 2); c.fillStyle = 'rgba(239,68,68,0.06)'; c.fill();
  c.beginPath(); c.arc(cx, cy, rPx, 0, Math.PI * 2);
  c.strokeStyle = 'rgba(239,68,68,0.75)'; c.lineWidth = 1.5; c.setLineDash([6, 4]); c.stroke(); c.setLineDash([]);
  if (rPx > 22) {
    c.font = 'bold 11px sans-serif'; c.textAlign = 'center'; c.textBaseline = 'bottom';
    c.fillStyle = 'rgba(239,68,68,0.9)'; c.fillText('R95 ' + rIn.toFixed(3) + '"', cx, cy - rPx - 3);
  }
  c.restore();
}

/* ── Hit test ── */
function hitTest(nx, ny, cv) {
  var hr = HIT_R / getScale(cv);
  for (var i = shots.length - 1; i >= 0; i--) {
    var dx = shots[i].nx - nx, dy = shots[i].ny - ny;
    if (Math.sqrt(dx * dx + dy * dy) < hr) return { type: 'shot', idx: i };
  }
  if (poa) { var dx2 = poa.nx - nx, dy2 = poa.ny - ny; if (Math.sqrt(dx2 * dx2 + dy2 * dy2) < hr) return { type: 'poa' }; }
  return null;
}

/* ════════════════════════════════════════
   CANVAS EVENT HANDLER
   calMode always checked first, always returns.
════════════════════════════════════════ */
function handleDown(cv, clientX, clientY) {
  if (!currentImg) return;
  var pt = getPt(cv, clientX, clientY);

  /* CALIBRATION — isolated, always returns */
  if (calMode) {
    calPoints.push({ nx: pt.nx, ny: pt.ny });
    updateCalProgress();
    renderBoth();
    if (calPoints.length === 2) {
      var refIn = getRefDistVal();
      var dx = calPoints[1].nx - calPoints[0].nx, dy = calPoints[1].ny - calPoints[0].ny;
      pxPerInch = Math.sqrt(dx * dx + dy * dy) / refIn;
      calMode = false;
      hideCalBar(); updateCalPill(); renderBoth(); updateStepBar(); updateBanner();
      markDirty(); /* calibration is a change */
      toast('Calibrated: ' + pxPerInch.toFixed(1) + ' px/in — now click your POA');
      setMode('poa');
    }
    return;
  }

  /* EDIT */
  if (mode === 'edit') {
    var hit = hitTest(pt.nx, pt.ny, cv);
    if (hit) { dragTarget = hit; selectedTarget = hit; isDragging = false; showDelSel(true); }
    else { selectedTarget = null; dragTarget = null; showDelSel(false); }
    renderBoth(); return;
  }

  /* POA */
  if (mode === 'poa') {
    poa = { nx: pt.nx, ny: pt.ny };
    updatePOAPill(); renderBoth(); updateStats(); updateStepBar(); updateBanner();
    markDirty();
    setMode('shot'); return;
  }

  /* SHOT */
  if (mode === 'shot') {
    if (!poa) { toast('Set POA first'); return; }
    shots.push({ nx: pt.nx, ny: pt.ny });
    updateShotPill(); renderBoth(); updateStats(); updateStepBar(); updateBanner();
    markDirty();
    return;
  }
}

function handleMove(cv, clientX, clientY) {
  if (!currentImg || mode !== 'edit' || !dragTarget) return;
  isDragging = true;
  var pt = getPt(cv, clientX, clientY);
  if (dragTarget.type === 'poa') poa = { nx: pt.nx, ny: pt.ny };
  else shots[dragTarget.idx] = { nx: pt.nx, ny: pt.ny };
  renderBoth(); updateStats();
}
function handleUp() {
  if (isDragging) { toast('Marker moved'); isDragging = false; markDirty(); }
  dragTarget = null;
}

function wireCanvas(cv) {
  cv.addEventListener('mousedown', function(e) { handleDown(cv, e.clientX, e.clientY); });
  cv.addEventListener('mousemove', function(e) {
    if (!currentImg) return;
    if (calMode) { cv.style.cursor = 'crosshair'; return; }
    if (mode === 'edit') {
      if (dragTarget) { handleMove(cv, e.clientX, e.clientY); cv.style.cursor = 'grabbing'; }
      else { var p = getPt(cv, e.clientX, e.clientY); cv.style.cursor = hitTest(p.nx, p.ny, cv) ? 'grab' : 'default'; }
    } else cv.style.cursor = 'crosshair';
  });
  cv.addEventListener('mouseup', handleUp);
  cv.addEventListener('mouseleave', function() { if (!isDragging) dragTarget = null; isDragging = false; });
  cv.addEventListener('touchstart', function(e) { e.preventDefault(); var t = e.touches[0]; handleDown(cv, t.clientX, t.clientY); }, { passive: false });
  cv.addEventListener('touchmove',  function(e) { e.preventDefault(); var t = e.touches[0]; handleMove(cv, t.clientX, t.clientY); }, { passive: false });
  cv.addEventListener('touchend', handleUp);
}
wireCanvas(dCv); wireCanvas(mCv);

/* ── Calibration UI ── */
function startCal() {
  if (!currentImg) { toast('Load a target image first'); return; }
  calMode = true; calPoints = [];
  var el = document.getElementById(isMobile() ? 'mRefDist' : 'dRefDist');
  if (el) el.value = settings.calDefault;
  showCalBar(); updateCalProgress(); updateStepBar(); updateBanner(); renderBoth();
}
function cancelCal() { calMode = false; calPoints = []; hideCalBar(); updateStepBar(); updateBanner(); renderBoth(); }
function showCalBar() { document.getElementById('dCalBar').style.display = 'flex'; document.getElementById('mCalBar').style.display = 'flex'; }
function hideCalBar() { document.getElementById('dCalBar').style.display = 'none'; document.getElementById('mCalBar').style.display = 'none'; }
function updateCalProgress() {
  var msg = ['Click point 1 of 2', 'Click point 2 of 2', 'Done'][calPoints.length] || '';
  document.getElementById('dCalProg').textContent = msg;
  document.getElementById('mCalProg').textContent = msg;
}
function updateCalPill() {
  document.getElementById('dCalPill').textContent = pxPerInch ? ('Cal: ' + pxPerInch.toFixed(1) + ' px/in') : 'Cal: none';
  document.getElementById('mCalPill').textContent = pxPerInch ? 'Cal ✓' : 'Cal';
}
function updatePOAPill() {
  document.getElementById('dPoaPill').textContent = poa ? 'POA: set ✓' : 'POA: not set';
  document.getElementById('mPoaPill').textContent = poa ? 'POA ✓' : 'POA';
}
function updateShotPill() {
  document.getElementById('dShotPill').textContent = 'Shots: ' + shots.length;
  document.getElementById('mShotPill').textContent = shots.length;
}
function showDelSel(show) {
  document.getElementById('dDelSel').style.display = show ? 'flex' : 'none';
  document.getElementById('mDelSel').style.display = show ? 'flex' : 'none';
}

/* ── Target label field ── */
function updateTargetLabelInput(val) {
  ['dTargetLabel','mTargetLabel'].forEach(function(id) {
    var el = document.getElementById(id); if (el) el.value = val != null ? val : '';
  });
}
function getTargetLabel() {
  /* Always read from the input — it is the source of truth */
  var el = document.getElementById('dTargetLabel');
  return (el && el.value.trim()) ? el.value.trim() : '';
}

/* ── Mode ── */
function setMode(m) {
  mode = m;
  if (m !== 'edit') { selectedTarget = null; dragTarget = null; showDelSel(false); renderBoth(); }
  function st(id, active) {
    var el = document.getElementById(id); if (!el) return;
    el.style.background  = active ? 'var(--bg-info)' : '';
    el.style.borderColor = active ? 'var(--border-info)' : '';
    el.style.color       = active ? 'var(--text-info)' : '';
    el.style.fontWeight  = active ? '500' : '';
  }
  ['d','m'].forEach(function(p) { st(p + 'ModePOA', m === 'poa'); st(p + 'ModeShot', m === 'shot'); st(p + 'ModeEdit', m === 'edit'); });
  updateBanner(); updateStepBar();
}

/* ── Step bar ── */
function updateStepBar() { renderStepBar('dStepBar'); renderStepBar('mStepBar'); }
function renderStepBar(elId) {
  var el = document.getElementById(elId); if (!el) return;
  var calDone = !!pxPerInch, poaDone = !!poa, shotsDone = shots.length > 0;
  var ss = saveBtnStepState(); /* 'dirty' | 'done' | 'pending' */

  function mk(icon, label, state, fn, extraClass) {
    var cls = 'step';
    if (state === 'active') cls += ' active';
    else if (state === 'done') cls += ' done';
    else if (state === 'dirty') cls += ' dirty';
    if (fn) cls += ' clickable';
    if (extraClass) cls += ' ' + extraClass;
    var d = document.createElement('div');
    d.className = cls;
    d.innerHTML = '<i class="ti ti-' + icon + '"></i><span>' + label + '</span>';
    if (fn) d.addEventListener('click', fn);
    return d;
  }
  function arr() { var s = document.createElement('span'); s.className = 'step-arr'; s.textContent = '›'; return s; }

  el.innerHTML = '';
  el.appendChild(mk('ruler',        'Calibrate', calDone ? 'done' : (calMode ? 'active' : 'pending'),
    function() { if (!calMode) startCal(); }));
  el.appendChild(arr());
  el.appendChild(mk('crosshair',    'Set POA', poaDone ? 'done' : (!calMode && pxPerInch && mode === 'poa' ? 'active' : 'pending'),
    function() { if (pxPerInch && !calMode) setMode('poa'); }));
  el.appendChild(arr());
  el.appendChild(mk('circle-dot',   'Add shots', shotsDone ? 'done' : (!calMode && poa && mode === 'shot' ? 'active' : 'pending'),
    function() { if (poa && !calMode) setMode('shot'); }));
  el.appendChild(arr());
  el.appendChild(mk('device-floppy','Save target', ss,
    function() { if (shots.length > 0) saveCurrentTarget(); }));
}

/* ── Banner ── */
function updateBanner() {
  var msg = '', cls = 'banner-neutral';
  if (!currentImg) {
    var sess = activeSessionIdx >= 0 ? sessions[activeSessionIdx] : null;
    if (sess) { cls = 'banner-info'; msg = '<i class="ti ti-photo-up"></i> Load a target image to add to this session, or save backup when done'; }
  } else if (calMode) {
    cls = 'banner-warn'; msg = '<i class="ti ti-ruler"></i> Click point ' + (calPoints.length + 1) + ' of 2 on two corners of a 1" grid square';
  } else if (!pxPerInch) {
    cls = 'banner-warn'; msg = '<i class="ti ti-ruler"></i> Calibrate first — click "Calibrate" in the step bar above';
  } else if (mode === 'poa' && !poa) {
    cls = 'banner-warn'; msg = '<i class="ti ti-crosshair"></i> Click your point of aim (POA) on the target';
  } else if (mode === 'shot') {
    cls = 'banner-info'; msg = '<i class="ti ti-circle-dot"></i> Click each bullet hole — orange = centroid, red dashed = R95';
  } else if (mode === 'edit') {
    cls = 'banner-neutral'; msg = '<i class="ti ti-arrows-move"></i> Click a marker to select, drag to reposition';
  } else if (poa && shots.length > 0 && saveState === 'dirty') {
    cls = 'banner-warn'; msg = '<i class="ti ti-device-floppy"></i> Unsaved changes — hit Save target when ready';
  } else if (poa && shots.length > 0) {
    cls = 'banner-success'; msg = '<i class="ti ti-check"></i> ' + shots.length + ' shot' + (shots.length > 1 ? 's' : '') + ' marked — load another image or save backup when done';
  }
  ['dBanner','mBanner'].forEach(function(id) {
    var el = document.getElementById(id); if (!el) return;
    if (!msg) { el.style.display = 'none'; return; }
    el.style.display = 'flex'; el.className = 'banner ' + cls; el.innerHTML = msg;
  });
}

/* ── Stats ── */
function computeStats(shotsArr, poaRef, ppi, imgW) {
  if (!poaRef || !shotsArr || shotsArr.length === 0) return null;
  var p = ppi || (imgW / 36) || (imgNaturalW / 36);
  var offs = shotsArr.map(function(s) { return { x: (s.nx - poaRef.nx) / p, y: -(s.ny - poaRef.ny) / p }; });
  var cX = offs.reduce(function(a, o) { return a + o.x; }, 0) / offs.length;
  var cY = offs.reduce(function(a, o) { return a + o.y; }, 0) / offs.length;
  var fromC = offs.map(function(o) { return Math.sqrt(Math.pow(o.x - cX, 2) + Math.pow(o.y - cY, 2)); });
  var mr = fromC.reduce(function(a, r) { return a + r; }, 0) / fromC.length;
  var r95 = mr * 2.1, es = 0;
  for (var i = 0; i < offs.length; i++) for (var j = i + 1; j < offs.length; j++) {
    var d = Math.sqrt(Math.pow(offs[i].x - offs[j].x, 2) + Math.pow(offs[i].y - offs[j].y, 2));
    if (d > es) es = d;
  }
  return { n: shotsArr.length, centroidX: cX, centroidY: cY, centroidX_px: cX * p, centroidY_px: -cY * p, meanR: mr, r95: r95, es: es, offsets: offs };
}
function updateStats() {
  var st = computeStats(shots, poa, pxPerInch, imgNaturalW);
  var u = pxPerInch ? 'in' : '~in';
  function sv(id, v) { var e = document.getElementById(id); if (e && e.childNodes[0]) e.childNodes[0].nodeValue = v; }
  function su(id, v) { var e = document.getElementById(id); if (e) e.textContent = v; }
  if (!st) { ['dsN','dsH','dsV','dsMR','dsR95','dsES','msN','msH','msV','msMR','msR95','msES'].forEach(function(id) { sv(id, '—'); }); return; }
  ['d','m'].forEach(function(p) {
    sv(p + 'sN', st.n); sv(p + 'sH', fmt(st.centroidX)); su(p + 'sHu', u);
    sv(p + 'sV', fmt(st.centroidY)); su(p + 'sVu', u);
    sv(p + 'sMR', fmt(st.meanR)); su(p + 'sMRu', u);
    sv(p + 'sR95', fmt(st.r95)); su(p + 'sR95u', u);
    sv(p + 'sES', fmt(st.es)); su(p + 'sESu', u);
  });
}

/* ── Image load ── */
function loadImageFile(file) {
  if (!file) return;
  if (activeSessionIdx < 0) { toast('Create or open a session first'); return; }
  var reader = new FileReader();
  reader.onload = function(ev) {
    var imgSrc = ev.target.result;
    var img = new Image();
    img.onload = function() {
      currentImg = img; imgNaturalW = img.naturalWidth; imgNaturalH = img.naturalHeight;
      poa = null; shots = []; pxPerInch = null; calMode = false; calPoints = [];
      selectedTarget = null; dragTarget = null; activeTargetIdx = -1;
      window._pendingImgSrc = imgSrc;
      /* FIX: derive label from filename and keep it as the canonical label */
      var fileLabel = file.name.replace(/\.[^.]+$/, '');
      window._currentTargetLabel = fileLabel; /* single source of truth */
      hideCalBar(); updatePOAPill(); updateShotPill(); updateCalPill(); showDelSel(false);
      ['dPlaceholder','mPlaceholder'].forEach(function(id) { var e = document.getElementById(id); if (e) e.style.display = 'none'; });
      dCv.style.display = 'block'; mCv.style.display = 'block';
      sizeCanvas(dCv, document.getElementById('dCanvasWrap'));
      sizeCanvas(mCv, document.getElementById('mCanvasWrap'));
      renderBoth(); updateStats();
      updateTargetLabelInput(fileLabel);
      markDirty(); /* new image loaded — needs saving */
      startCal();
      renderSidebars();
    };
    img.src = imgSrc;
  };
  reader.readAsDataURL(file);
}

/* ── Undo / delete selected ── */
function undoLast() {
  if (calMode && calPoints.length > 0) { calPoints.pop(); updateCalProgress(); renderBoth(); updateBanner(); return; }
  if (mode === 'edit') { toast('Drag to reposition, or use "Delete selected"'); return; }
  if (shots.length > 0) { shots.pop(); updateShotPill(); markDirty(); }
  else if (poa) { poa = null; updatePOAPill(); setMode('poa'); markDirty(); }
  renderBoth(); updateStats(); updateStepBar(); updateBanner();
}
function deleteSelected() {
  if (!selectedTarget) return;
  if (selectedTarget.type === 'poa') { poa = null; updatePOAPill(); toast('POA removed'); }
  else { shots.splice(selectedTarget.idx, 1); updateShotPill(); toast('Shot removed'); }
  selectedTarget = null; dragTarget = null; showDelSel(false);
  markDirty(); renderBoth(); updateStats(); updateStepBar(); updateBanner();
}

/* ════════════════════════════════════════
   SESSION & TARGET MANAGEMENT
════════════════════════════════════════ */
function saveCurrentTarget() {
  if (activeSessionIdx < 0) { toast('Create or open a session first'); return; }
  if (!currentImg)          { toast('Load a target image first'); return; }
  if (!poa)                 { toast('Set POA first'); return; }
  if (shots.length === 0)   { toast('Add at least one shot'); return; }

  var sess = sessions[activeSessionIdx];

  /* FIX: read label from input — that is always correct and up to date */
  var label = getTargetLabel();
  if (!label) {
    /* fallback: use window._currentTargetLabel, then numbered fallback */
    label = window._currentTargetLabel || ('Target ' + (sess.targets.length + 1));
  }

  var imgSrc = window._pendingImgSrc || currentImg.src;
  var tgt = newTarget(label, imgSrc, imgNaturalW, imgNaturalH);
  tgt.pxPerInch = pxPerInch;
  tgt.poa = { nx: poa.nx, ny: poa.ny };
  tgt.shots = shots.map(function(s) { return { nx: s.nx, ny: s.ny }; });
  tgt.calibrated = !!pxPerInch;

  if (activeTargetIdx >= 0 && activeTargetIdx < sess.targets.length) {
    tgt.id = sess.targets[activeTargetIdx].id;
    sess.targets[activeTargetIdx] = tgt;
    toast('Target "' + label + '" updated');
  } else {
    sess.targets.push(tgt);
    activeTargetIdx = sess.targets.length - 1;
    toast('Target "' + label + '" saved');
  }

  /* Keep label input and internal label in sync */
  window._currentTargetLabel = label;
  updateTargetLabelInput(label);

  sess.updatedAt = new Date().toISOString();
  dbSave(); markClean(); renderSidebars(); updateBanner();
}

function loadTarget(sessIdx, tgtIdx) {
  var sess = sessions[sessIdx];
  if (!sess || !sess.targets[tgtIdx]) return;
  var tgt = sess.targets[tgtIdx];
  var img = new Image();
  img.onload = function() {
    currentImg = img; imgNaturalW = tgt.imgW; imgNaturalH = tgt.imgH;
    poa = tgt.poa ? { nx: tgt.poa.nx, ny: tgt.poa.ny } : null;
    shots = tgt.shots.map(function(s) { return { nx: s.nx, ny: s.ny }; });
    pxPerInch = tgt.pxPerInch || null;
    calMode = false; calPoints = []; selectedTarget = null; dragTarget = null;
    window._pendingImgSrc = tgt.imgSrc;
    window._currentTargetLabel = tgt.label; /* FIX: always set from saved label */
    activeSessionIdx = sessIdx; activeTargetIdx = tgtIdx;
    hideCalBar(); updatePOAPill(); updateShotPill(); updateCalPill(); showDelSel(false);
    ['dPlaceholder','mPlaceholder'].forEach(function(id) { var e = document.getElementById(id); if (e) e.style.display = 'none'; });
    dCv.style.display = 'block'; mCv.style.display = 'block';
    sizeCanvas(dCv, document.getElementById('dCanvasWrap'));
    sizeCanvas(mCv, document.getElementById('mCanvasWrap'));
    /* FIX: label input always reflects the active target's saved label */
    updateTargetLabelInput(tgt.label);
    markClean(); /* loaded from saved state — clean */
    renderBoth(); updateStats(); updateStepBar(); updateBanner(); setMode('shot');
    renderSidebars(); closeMobileDrawer();
  };
  img.src = tgt.imgSrc;
}

function createNewSession() {
  var name = prompt('Session name (e.g. H4350 41.5gr):', 'New session');
  if (name === null) return;
  var dist = prompt('Distance (yards):', '100');
  if (dist === null) return;
  var notes = prompt('Notes / load details (optional):', '');
  if (notes === null) notes = '';
  var sess = newSession(name.trim() || 'New session', parseFloat(dist) || 100, notes.trim());
  sessions.push(sess);
  activeSessionIdx = sessions.length - 1;
  activeTargetIdx = -1;
  clearCanvas();
  dbSave(); renderSidebars(); updateBanner(); updateStepBar();
  toast('Session "' + sess.name + '" created — load a target image to begin');
}

function openSession(i) {
  activeSessionIdx = i; activeTargetIdx = -1;
  clearCanvas();
  renderSidebars(); updateBanner(); updateStepBar(); closeMobileDrawer();
  var sess = sessions[i];
  toast('Session "' + sess.name + '" — ' + sess.targets.length + ' target' + (sess.targets.length !== 1 ? 's' : ''));
}

function editSession(i) {
  var sess = sessions[i];
  var name = prompt('Session name:', sess.name); if (name === null) return;
  var dist = prompt('Distance (yards):', sess.dist); if (dist === null) return;
  var notes = prompt('Notes / load details:', sess.notes || ''); if (notes === null) return;
  sess.name = name.trim() || sess.name;
  sess.dist = parseFloat(dist) || sess.dist;
  sess.notes = notes.trim();
  dbSave(); renderSidebars(); toast('Session updated');
}

function deleteSession(i) {
  sessions.splice(i, 1);
  if (activeSessionIdx === i) { activeSessionIdx = -1; activeTargetIdx = -1; clearCanvas(); }
  else if (activeSessionIdx > i) activeSessionIdx--;
  dbSave(); renderSidebars(); toast('Session deleted');
}

function deleteTarget(sessIdx, tgtIdx) {
  var sess = sessions[sessIdx];
  sess.targets.splice(tgtIdx, 1);
  if (activeSessionIdx === sessIdx && activeTargetIdx === tgtIdx) {
    activeTargetIdx = -1; clearCanvas();
  } else if (activeSessionIdx === sessIdx && activeTargetIdx > tgtIdx) {
    activeTargetIdx--;
  }
  dbSave(); renderSidebars(); toast('Target deleted');
}

function clearCanvas() {
  currentImg = null; poa = null; shots = []; pxPerInch = null; calMode = false; calPoints = [];
  selectedTarget = null; dragTarget = null;
  window._pendingImgSrc = null; window._currentTargetLabel = null;
  hideCalBar(); updatePOAPill(); updateShotPill(); updateCalPill(); showDelSel(false);
  dCv.style.display = 'none'; mCv.style.display = 'none';
  ['dPlaceholder','mPlaceholder'].forEach(function(id) { var e = document.getElementById(id); if (e) e.style.display = ''; });
  updateStats(); updateTargetLabelInput(''); markNone();
}

/* ── Composite view ── */
function renderComposite() {
  var targets = [];
  if (activeSessionIdx >= 0) {
    targets = sessions[activeSessionIdx].targets;
    document.getElementById('dCompSess').textContent = 'Session: ' + sessions[activeSessionIdx].name;
  } else {
    sessions.forEach(function(s) { s.targets.forEach(function(t) { targets.push(t); }); });
    document.getElementById('dCompSess').textContent = 'All sessions';
  }
  targets = targets.filter(function(t) { return t.shots.length > 0 && t.poa; });
  document.getElementById('dCompShots').textContent = targets.length + ' target' + (targets.length !== 1 ? 's' : '');

  if (targets.length === 0) {
    document.getElementById('dCompPlaceholder').style.display = ''; compCv.style.display = 'none';
    ['dcN','dcH','dcV','dcMR','dcR95','dcES'].forEach(function(id) { var e = document.getElementById(id); if (e && e.childNodes[0]) e.childNodes[0].nodeValue = '—'; }); return;
  }
  document.getElementById('dCompPlaceholder').style.display = 'none'; compCv.style.display = 'block';
  var SIZE = 480; compCv.width = SIZE; compCv.height = SIZE;
  compCx.fillStyle = '#f9f9f7'; compCx.fillRect(0, 0, SIZE, SIZE);
  compCx.strokeStyle = '#e0e0da'; compCx.lineWidth = 0.5;
  [40,80,120,160,200].forEach(function(r) { compCx.beginPath(); compCx.arc(SIZE/2,SIZE/2,r,0,Math.PI*2); compCx.stroke(); });
  compCx.strokeStyle = '#d0d0c8';
  compCx.beginPath(); compCx.moveTo(SIZE/2,10); compCx.lineTo(SIZE/2,SIZE-10); compCx.stroke();
  compCx.beginPath(); compCx.moveTo(10,SIZE/2); compCx.lineTo(SIZE-10,SIZE/2); compCx.stroke();

  var allOff = [], maxAbs = 0;
  targets.forEach(function(t) {
    var ppi = t.pxPerInch || (t.imgW / 36);
    t.shots.forEach(function(sh) {
      var x = (sh.nx - t.poa.nx) / ppi, y = -(sh.ny - t.poa.ny) / ppi;
      maxAbs = Math.max(maxAbs, Math.abs(x), Math.abs(y));
      allOff.push({ x: x, y: y, ti: targets.indexOf(t) });
    });
  });
  if (maxAbs === 0) maxAbs = 1;
  var scale = (SIZE/2 - 32) / maxAbs;
  var colors = ['#3b82f6','#ef4444','#22c55e','#f59e0b','#8b5cf6','#ec4899','#06b6d4','#84cc16'];
  var counters = {};
  allOff.forEach(function(o) {
    counters[o.ti] = (counters[o.ti] || 0) + 1;
    var px = SIZE/2 + o.x * scale, py = SIZE/2 - o.y * scale, col = colors[o.ti % colors.length];
    compCx.save(); compCx.fillStyle = col; compCx.globalAlpha = 0.75;
    compCx.beginPath(); compCx.arc(px,py,7,0,Math.PI*2); compCx.fill();
    compCx.globalAlpha = 1; compCx.strokeStyle = '#fff'; compCx.lineWidth = 1.5;
    compCx.beginPath(); compCx.arc(px,py,7,0,Math.PI*2); compCx.stroke();
    compCx.fillStyle = '#fff'; compCx.font = 'bold 9px sans-serif'; compCx.textAlign = 'center'; compCx.textBaseline = 'middle';
    compCx.fillText(counters[o.ti], px, py); compCx.restore();
  });
  var cX = allOff.reduce(function(a,o){return a+o.x;},0)/allOff.length;
  var cY = allOff.reduce(function(a,o){return a+o.y;},0)/allOff.length;
  var fromC = allOff.map(function(o){return Math.sqrt(Math.pow(o.x-cX,2)+Math.pow(o.y-cY,2));});
  var mr = fromC.reduce(function(a,r){return a+r;},0)/fromC.length;
  var r95 = mr * 2.1, r95px = r95 * scale;
  var cpx = SIZE/2+cX*scale, cpy = SIZE/2-cY*scale;
  drawR95(compCx, cpx, cpy, r95px, r95);
  compCx.save(); compCx.strokeStyle='#f97316'; compCx.fillStyle='rgba(249,115,22,0.2)'; compCx.lineWidth=1.5;
  compCx.beginPath(); compCx.arc(cpx,cpy,5,0,Math.PI*2); compCx.fill(); compCx.stroke();
  compCx.strokeStyle='#f97316'; compCx.lineWidth=1;
  compCx.beginPath(); compCx.moveTo(cpx-8,cpy); compCx.lineTo(cpx+8,cpy); compCx.stroke();
  compCx.beginPath(); compCx.moveTo(cpx,cpy-8); compCx.lineTo(cpx,cpy+8); compCx.stroke(); compCx.restore();
  drawPOA(compCx, SIZE/2, SIZE/2, false);
  compCx.fillStyle='#666'; compCx.font='10px sans-serif'; compCx.textAlign='center';
  compCx.fillText('+'+maxAbs.toFixed(2)+'"',SIZE-26,SIZE/2-5);
  compCx.fillText('\u2212'+maxAbs.toFixed(2)+'"',26,SIZE/2-5);
  var lh = targets.length * 14 + 8;
  compCx.fillStyle='rgba(249,249,247,0.92)'; compCx.fillRect(6,SIZE-lh-4,150,lh+4);
  targets.forEach(function(t,i){
    var c=colors[i%colors.length],y=SIZE-lh+i*14+8;
    compCx.fillStyle=c; compCx.fillRect(8,y-6,10,10);
    compCx.fillStyle='#444'; compCx.textAlign='left'; compCx.font='10px sans-serif';
    var lbl=t.label; if(lbl.length>18)lbl=lbl.slice(0,17)+'…';
    compCx.fillText(lbl+' ('+t.shots.length+')',22,y+2);
  });
  function sv(id,v){var e=document.getElementById(id);if(e&&e.childNodes[0])e.childNodes[0].nodeValue=v;}
  sv('dcN',allOff.length); sv('dcH',fmt(cX)); sv('dcV',fmt(cY)); sv('dcMR',fmt(mr)); sv('dcR95',fmt(r95));
  var es=0; for(var i=0;i<allOff.length;i++) for(var j=i+1;j<allOff.length;j++){var d=Math.sqrt(Math.pow(allOff[i].x-allOff[j].x,2)+Math.pow(allOff[i].y-allOff[j].y,2));if(d>es)es=d;}
  sv('dcES',fmt(es));
}

/* ── Export / Import ── */
function saveBackupFile() {
  if (sessions.length === 0) { toast('No sessions to save'); return; }
  var blob = new Blob([JSON.stringify({ version: 3, savedAt: new Date().toISOString(), sessions: sessions }, null, 2)], { type: 'application/json' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a'); a.href = url; a.download = 'shot-tracker-backup-' + new Date().toISOString().slice(0,10) + '.json'; a.click(); URL.revokeObjectURL(url);
  toast('Backup saved — choose iCloud Drive to sync across devices');
}
function loadBackupFile(file) {
  if (!file) return;
  var r = new FileReader();
  r.onload = function(ev) {
    try {
      var d = JSON.parse(ev.target.result);
      if (!d.sessions || !Array.isArray(d.sessions)) throw new Error('Unrecognized file format');
      sessions = d.sessions; activeSessionIdx = -1; activeTargetIdx = -1;
      clearCanvas(); dbSave(); renderSidebars();
      toast('Loaded ' + sessions.length + ' session' + (sessions.length !== 1 ? 's' : '') + ' from backup');
    } catch(e) { toast('Could not load backup: ' + e.message); }
  };
  r.readAsText(file);
}
function exportSpreadsheet() {
  var rows = [];
  sessions.forEach(function(sess, si) {
    sess.targets.forEach(function(tgt, ti) {
      if (!tgt.poa || tgt.shots.length === 0) return;
      var ppi = tgt.pxPerInch || (tgt.imgW / 36);
      var offs = tgt.shots.map(function(sh) { return { x:(sh.nx-tgt.poa.nx)/ppi, y:-(sh.ny-tgt.poa.ny)/ppi }; });
      var cX = offs.reduce(function(a,o){return a+o.x;},0)/offs.length;
      var cY = offs.reduce(function(a,o){return a+o.y;},0)/offs.length;
      offs.forEach(function(o, i) {
        var hc=o.x-cX, vc=o.y-cY, rc=Math.sqrt(hc*hc+vc*vc);
        rows.push(['"'+sess.name+'"',si+1,sess.dist,tgt.calibrated?'yes':'estimated','"'+tgt.label+'"',ti+1,i+1,o.x.toFixed(4),o.y.toFixed(4),hc.toFixed(4),vc.toFixed(4),rc.toFixed(4),'"'+(sess.notes||'')+'"'].join(','));
      });
    });
  });
  if (!rows.length) { toast('No data to export'); return; }
  var csv = 'Session,Session #,Distance (yd),Calibrated,Target,Target #,Shot #,H from POA (in),V from POA (in),H from centroid (in),V from centroid (in),Radius from centroid (in),Notes\n' + rows.join('\n');
  var blob = new Blob([csv], { type: 'text/csv' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a'); a.href = url; a.download = 'shot-tracker-data-' + new Date().toISOString().slice(0,10) + '.csv'; a.click(); URL.revokeObjectURL(url);
}
function exportCompositeImage() {
  if (compCv.style.display === 'none' || !compCv.width) renderComposite();
  if (compCv.style.display === 'none') { toast('No composite data to export'); return; }
  var url = compCv.toDataURL('image/png');
  var a = document.createElement('a'); a.href = url; a.download = 'shot-tracker-composite-' + new Date().toISOString().slice(0,10) + '.png'; a.click();
  toast('Composite image saved');
}

/* ── Sidebar HTML ── */
function buildSidebarHTML() {
  var activeSess = activeSessionIdx >= 0 ? sessions[activeSessionIdx] : null;
  var curLabel = (activeSess && activeTargetIdx >= 0 && activeSess.targets[activeTargetIdx])
    ? activeSess.targets[activeTargetIdx].label
    : (window._currentTargetLabel || '');

  /* Save button HTML — class driven by saveState */
  var saveBtnHTML = '<button class="btn ' + saveBtnClass() + '" id="dSaveTargetBtn" ' +
    'style="margin-bottom:4px' + (saveState === 'dirty' ? ';animation:savePulse 2s ease-in-out infinite' : '') + '" ' +
    'onclick="saveCurrentTarget();closeMobileDrawer()">' +
    '<i class="ti ti-device-floppy"></i> ' + saveLabel() + '</button>';

  var sessHTML = sessions.length === 0
    ? '<div style="font-size:12px;color:var(--text-tertiary);padding:4px 0">No sessions yet — create one to begin</div>'
    : sessions.map(function(s, si) {
        var isOpen = si === activeSessionIdx;
        var tgtHTML = '';
        if (isOpen && s.targets.length > 0) {
          tgtHTML = '<div style="margin-top:6px;display:flex;flex-direction:column;gap:3px">' +
            s.targets.map(function(t, ti) {
              var isCur = ti === activeTargetIdx;
              var st = computeStats(t.shots, t.poa, t.pxPerInch, t.imgW);
              var badge = st ? (st.n + ' shots · R95 ' + fmt(st.r95, 2) + '"') : (t.shots.length + ' shots');
              return '<div style="display:flex;align-items:center;gap:4px;padding:4px 8px;border-radius:var(--radius);' +
                'background:' + (isCur ? 'var(--bg-info)' : 'var(--bg-tertiary)') + ';' +
                'border:0.5px solid ' + (isCur ? 'var(--border-info)' : 'transparent') + '">' +
                '<div style="flex:1;cursor:pointer" onclick="loadTarget(' + si + ',' + ti + ')">' +
                  '<div style="font-size:12px;font-weight:' + (isCur?'500':'400') + ';color:' + (isCur?'var(--text-info)':'var(--text-primary)') + '">' + t.label + '</div>' +
                  '<div style="font-size:11px;color:var(--text-tertiary)">' + badge + '</div>' +
                '</div>' +
                '<button class="s-btn s-btn-danger" style="padding:2px 6px;font-size:11px" onclick="event.stopPropagation();askDelTarget(' + si + ',' + ti + ')">✕</button>' +
              '</div>';
            }).join('') + '</div>';
        }
        return '<div class="session-item' + (isOpen ? ' active' : '') + '" id="sitem' + si + '">' +
          '<div style="display:flex;align-items:center;gap:4px">' +
            '<div style="flex:1;cursor:pointer" onclick="openSession(' + si + ')">' +
              '<div class="session-name">' + s.name + '</div>' +
              '<div class="session-meta">' + s.dist + 'yd · ' + s.targets.length + ' target' + (s.targets.length !== 1 ? 's' : '') + (s.notes ? ' · ' + s.notes : '') + '</div>' +
            '</div>' +
            '<button class="s-btn" style="padding:2px 6px;font-size:11px" onclick="event.stopPropagation();editSession(' + si + ')"><i class="ti ti-pencil" style="font-size:11px"></i></button>' +
            '<button class="s-btn s-btn-danger" style="padding:2px 6px;font-size:11px" onclick="event.stopPropagation();askDelSession(' + si + ')">✕</button>' +
          '</div>' +
          tgtHTML +
          '<div class="s-del-confirm" id="sdel' + si + '">' +
            '<span>Delete session + all targets?</span>' +
            '<button class="s-btn s-confirm" onclick="deleteSession(' + si + ')">Yes</button>' +
            '<button class="s-btn" onclick="cancelDel(' + si + ')">No</button>' +
          '</div>' +
          '<div class="s-del-confirm" id="stgtdel' + si + '">' +
            '<span>Delete this target?</span>' +
            '<button class="s-btn s-confirm" id="stgtdelyes' + si + '">Yes</button>' +
            '<button class="s-btn" onclick="cancelTgtDel(' + si + ')">No</button>' +
          '</div>' +
        '</div>';
      }).join('');

  var targetFieldHTML = activeSess
    ? '<div class="field" style="margin-bottom:6px"><label>Target label</label>' +
      '<input id="dTargetLabel" type="text" placeholder="e.g. Group 1, Cold bore" value="' + curLabel + '" ' +
      'oninput="window._currentTargetLabel=this.value;markDirty()"/></div>'
    : '';

  return '<div class="sec-label">Actions</div>' +
    saveBtnHTML +
    '<button class="btn btn-sm" onclick="createNewSession();closeMobileDrawer()" style="margin-bottom:8px">' +
      '<i class="ti ti-plus"></i> New session</button>' +

    (activeSess
      ? '<div class="sec-label">Current session</div>' +
        '<div style="padding:8px 10px;border-radius:var(--radius);border:0.5px solid var(--border-info);background:var(--bg-info);margin-bottom:8px">' +
          '<div style="font-size:13px;font-weight:500;color:var(--text-info)">' + activeSess.name + '</div>' +
          '<div style="font-size:11px;color:var(--text-info);opacity:0.8">' + activeSess.dist + 'yd' + (activeSess.notes ? ' · ' + activeSess.notes : '') + '</div>' +
        '</div>' +
        targetFieldHTML +
        '<label class="btn upload-btn" style="margin-bottom:8px">' +
          '<i class="ti ti-photo-up"></i> Load target image' +
          '<input type="file" accept="image/*" onchange="loadImageFile(this.files[0])"/>' +
        '</label>'
      : '<div style="font-size:12px;color:var(--text-secondary);padding:4px 0;margin-bottom:8px">Create or open a session to load target images.</div>') +

    '<div class="sec-label">Save &amp; Export</div>' +
    '<div class="export-grid" style="margin-bottom:8px">' +
      '<button class="btn btn-sm" onclick="saveBackupFile()"><i class="ti ti-cloud-upload"></i> Save backup</button>' +
      '<label class="btn btn-sm upload-btn"><i class="ti ti-cloud-download"></i> Load backup<input type="file" accept=".json" onchange="loadBackupFile(this.files[0])"/></label>' +
      '<button class="btn btn-sm" onclick="exportSpreadsheet()"><i class="ti ti-file-spreadsheet"></i> Export spreadsheet</button>' +
      '<button class="btn btn-sm" onclick="exportCompositeImage()"><i class="ti ti-photo-down"></i> Save composite image</button>' +
    '</div>' +

    '<div class="sec-label">Sessions (' + sessions.length + ')</div>' +
    '<div class="sessions-list">' + sessHTML + '</div>' +
    (sessions.length > 0 ? '<button class="btn btn-danger btn-sm" onclick="askClearAll()" style="margin-top:8px"><i class="ti ti-trash"></i> Clear all sessions</button>' : '');
}

function saveLabel() {
  if (saveState === 'saving') return 'Saved ✓';
  if (saveState === 'clean')  return 'Saved ✓';
  return 'Save target'; /* dirty or none */
}

function renderSidebars() {
  var h = buildSidebarHTML();
  document.getElementById('dSidebarContent').innerHTML = h;
  document.getElementById('mDrawerContent').innerHTML = h;
}

function askDelSession(i) { var e = document.getElementById('sdel' + i); if (e) e.style.display = 'flex'; }
function cancelDel(i) { var e = document.getElementById('sdel' + i); if (e) e.style.display = 'none'; }
function askDelTarget(si, ti) {
  var e = document.getElementById('stgtdel' + si); if (e) e.style.display = 'flex';
  var yb = document.getElementById('stgtdelyes' + si);
  if (yb) yb.onclick = function() { deleteTarget(si, ti); };
}
function cancelTgtDel(si) { var e = document.getElementById('stgtdel' + si); if (e) e.style.display = 'none'; }
function askClearAll() {
  var p = window._cap;
  if (p) { clearTimeout(p); window._cap = null; sessions = []; activeSessionIdx = -1; activeTargetIdx = -1; clearCanvas(); dbSave(); renderSidebars(); toast('All sessions cleared'); return; }
  toast('Tap again within 3 seconds to clear all ' + sessions.length + ' sessions');
  window._cap = setTimeout(function() { window._cap = null; }, 3000);
}

/* ── Settings ── */
function openSettings() { document.getElementById('settingsOverlay').classList.add('open'); renderSettings(); }
function closeSettings() { document.getElementById('settingsOverlay').classList.remove('open'); }
function renderSettings() {
  var note = settings.storageMode === 'files'
    ? 'After saving a target, you\'ll be reminded to save a backup file. Choose iCloud Drive to sync across your Apple devices.'
    : 'Sessions are saved in this browser automatically. Use "Save backup" to create a portable file for iCloud Drive or sharing.';
  document.getElementById('storageNote').textContent = note;
  document.getElementById('storageModeLocal').classList.toggle('active', settings.storageMode === 'local');
  document.getElementById('storageModFiles').classList.toggle('active', settings.storageMode === 'files');
  document.getElementById('calDefaultInput').value = settings.calDefault;
}
function setStorageMode(m) { settings.storageMode = m; saveSettings(); renderSettings(); toast(m === 'files' ? 'Backup-to-file mode enabled' : 'Local storage mode enabled'); }

/* ── Mobile drawer ── */
function openMobileDrawer() { renderSidebars(); document.getElementById('mDrawer').classList.add('open'); }
function closeMobileDrawer() { document.getElementById('mDrawer').classList.remove('open'); }

/* ── Tabs ── */
function switchTab(t) {
  document.getElementById('dTabSession').classList.toggle('active', t === 'session');
  document.getElementById('dTabComposite').classList.toggle('active', t === 'composite');
  document.getElementById('dPanelSession').style.display    = t === 'session'   ? 'flex' : 'none';
  document.getElementById('dPanelComposite').style.display  = t === 'composite' ? 'flex' : 'none';
  if (t === 'composite') renderComposite();
}

/* ── PWA ── */
var deferredInstall = null;
window.addEventListener('beforeinstallprompt', function(e) { e.preventDefault(); deferredInstall = e; document.getElementById('installBanner').classList.add('show'); });
window.addEventListener('appinstalled', function() { document.getElementById('installBanner').classList.remove('show'); deferredInstall = null; toast('Shot Tracker installed!'); });
function triggerInstall() { if (!deferredInstall) return; deferredInstall.prompt(); deferredInstall.userChoice.then(function() { deferredInstall = null; }); }

/* ── Wire events ── */
function wire(id, evt, fn) { var e = document.getElementById(id); if (e) e.addEventListener(evt, fn); }
wire('dTabSession',    'click', function() { switchTab('session'); });
wire('dTabComposite',  'click', function() { switchTab('composite'); });
wire('dRefreshComp',   'click', renderComposite);
wire('dExportSpread',  'click', exportSpreadsheet);
wire('dExportImg',     'click', exportCompositeImage);
wire('dCancelCal',     'click', cancelCal);
wire('mCancelCal',     'click', cancelCal);
wire('dModePOA',  'click', function() { if (!calMode && pxPerInch) setMode('poa');  else if (!pxPerInch) toast('Calibrate first'); });
wire('dModeShot', 'click', function() { if (!calMode && poa)       setMode('shot'); else if (!poa) toast('Set POA first'); });
wire('dModeEdit', 'click', function() { if (!calMode) setMode('edit'); });
wire('mModePOA',  'click', function() { if (!calMode && pxPerInch) setMode('poa');  else if (!pxPerInch) toast('Calibrate first'); });
wire('mModeShot', 'click', function() { if (!calMode && poa)       setMode('shot'); else if (!poa) toast('Set POA first'); });
wire('mModeEdit', 'click', function() { if (!calMode) setMode('edit'); });
wire('dUndo',     'click', undoLast);
wire('mUndo',     'click', undoLast);
wire('dDelSel',   'click', deleteSelected);
wire('mDelSel',   'click', deleteSelected);
wire('mMenuBtn',  'click', openMobileDrawer);
wire('mDrawerBackdrop', 'click', closeMobileDrawer);
wire('dSettingsBtn', 'click', openSettings);
wire('mSettingsBtn', 'click', function() { closeMobileDrawer(); openSettings(); });
wire('settingsClose',    'click', closeSettings);
wire('settingsOverlay',  'click', function(e) { if (e.target === this) closeSettings(); });
wire('storageModeLocal', 'click', function() { setStorageMode('local'); });
wire('storageModFiles',  'click', function() { setStorageMode('files'); });
wire('calDefaultInput',  'change', function() { var v = parseFloat(this.value) || 1; settings.calDefault = v; saveSettings(); toast('Default cal distance set to ' + v + '"'); });
wire('mStatsToggle', 'click', function() { this.classList.toggle('open'); document.getElementById('mStatsPanel').classList.toggle('open'); });
wire('installBanner',  'click', triggerInstall);
wire('installDismiss', 'click', function(e) { e.stopPropagation(); document.getElementById('installBanner').classList.remove('show'); });

window.addEventListener('resize', function() {
  if (currentImg) {
    sizeCanvas(dCv, document.getElementById('dCanvasWrap'));
    sizeCanvas(mCv, document.getElementById('mCanvasWrap'));
    renderBoth();
  }
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', function() { navigator.serviceWorker.register('/sw.js').catch(function() {}); });
}

/* ── Boot ── */
openDB().then(function() {
  return dbLoad();
}).then(function(saved) {
  if (saved && saved.length > 0) {
    sessions = saved.map(function(s) { var c = Object.assign({}, s); delete c.id; return c; });
    /* Migrate v1 flat sessions to v2 targets structure */
    sessions = sessions.map(function(s) {
      if (s.targets) return s;
      var sess = newSession(s.name, s.dist, s.notes || '');
      if (s.poa && s.shots && s.shots.length > 0) {
        var tgt = newTarget(s.name || 'Target 1', s.imgSrc, s.imgW, s.imgH);
        tgt.pxPerInch = s.pxPerInch || null;
        tgt.poa = s.poa;
        tgt.shots = s.shots;
        tgt.calibrated = s.calibrated || false;
        sess.targets.push(tgt);
      }
      return sess;
    });
    toast('Loaded ' + sessions.length + ' session' + (sessions.length !== 1 ? 's' : ''));
  }
  renderSidebars(); updateStepBar(); updateBanner();
});
