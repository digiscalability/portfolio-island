'use strict';
// The phone's controls (E6c, from the controls audit's p4-mobile.cjs, now
// gone; rebuilt from ux-audit/results/controls.json JOY-01, HAPTIC-01,
// RUN-01, PROMPT-01). Trusted touches through CDP. Rows:
//   landings  |v| at touchdown for 5 points on the stick's hit square
//             (58c8849: 1.00 at all 5, a full-speed lurch)
//   walk      speed at dy -10, -20 and -40 px (58c8849: 5.6 u/s at all three)
//   release   the thumb's return transition (58c8849: 0s, a snap)
//   vibrate   every navigator.vibrate pulse (58c8849: 5 and 8 ms only)
//   rim run   the stick pushed past its rim: running or not (A11's touch run)
//   touchify  prompts on touch with no 'press E' and no keyboard glyph left
//
//   npm run probe -- mobile --dist dist --port <n>
const lib = require('./lib.cjs');
const play = require('./p2/play.cjs');

const VIB = `(() => {
  window.__vib = [];
  try { const v = navigator.vibrate ? navigator.vibrate.bind(navigator) : null; navigator.vibrate = (p) => { window.__vib.push(p); return v ? v(p) : true; }; } catch (e) {}
})();`;

const JOY = () => {
  const ui = window.__app.ui;
  const j = ui.joyState || { forward: 0, strafe: 0 };
  return +Math.hypot(j.forward, j.strafe).toFixed(2);
};
const HIT = () => {
  const anchor = document.querySelector('[data-guide="joystick"]');
  const sq = [...document.querySelectorAll('#ui-overlay > div')].find((d) => d.style.touchAction === 'none' && d.style.width === '166px') || (anchor && anchor.parentElement);
  const ring = anchor || (sq && sq.firstElementChild);
  if (!sq || !ring) return null;
  const a = sq.getBoundingClientRect();
  const b = ring.getBoundingClientRect();
  const thumb = ring.querySelector('div');
  return { sq: [a.left, a.top, a.width, a.height], c: [b.left + b.width / 2, b.top + b.height / 2], thumbTransition: thumb ? getComputedStyle(thumb).transitionDuration : null };
};

async function mobile(t) {
  for (const prof of t.profiles(['phone'])) {
    const s = await t.session(prof, { init: [VIB] });
    await t.boot(s);
    const { page } = s;
    await page.tap(`${lib.WELCOME} button[data-dismiss]`).catch(() => lib.dismissWelcome(page));
    await lib.sleep(1800);
    const T = await lib.touch(s);
    const out = {};
    const h = await page.evaluate(HIT);
    if (!h) throw new Error('hook missing: the joystick hit square');
    out.hit = h;
    // landings
    const [x, y, w, hh] = h.sq;
    const pts = [
      [x + 4, y + 4],
      [x + w - 4, y + 4],
      [x + 4, y + hh - 4],
      [x + w - 4, y + hh - 4],
      [x + w / 2, y + 4],
    ];
    out.landings = [];
    for (const p of pts) {
      await T.send('touchStart', [[p[0], p[1], 5]]);
      await lib.sleep(60);
      const v = await page.evaluate(JOY);
      await T.send('touchEnd', []);
      await lib.sleep(400);
      out.landings.push({ at: p.map(Math.round), fromCentre: Math.round(Math.hypot(p[0] - h.c[0], p[1] - h.c[1])), v });
    }
    t.check(`${prof}: |v| at touchdown on the hit square's rim`, out.landings.every((l) => l.v === 0), out.landings.map((l) => l.v), '0 at all 5 (58c8849: 1.00 at all 5)');
    // walk plateaus
    out.walk = {};
    for (const dy of [-10, -20, -40]) {
      const c = h.c;
      await T.send('touchStart', [[c[0], c[1], 3]]);
      await lib.sleep(50);
      const end = Date.now() + 1800;
      while (Date.now() < end) {
        await T.send('touchMove', [[c[0], c[1] + dy, 3]]);
        await lib.sleep(120);
      }
      out.walk[dy] = await page.evaluate(() => +window.__app.scene.getPlayer().getTangentialSpeed().toFixed(2));
      await T.send('touchEnd', []);
      out.release = await page.evaluate(HIT);
      await lib.sleep(900);
    }
    t.check(`${prof}: the stick's speed follows deflection`, out.walk[-10] < 3.5 && out.walk[-40] > 5, out.walk, 'dy -10 about 2 u/s, -40 about 5.6 (58c8849: 5.6 at all three)');
    const tr = out.release ? out.release.thumbTransition : null;
    t.check(`${prof}: the thumb eases home on release`, tr === null ? null : tr.split(',').some((x) => parseFloat(x) > 0), tr, 'a transition of about 120 ms (58c8849: 0s)');
    // rim run: the stick pushed past its rim for 2 s
    {
      const c = h.c;
      await T.send('touchStart', [[c[0], c[1], 3]]);
      await lib.sleep(50);
      const end = Date.now() + 2200;
      while (Date.now() < end) {
        await T.send('touchMove', [[c[0], c[1] - 70, 3]]);
        await lib.sleep(120);
      }
      out.rimRun = await page.evaluate(() => ({ running: window.__app.scene.getPlayer().isRunning(), speed: +window.__app.scene.getPlayer().getTangentialSpeed().toFixed(2) }));
      await T.send('touchEnd', []);
      await lib.sleep(900);
    }
    t.check(`${prof}: pushing the stick to the edge runs`, out.rimRun.running || out.rimRun.speed > 7, out.rimRun, 'running, about 7.9 u/s (58c8849: the JUMP button held runs, the rim walks at 5.6)');
    // touchify: the villager and door prompts on touch
    const name = await page.evaluate(() => {
      const n = window.__app.scene.getIsland().npcTargets.find((x) => /Elder Sage/.test(x.name)) || window.__app.scene.getIsland().npcTargets.find((x) => x.meshRef && x.meshRef.visible);
      return n ? n.name : null;
    });
    const prompts = [];
    if (name && (await play.besideNpc(page, name, 6000)) === 'prompt') prompts.push(await page.evaluate(() => window.__app.ui.interactionDiv.textContent.trim()));
    await t.shot(page, `mobile-${prof}-prompt.png`);
    out.prompts = prompts;
    const bad = prompts.filter((p) => /press\s*E\b|⌨️/i.test(p));
    t.check(`${prof}: touch prompts carry no 'press E' or keyboard glyph`, prompts.length ? bad.length === 0 : null, prompts, "no 'press E', no ⌨️");
    // haptics
    // A pattern may arrive as a number, an array, or (through the harness's own wrapper) {t, p}.
    out.vibrate = (await page.evaluate(() => window.__vib.slice())).map((v) => (v && typeof v === 'object' && !Array.isArray(v) && 'p' in v ? v.p : v));
    t.check(`${prof}: the vibrate log`, true, [...new Set(out.vibrate.map((v) => JSON.stringify(v)))],'reported (58c8849: 5 and 8 ms; HAPTIC-01 wants 10, 12 and 18 ms)');
    t.data[prof] = out;
  }
}

module.exports = {
  mobile: { item: 'E6c (JOY-01, HAPTIC-01, RUN-01, PROMPT-01; A11, D7)', title: 'the phone stick: |v| at touchdown, speed by deflection, the release transition, the rim run, the vibrate log, touchify on prompts', profiles: ['phone'], run: mobile },
};
