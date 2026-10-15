// Unit tests for the landmark analysis rules (js/protocol.js): `node tests/protocol.test.mjs`.
// Each case places landmarks with a known answer, mainly to guard the left/right mapping:
// patient right is image-left in front views and image-right in back views.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const ctx = { window: {} };
vm.runInNewContext(readFileSync(new URL('../js/protocol.js', import.meta.url), 'utf8'), ctx);
const { analyze } = ctx.window.PostureProtocol;

let failures = 0;
function check(ok, msg, detail = '') { console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}${ok ? '' : '  → ' + detail}`); if (!ok) failures++; }
const texts = r => r.findings.map(f => f.text).join(' | ');
const has = (r, s) => r.findings.some(f => f.text.includes(s));

// Anterior: patient-right shoulder (image-left) 10 px higher over 200 px ≈ 2.9°
let r = analyze({ lm: {
  eyeR: [280, 100], eyeL: [320, 100],
  acrR: [200, 190], acrL: [400, 200],
  asisR: [250, 400], asisL: [350, 400],
  patR: [255, 600], patL: [345, 600], ttR: [256, 640], ttL: [344, 640],
  ankR: [260, 780], ankL: [340, 780],
} }, 'anterior');
check(has(r, 'ไหล่ขวาสูงกว่าซ้าย'), 'anterior: image-left shoulder higher = patient right higher', texts(r));
check(has(r, 'ระดับเชิงกราน'), 'anterior: level pelvis reported as level', texts(r));
check(has(r, 'ศีรษะตรง'), 'anterior: level eyes = head straight', texts(r));
check(r.plumbX === 300, 'anterior: plumb line through mid-ankles', r.plumbX);
check(r.q && Math.round(r.q.R) === Math.round(r.q.L), 'anterior: symmetric legs give equal Q-angles', JSON.stringify(r.q));

// Posterior: image-right shoulder higher = patient right higher
r = analyze({ lm: { acrR: [400, 190], acrL: [200, 200], heelR: [340, 780], heelL: [260, 780] } }, 'posterior');
check(has(r, 'ไหล่ขวาสูงกว่าซ้าย'), 'posterior: image-right shoulder higher = patient right higher', texts(r));

// Posterior: scapula on the patient's right (image-right) further from the spine
r = analyze({ lm: { c7: [300, 180], psisR: [330, 420], psisL: [270, 420], scapR: [380, 300], scapL: [245, 300] } }, 'posterior');
check(has(r, 'สะบักขวาห่าง'), 'posterior: wider right scapula detected', texts(r));

// Lateral, facing image-right: CVA 37° (forward head), knee behind the plumb line
r = analyze({ lm: { tragus: [340, 170], c7: [300, 200], acr: [305, 260], gt: [300, 470], knee: [280, 630], mall: [300, 760] } }, 'lateral');
check(has(r, 'ศีรษะยื่นไปด้านหน้า (CVA 37°'), 'lateral: CVA computed and flagged', texts(r));
check(has(r, 'เข่าอยู่หลังแนวดิ่ง'), 'lateral (facing right): knee behind plumb = hyperextension', texts(r));
// Same posture mirrored (facing image-left) must give the same findings
r = analyze({ lm: { tragus: [260, 170], c7: [300, 200], acr: [295, 260], gt: [300, 470], knee: [320, 630], mall: [300, 760] } }, 'lateral');
check(has(r, 'CVA 37°') && has(r, 'เข่าอยู่หลังแนวดิ่ง'), 'lateral (facing left): mirrored photo gives the same findings', texts(r));
// With a scale, distances are in centimetres
r = analyze({ scale: { pxPerCm: 4 }, lm: { tragus: [340, 170], c7: [300, 200], acr: [305, 260], gt: [300, 470], knee: [280, 630], mall: [300, 760] } }, 'lateral');
check(has(r, '≈ 5.0 ซม.'), 'lateral: offsets shown in cm when a scale is set', texts(r));

// Single leg stance (back view): image-left PSIS lower = patient left pelvis drops
r = analyze({ lm: { c7: [300, 180], psisR: [330, 400], psisL: [270, 412], heel: [330, 780] } }, 'sls');
check(has(r, 'เชิงกรานข้างซ้ายตกลง'), 'single leg stance: left pelvic drop detected', texts(r));

// Squat back view: knees closer together than ankles
r = analyze({ lm: { psisR: [330, 400], psisL: [270, 400], kneeR: [320, 600], kneeL: [280, 600], ankR: [350, 760], ankL: [250, 760] } }, 'squatBack');
check(has(r, 'Dynamic knee valgus'), 'squat: knee valgus detected', texts(r));

// Squat side view: trunk 45°, tibia 20°
r = analyze({ lm: { gt: [300, 500], acr: [400, 400], knee: [380, 560], mall: [330, 697] } }, 'squatSide');
check(has(r, 'ลำตัวโน้มไปด้านหน้ามากกว่าแนวหน้าแข้ง 25°'), 'squat: trunk vs tibia angle compared', texts(r));

// Missing landmarks never throw
for (const p of ['anterior', 'posterior', 'lateral', 'sls', 'squatBack', 'squatSide']) analyze({ lm: {} }, p);
check(true, 'empty landmark sets are handled');

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
