'use strict';
// Phase-2 guidance probes, part 2 (P2-E2b), on p2/guide-lib.cjs: recruiter,
// npcs and copy. The guidance audit's scripts (recruiter, npcs, copyprobe)
// were session temp files and are gone, so these are rebuilt from its report
// (docs/history/2026-11-03-ux-audit/phase2/a.json: GD-02, GD-05, GD-08,
// GD-12) and checked against the numbers it recorded on 58c8849. The backend
// stays blocked, so every villager reply is the written fallback.
//
//   npm run probe -- p2/recruiter [--scenario card,deeplink,tour] [--listen 60] [--device desk|phone] --dist dist --port <n>
//   npm run probe -- p2/npcs      [--hours 10.5,18,21,23,2,6] [--no-sailor] [--device desk|phone] --dist dist --port <n>
//   npm run probe -- p2/copy      [--device desk|phone] --dist dist --port <n>
const lib = require('../lib.cjs');
const G = require('./guide-lib.cjs');
const R = require('./room-lib.cjs');

const numList = (v, dflt) => (v && v !== true ? String(v).split(',').map(Number).filter((x) => Number.isFinite(x)) : dflt);

async function click(page, touch, xy) {
  if (!xy) return false;
  if (touch) await page.touchscreen.tap(xy[0], xy[1]);
  else await page.mouse.click(xy[0], xy[1]);
  return true;
}
const centreOf = (page, fn, arg) => page.evaluate(fn, arg);

// ---------------------------------------------------------------- recruiter
/** What a visitor can read that tells them what to do next. */
const SURFACES = () => {
  const ui = window.__app.ui;
  const vis = (el) => {
    if (!el || !el.isConnected) return false;
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return cs.display !== 'none' && cs.visibility !== 'hidden' && parseFloat(cs.opacity) > 0.1 && r.width > 2 && r.height > 2;
  };
  const txt = (el) => (vis(el) ? (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim() : null);
  const g = document.getElementById('ds-guide');
  const shown = ui.compassDiv && ui.compassDiv.style.display !== 'none';
  return {
    t: Math.round(performance.now()),
    // The guide card or its chip (A6, P2-A4's route card, P2-A12's Next chip).
    guide: g && vis(g) && (g.innerText || '').trim().length > 0 ? { active: g.dataset.active || null, step: g.dataset.step || null, text: (g.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 160), buttons: [...g.querySelectorAll('button,[role=button]')].filter(vis).map((b) => (b.getAttribute('aria-label') || b.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40)) } : null,
    toast: txt(ui.toastEl),
    flash: txt(ui.flashEl),
    prompt: txt(ui.interactionDiv),
    panel: ui.panels ? ui.panels.current() : null,
    welcome: ui.isWelcomeVisible(),
    compass: shown ? (window.__h && window.__h.compassFull ? window.__h.compassFull() : ui.compassLabel ? ui.compassLabel.textContent : null) : null,
  };
};
const HIRE_OPEN = () => {
  const ui = window.__app.ui;
  const p = ui.zonePanelDiv;
  if (!p || !p.isConnected) return null;
  const h = p.querySelector('h2');
  const text = (p.innerText || '').replace(/\s+/g, ' ');
  // The hire card: the zone panel that carries the CV and LinkedIn links.
  if (!/LinkedIn/.test(text) || !/CV/.test(text)) return null;
  return { h2: h ? h.textContent.trim().slice(0, 60) : null, tourButton: !!p.querySelector('button[data-hire-tour]') };
};
const CLOSE_XY = () => {
  const p = window.__app.ui.zonePanelDiv;
  if (!p) return null;
  p.scrollTop = 0;
  const el = p.querySelector('button[aria-label="Close"]');
  if (!el) return null;
  const b = el.getBoundingClientRect();
  return [b.left + b.width / 2, b.top + b.height / 2];
};

/** Close the hire card by its X and listen: every change of a surface, in seconds since the close. */
async function closeAndListen(page, touch, seconds) {
  await lib.sleep(300);
  const xy = await page.evaluate(CLOSE_XY);
  if (!(await click(page, touch, xy))) await page.evaluate(() => window.__app.ui.panels.closeTop());
  const t0 = await G.ptime(page);
  const seen = {};
  const tl = [];
  const end = Date.now() + seconds * 1000;
  let firstGuide = null;
  let guideGapMs = 0;
  let lastT = t0;
  while (Date.now() < end) {
    const s = await page.evaluate(SURFACES).catch(() => null);
    if (s) {
      const at = +((s.t - t0) / 1000).toFixed(1);
      for (const k of ['toast', 'flash', 'prompt']) {
        if (s[k] && s[k] !== seen[k]) tl.push({ s: at, k, v: s[k].slice(0, 120) });
        seen[k] = s[k];
      }
      const gk = s.guide ? `${s.guide.active}|${s.guide.text}` : null;
      if (gk !== seen.guide) tl.push({ s: at, k: 'guide', v: s.guide ? `${s.guide.text} [${s.guide.buttons.join(' | ')}]` : '(gone)' });
      seen.guide = gk;
      if (s.guide && firstGuide === null) firstGuide = at;
      if (!s.guide && !s.panel) guideGapMs += s.t - lastT;
      lastT = s.t;
    }
    await lib.sleep(250);
  }
  return { closedAt: t0, timeline: tl, firstGuideS: firstGuide, secondsWithNoGuide: +(guideGapMs / 1000).toFixed(1), firstMessageS: tl.length ? tl[0].s : null, last: await page.evaluate(SURFACES) };
}

async function recruiter(t) {
  const scenarios = t.args.scenario && t.args.scenario !== true ? String(t.args.scenario).split(',') : ['card', 'deeplink', 'tour'];
  const listen = Number(t.args.listen || 60);
  for (const prof of t.profiles(['desktop', 'phone'])) {
    const touch = lib.isTouchProfile(prof);
    const out = {};
    for (const sc of scenarios) {
      const s = await t.session(prof);
      const { page } = s;
      const row = { scenario: sc };
      try {
        if (sc === 'deeplink') {
          // The link recruiters are sent: the card opens with no welcome card.
          await t.boot(s, { query: 'hour=12&zone=hire', waitWelcome: false });
          await page.waitForFunction(HIRE_OPEN, null, { timeout: 60000, polling: 200 });
        } else {
          await t.boot(s, { query: 'hour=12' });
          const xy = await centreOf(page, (sel) => {
            const b = document.querySelector(`${sel} button[data-cta="contact"]`);
            if (!b) return null;
            const r = b.getBoundingClientRect();
            return [r.left + r.width / 2, r.top + r.height / 2];
          }, lib.WELCOME);
          if (!xy) throw new Error('hook missing: the welcome card\'s button[data-cta="contact"]');
          const c0 = Date.now();
          await click(page, touch, xy);
          await page.waitForFunction(HIRE_OPEN, null, { timeout: 15000, polling: 50 });
          row.hireCardMs = Date.now() - c0;
        }
        row.hire = await page.evaluate(HIRE_OPEN);
        await t.shot(page, `recruiter-${prof}-${sc}-hire-card.png`);
        if (sc === 'tour') {
          // The highlights tour from the card; it ends back on the card.
          const xy = await centreOf(page, () => {
            const p = window.__app.ui.zonePanelDiv;
            const b = p && p.querySelector('button[data-hire-tour]');
            if (!b) return null;
            b.scrollIntoView({ block: 'center' });
            const r = b.getBoundingClientRect();
            return [r.left + r.width / 2, r.top + r.height / 2];
          });
          if (!xy) throw new Error('hook missing: the hire card\'s button[data-hire-tour]');
          await click(page, touch, xy);
          const t0 = Date.now();
          await lib.sleep(4000);
          // The tour is over when the hire card is open again (or 90 s).
          while (Date.now() - t0 < 90000 && !(await page.evaluate(HIRE_OPEN))) await lib.sleep(500);
          row.tourS = +((Date.now() - t0) / 1000).toFixed(1);
          row.backOnCard = !!(await page.evaluate(HIRE_OPEN));
          await lib.sleep(600);
        }
        row.after = await closeAndListen(page, touch, sc === 'tour' ? Math.min(listen, 25) : listen);
        row.storage = await page.evaluate(() => ({ ds_welcomed: localStorage.getItem('ds_welcomed'), ds_hint_compass: localStorage.getItem('ds_hint_compass') }));
        await t.shot(page, `recruiter-${prof}-${sc}-after.png`);
        // The route card's 'Show me' (P2-A4): it sets the compass to Projects.
        if (row.after.last.guide && row.after.last.guide.buttons.some((b) => /show me|walk me/i.test(b))) {
          const xy = await centreOf(page, () => {
            const g = document.getElementById('ds-guide');
            const b = g && [...g.querySelectorAll('button,[role=button]')].find((x) => /show me|walk me/i.test(x.getAttribute('aria-label') || x.textContent || ''));
            if (!b) return null;
            const r = b.getBoundingClientRect();
            return [r.left + r.width / 2, r.top + r.height / 2];
          });
          await click(page, touch, xy);
          await lib.sleep(900);
          row.showMe = (await page.evaluate(SURFACES)).compass;
        }
      } catch (e) {
        row.error = String((e && e.message) || e).slice(0, 240);
      }
      out[sc] = row;
      t.log(`${prof} ${sc}: ${JSON.stringify({ ...row, after: row.after ? { firstGuideS: row.after.firstGuideS, firstMessageS: row.after.firstMessageS, secondsWithNoGuide: row.after.secondsWithNoGuide, timeline: row.after.timeline.slice(0, 8) } : null })}`);
      await s.close();
    }
    t.data[prof] = out;
    const a = (k) => (out[k] && out[k].after) || null;
    if (out.card) {
      t.check(`${prof}: after the hire card closes, a guide surface (s)`, a('card') ? a('card').firstGuideS !== null && a('card').firstGuideS <= 1 : null, a('card') ? (a('card').firstGuideS === null ? `none in ${listen} s (first message of any kind at ${a('card').firstMessageS ?? '-'} s)` : a('card').firstGuideS) : out.card.error, '<= 1');
      t.check(`${prof}: the route card's 'Show me' sets the compass to Projects`, out.card.showMe !== undefined ? /Projects/.test(out.card.showMe || '') : a('card') ? false : null, out.card.showMe !== undefined ? out.card.showMe : "no 'Show me' on a guide surface", 'Projects');
    }
    if (out.deeplink) {
      t.check(`${prof}: after the ?zone=hire card closes, a guide surface (s)`, a('deeplink') ? a('deeplink').firstGuideS !== null && a('deeplink').firstGuideS <= 2 : null, a('deeplink') ? (a('deeplink').firstGuideS === null ? `none in ${listen} s (first message at ${a('deeplink').firstMessageS ?? '-'} s)` : a('deeplink').firstGuideS) : out.deeplink.error, '<= 2 (the pitch line, once)');
      t.check(`${prof}: the deep link leaves ds_welcomed unset`, out.deeplink.storage ? out.deeplink.storage.ds_welcomed === null : null, out.deeplink.storage ? out.deeplink.storage.ds_welcomed : out.deeplink.error, 'null');
    }
    if (out.tour) t.check(`${prof}: after the recruiter tour, a guide surface within 2 s of the hire card closing (s)`, a('tour') ? a('tour').firstGuideS !== null && a('tour').firstGuideS <= 2 : null, a('tour') ? (a('tour').firstGuideS === null ? `none in ${Math.min(listen, 25)} s (tour ${out.tour.tourS} s, back on the card ${out.tour.backOnCard})` : a('tour').firstGuideS) : out.tour.error, '<= 2');
  }
}

// --------------------------------------------------------------------- npcs
const VILLAGERS = () => {
  const a = window.__app;
  const sc = a.scene;
  const P = sc.getPlayer().getWorldPosition();
  const rows = [];
  for (const n of sc.getIsland().npcTargets) {
    const act = typeof sc.getNpcActivity === 'function' ? sc.getNpcActivity(n.name) : null;
    const q = n.meshRef.getWorldPosition(P.clone());
    rows.push({ name: n.name, d: +q.distanceTo(P).toFixed(1), visible: !!n.meshRef.visible, activity: act || null });
  }
  rows.sort((x, y) => x.d - y.d);
  const up = (r) => r.visible && r.activity !== 'sleep';
  const trail = typeof sc.getTrailVillager === 'function' ? sc.getTrailVillager() : null;
  // Who First steps would send the visitor to talk to (A's talkVillager): null means the step is skipped.
  let talk;
  try {
    talk = typeof a.talkVillager === 'function' ? a.talkVillager(null) : undefined;
  } catch (e) {
    talk = undefined;
  }
  const row = (name) => rows.find((r) => r.name === name) || null;
  return {
    hour: +sc.getEnvironmentCycle().getHour().toFixed(2),
    total: rows.length,
    asleep: rows.filter((r) => !up(r)).length,
    awakeWithin30: rows.filter((r) => up(r) && r.d <= 30).map((r) => `${r.name} ${r.d}`),
    nearestAwake: rows.find(up) || null,
    trailVillager: trail ? row(trail) : null,
    talkTarget: talk === undefined ? undefined : talk ? row(talk) : null,
  };
};

async function npcs(t) {
  const hours = numList(t.args.hours, [10.5, 18, 21, 23, 2, 6]);
  for (const prof of t.profiles(['desktop'])) {
    const touch = lib.isTouchProfile(prof);
    const out = {};
    for (const h of hours) {
      const s = await t.session(prof);
      const { page } = s;
      const row = {};
      try {
        await t.boot(s, { query: `hour=${h}` });
        const sel = `${lib.WELCOME} button[data-dismiss]`;
        if (touch) await page.tap(sel).catch(() => page.click(sel));
        else await page.click(sel);
        const t0 = await G.ptime(page);
        // The first 12 s after Explore: every message, and the guide card.
        const msgs = [];
        const seen = new Set();
        const end = Date.now() + 12000;
        while (Date.now() < end) {
          const m = await page.evaluate(SURFACES).catch(() => null);
          if (m) {
            for (const k of ['toast', 'flash']) {
              if (m[k] && !seen.has(m[k])) {
                seen.add(m[k]);
                msgs.push({ s: +((m.t - t0) / 1000).toFixed(1), k, v: m[k].slice(0, 130) });
              }
            }
          }
          await lib.sleep(300);
        }
        row.messages = msgs;
        row.talkHintAtS = (msgs.find((m) => /villager.*Claude Haiku|talks through/i.test(m.v)) || {}).s ?? null;
        Object.assign(row, await page.evaluate(VILLAGERS));
        await t.shot(page, `npcs-${prof}-h${String(h).replace('.', 'p')}.png`);
      } catch (e) {
        row.error = String((e && e.message) || e).slice(0, 200);
      }
      out[`h${h}`] = row;
      t.log(`${prof} ${h} h: ${JSON.stringify({ ...row, messages: (row.messages || []).length })}`);
      await s.close();
      if (row.error) {
        t.check(`${prof} at ${h} h: villagers read`, null, row.error, 'no error');
        continue;
      }
      const noneUp = row.awakeWithin30.length === 0;
      // GD-12: the talk hint must not send a visitor to sleeping villagers.
      t.check(`${prof} at ${h} h: a talk hint only when a villager within 30 u is awake`, row.talkHintAtS === null || !noneUp, { talkHintAtS: row.talkHintAtS, awakeWithin30: row.awakeWithin30.slice(0, 4), asleep: `${row.asleep} of ${row.total}` }, 'no hint with nobody awake');
      if (row.talkTarget !== undefined) {
        const tt = row.talkTarget;
        const night = h >= 20 || h < 8;
        // The wave-1 re-verify's ruling: overnight one talking villager stays up near the spawn, and the card names them.
        t.check(`${prof} at ${h} h: First steps' talk step names an awake villager within 30 u`, tt ? tt.visible && tt.activity !== 'sleep' && tt.d <= 30 : night ? false : null, tt ? `${tt.name} (${tt.activity}, ${tt.d} u)` : 'none: the talk step is skipped', 'awake, <= 30 u');
      }
    }
    t.data[prof] = out;
    if (!t.args.noSailor) await sailor(t, prof, touch);
  }
}

/** P2-C6: the Sailor's own words carry the beach-house code, and that code opens the door. */
async function sailor(t, prof, touch) {
  const s = await t.session(prof, { init: [R.REWARD_INIT] });
  const { page } = s;
  const T = touch ? await lib.touch(s) : null;
  const row = {};
  try {
    await t.boot(s, { query: 'hour=12' });
    await R.install(page);
    const sel = `${lib.WELCOME} button[data-dismiss]`;
    if (touch) await page.tap(sel).catch(() => page.click(sel));
    else await page.click(sel);
    await lib.sleep(1500);
    // Skip First steps: its card is not part of this walk.
    await page.evaluate(() => {
      const g = document.getElementById('ds-guide');
      const b = g && [...g.querySelectorAll('button,[role=button]')].find((x) => /skip/i.test(`${x.getAttribute('aria-label') || ''} ${x.textContent || ''}`));
      if (b) b.click();
    });
    // He sails a boat round the islet, so a visitor meets him on the water:
    // keep 1.6 u off his side (he moves at about 4.5 u/s) until his prompt shows.
    const BESIDE = () => {
      const sc = window.__app.scene;
      const t0 = sc.getIsland().npcTargets.find((n) => /Sailor/.test(n.name));
      if (!t0) return null;
      const p = t0.meshRef.getWorldPosition(sc.getPlayer().getWorldPosition().clone());
      const n = p.clone().normalize();
      const toPole = p.clone().set(0, 1, 0).addScaledVector(n, -n.y).normalize();
      sc.getPlayer().setWorldPosition(p.clone().addScaledVector(toPole, 1.6).setLength(p.length() + 0.2));
      const ui = window.__app.ui;
      return { name: t0.name, visible: t0.meshRef.visible, overWater: sc.getIsland().isOverWater(n), prompt: ui.interactionDiv && ui.interactionDiv.style.display !== 'none' ? ui.interactionDiv.textContent || '' : '' };
    };
    let where = await page.evaluate(BESIDE);
    if (!where) throw new Error('no Sailor among the villagers');
    row.name = where.name;
    row.overWater = where.overWater;
    row.walk = 'timeout';
    for (let i = 0; i < 40 && row.walk !== 'prompt'; i++) {
      await lib.sleep(120);
      where = await page.evaluate(BESIDE);
      if (new RegExp(where.name).test(where.prompt)) row.walk = 'prompt';
    }
    row.promptBesideHim = where.prompt.slice(0, 80);
    if (row.walk === 'prompt') {
      if (touch) {
        const u = await T.useBtn();
        if (u) await T.tap(u[0], u[1]);
      } else await page.keyboard.press('e');
    }
    await lib.sleep(2500);
    // Everything he says: the chat's opening line and three offline replies, or his scripted lines.
    const heard = [];
    const chatText = () => page.evaluate(() => (window.__app.ui.npcChatDiv ? (window.__app.ui.npcChatDiv.querySelector('[role=log]') || window.__app.ui.npcChatDiv).innerText.replace(/\s+/g, ' ') : null));
    let text = await chatText();
    if (text !== null) {
      heard.push(text);
      for (const q of ['Hello!', 'Tell me about the beach house.', 'How do I get in?']) {
        await page.evaluate(() => {
          const i = window.__app.ui.npcChatDiv && window.__app.ui.npcChatDiv.querySelector('input');
          if (i) i.focus();
        });
        await page.keyboard.type(q, { delay: 10 });
        await page.keyboard.press('Enter');
        await lib.sleep(4200);
        text = await chatText();
        if (text === null) break;
        heard.push(text);
      }
      row.spoke = 'chat';
    } else {
      // A scripted villager: page through the dialogue, reading each line.
      for (let i = 0; i < 12; i++) {
        const line = await page.evaluate(() => {
          const ui = window.__app.ui;
          if (!ui.isDialogueActive()) return null;
          const ov = document.getElementById('ui-overlay');
          const el = [...ov.children].filter((d) => getComputedStyle(d).display !== 'none' && +getComputedStyle(d).zIndex >= 1500).pop();
          return el ? (el.innerText || '').replace(/\s+/g, ' ').trim() : '';
        });
        if (line === null) break;
        heard.push(line);
        await page.keyboard.press('e');
        await lib.sleep(700);
      }
      row.spoke = heard.length ? 'dialogue' : 'nothing';
    }
    row.heard = [...new Set(heard.join(' || ').split(' || '))].join(' || ').slice(-900);
    await t.shot(page, `npcs-${prof}-sailor.png`);
    await page.keyboard.press('Escape');
    await page.evaluate(() => {
      const ui = window.__app.ui;
      if (ui.closeNpcChat) ui.closeNpcChat();
      if (ui.panels && ui.panels.closeAll) ui.panels.closeAll();
    });
    // The code, from his words alone (never from this probe).
    const m = /\b(\d{4})\b/.exec(row.heard || '');
    row.code = m ? m[1] : null;
    if (row.code) {
      const e = await R.enterRoom(page, 'islet_beach_house', { touch, T, back: 3.0, pin: row.code });
      await lib.sleep(3000);
      row.door = { press: e.press, pinPad: e.pinPad ?? null, inside: await page.evaluate(() => window.__app.scene.isInsideInterior()) };
    }
  } catch (e) {
    row.error = String((e && e.message) || e).slice(0, 240);
  }
  t.data[`${prof}Sailor`] = row;
  t.log(`${prof} sailor: ${JSON.stringify(row)}`);
  await s.close();
  t.check(`${prof}: the Sailor tells the visitor the beach-house code`, row.error ? null : !!row.code, row.error || (row.code ? `a 4-digit code, heard by ${row.spoke}` : row.walk !== 'prompt' ? `no talk prompt beside his boat in 5 s (the prompt there: "${row.promptBesideHim}")` : `no code in what he said (${row.spoke}): "${(row.heard || '').slice(-200)}"`), 'a 4-digit code');
  t.check(`${prof}: that code opens the beach house`, row.error ? null : row.code ? !!(row.door && row.door.inside) : false, row.door || 'no code to try', 'inside');
}

// --------------------------------------------------------------------- copy
/** Every written line the island can say, as this device renders it. */
const COPY = () => {
  const a = window.__app;
  const ui = a.ui;
  const tf = (s) => (typeof ui.touchifyPlain === 'function' ? ui.touchifyPlain(String(s)) : String(s));
  const out = { lessons: [], villagers: [], touch: !!ui.isTouch };
  const L0 = a.constructor.LESSONS;
  if (Array.isArray(L0)) for (const [id, text] of L0) out.lessons.push({ id, text: tf(text) });
  for (const n of a.scene.getIsland().npcTargets) for (const line of n.dialogue || []) out.villagers.push({ who: n.name, text: tf(line) });
  return out;
};
const PANEL_TEXT = () => {
  const ov = document.getElementById('ui-overlay');
  const tops = [...ov.children].filter((d) => getComputedStyle(d).display !== 'none' && +getComputedStyle(d).zIndex >= 1500 && d.getBoundingClientRect().width > 100);
  tops.sort((x, y) => +getComputedStyle(y).zIndex - +getComputedStyle(x).zIndex);
  return tops[0] ? (tops[0].innerText || '').replace(/[ \t]+/g, ' ').trim() : null;
};

// Keyboard keys a phone cannot press (GD-08), and facts the island gets wrong.
const KEY_RULES = [
  [/\bWASD\b/, 'WASD'],
  [/\bSpace\b/, 'Space'],
  [/\bPress P\b/i, 'Press P'],
  [/(^|[\s(,;])E to\b/, 'E to'],
  [/\(M\)/, '(M)'],
  [/\bpress (E|Q|F|G|M|C)\b/i, 'press <key>'],
];
const FACT_RULES = [
  [/five zones/i, 'five zones'],
  [/equator belt/i, 'equator belt'],
  [/next delivery/i, 'next delivery'],
  [/Project Portfolio zone/i, 'Project Portfolio zone'],
  [/\b5 districts\b/i, '5 districts'],
  [/\bagents?\b/i, 'agent'],
  [/live AI/i, 'live AI'],
  [/\b(two dozen|dozens of)\b/i, 'a typed count'],
];
const hits = (rows, rules) => {
  const out = [];
  for (const r of rows) for (const [re, name] of rules) if (re.test(r.text)) out.push(`${name}: ${r.where} "${r.text.replace(/\s+/g, ' ').slice(0, 90)}"`);
  return out;
};

async function copy(t) {
  for (const prof of t.profiles(['phone', 'desktop'])) {
    const touch = lib.isTouchProfile(prof);
    const s = await t.session(prof);
    const { page } = s;
    await t.boot(s, { query: 'hour=12' });
    const sel = `${lib.WELCOME} button[data-dismiss]`;
    if (touch) await page.tap(sel).catch(() => page.click(sel));
    else await page.click(sel);
    await lib.sleep(1500);
    const c = await page.evaluate(COPY);
    const rows = [...c.lessons.map((l) => ({ where: `lesson ${l.id}`, text: l.text })), ...c.villagers.map((v) => ({ where: v.who, text: v.text }))];
    // The Journal and the checklist, as their panels render them.
    const panels = {};
    for (const [name, open] of [
      ['journal', () => window.__app.ui.showJournal && (window.__app.ui.showJournal(), true)],
      ['checklist', () => {
        const ui = window.__app.ui;
        // The '% explored' chip opens it.
        if (ui.completionBtn && ui.completionBtn.isConnected) {
          ui.completionBtn.click();
          return true;
        }
        const f = ui.showChecklist || ui.showCompletionModal;
        if (typeof f === 'function') {
          f.call(ui);
          return true;
        }
        return false;
      }],
    ]) {
      const ok = await page.evaluate(open).catch(() => false);
      await lib.sleep(700);
      const text = ok ? await page.evaluate(PANEL_TEXT) : null;
      panels[name] = text;
      if (text) for (const line of text.split('\n').map((x) => x.trim()).filter(Boolean)) rows.push({ where: name, text: line });
      await t.shot(page, `copy-${prof}-${name}.png`);
      await page.evaluate(() => window.__app.ui.panels && window.__app.ui.panels.closeAll && window.__app.ui.panels.closeAll());
      await lib.sleep(300);
    }
    const keys = touch ? hits(rows, KEY_RULES) : [];
    const facts = hits(rows, FACT_RULES);
    t.data[prof] = { touch: c.touch, lessons: c.lessons, villagerLines: c.villagers.length, panels: Object.fromEntries(Object.entries(panels).map(([k, v]) => [k, v ? v.length : null])), keys, facts };
    t.log(`${prof}: ${rows.length} lines; keys ${keys.length}; facts ${facts.length}`);
    t.check(`${prof}: the lessons, villager lines, Journal and checklist were read`, c.lessons.length > 0 && c.villagers.length > 0 && !!panels.journal, { lessons: c.lessons.length, villagerLines: c.villagers.length, journal: !!panels.journal, checklist: !!panels.checklist }, 'lessons, villager lines and the Journal');
    if (touch) t.check(`${prof}: no keyboard key in the copy a phone shows`, keys.length === 0, keys.length ? keys.slice(0, 12) : 'none', 'none');
    t.check(`${prof}: no wrong fact, banned word or typed count in the written lines`, facts.length === 0, facts.length ? facts.slice(0, 12) : 'none', 'none');
  }
}

module.exports = {
  recruiter: { item: 'P2-E2b (GD-02; P2-A4)', title: 'the recruiter after the hire card (the Hiring pill, ?zone=hire, the highlights tour): what the island says once it closes, and when', profiles: ['desktop', 'phone'], run: recruiter },
  npcs: { item: 'P2-E2b (GD-12, GD-05; P2-C6, wave-1 re-verify)', title: 'villagers by hour: who is awake within 30 u, the talk hint, who First steps names; the Sailor tells the beach-house code and it opens the door', profiles: ['desktop'], run: npcs },
  copy: { item: 'P2-E2b (GD-08)', title: 'the written lines a phone shows (lessons, villager lines, Journal, checklist): keyboard keys, wrong facts, banned words, typed counts', profiles: ['phone', 'desktop'], run: copy },
};
