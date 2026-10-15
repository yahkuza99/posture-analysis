// End-to-end smoke test: `npm test` (needs `npx playwright install chromium` once).
// Covers the main flow a clinic uses: patient data, photo + landmarks, case folder save/reopen,
// text auto-fit, print to PDF, working offline and running from a local file.
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { serve } from './serve.mjs';

const PORT = 8790;
const BASE = `http://localhost:${PORT}/`;
const FIXTURE = fileURLToPath(new URL('fixtures/figure.png', import.meta.url));
const ROOT = fileURLToPath(new URL('..', import.meta.url));

let failures = 0;
function check(ok, msg) { console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) failures++; }

const server = await serve(PORT);
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
try {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  // The real folder picker is a native dialog; stand in a folder from the origin-private file system.
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
  // guided landmarks: the editor opens on the first point of the anterior protocol
  check((await page.locator('#edHint').innerText()).includes('1/12'), 'editor starts the guided landmark protocol');
  const W = 600, H = 800;
  const sc = Math.min((b.width - 40) / W, (b.height - 40) / H), ox = (b.width - W * sc) / 2, oy = (b.height - H * sc) / 2;
  const px = (x, y) => page.mouse.click(b.x + ox + x * sc, b.y + oy + y * sc);
  for (const [x, y] of [[288, 120], [312, 120], [240, 190], [360, 200], [262, 420], [338, 420],
                        [272, 610], [328, 610], [271, 650], [329, 650], [268, 735], [334, 735]]) await px(x, y);
  check((await page.locator('#edProtoCount').innerText()) === '12/12', 'all 12 anterior landmarks placed in order');
  const analysis = await page.locator('#edAnalysis').innerText();
  check(analysis.includes('ไหล่ขวาสูงกว่าซ้าย') && analysis.includes('Q-angle'), 'automatic analysis lists findings with the patient side');
  const before = await page.locator('[data-findings="row1"] .finding').count();
  await page.click('#edInsert');
  check(await page.locator('[data-findings="row1"] .finding').count() > before, 'selected findings go into the report');
  await page.keyboard.press('g'); await at(0.5, 0.9);
  await page.keyboard.press('l'); await at(0.42, 0.25); await at(0.58, 0.27);
  check((await page.locator('#edMeasures').innerText()).includes('ข้างขวาสูงกว่า'), 'free level line reports the patient side (front view is mirrored)');
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
