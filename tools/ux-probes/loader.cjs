'use strict';
// The two loaders and the font swap (E6d; DA-10; D12). The audit's loader.cjs
// was a session temp file and is gone, so this is rebuilt from
// ux-audit/results/design.json DA-10: the static loader (index.html) and the
// JS loader (SimpleUI.showLoading) are two designs, and while the Bebas woff2
// is pending the title paints in Arial bold at about 775 px against about
// 470 px in Bebas.
//
// Every *.woff2 and the fonts.googleapis.com CSS are held back, and
// separately the main bundle (/assets/main-*.js), through openSession's
// onRoute, then released in turn, so main (Google) and D12 (self-hosted)
// measure alike:
//   static   fonts and bundle held: the static loader's title (the FOUT
//            frame); fonts released: the same title loaded; bundle released:
//            the JS loader with the faces loaded
//   js       fonts and bundle held, the bundle released first: the JS
//            loader's title in the FOUT frame, against the JS loader of the
//            static run (the faces in first): once world gen starts the page
//            answers nothing until the loader has gone
// Title width is the text's own box (a Range over the title), not its block.
// The phase diff is the share of viewport pixels (sum |dRGB| > 48) that
// differ between the static and JS loaders with the faces loaded, outside the
// progress parts (#ld-bar's track, #ld-pct, #ld-msg, #load-phase).
//
//   npm run probe -- loader --dist dist --port <n> [--profile desktop|phone]
const lib = require('./lib.cjs');

const FONT_RE = /\.woff2(\?|$)|^https:\/\/fonts\.googleapis\.com\//;
const BUNDLE_RE = /\/assets\/main-[^/]+\.js(\?|$)/;

/** A gate a route waits on until released. */
function gate() {
  let open;
  const p = new Promise((r) => (open = r));
  return { p, open, held: [] };
}

/** Page-side: the loader title's text box (width, height) and which loader shows it. */
const TITLE = () => {
  const visible = (el) => {
    if (!el || !el.isConnected) return false;
    const b = el.getBoundingClientRect();
    if (b.width < 1 || b.height < 1) return false;
    for (let n = el; n && n !== document; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity < 0.05) return false;
    }
    return true;
  };
  const box = (el) => {
    const r = document.createRange();
    r.selectNodeContents(el);
    const b = r.getBoundingClientRect();
    return { w: Math.round(b.width), h: Math.round(b.height), font: getComputedStyle(el).fontFamily.slice(0, 60) };
  };
  const ls = document.getElementById('loading-screen');
  const st = ls && visible(ls) ? [...ls.querySelectorAll('h1, h2')].find((e) => /LIFE ISLAND/i.test(e.textContent) && visible(e)) : null;
  const bar = document.getElementById('ld-bar');
  let js = null;
  if (bar) {
    let root = bar;
    while (root.parentElement && root.parentElement.id !== 'ui-overlay' && root.parentElement !== document.body) root = root.parentElement;
    js = [...root.querySelectorAll('div, h1, h2')].find((e) => [...e.childNodes].some((n) => n.nodeType === 3 && /LIFE ISLAND/i.test(n.textContent)) && visible(e)) || null;
  }
  return { static: st ? box(st) : null, js: js ? box(js) : null, ready: window.__lifeIslandReady === true };
};

/** Page-side: rects of the progress parts, excluded from the phase diff. */
const PROGRESS = () =>
  ['ld-msg', 'ld-pct', 'load-phase']
    .map((id) => document.getElementById(id))
    .concat([document.getElementById('ld-bar') && document.getElementById('ld-bar').parentElement])
    .filter(Boolean)
    .map((el) => {
      const b = el.getBoundingClientRect();
      return { x: b.left - 4, y: b.top - 4, w: b.width + 8, h: b.height + 8 };
    });

const BEBAS_LOADED = () => [...document.fonts].some((f) => f.family.replace(/["']/g, '') === 'Bebas Neue' && f.status === 'loaded');

async function open(t, prof) {
  const fonts = gate();
  const bundle = gate();
  const onRoute = async (route, req) => {
    const u = req.url();
    const g = FONT_RE.test(u) ? fonts : BUNDLE_RE.test(u) ? bundle : null;
    if (!g) return false;
    g.held.push(u);
    await g.p;
    await route.continue().catch(() => {});
    return true;
  };
  const s = await t.session(prof, { onRoute });
  const q = lib.bootQuery(s.profile.query, '', t.args.hour);
  await s.page.goto(`${t.base}/${q}`, { waitUntil: 'commit', timeout: 120000 });

  return { s, fonts, bundle };
}

/**
 * A screenshot through CDP Page.captureScreenshot: page.screenshot() waits
 * for web fonts, so it can never catch the FOUT frame.
 */
async function snap(t, page, file) {
  const cdp = await page.context().newCDPSession(page);
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  await cdp.detach().catch(() => {});
  const p = require('path').join(t.out, file);
  require('fs').writeFileSync(p, Buffer.from(data, 'base64'));
  return p;
}

async function waitFor(page, fn, ms = 30000) {
  const t0 = Date.now();
  for (;;) {
    const v = await page.evaluate(fn).catch(() => null);
    if (v) return v;
    if (Date.now() - t0 > ms) return null;
    await lib.sleep(150);
  }
}

function diffShare(a, b, skip) {
  let n = 0;
  let tot = 0;
  for (let y = 0; y < a.height; y++)
    for (let x = 0; x < a.width; x++) {
      if (skip.some((r) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h)) continue;
      const i = (y * a.width + x) * 4;
      tot++;
      if (Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2]) > 48) n++;
    }
  return tot ? n / tot : null;
}

async function loader(t) {
  for (const prof of t.profiles(['desktop', 'phone'])) {
    const out = {};
    // ---- static first
    {
      const { s, fonts, bundle } = await open(t, prof);
      const { page } = s;
      out.staticFout = (await waitFor(page, () => {
        const ls = document.getElementById('loading-screen');
        const h = ls && ls.querySelector('h2, h1');
        return h && h.getBoundingClientRect().width > 10 ? true : null;
      })) && (await page.evaluate(TITLE)).static;
      await lib.sleep(400);
      await snap(t, page, `loader-${prof}-static-fout.png`);
      fonts.open();
      out.bebasStatic = await waitFor(page, BEBAS_LOADED, 20000);
      await lib.sleep(500);
      out.staticLoaded = (await page.evaluate(TITLE)).static;
      out.fallback = await page.evaluate(() => {
        const el = document.getElementById('boot-fallback');
        const r = document.getElementById('bf-reason');
        return el && !el.hidden ? (r ? r.textContent : 'shown') : null;
      });
      const pStatic = await snap(t, page, `loader-${prof}-static-loaded.png`);
      const skipStatic = await page.evaluate(PROGRESS);
      bundle.open();
      await waitFor(page, () => (document.getElementById('ld-bar') ? true : null), 60000);
      await lib.sleep(600);
      const jsT = await page.evaluate(TITLE);
      out.jsAfterStatic = jsT.js;
      const pJs = await snap(t, page, `loader-${prof}-js-loaded.png`);
      const skipJs = await page.evaluate(PROGRESS);
      const fs = require('fs');
      const a = lib.pngDecode(fs.readFileSync(pStatic));
      const b = lib.pngDecode(fs.readFileSync(pJs));
      out.phaseDiff = a.width === b.width && a.height === b.height ? lib.round(diffShare(a, b, [...skipStatic, ...skipJs]) * 100, 2) : null;
      out.held = { fonts: fonts.held.length, bundle: bundle.held.length };
      await waitFor(page, () => (window.__lifeIslandReady === true ? true : null), 240000);
      await s.close();
    }
    // ---- the JS loader's own FOUT: the bundle first, the faces still held.
    // Its loaded frame is the one above (the faces in before the bundle):
    // once world gen starts, the page answers nothing until the loader is gone.
    {
      const { s, fonts, bundle } = await open(t, prof);
      const { page } = s;
      await waitFor(page, () => (document.getElementById('loading-screen') ? true : null));
      bundle.open();
      const js = await waitFor(page, () => (document.getElementById('ld-bar') ? true : null), 60000);
      await lib.sleep(300);
      out.jsFout = js ? (await page.evaluate(TITLE)).js : null;
      await snap(t, page, `loader-${prof}-js-fout.png`);
      fonts.open();
      await waitFor(page, () => (window.__lifeIslandReady === true ? true : null), 240000);
      await s.close();
    }
    const ratio = (f, l) => (f && l && l.w ? lib.round(f.w / l.w, 3) : null);
    out.staticRatio = ratio(out.staticFout, out.staticLoaded);
    out.jsRatio = ratio(out.jsFout, out.jsAfterStatic);
    t.data[prof] = out;
    const within = (r) => (r === null ? null : Math.abs(r - 1) <= 0.05);
    t.check(`${prof}: the static loader's FOUT title width within 5% of loaded`, within(out.staticRatio), { fout: out.staticFout, loaded: out.staticLoaded, ratio: out.staticRatio }, '0.95-1.05 (58c8849: about 775 px against 470 px)');
    t.check(`${prof}: the JS loader's FOUT title width within 5% of loaded`, within(out.jsRatio), { fout: out.jsFout, loaded: out.jsAfterStatic, ratio: out.jsRatio }, '0.95-1.05');
    t.check(`${prof}: the static and JS loaders match but for progress`, out.phaseDiff === null ? null : out.phaseDiff <= 2, `${out.phaseDiff}% of pixels differ`, '<= 2% outside the progress parts (58c8849: two designs)');
  }
}

module.exports = {
  loader: { item: 'E6d (DA-10; D12)', title: "the loaders with the woff2s, the fonts CSS and the bundle held back: FOUT title width against loaded (static and JS), the static-vs-JS pixel diff", profiles: ['desktop', 'phone'], run: loader },
};
