'use strict';
// Camera probes (A3, A4, A5): how far a mouse drag, a swipe or a look key
// turns the view, and how the chase camera behaves when the visitor strafes.
//
// Independence rules (plan › probes):
// - Look reads html[data-look-mode]. 'drag' → trusted press-and-drag through
//   CDP; absent → main's click-to-lock, driven the way the controls audit did
//   (the input manager's lock flag plus one movementX event per frame), so the
//   per-frame pacing is exact.
// - Touch swipes are synthetic TouchEvents dispatched once per animation frame
//   from inside rAF (exact pacing) in a hasTouch phone context, and the
//   fling-off runs set __dsFx.lookFling = false before any page script.
// - Yaw is read from OrbitCamera.getYawTarget() when A4 provides it, and is
//   otherwise measured from the orbit's follow direction.
// - Strafe drives the real input pipeline on a frozen, virtual-clock sim
//   (1/60 s steps), the motion audit's method.
const lib = require('./lib.cjs');

/** Yaw reference: the orbit's follow direction (else the camera's forward). */
const YAW_REF = () => {
  const h = window.__h;
  window.__yawRef = (h.followDir() || h.camFwd()).clone();
  window.__pitchRef = typeof h.oc().pitch === 'number' ? h.oc().pitch : null;
  const o = h.oc();
  window.__yawTgtRef = typeof o.getYawTarget === 'function' ? o.getYawTarget() : null;
  return true;
};
const YAW_NOW = () => {
  const h = window.__h;
  const o = h.oc();
  const now = h.followDir() || h.camFwd();
  const yaw = h.yawBetween(window.__yawRef, now);
  const pitch = window.__pitchRef !== null && typeof o.pitch === 'number' ? ((o.pitch - window.__pitchRef) * 180) / Math.PI : null;
  const tgt = typeof o.getYawTarget === 'function' && window.__yawTgtRef !== null ? ((o.getYawTarget() - window.__yawTgtRef) * 180) / Math.PI : null;
  return { yawDeg: +yaw.toFixed(2), pitchDeg: pitch === null ? null : +pitch.toFixed(2), yawTargetDeg: tgt === null ? null : +tgt.toFixed(2), lock: !!document.pointerLockElement, plReq: window.__plReq || 0 };
};
const absYaw = (r) => Math.abs(r.yawTargetDeg !== null && r.yawTargetDeg !== undefined ? r.yawTargetDeg : r.yawDeg);

async function settleCamera(page) {
  await page.evaluate(async () => {
    const h = window.__h;
    let prev = h.followDir() || h.camFwd();
    for (let i = 0, still = 0; i < 120 && still < 6; i++) {
      await h.raf(1);
      const f = h.followDir() || h.camFwd();
      still = Math.abs(h.yawBetween(prev, f)) < 0.02 ? still + 1 : 0;
      prev = f;
    }
  });
}

async function exitLock(page) {
  await page.evaluate(() => document.pointerLockElement && document.exitPointerLock && document.exitPointerLock());
  await page.waitForTimeout(200);
}

/** Trusted press-and-drag: one mouse move per frame. */
async function mouseDrag(page, { x0 = 700, y0 = 470, dx = 300, dy = 0, n = 30, button = 'left' }) {
  await page.mouse.move(x0, y0);
  await page.mouse.down({ button });
  for (let i = 1; i <= n; i++) {
    await page.mouse.move(x0 + (dx * i) / n, y0 + (dy * i) / n);
    await lib.nextFrames(page, 1);
  }
  await page.mouse.up({ button });
}

/** Main's locked look, paced exactly: the lock flag plus one movementX per frame. */
const LOCKED_MOVES = async ({ px, n, axis }) => {
  const h = window.__h;
  const im = window.__app.inputManager;
  const was = im.isPointerLocked;
  im.isPointerLocked = true;
  const per = px / n;
  const dts = await h.frames(n, () => {
    document.dispatchEvent(new MouseEvent('mousemove', axis === 'y' ? { movementX: 0, movementY: per } : { movementX: per, movementY: 0 }));
  });
  im.isPointerLocked = was;
  return dts.length > 1 ? dts.slice(1).reduce((s, x) => s + x, 0) / (dts.length - 1) : null;
};

/** 300 px (or px) of look input over n frames by whatever mode this build uses. */
async function look(page, mode, { px = 300, n = 30, axis = 'x' }) {
  await settleCamera(page);
  await page.evaluate(YAW_REF);
  let meanFrameMs = null;
  const t0 = Date.now();
  if (mode === 'drag') await mouseDrag(page, { dx: axis === 'x' ? px : 0, dy: axis === 'y' ? px : 0, n });
  else meanFrameMs = await page.evaluate(LOCKED_MOVES, { px, n, axis });
  if (meanFrameMs === null) meanFrameMs = (Date.now() - t0) / Math.max(1, n);
  await page.waitForTimeout(300);
  const at300 = await page.evaluate(YAW_NOW);
  await page.waitForTimeout(1200);
  const at1500 = await page.evaluate(YAW_NOW);
  return { px, frames: n, axis, meanFrameMs: lib.round(meanFrameMs, 2), settled300ms: at300, settled1500ms: at1500 };
}

/**
 * One finger on the canvas, dispatched once per animation frame from inside
 * rAF (the controls audit's method): exact pacing, which a velocity-based
 * look model is sensitive to. The yaw "at finger-up" is read in the same
 * frame as the touchend.
 */
const SWIPE = async ({ x0, y0, dx, n }) => {
  const h = window.__h;
  const cv = document.getElementById('game-canvas') || document.querySelector('canvas');
  const mk = (x, y) => new Touch({ identifier: 61, target: cv, clientX: x, clientY: y, pageX: x, pageY: y, radiusX: 8, radiusY: 8, force: 1 });
  const fire = (type, changed, all) => cv.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true, composed: true, touches: all, targetTouches: all, changedTouches: changed }));
  let t = mk(x0, y0);
  fire('touchstart', [t], [t]);
  let i = 0;
  const dts = await h.frames(n, () => {
    i++;
    t = mk(x0 + (dx * i) / n, y0);
    fire('touchmove', [t], [t]);
  });
  await h.raf(1);
  fire('touchend', [t], []);
  return dts.length > 1 ? dts.slice(1).reduce((s, x) => s + x, 0) / (dts.length - 1) : null;
};

async function touchSwipe(page, { x0 = 120, y0 = 430, dx = 150, n = 15 }) {
  await page.evaluate(YAW_REF);
  const meanFrameMs = await page.evaluate(SWIPE, { x0, y0, dx, n });
  const atFingerUp = await page.evaluate(YAW_NOW);
  await page.waitForTimeout(1500);
  const settled = await page.evaluate(YAW_NOW);
  return { px: dx, frames: n, meanFrameMs: lib.round(meanFrameMs, 2), atFingerUp, settled1500ms: settled, flingAddedDeg: lib.round(absYaw(settled) - absYaw(atFingerUp), 2) };
}

const ARM_PEER_TAP = () => {
  const a = window.__app;
  window.__muteToggles = 0;
  const mp = a.multiplayer;
  if (mp) {
    mp.__probeOrig = mp.__probeOrig || { peerIdForObject: mp.peerIdForObject, setPeerMuted: mp.setPeerMuted, getPeerName: mp.getPeerName };
    mp.peerIdForObject = () => 'probe-peer';
    mp.setPeerMuted = () => {};
    mp.getPeerName = () => 'Probe';
  }
  if (a.chat) {
    a.chat.__probeToggle = a.chat.__probeToggle || a.chat.toggleMute;
    a.chat.toggleMute = () => {
      window.__muteToggles++;
      return true;
    };
  }
  return { multiplayer: !!mp, chat: !!a.chat };
};
const DISARM_PEER_TAP = () => {
  const a = window.__app;
  const mp = a.multiplayer;
  if (mp && mp.__probeOrig) Object.assign(mp, mp.__probeOrig);
  if (a.chat && a.chat.__probeToggle) a.chat.toggleMute = a.chat.__probeToggle;
  return window.__muteToggles;
};

/** Player facing in world space, calibrated against the camera after a short walk. */
const FACING_AXIS = () => {
  const h = window.__h;
  const P = h.player();
  const q = P.getWorldQuaternion(new (P.quaternion.constructor)());
  const fwd = h.flat(h.camFwd()).normalize();
  const a = h.flat(new h.V3(0, 0, 1).applyQuaternion(q)).normalize();
  window.__facingSign = a.dot(fwd) >= 0 ? 1 : -1;
  return window.__facingSign;
};
const BEHIND_DEG = () => {
  const h = window.__h;
  const P = h.player();
  const q = P.getWorldQuaternion(new (P.quaternion.constructor)());
  const face = h.flat(new h.V3(0, 0, window.__facingSign || 1).applyQuaternion(q)).normalize();
  return Math.abs(h.yawBetween(face, h.camFwd()));
};

async function keyLook(page) {
  const out = {};
  for (const key of ['j', 'l', 'i', 'k']) {
    await settleCamera(page);
    await page.evaluate(YAW_REF);
    await page.keyboard.down(key);
    await page.waitForTimeout(1000);
    await page.keyboard.up(key);
    await page.waitForTimeout(150);
    out[key] = await page.evaluate(YAW_NOW);
  }
  // R: walk a moment (the camera trails behind), calibrate the facing axis,
  // turn the camera 120° off the player's back, press R, time the recentre.
  await page.keyboard.down('w');
  await page.waitForTimeout(800);
  await page.keyboard.up('w');
  await page.waitForTimeout(700);
  await page.evaluate(FACING_AXIS);
  await page.evaluate(() => window.__h.rotateFollow(120));
  await page.waitForTimeout(150);
  const before = await page.evaluate(BEHIND_DEG);
  await page.keyboard.press('r');
  const t0 = Date.now();
  let behindAt = null;
  const trace = [];
  while (Date.now() - t0 < 2000) {
    const d = await page.evaluate(BEHIND_DEG);
    trace.push([Date.now() - t0, lib.round(d, 1)]);
    if (behindAt === null && d < 10) behindAt = Date.now() - t0;
    await lib.sleep(50);
  }
  out.r = { offBackBeforeDeg: lib.round(before, 1), behindWithinMs: behindAt, trace: trace.filter((_, i) => i % 4 === 0) };
  return out;
}

async function lookProbe(t) {
  const profiles = t.profiles(['desktop', 'phone']);
  if (profiles.includes('desktop')) {
    const s = await t.session('desktop');
    const b = await t.boot(s);
    const { page } = s;
    await lib.dismissWelcome(page);
    await page.waitForTimeout(1500);
    const mode = await page.evaluate(() => document.documentElement.getAttribute('data-look-mode'));
    const D = (t.data.desktop = { boot: b, lookMode: mode || 'absent (main click-to-lock)' });

    // A real 300 px left-drag over 30 frames, whatever the mode.
    await settleCamera(page);
    await page.evaluate(YAW_REF);
    const pl0 = await page.evaluate(() => window.__plReq || 0);
    await mouseDrag(page, { dx: 300, n: 30 });
    await page.waitForTimeout(300);
    D.drag300 = { ...(await page.evaluate(YAW_NOW)), pointerLockRequests: (await page.evaluate(() => window.__plReq || 0)) - pl0 };
    t.check('desktop: a 300 px left-drag over 30 frames turns (deg)', Math.abs(absYaw(D.drag300) - 60) <= 3, lib.round(absYaw(D.drag300), 2), '60 ±3');
    t.check('desktop: the drag leaves pointerLockElement null', !D.drag300.lock, D.drag300.lock, false);
    await exitLock(page);

    // The same 300 px at five speeds, by this build's look path.
    D.rates = [];
    for (const n of [1, 5, 30, 60, 120]) D.rates.push(await look(page, mode, { px: 300, n }));
    for (const r of D.rates) t.check(`desktop: 300 px over ${r.frames} frames, settled at 300 ms (deg)`, Math.abs(absYaw(r.settled300ms) - 60) <= 3, lib.round(absYaw(r.settled300ms), 2), '60 ±3');
    await exitLock(page);

    // A 600 px move with no button pressed.
    await settleCamera(page);
    await page.evaluate(YAW_REF);
    await page.mouse.move(400, 470);
    for (let i = 1; i <= 20; i++) {
      await page.mouse.move(400 + i * 30, 470);
      await lib.nextFrames(page, 1);
    }
    await page.waitForTimeout(300);
    D.hover600 = await page.evaluate(YAW_NOW);
    t.check('desktop: a 600 px move with no button turns (deg)', Math.abs(D.hover600.yawDeg) < 0.5, D.hover600.yawDeg, 0);
    t.check('desktop: the move leaves pointerLockElement null', !D.hover600.lock, D.hover600.lock, false);

    // A click under 6 px on a peer still toggles mute.
    D.peerTapHooks = await page.evaluate(ARM_PEER_TAP);
    await page.mouse.move(720, 520);
    await page.mouse.down();
    await page.mouse.move(722, 521);
    await page.mouse.up();
    await page.waitForTimeout(300);
    D.peerTapToggles = await page.evaluate(DISARM_PEER_TAP);
    t.check('desktop: a < 6 px click on a peer toggles mute', D.peerTapToggles === 1, D.peerTapToggles, 1);
    await exitLock(page);

    // A right-drag must not leave a context menu behind.
    await page.evaluate(() => {
      window.__ctx = [];
      window.addEventListener('contextmenu', (e) => setTimeout(() => window.__ctx.push(e.defaultPrevented), 0), true);
    });
    await settleCamera(page);
    await page.evaluate(YAW_REF);
    await mouseDrag(page, { x0: 700, y0: 500, dx: 80, n: 8, button: 'right' });
    await page.waitForTimeout(300);
    D.rightDrag = { ...(await page.evaluate(YAW_NOW)), contextmenuEvents: await page.evaluate(() => window.__ctx.slice()) };
    D.rightDrag.contextMenuShown = D.rightDrag.contextmenuEvents.some((prevented) => !prevented);
    t.check('desktop: a right-drag leaves no context menu', !D.rightDrag.contextMenuShown, D.rightDrag.contextmenuEvents, 'none, or all prevented');
    await exitLock(page);

    // J, L, I, K and R.
    D.keys = await keyLook(page);
    t.check('desktop: J held 1.0 s turns (deg)', Math.abs(Math.abs(D.keys.j.yawDeg) - 90) <= 5, D.keys.j.yawDeg, '90 ±5');
    t.check('desktop: L held 1.0 s turns (deg)', Math.abs(Math.abs(D.keys.l.yawDeg) - 90) <= 5, D.keys.l.yawDeg, '90 ±5');
    t.check('desktop: R puts the camera behind within 0.5 s', D.keys.r.behindWithinMs !== null && D.keys.r.behindWithinMs <= 500, D.keys.r.behindWithinMs, '<= 500 ms');

    // The 30-frame drag again with the CPU throttled to about 30 fps.
    const cdp = await s.ctx.newCDPSession(page);
    const fps = () => page.evaluate(() => new Promise((res) => {
      let n = 0;
      const t0 = performance.now();
      const f = () => (performance.now() - t0 < 1000 ? (n++, requestAnimationFrame(f)) : res(n));
      requestAnimationFrame(f);
    }));
    // Pick the throttle rate whose frame rate lands closest to 30 fps.
    D.unthrottledFps = await fps();
    let rate = 1;
    let got = D.unthrottledFps;
    const tried = [];
    for (const r of [1.25, 1.5, 1.75, 2, 2.5, 3, 4]) {
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: r });
      await page.waitForTimeout(500);
      const f = await fps();
      tried.push([r, f]);
      if (Math.abs(f - 30) < Math.abs(got - 30)) {
        rate = r;
        got = f;
      }
      if (f < 26) break;
    }
    await cdp.send('Emulation.setCPUThrottlingRate', { rate });
    await page.waitForTimeout(500);
    D.throttleSearch = tried;
    const throttled = await look(page, mode, { px: 300, n: 30 });
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    const base30 = D.rates.find((r) => r.frames === 30);
    const a = absYaw(base30.settled300ms);
    const b2 = absYaw(throttled.settled300ms);
    D.throttled = { cpuRate: rate, fps: got, ...throttled, changePct: a ? lib.round((100 * (b2 - a)) / a, 1) : null };
    t.check('desktop: ~30 fps changes the 300 px drag by (%)', D.throttled.changePct !== null && Math.abs(D.throttled.changePct) < 10, D.throttled.changePct, '< 10');
    await exitLock(page);
    await t.shot(page, 'look-desktop.png');
  }

  // ds_mouse_lock='1': the opt-in lock and its pill.
  if (profiles.includes('desktop')) {
    const s = await t.session('desktop', { localStorage: { ds_mouse_lock: '1' } });
    const b = await t.boot(s);
    const { page } = s;
    await lib.dismissWelcome(page);
    await page.waitForTimeout(1200);
    const PILL = () => [...document.querySelectorAll('body *')].filter((e) => window.__h.visible(e) && /mouse locked/i.test(e.textContent || '') && e.children.length === 0).map((e) => e.textContent.trim()).slice(0, 2);
    await page.mouse.click(720, 520);
    await page.waitForTimeout(500);
    const at05 = { lock: await page.evaluate(() => !!document.pointerLockElement), pill: await page.evaluate(PILL), mode: await page.evaluate(() => document.documentElement.getAttribute('data-look-mode')) };
    await page.waitForTimeout(3200);
    const at37 = { lock: await page.evaluate(() => !!document.pointerLockElement), pill: await page.evaluate(PILL) };
    t.data.mouseLockOptIn = { boot: b, at500ms: at05, at3700ms: at37 };
    t.check("desktop ds_mouse_lock='1': a click locks the pointer", at05.lock, at05.lock, true);
    t.check("desktop ds_mouse_lock='1': the lock pill shows, then hides after 3 s", at05.pill.length > 0 && at37.pill.length === 0, { at500ms: at05.pill, at3700ms: at37.pill }, 'shown, then gone');
    await exitLock(page);
  }

  // Touch: 150 px swipes at four speeds, fling off, then a fling run.
  if (profiles.includes('phone')) {
    for (const fling of [false, true]) {
      const s = await t.session('phone', { fx: { lookFling: fling } });
      const b = await t.boot(s);
      const { page } = s;
      await page.tap(`${lib.WELCOME} button[data-dismiss]`).catch(() => lib.dismissWelcome(page));
      await page.waitForTimeout(1500);
      const swipes = [];
      for (const n of [1, 5, 15, 45]) {
        await settleCamera(page);
        swipes.push(await touchSwipe(page, { dx: 150, n }));
      }
      const key = fling ? 'phoneFling' : 'phoneNoFling';
      t.data[key] = { boot: b, lookFling: fling, swipes };
      if (!fling) {
        for (const w of swipes) t.check(`phone (fling off): 150 px over ${w.frames} frames, yaw at finger-up (deg)`, Math.abs(absYaw(w.atFingerUp) - 51.6) <= 3, lib.round(absYaw(w.atFingerUp), 2), '51.6 ±3');
      } else {
        for (const w of swipes) {
          const want = w.frames === 45 ? 'adds < 1' : 'adds 5-30';
          const pass = w.frames === 45 ? w.flingAddedDeg < 1 : w.flingAddedDeg >= 5 && w.flingAddedDeg <= 30;
          t.check(`phone (fling on): ${w.frames}-frame swipe fling (deg)`, pass, w.flingAddedDeg, want);
        }
        await t.shot(page, 'look-phone.png');
      }
    }
  }
}

// --------------------------------------------------------------- strafe
// Page-side recorder for the frozen sim.
const STRAFE_LIB = () => {
  const app = window.__app;
  const sc = app.scene;
  const P = sc.getPlayer();
  const cam = sc.getCamera();
  const V3 = P.position.constructor;
  const up = () => P.position.clone().normalize();
  const flat = (v, n) => v.clone().addScaledVector(n, -v.dot(n));
  const state = { pq: cam.quaternion.clone(), pp: P.position.clone(), pv: null };
  const rec = [];
  const sample = (tag) => {
    const n = up();
    const v = flat(P.position.clone().sub(state.pp), n);
    let dHead = 0;
    if (state.pv && v.lengthSq() > 1e-10 && state.pv.lengthSq() > 1e-10) dHead = (Math.acos(Math.min(1, v.clone().normalize().dot(state.pv.clone().normalize()))) * 180) / Math.PI;
    const dCam = (2 * Math.acos(Math.min(1, Math.abs(state.pq.dot(cam.quaternion)))) * 180) / Math.PI;
    // The camera's yaw change about the player's up, apart from pitch and roll.
    const f0 = flat(new V3(0, 0, -1).applyQuaternion(state.pq), n).normalize();
    const f1 = flat(new V3(0, 0, -1).applyQuaternion(cam.quaternion), n).normalize();
    const cy = f0.clone().cross(f1);
    const dYaw = (Math.atan2(cy.dot(n), f0.dot(f1)) * 180) / Math.PI;
    const camToPlayer = cam.position.clone().sub(P.position);
    const dist = camToPlayer.length();
    const pitch = (Math.asin(Math.max(-1, Math.min(1, camToPlayer.clone().normalize().dot(n)))) * 180) / Math.PI;
    const q = P.getWorldQuaternion(new (P.quaternion.constructor)());
    const face = flat(new V3(0, 0, window.__facingSign || 1).applyQuaternion(q), n).normalize();
    const fwd = flat(cam.getWorldDirection(new V3()), n).normalize();
    const c = face.clone().cross(fwd);
    const behind = Math.abs((Math.atan2(c.dot(n), face.dot(fwd)) * 180) / Math.PI);
    rec.push({ tag, dHead, dCam, dYaw, step: v.length(), dist, pitch, behind });
    state.pq.copy(cam.quaternion);
    state.pp.copy(P.position);
    state.pv = v.lengthSq() > 1e-10 ? v : state.pv;
  };
  window.__srec = rec;
  window.__srun = (n, tag) => {
    for (let i = 0; i < n; i++) {
      window.__step(1, 1 / 60);
      sample(tag);
    }
    return rec.length;
  };
  window.__sreset = () => {
    state.pq.copy(cam.quaternion);
    state.pp.copy(P.position);
    state.pv = null;
  };
  return true;
};
const FACING_CAL = () => {
  const sc = window.__app.scene;
  const P = sc.getPlayer();
  const cam = sc.getCamera();
  const V3 = P.position.constructor;
  const n = P.position.clone().normalize();
  const flat = (v) => v.clone().addScaledVector(n, -v.dot(n)).normalize();
  const q = P.getWorldQuaternion(new (P.quaternion.constructor)());
  const a = flat(new V3(0, 0, 1).applyQuaternion(q));
  window.__facingSign = a.dot(flat(cam.getWorldDirection(new V3()))) >= 0 ? 1 : -1;
  return window.__facingSign;
};

const summarizeTag = (rec, tag) => {
  const a = rec.filter((r) => r.tag === tag);
  const secs = a.length / 60;
  const head = a.reduce((s, r) => s + r.dHead, 0);
  const camRot = a.reduce((s, r) => s + r.dCam, 0);
  const path = a.reduce((s, r) => s + r.step, 0);
  const yawAbs = a.reduce((s, r) => s + Math.abs(r.dYaw || 0), 0);
  return { secs: lib.round(secs, 2), headingDegS: lib.round(head / secs, 0), cameraDegS: lib.round(camRot / secs, 0), cameraYawAbsDegS: lib.round(yawAbs / secs, 1), pathU: lib.round(path, 2), turnRadiusU: head > 0 ? lib.round(path / ((head * Math.PI) / 180), 2) : null };
};

/** One deterministic strafe session (standard or reduced motion). */
async function strafeSession(t, base, { reduced }) {
  const s = await t.session('desktop', { clock: true, ...(reduced ? { reducedMotion: 'reduce' } : {}) });
  const b = await t.boot(s, { base });
  const { page } = s;
  await lib.dismissWelcome(page);
  await page.waitForTimeout(2500);
  await page.evaluate(STRAFE_LIB);
  await page.evaluate(lib.FREEZE);
  const run = (n, tag) => page.evaluate(([n, tag]) => window.__srun(n, tag), [n, tag]);
  await run(90, 'settle');
  // Walk, calibrate the facing axis while the camera trails behind, then strafe.
  await page.keyboard.down('KeyW');
  await run(60, 'walk');
  await page.evaluate(FACING_CAL);
  await page.keyboard.up('KeyW');
  await page.keyboard.down('KeyD');
  await run(60, 'turn90');
  await run(120, 'strafeD');
  await page.keyboard.up('KeyD');
  // After stopping: recentre rate and time-to-behind (reduced motion's case).
  await page.evaluate(() => window.__sreset());
  await run(360, 'stopped');
  // Walking away: W from a swung camera, time until the camera is behind.
  await page.keyboard.down('KeyD');
  await run(60, 'swing');
  await page.keyboard.up('KeyD');
  await page.keyboard.down('KeyW');
  await page.evaluate(() => window.__sreset());
  await run(180, 'walkaway');
  await page.keyboard.up('KeyW');
  await run(30, 'rest');
  // Fixed poses for the camera-frame comparison: an S-walk, the touch stick,
  // and a vehicle chase.
  await page.keyboard.down('KeyS');
  await run(60, 'swalk');
  await page.keyboard.up('KeyS');
  await run(30, 'rest2');
  const stick = await page.evaluate(() => {
    const ui = window.__app.ui;
    if (typeof ui.getJoystick !== 'function') return false;
    ui.__probeJoy = ui.getJoystick;
    ui.getJoystick = () => ({ forward: 1, strafe: 0.5 });
    return true;
  });
  if (stick) {
    await run(60, 'stick');
    await page.evaluate(() => {
      const ui = window.__app.ui;
      ui.getJoystick = ui.__probeJoy;
    });
  }
  await run(30, 'rest3');
  // Two vehicle chases (CO-E3), W held 2 s from boarding: 'aligned' puts the
  // camera behind the car first; 'as boarded' parks it 150 degrees from the
  // camera's forward (boarding facing away, the case A5 left at 15 deg/s
  // against main's 37).
  // Board the first car, then turn the camera until its forward sits
  // offsetDeg from the car's, the way the integration's diagnostic did:
  // setYaw where it moves the view (A4 drives followDir from yaw), else the
  // follow direction itself (58c8849 keeps a yaw that riding ignores). Each
  // way is tried, then measured; the first that lands within 3 deg is kept.
  const BOARD = ([variant]) => {
    const sc = window.__app.scene;
    if (typeof sc.boardVehicle !== 'function' || typeof sc.vehicleKind !== 'function') return null;
    let idx = -1;
    for (let i = 0; i < 12; i++)
      if (sc.vehicleKind(i) === 'car') {
        idx = i;
        break;
      }
    if (idx < 0) return null;
    sc.boardVehicle(idx);
    if (!sc.isRidingVehicle()) return null;
    const v = sc.vehicles && sc.vehicles[idx];
    const oc = sc.getOrbitCamera();
    const cam = sc.getCamera();
    if (!v || !v.forward) return { idx, set: false };
    const V3 = v.forward.constructor;
    const deg = variant === 'aligned' ? 0 : 150;
    const offset = () => {
      const up = sc.getPlayer().position.clone().normalize();
      const flat = (x) => x.clone().addScaledVector(up, -x.dot(up)).normalize();
      const f = flat(v.forward);
      const c = flat(cam.getWorldDirection(new V3()));
      const cr = f.clone().cross(c);
      return { up, f, deg: (Math.atan2(cr.dot(up), f.dot(c)) * 180) / Math.PI };
    };
    const wrap = (d) => ((((d + 180) % 360) + 360) % 360) - 180;
    const ways = [];
    if (typeof oc.setYaw === 'function' && typeof oc.getYaw === 'function') ways.push('setYaw');
    if (oc.followDir) ways.push('followDir');
    const turn = (way, d) => {
      if (way === 'setYaw') oc.setYaw(oc.getYaw() + (d * Math.PI) / 180);
      else {
        oc.followDir.applyAxisAngle(offset().up, (d * Math.PI) / 180);
        if (typeof oc.snapToPlayer === 'function') oc.snapToPlayer();
      }
      window.__step(1, 1 / 60);
    };
    let via = null;
    for (const way of ways) {
      let sign = 1;
      let last = null;
      for (let i = 0; i < 10; i++) {
        const err = wrap(deg - offset().deg);
        if (Math.abs(err) < 1) break;
        // No progress (or the wrong way): turn the other way next time.
        if (last !== null && Math.abs(err) > Math.abs(last) - 0.5) sign = -sign;
        last = err;
        turn(way, sign * err);
      }
      if (Math.abs(wrap(deg - offset().deg)) < 3) {
        via = way;
        break;
      }
    }
    // setYaw counts as a manual look, and the orbit holds its follow for
    // FOLLOW_HOLD_S after one: a visitor who boards has not just looked, so
    // the pose is handed over as boarded (the 5b007a6 carry-over fix shows).
    let released = false;
    if ('sinceManualLook' in oc) {
      oc.sinceManualLook = Number.POSITIVE_INFINITY;
      released = true;
    }
    return { idx, set: via !== null, wantDeg: deg, gotDeg: +offset().deg.toFixed(1), via, followReleased: released };
  };
  const vehicles = {};
  for (const variant of ['aligned', 'asBoarded']) {
    const v = await page.evaluate(BOARD, [variant]);
    if (v === null) continue;
    vehicles[variant] = v;
    await run(30, `boarded-${variant}`);
    await page.keyboard.down('KeyW');
    await run(120, `chase-${variant}`);
    await page.keyboard.up('KeyW');
    await page.evaluate(() => window.__app.scene.disembarkVehicle());
    await run(60, `off-${variant}`);
  }
  const rec = await page.evaluate(() => window.__srec);
  await page.evaluate(lib.THAW);
  const tag = (x) => rec.filter((r) => r.tag === x);
  const firstBehind = (x, deg) => {
    const a = tag(x);
    const i = a.findIndex((r) => r.behind < deg);
    return i < 0 ? null : lib.round((i + 1) / 60, 2);
  };
  const maxRate = (x, win = 15) => {
    const a = tag(x);
    let m = 0;
    for (let i = 0; i + win <= a.length; i++) m = Math.max(m, (a.slice(i, i + win).reduce((s, r) => s + r.dCam, 0) * 60) / win);
    return lib.round(m, 1);
  };
  const frame = (x) => {
    const a = tag(x);
    if (!a.length) return null;
    const last = a[a.length - 1];
    return { dist: lib.round(last.dist, 4), pitchDeg: lib.round(last.pitch, 3), meanDist: lib.round(lib.mean(a.map((r) => r.dist)), 4), meanPitchDeg: lib.round(lib.mean(a.map((r) => r.pitch)), 3) };
  };
  return {
    boot: b,
    reducedMotionClass: await page.evaluate(() => document.documentElement.classList.contains('reduced-motion')).catch(() => null),
    strafe: summarizeTag(rec, 'strafeD'),
    stopped: { maxRecentreDegS: maxRate('stopped'), behindWithinS: firstBehind('stopped', 10), offBackAtStopDeg: tag('stopped').length ? lib.round(tag('stopped')[0].behind, 1) : null },
    walkAway: { behindWithinS: firstBehind('walkaway', 10), offBackAtStartDeg: tag('walkaway').length ? lib.round(tag('walkaway')[0].behind, 1) : null },
    poses: {
      sWalk: frame('swalk'),
      stick: stick ? frame('stick') : null,
      vehicleChaseAligned: vehicles.aligned ? { vehicle: vehicles.aligned, ...frame('chase-aligned'), ...summarizeTag(rec, 'chase-aligned') } : null,
      vehicleChaseAsBoarded: vehicles.asBoarded ? { vehicle: vehicles.asBoarded, ...frame('chase-asBoarded'), ...summarizeTag(rec, 'chase-asBoarded') } : null,
    },
  };
}

async function strafe(t) {
  const std = await strafeSession(t, t.base, { reduced: false });
  const rm = await strafeSession(t, t.base, { reduced: true });
  t.data.standard = std;
  t.data.reducedMotion = rm;
  t.check('D held 2 s: player heading (deg/s)', std.strafe.headingDegS < 20, std.strafe.headingDegS, '< 20');
  t.check('D held 2 s: camera (deg/s)', std.strafe.cameraDegS < 20, std.strafe.cameraDegS, '< 20');
  t.check('reduced motion, D held: camera (deg/s)', rm.strafe.cameraDegS < 5, rm.strafe.cameraDegS, '< 5');
  t.check('reduced motion, after stopping: recentre (deg/s)', rm.stopped.maxRecentreDegS <= 34, rm.stopped.maxRecentreDegS, '<= 34');
  t.check('reduced motion, after stopping: behind within (s)', rm.stopped.behindWithinS !== null && rm.stopped.behindWithinS <= 6, rm.stopped.behindWithinS, '<= 6');
  t.check('walking away settles behind within (s)', std.walkAway.behindWithinS !== null && std.walkAway.behindWithinS <= 1.5, std.walkAway.behindWithinS, '<= 1.5');
  if (t.compareBase) {
    const cmp = await strafeSession(t, t.compareBase, { reduced: false });
    t.data.compare = cmp;
    const pctDiff = (a, b) => (a === null || b === null || b === 0 ? null : lib.round((100 * Math.abs(a - b)) / Math.abs(b), 2));
    // A vehicle pose counts only where BOARD turned the camera as asked.
    const oriented = (p) => !p.vehicle || p.vehicle.set !== false;
    for (const pose of ['sWalk', 'stick', 'vehicleChaseAligned']) {
      const a = std.poses[pose];
      const b = cmp.poses[pose];
      if (!a || !b) {
        t.check(`${pose}: camera distance and pitch within 5% of the compare build`, null, { subject: a, compare: b }, 'both poses present');
        continue;
      }
      if (!oriented(a) || !oriented(b)) {
        t.check(`${pose}: the camera turned as asked on both builds`, null, { subject: a.vehicle, compare: b.vehicle }, 'within 3°');
        continue;
      }
      const dd = pctDiff(a.dist, b.dist);
      const dp = pctDiff(a.pitchDeg, b.pitchDeg);
      t.check(`${pose}: camera distance within 5% of the compare build (%)`, dd !== null && dd <= 5, dd, '<= 5');
      t.check(`${pose}: camera pitch within 5% of the compare build (%)`, dp !== null && dp <= 5, dp, '<= 5');
    }
    // As boarded, facing away: the camera swings behind the car at least as
    // fast as on the compare build (plan -10%; faster is the fix, not a fault).
    const a = std.poses.vehicleChaseAsBoarded;
    const b = cmp.poses.vehicleChaseAsBoarded;
    const both = a && b && oriented(a) && oriented(b);
    const dr = both && b.cameraYawAbsDegS ? lib.round((100 * (a.cameraYawAbsDegS - b.cameraYawAbsDegS)) / b.cameraYawAbsDegS, 2) : null;
    t.check('vehicleChaseAsBoarded: camera yaw deg/s no more than 10% below the compare build (%)', both ? dr !== null && dr >= -10 : null, both ? { subject: a.cameraYawAbsDegS, compare: b.cameraYawAbsDegS, diffPct: dr } : a && b ? { notTurned: { subject: a.vehicle, compare: b.vehicle } } : 'pose missing', '>= -10');
  }
  // The absolute bar: 37.2 deg/s, the pre-A5 build's swing as boarded facing
  // away (58c8849), within 10% (main 8662b27 carries A5's slowdown, so a
  // compare against it alone cannot show the carry-over fix).
  const ab = std.poses.vehicleChaseAsBoarded;
  if (ab) t.check('vehicleChaseAsBoarded: camera yaw (deg/s) against the pre-A5 37.2', ab.vehicle && ab.vehicle.set !== false ? ab.cameraYawAbsDegS >= 37.2 * 0.9 : null, { degS: ab.cameraYawAbsDegS, vehicle: ab.vehicle }, '>= 33.5 (37.2 -10%)');
  if (std.poses.vehicleChaseAsBoarded) t.data.vehicleChaseAsBoardedCameraYawDegS = std.poses.vehicleChaseAsBoarded.cameraYawAbsDegS;
}

module.exports = {
  look: { item: 'A3, A4', title: 'mouse drag, hover, peer tap, right-drag, opt-in lock, touch swipe, look keys, 30 fps', profiles: ['desktop', 'phone'], run: lookProbe },
  strafe: { item: 'A5, CO-E3', title: "D held after a walk: heading and camera deg/s, reduced motion, settle, fixed poses, the vehicle chase 'aligned' and 'as boarded'", profiles: ['desktop'], compare: true, run: strafe },
};
