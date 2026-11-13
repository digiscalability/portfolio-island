'use strict';
// Window 'ds:*' events (E6a). EVENTS_INIT wraps EventTarget.dispatchEvent
// before any page script, so every CustomEvent the app dispatches on window
// whose type starts with 'ds:' is logged with its time and detail, whatever
// its name: ds:intro, ds:modal, ds:guide, ds:guide-to, ds:goals,
// ds:npc-speaking, ds:npc-typing, ds:coin, ds:settings and any later one.
// Other probes pass EVENTS_INIT in their session's init list and read the log
// with eventsOf(page).
//
// The 'events' probe checks the contracts stage 2 adds:
// - A8: exactly one ds:intro {phase:'start'} then one {phase:'settled'} per
//   load, on desktop, on the phone, under reduced motion and on a deep link;
// - P2-A5: a 'ds:guide-to' {key:'school'} sets the compass label to School
//   within one frame;
// - D4: closing the hire card dispatches 'ds:modal' {open:false, id:'zone', zone:'hire'}.
// - B9 (wave 4): walking onto one meadow coin dispatches exactly one ds:coin
//   {x, y, value: 1} per coin gained (null on a build without it).
const lib = require('./lib.cjs');

const EVENTS_INIT = `(() => {
  if (window.top !== window) return;
  const E = (window.__dsEvents = window.__dsEvents || []);
  const orig = EventTarget.prototype.dispatchEvent;
  EventTarget.prototype.dispatchEvent = function (ev) {
    try {
      if (this === window && ev && typeof ev.type === 'string' && ev.type.indexOf('ds:') === 0) {
        let detail = null;
        try { detail = ev.detail === undefined ? null : JSON.parse(JSON.stringify(ev.detail)); } catch (e) { detail = String(ev.detail); }
        E.push({ t: Math.round(performance.now()), type: ev.type, detail });
        if (E.length > 4000) E.splice(0, 1000);
      }
    } catch (e) {}
    return orig.call(this, ev);
  };
})();`;

/** The 'ds:*' log so far (optionally one type, or since a page time). */
const eventsOf = (page, { type = null, since = 0 } = {}) =>
  page.evaluate(({ type, since }) => (window.__dsEvents || []).filter((e) => e.t >= since && (!type || e.type === type)), { type, since }).catch(() => []);

const INTRO = (evs) => evs.filter((e) => e.type === 'ds:intro').map((e) => (e.detail && e.detail.phase) || null);

/** One load: its ds:intro sequence, with the card dismissed so the intro settles. */
async function introLoad(t, prof, label, { reducedMotion = false, query = '' } = {}) {
  const s = await t.session(prof, { init: [EVENTS_INIT], ...(reducedMotion ? { reducedMotion: 'reduce' } : {}) });
  const b = await t.boot(s, { query, waitWelcome: !query });
  // Let the fly-in (or the calm entry) finish, then a little more.
  await s.page.waitForTimeout(4000);
  const evs = await eventsOf(s.page);
  const phases = INTRO(evs);
  return { label, boot: b, phases, all: evs.map((e) => `${(e.t / 1000).toFixed(2)}s ${e.type} ${JSON.stringify(e.detail)}`.slice(0, 160)), s };
}

/**
 * B9 (wave-4 rows list): walk onto one meadow coin on the frozen 1/60 s sim
 * (env.cjs's setup: 3.5 u short of the nearest meadow coin, facing it), then
 * step one more second. ds:coin must fire exactly once per coin gained, with
 * its values summing to the gain. Null on a build that never dispatches it.
 */
async function coinOnce(t, prof) {
  const E = require('./env.cjs');
  const s = await t.session(prof, { init: [EVENTS_INIT], clock: true });
  const { page } = s;
  const out0 = {};
  await t.boot(s);
  await lib.dismissWelcome(page);
  await page.waitForTimeout(1500);
  await page.evaluate(E.ENV_LIB);
  // --selftest-coin once|twice: wrap collectMeadowCoin to dispatch B9's event
  // once (the row must pass) or twice (it must fail) on a build without it.
  const self = t.args.selftestCoin && t.args.selftestCoin !== true ? String(t.args.selftestCoin) : null;
  if (self)
    out0.selftest = await page.evaluate((times) => {
      const sc = window.__app.scene;
      const orig = sc.collectMeadowCoin;
      if (typeof orig !== 'function') return 'no collectMeadowCoin';
      sc.collectMeadowCoin = function (...a) {
        const r = orig.apply(this, a);
        for (let i = 0; i < times; i++) window.dispatchEvent(new CustomEvent('ds:coin', { detail: { x: 1, y: 1, value: 1 } }));
        return r;
      };
      return `ds:coin x${times} per collectMeadowCoin`;
    }, self === 'twice' ? 2 : 1);
  const set = await page.evaluate(E.COIN_SETUP);
  const out = { ...out0, setup: set };
  if (set) {
    await page.waitForTimeout(900);
    for (let k = 0; k < 4; k++) {
      await page.evaluate(E.AIM_COIN);
      await page.waitForTimeout(250);
    }
    await page.waitForTimeout(600);
    await page.evaluate(lib.FREEZE);
    await page.evaluate(() => (window.__env.headH = window.__env.headTopH()));
    const since = await page.evaluate(() => performance.now());
    const n0 = await page.evaluate(() => window.__h.sc.getCoinsCollected());
    await page.keyboard.down('w');
    let at = null;
    for (let f = 0; f < 150 && at === null; f++) if ((await page.evaluate(E.COIN_FRAME)).n > n0) at = f;
    await page.keyboard.up('w');
    // One more second, standing: a late or repeated dispatch shows here.
    if (at !== null) for (let f = 0; f < 60; f++) await page.evaluate(E.COIN_FRAME);
    const n1 = await page.evaluate(() => window.__h.sc.getCoinsCollected());
    await page.evaluate(lib.THAW);
    const evs = await eventsOf(page, { type: 'ds:coin', since: Math.floor(since) });
    Object.assign(out, { collectedAtFrame: at, gained: n1 - n0, dsCoin: evs.map((e) => e.detail), valueSum: evs.reduce((a, e) => a + ((e.detail && Number(e.detail.value)) || 0), 0) });
  }
  const ok = out.gained > 0 && out.dsCoin && out.dsCoin.length ? out.dsCoin.length === out.gained && out.valueSum === out.gained : null;
  const why = !set ? 'no meadow coin list on this build' : !(out.gained > 0) ? 'the coin was never collected' : out.dsCoin.length ? `${out.dsCoin.length} ds:coin for ${out.gained} coin(s), values ${out.valueSum}` : 'no ds:coin on this build (B9 adds it)';
  t.check(`${prof}: ds:coin fires exactly once per pickup, walking onto one meadow coin (B9)`, ok, why, 'one per coin, values summing to the gain (null: no ds:coin on this build)');
  if (out.dsCoin && out.dsCoin.length) t.check(`${prof}: ds:coin's detail carries x, y and value (B9)`, out.dsCoin.every((d) => d && Number.isFinite(d.x) && Number.isFinite(d.y) && d.value === 1), out.dsCoin[0], '{x, y, value: 1}');
  await s.close();
  return out;
}

async function events(t) {
  const runs = [];
  // --part intro|coin (both by default).
  const part = t.args.part && t.args.part !== true ? String(t.args.part) : null;
  if (!part || part === 'coin') if (!t.args.profile || t.args.profile === 'desktop') t.data.coin = await coinOnce(t, 'desktop');
  if (part === 'coin') return;
  for (const [prof, label, opts] of [
    ['desktop', 'desktop', {}],
    ['phone', 'phone', {}],
    ['desktop', 'desktop, reduced motion', { reducedMotion: true }],
    ['desktop', 'desktop, deep link ?zone=projects', { query: 'zone=projects' }],
  ]) {
    if (t.args.profile && t.args.profile !== prof) continue;
    const r = await introLoad(t, prof, label, opts);
    runs.push(r);
    const starts = r.phases.filter((p) => p === 'start').length;
    const settled = r.phases.filter((p) => p === 'settled').length;
    const order = r.phases.join(',') === 'start,settled';
    t.check(`${label}: one ds:intro start, then one settled`, starts === 1 && settled === 1 && order, r.phases.length ? r.phases : 'no ds:intro event', 'start,settled');
    // The guide-to seam and the hire card's close signal, on the plain loads.
    if (!opts.reducedMotion && !opts.query) {
      const { page } = r.s;
      await lib.dismissWelcome(page).catch(() => {});
      await page.waitForTimeout(1500);
      const gt = await page.evaluate(async () => {
        const ui = window.__app.ui;
        const label = () => (window.__h && window.__h.compassFull ? window.__h.compassFull() : ui.compassLabel ? ui.compassLabel.textContent : null);
        const before = label();
        window.dispatchEvent(new CustomEvent('ds:guide-to', { detail: { key: 'school', source: 'probe' } }));
        await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
        const after = label();
        return { before, after, target: window.__app.mapGuideLabel || null };
      });
      // The recorder's own self-check: it must have logged the probe's dispatch.
      gt.recorderSawDispatch = (await eventsOf(page, { type: 'ds:guide-to' })).length > 0;
      r.guideTo = gt;
      t.check(`${label}: the ds:* recorder logs a window dispatch (self-check)`, gt.recorderSawDispatch, gt.recorderSawDispatch, true);
      t.check(`${label}: 'ds:guide-to' {key:'school'} sets the compass label to School within 1 frame`, /school/i.test(gt.after || ''), gt.after, 'School');
      // The hire card: open it the way the menu does, then close it.
      const since = await page.evaluate(() => performance.now());
      const opened = await page.evaluate(() => {
        const ui = window.__app.ui;
        if (ui.panels) ui.panels.closeAll();
        if (typeof ui.showHireCard === 'function') {
          ui.showHireCard('menu');
          return 'showHireCard';
        }
        const b = document.querySelector('button[data-section="hire"]');
        if (b) {
          b.click();
          return 'menu row';
        }
        return null;
      });
      await page.waitForTimeout(900);
      const top = await page.evaluate(() => window.__app.ui.panels.current());
      await page.evaluate(() => window.__app.ui.panels.closeTop());
      await page.waitForTimeout(500);
      const modal = await eventsOf(page, { type: 'ds:modal', since });
      r.hire = { opened, panel: top, modal };
      const closed = modal.find((e) => e.detail && e.detail.open === false && e.detail.id === 'zone' && e.detail.zone === 'hire');
      t.check(`${label}: closing the hire card dispatches ds:modal {open:false, id:'zone', zone:'hire'}`, top === 'zone' ? !!closed : null, modal.length ? modal.map((e) => JSON.stringify(e.detail)) : top === 'zone' ? 'no ds:modal event' : `the hire card did not open (${top})`, "{open:false,id:'zone',zone:'hire'}");
      await t.shot(page, `events-${prof}.png`);
    }
    delete r.s;
  }
  t.data.runs = runs;
}

module.exports = {
  events: { item: 'A8, P2-A5, D4 (E6a); B9 (wave 4)', title: "window 'ds:*' events: one ds:intro start and settled per load, ds:guide-to, the hire card's ds:modal, ds:coin once per pickup (`--part intro|coin`)", profiles: ['desktop', 'phone'], run: events },
  EVENTS_INIT,
  eventsOf,
};
