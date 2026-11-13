'use strict';
// Panel thumbnails with a browser scrollbar on their right edge (E6d; DA-17;
// C11). The audit's webp-edge.cjs was a session temp file and is gone, so this
// is rebuilt from ux-audit/results/design.json DA-17: columns x = 810-819 of
// chocomate.webp and rankpilot.webp (820 px wide) hold a light scrollbar (RGB
// 156-253) against the page background (13, 31, 19), and chocomate.webp is
// shown on the Projects card.
//
// C11 re-exports chocomate.webp at 808 px wide, so fixed columns no longer
// exist: each image the Projects panel shows is sampled at its last 10
// columns relative to naturalWidth, drawn to a canvas in the page. A column is
// light when the median over its rows of min(R, G, B) is over 150. Only shown
// images are judged; rankpilot.webp (not shown) is sampled and reported only.
// rankpilot.webp, og-cover.jpg and og-cover-v2.jpg are fetched for their
// status: C11 keeps all three serving 200 until Abbas rules on them.
//
//   npm run probe -- webp-edge --dist dist --port <n> [--profile desktop]
const lib = require('./lib.cjs');

const REPORT_ONLY = ['/assets/panels/rankpilot.webp'];
const MUST_SERVE = ['/assets/panels/rankpilot.webp', '/og-cover.jpg', '/og-cover-v2.jpg'];

/** Page-side: the last 10 columns of an image, as light (true) or not. */
const EDGE = async (src) => {
  const img = new Image();
  img.src = src;
  try {
    await img.decode();
  } catch (e) {
    return { src, error: 'decode failed' };
  }
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const d = ctx.getImageData(w - 10, 0, 10, h).data;
  const cols = [];
  for (let x = 0; x < 10; x++) {
    const mins = [];
    for (let y = 0; y < h; y++) {
      const i = (y * 10 + x) * 4;
      mins.push(Math.min(d[i], d[i + 1], d[i + 2]));
    }
    mins.sort((a, b) => a - b);
    const med = mins[mins.length >> 1];
    cols.push({ x: w - 10 + x, medianMin: med, light: med > 150 });
  }
  return { src, naturalWidth: w, naturalHeight: h, light: cols.filter((k) => k.light).map((k) => k.x), cols: cols.map((k) => k.medianMin) };
};

async function webpEdge(t) {
  for (const prof of t.profiles(['desktop'])) {
    const s = await t.session(prof);
    await t.boot(s);
    const { page } = s;
    await lib.dismissWelcome(page);
    await page.evaluate(() => window.__app.ui.showZonePanel({ id: 'projects', name: 'projects' }));
    await page.waitForTimeout(1500);
    const shown = await page.evaluate(() => {
      const h = window.__h;
      const panel = h.zonePanel();
      if (!panel) return null;
      return [...panel.querySelectorAll('img')].map((im) => ({ src: new URL(im.currentSrc || im.src, location.href).pathname, w: Math.round(im.getBoundingClientRect().width), h: Math.round(im.getBoundingClientRect().height), fit: getComputedStyle(im).objectFit }));
    });
    await t.shot(page, `webp-edge-${prof}-projects.png`);
    const out = { shown };
    const panelImgs = (shown || []).filter((x) => /\.(webp|png|jpe?g)$/i.test(x.src));
    const srcs = [...new Set([...panelImgs.map((x) => x.src), ...REPORT_ONLY])];
    out.images = [];
    for (const src of srcs) out.images.push({ ...(await page.evaluate(EDGE, src)), shown: panelImgs.some((x) => x.src === src) });
    out.status = {};
    for (const u of MUST_SERVE) out.status[u] = await page.evaluate(async (path) => (await fetch(path, { cache: 'no-store' })).status, u).catch(() => null);
    t.data[prof] = out;
    const judged = out.images.filter((x) => x.shown && !x.error);
    t.check(`${prof}: the Projects panel shows an image`, shown === null ? null : true, panelImgs.map((x) => `${x.src} ${x.w}x${x.h} ${x.fit}`), 'reported (fcaa649: chocomate.webp at 428x150, cover)');
    t.check(`${prof}: no light column on a shown image's right edge (C11)`, judged.length ? judged.every((x) => x.light.length === 0) : null, judged.map((x) => ({ src: x.src, naturalWidth: x.naturalWidth, light: x.light })), 'none in the last 10 columns (58c8849: chocomate.webp 810-819)');
    const rp = out.images.find((x) => x.src === REPORT_ONLY[0]);
    t.check(`${prof}: rankpilot.webp's right edge (report only)`, rp && !rp.error ? true : null, rp ? { naturalWidth: rp.naturalWidth, light: rp.light } : null, 'reported (58c8849: 810-819)');
    t.check(`${prof}: rankpilot.webp, og-cover.jpg and og-cover-v2.jpg still serve 200 (C11)`, MUST_SERVE.every((u) => out.status[u] === 200), out.status, '200 each (no public file deleted until Abbas rules)');
    await s.close();
  }
}

module.exports = {
  'webp-edge': { item: 'E6d (DA-17; C11)', title: "the Projects panel's images: light columns in the last 10 relative to naturalWidth; rankpilot.webp and the two og-covers still 200", profiles: ['desktop'], run: webpEdge },
  EDGE,
};
