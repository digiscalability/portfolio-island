'use strict';
// p2/journey (P2-E2a, from the guidance audit's curious2.cjs): the curious
// ten-minute visitor, who follows only the island's own guidance from
// Explore. The backend stays blocked, so villager replies take the written
// fallback.
//
//   npm run probe -- p2/journey [--scenario follow,mappick,chip] [--profile desktop|phone] [--cap 540] --dist dist --port <n>
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
// A pick is followed until that district's own door prompt shows (its zone
// name in the prompt, or getNearbyInteractable() on its door): another door
// on the way (a cottage's unnamed 'Press E to enter') is walked past. Its
// end is judged on readouts over 1.2 s, so a prompt still fading in is not
// read as absent. A villager chat that opens on the way is closed and the
// walk goes on, and E is pressed only with the prompt it is meant for up.
//
// A7's bar, at 1440x900 and 390x844 touch: all four halls entered within 6
// minutes; after each of stamps 1-3 the pill names a district within 1 s of
// leaving the hall (P2-A1 hides it inside); a map pick of each district ends
// with its door prompt up and the pill still on it. P2-A12's (follow): the
// Next chip within 1 s of Skip, naming a district at each leg until four
// stamps. chip: in a fresh session, the chip's first 'Show me' row sets the
// pill to that district, and an accepted quest shows in the chip within 1 s.
const lib = require('../lib.cjs');
const G = require('./guide-lib.cjs');

const DISTRICTS = [
  { id: 'projects', re: /project/i, chip: /Project Portfolio|Projects/ },
  { id: 'professional', re: /professional/i, chip: /Professional/ },
  { id: 'personal', re: /personal/i, chip: /Personal/ },
  { id: 'contact', re: /contact|get in touch/i, chip: /Get In Touch|Contact/ },
];
const isDistrictLabel = (l) => DISTRICTS.some((d) => d.re.test(l || ''));
const districtOf = (l) => DISTRICTS.find((d) => d.re.test(l || '')) || null;
const strip = (l) => (l || '').replace(/\s*•?\s*[\d.]+m$/, '').trim();
const DOOR = /(Press E|Tap 👆 USE|Tap USE) to enter/;
const DELIVER = /collect the delivery|deliver/i;
const escapeRe = (x) => String(x).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** A district's own door prompt: the zone's name after 'to enter' (its chip's words when the build gives no name). */
const doorRe = (d, names) =>
  names && names[d.id]
    ? new RegExp(`${DOOR.source} ${escapeRe(names[d.id])}`)
    : new RegExp(`${DOOR.source} .*(${d.re.source})`, 'i');
/** The district names the build gives its zones. */
const zoneNames = (page) =>
  page.evaluate(
    (ids) => {
      const zm = window.__app.scene.getZonesManager && window.__app.scene.getZonesManager();
      return Object.fromEntries(
        ids.map((id) => [id, (zm && zm.getZoneById(id) && zm.getZoneById(id).name) || null]),
      );
    },
    DISTRICTS.map((d) => d.id),
  );
/** The first sampled prompt that matches re, else the last one shown. */
const promptOf = (ss, re) => {
  const hit = ss.find((x) => x.prompt && re.test(x.prompt));
  if (hit) return hit.prompt;
  const shown = ss.filter((x) => x.prompt);
  return shown.length ? shown[shown.length - 1].prompt : null;
};
/** The pill at the end (the last sample that shows one), and whether every sample that shows one names the district. */
const pillOf = (ss, re) => {
  const shown = ss.map((x) => strip(x.compass)).filter(Boolean);
  return {
    pill: shown.length ? shown[shown.length - 1] : null,
    on: shown.length > 0 && shown.every((l) => re.test(l)),
  };
};

/**
 * Follow the compass to a district: until its own door prompt (or its door
 * as the nearby interactable), arrival within `near`, or the time runs out.
 * A villager chat that opens on the way is closed and the walk resumes.
 */
async function followTo(page, ms, { near, d = null, names = null } = {}) {
  const end = Date.now() + ms;
  const log = [];
  let strays = 0;
  let f = { outcome: 'timeout', log: [] };
  while (Date.now() < end) {
    f = await G.followCompass(page, end - Date.now(), {
      near,
      untilPrompt: d ? doorRe(d, names) : DOOR,
      untilZone: d ? d.id : null,
    });
    log.push(...f.log);
    if (f.outcome === 'panel:npc-chat' && strays < 4 && (await G.closeNpcChat(page))) {
      strays++;
      continue;
    }
    break;
  }
  return { ...f, log, strays };
}

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

/** P2-A12's Next chip: its words when #ds-guide shows 'Next: ...', else null. */
const CHIP = () => {
  const g = document.getElementById('ds-guide');
  if (!g || !g.isConnected) return null;
  const cs = getComputedStyle(g);
  const r = g.getBoundingClientRect();
  if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity < 0.1 || r.width < 2) return null;
  const text = (g.innerText || '').replace(/\s+/g, ' ').trim();
  return /^Next:/.test(text) ? { text: text.slice(0, 240), state: g.dataset.next || null } : null;
};
const CHIP_DISTRICT = /^Next:\s*\W*\s*(Projects|Project Portfolio|Professional|Personal|Contact|Get In Touch)/i;
/** Poll the chip for up to ms; the time it took, or null. */
async function chipWithin(page, ms) {
  const t0 = Date.now();
  do {
    const c = await page.evaluate(CHIP);
    if (c) return { ms: Date.now() - t0, ...c };
    await lib.sleep(50);
  } while (Date.now() - t0 < ms);
  return null;
}
/** Open the chip, press its first 'Show me' row, then accept the Elder Sage's quest: what the chip and the pill say. */
async function chipRoutes(page) {
  const out = {};
  out.opened = await page.evaluate(() => {
    const g = document.getElementById('ds-guide');
    const b = g && [...g.querySelectorAll('button')].find((x) => /^Next:/.test((x.innerText || '').trim()));
    if (!b) return false;
    if (g.dataset.next !== 'open') b.click();
    return true;
  });
  await lib.sleep(500);
  const SHOW_ME = /show me/i;
  out.showMe = await page.evaluate((src) => {
    const re = new RegExp(src, 'i');
    const g = document.getElementById('ds-guide');
    const b = g && [...g.querySelectorAll('button')].find((x) => re.test(x.innerText || x.getAttribute('aria-label') || ''));
    if (!b) return null;
    // The row: the largest ancestor that holds this one 'Show me' and no other.
    let row = b;
    while (row.parentElement && row.parentElement !== g && [...row.parentElement.querySelectorAll('button')].filter((x) => re.test(x.innerText || x.getAttribute('aria-label') || '')).length === 1) row = row.parentElement;
    const label = (row.innerText || '').replace(re, '').replace(/\s+/g, ' ').trim().slice(0, 80);
    b.click();
    return { row: label };
  }, SHOW_ME.source);
  await lib.sleep(700);
  if (out.showMe) out.showMe.compass = (await G.readout(page)).compass;
  // The quest list is drawn in the open chip: open it again if Show me folded it.
  await page.evaluate(() => {
    const ui = window.__app.ui;
    if (ui.panels && ui.panels.current()) ui.panels.closeAll();
    const g = document.getElementById('ds-guide');
    const b = g && [...g.querySelectorAll('button')].find((x) => /^Next:/.test((x.innerText || '').trim()));
    if (b && g.dataset.next !== 'open') b.click();
  });
  await lib.sleep(400);
  out.quest = await page.evaluate(() => {
    const q = window.__app.npcQuests;
    if (!q || typeof q.onTalk !== 'function') return { error: 'no npcQuests.onTalk' };
    q.onTalk('Elder Sage', window.__app.scene.getCoinsCollected());
    return { active: q.getActiveQuests(window.__app.scene.getCoinsCollected()).map((x) => `${x.giver}: ${x.label}`) };
  });
  const t1 = Date.now();
  out.quest.ms = null;
  while (Date.now() - t1 < 1500) {
    const c = await page.evaluate(() => (document.getElementById('ds-guide') ? document.getElementById('ds-guide').innerText.replace(/\s+/g, ' ') : ''));
    if (/Elder Sage/.test(c)) {
      out.quest.ms = Date.now() - t1;
      out.quest.chip = c.slice(0, 200);
      break;
    }
    await lib.sleep(50);
  }
  return out;
}

/** Leave a hall and read the pill as the visitor steps out: the first label within 1 s of the exit. */
async function pillAfterExit(page) {
  const t0 = Date.now();
  let last = null;
  do {
    const c = strip((await G.readout(page)).compass);
    if (c) {
      last = c;
      if (isDistrictLabel(c)) return { label: c, ms: Date.now() - t0 };
    }
    await lib.sleep(80);
  } while (Date.now() - t0 < 1000);
  return { label: last, ms: null };
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
      // P2-D10: the crown's call is button[data-crown-next] ('Next: ...');
      // older builds name it 'Wear it with pride'.
      const b = document.querySelector('#ui-overlay button[data-crown-next]') || [...document.querySelectorAll('#ui-overlay button')].find((x) => /Wear it with pride/.test(x.textContent));
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return [r.left + r.width / 2, r.top + r.height / 2];
    });
    await lib.sleep(700);
  }
  await closeZonePanel(page, touch);
  await lib.sleep(1800);
  await leaveBuilding(page, touch);
  // P2-A1 hides the pill inside a hall, so it is read from the exit: the
  // moment the visitor is outside again, then for 1 s.
  const out0 = Date.now();
  while (Date.now() - out0 < 6000 && (await page.evaluate(() => window.__app.scene.isInsideInterior()))) await lib.sleep(60);
  leg.exitMs = Date.now() - out0;
  leg.pillAfterExit = await pillAfterExit(page);
  await lib.sleep(800);
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
  // P2-A12: Skip folds First steps into the Next chip.
  R.chip = { afterSkip: R.guideSkipped ? await chipWithin(page, 1000) : null, legs: [] };
  const now = async () => +(((await G.ptime(page)) - EXPLORE_AT) / 1000).toFixed(1);
  const stopTL = G.startTimeline(page, EXPLORE_AT);
  await lib.sleep(1500);
  await t.shot(page, `journey-${tag}-00-explore.png`);
  // The trail: each remaining trail coin, nearest first.
  const coins = await page.evaluate(() => {
    const sc = window.__app.scene;
    const P = sc.getPlayer().getWorldPosition();
    // Either coin shape (lib COIN_READ); null when neither is present.
    const l = window.__uxCoin.list(sc, { trail: true });
    return l ? l.map((e) => [e.p.x, e.p.y, e.p.z, e.p.distanceTo(P)]).sort((a, b) => a[3] - b[3]) : null;
  });
  R.trailCoins = coins ? coins.length : null;
  for (const c of coins || []) await G.walkTo(page, c.slice(0, 3), 6000, 0.9);
  await lib.sleep(2200);
  R.steps.push({ at: 'trail done', s: await now(), read: await G.readout(page) });
  // The villager the trail ended at: the one the build says it leads to
  // (B10's getTrailVillager), else the nearest.
  const who = await page.evaluate(() => {
    const sc = window.__app.scene;
    const P = sc.getPlayer().getWorldPosition();
    const named = typeof sc.getTrailVillager === 'function' ? sc.getTrailVillager() : null;
    let best = null;
    for (const n of sc.getIsland().npcTargets) {
      if (!n.meshRef.visible) continue;
      const q = n.meshRef.getWorldPosition(P.clone());
      const d = q.distanceTo(P);
      if (named && n.name === named) return { name: n.name, d: +d.toFixed(1), from: 'getTrailVillager' };
      if (!best || d < best.d) best = { name: n.name, d: +d.toFixed(1), from: 'nearest' };
    }
    return best;
  });
  if (who) {
    R.talkWalk = await G.walkToNpc(page, who.name, 15000);
    // E only with the villager's prompt up.
    if (R.talkWalk === 'prompt') await page.keyboard.press('e');
    await lib.sleep(2600);
    R.talk = await page.evaluate(() => {
      const ui = window.__app.ui;
      const chat = ui.npcChatDiv;
      return { chat: chat ? chat.innerText.replace(/\s+/g, ' ').slice(0, 400) : null, dialogue: ui.isDialogueActive() };
    });
    R.talk.who = who.name;
    R.talk.whoFrom = who.from;
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
  const names = await zoneNames(page);
  R.zoneNames = names;
  let deliveries = 0;
  for (let n = 0; n < 14; n++) {
    if ((await now()) > cap) break;
    // A canned conversation or a villager chat still open (a villager met on
    // the way) holds the visitor in place: read it to the end, or close it.
    await closeDialogue(page);
    const strayAtStart = await G.closeNpcChat(page);
    const r0 = await G.readout(page);
    if (r0.stamps >= 4) break;
    const chipNow = await page.evaluate(CHIP);
    R.chip.legs.push({ n, stamps: r0.stamps, chip: chipNow ? chipNow.text.slice(0, 80) : null });
    const label = strip(r0.compass);
    const leg = { n, label, startS: await now() };
    if (strayAtStart) leg.strayChatClosed = true;
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
    const delivery = /Delivery|Parcel/.test(leg.labelAfterMap || label);
    // The district this leg leads to (the pick's, or the one the pill
    // names): only that district's own door ends it.
    const d = pick || (delivery ? null : districtOf(label));
    const want = d ? doorRe(d, names) : DOOR;
    const f = await followTo(page, 80000, { near: delivery ? 1.6 : 2.5, d, names });
    leg.outcome = f.outcome;
    if (f.strays) leg.strayChats = f.strays;
    leg.labels = [...new Set(f.log.map((x) => strip(x.label)))];
    leg.endS = await now();
    let ss = await G.sampleReadout(page, 1200);
    leg.prompt = promptOf(ss, delivery ? DELIVER : want);
    leg.labelAtEnd = pillOf(ss, /./).pill;
    if (pick) {
      const pl = pillOf(ss, pick.re);
      R.mapPicks.push({ district: pick.id, doorPromptUp: ss.some((x) => want.test(x.prompt || '')), pillOn: pl.on, pillAtEnd: pl.pill, prompt: leg.prompt, outcome: f.outcome, s: leg.endS });
    }
    await t.shot(page, `journey-${tag}-leg${n}-arrive.png`);
    if (delivery && !DOOR.test(leg.prompt || '')) {
      // E only with the mailbox's prompt up: an E beside a villager opens a chat.
      if (!DELIVER.test(leg.prompt || '')) {
        const tgt = await page.evaluate(() => (window.__app.lastCompassTarget ? window.__app.lastCompassTarget.toArray() : null));
        if (tgt) await G.walkTo(page, tgt, 4000, 1.0);
        ss = await G.sampleReadout(page, 1200);
        leg.promptAfterNudge = promptOf(ss, DELIVER);
      }
      if (DELIVER.test(leg.promptAfterNudge || leg.prompt || '')) {
        await page.keyboard.press('e');
        await lib.sleep(1500);
        leg.afterE = await G.readout(page);
        deliveries++;
      } else leg.note = 'no delivery prompt: E not pressed';
      if (await G.closeNpcChat(page)) leg.strayChatClosed = true;
      await lib.sleep(1500);
      continue;
    }
    if (!ss.some((x) => want.test(x.prompt || ''))) {
      const tgt = await page.evaluate(() => (window.__app.lastCompassTarget ? window.__app.lastCompassTarget.toArray() : null));
      if (tgt) await G.walkTo(page, tgt, 6000, 1.9);
      ss = await G.sampleReadout(page, 1200);
      leg.promptAfterNudge = promptOf(ss, want);
    }
    // E (or USE) only with the door prompt up.
    if (want.test(promptOf(ss, want) || '')) {
      const done = await enterAndRead(t, page, touch, leg, tag);
      leg.after = await G.readout(page);
      if (done) break;
    } else leg.note = leg.note || 'no door prompt: E not pressed';
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
    // Read at the hall's exit (P2-A1 hides the pill inside); the timeline's
    // pill 1 s after the stamp is the fallback for a leg with no exit read.
    const leg = R.legs.find((l) => l.inside && l.inside.stamps === n && l.pillAfterExit);
    const x = R.stamps.find((y) => y.n === n);
    const v = leg ? leg.pillAfterExit : null;
    t.check(`${prof}: after stamp ${n}, the pill names a district within 1 s of leaving the hall`, v ? isDistrictLabel(v.label) : x ? isDistrictLabel(x.pillAfter1s) : null, v ? (v.ms !== null ? `${v.label} at ${v.ms} ms` : v.label || '(hidden)') : x ? x.pillAfter1s : `no stamp ${n} in the run`, 'a district');
  }
  mapPickChecks(t, prof, R.mapPicks);
  // P2-A12's Next chip.
  const C = R.chip;
  const ca = C.afterSkip;
  t.check(`${prof}: after Skip, the Next chip within 1 s (ms)`, R.guideSkipped ? !!ca : null, ca ? ca.ms : R.guideSkipped ? 'no Next chip in 1 s' : 'no First steps card to skip', '<= 1000');
  const until4 = C.legs.filter((l) => l.stamps < 4);
  const bad = until4.filter((l) => !CHIP_DISTRICT.test(l.chip || ''));
  t.check(`${prof}: the Next chip names a district until four stamps`, ca && until4.length ? bad.length === 0 : null, ca ? (bad.length ? bad.slice(0, 4) : `${until4.length} legs, all a district`) : 'no Next chip', 'a district at every leg');
}

/**
 * P2-A12's routes, in a session of their own (they move the pill, and after
 * four stamps the chip's rows are no longer districts): Explore, Skip, the
 * chip's first 'Show me' row (a district at the start), then a quest
 * accepted with the chip open.
 */
async function chip(t, prof) {
  const touch = lib.isTouchProfile(prof);
  const tag = `${prof}-chip`;
  const s = await t.session(prof);
  const { page } = s;
  const R = {};
  R.boot = await t.boot(s);
  await lib.sleep(1500);
  await explore(page, touch);
  R.guideSkipped = await skipGuide(page, touch);
  R.afterSkip = R.guideSkipped ? await chipWithin(page, 1000) : null;
  await lib.sleep(600);
  R.routes = R.afterSkip ? await chipRoutes(page) : null;
  await t.shot(page, `journey-${tag}.png`);
  t.data[tag] = R;
  const rt = R.routes;
  const sm = rt && rt.showMe;
  const smDistrict = sm ? DISTRICTS.find((d) => d.re.test(sm.row)) : null;
  t.check(`${prof}: the chip's first 'Show me' row sets the pill to its district`, rt ? !!sm && !!smDistrict && smDistrict.re.test(sm.compass || '') : null, rt ? (sm ? { row: sm.row, pill: sm.compass } : "no 'Show me' row in the open chip") : 'no Next chip', "the row's district");
  t.check(`${prof}: an accepted quest shows in the open chip within 1 s (ms)`, rt && rt.quest && !rt.quest.error ? rt.quest.ms !== null && rt.quest.ms <= 1000 : null, rt ? rt.quest.error || (rt.quest.ms !== null ? rt.quest.ms : `not in 1.5 s (active: ${(rt.quest.active || []).join('; ')})`) : 'no Next chip', '<= 1000');
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
    const ok = ms.filter((m) => m.doorPromptUp && (m.pillOn !== undefined ? m.pillOn : isDistrictLabel(m.pillAtEnd))).length;
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
  const names = await zoneNames(page);
  R.zoneNames = names;
  for (const d of DISTRICTS) {
    const p = { district: d.id };
    if (await G.closeNpcChat(page)) p.strayChatClosedBefore = true;
    p.mapOk = await openMapPick(page, touch, d.chip);
    p.labelAfterPick = strip((await G.readout(page)).compass);
    // On to the district's own door prompt: another door on the way does not end it.
    const f = await followTo(page, 90000, { near: 0.8, d, names });
    p.outcome = f.outcome;
    if (f.strays) p.strayChats = f.strays;
    p.labels = [...new Set(f.log.map((x) => strip(x.label)))];
    // Judged over 1.2 s: the prompt may still be fading in.
    const ss = await G.sampleReadout(page, 1200);
    const want = doorRe(d, names);
    const pl = pillOf(ss, d.re);
    p.prompt = promptOf(ss, want);
    p.pillAtEnd = pl.pill;
    p.pillOn = pl.on;
    p.doorPromptUp = ss.some((x) => want.test(x.prompt || ''));
    p.samples = ss.length;
    await t.shot(page, `journey-${tag}-${d.id}.png`);
    R.picks.push(p);
    t.check(`${prof}: a map pick of ${d.id} ends with its door prompt up and the pill still on it`, p.mapOk ? p.doorPromptUp && p.pillOn : null, { outcome: p.outcome, prompt: p.prompt, pill: p.pillAtEnd, labels: p.labels }, `door prompt for ${names[d.id] || d.id}, pill on it`);
    await stepOff(page);
    await stepOff(page);
  }
  t.data[tag] = R;
}

async function journey(t) {
  const scenarios = String(t.args.scenario || 'follow,mappick,chip').split(',');
  for (const prof of t.profiles(['desktop', 'phone'])) {
    if (scenarios.includes('follow')) await follow(t, prof);
    if (scenarios.includes('mappick')) await mappick(t, prof);
    if (scenarios.includes('chip')) await chip(t, prof);
  }
}

module.exports = {
  mapPickChecks,
  journey: { item: 'P2-E2a (GD-01, A7)', title: "the curious ten-minute visitor following the island's own guidance: the pill over time, stamps, map picks ending at the door", profiles: ['desktop', 'phone'], run: journey },
};
