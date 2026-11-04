'use strict';
// Frame probes (B0, B2, CO-E3): the interior warm-up hitch and the
// seeded-window draw counter. hitch attaches at ready and measures ready to
// ready + 25 s; its first door reports the longest frame up to the first room
// frame and the black interval judged by pixels (a CDP screencast, veil
// hiding 95% of the world or more); --pause-near-door (and --no-khr) adds the
// entry after standing 3 s within a door's range.
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
  const H = (window.__hitch = { frames: [], loaf: [], renders: [], compiles: [], warm: [], readyAt: null, cardAt: null, installed: false, renderCalls: 0, composerCalls: 0 });
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
  // The welcome card's first paint with content (welcome_visible, as the perf gate marks it).
  const ivw = setInterval(() => { const w = document.querySelector('[role=dialog][aria-label="Welcome to DigiScalability Life Island"]'); if (w && w.innerHTML.length > 50) { clearInterval(ivw); H.cardAt = performance.now(); } }, 5);
})();`;

/**
 * The black interval judged by pixels (CO-E3): a CDP screencast through the
 * door entry, each frame's mean luminance against the world's just before
 * it. A frame is black when the veil hides 95% or more of the world (its
 * luminance is 5% of the pre-entry median or less); the interval runs from
 * the first black frame to the next frame that is not.
 */
async function screencastBlack(page, cdp, run) {
  const { jpegjs } = require('playwright-core/lib/utilsBundle');
  const frames = [];
  const onFrame = ({ data, metadata, sessionId }) => {
    frames.push({ t: metadata.timestamp * 1000, data });
    cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
  };
  cdp.on('Page.screencastFrame', onFrame);
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 40, maxWidth: 320, maxHeight: 320, everyNthFrame: 1 });
  await page.waitForTimeout(500);
  const enterAt = Date.now();
  const out = await run();
  await cdp.send('Page.stopScreencast').catch(() => {});
  cdp.off('Page.screencastFrame', onFrame);
  const lum = (b64) => {
    const img = jpegjs.decode(Buffer.from(b64, 'base64'), { useTArray: true });
    const lin = (c) => {
      const s = c / 255;
      return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    let sum = 0;
    let n = 0;
    for (let i = 0; i < img.data.length; i += 16) {
      sum += 0.2126 * lin(img.data[i]) + 0.7152 * lin(img.data[i + 1]) + 0.0722 * lin(img.data[i + 2]);
      n++;
    }
    return n ? sum / n : 0;
  };
  const rows = frames.map((f) => ({ t: f.t, lum: lum(f.data) })).sort((a, b) => a.t - b.t);
  const before = rows.filter((r) => r.t < enterAt).map((r) => r.lum);
  const base = before.length ? lib.median(before) : null;
  let blackMs = 0;
  let first = null;
  if (base) {
    for (let i = 0; i < rows.length; i++) {
      if (rows[i].t < enterAt) continue;
      const black = rows[i].lum <= 0.05 * base;
      if (black && first === null) first = rows[i].t;
      if (black && rows[i + 1]) blackMs += rows[i + 1].t - rows[i].t;
    }
  }
  return {
    out,
    pixels: {
      frames: rows.length,
      baseLum: base === null ? null : lib.round(base, 4),
      blackMs: base === null ? null : Math.round(blackMs),
      firstBlackAfterMs: first === null ? null : Math.round(first - enterAt),
      trace: rows.filter((r) => r.t >= enterAt).slice(0, 80).map((r) => `${Math.round(r.t - enterAt)}:${base ? lib.round(1 - r.lum / base, 2) : '?'}`),
    },
  };
}

/** The first door entry, under the veil: rows per rAF, the veil's opacity and the pixels. */
async function doorEntry(page, cdp, { pauseNearDoor = false } = {}) {
  if (pauseNearDoor) {
    // Stand 3 s within NEAR_DOOR_RANGE of a cottage door (B2's near-door
    // warm needs 1 s of standing still), then enter.
    const near = await page.evaluate(() => {
      const sc = window.__app.scene;
      const d = sc.getIsland().houseDoors[0];
      if (!d) return null;
      const P = sc.getPlayer();
      const up = d.position.clone().normalize();
      const ref = Math.abs(up.y) < 0.9 ? up.clone().set(0, 1, 0) : up.clone().set(1, 0, 0);
      const dir = d.position.clone().addScaledVector(ref.clone().cross(up).normalize(), 3).normalize();
      const s = sc.getIsland().sampleSurfaceByDirection(dir, 0);
      P.setWorldPosition(dir.multiplyScalar(s.position.length() + 0.75));
      return { door: d.id, distanceU: 3 };
    });
    await page.waitForTimeout(3000);
    if (!near) return { error: 'no house door' };
  }
  const run = () =>
    page.evaluate(async () => {
      const a = window.__app;
      if (typeof a.enterBuilding !== 'function') return { error: 'no enterBuilding' };
      a.ui.panels.closeAll();
      const nearDoorWarmed = !!a.scene.interiorNearDoorWarmed;
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
      return { rows, nearDoorWarmed };
    });
  const { out: door, pixels } = await screencastBlack(page, cdp, run);
  if (!door.rows) return door;
  const rows = door.rows;
  let black = 0;
  for (let i = 1; i < rows.length; i++) if (rows[i - 1].op >= 0.95) black += rows[i].t - rows[i - 1].t;
  const firstInside = rows.findIndex((r) => r.inside);
  const upTo = firstInside >= 0 ? Math.min(rows.length, firstInside + 2) : rows.length;
  return {
    pauseNearDoor,
    nearDoorWarmedBeforeEntry: door.nearDoorWarmed,
    // Stage 1 read rows[firstInside + 1].dt and so hid a slow first room frame.
    firstInsideFrameMs: firstInside >= 0 ? rows[firstInside].dt : null,
    maxFrameToFirstInsideMs: rows.length ? Math.max(...rows.slice(0, upTo).map((r) => r.dt)) : null,
    maxFrameMs: rows.length ? Math.max(...rows.map((r) => r.dt)) : null,
    blackIntervalMs: Math.round(black),
    blackIntervalPixelsMs: pixels.blackMs,
    pixels,
    trace: rows.filter((_, i) => i % 3 === 0).map((r) => `${r.t}:${r.op}${r.inside ? 'i' : ''}`),
  };
}

async function hitchRun(t, prof, scenario, { pauseNearDoor = false } = {}) {
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
    return { frames: h.frames, loaf: h.loaf, renders: h.renders, compiles: h.compiles, warm: h.warm, readyAt: h.readyAt, cardAt: h.cardAt, renderCalls: h.renderCalls, composerCalls: h.composerCalls, err: h.err || null };
  });
  // CO-E3: the probe attaches at ready and watches ready to ready + 25 s, so
  // a warm that fires early (main's at 1.3-2.9 s on a quiet machine, at its
  // 9 s ceiling on a busy one) is inside it wherever it lands. The frames
  // between ready and the card are the boot's own tail (the intro, the late
  // GLB models' first draws): reported, and judged from the card on.
  const w0 = H.cardAt !== null && H.cardAt > H.readyAt ? H.cardAt : H.readyAt;
  const w1 = H.readyAt + 25000;
  const inWin = (tt) => tt >= w0 && tt <= w1;
  const bootTail = H.frames.filter(([tt, d]) => tt >= H.readyAt && tt < w0 && d > 50).map(([tt, d]) => ({ atS: lib.round((tt - H.readyAt) / 1000, 2), ms: d }));
  // The warm, wherever it fires: every frame from its start to 100 ms past its end.
  const warmFrames = [];
  for (const w of H.warm) {
    const end = w.t + (w.endMs ?? 10000) + 100;
    for (const [tt, d] of H.frames) if (tt >= w.t && tt <= end && d > 50) warmFrames.push({ atS: lib.round((tt - H.readyAt) / 1000, 2), ms: d });
  }
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
  const cardS = lib.round((w0 - H.readyAt) / 1000, 2);
  const renderAddsInWin = renderAdds.filter((r) => r.atS >= cardS && r.atS <= 25);
  const compiles = H.compiles.map((c) => ({ ...c, atS: lib.round((c.t - H.readyAt) / 1000, 2) }));
  const warm = H.warm.map((w) => ({ startS: lib.round((w.t - H.readyAt) / 1000, 2), endMs: w.endMs ?? null }));
  const cdp = await s.ctx.newCDPSession(page);
  const doors = { walkStraightIn: await doorEntry(page, cdp) };
  await t.shot(page, `hitch-${prof}-${scenario}-inside.png`);
  if (pauseNearDoor) {
    // The near-door entry needs its own first door: a fresh page.
    const s2 = await t.session(prof, { init: [HITCH_INIT] });
    await t.boot(s2);
    await lib.dismissWelcome(s2.page);
    await s2.page.waitForTimeout(1500);
    doors.pauseNearDoor = await doorEntry(s2.page, await s2.ctx.newCDPSession(s2.page), { pauseNearDoor: true });
    await t.shot(s2.page, `hitch-${prof}-${scenario}-near-door-inside.png`);
    await s2.close();
  }
  return {
    boot: b,
    scenario,
    window: 'the card to ready + 25 s, and the warm wherever it fires',
    cardAfterReadyS: cardS,
    bootTailOver50: bootTail,
    warmFramesOver50: warmFrames,
    frames: lib.dist(frames),
    framesOver50: long,
    maxFrameMs: frames.length ? Math.max(...frames) : null,
    loafOver100: loaf.filter((l) => l.ms >= 100),
    renderCallsWithNewPrograms: renderAdds,
    maxProgramsAddedByOneRender: renderAdds.length ? Math.max(...renderAdds.map((r) => r.added)) : 0,
    maxProgramsAddedInOneFrame: frameJump,
    compiles,
    warmInterior: warm,
    door: doors.walkStraightIn,
    doors,
    renderCalls: H.renderCalls,
    composerCalls: H.composerCalls,
    hookError: H.err,
    _renderAddsInWin: renderAddsInWin,
  };
}

async function hitch(t) {
  const tag = t.noKhr ? ' (--no-khr)' : '';
  // Without the extension the near-door warm is the only warm, so --no-khr
  // runs the pause-near-door entry too; --pause-near-door adds it anywhere.
  const pauseNearDoor = !!t.args.pauseNearDoor || t.noKhr;
  // --no-khr judges the black interval by pixels on the phone as well.
  for (const prof of t.profiles(t.noKhr ? ['desktop', 'lowtier', 'phone'] : ['desktop', 'lowtier'])) {
    for (const scenario of ['card', 'walk']) {
      const r = await hitchRun(t, prof, scenario, { pauseNearDoor: pauseNearDoor && scenario === 'card' });
      const inWin = r._renderAddsInWin;
      delete r._renderAddsInWin;
      t.data[`${prof}-${scenario}`] = r;
      const k = `${prof} ${scenario === 'card' ? 'idle on the card' : 'walking'}${tag}`;
      const slowAdds = inWin.filter((x) => x.ms > 50);
      t.check(`${k}: the interior warm makes no frame over 50 ms, wherever it fires`, r.warmInterior.length ? r.warmFramesOver50.length === 0 : null, r.warmInterior.length ? (r.warmFramesOver50.length ? r.warmFramesOver50.slice(0, 6) : 0) : 'no warm ran', 0);
      t.check(`${k}: render() calls that created programs, card to +25 s (each must be a <= 50 ms first draw of a late-loaded model)`, slowAdds.length === 0, inWin.length ? inWin.map((x) => `${x.atS}s +${x.added} (${x.ms} ms)`) : 'none', 'none over 50 ms');
      // Every frame over 50 ms in the window is reported, not judged: on this
      // rig both builds make 60-90 ms frames there that are not the warm (the
      // music synthesis near ready + 5 s, late texture uploads). The warm's
      // own frames, the program-creating renders and long animation frames
      // are the gates.
      t.log(`${k}: frames over 50 ms, card to +25 s (reported): ${r.framesOver50.length ? JSON.stringify(r.framesOver50.slice(0, 6)) : 0}`);
      t.check(`${k}: long animation frames >= 100 ms, card to +25 s`, r.loafOver100.length === 0, r.loafOver100.length ? r.loafOver100.slice(0, 6) : 0, 0);
      const warm = r.warmInterior[0];
      if (!t.noKhr) t.check(`${k}: the interior warm resolves within 10 s`, warm ? warm.endMs !== null && warm.endMs <= 10000 : null, warm || 'no warm in the window', '<= 10000 ms');
      for (const [variant, d] of Object.entries(r.doors)) {
        if (!d || d.maxFrameToFirstInsideMs === undefined) continue;
        const v = variant === 'pauseNearDoor' ? 'pause-near-door' : 'walk-straight-in';
        t.check(`${k}: first door (${v}), the longest frame to the first room frame (ms)`, d.maxFrameToFirstInsideMs !== null && d.maxFrameToFirstInsideMs < 100, { maxToFirstInside: d.maxFrameToFirstInsideMs, firstInside: d.firstInsideFrameMs }, '< 100');
        if (t.noKhr) t.check(`${k}: first door (${v}), black interval by pixels (ms)`, d.blackIntervalPixelsMs !== null && d.blackIntervalPixelsMs <= 1000, { pixels: d.blackIntervalPixelsMs, opacity: d.blackIntervalMs }, '<= 1000');
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
  hitch: { item: 'B2, CO-E3', title: 'the card to ready + 25 s and the interior warm wherever it fires: frames, LoAF, programs per render and per compile; the first door walking straight in (and after a pause near a door), the black judged by pixels with --no-khr', profiles: ['desktop', 'lowtier'], run: hitch },
  seed: { item: 'B0', title: "window.__dsSeedDraws: fresh vs ds_arrived='1', reloads, vs test/golden/seedDraws.json (--bless writes it)", profiles: ['desktop', 'lowtier'], run: seed },
};
