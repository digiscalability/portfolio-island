'use strict';
// Phase-2 gameplay probes, part 3 (P2-E2c), on p2/play-lib.cjs: fishing,
// gather, bobber, shop and tour. The gameplay audit's g4a, g4b, g4d, g3-shop
// and g10-tour were session temp files and are gone, so these are rebuilt
// from its report (docs/history/2026-11-03-ux-audit/phase2/gameplay.json:
// GP-01, GP-04, GP-06, GP-09, GP-12) and checked against the numbers it
// recorded on 58c8849. Every row that reads a wave-3 feature (the '!' sprite,
// the Hats-tab dock, 'Next:', 'Your visit', the wait prompt) reads it
// optionally and reports null on a build without it.
//
//   npm run probe -- p2/fishing [--device desk|phone] --dist dist --port <n>
//   npm run probe -- p2/gather  [--device desk|phone] --dist dist --port <n>
//   npm run probe -- p2/bobber  [--device desk|phone] [--hours 12,18,21] --dist dist --port <n>
//   npm run probe -- p2/shop    [--device desk|phone] --dist dist --port <n>
//   npm run probe -- p2/tour    [--device desk|phone] [--teleport] --dist dist --port <n>
const lib = require('../lib.cjs');
const P = require('./play-lib.cjs');
const R = require('./room-lib.cjs');

/** The last window 'ds:goals' detail (P2-D10's feed), kept from the first script. */
const GOALS_INIT = `(() => {
  if (window.top !== window) return;
  window.__goals = { n: 0, last: null };
  window.addEventListener('ds:goals', (e) => { window.__goals.n++; window.__goals.last = e.detail || null; });
})();`;

async function start(t, prof, { localStorage, init = [] } = {}) {
  const touch = lib.isTouchProfile(prof);
  const s = await t.session(prof, { init: [P.SAMPLER, GOALS_INIT, ...init], localStorage });
  const { page } = s;
  const T = touch ? await lib.touch(s) : null;
  const boot = await t.boot(s);
  await lib.sleep(800);
  const sel = `${lib.WELCOME} button[data-dismiss]`;
  if (touch) await page.tap(sel).catch(() => page.click(sel));
  else await page.click(sel);
  await lib.sleep(600);
  // First steps (A6) steps aside where this build has it.
  await page.evaluate(() => {
    const g = document.getElementById('ds-guide');
    const b = g && [...g.querySelectorAll('button,[role=button]')].find((x) => /skip/i.test(`${x.getAttribute('aria-label') || ''} ${x.textContent || ''}`));
    if (b) b.click();
  });
  await lib.sleep(1200);
  await page.evaluate(P.HELPERS);
  return { s, page, touch, T, boot };
}

async function useKey(page, touch, T) {
  if (touch && T) {
    const u = await T.useBtn();
    if (u) return T.tap(u[0], u[1]);
  }
  return page.keyboard.press('e');
}

const prompt = (page) => page.evaluate(() => (window.__g ? window.__g.prompt() : null));
const coins = (page) => page.evaluate(() => window.__app.scene.getCoinsCollected());

/** Stand `dist` u from world point p along tangent angle `ang` (radians about the local up), on the ground. */
const STAND = ({ p, dist, ang }) => {
  const sc = window.__app.scene;
  const V3 = sc.getPlayer().getWorldPosition().constructor;
  const c = new V3(p[0], p[1], p[2]);
  const n = c.clone().normalize();
  const ref = Math.abs(n.y) < 0.9 ? new V3(0, 1, 0) : new V3(1, 0, 0);
  const tan = ref.clone().addScaledVector(n, -ref.dot(n)).normalize().applyAxisAngle(n, ang || 0);
  const d = c.clone().addScaledVector(tan, dist).normalize();
  const s = sc.getIsland().sampleSurfaceByDirection(d, 0);
  sc.getPlayer().setWorldPosition(d.multiplyScalar(s.position.length() + 0.75));
  return true;
};

// --------------------------------------------------------------- fishing kit
const FISH = () => {
  const sc = window.__app.scene;
  const F = sc.playerFishing;
  return { active: sc.isFishingActive(), biting: sc.isFishBiting(), phase: F ? F.phase : null, canCast: sc.canCastHere() };
};

/** Find a shore spot by the fisherman where this build offers the cast prompt. */
async function toShore(page, k0 = 0) {
  const fp = await page.evaluate(() => {
    const p = window.__app.scene.fishermanPos();
    return p ? p.toArray() : null;
  });
  if (!fp) throw new Error('hook missing: scene.fishermanPos()');
  // 12 headings x 5 distances: a villager who wanders up takes the prompt
  // (talk outranks the cast), so a spot is kept only while it shows 'cast'.
  for (let k = k0; k < k0 + 60; k++) {
    const ang = ((k % 12) / 12) * Math.PI * 2;
    const dist = [2.5, 4, 6, 8, 10][Math.floor(k / 12) % 5];
    await page.evaluate(STAND, { p: fp, dist, ang });
    await lib.sleep(700);
    const st = await page.evaluate(FISH);
    if (st.canCast && /cast/i.test((await prompt(page)) || '')) return { k, dist, ang: +ang.toFixed(2) };
  }
  return null;
}

/** Stand at a known spot again; when its prompt is no longer the cast's, find another. */
async function reShore(page, sp) {
  const fp = await page.evaluate(() => window.__app.scene.fishermanPos().toArray());
  await page.evaluate(STAND, { p: fp, dist: sp.dist, ang: sp.ang });
  await lib.sleep(600);
  if (/cast/i.test((await prompt(page)) || '')) return sp;
  return (await toShore(page, sp.k + 1)) || (await toShore(page, 0));
}

/** Cast, and wait for the float to land in the water (the 'wait' phase). */
async function cast(page, touch, T) {
  await useKey(page, touch, T);
  const t0 = Date.now();
  let st = await page.evaluate(FISH);
  while (Date.now() - t0 < 2500 && st.phase !== 'wait' && st.phase !== 'bite') {
    await lib.sleep(60);
    st = await page.evaluate(FISH);
  }
  return { t0, landedMs: st.phase === 'wait' || st.phase === 'bite' ? Date.now() - t0 : null, st };
}

async function untilIdle(page, ms = 12000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (!(await page.evaluate(FISH)).active) return true;
    await lib.sleep(150);
  }
  return false;
}

async function fishing(t) {
  for (const prof of t.profiles(['desktop', 'phone'])) {
    const { page, touch, T } = await start(t, prof, { localStorage: { ds_rod: '1' } });
    const out = {};
    out.shore = await toShore(page);
    if (!out.shore) {
      t.check(`${prof}: a shore spot offers the cast prompt`, false, await prompt(page), "'cast a line'");
      t.data[prof] = out;
      continue;
    }
    // 1. E at 1.4 s after the cast (GP-06: it cancelled the cast on 58c8849).
    const c1 = await cast(page, touch, T);
    // 1.4 s after the cast, and inside the wait: on a loaded host the flight
    // can take longer than 1.4 s, then the press waits 0.3 s past the landing.
    const pressAt = Math.max(1400, (c1.landedMs ?? 1100) + 300);
    while (Date.now() - c1.t0 < pressAt) await lib.sleep(40);
    out.waitPrompt = await prompt(page);
    const at = Date.now();
    await useKey(page, touch, T);
    await lib.sleep(500);
    const after = await page.evaluate(FISH);
    const toasts = (await P.gpEvents(page, 0)).filter((e) => e.t >= 0 && (e.ev === 'show' || e.ev === 'text')).map((e) => e.text);
    out.e14 = { pressAtMs: at - c1.t0, landedMs: c1.landedMs, activeAfter: after.active, phaseAfter: after.phase, toast: toasts.filter((x) => /nothing|not yet|wait/i.test(x)).slice(-1)[0] || null };
    t.check(`${prof}: E 1.4 s after the cast leaves the line in (isFishingActive)`, after.active, out.e14, 'true (58c8849: false, the cast is lost)');
    t.check(`${prof}: the wait prompt says neither reel nor splash`, out.waitPrompt === null ? null : !/reel|splash/i.test(out.waitPrompt), out.waitPrompt, "no 'reel', no 'splash' (58c8849: 'Press E to reel in')");
    await untilIdle(page);
    // 2. A 0.6 s E hold during the wait reels early (A's P2-A6 contract).
    out.shore = (await reShore(page, out.shore)) || out.shore;
    const c2 = await cast(page, touch, T);
    let hold = null;
    if (c2.landedMs !== null && !touch) {
      await page.keyboard.down('e');
      await lib.sleep(650);
      const mid = await page.evaluate(FISH);
      await page.keyboard.up('e');
      await lib.sleep(300);
      const end = await page.evaluate(FISH);
      hold = { activeAt650ms: mid.active, activeAfterRelease: end.active, phaseAt650ms: mid.phase };
    }
    out.hold = hold;
    t.check(`${prof}: a 0.6 s E hold in the wait reels the line in`, hold ? !hold.activeAt650ms : null, hold || (touch ? 'keyboard only' : 'no wait phase'), 'line out within 0.65 s');
    await untilIdle(page);
    // 3. The bite: when it comes and what the prompt says.
    out.shore = (await reShore(page, out.shore)) || out.shore;
    const c3 = await cast(page, touch, T);
    let bite = null;
    const t3 = Date.now();
    while (Date.now() - t3 < 15000) {
      const st = await page.evaluate(FISH);
      if (st.biting) {
        bite = { afterCastMs: Date.now() - c3.t0, prompt: await prompt(page) };
        break;
      }
      await lib.sleep(50);
    }
    if (bite) {
      await t.shot(page, `fishing-${prof}-bite.png`);
      const k0 = await page.evaluate(() => window.__app.fishCaught || 0);
      await useKey(page, touch, T);
      await lib.sleep(600);
      bite.caught = (await page.evaluate(() => window.__app.fishCaught || 0)) - k0;
    }
    out.bite = bite;
    t.check(`${prof}: a bite comes 3-9 s after the cast and E lands it`, bite ? bite.caught === 1 : false, bite, 'caught 1 (58c8849: bites 3.8-8.4 s)');
    t.data[prof] = out;
  }
}

// ---------------------------------------------------------------- gather kit
/** Every stake / crop pairing within 16 u of the farm: where the stake and a harvestable crop are both in reach. */
const CONFLICTS = async (page) =>
  page.evaluate(async () => {
    const a = window.__app;
    const sc = a.scene;
    const fp = sc.farmPos();
    if (!fp) return { error: 'no farmPos' };
    const V3 = fp.constructor;
    const n = fp.clone().normalize();
    const ref = Math.abs(n.y) < 0.9 ? new V3(0, 1, 0) : new V3(1, 0, 0);
    const e1 = ref.clone().addScaledVector(n, -ref.dot(n)).normalize();
    const e2 = n.clone().cross(e1);
    const both = [];
    const stakeOnly = [];
    const pl = sc.getPlayer();
    for (let i = -16; i <= 16; i += 1)
      for (let j = -16; j <= 16; j += 1) {
        const d = fp.clone().addScaledVector(e1, i).addScaledVector(e2, j).normalize();
        const s = sc.getIsland().sampleSurfaceByDirection(d, 0);
        pl.setWorldPosition(d.multiplyScalar(s.position.length() + 0.75));
        const b = typeof a.nearestBuildOpportunity === 'function' ? a.nearestBuildOpportunity() : null;
        // The crop scan is cached at 5 Hz (harvestScanAt): clear it per spot.
        sc.harvestScanAt = 0;
        const crop = sc.nearestHarvestableCrop();
        sc.harvestScanAt = 0;
        if (b && b.dist < 3.5 && crop !== null) both.push({ i, j, stake: +b.dist.toFixed(2), system: b.system });
        else if (b && b.dist < 3.5 && b.system === 'build' && crop === null && sc.nearestChoppableTree() === null && sc.nearestOreNode() === null) stakeOnly.push({ i, j, stake: +b.dist.toFixed(2) });
      }
    return { both, stakeOnly, e1: e1.toArray(), e2: e2.toArray(), fp: fp.toArray() };
  });
const AT_GRID = ({ fp, e1, e2, i, j }) => {
  const sc = window.__app.scene;
  const V3 = sc.getPlayer().getWorldPosition().constructor;
  const d = new V3(...fp).addScaledVector(new V3(...e1), i).addScaledVector(new V3(...e2), j).normalize();
  const s = sc.getIsland().sampleSurfaceByDirection(d, 0);
  sc.getPlayer().setWorldPosition(d.multiplyScalar(s.position.length() + 0.75));
  return true;
};
const PANEL = () => (window.__app.ui.panels ? window.__app.ui.panels.current() : null);

async function gather(t) {
  for (const prof of t.profiles(['desktop', 'phone'])) {
    const { page, touch, T } = await start(t, prof, { localStorage: { ds_sickle: '1' } });
    const out = {};
    // 1. Four harvest presses beside the farm's stake (GP-12).
    const g = await CONFLICTS(page);
    out.conflicts = { both: g.both ? g.both.length : null, stakeOnly: g.stakeOnly ? g.stakeOnly.length : null, error: g.error };
    const presses = [];
    if (g.both && g.both.length) {
      for (let k = 0; k < 4; k++) {
        const spot = g.both[Math.min(k, g.both.length - 1)];
        await page.evaluate(AT_GRID, { fp: g.fp, e1: g.e1, e2: g.e2, i: spot.i, j: spot.j });
        await lib.sleep(500);
        const pr = await prompt(page);
        const before = await page.evaluate(() => window.__app.produce || 0);
        await useKey(page, touch, T);
        await lib.sleep(700);
        const panel = await page.evaluate(PANEL);
        const produced = (await page.evaluate(() => window.__app.produce || 0)) - before;
        presses.push({ spot, prompt: pr && pr.slice(0, 80), harvested: produced > 0, panel });
        if (panel) await page.evaluate(() => window.__app.ui.panels.closeAll());
        await lib.sleep(300);
      }
    }
    out.presses = presses;
    t.check(`${prof}: 4 harvest presses beside the farm's stake harvest`, presses.length ? presses.filter((p) => p.harvested).length === 4 : null, presses.length ? `${presses.filter((p) => p.harvested).length}/4 (panels: ${presses.map((p) => p.panel).join(',')})` : 'no stake-and-crop spot found', "4/4 (58c8849: 0/4 at spots where a stake under 3.5 u and a ripe crop are both in reach; the audit's 1 of 4 was four presses across the farm)");
    // 2. At a stake with no tool action, E opens the chooser.
    if (g.stakeOnly && g.stakeOnly.length) {
      const sp = g.stakeOnly[0];
      await page.evaluate(AT_GRID, { fp: g.fp, e1: g.e1, e2: g.e2, i: sp.i, j: sp.j });
      await lib.sleep(500);
      out.stake = { prompt: await prompt(page) };
      await useKey(page, touch, T);
      await lib.sleep(800);
      out.stake.panel = await page.evaluate(PANEL);
      await page.evaluate(() => window.__app.ui.panels.closeAll());
    }
    t.check(`${prof}: E at a bare stake opens the chooser`, out.stake ? !!out.stake.panel : null, out.stake || 'no bare stake within 16 u of the farm', 'a panel opens');
    // 3. The mailbox prompt names its key, and the next-district toast after a collect.
    const mb = await page.evaluate(() => {
      const d = window.__app.deliverySystem;
      const act = d && d.getActiveDeliveries ? d.getActiveDeliveries() : [];
      const m = act[0] && act[0].destination;
      if (!m) return null;
      const p = m.mesh.getWorldPosition(m.mesh.position.clone());
      return p.toArray();
    });
    if (mb) {
      await page.evaluate(STAND, { p: mb, dist: 1.5, ang: 0 });
      await lib.sleep(900);
      out.mailbox = { prompt: await prompt(page) };
      const since = await page.evaluate(() => Math.round(performance.now()));
      await useKey(page, touch, T);
      // The toast queues behind whatever is on screen (the arrival toast, a
      // quest card), so it is read for up to 8 s, not 2.5: the integration
      // saw 'Delivered. The next parcel waits near ...' land 79-108 ms after
      // E when nothing was queued, and outside a 2.5 s window when it was.
      const NEXT = (x) => /next parcel waits near/i.test(x) || (/Welcome Hub|Professional|Project|Personal|Get In Touch|School|harbour|kiosk/i.test(x) && /deliver|parcel|next|mailbox/i.test(x));
      let ev = [];
      for (let waited = 0; waited < 8000; waited += 250) {
        await lib.sleep(250);
        ev = (await P.gpEvents(page, since)).filter((e) => e.ev === 'show' || e.ev === 'text');
        if (ev.some((e) => NEXT(e.text))) break;
      }
      const hit = ev.find((e) => NEXT(e.text));
      out.mailbox.toasts = [...new Set(ev.map((e) => e.text.slice(0, 140)))].slice(0, 6);
      out.mailbox.nextDistrictToast = hit ? hit.text.slice(0, 140) : null;
      out.mailbox.nextDistrictToastAfterMs = hit ? Math.round(hit.t - since) : null;
    }
    const mp = out.mailbox ? out.mailbox.prompt : null;
    t.check(`${prof}: the mailbox prompt names its key`, mp === null ? null : touch ? /Tap|USE/i.test(mp) : /Press\s*(<strong>)?\s*E|\[E\]/i.test(mp), mp || 'no active delivery mailbox', touch ? "'Tap USE'" : "'Press E' (58c8849: the bubble text alone)");
    t.check(`${prof}: after a collect, a toast names the next delivery's district`, out.mailbox ? !!out.mailbox.nextDistrictToast : null, out.mailbox ? out.mailbox.nextDistrictToast || out.mailbox.toasts : 'no mailbox', 'a district name');
    // 4. The delivery chain: hop lengths in the order the deliveries unlock.
    out.chain = await page.evaluate(() => {
      const d = window.__app.deliverySystem;
      const list = d && d.deliveries;
      if (!list) return null;
      const pts = list.map((x) => x.destination && x.destination.mesh.getWorldPosition(x.destination.mesh.position.clone())).filter(Boolean);
      const arc = (a, b) => a.clone().normalize().angleTo(b.clone().normalize()) * ((a.length() + b.length()) / 2);
      const hops = [];
      for (let i = 1; i < pts.length; i++) hops.push(Math.round(arc(pts[i - 1], pts[i])));
      return { n: pts.length, hops, total: hops.reduce((s, x) => s + x, 0) };
    });
    t.check(`${prof}: the delivery chain is 1,000 u or less`, out.chain ? out.chain.total <= 1000 : null, out.chain ? out.chain.total : 'no deliveries', '<= 1000 u (58c8849: 1,643 u)');
    t.data[prof] = out;
  }
}

// ---------------------------------------------------------------- bobber kit
/** The float against the avatar's projected box (mesh bounds x matrixWorld, never setFromObject). */
const FLOAT_VS_AVATAR = () => {
  const sc = window.__app.scene;
  const cam = sc.getCamera();
  const F = sc.playerFishing;
  const b = F && F.bobber;
  if (!b || !b.visible) return null;
  const V = b.position.constructor;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  // The avatar's own posed vertices (a skinned mesh's bind-pose bounds are far
  // wider than the pose), sampled to at most ~300 a mesh; the rod and the
  // line are left out (they are not the avatar's body).
  const skip = new Set([sc.playerRod, sc.fishLine].filter(Boolean));
  const tmp = new V();
  sc.getPlayer().traverse((m) => {
    if (!m.isMesh || !m.geometry || !m.visible || !m.geometry.attributes.position) return;
    for (let o = m; o; o = o.parent) if (skip.has(o)) return;
    const a = m.geometry.attributes.position;
    const step = Math.max(1, Math.floor(a.count / 300));
    for (let i = 0; i < a.count; i += step) {
      if (m.isSkinnedMesh) m.getVertexPosition(i, tmp);
      else tmp.fromBufferAttribute(a, i);
      const v = tmp.applyMatrix4(m.matrixWorld).project(cam);
      minX = Math.min(minX, v.x);
      maxX = Math.max(maxX, v.x);
      minY = Math.min(minY, v.y);
      maxY = Math.max(maxY, v.y);
    }
  });
  const f = b.getWorldPosition(new V()).project(cam);
  const W = innerWidth;
  const H = innerHeight;
  const px = (x, y) => [Math.round(((x + 1) / 2) * W), Math.round(((1 - y) / 2) * H)];
  const inside = f.x >= minX && f.x <= maxX && f.y >= minY && f.y <= maxY;
  const onScreen = f.z < 1 && Math.abs(f.x) <= 1 && Math.abs(f.y) <= 1;
  // Sprites over the float (within 1.6 u, radially above it). The '!' (wave
  // 3, B) is one that is there at the bite and was not during the wait: the
  // caller diffs two of these lists (a lamp's glow sprite is there in both).
  const near = [];
  const bp = b.getWorldPosition(new V());
  sc.traverseVisible((o) => {
    if (!o.isSprite) return;
    const w = o.getWorldPosition(new V());
    if (w.distanceTo(bp) < 1.6 && w.length() > bp.length()) near.push(o.uuid);
  });
  return { float: px(f.x, f.y), avatar: [...px(minX, maxY), ...px(maxX, minY)], inside, onScreen, near };
};

/**
 * The chase camera settled behind the avatar's visual forward (+Z): the view
 * of a visitor who walked up to the shore. (Settling it along the cast line
 * instead puts the float behind the avatar in nearly every cast: 1 of 8 clear
 * on desktop, 0 on the phone, on both baselines; too adversarial to compare
 * with the audit's 3 of 8 inside.)
 */
const BEHIND = () => {
  const sc = window.__app.scene;
  const pl = sc.getPlayer();
  const p = pl.getWorldPosition();
  const up = p.clone().normalize();
  const fwd = p.clone().set(0, 0, 1).applyQuaternion(pl.quaternion);
  fwd.addScaledVector(up, -fwd.dot(up)).normalize();
  const oc = sc.getOrbitCamera();
  if (oc.followDir) oc.followDir.copy(fwd).negate();
  oc.yawVelocity = 0;
  if (oc.snapToPlayer) oc.snapToPlayer();
  return true;
};

/** Point the chase camera at the nearest open water (16 bearings, 6 u out), so a step forward faces the sea. */
const AIM_WATER = () => {
  const sc = window.__app.scene;
  const isl = sc.getIsland();
  const p = sc.getPlayer().getWorldPosition();
  const up = p.clone().normalize();
  const ref = Math.abs(up.y) < 0.9 ? p.clone().set(0, 1, 0) : p.clone().set(1, 0, 0);
  const e1 = ref.addScaledVector(up, -ref.dot(up)).normalize();
  for (const reach of [4, 6, 8, 11]) {
    for (let k = 0; k < 16; k++) {
      const t = e1.clone().applyAxisAngle(up, (k / 16) * Math.PI * 2);
      const cand = up.clone().add(t.clone().multiplyScalar(reach / isl.getRadius())).normalize();
      if (isl.isOverWater(cand)) {
        const oc = sc.getOrbitCamera();
        if (oc.followDir) oc.followDir.copy(t).negate();
        oc.yawVelocity = 0;
        if (oc.snapToPlayer) oc.snapToPlayer();
        return { reach, k };
      }
    }
  }
  return null;
};

/** Face the water like a visitor who walked to the shore: aim, one short step, settle. */
async function faceWater(page) {
  const a = await page.evaluate(AIM_WATER);
  if (!a) return null;
  await page.keyboard.down('w');
  await lib.sleep(120);
  await page.keyboard.up('w');
  await lib.sleep(500);
  return a;
}

/**
 * A hard budget per cast and per hour (wave-4 carry-over): the live run of
 * 2026-11-14 stalled after desktop cast 0 for over 20 min with Chrome busy
 * and had to be stopped by PID. Past the budget the step is abandoned, the
 * session is closed (which settles the abandoned evaluate) and the rows it
 * feeds read null.
 */
const BOBBER_CAST_MS = 60000;
const BOBBER_HOUR_MS = 45000;
const STALLED = Symbol('stalled');
async function within(ms, fn) {
  let timer = null;
  const work = fn();
  work.catch(() => undefined);
  try {
    return await Promise.race([work, new Promise((r) => (timer = setTimeout(() => r(STALLED), ms)))]);
  } finally {
    clearTimeout(timer);
  }
}

async function bobber(t) {
  const hours = String(t.args.hours || '12,18,21').split(',').map(Number);
  // --cast-ms <n> shortens both budgets (the stall path is checked with --cast-ms 1500).
  const castMs = Number(t.args.castMs) || BOBBER_CAST_MS;
  const hourMs = Number(t.args.castMs) || BOBBER_HOUR_MS;
  for (const prof of t.profiles(['desktop', 'phone'])) {
    const { s, page, touch, T } = await start(t, prof, { localStorage: { ds_rod: '1' } });
    const out = { casts: [], bites: {}, stalled: null };
    // The shore spots by the fisherman that offer a cast (up to 36 tried).
    const spots = [];
    const found = await within(150000, async () => {
      for (let k = 0; k < 36 && spots.length < 8; ) {
        const sp = await toShore(page, k);
        if (!sp) break;
        spots.push(sp);
        k = sp.k + 1;
      }
      return true;
    });
    if (found === STALLED) out.stalled = 'the shore-spot search over 150 s';
    out.spots = spots.length;
    // Eight casts, cycling the spots, each with the chase camera settled
    // behind the avatar's facing (the view a visitor who walked up has).
    for (let c = 0; c < 8 && spots.length && !out.stalled; c++) {
      const sp = spots[c % spots.length];
      const done = await within(castMs, async () => {
        const sp2 = await reShore(page, sp);
        if (sp2) Object.assign(sp, sp2);
        await faceWater(page);
        if (!/cast/i.test((await prompt(page)) || '')) {
          const sp3 = await reShore(page, sp);
          if (sp3) Object.assign(sp, sp3);
        }
        await page.evaluate(BEHIND);
        await lib.sleep(500);
        const r = await cast(page, touch, T);
        await lib.sleep(400);
        const v = await page.evaluate(FLOAT_VS_AVATAR);
        out.casts.push({ spot: sp, landedMs: r.landedMs, ...(v || { float: null }) });
        if (c === 0) await t.shot(page, `bobber-${prof}-cast0.png`);
        await page.evaluate(() => {
          const sc = window.__app.scene;
          if (sc.isFishingActive()) sc.reelLine();
        });
        await untilIdle(page, 4000);
        return true;
      });
      if (done === STALLED) out.stalled = `cast ${c} over ${castMs / 1000} s`;
    }
    const judged = out.casts.filter((c) => c.float);
    // Clear = not inside the avatar's projected box; a float off the edge of
    // the screen is counted apart (it is not hidden by the avatar, nor seen).
    const clear = judged.filter((c) => !c.inside).length;
    const off = judged.filter((c) => !c.onScreen).length;
    t.check(`${prof}: the float clears the avatar's box in 7 of 8 casts`, judged.length >= 8 ? clear >= 7 : null, `${clear}/${judged.length} (off screen: ${off})${out.stalled ? `; stalled at ${out.stalled}` : ''}`, '>= 7/8 (the audit, 58c8849: inside the box in 3 of 8)');
    // The bite at each hour, with its screenshot ('!' sprite where the build has it).
    // Each hour reads null on its own when no free shore spot is found, the
    // bite is missed in 15 s or the hour runs past its budget.
    const env = out.stalled ? false : await within(10000, () => page.evaluate(() => 'debugHour' in window.__app.scene.getEnvironmentCycle()));
    for (const h of hours) {
      if (out.stalled) {
        out.bites[h] = { missing: `not run (stalled at ${out.stalled})` };
        continue;
      }
      const got = await within(hourMs, async () => {
        if (env === true) await page.evaluate((hh) => (window.__app.scene.getEnvironmentCycle().debugHour = hh), h);
        await lib.sleep(800);
        if (!spots.length || !(await reShore(page, spots[0]))) return { missing: 'no free shore spot' };
        await faceWater(page);
        await page.evaluate(BEHIND);
        await lib.sleep(500);
        const c0 = await cast(page, touch, T);
        await lib.sleep(300);
        const waiting = await page.evaluate(FLOAT_VS_AVATAR);
        let bite = null;
        while (Date.now() - c0.t0 < 15000) {
          if ((await page.evaluate(FISH)).biting) {
            bite = await page.evaluate(FLOAT_VS_AVATAR);
            await t.shot(page, `bobber-${prof}-h${h}-bite.png`);
            break;
          }
          await lib.sleep(60);
        }
        if (bite) {
          const before = new Set((waiting && waiting.near) || []);
          const fresh = bite.near.filter((u) => !before.has(u));
          bite.bang = fresh.length > 0;
        }
        await page.evaluate(() => {
          const sc = window.__app.scene;
          if (sc.isFishingActive()) sc.reelLine();
        });
        await untilIdle(page, 4000);
        return bite || { missing: 'no bite in 15 s' };
      });
      if (got === STALLED) {
        out.stalled = `the ${h} h cast over ${hourMs / 1000} s`;
        out.bites[h] = { missing: 'stalled' };
      } else out.bites[h] = got;
    }
    // 58c8849 has no '!' at all: with no bang at any hour the rows read null
    // (this build has none), not fail.
    const any = Object.values(out.bites).some((b) => b && b.bang === true);
    for (const h of hours) {
      const b = out.bites[h];
      t.check(`${prof}: the bite shows the '!' sprite at ${h} h`, !b || b.missing || !any ? null : b.bang, b ? b.missing || (b.bang ? 'sprite' : 'no sprite') : 'not run', "a sprite above the float (null: no bite, no shore spot, or this build has none)");
    }
    if (out.stalled) await s.close().catch(() => undefined);
    t.data[prof] = out;
  }
}

// ------------------------------------------------------------------ shop kit
const SHOP_COUNT = async (page) =>
  page.evaluate(async () => {
    const ui = window.__app.ui;
    const d = ui.shopDiv;
    if (!d || !d.isConnected) return null;
    const per = {};
    for (const tab of ['tools', 'supplies', 'hats']) {
      const b = d.querySelector(`button[data-shop-tab="${tab}"]`);
      if (b) b.click();
      await new Promise((r) => setTimeout(r, 60));
      const rows = [...d.querySelectorAll('button[data-shop-id]')];
      per[tab] = { n: rows.length, enabled: rows.filter((x) => !x.disabled).length };
    }
    const total = Object.values(per).reduce((s, x) => s + x.n, 0);
    const enabled = Object.values(per).reduce((s, x) => s + x.enabled, 0);
    return { per, total, enabled, text: (d.innerText || '').replace(/\s+/g, ' ').slice(0, 400) };
  });
const SHOP_VS_AVATAR = () => {
  const sc = window.__app.scene;
  const d = window.__app.ui.shopDiv;
  if (!d) return null;
  const r = d.getBoundingClientRect();
  const p = sc.getPlayer().getWorldPosition().clone();
  p.addScaledVector(p.clone().normalize(), 0.9);
  const v = p.project(sc.getCamera());
  const c = [((v.x + 1) / 2) * innerWidth, ((1 - v.y) / 2) * innerHeight];
  return { shop: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)], avatar: c.map(Math.round), inside: c[0] >= r.left && c[0] <= r.right && c[1] >= r.top && c[1] <= r.bottom };
};

async function openKiosk(page, touch, T) {
  const kp = await page.evaluate(() => {
    const p = window.__app.scene.kioskPos();
    return p ? p.toArray() : null;
  });
  if (!kp) throw new Error('hook missing: scene.kioskPos()');
  for (const ang of [0, 1.6, 3.1, 4.7]) {
    await page.evaluate(STAND, { p: kp, dist: 2.2, ang });
    await lib.sleep(600);
    if (/kiosk/i.test((await prompt(page)) || '')) {
      await useKey(page, touch, T);
      await lib.sleep(900);
      if (await page.evaluate(() => !!(window.__app.ui.shopDiv && window.__app.ui.shopDiv.isConnected))) return true;
    }
  }
  // Fallback: the kiosk's own callback, the path E takes.
  await page.evaluate(() => window.__app.openShop());
  await lib.sleep(900);
  return 'callback';
}

async function shop(t) {
  for (const prof of t.profiles(['desktop', 'phone'])) {
    const { page, touch, T } = await start(t, prof);
    const out = {};
    // The trail's coins: a visitor who follows it reaches the kiosk with them.
    out.trail = await page.evaluate(() => {
      const sc = window.__app.scene;
      return { left: sc.trailCoinsLeft ?? null, coins: sc.getCoinsCollected() };
    });
    const want = 5;
    await page.evaluate((w) => {
      const sc = window.__app.scene;
      const c = sc.getCoinsCollected();
      if (c < w) sc.addCoins(w - c);
    }, want);
    out.coins = await coins(page);
    out.opened = await openKiosk(page, touch, T);
    out.count = await SHOP_COUNT(page);
    t.check(`${prof}: items affordable with the trail's ${want} coins`, out.count ? true : null, out.count ? `${out.count.enabled}/${out.count.total} (${JSON.stringify(out.count.per)})` : 'no shop', 'reported (58c8849: 2 of 20)');
    // The 'Show me' line with nothing affordable (P2-D7).
    await page.evaluate(() => window.__app.ui.panels.closeAll());
    await page.evaluate(() => {
      const sc = window.__app.scene;
      sc.spendCoins(sc.getCoinsCollected());
    });
    await openKiosk(page, touch, T);
    const broke = await SHOP_COUNT(page);
    out.showMe = broke ? (/Show me/i.test(broke.text) ? broke.text.match(/[^.]*Show me[^.]*/i)[0].trim().slice(0, 120) : null) : null;
    t.check(`${prof}: with nothing affordable, the shop says 'Show me' where to earn`, broke ? (out.showMe ? true : null) : null, out.showMe || 'no Show me line on this build', "a 'Show me' line (null: not built yet)");
    // The Hats tab and the avatar (GP-09): desktop dock, phone equip toast.
    await page.evaluate(() => window.__app.ui.panels.closeAll());
    await page.evaluate(() => window.__app.scene.addCoins(60));
    await openKiosk(page, touch, T);
    await page.evaluate(() => {
      const b = window.__app.ui.shopDiv && window.__app.ui.shopDiv.querySelector('button[data-shop-tab="hats"]');
      if (b) b.click();
    });
    await lib.sleep(700);
    out.hats = await page.evaluate(SHOP_VS_AVATAR);
    await t.shot(page, `shop-${prof}-hats.png`);
    if (!touch) t.check(`${prof}: with the Hats tab open the avatar's centre is outside the shop`, out.hats ? !out.hats.inside : null, out.hats, 'outside (58c8849: inside, the shop is a centred modal)');
    const since = await page.evaluate(() => Math.round(performance.now()));
    // Since P2-D3 an outcome inside the open shop is a status line pinned in
    // the modal ([data-panel-note], appended to the top modal's element), not
    // a toast: every note is recorded from the first click, with its delay
    // after the click before it.
    const bought = await page.evaluate(async () => {
      const d = window.__app.ui.shopDiv;
      const b = d && [...d.querySelectorAll('button[data-shop-id]')].find((x) => !x.disabled);
      if (!b) return null;
      const notes = [];
      const clicks = [];
      const read = () => {
        for (const n of document.querySelectorAll('[data-panel-note]')) {
          const text = (n.textContent || '').trim();
          if (!text || notes.some((x) => x.text === text)) continue;
          const now = performance.now();
          const last = clicks.filter((c) => c <= now).slice(-1)[0];
          const sd = window.__app.ui.shopDiv;
          notes.push({ text: text.slice(0, 120), afterClickMs: last === undefined ? null : Math.round(now - last), inShop: !!(sd && sd.contains(n)) });
        }
      };
      const mo = new MutationObserver(read);
      mo.observe(document.body, { subtree: true, childList: true, characterData: true });
      const id = b.getAttribute('data-shop-id');
      clicks.push(performance.now());
      b.click();
      await new Promise((r) => setTimeout(r, 500));
      const d2 = window.__app.ui.shopDiv;
      const b2 = d2 && d2.querySelector(`button[data-shop-id="${id}"]`);
      if (b2 && /Equip$/.test(b2.textContent.trim()) && !b2.disabled) {
        clicks.push(performance.now());
        b2.click();
      }
      await new Promise((r) => setTimeout(r, 1000));
      read();
      mo.disconnect();
      const b3 = window.__app.ui.shopDiv && window.__app.ui.shopDiv.querySelector(`button[data-shop-id="${id}"]`);
      return { id, label: b3 ? b3.textContent.trim() : null, clicks: clicks.length, notes };
    });
    await lib.sleep(700);
    await t.shot(page, `shop-${prof}-equipped.png`);
    const ev = (await P.gpEvents(page, since)).filter((e) => e.ev === 'show' || e.ev === 'text').map((e) => e.text.slice(0, 120));
    const HAT = /wear|equip|hat|cap|looking/i;
    const note = bought ? bought.notes.find((x) => HAT.test(x.text) && x.afterClickMs !== null && x.afterClickMs <= 1000) || null : null;
    out.equip = { bought, toast: ev.find((x) => HAT.test(x) && !/Island Shop/.test(x)) || null, note };
    t.check(`${prof}: equipping a hat says so (a toast, or the shop's [data-panel-note] within 1 s)`, bought ? !!(out.equip.toast || out.equip.note) : null, out.equip.note ? `note ${out.equip.note.afterClickMs} ms after the click${out.equip.note.inShop ? ', inside the shop' : ''}: ${out.equip.note.text}` : out.equip, 'a toast or a note (58c8849: none)');
    t.data[prof] = out;
  }
}

// ------------------------------------------------------------------ tour kit
const TOUR = ['projects', 'professional', 'personal', 'contact'];
const VISIT = () => {
  const a = window.__app;
  const g = window.__goals && window.__goals.last;
  let stamps = null;
  try {
    const raw = localStorage.getItem('ds_passport');
    const v = raw ? JSON.parse(raw) : null;
    stamps = Array.isArray(v) ? v.length : v && typeof v === 'object' ? Object.keys(v).length : null;
  } catch (e) {}
  return {
    goals: g ? { visit: g.visit || null, next: g.next ? { label: g.next.label, guideKey: g.next.guideKey } : null, done: g.done, total: g.total } : null,
    goalsEvents: window.__goals ? window.__goals.n : 0,
    stamps,
    coins: a.scene.getCoinsCollected(),
    minutes: +((performance.now() - (a.visitStartedAt || 0)) / 60000).toFixed(1),
  };
};

async function tour(t) {
  for (const prof of t.profiles(['desktop', 'phone'])) {
    // No REWARD_INIT here: the fourth stamp's celebration is what this reads.
    const { page, touch, T } = await start(t, prof);
    await R.install(page);
    const out = { stops: [] };
    const t0 = Date.now();
    for (const id of TOUR) {
      await R.outdoors(page);
      if (!t.args.teleport) {
        const door = await page.evaluate((i) => {
          const b = window.__ia.building(i);
          return b ? b.door.toArray() : null;
        }, id);
        if (door) out.stops.push({ id, walk: (({ ms, arrived }) => ({ ms, arrived }))(await P.walkTo(page, door, { within: 4, maxMs: 70000, run: true })) });
      }
      const e = await R.enterRoom(page, id, { touch, T, back: 3.0, walkMs: 4000 });
      await lib.sleep(1800);
      const st = await page.evaluate(() => ({ inside: window.__app.scene.isInsideInterior(), panel: window.__app.ui.panels.current() }));
      out.stops.push({ id, press: e.press, ...st, visit: await page.evaluate(VISIT) });
    }
    // After the fourth stamp: the celebration's 'Next:' and its 'Your visit' block.
    const card = await page.evaluate(() => {
      const ov = document.getElementById('ui-overlay');
      // The celebration, not the hall's zone panel under it: the panel stack's
      // 'passport-complete' entry, else a dialog that reads like it.
      const pm = window.__app.ui.panels;
      const st = (pm && pm.stack) || [];
      const ent = st.find((e) => e && e.id === 'passport-complete');
      const dlg = (ent && ent.spec && ent.spec.el) || [...(ov ? ov.querySelectorAll('[role=dialog], [role=alertdialog]') : [])].filter((d) => d.isConnected && getComputedStyle(d).display !== 'none' && /passport|crown|wear it/i.test(d.innerText || '')).pop();
      const txt = dlg ? (dlg.innerText || '').replace(/\s+/g, ' ').trim() : null;
      return { panel: window.__app.ui.panels.current(), text: txt ? txt.slice(0, 500) : null };
    });
    await t.shot(page, `tour-${prof}-celebration.png`);
    out.card = card;
    out.visit = await page.evaluate(VISIT);
    out.seconds = Math.round((Date.now() - t0) / 1000);
    const nextM = card.text && card.text.match(/Next:\s*([^.→]+)/);
    const visitM = card.text && /Your visit/i.test(card.text);
    out.cardNext = nextM ? nextM[1].trim().slice(0, 80) : null;
    out.cardVisit = visitM ? card.text.slice(card.text.search(/Your visit/i), card.text.search(/Your visit/i) + 160) : null;
    t.check(`${prof}: all four districts stamped`, out.visit.stamps === null ? null : out.visit.stamps >= 4, out.visit.stamps, '4');
    t.check(`${prof}: coins after the four districts`, true, out.visit.coins, `reported (58c8849, walked: 5; wave 4 P2-A10 wants 25 or more)`);
    t.check(`${prof}: the celebration names a 'Next:' goal`, card.text ? (out.cardNext ? true : null) : null, out.cardNext || card.text || `no celebration card (panel ${card.panel})`, "'Next: <goal>' (null: not built yet)");
    const v = out.visit.goals && out.visit.goals.visit;
    t.check(`${prof}: the celebration's 'Your visit' block matches the counts`, out.cardVisit ? (v ? new RegExp(`\\b${v.stamps}\\b`).test(out.cardVisit) : null) : null, { card: out.cardVisit, goals: v }, "'Your visit' with the ds:goals counts (null: not built yet)");
    t.data[prof] = out;
  }
}

module.exports = {
  fishing: { item: 'P2-E2c (GP-06; P2-A6)', title: "the cast: E at 1.4 s (cancels the cast on 58c8849), the wait prompt, a 0.6 s E hold, the bite's time and the catch", profiles: ['desktop', 'phone'], run: fishing },
  gather: { item: 'P2-E2c (GP-12, GP-01, GP-07; P2-A6)', title: "4 harvest presses beside the farm stake, E at a bare stake, the mailbox prompt's key, the next-district toast, the delivery chain's length", profiles: ['desktop', 'phone'], run: gather },
  bobber: { item: 'P2-E2c (GP-06; P2-B7)', title: "the float against the avatar's box in 8 shore casts, and the bite's '!' at 12, 18 and 21 h", profiles: ['desktop', 'phone'], run: bobber },
  shop: { item: 'P2-E2c (GP-04, GP-09; P2-D7)', title: "the kiosk with the trail's coins (what is affordable), 'Show me' with none, the Hats tab against the avatar, the equip toast", profiles: ['desktop', 'phone'], run: shop },
  tour: { item: 'P2-E2c (GP-01, GP-04; P2-D10, P2-A10)', title: "the four districts walked and stamped: coins, minutes, the ds:goals visit, and the celebration's 'Next:' and 'Your visit'", profiles: ['desktop', 'phone'], run: tour },
};
