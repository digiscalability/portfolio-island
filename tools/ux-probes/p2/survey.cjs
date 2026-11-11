'use strict';
// p2/survey (P2-E1a, from the interiors audit's survey.cjs). Every enterable
// building, entered the way a visitor does (walk at the door, E or a USE tap,
// the islet code typed on its pad): the entry transition, the room's
// reachability flood fill (reach: every hotspot reachable from the spawn,
// promptAtSpawn, spawnInsideProp; the spawn and hotspots are the build's own,
// GameScene.INTERIOR_SPAWN and interiorHotspotsFor(theme), or the audit's
// (-1.8, 2.6) and shell fixtures on a build without them), the camera sweep,
// the avatar's share of the frame (avatarFrame), the posters' cap height
// (capPx), four room poses, the steady per-room cost, the forced window
// pass, then out by the Leave control and the exit transition.
//
//   npm run probe -- p2/survey [--device desk|phone] [--hour 12] [--ids a,b] [--no-poses] [--weather rain] --dist dist --port <n>
//
// P2-B1's bar: promptAtSpawn is [] and spawnInsideProp null in all 7 themes,
// every hotspot reachable. D6's: entering the Welcome hall, no toast or flash
// rectangle intersects the zone panel's.
const lib = require('../lib.cjs');
const R = require('./room-lib.cjs');

const IDS = ['welcome', 'professional', 'projects', 'personal', 'contact', 'house_0', 'house_3', 'islet_beach_house'];
const POSES = {
  back: [
    [0, 1.6, Math.PI],
    [0.6, 1.6, Math.PI],
    [-0.8, 1.2, Math.PI],
  ],
  left: [
    [0.6, 0.4, -Math.PI / 2],
    [1.2, 0.4, -Math.PI / 2],
    [0.6, 1.2, -Math.PI / 2],
  ],
  right: [
    [-0.6, 0.4, Math.PI / 2],
    [-1.2, 0.4, Math.PI / 2],
    [-0.6, 1.2, Math.PI / 2],
  ],
  front: [
    [0.6, -1.2, 0],
    [1.0, -0.6, 0],
    [0.2, -0.4, 0],
  ],
};

// D6: toasts and flashes painted over the open zone panel.
const MESSAGE_OVER_PANEL = () => {
  const ui = window.__app.ui;
  const p = ui.zonePanelDiv;
  if (!p || !p.isConnected) return null;
  const pr = p.getBoundingClientRect();
  const out = [];
  for (const [k, el] of [
    ['toast', ui.toastEl],
    ['flash', ui.flashEl],
  ]) {
    if (!el || !el.isConnected || parseFloat(getComputedStyle(el).opacity) < 0.3) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    const w = Math.min(r.right, pr.right) - Math.max(r.left, pr.left);
    const h = Math.min(r.bottom, pr.bottom) - Math.max(r.top, pr.top);
    if (w > 1 && h > 1) out.push(`${k} '${(el.textContent || '').trim().slice(0, 40)}' ${Math.round(w)}x${Math.round(h)}`);
  }
  return out;
};

async function surveyOne(t, page, id, { touch, T, skipPoses, tag }) {
  const B = { id };
  try {
    await R.outdoors(page);
    const e = await R.enterRoom(page, id, { touch, T, back: 3.0, walkMs: 3000, record: true });
    Object.assign(B, { door: e.door, walkMs: e.walkMs, promptOutside: e.promptOutside, press: e.press, pinPad: e.pinPad ?? null });
    // D6: sample message rectangles over the panel while it opens.
    const over = [];
    for (let i = 0; i < 9; i++) {
      await page.waitForTimeout(300);
      for (const x of (await page.evaluate(MESSAGE_OVER_PANEL)) || []) if (!over.includes(x)) over.push(x);
    }
    B.messagesOverPanel = over;
    await t.shot(page, `survey-${tag}-${id}-1-entered.png`);
    B.a11yOnEnter = await page.evaluate(() => {
      const ae = document.activeElement;
      const live = [...document.querySelectorAll('[aria-live],[role=status],[role=alert],[role=log]')].map((e) => ({ role: e.getAttribute('role'), live: e.getAttribute('aria-live'), text: (e.textContent || '').trim().slice(0, 80) }));
      const pr = window.__app.ui.interactionDiv;
      return { active: ae ? `${ae.tagName}${ae.id ? '#' + ae.id : ''} ${(ae.textContent || '').trim().slice(0, 30)}` : null, liveRegions: live.filter((l) => l.text), promptText: pr ? pr.textContent : null, panel: window.__app.ui.panels.current() };
    });
    await page.waitForTimeout(100);
    const fr = await page.evaluate(() => window.__ia.stop());
    B.enter = R.transition(fr, e.p0);
    B.state = await page.evaluate(() => window.__ia.state());
    if (!B.state.inside) {
      B.error = 'not inside after the door';
      return B;
    }
    if (B.state.panel) {
      await page.keyboard.press('Escape');
      await page.waitForTimeout(500);
      if (touch) await page.evaluate(() => window.__app.ui.panels.closeAll());
      B.afterEscape = await page.evaluate(() => ({ inside: window.__app.scene.isInsideInterior(), panel: window.__app.ui.panels.current() }));
    }
    await page.waitForTimeout(400);
    await t.shot(page, `survey-${tag}-${id}-2-entry-view.png`);
    B.entryView = {
      avatarFrame: await page.evaluate(() => window.__ia.avatarFrame()),
      posters: await page.evaluate(() => window.__ia.posters()),
      lum: await page.evaluate(() => window.__ia.lum()),
      hotspot: (await page.evaluate(() => window.__ia.state())).hotspot,
    };
    B.capPx = B.entryView.posters.map((p) => ({ which: p.which, capPx: p.capPx, visiblePct: p.visiblePct }));
    B.reach = await page.evaluate(() => window.__ia.reach());
    B.camSweep = await page.evaluate(() => window.__ia.camSweep());
    if (!skipPoses) {
      B.poses = {};
      for (const [name, cands] of Object.entries(POSES)) {
        const used = await page.evaluate((cs) => {
          const sc = window.__app.scene;
          for (const [x, z, yaw] of cs) {
            if (!sc.interiorFurnitureBlocked(x, z)) {
              window.__ia.pose(x, z, yaw);
              return [x, z, yaw];
            }
          }
          window.__ia.pose(...cs[0]);
          return cs[0];
        }, cands);
        await page.waitForTimeout(450);
        await t.shot(page, `survey-${tag}-${id}-3-${name}.png`);
        B.poses[name] = { pose: used, posters: await page.evaluate(() => window.__ia.posters()), avatarFrame: await page.evaluate(() => window.__ia.avatarFrame()), lum: await page.evaluate(() => window.__ia.lum({ all: [0, 0, 1, 1], centre: [0.3, 0.2, 0.7, 0.6] })), hotspot: (await page.evaluate(() => window.__ia.state())).hotspot };
      }
    }
    await page.evaluate(() => window.__ia.pose(0, 1.6, Math.PI));
    await page.waitForTimeout(300);
    B.perf = R.summarise(await R.frames(page, 2000));
    await page.evaluate(() => {
      window.__app.scene.interiorViewAccum = 99;
      window.__ia.start();
    });
    await page.waitForTimeout(400);
    B.windowPass = (await page.evaluate(() => window.__ia.stop())).filter((f) => f.rt > 0).map((f) => ({ draws: f.rt, ms: f.rtMs, frameDt: f.dt }));
    // Out by the Leave control, the way a visitor finds it.
    const lr = await page.evaluate(R.LEAVE_RECT);
    B.leaveButton = lr;
    await page.evaluate(() => window.__ia.start());
    if (lr) {
      if (touch) await page.touchscreen.tap(lr.x + lr.w / 2, lr.y + lr.h / 2);
      else await page.mouse.click(lr.x + lr.w / 2, lr.y + lr.h / 2);
    }
    await page.waitForTimeout(2050);
    const xf = await page.evaluate(() => window.__ia.stop());
    const lastIn = xf.map((f) => f.inside).lastIndexOf(true);
    B.exit = { frames: xf.length, outsideAtMs: lastIn >= 0 && xf[lastIn + 1] ? xf[lastIn + 1].t : null, maxDt: xf.length ? Math.max(...xf.map((f) => f.dt)) : null, blackMs: R.transition(xf, 0).blackMs, programsAdded: (xf.length ? xf[xf.length - 1].prog : 0) - (xf.length ? xf[0].prog : 0) };
    B.afterExit = await page.evaluate(() => window.__ia.state());
  } catch (e) {
    B.error = String(e).slice(0, 300);
    await page.evaluate(() => {
      try {
        if (window.__app.scene.isInsideInterior()) window.__app.exitBuilding(true);
      } catch (e) {}
    });
    await page.waitForTimeout(1500);
  }
  return B;
}

async function survey(t) {
  const hour = String(t.args.hour || '12');
  const ids = t.args.ids && t.args.ids !== true ? String(t.args.ids).split(',') : IDS;
  for (const prof of t.profiles(['desktop'])) {
    const touch = lib.isTouchProfile(prof);
    const tag = `${prof}-h${hour}`;
    const s = await t.session(prof, { init: [R.REWARD_INIT] });
    const { page } = s;
    const T = touch ? await lib.touch(s) : null;
    const out = { hour, buildings: {} };
    out.boot = await t.boot(s, { query: `hour=${hour}` });
    out.install = await R.install(page);
    if (touch) await page.tap(`${lib.WELCOME} button[data-dismiss]`).catch(() => lib.dismissWelcome(page));
    else await lib.dismissWelcome(page);
    await page.waitForTimeout(1200);
    if (!t.args.noWarm) out.warm = await R.warm(page);
    if (t.args.weather && t.args.weather !== true) await page.evaluate((w) => window.__app.scene.getEnvironmentCycle().setWeather(w), String(t.args.weather));
    await page.waitForTimeout(1500);
    for (const id of ids) out.buildings[id] = await surveyOne(t, page, id, { touch, T, skipPoses: !!t.args.noPoses, tag });
    t.data[tag] = out;
    // Per theme (the cottages share one).
    const themes = {};
    for (const b of Object.values(out.buildings)) {
      const th = (b.state && b.state.theme) || b.id;
      if (!themes[th]) themes[th] = b;
    }
    const bad = (f) => Object.entries(themes).filter(([, b]) => !b.reach || f(b.reach)).map(([th, b]) => `${th}: ${b.reach ? JSON.stringify(f(b.reach)) : b.error || 'no reach'}`);
    t.check(`${prof}: promptAtSpawn is [] in every theme (${Object.keys(themes).length})`, Object.keys(themes).length >= 7 ? bad((r) => (r.promptAtSpawn.length ? r.promptAtSpawn : null)).length === 0 : false, bad((r) => (r.promptAtSpawn.length ? r.promptAtSpawn : null)).slice(0, 8), '[] in all 7');
    t.check(`${prof}: spawnInsideProp is null in every theme`, bad((r) => r.spawnInsideProp).length === 0, bad((r) => r.spawnInsideProp).slice(0, 8), 'null');
    t.check(`${prof}: every hotspot is reachable from the doorway`, bad((r) => { const u = r.hotspots.filter((h) => !h.reachable).map((h) => h.label); return u.length ? u : null; }).length === 0, bad((r) => { const u = r.hotspots.filter((h) => !h.reachable).map((h) => h.label); return u.length ? u : null; }).slice(0, 8), 'all reachable');
    const w = out.buildings.welcome;
    if (w) t.check(`${prof}: entering the Welcome hall, no toast or flash over the zone panel (D6)`, (w.messagesOverPanel || []).length === 0, (w.messagesOverPanel || []).length ? w.messagesOverPanel : 'none', 'none');
    t.check(`${prof}: every building entered`, Object.values(out.buildings).every((b) => b.state && b.state.inside), Object.values(out.buildings).map((b) => `${b.id} ${b.state && b.state.inside ? 'in' : 'OUT'} (${b.press})`), 'all');
  }
}

module.exports = {
  survey: { item: 'P2-E1a (INT-03, INT-04, P2-B1, D6)', title: 'every building by the door: entry, reach and promptAtSpawn, spawnInsideProp, camera sweep, avatarFrame, capPx, poses, cost, Leave and exit', profiles: ['desktop'], run: survey },
};
