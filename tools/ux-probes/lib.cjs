'use strict';
// Shared harness for the UX probes (tools/ux-probes) and the perf gate
// (tools/perf-gate.cjs). Dev-only CommonJS; it imports no repo code.
//
// SAFETY. Probes run the production build against a local `vite preview`, and
// nothing they do may reach a real backend:
// - every non-GET request is aborted, wherever it is going;
// - Firebase (RTDB, Auth, App Check, Firestore, installations), Cloud
//   Functions and *.run.app, ElevenLabs, reCAPTCHA, Google analytics and auth
//   hosts and Vercel insights are blocked outright, GET included;
// - WebSockets are replaced by a stub before any page script runs, and
//   routeWebSocket closes anything that still tries;
// - reCAPTCHA is answered in the page by a stub (RECAPTCHA_STUB) that makes
//   no request, so a build with App Check (production) gets as far as its
//   token exchange, which is then aborted like any backend call;
// - service workers are blocked, so page.route sees every request;
// - every context starts with fresh storage, and every boot carries ?owner=1.
// A run fails closed (exit 2) only when something gets past: a response
// arrives from a blocked host, a route.continue() goes to one, or a non-GET
// reaches the network. Every intercepted attempt is logged with its method and
// host, and a run counts only if that log shows the boot proof intercepted:
// the 'POST identitytoolkit.googleapis.com …signUp', or, on a build with App
// Check (production), the 'POST content-firebaseappcheck.googleapis.com
// …:exchange…' that gates it. classify() is the one rule every interception
// goes through; test/probeSafety.test.ts pins it and the stub.
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..');
const WELCOME = '[role=dialog][aria-label="Welcome to DigiScalability Life Island"]';

// --------------------------------------------------------------------- exits
const EXIT = { pass: 0, fail: 1, failClosed: 2, inconclusive: 3 };

class HarnessError extends Error {
  constructor(msg) {
    super(msg);
    this.name = 'HarnessError';
  }
}

// ---------------------------------------------------------------------- args
/**
 * Parse `--key value`, `--key=value` and bare `--flag`. A key listed in
 * `multi` swallows every following non-flag token (`--ab distA distB`).
 */
function parseArgs(argv, { multi = [], bool = [] } = {}) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      out._.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    const key = (eq > 0 ? a.slice(2, eq) : a.slice(2)).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (eq > 0) {
      out[key] = a.slice(eq + 1);
      continue;
    }
    if (multi.includes(key)) {
      const vals = [];
      while (i + 1 < argv.length && !argv[i + 1].startsWith('--')) vals.push(argv[++i]);
      out[key] = vals;
      continue;
    }
    if (bool.includes(key) || i + 1 >= argv.length || argv[i + 1].startsWith('--')) {
      out[key] = true;
      continue;
    }
    out[key] = argv[++i];
  }
  return out;
}

const numArg = (v, name) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0 || n > 65535) throw new HarnessError(`${name} must be a port number, got ${v}`);
  return n;
};

// ---------------------------------------------------------------- playwright
function playwright() {
  try {
    return require('playwright-core');
  } catch (e) {
    throw new HarnessError(
      'playwright-core is not installed next to tools/ux-probes. Run `npm ci` in this checkout ' +
        '(devDependencies pin playwright-core 1.58.2, which uses the cached chromium-1208).',
    );
  }
}

function axeSource() {
  const file = require.resolve('axe-core/axe.min.js', { paths: [__dirname, REPO] });
  return fs.readFileSync(file, 'utf8');
}

function pngDecode(buf) {
  const { PNG } = require('playwright-core/lib/utilsBundle');
  return PNG.sync.read(buf);
}

/** GL backend: hardware ANGLE/D3D11 on Windows unless PERF_GL overrides it. */
function glArgs() {
  const mode = process.env.PERF_GL || process.env.GL || 'gpu';
  if (mode === 'gpu') {
    const angle = process.platform === 'win32' ? 'd3d11' : 'default';
    return ['--use-angle=' + angle, '--ignore-gpu-blocklist', '--enable-gpu'];
  }
  if (mode === 'swiftshader') return ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];
  return mode.split(/\s+/).filter(Boolean); // raw flags
}

async function launch() {
  const { chromium } = playwright();
  // channel 'chromium' = Chrome for Testing in new-headless mode: the same
  // chromium-1208 binary the audits ran, found in the shared ms-playwright
  // cache (PLAYWRIGHT_BROWSERS_PATH overrides the cache location).
  return chromium.launch({ channel: 'chromium', headless: true, args: glArgs() });
}

// ------------------------------------------------------------------ profiles
const UA_DESKTOP =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';
const UA_PHONE =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Mobile Safari/537.36';

const PROFILES = {
  desktop: {
    name: 'desktop',
    device: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, userAgent: UA_DESKTOP },
    query: '',
    cpu: 1,
  },
  phone: {
    name: 'phone',
    device: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: UA_PHONE },
    query: '',
    cpu: 1,
  },
  // The perf low tier: the phone context at 1x CPU, touch UI forced the way the
  // perf audit booted it (its 118-program baseline was measured like this).
  lowtier: {
    name: 'lowtier',
    device: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: UA_PHONE },
    query: '&touch=1',
    cpu: 1,
  },
  // Stage-2 breakpoints: a landscape phone, a short landscape phone, a
  // portrait tablet and a small laptop.
  landscape: {
    name: 'landscape',
    device: { viewport: { width: 844, height: 390 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: UA_PHONE },
    query: '',
    cpu: 1,
  },
  landscape667: {
    name: 'landscape667',
    device: { viewport: { width: 667, height: 375 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: UA_PHONE },
    query: '',
    cpu: 1,
  },
  tablet: {
    name: 'tablet',
    device: { viewport: { width: 768, height: 1024 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: UA_PHONE },
    query: '',
    cpu: 1,
  },
  desktop1024: {
    name: 'desktop1024',
    device: { viewport: { width: 1024, height: 768 }, deviceScaleFactor: 1, userAgent: UA_DESKTOP },
    query: '',
    cpu: 1,
  },
};

function profile(name) {
  const p = PROFILES[name];
  if (!p) throw new HarnessError(`unknown profile '${name}' (${Object.keys(PROFILES).join(' | ')})`);
  return p;
}
const isTouchProfile = (p) => !!((typeof p === 'string' ? profile(p) : p).device.hasTouch);

/**
 * Trusted touches through CDP (Input.dispatchTouchEvent), the way a phone
 * sends them: tap, drag, a held joystick, and the touch UI's own controls
 * (the D6 data-guide anchors when they exist, else the 166 px joystick hit
 * square and the 74 px USE disc).
 */
async function touch(session) {
  const { page, ctx } = session;
  const cdp = await ctx.newCDPSession(page);
  const send = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y, id]) => ({ x, y, id: id ?? 1, radiusX: 6, radiusY: 6, force: 1 })) });
  const tap = async (x, y) => {
    await send('touchStart', [[x, y, 9]]);
    await sleep(40);
    await send('touchEnd', []);
  };
  const drag = async (from, to, ms = 600, steps = 12, id = 7) => {
    await send('touchStart', [[from[0], from[1], id]]);
    for (let i = 1; i <= steps; i++) {
      await send('touchMove', [[from[0] + ((to[0] - from[0]) * i) / steps, from[1] + ((to[1] - from[1]) * i) / steps, id]]);
      await sleep(ms / steps);
    }
    await send('touchEnd', []);
  };
  const joyCenter = () =>
    page.evaluate(() => {
      const anchor = document.querySelector('[data-guide="joystick"]');
      const hit = anchor || [...document.querySelectorAll('#ui-overlay > div')].find((d) => d.style.touchAction === 'none' && d.style.width === '166px');
      if (!hit) return null;
      const ring = hit.firstElementChild && hit.firstElementChild.getBoundingClientRect().width > 40 ? hit.firstElementChild : hit;
      const b = ring.getBoundingClientRect();
      return [b.left + b.width / 2, b.top + b.height / 2];
    });
  const useBtn = () =>
    page.evaluate(() => {
      const anchor = document.querySelector('[data-guide="use-button"]');
      const el = anchor || [...document.querySelectorAll('#ui-overlay > div')].find((d) => d.style.width === '74px' && /USE/.test(d.textContent || ''));
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return [b.left + b.width / 2, b.top + b.height / 2];
    });
  /** Hold the stick (dx, dy) px off centre for ms, re-sending like a resting thumb. */
  const joyHold = async (dx, dy, ms) => {
    const c = await joyCenter();
    if (!c) return false;
    await send('touchStart', [[c[0], c[1], 3]]);
    await sleep(50);
    const end = Date.now() + ms;
    while (Date.now() < end) {
      await send('touchMove', [[c[0] + dx, c[1] + dy, 3]]);
      await sleep(120);
    }
    await send('touchEnd', []);
    return true;
  };
  return { cdp, send, tap, drag, joyCenter, useBtn, joyHold };
}

// -------------------------------------------------------------------- safety
const BLOCK_HOST = [
  /(^|\.)firebaseio\.com$/,
  /(^|\.)firebasedatabase\.app$/,
  /(^|\.)firebaseapp\.com$/,
  /^identitytoolkit\.googleapis\.com$/,
  /^securetoken\.googleapis\.com$/,
  // App Check: the SDK's token exchange lives on content-firebaseappcheck.
  /^(content-)?firebaseappcheck\.googleapis\.com$/,
  /^firestore\.googleapis\.com$/,
  /^firebaseinstallations\.googleapis\.com$/,
  /^firebase\.googleapis\.com$/,
  /firebaselogging/,
  /(^|\.)cloudfunctions\.net$/,
  /\.run\.app$/,
  /(^|\.)elevenlabs\.io$/,
  /(^|\.)elevenlabs\.com$/,
  /^www\.google\.com$/,
  /^www\.gstatic\.com$/,
  /recaptcha/,
  /^apis\.google\.com$/,
  /^accounts\.google\.com$/,
  /^oauth2\.googleapis\.com$/,
  /(^|\.)google-analytics\.com$/,
  /(^|\.)googletagmanager\.com$/,
  /(^|\.)doubleclick\.net$/,
  /(^|\.)vercel-insights\.com$/,
  /(^|\.)vercel-scripts\.com$/,
  /(^|\.)clarity\.ms$/,
  /(^|\.)hotjar\.com$/,
  // Third-party lookups EnvironmentCycle makes only with weather consent: a
  // probe's world stays on the clock it was given, never the rig's weather.
  /(^|\.)open-meteo\.com$/,
  /(^|\.)ipapi\.co$/,
  /(^|\.)bigdatacloud\.net$/,
];
const BLOCK_PATH = [/\/_vercel\/(insights|speed-insights)\//, /\/recaptcha\//, /\/__\/auth\//];

const hostOf = (u) => {
  try {
    return new URL(u).hostname;
  } catch (e) {
    return '';
  }
};
const isBlockedUrl = (u) => {
  if (/^(data|blob|about|chrome-extension):/.test(u)) return false;
  return BLOCK_HOST.some((r) => r.test(hostOf(u))) || BLOCK_PATH.some((r) => r.test(u));
};

/**
 * The interception rule, pure (test/probeSafety.test.ts pins its table):
 * - 'close-ws'     every WebSocket, wherever it goes;
 * - 'block-host'   any method to a blocked backend host or path, GET included;
 * - 'abort-nonget' any other request that is not a GET (HEAD included);
 * - 'allow'        a GET to anything else (the build's own files, fonts).
 */
function classify({ url, method = 'GET', resourceType = '', isWebSocket = false } = {}) {
  const u = String(url || '');
  if (isWebSocket || resourceType === 'websocket' || /^wss?:/i.test(u)) return 'close-ws';
  if (isBlockedUrl(u)) return 'block-host';
  if (String(method).toUpperCase() !== 'GET') return 'abort-nonget';
  return 'allow';
}

/**
 * The leak rule, pure. A leak is anything that got past classify():
 * - a 'response' from a blocked host;
 * - a 'response' to a non-GET the harness did not abort;
 * - a 'requestfailed' non-GET the harness did not abort, failing for a reason
 *   other than the client blocking it.
 * Returns the reason, or null.
 */
function leakReason({ event, method, url, aborted = false, errorText = '' }) {
  const m = String(method || 'GET').toUpperCase();
  if (event === 'response') {
    if (isBlockedUrl(String(url || ''))) return 'response from a blocked host';
    if (m !== 'GET' && !aborted) return 'non-GET reached the network';
    return null;
  }
  if (event === 'requestfailed') {
    if (m !== 'GET' && !aborted && !/ERR_BLOCKED_BY_CLIENT|ERR_ABORTED/.test(errorText || '')) return `non-GET reached the network (${errorText})`;
    return null;
  }
  return null;
}

// The boot proof: the anonymous sign-up, or (App Check builds, production)
// the token exchange it waits on. One of them must be seen intercepted.
const SIGNUP = /^POST identitytoolkit\.googleapis\.com\S*signUp/;
const APPCHECK = /^POST content-firebaseappcheck\.googleapis\.com\/\S*:exchange\w*/;
/** 'signUp' | 'appCheck' | null for one intercepted-log line. */
const bootProof = (line) => (SIGNUP.test(line) ? 'signUp' : APPCHECK.test(line) ? 'appCheck' : null);

// --selftest-leak: the harness answers this one blocked-host URL itself with a
// synthetic 200 (route.fulfill, nothing leaves the machine). Its 'response'
// event is a leak by the rule above, so the run must exit 2.
const SELFTEST_URL = 'https://firebaseinstallations.googleapis.com/ux-probes-selftest-leak';

// Before any page script: a WebSocket that never connects, a recorder for
// pointer-lock requests and haptics, and (for --no-khr) no parallel compile.
const WS_STUB = `(() => {
  class BlockedWebSocket extends EventTarget {
    constructor(url) {
      super();
      this.url = String(url); this.readyState = 0; this.protocol = ''; this.extensions = '';
      this.bufferedAmount = 0; this.binaryType = 'blob';
      this.onopen = null; this.onmessage = null; this.onerror = null; this.onclose = null;
      (window.__blockedWS = window.__blockedWS || []).push(this.url);
      setTimeout(() => {
        this.readyState = 3;
        const e = new Event('error'); this.dispatchEvent(e); if (typeof this.onerror === 'function') this.onerror(e);
        const c = new CloseEvent('close', { code: 1006, reason: 'blocked by ux-probes', wasClean: false });
        this.dispatchEvent(c); if (typeof this.onclose === 'function') this.onclose(c);
      }, 0);
    }
    send() {} close() {}
  }
  for (const [k, v] of [['CONNECTING', 0], ['OPEN', 1], ['CLOSING', 2], ['CLOSED', 3]]) { BlockedWebSocket[k] = v; BlockedWebSocket.prototype[k] = v; }
  window.WebSocket = BlockedWebSocket;
})();`;
// reCAPTCHA Enterprise, answered in the page. On a build with App Check
// (VITE_APPCHECK_SITE_KEY: production), Auth's signUp waits for an App Check
// token, the token for App Check's exchange, and the exchange for reCAPTCHA.
// Its script (www.google.com/recaptcha/enterprise.js) is blocked, and
// firebase/app-check 0.12 loads it with no onerror, so without this stub the
// exchange is never sent, the signUp never leaves, and no production run
// counts. The stub is the API App Check calls (ready, render, execute, plus
// the v3 spelling on grecaptcha itself): execute() runs the widget's success
// callback and resolves a dummy token. It makes no request of its own; the
// exchange POST and the signUp it unlocks are aborted by classify() like any
// backend call. A build without App Check never touches it.
const RECAPTCHA_STUB = `(() => {
  if (window.top !== window) return;
  const TOKEN = 'ux-probes-recaptcha-stub';
  const widgets = [];
  const stub = (window.__recaptchaStub = { rendered: 0, executed: 0 });
  const api = {
    ready(cb) { if (typeof cb === 'function') setTimeout(cb, 0); },
    render(container, params) { widgets.push(params || {}); stub.rendered++; return widgets.length - 1; },
    execute(widget) {
      const w = typeof widget === 'number' ? widgets[widget] : widgets[widgets.length - 1];
      stub.executed++;
      try { if (w && typeof w.callback === 'function') w.callback(TOKEN); } catch (e) {}
      return Promise.resolve(TOKEN);
    },
    reset() {},
    getResponse() { return TOKEN; },
  };
  window.grecaptcha = Object.assign({ enterprise: api }, api);
})();`;
const RECORDER = `(() => {
  window.__vib = [];
  try { Object.defineProperty(Navigator.prototype, 'vibrate', { configurable: true, value: function (p) { window.__vib.push({ t: Math.round(performance.now()), p }); return true; } }); } catch (e) {}
  window.__plReq = 0;
  try {
    const orig = Element.prototype.requestPointerLock;
    Element.prototype.requestPointerLock = function () { window.__plReq++; try { return orig.apply(this, arguments); } catch (e) { return Promise.reject(e); } };
  } catch (e) {}
})();`;
const NO_KHR = `(() => {
  for (const C of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) {
    if (!C) continue;
    const orig = C.prototype.getExtension;
    C.prototype.getExtension = function (name) { return name === 'KHR_parallel_shader_compile' ? null : orig.call(this, name); };
    const sup = C.prototype.getSupportedExtensions;
    C.prototype.getSupportedExtensions = function () { return (sup.call(this) || []).filter((n) => n !== 'KHR_parallel_shader_compile'); };
  }
})();`;
// Virtual clock + rAF log (the motion audit's h.cjs). performance.now() is
// looked up at call time everywhere in the app, so while __vc.on the whole sim
// advances only by the dt a probe steps: deterministic frames.
const CLOCK = `(() => {
  const realNow = performance.now.bind(performance);
  const vc = (window.__vc = { on: false, t: 0, realNow });
  performance.now = () => (vc.on ? vc.t : realNow());
  const fl = (window.__frames = { on: false, t: [] });
  const rafLoop = () => { if (fl.on) fl.t.push(realNow()); requestAnimationFrame(rafLoop); };
  requestAnimationFrame(rafLoop);
})();`;

/**
 * The init scripts every session gets, in this order, before any page script
 * and before a probe's own: the WebSocket stub, the reCAPTCHA stub (unless
 * recaptchaStub is false), the recorder, then --no-khr and the virtual clock
 * when asked for.
 */
function baseInitScripts({ noKhr = false, clock = false, recaptchaStub = true } = {}) {
  return [WS_STUB, ...(recaptchaStub ? [RECAPTCHA_STUB] : []), RECORDER, ...(noKhr ? [NO_KHR] : []), ...(clock ? [CLOCK] : [])];
}

/**
 * One browser context with the safety net. Returns { ctx, page, net, close }.
 * net = { intercepted: [], leaks: [], signUpSeen, appCheckSeen, bootProofSeen }.
 */
async function openSession(browser, prof, opts = {}) {
  const p = typeof prof === 'string' ? profile(prof) : prof;
  const ctxOpts = {
    ...p.device,
    serviceWorkers: 'block',
    locale: 'en-AU',
    timezoneId: 'Australia/Melbourne',
    ...(opts.reducedMotion ? { reducedMotion: opts.reducedMotion } : {}),
    ...(opts.context || {}),
  };
  const ctx = await browser.newContext(ctxOpts);
  // net.hold = { re, ms } lets a probe give blocked requests matching `re` a
  // realistic latency before they are aborted (they are never continued).
  const netLog = { intercepted: [], leaks: [], aborted: new WeakSet(), signUpSeen: false, appCheckSeen: false, bootProofSeen: false, offHost: new Set(), hold: null, selftestLeak: !!opts.selftestLeak };
  const intercept = (req) => {
    const line = `${req.method()} ${hostOf(req.url())}${(() => {
      try {
        return new URL(req.url()).pathname;
      } catch (e) {
        return '';
      }
    })()}`;
    netLog.intercepted.push(line.slice(0, 200));
    const proof = bootProof(line);
    if (proof === 'signUp') netLog.signUpSeen = true;
    if (proof === 'appCheck') netLog.appCheckSeen = true;
    if (proof) netLog.bootProofSeen = true;
  };
  const leak = (why, req) => netLog.leaks.push(`${why}: ${req.method()} ${req.url().slice(0, 160)}`);
  await ctx.route('**/*', async (route) => {
    const req = route.request();
    const u = req.url();
    if (netLog.selftestLeak && u === SELFTEST_URL) {
      // Answered here, never sent: the synthetic 'response' must read as a leak.
      return route.fulfill({ status: 200, contentType: 'text/plain', headers: { 'access-control-allow-origin': '*' }, body: 'ux-probes selftest' }).catch(() => {});
    }
    if (classify({ url: u, method: req.method(), resourceType: req.resourceType() }) !== 'allow') {
      netLog.aborted.add(req);
      intercept(req);
      const hold = netLog.hold;
      if (hold && hold.re.test(u)) await sleep(hold.ms);
      return route.abort('blockedbyclient').catch(() => {});
    }
    if (opts.onRoute) {
      const handled = await opts.onRoute(route, req);
      if (handled) return undefined;
    }
    // Belt and braces: never continue something the rule above should have
    // stopped (a probe's onRoute hook cannot reach this line with one either).
    if (classify({ url: u, method: req.method(), resourceType: req.resourceType() }) !== 'allow') {
      leak('route.continue() to a blocked request', req);
      return route.abort('blockedbyclient');
    }
    return route.continue();
  });
  await ctx.routeWebSocket(/.*/, (ws) => {
    netLog.intercepted.push(`WS ${hostOf(ws.url())}`);
    if (classify({ url: ws.url(), isWebSocket: true }) === 'close-ws') ws.close({ code: 1000, reason: 'ux-probes blocked' });
  });
  for (const s of baseInitScripts({ noKhr: !!opts.noKhr, clock: !!opts.clock, recaptchaStub: opts.recaptchaStub !== false })) await ctx.addInitScript(s);
  if (opts.skipName !== false)
    await ctx.addInitScript(() => {
      try {
        sessionStorage.setItem('ds_name_skipped', '1');
      } catch (e) {}
    });
  if (opts.localStorage)
    await ctx.addInitScript((kv) => {
      try {
        if (sessionStorage.getItem('__uxSeeded') === '1') return;
        for (const [k, v] of Object.entries(kv)) localStorage.setItem(k, v);
        sessionStorage.setItem('__uxSeeded', '1');
      } catch (e) {}
    }, opts.localStorage);
  if (opts.fx) await ctx.addInitScript((fx) => (window.__dsFx = Object.assign(window.__dsFx || {}, fx)), opts.fx);
  for (const s of opts.init || []) await ctx.addInitScript(s);
  const page = await ctx.newPage();
  const sink = { console: [], pageerrors: [] };
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') sink.console.push(`[${m.type()}] ${m.text().slice(0, 240)}`);
  });
  page.on('pageerror', (e) => sink.pageerrors.push(String(e).slice(0, 300)));
  page.on('request', (r) => {
    const h = hostOf(r.url());
    if (h && h !== 'localhost' && h !== '127.0.0.1' && h !== '[::1]') netLog.offHost.add(`${r.method()} ${h}`);
  });
  page.on('response', (r) => {
    const req = r.request();
    const why = leakReason({ event: 'response', method: req.method(), url: r.url(), aborted: netLog.aborted.has(req) });
    if (why) leak(why, req);
  });
  page.on('requestfailed', (req) => {
    const err = (req.failure() && req.failure().errorText) || '';
    const why = leakReason({ event: 'requestfailed', method: req.method(), url: req.url(), aborted: netLog.aborted.has(req), errorText: err });
    if (why) leak(why, req);
  });
  if (p.cpu && p.cpu > 1) {
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: p.cpu });
  }
  let closed = false;
  const close = async ({ waitSignUpMs = 15000 } = {}) => {
    if (closed) return;
    closed = true;
    // The boot proof (signUp, or App Check's exchange) shows the net is live;
    // give a short run time to reach it, as long as the page is on the app.
    const t0 = Date.now();
    while (!netLog.bootProofSeen && Date.now() - t0 < waitSignUpMs) {
      const onApp = await page.evaluate(() => !!window.__app).catch(() => false);
      if (!onApp) break;
      await sleep(250);
    }
    // Whether App Check used the reCAPTCHA stub (only a build with App Check does).
    netLog.recaptchaStub = await page.evaluate(() => (window.__recaptchaStub ? { ...window.__recaptchaStub } : null)).catch(() => null);
    await ctx.close().catch(() => {});
  };
  return { ctx, page, net: netLog, sink, profile: p, close };
}

/** --selftest-leak: ask the page for the one URL the harness answers itself. */
async function triggerSelftestLeak(session) {
  if (!session || !session.net || !session.net.selftestLeak || session.net.selftestFired) return false;
  session.net.selftestFired = true;
  await session.page
    .evaluate((u) => fetch(u, { mode: 'no-cors', cache: 'no-store' }).then(() => true, () => false), SELFTEST_URL)
    .catch(() => false);
  // The 'response' event can trail the fetch's resolution by a tick.
  for (let i = 0; i < 20 && !session.net.leaks.length; i++) await sleep(100);
  return session.net.leaks.length > 0;
}

function netSummary(sessions) {
  const leaks = [];
  const intercepted = new Map();
  let signUp = 0;
  let appCheck = 0;
  let proof = 0;
  let stubbed = 0;
  const offHost = new Set();
  for (const s of sessions) {
    leaks.push(...s.net.leaks);
    if (s.net.signUpSeen) signUp++;
    if (s.net.appCheckSeen) appCheck++;
    if (s.net.recaptchaStub && s.net.recaptchaStub.executed > 0) stubbed++;
    if (s.net.bootProofSeen || s.net.signUpSeen || s.net.appCheckSeen) proof++;
    for (const l of s.net.intercepted) {
      const k = l.replace(/(identitytoolkit\.googleapis\.com\S*signUp)\S*/, '$1').replace(/(content-firebaseappcheck\.googleapis\.com)\/\S*(:exchange\w*)/, '$1/…$2');
      intercepted.set(k, (intercepted.get(k) || 0) + 1);
    }
    for (const h of s.net.offHost) offHost.add(h);
  }
  return {
    sessions: sessions.length,
    sessionsWithSignUpIntercepted: signUp,
    sessionsWithAppCheckIntercepted: appCheck,
    sessionsWithBootProof: proof,
    signUpIntercepted: signUp > 0,
    appCheckIntercepted: appCheck > 0,
    // A run counts when either boot proof was intercepted (production's App
    // Check gates the sign-up behind its exchange).
    bootProofIntercepted: proof > 0,
    // Sessions where App Check asked the reCAPTCHA stub for a token.
    sessionsWithRecaptchaStubUsed: stubbed,
    leaks,
    intercepted: [...intercepted.entries()].map(([k, n]) => `${k} x${n}`),
    offHostRequests: [...offHost],
  };
}

// ------------------------------------------------------------------- serving
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function portInUse(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const s = net.connect({ port, host });
    s.once('connect', () => {
      s.destroy();
      resolve(true);
    });
    s.once('error', () => resolve(false));
  });
}

const servers = new Set();
let exitHooked = false;
function hookExit() {
  if (exitHooked) return;
  exitHooked = true;
  const killAll = () => {
    for (const s of servers) s.killSync();
  };
  process.on('exit', killAll);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => {
      killAll();
      process.exit(130);
    });
  }
}

/**
 * `vite preview --outDir <dist> --port <n> --strictPort` as a child process,
 * killed by PID on exit and on SIGINT. A busy port is an error, never reused.
 */
async function startPreview({ dist, port, host = '127.0.0.1', label = 'preview' }) {
  const absDist = path.resolve(dist);
  if (!fs.existsSync(path.join(absDist, 'index.html'))) throw new HarnessError(`${absDist} has no index.html: run \`npm run build\` first`);
  if (await portInUse(port, host)) throw new HarnessError(`port ${port} is busy; pass a free --port (ports are never reused)`);
  // vite's package exports omit bin/, so resolve its package.json and step in.
  const viteBin = path.join(path.dirname(require.resolve('vite/package.json', { paths: [REPO, __dirname] })), 'bin', 'vite.js');
  hookExit();
  const child = spawn(process.execPath, [viteBin, 'preview', '--outDir', absDist, '--port', String(port), '--strictPort', '--host', host], {
    cwd: REPO,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  let exited = null;
  child.once('exit', (code) => (exited = code === null ? 'signal' : code));
  const srv = {
    label,
    pid: child.pid,
    port,
    url: `http://${host}:${port}`,
    dist: absDist,
    killSync() {
      if (exited !== null) return;
      try {
        if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
        else process.kill(child.pid, 'SIGTERM');
      } catch (e) {}
      exited = exited ?? 'killed';
      servers.delete(srv);
    },
    async stop() {
      srv.killSync();
      for (let i = 0; i < 40 && (await portInUse(port, host)); i++) await sleep(100);
    },
  };
  servers.add(srv);
  for (let i = 0; i < 300; i++) {
    if (exited !== null) throw new HarnessError(`vite preview on ${port} exited (${exited}): ${out.trim().slice(-400)}`);
    if (await portInUse(port, host)) return srv;
    await sleep(100);
  }
  srv.killSync();
  throw new HarnessError(`vite preview on ${port} did not start within 30 s`);
}

/** --base attaches to a running preview; --dist/--port starts one. */
async function serve({ base, dist, port, label }) {
  if (base) {
    const u = new URL(base);
    const p = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
    // 'localhost' may resolve to ::1 while vite listens on 127.0.0.1 only.
    const hosts = u.hostname === 'localhost' ? ['127.0.0.1', '::1'] : [u.hostname.replace(/^\[|\]$/g, '')];
    let up = false;
    for (const h of hosts) up = up || (await portInUse(p, h));
    if (!up) throw new HarnessError(`nothing listens at ${base}`);
    return { url: base.replace(/\/$/, ''), pid: null, port: p, stop: async () => {}, attached: true, label };
  }
  if (!port) throw new HarnessError('pass --port <n> with --dist (ports are always arguments), or --base <url>');
  return startPreview({ dist: dist || 'dist', port: numArg(port, '--port'), label });
}

// ---------------------------------------------------------------------- boot
const APP_QUERY = '?owner=1';

async function boot(session, base, { query = '', waitWelcome = true, timeout = 240000 } = {}) {
  const { page } = session;
  const q = APP_QUERY + (session.profile.query || '') + (query ? '&' + query.replace(/^[?&]/, '') : '');
  const t0 = Date.now();
  await page.goto(`${base}/${q}`, { waitUntil: 'domcontentloaded', timeout });
  await page.waitForFunction(() => window.__lifeIslandReady === true, null, { timeout, polling: 100 });
  const readyMs = Date.now() - t0;
  let welcomeMs = null;
  if (waitWelcome) {
    const ok = await page
      .waitForSelector(`${WELCOME} button[data-dismiss]`, { state: 'visible', timeout: 120000 })
      .then(() => true)
      .catch(() => false);
    if (ok) welcomeMs = Date.now() - t0;
  }
  await page.evaluate(HELPERS);
  await triggerSelftestLeak(session);
  return { readyMs, welcomeMs };
}

async function dismissWelcome(page) {
  const sel = `${WELCOME} button[data-dismiss]`;
  await page.waitForSelector(sel, { state: 'visible', timeout: 60000 });
  await page.click(sel);
  await page.waitForTimeout(300);
}

/** One rAF (or n) in the page. */
const nextFrames = (page, n = 1) =>
  page.evaluate(
    (n) =>
      new Promise((res) => {
        let k = 0;
        const f = () => (++k >= n ? res() : requestAnimationFrame(f));
        requestAnimationFrame(f);
      }),
    n,
  );

// In-page helpers, installed after every boot as window.__h.
const HELPERS = () => {
  const app = window.__app;
  const sc = app.scene;
  const oc = () => sc.getOrbitCamera();
  const player = () => sc.getPlayer();
  const pos = () => player().getWorldPosition().clone();
  const up = () => pos().normalize();
  const V3 = pos().constructor;
  /** Tangent-plane projection of v at the player. */
  const flat = (v, n = up()) => v.clone().addScaledVector(n, -v.dot(n));
  /** Signed angle (deg) from a to b about the local up: + = counter-clockwise seen from above. */
  const yawBetween = (a, b) => {
    const n = up();
    const pa = flat(a, n).normalize();
    const pb = flat(b, n).normalize();
    const c = pa.clone().cross(pb);
    return (Math.atan2(c.dot(n), pa.dot(pb)) * 180) / Math.PI;
  };
  const camFwd = () => {
    const cam = sc.getCamera();
    return cam.getWorldDirection(new V3());
  };
  /** Camera-space bearing of a world point: + = right of the view centre. */
  const bearing = (p) => {
    const cam = sc.getCamera();
    cam.updateMatrixWorld(true);
    const q = p.clone().applyMatrix4(cam.matrixWorldInverse);
    return (Math.atan2(q.x, -q.z) * 180) / Math.PI;
  };
  const followDir = () => (oc().followDir ? oc().followDir.clone() : null);
  /** Rotate the orbit about the player's up by deg (+ = counter-clockwise). */
  const rotateFollow = (deg) => {
    const o = oc();
    if (!o.followDir) return false;
    o.followDir.applyAxisAngle(up(), (deg * Math.PI) / 180);
    if (typeof o.snapToPlayer === 'function') o.snapToPlayer();
    return true;
  };
  const wrap = (d) => {
    let x = d;
    while (x > 180) x -= 360;
    while (x <= -180) x += 360;
    return x;
  };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const raf = (n = 1) =>
    new Promise((res) => {
      let k = 0;
      const f = () => (++k >= n ? res() : requestAnimationFrame(f));
      requestAnimationFrame(f);
    });
  /** Run fn once per animation frame for n frames; resolves with frame deltas. */
  const frames = (n, fn) =>
    new Promise((res) => {
      const dts = [];
      let last = performance.now();
      let i = 0;
      const step = () => {
        const now = performance.now();
        dts.push(now - last);
        last = now;
        if (i < n) {
          fn(i);
          i++;
          requestAnimationFrame(step);
        } else res(dts);
      };
      requestAnimationFrame(step);
    });
  /** Put the player `dist` units from world point c along a tangent, `lift` above. */
  const tpNear = (c, dist, lift = 0.6) => {
    const n = c.clone().normalize();
    const ref = Math.abs(n.y) < 0.9 ? new V3(0, 1, 0) : new V3(1, 0, 0);
    const tan = ref.clone().cross(n).normalize();
    const p = c.clone().addScaledVector(tan, dist);
    p.setLength(c.length() + lift);
    player().setWorldPosition(p);
    return p;
  };
  const visible = (el) => {
    if (!el || !el.isConnected) return false;
    const b = el.getBoundingClientRect();
    if (b.width < 1 || b.height < 1) return false;
    for (let n = el; n && n !== document; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity < 0.05) return false;
    }
    return b.right > 0 && b.bottom > 0 && b.left < innerWidth && b.top < innerHeight;
  };
  const rect = (el) => {
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height) };
  };
  const describe = (el) => {
    if (!el) return null;
    if (el === document.body) return 'BODY';
    const t = (el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    return `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}[${t}]`;
  };
  /** The open zone panel (z 1650 with an h2 or the email row). */
  const zonePanel = () =>
    [...document.querySelectorAll('#ui-overlay > div')].find((d) => d.style.zIndex === '1650' && d.querySelector('[data-email], h2')) || null;
  const panels = () => {
    const pm = app.ui && app.ui.panels;
    if (!pm) return null;
    return { current: pm.current(), stack: (pm.stack || []).map((e) => e.id), scrim: pm.scrim ? getComputedStyle(pm.scrim).display : null };
  };
  const zones = () => sc.getZonesManager().getZones().map((z) => ({ id: z.id, pos: z.getPosition().clone() }));
  const zonePos = (id) => {
    const z = sc.getZonesManager().getZones().find((x) => x.id === id);
    return z ? z.getPosition().clone() : null;
  };
  /** Great-circle distance (u) from the player to a world point. */
  const arcTo = (p) => {
    const P = pos();
    return P.clone().normalize().angleTo(p.clone().normalize()) * P.length();
  };
  /** The gold compass arrow's screen bearing: 0 = up, + = clockwise (right). null when hidden. */
  const arrow = () => {
    const ui = app.ui;
    const div = ui.compassDiv;
    const el = ui.compassArrow;
    if (!div || !el || getComputedStyle(div).display === 'none') return null;
    const tf = el.style.transform || '';
    let deg = null;
    const m = /rotate\((-?[\d.]+)(deg|rad|turn)\)/.exec(tf);
    if (m) deg = m[2] === 'deg' ? +m[1] : m[2] === 'rad' ? (+m[1] * 180) / Math.PI : +m[1] * 360;
    else {
      const ct = getComputedStyle(el).transform;
      const mm = /matrix\(([^)]+)\)/.exec(ct || '');
      if (mm) {
        const [a, b] = mm[1].split(',').map(Number);
        deg = (Math.atan2(b, a) * 180) / Math.PI;
      }
    }
    if (deg === null) return null;
    // The glyph points right at 0deg, so screen-up is -90deg.
    return { rel: wrap(deg + 90), label: ui.compassLabel ? ui.compassLabel.textContent : null };
  };
  // The compass pill's full label. Under 480 px the pill shows only the
  // label's first token (its icon), so the label is read where the UI is
  // handed it: updateQuestCompass(state), observed, never changed.
  const ui0 = app.ui;
  if (ui0 && typeof ui0.updateQuestCompass === 'function' && !ui0.updateQuestCompass.__probe) {
    const orig = ui0.updateQuestCompass;
    const w = function (state) {
      window.__compassFull = state ? state.label : null;
      return orig.apply(this, arguments);
    };
    w.__probe = true;
    ui0.updateQuestCompass = w;
  }
  const compassFull = () => (window.__compassFull !== undefined ? window.__compassFull : ui0 && ui0.compassLabel ? ui0.compassLabel.textContent : null);
  window.__h = { app, sc, oc, player, pos, up, V3, flat, yawBetween, camFwd, bearing, followDir, rotateFollow, wrap, wait, raf, frames, tpNear, visible, rect, describe, zonePanel, panels, zones, zonePos, arcTo, arrow, compassFull };
  return true;
};

// Page-side: stop the live loop and drive the sim on the virtual clock
// (needs the session opened with { clock: true }).
const FREEZE = () => {
  const app = window.__app;
  app.renderer.stopRenderLoop();
  window.__vc.t = window.__vc.realNow();
  window.__vc.on = true;
  window.__step = (n, dt) => {
    for (let i = 0; i < n; i++) {
      window.__vc.t += dt * 1000;
      app.update(dt);
    }
  };
  window.__render = () => app.renderer.render();
  return true;
};
const THAW = () => {
  const r = window.__app.renderer;
  window.__vc.on = false;
  r.isRunning = false;
  r.startRenderLoop(r.scene, r.camera, r.renderCallback);
  return true;
};

// ------------------------------------------------------------------- numbers
const sorted = (a) => [...a].filter((x) => x !== null && x !== undefined && !Number.isNaN(x)).sort((x, y) => x - y);
const pct = (arr, p) => {
  const a = sorted(arr);
  if (!a.length) return null;
  const i = Math.min(a.length - 1, Math.max(0, Math.ceil((p / 100) * a.length) - 1));
  return a[i];
};
const median = (arr) => {
  const a = sorted(arr);
  if (!a.length) return null;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};
const mean = (arr) => {
  const a = sorted(arr);
  return a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
};
const round = (x, d = 2) => (x === null || x === undefined || Number.isNaN(x) ? null : +Number(x).toFixed(d));
const dist = (arr) => ({ n: sorted(arr).length, p50: round(pct(arr, 50)), p95: round(pct(arr, 95)), p99: round(pct(arr, 99)), max: round(pct(arr, 100)), mean: round(mean(arr)) });

// ---------------------------------------------------------------- contrast
const lin = (c) => {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const luminance = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
const contrastRatio = (a, b) => {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};
const parseRgb = (s) => {
  const m = /rgba?\(([^)]+)\)/.exec(s || '');
  if (!m) return null;
  const p = m[1].split(/[,\s/]+/).filter(Boolean).map((x) => parseFloat(x));
  return { rgb: [p[0], p[1], p[2]], a: p.length > 3 ? p[3] : 1 };
};

// ------------------------------------------------------------------- output
function outDir(args, name) {
  const dir = path.resolve(args.out || path.join(os.tmpdir(), 'ux-probes', name));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

/** Parsed JSON, or null when the file is missing or unreadable. */
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return null;
  }
}

// --------------------------------------------------------------- seed golden
/**
 * test/golden/seedDraws.json of the checkout under test, never of this tool's
 * own checkout: `--golden <path>` when given; else the checkout that holds
 * `--dist` (the build being measured was made there); else the current
 * directory. --bless writes to the same path.
 */
function goldenPath(args) {
  if (args.golden && args.golden !== true) return path.resolve(String(args.golden));
  const rel = path.join('test', 'golden', 'seedDraws.json');
  if (args.dist && args.dist !== true) {
    const root = path.resolve(String(args.dist), '..');
    if (fs.existsSync(path.join(root, 'package.json'))) return path.join(root, rel);
  }
  return path.resolve(process.cwd(), rel);
}

/**
 * The golden's { total, marks } for one profile. B0's golden is the flat
 * window.__dsSeedDraws shape, { marks, total }, which every profile must
 * match. A { desktop, lowtier } file (older --bless output) is read per
 * profile.
 */
function goldenFor(golden, prof) {
  if (!golden || typeof golden !== 'object') return null;
  if (golden.marks && golden.total !== undefined) return { total: golden.total, marks: golden.marks };
  const g = golden[prof];
  return g && g.marks && g.total !== undefined ? { total: g.total, marks: g.marks } : null;
}

// ---------------------------------------------------------------- host load
/** CPU time over every core of this machine (ms), for a busy share over a window. */
function hostCpu() {
  let busy = 0;
  let total = 0;
  for (const c of os.cpus()) {
    const t = c.times;
    busy += t.user + t.nice + t.sys + t.irq;
    total += t.user + t.nice + t.sys + t.irq + t.idle;
  }
  return { busy, total };
}
const hostBusyPct = (a, b) => (b.total > a.total ? round(((b.busy - a.busy) / (b.total - a.total)) * 100, 1) : null);

/**
 * The machine's load over a window, split between this browser and the rest:
 * os.cpus() for the whole machine, CDP SystemInfo.getProcessInfo for this
 * browser's own processes (browser, renderers, GPU). otherBusyPct is what
 * other sessions, builds and apps took; null when CDP cannot say. A probe
 * that judges frame times reads it, since its own browser's share is not
 * noise. The processes are sampled every second and each one's CPU time is
 * summed by pid, so a renderer that starts and exits inside the window (a
 * context opened and closed) is counted up to its last sample, not handed to
 * 'other'. stop() returns { hostBusyPct, browserPct, otherBusyPct, threads }.
 */
async function hostLoadMeter(browser, { everyMs = 1000 } = {}) {
  let cdp = null;
  try {
    cdp = await browser.newBrowserCDPSession();
  } catch (e) {}
  const seen = new Map(); // pid -> last cpuTime (s)
  let ownMs = 0;
  let ok = !!cdp;
  let first = true;
  const sample = async () => {
    if (!cdp || !ok) return;
    try {
      const { processInfo } = await cdp.send('SystemInfo.getProcessInfo');
      for (const p of processInfo) {
        const cpu = p.cpuTime || 0;
        // A process already running at the first sample is the baseline; one
        // that appears later started inside the window, so all of it counts.
        const prev = seen.has(p.id) ? seen.get(p.id) : first ? cpu : 0;
        ownMs += Math.max(0, cpu - prev) * 1000;
        seen.set(p.id, cpu);
      }
      first = false;
    } catch (e) {
      ok = false;
    }
  };
  const a = hostCpu();
  await sample();
  let busy = null;
  const timer = setInterval(() => {
    if (!busy) busy = sample().finally(() => (busy = null));
  }, everyMs);
  if (timer.unref) timer.unref();
  return {
    async stop() {
      clearInterval(timer);
      if (busy) await busy;
      await sample();
      const z = hostCpu();
      if (cdp) await cdp.detach().catch(() => {});
      const total = z.total - a.total;
      const host = total > 0 ? ((z.busy - a.busy) / total) * 100 : null;
      const own = ok && total > 0 ? (ownMs / total) * 100 : null;
      return { hostBusyPct: round(host, 1), browserPct: round(own, 1), otherBusyPct: host !== null && own !== null ? round(Math.max(0, host - own), 1) : null, threads: os.cpus().length };
    },
  };
}

/**
 * Verdict over a list of checks. A check is { name, pass: true|false|null }
 * where null = could not be evaluated (inconclusive). Leaks and a missing
 * boot proof (signUp, or App Check's exchange) override everything.
 */
function verdict(checks, netSum, { requireSignUp = true } = {}) {
  if (netSum && netSum.leaks.length) return { code: EXIT.failClosed, verdict: 'fail-closed', why: netSum.leaks.slice(0, 5) };
  const proof = netSum && (netSum.bootProofIntercepted !== undefined ? netSum.bootProofIntercepted : netSum.signUpIntercepted);
  if (requireSignUp && netSum && !proof) return { code: EXIT.inconclusive, verdict: 'inconclusive', why: ['neither the boot identitytoolkit signUp POST nor the App Check exchange was seen intercepted: the run does not count'] };
  const failed = checks.filter((c) => c.pass === false);
  const open = checks.filter((c) => c.pass === null || c.pass === undefined);
  if (failed.length) return { code: EXIT.fail, verdict: 'fail', why: failed.map((c) => c.name) };
  if (open.length) return { code: EXIT.inconclusive, verdict: 'inconclusive', why: open.map((c) => c.name) };
  return { code: EXIT.pass, verdict: 'pass', why: [] };
}

module.exports = {
  REPO,
  WELCOME,
  EXIT,
  HarnessError,
  parseArgs,
  numArg,
  playwright,
  axeSource,
  pngDecode,
  launch,
  glArgs,
  PROFILES,
  profile,
  isTouchProfile,
  touch,
  BLOCK_HOST,
  BLOCK_PATH,
  isBlockedUrl,
  classify,
  leakReason,
  bootProof,
  SELFTEST_URL,
  RECAPTCHA_STUB,
  baseInitScripts,
  triggerSelftestLeak,
  openSession,
  netSummary,
  portInUse,
  startPreview,
  serve,
  boot,
  dismissWelcome,
  nextFrames,
  HELPERS,
  FREEZE,
  THAW,
  sleep,
  pct,
  median,
  mean,
  round,
  dist,
  luminance,
  contrastRatio,
  parseRgb,
  outDir,
  writeJson,
  readJson,
  goldenPath,
  goldenFor,
  hostCpu,
  hostBusyPct,
  hostLoadMeter,
  verdict,
};
