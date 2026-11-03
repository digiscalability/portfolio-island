'use strict';
// Key and click probes (A2, A3): does a key or click reach the world only when
// the world has focus? Ports of the controls audit's p2-clash, the first-minute
// audit's d-cardkeys and p9-sheet-lock.
//
// Independence rules: panels come from __app.ui.panels.current(), the welcome
// card is found by its role and aria-label, and the photo / recording verbs are
// counted through wrappers that never take a photo or open the microphone.
const lib = require('./lib.cjs');

const W = lib.WELCOME;

/** Count photo and recording verbs without performing them. */
const HOOK_VERBS = () => {
  const a = window.__app;
  window.__rec = 0;
  window.__photo = 0;
  if (a.chat && typeof a.chat.startRecording === 'function') {
    a.chat.startRecording = function () {
      window.__rec++;
      return Promise.resolve();
    };
  }
  if (typeof a.capturePhoto === 'function') {
    a.capturePhoto = function () {
      window.__photo++;
      return Promise.resolve();
    };
  }
  return true;
};

const STATE = () => {
  const h = window.__h;
  const a = h.app;
  const p = h.player();
  const ls = (k) => {
    try {
      return localStorage.getItem(k);
    } catch (e) {
      return 'ERR';
    }
  };
  return {
    panel: a.ui.panels.current(),
    welcome: a.ui.isWelcomeVisible(),
    customize: !!a.ui.customizeDiv,
    npcChat: a.ui.isNpcChatOpen(),
    rec: window.__rec || 0,
    photo: window.__photo || 0,
    seated: a.scene.isPlayerSeated(),
    pos: h.pos().toArray(),
    radius: h.pos().length(),
    grounded: typeof p.isOnGround === 'function' ? p.isOnGround() : null,
    focus: h.describe(document.activeElement),
    selection: String(getSelection() || '').trim().slice(0, 60),
    lock: !!document.pointerLockElement,
    ds_welcomed: ls('ds_welcomed'),
  };
};

const RESET = () => {
  const a = window.__app;
  const ui = a.ui;
  if (ui.customizeDiv && ui.hideCustomize) ui.hideCustomize();
  if (ui.isNpcChatOpen && ui.isNpcChatOpen()) ui.closeNpcChat();
  ui.panels.closeAll();
  if (a.scene.isPlayerSeated()) a.scene.standUpFromBench();
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  const s = getSelection();
  if (s) s.removeAllRanges();
  if (document.pointerLockElement && document.exitPointerLock) document.exitPointerLock();
  return true;
};

const moved = (a, b) => lib.round(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]), 3);

/** Hold a key for ms, re-sending keydown every 400 ms like OS auto-repeat. */
async function hold(page, key, ms) {
  await page.keyboard.down(key);
  const end = Date.now() + ms;
  while (Date.now() < end) {
    await lib.sleep(Math.min(400, end - Date.now()));
    if (Date.now() < end) await page.keyboard.down(key);
  }
  await page.keyboard.up(key);
}

const SELECT_EMAIL = () => {
  const p = window.__h.zonePanel();
  const el = p && (p.querySelector('[data-email]') || [...p.querySelectorAll('a, span, p')].find((e) => /@digiscalability\.com/.test(e.textContent)));
  if (!el) return null;
  const rg = document.createRange();
  rg.selectNodeContents(el);
  const s = getSelection();
  s.removeAllRanges();
  s.addRange(rg);
  return s.toString().trim().slice(0, 60);
};

const PANEL_SCROLL = () => {
  const p = window.__h.zonePanel();
  const sc = p && [p, ...p.querySelectorAll('*')].find((e) => e.scrollHeight > e.clientHeight + 4 && /auto|scroll/.test(getComputedStyle(e).overflowY));
  return sc ? sc.scrollTop : null;
};

const openZone = (page, id) =>
  page.evaluate((id) => {
    window.__app.ui.showZonePanel({ id, name: id });
    return true;
  }, id);

async function clash(t) {
  for (const prof of t.profiles(['desktop'])) {
    const s = await t.session(prof);
    const b = await t.boot(s);
    const { page } = s;
    await page.evaluate(HOOK_VERBS);
    const st = () => page.evaluate(STATE);
    const reset = async () => {
      await page.evaluate(RESET);
      await page.waitForTimeout(500);
    };
    const r = { boot: b };

    // Ctrl+C / Meta+C on Get In Touch with the email selected.
    for (const [label, combo, viaCard] of [
      ['ctrlC', 'Control+c', true],
      ['metaC', 'Meta+c', false],
    ]) {
      if (viaCard && (await page.$(`${W} button[data-cta="contact"]`))) await page.click(`${W} button[data-cta="contact"]`);
      else await openZone(page, 'contact');
      await page.waitForTimeout(1000);
      const selected = await page.evaluate(SELECT_EMAIL);
      const s0 = await st();
      if (viaCard) await t.shot(page, `clash-${prof}-ctrlc-before.png`);
      await page.keyboard.press(combo);
      await page.waitForTimeout(900);
      const s1 = await st();
      if (viaCard) await t.shot(page, `clash-${prof}-ctrlc-after.png`);
      r[label] = { selected, panelBefore: s0.panel, panelAfter: s1.panel, customizeOpened: s1.customize && !s0.customize, selectionAfter: s1.selection };
      await reset();
    }
    t.check(`${prof}: Ctrl+C on Get In Touch leaves 'zone'`, r.ctrlC.panelAfter === 'zone', r.ctrlC.panelAfter, 'zone');
    t.check(`${prof}: Ctrl+C keeps the email selected`, !!r.ctrlC.selected && r.ctrlC.selectionAfter === r.ctrlC.selected, r.ctrlC.selectionAfter, r.ctrlC.selected);
    t.check(`${prof}: Meta+C on Get In Touch leaves 'zone'`, r.metaC.panelAfter === 'zone', r.metaC.panelAfter, 'zone');
    t.check(`${prof}: Meta+C keeps the email selected`, !!r.metaC.selected && r.metaC.selectionAfter === r.metaC.selected, r.metaC.selectionAfter, r.metaC.selected);

    // Movement keys held 1.5 s behind an open Projects card.
    r.behindModal = [];
    for (const key of ['ArrowDown', 'w']) {
      await openZone(page, 'projects');
      await page.waitForTimeout(1000);
      const s0 = await st();
      const sc0 = await page.evaluate(PANEL_SCROLL);
      await hold(page, key, 1500);
      await page.waitForTimeout(400);
      const s1 = await st();
      const sc1 = await page.evaluate(PANEL_SCROLL);
      r.behindModal.push({ key, panelBefore: s0.panel, panelAfter: s1.panel, playerMovedU: moved(s0.pos, s1.pos), panelScrollTop: [sc0, sc1] });
      if (key === 'ArrowDown') await t.shot(page, `clash-${prof}-projects-after-arrowdown.png`);
      await reset();
    }
    for (const m of r.behindModal) t.check(`${prof}: ${m.key} held 1.5 s behind Projects moves the avatar (u)`, m.playerMovedU <= 0.05, m.playerMovedU, '<= 0.05');

    // M, C and P inside an open panel.
    r.verbsInPanel = [];
    for (const key of ['m', 'c', 'p']) {
      await openZone(page, 'projects');
      await page.waitForTimeout(900);
      const s0 = await st();
      await page.keyboard.press(key);
      await page.waitForTimeout(900);
      const s1 = await st();
      r.verbsInPanel.push({ key, panelBefore: s0.panel, panelAfter: s1.panel, customize: s1.customize, photo: s1.photo - s0.photo });
      await reset();
    }
    for (const v of r.verbsInPanel) {
      t.check(`${prof}: '${v.key}' in a panel leaves it 'zone'`, v.panelAfter === 'zone', v.panelAfter, 'zone');
      t.check(`${prof}: '${v.key}' in a panel takes no photo`, v.photo === 0, v.photo, 0);
    }

    // E behind a panel, standing at a bench.
    r.bench = await page.evaluate(async () => {
      const h = window.__h;
      const bs = h.sc.benchGroups || [];
      const p = h.pos();
      let best = null;
      for (const g of bs) {
        const w = g.getWorldPosition(p.clone());
        const d = w.distanceTo(p);
        if (!best || d < best.d) best = { d, w };
      }
      if (!best) return { benches: 0 };
      h.tpNear(best.w, 1.2);
      await h.wait(900);
      const n = h.sc.getNearbyInteractable();
      return { benches: bs.length, nearbyType: n ? n.type : null };
    });
    if (r.bench.nearbyType === 'bench') {
      await openZone(page, 'projects');
      await page.waitForTimeout(900);
      const s0 = await st();
      await page.keyboard.press('e');
      await page.waitForTimeout(900);
      const s1 = await st();
      r.eBehindPanel = { panelBefore: s0.panel, panelAfter: s1.panel, seatedBehindPanel: s1.seated && !s0.seated };
      await t.shot(page, `clash-${prof}-e-behind-panel.png`);
      await reset();
      t.check(`${prof}: E behind a panel never seats the avatar`, !r.eBehindPanel.seatedBehindPanel, r.eBehindPanel.seatedBehindPanel, false);
    } else t.check(`${prof}: E behind a panel never seats the avatar`, null, r.bench, 'a bench within reach');

    // Space on a focused button inside a panel.
    await openZone(page, 'projects');
    await page.waitForTimeout(900);
    const focused = await page.evaluate(() => {
      const h = window.__h;
      const p = h.zonePanel();
      const btn = p && [...p.querySelectorAll('button')].find((x) => h.visible(x));
      if (!btn) return null;
      btn.focus();
      return h.describe(document.activeElement);
    });
    const r0 = (await st()).radius;
    let peak = r0;
    let leftGround = false;
    await page.keyboard.down('Space');
    for (let i = 0; i < 10; i++) {
      await page.waitForTimeout(60);
      const x = await st();
      peak = Math.max(peak, x.radius);
      if (x.grounded === false) leftGround = true;
    }
    await page.keyboard.up('Space');
    await page.waitForTimeout(500);
    r.spaceOnPanelButton = { focused, heightGainU: lib.round(peak - r0, 3), leftGround, panelAfter: (await st()).panel };
    await reset();
    t.check(`${prof}: Space on a focused panel button (height gain u)`, focused ? r.spaceOnPanelButton.heightGainU <= 0.02 : null, r.spaceOnPanelButton.heightGainU, '<= 0.02');

    // ArrowLeft on the focused volume slider (opened the keyboard way).
    const slider = await page.evaluate(async () => {
      const ui = window.__app.ui;
      if (ui.muteBtn) ui.muteBtn.focus();
      await window.__h.wait(150);
      const el = document.querySelector('#ui-overlay input[type=range]');
      if (!el) return null;
      el.focus();
      return { value: el.value, focus: window.__h.describe(document.activeElement) };
    });
    if (slider) {
      const s0 = await st();
      await hold(page, 'ArrowLeft', 1200);
      await page.waitForTimeout(400);
      const s1 = await st();
      const v1 = await page.evaluate(() => document.querySelector('#ui-overlay input[type=range]').value);
      r.volumeSlider = { valueBefore: slider.value, valueAfter: v1, focus: slider.focus, playerMovedU: moved(s0.pos, s1.pos) };
      t.check(`${prof}: ArrowLeft on the volume slider moves the avatar (u)`, r.volumeSlider.playerMovedU <= 0.05, r.volumeSlider.playerMovedU, '<= 0.05');
    } else t.check(`${prof}: ArrowLeft on the volume slider moves the avatar (u)`, null, 'no range input', 'a volume slider');
    await reset();

    // sendThenWalk: type a line to an AI villager, click Send, hold W 0.6 s.
    r.sendThenWalk = await sendThenWalk(t, s, prof);
    t.check(`${prof}: sendThenWalk closes the NPC chat`, r.sendThenWalk.opened ? !r.sendThenWalk.stillOpenAfterWalk : null, r.sendThenWalk.opened ? r.sendThenWalk.stillOpenAfterWalk : 'chat never opened', false);
    t.data[prof] = r;
  }
}

async function sendThenWalk(t, s, prof) {
  const { page } = s;
  const out = { tried: [] };
  // Villagers with a quest open the canned dialogue on E, so walk the roster
  // until E opens the free-text AI chat.
  const names = await page.evaluate(() => {
    const h = window.__h;
    const isl = h.sc.getIsland ? h.sc.getIsland() : h.sc.island;
    return ((isl && isl.npcTargets) || []).filter((x) => x.meshRef && x.meshRef.visible).map((x) => x.name);
  });
  for (const name of names) {
    if (out.tried.length >= 10) break;
    const prompt = await page.evaluate(async (name) => {
      const h = window.__h;
      const isl = h.sc.getIsland ? h.sc.getIsland() : h.sc.island;
      const x = isl.npcTargets.find((n) => n.name === name);
      h.tpNear(x.meshRef.position.clone(), 1.4);
      await h.wait(700);
      return ((h.app.ui.interactionDiv && h.app.ui.interactionDiv.textContent) || '').trim().slice(0, 80);
    }, name);
    if (!/ask anything/i.test(prompt)) continue;
    await page.keyboard.press('e');
    let opened = false;
    for (let i = 0; i < 10 && !opened; i++) {
      await page.waitForTimeout(150);
      opened = await page.evaluate(() => window.__app.ui.isNpcChatOpen());
    }
    out.tried.push(name);
    if (opened) {
      out.openedVia = `E at ${name}`;
      break;
    }
    await page.evaluate(() => {
      const ui = window.__app.ui;
      if (ui.isDialogueActive && ui.isDialogueActive() && ui.hideDialogue) ui.hideDialogue();
    });
    await page.evaluate(RESET);
    await page.waitForTimeout(400);
  }
  if (!out.openedVia) {
    // The walk-away rule reads only ui.isNpcChatOpen(), so a directly opened
    // chat measures the same thing when no villager opened one. Its reply
    // takes 3 s, like a live model.
    await page.evaluate(() => window.__app.ui.showNpcChat('Probe', 'Hello.', () => new Promise((r) => setTimeout(() => r('Thanks.'), 3000))));
    await page.waitForTimeout(600);
    out.openedVia = (await page.evaluate(() => window.__app.ui.isNpcChatOpen())) ? 'ui.showNpcChat (fallback)' : null;
  }
  out.opened = !!out.openedVia;
  if (!out.opened) return out;
  // A live reply takes seconds; the harness aborts the backend at once, which
  // would hand focus straight back to the input. Give the blocked auth and
  // function calls a 3 s latency for this step (they are still aborted).
  s.net.hold = { re: /identitytoolkit|securetoken|cloudfunctions\.net|\.run\.app|firebaseappcheck/, ms: 3000 };
  const send = await page.evaluate(() => {
    const ui = window.__app.ui;
    const panel = ui.npcChatDiv;
    if (!panel) return null;
    const input = panel.querySelector('input[type=text]');
    const btn = [...panel.querySelectorAll('button')].find((b) => /^send$/i.test((b.textContent || '').trim()));
    if (!input || !btn) return null;
    input.focus();
    const r = btn.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  if (!send) {
    out.error = 'no input or Send button in the chat';
    return out;
  }
  await page.keyboard.type('hello', { delay: 30 });
  const p0 = (await page.evaluate(STATE)).pos;
  await page.mouse.click(send.x, send.y);
  out.focusAfterSend = await page.evaluate(() => window.__h.describe(document.activeElement));
  await hold(page, 'w', 600);
  await page.waitForTimeout(500);
  const s1 = await page.evaluate(STATE);
  out.stillOpenAfterWalk = s1.npcChat;
  out.playerMovedU = moved(p0, s1.pos);
  await t.shot(page, `clash-${prof}-send-then-walk.png`);
  s.net.hold = null;
  await page.evaluate(RESET);
  return out;
}

async function cardkeys(t) {
  for (const prof of t.profiles(['desktop'])) {
    const s = await t.session(prof);
    const b = await t.boot(s);
    const { page } = s;
    await page.evaluate(HOOK_VERBS);
    await page.waitForTimeout(1500); // the card has been up a moment
    const steps = [{ at: 'card', ...(await page.evaluate(STATE)) }];
    for (const key of ['c', 'p', 'm', 'e']) {
      await page.keyboard.press(key);
      await page.waitForTimeout(250);
      steps.push({ at: `after ${key}`, ...(await page.evaluate(STATE)) });
    }
    const cardStillUp = await page.$(`${W} button[data-dismiss]`).then((x) => !!x);
    const welcomedBeforeExplore = steps[steps.length - 1].ds_welcomed;
    if (cardStillUp) await page.click(`${W} button[data-dismiss]`);
    await page.waitForTimeout(900);
    const after = await page.evaluate(STATE);
    await t.shot(page, `cardkeys-${prof}-after-explore.png`);
    const strip = (x) => ({ at: x.at, panel: x.panel, welcome: x.welcome, customize: x.customize, photo: x.photo, ds_welcomed: x.ds_welcomed, focus: x.focus });
    t.data[prof] = { boot: b, steps: steps.map(strip), cardStillUpAfterKeys: cardStillUp, exploreClicked: cardStillUp, after09s: strip({ at: 'explore +0.9 s', ...after }) };
    t.check(`${prof}: the card survives C, P, M and E`, cardStillUp, cardStillUp, true);
    t.check(`${prof}: ds_welcomed unset until the visitor chooses`, welcomedBeforeExplore === null, welcomedBeforeExplore, null);
    t.check(`${prof}: panel 0.9 s after Explore`, cardStillUp && after.panel === null, after.panel, null);
    t.check(`${prof}: Explore sets ds_welcomed`, cardStillUp && !!after.ds_welcomed, after.ds_welcomed, 'set');
  }
}

async function sheetLock(t) {
  for (const prof of t.profiles(['desktop'])) {
    const s = await t.session(prof);
    const b = await t.boot(s);
    const { page } = s;
    await lib.dismissWelcome(page);
    await page.waitForTimeout(1200);
    const st = () => page.evaluate(() => ({ panel: window.__app.ui.panels.current(), locked: !!document.pointerLockElement, plReq: window.__plReq }));
    await page.click('[aria-label="Open portfolio menu"]');
    await page.waitForTimeout(700);
    const before = await st();
    await page.mouse.click(200, 700);
    await page.waitForTimeout(600);
    const afterWorldClick = await st();
    const row = await page.evaluate(() => window.__h.rect(document.querySelector('button[data-section="projects"]')));
    if (row) await page.mouse.click(row.x + row.w / 2, row.y + row.h / 2);
    await page.waitForTimeout(800);
    const afterRowClick = await st();
    await t.shot(page, `sheet-lock-${prof}.png`);
    t.data[prof] = { boot: b, before, afterWorldClick, rowFound: !!row, afterRowClick };
    t.check(`${prof}: the menu is open before the world click`, before.panel === 'portfolio-menu', before.panel, 'portfolio-menu');
    t.check(`${prof}: a world click leaves the pointer free`, !afterWorldClick.locked, afterWorldClick.locked, false);
    t.check(`${prof}: the Projects row then opens 'zone'`, !!row && afterRowClick.panel === 'zone', afterRowClick.panel, 'zone');
  }
}

module.exports = {
  clash: { item: 'A2', title: 'keys that reach the world while a panel, field or control has focus', profiles: ['desktop'], run: clash },
  cardkeys: { item: 'A2', title: 'C, P, M and E on a fresh welcome card, then Explore', profiles: ['desktop'], run: cardkeys },
  'sheet-lock': { item: 'A3', title: 'a world click beside the open Portfolio menu, then its Projects row', profiles: ['desktop'], run: sheetLock },
};
