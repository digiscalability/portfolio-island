'use strict';
// Breakpoints (E6a, ported from the UI audit's breakpoints.cjs): the welcome
// card, the HUD, the Portfolio menu and the hire card at 768x1024 touch,
// 1024x768, 844x390 touch, 667x375 touch and 1440x900. Overlaps, small
// targets, horizontal overflow, and what of the hire card is in view without
// scrolling. D5 and P2-D5's bar: LinkedIn, CV and Code in view at 844x390 and
// 1440x900; the highlights-tour button in view at 1440x900.
const lib = require('./lib.cjs');
const { UX_HELPERS, smallOf } = require('./phone.cjs');

const CONFIGS = [
  ['t768', 'tablet'],
  ['d1024', 'desktop1024'],
  ['m844L', 'landscape'],
  ['m667L', 'landscape667'],
  ['d1440', 'desktop'],
];

async function act(page, touch, sel) {
  const r = await page.evaluate((s) => {
    const all = [...document.querySelectorAll(s)];
    const el = all.find((e) => window.__ux && window.__ux.vis(e)) || all[0];
    if (!el) return null;
    el.scrollIntoView({ block: 'nearest' });
    const b = el.getBoundingClientRect();
    return [b.left + b.width / 2, b.top + b.height / 2];
  }, sel);
  if (!r) return false;
  if (touch) await page.touchscreen.tap(r[0], r[1]);
  else await page.mouse.click(r[0], r[1]);
  return true;
}

async function breakpoints(t) {
  const only = t.args.profile ? String(t.args.profile) : null;
  for (const [tag, prof] of CONFIGS) {
    if (only && only !== prof && only !== tag) continue;
    const touch = lib.isTouchProfile(prof);
    const s = await t.session(prof);
    const { page } = s;
    const r = (t.data[tag] = {});
    r.boot = await t.boot(s);
    await page.evaluate(UX_HELPERS);
    r.vp = await page.evaluate(() => [innerWidth, innerHeight]);
    r.welcome = await page.evaluate((sel) => window.__ux.surfaceInfo(document.querySelector(sel)), lib.WELCOME);
    r.welcomeSmall = touch ? smallOf(await page.evaluate((sel) => window.__ux.interactive(document.querySelector(sel)), lib.WELCOME)) : null;
    r.overflowX = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    await t.shot(page, `breakpoints-${tag}-01-welcome.png`);
    await act(page, touch, `${lib.WELCOME} button[data-dismiss]`);
    await page.waitForTimeout(1800);
    await page.evaluate(UX_HELPERS);
    r.hud = await page.evaluate(() => window.__ux.onScreen());
    r.overlaps = await page.evaluate(() => window.__ux.overlaps());
    const targets = await page.evaluate(() => window.__ux.interactive());
    r.small = touch ? smallOf(targets) : targets.filter((x) => x.h < 24 || x.w < 24).map((x) => `${x.name} ${x.w}x${x.h}`);
    await t.shot(page, `breakpoints-${tag}-02-hud.png`);
    if (touch) {
      await act(page, true, '.hud-btn[aria-label="Open island menu"]');
      await page.waitForTimeout(600);
      r.drawer = await page.evaluate(() => {
        const l = window.__app.ui.drawerListEl;
        return l ? { rect: window.__ux.rect(l), scrollH: l.scrollHeight, clientH: l.clientHeight, rows: l.children.length } : null;
      });
    }
    await act(page, touch, '[aria-label="Open portfolio menu"]');
    await page.waitForTimeout(700);
    r.menu = await page.evaluate(() => window.__ux.surfaceInfo(window.__ux.menu()));
    await t.shot(page, `breakpoints-${tag}-03-menu.png`);
    await act(page, touch, 'button[data-section="hire"]');
    await page.waitForTimeout(1000);
    const hire = await page.evaluate(() => {
      const p = window.__ux.zonePanel();
      if (!p) return null;
      const link = (re) => [...p.querySelectorAll('a,button')].find((a) => re.test(window.__ux.txt(a)));
      const one = (re) => {
        const el = link(re);
        return el ? { text: window.__ux.txt(el).slice(0, 30), inView: window.__ux.inView(el, p), rect: window.__ux.rect(el) } : null;
      };
      const pb = p.getBoundingClientRect();
      return {
        surface: window.__ux.surfaceInfo(p),
        linkedin: one(/LinkedIn/i),
        cv: one(/\bCV\b/),
        code: one(/\bCode\b|GitHub/),
        tour: (() => {
          const b = p.querySelector('button[data-hire-tour]');
          return b ? { text: window.__ux.txt(b).slice(0, 40), inView: window.__ux.inView(b, p) } : null;
        })(),
        aboveFold: [...p.querySelectorAll('h2,h3,a,button,p')].filter((e) => e.getBoundingClientRect().bottom <= Math.min(innerHeight, pb.bottom)).map((e) => window.__ux.txt(e).slice(0, 30)),
      };
    });
    r.hire = hire;
    await t.shot(page, `breakpoints-${tag}-04-hire.png`);
    const links = hire ? ['linkedin', 'cv', 'code'].map((k) => hire[k]) : [];
    r.linksInView = hire ? Object.fromEntries(['linkedin', 'cv', 'code'].map((k) => [k, hire[k] ? hire[k].inView : 'missing'])) : 'no hire card';
    if (tag === 'm844L' || tag === 'd1440') {
      t.check(`${tag}: LinkedIn, CV and Code in view in the hire card without scrolling`, hire ? links.every((x) => x && x.inView) : false, r.linksInView, 'all in view');
    }
    if (tag === 'd1440') t.check(`${tag}: the hire card's highlights-tour button in view`, hire && hire.tour ? hire.tour.inView : false, hire && hire.tour ? hire.tour : 'no tour button', 'in view');
    t.check(`${tag}: no horizontal page overflow`, r.overflowX <= 0, r.overflowX, '<= 0');
    await page.evaluate(() => window.__app.ui.panels.closeAll());
    await s.close();
  }
}

module.exports = {
  breakpoints: { item: 'D5, P2-D5 (E6a)', title: 'welcome, HUD, menu and hire card at 768x1024, 1024x768, 844x390, 667x375 and 1440x900: what is in view, overlaps, small targets', profiles: ['desktop'], run: breakpoints },
};
