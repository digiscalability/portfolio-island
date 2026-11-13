'use strict';
// A campaign link on a plain desktop (E6c, from the controls audit's
// p7-touchparam.cjs, now gone; rebuilt from ux-audit/results/controls.json
// DEVICE-01). ?utm_content=get-in-touch carries the substring 'touch', and
// 58c8849 read location.search.includes('touch') at boot: a 1440x900 desktop
// with maxTouchPoints 0 got the phone scheme (joystick, the drawer instead of
// the Portfolio and Work-with-me chips, 'Drag the joystick to move'). D7 and
// B8 read ?touch=1 exactly. The pins row reads B8's pin scale through
// GameScene.isCoarsePointer when the build has it.
//
//   npm run probe -- touchparam --dist dist --port <n>
const lib = require('./lib.cjs');

const SCHEME = () => {
  const ui = window.__app.ui;
  const sc = window.__app.scene;
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
  const joy = document.querySelector('[data-guide="joystick"]') || [...document.querySelectorAll('#ui-overlay > div')].find((d) => d.style.touchAction === 'none' && d.style.width === '166px');
  const portfolio = document.querySelector('.hud-btn[aria-label="Open portfolio menu"]');
  const drawer = document.querySelector('.hud-btn[aria-label="Open island menu"]');
  const body = (document.getElementById('ui-overlay') || document.body).innerText || '';
  let coarse = null;
  try {
    coarse = typeof sc.isCoarsePointer === 'function' ? !!sc.isCoarsePointer() : typeof sc.constructor.isCoarsePointer === 'function' ? !!sc.constructor.isCoarsePointer() : null;
  } catch (e) {}
  return {
    isTouch: ui.isTouchDevice(),
    inputMode: typeof ui.getInputMode === 'function' ? ui.getInputMode() : null,
    maxTouchPoints: navigator.maxTouchPoints,
    joystickVisible: vis(joy),
    portfolioChip: vis(portfolio),
    drawerButton: vis(drawer),
    joystickCopy: /drag the joystick/i.test(body),
    pinCoarse: coarse,
  };
};

async function touchparam(t) {
  for (const prof of t.profiles(['desktop'])) {
    const s = await t.session(prof);
    await t.boot(s, { query: 'utm_content=get-in-touch' });
    const { page } = s;
    const card = await page.evaluate(SCHEME);
    await lib.dismissWelcome(page);
    await lib.sleep(1500);
    const hud = await page.evaluate(SCHEME);
    await t.shot(page, `touchparam-${prof}-hud.png`);
    t.data[prof] = { card, hud };
    t.check(`${prof}: ?utm_content=get-in-touch: isTouch is false`, !hud.isTouch, hud.isTouch, 'false (58c8849: true)');
    t.check(`${prof}: the joystick is hidden`, !hud.joystickVisible, hud.joystickVisible, 'hidden (58c8849: shown)');
    t.check(`${prof}: the desktop chips, not the drawer`, hud.portfolioChip, { portfolioChip: hud.portfolioChip, drawerButton: hud.drawerButton }, 'Portfolio chip visible');
    t.check(`${prof}: pins at desktop scale (B8)`, hud.pinCoarse === null ? null : !hud.pinCoarse, hud.pinCoarse, 'isCoarsePointer false (null: no hook on this build)');
  }
}

module.exports = {
  touchparam: { item: 'E6c (DEVICE-01; D7, B8)', title: '?utm_content=get-in-touch on a plain 1440x900 desktop: isTouch, the joystick, chips or drawer, the joystick copy, pin scale', profiles: ['desktop'], run: touchparam },
};
