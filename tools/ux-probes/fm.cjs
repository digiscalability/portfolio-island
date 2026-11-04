'use strict';
// First-minute scenarios (E6a, ported from the audit's first-minute/run.cjs
// and fm-lib.cjs). Every visible top-level #ui-overlay surface (plus the
// static loader and the boot fallback) is sampled every 150 ms: show, text
// change, hide. Each sample also notes a toast and a flash visible together,
// and the toast against the interaction prompt.
//
//   npm run probe -- fm [d-idle|m-idle|d-active|m-active|d-tour] --dist dist --port <n>
//   (no scenario runs all five; --scenario a,b picks several)
//
// - d-idle / m-idle: a first visit reads the card, presses Explore (and Skip
//   on the First-steps guide, when there is one), then does nothing until
//   +112 s; the same browser then comes back. cardGeo: the card's visible
//   words and buttons, and the world showing through it (the max channel of
//   the difference between the card over the world and over a blank page).
// - d-active / m-active: a typical newcomer moves, looks, follows the gold
//   arrow and opens the Portfolio menu.
// - d-tour: the full tour from the card, then the recruiter tour.
const lib = require('./lib.cjs');
const { EVENTS_INIT, eventsOf } = require('./events.cjs');

// ------------------------------------------------------------------ sampler
const SAMPLER = `(() => {
  if (window.top !== window) return;
  const FM = (window.__fm = { events: [], keys: {}, state: [], n: 0, both: [], toastPrompt: [], samples: 0 });
  const ids = new WeakMap();
  const last = new Map();
  const now = () => Math.round(performance.now());
  const norm = (s) => s.replace(/\\d+(\\.\\d+)?/g, '#');
  const visible = (el) => {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    if (r.right < 0 || r.bottom < 0 || r.left > innerWidth || r.top > innerHeight) return false;
    let n = el;
    while (n && n !== document.documentElement) {
      const cs = getComputedStyle(n);
      if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) < 0.06) return false;
      n = n.parentElement;
    }
    return true;
  };
  const idOf = (el) => {
    let i = ids.get(el);
    if (!i) { i = ++FM.n; ids.set(el, i); }
    return i;
  };
  const kindOf = (el) => {
    const ui = window.__app && window.__app.ui;
    if (!ui) return null;
    if (el === ui.toastEl) return 'toast';
    if (el === ui.flashEl) return 'flash';
    if (el === ui.interactionDiv) return 'prompt';
    if (el.id === 'ds-guide') return 'guide';
    return null;
  };
  const sample = () => {
    const t = now();
    const cands = [];
    const ls = document.getElementById('loading-screen');
    if (ls) cands.push(['static-loader', ls]);
    const bf = document.getElementById('boot-fallback');
    if (bf) cands.push(['boot-fallback', bf]);
    const ov = document.getElementById('ui-overlay');
    if (ov) for (const c of ov.children) cands.push([null, c]);
    const seen = new Set();
    for (const [name, el] of cands) {
      const id = idOf(el);
      seen.add(id);
      const vis = visible(el);
      const text = vis ? (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 260) : '';
      const prev = last.get(id);
      if (vis && text) {
        if (!prev || !prev.vis) {
          const r = el.getBoundingClientRect();
          FM.events.push({ t, id, ev: 'show', name, kind: kindOf(el), text, z: getComputedStyle(el).zIndex, rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)], aria: el.getAttribute('aria-label') || el.getAttribute('role') || '' });
          last.set(id, { vis: true, norm: norm(text), text });
        } else if (prev.norm !== norm(text)) {
          FM.events.push({ t, id, ev: 'text', name, kind: kindOf(el), text });
          last.set(id, { vis: true, norm: norm(text), text });
        }
      } else if (prev && prev.vis) {
        FM.events.push({ t, id, ev: 'hide', name, text: prev.text.slice(0, 80) });
        last.set(id, { vis: false, norm: '', text: '' });
      }
    }
    for (const [id, prev] of last) {
      if (prev.vis && !seen.has(id)) {
        FM.events.push({ t, id, ev: 'gone', text: prev.text.slice(0, 80) });
        last.set(id, { vis: false, norm: '', text: '' });
      }
    }
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith('ds_') && !(k in FM.keys)) FM.keys[k] = t;
      }
    } catch (e) {}
    const ui = window.__app && window.__app.ui;
    if (ui) {
      FM.samples++;
      const tv = ui.toastEl && visible(ui.toastEl) ? (ui.toastEl.innerText || '').replace(/\\s+/g, ' ').trim() : '';
      const fv = ui.flashEl && visible(ui.flashEl) ? (ui.flashEl.innerText || '').replace(/\\s+/g, ' ').trim() : '';
      if (tv && fv) FM.both.push({ t, toast: tv.slice(0, 80), flash: fv.slice(0, 80) });
      const pr = ui.interactionDiv;
      if (tv && pr && visible(pr)) {
        const a = ui.toastEl.getBoundingClientRect();
        const b = pr.getBoundingClientRect();
        const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        FM.toastPrompt.push({ t, overlap: w > 0 && h > 0 ? [Math.round(w), Math.round(h)] : null, promptW: Math.round(b.width), toast: tv.slice(0, 60) });
      }
    }
  };
  const state = () => {
    try {
      const a = window.__app;
      if (!a || !a.scene || !a.ui) return;
      const p = a.scene.getPlayer && a.scene.getPlayer();
      const pos = p && p.getWorldPosition ? p.getWorldPosition() : null;
      FM.state.push({
        t: now(),
        welcome: a.ui.isWelcomeVisible(),
        panel: a.ui.panels ? a.ui.panels.current() : null,
        pos: pos ? [+pos.x.toFixed(2), +pos.y.toFixed(2), +pos.z.toFixed(2)] : null,
        coins: a.scene.getCoinsCollected ? a.scene.getCoinsCollected() : null,
        stamps: a.passport && a.passport.count ? a.passport.count() : null,
        compass: a.ui.compassLabel && a.ui.compassDiv && a.ui.compassDiv.style.display !== 'none' ? a.ui.compassLabel.textContent : null,
        prompt: a.ui.interactionDiv ? (a.ui.interactionDiv.textContent || '').trim() : null,
      });
    } catch (e) {
      FM.stateErr = String(e).slice(0, 200);
    }
  };
  const start = () => {
    setInterval(sample, 150);
    setInterval(state, 500);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();`;

const ptime = (page) => page.evaluate(() => Math.round(performance.now())).catch(() => null);
async function untilPage(page, ms) {
  for (;;) {
    const t = await ptime(page);
    if (t === null || t >= ms) return t;
    await lib.sleep(Math.min(250, ms - t));
  }
}
const dump = (page) => page.evaluate(() => ({ events: window.__fm.events, keys: window.__fm.keys, state: window.__fm.state, both: window.__fm.both, toastPrompt: window.__fm.toastPrompt, samples: window.__fm.samples })).catch((e) => ({ err: String(e) }));

async function hold(page, keys, ms) {
  for (const k of keys) await page.keyboard.down(k);
  const end = Date.now() + ms;
  while (Date.now() < end) {
    await lib.sleep(Math.min(400, end - Date.now()));
    if (Date.now() < end) for (const k of keys) await page.keyboard.down(k);
  }
  for (const k of keys) await page.keyboard.up(k);
}

/** Press the card's Explore button the way the device does. */
async function explore(page, touch) {
  const sel = `${lib.WELCOME} button[data-dismiss]`;
  if (touch) await page.tap(sel).catch(() => page.click(sel));
  else await page.click(sel);
  return ptime(page);
}

/** The First-steps guide (A6), when this build has one: Skip it. */
async function skipGuide(page, touch) {
  await page.waitForTimeout(900);
  const r = await page.evaluate(() => {
    const g = document.getElementById('ds-guide');
    if (!g) return null;
    const b = [...g.querySelectorAll('button,[role=button]')].find((x) => /skip/i.test(`${x.getAttribute('aria-label') || ''} ${x.textContent || ''}`));
    if (!b) return { guide: true, skip: false };
    const q = b.getBoundingClientRect();
    return { guide: true, skip: true, xy: [q.left + q.width / 2, q.top + q.height / 2] };
  });
  if (r && r.skip) {
    if (touch) await page.touchscreen.tap(r.xy[0], r.xy[1]);
    else await page.mouse.click(r.xy[0], r.xy[1]);
    await page.waitForTimeout(300);
  }
  return r;
}

/**
 * cardGeo (D9): visible words and buttons, and the world showing through the
 * card: the card's inner box (16 px in from its edges) over the live world,
 * then over a blank page (canvas hidden); the max channel of the per-pixel
 * difference is 0 when the card is opaque.
 */
async function cardGeo(page) {
  const geo = await page.evaluate((W) => {
    const el = document.querySelector(W);
    if (!el) return null;
    const vis = (e) => {
      const b = e.getBoundingClientRect();
      if (b.width < 1 || b.height < 1) return false;
      for (let n = e; n && n !== document; n = n.parentElement) {
        const cs = getComputedStyle(n);
        if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity < 0.05) return false;
      }
      const r = el.getBoundingClientRect();
      return b.bottom > r.top && b.top < r.bottom;
    };
    const b = el.getBoundingClientRect();
    const btns = [...el.querySelectorAll('button')].filter(vis).map((x) => {
      const r = x.getBoundingClientRect();
      return { text: x.textContent.replace(/\s+/g, ' ').trim(), h: Math.round(r.height), w: Math.round(r.width), top: Math.round(r.top), disclosure: x.hasAttribute('aria-expanded') };
    });
    return {
      rect: [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)],
      scrollH: el.scrollHeight,
      clientH: el.clientHeight,
      words: el.innerText.split(/\s+/).filter(Boolean).length,
      buttons: btns.length,
      disclosures: btns.filter((x) => x.disclosure).length,
      btns,
      background: getComputedStyle(el).backgroundColor,
    };
  }, lib.WELCOME);
  if (!geo) return null;
  const [x, y, w, h] = geo.rect;
  const clip = { x: Math.max(0, x + 16), y: Math.max(0, y + 16), width: Math.max(1, w - 32), height: Math.max(1, h - 32) };
  const over = await page.screenshot({ clip }).catch(() => null);
  await page.evaluate(() => {
    const c = document.getElementById('game-canvas') || document.querySelector('canvas');
    if (c) c.style.visibility = 'hidden';
  });
  await page.waitForTimeout(120);
  const blank = await page.screenshot({ clip }).catch(() => null);
  await page.evaluate(() => {
    const c = document.getElementById('game-canvas') || document.querySelector('canvas');
    if (c) c.style.visibility = '';
  });
  if (over && blank) {
    const A = lib.pngDecode(over);
    const B = lib.pngDecode(blank);
    let max = 0;
    let diffPx = 0;
    for (let i = 0; i < A.data.length; i += 4) {
      const m = Math.max(Math.abs(A.data[i] - B.data[i]), Math.abs(A.data[i + 1] - B.data[i + 1]), Math.abs(A.data[i + 2] - B.data[i + 2]));
      if (m > max) max = m;
      if (m > 12) diffPx++;
    }
    geo.worldThrough = { clip, maxChannel: max, pixelsOver12: diffPx, pixels: A.width * A.height };
  }
  return geo;
}

/** Hints after Explore: toasts and flashes first shown later than 3 s after it. */
function hintsAfter(events, exploreAt) {
  return events
    .filter((e) => e.ev === 'show' && (e.kind === 'toast' || e.kind === 'flash' || e.z === '1750') && e.t > exploreAt + 3000)
    .map((e) => ({ s: lib.round((e.t - exploreAt) / 1000, 1), kind: e.kind || `z${e.z}`, text: e.text.slice(0, 120) }));
}

// ---------------------------------------------------------------- scenarios
async function idle(t, prof, tag) {
  const touch = lib.isTouchProfile(prof);
  const s = await t.session(prof, { init: [SAMPLER, EVENTS_INIT] });
  const { page } = s;
  const b = await t.boot(s);
  const tw = await ptime(page);
  await untilPage(page, tw + 6000); // reading the card
  await t.shot(page, `fm-${tag}-card.png`);
  const geo = await cardGeo(page);
  const tx = await explore(page, touch);
  const guide = await skipGuide(page, touch);
  await untilPage(page, tx + 112000 - 6000);
  await t.shot(page, `fm-${tag}-idle-end.png`);
  const first = await dump(page);
  const hints = hintsAfter(first.events || [], tx);
  const lost = hints.find((x) => /\bLost\?/.test(x.text));
  // The same browser comes back.
  const b2 = await t.boot(s);
  const tw2 = await ptime(page);
  await untilPage(page, tw2 + 5000);
  await t.shot(page, `fm-${tag}-return-card.png`);
  const returnCard = await page.evaluate((W) => {
    const el = document.querySelector(W);
    if (!el) return null;
    return { text: el.innerText.replace(/\s+/g, ' ').trim().slice(0, 600), buttons: [...el.querySelectorAll('button')].map((x) => x.textContent.replace(/\s+/g, ' ').trim()) };
  }, lib.WELCOME);
  const tx2 = await explore(page, touch);
  await untilPage(page, tx2 + 30000);
  const ret = await dump(page);
  const out = {
    boot: b,
    returnBoot: b2,
    cardGeo: geo,
    guide,
    exploreAtMs: tx,
    hints,
    lostHintAtS: lost ? lost.s : null,
    returnCard,
    returnHints: hintsAfter(ret.events || [], tx2),
    introEvents: (await eventsOf(page, { type: 'ds:intro' })).map((e) => e.detail),
    keys: first.keys,
  };
  t.data[tag] = out;
  // A8: an idle visitor gets the lost-visitor hint ('Lost? …', both copies) by +35 s.
  out.firstHintAfterExplore = hints[0] || null;
  t.check(`${tag}: the 'Lost?' hint is on screen by +35 s after Explore${guide && guide.guide ? ' (guide skipped)' : ''}`, lost ? lost.s <= 35 : false, lost ? `${lost.s} s` : 'not in 106 s', '<= 35 s');
  if (geo) {
    t.check(`${tag}: cardGeo words (D9: 80 or fewer)`, geo.words <= 80, geo.words, '<= 80');
    t.check(`${tag}: cardGeo visible buttons, disclosure aside (D9: 4 or fewer)`, geo.buttons - geo.disclosures <= 4, `${geo.buttons} (${geo.disclosures} disclosure)`, '<= 4 + disclosure');
    if (geo.worldThrough) t.check(`${tag}: cardGeo world through the card (max channel)`, geo.worldThrough.maxChannel === 0, geo.worldThrough.maxChannel, 0);
  } else t.check(`${tag}: the welcome card is up for cardGeo`, false, 'no card', 'card');
}

async function activeDesktop(t) {
  const s = await t.session('desktop', { init: [SAMPLER, EVENTS_INIT] });
  const p = s.page;
  const b = await t.boot(s);
  const tw = await ptime(p);
  await untilPage(p, tw + 2500);
  // Game reflexes while the card is up: W, M, E, Q (Space and Enter would
  // press the card's focused button; keyboard.cjs covers those).
  await hold(p, ['w'], 900);
  for (const k of ['m', 'e', 'q']) {
    await p.keyboard.press(k);
    await lib.sleep(250);
  }
  await untilPage(p, tw + 6000);
  const tx = await explore(p, false);
  await lib.sleep(900);
  const after = await p.evaluate(() => window.__app.ui.panels.current());
  if (after) {
    await lib.sleep(1500);
    await p.keyboard.press('Escape');
    await lib.sleep(400);
  }
  // Look with the mouse (a press-and-drag on builds that have drag look), then walk.
  await p.mouse.move(700, 470);
  await p.mouse.down();
  for (let i = 1; i <= 12; i++) {
    await p.mouse.move(700 + i * 20, 470);
    await lib.nextFrames(p, 1);
  }
  await p.mouse.up();
  await hold(p, ['w'], 3000);
  await t.shot(p, 'fm-d-active-after-walk.png');
  // Follow the gold arrow for 45 s; press E on the first prompt.
  const end = Date.now() + 45000;
  let pressedE = false;
  const held = new Set();
  const set = async (keys) => {
    for (const k of [...held]) if (!keys.includes(k)) {
      await p.keyboard.up(k);
      held.delete(k);
    }
    for (const k of keys) {
      await p.keyboard.down(k);
      held.add(k);
    }
  };
  while (Date.now() < end) {
    const st = await p.evaluate(() => {
      const h = window.__h;
      const a = h.arrow();
      return { rel: a ? a.rel : null, panel: h.app.ui.panels.current(), prompt: h.app.ui.interactionDiv ? (h.app.ui.interactionDiv.textContent || '').trim() : null };
    }).catch(() => null);
    if (!st) break;
    if (st.panel && st.panel !== 'drawer') {
      await set([]);
      await lib.sleep(2000);
      await p.keyboard.press('Escape');
      await lib.sleep(500);
      continue;
    }
    if (st.prompt && !pressedE) {
      pressedE = true;
      await set([]);
      await p.keyboard.press('e');
      await lib.sleep(2500);
      await p.keyboard.press('Escape');
      await lib.sleep(600);
      continue;
    }
    const a = st.rel === null ? null : Math.abs(st.rel);
    await set(a === null ? [] : a < 25 ? ['w'] : a > 120 ? ['w', st.rel > 0 ? 'd' : 'a'] : ['w', st.rel > 0 ? 'd' : 'a']);
    await lib.sleep(200);
  }
  await set([]);
  await t.shot(p, 'fm-d-active-after-follow.png');
  await p.click('.hud-btn[aria-label="Open portfolio menu"]').catch(() => {});
  await lib.sleep(700);
  const menu = await p.evaluate(() => window.__app.ui.panels.current());
  await t.shot(p, 'fm-d-active-menu.png');
  await p.keyboard.press('Escape');
  await untilPage(p, tw + 125000);
  const d = await dump(p);
  t.data['d-active'] = { boot: b, exploreAtMs: tx, panelAfterExplore: after, menu, both: d.both, samples: d.samples, hints: hintsAfter(d.events || [], tx) };
  t.check('d-active: no sample shows a flash and a toast together', d.samples > 0 ? d.both.length === 0 : null, d.both.length ? d.both.slice(0, 5) : `0 of ${d.samples} samples`, 'none');
}

async function activePhone(t) {
  const s = await t.session('phone', { init: [SAMPLER, EVENTS_INIT] });
  const p = s.page;
  const T = await lib.touch(s);
  const b = await t.boot(s);
  const tw = await ptime(p);
  await untilPage(p, tw + 6000);
  const tx = await explore(p, true);
  await lib.sleep(900);
  // Swipe the world to look, then the stick forward 3 s.
  const pt = await p.evaluate(() => {
    for (const [x, y] of [[250, 430], [200, 400], [300, 360], [195, 330]]) {
      const el = document.elementFromPoint(x, y);
      if (el && el.tagName === 'CANVAS') return [x, y];
    }
    return null;
  });
  if (pt) await T.drag(pt, [pt[0] - 150, pt[1]], 700);
  await lib.sleep(400);
  await T.joyHold(0, -36, 3000);
  await t.shot(p, 'fm-m-active-after-walk.png');
  // Follow the arrow with the stick for 45 s; tap USE on the first prompt.
  const end = Date.now() + 45000;
  let tapped = false;
  let down = false;
  const c = await T.joyCenter();
  while (c && Date.now() < end) {
    const st = await p.evaluate(() => {
      const h = window.__h;
      const a = h.arrow();
      return { rel: a ? a.rel : null, panel: h.app.ui.panels.current(), prompt: h.app.ui.interactionDiv ? (h.app.ui.interactionDiv.textContent || '').trim() : null };
    }).catch(() => null);
    if (!st) break;
    if (st.panel && st.panel !== 'drawer') {
      if (down) {
        await T.send('touchEnd', []);
        down = false;
      }
      await lib.sleep(2000);
      await p.evaluate(() => window.__app.ui.panels.closeTop());
      await lib.sleep(500);
      continue;
    }
    if (st.prompt && !tapped) {
      tapped = true;
      if (down) {
        await T.send('touchEnd', []);
        down = false;
      }
      const u = await T.useBtn();
      if (u) await T.tap(u[0], u[1]);
      await lib.sleep(2500);
      await p.evaluate(() => {
        window.__app.ui.panels.closeTop();
        if (window.__app.ui.closeNpcChat) window.__app.ui.closeNpcChat();
      });
      await lib.sleep(600);
      continue;
    }
    if (st.rel === null) {
      await lib.sleep(250);
      continue;
    }
    const r = (st.rel * Math.PI) / 180;
    if (!down) {
      await T.send('touchStart', [[c[0], c[1], 3]]);
      down = true;
    }
    await T.send('touchMove', [[c[0] + 38 * Math.sin(r), c[1] - 38 * Math.cos(r), 3]]);
    await lib.sleep(200);
  }
  if (down) await T.send('touchEnd', []);
  await t.shot(p, 'fm-m-active-after-follow.png');
  await p.tap('.hud-btn[aria-label="Open island menu"]').catch(() => {});
  await lib.sleep(600);
  await p.tap('.hud-btn[aria-label="Open portfolio menu"]').catch(() => {});
  await lib.sleep(700);
  const menu = await p.evaluate(() => window.__app.ui.panels.current());
  await t.shot(p, 'fm-m-active-menu.png');
  await p.evaluate(() => window.__app.ui.panels.closeTop());
  await untilPage(p, tw + 125000);
  const d = await dump(p);
  const overlaps = (d.toastPrompt || []).filter((x) => x.overlap);
  const narrow = (d.toastPrompt || []).filter((x) => x.promptW < 300);
  t.data['m-active'] = { boot: b, exploreAtMs: tx, menu, both: d.both, toastPrompt: d.toastPrompt, samples: d.samples, hints: hintsAfter(d.events || [], tx) };
  t.check('m-active: no sample shows a flash and a toast together', d.samples > 0 ? d.both.length === 0 : null, d.both.length ? d.both.slice(0, 5) : `0 of ${d.samples} samples`, 'none');
  t.check('m-active: the toast and the prompt never intersect at 390x844', (d.toastPrompt || []).length ? overlaps.length === 0 : null, overlaps.length ? overlaps.slice(0, 4) : `${(d.toastPrompt || []).length} samples with both up`, 'none');
  t.check('m-active: the prompt is 300 px wide or more beside a toast', (d.toastPrompt || []).length ? narrow.length === 0 : null, narrow.length ? narrow.slice(0, 4).map((x) => x.promptW) : 'ok', '>= 300');
}

async function tours(t) {
  const s = await t.session('desktop', { init: [SAMPLER, EVENTS_INIT] });
  const p = s.page;
  const b = await t.boot(s);
  const tw = await ptime(p);
  await untilPage(p, tw + 2000);
  // D9 moves Full tour behind 'More ways to explore': open the disclosure first.
  const disclosure = await p.evaluate((W) => {
    const card = document.querySelector(W);
    const tour = card && card.querySelector('button[data-tour]');
    const shown = tour && tour.getBoundingClientRect().height > 0 && getComputedStyle(tour).visibility !== 'hidden';
    if (shown) return 'not needed';
    const d = card && [...card.querySelectorAll('button,[role=button],summary')].find((x) => x.hasAttribute('aria-expanded') || /more ways/i.test(x.textContent || ''));
    if (!d) return 'none found';
    d.click();
    return 'opened';
  }, lib.WELCOME);
  await lib.sleep(400);
  await p.click(`${lib.WELCOME} button[data-tour]`);
  const ts = await ptime(p);
  let tEnd = null;
  for (let i = 0; i < 480; i++) {
    await lib.sleep(250);
    if (!(await p.evaluate(() => !!window.__app.tour))) {
      tEnd = await ptime(p);
      break;
    }
  }
  await lib.sleep(2500);
  await t.shot(p, 'fm-d-tour-after-end.png');
  // The recruiter tour: Portfolio menu, Hiring row, the hire card's tour button.
  await p.click('.hud-btn[aria-label="Open portfolio menu"]').catch(() => {});
  await lib.sleep(600);
  await p.click('button[data-section="hire"]').catch(() => {});
  await lib.sleep(800);
  const hireTour = await p.evaluate(() => {
    const b = document.querySelector('button[data-hire-tour]');
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { text: b.textContent.replace(/\s+/g, ' ').trim(), inView: r.top >= 0 && r.bottom <= innerHeight };
  });
  let tr = null;
  let tEnd2 = null;
  if (hireTour) {
    await p.click('button[data-hire-tour]').catch(() => {});
    tr = await ptime(p);
    for (let i = 0; i < 360; i++) {
      await lib.sleep(250);
      if (!(await p.evaluate(() => !!window.__app.tour))) {
        tEnd2 = await ptime(p);
        break;
      }
    }
  }
  await t.shot(p, 'fm-d-tour-recruit-end.png');
  t.data['d-tour'] = { boot: b, disclosure, fullTourS: tEnd ? lib.round((tEnd - ts) / 1000, 1) : null, hireTourButton: hireTour, recruiterTourS: tEnd2 && tr ? lib.round((tEnd2 - tr) / 1000, 1) : null };
  t.check('d-tour: the full tour runs to its end', tEnd !== null, t.data['d-tour'].fullTourS, 'ends');
  t.check("d-tour: the hire card's tour button is in view at 1440x900", hireTour ? hireTour.inView : false, hireTour || 'no button', 'in view');
}

const SCENARIOS = {
  'd-idle': (t) => idle(t, 'desktop', 'd-idle'),
  'm-idle': (t) => idle(t, 'phone', 'm-idle'),
  'd-active': activeDesktop,
  'm-active': activePhone,
  'd-tour': tours,
};

async function fm(t) {
  const asked = String(t.args.scenario || t.args._[1] || Object.keys(SCENARIOS).join(','))
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
  for (const sc of asked) if (!SCENARIOS[sc]) throw new lib.HarnessError(`fm: unknown scenario '${sc}' (${Object.keys(SCENARIOS).join(', ')})`);
  t.data.scenarios = asked;
  for (const sc of asked) await SCENARIOS[sc](t);
}

module.exports = {
  fm: { item: 'A8, D6, D9 (E6a)', title: 'first-minute scenarios: d-idle, m-idle (hint by +35 s, cardGeo), d-active, m-active (no flash with a toast), d-tour', profiles: ['desktop', 'phone'], run: fm },
  SAMPLER,
};
