'use strict';
// Locomotion (E6c; stage 1 assumed a loco.cjs that was never ported). The
// motion audit's locomotion.cjs and analyze_loco.cjs were session temp files
// and are gone, so this is rebuilt from its report (ux-audit/results/
// motion.json: MOT-01, MOT-04, MOT-07, MOT-14, MOT-15; controls.json RUN-01)
// and checked against the numbers it recorded on 58c8849. Rows:
//   run       hold W, then the run key: isOnGround, speed and airborne frames
//             (`--run shift`, or `--run space` = the build's Space-run: it adds
//             ?legacyrun=1 only on a build that sets html[data-run-key]);
//             with Shift as the run key, Space held while walking only jumps
//   land      a standing jump: sole clearance on the grounded landing frames,
//             the squash minimum against touchdown, how far the camera rises
//   wave      the hand-height curve from the chase camera, and crops
//   footfall  the walk phase at the moment each footstep fires (the dust puff
//             that rides with sfx.footstep), A13 moves them to 0 and 0.5
//   hints     A13's ds_hint_* toasts: each once, never under a panel or the guide
//
//   npm run probe -- loco [--run shift|space] [--profile desktop] --dist dist --port <n>
const lib = require('./lib.cjs');

/** Per-rAF recorder of the player and camera (window.__loco). */
const RECORDER = () => {
  const sc = window.__app.scene;
  const pl = sc.getPlayer();
  const isl = sc.getIsland();
  const V = pl.getWorldPosition().constructor;
  const tmp = new V();
  // The 24 lowest bind-pose vertices of each skinned mesh: the soles.
  const soles = [];
  pl.traverse((m) => {
    if (!m.isSkinnedMesh || !m.geometry || !m.geometry.attributes.position) return;
    const a = m.geometry.attributes.position;
    const idx = [...Array(a.count).keys()].sort((i, j) => a.getY(i) - a.getY(j)).slice(0, 24);
    soles.push({ m, idx });
  });
  const surfR = (p) => {
    const d = p.clone().normalize();
    return isl.sampleSurfaceByDirection(d, 0).position.length();
  };
  const sole = () => {
    let best = Infinity;
    for (const { m, idx } of soles)
      for (const i of idx) {
        m.getVertexPosition(i, tmp);
        tmp.applyMatrix4(m.matrixWorld);
        best = Math.min(best, tmp.length() - surfR(tmp));
      }
    return best === Infinity ? null : best;
  };
  const L = (window.__loco = { rows: [], on: false, sole: false, hand: false });
  const tick = () => {
    if (L.on) {
      const p = pl.getWorldPosition();
      const cam = sc.getCamera().position;
      const r = { t: performance.now(), ground: pl.isOnGround(), speed: pl.getTangentialSpeed(), rp: p.length(), rc: cam.length(), sy: pl.gltfModel ? pl.gltfModel.scale.y : null, phase: pl.getWalkCyclePhase ? pl.getWalkCyclePhase() : null };
      if (L.sole) r.sole = sole();
      // The hand: SimplePlayer's own hand anchor (the rod's mount), radial height over the feet.
      const ha = L.hand && pl.getHandAnchor ? pl.getHandAnchor() : null;
      if (ha) r.hand = ha.getWorldPosition(new V()).length() - p.length();
      L.rows.push(r);
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  // Footfalls: the dust puff of 1 that main-simple spawns with every sfx.footstep.
  const F = (window.__foot = []);
  const orig = sc.spawnDust.bind(sc);
  sc.spawnDust = (pos, n) => {
    if (n === 1 && pl.getWalkCyclePhase) F.push({ t: performance.now(), phase: +pl.getWalkCyclePhase().toFixed(3) });
    return orig(pos, n);
  };
  // Hints: every toast with {hint:true}, and what was open when it fired.
  const H = (window.__hints = []);
  const ui = window.__app.ui;
  const ot = ui.toast.bind(ui);
  ui.toast = (text, opts) => {
    if (opts && opts.hint) {
      const g = document.getElementById('ds-guide');
      H.push({ t: performance.now(), text: String(text).slice(0, 100), panel: ui.panels ? ui.panels.current() : null, guideOpen: !!(g && g.getBoundingClientRect().height > 40 && getComputedStyle(g).display !== 'none'), inside: sc.isInsideInterior() });
    }
    return ot(text, opts);
  };
  return { soles: soles.reduce((s, x) => s + x.idx.length, 0), hand: !!(pl.getHandAnchor && pl.getHandAnchor()) };
};
const take = (page) => page.evaluate(() => {
  const L = window.__loco;
  L.on = false;
  const r = L.rows;
  L.rows = [];
  return r;
});
const rec = (page, o = {}) => page.evaluate((oo) => Object.assign(window.__loco, { rows: [], on: true, sole: !!oo.sole, hand: !!oo.hand }), o);

async function settle(page) {
  await page.keyboard.up('w').catch(() => {});
  await page.keyboard.up('Shift').catch(() => {});
  await page.keyboard.up(' ').catch(() => {});
  await lib.sleep(1500);
}

async function loco(t) {
  const want = String(t.args.run || 'shift');
  for (const prof of t.profiles(['desktop'])) {
    let s = await t.session(prof);
    await t.boot(s);
    let page = s.page;
    let runKey = await page.evaluate(() => document.documentElement.getAttribute('data-run-key'));
    const out = { runKeyAttr: runKey, asked: want };
    // --run space on a build that has the attribute: its legacy Space-run.
    if (want === 'space' && runKey) {
      await s.close();
      s = await t.session(prof);
      await t.boot(s, { query: 'legacyrun=1' });
      page = s.page;
      runKey = await page.evaluate(() => document.documentElement.getAttribute('data-run-key'));
      out.legacyrun = true;
      out.runKeyAttr = runKey;
    }
    await lib.dismissWelcome(page);
    await lib.sleep(1500);
    out.rig = await page.evaluate(RECORDER);
    // The key this build runs with: Shift only when asked and the build says so.
    const key = want === 'shift' ? 'Shift' : ' ';
    // ---- run
    await page.keyboard.down('w');
    await lib.sleep(1500);
    await rec(page);
    const t0 = await page.evaluate(() => performance.now());
    await page.keyboard.down(key);
    await lib.sleep(1600);
    let rows = await take(page);
    await settle(page);
    const after = rows.filter((r) => r.t >= t0);
    const plateau = Math.max(...after.map((r) => r.speed));
    const at95 = after.find((r) => r.speed >= 0.95 * 7.9);
    const at06 = after.filter((r) => r.t - t0 <= 600).pop();
    out.run = {
      key: key === ' ' ? 'Space' : 'Shift',
      airborneFrames: after.filter((r) => !r.ground).length,
      peakSpeed: +plateau.toFixed(2),
      speedAt06s: at06 ? +at06.speed.toFixed(2) : null,
      t95ms: at95 ? Math.round(at95.t - t0) : null,
    };
    t.check(`${prof}: run (${out.run.key}): no airborne frames at the start`, want === 'shift' ? (runKey === 'shift' ? out.run.airborneFrames === 0 : null) : true, out.run, want === 'shift' ? '0 airborne, about 7.9 u/s within 0.6 s (null: this build has no Shift run; 58c8849 Space: 34 airborne frames)' : 'reported (58c8849: 34 airborne frames, 95% at 0.78 s)');
    if (want === 'shift' && runKey === 'shift') t.check(`${prof}: Shift reaches about 7.9 u/s within 0.6 s`, out.run.speedAt06s !== null && out.run.speedAt06s >= 0.95 * 7.9, out.run.speedAt06s, '>= 7.5 u/s at 0.6 s');
    // Space only jumps when Shift runs.
    if (runKey === 'shift') {
      await page.keyboard.down('w');
      await lib.sleep(1500);
      await rec(page);
      const ts = await page.evaluate(() => performance.now());
      await page.keyboard.down(' ');
      await lib.sleep(1600);
      await page.keyboard.up(' ');
      rows = await take(page);
      await settle(page);
      const a = rows.filter((r) => r.t >= ts);
      let jumps = 0;
      for (let i = 1; i < a.length; i++) if (a[i - 1].ground && !a[i].ground) jumps++;
      const late = a.filter((r) => r.t - ts > 900 && r.ground);
      out.spaceHeld = { jumps, groundedSpeedLate: late.length ? +Math.max(...late.map((r) => r.speed)).toFixed(2) : null };
      t.check(`${prof}: Space held while walking only jumps (no run)`, jumps >= 1 && (out.spaceHeld.groundedSpeedLate === null || out.spaceHeld.groundedSpeedLate < 7), out.spaceHeld, '1 jump, walk speed after it');
    }
    // ---- land: a standing jump
    await rec(page, { sole: true });
    const tj = await page.evaluate(() => performance.now());
    await page.keyboard.press(' ');
    await lib.sleep(1700);
    rows = await take(page);
    const j = rows.filter((r) => r.t >= tj - 50);
    const firstAir = j.findIndex((r) => !r.ground);
    let touch = -1;
    for (let i = Math.max(1, firstAir); i < j.length; i++) if (!j[i - 1].ground && j[i].ground) {
      touch = i;
      break;
    }
    if (firstAir >= 0 && touch > 0) {
      const g0 = j[0];
      const grounded = j.slice(touch, touch + 12);
      const sy = grounded.map((r) => r.sy).filter((x) => x !== null);
      const minI = sy.length ? sy.indexOf(Math.min(...sy)) : null;
      const riseP = Math.max(...j.map((r) => r.rp - g0.rp));
      const riseC = Math.max(...j.map((r) => r.rc - g0.rc));
      out.land = {
        airborneFrames: touch - firstAir,
        soleMaxGroundedLanding: +Math.max(...grounded.map((r) => (r.sole === null ? -1 : r.sole))).toFixed(3),
        squashMin: sy.length ? +Math.min(...sy).toFixed(3) : null,
        squashMinFramesAfterTouch: minI,
        playerRise: +riseP.toFixed(2),
        cameraRise: +riseC.toFixed(2),
        cameraRatio: riseP > 0 ? +(riseC / riseP).toFixed(2) : null,
      };
    }
    t.check(`${prof}: landing soles within 0.01 u of the ground`, out.land ? out.land.soleMaxGroundedLanding <= 0.01 : null, out.land ? out.land.soleMaxGroundedLanding : 'no jump', '<= 0.01 u (58c8849: 0.088 u)');
    t.check(`${prof}: the squash minimum within 2 frames of touchdown`, out.land && out.land.squashMinFramesAfterTouch !== null ? out.land.squashMinFramesAfterTouch <= 2 : null, out.land ? out.land.squashMinFramesAfterTouch : null, '<= 2 frames (58c8849: 7 frames, 117 ms)');
    t.check(`${prof}: the camera rises 0.35 u or less during a jump`, out.land ? out.land.cameraRise <= 0.35 : null, out.land ? `${out.land.cameraRise} u for a ${out.land.playerRise} u jump` : null, '<= 0.35 u (58c8849: 1.09 u, ratio 1.00)');
    await lib.sleep(800);
    // ---- wave
    await rec(page, { hand: true });
    const tw = await page.evaluate(() => performance.now());
    await page.evaluate(() => window.__app.scene.getPlayer().triggerWave());
    const crops = [];
    for (const ms of [150, 400, 800]) {
      await lib.sleep(ms - (crops.length ? [150, 400, 800][crops.length - 1] : 0));
      const box = await page.evaluate(() => {
        const sc = window.__app.scene;
        const p = sc.getPlayer().getWorldPosition().clone();
        p.addScaledVector(p.clone().normalize(), 1.0);
        const v = p.project(sc.getCamera());
        return [((v.x + 1) / 2) * innerWidth, ((1 - v.y) / 2) * innerHeight];
      });
      const c = { x: Math.max(0, box[0] - 160), y: Math.max(0, box[1] - 180), width: 320, height: 320 };
      crops.push(await t.shot(page, `loco-${prof}-wave-${ms}ms.png`, { clip: c }));
    }
    await lib.sleep(800);
    rows = await take(page);
    const hw = rows.filter((r) => r.t >= tw && typeof r.hand === 'number').map((r) => [Math.round(r.t - tw), +r.hand.toFixed(2)]);
    out.wave = { curve: hw.filter((_, i) => i % 3 === 0).slice(0, 40), peak: hw.length ? Math.max(...hw.map((x) => x[1])) : null };
    t.check(`${prof}: the wave's hand-height curve`, hw.length ? true : null, out.wave.peak, 'reported, with crops (58c8849: -0.12 to 0.91 u on a 0.15 s linear ramp)');
    // ---- footfalls
    await page.evaluate(() => (window.__foot.length = 0));
    await page.keyboard.down('w');
    await lib.sleep(4000);
    await page.keyboard.up('w');
    const foot = await page.evaluate(() => window.__foot.slice());
    const ph = foot.map((f) => f.phase);
    const near = (x, c) => Math.min(Math.abs(x - c), Math.abs(x - c + 1), Math.abs(x - c - 1));
    out.footfall = { n: ph.length, phases: ph.slice(0, 16), at0or05: ph.filter((x) => near(x, 0) < 0.08 || near(x, 0.5) < 0.08).length, at025or075: ph.filter((x) => near(x, 0.25) < 0.08 || near(x, 0.75) < 0.08).length };
    t.check(`${prof}: footfalls at walk phases 0 and 0.5`, ph.length >= 4 ? out.footfall.at0or05 === ph.length : null, out.footfall, 'all at 0 / 0.5 (58c8849: 0.25 / 0.75)');
    // ---- hints (A13)
    await lib.sleep(1000);
    const hints = await page.evaluate(() => {
      const ls = {};
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (/^ds_hint_/.test(k)) ls[k] = localStorage.getItem(k);
      }
      return { fired: window.__hints.slice(), stored: ls };
    });
    const seen = {};
    for (const h of hints.fired) seen[h.text] = (seen[h.text] || 0) + 1;
    out.hints = { ...hints, repeats: Object.entries(seen).filter(([, n]) => n > 1).map(([k]) => k), underCover: hints.fired.filter((h) => h.panel || h.guideOpen || h.inside).map((h) => h.text) };
    t.check(`${prof}: each first-use hint shows once, never under a panel or the guide`, hints.fired.length ? out.hints.repeats.length === 0 && out.hints.underCover.length === 0 : null, { fired: hints.fired.map((h) => h.text), stored: Object.keys(hints.stored), repeats: out.hints.repeats, underCover: out.hints.underCover }, 'once each, none covered (null: no hint fired in this run)');
    t.data[prof] = out;
  }
}

module.exports = {
  loco: { item: 'E6c (MOT-01, MOT-04, MOT-07, MOT-14, MOT-15, RUN-01; A11, A13, B)', title: 'locomotion: the run start (--run shift|space), Space while walking, landing soles and squash, the camera in a jump, the wave curve, footfall phases, first-use hints', profiles: ['desktop'], run: loco },
};
