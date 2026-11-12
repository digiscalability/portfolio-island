'use strict';
// p2/L.cjs, the lighting probes' kit (P2-E1a, ported from the lighting
// audit's L.cjs onto lib.cjs; its harness parts are lib.cjs's now). In the
// page: window.__L (lon/lat placement, teleport, framing), the light-rig
// dump, the loop pause (SimpleRenderer stopRenderLoop / startRenderLoop /
// render, E's hooks) and the category mask: every drawable swapped to a flat
// MeshBasic colour per category (player, npc, ground, path, sea, sky, prop,
// label), keyed on SkyDome, userData.isPavement and isCelHull,
// island.surfaceMesh and npcTargets (B and C's hooks), restored after. In
// node: per-category CIE L* from a normal frame and its mask, region stats,
// and capturePair (normal + mask, loop paused between). The PNG reader is
// playwright-core's (lib.pngDecode). Wave 2's lighting probes (daycycle,
// beacons, weather, room-rig) build on it.
const fs = require('fs');
const lib = require('../lib.cjs');

// In-page helpers (after boot). Adds window.__L.
function installHelpers() {
  const app = window.__app;
  const sc = app.scene;
  const P = sc.getPlayer();
  const V3 = P.position.constructor;
  const isl = sc.getIsland();
  const cam = () => sc.getOrbitCamera();
  const H = (window.__L = {});
  H.V3 = V3;
  H.lonlat = (lon, lat) => new V3(Math.cos(lon) * Math.cos(lat), Math.sin(lat), Math.sin(lon) * Math.cos(lat)).normalize();
  H.tp = (dir, lift = 0.75) => {
    const d = dir.clone().normalize();
    const s = isl.sampleSurfaceByDirection(d, 0);
    const p = d.clone().multiplyScalar(s.position.length() + lift);
    P.setWorldPosition(p);
    return p;
  };
  H.north = (dir) => {
    const pole = new V3(0, 1, 0);
    const t = pole.clone().addScaledVector(dir, -pole.dot(dir));
    if (t.lengthSq() < 1e-6) return new V3(1, 0, 0);
    return t.normalize();
  };
  H.frame = (follow, pitch, dist) => {
    const c = cam();
    c.minPitch = -1.35;
    c.followDir = follow.clone().normalize();
    if (pitch != null) c.pitch = pitch;
    if (dist != null) {
      c.distanceTarget = dist;
      c.distance = dist;
    }
    c.snapToPlayer();
  };
  return { radius: isl.getRadius(), sea: isl.seaLevel() };
}

// ---- light rig dump ------------------------------------------------------
function rigDump() {
  const app = window.__app;
  const sc = app.scene;
  const sr = app.renderer;
  const R = sr.getRenderer();
  const hex = (c) => (c ? '#' + c.getHexString() : null);
  const v3 = (v) => (v ? [+v.x.toFixed(3), +v.y.toFixed(3), +v.z.toFixed(3)] : null);
  const lights = [];
  sc.traverse((o) => {
    if (!o.isLight) return;
    let vis = o.visible;
    let p = o.parent;
    let chainVis = vis;
    while (p) { if (!p.visible) chainVis = false; p = p.parent; }
    const e = { type: o.type, name: o.name || '', parent: o.parent ? (o.parent.name || o.parent.type) : null, visible: o.visible, chainVisible: chainVis, intensity: +o.intensity.toFixed(3), color: hex(o.color) };
    if (o.isHemisphereLight) e.groundColor = hex(o.groundColor);
    if (o.isPointLight || o.isSpotLight) { e.distance = o.distance; e.decay = o.decay; }
    if (o.isSpotLight) { e.angle = +o.angle.toFixed(3); e.penumbra = o.penumbra; }
    if (o.isDirectionalLight) { const d = o.position.clone().sub(o.target.position).normalize(); e.dir = v3(d); }
    e.castShadow = !!o.castShadow;
    if (o.castShadow && o.shadow) {
      const s = o.shadow;
      e.shadow = { mapSize: [s.mapSize.x, s.mapSize.y], bias: s.bias, normalBias: s.normalBias, radius: s.radius, intensity: s.intensity, autoUpdate: s.autoUpdate };
      if (s.camera && s.camera.isOrthographicCamera) e.shadow.ortho = [s.camera.left, s.camera.right, s.camera.top, s.camera.bottom, s.camera.near, s.camera.far];
      if (s.camera && s.camera.isPerspectiveCamera) e.shadow.persp = [s.camera.fov, s.camera.near, s.camera.far];
      if (s.map) e.shadow.mapAllocated = [s.map.width, s.map.height];
    }
    lights.push(e);
  });
  const env = sc.getEnvironmentCycle();
  const fog = sc.fog;
  const composer = sr.composer;
  const passes = composer ? composer.passes.map((p) => {
    const o = { name: p.constructor.name, enabled: p.enabled };
    if (p.strength !== undefined) { o.strength = p.strength; o.radius = p.radius; o.threshold = p.threshold; o.resolution = p.resolution ? [p.resolution.x, p.resolution.y] : null; }
    return o;
  }) : null;
  // counts that enter the program cache key: visible (chain) lights by type
  const counts = {};
  sc.traverseVisible((o) => { if (o.isLight) counts[o.type] = (counts[o.type] || 0) + 1; });
  let casters = 0, receivers = 0, castersVisible = 0;
  sc.traverse((o) => { if (o.isMesh || o.isInstancedMesh || o.isSkinnedMesh) { if (o.castShadow) casters++; if (o.receiveShadow) receivers++; } });
  sc.traverseVisible((o) => { if ((o.isMesh) && o.castShadow) castersVisible++; });
  return {
    hour: env ? env.getHour() : null,
    dayFactor: env ? +env.getDayFactor().toFixed(4) : null,
    weather: env ? env.getWeather() : null,
    lights,
    visibleLightCounts: counts,
    renderer: {
      toneMapping: R.toneMapping, exposure: R.toneMappingExposure, outputColorSpace: R.outputColorSpace,
      shadowMap: { enabled: R.shadowMap.enabled, type: R.shadowMap.type, autoUpdate: R.shadowMap.autoUpdate },
      pixelRatio: R.getPixelRatio(), size: [R.domElement.width, R.domElement.height],
      postEnabled: !!sr.postProcessingEnabled, composer: !!composer, passes,
      governor: { scale: sr.renderScale, rung: sr.qualityRung, ema: sr.fpsEma, armed: sr.governorArmed, halfShadow: sr.alwaysHalfShadow, frozen: sr.shadowFrozen },
      programs: R.info.programs ? R.info.programs.length : null,
    },
    fog: fog ? { type: fog.type || fog.constructor.name, color: hex(fog.color), density: fog.density } : null,
    background: sc.background ? (sc.background.isColor ? hex(sc.background) : 'tex') : null,
    environment: !!sc.environment,
    shadowCasters: casters, shadowReceivers: receivers, castersVisible,
  };
}

// The key light (the shadow-casting DirectionalLight): its elevation above the
// player's own horizon (asin(dir . up)), intensity, colour and shadow strength.
function sunState() {
  const sc = window.__app.scene;
  const up = sc.getPlayer().position.clone().normalize();
  let sun = null;
  sc.traverse((o) => { if (!sun && o.isDirectionalLight && o.castShadow) sun = o; });
  if (!sun) return null;
  const a = sun.getWorldPosition(up.clone());
  const b = sun.target.getWorldPosition(up.clone());
  const d = a.sub(b).normalize();
  const env = sc.getEnvironmentCycle();
  return {
    elevDeg: +((Math.asin(Math.max(-1, Math.min(1, d.dot(up)))) * 180) / Math.PI).toFixed(1),
    intensity: +sun.intensity.toFixed(3),
    color: '#' + sun.color.getHexString(),
    shadowIntensity: sun.shadow && typeof sun.shadow.intensity === 'number' ? +sun.shadow.intensity.toFixed(3) : null,
    hour: env ? +env.getHour().toFixed(2) : null,
    day: env ? +env.getDayFactor().toFixed(3) : null,
    weather: env && env.getWeather ? env.getWeather() : null,
  };
}

// ---- frame snapshot with category mask -------------------------------------
// Renders one normal frame (loop paused), then the same frame with every
// drawable swapped to a flat MeshBasic category colour (fog off). The caller
// screenshots after each render. Categories:
const CATS = {
  player: [0.6, 0.0, 0.6],
  npc: [0.0, 0.6, 0.6],
  ground: [0.6, 0.6, 0.0],
  path: [0.6, 0.3, 0.0],
  sea: [0.0, 0.0, 0.6],
  sky: [0.0, 0.6, 0.0],
  prop: [0.6, 0.0, 0.0],
  label: [0.0, 0.3, 0.3],
  // With { zones: true } the terrain is split by Island's own dark-zone rule
  // (the lamp scatter, 'no lamp on the beach band or up the highland
  // shoulder'): beach = dir.y < sin(0.32); highland = more than
  // MAX_DISPLACEMENT x 0.42 x reliefScale above the sea. C5's bound is
  // measured on these two (P2-E1b). frameStats reports them, plus groundAll
  // (the whole terrain, the audit's 'ground').
  beach: [0.3, 0.3, 0.0],
  highland: [0.3, 0.6, 0.0],
  // Night-emissive meshes (userData.isNightEmissive: windows, sconces, lamp
  // bulbs, beacons), with { bulbs: true }: P2-E5's bloom check.
  bulb: [0.6, 0.0, 0.3],
};
// Every category colour keeps one channel at 0. Under the composer (desktop)
// OutputPass tone-maps the mask too, toneMapped or not, and the Neutral curve
// subtracts 0.04 from a colour whose smallest channel is 0.08 or more: a
// colour with a zero channel comes through unchanged on both tiers.
function pauseLoop() {
  const sr = window.__app.renderer;
  sr.stopRenderLoop();
  return true;
}
function resumeLoop() {
  const sr = window.__app.renderer;
  sr.isRunning = false;
  sr.startRenderLoop(sr.scene, sr.camera, sr.renderCallback);
  return true;
}
function renderOnce() {
  const sr = window.__app.renderer;
  sr.render();
  return true;
}
function maskBegin(arg) {
  // Either the category table, or { cats, zones, bulbs }.
  const CATSIN = arg.cats || arg;
  const ZONES = !!arg.zones;
  const BULBS = !!arg.bulbs;
  const app = window.__app;
  const sc = app.scene;
  const player = sc.getPlayer();
  const isl = sc.getIsland();
  const terrain = isl.surfaceMesh;
  const swapped = [];
  const hidden = [];
  const matCache = {};
  let zoneSwap = null;
  // find a MeshBasicMaterial constructor in the scene
  let Basic = null;
  sc.traverse((o) => { if (!Basic && o.material && !Array.isArray(o.material) && o.material.type === 'MeshBasicMaterial') Basic = o.material.constructor; });
  const mk = (cat, side) => {
    const key = cat + ':' + side;
    if (matCache[key]) return matCache[key];
    const c = CATSIN[cat];
    const m = new Basic({ fog: false });
    m.color.setRGB(c[0], c[1], c[2], 'srgb-linear');
    m.toneMapped = false;
    m.side = side;
    matCache[key] = m;
    return m;
  };
  const isUnder = (o, root) => { let p = o; while (p) { if (p === root) return true; p = p.parent; } return false; };
  const npcRoots = new Set();
  try {
    for (const n of isl.npcTargets || []) if (n.meshRef) npcRoots.add(n.meshRef);
    for (const n of isl.getNPCInstances ? isl.getNPCInstances() : []) if (n.group) npcRoots.add(n.group);
  } catch (e) {}
  const underNpc = (o) => { let p = o; while (p) { if (npcRoots.has(p)) return true; if (p.userData && (p.userData.isNPC || p.userData.npc || p.userData.isVillager)) return true; p = p.parent; } return false; };
  sc.traverse((o) => {
    if (o.isSprite || o.isPoints || o.isLine) {
      if (o.visible) { hidden.push(o); o.visible = false; }
      return;
    }
    if (!o.isMesh) return;
    let cat = 'prop';
    const name = (o.name || '') + '|' + (o.parent ? o.parent.name || '' : '');
    if (isUnder(o, player)) cat = 'player';
    else if (underNpc(o)) cat = 'npc';
    else if (o === terrain) cat = 'ground';
    else if (o.userData && o.userData.isPavement) cat = 'path';
    else if (/sea|ocean|water/i.test(o.name || '') && !/fall/i.test(o.name)) cat = 'sea';
    else if (/sky/i.test(o.name || '')) cat = 'sky';
    else if (o.name === 'SkyDome') cat = 'sky';
    else if (o.material && o.material.type === 'ShaderMaterial' && o.geometry && o.geometry.boundingSphere && o.geometry.boundingSphere.radius > 500) cat = 'sky';
    else if (/^(sun|moon|stars)$/.test(o.name || '')) cat = 'sky';
    else if (/grass/i.test(o.name || '')) cat = 'ground';
    if (o.material && o.material.transparent && o.material.opacity < 0.05) cat = null;
    if (o.material && o.material.visible === false) cat = null;
    if (o.userData && o.userData.isCelHull) {
      // ink: inherit category
      cat = isUnder(o, player) ? 'player' : underNpc(o) ? 'npc' : 'prop';
    }
    if (!cat) { if (o.visible) { hidden.push(o); o.visible = false; } return; }
    if (BULBS && cat === 'prop' && o.userData && o.userData.isNightEmissive) cat = 'bulb';
    swapped.push([o, o.material]);
    const side = Array.isArray(o.material) ? 0 : o.material.side || 0;
    if (ZONES && o === terrain && o.geometry && o.geometry.attributes.position) {
      // The terrain by zone, as vertex colours on a flat material.
      const G = isl.constructor;
      const thr = (G.MAX_DISPLACEMENT || 0) * 0.42 * (isl.reliefScale || 1);
      if (thr > 0) {
        const g = o.geometry;
        const pos = g.attributes.position;
        const col = new Float32Array(pos.count * 3);
        const sea = isl.seaLevel();
        const beachY = Math.sin(0.32);
        o.updateWorldMatrix(true, false);
        const e = o.matrixWorld.elements; // the terrain mesh is rotated: classify in world space
        for (let i = 0; i < pos.count; i++) {
          const lx = pos.getX(i), ly = pos.getY(i), lz = pos.getZ(i);
          const x = e[0] * lx + e[4] * ly + e[8] * lz + e[12];
          const y = e[1] * lx + e[5] * ly + e[9] * lz + e[13];
          const z = e[2] * lx + e[6] * ly + e[10] * lz + e[14];
          const r = Math.sqrt(x * x + y * y + z * z) || 1;
          const c = CATSIN[r - sea > thr ? 'highland' : y / r < beachY ? 'beach' : 'ground'];
          col[i * 3] = c[0]; col[i * 3 + 1] = c[1]; col[i * 3 + 2] = c[2];
        }
        zoneSwap = { g, orig: g.attributes.color || null };
        g.setAttribute('color', new pos.constructor(col, 3));
        const m = new Basic({ fog: false, vertexColors: true });
        m.toneMapped = false;
        m.side = side;
        matCache['zones'] = m;
        o.material = m;
        return;
      }
    }
    o.material = mk(cat, side);
  });
  window.__L.mask = { swapped, hidden, matCache, zoneSwap };
  return { swapped: swapped.length, hidden: hidden.length, npcRoots: npcRoots.size, zones: !!zoneSwap };
}
function maskEnd() {
  const m = window.__L.mask;
  if (!m) return false;
  for (const [o, mat] of m.swapped) o.material = mat;
  for (const o of m.hidden) o.visible = true;
  if (m.zoneSwap) {
    if (m.zoneSwap.orig) m.zoneSwap.g.setAttribute('color', m.zoneSwap.orig);
    else m.zoneSwap.g.deleteAttribute('color');
  }
  for (const mat of Object.values(m.matCache)) if (mat && mat.dispose) mat.dispose();
  window.__L.mask = null;
  return true;
}

// ---- node-side image stats -------------------------------------------------
const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
const LUT = new Float64Array(256); for (let i = 0; i < 256; i++) LUT[i] = lin(i);
const Lstar = (Y) => (Y > 0.008856 ? 116 * Math.cbrt(Y) - 16 : 903.3 * Y);
function readPNG(f) { return lib.pngDecode(fs.readFileSync(f)); }
function classify(maskImg, x, y) {
  const k = (y * maskImg.width + x) * 4;
  const r = maskImg.data[k], g = maskImg.data[k + 1], b = maskImg.data[k + 2];
  let best = null, bd = 1e9;
  for (const [cat, c] of Object.entries(CATS)) {
    // expected sRGB of the linear category colour
    const er = Math.round(255 * enc(c[0])), eg = Math.round(255 * enc(c[1])), eb = Math.round(255 * enc(c[2]));
    const d = Math.abs(r - er) + Math.abs(g - eg) + Math.abs(b - eb);
    if (d < bd) { bd = d; best = cat; }
  }
  return bd <= 18 ? best : null;
}
function enc(x) { return x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055; }
// mean luminance -> L*, plus percentiles, for each category over the whole frame,
// and local player-vs-surroundings contrast.
function frameStats(normalFile, maskFile, opts = {}) {
  const A = readPNG(normalFile), M = readPNG(maskFile);
  const W = A.width, H = A.height;
  const acc = {};
  const catAt = new Array(W * H);
  let px0 = W, py0 = H, px1 = -1, py1 = -1;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const c = classify(M, x, y);
      catAt[y * W + x] = c;
      if (!c) continue;
      const k = (y * W + x) * 4;
      const Y = 0.2126 * LUT[A.data[k]] + 0.7152 * LUT[A.data[k + 1]] + 0.0722 * LUT[A.data[k + 2]];
      // The whole terrain too (the zones split it into ground, beach and highland).
      for (const key of c === 'ground' || c === 'beach' || c === 'highland' ? [c, 'groundAll'] : [c]) {
        const e = (acc[key] = acc[key] || { n: 0, sumY: 0, ys: [], r: 0, g: 0, b: 0 });
        e.n++; e.sumY += Y; e.r += A.data[k]; e.g += A.data[k + 1]; e.b += A.data[k + 2];
        if (e.ys.length < 400000) e.ys.push(Y);
      }
      if (c === 'player') { if (x < px0) px0 = x; if (x > px1) px1 = x; if (y < py0) py0 = y; if (y > py1) py1 = y; }
    }
  const out = { size: [W, H], cats: {} };
  for (const [c, e] of Object.entries(acc)) {
    e.ys.sort((a, b) => a - b);
    const q = (p) => e.ys[Math.min(e.ys.length - 1, Math.floor(p * e.ys.length))];
    // Y is the mean relative luminance (ratios between categories use it).
    out.cats[c] = { frac: +(e.n / (W * H)).toFixed(4), Lstar: +Lstar(e.sumY / e.n).toFixed(1), Y: +(e.sumY / e.n).toFixed(5), L10: +Lstar(q(0.1)).toFixed(1), L50: +Lstar(q(0.5)).toFixed(1), L90: +Lstar(q(0.9)).toFixed(1), rgb: [Math.round(e.r / e.n), Math.round(e.g / e.n), Math.round(e.b / e.n)] };
  }
  // local contrast: player vs non-player pixels in a ring around the player bbox
  if (px1 >= 0) {
    const bw = px1 - px0 + 1, bh = py1 - py0 + 1;
    // opts.ringPad: the ring's width as a share of the avatar's larger side
    // (0.6 by default; avlum uses 0.2, the room right around the avatar).
    const pad = Math.max(6, Math.round(Math.max(bw, bh) * (typeof opts.ringPad === 'number' ? opts.ringPad : 0.6)));
    const ring = { n: 0, sumY: 0 };
    const ringCats = {};
    for (let y = Math.max(0, py0 - pad); y <= Math.min(H - 1, py1 + pad); y++)
      for (let x = Math.max(0, px0 - pad); x <= Math.min(W - 1, px1 + pad); x++) {
        const c = catAt[y * W + x];
        if (!c || c === 'player') continue;
        const k = (y * W + x) * 4;
        const Y = 0.2126 * LUT[A.data[k]] + 0.7152 * LUT[A.data[k + 1]] + 0.0722 * LUT[A.data[k + 2]];
        ring.n++; ring.sumY += Y; ringCats[c] = (ringCats[c] || 0) + 1;
      }
    out.player = { bbox: [px0, py0, bw, bh], Lstar: out.cats.player ? out.cats.player.Lstar : null, ringLstar: ring.n ? +Lstar(ring.sumY / ring.n).toFixed(1) : null, ringCats };
    if (out.player.ringLstar != null && out.player.Lstar != null) out.player.dL = +(out.player.Lstar - out.player.ringLstar).toFixed(1);
  }
  // whole-frame
  let sumY = 0;
  for (let i = 0; i < W * H; i++) { const k = i * 4; sumY += 0.2126 * LUT[A.data[k]] + 0.7152 * LUT[A.data[k + 1]] + 0.0722 * LUT[A.data[k + 2]]; }
  out.frameLstar = +Lstar(sumY / (W * H)).toFixed(1);
  return out;
}
// Region stats (no mask): mean L*, mean rgb, hue.
function regionStats(file, x, y, w, h) {
  const A = readPNG(file);
  let n = 0, sumY = 0, r = 0, g = 0, b = 0;
  for (let j = y; j < Math.min(A.height, y + h); j++)
    for (let i = x; i < Math.min(A.width, x + w); i++) {
      const k = (j * A.width + i) * 4;
      sumY += 0.2126 * LUT[A.data[k]] + 0.7152 * LUT[A.data[k + 1]] + 0.0722 * LUT[A.data[k + 2]];
      r += A.data[k]; g += A.data[k + 1]; b += A.data[k + 2]; n++;
    }
  return { Lstar: +Lstar(sumY / n).toFixed(1), rgb: [Math.round(r / n), Math.round(g / n), Math.round(b / n)] };
}

async function shot(page, file, opts = {}) {
  await page.screenshot({ path: file, timeout: 90000, ...opts });
  return file.replace(/\\/g, '/');
}

// One measured view: normal frame + mask frame, loop paused between.
async function setUi(page, visible) {
  await page.evaluate((v) => { const el = document.getElementById('ui-overlay'); if (el) el.style.visibility = v ? '' : 'hidden'; for (const c of document.querySelectorAll('body > div')) { if (c.id !== 'ui-overlay' && c.querySelector && !c.querySelector('canvas') && c.dataset) { if (!v) { c.dataset.lHid = c.style.visibility || '-'; c.style.visibility = 'hidden'; } else if (c.dataset.lHid) { c.style.visibility = c.dataset.lHid === '-' ? '' : c.dataset.lHid; delete c.dataset.lHid; } } } }, visible);
}
async function capturePair(page, base, opts = {}) {
  if (opts.hideUi) await setUi(page, false);
  await page.evaluate(pauseLoop);
  await page.evaluate(renderOnce);
  await page.waitForTimeout(60);
  const a = await shot(page, base + '.png');
  const info = await page.evaluate(maskBegin, { cats: CATS, zones: !!opts.zones, bulbs: !!opts.bulbs });
  await page.evaluate(renderOnce);
  await page.waitForTimeout(60);
  const m = await shot(page, base + '.mask.png');
  await page.evaluate(maskEnd);
  await page.evaluate(renderOnce);
  await page.evaluate(resumeLoop);
  if (opts.hideUi) await setUi(page, true);
  return { a, m, info };
}

/** HSL hue (degrees) and saturation of an sRGB triple. */
function hueOf([r, g, b]) {
  const R = r / 255, G = g / 255, B = b / 255;
  const mx = Math.max(R, G, B), mn = Math.min(R, G, B);
  const d = mx - mn;
  if (d < 1e-6) return { hue: null, sat: 0 };
  let h = mx === R ? ((G - B) / d) % 6 : mx === G ? (B - R) / d + 2 : (R - G) / d + 4;
  h = (h * 60 + 360) % 360;
  const l = (mx + mn) / 2;
  return { hue: +h.toFixed(1), sat: +(d / (1 - Math.abs(2 * l - 1))).toFixed(3) };
}
/** The difference between two hues, in degrees (0-180). */
const hueDiff = (a, b) => (a === null || b === null ? null : Math.abs(((a - b + 540) % 360) - 180));
/** Relative luminance of an sRGB pixel at byte offset k. */
const lumAt = (img, k) => 0.2126 * LUT[img.data[k]] + 0.7152 * LUT[img.data[k + 1]] + 0.0722 * LUT[img.data[k + 2]];

module.exports = { setUi, installHelpers, rigDump, sunState, CATS, pauseLoop, resumeLoop, renderOnce, maskBegin, maskEnd, frameStats, regionStats, readPNG, classify, Lstar, LUT, lumAt, hueOf, hueDiff, shot, capturePair };
