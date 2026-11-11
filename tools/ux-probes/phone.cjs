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

module.exports = {
  phone: { item: 'D4 (E6a)', title: 'phone tap targets under 44 px on every surface (welcome, HUD, drawer, menu, hire card, districts, emote wheel, NPC chat)', profiles: ['phone'], run: phone },
  UX_HELPERS,
  smallOf,
};
