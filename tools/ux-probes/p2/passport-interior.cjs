'use strict';
// p2/passport-interior (P2-E1a, from the interiors audit's dbg-passport.cjs):
// the fourth passport stamp lands inside a hall. A returning visitor with
// three zones stamped walks into Get In Touch and presses E. showZonePanel is
// wrapped so the error fadeThrough's try/catch swallows is caught. Then
// Escape, which should close only the celebration.
//
// P2-D1 and P2-A2's bar: no TypeError; the panel stack is ['zone',
// 'passport-complete']; the Leave control exists; after Escape the Get In
// Touch panel is still open, its lead form included.
const lib = require('../lib.cjs');
const R = require('./room-lib.cjs');

const STAMPED = `try { localStorage.setItem('ds_passport', JSON.stringify(['professional','projects','personal'])); localStorage.setItem('ds_welcomed','1'); } catch (e) {}`;

const STACK = () => {
  const ui = window.__app.ui;
  const pm = ui.panels;
  const zp = ui.zonePanelDiv;
  return {
    inside: window.__app.scene.isInsideInterior(),
    panel: pm ? pm.current() : null,
    stack: pm && pm.stack ? pm.stack.map((e) => e.id) : null,
    zonePanel: !!(zp && zp.isConnected),
    zoneHeading: zp && zp.isConnected ? (zp.querySelector('h2') || {}).textContent || null : null,
    leadForm: !!(zp && zp.isConnected && zp.querySelector('#lead-send, form, textarea')),
    leave: !!(ui.leaveBtn && ui.leaveBtn.isConnected),
    prompt: ui.interactionDiv ? (ui.interactionDiv.textContent || '').trim() : null,
    err: window.__zpErr || [],
    stamps: window.__app.passport && window.__app.passport.count ? window.__app.passport.count() : null,
  };
};

async function passportInterior(t) {
  for (const prof of t.profiles(['desktop'])) {
    const touch = lib.isTouchProfile(prof);
    const s = await t.session(prof, { init: [STAMPED] });
    const { page } = s;
    const T = touch ? await lib.touch(s) : null;
    const r = {};
    r.boot = await t.boot(s, { query: 'hour=12' });
    await R.install(page);
    // A returning visitor gets the returning card.
    if (touch) await page.tap(`${lib.WELCOME} button[data-dismiss]`).catch(() => lib.dismissWelcome(page));
    else await lib.dismissWelcome(page).catch(() => {});
    await page.waitForTimeout(1500);
    r.warm = await R.warm(page);
    await page.evaluate(() => {
      const ui = window.__app.ui;
      const orig = ui.showZonePanel.bind(ui);
      window.__zpErr = [];
      ui.showZonePanel = (...a) => {
        try {
          return orig(...a);
        } catch (e) {
          window.__zpErr.push(String(e));
          throw e;
        }
      };
    });
    r.enter = await R.enterRoom(page, 'contact', { touch, T, back: 3.0 });
    await page.waitForTimeout(1600);
    r.afterE = await page.evaluate(STACK);
    await t.shot(page, `passport-interior-${prof}-after-E.png`);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(700);
    r.afterEscape = await page.evaluate(STACK);
    await t.shot(page, `passport-interior-${prof}-after-escape.png`);
    r.pageErrors = s.sink.pageerrors.slice(0, 5);
    t.data[prof] = r;
    const typeErr = [...r.afterE.err, ...r.pageErrors].filter((x) => /TypeError/.test(x));
    t.check(`${prof}: no TypeError when the 4th stamp lands inside Get In Touch`, typeErr.length === 0, typeErr.length ? typeErr : 'none', 'none');
    t.check(`${prof}: the panel stack after E`, JSON.stringify(r.afterE.stack) === JSON.stringify(['zone', 'passport-complete']), r.afterE.stack, "['zone','passport-complete']");
    t.check(`${prof}: the Leave control exists inside the hall`, r.afterE.leave, r.afterE.leave, true);
    t.check(`${prof}: Escape closes only the celebration (Get In Touch and its lead form stay open)`, r.afterEscape.inside && r.afterEscape.panel === 'zone' && r.afterEscape.leadForm, { panel: r.afterEscape.panel, heading: r.afterEscape.zoneHeading, leadForm: r.afterEscape.leadForm, leave: r.afterEscape.leave }, "panel 'zone' with the lead form");
  }
}

module.exports = {
  'passport-interior': { item: 'P2-E1a (INT-02, P2-D1, P2-A2)', title: 'the 4th stamp inside Get In Touch: no TypeError, the stack, Leave, and Escape closing only the celebration', profiles: ['desktop'], run: passportInterior },
};
