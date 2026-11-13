'use strict';
// First steps (A6), scripted from FM-07's spec (E6a). At 1440x900, 390x844
// touch, 844x390 and 667x375: Explore, then walk, look (drag, swipe), talk,
// portfolio and compass, the way each device does them. It reports:
// - each step's time from the end of its action to done (<= 1 s), and
//   Explore to the finale "You're set" (<= 60 s);
// - Skip (writes skipped, hides the card), resume after a reload with two
//   steps done (at 3/5), and the one-line chip after 20 s on a step;
// - document.getAnimations() inside #ds-guide under reduced motion (none);
// - the card's rect, at every step, with the chip up and at the finale,
//   against the joystick (bottom-left 166x166), the action column,
//   [data-hud=prompt], the minimap, the compass pill and the viewport edges,
//   and, sampled every 300 ms for the whole flow, against any toast or flash
//   that comes up (no overlap);
// - the compass label after the finale's 'Show me' buttons (Projects, School);
// - legacy storage: the controls card once, then, after that card has gone
//   (its OK or its 8 s), the first undone step;
// - hint toasts shown while the guide is active (none, once D6 lands);
// - B10: the last trail coin's distance to the seat of the villager the
//   trail leads to (scene.getTrailVillager(); the nearest villager on a build
//   without it), and whether that villager talks through Claude Haiku 4.5
//   (its prompt says 'ask anything');
// - night (?hour=23, after 12 s on the welcome card so the night's sleep
//   goals have landed): the talk step names an awake villager within 30 u and
//   the arrival coins lead to an awake villager (the wave-1 re-verify's
//   decision: B keeps a talking villager awake by the spawn overnight).
//
// Every session boots at ?hour=12 (lib.bootQuery; --hour <n> moves them all)
// except the night sessions, which name their own hours (--night-hour,
// 21,23,2,6 by default, the night-diag proof's hours; one hour or a list).
//
// The guide is read only through its contract: #ds-guide (data-active, the
// 'n/5' header, Skip, the Resume chip, the finale buttons), localStorage
// ds_guide_v1 = {v:1, done[], finished, skipped, t}, and window 'ds:guide'
// {active, step} events (events.cjs). --double injects a stand-in that
// follows the same contract, to test this probe before A6 exists; its checks
// are marked '(double)' and prove nothing about the product.
const lib = require('./lib.cjs');
const { EVENTS_INIT } = require('./events.cjs');

const STEPS = ['move', 'look', 'talk', 'portfolio', 'compass'];
const VIEWPORTS = [
  { tag: '1440x900', prof: 'desktop', show: 'projects' },
  { tag: '390x844', prof: 'phone', show: 'school' },
  { tag: '844x390', prof: 'landscape', show: 'projects' },
  { tag: '667x375', prof: 'landscape667', show: 'school' },
];
const HINT_RE = /The gold ➤|talks through Claude Haiku|Coins! The|That ticked up|\bLost\?|the town square|the human behind|special today|daily special/i;

// --------------------------------------------------------------- page side
const STATE = () => {
  const g = document.getElementById('ds-guide');
  const vis = (el) => {
    if (!el || !el.isConnected) return false;
    const b = el.getBoundingClientRect();
    if (b.width < 2 || b.height < 2) return false;
    for (let n = el; n && n !== document; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity < 0.05) return false;
    }
    return true;
  };
  let store = null;
  try {
    store = JSON.parse(localStorage.getItem('ds_guide_v1') || 'null');
  } catch (e) {}
  const evs = (window.__dsEvents || []).filter((e) => e.type === 'ds:guide');
  const text = g && vis(g) ? (g.innerText || '').replace(/\s+/g, ' ').trim() : '';
  const m = /(\d)\s*\/\s*5/.exec(text);
  const b = g ? g.getBoundingClientRect() : null;
  const ui = window.__app && window.__app.ui;
  // Guide.view().justDone: the step whose check plays during the 450 ms
  // advance, while the card still reads the old n/5. undefined when the
  // build exposes no guide view (the settled() fallback then waits for 3/5).
  let justDone;
  try {
    const gv = window.__app && window.__app.guide && typeof window.__app.guide.view === 'function' ? window.__app.guide.view() : null;
    justDone = gv ? gv.justDone || null : undefined;
  } catch (e) {}
  return {
    t: Math.round(performance.now()),
    justDone,
    present: !!g && vis(g),
    active: g ? g.getAttribute('data-active') : null,
    text: text.slice(0, 240),
    stepNo: m ? +m[1] : null,
    chip: !!text && /resume/i.test(text),
    finale: !!text && /you['’]re set/i.test(text),
    // P2-A12's Next chip ('folded' or 'open'): the card after First steps ends.
    next: g && g.dataset.next ? g.dataset.next : !!text && /^Next:/.test(text) ? 'folded' : null,
    store,
    event: evs.length ? evs[evs.length - 1].detail : null,
    rect: b ? [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)] : null,
    panel: ui && ui.panels ? ui.panels.current() : null,
    compass: window.__h && window.__h.compassFull ? window.__h.compassFull() : ui && ui.compassLabel ? ui.compassLabel.textContent : null,
  };
};

/** The card against the joystick, the action column, the prompt lane, the minimap and the viewport. */
const GEOMETRY = () => {
  const g = document.getElementById('ds-guide');
  if (!g) return null;
  const vis = (el) => {
    if (!el || !el.isConnected) return false;
    const b = el.getBoundingClientRect();
    if (b.width < 2 || b.height < 2) return false;
    for (let n = el; n && n !== document; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity < 0.05) return false;
    }
    return true;
  };
  if (!vis(g)) return null;
  const R = (el) => el.getBoundingClientRect();
  const card = R(g);
  const hits = [];
  const inter = (name, el) => {
    if (!el || !vis(el)) return;
    const b = R(el);
    const w = Math.min(card.right, b.right) - Math.max(card.left, b.left);
    const h = Math.min(card.bottom, b.bottom) - Math.max(card.top, b.top);
    if (w > 1 && h > 1) hits.push(`${name} ${Math.round(w)}x${Math.round(h)}`);
  };
  const ov = document.getElementById('ui-overlay');
  const kids = ov ? [...ov.children] : [];
  inter('joystick', document.querySelector('[data-guide="joystick"]') || kids.find((d) => d.style && d.style.width === '166px' && d.style.touchAction === 'none'));
  for (const d of kids) if (d.style && d.style.width === '74px' && d.style.height === '74px') inter(`action ${(d.textContent || '').trim().slice(0, 8)}`, d);
  inter('prompt', document.querySelector('[data-hud="prompt"]') || (window.__app && window.__app.ui && window.__app.ui.interactionDiv));
  // The minimap (top +40, left +10, 104-172 px): A6's short-landscape lane
  // (top +56, left +16, 300 px) and its chip sit over it (waves critique).
  const ui = window.__app && window.__app.ui;
  inter('minimap', document.querySelector('[data-hud="minimap"], [data-guide="minimap"]') || (ui && ui.mapCanvas));
  // The compass pill, and whatever message is up: a toast lifts over the card
  // and a flash goes above or below it (wave 1's D fixes), which this check
  // could not see while it left them out.
  inter('compass pill', document.querySelector('[data-hud="compass"], [data-guide="compass"]') || (ui && ui.compassDiv));
  inter('toast', ui && ui.toastEl);
  inter('flash', ui && ui.flashEl);
  const edges = [];
  if (card.left < 0) edges.push('left');
  if (card.top < 0) edges.push('top');
  if (card.right > innerWidth) edges.push('right');
  if (card.bottom > innerHeight) edges.push('bottom');
  return { card: [Math.round(card.left), Math.round(card.top), Math.round(card.width), Math.round(card.height)], overlaps: hits, edges };
};

const GUIDE_ANIMATIONS = () => {
  const g = document.getElementById('ds-guide');
  return document
    .getAnimations()
    .filter((a) => a.playState === 'running' && a.effect && a.effect.target && g && (g === a.effect.target || g.contains(a.effect.target)))
    .map((a) => a.animationName || a.constructor.name);
};

/** A toast on screen right now, and whether the guide is active. */
const TOAST_NOW = () => {
  const ui = window.__app && window.__app.ui;
  const t = ui && ui.toastEl;
  const on = !!t && t.isConnected && parseFloat(getComputedStyle(t).opacity) > 0.5 && t.getBoundingClientRect().height > 2;
  const g = document.getElementById('ds-guide');
  return { toast: on ? (t.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 120) : null, guideActive: !!g && g.getAttribute('data-active') === '1' };
};

// The B10 trail check: the last trail coin, the nearest villager to it.
const TRAIL = () => {
  const sc = window.__app.scene;
  const coins = (sc.coins || []).filter((c) => c.trail && c.mesh && /trail_coin_\d+/.test(c.mesh.name || ''));
  if (!coins.length) return null;
  coins.sort((a, b) => +a.mesh.name.split('_').pop() - +b.mesh.name.split('_').pop());
  const last = coins[coins.length - 1].mesh.position.clone();
  let best = null;
  for (const n of sc.getIsland().npcTargets || []) {
    if (!n.meshRef || !n.meshRef.visible) continue;
    const p = n.meshRef.getWorldPosition(last.clone());
    const d = p.distanceTo(last);
    if (!best || d < best.d) best = { name: n.name, d: +d.toFixed(2) };
  }
  // B10's own word for the villager the trail leads to, when the build has
  // it. The trail is laid toward their seat (npcTargets[].position), and they
  // walk about: the live distance read 3.15 u about one run in six, so the
  // check measures to the seat and reports the live distance beside it.
  const named = typeof sc.getTrailVillager === 'function' ? sc.getTrailVillager() : undefined;
  const tg = named ? (sc.getIsland().npcTargets || []).find((n) => n.name === named) : null;
  const seat = tg && tg.position ? { name: named, d: +tg.position.distanceTo(last).toFixed(2), liveD: tg.meshRef ? +tg.meshRef.getWorldPosition(last.clone()).distanceTo(last).toFixed(2) : null } : null;
  return { coins: coins.length, last: last.toArray().map((x) => +x.toFixed(2)), nearest: best, named, seat };
};

/** Who is awake: every villager in the world, their activity and distance from the visitor. */
const AWAKE = () => {
  const sc = window.__app.scene;
  const p = sc.getPlayer().getWorldPosition();
  const act = (n) => (typeof sc.getNpcActivity === 'function' ? sc.getNpcActivity(n) || null : null);
  const rows = (sc.getIsland().npcTargets || []).map((t) => ({ name: t.name, awake: !!(t.meshRef && t.meshRef.visible) && act(t.name) !== 'sleep', activity: act(t.name), d: t.meshRef ? +t.meshRef.position.distanceTo(p).toFixed(1) : null }));
  const env = sc.getEnvironmentCycle ? sc.getEnvironmentCycle() : null;
  const named = typeof sc.getTrailVillager === 'function' ? sc.getTrailVillager() : null;
  return { hour: env ? +env.getHour().toFixed(2) : null, rows, trailVillager: named, coinsDown: typeof sc.hasTrailCoins === 'function' ? sc.hasTrailCoins() : null };
};

// ---------------------------------------------------------------- the double
// A stand-in for A6, injected only with --double: the same DOM, storage and
// event contract, driven by the app's public state. It exists to exercise
// this probe; it is not the product's guide.
const DOUBLE = `(() => {
  if (window.top !== window) return;
  const STEPS = ['move', 'look', 'talk', 'portfolio', 'compass'];
  const st = { done: [], i: 0, armed: false, skipped: false, finished: false, idleSince: 0, chip: false, yaw0: null, moved: 0, last: null };
  let legacyAtLoad = false;
  try { legacyAtLoad = !!localStorage.getItem('ds_welcomed') && !localStorage.getItem('ds_guide_v1'); } catch (e) {}
  const load = () => {
    try {
      const s = JSON.parse(localStorage.getItem('ds_guide_v1') || 'null');
      if (s) { st.done = s.done || []; st.skipped = !!s.skipped; st.finished = !!s.finished; return; }
      // A legacy visitor (ds_welcomed, no ds_guide_v1): move and look are done; one controls card.
      if (legacyAtLoad) {
        st.done = ['move', 'look'];
        if (!localStorage.getItem('ds_controls_v2')) {
          localStorage.setItem('ds_controls_v2', '1');
          const c = document.createElement('div');
          c.textContent = 'Drag to look · Space to run';
          Object.assign(c.style, { position: 'absolute', left: '16px', top: '180px', background: '#111', color: '#fff', padding: '8px' });
          (document.getElementById('ui-overlay') || document.body).appendChild(c);
          setTimeout(() => c.remove(), 5000);
        }
      }
    } catch (e) {}
  };
  const save = () => { try { localStorage.setItem('ds_guide_v1', JSON.stringify({ v: 1, done: st.done, finished: st.finished, skipped: st.skipped, t: Date.now() })); } catch (e) {} };
  const emit = () => window.dispatchEvent(new CustomEvent('ds:guide', { detail: { active: st.armed && !st.finished && !st.skipped, step: STEPS[st.i] || null } }));
  let card = null;
  const render = () => {
    const ov = document.getElementById('ui-overlay');
    if (!ov) return;
    if (!card) {
      card = document.createElement('div');
      card.id = 'ds-guide';
      card.setAttribute('role', 'status');
      card.setAttribute('aria-live', 'polite');
      Object.assign(card.style, { position: 'absolute', left: '16px', top: innerHeight <= 500 ? '56px' : '232px', width: '300px', background: 'rgba(16,24,38,0.94)', color: '#fff', padding: '10px 14px', borderRadius: '14px', font: '14px system-ui', zIndex: '1700', pointerEvents: 'auto' });
      // Portrait phones: above the prompt lane (its top sits near 486 px at 390x844).
      if (matchMedia('(pointer: coarse)').matches && innerHeight > 500) { card.style.top = ''; card.style.bottom = '384px'; card.style.width = 'min(92vw,360px)'; }
      ov.appendChild(card);
    }
    const on = st.armed && !st.skipped;
    card.style.display = on ? 'block' : 'none';
    card.setAttribute('data-active', on && !st.finished ? '1' : '0');
    if (!on) return;
    if (st.finished) { card.innerHTML = "You're set. Next: the work. <button data-g='p'>Show me Projects</button> <button data-g='s'>Show me the School</button>"; return; }
    const n = st.i + 1;
    card.innerHTML = st.chip ? '<button data-g="r" style="min-height:44px">First steps ' + n + '/5 · Resume</button>' : 'First steps · ' + n + '/5 <button data-g="k" aria-label="Skip the first-steps guide" style="min-height:44px">Skip</button><div>' + ({ move: 'Walk with W A S D.', look: 'Drag to look — or J/L to turn.', talk: 'Mayor talks through Claude Haiku 4.5. Walk up to Mayor and press E to ask anything.', portfolio: 'Open 📖 Portfolio.', compass: 'The gold ➤ points the way. Press M for the map.' })[STEPS[st.i]] + '</div>';
  };
  const complete = (step) => {
    if (STEPS[st.i] !== step || st.finished) return;
    st.done.push(step); st.i++; st.idleSince = performance.now(); st.chip = false;
    if (st.i >= STEPS.length) st.finished = true;
    save(); emit(); render();
  };
  document.addEventListener('click', (e) => {
    const b = e.target && e.target.closest && e.target.closest('#ds-guide button');
    if (!b) return;
    const g = b.getAttribute('data-g');
    const app = window.__app;
    if (g === 'k') { st.skipped = true; save(); emit(); render(); }
    if (g === 'r') { st.chip = false; st.idleSince = performance.now(); render(); }
    if ((g === 'p' || g === 's') && app) {
      // A real place for each: main-simple drops a map target within 6 u of the player as reached.
      const z = g === 'p' ? app.scene.getZonesManager().getZones().find((x) => x.id === 'projects') : null;
      const pos = z ? z.getPosition() : app.scene.schoolPos && app.scene.schoolPos();
      if (pos) {
        app.mapGuideTarget = pos.clone();
        app.mapGuideLabel = g === 'p' ? '🚀 Projects' : '🏫 School';
      }
      st.armed = false; render();
    }
  }, true);
  const tick = () => {
    const app = window.__app;
    if (app && app.ui && app.scene) {
      // Like A6, the double pauses while the welcome card is up and arms when it closes.
      if (app.ui.isWelcomeVisible()) st.sawWelcome = true;
      if (card) card.style.visibility = app.ui.isWelcomeVisible() ? 'hidden' : '';
      if (!st.armed && st.sawWelcome && !app.ui.isWelcomeVisible() && app.ui.panels && app.ui.panels.current() === null && window.__lifeIslandReady) {
        load();
        if (!st.skipped && !st.finished) { st.armed = true; st.i = st.done.length; st.idleSince = performance.now(); st.yaw0 = app.scene.getOrbitCamera().getYaw(); emit(); }
        render();
      }
      if (st.armed && !st.finished && !st.skipped) {
        const step = STEPS[st.i];
        const p = app.scene.getPlayer().getWorldPosition();
        if (st.last) st.moved += p.distanceTo(st.last);
        st.last = p.clone();
        const cur = app.ui.panels.current();
        if (step === 'move' && st.moved > 4) complete('move');
        else if (step === 'look') { const y = app.scene.getOrbitCamera().getYaw(); if (st.yaw0 === null) st.yaw0 = y; if (Math.abs(y - st.yaw0) > 0.61) complete('look'); }
        else if (step === 'talk' && (cur === 'npc-chat' || app.ui.isDialogueActive())) complete('talk');
        else if (step === 'portfolio' && (cur === 'portfolio-menu' || cur === 'zone')) complete('portfolio');
        else if (step === 'compass' && cur === 'island-map') complete('compass');
        if (step === 'look' && st.done.indexOf('look') < 0 && st.yaw0 === null) st.yaw0 = app.scene.getOrbitCamera().getYaw();
        if (!st.chip && performance.now() - st.idleSince > 20000) { st.chip = true; render(); }
      }
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
})();`;

// -------------------------------------------------------------- node side
const ptime = (page) => page.evaluate(() => Math.round(performance.now()));

async function waitFor(page, pred, ms, every = 100) {
  const end = Date.now() + ms;
  for (;;) {
    const s = await page.evaluate(STATE).catch(() => null);
    if (s && pred(s)) return s;
    if (Date.now() > end) return null;
    await lib.sleep(every);
  }
}
/**
 * The card is on a step that has settled (wave-3 amendments, guide night):
 * not inside First steps' advance pause, when the card still reads 2/5 with
 * the check playing. With Guide's justDone readable, a step with no justDone
 * counts; without it, only a step past 2/5 does (both callers want 3/5).
 */
const settled = (x) => !!x && x.present && x.stepNo !== null && (x.justDone === null || x.stepNo > 2);
const isDone = (s, step) => !!(s && ((s.store && Array.isArray(s.store.done) && s.store.done.includes(step)) || (s.event && s.event.step && STEPS.indexOf(s.event.step) > STEPS.indexOf(step)) || (s.stepNo && s.stepNo - 1 > STEPS.indexOf(step))));

async function clickXY(page, touch, T, xy) {
  if (touch) await T.tap(xy[0], xy[1]);
  else await page.mouse.click(xy[0], xy[1]);
}

/** Steer to the named villager until the talk prompt names them. */
async function walkToVillager(page, touch, T, name, ms) {
  const end = Date.now() + ms;
  let down = false;
  const keys = new Set();
  const setKeys = async (want) => {
    for (const k of [...keys]) if (!want.includes(k)) {
      await page.keyboard.up(k);
      keys.delete(k);
    }
    for (const k of want) {
      await page.keyboard.down(k);
      keys.add(k);
    }
  };
  const c = touch ? await T.joyCenter() : null;
  let out = 'timeout';
  while (Date.now() < end) {
    const s = await page
      .evaluate((n) => {
        const a = window.__app;
        const tgt = a.scene.getNpcPosition ? a.scene.getNpcPosition(n) : null;
        if (!tgt) return null;
        const P = a.scene.getPlayer().getWorldPosition();
        const up = P.clone().normalize();
        const proj = (v) => v.clone().addScaledVector(up, -v.dot(up));
        const toT = proj(tgt.clone().sub(P)).normalize();
        const f = proj(a.scene.getOrbitCamera().getForwardDirection().clone()).normalize();
        const cr = f.clone().cross(toT);
        const rel = (-Math.atan2(cr.dot(up), f.dot(toT)) * 180) / Math.PI;
        const prompt = a.ui.interactionDiv ? (a.ui.interactionDiv.textContent || '').trim() : '';
        return { rel, d: tgt.distanceTo(P), prompt, panel: a.ui.panels.current() };
      }, name)
      .catch(() => null);
    if (!s) {
      out = 'no villager';
      break;
    }
    if (new RegExp(name).test(s.prompt)) {
      out = 'prompt';
      break;
    }
    if (s.panel && s.panel !== 'drawer') await page.evaluate(() => window.__app.ui.panels.closeTop());
    if (touch && c) {
      const r = (s.rel * Math.PI) / 180;
      if (!down) {
        await T.send('touchStart', [[c[0], c[1], 3]]);
        down = true;
      }
      await T.send('touchMove', [[c[0] + 38 * Math.sin(r), c[1] - 38 * Math.cos(r), 3]]);
    } else {
      const a = Math.abs(s.rel);
      await setKeys(a < 25 ? ['w'] : ['w', s.rel > 0 ? 'd' : 'a']);
    }
    await lib.sleep(150);
  }
  if (down) await T.send('touchEnd', []);
  await setKeys([]);
  return out;
}

/** Do one step the way the device does it; resolves at the end of the action. */
async function act(page, step, touch, T, ctx) {
  const vp = await page.evaluate(() => [innerWidth, innerHeight]);
  if (step === 'move') {
    if (touch) await T.joyHold(0, -36, 1500);
    else {
      await page.keyboard.down('w');
      const end = Date.now() + 1500;
      while (Date.now() < end) {
        await lib.sleep(300);
        await page.keyboard.down('w');
      }
      await page.keyboard.up('w');
    }
    return 'walked 1.5 s';
  }
  if (step === 'look') {
    if (touch) {
      const y = Math.round(vp[1] * 0.42);
      const x = Math.round(vp[0] * 0.62);
      await T.drag([x, y], [x - 150, y], 400, 15);
      return 'swiped 150 px';
    }
    await page.mouse.move(700, 470);
    await page.mouse.down();
    for (let i = 1; i <= 30; i++) {
      await page.mouse.move(700 + i * 10, 470);
      await lib.nextFrames(page, 1);
    }
    await page.mouse.up();
    return 'dragged 300 px';
  }
  if (step === 'talk') {
    const st = await page.evaluate(STATE);
    const m = /walk up to (?:the )?(.+?) and (?:press|tap)/i.exec(st.text || '');
    const name = m ? m[1].trim() : (st.compass || '').replace(/^[^A-Za-z]+/, '').replace(/\s*[•·].*$/, '').trim();
    ctx.talkTarget = name || null;
    if (!name) return 'no target named';
    ctx.talkWalk = await walkToVillager(page, touch, T, name, 25000);
    if (touch) {
      const u = await T.useBtn();
      if (u) await T.tap(u[0], u[1]);
    } else await page.keyboard.press('e');
    return `talked to ${name} (${ctx.talkWalk})`;
  }
  if (step === 'portfolio') {
    const xyOfSel = (sel) =>
      page.evaluate((q) => {
        const el = [...document.querySelectorAll(q)].find((e) => e.getBoundingClientRect().height > 2 && getComputedStyle(e).visibility !== 'hidden');
        if (!el) return null;
        const b = el.getBoundingClientRect();
        return [b.left + b.width / 2, b.top + b.height / 2];
      }, sel);
    if (touch) {
      const tg = await xyOfSel('[aria-label="Open island menu"]');
      if (tg) await clickXY(page, true, T, tg);
      await lib.sleep(600);
    }
    const pill = await xyOfSel('[aria-label="Open portfolio menu"]');
    if (pill) await clickXY(page, touch, T, pill);
    return pill ? 'opened the Portfolio menu' : 'no Portfolio pill';
  }
  if (step === 'compass') {
    if (touch) {
      const cp = await page.evaluate(() => {
        const d = window.__app.ui.compassDiv;
        if (!d) return null;
        const b = d.getBoundingClientRect();
        return [b.left + b.width / 2, b.top + b.height / 2];
      });
      if (cp) await T.tap(cp[0], cp[1]);
      return cp ? 'tapped the compass' : 'no compass';
    }
    await page.keyboard.press('m');
    return 'pressed M';
  }
  return 'unknown step';
}

/** Close whatever the step opened, so the next one starts in free roam. */
async function closeAfter(page, step, touch) {
  if (step === 'talk') {
    await page.evaluate(() => {
      const ui = window.__app.ui;
      if (ui.closeNpcChat) ui.closeNpcChat();
      ui.panels.closeAll();
    });
    for (let i = 0; i < 6 && (await page.evaluate(() => window.__app.ui.isDialogueActive())); i++) {
      await page.keyboard.press(touch ? 'e' : 'Escape');
      await lib.sleep(500);
    }
  } else if (step === 'portfolio' || step === 'compass') {
    if (touch) await page.evaluate(() => window.__app.ui.panels.closeAll());
    else await page.keyboard.press('Escape');
  }
  await lib.sleep(800);
}

async function explore(page, touch) {
  const sel = `${lib.WELCOME} button[data-dismiss]`;
  if (touch) await page.tap(sel).catch(() => page.click(sel));
  else await page.click(sel);
  return ptime(page);
}

async function newSession(t, prof, opts = {}) {
  const init = [EVENTS_INIT, ...(t.args.double ? [DOUBLE] : []), ...(opts.init || [])];
  const s = await t.session(prof, { ...opts, init });
  return s;
}

const tagOf = (t, name) => (t.args.double ? `${name} (double)` : name);

/** The whole guide at one viewport: steps, reload at 3/5, the chip, the finale, a 'Show me'. */
async function flow(t, v) {
  const touch = lib.isTouchProfile(v.prof);
  const s = await newSession(t, v.prof);
  const { page } = s;
  const T = touch ? await lib.touch(s) : null;
  const r = { viewport: v.tag, steps: {}, geometry: [], hintsWhileActive: [] };
  r.boot = await t.boot(s);
  const exploreAt = await explore(page, touch);
  const first = await waitFor(page, (x) => x.present, 3000);
  r.cardAfterExplore = first ? { text: first.text, rect: first.rect } : null;
  t.check(tagOf(t, `${v.tag}: guide card present after Explore`), !!first, first ? first.text.slice(0, 60) : 'no #ds-guide', '#ds-guide visible');
  await t.shot(page, `guide-${v.tag}-explore.png`);
  if (!first) {
    t.data[v.tag] = r;
    return r;
  }
  // Sample toasts in the background: none may be a hint while the guide is active.
  let sampling = true;
  // The same loop catches a toast or a flash over the card: they come and go
  // between the per-step reads.
  r.messagesOverCard = [];
  r.messageSamples = 0;
  const sampler = (async () => {
    while (sampling) {
      const x = await page.evaluate(TOAST_NOW).catch(() => null);
      if (x && x.guideActive && x.toast && HINT_RE.test(x.toast) && !r.hintsWhileActive.includes(x.toast)) r.hintsWhileActive.push(x.toast);
      const g = await page.evaluate(GEOMETRY).catch(() => null);
      if (g) {
        r.messageSamples++;
        const hit = g.overlaps.filter((o) => /^(toast|flash) /.test(o));
        if (hit.length && r.messagesOverCard.length < 12) r.messagesOverCard.push({ card: g.card, overlaps: hit, toast: x ? x.toast : null });
      }
      await lib.sleep(300);
    }
  })();
  const ctx = {};
  for (let i = 0; i < STEPS.length; i++) {
    const step = STEPS[i];
    if (i === 2) {
      // A reload with two steps done resumes at step 3.
      await t.boot(s);
      await explore(page, touch);
      const res = await waitFor(page, (x) => x.present, 3000);
      r.resume = res ? { stepNo: res.stepNo, event: res.event, done: res.store && res.store.done } : null;
      const at3 = !!res && (res.stepNo === 3 || (res.event && res.event.step === 'talk'));
      t.check(tagOf(t, `${v.tag}: a reload with 2 steps done resumes at step 3`), at3, res ? res.stepNo || (res.event && res.event.step) : 'no card after reload', '3/5 (talk)');
      // 20 s with no input on a step shows the one-line chip.
      await lib.sleep(21000);
      const chip = await page.evaluate(STATE);
      r.chip = { text: chip.text, rect: chip.rect };
      // The chip's rect is judged too: it sits where the card's top-left does.
      const gc = await page.evaluate(GEOMETRY);
      if (gc) r.geometry.push({ step: `${step} (chip)`, ...gc });
      t.check(tagOf(t, `${v.tag}: 20 s with no input on a step shows the chip`), chip.chip, chip.text.slice(0, 50) || 'no card', "'First steps 3/5 · Resume'");
      await t.shot(page, `guide-${v.tag}-chip.png`);
      const cxy = await page.evaluate(() => {
        const g = document.getElementById('ds-guide');
        const b = g && ([...g.querySelectorAll('button,[role=button]')].find((x) => /resume/i.test(x.textContent || '')) || g);
        if (!b) return null;
        const q = b.getBoundingClientRect();
        return [q.left + q.width / 2, q.top + q.height / 2];
      });
      if (cxy) await clickXY(page, touch, T, cxy);
      await lib.sleep(500);
    }
    const g = await page.evaluate(GEOMETRY);
    if (g) r.geometry.push({ step, ...g });
    const pre = await page.evaluate(STATE);
    if (isDone(pre, step)) {
      r.steps[step] = { how: 'already done before its action' };
      t.check(tagOf(t, `${v.tag}: '${step}' completes within 1 s of its action`), false, 'already done before its action (fresh storage)', '<= 1000 ms');
      continue;
    }
    const t0 = await ptime(page);
    const how = await act(page, step, touch, T, ctx);
    const t1 = await ptime(page);
    const done = await waitFor(page, (x) => isDone(x, step), 6000);
    const doneAt = done ? done.t : null;
    r.steps[step] = { how, actionMs: t1 - t0, doneAfterActionMs: doneAt === null ? null : doneAt - t1 };
    t.check(tagOf(t, `${v.tag}: '${step}' completes within 1 s of its action`), doneAt !== null && doneAt - t1 <= 1000, doneAt === null ? `not done 6 s after: ${how}` : `${doneAt - t1} ms after: ${how}`, '<= 1000 ms');
    await closeAfter(page, step, touch);
  }
  const fin = await waitFor(page, (x) => x.finale, 6000);
  r.finaleS = fin ? lib.round((fin.t - exploreAt) / 1000, 1) : null;
  r.talk = ctx;
  t.check(tagOf(t, `${v.tag}: Explore to the finale (s)`), fin !== null && r.finaleS <= 60, fin ? r.finaleS : 'no finale', '<= 60 (target 35-50)');
  await t.shot(page, `guide-${v.tag}-finale.png`);
  if (fin) {
    const gf = await page.evaluate(GEOMETRY);
    if (gf) r.geometry.push({ step: 'finale', ...gf });
    const want = v.show === 'school' ? /school/i : /show me/i;
    const bxy = await page.evaluate((src) => {
      const re = new RegExp(src, 'i');
      const g = document.getElementById('ds-guide');
      const bs = g ? [...g.querySelectorAll('button')] : [];
      const b = src === 'school' ? bs.find((x) => re.test(x.textContent || '')) : bs.find((x) => /show me/i.test(x.textContent || ''));
      if (!b) return null;
      const q = b.getBoundingClientRect();
      return { xy: [q.left + q.width / 2, q.top + q.height / 2], text: (b.textContent || '').trim() };
    }, v.show === 'school' ? 'school' : 'show me');
    if (bxy) {
      await clickXY(page, touch, T, bxy.xy);
      await lib.sleep(1000);
      const after = await page.evaluate(STATE);
      r.showMe = { button: bxy.text, compass: after.compass };
      const target = v.show === 'school' ? /school/i : /projects/i;
      t.check(tagOf(t, `${v.tag}: '${bxy.text}' sets the compass label`), target.test(after.compass || ''), after.compass, v.show === 'school' ? 'School' : 'Projects');
    } else t.check(tagOf(t, `${v.tag}: the finale's 'Show me' button`), false, 'missing', want.source);
  }
  sampling = false;
  await sampler;
  const overl = r.geometry.filter((x) => x.overlaps.length || x.edges.length);
  t.check(tagOf(t, `${v.tag}: the card never overlaps the joystick, the action column, the prompt, the minimap, the compass pill or an edge`), r.geometry.length ? overl.length === 0 : null, overl.length ? overl.map((x) => `${x.step}: ${[...x.overlaps, ...x.edges].join(', ')}`) : 'clear', 'clear');
  t.check(tagOf(t, `${v.tag}: no toast or flash lands on the card (sampled every 300 ms)`), r.messageSamples ? r.messagesOverCard.length === 0 : null, r.messagesOverCard.length ? r.messagesOverCard.slice(0, 4) : `clear in ${r.messageSamples} samples`, 'clear');
  t.check(tagOf(t, `${v.tag}: no hint toast while the guide is active`), r.hintsWhileActive.length === 0, r.hintsWhileActive.length ? r.hintsWhileActive : 'none', 'none (D6)');
  t.data[v.tag] = r;
  // Each part closes its page: nine live worlds in one browser slowed the
  // last ones enough that the 8 s controls card took over 13 s.
  await s.close();
  return r;
}

async function skipAndTrail(t, prof) {
  const touch = lib.isTouchProfile(prof);
  const s = await newSession(t, prof);
  const { page } = s;
  const r = { profile: prof };
  r.boot = await t.boot(s);
  await explore(page, touch);
  r.trail = await page.evaluate(TRAIL);
  const g = await waitFor(page, (x) => x.present, 3000);
  if (g) {
    const sk = await page.evaluate(() => {
      const card = document.getElementById('ds-guide');
      const b = card && [...card.querySelectorAll('button,[role=button]')].find((x) => /skip/i.test(`${x.getAttribute('aria-label') || ''} ${x.textContent || ''}`));
      if (!b) return null;
      const q = b.getBoundingClientRect();
      return [q.left + q.width / 2, q.top + q.height / 2];
    });
    if (sk) {
      if (touch) await page.touchscreen.tap(sk[0], sk[1]);
      else await page.mouse.click(sk[0], sk[1]);
    }
    await lib.sleep(700);
    const after = await page.evaluate(STATE);
    // Since P2-A12 a skipped card folds into the Next chip: that counts as hidden.
    r.skip = { button: !!sk, present: after.present, next: after.next, text: after.text.slice(0, 60), store: after.store };
    t.check(tagOf(t, `${prof}: Skip writes skipped and hides the card`), !!sk && (!after.present || !!after.next) && !!(after.store && after.store.skipped), r.skip, 'skipped:true, card hidden (or folded into the Next chip)');
  } else t.check(tagOf(t, `${prof}: Skip writes skipped and hides the card`), null, 'no guide card', 'skipped:true, card hidden');
  if (prof === 'desktop' && r.trail && (r.trail.seat || r.trail.nearest)) {
    // The trail's villager: B10's own (their seat), else the nearest one.
    const who = r.trail.seat ? r.trail.seat.name : r.trail.nearest.name;
    const d = r.trail.seat ? r.trail.seat.d : r.trail.nearest.d;
    // Is the villager at the trail's end one who talks through Claude Haiku 4.5?
    r.trail.prompt = await page.evaluate((name) => {
      const sc = window.__app.scene;
      const tg = sc.getIsland().npcTargets.find((x) => x.name === name);
      const c = tg.meshRef.getWorldPosition(sc.getPlayer().getWorldPosition().clone());
      const up = c.clone().normalize();
      const ref = Math.abs(up.y) < 0.9 ? up.clone().set(0, 1, 0) : up.clone().set(1, 0, 0);
      const p = c.clone().addScaledVector(ref.clone().cross(up).normalize(), 1.4);
      p.setLength(c.length() + 0.6);
      sc.getPlayer().setWorldPosition(p);
      return name;
    }, who);
    // The villager walks on: take the first prompt that names them within 3 s.
    r.trail.talkPrompt = null;
    for (let i = 0; i < 30 && !r.trail.talkPrompt; i++) {
      await lib.sleep(100);
      const pr = await page.evaluate(() => (window.__app.ui.interactionDiv ? (window.__app.ui.interactionDiv.textContent || '').trim() : null));
      if (pr && pr.includes(who)) r.trail.talkPrompt = pr;
    }
    const ai = /ask anything/i.test(r.trail.talkPrompt || '');
    t.check(`at Explore: the last trail coin is within 3 u of the seat of a villager who talks through Claude Haiku 4.5 (B10)`, d <= 3 && ai, { villager: who, measuredTo: r.trail.seat ? 'seat (getTrailVillager)' : 'live position (no getTrailVillager)', distanceU: d, liveDistanceU: r.trail.seat ? r.trail.seat.liveD : r.trail.nearest.d, nearestLive: r.trail.nearest, prompt: r.trail.talkPrompt }, '<= 3 u, "ask anything"');
  }
  t.data[`skip-${prof}`] = r;
  await s.close();
}

async function reducedMotion(t, prof) {
  const touch = lib.isTouchProfile(prof);
  const s = await newSession(t, prof, { reducedMotion: 'reduce' });
  const { page } = s;
  await t.boot(s);
  await explore(page, touch);
  const g = await waitFor(page, (x) => x.present, 3000);
  if (!g) {
    t.check(tagOf(t, `${prof}, reduced motion: no guide animation`), null, 'no guide card', 'none');
    return;
  }
  const seen = new Set();
  const T = touch ? await lib.touch(s) : null;
  const sampling = (async () => {
    for (let i = 0; i < 40; i++) {
      for (const a of await page.evaluate(GUIDE_ANIMATIONS).catch(() => [])) seen.add(a);
      await lib.sleep(100);
    }
  })();
  await act(page, 'move', touch, T, {});
  await sampling;
  t.data[`reduced-${prof}`] = { animations: [...seen] };
  t.check(tagOf(t, `${prof}, reduced motion: getAnimations() lists no guide animation`), seen.size === 0, seen.size ? [...seen] : 'none', 'none');
  await s.close();
}

async function legacy(t) {
  const s = await newSession(t, 'desktop', { localStorage: { ds_welcomed: '1' } });
  const { page } = s;
  await t.boot(s);
  await explore(page, false);
  await lib.sleep(1500);
  const controls = () =>
    page.evaluate(() => {
      const hit = [...document.querySelectorAll('#ui-overlay *')].find((e) => e.children.length === 0 && /Drag to look|for all controls|to run/i.test(e.textContent || '') && e.getBoundingClientRect().height > 2);
      return hit ? hit.textContent.replace(/\s+/g, ' ').trim().slice(0, 100) : null;
    });
  const c1 = await controls();
  const t1 = await ptime(page);
  // The controls card holds the guide for 8 s (or until its OK): the step is
  // read once the card has gone, not while it is up ('controls').
  // A settled step only: during the advance pause the card still reads 2/5.
  const onStep = (x) => settled(x) || (x.present && x.stepNo === null && !x.justDone && !!x.event && STEPS.includes(x.event.step));
  const st = await waitFor(page, onStep, 20000);
  const stepAfterMs = st ? st.t - t1 + 1500 : null;
  const stuck = st ? null : await page.evaluate(STATE).catch(() => null);
  await t.boot(s);
  await explore(page, false);
  await lib.sleep(1500);
  const c2 = await controls();
  // After the reload there is no controls card, so the step is up at once.
  const st2 = await waitFor(page, onStep, 3000);
  const at3 = (x) => !!x && (x.stepNo === 3 || (!!x.event && x.event.step === 'talk'));
  t.data.legacy = { controlsCard: c1, controlsCardAfterReload: c2, stepAfterExploreMs: stepAfterMs, guide: st ? { stepNo: st.stepNo, event: st.event, done: st.store && st.store.done } : null, stateAt20s: stuck, guideAfterReload: st2 ? { stepNo: st2.stepNo, event: st2.event } : null };
  t.check(tagOf(t, 'legacy storage: the controls card shows once'), !!c1 && !c2, { first: c1, afterReload: c2 }, 'shown, then not again');
  t.check(tagOf(t, 'legacy storage: after the controls card the guide starts at the first undone step (3/5, talk)'), at3(st), st ? { step: st.stepNo || (st.event && st.event.step), msAfterExplore: stepAfterMs } : 'no step within 20 s of the controls card', '3/5');
  t.check(tagOf(t, 'legacy storage: after a reload the guide is at 3/5 with no controls card'), at3(st2), st2 ? st2.stepNo || (st2.event && st2.event.step) : 'no step within 3 s', '3/5');
  await s.close();
}

/**
 * Night (wave-1 re-verify). From about 22:00 to 08:00 First steps skipped the
 * talk step when no talking villager was awake within 30 u, and the arrival
 * coins led to a sleeping villager's seat. The decision: B keeps one talking
 * villager awake near the spawn overnight and the trail leads to them; A's
 * skip stays as the fallback. So at ?hour=23 (a fresh visitor, desktop): the
 * coins lead to an awake villager, and after walk and look the card is on
 * 3/5 and names an awake villager within 30 u.
 */
/** --night-hour: one hour or a comma list; 21,23,2,6 by default (wave-3 amendments). */
function nightHours(arg) {
  const raw = arg !== undefined && arg !== true ? String(arg) : '21,23,2,6';
  const hours = raw
    .split(',')
    .map((h) => Number(h.trim()))
    .filter((h) => Number.isFinite(h) && h >= 0 && h < 24);
  return hours.length ? hours : [23];
}

async function night(t, hour) {
  const s = await newSession(t, 'desktop');
  const { page } = s;
  const r = { hour };
  r.boot = await t.boot(s, { query: `hour=${hour}` });
  // The night's sleep goals reach the villagers over the first seconds after
  // boot (the Mayor was still up 8 s after a quick Explore in one run and in
  // bed at Explore in the next), so the visitor reads the card for 12 s first.
  const cardS = t.args.nightWait !== undefined && t.args.nightWait !== true ? Number(t.args.nightWait) : 12;
  r.cardS = cardS;
  await lib.sleep(cardS * 1000);
  await explore(page, false);
  const first = await waitFor(page, (x) => x.present, 3000);
  r.atExplore = await page.evaluate(AWAKE);
  // The trail's villager, read at Explore and again once the visitor has
  // walked and looked (5 s or more later): the night's sleep goal takes a few
  // seconds to send a villager home, so one read at Explore finds them up.
  const leadCheck = (later) => {
    const who = r.atExplore.trailVillager;
    const a = r.atExplore.rows.find((x) => x.name === who) || null;
    const b = later ? later.rows.find((x) => x.name === who) || null : null;
    const ok = !!a && a.awake && (!later || (!!b && b.awake));
    t.check(tagOf(t, `night (?hour=${hour}): the arrival coins lead to an awake villager`), who ? ok : null, who ? { villager: who, atExplore: a ? { awake: a.awake, activity: a.activity, distanceU: a.d } : null, afterWalkAndLook: b ? { awake: b.awake, activity: b.activity, distanceU: b.d } : later ? 'gone' : 'not read', clock: r.atExplore.hour } : 'no getTrailVillager on this build', 'awake at Explore and after');
  };
  if (!first) {
    leadCheck(null);
    t.check(tagOf(t, `night (?hour=${hour}): the talk step names an awake villager within 30 u`), false, 'no guide card after Explore', 'an awake villager, <= 30 u');
    (t.data.night = t.data.night || {})[`h${hour}`] = r;
    await s.close();
    return;
  }
  for (const step of ['move', 'look']) {
    const pre = await page.evaluate(STATE);
    if (!isDone(pre, step)) await act(page, step, false, null, {});
    await waitFor(page, (x) => isDone(x, step), 6000);
  }
  // The talk step, or what the guide did in its place.
  // Past the look step's advance pause (the card reads 2/5 while its check
  // plays): a settled step, or the finale when talk was skipped.
  const st = await waitFor(page, (x) => settled(x) || (x.present && x.finale), 4000);
  const world = await page.evaluate(AWAKE);
  leadCheck(world);
  const awakeNear = world.rows.filter((x) => x.awake && x.d !== null && x.d <= 30).sort((a, b) => a.d - b.d);
  const m = st ? /walk up to (?:the )?(.+?) and (?:press|tap)/i.exec(st.text || '') : null;
  const name = m ? m[1].trim() : null;
  const row = name ? world.rows.find((x) => x.name === name) || null : null;
  const skipped = !!(st && st.store && Array.isArray(st.store.done) && st.store.done.includes('talk'));
  r.talk = { stepNo: st ? st.stepNo : null, card: st ? st.text.slice(0, 120) : null, names: name, villager: row, skipped, awakeWithin30: awakeNear.map((x) => `${x.name} ${x.d}`), clock: world.hour };
  await t.shot(page, `guide-night-h${hour}-talk.png`);
  let ok = !!st && st.stepNo === 3 && !!row && row.awake && row.d <= 30;
  // ...and they stay up: 10 s on, the card is still on 3/5 naming someone awake.
  if (ok) {
    await lib.sleep(10000);
    const st2 = await page.evaluate(STATE);
    const w2 = await page.evaluate(AWAKE);
    const m2 = /walk up to (?:the )?(.+?) and (?:press|tap)/i.exec(st2.text || '');
    const row2 = m2 ? w2.rows.find((x) => x.name === m2[1].trim()) || null : null;
    r.talk.after10s = { stepNo: st2.stepNo, names: m2 ? m2[1].trim() : null, villager: row2 };
    ok = st2.stepNo === 3 && !!row2 && row2.awake && row2.d <= 30;
  }
  const why = !st ? 'no guide card' : skipped ? `the talk step was skipped (card at ${st.stepNo || 'the finale'}/5); awake within 30 u: ${awakeNear.length ? awakeNear.map((x) => x.name).join(', ') : 'nobody'}` : r.talk;
  t.check(tagOf(t, `night (?hour=${hour}): the talk step names an awake villager within 30 u`), ok, ok ? { villager: name, distanceU: row.d, activity: row.activity, after10s: r.talk.after10s.names } : why, 'on 3/5, an awake villager, <= 30 u, still so 10 s on');
  (t.data.night = t.data.night || {})[`h${hour}`] = r;
  await s.close();
}

async function guide(t) {
  const only = t.args.profile ? String(t.args.profile) : null;
  // --part flow|skip|reduced|legacy|night runs one part (all of them by default).
  const part = t.args.part && t.args.part !== true ? String(t.args.part) : null;
  const on = (p) => !part || part === p;
  if (on('flow')) for (const v of VIEWPORTS) if (!only || only === v.prof) await flow(t, v);
  if (on('skip')) for (const prof of ['desktop', 'phone']) if (!only || only === prof) await skipAndTrail(t, prof);
  if (on('reduced')) for (const prof of ['desktop', 'phone']) if (!only || only === prof) await reducedMotion(t, prof);
  if (on('legacy') && (!only || only === 'desktop')) await legacy(t);
  if (on('night') && (!only || only === 'desktop')) for (const h of nightHours(t.args.nightHour)) await night(t, h);
  t.data.double = !!t.args.double;
  t.data.introEvents = 'see events.cjs';
}

module.exports = {
  guide: { item: 'A6, B10 (E6a)', title: "First steps at 1440x900, 390x844, 844x390, 667x375 (?hour=12): step timing, finale, Skip, resume, the chip, reduced motion, geometry incl. toasts and flashes, 'Show me', legacy, the trail's villager; night sessions at 21, 23, 2 and 6 h", profiles: ['desktop'], run: guide },
  STATE,
  settled,
  nightHours,
  DOUBLE,
};
