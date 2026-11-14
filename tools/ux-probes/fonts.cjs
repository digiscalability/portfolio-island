'use strict';
// The faces text really renders in (E6d; DA-06; D12). The audit's
// fonts-cdp.cjs was a session temp file and is gone, so this is rebuilt from
// ux-audit/results/design.json DA-06: CDP CSS.getPlatformFontsForNode at 1440
// and 390 found the welcome title and body in Segoe UI and every <button> in
// Arial (the welcome CTAs, the Hiring pill, the Portfolio-menu items); the
// Patrick Hand faces stayed 'unloaded', so the bubble canvas painted in
// system-ui.
//
//   no Arial   after document.fonts.ready, every element with its own text in
//              the welcome card (title, body, every button), the Hiring pill
//              and the Portfolio menu's items: CSS.getPlatformFontsForNode.
//              A node whose computed family names 'Bebas Neue Fallback' (D12's
//              deliberate metric fallback over local Arial) is exempt.
//   faces      'Bebas Neue' and 'Patrick Hand' count as loaded only when
//              document.fonts.check() is true AND a FontFace of exactly that
//              family has status 'loaded': check() is vacuously true when no
//              face matches the family. Patrick Hand is read after the first
//              bubble paints (GameScene.showNpcSpeechBubble starts B8's load).
//              The canvas's own use of the family loads the face on every
//              build, so a second row judges the paint: the bubble's last
//              fillText in 'Patrick Hand' happened with the face loaded.
//   hosts      which host served each woff2 (fonts.gstatic.com on main; the
//              site itself after D12).
//   CLS        layout-shift entries in the 2 s after each face loads (D12:
//              no font-driven CLS).
//
//   npm run probe -- fonts --dist dist --port <n> [--profile desktop|phone]
const lib = require('./lib.cjs');

/** Init: layout shifts and face loads, timed. */
const FONT_LOG = `(() => {
  const L = (window.__fontLog = { shifts: [], faces: [], paints: [] });
  // Every canvas fillText in 'Patrick Hand' (the bubble): was the face loaded then?
  try {
    const ft = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function () {
      if (L.paints.length < 200 && /Patrick Hand/.test(this.font))
        L.paints.push({ t: performance.now(), loaded: [...document.fonts].some((f) => f.family.replace(/["']/g, '') === 'Patrick Hand' && f.status === 'loaded') });
      return ft.apply(this, arguments);
    };
  } catch (e) {}
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) L.shifts.push({ t: e.startTime, v: e.value, input: e.hadRecentInput });
    }).observe({ type: 'layout-shift', buffered: true });
  } catch (e) {}
  try {
    document.fonts.addEventListener('loadingdone', (e) => {
      for (const f of e.fontfaces) L.faces.push({ t: performance.now(), family: f.family.replace(/["']/g, ''), status: f.status });
    });
  } catch (e) {}
})();`;

/** Page-side: tag every element with its own text under the given roots. */
const TAG = ({ sel, label, start }) => {
  let i = start;
  const out = [];
  for (const root of document.querySelectorAll(sel)) {
    const els = [root, ...root.querySelectorAll('*')];
    for (const el of els) {
      const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 0);
      if (!own) continue;
      const b = el.getBoundingClientRect();
      if (b.width < 1 || b.height < 1) continue;
      el.setAttribute('data-fontprobe', String(i));
      out.push({ i, label, tag: el.tagName.toLowerCase(), text: el.textContent.replace(/\s+/g, ' ').trim().slice(0, 40), family: getComputedStyle(el).fontFamily });
      i++;
    }
  }
  return out;
};

const FACES = () => {
  const has = (fam) => [...document.fonts].some((f) => f.family.replace(/["']/g, '') === fam && f.status === 'loaded');
  const anyFace = (fam) => [...document.fonts].some((f) => f.family.replace(/["']/g, '') === fam);
  return {
    bebas: { check: document.fonts.check(`40px 'Bebas Neue'`), face: anyFace('Bebas Neue'), loaded: has('Bebas Neue') },
    patrick: { check: document.fonts.check(`26px 'Patrick Hand'`), face: anyFace('Patrick Hand'), loaded: has('Patrick Hand') },
    families: [...new Set([...document.fonts].map((f) => `${f.family.replace(/["']/g, '')}:${f.status}`))].slice(0, 30),
  };
};

async function platformFonts(page, nodes) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('DOM.enable');
  await cdp.send('CSS.enable');
  const { root } = await cdp.send('DOM.getDocument', { depth: -1 });
  const { nodeIds } = await cdp.send('DOM.querySelectorAll', { nodeId: root.nodeId, selector: '[data-fontprobe]' });
  const byIdx = {};
  for (const id of nodeIds) {
    const { attributes } = await cdp.send('DOM.getAttributes', { nodeId: id });
    const k = attributes.indexOf('data-fontprobe');
    const idx = Number(attributes[k + 1]);
    const { fonts } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId: id }).catch(() => ({ fonts: [] }));
    byIdx[idx] = fonts.map((f) => f.familyName);
  }
  await cdp.detach().catch(() => {});
  return nodes.map((n) => ({ ...n, platform: byIdx[n.i] || [] }));
}

async function fonts(t) {
  for (const prof of t.profiles(['desktop', 'phone'])) {
    const woff = [];
    const s = await t.session(prof, { init: [FONT_LOG] });
    s.page.on('response', (r) => {
      if (/\.woff2(\?|$)/.test(r.url())) woff.push({ host: new URL(r.url()).host, status: r.status() });
    });
    await t.boot(s);
    const { page } = s;
    await page.evaluate(() => document.fonts.ready.then(() => true));
    await page.waitForTimeout(800);
    let nodes = await page.evaluate(TAG, { sel: lib.WELCOME, label: 'welcome', start: 0 });
    const welcome = await platformFonts(page, nodes);
    await lib.dismissWelcome(page);
    await page.waitForTimeout(600);
    nodes = await page.evaluate(TAG, { sel: '[aria-label="Hiring? Open the CV and contact card"]', label: 'hiring', start: 1000 });
    const hiring = await platformFonts(page, nodes);
    let menu = [];
    const opened = await page
      .click('.hud-btn[aria-label="Open portfolio menu"]', { timeout: 3000 })
      .then(() => true)
      .catch(() => false);
    if (opened) {
      await page.waitForTimeout(700);
      nodes = await page.evaluate(TAG, { sel: 'button[data-section]', label: 'menu', start: 2000 });
      menu = await platformFonts(page, nodes);
      await page.keyboard.press('Escape');
    }
    // The first bubble: B8's Patrick Hand load starts at the first show.
    const bubble = await page.evaluate(() => {
      const sc = window.__app.scene;
      if (typeof sc.showNpcSpeechBubble !== 'function') return false;
      sc.showNpcSpeechBubble(0, 'Hello there, welcome to the island!', 1e9);
      return true;
    });
    await page.waitForTimeout(3500);
    const faces = await page.evaluate(FACES);
    const log = await page.evaluate(() => window.__fontLog);
    const all = [...welcome, ...hiring, ...menu];
    const isArial = (n) => n.platform.some((f) => /^arial/i.test(f));
    const exempt = (n) => /Bebas Neue Fallback/i.test(n.family);
    const arial = all.filter((n) => isArial(n) && !exempt(n));
    const cls = (log.faces || []).map((f) => ({ family: f.family, t: Math.round(f.t), cls2s: lib.round(log.shifts.filter((x) => !x.input && x.t >= f.t && x.t <= f.t + 2000).reduce((a, x) => a + x.v, 0), 4) }));
    const out = { nodes: all.map((n) => `${n.label} ${n.tag} '${n.text}': ${n.platform.join(', ') || '-'}`), arial: arial.map((n) => `${n.label} ${n.tag} '${n.text}'`), faces, bubble, woff2: woff, faceLoads: cls, menuOpened: opened, hiringFound: hiring.length > 0 };
    t.data[prof] = out;
    t.check(`${prof}: no Arial in the welcome card, the Hiring pill and the Portfolio menu`, all.length ? arial.length === 0 : null, { arial: out.arial.slice(0, 12), nodes: all.length }, "none ('Bebas Neue Fallback' nodes exempt; 58c8849: every button in Arial)");
    t.check(`${prof}: 'Bebas Neue' loaded (check() and a loaded FontFace)`, faces.bebas.check && faces.bebas.loaded, faces.bebas, 'both true');
    t.check(`${prof}: 'Patrick Hand' loaded after the first bubble`, bubble ? faces.patrick.check && faces.patrick.loaded : null, faces.patrick, 'both true (58c8849: unloaded)');
    const paints = log.paints || [];
    out.bubblePaints = { n: paints.length, first: paints[0] || null, last: paints[paints.length - 1] || null };
    t.check(`${prof}: the bubble's last paint used the loaded Patrick Hand`, paints.length ? paints[paints.length - 1].loaded : null, out.bubblePaints, 'loaded at the last fillText (58c8849: painted before the face loaded, never repainted)');
    t.check(`${prof}: the host of each woff2 (reported)`, true, [...new Set(woff.map((w) => `${w.host} ${w.status}`))], 'fonts.gstatic.com on main; this site after D12');
    t.check(`${prof}: no layout shift in the 2 s after a face loads (D12)`, cls.length ? cls.every((f) => f.cls2s < 0.01) : null, cls, 'CLS < 0.01 per face (null: no face loaded)');
    await s.close();
  }
}

module.exports = {
  fonts: { item: 'E6d (DA-06; D12)', title: "platform fonts (CDP) of the welcome card, the Hiring pill and the Portfolio menu; Bebas Neue and Patrick Hand really loaded; the woff2 hosts; CLS after each face", profiles: ['desktop', 'phone'], run: fonts },
};
