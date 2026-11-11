'use strict';
// Phase-2 room harness (P2-E1a), ported from the interiors audit's ia.cjs and
// rebased onto lib.cjs (the audit's copy required ux-build/B/scripts/hb.cjs;
// that is gone). The safety net is lib.cjs's: every non-GET aborted, the
// backend hosts blocked, WebSockets closed, service workers blocked.
//
// INSTALL puts window.__ia in the page: per-frame timing (update, render,
// main / render-target / post draws, programs, inside, the veil's opacity),
// building lookup and doorstep placement, room poses, canvas L* readback,
// posters, the avatar's share of the frame, the camera sweep and the
// reachability flood fill, and a state snapshot.
//
// enterRoom() enters the way a visitor does: stand on the door axis, walk at
// the door (W, or the joystick through trusted CDP touches) until its prompt
// shows, then press E or tap USE, and type the islet code on its pad. When a
// villager or prop holds the prompt, it uses the app's own door callback (the
// path E takes) and says so ('fallback-callback').
const lib = require('../lib.cjs');

// Long animation frames, long tasks and rAF gaps over 50 ms, from page
// start (the audit's LOAF, plus the frame gaps: one observer missing an
// entry cannot hide a freeze).
const LONGTASKS_INIT = `(() => {
  if (window.top !== window) return;
  const L = (window.__lt = { loaf: [], longtasks: [], gaps: [] });
  let last = 0;
  const tick = (t) => {
    if (last && t - last > 50) L.gaps.push([Math.round(last), Math.round(t - last)]);
    last = t;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries()) L.loaf.push([Math.round(e.startTime), Math.round(e.duration), Math.round(e.blockingDuration || 0)]); })
      .observe({ type: 'long-animation-frame', buffered: true });
  } catch (e) {}
  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries()) L.longtasks.push([Math.round(e.startTime), Math.round(e.duration)]); })
      .observe({ type: 'longtask', buffered: true });
  } catch (e) {}
})();`;

// welcome_visible, as the perf gate and the funnel audit define it: the card
// has content (innerHTML over 50 characters).
const WELCOME_MARK_INIT = `(() => {
  if (window.top !== window) return;
  window.__welcomeAt = null;
  const W = '[role=dialog][aria-label="Welcome to DigiScalability Life Island"]';
  const tick = () => {
    if (window.__welcomeAt === null) {
      const w = document.querySelector(W);
      if (w && w.innerHTML.length > 50) window.__welcomeAt = performance.now();
    }
    if (window.__welcomeAt === null) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
})();`;

const REWARD_INIT = `try { localStorage.setItem('ds_passport_reward','1'); } catch (e) {}`;

const stats = (arr) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))];
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  return { n: arr.length, mean: +mean.toFixed(2), p50: +q(0.5).toFixed(2), p95: +q(0.95).toFixed(2), max: +s[s.length - 1].toFixed(2), over50: arr.filter((x) => x > 50).length };
};

// Page-side instrumentation, installed once the app is ready.
const INSTALL = () => {
  const app = window.__app;
  if (!app || !app.renderer || !app.scene) return 'no app';
  if (window.__ia) return 'already';
  const R = app.renderer;
  const gl = R.getRenderer();
  const sc = app.scene;
  const now = () => (window.__vc ? window.__vc.realNow() : performance.now());
  const IA = (window.__ia = { frames: [], rec: false, cur: null, maxFrames: 4000 });
  const origCb = R.renderCallback;
  R.renderCallback = (dt) => {
    const t0 = now();
    const f = { t: t0, upd: 0, ren: 0, main: 0, rt: 0, post: 0, tris: 0, rtMs: 0 };
    IA.cur = f;
    origCb(dt);
    f.upd = now() - t0;
  };
  const origRender = R.render.bind(R);
  R.render = () => {
    const t0 = now();
    origRender();
    // Optional canvas readback in the SAME task as the draw (no
    // preserveDrawingBuffer): mean CIE L* over a 4 px grid, plus regions.
    if (IA.wantPixels) {
      IA.wantPixels = false;
      try {
        const c = gl.getContext();
        const w = c.drawingBufferWidth;
        const h = c.drawingBufferHeight;
        const buf = new Uint8Array(w * h * 4);
        c.readPixels(0, 0, w, h, c.RGBA, c.UNSIGNED_BYTE, buf);
        const lin = (v) => {
          v /= 255;
          return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
        };
        const Lstar = (r, g, b) => {
          const Y = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
          return Y > 0.008856 ? 116 * Math.cbrt(Y) - 16 : 903.3 * Y;
        };
        const regions = IA.pixRegions || { all: [0, 0, 1, 1] };
        const out = {};
        for (const [name, [x0, y0, x1, y1]] of Object.entries(regions)) {
          let s = 0;
          let n = 0;
          let dark = 0;
          const rgb = [0, 0, 0];
          // regions are in top-left-origin fractions; readPixels rows are bottom-up
          for (let y = Math.floor(y0 * h); y < Math.floor(y1 * h); y += 4) {
            const row = h - 1 - y;
            for (let x = Math.floor(x0 * w); x < Math.floor(x1 * w); x += 4) {
              const i = (row * w + x) * 4;
              const L = Lstar(buf[i], buf[i + 1], buf[i + 2]);
              s += L;
              n++;
              if (L < 15) dark++;
              rgb[0] += buf[i];
              rgb[1] += buf[i + 1];
              rgb[2] += buf[i + 2];
            }
          }
          out[name] = { L: +(s / Math.max(1, n)).toFixed(1), darkPct: +((100 * dark) / Math.max(1, n)).toFixed(1), rgb: rgb.map((v) => Math.round(v / Math.max(1, n))) };
        }
        IA.pixels = out;
      } catch (e) {
        IA.pixels = { error: String(e) };
      }
    }
    const f = IA.cur;
    if (f) {
      f.ren = now() - t0;
      f.prog = gl.info.programs.length;
      f.inside = sc.isInsideInterior();
      const fd = app.ui.fadeDiv;
      f.fade = fd ? +getComputedStyle(fd).opacity : 0;
      if (IA.rec) {
        IA.frames.push(f);
        if (IA.frames.length > IA.maxFrames) IA.frames.shift();
      }
    }
  };
  const origGL = gl.render.bind(gl);
  gl.render = (scene, cam) => {
    const t0 = now();
    origGL(scene, cam);
    const f = IA.cur;
    if (!f) return;
    const c = gl.info.render.calls;
    if (cam === sc.camera) {
      f.main += c;
      f.tris += gl.info.render.triangles;
    } else if (scene === sc) {
      f.rt += c;
      f.rtMs += now() - t0;
    } else f.post += c;
  };
  IA.start = () => {
    IA.frames = [];
    IA.rec = true;
  };
  IA.stop = () => {
    IA.rec = false;
    const fr = IA.frames;
    const out = [];
    for (let i = 0; i < fr.length; i++) {
      const f = fr[i];
      out.push({
        t: +(f.t - fr[0].t).toFixed(1),
        dt: i ? +(f.t - fr[i - 1].t).toFixed(1) : 0,
        upd: +f.upd.toFixed(2),
        ren: +f.ren.toFixed(2),
        main: f.main,
        rt: f.rt,
        rtMs: +f.rtMs.toFixed(2),
        post: f.post,
        tris: f.tris,
        prog: f.prog,
        inside: f.inside,
        fade: +(f.fade ?? 0).toFixed(2),
      });
    }
    return out;
  };
  // Building lookup: zone halls by id, cottages house_N, the islet house.
  IA.building = (id) => {
    const V = sc.player.position.constructor;
    let obj;
    let door;
    if (id.startsWith('house_') || id.startsWith('islet_')) {
      obj = sc.getObjectByName(id);
      const d = sc.island.houseDoors.find((x) => x.id === id);
      door = d ? d.position.clone() : null;
    } else {
      const z = sc.getZonesManager().getZoneById(id);
      obj = z ? z.marker : null;
    }
    if (!obj) return null;
    obj.updateWorldMatrix(true, false);
    const pos = new V().setFromMatrixPosition(obj.matrixWorld);
    const q = obj.getWorldQuaternion(sc.camera.quaternion.clone());
    const fwd = new V(0, 0, 1).applyQuaternion(q);
    // Zone halls: interaction needs centre distance < 2.5 and the collider
    // (1.7 + player 0.4) keeps the player beyond 2.1, so the doorstep is 2.3.
    if (!door) door = pos.clone().addScaledVector(fwd, 2.3);
    return { pos, fwd, door };
  };
  // Stand the player on the doorstep, facing the door, chase camera settled.
  IA.goToDoor = (id, back = 0) => {
    const b = IA.building(id);
    if (!b) return { error: 'no building ' + id };
    const p = b.door.clone().addScaledVector(b.fwd, back);
    const dir = p.clone().normalize();
    const s = sc.island.sampleSurfaceByDirection(dir, 0);
    sc.player.setWorldPosition(dir.multiplyScalar(s.position.length() + 0.75));
    sc.player.updateWorldMatrix?.();
    // The chase camera sits along followDir from the player: put it on the
    // street side (door-forward), so it looks past the player at the door —
    // the pose a visitor has when they press E (and the one the window's
    // outlook is derived from).
    const up = p.clone().normalize();
    const away = b.fwd.clone();
    away.addScaledVector(up, -away.dot(up)).normalize();
    const oc = sc.getOrbitCamera();
    oc.followDir = away.clone();
    oc.yawVelocity = 0;
    oc.snapToPlayer();
    return { ok: true, doorDist: +b.door.distanceTo(b.pos).toFixed(2) };
  };
  // Room-local pose: player at (x, z) facing yaw, camera settled behind.
  IA.pose = (x, z, yaw) => {
    const o = sc.constructor.INTERIOR_ORIGIN;
    sc.player.position.set(o.x + x, o.y + 0.8, o.z + z);
    sc.player.quaternion.setFromAxisAngle(new (sc.player.position.constructor)(0, 1, 0), yaw);
    sc.interiorYaw = yaw;
    sc.interiorCamYaw = yaw;
    sc.interiorVelF = 0;
    sc.interiorVelS = 0;
    sc.setInteriorMove(0, 0);
    return true;
  };
  IA.lum = (regions) =>
    new Promise((res) => {
      IA.pixRegions = regions || null;
      IA.pixels = null;
      IA.wantPixels = true;
      const wait = () => (IA.pixels ? res(IA.pixels) : requestAnimationFrame(wait));
      requestAnimationFrame(wait);
    });
  // The same readback from one frame drawn now (the caller may have stopped
  // the loop to change a light for that one frame).
  IA.lumNow = (regions) => {
    IA.pixRegions = regions || null;
    IA.pixels = null;
    IA.wantPixels = true;
    R.render();
    return IA.pixels;
  };
  // Visible lights, by type, and which of them are the room's own.
  IA.lights = () => {
    const own = new Set([sc.interiorLamp, sc.interiorRoomLamp, sc.interiorRoomFill, sc.interiorFire].filter(Boolean));
    const byType = {};
    let n = 0;
    let room = 0;
    sc.traverseVisible((o) => {
      if (!o.isLight) return;
      n++;
      byType[o.type] = (byType[o.type] || 0) + 1;
      if (own.has(o) || (sc.interiorGroup && (() => { let p = o; while (p) { if (p === sc.interiorGroup) return true; p = p.parent; } return false; })())) room++;
    });
    return { n, byType, room };
  };
  // The window pane on screen (top-left-origin fractions), or null when out of view.
  IA.windowRegion = () => {
    const mat = sc.interiorWindowMat;
    if (!mat || !sc.interiorGroup) return null;
    const V = sc.player.position.constructor;
    let x0 = 1, y0 = 1, x1 = 0, y1 = 0, seen = false;
    sc.interiorGroup.traverse((m) => {
      if (!m.isMesh || m.material !== mat || !m.geometry) return;
      if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
      const b = m.geometry.boundingBox;
      for (const x of [b.min.x, b.max.x])
        for (const y of [b.min.y, b.max.y])
          for (const z of [b.min.z, b.max.z]) {
            const w = new V(x, y, z).applyMatrix4(m.matrixWorld);
            if (w.clone().applyMatrix4(sc.camera.matrixWorldInverse).z > -sc.camera.near) continue;
            const v = w.project(sc.camera);
            seen = true;
            x0 = Math.min(x0, (v.x + 1) / 2);
            x1 = Math.max(x1, (v.x + 1) / 2);
            y0 = Math.min(y0, (1 - v.y) / 2);
            y1 = Math.max(y1, (1 - v.y) / 2);
          }
    });
    const c = (v) => Math.max(0, Math.min(1, v));
    if (!seen || c(x1) - c(x0) < 0.02 || c(y1) - c(y0) < 0.02) return null;
    // Inset a little: the frame and the curtains sit at the pane's edge.
    const ix = (c(x1) - c(x0)) * 0.2;
    const iy = (c(y1) - c(y0)) * 0.2;
    return [+(c(x0) + ix).toFixed(3), +(c(y0) + iy).toFixed(3), +(c(x1) - ix).toFixed(3), +(c(y1) - iy).toFixed(3)];
  };
  const geoAny = () => {
    let g = null;
    sc.interiorGroup.traverse((o) => {
      if (!g && o.isMesh && o.geometry) g = o.geometry;
    });
    g.computeBoundingBox();
    return g.boundingBox.constructor; // THREE.Box3
  };
  // Every poster: on-screen size, angle to the camera, and the cap height of
  // its text in CSS px (system-ui bold cap ≈ 0.72 em).
  IA.posters = () => {
    const cam = sc.camera;
    const W = innerWidth;
    const Hh = innerHeight;
    const V = sc.player.position.constructor;
    const res = [];
    sc.interiorGroup.traverse((o) => {
      if (!o.isMesh || !o.material || !o.material.map || !o.visible) return;
      const idx = sc.interiorPosters.findIndex((p) => p.tex === o.material.map);
      if (idx < 0) return;
      const { width: pw, height: ph } = o.geometry.parameters;
      const toScreen = (lx, ly) => {
        const w = new V(lx, ly, 0).applyMatrix4(o.matrixWorld);
        const behind = w.clone().applyMatrix4(cam.matrixWorldInverse).z > -cam.near;
        const v = w.project(cam);
        return { x: ((v.x + 1) / 2) * W, y: ((1 - v.y) / 2) * Hh, behind, ndc: v };
      };
      // visible fraction over a 7x7 grid of the poster face
      let vis = 0;
      for (let i = 0; i < 7; i++)
        for (let j = 0; j < 7; j++) {
          const s = toScreen(-pw / 2 + (pw * i) / 6, -ph / 2 + (ph * j) / 6);
          if (!s.behind && s.x >= 0 && s.x <= W && s.y >= 0 && s.y <= Hh) vis++;
        }
      const centre = new V(0, 0, 0).applyMatrix4(o.matrixWorld);
      const n = new V(0, 0, 1).transformDirection(o.matrixWorld);
      const toCam = cam.position.clone().sub(centre).normalize();
      const canvasH = sc.interiorPosters[idx].ctx.canvas.height;
      const fs = idx === 0 ? 60 : 40;
      // cap height of the text in world units on this poster, projected at the
      // poster centre (vertical and horizontal), so squash = wide/tall ratio
      const capW = (0.72 * fs * ph) / canvasH;
      const c0 = toScreen(0, 0);
      const cUp = toScreen(0, capW);
      const cRt = toScreen(capW, 0);
      const ok = !c0.behind && !cUp.behind && !cRt.behind;
      const capPx = ok ? Math.hypot(cUp.x - c0.x, cUp.y - c0.y) : null;
      const capWide = ok ? Math.hypot(cRt.x - c0.x, cRt.y - c0.y) : null;
      res.push({
        idx,
        which: ['back-title', 'left-content', 'right-content'][idx],
        visiblePct: Math.round((100 * vis) / 49),
        facingDeg: +((Math.acos(Math.max(-1, Math.min(1, n.dot(toCam)))) * 180) / Math.PI).toFixed(0),
        dist: +cam.position.distanceTo(centre).toFixed(2),
        capPx: capPx === null ? null : +capPx.toFixed(1),
        squash: capPx ? +(capWide / capPx).toFixed(2) : null,
      });
    });
    return res;
  };
  // Avatar's share of the frame at the current pose.
  // NOTE: never Box3.setFromObject(sc.player) here. SimplePlayer overrides
  // Object3D.updateWorldMatrix() with a zero-argument physics sync, so
  // setFromObject (and any child's getWorldPosition) snaps the avatar's
  // visual group back to the doorstep outside while the player is indoors.
  // Corners come from each mesh's own boundingBox x the last rendered
  // matrixWorld instead.
  IA.avatarFrame = () => {
    const V = sc.player.position.constructor;
    const cam = sc.camera;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let minWY = Infinity;
    let maxWY = -Infinity;
    sc.player.traverse((m) => {
      if (!m.isMesh || !m.geometry || !m.visible) return;
      if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
      const b = m.geometry.boundingBox;
      for (const x of [b.min.x, b.max.x])
        for (const y of [b.min.y, b.max.y])
          for (const z of [b.min.z, b.max.z]) {
            const w = new V(x, y, z).applyMatrix4(m.matrixWorld);
            minWY = Math.min(minWY, w.y);
            maxWY = Math.max(maxWY, w.y);
            const v = w.project(cam);
            minX = Math.min(minX, v.x);
            maxX = Math.max(maxX, v.x);
            minY = Math.min(minY, v.y);
            maxY = Math.max(maxY, v.y);
          }
    });
    const cx = (a) => Math.max(-1, Math.min(1, a));
    const area = ((cx(maxX) - cx(minX)) * (cx(maxY) - cx(minY))) / 4;
    return {
      bboxH: +(maxWY - minWY).toFixed(2),
      screenAreaPct: +(area * 100).toFixed(1),
      screenTopPct: +(((1 - cx(maxY)) / 2) * 100).toFixed(1),
      screenWidthPct: +(((cx(maxX) - cx(minX)) / 2) * 100).toFixed(1),
      camDist: +cam.position.distanceTo(sc.player.position).toFixed(2),
    };
  };
  // Every walkable (x, z) on a 0.3 grid x 16 headings: where would the follow
  // camera sit, is it inside a prop, and does a prop block its view of the
  // player? Mirrors updateInteriorMode's camera formula.
  IA.camSweep = (nearArg) => {
    const Box3 = geoAny();
    const o = sc.constructor.INTERIOR_ORIGIN;
    const set = sc.interiorSets[sc.interiorActiveTheme];
    const solids = [];
    const consider = (m, tag) => {
      if (!m.isMesh || !m.visible) return;
      if (m.material && m.material.transparent) return; // blobs, posters
      const b = new Box3().setFromObject(m);
      const sz = [b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z];
      solids.push({ b, tag, m, sz });
    };
    set.traverse((m) => consider(m, 'prop'));
    for (const c of sc.interiorGroup.children) if (c.isMesh) consider(c, 'shell');
    const rc = new (sc.getOrbitCamera().raycaster.constructor)();
    const V = sc.player.position.constructor;
    const meshes = solids.map((s) => s.m);
    let poses = 0;
    let inside = 0;
    let blocked = 0;
    const insideBy = {};
    const examples = [];
    for (let x = -3.3; x <= 3.31; x += 0.3)
      for (let z = -3.3; z <= 3.31; z += 0.3) {
        if (sc.interiorWallBlocked(x, z) || sc.interiorFurnitureBlocked(x, z)) continue;
        for (let k = 0; k < 16; k++) {
          const yaw = (k / 16) * Math.PI * 2;
          const camX = Math.max(-3.6, Math.min(3.6, x - Math.sin(yaw) * 2.4));
          const camZ = Math.max(-3.6, Math.min(3.6, z - Math.cos(yaw) * 2.4));
          const cam = new V(o.x + camX, o.y + 0.8 + 1.25, o.z + camZ);
          const tgt = new V(o.x + x, o.y + 0.8 + 0.85, o.z + z);
          poses++;
          const near = typeof nearArg === 'number' ? nearArg : 0.1;
          const inS = solids.find(
            (s) =>
              cam.x > s.b.min.x - near &&
              cam.x < s.b.max.x + near &&
              cam.y > s.b.min.y - near &&
              cam.y < s.b.max.y + near &&
              cam.z > s.b.min.z - near &&
              cam.z < s.b.max.z + near &&
              s.tag === 'prop',
          );
          if (inS) {
            inside++;
            const key = inS.sz.map((v) => v.toFixed(2)).join('x');
            insideBy[key] = (insideBy[key] || 0) + 1;
            if (examples.length < 6) examples.push({ x: +x.toFixed(1), z: +z.toFixed(1), yawDeg: k * 22.5, cam: [camX, 2.05, camZ].map((v) => +v.toFixed(2)), prop: key });
            continue;
          }
          const dir = tgt.clone().sub(cam);
          const d = dir.length();
          rc.set(cam, dir.normalize());
          rc.far = d - 0.25;
          rc.near = 0;
          const h = rc.intersectObjects(meshes, false);
          if (h.length) blocked++;
        }
      }
    return { poses, cameraInsidePropPct: +((100 * inside) / poses).toFixed(1), viewBlockedPct: +((100 * blocked) / poses).toFixed(1), insideBy, examples };
  };
  // Flood-fill the walkable floor from the build's spawn; which hotspots can
  // be reached, how far, and where two hotspots fight for the prompt. The
  // spawn and the hotspot list are the build's own when it has them (P2-B1:
  // GameScene.INTERIOR_SPAWN and scene.interiorHotspotsFor(theme), which
  // moves the home's curtains to (2.4, 2.7)); an older build falls back to
  // the audit's spawn (-1.8, 2.6) and its shell fixtures, the curtains at
  // (1.8, 2.95).
  IA.reach = () => {
    const G = sc.constructor;
    const theme = sc.interiorActiveTheme;
    const own = !!G.INTERIOR_SPAWN && Number.isFinite(G.INTERIOR_SPAWN.x) && Number.isFinite(G.INTERIOR_SPAWN.z);
    const SP = own ? { x: G.INTERIOR_SPAWN.x, z: G.INTERIOR_SPAWN.z } : { x: -1.8, z: 2.6 };
    const ownSpots = typeof sc.interiorHotspotsFor === 'function';
    // Short labels for the shell fixtures and the door; a theme's own
    // hotspots keep the prompt they show.
    const short = (h) => (h.action === 'leave' ? 'door (leave)' : h.text === 'curtains' ? 'curtains' : h.text === 'lamp' ? 'lamp switch' : h.label);
    const spots = ownSpots
      ? sc.interiorHotspotsFor(theme).map((h) => ({ ...h, label: short(h) }))
      : [
          ...(G.INTERIOR_HOTSPOTS[theme] || []).map((h) => ({ ...h })),
          { x: -2.75, z: 3.0, r: 1.0, label: 'lamp switch', action: 'room' },
          { x: 1.8, z: 2.95, r: 1.05, label: 'curtains', action: 'room' },
          { ...G.INTERIOR_DOOR_HOTSPOT, label: 'door (leave)' },
        ];
    const step = 0.1;
    const key = (i, j) => i * 1000 + j;
    const toXZ = (i, j) => [-3.4 + i * step, -3.4 + j * step];
    const N = Math.round(6.8 / step) + 1;
    const inWall = (i, j) => {
      if (i < 0 || j < 0 || i >= N || j >= N) return true;
      const [x, z] = toXZ(i, j);
      return sc.interiorWallBlocked(x, z);
    };
    const inProp = (i, j) => {
      const [x, z] = toXZ(i, j);
      return sc.interiorFurnitureBlocked(x, z);
    };
    const ok = (i, j) => !inWall(i, j) && !inProp(i, j);
    const si = Math.round((SP.x + 3.4) / step);
    const sj = Math.round((SP.z + 3.4) / step);
    const spawnInProp = inProp(si, sj);
    const dist = new Map([[key(si, sj), 0]]);
    const q = [[si, sj]];
    while (q.length) {
      const [i, j] = q.shift();
      const d0 = dist.get(key(i, j));
      // updateInteriorMode skips furniture while the CURRENT spot overlaps a
      // prop (the stuck-player escape), so moves out of a prop are allowed.
      const escaping = inProp(i, j);
      for (const [di, dj] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        const ni = i + di;
        const nj = j + dj;
        if (inWall(ni, nj) || dist.has(key(ni, nj))) continue;
        if (!escaping && inProp(ni, nj)) continue;
        dist.set(key(ni, nj), d0 + step);
        q.push([ni, nj]);
      }
    }
    let walkable = 0;
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) if (ok(i, j)) walkable++;
    const out = spots.map((h) => {
      let best = Infinity;
      for (const [k, d] of dist) {
        const i = Math.floor(k / 1000);
        const j = k % 1000;
        const [x, z] = toXZ(i, j);
        if (Math.hypot(x - h.x, z - h.z) < h.r) best = Math.min(best, d);
      }
      return { label: String(h.label).replace(/<[^>]+>/g, ''), action: h.action, reachable: best < Infinity, walkFromDoor: best < Infinity ? +best.toFixed(1) : null };
    });
    // the prompt at the spawn point itself
    const atSpawn = spots.filter((h) => Math.hypot(SP.x - h.x, SP.z - h.z) < h.r).map((h) => String(h.label).replace(/<[^>]+>/g, ''));
    // which prop the spawn overlaps (by its collider box), if any
    let spawnProp = null;
    if (spawnInProp) {
      const R = G.INTERIOR_PLAYER_R;
      const c = (sc.interiorColliders[theme] || []).find((b) => SP.x > b.minX - R && SP.x < b.maxX + R && SP.z > b.minZ - R && SP.z < b.maxZ + R);
      if (c) spawnProp = { minX: +c.minX.toFixed(2), maxX: +c.maxX.toFixed(2), minZ: +c.minZ.toFixed(2), maxZ: +c.maxZ.toFixed(2) };
    }
    return { spawn: [SP.x, SP.z], spawnFrom: own ? 'INTERIOR_SPAWN' : 'the audit (-1.8, 2.6)', spotsFrom: ownSpots ? 'interiorHotspotsFor' : 'the audit list', reachableCells: dist.size, walkableCells: walkable, hotspots: out, promptAtSpawn: atSpawn, spawnInsideProp: spawnProp };
  };
  IA.state = () => {
    const o = sc.constructor.INTERIOR_ORIGIN;
    const p = sc.player.position;
    const c = sc.camera.position;
    return {
      inside: sc.isInsideInterior(),
      theme: sc.interiorActiveTheme,
      player: [+(p.x - o.x).toFixed(2), +(p.y - o.y).toFixed(2), +(p.z - o.z).toFixed(2)],
      cam: [+(c.x - o.x).toFixed(2), +(c.y - o.y).toFixed(2), +(c.z - o.z).toFixed(2)],
      yaw: +sc.interiorYaw.toFixed(3),
      hotspot: sc.getInteriorHotspot()?.label ?? null,
      panel: app.ui.panels?.current?.() ?? null,
      programs: gl.info.programs.length,
      geometries: gl.info.memory.geometries,
      textures: gl.info.memory.textures,
      lamp: sc.interiorLamp ? +sc.interiorLamp.intensity.toFixed(2) : null,
      roomLamp: sc.interiorRoomLamp ? +sc.interiorRoomLamp.intensity.toFixed(2) : null,
      fill: sc.interiorRoomFill ? +sc.interiorRoomFill.intensity.toFixed(2) : null,
      fire: sc.interiorFire ? +sc.interiorFire.intensity.toFixed(2) : null,
      party: !!sc.partyMode,
      occupants: (sc.interiorOccupants || []).length,
      zzz: !!sc.interiorZzz?.visible,
      hour: sc.getEnvironmentCycle?.()?.getHour?.() ?? null,
      weather: sc.getEnvironmentCycle?.()?.getWeather?.() ?? null,
    };
  };
  return 'installed';
};

async function install(page) {
  return page.evaluate(INSTALL);
}

// Wait until the idle interior warm has run (or force it), so per-room numbers
// are steady-state rather than first-compile.
async function warm(page) {
  return page.evaluate(async () => {
    const sc = window.__app.scene;
    const t0 = performance.now();
    await sc.warmInterior();
    return { warmed: sc.interiorWarmed, ms: Math.round(performance.now() - t0) };
  });
}

async function frames(page, ms) {
  await page.evaluate(() => window.__ia.start());
  await page.waitForTimeout(ms);
  return page.evaluate(() => window.__ia.stop());
}

function summarise(fr, from = 0, to = Infinity) {
  const w = fr.filter((f) => f.t >= from && f.t <= to);
  const pick = (k) => w.map((f) => f[k]).filter((x) => typeof x === 'number');
  return {
    n: w.length,
    dt: stats(pick('dt').slice(1)),
    upd: stats(pick('upd')),
    ren: stats(pick('ren')),
    mainDraws: stats(pick('main')),
    rtDraws: w.filter((f) => f.rt > 0).map((f) => [f.t, f.rt, f.rtMs]),
    postDraws: stats(pick('post')),
    tris: stats(pick('tris')),
    prog: [w[0] && w[0].prog, w[w.length - 1] && w[w.length - 1].prog],
  };
}

const programs = (page) => page.evaluate(() => window.__app.renderer.getRenderer().info.programs.length);
const prompt = (page) => page.evaluate(() => (window.__app.ui.interactionDiv ? window.__app.ui.interactionDiv.textContent || '' : ''));

/** Frames recorded across an entry or exit: programs, the longest frame, the veil. */
function transition(fr, p0) {
  const firstIn = fr.findIndex((f) => f.inside);
  const black = fr.filter((f) => f.fade >= 0.95);
  return {
    frames: fr.length,
    firstInsideAtMs: firstIn >= 0 ? fr[firstIn].t : null,
    firstInsideFrameMs: firstIn >= 0 ? fr[firstIn].dt : null,
    nextFrameMs: firstIn >= 0 && fr[firstIn + 1] ? fr[firstIn + 1].dt : null,
    maxDt: fr.length ? Math.max(...fr.map((f) => f.dt)) : null,
    maxRen: fr.length ? Math.max(...fr.map((f) => f.ren)) : null,
    over50: fr.filter((f) => f.dt > 50).map((f) => [f.t, f.dt, +f.ren.toFixed(0)]),
    blackMs: black.length ? +(black[black.length - 1].t - black[0].t).toFixed(0) : 0,
    programsAdded: (fr.length ? fr[fr.length - 1].prog : p0) - p0,
    rtPass: fr.filter((f) => f.rt > 0).map((f) => ({ t: f.t, draws: f.rt, ms: f.rtMs })),
    inside: fr.length ? fr[fr.length - 1].inside : null,
  };
}

/** Leave any room and close every panel, so the next visit starts outdoors. */
async function outdoors(page) {
  await page.evaluate(() => {
    const a = window.__app;
    if (a.ui.panels && a.ui.panels.closeAll) a.ui.panels.closeAll();
    if (a.scene.isInsideInterior()) a.exitBuilding(a.insideIsZone);
  });
  await page.waitForTimeout(1200);
}

/** Type the islet's code on its pad: keys on a keyboard, taps on a phone. */
async function typePin(page, touch, pin = '5673') {
  if (!touch) {
    await page.keyboard.type(pin, { delay: 110 });
    return 'typed';
  }
  for (const d of pin) {
    const r = await page.evaluate((dg) => {
      const b = [...((window.__app.ui.pinDiv && window.__app.ui.pinDiv.querySelectorAll('button')) || [])].find((x) => x.textContent === dg);
      if (!b) return null;
      const q = b.getBoundingClientRect();
      return { x: q.x + q.width / 2, y: q.y + q.height / 2 };
    }, d);
    if (r) await page.touchscreen.tap(r.x, r.y);
    await page.waitForTimeout(120);
  }
  return 'tapped';
}

/**
 * Walk at a building's door like a visitor and press E or tap USE when its
 * prompt shows. opts.T is lib.touch(session) on a touch profile.
 * Returns { door, walkMs, promptOutside, press, pin }. The frames of the entry
 * are recorded from the press when opts.record is set (then .frames, .t0).
 */
async function enterRoom(page, id, { touch = false, T = null, back = 3.0, walkMs = 6000, standStillMs = 0, beforePress = null, record = false, pin = '5673', settleMs = 700, fastPrompt = false } = {}) {
  const out = { id };
  out.door = await page.evaluate(([i, b]) => window.__ia.goToDoor(i, b), [id, back]);
  await page.waitForTimeout(settleMs);
  const t0 = Date.now();
  let down = false;
  let c = null;
  if (touch && T) {
    c = await T.joyCenter();
    if (c) {
      await T.send('touchStart', [[c[0], c[1], 1]]);
      for (let k = 1; k <= 6; k++) await T.send('touchMove', [[c[0], c[1] - k * 8, 1]]);
      down = true;
    }
  } else await page.keyboard.down('KeyW');
  if (fastPrompt) {
    // One in-page wait instead of a round trip every 50 ms: on a throttled
    // CPU each round trip costs a frame or more.
    await page
      .waitForFunction(() => /to enter/.test((window.__app.ui.interactionDiv && window.__app.ui.interactionDiv.textContent) || ''), null, { timeout: walkMs, polling: 'raf' })
      .catch(() => {});
  } else {
    let ms = 0;
    for (; ms < walkMs; ms += 50) {
      await page.waitForTimeout(50);
      if (!touch && ms % 400 === 0) await page.keyboard.down('KeyW');
      if (/to enter/.test(await prompt(page))) break;
    }
  }
  if (down) await T.send('touchEnd', []);
  if (!touch) await page.keyboard.up('KeyW');
  out.walkMs = Date.now() - t0;
  out.promptOutside = await prompt(page);
  if (standStillMs) await page.waitForTimeout(standStillMs);
  if (beforePress) await beforePress();
  out.p0 = await programs(page);
  out.nearDoorWarmBeforeE = await page.evaluate(() => !!window.__app.scene.interiorNearDoorWarmed);
  if (record) await page.evaluate(() => window.__ia.start());
  out.pressAt = await page.evaluate(() => performance.now());
  if (/to enter/.test(out.promptOutside)) {
    if (touch && T) {
      const u = await T.useBtn();
      if (u) await T.tap(u[0], u[1]);
      out.press = u ? 'USE tap' : 'no USE button';
    } else {
      await page.keyboard.press('KeyE');
      out.press = 'E';
    }
  } else {
    // A villager or prop holds the prompt: the scene's own door callback, the path E takes.
    out.press = 'fallback-callback';
    await page.evaluate((i) => {
      const sc = window.__app.scene;
      if (i.startsWith('house_') || i.startsWith('islet_')) sc.onHouseEnterCb(i);
      else sc.interactWithZone(sc.getZonesManager().getZoneById(i));
    }, id);
  }
  if (id.startsWith('islet_')) {
    await page.waitForTimeout(500);
    out.pinPad = await page.evaluate(() => !!window.__app.ui.pinDiv);
    if (out.pinPad) out.pin = await typePin(page, touch, pin);
  }
  return out;
}

/** The Leave control, as a visitor finds it (D's P2-D2 makes it a button). */
const LEAVE_RECT = () => {
  const ui = window.__app.ui;
  const b = ui.leaveBtn || [...document.querySelectorAll('#ui-overlay div, #ui-overlay button')].find((d) => /←\s*Leave/.test(d.textContent || '') && d.children.length <= 1);
  if (!b || !b.isConnected) return null;
  const r = b.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return null;
  return { tag: b.tagName, role: b.getAttribute('role'), tabIndex: b.tabIndex, ariaLabel: b.getAttribute('aria-label'), x: r.x, y: r.y, w: r.width, h: r.height };
};

module.exports = { LONGTASKS_INIT, WELCOME_MARK_INIT, REWARD_INIT, INSTALL, install, warm, frames, summarise, stats, transition, programs, prompt, outdoors, typePin, enterRoom, LEAVE_RECT };
