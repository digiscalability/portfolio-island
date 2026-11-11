'use strict';
// Stage-2 probes, part 2 (E6b): lum. The design audit's lum.cjs was a session
// temp file and is gone, so this is rebuilt from its report
// (docs/history/2026-11-03-ux-audit/design.json: DA-02, DA-03, DA-13) on
// p2/L.cjs's exact masks (the audit averaged boxes, which mixed ground into
// the player's number), and checked against what it recorded on 58c8849.
//
//   npm run probe -- lum [--hours 6,12,18,21] [--profile desktop|phone] --dist dist --port <n>
//
// At ?hour=6/12/18/21, on 1440 and on 390 (the low tier):
// - the hub-wide frame: ground and sky L*, and the sky-to-ground luminance ratio;
// - the shore frame, looking out to sea: the open sea's L*, mean colour and
//   hue, and the luminance step across the horizon row (the sky just above
//   the sea against the sea just below it).
// C1's bar: ground 40 or more at 06 and 18 h, sky to ground 3:1 or less.
// C2's: sea hue 195-215 degrees, daytime L* 32-45, the step across the
// horizon 4 L* or less. P2-B4's: the phone's sky within 3 L* of desktop's.
const fs = require('fs');
const path = require('path');
const lib = require('./lib.cjs');
const L = require('./p2/L.cjs');
const W = require('./p2/light.cjs');

const HOURS = [6, 12, 18, 21];

/** The step across the horizon: per column, the sky's last rows against the sea's first rows. */
function horizonStep(normalFile, maskFile) {
  const A = L.readPNG(normalFile);
  const M = L.readPNG(maskFile);
  const band = Math.max(4, Math.round(A.height / 150));
  const steps = [];
  let rowSum = 0;
  for (let x = 4; x < A.width - 4; x += 4) {
    // The lowest sky pixel with sea straight below it.
    let ys = -1;
    for (let y = A.height - 2 - band * 2; y > band; y--) {
      if (L.classify(M, x, y) === 'sky' && L.classify(M, x, y + 2) === 'sea') {
        ys = y;
        break;
      }
    }
    if (ys < 0) continue;
    let sky = 0;
    let sea = 0;
    let ns = 0;
    let nw = 0;
    for (let k = 1; k <= band; k++) {
      if (L.classify(M, x, ys - k) === 'sky') {
        sky += L.lumAt(A, ((ys - k) * A.width + x) * 4);
        ns++;
      }
      if (L.classify(M, x, ys + 2 + k) === 'sea') {
        sea += L.lumAt(A, ((ys + 2 + k) * A.width + x) * 4);
        nw++;
      }
    }
    if (!ns || !nw) continue;
    steps.push(Math.abs(L.Lstar(sky / ns) - L.Lstar(sea / nw)));
    rowSum += ys;
  }
  if (steps.length < 10) return { columns: steps.length, stepL: null };
  steps.sort((a, b) => a - b);
  return { columns: steps.length, stepL: +steps[Math.floor(steps.length / 2)].toFixed(1), p90: +steps[Math.floor(steps.length * 0.9)].toFixed(1), horizonRow: Math.round(rowSum / steps.length) };
}

async function lum(t) {
  const hours = t.args.hours && t.args.hours !== true ? String(t.args.hours).split(',').map(Number) : HOURS;
  const profiles = t.profiles(['desktop', 'phone']);
  const rows = {};
  for (const prof of profiles) {
    const s = await W.openWorld(t, prof, t.base);
    const { page } = s;
    rows[prof] = {};
    for (const h of hours) {
      if ((await page.evaluate(W.SET_HOUR, h)) === null) throw new Error('hook missing: EnvironmentCycle.debugHour');
      await page.waitForTimeout(1600);
      const row = {};
      for (const view of ['hub', 'beach']) {
        const where = await page.evaluate(W.VIEW, W.viewArg(view));
        if (!where) continue;
        await page.waitForTimeout(700);
        const stem = path.join(t.out, `lum-${prof}-h${h}-${view === 'beach' ? 'sea' : view}`);
        const pair = await L.capturePair(page, stem, { hideUi: true, zones: true });
        const st = L.frameStats(pair.a, pair.m);
        const c = st.cats;
        if (view === 'hub') {
          row.ground = (c.groundAll || {}).Lstar ?? null;
          row.sky = (c.sky || {}).Lstar ?? null;
          row.skyToGround = c.sky && c.groundAll && c.groundAll.Y ? +(c.sky.Y / c.groundAll.Y).toFixed(2) : null;
          row.player = (c.player || {}).Lstar ?? null;
        } else {
          row.sea = c.sea ? { Lstar: c.sea.Lstar, rgb: c.sea.rgb, ...L.hueOf(c.sea.rgb), share: c.sea.frac } : null;
          row.seaSky = (c.sky || {}).Lstar ?? null;
          row.horizon = horizonStep(pair.a, pair.m);
        }
        fs.rmSync(pair.m, { force: true });
        t.data.frames = [...(t.data.frames || []), pair.a];
      }
      rows[prof][h] = row;
      t.log(`${prof} ${h} h: ${JSON.stringify(row)}`);
    }
    await page.evaluate(W.SET_HOUR, null);
    await s.close();
  }
  t.data.rows = rows;
  const have = (h) => hours.includes(h);
  for (const prof of profiles) {
    const r = rows[prof];
    for (const h of [6, 18].filter(have)) {
      t.check(`${prof}: hub ground at ${h} h (L*)`, r[h].ground !== null ? r[h].ground >= 40 : null, r[h].ground, '>= 40');
      t.check(`${prof}: sky to ground luminance at ${h} h`, r[h].skyToGround !== null ? r[h].skyToGround <= 3 : null, r[h].skyToGround, '<= 3:1');
    }
    const seaHues = hours.filter((h) => r[h].sea && r[h].sea.hue !== null).map((h) => [h, r[h].sea.hue]);
    const off = seaHues.filter(([, hue]) => hue < 195 || hue > 215).map(([h, hue]) => `${h} h: ${hue}`);
    t.check(`${prof}: the open sea's hue at ${seaHues.map(([h]) => h).join('/')} h (degrees)`, seaHues.length ? off.length === 0 : null, off.length ? off : seaHues.map(([h, hue]) => `${h} h: ${hue}`), '195-215');
    if (have(12) && r[12].sea) t.check(`${prof}: the open sea at noon (L*)`, r[12].sea.Lstar >= 32 && r[12].sea.Lstar <= 45, r[12].sea.Lstar, '32-45');
    const steps = hours.filter((h) => r[h].horizon && r[h].horizon.stepL !== null).map((h) => [h, r[h].horizon.stepL]);
    const worst = steps.slice().sort((a, b) => b[1] - a[1])[0];
    t.check(`${prof}: the luminance step across the horizon row (worst hour, L*)`, worst ? worst[1] <= 4 : null, worst ? `${worst[1]} at ${worst[0]} h (${steps.map(([h, v]) => `${h} h ${v}`).join(', ')})` : 'no sea horizon in view', '<= 4');
  }
  if (profiles.includes('desktop') && profiles.includes('phone')) {
    const d = hours.filter((h) => rows.desktop[h].sky !== null && rows.phone[h].sky !== null).map((h) => [h, +(rows.phone[h].sky - rows.desktop[h].sky).toFixed(1)]);
    const worst = d.slice().sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))[0];
    t.check('the phone sky against desktop, hub (worst hour, L*)', worst ? Math.abs(worst[1]) <= 3 : null, worst ? `${worst[1]} at ${worst[0]} h (${d.map(([h, v]) => `${h} h ${v}`).join(', ')})` : 'no sky', 'within +-3');
  }
}

module.exports = {
  lum: { item: 'E6b (DA-02, DA-03; C1, C2, P2-B4)', title: 'ground, sky and sea L* by exact masks at 6, 12, 18 and 21 h on 1440 and 390: the sky-to-ground ratio, the sea hue, the step across the horizon row', profiles: ['desktop', 'phone'], run: lum },
};
