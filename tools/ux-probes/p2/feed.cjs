'use strict';
// p2/feed: bird feed at night (P2-E2d; GP-13; P2-A10). The gameplay audit's
// g4c.cjs was a session temp file and is gone, so this is rebuilt from
// phase2-audit/results/gameplay.json GP-13: at ?hour=21, F with bird feed over
// the open hub lawn flashed 'Not here — try over open ground' and the feed
// was not spent (GameScene.throwBirdFeed refuses when dayFactor < 0.3); at
// noon 8 birds landed around the pile within 6 s.
//
// Desktop, the welcome card dismissed and First steps skipped, at the spawn
// on the hub lawn with no cat in aim. Every ui.flashMessage is recorded
// (wrapped, observed). The feed counts are the persisted ones
// (localStorage ds_bird_feed / ds_cat_feed), seeded per session.
//   night    ?hour=21, bird feed only: the flash text (P2-A10: /roost/i), the
//            bird-feed count before and after (unchanged), the day factor
//   cat      ?hour=21, bird and cat feed held: a cat throw happens (the
//            cat-feed count drops by 1)
//   noon     ?hour=12, bird feed only: the throw spends one, birds within
//            2 u of the pile 6 s later (the audit: 8)
//
//   npm run probe -- p2/feed --dist dist --port <n>
const lib = require('../lib.cjs');

const FLASH_LOG = () => {
  const ui = window.__app.ui;
  const L = (window.__flash = []);
  if (typeof ui.flashMessage === 'function' && !ui.flashMessage.__probe) {
    const orig = ui.flashMessage;
    const w = function (text) {
      L.push({ t: performance.now(), text: String(text).slice(0, 160) });
      return orig.apply(this, arguments);
    };
    w.__probe = true;
    ui.flashMessage = w;
  }
  return true;
};
const READ = () => {
  const sc = window.__app.scene;
  const ls = (k) => {
    const v = localStorage.getItem(k);
    return v === null ? null : +v;
  };
  const env = sc.getEnvironmentCycle ? sc.getEnvironmentCycle() : null;
  return { bird: ls('ds_bird_feed'), cat: ls('ds_cat_feed'), dayFactor: env && env.getDayFactor ? +env.getDayFactor().toFixed(3) : null, hour: env && env.getHour ? +env.getHour().toFixed(2) : null, flashes: (window.__flash || []).map((f) => f.text) };
};
/** Remember where the newest feed pile lands (the pile may be eaten away by 6 s). */
const MARK_PILE = () => {
  const sc = window.__app.scene;
  const piles = sc.feedPiles || [];
  const p = piles[piles.length - 1];
  window.__pileAt = p ? (p.to || p.pile.position).clone() : null;
  return !!p;
};
/** Ground birds within 2 u of where the pile landed. */
const BIRDS_AT_PILE = () => {
  const sc = window.__app.scene;
  const at = window.__pileAt;
  if (!at) return { pile: false, birds: null };
  const birds = (sc.groundBirds || []).filter((g) => g.curPos && g.curPos.distanceTo(at) < 2).length;
  return { pile: true, birds };
};

async function one(t, prof, { hour, bird, cat }) {
  const s = await t.session(prof, { localStorage: { ds_bird_feed: String(bird), ds_cat_feed: String(cat) } });
  await t.boot(s, { query: `hour=${hour}` });
  const { page } = s;
  await lib.dismissWelcome(page);
  await page.evaluate(() => {
    const g = window.__app.guide;
    if (g && typeof g.isActive === 'function' && g.isActive() && typeof g.skip === 'function') g.skip();
  });
  await lib.sleep(1500);
  await page.evaluate(FLASH_LOG);
  const before = await page.evaluate(READ);
  await page.keyboard.press('f');
  await lib.sleep(1200);
  const after = await page.evaluate(READ);
  const marked = await page.evaluate(MARK_PILE);
  const r = { hour, before, after, flash: after.flashes.slice(-1)[0] || null, pileThrown: marked };
  if (hour === 12) {
    await lib.sleep(4800);
    r.pile = await page.evaluate(BIRDS_AT_PILE);
  }
  await t.shot(page, `p2-feed-${prof}-h${hour}-${cat ? 'cat' : 'bird'}.png`);
  await s.close();
  return r;
}

async function feed(t) {
  for (const prof of t.profiles(['desktop'])) {
    const night = await one(t, prof, { hour: 21, bird: 3, cat: 0 });
    const cat = await one(t, prof, { hour: 21, bird: 3, cat: 2 });
    const noon = await one(t, prof, { hour: 12, bird: 3, cat: 0 });
    t.data[prof] = { night, cat, noon };
    const nightOk = night.before.dayFactor !== null && night.before.dayFactor < 0.3;
    t.check(`${prof}: 21 h, bird feed: the message says the birds roost (P2-A10)`, nightOk ? /roost/i.test(night.flash || '') : null, { flash: night.flash, dayFactor: night.before.dayFactor }, "/roost/i (58c8849 and fcaa649: '🌾 Not here — try over open ground')");
    t.check(`${prof}: 21 h, bird feed: the bird-feed count is unchanged`, nightOk ? night.after.bird === night.before.bird : null, `${night.before.bird} -> ${night.after.bird}`, 'unchanged');
    t.check(`${prof}: 21 h, with cat feed held: a cat throw happens (P2-A10)`, nightOk ? cat.after.cat === cat.before.cat - 1 : null, { cat: `${cat.before.cat} -> ${cat.after.cat}`, bird: `${cat.before.bird} -> ${cat.after.bird}`, flash: cat.flash }, 'the cat-feed count drops by 1');
    t.check(`${prof}: 12 h control: the throw spends one and birds land within 6 s`, noon.after.bird === noon.before.bird - 1 && noon.pile && noon.pile.birds !== null && noon.pile.birds >= 1, { bird: `${noon.before.bird} -> ${noon.after.bird}`, pile: noon.pile, flash: noon.flash }, 'spent, birds at the pile (the audit: 8)');
  }
}

module.exports = {
  feed: { item: 'P2-E2d (GP-13; P2-A10)', title: 'bird feed at 21 h: the message, the persisted counts, the cat throw with cat feed held, the noon control', profiles: ['desktop'], run: feed },
};
