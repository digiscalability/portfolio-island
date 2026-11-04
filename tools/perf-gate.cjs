#!/usr/bin/env node
'use strict';
// npm run perf:gate -- the perf gate for production builds (stage-1 item E1).
//
//   perf:gate -- --dist dist --port 5191                 baseline report + counter and µs budget checks
//   perf:gate -- --base http://127.0.0.1:5191            the same, attached to a running preview
//   perf:gate -- --dist dist --port 5191 --fx <name>     one __dsFx effect: per-view draws and programs, then 6 x 1.5 s per side
//   perf:gate -- --ab <distA> <distB> --ports pA,pB [--cycles 6]   whole build B against A, ABAB, fresh context per cycle
//   add --seed to compare window.__dsSeedDraws with the subject's test/golden/seedDraws.json (--golden <path> overrides)
//   --profiles desktop,lowtier,startup  (default: all three; --fx uses desktop,lowtier)
//   --hour <h|live>                                       the world clock (default 12: noon, as the audit measured)
//   --out <dir>                                           JSON + ledger.md (default <os tmpdir>/ux-probes/perf-gate)
//
// Profiles: desktop 1440x900 DPR 1; low tier 390x844 touch DPR 2 at 1x CPU;
// startup-only at 4x CPU with GPU timer queries off (they inflate throttled
// CPU time by ~15%). Hardware GL (ANGLE D3D11 on Windows; PERF_GL overrides).
//
// Verdict per metric (plan-r3 › perfBudget, critique-r3), against T, the
// budget, and the metric's floor, its 24-cycle A/A band from
// tools/perf-gate.floor.json:
// - timings (sigma rule): valid when sigma <= T/2; pass when valid and
//   delta <= T; fail when valid and delta > T + sigma; anything else is
//   inconclusive, and the run escalates to 2x cycles, up to 24. delta = median
//   of the paired (B - A) cycle differences; sigma = the 95% band of delta,
//   t(n-1) x 1.2533 x SD/sqrt(n) over those differences. A timing whose T is
//   below 2 x its floor cannot resolve on this rig: CPU is judged by its proxy
//   (FxBudget µs per effect) and the rest are reported 'unresolvable', and
//   the report says so.
// - counters (draws, triangles, programs, nodes, long tasks, bytes): delta =
//   median(B) - median(A); pass when delta <= max(T, floor); fail when delta
//   > max(T, floor) + sigma, or > max(T, floor) at 24 cycles; else
//   inconclusive. Improvements always pass.
// - texture MB is the one exact counter: equal on every A/A load.
// welcome_visible is stratified by the boot-race mode (programs 212/215 on
// desktop, 113/117 on the low tier) and compared like with like. Every load
// checks the hub-wide and Projects poses, and a pitch that differs between
// the builds by more than 0.01 rad makes the run inconclusive.
// Exit codes: 0 pass, 1 budget fail, 2 fail-closed (a request got past the
// harness), 3 inconclusive. Shares the probes' safety harness (lib.cjs).
//
//   --record-floor (with --ab <dist> <dist>): run 24 cycles, keep the verdicts
//   at 6, 12 and 24, and write each metric's 24-cycle band to the floor file
//   (--floor <file> reads or writes another one).
const fs = require('fs');
const path = require('path');
const lib = require('./ux-probes/lib.cjs');

// ---------------------------------------------------------------- budgets
// plan-r3 perfBudget. CPU p50 has no budget (report-only); the startup
// budgets for the 1x profiles are desktop's, the 'startup' profile is 4x.
const THRESHOLDS = {
  desktop: { cpuP95: 1.0, gpuP50: 2.0, drawsSpawn: 50, drawsHub: 80, drawsProjects: 60, programs: 5, welcomeMs: 150, worldGenMs: 50, longTasksBeforeCard: 1, longestTaskBeforeCardMs: 50, bytesBeforeCardKB: 50 },
  lowtier: { cpuP95: 0.75, drawsSpawn: 20, drawsHub: 30, drawsProjects: 25, programs: 3, nodes: 150, textureMB: 6, bytesBeforeCardKB: 50 },
  startup: { welcomeMs: 400, worldGenMs: 200, longTasksBeforeCard: 2, longestTaskBeforeCardMs: 50, bytesBeforeCardKB: 50 },
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
// The fixed views, in measuring order. A view is a POSE ({ view }) plus the
// time the world needs to settle after it, and its draw budget key. P2-E3
// adds a vehicle view and a room view here.
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
  const G = (window.__gate = { frames: [], longtasks: [], renders: [], compiles: [], welcomeAt: null, hooked: false, err: null });
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
    const protoRender = Object.getPrototypeOf(sr).render;
    sr.render = function () {
      R.info.reset();
      const t0 = performance.now();
      let q = null;
      if (ext && cur) { q = pool.pop() || gl.createQuery(); gl.beginQuery(ext.TIME_ELAPSED_EXT, q); }
      protoRender.call(this);
      if (q) { gl.endQuery(ext.TIME_ELAPSED_EXT); pending.push({ q, f: cur }); }
      if (cur) {
        cur.ren = performance.now() - t0;
        cur.calls = R.info.render.calls;
        cur.tris = R.info.render.triangles;
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
  R.info.reset();
  sr.render();
  const i = R.info;
  const out = { draws: i.render.calls, triangles: i.render.triangles, programs: i.programs ? i.programs.length : null, textures: i.memory.textures, geometries: i.memory.geometries };
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
  return { n: fr.length, cpu: fr.map((f) => f.upd + f.ren), gpu: fr.filter((f) => f.gpu !== null).map((f) => f.gpu), calls: fr.map((f) => f.calls) };
};

const FX_SNAPSHOT = () => {
  const g = window.__dsFx || {};
  return { stats: JSON.parse(JSON.stringify(g.stats || {})), effects: JSON.parse(JSON.stringify(g.effects || {})) };
};

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
    frames: f.n,
    fps: round(f.n / ((t1 - t0) / 1000), 1),
    cpuP50: round(pct(f.cpu, 50), 3),
    cpuP95: round(pct(f.cpu, 95), 3),
    gpuP50: f.gpu.length ? round(pct(f.gpu, 50), 3) : null,
    drawsMean: f.calls.length ? round(f.calls.reduce((s, x) => s + x, 0) / f.calls.length, 1) : null,
    fxUsPerFrame: fxUs,
    effects: fx1.effects,
    animatedMax: [an0, an1, an2].some((x) => typeof x === 'number') ? Math.max(...[an0, an1, an2].filter((x) => typeof x === 'number')) : null,
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
async function loadCycle(browser, base, prof, { nogpu, startupOnly, programsAtS = 30, seed = false, hour = '12' }) {
  const p = lib.profile(prof === 'startup' ? 'lowtier' : prof);
  const profObj = prof === 'startup' ? { ...p, name: 'startup', cpu: 4 } : p;
  const cpu0 = lib.hostCpu();
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
  } finally {
    await s.close({ waitSignUpMs: 20000 });
    out.net = { signUpSeen: s.net.signUpSeen, bootProofSeen: !!s.net.bootProofSeen, leaks: s.net.leaks.slice(), intercepted: [...new Set(s.net.intercepted)] };
    // Everything on the machine, this browser included: other sessions'
    // builds and probes show up here and in the timing spread.
    out.hostBusyPct = lib.hostBusyPct(cpu0, lib.hostCpu());
  }
  return out;
}

// ---------------------------------------------------------------- verdicts
const T975 = [null, 12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.16, 2.145, 2.131, 2.12, 2.11, 2.101, 2.093, 2.086, 2.08, 2.074, 2.069, 2.064, 2.06, 2.056, 2.052, 2.048, 2.045, 2.042];
/** Two-sided 95% Student t quantile; past 30 df the table rounds df down (conservative). */
const t975 = (df) => (df < 1 ? null : df <= 30 ? T975[df] : df <= 40 ? 2.042 : df <= 60 ? 2.021 : df <= 120 ? 2.0 : 1.98);
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const sampleSd = (a) => {
  const m = a.reduce((s, x) => s + x, 0) / a.length;
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
};

/**
 * The plan's verdict rule for one metric (lower is better). a[i] and b[i] are
 * side A and side B in cycle i; ABAB order makes each pair adjacent in time.
 * - delta = median over cycles of (b[i] - a[i]);
 * - sigma = the 95% band of delta: t(0.975, n-1) x 1.2533 x SD(b - a) / sqrt(n);
 * - valid when sigma <= threshold/2; pass when valid and delta <= threshold;
 *   fail when valid and delta > threshold + sigma; else inconclusive.
 * An invalid result never fails. sigmaSplitA is the plan's single split,
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
  let verdict = 'inconclusive';
  if (valid && delta <= threshold) verdict = 'pass';
  else if (valid && delta > threshold + sigma) verdict = 'fail';
  return { verdict, ...out, threshold, valid, withinThreshold: Math.abs(delta) <= threshold };
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

/** The exact rule: |delta| <= threshold, and an A/A side must not move at all. */
function judgeExact(a, b, threshold) {
  const r = judge(a, b, null);
  if (!r.n) return r;
  if (threshold === undefined || threshold === null) return { ...r, verdict: 'n/a' };
  const delta = median(b.filter(isNum)) - median(a.filter(isNum));
  return { ...r, delta: round(delta, 3), threshold, verdict: delta <= threshold ? 'pass' : 'fail', withinThreshold: Math.abs(delta) <= threshold };
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
  if (uni) return { a, b, strata: { one: { a: a.filter(isNum).length, b: b.filter(isNum).length, paired: Math.min(a.length, b.length) } }, stratified: false };
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
  /** A timing: the sigma rule, unless T is below 2 x the floor (then the proxy, or unresolvable). */
  const timing = (name, f, thr, { proxyOf = null, a = null, b = null, extra = {} } = {}) => {
    const A = a || pick(cyclesA, f);
    const B = b || pick(cyclesB, f);
    const floorV = fl(name);
    const r = { kind: 'timing', ...judge(A, B, thr), floor: floorV, ...extra };
    if (thr !== undefined && thr !== null && floorV !== null && thr < 2 * floorV) {
      r.unresolvable = `T ${thr} < 2 x floor ${floorV}`;
      r.directVerdict = r.verdict;
      if (proxyOf === 'cpu') {
        const p = proxy();
        r.rule = 'proxy: FxBudget µs per effect';
        r.verdict = p.verdict;
        r.proxy = { verdict: p.verdict, sum: p.sum, each: p.each, total: p.total, over: p.over, note: p.note };
      } else {
        r.rule = 'unresolvable on this rig (no proxy): reported, not judged';
        r.verdict = 'n/a';
      }
    } else r.rule = thr === undefined || thr === null ? 'report only' : 'sigma';
    rows[name] = r;
  };
  const counter = (name, f, thr) => {
    rows[name] = { kind: 'counter', rule: thr === undefined || thr === null ? 'report only' : 'counter: |Δ| <= max(T, floor)', ...judgeCounter(pick(cyclesA, f), pick(cyclesB, f), thr, fl(name), { cycles }) };
  };
  const exact = (name, f, thr) => {
    rows[name] = { kind: 'exact', rule: thr === undefined || thr === null ? 'exact (A/A equal), no budget' : 'exact', ...judgeExact(pick(cyclesA, f), pick(cyclesB, f), thr) };
  };
  const startupRows = (suffix) => {
    // welcome_visible, compared like with like across the boot race's modes.
    const modeOf = (c) => (isNum(c.programs) ? c.programs : c.programsAtCard);
    const st = stratify(pick(cyclesA, (c) => c.welcomeMs), pick(cyclesB, (c) => c.welcomeMs), pick(cyclesA, modeOf), pick(cyclesB, modeOf));
    timing(`welcome_visible ms${suffix}`, null, T.welcomeMs, { a: st.a, b: st.b, extra: { stratified: st.stratified, strata: st.strata } });
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
  // Programs ride the boot race (212/215 desktop, 113/117 low tier) and nodes
  // wander by a few: counters with floors.
  counter('programs (30 s after the card)', (c) => c.programs, T.programs);
  counter('programs after the views', (c) => c.programsAfterViews, T.programs);
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
      if (r.threshold === undefined || r.threshold === null || !isNum(r.delta)) continue;
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
  const data = { mode: 'ab', distA: srvA.dist, distB: srvB.dist, sameDist: srvA.dist === srvB.dist, floorFile: floorFile.replace(/\\/g, '/'), floorRecorded: floor ? floor.recorded || null : null, profiles: {}, leaks: [], signUpMissing: 0 };
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
            process.stdout.write(`  ${prof} cycle ${c + 1}/${cycles} ${side}: welcome ${r.welcomeMs} ms${r.views ? `, spawn cpu p50 ${r.views.spawn.cpuP50} / draws ${r.views.spawn.draws}, hub pitch ${r.views.hub.pose.camPitch}` : ''}, host ${r.hostBusyPct}% busy\n`);
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
      const pose = prof === 'startup' ? null : poseCheck(A, B);
      let pv = overall(rows);
      if (pose && !pose.equal && pv !== 'fail') pv = 'inconclusive';
      data.profiles[prof] = { cycles: done, verdict: pv, checkpoints, poseCheck: pose, hostBusyPct: { p50: round(median(host), 1), max: host.length ? Math.max(...host) : null }, metrics: rows, raw: { A, B } };
      if (pose) process.stdout.write(`  ${prof} pose check: ${pose.equal ? 'equal' : 'DIFFERENT'} — ${Object.entries(pose.views).map(([v, r]) => `${v} camera pitch A ${r.camPitch.medianA} B ${r.camPitch.medianB} rad`).join('; ')}\n`);
    }
  } finally {
    await browser.close().catch(() => {});
    await srvA.stop();
    await srvB.stop();
  }
  const verdicts = Object.values(data.profiles).map((p) => p.verdict);
  let v = verdicts.includes('fail') ? 'fail' : verdicts.includes('inconclusive') ? 'inconclusive' : 'pass';
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

/** A dist's entry bundle (main-<hash>.js), or its folder name when it has none. */
function bundleOf(dist) {
  try {
    const m = fs.readdirSync(path.join(dist, 'assets')).find((f) => /^main-[\w-]+\.js$/.test(f));
    if (m) return m;
  } catch (e) {}
  return path.basename(dist);
}

/**
 * --record-floor: each metric's 24-cycle A/A band (the sigma the verdict rule
 * uses) per profile, written through prettier (format:check covers *.json).
 */
async function writeFloor(file, data) {
  const out = {
    about:
      "The perf gate's floor: each metric's 24-cycle A/A band (the 95% band of the paired delta, the gate's sigma) on this rig. A timing whose budget T is under 2 x its floor is judged by its proxy (FxBudget µs for CPU) or reported unresolvable; a counter passes when its delta is within max(T, floor). Rewrite with: npm run perf:gate -- --ab <dist> <dist> --ports <a>,<b> --record-floor",
    recorded: {
      at: new Date().toISOString(),
      // The build by its entry bundle, not by a local path.
      build: bundleOf(data.distA),
      cycles: Object.fromEntries(Object.entries(data.profiles).map(([p, x]) => [p, x.cycles])),
      hostBusyPct: Object.fromEntries(Object.entries(data.profiles).map(([p, x]) => [p, x.hostBusyPct])),
      rig: `${require('os').cpus()[0].model.trim()}, ${require('os').cpus().length} threads`,
    },
    profiles: {},
  };
  for (const [prof, p] of Object.entries(data.profiles)) {
    out.profiles[prof] = {};
    for (const [k, r] of Object.entries(p.metrics || {})) if (isNum(r.sigma)) out.profiles[prof][k] = round(r.sigma, 4);
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
    for (let k = 0; k < 2; k++) {
      sr.renderCallback(1 / 240);
      R.info.reset();
      sr.render();
      draws += R.info.render.calls;
      triangles += R.info.render.triangles;
    }
    return { draws: draws / 2, triangles: triangles / 2, programs: R.info.programs ? R.info.programs.length : null };
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
async function modeFx(args) {
  const name = String(args.fx);
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
          if (T.gpuP50) rows['spawn: GPU p50 ms'] = { kind: 'timing', ...judge(offW.map((x) => x.gpuP50), onW.map((x) => x.gpuP50), T.gpuP50) };
          for (const view of VIEWS) rows[`${view}: draws`] = { kind: 'counter', ...counters[view].draws };
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
  if (data.mode === 'report') for (const c of data.checks || []) lines.push(`  ${c.reportOnly ? 'info' : c.pass === true ? 'PASS' : c.pass === false ? 'FAIL' : '  ? '} ${c.name}: ${JSON.stringify(c.value)}  (${c.expect})`);
  else
    for (const [prof, p] of Object.entries(data.profiles || {})) {
      lines.push(`  ${prof}: ${p.verdict} after ${p.cycles} cycles${p.hostBusyPct ? ` (host ${p.hostBusyPct.p50}% busy, max ${p.hostBusyPct.max}%)` : ''}`);
      if (p.checkpoints && p.checkpoints.length > 1) lines.push(`    checkpoints: ${p.checkpoints.map((c) => `${c.cycles} cycles ${c.verdict}${c.fails.length ? ` (FAIL ${c.fails.join(', ')})` : ''}`).join('; ')}`);
      if (p.poseCheck) lines.push(`    pose check: ${p.poseCheck.equal ? 'equal' : 'DIFFERENT (the run cannot pass)'}; ${Object.entries(p.poseCheck.views).map(([v, r]) => `${v} camera pitch A ${r.camPitch.medianA} B ${r.camPitch.medianB} rad, orbit pitch A ${r.ocPitch.medianA} B ${r.ocPitch.medianB}`).join('; ')}`);
      for (const [k, r] of Object.entries(p.metrics)) {
        if (r.verdict === 'n/a' && !r.unresolvable) continue;
        const why = r.verdict === 'inconclusive' && r.valid === false ? '  (sigma > thr/2)' : '';
        const fl = isNum(r.floor) ? ` floor ${r.floor}` : '';
        const tc = isNum(r.thresholdUsed) && r.thresholdUsed !== r.threshold ? ` (judged at ${r.thresholdUsed})` : '';
        const rule = r.unresolvable ? `  [${r.rule}: ${r.unresolvable}${r.proxy ? `, proxy ${r.proxy.verdict}` : ''}]` : '';
        lines.push(`    ${String(r.verdict).padEnd(12)} ${k}: Δ ${r.delta ?? r.medianB} σ ${r.sigma ?? '-'} thr ${r.threshold ?? '-'}${fl}${tc}${why}${rule}`);
      }
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
  const args = lib.parseArgs(process.argv.slice(2), { multi: ['ab'], bool: ['seed', 'help', 'recordFloor'] });
  if (args.help) {
    process.stdout.write(fs.readFileSync(__filename, 'utf8').split('\n').slice(2, 26).join('\n') + '\n');
    return 0;
  }
  const out = lib.outDir(args, 'perf-gate');
  const startedAt = new Date().toISOString();
  let data;
  try {
    if (args.ab) data = await modeAB(args);
    else if (args.fx) data = await modeFx(args);
    else data = await modeReport(args);
  } catch (e) {
    data = { mode: args.ab ? 'ab' : args.fx ? 'fx' : 'report', verdict: 'inconclusive', error: String((e && e.stack) || e).slice(0, 2000), profiles: {} };
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
module.exports = { judge, judgeCounter, judgeExact, bootModes, stratify, cpuProxy, metricTable, overall, aaSummary, poseCheck, ledger, t975, loadFloor, floorOf, THRESHOLDS, FX_US, FX_LEDGER, BASELINE, VIEW_DEFS, POSE_TOL_RAD };
