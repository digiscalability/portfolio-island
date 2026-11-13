'use strict';
// A touch-capable laptop (E6c, from the controls audit's p5-hybrid-extra.cjs,
// now gone; rebuilt from ux-audit/results/controls.json DEVICE-01 and
// critique-r3). A 1440x900 desktop context with NO hasTouch (so pointer stays
// fine, as on a real touch laptop) and an init script that sets
// navigator.maxTouchPoints = 5. Touches go through CDP
// Input.dispatchTouchEvent. Row 0 answers critique-r3: do those touches
// arrive trusted without touch emulation? Then (D7): the desktop chips
// show, the prompt shows a keycap after a key and the USE glyph after a
// trusted tap. Keycap markup is read where D7 has it; without it the row
// reports null. 58c8849: the phone scheme, and 'Tap USE to talk to Elder
// Sage' while W walks.
//
//   npm run probe -- hybrid --dist dist --port <n>
const lib = require('./lib.cjs');
const play = require('./p2/play.cjs');

const MAX_TOUCH = `(() => {
  try { Object.defineProperty(Navigator.prototype, 'maxTouchPoints', { get: () => 5, configurable: true }); } catch (e) {}
  window.__touchTrust = [];
  for (const ty of ['touchstart', 'pointerdown']) addEventListener(ty, (e) => { if (ty === 'pointerdown' && e.pointerType !== 'touch') return; window.__touchTrust.push({ type: ty, trusted: e.isTrusted }); }, true);
})();`;

const PROMPT = () => {
  const d = window.__app.ui.interactionDiv;
  if (!d || d.style.display === 'none') return null;
  const html = d.innerHTML;
  return {
    text: (d.textContent || '').trim().slice(0, 100),
    keycap: d.querySelector('kbd, .ds-key, [data-key], [data-keycap]') ? true : /<kbd/i.test(html) ? true : null,
    useGlyph: /USE|👆/.test(d.textContent || ''),
  };
};

async function hybrid(t) {
  for (const prof of t.profiles(['desktop'])) {
    const s = await t.session(prof, { init: [MAX_TOUCH] });
    await t.boot(s);
    const { page } = s;
    await lib.dismissWelcome(page);
    await lib.sleep(1500);
    const T = await lib.touch(s);
    const out = {};
    // Row 0: a CDP touch without touch emulation, trusted or not.
    await page.evaluate(() => (window.__touchTrust.length = 0));
    await T.tap(720, 300);
    await lib.sleep(300);
    out.trust = await page.evaluate(() => window.__touchTrust.slice());
    out.cdpTouchTrusted = out.trust.length ? out.trust.every((x) => x.trusted) : null;
    t.check(`${prof}: CDP Input.dispatchTouchEvent arrives trusted without touch emulation`, out.cdpTouchTrusted === null ? null : true, out.trust.length ? out.trust : 'no touch event reached the page', 'documented (critique-r3)');
    // The scheme.
    out.scheme = await page.evaluate(() => {
      const ui = window.__app.ui;
      const vis = (el) => !!el && el.isConnected && el.getBoundingClientRect().width > 2 && getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden';
      return {
        isTouch: ui.isTouchDevice(),
        inputMode: typeof ui.getInputMode === 'function' ? ui.getInputMode() : null,
        portfolioChip: vis(document.querySelector('.hud-btn[aria-label="Open portfolio menu"]')),
        drawerButton: vis(document.querySelector('.hud-btn[aria-label="Open island menu"]')),
        coarse: matchMedia('(pointer: coarse)').matches,
      };
    });
    t.check(`${prof}: a touch laptop shows the desktop chips`, out.scheme.portfolioChip, out.scheme, 'the Portfolio chip (58c8849: the phone drawer)');
    // The prompt beside a villager: after a key, then after a trusted tap.
    const name = await page.evaluate(() => {
      const n = window.__app.scene.getIsland().npcTargets.find((x) => /Elder Sage/.test(x.name)) || window.__app.scene.getIsland().npcTargets.find((x) => x.meshRef && x.meshRef.visible);
      return n ? n.name : null;
    });
    if (name) {
      const at = await play.besideNpc(page, name, 6000);
      await page.keyboard.press('ArrowLeft');
      await lib.sleep(400);
      await play.besideNpc(page, name, 3000);
      out.afterKey = await page.evaluate(PROMPT);
      await T.tap(720, 260);
      await lib.sleep(400);
      await play.besideNpc(page, name, 3000);
      out.afterTap = await page.evaluate(PROMPT);
      out.villager = { name, at };
      await t.shot(page, `hybrid-${prof}-prompt-after-tap.png`);
    }
    t.check(`${prof}: after a key, the prompt shows a keycap`, out.afterKey ? (out.afterKey.keycap === null ? null : out.afterKey.keycap && !out.afterKey.useGlyph) : null, out.afterKey || 'no villager prompt', 'a keycap, no USE (null: no keycap markup on this build)');
    t.check(`${prof}: after a trusted tap, the prompt shows the USE glyph`, out.afterTap ? out.afterTap.useGlyph : null, out.afterTap || 'no villager prompt', "'USE'");
    t.data[prof] = out;
  }
}

module.exports = {
  hybrid: { item: 'E6c (DEVICE-01; D7)', title: 'a touch laptop (no hasTouch, maxTouchPoints 5, CDP touches): are the touches trusted, the desktop chips, the keycap after a key, the USE glyph after a tap', profiles: ['desktop'], run: hybrid },
};
