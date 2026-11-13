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
//   npm run probe -- p2/survey [--device desk|phone] [--hour 12] [--ids a,b] [--no-poses] [--weather rain] [--selftest-a11] --dist dist --port <n>
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

// ------------------------------------------------------------- P2-A11 rows
// Wave-4 rows list: the hire card from the Professional and Contact halls,
// a project card in Projects and the compass in Welcome, each in 2 actions
// (walk to the hotspot, then E), and J held 1 s turning the view. The
// analytics listener replaces window.va (@vercel/analytics' queue) before any
// page script, and pins it so the insights script cannot swap it out (the
// harness blocks /_vercel/insights/ anyway), so track('hire_cta',
// {cta:'interior'}) is seen without a send.
//
// Every boot carries ?owner=1 (lib APP_QUERY), and Analytics.track() returns
// at once on an owner visit (isOwnerVisit reads localStorage 'ds_owner'), so
// with owner mode on no event would ever reach window.va. The survey hides
// that key from the page: getItem('ds_owner') reads null in this session
// only. Nothing leaves: insights hosts and paths and every non-GET are blocked
// by the harness. isOwnerVisit gates analytics alone (Analytics.ts and the
// inject() beforeSend in main-simple.ts), so nothing else in the run changes.
const OWNER_KEY = 'ds_owner';
const A11_INIT = `(() => {
  if (window.top !== window) return;
  try {
    const gi = Storage.prototype.getItem;
    Storage.prototype.getItem = function (k) { return k === ${JSON.stringify(OWNER_KEY)} ? null : gi.call(this, k); };
  } catch (e) {}
  const L = (window.__a11 = { va: [], guideTo: [] });
  const va = function (...p) { try { L.va.push(JSON.parse(JSON.stringify(p))); } catch (e) {} };
  try { Object.defineProperty(window, 'va', { configurable: true, get: () => va, set: () => {} }); } catch (e) { window.va = va; }
  window.addEventListener('ds:guide-to', (e) => L.guideTo.push(e.detail ? JSON.parse(JSON.stringify(e.detail)) : null));
})();`;
/** The hire_cta event with this cta among the listener's events, or null. */
const hireHit = (events, cta) => (events || []).find((e) => e && e.name === 'hire_cta' && e.data && e.data.cta === cta) || null;
/** Events the listener has seen since index n, as {name, data}. */
const VA_SINCE = (n) => window.__a11.va.slice(n).filter((p) => p[0] === 'event').map((p) => ({ name: p[1].name, data: p[1].data || null }));
const A11_ROOMS = { professional: 'hire', contact: 'hire', projects: 'project', welcome: 'compass' };

/** Stand on the hotspot whose arg starts with `want` (room-local), facing it; null when the build has none. */
const TO_HOTSPOT = (want) => {
  const sc = window.__app.scene;
  if (typeof sc.interiorHotspotsFor !== 'function') return { why: 'no interiorHotspotsFor' };
  const hs = sc.interiorHotspotsFor(sc.interiorActiveTheme).filter((h) => typeof h.arg === 'string' && (h.arg === want || h.arg.startsWith(`${want}:`)));
  if (!hs.length) return { why: `no hotspot with arg '${want}'` };
  for (const h of hs)
    for (const f of [0.5, 0.75, 0.3, 0.9, 0.97])
      for (let k = 0; k < 16; k++) {
        const a = (k / 16) * Math.PI * 2;
        const x = h.x + Math.cos(a) * h.r * f;
        const z = h.z + Math.sin(a) * h.r * f;
        if (sc.interiorFurnitureBlocked(x, z) || sc.interiorWallBlocked(x, z)) continue;
        // Face the hotspot centre (yaw 0 looks along +Z in IA.pose's frame).
        window.__ia.pose(x, z, Math.atan2(h.x - x, h.z - z));
        return { arg: h.arg, at: [+x.toFixed(2), +z.toFixed(2)] };
      }
  return { why: 'every spot around the hotspot is blocked', spots: hs.map((h) => [h.x, h.z, h.r]) };
};
const CAM_YAW = () => {
  const d = window.__app.scene.camera.getWorldDirection(window.__app.scene.player.position.clone());
  return (Math.atan2(d.x, d.z) * 180) / Math.PI;
};

async function a11Room(page, id, { touch, T }) {
  const want = A11_ROOMS[id];
  const out = { want };
  const go = await page.evaluate(TO_HOTSPOT, want);
  Object.assign(out, go);
  if (go.arg) {
    await page.waitForTimeout(500);
    out.prompt = await page.evaluate(() => {
      const h = window.__app.scene.getInteriorHotspot();
      return h ? { label: String(h.label || '').replace(/<[^>]+>/g, ''), arg: h.arg || null } : null;
    });
    const n0 = await page.evaluate(() => ({ va: window.__a11.va.length, g: window.__a11.guideTo.length }));
    if (touch && T) {
      const u = await T.useBtn();
      if (u) await T.tap(u[0], u[1]);
    } else await page.keyboard.press('e');
    await page.waitForTimeout(1200);
    out.after = await page.evaluate(
      ([n, anchor]) => {
        const ui = window.__app.ui;
        const va = window.__a11.va.slice(n.va).filter((p) => p[0] === 'event').map((p) => p[1]);
        const panel = ui.panels && ui.panels.current ? ui.panels.current() : null;
        const zp = ui.zonePanelDiv && ui.zonePanelDiv.isConnected ? ui.zonePanelDiv : null;
        const card = zp ? zp.querySelector(anchor ? `[data-project="${anchor}"]` : '[data-project]') : null;
        let inView = null;
        if (card) {
          const r = card.getBoundingClientRect();
          const v = zp.getBoundingClientRect();
          inView = r.top >= v.top - 1 && r.top < v.bottom - 20;
        }
        return { events: va.map((e) => ({ name: e.name, data: e.data || null })), guideTo: window.__a11.guideTo.slice(n.g), panel, projectCard: !!card, projectCardInView: inView };
      },
      [n0, go.arg.startsWith('project:') ? go.arg.slice(8) : null],
    );
    await page.evaluate(() => {
      const ui = window.__app.ui;
      if (ui.closeHireCard) ui.closeHireCard();
      if (ui.panels && ui.panels.closeAll) ui.panels.closeAll();
    });
    await page.waitForTimeout(500);
  }
  // J held 1 s indoors, from the room's middle facing the back wall.
  if (!touch) {
    await page.evaluate(() => window.__ia.pose(0, 0.6, Math.PI));
    await page.waitForTimeout(500);
    const y0 = await page.evaluate(CAM_YAW);
    await page.keyboard.down('j');
    await page.waitForTimeout(1000);
    await page.keyboard.up('j');
    await page.waitForTimeout(150);
    const y1 = await page.evaluate(CAM_YAW);
    out.jTurnDeg = Math.round(Math.abs(((y1 - y0 + 540) % 360) - 180));
  }
  return out;
}

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
    if (A11_ROOMS[id]) B.a11 = await a11Room(page, id, { touch, T, tag, t });
    await page.evaluate(() => window.__ia.pose(0, 1.6, Math.PI));
    await page.waitForTimeout(300);
    B.perf =R.summarise(await R.frames(page, 2000));
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
    const s = await t.session(prof, { init: [R.REWARD_INIT, A11_INIT] });
    const { page } = s;
    const T = touch ? await lib.touch(s) : null;
    const out = { hour, buildings: {} };
    out.boot = await t.boot(s, { query: `hour=${hour}` });
    out.install = await R.install(page);
    if (touch) await page.tap(`${lib.WELCOME} button[data-dismiss]`).catch(() => lib.dismissWelcome(page));
    else await lib.dismissWelcome(page);
    await page.waitForTimeout(1200);
    out.ownerHidden = await page.evaluate((k) => ({ query: new URLSearchParams(location.search).get('owner'), stored: localStorage.getItem(k) }), OWNER_KEY);
    if (t.args.selftestA11) {
      // --selftest-a11: a real track() through the app's own Analytics module
      // (the hire card's 'Send a message' button fires hire_cta {cta:'message'}),
      // judged by the same matcher as the hall rows. It proves the listener
      // sees track() despite ?owner=1, so the hall rows can pass on a build
      // that fires {cta:'interior'}.
      const n = await page.evaluate(() => window.__a11.va.length);
      const opened = await page.evaluate(() => {
        window.__app.ui.showHireCard('menu');
        const b = document.querySelector('button[data-hire-contact]');
        if (!b) return false;
        b.click();
        return true;
      });
      await page.waitForTimeout(1500);
      const events = await page.evaluate(VA_SINCE, n);
      out.selftestA11 = { opened, events, ownerHidden: out.ownerHidden };
      t.check(`${prof}: selftest: a real track('hire_cta') reaches the listener under ?owner=1 (row matcher)`, opened ? !!hireHit(events, 'message') : null, out.selftestA11, "hire_cta {cta:'message'} seen");
      await page.evaluate(() => {
        const ui = window.__app.ui;
        if (ui.closeHireCard) ui.closeHireCard();
        if (ui.panels && ui.panels.closeAll) ui.panels.closeAll();
      });
      await page.waitForTimeout(500);
    }
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
    // P2-A11 (wave 4). Exhibit cap height at the back, left and right poses
    // in the five halls: the poster each pose faces (back-title, left-content,
    // right-content), when at least half of it is on screen.
    const minCap = touch ? 11 : 18;
    const caps = [];
    for (const hid of ['welcome', 'professional', 'projects', 'personal', 'contact']) {
      const b = out.buildings[hid];
      if (!b || !b.poses) continue;
      for (const [pose, which] of [
        ['back', 'back-title'],
        ['left', 'left-content'],
        ['right', 'right-content'],
      ]) {
        const pp = b.poses[pose] && (b.poses[pose].posters || []).find((x) => x.which === which);
        if (pp && pp.visiblePct >= 50 && pp.capPx !== null) caps.push({ hall: hid, pose, capPx: pp.capPx });
      }
    }
    const low = caps.filter((c) => c.capPx < minCap);
    t.check(`${prof}: exhibit cap height at the back, left and right poses in the halls (P2-A11)`, caps.length ? low.length === 0 : null, caps.length ? (low.length ? low : `min ${Math.min(...caps.map((c) => c.capPx))} px over ${caps.length}`) : 'no exhibit on screen at those poses', `>= ${minCap} px`);
    const a11 = (hid) => (out.buildings[hid] && out.buildings[hid].a11) || null;
    for (const hid of ['professional', 'contact']) {
      const a = a11(hid);
      const hit = a && a.after ? hireHit(a.after.events, 'interior') : null;
      t.check(`${prof}: in the ${hid} hall the hire card opens in 2 actions, hire_cta {cta:'interior'} (P2-A11)`, a && a.after ? !!hit : null, a ? (a.after ? { prompt: a.prompt, events: a.after.events, panel: a.after.panel } : a.why) : 'not surveyed', "hire_cta {cta:'interior'} (null: no hotspot with arg 'hire')");
    }
    const ap = a11('projects');
    t.check(`${prof}: in Projects a project card opens in 2 actions (P2-A11)`, ap && ap.after ? ap.after.projectCard && ap.after.projectCardInView !== false : null, ap ? (ap.after ? { prompt: ap.prompt, arg: ap.arg, panel: ap.after.panel, card: ap.after.projectCard, inView: ap.after.projectCardInView } : ap.why) : 'not surveyed', "Projects open at a card (null: no hotspot with arg 'project')");
    const aw = a11('welcome');
    t.check(`${prof}: in Welcome the compass is set in 2 actions (P2-A11)`, aw && aw.after ? aw.after.guideTo.some((d) => d && /^district:/.test(d.key || '')) : null, aw ? (aw.after ? { prompt: aw.prompt, guideTo: aw.after.guideTo } : aw.why) : 'not surveyed', "ds:guide-to {key:'district:...'} (null: no hotspot with arg 'compass')");
    if (!touch) {
      const turns = ['welcome', 'professional', 'projects', 'contact'].map((hid) => a11(hid)).filter((a) => a && typeof a.jTurnDeg === 'number').map((a) => a.jTurnDeg);
      t.check(`${prof}: J held 1 s indoors turns the view 60 deg or more (P2-A11)`, turns.length ? Math.min(...turns) >= 60 : null, turns.length ? turns : 'not measured', '>= 60 in every hall');
    }
    t.check(`${prof}: every building entered`, Object.values(out.buildings).every((b) => b.state && b.state.inside), Object.values(out.buildings).map((b) => `${b.id} ${b.state && b.state.inside ? 'in' : 'OUT'} (${b.press})`), 'all');
  }
}

module.exports = {
  survey: { item: 'P2-E1a (INT-03, INT-04, P2-B1, D6)', title: 'every building by the door: entry, reach and promptAtSpawn, spawnInsideProp, camera sweep, avatarFrame, capPx, poses, cost, Leave and exit', profiles: ['desktop'], run: survey },
};
