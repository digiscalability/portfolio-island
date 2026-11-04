'use strict';
// Keyboard-only navigation (E6a, ported from the controls audit's p3 and p6
// probes), for D4's focus contract:
// - the welcome card keeps Tab inside it (welcomeFocusEscapes false);
// - Space or Enter on a fresh card leaves it open (one fresh page each);
// - Enter on the Portfolio pill puts focus on the menu's first row, and the
//   menu is a non-modal dialog (no aria-modal);
// - a zone panel opened from the menu takes focus, ArrowDown x5 and PageDown
//   scroll it, and Escape returns focus to the pill;
// - on the phone, the drawer stays open while focus moves through it.
const lib = require('./lib.cjs');

const PILL = '[aria-label="Open portfolio menu"]';

// In-page: what has focus, and where it sits.
const FOCUS = (W) => {
  const a = document.activeElement;
  const desc = (el) => {
    if (!el) return null;
    if (el === document.body) return 'BODY';
    const t = (el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 50);
    return `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}[${t}]`;
  };
  const w = document.querySelector(W);
  const pm = window.__app.ui.panels;
  const menu = [...document.querySelectorAll('#ui-overlay > div')].find((d) => d.querySelector && d.querySelector('button[data-section="hire"]') && d.getBoundingClientRect().height > 0) || null;
  const zone = window.__app.ui.zonePanelDiv || null;
  return {
    el: desc(a),
    inWelcome: !!(w && a && w.contains(a)),
    inMenu: !!(menu && a && menu.contains(a)),
    inZone: !!(zone && a && zone.contains(a)),
    isPill: !!(a && a.matches && a.matches('[aria-label="Open portfolio menu"]')),
    panel: pm ? pm.current() : null,
  };
};

async function welcomeTab(t) {
  const s = await t.session('desktop');
  const b = await t.boot(s);
  const { page } = s;
  await page.waitForTimeout(600);
  const seq = [await page.evaluate(FOCUS, lib.WELCOME)];
  for (let i = 0; i < 10; i++) {
    await page.keyboard.press('Tab');
    await page.waitForTimeout(80);
    seq.push(await page.evaluate(FOCUS, lib.WELCOME));
  }
  const escapes = seq.some((f) => !f.inWelcome);
  t.data.welcomeTab = { boot: b, sequence: seq.map((f) => `${f.el} ${f.inWelcome ? 'in card' : 'OUTSIDE'}`) };
  t.check('welcome card: Tab x10 keeps focus inside (welcomeFocusEscapes false)', !escapes, escapes, false);
  await t.shot(page, 'keyboard-welcome-tab.png');
}

async function cardKey(t, key) {
  const s = await t.session('desktop');
  await t.boot(s);
  const { page } = s;
  await page.waitForTimeout(1500);
  const before = await page.evaluate(FOCUS, lib.WELCOME);
  await page.keyboard.press(key);
  await page.waitForTimeout(1200);
  const after = await page.evaluate((W) => {
    const el = document.querySelector(W);
    return { open: !!el && el.getBoundingClientRect().height > 0 && window.__app.ui.isWelcomeVisible(), panel: window.__app.ui.panels.current() };
  }, lib.WELCOME);
  t.data[`card${key}`] = { focusBefore: before.el, ...after };
  t.check(`a fresh card: ${key} leaves it open`, after.open, after.open ? 'open' : `closed (panel ${after.panel})`, 'open');
}

async function menuAndPanel(t) {
  const s = await t.session('desktop');
  const b = await t.boot(s);
  const { page } = s;
  await lib.dismissWelcome(page);
  await page.waitForTimeout(1200);
  await page.evaluate(() => window.__app.ui.panels.closeAll());
  // Enter on the Portfolio pill.
  await page.evaluate((sel) => document.querySelector(sel) && document.querySelector(sel).focus(), PILL);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(700);
  const menu = await page.evaluate(FOCUS, lib.WELCOME);
  const menuAttrs = await page.evaluate(() => {
    const m = [...document.querySelectorAll('#ui-overlay > div')].find((d) => d.querySelector && d.querySelector('button[data-section="hire"]') && d.getBoundingClientRect().height > 0);
    if (!m) return null;
    const rows = [...m.querySelectorAll('button')];
    return { role: m.getAttribute('role'), ariaModal: m.getAttribute('aria-modal'), labelledby: m.getAttribute('aria-labelledby'), firstRow: rows[0] ? rows[0].textContent.replace(/\s+/g, ' ').trim().slice(0, 40) : null, firstRowFocused: rows[0] === document.activeElement };
  });
  t.data.menu = { focus: menu, attrs: menuAttrs };
  t.check('Enter on the Portfolio pill: focus lands on the menu\'s first row', menu.panel === 'portfolio-menu' ? !!(menuAttrs && menuAttrs.firstRowFocused) : false, `${menu.el} (panel ${menu.panel})`, menuAttrs ? menuAttrs.firstRow : 'first row');
  t.check('the Portfolio menu is not aria-modal', menuAttrs ? menuAttrs.ariaModal !== 'true' : null, menuAttrs ? menuAttrs.ariaModal : 'no menu', 'absent');
  await t.shot(page, 'keyboard-menu.png');
  // A zone panel from the menu, by keyboard.
  await page.evaluate(() => {
    const b = document.querySelector('button[data-section="projects"]');
    if (b) b.focus();
  });
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1000);
  const zone = await page.evaluate(FOCUS, lib.WELCOME);
  const scroll = async (key, n) => {
    const s0 = await page.evaluate(() => (window.__app.ui.zonePanelDiv ? window.__app.ui.zonePanelDiv.scrollTop : null));
    for (let i = 0; i < n; i++) {
      await page.keyboard.press(key);
      await page.waitForTimeout(90);
    }
    await page.waitForTimeout(300);
    const s1 = await page.evaluate(() => (window.__app.ui.zonePanelDiv ? window.__app.ui.zonePanelDiv.scrollTop : null));
    return { from: s0, to: s1 };
  };
  const down = await scroll('ArrowDown', 5);
  const pg = await scroll('PageDown', 1);
  const walked = await page.evaluate(() => window.__h.pos().toArray());
  await t.shot(page, 'keyboard-zone-panel.png');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(600);
  const back = await page.evaluate(FOCUS, lib.WELCOME);
  t.data.zone = { boot: b, focus: zone, arrowDown5: down, pageDown: pg, playerAfter: walked, afterEscape: back };
  t.check('a zone panel opened from the menu takes focus', zone.panel === 'zone' ? zone.inZone : false, `${zone.el} (panel ${zone.panel})`, 'inside the panel');
  t.check('ArrowDown x5 scrolls the panel', down.from !== null && down.to > down.from, down, 'scrollTop grows');
  t.check('PageDown scrolls the panel', pg.from !== null && pg.to > pg.from, pg, 'scrollTop grows');
  t.check('Escape returns focus to the Portfolio pill', back.isPill, back.el, 'the Portfolio pill');
}

async function phoneDrawer(t) {
  const s = await t.session('phone');
  await t.boot(s);
  const { page } = s;
  await page.tap(`${lib.WELCOME} button[data-dismiss]`).catch(() => lib.dismissWelcome(page));
  await page.waitForTimeout(1200);
  const toggle = await page.$('[aria-label="Open island menu"]');
  if (!toggle) {
    t.check('phone: the drawer stays open for 20 s while focus moves through it', null, 'no drawer toggle', 'open');
    return;
  }
  await toggle.tap().catch(() => toggle.click());
  await page.waitForTimeout(600);
  const open = () => page.evaluate(() => {
    const l = window.__app.ui.drawerListEl;
    if (!l) return null;
    const b = l.getBoundingClientRect();
    return b.height > 4 && getComputedStyle(l).visibility !== 'hidden' && +getComputedStyle(l).opacity > 0.05;
  });
  // Focus the first drawer row, then move with Tab every 2 s for 20 s.
  await page.evaluate(() => {
    const l = window.__app.ui.drawerListEl;
    const f = l && l.querySelector('[tabindex],button,a');
    if (f) f.focus();
  });
  const trace = [];
  for (let i = 0; i < 10; i++) {
    await page.waitForTimeout(2000);
    await page.keyboard.press('Tab');
    trace.push(await open());
  }
  t.data.phoneDrawer = { openEvery2s: trace };
  t.check('phone: the drawer stays open for 20 s while focus moves through it', trace.every((x) => x === true), trace.map((x) => (x ? 'open' : 'closed')).join(','), 'open throughout');
  await t.shot(page, 'keyboard-phone-drawer.png');
}

async function keyboard(t) {
  await welcomeTab(t);
  await cardKey(t, 'Space');
  await cardKey(t, 'Enter');
  await menuAndPanel(t);
  if (!t.args.profile || t.args.profile === 'phone') await phoneDrawer(t);
}

module.exports = {
  keyboard: { item: 'D4 (E6a)', title: 'welcome Tab trap, Space/Enter on a fresh card, Enter on the Portfolio pill, a zone panel takes focus and scrolls, Escape returns it, the phone drawer', profiles: ['desktop'], run: keyboard },
};
