'use strict';
// p2/build: a failed build's outcome message waits behind hints (P2-E2d;
// GP-08; D6). The gameplay audit's g6-build.cjs was a session temp file and
// is gone, so this is rebuilt from phase2-audit/results/gameplay.json GP-08:
// 'The build cart is stuck — materials returned.' appeared 5.9 s after E,
// though the coins were back at 2.7 s; it waited behind the 88-character
// talk hint, which dwells 50 ms per character. (Apart from p2/building.cjs,
// the rooms probes.)
//
// Desktop, the card dismissed, First steps skipped, with timber and coins
// seeded (ds_timber 10, ds_coins 30) so the cheapest free structure plot is
// affordable. The cloud write is blocked by the harness, as every write is,
// so the build refunds. Stood 1.5 u from the plot's seat, E pressed:
//   coins     the time from E (on a structure plot, the chooser's Build
//             click) until the coin count is back where it was
//   toast     every ui.toast call (observed), and when the refund text is on
//             screen (P2's SAMPLER over #ui-overlay), against E and the coins
//   ahead     what showed between E and the refund (the queued hint)
// D6's deferred row: the refund message within 0.5 s of the coins returning.
//
//   npm run probe -- p2/build --dist dist --port <n>
const lib = require('../lib.cjs');
const P = require('./play-lib.cjs');

const REFUND = /materials returned|build cart is stuck|plenty of building/i;

const TOAST_LOG = () => {
  const ui = window.__app.ui;
  const L = (window.__toasts = []);
  if (typeof ui.toast === 'function' && !ui.toast.__probe) {
    const orig = ui.toast;
    const w = function (text, opts) {
      L.push({ t: Math.round(performance.now()), text: String(text).slice(0, 160), hint: !!(opts && opts.hint) });
      return orig.apply(this, arguments);
    };
    w.__probe = true;
    ui.toast = w;
  }
  // Coins, every frame: the moment the count changes.
  const sc = window.__app.scene;
  const C = (window.__coinTrace = []);
  let last = sc.getCoinsCollected();
  const tick = () => {
    const n = sc.getCoinsCollected();
    if (n !== last) C.push({ t: Math.round(performance.now()), n });
    last = n;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  return true;
};
/**
 * The cheapest free structure plot (the build system: a scaffold and a 1.6 s
 * construction moment before the refund), else a bench plot; stand 1.5 u
 * from its seat.
 */
const STAND = () => {
  const sc = window.__app.scene;
  const isl = sc.getIsland();
  const plots = typeof sc.freePlotSummary === 'function' ? sc.freePlotSummary() : [];
  const cheap = ['signpost', 'planter', 'lantern', 'campfire', 'gazebo'];
  const pick = plots.filter((p) => p.kind !== 'bench').sort((a, b) => cheap.indexOf(a.kind) - cheap.indexOf(b.kind))[0] || plots[0];
  if (!pick) return null;
  const c = pick.pos.clone();
  const up = c.clone().normalize();
  const V3 = c.constructor;
  const ref = Math.abs(up.y) < 0.9 ? new V3(0, 1, 0) : new V3(1, 0, 0);
  const t = ref.clone().addScaledVector(up, -ref.dot(up)).normalize();
  const dir = c.clone().addScaledVector(t, 1.5).normalize();
  const sfc = isl.sampleSurfaceByDirection(dir, 0);
  sc.getPlayer().setWorldPosition(dir.multiplyScalar(sfc.position.length() + 0.6));
  return { kind: pick.kind, plots: plots.length };
};

async function build(t) {
  for (const prof of t.profiles(['desktop'])) {
    const s = await t.session(prof, { init: [P.SAMPLER], localStorage: { ds_timber: '10', ds_coins: '30' } });
    await t.boot(s);
    const { page } = s;
    await lib.dismissWelcome(page);
    await page.evaluate(() => {
      const g = window.__app.guide;
      if (g && typeof g.isActive === 'function' && g.isActive() && typeof g.skip === 'function') g.skip();
    });
    await lib.sleep(1500);
    await page.evaluate(P.HELPERS);
    const stand = await page.evaluate(STAND);
    if (!stand) throw new Error('hook missing: scene.freePlotSummary (no free plot)');
    await lib.sleep(1200);
    const prompt = await page.evaluate(() => window.__g.prompt());
    await page.evaluate(TOAST_LOG);
    const c0 = await page.evaluate(() => window.__app.scene.getCoinsCollected());
    let tE = await page.evaluate(() => Math.round(performance.now()));
    await page.keyboard.press('e');
    // A structure plot's chooser: its first affordable Build button.
    await lib.sleep(400);
    const chose = await page.evaluate(() => {
      const b = [...document.querySelectorAll('button[data-build-kind]')].find((x) => !x.disabled);
      if (!b) return null;
      b.click();
      return Math.round(performance.now());
    });
    if (chose) tE = chose;
    await lib.sleep(9000);
    const trace = await page.evaluate(() => window.__coinTrace.slice());
    const toasts = await page.evaluate(() => window.__toasts.slice());
    const ev = (await P.gpEvents(page, tE)).filter((e) => e.ev === 'show' || e.ev === 'text');
    await t.shot(page, `p2-build-${prof}.png`);
    await s.close();
    const spent = trace.find((x) => x.n < c0);
    const back = trace.find((x, i) => i > 0 && x.n === c0 && trace.slice(0, i).some((y) => y.n < c0));
    const call = toasts.find((x) => REFUND.test(x.text));
    const shown = ev.find((e) => REFUND.test(e.text));
    const ahead = ev.filter((e) => (!shown || e.t < shown.t) && !REFUND.test(e.text)).map((e) => ({ ms: e.t - tE, text: e.text.slice(0, 100) }));
    const out = {
      plot: stand,
      chooser: !!chose,
      prompt,
      coinsBefore: c0,
      spentMs: spent ? spent.t - tE : null,
      coinsBackMs: back ? back.t - tE : null,
      refundCalledMs: call ? call.t - tE : null,
      refundShownMs: shown ? shown.t - tE : null,
      refundText: shown ? shown.text.slice(0, 120) : call ? call.text : null,
      ahead,
      toasts: toasts.map((x) => ({ ms: x.t - tE, text: x.text.slice(0, 100), hint: x.hint })),
    };
    out.lagMs = out.refundShownMs !== null && out.coinsBackMs !== null ? out.refundShownMs - out.coinsBackMs : null;
    t.data[prof] = out;
    t.check(`${prof}: the build was charged and refunded (the write blocked)`, out.spentMs !== null && out.coinsBackMs !== null ? true : null, { kind: stand.kind, spentMs: out.spentMs, coinsBackMs: out.coinsBackMs, prompt }, 'charged at E, coins back (the audit: 2.7 s)');
    t.check(`${prof}: the refund message within 0.5 s of the coins returning (D6)`, out.lagMs === null ? null : out.lagMs <= 500, { coinsBackMs: out.coinsBackMs, refundShownMs: out.refundShownMs, lagMs: out.lagMs, text: out.refundText }, '<= 500 ms (58c8849: coins 2.7 s, message 5.9 s)');
    t.check(`${prof}: what showed between E and the refund (reported)`, true, ahead.slice(0, 6), 'reported (58c8849: the 88-character talk hint)');
  }
}

module.exports = {
  build: { item: 'P2-E2d (GP-08; D6)', title: "a blocked build at a free plot: E to the coins' return and to the refund message on screen, and what queued ahead of it", profiles: ['desktop'], run: build },
};
