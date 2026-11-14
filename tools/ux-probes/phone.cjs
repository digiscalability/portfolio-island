'use strict';
// Phone small targets (E6a, ported from the UI audit's phone.cjs): every
// interactive element on each phone surface whose tap target is under 44 px
// on either side (.hud-btn's ::after pad counts as max(box, 44)). D4's bar:
// every list is empty. Surfaces: the welcome card, the HUD, the drawer, the
// Portfolio menu, the hire card and the four district panels, the emote
// wheel and the NPC chat. UX_HELPERS (window.__ux) is shared with
// breakpoints.cjs.
const lib = require('./lib.cjs');

const UX_HELPERS = () => {
  const vis = (el) => {
    if (!el || !el.isConnected) return false;
    const b = el.getBoundingClientRect();
    if (b.width < 1 || b.height < 1) return false;
    for (let n = el; n && n !== document; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity < 0.05) return false;
    }
    return b.right > 0 && b.bottom > 0 && b.left < innerWidth && b.top < innerHeight;
  };
  const txt = (el) => ((el && el.textContent) || '').replace(/\s+/g, ' ').trim();
  const accName = (el) => {
    if (!el) return '';
    const al = el.getAttribute('aria-label');
    if (al) return al.trim();
    const lb = el.getAttribute('aria-labelledby');
    if (lb) return lb.split(/\s+/).map((id) => txt(document.getElementById(id))).join(' ');
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return el.getAttribute('title') || el.getAttribute('placeholder') || '';
    return txt(el) || el.getAttribute('title') || '';
  };
  const label = (el) => {
    if (!el) return 'null';
    if (el === document.body) return 'BODY';
    return `${el.tagName.toLowerCase()}${el.getAttribute('role') ? `[role=${el.getAttribute('role')}]` : ''}:${accName(el).slice(0, 48)}`;
  };
  const rect = (el) => {
    const b = el.getBoundingClientRect();
    return [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)];
  };
  const zonePanel = () => {
    const z = window.__app && window.__app.ui && window.__app.ui.zonePanelDiv;
    if (z && vis(z)) return z;
    return [...document.querySelectorAll('#ui-overlay > div')].find((d) => d.style.zIndex === '1650' && d.querySelector('[data-email], h2') && !d.getAttribute('role') && vis(d)) || null;
  };
  const menu = () => [...document.querySelectorAll('#ui-overlay > div')].find((d) => d.querySelector && d.querySelector('button[data-section="hire"]') && vis(d)) || null;
  const modal = () => [...document.querySelectorAll('#ui-overlay > [role=dialog]')].filter(vis).pop() || null;
  const isHudBtn = (el) => el.classList && el.classList.contains('hud-btn');
  const INTERACTIVE = 'button, a[href], input, textarea, select, [role=button], [tabindex]:not([tabindex="-1"])';
  const interactive = (root = document) =>
    [...(root || document).querySelectorAll(INTERACTIVE)].filter(vis).map((el) => {
      const b = el.getBoundingClientRect();
      const hitW = isHudBtn(el) ? Math.max(b.width, 44) : b.width;
      const hitH = isHudBtn(el) ? Math.max(b.height, 44) : b.height;
      return { label: label(el), name: accName(el).slice(0, 60), rect: rect(el), w: Math.round(b.width), h: Math.round(b.height), hitW: Math.round(hitW), hitH: Math.round(hitH) };
    });
  const overlaps = () => {
    const els = [...document.querySelectorAll(INTERACTIVE)].filter(vis);
    const out = [];
    for (let i = 0; i < els.length; i++)
      for (let j = i + 1; j < els.length; j++) {
        const a = els[i];
        const b = els[j];
        if (a.contains(b) || b.contains(a)) continue;
        const A = a.getBoundingClientRect();
        const B = b.getBoundingClientRect();
        const w = Math.min(A.right, B.right) - Math.max(A.left, B.left);
        const h = Math.min(A.bottom, B.bottom) - Math.max(A.top, B.top);
        if (w > 1 && h > 1) out.push(`${label(a)} X ${label(b)} = ${Math.round(w)}x${Math.round(h)}`);
      }
    return out;
  };
  const onScreen = () => [...document.querySelectorAll('#ui-overlay > *')].filter(vis).map((el) => `${label(el).slice(0, 60)} ${rect(el).join(',')} z${getComputedStyle(el).zIndex}`);
  const inView = (el, root) => {
    if (!vis(el)) return false;
    const b = el.getBoundingClientRect();
    const r = root ? root.getBoundingClientRect() : { top: 0, left: 0, bottom: innerHeight, right: innerWidth };
    return b.top >= Math.max(0, r.top) - 1 && b.bottom <= Math.min(innerHeight, r.bottom) + 1 && b.left >= -1 && b.right <= innerWidth + 1;
  };
  const surfaceInfo = (el) => {
    if (!el) return null;
    return { role: el.getAttribute('role'), ariaModal: el.getAttribute('aria-modal'), rect: rect(el), scrollH: el.scrollHeight, clientH: el.clientHeight, words: txt(el).split(' ').length, headings: [...el.querySelectorAll('h1,h2,h3')].map((h) => `${h.tagName}:${txt(h).slice(0, 50)}`) };
  };
  window.__ux = { vis, txt, accName, label, rect, zonePanel, menu, modal, interactive, overlaps, onScreen, inView, surfaceInfo };
  return true;
};

const smallOf = (list) => (list || []).filter((t) => t.hitH < 44 || t.hitW < 44).map((t) => `${t.name || t.label} ${t.w}x${t.h}${t.hitH !== t.h || t.hitW !== t.w ? ` (pad ${t.hitW}x${t.hitH})` : ''}`);

async function tapSel(page, sel) {
  const r = await page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return [b.left + b.width / 2, b.top + b.height / 2];
  }, sel);
  if (!r) return false;
  await page.touchscreen.tap(r[0], r[1]);
  return true;
}

async function openMenu(page) {
  await page.evaluate(() => window.__app.ui.panels.closeAll());
  await page.waitForTimeout(250);
  await tapSel(page, '.hud-btn[aria-label="Open island menu"]');
  await page.waitForTimeout(500);
  await tapSel(page, '.hud-btn[aria-label="Open portfolio menu"]');
  await page.waitForTimeout(700);
}

async function phone(t) {
  const s = await t.session('phone');
  const b = await t.boot(s);
  const { page } = s;
  await page.evaluate(UX_HELPERS);
  const lists = {};
  const note = async (name, rootFn, shot) => {
    await page.evaluate(UX_HELPERS);
    const targets = await page.evaluate(rootFn);
    lists[name] = targets === null ? null : smallOf(targets);
    if (shot) await t.shot(page, `phone-${name}.png`);
  };
  await note('welcome', (W) => window.__ux.interactive(document.querySelector('[role=dialog][aria-label="Welcome to DigiScalability Life Island"]')), true);
  await tapSel(page, `${lib.WELCOME} button[data-dismiss]`);
  await page.waitForTimeout(1800);
  await note('hud', () => window.__ux.interactive(), true);
  lists.hudOverlaps = await page.evaluate(() => window.__ux.overlaps());
  await tapSel(page, '.hud-btn[aria-label="Open island menu"]');
  await page.waitForTimeout(700);
  await note('drawer', () => (window.__app.ui.drawerListEl ? window.__ux.interactive(window.__app.ui.drawerListEl) : null), true);
  await openMenu(page);
  await note('menu', () => (window.__ux.menu() ? window.__ux.interactive(window.__ux.menu()) : null), true);
  for (const id of ['hire', 'professional', 'projects', 'personal', 'contact']) {
    await openMenu(page);
    await tapSel(page, `button[data-section="${id}"]`);
    await page.waitForTimeout(1100);
    await note(`section_${id}`, () => (window.__ux.zonePanel() ? window.__ux.interactive(window.__ux.zonePanel()) : null), id === 'hire');
  }
  await page.evaluate(() => window.__app.ui.panels.closeAll());
  await page.waitForTimeout(300);
  if (await tapSel(page, '.hud-btn[aria-label="Send an emote"]')) {
    await page.waitForTimeout(500);
    await note('emote', () => (window.__app.ui.emoteWheel ? window.__ux.interactive(window.__app.ui.emoteWheel) : null), true);
    await page.evaluate(() => window.__app.ui.panels.closeAll());
  }
  // The NPC chat, opened beside the Storyteller.
  const near = await page.evaluate(() => {
    const app = window.__app;
    const ts = app.scene.getIsland().npcTargets;
    const tg = ts.find((x) => x.name === 'Storyteller' && x.meshRef.visible) || ts.find((x) => x.meshRef.visible);
    if (!tg) return null;
    const c = tg.meshRef.position.clone();
    const up = c.clone().normalize();
    const ref = Math.abs(up.y) < 0.9 ? up.clone().set(0, 1, 0) : up.clone().set(1, 0, 0);
    const p = c.clone().addScaledVector(ref.clone().cross(up).normalize(), 1.6);
    p.setLength(c.length() + 0.6);
    app.scene.getPlayer().setWorldPosition(p);
    return tg.name;
  });
  await page.waitForTimeout(1500);
  const T = await lib.touch(s);
  const u = await T.useBtn();
  if (near && u) {
    await T.tap(u[0], u[1]);
    await page.waitForTimeout(1300);
    await note('npcChat', () => (window.__app.ui.npcChatDiv ? window.__ux.interactive(window.__app.ui.npcChatDiv) : null), true);
    await page.evaluate(() => window.__app.ui.closeNpcChat && window.__app.ui.closeNpcChat());
  }
  t.data = Object.assign(t.data, { boot: b, smallTargets: lists });
  for (const [name, list] of Object.entries(lists)) {
    if (name === 'hudOverlaps') continue;
    t.check(`phone ${name}: tap targets under 44 px`, list === null ? null : list.length === 0, list === null ? 'surface did not open' : list.length ? list : 'none', 'none');
  }
}

// ---------------------------------------------------------- D16 (wave 4)
// Does the minimap or the compass show through a card at 390x844 and
// 844x390? For each card (the Portfolio menu, the hire card, the Projects
// panel) and each element, the part of the element under the card is
// screenshotted with the element shown (A), hidden (B) and shown again (C).
// The element shows through when A and B differ in more of the pixels than
// A and C do (the live scene's own motion) by 1% or more. The minimap's
// label cap height is measured from its own fillText calls: the 'H' ascent
// of each label font, times the canvas transform, in CSS px.
const LABEL_INIT = `(() => {
  if (window.top !== window) return;
  const W = (window.__mapText = new WeakMap());
  const f = CanvasRenderingContext2D.prototype.fillText;
  CanvasRenderingContext2D.prototype.fillText = function (text, x, y, m) {
    try {
      let a = W.get(this.canvas);
      if (!a) W.set(this.canvas, (a = []));
      a.push({ text: String(text).slice(0, 24), font: this.font, k: this.getTransform().a });
      if (a.length > 400) a.splice(0, 200);
    } catch (e) {}
    return f.call(this, text, x, y, m);
  };
})();`;
const MAP_LABELS = () => {
  const c = window.__app.ui.mapCanvas;
  if (!c || !c.isConnected) return null;
  const css = c.getBoundingClientRect().width / c.width;
  const calls = (window.__mapText.get(c) || []).filter((x) => /[A-Za-z]{2,}/.test(x.text));
  const m = document.createElement('canvas').getContext('2d');
  const seen = new Map();
  for (const x of calls) {
    // The online-count pill ('3 ONLINE') is a caption on the ring, not a
    // place label; it is keyed apart so a shared font cannot hide either.
    const pill = /^\d+\s+ONLINE$/i.test(x.text.trim());
    const key = `${pill ? 'pill' : 'label'}|${x.font}|${x.k}`;
    if (seen.has(key)) continue;
    m.font = x.font;
    const cap = m.measureText('H').actualBoundingBoxAscent * x.k * css;
    seen.set(key, { font: x.font, capPx: Math.round(cap * 10) / 10, sample: x.text, pill });
  }
  return { rows: [...seen.values()] };
};
/**
 * D16's row: the minimap's place labels (the Hub, the districts), which D16
 * sets to 10.5 px/600. The online-count pill is reported apart: D16 does not
 * change it (6.7 px at 844x390 on main and on wave 4 alike).
 */
function judgeMapLabels(read) {
  if (!read || !Array.isArray(read.rows)) return null;
  const labels = read.rows.filter((r) => !r.pill);
  const pills = read.rows.filter((r) => r.pill);
  return { labels, pills, minCapPx: labels.length ? Math.min(...labels.map((r) => r.capPx)) : null, pillCapPx: pills.length ? Math.min(...pills.map((r) => r.capPx)) : null };
}
const RECT_UNDER = (which) => {
  const ui = window.__app.ui;
  const el = which === 'minimap' ? ui.mapCanvas : ui.compassDiv;
  const panels = [ui.zonePanelDiv, document.querySelector('[aria-label="Portfolio menu"]'), ...document.querySelectorAll('[role=dialog]')].filter((d) => d && d.isConnected && getComputedStyle(d).display !== 'none' && parseFloat(getComputedStyle(d).opacity) > 0.5);
  if (!el || !el.isConnected || getComputedStyle(el).display === 'none' || !panels.length) return null;
  const e = el.getBoundingClientRect();
  let best = null;
  for (const p of panels) {
    const r = p.getBoundingClientRect();
    // Inset by the card's corner radius (and border) where the overlap meets
    // its edge: a rounded corner's outside is not the card.
    const cs = getComputedStyle(p);
    const rad = Math.max(...['borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomLeftRadius', 'borderBottomRightRadius'].map((k) => parseFloat(cs[k]) || 0)) + (parseFloat(cs.borderTopWidth) || 0);
    const x0 = Math.max(e.left, r.left + rad);
    const y0 = Math.max(e.top, r.top + rad);
    const x1 = Math.min(e.right, r.right - rad, innerWidth);
    const y1 = Math.min(e.bottom, r.bottom - rad, innerHeight);
    if (x1 - x0 >= 4 && y1 - y0 >= 4 && (!best || (x1 - x0) * (y1 - y0) > best.width * best.height)) best = { x: Math.floor(x0), y: Math.floor(y0), width: Math.floor(x1 - x0), height: Math.floor(y1 - y0) };
  }
  return best;
};
function diffFrac(a, b) {
  let n = 0;
  // 4 levels: a 0.95-alpha card over a bright minimap moves pixels by about 5-13.
  for (let i = 0; i < a.data.length; i += 4) if (Math.abs(a.data[i] - b.data[i]) > 4 || Math.abs(a.data[i + 1] - b.data[i + 1]) > 4 || Math.abs(a.data[i + 2] - b.data[i + 2]) > 4) n++;
  return n / (a.data.length / 4);
}
async function showsThrough(page, which) {
  const clip = await page.evaluate(RECT_UNDER, which);
  if (!clip) return { overlap: false };
  const vis = (v) =>
    page.evaluate(
      ([w, on]) => {
        const ui = window.__app.ui;
        const el = w === 'minimap' ? ui.mapCanvas : ui.compassDiv;
        el.style.visibility = on ? '' : 'hidden';
      },
      [which, v],
    );
  const A = lib.pngDecode(await page.screenshot({ clip }));
  await vis(false);
  await page.waitForTimeout(80);
  const B = lib.pngDecode(await page.screenshot({ clip }));
  await vis(true);
  await page.waitForTimeout(80);
  const C = lib.pngDecode(await page.screenshot({ clip }));
  const signal = diffFrac(A, B);
  const noise = diffFrac(A, C);
  return { overlap: true, clip, signalPct: lib.round(signal * 100, 1), noisePct: lib.round(noise * 100, 1), through: signal - noise >= 0.01 };
}

async function showthrough(t) {
  for (const prof of t.profiles(['phone', 'landscape'])) {
    const s = await t.session(prof, { init: [LABEL_INIT] });
    const { page } = s;
    await t.boot(s, { query: 'hour=12' });
    await tapSel(page, `${lib.WELCOME} button[data-dismiss]`);
    await page.waitForTimeout(2500);
    const out = { labels: judgeMapLabels(await page.evaluate(MAP_LABELS)), cards: {} };
    await t.shot(page, `showthrough-${prof}-hud.png`);
    t.check(`${prof}: minimap label cap height (D16)`, out.labels && out.labels.minCapPx !== null ? out.labels.minCapPx >= 7 : null, out.labels ? out.labels.labels.map((l) => `${l.capPx} px ${l.font} (${l.sample})`) : 'no minimap', '>= 7 px (CSS)');
    t.check(`${prof}: the minimap's online-count pill cap height (reported)`, true, out.labels && out.labels.pillCapPx !== null ? out.labels.pills.map((l) => `${l.capPx} px ${l.font} (${l.sample})`) : 'no pill drawn', 'reported, not D16 (main 6.7 px at 844x390)');
    const cards = [
      ['menu', async () => openMenu(page)],
      [
        'hire card',
        async () => {
          await page.evaluate(() => window.__app.ui.panels.closeAll());
          await page.evaluate(() => window.__app.ui.showHireCard && window.__app.ui.showHireCard('menu'));
          await page.waitForTimeout(900);
        },
      ],
      [
        'Projects',
        async () => {
          await openMenu(page);
          await tapSel(page, 'button[data-section="projects"]');
          await page.waitForTimeout(1100);
        },
      ],
    ];
    for (const [name, open] of cards) {
      await open();
      // --selftest-through: make every open card half transparent; the rows must fail.
      if (t.args.selftestThrough)
        await page.evaluate(() => {
          for (const d of [window.__app.ui.zonePanelDiv, document.querySelector('[aria-label="Portfolio menu"]'), ...document.querySelectorAll('[role=dialog]')]) if (d && d.isConnected) d.style.background = 'rgba(12, 12, 20, 0.5)';
        });
      const r = { minimap: await showsThrough(page, 'minimap'), compass: await showsThrough(page, 'compass') };
      out.cards[name] = r;
      await t.shot(page, `showthrough-${prof}-${name.replace(/\s+/g, '-')}.png`);
      const hits = Object.entries(r).filter(([, v]) => v.through);
      const any = Object.values(r).some((v) => v.overlap);
      t.check(`${prof}: the minimap or compass shows through the ${name} (D16)`, any ? hits.length === 0 : true, any ? Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v.overlap ? `${v.signalPct}% hidden vs ${v.noisePct}% noise${v.through ? ' (through)' : ''}` : 'not under the card'])) : 'neither is under the card', 'not through (A/B pixel diff no more than the A/C noise + 1%)');
    }
    await page.evaluate(() => window.__app.ui.panels.closeAll());
    t.data[prof] = out;
    await s.close();
  }
}

module.exports = {
  showthrough: { item: 'D16 (wave 4)', title: 'at 390x844 and 844x390: the minimap or compass showing through the menu, the hire card and Projects (pixels), and the minimap label cap height', profiles: ['phone', 'landscape'], run: showthrough },
  phone: { item: 'D4 (E6a)', title: 'phone tap targets under 44 px on every surface (welcome, HUD, drawer, menu, hire card, districts, emote wheel, NPC chat)', profiles: ['phone'], run: phone },
  UX_HELPERS,
  smallOf,
  judgeMapLabels,
};
