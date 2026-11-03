'use strict';
// Panel probes (D1, D2): the Leaderboard's "Guide me to the start line", and
// what browser Back does with a panel open.
//
// Independence rules: panels come from __app.ui.panels.current(), the welcome
// card is found by its role and aria-label, and menus are opened through their
// aria-labelled HUD buttons, the way a visitor does.
const lib = require('./lib.cjs');

const W = lib.WELCOME;
const PORTFOLIO = '#ui-overlay [aria-label="Open portfolio menu"]';
const DRAWER = '.hud-btn[aria-label="Open island menu"]';

const press = (page, touch, sel) => (touch ? page.tap(sel) : page.click(sel));

const PANELS = () => {
  const pm = window.__app.ui.panels;
  return { current: pm.current(), stack: (pm.stack || []).map((e) => e.id), scrim: pm.scrim ? getComputedStyle(pm.scrim).display : null };
};
const TOUCH_CONTROLS = () =>
  [...document.querySelectorAll('#ui-overlay > div')]
    .filter((d) => (d.style.width === '166px' && d.style.touchAction === 'none') || (d.children.length === 2 && /^(USE|JUMP|WAVE)$/.test((d.lastElementChild.textContent || '').trim())))
    .map((d) => ({ control: (d.lastElementChild && /^(USE|JUMP|WAVE)$/.test(d.lastElementChild.textContent.trim()) ? d.lastElementChild.textContent.trim() : 'joystick'), display: d.style.display || 'default', visible: window.__h.visible(d) }));
const CHIP_OPACITY = () => {
  const el = document.querySelector('#ui-overlay [aria-label="Open portfolio menu"]');
  return el ? +getComputedStyle(el).opacity : null;
};

async function openMenu(page, touch) {
  await page.evaluate(() => {
    window.__app.ui.hideZonePanel();
    window.__app.ui.panels.closeAll();
  });
  await page.waitForTimeout(250);
  if (touch && (await page.$(DRAWER))) {
    await page.tap(DRAWER);
    await page.waitForTimeout(500);
  }
  await press(page, touch, PORTFOLIO);
  await page.waitForTimeout(600);
}

async function guideMe(t) {
  for (const prof of t.profiles(['desktop', 'phone'])) {
    const touch = prof !== 'desktop';
    const s = await t.session(prof);
    const b = await t.boot(s);
    const { page } = s;
    await press(page, touch, `${W} button[data-dismiss]`);
    await page.waitForTimeout(1500);
    await openMenu(page, touch);
    await page.waitForSelector('button[data-board="leaderboard"]', { state: 'visible', timeout: 8000 });
    await press(page, touch, 'button[data-board="leaderboard"]');
    await page.waitForTimeout(1500);
    const before = await page.evaluate(PANELS);
    await press(page, touch, 'text=Guide me to the start line');
    await lib.nextFrames(page, 1);
    const after = { ...(await page.evaluate(PANELS)), chipOpacity: await page.evaluate(CHIP_OPACITY), touchControls: touch ? await page.evaluate(TOUCH_CONTROLS) : null };
    await t.shot(page, `guide-me-${prof}.png`);
    await page.waitForTimeout(6000);
    const after6s = await page.evaluate(PANELS);
    t.data[prof] = { boot: b, before, afterNextFrame: after, after6s };
    t.check(`${prof}: panels.current() right after the click`, after.current === null, after.current, null);
    t.check(`${prof}: the panel stack right after the click`, after.stack.length === 0, after.stack, []);
    t.check(`${prof}: the scrim is hidden right after the click`, after.scrim === 'none', after.scrim, 'none');
    t.check(`${prof}: the HUD is not dimmed (Portfolio pill opacity)`, after.chipOpacity !== null && after.chipOpacity >= 0.9, after.chipOpacity, '>= 0.9');
    if (touch) {
      const tc = after.touchControls || [];
      const need = ['joystick', 'USE', 'JUMP', 'WAVE'];
      const shown = need.filter((n) => tc.some((c) => c.control === n && c.visible));
      t.check(`${prof}: joystick and USE/JUMP/WAVE visible in the next frame`, shown.length === need.length, shown, need);
    }
  }
}

// ------------------------------------------------------------------- back
const ON_APP = (base) => (u) => u.startsWith(base);

async function goBack(page) {
  await page.goBack({ waitUntil: 'commit', timeout: 10000 }).catch(() => null);
  await page.waitForTimeout(900);
  return page.url();
}

async function appState(page) {
  return page
    .evaluate(() => ({
      panel: window.__app ? window.__app.ui.panels.current() : null,
      zone: new URL(location.href).searchParams.get('zone'),
      historyLength: history.length,
      zonePanelInDom: !!(window.__h && window.__h.zonePanel() && window.__h.visible(window.__h.zonePanel())),
    }))
    .catch(() => null);
}

async function openSection(page, touch, id) {
  await openMenu(page, touch);
  await page.waitForSelector(`button[data-section="${id}"]`, { state: 'visible', timeout: 8000 });
  await press(page, touch, `button[data-section="${id}"]`);
  await page.waitForTimeout(900);
}

async function back(t) {
  const onApp = ON_APP(t.base);
  const cases = {};
  const want = (name, pass, value, expect) => t.check(name, pass, value, expect);
  const desktop = t.profiles(['desktop', 'phone']).includes('desktop');
  const phone = t.profiles(['desktop', 'phone']).includes('phone');
  const fresh = async (prof, query) => {
    const s = await t.session(prof, { init: ["window.addEventListener('pageshow', (e) => { window.__pageshowPersisted = e.persisted; });"] });
    await t.boot(s, query ? { query } : {});
    return s;
  };

  if (desktop) {
    // 1-2. Projects, then Back; then Back again.
    {
      const s = await fresh('desktop');
      const p = s.page;
      await press(p, false, `${W} button[data-dismiss]`);
      await p.waitForTimeout(1200);
      await openSection(p, false, 'projects');
      const open = await appState(p);
      const u1 = await goBack(p);
      const st1 = onApp(u1) ? await appState(p) : null;
      const u2 = onApp(u1) ? await goBack(p) : null;
      cases.projectsThenBack = { open, urlAfterBack: u1, after: st1, urlAfterSecondBack: u2 };
      want('1. Projects, then Back: still on the island', onApp(u1), u1, 'the island');
      want('1. Projects, then Back: panel null, no zone param', !!st1 && st1.panel === null && !st1.zone, st1, '{ panel: null, zone: null }');
      want('2. a second Back leaves the site', u2 !== null && !onApp(u2), u2, 'off the island');
      if (onApp(pageUrl(p))) await t.shot(p, 'back-1-desktop.png');
    }
    // 3. Close with the ✕, then one Back leaves the site.
    {
      const s = await fresh('desktop');
      const p = s.page;
      await press(p, false, `${W} button[data-dismiss]`);
      await p.waitForTimeout(1200);
      await openSection(p, false, 'projects');
      const closed = await p.evaluate(() => {
        const z = window.__h.zonePanel();
        const x = z && [...z.querySelectorAll('button,[role=button]')].find((b) => /^(×|✕)$/.test((b.textContent || '').trim()) || /close/i.test(b.getAttribute('aria-label') || ''));
        if (!x) return false;
        x.click();
        return true;
      });
      await p.waitForTimeout(500);
      const u = await goBack(p);
      cases.closeThenBack = { closedWithX: closed, urlAfterBack: u };
      want('3. ✕, then one Back leaves the site', closed && !onApp(u), u, 'off the island');
    }
    // 4. ?zone=hire opens the hire card, and one Back leaves the site.
    {
      const s = await fresh('desktop', 'zone=hire');
      const p = s.page;
      await p.waitForTimeout(800);
      const st = await appState(p);
      const u = await goBack(p);
      cases.zoneHire = { opened: st, urlAfterBack: u };
      want('4. ?zone=hire opens the hire card', !!st && st.panel !== null, st && st.panel, 'a panel');
      want('4. ?zone=hire, then one Back leaves the site', !onApp(u), u, 'off the island');
    }
    // 6. Projects, then Hiring from the menu (a sweep), then one Back.
    {
      const s = await fresh('desktop');
      const p = s.page;
      await press(p, false, `${W} button[data-dismiss]`);
      await p.waitForTimeout(1200);
      await openSection(p, false, 'projects');
      await openSection(p, false, 'hire');
      const open = await appState(p);
      const u = await goBack(p);
      const st = onApp(u) ? await appState(p) : null;
      cases.sweepThenBack = { open, urlAfterBack: u, after: st };
      want('6. Projects, then Hiring (a sweep), then one Back: back on the island', onApp(u) && !!st && st.panel === null, st || u, 'the island, no panel');
    }
    // 7. Overlays that must not add history entries.
    {
      const s = await fresh('desktop');
      const p = s.page;
      const h0 = await p.evaluate(() => history.length);
      const rows = [['welcome card (boot)', h0]];
      await press(p, false, `${W} button[data-dismiss]`);
      await p.waitForTimeout(800);
      const step = async (label, fn) => {
        await fn();
        await p.waitForTimeout(500);
        rows.push([label, await p.evaluate(() => history.length)]);
        await p.keyboard.press('Escape').catch(() => {});
        await p.evaluate(() => window.__app.ui.panels.closeAll()).catch(() => {});
        await p.waitForTimeout(300);
      };
      if (await p.$(DRAWER)) await step('drawer', () => p.click(DRAWER));
      if (await p.$('.hud-btn[aria-label="Send an emote"]')) await step('emote wheel', () => p.click('.hud-btn[aria-label="Send an emote"]'));
      await step('chat input', () => p.keyboard.press('Enter'));
      await step('tour', () => p.evaluate(() => typeof window.__app.startTour === 'function' && window.__app.startTour()));
      await p.evaluate(() => window.__app.tour && window.__app.endTour && window.__app.endTour()).catch(() => {});
      cases.historyLength = rows;
      const grew = rows.filter(([, n]) => n !== h0);
      want('7. welcome card, drawer, emote wheel, chat input and tour leave history.length unchanged', grew.length === 0, rows, `all ${h0}`);
    }
    // 8. bfcache: away and back, panels.current() matches the DOM.
    {
      const s = await fresh('desktop');
      const p = s.page;
      await press(p, false, `${W} button[data-dismiss]`);
      await p.waitForTimeout(1200);
      await openSection(p, false, 'projects');
      const before = await appState(p);
      await p.goto('about:blank').catch(() => {});
      await p.waitForTimeout(500);
      await p.goBack({ waitUntil: 'commit', timeout: 15000 }).catch(() => null);
      await p.waitForFunction(() => window.__lifeIslandReady === true, null, { timeout: 120000 }).catch(() => {});
      await p.evaluate(lib.HELPERS).catch(() => {});
      await p.waitForTimeout(800);
      const st = await appState(p);
      const restored = await p.evaluate(() => window.__pageshowPersisted === true).catch(() => null);
      cases.bfcache = { before, restoredFromBfcache: restored, after: st };
      const match = !!st && (st.panel === 'zone') === st.zonePanelInDom;
      want('8. after away-and-back, panels.current() matches the DOM', match, st, 'panel state == DOM');
    }
  }
  if (phone) {
    // 5. Phone: drawer, Portfolio, Projects, then Back once; then Back again.
    const s = await fresh('phone');
    const p = s.page;
    await p.tap(`${W} button[data-dismiss]`);
    await p.waitForTimeout(1500);
    await openSection(p, true, 'projects');
    const open = await appState(p);
    const u1 = await goBack(p);
    const st1 = onApp(u1) ? await appState(p) : null;
    const u2 = onApp(u1) ? await goBack(p) : null;
    cases.phoneProjectsThenBack = { open, urlAfterBack: u1, after: st1, urlAfterSecondBack: u2 };
    want('5. phone: drawer, Portfolio, Projects, then Back: island, no panel, no zone', onApp(u1) && !!st1 && st1.panel === null && !st1.zone, st1 || u1, 'the island, no panel');
    want('5. phone: the next Back leaves the site', u2 !== null && !onApp(u2), u2, 'off the island');
  }
  t.data.cases = cases;
}

const pageUrl = (p) => {
  try {
    return p.url();
  } catch (e) {
    return '';
  }
};

module.exports = {
  'guide-me': { item: 'D1', title: "Leaderboard → 'Guide me to the start line': panels, scrim, touch controls", profiles: ['desktop', 'phone'], run: guideMe },
  back: { item: 'D2', title: 'browser Back with a panel open: the history cases', profiles: ['desktop', 'phone'], run: back },
};
