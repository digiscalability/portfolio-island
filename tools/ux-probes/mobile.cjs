'use strict';
// The phone's controls (E6c, from the controls audit's p4-mobile.cjs, now
// gone; rebuilt from ux-audit/results/controls.json JOY-01, HAPTIC-01,
// RUN-01, PROMPT-01). Trusted touches through CDP. Rows:
//   landings  |v| at touchdown for 5 points on the stick's hit square
//             (58c8849: 1.00 at all 5, a full-speed lurch)
//   walk      speed at dy -10, -20 and -40 px (58c8849: 5.6 u/s at all three)
//   plateau   speed at 0.15 and 0.7 of the stick's radius (the ring found
//             from the hit square, as today), B3's 2.0 and 5.6 u/s
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
  return { sq: [a.left, a.top, a.width, a.height], c: [b.left + b.width / 2, b.top + b.height / 2], ring: b.width, thumbTransition: thumb ? getComputedStyle(thumb).transitionDuration : null };
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
    // Stick plateaus (B3, wave 4): deflection as a share of the stick's own
    // radius (the ring's half-width, read from the build), not fixed px.
    const R = h.ring / 2;
    out.plateau = { radiusPx: lib.round(R, 1) };
    for (const share of [0.15, 0.7]) {
      const c = h.c;
      await T.send('touchStart', [[c[0], c[1], 3]]);
      await lib.sleep(50);
      const end = Date.now() + 1800;
      while (Date.now() < end) {
        await T.send('touchMove', [[c[0], c[1] - share * R, 3]]);
        await lib.sleep(120);
      }
      out.plateau[share] = await page.evaluate(() => +window.__app.scene.getPlayer().getTangentialSpeed().toFixed(2));
      await T.send('touchEnd', []);
      await lib.sleep(900);
    }
    t.check(`${prof}: the stick at 0.15 of its radius walks about 2.0 u/s (B3)`, Math.abs(out.plateau[0.15] - 2.0) <= 0.2, out.plateau, '2.0 ±0.2 u/s');
    t.check(`${prof}: the stick at 0.7 of its radius walks about 5.6 u/s (B3)`, Math.abs(out.plateau[0.7] - 5.6) <= 0.3, out.plateau[0.7], '5.6 ±0.3 u/s');
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
    const vib = async () => (await page.evaluate(() => window.__vib.slice())).map((v) => (v && typeof v === 'object' && !Array.isArray(v) && 'p' in v ? v.p : v));
    out.vibrate = await vib();
    t.check(`${prof}: the vibrate log`, true, [...new Set(out.vibrate.map((v) => JSON.stringify(v)))], 'reported (58c8849: 5 and 8 ms; HAPTIC-01 wants 10, 12 and 18 ms)');
    // D15 (wave-4 rows list): the pulses judged, each read from the log
    // entries its own action adds.
    const pulsesOf = async (fn) => {
      const n = (await vib()).length;
      await fn();
      return (await vib()).slice(n);
    };
    out.haptics = {};
    out.haptics.engage = await pulsesOf(async () => {
      const c = await T.joyCenter();
      await T.send('touchStart', [[c[0], c[1], 3]]);
      await lib.sleep(120);
      await T.send('touchEnd', []);
      await lib.sleep(400);
    });
    t.check(`${prof}: the stick's engage pulse is 10 ms (D15)`, out.haptics.engage.length ? out.haptics.engage[0] === 10 : null, out.haptics.engage, '10 (58c8849 and fcaa649: 5)');
    const jump = await page.evaluate(() => {
      const el = [...document.querySelectorAll('#ui-overlay [role=button], #ui-overlay > div')].find((d) => /^jump/i.test(d.getAttribute('aria-label') || '') || /^\W*JUMP\W*$/i.test((d.textContent || '').trim()));
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return b.width > 0 ? [b.left + b.width / 2, b.top + b.height / 2] : null;
    });
    out.haptics.button = jump ? await pulsesOf(async () => {
      await T.tap(jump[0], jump[1]);
      await lib.sleep(900);
    }) : null;
    t.check(`${prof}: a HUD button press pulses 12 ms (D15; JUMP)`, out.haptics.button && out.haptics.button.length ? out.haptics.button[0] === 12 : null, out.haptics.button || 'no JUMP button found', '12 (58c8849 and fcaa649: 8)');
    // A USE tap at a cottage door: the interaction-success pulse.
    const door = await page.evaluate(() => {
      const a = window.__app;
      const d = a.scene.getIsland().houseDoors && a.scene.getIsland().houseDoors[0];
      if (!d) return null;
      const sc = a.scene;
      const dir = d.position.clone().normalize();
      const surf = sc.getIsland().sampleSurfaceByDirection(dir, 0);
      sc.getPlayer().setWorldPosition(dir.multiplyScalar(surf.position.length() + 0.75));
      return d.id;
    });
    await lib.sleep(900);
    const doorPrompt = door ? await page.evaluate(() => (window.__app.ui.interactionDiv ? window.__app.ui.interactionDiv.textContent.trim() : '')) : '';
    const u = /door|enter|knock|inside|visit|home/i.test(doorPrompt) ? await T.useBtn() : null;
    out.haptics.door = { door, prompt: doorPrompt.slice(0, 80), pulses: u ? await pulsesOf(async () => {
      await T.tap(u[0], u[1]);
      await lib.sleep(1500);
    }) : null };
    await page.evaluate(() => {
      const a = window.__app;
      try {
        if (a.scene.isInsideInterior()) a.exitBuilding(true);
      } catch (e) {}
    });
    const dp = out.haptics.door.pulses;
    t.check(`${prof}: a USE tap at a door pulses 18 ms (D15)`, dp ? dp.includes(18) : null, dp ? { prompt: out.haptics.door.prompt, pulses: dp } : `no door in reach (${door || 'no houseDoors'}; prompt '${doorPrompt.slice(0, 60)}')`, '18 among the pulses (null: no door in reach)');
    t.data[prof] = out;
  }
}

module.exports = {
  mobile: { item: 'E6c (JOY-01, HAPTIC-01, RUN-01, PROMPT-01; A11, D7)', title: 'the phone stick: |v| at touchdown, speed by deflection, the release transition, the rim run, the vibrate log, touchify on prompts', profiles: ['phone'], run: mobile },
};
