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

async function events(t) {
  const runs = [];
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
  events: { item: 'A8, P2-A5, D4 (E6a)', title: "window 'ds:*' events: one ds:intro start and settled per load, ds:guide-to, the hire card's ds:modal", profiles: ['desktop', 'phone'], run: events },
  EVENTS_INIT,
  eventsOf,
};
