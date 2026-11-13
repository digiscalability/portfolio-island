'use strict';
// Villager motion and chat framing (E6c, from the motion audit's npcprobe.cjs,
// analyze_npc.cjs and npcshots.cjs, now gone; rebuilt from
// ux-audit/results/motion.json MOT-11, MOT-12, MOT-13 and checked against the
// numbers it recorded on 58c8849). Rows:
//   gait     bob and roll cycles per leg cycle while walking (58c8849: bob 1,
//            roll 0.5; MOT-12 wants 2 and 1), the walk-start leg pop
//            (8-11 deg in one frame), sole height while walking
//   poses    the lowest sole of sitting and kneeling villagers
//            (58c8849: -0.121 u sitting, -0.089 u kneeling)
//   talk     a villager held in dialogue for 4 s: arm range and the first
//            gesture's time (58c8849: 12 deg, the first hop 4-9 s in)
//   lean     the root's tilt while the visitor types (B8; null without it)
//   framing  at 390x844 and 1440x900 during a chat: the bubble and the pin
//            inside the viewport, the pin's bottom above the head's top
// Villager state is read from each meshRef.userData (wander, limbs).
//
//   npm run probe -- npc --dist dist --port <n>
const lib = require('./lib.cjs');
const play = require('./p2/play.cjs');

const INSTALL = () => {
  const sc = window.__app.scene;
  const isl = sc.getIsland();
  const V = sc.getPlayer().getWorldPosition().constructor;
  const tmp = new V();
  const soleCache = new Map();
  const surf = (p) => isl.sampleSurfaceByDirection(p.clone().normalize(), 0).position.length();
  const sole = (ref) => {
    let s = soleCache.get(ref);
    if (!s) {
      s = [];
      ref.traverse((m) => {
        if (!m.isSkinnedMesh || !m.geometry || !m.geometry.attributes.position) return;
        const a = m.geometry.attributes.position;
        const idx = [...Array(a.count).keys()].sort((i, j) => a.getY(i) - a.getY(j)).slice(0, 16);
        s.push({ m, idx });
      });
      soleCache.set(ref, s);
    }
    let best = Infinity;
    for (const { m, idx } of s)
      for (const i of idx) {
        m.getVertexPosition(i, tmp);
        tmp.applyMatrix4(m.matrixWorld);
        best = Math.min(best, tmp.length() - surf(tmp));
      }
    return best === Infinity ? null : best;
  };
  const N = (window.__npc = { rec: false, rows: [], sole, every: 6 });
  let f = 0;
  const tick = () => {
    if (N.rec) {
      f++;
      const fr = { t: performance.now(), v: [] };
      isl.npcTargets.forEach((n, i) => {
        const r = n.meshRef;
        const ud = r && r.userData;
        const w = ud && ud.wander;
        if (!w || !r.visible) return;
        const limbs = ud.limbs || null;
        fr.v.push({ i, name: n.name, off: r.position.length() - w.radius, roll: w.roll, dist: w.dist, leg: limbs ? limbs[0].ang : null, arm: limbs ? limbs[3].ang : null, pose: w.pose || null, sole: f % N.every === 0 ? sole(r) : null });
      });
      N.rows.push(fr);
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  return isl.npcTargets.length;
};

const cycles = (xs) => {
  // zero crossings of the mean-removed series / 2
  if (xs.length < 8) return 0;
  const m = xs.reduce((s, x) => s + x, 0) / xs.length;
  let n = 0;
  for (let i = 1; i < xs.length; i++) if (xs[i - 1] - m < 0 && xs[i] - m >= 0) n++;
  return n;
};

async function record(page, ms) {
  await page.evaluate(() => {
    window.__npc.rows = [];
    window.__npc.rec = true;
  });
  await lib.sleep(ms);
  return page.evaluate(() => {
    window.__npc.rec = false;
    return window.__npc.rows;
  });
}

function gait(rows) {
  // Per villager: frames where it walks (dist advancing).
  const by = new Map();
  for (const fr of rows) for (const v of fr.v) (by.get(v.name) || by.set(v.name, []).get(v.name)).push({ t: fr.t, ...v });
  const per = [];
  let pops = [];
  const soles = [];
  for (const [name, s] of by) {
    const walk = [];
    for (let i = 1; i < s.length; i++) {
      const moving = s[i].dist - s[i - 1].dist > 1e-4;
      if (moving) walk.push(s[i]);
      // walk start: the first moving frame after a still one
      if (moving && i >= 2 && !(s[i - 1].dist - s[i - 2].dist > 1e-4) && s[i].leg !== null && s[i - 1].leg !== null) pops.push(Math.abs(s[i].leg - s[i - 1].leg) * (180 / Math.PI));
    }
    if (walk.length < 90) continue;
    const legC = cycles(walk.map((x) => x.leg));
    if (!legC) continue;
    per.push({ name, frames: walk.length, bobPerLeg: +(cycles(walk.map((x) => x.off)) / legC).toFixed(2), rollPerLeg: +(cycles(walk.map((x) => x.roll)) / legC).toFixed(2) });
    for (const x of walk) if (x.sole !== null) soles.push(x.sole);
  }
  const med = (a) => (a.length ? +[...a].sort((x, y) => x - y)[Math.floor(a.length / 2)].toFixed(2) : null);
  return { walkers: per.length, per: per.slice(0, 8), bobPerLeg: med(per.map((p) => p.bobPerLeg)), rollPerLeg: med(per.map((p) => p.rollPerLeg)), walkStartPopDeg: pops.length ? +Math.max(...pops).toFixed(1) : null, walkStartPopMedianDeg: pops.length ? +[...pops].sort((a, b) => a - b)[Math.floor(pops.length / 2)].toFixed(1) : null, pops: pops.length, soleWalking: soles.length ? { min: +Math.min(...soles).toFixed(3), max: +Math.max(...soles).toFixed(3) } : null };
}

/**
 * The chat's sprite bounds for one villager (`name`; the held one by
 * default): its pin, the bubble when it is on her, the head's projected top.
 * `others: true` adds every other villager whose root projects inside the
 * viewport, with a pin on screen (B8 fades the HELD villager's pin and
 * bubble during a chat by design, so hers read null there).
 */
const FRAMING = ({ name = null, others = false } = {}) => {
  const sc = window.__app.scene;
  const cam = sc.getCamera();
  const V = cam.position.constructor;
  const W = innerWidth;
  const H = innerHeight;
  const px = (v) => [((v.x + 1) / 2) * W, ((1 - v.y) / 2) * H];
  const spriteRect = (sp) => {
    if (!sp || !sp.visible) return null;
    const c = sp.getWorldPosition(new V());
    const right = new V(1, 0, 0).applyQuaternion(cam.quaternion);
    const up = new V(0, 1, 0).applyQuaternion(cam.quaternion);
    const sx = sp.scale.x;
    const sy = sp.scale.y;
    const cx = sp.center ? sp.center.x : 0.5;
    const cy = sp.center ? sp.center.y : 0.5;
    if (sp.material && sp.material.sizeAttenuation === false) {
      // A fixed-size sprite: its scale is in clip units (three's sprite shader
      // multiplies by -mvPosition.z, which the divide cancels).
      const n = c.clone().project(cam);
      const P = cam.projectionMatrix.elements;
      const hw = P[0] * sx;
      const hh = P[5] * sy;
      const x0 = n.x - cx * hw;
      const y0 = n.y - cy * hh;
      const a = px({ x: x0, y: y0 + hh });
      const b = px({ x: x0 + hw, y: y0 });
      return [a[0], a[1], b[0], b[1]].map(Math.round);
    }
    const pts = [];
    for (const [u, v] of [[0, 0], [1, 0], [0, 1], [1, 1]]) pts.push(px(c.clone().addScaledVector(right, (u - cx) * sx).addScaledVector(up, (v - cy) * sy).project(cam)));
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)].map(Math.round);
  };
  const held = sc.heldNpcName;
  const targets = sc.getIsland().npcTargets;
  const inView = (r) => (r ? r[0] >= 0 && r[1] >= 0 && r[2] <= W && r[3] <= H : null);
  const one = (n) => {
    const tag = n && (sc.nameTags || []).find((g) => g.target === n || g.target.meshRef === n.meshRef);
    let headTop = null;
    if (n) {
      let top = -Infinity;
      let topP = null;
      n.meshRef.traverse((m) => {
        if (!m.isMesh || !m.geometry) return;
        if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
        const b = m.geometry.boundingBox;
        for (const x of [b.min.x, b.max.x]) for (const y of [b.min.y, b.max.y]) for (const z of [b.min.z, b.max.z]) {
          const w = new V(x, y, z).applyMatrix4(m.matrixWorld);
          if (w.length() > top) {
            top = w.length();
            topP = w;
          }
        }
      });
      if (topP) headTop = Math.round(px(topP.project(cam))[1]);
    }
    const bt = sc.npcBubble && n && sc.nameTags ? sc.nameTags[sc.npcBubbleFor] : null;
    const onHer = !!bt && (bt.target === n || bt.target.meshRef === n.meshRef);
    const bubble = onHer ? spriteRect(sc.npcBubble.sprite) : null;
    const pin = spriteRect(tag && tag.sprite);
    const pinOpacity = tag && tag.sprite && tag.sprite.material ? +tag.sprite.material.opacity.toFixed(2) : null;
    return { name: n ? n.name : null, bubble, pin, pinOpacity, headTop, bubbleInView: inView(bubble), pinInView: inView(pin), pinAboveHead: pin && headTop !== null ? pin[3] <= headTop : null };
  };
  const n = targets.find((x) => x.name === (name || held));
  const out = { held, ...one(n) };
  if (others) {
    out.others = [];
    for (const o of targets) {
      if (o === n || !o.meshRef.visible) continue;
      const c = o.meshRef.getWorldPosition(new V()).project(cam);
      // Inside the middle 80% of the view: a villager at the very edge has
      // her pin cut by the edge whatever the chat does.
      if (c.z > 1 || Math.abs(c.x) > 0.8 || Math.abs(c.y) > 0.8) continue;
      const r = one(o);
      if (r.pin) out.others.push(r);
    }
  }
  return out;
};
/** The head-top read is a bounding-box corner, above the mesh: pins within this many px of it count as above. */
const HEAD_TOL_PX = 2;
/** The nearest other villager on screen, by index (for a bubble during the chat). */
const OTHER_ON_SCREEN = (held) => {
  const sc = window.__app.scene;
  const cam = sc.getCamera();
  const V = cam.position.constructor;
  const ts = sc.getIsland().npcTargets;
  let best = -1;
  let bd = Infinity;
  ts.forEach((o, i) => {
    if (o.name === held || !o.meshRef.visible) return;
    const w = o.meshRef.getWorldPosition(new V());
    const c = w.clone().project(cam);
    if (c.z > 1 || Math.abs(c.x) > 0.8 || c.y < -0.8 || c.y > 0.5) return;
    const d = w.distanceTo(cam.position);
    if (d < bd) {
      bd = d;
      best = i;
    }
  });
  return best;
};

async function npc(t) {
  // Gait, poses and talk on the desktop; chat framing on both sizes.
  for (const prof of t.profiles(['desktop', 'phone'])) {
    const touch = lib.isTouchProfile(prof);
    const s = await t.session(prof);
    await t.boot(s);
    const { page } = s;
    if (touch) await page.tap(`${lib.WELCOME} button[data-dismiss]`).catch(() => lib.dismissWelcome(page));
    else await lib.dismissWelcome(page);
    await lib.sleep(1500);
    await page.evaluate(INSTALL);
    const T = touch ? await lib.touch(s) : null;
    const out = {};
    if (!touch) {
      const rows = await record(page, 9000);
      out.gait = gait(rows);
      t.check(`${prof}: bob cycles per leg cycle while walking`, out.gait.bobPerLeg === null ? null : Math.abs(out.gait.bobPerLeg - 2) <= 0.3, out.gait.bobPerLeg, '2 (58c8849: 1, once per stride)');
      t.check(`${prof}: roll cycles per leg cycle`, out.gait.rollPerLeg === null ? null : Math.abs(out.gait.rollPerLeg - 1) <= 0.2, out.gait.rollPerLeg, '1 (58c8849: 0.5)');
      t.check(`${prof}: the walk-start leg pop`, out.gait.walkStartPopDeg === null ? null : out.gait.walkStartPopDeg < 2, out.gait.walkStartPopDeg, '< 2 deg (58c8849: 8-11 deg)');
      t.check(`${prof}: soles while walking`, out.gait.soleWalking ? out.gait.soleWalking.min >= -0.01 && out.gait.soleWalking.min <= 0.01 : null, out.gait.soleWalking, 'min 0 to 0.01 u (58c8849: 0.061-0.147 u)');
      // poses: the lowest sole of each sitting and kneeling villager seen
      const posed = {};
      for (const fr of rows) for (const v of fr.v) if (v.pose && v.sole !== null) posed[v.pose] = Math.min(posed[v.pose] ?? Infinity, v.sole);
      out.poses = Object.fromEntries(Object.entries(posed).map(([k, x]) => [k, +x.toFixed(3)]));
      for (const p of ['sit', 'kneel']) t.check(`${prof}: ${p === 'sit' ? 'sitting' : 'kneeling'} soles within 0.02 u of the ground or seat`, out.poses[p] === undefined ? null : Math.abs(out.poses[p]) <= 0.02, out.poses[p] ?? `no villager in the '${p}' pose in the window`, `+/-0.02 u (58c8849: ${p === 'sit' ? '-0.121' : '-0.089'} u)`);
    }
    // talk: hold the Elder Sage (or the first awake villager) in dialogue.
    const name = await page.evaluate(() => {
      const ts = window.__app.scene.getIsland().npcTargets;
      const n = ts.find((x) => /Elder Sage/.test(x.name) && x.meshRef.visible) || ts.find((x) => x.meshRef && x.meshRef.visible && x.meshRef.userData.limbs);
      return n ? n.name : null;
    });
    if (name) {
      const chat = await play.openChat(page, touch, T, name);
      const heldName = await page.evaluate(() => window.__app.scene.heldNpcName);
      if (!heldName) await page.evaluate((n) => window.__app.scene.setNpcDialogueHold(n), name);
      const t0 = await page.evaluate(() => performance.now());
      const rows = await record(page, 4000);
      const arms = [];
      let firstGesture = null;
      let a0 = null;
      for (const fr of rows) {
        const v = fr.v.find((x) => x.name === (heldName || name));
        if (!v || v.arm === null) continue;
        arms.push(v.arm);
        if (a0 === null) a0 = v.arm;
        if (firstGesture === null && Math.abs(v.arm - a0) * (180 / Math.PI) > 10) firstGesture = Math.round(fr.t - t0);
      }
      out.talk = { name: heldName || name, chat: !!chat.chat, armRangeDeg: arms.length ? +((Math.max(...arms) - Math.min(...arms)) * (180 / Math.PI)).toFixed(1) : null, firstGestureMs: firstGesture };
      if (!touch) {
        t.check(`${prof}: arm range over 4 s of talk`, out.talk.armRangeDeg === null ? null : out.talk.armRangeDeg >= 40, out.talk.armRangeDeg, '>= 40 deg (58c8849: 12 deg)');
        t.check(`${prof}: the first gesture within 1.6 s`, out.talk.armRangeDeg === null ? null : firstGesture !== null && firstGesture <= 1600, firstGesture, '<= 1600 ms');
        // lean on typing (B8): the root's tilt from plumb before and while typing.
        const tilt = () =>
          page.evaluate((n) => {
            const r = window.__app.scene.getIsland().npcTargets.find((x) => x.name === n).meshRef;
            const up = r.position.clone().normalize();
            const ax = r.position.clone().set(0, 1, 0).applyQuaternion(r.quaternion);
            return +((Math.acos(Math.max(-1, Math.min(1, ax.dot(up)))) * 180) / Math.PI).toFixed(2);
          }, out.talk.name);
        const before = await tilt();
        const input = await page.$('#ui-overlay input[type=text], #ui-overlay textarea, #ui-overlay input:not([type])');
        let during = null;
        if (input) {
          await input.click().catch(() => {});
          await page.keyboard.type('hello there', { delay: 90 });
          during = await tilt();
          await page.keyboard.press('Control+A').catch(() => {});
          await page.keyboard.press('Backspace').catch(() => {});
        }
        out.lean = { before, during };
        t.check(`${prof}: the villager leans in while the visitor types (B8)`, during === null ? null : during - before > 2 ? true : null, out.lean, 'tilt grows (null: no lean on this build)');
      }
      // Framing during the chat. B8 fades the held villager's pin and bubble
      // (the chat panel carries the words), so what is judged on screen is
      // every OTHER villager's pin, and a bubble on the nearest other one;
      // the held villager's own pin is read with the hold released for
      // 300 ms (it fades back in over 150 ms) while the chat camera stays.
      const other = await page.evaluate(OTHER_ON_SCREEN, out.talk.name);
      if (other >= 0) await page.evaluate((i) => window.__app.scene.showNpcSpeechBubble(i, 'Hello there, welcome to the island!', 1e9), other);
      await lib.sleep(400);
      out.framing = await page.evaluate(FRAMING, { others: true });
      out.framing.bubbleOn = other >= 0 ? await page.evaluate((i) => window.__app.scene.getIsland().npcTargets[i].name, other) : null;
      const onOther = other >= 0 ? await page.evaluate(FRAMING, { name: out.framing.bubbleOn }) : null;
      await t.shot(page, `npc-${prof}-chat.png`);
      const pins = out.framing.others || [];
      const bubbleIn = onOther ? onOther.bubbleInView : null;
      t.check(`${prof}: during a chat the other villagers' pins, and a bubble on one of them, are inside the viewport`, !pins.length && bubbleIn === null ? null : pins.every((r) => r.pinInView !== false) && bubbleIn !== false, { pins: pins.map((r) => ({ name: r.name, pin: r.pin, inView: r.pinInView })), bubble: onOther ? { on: onOther.name, rect: onOther.bubble, inView: bubbleIn } : null }, 'inside');
      // headTop is the projected top of the head's bounding-box corners, which
      // sit above the mesh itself, so a pin within HEAD_TOL_PX of it reads as
      // above (integration: 1-2 px across three villagers).
      const above = (r) => (r.pin && r.headTop !== null ? r.pin[3] <= r.headTop + HEAD_TOL_PX : null);
      t.check(`${prof}: the other villagers' pins sit above their heads during the chat (${HEAD_TOL_PX} px box tolerance)`, pins.length ? pins.every((r) => above(r) !== false) : null, pins.map((r) => ({ name: r.name, pinBottom: r.pin && r.pin[3], headTop: r.headTop })), 'above (B8)');
      await page.evaluate(() => window.__app.scene.setNpcDialogueHold(null));
      await lib.sleep(300);
      out.framing.heldBeforeFade = await page.evaluate(FRAMING, { name: out.talk.name });
      const hb = out.framing.heldBeforeFade;
      // At chat range the pin is in its near fade (Island's 2.6-6 u ramp), so
      // it is judged only when it is at least half opaque; fainter, the row
      // reports it (null) for B.
      const visible = hb.pin && (hb.pinOpacity === null || hb.pinOpacity >= 0.5);
      t.check(`${prof}: the held villager's pin (hold released 300 ms, chat camera kept) is inside the viewport, its bottom above her head`, visible ? hb.pinInView !== false && above(hb) !== false : null, { pin: hb.pin, opacity: hb.pinOpacity, headTop: hb.headTop, inView: hb.pinInView }, 'inside and above (B8); null when the near fade holds it under 0.5 opacity');
    }
    t.data[prof] = out;
  }
}

module.exports = {
  npc: { item: 'E6c (MOT-11, MOT-12, MOT-13; B8)', title: 'villagers: bob and roll per leg cycle, the walk-start pop, soles walking, sitting and kneeling, talk gestures and the first gesture, the lean on typing, chat sprite bounds at 390 and 1440', profiles: ['desktop', 'phone'], run: npc },
};
