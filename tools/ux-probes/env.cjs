'use strict';
// World juice (E6d; MOT-16, MOT-22; B9, C9). The audit's env_juice.cjs was a
// session temp file and is gone, so this is rebuilt from
// ux-audit/results/motion.json:
//   MOT-16  a collected coin rises 0.96 u over 0.45 s from where it touched
//           the player and shrinks; from the chase camera it stays inside the
//           avatar's silhouette in every frame (B9 wants it above the head in
//           4 or more of 8 frames)
//   MOT-22  tree canopy tops move 0.9-4.3 px over 6 s at 20-39 u (C9 wants
//           15-30 px per 6 s)
//
// Both rows are judged by rendered pixels, so 58c8849's per-mesh coin and
// B9's instanced one, and the group sway and C9's shader sway, are measured
// the same way (the wave-4 contracts). The frozen sim at 1/60 s, real keys.
//   coin    the nearest meadow coin ahead: the player stood 3.5 u short of it,
//           the chase camera turned to it, W held. From the frame the count
//           steps, 8 frames over 450 ms: a frame counts when coin-coloured
//           pixels (the hue of #ffd34a ±12°, saturated and bright) appear
//           above the head's projected top (the posed mesh's highest vertex)
//           in a crop around the player, beyond the frame before the pickup.
//           `ds:coin`'s detail is recorded when the build dispatches it.
//   canopy  the player idle and the camera held: every sway tree 20-40 u from
//           the camera whose canopy top projects inside the view with sky
//           above it. Each 100 ms for 6 s the topmost silhouette pixel in a
//           crop around it (the first row that leaves the sky colour of its
//           column); travel is the peak-to-peak excursion of that point.
//           The CPU projection of the group's own top point (the group sway
//           alone, GameScene's 0.018 rad x gust) is reported beside it, and
//           shaderOnly = pixel - CPU when the build sways in the shader (C9).
//
//   npm run probe -- env --dist dist --port <n> [--part coin|canopy]
const lib = require('./lib.cjs');

const GOLD_HUE = 45; // #ffd34a
const HUE_TOL = 12;

/** Page-side helpers: projection, the head top, coins and trees. */
const ENV_LIB = () => {
  const h = window.__h;
  const sc = h.sc;
  const P = sc.getPlayer();
  const V3 = h.V3;
  const model = P.gltfModel || P;
  const cam = () => sc.getCamera();
  const proj = (p) => {
    const v = p.clone().project(cam());
    return { x: ((v.x + 1) / 2) * innerWidth, y: ((1 - v.y) / 2) * innerHeight, z: v.z };
  };
  // The posed mesh's highest vertex over the feet (World Law 3: measured).
  const headTopH = () => {
    const p = P.getWorldPosition();
    const up = p.clone().normalize();
    const v = new V3();
    let best = 0;
    model.traverse((o) => {
      if (!o.isMesh || !o.geometry || !o.geometry.attributes.position || !o.visible) return;
      const a = o.geometry.attributes.position;
      const stride = Math.max(1, Math.floor(a.count / 600));
      for (let i = 0; i < a.count; i += stride) {
        if (o.isSkinnedMesh) o.getVertexPosition(i, v);
        else v.fromBufferAttribute(a, i);
        v.applyMatrix4(o.matrixWorld);
        best = Math.max(best, v.sub(p).dot(up));
      }
    });
    return best;
  };
  /** Meadow coins (never the trail's): per-mesh on 58c8849-fcaa649, or B9's list. */
  const coinList = () => {
    const out = [];
    const cs = sc.coins;
    if (Array.isArray(cs))
      for (const c of cs) {
        if (!c || c.trail) continue;
        const m = c.mesh;
        const pos = m && m.position ? m.position : c.position || c.pos || null;
        const vis = m ? m.visible : c.visible !== false && !c.collected;
        if (pos && vis) out.push(pos.clone ? pos.clone() : new V3(pos.x, pos.y, pos.z));
      }
    return out;
  };
  const E = (window.__env = { proj, headTopH, coinList, coinEvents: [] });
  window.addEventListener('ds:coin', (e) => E.coinEvents.push({ t: performance.now(), detail: e.detail ? JSON.parse(JSON.stringify(e.detail)) : null }));
  return { coins: coinList().length, swayTrees: (sc.swayTrees || []).length, fx: !!(window.__app.fx || window.__fx) };
};

/** Stand 3.5 u short of the nearest meadow coin and face it. */
const COIN_SETUP = () => {
  const h = window.__h;
  const sc = h.sc;
  const isl = sc.getIsland();
  const E = window.__env;
  const p = h.pos();
  const coins = E.coinList().filter((c) => c.clone().normalize().y > 0.35);
  if (!coins.length) return null;
  coins.sort((a, b) => a.distanceTo(p) - b.distanceTo(p));
  const c = coins[0];
  const up = c.clone().normalize();
  const toward = h.flat(p.clone().sub(c), up).normalize();
  if (toward.lengthSq() < 0.5) toward.copy(h.flat(new h.V3(1, 0, 0), up)).normalize();
  const dir = c.clone().addScaledVector(toward, 3.5).normalize();
  const sfc = isl.sampleSurfaceByDirection(dir, 0);
  sc.getPlayer().setWorldPosition(dir.multiplyScalar(sfc.position.length() + 0.6));
  E.coin = c;
  return { coinFrom: +c.distanceTo(p).toFixed(1) };
};
const AIM_COIN = () => {
  const h = window.__h;
  const tgt = window.__env.coin;
  const b = h.bearing(tgt);
  h.rotateFollow(b);
  if (Math.abs(h.bearing(tgt)) > Math.abs(b)) h.rotateFollow(-2 * b);
  return Math.round(h.bearing(tgt) * 10) / 10;
};
/** Step one frame, render, and say where the head is on screen. */
const COIN_FRAME = () => {
  const h = window.__h;
  const E = window.__env;
  window.__step(1, 1 / 60);
  window.__render();
  const p = h.pos();
  const up = p.clone().normalize();
  const top = E.proj(p.clone().addScaledVector(up, E.headH));
  const feet = E.proj(p);
  return { n: h.sc.getCoinsCollected(), top, feet };
};

/** Gold pixels in the crop above the head (above `topY`, within ±halfW of x). */
function goldAbove(png, x, topY, halfW = 70, height = 140) {
  const x0 = Math.max(0, Math.round(x - halfW));
  const x1 = Math.min(png.width - 1, Math.round(x + halfW));
  const y0 = Math.max(0, Math.round(topY - height));
  const y1 = Math.min(png.height - 1, Math.round(topY - 2));
  let n = 0;
  for (let y = y0; y <= y1; y++)
    for (let xx = x0; xx <= x1; xx++) {
      const i = (y * png.width + xx) * 4;
      if (isGold(png.data[i], png.data[i + 1], png.data[i + 2])) n++;
    }
  return n;
}
function isGold(r, g, b) {
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  if (mx < 140 || mx - mn < 0.45 * mx) return false;
  let hue;
  const d = mx - mn;
  if (mx === r) hue = (60 * ((g - b) / d) + 360) % 360;
  else if (mx === g) hue = 60 * ((b - r) / d) + 120;
  else hue = 60 * ((r - g) / d) + 240;
  return Math.abs(hue - GOLD_HUE) <= HUE_TOL;
}

async function coinPart(t, prof, s, out) {
  const { page } = s;
  const set = await page.evaluate(COIN_SETUP);
  if (!set) {
    out.coin = { why: 'no meadow coin list on this build' };
    t.check(`${prof}: the coin pops above the head in 4 or more of 8 frames (B9)`, null, out.coin, '>= 4 of 8 (58c8849: inside the silhouette in every frame)');
    return;
  }
  await page.waitForTimeout(900);
  for (let k = 0; k < 4; k++) {
    await page.evaluate(AIM_COIN);
    await page.waitForTimeout(250);
  }
  await page.waitForTimeout(600);
  await page.evaluate(lib.FREEZE);
  await page.evaluate(() => (window.__env.headH = window.__env.headTopH()));
  const n0 = await page.evaluate(() => window.__h.sc.getCoinsCollected());
  await page.keyboard.down('w');
  let prev = null;
  let prevShot = null;
  let hit = null;
  for (let f = 0; f < 150; f++) {
    const fr = await page.evaluate(COIN_FRAME);
    if (fr.n > n0) {
      hit = { frame: f, ...fr };
      break;
    }
    prev = fr;
    if (f % 2 === 0 || f > 20) prevShot = { fr, buf: await page.screenshot() };
  }
  await page.keyboard.up('w');
  if (!hit) {
    out.coin = { ...set, why: 'the coin was never collected' };
    t.check(`${prof}: the coin pops above the head in 4 or more of 8 frames (B9)`, null, out.coin, '>= 4 of 8');
    await page.evaluate(lib.THAW);
    return;
  }
  const base = prevShot ? goldAbove(lib.pngDecode(prevShot.buf), prevShot.fr.top.x, prevShot.fr.top.y) : 0;
  // 8 frames over 450 ms: 0, 4, 8, 12, 16, 20, 24, 27 frames after the step.
  const at = [0, 4, 8, 12, 16, 20, 24, 27];
  const frames = [];
  let cur = hit;
  let done = 0;
  for (const k of at) {
    while (done < k) {
      cur = await page.evaluate(COIN_FRAME);
      done++;
    }
    const buf = await page.screenshot();
    const png = lib.pngDecode(buf);
    const n = goldAbove(png, cur.top.x, cur.top.y);
    frames.push({ ms: Math.round((k * 1000) / 60), gold: n, above: n > base + 8, headTopY: Math.round(cur.top.y) });
    if (k === 8 || k === 16) {
      const c = { x: Math.max(0, cur.top.x - 120), y: Math.max(0, cur.top.y - 170), width: 240, height: 300 };
      await t.shot(page, `env-${prof}-coin-${Math.round((k * 1000) / 60)}ms.png`, { clip: c });
    }
  }
  await page.evaluate(lib.THAW);
  const events = await page.evaluate(() => window.__env.coinEvents.slice(0, 4));
  const above = frames.filter((f) => f.above).length;
  out.coin = { ...set, baseGold: base, frames, above, dsCoin: events.length ? events : null, prevFrame: prev ? Math.round(prev.top.y) : null };
  t.check(`${prof}: the coin pops above the head in 4 or more of 8 frames (B9)`, above >= 4, `${above} of 8`, '>= 4 of 8 (58c8849: inside the silhouette in every frame)');
  t.check(`${prof}: ds:coin's detail (B9; recorded, not judged)`, events.length ? true : null, events.length ? events[0].detail : null, '{x, y, value} once per pickup (null: no ds:coin on this build)');
}

/**
 * Stand 26 u from the n-th standing tree near the spawn, on land, and turn the
 * chase camera to 14° beside it (the avatar's head stays off the tree), so the
 * trees around it sit 20-40 u from the camera.
 */
const CANOPY_PLACE = (n) => {
  const h = window.__h;
  const sc = h.sc;
  const isl = sc.getIsland();
  const E = window.__env;
  const p = E.spawn || (E.spawn = h.pos());
  const R = p.length();
  const trees = (sc.swayTrees || []).filter((tr) => !tr.felled && tr.group && tr.group.visible).map((tr) => tr.group.position.clone());
  trees.sort((a, b) => a.distanceTo(p) - b.distanceTo(p));
  const c = trees[n * 7];
  if (!c) return null;
  const up = c.clone().normalize();
  for (let k = 0; k < 8; k++) {
    const ref = h.flat(p.clone().sub(c), up).normalize();
    if (ref.lengthSq() < 0.5) ref.copy(h.flat(new h.V3(1, 0, 0), up)).normalize();
    ref.applyAxisAngle(up, (k * Math.PI) / 4);
    const axis = up.clone().cross(ref).normalize();
    const dir = up.clone().applyAxisAngle(axis, 26 / R);
    if (isl.isOverWater && isl.isOverWater(dir)) continue;
    const sfc = isl.sampleSurfaceByDirection(dir, 0);
    sc.getPlayer().setWorldPosition(dir.multiplyScalar(sfc.position.length() + 0.6));
    E.aimAt = c.clone().addScaledVector(up, 4);
    return { tree: n * 7, treeFromSpawn: +c.distanceTo(p).toFixed(1), heading: k };
  }
  return null;
};
const AIM_TREE = () => {
  const h = window.__h;
  const tgt = window.__env.aimAt;
  const b = h.bearing(tgt) + 14;
  h.rotateFollow(b);
  if (Math.abs(h.bearing(tgt) + 14) > Math.abs(b)) h.rotateFollow(-2 * b);
  return Math.round(h.bearing(tgt) * 10) / 10;
};
/** Sway trees 20-40 u from the camera, the top projected in view and clear of the avatar. */
const CANOPY_CANDIDATES = () => {
  const h = window.__h;
  const sc = h.sc;
  const E = window.__env;
  const camPos = sc.getCamera().position.clone();
  let Box3 = null;
  sc.traverse((o) => {
    if (!Box3 && o.isMesh && o.geometry) {
      if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
      Box3 = o.geometry.boundingBox.constructor;
    }
  });
  const pp = h.pos();
  const pup = pp.clone().normalize();
  const a = E.proj(pp);
  const b = E.proj(pp.clone().addScaledVector(pup, 2.2));
  const avatar = { x0: Math.min(a.x, b.x) - 90, x1: Math.max(a.x, b.x) + 90, y0: Math.min(a.y, b.y) - 60, y1: Math.max(a.y, b.y) + 20 };
  const trees = [];
  (sc.swayTrees || []).forEach((tr, idx) => {
    if (tr.felled || !tr.group || !tr.group.visible) return;
    const g = tr.group;
    const d = g.position.distanceTo(camPos);
    if (d < 20 || d > 40) return;
    // The top in the group's own frame: Box3 with the group's transform cleared.
    const q = g.quaternion.clone();
    const ps = g.position.clone();
    const sl = g.scale.clone();
    g.quaternion.identity();
    g.position.set(0, 0, 0);
    g.scale.set(1, 1, 1);
    g.updateMatrixWorld(true);
    const parentInv = g.parent ? g.parent.matrixWorld.clone().invert() : null;
    const box = new Box3();
    g.traverse((o) => {
      if (!o.isMesh || !o.geometry) return;
      if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
      const bb = o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld);
      if (parentInv) bb.applyMatrix4(parentInv);
      box.union(bb);
    });
    g.quaternion.copy(q);
    g.position.copy(ps);
    g.scale.copy(sl);
    g.updateMatrixWorld(true);
    if (box.isEmpty()) return;
    const local = new h.V3((box.min.x + box.max.x) / 2, box.max.y, (box.min.z + box.max.z) / 2);
    const sp = E.proj(local.clone().applyMatrix4(g.matrixWorld));
    if (sp.z > 1 || sp.x < 60 || sp.x > innerWidth - 60 || sp.y < 120 || sp.y > innerHeight - 60) return;
    if (sp.x > avatar.x0 && sp.x < avatar.x1 && sp.y > avatar.y0 && sp.y < avatar.y1) return;
    trees.push({ idx, d: +d.toFixed(1), local: [local.x, local.y, local.z], sp: [Math.round(sp.x), Math.round(sp.y)] });
  });
  E.trees = trees;
  return trees;
};

/** 6 s at 100 ms on the frozen sim: a screenshot and the CPU-projected tops per sample. */
async function canopySamples(page) {
  await page.evaluate(lib.FREEZE);
  const samples = [];
  for (let k = 0; k <= 60; k++) {
    if (k) await page.evaluate(() => window.__step(6, 1 / 60));
    const cpu = await page.evaluate(() => {
      const h = window.__h;
      const E = window.__env;
      window.__render();
      return E.trees.map((tr) => {
        const g = h.sc.swayTrees[tr.idx].group;
        g.updateMatrixWorld(true);
        const p = E.proj(new h.V3(...tr.local).applyMatrix4(g.matrixWorld));
        return [p.x, p.y];
      });
    });
    samples.push({ png: lib.pngDecode(await page.screenshot()), cpu });
  }
  await page.evaluate(lib.THAW);
  return samples;
}

async function canopyPart(t, prof, s, out) {
  const { page } = s;
  const trees = [];
  out.canopyPlaces = [];
  for (let n = 0; n < 6 && trees.filter((x) => x.pixelPx !== null).length < 4; n++) {
    const place = await page.evaluate(CANOPY_PLACE, n);
    if (!place) continue;
    await page.waitForTimeout(900);
    for (let k = 0; k < 4; k++) {
      await page.evaluate(AIM_TREE);
      await page.waitForTimeout(250);
    }
    await page.waitForTimeout(1500);
    const cand = await page.evaluate(CANOPY_CANDIDATES);
    out.canopyPlaces.push({ ...place, candidates: cand.length });
    if (!cand.length) continue;
    await t.shot(page, `env-${prof}-canopy-${n}.png`);
    const samples = await canopySamples(page);
    cand.forEach((tr, i) => {
      const [cx, cy] = tr.sp;
      const W = 28;
      const pix = samples.map((sm) => silhouetteTop(sm.png, cx - W, cy - 30, 2 * W, 60));
      const clear = pix.every(Boolean) && pix[0].skyAbove;
      trees.push({ place: n, idx: tr.idx, d: tr.d, sp: tr.sp, cpuPx: lib.round(peak(samples.map((sm) => sm.cpu[i])), 2), pixelPx: clear ? lib.round(peak(pix.map((q) => [q.x, q.y])), 2) : null });
    });
  }
  if (!trees.length) {
    out.canopy = { why: 'no sway tree 20-40 u from the camera with its top in view' };
    t.check(`${prof}: canopy travel 15-30 px per 6 s at 20-40 u (C9)`, null, out.canopy, '15-30 px (58c8849: 0.9-4.3 px)');
    return;
  }
  const judged = trees.filter((x) => x.pixelPx !== null);
  const pixMed = judged.length ? lib.median(judged.map((x) => x.pixelPx)) : null;
  const cpuJudged = judged.length ? lib.median(judged.map((x) => x.cpuPx)) : null;
  out.canopy = {
    trees: trees.slice(0, 40),
    n: trees.length,
    judged: judged.length,
    pixelMedianPx: lib.round(pixMed, 2),
    pixelRangePx: judged.length ? [Math.min(...judged.map((x) => x.pixelPx)), Math.max(...judged.map((x) => x.pixelPx))] : null,
    cpuMedianPx: lib.round(lib.median(trees.map((x) => x.cpuPx)), 2),
    cpuRangePx: [Math.min(...trees.map((x) => x.cpuPx)), Math.max(...trees.map((x) => x.cpuPx))],
    shaderOnlyPx: pixMed !== null && cpuJudged !== null ? lib.round(pixMed - cpuJudged, 2) : null,
  };
  t.check(`${prof}: canopy travel 15-30 px per 6 s at 20-40 u (C9)`, judged.length >= 2 ? pixMed >= 15 && pixMed <= 30 : null, { pixelMedianPx: out.canopy.pixelMedianPx, pixelRangePx: out.canopy.pixelRangePx, shaderOnlyPx: out.canopy.shaderOnlyPx, judged: judged.length }, '15-30 px from pixels (58c8849: 0.9-4.3 px)');
  t.check(`${prof}: the group sway alone (CPU projection, reported)`, true, { medianPx: out.canopy.cpuMedianPx, rangePx: out.canopy.cpuRangePx }, 'reported (58c8849: 0.9-4.3 px)');
}

/** Peak-to-peak excursion (px) of a 2-D track: the largest distance between two of its points. */
function peak(pts) {
  let m = 0;
  for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) m = Math.max(m, Math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1]));
  return m;
}

/**
 * The topmost silhouette point in a crop: per column, the first row whose
 * colour leaves that column's top pixel (the sky) by more than 40 (sum of
 * |dRGB|). Returns the topmost row's y and the mean x of its hits, sub-pixel
 * by the hit count of the top two rows. skyAbove: the crop's top row is sky
 * (blue over red) in every column and the silhouette starts below it.
 */
function silhouetteTop(png, x0, y0, w, h) {
  x0 = Math.max(0, Math.round(x0));
  y0 = Math.max(0, Math.round(y0));
  const tops = [];
  let skyRow = 0;
  let cols = 0;
  for (let x = x0; x < Math.min(png.width, x0 + w); x++) {
    const i0 = (y0 * png.width + x) * 4;
    const sky = [png.data[i0], png.data[i0 + 1], png.data[i0 + 2]];
    cols++;
    if (sky[2] > 140 && sky[2] > sky[0] + 15) skyRow++;
    for (let y = y0 + 1; y < Math.min(png.height, y0 + h); y++) {
      const i = (y * png.width + x) * 4;
      if (Math.abs(png.data[i] - sky[0]) + Math.abs(png.data[i + 1] - sky[1]) + Math.abs(png.data[i + 2] - sky[2]) > 40) {
        tops.push([x, y]);
        break;
      }
    }
  }
  if (!tops.length) return null;
  const minY = Math.min(...tops.map((p) => p[1]));
  const near = tops.filter((p) => p[1] <= minY + 2);
  return { x: lib.mean(near.map((p) => p[0])), y: lib.mean(near.map((p) => p[1])), skyAbove: minY > y0 + 3 && skyRow === cols };
}

async function env(t) {
  const part = String(t.args.part || 'all');
  for (const prof of t.profiles(['desktop'])) {
    const out = {};
    if (part === 'all' || part === 'canopy') {
      const s = await t.session(prof, { clock: true });
      await t.boot(s);
      await lib.dismissWelcome(s.page);
      await s.page.waitForTimeout(2500);
      out.setup = await s.page.evaluate(ENV_LIB);
      await canopyPart(t, prof, s, out);
      await s.close();
    }
    if (part === 'all' || part === 'coin') {
      const s = await t.session(prof, { clock: true });
      await t.boot(s);
      await lib.dismissWelcome(s.page);
      await s.page.waitForTimeout(1500);
      out.setup = await s.page.evaluate(ENV_LIB);
      await coinPart(t, prof, s, out);
      await s.close();
    }
    t.data[prof] = out;
  }
}

module.exports = {
  env: { item: 'E6d (MOT-16, MOT-22; B9, C9)', title: 'world juice by pixels: the coin pop above the head (8 frames over 450 ms), canopy travel per 6 s at 20-40 u (`--part coin|canopy`)', profiles: ['desktop'], run: env },
  isGold,
  ENV_LIB,
  COIN_SETUP,
  AIM_COIN,
  COIN_FRAME,
  peak,
  silhouetteTop,
};
