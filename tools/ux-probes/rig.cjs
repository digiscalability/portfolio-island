'use strict';
// Rig probes (B1): the first-visit standing jump that spins the legs, and the
// swim / ride / sit poses that a limb-layer rewrite must leave unchanged.
//
// World Law 3 (measure the rig): every number here is read off the live
// player.glb bones, never inferred. The limb rest pose is ±π, so leg angles
// are reported as their wrapped distance from π.
const lib = require('./lib.cjs');

const BONES = ['hips', 'spine', 'head', 'armL', 'armR', 'legL', 'legR'];

/** Install the per-frame limb trace (rAF, live loop) and the hand-vertex set. */
const RIG_LIB = () => {
  const sc = window.__app.scene;
  const P = sc.getPlayer();
  if (typeof P.ensureLimbBones === 'function') P.ensureLimbBones();
  const V3 = P.position.constructor;
  // Right-hand vertices: armR-weighted (> 0.95) and the lowest 10% along the
  // limb, the motion audit's hand marker.
  const hand = [];
  P.gltfModel.traverse((o) => {
    if (!o.isSkinnedMesh) return;
    const mat = (Array.isArray(o.material) ? o.material[0] : o.material).name;
    if (mat === 'Outline') return;
    const g = o.geometry;
    const si = g.attributes.skinIndex;
    const sw = g.attributes.skinWeight;
    const pos = g.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      let bi = 0;
      let bw = -1;
      for (let k = 0; k < 4; k++)
        if (sw.getComponent(i, k) > bw) {
          bw = sw.getComponent(i, k);
          bi = si.getComponent(i, k);
        }
      if (o.skeleton.bones[bi].name === 'armR' && bw > 0.95) hand.push({ o, i, y: pos.getY(i) });
    }
  });
  hand.sort((a, b) => a.y - b.y);
  const handSet = hand.slice(0, Math.max(3, Math.floor(hand.length * 0.1)));
  const v = new V3();
  const handUp = () => {
    if (!handSet.length) return null;
    const a = new V3();
    for (const { o, i } of handSet) {
      o.getVertexPosition(i, v);
      a.add(v.applyMatrix4(o.matrixWorld));
    }
    a.divideScalar(handSet.length);
    const up = P.position.clone().normalize();
    return a.sub(P.position).dot(up);
  };
  const legs = () => ({
    legL: P.legLBone ? P.legLBone.rotation.x : null,
    legR: P.legRBone ? P.legRBone.rotation.x : null,
    armR: P.armRBone ? P.armRBone.rotation.x : null,
  });
  window.__rig = { P, legs, handUp, handVerts: handSet.length };
  return { handVerts: handSet.length, bones: !!(P.legLBone && P.legRBone && P.armRBone) };
};

const offPiDeg = (x) => {
  if (x === null || x === undefined) return null;
  let d = x - Math.PI;
  d = ((d % (2 * Math.PI)) + 3 * Math.PI) % (2 * Math.PI) - Math.PI;
  return lib.round((Math.abs(d) * 180) / Math.PI, 2);
};

/**
 * Step the frozen sim `n` frames at 1/60 s, recording grounded, limbs and the
 * hand height per frame (and, with census, which limbs the mixer rewrote).
 */
const STEP_RIG = ({ n, tag, census }) => {
  const R = window.__rig;
  const P = R.P;
  const bones = { armL: P.armLBone, armR: P.armRBone, legL: P.legLBone, legR: P.legRBone };
  const mixer = P.animationMixer;
  const orig = mixer.update;
  let cur = null;
  if (census) {
    mixer.update = function (dt) {
      const before = {};
      for (const [k, bn] of Object.entries(bones)) before[k] = bn.quaternion.clone();
      const r = orig.call(this, dt);
      for (const [k, bn] of Object.entries(bones)) cur[k] = cur[k] || !bn.quaternion.equals(before[k]);
      return r;
    };
  }
  const rows = [];
  const counts = { armL: 0, armR: 0, legL: 0, legR: 0 };
  for (let i = 0; i < n; i++) {
    cur = {};
    window.__step(1, 1 / 60);
    if (census) for (const k of Object.keys(counts)) if (cur[k]) counts[k]++;
    const l = R.legs();
    rows.push({ tag, g: P.getIsGrounded() ? 1 : 0, legL: l.legL, legR: l.legR, hand: R.handUp() });
  }
  if (census) mixer.update = orig;
  return { rows, counts };
};

/** Per-frame hand jumps from 4 frames before each touchdown to 10 after. */
const landingDeltas = (rows) => {
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    if (!(rows[i].g && !rows[i - 1].g)) continue;
    const d = [];
    for (let k = Math.max(1, i - 4); k < Math.min(rows.length, i + 10); k++) if (rows[k].hand !== null && rows[k - 1].hand !== null) d.push(lib.round(rows[k].hand - rows[k - 1].hand, 3));
    out.push(d);
  }
  return out;
};

async function legspin(t) {
  for (const prof of t.profiles(['desktop'])) {
    const s = await t.session(prof, { clock: true });
    const b = await t.boot(s);
    const { page } = s;
    await lib.dismissWelcome(page);
    await page.waitForTimeout(1500);
    const setup = await page.evaluate(RIG_LIB);
    if (!setup.bones) throw new Error('hook missing: SimplePlayer limb bones (legLBone/legRBone/armRBone)');
    // A first-visit standing jump on the frozen sim at exactly 1/60 s, driven
    // by a real Space press, so the airborne frame count (and so the spin) is
    // the same on every machine.
    await page.evaluate(lib.FREEZE);
    const run = (n, tag, census = false) => page.evaluate(STEP_RIG, { n, tag, census });
    const rows = [];
    rows.push(...(await run(30, 'settle')).rows);
    await page.evaluate(() => window.__render());
    await t.shot(page, `legspin-${prof}-before.png`);
    await page.keyboard.down('Space');
    rows.push(...(await run(2, 'jump1')).rows);
    await page.keyboard.up('Space');
    for (let k = 0; k < 8; k++) {
      const r = (await run(10, 'jump1')).rows;
      rows.push(...r);
      if (k === 1) {
        await page.evaluate(() => window.__render());
        await t.shot(page, `legspin-${prof}-air.png`);
      }
      if (r[r.length - 1].g && rows.some((x) => x.tag === 'jump1' && !x.g)) break;
    }
    rows.push(...(await run(48, 'landed')).rows);
    await page.evaluate(() => window.__render());
    await t.shot(page, `legspin-${prof}-after-landing.png`);
    const afterLanding = await page.evaluate(() => window.__rig.legs());
    const census = await run(300, 'idle', true);
    rows.push(...census.rows);
    rows.push(...(await run(300, 'idle')).rows);
    const after10s = await page.evaluate(() => window.__rig.legs());
    // Ordinary standing jumps after a short walk, for the landing hand jump.
    // The skipped-rewrite flail depends on the clip phase at touchdown, so the
    // jumps start at six different idle offsets.
    await page.keyboard.down('KeyW');
    rows.push(...(await run(60, 'walk')).rows);
    await page.keyboard.up('KeyW');
    rows.push(...(await run(90, 'rest')).rows);
    for (const [k, gap] of [30, 45, 60, 75, 90, 105].entries()) {
      const tag = `jump${k + 2}`;
      await page.keyboard.down('Space');
      rows.push(...(await run(2, tag)).rows);
      await page.keyboard.up('Space');
      rows.push(...(await run(70 + gap, tag)).rows);
    }
    await page.evaluate(lib.THAW);
    const air1 = rows.filter((r) => r.tag === 'jump1' && !r.g).length;
    const landings = landingDeltas(rows);
    const allDeltas = landings.flat();
    const maxHand = allDeltas.length ? Math.max(...allDeltas.map(Math.abs)) : null;
    const minLegL = Math.min(...rows.map((r) => r.legL));
    t.data[prof] = {
      boot: b,
      handVerts: setup.handVerts,
      firstJumpAirborneFrames: air1,
      afterLanding: { ...afterLanding, legLOffPiDeg: offPiDeg(afterLanding.legL), legROffPiDeg: offPiDeg(afterLanding.legR) },
      after10sIdle: { ...after10s, legLOffPiDeg: offPiDeg(after10s.legL), legROffPiDeg: offPiDeg(after10s.legR) },
      minLegLRad: lib.round(minLegL, 3),
      mixerRewritesIdle300: census.counts,
      landings: landings.map((d, i) => ({ landing: i + 1, handDeltaPerFrameU: d, maxAbs: d.length ? Math.max(...d.map(Math.abs)) : null })),
      maxAbsHandDeltaU: maxHand,
      trace: rows.filter((r, i) => r.tag === 'jump1' || i % 15 === 0).map((r) => [r.tag, r.g, lib.round(r.legL, 3), lib.round(r.legR, 3), lib.round(r.hand, 3)]),
    };
    for (const [when, l] of [
      ['after the first-visit standing jump', t.data[prof].afterLanding],
      ['after 10 s idle', t.data[prof].after10sIdle],
    ]) {
      t.check(`${prof}: legL within 1° of π ${when}`, l.legLOffPiDeg !== null && l.legLOffPiDeg <= 1, { rad: lib.round(l.legL, 3), offPiDeg: l.legLOffPiDeg }, '<= 1°');
      t.check(`${prof}: legR within 1° of π ${when}`, l.legROffPiDeg !== null && l.legROffPiDeg <= 1, { rad: lib.round(l.legR, 3), offPiDeg: l.legROffPiDeg }, '<= 1°');
    }
    t.check(`${prof}: no landing frame moves the hand more than 0.15 u`, maxHand !== null ? maxHand <= 0.15 : null, maxHand, '<= 0.15');
  }
}

// ------------------------------------------------------------------- rig
/** Bone positions in the player's local frame (independent of where it stands). */
const BONE_SAMPLE = (names) => {
  const P = window.__app.scene.getPlayer();
  P.updateMatrixWorld(true);
  const out = {};
  P.gltfModel.traverse((o) => {
    if (o.isBone && names.includes(o.name) && !(o.name in out)) {
      const w = o.getWorldPosition(new (P.position.constructor)());
      const l = P.worldToLocal(w);
      out[o.name] = [+l.x.toFixed(5), +l.y.toFixed(5), +l.z.toFixed(5)];
    }
  });
  return out;
};

async function rigSession(t, base) {
  const s = await t.session('desktop', { clock: true });
  const b = await t.boot(s, { base });
  const { page } = s;
  await lib.dismissWelcome(page);
  await page.waitForTimeout(2000);
  await page.evaluate(lib.FREEZE);
  const step = (n) => page.evaluate((n) => window.__step(n, 1 / 60), n);
  const reset = () =>
    page.evaluate(() => {
      const P = window.__app.scene.getPlayer();
      if (P.animationMixer) P.animationMixer.setTime(0);
    });
  const poses = {};
  // sit: the nearest bench.
  const sit = await page.evaluate(async () => {
    const h = window.__h;
    const bs = h.sc.benchGroups || [];
    const p = h.pos();
    let best = null;
    for (const g of bs) {
      const w = g.getWorldPosition(p.clone());
      const d = w.distanceTo(p);
      if (!best || d < best.d) best = { d, g, w };
    }
    if (!best) return null;
    h.tpNear(best.w, 1.2);
    window.__step(2, 1 / 60);
    h.sc.sitOnBench(best.g);
    return h.sc.isPlayerSeated();
  });
  if (sit) {
    await reset();
    await step(60);
    poses.sit = await page.evaluate(BONE_SAMPLE, BONES);
    await page.evaluate(() => window.__app.scene.standUpFromBench());
    await step(30);
  }
  // ride: the first car.
  const ride = await page.evaluate(() => {
    const sc = window.__app.scene;
    for (let i = 0; i < 16; i++) if (sc.vehicleKind(i) === 'car') {
      sc.boardVehicle(i);
      return sc.isRidingVehicle() ? i : null;
    }
    return null;
  });
  if (ride !== null) {
    await reset();
    await step(60);
    poses.ride = await page.evaluate(BONE_SAMPLE, BONES);
    await page.evaluate(() => window.__app.scene.disembarkVehicle());
    await step(30);
  }
  // swim: the nearest deep water, Space held (the swim intent).
  const swim = await page.evaluate(() => {
    const sc = window.__app.scene;
    const isl = sc.getIsland ? sc.getIsland() : sc.island;
    const P = sc.getPlayer();
    const V3 = P.position.constructor;
    const sea = isl.seaLevel();
    const here = P.position.clone().normalize();
    let best = null;
    const N = 6000;
    for (let i = 0; i < N; i++) {
      const y = 1 - (2 * (i + 0.5)) / N;
      const rr = Math.sqrt(1 - y * y);
      const th = i * Math.PI * (3 - Math.sqrt(5));
      const d = new V3(Math.cos(th) * rr, y, Math.sin(th) * rr);
      const ang = Math.acos(Math.min(1, d.dot(here)));
      if (best && ang >= best.ang) continue;
      if (!isl.isOverWater(d) || isl.sampleSurfaceByDirection(d, 0).position.length() >= sea - 2.5) continue;
      best = { ang, d };
    }
    if (!best) return null;
    P.setWorldPosition(best.d.clone().multiplyScalar(sea - 0.2));
    return true;
  });
  if (swim) {
    await page.keyboard.down('Space');
    await step(120);
    await reset();
    await step(60);
    poses.swim = await page.evaluate(BONE_SAMPLE, BONES);
    poses.swimState = await page.evaluate(() => {
      const P = window.__app.scene.getPlayer();
      return { inWater: P.isInWater ? P.isInWater() : null, swimming: P.isSwimming ? P.isSwimming() : null };
    });
    await page.keyboard.up('Space');
  }
  await page.evaluate(lib.THAW);
  return { boot: b, poses, sitOk: !!sit, rideVehicle: ride, swimOk: !!swim };
}

async function rig(t) {
  const subject = await rigSession(t, t.base);
  t.data.subject = subject;
  for (const pose of ['sit', 'ride', 'swim']) t.check(`${pose}: pose reached`, !!subject.poses[pose], !!subject.poses[pose], true);
  if (t.compareBase) {
    const cmp = await rigSession(t, t.compareBase);
    t.data.compare = cmp;
    for (const pose of ['sit', 'ride', 'swim']) {
      const a = subject.poses[pose];
      const c = cmp.poses[pose];
      if (!a || !c) {
        t.check(`${pose}: bone positions within 1e-3 u of the compare build`, null, 'pose missing on one side', 'both');
        continue;
      }
      let max = 0;
      const per = {};
      for (const bn of BONES) {
        if (!a[bn] || !c[bn]) continue;
        const d = Math.hypot(a[bn][0] - c[bn][0], a[bn][1] - c[bn][1], a[bn][2] - c[bn][2]);
        per[bn] = lib.round(d, 6);
        max = Math.max(max, d);
      }
      t.data[`${pose}Delta`] = per;
      t.check(`${pose}: max bone |Δ| vs the compare build (u)`, max <= 1e-3, lib.round(max, 6), '<= 0.001');
    }
  }
}

module.exports = {
  legspin: { item: 'B1', title: 'first-visit standing jump: legs vs π, mixer rewrites, landing hand jump', profiles: ['desktop'], run: legspin },
  rig: { item: 'B1', title: 'swim, ride and sit bone positions (--compare diffs two builds)', profiles: ['desktop'], compare: true, run: rig },
};
