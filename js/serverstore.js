/* Clinic-server storage: when the app is served by server/posture_server.py, cases live in one
 * folder on that server instead of a folder on each computer.
 *
 * ServerDir mimics the small part of FileSystemDirectoryHandle that app.js uses
 * (getFileHandle / entries / removeEntry / createWritable / permissions), so the existing
 * save, open, backup and restore code runs unchanged on top of it.
 *
 * Two computers editing the same case: every write sends the file's version (mtime) that this
 * browser last saw; the server refuses with 409 if someone else saved in between, and the user
 * is told instead of silently losing the other computer's work. */
(() => {
const API = 'api/';
const MODE_KEY = 'posture-server-mode';
const SEEN_KEY = 'posture-server-seen';
const HDR = { 'X-Posture': '1' };

const seen = (() => { try { return JSON.parse(localStorage.getItem(SEEN_KEY) || '{}'); } catch { return {}; } })();
function remember(name, mtime) {
  if (mtime == null) delete seen[name]; else seen[name] = mtime;
  try { localStorage.setItem(SEEN_KEY, JSON.stringify(seen)); } catch { /* storage full: keep in memory */ }
}

async function call(path, opts = {}) {
  let r;
  try { r = await fetch(API + path, { cache: 'no-store', ...opts }); }
  catch { throw new Error('ติดต่อเครื่องกลางไม่ได้ (ตรวจสายแลน/เครื่อง .63)'); }
  return r;
}
function fail(r, what) {
  const e = new Error(`${what}ไม่สำเร็จ (รหัส ${r.status})`);
  if (r.status === 404) e.name = 'NotFoundError';
  return e;
}
const enc = p => encodeURIComponent(p);

class ServerFile {
  constructor(name, size, mtime) { this.kind = 'file'; this.name = name; this._size = size; this._mtime = mtime; }
  async getFile() {
    const r = await call('cases/' + enc(this.name));
    if (!r.ok) throw fail(r, 'อ่านเคส');
    const buf = await r.arrayBuffer();
    const mt = +r.headers.get('X-Mtime') || this._mtime || Date.now();
    remember(this.name, mt);
    const name = this.name;
    return { name, size: buf.byteLength, lastModified: mt,
      text: async () => new TextDecoder().decode(buf), arrayBuffer: async () => buf };
  }
  async createWritable() {
    const name = this.name, parts = [];
    return {
      write: async d => { parts.push(d); },
      close: async () => {
        const base = seen[name] != null ? String(seen[name]) : 'unknown';
        const r = await call('cases/' + enc(name), { method: 'PUT', body: new Blob(parts),
          headers: { ...HDR, 'Content-Type': 'application/json', 'X-Base-Mtime': base } });
        if (r.status === 409) {
          const e = new Error('เคสนี้ถูกแก้จากเครื่องอื่นหลังจากที่เปิดไว้ — เปิดเคสใหม่จากรายการก่อน แล้วแก้อีกครั้ง');
          e.name = 'ConflictError'; throw e;
        }
        if (!r.ok) throw fail(r, 'บันทึกลงเครื่องกลาง');
        remember(name, (await r.json()).mtime);
      },
    };
  }
}

class ServerDir {
  constructor(name) { this.kind = 'directory'; this.name = name; this.server = true; }
  async queryPermission() { return 'granted'; }
  async requestPermission() { return 'granted'; }
  async isSameEntry(o) { return o === this; }
  async resolve() { return null; }
  async getFileHandle(name, { create = false } = {}) {
    const r = await call('cases/' + enc(name) + '?meta=1');
    if (r.ok) {
      const m = await r.json();
      if (seen[name] == null) remember(name, m.mtime);
      return new ServerFile(name, m.size, m.mtime);
    }
    if (r.status !== 404) throw fail(r, 'อ่านเคส');
    if (!create) { const e = new Error('ไม่พบไฟล์ ' + name); e.name = 'NotFoundError'; throw e; }
    remember(name, 'new');                     // the server refuses if another computer creates it first
    return new ServerFile(name, 0, 0);
  }
  async removeEntry(name) {
    const r = await call('cases/' + enc(name), { method: 'DELETE', headers: HDR });
    if (!r.ok && r.status !== 404) throw fail(r, 'ลบเคส');
    remember(name, null);
  }
  async getDirectoryHandle() { throw new Error('เครื่องกลางไม่มีโฟลเดอร์ย่อย'); }
  async *entries() {
    const r = await call('cases');
    if (!r.ok) throw fail(r, 'อ่านรายการเคส');
    for (const it of await r.json()) yield [it.name, new ServerFile(it.name, it.size, it.mtime)];
  }
}

// Served by the clinic server? Remember the answer, so that when the server is briefly down the
// app keeps saying "server unreachable" instead of quietly switching to a local folder.
async function detect() {
  let name = null;
  try {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 4000);
    const r = await fetch(API + 'ping', { cache: 'no-store', signal: ctl.signal });
    clearTimeout(t);
    if (r.ok) { const j = await r.json(); if (j && j.ok) name = j.name || 'เครื่องกลาง'; }
  } catch { /* offline or not a server deployment */ }
  try {
    if (name) localStorage.setItem(MODE_KEY, name);
    else name = localStorage.getItem(MODE_KEY);
  } catch { /* no storage */ }
  return name ? new ServerDir(name) : null;
}

async function getSettings() {
  try { const r = await call('settings'); return r.ok ? await r.json() : {}; } catch { return {}; }
}
async function putSettings(obj) {
  const r = await call('settings', { method: 'PUT', body: JSON.stringify(obj), headers: { ...HDR, 'Content-Type': 'application/json' } });
  if (!r.ok) throw fail(r, 'บันทึกการตั้งค่าคลินิก');
}

window.PostureServer = { detect, getSettings, putSettings, ServerDir };
})();
