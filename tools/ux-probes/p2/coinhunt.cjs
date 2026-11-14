'use strict';
// p2/coinhunt: the meadow-coin economy, measured in the repo (P2-E2d; GP-04;
// P2-A9). The gameplay audit's g11.cjs was a session temp file and is gone,
// so this is rebuilt from phase2-audit/results/gameplay.json GP-04: a perfect
// coin hunter makes 13 coins a minute, and only 2 of the 80 meadow coins lie
// within 30 u of the spawn. With no Vercel Web Analytics baseline, this is
// P2-A9's in-repo economy before-number (beside p2/tour and p2/quests).
//
// Desktop, a fresh visitor on the default world (the seeded window: the seed
// golden's 80842 draws), the card dismissed, First steps skipped, then the
// frozen sim at 1/60 s, real keys:
//   trail   the arrival trail walked coin by coin (nearest first); the coin
//           total after it
//   hunt    3 simulated minutes from there: aim the chase camera at the
//           nearest standing meadow coin, hold W (at a walk, as the audit's
//           13/min was measured; `--run` also holds the run key,
//           html[data-run-key], else Space), re-aim every 0.25 s; a coin not
//           reached within 12 s is skipped. Coins per minute from the count.
//   near    meadow coins within 30 u (great-circle) of the spawn at the start
//
//   npm run probe -- p2/coinhunt [--minutes 3] [--run] --dist dist --port <n>
const lib = require('../lib.cjs');
const P = require('./play-lib.cjs');

/** Page-side: coin lists and the steering step. */
const HUNT_LIB = () => {
  const sc = window.__app.scene;
  const g = window.__g;
  // Standing coins in either shape (lib COIN_READ: today's meshes or B9's
  // records); null when the scene has neither, so the rate reads null.
  const list = (trail) => {
    const l = window.__uxCoin.list(sc, { trail });
    return l ? l.map(({ i, p }) => ({ i, p })) : null;
  };
  const H = (window.__hunt = {
    spawn: g.pos(),
    skip: new Set(),
    target: null,
    since: 0,
    list,
    near(trail) {
      const p = g.pos();
      const all = (list(trail) || []).filter((x) => !H.skip.has(x.i));
      all.sort((a, b) => g.arc(p, a.p) - g.arc(p, b.p));
      return all[0] || null;
    },
    /** Steer toward the nearest coin for n frames; returns the count. */
    step(n, trail) {
      const p = g.pos();
      if (!H.target || !(list(trail) || []).some((x) => x.i === H.target.i) || H.since > 12 * 60) {
        if (H.target && H.since > 12 * 60) H.skip.add(H.target.i);
        H.target = H.near(trail);
        H.since = 0;
      }
      if (!H.target) return { coins: sc.getCoinsCollected(), target: null };
      g.aimAt(H.target.p);
      window.__step(n, 1 / 60);
      H.since += n;
      return { coins: sc.getCoinsCollected(), target: H.target.i, d: +g.arc(p, H.target.p).toFixed(1) };
    },
  });
  const meadow = list(false);
  const trail = list(true);
  return {
    meadow: meadow ? meadow.length : null,
    trail: trail ? trail.length : null,
    within30: meadow ? meadow.filter((x) => g.arc(H.spawn, x.p) <= 30).length : null,
    seedDraws: typeof window.__dsSeedDraws === 'number' ? window.__dsSeedDraws : window.__dsSeedDraws && window.__dsSeedDraws.total ? window.__dsSeedDraws.total : null,
  };
};

async function coinhunt(t) {
  const minutes = Number(t.args.minutes || 3);
  for (const prof of t.profiles(['desktop'])) {
    const s = await t.session(prof, { clock: true });
    await t.boot(s);
    const { page } = s;
    await lib.dismissWelcome(page);
    await page.evaluate(() => {
      const g = window.__app.guide;
      if (g && typeof g.isActive === 'function' && g.isActive() && typeof g.skip === 'function') g.skip();
    });
    await lib.sleep(1500);
    await page.evaluate(P.HELPERS);
    const start = await page.evaluate(HUNT_LIB);
    const c0 = await page.evaluate(() => window.__app.scene.getCoinsCollected());
    await page.evaluate(lib.FREEZE);
    const run = String(t.args.run || '') === 'true' || t.args.run === true;
    const runKey = run ? ((await page.evaluate(() => document.documentElement.getAttribute('data-run-key'))) === 'shift' ? 'Shift' : ' ') : null;
    await page.keyboard.down('w');
    if (runKey) await page.keyboard.down(runKey);
    // The arrival trail first (up to 60 s of sim).
    let r = null;
    for (let f = 0; f < 60 * 60; f += 15) {
      r = await page.evaluate((n) => window.__hunt.step(n, true), 15);
      if (r.target === null) break;
    }
    const afterTrail = await page.evaluate(() => window.__app.scene.getCoinsCollected());
    const trailLeft = await page.evaluate(() => { const l = window.__hunt.list(true); return l ? l.length : null; });
    // The hunt.
    await page.evaluate(() => {
      window.__hunt.target = null;
      window.__hunt.skip.clear();
    });
    const frames = Math.round(minutes * 60 * 60);
    const trace = [];
    for (let f = 0; f < frames; f += 15) {
      r = await page.evaluate((n) => window.__hunt.step(n, false), 15);
      if (f % 600 === 0) trace.push({ s: Math.round(f / 60), coins: r.coins, d: r.d });
    }
    if (runKey) await page.keyboard.up(runKey);
    await page.keyboard.up('w');
    const end = await page.evaluate(() => ({ coins: window.__app.scene.getCoinsCollected(), skipped: window.__hunt.skip.size }));
    await page.evaluate(lib.THAW);
    await t.shot(page, `p2-coinhunt-${prof}.png`);
    await s.close();
    const hunted = end.coins - afterTrail;
    const out = { start, coinsAtStart: c0, afterTrail, trailLeft, minutes, hunted, perMin: lib.round(hunted / minutes, 1), skipped: end.skipped, gait: runKey === null ? 'walk' : runKey === ' ' ? 'run (Space)' : 'run (Shift)', trace };
    t.data[prof] = out;
    t.check(`${prof}: coins per minute, a perfect meadow hunter (P2-A9 baseline)`, hunted > 0 ? true : null, out.perMin, 'reported (the audit: 13/min)');
    t.check(`${prof}: meadow coins within 30 u of the spawn (reported)`, start.meadow ? true : null, `${start.within30} of ${start.meadow}`, 'reported (the audit: 2 of 80)');
    t.check(`${prof}: the coin total after the arrival trail (reported)`, trailLeft === 0 && start.trail > 0 ? true : null, { afterTrail, trailCoins: start.trail, left: trailLeft }, 'reported (p2/tour reads 5 on fcaa649)');
  }
}

module.exports = {
  coinhunt: { item: 'P2-E2d (GP-04; P2-A9)', title: 'the in-repo economy baseline: the arrival trail, then 3 simulated minutes of a perfect nearest-meadow-coin hunter on the frozen sim', profiles: ['desktop'], run: coinhunt },
};
