// ZIP writer/reader used for backups (js/zip.js): `node tests/zip.test.mjs`.
// Archives must open in standard tools (checked with Python's zipfile) and round-trip exactly.
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';

const ctx = { window: {}, TextEncoder, TextDecoder, Blob, Response, DecompressionStream };
vm.runInNewContext(readFileSync(new URL('../js/zip.js', import.meta.url), 'utf8'), ctx);
const { makeZip, readZip } = ctx.window.PostureZip;

let failures = 0;
function check(ok, msg, detail = '') { console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}${ok ? '' : '  → ' + detail}`); if (!ok) failures++; }

const photo = new Uint8Array(200000); for (let i = 0; i < photo.length; i++) photo[i] = (i * 7919) & 255;
const files = [
  { name: 'cases/CN-001_สมชาย_2026-10-15.json', data: JSON.stringify({ patient: { name: 'สมชาย' } }) },
  { name: 'cases/binary.bin', data: photo },
  { name: 'settings.json', data: '{}' },
];
const zip = makeZip(files);
const dir = mkdtempSync(join(tmpdir(), 'zip-')), path = join(dir, 'b.zip');
writeFileSync(path, zip);
let py = '';
try {
  py = execFileSync('python3', ['-c', `import zipfile,sys
z=zipfile.ZipFile(sys.argv[1]); bad=z.testzip(); print('bad' if bad else 'ok'); print('|'.join(z.namelist()))`, path]).toString();
  check(py.startsWith('ok'), 'archive passes Python zipfile CRC check', py);
  check(py.includes('cases/CN-001_สมชาย_2026-10-15.json'), 'Thai file names are stored as UTF-8', py);
} catch (e) { check(false, 'python3 can read the archive', e.message); }

const back = await readZip(zip);
check(back.length === 3, 'reader returns every entry', back.length);
check(new TextDecoder().decode(back[0].data).includes('สมชาย'), 'text content round-trips');
check(back[1].data.length === photo.length && back[1].data.every((b, i) => b === photo[i]), 'binary content round-trips');

// archives re-zipped by other tools (deflate) still restore
execFileSync('python3', ['-c', `import zipfile,sys
z=zipfile.ZipFile(sys.argv[1],'w',zipfile.ZIP_DEFLATED); z.writestr('cases/x.json','{"patient":{}}'*50); z.close()`, join(dir, 'd.zip')]);
const d = await readZip(new Uint8Array(readFileSync(join(dir, 'd.zip'))));
check(d.length === 1 && new TextDecoder().decode(d[0].data).startsWith('{"patient"'), 'deflated archives from other tools are readable');

const broken = zip.slice(); broken[100] ^= 0xff;
let threw = false; try { await readZip(broken); } catch { threw = true; }
check(threw, 'corrupted data is detected (CRC)');

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
