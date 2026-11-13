'use strict';
// Keys by position on a non-QWERTY layout (E6c, from the controls audit's
// p8-layout.cjs, now gone; rebuilt from ux-audit/results/controls.json
// BIND-01). AZERTY is sent through CDP Input.dispatchKeyEvent: the physical
// W position is code KeyW with key 'z', the physical A position code KeyA with
// key 'q'. 58c8849: the W position moved the avatar 0 u and the A position
// waved instead of strafing; a QWERTY W moved 4.69 u in 0.8 s. A13 binds keys
// by e.code: the W position walks about 4.7 u and the A position strafes.
//
//   npm run probe -- layout --dist dist --port <n>
const lib = require('./lib.cjs');

const KEYS = {
  qwertyW: { code: 'KeyW', key: 'w', vk: 87 },
  azertyW: { code: 'KeyW', key: 'z', vk: 90 },
  azertyA: { code: 'KeyA', key: 'q', vk: 81 },
};

/** Hold one key for ms the way a keyboard does: keyDown, auto-repeats, keyUp. */
async function hold(cdp, k, ms) {
  const base = { code: k.code, key: k.key, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk };
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', text: k.key, unmodifiedText: k.key, ...base });
  const end = Date.now() + ms;
  while (Date.now() < end) {
    await lib.sleep(33);
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', autoRepeat: true, text: k.key, unmodifiedText: k.key, ...base });
  }
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}

const STATE = () => {
  const pl = window.__app.scene.getPlayer();
  const p = pl.getWorldPosition();
  return { p: [p.x, p.y, p.z], wave: pl.waveTime || 0, fwd: (() => {
    const f = p.clone().set(0, 0, 1).applyQuaternion(pl.quaternion);
    return [f.x, f.y, f.z];
  })() };
};

async function layout(t) {
  for (const prof of t.profiles(['desktop'])) {
    const s = await t.session(prof);
    await t.boot(s);
    const { page } = s;
    await lib.dismissWelcome(page);
    await lib.sleep(1500);
    const cdp = await page.context().newCDPSession(page);
    const out = {};
    for (const [name, k] of Object.entries(KEYS)) {
      const a = await page.evaluate(STATE);
      let maxWave = 0;
      const poll = setInterval(async () => {
        const w = await page.evaluate(() => window.__app.scene.getPlayer().waveTime || 0).catch(() => 0);
        maxWave = Math.max(maxWave, w);
      }, 100);
      await hold(cdp, k, 800);
      clearInterval(poll);
      await lib.sleep(400);
      const b = await page.evaluate(STATE);
      const d = Math.hypot(b.p[0] - a.p[0], b.p[1] - a.p[1], b.p[2] - a.p[2]);
      // Sideways share: the move's component across the avatar's starting facing.
      const mv = [b.p[0] - a.p[0], b.p[1] - a.p[1], b.p[2] - a.p[2]];
      const along = d > 1e-3 ? Math.abs(mv[0] * a.fwd[0] + mv[1] * a.fwd[1] + mv[2] * a.fwd[2]) / d : null;
      out[name] = { code: k.code, key: k.key, walked: +d.toFixed(2), alongFacing: along === null ? null : +along.toFixed(2), waved: maxWave > 0 };
      await lib.sleep(1200);
    }
    t.data[prof] = out;
    t.check(`${prof}: QWERTY W walks (control)`, out.qwertyW.walked > 3, out.qwertyW, 'about 4.7 u in 0.8 s');
    t.check(`${prof}: AZERTY W position (code KeyW, key 'z') walks`, out.azertyW.walked > 3, out.azertyW, 'about 4.7 u (58c8849: 0 u)');
    t.check(`${prof}: AZERTY A position (code KeyA, key 'q') strafes and never waves`, out.azertyA.walked > 0.5 && !out.azertyA.waved, out.azertyA, 'moves, no wave (58c8849: waved, 0 u)');
  }
}

module.exports = {
  layout: { item: 'E6c (BIND-01; A13)', title: "AZERTY through CDP Input.dispatchKeyEvent: distance walked by the W position (code KeyW, key 'z'), and whether the A position (KeyA, 'q') strafes or waves", profiles: ['desktop'], run: layout },
};
