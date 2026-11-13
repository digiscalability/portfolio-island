#!/usr/bin/env node
'use strict';
// npm run perf:gate -- the perf gate for production builds (stage-1 item E1).
//
//   perf:gate -- --dist dist --port 5191                 baseline report + counter and µs budget checks
//   perf:gate -- --base http://127.0.0.1:5191            the same, attached to a running preview
//   perf:gate -- --dist dist --port 5191 --fx <name>     one __dsFx effect: per-view draws and programs, then 6 x 1.5 s per side
//   perf:gate -- --ab <distA> <distB> --ports pA,pB [--cycles 6]   whole build B against A, ABAB, fresh context per cycle
//   perf:gate -- --rejudge <perf-gate-ab.json>           the verdict maths again on a saved A/B's loads (no browser)
//   perf:gate -- --dist dist --port 5191 --dusk          the dusk check alone: ?hour=17, then the clock to 17.5 after the warm
//   perf:gate -- --dist dist --port 5191 --governor      E3: the lowtier4x profile (390x844 DPR 2 touch, 4x CPU, no timer
//                                                         queries), governor live: renderScale and fps after 30 s
//   perf:gate -- --dist dist --port 5191 --gpuheavy      E3: the 1x low tier with ?gpuheavy=1: renderScale under 0.9 within 20 s
//   add --seed to compare window.__dsSeedDraws with the subject's test/golden/seedDraws.json (--golden <path> overrides)
//   add --dusk to --ab for the dusk check on each side (side B is held to it)
//   --profiles desktop,lowtier,startup  (default: all three; --fx and --dusk use desktop,lowtier)
//   --hour <h|live>                                       the world clock (default 12: noon, as the audit measured);
//                                                         --hour 21 is the night run: the card, the longest task before it, programs at +30 s
//   --out <dir>                                           JSON + ledger.md (default <os tmpdir>/ux-probes/perf-gate)
//
// Profiles: desktop 1440x900 DPR 1; low tier 390x844 touch DPR 2 at 1x CPU;
// startup-only at 4x CPU with GPU timer queries off (they inflate throttled
// CPU time by ~15%). Hardware GL (ANGLE D3D11 on Windows; PERF_GL overrides).
//
// Views per load, after the card: idle spawn, hub-wide and Projects (posed);
// then the vehicle view (the car nearest the land circuit's start, W held 3 s
// down the leg from ring 0 toward ring 1) and the room view (the Professional
// hall by its door: the first door's longest frame, the black interval by
// pixels, the programs it adds, then the steady room's draws and render p50).
//
// Verdict per metric (plan-r3 › perfBudget, critique-r3), against T, the
// budget, and the metric's floor from tools/perf-gate.floor.json (a 24-cycle
// A/A on this rig):
// - timings (sigma rule): valid when sigma <= T/2; pass when valid and
//   delta <= T; fail when valid and delta > T + sigma; anything else is
//   inconclusive, and the run escalates to 2x cycles, up to 24. delta = median
//   of the paired (B - A) cycle differences; sigma = the 95% band of delta,
//   t(n-1) x 1.2533 x SD/sqrt(n) over those differences. A timing's floor is
//   that sigma at 24 cycles; a timing whose T is below 2 x its floor cannot
//   resolve on this rig: CPU is judged by its proxy (FxBudget µs per effect)
//   and the rest are reported 'unresolvable', and the report says so. CPU
//   p95 whose sigma is still over T/2 at 24 cycles is judged by the proxy
//   too, when side B has FxBudget timings. A paired sign test fails any
//   timing, valid or not, when nearly every pair is over T (19 of 24, 11 of
//   12: one-sided 0.005), so a shift every pair agrees on fails although a
//   bimodal side inflates sigma. The same test passes a timing the sigma
//   rule left inconclusive when, at 24 cycles or more, no pair is over T
//   (wave-1 re-verify: welcome_visible 578 ms earlier, 22 of 24 pairs earlier
//   and 0 over T, read inconclusive on sigma 369 against T/2 75). A median
//   shift of T or more gives 0 of 24 with probability 6e-8 or less. For
//   welcome_visible the pairs counted are the cycle-order ones, since the
//   mode-matched pairing can leave as few as 7.
// - counters (draws, triangles, programs, nodes, long tasks, bytes): delta =
//   median(B) - median(A), except programs, which ride the boot race and are
//   judged on its mix (judgeMixCounter: each side's mode medians weighted by
//   how often each mode came up). Pass when delta <= max(T, floor); fail when
//   delta > max(T, floor) + sigma, or > max(T, floor) at 24 cycles; else
//   inconclusive. Improvements always pass. A counter's floor is its A/A
//   spread (aaSpread: the 99th percentile of |delta| over resampled 24-cycle
//   A/As, with the counter's own statistic).
// - texture MB is the one exact counter: equal on every A/A load.
// welcome_visible is stratified by the boot-race mode (on s1-int, desktop
// programs 154 or 165) and compared like with like; when one side has one
// mode (wave 1: main 154/158/165 against the build's 160) the pairs cannot
// be matched and stay in cycle order, and the sign test judges a shift (the
// JSON's strata give each side's modes). Every load checks the
// hub-wide and Projects poses, and a pitch that differs between the builds by
// more than 0.01 rad makes the run inconclusive. Every load records the share
// of the machine other processes took (otherBusyPct).
// Exit codes: 0 pass, 1 budget fail, 2 fail-closed (a request got past the
// harness), 3 inconclusive. Shares the probes' safety harness (lib.cjs).
//
//   --record-floor (with --ab <dist> <dist>): run 24 cycles, keep the verdicts
//   at 6, 12 and 24, and write each metric's floor to the floor file
//   (--floor <file> reads or writes another one), marked quiet or busy by
//   what other processes took while it ran.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const lib = require('./ux-probes/lib.cjs');
// The room view enters by the door with the room probes' kit and judges the
// black interval with hitch's screencast.
const R = require('./ux-probes/p2/room-lib.cjs');
const F = require('./ux-probes/frames.cjs');

// ---------------------------------------------------------------- budgets
// plan-r3 perfBudget. CPU p50 has no budget (report-only); the startup
// budgets for the 1x profiles are desktop's, the 'startup' profile is 4x.
// P2-E3 adds the vehicle view (draws, as for the Projects view) and the room
// view: its draws against main, and two absolute bars on the first door (the
// longest frame of the entry and the programs it adds).
const THRESHOLDS = {
  desktop: { cpuP95: 1.0, gpuP50: 2.0, drawsSpawn: 50, drawsHub: 80, drawsProjects: 60, drawsVehicle: 60, drawsRoom: 25, roomFirstDoorMs: 100, roomProgramsAdded: 3, programs: 5, welcomeMs: 150, worldGenMs: 50, longTasksBeforeCard: 1, longestTaskBeforeCardMs: 50, bytesBeforeCardKB: 50 },
  lowtier: { cpuP95: 0.75, drawsSpawn: 20, drawsHub: 30, drawsProjects: 25, drawsVehicle: 25, drawsRoom: 0, roomFirstDoorMs: 200, roomProgramsAdded: 3, programs: 3, nodes: 150, textureMB: 6, bytesBeforeCardKB: 50 },
  startup: { welcomeMs: 400, worldGenMs: 200, longTasksBeforeCard: 2, longestTaskBeforeCardMs: 50, bytesBeforeCardKB: 50 },
};
// The dusk check (P2-B6, P2-C4): no long task of this or more crossing 17:00 to 17:30.
const DUSK_LONGEST_MS = 100;
// What an effect is expected to SAVE (a credit: B - A at or below it), which
// --fx <name> holds it to beside the budgets. E2 with P2-E4's restated
// acceptance: on the low tier half-rate shadows save 0.6 ms of GPU p50 and
// 0.4 ms of mean CPU (the mean, because frames alternate with and without the
// shadow pass, so p50 hides it), and the spawn view's 94-95 shadow draws a
// frame become 47.5 +-3. Desktop stays at full rate (decision 12).
const FX_CREDIT = {
  halfShadow: {
    lowtier: { gpuP50: -0.6, cpuMean: -0.4, shadowDrawsSpawn: { value: 47.5, tol: 3 } },
    desktop: { shadowDrawsUnchanged: true },
  },
};
// FxBudget µs per frame: each effect, and the sum of every effect.
const FX_US = { desktop: 150, lowtier: 80, totalDesktop: 600, totalLowtier: 300 };
// plan-r3's per-effect ledger (µs/frame), which --fx <name> also holds an effect to.
const FX_LEDGER = {
  lookFling: 20,
  guide: 30,
  camRays: { desktop: 50, lowtier: 40 },
  gait: 60,
  squash: 5,
  swim: 10,
  npcGait: 80,
  npcTalk: 20,
  coins: 20,
  avatarFade: 5,
  idleLife: { desktop: 40, lowtier: 15 },
  pins: 0,
  dust: 15,
};
const ledgerUs = (name, prof) => {
  const v = FX_LEDGER[name];
  if (v === undefined || v === null) return null;
  return typeof v === 'number' ? v : v[prof] ?? null;
};
// A/A bands recorded by --record-floor.
const FLOOR_FILE = path.join(__dirname, 'perf-gate.floor.json');
function loadFloor(file) {
  const f = lib.readJson(file);
  return f && typeof f === 'object' ? f : null;
}
const floorOf = (floor, prof, metric) => {
  const p = floor && floor.profiles && floor.profiles[prof];
  const v = p ? p[metric] : undefined;
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
};
// Main 58c8849 on the audit rig (RTX 5070, Ryzen 7 7700), noon. The plan's
// numbers, except the low-tier spawn draws: the plan's ~627 came from a 4x
// run on the live afternoon clock with the governor free; this gate's
// whole-frame count at noon, 1x, governor pinned, reads 658 on main. The
// default mode checks programs and spawn draws against these plus the
// budget; the A/B mode (against main's own dist) is the authoritative check.
const BASELINE = {
  desktop: { idleCpuP95: 16.4, programs: 216, programsTol: 5, draws: { spawn: 658, hub: 1777, projects: 1233 } },
  lowtier: { programs: 118, programsTol: 3, draws: { spawn: 658 } },
};
// The posed views, in measuring order. A view is a POSE ({ view }) plus the
// time the world needs to settle after it, and its draw budget key. P2-E3's
// vehicle and room views follow them in a load (vehicleView, roomView): they
// are driven, not posed, so --fx does not pair them.
const VIEW_DEFS = [
  { name: 'spawn', settleMs: 0, fxSettleMs: 600, drawKey: 'drawsSpawn', poseCheck: false },
  { name: 'hub', settleMs: 1200, fxSettleMs: 1200, drawKey: 'drawsHub', poseCheck: true },
  { name: 'projects', settleMs: 1500, fxSettleMs: 1500, drawKey: 'drawsProjects', poseCheck: true },
];
const VIEWS = VIEW_DEFS.map((v) => v.name);
const DRAW_KEY = Object.fromEntries(VIEW_DEFS.map((v) => [v.name, v.drawKey]));
const POSE_TOL_RAD = 0.01;

// ------------------------------------------------------------ page hooks
// Installed before any page script: per-app-frame CPU (the update callback
// plus render()), GPU timer queries around render() unless disabled, program
// accounting per render() / composer render / compile call, long tasks and
// the welcome-card mark.
const GATE_INIT = (opts) => `(() => {
  if (window.top !== window) return;
  const OPTS = ${JSON.stringify(opts)};
  const G = (window.__gate = { frames: [], longtasks: [], renders: [], compiles: [], welcomeAt: null, hooked: false, err: null, shadowNow: 0 });
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) G.longtasks.push([Math.round(e.startTime), Math.round(e.duration)]); }).observe({ type: 'longtask', buffered: true }); } catch (e) {}
  const W = '[role=dialog][aria-label="Welcome to DigiScalability Life Island"]';
  const tick = () => {
    if (G.welcomeAt === null) {
      const w = document.querySelector(W);
      if (w && w.innerHTML.length > 50) G.welcomeAt = performance.now();
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  let inCompile = 0, inComposer = 0;
  const install = () => {
    const app = window.__app;
    const sr = app && app.renderer;
    if (!sr || typeof sr.renderCallback !== 'function' || typeof sr.getRenderer !== 'function') return false;
    const R = sr.getRenderer();
    const gl = R.getContext();
    const ext = OPTS.nogpu ? null : gl.getExtension('EXT_disjoint_timer_query_webgl2');
    R.info.autoReset = false;
    const progs = () => (R.info.programs ? R.info.programs.length : 0);
    let cur = null;
    const origCb = sr.renderCallback;
    sr.renderCallback = function (dt) {
      const t0 = performance.now();
      cur = { t: t0, upd: 0, ren: 0, gpu: null, q: null };
      origCb.call(this, dt);
      cur.upd = performance.now() - t0;
    };
    const pending = [];
    const pool = [];
    const poll = () => {
      if (!ext) return;
      const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT);
      while (pending.length) {
        const p = pending[0];
        if (!gl.getQueryParameter(p.q, gl.QUERY_RESULT_AVAILABLE)) break;
        const ns = gl.getQueryParameter(p.q, gl.QUERY_RESULT);
        if (!disjoint) p.f.gpu = ns / 1e6;
        pool.push(p.q);
        pending.shift();
      }
      if (pending.length > 200) pending.splice(0, pending.length - 200);
    };
    // Shadow draws of the frame: the calls WebGLShadowMap.render adds (0 on a
    // frame whose pass is skipped: autoUpdate off and needsUpdate not set).
    const sm = R.shadowMap;
    if (sm && typeof sm.render === 'function') {
      const origS = sm.render;
      sm.render = function () {
        const c0 = R.info.render.calls;
        const r = origS.apply(this, arguments);
        G.shadowNow += R.info.render.calls - c0;
        return r;
      };
    }
    const protoRender = Object.getPrototypeOf(sr).render;
    sr.render = function () {
      R.info.reset();
      G.shadowNow = 0;
      const t0 = performance.now();
      let q = null;
      if (ext && cur) { q = pool.pop() || gl.createQuery(); gl.beginQuery(ext.TIME_ELAPSED_EXT, q); }
      protoRender.call(this);
      if (q) { gl.endQuery(ext.TIME_ELAPSED_EXT); pending.push({ q, f: cur }); }
      if (cur) {
        cur.ren = performance.now() - t0;
        cur.calls = R.info.render.calls;
        cur.tris = R.info.render.triangles;
        cur.shadow = G.shadowNow;
        cur.progs = progs();
        G.frames.push(cur);
        if (G.frames.length > 40000) G.frames.splice(0, 10000);
        cur = null;
      }
      poll();
    };
    const origR = R.render;
    R.render = function () {
      const p0 = progs();
      const t0 = performance.now();
      const r = origR.apply(this, arguments);
      const p1 = progs();
      if (p1 !== p0 && inComposer === 0) G.renders.push({ t: Math.round(t0), label: 'renderer.render', added: p1 - p0, ms: +(performance.now() - t0).toFixed(1), inCompile: inCompile > 0 });
      return r;
    };
    for (const key of ['compile', 'compileAsync']) {
      const orig = R[key];
      if (typeof orig !== 'function') continue;
      R[key] = function () {
        // compileAsync runs this.compile() inside it: only the outermost call
        // is recorded, so summing 'compiles' counts each program once.
        const nested = inCompile > 0;
        const p0 = progs();
        const t0 = performance.now();
        inCompile++;
        let r;
        try { r = orig.apply(this, arguments); } finally { inCompile--; }
        if (!nested) G.compiles.push({ t: Math.round(t0), label: 'renderer.' + key, added: progs() - p0, ms: +(performance.now() - t0).toFixed(1) });
        return r;
      };
    }
    G.hooked = { timerQuery: !!ext };
    return true;
  };
  const iv = setInterval(() => { try { if (install()) clearInterval(iv); } catch (e) { G.err = String(e); clearInterval(iv); } }, 2);
  const ivc = setInterval(() => {
    const sr = window.__app && window.__app.renderer;
    const c = sr && sr.composer;
    if (!c || c.render.__gate) return;
    const R = sr.getRenderer();
    const progs = () => (R.info.programs ? R.info.programs.length : 0);
    const orig = c.render;
    const f = function () {
      const p0 = progs();
      const t0 = performance.now();
      inComposer++;
      let r;
      try { r = orig.apply(this, arguments); } finally { inComposer--; }
      const p1 = progs();
      if (p1 !== p0) G.renders.push({ t: Math.round(t0), label: 'composer.render', added: p1 - p0, ms: +(performance.now() - t0).toFixed(1), inCompile: inCompile > 0 });
      return r;
    };
    f.__gate = true;
    c.render = f;
    clearInterval(ivc);
  }, 20);
})();`;

// ------------------------------------------------------------ page-side
/**
 * The three views. 'spawn' is the idle camera where the visitor lands: the
 * first call records it (player position, follow direction, pitch,
 * distance) and later calls restore it, so --fx can come back to it.
 */
const POSE = ({ view }) => {
  const app = window.__app;
  const sc = app.scene;
  const P = sc.getPlayer();
  const V3 = P.position.constructor;
  const isl = sc.getIsland ? sc.getIsland() : sc.island;
  const oc = sc.getOrbitCamera();
  const lonlat = (lon, lat) => new V3(Math.cos(lon) * Math.cos(lat), Math.sin(lat), Math.sin(lon) * Math.cos(lat)).normalize();
  const north = (dir) => {
    const pole = new V3(0, 1, 0);
    const t = pole.clone().addScaledVector(dir, -pole.dot(dir));
    return t.lengthSq() < 1e-6 ? new V3(1, 0, 0) : t.normalize();
  };
  const frame = (follow, pitch, dist) => {
    // The design audit's view framing (runtime only): follow direction,
    // pitch and distance, then a hard cut to the pose. A4 eases pitch toward
    // pitchTarget within 1.2-1.5 s, so the target is pinned too: stage 1
    // measured s1-int's hub and Projects views at -0.12 rad against main's
    // -0.62 and -0.38 and reported a fake saving.
    oc.minPitch = -1.35;
    if (oc.followDir && follow) oc.followDir.copy(follow.clone().normalize());
    if (pitch !== null) {
      oc.pitch = pitch;
      oc.pitchTarget = pitch;
    }
    if (typeof oc.setDistance === 'function') oc.setDistance(dist);
    oc.distanceTarget = dist;
    oc.distance = dist;
    if (typeof oc.snapToPlayer === 'function') oc.snapToPlayer();
  };
  if (view === 'spawn') {
    const z = window.__gatePose0;
    if (!z) {
      window.__gatePose0 = {
        pos: P.getWorldPosition().clone(),
        follow: oc.followDir ? oc.followDir.clone() : null,
        pitch: typeof oc.pitch === 'number' ? oc.pitch : null,
        dist: typeof oc.distance === 'number' ? oc.distance : null,
      };
    } else {
      P.setWorldPosition(z.pos.clone());
      frame(z.follow, z.pitch, z.dist);
    }
  } else if (view === 'hub') {
    const p = P.position.clone().normalize();
    const f = new V3(0.2, 0, 1);
    frame(f.addScaledVector(p, -f.dot(p)).normalize(), -0.62, 12);
  } else if (view === 'projects') {
    const d = lonlat(Math.PI * 0.5, 0.4636);
    const s = isl.sampleSurfaceByDirection(d, 0);
    P.setWorldPosition(d.clone().multiplyScalar(s.position.length() + 0.75));
    frame(north(d).negate(), -0.38, 9);
  }
  return true;
};

/** The pose the camera really holds when a view is measured. */
const POSE_READ = () => {
  const sc = window.__app.scene;
  const oc = sc.getOrbitCamera();
  const cam = sc.getCamera();
  const P = sc.getPlayer();
  const V3 = P.position.constructor;
  const up = P.position.clone().normalize();
  const fwd = cam.getWorldDirection(new V3());
  const r = (x) => (typeof x === 'number' && Number.isFinite(x) ? +x.toFixed(4) : null);
  return {
    ocPitch: r(oc.pitch),
    pitchTarget: 'pitchTarget' in oc ? r(oc.pitchTarget) : null,
    camPitch: r(Math.asin(Math.max(-1, Math.min(1, -fwd.dot(up))))),
    distance: r(oc.distance),
  };
};

/** One whole frame (shadow pass + composer passes), loop paused around it. */
const WHOLE_FRAME = () => {
  const sr = window.__app.renderer;
  const R = sr.getRenderer();
  sr.stopRenderLoop();
  // The counted frame always holds a shadow pass (unless the interior freeze
  // parks it): at half rate (E2, the low tier) every other frame has none, so
  // a single frame would read 476 or 572 draws by the phase it landed on, and
  // the draw budgets would be judged on that coin toss. A no-op at full rate.
  if (!sr.shadowFrozen) R.shadowMap.needsUpdate = true;
  R.info.reset();
  sr.render();
  const i = R.info;
  const out = { draws: i.render.calls, triangles: i.render.triangles, shadowDraws: window.__gate ? window.__gate.shadowNow : null, programs: i.programs ? i.programs.length : null, textures: i.memory.textures, geometries: i.memory.geometries };
  sr.isRunning = false;
  sr.startRenderLoop(sr.scene, sr.camera, sr.renderCallback);
  return out;
};

const CENSUS = () => {
  const scene = window.__app.scene;
  let nodes = 0;
  const texs = new Map();
  const addTex = (t) => {
    if (t && t.isTexture && !texs.has(t.uuid)) texs.set(t.uuid, t);
  };
  scene.traverse((o) => {
    nodes++;
    const ms = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
    for (const m of ms) {
      for (const k of ['map', 'normalMap', 'gradientMap', 'emissiveMap', 'alphaMap', 'aoMap', 'roughnessMap', 'metalnessMap', 'envMap', 'lightMap', 'bumpMap', 'displacementMap', 'matcap', 'specularMap']) addTex(m[k]);
      if (m.uniforms) for (const u of Object.values(m.uniforms)) addTex(u && u.value);
    }
  });
  addTex(scene.background);
  addTex(scene.environment);
  let bytes = 0;
  let max2048 = 0;
  for (const t of texs.values()) {
    const img = t.image;
    const w = (img && (img.width || (img.data && img.data.width))) || 0;
    const h = (img && (img.height || (img.data && img.data.height))) || 0;
    if (w >= 2048 && h >= 2048) max2048++;
    bytes += w * h * 4 * (t.generateMipmaps ? 1.333 : 1);
  }
  return { nodes, textures: texs.size, textureMB: +(bytes / 1048576).toFixed(2), maps2048: max2048 };
};

const FRAME_STATS = ([t0, t1]) => {
  const fr = window.__gate.frames.filter((f) => f.t >= t0 && f.t < t1);
  return {
    n: fr.length,
    cpu: fr.map((f) => f.upd + f.ren),
    ren: fr.map((f) => f.ren),
    gpu: fr.filter((f) => f.gpu !== null).map((f) => f.gpu),
    calls: fr.map((f) => f.calls),
    tris: fr.map((f) => f.tris),
    shadow: fr.map((f) => f.shadow || 0),
  };
};

const FX_SNAPSHOT = () => {
  const g = window.__dsFx || {};
  return { stats: JSON.parse(JSON.stringify(g.stats || {})), effects: JSON.parse(JSON.stringify(g.effects || {})) };
};

// ------------------------------------------------- vehicle and room views
/**
 * The vehicle view (P2-E3, GP-14): board the car nearest the land circuit's
 * start, put it on ring 0 heading down the leg to ring 1, and turn the chase
 * camera behind it. The drive itself is W held for 3 s (VEHICLE_DRIVE_MS): no
 * pointer input, so the car runs the leg's great circle at its 13 u/s.
 */
const VEHICLE_SETUP = () => {
  const sc = window.__app.scene;
  if (typeof sc.boardVehicle !== 'function' || typeof sc.vehicleKind !== 'function' || !Array.isArray(sc.vehicles)) return { error: 'hook missing: scene.boardVehicle / vehicleKind / vehicles' };
  const start = typeof sc.getRaceStartPosition === 'function' ? sc.getRaceStartPosition('land') : null;
  const land = sc.races && sc.races.circuits ? sc.races.circuits.land : null;
  if (!start || !land || !land.dirs || land.dirs.length < 2) return { error: 'hook missing: the land circuit (scene.getRaceStartPosition, races.circuits.land.dirs)' };
  let idx = -1;
  let best = Infinity;
  for (let i = 0; i < sc.vehicles.length; i++) {
    if (sc.vehicleKind(i) !== 'car' || sc.vehicles[i].occupied) continue;
    const d = sc.vehicles[i].group.position.distanceTo(start);
    if (d < best) {
      best = d;
      idx = i;
    }
  }
  if (idx < 0) return { error: 'no free car' };
  const v = sc.vehicles[idx];
  const isl = sc.getIsland ? sc.getIsland() : sc.island;
  const a = land.dirs[0].clone().normalize();
  const b = land.dirs[1].clone().normalize();
  const fwd = b.clone().addScaledVector(a, -b.dot(a)).normalize();
  sc.boardVehicle(idx);
  if (!sc.isRidingVehicle()) return { error: 'boardVehicle did not board the car' };
  v.dir.copy(a);
  v.forward.copy(fwd);
  const s = isl.sampleSurfaceByDirection(v.dir, 0);
  v.radius = s.position.length() + 0.06;
  v.normal.copy(s.normal);
  sc.getPlayer().setWorldPosition(v.dir.clone().multiplyScalar(v.radius + 0.72));
  window.__gateCar = { idx, a, fwd };
  return { idx, carToStartU: +best.toFixed(1), legU: +(a.angleTo(b) * isl.getRadius()).toFixed(1) };
};

/**
 * Turn the chase camera until it looks down the leg (within 1 degree): by
 * the follow direction, or by setYaw where the follow direction is derived
 * from yaw. Returns the angle left, in degrees.
 */
const VEHICLE_AIM = ([way, sign]) => {
  const sc = window.__app.scene;
  const g = window.__gateCar;
  const oc = sc.getOrbitCamera();
  const cam = sc.getCamera();
  const V3 = g.fwd.constructor;
  const up = sc.getPlayer().position.clone().normalize();
  const flat = (x) => x.clone().addScaledVector(up, -x.dot(up)).normalize();
  const off = () => {
    const f = flat(g.fwd);
    const c = flat(cam.getWorldDirection(new V3()));
    return (Math.atan2(f.clone().cross(c).dot(up), f.dot(c)) * 180) / Math.PI;
  };
  const err = off();
  if (Math.abs(err) < 1) return { deg: +err.toFixed(2), done: true };
  if (way === 'followDir' && oc.followDir) {
    oc.followDir.copy(flat(g.fwd)).negate();
    if (typeof oc.snapToPlayer === 'function') oc.snapToPlayer();
  } else if (way === 'setYaw' && typeof oc.setYaw === 'function' && typeof oc.getYaw === 'function') {
    oc.setYaw(oc.getYaw() + (sign * err * Math.PI) / 180);
    if (typeof oc.snapToPlayer === 'function') oc.snapToPlayer();
  }
  return { deg: +err.toFixed(2), done: false };
};

/** Where the car is against the leg's great circle: distance along it and off it (u). */
const VEHICLE_READ = () => {
  const sc = window.__app.scene;
  const g = window.__gateCar;
  const v = sc.vehicles[g.idx];
  const R = (sc.getIsland ? sc.getIsland() : sc.island).getRadius();
  const n = g.a.clone().cross(g.fwd).normalize(); // the leg's plane
  const d = v.dir.clone().normalize();
  const inPlane = d.clone().addScaledVector(n, -d.dot(n)).normalize();
  return { alongU: +(g.a.angleTo(inPlane) * R).toFixed(2), offPathU: +(Math.asin(Math.max(-1, Math.min(1, d.dot(n)))) * R).toFixed(2), riding: sc.isRidingVehicle() };
};
const VEHICLE_DRIVE_MS = 3000;

async function vehicleView(page) {
  const setup = await page.evaluate(VEHICLE_SETUP);
  if (setup.error) throw new Error(setup.error);
  // The ride camera eases back to its ride distance; aim it down the leg.
  let aim = null;
  for (const way of ['followDir', 'setYaw']) {
    let sign = -1;
    let last = null;
    for (let i = 0; i < 10; i++) {
      aim = await page.evaluate(VEHICLE_AIM, [way, sign]);
      if (aim.done) break;
      // No progress: the turn went the other way, so reverse it.
      if (last !== null && Math.abs(aim.deg) > Math.abs(last) - 0.5) sign = -sign;
      last = aim.deg;
      await lib.nextFrames(page, 3);
    }
    if (aim && aim.done) {
      aim.via = way;
      break;
    }
  }
  await page.waitForTimeout(1200);
  const settled = await page.evaluate(VEHICLE_AIM, ['none', 0]);
  // W drives along the camera's forward: off the leg, the path is not the leg's.
  if (Math.abs(settled.deg) > 5) throw new Error(`hook missing: the chase camera could not be aimed down the leg (${settled.deg} deg off; followDir / setYaw)`);
  const pose = await page.evaluate(POSE_READ);
  const atStart = await page.evaluate(WHOLE_FRAME);
  await page.waitForTimeout(250);
  const t0 = await page.evaluate(() => performance.now());
  const fx0 = await page.evaluate(FX_SNAPSHOT);
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(VEHICLE_DRIVE_MS / 2);
  const tm = await page.evaluate(() => performance.now());
  await page.keyboard.down('KeyW'); // a held key repeats
  await page.waitForTimeout(VEHICLE_DRIVE_MS / 2);
  const t1 = await page.evaluate(() => performance.now());
  const fx1 = await page.evaluate(FX_SNAPSHOT);
  await page.keyboard.up('KeyW');
  const drive = await page.evaluate(VEHICLE_READ);
  const all = await page.evaluate(FRAME_STATS, [t0, t1]);
  const w1 = frameNumbers(await page.evaluate(FRAME_STATS, [t0, tm]), tm - t0);
  const w2 = frameNumbers(await page.evaluate(FRAME_STATS, [tm, t1]), t1 - tm);
  const fxUs = {};
  for (const [name, s] of Object.entries(fx1.stats)) fxUs[name] = all.n ? round((s.us - (fx0.stats[name] || { us: 0 }).us) / all.n, 2) : null;
  const pooled = frameNumbers(all, t1 - t0);
  await page.evaluate(() => window.__app.scene.disembarkVehicle());
  await page.waitForTimeout(600);
  return {
    // Draws and triangles are the drive's mean whole frame: the car moves,
    // so one paused frame would be one point of the leg.
    draws: pooled.drawsMean,
    triangles: pooled.trianglesMean,
    programs: atStart.programs,
    ...pooled,
    fxUsPerFrame: fxUs,
    effects: fx1.effects,
    atStart: { draws: atStart.draws, triangles: atStart.triangles },
    windows: [w1, w2].map((w) => ({ frames: w.frames, cpuP95: w.cpuP95, gpuP50: w.gpuP50, drawsMean: w.drawsMean })),
    pose,
    drive: { ...setup, aimVia: aim ? aim.via || null : null, aimDeg: settled.deg, ...drive },
  };
}

/**
 * The room view (P2-E3): the Professional hall by its door, the way a visitor
 * enters (p2/room-lib's enterRoom: walk at the door, E or USE at its prompt).
 * The entry: its longest frame, the black interval judged by pixels (a CDP
 * screencast, the veil hiding 95% or more of the world) and by the veil's
 * opacity, the programs it adds. Then the steady room, the hall's panel
 * closed, from the door end: one whole frame's draws and a 1.5 s window.
 */
const ROOM_ID = 'professional';
async function roomView(session, prof) {
  const { page, ctx } = session;
  const touch = lib.isTouchProfile(session.profile);
  await R.install(page);
  const T = touch ? await lib.touch(session) : null;
  const cdp = await ctx.newCDPSession(page);
  const run = async () => {
    const e = await R.enterRoom(page, ROOM_ID, { touch, T, back: 3.0, record: true });
    await page.waitForTimeout(3200);
    return { e, fr: await page.evaluate(() => window.__ia.stop()) };
  };
  const { out, pixels } = await F.screencastBlack(page, cdp, run);
  await cdp.detach().catch(() => {});
  const tr = R.transition(out.fr, out.e.p0);
  const firstIn = out.fr.findIndex((f) => f.inside);
  const room = {
    id: ROOM_ID,
    press: out.e.press,
    walkMs: out.e.walkMs,
    inside: !!tr.inside,
    firstDoorFrameMs: tr.maxDt,
    toFirstInsideFrameMs: firstIn >= 0 ? Math.max(...out.fr.slice(0, firstIn + 2).map((f) => f.dt)) : null,
    firstInsideFrameMs: tr.firstInsideFrameMs,
    programsAdded: tr.programsAdded,
    blackMsPixels: pixels.blackMs,
    blackMsOpacity: tr.blackMs,
    windowPass: tr.rtPass.slice(0, 3),
  };
  if (!room.inside) return { ...room, error: `not inside ${ROOM_ID} after the entry (${out.e.press}; prompt '${out.e.promptOutside}')` };
  await page.evaluate(() => {
    const a = window.__app;
    if (a.ui.panels && a.ui.panels.closeAll) a.ui.panels.closeAll();
    window.__ia.pose(0, 0.6, Math.PI);
  });
  await page.waitForTimeout(700);
  const counters = await page.evaluate(WHOLE_FRAME);
  await page.waitForTimeout(250);
  const timing = await windowStats(page, 1500);
  Object.assign(room, { draws: counters.draws, triangles: counters.triangles, programs: counters.programs, renP50: timing.renP50, cpuP50: timing.cpuP50, cpuP95: timing.cpuP95, gpuP50: timing.gpuP50, fps: timing.fps });
  await R.outdoors(page);
  return room;
}

const PIN_GOVERNOR = () => {
  // A resolution or rung change must not masquerade as cost.
  const sr = window.__app.renderer;
  sr.governorArmed = false;
  sr.governorArmAccum = -1e12;
  return true;
};

// --------------------------------------------------------------- numbers
const { median, pct, round } = lib;

const ANIMATED = () => document.getAnimations().filter((a) => a.playState === 'running').length;

async function windowStats(page, ms) {
  const t0 = await page.evaluate(() => performance.now());
  const fx0 = await page.evaluate(FX_SNAPSHOT);
  const an0 = await page.evaluate(ANIMATED).catch(() => null);
  await page.waitForTimeout(ms / 2);
  const an1 = await page.evaluate(ANIMATED).catch(() => null);
  await page.waitForTimeout(ms / 2);
  const t1 = await page.evaluate(() => performance.now());
  const fx1 = await page.evaluate(FX_SNAPSHOT);
  const an2 = await page.evaluate(ANIMATED).catch(() => null);
  const f = await page.evaluate(FRAME_STATS, [t0, t1]);
  const fxUs = {};
  for (const [name, s] of Object.entries(fx1.stats)) {
    const a = fx0.stats[name] || { us: 0, calls: 0 };
    fxUs[name] = f.n ? round((s.us - a.us) / f.n, 2) : null;
  }
  return {
    ...frameNumbers(f, t1 - t0),
    fxUsPerFrame: fxUs,
    effects: fx1.effects,
    animatedMax: [an0, an1, an2].some((x) => typeof x === 'number') ? Math.max(...[an0, an1, an2].filter((x) => typeof x === 'number')) : null,
  };
}

/** The numbers of one window of frames (FRAME_STATS over ms). */
function frameNumbers(f, ms) {
  const avg = (a) => (a && a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
  return {
    frames: f.n,
    fps: round(f.n / (ms / 1000), 1),
    cpuP50: round(pct(f.cpu, 50), 3),
    cpuP95: round(pct(f.cpu, 95), 3),
    // The mean frame: a half-rate pass alternates heavy and light frames, so
    // p50 lands on one kind or the other and hides the saving (P2-E4).
    cpuMean: round(avg(f.cpu), 3),
    renP50: round(pct(f.ren || [], 50), 3),
    gpuP50: f.gpu.length ? round(pct(f.gpu, 50), 3) : null,
    gpuMean: f.gpu.length ? round(avg(f.gpu), 3) : null,
    drawsMean: f.calls.length ? round(avg(f.calls), 1) : null,
    trianglesMean: f.tris && f.tris.length ? round(avg(f.tris), 0) : null,
    shadowDrawsMean: f.shadow && f.shadow.length ? round(avg(f.shadow), 1) : null,
  };
}

async function bootPage(page, base, profObj, hour) {
  // The hour is pinned (noon by default): night lights change the light
  // count, the programs and the draws, so a live clock would move every counter.
  const q = '?owner=1&perf=1' + (hour && hour !== 'live' ? `&hour=${hour}` : '') + (profObj.query || '');
  await page.goto(`${base}/${q}`, { waitUntil: 'domcontentloaded', timeout: 240000 });
  await page.waitForFunction(() => window.__lifeIslandReady === true, null, { timeout: 300000, polling: 100 });
  await page.waitForSelector(`${lib.WELCOME} button[data-dismiss]`, { state: 'visible', timeout: 180000 });
  await page.evaluate(lib.HELPERS);
}

/** Dismiss the card, pin the governor, and wait until `atS` after the card. */
async function settleAfterCard(page, atS) {
  await page.click(`${lib.WELCOME} button[data-dismiss]`).catch(() => {});
  const cardAt = Date.now();
  await page.waitForTimeout(2500);
  await page.evaluate(PIN_GOVERNOR);
  const waitMs = atS * 1000 - (Date.now() - cardAt);
  if (waitMs > 0) await page.waitForTimeout(waitMs);
  return cardAt;
}

/**
 * One page load: startup marks, then (programsAtS after the card: past the
 * interior warm and the late compiles) programs, nodes and textures, then the
 * three views' counters and timing windows.
 */
async function loadCycle(browser, base, prof, { nogpu, startupOnly, programsAtS = 30, seed = false, hour = '12', scenarios = true }) {
  const p = lib.profile(prof === 'startup' ? 'lowtier' : prof);
  const profObj = prof === 'startup' ? { ...p, name: 'startup', cpu: 4 } : p;
  // The machine's load over the load, split between this browser and the rest.
  const meter = await lib.hostLoadMeter(browser);
  const s = await lib.openSession(browser, profObj, { init: [GATE_INIT({ nogpu: nogpu || prof === 'startup' })] });
  const { page } = s;
  const out = { profile: prof };
  try {
    await bootPage(page, base, profObj, hour);
    const boot = await page.evaluate(() => {
      const G = window.__gate;
      const welcome = G.welcomeAt;
      const measures = {};
      for (const e of performance.getEntriesByType('measure')) measures[e.name] = Math.round(e.duration);
      const res = performance.getEntriesByType('resource');
      const before = welcome ? res.filter((r) => r.responseEnd <= welcome) : res;
      const lt = welcome ? G.longtasks.filter((x) => x[0] < welcome) : G.longtasks;
      const sr = window.__app && window.__app.renderer;
      const R = sr && typeof sr.getRenderer === 'function' ? sr.getRenderer() : null;
      return {
        welcomeMs: welcome ? Math.round(welcome) : null,
        worldGenMs: measures.world_gen ?? null,
        longTasksBeforeCard: lt.filter((x) => x[1] > 50).length,
        longestTaskBeforeCardMs: lt.length ? Math.max(...lt.map((x) => x[1])) : 0,
        bytesBeforeCardKB: +(before.reduce((n, r) => n + (r.transferSize || 0), 0) / 1024).toFixed(1),
        // The boot race's mode for a startup-only load (no +30 s read).
        programsAtCard: R && R.info && R.info.programs ? R.info.programs.length : null,
        hooked: G.hooked,
        hookErr: G.err,
      };
    });
    Object.assign(out, boot);
    if (seed) out.seed = await page.evaluate(() => (window.__dsSeedDraws ? JSON.parse(JSON.stringify(window.__dsSeedDraws)) : null));
    if (startupOnly) return out;
    if (!boot.hooked) throw new Error('hook missing: __app.renderer.renderCallback / getRenderer for frame timing');
    const cardAt = await settleAfterCard(page, programsAtS);
    out.programs = (await page.evaluate(WHOLE_FRAME)).programs;
    out.programsReadAtS = round((Date.now() - cardAt) / 1000, 1);
    Object.assign(out, await page.evaluate(CENSUS));
    out.views = {};
    for (const v of VIEW_DEFS) {
      await page.evaluate(POSE, { view: v.name });
      if (v.settleMs) await page.waitForTimeout(v.settleMs);
      const pose = await page.evaluate(POSE_READ);
      const counters = await page.evaluate(WHOLE_FRAME);
      await page.waitForTimeout(250);
      const timing = await windowStats(page, 1500);
      out.views[v.name] = { ...counters, ...timing, pose };
    }
    out.programsAfterViews = (await page.evaluate(WHOLE_FRAME)).programs;
    out.renderProgramAdds = await page.evaluate(() => window.__gate.renders.filter((r) => !r.inCompile).map((r) => ({ label: r.label, added: r.added, ms: r.ms })));
    // P2-E3: the vehicle view, then the room view (the session's first door),
    // after the posed views so their numbers stay what the floor recorded.
    if (scenarios) {
      out.views.vehicle = await vehicleView(page);
      out.room = await roomView(s, prof);
      out.programsAfterScenarios = (await page.evaluate(WHOLE_FRAME)).programs;
    }
  } finally {
    // Everything on the machine (hostBusyPct, this browser included) and what
    // other processes took (otherBusyPct), over the load, read before the
    // context closes: other sessions' builds and probes show up there and in
    // the timing spread.
    const load = await meter.stop();
    out.hostBusyPct = load.hostBusyPct;
    out.browserPct = load.browserPct;
    out.otherBusyPct = load.otherBusyPct;
    await s.close({ waitSignUpMs: 20000 });
    out.net = { signUpSeen: s.net.signUpSeen, bootProofSeen: !!s.net.bootProofSeen, leaks: s.net.leaks.slice(), intercepted: [...new Set(s.net.intercepted)] };
  }
  return out;
}

/**
 * The dusk check (P2-E3; LT-03, P2-B6, P2-C4). A visitor playing through dusk
 * crosses the exterior-lights cutoff once; when that changes the light count
 * every lit program re-links in one task. A fresh browser (a cold GPU program
 * cache): boot at ?hour=17, wait out the interior warm, move the clock to
 * 17.5 h through EnvironmentCycle.debugHour, and take the longest long task,
 * long animation frame or frame gap of the next 6 s.
 */
const DUSK_STATE = () => {
  const sc = window.__app.scene;
  const env = sc.getEnvironmentCycle();
  const lights = {};
  sc.traverseVisible((o) => {
    if (o.isLight) lights[o.type] = (lights[o.type] || 0) + 1;
  });
  return { lights, programs: window.__app.renderer.getRenderer().info.programs.length, hour: +env.getHour().toFixed(2), day: +env.getDayFactor().toFixed(3) };
};
async function duskCheck(base, prof, { warmMs = 13000 } = {}) {
  const browser = await lib.launch();
  const p = lib.profile(prof);
  const s = await lib.openSession(browser, p, { init: [R.LONGTASKS_INIT] });
  const { page } = s;
  const out = { profile: prof };
  try {
    await bootPage(page, base, p, '17');
    await page.click(`${lib.WELCOME} button[data-dismiss]`).catch(() => {});
    await page.waitForTimeout(warmMs);
    out.before = await page.evaluate(DUSK_STATE);
    const t0 = await page.evaluate(() => {
      const env = window.__app.scene.getEnvironmentCycle();
      if (!('debugHour' in env)) return null;
      env.debugHour = 17.5;
      return performance.now();
    });
    if (t0 === null) throw new Error('hook missing: EnvironmentCycle.debugHour');
    await page.waitForTimeout(6000);
    out.after = await page.evaluate(DUSK_STATE);
    const lt = await page.evaluate((x) => {
      const L = window.__lt || { longtasks: [], loaf: [], gaps: [] };
      const after = (a) => a.filter(([st]) => st >= x - 50).map((e) => e[1]);
      return { longtasks: after(L.longtasks), loaf: after(L.loaf), gaps: after(L.gaps) };
    }, t0);
    // Three views of the same freeze: one observer missing an entry cannot hide it.
    out.longestMs = Math.max(0, ...lt.longtasks, ...lt.loaf, ...lt.gaps);
    out.longTasks = lt.longtasks;
    out.frameGaps = lt.gaps;
    out.programsAdded = out.after.programs - out.before.programs;
    // The flip is a re-link: the light set changes and programs are added in
    // one long task. A long frame with neither is the host (another session
    // holding the CPU), so it leaves the check open instead of failing it.
    out.relinked = out.programsAdded > 0 || JSON.stringify(out.before.lights) !== JSON.stringify(out.after.lights);
    out.pass = out.longestMs < DUSK_LONGEST_MS ? true : out.relinked ? false : null;
    if (out.pass === null) out.note = 'a long frame with no light or program change: the host, not the dusk flip';
  } catch (e) {
    out.error = String((e && e.message) || e).slice(0, 300);
    out.pass = null;
  } finally {
    await s.close({ waitSignUpMs: 20000 });
    out.net = { signUpSeen: s.net.signUpSeen, bootProofSeen: !!s.net.bootProofSeen, leaks: s.net.leaks.slice() };
    await browser.close().catch(() => {});
  }
  return out;
}

/** The dusk check on each profile of one build; adds its leaks and missing boot proofs to data. */
async function duskRuns(base, profiles, data) {
  const out = {};
  for (const prof of profiles.filter((p) => p !== 'startup')) {
    const r = await duskCheck(base, prof);
    if (r.net.leaks.length) data.leaks.push(...r.net.leaks);
    if (!r.net.signUpSeen && !r.net.bootProofSeen) data.signUpMissing++;
    out[prof] = r;
    process.stdout.write(`  dusk ${prof}: ${r.error ? `error ${r.error}` : `longest ${r.longestMs} ms, lights ${JSON.stringify(r.before.lights)} -> ${JSON.stringify(r.after.lights)}, programs +${r.programsAdded}`}\n`);
  }
  return out;
}
const duskVerdict = (runs) => {
  const rs = Object.values(runs || {});
  if (rs.some((r) => r.pass === false)) return 'fail';
  if (!rs.length || rs.some((r) => r.pass === null)) return 'inconclusive';
  return 'pass';
};

/** --dusk with no --ab: the dusk check alone, on one build. */
async function modeDusk(args) {
  const server = await lib.serve({ base: args.base, dist: args.dist, port: args.port });
  const profiles = String(args.profiles || 'desktop,lowtier').split(',');
  const data = { mode: 'dusk', profiles: {}, leaks: [], signUpMissing: 0 };
  try {
    data.dusk = await duskRuns(server.url, profiles, data);
  } finally {
    await server.stop();
  }
  const v = duskVerdict(data.dusk);
  data.verdict = data.leaks.length ? 'fail-closed' : v === 'pass' && data.signUpMissing ? 'inconclusive' : v;
  return data;
}

// ---------------------------------------------------------------- verdicts
const T975 =[null, 12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.16, 2.145, 2.131, 2.12, 2.11, 2.101, 2.093, 2.086, 2.08, 2.074, 2.069, 2.064, 2.06, 2.056, 2.052, 2.048, 2.045, 2.042];
/** Two-sided 95% Student t quantile; past 30 df the table rounds df down (conservative). */
const t975 = (df) => (df < 1 ? null : df <= 30 ? T975[df] : df <= 40 ? 2.042 : df <= 60 ? 2.021 : df <= 120 ? 2.0 : 1.98);
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const sampleSd = (a) => {
  const m = a.reduce((s, x) => s + x, 0) / a.length;
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
};

/**
 * The paired sign test's level, one-sided. A timing fails on it when so many
 * of its n paired differences are over T that a true median shift of T or
 * less would give that many with probability SIGN_ALPHA or less. At 0.005 it
 * needs 8 of 8, 11 of 12 or 19 of 24 (never at 6 cycles), so an A/A timing
 * whose noise is as large as T (each side's SD = T) fails on it in about 1
 * run in 700,000.
 */
const SIGN_ALPHA = 0.005;
/** The fewest pairs the sign test's pass path needs (none of them over T): 24, the gate's last escalation. */
const SIGN_PASS_MIN = 24;
/** Pairs (b - a) over T, in the order given; pass when there are SIGN_PASS_MIN or more and none is over. */
function signPass(a, b, threshold) {
  const d = [];
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (isNum(a[i]) && isNum(b[i])) d.push(b[i] - a[i]);
  const over = d.filter((x) => x > threshold).length;
  return { over, n: d.length, pass: d.length >= SIGN_PASS_MIN && over === 0 };
}
/** The fewest of n pairs over T that the sign test fails on, or null when even n of n is not enough. */
function signCritical(n, alpha = SIGN_ALPHA) {
  if (!(n >= 1)) return null;
  // P(X >= k) for X ~ Binomial(n, 1/2), summed down from k = n.
  let c = 1; // C(n, k)
  let tail = 0;
  let found = null;
  for (let k = n; k >= 0; k--) {
    tail += c / 2 ** n;
    if (tail > alpha) break;
    found = k;
    c = (c * k) / (n - k + 1);
  }
  return found;
}

/**
 * The plan's verdict rule for one metric (lower is better). a[i] and b[i] are
 * side A and side B in cycle i; ABAB order makes each pair adjacent in time.
 * - delta = median over cycles of (b[i] - a[i]);
 * - sigma = the 95% band of delta: t(0.975, n-1) x 1.2533 x SD(b - a) / sqrt(n);
 * - valid when sigma <= threshold/2; pass when valid and delta <= threshold;
 *   fail when valid and delta > threshold + sigma; else inconclusive.
 * - the paired sign test (sign): fail, valid or not, when at least
 *   signCritical(n) of the n differences are over the threshold, a shift
 *   above T that the pairs agree on (wave 1's welcome_visible: +341 ms, every
 *   pair later and 23 of 24 over T, but sigma 141 against T 150, because
 *   main's loads sat in boot-race modes ~650 ms apart and the build's in
 *   one). Otherwise an invalid result never fails. The pass path: a result
 *   the sigma rule leaves inconclusive passes when n >= SIGN_PASS_MIN and no
 *   difference is over the threshold (passedBy 'sign'); it never turns a
 *   fail into a pass. sigmaSplitA is the plan's single split,
 * |median(A_odd) - median(A_even)|, kept for the record: one 3-vs-3 split
 * routinely understates the spread, so it does not decide anything.
 */
function judge(a, b, threshold) {
  const pairs = [];
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (isNum(a[i]) && isNum(b[i])) pairs.push([a[i], b[i]]);
  const n = pairs.length;
  if (!n) return { verdict: 'n/a', n: 0 };
  const A = pairs.map((x) => x[0]);
  const B = pairs.map((x) => x[1]);
  const d = pairs.map(([x, y]) => y - x);
  const delta = median(d);
  const sigma = n > 1 ? (t975(n - 1) * 1.2533 * sampleSd(d)) / Math.sqrt(n) : null;
  const odd = A.filter((_, i) => i % 2 === 0);
  const even = A.filter((_, i) => i % 2 === 1);
  const all = [...A, ...B];
  const out = {
    delta: round(delta, 3),
    sigma: sigma === null ? null : round(sigma, 3),
    n,
    medianA: round(median(A), 3),
    medianB: round(median(B), 3),
    range: [round(Math.min(...all), 3), round(Math.max(...all), 3)],
    sigmaSplitA: odd.length && even.length ? round(Math.abs(median(odd) - median(even)), 3) : null,
  };
  // No budget on this profile: report the numbers (A/A still compares them).
  if (threshold === undefined || threshold === null) return { verdict: 'n/a', ...out };
  const valid = sigma !== null && sigma <= threshold / 2;
  const over = d.filter((x) => x > threshold).length;
  const needed = signCritical(n);
  const sign = { over, n, needed, fail: needed !== null && over >= needed, pass: n >= SIGN_PASS_MIN && over === 0 };
  let verdict = 'inconclusive';
  let passedBy = null;
  if (valid && delta <= threshold) verdict = 'pass';
  else if ((valid && delta > threshold + sigma) || sign.fail) verdict = 'fail';
  else if (sign.pass) {
    verdict = 'pass';
    passedBy = 'sign';
  }
  return { verdict, ...out, threshold, valid, sign, ...(passedBy ? { passedBy } : {}), withinThreshold: Math.abs(delta) <= threshold };
}

/**
 * The counter rule (critique-r3): delta = median(B) - median(A), the per-side
 * medians; Tc = max(threshold, floor). Pass when delta <= Tc (an improvement
 * of any size passes); fail when delta > Tc + sigma, or delta > Tc at 24
 * cycles; otherwise inconclusive. sigma is the paired band as in judge().
 */
function judgeCounter(a, b, threshold, floor = null, { cycles = null } = {}) {
  const pairs = [];
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (isNum(a[i]) && isNum(b[i])) pairs.push([a[i], b[i]]);
  const n = pairs.length;
  if (!n) return { verdict: 'n/a', n: 0 };
  const A = pairs.map((x) => x[0]);
  const B = pairs.map((x) => x[1]);
  const d = pairs.map(([x, y]) => y - x);
  const delta = median(B) - median(A);
  const sigma = n > 1 ? (t975(n - 1) * 1.2533 * sampleSd(d)) / Math.sqrt(n) : null;
  const all = [...A, ...B];
  const out = { delta: round(delta, 3), sigma: sigma === null ? null : round(sigma, 3), n, medianA: round(median(A), 3), medianB: round(median(B), 3), range: [round(Math.min(...all), 3), round(Math.max(...all), 3)] };
  if (threshold === undefined || threshold === null) return { verdict: 'n/a', ...out };
  const tc = Math.max(threshold, isNum(floor) ? floor : 0);
  let verdict = 'inconclusive';
  if (delta <= tc) verdict = 'pass';
  else if ((sigma !== null && delta > tc + sigma) || (cycles !== null && cycles >= 24)) verdict = 'fail';
  return { verdict, ...out, threshold, floor: isNum(floor) ? floor : null, thresholdUsed: round(tc, 3), withinThreshold: Math.abs(delta) <= tc };
}

/** A seeded PRNG (mulberry32), so a resampled floor or band is the same on every run. */
function prng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let x = s;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}
const seedOf = (name) => [...String(name)].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) >>> 0, 2166136261);

/**
 * A side's value for a counter that rides the boot race (desktop programs:
 * 154 or 165 on s1-int): the mean of its modes' medians, weighted by how
 * often each mode came up. Each side is split at its own midpoint
 * (bootModes), as welcome_visible is. A plain median jumps by the whole gap
 * (11 programs) when the two sides' medians land in different modes; this
 * moves only with the mode mix, by the gap times the shift in it.
 */
function mixValue(values, modes) {
  const xs = [];
  const ms = [];
  for (let i = 0; i < values.length; i++) if (isNum(values[i]) && isNum(modes[i])) (xs.push(values[i]), ms.push(modes[i]));
  if (!xs.length) return null;
  const split = bootModes(ms);
  const by = {};
  split.forEach((m, i) => (by[m] = by[m] || []).push(xs[i]));
  return Object.values(by).reduce((s, g) => s + (g.length / xs.length) * median(g), 0);
}

/**
 * The counter rule on a boot-race counter: delta = mixValue(B) - mixValue(A),
 * sigma its 95% band from a seeded bootstrap over cycles (each side
 * resampled with its modes), then judgeCounter's verdict on max(T, floor).
 * The JSON keeps each side's mode medians and mix.
 */
function judgeMixCounter(a, b, modeA, modeB, threshold, floor = null, { cycles = null, name = '' } = {}) {
  const side = (v, m) => {
    const out = [];
    for (let i = 0; i < v.length; i++) if (isNum(v[i]) && isNum(m[i])) out.push([v[i], m[i]]);
    return out;
  };
  const A = side(a, modeA);
  const B = side(b, modeB);
  const n = Math.min(A.length, B.length);
  if (!n) return { verdict: 'n/a', n: 0 };
  const val = (s) => mixValue(s.map((x) => x[0]), s.map((x) => x[1]));
  const delta = val(B) - val(A);
  const rnd = prng(seedOf(`band:${name}`));
  const draw = (s) => Array.from({ length: s.length }, () => s[Math.floor(rnd() * s.length)]);
  const ds = [];
  for (let r = 0; r < 1000; r++) ds.push(val(draw(B)) - val(draw(A)));
  ds.sort((x, y) => x - y);
  const sigma = n > 1 ? (ds[Math.floor(0.975 * (ds.length - 1))] - ds[Math.floor(0.025 * (ds.length - 1))]) / 2 : null;
  const modes = (s) => {
    const split = bootModes(s.map((x) => x[1]));
    const by = {};
    split.forEach((m, i) => (by[m] = by[m] || []).push(s[i][0]));
    return Object.fromEntries(Object.entries(by).map(([m, g]) => [m, { loads: g.length, median: round(median(g), 2) }]));
  };
  const all = [...A, ...B].map((x) => x[0]);
  const out = { delta: round(delta, 3), sigma: sigma === null ? null : round(sigma, 3), n, medianA: round(val(A), 3), medianB: round(val(B), 3), range: [round(Math.min(...all), 3), round(Math.max(...all), 3)], stratified: true, modesA: modes(A), modesB: modes(B) };
  if (threshold === undefined || threshold === null) return { verdict: 'n/a', ...out };
  const tc = Math.max(threshold, isNum(floor) ? floor : 0);
  let verdict = 'inconclusive';
  if (delta <= tc) verdict = 'pass';
  else if ((sigma !== null && delta > tc + sigma) || (cycles !== null && cycles >= 24)) verdict = 'fail';
  return { verdict, ...out, threshold, floor: isNum(floor) ? floor : null, thresholdUsed: round(tc, 3), withinThreshold: Math.abs(delta) <= tc };
}

/**
 * A counter's floor (critique-r3: "record each counter's 24-cycle A/A
 * spread"): the 99th percentile of |delta| over 2,000 seeded resampled A/As,
 * each side n loads drawn from both sides' loads pooled, with the counter's
 * own statistic (the per-side median, or mixValue for a boot-race counter).
 * At 24 cycles a counter over max(T, floor) fails outright, so a floor set
 * at this percentile keeps that to about 1 A/A in 100 per counter at the edge.
 */
function aaSpread({ a, b, ma = null, mb = null }, { name = '', n = null, resamples = 2000, q = 0.99 } = {}) {
  const pool = [];
  for (const [vals, mods] of [
    [a, ma],
    [b, mb],
  ])
    for (let i = 0; i < vals.length; i++) if (isNum(vals[i]) && (!mods || isNum(mods[i]))) pool.push([vals[i], mods ? mods[i] : null]);
  const k = n || Math.min(a.filter(isNum).length, b.filter(isNum).length);
  if (pool.length < 2 || !k) return null;
  const rnd = prng(seedOf(`floor:${name}`));
  const draw = () => Array.from({ length: k }, () => pool[Math.floor(rnd() * pool.length)]);
  const stat = ma ? (s) => mixValue(s.map((x) => x[0]), s.map((x) => x[1])) : (s) => median(s.map((x) => x[0]));
  const ds = [];
  for (let r = 0; r < resamples; r++) ds.push(Math.abs(stat(draw()) - stat(draw())));
  ds.sort((x, y) => x - y);
  return round(ds[Math.min(ds.length - 1, Math.floor(q * ds.length))], 4);
}

/**
 * A credit (FX_CREDIT): what an effect must SAVE, as B - A at or below a
 * negative number, on judge()'s paired delta and band. Pass when delta is at
 * or below the credit (with ciUpper: when delta + sigma is, the 95% band's
 * upper bound); fail when even the band's lower bound misses it
 * (delta - sigma > credit); otherwise inconclusive.
 */
function judgeCredit(a, b, credit, { ciUpper = false } = {}) {
  const r = judge(a, b, null);
  if (!r.n || !isNum(credit)) return { ...r, verdict: 'n/a' };
  const sigma = isNum(r.sigma) ? r.sigma : null;
  let verdict = 'inconclusive';
  if (ciUpper ? sigma !== null && r.delta + sigma <= credit : r.delta <= credit) verdict = 'pass';
  else if (sigma !== null && r.delta - sigma > credit) verdict = 'fail';
  return { ...r, verdict, threshold: credit, rule: ciUpper ? 'credit: the band\'s upper bound (delta + sigma) at or below it' : 'credit: delta at or below it' };
}

/** The exact rule: |delta| <= threshold, and an A/A side must not move at all. */
function judgeExact(a, b, threshold) {
  const r = judge(a, b, null);
  if (!r.n) return r;
  if (threshold === undefined || threshold === null) return { ...r, verdict: 'n/a' };
  const delta = median(b.filter(isNum)) - median(a.filter(isNum));
  return { ...r, delta: round(delta, 3), threshold, verdict: delta <= threshold ? 'pass' : 'fail', withinThreshold: Math.abs(delta) <= threshold };
}

/**
 * An absolute bar on side B (the room view's first door: its longest frame
 * and the programs it adds). Pass when B's median is within the bar; fail
 * when it is over and nearly every load is (the sign test's count: 11 of 12,
 * 19 of 24, never at 6), or at 24 cycles; otherwise inconclusive. Side A is
 * reported beside it, so the row shows what main does.
 */
function judgeAbsolute(a, b, bar, { cycles = null } = {}) {
  const A = a.filter(isNum);
  const B = b.filter(isNum);
  if (!B.length) return { verdict: 'n/a', n: 0 };
  const out = { n: B.length, medianA: A.length ? round(median(A), 3) : null, medianB: round(median(B), 3), delta: A.length ? round(median(B) - median(A), 3) : null, range: [round(Math.min(...B), 3), round(Math.max(...B), 3)] };
  if (bar === undefined || bar === null) return { verdict: 'n/a', ...out };
  const over = B.filter((x) => x > bar).length;
  const needed = signCritical(B.length);
  let verdict = 'inconclusive';
  if (median(B) <= bar) verdict = 'pass';
  else if ((needed !== null && over >= needed) || (cycles !== null && cycles >= 24)) verdict = 'fail';
  return { verdict, ...out, threshold: bar, sign: { over, n: B.length, needed } };
}

/**
 * The boot race (README): GLB materials compile in one render pass or both,
 * so programs land in two modes (desktop 212/215, low tier 113/117) and the
 * late mode shows the card ~0.6 s later. Each side's loads are split at the
 * midpoint of its own program range (one mode when the range is under 2),
 * and the timing is paired within each mode, in cycle order.
 */
function bootModes(progs) {
  const xs = progs.filter(isNum);
  if (xs.length < 2) return progs.map((p) => (isNum(p) ? 'one' : null));
  const lo = Math.min(...xs);
  const hi = Math.max(...xs);
  if (hi - lo < 2) return progs.map((p) => (isNum(p) ? 'one' : null));
  const mid = (lo + hi) / 2;
  return progs.map((p) => (!isNum(p) ? null : p > mid ? 'late' : 'early'));
}
function stratify(a, b, modeA, modeB) {
  const ma = bootModes(modeA);
  const mb = bootModes(modeB);
  const uni = ma.every((m) => m === 'one' || m === null) || mb.every((m) => m === 'one' || m === null);
  const strata = {};
  // Loads per mode on each side, so a run whose sides cannot be matched mode
  // to mode (one side in one mode) says so; the sign test judges it then.
  const count = (ms) => ms.reduce((o, m) => (m === null ? o : { ...o, [m]: (o[m] || 0) + 1 }), {});
  if (uni) return { a, b, strata: { one: { a: a.filter(isNum).length, b: b.filter(isNum).length, paired: Math.min(a.length, b.length) }, modesA: count(ma), modesB: count(mb) }, stratified: false };
  const pa = [];
  const pb = [];
  for (const s of ['early', 'late']) {
    const qa = a.filter((x, i) => ma[i] === s && isNum(x));
    const qb = b.filter((x, i) => mb[i] === s && isNum(x));
    const n = Math.min(qa.length, qb.length);
    pa.push(...qa.slice(0, n));
    pb.push(...qb.slice(0, n));
    strata[s] = { a: qa.length, b: qb.length, paired: n };
  }
  return { a: pa, b: pb, strata, stratified: true };
}

/** µs per frame for each FxBudget effect over a side's windows (median), and the sum. */
function fxUsOf(cycles) {
  const per = {};
  for (const c of cycles) for (const v of Object.values((c && c.views) || {})) for (const [n, us] of Object.entries(v.fxUsPerFrame || {})) if (isNum(us)) (per[n] = per[n] || []).push(us);
  const med = Object.fromEntries(Object.entries(per).map(([n, xs]) => [n, round(median(xs), 2)]));
  return { perEffect: med, sum: round(Object.values(med).reduce((s, x) => s + x, 0), 2) };
}

/** The CPU proxy: every FxBudget effect on side B within its µs budget, and their sum. */
function cpuProxy(prof, cyclesB) {
  const fxp = fxUsOf(cyclesB);
  const each = prof === 'lowtier' ? FX_US.lowtier : FX_US.desktop;
  const total = prof === 'lowtier' ? FX_US.totalLowtier : FX_US.totalDesktop;
  const names = Object.keys(fxp.perEffect);
  if (!names.length) return { verdict: 'n/a', note: 'no FxBudget timings on side B (no effect registered, or ?perf=1 off)', ...fxp };
  const over = names.filter((n) => fxp.perEffect[n] > Math.min(each, ledgerUs(n, prof) ?? each));
  return { verdict: !over.length && fxp.sum <= total ? 'pass' : 'fail', each, total, over, ...fxp };
}

/**
 * One profile's verdict table. floor: the parsed floor file (or null);
 * cycles: how many cycles ran (counters fail outright at 24).
 */
function metricTable(prof, cyclesA, cyclesB, floor = null, { cycles = null } = {}) {
  const T = THRESHOLDS[prof] || {};
  const pick = (arr, f) =>
    arr.map((c) => {
      try {
        return f(c);
      } catch (e) {
        return null;
      }
    });
  const rows = {};
  let proxyRow = null;
  const proxy = () => (proxyRow = proxyRow || cpuProxy(prof, cyclesB));
  const fl = (name) => floorOf(floor, prof, name);
  /**
   * A timing: the sigma rule, unless T is below 2 x the floor, or CPU p95's
   * sigma is still over T/2 at 24 cycles (then the CPU proxy, or
   * unresolvable). The paired sign test fails a shift above T on every rule.
   */
  const timing = (name, f, thr, { proxyOf = null, a = null, b = null, order = null, extra = {} } = {}) => {
    const A = a || pick(cyclesA, f);
    const B = b || pick(cyclesB, f);
    const floorV = fl(name);
    const r = { kind: 'timing', ...judge(A, B, thr), floor: floorV, ...extra };
    const signFail = !!(r.sign && r.sign.fail);
    // The pass path on the cycle-order pairs, when the row was paired some
    // other way (welcome_visible by boot-race mode) and stayed inconclusive.
    if (order && r.verdict === 'inconclusive' && thr !== undefined && thr !== null) {
      const sp = signPass(order.a, order.b, thr);
      r.signInCycleOrder = sp;
      if (sp.pass) {
        r.verdict = 'pass';
        r.passedBy = 'sign';
      }
    }
    const passRule = () => {
      const sp = r.signInCycleOrder && r.signInCycleOrder.pass ? r.signInCycleOrder : r.sign;
      return `sign test: ${sp.over} of ${sp.n} pairs over T${sp === r.sign ? '' : ' in cycle order'} (passes at 0 of ${SIGN_PASS_MIN} or more)`;
    };
    const byProxy = () => {
      const p = proxy();
      r.rule = 'proxy: FxBudget µs per effect';
      r.verdict = p.verdict;
      r.proxy = { verdict: p.verdict, sum: p.sum, each: p.each, total: p.total, over: p.over, note: p.note };
    };
    const signRule = `sign test: ${r.sign ? r.sign.over : 0} of ${r.n} pairs over T (fails at ${r.sign ? r.sign.needed : '-'})`;
    if (thr !== undefined && thr !== null && floorV !== null && thr < 2 * floorV) {
      r.unresolvable = `T ${thr} < 2 x floor ${floorV}`;
      r.directVerdict = r.verdict;
      if (signFail) {
        r.rule = signRule;
        r.verdict = 'fail';
      } else if (proxyOf === 'cpu') byProxy();
      else {
        r.rule = 'unresolvable on this rig (no proxy): reported, not judged';
        r.verdict = 'n/a';
      }
    } else if (proxyOf === 'cpu' && r.verdict === 'inconclusive' && r.valid === false && !signFail && isNum(cycles) && cycles >= 24 && proxy().verdict !== 'n/a') {
      // 24 cycles and sigma still over T/2: this run cannot resolve the
      // budget directly, so CPU p95 is judged by its proxy, as a timing
      // under 2 x its floor is, and the row says so. A side B with no
      // FxBudget timings leaves the proxy nothing to stand in with, so the
      // row stays inconclusive then.
      r.unresolvable = `sigma ${r.sigma} > T/2 ${thr / 2} at ${cycles} cycles`;
      r.directVerdict = r.verdict;
      byProxy();
    } else r.rule = thr === undefined || thr === null ? 'report only' : signFail ? signRule : r.passedBy === 'sign' ? passRule() : 'sigma';
    rows[name] = r;
  };
  // The boot race's mode for a load: its programs 30 s after the card, or at
  // the card for a startup-only load.
  const modeOf = (c) => (isNum(c.programs) ? c.programs : c.programsAtCard);
  /** A counter; `raced` judges it by the boot race's mix (judgeMixCounter). */
  const counter = (name, f, thr, { raced = false } = {}) => {
    const a = pick(cyclesA, f);
    const b = pick(cyclesB, f);
    const ma = raced ? pick(cyclesA, modeOf) : null;
    const mb = raced ? pick(cyclesB, modeOf) : null;
    const judged = raced ? judgeMixCounter(a, b, ma, mb, thr, fl(name), { cycles, name }) : judgeCounter(a, b, thr, fl(name), { cycles });
    const rule = thr === undefined || thr === null ? 'report only' : raced ? 'counter on the boot-race mix: |Δ| <= max(T, floor)' : 'counter: |Δ| <= max(T, floor)';
    rows[name] = { kind: 'counter', rule, ...judged };
    // What --record-floor resamples: kept off the JSON.
    Object.defineProperty(rows[name], 'floorInput', { value: { a, b, ma, mb }, enumerable: false });
  };
  const exact = (name, f, thr) => {
    rows[name] = { kind: 'exact', rule: thr === undefined || thr === null ? 'exact (A/A equal), no budget' : 'exact', ...judgeExact(pick(cyclesA, f), pick(cyclesB, f), thr) };
  };
  /** An absolute bar on side B (the first door's frame and programs). */
  const absolute = (name, f, bar) => {
    rows[name] = { kind: 'absolute', rule: bar === undefined || bar === null ? 'report only' : 'absolute: side B within the bar', ...judgeAbsolute(pick(cyclesA, f), pick(cyclesB, f), bar, { cycles }) };
  };
  const startupRows = (suffix) => {
    // welcome_visible, compared like with like across the boot race's modes.
    const wA = pick(cyclesA, (c) => c.welcomeMs);
    const wB = pick(cyclesB, (c) => c.welcomeMs);
    const st = stratify(wA, wB, pick(cyclesA, modeOf), pick(cyclesB, modeOf));
    timing(`welcome_visible ms${suffix}`, null, T.welcomeMs, { a: st.a, b: st.b, order: st.stratified ? { a: wA, b: wB } : null, extra: { stratified: st.stratified, strata: st.strata } });
    timing(`world_gen ms${suffix}`, (c) => c.worldGenMs, T.worldGenMs);
    timing(`longest task before the card ms${suffix}`, (c) => c.longestTaskBeforeCardMs, T.longestTaskBeforeCardMs);
    counter(`long tasks > 50 ms before the card${suffix}`, (c) => c.longTasksBeforeCard, T.longTasksBeforeCard);
    counter(`bytes before the card (KB, transfer)${suffix}`, (c) => c.bytesBeforeCardKB, T.bytesBeforeCardKB);
  };
  if (prof === 'startup') {
    startupRows(' (4x)');
    return rows;
  }
  for (const v of VIEWS) {
    timing(`${v}: CPU p50 ms`, (c) => c.views[v].cpuP50, null);
    timing(`${v}: CPU p95 ms`, (c) => c.views[v].cpuP95, T.cpuP95, { proxyOf: 'cpu' });
    if (T.gpuP50) timing(`${v}: GPU p50 ms`, (c) => c.views[v].gpuP50, T.gpuP50);
    // Draws and triangles per view are counters, not exact: villagers,
    // cats, birds, clouds and cars move through every view, and rock.glb /
    // tree.glb clones land somewhere new on every load (see README).
    counter(`${v}: draws`, (c) => c.views[v].draws, T[DRAW_KEY[v]]);
    counter(`${v}: triangles`, (c) => c.views[v].triangles, null);
  }
  // P2-E3: the vehicle view (the 3 s drive's frames) and the room view. A
  // load without them (a run saved before P2-E3) leaves these rows n/a.
  timing('vehicle: CPU p50 ms', (c) => c.views.vehicle.cpuP50, null);
  timing('vehicle: CPU p95 ms', (c) => c.views.vehicle.cpuP95, T.cpuP95, { proxyOf: 'cpu' });
  if (T.gpuP50) timing('vehicle: GPU p50 ms', (c) => c.views.vehicle.gpuP50, T.gpuP50);
  counter('vehicle: draws', (c) => c.views.vehicle.draws, T.drawsVehicle);
  counter('vehicle: triangles', (c) => c.views.vehicle.triangles, null);
  absolute('room: first-door longest frame ms', (c) => c.room.firstDoorFrameMs, T.roomFirstDoorMs);
  absolute('room: programs added on entry', (c) => c.room.programsAdded, T.roomProgramsAdded);
  timing('room: black interval ms (pixels)', (c) => c.room.blackMsPixels, null);
  counter('room: draws', (c) => c.room.draws, T.drawsRoom);
  timing('room: render p50 ms', (c) => c.room.renP50, null);
  // Programs ride the boot race (on s1-int desktop 154 or 165, the low tier
  // 101), so they are judged on its mix; nodes wander by a few. Counters
  // with floors.
  counter('programs (30 s after the card)', (c) => c.programs, T.programs, { raced: true });
  counter('programs after the views', (c) => c.programsAfterViews, T.programs, { raced: true });
  counter('scene nodes', (c) => c.nodes, T.nodes ?? null);
  // The one exact counter: constant on every A/A load measured.
  exact('texture MB', (c) => c.textureMB, T.textureMB ?? null);
  startupRows('');
  if (proxyRow) rows['CPU proxy: FxBudget µs (side B)'] = { kind: 'µs', rule: 'proxy for the CPU p95 budgets', ...proxyRow };
  return rows;
}

function overall(rows) {
  const vs = Object.values(rows)
    .map((r) => r.verdict)
    .filter((v) => v !== 'n/a');
  if (vs.includes('fail')) return 'fail';
  if (vs.includes('inconclusive')) return 'inconclusive';
  return 'pass';
}

/**
 * A/A (one dist on both sides): the exact counter is equal on every load, no
 * verdict fails, and every |delta| is within max(T, floor).
 */
function aaSummary(profiles) {
  const out = { exactCountersEqual: true, exactCounters: [], outsideThreshold: [], verdictNeverFail: true };
  for (const [prof, p] of Object.entries(profiles)) {
    if (p.verdict === 'fail') out.verdictNeverFail = false;
    for (const [k, r] of Object.entries(p.metrics || {})) {
      if (r.kind === 'exact' && r.range) {
        const equal = r.range[0] === r.range[1];
        out.exactCounters.push({ profile: prof, metric: k, range: r.range, equal });
        if (!equal) out.exactCountersEqual = false;
      }
      // An absolute row's threshold is a bar on side B, not on the delta.
      if (r.kind === 'absolute' || r.threshold === undefined || r.threshold === null || !isNum(r.delta)) continue;
      const tc = Math.max(r.threshold, isNum(r.floor) ? r.floor : 0);
      const within = r.withinThreshold === false ? false : Math.abs(r.delta) <= tc;
      if (!within) out.outsideThreshold.push({ profile: prof, metric: k, delta: r.delta, sigma: r.sigma, threshold: r.threshold, floor: isNum(r.floor) ? r.floor : null });
    }
  }
  return out;
}

/** Hub-wide and Projects: both builds hold the same camera pitch (within POSE_TOL_RAD). */
function poseCheck(cyclesA, cyclesB) {
  const out = { equal: true, views: {} };
  for (const v of VIEW_DEFS.filter((x) => x.poseCheck)) {
    const get = (arr, k) => arr.map((c) => c && c.views && c.views[v.name] && c.views[v.name].pose && c.views[v.name].pose[k]).filter(isNum);
    const row = {};
    for (const k of ['camPitch', 'ocPitch']) {
      const a = get(cyclesA, k);
      const b = get(cyclesB, k);
      const ma = a.length ? median(a) : null;
      const mb = b.length ? median(b) : null;
      const spread = a.length && b.length ? Math.max(Math.max(...a, ...b) - Math.min(...a, ...b), 0) : null;
      const d = ma !== null && mb !== null ? Math.abs(mb - ma) : null;
      row[k] = { medianA: ma === null ? null : round(ma, 4), medianB: mb === null ? null : round(mb, 4), absDelta: d === null ? null : round(d, 4), spreadAllLoads: spread === null ? null : round(spread, 4) };
      if (d === null || d > POSE_TOL_RAD) out.equal = false;
    }
    out.views[v.name] = row;
  }
  return out;
}

// -------------------------------------------------------------------- modes
async function modeAB(args) {
  const [distA, distB] = args.ab || [];
  if (!distA || !distB) throw new lib.HarnessError('--ab takes two dist directories');
  const ports = String(args.ports || '')
    .split(',')
    .map((x) => lib.numArg(x, '--ports'));
  if (ports.length !== 2) throw new lib.HarnessError('--ab needs --ports <pA>,<pB>');
  const profiles = String(args.profiles || 'desktop,lowtier,startup').split(',');
  const hour = args.hour || '12';
  const recordFloor = !!args.recordFloor;
  const floorFile = args.floor && args.floor !== true ? path.resolve(String(args.floor)) : FLOOR_FILE;
  // --record-floor measures the floor, so it judges without the old one.
  const floor = recordFloor ? null : loadFloor(floorFile);
  const srvA = await lib.startPreview({ dist: distA, port: ports[0], label: 'A' });
  let srvB;
  try {
    srvB = await lib.startPreview({ dist: distB, port: ports[1], label: 'B' });
  } catch (e) {
    await srvA.stop();
    throw e;
  }
  const browser = await lib.launch();
  const sizeA = bundleSize(srvA.dist);
  const data = { mode: 'ab', distA: srvA.dist, distB: srvB.dist, bundle: { A: sizeA, B: bundleCheck(bundleSize(srvB.dist), sizeA || BUNDLE.main), againstMain: bundleCheck(bundleSize(srvB.dist)) }, sameDist: srvA.dist === srvB.dist, floorFile: floorFile.replace(/\\/g, '/'), floorRecorded: floor ? floor.recorded || null : null, floorQuiet: floor ? floorQuiet(floor) : null, profiles: {}, leaks: [], signUpMissing: 0 };
  if (recordFloor && !data.sameDist) throw new lib.HarnessError('--record-floor needs an A/A run: --ab <dist> <dist>');
  try {
    for (const prof of profiles) {
      // One discarded load per side first: the browser's shader and HTTP
      // caches start cold, and a cold first cycle would bias side A.
      for (const base of [srvA.url, srvB.url]) {
        const w = await loadCycle(browser, base, prof, { startupOnly: true, hour });
        if (w.net.leaks.length) data.leaks.push(...w.net.leaks);
      }
      const A = [];
      const B = [];
      let rows = null;
      let done = 0;
      const checkpoints = [];
      // Each profile starts at the requested cycles and escalates on its own;
      // --record-floor keeps going to 24 and keeps each checkpoint's verdict.
      let cycles = Number(args.cycles || 6);
      // --max-cycles caps the escalation (a smoke run); 24 is the verdict's own cap.
      const maxCycles = recordFloor ? 24 : Math.min(24, Number(args.maxCycles || 24));
      for (;;) {
        for (let c = done; c < cycles; c++) {
          for (const side of ['A', 'B']) {
            const base = side === 'A' ? srvA.url : srvB.url;
            const r = await loadCycle(browser, base, prof, { startupOnly: prof === 'startup', programsAtS: 30, hour });
            if (r.net.leaks.length) data.leaks.push(...r.net.leaks);
            if (!r.net.signUpSeen && !r.net.bootProofSeen) data.signUpMissing++;
            (side === 'A' ? A : B).push(r);
            process.stdout.write(`  ${prof} cycle ${c + 1}/${cycles} ${side}: welcome ${r.welcomeMs} ms${r.views ? `, spawn cpu p50 ${r.views.spawn.cpuP50} / draws ${r.views.spawn.draws}, programs ${r.programs}, hub pitch ${r.views.hub.pose.camPitch}` : ''}, host ${r.hostBusyPct}% busy (others ${r.otherBusyPct}%)\n`);
          }
        }
        done = cycles;
        rows = metricTable(prof, A, B, floor, { cycles });
        const v = overall(rows);
        checkpoints.push({ cycles, verdict: v, fails: Object.entries(rows).filter(([, r]) => r.verdict === 'fail').map(([k]) => k), inconclusive: Object.entries(rows).filter(([, r]) => r.verdict === 'inconclusive').map(([k]) => k) });
        if ((v !== 'inconclusive' && !recordFloor) || cycles >= maxCycles) break;
        cycles = Math.min(maxCycles, cycles * 2);
        process.stdout.write(`  ${prof}: ${v} at ${done} cycles, ${recordFloor ? 'recording the floor' : 'escalating'} to ${cycles}\n`);
      }
      const host = [...A, ...B].map((r) => r.hostBusyPct).filter((x) => x !== null && x !== undefined);
      const others = [...A, ...B].map((r) => r.otherBusyPct).filter((x) => x !== null && x !== undefined);
      const pose = prof === 'startup' ? null : poseCheck(A, B);
      let pv = overall(rows);
      if (pose && !pose.equal && pv !== 'fail') pv = 'inconclusive';
      data.profiles[prof] = {
        cycles: done,
        verdict: pv,
        checkpoints,
        poseCheck: pose,
        hostBusyPct: { p50: round(median(host), 1), max: host.length ? Math.max(...host) : null },
        otherBusyPct: others.length ? { p50: round(median(others), 1), max: Math.max(...others) } : null,
        metrics: rows,
        raw: { A, B },
      };
      if (pose) process.stdout.write(`  ${prof} pose check: ${pose.equal ? 'equal' : 'DIFFERENT'} — ${Object.entries(pose.views).map(([v, r]) => `${v} camera pitch A ${r.camPitch.medianA} B ${r.camPitch.medianB} rad`).join('; ')}\n`);
    }
    // --dusk: the dusk check once per side, each in a browser of its own.
    if (args.dusk) data.dusk = { A: await duskRuns(srvA.url, profiles, data), B: await duskRuns(srvB.url, profiles, data) };
  } finally {
    await browser.close().catch(() => {});
    await srvA.stop();
    await srvB.stop();
  }
  const verdicts = Object.values(data.profiles).map((p) => p.verdict);
  let v = verdicts.includes('fail') ? 'fail' : verdicts.includes('inconclusive') ? 'inconclusive' : 'pass';
  if (data.dusk) {
    // Side B is held to the bar; side A is there to show what main does.
    data.duskVerdict = duskVerdict(data.dusk.B);
    if (data.duskVerdict === 'fail') v = 'fail';
    else if (data.duskVerdict === 'inconclusive' && v === 'pass') v = 'inconclusive';
  }
  if (data.signUpMissing) v = v === 'fail' ? v : 'inconclusive';
  if (data.sameDist) {
    // A/A: pass or inconclusive, never fail; every |delta| within
    // max(T, floor); the exact counter equal on every load.
    data.aa = aaSummary(data.profiles);
    if (!data.aa.exactCountersEqual) v = 'fail';
  }
  if (recordFloor && !data.leaks.length) {
    data.floorWritten = await writeFloor(floorFile, data);
    // The same 24 cycles judged against the floor they just recorded.
    const fresh = loadFloor(floorFile);
    const rejudged = {};
    for (const [prof, p] of Object.entries(data.profiles)) {
      const rows = metricTable(prof, p.raw.A, p.raw.B, fresh, { cycles: p.cycles });
      rejudged[prof] = { verdict: overall(rows), metrics: rows };
    }
    data.withRecordedFloor = { profiles: Object.fromEntries(Object.entries(rejudged).map(([k, v]) => [k, { verdict: v.verdict }])), aa: aaSummary(rejudged) };
  }
  if (data.leaks.length) v = 'fail-closed';
  data.verdict = v;
  return data;
}

/**
 * --rejudge <perf-gate-ab.json>: the verdict maths again on a saved A/B's
 * loads (each profile's raw.A and raw.B), against the current floor file
 * (or --floor), replaying the run's checkpoints (6, 12, 24 cycles: the first
 * that is not inconclusive ends a profile, as in --ab). No browser, no
 * server: a rule change is checked on recorded runs without new loads.
 */
function modeRejudge(args) {
  const file = path.resolve(String(args.rejudge));
  const src = lib.readJson(file);
  if (!src || !src.profiles || src.mode !== 'ab') throw new lib.HarnessError(`--rejudge takes a perf-gate-ab.json; ${file} is not one`);
  const floorFile = args.floor && args.floor !== true ? path.resolve(String(args.floor)) : FLOOR_FILE;
  const floor = loadFloor(floorFile);
  const data = { mode: 'rejudge', source: file.replace(/\\/g, '/'), sourceVerdict: src.verdict, distA: src.distA, distB: src.distB, sameDist: !!src.sameDist, floorFile: floorFile.replace(/\\/g, '/'), floorRecorded: floor ? floor.recorded || null : null, floorQuiet: floor ? floorQuiet(floor) : null, profiles: {}, leaks: src.leaks || [], signUpMissing: src.signUpMissing || 0 };
  const start = Number(args.cycles || 6);
  for (const [prof, p] of Object.entries(src.profiles)) {
    const A = (p.raw && p.raw.A) || [];
    const B = (p.raw && p.raw.B) || [];
    const n = Math.min(A.length, B.length);
    if (!n) continue;
    const checkpoints = [];
    let rows = null;
    for (let c = Math.min(start, n); ; c = Math.min(n, c * 2)) {
      rows = metricTable(prof, A.slice(0, c), B.slice(0, c), floor, { cycles: c });
      const v = overall(rows);
      checkpoints.push({ cycles: c, verdict: v, fails: Object.entries(rows).filter(([, r]) => r.verdict === 'fail').map(([k]) => k), inconclusive: Object.entries(rows).filter(([, r]) => r.verdict === 'inconclusive').map(([k]) => k) });
      if (v !== 'inconclusive' || c >= n) break;
    }
    const used = checkpoints[checkpoints.length - 1].cycles;
    const pose = prof === 'startup' ? null : poseCheck(A.slice(0, used), B.slice(0, used));
    let pv = overall(rows);
    if (pose && !pose.equal && pv !== 'fail') pv = 'inconclusive';
    data.profiles[prof] = { cycles: used, verdict: pv, sourceVerdict: p.verdict, sourceCycles: p.cycles, checkpoints, poseCheck: pose, hostBusyPct: p.hostBusyPct, otherBusyPct: p.otherBusyPct, metrics: rows };
  }
  const verdicts = Object.values(data.profiles).map((p) => p.verdict);
  let v = verdicts.includes('fail') ? 'fail' : verdicts.includes('inconclusive') || !verdicts.length ? 'inconclusive' : 'pass';
  if (data.signUpMissing) v = v === 'fail' ? v : 'inconclusive';
  if (data.sameDist) {
    data.aa = aaSummary(data.profiles);
    if (!data.aa.exactCountersEqual) v = 'fail';
  }
  if (data.leaks.length) v = 'fail-closed';
  data.verdict = v;
  return data;
}

/**
 * The main chunk's size (wave-2 amendments). Wave 1 took it over Vite's
 * 1,000 kB chunk warning (vite.config.ts chunkSizeWarningLimit, which stays
 * where it is). kB are Vite's: bytes / 1000, gzip at zlib's default level.
 * - main: wave-2 main (f79c38c; 29edc9b builds the same chunk), the
 *   baseline every delta is reported against (wave-3 amendments, bundle).
 *   wave1 (8662b27) and beforeWave1 (d5e0e96) are kept for the record.
 * - gzipBudgetKB: the plan's '+50 KB transferred before the card' (the main
 *   chunk is fetched before the card); the gating half of the check. The
 *   budget stays anchored at budgetBase (wave-1 main), so rebasing main
 *   does not hand the budget back: wave 2 used +21.97 kB of it.
 * - lazyCandidate: the largest whole module in the chunk that nothing needs
 *   before the welcome card, measured on ux/w2-perf-gate by minifying each
 *   module of the chunk on its own (esbuild, then gzip). GameScene.ts,
 *   SimpleUI.ts, Island.ts and main-simple.ts are 69% of the chunk and are
 *   not candidates as whole files. A moves it in wave 3 (amendments, A).
 * - nextCandidate: the one the report names for wave 4.
 */
const BUNDLE = {
  warnKB: 1000,
  main: { rawKB: 1073.23, gzipKB: 333.82, at: 'wave-2 main (f79c38c)' },
  wave1: { rawKB: 1004.45, gzipKB: 311.85, at: 'wave-1 main (8662b27)' },
  beforeWave1: { rawKB: 930.89, gzipKB: 288.04, at: 'main before wave 1 (d5e0e96)' },
  gzipBudgetKB: 50,
  budgetBase: { rawKB: 1004.45, gzipKB: 311.85, at: 'wave-1 main (8662b27)' },
  nextCandidate: {
    module: 'Chat.ts',
    minKB: 7.0,
    gzipKB: 2.77,
    how: "once SimpleUI.ts stops importing Chat's VOICE_MAX_MS (wave 4)",
  },
  lazyCandidate: {
    module: 'Multiplayer.ts',
    minKB: 14.07,
    gzipKB: 5.17,
    owners: 'A imports it (main-simple.ts), B owns the file',
    how: "main-simple.ts builds it after the world, so a dynamic import() there moves it out; Chat.ts (7.0 kB, 2.77 gzip) can follow once SimpleUI.ts stops importing Chat's VOICE_MAX_MS",
  },
};
const kB = (bytes) => round(bytes / 1000, 2);
/** A dist's main chunk: { file, rawKB, gzipKB }, or null when the dist has none (a --base run). */
function bundleSize(dist) {
  try {
    const dir = path.join(dist, 'assets');
    const file = fs.readdirSync(dir).find((f) => /^main-[\w-]+\.js$/.test(f));
    if (!file) return null;
    const buf = fs.readFileSync(path.join(dir, file));
    return { file, rawKB: kB(buf.length), gzipKB: kB(zlib.gzipSync(buf).length) };
  } catch (e) {
    return null;
  }
}
/**
 * A main chunk against a baseline ({ rawKB, gzipKB }; BUNDLE.main unless side
 * A of an A/B is given). The deltas are against that baseline. pass: gzip is
 * no more than gzipBudgetKB over BUNDLE.budgetBase (budgetUsedKB).
 * overWarning is reported, never gating: the chunk was already over on main.
 */
function bundleCheck(size, base = BUNDLE.main) {
  if (!size) return null;
  const deltaRawKB = round(size.rawKB - base.rawKB, 2);
  const deltaGzipKB = round(size.gzipKB - base.gzipKB, 2);
  const budgetUsedKB = round(size.gzipKB - BUNDLE.budgetBase.gzipKB, 2);
  const overWarningKB = round(size.rawKB - BUNDLE.warnKB, 2);
  return { ...size, base, deltaRawKB, deltaGzipKB, budgetUsedKB, overWarning: overWarningKB > 0, overWarningKB, pass: budgetUsedKB <= BUNDLE.gzipBudgetKB };
}

/** A dist's entry bundle (main-<hash>.js), or its folder name when it has none. */
function bundleOf(dist) {
  try {
    const m = fs.readdirSync(path.join(dist, 'assets')).find((f) => /^main-[\w-]+\.js$/.test(f));
    if (m) return m;
  } catch (e) {}
  return path.basename(dist);
}

/**
 * The floor's own record of how quiet the host was: per profile, the median
 * share of the machine that other processes took during the loads, against
 * QUIET_OTHER_PCT. A floor recorded busier than that is marked, and every run
 * that reads it says so.
 */
const QUIET_OTHER_PCT = 10;
/**
 * Was the host quiet for a profile's loads? otherBusyPct is { p50, max }, the
 * share of the machine other processes took. Over QUIET_OTHER_PCT the timing
 * rows are noise: an inconclusive verdict is then the host's, not the
 * build's, and the run is to be made again, alone (wave-2 amendments).
 */
function hostNote(otherBusyPct, verdict) {
  if (!otherBusyPct || !isNum(otherBusyPct.p50)) return null;
  if (otherBusyPct.p50 <= QUIET_OTHER_PCT) return null;
  const what = verdict === 'inconclusive' ? 'this inconclusive verdict is the host\'s, not the build\'s' : verdict === 'fail' ? 'counters hold, but confirm any timing fail on a quiet host' : 'timing rows passed in spite of it';
  return `host not quiet: other processes took ${otherBusyPct.p50}% of the machine (median; quiet is ${QUIET_OTHER_PCT}% or less). Run the gate alone: ${what}`;
}
function floorQuiet(floor) {
  const q = floor && floor.recorded && floor.recorded.quiet;
  if (!q || typeof q !== 'object') return { known: false, busy: [] };
  return { known: true, busy: Object.entries(q).filter(([, v]) => v === false).map(([p]) => p) };
}

/**
 * --record-floor: per profile, each timing's 24-cycle A/A band (the sigma the
 * verdict rule uses) and each counter's 24-cycle A/A spread (aaSpread: the
 * 99th percentile of |delta| over resampled A/As, with the counter's own
 * statistic), written through prettier (format:check covers *.json). The
 * host's quiet share is recorded beside them.
 */
async function writeFloor(file, data) {
  const quiet = {};
  const other = {};
  for (const [p, x] of Object.entries(data.profiles)) {
    other[p] = x.otherBusyPct || null;
    quiet[p] = !!(x.otherBusyPct && isNum(x.otherBusyPct.p50) && x.otherBusyPct.p50 <= QUIET_OTHER_PCT);
  }
  const out = {
    about:
      "The perf gate's floor on this rig, from a 24-cycle A/A. A timing's floor is its 95% band (the gate's sigma over the paired deltas); a timing whose budget T is under 2 x its floor is judged by its proxy (FxBudget µs for CPU) or reported unresolvable. A counter's floor is its A/A spread: the 99th percentile of |delta| over 2,000 seeded resampled 24-cycle A/As, with the statistic it is judged by (the per-side median, or the boot-race mix for programs); a counter passes when its delta is within max(T, floor). 'quiet' says whether other processes took no more than quietOtherPct of the machine (median over the loads) while it was recorded. Rewrite with: npm run perf:gate -- --ab <dist> <dist> --ports <a>,<b> --record-floor",
    recorded: {
      at: new Date().toISOString(),
      // The build by its entry bundle, not by a local path.
      build: bundleOf(data.distA),
      cycles: Object.fromEntries(Object.entries(data.profiles).map(([p, x]) => [p, x.cycles])),
      hostBusyPct: Object.fromEntries(Object.entries(data.profiles).map(([p, x]) => [p, x.hostBusyPct])),
      otherBusyPct: other,
      quietOtherPct: QUIET_OTHER_PCT,
      quiet,
      rig: `${require('os').cpus()[0].model.trim()}, ${require('os').cpus().length} threads`,
    },
    profiles: {},
  };
  for (const [prof, p] of Object.entries(data.profiles)) {
    out.profiles[prof] = {};
    for (const [k, r] of Object.entries(p.metrics || {})) {
      if (r.kind === 'counter' && r.floorInput) {
        const s = aaSpread(r.floorInput, { name: `${prof}:${k}` });
        if (isNum(s)) out.profiles[prof][k] = s;
      } else if (isNum(r.sigma)) out.profiles[prof][k] = round(r.sigma, 4);
    }
  }
  let text = JSON.stringify(out, null, 2) + '\n';
  try {
    const prettier = require(require.resolve('prettier', { paths: [lib.REPO] }));
    text = await prettier.format(text, { ...((await prettier.resolveConfig(file)) || {}), parser: 'json' });
  } catch (e) {
    out.note = `written without prettier: ${String(e).slice(0, 120)}`;
  }
  fs.writeFileSync(file, text);
  return file.replace(/\\/g, '/');
}

/**
 * One off/on pair for --fx, with the live loop stopped so nothing moves
 * between the two sides: per side, the switch is set, then two app frames
 * run (the update callback with a 1/240 s step, so the effect applies its
 * switch while villagers move ~1 cm, then a whole render). Draws and
 * triangles are the mean of the two frames (a half-rate pass averages out);
 * programs are read after them.
 */
const FX_PAIR = ({ name }) => {
  const sr = window.__app.renderer;
  const R = sr.getRenderer();
  sr.stopRenderLoop();
  const side = (v) => {
    window.__dsFx = window.__dsFx || {};
    window.__dsFx[name] = v;
    let draws = 0;
    let triangles = 0;
    let shadow = 0;
    for (let k = 0; k < 2; k++) {
      sr.renderCallback(1 / 240);
      R.info.reset();
      sr.render();
      draws += R.info.render.calls;
      triangles += R.info.render.triangles;
      shadow += window.__gate.shadowNow || 0;
    }
    return { draws: draws / 2, triangles: triangles / 2, shadowDraws: shadow / 2, programs: R.info.programs ? R.info.programs.length : null };
  };
  const off = side(false);
  const on = side(true);
  sr.isRunning = false;
  sr.startRenderLoop(sr.scene, sr.camera, sr.renderCallback);
  return { off, on };
};

/**
 * --fx <name>: the effect starts OFF before any page script runs. 30 s after
 * the card, each view is posed and measured with 4 off/on pairs (FX_PAIR:
 * whole-frame draws, triangles and programs per side, nothing moving in
 * between); programs the ON sides add are the effect's. Then 6 x 1.5 s per
 * side of timing at the spawn, escalating like --ab.
 */
// E4's modal scenario: main-thread busy time (long tasks and long animation
// frames, merged, per second) and Event Timing durations for taps on the
// panel's buttons, recorded from the first script.
const MODAL_INIT = `(() => {
  if (window.top !== window) return;
  const M = (window.__modal = { busy: [], events: [] });
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) M.busy.push([e.startTime, e.startTime + e.duration]); }).observe({ type: 'longtask', buffered: true }); } catch (e) {}
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) M.busy.push([e.startTime, e.startTime + e.duration]); }).observe({ type: 'long-animation-frame', buffered: true }); } catch (e) {}
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) M.events.push({ t: e.startTime, name: e.name, d: e.duration }); }).observe({ type: 'event', durationThreshold: 16, buffered: true }); } catch (e) {}
})();`;
/** Busy ms per second over [a, b): the union of the recorded intervals, clipped. */
const BUSY = ([a, b]) => {
  const iv = window.__modal.busy.filter((x) => x[1] > a && x[0] < b).map((x) => [Math.max(a, x[0]), Math.min(b, x[1])]).sort((x, y) => x[0] - y[0]);
  let sum = 0;
  let cur = null;
  for (const x of iv) {
    if (!cur || x[0] > cur[1]) {
      if (cur) sum += cur[1] - cur[0];
      cur = [x[0], x[1]];
    } else cur[1] = Math.max(cur[1], x[1]);
  }
  if (cur) sum += cur[1] - cur[0];
  return +(sum / ((b - a) / 1000)).toFixed(1);
};
// E4's bar: the main thread busy under 400 ms a second behind Projects (from about 1005).
const MODAL_BUSY_MS_S = 400;

/** The Projects panel through the UI on a touch build: the drawer, the Portfolio menu, Projects. */
async function openProjects(page) {
  const tapSel = async (sel) => {
    const r = await page.evaluate((s) => {
      const el = document.querySelector(s);
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return b.width > 1 ? [b.left + b.width / 2, b.top + b.height / 2] : null;
    }, sel);
    if (!r) return false;
    await page.touchscreen.tap(r[0], r[1]);
    return true;
  };
  await tapSel('.hud-btn[aria-label="Open island menu"]');
  await page.waitForTimeout(800);
  await tapSel('.hud-btn[aria-label="Open portfolio menu"]');
  await page.waitForTimeout(1000);
  const ok = await tapSel('button[data-section="projects"]');
  await page.waitForTimeout(1500);
  return { tapped: ok, panel: await page.evaluate(() => window.__app.ui.panels.current()) };
}

/**
 * --fx modalDivisor (E4): the lowtier4x profile, governor live. Projects is
 * opened through the UI, then the switch alternates off and on behind it
 * (__dsFx.modalDivisor, read per frame), 4 s a side for --cycles cycles:
 * per side the main-thread busy ms/s and the Event Timing durations of taps
 * on the panel's own buttons (non-closing ones). The panel region's pixels
 * on against off, and the governor rung before and after.
 */
async function modeModal(args) {
  const server = await lib.serve({ base: args.base, dist: args.dist, port: args.port });
  const browser = await lib.launch();
  const p = LOWTIER4X();
  const cycles = Number(args.cycles || 4);
  const data = { mode: 'fx', effect: 'modalDivisor', scenario: 'modal', profile: p.name, profiles: {}, checks: [], leaks: [], signUpMissing: 0 };
  try {
    const s = await lib.openSession(browser, p, { init: [GATE_INIT({ nogpu: true }), MODAL_INIT], fx: { modalDivisor: false } });
    const { page } = s;
    const set = (v) => page.evaluate((x) => (window.__dsFx = Object.assign(window.__dsFx || {}, { modalDivisor: x })), v);
    try {
      await bootPage(page, server.url, p, args.hour || '12');
      await page.click(`${lib.WELCOME} button[data-dismiss]`).catch(() => {});
      await page.waitForTimeout(8000);
      data.governorBefore = await page.evaluate(GOV_STATE);
      data.open = await openProjects(page);
      if (data.open.panel !== 'zone') throw new Error(`hook missing: the Projects panel did not open (${JSON.stringify(data.open)})`);
      const buttons = await page.evaluate(() => {
        const z = window.__app.ui.zonePanelDiv;
        if (!z) return [];
        return [...z.querySelectorAll('button, [role=tab]')]
          .filter((b) => !/close|×|✕|back|leave/i.test(`${b.getAttribute('aria-label') || ''} ${b.textContent || ''}`) && !b.closest('a'))
          .slice(0, 6)
          .map((b) => {
            const r = b.getBoundingClientRect();
            return [r.left + r.width / 2, r.top + r.height / 2];
          })
          .filter(([x, y]) => x > 0 && y > 0 && y < innerHeight);
      });
      const sides = { off: { busy: [], events: [] }, on: { busy: [], events: [] } };
      for (let c = 0; c < cycles; c++) {
        for (const side of ['off', 'on']) {
          await set(side === 'on');
          await page.waitForTimeout(600);
          const t0 = await page.evaluate(() => performance.now());
          // --no-taps: the busy time of the panel left alone.
          const taps = args.noTaps ? [] : buttons.slice(0, 3);
          for (const [x, y] of taps) {
            await page.touchscreen.tap(x, y);
            await page.waitForTimeout(700);
          }
          await page.waitForTimeout(Math.max(0, 4000 - taps.length * 700));
          const t1 = await page.evaluate(() => performance.now());
          sides[side].busy.push(await page.evaluate(BUSY, [t0, t1]));
          sides[side].events.push(...(await page.evaluate(([a, b]) => window.__modal.events.filter((e) => e.t >= a && e.t < b && /pointer|click|touch/.test(e.name)).map((e) => e.d), [t0, t1])));
          sides[side].state = await page.evaluate(GOV_STATE);
        }
      }
      // The panel region, on against off (the canvas behind a translucent panel).
      const rect = await page.evaluate(() => {
        const z = window.__app.ui.zonePanelDiv;
        const r = z.getBoundingClientRect();
        return { x: Math.max(0, r.left), y: Math.max(0, r.top), width: Math.min(innerWidth, r.width), height: Math.min(innerHeight - Math.max(0, r.top), r.height) };
      });
      const shot = async (v) => {
        await set(v);
        await page.waitForTimeout(800);
        const buf = await page.screenshot({ clip: rect });
        fs.writeFileSync(path.join(lib.outDir(args, 'perf-gate'), `modal-panel-${v ? 'on' : 'off'}.png`), buf);
        return lib.pngDecode(buf);
      };
      const a = await shot(false);
      const b = await shot(true);
      let diff = 0;
      for (let i = 0; i < a.data.length; i += 4) if (Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2]) > 24) diff++;
      data.panelDiffPct = +((100 * diff) / (a.data.length / 4)).toFixed(2);
      await set(null);
      await page.evaluate(() => window.__app.ui.panels.closeAll());
      await page.waitForTimeout(3000);
      data.governorAfter = await page.evaluate(GOV_STATE);
      data.sides = { off: { busy: sides.off.busy, eventsMs: sides.off.events, divisor: sides.off.state && sides.off.state.modalDivisor }, on: { busy: sides.on.busy, eventsMs: sides.on.events, divisor: sides.on.state && sides.on.state.modalDivisor } };
    } finally {
      await s.close({ waitSignUpMs: 20000 });
      if (s.net.leaks.length) data.leaks.push(...s.net.leaks);
      if (!s.net.signUpSeen && !s.net.bootProofSeen) data.signUpMissing++;
    }
  } finally {
    await browser.close().catch(() => {});
    await server.stop();
  }
  const check = (name, pass, value, expect) => data.checks.push({ name, pass, value, expect });
  const S = data.sides;
  if (S) {
    check('lowtier4x behind Projects, divisor on: main thread busy ms/s (median)', median(S.on.busy) < MODAL_BUSY_MS_S, { on: median(S.on.busy), off: median(S.off.busy) }, `< ${MODAL_BUSY_MS_S} (wave-2 main: about 1005)`);
    const eOn = S.on.eventsMs.length ? median(S.on.eventsMs) : null;
    const eOff = S.off.eventsMs.length ? median(S.off.eventsMs) : null;
    check('Event Timing durations of taps on the panel fall (one-sided, T = 0)', eOn === null || eOff === null ? null : eOn - eOff <= 0, { on: eOn, off: eOff, nOn: S.on.eventsMs.length, nOff: S.off.eventsMs.length }, 'on - off <= 0 ms');
    check('the panel region on against off', data.panelDiffPct < 1, data.panelDiffPct, '< 1% of pixels');
    check('the governor rung is the same before and after', data.governorBefore.qualityRung === data.governorAfter.qualityRung, [data.governorBefore.qualityRung, data.governorAfter.qualityRung], 'equal');
  }
  data.verdict = data.leaks.length ? 'fail-closed' : data.signUpMissing ? 'inconclusive' : data.checks.some((c) => c.pass === false) ? 'fail' : data.checks.some((c) => c.pass === null) ? 'inconclusive' : 'pass';
  return data;
}

async function modeFx(args) {
  const name = String(args.fx);
  // E4's modal divisor is measured behind a panel on the 4x low tier, not by off/on frame pairs.
  if (name === 'modalDivisor' && !args.pairs) return modeModal(args);
  const server = await lib.serve({ base: args.base, dist: args.dist, port: args.port });
  const browser = await lib.launch();
  const profiles = String(args.profiles || 'desktop,lowtier')
    .split(',')
    .filter((p) => p !== 'startup');
  const hour = args.hour || '12';
  const data = { mode: 'fx', effect: name, profiles: {}, leaks: [], signUpMissing: 0 };
  try {
    for (const prof of profiles) {
      const p = lib.profile(prof);
      const T = THRESHOLDS[prof];
      const s = await lib.openSession(browser, p, { init: [GATE_INIT({ nogpu: false })], fx: { [name]: false } });
      const { page } = s;
      const set = (on) =>
        page.evaluate(
          ([n, v]) => {
            window.__dsFx = window.__dsFx || {};
            window.__dsFx[n] = v;
          },
          [name, on],
        );
      try {
        await bootPage(page, server.url, p, hour);
        await settleAfterCard(page, 30);
        // Counters: per view, 4 off/on pairs with the world held still.
        const counters = {};
        let programsAdded = 0;
        for (const vd of VIEW_DEFS) {
          const view = vd.name;
          await page.evaluate(POSE, { view });
          await page.waitForTimeout(vd.fxSettleMs);
          const off = [];
          const on = [];
          for (let k = 0; k < 4; k++) {
            const pair = await page.evaluate(FX_PAIR, { name });
            off.push(pair.off);
            on.push(pair.on);
            programsAdded += pair.on.programs - pair.off.programs;
            await page.waitForTimeout(250);
          }
          counters[view] = {
            draws: judge(
              off.map((x) => x.draws),
              on.map((x) => x.draws),
              T[DRAW_KEY[view]],
            ),
            triangles: judge(
              off.map((x) => x.triangles),
              on.map((x) => x.triangles),
              null,
            ),
            off,
            on,
          };
        }
        // Timing at the spawn, interleaved.
        await page.evaluate(POSE, { view: 'spawn' });
        await page.waitForTimeout(800);
        const offW = [];
        const onW = [];
        let cycles = Number(args.cycles || 6);
        let done = 0;
        let rows;
        for (;;) {
          for (let c = done; c < cycles; c++) {
            await set(false);
            await page.waitForTimeout(400);
            offW.push(await windowStats(page, 1500));
            await set(true);
            await page.waitForTimeout(400);
            onW.push(await windowStats(page, 1500));
          }
          done = cycles;
          rows = {
            'spawn: CPU p50 ms': { kind: 'timing', ...judge(offW.map((x) => x.cpuP50), onW.map((x) => x.cpuP50), T.cpuP50) },
            'spawn: CPU p95 ms': { kind: 'timing', ...judge(offW.map((x) => x.cpuP95), onW.map((x) => x.cpuP95), T.cpuP95) },
          };
          rows['spawn: CPU mean ms'] = { kind: 'timing', ...judge(offW.map((x) => x.cpuMean), onW.map((x) => x.cpuMean), null) };
          rows['spawn: GPU p50 ms'] = { kind: 'timing', ...judge(offW.map((x) => x.gpuP50), onW.map((x) => x.gpuP50), T.gpuP50 ?? null) };
          for (const view of VIEWS) rows[`${view}: draws`] = { kind: 'counter', ...counters[view].draws };
          // What the effect is meant to save (FX_CREDIT), held beside the budgets.
          const credit = (FX_CREDIT[name] || {})[prof] || null;
          if (credit) {
            if (isNum(credit.gpuP50)) rows['credit: spawn GPU p50 ms'] = { kind: 'credit', ...judgeCredit(offW.map((x) => x.gpuP50), onW.map((x) => x.gpuP50), credit.gpuP50) };
            if (isNum(credit.cpuMean)) rows['credit: spawn mean CPU ms'] = { kind: 'credit', ...judgeCredit(offW.map((x) => x.cpuMean), onW.map((x) => x.cpuMean), credit.cpuMean, { ciUpper: true }) };
            const sd = (side) => median(counters.spawn[side].map((x) => x.shadowDraws));
            if (credit.shadowDrawsSpawn) {
              const { value, tol } = credit.shadowDrawsSpawn;
              rows['credit: spawn shadow draws with the effect on'] = { kind: 'credit', verdict: Math.abs(sd('on') - value) <= tol ? 'pass' : 'fail', medianA: round(sd('off'), 1), medianB: round(sd('on'), 1), delta: round(sd('on') - sd('off'), 1), threshold: `${value} +-${tol}`, n: counters.spawn.on.length };
            }
            if (credit.shadowDrawsUnchanged) rows['credit: spawn shadow draws unchanged'] = { kind: 'credit', verdict: Math.abs(sd('on') - sd('off')) <= 0.5 ? 'pass' : 'fail', medianA: round(sd('off'), 1), medianB: round(sd('on'), 1), delta: round(sd('on') - sd('off'), 1), threshold: 'on = off', n: counters.spawn.on.length };
          }
          rows['programs the effect adds'] = { kind: 'counter', verdict: programsAdded <= T.programs ? 'pass' : 'fail', delta: programsAdded, threshold: T.programs, n: 1 };
          const us = onW.map((x) => (x.fxUsPerFrame || {})[name]).filter((x) => x !== null && x !== undefined);
          // The effect's own ledger line when plan-r3 gives one, inside the tier's per-effect cap.
          const usCap = Math.min(FX_US[prof], ledgerUs(name, prof) ?? FX_US[prof]);
          rows['µs per frame (FxBudget)'] = us.length ? { kind: 'µs', verdict: median(us) <= usCap ? 'pass' : 'fail', medianB: round(median(us), 2), threshold: usCap, ledger: ledgerUs(name, prof) } : { kind: 'µs', verdict: 'n/a', note: 'not timed by fx.time (unregistered or ?perf=1 off)' };
          // plan-r3 rules: at most 3 animated elements at once.
          const anim = onW.map((x) => x.animatedMax).filter(isNum);
          rows['animated elements with the effect on (max)'] = anim.length ? { kind: 'counter', verdict: Math.max(...anim) <= 3 ? 'pass' : 'fail', medianB: Math.max(...anim), threshold: 3 } : { kind: 'counter', verdict: 'n/a' };
          if (overall(rows) !== 'inconclusive' || cycles >= 24) break;
          cycles = Math.min(24, cycles * 2);
        }
        await set(null);
        const fxNow = await page.evaluate(FX_SNAPSHOT);
        data.profiles[prof] = {
          cycles: done,
          verdict: overall(rows),
          metrics: rows,
          ledger: {
            defaults: (fxNow.effects || {})[name] || null,
            draws: Object.fromEntries(VIEWS.map((v) => [v, counters[v].draws.delta])),
            programs: programsAdded,
            usPerFrame: rows['µs per frame (FxBudget)'].medianB ?? null,
          },
          counters: Object.fromEntries(VIEWS.map((v) => [v, { off: counters[v].off, on: counters[v].on, triangles: counters[v].triangles }])),
          raw: { off: offW, on: onW },
        };
      } finally {
        await s.close({ waitSignUpMs: 20000 });
        if (s.net.leaks.length) data.leaks.push(...s.net.leaks);
        if (!s.net.signUpSeen && !s.net.bootProofSeen) data.signUpMissing++;
      }
    }
  } finally {
    await browser.close().catch(() => {});
    await server.stop();
  }
  const vs = Object.values(data.profiles).map((p) => p.verdict);
  data.verdict = data.leaks.length ? 'fail-closed' : vs.includes('fail') ? 'fail' : vs.includes('inconclusive') || data.signUpMissing ? 'inconclusive' : 'pass';
  return data;
}

// E3: the 4x low tier. 390x844, DPR 2, touch, 4x CPU, GPU timer queries off
// (they inflate throttled CPU time by ~15%, as for 'startup').
const LOWTIER4X = () => ({ ...lib.profile('lowtier'), name: 'lowtier4x', cpu: 4 });
/** The governor's state: E3's snapshot where the build has it, else the private fields. */
const GOV_STATE = () => {
  const sr = window.__app.renderer;
  if (typeof sr.getGovernorState === 'function') return { ...sr.getGovernorState(), armed: sr.governorArmed, lowBar: sr.fpsLowThreshold, lowStreak: sr.lowStreak, via: 'getGovernorState' };
  return { renderScale: sr.renderScale, fpsEma: sr.fpsEma, cpuEma: sr.cpuEma ?? null, qualityRung: sr.qualityRung, cpuBound: sr.cpuBound ?? null, modalDivisor: null, via: 'fields' };
};
// E3's bars: on the 4x low tier after 30 s the scale is 0.9 or more (from
// 0.48 on wave-2 main) and 16 fps or more; with ?gpuheavy=1 on the low tier
// at DPR 2 the scale drops below 0.9 within 20 s.
const GOVERNOR_BARS = { scaleAt30s: 0.9, fpsAt30s: 16, gpuHeavyShedS: 20 };

/**
 * --governor (E3): one fresh load with the governor LIVE (never pinned). The
 * default is the lowtier4x profile, idle at the spawn after the card: the
 * governor state each second for 30 s, then renderScale and the delivered fps
 * over the last 5 s. --gpuheavy instead boots the 1x low tier with
 * ?gpuheavy=1 (one extra full-screen pass) and records when renderScale
 * first drops below 0.9.
 */
async function modeGovernor(args) {
  const server = await lib.serve({ base: args.base, dist: args.dist, port: args.port });
  const browser = await lib.launch();
  const heavy = !!args.gpuheavy;
  const base = heavy ? lib.profile('lowtier') : LOWTIER4X();
  const profObj = heavy ? { ...base, name: 'lowtier-gpuheavy', query: `${base.query || ''}&gpuheavy=1` } : base;
  const seconds = Number(args.seconds || (heavy ? 20 : 30));
  const data = { mode: 'governor', profile: profObj.name, cpu: profObj.cpu, seconds, bars: GOVERNOR_BARS, samples: [], checks: [], leaks: [], signUpMissing: 0 };
  try {
    const meter = await lib.hostLoadMeter(browser);
    const s = await lib.openSession(browser, profObj, { init: [GATE_INIT({ nogpu: true })] });
    const { page } = s;
    try {
      await bootPage(page, server.url, profObj, args.hour || '12');
      await page.click(`${lib.WELCOME} button[data-dismiss]`).catch(() => {});
      const t0 = Date.now();
      for (let i = 1; i <= seconds; i++) {
        await page.waitForTimeout(Math.max(0, i * 1000 - (Date.now() - t0)));
        data.samples.push({ s: i, ...(await page.evaluate(GOV_STATE)) });
      }
      // Delivered app frames over the last 5 s (the gate's per-frame hook).
      data.fpsLast5s = await page.evaluate(() => {
        const now = performance.now();
        return +(window.__gate.frames.filter((f) => f.t >= now - 5000).length / 5).toFixed(1);
      });
    } finally {
      const load = await meter.stop();
      data.otherBusyPct = load.otherBusyPct;
      await s.close({ waitSignUpMs: 20000 });
      if (s.net.leaks.length) data.leaks.push(...s.net.leaks);
      if (!s.net.signUpSeen && !s.net.bootProofSeen) data.signUpMissing++;
    }
  } finally {
    await browser.close().catch(() => {});
    await server.stop();
  }
  const last = data.samples[data.samples.length - 1] || {};
  const check = (name, pass, value, expect) => data.checks.push({ name, pass, value, expect });
  if (heavy) {
    const first = data.samples.find((x) => x.renderScale < GOVERNOR_BARS.scaleAt30s);
    check(`lowtier ?gpuheavy=1: renderScale under ${GOVERNOR_BARS.scaleAt30s} within ${GOVERNOR_BARS.gpuHeavyShedS} s`, !!first && first.s <= GOVERNOR_BARS.gpuHeavyShedS, first ? `${first.renderScale} at ${first.s} s` : `never (last ${last.renderScale})`, `<= ${GOVERNOR_BARS.gpuHeavyShedS} s`);
  } else {
    check(`lowtier4x: renderScale after ${seconds} s`, last.renderScale >= GOVERNOR_BARS.scaleAt30s, last.renderScale, `>= ${GOVERNOR_BARS.scaleAt30s} (wave-2 main: 0.48)`);
    check(`lowtier4x: fps after ${seconds} s`, data.fpsLast5s >= GOVERNOR_BARS.fpsAt30s, data.fpsLast5s, `>= ${GOVERNOR_BARS.fpsAt30s}`);
  }
  data.verdict = data.leaks.length ? 'fail-closed' : data.signUpMissing ? 'inconclusive' : data.checks.every((c) => c.pass) ? 'pass' : 'fail';
  return data;
}

async function modeReport(args) {
  const server = await lib.serve({ base: args.base, dist: args.dist, port: args.port });
  const browser = await lib.launch();
  const profiles = String(args.profiles || 'desktop,lowtier,startup').split(',');
  const data = { mode: 'report', profiles: {}, checks: [], leaks: [], signUpMissing: 0 };
  const check = (name, pass, value, expect, reportOnly = false) => data.checks.push({ name, pass, value, expect, reportOnly });
  const goldenFile = args.seed ? lib.goldenPath(args) : null;
  const golden = goldenFile ? lib.readJson(goldenFile) : null;
  if (goldenFile) data.seedGolden = { file: goldenFile.replace(/\\/g, '/'), present: !!golden };
  try {
    for (const prof of profiles) {
      const r = await loadCycle(browser, server.url, prof, { startupOnly: prof === 'startup', programsAtS: 30, seed: !!args.seed, hour: args.hour || '12' });
      if (r.net.leaks.length) data.leaks.push(...r.net.leaks);
      if (!r.net.signUpSeen && !r.net.bootProofSeen) data.signUpMissing++;
      data.profiles[prof] = r;
      if (prof === 'startup') {
        check('startup (4x): welcome_visible ms', true, r.welcomeMs, 'reported', true);
        continue;
      }
      const base = BASELINE[prof];
      // Budgets against main's documented baseline (the A/B mode is authoritative).
      check(`${prof}: programs 30 s after the card`, r.programs <= base.programs + base.programsTol, r.programs, `<= ${base.programs + base.programsTol} (main ${base.programs} ±${base.programsTol})`);
      const dSpawn = THRESHOLDS[prof].drawsSpawn;
      check(`${prof}: idle spawn draws`, r.views.spawn.draws <= base.draws.spawn + dSpawn, r.views.spawn.draws, `<= ${base.draws.spawn + dSpawn} (main ~${base.draws.spawn})`);
      for (const v of ['hub', 'projects']) check(`${prof}: ${v} draws (report-only; A/B gates them)`, null, r.views[v].draws, prof === 'desktop' ? `main ~${base.draws[v]}` : 'reported', true);
      if (prof === 'lowtier') {
        check('lowtier: no 2048² maps', r.maps2048 === 0, r.maps2048, 0);
      }
      // µs accounting for every registered effect.
      const fxUs = {};
      for (const v of Object.values(r.views)) for (const [n, us] of Object.entries(v.fxUsPerFrame || {})) (fxUs[n] = fxUs[n] || []).push(us);
      let total = 0;
      for (const [n, arr] of Object.entries(fxUs)) {
        const m = median(arr);
        total += m || 0;
        check(`${prof}: ${n} µs/frame`, m <= FX_US[prof], round(m, 2), `<= ${FX_US[prof]}`);
      }
      const cap = prof === 'desktop' ? FX_US.totalDesktop : FX_US.totalLowtier;
      check(`${prof}: all effects µs/frame`, total <= cap, round(total, 2), `<= ${cap}`);
      if (prof === 'desktop') check('desktop: idle CPU p95 ms (sanity, report-only)', null, r.views.spawn.cpuP95, `~${BASELINE.desktop.idleCpuP95} ±15% on the audit rig`, true);
      check(`${prof}: render() calls that created programs (B2 ledger, report-only)`, null, r.renderProgramAdds.map((x) => `+${x.added} ${x.ms} ms`), 'none after B2', true);
      check(`${prof}: host CPU busy during the load (report-only)`, null, r.hostBusyPct, 'other sessions add timing noise', true);
      // P2-E3: the vehicle and room views. The room's draws are gated by the
      // A/B (main + 25 on desktop, main + 0 on the low tier); its first door
      // is held to the ledger's absolute bars here too.
      const veh = r.views.vehicle;
      const room = r.room;
      const T = THRESHOLDS[prof];
      check(`${prof}: the vehicle view has more draws than the idle spawn (report-only)`, null, { vehicle: veh.draws, spawn: r.views.spawn.draws, offPathU: veh.drive.offPathU, alongU: veh.drive.alongU }, 'vehicle > spawn', true);
      check(`${prof}: room, the first door's longest frame ms`, room.inside ? room.firstDoorFrameMs <= T.roomFirstDoorMs : false, room.inside ? room.firstDoorFrameMs : room.error, `<= ${T.roomFirstDoorMs}`);
      check(`${prof}: room, programs added on entry`, room.inside ? room.programsAdded <= T.roomProgramsAdded : false, room.programsAdded, `<= ${T.roomProgramsAdded}`);
      check(`${prof}: room, black interval ms (report-only)`, null, { pixels: room.blackMsPixels, opacity: room.blackMsOpacity, press: room.press }, 'reported', true);
      check(`${prof}: room draws and render p50 ms (report-only; A/B gates the draws)`, null, { draws: room.draws, renP50: room.renP50 }, prof === 'desktop' ? `main + ${T.drawsRoom}` : 'no more than main', true);
      if (args.seed) {
        const g = lib.goldenFor(golden, prof);
        const rel = path.relative(process.cwd(), goldenFile);
        const label = `${prof}: __dsSeedDraws vs ${(rel && !rel.startsWith('..') ? rel : goldenFile).replace(/\\/g, '/')}`;
        if (!r.seed) check(label, null, 'seed counter absent', 'report only', true);
        else if (!g) check(label, null, golden ? `golden has no ${prof} entry` : `golden absent: ${goldenFile.replace(/\\/g, '/')}`, 'report only', true);
        else check(label, JSON.stringify({ total: r.seed.total, marks: r.seed.marks }) === JSON.stringify({ total: g.total, marks: g.marks }), r.seed.total, g.total);
      }
    }
  } finally {
    await browser.close().catch(() => {});
    await server.stop();
  }
  // The main chunk against wave-1 main (needs a dist on disk; a --base run has none).
  const bundle = bundleCheck(server.dist ? bundleSize(server.dist) : null);
  data.bundle = bundle;
  if (bundle) {
    const m = BUNDLE.main;
    const c = BUNDLE.lazyCandidate;
    const n = BUNDLE.nextCandidate;
    const b = BUNDLE.budgetBase;
    check(`bundle: main chunk gzip kB inside the budget (${bundle.file})`, bundle.pass, { gzipKB: bundle.gzipKB, delta: bundle.deltaGzipKB, budgetUsed: bundle.budgetUsedKB }, `<= ${b.gzipKB} + ${BUNDLE.gzipBudgetKB} (${b.at}); delta against ${m.at} ${m.gzipKB}`);
    check('bundle: main chunk raw kB against main (report-only)', null, { rawKB: bundle.rawKB, delta: bundle.deltaRawKB }, `main ${m.rawKB} (${m.at}); wave 1 ${BUNDLE.wave1.rawKB}; before wave 1 ${BUNDLE.beforeWave1.rawKB} raw, ${BUNDLE.beforeWave1.gzipKB} gzip`, true);
    check(`bundle: over Vite's ${BUNDLE.warnKB} kB chunk warning (report-only; the limit stays)`, null, bundle.overWarning ? `over by ${bundle.overWarningKB} kB` : `under by ${-bundle.overWarningKB} kB`, `lazy-load candidate this wave: ${c.module}, ${c.minKB} kB minified, ${c.gzipKB} kB gzip (${c.owners}); next for wave 4: ${n.module}, ${n.minKB} kB, ${n.gzipKB} kB gzip`, true);
  } else check('bundle: main chunk size (report-only)', null, 'no dist on disk (a --base run)', 'reported with --dist', true);
  const gating = data.checks.filter((c) => !c.reportOnly);
  data.verdict = data.leaks.length ? 'fail-closed' : gating.some((c) => c.pass === false) ? 'fail' : data.signUpMissing ? 'inconclusive' : 'pass';
  return data;
}

// ------------------------------------------------------------------ ledger
/**
 * One row per registered effect (FxBudget's __dsFx.effects), plus the --fx
 * subject. Draws and programs are measured by --fx <name> (on minus off);
 * µs per frame comes from FxBudget's stats in whatever windows the mode ran.
 */
function ledger(data) {
  const rows = ['| effect | tier default (desktop/low) | switch | draws spawn/hub/Projects (on - off) | programs desktop/low | µs/frame desktop/low |', '|---|---|---|---|---|---|'];
  const effects = {};
  const entry = (n) => (effects[n] = effects[n] || { defaults: null, us: { desktop: [], lowtier: [] } });
  const collect = (prof, windows) => {
    for (const v of windows) {
      if (!v) continue;
      for (const [n, d] of Object.entries(v.effects || {})) entry(n).defaults = d;
      for (const [n, us] of Object.entries(v.fxUsPerFrame || {})) {
        if (us === null || us === undefined) continue;
        const e = entry(n);
        if (e.us[prof]) e.us[prof].push(us);
      }
    }
  };
  for (const [prof, p] of Object.entries(data.profiles || {})) {
    if (p.views) collect(prof, Object.values(p.views));
    if (p.raw && (p.raw.A || p.raw.B)) for (const r of [...(p.raw.A || []), ...(p.raw.B || [])]) if (r.views) collect(prof, Object.values(r.views));
    if (p.raw && p.raw.on) collect(prof, data.mode === 'fx' ? p.raw.on : []);
    if (p.raw && p.raw.off) for (const w of p.raw.off) for (const [n, d] of Object.entries(w.effects || {})) entry(n).defaults = d;
  }
  if (data.mode === 'fx' && data.effect) entry(data.effect);
  const fmtD = (x) => (x === null || x === undefined ? '?' : x > 0 ? `+${x}` : String(x));
  const fmtUs = (a) => (a.length ? String(round(median(a), 1)) : '-');
  for (const [n, e] of Object.entries(effects).sort(([a], [b]) => (a < b ? -1 : 1))) {
    const d = e.defaults ? `${e.defaults.desktop ? 'on' : 'off'}/${e.defaults.low ? 'on' : 'off'}` : 'not registered';
    let draws = `run --fx ${n}`;
    let progs = `run --fx ${n}`;
    if (data.mode === 'fx' && n === data.effect) {
      const L = (prof) => (data.profiles[prof] ? data.profiles[prof].ledger : null);
      const dv = (prof) => (L(prof) ? VIEWS.map((v) => fmtD(L(prof).draws[v])).join('/') : '-');
      draws = ['desktop', 'lowtier']
        .filter((prof) => L(prof))
        .map((prof) => `${prof === 'desktop' ? 'desktop' : 'low'} ${dv(prof)}`)
        .join('; ');
      progs = ['desktop', 'lowtier'].map((prof) => (L(prof) ? fmtD(L(prof).programs) : '-')).join('/');
    }
    rows.push(`| ${n} | ${d} | __dsFx.${n} | ${draws} | ${progs} | ${fmtUs(e.us.desktop)}/${fmtUs(e.us.lowtier)} |`);
  }
  if (Object.keys(effects).length === 0) rows.push('| (none registered) | | | | | |');
  return rows.join('\n') + '\n';
}

function printSummary(data) {
  const lines = [`perf-gate (${data.mode}): ${data.verdict}`];
  if (data.mode === 'rejudge' && data.source) lines.push(`  re-judged ${data.source} (it read ${data.sourceVerdict}) against ${data.floorFile}`);
  if (data.floorQuiet && data.floorQuiet.busy.length) lines.push(`  note: the floor file was recorded on a busy host (${data.floorQuiet.busy.join(', ')}: other processes over ${QUIET_OTHER_PCT}% of the machine); re-record it on a quiet one`);
  else if (data.floorQuiet && !data.floorQuiet.known) lines.push('  note: the floor file does not say how quiet the host was; re-record it with --record-floor');
  if (data.mode === 'ab' && data.bundle && data.bundle.B) {
    const b = data.bundle.B;
    lines.push(`  bundle: main chunk B ${b.rawKB} kB raw, ${b.gzipKB} kB gzip; against A ${b.deltaRawKB >= 0 ? '+' : ''}${b.deltaRawKB} raw, ${b.deltaGzipKB >= 0 ? '+' : ''}${b.deltaGzipKB} gzip${b.overWarning ? `; over Vite's ${BUNDLE.warnKB} kB warning by ${b.overWarningKB}` : ''} (report-only here; --report gates gzip)`);
  }
  if (data.mode === 'report' || data.mode === 'governor' || data.scenario === 'modal') for (const c of data.checks || []) lines.push(`  ${c.reportOnly ? 'info' : c.pass === true ? 'PASS' : c.pass === false ? 'FAIL' : '  ? '} ${c.name}: ${JSON.stringify(c.value)}  (${c.expect})`);
  else
    for (const [prof, p] of Object.entries(data.profiles || {})) {
      lines.push(`  ${prof}: ${p.verdict} after ${p.cycles} cycles${p.sourceVerdict ? ` (it read ${p.sourceVerdict} after ${p.sourceCycles})` : ''}${p.hostBusyPct ? ` (host ${p.hostBusyPct.p50}% busy, max ${p.hostBusyPct.max}%${p.otherBusyPct ? `; other processes ${p.otherBusyPct.p50}%, max ${p.otherBusyPct.max}%` : ''})` : ''}`);
      const note = hostNote(p.otherBusyPct, p.verdict);
      if (note) lines.push(`    note: ${note}`);
      if (p.checkpoints && p.checkpoints.length > 1) lines.push(`    checkpoints: ${p.checkpoints.map((c) => `${c.cycles} cycles ${c.verdict}${c.fails.length ? ` (FAIL ${c.fails.join(', ')})` : ''}`).join('; ')}`);
      if (p.poseCheck) lines.push(`    pose check: ${p.poseCheck.equal ? 'equal' : 'DIFFERENT (the run cannot pass)'}; ${Object.entries(p.poseCheck.views).map(([v, r]) => `${v} camera pitch A ${r.camPitch.medianA} B ${r.camPitch.medianB} rad, orbit pitch A ${r.ocPitch.medianA} B ${r.ocPitch.medianB}`).join('; ')}`);
      for (const [k, r] of Object.entries(p.metrics)) {
        if (r.verdict === 'n/a' && !r.unresolvable) continue;
        if (r.kind === 'µs' && !isNum(r.delta) && !isNum(r.medianB)) {
          // The CPU proxy row: side B's FxBudget µs per frame against their budgets.
          lines.push(`    ${String(r.verdict).padEnd(12)} ${k}: sum ${r.sum ?? '-'} µs (each <= ${r.each ?? '-'}, all <= ${r.total ?? '-'})${r.over && r.over.length ? `, over: ${r.over.join(', ')}` : ''}${r.note ? ` (${r.note})` : ''}`);
          continue;
        }
        if (r.kind === 'absolute') {
          lines.push(`    ${String(r.verdict).padEnd(12)} ${k}: B ${r.medianB} (A ${r.medianA ?? '-'}) bar ${r.threshold ?? '-'}${r.sign && r.verdict !== 'pass' ? `, ${r.sign.over} of ${r.sign.n} loads over` : ''}`);
          continue;
        }
        const why = r.verdict === 'inconclusive' && r.valid === false ? '  (sigma > thr/2)' : '';
        const fl = isNum(r.floor) ? ` floor ${r.floor}` : '';
        const tc = isNum(r.thresholdUsed) && r.thresholdUsed !== r.threshold ? ` (judged at ${r.thresholdUsed})` : '';
        const rule = r.unresolvable ? `  [${r.rule}: ${r.unresolvable}${r.proxy ? `, proxy ${r.proxy.verdict}` : ''}]` : r.sign && r.sign.fail ? `  [${r.rule}]` : '';
        lines.push(`    ${String(r.verdict).padEnd(12)} ${k}: Δ ${r.delta ?? r.medianB} σ ${r.sigma ?? '-'} thr ${r.threshold ?? '-'}${fl}${tc}${why}${rule}`);
      }
    }
  if (data.dusk) {
    const sides = data.mode === 'dusk' ? { '': data.dusk } : data.dusk;
    for (const [side, runs] of Object.entries(sides))
      for (const [prof, r] of Object.entries(runs)) lines.push(`  ${r.pass === true ? 'PASS' : r.pass === false ? 'FAIL' : '  ? '} dusk${side ? ` (${side})` : ''} ${prof}: ${r.error ? r.error : `longest task ${r.longestMs} ms crossing 17:00 to 17:30 (want < ${DUSK_LONGEST_MS}); lights ${JSON.stringify(r.before.lights)} -> ${JSON.stringify(r.after.lights)}, programs +${r.programsAdded}${r.note ? ` (${r.note})` : ''}`}`);
  }
  if (data.aa) {
    lines.push(`  A/A: verdict never fail ${data.aa.verdictNeverFail}; exact counters equal ${data.aa.exactCountersEqual}; |Δ| over max(T, floor): ${data.aa.outsideThreshold.length ? data.aa.outsideThreshold.map((x) => `${x.profile} ${x.metric} ${x.delta}`).join('; ') : 'none'}`);
  }
  if (data.floorWritten) lines.push(`  floor written: ${data.floorWritten}`);
  if (data.withRecordedFloor) {
    const w = data.withRecordedFloor;
    lines.push(`  judged with the recorded floor: ${Object.entries(w.profiles).map(([p, x]) => `${p} ${x.verdict}`).join(', ')}; never fail ${w.aa.verdictNeverFail}; |Δ| over max(T, floor): ${w.aa.outsideThreshold.length ? w.aa.outsideThreshold.map((x) => `${x.profile} ${x.metric} ${x.delta}`).join('; ') : 'none'}`);
  }
  if (data.leaks && data.leaks.length) lines.push(`  LEAKS: ${data.leaks.slice(0, 5).join(' | ')}`);
  process.stdout.write(lines.join('\n') + '\n');
}

async function main() {
  const args = lib.parseArgs(process.argv.slice(2), { multi: ['ab'], bool: ['seed', 'help', 'recordFloor', 'dusk', 'governor', 'gpuheavy', 'noTaps', 'pairs'] });
  if (args.help) {
    process.stdout.write(fs.readFileSync(__filename, 'utf8').split('\n').slice(2, 46).join('\n') + '\n');
    return 0;
  }
  const out = lib.outDir(args, 'perf-gate');
  const startedAt = new Date().toISOString();
  let data;
  try {
    if (args.rejudge) data = modeRejudge(args);
    else if (args.ab) data = await modeAB(args);
    else if (args.fx) data = await modeFx(args);
    else if (args.dusk) data = await modeDusk(args);
    else if (args.governor || args.gpuheavy) data = await modeGovernor(args);
    else data = await modeReport(args);
  } catch (e) {
    data = { mode: args.rejudge ? 'rejudge' : args.ab ? 'ab' : args.fx ? 'fx' : args.dusk ? 'dusk' : args.governor || args.gpuheavy ? 'governor' : 'report', verdict: 'inconclusive', error: String((e && e.stack) || e).slice(0, 2000), profiles: {} };
  }
  data.startedAt = startedAt;
  data.finishedAt = new Date().toISOString();
  data.thresholds = THRESHOLDS;
  data.fxLedgerUs = FX_LEDGER;
  data.fxBudgetUs = FX_US;
  const code = { pass: 0, fail: 1, 'fail-closed': 2, inconclusive: 3 }[data.verdict] ?? 3;
  data.exit = code;
  lib.writeJson(path.join(out, `perf-gate-${data.mode}.json`), data);
  fs.writeFileSync(path.join(out, 'ledger.md'), ledger(data));
  printSummary(data);
  if (data.error) process.stdout.write(`error: ${data.error.split('\n')[0]}\n`);
  process.stdout.write(`json: ${path.join(out, `perf-gate-${data.mode}.json`)}\n`);
  return code;
}

if (require.main === module) {
  main().then(
    (c) => process.exit(c),
    (e) => {
      process.stderr.write(String((e && e.stack) || e) + '\n');
      process.exit(3);
    },
  );
}

// The verdict maths, for re-judging a saved run.
module.exports = { hostNote, BUNDLE, bundleSize, bundleCheck, judgeAbsolute, judgeCredit, duskVerdict, FX_CREDIT, DUSK_LONGEST_MS, frameNumbers, judge, signCritical, signPass, SIGN_ALPHA, SIGN_PASS_MIN, modeRejudge, judgeCounter, judgeMixCounter, mixValue, aaSpread, writeFloor, judgeExact, bootModes, stratify, cpuProxy, metricTable, overall, aaSummary, poseCheck, ledger, t975, loadFloor, floorOf, floorQuiet, QUIET_OTHER_PCT, THRESHOLDS, FX_US, FX_LEDGER, BASELINE, VIEW_DEFS, POSE_TOL_RAD };
