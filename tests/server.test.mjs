// Clinic-server mode: the app served by server/posture_server.py keeps every case in one folder on
// the server, shared by all computers. Two "computers" are two browser contexts here.
// Run: node tests/server.test.mjs   (needs Python 3 on PATH as python3/python, or set PYTHON)
import { chromium } from 'playwright';
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = 8791;
const BASE = `http://localhost:${PORT}/`;
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const FIXTURE = fileURLToPath(new URL('fixtures/figure.png', import.meta.url));
const DATA = mkdtempSync(join(tmpdir(), 'posture-cases-'));

let failures = 0;
function check(ok, msg) { console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) failures++; }

const PY = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const srv = spawn(PY, [join(ROOT, 'server', 'posture_server.py'), '--app', ROOT, '--data', DATA, '--host', '127.0.0.1', '--port', String(PORT)],
  { stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((res, rej) => {
  srv.stdout.on('data', d => { if (String(d).includes('posture server')) res(); });
  srv.on('exit', c => rej(new Error('server exited ' + c)));
  setTimeout(() => rej(new Error('server did not start')), 10000);
});
const diskCases = () => readdirSync(DATA).filter(n => n.endsWith('.json') && !n.startsWith('.'));
const diskCase = n => JSON.parse(readFileSync(join(DATA, n), 'utf8'));

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
try {
  // ---- the server itself: only the app's files are reachable, writes need the app's header
  const get = p => fetch(BASE + p).then(r => r.status);
  check(await get('server/posture_server.py') === 404, 'server code is not served');
  // raw paths: fetch() would normalise "../" away before it reaches the server
  const raw = p => new Promise(res => http.get({ host: '127.0.0.1', port: PORT, path: p }, r => { r.resume(); res(r.statusCode); }));
  const escapes = await Promise.all(['/js/../../README.md', '/js/..%2f..%2fREADME.md', '/css/%2e%2e/%2e%2e/package.json', '/.git/config', '/js/../server/posture_server.py'].map(raw));
  check(escapes.every(s => s === 404), 'no path escapes the app folder (' + escapes.join(',') + ')');
  check(await get('js/app.js') === 200 && await get('') === 200, 'app files are served');
  const bare = await fetch(BASE + 'api/cases/x.json', { method: 'PUT', body: '{}' });
  check(bare.status === 403, 'a write without the app header is refused (cross-site pages cannot send it)');
  const bad = await fetch(BASE + 'api/cases/' + encodeURIComponent('../evil.json'), { method: 'PUT', body: '{}', headers: { 'X-Posture': '1' } });
  check(bad.status === 400 || bad.status === 404, 'file names with folders are refused');
  const notJson = await fetch(BASE + 'api/cases/a.json', { method: 'PUT', body: 'hello', headers: { 'X-Posture': '1' } });
  check(notJson.status === 400 && !diskCases().length, 'anything that is not a case is refused');

  const open = async () => {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
    const page = await ctx.newPage();
    page.errors = []; page.external = [];
    page.on('pageerror', e => page.errors.push(e.message));
    page.on('request', r => { if (!r.url().startsWith(BASE) && !/^(data|blob):/.test(r.url())) page.external.push(r.url()); });
    page.on('dialog', d => d.accept());
    await page.goto(BASE);
    await page.waitForFunction(() => document.querySelector('#btnFolder').textContent.includes('เครื่องกลาง'));
    return page;
  };
  const saved = page => page.waitForFunction(() => document.querySelector('#saveStatus').textContent.includes('บันทึกลงโฟลเดอร์แล้ว'), null, { timeout: 8000 });

  // ---- computer A creates a case
  const a = await open();
  check(await a.locator('#btnFolder.ok').count() === 1, 'computer A: folder chip shows the clinic server, no folder to pick');
  await a.fill('[data-bind="patient.name"] >> nth=0', 'ทดสอบ');
  await a.fill('[data-bind="patient.cn"] >> nth=0', 'CN-001');
  await a.click('#btnSave'); await saved(a);
  const name = 'CN-001_ทดสอบ_' + (await a.inputValue('[data-bind="patient.date"] >> nth=0')) + '.json';
  check(diskCases().length === 1 && diskCases()[0] === name, `case written to the server folder as ${name}`);
  await a.locator('[data-bind-text="impression"]').fill('จากเครื่อง A');
  await a.waitForFunction(() => document.querySelector('#saveStatus').textContent.includes('บันทึกลงโฟลเดอร์แล้ว'), null, { timeout: 8000 });
  await a.waitForTimeout(300);
  check(diskCase(name).impression === 'จากเครื่อง A', 'edits autosave to the same file on the server');

  // ---- computer B sees it, opens and edits it
  const b = await open();
  await b.click('#btnOpen'); await b.waitForSelector('.case-item');
  check(await b.locator('.case-item').count() === 1, 'computer B: case list shows the case saved on A');
  await b.click('.case-item'); await b.waitForFunction(() => !document.querySelector('#casesDlg').open);
  check(await b.inputValue('[data-bind="patient.name"] >> nth=0') === 'ทดสอบ', 'computer B opens the case');
  await b.locator('[data-bind-text="impression"]').fill('จากเครื่อง B');
  await saved(b); await b.waitForTimeout(300);
  check(diskCase(name).impression === 'จากเครื่อง B', 'computer B saves its edit');

  // ---- A, still holding the old version, edits again: refused, B's work stays
  await a.locator('[data-bind-text="impression"]').fill('A ทับ B');
  await a.waitForFunction(() => document.querySelector('#saveStatus').textContent.includes('ไม่สำเร็จ'), null, { timeout: 8000 }).catch(() => {});
  check(diskCase(name).impression === 'จากเครื่อง B', "A's stale save does not overwrite B's work");
  check((await a.locator('#toast').textContent()).includes('เครื่องอื่น'), 'A is told the case was changed on another computer');
  // A reopens the case from the list and can save again
  await a.click('#btnNew');
  await a.click('#btnOpen'); await a.waitForSelector('.case-item'); await a.click('.case-item');
  await a.waitForFunction(() => !document.querySelector('#casesDlg').open);
  check(await a.locator('[data-bind-text="impression"]').textContent() === 'จากเครื่อง B', "after reopening, A sees B's edit");
  await a.locator('[data-bind-text="impression"]').fill('A หลังเปิดใหม่');
  await saved(a); await a.waitForTimeout(300);
  check(diskCase(name).impression === 'A หลังเปิดใหม่', 'after reopening, A can save again');

  // ---- clinic logo is shared by every computer
  await b.click('#btnSettings');
  const [fc] = await Promise.all([b.waitForEvent('filechooser'), b.click('#setLogo')]);
  await fc.setFiles(FIXTURE);
  await b.waitForFunction(() => !!document.querySelector('.logo-slot img'));
  await b.waitForTimeout(500);
  const c = await open();
  await c.waitForFunction(() => !!document.querySelector('.logo-slot img'), null, { timeout: 5000 }).catch(() => {});
  check(await c.locator('.logo-slot img').count() > 0, 'a logo set on one computer shows on another');

  // ---- settings and backup UI fit the server
  await c.click('#btnSettings');
  check(await c.locator('#setFolder').isDisabled() && await c.locator('#setBackupFolder').isDisabled(), 'no local folder pickers on the server');
  check((await c.locator('#setBackupInfo').textContent()).includes('ทุกคืน'), 'settings say the server backs up every night');
  check(await c.locator('#btnBackup').isHidden(), 'no "make a backup" reminder on the server');

  // ---- nightly backup ZIP restores through the app
  const ZIPS = mkdtempSync(join(tmpdir(), 'posture-zips-')), MIRROR = join(ZIPS, 'mirror');
  const bk = spawnSync(PY, [join(ROOT, 'server', 'backup.py'), '--data', DATA, '--zip-dir', ZIPS, '--keep', '2', '--mirror', MIRROR], { encoding: 'utf8' });
  const zipName = readdirSync(ZIPS).find(n => n.endsWith('.zip'));
  check(bk.status === 0 && !!zipName, 'nightly backup writes a ZIP: ' + (bk.stdout || bk.stderr).trim());
  check(readdirSync(MIRROR).includes(name), 'nightly backup mirrors the case folder');
  await c.evaluate(n => fetch('api/cases/' + encodeURIComponent(n), { method: 'DELETE', headers: { 'X-Posture': '1' } }), name);
  check(!diskCases().includes(name) && readdirSync(join(DATA, '.trash')).some(n => n.startsWith(name)), 'deleting a case moves it to .trash');
  const [rc] = await Promise.all([c.waitForEvent('filechooser'), c.click('#setRestore')]);
  await rc.setFiles(join(ZIPS, zipName));
  await c.waitForFunction(() => document.querySelector('#toast').textContent.includes('กู้คืนแล้ว'), null, { timeout: 8000 }).catch(() => {});
  check(diskCases().includes(name) && diskCase(name).impression === 'A หลังเปิดใหม่', 'the server backup restores the case through the app');
  rmSync(ZIPS, { recursive: true, force: true });

  const audit = readFileSync(join(DATA, '.audit.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  check(audit.some(r => r.action === 'conflict') && audit.some(r => r.action === 'create'), 'saves and refused saves are logged');

  for (const p of [a, b, c]) {
    check(p.external.length === 0, 'no requests leave the clinic network' + (p.external.length ? ': ' + p.external.join(', ') : ''));
    check(p.errors.length === 0, 'no page errors' + (p.errors.length ? ': ' + p.errors.join(' | ') : ''));
  }
} finally {
  await browser.close();
  srv.kill();
  rmSync(DATA, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exitCode = failures ? 1 : 0;
