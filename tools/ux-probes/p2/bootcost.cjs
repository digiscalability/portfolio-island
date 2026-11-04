'use strict';
// p2/bootcost (P2-E1a, from the lighting audit's bootcost.cjs): the boot cost
// of the night light set. A fresh browser per boot (a cold GPU program
// cache), alternating ?hour=12 and ?hour=21, on desktop and the phone: the
// time to the welcome card, the long tasks before it, the programs at the
// card and the visible lights.
//
//   npm run probe -- p2/bootcost [--reps 3] [--hours 12,21] [--device desk|phone] --dist dist --port <n>
//
// P2-B6 and P2-C4's bar: the ?hour=21 card arrives within +300 ms of the
// ?hour=12 card on both tiers (medians).
const lib = require('../lib.cjs');
const R = require('./room-lib.cjs');

const AT_CARD = () => {
  const lt = ((window.__lt && window.__lt.longtasks) || []).filter(([st]) => window.__welcomeAt !== null && st < window.__welcomeAt);
  const lights = {};
  window.__app.scene.traverseVisible((o) => {
    if (o.isLight) lights[o.type] = (lights[o.type] || 0) + 1;
  });
  return {
    welcomeMs: window.__welcomeAt === null ? null : Math.round(window.__welcomeAt),
    longTasksBeforeCard: lt.length,
    longestBeforeCardMs: lt.reduce((a, [, d]) => Math.max(a, d), 0),
    sumLongBeforeCardMs: lt.reduce((a, [, d]) => a + d, 0),
    programs: window.__app.renderer.getRenderer().info.programs.length,
    lights,
  };
};

async function bootcost(t) {
  const reps = Number(t.args.reps || 3);
  const hours = String(t.args.hours || '12,21').split(',').map(Number);
  const runs = [];
  for (let rep = 0; rep < reps; rep++) {
    for (const prof of t.profiles(['desktop', 'phone'])) {
      for (const h of rep % 2 === 0 ? hours : [...hours].reverse()) {
        const s = await t.freshSession(prof, { init: [R.WELCOME_MARK_INIT, R.LONGTASKS_INIT] });
        const row = { prof, h, rep };
        try {
          await t.boot(s, { query: `hour=${h}` });
          Object.assign(row, await s.page.evaluate(AT_CARD));
        } catch (e) {
          row.error = String(e).slice(0, 200);
        }
        runs.push(row);
        t.log(JSON.stringify(row));
        await s.close();
      }
    }
  }
  const summary = {};
  for (const r of runs.filter((x) => !x.error)) (summary[`${r.prof}-h${r.h}`] = summary[`${r.prof}-h${r.h}`] || []).push(r);
  const med = (xs) => lib.median(xs);
  const sum = {};
  for (const [k, rs] of Object.entries(summary)) sum[k] = { n: rs.length, welcomeMs: med(rs.map((r) => r.welcomeMs)), longestBeforeCardMs: med(rs.map((r) => r.longestBeforeCardMs)), programs: med(rs.map((r) => r.programs)), all: rs.map((r) => r.welcomeMs) };
  t.data.runs = runs;
  t.data.summary = sum;
  for (const prof of t.profiles(['desktop', 'phone'])) {
    const a = sum[`${prof}-h${hours[0]}`];
    const b = sum[`${prof}-h${hours[hours.length - 1]}`];
    const d = a && b && a.welcomeMs !== null && b.welcomeMs !== null ? Math.round(b.welcomeMs - a.welcomeMs) : null;
    t.data[`${prof}DeltaMs`] = d;
    t.check(`${prof}: the ?hour=${hours[hours.length - 1]} card against the ?hour=${hours[0]} card (median, ms)`, d !== null ? d <= 300 : null, d === null ? 'missing runs' : `${d} (${a.welcomeMs} vs ${b.welcomeMs})`, '<= +300');
  }
}

module.exports = {
  bootcost: { item: 'P2-E1a (LT-03, P2-B6, P2-C4)', title: 'boot cost of the night light set: ?hour=12 vs ?hour=21 cards, a fresh browser per boot', profiles: ['desktop', 'phone'], run: bootcost },
};
