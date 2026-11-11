'use strict';
// p2/party and p2/partyoff (P2-E1a, from the interiors audit's party.cjs and
// partyoff.cjs): the beach-house party against the light-count program keys.
//
// party: after the idle warm (and a cottage visit, unless --first), walk to
// the beach house, press E (or tap USE), type the code on its pad; then the
// party off and on inside, leave, and re-enter. Each step records the
// programs it adds, the longest frame, the veil and the visible lights.
// P2-B2's bar: the entry adds 1 program or fewer, its longest frame is
// 100 ms or less on desktop (200 ms on the phone at 1x); toggling adds 0
// programs, frames 50 ms or less on desktop; the beach house has as many
// visible lights as a cottage.
//
// partyoff: 3 s after 'Party over', are the borrowed dancers still in the
// room, visible and frozen (position and an arm unchanged 1.5 s apart)?
// P2-B2's bar: frozenInRoom = 0.
const lib = require('../lib.cjs');
const R = require('./room-lib.cjs');

const LIGHTS = () => {
  let n = 0;
  window.__app.scene.traverseVisible((o) => {
    if (o.isLight) n++;
  });
  return n;
};

async function step(page, name, fn, ms = 3200) {
  const p0 = await R.programs(page);
  await page.evaluate(() => window.__ia.start());
  await fn();
  await page.waitForTimeout(ms);
  const fr = await page.evaluate(() => window.__ia.stop());
  const p1 = await R.programs(page);
  const tr = R.transition(fr, p0);
  return { name, programsAdded: p1 - p0, maxDt: tr.maxDt, maxRen: tr.maxRen, over50: tr.over50, blackMs: tr.blackMs, inside: tr.inside, lights: await page.evaluate(LIGHTS) };
}

const toggleParty = (page) => page.evaluate(() => window.__app.ui.flashMessage(window.__app.scene.toggleInteriorFixture('party')));

async function party(t) {
  const first = !!t.args.first;
  for (const prof of t.profiles(['desktop'])) {
    const touch = lib.isTouchProfile(prof);
    const s = await t.session(prof, { init: [R.REWARD_INIT] });
    const { page } = s;
    const T = touch ? await lib.touch(s) : null;
    await t.boot(s, { query: 'hour=12' });
    await R.install(page);
    if (touch) await page.tap(`${lib.WELCOME} button[data-dismiss]`).catch(() => lib.dismissWelcome(page));
    else await lib.dismissWelcome(page);
    await page.waitForTimeout(1200);
    const out = { first, warm: await R.warm(page), steps: [] };
    await page.waitForTimeout(1500);
    if (!first) {
      // A cottage visit first, as a visitor who has been indoors before.
      out.steps.push(await step(page, 'enter-cottage', () => R.enterRoom(page, 'house_0', { touch, T, back: 3.0 })));
      out.steps.push(await step(page, 'exit-cottage', () => page.evaluate(() => window.__app.exitBuilding(false)), 2000));
    }
    out.steps.push(await step(page, 'enter-beach', () => R.enterRoom(page, 'islet_beach_house', { touch, T, back: 3.0 }), 4200));
    await t.shot(page, `party-${prof}-inside.png`);
    await page.evaluate(() => window.__ia.pose(0.9, 1.8, Math.PI));
    await page.waitForTimeout(400);
    await t.shot(page, `party-${prof}-floor.png`);
    out.steps.push(await step(page, 'party-off', () => toggleParty(page)));
    out.steps.push(await step(page, 'party-on', () => toggleParty(page)));
    out.steps.push(await step(page, 'exit-beach', () => page.evaluate(() => window.__app.exitBuilding(false)), 2500));
    out.steps.push(await step(page, 'reenter-beach', () => page.evaluate(() => window.__app.scene.onHouseEnterCb('islet_beach_house')), 3000));
    t.data[prof] = out;
    const by = Object.fromEntries(out.steps.map((x) => [x.name, x]));
    const e = by['enter-beach'];
    const frameCap = touch ? 200 : 100;
    t.check(`${prof}: entering the beach house adds programs`, e.inside ? e.programsAdded <= 1 : false, e.inside ? e.programsAdded : 'not inside', '<= 1');
    t.check(`${prof}: the beach-house entry's longest frame (ms)`, e.inside && e.maxDt !== null ? e.maxDt <= frameCap : false, e.maxDt, `<= ${frameCap}`);
    for (const k of ['party-off', 'party-on']) {
      const x = by[k];
      t.check(`${prof}: ${k} adds programs`, x.programsAdded === 0, x.programsAdded, 0);
      if (!touch) t.check(`${prof}: ${k} longest frame (ms)`, x.maxDt !== null && x.maxDt <= 50, x.maxDt, '<= 50');
    }
    const cottage = by['enter-cottage'];
    if (cottage) t.check(`${prof}: the beach house has as many visible lights as a cottage`, e.lights === cottage.lights, { beach: e.lights, cottage: cottage.lights }, 'equal');
  }
}

const DANCERS = () => {
  const sc = window.__app.scene;
  const o = sc.constructor.INTERIOR_ORIGIN;
  const names = ['Gardener', 'Artist', 'Musician', 'Storyteller', 'Cartographer', 'Courier'];
  return names.map((n) => {
    const tg = sc.island.npcTargets.find((x) => x.name === n);
    if (!tg) return null;
    const r = tg.meshRef;
    const l = r.userData.limbs && r.userData.limbs[2];
    return { n, visible: r.visible, inRoom: Math.abs(r.position.y - o.y) < 5, pos: [r.position.x - o.x, r.position.y - o.y, r.position.z - o.z].map((v) => +v.toFixed(2)), arm: l ? l.b.quaternion.toArray().map((v) => +v.toFixed(3)) : null };
  });
};

async function partyoff(t) {
  for (const prof of t.profiles(['desktop'])) {
    const touch = lib.isTouchProfile(prof);
    const s = await t.session(prof, { init: [R.REWARD_INIT] });
    const { page } = s;
    const T = touch ? await lib.touch(s) : null;
    await t.boot(s, { query: 'hour=12' });
    await R.install(page);
    if (touch) await page.tap(`${lib.WELCOME} button[data-dismiss]`).catch(() => lib.dismissWelcome(page));
    else await lib.dismissWelcome(page);
    await page.waitForTimeout(1000);
    const e = await R.enterRoom(page, 'islet_beach_house', { touch, T, back: 3.0 });
    await page.waitForTimeout(5000);
    const on = await page.evaluate(DANCERS);
    await toggleParty(page);
    await page.waitForTimeout(1500);
    const off1 = await page.evaluate(DANCERS);
    await page.waitForTimeout(1500);
    const off2 = await page.evaluate(DANCERS);
    await t.shot(page, `partyoff-${prof}-3s.png`);
    const frozen = off1.map((a, i) => !!(a && off2[i] && a.visible && a.inRoom && JSON.stringify(a.pos) === JSON.stringify(off2[i].pos) && JSON.stringify(a.arm) === JSON.stringify(off2[i].arm)));
    const inside = await page.evaluate(() => window.__app.scene.isInsideInterior());
    t.data[prof] = { enter: { press: e.press, pin: e.pin || null }, inside, partyOn: on, off1, off2, frozenInRoom: frozen.filter(Boolean).length };
    t.check(`${prof}: dancers frozen in the room 3 s after 'Party over'`, inside ? frozen.filter(Boolean).length === 0 : false, inside ? frozen.filter(Boolean).length : 'not inside the beach house', 0);
  }
}

module.exports = {
  party: { item: 'P2-E1a (INT-08, P2-B2)', title: 'the beach-house entry and the party off/on: programs, longest frame, veil and visible lights (--first: the session\'s first door)', profiles: ['desktop'], run: party },
  partyoff: { item: 'P2-E1a (INT-08, P2-B2)', title: "3 s after 'Party over': borrowed dancers still in the room, visible and frozen", profiles: ['desktop'], run: partyoff },
};
