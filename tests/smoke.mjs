// End-to-end smoke test: `npm test` (needs `npx playwright install chromium` once).
// Covers the main flow a clinic uses: patient data, photo + landmarks, case folder save/reopen,
// text auto-fit, muscle chart, print to PDF, and working offline.
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { webcrypto as wc } from 'node:crypto';
import { serve } from './serve.mjs';

const PORT = 8790;
const BASE = `http://localhost:${PORT}/`;
const FIXTURE = fileURLToPath(new URL('fixtures/figure.png', import.meta.url));
const ROOT = fileURLToPath(new URL('..', import.meta.url));

// A throwaway license key pair: the admin tool signs with it, the app (on localhost) verifies with it.
const ALG = { name: 'ECDSA', namedCurve: 'P-256' };
const keys = await wc.subtle.generateKey(ALG, true, ['sign', 'verify']);
const privJwk = await wc.subtle.exportKey('jwk', keys.privateKey);
const pubJwk = (({ kty, crv, x, y }) => ({ kty, crv, x, y }))(privJwk);
const TMP = mkdtempSync(join(tmpdir(), 'posture-'));
const PRIV_FILE = join(TMP, 'posture-license-PRIVATE-KEY.json');
writeFileSync(PRIV_FILE, JSON.stringify({ jwk: privJwk }));
const b64u = b => Buffer.from(b).toString('base64url');
async function signLicense(payload, key = keys.privateKey) {
  const body = b64u(new TextEncoder().encode(JSON.stringify(payload)));
  return `PA1-${body}.${b64u(await wc.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(body)))}`;
}

let failures = 0;
function check(ok, msg) { console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) failures++; }

const server = await serve(PORT);
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
try {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  // The real folder picker is a native dialog; stand in a folder from the origin-private file system.
  await ctx.addInitScript(k => { window.__TEST_LICENSE_PUBLIC_KEY__ = k; }, pubJwk);
  await ctx.addInitScript(() => {
    window.showDirectoryPicker = async () => {
      const root = await navigator.storage.getDirectory();
      return root.getDirectoryHandle('Posture Cases', { create: true });
    };
  });
  const page = await ctx.newPage();
  const errors = [], external = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('request', r => { if (!r.url().startsWith(BASE) && !r.url().startsWith('data:') && !r.url().startsWith('blob:')) external.push(r.url()); });
  page.on('dialog', d => d.accept());

  await page.goto(BASE);
  await page.waitForFunction(() => document.fonts.status === 'loaded');
  check(await page.evaluate(() => document.fonts.check('16px Sarabun', 'ก')), 'Thai font loads from the app itself');

  // patient + photo + landmarks
  await page.fill('[data-bind="patient.name"] >> nth=0', 'ทดสอบ');
  await page.fill('[data-bind="patient.cn"] >> nth=0', 'CN-001');
  check(await page.inputValue('[data-bind="patient.cn"] >> nth=2') === 'CN-001', 'patient fields are shared across pages');
  const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.click('[data-slot="front"]')]);
  await fc.setFiles(FIXTURE);
  await page.waitForSelector('[data-slot="front"] canvas');
  await page.hover('[data-slot="front"]'); await page.click('[data-slot="front"] [data-a="edit"]');
  const b = await page.locator('#edCanvas').boundingBox();
  const at = (fx, fy) => page.mouse.click(b.x + b.width * fx, b.y + b.height * fy);
  await page.keyboard.press('g'); await at(0.5, 0.9);
  await page.keyboard.press('l'); await at(0.42, 0.25); await at(0.58, 0.27);
  check((await page.locator('#edMeasures').innerText()).includes('ข้างขวาสูงกว่า'), 'level line reports the patient side (front view is mirrored)');
  await page.click('#edDone');

  // case folder: choose, save, autosave, reopen from the list
  await page.click('#btnFolder');
  await page.waitForFunction(() => document.querySelector('#btnFolder').textContent.includes('Posture Cases'));
  await page.click('#btnSave');
  await page.waitForFunction(() => document.querySelector('#saveStatus').textContent.includes('บันทึกลงโฟลเดอร์แล้ว'));
  const files = async () => page.evaluate(async () => {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('Posture Cases');
    const out = {}; for await (const [n, h] of dir.entries()) out[n] = JSON.parse(await (await h.getFile()).text());
    return out;
  });
  let saved = await files();
  const name = 'CN-001_ทดสอบ_' + (await page.inputValue('[data-bind="patient.date"] >> nth=0')) + '.json';
  check(Object.keys(saved).length === 1 && saved[name], `case saved to the folder as ${name}`);
  await page.locator('[data-bind-text="impression"]').fill('ข้อความยาว '.repeat(160));
  await page.waitForFunction(() => document.querySelector('#saveStatus').textContent.includes('บันทึกลงโฟลเดอร์แล้ว'), null, { timeout: 8000 });
  saved = await files();
  check(saved[name].impression.startsWith('ข้อความยาว'), 'edits autosave to the same file');
  const fontPt = await page.locator('[data-bind-text="impression"]').evaluate(e => parseFloat(e.style.fontSize));
  check(fontPt < 11, `long impression text shrinks its font (${fontPt}pt) instead of the chart`);

  await page.click('#btnNew');
  check(await page.inputValue('[data-bind="patient.name"] >> nth=0') === '', 'new case starts empty');
  await page.click('#btnOpen');
  await page.waitForSelector('.case-item');
  check(await page.locator('.case-item').count() === 1, 'case list shows the saved case');
  await page.click('.case-item');
  await page.waitForFunction(() => !document.querySelector('#casesDlg').open);
  await page.waitForSelector('[data-slot="front"] canvas', { timeout: 5000 }).catch(() => {});
  check(await page.inputValue('[data-bind="patient.name"] >> nth=0') === 'ทดสอบ', 'reopening restores the case');
  check(await page.locator('[data-slot="front"] canvas').count() === 1, 'reopened case keeps its photo');

  // license: trial until a valid key is entered; keys come from the real admin tool
  check(await page.evaluate(() => document.body.classList.contains('trial')), 'unlicensed copy is in trial mode (watermark)');
  const tryLicense = async key => {
    await page.evaluate(() => document.querySelector('#licenseDlg').open || document.querySelector('#btnLicense').click());
    await page.fill('#licenseText', key); await page.click('#licenseApply');
    await page.waitForFunction(() => document.querySelector('#licenseMsg').textContent);
    return page.locator('#licenseMsg').textContent();
  };
  const today = new Date().toISOString().slice(0, 10);
  let msg = await tryLicense(await signLicense({ v: 1, id: 'T1', clinic: 'คลินิกหมดอายุ', iss: '2020-01-01', exp: '2020-12-31' }));
  check(msg.includes('หมดอายุ'), 'expired license is rejected');
  const other = await wc.subtle.generateKey(ALG, true, ['sign', 'verify']);
  msg = await tryLicense(await signLicense({ v: 1, id: 'T2', clinic: 'ปลอม', iss: today, exp: null }, other.privateKey));
  check(msg.includes('ไม่ถูกต้อง'), 'license signed with another key is rejected');
  const good = await signLicense({ v: 1, id: 'T3', clinic: 'x', iss: today, exp: null });
  msg = await tryLicense(good.replace(/^PA1-[^.]+/, 'PA1-' + b64u(new TextEncoder().encode(JSON.stringify({ v: 1, id: 'T3', clinic: 'แก้ชื่อ', iss: today, exp: null })))));
  check(msg.includes('ไม่ถูกต้อง'), 'tampered license is rejected');
  await page.click('#licenseDlg [data-close]');

  const admin = await ctx.newPage();
  admin.on('pageerror', e => errors.push('admin: ' + e.message));
  await admin.goto(BASE + 'tools/license-admin.html');
  const [kc] = await Promise.all([admin.waitForEvent('filechooser'), admin.click('#loadKey')]);
  await kc.setFiles(PRIV_FILE);
  await admin.waitForSelector('#issue:not([disabled])');
  await admin.fill('#clinic', 'คลินิกทดสอบ');
  await admin.selectOption('#plan', '1y');
  await admin.click('#issue');
  const issued = await admin.inputValue('#keyOut');
  await admin.fill('#checkIn', issued); await admin.click('#check');
  check((await admin.locator('#checkOut').textContent()).includes('ใช้ได้'), 'admin tool issues and verifies a license');
  await admin.close();
  msg = await tryLicense(issued);
  check(msg.includes('คลินิกทดสอบ'), 'license from the admin tool is accepted');
  await page.waitForFunction(() => !document.body.classList.contains('trial'));
  check((await page.locator('.page-foot >> nth=0').textContent()).includes('คลินิกทดสอบ'), 'licensed reports carry the clinic name');

  // print
  await page.emulateMedia({ media: 'print' });
  const pdf = await page.pdf({ format: 'A4', printBackground: true, preferCSSPageSize: true });
  const pages = (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
  check(pages === 3, `PDF has 3 A4 pages (got ${pages})`);
  await page.emulateMedia({ media: 'screen' });

  // offline: the service worker serves the app with no network
  await page.reload();
  await page.waitForFunction(() => navigator.serviceWorker.controller, null, { timeout: 10000 });
  await ctx.setOffline(true);
  await page.reload();
  await page.waitForSelector('.page');
  await page.waitForFunction(() => document.fonts.status === 'loaded');
  check(await page.evaluate(() => document.fonts.check('16px Sarabun', 'ก')), 'app and fonts load while offline');
  check(await page.inputValue('[data-bind="patient.name"] >> nth=0') === 'ทดสอบ', 'working case survives an offline reload');
  await ctx.setOffline(false);

  check(!(await page.evaluate(() => document.body.classList.contains('trial'))), 'license persists across reloads');

  // the customer ZIP runs from disk: open index.html as a file
  const local = await ctx.newPage();
  const localErrors = []; local.on('pageerror', e => localErrors.push(e.message));
  await local.goto('file://' + ROOT + 'index.html');
  await local.waitForSelector('.page');
  await local.waitForFunction(() => document.fonts.status === 'loaded');
  check(localErrors.length === 0 && await local.evaluate(() => document.fonts.check('16px Sarabun', 'ก')), 'app opens from a local file (offline ZIP package)');
  await local.close();

  check(external.length === 0, 'no requests leave the app' + (external.length ? ': ' + external.join(', ') : ''));
  check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
} finally {
  await browser.close();
  server.close();
}
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
