'use strict';
// Phase-2 gameplay probes, part 2 (P2-E2b), on p2/play-lib.cjs and
// p2/guide-lib.cjs: firstplay, race and quests. The gameplay audit's scripts
// (g2-firstplay, g7-race, g5-quests) were session temp files and are gone, so
// these are rebuilt from its report
// (docs/history/2026-11-03-ux-audit/phase2/gameplay.json: GP-02, GP-03,
// GP-04, GP-05, GP-10) and checked against the numbers it recorded on
// 58c8849. The backend stays blocked, so every villager reply is the written
// fallback, and sounds are logged by wrapping OscillatorNode and
// AudioBufferSourceNode starts (play-lib's AUDIO).
//
//   npm run probe -- p2/firstplay [--device desk|phone] --dist dist --port <n>
//   npm run probe -- p2/race      [--driver gates|compass] [--circuit land|water] [--device desk|phone] --dist dist --port <n>
//   npm run probe -- p2/race --legs | --circuit water --craft boat   (P2-E2d) --dist dist --port <n>
//   npm run probe -- p2/quests    [--device desk|phone] --dist dist --port <n>
const lib = require('../lib.cjs');
const G = require('./guide-lib.cjs');
const P = require('./play-lib.cjs');

async function tapOrClick(page, touch, xy) {
  if (!xy) return false;
  if (touch) await page.touchscreen.tap(xy[0], xy[1]);
  else await page.mouse.click(xy[0], xy[1]);
  return true;
}
async function explore(page, touch) {
  const sel = `${lib.WELCOME} button[data-dismiss]`;
  if (touch) await page.tap(sel).catch(() => page.click(sel));
  else await page.click(sel);
  return G.ptime(page);
}
/** First steps (A6) steps aside where this build has it. */
const skipGuide = (page) =>
  page.evaluate(() => {
    const g = document.getElementById('ds-guide');
    const b = g && [...g.querySelectorAll('button,[role=button]')].find((x) => /skip/i.test(`${x.getAttribute('aria-label') || ''} ${x.textContent || ''}`));
    if (b) b.click();
    return !!b;
  });
async function useKey(page, touch, T) {
  if (touch && T) {
    const u = await T.useBtn();
    if (u) return T.tap(u[0], u[1]);
  }
  return page.keyboard.press('e');
}
/** Put the player `dist` u from a world point (toward the pole side), on the ground. */
const TP_NEAR = ({ p, dist }) => {
  const sc = window.__app.scene;
  const V3 = sc.getPlayer().getWorldPosition().constructor;
  const c = new V3(p[0], p[1], p[2]);
  const n = c.clone().normalize();
  const ref = Math.abs(n.y) < 0.9 ? new V3(0, 1, 0) : new V3(1, 0, 0);
  const tan = ref.clone().addScaledVector(n, -ref.dot(n)).normalize();
  const d = c.clone().addScaledVector(tan, dist).normalize();
  const s = sc.getIsland().sampleSurfaceByDirection(d, 0);
  sc.getPlayer().setWorldPosition(d.multiplyScalar(s.position.length() + 0.75));
  return true;
};

/** Stand 1.4 u from a villager, re-placed every poll (they walk), until the talk prompt names them. */
async function besideNpc(page, name, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const pos = await page.evaluate((n) => {
      const p = window.__app.scene.getNpcPosition(n);
      return p ? p.toArray() : null;
    }, name);
    if (!pos) return 'no npc';
    await page.evaluate(TP_NEAR, { p: pos, dist: 1.4 });
    await lib.sleep(200);
    const prompt = await page.evaluate(() => (window.__app.ui.interactionDiv ? window.__app.ui.interactionDiv.textContent : ''));
    if (new RegExp(name).test(prompt || '')) return 'prompt';
  }
  return 'timeout';
}

// ---------------------------------------------------------------- firstplay
const CHAT = () => {
  const ui = window.__app.ui;
  const c = ui.npcChatDiv;
  if (!c || !c.isConnected) return null;
  // 58c8849's chat has no role=log: its log is the panel's one scrolling child.
  const log = c.querySelector('[role=log]') || [...c.children].find((d) => d.style.overflowY === 'auto') || c;
  const lines = [...log.children].map((d) => (d.innerText || d.textContent || '').replace(/\s+/g, ' ').trim()).filter(Boolean);
  // Action buttons: any button in the chat that is not the header's or Send.
  const buttons = [...c.querySelectorAll('button')]
    .filter((b) => !/^(Close chat|NPC voice)$/.test(b.getAttribute('aria-label') || '') && !/^(send|➤|→)$/i.test((b.textContent || '').trim()) && b.getBoundingClientRect().width > 2)
    .map((b) => (b.getAttribute('aria-label') || b.textContent || '').replace(/\s+/g, ' ').trim());
  return { lines, buttons, badge: ui.npcChatBadge ? ui.npcChatBadge.textContent : null, who: (c.querySelector('span') || {}).textContent || null };
};
const TOP = () => {
  const ui = window.__app.ui;
  const p = ui.zonePanelDiv;
  const text = p && p.isConnected ? (p.innerText || '').replace(/\s+/g, ' ') : '';
  return { panel: ui.panels.current(), h2: p && p.isConnected && p.querySelector('h2') ? p.querySelector('h2').textContent.trim() : null, hire: /LinkedIn/.test(text) && /CV/.test(text), compass: window.__h && window.__h.compassFull ? window.__h.compassFull() : null };
};

/** The buttons a reply added: the after-set less the before-set, as multisets
 * (the chat's own 🎤 sits after the log, so a slice by count returns it). */
const newButtons = (before, after) => {
  const left = new Map();
  for (const b of before) left.set(b, (left.get(b) || 0) + 1);
  return after.filter((b) => {
    const n = left.get(b) || 0;
    if (n > 0) left.set(b, n - 1);
    return n === 0;
  });
};

const QUESTIONS = [
  { key: 'both', q: 'What does Abbas build, and how do I contact him?' },
  { key: 'build', q: 'What does Abbas build?' },
  { key: 'contact', q: 'How do I contact him?' },
  { key: 'shop', q: 'Where is the shop?' },
  { key: 'weather', q: 'Nice weather?' },
];

async function openChat(page, touch, T, name) {
  const walk = await G.walkToNpc(page, name, 15000);
  if (walk === 'prompt') await useKey(page, touch, T);
  await lib.sleep(2400);
  // A quest giver answers E with scripted lines first: page through them, then E again.
  for (let i = 0; i < 10 && (await page.evaluate(() => window.__app.ui.isDialogueActive())); i++) {
    await useKey(page, touch, T);
    await lib.sleep(600);
  }
  if (!(await page.evaluate(CHAT))) {
    const w2 = await G.walkToNpc(page, name, 6000);
    if (w2 === 'prompt') await useKey(page, touch, T);
    await lib.sleep(2400);
  }
  // A villager on a route (P2-C's walks) can step out of reach between the
  // prompt and E: stand beside them and press E with their prompt up.
  if (!(await page.evaluate(CHAT)) && !(await page.evaluate(() => window.__app.ui.isDialogueActive()))) {
    if ((await besideNpc(page, name, 4000)) === 'prompt') await useKey(page, touch, T);
    await lib.sleep(2400);
    for (let i = 0; i < 10 && (await page.evaluate(() => window.__app.ui.isDialogueActive())); i++) {
      await useKey(page, touch, T);
      await lib.sleep(600);
    }
  }
  return { walk, chat: await page.evaluate(CHAT) };
}

async function firstplay(t) {
  for (const prof of t.profiles(['desktop', 'phone'])) {
    const touch = lib.isTouchProfile(prof);
    const s = await t.session(prof, { init: [P.SAMPLER, P.AUDIO] });
    const { page } = s;
    const T = touch ? await lib.touch(s) : null;
    const out = { asked: {} };
    // Noon, whatever the rig's clock says: at night the trail's villager is asleep.
    await t.boot(s, { query: 'hour=12' });
    await lib.sleep(1200);
    const EXPLORE_AT = await explore(page, touch);
    out.guideSkipped = await skipGuide(page);
    await lib.sleep(1200);
    // The arrival trail: every trail coin, nearest first.
    const coins = await page.evaluate(() => {
      const sc = window.__app.scene;
      const p = sc.getPlayer().getWorldPosition();
      return (sc.coins || []).filter((c) => c.trail && c.mesh.visible).map((c) => [...c.mesh.position.toArray(), c.mesh.position.distanceTo(p)]).sort((a, b) => a[3] - b[3]);
    });
    const t0 = Date.now();
    for (const c of coins) await G.walkTo(page, c.slice(0, 3), 6000, 0.9);
    out.trail = { coins: coins.length, seconds: +((Date.now() - t0) / 1000).toFixed(1), collected: await page.evaluate(() => window.__app.scene.getCoinsCollected()) };
    const who = await page.evaluate(() => {
      const sc = window.__app.scene;
      const p = sc.getPlayer().getWorldPosition();
      const named = typeof sc.getTrailVillager === 'function' ? sc.getTrailVillager() : null;
      let best = null;
      for (const n of sc.getIsland().npcTargets) {
        if (!n.meshRef.visible) continue;
        const d = n.meshRef.getWorldPosition(p.clone()).distanceTo(p);
        if (named && n.name === named) return { name: n.name, d: +d.toFixed(1), from: 'getTrailVillager' };
        if (!best || d < best.d) best = { name: n.name, d: +d.toFixed(1), from: 'nearest' };
      }
      return best;
    });
    out.villager = who;
    if (!who) throw new Error('no villager in the world');
    const first = await openChat(page, touch, T, who.name);
    out.chatOpened = { walk: first.walk, opened: !!first.chat, opening: first.chat ? first.chat.lines.slice(0, 2) : null, badge: first.chat ? first.chat.badge : null };
    await t.shot(page, `firstplay-${prof}-chat.png`);
    for (const { key, q } of QUESTIONS) {
      let chat = await page.evaluate(CHAT);
      if (!chat) chat = (await openChat(page, touch, T, who.name)).chat;
      if (!chat) {
        out.asked[key] = { q, error: 'the chat did not open' };
        continue;
      }
      const before = chat.lines.length;
      const b0 = chat.buttons.slice();
      await page.evaluate(() => {
        const i = window.__app.ui.npcChatDiv.querySelector('input');
        if (i) i.focus();
      });
      await page.keyboard.type(q, { delay: 10 });
      const sent = Date.now();
      await page.keyboard.press('Enter');
      // The reply: a new line after the visitor's own.
      let after = null;
      for (let i = 0; i < 40; i++) {
        await lib.sleep(250);
        after = await page.evaluate(CHAT);
        if (after && after.lines.length >= before + 2 && !/…$|\.\.\.$/.test(after.lines[after.lines.length - 1])) break;
      }
      // A reply may be typed out: wait until its text holds still.
      for (let i = 0, last = null; i < 24; i++) {
        await lib.sleep(300);
        after = (await page.evaluate(CHAT)) || after;
        const now = after ? after.lines.join('|') : '';
        if (now === last) break;
        last = now;
      }
      const row = { q, replyMs: Date.now() - sent, reply: after ? after.lines.slice(before + 1).join(' / ').slice(0, 300) : null, buttons: after ? newButtons(b0, after.buttons) : [], badge: after ? after.badge : null };
      await t.shot(page, `firstplay-${prof}-${key}.png`);
      // Press the reply's button, and read where it leads.
      if (row.buttons.length) {
        const xy = await page.evaluate((label) => {
          const c = window.__app.ui.npcChatDiv;
          const b = c && [...c.querySelectorAll('button')].reverse().find((x) => (x.getAttribute('aria-label') || x.textContent || '').replace(/\s+/g, ' ').trim() === label);
          if (!b) return null;
          b.scrollIntoView({ block: 'center' });
          const r = b.getBoundingClientRect();
          return [r.left + r.width / 2, r.top + r.height / 2];
        }, row.buttons[0]);
        await tapOrClick(page, touch, xy);
        await lib.sleep(1200);
        row.led = await page.evaluate(TOP);
        await t.shot(page, `firstplay-${prof}-${key}-button.png`);
        await page.evaluate(() => {
          const ui = window.__app.ui;
          if (ui.panels.current() && ui.panels.current() !== 'npc-chat') ui.panels.closeTop();
        });
        await lib.sleep(500);
      }
      out.asked[key] = row;
      t.log(`${prof} "${q}": ${JSON.stringify(row)}`);
    }
    await page.keyboard.press('Escape');
    await page.evaluate(() => window.__app.ui.closeNpcChat && window.__app.ui.closeNpcChat());
    const closedAt = await G.ptime(page);
    await lib.sleep(6000);
    // GP-08: the talk hint must not come back once the visitor has talked.
    out.talkHintAfterChat = (await P.gpEvents(page, closedAt)).filter((e) => e.ev === 'show' && /villager.*Claude Haiku|talks through/i.test(e.text)).map((e) => e.text.slice(0, 80));
    out.sounds = ((await P.audio(page, EXPLORE_AT)) || { log: [] }).log.length;
    t.data[prof] = out;
    const A = out.asked;
    const ok = (k) => A[k] && !A[k].error;
    t.check(`${prof}: the trail's villager opens a chat`, out.chatOpened.opened, out.chatOpened.opened ? `${who.name} (${who.from})` : `${who.name}: ${out.chatOpened.walk}`, 'a chat');
    // P2-D4, with the backend blocked.
    t.check(`${prof}: 'What does Abbas build?' names Projects and offers a button`, ok('build') ? /Projects/.test(A.build.reply || '') && A.build.buttons.length > 0 : null, ok('build') ? { reply: (A.build.reply || '').slice(0, 110), buttons: A.build.buttons } : (A.build || {}).error, 'Projects + a button');
    t.check(`${prof}: its button opens the Projects panel`, ok('build') ? !!(A.build.led && A.build.led.panel === 'zone' && /Project/i.test(A.build.led.h2 || '')) : null, ok('build') ? A.build.led || 'no button' : (A.build || {}).error, "panel 'zone', Projects");
    t.check(`${prof}: 'How do I contact him?' leads to the hire card`, ok('contact') ? !!(A.contact.led && A.contact.led.hire) : null, ok('contact') ? A.contact.led || { reply: (A.contact.reply || '').slice(0, 110), buttons: A.contact.buttons } : (A.contact || {}).error, 'the hire card');
    t.check(`${prof}: 'Where is the shop?' offers 'Show me'`, ok('shop') ? A.shop.buttons.some((b) => /show me/i.test(b)) : null, ok('shop') ? { reply: (A.shop.reply || '').slice(0, 110), buttons: A.shop.buttons, compassAfter: A.shop.led ? A.shop.led.compass : null } : (A.shop || {}).error, "a 'Show me' button");
    t.check(`${prof}: 'Nice weather?' gets a written line and no button`, ok('weather') ? !!A.weather.reply && A.weather.buttons.length === 0 : null, ok('weather') ? { reply: (A.weather.reply || '').slice(0, 110), buttons: A.weather.buttons } : (A.weather || {}).error, 'a line, no button');
    const badge = (A.weather || A.build || {}).badge;
    t.check(`${prof}: the badge reads 'offline replies' once a reply fell back`, badge === 'offline replies', badge, 'offline replies');
    t.check(`${prof}: no talk hint returns after the chat`, out.talkHintAfterChat.length === 0, out.talkHintAfterChat.length ? out.talkHintAfterChat : 'none', 'none');
  }
}

// --------------------------------------------------------------------- race
const RACE = () => {
  const sc = window.__app.scene;
  const r = sc.races;
  const ui = window.__app.ui;
  const rect = (el) => {
    if (!el || !el.isConnected) return null;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || parseFloat(cs.opacity) < 0.05) return null;
    const b = el.getBoundingClientRect();
    return b.width > 2 ? [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)] : null;
  };
  return {
    state: r ? r.state : null,
    nextIdx: r ? r.nextIdx : null,
    hud: ui.raceDiv && rect(ui.raceDiv) ? (ui.raceDiv.innerText || '').replace(/\s+/g, ' ').trim() : null,
    hudRect: rect(ui.raceDiv),
    pillRect: rect(ui.compassDiv),
    compass: window.__h && window.__h.compassFull ? window.__h.compassFull() : null,
    toast: ui.toastEl && rect(ui.toastEl) ? (ui.toastEl.innerText || '').replace(/\s+/g, ' ').trim() : null,
    riding: sc.isRidingVehicle(),
  };
};
/** Board the craft nearest the circuit's start and put it 14 u before ring 0, heading through it. */
const RACE_SETUP = ({ kind, craft }) => {
  const sc = window.__app.scene;
  const c = sc.races && sc.races.circuits ? sc.races.circuits[kind] : null;
  if (!c || !c.dirs || c.dirs.length < 3) return { error: 'hook missing: scene.races.circuits' };
  const start = sc.getRaceStartPosition(kind);
  const want = craft ? [craft] : kind === 'land' ? ['car'] : ['jetski', 'boat'];
  let idx = -1;
  let best = Infinity;
  for (let i = 0; i < sc.vehicles.length; i++) {
    if (!want.includes(sc.vehicleKind(i)) || sc.vehicles[i].occupied) continue;
    const d = sc.vehicles[i].group.position.distanceTo(start);
    if (d < best) {
      best = d;
      idx = i;
    }
  }
  if (idx < 0) return { error: `no free ${want.join(' or ')}` };
  const v = sc.vehicles[idx];
  const isl = sc.getIsland();
  const R = isl.getRadius();
  const a = c.dirs[0].clone().normalize();
  const b = c.dirs[1].clone().normalize();
  const fwd = b.clone().addScaledVector(a, -b.dot(a)).normalize();
  // 14 u back along the leg's great circle, facing ring 0.
  const th = 14 / R;
  const back = a.clone().multiplyScalar(Math.cos(th)).addScaledVector(fwd, -Math.sin(th)).normalize();
  const f2 = a.clone().addScaledVector(back, -a.dot(back)).normalize();
  sc.boardVehicle(idx);
  if (!sc.isRidingVehicle()) return { error: 'boardVehicle did not board' };
  window.__race = { kind, idx };
  // --craft: start from where that craft is parked, as a visitor would.
  if (craft) return { idx, craft: sc.vehicleKind(idx), craftToStartU: +best.toFixed(1), rings: c.dirs.length, parked: true };
  v.dir.copy(back);
  v.forward.copy(f2);
  if (kind === 'land') {
    const s = isl.sampleSurfaceByDirection(v.dir, 0);
    v.radius = s.position.length() + 0.06;
    v.normal.copy(s.normal);
  }
  const oc = sc.getOrbitCamera();
  if (oc.followDir) oc.followDir.copy(f2).negate();
  if (typeof oc.snapToPlayer === 'function') oc.snapToPlayer();
  window.__race = { kind, idx };
  return { idx, craft: sc.vehicleKind(idx), craftToStartU: +best.toFixed(1), rings: c.dirs.length, legU: +(a.angleTo(b) * R).toFixed(1) };
};
/** The steering error: the next gate (or the compass arrow) against the craft's heading, in degrees, + = to the right. */
const RACE_STEER = ({ driver }) => {
  const sc = window.__app.scene;
  const g = window.__race;
  const r = sc.races;
  const c = r.circuits[g.kind];
  const v = sc.vehicles[g.idx];
  const isl = sc.getIsland();
  const R = isl.getRadius();
  const up = v.dir.clone().normalize();
  const next = c.dirs[r.state === 'running' ? r.nextIdx : 0].clone().normalize();
  const dist = up.angleTo(next) * R;
  let rel;
  if (driver === 'compass') {
    // Only what the pill shows: its arrow's screen bearing (A1's sign: + is clockwise, to the right).
    const a = window.__h.arrow();
    rel = a ? a.rel : null;
  } else {
    const to = next.clone().addScaledVector(up, -next.dot(up)).normalize();
    const f = v.forward.clone().addScaledVector(up, -v.forward.dot(up)).normalize();
    rel = (-Math.atan2(f.clone().cross(to).dot(up), f.dot(to)) * 180) / Math.PI;
  }
  // Is the next ring above the visitor's horizon? Camera height and ring-top
  // height over the sea-level sphere give each one's horizon distance.
  const cam = sc.getCamera().position;
  const hCam = Math.max(0.05, cam.length() - isl.analyticSurface(cam.clone().normalize()).radius);
  const ringTop = (c.surfaceR ? c.surfaceR[r.state === 'running' ? r.nextIdx : 0] : R) + 2.5 - isl.analyticSurface(next).radius;
  const horizon = Math.sqrt(2 * R * hCam) + Math.sqrt(2 * R * Math.max(0, ringTop));
  const camToRing = cam.clone().normalize().angleTo(next) * R;
  return { rel, dist: +dist.toFixed(1), state: r.state, nextIdx: r.nextIdx, belowHorizon: camToRing > horizon, camToRingU: +camToRing.toFixed(1), horizonU: +horizon.toFixed(1), riding: sc.isRidingVehicle() };
};

/**
 * --legs: every consecutive ring spacing on both circuits (ring i to i+1, and
 * the last back to the finish, ring 0), great-circle u, against the chase
 * camera's own horizon on foot: sqrt(2 R h), h its height over the player's
 * feet (the audit's 1.37 u).
 */
const RACE_LEGS = () => {
  const sc = window.__app.scene;
  const isl = sc.getIsland();
  const R = isl.getRadius();
  const cam = sc.getCamera().position;
  const pl = sc.getPlayer().getWorldPosition();
  // The audit's horizon: the camera's height over the player's feet (1.37 u).
  const hCam = cam.length() - pl.length();
  const horizon = Math.sqrt(2 * R * Math.max(0.05, hCam));
  const out = { R: +R.toFixed(1), camAbovePlayerU: +hCam.toFixed(2), camAboveGroundU: +(cam.length() - isl.analyticSurface(cam.clone().normalize()).radius).toFixed(2), horizonU: +horizon.toFixed(1), circuits: {} };
  for (const kind of ['land', 'water']) {
    const c = sc.races && sc.races.circuits ? sc.races.circuits[kind] : null;
    if (!c || !c.dirs) continue;
    const d = c.dirs.map((x) => x.clone().normalize());
    const legs = d.map((a, i) => +(a.angleTo(d[(i + 1) % d.length]) * R).toFixed(1));
    out.circuits[kind] = { rings: d.length, legs, meanU: +(legs.reduce((s, x) => s + x, 0) / legs.length).toFixed(1), maxU: Math.max(...legs), overHorizon: legs.filter((x) => x > horizon).length };
  }
  return out;
};
/**
 * The boat against the shore. A craft's step onto land is refused
 * (GameScene keeps craft on the sea), so a beaching reads as: the bow (1.5 u
 * ahead along its forward) over land and the hull not moving between polls.
 */
const BOAT = () => {
  const sc = window.__app.scene;
  const g = window.__race;
  const v = sc.vehicles[g.idx];
  const r = sc.races;
  const isl = sc.getIsland();
  const R = isl.getRadius();
  const up = v.dir.clone().normalize();
  const f = v.forward.clone().addScaledVector(up, -v.forward.dot(up)).normalize();
  const bow = up.clone().multiplyScalar(Math.cos(1.5 / R)).addScaledVector(f, Math.sin(1.5 / R)).normalize();
  const prev = g.prevDir || up.clone();
  const movedU = prev.angleTo(up) * R;
  g.prevDir = up.clone();
  return { bowOnLand: !isl.isOverWater(bow), movedU: +movedU.toFixed(3), state: r.state, nextIdx: r.nextIdx, riding: sc.isRidingVehicle() };
};
/** --craft boat: the gates driver from the parked boat for ms (backing out after 4 s aground); beachings and checkpoints passed. */
async function driveBoat(page, ms) {
  let held = new Set();
  const set = async (keys) => {
    for (const k of [...held]) if (!keys.has(k)) await page.keyboard.up(k);
    for (const k of keys) await page.keyboard.down(k);
    held = keys;
  };
  let beachings = 0;
  let free = 4;
  let stuckMs = 0;
  let lastIdx = null;
  let passed = 0;
  let started = false;
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const s = await page.evaluate(RACE_STEER, { driver: 'gates' }).catch(() => null);
    const b = await page.evaluate(BOAT).catch(() => null);
    if (!s || !b || !b.riding) break;
    // A beaching: the throttle held, the bow on land and the hull stopped.
    // A new beaching only after 0.5 s afloat and moving (4 polls), so one
    // grounding the steer rocks against counts once.
    const beached = held.has('w') && b.bowOnLand && b.movedU < 0.05;
    if (beached && free >= 4) beachings++;
    free = beached ? 0 : free + 1;
    // Stuck 4 s: back out and try again, as driveLap's driver does.
    stuckMs = beached ? stuckMs + 120 : 0;
    if (stuckMs > 4000) {
      stuckMs = 0;
      await set(new Set(['s']));
      await lib.sleep(900);
      continue;
    }
    if (b.state === 'running') {
      if (!started) started = true;
      else if (b.nextIdx !== lastIdx) passed++;
      lastIdx = b.nextIdx;
    }
    if (s.rel === null || Math.abs(s.rel) < 10) await set(new Set(['w']));
    else await set(new Set(['w', s.rel > 0 ? 'd' : 'a']));
    await lib.sleep(120);
  }
  await set(new Set());
  return { beachings, checkpointsPassed: passed, started, ms: Date.now() - t0 };
}

async function driveLap(page, driver, maxMs) {
  let held = new Set();
  const set = async (keys) => {
    for (const k of [...held]) if (!keys.has(k)) await page.keyboard.up(k);
    for (const k of keys) await page.keyboard.down(k);
    held = keys;
  };
  const cps = [];
  const toasts = new Set();
  let lastIdx = null;
  let started = null;
  let finished = null;
  let stallAt = null;
  let lastDist = null;
  let stalls = 0;
  const stallLog = [];
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    const s = await page.evaluate(RACE_STEER, { driver }).catch(() => null);
    if (!s || !s.riding) break;
    if (s.state === 'running' && started === null) started = Date.now();
    if (started !== null && s.state === 'idle') {
      finished = Date.now();
      break;
    }
    if (s.state === 'running' && s.nextIdx !== lastIdx) {
      // A checkpoint just passed (or the start): what the visitor has to go on for the next ring.
      const r = await page.evaluate(RACE);
      const ov = r.hudRect && r.pillRect ? Math.max(0, Math.min(r.hudRect[0] + r.hudRect[2], r.pillRect[0] + r.pillRect[2]) - Math.max(r.hudRect[0], r.pillRect[0])) * Math.max(0, Math.min(r.hudRect[1] + r.hudRect[3], r.pillRect[1] + r.pillRect[3]) - Math.max(r.hudRect[1], r.pillRect[1])) : 0;
      cps.push({ next: s.nextIdx, belowHorizon: s.belowHorizon, camToRingU: s.camToRingU, horizonU: s.horizonU, compass: r.compass, hud: r.hud, pillCoveredPct: r.pillRect ? Math.round((100 * ov) / (r.pillRect[2] * r.pillRect[3])) : null });
      lastIdx = s.nextIdx;
    }
    if (s.state === 'running') {
      const r = await page.evaluate(RACE).catch(() => null);
      if (r && r.toast) toasts.add(r.toast.slice(0, 80));
    }
    // A stall: no progress toward the next ring for 4 s.
    if (lastDist !== null && Math.abs(s.dist - lastDist) < 0.3) {
      if (stallAt === null) stallAt = Date.now();
      else if (Date.now() - stallAt > 4000) {
        stalls++;
        stallLog.push({ atS: +((Date.now() - t0) / 1000).toFixed(1), state: s.state, next: s.nextIdx, distU: s.dist });
        stallAt = null;
        // Back out and try again, as a driver would.
        await set(new Set(['s']));
        await lib.sleep(900);
      }
    } else stallAt = null;
    lastDist = s.dist;
    if (s.rel === null) await set(new Set(['w']));
    else if (Math.abs(s.rel) < 10) await set(new Set(['w']));
    else await set(new Set(['w', s.rel > 0 ? 'd' : 'a']));
    await lib.sleep(120);
  }
  await set(new Set());
  return { started: started !== null, finished: finished !== null, lapS: started !== null && finished !== null ? +((finished - started) / 1000).toFixed(1) : null, checkpoints: cps, toasts: [...toasts], stalls, stallLog, ms: Date.now() - t0 };
}

const FINISH = () => {
  const ov = document.getElementById('ui-overlay');
  const tops = [...ov.children].filter((d) => getComputedStyle(d).display !== 'none' && +getComputedStyle(d).zIndex >= 1500 && d.getBoundingClientRect().width > 120);
  // The panel manager's open modal too, wherever it sits in the overlay.
  const pm = window.__app.ui.panels;
  const top = pm && typeof pm.topModal === 'function' ? pm.topModal() : null;
  if (top && top.el && top.el.isConnected && !tops.some((d) => d === top.el || d.contains(top.el))) tops.push(top.el);
  const text = tops.map((d) => (d.innerText || '').replace(/\s+/g, ' ').trim()).join(' || ');
  const nameInput = [...document.querySelectorAll('#ui-overlay input')].find((i) => /name/i.test(`${i.placeholder || ''} ${i.getAttribute('aria-label') || ''}`) && i.getBoundingClientRect().width > 2);
  const mp = window.__app.multiplayer;
  return { panel: window.__app.ui.panels.current(), text: text.slice(0, 500), namePrompt: !!nameInput, selfName: mp && mp.selfName ? mp.selfName : null, storedName: localStorage.getItem('ds_player_name'), buttons: [...document.querySelectorAll('#ui-overlay button')].filter((b) => b.getBoundingClientRect().width > 2).map((b) => (b.textContent || '').replace(/\s+/g, ' ').trim()).filter((x) => /retry|board|leaderboard/i.test(x)) };
};

async function raceLegs(t) {
  for (const prof of t.profiles(['desktop'])) {
    const s = await t.session(prof);
    const { page } = s;
    await t.boot(s, { query: 'hour=12' });
    await lib.sleep(1000);
    await explore(page, false);
    await skipGuide(page);
    await lib.sleep(1500);
    const legs = await page.evaluate(RACE_LEGS);
    await s.close();
    t.data[prof] = { legs };
    for (const kind of ['land', 'water']) {
      const c = legs.circuits[kind];
      t.check(`${prof}: ${kind} circuit ring spacing against the chase-camera horizon (reported)`, c ? true : null, c ? { rings: c.rings, meanU: c.meanU, maxU: c.maxU, legs: c.legs, overHorizon: `${c.overHorizon} of ${c.legs.length}`, horizonU: legs.horizonU } : null, `reported (58c8849: ${kind === 'land' ? '115.5' : '103.9'} u, horizon 16.5 u)`);
    }
  }
}

async function raceBoat(t) {
  for (const prof of t.profiles(['desktop'])) {
    const s = await t.session(prof, { init: [P.SAMPLER], skipName: false });
    const { page } = s;
    await t.boot(s, { query: 'hour=12' });
    await lib.sleep(1000);
    await explore(page, false);
    await skipGuide(page);
    await lib.sleep(1500);
    const setup = await page.evaluate(RACE_SETUP, { kind: 'water', craft: 'boat' });
    if (setup.error) throw new Error(setup.error);
    await lib.sleep(1200);
    await t.shot(page, `race-${prof}-boat-start.png`);
    const run = await driveBoat(page, 49000);
    await t.shot(page, `race-${prof}-boat-end.png`);
    await s.close();
    t.data[prof] = { setup, run };
    t.check(`${prof}: from the parked boat, checkpoints passed in 49 s (GP-03)`, run.checkpointsPassed >= 5, { passed: run.checkpointsPassed, started: run.started, craftToStartU: setup.craftToStartU }, '5 of 5 (58c8849: 0 of 5)');
    t.check(`${prof}: beachings with the throttle held`, run.beachings === 0, run.beachings, '0 (58c8849: 9)');
  }
}

async function race(t) {
  if (t.args.legs) return raceLegs(t);
  if (t.args.craft === 'boat') return raceBoat(t);
  const driver = t.args.driver === 'compass' ? 'compass' : 'gates';
  const kind = t.args.circuit === 'water' ? 'water' : 'land';
  const all = [];
  for (const prof of t.profiles(['desktop', 'phone'])) {
    const touch = lib.isTouchProfile(prof);
    const s = await t.session(prof, { init: [P.SAMPLER], skipName: false });
    const { page } = s;
    const out = { driver, kind };
    await t.boot(s, { query: 'hour=12' });
    await lib.sleep(1000);
    await explore(page, touch);
    await skipGuide(page);
    await lib.sleep(1500);
    out.setup = await page.evaluate(RACE_SETUP, { kind });
    if (out.setup.error) throw new Error(out.setup.error);
    await lib.sleep(1200);
    out.before = await page.evaluate(RACE);
    await t.shot(page, `race-${prof}-${kind}-start.png`);
    out.lap = await driveLap(page, driver, 150000);
    await lib.sleep(2500);
    out.finish = await page.evaluate(FINISH);
    await t.shot(page, `race-${prof}-${kind}-finish.png`);
    // The name prompt sits over the finish modal: skip it, as a browsing
    // visitor would, and read the finish behind it (D10's 'Couldn't reach').
    if (out.finish.namePrompt) {
      out.namePromptText = out.finish.text.slice(0, 160);
      const xy = await page.evaluate(() => {
        const m = window.__app.ui.nameModalDiv;
        const b = m && [...m.querySelectorAll('button')].find((x) => /^skip/i.test((x.textContent || '').trim()));
        if (!b) return null;
        const r = b.getBoundingClientRect();
        return [r.left + r.width / 2, r.top + r.height / 2];
      });
      out.nameSkipped = await tapOrClick(page, touch, xy);
      await lib.sleep(2500);
      out.finish = { ...(await page.evaluate(FINISH)), namePrompt: true };
      await t.shot(page, `race-${prof}-${kind}-finish-after-name.png`);
    }
    // A second finish must not ask for the name again (reported when the lap finished).
    t.data[prof] = out;
    const cps = out.lap.checkpoints;
    all.push(...cps);
    t.log(`${prof}: ${JSON.stringify({ setup: out.setup, lap: { ...out.lap, checkpoints: cps.length }, finish: out.finish })}`);
    // The gates driver knows where the rings are, so its lap only has to finish; a
    // visitor has the compass alone, and that lap must not stall (GP-03).
    t.check(`${prof}: the ${kind} lap finishes with the '${driver}' driver${driver === 'compass' ? ', with no stall' : ''}`, out.lap.finished && (driver !== 'compass' || out.lap.stalls === 0), { finished: out.lap.finished, lapS: out.lap.lapS, stalls: out.lap.stalls, checkpoints: cps.length }, driver === 'compass' ? 'finished, 0 stalls' : 'finished');
    const covered = cps.filter((c) => c.pillCoveredPct !== null).map((c) => c.pillCoveredPct);
    t.check(`${prof}: the race HUD leaves the compass pill clear (share of the pill it covers, %)`, covered.length ? Math.max(...covered) === 0 : null, covered.length ? Math.max(...covered) : 'no pill on screen', '0');
    const labels = cps.map((c) => c.compass);
    t.check(`${prof}: at each checkpoint the compass names the next ring`, cps.length ? labels.every((l) => /^\W*(Ring|Finish)/i.test(l || '')) : null, labels.slice(0, 6), "starts with 'Ring' or 'Finish'");
    const district = out.lap.toasts.filter((x) => /Personal|Professional|Projects|Contact|Get In Touch|Welcome Hub/i.test(x));
    t.check(`${prof}: no district toast between 'Go!' and the finish`, out.lap.started ? district.length === 0 : null, district.length ? district : 'none', 'none');
    if (out.lap.finished) {
      t.check(`${prof}: the finish does not claim 'on the board' with the backend blocked`, !/on the board/i.test(out.finish.text), /on the board/i.test(out.finish.text) ? out.finish.text.slice(0, 160) : "no 'on the board'", "never 'on the board'");
      t.check(`${prof}: the finish says it could not reach the board, with Retry`, /couldn.t reach/i.test(out.finish.text) && out.finish.buttons.some((b) => /retry/i.test(b)), { text: out.finish.text.slice(0, 160), buttons: out.finish.buttons }, "'Couldn't reach' + Retry");
      t.check(`${prof}: a fresh visitor is asked for a name at the first finish`, out.finish.namePrompt || !!out.finish.storedName, { namePrompt: out.finish.namePrompt, selfName: out.finish.selfName, storedName: out.finish.storedName }, 'a name prompt');
    }
  }
  // GP-03: with nothing pointing at it, is the next ring even in sight?
  const below = all.filter((c) => c.belowHorizon).length;
  t.data.checkpoints = { total: all.length, belowHorizon: below };
  t.check('checkpoints where the next ring is below the horizon', all.length ? true : null, `${below} of ${all.length}`, 'reported (main: 10 of 10; the compass has to point there)');
}

// ------------------------------------------------------------------- quests
async function quests(t) {
  for (const prof of t.profiles(['desktop'])) {
    const touch = lib.isTouchProfile(prof);
    const s = await t.session(prof, { init: [P.SAMPLER, P.AUDIO] });
    const { page } = s;
    const T = touch ? await lib.touch(s) : null;
    const out = {};
    await t.boot(s, { query: 'hour=12' });
    await lib.sleep(1000);
    await explore(page, touch);
    await skipGuide(page);
    await lib.sleep(1500);
    await page.evaluate(P.HELPERS);
    // The School: six presses.
    const school = await page.evaluate(() => {
      const p = window.__app.scene.schoolPos();
      return p ? p.toArray() : null;
    });
    if (!school) throw new Error('hook missing: scene.schoolPos()');
    await page.evaluate(TP_NEAR, { p: school, dist: 1.2 });
    await lib.sleep(1200);
    const c0 = await page.evaluate(() => window.__app.scene.getCoinsCollected());
    const prompt0 = await page.evaluate(() => window.__g.prompt());
    const at = await G.ptime(page);
    const t0 = Date.now();
    for (let i = 0; i < 6; i++) {
      await useKey(page, touch, T);
      await lib.sleep(380);
    }
    const pressMs = Date.now() - t0;
    await lib.sleep(1200);
    const c1 = await page.evaluate(() => window.__app.scene.getCoinsCollected());
    await t.shot(page, `quests-${prof}-school.png`);
    await lib.sleep(9000);
    const lessonToasts = (await P.gpEvents(page, at)).filter((e) => (e.ev === 'show' || e.ev === 'text') && /Lesson/i.test(e.text)).map((e) => e.text.slice(0, 110));
    out.school = { prompt: prompt0, coinsBefore: c0, coinsAfter: c1, paid: c1 - c0, pressSeconds: +(pressMs / 1000).toFixed(1), lessonToasts: [...new Set(lessonToasts)] };
    t.log(`${prof} school: ${JSON.stringify(out.school)}`);
    // GP-04: six presses used to pay +60 in 2 s; the fix pays one lesson (+10) a visit.
    t.check(`${prof}: six presses at the School pay (coins)`, /lesson/i.test(prompt0 || '') ? out.school.paid <= 10 : null, /lesson/i.test(prompt0 || '') ? out.school.paid : `no lesson prompt at the School: '${prompt0}'`, '<= +10 (main: +60)');

    // P2-E2c: the canteen double press (P2-A6). Two E presses 150 ms apart,
    // empty-handed: coins and soups before and after.
    const canteen = await page.evaluate(() => {
      const p = window.__app.scene.canteenPos();
      return p ? p.toArray() : null;
    });
    if (canteen) {
      await page.evaluate(() => {
        const a = window.__app;
        a.produce = 0;
        if (a.scene.getCoinsCollected() < 10) a.scene.addCoins(10 - a.scene.getCoinsCollected());
      });
      await page.evaluate(TP_NEAR, { p: canteen, dist: 2.0 });
      await lib.sleep(900);
      const before = await page.evaluate(() => ({ coins: window.__app.scene.getCoinsCollected(), soup: window.__app.meals ? window.__app.meals.soup : null, prompt: window.__g.prompt() }));
      await useKey(page, touch, T);
      await lib.sleep(150);
      await useKey(page, touch, T);
      await lib.sleep(1200);
      const after = await page.evaluate(() => ({ coins: window.__app.scene.getCoinsCollected(), soup: window.__app.meals ? window.__app.meals.soup : null }));
      out.canteen = { prompt: before.prompt, coinsBefore: before.coins, coinsAfter: after.coins, soupBefore: before.soup, soupAfter: after.soup, bought: after.soup !== null && before.soup !== null ? after.soup - before.soup : null };
      t.log(`${prof} canteen: ${JSON.stringify(out.canteen)}`);
      t.check(`${prof}: a canteen double press buys one soup`, /soup/i.test(before.prompt || '') && out.canteen.bought !== null ? out.canteen.bought === 1 : null, out.canteen, '1 soup, -3 coins');
    } else out.canteen = { note: 'no scene.canteenPos()' };

    // The Elder Sage: the prompt says she has a request, and after it E opens the chat.
    const sage = await page.evaluate(() => {
      const sc = window.__app.scene;
      const n = sc.getIsland().npcTargets.find((x) => /Elder Sage/.test(x.name));
      if (!n) return null;
      return { name: n.name, pos: n.meshRef.getWorldPosition(sc.getPlayer().getWorldPosition().clone()).toArray(), visible: n.meshRef.visible };
    });
    if (sage) {
      // Teleport beside her and keep station until her prompt shows (the walk
      // from 4 u timed out on the wave-2 build); walk only as a fallback.
      let walk = await besideNpc(page, sage.name, 6000);
      if (walk !== 'prompt') walk = await G.walkToNpc(page, sage.name, 15000);
      const prompt = await page.evaluate(() => window.__g.prompt());
      out.sage = { walk, prompt };
      if (walk === 'prompt') {
        await useKey(page, touch, T);
        await lib.sleep(1500);
        out.sage.firstE = await page.evaluate(() => ({ dialogue: window.__app.ui.isDialogueActive(), panel: window.__app.ui.panels.current() }));
        await t.shot(page, `quests-${prof}-sage.png`);
        // Page through her quest lines, then E once more.
        for (let i = 0; i < 12 && (await page.evaluate(() => window.__app.ui.isDialogueActive())); i++) {
          await useKey(page, touch, T);
          await lib.sleep(650);
        }
        await lib.sleep(600);
        let again = await besideNpc(page, sage.name, 4000);
        if (again !== 'prompt') again = await G.walkToNpc(page, sage.name, 6000);
        if (again === 'prompt') await useKey(page, touch, T);
        await lib.sleep(2200);
        out.sage.secondE = await page.evaluate(() => ({ dialogue: window.__app.ui.isDialogueActive(), panel: window.__app.ui.panels.current() }));
        await page.evaluate(() => {
          const ui = window.__app.ui;
          if (ui.closeNpcChat) ui.closeNpcChat();
          if (ui.panels.closeAll) ui.panels.closeAll();
        });
      }
      t.log(`${prof} sage: ${JSON.stringify(out.sage)}`);
      t.check(`${prof}: the Elder Sage's prompt says she has a request`, walk === 'prompt' ? /request/i.test(prompt || '') : null, prompt || walk, "contains 'request'");
      t.check(`${prof}: after her quest lines, E opens the chat`, out.sage.secondE ? out.sage.secondE.panel === 'npc-chat' : null, out.sage.secondE || walk, "panel 'npc-chat'");
    }
    // GP-07: the parcel prompt at a glowing mailbox names the key.
    const mail = await page.evaluate(() => {
      const a = window.__app;
      const d = a.delivery || a.deliverySystem || (a.scene.getDeliverySystem && a.scene.getDeliverySystem());
      const dest = d && (d.destination || (d.getDestination && d.getDestination()));
      const p = dest && (dest.position || (dest.getPosition && dest.getPosition()) || dest.pos);
      return p && p.toArray ? p.toArray() : a.lastCompassTarget && /Delivery|Parcel/i.test(window.__h.compassFull() || '') ? a.lastCompassTarget.toArray() : null;
    });
    if (mail) {
      await page.evaluate(TP_NEAR, { p: mail, dist: 1.6 });
      await lib.sleep(1500);
      out.mailbox = { prompt: await page.evaluate(() => window.__g.prompt()) };
      t.check(`${prof}: the prompt at the parcel's mailbox names the key`, out.mailbox.prompt ? /Press E|Tap .*USE/i.test(out.mailbox.prompt) : null, out.mailbox.prompt || 'no prompt at the mailbox', "'Press E' or 'Tap USE'");
    } else out.mailbox = { note: 'no delivery destination found through the app hooks' };
    out.sounds = ((await P.audio(page, 0)) || { log: [] }).log.length;
    t.data[prof] = out;
  }
}

module.exports = {
  firstplay: { item: 'P2-E2b (GP-02, GP-08; P2-D4)', title: "the first play: the trail, its villager, and five questions with the backend blocked (the reply, its button, where the button leads, the badge)", profiles: ['desktop', 'phone'], run: firstplay },
  race: { item: 'P2-E2b (GP-03, GP-05; P2-A7, D10)', title: "a lap by the gates' positions (or --driver compass: by the compass pill alone): the next ring against the horizon, the HUD over the pill, district toasts, the finish modal, the name prompt. --legs: every ring spacing on both circuits against the horizon; --circuit water --craft boat: from the parked boat, beachings and checkpoints in 49 s (P2-E2d)", profiles: ['desktop', 'phone'], run: race },
  quests: { item: 'P2-E2b (GP-04, GP-07, GP-10; P2-A7); P2-E2c canteen', title: "six presses at the School, the canteen double press (coins and soups), the Elder Sage's prompt and what E does after her quest, the parcel prompt", profiles: ['desktop'], run: quests },
  // Helpers for the top-level npc.cjs (functions, not probes: run.cjs registers only {run}).
  openChat,
  besideNpc,
  useKey,
  CHAT,
  TP_NEAR,
};
