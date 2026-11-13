'use strict';
// p2/play-lib.cjs, the gameplay probes' kit (P2-E2a, ported from the
// gameplay audit's gp-lib.cjs onto lib.cjs; its harness is lib.cjs's now).
// Init scripts for a session's init list:
// - SAMPLER: every #ui-overlay surface's show / text / hide every 120 ms
//   (window.__gp.ev), so a probe can say what the visitor read and when;
// - FRAME_INIT({gpu}): app CPU per frame (renderCallback + render), draws,
//   triangles, programs, textures, optional GPU timer queries, LoAF;
// - AUDIO: every Sfx one-shot (OscillatorNode and AudioBufferSourceNode
//   starts, with the frequency the synth set and the context state).
// In-page helpers (HELPERS, window.__g): aimAt, tpTo, panel, prompt, coins,
// arc, topPanelEl. Node side: walkTo (a perfect steerer: aim the chase camera
// and hold W), gpEvents, frameStats, audio. Wave 3's gameplay probes
// (firstplay, shop, fishing, quests, race...) build on it.
const SAMPLER = `(() => {
  if (window.top !== window) return;
  const G = (window.__gp = { ev: [], n: 0 });
  const ids = new WeakMap();
  const last = new Map();
  const now = () => Math.round(performance.now());
  const norm = (s) => s.replace(/\\d+(\\.\\d+)?/g, '#');
  const vis = (el) => {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    if (r.right < 0 || r.bottom < 0 || r.left > innerWidth || r.top > innerHeight) return false;
    let n = el;
    while (n && n !== document.documentElement) {
      const cs = getComputedStyle(n);
      if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) < 0.06) return false;
      n = n.parentElement;
    }
    return true;
  };
  const idOf = (el) => {
    let i = ids.get(el);
    if (!i) { i = ++G.n; ids.set(el, i); }
    return i;
  };
  const sample = () => {
    const t = now();
    const ov = document.getElementById('ui-overlay');
    if (!ov) return;
    const seen = new Set();
    for (const el of ov.children) {
      const id = idOf(el);
      seen.add(id);
      const v = vis(el);
      const text = v ? (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 300) : '';
      const prev = last.get(id);
      if (v && text) {
        if (!prev || !prev.vis) {
          const r = el.getBoundingClientRect();
          G.ev.push({ t, id, ev: 'show', text, z: getComputedStyle(el).zIndex, rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] });
          last.set(id, { vis: true, norm: norm(text), text });
        } else if (prev.norm !== norm(text)) {
          G.ev.push({ t, id, ev: 'text', text });
          last.set(id, { vis: true, norm: norm(text), text });
        }
      } else if (prev && prev.vis) {
        G.ev.push({ t, id, ev: 'hide', text: prev.text.slice(0, 100) });
        last.set(id, { vis: false, norm: '', text: '' });
      }
    }
    for (const [id, prev] of last) {
      if (prev.vis && !seen.has(id)) { G.ev.push({ t, id, ev: 'gone', text: prev.text.slice(0, 100) }); last.set(id, { vis: false, norm: '', text: '' }); }
    }
    if (G.ev.length > 6000) G.ev.splice(0, 1000);
  };
  const start = () => setInterval(sample, 120);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();`;

const FRAME_INIT = (flags) => `(() => {
  if (window.top !== window) return;
  const FLAGS = ${JSON.stringify(flags || {})};
  const P = (window.__perf = { raf: [], frames: [], loaf: [], hooked: null, hookErr: null });
  let last = 0;
  const tick = (t) => { if (last) P.raf.push([t, t - last]); last = t; if (P.raf.length > 120000) P.raf.splice(0, 20000); requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries()) P.loaf.push({ s: Math.round(e.startTime), d: Math.round(e.duration), block: Math.round(e.blockingDuration || 0) }); }).observe({ type: 'long-animation-frame', buffered: true });
  } catch (e) {}
  function install() {
    const app = window.__app;
    const sr = app && app.renderer;
    if (!sr || typeof sr.renderCallback !== 'function' || !sr.getRenderer) return false;
    const R = sr.getRenderer();
    const gl = R.getContext();
    const ext = FLAGS.gpu ? gl.getExtension('EXT_disjoint_timer_query_webgl2') : null;
    R.info.autoReset = false;
    let cur = null;
    const origCb = sr.renderCallback;
    sr.renderCallback = function (dt) {
      const t0 = performance.now();
      cur = { t: t0, dt, upd: 0, ren: 0, gpu: null };
      origCb.call(this, dt);
      cur.upd = performance.now() - t0;
    };
    const pending = [];
    const pool = [];
    const protoRender = Object.getPrototypeOf(sr).render;
    sr.render = function () {
      R.info.reset();
      const t0 = performance.now();
      let q = null;
      if (ext) { q = pool.pop() || gl.createQuery(); gl.beginQuery(ext.TIME_ELAPSED_EXT, q); }
      protoRender.call(this);
      if (ext && q) { gl.endQuery(ext.TIME_ELAPSED_EXT); pending.push({ q, f: cur }); }
      if (cur) {
        cur.ren = performance.now() - t0;
        cur.calls = R.info.render.calls; cur.tris = R.info.render.triangles; cur.progs = R.info.programs ? R.info.programs.length : 0; cur.tex = R.info.memory ? R.info.memory.textures : 0;
        P.frames.push(cur);
        if (P.frames.length > 80000) P.frames.splice(0, 20000);
        cur = null;
      }
      if (ext) {
        const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT);
        while (pending.length) {
          const p = pending[0];
          if (!gl.getQueryParameter(p.q, gl.QUERY_RESULT_AVAILABLE)) break;
          const ns = gl.getQueryParameter(p.q, gl.QUERY_RESULT);
          if (p.f && !disjoint) p.f.gpu = ns / 1e6;
          pool.push(p.q); pending.shift();
        }
      }
    };
    P.hooked = { at: performance.now(), timerQuery: !!ext };
    return true;
  }
  const iv = setInterval(() => { try { if (install()) clearInterval(iv); } catch (e) { P.hookErr = String(e); clearInterval(iv); } }, 5);
})();`;

const AUDIO = `(() => {
  if (window.top !== window) return;
  const A = (window.__aud = { log: [] });
  try {
    const sv = AudioParam.prototype.setValueAtTime;
    AudioParam.prototype.setValueAtTime = function (v, t) { try { this.__last = v; } catch (e) {} return sv.call(this, v, t); };
    const os = OscillatorNode.prototype.start;
    OscillatorNode.prototype.start = function (...a) {
      try { const f = this.frequency.__last != null ? this.frequency.__last : this.frequency.value; A.log.push([Math.round(performance.now()), 'osc', this.type, Math.round(f), this.context.state]); if (A.log.length > 4000) A.log.splice(0, 1000); } catch (e) {}
      return os.apply(this, a);
    };
    const bs = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (...a) {
      try { A.log.push([Math.round(performance.now()), 'buf', this.buffer ? +this.buffer.duration.toFixed(2) : null, this.loop ? 1 : 0, this.context.state]); if (A.log.length > 4000) A.log.splice(0, 1000); } catch (e) {}
      return bs.apply(this, a);
    };
  } catch (e) { A.err = String(e); }
})();`;

// In-page helpers (window.__g), installed after boot.
const HELPERS = () => {
  const app = window.__app;
  const sc = app.scene;
  const ui = app.ui;
  const cam = () => sc.getOrbitCamera();
  const P = () => sc.getPlayer();
  const pos = () => P().getWorldPosition().clone();
  const V3 = () => P().getWorldPosition().constructor;
  const arc = (a, b) => a.clone().normalize().angleTo(b.clone().normalize()) * ((a.length() + b.length()) / 2);
  const tangentTo = (from, to) => {
    const n = from.clone().normalize();
    const d = to.clone().sub(from);
    d.addScaledVector(n, -d.dot(n));
    return d.normalize();
  };
  /** Aim the chase camera so 'forward' (W) heads toward world point t. */
  const aimAt = (t) => {
    const c = cam();
    const dir = tangentTo(pos(), t);
    if (c.followDir) c.followDir.copy(dir).negate();
  };
  const tpTo = (c, dist = 0, lift = 0.6) => {
    const up = c.clone().normalize();
    const ref = Math.abs(up.y) < 0.9 ? up.clone().set(0, 1, 0) : up.clone().set(1, 0, 0);
    const p = c.clone().addScaledVector(ref.clone().cross(up).normalize(), dist);
    p.setLength(c.length() + lift);
    P().setWorldPosition(p);
    return p;
  };
  const panel = () => (ui.panels ? ui.panels.current() : null);
  const prompt = () => (ui.interactionDiv && ui.interactionDiv.style.display !== 'none' ? (ui.interactionDiv.textContent || '').trim() : null);
  const coins = () => sc.getCoinsCollected();
  const vis = (el) => {
    if (!el || !el.isConnected) return false;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) < 0.05) return false;
    const b = el.getBoundingClientRect();
    return b.width > 0 && b.height > 0;
  };
  const topPanelEl = () => {
    const ov = document.getElementById('ui-overlay');
    if (!ov) return null;
    const c = [...ov.children].filter((d) => vis(d) && +getComputedStyle(d).zIndex >= 1500);
    c.sort((a, b) => +getComputedStyle(b).zIndex - +getComputedStyle(a).zIndex);
    return c[0] || null;
  };
  const text = (el) => (el ? (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim() : null);
  window.__g = { app, sc, ui, cam, P, pos, V3, arc, tangentTo, aimAt, tpTo, panel, prompt, coins, vis, topPanelEl, text };
  return true;
};

/** Walk toward world point t by aiming the camera and holding W (a visitor who steers perfectly). */
async function walkTo(page, target, { within = 2.0, maxMs = 60000, run = false, sample = 150 } = {}) {
  await page.evaluate(HELPERS);
  const t0 = Date.now();
  let lastP = null;
  let stallMs = 0;
  const path = [];
  // A11's contract: html[data-run-key] 'shift' means hold Shift to run; absent
  // or 'space' means hold Space (the wave-2 and 58c8849 builds).
  const runKey = run ? ((await page.evaluate(() => document.documentElement.getAttribute('data-run-key'))) === 'shift' ? 'Shift' : ' ') : null;
  try {
    await page.keyboard.down('w');
    if (run) await page.keyboard.down(runKey);
    while (Date.now() - t0 < maxMs) {
      const s = await page.evaluate((tt) => {
        const g = window.__g;
        const T = new (g.V3())(tt[0], tt[1], tt[2]);
        g.aimAt(T);
        const p = g.pos();
        return { d: g.arc(p, T), p: [p.x, p.y, p.z], panel: g.panel(), coins: g.coins() };
      }, target);
      path.push({ t: Date.now() - t0, d: +s.d.toFixed(2), panel: s.panel, coins: s.coins });
      if (s.d < within) break;
      if (lastP) {
        const mv = Math.hypot(s.p[0] - lastP[0], s.p[1] - lastP[1], s.p[2] - lastP[2]);
        stallMs = mv < 0.05 ? stallMs + sample : 0;
        if (stallMs > 2500) break;
      }
      lastP = s.p;
      await page.waitForTimeout(sample);
    }
  } finally {
    if (run) await page.keyboard.up(runKey).catch(() => {});
    await page.keyboard.up('w').catch(() => {});
  }
  const last = path[path.length - 1] || { d: null };
  return { ms: Date.now() - t0, arrived: last.d !== null && last.d < within, finalD: last.d, stall: stallMs > 2500, path };
}

const gpEvents = (page, since = 0) => page.evaluate((s) => (window.__gp ? window.__gp.ev.filter((e) => e.t >= s) : []), since).catch(() => []);

async function frameStats(page, t0, t1) {
  return page.evaluate(
    ([a, b]) => {
      const P = window.__perf;
      if (!P) return null;
      const fr = P.frames.filter((f) => f.t >= a && f.t < b);
      const pct = (arr, p) => {
        if (!arr.length) return null;
        const s = [...arr].sort((x, y) => x - y);
        return +s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))].toFixed(2);
      };
      const iv = [];
      for (let i = 1; i < fr.length; i++) iv.push(fr[i].t - fr[i - 1].t);
      const cpu = fr.map((f) => f.upd + f.ren);
      const gpu = fr.filter((f) => typeof f.gpu === 'number').map((f) => f.gpu);
      const loaf = P.loaf.filter((l) => l.s >= a && l.s < b);
      return {
        seconds: +((b - a) / 1000).toFixed(2),
        appFps: +(fr.length / ((b - a) / 1000)).toFixed(1),
        frameInterval: { p50: pct(iv, 50), p95: pct(iv, 95), max: iv.length ? Math.max(...iv) : null },
        over50: iv.filter((x) => x > 50).length,
        cpuFrame: { p50: pct(cpu, 50), p95: pct(cpu, 95) },
        gpu: { p50: pct(gpu, 50) },
        calls: { p50: pct(fr.map((f) => f.calls || 0), 50) },
        loafMax: loaf.length ? Math.max(...loaf.map((l) => l.d)) : 0,
        progs: fr.length ? [fr[0].progs, fr[fr.length - 1].progs] : null,
      };
    },
    [t0, t1],
  );
}

const audio = (page, since = 0) =>
  page.evaluate((s) => {
    const A = window.__aud;
    if (!A) return null;
    return { log: A.log.filter((x) => x[0] >= s && !(x[1] === 'buf' && x[3] === 1)) };
  }, since).catch(() => null);

module.exports = { SAMPLER, FRAME_INIT, AUDIO, HELPERS, walkTo, gpEvents, frameStats, audio };
