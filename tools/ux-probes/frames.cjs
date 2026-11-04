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
// apart from one created inside a compile call. scene.warmInterior and
// warmInteriorNearDoor are timed, and the warm's own work is recorded as the
// synchronous spans it runs (warmSegs, below), so a frame is charged to the
// warm by that work and not by when it lands.
const HITCH_INIT = `(() => {
  if (window.top !== window) return;
  const H = (window.__hitch = { frames: [], loaf: [], renders: [], compiles: [], warm: [], warmSegs: [], warmYields: 0, warmSegsClosedAtFrame: 0, readyAt: null, cardAt: null, installed: false, renderCalls: 0, composerCalls: 0 });
  const now = () => performance.now();
  // The warm's own work. A warm call opens a span; every time the warm yields
  // (a setTimeout made from its own frames: nextTask in compileInteriorPass
  // and warmInteriorPasses, settleWarmPrograms' polls) the open span closes,
  // and that timer's callback opens the next one, which the warm's
  // continuation then runs in. A span still open at a frame means a yield the
  // tags missed: it is closed there and counted.
  const WARM_FRAMES = /\\b(warmInteriorPasses|compileInteriorPass|settleWarmPrograms)\\b/;
  let flight = 0;
  let segAt = null;
  const segOpen = () => { if (segAt === null) segAt = now(); };
  const segClose = () => { if (segAt !== null) { H.warmSegs.push([+segAt.toFixed(2), +now().toFixed(2)]); segAt = null; } };
  const st0 = window.setTimeout;
  window.setTimeout = function (cb, ms) {
    if (flight > 0 && typeof cb === 'function' && WARM_FRAMES.test(new Error().stack || '')) {
      segClose();
      H.warmYields++;
      const rest = Array.prototype.slice.call(arguments, 2);
      return st0.call(window, function () { segOpen(); return cb.apply(this, arguments); }, ms, ...rest);
    }
    return st0.apply(window, arguments);
  };
  let last = 0;
  // Each rAF tick also logs the program count after the last top-level
  // render, so the jump between two consecutive renders (a compile call in
  // between plus the render itself) is visible as one number.
  H.postProgs = null;
  const tick = (t) => {
    if (segAt !== null) { segClose(); H.warmSegsClosedAtFrame++; }
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
  // A live frame that draws the room outside an entry: stage 1's warm made
  // the room visible while compileAsync finished, and the next frame drew the
  // room-lit variants for 2,043 ms. By design no frame ever draws it there.
  H.roomRenders = [];
  const roomShown = () => {
    const sc = window.__app && window.__app.scene;
    const g = sc && sc.interiorGroup;
    if (!g || !g.visible) return false;
    try { return !sc.isInsideInterior(); } catch (e) { return false; }
  };
  const install = () => {
    const app = window.__app;
    if (!app || !app.renderer || !app.scene || typeof app.renderer.getRenderer !== 'function') return false;
    const R = app.renderer.getRenderer();
    if (!R || !R.info) return false;
    H.roomHook = 'interiorGroup' in app.scene && typeof app.scene.isInsideInterior === 'function';
    const progs = () => (R.info.programs ? R.info.programs.length : 0);
    const wrapRender = (obj, key, label, counter) => {
      const orig = obj[key];
      if (typeof orig !== 'function' || orig.__hitch) return;
      const f = function () {
        const p0 = progs();
        const shown = inComposer === 0 && inCompile === 0 && roomShown();
        const t0 = now();
        const r = orig.apply(this, arguments);
        const p1 = progs();
        H[counter]++;
        if (inComposer === 0 && inCompile === 0) H.postProgs = p1;
        if (p1 !== p0 && inComposer === 0) H.renders.push({ t: Math.round(t0), label, added: p1 - p0, ms: +(now() - t0).toFixed(1), inCompile: inCompile > 0, programs: p1 });
        if (shown) H.roomRenders.push({ t: Math.round(t0), label, added: p1 - p0, ms: +(now() - t0).toFixed(1) });
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
    // The idle warm (warmInterior) and B2's near-door warm. A call that finds
    // the room already warm returns at once and records endMs 0.
    const wrapWarm = (key, source) => {
      if (typeof sc[key] !== 'function' || sc[key].__hitch) return;
      const o = sc[key];
      const w = function () {
        const t0 = now();
        const rec = { t: Math.round(t0), source: H.nextWarmSource || source };
        H.nextWarmSource = null;
        H.warm.push(rec);
        flight++;
        segOpen();
        let r;
        try { r = o.apply(this, arguments); } catch (e) { flight--; segClose(); throw e; }
        // The call's synchronous part is over: what runs next in this task is the caller's.
        segClose();
        const done = (ok) => { segClose(); flight = Math.max(0, flight - 1); rec.endMs = Math.round(now() - t0); if (!ok) rec.rejected = true; };
        if (r && typeof r.then === 'function') r.then(() => done(true), () => done(false));
        else done(true);
        return r;
      };
      w.__hitch = true;
      sc[key] = w;
    };
    wrapWarm('warmInterior', 'idle');
    wrapWarm('warmInteriorNearDoor', 'near-door');
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
      const shown = inCompile === 0 && roomShown();
      const t0 = now();
      inComposer++;
      let r;
      try { r = orig.apply(this, arguments); } finally { inComposer--; }
      const p1 = progs();
      H.composerCalls++;
      if (inCompile === 0) H.postProgs = p1;
      if (p1 !== p0) H.renders.push({ t: Math.round(t0), label: 'composer.render', added: p1 - p0, ms: +(now() - t0).toFixed(1), inCompile: inCompile > 0, programs: p1 });
      if (shown) H.roomRenders.push({ t: Math.round(t0), label: 'composer.render', added: p1 - p0, ms: +(now() - t0).toFixed(1) });
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

// A frame over 50 ms is the warm's only by the warm's own work in it. One
// slice is WARM_SLICE_MS (4 ms) plus one object by design, and setTimeout's
// 4 ms clamp spaces the slices, so an ordinary frame holds two at most: under
// WARM_MIN_MS of the warm's work, a frame over the line is over it on someone
// else's work.
const WARM_MIN_MS = 10;
const HITCH_MS = 50;

/**
 * Which frames over 50 ms the interior warm made (CO-E3), pure. frames: rAF
 * ticks [t, dt], each the interval (t - dt, t]; flights: the warm calls,
 * [{ t, endMs }], each watched to 100 ms past its end; segs: the warm's own
 * synchronous spans [[t0, t1]]; roomRenders: live renders that drew the room
 * outside an entry, [{ t, label, added, ms }]; renders: render() calls that
 * created programs, listed with each frame and never charged by themselves
 * (a late model's first draw or the bloom's is not the warm's). A frame over
 * 50 ms that overlaps a flight is the warm's when
 * - a live render in it drew the room outside an entry: the room-lit variants
 *   on screen (stage 1's 2,181 ms frame), or
 * - the warm's own work in it is over 50 ms, or
 * - that work is at least WARM_MIN_MS and the frame is 50 ms or less without it.
 * Returns { inFlight, charged }: every frame over 50 ms in a flight, and the
 * warm's, each { t, ms, warmMs, renders, roomRenders, why }.
 */
function warmAttribution({ frames = [], flights = [], segs = [], roomRenders = [], renders = [], minMs = WARM_MIN_MS, hitchMs = HITCH_MS } = {}) {
  const overlap = (a0, a1, b0, b1) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
  const wins = flights.map((w) => [w.t, w.t + (w.endMs === null || w.endMs === undefined ? 10000 : w.endMs) + 100]);
  const inWins = (tt) => wins.some(([w0, w1]) => tt >= w0 && tt <= w1);
  const inFlight = [];
  const charged = [];
  for (const [t, dt] of frames) {
    if (!(dt > hitchMs)) continue;
    const f0 = t - dt;
    if (!wins.some(([w0, w1]) => overlap(f0, t, w0, w1) > 0)) continue;
    const warmMs = +segs.reduce((s, [s0, s1]) => s + overlap(f0, t, s0, s1), 0).toFixed(1);
    const inFrame = (r) => r.t > f0 && r.t <= t && inWins(r.t);
    const room = roomRenders.filter(inFrame).map((r) => ({ label: r.label, added: r.added, ms: r.ms }));
    const adds = renders.filter((r) => !r.inCompile && r.added > 0 && inFrame(r)).map((r) => ({ label: r.label, added: r.added, ms: r.ms }));
    const row = { t, ms: dt, warmMs, renders: adds, roomRenders: room };
    let why = null;
    if (room.length) why = `a live render in it drew the room outside an entry (${room.map((r) => `${r.label} ${r.ms} ms, +${r.added} programs`).join('; ')})`;
    else if (warmMs > hitchMs) why = `the warm's own work in it is ${warmMs} ms`;
    else if (warmMs >= minMs && dt - warmMs <= hitchMs) why = `${warmMs} ms of it is the warm's: ${+(dt - warmMs).toFixed(1)} ms without it`;
    inFlight.push({ ...row, why });
    if (why) charged.push({ ...row, why });
  }
  return { inFlight, charged };
}

/**
 * Whether the warm's work was seen whole: a warm that ran over several tasks
 * (over 150 ms) yielded through the tagged frames at least twice, no span was
 * left open at a frame, and no compile call inside a flight fell outside the
 * spans. Otherwise warmAttribution() cannot see the warm's work, and the
 * check is inconclusive rather than a pass.
 */
function warmTagging({ flights = [], segs = [], compiles = [], yields = 0, closedAtFrame = 0 } = {}) {
  const ran = flights.filter((w) => (w.endMs || 0) > 150);
  const inSeg = (c) => segs.some(([s0, s1]) => c.t >= s0 - 1 && c.t + (c.syncMs || 0) <= s1 + 1);
  const inFlightC = compiles.filter((c) => flights.some((w) => c.t >= w.t && c.t <= w.t + (w.endMs ?? 10000)));
  const outsideMs = +inFlightC.filter((c) => !inSeg(c)).reduce((s, c) => s + (c.syncMs || 0), 0).toFixed(1);
  const why = [];
  if (ran.length && yields < 2) why.push(`a warm ran ${ran[0].endMs} ms but ${yields} of its yields were seen (frames.cjs tags warmInteriorPasses, compileInteriorPass and settleWarmPrograms)`);
  if (closedAtFrame) why.push(`${closedAtFrame} warm spans were still open at a frame`);
  if (outsideMs > 5) why.push(`${outsideMs} ms of compile calls inside a flight fell outside the warm's spans`);
  return { ok: why.length === 0, why, compileMsOutsideSpans: outsideMs };
}

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

async function hitchRun(t, prof, scenario, { pauseNearDoor = false, warmAt = null } = {}) {
  const s = await t.session(prof, { init: [HITCH_INIT] });
  const { page } = s;
  const b = await t.boot(s, { waitWelcome: false });
  if (!(await page.evaluate(() => window.__hitch && window.__hitch.installed))) throw new Error('hook missing: __app.renderer.getRenderer() for program accounting');
  const readyAt = await page.evaluate(() => window.__hitch.readyAt);
  // --warm-at <s>: call scene.warmInterior() at ready + s, so the warm fires
  // there whatever idleDefer would have done (an earlier idle warm makes it a
  // no-op, and the JSON says which warm ran).
  if (warmAt !== null)
    await page.evaluate(
      ({ at, readyAt: r0 }) => {
        setTimeout(() => {
          window.__hitch.nextWarmSource = 'probe (--warm-at)';
          void window.__app.scene.warmInterior();
        }, Math.max(0, r0 + at * 1000 - performance.now()));
      },
      { at: warmAt, readyAt },
    );
  const untilAfterReady = async (ms) => {
    for (;;) {
      const n = await page.evaluate(() => performance.now());
      if (n - readyAt >= ms) return;
      await lib.sleep(Math.min(250, ms - (n - readyAt)));
    }
  };
  await page.waitForSelector(`${lib.WELCOME} button[data-dismiss]`, { state: 'visible', timeout: 120000 }).catch(() => {});
  // The machine's load from the card to the end of the window: frames over
  // 50 ms are judged only when other processes left the host quiet.
  const meter = await lib.hostLoadMeter(t.browser);
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
  const hostLoad = await meter.stop();
  const H = await page.evaluate(() => {
    const h = window.__hitch;
    return { frames: h.frames, loaf: h.loaf, renders: h.renders, roomRenders: h.roomRenders, roomHook: !!h.roomHook, compiles: h.compiles, warm: h.warm, warmSegs: h.warmSegs, warmYields: h.warmYields, warmSegsClosedAtFrame: h.warmSegsClosedAtFrame, readyAt: h.readyAt, cardAt: h.cardAt, renderCalls: h.renderCalls, composerCalls: h.composerCalls, err: h.err || null };
  });
  // CO-E3: the probe attaches at ready and watches ready to ready + 25 s, so
  // a warm that fires early (main's at 1.3-2.9 s on a quiet machine, at its
  // 9 s ceiling on a busy one) is inside it wherever it lands. The frames
  // between ready and the card are the boot's own tail (the intro, the late
  // GLB models' first draws): reported, and judged from the card on.
  const w0 = H.cardAt !== null && H.cardAt > H.readyAt ? H.cardAt : H.readyAt;
  const w1 = H.readyAt + 25000;
  const inWin = (tt) => tt >= w0 && tt <= w1;
  const atS = (tt) => lib.round((tt - H.readyAt) / 1000, 2);
  const bootTail = H.frames.filter(([tt, d]) => tt >= H.readyAt && tt < w0 && d > 50).map(([tt, d]) => ({ atS: atS(tt), ms: d }));
  // The warm, wherever it fires, judged by its own work in each frame.
  const att = warmAttribution({ frames: H.frames, flights: H.warm, segs: H.warmSegs, roomRenders: H.roomRenders, renders: H.renders });
  const tagging = warmTagging({ flights: H.warm, segs: H.warmSegs, compiles: H.compiles, yields: H.warmYields, closedAtFrame: H.warmSegsClosedAtFrame });
  if (!H.roomHook) tagging.why.push('no scene.interiorGroup / isInsideInterior(): a live frame drawing the room cannot be seen');
  tagging.ok = tagging.why.length === 0;
  const shown = (x) => ({ atS: atS(x.t), ms: x.ms, warmMs: x.warmMs, ...(x.renders.length ? { renders: x.renders } : {}), ...(x.roomRenders.length ? { roomRenders: x.roomRenders } : {}), ...(x.why ? { why: x.why } : {}) });
  const segMs = H.warmSegs.map(([a, z]) => z - a);
  const warmWork = {
    yields: H.warmYields,
    spans: H.warmSegs.length,
    ms: lib.round(segMs.reduce((x, y) => x + y, 0), 1),
    longestSpanMs: segMs.length ? lib.round(Math.max(...segMs), 1) : null,
    longestSpans: H.warmSegs
      .map(([a, z]) => ({ atS: atS(a), ms: lib.round(z - a, 1) }))
      .sort((x, y) => y.ms - x.ms)
      .slice(0, 5),
    spansOpenAtAFrame: H.warmSegsClosedAtFrame,
    compileMsOutsideSpans: tagging.compileMsOutsideSpans,
    seenWhole: tagging.ok,
    why: tagging.why,
  };
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
  const warm = H.warm.map((w) => ({ startS: lib.round((w.t - H.readyAt) / 1000, 2), endMs: w.endMs ?? null, source: w.source }));
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
    // The frames over 50 ms the warm made, by its own work (warmAttribution),
    // and every frame over 50 ms while a warm was in flight, with its share.
    warmFramesOver50: att.charged.map(shown),
    warmFlightFramesOver50: att.inFlight.map(shown),
    warmWork,
    // Live renders that drew the room outside an entry, ready to + 25 s (none by design).
    roomRendersOutsideAnEntry: H.roomRenders.map((x) => ({ atS: atS(x.t), label: x.label, ms: x.ms, added: x.added })),
    hostLoad,
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

// Frames over 50 ms after the card are judged where plan-r3 sets that budget
// (desktop, with the extension), and only when other processes (other
// sessions' builds and probes, other apps) took no more than this share of
// the machine (lib.hostLoadMeter; --busy-cap <pct> overrides it). On a busier
// host a frame over 50 ms is inconclusive, not a fail and not a pass.
const OTHER_BUSY_CAP_PCT = 10;

async function hitch(t) {
  const tag = t.noKhr ? ' (--no-khr)' : '';
  // Without the extension the near-door warm is the only warm, so --no-khr
  // runs the pause-near-door entry too; --pause-near-door adds it anywhere.
  const pauseNearDoor = !!t.args.pauseNearDoor || t.noKhr;
  const warmAt = t.args.warmAt !== undefined && t.args.warmAt !== true ? Number(t.args.warmAt) : null;
  if (warmAt !== null && !(warmAt >= 0)) throw new lib.HarnessError(`--warm-at takes seconds after ready, got ${t.args.warmAt}`);
  const cap = t.args.busyCap !== undefined && t.args.busyCap !== true ? Number(t.args.busyCap) : OTHER_BUSY_CAP_PCT;
  t.data.otherBusyCapPct = cap;
  t.data.warmAt = warmAt;
  // --no-khr judges the black interval by pixels on the phone as well.
  for (const prof of t.profiles(t.noKhr ? ['desktop', 'lowtier', 'phone'] : ['desktop', 'lowtier'])) {
    for (const scenario of ['card', 'walk']) {
      const r = await hitchRun(t, prof, scenario, { pauseNearDoor: pauseNearDoor && scenario === 'card', warmAt });
      const inWin = r._renderAddsInWin;
      delete r._renderAddsInWin;
      t.data[`${prof}-${scenario}`] = r;
      const k = `${prof} ${scenario === 'card' ? 'idle on the card' : 'walking'}${tag}`;
      const slowAdds = inWin.filter((x) => x.ms > 50);
      // The warm by its own work in each frame (warmAttribution). A warm whose
      // work the tags did not see whole is inconclusive, never a pass.
      const ww = r.warmWork;
      const warmPass = !r.warmInterior.length ? null : r.warmFramesOver50.length ? false : ww.seenWhole ? true : null;
      const warmValue = !r.warmInterior.length ? 'no warm ran' : r.warmFramesOver50.length ? r.warmFramesOver50.slice(0, 6) : ww.seenWhole ? 0 : ww.why;
      t.check(`${k}: the interior warm makes no frame over 50 ms, wherever it fires`, warmPass, warmValue, 0);
      t.check(`${k}: render() calls that created programs, card to +25 s (each must be a <= 50 ms first draw of a late-loaded model)`, slowAdds.length === 0, inWin.length ? inWin.map((x) => `${x.atS}s +${x.added} (${x.ms} ms)`) : 'none', 'none over 50 ms');
      // plan-r3's runtime budget: 0 frames over 50 ms after the card.
      const over = r.framesOver50;
      const other = r.hostLoad ? r.hostLoad.otherBusyPct : null;
      if (prof === 'desktop' && !t.noKhr) {
        const quiet = other !== null && other <= cap;
        t.check(`${k}: frames over 50 ms, card to +25 s`, over.length === 0 ? true : quiet ? false : null, over.length ? { frames: over.slice(0, 6), host: r.hostLoad } : 0, `0 (inconclusive when other processes took over ${cap}% of the host)`);
      } else t.log(`${k}: frames over 50 ms, card to +25 s (reported; plan-r3 budgets desktop with the extension): ${over.length ? JSON.stringify(over.slice(0, 6)) : 0}; host ${JSON.stringify(r.hostLoad)}`);
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
  hitch: { item: 'B2, CO-E3', title: "the card to ready + 25 s and the interior warm wherever it fires (by its own work; --warm-at <s> fires it): frames, LoAF, programs per render and per compile; the first door walking straight in (and after a pause near a door), the black judged by pixels with --no-khr", profiles: ['desktop', 'lowtier'], run: hitch },
  warmAttribution,
  warmTagging,
  WARM_MIN_MS,
  seed: { item: 'B0', title: "window.__dsSeedDraws: fresh vs ds_arrived='1', reloads, vs test/golden/seedDraws.json (--bless writes it)", profiles: ['desktop', 'lowtier'], run: seed },
};
