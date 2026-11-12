'use strict';
// Phase-2 lighting probes, part 2 (P2-E1b), on p2/L.cjs. The lighting audit's
// own scripts (daycycle, weather, beacons, shadowdraws) were session temp
// files and are gone, so these are rebuilt from its report
// (docs/history/2026-11-03-ux-audit/phase2/lighting,.json): the same views,
// hours and masks, checked against the numbers it recorded on 58c8849.
//
//   npm run probe -- p2/daycycle    [--hours 6,12,21] [--views hub,beach] [--device desk|phone] [--bloom [--sweep]] [--keep]
//                                   [--compare <main dist> --compare-port <m>] --dist dist --port <n>
//   npm run probe -- p2/weather     [--device desk|phone] --dist dist --port <n>
//   npm run probe -- p2/beacons     [--device desk|phone] --dist dist --port <n>
//   npm run probe -- p2/shadowdraws [--device desk|phone] --dist dist --port <n>
//   npm run probe -- p2/edge-crawl  [--compare <main dist> --compare-port <m>] --dist dist --port <n>
//
// The hour is set at runtime through EnvironmentCycle.debugHour, the field
// ?hour= itself writes, so one load covers every hour.
const fs = require('fs');
const path = require('path');
const lib = require('../lib.cjs');
const L = require('./L.cjs');

const ZONE_LAT = 0.4636; // Districts.ts: the four ring districts
const DISTRICTS = { professional: 0, projects: Math.PI * 0.5, personal: Math.PI, contact: Math.PI * 1.5 };
const DISTRICT_HEX = { welcome: '#4caf50', professional: '#2196f3', projects: '#ff9800', personal: '#e91e63', contact: '#9c27b0' };
const ALL_VIEWS = ['hub', 'spawn', 'professional', 'projects', 'personal', 'contact', 'beach', 'highland'];
const ALL_HOURS = [0, 6, 9, 10.5, 12, 15, 18, 21];

// ------------------------------------------------------------- page side
/** Put the player and the camera at a named view. Returns where it landed. */
const VIEW = ({ view, lon, lat }) => {
  const H = window.__L;
  const sc = window.__app.scene;
  const P = sc.getPlayer();
  const isl = sc.getIsland();
  const oc = sc.getOrbitCamera();
  if (!window.__lSpawn) window.__lSpawn = { pos: P.getWorldPosition().clone(), follow: oc.followDir.clone(), pitch: oc.pitch, dist: oc.distance };
  const z = window.__lSpawn;
  const frame = (follow, pitch, dist) => {
    H.frame(follow, pitch, dist);
    if ('pitchTarget' in oc) oc.pitchTarget = pitch;
    oc.snapToPlayer();
  };
  const at = (d) => ({ lon: +Math.atan2(d.z, d.x).toFixed(3), lat: +Math.asin(d.y).toFixed(3), elevAboveSea: +(isl.analyticSurface(d).radius - isl.seaLevel()).toFixed(2) });
  if (view === 'spawn') {
    P.setWorldPosition(z.pos.clone());
    frame(z.follow, z.pitch, z.dist);
    return at(z.pos.clone().normalize());
  }
  if (view === 'hub') {
    // The design audit's hub-wide framing (the perf gate's 'hub' view).
    P.setWorldPosition(z.pos.clone());
    const p = z.pos.clone().normalize();
    const f = new H.V3(0.2, 0, 1);
    frame(f.addScaledVector(p, -f.dot(p)).normalize(), -0.62, 12);
    return at(p);
  }
  if (view === 'beach') {
    // The beach band: dry land below lat 0.32 (Island's dark-zone rule).
    for (let lo = 0.4; lo < 0.4 + Math.PI * 2; lo += 0.1)
      for (let la = 0.29; la >= 0.14; la -= 0.01) {
        const d = H.lonlat(lo, la);
        if (isl.isOverWater(d) || isl.analyticSurface(d).radius - isl.seaLevel() < 0.5) continue;
        H.tp(d);
        frame(H.north(d), -0.5, 10); // the camera inland of the player, looking out to sea
        return at(d);
      }
    return null;
  }
  if (view === 'highland') {
    // The highland shoulder: above MAX_DISPLACEMENT x 0.42 x reliefScale, short of the summit.
    const thr = (isl.constructor.MAX_DISPLACEMENT || 0) * 0.42 * (isl.reliefScale || 1);
    if (!(thr > 0)) return null;
    for (let la = 0.5; la <= 1.25; la += 0.03)
      for (let lo = 0; lo < Math.PI * 2; lo += 0.06) {
        const d = H.lonlat(lo, la);
        const e = isl.analyticSurface(d).radius - isl.seaLevel();
        if (e < thr * 1.15 || e > thr * 1.7) continue;
        H.tp(d);
        frame(H.north(d).negate(), -0.5, 10);
        return at(d);
      }
    return null;
  }
  // A ring district: at its centre (the perf gate's Projects pose), the camera to the south.
  const d = H.lonlat(lon, lat);
  H.tp(d);
  frame(H.north(d).negate(), -0.38, 9);
  return at(d);
};

const SET_HOUR = (h) => {
  const env = window.__app.scene.getEnvironmentCycle();
  if (!('debugHour' in env)) return null;
  env.debugHour = h;
  return true;
};

const BLOOM = () => {
  const sr = window.__app.renderer;
  const b = sr.bloomPass;
  return b ? { enabled: !!b.enabled, threshold: b.threshold, strength: +b.strength.toFixed(3), lever: typeof sr.setBloomNight === 'function' } : null;
};

/** A resolution or rung change (half-rate shadows, half the grass) must not read as light. */
const PIN_GOVERNOR = () => {
  const sr = window.__app.renderer;
  sr.governorArmed = false;
  sr.governorArmAccum = -1e12;
  return true;
};

// -------------------------------------------------------------- node side
const Yof = (c) => (c && typeof c.Y === 'number' ? c.Y : null);
const ratio = (a, b) => (a !== null && b ? +(a / b).toFixed(2) : null);
const numList = (v, dflt) => (v && v !== true ? String(v).split(',').map(Number).filter((x) => Number.isFinite(x)) : dflt);

async function openWorld(t, prof, base, { hour = 12, fresh = false, opts = {} } = {}) {
  const s = fresh ? await t.freshSession(prof, opts) : await t.session(prof, opts);
  await t.boot(s, { query: `hour=${hour}`, base });
  await s.page.evaluate(L.installHelpers);
  if (lib.isTouchProfile(prof)) await s.page.tap(`${lib.WELCOME} button[data-dismiss]`).catch(() => lib.dismissWelcome(s.page));
  else await lib.dismissWelcome(s.page);
  // Past the intro's glide and the late model loads.
  await s.page.waitForTimeout(3500);
  await s.page.evaluate(PIN_GOVERNOR);
  return s;
}

const viewArg = (view) => (view in DISTRICTS ? { view, lon: DISTRICTS[view], lat: ZONE_LAT } : { view });

/** One build's captures: rows[profile][hour][view] = { where, sun, cats, player }. */
async function captureCycle(t, base, label, profiles, hours, views, { keep }) {
  const out = {};
  for (const prof of profiles) {
    const s = await openWorld(t, prof, base);
    const { page } = s;
    out[prof] = {};
    for (const h of hours) {
      if ((await page.evaluate(SET_HOUR, h)) === null) throw new Error('hook missing: EnvironmentCycle.debugHour');
      await page.waitForTimeout(1600);
      out[prof][h] = {};
      for (const view of views) {
        const where = await page.evaluate(VIEW, viewArg(view));
        if (!where) {
          out[prof][h][view] = { error: 'no such place on this island' };
          continue;
        }
        await page.waitForTimeout(700);
        const sun = await page.evaluate(L.sunState);
        const stem = path.join(t.out, `${label}-${prof}-h${String(h).replace('.', 'p')}-${view}`);
        const pair = await L.capturePair(page, stem, { hideUi: true, zones: true });
        const st = L.frameStats(pair.a, pair.m);
        out[prof][h][view] = { where, sun, cats: st.cats, player: st.player || null, frameLstar: st.frameLstar };
        // Keep the frames Abbas is shown (06, 18 and 21 h at the hub, the beach band and the highland); drop the rest.
        const shown = [6, 12, 18, 21].includes(h) && ['hub', 'beach', 'highland'].includes(view);
        if (!keep) {
          fs.rmSync(pair.m, { force: true });
          if (!shown) fs.rmSync(pair.a, { force: true });
        }
        if (keep || shown) t.data.frames = [...(t.data.frames || []), pair.a];
      }
      t.log(`${label} ${prof} ${h} h: ${views.map((v) => `${v} ${((out[prof][h][v].cats || {}).groundAll || {}).Lstar ?? '-'}`).join(', ')}`);
    }
    await page.evaluate(SET_HOUR, null);
    await s.close();
  }
  return out;
}

/** The night bloom threshold the plan decided (P2-E5): 1.0 at night, 0.85 by day, a smoothstep between day factors 0.3 and 0.8. */
const bloomCurve = (day) => {
  const x = Math.max(0, Math.min(1, (day - 0.3) / 0.5));
  return +(1.0 + (0.85 - 1.0) * (x * x * (3 - 2 * x))).toFixed(4);
};

/** Ground, player, bulb, halo (within 6 px of a bulb), prop and whole-frame L* of one frame against a bulbs mask. */
function bloomStats(normalFile, maskFile) {
  const A = L.readPNG(normalFile);
  const M = L.readPNG(maskFile);
  const W = A.width;
  const H = A.height;
  const cat = new Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) cat[y * W + x] = L.classify(M, x, y);
  const acc = {};
  const add = (k, Y) => {
    const e = (acc[k] = acc[k] || { n: 0, s: 0 });
    e.n++;
    e.s += Y;
  };
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const Y = L.lumAt(A, i * 4);
      add('frame', Y);
      const c = cat[i];
      if (c) add(c, Y);
      if (c !== 'bulb') {
        let near = false;
        for (const [dx, dy] of [[3, 0], [-3, 0], [0, 3], [0, -3], [6, 0], [-6, 0], [0, 6], [0, -6]]) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx >= 0 && xx < W && yy >= 0 && yy < H && cat[yy * W + xx] === 'bulb') {
            near = true;
            break;
          }
        }
        if (near) add('halo', Y);
      }
    }
  const Ls = (k) => (acc[k] ? +L.Lstar(acc[k].s / acc[k].n).toFixed(1) : null);
  return { ground: Ls('ground'), player: Ls('player'), bulb: Ls('bulb'), halo: Ls('halo'), prop: Ls('prop'), frame: Ls('frame'), bulbShare: acc.bulb ? +(acc.bulb.n / (W * H)).toFixed(4) : 0 };
}

/** One frozen frame under several bloom settings (the loop stopped throughout), and its bulbs mask. */
async function bloomVariants(page, stem, variants) {
  await L.setUi(page, false);
  await page.evaluate(L.pauseLoop);
  const files = {};
  for (const v of variants) {
    await page.evaluate(({ enabled, threshold }) => {
      const sr = window.__app.renderer;
      sr.setBloomEnabled(enabled);
      if (threshold !== null && threshold !== undefined) sr.bloomPass.threshold = threshold;
      sr.render();
    }, v);
    await page.waitForTimeout(60);
    files[v.tag] = await L.shot(page, `${stem}-${v.tag}.png`);
  }
  await page.evaluate(L.maskBegin, { cats: L.CATS, bulbs: true });
  await page.evaluate(L.renderOnce);
  await page.waitForTimeout(60);
  const mask = await L.shot(page, `${stem}.mask.png`);
  await page.evaluate(L.maskEnd);
  return { files, mask };
}

/**
 * P2-E5: one frozen frame at 12 and 21 h, at Professional and the hub, under
 * today's bloom ('on'), the decided night threshold ('night': the build's own
 * setBloomNight where it has one, else the probe writes the curve's value)
 * and the bloom pass off. --sweep adds thresholds 0.90 and 0.95.
 */
async function bloomRun(t) {
  const prof = 'desktop';
  const s = await openWorld(t, prof, t.base);
  const { page } = s;
  const rows = {};
  for (const h of [12, 21]) {
    await page.evaluate(SET_HOUR, h);
    await page.waitForTimeout(1600);
    for (const view of ['professional', 'hub']) {
      await page.evaluate(VIEW, viewArg(view));
      await page.waitForTimeout(900);
      const sun = await page.evaluate(L.sunState);
      const asBuilt = await page.evaluate(BLOOM);
      if (!asBuilt) throw new Error('hook missing: __app.renderer.bloomPass (no composer on this profile)');
      const want = bloomCurve(sun.day);
      // The build's own lever where it has one (so the curve measured is the build's).
      const lever = asBuilt.lever
        ? await page.evaluate((day) => {
            const sr = window.__app.renderer;
            const was = sr.bloomPass.threshold;
            sr.setBloomNight(day);
            const v = sr.bloomPass.threshold;
            sr.bloomPass.threshold = was;
            return v;
          }, sun.day)
        : null;
      const driven = Math.abs(asBuilt.threshold - want) < 0.005 && h === 21;
      const nightBy = driven ? 'the build, already driving it' : lever !== null ? 'setBloomNight, called by the probe (no caller on this build)' : 'the probe, writing the threshold (no setBloomNight on this build)';
      const variants = [
        { tag: 'on', enabled: true, threshold: asBuilt.threshold },
        { tag: 'night', enabled: true, threshold: lever !== null ? lever : want },
        ...(t.args.sweep ? [0.9, 0.95].map((x) => ({ tag: `t${x}`, enabled: true, threshold: x })) : []),
        { tag: 'off', enabled: false, threshold: null },
      ];
      const cap = await bloomVariants(page, path.join(t.out, `bloom-h${h}-${view}`), variants);
      const row = { sun, asBuilt, nightThreshold: lever !== null ? lever : want, nightBy };
      for (const v of variants) row[v.tag] = bloomStats(cap.files[v.tag], cap.mask);
      fs.rmSync(cap.mask, { force: true });
      t.data.frames = [...(t.data.frames || []), ...Object.values(cap.files)];
      // Put the pass back as the build had it.
      await page.evaluate((b) => {
        const sr = window.__app.renderer;
        sr.setBloomEnabled(b.enabled);
        sr.bloomPass.threshold = b.threshold;
        sr.render();
      }, asBuilt);
      await page.evaluate(L.resumeLoop);
      await L.setUi(page, true);
      rows[`h${h}-${view}`] = row;
      t.log(`bloom ${h} h ${view} (night threshold ${row.nightThreshold}, ${nightBy}): ${variants.map((v) => `${v.tag} ${JSON.stringify(row[v.tag])}`).join(' ')}`);
    }
  }
  await page.evaluate(SET_HOUR, null);
  t.data.bloom = rows;
  const d = (a, b) => (a === null || b === null || a === undefined || b === undefined ? null : +(a - b).toFixed(1));
  for (const view of ['professional', 'hub']) {
    const n = rows[`h21-${view}`];
    const x = n.night;
    t.check(`21 h ${view}: ground against bloom-off, L* (threshold ${n.nightThreshold}, by ${n.nightBy})`, d(x.ground, n.off.ground) !== null ? Math.abs(d(x.ground, n.off.ground)) <= 1 : null, d(x.ground, n.off.ground), 'within +-1');
    t.check(`21 h ${view}: player against bloom-off, L*`, d(x.player, n.off.player) !== null ? Math.abs(d(x.player, n.off.player)) <= 2 : null, d(x.player, n.off.player), 'within +-2');
    t.check(`21 h ${view}: bulb pixels against bloom-off, L*`, d(x.bulb, n.off.bulb) !== null ? d(x.bulb, n.off.bulb) >= 5 : null, d(x.bulb, n.off.bulb) === null ? 'no bulb pixels in view' : `${d(x.bulb, n.off.bulb)} (today's bloom: ${d(n.on.bulb, n.off.bulb)}; the halo within 6 px: ${d(x.halo, n.off.halo)}, today ${d(n.on.halo, n.off.halo)})`, '>= +5');
    const day = rows[`h12-${view}`];
    t.check(`12 h ${view}: the frame against today's bloom, L*`, Math.abs(d(day.night.frame, day.on.frame)) <= 1 && Math.abs(d(day.night.ground, day.on.ground)) <= 1, { frame: d(day.night.frame, day.on.frame), ground: d(day.night.ground, day.on.ground) }, 'within +-1');
  }
}

async function daycycle(t) {
  if (t.args.bloom) return bloomRun(t);
  const hours = numList(t.args.hours, ALL_HOURS);
  const views = t.args.views && t.args.views !== true ? String(t.args.views).split(',') : ALL_VIEWS;
  const profiles = t.profiles(['desktop', 'phone']);
  const keep = !!t.args.keep;
  const rows = await captureCycle(t, t.base, 'subject', profiles, hours, views, { keep });
  t.data.rows = rows;
  const main = t.compareBase ? await captureCycle(t, t.compareBase, 'main', profiles, hours, views, { keep }) : null;
  if (main) t.data.main = main;
  const g = (set, prof, h, view, cat = 'groundAll') => (((set[prof] || {})[h] || {})[view] || {}).cats ? ((set[prof][h][view].cats[cat] || {}).Lstar ?? null) : null;
  const cell = (set, prof, h, view) => ((set[prof] || {})[h] || {})[view] || {};
  const have = (h) => hours.includes(h);
  const dv = views.filter((v) => v in DISTRICTS);
  for (const prof of profiles) {
    // P2-C1: every district lit for its own hour.
    const mid = [9, 10.5, 12, 15].filter(have);
    if (mid.length && dv.length && views.includes('hub')) {
      const worst = { d: Infinity };
      const elev = { d: Infinity };
      const shad = { d: Infinity };
      for (const h of mid)
        for (const v of dv) {
          if (g(rows, prof, h, v) === null || g(rows, prof, h, 'hub') === null) continue;
          const delta = g(rows, prof, h, v) - g(rows, prof, h, 'hub');
          if (delta < worst.d) Object.assign(worst, { d: +delta.toFixed(1), at: `${v} ${h} h (${g(rows, prof, h, v)} vs hub ${g(rows, prof, h, 'hub')})` });
          const sun = cell(rows, prof, h, v).sun || {};
          if (sun.elevDeg < elev.d) Object.assign(elev, { d: sun.elevDeg, at: `${v} ${h} h` });
          if (sun.shadowIntensity < shad.d) Object.assign(shad, { d: sun.shadowIntensity, at: `${v} ${h} h` });
        }
      t.check(`${prof}: district ground against the hub, ${mid.join('/')} h (worst, L*)`, worst.d >= -5, `${worst.d} at ${worst.at}`, '>= -5');
      t.check(`${prof}: the sun's elevation at each district, ${mid.join('/')} h (lowest, degrees)`, elev.d >= 40, `${elev.d} at ${elev.at}`, '>= 40');
      t.check(`${prof}: shadow strength at each district, ${mid.join('/')} h (lowest)`, shad.d >= 0.999, `${shad.d} at ${shad.at}`, '1');
    }
    if (have(10.5) && views.includes('professional') && views.includes('hub')) t.data[`${prof}ProfessionalBelowHubAt1030`] = +(g(rows, prof, 10.5, 'hub') - g(rows, prof, 10.5, 'professional')).toFixed(1);
    // C1: golden hour.
    for (const h of [6, 18].filter(have)) {
      const gv = views.filter((v) => v !== 'beach' && v !== 'highland');
      const low = gv.map((v) => [v, g(rows, prof, h, v)]).filter(([, x]) => x !== null).sort((a, b) => a[1] - b[1])[0];
      if (low) t.check(`${prof}: ground at ${h} h (lowest of ${gv.length} views, L*)`, low[1] >= 40, `${low[1]} at ${low[0]}`, '>= 40');
      const hub = cell(rows, prof, h, 'hub');
      if (hub.cats) {
        const r = ratio(Yof(hub.cats.sky), Yof(hub.cats.groundAll));
        t.check(`${prof}: sky to ground luminance at ${h} h, hub`, r !== null ? r <= 3 : null, r, '<= 3:1');
        t.check(`${prof}: shadow strength at the player at ${h} h, hub`, hub.sun && hub.sun.shadowIntensity !== null ? hub.sun.shadowIntensity >= 0.9 : null, hub.sun ? hub.sun.shadowIntensity : null, '>= 0.9');
      }
      const sp = cell(rows, prof, h, 'spawn');
      if (sp.cats && sp.cats.player) t.check(`${prof}: the player at ${h} h, spawn (L*)`, sp.cats.player.Lstar >= 18, sp.cats.player.Lstar, '>= 18');
    }
    // C5: faces at night, dark patches kept.
    if (have(21) && views.includes('hub')) {
      const hub = cell(rows, prof, 21, 'hub');
      const p = hub.cats && hub.cats.player;
      t.check(`${prof}: the player at 21 h, hub (median and p90 L*)`, p ? p.L50 >= 14 && p.L90 >= 25 : null, p ? { median: p.L50, p90: p.L90 } : 'no player pixels', 'median >= 14, p90 >= 25');
      t.check(`${prof}: hub ground at 21 h (L*)`, g(rows, prof, 21, 'hub') <= 28, g(rows, prof, 21, 'hub'), '<= 28 (night stays night)');
      const rg = hub.cats ? ratio(Yof(hub.cats.path), Yof(hub.cats.groundAll)) : null;
      t.check(`${prof}: road to ground luminance at 21 h, hub`, rg !== null ? rg >= 2.5 : null, rg, '>= 2.5:1');
    }
    if (main) {
      if (have(12) && views.includes('hub')) {
        const d = +(g(rows, prof, 12, 'hub') - g(main, prof, 12, 'hub')).toFixed(1);
        t.check(`${prof}: noon hub ground against main (L*)`, Math.abs(d) <= 1.2, d, 'within +-1.2');
      }
      if (have(21)) {
        for (const [view, cat] of [
          ['beach', 'beach'],
          ['highland', 'highland'],
        ]) {
          if (!views.includes(view)) continue;
          const a = g(main, prof, 21, view, cat);
          const b = g(rows, prof, 21, view, cat);
          t.check(`${prof}: ${view === 'beach' ? 'beach-band' : 'highland-shoulder'} ground at 21 h against main (L*)`, a !== null && b !== null ? b - a <= 3 : null, a !== null && b !== null ? `${+(b - a).toFixed(1)} (${b} vs ${a})` : 'no such pixels', '<= +3');
        }
        if (views.includes('hub')) {
          const d = +(g(rows, prof, 21, 'hub', 'sky') - g(main, prof, 21, 'hub', 'sky')).toFixed(1);
          if (prof === 'desktop') t.check('desktop: the 21 h sky against main (L*)', Math.abs(d) <= 2, d, 'within +-2');
          else t.data.phoneSky21VsMain = d;
        }
      }
    }
  }
  // P2-B4: the phone's sky against desktop's.
  if (profiles.includes('desktop') && profiles.includes('phone') && views.includes('hub')) {
    const hs = [0, 6, 12, 18, 21].filter(have);
    const worst = hs.map((h) => [h, +(g(rows, 'phone', h, 'hub', 'sky') - g(rows, 'desktop', h, 'hub', 'sky')).toFixed(1)]).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))[0];
    if (worst) t.check(`phone sky against desktop, hub, ${hs.join('/')} h (worst, L*)`, Math.abs(worst[1]) <= 3, `${worst[1]} at ${worst[0]} h`, 'within +-3');
  }
}

// ------------------------------------------------------------------ weather
/** Shadow contrast on the ground: 1 - Y(as rendered) / Y(shadows off), over the pixels the shadow darkens. */
function shadowContrast(normalFile, noShadowFile, maskFile) {
  const A = L.readPNG(normalFile);
  const B = L.readPNG(noShadowFile);
  const M = L.readPNG(maskFile);
  const ds = [];
  let ground = 0;
  for (let y = 0; y < A.height; y += 2)
    for (let x = 0; x < A.width; x += 2) {
      const c = L.classify(M, x, y);
      if (c !== 'ground' && c !== 'path') continue;
      ground++;
      const k = (y * A.width + x) * 4;
      const yb = L.lumAt(B, k);
      if (yb < 0.01) continue;
      const d = 1 - L.lumAt(A, k) / yb;
      if (d > 0.04) ds.push(d);
    }
  ds.sort((a, b) => a - b);
  return { shadowedSamples: ds.length, shadowedShare: ground ? +(ds.length / ground).toFixed(3) : null, contrast: ds.length > 50 ? +ds[Math.floor(ds.length / 2)].toFixed(3) : 0, p90: ds.length > 50 ? +ds[Math.floor(ds.length * 0.9)].toFixed(3) : 0 };
}

/** The frame with the key light's shadows switched off (loop paused, restored after). */
async function noShadowShot(page, file) {
  await page.evaluate(() => {
    const sc = window.__app.scene;
    window.__app.renderer.stopRenderLoop();
    let sun = null;
    sc.traverse((o) => { if (!sun && o.isDirectionalLight && o.castShadow) sun = o; });
    window.__lSun = { sun, was: sun.shadow.intensity };
    sun.shadow.intensity = 0;
    window.__app.renderer.render();
  });
  await page.waitForTimeout(60);
  await L.shot(page, file);
  await page.evaluate(() => {
    const s = window.__lSun;
    s.sun.shadow.intensity = s.was;
    const sr = window.__app.renderer;
    sr.render();
    sr.isRunning = false;
    sr.startRenderLoop(sr.scene, sr.camera, sr.renderCallback);
  });
}

async function weather(t) {
  for (const prof of t.profiles(['desktop'])) {
    const s = await openWorld(t, prof, t.base);
    const { page } = s;
    const rows = {};
    for (const w of ['clear', 'cloudy', 'rain', 'snow']) {
      const ok = await page.evaluate((k) => {
        const env = window.__app.scene.getEnvironmentCycle();
        if (typeof env.setWeather !== 'function') return false;
        env.setWeather(k);
        return true;
      }, w);
      if (!ok) throw new Error('hook missing: EnvironmentCycle.setWeather');
      await page.waitForTimeout(6000); // the sky, fog and sun ease into a weather
      await page.evaluate(VIEW, { view: 'hub' });
      await page.waitForTimeout(700);
      const sun = await page.evaluate(L.sunState);
      const stem = path.join(t.out, `weather-${prof}-${w}`);
      await L.setUi(page, false);
      const pair = await L.capturePair(page, stem, {});
      await noShadowShot(page, `${stem}.noshadow.png`);
      await L.setUi(page, true);
      const st = L.frameStats(pair.a, pair.m);
      rows[w] = { sun, groundLstar: (st.cats.ground || {}).Lstar ?? null, skyLstar: (st.cats.sky || {}).Lstar ?? null, ...shadowContrast(pair.a, `${stem}.noshadow.png`, pair.m) };
      fs.rmSync(pair.m, { force: true });
      fs.rmSync(`${stem}.noshadow.png`, { force: true });
      t.data.frames = [...(t.data.frames || []), pair.a];
      t.log(`${prof} ${w}: ${JSON.stringify(rows[w])}`);
    }
    await page.evaluate(() => window.__app.scene.getEnvironmentCycle().setWeather('clear'));
    t.data[prof] = rows;
    const r = rows.clear.contrast ? +(rows.rain.contrast / rows.clear.contrast).toFixed(2) : null;
    t.check(`${prof}: clear noon has a shadow to measure`, rows.clear.contrast > 0.1 && rows.clear.shadowedSamples >= 200, { contrast: rows.clear.contrast, samples: rows.clear.shadowedSamples }, 'contrast > 0.1 on 200 samples or more');
    t.check(`${prof}: noon-rain shadow contrast against clear`, r !== null ? r <= 0.3 : null, r === null ? 'no clear shadow' : `${r}x (rain ${rows.rain.contrast}, clear ${rows.clear.contrast}; shadow strength ${rows.rain.sun.shadowIntensity})`, '<= 0.3x');
  }
}

// ------------------------------------------------------------------ beacons
const BEACON = ({ id }) => {
  const sc = window.__app.scene;
  const z = sc.getZonesManager().getZoneById(id);
  const b = z && z.marker ? z.marker.getObjectByName('zone-beacon') : null;
  if (!b || !b.material) return null;
  const m = b.material;
  return { emissive: m.emissive ? '#' + m.emissive.getHexString() : null, intensity: typeof m.emissiveIntensity === 'number' ? +m.emissiveIntensity.toFixed(3) : null, color: m.color ? '#' + m.color.getHexString() : null, type: m.type };
};
/** Stand back from a hall on the side nearest the spawn and look up at its roof. */
const BEACON_VIEW = ({ id, dist, pitch, side }) => {
  const H = window.__L;
  const sc = window.__app.scene;
  const z = sc.getZonesManager().getZoneById(id);
  if (!z) return null;
  const c = z.getPosition().clone();
  const n = c.clone().normalize();
  const home = (window.__lSpawn ? window.__lSpawn.pos : sc.getPlayer().getWorldPosition()).clone();
  let away = home.sub(c);
  away.addScaledVector(n, -away.dot(n));
  if (away.lengthSq() < 1) away = H.north(n).negate();
  away.normalize().multiplyScalar(side || 1);
  const d = c.clone().addScaledVector(away, 7).normalize();
  H.tp(d);
  const oc = sc.getOrbitCamera();
  H.frame(away, pitch, dist);
  if ('pitchTarget' in oc) oc.pitchTarget = pitch;
  oc.snapToPlayer();
  return true;
};
/** The mask with the beacon alone in its own colour (one channel at 0: see L.CATS). */
const BEACON_MASK = ({ id, cats }) => {
  const sc = window.__app.scene;
  const b = sc.getZonesManager().getZoneById(id).marker.getObjectByName('zone-beacon');
  let Basic = null;
  sc.traverse((o) => { if (!Basic && o.material && !Array.isArray(o.material) && o.material.type === 'MeshBasicMaterial') Basic = o.material.constructor; });
  const m = new Basic({ fog: false });
  m.color.setRGB(0, 0.3, 0.6, 'srgb-linear');
  m.toneMapped = false;
  b.material = m; // maskEnd puts the real one back (maskBegin saved it) and disposes this one
  window.__L.mask.matCache.beacon = m;
  return !!cats;
};

function beaconPixels(normalFile, maskFile) {
  const A = L.readPNG(normalFile);
  const M = L.readPNG(maskFile);
  const W = A.width;
  const H = A.height;
  const is = new Uint8Array(W * H);
  let n = 0;
  let r = 0;
  let g = 0;
  let b = 0;
  for (let i = 0; i < W * H; i++) {
    const k = i * 4;
    if (M.data[k] + Math.abs(M.data[k + 1] - 149) + Math.abs(M.data[k + 2] - 203) <= 18) {
      is[i] = 1;
      n++;
      r += A.data[k];
      g += A.data[k + 1];
      b += A.data[k + 2];
    }
  }
  if (n < 12) return { pixels: n };
  // The halo: pixels within 8 px of the beacon that are not the beacon.
  let hn = 0;
  let hy = 0;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      if (is[y * W + x]) continue;
      let near = false;
      for (let dy = -8; dy <= 8 && !near; dy += 4) for (let dx = -8; dx <= 8 && !near; dx += 4) if (y + dy >= 0 && y + dy < H && x + dx >= 0 && x + dx < W && is[(y + dy) * W + x + dx]) near = true;
      if (!near) continue;
      hn++;
      hy += L.lumAt(A, (y * W + x) * 4);
    }
  const rgb = [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
  return { pixels: n, rgb, ...L.hueOf(rgb), haloLstar: hn ? +L.Lstar(hy / hn).toFixed(1) : null };
}

async function beaconShot(page, stem, id) {
  await page.evaluate(L.pauseLoop);
  await page.evaluate(L.renderOnce);
  await page.waitForTimeout(60);
  const a = await L.shot(page, `${stem}.png`);
  await page.evaluate(L.maskBegin, L.CATS);
  await page.evaluate(BEACON_MASK, { id, cats: true });
  await page.evaluate(L.renderOnce);
  await page.waitForTimeout(60);
  const m = await L.shot(page, `${stem}.mask.png`);
  await page.evaluate(L.maskEnd);
  await page.evaluate(L.renderOnce);
  await page.evaluate(L.resumeLoop);
  const px = beaconPixels(a, m);
  fs.rmSync(m, { force: true });
  return { a, ...px };
}

async function beacons(t) {
  const hexHue = (hex) => L.hueOf([parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)]).hue;
  for (const prof of t.profiles(['desktop'])) {
    const s = await openWorld(t, prof, t.base);
    const { page } = s;
    const rows = {};
    for (const h of [12, 21]) {
      await page.evaluate(SET_HOUR, h);
      await page.waitForTimeout(1600);
      for (const id of Object.keys(DISTRICT_HEX)) {
        const mat = await page.evaluate(BEACON, { id });
        if (!mat) throw new Error(`hook missing: the zone-beacon mesh of ${id}`);
        let px = { pixels: 0 };
        for (const [dist, pitch, side] of [
          [11, -0.12, 1],
          [15, -0.22, 1],
          [9, 0.05, 1],
          [20, -0.3, 1],
          [11, -0.12, -1],
          [18, -0.25, -1],
        ]) {
          await page.evaluate(BEACON_VIEW, { id, dist, pitch, side });
          await page.waitForTimeout(600);
          await L.setUi(page, false);
          px = await beaconShot(page, path.join(t.out, `beacon-${prof}-h${h}-${id}`), id);
          await L.setUi(page, true);
          if (px.pixels >= 12) break;
        }
        const row = { material: mat, authored: DISTRICT_HEX[id], authoredHue: hexHue(DISTRICT_HEX[id]), ...px };
        row.hueOff = px.hue === undefined || px.hue === null ? null : +L.hueDiff(px.hue, row.authoredHue).toFixed(1);
        // Desktop: the same frame with the bloom pass off, for the halo.
        if (px.pixels >= 12 && (await page.evaluate(BLOOM))) {
          await page.evaluate(() => window.__app.renderer.setBloomEnabled(false));
          await L.setUi(page, false);
          const off = await beaconShot(page, path.join(t.out, `beacon-${prof}-h${h}-${id}-nobloom`), id);
          await L.setUi(page, true);
          await page.evaluate(() => window.__app.renderer.setBloomEnabled(true));
          row.haloBloomDeltaL = off.haloLstar !== null && px.haloLstar !== null ? +(px.haloLstar - off.haloLstar).toFixed(1) : null;
          fs.rmSync(off.a, { force: true });
        }
        rows[`h${h}-${id}`] = row;
        t.data.frames = [...(t.data.frames || []), px.a];
        t.log(`${prof} ${h} h ${id}: ${JSON.stringify({ ...row, a: undefined })}`);
      }
    }
    await page.evaluate(SET_HOUR, null);
    t.data[prof] = rows;
    for (const h of [12, 21]) {
      const ids = Object.keys(DISTRICT_HEX);
      const want = h === 12 ? 1.0 : 1.3;
      const offI = ids.filter((id) => Math.abs(rows[`h${h}-${id}`].material.intensity - want) > 0.02).map((id) => `${id} ${rows[`h${h}-${id}`].material.intensity}`);
      t.check(`${prof}: beacon emissive intensity at ${h} h`, offI.length === 0, offI.length ? offI : want, String(want));
      const offC = ids.filter((id) => rows[`h${h}-${id}`].material.emissive !== DISTRICT_HEX[id]).map((id) => `${id} ${rows[`h${h}-${id}`].material.emissive} (authored ${DISTRICT_HEX[id]})`);
      t.check(`${prof}: beacon emissive equals the district colour at ${h} h`, offC.length === 0, offC.length ? offC : 'all five', 'the authored colour');
      const seen = ids.filter((id) => rows[`h${h}-${id}`].hueOff !== null);
      const offH = seen.filter((id) => rows[`h${h}-${id}`].hueOff > 10).map((id) => `${id} ${rows[`h${h}-${id}`].hueOff} deg off (hue ${rows[`h${h}-${id}`].hue}, authored ${rows[`h${h}-${id}`].authoredHue})`);
      t.check(`${prof}: a rendered beacon's hue against its district colour at ${h} h`, seen.length < ids.length ? null : offH.length === 0, seen.length < ids.length ? `beacon not in view: ${ids.filter((id) => !seen.includes(id)).join(', ')}` : offH.length ? offH : 'all within 10 deg', 'within +-10 deg');
    }
    const pj = rows['h12-projects'];
    if (pj && pj.haloBloomDeltaL !== undefined) t.check(`${prof}: the Projects beacon's halo at noon, bloom on against off (L*)`, pj.haloBloomDeltaL !== null ? pj.haloBloomDeltaL <= 1.5 : null, pj.haloBloomDeltaL, '<= +1.5 (it does not bloom)');
  }
}

// -------------------------------------------------------------- shadowdraws
// Shadow draws per frame, counted where WebGLShadowMap.render adds them.
const SHADOW_HOOK = () => {
  const sr = window.__app.renderer;
  const R = sr.getRenderer();
  if (window.__sd) return true;
  const S = (window.__sd = { now: 0, frames: [] });
  R.info.autoReset = false;
  const sm = R.shadowMap;
  const origS = sm.render;
  sm.render = function () {
    const c0 = R.info.render.calls;
    const r = origS.apply(this, arguments);
    S.now += R.info.render.calls - c0;
    if (R.info.render.calls > c0) S.passAt = window.__app.scene.getPlayer().getWorldPosition().clone();
    return r;
  };
  const proto = Object.getPrototypeOf(sr).render;
  sr.render = function () {
    R.info.reset();
    S.now = 0;
    proto.call(this);
    const p = window.__app.scene.getPlayer().getWorldPosition();
    S.frames.push({ shadow: S.now, draws: R.info.render.calls, lag: S.passAt ? +p.distanceTo(S.passAt).toFixed(4) : null });
    if (S.frames.length > 4000) S.frames.splice(0, 1000);
  };
  return true;
};
const SHADOW_READ = ({ n }) => {
  const fr = window.__sd.frames.slice(-n);
  const pass = fr.filter((f) => f.shadow > 0);
  const avg = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
  const sr = window.__app.renderer;
  return {
    frames: fr.length,
    passes: pass.length,
    perPass: pass.length ? +avg(pass.map((f) => f.shadow)).toFixed(1) : 0,
    perFrame: +avg(fr.map((f) => f.shadow)).toFixed(1),
    draws: +avg(fr.map((f) => f.draws)).toFixed(1),
    maxLagU: fr.reduce((m, f) => Math.max(m, f.lag || 0), 0),
    autoUpdate: sr.getRenderer().shadowMap.autoUpdate,
    mapSize: (() => {
      let sun = null;
      window.__app.scene.traverse((o) => { if (!sun && o.isDirectionalLight && o.castShadow) sun = o; });
      return sun ? sun.shadow.mapSize.x : null;
    })(),
  };
};

async function shadowdraws(t) {
  for (const prof of t.profiles(['desktop', 'lowtier'])) {
    const low = prof !== 'desktop';
    const s = await t.session(prof, { clock: true });
    const { page } = s;
    await t.boot(s, { query: 'hour=12' });
    await page.evaluate(L.installHelpers);
    if (lib.isTouchProfile(prof)) await page.tap(`${lib.WELCOME} button[data-dismiss]`).catch(() => lib.dismissWelcome(page));
    else await lib.dismissWelcome(page);
    await page.waitForTimeout(3500);
    await page.evaluate(PIN_GOVERNOR);
    await page.evaluate(SHADOW_HOOK);
    const out = { views: {} };
    for (const [h, list] of [
      [12, ['spawn', 'hub', 'projects']],
      [21, ['spawn']],
    ]) {
      await page.evaluate(SET_HOUR, h);
      await page.waitForTimeout(1600);
      for (const view of list) {
        await page.evaluate(VIEW, viewArg(view));
        await page.waitForTimeout(1200);
        out.views[`${view}-h${h}`] = await page.evaluate(SHADOW_READ, { n: 60 });
      }
    }
    await page.evaluate(SET_HOUR, 12);
    await page.evaluate(VIEW, { view: 'spawn' });
    await page.waitForTimeout(800);
    // The contact shadow while walking: W held on the frozen 1/60 s sim. The
    // shadow a frame shows was drawn where the player stood at the last
    // shadow pass, so its offset from the feet is the distance walked since.
    await page.evaluate(lib.FREEZE);
    await page.keyboard.down('KeyW');
    const walk = await page.evaluate(() => {
      const P = window.__app.scene.getPlayer();
      const S = window.__sd;
      for (let i = 0; i < 40; i++) {
        window.__step(1, 1 / 60);
        window.__render();
      }
      S.frames.length = 0;
      const p0 = P.getWorldPosition().clone();
      for (let i = 0; i < 120; i++) {
        window.__step(1, 1 / 60);
        window.__render();
      }
      return { speedUps: +(P.getWorldPosition().distanceTo(p0) / 2).toFixed(2) };
    });
    await page.keyboard.up('KeyW');
    out.walk = { ...walk, ...(await page.evaluate(SHADOW_READ, { n: 120 })) };
    await page.evaluate(lib.THAW);
    await page.evaluate(SET_HOUR, null);
    t.data[prof] = out;
    const sp = out.views['spawn-h12'];
    t.log(`${prof}: ${JSON.stringify(out)}`);
    t.check(`${prof}: shadow draws per pass at the spawn view (a full pass)`, sp.perPass > 0 ? true : false, sp.perPass, 'reported (main: 94-95)');
    if (low) {
      // E2: half rate is the low tier's default.
      t.check(`${prof}: shadow passes in 60 frames at the spawn`, Math.abs(sp.passes - 30) <= 1, sp.passes, '30 +-1 (half rate)');
      t.check(`${prof}: shadow draws per frame at the spawn, at half rate`, Math.abs(sp.perFrame - 47.5) <= 3, sp.perFrame, '47.5 +-3');
      t.check(`${prof}: the contact shadow's offset from the feet walking at ${out.walk.speedUps} u/s (max, u)`, out.walk.maxLagU <= 0.1, out.walk.maxLagU, '<= 0.1');
    } else {
      t.check(`${prof}: shadow passes in 60 frames at the spawn`, sp.passes === 60, sp.passes, '60 (full rate; decision 12)');
      t.check(`${prof}: the contact shadow's offset from the feet walking (max, u)`, out.walk.maxLagU <= 0.001, out.walk.maxLagU, '0 (a pass every frame)');
    }
  }
}

// --------------------------------------------------------------- edge-crawl
// A fixed camera over the walk's path, the sim frozen at 1/60 s: the L* of
// static shadow-edge pixels, frame to frame, while the player walks W for 3 s
// (the shadow box follows the player, so its texels re-quantise the edges)
// and while the player stands (the scene's own animation: grass, clouds).
const CRAWL_SETUP = () => {
  const sc = window.__app.scene;
  const cam = sc.getCamera();
  const P = sc.getPlayer();
  const up = P.getWorldPosition().clone().normalize();
  const fwd = sc.getOrbitCamera().getForwardDirection().clone();
  fwd.addScaledVector(up, -fwd.dot(up)).normalize();
  // Look straight down at the middle of the walk (8 u ahead), from 16 u up.
  const mid = P.getWorldPosition().clone().addScaledVector(fwd, 8);
  const eye = mid.clone().addScaledVector(mid.clone().normalize(), 16);
  window.__crawl = { eye, mid, fwd, cam };
  const R = window.__app.renderer.getRenderer();
  const gl = R.getContext();
  const w = gl.drawingBufferWidth;
  const h = gl.drawingBufferHeight;
  const lin = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const c = i / 255;
    lin[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }
  const Lst = (Y) => (Y > 0.008856 ? 116 * Math.cbrt(Y) - 16 : 903.3 * Y);
  window.__crawl.frame = () => {
    // The orbit camera wrote the chase pose in update(); put the fixed one back.
    cam.position.copy(eye);
    cam.up.copy(fwd);
    cam.lookAt(mid);
    cam.updateMatrixWorld(true);
    window.__render();
    const buf = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    const out = new Float32Array(Math.ceil(w / 2) * Math.ceil(h / 2));
    let n = 0;
    for (let y = 0; y < h; y += 2)
      for (let x = 0; x < w; x += 2) {
        const k = (y * w + x) * 4;
        out[n++] = Lst(0.2126 * lin[buf[k]] + 0.7152 * lin[buf[k + 1]] + 0.0722 * lin[buf[k + 2]]);
      }
    return out;
  };
  /** Where the player is on that half-resolution grid (readPixels rows run bottom-up). */
  window.__crawl.playerXY = () => {
    const v = P.getWorldPosition().clone().project(cam);
    return [((v.x + 1) / 2) * (w / 2), ((v.y + 1) / 2) * (h / 2)];
  };
  window.__crawl.gw = Math.ceil(w / 2);
  return { w: Math.ceil(w / 2), h: Math.ceil(h / 2) };
};
const CRAWL_RUN = ({ frames, phase }) => {
  const C = window.__crawl;
  let sun = null;
  window.__app.scene.traverse((o) => { if (!sun && o.isDirectionalLight && o.castShadow) sun = o; });
  const W = C.gw;
  if (phase === 'stand') {
    // Edge pixels: where the key's shadow darkens the frame by 15% to 85% of
    // the full shadow step (the penumbra), from one frame with and one without.
    window.__step(1, 1 / 60);
    const was = sun.shadow.intensity;
    sun.shadow.intensity = 0;
    const lit = C.frame();
    sun.shadow.intensity = was;
    const base = C.frame();
    let full = 0;
    for (let i = 0; i < base.length; i++) full = Math.max(full, lit[i] - base[i]);
    C.edge = [];
    for (let i = 0; i < base.length; i++) {
      const d = lit[i] - base[i];
      if (full > 4 && d > 0.15 * full && d < 0.85 * full) C.edge.push(i);
    }
    C.full = full;
    C.prev = base;
    C.moved = new Float32Array(C.edge.length);
  }
  const edge = C.edge;
  // 'walk' keeps only the edges that held still while the player stood: a
  // swaying tree's shadow moves on its own and is not crawl.
  const use = phase === 'walk' ? edge.map((_, k) => C.moved[k] < 0.75) : null;
  let prev = C.prev;
  let sum = 0;
  let trimmed = 0;
  let used = 0;
  let pixels = 0;
  const per = [];
  for (let f = 0; f < frames; f++) {
    window.__step(1, 1 / 60);
    const cur = C.frame();
    const [px, py] = C.playerXY();
    let s = 0;
    let n = 0;
    const ds = [];
    for (let k = 0; k < edge.length; k++) {
      if (use && !use[k]) continue;
      const i = edge[k];
      const x = i % W;
      const y = (i - x) / W;
      if (Math.abs(x - px) < 40 && Math.abs(y - py) < 40) continue; // the avatar and its own shadow
      const d = Math.abs(cur[i] - prev[i]);
      if (phase === 'stand' && d > C.moved[k]) C.moved[k] = d;
      s += d;
      n++;
      ds.push(d);
    }
    if (n) {
      per.push(s / n);
      sum += s / n;
      // The lower 90% of the pixels: a villager's shadow crossing the view
      // moves a few edges a lot; crawl moves most of them a little.
      ds.sort((a, b) => a - b);
      const keep = Math.max(1, Math.floor(ds.length * 0.9));
      let ts = 0;
      for (let k = 0; k < keep; k++) ts += ds[k];
      trimmed += ts / keep;
      used++;
      pixels = Math.max(pixels, n);
    }
    prev = cur;
  }
  C.prev = prev;
  per.sort((a, b) => a - b);
  const still = phase === 'stand' ? C.moved.reduce((n, v) => n + (v < 0.75 ? 1 : 0), 0) : use.filter(Boolean).length;
  return { edgePixels: edge.length, staticEdgePixels: still, measuredPixels: pixels, fullShadowStepL: +C.full.toFixed(1), meanAbsDeltaL: used ? +(sum / used).toFixed(4) : null, trimmedMeanAbsDeltaL: used ? +(trimmed / used).toFixed(4) : null, p95: per.length ? +per[Math.floor(per.length * 0.95)].toFixed(4) : null, frames: used, shadowStrength: +sun.shadow.intensity.toFixed(2) };
};

async function crawlOne(t, base, label) {
  const prof = t.profiles(['desktop'])[0];
  const s = await t.session(prof, { clock: true });
  const { page } = s;
  await t.boot(s, { query: 'hour=10', base });
  await page.evaluate(L.installHelpers);
  if (lib.isTouchProfile(prof)) await page.tap(`${lib.WELCOME} button[data-dismiss]`).catch(() => lib.dismissWelcome(page));
  else await lib.dismissWelcome(page);
  await page.waitForTimeout(3500);
  await page.evaluate(PIN_GOVERNOR);
  await page.evaluate(VIEW, { view: 'spawn' });
  await page.waitForTimeout(800);
  await L.setUi(page, false);
  await page.evaluate(lib.FREEZE);
  const grid = await page.evaluate(CRAWL_SETUP);
  // Standing 1.5 s finds the edges and which of them move on their own
  // (swaying trees); another second standing is the noise floor on the
  // static ones; then W for 3 s.
  const finding = await page.evaluate(CRAWL_RUN, { frames: 90, phase: 'stand' });
  const standing = await page.evaluate(CRAWL_RUN, { frames: 60, phase: 'walk' });
  await page.keyboard.down('KeyW');
  const walking = await page.evaluate(CRAWL_RUN, { frames: 180, phase: 'walk' });
  await page.keyboard.up('KeyW');
  await t.shot(page, `edge-crawl-${label}.png`);
  await page.evaluate(lib.THAW);
  await L.setUi(page, true);
  await s.close();
  const crawl = walking.trimmedMeanAbsDeltaL !== null && standing.trimmedMeanAbsDeltaL !== null ? +(walking.trimmedMeanAbsDeltaL - standing.trimmedMeanAbsDeltaL).toFixed(4) : null;
  return { profile: prof, grid, allEdgesStanding: finding.meanAbsDeltaL, standing, walking, crawl };
}

async function edgeCrawl(t) {
  const a = await crawlOne(t, t.base, 'subject');
  t.data.subject = a;
  t.log(`subject: ${JSON.stringify(a)}`);
  t.check('static shadow-edge pixels under the fixed camera', a.walking.staticEdgePixels >= 200, `${a.walking.staticEdgePixels} of ${a.walking.edgePixels} edge pixels`, '>= 200');
  t.check('mean per-frame |dL*| on static shadow edges, walking W for 3 s (the lower 90% of the pixels)', a.walking.trimmedMeanAbsDeltaL !== null ? true : null, { walking: a.walking.trimmedMeanAbsDeltaL, standing: a.standing.trimmedMeanAbsDeltaL, crawl: a.crawl, allPixels: { walking: a.walking.meanAbsDeltaL, standing: a.standing.meanAbsDeltaL } }, 'reported');
  if (t.compareBase) {
    const b = await crawlOne(t, t.compareBase, 'main');
    t.data.main = b;
    t.log(`main: ${JSON.stringify(b)}`);
    // Within 10% of main, or within 0.01 L* of it where main's own number is that small.
    const [wa, wb] = [a.walking.trimmedMeanAbsDeltaL, b.walking.trimmedMeanAbsDeltaL];
    const r = wb ? +(wa / wb).toFixed(3) : null;
    const d = wa !== null && wb !== null ? +(wa - wb).toFixed(4) : null;
    t.check('walking edge crawl against main', d !== null ? d <= Math.max(0.01, 0.1 * wb) : null, d === null ? 'no edge pixels' : `${r === null ? '-' : r + 'x'} (${wa} vs ${wb})`, '<= 1.10x, or within 0.01 L*');
  }
}

module.exports = {
  // For lum.cjs (E6b): the same views, hours and world set-up.
  VIEW,
  SET_HOUR,
  openWorld,
  viewArg,
  daycycle: { item: 'P2-E1b (LT-01, LT-02, LT-05, LT-06; P2-C1, C1, C5, P2-B4, P2-B5, P2-E5)', title: 'ground, path, player, villager, sky and sea L* by exact masks, 8 views x 8 hours, both tiers; --bloom: night bloom on, off and the bloomNight lever; --compare <main dist>', profiles: ['desktop', 'phone'], compare: true, run: daycycle },
  weather: { item: 'P2-E1b (LT-08, P2-B5)', title: 'shadow contrast on the ground at noon in clear, cloudy, rain and snow', profiles: ['desktop'], run: weather },
  beacons: { item: 'P2-E1b (LT-09, P2-C5)', title: "each district beacon at 12 and 21 h: the material's emissive and intensity, the rendered hue, the halo with bloom on and off", profiles: ['desktop'], run: beacons },
  shadowdraws: { item: 'P2-E1b (LT-08, E2)', title: 'shadow draws per view, shadow passes per 60 frames, and the contact shadow offset while walking', profiles: ['desktop', 'lowtier'], run: shadowdraws },
  'edge-crawl': { item: 'P2-E1b (LT-01, P2-C1)', title: 'mean per-frame |dL*| on static shadow-edge pixels while walking W for 3 s under a fixed camera; --compare <main dist>', profiles: ['desktop'], compare: true, run: edgeCrawl },
};
