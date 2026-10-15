/* Posture Analysis
 * Local, single-page report builder. Everything stays in the browser:
 * the working case is autosaved to IndexedDB and can be exported/imported as a .json file.
 */
(() => {
'use strict';

// ------------------------------------------------------------------ config

const APP_VERSION = '__APP_VERSION__'; // stamped with the commit on deploy

// Public half of the seller's license signing key (ECDSA P-256, JWK). Licenses are signed with the
// private half in tools/license-admin.html and verified here, offline. null = every copy runs as a trial.
const LICENSE_PUBLIC_KEY = null;

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
  { id: 'dashed', label: 'เส้นตรง',     key: 'D', color: '#f4c20d', clicks: 2 },
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

function newId() {
  return (crypto.randomUUID && crypto.randomUUID()) || Date.now().toString(36) + Math.random().toString(36).slice(2);
}
function emptyCase() {
  return {
    version: 1,
    id: newId(),
    fileName: null,                    // name of this case's file in the chosen folder, once saved there
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

const hhmm = () => new Date().toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });
let saveTimer, folderTimer, dirty = false, folderWritePending = false;
function setStatus(t) { $('#saveStatus').textContent = t; }

// Every edit: keep a working copy in the browser right away, and (once the case has a file in
// the chosen folder) write that file too, a little later so typing doesn't cause constant writes.
function changed() {
  dirty = true;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try { await idbSet('current', JSON.stringify(state)); }
    catch { setStatus('บันทึกสำรองในเบราว์เซอร์ไม่ได้ — กรุณากด "บันทึก"'); }
  }, 400);
  if (state.fileName && folder.perm === 'granted') {
    folderWritePending = true; setStatus('กำลังบันทึก…');
    clearTimeout(folderTimer);
    folderTimer = setTimeout(() => saveCase({ auto: true }), 1500);
  } else {
    setStatus(folder.handle ? 'ยังไม่ได้บันทึกลงโฟลเดอร์ — กด "บันทึก"' : 'ยังไม่ได้บันทึกเป็นไฟล์');
  }
}

function caseFileName() {
  const p = state.patient;
  const parts = [p.cn, p.name, p.lastname, p.date].filter(Boolean).join('_') || 'posture';
  return parts.replace(/[\\/:*?"<>|\s]+/g, '-').slice(0, 120) + '.json';
}
// Fallback for file systems that refuse non-ASCII names: CN + date + short id.
function asciiFileName() {
  const p = state.patient;
  const base = [p.cn, p.date].filter(Boolean).join('_').replace(/[^A-Za-z0-9._-]+/g, '-') || 'posture';
  return `${base}_${state.id.slice(0, 6)}.json`;
}
function caseHasContent() {
  const p = state.patient;
  return !!(p.name || p.lastname || p.cn || Object.keys(state.photos).length || state.impression || state.muscle.strokes.length);
}
function downloadCase() {
  const blob = new Blob([JSON.stringify(state)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = caseFileName();
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  dirty = false; setStatus('ดาวน์โหลดไฟล์แล้ว ' + hhmm());
}

function parseCase(text) {
  const data = JSON.parse(text);
  if (!data || typeof data !== 'object' || !data.patient) throw new Error('not a case file');
  const s = Object.assign(emptyCase(), data);
  s.id ??= newId();
  return s;
}
async function loadCase(text, fileName) {
  let s;
  try { s = parseCase(text); } catch { toast('เปิดไฟล์ไม่ได้ — ไฟล์ไม่ใช่ไฟล์เคสของระบบนี้'); return false; }
  s.fileName = fileName || null;
  await applyState(s);
  dirty = false;
  try { await idbSet('current', JSON.stringify(state)); } catch { /* best effort */ }
  setStatus(fileName ? 'เปิดจากโฟลเดอร์: ' + fileName : 'เปิดไฟล์แล้ว (ยังไม่อยู่ในโฟลเดอร์ — กด "บันทึก" เพื่อเก็บลงโฟลเดอร์)');
  return true;
}

// Before replacing the current case: flush it to its file, or confirm discarding an unsaved one.
async function leaveCurrentCase() {
  if (state.fileName && folder.perm === 'granted') { if (dirty || folderWritePending) await saveCase({ auto: true }); return true; }
  if (dirty && caseHasContent()) return confirm('เคสปัจจุบันยังไม่ได้บันทึกเป็นไฟล์ ต้องการทิ้งข้อมูลเคสนี้หรือไม่?');
  return true;
}

// ------------------------------------------------------------------ case folder (File System Access API)
// Chrome/Edge on a computer can read and write a folder the user picks. Other browsers fall back
// to downloading/opening .json files by hand.

const FS_OK = 'showDirectoryPicker' in window;
const folder = { handle: null, perm: 'none' };

async function loadFolder() {
  if (!FS_OK) return;
  try {
    folder.handle = (await idbGet('folder')) || null;
    if (folder.handle) folder.perm = await folder.handle.queryPermission({ mode: 'readwrite' });
  } catch { folder.handle = null; }
}
async function chooseFolder() {
  if (!FS_OK) { toast('เลือกโฟลเดอร์ได้เฉพาะ Chrome หรือ Edge บนคอมพิวเตอร์'); return false; }
  try {
    const h = await window.showDirectoryPicker({ id: 'posture-cases', mode: 'readwrite', startIn: 'documents' });
    folder.handle = h; folder.perm = 'granted';
    await idbSet('folder', h);
    renderFolder(); toast('ตั้งที่เก็บไฟล์เป็นโฟลเดอร์ "' + h.name + '" แล้ว');
    return true;
  } catch (e) {
    if (e.name !== 'AbortError') toast('เลือกโฟลเดอร์ไม่ได้: ' + e.message);
    return false;
  }
}
// Must run from a click: browsers only show the permission prompt in response to the user.
async function ensurePermission() {
  if (!folder.handle) return false;
  if (folder.perm === 'granted') return true;
  try { folder.perm = await folder.handle.requestPermission({ mode: 'readwrite' }); } catch { folder.perm = 'denied'; }
  renderFolder();
  return folder.perm === 'granted';
}
async function fileExists(name) {
  try { await folder.handle.getFileHandle(name); return true; } catch { return false; }
}
async function uniqueName(want, mine) {
  if (want === mine || !(await fileExists(want))) return want;
  const base = want.replace(/\.json$/, '');
  for (let i = 2; ; i++) { const n = `${base}-${i}.json`; if (n === mine || !(await fileExists(n))) return n; }
}
async function writeFile(name, text) {
  const fh = await folder.handle.getFileHandle(name, { create: true });
  const w = await fh.createWritable(); // written to a temporary file and swapped in on close
  await w.write(text); await w.close();
}

async function saveCase({ auto = false } = {}) {
  clearTimeout(folderTimer);
  if (!FS_OK || !folder.handle) {
    folderWritePending = false;
    if (auto) return;
    if (FS_OK && confirm('ยังไม่ได้ตั้งโฟลเดอร์เก็บไฟล์\nตั้งตอนนี้เลยไหม? (กด Cancel เพื่อดาวน์โหลดเป็นไฟล์แทน)')) {
      if (await chooseFolder()) return saveCase();
    }
    downloadCase(); return;
  }
  if (auto ? folder.perm !== 'granted' : !(await ensurePermission())) {
    folderWritePending = false;
    if (!auto) toast('ไม่ได้รับอนุญาตให้บันทึกลงโฟลเดอร์');
    renderFolder(); return;
  }
  try {
    const old = state.fileName;
    // a manual save renames the file when CN/name/date changed; autosave keeps the current name
    let name = old && auto ? old : await uniqueName(caseFileName(), old);
    state.fileName = name; state.savedAt = new Date().toISOString();
    try { await writeFile(name, JSON.stringify(state)); }
    catch (e) {
      if (name === old || !/[^\x00-\x7f]/.test(name)) throw e;
      name = await uniqueName(asciiFileName(), old); state.fileName = name;
      await writeFile(name, JSON.stringify(state));
    }
    if (old && old !== name) { try { await folder.handle.removeEntry(old); } catch { /* already gone */ } }
    dirty = false; folderWritePending = false;
    try { await idbSet('current', JSON.stringify(state)); } catch { /* best effort */ }
    setStatus('บันทึกลงโฟลเดอร์แล้ว ' + hhmm());
    if (!auto) toast('บันทึกแล้ว: ' + folder.handle.name + ' / ' + name);
  } catch (e) {
    folderWritePending = false;
    setStatus('บันทึกลงโฟลเดอร์ไม่สำเร็จ');
    toast('บันทึกไม่สำเร็จ: ' + e.message, 5000);
  }
}

function renderFolder() {
  const chip = $('#btnFolder');
  chip.className = 'folder-chip';
  if (!FS_OK) { chip.textContent = '📄 บันทึกเป็นไฟล์ดาวน์โหลด'; chip.title = 'เบราว์เซอร์นี้เลือกโฟลเดอร์ไม่ได้ ใช้ Chrome หรือ Edge'; return; }
  if (!folder.handle) { chip.textContent = '📁 ยังไม่ได้ตั้งที่เก็บไฟล์'; chip.classList.add('warn'); chip.title = 'คลิกเพื่อเลือกโฟลเดอร์เก็บไฟล์เคส'; return; }
  if (folder.perm !== 'granted') { chip.textContent = '📁 คลิกเพื่ออนุญาต: ' + folder.handle.name; chip.classList.add('warn'); chip.title = 'เบราว์เซอร์ต้องขออนุญาตเข้าโฟลเดอร์ทุกครั้งที่เปิดใหม่'; return; }
  chip.textContent = '📁 ' + folder.handle.name; chip.classList.add('ok'); chip.title = 'โฟลเดอร์เก็บไฟล์เคส — คลิกเพื่อดูรายการเคส';
}
async function onFolderChip() {
  if (!FS_OK) return openSettings();
  if (!folder.handle) return chooseFolder();
  if (folder.perm !== 'granted') { if (await ensurePermission()) toast('อนุญาตโฟลเดอร์แล้ว'); return; }
  openCases();
}

// ---- case list
let caseItems = [];
async function openCases() {
  const dlg = $('#casesDlg'); if (!dlg.open) dlg.showModal();
  const body = $('#casesBody');
  if (!FS_OK) {
    body.innerHTML = '<div class="cases-msg">เบราว์เซอร์นี้เปิดรายการเคสจากโฟลเดอร์ไม่ได้ (ใช้ได้ใน Chrome หรือ Edge บนคอมพิวเตอร์)<br>กด "เปิดจากไฟล์อื่น…" เพื่อเลือกไฟล์ .json ของเคส</div>';
    return;
  }
  if (!folder.handle) {
    body.innerHTML = '<div class="cases-empty">ยังไม่ได้ตั้งโฟลเดอร์เก็บไฟล์เคส<br><button type="button" class="primary" id="casesPick">เลือกโฟลเดอร์</button></div>';
    $('#casesPick').onclick = async () => { if (await chooseFolder()) openCases(); };
    return;
  }
  if (folder.perm !== 'granted') {
    body.innerHTML = `<div class="cases-empty">ต้องอนุญาตให้เข้าโฟลเดอร์ "${esc(folder.handle.name)}" ก่อน<br><button type="button" class="primary" id="casesAllow">อนุญาต</button></div>`;
    $('#casesAllow').onclick = async () => { if (await ensurePermission()) openCases(); };
    return;
  }
  body.innerHTML = '<div class="cases-empty">กำลังอ่านรายการเคส…</div>';
  caseItems = [];
  try {
    for await (const [name, h] of folder.handle.entries()) {
      if (h.kind !== 'file' || !name.toLowerCase().endsWith('.json')) continue;
      const f = await h.getFile();
      caseItems.push({ name, h, time: f.lastModified });
    }
  } catch (e) { body.innerHTML = `<div class="cases-empty">อ่านโฟลเดอร์ไม่ได้: ${esc(e.message)}</div>`; return; }
  caseItems.sort((a, b) => b.time - a.time);
  body.innerHTML = `<input type="search" class="cases-search" id="casesSearch" placeholder="ค้นหา CN หรือชื่อ (${caseItems.length} เคส ใน ${esc(folder.handle.name)})"><div class="cases-list" id="casesList"></div>`;
  $('#casesSearch').oninput = renderCaseList;
  renderCaseList(); $('#casesSearch').focus();
}
function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function renderCaseList() {
  const q = ($('#casesSearch')?.value || '').trim().toLowerCase();
  const list = $('#casesList');
  const items = caseItems.filter(it => !q || it.name.toLowerCase().includes(q));
  if (!items.length) { list.innerHTML = `<div class="cases-empty">${caseItems.length ? 'ไม่พบเคสที่ค้นหา' : 'ยังไม่มีเคสในโฟลเดอร์นี้'}</div>`; return; }
  list.innerHTML = '';
  items.slice(0, 500).forEach(it => {
    const parts = it.name.replace(/\.json$/i, '').split('_');
    const b = document.createElement('button'); b.type = 'button'; b.className = 'case-item' + (it.name === state.fileName ? ' current' : '');
    b.innerHTML = `<span class="c-main">${esc(parts.slice(0, 3).join('  '))}</span>
      <span class="c-time">${new Date(it.time).toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short' })}</span>
      <span class="c-sub">${esc(parts.slice(3).join(' ') || it.name)}</span>`;
    b.onclick = async () => {
      if (it.name === state.fileName) { $('#casesDlg').close(); return; }
      if (!(await leaveCurrentCase())) return;
      if (await loadCase(await (await it.h.getFile()).text(), it.name)) $('#casesDlg').close();
    };
    list.append(b);
  });
}
async function openFromFile() {
  if (!(await leaveCurrentCase())) return;
  if (!window.showOpenFilePicker) { $('#fileOpen').value = ''; $('#fileOpen').click(); return; }
  let fh;
  try { [fh] = await window.showOpenFilePicker({ id: 'posture-cases', types: [{ description: 'ไฟล์เคส Posture', accept: { 'application/json': ['.json'] } }] }); }
  catch { return; }
  // a file that sits directly in the case folder keeps saving to itself
  let inFolder = null;
  if (folder.handle && folder.perm === 'granted') { try { const p = await folder.handle.resolve(fh); if (p && p.length === 1) inFolder = p[0]; } catch { /* other location */ } }
  if (await loadCase(await (await fh.getFile()).text(), inFolder)) $('#casesDlg').close();
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
    el.addEventListener('input', () => { setPath(state, el.dataset.bindText, readEditable(el)); fitText(el); changed(); });
    el.addEventListener('paste', plainPaste);
  });
}
// <input type=date> prints in the browser's format with a calendar icon; print a Thai date instead.
function updatePrintDate() {
  const v = state.patient.date; let txt = '';
  if (v) { const [y, m, d] = v.split('-').map(Number); txt = new Date(y, m - 1, d).toLocaleDateString('th-TH', { day: '2-digit', month: '2-digit', year: 'numeric' }); }
  $$('.date-print').forEach(el => (el.textContent = txt));
}
// Shrink the font of a fixed-height box until its text fits (11pt down to 6.5pt).
const FIT_MAX = 11, FIT_MIN = 6.5;
function fitText(el) {
  let size = FIT_MAX;
  el.style.fontSize = size + 'pt';
  while (el.scrollHeight > el.clientHeight + 1 && size > FIT_MIN) {
    size -= 0.5; el.style.fontSize = size + 'pt';
  }
  el.classList.toggle('overfull', el.scrollHeight > el.clientHeight + 1);
}
function fitAll() { $$('[data-bind-text]').forEach(fitText); }
function readEditable(el) { return el.innerText.replace(/\n$/, ''); }
function plainPaste(e) {
  e.preventDefault();
  document.execCommand('insertText', false, (e.clipboardData || window.clipboardData).getData('text/plain'));
}
function fillFields() {
  $$('[data-bind]').forEach(el => { el.value = getPath(state, el.dataset.bind) ?? ''; });
  updatePrintDate();
  $$('[data-bind-text]').forEach(el => { el.innerText = getPath(state, el.dataset.bindText) ?? ''; });
  fitAll();
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
      case 'dashed': // drawn solid now; the id is kept so saved cases still open
        ctx.lineWidth = 2.6 * u;
        ctx.beginPath(); ctx.moveTo(...pts[0]); ctx.lineTo(...pts[1]); ctx.stroke();
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
    else ed.press = { x: e.clientX, y: e.clientY, tx: ed.tx, ty: ed.ty, img: null }; // empty space: drag to pan
    drawEditor(); return;
  }
  // drawing tools: decide on release — a click places a point, a drag pans the photo
  ed.press = { x: e.clientX, y: e.clientY, tx: ed.tx, ty: ed.ty, img };
}
function placePoint(img) {
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
  if (ed.press && !ed.pan && Math.hypot(e.clientX - ed.press.x, e.clientY - ed.press.y) > 4) {
    ed.pan = ed.press; ed.press = null; edCanvas.style.cursor = 'grabbing';
  }
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
  if (ed.press) { const p = ed.press; ed.press = null; if (p.img) placePoint(p.img); }
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
    const box = $(`[data-bind-text="${cfg.text}"]`); box.innerText = getPath(state, cfg.text); fitText(box);
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
  edCanvas.addEventListener('pointercancel', () => { ed.press = null; edPointerUp(); });
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
      if (st.shape === 'ellipse') {
        const e = ellipseOf(pts[0], pts[pts.length - 1], r);
        lc.beginPath(); lc.ellipse(e.cx, e.cy, e.rx, e.ry, e.rot, 0, Math.PI * 2); lc.fill(); return;
      }
      if (pts.length === 1) { lc.beginPath(); lc.arc(pts[0][0], pts[0][1], r, 0, Math.PI * 2); lc.fill(); return; }
      // quadratic curves through the midpoints give a smooth line instead of a jagged polyline
      lc.lineWidth = r * 2; lc.beginPath(); lc.moveTo(...pts[0]);
      for (let i = 1; i < pts.length - 1; i++) {
        lc.quadraticCurveTo(pts[i][0], pts[i][1], (pts[i][0] + pts[i + 1][0]) / 2, (pts[i][1] + pts[i + 1][1]) / 2);
      }
      lc.lineTo(...pts[pts.length - 1]); lc.stroke();
    });
    ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 0.62;
    ctx.filter = `blur(${0.7 * k}px)`; // soft edge so the colour blends into the chart
    ctx.drawImage(layer, 0, 0); ctx.restore();
  }
}
function muscleImgPoint(e) {
  const r = mCanvas.getBoundingClientRect();
  return [(e.clientX - r.left - mc.tf.tx) / mc.tf.s, (e.clientY - r.top - mc.tf.ty) / mc.tf.s];
}
// An oval drawn along the drag: its long axis follows the muscle, its width is the brush size.
function ellipseOf(a, b, r) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  return { cx: (a[0] + b[0]) / 2, cy: (a[1] + b[1]) / 2, rx: Math.max(Math.hypot(dx, dy) / 2, r), ry: r, rot: Math.atan2(dy, dx) };
}
function hitsStroke(st, p, pad) {
  if (st.shape === 'ellipse') {
    const e = ellipseOf(st.pts[0], st.pts[st.pts.length - 1], st.r);
    const c = Math.cos(-e.rot), s = Math.sin(-e.rot), x = p[0] - e.cx, y = p[1] - e.cy;
    const u = x * c - y * s, v = x * s + y * c;
    return (u * u) / ((e.rx + pad) ** 2) + (v * v) / ((e.ry + pad) ** 2) <= 1;
  }
  return st.pts.some(q => Math.hypot(q[0] - p[0], q[1] - p[1]) < st.r + pad);
}
function eraseAt(p) {
  const before = state.muscle.strokes.length;
  state.muscle.strokes = state.muscle.strokes.filter(st => !hitsStroke(st, p, mc.size / mc.tf.s * 0.5));
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
    // drag along the muscle to draw an oval (the free brush was removed; old brush strokes still render)
    mc.stroke = { type: mc.tool, shape: 'ellipse', r: mc.size / mc.tf.s, pts: [p, p] };
    state.muscle.strokes.push(mc.stroke); drawMuscle();
  });
  mCanvas.addEventListener('pointermove', e => {
    if (!mc.stroke) return;
    if (mc.stroke === 'erase') { if (eraseAt(muscleImgPoint(e))) drawMuscle(); return; }
    mc.stroke.pts[1] = muscleImgPoint(e); drawMuscle();
  });
  const end = () => {
    if (!mc.stroke) return;
    mc.stroke = null; changed();
  };
  mCanvas.addEventListener('pointerup', end);
  mCanvas.addEventListener('pointercancel', end);
}

// ------------------------------------------------------------------ clinic settings (logo, default chart)
// Kept in the browser only, separate from the case, so they never end up in the repository.

let settings = { logo: null, chart: null, therapist: '', license: null };
async function saveSettings(patch) {
  Object.assign(settings, patch);
  try { await idbSet('settings', JSON.stringify(settings)); } catch { toast('บันทึกการตั้งค่าไม่ได้'); }
}
function renderLogo() {
  $$('.logo-slot').forEach(slot => {
    slot.innerHTML = '';
    if (settings.logo) {
      const img = document.createElement('img'); img.src = settings.logo; img.alt = 'โลโก้'; img.title = 'คลิกเพื่อเปลี่ยนหรือลบโลโก้';
      img.title = 'คลิกเพื่อเปลี่ยนโลโก้ (ตั้งค่า)'; img.onclick = openSettings;
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
    await saveSettings({ logo: src }); renderLogo(); renderSettings();
  };
  input.click();
}

function openSettings() { renderSettings(); const d = $('#settingsDlg'); if (!d.open) d.showModal(); }
function renderSettings() {
  $('#setFolderInfo').textContent = !FS_OK ? 'เบราว์เซอร์นี้เลือกโฟลเดอร์ไม่ได้ (ใช้ Chrome หรือ Edge) — ไฟล์เคสจะดาวน์โหลดไปที่โฟลเดอร์ Downloads'
    : folder.handle ? `โฟลเดอร์ "${folder.handle.name}"${folder.perm === 'granted' ? '' : ' (ต้องกดอนุญาตอีกครั้ง)'} · เคสบันทึกอัตโนมัติลงโฟลเดอร์นี้`
    : 'ยังไม่ได้เลือก — เลือกโฟลเดอร์ในเครื่อง (เช่น Documents/Posture Cases) เพื่อเก็บไฟล์เคสทั้งหมด';
  $('#setFolder').textContent = folder.handle ? 'เปลี่ยนโฟลเดอร์' : 'เลือกโฟลเดอร์';
  $('#setFolder').disabled = !FS_OK;
  $('#setLogoPreview').src = settings.logo || '';
  $('#setLogoRemove').disabled = !settings.logo;
  $('#setTherapist').value = settings.therapist || '';
  $('#appVersion').textContent = APP_VERSION.startsWith('__') ? 'dev' : APP_VERSION;
  $('#offlineState').textContent = navigator.serviceWorker?.controller ? 'พร้อมใช้งานออฟไลน์ ✓' : 'ยังไม่พร้อมใช้ออฟไลน์ (ต้องเปิดผ่านเว็บอย่างน้อย 1 ครั้ง)';
}
function bindSettings() {
  $$('[data-close]').forEach(b => b.onclick = () => b.closest('dialog').close());
  $('#setFolder').onclick = async () => { if (await chooseFolder()) renderSettings(); };
  $('#setLogo').onclick = pickLogo;
  $('#setLogoRemove').onclick = async () => { await saveSettings({ logo: null }); renderLogo(); renderSettings(); };
  $('#setChart').onclick = () => { $('#muscleFile').value = ''; $('#muscleFile').click(); };
  $('#setTherapist').onchange = e => saveSettings({ therapist: e.target.value.trim() });
  $('#btnSettings').onclick = openSettings;
  $('#btnFolder').onclick = onFolderChip;
  $('#casesFromFile').onclick = openFromFile;
}

// ------------------------------------------------------------------ license (offline, signed)
// Key format: "PA1-" + base64url(JSON payload) + "." + base64url(ECDSA P-256 / SHA-256 signature).
// Payload: { v: 1, id, clinic, iss: 'YYYY-MM-DD', exp: 'YYYY-MM-DD' | null }.
// Unlicensed or expired copies keep every feature but print with a "trial" watermark.

let license = null; // verified payload, or null

const b64uDecode = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), c => c.charCodeAt(0));
function publicKeyJwk() {
  // tests run on localhost with their own key pair
  if (window.__TEST_LICENSE_PUBLIC_KEY__ && ['localhost', '127.0.0.1'].includes(location.hostname)) return window.__TEST_LICENSE_PUBLIC_KEY__;
  return LICENSE_PUBLIC_KEY;
}
async function verifyLicense(text) {
  const key = String(text || '').replace(/\s+/g, '');
  const m = /^PA1-([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(key);
  if (!m) return { ok: false, reason: 'รูปแบบ license ไม่ถูกต้อง' };
  const jwk = publicKeyJwk();
  if (!jwk || !crypto.subtle) return { ok: false, reason: 'โปรแกรมนี้ยังไม่ได้ตั้งค่าการตรวจ license' };
  let payload;
  try {
    const pub = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    const good = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, b64uDecode(m[2]), new TextEncoder().encode(m[1]));
    if (!good) return { ok: false, reason: 'license ไม่ถูกต้อง (ลายเซ็นไม่ตรง)' };
    payload = JSON.parse(new TextDecoder().decode(b64uDecode(m[1])));
  } catch { return { ok: false, reason: 'license ไม่ถูกต้อง' }; }
  if (payload.v !== 1 || !payload.clinic) return { ok: false, reason: 'license ไม่ถูกต้อง' };
  if (payload.exp && payload.exp < todayISO()) return { ok: false, expired: true, payload, reason: `license หมดอายุแล้วเมื่อ ${thDate(payload.exp)}` };
  return { ok: true, payload };
}
function thDate(iso) { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d).toLocaleDateString('th-TH', { dateStyle: 'medium' }); }

async function loadLicense() {
  license = null;
  let note = '';
  if (settings.license) {
    const r = await verifyLicense(settings.license);
    if (r.ok) license = r.payload; else note = r.reason;
  }
  renderLicense(note);
  if (license?.exp) {
    const days = Math.ceil((new Date(license.exp) - new Date(todayISO())) / 86400000);
    if (days <= 30) toast(`license จะหมดอายุใน ${days} วัน (${thDate(license.exp)})`, 6000);
  }
}
function renderLicense(note = '') {
  document.body.classList.toggle('trial', !license);
  const chip = $('#btnLicense');
  chip.hidden = !!license;
  chip.textContent = note.includes('หมดอายุ') ? 'License หมดอายุ' : 'ทดลองใช้ — ใส่ license';
  $$('.page-foot').forEach(f => (f.textContent = license ? `ใช้งานภายใต้ license: ${license.clinic}` : 'ฉบับทดลอง — ยังไม่ได้ลงทะเบียน license'));
  $('#setLicenseInfo').textContent = license
    ? `${license.clinic} · ${license.exp ? 'ใช้ได้ถึง ' + thDate(license.exp) : 'ไม่มีวันหมดอายุ'} · รหัส ${license.id}`
    : (note || 'ยังไม่ได้ใส่ license — รายงานที่พิมพ์จะมีลายน้ำ "ฉบับทดลอง"');
  $('#setLicense').textContent = license ? 'เปลี่ยน license' : 'ใส่ license';
  $('#setLicenseRemove').disabled = !settings.license;
}
function openLicense() {
  $('#licenseText').value = ''; $('#licenseMsg').textContent = ''; $('#licenseMsg').className = 'lic-msg';
  const d = $('#licenseDlg'); if (!d.open) d.showModal();
  $('#licenseText').focus();
}
function bindLicense() {
  $('#btnLicense').onclick = openLicense;
  $('#setLicense').onclick = openLicense;
  $('#setLicenseRemove').onclick = async () => {
    if (!confirm('ลบ license ออกจากเครื่องนี้? รายงานจะกลับไปมีลายน้ำ "ฉบับทดลอง"')) return;
    await saveSettings({ license: null }); await loadLicense();
  };
  $('#licenseFile').onclick = () => {
    const input = document.createElement('input'); input.type = 'file'; input.accept = '.license,.txt';
    input.onchange = async () => { const f = input.files[0]; if (f) $('#licenseText').value = (await f.text()).trim(); };
    input.click();
  };
  $('#licenseApply').onclick = async () => {
    const msg = $('#licenseMsg');
    const r = await verifyLicense($('#licenseText').value);
    if (!r.ok) { msg.textContent = r.reason; msg.className = 'lic-msg err'; return; }
    await saveSettings({ license: $('#licenseText').value.replace(/\s+/g, '') });
    await loadLicense();
    msg.textContent = `ลงทะเบียนแล้ว: ${r.payload.clinic}`; msg.className = 'lic-msg ok';
    setTimeout(() => $('#licenseDlg').close(), 900);
    renderSettings();
  };
}

// ------------------------------------------------------------------ offline app (service worker) & install

function setupPWA() {
  if (!('serviceWorker' in navigator) || !location.protocol.startsWith('http')) return;
  // Reload only when the user accepted an update; the very first install also fires
  // controllerchange (clients.claim) and must not reload a page someone is working in.
  let updateAccepted = false, reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (updateAccepted && !reloading) { reloading = true; location.reload(); }
  });
  navigator.serviceWorker.register('sw.js').then(reg => {
    const offer = w => {
      $('#updateBar').hidden = false;
      $('#btnUpdate').onclick = async () => {
        if (state.fileName && (dirty || folderWritePending)) await saveCase({ auto: true });
        updateAccepted = true; w.postMessage('skipWaiting');
      };
    };
    if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      w.addEventListener('statechange', () => { if (w.state === 'installed' && navigator.serviceWorker.controller) offer(w); });
    });
    setInterval(() => reg.update().catch(() => {}), 60 * 60 * 1000);
  }).catch(() => { /* offline support unavailable; the app still works online */ });

  let deferred = null;
  window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferred = e; $('#btnInstall').hidden = false; });
  $('#btnInstall').onclick = async () => { if (!deferred) return; deferred.prompt(); await deferred.userChoice; deferred = null; $('#btnInstall').hidden = true; };
  window.addEventListener('appinstalled', () => { $('#btnInstall').hidden = true; toast('ติดตั้งแอปแล้ว เปิดได้จากเดสก์ท็อปหรือเมนู Start'); });
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
  window.addEventListener('error', e => toast('เกิดข้อผิดพลาด: ' + (e.message || e.error), 5000));
  window.addEventListener('unhandledrejection', e => toast('เกิดข้อผิดพลาด: ' + (e.reason?.message || e.reason), 5000));
  bindFields(); bindSlots(); buildEditorUI(); bindMuscle(); bindSettings(); bindLicense(); setupPWA();

  $('#btnNew').onclick = async () => {
    if (!(await leaveCurrentCase())) return;
    const s = emptyCase(); s.patient.therapist = settings.therapist || '';
    await applyState(s); dirty = false;
    try { await idbSet('current', JSON.stringify(state)); } catch { /* best effort */ }
    setStatus('เคสใหม่');
  };
  $('#btnSave').onclick = () => saveCase();
  $('#btnOpen').onclick = openCases;
  $('#fileOpen').onchange = async e => { const f = e.target.files[0]; if (f && await loadCase(await f.text(), null)) $('#casesDlg').close(); };
  $('#btnPrint').onclick = () => window.print();
  window.addEventListener('beforeprint', () => document.activeElement?.blur?.()); // no text cursor in the PDF
  document.addEventListener('keydown', e => {
    if (!(e.ctrlKey || e.metaKey)) return;
    const k = e.key.toLowerCase();
    if (k === 's') { e.preventDefault(); saveCase(); }
    if (k === 'o') { e.preventDefault(); openCases(); }
  });
  // don't close the tab while a write to the case folder is still waiting
  window.addEventListener('beforeunload', e => { if (folderWritePending) { e.preventDefault(); e.returnValue = ''; } });
  // ask the browser not to evict the working copy when the disk gets full
  navigator.storage?.persist?.().catch(() => {});

  try { const st = await idbGet('settings'); if (st) Object.assign(settings, JSON.parse(st)); } catch { /* no settings yet */ }
  renderLogo();
  await loadLicense();
  await loadFolder(); renderFolder();

  let saved = null;
  try { saved = await idbGet('current'); } catch { /* storage unavailable: start blank */ }
  let s = emptyCase();
  if (saved) { try { s = Object.assign(emptyCase(), JSON.parse(saved)); } catch { /* ignore corrupt autosave */ } }
  await applyState(s);
  setStatus(state.fileName ? 'ไฟล์: ' + state.fileName : '');
  if (document.fonts) document.fonts.ready.then(() => { redrawAll(); fitAll(); });

  let rt; window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(redrawAll, 150); });
}

init();
})();
