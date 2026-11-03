'use strict';
// Compass probes (A1): does the gold arrow point at its target, and does a
// visitor who follows it arrive?
//
// Independence rules (plan › probes): the camera turns through
// OrbitCamera.setYaw when that hook moves the view, otherwise by rotating the
// orbit's follow direction (main's setYaw writes a field nothing reads); the
// target is set explicitly through __app.mapGuideTarget, so A7's minute-one
// target change cannot move it.
const lib = require('./lib.cjs');

// The audit's 24 off-axis camera-space bearings (arrowcheck2.json, + = right
// of the view centre). Reusing them keeps main's baseline comparable: 24/24 on
// the opposite side, mean unwrapped |error| ~148°.
const BEARINGS = [164, 154, 144, 134, 124, 115, 106, 96, 88, 79, 70, 62, 53, 45, 37, 28, 20, 12, -12, -20, -28, -37, -44, -53];

/** Boot, leave the card, clear panels, aim the compass at the Projects zone. */
async function setup(t, prof) {
  const s = await t.session(prof);
  const b = await t.boot(s);
  const { page } = s;
  await lib.dismissWelcome(page);
  await page.waitForTimeout(4500); // the first-run compass hint passes
  const target = await page.evaluate(() => {
    const h = window.__h;
    const a = h.app;
    if (a.ui.panels && a.ui.panels.closeAll) a.ui.panels.closeAll();
    const p = h.zonePos('projects');
    if (!p) return null;
    if (!('mapGuideTarget' in a)) return { hookMissing: 'mapGuideTarget' };
    a.mapGuideTarget = p.clone();
    a.mapGuideLabel = '🚀 Projects';
    window.__probeTarget = p.clone();
    return { pos: p.toArray().map((x) => +x.toFixed(2)), distance: +h.arcTo(p).toFixed(1) };
  });
  if (!target) throw new Error('no projects zone in ZonesManager');
  if (target.hookMissing) throw new Error(`hook missing: __app.${target.hookMissing}`);
  await lib.nextFrames(page, 3);
  return { s, page, boot: b, target };
}

/**
 * Turn the view by `deg` (camera turn units). Uses setYaw when it moves the
 * camera, else rotates the follow direction. Resolves once the forward vector
 * stops changing.
 */
const TURN = async ({ deg, mode }) => {
  const h = window.__h;
  const o = h.oc();
  const settle = async () => {
    let prev = h.camFwd();
    for (let i = 0, still = 0; i < 90 && still < 3; i++) {
      await h.raf(1);
      const f = h.camFwd();
      still = Math.abs(h.yawBetween(prev, f)) < 0.05 ? still + 1 : 0;
      prev = f;
    }
  };
  if (mode === 'setYaw') o.setYaw(o.getYaw() + (deg * Math.PI) / 180);
  else h.rotateFollow(deg);
  await settle();
  return true;
};

/** Which turn mechanism this build honours: 'setYaw' or 'followDir'. */
const DETECT_TURN = async () => {
  const h = window.__h;
  const o = h.oc();
  if (typeof o.setYaw !== 'function' || typeof o.getYaw !== 'function') return 'followDir';
  const f0 = h.camFwd();
  const y0 = o.getYaw();
  o.setYaw(y0 + 0.35);
  await h.raf(12);
  const moved = Math.abs(h.yawBetween(f0, h.camFwd()));
  o.setYaw(y0);
  await h.raf(12);
  return moved > 0.5 ? 'setYaw' : 'followDir';
};

const SAMPLE = () => {
  const h = window.__h;
  const a = h.arrow();
  return { arrowRel: a ? +a.rel.toFixed(1) : null, label: a ? a.label : null, targetCamDeg: +h.bearing(window.__probeTarget).toFixed(1) };
};

async function arrow(t) {
  for (const prof of t.profiles(['desktop'])) {
    const { page, boot, target } = await setup(t, prof);
    const mode = await page.evaluate(DETECT_TURN);
    // Calibrate the sign of a turn against the target's bearing.
    const c0 = (await page.evaluate(SAMPLE)).targetCamDeg;
    await page.evaluate(TURN, { deg: 10, mode });
    const c1 = (await page.evaluate(SAMPLE)).targetCamDeg;
    const k = lib.round((c1 - c0) / 10, 3) || -1;
    const samples = [];
    for (const want of BEARINGS) {
      for (let attempt = 0; attempt < 3; attempt++) {
        const cur = (await page.evaluate(SAMPLE)).targetCamDeg;
        let d = want - cur;
        while (d > 180) d -= 360;
        while (d < -180) d += 360;
        if (Math.abs(d) < 1.5) break;
        await page.evaluate(TURN, { deg: d / k, mode });
      }
      await lib.nextFrames(page, 3);
      const smp = await page.evaluate(SAMPLE);
      samples.push({ want, ...smp });
      if (samples.length % 6 === 1) await t.shot(page, `arrow-${prof}-${String(samples.length).padStart(2, '0')}.png`);
    }
    const off = samples.filter((q) => q.arrowRel !== null && Math.abs(q.targetCamDeg) > 8 && Math.abs(q.targetCamDeg) < 172);
    const sameSide = off.filter((q) => Math.sign(q.arrowRel) === Math.sign(q.targetCamDeg)).length;
    const wrapErr = (q) => {
      let e = q.arrowRel - q.targetCamDeg;
      while (e > 180) e -= 360;
      while (e < -180) e += 360;
      return Math.abs(e);
    };
    const meanErr = lib.round(lib.mean(off.map(wrapErr)), 1);
    const meanErrUnwrapped = lib.round(lib.mean(off.map((q) => Math.abs(q.arrowRel - q.targetCamDeg))), 1);
    t.data[prof] = { boot, target, turnMode: mode, turnGain: k, offAxis: off.length, sameSide, oppositeSide: off.length - sameSide, meanAbsErrDeg: meanErr, meanAbsErrUnwrappedDeg: meanErrUnwrapped, samples };
    t.check(`${prof}: off-axis samples`, off.length === 24, off.length, 24);
    t.check(`${prof}: arrow on the target's side`, sameSide === off.length && off.length > 0, `${sameSide}/${off.length}`, `${off.length}/${off.length}`);
    t.check(`${prof}: mean |arrow - bearing| (deg)`, meanErr !== null && meanErr < 5, meanErr, '< 5');
  }
}

async function follow(t) {
  const RUN_MS = 25000;
  for (const prof of t.profiles(['desktop'])) {
    const { page, boot, target } = await setup(t, prof);
    const held = new Set();
    const set = async (keys) => {
      for (const k of [...held]) if (!keys.has(k)) await page.keyboard.up(k);
      for (const k of keys) await page.keyboard.down(k); // re-send = auto-repeat
      held.clear();
      for (const k of keys) held.add(k);
    };
    const state = () =>
      page.evaluate(() => {
        const h = window.__h;
        const a = h.arrow();
        return {
          d: +h.arcTo(window.__probeTarget).toFixed(1),
          rel: a ? a.rel : null,
          label: a ? a.label : null,
          explicit: !!h.app.mapGuideTarget,
          panel: h.app.ui.panels.current(),
          prompt: h.app.ui.interactionDiv ? (h.app.ui.interactionDiv.textContent || '').trim().slice(0, 60) : null,
        };
      });
    const samples = [];
    const t0 = Date.now();
    let next = 0;
    let reached = null;
    let lastLabel = null;
    let flips = 0;
    const prompts = new Set();
    while (Date.now() - t0 < RUN_MS) {
      const st = await state();
      if (st.prompt) prompts.add(st.prompt);
      if (st.panel && st.panel !== 'drawer') await page.evaluate(() => window.__h.app.ui.panels.closeTop());
      // Label flips count only while the explicit target is active: main-simple
      // clears it within 6 u, which changes the label once by design.
      const base = st.label ? st.label.replace(/\s*[•·]\s*\d+m$/, '').replace(/\s+\d+m$/, '') : null;
      if (st.explicit && base && lastLabel && base !== lastLabel) flips++;
      if (st.explicit && base) lastLabel = base;
      if (reached === null && st.d <= 5) reached = +((Date.now() - t0) / 1000).toFixed(1);
      if (st.rel === null) await set(new Set());
      else {
        // --mirror steers by the arrow's mirror image: a self-test of the
        // follower on a build whose arrow is known to be mirrored (main).
        const rel = t.args.mirror ? -st.rel : st.rel;
        const ab = Math.abs(rel);
        const side = rel > 0 ? 'd' : 'a';
        await set(new Set(ab < 25 ? ['w'] : ab > 120 ? [side] : ['w', side]));
      }
      const el = Date.now() - t0;
      if (el >= next) {
        samples.push({ s: Math.round(el / 1000), d: st.d, label: st.label, explicit: st.explicit });
        next += 1000;
      }
      await lib.sleep(150);
    }
    await set(new Set());
    const end = await state();
    await t.shot(page, `follow-${prof}-end.png`);
    const startD = samples.length ? samples[0].d : null;
    t.data[prof] = { boot, target, steering: t.args.mirror ? 'mirror image (self-test)' : 'arrow as drawn', startDistance: startD, distanceAt25s: end.d, minDistance: Math.min(...samples.map((x) => x.d), end.d), reachedWithin5mAtS: reached, labelFlips: flips, prompts: [...prompts], samples };
    t.check(`${prof}: within 5 m of the Projects zone in <= 25 s`, reached !== null, reached === null ? `closest ${t.data[prof].minDistance} m` : `${reached} s`, '<= 25 s');
    t.check(`${prof}: label flips while the explicit target is active`, flips === 0, flips, 0);
  }
}

module.exports = {
  arrow: { item: 'A1', title: '24 off-axis yaws: arrow side vs target side, |error|', profiles: ['desktop'], run: arrow },
  follow: { item: 'A1', title: 'keyboard follower steers by the arrow to the Projects zone', profiles: ['desktop'], run: follow },
};
