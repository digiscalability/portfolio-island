'use strict';
// Villager speech-bubble contrast under bloom (E6c, from the design audit's
// bubble-ab.cjs, now gone; rebuilt from ux-audit/results/design.json DA-08).
// A villager held still, a bubble shown on it, the camera about 18 u away
// (and at --dist values), the same frame shot with bloom on and off at 12 h
// and 21 h. Contrast is the bubble's text (2nd percentile luminance inside the
// bubble's projected rect) against its fill (90th percentile). 58c8849 at
// noon, 18 u: 2.93:1 with bloom on, 15.38:1 off. DA-08's bar: 7:1 or better
// with bloom on at 12 h and 21 h.
//
// The villager is stood still through her wander state (idle until far in
// the future), NOT setNpcDialogueHold: since B8 the villager held in a chat
// loses her pin and her bubble (the chat panel carries the words), so a held
// villager's bubble is never on screen. A bubble shows on a villager the
// visitor is near but not talking to, which is what this measures.
//
//   npm run probe -- bubble [--dists 10,18,26] [--hours 12,21] --dist dist --port <n>
const lib = require('./lib.cjs');

const PLACE = ({ name, d }) => {
  const sc = window.__app.scene;
  const n = sc.getIsland().npcTargets.find((x) => x.name === name);
  const w = n.meshRef.userData.wander;
  if (w) {
    w.state = 'idle';
    w.until = 1e12;
  }
  const c = n.meshRef.position.clone();
  const up = c.clone().normalize();
  const V = c.constructor;
  const ref = Math.abs(up.y) < 0.9 ? new V(0, 1, 0) : new V(1, 0, 0);
  const tan = ref.clone().addScaledVector(up, -ref.dot(up)).normalize();
  // The camera trails the player by its follow distance: stand the player
  // d - 4.4 u out so the camera ends up about d u from the bubble.
  const away = Math.max(2, d - 4.4);
  const dir = c.clone().addScaledVector(tan, away).normalize();
  const s = sc.getIsland().sampleSurfaceByDirection(dir, 0);
  sc.getPlayer().setWorldPosition(dir.multiplyScalar(s.position.length() + 0.75));
  const oc = sc.getOrbitCamera();
  if (oc.followDir) oc.followDir.copy(tan);
  oc.yawVelocity = 0;
  if (oc.snapToPlayer) oc.snapToPlayer();
  const i = sc.getIsland().npcTargets.indexOf(n);
  sc.showNpcSpeechBubble(i, 'Hello there, welcome to the island!', 1e9);
  return i;
};
const RECT = () => {
  const sc = window.__app.scene;
  const sp = sc.npcBubble && sc.npcBubble.sprite;
  if (!sp || !sp.visible) return null;
  const cam = sc.getCamera();
  const V = cam.position.constructor;
  const c = sp.getWorldPosition(new V());
  const right = new V(1, 0, 0).applyQuaternion(cam.quaternion);
  const up = new V(0, 1, 0).applyQuaternion(cam.quaternion);
  const pts = [];
  // the bubble body is the canvas's middle band: x 16..496 of 512, y top..bottom of the 160 logical rows
  for (const [u, v] of [[0.06, 0.25], [0.94, 0.25], [0.06, 0.75], [0.94, 0.75]]) {
    const w = c.clone().addScaledVector(right, (u - sp.center.x) * sp.scale.x).addScaledVector(up, (v - sp.center.y) * sp.scale.y).project(cam);
    pts.push([((w.x + 1) / 2) * innerWidth, ((1 - w.y) / 2) * innerHeight]);
  }
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const r = { x: Math.max(0, Math.min(...xs)), y: Math.max(0, Math.min(...ys)), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
  return r.w > 8 && r.h > 4 ? r : null;
};

async function contrastOf(page, r) {
  const buf = await page.screenshot({ clip: { x: Math.round(r.x), y: Math.round(r.y), width: Math.max(4, Math.round(r.w)), height: Math.max(4, Math.round(r.h)) } });
  const png = lib.pngDecode(buf);
  const Ls = [];
  for (let i = 0; i < png.width * png.height; i++) {
    const o = i * 4;
    Ls.push([lib.luminance([png.data[o], png.data[o + 1], png.data[o + 2]]), [png.data[o], png.data[o + 1], png.data[o + 2]]]);
  }
  Ls.sort((a, b) => a[0] - b[0]);
  const text = Ls[Math.floor(Ls.length * 0.02)][1];
  const fill = Ls[Math.floor(Ls.length * 0.9)][1];
  return { ratio: +lib.contrastRatio(text, fill).toFixed(2), text, fill };
}

async function bubble(t) {
  const dists = String(t.args.dists || '18').split(',').map(Number);
  const hours = String(t.args.hours || '12,21').split(',').map(Number);
  for (const prof of t.profiles(['desktop'])) {
    const s = await t.session(prof);
    await t.boot(s);
    const { page } = s;
    await lib.dismissWelcome(page);
    await lib.sleep(1500);
    const name = await page.evaluate(() => {
      const ts = window.__app.scene.getIsland().npcTargets;
      const n = ts.find((x) => /Elder Sage/.test(x.name)) || ts.find((x) => x.meshRef && x.meshRef.visible);
      return n ? n.name : null;
    });
    if (!name) throw new Error('hook missing: a villager');
    const hasBloom = await page.evaluate(() => !!window.__app.renderer.bloomPass);
    const rows = {};
    for (const h of hours) {
      await page.evaluate((hh) => {
        const env = window.__app.scene.getEnvironmentCycle();
        if ('debugHour' in env) env.debugHour = hh;
      }, h);
      await lib.sleep(1500);
      for (const d of dists) {
        await page.evaluate((n) => {
          // A villager asleep at night is hidden: wake the held one for the shot.
          const m = window.__app.scene.getIsland().npcTargets.find((x) => x.name === n).meshRef;
          m.visible = true;
        }, name);
        await page.evaluate(PLACE, { name, d });
        await lib.sleep(900);
        const r = await page.evaluate(RECT);
        if (!r) {
          rows[`${h}h ${d}u`] = { error: 'bubble off screen' };
          continue;
        }
        const on = hasBloom ? await (async () => {
          await page.evaluate(() => (window.__app.renderer.bloomPass.enabled = true));
          await lib.sleep(300);
          return contrastOf(page, r);
        })() : null;
        if (d === dists[0]) await t.shot(page, `bubble-${prof}-h${h}-${d}u-bloom.png`, { clip: { x: Math.max(0, r.x - 40), y: Math.max(0, r.y - 40), width: Math.round(r.w + 80), height: Math.round(r.h + 80) } });
        let off = null;
        if (hasBloom) {
          const was = await page.evaluate(() => {
            const b = window.__app.renderer.bloomPass;
            const w = b.enabled;
            b.enabled = false;
            return w;
          });
          await lib.sleep(300);
          off = await contrastOf(page, r);
          await page.evaluate((w) => (window.__app.renderer.bloomPass.enabled = w), was);
        } else off = await contrastOf(page, r);
        rows[`${h}h ${d}u`] = { rect: [r.x, r.y, r.w, r.h].map(Math.round), bloomOn: on, bloomOff: off };
      }
    }
    await page.evaluate((n) => {
      const w = window.__app.scene.getIsland().npcTargets.find((x) => x.name === n).meshRef.userData.wander;
      if (w) w.until = 0;
    }, name);
    t.data[prof] = { name, hasBloom, rows };
    for (const h of hours) {
      const r = rows[`${h}h ${dists[0]}u`];
      t.check(`${prof}: bubble text contrast with bloom on at ${h} h (${dists[0]} u)`, r && r.bloomOn ? r.bloomOn.ratio >= 7 : null, r ? (r.bloomOn ? `${r.bloomOn.ratio}:1 (bloom off ${r.bloomOff.ratio}:1)` : r.error || 'no bloom on this build') : 'not run', '>= 7:1 (58c8849 noon 18 u: 2.93:1 on, 15.38:1 off)');
    }
  }
}

module.exports = {
  bubble: { item: 'E6c (DA-08; B8)', title: "villager bubble text contrast with bloom on and off, at 12 h and 21 h, the camera about 18 u away (--dists)", profiles: ['desktop'], run: bubble },
};
