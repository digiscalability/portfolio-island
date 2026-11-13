'use strict';
// The CBD facade textures' cost (E6d; DA-12; C7). The audit's texgen-time.cjs
// was a session temp file and is gone, so this is rebuilt from
// ux-audit/results/design.json DA-12: the four 'building_placeholder' towers
// each use brick albedo, Sobel normal, AO and roughness maps, 4 x 512² canvases
// (about 5.3 MB of GPU memory with mips), costing 13.5 ms on desktop and
// 41.9 ms at 4x CPU on the synchronous world-gen path. C7 deletes
// TextureGenerator.createBuildingTextures, so a timer on that function would
// read "missing" after C7. No hook (the wave-4 contract): instead
//   canvases  an init script wraps document.createElement and counts the
//             512x512 canvases made between the boot:worldgen-start and
//             boot:scene-ready marks (4 on main, 0 after C7)
//   fixture   the generator's canvas work, copied from
//             TextureGenerator.createBuildingTextures at fcaa649 (Math.random
//             replaced by a local LCG, so the page's stream is untouched),
//             timed in the same page after boot
//   saving    fixture cost x (the facades present ? 1 : 0): a build without
//             the function reads 0, not "missing"
// At 4x CPU (CDP throttling), the median of 3 fresh loads, with world_gen
// from the page's own measure for the cross-check against perf-gate --ab.
//
//   npm run probe -- texgen --dist dist --port <n> [--loads 3] [--cpu 4]
const lib = require('./lib.cjs');

/** Counts canvases as they are made; their size is read after world gen. */
const CANVAS_COUNTER = `(() => {
  const made = (window.__texgenCanvases = []);
  const orig = Document.prototype.createElement;
  Document.prototype.createElement = function (tag, opts) {
    const el = orig.call(this, tag, opts);
    if (String(tag).toLowerCase() === 'canvas') made.push({ el, t: performance.now() });
    return el;
  };
})();`;

/** Page-side: the fixture of createBuildingTextures' canvas work (fcaa649), w x h. */
const FIXTURE = ({ w, h, reps }) => {
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const normalFrom = (source) => {
    const W = source.width;
    const H = source.height;
    const src = source.getContext('2d').getImageData(0, 0, W, H).data;
    const n = document.createElement('canvas');
    n.width = W;
    n.height = H;
    const nctx = n.getContext('2d');
    const img = nctx.createImageData(W, H);
    const lum = (i) => 0.2126 * src[i] + 0.7152 * src[i + 1] + 0.0722 * src[i + 2];
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const idx = (y * W + x) * 4;
        const left = x > 0 ? lum((y * W + (x - 1)) * 4) : lum(idx);
        const right = x < W - 1 ? lum((y * W + (x + 1)) * 4) : lum(idx);
        const up = y > 0 ? lum(((y - 1) * W + x) * 4) : lum(idx);
        const down = y < H - 1 ? lum(((y + 1) * W + x) * 4) : lum(idx);
        const nx = -(right - left) / 255;
        const ny = -(down - up) / 255;
        const len = Math.sqrt(nx * nx + ny * ny + 1);
        img.data[idx] = Math.round(((nx / len) * 0.5 + 0.5) * 255);
        img.data[idx + 1] = Math.round(((ny / len) * 0.5 + 0.5) * 255);
        img.data[idx + 2] = Math.round(((1 / len) * 0.5 + 0.5) * 255);
        img.data[idx + 3] = 255;
      }
    nctx.putImageData(img, 0, 0);
    return n;
  };
  const once = () => {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#b9c0c9';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#8b95a1';
    const rowH = 28;
    for (let y = 0; y < h; y += rowH)
      for (let x = 0; x < w; x += 48) {
        const jitter = Math.floor((rnd() - 0.5) * 6);
        ctx.fillRect(x + jitter, y + 6, 44, rowH - 10);
        ctx.fillStyle = `rgba(0,0,0,${(rnd() * 0.06).toFixed(2)})`;
        ctx.fillRect(x + jitter + 1, y + rowH - 6, 42, 2);
        ctx.fillStyle = '#8b95a1';
      }
    normalFrom(c);
    const ao = document.createElement('canvas');
    ao.width = w;
    ao.height = h;
    const aoc = ao.getContext('2d');
    aoc.fillStyle = 'rgba(0,0,0,0)';
    aoc.fillRect(0, 0, w, h);
    const grad = aoc.createRadialGradient(w / 2, h / 2, w * 0.2, w / 2, h / 2, w * 0.7);
    grad.addColorStop(0, 'rgba(0,0,0,0)');
    grad.addColorStop(1, 'rgba(0,0,0,0.18)');
    aoc.fillStyle = grad;
    aoc.fillRect(0, 0, w, h);
    const r = document.createElement('canvas');
    r.width = w;
    r.height = h;
    const rctx = r.getContext('2d');
    rctx.fillStyle = '#b0b0b0';
    rctx.fillRect(0, 0, w, h);
  };
  once(); // warm the code path; the timed runs follow
  const ms = [];
  for (let i = 0; i < reps; i++) {
    const t0 = performance.now();
    once();
    ms.push(performance.now() - t0);
  }
  ms.sort((a, b) => a - b);
  return ms[ms.length >> 1];
};

/** Page-side: 512² canvases made inside world gen, and world_gen itself. */
const READ = () => {
  const mark = (n) => {
    const e = performance.getEntriesByName(n, 'mark')[0];
    return e ? e.startTime : null;
  };
  const t0 = mark('boot:worldgen-start');
  const t1 = mark('boot:scene-ready');
  const made = window.__texgenCanvases || [];
  const inGen = made.filter((c) => t0 !== null && t1 !== null && c.t >= t0 && c.t <= t1);
  const big = inGen.filter((c) => c.el.width === 512 && c.el.height === 512);
  const wg = performance.getEntriesByName('world_gen', 'measure')[0];
  return { marks: t0 !== null && t1 !== null, canvasesInGen: inGen.length, canvases512: big.length, worldGenMs: wg ? Math.round(wg.duration) : null };
};

async function texgen(t) {
  const loads = Math.max(1, Math.round(Number(t.args.loads || 3)));
  const cpu = Number(t.args.cpu || 4);
  const prof = { ...lib.profile('desktop'), name: `desktop${cpu}x`, cpu };
  const runs = [];
  for (let i = 0; i < loads; i++) {
    const s = await t.freshSession(prof, { init: [CANVAS_COUNTER] });
    await t.boot(s, { waitWelcome: false });
    const r = await s.page.evaluate(READ);
    r.fixtureMs = lib.round(await s.page.evaluate(FIXTURE, { w: 512, h: 512, reps: 3 }), 1);
    runs.push(r);
    await s.close();
  }
  const present = lib.median(runs.map((r) => r.canvases512));
  const fixture = lib.median(runs.map((r) => r.fixtureMs));
  const facades = present >= 4;
  const out = {
    cpu,
    loads: runs,
    canvases512: present,
    facadesPresent: facades,
    fixtureMs: lib.round(fixture, 1),
    savingMs: lib.round(facades ? fixture : 0, 1),
    worldGenMs: lib.median(runs.map((r) => r.worldGenMs)),
  };
  t.data[prof.name] = out;
  t.check(`${prof.name}: the world-gen marks are there`, runs.every((r) => r.marks) ? true : null, runs.map((r) => r.marks), 'boot:worldgen-start and boot:scene-ready');
  t.check(`${prof.name}: no facade canvases in world gen (C7)`, runs.every((r) => r.marks) ? !facades : null, { canvases512: present, inGen: runs.map((r) => r.canvasesInGen) }, '0 of the 4 512² facade maps (58c8849 and fcaa649: 4)');
  t.check(`${prof.name}: the facade generator's cost on this build (reported)`, true, { fixtureMs: out.fixtureMs, savingMs: out.savingMs, worldGenMs: out.worldGenMs }, `saving = fixture x present (the audit: 41.9 ms at 4x, 13.5 ms at 1x); world_gen for perf-gate's --ab`);
}

module.exports = {
  texgen: { item: 'E6d (DA-12; C7)', title: "the CBD facade maps: 512² canvases made in world gen, the generator's cost from a fixture, at 4x CPU, median of 3 fresh loads", profiles: ['desktop'], run: texgen },
  FIXTURE,
};
