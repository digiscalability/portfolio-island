'use strict';
// Stage-2 probes, part 2 (E6b): intro. The motion audit's scripts (intro_ui,
// veil2, analyze_intro) were session temp files and are gone, so this is
// rebuilt from its report (docs/history/2026-11-03-ux-audit/motion.json:
// MOT-09, MOT-10) and checked against the numbers it recorded on 58c8849.
//
//   npm run probe -- intro [--profile desktop|phone] [--reduced-motion] --dist dist --port <n>
//
// - the fly-in or the calm entry: the camera's rotation per frame, the frames
//   over 50 ms once the loader has faded, the flight's span against the
//   loader, welcome_visible;
// - the first-frame opacity of the welcome card, the Portfolio menu, a zone
//   panel and the hire card (and when each is fully in);
// - the veil's ramp on its first and second use.
// A10's bar: on desktop the camera turns 1.5 degrees a frame or less through
// the flight, and no frame takes over 50 ms after the loader fades.
const lib = require('./lib.cjs');

// Before any page script: one row per animation frame from the first frame
// the camera exists.
const INTRO_INIT = `(() => {
  if (window.top !== window) return;
  const I = (window.__intro = { rows: [], events: [], on: true });
  window.addEventListener('ds:intro', (e) => I.events.push({ t: performance.now(), phase: e.detail && e.detail.phase }));
  const W = '[role=dialog][aria-label="Welcome to DigiScalability Life Island"]';
  let last = 0;
  const tick = (t) => {
    if (I.on) {
      const row = { t: +t.toFixed(1), dt: last ? +(t - last).toFixed(1) : 0 };
      // Two loaders cover the canvas in turn: index.html's static one, then
      // the app's own (the overlay child that holds #ld-bar), which fades out.
      let lo = 0;
      const ld = document.getElementById('loading-screen');
      if (ld && getComputedStyle(ld).display !== 'none') lo = +getComputedStyle(ld).opacity;
      const bar = document.getElementById('ld-bar');
      if (bar) {
        let el = bar;
        while (el.parentElement && el.parentElement.id !== 'ui-overlay') el = el.parentElement;
        const cs = getComputedStyle(el);
        if (cs.display !== 'none') lo = Math.max(lo, +cs.opacity);
      }
      row.loader = +lo.toFixed(2);
      const w = document.querySelector(W);
      if (w && w.innerHTML.length > 50) row.welcome = +(+getComputedStyle(w).opacity).toFixed(2);
      const a = window.__app;
      const sc = a && a.scene;
      const cam = sc && sc.getCamera ? sc.getCamera() : null;
      const pl = sc && sc.getPlayer ? sc.getPlayer() : null;
      if (cam && pl) {
        const q = cam.quaternion;
        row.q = [q.x, q.y, q.z, q.w];
        row.d = +cam.position.distanceTo(pl.getWorldPosition()).toFixed(2);
        row.ready = window.__lifeIslandReady === true;
      }
      I.rows.push(row);
      if (I.rows.length > 6000) I.rows.shift();
    }
    last = t;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
})();`;

/** The angle between two camera quaternions, in degrees. */
const angle = (a, b) => {
  const d = Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]));
  return (2 * Math.acos(d) * 180) / Math.PI;
};

/** Per-rAF opacity of whatever overlay element appears after the caller's action, for ms. */
const WATCH_NEW = ({ ms, pick }) =>
  new Promise((res) => {
    const ov = document.getElementById('ui-overlay');
    const before = new Set(ov.children);
    const ui = window.__app.ui;
    const rows = [];
    const t0 = performance.now();
    window.__watchT0 = t0;
    const find = () => {
      if (pick === 'zone') return ui.zonePanelDiv && ui.zonePanelDiv.isConnected ? ui.zonePanelDiv : null;
      if (pick === 'fade') return ui.fadeDiv && ui.fadeDiv.isConnected ? ui.fadeDiv : null;
      return [...ov.children].find((d) => !before.has(d) && getComputedStyle(d).display !== 'none' && d.getBoundingClientRect().width > 80) || null;
    };
    const tick = () => {
      const now = performance.now();
      const el = find();
      if (el) {
        const cs = getComputedStyle(el);
        rows.push({ t: +(now - t0).toFixed(1), o: +(+cs.opacity).toFixed(3), tf: cs.transform });
      } else rows.push({ t: +(now - t0).toFixed(1), o: null });
      if (now - t0 < ms) requestAnimationFrame(tick);
      else res(rows);
    };
    requestAnimationFrame(tick);
  });

/**
 * First frame's opacity, and when the element is fully in. `transformed` is
 * D11's "opacity only" test: true when the computed transform CHANGES across
 * the frames the element is seen (a slide or a scale). A constant transform
 * is the element's static positioning (a centring translate), not motion.
 */
function ramp(rows) {
  const seen = rows.filter((r) => r.o !== null);
  if (!seen.length) return { shown: false };
  const full = seen.find((r) => r.o >= 0.99);
  const tfs = [...new Set(seen.map((r) => (r.tf === undefined ? 'none' : String(r.tf))))];
  return { shown: true, firstFrameAtMs: seen[0].t, firstFrameOpacity: seen[0].o, fullAtMs: full ? full.t : null, rampMs: full ? +(full.t - seen[0].t).toFixed(0) : null, transformed: tfs.length > 1, transforms: tfs.slice(0, 6) };
}

async function watch(page, pick, act, ms = 700) {
  const p = page.evaluate(WATCH_NEW, { ms, pick });
  await lib.sleep(60);
  await act();
  return ramp(await p);
}

async function intro(t) {
  for (const prof of t.profiles(['desktop'])) {
    const touch = lib.isTouchProfile(prof);
    const s = await t.session(prof, { init: [INTRO_INIT], reducedMotion: t.args.reducedMotion ? 'reduce' : undefined });
    const { page } = s;
    await t.boot(s, { query: 'hour=12' });
    await lib.sleep(1800);
    const rec = await page.evaluate(() => {
      window.__intro.on = false;
      return { rows: window.__intro.rows, events: window.__intro.events };
    });
    await t.shot(page, `intro-${prof}-card.png`);
    const rows = rec.rows.filter((r) => r.q);
    const out = { frames: rows.length, events: rec.events.map((e) => ({ at: Math.round(e.t), phase: e.phase })) };
    // The flight: from ds:intro 'start' to 'settled' when the build says so,
    // else from the first frame the camera is over 20 u out to the first at rest near the player.
    const ev = (ph) => (rec.events.find((e) => e.phase === ph) || {}).t;
    const far = rows.find((r) => r.d > 20);
    const tStart = ev('start') ?? (far ? far.t : null);
    const cardRow = rec.rows.find((r) => r.welcome !== undefined);
    const tEnd = ev('settled') ?? (cardRow ? cardRow.t : rows.length ? rows[rows.length - 1].t : null);
    const fadedRow = rec.rows.find((r, i) => i > 0 && r.loader <= 0.05 && rec.rows.slice(0, i).some((x) => x.loader > 0.5));
    const opaqueUntil = rec.rows.filter((r) => r.loader >= 0.95).pop();
    out.loader = { opaqueUntilMs: opaqueUntil ? opaqueUntil.t : null, fadedAtMs: fadedRow ? fadedRow.t : null };
    out.flight = { startMs: tStart !== null && tStart !== undefined ? Math.round(tStart) : null, endMs: tEnd !== null && tEnd !== undefined ? Math.round(tEnd) : null, flewIn: !!far, startDistanceU: far ? far.d : rows.length ? rows[0].d : null };
    const flight = tStart !== null && tStart !== undefined && tEnd !== null && tEnd !== undefined ? rows.filter((r) => r.t >= tStart && r.t <= tEnd) : [];
    const visible = flight.filter((r) => out.loader.opaqueUntilMs === null || r.t > out.loader.opaqueUntilMs);
    const turns = [];
    for (let i = 1; i < visible.length; i++) turns.push({ t: visible[i].t, deg: +angle(visible[i - 1].q, visible[i].q).toFixed(2), dt: visible[i].dt, d: visible[i].d });
    const worst = turns.slice().sort((a, b) => b.deg - a.deg)[0] || null;
    out.flight.msUnderTheLoader = out.loader.opaqueUntilMs !== null && tStart !== null && tStart !== undefined ? Math.max(0, Math.round(out.loader.opaqueUntilMs - tStart)) : null;
    out.flight.firstVisibleDistanceU = visible.length ? visible[0].d : null;
    out.flight.visibleFrames = visible.length;
    out.flight.maxTurnDegPerFrame = worst ? worst.deg : null;
    out.flight.maxTurnAt = worst ? { ms: Math.round(worst.t), distanceU: worst.d, frameMs: worst.dt } : null;
    out.flight.frameMs = lib.dist(visible.map((r) => r.dt));
    // Frames over 50 ms once the loader has faded, up to 1.5 s after the card.
    const after = fadedRow ? rec.rows.filter((r) => r.t > fadedRow.t) : [];
    out.over50AfterFade = after.filter((r) => r.dt > 50).map((r) => ({ atMs: Math.round(r.t), ms: r.dt }));
    out.welcome = cardRow ? { visibleMs: Math.round(cardRow.t), firstFrameOpacity: cardRow.welcome, msAfterArrival: tEnd !== null && tEnd !== undefined ? Math.round(cardRow.t - tEnd) : null, fullAtMs: (rec.rows.find((r) => r.welcome !== undefined && r.welcome >= 0.99) || {}).t ?? null } : null;

    // The UI surfaces: first-frame opacity and the ramp.
    const ui = {};
    const centre = (fn, arg) => page.evaluate(fn, arg);
    const press = async (xy) => {
      if (!xy) return false;
      if (touch) await page.touchscreen.tap(xy[0], xy[1]);
      else await page.mouse.click(xy[0], xy[1]);
      return true;
    };
    // The hire card, from the welcome card's Hiring pill.
    const cta = await centre((sel) => {
      const b = document.querySelector(`${sel} button[data-cta="contact"]`);
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return [r.left + r.width / 2, r.top + r.height / 2];
    }, lib.WELCOME);
    ui.hireCard = cta ? await watch(page, 'zone', () => press(cta)) : { shown: false, note: 'no Hiring pill on the card' };
    await t.shot(page, `intro-${prof}-hire-card.png`);
    await page.evaluate(() => window.__app.ui.panels.closeAll());
    await lib.sleep(500);
    if (await page.evaluate(() => window.__app.ui.isWelcomeVisible())) await lib.dismissWelcome(page).catch(() => {});
    await lib.sleep(600);
    // The Portfolio menu (the phone's lives in the drawer, so it is opened where the pill is on screen).
    const pill = await centre(() => {
      const b = document.querySelector('.hud-btn[aria-label="Open portfolio menu"]');
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return r.width > 2 && r.top >= 0 && r.bottom <= innerHeight ? [r.left + r.width / 2, r.top + r.height / 2] : null;
    });
    ui.menu = pill ? await watch(page, 'new', () => press(pill)) : { shown: false, note: 'the Portfolio pill is not on screen at this size' };
    // A zone panel, from the menu's first section row.
    const row = await centre(() => {
      const b = [...document.querySelectorAll('button[data-section]')].find((x) => x.getBoundingClientRect().width > 2);
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return [r.left + r.width / 2, r.top + r.height / 2];
    });
    ui.zonePanel = row ? await watch(page, 'zone', () => press(row)) : { shown: false, note: 'no section row in the menu' };
    await page.evaluate(() => window.__app.ui.panels.closeAll());
    await lib.sleep(400);
    // The veil: its first use this session, then its second.
    if (await page.evaluate(() => typeof window.__app.ui.fadeThrough === 'function')) {
      const first = await page.evaluate(WATCH_VEIL);
      await lib.sleep(1200);
      const second = await page.evaluate(WATCH_VEIL);
      ui.veil = { firstUse: first, secondUse: second };
    } else ui.veil = { note: 'no ui.fadeThrough on this build' };
    // D11 (wave-4 rows list): the coin chip through a count-up, and the
    // flight a ds:coin starts (a synthetic one: D11 listens for B9's event).
    if (await page.evaluate(() => window.__app.ui.isWelcomeVisible())) await lib.dismissWelcome(page).catch(() => {});
    await lib.sleep(400);
    out.coinChip = await page.evaluate(COIN_COUNT_UP);
    // --selftest-flight: a stand-in for D11's flight (a 22 px coin to the chip
    // over 420 ms), so the flight row is shown to judge a real one.
    if (t.args.selftestFlight)
      await page.evaluate(() => {
        window.addEventListener('ds:coin', (e) => {
          const chip = window.__app.ui.coinDiv.getBoundingClientRect();
          const d = document.createElement('div');
          Object.assign(d.style, { position: 'fixed', width: '22px', height: '22px', borderRadius: '50%', background: '#ffd34a', zIndex: 99999, left: `${e.detail.x - 11}px`, top: `${e.detail.y - 11}px` });
          document.body.appendChild(d);
          const t0 = performance.now();
          const step = () => {
            const k = Math.min(1, (performance.now() - t0) / 420);
            d.style.left = `${e.detail.x + (chip.left + chip.width / 2 - e.detail.x) * k - 11}px`;
            d.style.top = `${e.detail.y + (chip.top + chip.height / 2 - e.detail.y) * k - 11}px`;
            if (k < 1) requestAnimationFrame(step);
            else setTimeout(() => d.remove(), 200);
          };
          requestAnimationFrame(step);
        });
      });
    out.coinFlight = t.args.reducedMotion ? null : await page.evaluate(COIN_FLIGHT);
    out.ui = ui;
    t.data[prof] = out;
    const cc = out.coinChip;
    t.check(`${prof}: the coin chip's width stays constant through a count-up, 11 to 18 (D11)`, cc && cc.texts.length >= 2 ? cc.spreadPx <= 0.5 : null, cc ? `${cc.spreadPx} px spread, widths ${cc.widths.join('/')} (${cc.texts.join(' > ')})${cc.texts.length < 2 ? '; no count-up seen' : ''}` : 'no coin chip', '<= 0.5 px (layout width; tabular-nums)');
    if (!t.args.reducedMotion) {
      const f = out.coinFlight;
      t.check(`${prof}: a ds:coin's flight ends on the coin chip (D11)`, f && f.flew ? f.endsOnChip : null, f ? (f.flew ? { end: f.end, chip: f.chip, ms: f.lastMs } : f.why) : 'not run', 'the flying coin ends inside the chip (+-4 px) (null: no flight on this build)');
    } else {
      // D11's reduced-motion rule: an opacity-only ramp of about 120 ms.
      const rm = [ui.menu, ui.zonePanel].filter((x) => x && x.shown);
      t.check(`${prof}: reduced motion ramps the menu and a panel in about 120 ms (D11)`, rm.length ? rm.every((x) => x.rampMs !== null && x.rampMs >= 80 && x.rampMs <= 200 && !x.transformed) : null, rm.map((x) => ({ firstFrameOpacity: x.firstFrameOpacity, rampMs: x.rampMs, transformed: x.transformed })), '80-200 ms, opacity only (main: instant)');
    }
    t.log(`${prof}: ${JSON.stringify({ flight: out.flight, loader: out.loader, over50AfterFade: out.over50AfterFade, welcome: out.welcome, ui })}`);
    // A10's bar is desktop's; the phone's calm entry is reported.
    const flew = out.flight.flewIn && out.flight.visibleFrames > 5;
    t.check(`${prof}: the camera's turn per frame through the visible flight (max, degrees)`, flew ? out.flight.maxTurnDegPerFrame <= 1.5 : out.flight.flewIn ? null : true, flew ? `${out.flight.maxTurnDegPerFrame} at ${out.flight.maxTurnAt.distanceU} u (a ${out.flight.maxTurnAt.frameMs} ms frame)` : out.flight.flewIn ? 'too few visible frames' : 'no fly-in (a calm entry)', '<= 1.5');
    t.check(`${prof}: frames over 50 ms after the loader fades`, out.loader.fadedAtMs !== null ? out.over50AfterFade.length === 0 : null, out.loader.fadedAtMs !== null ? (out.over50AfterFade.length ? out.over50AfterFade.slice(0, 6) : 0) : 'the loader was never seen to fade', 0);
    t.check(`${prof}: the welcome card appears`, !!out.welcome, out.welcome ? `${out.welcome.visibleMs} ms, first-frame opacity ${out.welcome.firstFrameOpacity}` : 'no card', 'reported');
  }
}

/** The coin chip's layout width (offsetWidth: the pop's transform aside) per rAF while 11 counts up to 18. */
const COIN_COUNT_UP = () =>
  new Promise((res) => {
    const a = window.__app;
    const sc = a.scene;
    const ui = a.ui;
    if (typeof sc.setCoins !== 'function' || typeof ui.updateCoinCounter !== 'function') return res(null);
    sc.setCoins(11);
    ui.updateCoinCounter(11);
    setTimeout(() => {
      const el = ui.coinDiv;
      if (!el || !el.isConnected) return res(null);
      const widths = [];
      const texts = [];
      sc.addCoins(7);
      ui.updateCoinCounter(sc.getCoinsCollected());
      const t0 = performance.now();
      const tick = () => {
        widths.push(el.offsetWidth);
        const tx = (el.textContent || '').trim();
        if (texts[texts.length - 1] !== tx) texts.push(tx);
        if (performance.now() - t0 < 1000) requestAnimationFrame(tick);
        else res({ widths: [...new Set(widths)], spreadPx: Math.max(...widths) - Math.min(...widths), texts: texts.slice(0, 10) });
      };
      requestAnimationFrame(tick);
    }, 600);
  });

/**
 * Dispatch one ds:coin {x, y, value: 1} at the screen's centre-left and track
 * any 14-32 px element that appears and moves in the next 900 ms: its last
 * rect is the flight's end, judged against the chip's rect (+-4 px).
 */
const COIN_FLIGHT = () =>
  new Promise((res) => {
    const ui = window.__app.ui;
    const chipEl = ui.coinDiv;
    if (!chipEl || !chipEl.isConnected) return res({ flew: false, why: 'no coin chip' });
    const seen = new Map();
    const mo = new MutationObserver((ms) => {
      for (const m of ms) for (const n of m.addedNodes) if (n.nodeType === 1 && !seen.has(n)) seen.set(n, []);
    });
    mo.observe(document.body, { childList: true, subtree: true });
    const t0 = performance.now();
    window.dispatchEvent(new CustomEvent('ds:coin', { detail: { x: Math.round(innerWidth * 0.4), y: Math.round(innerHeight * 0.55), value: 1 } }));
    const tick = () => {
      const now = performance.now() - t0;
      for (const [n, rows] of seen) {
        if (!n.isConnected) continue;
        const r = n.getBoundingClientRect();
        if (r.width >= 14 && r.width <= 32 && r.height >= 14 && r.height <= 32) rows.push({ t: Math.round(now), x: r.left + r.width / 2, y: r.top + r.height / 2 });
      }
      if (now < 900) requestAnimationFrame(tick);
      else {
        mo.disconnect();
        const moved = [...seen.values()].filter((rows) => rows.length >= 3 && Math.hypot(rows[rows.length - 1].x - rows[0].x, rows[rows.length - 1].y - rows[0].y) > 20);
        if (!moved.length) return res({ flew: false, why: 'no element flew after ds:coin' });
        const rows = moved.sort((p, q) => q.length - p.length)[0];
        const last = rows[rows.length - 1];
        const c = chipEl.getBoundingClientRect();
        res({ flew: true, end: [Math.round(last.x), Math.round(last.y)], lastMs: last.t, chip: [Math.round(c.left), Math.round(c.top), Math.round(c.width), Math.round(c.height)], endsOnChip: last.x >= c.left - 4 && last.x <= c.right + 4 && last.y >= c.top - 4 && last.y <= c.bottom + 4 });
      }
    };
    requestAnimationFrame(tick);
  });

/** The veil's opacity per rAF across one fadeThrough: when it starts, when it is black, how long the ramp took. */
const WATCH_VEIL = () =>
  new Promise((res) => {
    const ui = window.__app.ui;
    const rows = [];
    const t0 = performance.now();
    try {
      ui.fadeThrough(() => {});
    } catch (e) {
      res({ error: String(e).slice(0, 100) });
      return;
    }
    const tick = () => {
      const now = performance.now();
      const el = ui.fadeDiv;
      rows.push({ t: now - t0, o: el && el.isConnected ? +getComputedStyle(el).opacity : 0 });
      if (now - t0 < 1500) requestAnimationFrame(tick);
      else {
        const up = rows.find((r) => r.o > 0.02);
        const black = rows.find((r) => r.o >= 0.99);
        const blackRows = rows.filter((r) => r.o >= 0.95);
        res({
          firstFrameOpacity: rows.length ? +rows[0].o.toFixed(2) : null,
          blackAtMs: black ? Math.round(black.t) : null,
          rampMs: up && black ? Math.round(black.t - (rows[Math.max(0, rows.indexOf(up) - 1)] || up).t) : null,
          blackHeldMs: blackRows.length ? Math.round(blackRows[blackRows.length - 1].t - blackRows[0].t) : 0,
        });
      }
    };
    requestAnimationFrame(tick);
  });

module.exports = {
  intro: { item: 'E6b (MOT-09, MOT-10; A10)', title: "the fly-in or calm entry: the camera's turn per frame, frames over 50 ms after the loader fades, welcome_visible; first-frame opacity of the welcome card, menu, zone panel and hire card; the veil's first-use ramp", profiles: ['desktop'], run: intro },
  ramp,
};
