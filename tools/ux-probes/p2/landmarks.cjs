'use strict';
// p2/landmarks: the Projects district's five sites explain themselves
// (P2-E2d; GD-09; P2-A13). The guidance audit's lm-d.cjs was a session temp
// file and is gone, so this is rebuilt from phase2-audit/results/a.json
// GD-09: walking to each site plaque (construction_0-4) and standing 1.8-2.5 u
// out, 4 of 5 sites showed no prompt, and at RankPilot the only prompt was
// the bench-plot advert ('🪑 A bench could go here — needs 4 🪵 + 10 🪙').
//
// Desktop, the card dismissed, First steps skipped. For each site i, the
// `construction_${i}` anchor (Island's mesh, found by name; WORK_SITES
// order), the player stood 2.2 u out (outside its 0.8 u collider, the first
// of 8 headings that holds 1.8-2.5 u after a settle), and `[data-hud=prompt]`
// (else the interaction div) read every 100 ms for 1.2 s. P2-A13's rows:
//   prompt   it names board i's project and status, from a fixture copied
//            from SignPainter.PROJECT_BOARDS (test/probeSafety pins the
//            fixture to the table)
//   E        when the prompt names the project: E opens Projects at the card
//            for site i (data-project rankpilot, chocomate, island, banos,
//            insta; there is no DigiScalability site) with the card's top
//            inside the panel's scroll viewport, and the passport count is
//            unchanged by the landmark open (null when no prompt names it)
//
//   npm run probe -- p2/landmarks --dist dist --port <n>
const lib = require('../lib.cjs');

/** SignPainter.PROJECT_BOARDS at fcaa649 (C8; Abbas checked the strings on 2026-11-13). */
const PROJECT_BOARDS = [
  { name: 'RankPilot', status: 'Pre-launch' },
  { name: 'ChocoMate', status: 'Paused' },
  { name: 'Life Island', status: 'This island' },
  { name: "Bano's Cookbook", status: "Ammi's recipes" },
  { name: 'Insta Services API', status: 'Modernising' },
];
/** The Projects card each site opens (P2-A13's own table). */
const ANCHORS = ['rankpilot', 'chocomate', 'island', 'banos', 'insta'];

/** Stand 2.2 u from site i on the first heading that holds; returns the anchor's world spot. */
const STAND = ({ i, k }) => {
  const sc = window.__app.scene;
  const isl = sc.getIsland();
  const o = sc.getObjectByName(`construction_${i}`) || (isl.mesh && isl.mesh.getObjectByName ? isl.mesh.getObjectByName(`construction_${i}`) : null);
  if (!o) return null;
  const P = sc.getPlayer();
  const V3 = P.getWorldPosition().constructor;
  const c = o.getWorldPosition(new V3());
  const up = c.clone().normalize();
  const ref = Math.abs(up.y) < 0.9 ? new V3(0, 1, 0) : new V3(1, 0, 0);
  const t = ref.clone().addScaledVector(up, -ref.dot(up)).normalize().applyAxisAngle(up, (k * Math.PI) / 4);
  const dir = c.clone().addScaledVector(t, 2.2).normalize();
  const sfc = isl.sampleSurfaceByDirection(dir, 0);
  P.setWorldPosition(dir.multiplyScalar(sfc.position.length() + 0.6));
  window.__site = c;
  return { at: [c.x, c.y, c.z] };
};
const DIST = () => {
  const sc = window.__app.scene;
  const p = sc.getPlayer().getWorldPosition();
  const c = window.__site;
  return c ? +(p.clone().normalize().angleTo(c.clone().normalize()) * p.length()).toFixed(2) : null;
};
const PROMPT = () => {
  const el = document.querySelector('[data-hud="prompt"]') || (window.__app.ui && window.__app.ui.interactionDiv);
  if (!el || !el.isConnected) return null;
  const cs = getComputedStyle(el);
  if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity < 0.05) return null;
  const t = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
  return t || null;
};
const PASSPORT = () => {
  const a = window.__app;
  return a.passport && typeof a.passport.count === 'function' ? a.passport.count() : null;
};
/** The open panel, and where the card for `anchor` sits in its scroll viewport. */
const CARD = (anchor) => {
  const ui = window.__app.ui;
  const current = ui.panels && ui.panels.current ? ui.panels.current() : null;
  const panel = ui.zonePanelDiv && ui.zonePanelDiv.isConnected ? ui.zonePanelDiv : null;
  if (!panel) return { current, open: false };
  const card = panel.querySelector(`[data-project="${anchor}"]`);
  if (!card) return { current, open: true, card: false };
  let sc = card.parentElement;
  while (sc && sc !== panel.parentElement) {
    const cs = getComputedStyle(sc);
    if (/(auto|scroll)/.test(cs.overflowY) && sc.scrollHeight > sc.clientHeight + 2) break;
    sc = sc.parentElement;
  }
  const view = (sc && sc !== panel.parentElement ? sc : panel).getBoundingClientRect();
  const r = card.getBoundingClientRect();
  return { current, open: true, card: true, top: Math.round(r.top), viewTop: Math.round(view.top), viewBottom: Math.round(view.bottom), inView: r.top >= view.top - 1 && r.top < view.bottom - 20 };
};

async function landmarks(t) {
  for (const prof of t.profiles(['desktop'])) {
    const s = await t.session(prof);
    await t.boot(s);
    const { page } = s;
    await lib.dismissWelcome(page);
    await page.evaluate(() => {
      const g = window.__app.guide;
      if (g && typeof g.isActive === 'function' && g.isActive() && typeof g.skip === 'function') g.skip();
    });
    await lib.sleep(1200);
    const sites = [];
    for (let i = 0; i < PROJECT_BOARDS.length; i++) {
      let stood = null;
      let d = null;
      for (let k = 0; k < 8; k++) {
        stood = await page.evaluate(STAND, { i, k });
        if (!stood) break;
        await lib.sleep(700);
        d = await page.evaluate(DIST);
        if (d !== null && d >= 1.8 && d <= 2.6) break;
      }
      if (!stood) {
        sites.push({ i, missing: true });
        continue;
      }
      const seen = [];
      for (let n = 0; n < 12; n++) {
        const p = await page.evaluate(PROMPT);
        if (p && !seen.includes(p)) seen.push(p);
        await lib.sleep(100);
      }
      const b = PROJECT_BOARDS[i];
      const names = seen.some((p) => p.includes(b.name) && p.includes(b.status));
      const row = { i, project: b.name, d, prompts: seen, names };
      await t.shot(page, `p2-landmarks-${prof}-site${i}.png`);
      if (names) {
        const before = await page.evaluate(PASSPORT);
        await page.keyboard.press('e');
        await lib.sleep(1200);
        row.card = await page.evaluate(CARD, ANCHORS[i]);
        row.passport = { before, after: await page.evaluate(PASSPORT) };
        await page.evaluate(() => {
          const ui = window.__app.ui;
          if (ui.panels && ui.panels.closeAll) ui.panels.closeAll();
        });
        await lib.sleep(500);
      }
      sites.push(row);
    }
    await s.close();
    t.data[prof] = { sites };
    const found = sites.filter((x) => !x.missing);
    const prompted = found.filter((x) => x.prompts.length);
    t.check(`${prof}: the five sites found (construction_0-4)`, found.length === 5 ? true : null, found.length, '5');
    t.check(`${prof}: each site's prompt names its project and status (P2-A13)`, found.length ? found.every((x) => x.names) : null, found.map((x) => `${x.project}: ${x.prompts.length ? x.prompts.join(' | ') : '(no prompt)'}`), `PROJECT_BOARDS' name and status (58c8849: 4 of 5 no prompt, RankPilot the bench advert)`);
    t.check(`${prof}: sites with any prompt (reported)`, true, `${prompted.length} of ${found.length}`, 'reported (58c8849: 1 of 5)');
    const opened = found.filter((x) => x.card);
    t.check(`${prof}: E opens Projects at the site's card, in view (P2-A13)`, opened.length ? opened.every((x) => x.card.card && x.card.inView) : null, opened.map((x) => ({ site: ANCHORS[x.i], ...x.card })), 'the card for site i, its top inside the panel (null: no prompt names a project)');
    t.check(`${prof}: the landmark open leaves the passport count alone (P2-A13)`, opened.length ? opened.every((x) => x.passport.before === x.passport.after) : null, opened.map((x) => x.passport), 'unchanged (null: no prompt names a project)');
  }
}

module.exports = {
  landmarks: { item: 'P2-E2d (GD-09; P2-A13)', title: "the Projects district's five sites from 2.2 u: the prompt names project and status; E opens Projects at the site's card without a stamp", profiles: ['desktop'], run: landmarks },
  PROJECT_BOARDS,
  ANCHORS,
  CARD,
};
