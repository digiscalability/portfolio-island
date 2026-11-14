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
  // The right hand: the armR-weighted (> 0.95) vertices lowest along the limb
  // (rig.cjs's marker), their world centroid. getHandAnchor() is the armR
  // bone, the SHOULDER pivot: it does not move when the arm swings.
  const handSet = [];
  {
    const all = [];
    (pl.gltfModel || pl).traverse((o) => {
      if (!o.isSkinnedMesh) return;
      const mat = (Array.isArray(o.material) ? o.material[0] : o.material).name;
      if (mat === 'Outline') return;
      const g = o.geometry;
      const si = g.attributes.skinIndex;
      const sw = g.attributes.skinWeight;
      const pos = g.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        let bi = 0;
        let bw = -1;
        for (let k = 0; k < 4; k++)
          if (sw.getComponent(i, k) > bw) {
            bw = sw.getComponent(i, k);
            bi = si.getComponent(i, k);
          }
        if (o.skeleton.bones[bi].name === 'armR' && bw > 0.95) all.push({ o, i, y: pos.getY(i) });
      }
    });
    all.sort((a, b) => a.y - b.y);
    handSet.push(...all.slice(0, Math.max(3, Math.floor(all.length * 0.1))));
  }
  const hv = new V();
  const handWorld = () => {
    if (!handSet.length) return null;
    const a = new V();
    for (const { o, i } of handSet) {
      o.getVertexPosition(i, hv);
      a.add(hv.applyMatrix4(o.matrixWorld));
    }
    return a.divideScalar(handSet.length);
  };
  const L = (window.__loco = { rows: [], on: false, sole: false, hand: false, handWorld });
  const tick = () => {
    if (L.on) {
      const p = pl.getWorldPosition();
      const cam = sc.getCamera().position;
      const r = { t: performance.now(), ground: pl.isOnGround(), speed: pl.getTangentialSpeed(), rp: p.length(), rc: cam.length(), sy: pl.gltfModel ? pl.gltfModel.scale.y : null, phase: pl.getWalkCyclePhase ? pl.getWalkCyclePhase() : null };
      if (L.sole) r.sole = sole();
      // The hand (armR's hand vertices), radial height over the feet.
      const hw = L.hand ? handWorld() : null;
      if (hw) r.hand = hw.length() - p.length();
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
  // The guide counts as open by its card's data-active (A13's own gate, D6):
  // the card stays in the DOM folded once First steps is skipped or done.
  const H = (window.__hints = []);
  const ui = window.__app.ui;
  const ot = ui.toast.bind(ui);
  ui.toast = (text, opts) => {
    if (opts && opts.hint) {
      const g = document.getElementById('ds-guide');
      H.push({ t: performance.now(), text: String(text).slice(0, 100), panel: ui.panels ? ui.panels.current() : null, guideOpen: !!(g && (g.dataset.active !== undefined ? g.dataset.active === '1' : g.getBoundingClientRect().height > 40 && getComputedStyle(g).display !== 'none')), inside: sc.isInsideInterior() });
    }
    return ot(text, opts);
  };
  return { soles: soles.reduce((s, x) => s + x.idx.length, 0), hand: handSet.length };
};
/** A13's hint recorder alone: every toast with {hint:true}, and what was open when it fired. */
const HINTS_INIT = () => {
  if (window.__hints) return 'already';
  const H = (window.__hints = []);
  const ui = window.__app.ui;
  const sc = window.__app.scene;
  const ot = ui.toast.bind(ui);
  ui.toast = (text, opts) => {
    if (opts && opts.hint) {
      const g = document.getElementById('ds-guide');
      H.push({ t: performance.now(), text: String(text).slice(0, 100), panel: ui.panels ? ui.panels.current() : null, guideOpen: !!(g && (g.dataset.active !== undefined ? g.dataset.active === '1' : g.getBoundingClientRect().height > 40 && getComputedStyle(g).display !== 'none')), inside: sc.isInsideInterior() });
    }
    return ot(text, opts);
  };
  return true;
};
/** Stand the player 3 u from the nearest standing tree (A13's chop hint fires within 6 u). */
const NEAR_TREE = () => {
  const sc = window.__app.scene;
  const isl = sc.getIsland();
  const P = sc.getPlayer();
  const p = P.getWorldPosition().clone();
  let best = null;
  let bd = Infinity;
  for (const tr of sc.swayTrees || []) {
    if (tr.felled || tr.pendingFell) continue;
    const d = tr.group.position.distanceTo(p);
    if (d < bd) {
      bd = d;
      best = tr;
    }
  }
  if (!best) return null;
  const c = best.group.position.clone();
  const up = c.clone().normalize();
  const V = c.constructor;
  const ref = Math.abs(up.y) < 0.9 ? new V(0, 1, 0) : new V(1, 0, 0);
  const tan = ref.addScaledVector(up, -ref.dot(up)).normalize();
  const dir = c.addScaledVector(tan, 3).normalize();
  const sfc = isl.sampleSurfaceByDirection(dir, 0);
  P.setWorldPosition(dir.multiplyScalar(sfc.position.length() + 0.75));
  return { treeFrom: +bd.toFixed(1) };
};
const HINT_STATE = () => {
  const ls = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (/^ds_hint_/.test(k)) ls[k] = localStorage.getItem(k);
  }
  return { fired: (window.__hints || []).slice(), stored: ls };
};

/**
 * A13's first-use hints on a fresh profile: First steps skipped (a hint
 * never shows while the guide teaches), W held 4.5 s without running (the
 * run hint waits for 3 s of walking), then the player 3 u from a tree (the
 * chop hint, within 6 u). The page is reloaded on the same profile and the
 * walk and the tree repeated: a hint fired on the first load must not fire
 * again. Every hint records the panel, the guide and the interior at the
 * moment it fired.
 */
async function hintsRun(t, prof) {
  const s = await t.freshSession(prof);
  const { page } = s;
  const loads = [];
  for (let load = 0; load < 2; load++) {
    if (load === 0) await t.boot(s);
    else {
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => window.__lifeIslandReady === true, null, { timeout: 240000, polling: 100 });
    }
    await lib.dismissWelcome(page).catch(() => {});
    await lib.sleep(1500);
    const skipped = await page.evaluate(() => {
      const g = window.__app.guide;
      if (g && typeof g.isActive === 'function' && g.isActive() && typeof g.skip === 'function') g.skip();
      return g && typeof g.isActive === 'function' ? !g.isActive() : null;
    });
    await page.evaluate(HINTS_INIT);
    await page.keyboard.down('w');
    await lib.sleep(4500);
    await page.keyboard.up('w');
    await lib.sleep(800);
    const tree = await page.evaluate(NEAR_TREE);
    await lib.sleep(2000);
    loads.push({ load: load + 1, guideOff: skipped, tree, ...(await page.evaluate(HINT_STATE)) });
  }
  await s.close();
  return loads;
}

const take = (page) => page.evaluate(() => {
  const L = window.__loco;
  L.on = false;
  const r = L.rows;
  L.rows = [];
  return r;
});
/**
 * The hand anchor and the head bone, projected (CSS px), with the head's
 * disc radius (0.11 u beside the bone, across the view) and both depths in
 * camera space. `box` is the crop's anchor, 1.0 u over the feet.
 */
const HAND_VS_HEAD = () => {
  // The hand is window.__loco.handWorld (armR's hand vertices; installed with the recorder).
  const sc = window.__app.scene;
  const cam = sc.getCamera();
  const pl = sc.getPlayer();
  const V = pl.getWorldPosition().constructor;
  const px = (w) => {
    const v = w.clone().project(cam);
    return [((v.x + 1) / 2) * innerWidth, ((1 - v.y) / 2) * innerHeight];
  };
  const depth = (w) => -w.clone().applyMatrix4(cam.matrixWorldInverse).z;
  const p = pl.getWorldPosition().clone();
  const box = px(p.clone().addScaledVector(p.clone().normalize(), 1.0));
  const hw = window.__loco && window.__loco.handWorld ? window.__loco.handWorld() : null;
  let head = null;
  (pl.gltfModel || pl).traverse((o) => {
    if (!head && o.isBone && /head/i.test(o.name) && !/top|end/i.test(o.name)) head = o;
  });
  const hd = head ? head.getWorldPosition(new V()) : null;
  const right = new V(1, 0, 0).applyQuaternion(cam.quaternion);
  const headR = hd ? Math.hypot(...px(hd.clone().addScaledVector(right, 0.11)).map((x, i) => x - px(hd)[i])) : null;
  return { t: performance.now(), box, hand: hw ? px(hw) : null, head: hd ? px(hd) : null, headR, handDepth: hw ? depth(hw) : null, headDepth: hd ? depth(hd) : null, headBone: head ? head.name : null };
};
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
    // B6 (wave-4 rows list): 10 crops at 100 ms steps across the 1.23 s
    // wave (150-1050 ms). Each judges the hand (armR's hand vertices)
    // projected inside the 320 px crop around the head and not hidden by the
    // head bone's projected disc (inside one radius of its centre and farther
    // from the camera than the head). B6 wants 8 of 10.
    // The geometry is sampled in-page every frame, so the judged frame is
    // the one nearest each step whatever the screenshots cost; the crops
    // are taken as close to their step as the screenshots allow.
    await page.evaluate(`window.__hvh = ${HAND_VS_HEAD.toString()}`);
    const T_WAVE = [150, 250, 350, 450, 550, 650, 750, 850, 950, 1050];
    const waveP = page.evaluate(
      () =>
        new Promise((res) => {
          const rows = [];
          const t0 = performance.now();
          window.__app.scene.getPlayer().triggerWave();
          const tick = () => {
            const g = window.__hvh();
            g.t = g.t - t0;
            rows.push(g);
            if (performance.now() - t0 < 1300) requestAnimationFrame(tick);
            else res(rows);
          };
          requestAnimationFrame(tick);
        }),
    );
    const tw = await page.evaluate(() => performance.now());
    const crops = [];
    for (const ms of T_WAVE) {
      const now = await page.evaluate(() => performance.now());
      if (tw + ms > now) await lib.sleep(tw + ms - now);
      const g = await page.evaluate(() => window.__hvh());
      const c = { x: Math.max(0, Math.round(g.box[0] - 160)), y: Math.max(0, Math.round(g.box[1] - 180)), width: 320, height: 320 };
      crops.push(await t.shot(page, `loco-${prof}-wave-${ms}ms.png`, { clip: c }));
    }
    const waveRows = await waveP;
    const handRows = T_WAVE.map((ms) => {
      const g = waveRows.reduce((b, r) => (Math.abs(r.t - ms) < Math.abs(b.t - ms) ? r : b), waveRows[0]);
      const c = { x: Math.max(0, g.box[0] - 160), y: Math.max(0, g.box[1] - 180), width: 320, height: 320 };
      const inCrop = g.hand ? g.hand[0] >= c.x && g.hand[0] <= c.x + c.width && g.hand[1] >= c.y && g.hand[1] <= c.y + c.height : false;
      const d = g.hand && g.head ? Math.hypot(g.hand[0] - g.head[0], g.hand[1] - g.head[1]) : null;
      const behind = d !== null && d < g.headR && g.handDepth > g.headDepth;
      const beside = d !== null && !behind;
      return { ms, atMs: Math.round(g.t), inCrop, distPx: d === null ? null : Math.round(d), headRPx: g.headR === null ? null : Math.round(g.headR), behind, visible: inCrop && beside };
    });
    await lib.sleep(400);
    rows = await take(page);
    const hw = rows.filter((r) => r.t >= tw && typeof r.hand === 'number').map((r) => [Math.round(r.t - tw), +r.hand.toFixed(2)]);
    out.wave = { curve: hw.filter((_, i) => i % 3 === 0).slice(0, 40), peak: hw.length ? Math.max(...hw.map((x) => x[1])) : null };
    t.check(`${prof}: the wave's hand-height curve`, hw.length ? true : null, out.wave.peak, 'reported, with crops (58c8849: -0.12 to 0.91 u on a 0.15 s linear ramp)');
    out.wave.crops = handRows;
    const seenN = handRows.filter((r) => r.visible).length;
    const measurable = handRows.filter((r) => r.headRPx !== null && r.distPx !== null).length;
    t.check(`${prof}: the waving hand is visible beside the head in 8 or more of 10 crops (B6)`, measurable >= 8 ? seenN >= 8 : null, `${seenN} of ${handRows.length} (${handRows.map((r) => `${r.ms}:${r.visible ? 'y' : r.behind ? 'behind' : 'out'}`).join(' ')}; px from the head ${handRows.map((r) => r.distPx).join('/')})`, '>= 8 of 10 (null: no hand vertices or head bone)');
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
    // ---- hints (A13): the run session's own, then a fresh profile driven to them.
    await lib.sleep(1000);
    out.hintsInRun = await page.evaluate(HINT_STATE);
    await s.close();
    const loads = await hintsRun(t, prof);
    const fired = loads.flatMap((l) => l.fired.map((h) => ({ ...h, load: l.load })));
    const seen = {};
    for (const h of fired) seen[h.text] = (seen[h.text] || 0) + 1;
    const RUN = /run|stick to the edge/i;
    out.hints = { loads, repeats: Object.entries(seen).filter(([, n]) => n > 1).map(([k]) => k), underCover: fired.filter((h) => h.panel || h.guideOpen || h.inside).map((h) => h.text) };
    const first = loads[0] ? loads[0].fired : [];
    t.check(`${prof}: on a fresh profile the run hint and one more fire (A13)`, first.length ? first.some((h) => RUN.test(h.text)) && first.length >= 2 : null, { fired: first.map((h) => h.text), stored: loads[0] ? Object.keys(loads[0].stored) : [], guideOff: loads[0] ? loads[0].guideOff : null, tree: loads[0] ? loads[0].tree : null }, 'the run hint + 1 (null: no hint fired; a build without A13)');
    t.check(`${prof}: each first-use hint shows once (across a reload), never under a panel or the guide`, fired.length ? out.hints.repeats.length === 0 && out.hints.underCover.length === 0 : null, { fired: fired.map((h) => `${h.load}: ${h.text}`), repeats: out.hints.repeats, underCover: out.hints.underCover }, 'once each, none covered (null: no hint fired in this run)');
    t.data[prof] = out;
  }
}

module.exports = {
  loco: { item: 'E6c (MOT-01, MOT-04, MOT-07, MOT-14, MOT-15, RUN-01; A11, A13, B)', title: 'locomotion: the run start (--run shift|space), Space while walking, landing soles and squash, the camera in a jump, the wave curve, footfall phases, first-use hints', profiles: ['desktop'], run: loco },
};
