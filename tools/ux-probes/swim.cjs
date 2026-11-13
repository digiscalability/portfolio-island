'use strict';
// Swim pops (E6d; MOT-08; B5). The audit's swim.cjs was a session temp file
// and is gone, so this is rebuilt from ux-audit/results/motion.json MOT-08:
// wading in, swimming, the tread/stroke gate, a dive, turning back and
// walking out popped the limbs and the body 48-151° in a single frame (entry:
// right arm 126°, left leg 53°; the 0.4 u/s gate: left arm 136° then 126°;
// the dive: both arms 48°; the exit: body pitch 77° and left arm 151°).
//
// The frozen sim at exactly 1/60 s, driven by real keys (W, S, Shift = dive in
// water on every build). Each frame records the quaternion of armL, armR,
// legL, legR and of the model (the body pitch). A pop is the quaternion angle
// between consecutive frames over 25°, never an Euler delta: the arms rest
// near Euler ±π, where rotation.x reads +3.13 one frame and -3.13 the next.
// B5 wants the pops array empty; its swim pose diff is `rig --compare`.
//
//   npm run probe -- swim --dist dist --port <n> [--profile desktop]
const lib = require('./lib.cjs');

const POP_DEG = 25;
const PARTS = ['armL', 'armR', 'legL', 'legR', 'body'];

/** Page-side: find the shore ahead, stand 5 u inland, and the recorder. */
const SWIM_LIB = () => {
  const h = window.__h;
  const sc = h.sc;
  const P = sc.getPlayer();
  if (typeof P.ensureLimbBones === 'function') P.ensureLimbBones();
  const isl = sc.getIsland();
  const V3 = h.V3;
  const model = P.gltfModel || P;
  const bones = {};
  model.traverse((o) => {
    if (o.isBone && ['armL', 'armR', 'legL', 'legR'].includes(o.name) && !bones[o.name]) bones[o.name] = o;
  });
  // March along the camera's heading until the ground is water.
  const up0 = h.up();
  const R = h.pos().length();
  const fwd = h.flat(h.camFwd(), up0).normalize();
  const axis = up0.clone().cross(fwd).normalize();
  let shore = null;
  for (let s = 2; s < 2 * Math.PI * R; s += 1) {
    const d = up0.clone().applyAxisAngle(axis, s / R);
    if (isl.isOverWater(d)) {
      shore = s;
      break;
    }
  }
  if (shore === null) return { shore: null };
  const dirAt = (s) => up0.clone().applyAxisAngle(axis, s / R);
  const stand = dirAt(shore - 5);
  const sfc = isl.sampleSurfaceByDirection(stand, 0);
  P.setWorldPosition(stand.clone().multiplyScalar(sfc.position.length() + 0.6));
  const target = dirAt(shore + 12).multiplyScalar(isl.seaLevel ? isl.seaLevel() : R);
  const S = (window.__swim = {
    rows: [],
    target,
    step(n, tag) {
      for (let i = 0; i < n; i++) {
        window.__step(1, 1 / 60);
        const pp = P.getWorldPosition();
        const r = { tag, swim: P.isSwimming ? (P.isSwimming() ? 1 : 0) : null, speed: P.getTangentialSpeed(), water: isl.isOverWater(pp.clone().normalize()) ? 1 : 0, toTarget: pp.distanceTo(target) };
        for (const [k, b] of Object.entries(bones)) r[k] = b.quaternion.toArray();
        r.body = model.quaternion.toArray();
        S.rows.push(r);
      }
      return S.rows.length;
    },
  });
  return { shore, bones: Object.keys(bones), standFromSpawn: shore - 5 };
};

/** Turn the chase camera until world point `target` sits dead ahead. */
const AIM = () => {
  const h = window.__h;
  const tgt = window.__swim.target;
  const b = h.bearing(tgt);
  h.rotateFollow(b);
  // The follow direction's sign is the camera's business: undo a wrong turn.
  if (Math.abs(h.bearing(tgt)) > Math.abs(b)) h.rotateFollow(-2 * b);
  return Math.round(h.bearing(tgt) * 10) / 10;
};

const qAngleDeg = (a, b) => {
  const d = Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]);
  return (2 * Math.acos(Math.min(1, d)) * 180) / Math.PI;
};

/** Every one-frame change over POP_DEG, per part, with the phase it happened in. */
function pops(rows) {
  const out = [];
  for (let i = 1; i < rows.length; i++)
    for (const k of PARTS) {
      if (!rows[i][k] || !rows[i - 1][k]) continue;
      const d = qAngleDeg(rows[i - 1][k], rows[i][k]);
      if (d > POP_DEG) out.push({ frame: i, tag: rows[i].tag, part: k, deg: Math.round(d), swim: rows[i].swim });
    }
  return out;
}

async function swim(t) {
  for (const prof of t.profiles(['desktop'])) {
    const s = await t.session(prof, { clock: true });
    await t.boot(s);
    const { page } = s;
    await lib.dismissWelcome(page);
    await page.waitForTimeout(1500);
    const setup = await page.evaluate(SWIM_LIB);
    if (setup.shore === null) throw new Error('no shore found ahead of the camera');
    if (setup.bones.length < 4) throw new Error('hook missing: armL / armR / legL / legR bones on the player');
    // Settle on the new spot with the live loop, then face the water.
    await page.waitForTimeout(800);
    let bearing = null;
    for (let k = 0; k < 4; k++) {
      bearing = await page.evaluate(AIM);
      await page.waitForTimeout(250);
    }
    await page.evaluate(lib.FREEZE);
    const step = (n, tag) => page.evaluate(([k, tg]) => window.__swim.step(k, tg), [n, tag]);
    const swimming = () => page.evaluate(() => window.__app.scene.getPlayer().isSwimming());
    await step(20, 'settle');
    const phases = {};
    // Wade in, and hold the swim button (Space on every build) once over water.
    const overWater = () => page.evaluate(() => {
      const r = window.__swim.rows;
      return r.length ? r[r.length - 1].water === 1 : false;
    });
    await page.keyboard.down('w');
    let k = 0;
    while (!(await overWater()) && k < 60) {
      await step(5, 'wade');
      k++;
    }
    await page.keyboard.down(' ');
    while (!(await swimming()) && k < 120) {
      await step(5, 'wade');
      k++;
    }
    phases.enteredAfterFrames = k * 5;
    await step(120, 'stroke');
    // The 0.4 u/s gate: let go to tread, then stroke again, twice.
    for (let r = 0; r < 2; r++) {
      await page.keyboard.up('w');
      await step(90, 'tread');
      await page.keyboard.down('w');
      await step(60, 'stroke');
    }
    await page.keyboard.up('w');
    // Dive and come back up.
    await page.keyboard.down('Shift');
    await step(90, 'dive');
    await page.keyboard.up('Shift');
    await step(120, 'ascend');
    // Turn back and walk out.
    await page.keyboard.down('s');
    k = 0;
    while (((await swimming()) || (await overWater())) && k < 120) {
      await step(5, 'turnback');
      k++;
    }
    phases.exitedAfterFrames = k * 5;
    await page.keyboard.up(' ');
    await step(60, 'walkout');
    await page.keyboard.up('s');
    await step(30, 'stand');
    const rows = await page.evaluate(() => window.__swim.rows);
    t.data.trace = rows.filter((_, i) => i % 30 === 0).map((r) => [r.tag, r.swim, r.water, +r.speed.toFixed(2), +r.toTarget.toFixed(1)]);
    await page.evaluate(lib.THAW);
    const p = pops(rows);
    const tags = [...new Set(rows.map((r) => r.tag))];
    const byTag = Object.fromEntries(tags.map((tg) => [tg, p.filter((x) => x.tag === tg).map((x) => `${x.part} ${x.deg}°`)]));
    const swamFrames = rows.filter((r) => r.swim).length;
    const out = { setup: { ...setup, bearing }, phases, frames: rows.length, swamFrames, pops: p, popsByPhase: byTag };
    t.data[prof] = out;
    const ran = swamFrames > 200 && phases.exitedAfterFrames < 120 * 5;
    t.check(`${prof}: the swim ran (entry, gate, dive, turn back, exit)`, ran ? true : null, { swamFrames, ...phases }, 'in the water 200+ frames and out again');
    t.check(`${prof}: no one-frame pop over ${POP_DEG}° (B5)`, ran ? p.length === 0 : null, p.length ? p.map((x) => `${x.tag} ${x.part} ${x.deg}°`).slice(0, 24) : [], `empty (58c8849: entry armR 126°, legL 53°; gate armL 136°/126°; dive arms 48°; exit body 77°, armL 151°)`);
  }
}

module.exports = {
  swim: { item: 'E6d (MOT-08; B5)', title: 'swim pops: wade in, stroke, the 0.4 u/s gate, dive, turn back, walk out; quaternion angle per frame over 25°', profiles: ['desktop'], run: swim },
  pops,
  qAngleDeg,
};
