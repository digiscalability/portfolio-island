'use strict';
// p2/guide-lib.cjs, the guidance probes' kit (P2-E2a, ported from the
// guidance audit's gd-lib.cjs and gd-help.cjs onto lib.cjs). journey uses
// it now; wave 2's recruiter, landmarks, npcs and copy probes will too.
// - readout(): what the visitor can read now: toast, flash, prompt, the
//   compass pill (its full label, which phones abbreviate to an icon), the
//   panel, stamps, coins, the compass target's distance;
// - followCompass(): a visitor who follows the compass as A1 draws it (the
//   bearing of __app.lastCompassTarget from the camera's forward): W when the
//   target is ahead, W plus A or D to turn; stops on arrival, on a panel, on
//   the welcome card, when a prompt matches, or (untilZone) when
//   getNearbyInteractable() is that district's door;
// - sampleReadout(): readouts over about a second, so a prompt that is still
//   fading in or out is not read as absent;
// - closeNpcChat(): closes a villager chat that opened on the way;
// - walkTo() and walkToNpc(): the same steering to a fixed point or to a
//   villager, until the talk prompt names them;
// - startTimeline(): a background sampler of every change in those readouts,
//   with seconds since a reference time (Explore).
const lib = require('../lib.cjs');

const ptime = (page) => page.evaluate(() => Math.round(performance.now())).catch(() => null);

async function untilPage(page, ms) {
  for (;;) {
    const t = await ptime(page);
    if (t === null || t >= ms) return t;
    await lib.sleep(Math.min(250, ms - t));
  }
}

async function hold(page, keys, ms) {
  for (const k of keys) await page.keyboard.down(k);
  const end = Date.now() + ms;
  while (Date.now() < end) {
    await lib.sleep(Math.min(400, end - Date.now()));
    if (Date.now() < end) for (const k of keys) await page.keyboard.down(k);
  }
  for (const k of keys) await page.keyboard.up(k);
}

const READOUT = () => {
  const a = window.__app;
  const ui = a.ui;
  const vis = (el) => {
    if (!el || !el.isConnected) return false;
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return cs.display !== 'none' && cs.visibility !== 'hidden' && parseFloat(cs.opacity) > 0.05 && r.width > 2 && r.height > 2;
  };
  const txt = (el) => (vis(el) ? (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim() : null);
  let pos = null;
  let tgtD = null;
  try {
    const p = a.scene.getPlayer().getWorldPosition();
    pos = [+p.x.toFixed(1), +p.y.toFixed(1), +p.z.toFixed(1)];
    const tgt = a.lastCompassTarget;
    tgtD = tgt ? +tgt.distanceTo(p).toFixed(1) : null;
  } catch (e) {}
  const shown = ui.compassDiv && ui.compassDiv.style.display !== 'none';
  const full = window.__h && window.__h.compassFull ? window.__h.compassFull() : ui.compassLabel ? ui.compassLabel.textContent : null;
  return {
    t: Math.round(performance.now()),
    welcome: ui.isWelcomeVisible(),
    panel: ui.panels ? ui.panels.current() : null,
    toast: txt(ui.toastEl),
    flash: txt(ui.flashEl),
    prompt: txt(ui.interactionDiv),
    compass: shown ? full : null,
    tgtD,
    pos,
    coins: a.scene.getCoinsCollected ? a.scene.getCoinsCollected() : null,
    stamps: a.passport ? a.passport.count() : null,
    trail: a.scene.hasTrailCoins ? a.scene.hasTrailCoins() : null,
  };
};
const readout = (page) => page.evaluate(READOUT);

/** The compass target's bearing from the camera's forward (+ = to the right), and its distance. */
const BEARING = (T) => {
  const a = window.__app;
  const pl = a.scene.getPlayer();
  const tgt = T ? new (pl.getWorldPosition().constructor)(T[0], T[1], T[2]) : a.lastCompassTarget;
  if (!tgt || !pl) return null;
  const P = pl.getWorldPosition();
  const n = P.clone().normalize();
  const proj = (v) => v.clone().addScaledVector(n, -v.dot(n));
  const toT = proj(tgt.clone().sub(P));
  const f = proj(a.scene.getOrbitCamera().getForwardDirection().clone());
  if (toT.lengthSq() < 1e-6 || f.lengthSq() < 1e-6) return null;
  toT.normalize();
  f.normalize();
  const cr = f.clone().cross(toT);
  const ui = a.ui;
  return {
    rel: (-Math.atan2(cr.dot(n), f.dot(toT)) * 180) / Math.PI,
    d: +tgt.distanceTo(P).toFixed(2),
    label: window.__h && window.__h.compassFull ? window.__h.compassFull() : ui.compassLabel ? ui.compassLabel.textContent : null,
    panel: ui.panels.current(),
    welcome: ui.isWelcomeVisible(),
    prompt: ui.interactionDiv ? (ui.interactionDiv.textContent || '').trim() : null,
    nearZone: (() => {
      try {
        const n = a.scene.getNearbyInteractable && a.scene.getNearbyInteractable();
        return n && n.type === 'zone' && n.zone ? n.zone.id || null : null;
      } catch (e) {
        return null;
      }
    })(),
  };
};

async function steer(page, getState, ms, { near = 2.6, untilPrompt = null, untilZone = null, stopOnPanel = true } = {}) {
  const log = [];
  const end = Date.now() + ms;
  let held = new Set();
  const set = async (keys) => {
    for (const k of [...held]) if (!keys.has(k)) await page.keyboard.up(k);
    for (const k of keys) await page.keyboard.down(k);
    held = keys;
  };
  let lastLabel;
  let outcome = 'timeout';
  let lastD = null;
  while (Date.now() < end) {
    const s = await getState().catch(() => null);
    if (!s) {
      await set(new Set());
      await lib.sleep(250);
      continue;
    }
    lastD = s.d;
    if (s.label !== lastLabel) {
      log.push({ t: Date.now(), label: s.label, d: s.d });
      lastLabel = s.label;
    }
    if (stopOnPanel && s.panel && s.panel !== 'drawer') {
      outcome = 'panel:' + s.panel;
      break;
    }
    if (s.welcome) {
      outcome = 'welcome';
      break;
    }
    if (s.d < near) {
      outcome = 'arrived';
      break;
    }
    if (untilPrompt && s.prompt && untilPrompt.test(s.prompt)) {
      outcome = 'prompt';
      break;
    }
    if (untilZone && s.nearZone === untilZone) {
      outcome = 'prompt';
      break;
    }
    const a = Math.abs(s.rel);
    await set(new Set(a < 25 ? ['w'] : ['w', s.rel > 0 ? 'd' : 'a']));
    await lib.sleep(150);
  }
  await set(new Set());
  return { outcome, lastD, log };
}

/** Follow the compass as A1 draws it. */
const followCompass = (page, ms, opts = {}) => steer(page, () => page.evaluate(BEARING, null), ms, opts);

/** Walk toward a fixed world point with the same steering. */
const walkTo = (page, target, ms, near = 2.2) => steer(page, () => page.evaluate(BEARING, target), ms, { near });

/** Walk up to a (moving) villager until the talk prompt names them. */
async function walkToNpc(page, name, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const pos = await page.evaluate((n) => {
      const p = window.__app.scene.getNpcPosition(n);
      return p ? p.toArray() : null;
    }, name);
    if (!pos) return 'no npc';
    const prompt = await page.evaluate(() => (window.__app.ui.interactionDiv ? window.__app.ui.interactionDiv.textContent : ''));
    if (new RegExp(name).test(prompt || '')) return 'prompt';
    await walkTo(page, pos, 1200, 1.5);
  }
  return 'timeout';
}

/** Readouts every `every` ms for `ms`: a prompt fades in and out, so one read can miss it. */
async function sampleReadout(page, ms = 1200, every = 150) {
  const out = [];
  const end = Date.now() + ms;
  do {
    const r = await readout(page).catch(() => null);
    if (r) out.push(r);
    await lib.sleep(every);
  } while (Date.now() < end);
  return out;
}

/** Close a villager chat that opened on the way (a villager who greets, or an E meant for something else). True when one was open. */
async function closeNpcChat(page) {
  const open = await page.evaluate(() => {
    const ui = window.__app.ui;
    const el = ui.npcChatDiv;
    const shown = !!el && el.isConnected && getComputedStyle(el).display !== 'none';
    return (ui.panels && ui.panels.current() === 'npc-chat') || shown;
  });
  if (!open) return false;
  await page.keyboard.press('Escape');
  await page.evaluate(() => {
    const ui = window.__app.ui;
    if (ui.closeNpcChat) ui.closeNpcChat();
  });
  await lib.sleep(500);
  return true;
}

/**
 * A background sampler of every change in the readout (toast, flash, prompt,
 * compass, panel, stamps), as seconds since refT. Returns stop(), which
 * resolves with the timeline.
 */
function startTimeline(page, refT) {
  let stop = false;
  const seen = new Map();
  const timeline = [];
  const strip = (l) => (l || '').replace(/\s*•?\s*[\d.]+m$/, '').trim();
  const loop = (async () => {
    while (!stop) {
      const r = await readout(page).catch(() => null);
      if (r) {
        const s = +((r.t - refT) / 1000).toFixed(1);
        for (const k of ['toast', 'flash', 'prompt']) {
          const v = r[k];
          if (v && v !== seen.get(k)) timeline.push({ s, k, v });
          seen.set(k, v);
        }
        const c = strip(r.compass);
        if (c !== seen.get('compass')) timeline.push({ s, k: 'compass', v: c || '(hidden)' });
        seen.set('compass', c);
        if (r.panel !== seen.get('panel')) timeline.push({ s, k: 'panel', v: r.panel });
        seen.set('panel', r.panel);
        if (r.stamps !== seen.get('stamps')) timeline.push({ s, k: 'stamps', v: r.stamps });
        seen.set('stamps', r.stamps);
      }
      await lib.sleep(300);
    }
  })();
  return async () => {
    stop = true;
    await loop;
    return timeline;
  };
}

/** Rect and in-viewport check for the links and buttons inside a root. */
const linkGeo = (page, rootSel) =>
  page.evaluate((sel) => {
    const root = sel ? document.querySelector(sel) : document.body;
    if (!root) return null;
    return [...root.querySelectorAll('a,button')]
      .map((el) => {
        const r = el.getBoundingClientRect();
        return { t: (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60), x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), inView: r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth };
      })
      .filter((x) => x.t);
  }, rootSel);

module.exports = { ptime, untilPage, hold, READOUT, readout, sampleReadout, closeNpcChat, BEARING, steer, followCompass, walkTo, walkToNpc, startTimeline, linkGeo };
