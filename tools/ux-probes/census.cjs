'use strict';
// Scene and DOM census (E6a, from the design audit's capture.cjs). The scene
// side lists every material by type and ramp, and the lit, opaque materials
// that are not MeshToon (C3's 'one shading model': MeshStandard only on
// transparent materials, plus the player's dress until B15), grouped by where
// they sit: the zone halls, tree.glb, villagers, the player and the props.
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
    return 'props';
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
  return {
    meshes,
    hulls,
    materials: rows.length,
    byType,
    notToon: { count: off.length, byWhere: Object.fromEntries(Object.entries(offBy).map(([k, v]) => [k, { count: v.length, samples: v.slice(0, 25) }])) },
    toonWithoutRamp: { count: toonNoRamp.length, byWhere: noRampBy, samples: toonNoRamp.slice(0, 20).map((e) => `${e.color} users=${e.users} on=${e.sample}`) },
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
  return { boot: b, scene, dom };
}

async function census(t) {
  for (const prof of t.profiles(['desktop', 'phone'])) {
    const r = await censusOne(t, t.base, prof, 'subject');
    t.data[prof] = r;
    // C3's scope: the zone halls, tree.glb, the villagers and the props. The
    // player's dress waits for B15, and the interiors are wave 2's PR; both
    // are reported, not judged.
    const IN_SCOPE = ['zone halls', 'trees', 'villagers', 'props', 'terrain'];
    const off = r.scene.notToon;
    const offIn = Object.entries(off.byWhere).filter(([w]) => IN_SCOPE.includes(w));
    const nOff = offIn.reduce((n, [, v]) => n + v.count, 0);
    t.check(`${prof}: one shading model in the halls, trees, villagers and props (lit opaque materials that are not MeshToon)`, nOff === 0, nOff ? Object.fromEntries(offIn.map(([k, v]) => [k, v.count])) : 0, 0);
    const noRamp = Object.entries(r.scene.toonWithoutRamp.byWhere || {}).filter(([w]) => IN_SCOPE.includes(w));
    const nNoRamp = noRamp.reduce((n, [, v]) => n + v, 0);
    t.check(`${prof}: every MeshToon material there carries the one shared ramp`, nNoRamp === 0 && r.scene.rampWidths.length <= 1, { withoutRamp: Object.fromEntries(noRamp), rampWidths: r.scene.rampWidths }, 'all with one ramp');
    t.data[prof].reportOnly = { player: off.byWhere.player ? off.byWhere.player.count : 0, interiors: off.byWhere.interiors ? off.byWhere.interiors.count : 0 };
    if (t.compareBase) {
      const c = await censusOne(t, t.compareBase, prof, 'compare');
      t.data[`${prof}Compare`] = { scene: { byType: c.scene.byType, notToon: c.scene.notToon.count, renderer: c.scene.renderer } };
      const a = r.scene.renderer.programs;
      const m = c.scene.renderer.programs;
      // One load per side, so the boot race's 3-4 program spread is allowed;
      // perf-gate --ab (programs at +30 s over 6-24 cycles) is the authority.
      t.check(`${prof}: programs 12 s after the card, no higher than the compare build (one load, ±4 boot race)`, a !== null && m !== null ? a <= m + 4 : null, { subject: a, compare: m }, '<= compare + 4');
    }
  }
}

module.exports = {
  census: { item: 'C3 (E6a)', title: 'scene material census (one shading model, the shared ramp, programs) and the DOM style census', profiles: ['desktop', 'phone'], compare: true, run: census },
};
