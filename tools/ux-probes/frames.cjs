'use strict';
// Frame probes (B0, B2): the interior warm-up hitch and the seeded-window
// draw counter.
const fs = require('fs');
const path = require('path');
const lib = require('./lib.cjs');

// Installed before any page script: rAF intervals, long animation frames, and
// program accounting. renderer.render and the composer's render log
// info.programs.length before and after every call; renderer.compile and
// compileAsync tag what they add, so a program created by a render() is told
// apart from one created inside a compile call. scene.warmInterior is timed.
const HITCH_INIT = `(() => {
  if (window.top !== window) return;
  const H = (window.__hitch = { frames: [], loaf: [], renders: [], compiles: [], warm: [], readyAt: null, installed: false, renderCalls: 0, composerCalls: 0 });
  const now = () => performance.now();
  let last = 0;
  // Each rAF tick also logs the program count after the last top-level
  // render, so the jump between two consecutive renders (a compile call in
  // between plus the render itself) is visible as one number.
  H.postProgs = null;
  const tick = (t) => {
    if (last) H.frames.push([Math.round(t), +(t - last).toFixed(1), H.postProgs]);
    last = t;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries()) H.loaf.push([Math.round(e.startTime), Math.round(e.duration), Math.round(e.blockingDuration || 0)]); })
      .observe({ type: 'long-animation-frame', buffered: true });
  } catch (e) {}
  let inCompile = 0;
  let inComposer = 0; // renderer.render calls nested in composer.render are the composer's
  const install = () => {
    const app = window.__app;
    if (!app || !app.renderer || !app.scene || typeof app.renderer.getRenderer !== 'function') return false;
    const R = app.renderer.getRenderer();
    if (!R || !R.info) return false;
    const progs = () => (R.info.programs ? R.info.programs.length : 0);
    const wrapRender = (obj, key, label, counter) => {
      const orig = obj[key];
      if (typeof orig !== 'function' || orig.__hitch) return;
      const f = function () {
        const p0 = progs();
        const t0 = now();
        const r = orig.apply(this, arguments);
        const p1 = progs();
        H[counter]++;
        if (inComposer === 0 && inCompile === 0) H.postProgs = p1;
        if (p1 !== p0 && inComposer === 0) H.renders.push({ t: Math.round(t0), label, added: p1 - p0, ms: +(now() - t0).toFixed(1), inCompile: inCompile > 0, programs: p1 });
        return r;
      };
      f.__hitch = true;
      obj[key] = f;
    };
    wrapRender(R, 'render', 'renderer.render', 'renderCalls');
    const wrapCompile = (key) => {
      const orig = R[key];
      if (typeof orig !== 'function' || orig.__hitch) return;
      const f = function () {
        // compileAsync runs this.compile() inside it: only the outermost call
        // is recorded, so summing 'compiles' counts each program once.
        const nested = inCompile > 0;
        const p0 = progs();
        const t0 = now();
        inCompile++;
        let r;
        try { r = orig.apply(this, arguments); } finally { inCompile--; }
        if (nested) return r;
        const rec = { t: Math.round(t0), label: 'renderer.' + key, addedSync: progs() - p0, syncMs: +(now() - t0).toFixed(1) };
        H.compiles.push(rec);
        // addedByResolve: programs gained from the call until the promise
        // resolved, from any source (a render in between counts too).
        if (r && typeof r.then === 'function') r.then(() => { rec.resolvedMs = Math.round(now() - t0); rec.addedByResolve = progs() - p0; }, () => { rec.rejected = true; });
        return r;
      };
      f.__hitch = true;
      R[key] = f;
    };
    wrapCompile('compile');
    wrapCompile('compileAsync');
    const sc = app.scene;
    if (typeof sc.warmInterior === 'function' && !sc.warmInterior.__hitch) {
      const o = sc.warmInterior;
      const w = function () {
        const t0 = now();
        const rec = { t: Math.round(t0) };
        H.warm.push(rec);
        const r = o.apply(this, arguments);
        if (r && typeof r.then === 'function') r.then(() => { rec.endMs = Math.round(now() - t0); }, () => { rec.rejected = true; });
        return r;
      };
      w.__hitch = true;
      sc.warmInterior = w;
    }
    return true;
  };
  const iv = setInterval(() => {
    try { if (install()) { clearInterval(iv); H.installed = true; } } catch (e) { H.err = String(e); clearInterval(iv); }
  }, 2);
  // The composer is built after world gen (desktop only); wrap it when it appears.
  const ivc = setInterval(() => {
    const sr = window.__app && window.__app.renderer;
    const c = sr && sr.composer;
    if (!c || c.render.__hitch) return;
    const R = sr.getRenderer();
    const progs = () => (R.info.programs ? R.info.programs.length : 0);
    const orig = c.render;
    const f = function () {
      const p0 = progs();
      const t0 = now();
      inComposer++;
      let r;
      try { r = orig.apply(this, arguments); } finally { inComposer--; }
      const p1 = progs();
      H.composerCalls++;
      if (inCompile === 0) H.postProgs = p1;
      if (p1 !== p0) H.renders.push({ t: Math.round(t0), label: 'composer.render', added: p1 - p0, ms: +(now() - t0).toFixed(1), inCompile: inCompile > 0, programs: p1 });
      return r;
    };
    f.__hitch = true;
    c.render = f;
    clearInterval(ivc);
  }, 20);
  const ivr = setInterval(() => { if (window.__lifeIslandReady) { clearInterval(ivr); H.readyAt = performance.now(); } }, 5);
})();`;

async function hitchRun(t, prof, scenario) {
  const s = await t.session(prof, { init: [HITCH_INIT] });
  const { page } = s;
  const b = await t.boot(s, { waitWelcome: false });
  if (!(await page.evaluate(() => window.__hitch && window.__hitch.installed))) throw new Error('hook missing: __app.renderer.getRenderer() for program accounting');
  const readyAt = await page.evaluate(() => window.__hitch.readyAt);
  const untilAfterReady = async (ms) => {
    for (;;) {
      const n = await page.evaluate(() => performance.now());
      if (n - readyAt >= ms) return;
      await lib.sleep(Math.min(250, ms - (n - readyAt)));
    }
  };
  await page.waitForSelector(`${lib.WELCOME} button[data-dismiss]`, { state: 'visible', timeout: 120000 }).catch(() => {});
  if (scenario === 'walk') {
    await page.click(`${lib.WELCOME} button[data-dismiss]`).catch(() => {});
    const plan = [
      ['KeyW', 6000],
      ['KeyD', 3000],
      ['KeyW', 13000],
    ];
    for (const [key, ms] of plan) {
      await page.keyboard.down(key);
      const end = Date.now() + ms;
      while (Date.now() < end) {
        await lib.sleep(400);
        await page.keyboard.down(key);
        // Walk a loop, not off into the sea: nudge the heading now and then.
        const panel = await page.evaluate(() => window.__app.ui.panels.current()).catch(() => null);
        if (panel) await page.evaluate(() => window.__app.ui.panels.closeAll()).catch(() => {});
      }
      await page.keyboard.up(key);
    }
  }
  await untilAfterReady(25000);
  const H = await page.evaluate(() => {
    const h = window.__hitch;
    return { frames: h.frames, loaf: h.loaf, renders: h.renders, compiles: h.compiles, warm: h.warm, readyAt: h.readyAt, renderCalls: h.renderCalls, composerCalls: h.composerCalls, err: h.err || null };
  });
  const w0 = H.readyAt + 5000;
  const w1 = H.readyAt + 25000;
  const inWin = (tt) => tt >= w0 && tt <= w1;
  const frames = H.frames.filter(([tt]) => inWin(tt)).map(([, d]) => d);
  // Programs gained between two consecutive renders (compile calls included):
  // the frame-level number the perf audit reported.
  let frameJump = { added: 0, atS: null, frameMs: null };
  for (let i = 1; i < H.frames.length; i++) {
    const [tt, d, p] = H.frames[i];
    const p0 = H.frames[i - 1][2];
    if (!inWin(tt) || p === null || p0 === null) continue;
    if (p - p0 > frameJump.added) frameJump = { added: p - p0, atS: lib.round((tt - H.readyAt) / 1000, 2), frameMs: d };
  }
  const long = H.frames.filter(([tt, d]) => inWin(tt) && d > 50).map(([tt, d]) => ({ atS: lib.round((tt - H.readyAt) / 1000, 2), ms: d }));
  const loaf = H.loaf.filter(([st]) => inWin(st)).map(([st, d, blk]) => ({ atS: lib.round((st - H.readyAt) / 1000, 2), ms: d, blockingMs: blk }));
  const renderAdds = H.renders.filter((r) => !r.inCompile).map((r) => ({ atS: lib.round((r.t - H.readyAt) / 1000, 2), label: r.label, added: r.added, ms: r.ms, programs: r.programs }));
  const renderAddsInWin = renderAdds.filter((r) => r.atS >= 5 && r.atS <= 25);
  const compiles = H.compiles.map((c) => ({ ...c, atS: lib.round((c.t - H.readyAt) / 1000, 2) }));
  const warm = H.warm.map((w) => ({ startS: lib.round((w.t - H.readyAt) / 1000, 2), endMs: w.endMs ?? null }));
  // The first door entry, under the veil.
  const door = await page.evaluate(async () => {
    const a = window.__app;
    if (typeof a.enterBuilding !== 'function') return { error: 'no enterBuilding' };
    a.ui.panels.closeAll();
    const rows = [];
    const t0 = performance.now();
    let last = t0;
    a.enterBuilding('probe_house', false);
    await new Promise((res) => {
      const loop = () => {
        const n = performance.now();
        const el = a.ui.fadeDiv;
        rows.push({ t: Math.round(n - t0), dt: +(n - last).toFixed(1), op: el ? +(+getComputedStyle(el).opacity).toFixed(2) : 0, inside: a.scene.isInsideInterior() });
        last = n;
        if (n - t0 < 2500) requestAnimationFrame(loop);
        else res();
      };
      requestAnimationFrame(loop);
    });
    return { rows };
  });
  let doorOut = door;
  if (door.rows) {
    const rows = door.rows;
    let black = 0;
    for (let i = 1; i < rows.length; i++) if (rows[i - 1].op >= 0.95) black += rows[i].t - rows[i - 1].t;
    const firstInside = rows.findIndex((r) => r.inside);
    const interiorFrameMs = firstInside >= 0 && firstInside + 1 < rows.length ? rows[firstInside + 1].dt : null;
    doorOut = { blackIntervalMs: Math.round(black), interiorFrameMs, maxFrameMs: Math.max(...rows.map((r) => r.dt)), trace: rows.filter((_, i) => i % 3 === 0).map((r) => `${r.t}:${r.op}${r.inside ? 'i' : ''}`) };
  }
  await t.shot(page, `hitch-${prof}-${scenario}-inside.png`);
  return {
    boot: b,
    scenario,
    frames: lib.dist(frames),
    framesOver50: long,
    maxFrameMs: frames.length ? Math.max(...frames) : null,
    loafOver100: loaf.filter((l) => l.ms >= 100),
    renderCallsWithNewPrograms: renderAdds,
    maxProgramsAddedByOneRender: renderAdds.length ? Math.max(...renderAdds.map((r) => r.added)) : 0,
    maxProgramsAddedInOneFrame: frameJump,
    compiles,
    warmInterior: warm,
    door: doorOut,
    renderCalls: H.renderCalls,
    composerCalls: H.composerCalls,
    hookError: H.err,
    _renderAddsInWin: renderAddsInWin,
  };
}

async function hitch(t) {
  const tag = t.noKhr ? ' (--no-khr)' : '';
  for (const prof of t.profiles(['desktop', 'lowtier'])) {
    for (const scenario of ['card', 'walk']) {
      const r = await hitchRun(t, prof, scenario);
      const inWin = r._renderAddsInWin;
      delete r._renderAddsInWin;
      t.data[`${prof}-${scenario}`] = r;
      const k = `${prof} ${scenario === 'card' ? 'idle on the card' : 'walking'}${tag}`;
      const slowAdds = inWin.filter((x) => x.ms > 50);
      t.check(`${k}: render() calls that created programs, 5-25 s (each must be a <= 50 ms first draw of a late-loaded model)`, slowAdds.length === 0, inWin.length ? inWin.map((x) => `${x.atS}s +${x.added} (${x.ms} ms)`) : 'none', 'none over 50 ms');
      t.check(`${k}: frames over 50 ms, 5-25 s`, r.framesOver50.length === 0, r.framesOver50.length ? r.framesOver50.slice(0, 6) : 0, 0);
      t.check(`${k}: long animation frames >= 100 ms, 5-25 s`, r.loafOver100.length === 0, r.loafOver100.length ? r.loafOver100.slice(0, 6) : 0, 0);
      const warm = r.warmInterior[0];
      if (!t.noKhr) t.check(`${k}: the interior warm resolves within 10 s`, warm ? warm.endMs !== null && warm.endMs <= 10000 : null, warm || 'no warm in the window', '<= 10000 ms');
      if (r.door && r.door.interiorFrameMs !== undefined) {
        t.check(`${k}: first door entry, interior frame (ms)`, r.door.interiorFrameMs !== null && r.door.interiorFrameMs < 100, r.door.interiorFrameMs, '< 100');
        if (t.noKhr && prof === 'desktop') t.check(`${k}: first door entry, black interval (ms)`, r.door.blackIntervalMs <= 1000, r.door.blackIntervalMs, '<= 1000');
      }
    }
  }
}

// ------------------------------------------------------------------- seed
// The golden belongs to the checkout under test (B0 writes it there), so it
// resolves from --golden, else the checkout holding --dist, else the current
// directory, never from this tool's own checkout (lib.goldenPath).

async function seedRun(t, prof, label, localStorage) {
  const s = await t.session(prof, localStorage ? { localStorage } : {});
  const b = await t.boot(s, { waitWelcome: false });
  const seed = await s.page.evaluate(() => {
    const d = window.__dsSeedDraws;
    return d ? JSON.parse(JSON.stringify(d)) : null;
  });
  await s.close({ waitSignUpMs: 20000 });
  return { label, profile: prof, readyMs: b.readyMs, seed };
}

async function seed(t) {
  const runs = [];
  const profiles = t.profiles(['desktop', 'lowtier']);
  for (const prof of profiles) {
    const reps = prof === 'desktop' ? 3 : 1;
    for (let i = 0; i < reps; i++) runs.push(await seedRun(t, prof, `fresh #${i + 1}`, null));
    runs.push(await seedRun(t, prof, "ds_arrived='1'", { ds_arrived: '1' }));
  }
  t.data.runs = runs;
  const GOLDEN = lib.goldenPath(t.args);
  const shown = GOLDEN.replace(/\\/g, '/');
  const key = (x) => (x ? JSON.stringify({ total: x.total, marks: x.marks }) : null);
  // --bless first, so the checks below read the golden it wrote.
  if (t.args.bless) await bless(t, runs, GOLDEN, key);
  const golden = lib.readJson(GOLDEN);
  t.data.golden = golden ? { file: shown, ...golden } : { file: shown, absent: true };
  for (const prof of profiles) {
    const mine = runs.filter((r) => r.profile === prof);
    const present = mine.every((r) => r.seed);
    const sameAll = present && mine.every((r) => key(r.seed) === key(mine[0].seed));
    const first = mine[0] && mine[0].seed;
    const g = lib.goldenFor(golden, prof);
    if (prof === 'desktop') {
      t.check('desktop: window.__dsSeedDraws present', present, present ? first.total : 'seed counter absent', '{marks, total}');
      t.check("desktop: total and every mark identical for fresh storage, ds_arrived='1' and 3 reloads", present ? sameAll : false, present ? mine.map((r) => `${r.label}: ${r.seed.total}`) : 'seed counter absent', 'identical');
      t.check(`desktop: equal to ${shown}`, present && g ? key(first) === key(g) : false, !golden ? 'golden absent' : !present ? 'seed counter absent' : { measured: first.total, golden: g ? g.total : 'no desktop entry' }, 'equal');
    } else {
      // The low tier is reported; a difference is a pre-existing finding.
      t.data[`${prof}Report`] = present ? { totals: mine.map((r) => `${r.label}: ${r.seed.total}`), identical: sameAll, equalsDesktop: key(first) === key((runs.find((r) => r.profile === 'desktop') || {}).seed), equalsGolden: g ? key(first) === key(g) : 'golden absent' } : 'seed counter absent';
    }
  }
}

/** --bless: write B0's golden from the desktop runs (only when they all agree). */
async function bless(t, runs, GOLDEN, key) {
  const desk = runs.filter((r) => r.profile === 'desktop');
  const low = runs.filter((r) => r.profile === 'lowtier');
  const ok = desk.length && desk.every((r) => r.seed && key(r.seed) === key(desk[0].seed));
  if (!ok) throw new Error('--bless refused: the desktop runs are missing the counter or disagree');
  // B0's shape: the flat window.__dsSeedDraws object, { marks, total }.
  // The low tier must match it; a difference is recorded, not blessed.
  const out = { marks: desk[0].seed.marks, total: desk[0].seed.total };
  if (low.length && low[0].seed && key(low[0].seed) !== key(desk[0].seed)) t.data.blessNote = `the low tier differs (${low[0].seed.total}); only the desktop values were written`;
  fs.mkdirSync(path.dirname(GOLDEN), { recursive: true });
  // JSON goldens are prettier-formatted (format:check covers *.json), with
  // the subject checkout's prettier when it has one.
  let text = JSON.stringify(out, null, 2) + '\n';
  try {
    const prettier = require(require.resolve('prettier', { paths: [path.dirname(path.dirname(path.dirname(GOLDEN))), lib.REPO] }));
    text = await prettier.format(text, { ...((await prettier.resolveConfig(GOLDEN)) || {}), parser: 'json' });
  } catch (e) {
    t.data.blessNote = [t.data.blessNote, `written without prettier: ${String(e).slice(0, 120)}`].filter(Boolean).join('; ');
  }
  fs.writeFileSync(GOLDEN, text);
  t.data.blessed = GOLDEN.replace(/\\/g, '/');
}

module.exports = {
  hitch: { item: 'B2', title: '5-25 s after ready: frames, LoAF, programs per render and per compile, the first door entry', profiles: ['desktop', 'lowtier'], run: hitch },
  seed: { item: 'B0', title: "window.__dsSeedDraws: fresh vs ds_arrived='1', reloads, vs test/golden/seedDraws.json (--bless writes it)", profiles: ['desktop', 'lowtier'], run: seed },
};
