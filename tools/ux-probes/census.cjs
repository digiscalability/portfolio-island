'use strict';
// Scene and DOM census (E6a, from the design audit's capture.cjs). The scene
// side lists every material by type and ramp, and the lit, opaque materials
// that are not MeshToon (C3's 'one shading model': MeshStandard only on
// transparent materials, plus the player's dress until B15), grouped by where
// they sit: the zone halls, tree.glb, villagers, the player, the props (what
// Island builds under island.mesh: C3's targets) and the scene props (what
// GameScene and RaceSystem add to the scene themselves: the race gates, the
// cruise ship, the islet beach house, road markings, rock.glb, the coins).
// The scene props are B's and wait for B15, so they are reported apart and
// judged only with --scene-props; once B15 is on main they fold into the
// default scope (SCENE_PROPS_JUDGED below).
// It also records the renderer's programs, draws and textures at a fixed
// time after the card; with --compare <main dist> it checks the subject has
// no more programs than main. The DOM side tallies radii, shadows, fonts,
// sizes, colours and emoji on screen (report only).
const lib = require('./lib.cjs');

const SCENE_CENSUS = () => {
  const app = window.__app;
  const sc = app.scene;
  const player = sc.getPlayer ? sc.getPlayer() : sc.player;
  const isl = sc.getIsland ? sc.getIsland() : sc.island;
  const zoneRoots = new Set();
  try {
    for (const z of sc.getZonesManager().getZones()) {
      if (z.marker) zoneRoots.add(z.marker);
      if (z.group) zoneRoots.add(z.group);
      if (z.mesh) zoneRoots.add(z.mesh);
    }
  } catch (e) {}
  const npcRoots = new Set();
  for (const n of (isl && isl.npcTargets) || []) if (n.meshRef) npcRoots.add(n.meshRef);
  const under = (o, test) => {
    for (let p = o; p; p = p.parent) if (test(p)) return true;
    return false;
  };
  const where = (o) => {
    if (player && under(o, (p) => p === player)) return 'player';
    if (under(o, (p) => npcRoots.has(p))) return 'villagers';
    if (under(o, (p) => zoneRoots.has(p))) return 'zone halls';
    if (under(o, (p) => /tree/i.test(p.name || '') || (p.userData && /tree\.glb/.test(p.userData.src || '')))) return 'trees';
    if (sc.interiorGroup && under(o, (p) => p === sc.interiorGroup)) return 'interiors';
    if (isl && o === isl.surfaceMesh) return 'terrain';
    // Island's own props hang under island.mesh; anything else is added to
    // the scene by GameScene or RaceSystem.
    if (isl && isl.mesh && under(o, (p) => p === isl.mesh)) return 'props';
    return 'scene props';
  };
  const LIT = new Set(['MeshStandardMaterial', 'MeshPhysicalMaterial', 'MeshLambertMaterial', 'MeshPhongMaterial', 'MeshToonMaterial']);
  const mats = new Map();
  const byType = {};
  let meshes = 0;
  let hulls = 0;
  sc.traverse((o) => {
    if (!o.material) return;
    if (o.isMesh) meshes++;
    if (o.userData && o.userData.isCelHull) hulls++;
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      if (!m) continue;
      let e = mats.get(m.uuid);
      if (!e) {
        e = { type: m.type, transparent: !!m.transparent || (typeof m.opacity === 'number' && m.opacity < 1), ramp: m.gradientMap ? (m.gradientMap.image && m.gradientMap.image.width) || '?' : null, color: m.color ? '#' + m.color.getHexString() : null, name: m.name || '', users: 0, where: new Set(), sample: o.name || (o.parent && o.parent.name) || o.type };
        mats.set(m.uuid, e);
      }
      e.users++;
      e.where.add(where(o));
    }
  });
  const rows = [...mats.values()];
  for (const e of rows) {
    const k = e.type + (e.type === 'MeshToonMaterial' ? (e.ramp ? `[ramp${e.ramp}]` : '[no ramp]') : '');
    byType[k] = (byType[k] || 0) + 1;
  }
  // The exceptions to one shading model: lit, opaque and not toon.
  const off = rows.filter((e) => LIT.has(e.type) && e.type !== 'MeshToonMaterial' && !e.transparent);
  const offBy = {};
  for (const e of off) for (const w of e.where) (offBy[w] = offBy[w] || []).push(`${e.type} ${e.color} users=${e.users} on=${e.sample}${e.name ? ` (${e.name})` : ''}`);
  const toonNoRamp = rows.filter((e) => e.type === 'MeshToonMaterial' && !e.ramp);
  const noRampBy = {};
  for (const e of toonNoRamp) for (const w of e.where) noRampBy[w] = (noRampBy[w] || 0) + 1;
  const ramps = new Set(rows.filter((e) => e.type === 'MeshToonMaterial' && e.ramp).map((e) => e.ramp));
  const R = app.renderer.getRenderer();
  // Textures (wave-4 rows list, C7): every unique texture a scene material
  // holds (map slots and shader uniforms) plus the scene's background and
  // environment, with an estimated GPU size of w x h x 4 x 4/3 (RGBA8 with
  // mipmaps). CanvasTextures are counted apart (C7 removes four 512x512).
  const texs = new Set();
  const addTex = (v) => {
    if (v && v.isTexture) texs.add(v);
  };
  sc.traverse((o) => {
    for (const m of o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : []) {
      if (!m) continue;
      for (const k of Object.keys(m)) addTex(m[k]);
      if (m.uniforms) for (const u of Object.values(m.uniforms)) if (u) addTex(u.value);
    }
  });
  addTex(sc.background);
  addTex(sc.environment);
  const texRow = { count: 0, canvas: 0, canvas512: 0, bytes: 0, canvasBytes: 0, canvas512Bytes: 0 };
  for (const tx of texs) {
    const img = tx.image || {};
    const w = img.width || img.videoWidth || 0;
    const h = img.height || img.videoHeight || 0;
    const bytes = Math.round(w * h * 4 * (4 / 3));
    texRow.count++;
    texRow.bytes += bytes;
    if (tx.isCanvasTexture) {
      texRow.canvas++;
      texRow.canvasBytes += bytes;
      if (w === 512 && h === 512) {
        texRow.canvas512++;
        texRow.canvas512Bytes += bytes;
      }
    }
  }
  texRow.MiB = Math.round((texRow.bytes / 1048576) * 100) / 100;
  texRow.canvasMiB = Math.round((texRow.canvasBytes / 1048576) * 100) / 100;
  texRow.canvas512MiB = Math.round((texRow.canvas512Bytes / 1048576) * 100) / 100;
  return {
    textures: texRow,
    meshes,
    hulls,
    materials: rows.length,
    byType,
    notToon: { count: off.length, byWhere: Object.fromEntries(Object.entries(offBy).map(([k, v]) => [k, { count: v.length, samples: v.slice(0, 25) }])) },
    toonWithoutRamp: { count: toonNoRamp.length, byWhere: noRampBy, samples: toonNoRamp.slice(0, 20).map((e) => `${e.color} users=${e.users} on=${e.sample} [${[...e.where].join(', ')}]`) },
    rampWidths: [...ramps],
    renderer: { programs: R.info.programs ? R.info.programs.length : null, textures: R.info.memory.textures, geometries: R.info.memory.geometries },
  };
};

const DOM_CENSUS = () => {
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    for (let p = el; p && p !== document.body; p = p.parentElement) {
      const cs = getComputedStyle(p);
      if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) < 0.05) return false;
    }
    return true;
  };
  const tally = (m, k) => m.set(k, (m.get(k) || 0) + 1);
  const radii = new Map();
  const shadows = new Map();
  const fonts = new Map();
  const sizes = new Map();
  const colors = new Map();
  const bgs = new Map();
  const emoji = new Map();
  const els = [...document.querySelectorAll('#ui-overlay *')].filter(vis);
  const emojiRe = /\p{Extended_Pictographic}️?/gu;
  for (const el of els) {
    const cs = getComputedStyle(el);
    if (cs.borderRadius !== '0px') tally(radii, cs.borderRadius);
    if (cs.boxShadow !== 'none') tally(shadows, cs.boxShadow);
    const own = [...el.childNodes].filter((n) => n.nodeType === 3 && n.textContent.trim()).map((n) => n.textContent.trim()).join(' ');
    if (own) {
      tally(fonts, cs.fontFamily);
      tally(sizes, cs.fontSize);
      tally(colors, cs.color);
      for (const e of own.match(emojiRe) || []) tally(emoji, e);
    }
    if (cs.backgroundColor !== 'rgba(0, 0, 0, 0)') tally(bgs, cs.backgroundColor);
  }
  const top = (m, n = 30) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
  return { visibleElements: els.length, radii: top(radii), shadows: top(shadows, 15), fonts: top(fonts), fontSizes: top(sizes, 40), textColors: top(colors), backgrounds: top(bgs), emoji: { distinct: emoji.size, top: top(emoji, 60) } };
};

/**
 * domCensus, judged (wave-3 amendments, for D13): emoji in the chrome of the
 * HUD, the menu (the Portfolio menu on desktop, the drawer on the phone) and
 * the hire card. Chrome is a control (button, link, tab, switch and the like,
 * with what is inside it), a HUD anchor ([data-guide]) and, in the menu and
 * the hire card, a heading. Narrative text may keep emoji: toasts and live
 * regions, the guide card, chat and dialogue, and body copy are not chrome.
 * The frozen pill labels ('📖 Portfolio', '💼 Work with me') are exempt as
 * whole labels. Page side; scope is 'hud', 'menu' or 'hire'.
 */
const FROZEN_LABELS = ['📖 Portfolio', '💼 Work with me'];
const EMOJI_CHROME = ({ scope, frozen }) => {
  const emojiRe = /\p{Extended_Pictographic}/gu;
  const norm = (s) => (s || '').replace(new RegExp(String.fromCharCode(0xfe0f), 'g'), '').replace(/\s+/g, ' ').trim();
  const frozenSet = new Set(frozen.map(norm));
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    for (let p = el; p && p !== document.body; p = p.parentElement) {
      const cs = getComputedStyle(p);
      if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) < 0.05) return false;
    }
    return true;
  };
  const CONTROL = 'button, a[href], [role=button], [role=link], [role=menuitem], [role=tab], [role=switch], [role=checkbox], [role=radio], summary, label, select';
  const NARRATIVE = '[aria-live], [role=status], [role=log], [role=alert], #ds-guide';
  let roots = [];
  let chromeSel = CONTROL;
  if (scope === 'hud') {
    const ov = document.getElementById('ui-overlay');
    roots = ov ? [ov] : [];
    chromeSel = `${CONTROL}, [data-guide]`;
  } else if (scope === 'menu') {
    roots = [document.getElementById('ds-drawer'), document.querySelector('[role=dialog][aria-labelledby="ds-portfolio-menu-title"]')].filter((el) => el && vis(el));
    chromeSel = `${CONTROL}, h1, h2, h3, h4, [role=heading]`;
  } else if (scope === 'hire') {
    roots = [document.querySelector('[role=dialog][data-zone="hire"]')].filter((el) => el && vis(el));
    chromeSel = `${CONTROL}, h1, h2, h3, h4, [role=heading]`;
  }
  const out = [];
  const seen = new Set();
  for (const root of roots) {
    for (const el of root.querySelectorAll(chromeSel)) {
      if (!vis(el)) continue;
      // The outermost chrome element owns its text: a span inside a button is the button's.
      let owner = el;
      for (let p = el.parentElement; p && p !== root; p = p.parentElement) if (p.matches(chromeSel)) owner = p;
      if (seen.has(owner)) continue;
      seen.add(owner);
      if (owner.closest(NARRATIVE)) continue;
      if (scope === 'hud' && owner.closest('[role=dialog], [role=alertdialog], #ds-drawer')) continue;
      const text = norm(owner.innerText || owner.textContent);
      const label = norm(owner.getAttribute('aria-label'));
      const found = text.match(emojiRe) || [];
      if (!found.length) continue;
      if (frozenSet.has(text)) continue;
      out.push({ tag: owner.tagName.toLowerCase(), text: text.slice(0, 60), label: label.slice(0, 60) || null, emoji: [...new Set(found)].join('') });
    }
  }
  return { scope, roots: roots.length, offenders: out };
};

/** --dom: open the menu and the hire card and census their chrome's emoji (D13's acceptance). */
async function domChrome(t, page, prof) {
  const res = { hud: await page.evaluate(EMOJI_CHROME, { scope: 'hud', frozen: FROZEN_LABELS }) };
  // The menu: the drawer toggle on the phone, the Portfolio pill on desktop.
  const opened = await page.evaluate(() => {
    const ui = window.__app && window.__app.ui;
    const toggle = document.querySelector('[data-guide="drawer-toggle"]');
    const r = toggle ? toggle.getBoundingClientRect() : null;
    if (toggle && r.width > 1 && r.height > 1) {
      toggle.click();
      return 'drawer';
    }
    const pill = [...document.querySelectorAll('#ui-overlay button')].find((b) => /Portfolio/.test(b.textContent || '') && b.getBoundingClientRect().width > 1);
    if (pill) {
      pill.click();
      return 'portfolio pill';
    }
    if (ui && typeof ui.togglePortfolioMenu === 'function') {
      ui.togglePortfolioMenu();
      return 'togglePortfolioMenu()';
    }
    return null;
  });
  await page.waitForTimeout(700);
  res.menu = { openedBy: opened, ...(await page.evaluate(EMOJI_CHROME, { scope: 'menu', frozen: FROZEN_LABELS })) };
  await t.shot(page, `census-dom-menu-${prof}.png`);
  await page.keyboard.press('Escape').catch(() => {});
  await page.evaluate(() => {
    const ui = window.__app && window.__app.ui;
    if (document.getElementById('ds-drawer') && ui && ui.drawerOpen && typeof ui.closeDrawer === 'function') ui.closeDrawer();
    if (ui && ui.panels && typeof ui.panels.closeAll === 'function') ui.panels.closeAll();
  });
  await page.waitForTimeout(500);
  await page.evaluate(() => window.__app && window.__app.ui && window.__app.ui.showHireCard && window.__app.ui.showHireCard('menu'));
  await page.waitForTimeout(900);
  res.hire = await page.evaluate(EMOJI_CHROME, { scope: 'hire', frozen: FROZEN_LABELS });
  await t.shot(page, `census-dom-hire-${prof}.png`);
  await page.keyboard.press('Escape').catch(() => {});
  return res;
}

async function censusOne(t, base, prof, label) {
  const s = await t.session(prof);
  const b = await t.boot(s, { base, query: 'hour=12' });
  const { page } = s;
  await page.click(`${lib.WELCOME} button[data-dismiss]`).catch(() => {});
  // tree.glb and the GLB fleet load after the card.
  await page.waitForTimeout(12000);
  const scene = await page.evaluate(SCENE_CENSUS);
  const dom = await page.evaluate(DOM_CENSUS);
  await t.shot(page, `census-${label}-${prof}.png`);
  const chrome = t.args.dom ? await domChrome(t, page, prof) : null;
  return { boot: b, scene, dom, chrome };
}

/** Flip to true once B15 (the scene props' conversion) is on main: they are judged by default from then on. */
const SCENE_PROPS_JUDGED = false;

async function census(t) {
  const judgeSceneProps = SCENE_PROPS_JUDGED || !!t.args.sceneProps;
  for (const prof of t.profiles(['desktop', 'phone'])) {
    const r = await censusOne(t, t.base, prof, 'subject');
    t.data[prof] = r;
    t.log(`${prof}: textures ${JSON.stringify(r.scene.textures)}`);
    // C3's scope: the zone halls, tree.glb, the villagers and Island's props.
    // The player's dress and the scene props wait for B15, and the interiors
    // are wave 2's PR; they are reported, not judged.
    const IN_SCOPE = ['zone halls', 'trees', 'villagers', 'props', 'terrain'];
    const off = r.scene.notToon;
    const offIn = Object.entries(off.byWhere).filter(([w]) => IN_SCOPE.includes(w));
    const nOff = offIn.reduce((n, [, v]) => n + v.count, 0);
    t.check(`${prof}: one shading model in the halls, trees, villagers and props (lit opaque materials that are not MeshToon)`, nOff === 0, nOff ? Object.fromEntries(offIn.map(([k, v]) => [k, v.count])) : 0, 0);
    const noRamp = Object.entries(r.scene.toonWithoutRamp.byWhere || {}).filter(([w]) => IN_SCOPE.includes(w));
    const nNoRamp = noRamp.reduce((n, [, v]) => n + v, 0);
    t.check(`${prof}: every MeshToon material there carries the one shared ramp`, nNoRamp === 0 && r.scene.rampWidths.length <= 1, { withoutRamp: Object.fromEntries(noRamp), rampWidths: r.scene.rampWidths }, 'all with one ramp');
    const sp = off.byWhere['scene props'] || { count: 0, samples: [] };
    const spNoRamp = (r.scene.toonWithoutRamp.byWhere || {})['scene props'] || 0;
    t.data[prof].reportOnly = { player: off.byWhere.player ? off.byWhere.player.count : 0, interiors: off.byWhere.interiors ? off.byWhere.interiors.count : 0, ...(judgeSceneProps ? {} : { sceneProps: { notToon: sp.count, toonWithoutRamp: spNoRamp, samples: sp.samples } }) };
    if (judgeSceneProps) {
      // B15's acceptance: no lit opaque non-toon scene prop, no toon without the ramp.
      t.check(`${prof}: one shading model in the scene props (B15: race gates, cruise ship, islet house, road markings, rocks)`, sp.count === 0, sp.count ? { count: sp.count, samples: sp.samples.slice(0, 8) } : 0, 0);
      t.check(`${prof}: every MeshToon scene prop carries the shared ramp (B15)`, spNoRamp === 0, spNoRamp, 0);
    } else t.log(`${prof}: scene props (B15, reported apart): ${sp.count} lit opaque non-toon, ${spNoRamp} toon without the ramp`);
    // --dom (wave-3 amendments, D13): the DOM census judged. 0 emoji in the
    // chrome of the HUD, the menu and the hire card; the frozen pill labels
    // are exempt. A menu or hire card that did not open is inconclusive.
    if (r.chrome) {
      for (const sc of ['hud', 'menu', 'hire']) {
        const c = r.chrome[sc];
        const n = c.offenders.length;
        t.check(`${prof}: emoji in the ${sc === 'hire' ? 'hire card' : sc === 'hud' ? 'HUD' : 'menu'} chrome (D13; frozen pill labels exempt)`, c.roots ? n === 0 : null, c.roots ? (n ? { count: n, offenders: c.offenders.slice(0, 12) } : 0) : `no ${sc} on screen`, 0);
      }
    }
    if (t.compareBase) {
      const c = await censusOne(t, t.compareBase, prof, 'compare');
      t.data[`${prof}Compare`] = { scene: { byType: c.scene.byType, notToon: c.scene.notToon.count, renderer: c.scene.renderer } };
      const a = r.scene.renderer.programs;
      const m = c.scene.renderer.programs;
      // One load per side, so the boot race's 3-4 program spread is allowed;
      // perf-gate --ab (programs at +30 s over 6-24 cycles) is the authority.
      t.check(`${prof}: programs 12 s after the card, no higher than the compare build (one load, ±4 boot race)`, a !== null && m !== null ? a <= m + 4 : null, { subject: a, compare: m }, '<= compare + 4');
      // C7 (wave 4). The amendment's -4 textures / -5.3 MiB counts the four
      // canvases createBuildingTextures MAKES (texgen.cjs counts those). The
      // GPU holds one: Materials.toonify keeps only 'map', so the normal, AO
      // and roughness canvases are never uploaded. MEASURED on fcaa649: one
      // 512x512 CanvasTexture in the scene (1.33 MiB). The row wants that
      // one gone (-1, about -1.3 MiB); no change reads null, more fails.
      // Judged on the 512x512 CanvasTextures (the facade size), so another
      // package's new canvas (B9's desktop-only coinGlint) cannot offset C7.
      const ts = r.scene.textures;
      const tc = c.scene.textures;
      t.data[`${prof}Compare`].scene.textures = tc;
      if (ts && tc) {
        const v = c7Verdict(ts, tc);
        t.check(`${prof}: 512x512 CanvasTextures and their estimated GPU MiB against the compare build (C7)`, v.pass, { subject: { canvas: ts.canvas, canvas512: ts.canvas512, canvas512MiB: ts.canvas512MiB, canvasMiB: ts.canvasMiB, allMiB: ts.MiB }, compare: { canvas: tc.canvas, canvas512: tc.canvas512, canvas512MiB: tc.canvas512MiB, canvasMiB: tc.canvasMiB, allMiB: tc.MiB }, delta: v.delta }, '512x512: <= -1 and <= -1.3 MiB, the facade albedo (null: unchanged; all canvases reported)');
      }
    }
  }
}

/**
 * C7's verdict from two texture rows: the change in 512x512 CanvasTextures
 * (count and estimated MiB). null when unchanged, fail when it rises.
 */
function c7Verdict(ts, tc) {
  const mib = (r) => (typeof r.canvas512MiB === 'number' ? r.canvas512MiB : Math.round(((r.canvas512 * 512 * 512 * 4 * (4 / 3)) / 1048576) * 100) / 100);
  const dN = ts.canvas512 - tc.canvas512;
  const dMiB = Math.round((mib(ts) - mib(tc)) * 100) / 100;
  const delta = { canvas512: dN, canvas512MiB: dMiB, canvas: ts.canvas - tc.canvas, canvasMiB: Math.round((ts.canvasMiB - tc.canvasMiB) * 100) / 100 };
  return { pass: dN === 0 ? null : dN < 0 ? dN <= -1 && dMiB <= -1.3 : false, delta };
}

module.exports = {
  c7Verdict,
  EMOJI_CHROME,
  FROZEN_LABELS,
  census: { item: 'C3, B15 (E6a)', title: "scene material census (one shading model, the shared ramp, programs) on C3's targets; B's scene props reported apart (--scene-props judges them); the DOM style census (--dom judges emoji in the HUD, menu and hire-card chrome, D13)", profiles: ['desktop', 'phone'], compare: true, run: census },
};
