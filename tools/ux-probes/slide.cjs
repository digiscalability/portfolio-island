'use strict';
// Foot plant, bob, hip flexion and the 180° turn (E6d; MOT-04, MOT-20; B3).
// The audit's slide2.cjs and locomotion.cjs were session temp files and are
// gone, so this is rebuilt from ux-audit/results/motion.json:
//   MOT-04  the planted foot never stops: its best moment in any cycle is
//           33% of the body speed at a 5.32 u/s walk and 36% at an 8.12 u/s
//           run (bestPlantRatio; B3 wants under 0.12 at both)
//   MOT-20  a W -> S reversal peaks at 1603°/s, 90% of the turn in 217 ms
//
// Everything runs on the frozen sim at exactly 1/60 s (lib.FREEZE), driven by
// real key presses, so a frame is a frame on every machine. Rows:
//   plant     per leg, the sole is the centroid of the 8 lowest bind-pose
//             vertices skinned to legL / legR (World Law 3: measured, not
//             guessed). Each frame the lower sole's world speed over the body
//             speed (getTangentialSpeed); per gait cycle (a full walk phase)
//             its minimum. bestPlantRatio is the median of those minima.
//   bob       the frame of the body's lowest point in each half-cycle against
//             the nearest heel strike (the frame a sole becomes the lower one).
//             Read from SimplePlayer.getGaitState?.().bob when B3 exposes it,
//             else the model's radial height; null when nothing bobs.
//   flexion   peak hip flexion at the run speed: the quaternion angle of
//             legL / legR from their bind rest (never Euler: the rest is ±π).
//   turn180   W held at a walk, then S: the model's heading rate, peak °/s and
//             t90 (the time to 90% of the turn).
//
// The run key is the build's own: html[data-run-key] ('shift'), else Space
// (58c8849 runs on a held Space, jumping first; only grounded frames count).
//
//   npm run probe -- slide --dist dist --port <n> [--profile desktop]
const lib = require('./lib.cjs');

const DT = 1 / 60;

/** Page-side: the per-leg sole sets, the leg rests, and window.__slide.step(n). */
const SLIDE_LIB = () => {
  const sc = window.__app.scene;
  const P = sc.getPlayer();
  if (typeof P.ensureLimbBones === 'function') P.ensureLimbBones();
  const isl = sc.getIsland();
  const V3 = P.getWorldPosition().constructor;
  const model = P.gltfModel || P;
  const Q = model.quaternion.constructor;
  const M4 = model.matrixWorld.constructor;
  // Bind rests of legL / legR from the skeleton (local = parentBind^-1 * bind).
  const rest = {};
  const bone = {};
  const sets = { legL: [], legR: [] };
  model.traverse((o) => {
    if (!o.isSkinnedMesh || !o.skeleton) return;
    const mat = (Array.isArray(o.material) ? o.material[0] : o.material) || {};
    if (mat.name === 'Outline') return;
    const sk = o.skeleton;
    const bindW = (b) => {
      const i = sk.bones.indexOf(b);
      return i >= 0 ? new M4().copy(sk.boneInverses[i]).invert() : null;
    };
    for (const name of ['legL', 'legR']) {
      const b = sk.bones.find((x) => x.name === name);
      if (!b || rest[name]) continue;
      bone[name] = b;
      const w = bindW(b);
      const pw = b.parent ? bindW(b.parent) : null;
      const local = pw ? pw.invert().multiply(w) : w;
      const q = new Q();
      local.decompose(new V3(), q, new V3());
      rest[name] = q;
    }
    const g = o.geometry;
    const si = g.attributes.skinIndex;
    const sw = g.attributes.skinWeight;
    const pos = g.attributes.position;
    if (!si || !sw) return;
    for (let i = 0; i < pos.count; i++) {
      let bi = 0;
      let bw = -1;
      for (let k = 0; k < 4; k++)
        if (sw.getComponent(i, k) > bw) {
          bw = sw.getComponent(i, k);
          bi = si.getComponent(i, k);
        }
      const nm = sk.bones[bi] && sk.bones[bi].name;
      if ((nm === 'legL' || nm === 'legR') && bw > 0.5) sets[nm].push({ o, i, y: pos.getY(i) });
    }
  });
  for (const k of Object.keys(sets)) sets[k] = sets[k].sort((a, b) => a.y - b.y).slice(0, 8);
  const v = new V3();
  const sole = (k) => {
    const s = sets[k];
    if (!s.length) return null;
    const a = new V3();
    for (const { o, i } of s) {
      o.getVertexPosition(i, v);
      a.add(v.applyMatrix4(o.matrixWorld));
    }
    return a.divideScalar(s.length);
  };
  const surfR = (p) => isl.sampleSurfaceByDirection(p.clone().normalize(), 0).position.length();
  const angFromRest = (k) => {
    const b = bone[k];
    if (!b || !rest[k]) return null;
    const d = rest[k].clone().invert().multiply(b.quaternion);
    return 2 * Math.acos(Math.min(1, Math.abs(d.w)));
  };
  const fwd = () => {
    const d = new V3();
    model.getWorldDirection(d);
    return d;
  };
  const S = (window.__slide = {
    rows: [],
    step(n) {
      for (let i = 0; i < n; i++) {
        window.__step(1, 1 / 60);
        const p = P.getWorldPosition().clone();
        const up = p.clone().normalize();
        const sL = sole('legL');
        const sR = sole('legR');
        const gs = typeof P.getGaitState === 'function' ? P.getGaitState() : null;
        const mp = new V3();
        model.getWorldPosition(mp);
        const f = fwd();
        const ff = f.addScaledVector(up, -f.dot(up)).normalize();
        S.rows.push({
          speed: P.getTangentialSpeed(),
          g: P.getIsGrounded() ? 1 : 0,
          phase: P.getWalkCyclePhase ? P.getWalkCyclePhase() : null,
          p: [p.x, p.y, p.z],
          up: [up.x, up.y, up.z],
          sL: sL ? [sL.x, sL.y, sL.z] : null,
          sR: sR ? [sR.x, sR.y, sR.z] : null,
          hL: sL ? sL.length() - surfR(sL) : null,
          hR: sR ? sR.length() - surfR(sR) : null,
          bob: gs && typeof gs.bob === 'number' ? gs.bob : mp.length() - p.length(),
          fL: angFromRest('legL'),
          fR: angFromRest('legR'),
          f: [ff.x, ff.y, ff.z],
        });
      }
      return S.rows.length;
    },
    take() {
      const r = S.rows;
      S.rows = [];
      return r;
    },
  });
  return { soles: { legL: sets.legL.length, legR: sets.legR.length }, rests: Object.keys(rest), gaitState: typeof P.getGaitState === 'function' };
};

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a) => Math.sqrt(dot(a, a));
const tang = (d, up) => {
  const k = dot(d, up);
  return [d[0] - up[0] * k, d[1] - up[1] * k, d[2] - up[2] * k];
};
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/**
 * The plant, bob and flexion numbers of one steady stretch of rows. The sole
 * speeds are tangential world speeds (the body's own frame of reference is
 * the ground, so a planted sole reads 0).
 */
function gait(rows) {
  const fr = [];
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1];
    const b = rows[i];
    if (!a.g || !b.g || !a.sL || !b.sL || !a.sR || !b.sR) continue;
    const lower = b.hL <= b.hR ? 'L' : 'R';
    const s = lower === 'L' ? len(tang(sub(b.sL, a.sL), b.up)) / DT : len(tang(sub(b.sR, a.sR), b.up)) / DT;
    fr.push({ i, lower, ratio: b.speed > 0.5 ? s / b.speed : null, sole: s, speed: b.speed, phase: b.phase, bob: b.bob, flex: Math.max(b.fL || 0, b.fR || 0) });
  }
  // Cycles: a wrap of the walk phase starts a new one.
  const cycles = [];
  let cur = [];
  for (let k = 0; k < fr.length; k++) {
    if (k && fr[k].phase !== null && fr[k - 1].phase !== null && fr[k].phase < fr[k - 1].phase - 0.5) {
      if (cur.length) cycles.push(cur);
      cur = [];
    }
    cur.push(fr[k]);
  }
  const full = cycles.filter((c) => c.length >= 12);
  const mins = full.map((c) => {
    const r = c.filter((x) => x.ratio !== null);
    return r.length ? Math.min(...r.map((x) => x.ratio)) : null;
  }).filter((x) => x !== null);
  // Heel strikes: the frame a sole becomes the lower one.
  const strikes = [];
  for (let k = 1; k < fr.length; k++) if (fr[k].lower !== fr[k - 1].lower) strikes.push(fr[k].i);
  // Bob minima per half-cycle (between strikes), against the nearest strike.
  const bobs = fr.map((x) => x.bob);
  const bobRange = bobs.length ? Math.max(...bobs) - Math.min(...bobs) : 0;
  let bobOffsets = null;
  if (bobRange > 0.004 && strikes.length >= 3) {
    bobOffsets = [];
    for (let s = 0; s + 1 < strikes.length; s++) {
      const seg = fr.filter((x) => x.i >= strikes[s] - 4 && x.i < strikes[s + 1] - 4);
      if (seg.length < 4) continue;
      const lo = seg.reduce((m, x) => (x.bob < m.bob ? x : m), seg[0]);
      const near = strikes.reduce((m, st) => (Math.abs(st - lo.i) < Math.abs(m - lo.i) ? st : m), strikes[0]);
      bobOffsets.push(lo.i - near);
    }
  }
  return {
    frames: fr.length,
    speed: lib.round(lib.median(fr.map((x) => x.speed)), 2),
    cycles: full.length,
    cycleMins: mins.map((x) => lib.round(x, 3)),
    bestPlantRatio: mins.length ? lib.round(lib.median(mins), 3) : null,
    overallMin: mins.length ? lib.round(Math.min(...mins), 3) : null,
    bestSoleSpeed: full.length ? lib.round(lib.median(full.map((c) => Math.min(...c.map((x) => x.sole)))), 2) : null,
    meanLowerSoleSpeed: fr.length ? lib.round(lib.mean(fr.map((x) => x.sole)), 2) : null,
    bobRange: lib.round(bobRange, 4),
    bobOffsetFrames: bobOffsets,
    bobOffsetMedianAbs: bobOffsets && bobOffsets.length ? lib.median(bobOffsets.map(Math.abs)) : null,
    peakFlexRad: fr.length ? lib.round(Math.max(...fr.map((x) => x.flex)), 3) : null,
  };
}

/** Heading rate over a reversal: signed angle per frame about the local up. */
function turn(rows) {
  const deg = [];
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1].f;
    const b = rows[i].f;
    const up = rows[i].up;
    deg.push((Math.atan2(dot(cross(a, b), up), dot(a, b)) * 180) / Math.PI);
  }
  const cum = [];
  let c = 0;
  for (const d of deg) cum.push((c += d));
  const total = cum.length ? cum[cum.length - 1] : 0;
  const start = deg.findIndex((d) => Math.abs(d) > 0.05);
  const i90 = cum.findIndex((x) => Math.abs(x) >= 0.9 * Math.abs(total));
  const rates = deg.map((d) => Math.abs(d) / DT);
  return {
    totalDeg: lib.round(total, 1),
    peakDegPerS: rates.length ? Math.round(Math.max(...rates)) : null,
    t90ms: start >= 0 && i90 >= 0 ? Math.round((i90 - start + 1) * DT * 1000) : null,
  };
}

async function slide(t) {
  for (const prof of t.profiles(['desktop'])) {
    const s = await t.session(prof, { clock: true });
    await t.boot(s);
    const { page } = s;
    await lib.dismissWelcome(page);
    await page.waitForTimeout(1500);
    const runKeyAttr = await page.evaluate(() => document.documentElement.getAttribute('data-run-key'));
    const setup = await page.evaluate(SLIDE_LIB);
    if (!setup.soles.legL || !setup.soles.legR) throw new Error('hook missing: legL / legR skinned vertices on the player');
    await page.evaluate(lib.FREEZE);
    const step = (n) => page.evaluate((k) => window.__slide.step(k), n);
    const take = () => page.evaluate(() => window.__slide.take());
    await step(30);
    await take();
    const out = { runKeyAttr, setup };
    // ---- walk
    await page.keyboard.down('w');
    await step(90);
    await take();
    await step(240);
    out.walk = gait(await take());
    // ---- run (the build's own key)
    const key = runKeyAttr === 'shift' ? 'Shift' : ' ';
    await page.keyboard.down(key);
    await step(120);
    await take();
    await step(240);
    out.run = gait(await take());
    out.run.key = key === ' ' ? 'Space' : 'Shift';
    await page.keyboard.up(key);
    await step(90);
    await take();
    // ---- turn180 at a walk: W -> S
    await step(60);
    await take();
    await page.keyboard.up('w');
    await page.keyboard.down('s');
    await step(60);
    out.turn180 = turn(await take());
    await page.keyboard.up('s');
    await step(30);
    await page.evaluate(lib.THAW);
    t.data[prof] = out;

    const walkOk = out.walk.speed !== null && out.walk.speed > 4.5;
    const runOk = out.run.speed !== null && out.run.speed > 7;
    t.check(`${prof}: walk bestPlantRatio under 0.12 (B3)`, walkOk && out.walk.bestPlantRatio !== null ? out.walk.bestPlantRatio < 0.12 : null, { ratio: out.walk.bestPlantRatio, speed: out.walk.speed, cycles: out.walk.cycles }, '< 0.12 at about 5.6 u/s (58c8849: 0.33 at 5.32 u/s)');
    t.check(`${prof}: run bestPlantRatio under 0.12 (B3)`, runOk && out.run.bestPlantRatio !== null ? out.run.bestPlantRatio < 0.12 : null, { ratio: out.run.bestPlantRatio, speed: out.run.speed, key: out.run.key, cycles: out.run.cycles }, '< 0.12 at about 8.1 u/s (58c8849: 0.36 at 8.12 u/s)');
    t.check(`${prof}: the bob is lowest at heel strike (B3)`, out.walk.bobOffsetMedianAbs === null ? null : out.walk.bobOffsetMedianAbs <= 2, { walk: out.walk.bobOffsetMedianAbs, run: out.run.bobOffsetMedianAbs, range: out.walk.bobRange }, 'within 2 frames (null: no bob; 58c8849 has none)');
    t.check(`${prof}: peak hip flexion at the run 0.9 rad or less (B3)`, runOk && out.run.peakFlexRad !== null ? out.run.peakFlexRad <= 0.9 : null, out.run.peakFlexRad, '<= 0.9 rad (quaternion angle from the bind rest)');
    t.check(`${prof}: turn180 peak rate 720°/s or less (MOT-20)`, out.turn180.peakDegPerS !== null && Math.abs(out.turn180.totalDeg) > 120 ? out.turn180.peakDegPerS <= 720 : null, out.turn180, '<= 720°/s, t90 280-360 ms (58c8849: 1603°/s, 217 ms)');
  }
}

module.exports = {
  slide: { item: 'E6d (MOT-04, MOT-20; B3)', title: 'foot plant at the walk and run (bestPlantRatio), bob against heel strike, hip flexion, turn180', profiles: ['desktop'], run: slide },
  gait,
  turn,
};
