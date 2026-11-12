'use strict';
// Stage-2 probes, part 2 (E6b): camera. The motion audit's scripts (camprobe,
// camprobe2) were session temp files and are gone, so this is rebuilt from
// its report (docs/history/2026-11-03-ux-audit/motion.json: MOT-05, MOT-06,
// MOT-18) and checked against the numbers it recorded on 58c8849.
//
//   npm run probe -- camera [--part talk,tour,parked,door,force] [--force 0.8] --dist dist --port <n>
//
// - talk: the conversation camera's turn per frame on the push-in, on the
//   release and in the frames after;
// - tour: the first frame's turn, the largest turn per frame, and the frames
//   with the camera inside a building's mass;
// - parked: the player 1.2 u from a hall's wall with the camera on the wall
//   side: blocked frames and the camera's distance;
// - door: the same wall check for 60 frames after leaving a cottage by its door;
// - force (B11): the orbit distance held at 0.8 u (--force <u>): the avatar's
//   opacity over the next frames, then restored past 1.3 u; programs and draws.
const lib = require('./lib.cjs');
const G = require('./p2/guide-lib.cjs');

// In page: a per-frame recorder of the camera, and the wall check.
const CAM_INSTALL = () => {
  const sc = window.__app.scene;
  const oc = sc.getOrbitCamera();
  const cam = sc.getCamera();
  const P = sc.getPlayer();
  if (window.__camRec) return true;
  // What can stand between the player and the camera: the camera's own
  // collision list, the district halls and the cottages.
  const list = new Set(oc.collisionMeshes || []);
  const add = (root) => root && root.traverse((o) => {
    if (o.isMesh && !(o.userData && o.userData.isCelHull) && o.name !== 'zone-beacon' && !(o.material && o.material.transparent)) list.add(o);
  });
  for (const z of sc.getZonesManager().getZones()) add(z.marker);
  for (const d of sc.getIsland().houseDoors || []) add(sc.getObjectByName(d.id));
  const rc = new oc.raycaster.constructor();
  const C = (window.__camRec = { meshes: [...list] });
  // The halls' and cottages' solid masses as world boxes, for 'is the camera
  // inside a building' (a tour's camera is on a rail, far from the player, so
  // the chest-to-camera line means nothing there).
  const Box3 = (() => {
    const g = C.meshes.find((m) => m.geometry);
    g.geometry.computeBoundingBox();
    return g.geometry.boundingBox.constructor;
  })();
  C.boxes = [];
  const boxOf = (root, label) => root && root.traverse((o) => {
    if (!o.isMesh || (o.userData && o.userData.isCelHull) || o.name === 'zone-beacon' || (o.material && o.material.transparent)) return;
    const b = new Box3().setFromObject(o);
    const sz = [b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z];
    // Walls and roofs: at least 1.2 u across in every direction.
    if (Math.min(...sz) >= 1.2) C.boxes.push({ b, label });
  });
  for (const z of sc.getZonesManager().getZones()) boxOf(z.marker, z.id);
  for (const d of sc.getIsland().houseDoors || []) boxOf(sc.getObjectByName(d.id), d.id);
  /** The building whose mass holds the camera, or null. */
  C.inside = () => {
    const p = cam.position;
    for (const { b, label } of C.boxes) if (p.x > b.min.x && p.x < b.max.x && p.y > b.min.y && p.y < b.max.y && p.z > b.min.z && p.z < b.max.z) return label;
    return null;
  };
  /** Distance to the first wall on the line from the player's chest to the camera, or null when clear. */
  C.blocked = () => {
    const feet = P.getWorldPosition();
    const chest = feet.clone().addScaledVector(feet.clone().normalize(), 0.9);
    const dir = cam.position.clone().sub(chest);
    const d = dir.length();
    if (d < 0.3) return null;
    rc.set(chest, dir.normalize());
    rc.near = 0;
    rc.far = d - 0.05;
    const h = rc.intersectObjects(C.meshes, false);
    return h.length ? +h[0].distance.toFixed(2) : null;
  };
  /** Record for ms: the turn per frame (degrees), the frame time, the camera's distance, the wall check. */
  C.record = (ms, wall, markKeys) =>
    new Promise((res) => {
      const rows = [];
      let prev = null;
      let last = performance.now();
      const t0 = last;
      // With markKeys: when the first of those keys went down, on this clock.
      let mark = null;
      const onKey = (e) => {
        if (mark === null && markKeys.includes(e.key)) mark = Math.round(performance.now() - t0);
      };
      if (markKeys) window.addEventListener('keydown', onKey, true);
      const tick = () => {
        const now = performance.now();
        const q = cam.quaternion;
        const dot = prev ? Math.min(1, Math.abs(q.x * prev[0] + q.y * prev[1] + q.z * prev[2] + q.w * prev[3])) : 1;
        const row = { t: +(now - t0).toFixed(0), dt: +(now - last).toFixed(1), deg: +((2 * Math.acos(dot) * 180) / Math.PI).toFixed(2), dist: +cam.position.distanceTo(P.getWorldPosition()).toFixed(2) };
        if (wall === 'inside') row.wall = C.inside();
        else if (wall) row.wall = C.blocked();
        rows.push(row);
        prev = [q.x, q.y, q.z, q.w];
        last = now;
        if (now - t0 < ms) requestAnimationFrame(tick);
        else {
          if (markKeys) window.removeEventListener('keydown', onKey, true);
          res(markKeys ? { rows: rows.slice(1), mark } : rows.slice(1));
        }
      };
      requestAnimationFrame(tick);
    });
  return true;
};

const sum = (rows) => {
  const worst = rows.slice().sort((a, b) => b.deg - a.deg)[0] || null;
  return { frames: rows.length, firstFrameDeg: rows.length ? rows[0].deg : null, maxDegPerFrame: worst ? worst.deg : null, maxAtMs: worst ? worst.t : null, over2deg: rows.filter((r) => r.deg > 2).length, meanFrameMs: rows.length ? lib.round(lib.mean(rows.map((r) => r.dt)), 1) : null };
};

async function open(t, prof, { card = false } = {}) {
  const s = await t.session(prof);
  const { page } = s;
  await t.boot(s, { query: 'hour=12' });
  if (!card) {
    await lib.dismissWelcome(page);
    await lib.sleep(1500);
    // First steps is not part of this: Skip.
    await page.evaluate(() => {
      const g = document.getElementById('ds-guide');
      const b = g && [...g.querySelectorAll('button,[role=button]')].find((x) => /skip/i.test(`${x.getAttribute('aria-label') || ''} ${x.textContent || ''}`));
      if (b) b.click();
    });
    await lib.sleep(2500);
  }
  await page.evaluate(CAM_INSTALL);
  return s;
}

/** The conversation camera: walk up to the trail's villager, E, then close the chat. */
async function talk(t, prof) {
  const s = await open(t, prof);
  const { page } = s;
  const who = await page.evaluate(() => {
    const sc = window.__app.scene;
    const p = sc.getPlayer().getWorldPosition();
    const named = typeof sc.getTrailVillager === 'function' ? sc.getTrailVillager() : null;
    let best = null;
    for (const n of sc.getIsland().npcTargets) {
      if (!n.meshRef.visible) continue;
      const d = n.meshRef.getWorldPosition(p.clone()).distanceTo(p);
      if (named && n.name === named) return n.name;
      if (!best || d < best.d) best = { name: n.name, d };
    }
    return best ? best.name : null;
  });
  const out = { villager: who, tries: 0 };
  // The frames a turn starts on: everything from the key press on, from the
  // first frame the camera moves at all (the chase camera rests before it).
  const from = (rec) => {
    const rows = rec.mark === null ? rec.rows : rec.rows.filter((r) => r.t >= rec.mark);
    const at = rows.findIndex((r) => r.deg > 0.3);
    return at >= 0 ? rows.slice(at) : [];
  };
  let push = null;
  for (; out.tries < 3; out.tries++) {
    out.walk = who ? await G.walkToNpc(page, who, 20000) : 'no villager';
    if (out.walk !== 'prompt') break;
    const pushP = page.evaluate(() => window.__camRec.record(1800, false, ['e', 'E']));
    await lib.sleep(150);
    await page.keyboard.press('e');
    push = await pushP;
    await lib.sleep(1200);
    out.opened = await page.evaluate(() => ({ chat: !!window.__app.ui.npcChatDiv, dialogue: window.__app.ui.isDialogueActive(), panel: window.__app.ui.panels.current() }));
    if (out.opened.chat || out.opened.dialogue) break;
  }
  if (!push || !out.opened || !(out.opened.chat || out.opened.dialogue)) {
    await s.close();
    return { ...out, error: `the conversation did not open (${out.walk}, ${out.tries} tries)` };
  }
  out.pushIn = sum(from(push));
  await t.shot(page, `camera-${prof}-talk.png`);
  const relP = page.evaluate(() => window.__camRec.record(2200, false, ['Escape']));
  await lib.sleep(150);
  await page.keyboard.press('Escape');
  await page.evaluate(() => {
    const ui = window.__app.ui;
    if (ui.closeNpcChat) ui.closeNpcChat();
  });
  const moving = from(await relP);
  // 'Release' is the glide back (0.35 s on main); 'after' is the chase camera taking over.
  out.release = sum(moving.filter((r) => r.t - moving[0].t <= 400));
  out.after = sum(moving.filter((r) => r.t - moving[0].t > 400));
  await s.close();
  return out;
}

/** The full tour from the welcome card: the first frame's turn, the largest, and frames behind a wall. */
async function tour(t, prof) {
  const s = await open(t, prof, { card: true });
  const { page } = s;
  const xy = await page.evaluate((sel) => {
    const b = document.querySelector(`${sel} button[data-tour]`);
    if (!b) return null;
    b.scrollIntoView({ block: 'center' });
    const r = b.getBoundingClientRect();
    return [r.left + r.width / 2, r.top + r.height / 2];
  }, lib.WELCOME);
  if (!xy) {
    await s.close();
    return { error: 'no tour button on the welcome card (button[data-tour])' };
  }
  const recP = page.evaluate(() => window.__camRec.record(14000, 'inside'));
  await lib.sleep(150);
  await page.mouse.click(xy[0], xy[1]);
  const rows = await recP;
  await t.shot(page, `camera-${prof}-tour.png`);
  const at = rows.findIndex((r) => r.deg > 0.05);
  const moving = at >= 0 ? rows.slice(at) : rows;
  const walls = moving.filter((r) => r.wall !== null && r.wall !== undefined);
  const out = { ...sum(moving), framesInsideABuilding: walls.length, firstInsideAtMs: walls.length ? walls[0].t : null, insideOf: [...new Set(walls.map((r) => r.wall))], maxDegPerSecond: lib.round(Math.max(0, ...moving.map((r) => (r.dt > 0 ? (r.deg * 1000) / r.dt : 0))), 0) };
  await page.evaluate(() => {
    const a = window.__app;
    if (typeof a.endTour === 'function') a.endTour();
  });
  await s.close();
  return out;
}

/** The player 1.2 u from a hall's wall, the camera on the wall side. */
async function parked(t, prof) {
  const s = await open(t, prof);
  const { page } = s;
  const where = await page.evaluate(() => {
    const sc = window.__app.scene;
    const z = sc.getZonesManager().getZoneById('professional');
    const P = sc.getPlayer();
    const V = P.getWorldPosition().constructor;
    z.marker.updateWorldMatrix(true, false);
    const c = new V().setFromMatrixPosition(z.marker.matrixWorld);
    const n = c.clone().normalize();
    // The side wall: at right angles to the door's forward.
    const fwd = new V(0, 0, 1).applyQuaternion(z.marker.getWorldQuaternion(sc.getCamera().quaternion.clone()));
    const side = fwd.clone().cross(n).normalize();
    // Find the wall by a ray from 8 u out, then stand 1.2 u off it.
    const rc = new (sc.getOrbitCamera().raycaster.constructor)();
    const from = c.clone().addScaledVector(side, 8).addScaledVector(n, 0.9);
    rc.set(from, side.clone().negate());
    rc.far = 8;
    const meshes = [];
    z.marker.traverse((o) => {
      if (o.isMesh && !(o.userData && o.userData.isCelHull)) meshes.push(o);
    });
    const hit = rc.intersectObjects(meshes, false)[0];
    if (!hit) return null;
    const d = hit.point.clone().addScaledVector(side, 1.2).normalize();
    const surf = sc.getIsland().sampleSurfaceByDirection(d, 0);
    P.setWorldPosition(d.multiplyScalar(surf.position.length() + 0.75));
    // The camera on the wall side: it trails along -side, into the building.
    const oc = sc.getOrbitCamera();
    if (oc.followDir) oc.followDir.copy(side).negate();
    if (typeof oc.snapToPlayer === 'function') oc.snapToPlayer();
    return { wallFromCentreU: +hit.point.distanceTo(c).toFixed(2) };
  });
  if (!where) {
    await s.close();
    return { error: 'no wall found beside the Professional hall' };
  }
  await lib.sleep(1200);
  const rows = await page.evaluate(() => window.__camRec.record(1000, true));
  await t.shot(page, `camera-${prof}-parked.png`);
  const blocked = rows.filter((r) => r.wall !== null && r.wall !== undefined);
  // Then walk away from the wall for 0.8 s.
  const p = page.evaluate(() => window.__camRec.record(800, true));
  await page.keyboard.down('KeyS');
  const walk = await p;
  await page.keyboard.up('KeyS');
  await s.close();
  return { ...where, frames: rows.length, blockedFrames: blocked.length, wallAtU: blocked.length ? blocked[0].wall : null, cameraDistanceU: rows.length ? rows[rows.length - 1].dist : null, minCameraDistanceU: rows.length ? Math.min(...rows.map((r) => r.dist)) : null, walkingAwayBlocked: `${walk.filter((r) => r.wall !== null && r.wall !== undefined).length} of ${walk.length}` };
}

/** Leaving a cottage by its door: is there a wall between the player and the camera once outside? */
async function door(t, prof) {
  const s = await open(t, prof);
  const { page } = s;
  const ok = await page.evaluate(() => {
    const a = window.__app;
    const d = a.scene.getIsland().houseDoors[0];
    if (!d || typeof a.enterBuilding !== 'function') return null;
    // Stand on the doorstep, facing the door, as a visitor does.
    const sc = a.scene;
    const house = sc.getObjectByName(d.id);
    const V = sc.getPlayer().getWorldPosition().constructor;
    house.updateWorldMatrix(true, false);
    const fwd = new V(0, 0, 1).applyQuaternion(house.getWorldQuaternion(sc.getCamera().quaternion.clone()));
    const up = d.position.clone().normalize();
    fwd.addScaledVector(up, -fwd.dot(up)).normalize();
    const dir = d.position.clone().normalize();
    const surf = sc.getIsland().sampleSurfaceByDirection(dir, 0);
    sc.getPlayer().setWorldPosition(dir.multiplyScalar(surf.position.length() + 0.75));
    const oc = sc.getOrbitCamera();
    if (oc.followDir) oc.followDir.copy(fwd);
    if (typeof oc.snapToPlayer === 'function') oc.snapToPlayer();
    return d.id;
  });
  if (!ok) {
    await s.close();
    return { error: 'no cottage door' };
  }
  await lib.sleep(700);
  await page.evaluate((id) => window.__app.enterBuilding(id, false), ok);
  await lib.sleep(2600);
  const inside = await page.evaluate(() => window.__app.scene.isInsideInterior());
  await page.evaluate(() => window.__app.exitBuilding(false));
  // Wait for the first frame outdoors, then 60 frames.
  for (let i = 0; i < 60 && (await page.evaluate(() => window.__app.scene.isInsideInterior())); i++) await lib.sleep(50);
  const rows = await page.evaluate(() => window.__camRec.record(1000, true));
  await t.shot(page, `camera-${prof}-door.png`);
  await s.close();
  const blocked = rows.filter((r) => r.wall !== null && r.wall !== undefined);
  return { house: ok, wentInside: inside, frames: rows.length, blockedFrames: blocked.length, wallAtU: blocked.length ? blocked[0].wall : null, cameraDistanceU: rows.length ? rows[rows.length - 1].dist : null };
}

/** B11: the camera forced close. setDistance clamps at minDistance (2 u), so that is written first. */
async function force(t, prof, u) {
  const s = await open(t, prof);
  const { page } = s;
  const AVATAR = () => {
    const sc = window.__app.scene;
    let min = 1;
    let n = 0;
    sc.getPlayer().traverse((m) => {
      if (!m.isMesh || !m.visible || (m.userData && m.userData.isCelHull)) return;
      for (const mat of Array.isArray(m.material) ? m.material : [m.material]) {
        if (!mat) continue;
        n++;
        min = Math.min(min, mat.transparent ? mat.opacity : 1);
      }
    });
    // One whole frame, the loop stopped around it, for the draw count.
    const sr = window.__app.renderer;
    const R = sr.getRenderer();
    const auto = R.info.autoReset;
    sr.stopRenderLoop();
    R.info.autoReset = false;
    R.info.reset();
    sr.render();
    const draws = R.info.render.calls;
    R.info.autoReset = auto;
    sr.isRunning = false;
    sr.startRenderLoop(sr.scene, sr.camera, sr.renderCallback);
    return { opacity: +min.toFixed(3), materials: n, programs: R.info.programs.length, draws, dist: +sc.getCamera().position.distanceTo(sc.getPlayer().getWorldPosition()).toFixed(2) };
  };
  // Past the boot's late compiles (the interior warm, the bloom's arrival),
  // so a program count that moves is the fade's.
  await lib.sleep(12000);
  const before = await page.evaluate(AVATAR);
  const rows = await page.evaluate(
    ([dist]) =>
      new Promise((res) => {
        const sc = window.__app.scene;
        const oc = sc.getOrbitCamera();
        window.__camForce = { minDistance: oc.minDistance, distance: oc.distance, distanceTarget: oc.distanceTarget };
        oc.minDistance = dist;
        oc.distance = dist;
        oc.distanceTarget = dist;
        const out = [];
        const t0 = performance.now();
        const read = () => {
          let min = 1;
          sc.getPlayer().traverse((m) => {
            if (!m.isMesh || !m.visible || (m.userData && m.userData.isCelHull)) return;
            for (const mat of Array.isArray(m.material) ? m.material : [m.material]) if (mat) min = Math.min(min, mat.transparent ? mat.opacity : 1);
          });
          return min;
        };
        const tick = () => {
          const now = performance.now();
          // Hold the distance: the orbit eases back toward its target otherwise.
          oc.distance = dist;
          oc.distanceTarget = dist;
          // fd: the distance B11's fade reads, camera to the torso (0.35 u up from the player's origin).
          const pl = sc.getPlayer();
          const wp = pl.getWorldPosition();
          const anchor = pl.position && pl.quaternion ? wp.clone().set(0, 0.35, 0).applyQuaternion(pl.quaternion).add(pl.position) : wp.clone().addScaledVector(wp.clone().normalize(), 0.35);
          const cam = sc.getCamera().position;
          out.push({ t: Math.round(now - t0), o: +read().toFixed(3), d: +cam.distanceTo(wp).toFixed(2), fd: +cam.distanceTo(anchor).toFixed(2) });
          if (now - t0 < 800) requestAnimationFrame(tick);
          else res(out);
        };
        requestAnimationFrame(tick);
      }),
    [u],
  );
  const close = await page.evaluate(AVATAR);
  await t.shot(page, `camera-${prof}-force.png`);
  await page.evaluate(() => {
    const oc = window.__app.scene.getOrbitCamera();
    const w = window.__camForce;
    oc.minDistance = w.minDistance;
    oc.distance = Math.max(2, w.distance);
    oc.distanceTarget = Math.max(2, w.distanceTarget);
  });
  await lib.sleep(900);
  const restored = await page.evaluate(AVATAR);
  await s.close();
  // B11's 150 ms runs from the frame the camera crosses the fade's 1.1 u (to
  // the torso), not from the force: the orbit glides in over a few hundred ms.
  const cross = rows.find((r) => r.fd < 1.1);
  const t1 = cross ? cross.t : null;
  const hit = rows.find((r) => Math.abs(r.o - 0.35) <= 0.05);
  return {
    forcedU: u,
    before,
    close,
    restored,
    cameraDistanceReachedU: rows.length ? rows[rows.length - 1].d : null,
    fadeDistanceReachedU: rows.length ? rows[rows.length - 1].fd : null,
    crossed11AtMs: t1,
    opacityAt150ms: t1 === null ? null : ((rows.filter((r) => r.t <= t1 + 150).pop() || {}).o ?? null),
    opacityAt150msFromForce: (rows.filter((r) => r.t <= 150).pop() || {}).o ?? null,
    reached035AtMs: hit ? hit.t : null,
    reached035AfterCrossMs: hit && t1 !== null ? hit.t - t1 : null,
    minOpacity: rows.length ? Math.min(...rows.map((r) => r.o)) : null,
  };
}

async function camera(t) {
  const parts = t.args.part && t.args.part !== true ? String(t.args.part).split(',') : ['talk', 'tour', 'parked', 'door', 'force'];
  const u = Number(t.args.force && t.args.force !== true ? t.args.force : 0.8);
  for (const prof of t.profiles(['desktop'])) {
    const out = {};
    const run = async (name, fn) => {
      try {
        out[name] = await fn();
      } catch (e) {
        out[name] = { error: String((e && e.message) || e).slice(0, 240) };
      }
      t.log(`${prof} ${name}: ${JSON.stringify(out[name])}`);
    };
    if (parts.includes('talk')) {
      await run('talk', () => talk(t, prof));
      const k = out.talk;
      // MOT-05: no one-frame snap on the push-in, the release or after.
      t.check(`${prof}: the conversation push-in's first frame (degrees)`, k.error ? null : k.pushIn.frames ? k.pushIn.firstFrameDeg < 2 : true, k.error || (k.pushIn.frames ? k.pushIn.firstFrameDeg : 'the camera did not turn'), '< 2');
      t.check(`${prof}: the largest turn per frame on the release and after (degrees)`, k.error ? null : Math.max(k.release.maxDegPerFrame || 0, k.after.maxDegPerFrame || 0) < 2, k.error || { release: k.release.maxDegPerFrame, after: k.after.maxDegPerFrame }, '< 2');
    }
    if (parts.includes('tour')) {
      await run('tour', () => tour(t, prof));
      const k = out.tour;
      // MOT-18.
      t.check(`${prof}: the tour's first frame (degrees)`, k.error ? null : k.firstFrameDeg < 1, k.error || k.firstFrameDeg, '< 1');
      t.check(`${prof}: the tour's largest turn per frame (degrees)`, k.error ? null : k.maxDegPerFrame < 2, k.error || `${k.maxDegPerFrame} (${k.maxDegPerSecond} deg/s)`, '< 2');
      t.check(`${prof}: tour frames with the camera inside a building`, k.error ? null : k.framesInsideABuilding === 0, k.error || (k.framesInsideABuilding ? `${k.framesInsideABuilding} (first at ${k.firstInsideAtMs} ms, in ${k.insideOf.join(', ')})` : 0), 0);
    }
    if (parts.includes('parked')) {
      await run('parked', () => parked(t, prof));
      const k = out.parked;
      // MOT-06.
      t.check(`${prof}: 1.2 u from a wall, frames with the wall between the player and the camera`, k.error ? null : k.blockedFrames === 0, k.error || `${k.blockedFrames} of ${k.frames} (camera ${k.cameraDistanceU} u away, the wall at ${k.wallAtU} u)`, 0);
      t.check(`${prof}: 1.2 u from a wall, the camera's distance (u)`, k.error ? null : k.minCameraDistanceU >= 0.55, k.error || k.minCameraDistanceU, '>= 0.55');
    }
    if (parts.includes('door')) {
      await run('door', () => door(t, prof));
      const k = out.door;
      t.check(`${prof}: leaving by a door, frames with a wall between the player and the camera`, k.error ? null : k.wentInside ? k.blockedFrames === 0 : null, k.error || `${k.blockedFrames} of ${k.frames}`, 0);
    }
    if (parts.includes('force')) {
      await run('force', () => force(t, prof, u));
      const k = out.force;
      // B11.
      t.check(`${prof}: forced to ${u} u, the avatar fades to 0.35 within 150 ms of the camera crossing 1.1 u`, k.error ? null : k.opacityAt150ms !== null && Math.abs(k.opacityAt150ms - 0.35) <= 0.05, k.error || { at150ms: k.opacityAt150ms, crossedAtMs: k.crossed11AtMs, reached035AfterCrossMs: k.reached035AfterCrossMs, min: k.minOpacity, fadeDistanceU: k.fadeDistanceReachedU, cameraAtU: k.cameraDistanceReachedU }, '0.35 +-0.05');
      t.check(`${prof}: the avatar is opaque again past 1.3 u`, k.error ? null : k.restored.opacity >= 0.99, k.error || { opacity: k.restored.opacity, cameraAtU: k.restored.dist }, '1');
      t.check(`${prof}: programs with the camera forced close`, k.error ? null : k.close.programs === k.before.programs && k.restored.programs === k.before.programs, k.error || { before: k.before.programs, close: k.close.programs, restored: k.restored.programs }, 'unchanged');
    }
    t.data[prof] = out;
  }
}

module.exports = {
  camera: { item: 'E6b (MOT-05, MOT-06, MOT-18; B11)', title: "the conversation camera's turn per frame, the tour's, the camera behind a wall (parked, leaving by a door), and the avatar with the camera forced to 0.8 u", profiles: ['desktop'], run: camera },
};
