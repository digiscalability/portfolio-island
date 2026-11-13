'use strict';
// Phase-2 room probes, part 3 (P2-E1c), on p2/room-lib.cjs: sweep, clip and
// rtkeys. The interiors audit's sweep.cjs, clip.cjs and rtkeys.cjs were
// session temp files and are gone, so these are rebuilt from its report
// (docs/history/2026-11-03-ux-audit/phase2/building.json: INT-01, INT-04) and
// checked against the numbers it recorded on 58c8849.
//
// sweep drives the player (a room-local pose on a 0.3 u grid with 16
// headings) and then runs the build's OWN interior camera code
// (updateInteriorMode, one simulated second at 10 Hz) before it reads the
// live camera, so it measures whatever follow, pull-in or entry shot the
// build has (B's P2-B11). It never writes the camera. "Inside a prop" is
// judged against each prop mesh's own world bounding box (geometry bounds x
// matrixWorld), not B's colliders or camBlockers, so B can change those
// freely. The window repaint is held off for the sweep and released after.
// The near-plane share counts every pose within 0.1 u of a prop box, the
// strictly-inside ones included, as the audit counted it (cottage 2.5% =
// 0.9% inside + 1.6% near on 58c8849).
//
//   npm run probe -- p2/sweep  [--ids personal,house_0,...] [--device desk|phone] --dist dist --port <n>
//   npm run probe -- p2/clip   [--device desk|phone] --dist dist --port <n>
//   npm run probe -- p2/rtkeys [--device desk|phone] --dist dist --port <n>
const lib = require('../lib.cjs');
const R = require('./room-lib.cjs');

// One building per interior theme (the cottages share one).
const THEMES = ['welcome', 'professional', 'projects', 'personal', 'contact', 'house_0', 'islet_beach_house'];
// 58c8849 (building.json): strictly inside a prop, % of poses.
const BASE_INSIDE = { personal: 4.6, house_0: 0.9, islet_beach_house: 0.4 };

const LIVE_SWEEP = ({ step, headings, near, settle }) => {
  const sc = window.__app.scene;
  const o = sc.constructor.INTERIOR_ORIGIN;
  const set = sc.interiorSets[sc.interiorActiveTheme];
  if (!set) return { error: 'no interior set' };
  const V = sc.player.position.constructor;
  let Box3 = null;
  const props = [];
  set.updateMatrixWorld(true);
  set.traverse((m) => {
    if (!m.isMesh || !m.visible || !m.geometry) return;
    if (m.material && m.material.transparent) return; // blobs, posters, glass
    if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
    if (!Box3) Box3 = m.geometry.boundingBox.constructor;
    const b = m.geometry.boundingBox.clone().applyMatrix4(m.matrixWorld);
    const sz = [b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z];
    props.push({ b, name: m.name || (m.parent && m.parent.name) || '', key: sz.map((v) => v.toFixed(2)).join('x') });
  });
  const save = { wait: sc.interiorViewWait, pos: sc.player.position.clone(), yaw: sc.interiorYaw, camYaw: sc.interiorCamYaw };
  sc.interiorViewWait = 1e9;
  const tick = () => {
    for (let i = 0; i < settle; i++) sc.updateInteriorMode(0.1);
  };
  let poses = 0;
  let inside = 0;
  let nearHits = 0;
  const insideBy = {};
  const examples = [];
  const cam = sc.camera.position;
  for (let x = -3.3; x <= 3.31; x += step)
    for (let z = -3.3; z <= 3.31; z += step) {
      if (sc.interiorWallBlocked(x, z) || sc.interiorFurnitureBlocked(x, z)) continue;
      for (let k = 0; k < headings; k++) {
        const yaw = (k / headings) * Math.PI * 2;
        sc.player.position.set(o.x + x, o.y + 0.8, o.z + z);
        sc.interiorYaw = yaw;
        sc.interiorCamYaw = yaw;
        sc.interiorVelF = 0;
        sc.interiorVelS = 0;
        sc.setInteriorMove(0, 0);
        tick();
        poses++;
        const hit = props.find((s) => cam.x > s.b.min.x && cam.x < s.b.max.x && cam.y > s.b.min.y && cam.y < s.b.max.y && cam.z > s.b.min.z && cam.z < s.b.max.z);
        if (hit) {
          inside++;
          const key = hit.name ? `${hit.name} ${hit.key}` : hit.key;
          insideBy[key] = (insideBy[key] || 0) + 1;
          if (examples.length < 12) examples.push({ x: +x.toFixed(1), z: +z.toFixed(1), yawDeg: +((yaw * 180) / Math.PI).toFixed(1), cam: [cam.x - o.x, cam.y - o.y, cam.z - o.z].map((v) => +v.toFixed(2)), prop: key });
          continue;
        }
        const nh = props.find((s) => cam.x > s.b.min.x - near && cam.x < s.b.max.x + near && cam.y > s.b.min.y - near && cam.y < s.b.max.y + near && cam.z > s.b.min.z - near && cam.z < s.b.max.z + near);
        if (nh) nearHits++;
      }
    }
  sc.player.position.copy(save.pos);
  sc.interiorYaw = save.yaw;
  sc.interiorCamYaw = save.camYaw;
  sc.interiorViewWait = save.wait;
  tick();
  return { theme: sc.interiorActiveTheme, props: props.length, poses, cameraInsidePropPct: +((100 * inside) / Math.max(1, poses)).toFixed(1), nearPlanePct: +((100 * (inside + nearHits)) / Math.max(1, poses)).toFixed(1), insideBy, examples };
};

async function inRoom(page, id, touch, T) {
  await R.outdoors(page);
  const e = await R.enterRoom(page, id, { touch, T, back: 3.0, walkMs: 3000 });
  await page.waitForTimeout(1500);
  const st = await page.evaluate(() => ({ inside: window.__app.scene.isInsideInterior(), theme: window.__app.scene.interiorActiveTheme, panel: window.__app.ui.panels.current() }));
  if (st.panel) {
    await page.evaluate(() => window.__app.ui.panels.closeAll());
    await page.waitForTimeout(400);
  }
  return { press: e.press, ...st };
}

async function boot(t, prof) {
  const touch = lib.isTouchProfile(prof);
  const s = await t.session(prof, { init: [R.REWARD_INIT] });
  const { page } = s;
  const T = touch ? await lib.touch(s) : null;
  const b = await t.boot(s);
  await R.install(page);
  if (touch) await page.tap(`${lib.WELCOME} button[data-dismiss]`).catch(() => lib.dismissWelcome(page));
  else await lib.dismissWelcome(page);
  await page.waitForTimeout(1200);
  return { s, page, touch, T, b };
}

async function sweep(t) {
  const ids = t.args.ids && t.args.ids !== true ? String(t.args.ids).split(',') : THEMES;
  const step = Number(t.args.step || 0.3);
  for (const prof of t.profiles(['desktop'])) {
    const { page, touch, T } = await boot(t, prof);
    await R.warm(page);
    const rooms = {};
    for (const id of ids) {
      const st = await inRoom(page, id, touch, T);
      if (!st.inside) {
        rooms[id] = { error: 'not inside', ...st };
        continue;
      }
      const t0 = Date.now();
      rooms[id] = { ...(await page.evaluate(LIVE_SWEEP, { step, headings: 16, near: 0.1, settle: 10 })), ms: Date.now() - t0 };
      t.log(`${prof} ${id}: inside ${rooms[id].cameraInsidePropPct}% near ${rooms[id].nearPlanePct}% of ${rooms[id].poses}`);
    }
    await R.outdoors(page);
    t.data[prof] = rooms;
    for (const id of ids) {
      const r = rooms[id];
      const base = BASE_INSIDE[id] || 0;
      t.check(`${prof}: ${id}: camera strictly inside a prop`, r && !r.error ? r.cameraInsidePropPct === 0 : null, r ? (r.error ? r.error : `${r.cameraInsidePropPct}% of ${r.poses}`) : 'not run', `0% (58c8849: ${base}%)`);
      t.check(`${prof}: ${id}: camera within the 0.1 u near plane of a prop`, r && !r.error ? r.nearPlanePct <= 0.5 : null, r && !r.error ? `${r.nearPlanePct}%` : null, '<= 0.5% (58c8849: Contact 3.3, cottage 2.5, Professional 0.3)');
    }
  }
}

/** The pose in place now, after the build's camera has had a second: camera inside a prop, the avatar's share, occlusion. */
const POSE_VIEW = ({ x, z, yaw }) => {
  const sc = window.__app.scene;
  const o = sc.constructor.INTERIOR_ORIGIN;
  sc.player.position.set(o.x + x, o.y + 0.8, o.z + z);
  sc.interiorYaw = yaw;
  sc.interiorCamYaw = yaw;
  sc.interiorVelF = 0;
  sc.interiorVelS = 0;
  sc.setInteriorMove(0, 0);
  const wait = sc.interiorViewWait;
  sc.interiorViewWait = 1e9;
  for (let i = 0; i < 10; i++) sc.updateInteriorMode(0.1);
  sc.interiorViewWait = wait;
  return true;
};
const POSE_JUDGE = () => {
  const sc = window.__app.scene;
  const set = sc.interiorSets[sc.interiorActiveTheme];
  const cam = sc.camera;
  const V = cam.position.constructor;
  const meshes = [];
  let inside = null;
  set.traverse((m) => {
    if (!m.isMesh || !m.visible || !m.geometry || (m.material && m.material.transparent)) return;
    if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
    const b = m.geometry.boundingBox.clone().applyMatrix4(m.matrixWorld);
    if (!inside && b.containsPoint(cam.position)) inside = m.name || 'prop';
    meshes.push(m);
  });
  const rc = new (sc.getOrbitCamera().raycaster.constructor)();
  const tgt = sc.player.position.clone().add(new V(0, 0.85, 0));
  const dir = tgt.clone().sub(cam.position);
  const d = dir.length();
  rc.set(cam.position, dir.normalize());
  rc.near = 0;
  rc.far = d - 0.25;
  const occluded = rc.intersectObjects(meshes, false).length > 0;
  return { camInside: inside, occluded, avatar: window.__ia.avatarFrame() };
};

async function clip(t) {
  for (const prof of t.profiles(['desktop', 'phone'])) {
    const { page, touch, T } = await boot(t, prof);
    await R.warm(page);
    const st = await inRoom(page, 'personal', touch, T);
    const out = { room: st, poses: {} };
    if (st.inside) {
      // The audit's two poses: the chimney breast and the bookshelf. Found as
      // the first live-sweep poses inside the two props that took the most.
      const sw = await page.evaluate(LIVE_SWEEP, { step: 0.3, headings: 16, near: 0.1, settle: 10 });
      out.sweep = { cameraInsidePropPct: sw.cameraInsidePropPct, insideBy: sw.insideBy };
      // The audit's poses are fixed so a build that fixes the camera is judged on them too.
      const fixed = await page.evaluate(() => {
        const sc = window.__app.scene;
        const set = sc.interiorSets[sc.interiorActiveTheme];
        const o = sc.constructor.INTERIOR_ORIGIN;
        const found = {};
        set.traverse((m) => {
          if (!m.isMesh || !m.geometry) return;
          if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
          const b = m.geometry.boundingBox.clone().applyMatrix4(m.matrixWorld);
          const c = b.getCenter(m.position.clone());
          const sz = b.getSize(m.position.clone());
          // 58c8849's Personal room (theme 'home'): the chimney breast is
          // 0.50 x 2.60 x 1.40 and the bookshelf 0.38 x 2.20 x 1.60.
          const thin = Math.min(sz.x, sz.z);
          const wide = Math.max(sz.x, sz.z);
          const tag = sz.y >= 2.4 && wide > 1.2 && thin < 0.7 ? 'chimney' : sz.y >= 1.8 && sz.y < 2.4 && thin < 0.5 && wide > 1.2 ? 'bookshelf' : null;
          if (tag && !found[tag]) found[tag] = { cx: +(c.x - o.x).toFixed(2), cz: +(c.z - o.z).toFixed(2), sz: [sz.x, sz.y, sz.z].map((v) => +v.toFixed(2)) };
        });
        return found;
      });
      out.props = fixed;
      for (const [tag, p] of Object.entries(fixed)) {
        // Stand 1.9 u in front of the prop (toward the room centre), facing away from it.
        const len = Math.hypot(p.cx, p.cz) || 1;
        const ux = -p.cx / len;
        const uz = -p.cz / len;
        const x = p.cx + ux * 1.9;
        const z = p.cz + uz * 1.9;
        const yaw = Math.atan2(ux, uz);
        await page.evaluate(POSE_VIEW, { x, z, yaw });
        await page.waitForTimeout(500);
        const j = await page.evaluate(POSE_JUDGE);
        await t.shot(page, `clip-${prof}-personal-${tag}.png`);
        out.poses[tag] = { pose: [x, z, yaw].map((v) => +v.toFixed(2)), ...j };
      }
    }
    await R.outdoors(page);
    t.data[prof] = out;
    for (const tag of ['chimney', 'bookshelf']) {
      const p = out.poses[tag];
      t.check(`${prof}: ${tag} pose: the camera is outside the prop and the avatar shows`, p ? !p.camInside && !p.occluded && p.avatar.screenAreaPct > 3 : null, p ? { camInside: p.camInside, occluded: p.occluded, screenAreaPct: p.avatar.screenAreaPct } : 'pose not found', 'outside, not occluded, avatar > 3% (58c8849: the camera inside the chimney box)');
    }
  }
}

/** Every program the renderer holds: its shader name and output colour space. */
const PROGRAMS = () =>
  window.__app.renderer
    .getRenderer()
    .info.programs.map((p) => {
      const key = String(p.cacheKey || '');
      return { id: p.id, name: p.name || p.type || '?', linear: /(^|,)srgb-linear(,|$)/.test(key), srgb: /(^|,)srgb(,|$)/.test(key) };
    });

async function rtkeys(t) {
  for (const prof of t.profiles(['phone', 'desktop'])) {
    const { page, touch, T } = await boot(t, prof);
    // After the idle interior warm, as the audit measured it.
    await R.warm(page);
    await page.waitForTimeout(1500);
    const before = await page.evaluate(PROGRAMS);
    const ids = new Set(before.map((p) => p.id));
    const st = await inRoom(page, 'professional', touch, T);
    await page.waitForTimeout(1500);
    const after = await page.evaluate(PROGRAMS);
    const added = after.filter((p) => !ids.has(p.id));
    const by = {};
    for (const p of added) {
      const k = `${p.name}${p.linear ? ' srgb-linear' : p.srgb ? ' srgb' : ''}`;
      by[k] = (by[k] || 0) + 1;
    }
    await R.outdoors(page);
    const linear = added.filter((p) => p.linear);
    t.data[prof] = { room: st, before: before.length, after: after.length, added: added.length, addedBy: by, linearToonOrPhysical: linear.filter((p) => /Toon|Physical|Standard/i.test(p.name)).length };
    t.check(`${prof}: the first door's new programs, by shader and colour space`, true, `${added.length} added: ${JSON.stringify(by)}`, 'diagnostic (58c8849 phone: 28 srgb-linear, 12 toon, 10 physical; desktop: 2)');
  }
}

module.exports = {
  sweep: { item: 'P2-E1c (INT-04; P2-B11)', title: "the live room camera on a 0.3 u grid x 16 headings: strictly inside a prop (each mesh's own world bounds) and within the 0.1 u near plane, per theme", profiles: ['desktop'], run: sweep },
  clip: { item: 'P2-E1c (INT-04; P2-B11)', title: "Personal's chimney and bookshelf poses: the camera inside the prop, the avatar occluded, its share of the frame", profiles: ['desktop', 'phone'], run: clip },
  rtkeys: { item: 'P2-E1c (INT-01; diagnostic)', title: "the first door's new programs by shader and output colour space (render-target srgb-linear keys)", profiles: ['phone', 'desktop'], run: rtkeys },
};
