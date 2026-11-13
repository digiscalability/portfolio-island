'use strict';
// Bundle sizes, gzip and brotli (E6d; PERF-12). The audit's
// perf-headroom/bundles.cjs was a session temp file and is gone, so this is
// rebuilt from ux-audit/results/performance.json PERF-12: main-BT05EkBU.js
// 886 kB raw, 273 kB gzip-9, 219 kB brotli-11; three-PPx_lrH1.js 642, 165 and
// 135 kB. The Projects panel's line '~280 KB app + 175 KB three.js (brotli)'
// quotes gzip numbers as brotli.
//
// Node only, no browser (the leak and port rows do not apply). Every chunk
// under <dist>/assets: raw, gzip level 9 and brotli quality 11
// (zlib.brotliCompressSync). The main chunk's gzip also through perf-gate's
// exported bundleSize, so the two tools agree. The panel's quoted numbers are
// read from the built main chunk and compared, report-only, with the measured
// brotli sizes (within 5%). `--compare <dir>` sizes a second build beside it.
//
//   npm run probe -- bundles --dist dist [--compare <dir>]
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const lib = require('./lib.cjs');

const kB = (n) => Math.round((n / 1000) * 100) / 100;

function sizes(dist) {
  const dir = path.join(path.resolve(dist), 'assets');
  if (!fs.existsSync(dir)) return null;
  const chunks = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js')).sort()) {
    const buf = fs.readFileSync(path.join(dir, f));
    chunks.push({
      file: f,
      rawKB: kB(buf.length),
      gzipKB: kB(zlib.gzipSync(buf, { level: 9 }).length),
      brotliKB: kB(zlib.brotliCompressSync(buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buf.length } }).length),
    });
  }
  const main = chunks.find((c) => /^main-[\w-]+\.js$/.test(c.file)) || null;
  const three = chunks.find((c) => /^three-[\w-]+\.js$/.test(c.file)) || null;
  let quote = null;
  if (main) {
    const src = fs.readFileSync(path.join(dir, main.file), 'utf8');
    const m = /~(\d+)\s*KB app \+ (\d+)\s*KB three\.js \((\w+)\)/.exec(src);
    if (m) quote = { appKB: +m[1], threeKB: +m[2], unit: m[3] };
  }
  let gate = null;
  try {
    gate = require('../perf-gate.cjs').bundleSize(path.resolve(dist));
  } catch (e) {
    gate = null;
  }
  const total = (k) => kB(chunks.reduce((a, c) => a + c[k] * 1000, 0));
  return { dist: path.resolve(dist), chunks, main, three, quote, perfGateMain: gate, total: { rawKB: total('rawKB'), gzipKB: total('gzipKB'), brotliKB: total('brotliKB') } };
}

async function run({ args }) {
  const checks = [];
  const check = (name, pass, value, expect) => checks.push({ name, pass: pass === null || pass === undefined ? null : !!pass, value, expect });
  const a = sizes(args.dist || 'dist');
  const b = args.compare ? sizes(args.compare) : null;
  const data = { subject: a, compare: b };
  if (!a || !a.main) {
    check('a main chunk under <dist>/assets', null, a ? a.chunks.length : null, 'main-<hash>.js');
    return { checks, data };
  }
  const within = (q, m) => (q && m ? Math.abs(q / m - 1) <= 0.05 : null);
  check('main chunk: raw, gzip-9, brotli-11 (kB)', true, { file: a.main.file, raw: a.main.rawKB, gzip: a.main.gzipKB, brotli: a.main.brotliKB }, 'reported (58c8849: 886 / 273 / 219)');
  check('three chunk: raw, gzip-9, brotli-11 (kB)', a.three ? true : null, a.three ? { file: a.three.file, raw: a.three.rawKB, gzip: a.three.gzipKB, brotli: a.three.brotliKB } : null, 'reported (58c8849: 642 / 165 / 135)');
  check("perf-gate's bundleSize agrees on the main chunk's gzip", a.perfGateMain ? Math.abs(a.perfGateMain.gzipKB / a.main.gzipKB - 1) <= 0.01 : null, a.perfGateMain, "within 1% (perf-gate gzips at zlib's default level 6, this row at 9)");
  check(`the Projects panel's '${a.quote ? `~${a.quote.appKB} KB app + ${a.quote.threeKB} KB three.js (${a.quote.unit})` : 'quote'}' matches brotli within 5% (report only)`, a.quote ? true : null, a.quote ? { app: { quoted: a.quote.appKB, brotli: a.main.brotliKB, gzip: a.main.gzipKB, within5: within(a.quote.appKB, a.main.brotliKB) }, three: a.three ? { quoted: a.quote.threeKB, brotli: a.three.brotliKB, gzip: a.three.gzipKB, within5: within(a.quote.threeKB, a.three.brotliKB) } : null } : null, 'report only (58c8849: the quote matches gzip, not brotli)');
  check('every chunk, total (kB)', true, { chunks: a.chunks.length, ...a.total }, 'reported');
  if (b && b.main) check('the compare build: main and three (kB)', true, { main: { file: b.main.file, raw: b.main.rawKB, gzip: b.main.gzipKB, brotli: b.main.brotliKB }, three: b.three ? { raw: b.three.rawKB, gzip: b.three.gzipKB, brotli: b.three.brotliKB } : null, deltaMainGzipKB: lib.round(a.main.gzipKB - b.main.gzipKB, 2) }, 'reported');
  return { checks, data };
}

module.exports = {
  bundles: { static: true, item: 'E6d (PERF-12)', title: "every chunk's raw, gzip-9 and brotli-11 size; the Projects panel's quoted sizes against brotli (report only); --compare <dist>", run },
  sizes,
};
