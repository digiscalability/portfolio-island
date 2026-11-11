'use strict';
// p2/walkin (P2-E1a, from the interiors audit's walkin.cjs). A visitor walks
// straight up to a door (the joystick on a phone, through trusted CDP
// touches; W on a keyboard) and enters the moment its prompt shows, with no
// standing still near the door. The default run, after 12 s on the island:
// Professional (the session's first door), Projects, then a cottage after
// standing still 2 s at its door. Each entry records the programs it adds,
// the longest frame and the black veil (fade opacity >= 0.95).
//
//   npm run probe -- p2/walkin --device phone [--cpu 4] [--runs 3] [--hour 12] --dist dist --port <n>
//
// --cpu 4 (CO-A5): CPU throttled 4x through CDP from the first byte; the
// visitor taps Explore on the card and enters the Welcome Hub 2.5 s after the
// card appeared; median of --runs runs (default 3), each in a fresh browser.
// As the integration measured it: the recorders and the touch session are
// set up before the card, Explore is tapped the moment the card shows, the
// visitor is put 2 u out on the hall's door axis 1 s after the card (in
// place of most of the ~14 m walk), walks the rest, and taps USE when the
// prompt shows, not before 2.5 s. pressAfterCardMs is the press itself; a
// median outside 2.5-4 s makes the run inconclusive.
const lib = require('../lib.cjs');
const R = require('./room-lib.cjs');

const median = (xs) => lib.median(xs.filter((x) => typeof x === 'number'));

async function visit(page, id, touch, T, { standStillMs = 0, beforePress = null, fromCard = false } = {}) {
  // fromCard: the session's first seconds, so nothing to leave and no camera
  // to let settle; 2 u out on the door axis (the prompt's edge) and one
  // in-page wait for the prompt.
  if (!fromCard) await R.outdoors(page);
  const e = await R.enterRoom(page, id, { touch, T, back: fromCard ? 2.0 : 5.0, settleMs: fromCard ? 50 : 700, fastPrompt: fromCard, standStillMs, beforePress, record: true });
  await page.waitForTimeout(3000);
  const fr = await page.evaluate(() => window.__ia.stop());
  const p1 = await R.programs(page);
  const tr = R.transition(fr, e.p0);
  return { id, walkMs: e.walkMs, press: e.press, pressAt: e.pressAt, standStillMs, nearDoorWarmBeforeE: e.nearDoorWarmBeforeE, inside: tr.inside, programsAdded: p1 - e.p0, maxDt: tr.maxDt, over50: tr.over50, blackMs: tr.blackMs, rtPass: tr.rtPass, firstInsideAt: tr.firstInsideAtMs };
}

async function cpuSession(t, prof, cpu, fresh) {
  const opts = { init: [R.REWARD_INIT, R.WELCOME_MARK_INIT] };
  const s = fresh ? await t.freshSession(prof, opts) : await t.session(prof, opts);
  if (cpu > 1) {
    const cdp = await s.ctx.newCDPSession(s.page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpu });
  }
  return s;
}

async function walkin(t) {
  const hour = String(t.args.hour || '12');
  const cpu = Number(t.args.cpu || 1);
  for (const prof of t.profiles(['phone'])) {
    const touch = lib.isTouchProfile(prof);
    if (cpu > 1) {
      // CO-A5: the Welcome Hub, 2.5 s after the card, at cpu x.
      const runs = Number(t.args.runs || 3);
      const rows = [];
      for (let i = 0; i < runs; i++) {
        const s = await cpuSession(t, prof, cpu, true);
        const { page } = s;
        const T = touch ? await lib.touch(s) : null;
        // Everything that can happen before the card does (the recorders, the
        // touch session), so only the walk itself lies between the card and E.
        await t.boot(s, { query: `hour=${hour}`, waitWelcome: false });
        await R.install(page);
        // The card as the page saw it, and its Explore button, in one round
        // trip; then a trusted tap there (no actionability waits at 4x).
        const sel = `${lib.WELCOME} button[data-dismiss]`;
        await page.waitForFunction((q) => window.__welcomeAt !== null && !!document.querySelector(q), sel, { timeout: 120000, polling: 50 });
        const card = await page.evaluate((q) => {
          const r = document.querySelector(q).getBoundingClientRect();
          return { at: window.__welcomeAt, xy: [r.left + r.width / 2, r.top + r.height / 2] };
        }, sel);
        const cardAt = card.at;
        if (touch) await T.tap(card.xy[0], card.xy[1]);
        else await page.mouse.click(card.xy[0], card.xy[1]);
        await lib.sleep(200);
        if (await page.evaluate(() => window.__app.ui.isWelcomeVisible())) await lib.dismissWelcome(page);
        // The hall is ~14 m from the spawn, about 2.5 s on foot, so the
        // visitor is at its door 2.5 s after the card (the integration's
        // protocol: a stand-in for the walk, then E within ~150 ms). At 4x the
        // approach itself (onto the door axis, the last steps to the prompt,
        // the tap) takes 1.3-2.4 s, so it starts 1 s after the card, and E
        // waits for 2.5 s if the visitor gets there first.
        const untilAfterCard = async (ms) => {
          for (;;) {
            const now = await page.evaluate(() => performance.now());
            if (cardAt === null || now - cardAt >= ms) break;
            await lib.sleep(Math.min(100, ms - (now - cardAt)));
          }
        };
        await untilAfterCard(1000);
        const v = await visit(page, 'welcome', touch, T, { fromCard: true, beforePress: () => untilAfterCard(2500) });
        // The press itself (enterRoom stamps it), not the end of the visit.
        v.pressAfterCardMs = cardAt === null || typeof v.pressAt !== 'number' ? null : Math.round(v.pressAt - cardAt);
        rows.push(v);
        await t.shot(page, `walkin-${prof}-cpu${cpu}-run${i + 1}.png`);
        await s.close();
      }
      const m = { programsAdded: median(rows.map((x) => x.programsAdded)), maxDt: median(rows.map((x) => x.maxDt)), blackMs: median(rows.map((x) => x.blackMs)), pressAfterCardMs: median(rows.map((x) => x.pressAfterCardMs)) };
      t.data[`${prof}-cpu${cpu}`] = { runs: rows, median: m };
      // The scenario is E 2.5 s after the card; a press much later is a
      // different visit, so the run does not count (inconclusive, not a fail).
      const onTime = m.pressAfterCardMs !== null && m.pressAfterCardMs >= 2500 && m.pressAfterCardMs <= 4000;
      t.check(`${prof} at ${cpu}x: E pressed 2.5-4 s after the card (median, ms)`, onTime ? true : null, m.pressAfterCardMs, '2500-4000');
      t.check(`${prof} at ${cpu}x, the Welcome Hub 2.5 s after the card: programs added (median of ${runs})`, m.programsAdded !== null && m.programsAdded <= 3, m.programsAdded, '<= 3');
      t.check(`${prof} at ${cpu}x: longest frame on entry (median, ms)`, m.maxDt !== null && m.maxDt <= 200, m.maxDt, '<= 200');
      t.check(`${prof} at ${cpu}x: black veil (median, ms)`, m.blackMs !== null && m.blackMs <= 800, m.blackMs, '<= 800');
      continue;
    }
    const s = await cpuSession(t, prof, 1, false);
    const { page } = s;
    const T = touch ? await lib.touch(s) : null;
    await t.boot(s, { query: `hour=${hour}` });
    await R.install(page);
    if (touch) await page.tap(`${lib.WELCOME} button[data-dismiss]`).catch(() => lib.dismissWelcome(page));
    else await lib.dismissWelcome(page);
    // A visitor who has been on the island ~12 s (the idle warm has had its chance).
    await page.waitForTimeout(12000);
    const visits = [];
    visits.push(await visit(page, 'professional', touch, T));
    await t.shot(page, `walkin-${prof}-professional.png`);
    visits.push(await visit(page, 'projects', touch, T));
    visits.push(await visit(page, 'house_0', touch, T, { standStillMs: 2000 }));
    t.data[prof] = { hour, visits };
    const first = visits[0];
    // INT-01's bar for the walk-straight-in first door at 1x.
    t.check(`${prof}: the walk-straight-in first door (Professional) adds programs`, first.programsAdded <= 3, first.programsAdded, '<= 3');
    t.check(`${prof}: the first door's longest frame (ms)`, first.maxDt !== null && first.maxDt <= 100, first.maxDt, '<= 100');
    t.check(`${prof}: the first door's black veil (ms)`, first.blackMs <= 600, first.blackMs, '<= 600');
    t.check(`${prof}: every visit ends inside its room`, visits.every((x) => x.inside), visits.map((x) => `${x.id} ${x.inside ? 'in' : 'OUT'} (${x.press})`), 'all inside');
  }
}

module.exports = {
  walkin: { item: 'P2-E1a (INT-01, CO-A5)', title: 'walk straight in: the first door, a later door and a cottage; --cpu 4 enters the Welcome Hub 2.5 s after the card', profiles: ['phone'], run: walkin },
};
