#!/usr/bin/env node
'use strict';
// UX probe runner. `npm run probe -- <name> --dist <dir> --port <n> [options]`
//
//   --dist <dir> --port <n>      serve <dir> with `vite preview --strictPort` (killed by PID on exit)
//   --base <url>                 attach to a preview that is already running instead (--url is the same)
//   --profile desktop|phone|lowtier   run one profile instead of the probe's defaults
//                                (--device desk|phone, the phase-2 probes' spelling, maps onto it)
//   --out <dir>                  JSON + PNGs (default <os tmpdir>/ux-probes/<name>)
//   --compare <dir> --compare-port <m>   a second build, for probes that diff two dists
//   --no-khr                     KHR_parallel_shader_compile reads as unsupported
//   --selftest-leak              the harness fakes one leaked response: the run must exit 2
//
// Phase-2 probes live in p2/ and run by their path: `npm run probe -- p2/walkin ...`.
//
// Exit codes: 0 pass, 1 criterion fail, 2 fail-closed (a request got past the
// harness), 3 inconclusive (no decision: setup error, crash, or no boot proof
// intercepted). `npm run probe -- list` prints every probe and the item it serves.
const fs = require('fs');
const path = require('path');
const lib = require('./lib.cjs');

const GROUPS = ['compass', 'keys', 'look', 'rig', 'frames', 'panels', 'a11y'];
// p2/*.cjs modules that are shared libraries, not probes.
const P2_LIBS = new Set(['room-lib', 'L', 'play-lib', 'guide-lib']);

/** Every probe module present next to this file (a group may land later). */
function registry() {
  const reg = {};
  for (const g of GROUPS) {
    const file = path.join(__dirname, `${g}.cjs`);
    if (!fs.existsSync(file)) continue;
    for (const [name, def] of Object.entries(require(file))) if (def && typeof def.run === 'function') reg[name] = { ...def, group: g };
  }
  const p2 = path.join(__dirname, 'p2');
  if (fs.existsSync(p2)) {
    for (const f of fs.readdirSync(p2).filter((x) => x.endsWith('.cjs')).sort()) {
      const g = f.replace(/\.cjs$/, '');
      if (P2_LIBS.has(g)) continue;
      for (const [name, def] of Object.entries(require(path.join(p2, f)))) if (def && typeof def.run === 'function') reg[`p2/${name}`] = { ...def, group: `p2/${g}` };
    }
  }
  const census = path.join(__dirname, 'lock-census.cjs');
  if (fs.existsSync(census)) reg['lock-census'] = { ...require(census).probe, group: 'lock-census' };
  return reg;
}

function usage(reg) {
  const rows = Object.entries(reg).map(([n, d]) => `  ${n.padEnd(22)} ${String(d.item || '').padEnd(12)} ${d.title || ''}`);
  return `usage: npm run probe -- <name> --dist <dir> --port <n> [--base <url>] [--profile desktop|phone|lowtier] [--out <dir>] [--compare <dir> --compare-port <n>] [--no-khr] [--selftest-leak]\n\nprobes:\n${rows.join('\n')}\n`;
}

/** The phase-2 probes' flag spellings onto the runner's: --url is --base, --device desk|phone is --profile. */
function normaliseArgs(args) {
  if (args.url && !args.base) args.base = args.url;
  if (args.device && !args.profile) {
    const d = String(args.device).toLowerCase();
    args.profile = d === 'desk' || d === 'desktop' ? 'desktop' : d === 'phone' || d === 'mobile' ? 'phone' : d;
  }
  return args;
}

function makeContext({ name, def, args, out, server, compare, browser }) {
  const sessions = [];
  const checks = [];
  const data = {};
  const shots = [];
  const extraBrowsers = [];
  const t = {
    name,
    args,
    out,
    base: server ? server.url : null,
    compareBase: compare ? compare.url : null,
    browser,
    data,
    noKhr: !!args.noKhr,
    profiles(defaults) {
      if (args.profile) return [String(args.profile)];
      return defaults || def.profiles || ['desktop'];
    },
    async session(prof, opts = {}) {
      const s = await lib.openSession(browser, prof, { noKhr: t.noKhr, selftestLeak: !!args.selftestLeak, ...opts });
      sessions.push(s);
      return s;
    },
    /** A session in a browser of its own (a cold GPU program cache); closed with the run. */
    async freshSession(prof, opts = {}) {
      const b = await lib.launch();
      extraBrowsers.push(b);
      const s = await lib.openSession(b, prof, { noKhr: t.noKhr, selftestLeak: !!args.selftestLeak, ...opts });
      sessions.push(s);
      const close = s.close;
      s.close = async (o) => {
        await close(o);
        await b.close().catch(() => {});
      };
      return s;
    },
    async boot(s, opts = {}) {
      return lib.boot(s, opts.base || t.base, opts);
    },
    check(checkName, pass, value, expect, note) {
      const c = { name: checkName, pass: pass === null || pass === undefined ? null : !!pass, value, expect };
      if (note) c.note = note;
      checks.push(c);
      return c.pass;
    },
    async shot(page, file, opts = {}) {
      const p = path.join(out, file);
      await page.screenshot({ path: p, timeout: 60000, ...opts }).catch((e) => (data.shotErrors = [...(data.shotErrors || []), `${file}: ${e.message.slice(0, 120)}`]));
      shots.push(p.replace(/\\/g, '/'));
      return p;
    },
    log(...a) {
      if (!args.quiet) console.log(`[${name}]`, ...a);
    },
  };
  return { t, sessions, checks, data, shots, extraBrowsers };
}

async function main() {
  const argv = process.argv.slice(2);
  const args = normaliseArgs(lib.parseArgs(argv, { bool: ['noKhr', 'quiet', 'help', 'bless', 'selftestLeak', 'reducedMotion', 'pauseNearDoor', 'first', 'record'] }));
  const reg = registry();
  const name = args._[0];
  if (!name || args.help) {
    process.stdout.write(usage(reg));
    return name ? 0 : 3;
  }
  if (name === 'list') {
    process.stdout.write(usage(reg));
    return 0;
  }
  const def = reg[name];
  if (!def) {
    process.stderr.write(`unknown probe '${name}'\n` + usage(reg));
    return 3;
  }
  // Phase-2 probes write under tools/ux-probes/out/p2/ (git-ignored) unless --out says otherwise.
  const out = name.startsWith('p2/') && !args.out ? lib.outDir({ out: path.join(__dirname, 'out', name) }, name) : lib.outDir(args, name);
  const file = path.join(out, `${name.replace(/\//g, '-')}.json`);
  const startedAt = new Date().toISOString();

  if (def.static) {
    const res = await def.run({ args, out });
    const v = lib.verdict(res.checks || [], null, { requireSignUp: false });
    lib.writeJson(file, { probe: name, item: def.item, startedAt, finishedAt: new Date().toISOString(), verdict: v.verdict, exit: v.code, why: v.why, checks: res.checks, ...res.data });
    printSummary(name, v, res.checks || [], file);
    return v.code;
  }

  let server = null;
  let compare = null;
  let browser = null;
  let ctx = null;
  let error = null;
  try {
    server = await lib.serve({ base: args.base, dist: args.dist, port: args.port, label: 'subject' });
    if (args.compare || args.compareBase) {
      if (!def.compare) throw new lib.HarnessError(`${name} does not take --compare`);
      compare = await lib.serve({ base: args.compareBase, dist: args.compare, port: args.comparePort, label: 'compare' });
    }
    browser = await lib.launch();
    ctx = makeContext({ name, def, args, out, server, compare, browser });
    await def.run(ctx.t);
  } catch (e) {
    error = String((e && e.stack) || e).slice(0, 2000);
  } finally {
    if (ctx) for (const s of ctx.sessions) await s.close().catch(() => {});
    if (ctx) for (const b of ctx.extraBrowsers) await b.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    if (server) await server.stop();
    if (compare) await compare.stop();
  }
  const sessions = ctx ? ctx.sessions : [];
  const checks = ctx ? ctx.checks : [];
  const netSum = lib.netSummary(sessions);
  let v = lib.verdict(checks, netSum, { requireSignUp: sessions.length > 0 });
  if (error && v.code !== lib.EXIT.failClosed) {
    // A hook the plan's contracts promise is gone: a criterion failure, not noise.
    v = /hook missing/.test(error) ? { code: lib.EXIT.fail, verdict: 'fail', why: ['hook missing'] } : { code: lib.EXIT.inconclusive, verdict: 'inconclusive', why: ['probe error'] };
  }
  const result = {
    probe: name,
    item: def.item,
    title: def.title,
    startedAt,
    finishedAt: new Date().toISOString(),
    base: server ? server.url : null,
    dist: server && server.dist ? server.dist : args.base ? null : path.resolve(args.dist || 'dist'),
    compare: compare ? { base: compare.url, dist: compare.dist || null } : null,
    flags: { profile: args.profile || null, noKhr: !!args.noKhr, selftestLeak: !!args.selftestLeak },
    verdict: v.verdict,
    exit: v.code,
    why: v.why,
    error,
    checks,
    data: ctx ? ctx.data : {},
    shots: ctx ? ctx.shots : [],
    net: netSum,
    pageErrors: sessions.flatMap((s) => s.sink.pageerrors).slice(0, 20),
  };
  lib.writeJson(file, result);
  printSummary(name, v, checks, file, error);
  return v.code;
}

function printSummary(name, v, checks, file, error) {
  const lines = checks.map((c) => `  ${c.pass === true ? 'PASS' : c.pass === false ? 'FAIL' : '  ? '} ${c.name}: ${JSON.stringify(c.value)}${c.expect !== undefined ? `  (want ${c.expect})` : ''}`);
  process.stdout.write(`${name}: ${v.verdict} (exit ${v.code})${v.why.length ? ' - ' + v.why.slice(0, 4).join('; ') : ''}\n${lines.join('\n')}\n${error ? 'error: ' + error.split('\n')[0] + '\n' : ''}json: ${file}\n`);
}

main().then(
  (code) => process.exit(code),
  (e) => {
    process.stderr.write(String((e && e.stack) || e) + '\n');
    process.exit(lib.EXIT.inconclusive);
  },
);
