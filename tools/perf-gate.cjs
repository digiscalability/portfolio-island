#!/usr/bin/env node
'use strict';
// npm run perf:gate -- the perf gate for production builds (stage-1 item E1).
//
//   perf:gate -- --dist dist --port 5191                 baseline report + counter and µs budget checks
//   perf:gate -- --base http://127.0.0.1:5191            the same, attached to a running preview
//   perf:gate -- --dist dist --port 5191 --fx <name>     interleaved toggle of one __dsFx effect, 6 x 1.5 s per side
//   perf:gate -- --ab <distA> <distB> --ports pA,pB [--cycles 6]   whole build B against A, ABAB, fresh context per cycle
//   add --seed to compare window.__dsSeedDraws with test/golden/seedDraws.json
//   --profiles desktop,lowtier,startup  (default: all three; --fx uses desktop,lowtier)
//   --hour <h|live>                                       the world clock (default 12: noon, as the audit measured)
//   --out <dir>                                           JSON + ledger.md (default <os tmpdir>/ux-probes/perf-gate)
//
// Profiles: desktop 1440x900 DPR 1; low tier 390x844 touch DPR 2 at 1x CPU;
// startup-only at 4x CPU with GPU timer queries off (they inflate throttled
// CPU time by ~15%). Hardware GL (ANGLE D3D11 on Windows; PERF_GL overrides).
//
// Validity (plan › perfBudget): sigma = |median(A_odd) - median(A_even)| per
// metric. A result is valid only when sigma <= threshold/2. Pass when
// delta <= threshold; fail when delta > threshold + sigma; anything else is
// inconclusive, and the run escalates to 2x cycles, up to 24.
// Exit codes: 0 pass, 1 budget fail, 2 fail-closed (a request got past the
// harness), 3 inconclusive. Shares the probes' safety harness (lib.cjs).
const fs = require('fs');
const path = require('path');
const lib = require('./ux-probes/lib.cjs');

// ---------------------------------------------------------------- budgets
const THRESHOLDS = {
  desktop: { cpuP50: 1.0, cpuP95: 1.5, gpuP50: 2.0, drawsSpawn: 50, drawsHub: 60, drawsProjects: 0, programs: 5 },
  lowtier: { cpuP50: 0.5, cpuP95: 0.8, drawsSpawn: 20, drawsHub: 20, drawsProjects: 20, programs: 3, nodes: 150, textureMB: 6 },
  startup: { welcomeMs: 400, worldGenMs: 200 },
  // startup metrics on the 1x profiles (desktop numbers)
  boot: { welcomeMs: 100, worldGenMs: 50, bytesBeforeCardKB: 50, longTasksBeforeCard: 1 },
};
const FX_US = { desktop: 150, lowtier: 100, totalDesktop: 600, totalLowtier: 400 };
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
const GOLDEN_SEED = path.join(lib.REPO, 'test', 'golden', 'seedDraws.json');

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
        const p0 = progs();
        const t0 = performance.now();
        inCompile++;
        let r;
        try { r = orig.apply(this, arguments); } finally { inCompile--; }
        G.compiles.push({ t: Math.round(t0), label: 'renderer.' + key, added: progs() - p0, ms: +(performance.now() - t0).toFixed(1) });
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
    // pitch and distance, then a hard cut to the pose.
    oc.minPitch = -1.35;
    if (oc.followDir) oc.followDir.copy(follow.clone().normalize());
    if (pitch !== null) oc.pitch = pitch;
    if (typeof oc.setDistance === 'function') oc.setDistance(dist);
    oc.distanceTarget = dist;
    oc.distance = dist;
    if (typeof oc.snapToPlayer === 'function') oc.snapToPlayer();
  };
  if (view === 'hub') {
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

// --------------------------------------------------------------- numbers
const { median, pct, round } = lib;

async function windowStats(page, ms) {
  const t0 = await page.evaluate(() => performance.now());
  const fx0 = await page.evaluate(FX_SNAPSHOT);
  await page.waitForTimeout(ms);
  const t1 = await page.evaluate(() => performance.now());
  const fx1 = await page.evaluate(FX_SNAPSHOT);
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
  };
}

/** One page load: startup marks, the three views, counters, programs. */
async function loadCycle(browser, base, prof, { nogpu, startupOnly, programsAtS = 12, seed = false, hour = '12' }) {
  const p = lib.profile(prof === 'startup' ? 'lowtier' : prof);
  const profObj = prof === 'startup' ? { ...p, name: 'startup', cpu: 4 } : p;
  const s = await lib.openSession(browser, profObj, { init: [GATE_INIT({ nogpu: nogpu || prof === 'startup' })] });
  const { page } = s;
  const out = { profile: prof };
  try {
    // The hour is pinned (noon by default): night lights change the light
    // count, the programs and the draws, so a live clock would move every counter.
    const q = '?owner=1&perf=1' + (hour && hour !== 'live' ? `&hour=${hour}` : '') + (profObj.query || '');
    await page.goto(`${base}/${q}`, { waitUntil: 'domcontentloaded', timeout: 240000 });
    await page.waitForFunction(() => window.__lifeIslandReady === true, null, { timeout: 300000, polling: 100 });
    await page.waitForSelector(`${lib.WELCOME} button[data-dismiss]`, { state: 'visible', timeout: 180000 });
    await page.evaluate(lib.HELPERS);
    const boot = await page.evaluate(() => {
      const G = window.__gate;
      const welcome = G.welcomeAt;
      const measures = {};
      for (const e of performance.getEntriesByType('measure')) measures[e.name] = Math.round(e.duration);
      const res = performance.getEntriesByType('resource');
      const before = welcome ? res.filter((r) => r.responseEnd <= welcome) : res;
      const lt = welcome ? G.longtasks.filter((x) => x[0] < welcome) : G.longtasks;
      return {
        welcomeMs: welcome ? Math.round(welcome) : null,
        worldGenMs: measures.world_gen ?? null,
        longTasksBeforeCard: lt.filter((x) => x[1] > 50).length,
        longestTaskBeforeCardMs: lt.length ? Math.max(...lt.map((x) => x[1])) : 0,
        bytesBeforeCardKB: +(before.reduce((n, r) => n + (r.transferSize || 0), 0) / 1024).toFixed(1),
        hooked: G.hooked,
        hookErr: G.err,
      };
    });
    Object.assign(out, boot);
    if (seed) out.seed = await page.evaluate(() => (window.__dsSeedDraws ? JSON.parse(JSON.stringify(window.__dsSeedDraws)) : null));
    if (startupOnly) return out;
    if (!boot.hooked) throw new Error('hook missing: __app.renderer.renderCallback / getRenderer for frame timing');
    await page.click(`${lib.WELCOME} button[data-dismiss]`).catch(() => {});
    const cardAt = Date.now();
    await page.waitForTimeout(2500);
    // Pin the governor: a resolution or rung change must not masquerade as cost.
    await page.evaluate(() => {
      const sr = window.__app.renderer;
      sr.governorArmed = false;
      sr.governorArmAccum = -1e12;
    });
    out.views = {};
    for (const view of ['spawn', 'hub', 'projects']) {
      if (view !== 'spawn') {
        await page.evaluate(POSE, { view });
        await page.waitForTimeout(view === 'projects' ? 1500 : 1200);
      }
      const counters = await page.evaluate(WHOLE_FRAME);
      await page.waitForTimeout(250);
      const timing = await windowStats(page, 1500);
      out.views[view] = { ...counters, ...timing };
      if (view === 'spawn') {
        // Programs, nodes and textures at the spawn, programsAtS after the
        // card (past the interior warm), before the other views add their own.
        const waitMs = programsAtS * 1000 - (Date.now() - cardAt);
        if (waitMs > 0) await page.waitForTimeout(waitMs);
        out.programs = (await page.evaluate(WHOLE_FRAME)).programs;
        out.programsReadAtS = round((Date.now() - cardAt) / 1000, 1);
        Object.assign(out, await page.evaluate(CENSUS));
      }
    }
    out.programsAfterViews = (await page.evaluate(WHOLE_FRAME)).programs;
    out.renderProgramAdds = await page.evaluate(() => window.__gate.renders.filter((r) => !r.inCompile).map((r) => ({ label: r.label, added: r.added, ms: r.ms })));
  } finally {
    await s.close({ waitSignUpMs: 20000 });
    out.net = { signUpSeen: s.net.signUpSeen, leaks: s.net.leaks.slice(), intercepted: [...new Set(s.net.intercepted)] };
  }
  return out;
}

// ---------------------------------------------------------------- verdicts
/** The plan's rule for one metric. a, b: per-cycle values (lower is better). */
function judge(a, b, threshold) {
  const A = a.filter((x) => x !== null && x !== undefined);
  const B = b.filter((x) => x !== null && x !== undefined);
  if (!A.length || !B.length) return { verdict: 'n/a', a: A, b: B };
  // No budget on this profile: report the medians (A/A still compares them).
  if (threshold === undefined || threshold === null) return { verdict: 'n/a', delta: round(median(B) - median(A), 3), medianA: round(median(A), 3), medianB: round(median(B), 3), n: [A.length, B.length] };
  const odd = A.filter((_, i) => i % 2 === 0);
  const even = A.filter((_, i) => i % 2 === 1);
  const sigma = odd.length && even.length ? Math.abs(median(odd) - median(even)) : 0;
  const delta = median(B) - median(A);
  const valid = sigma <= threshold / 2;
  let verdict;
  if (valid && delta <= threshold) verdict = 'pass';
  else if (delta > threshold + sigma) verdict = 'fail';
  else verdict = 'inconclusive';
  return { verdict, delta: round(delta, 3), sigma: round(sigma, 3), threshold, valid, medianA: round(median(A), 3), medianB: round(median(B), 3), n: [A.length, B.length] };
}

function metricTable(prof, cyclesA, cyclesB) {
  const T = THRESHOLDS[prof === 'startup' ? 'startup' : prof] || {};
  const B = THRESHOLDS.boot;
  const pick = (arr, f) => arr.map((c) => {
    try {
      return f(c);
    } catch (e) {
      return null;
    }
  });
  const rows = {};
  const add = (name, f, thr, kind = 'timing') => {
    rows[name] = { kind, ...judge(pick(cyclesA, f), pick(cyclesB, f), thr) };
  };
  if (prof === 'startup') {
    add('welcome_visible ms (4x)', (c) => c.welcomeMs, T.welcomeMs);
    add('world_gen ms (4x)', (c) => c.worldGenMs, T.worldGenMs);
    return rows;
  }
  for (const v of ['spawn', 'hub', 'projects']) {
    add(`${v}: CPU p50 ms`, (c) => c.views[v].cpuP50, T.cpuP50);
    add(`${v}: CPU p95 ms`, (c) => c.views[v].cpuP95, T.cpuP95);
    if (T.gpuP50) add(`${v}: GPU p50 ms`, (c) => c.views[v].gpuP50, T.gpuP50);
    const dk = { spawn: 'drawsSpawn', hub: 'drawsHub', projects: 'drawsProjects' }[v];
    add(`${v}: draws`, (c) => c.views[v].draws, T[dk], 'counter');
    add(`${v}: triangles`, (c) => c.views[v].triangles, null, 'counter');
  }
  // Programs and nodes are counters but not exact on main: a boot race puts
  // 3 more programs (215 vs 212 desktop, 117 vs 113 low tier) and ~700 ms
  // before the card into ~40% of loads, and nodes wander by up to 6. Measured
  // over 96 A/A loads; they are judged by the sigma rule like the draws.
  add('programs', (c) => c.programs, T.programs, 'counter');
  add('scene nodes', (c) => c.nodes, T.nodes ?? null, 'counter');
  add('texture MB', (c) => c.textureMB, T.textureMB ?? null, 'exact');
  add('welcome_visible ms', (c) => c.welcomeMs, prof === 'desktop' ? B.welcomeMs : null);
  add('world_gen ms', (c) => c.worldGenMs, prof === 'desktop' ? B.worldGenMs : null);
  add('long tasks > 50 ms before the card', (c) => c.longTasksBeforeCard, B.longTasksBeforeCard);
  add('bytes before the card (KB, transfer)', (c) => c.bytesBeforeCardKB, B.bytesBeforeCardKB, 'exact');
  return rows;
}

function overall(rows) {
  const vs = Object.values(rows).map((r) => r.verdict).filter((v) => v !== 'n/a');
  if (vs.includes('fail')) return 'fail';
  if (vs.includes('inconclusive')) return 'inconclusive';
  return 'pass';
}

// -------------------------------------------------------------------- modes
async function modeAB(args, out) {
  const [distA, distB] = args.ab || [];
  if (!distA || !distB) throw new lib.HarnessError('--ab takes two dist directories');
  const ports = String(args.ports || '').split(',').map((x) => lib.numArg(x, '--ports'));
  if (ports.length !== 2) throw new lib.HarnessError('--ab needs --ports <pA>,<pB>');
  const profiles = String(args.profiles || 'desktop,lowtier,startup').split(',');
  let cycles = Number(args.cycles || 6);
  const srvA = await lib.startPreview({ dist: distA, port: ports[0], label: 'A' });
  let srvB;
  try {
    srvB = await lib.startPreview({ dist: distB, port: ports[1], label: 'B' });
  } catch (e) {
    await srvA.stop();
    throw e;
  }
  const browser = await lib.launch();
  const data = { mode: 'ab', distA: srvA.dist, distB: srvB.dist, sameDist: srvA.dist === srvB.dist, profiles: {}, leaks: [], signUpMissing: 0 };
  try {
    for (const prof of profiles) {
      // One discarded load per side first: the browser's shader and HTTP
      // caches start cold, and a cold first cycle would bias side A.
      for (const base of [srvA.url, srvB.url]) {
        const w = await loadCycle(browser, base, prof, { startupOnly: true, hour: args.hour || '12' });
        if (w.net.leaks.length) data.leaks.push(...w.net.leaks);
      }
      const A = [];
      const B = [];
      let rows = null;
      let done = 0;
      // Each profile starts at the requested cycles and escalates on its own.
      cycles = Number(args.cycles || 6);
      for (;;) {
        for (let c = done; c < cycles; c++) {
          for (const side of ['A', 'B']) {
            const base = side === 'A' ? srvA.url : srvB.url;
            const r = await loadCycle(browser, base, prof, { startupOnly: prof === 'startup', hour: args.hour || '12' });
            if (r.net.leaks.length) data.leaks.push(...r.net.leaks);
            if (!r.net.signUpSeen) data.signUpMissing++;
            (side === 'A' ? A : B).push(r);
            process.stdout.write(`  ${prof} cycle ${c + 1}/${cycles} ${side}: welcome ${r.welcomeMs} ms${r.views ? `, spawn cpu p50 ${r.views.spawn.cpuP50} / draws ${r.views.spawn.draws}` : ''}\n`);
          }
        }
        done = cycles;
        rows = metricTable(prof, A, B);
        const v = overall(rows);
        if (v !== 'inconclusive' || cycles >= 24) break;
        cycles = Math.min(24, cycles * 2);
        process.stdout.write(`  ${prof}: inconclusive, escalating to ${cycles} cycles\n`);
      }
      // A/A: exact counters must be equal (amendment 3). The exact ones are
      // the texture MB and the bytes before the card (constant over 96 A/A
      // loads). Draws and triangles per view vary load to load (villagers walk
      // in and out of a view, ±20 draws at the spawn), and programs and nodes
      // ride a boot race (see metricTable); all of those are judged by the
      // sigma rule like the timings.
      if (data.sameDist) {
        data.aaExactCountersEqual = data.aaExactCountersEqual !== false;
        for (const r of Object.values(rows)) {
          if (r.kind !== 'exact' || r.delta === undefined) continue;
          if (r.delta !== 0) {
            r.aaCounterMismatch = true;
            data.aaExactCountersEqual = false;
          }
        }
      }
      data.profiles[prof] = { cycles: done, verdict: overall(rows), metrics: rows, raw: { A, B } };
    }
  } finally {
    await browser.close().catch(() => {});
    await srvA.stop();
    await srvB.stop();
  }
  const verdicts = Object.values(data.profiles).map((p) => p.verdict);
  let v = verdicts.includes('fail') ? 'fail' : verdicts.includes('inconclusive') ? 'inconclusive' : 'pass';
  if (data.signUpMissing) v = v === 'fail' ? v : 'inconclusive';
  if (data.sameDist && data.aaExactCountersEqual === false && v === 'pass') v = 'fail';
  if (data.leaks.length) v = 'fail-closed';
  data.verdict = v;
  return data;
}

async function modeFx(args, out) {
  const name = String(args.fx);
  const server = await lib.serve({ base: args.base, dist: args.dist, port: args.port });
  const browser = await lib.launch();
  const profiles = String(args.profiles || 'desktop,lowtier').split(',').filter((p) => p !== 'startup');
  const data = { mode: 'fx', effect: name, profiles: {}, leaks: [], signUpMissing: 0 };
  try {
    for (const prof of profiles) {
      const s = await lib.openSession(browser, lib.profile(prof), { init: [GATE_INIT({ nogpu: false })] });
      const { page } = s;
      const hour = args.hour || '12';
      await page.goto(`${server.url}/?owner=1&perf=1${hour !== 'live' ? `&hour=${hour}` : ''}${lib.profile(prof).query || ''}`, { waitUntil: 'domcontentloaded', timeout: 240000 });
      await page.waitForFunction(() => window.__lifeIslandReady === true, null, { timeout: 300000, polling: 100 });
      await page.waitForSelector(`${lib.WELCOME} button[data-dismiss]`, { state: 'visible', timeout: 180000 });
      await page.evaluate(lib.HELPERS);
      await page.click(`${lib.WELCOME} button[data-dismiss]`).catch(() => {});
      await page.waitForTimeout(3000);
      await page.evaluate(() => {
        const sr = window.__app.renderer;
        sr.governorArmed = false;
        sr.governorArmAccum = -1e12;
      });
      const set = (on) => page.evaluate(([n, v]) => {
        window.__dsFx = window.__dsFx || {};
        window.__dsFx[n] = v;
      }, [name, on]);
      const off = [];
      const on = [];
      let cycles = Number(args.cycles || 6);
      let done = 0;
      let rows;
      for (;;) {
        for (let c = done; c < cycles; c++) {
          await set(false);
          await page.waitForTimeout(400);
          off.push(await windowStats(page, 1500));
          await set(true);
          await page.waitForTimeout(400);
          on.push(await windowStats(page, 1500));
        }
        done = cycles;
        const T = THRESHOLDS[prof];
        rows = {
          'CPU p50 ms': judge(off.map((x) => x.cpuP50), on.map((x) => x.cpuP50), T.cpuP50),
          'CPU p95 ms': judge(off.map((x) => x.cpuP95), on.map((x) => x.cpuP95), T.cpuP95),
          draws: { kind: 'counter', ...judge(off.map((x) => x.drawsMean), on.map((x) => x.drawsMean), T.drawsSpawn) },
        };
        if (T.gpuP50) rows['GPU p50 ms'] = judge(off.map((x) => x.gpuP50), on.map((x) => x.gpuP50), T.gpuP50);
        const us = on.map((x) => (x.fxUsPerFrame || {})[name]).filter((x) => x !== null && x !== undefined);
        rows['µs per frame (FxBudget)'] = us.length ? { verdict: median(us) <= FX_US[prof] ? 'pass' : 'fail', medianB: round(median(us), 2), threshold: FX_US[prof] } : { verdict: 'n/a', note: 'not timed by fx.time (unregistered or ?perf=1 off)' };
        if (overall(rows) !== 'inconclusive' || cycles >= 24) break;
        cycles = Math.min(24, cycles * 2);
      }
      await set(null);
      data.profiles[prof] = { cycles: done, verdict: overall(rows), metrics: rows, raw: { off, on } };
      await s.close({ waitSignUpMs: 20000 });
      if (s.net.leaks.length) data.leaks.push(...s.net.leaks);
      if (!s.net.signUpSeen) data.signUpMissing++;
    }
  } finally {
    await browser.close().catch(() => {});
    await server.stop();
  }
  const vs = Object.values(data.profiles).map((p) => p.verdict);
  data.verdict = data.leaks.length ? 'fail-closed' : vs.includes('fail') ? 'fail' : vs.includes('inconclusive') || data.signUpMissing ? 'inconclusive' : 'pass';
  return data;
}

async function modeReport(args, out) {
  const server = await lib.serve({ base: args.base, dist: args.dist, port: args.port });
  const browser = await lib.launch();
  const profiles = String(args.profiles || 'desktop,lowtier,startup').split(',');
  const data = { mode: 'report', profiles: {}, checks: [], leaks: [], signUpMissing: 0 };
  const check = (name, pass, value, expect, reportOnly = false) => data.checks.push({ name, pass, value, expect, reportOnly });
  try {
    for (const prof of profiles) {
      const r = await loadCycle(browser, server.url, prof, { startupOnly: prof === 'startup', programsAtS: 30, seed: !!args.seed, hour: args.hour || '12' });
      if (r.net.leaks.length) data.leaks.push(...r.net.leaks);
      if (!r.net.signUpSeen) data.signUpMissing++;
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
      if (args.seed) {
        const golden = fs.existsSync(GOLDEN_SEED) ? JSON.parse(fs.readFileSync(GOLDEN_SEED, 'utf8')) : null;
        const g = golden ? golden[prof === 'desktop' ? 'desktop' : 'lowtier'] || null : null;
        if (!r.seed || !g) check(`${prof}: __dsSeedDraws vs test/golden/seedDraws.json`, null, !r.seed ? 'seed counter absent' : 'golden absent', 'report only', true);
        else check(`${prof}: __dsSeedDraws vs test/golden/seedDraws.json`, JSON.stringify({ total: r.seed.total, marks: r.seed.marks }) === JSON.stringify({ total: g.total, marks: g.marks }), r.seed.total, g.total);
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
function ledger(data) {
  const rows = ['| effect | tier default (desktop/low) | switch | draws spawn/hub/Projects | programs | µs/frame |', '|---|---|---|---|---|---|'];
  const effects = {};
  const collect = (r) => {
    if (!r || !r.views) return;
    for (const v of Object.values(r.views)) {
      for (const [n, d] of Object.entries(v.effects || {})) effects[n] = effects[n] || { defaults: d, us: [] };
      for (const [n, us] of Object.entries(v.fxUsPerFrame || {})) {
        effects[n] = effects[n] || { defaults: null, us: [] };
        effects[n].us.push(us);
      }
    }
  };
  for (const p of Object.values(data.profiles || {})) {
    if (p.views) collect(p);
    if (p.raw) for (const r of [...(p.raw.A || []), ...(p.raw.B || [])]) collect(r);
  }
  for (const [n, e] of Object.entries(effects).sort()) {
    const d = e.defaults ? `${e.defaults.desktop ? 'on' : 'off'}/${e.defaults.low ? 'on' : 'off'}` : '?';
    rows.push(`| ${n} | ${d} | __dsFx.${n} | (per-effect A/B: --fx ${n}) | - | ${e.us.length ? round(median(e.us), 1) : '-'} |`);
  }
  if (Object.keys(effects).length === 0) rows.push('| (none registered) | | | | | |');
  return rows.join('\n') + '\n';
}

function printSummary(data) {
  const lines = [`perf-gate (${data.mode}): ${data.verdict}`];
  if (data.mode === 'report') for (const c of data.checks || []) lines.push(`  ${c.reportOnly ? 'info' : c.pass === true ? 'PASS' : c.pass === false ? 'FAIL' : '  ? '} ${c.name}: ${JSON.stringify(c.value)}  (${c.expect})`);
  else
    for (const [prof, p] of Object.entries(data.profiles || {})) {
      lines.push(`  ${prof}: ${p.verdict} after ${p.cycles} cycles`);
      for (const [k, r] of Object.entries(p.metrics)) if (r.verdict !== 'n/a') lines.push(`    ${r.verdict.padEnd(12)} ${k}: Δ ${r.delta ?? r.medianB} σ ${r.sigma ?? '-'} thr ${r.threshold}${r.aaCounterMismatch ? '  (A/A counter mismatch)' : ''}`);
    }
  if (data.leaks && data.leaks.length) lines.push(`  LEAKS: ${data.leaks.slice(0, 5).join(' | ')}`);
  process.stdout.write(lines.join('\n') + '\n');
}

async function main() {
  const args = lib.parseArgs(process.argv.slice(2), { multi: ['ab'], bool: ['seed', 'help'] });
  if (args.help) {
    process.stdout.write(fs.readFileSync(__filename, 'utf8').split('\n').slice(2, 22).join('\n') + '\n');
    return 0;
  }
  const out = lib.outDir(args, 'perf-gate');
  const startedAt = new Date().toISOString();
  let data;
  try {
    if (args.ab) data = await modeAB(args, out);
    else if (args.fx) data = await modeFx(args, out);
    else data = await modeReport(args, out);
  } catch (e) {
    data = { mode: args.ab ? 'ab' : args.fx ? 'fx' : 'report', verdict: 'inconclusive', error: String((e && e.stack) || e).slice(0, 2000), profiles: {} };
  }
  data.startedAt = startedAt;
  data.finishedAt = new Date().toISOString();
  data.thresholds = THRESHOLDS;
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
module.exports = { judge, metricTable, overall, THRESHOLDS, FX_US, BASELINE };
