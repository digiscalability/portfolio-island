'use strict';
// Accessibility probes (D3, D4, D8): label-on-fill contrast sampled from real
// pixels, and axe-core 4.10.3 on named surfaces.
//
// Contrast method (the UI audit's contrastAt): the label is made transparent,
// its box is screenshotted, and the fill is the median of those pixels (the
// 90th percentile is the worst case). The label colour is the computed colour
// times the element's effective opacity, composited on that fill.
const lib = require('./lib.cjs');

const W = lib.WELCOME;

/** Find an element in-page: { sel, text?, scope? } (first visible match). */
const FIND = ({ sel, text, scope }) => {
  const h = window.__h;
  const root = scope === 'npcChat' ? window.__app.ui.npcChatDiv : document;
  if (!root) return null;
  const re = text ? new RegExp(text, 'i') : null;
  const el = [...root.querySelectorAll(sel)].find((e) => h.visible(e) && (!re || re.test((e.textContent || '').trim())));
  if (!el) return null;
  document.querySelectorAll('[data-ux-ctr]').forEach((e) => e.removeAttribute('data-ux-ctr'));
  el.setAttribute('data-ux-ctr', '1');
  const b = el.getBoundingClientRect();
  let op = 1;
  for (let n = el; n && n !== document; n = n.parentElement) op *= +getComputedStyle(n).opacity;
  const cs = getComputedStyle(el);
  return {
    box: { x: Math.max(0, b.left), y: Math.max(0, b.top), width: Math.min(innerWidth - Math.max(0, b.left), b.width), height: Math.min(innerHeight - Math.max(0, b.top), b.height) },
    color: cs.color,
    opacity: op,
    font: cs.fontSize,
    weight: cs.fontWeight,
    text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40),
  };
};

async function contrastAt(page, find, note) {
  const info = await page.evaluate(FIND, find);
  if (!info || info.box.width < 2 || info.box.height < 2) return { note, missing: true };
  await page.evaluate(() => {
    const st = document.createElement('style');
    st.id = 'ux-ctr-style';
    st.textContent = '[data-ux-ctr], [data-ux-ctr] * { color: transparent !important; text-shadow: none !important; -webkit-text-fill-color: transparent !important; }';
    document.head.appendChild(st);
  });
  await page.waitForTimeout(60);
  const buf = await page.screenshot({ clip: info.box });
  await page.evaluate(() => {
    const st = document.getElementById('ux-ctr-style');
    if (st) st.remove();
    document.querySelectorAll('[data-ux-ctr]').forEach((e) => e.removeAttribute('data-ux-ctr'));
  });
  const img = lib.pngDecode(buf);
  const px = [];
  for (let i = 0; i < img.data.length; i += 4) px.push([img.data[i], img.data[i + 1], img.data[i + 2]]);
  px.sort((a, b) => lib.luminance(a) - lib.luminance(b));
  const at = (p) => px[Math.min(px.length - 1, Math.floor(px.length * p))];
  const bgMed = at(0.5);
  const bgLight = at(0.9);
  const c = lib.parseRgb(info.color);
  const a = (c ? c.a : 1) * info.opacity;
  const comp = (bg) => (c ? c.rgb.map((v, i) => v * a + bg[i] * (1 - a)) : [255, 255, 255]);
  const size = parseFloat(info.font);
  const large = size >= 24 || (+info.weight >= 700 && size >= 18.66);
  return {
    note,
    text: info.text,
    font: info.font,
    weight: info.weight,
    color: info.color,
    effAlpha: lib.round(a, 2),
    bgMedian: bgMed,
    bgP90: bgLight,
    ratioMedian: lib.round(lib.contrastRatio(comp(bgMed), bgMed), 2),
    ratioWorst: lib.round(lib.contrastRatio(comp(bgLight), bgLight), 2),
    largeText: large,
  };
}

/** Focus ring: keyboard-focus the element, diff against the blurred frame. */
async function focusRing(page, sel, note) {
  const box = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el || !window.__h.visible(el)) return null;
    const b = el.getBoundingClientRect();
    const pad = 8;
    return { x: Math.max(0, b.left - pad), y: Math.max(0, b.top - pad), width: Math.min(innerWidth, b.width + 2 * pad), height: Math.min(innerHeight, b.height + 2 * pad), inner: { x: b.left, y: b.top, w: b.width, h: b.height } };
  }, sel);
  if (!box) return { note, missing: true };
  const clip = { x: box.x, y: box.y, width: box.width, height: box.height };
  await page.evaluate(() => document.activeElement && document.activeElement.blur && document.activeElement.blur());
  await page.waitForTimeout(80);
  const off = lib.pngDecode(await page.screenshot({ clip }));
  // :focus-visible needs a keyboard focus: focus the element before it, then Tab.
  await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    const all = [...document.querySelectorAll('button, a[href], input, [tabindex]:not([tabindex="-1"]), [role=button]')].filter((e) => e.tabIndex >= 0 && window.__h.visible(e));
    const i = all.indexOf(el);
    if (i > 0) all[i - 1].focus();
    else if (document.activeElement) document.activeElement.blur();
  }, sel);
  await page.keyboard.press('Tab');
  await page.waitForTimeout(120);
  const focusedOk = await page.evaluate((sel) => document.activeElement === document.querySelector(sel), sel);
  if (!focusedOk) await page.focus(sel).catch(() => {});
  const on = lib.pngDecode(await page.screenshot({ clip }));
  await page.evaluate(() => document.activeElement && document.activeElement.blur && document.activeElement.blur());
  // Ring pixels: changed by focus. Outer edge: ring pixels with an unchanged
  // neighbour; the surround: those unchanged neighbours, as they were.
  const w = on.width;
  const h = on.height;
  const idx = (x, y) => (y * w + x) * 4;
  const diff = (x, y) => {
    const i = idx(x, y);
    return Math.abs(on.data[i] - off.data[i]) + Math.abs(on.data[i + 1] - off.data[i + 1]) + Math.abs(on.data[i + 2] - off.data[i + 2]) > 48;
  };
  const edge = [];
  const around = [];
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      if (!diff(x, y)) continue;
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        if (!diff(x + dx, y + dy)) {
          const i = idx(x, y);
          const j = idx(x + dx, y + dy);
          // Outer edge only: the unchanged neighbour lies outside the element box.
          const gx = box.x + x + dx;
          const gy = box.y + y + dy;
          const outside = gx < box.inner.x || gx > box.inner.x + box.inner.w || gy < box.inner.y || gy > box.inner.y + box.inner.h;
          if (!outside) continue;
          edge.push([on.data[i], on.data[i + 1], on.data[i + 2]]);
          around.push([on.data[j], on.data[j + 1], on.data[j + 2]]);
          break;
        }
      }
    }
  }
  if (!edge.length) return { note, ringVisible: false, focused: focusedOk };
  const med = (arr) => {
    const s = [...arr].sort((a, b) => lib.luminance(a) - lib.luminance(b));
    return s[s.length >> 1];
  };
  const ring = med(edge);
  const bg = med(around);
  return { note, ringVisible: true, focused: focusedOk, edgePixels: edge.length, ring, surround: bg, ratio: lib.round(lib.contrastRatio(ring, bg), 2) };
}

const SURFACES_DESKTOP = [
  ['welcome', { sel: `${W} button[data-dismiss]` }, 'Explore the island'],
  ['welcome', { sel: `${W} button[data-cta="projects"]` }, 'See the work (primary)'],
  ['hud', { sel: '#ui-overlay [aria-label="Open portfolio menu"]' }, 'Portfolio pill'],
  ['hud', { sel: '#ui-overlay [data-cta="work-with-me"], #ui-overlay [aria-label^="Work with me"]' }, 'Work with me pill'],
];

/** Open each surface the way the app does and measure its filled buttons. */
async function measureSession(t, prof, hour, withKeys = false) {
  const touch = prof !== 'desktop';
  const s = await t.session(prof);
  const b = await t.boot(s, { query: `hour=${hour}` });
  const { page } = s;
  const rows = [];
  const m = async (find, note) => rows.push(await contrastAt(page, find, note));
  for (const [, find, note] of SURFACES_DESKTOP.filter(([k]) => k === 'welcome')) await m(find, note);
  await (touch ? page.tap(`${W} button[data-dismiss]`) : page.click(`${W} button[data-dismiss]`));
  await page.waitForTimeout(1500);
  if (touch && (await page.$('.hud-btn[aria-label="Open island menu"]'))) {
    // The pills live in the drawer on a phone.
    await page.tap('.hud-btn[aria-label="Open island menu"]');
    await page.waitForTimeout(600);
  }
  for (const [, find, note] of SURFACES_DESKTOP.filter(([k]) => k === 'hud')) await m(find, note);
  await t.shot(page, `contrast-${prof}-h${hour}-hud.png`);
  const keys = withKeys ? await keyRows(page) : null;
  const ring = !touch && (hour === 12 || hour === 18) ? await focusRing(page, '#ui-overlay [aria-label="Open portfolio menu"]', 'focus ring on the Portfolio pill') : null;
  await page.evaluate(() => window.__app.ui.panels.closeAll());
  // Hire card: LinkedIn.
  await page.evaluate(() => window.__app.ui.showHireCard('menu'));
  await page.waitForTimeout(700);
  await m({ sel: 'a, button', text: 'LinkedIn' }, 'LinkedIn (hire card)');
  await page.evaluate(() => window.__app.ui.panels.closeAll());
  // Contact: the voice call button.
  await page.evaluate(() => window.__app.ui.showZonePanel({ id: 'contact', name: 'contact' }));
  await page.waitForSelector('#rd-start', { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(300);
  await m({ sel: '#rd-start' }, 'Start voice call');
  await page.evaluate(() => window.__app.ui.panels.closeAll());
  // NPC chat: Send.
  await page.evaluate(() => window.__app.ui.showNpcChat('Probe', 'Hello.', async () => 'Thanks.'));
  await page.waitForTimeout(500);
  await m({ sel: 'button', text: '^send$', scope: 'npcChat' }, 'Send (NPC chat)');
  await page.evaluate(() => window.__app.ui.closeNpcChat());
  // The name prompt.
  await page.evaluate(() => window.__app.ui.promptName('', () => {}));
  await page.waitForTimeout(500);
  await m({ sel: 'button', text: 'enter the island' }, 'Name prompt CTA');
  await page.keyboard.press('Escape').catch(() => {});
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find((x) => /enter the island/i.test(x.textContent || ''));
    const modal = btn && btn.closest('#ui-overlay > div');
    if (modal) modal.remove();
  });
  // Customise: Done.
  await page.evaluate(() => typeof window.__app.openCustomize === 'function' && window.__app.openCustomize());
  await page.waitForTimeout(500);
  await m({ sel: '#close-customize, button', text: '^done$' }, 'Done (customise)');
  await page.evaluate(() => window.__app.ui.customizeDiv && window.__app.ui.hideCustomize && window.__app.ui.hideCustomize());
  // Phone: the touch captions over grass (spawn), sand (a beach) and sky.
  let captions = null;
  if (touch) captions = await captionsOver(t, page, prof, hour);
  return { boot: b, rows, ring, captions, keys };
}

/**
 * D7's key markup (wave-3 amendments, rows other items need): the glyph
 * pill's text against its own fill, for every ring tint, and the keycap's
 * background. The probe renders one of each with the build's own classes
 * (kbd.kc, span.kg with --kg-ring), so no villager prompt is needed; a build
 * whose stylesheets have no rule for them reports null.
 */
const KG_RINGS = [
  ['use', 'USE'],
  ['jump', 'JUMP'],
  ['wave', 'WAVE'],
  ['feed', 'FEED'],
  ['eat', 'EAT'],
];
const KEY_SAMPLES = (rings) => {
  const has = (re) => {
    for (const sh of document.styleSheets) {
      let rules;
      try {
        rules = sh.cssRules;
      } catch (e) {
        continue;
      }
      for (const r of rules || []) if (r.selectorText && re.test(r.selectorText)) return true;
    }
    return false;
  };
  const out = { kc: has(/(^|[\s,])kbd\.kc\b/), kg: has(/(^|[\s,])\.kg\b/), keycapBg: null };
  document.getElementById('ux-key-samples')?.remove();
  if (!out.kc && !out.kg) return out;
  const box = document.createElement('div');
  box.id = 'ux-key-samples';
  box.style.cssText = 'position:fixed;left:16px;top:120px;z-index:99999;display:flex;flex-direction:column;gap:8px;align-items:flex-start;pointer-events:none';
  if (out.kg) {
    for (const [ring, label] of rings) {
      const s = document.createElement('span');
      s.className = 'kg';
      s.dataset.ring = ring;
      s.dataset.uxKg = ring;
      s.style.setProperty('--kg-ring', `var(--ds-ring-${ring})`);
      s.textContent = label;
      box.appendChild(s);
    }
  }
  if (out.kc) {
    const k = document.createElement('kbd');
    k.className = 'kc';
    k.dataset.uxKc = '1';
    k.textContent = 'E';
    box.appendChild(k);
  }
  (document.getElementById('ui-overlay') || document.body).appendChild(box);
  if (out.kc) out.keycapBg = getComputedStyle(box.querySelector('[data-ux-kc]')).backgroundColor;
  return out;
};

async function keyRows(page) {
  const s = await page.evaluate(KEY_SAMPLES, KG_RINGS);
  await page.waitForTimeout(100);
  const r = { markup: { kc: s.kc, kg: s.kg }, keycapBg: s.keycapBg, keycapBgAlpha: null, pills: [] };
  if (s.keycapBg) {
    const c = lib.parseRgb(s.keycapBg);
    r.keycapBgAlpha = c ? lib.round(c.a, 3) : null;
  }
  if (s.kg) for (const [ring, label] of KG_RINGS) r.pills.push({ ring, ...(await contrastAt(page, { sel: `[data-ux-kg="${ring}"]` }, `${label} glyph pill (${ring} ring)`)) });
  await page.evaluate(() => document.getElementById('ux-key-samples')?.remove());
  return r;
}

const CAPTION_SEL = (cap) => ({ sel: '#ui-overlay > div > div', text: `^${cap}$` });

async function captionsOver(t, page, prof, hour) {
  const out = {};
  const measure = async (label) => {
    out[label] = [];
    for (const cap of ['USE', 'JUMP', 'WAVE']) out[label].push(await contrastAt(page, CAPTION_SEL(cap), `${cap} over ${label}`));
  };
  await page.evaluate(() => window.__app.ui.panels.closeAll());
  await page.waitForTimeout(400);
  await measure('grass');
  // Sand: the nearest shore, camera looking inland along the beach.
  const beach = await page.evaluate(async () => {
    const h = window.__h;
    const isl = h.sc.getIsland ? h.sc.getIsland() : h.sc.island;
    const P = h.player();
    const V3 = P.position.constructor;
    const sea = isl.seaLevel();
    const here = P.position.clone().normalize();
    let best = null;
    const N = 4000;
    for (let i = 0; i < N; i++) {
      const y = 1 - (2 * (i + 0.5)) / N;
      const rr = Math.sqrt(1 - y * y);
      const th = i * Math.PI * (3 - Math.sqrt(5));
      const d = new V3(Math.cos(th) * rr, y, Math.sin(th) * rr);
      const ang = Math.acos(Math.min(1, d.dot(here)));
      if (best && ang >= best.ang) continue;
      if (isl.isOverWater(d)) continue;
      const r = isl.sampleSurfaceByDirection(d, 0).position.length();
      if (r > sea + 0.15 && r < sea + 0.6) best = { ang, d, r };
    }
    if (!best) return false;
    P.setWorldPosition(best.d.clone().multiplyScalar(best.r + 0.7));
    await h.wait(900);
    if (typeof h.oc().snapToPlayer === 'function') h.oc().snapToPlayer();
    await h.wait(300);
    return true;
  });
  if (beach) {
    await measure('sand');
    await t.shot(page, `contrast-${prof}-h${hour}-sand.png`);
  }
  // Sky: the camera at its highest look-up pitch, with the avatar hidden for
  // the reading so its body is not what sits behind the captions.
  await page.evaluate(async () => {
    const o = window.__h.oc();
    if (typeof o.maxPitch === 'number') o.pitch = o.maxPitch;
    if (typeof o.snapToPlayer === 'function') o.snapToPlayer();
    window.__h.player().visible = false;
    await window.__h.wait(300);
  });
  await measure('sky');
  await t.shot(page, `contrast-${prof}-h${hour}-sky.png`);
  await page.evaluate(() => (window.__h.player().visible = true));
  return out;
}

async function contrast(t) {
  const hours = t.args.hours ? String(t.args.hours).split(',').map(Number) : [6, 12, 18, 21];
  for (const prof of t.profiles(['desktop', 'phone'])) {
    for (const hour of hours) {
      const r = await measureSession(t, prof, hour, hour === hours[0]);
      t.data[`${prof}-h${hour}`] = r;
      for (const row of r.rows) {
        if (row.missing) {
          t.check(`${prof} ?hour=${hour}: ${row.note}`, null, 'not found', '>= 4.5');
          continue;
        }
        t.check(`${prof} ?hour=${hour}: ${row.note} label (median, worst)`, row.ratioMedian >= 4.5, [row.ratioMedian, row.ratioWorst], '>= 4.5 (target 5)');
      }
      if (r.ring) {
        if (r.ring.missing) t.check(`${prof} ?hour=${hour}: focus ring outer edge`, null, 'element not found', '>= 3');
        else t.check(`${prof} ?hour=${hour}: focus ring outer edge vs surround`, r.ring.ringVisible && r.ring.ratio >= 3, r.ring.ringVisible ? r.ring.ratio : 'no visible ring', '>= 3');
      }
      if (r.keys) {
        // D7's acceptance: glyph pill text 7:1 or better (target 9:1) on every
        // ring tint, and a keycap background that is not transparent.
        const k = r.keys;
        if (!k.markup.kg) t.check(`${prof}: glyph pill text against its fill (D7)`, null, 'no .kg rule on this build', '>= 7 (target 9)');
        for (const row of k.pills) {
          if (row.missing) t.check(`${prof}: ${row.note}`, null, 'not rendered', '>= 7 (target 9)');
          else t.check(`${prof}: ${row.note} text (median, worst) (D7)`, row.ratioMedian >= 7, [row.ratioMedian, row.ratioWorst], '>= 7 (target 9)');
        }
        t.check(`${prof}: keycap background is not transparent (D7)`, k.markup.kc ? k.keycapBgAlpha !== null && k.keycapBgAlpha > 0 : null, k.markup.kc ? { background: k.keycapBg, alpha: k.keycapBgAlpha } : 'no kbd.kc rule on this build', 'alpha > 0');
      }
      if (r.captions) {
        for (const [bg, list] of Object.entries(r.captions)) {
          for (const row of list) {
            if (row.missing) t.check(`${prof} ?hour=${hour}: ${row.note}`, null, 'not found', '>= 7');
            else t.check(`${prof} ?hour=${hour}: ${row.note} (median, worst)`, row.ratioMedian >= 7, [row.ratioMedian, row.ratioWorst], '>= 7');
          }
        }
      }
    }
  }
}

// -------------------------------------------------------------------- axe
const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'];

async function axeOn(page, scopeSel) {
  return page.evaluate(
    async ({ sel, tags }) => {
      const ctx = sel ? document.querySelector(sel) : document;
      if (!ctx) return { missing: true };
      const r = await window.axe.run(ctx, { resultTypes: ['violations', 'incomplete'], runOnly: { type: 'tag', values: tags } });
      return {
        version: window.axe.version,
        violations: r.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length, targets: v.nodes.slice(0, 5).map((n) => n.target.join(' ').slice(0, 90)) })),
        // axe cannot resolve contrast over gradients or the live canvas; those
        // land here, which is why the contrast probe samples real pixels.
        incomplete: r.incomplete.map((v) => ({ id: v.id, nodes: v.nodes.length })),
      };
    },
    { sel: scopeSel, tags: AXE_TAGS },
  );
}

const MARK = (pick) => {
  document.querySelectorAll('[data-ux-scope]').forEach((e) => e.removeAttribute('data-ux-scope'));
  const ui = window.__app.ui;
  let el = null;
  if (pick === 'npcChat') el = ui.npcChatDiv;
  else if (pick === 'zone') el = window.__h.zonePanel();
  else if (pick === 'modal') el = [...document.querySelectorAll('#ui-overlay > [role=dialog]')].filter((e) => window.__h.visible(e)).pop() || window.__h.zonePanel();
  else if (pick === 'top') {
    // The top panel's own element (PanelManager's stack), else the last dialog.
    const st = (ui.panels && ui.panels.stack) || [];
    const top = st[st.length - 1];
    el = top && top.spec ? top.spec.el : null;
    if (!el) el = [...document.querySelectorAll('#ui-overlay > [role=dialog]')].pop() || null;
  } else if (pick === 'overlay') el = document.getElementById('ui-overlay');
  else if (pick === 'drawer') el = ui.drawerListEl || null;
  else if (pick === 'name-prompt') {
    const inp = [...document.querySelectorAll('input')].find((i) => i.placeholder === 'Your name' && i.getBoundingClientRect().width > 2);
    el = inp ? inp.closest('[role=dialog]') || inp.parentElement.parentElement : null;
  } else el = document.querySelector(pick);
  if (el) el.setAttribute('data-ux-scope', '1');
  return !!el;
};

// The surfaces, in the order a session opens them: the welcome card, then the
// 20 the wave-1 verify scanned on each device (40 in all, 0 serious or
// critical there): the HUD, the Portfolio menu (the drawer on the phone), the
// hire card, the four zone panels, the eight centred modals (passport, island
// times, pack, journal, leaderboard, guestbook, roster, island map), the
// receipt, say-hi and completion modals, the NPC chat and the name prompt.
// Each is opened through the UI's own entry point, with the backend blocked.
const ZONES = ['professional', 'projects', 'personal', 'contact'];
const MODALS = [
  ['passport', () => window.__app.ui.showPassport()],
  ['island-times', () => void window.__app.ui.showIslandTimes()],
  ['pack', () => window.__app.ui.showInventory()],
  ['journal', () => window.__app.ui.showJournal()],
  ['leaderboard', () => void window.__app.ui.showLeaderboard()],
  ['guestbook', () => void window.__app.ui.showGuestbook()],
  ['roster', () => window.__app.ui.showRoster()],
  ['island-map', () => window.__app.openIslandMap()],
  ['receipt', () => window.__app.ui.showReceipt([{ label: 'Probe coin', amount: 1, t: Date.now() }])],
  ['say-hi', () => window.__app.ui.showSayHi()],
  ['completion', () => window.__app.ui.showCompletionModal()],
];
const AXE_SURFACES = ['hud', 'menu', 'hire', ...ZONES.map((z) => `zone-${z}`), ...MODALS.map((m) => m[0]), 'npc-chat', 'name-prompt'];

async function axe(t) {
  const src = lib.axeSource();
  for (const prof of t.profiles(['desktop', 'phone'])) {
    const touch = prof !== 'desktop';
    const s = await t.session(prof);
    const b = await t.boot(s);
    const { page } = s;
    await page.addScriptTag({ content: src });
    const res = {};
    const closeAll = () => page.evaluate(() => window.__app.ui.panels.closeAll()).catch(() => {});
    /** Open a surface, scan its element, close everything again (keep: leave it up). */
    const run = async (name, open, pick, wait = 800, keep = false) => {
      try {
        if (open) await open();
        await page.waitForTimeout(wait);
        const ok = await page.evaluate(MARK, pick);
        res[name] = ok ? await axeOn(page, '[data-ux-scope]') : { missing: true };
      } catch (e) {
        res[name] = { error: String(e && e.message ? e.message : e).slice(0, 200) };
      }
      if (keep) return;
      await closeAll();
      await page.waitForTimeout(250);
    };
    // The welcome card stays up: its Explore button is pressed next.
    await run('welcome', null, W, 0, true);
    await (touch ? page.tap(`${W} button[data-dismiss]`).catch(() => page.click(`${W} button[data-dismiss]`)) : page.click(`${W} button[data-dismiss]`));
    await page.waitForTimeout(1500);
    await run('hud', null, 'overlay', 300);
    if (!touch) {
      await run('menu', async () => {
        const pill = await page.$('.hud-btn[aria-label="Open portfolio menu"]');
        if (pill) await pill.click();
      }, 'top');
    } else {
      await run('menu', async () => {
        const tg = await page.$('[aria-label="Open island menu"]');
        if (tg) await tg.tap().catch(() => tg.click());
      }, 'drawer');
      const tg = await page.$('[aria-label="Close island menu"], [aria-label="Open island menu"]');
      if (tg && (await page.evaluate(() => !!(window.__app.ui.drawerListEl && window.__app.ui.drawerListEl.getBoundingClientRect().height > 2)))) await tg.tap().catch(() => {});
      await page.waitForTimeout(400);
    }
    await run('hire', () => page.evaluate(() => window.__app.ui.showHireCard('menu')), 'top');
    for (const z of ZONES) await run(`zone-${z}`, () => page.evaluate((id) => window.__app.ui.showZonePanel({ id, name: id }), z), 'top');
    for (const [name, open] of MODALS) await run(name, () => page.evaluate(open), 'top', 1200);
    await run('npc-chat', () => page.evaluate(() => window.__app.ui.showNpcChat('Probe', 'Hello.', async () => 'Thanks.')), 'npcChat', 600);
    await page.evaluate(() => window.__app.ui.closeNpcChat && window.__app.ui.closeNpcChat()).catch(() => {});
    await run('name-prompt', () => page.evaluate(() => window.__app.ui.promptName('', () => {})), 'name-prompt', 600);
    await page.keyboard.press('Escape').catch(() => {});
    t.data[prof] = { boot: b, surfaces: res, pageErrors: s.sink && s.sink.pageerrors ? s.sink.pageerrors.slice(0, 5) : [] };
    for (const name of ['welcome', 'hire', 'npc-chat']) {
      const r = res[name];
      const cc = r && r.violations ? r.violations.find((v) => v.id === 'color-contrast') : null;
      t.check(`${prof}: axe color-contrast on ${name}`, r && r.violations ? !cc : null, r && r.missing ? 'surface not found' : r && r.error ? r.error : cc ? `${cc.nodes} nodes` : 0, 0);
    }
    // The verify's line: no serious or critical violation on any of the 20.
    const bad = {};
    const unseen = [];
    const minor = {};
    for (const name of AXE_SURFACES) {
      const r = res[name];
      if (!r || !r.violations) {
        unseen.push(`${name}: ${r && r.error ? r.error.slice(0, 80) : 'not found'}`);
        continue;
      }
      const sc = r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
      if (sc.length) bad[name] = sc.map((v) => `${v.id} (${v.impact}) x${v.nodes}: ${v.targets[0] || ''}`);
      const rest = r.violations.filter((v) => v.impact !== 'serious' && v.impact !== 'critical');
      if (rest.length) minor[name] = rest.map((v) => v.id);
    }
    t.data[prof].summary = { scanned: AXE_SURFACES.length - unseen.length, seriousOrCritical: bad, minorOrModerate: minor, unseen };
    t.check(`${prof}: every one of the ${AXE_SURFACES.length} surfaces was opened and scanned`, unseen.length === 0, unseen.length ? unseen : AXE_SURFACES.length, AXE_SURFACES.length);
    t.check(`${prof}: axe serious or critical violations on the ${AXE_SURFACES.length} surfaces`, Object.keys(bad).length === 0, Object.keys(bad).length ? bad : 0, 0);
  }
}

module.exports = {
  contrast: { item: 'D3', title: 'label-on-fill contrast at ?hour=6/12/18/21 on 1440 and 390, captions, focus ring, D7 glyph pills and keycap', profiles: ['desktop', 'phone'], run: contrast },
  axe: { item: 'D3, D4, D8', title: 'axe-core 4.10.3 on the welcome card and 20 surfaces per device (40): HUD, menu or drawer, hire card, 4 zone panels, 11 modals, NPC chat, name prompt', profiles: ['desktop', 'phone'], run: axe },
  AXE_SURFACES,
};
