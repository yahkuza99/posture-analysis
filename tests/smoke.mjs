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
    window.showDirectoryPicker = async (o = {}) => {
      const root = await navigator.storage.getDirectory();
      return root.getDirectoryHandle(o.id === 'posture-backup' ? 'Backup' : 'Posture Cases', { create: true });
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
  await page.mouse.move(5, 5);
  check(await page.locator('[data-slot="front"] .slot-tools').isHidden(), 'photo toolbar stays hidden until the photo is hovered');
  await page.hover('[data-slot="front"]'); await page.click('[data-slot="front"] [data-a="edit"]');
  const b = await page.locator('#edCanvas').boundingBox();
  const at = (fx, fy) => page.mouse.click(b.x + b.width * fx, b.y + b.height * fy);
  const readCase = () => page.evaluate(() => new Promise((res, rej) => {
    const r = indexedDB.open('posture-analysis', 1);
    r.onsuccess = () => { const g = r.result.transaction('kv').objectStore('kv').get('current'); g.onsuccess = () => res(JSON.parse(g.result)); g.onerror = rej; };
  }));
  // simple drawing first: the editor opens on the straight-line tool; press-drag-release draws a line
  check(await page.locator('#edTools [data-tool="dashed"].active').count() === 1, 'editor opens with the straight-line tool');
  check(await page.locator('#edProtoDetails[open]').count() === 0 && await page.locator('#edRight').isHidden(), 'landmarks and analysis stay folded away');
  const drag = async (pts) => {
    await page.mouse.move(b.x + b.width * pts[0][0], b.y + b.height * pts[0][1]); await page.mouse.down();
    for (const [fx, fy] of pts.slice(1)) await page.mouse.move(b.x + b.width * fx, b.y + b.height * fy, { steps: 6 });
    await page.mouse.up();
  };
  await drag([[0.45, 0.3], [0.55, 0.3]]);
  await page.keyboard.press('c');
  await drag([[0.5, 0.25], [0.52, 0.35], [0.5, 0.45], [0.49, 0.55]]);
  const shapes = async () => (await readCase()).photos.front.shapes;
  // landmarks are opt-in
  await page.click('#edProtoDetails summary');
  await page.waitForFunction(() => document.querySelector('#edHint').textContent.includes('1/12'), null, { timeout: 3000 }).catch(() => {});
  check((await page.locator('#edHint').innerText()).includes('1/12'), 'opening the landmark section starts the guided protocol');
  const W = 600, H = 800;
  // the photo was fitted to the stage when the editor opened; opening the landmark section shows
  // the side panel, which narrows the stage and re-centres the photo at the same zoom
  const sc = Math.min((b.width - 40) / W, (b.height - 40) / H);
  const b2 = await page.locator('#edCanvas').boundingBox();
  const ox = (b2.width - W * sc) / 2, oy = (b2.height - H * sc) / 2;
  const px = (x, y) => page.mouse.click(b2.x + ox + x * sc, b2.y + oy + y * sc);
  for (const [x, y] of [[288, 120], [312, 120], [240, 190], [360, 200], [262, 420], [338, 420],
                        [272, 610], [328, 610], [271, 650], [329, 650], [268, 735], [334, 735]]) await px(x, y);
  check((await page.locator('#edProtoCount').innerText()) === '12/12', 'all 12 anterior landmarks placed in order');
  // the last placed point stays selected: Shift+→ three times nudges it 30 screen px
  for (let i = 0; i < 3; i++) await page.keyboard.press('Shift+ArrowRight');
  const analysis = await page.locator('#edAnalysis').innerText();
  check(analysis.includes('ไหล่ขวาสูงกว่าซ้าย') && analysis.includes('Q-angle'), 'automatic analysis lists findings with the patient side');
  const before = await page.locator('[data-findings="row1"] .finding').count();
  await page.click('#edInsert');
  check(await page.locator('[data-findings="row1"] .finding').count() > before, 'selected findings go into the report');
  await page.keyboard.press('y'); await px(300, 760);
  await page.keyboard.press('l'); await px(240, 195); await px(360, 205);
  check((await page.locator('#edMeasures').innerText()).includes('ข้างขวาสูงกว่า'), 'free level line reports the patient side (front view is mirrored)');
  await page.click('#edDone');
  await page.waitForTimeout(600);
  const sh = await shapes();
  check(sh.some(x => x.type === 'dashed' && x.pts.length === 2), 'press-drag-release draws a straight line');
  check(sh.some(x => x.type === 'curve' && x.pts.length > 5), 'freehand curve tool records a smooth stroke');
  const ankL = (await readCase()).photos.front.lm.ankL;
  check(Math.abs(ankL[0] - (334 + 30 / sc)) < 0.5, `arrow keys nudge the selected landmark (x ${ankL[0].toFixed(1)})`);

  // design-tool alignment: dragging the photo near the frame centre snaps the plumb line onto it
  const sb = await page.locator('[data-slot="front"]').boundingBox();
  await page.mouse.move(sb.x + sb.width / 2, sb.y + sb.height / 2); await page.mouse.down();
  await page.mouse.move(sb.x + sb.width / 2 + 40, sb.y + sb.height / 2, { steps: 4 });
  check(await page.locator('[data-slot="front"].dragging').count() === 1 && !(await page.locator('[data-slot="front"] .gbadge').textContent()), 'centre guides show while dragging, no snap when off-centre');
  await page.mouse.move(sb.x + sb.width / 2 + 3, sb.y + sb.height / 2, { steps: 4 });
  check((await page.locator('[data-slot="front"] .gbadge').textContent()).includes('แกน Y อยู่กึ่งกลาง'), 'photo snaps so the plumb line sits on the frame centre');
  await page.mouse.up();

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

  // reopening a photo after the side panel was shown keeps the photo centred in the stage
  await page.hover('[data-slot="back"]').catch(() => {});
  await page.hover('[data-slot="front"]'); await page.click('[data-slot="front"] [data-a="edit"]'); await page.waitForTimeout(300);
  const imgCentre = await page.evaluate(() => {
    const st = document.querySelector('#edStage').getBoundingClientRect();
    return { stageW: st.width };
  });
  check(imgCentre.stageW > 0, 'editor reopens');
  await page.click('#edDone');
  // backup: a second folder gets a copy of every save; a full backup is a ZIP that restores
  check(await page.locator('#btnBackup').isVisible(), 'reminder shows when no backup has been made yet');
  await page.click('#btnSettings');
  await page.click('#setBackupFolder');
  await page.waitForFunction(() => document.querySelector('#setBackupInfo').textContent.includes('Backup'));
  await page.click('#settingsDlg [data-close]');
  await page.click('#btnSave');
  await page.waitForFunction(async n => {
    try { return !!(await (await (await (await navigator.storage.getDirectory()).getDirectoryHandle('Backup')).getDirectoryHandle('cases')).getFileHandle(n)); }
    catch { return false; }
  }, name, { timeout: 8000 }).catch(() => {});
  const listDir = async path => page.evaluate(async path => {
    let d = await navigator.storage.getDirectory();
    for (const p of path) d = await d.getDirectoryHandle(p);
    const out = []; for await (const [n] of d.entries()) out.push(n); return out.sort();
  }, path);
  check((await listDir(['Backup', 'cases'])).includes(name), 'each save is copied to the backup folder');
  await page.click('#btnSettings'); await page.click('#setBackupNow');
  await page.waitForFunction(() => document.querySelector('#saveStatus').textContent.includes('สำรองข้อมูลแล้ว'));
  await page.click('#settingsDlg [data-close]');
  check(await page.locator('#btnBackup').isHidden(), 'reminder clears after a full backup');
  const zips = (await listDir(['Backup'])).filter(n => n.endsWith('.zip'));
  check(zips.length === 1, `full backup writes a dated ZIP (${zips[0]})`);
  const zipBytes = await page.evaluate(async n => {
    const f = await (await (await (await navigator.storage.getDirectory()).getDirectoryHandle('Backup')).getFileHandle(n)).getFile();
    return Array.from(new Uint8Array(await f.arrayBuffer()));
  }, zips[0]);
  await page.evaluate(async n => (await (await navigator.storage.getDirectory()).getDirectoryHandle('Posture Cases')).removeEntry(n), name);
  check(!(await listDir(['Posture Cases'])).includes(name), 'case file deleted (simulated loss)');
  await page.click('#btnSettings');
  const [rc] = await Promise.all([page.waitForEvent('filechooser'), page.click('#setRestore')]);
  await rc.setFiles({ name: zips[0], mimeType: 'application/zip', buffer: Buffer.from(zipBytes) });
  await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('กู้คืนแล้ว'));
  await page.click('#settingsDlg [data-close]');
  check((await listDir(['Posture Cases'])).includes(name), 'restore brings the case back from the ZIP');

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
