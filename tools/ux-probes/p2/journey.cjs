'use strict';
// p2/journey (P2-E2a, from the guidance audit's curious2.cjs): the curious
// ten-minute visitor, who follows only the island's own guidance from
// Explore. The backend stays blocked, so villager replies take the written
// fallback.
//
//   npm run probe -- p2/journey [--scenario follow,mappick] [--profile desktop|phone] [--cap 540] --dist dist --port <n>
//
// follow: Explore, walk the trail coins, talk to the trail's villager, then
//   follow the compass wherever it points (districts, deliveries), entering
//   each district hall it leads to; after two deliveries, switch to the island
//   map for the next unstamped district. Stops at four stamps or --cap s.
//   Logged: the pill's label over time, each passport stamp and when, each
//   map pick and whether that district's door prompt was up at its end.
// mappick: a map pick of each district in turn (M, or a tap on the compass,
//   then the district's chip), followed to its end.
//
// A7's bar, at 1440x900 and 390x844 touch: all four halls entered within 6
// minutes; after each of stamps 1-3 the pill names a district within 1 s; a
// map pick of each district ends with its door prompt up and the pill still
// on it.
const lib = require('../lib.cjs');
const G = require('./guide-lib.cjs');

const DISTRICTS = [
  { id: 'projects', re: /project/i, chip: /Project Portfolio|Projects/ },
  { id: 'professional', re: /professional/i, chip: /Professional/ },
  { id: 'personal', re: /personal/i, chip: /Personal/ },
  { id: 'contact', re: /contact|get in touch/i, chip: /Get In Touch|Contact/ },
];
const isDistrictLabel = (l) => DISTRICTS.some((d) => d.re.test(l || ''));
const strip = (l) => (l || '').replace(/\s*•?\s*[\d.]+m$/, '').trim();
const DOOR = /(Press E|Tap 👆 USE|Tap USE) to enter/;

async function press(page, touch, xy) {
  if (touch) await page.touchscreen.tap(xy[0], xy[1]);
  else await page.mouse.click(xy[0], xy[1]);
}
async function pressFn(page, touch, fn, arg) {
  const r = await page.evaluate(fn, arg);
  if (!r) return false;
  await press(page, touch, r);
  return true;
}

async function explore(page, touch) {
  const sel = `${lib.WELCOME} button[data-dismiss]`;
  if (touch) await page.tap(sel).catch(() => page.click(sel));
  else await page.click(sel);
  return G.ptime(page);
}

/** The First-steps guide (A6), when this build has one, steps aside: Skip. */
async function skipGuide(page, touch) {
  await lib.sleep(900);
  return pressFn(page, touch, () => {
    const g = document.getElementById('ds-guide');
    const b = g && [...g.querySelectorAll('button,[role=button]')].find((x) => /skip/i.test(`${x.getAttribute('aria-label') || ''} ${x.textContent || ''}`));
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return [r.left + r.width / 2, r.top + r.height / 2];
  });
}

async function closeZonePanel(page, touch) {
  await page.evaluate(() => {
    const p = window.__app.ui.zonePanelDiv;
    if (p) p.scrollTop = 0;
  });
  await lib.sleep(250);
  const ok = await pressFn(page, touch, () => {
    const p = window.__app.ui.zonePanelDiv;
    const el = p && p.querySelector('button[aria-label="Close"]');
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return [b.left + b.width / 2, b.top + b.height / 2];
  });
  if (!ok) await page.evaluate(() => window.__app.ui.panels.closeTop());
}
async function leaveBuilding(page, touch) {
  const ok = await pressFn(page, touch, () => {
    const ui = window.__app.ui;
    const el = ui.leaveBtn || [...document.querySelectorAll('#ui-overlay > div')].find((d) => (d.textContent || '').trim() === '← Leave');
    if (!el || !el.isConnected) return null;
    const b = el.getBoundingClientRect();
    return [b.left + b.width / 2, b.top + b.height / 2];
  });
  if (!ok) await page.evaluate(() => window.__app.scene.isInsideInterior() && window.__app.exitBuilding(window.__app.insideIsZone));
}
/** Step 7 u from the current spot toward the pole hub (off the doorstep). */
async function stepOff(page) {
  const tgt = await page.evaluate(() => {
    const P = window.__app.scene.getPlayer().getWorldPosition();
    const pole = P.clone().set(0, P.length(), 0);
    const d = pole.sub(P);
    if (d.length() < 1) return null;
    return P.clone().add(d.normalize().multiplyScalar(7)).toArray();
  });
  if (tgt) await G.walkTo(page, tgt, 4000, 1.0);
}
async function openMapPick(page, touch, chipRe) {
  if (touch) {
    const tapped = await pressFn(page, true, () => {
      const d = window.__app.ui.compassDiv;
      if (!d || d.style.display === 'none') return null;
      const b = d.getBoundingClientRect();
      return [b.left + b.width / 2, b.top + b.height / 2];
    });
    if (!tapped) await page.keyboard.press('m');
  } else await page.keyboard.press('m');
  await lib.sleep(900);
  const ok = await pressFn(
    page,
    touch,
    (src) => {
      const re = new RegExp(src);
      const ov = document.getElementById('ui-overlay');
      const m = [...ov.children].reverse().find((d) => /Island map/i.test(d.textContent || ''));
      if (!m) return null;
      const b = [...m.querySelectorAll('button')].find((x) => re.test(x.textContent));
      if (!b) return null;
      b.scrollIntoView({ block: 'center' });
      const r = b.getBoundingClientRect();
      return [r.left + r.width / 2, r.top + r.height / 2];
    },
    chipRe.source,
  );
  await lib.sleep(700);
  if (await page.evaluate(() => window.__app.ui.panels.current() === 'island-map')) await page.evaluate(() => window.__app.ui.panels.closeTop());
  return ok;
}

async function enterAndRead(t, page, touch, leg, tag) {
  if (touch) {
    const s = await lib.touch({ page, ctx: page.context() });
    const u = await s.useBtn();
    if (u) await s.tap(u[0], u[1]);
    else await page.keyboard.press('e');
  } else await page.keyboard.press('e');
  await lib.sleep(2800);
  leg.inside = await page.evaluate(() => {
    const ui = window.__app.ui;
    const p = ui.zonePanelDiv;
    return { inside: window.__app.scene.isInsideInterior(), panel: ui.panels.current(), h2: p ? (p.querySelector('h2') || {}).textContent : null, stamps: window.__app.passport.count() };
  });
  await t.shot(page, `journey-${tag}-leg${leg.n}-panel.png`);
  const complete = await page.evaluate(() => /Portfolio complete!/.test(document.getElementById('ui-overlay').innerText));
  if (complete) {
    await t.shot(page, `journey-${tag}-passport-complete.png`);
    await pressFn(page, touch, () => {
      const b = [...document.querySelectorAll('#ui-overlay button')].find((x) => /Wear it with pride/.test(x.textContent));
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return [r.left + r.width / 2, r.top + r.height / 2];
    });
    await lib.sleep(700);
  }
  await closeZonePanel(page, touch);
  await lib.sleep(1800);
  await leaveBuilding(page, touch);
  await lib.sleep(1800);
  await stepOff(page);
  return complete;
}

async function follow(t, prof) {
  const touch = lib.isTouchProfile(prof);
  const tag = `${prof}-follow`;
  const cap = Number(t.args.cap || 540);
  const s = await t.session(prof);
  const { page } = s;
  const R = { steps: [], legs: [], mapPicks: [] };
  R.boot = await t.boot(s);
  await lib.sleep(1500);
  const EXPLORE_AT = await explore(page, touch);
  R.guideSkipped = await skipGuide(page, touch);
  const now = async () => +(((await G.ptime(page)) - EXPLORE_AT) / 1000).toFixed(1);
  const stopTL = G.startTimeline(page, EXPLORE_AT);
  await lib.sleep(1500);
  await t.shot(page, `journey-${tag}-00-explore.png`);
  // The trail: each remaining trail coin, nearest first.
  const coins = await page.evaluate(() => {
    const sc = window.__app.scene;
    const P = sc.getPlayer().getWorldPosition();
    return (sc.coins || []).filter((c) => c.trail && c.mesh.visible).map((c) => [...c.mesh.position.toArray(), c.mesh.position.distanceTo(P)]).sort((a, b) => a[3] - b[3]);
  });
  for (const c of coins) await G.walkTo(page, c.slice(0, 3), 6000, 0.9);
  await lib.sleep(2200);
  R.steps.push({ at: 'trail done', s: await now(), read: await G.readout(page) });
  // The villager the trail ended at.
  const who = await page.evaluate(() => {
    const sc = window.__app.scene;
    const P = sc.getPlayer().getWorldPosition();
    let best = null;
    for (const n of sc.getIsland().npcTargets) {
      if (!n.meshRef.visible) continue;
      const q = n.meshRef.getWorldPosition(P.clone());
      const d = q.distanceTo(P);
      if (!best || d < best.d) best = { name: n.name, d: +d.toFixed(1) };
    }
    return best;
  });
  if (who) {
    R.talkWalk = await G.walkToNpc(page, who.name, 15000);
    await page.keyboard.press('e');
    await lib.sleep(2600);
    R.talk = await page.evaluate(() => {
      const ui = window.__app.ui;
      const chat = ui.npcChatDiv;
      return { chat: chat ? chat.innerText.replace(/\s+/g, ' ').slice(0, 400) : null, dialogue: ui.isDialogueActive() };
    });
    R.talk.who = who.name;
    if (R.talk.chat) {
      await page.evaluate(() => {
        const i = window.__app.ui.npcChatDiv.querySelector('input');
        if (i) i.focus();
      });
      await page.keyboard.type("Where can I see Abbas's projects?", { delay: 12 });
      await page.keyboard.press('Enter');
      await lib.sleep(4500);
      R.talk.reply = await page.evaluate(() => (window.__app.ui.npcChatDiv ? window.__app.ui.npcChatDiv.innerText.replace(/\s+/g, ' ').slice(-300) : null));
      await t.shot(page, `journey-${tag}-01-talk.png`);
      await page.keyboard.press('Escape');
      await page.evaluate(() => window.__app.ui.closeNpcChat && window.__app.ui.closeNpcChat());
      await lib.sleep(800);
    } else await closeDialogue(page);
  }
  // Legs: follow the compass wherever it points.
  let deliveries = 0;
  for (let n = 0; n < 14; n++) {
    if ((await now()) > cap) break;
    // A canned conversation still open (a villager met on the way) holds the
    // visitor in place: read it to the end first, as a visitor would.
    await closeDialogue(page);
    const r0 = await G.readout(page);
    if (r0.stamps >= 4) break;
    const label = strip(r0.compass);
    const leg = { n, label, startS: await now() };
    R.legs.push(leg);
    if (!label) {
      leg.note = 'compass hidden';
      break;
    }
    let pick = null;
    if (/Delivery|Parcel/.test(label) && deliveries >= 2) {
      // Switch to the map for the next unstamped district.
      const left = await page.evaluate(() => ['projects', 'professional', 'personal', 'contact'].filter((z) => !window.__app.passport.has(z)));
      pick = DISTRICTS.find((d) => d.id === left[0]);
      if (pick) {
        leg.mapPick = pick.id;
        leg.mapOk = await openMapPick(page, touch, pick.chip);
        leg.labelAfterMap = strip((await G.readout(page)).compass);
      }
    }
    const f = await G.followCompass(page, 80000, { near: /Delivery|Parcel/.test(label) && !pick ? 1.6 : 2.5, untilPrompt: DOOR });
    leg.outcome = f.outcome;
    leg.labels = [...new Set(f.log.map((x) => strip(x.label)))];
    leg.endS = await now();
    const ra = await G.readout(page);
    leg.prompt = ra.prompt;
    leg.labelAtEnd = strip(ra.compass);
    if (pick) R.mapPicks.push({ district: pick.id, doorPromptUp: DOOR.test(ra.prompt || '') && pick.re.test(ra.prompt || ''), pillAtEnd: leg.labelAtEnd, prompt: ra.prompt, s: leg.endS });
    await t.shot(page, `journey-${tag}-leg${n}-arrive.png`);
    if (/Delivery|Parcel/.test(leg.labelAfterMap || label) && !DOOR.test(ra.prompt || '')) {
      await page.keyboard.press('e');
      await lib.sleep(1500);
      leg.afterE = await G.readout(page);
      deliveries++;
      await lib.sleep(1500);
      continue;
    }
    if (!DOOR.test(ra.prompt || '')) {
      const tgt = await page.evaluate(() => (window.__app.lastCompassTarget ? window.__app.lastCompassTarget.toArray() : null));
      if (tgt) await G.walkTo(page, tgt, 6000, 1.9);
      leg.promptAfterNudge = (await G.readout(page)).prompt;
    }
    if (DOOR.test((await G.readout(page)).prompt || '')) {
      const done = await enterAndRead(t, page, touch, leg, tag);
      leg.after = await G.readout(page);
      if (done) break;
    }
  }
  R.final = await G.readout(page);
  R.endS = await now();
  R.timeline = await stopTL();
  await t.shot(page, `journey-${tag}-end.png`);
  // Stamps and the pill around them.
  const stamps = [];
  for (const e of R.timeline.filter((x) => x.k === 'stamps' && x.v > 0)) if (!stamps.find((x) => x.n === e.v)) stamps.push({ n: e.v, s: e.s });
  const pillAt = (sec) => {
    let v = null;
    for (const e of R.timeline) if (e.k === 'compass' && e.s <= sec) v = e.v;
    return v;
  };
  R.stamps = stamps.map((x) => ({ ...x, pillAfter1s: pillAt(x.s + 1.0) }));
  R.pillOverTime = R.timeline.filter((x) => x.k === 'compass').map((x) => `${x.s}s ${x.v}`);
  const by6 = stamps.filter((x) => x.s <= 360).length;
  const by9 = stamps.filter((x) => x.s <= 540).length;
  R.stampsBy6Min = by6;
  R.stampsBy9Min = by9;
  t.data[tag] = R;
  t.check(`${prof}: all four district halls entered within 6 minutes of Explore`, by6 >= 4, `${by6} of 4 by 6 min (${by9} by 9 min)`, '4 of 4');
  for (let n = 1; n <= 3; n++) {
    const x = R.stamps.find((y) => y.n === n);
    t.check(`${prof}: after stamp ${n}, the pill names a district within 1 s`, x ? isDistrictLabel(x.pillAfter1s) : null, x ? x.pillAfter1s : `no stamp ${n} in the run`, 'a district');
  }
  mapPickChecks(t, prof, R.mapPicks);
}

/**
 * Read a canned dialogue to its end with E: each press finishes the line on
 * screen, the next shows the following one, and the last closes it. A long
 * one (s1-int's trail ended at the Elder Sage) outlasts a fixed six presses.
 */
async function closeDialogue(page, max = 40) {
  let n = 0;
  for (; n < max && (await page.evaluate(() => window.__app.ui.isDialogueActive())); n++) {
    await page.keyboard.press('e');
    await lib.sleep(400);
  }
  return n;
}

/**
 * The follow scenario's map picks, one check per district: a visitor whose
 * pick falls back to the delivery picks the same district again, leg after
 * leg, and each repeat is the same finding (R.mapPicks keeps every one).
 */
function mapPickChecks(t, prof, picks) {
  const by = new Map();
  for (const m of picks) by.set(m.district, [...(by.get(m.district) || []), m]);
  for (const [district, ms] of by) {
    const ok = ms.filter((m) => m.doorPromptUp && isDistrictLabel(m.pillAtEnd)).length;
    const last = ms[ms.length - 1];
    const value = ms.length > 1 ? { picks: ms.length, endedAtTheDoor: ok, last: { prompt: last.prompt, pill: last.pillAtEnd } } : { prompt: last.prompt, pill: last.pillAtEnd };
    t.check(`${prof}: the map pick${ms.length > 1 ? 's' : ''} of ${district} end${ms.length > 1 ? '' : 's'} with its door prompt up and the pill still on it`, ok === ms.length, value, 'door prompt up, pill on it');
  }
}

async function mappick(t, prof) {
  const touch = lib.isTouchProfile(prof);
  const tag = `${prof}-mappick`;
  const s = await t.session(prof);
  const { page } = s;
  const R = { picks: [] };
  R.boot = await t.boot(s);
  await lib.sleep(1500);
  await explore(page, touch);
  R.guideSkipped = await skipGuide(page, touch);
  await lib.sleep(1500);
  for (const d of DISTRICTS) {
    const p = { district: d.id };
    p.mapOk = await openMapPick(page, touch, d.chip);
    p.labelAfterPick = strip((await G.readout(page)).compass);
    const f = await G.followCompass(page, 90000, { near: 0.8, untilPrompt: DOOR });
    p.outcome = f.outcome;
    p.labels = [...new Set(f.log.map((x) => strip(x.label)))];
    const ra = await G.readout(page);
    p.prompt = ra.prompt;
    p.pillAtEnd = strip(ra.compass);
    p.doorPromptUp = DOOR.test(ra.prompt || '') && d.re.test(ra.prompt || '');
    await t.shot(page, `journey-${tag}-${d.id}.png`);
    R.picks.push(p);
    t.check(`${prof}: a map pick of ${d.id} ends with its door prompt up and the pill still on it`, p.mapOk ? p.doorPromptUp && d.re.test(p.pillAtEnd || '') : null, { outcome: p.outcome, prompt: p.prompt, pill: p.pillAtEnd, labels: p.labels }, `door prompt for ${d.id}, pill on it`);
    await stepOff(page);
    await stepOff(page);
  }
  t.data[tag] = R;
}

async function journey(t) {
  const scenarios = String(t.args.scenario || 'follow,mappick').split(',');
  for (const prof of t.profiles(['desktop', 'phone'])) {
    if (scenarios.includes('follow')) await follow(t, prof);
    if (scenarios.includes('mappick')) await mappick(t, prof);
  }
}

module.exports = {
  mapPickChecks,
  journey: { item: 'P2-E2a (GD-01, A7)', title: "the curious ten-minute visitor following the island's own guidance: the pill over time, stamps, map picks ending at the door", profiles: ['desktop', 'phone'], run: journey },
};
