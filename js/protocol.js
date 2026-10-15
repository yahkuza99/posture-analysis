/* Landmark protocols and automatic posture analysis.
 *
 * Each photo slot uses one protocol: an ordered list of anatomical landmarks the therapist
 * places by hand. From the placed points, analyze() derives the reference lines to draw and
 * a list of findings in Thai. Pure functions only (no DOM), so the rules are easy to read,
 * test and tune. Thresholds are screening cut-offs, not diagnoses; the therapist reviews
 * every finding before it goes into the report.
 *
 * Coordinates are image pixels, y grows downward. "Patient right" is image-left in an
 * anterior view and image-right in a posterior view.
 */
(() => {
'use strict';

const P = (id, code, name, hint) => ({ id, code, name, hint });

const PROTOCOLS = {
  anterior: {
    title: 'ด้านหน้า (Anterior)',
    points: [
      P('eyeR', 'Eye R', 'ตาขวา', 'กึ่งกลางตาขวาของผู้รับบริการ (อยู่ทางซ้ายของภาพ)'),
      P('eyeL', 'Eye L', 'ตาซ้าย', 'กึ่งกลางตาซ้าย (อยู่ทางขวาของภาพ)'),
      P('acrR', 'Acr R', 'Acromion ขวา', 'ปลายไหล่ขวา (Acromion) — ทางซ้ายของภาพ'),
      P('acrL', 'Acr L', 'Acromion ซ้าย', 'ปลายไหล่ซ้าย (Acromion) — ทางขวาของภาพ'),
      P('asisR', 'ASIS R', 'ASIS ขวา', 'Anterior superior iliac spine ขวา'),
      P('asisL', 'ASIS L', 'ASIS ซ้าย', 'Anterior superior iliac spine ซ้าย'),
      P('patR', 'Pat R', 'กึ่งกลางลูกสะบ้าขวา', 'กึ่งกลางลูกสะบ้า (Patella) ขวา'),
      P('patL', 'Pat L', 'กึ่งกลางลูกสะบ้าซ้าย', 'กึ่งกลางลูกสะบ้า (Patella) ซ้าย'),
      P('ttR', 'TT R', 'Tibial tuberosity ขวา', 'ปุ่มกระดูกหน้าแข้งขวา (Tibial tuberosity)'),
      P('ttL', 'TT L', 'Tibial tuberosity ซ้าย', 'ปุ่มกระดูกหน้าแข้งซ้าย (Tibial tuberosity)'),
      P('ankR', 'Ank R', 'กึ่งกลางข้อเท้าขวา', 'กึ่งกลางข้อเท้าขวา ระหว่างตาตุ่มในและนอก'),
      P('ankL', 'Ank L', 'กึ่งกลางข้อเท้าซ้าย', 'กึ่งกลางข้อเท้าซ้าย ระหว่างตาตุ่มในและนอก'),
    ],
  },
  posterior: {
    title: 'ด้านหลัง (Posterior)',
    points: [
      P('occ', 'Occ', 'ท้ายทอย', 'กึ่งกลางท้ายทอย (External occipital protuberance)'),
      P('c7', 'C7', 'C7', 'ปุ่มกระดูกสันหลัง C7 (จุดที่นูนที่สุดของคอ)'),
      P('acrR', 'Acr R', 'Acromion ขวา', 'ปลายไหล่ขวา — ทางขวาของภาพ'),
      P('acrL', 'Acr L', 'Acromion ซ้าย', 'ปลายไหล่ซ้าย — ทางซ้ายของภาพ'),
      P('scapR', 'Scap R', 'มุมล่างสะบักขวา', 'Inferior angle of scapula ขวา'),
      P('scapL', 'Scap L', 'มุมล่างสะบักซ้าย', 'Inferior angle of scapula ซ้าย'),
      P('psisR', 'PSIS R', 'PSIS ขวา', 'Posterior superior iliac spine ขวา (รอยบุ๋มเหนือก้น)'),
      P('psisL', 'PSIS L', 'PSIS ซ้าย', 'Posterior superior iliac spine ซ้าย'),
      P('heelR', 'Heel R', 'กึ่งกลางส้นเท้าขวา', 'กึ่งกลางส้นเท้าขวา'),
      P('heelL', 'Heel L', 'กึ่งกลางส้นเท้าซ้าย', 'กึ่งกลางส้นเท้าซ้าย'),
    ],
  },
  lateral: {
    title: 'ด้านข้าง (Lateral)',
    points: [
      P('tragus', 'Tragus', 'ติ่งหู (Tragus)', 'ติ่งหูด้านหน้า (Tragus)'),
      P('c7', 'C7', 'C7', 'ปุ่มกระดูกสันหลัง C7 ด้านหลังคอ'),
      P('acr', 'Acr', 'Acromion', 'ปลายไหล่ (Acromion)'),
      P('gt', 'GT', 'Greater trochanter', 'ปุ่มกระดูกต้นขา (Greater trochanter)'),
      P('knee', 'Knee', 'แนวข้อเข่าด้านนอก', 'แนวข้อเข่าด้านนอก (Lateral knee joint line)'),
      P('mall', 'Mall', 'ตาตุ่มนอก', 'ตาตุ่มนอก (Lateral malleolus) — แนวดิ่งจะลากผ่านจุดนี้'),
    ],
  },
  sls: {
    title: 'ยืนขาเดียว (ด้านหลัง)',
    points: [
      P('c7', 'C7', 'C7', 'ปุ่มกระดูกสันหลัง C7'),
      P('psisR', 'PSIS R', 'PSIS ขวา', 'Posterior superior iliac spine ขวา — ทางขวาของภาพ'),
      P('psisL', 'PSIS L', 'PSIS ซ้าย', 'Posterior superior iliac spine ซ้าย — ทางซ้ายของภาพ'),
      P('heel', 'Heel', 'ส้นเท้าขาที่ยืน', 'กึ่งกลางส้นเท้าของขาที่ยืน'),
    ],
  },
  squatBack: {
    title: 'Squat (ด้านหลัง)',
    points: [
      P('psisR', 'PSIS R', 'PSIS ขวา', 'PSIS ขวา — ทางขวาของภาพ'),
      P('psisL', 'PSIS L', 'PSIS ซ้าย', 'PSIS ซ้าย — ทางซ้ายของภาพ'),
      P('kneeR', 'Knee R', 'กึ่งกลางเข่าขวา', 'กึ่งกลางข้อเข่าขวาด้านหลัง'),
      P('kneeL', 'Knee L', 'กึ่งกลางเข่าซ้าย', 'กึ่งกลางข้อเข่าซ้ายด้านหลัง'),
      P('ankR', 'Ank R', 'กึ่งกลางข้อเท้าขวา', 'กึ่งกลางข้อเท้าขวา'),
      P('ankL', 'Ank L', 'กึ่งกลางข้อเท้าซ้าย', 'กึ่งกลางข้อเท้าซ้าย'),
    ],
  },
  squatSide: {
    title: 'Squat (ด้านข้าง)',
    points: [
      P('acr', 'Acr', 'Acromion', 'ปลายไหล่ (Acromion)'),
      P('gt', 'GT', 'Greater trochanter', 'ปุ่มกระดูกต้นขา (Greater trochanter)'),
      P('knee', 'Knee', 'แนวข้อเข่าด้านนอก', 'แนวข้อเข่าด้านนอก'),
      P('mall', 'Mall', 'ตาตุ่มนอก', 'ตาตุ่มนอก (Lateral malleolus)'),
    ],
  },
};

// Cut-offs used to word the findings.
const T = {
  levelSame: 1.0,      // deg: below this, two sides are treated as level
  levelSlight: 2.5,    // deg: below this, "เล็กน้อย"
  headTilt: 2.0,       // deg
  trunkLean: 2.0,      // deg
  shiftPct: 4,         // % of shoulder/pelvis width: lateral shift of the trunk from the plumb line
  scapDiffPct: 15,     // % difference in scapula-to-spine distance
  cvaForward: 50,      // deg: CVA below this = forward head
  sagittalPct: 1.5,    // % of standing height: landmark ahead of / behind the plumb line
  qMale: 15, qFemale: 20,
  kneeValgusRatio: 0.85, // knee width / ankle width during squat
  trunkTibiaDiff: 10,  // deg
};

const deg = r => r * 180 / Math.PI;
const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const fmt = (v, d = 1) => (Math.round(v * 10 ** d) / 10 ** d).toFixed(d);
const TH = { R: 'ขวา', L: 'ซ้าย' };
const other = s => (s === 'R' ? 'L' : 'R');

// Signed tilt of the line a→b in degrees; positive = the image-right end is higher.
function tilt(a, b) {
  const [l, r] = a[0] <= b[0] ? [a, b] : [b, a];
  return deg(Math.atan2(l[1] - r[1], r[0] - l[0]));
}
// Patient side shown on image-right for a frontal-plane view.
const rightSideIs = view => (view === 'anterior' ? 'L' : 'R');
// Patient side for a horizontal image offset (+ = image-right).
const sideOfDx = (dx, view) => (dx > 0 ? rightSideIs(view) : other(rightSideIs(view)));
// Lean of the segment lower→upper from vertical, + = upper end toward image-right.
const lean = (lower, upper) => deg(Math.atan2(upper[0] - lower[0], lower[1] - upper[1]));
// Interior angle at v.
function angleAt(a, v, b) {
  let d = Math.abs(deg(Math.atan2(a[1] - v[1], a[0] - v[0]) - Math.atan2(b[1] - v[1], b[0] - v[0])));
  return d > 180 ? 360 - d : d;
}

/* Helpers that add a level comparison of a left/right pair (frontal views).
 * `subject` names the structure, e.g. 'ไหล่'. */
function levelFinding(out, L, a, b, view, subject, key) {
  if (!a || !b) return;
  const t = tilt(a, b);
  const abs = Math.abs(t);
  out.lines.push({ t: 'level', a, b, label: `${fmt(abs)}°`, color: '#e3262e' });
  if (abs < T.levelSame) {
    out.findings.push({ key, text: `ระดับ${subject}ใกล้เคียงกัน (${fmt(abs)}°)`, flag: false });
    return;
  }
  const higher = t > 0 ? rightSideIs(view) : other(rightSideIs(view));
  const slight = abs < T.levelSlight ? 'เล็กน้อย' : '';
  out.findings.push({ key, text: `${subject}${TH[higher]}สูงกว่า${TH[other(higher)]}${slight} (${fmt(abs)}°)`, flag: true, value: t });
}

function cm(px, scale) { return scale ? px / scale : null; }
function distText(px, scale) { const c = cm(px, scale); return c == null ? '' : ` ≈ ${fmt(c)} ซม.`; }

const ANALYZE = {
  anterior(L, out, ctx) {
    const v = 'anterior';
    const base = L.ankR && L.ankL ? mid(L.ankR, L.ankL) : L.ankR || L.ankL;
    if (base) { out.plumbX = base[0]; out.lines.push({ t: 'plumb', x: base[0] }); }

    if (L.eyeR && L.eyeL) {
      const t = tilt(L.eyeR, L.eyeL), abs = Math.abs(t);
      out.lines.push({ t: 'level', a: L.eyeR, b: L.eyeL, label: `${fmt(abs)}°`, color: '#e3262e', thin: true });
      const lower = t > 0 ? other(rightSideIs(v)) : rightSideIs(v);
      out.findings.push(abs < T.headTilt
        ? { key: 'head', text: `ศีรษะตรง (${fmt(abs)}°)`, flag: false }
        : { key: 'head', text: `ศีรษะเอียงไปทาง${TH[lower]} (${fmt(abs)}°)`, flag: true });
    }
    levelFinding(out, L, L.acrR, L.acrL, v, 'ไหล่', 'shoulder');
    levelFinding(out, L, L.asisR, L.asisL, v, 'เชิงกราน (ASIS) ', 'pelvis');

    const q = {};
    for (const s of ['R', 'L']) {
      const a = L['asis' + s], p = L['pat' + s], t = L['tt' + s];
      if (!(a && p && t)) continue;
      q[s] = 180 - angleAt(a, p, t);
      // patient right is image-left in a front view: put its label on the outer (left) side
      out.lines.push({ t: 'q', a, v: p, b: t, label: `Q ${Math.round(q[s])}°`, outward: s === 'R' ? -1 : 1 });
    }
    if (q.R != null || q.L != null) {
      const part = s => (q[s] == null ? '' : `${TH[s]} ${Math.round(q[s])}°`);
      const high = ['R', 'L'].filter(s => q[s] != null && q[s] > T.qFemale);
      out.q = q;
      out.findings.push({
        key: 'q',
        text: `Q-angle ${[part('R'), part('L')].filter(Boolean).join(' / ')}` + (high.length ? ` — ${high.map(s => TH[s]).join(' และ ')}สูงกว่าค่าปกติ` : ''),
        flag: high.length > 0,
      });
    }

    if (base && L.acrR && L.acrL) {
      const m = mid(L.acrR, L.acrL), width = Math.abs(L.acrR[0] - L.acrL[0]) || 1;
      const dx = m[0] - base[0], pct = Math.abs(dx) / width * 100;
      out.lines.push({ t: 'shift', from: [base[0], m[1]], to: m, ok: pct < T.shiftPct });
      out.findings.push(pct < T.shiftPct
        ? { key: 'shift', text: 'ลำตัวอยู่กึ่งกลางแนวดิ่ง', flag: false }
        : { key: 'shift', text: `ลำตัวเยื้องไปทาง${TH[sideOfDx(dx, v)]}${distText(Math.abs(dx), ctx.scale)}`, flag: true });
    }
  },

  posterior(L, out, ctx) {
    const v = 'posterior';
    const base = L.heelR && L.heelL ? mid(L.heelR, L.heelL) : L.heelR || L.heelL;
    if (base) { out.plumbX = base[0]; out.lines.push({ t: 'plumb', x: base[0] }); }
    const pelvisMid = L.psisR && L.psisL ? mid(L.psisR, L.psisL) : null;

    if (L.occ && L.c7) {
      const a = lean(L.c7, L.occ);
      out.lines.push({ t: 'seg', a: L.c7, b: L.occ, color: '#1e88e5' });
      out.findings.push(Math.abs(a) < T.headTilt
        ? { key: 'head', text: `ศีรษะตรง (${fmt(Math.abs(a))}°)`, flag: false }
        : { key: 'head', text: `ศีรษะเอียงไปทาง${TH[sideOfDx(a, v)]} (${fmt(Math.abs(a))}°)`, flag: true });
    }
    levelFinding(out, L, L.acrR, L.acrL, v, 'ไหล่', 'shoulder');
    levelFinding(out, L, L.scapR, L.scapL, v, 'มุมล่างสะบัก', 'scapLevel');
    levelFinding(out, L, L.psisR, L.psisL, v, 'เชิงกราน (PSIS) ', 'pelvis');

    if (L.c7 && pelvisMid) {
      out.lines.push({ t: 'seg', a: L.c7, b: pelvisMid, color: '#1e88e5', dash: true });
      const a = lean(pelvisMid, L.c7);
      out.findings.push(Math.abs(a) < T.trunkLean
        ? { key: 'trunk', text: `แนวกระดูกสันหลังตรง (${fmt(Math.abs(a))}°)`, flag: false }
        : { key: 'trunk', text: `ลำตัวเอียงไปทาง${TH[sideOfDx(a, v)]} (${fmt(Math.abs(a))}°)`, flag: true });

      if (L.scapR && L.scapL) {
        // distance of each inferior angle from the spinal line C7 → mid-PSIS
        const d = p => {
          const [a1, b1] = [L.c7, pelvisMid];
          return Math.abs((b1[0] - a1[0]) * (a1[1] - p[1]) - (a1[0] - p[0]) * (b1[1] - a1[1])) / (dist(a1, b1) || 1);
        };
        const dR = d(L.scapR), dL = d(L.scapL);
        const wide = dR > dL ? 'R' : 'L', diff = Math.abs(dR - dL) / Math.min(dR, dL) * 100;
        out.findings.push(diff < T.scapDiffPct
          ? { key: 'scap', text: 'ระยะสะบักจากแนวกระดูกสันหลังใกล้เคียงกัน', flag: false }
          : { key: 'scap', text: `สะบัก${TH[wide]}ห่างจากแนวกระดูกสันหลังมากกว่า${TH[other(wide)]} (สะบักเปิด)${distText(Math.abs(dR - dL), ctx.scale)}`, flag: true });
      }
    }
    if (base && L.c7) {
      const width = L.acrR && L.acrL ? Math.abs(L.acrR[0] - L.acrL[0]) : null;
      const dx = L.c7[0] - base[0];
      if (width) {
        const pct = Math.abs(dx) / width * 100;
        out.lines.push({ t: 'shift', from: [base[0], L.c7[1]], to: L.c7, ok: pct < T.shiftPct });
        if (pct >= T.shiftPct) out.findings.push({ key: 'shift', text: `ลำตัวส่วนบนเยื้องไปทาง${TH[sideOfDx(dx, v)]}${distText(Math.abs(dx), ctx.scale)}`, flag: true });
      }
    }
  },

  lateral(L, out, ctx) {
    if (!L.mall) return;
    out.plumbX = L.mall[0]; out.lines.push({ t: 'plumb', x: L.mall[0] });
    // which way the patient faces: the ear is in front of C7
    const facing = L.tragus && L.c7 ? Math.sign(L.tragus[0] - L.c7[0]) || 1 : null;
    const top = L.tragus || L.acr;
    const height = top ? Math.abs(L.mall[1] - top[1]) / 0.87 : null; // tragus sits at ~87% of stature
    const off = p => (p && facing ? (p[0] - L.mall[0]) * facing : null); // + = anterior
    const pct = px => (height ? px / height * 100 : 0);

    if (L.tragus && L.c7) {
      const cva = deg(Math.atan2(L.c7[1] - L.tragus[1], Math.abs(L.tragus[0] - L.c7[0])));
      out.lines.push({ t: 'cva', c7: L.c7, tragus: L.tragus, label: `CVA ${Math.round(cva)}°` });
      out.findings.push(cva < T.cvaForward
        ? { key: 'cva', text: `ศีรษะยื่นไปด้านหน้า (CVA ${Math.round(cva)}°, ปกติ ≥ ${T.cvaForward}°)`, flag: true }
        : { key: 'cva', text: `ตำแหน่งศีรษะปกติ (CVA ${Math.round(cva)}°)`, flag: false });
    }
    const parts = [
      ['tragus', 'ติ่งหู', 'ศีรษะอยู่หน้าแนวดิ่ง', 'ศีรษะอยู่หลังแนวดิ่ง'],
      ['acr', 'ไหล่', 'ไหล่อยู่หน้าแนวดิ่ง (ไหล่ห่อ / ยื่นไปด้านหน้า)', 'ไหล่อยู่หลังแนวดิ่ง'],
      ['gt', 'สะโพก', 'สะโพกยื่นไปด้านหน้าแนวดิ่ง (Sway back)', 'สะโพกอยู่หลังแนวดิ่ง'],
      ['knee', 'เข่า', 'เข่าอยู่หน้าแนวดิ่ง (เข่างอ)', 'เข่าอยู่หลังแนวดิ่ง (เข่าแอ่น / Hyperextension)'],
    ];
    for (const [id, , ahead, behind] of parts) {
      const p = L[id], o = off(p); if (o == null) continue;
      const ok = pct(Math.abs(o)) < T.sagittalPct;
      out.lines.push({ t: 'shift', from: [L.mall[0], p[1]], to: p, ok });
      if (!ok) out.findings.push({ key: id, text: (o > 0 ? ahead : behind) + distText(Math.abs(o), ctx.scale), flag: true });
    }
    if (facing == null && (L.acr || L.gt || L.knee)) out.findings.push({ key: 'facing', text: 'วางติ่งหูและ C7 ก่อน เพื่อให้ระบบรู้ทิศที่ผู้รับบริการหันหน้า', flag: false, note: true });
  },

  sls(L, out, ctx) {
    const v = 'posterior';
    if (L.heel) { out.plumbX = L.heel[0]; out.lines.push({ t: 'plumb', x: L.heel[0] }); }
    if (L.psisR && L.psisL) {
      const t = tilt(L.psisR, L.psisL), abs = Math.abs(t);
      out.lines.push({ t: 'level', a: L.psisR, b: L.psisL, label: `${fmt(abs)}°`, color: '#e3262e' });
      const lower = t > 0 ? other(rightSideIs(v)) : rightSideIs(v);
      out.findings.push(abs < T.levelSlight
        ? { key: 'pelvis', text: `ควบคุมระดับเชิงกรานได้ดี (${fmt(abs)}°)`, flag: false }
        : { key: 'pelvis', text: `เชิงกรานข้าง${TH[lower]}ตกลง ${fmt(abs)}° (Trendelenburg)`, flag: true });
      if (L.c7) {
        const pm = mid(L.psisR, L.psisL), a = lean(pm, L.c7);
        out.lines.push({ t: 'seg', a: pm, b: L.c7, color: '#1e88e5', dash: true });
        if (Math.abs(a) >= T.trunkLean) out.findings.push({ key: 'trunk', text: `ลำตัวเอียงไปทาง${TH[sideOfDx(a, v)]} ${fmt(Math.abs(a))}°`, flag: true });
      }
    }
  },

  squatBack(L, out) {
    const v = 'posterior';
    if (L.ankR && L.ankL) { const m = mid(L.ankR, L.ankL); out.plumbX = m[0]; out.lines.push({ t: 'plumb', x: m[0] }); }
    levelFinding(out, L, L.psisR, L.psisL, v, 'เชิงกราน (PSIS) ', 'pelvis');
    for (const s of ['R', 'L']) if (L['knee' + s] && L['ank' + s]) out.lines.push({ t: 'seg', a: L['ank' + s], b: L['knee' + s], color: '#f4c20d' });
    if (L.kneeR && L.kneeL && L.ankR && L.ankL) {
      const r = Math.abs(L.kneeR[0] - L.kneeL[0]) / (Math.abs(L.ankR[0] - L.ankL[0]) || 1);
      out.findings.push(r < T.kneeValgusRatio
        ? { key: 'valgus', text: `เข่าเคลื่อนเข้าด้านในขณะ Squat (Dynamic knee valgus; ระยะเข่า/ข้อเท้า ${fmt(r, 2)})`, flag: true }
        : { key: 'valgus', text: 'แนวเข่าอยู่ในแนวข้อเท้าขณะ Squat', flag: false });
    }
  },

  squatSide(L, out) {
    if (L.gt && L.acr) {
      out.lines.push({ t: 'seg', a: L.gt, b: L.acr, color: '#1e88e5' });
    }
    if (L.mall && L.knee) out.lines.push({ t: 'seg', a: L.mall, b: L.knee, color: '#f4c20d' });
    if (L.gt && L.acr && L.mall && L.knee) {
      const trunk = Math.abs(lean(L.gt, L.acr)), tibia = Math.abs(lean(L.mall, L.knee));
      out.lines.push({ t: 'text', at: L.acr, text: `ลำตัว ${Math.round(trunk)}°` });
      out.lines.push({ t: 'text', at: L.knee, text: `หน้าแข้ง ${Math.round(tibia)}°` });
      const d = trunk - tibia;
      out.findings.push(d > T.trunkTibiaDiff
        ? { key: 'trunk', text: `ลำตัวโน้มไปด้านหน้ามากกว่าแนวหน้าแข้ง ${Math.round(d)}° (ลำตัว ${Math.round(trunk)}°, หน้าแข้ง ${Math.round(tibia)}°)`, flag: true }
        : { key: 'trunk', text: `ลำตัวขนานกับแนวหน้าแข้ง (ลำตัว ${Math.round(trunk)}°, หน้าแข้ง ${Math.round(tibia)}°)`, flag: false });
    }
  },
};

/* analyze(photo, protocolId) → { lines, findings, plumbX, q }
 * photo.lm: { [landmarkId]: [x, y] }, photo.scale: pixels per cm (optional). */
function analyze(photo, protocolId) {
  const out = { lines: [], findings: [], plumbX: null, q: null };
  const fn = ANALYZE[protocolId];
  if (!fn || !photo || !photo.lm) return out;
  fn(photo.lm, out, { scale: photo.scale?.pxPerCm || null });
  return out;
}

window.PostureProtocol = { PROTOCOLS, analyze, THRESHOLDS: T, tilt, angleAt };
})();
