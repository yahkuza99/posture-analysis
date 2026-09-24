/* Posture Analysis
 * Local, single-page report builder. Everything stays in the browser:
 * the working case is autosaved to IndexedDB and can be exported/imported as a .json file.
 */
(() => {
'use strict';

// ------------------------------------------------------------------ config

const SLOTS = {
  front:     { label: 'ด้านหน้า (Anterior)',       view: 'front', row: 'row1' },
  back:      { label: 'ด้านหลัง (Posterior)',      view: 'back',  row: 'row1' },
  sideR:     { label: 'ด้านข้างขวา (Rt. lateral)', view: 'side',  row: 'row2' },
  sideL:     { label: 'ด้านข้างซ้าย (Lt. lateral)', view: 'side',  row: 'row2' },
  slsL:      { label: 'ยืนขาซ้าย (Single leg stance Lt.)', view: 'back', text: 'functional.sls' },
  slsR:      { label: 'ยืนขาขวา (Single leg stance Rt.)', view: 'back', text: 'functional.sls' },
  squatBack: { label: 'Squat ด้านหลัง',  view: 'back', text: 'functional.squat' },
  squatSide: { label: 'Squat ด้านข้าง',  view: 'side', text: 'functional.squat' },
};

// Quick-insert findings. Edit this list to match the clinic's wording.
const PRESETS = [
  'ไหล่ขวาสูงกว่าซ้าย', 'ไหล่ซ้ายสูงกว่าขวา',
  'ไหล่ขวาสูงกว่าซ้ายเล็กน้อย', 'ไหล่ซ้ายสูงกว่าขวาเล็กน้อย',
  'สะบักเปิดออกข้างขวามากกว่าซ้าย', 'สะบักเปิดออกข้างซ้ายมากกว่าขวา',
  'สะโพกขวาสูงกว่าซ้าย', 'สะโพกซ้ายสูงกว่าขวา',
  'ลงน้ำหนักเท้าขวา', 'ลงน้ำหนักเท้าซ้าย',
  'ศีรษะยื่นไปด้านหน้า (Forward head)',
  'ไหล่ห่อ (Rounded shoulder)',
  'ไหล่ขวางุ้มกว่าไหล่ซ้าย', 'ไหล่ซ้ายงุ้มกว่าไหล่ขวา',
  'หลังส่วนบนค่อม (Kyphosis)',
  'หลังส่วนล่างแอ่น', 'หลังส่วนล่างแบน (Flat back)',
  'เข่าแอ่น (Hyperextension)',
  'เข่าชิด (Knock knee)', 'ขาโก่ง (Bow leg)',
  'เท้าแบน (Flat foot)',
  'สะโพกหมุนไปทางด้านหน้า',
  '@qangle', '@scoliometer',
];
const PRESET_LABEL = { '@qangle': 'Q-angle (กรอกจากค่าที่วัด)', '@scoliometer': 'Scoliometer' };

const COLORS = ['#e3262e', '#2dbd3a', '#f4c20d', '#1e88e5', '#ffffff', '#111111'];

const TOOLS = [
  { id: 'select', label: 'เลือก/ย้าย', key: 'V' },
  { id: 'point',  label: 'จุด',        key: 'P', color: '#f4c20d', clicks: 1 },
  { id: 'plumb',  label: 'เส้นดิ่ง',    key: 'G', color: '#2dbd3a', clicks: 1 },
  { id: 'line',   label: 'เส้นระดับ',   key: 'L', color: '#e3262e', clicks: 2 },
  { id: 'dashed', label: 'เส้นประ',     key: 'D', color: '#f4c20d', clicks: 2 },
  { id: 'angle',  label: 'มุม',         key: 'A', color: '#e3262e', clicks: 3 },
  { id: 'qangle', label: 'Q-angle',     key: 'Q', color: '#f4c20d', clicks: 3 },
  { id: 'text',   label: 'ข้อความ',     key: 'T', color: '#111111', clicks: 1 },
];
const TOOL_HINTS = {
  select: 'คลิกเส้น/จุดเพื่อเลือก ลากจุดเพื่อปรับตำแหน่ง ลากตัวเส้นเพื่อย้ายทั้งเส้น',
  point:  'คลิกเพื่อวางจุด landmark',
  plumb:  'คลิกที่ตาตุ่ม/กึ่งกลางฐาน เพื่อวางเส้นดิ่ง (แนวตั้ง)',
  line:   ['คลิกจุดที่ 1 (เช่น ไหล่ข้างหนึ่ง)', 'คลิกจุดที่ 2 (อีกข้าง)'],
  dashed: ['คลิกจุดเริ่มต้น', 'คลิกจุดปลาย'],
  angle:  ['คลิกปลายแขนมุมที่ 1', 'คลิกจุดยอดมุม', 'คลิกปลายแขนมุมที่ 2'],
  qangle: ['คลิก ASIS', 'คลิกกึ่งกลางลูกสะบ้า (Patella)', 'คลิก Tibial tuberosity'],
  text:   'คลิกตำแหน่งที่จะวางข้อความ',
};

// ------------------------------------------------------------------ state

function emptyCase() {
  return {
    version: 1,
    patient: { name: '', lastname: '', cn: '', therapist: '', date: todayISO(), rechecked: '' },
    photos: {},                        // slotId -> { src, w, h, view:{z,cx,cy}, shapes:[] }
    findings: { row1: [], row2: [] },  // arrays of strings
    functional: { sls: '', squat: '' },
    muscle: { src: null, strokes: [], tightList: '', weakList: '' },
    impression: '',
    recommendation: '',
  };
}
let state = emptyCase();
const images = {}; // src -> HTMLImageElement (decoded)

function todayISO() {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}
function getPath(obj, path) { return path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj); }
function setPath(obj, path, v) {
  const keys = path.split('.'); const last = keys.pop();
  const target = keys.reduce((o, k) => (o[k] ??= {}), obj);
  target[last] = v;
}

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

function toast(msg, ms = 2600) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), ms);
}

function loadImage(src) {
  if (images[src]) return Promise.resolve(images[src]);
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => { images[src] = img; res(img); };
    img.onerror = rej;
    img.src = src;
  });
}

// Downscale big phone photos so the saved case stays small.
async function fileToDataURL(file, maxSide = 1800) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    const k = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(img, 0, 0, c.width, c.height);
    return { src: c.toDataURL('image/jpeg', 0.88), w: c.width, h: c.height };
  } finally { URL.revokeObjectURL(url); }
}

// ------------------------------------------------------------------ persistence (IndexedDB)

const DB_NAME = 'posture-analysis', STORE = 'kv';
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
async function idbSet(key, val) {
  const db = await idb();
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE, 'readwrite'); tx.objectStore(STORE).put(val, key);
    tx.oncomplete = res; tx.onerror = () => rej(tx.error);
  });
}
async function idbGet(key) {
  const db = await idb();
  return new Promise((res, rej) => {
    const r = db.transaction(STORE).objectStore(STORE).get(key);
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}

let saveTimer;
function changed() {
  clearTimeout(saveTimer);
  $('#saveStatus').textContent = 'กำลังบันทึก…';
  saveTimer = setTimeout(async () => {
    try {
      await idbSet('current', JSON.stringify(state));
      $('#saveStatus').textContent = 'บันทึกอัตโนมัติแล้ว ' + new Date().toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });
    } catch (e) {
      $('#saveStatus').textContent = 'บันทึกอัตโนมัติไม่ได้ — กรุณากด "บันทึกไฟล์"';
    }
  }, 500);
}

function caseFileName() {
  const p = state.patient;
  const parts = [p.cn, p.name, p.lastname, p.date].filter(Boolean).join('_') || 'posture';
  return parts.replace(/[\\/:*?"<>|\s]+/g, '-') + '.json';
}
function saveFile() {
  const blob = new Blob([JSON.stringify(state)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = caseFileName();
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
async function openFile(file) {
  try {
    const data = JSON.parse(await file.text());
    if (!data || typeof data !== 'object' || !data.patient) throw new Error('bad file');
    await applyState(Object.assign(emptyCase(), data));
    changed();
    toast('เปิดไฟล์แล้ว');
  } catch (e) {
    toast('เปิดไฟล์ไม่ได้ — ไฟล์ไม่ใช่ไฟล์เคสของระบบนี้');
  }
}

// ------------------------------------------------------------------ form bindings

function bindFields() {
  $$('[data-bind]').forEach(el => {
    el.addEventListener('input', () => {
      setPath(state, el.dataset.bind, el.value);
      $$(`[data-bind="${el.dataset.bind}"]`).forEach(o => { if (o !== el) o.value = el.value; });
      if (el.dataset.bind === 'patient.date') updatePrintDate();
      changed();
    });
  });
  $$('[data-bind-text]').forEach(el => {
    el.addEventListener('input', () => { setPath(state, el.dataset.bindText, readEditable(el)); changed(); });
    el.addEventListener('paste', plainPaste);
  });
}
// <input type=date> prints in the browser's format with a calendar icon; print a Thai date instead.
function updatePrintDate() {
  const v = state.patient.date; let txt = '';
  if (v) { const [y, m, d] = v.split('-').map(Number); txt = new Date(y, m - 1, d).toLocaleDateString('th-TH', { day: '2-digit', month: '2-digit', year: 'numeric' }); }
  $$('.date-print').forEach(el => (el.textContent = txt));
}
function readEditable(el) { return el.innerText.replace(/\n$/, ''); }
function plainPaste(e) {
  e.preventDefault();
  document.execCommand('insertText', false, (e.clipboardData || window.clipboardData).getData('text/plain'));
}
function fillFields() {
  $$('[data-bind]').forEach(el => { el.value = getPath(state, el.dataset.bind) ?? ''; });
  updatePrintDate();
  $$('[data-bind-text]').forEach(el => { el.innerText = getPath(state, el.dataset.bindText) ?? ''; });
}

// ------------------------------------------------------------------ findings boxes (page 1)

function renderFindings(row) {
  const col = $(`[data-findings="${row}"]`);
  col.innerHTML = '';
  state.findings[row].forEach((text, i) => {
    const wrap = document.createElement('div'); wrap.className = 'finding-wrap';
    const box = document.createElement('div');
    box.className = 'finding'; box.contentEditable = 'true'; box.innerText = text;
    box.addEventListener('input', () => { state.findings[row][i] = readEditable(box); changed(); });
    box.addEventListener('paste', plainPaste);
    const del = document.createElement('button');
    del.type = 'button'; del.className = 'finding-del'; del.textContent = '×'; del.title = 'ลบกล่องนี้';
    del.onclick = () => { state.findings[row].splice(i, 1); renderFindings(row); changed(); };
    wrap.append(box, del); col.append(wrap);
  });

  const add = document.createElement('div'); add.className = 'findings-add';
  const sel = document.createElement('select');
  sel.innerHTML = '<option value="">+ เลือกข้อความสำเร็จรูป…</option>' +
    PRESETS.map(p => `<option value="${p}">${PRESET_LABEL[p] || p}</option>`).join('');
  sel.onchange = () => { if (sel.value) addFinding(row, presetText(sel.value)); };
  const btn = document.createElement('button'); btn.type = 'button'; btn.textContent = '+ กล่องว่าง';
  btn.onclick = () => addFinding(row, '', true);
  add.append(sel, btn); col.append(add);
}
function addFinding(row, text, focus) {
  state.findings[row].push(text);
  renderFindings(row); changed();
  if (focus) { const boxes = $$(`[data-findings="${row}"] .finding`); boxes[boxes.length - 1]?.focus(); }
}
function presetText(p) {
  if (p === '@scoliometer') return 'Scoliometer\n__ : __ degree';
  if (p === '@qangle') {
    const q = qAnglesFor('front');
    const fmt = v => (v == null ? '__' : Math.round(v));
    return `Q-angle\nRt.side = ${fmt(q.Rt)} องศา\nLt.side = ${fmt(q.Lt)} องศา\n**ค่าปกติ**\nผู้หญิง ≤ 20 ผู้ชาย ≤ 15`;
  }
  return p;
}

// ------------------------------------------------------------------ geometry & measurements

const deg = r => r * 180 / Math.PI;
function angleAt(a, v, b) { // interior angle at v, degrees
  const a1 = Math.atan2(a[1] - v[1], a[0] - v[0]), a2 = Math.atan2(b[1] - v[1], b[0] - v[0]);
  let d = Math.abs(deg(a1 - a2)); if (d > 180) d = 360 - d; return d;
}
function qAngle(s) { return 180 - angleAt(s.pts[0], s.pts[1], s.pts[2]); }
function lineTilt(s) { // degrees from horizontal, 0..90, and which image side is higher
  let [a, b] = s.pts; if (a[0] > b[0]) [a, b] = [b, a];
  const t = deg(Math.atan2(a[1] - b[1], b[0] - a[0])); // + => image-right side higher
  return { deg: Math.abs(t), higher: t > 0.05 ? 'imgRight' : t < -0.05 ? 'imgLeft' : null };
}
// Patient side for an image side. Front view is mirrored (patient's right is on image-left).
function patientSide(imgSide, view) {
  if (view === 'front') return imgSide === 'imgLeft' ? 'Rt' : 'Lt';
  if (view === 'back') return imgSide === 'imgLeft' ? 'Lt' : 'Rt';
  return null;
}
const TH_SIDE = { Rt: 'ขวา', Lt: 'ซ้าย' };

function measuresOf(photo, view) {
  const out = [];
  photo.shapes.forEach((s, i) => {
    if (s.type === 'line') {
      const t = lineTilt(s);
      const side = t.higher && patientSide(t.higher, view);
      let txt = `เส้นระดับเอียง ${t.deg.toFixed(1)}°`;
      if (side) txt += ` (ข้าง${TH_SIDE[side]}สูงกว่า)`;
      else if (t.higher) txt += ` (${t.higher === 'imgRight' ? 'ขวา' : 'ซ้าย'}ของภาพสูงกว่า)`;
      out.push({ i, txt });
    } else if (s.type === 'angle') {
      out.push({ i, txt: `มุม ${angleAt(...s.pts).toFixed(1)}°` });
    } else if (s.type === 'qangle') {
      const side = qSide(s, photo, view);
      out.push({ i, txt: `Q-angle ${side ? side + '.side ' : ''}= ${Math.round(qAngle(s))} องศา` });
    }
  });
  return out;
}
function qSide(s, photo, view) {
  const imgSide = s.pts[1][0] < photo.w / 2 ? 'imgLeft' : 'imgRight';
  return patientSide(imgSide, view);
}
function qAnglesFor(slotId) {
  const photo = state.photos[slotId]; const r = { Rt: null, Lt: null };
  if (!photo) return r;
  photo.shapes.filter(s => s.type === 'qangle').forEach(s => {
    const side = qSide(s, photo, SLOTS[slotId].view); if (side) r[side] = qAngle(s);
  });
  return r;
}

// ------------------------------------------------------------------ drawing

/* Draws an annotated photo. `tf` maps image px -> canvas px: X = x*s + tx.
 * `u` is the base unit for stroke widths and fonts (canvas px). */
function drawPhoto(ctx, photo, img, tf, u, opts = {}) {
  const { s, tx, ty } = tf;
  const P = p => [p[0] * s + tx, p[1] * s + ty];
  ctx.drawImage(img, tx, ty, photo.w * s, photo.h * s);
  const top = ty, bottom = ty + photo.h * s;

  photo.shapes.forEach((sh, idx) => {
    const sel = opts.selected === idx;
    ctx.save();
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.strokeStyle = sh.color; ctx.fillStyle = sh.color;
    ctx.lineWidth = 2.2 * u;
    if (sel) { ctx.shadowColor = '#00e5ff'; ctx.shadowBlur = 8 * u; }
    const pts = sh.pts.map(P);

    switch (sh.type) {
      case 'point':
        landmark(ctx, pts[0], u, sh.color); break;
      case 'plumb':
        ctx.beginPath(); ctx.moveTo(pts[0][0], top); ctx.lineTo(pts[0][0], bottom); ctx.stroke();
        landmark(ctx, pts[0], u, sh.color); break;
      case 'line': {
        const [a, b] = pts; const dx = b[0] - a[0], dy = b[1] - a[1], ext = 0.18;
        ctx.beginPath(); ctx.moveTo(a[0] - dx * ext, a[1] - dy * ext); ctx.lineTo(b[0] + dx * ext, b[1] + dy * ext); ctx.stroke();
        landmark(ctx, a, u, '#f4c20d'); landmark(ctx, b, u, '#f4c20d');
        if (opts.labels !== false) {
          const t = lineTilt(sh); const R = a[0] > b[0] ? a : b;
          label(ctx, `${t.deg.toFixed(1)}°`, R[0], R[1] - 10 * u, u, sh.color);
        }
        break;
      }
      case 'dashed':
        ctx.setLineDash([4 * u, 3.5 * u]); ctx.lineWidth = 2 * u;
        ctx.beginPath(); ctx.moveTo(...pts[0]); ctx.lineTo(...pts[1]); ctx.stroke();
        ctx.setLineDash([]);
        landmark(ctx, pts[0], u, '#f4c20d'); landmark(ctx, pts[1], u, '#f4c20d'); break;
      case 'angle': case 'qangle': {
        const [a, v, b] = pts;
        ctx.beginPath(); ctx.moveTo(...a); ctx.lineTo(...v); ctx.lineTo(...b); ctx.stroke();
        if (sh.type === 'qangle') { // extension of ASIS→patella line, the Q-angle is measured against it
          const dx = v[0] - a[0], dy = v[1] - a[1], L = Math.hypot(dx, dy) || 1;
          const ext = Math.hypot(b[0] - v[0], b[1] - v[1]);
          ctx.setLineDash([3 * u, 3 * u]); ctx.lineWidth = 1.4 * u;
          ctx.beginPath(); ctx.moveTo(...v); ctx.lineTo(v[0] + dx / L * ext, v[1] + dy / L * ext); ctx.stroke();
          ctx.setLineDash([]);
        }
        pts.forEach(p => landmark(ctx, p, u, '#f4c20d'));
        if (opts.labels !== false) {
          const val = sh.type === 'qangle' ? qAngle(sh) : angleAt(...sh.pts);
          label(ctx, `${sh.type === 'qangle' ? 'Q ' : ''}${Math.round(val)}°`, v[0] + 10 * u, v[1] - 4 * u, u, sh.color, 'left');
        }
        break;
      }
      case 'text':
        label(ctx, sh.text || '', pts[0][0], pts[0][1], u, sh.color, 'left', true); break;
    }
    ctx.restore();
  });

  // in-progress shape
  if (opts.pending && opts.pending.pts.length) {
    const pend = opts.pending;
    ctx.save();
    ctx.strokeStyle = pend.color; ctx.lineWidth = 1.6 * u; ctx.setLineDash([5 * u, 4 * u]);
    const pts = pend.pts.map(P); if (opts.cursor) pts.push(opts.cursor);
    ctx.beginPath(); pts.forEach((p, i) => (i ? ctx.lineTo(...p) : ctx.moveTo(...p))); ctx.stroke();
    ctx.setLineDash([]);
    pend.pts.map(P).forEach(p => landmark(ctx, p, u, '#f4c20d'));
    ctx.restore();
  }
}
function landmark(ctx, [x, y], u, color) {
  ctx.save(); ctx.shadowBlur = 0; ctx.setLineDash([]);
  ctx.beginPath(); ctx.arc(x, y, 4.2 * u, 0, Math.PI * 2);
  ctx.fillStyle = color === '#ffffff' || color === '#111111' ? '#f4c20d' : color; ctx.fill();
  ctx.lineWidth = 1.4 * u; ctx.strokeStyle = '#1a1a1a'; ctx.stroke();
  ctx.beginPath(); ctx.arc(x, y, 1.3 * u, 0, Math.PI * 2); ctx.fillStyle = '#1a1a1a'; ctx.fill();
  ctx.restore();
}
function label(ctx, txt, x, y, u, color, align = 'center', boxed = false) {
  ctx.save(); ctx.shadowBlur = 0;
  ctx.font = `600 ${11 * u}px Sarabun, Tahoma, sans-serif`;
  ctx.textAlign = align; ctx.textBaseline = 'middle';
  const lines = String(txt).split('\n'); const lh = 13 * u;
  const w = Math.max(...lines.map(l => ctx.measureText(l).width));
  const x0 = align === 'left' ? x : x - w / 2;
  ctx.fillStyle = 'rgba(255,255,255,.88)';
  const pad = 2.5 * u;
  ctx.fillRect(x0 - pad, y - lh / 2 - pad / 2, w + pad * 2, lh * lines.length + pad);
  if (boxed) { ctx.lineWidth = 0.8 * u; ctx.strokeStyle = '#333'; ctx.strokeRect(x0 - pad, y - lh / 2 - pad / 2, w + pad * 2, lh * lines.length + pad); }
  ctx.fillStyle = color === '#ffffff' ? '#111' : color;
  lines.forEach((l, i) => ctx.fillText(l, x, y + i * lh));
  ctx.restore();
}

// ------------------------------------------------------------------ photo slots on the page

const PRINT_SCALE = 3; // slot canvases are rendered at 3× for sharp print/PDF

function slotEl(id) { return $(`[data-slot="${id}"]`); }

function slotTransform(photo, W, H) {
  const v = photo.view; const s = Math.max(W / photo.w, H / photo.h) * v.z;
  // keep the photo covering the frame (no white gaps) when it is big enough to
  const clamp = (c, size, frame) => {
    const half = frame / 2 / s;
    return size * s >= frame ? Math.min(size - half, Math.max(half, c)) : size / 2;
  };
  const cx = clamp(v.cx, photo.w, W), cy = clamp(v.cy, photo.h, H);
  return { s, tx: W / 2 - cx * s, ty: H / 2 - cy * s };
}

// Frame the person, not the photo: centre on the plumb line when there is one.
function plumbX(photo) {
  const p = photo.shapes.find(sh => sh.type === 'plumb');
  return p ? p.pts[0][0] : null;
}
function centerView(photo) {
  photo.view = { z: photo.view?.z || 1, cx: plumbX(photo) ?? photo.w / 2, cy: photo.h / 2 };
}

function renderSlot(id) {
  const el = slotEl(id); const photo = state.photos[id];
  el.innerHTML = '';
  if (!photo) {
    el.className = 'slot empty';
    el.innerHTML = `<div>${SLOTS[id].label}<br><small>คลิก หรือ ลากรูปมาวาง</small></div>`;
    return;
  }
  el.className = 'slot filled';
  const c = document.createElement('canvas'); el.append(c);
  const tools = document.createElement('div'); tools.className = 'slot-tools';
  tools.innerHTML = `
    <button type="button" class="primary" data-a="edit">วางจุด/เส้น</button>
    <button type="button" data-a="in" title="ขยาย">＋</button>
    <button type="button" data-a="out" title="ย่อ">－</button>
    <button type="button" data-a="reset" title="จัดกึ่งกลาง">⟲</button>
    <button type="button" data-a="replace">เปลี่ยนรูป</button>
    <button type="button" data-a="remove">ลบ</button>`;
  el.append(tools);
  drawSlot(id);
}

function drawSlot(id) {
  const el = slotEl(id); const photo = state.photos[id]; const c = el.querySelector('canvas');
  if (!photo || !c) return;
  const W = el.clientWidth, H = el.clientHeight; if (!W || !H) return;
  c.width = W * PRINT_SCALE; c.height = H * PRINT_SCALE;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  loadImage(photo.src).then(img => {
    const tf = slotTransform(photo, c.width, c.height);
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    drawPhoto(ctx, photo, img, tf, c.height / 360);
  });
}

let pickTarget = null;
function pickPhoto(id) { pickTarget = id; $('#photoFile').value = ''; $('#photoFile').click(); }

async function setPhoto(id, file) {
  if (!file || !file.type.startsWith('image/')) { toast('กรุณาเลือกไฟล์รูปภาพ'); return; }
  const { src, w, h } = await fileToDataURL(file);
  const old = state.photos[id];
  if (old && old.shapes.length && !confirm('เปลี่ยนรูปแล้วจุดและเส้นเดิมจะถูกลบ ต้องการเปลี่ยนหรือไม่?')) return;
  state.photos[id] = { src, w, h, view: { z: 1, cx: w / 2, cy: h / 2 }, shapes: [] };
  renderSlot(id); changed();
}

function bindSlots() {
  Object.keys(SLOTS).forEach(id => {
    const el = slotEl(id);
    el.addEventListener('click', e => {
      const a = e.target.closest('button')?.dataset.a;
      const photo = state.photos[id];
      if (!photo) { pickPhoto(id); return; }
      if (!a) return;
      if (a === 'edit') openEditor(id);
      if (a === 'replace') pickPhoto(id);
      if (a === 'remove' && confirm('ลบรูปนี้พร้อมจุดและเส้นทั้งหมด?')) { delete state.photos[id]; renderSlot(id); changed(); }
      if (a === 'in' || a === 'out') { photo.view.z = Math.max(0.3, Math.min(8, photo.view.z * (a === 'in' ? 1.15 : 1 / 1.15))); drawSlot(id); changed(); }
      if (a === 'reset') { photo.view.z = 1; centerView(photo); drawSlot(id); changed(); }
    });
    el.addEventListener('dblclick', e => { if (state.photos[id] && !e.target.closest('button')) openEditor(id); });

    // drag the photo inside its frame to position it
    el.addEventListener('pointerdown', e => {
      const photo = state.photos[id];
      if (!photo || e.button !== 0 || e.target.closest('button')) return;
      el.setPointerCapture(e.pointerId);
      const tf = slotTransform(photo, el.clientWidth, el.clientHeight), s = tf.s;
      const start = { x: e.clientX, y: e.clientY, cx: (el.clientWidth / 2 - tf.tx) / s, cy: (el.clientHeight / 2 - tf.ty) / s };
      let moved = false;
      const move = ev => {
        const dx = ev.clientX - start.x, dy = ev.clientY - start.y;
        if (Math.abs(dx) + Math.abs(dy) > 2) moved = true;
        photo.view.cx = start.cx - dx / s; photo.view.cy = start.cy - dy / s;
        drawSlot(id);
      };
      const up = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); if (moved) changed(); };
      el.addEventListener('pointermove', move); el.addEventListener('pointerup', up);
    });

    el.addEventListener('dragover', e => { e.preventDefault(); el.classList.add('dragover'); });
    el.addEventListener('dragleave', () => el.classList.remove('dragover'));
    el.addEventListener('drop', e => {
      e.preventDefault(); el.classList.remove('dragover');
      const f = e.dataTransfer.files[0]; if (f) setPhoto(id, f);
    });
  });
  $('#photoFile').addEventListener('change', e => { const f = e.target.files[0]; if (f && pickTarget) setPhoto(pickTarget, f); });
}

// ------------------------------------------------------------------ annotation editor

const ed = {
  id: null, photo: null, img: null,
  tool: 'select', color: null,
  s: 1, tx: 0, ty: 0,           // image -> screen (CSS px)
  pending: null, cursor: null,
  selected: -1, drag: null, pan: null, space: false,
  history: [],
};
const edCanvas = $('#edCanvas');

function openEditor(id) {
  ed.id = id; ed.photo = state.photos[id];
  ed.history = []; ed.selected = -1; ed.pending = null; ed.plumbAtOpen = plumbX(ed.photo);
  $('#edTitle').textContent = 'วางจุด/เส้น — ' + SLOTS[id].label;
  $('#editor').hidden = false;
  document.body.style.overflow = 'hidden';
  loadImage(ed.photo.src).then(img => { ed.img = img; fitEditor(); setTool(ed.tool); });
}
function closeEditor() {
  $('#editor').hidden = true; document.body.style.overflow = '';
  const id = ed.id, photo = ed.photo; ed.id = null; ed.photo = null;
  if (plumbX(photo) !== ed.plumbAtOpen) centerView(photo); // plumb line added or moved: re-centre on it
  drawSlot(id); changed();
}
function fitEditor() {
  const st = $('#edStage'); const W = st.clientWidth, H = st.clientHeight, p = ed.photo;
  ed.s = Math.min((W - 40) / p.w, (H - 40) / p.h);
  ed.tx = (W - p.w * ed.s) / 2; ed.ty = (H - p.h * ed.s) / 2;
  drawEditor();
}
function drawEditor() {
  if (!ed.photo || !ed.img) return;
  const st = $('#edStage'); const dpr = window.devicePixelRatio || 1;
  const W = st.clientWidth, H = st.clientHeight;
  if (edCanvas.width !== Math.round(W * dpr) || edCanvas.height !== Math.round(H * dpr)) {
    edCanvas.width = Math.round(W * dpr); edCanvas.height = Math.round(H * dpr);
  }
  const ctx = edCanvas.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#2b2e33'; ctx.fillRect(0, 0, edCanvas.width, edCanvas.height);
  const tf = { s: ed.s * dpr, tx: ed.tx * dpr, ty: ed.ty * dpr };
  const cursor = ed.cursor && [ed.cursor[0] * dpr, ed.cursor[1] * dpr];
  drawPhoto(ctx, ed.photo, ed.img, tf, 1.25 * dpr, { selected: ed.selected, pending: ed.pending, cursor });
  renderMeasures();
}

function toImg(e) {
  const r = edCanvas.getBoundingClientRect();
  const sx = e.clientX - r.left, sy = e.clientY - r.top;
  return { screen: [sx, sy], img: [(sx - ed.tx) / ed.s, (sy - ed.ty) / ed.s] };
}
function toScreen(p) { return [p[0] * ed.s + ed.tx, p[1] * ed.s + ed.ty]; }

function snapshot() { ed.history.push(JSON.stringify(ed.photo.shapes)); if (ed.history.length > 100) ed.history.shift(); }
function undo() {
  if (ed.pending && ed.pending.pts.length) { ed.pending.pts.pop(); updateHint(); drawEditor(); return; }
  const h = ed.history.pop(); if (h == null) return;
  ed.photo.shapes = JSON.parse(h); ed.selected = -1; drawEditor();
}

function setTool(id) {
  ed.tool = id; ed.pending = null;
  const t = TOOLS.find(t => t.id === id);
  ed.color = t.color || ed.color;
  $$('#edTools button').forEach(b => b.classList.toggle('active', b.dataset.tool === id));
  $$('#edColors button').forEach(b => b.classList.toggle('active', b.dataset.color === ed.color));
  edCanvas.style.cursor = id === 'select' ? 'default' : 'crosshair';
  updateHint(); drawEditor();
}
function updateHint() {
  const h = TOOL_HINTS[ed.tool];
  $('#edHint').textContent = Array.isArray(h) ? h[ed.pending ? ed.pending.pts.length : 0] : h;
}

// hit testing in screen px
function hitHandle(sp) {
  const shapes = ed.photo.shapes;
  for (let i = shapes.length - 1; i >= 0; i--) {
    const pts = shapes[i].pts;
    for (let j = 0; j < pts.length; j++) {
      const q = toScreen(pts[j]); if (Math.hypot(q[0] - sp[0], q[1] - sp[1]) < 9) return { i, j };
    }
  }
  return null;
}
function distSeg(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1]; const L = dx * dx + dy * dy;
  const t = L ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}
function hitBody(sp) {
  const shapes = ed.photo.shapes;
  for (let i = shapes.length - 1; i >= 0; i--) {
    const sh = shapes[i]; const pts = sh.pts.map(toScreen);
    if (sh.type === 'plumb') {
      const top = ed.ty, bottom = ed.ty + ed.photo.h * ed.s;
      if (Math.abs(sp[0] - pts[0][0]) < 6 && sp[1] >= top && sp[1] <= bottom) return i;
    } else if (sh.type === 'text') {
      if (sp[0] >= pts[0][0] - 4 && sp[0] <= pts[0][0] + 160 && Math.abs(sp[1] - pts[0][1]) < 12) return i;
    } else {
      for (let j = 0; j + 1 < pts.length; j++) if (distSeg(sp, pts[j], pts[j + 1]) < 6) return i;
    }
  }
  return -1;
}

function edPointerDown(e) {
  if (!ed.photo) return;
  const { screen, img } = toImg(e);
  edCanvas.setPointerCapture(e.pointerId);
  if (e.button === 2 || e.button === 1 || ed.space) {
    ed.pan = { x: e.clientX, y: e.clientY, tx: ed.tx, ty: ed.ty }; edCanvas.style.cursor = 'grabbing'; return;
  }
  if (e.button !== 0) return;

  if (ed.tool === 'select') {
    const h = hitHandle(screen);
    if (h) { snapshot(); ed.selected = h.i; ed.drag = { kind: 'handle', ...h }; drawEditor(); return; }
    const b = hitBody(screen);
    ed.selected = b;
    if (b >= 0) { snapshot(); ed.drag = { kind: 'body', i: b, last: img }; }
    drawEditor(); return;
  }

  const t = TOOLS.find(t => t.id === ed.tool);
  if (!ed.pending) ed.pending = { type: t.id, color: ed.color, pts: [] };
  ed.pending.pts.push(img);
  if (ed.pending.pts.length >= t.clicks) {
    const sh = ed.pending; ed.pending = null;
    if (sh.type === 'text') {
      const txt = prompt('ข้อความ:'); if (!txt) { updateHint(); drawEditor(); return; }
      sh.text = txt;
    }
    snapshot(); ed.photo.shapes.push(sh); ed.selected = ed.photo.shapes.length - 1;
  }
  updateHint(); drawEditor();
}
function edPointerMove(e) {
  if (!ed.photo) return;
  const { screen, img } = toImg(e);
  if (ed.pan) { ed.tx = ed.pan.tx + e.clientX - ed.pan.x; ed.ty = ed.pan.ty + e.clientY - ed.pan.y; drawEditor(); return; }
  if (ed.drag) {
    const sh = ed.photo.shapes[ed.drag.i];
    if (ed.drag.kind === 'handle') sh.pts[ed.drag.j] = img;
    else { const dx = img[0] - ed.drag.last[0], dy = img[1] - ed.drag.last[1]; sh.pts = sh.pts.map(p => [p[0] + dx, p[1] + dy]); ed.drag.last = img; }
    drawEditor(); return;
  }
  if (ed.tool === 'select') edCanvas.style.cursor = hitHandle(screen) ? 'move' : hitBody(screen) >= 0 ? 'pointer' : 'default';
  if (ed.pending) { ed.cursor = screen; drawEditor(); }
}
function edPointerUp() {
  if (ed.pan) { ed.pan = null; edCanvas.style.cursor = ed.tool === 'select' ? 'default' : 'crosshair'; }
  if (ed.drag) { ed.drag = null; drawEditor(); }
}
function edWheel(e) {
  e.preventDefault();
  const { screen } = toImg(e);
  const k = Math.exp(-e.deltaY * 0.0015);
  const ns = Math.max(0.05, Math.min(20, ed.s * k)); const r = ns / ed.s;
  ed.tx = screen[0] - (screen[0] - ed.tx) * r; ed.ty = screen[1] - (screen[1] - ed.ty) * r; ed.s = ns;
  drawEditor();
}
function deleteSelected() {
  if (ed.selected < 0) return;
  snapshot(); ed.photo.shapes.splice(ed.selected, 1); ed.selected = -1; drawEditor();
}

function renderMeasures() {
  const box = $('#edMeasures'); const m = measuresOf(ed.photo, SLOTS[ed.id].view);
  if (!m.length) { box.innerHTML = '<div class="none">ยังไม่มี — ใช้เครื่องมือเส้นระดับ, มุม หรือ Q-angle</div>'; return; }
  const key = JSON.stringify(m.map(x => x.txt)) + ed.selected;
  if (box.dataset.key === key) return; box.dataset.key = key;
  box.innerHTML = '';
  m.forEach(({ i, txt }) => {
    const row = document.createElement('div'); row.className = 'm';
    if (i === ed.selected) row.style.outline = '2px solid #00bcd4';
    const span = document.createElement('span'); span.textContent = txt;
    const b = document.createElement('button'); b.type = 'button'; b.textContent = '+ ใส่ในผลตรวจ';
    b.onclick = () => insertMeasure(txt);
    row.append(span, b); box.append(row);
  });
}
function insertMeasure(txt) {
  const cfg = SLOTS[ed.id];
  if (cfg.row) { state.findings[cfg.row].push(txt); renderFindings(cfg.row); }
  else {
    const cur = getPath(state, cfg.text) || '';
    setPath(state, cfg.text, cur ? cur + ', ' + txt : txt);
    $(`[data-bind-text="${cfg.text}"]`).innerText = getPath(state, cfg.text);
  }
  changed(); toast('เพิ่มในผลตรวจแล้ว');
}

function buildEditorUI() {
  $('#edTools').innerHTML = TOOLS.map(t => `<button type="button" data-tool="${t.id}">${t.label}<kbd>${t.key}</kbd></button>`).join('');
  $('#edColors').innerHTML = COLORS.map(c => `<button type="button" data-color="${c}" style="background:${c}" title="${c}"></button>`).join('');
  $('#edTools').onclick = e => { const b = e.target.closest('button'); if (b) setTool(b.dataset.tool); };
  $('#edColors').onclick = e => {
    const b = e.target.closest('button'); if (!b) return;
    ed.color = b.dataset.color;
    if (ed.selected >= 0) { snapshot(); ed.photo.shapes[ed.selected].color = ed.color; }
    if (ed.pending) ed.pending.color = ed.color;
    $$('#edColors button').forEach(x => x.classList.toggle('active', x === b)); drawEditor();
  };
  $('#edUndo').onclick = undo;
  $('#edDelete').onclick = deleteSelected;
  $('#edClear').onclick = () => { if (ed.photo.shapes.length && confirm('ลบจุดและเส้นทั้งหมดในรูปนี้?')) { snapshot(); ed.photo.shapes = []; ed.selected = -1; drawEditor(); } };
  $('#edFit').onclick = fitEditor;
  $('#edDone').onclick = closeEditor;

  edCanvas.addEventListener('pointerdown', edPointerDown);
  edCanvas.addEventListener('pointermove', edPointerMove);
  edCanvas.addEventListener('pointerup', edPointerUp);
  edCanvas.addEventListener('pointerleave', () => { ed.cursor = null; if (ed.pending) drawEditor(); });
  edCanvas.addEventListener('wheel', edWheel, { passive: false });
  edCanvas.addEventListener('contextmenu', e => e.preventDefault());
  edCanvas.addEventListener('dblclick', () => {
    const sh = ed.photo.shapes[ed.selected];
    if (ed.tool === 'select' && sh && sh.type === 'text') {
      const t = prompt('แก้ข้อความ:', sh.text); if (t != null) { snapshot(); sh.text = t; drawEditor(); }
    }
  });
  window.addEventListener('resize', () => { if (ed.id) drawEditor(); });

  document.addEventListener('keydown', e => {
    if (!ed.id) return;
    if (e.target.matches('input, textarea, [contenteditable="true"]')) return;
    if (e.key === ' ') { ed.space = true; e.preventDefault(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); return; }
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSelected(); return; }
    if (e.key === 'Escape') { if (ed.pending) { ed.pending = null; updateHint(); drawEditor(); } else closeEditor(); return; }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const t = TOOLS.find(t => t.key.toLowerCase() === e.key.toLowerCase()); if (t) setTool(t.id);
  });
  document.addEventListener('keyup', e => { if (e.key === ' ') ed.space = false; });
}

// ------------------------------------------------------------------ muscle chart (page 3)

const mc = { tool: 'tight', size: 12, stroke: null, tf: null, img: null };
const mCanvas = $('#muscleCanvas');

async function drawMuscle() {
  const W = mCanvas.clientWidth, H = mCanvas.clientHeight; if (!W || !H) return;
  const src = state.muscle.src || settings.chart;
  $('#muscleEmpty').hidden = !!src;
  if (!src) { mc.tf = null; mCanvas.width = mCanvas.width; return; }
  let img; try { img = await loadImage(src); } catch { return; }
  mc.img = img;
  const k = PRINT_SCALE;
  mCanvas.width = W * k; mCanvas.height = H * k;
  // shifted slightly left so the legend sits in the chart's empty lower-right corner, like the paper form
  const s = Math.min(W / img.naturalWidth, H / img.naturalHeight);
  mc.tf = { s, tx: (W - img.naturalWidth * s) / 2 - W * 0.07, ty: (H - img.naturalHeight * s) / 2 };
  const ctx = mCanvas.getContext('2d');
  ctx.setTransform(k, 0, 0, k, 0, 0);
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
  ctx.drawImage(img, mc.tf.tx, mc.tf.ty, img.naturalWidth * s, img.naturalHeight * s);

  // Each colour is painted opaque on its own layer, then laid over the chart translucently,
  // so overlapping brush strokes don't get darker.
  for (const type of ['tight', 'weak']) {
    const layer = document.createElement('canvas'); layer.width = mCanvas.width; layer.height = mCanvas.height;
    const lc = layer.getContext('2d'); lc.setTransform(k, 0, 0, k, 0, 0);
    lc.strokeStyle = lc.fillStyle = type === 'tight' ? '#3d7fd0' : '#e9cf3c';
    lc.lineCap = 'round'; lc.lineJoin = 'round';
    state.muscle.strokes.filter(st => st.type === type).forEach(st => {
      const pts = st.pts.map(p => [p[0] * s + mc.tf.tx, p[1] * s + mc.tf.ty]); const r = st.r * s;
      if (pts.length === 1) { lc.beginPath(); lc.arc(pts[0][0], pts[0][1], r, 0, Math.PI * 2); lc.fill(); return; }
      lc.lineWidth = r * 2; lc.beginPath(); pts.forEach((p, i) => (i ? lc.lineTo(...p) : lc.moveTo(...p))); lc.stroke();
    });
    ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 0.62; ctx.drawImage(layer, 0, 0); ctx.restore();
  }
}
function muscleImgPoint(e) {
  const r = mCanvas.getBoundingClientRect();
  return [(e.clientX - r.left - mc.tf.tx) / mc.tf.s, (e.clientY - r.top - mc.tf.ty) / mc.tf.s];
}
function eraseAt(p) {
  const before = state.muscle.strokes.length;
  state.muscle.strokes = state.muscle.strokes.filter(st => !st.pts.some(q => Math.hypot(q[0] - p[0], q[1] - p[1]) < st.r + mc.size / mc.tf.s * 0.5));
  return before !== state.muscle.strokes.length;
}
function bindMuscle() {
  $$('[data-mtool]').forEach(b => b.onclick = () => {
    mc.tool = b.dataset.mtool; $$('[data-mtool]').forEach(x => x.classList.toggle('active', x === b));
  });
  $('#brushSize').oninput = e => (mc.size = +e.target.value);
  $('#muscleUndo').onclick = () => { state.muscle.strokes.pop(); drawMuscle(); changed(); };
  $('#muscleClear').onclick = () => { if (state.muscle.strokes.length && confirm('ล้างสีทั้งหมดบนภาพกล้ามเนื้อ?')) { state.muscle.strokes = []; drawMuscle(); changed(); } };
  $('#muscleImage').onclick = $('#muscleEmpty').onclick = () => { $('#muscleFile').value = ''; $('#muscleFile').click(); };
  $('#muscleFile').onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    if (state.muscle.strokes.length && !confirm('เปลี่ยนภาพแล้วสีที่ระบายไว้จะถูกลบ ต้องการเปลี่ยนหรือไม่?')) return;
    const { src } = await fileToDataURL(f, 2000);
    state.muscle.src = src; state.muscle.strokes = []; drawMuscle(); changed();
    saveSettings({ chart: src }); // becomes the chart for new cases too
  };

  mCanvas.addEventListener('pointerdown', e => {
    if (e.button !== 0 || !mc.tf) return;
    mCanvas.setPointerCapture(e.pointerId);
    const p = muscleImgPoint(e);
    // pin the chart this case was painted on, so a later default-chart change can't misalign it
    if (!state.muscle.src) state.muscle.src = settings.chart;
    if (mc.tool === 'erase') { if (eraseAt(p)) drawMuscle(); mc.stroke = 'erase'; return; }
    mc.stroke = { type: mc.tool, r: mc.size / mc.tf.s, pts: [p] };
    state.muscle.strokes.push(mc.stroke); drawMuscle();
  });
  mCanvas.addEventListener('pointermove', e => {
    if (!mc.stroke) return;
    const p = muscleImgPoint(e);
    if (mc.stroke === 'erase') { if (eraseAt(p)) drawMuscle(); return; }
    const last = mc.stroke.pts[mc.stroke.pts.length - 1];
    if (Math.hypot(p[0] - last[0], p[1] - last[1]) > mc.stroke.r * 0.3) { mc.stroke.pts.push(p); drawMuscle(); }
  });
  const end = () => { if (mc.stroke) { mc.stroke = null; changed(); } };
  mCanvas.addEventListener('pointerup', end);
  mCanvas.addEventListener('pointercancel', end);
}

// ------------------------------------------------------------------ clinic settings (logo, default chart)
// Kept in the browser only, separate from the case, so they never end up in the repository.

let settings = { logo: null, chart: null };
async function saveSettings(patch) {
  Object.assign(settings, patch);
  try { await idbSet('settings', JSON.stringify(settings)); } catch { toast('บันทึกการตั้งค่าไม่ได้'); }
}
function renderLogo() {
  $$('.logo-slot').forEach(slot => {
    slot.innerHTML = '';
    if (settings.logo) {
      const img = document.createElement('img'); img.src = settings.logo; img.alt = 'โลโก้'; img.title = 'คลิกเพื่อเปลี่ยนหรือลบโลโก้';
      img.onclick = () => {
        if (confirm('เปลี่ยนโลโก้? (กด Cancel เพื่อเลือกลบโลโก้แทน)')) pickLogo();
        else if (confirm('ลบโลโก้ออก?')) { saveSettings({ logo: null }); renderLogo(); }
      };
      slot.append(img);
    } else {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'logo-add'; b.textContent = '+ ใส่โลโก้คลินิก';
      b.onclick = pickLogo; slot.append(b);
    }
  });
}
function pickLogo() {
  const input = document.createElement('input'); input.type = 'file'; input.accept = 'image/*';
  input.onchange = async () => {
    const f = input.files[0]; if (!f) return;
    // PNG keeps transparent logos transparent
    const src = await new Promise(res => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(f); });
    await saveSettings({ logo: src }); renderLogo();
  };
  input.click();
}

// ------------------------------------------------------------------ app

async function applyState(s) {
  state = s;
  state.findings ??= { row1: [], row2: [] };
  state.muscle ??= emptyCase().muscle;
  state.functional ??= { sls: '', squat: '' };
  fillFields();
  renderFindings('row1'); renderFindings('row2');
  Object.keys(SLOTS).forEach(renderSlot);
  drawMuscle();
}

function redrawAll() { Object.keys(SLOTS).forEach(drawSlot); drawMuscle(); }

async function init() {
  bindFields(); bindSlots(); buildEditorUI(); bindMuscle();

  $('#btnNew').onclick = async () => {
    if (!confirm('เริ่มเคสใหม่? ข้อมูลที่ยังไม่ได้ "บันทึกไฟล์" จะหายไป')) return;
    await applyState(emptyCase()); changed();
  };
  $('#btnSave').onclick = saveFile;
  $('#btnOpen').onclick = () => { $('#fileOpen').value = ''; $('#fileOpen').click(); };
  $('#fileOpen').onchange = e => { const f = e.target.files[0]; if (f) openFile(f); };
  $('#btnPrint').onclick = () => window.print();
  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); saveFile(); }
  });

  try { const st = await idbGet('settings'); if (st) Object.assign(settings, JSON.parse(st)); } catch { /* no settings yet */ }
  renderLogo();

  let saved = null;
  try { saved = await idbGet('current'); } catch { /* storage unavailable: start blank */ }
  let s = emptyCase();
  if (saved) { try { s = Object.assign(emptyCase(), JSON.parse(saved)); } catch { /* ignore corrupt autosave */ } }
  await applyState(s);
  if (document.fonts) document.fonts.ready.then(redrawAll);

  let rt; window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(redrawAll, 150); });
}

init();
})();
