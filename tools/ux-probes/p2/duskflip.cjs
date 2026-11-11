'use strict';
// p2/duskflip (P2-E1a, from the lighting audit's duskflip.cjs): the dusk
// light-count flip at runtime. A visitor playing through dusk crosses the
// exterior-lights cutoff once, and every lit program re-links for the night
// set. Boot at ?hour=17 (the day set), let the interior warm finish (13 s),
// then move the clock to 17.5 h through EnvironmentCycle.debugHour and record
// the long tasks of the next 6 s. A fresh browser per run.
//
//   npm run probe -- p2/duskflip [--reps 1] [--device desk|phone] --dist dist --port <n>
//
// P2-B6 and P2-C4's bar: no long task of 100 ms or more crossing 17:00 to 17:30.
const R = require('./room-lib.cjs');

const LIGHTS_NOW = () => {
  const c = {};
  window.__app.scene.traverseVisible((o) => {
    if (o.isLight) c[o.type] = (c[o.type] || 0) + 1;
  });
  return { lights: c, programs: window.__app.renderer.getRenderer().info.programs.length, day: +window.__app.scene.getEnvironmentCycle().getDayFactor().toFixed(3), hour: +window.__app.scene.getEnvironmentCycle().getHour().toFixed(2) };
};

async function duskflip(t) {
  const reps = Number(t.args.reps || 1);
  const runs = [];
  for (let rep = 0; rep < reps; rep++) {
    for (const prof of t.profiles(['desktop', 'phone'])) {
      const s = await t.freshSession(prof, { init: [R.LONGTASKS_INIT] });
      const { page } = s;
      const row = { prof, rep };
      try {
        await t.boot(s, { query: 'hour=17' });
        await page.click(`[role=dialog][aria-label="Welcome to DigiScalability Life Island"] button[data-dismiss]`).catch(() => {});
        await page.waitForTimeout(13000);
        row.before = await page.evaluate(LIGHTS_NOW);
        const t0 = await page.evaluate(() => {
          window.__app.scene.getEnvironmentCycle().debugHour = 17.5;
          return performance.now();
        });
        await page.waitForTimeout(6000);
        row.after = await page.evaluate(LIGHTS_NOW);
        const lt = await page.evaluate((x) => {
          const L = window.__lt || { longtasks: [], loaf: [], gaps: [] };
          const after = (a) => a.filter(([st]) => st >= x - 50).map((e) => e[1]);
          return { longtasks: after(L.longtasks), loaf: after(L.loaf), gaps: after(L.gaps) };
        }, t0);
        row.longTasks = lt.longtasks;
        row.longAnimationFrames = lt.loaf;
        row.frameGaps = lt.gaps;
        // The longest of the three views of the same freeze.
        row.longestMs = Math.max(0, ...lt.longtasks, ...lt.loaf, ...lt.gaps);
        await t.shot(page, `duskflip-${prof}-${rep}.png`);
      } catch (e) {
        row.error = String(e).slice(0, 200);
      }
      runs.push(row);
      await s.close();
      t.check(`${prof}${reps > 1 ? ` #${rep + 1}` : ''}: the longest task crossing 17:00 to 17:30 (ms)`, row.error ? null : row.longestMs < 100, row.error || `${row.longestMs} (lights ${JSON.stringify(row.before.lights)} -> ${JSON.stringify(row.after.lights)}, programs ${row.before.programs} -> ${row.after.programs})`, '< 100');
    }
  }
  t.data.runs = runs;
}

module.exports = {
  duskflip: { item: 'P2-E1a (LT-03, P2-B6, P2-C4)', title: 'the dusk flip: ?hour=17, then debugHour 17.5 after the warm; long tasks of the next 6 s', profiles: ['desktop', 'phone'], run: duskflip },
};
