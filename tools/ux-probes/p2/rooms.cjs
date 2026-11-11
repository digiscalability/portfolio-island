'use strict';
// Phase-2 room probes, part 2 (P2-E1b), on p2/room-lib.cjs and p2/L.cjs. The
// interiors and lighting audits' scripts (a11y, phone-ctl, lighting,
// interior, avlum, warmtest, census) were session temp files and are gone, so
// these are rebuilt from the audits' reports
// (docs/history/2026-11-03-ux-audit/phase2/building.json and lighting,.json)
// and checked against the numbers they recorded on 58c8849. Rooms are entered
// the way a visitor enters them (room-lib's enterRoom).
//
//   npm run probe -- p2/room-a11y   [--listen 60] --dist dist --port <n>
//   npm run probe -- p2/room-phone  --dist dist --port <n>
//   npm run probe -- p2/room-light  [--hours 12,21,22] [--device desk|phone] --dist dist --port <n>
//   npm run probe -- p2/room-rig    [--hours 12,21] [--borrow] [--device desk|phone] --dist dist --port <n>
//   npm run probe -- p2/avlum       [--hours 12,22] [--device desk|phone] --dist dist --port <n>
//   npm run probe -- p2/warmtest    [--hours 12,21] [--device desk|phone] --dist dist --port <n>
//   npm run probe -- p2/room-census [--device desk|phone] --dist dist --port <n>
const path = require('path');
const fs = require('fs');
const lib = require('../lib.cjs');
const R = require('./room-lib.cjs');
const L = require('./L.cjs');

const HALLS = ['welcome', 'professional', 'projects', 'personal', 'contact'];
const BACK = [0, 1.6, Math.PI]; // the audits' back-wall pose
const FRONT = [0.6, -1.2, 0];
const numList = (v, dflt) => (v && v !== true ? String(v).split(',').map(Number).filter((x) => Number.isFinite(x)) : dflt);

const SET_HOUR = (h) => {
  const env = window.__app.scene.getEnvironmentCycle();
  if (!('debugHour' in env)) return null;
  env.debugHour = h;
  return true;
};
const INSIDE = () => window.__app.scene.isInsideInterior();
const OUT_LIGHTS = () => {
  let n = 0;
  window.__app.scene.traverseVisible((o) => {
    if (o.isLight) n++;
  });
  return n;
};

async function openRooms(t, prof, { hour = 12, init = [], warm = true } = {}) {
  const touch = lib.isTouchProfile(prof);
  const s = await t.session(prof, { init: [R.REWARD_INIT, ...init] });
  const { page } = s;
  const T = touch ? await lib.touch(s) : null;
  await t.boot(s, { query: `hour=${hour}` });
  await R.install(page);
  if (touch) await page.tap(`${lib.WELCOME} button[data-dismiss]`).catch(() => lib.dismissWelcome(page));
  else await lib.dismissWelcome(page);
  await page.waitForTimeout(1200);
  if (warm) await R.warm(page);
  await page.waitForTimeout(1500);
  return { s, page, touch, T };
}

/** Enter a room and wait until the visitor is inside (or 4 s). Returns enterRoom's record plus insideAt (page ms). */
async function goIn(page, id, o) {
  const e = await R.enterRoom(page, id, { back: 3.0, ...o });
  const t0 = Date.now();
  while (Date.now() - t0 < 4000 && !(await page.evaluate(INSIDE))) await lib.sleep(40);
  e.inside = await page.evaluate(INSIDE);
  e.insideAt = await page.evaluate(() => performance.now());
  return e;
}

const closePanels = (page) =>
  page.evaluate(() => {
    const a = window.__app;
    if (a.ui.panels && a.ui.panels.closeAll) a.ui.panels.closeAll();
  });
const pose = (page, p) => page.evaluate((q) => window.__ia.pose(q[0], q[1], q[2]), p);

// ---------------------------------------------------------------- room-a11y
const LEAVE = () => {
  const ui = window.__app.ui;
  const b = ui.leaveBtn || [...document.querySelectorAll('#ui-overlay div, #ui-overlay button')].find((d) => /←\s*Leave/.test(d.textContent || '') && d.children.length <= 1);
  if (!b || !b.isConnected) return null;
  const r = b.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return null;
  const name = (b.getAttribute('aria-label') || b.textContent || '').replace(/\s+/g, ' ').trim();
  // Every other visible HUD element whose box meets Leave's.
  const over = [];
  for (const el of document.querySelectorAll('#ui-overlay > *')) {
    if (el === b || el.contains(b) || b.contains(el)) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) < 0.05) continue;
    for (const k of el.children.length && cs.pointerEvents === 'none' ? [...el.children] : [el]) {
      const q = k.getBoundingClientRect();
      if (q.width < 2 || q.height < 2 || q.width >= innerWidth * 0.95) continue;
      const w = Math.min(r.right, q.right) - Math.max(r.left, q.left);
      const h = Math.min(r.bottom, q.bottom) - Math.max(r.top, q.top);
      if (w > 1 && h > 1) over.push(`${(k.getAttribute('aria-label') || k.textContent || k.tagName).replace(/\s+/g, ' ').trim().slice(0, 30)} ${Math.round(w)}x${Math.round(h)}`);
    }
  }
  return { tag: b.tagName, role: b.getAttribute('role'), tabIndex: b.tabIndex, name, focused: document.activeElement === b, w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x), y: Math.round(r.y), over };
};
const ACTIVE = () => {
  const ae = document.activeElement;
  if (!ae || ae === document.body) return 'BODY';
  return `${ae.tagName}${ae.id ? '#' + ae.id : ''} ${(ae.getAttribute('aria-label') || ae.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40)}`;
};
const LIVE = () =>
  [...document.querySelectorAll('[aria-live],[role=status],[role=alert],[role=log]')]
    .map((e) => ({ role: e.getAttribute('role'), live: e.getAttribute('aria-live'), text: (e.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 100) }))
    .filter((l) => l.text);
const MESSAGES = () => {
  const ui = window.__app.ui;
  const txt = (el) => {
    if (!el || !el.isConnected) return null;
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return cs.display !== 'none' && cs.visibility !== 'hidden' && parseFloat(cs.opacity) > 0.1 && r.width > 2 ? (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim() : null;
  };
  return { toast: txt(ui.toastEl), flash: txt(ui.flashEl), compass: txt(ui.compassDiv), prompt: txt(ui.interactionDiv), inside: window.__app.scene.isInsideInterior() };
};
const OUTDOOR_HINT = /villager nearby|talks through|Lost\?|gold arrow|Coins!|coins? to collect|Secret found|radar|press M\b|compass points/i;

async function roomA11y(t) {
  const listenS = Number(t.args.listen || 60);
  for (const prof of t.profiles(['desktop'])) {
    const { page, touch, T } = await openRooms(t, prof);
    const out = {};
    // A cottage: E within a second of the room showing.
    const c = await goIn(page, 'house_0', { touch, T });
    await page.waitForTimeout(700);
    await page.keyboard.press('KeyE');
    await page.waitForTimeout(1500);
    out.eAfterEntry = { press: c.press, insideAfterEntry: c.inside, insideAfterE: await page.evaluate(INSIDE) };
    t.check(`${prof}: E 0.7 s after entering a cottage keeps the visitor inside`, c.inside ? out.eAfterEntry.insideAfterE : null, out.eAfterEntry, 'inside');
    // Out by the door: walk at it, E at its prompt.
    if (!(await page.evaluate(INSIDE))) await goIn(page, 'house_0', { touch, T });
    await page.evaluate(() => {
      const d = window.__app.scene.constructor.INTERIOR_DOOR_HOTSPOT || { x: -1.8, z: 3.3 };
      window.__ia.pose(d.x, d.z - 2.4, 0);
    });
    await page.waitForTimeout(300);
    await page.keyboard.down('KeyW');
    let doorPrompt = '';
    for (let i = 0; i < 40; i++) {
      await page.waitForTimeout(80);
      doorPrompt = (await page.evaluate(() => (window.__app.scene.getInteriorHotspot() || {}).label || '')) || '';
      if (/outside|leave/i.test(doorPrompt)) break;
    }
    await page.keyboard.up('KeyW');
    await page.keyboard.press('KeyE');
    await page.waitForTimeout(1000);
    out.byTheDoor = { prompt: doorPrompt.replace(/<[^>]+>/g, ''), insideAfter: await page.evaluate(INSIDE) };
    t.check(`${prof}: walking to the door and pressing E puts the visitor outside within 1 s`, /outside|leave/i.test(doorPrompt) ? !out.byTheDoor.insideAfter : null, out.byTheDoor, 'outside');
    await R.outdoors(page);

    // The Professional hall: its panel opens on entry.
    const h = await goIn(page, 'professional', { touch, T });
    await page.waitForTimeout(2200);
    out.hall = { press: h.press, inside: h.inside, panel: await page.evaluate(() => window.__app.ui.panels.current()), active: await page.evaluate(ACTIVE), live: await page.evaluate(LIVE) };
    await t.shot(page, `room-a11y-${prof}-hall-entered.png`);
    const panelOpen = !!out.hall.panel;
    const st0 = await page.evaluate(() => window.__ia.state().player);
    await page.keyboard.down('KeyW');
    await page.waitForTimeout(1000);
    await page.keyboard.up('KeyW');
    const st1 = await page.evaluate(() => window.__ia.state().player);
    out.wBehindPanel = { movedU: +Math.hypot(st1[0] - st0[0], st1[2] - st0[2]).toFixed(2) };
    t.check(`${prof}: W held 1 s behind the hall panel moves the room avatar (u)`, panelOpen ? out.wBehindPanel.movedU <= 0.05 : null, panelOpen ? out.wBehindPanel.movedU : 'no panel opened', '0');
    await page.keyboard.press('KeyE');
    await page.waitForTimeout(1200);
    out.eBehindPanel = { inside: await page.evaluate(INSIDE), panel: await page.evaluate(() => window.__app.ui.panels.current()) };
    t.check(`${prof}: E behind the hall panel keeps the visitor inside with the panel open`, panelOpen ? out.eBehindPanel.inside && out.eBehindPanel.panel === out.hall.panel : null, out.eBehindPanel, `inside, panel '${out.hall.panel}'`);
    if (!out.eBehindPanel.inside) {
      await goIn(page, 'professional', { touch, T });
      await page.waitForTimeout(2200);
    }
    // A Tab walk with the panel open (reported).
    const walk = [];
    for (let i = 0; i < 16; i++) {
      await page.keyboard.press('Tab');
      walk.push(await page.evaluate(ACTIVE));
    }
    out.tabWalkPanelOpen = { stops: walk, leaveAt: walk.findIndex((x) => /Leave/.test(x)) + 1 || null };
    await page.keyboard.press('Escape');
    await page.waitForTimeout(700);
    out.escapeOnce = { inside: await page.evaluate(INSIDE), panel: await page.evaluate(() => window.__app.ui.panels.current()) };
    t.check(`${prof}: Escape once closes the hall panel and keeps the visitor inside`, out.escapeOnce.inside && !out.escapeOnce.panel, out.escapeOnce, 'inside, no panel');
    if (!out.escapeOnce.inside) {
      await goIn(page, 'professional', { touch, T });
      await page.waitForTimeout(1500);
    }
    await closePanels(page);
    await page.waitForTimeout(300);
    // Leave: a button with a name, reachable by Tab, clear of the HUD.
    await page.evaluate(() => {
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    });
    const leave0 = await page.evaluate(LEAVE);
    out.leave = leave0;
    t.check(`${prof}: Leave is a button with a name`, leave0 ? (leave0.tag === 'BUTTON' || leave0.role === 'button') && leave0.tabIndex >= 0 && /leave/i.test(leave0.name) : false, leave0 ? { tag: leave0.tag, role: leave0.role, tabIndex: leave0.tabIndex, name: leave0.name } : 'no Leave control', 'BUTTON, tabIndex >= 0, named Leave');
    let reached = null;
    const tabs = [];
    for (let i = 1; i <= 3 && reached === null; i++) {
      await page.keyboard.press('Tab');
      tabs.push(await page.evaluate(ACTIVE));
      const l = await page.evaluate(LEAVE);
      if (l && l.focused) reached = i;
    }
    out.tabToLeave = { reached, stops: tabs };
    t.check(`${prof}: Tab reaches Leave within 3 presses once the panel is closed`, reached !== null, reached === null ? tabs : reached, '<= 3');
    t.check(`${prof}: Leave overlaps no visible HUD element`, leave0 ? leave0.over.length === 0 : null, leave0 ? (leave0.over.length ? leave0.over : 'none') : 'no Leave control', 'none');
    // A region that says where the visitor now is (the hall's name, or 'inside'), not the compass or the guide card.
    const said = out.hall.live.filter((l) => /Professional|inside|indoors|entered|\broom\b/i.test(l.text));
    t.check(`${prof}: a live region announces the room`, said.length >= 1, said.length ? said.slice(0, 2) : out.hall.live.length ? `none names the room: ${out.hall.live.map((l) => l.text.slice(0, 40)).join(' | ')}` : 'no live region with text', 'a region naming the room');
    // axe on the room.
    try {
      await page.addScriptTag({ content: lib.axeSource() });
      out.axe = await page.evaluate(async () => {
        const r = await window.axe.run(document, { resultTypes: ['violations'], runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'] } });
        return r.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length }));
      });
      t.check(`${prof}: axe violations inside the room`, out.axe.length === 0, out.axe.length ? out.axe : 0, 0);
    } catch (e) {
      out.axe = { error: String(e).slice(0, 120) };
    }
    // Q inside must not wave once outside; then a listener for outdoor messages.
    await page.keyboard.press('KeyQ');
    const seen = new Set();
    let compassShown = 0;
    let samples = 0;
    const end = Date.now() + listenS * 1000;
    while (Date.now() < end) {
      const m = await page.evaluate(MESSAGES).catch(() => null);
      if (m && m.inside) {
        samples++;
        for (const k of ['toast', 'flash']) if (m[k]) seen.add(`${k}: ${m[k].slice(0, 90)}`);
        if (m.compass) compassShown++;
      }
      await lib.sleep(500);
    }
    out.listen = { seconds: listenS, samples, messages: [...seen], compassShownSamples: compassShown };
    const hints = [...seen].filter((x) => OUTDOOR_HINT.test(x));
    t.check(`${prof}: outdoor hints inside the room over ${listenS} s`, samples > 0 ? hints.length === 0 : null, hints.length ? hints : 'none', 'none');
    t.check(`${prof}: the compass pill inside the room over ${listenS} s (samples showing it)`, samples > 0 ? compassShown === 0 : null, `${compassShown} of ${samples}`, '0');
    await t.shot(page, `room-a11y-${prof}-hall-idle.png`);
    // Escape with no panel open: out within a second.
    await page.keyboard.press('Escape');
    await page.waitForTimeout(1000);
    out.escapeTwice = { inside: await page.evaluate(INSIDE) };
    t.check(`${prof}: a second Escape (no panel open) puts the visitor outside within 1 s`, !out.escapeTwice.inside, out.escapeTwice, 'outside');
    if (out.escapeTwice.inside) await R.outdoors(page);
    await page.waitForTimeout(400);
    out.waveAfterExit = await page.evaluate(() => {
      const p = window.__app.scene.getPlayer();
      return typeof p.waveTime === 'number' ? +p.waveTime.toFixed(2) : null;
    });
    t.check(`${prof}: Q pressed inside does not wave after the exit`, out.waveAfterExit === null ? null : out.waveAfterExit === 0, out.waveAfterExit, '0 s of wave left');
    t.data[prof] = out;
  }
}

// --------------------------------------------------------------- room-phone
const TOUCH_CONTROLS = () => {
  const vis = (el) => {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4 || r.right < 0 || r.bottom < 0 || r.left > innerWidth || r.top > innerHeight) return false;
    for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) < 0.06) return false;
    }
    return true;
  };
  const all = [...document.querySelectorAll('#ui-overlay div')];
  const disc = (cap) => all.find((d) => d.style.width === '74px' && new RegExp(cap).test(d.textContent || ''));
  const joy = document.querySelector('[data-guide="joystick"]') || all.find((d) => d.style.touchAction === 'none' && d.style.width === '166px');
  const one = (txt) => all.find((d) => (d.textContent || '').trim() === txt && d.children.length === 0);
  const ui = window.__app.ui;
  const leave = ui.leaveBtn || [...document.querySelectorAll('#ui-overlay div, #ui-overlay button')].find((d) => /←\s*Leave/.test(d.textContent || '') && d.children.length <= 1);
  const lr = leave && leave.isConnected ? leave.getBoundingClientRect() : null;
  return {
    USE: vis(document.querySelector('[data-guide="use-button"]') || disc('USE')),
    JUMP: vis(disc('JUMP')),
    WAVE: vis(disc('WAVE')),
    joystick: vis(joy),
    chat: vis(one('💬')),
    mic: vis(one('🎤')),
    drawerToggle: vis(document.querySelector('[aria-label="Open island menu"]')),
    leave: vis(leave),
    leaveSize: lr ? [Math.round(lr.width), Math.round(lr.height)] : null,
    emote: vis(one('😀')),
  };
};

async function roomPhone(t) {
  for (const prof of t.profiles(['phone'])) {
    const { page, touch, T } = await openRooms(t, prof);
    if (!touch) throw new lib.HarnessError('p2/room-phone needs a touch profile (--device phone)');
    const out = { outdoors: await page.evaluate(TOUCH_CONTROLS) };
    const c = await goIn(page, 'house_0', { touch, T });
    await page.waitForTimeout(600);
    const u = await T.useBtn();
    if (u) await T.tap(u[0], u[1]);
    await page.waitForTimeout(1500);
    out.useAfterEntry = { press: c.press, insideAfterEntry: c.inside, insideAfterUse: await page.evaluate(INSIDE) };
    t.check(`${prof}: a USE tap 0.6 s after entering keeps the visitor inside`, c.inside ? out.useAfterEntry.insideAfterUse : null, out.useAfterEntry, 'inside');
    if (!(await page.evaluate(INSIDE))) await goIn(page, 'house_0', { touch, T });
    await page.waitForTimeout(800);
    out.inside = await page.evaluate(TOUCH_CONTROLS);
    await t.shot(page, `room-phone-${prof}-inside.png`);
    const k = out.inside;
    t.check(`${prof}: inside, JUMP and WAVE are off screen`, !k.JUMP && !k.WAVE, { JUMP: k.JUMP, WAVE: k.WAVE }, 'both hidden');
    t.check(`${prof}: inside, USE, the joystick, chat and mic stay`, k.USE && k.joystick && k.chat && k.mic, { USE: k.USE, joystick: k.joystick, chat: k.chat, mic: k.mic }, 'all visible');
    t.check(`${prof}: inside, Leave and the drawer toggle stay`, k.leave && k.drawerToggle, { leave: k.leave, drawerToggle: k.drawerToggle }, 'both visible');
    t.check(`${prof}: Leave is a 44 px target`, k.leaveSize ? k.leaveSize[0] >= 44 && k.leaveSize[1] >= 44 : null, k.leaveSize || 'no Leave control', '>= 44 x 44');
    const lv = await page.evaluate(LEAVE);
    out.leave = lv;
    t.check(`${prof}: Leave overlaps no visible HUD element`, lv ? lv.over.length === 0 : null, lv ? (lv.over.length ? lv.over : 'none') : 'no Leave control', 'none');
    // The joystick walks the room.
    const p0 = await page.evaluate(() => window.__ia.state().player);
    await T.joyHold(0, -50, 1200);
    const p1 = await page.evaluate(() => window.__ia.state().player);
    out.joystick = { movedU: +Math.hypot(p1[0] - p0[0], p1[2] - p0[2]).toFixed(2) };
    t.check(`${prof}: the joystick walks the room (u in 1.2 s)`, out.joystick.movedU >= 0.8, out.joystick.movedU, '>= 0.8');
    // Out by Leave.
    if (lv) {
      await T.tap(lv.x + lv.w / 2, lv.y + lv.h / 2);
      await page.waitForTimeout(1500);
    }
    out.leaveTap = { inside: await page.evaluate(INSIDE) };
    t.check(`${prof}: a tap on Leave puts the visitor outside within 1.5 s`, lv ? !out.leaveTap.inside : null, out.leaveTap, 'outside');
    t.data[prof] = out;
  }
}

// --------------------------------------------------------------- room-light
async function roomLight(t) {
  const hours = numList(t.args.hours, [12, 21, 22]);
  const rooms = t.args.ids && t.args.ids !== true ? String(t.args.ids).split(',') : ['house_0', 'professional'];
  for (const prof of t.profiles(['desktop', 'phone'])) {
    const { page, touch, T } = await openRooms(t, prof);
    const out = {};
    for (const h of hours) {
      await R.outdoors(page);
      if ((await page.evaluate(SET_HOUR, h)) === null) throw new Error('hook missing: EnvironmentCycle.debugHour');
      await page.waitForTimeout(1800);
      const outdoorLights = await page.evaluate(OUT_LIGHTS);
      for (const id of rooms) {
        const row = { outdoorLights };
        await R.outdoors(page); // out of the room before, or its door would never be reached
        const e = await goIn(page, id, { touch, T });
        await page.waitForTimeout(2200);
        if (!e.inside) {
          out[`h${h}-${id}`] = { error: `not inside (${e.press})` };
          continue;
        }
        await closePanels(page);
        await pose(page, BACK);
        await page.waitForTimeout(600);
        row.lights = await page.evaluate(() => window.__ia.lights());
        row.state = await page.evaluate(() => {
          const s = window.__ia.state();
          return { theme: s.theme, lamp: s.lamp, roomLamp: s.roomLamp, fill: s.fill, hour: s.hour };
        });
        const regions = { all: [0, 0, 1, 1], wall: [0.25, 0.12, 0.75, 0.55] };
        row.lampOn = await page.evaluate((r) => window.__ia.lum(r), regions);
        await t.shot(page, `room-light-${prof}-h${h}-${id}-lamp-on.png`);
        await page.evaluate(() => window.__app.scene.toggleInteriorFixture('lamp'));
        await page.waitForTimeout(1800);
        row.lampOff = await page.evaluate((r) => window.__ia.lum(r), regions);
        await t.shot(page, `room-light-${prof}-h${h}-${id}-lamp-off.png`);
        await page.evaluate(() => window.__app.scene.toggleInteriorFixture('lamp'));
        await page.waitForTimeout(1500);
        // The front wall: the window pane and the curtains.
        await pose(page, FRONT);
        await page.waitForTimeout(600);
        const win = await page.evaluate(() => window.__ia.windowRegion());
        const fr = win ? { all: [0, 0, 1, 1], window: win } : { all: [0, 0, 1, 1] };
        row.front = await page.evaluate((r) => window.__ia.lum(r), fr);
        row.windowRegion = win;
        await t.shot(page, `room-light-${prof}-h${h}-${id}-front.png`);
        await page.evaluate(() => window.__app.scene.toggleInteriorFixture('curtains'));
        await page.waitForTimeout(1500);
        row.curtainsShut = await page.evaluate((r) => window.__ia.lum(r), fr);
        await page.evaluate(() => window.__app.scene.toggleInteriorFixture('curtains'));
        await page.waitForTimeout(600);
        row.lampDeltaL = +(row.lampOff.all.L - row.lampOn.all.L).toFixed(1);
        row.wallRB = row.lampOn.wall.rgb[2] ? +(row.lampOn.wall.rgb[0] / row.lampOn.wall.rgb[2]).toFixed(2) : null;
        out[`h${h}-${id}`] = row;
        t.log(`${prof} ${h} h ${id}: lamp on ${row.lampOn.all.L}, off ${row.lampOff.all.L}, window ${row.front.window ? row.front.window.L : '-'}, lights in ${row.lights.n} / out ${outdoorLights}, wall R/B ${row.wallRB}`);
      }
    }
    await R.outdoors(page);
    await page.evaluate(SET_HOUR, null);
    t.data[prof] = out;
    const ok = (k) => out[k] && !out[k].error;
    const night = hours.filter((h) => h >= 20 || h < 5);
    for (const id of rooms) {
      if (hours.includes(12) && hours.includes(21) && ok(`h12-${id}`) && ok(`h21-${id}`)) {
        const d = +(out[`h21-${id}`].lampOn.all.L - out[`h12-${id}`].lampOn.all.L).toFixed(1);
        t.check(`${prof}: ${id}, lamp on, 21 h against 12 h (room L*)`, Math.abs(d) <= 3, `${d} (${out[`h12-${id}`].lampOn.all.L} at 12 h, ${out[`h21-${id}`].lampOn.all.L} at 21 h)`, 'within +-3');
      }
      for (const h of hours.filter((x) => x === 12 || x === 21)) if (ok(`h${h}-${id}`)) t.check(`${prof}: ${id} at ${h} h, lamp off against lamp on (room L*)`, out[`h${h}-${id}`].lampDeltaL <= -12, out[`h${h}-${id}`].lampDeltaL, '<= -12');
      for (const h of hours) if (ok(`h${h}-${id}`)) t.check(`${prof}: ${id} at ${h} h, visible lights indoors against outdoors`, out[`h${h}-${id}`].lights.n === out[`h${h}-${id}`].outdoorLights, { indoors: out[`h${h}-${id}`].lights.n, outdoors: out[`h${h}-${id}`].outdoorLights, byType: out[`h${h}-${id}`].lights.byType }, 'equal');
    }
    const wn = night.length ? night[night.length - 1] : null;
    const cot = rooms[0];
    if (hours.includes(12) && wn !== null && ok(`h12-${cot}`) && ok(`h${wn}-${cot}`)) {
      const a = out[`h12-${cot}`].front.window;
      const b = out[`h${wn}-${cot}`].front.window;
      t.check(`${prof}: the window pane follows the hour (${cot}: L* at 12 h minus at ${wn} h)`, a && b ? a.L - b.L >= 15 : null, a && b ? `${+(a.L - b.L).toFixed(1)} (${a.L} vs ${b.L})` : 'the pane is not in the front view', '>= 15');
      t.check(`${prof}: a warm room at night (${cot} at ${wn} h, back wall R/B)`, out[`h${wn}-${cot}`].wallRB !== null ? out[`h${wn}-${cot}`].wallRB >= 1.15 : null, out[`h${wn}-${cot}`].wallRB, '>= 1.15');
    }
  }
}

// ----------------------------------------------------------------- room-rig
/** One frame with some lights dark (the loop stopped around it), read back, then restored. */
const RIG_VARIANT = ({ which, regions }) => {
  const sc = window.__app.scene;
  const sr = window.__app.renderer;
  const own = new Set([sc.interiorLamp, sc.interiorRoomLamp, sc.interiorRoomFill, sc.interiorFire].filter(Boolean));
  const inRoom = (o) => {
    for (let p = o; p; p = p.parent) if (p === sc.interiorGroup) return true;
    return false;
  };
  const saved = [];
  sc.traverse((o) => {
    if (!o.isLight) return;
    const room = own.has(o) || inRoom(o);
    if ((which === 'no-outdoor' && !room) || (which === 'no-room' && room)) {
      saved.push([o, o.intensity]);
      o.intensity = 0;
    }
  });
  sr.stopRenderLoop();
  const px = window.__ia.lumNow(regions);
  for (const [o, i] of saved) o.intensity = i;
  sr.isRunning = false;
  sr.startRenderLoop(sr.scene, sr.camera, sr.renderCallback);
  return { L: px && px.all ? px.all.L : null, zeroed: saved.length };
};

async function roomRig(t) {
  const hours = numList(t.args.hours, [12, 21]);
  const ids = t.args.ids && t.args.ids !== true ? String(t.args.ids).split(',') : HALLS;
  for (const prof of t.profiles(['desktop', 'phone'])) {
    const { page, touch, T } = await openRooms(t, prof);
    const out = {};
    for (const h of hours) {
      await R.outdoors(page);
      await page.evaluate(SET_HOUR, h);
      await page.waitForTimeout(1800);
      const outdoorLights = await page.evaluate(OUT_LIGHTS);
      for (const id of ids) {
        const e = await goIn(page, id, { touch, T });
        await page.waitForTimeout(2000);
        if (!e.inside) {
          out[`h${h}-${id}`] = { error: `not inside (${e.press})` };
          await R.outdoors(page);
          continue;
        }
        await closePanels(page);
        await pose(page, BACK);
        await page.waitForTimeout(600);
        const regions = { all: [0, 0, 1, 1] };
        const row = { outdoorLights, lights: await page.evaluate(() => window.__ia.lights()), programs: await R.programs(page) };
        row.L = (await page.evaluate((r) => window.__ia.lum(r), regions)).all.L;
        // The room without the outdoor rig (what the frozen sun, hemisphere, fill and rim add through the walls).
        row.noOutdoor = await page.evaluate(RIG_VARIANT, { which: 'no-outdoor', regions });
        row.outdoorShareL = row.noOutdoor.L === null ? null : +(row.L - row.noOutdoor.L).toFixed(1);
        // --borrow: the room lit by the outdoor rig alone (its own lights dark).
        if (t.args.borrow) row.borrowedOnly = await page.evaluate(RIG_VARIANT, { which: 'no-room', regions });
        if (id === ids[0]) await t.shot(page, `room-rig-${prof}-h${h}-${id}.png`);
        out[`h${h}-${id}`] = row;
        t.log(`${prof} ${h} h ${id}: L* ${row.L}, without the outdoor rig ${row.noOutdoor.L}, lights in ${row.lights.n} (${JSON.stringify(row.lights.byType)}) / out ${outdoorLights}, programs ${row.programs}`);
        await R.outdoors(page);
      }
    }
    await page.evaluate(SET_HOUR, null);
    t.data[prof] = out;
    const ok = (k) => out[k] && !out[k].error;
    if (hours.includes(12) && hours.includes(21)) {
      const rows = ids.filter((id) => ok(`h12-${id}`) && ok(`h21-${id}`)).map((id) => [id, +(out[`h21-${id}`].L - out[`h12-${id}`].L).toFixed(1)]);
      const worst = rows.sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))[0];
      t.check(`${prof}: lamp-on room L*, 21 h against 12 h (worst of ${rows.length} halls)`, worst ? Math.abs(worst[1]) <= 3 : null, worst ? `${worst[1]} in ${worst[0]} (${rows.map((r) => `${r[0]} ${r[1]}`).join(', ')})` : 'no hall entered', 'within +-3');
    }
    for (const h of hours) {
      const bad = ids.filter((id) => ok(`h${h}-${id}`) && out[`h${h}-${id}`].lights.n !== out[`h${h}-${id}`].outdoorLights).map((id) => `${id} ${out[`h${h}-${id}`].lights.n}`);
      const any = ids.find((id) => ok(`h${h}-${id}`));
      t.check(`${prof}: visible lights indoors at ${h} h against outdoors (${any ? out[`h${h}-${any}`].outdoorLights : '?'})`, any ? bad.length === 0 : null, bad.length ? bad : 'equal in every hall', 'equal');
    }
    t.check(`${prof}: every hall entered`, Object.values(out).every((r) => !r.error), Object.entries(out).filter(([, r]) => r.error).map(([k, r]) => `${k}: ${r.error}`), 'all');
  }
}

// -------------------------------------------------------------------- avlum
async function avlum(t) {
  const hours = numList(t.args.hours, [12, 22]);
  const id = t.args.ids && t.args.ids !== true ? String(t.args.ids).split(',')[0] : 'house_0';
  for (const prof of t.profiles(['desktop', 'phone'])) {
    const { page, touch, T } = await openRooms(t, prof);
    await page.evaluate(L.installHelpers);
    const out = {};
    for (const h of hours) {
      await R.outdoors(page);
      await page.evaluate(SET_HOUR, h);
      await page.waitForTimeout(1800);
      const e = await goIn(page, id, { touch, T });
      await page.waitForTimeout(2000);
      if (!e.inside) {
        out[`h${h}`] = { error: `not inside (${e.press})` };
        continue;
      }
      await closePanels(page);
      await pose(page, BACK);
      await page.waitForTimeout(600);
      const stem = path.join(t.out, `avlum-${prof}-h${h}`);
      const pair = await L.capturePair(page, stem, { hideUi: true });
      // 'Around' is the band right beside the avatar (a fifth of its height wide).
      const st = L.frameStats(pair.a, pair.m, { ringPad: 0.2 });
      fs.rmSync(pair.m, { force: true });
      t.data.frames = [...(t.data.frames || []), pair.a];
      out[`h${h}`] = st.player ? { avatarL: st.player.Lstar, aroundL: st.player.ringLstar, dL: st.player.dL, roomL: st.frameLstar, playerShare: (st.cats.player || {}).frac } : { error: 'no avatar pixels in the frame' };
      t.log(`${prof} ${h} h: ${JSON.stringify(out[`h${h}`])}`);
    }
    await R.outdoors(page);
    await page.evaluate(SET_HOUR, null);
    t.data[prof] = out;
    for (const h of hours) {
      const r = out[`h${h}`];
      const nightBar = h >= 20 || h < 5;
      // P2-B9: at night the avatar reads against the room, 5 L* or more above it.
      t.check(`${prof}: the avatar against the room around it at ${h} h (L*)`, r.error ? null : nightBar ? r.dL >= 5 : true, r.error || `${r.dL} (avatar ${r.avatarL}, around ${r.aroundL})`, nightBar ? '>= +5' : 'reported');
    }
  }
}

// ----------------------------------------------------------------- warmtest
// Before any page script: wrap scene.warmInterior as soon as the app exists,
// to stamp the warm's start and end and the programs on either side.
const WARM_INIT = `(() => {
  if (window.top !== window) return;
  const W = (window.__warm = { runs: [], wrapped: false });
  const progs = () => window.__app.renderer.getRenderer().info.programs.length;
  const iv = setInterval(() => {
    const sc = window.__app && window.__app.scene;
    if (!sc || typeof sc.warmInterior !== 'function' || !window.__app.renderer || !window.__app.renderer.getRenderer) return;
    clearInterval(iv);
    const orig = sc.warmInterior;
    sc.warmInterior = function () {
      const row = { t0: performance.now(), p0: progs(), t1: null, p1: null, already: !!sc.interiorWarmed };
      W.runs.push(row);
      const r = orig.apply(this, arguments);
      Promise.resolve(r).then(() => { row.t1 = performance.now(); row.p1 = progs(); }, () => { row.t1 = performance.now(); row.p1 = progs(); row.rejected = true; });
      return r;
    };
    W.wrapped = true;
  }, 4);
})();`;

async function warmtest(t) {
  const hours = numList(t.args.hours, [12, 21]);
  for (const prof of t.profiles(['desktop', 'phone'])) {
    const rows = {};
    for (const h of hours) {
      const s = await t.freshSession(prof, { init: [R.LONGTASKS_INIT, R.WELCOME_MARK_INIT, WARM_INIT] });
      const { page } = s;
      const row = { hour: h };
      try {
        await t.boot(s, { query: `hour=${h}` });
        await page.click(`${lib.WELCOME} button[data-dismiss]`).catch(() => {});
        // The app's own idle warm, or the probe's call if it has not come by 12 s.
        const t0 = Date.now();
        let run = null;
        while (Date.now() - t0 < 26000) {
          run = await page.evaluate(() => (window.__warm ? window.__warm.runs.find((r) => !r.already) || null : null));
          if (run && run.t1 !== null) break;
          if (!run && Date.now() - t0 > 12000 && !row.forced) {
            row.forced = true;
            await page.evaluate(() => {
              window.__app.scene.warmInterior();
            });
          }
          await lib.sleep(250);
        }
        await page.waitForTimeout(1500);
        const after = await page.evaluate(() => ({ programs: window.__app.renderer.getRenderer().info.programs.length, warmed: !!window.__app.scene.interiorWarmed, wrapped: window.__warm.wrapped, cardAt: window.__welcomeAt }));
        if (!run || run.t1 === null) throw new Error(run ? 'the warm did not finish within 26 s' : `the warm never started (wrapped ${after.wrapped})`);
        const lt = await page.evaluate(([a, b]) => {
          const X = window.__lt || { longtasks: [], loaf: [], gaps: [] };
          const within = (arr) => arr.filter(([st, d]) => st + d >= a && st <= b).map((e) => e[1]);
          return { longtasks: within(X.longtasks), loaf: within(X.loaf), gaps: within(X.gaps) };
        }, [run.t0 - 20, run.t1 + 1200]);
        Object.assign(row, {
          source: row.forced ? 'forced by the probe' : 'the idle warm',
          startedAfterCardMs: after.cardAt !== null ? Math.round(run.t0 - after.cardAt) : null,
          warmMs: Math.round(run.t1 - run.t0),
          programsBefore: run.p0,
          programsAtEnd: run.p1,
          programsSettled: after.programs,
          programsAdded: after.programs - run.p0,
          longestMs: Math.max(0, ...lt.longtasks, ...lt.loaf, ...lt.gaps),
          longTasks: lt.longtasks,
          frameGaps: lt.gaps,
          warmed: after.warmed,
        });
      } catch (e) {
        row.error = String((e && e.message) || e).slice(0, 200);
      }
      rows[`h${h}`] = row;
      t.log(`${prof} ${h} h: ${JSON.stringify(row)}`);
      await s.close();
      const night = h >= 20 || h < 5;
      t.check(`${prof} at ${h} h: programs the interior warm adds`, row.error ? null : row.programsAdded <= 5, row.error || row.programsAdded, '<= 5');
      t.check(`${prof} at ${h} h: the longest task in the warm's window (ms)`, row.error ? null : row.longestMs < (night ? 350 : 100), row.error || row.longestMs, night ? '< 350' : '< 100');
    }
    t.data[prof] = rows;
  }
}

// -------------------------------------------------------------- room-census
const ROOM_CENSUS = () => {
  const sc = window.__app.scene;
  const g = sc.interiorGroup;
  if (!g) return null;
  const LIT = new Set(['MeshStandardMaterial', 'MeshPhysicalMaterial', 'MeshLambertMaterial', 'MeshPhongMaterial']);
  const posters = new Set((sc.interiorPosters || []).map((p) => p.tex));
  const party = sc.partyProps ? sc.partyProps.group : null;
  const under = (o, root) => {
    for (let p = o; p; p = p.parent) if (p === root) return true;
    return false;
  };
  const sets = sc.interiorSets || {};
  const where = (o) => {
    for (const [name, set] of Object.entries(sets)) if (under(o, set)) return name;
    return party && under(o, party) ? 'party' : 'shell';
  };
  const out = {};
  const row = (k) => (out[k] = out[k] || { meshes: 0, byType: {}, toonNoRamp: 0, notToon: 0, notToonAllowed: 0, notToonSamples: [], hulls: 0, casters: 0 });
  g.traverse((o) => {
    if (!o.isMesh) return;
    const r = row(where(o));
    if (o.userData && o.userData.isCelHull) {
      r.hulls++;
      return;
    }
    r.meshes++;
    if (o.castShadow) r.casters++;
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      if (!m) continue;
      r.byType[m.type] = (r.byType[m.type] || 0) + 1;
      if (m.type === 'MeshToonMaterial' && !m.gradientMap) r.toonNoRamp++;
      if (!LIT.has(m.type)) continue;
      // The pane, the posters and the party's tiles may stay off the toon model.
      const allowed = m === sc.interiorWindowMat || (m.map && posters.has(m.map)) || (party && under(o, party));
      if (allowed) r.notToonAllowed++;
      else {
        r.notToon++;
        if (r.notToonSamples.length < 4) r.notToonSamples.push(`${m.type} ${m.color ? '#' + m.color.getHexString() : ''} ${o.geometry ? o.geometry.type : ''}`.trim());
      }
    }
  });
  return out;
};

async function roomCensus(t) {
  for (const prof of t.profiles(['desktop', 'phone'])) {
    const { page, touch, T } = await openRooms(t, prof);
    // The party props are built on the first beach-house visit: go there once.
    const e = await goIn(page, 'islet_beach_house', { touch, T });
    await page.waitForTimeout(2500);
    await R.outdoors(page);
    const c = await page.evaluate(ROOM_CENSUS);
    if (!c) throw new Error('hook missing: scene.interiorGroup');
    t.data[prof] = { beachHouse: { press: e.press, inside: e.inside }, census: c };
    const themes = Object.keys(c).filter((k) => k !== 'shell' && k !== 'party');
    const total = Object.values(c).reduce((n, r) => n + r.meshes, 0);
    const off = Object.entries(c).filter(([, r]) => r.notToon > 0);
    t.log(`${prof}: ${total} meshes; ${Object.entries(c).map(([k, r]) => `${k} ${r.meshes} (${Object.entries(r.byType).map(([ty, n]) => `${ty.replace('Mesh', '').replace('Material', '')} ${n}`).join(', ')}; hulls ${r.hulls})`).join('; ')}`);
    t.check(`${prof}: the 7 room sets are built`, themes.length >= 7, themes, '7 themes');
    t.check(`${prof}: lit materials off the toon model, outside the pane, the posters and the party`, off.length === 0, off.length ? Object.fromEntries(off.map(([k, r]) => [k, `${r.notToon} (${r.notToonSamples[0]})`])) : 0, 0);
    const hullsBy = themes.map((k) => [k, c[k].hulls]);
    if (prof === 'desktop') t.check(`${prof}: every room set has ink hulls`, hullsBy.every(([, n]) => n > 0), Object.fromEntries(hullsBy), '> 0 in each');
    else t.check(`${prof}: no ink hulls on the low tier`, hullsBy.every(([, n]) => n === 0) && (c.shell ? c.shell.hulls === 0 : true), Object.fromEntries(hullsBy), '0 in each');
  }
}

module.exports = {
  'room-a11y': { item: 'P2-E1b (INT-03, INT-07, INT-11; P2-A1, P2-D2)', title: 'inside a room on a keyboard: E after entry and behind the panel, Escape once and twice, Tab to Leave, Leave against the HUD, live regions, axe, a 60 s listener for outdoor hints', profiles: ['desktop'], run: roomA11y },
  'room-phone': { item: 'P2-E1b (INT-12, INT-03; P2-A1, P2-D2)', title: 'inside a room on a phone: USE after entry, which touch controls stay, Leave as a target, the joystick, out by Leave', profiles: ['phone'], run: roomPhone },
  'room-light': { item: 'P2-E1b (INT-09, LT-04; P2-B9)', title: 'a cottage and the Professional hall at 12, 21 and 22 h: room L* with the lamp on and off, the window pane, the curtains, lights indoors against outdoors', profiles: ['desktop', 'phone'], run: roomLight },
  'room-rig': { item: 'P2-E1b (LT-04; P2-B9)', title: 'the five halls at 12 and 21 h: room L*, the share the outdoor rig adds, visible lights and programs inside (--borrow: the room on the outdoor rig alone)', profiles: ['desktop', 'phone'], run: roomRig },
  avlum: { item: 'P2-E1b (INT-09; P2-B9)', title: "the avatar's L* against the room around it at 12 and 22 h, by mask", profiles: ['desktop', 'phone'], run: avlum },
  warmtest: { item: 'P2-E1b (LT-04; P2-B9)', title: 'the interior warm, cold in a fresh browser at 12 and 21 h: programs added and the longest task in its window', profiles: ['desktop', 'phone'], run: warmtest },
  'room-census': { item: 'P2-E1b (INT-06; P2-B10)', title: 'the room sets by material type: lit materials off the toon model, ink hulls, shadow casters', profiles: ['desktop', 'phone'], run: roomCensus },
};
