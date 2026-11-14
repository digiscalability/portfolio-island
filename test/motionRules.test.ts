// @vitest-environment happy-dom
//
// Motion rules (D11). ui/motion.ts is the one source of durations and easings
// and style.css mirrors it; nothing loops forever except what the allow-list
// names; and animated properties stay on the compositor (opacity and
// transforms) or are paint-only colour changes, with the few layout-animating
// transitions listed by selector and reason.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { a11y } from '../Accessibility';
import { animateIn, animateOut, durVar, easeVar, MOTION, staggerIn } from '../ui/motion';

const src = (f: string): string =>
  readFileSync(join(process.cwd(), f), 'utf8').replace(/\r\n/g, '\n');

// D's surfaces are scanned and judged. Guide.ts and GuideCard.ts are A's;
// lock-census forbids a D test reading them, so they are left to A's tests.
const JUDGED = [
  'style.css',
  'index.html',
  'SimpleUI.ts',
  ...readdirSync(join(process.cwd(), 'ui'))
    .filter((f) => f.endsWith('.ts'))
    .map((f) => `ui/${f}`),
];

// 'infinite' is allowed only for these, by keyframe name or selector:
// - bounce: the loading dots (style.css);
// - spin: index.html's static boot spinner;
// - ds-drawer-pulse: the ☰ dot the drawer-slot ruling relies on (off under
//   reduced motion);
// - ld-pulse and ld-spin: the loader's moon and orbit;
// - the reduced-motion liveness carve-out for .loading-spinner and #ld-orbit.
const INFINITE_OK = [
  /animation:\s*bounce\b/,
  /animation:\s*spin\b/,
  /ds-drawer-pulse/,
  /\bld-pulse\b/,
  /\bld-spin\b/,
  /animation-iteration-count:\s*infinite\s*!important/, // the carve-out (checked below)
];

// On the compositor: opacity and transforms. Paint-only, no layout: colours,
// shadows and the discrete visibility flip.
const COMPOSITOR = new Set(['opacity', 'transform', 'translate', 'scale', 'rotate', 'filter']);
const PAINT_ONLY = new Set([
  'color',
  'background',
  'background-color',
  'border-color',
  'box-shadow',
  'visibility',
]);
// Layout-animating transitions that stay, by context and reason: progress
// bars fill by width (the loader bar, the stamina and XP meters).
const LAYOUT_OK: Array<{ prop: string; near: RegExp; why: string }> = [
  { prop: 'width', near: /\.loading-progress-bar/, why: 'the loading bar fills' },
  { prop: 'width', near: /ld-bar|ld-fill|progress/i, why: 'the loader bar fills' },
  { prop: 'width', near: /stamina|breath|xp|meter|bar/i, why: 'a meter fills' },
];

/** Every transition's property list in a file, with the text before it. */
const transitions = (text: string): Array<{ prop: string; before: string; at: number }> => {
  const out: Array<{ prop: string; before: string; at: number }> = [];
  const re = /transition(-property)?\s*([:=])\s*(['"`]?)([^;'"`}]+)/g;
  for (const m of text.matchAll(re)) {
    // In code, `el.style.transition = fade` names a variable: its string is
    // scanned where it is written.
    if (m[2] === '=' && !m[3]) continue;
    const list = m[4].replace(/!important/g, '').trim();
    if (!list || /^none$/i.test(list) || list.startsWith('$')) continue;
    for (const part of list.split(/,(?![^(]*\))/)) {
      const prop = part.trim().split(/\s+/)[0];
      if (!prop || /^\d/.test(prop) || prop.startsWith('var(')) continue;
      out.push({ prop, before: text.slice(Math.max(0, m.index! - 600), m.index!), at: m.index! });
    }
  }
  return out;
};

const lineOf = (text: string, at: number): number => text.slice(0, at).split('\n').length;

describe('ui/motion.ts and style.css agree', () => {
  const css = src('style.css');
  test('every duration and easing has its --ds-dur-* / --ds-ease-* property, same value', () => {
    for (const [k, ms] of Object.entries(MOTION.dur)) {
      expect(css).toContain(`${durVar(k as keyof typeof MOTION.dur)}: ${ms}ms;`);
    }
    for (const [k, e] of Object.entries(MOTION.ease)) {
      expect(css).toContain(`${easeVar(k as keyof typeof MOTION.ease)}: ${e};`);
    }
  });

  test('the durations are 90, 140, 200, 240 and 450 ms', () => {
    expect(Object.values(MOTION.dur)).toEqual([90, 140, 200, 240, 450]);
  });
});

describe('nothing loops forever outside the allow-list', () => {
  test.each(JUDGED)('%s', (f) => {
    const text = src(f);
    const bad: string[] = [];
    for (const m of text.matchAll(/\binfinite\b/g)) {
      const start = text.lastIndexOf('\n', m.index!) + 1;
      const end = text.indexOf('\n', m.index!);
      const line = text.slice(start, end === -1 ? undefined : end);
      if (line.trim().startsWith('//') || line.trim().startsWith('*')) continue;
      if (!INFINITE_OK.some((re) => re.test(line)))
        bad.push(`${f}:${lineOf(text, m.index!)} ${line.trim()}`);
      // The carve-out may loop only for the spinner and the orbit.
      if (/iteration-count:\s*infinite\s*!important/.test(line)) {
        const ctx = text.slice(Math.max(0, m.index! - 200), m.index!);
        if (!/#ld-orbit/.test(ctx))
          bad.push(`${f}:${lineOf(text, m.index!)} carve-out outside #ld-orbit`);
      }
    }
    expect(bad).toEqual([]);
  });

  test('a brightness(…) infinite pulse would fail it', () => {
    const line = "el.style.animation = 'glow 1s infinite';";
    expect(INFINITE_OK.some((re) => re.test(line))).toBe(false);
  });
});

describe('animated properties stay on the compositor', () => {
  test.each(JUDGED)('%s', (f) => {
    const text = src(f);
    const bad = transitions(text)
      .filter(({ prop }) => !COMPOSITOR.has(prop) && !PAINT_ONLY.has(prop) && prop !== 'all')
      .filter(
        ({ prop, before }) => !LAYOUT_OK.some((ok) => ok.prop === prop && ok.near.test(before)),
      )
      .map(({ prop, at }) => `${f}:${lineOf(text, at)} ${prop}`);
    expect(bad).toEqual([]);
  });

  test('a left/top transition would fail it', () => {
    const t = transitions("thumb.style.transition = 'left 120ms ease, top 120ms ease';");
    expect(t.map((x) => x.prop)).toEqual(['left', 'top']);
    expect(t.some((x) => COMPOSITOR.has(x.prop) || PAINT_ONLY.has(x.prop))).toBe(false);
  });
});

describe('the reduced-motion rule ramps opacity and colour, never motion', () => {
  const css = src('style.css');
  test('both blocks: 120 ms on opacity and colours only, no transition:none', () => {
    const media = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce) {'));
    const cls = css.slice(css.indexOf('html.reduced-motion * {'));
    for (const block of [media.slice(0, 400), cls.slice(0, 300)]) {
      expect(block).toContain(
        'transition-property: opacity, color, background-color, border-color !important;',
      );
      expect(block).toContain('transition-duration: 120ms !important;');
      expect(block).not.toContain('transition: none');
    }
  });
});

describe('animateIn, animateOut and the HUD stagger', () => {
  afterEach(() => a11y.setReducedMotion(false));
  const fake = () => {
    const calls: Array<{ k: Keyframe[]; o: KeyframeAnimationOptions }> = [];
    const el = document.createElement('div');
    document.body.appendChild(el);
    (el as unknown as { animate: unknown }).animate = vi.fn(
      (k: Keyframe[], o: KeyframeAnimationOptions) => {
        calls.push({ k, o });
        return { cancel: vi.fn(), onfinish: null } as unknown as Animation;
      },
    );
    return { el, calls };
  };

  test('a panel arrives: opacity from 0 over 180 ms, a lift over 240 ms', () => {
    const { el, calls } = fake();
    animateIn(el);
    expect(calls[0].k[0].opacity).toBe(0);
    expect(calls[0].o.duration).toBe(180);
    expect(calls[1].o.duration).toBe(240);
    expect(Object.keys(calls[1].k[0]).sort()).toEqual(['scale', 'translate']);
  });

  test('under reduced motion: one opacity ramp of 120 ms, no transform', () => {
    a11y.setReducedMotion(true);
    const { el, calls } = fake();
    animateIn(el);
    expect(calls).toHaveLength(1);
    expect(calls[0].o.duration).toBe(120);
    expect(Object.keys(calls[0].k[0])).toEqual(['opacity']);
  });

  test('a panel leaves over 140 ms; cancelling ends it at once and runs done', () => {
    const { el, calls } = fake();
    const done = vi.fn();
    const stop = animateOut(el, done);
    expect(calls[0].o.duration).toBe(140);
    expect(done).not.toHaveBeenCalled();
    stop();
    expect(done).toHaveBeenCalledTimes(1);
    stop();
    expect(done).toHaveBeenCalledTimes(1);
  });

  test('without animation support the exit is immediate', () => {
    const el = document.createElement('div');
    (el as unknown as { animate: unknown }).animate = undefined;
    const done = vi.fn();
    animateOut(el, done);
    expect(done).toHaveBeenCalledTimes(1);
  });

  test('the HUD staggers in: 220 ms each, 40 ms apart', () => {
    const a = fake();
    const b = fake();
    const c = fake();
    staggerIn([a.el, b.el, c.el]);
    const all = [a, b, c].map((x) => x.calls[0].o);
    expect(all.map((o) => o.duration)).toEqual([220, 220, 220]);
    expect(all.map((o) => o.delay).sort()).toEqual([0, 40, 80]);
    expect(all.every((o) => o.fill === 'backwards')).toBe(true);
  });
});

describe('the HUD waits out the intro (PanelManager.holdHud / releaseHud)', () => {
  test('hold hides every layer element, late ones too; release unhides them', async () => {
    document.body.innerHTML = '<div id="ui-overlay"></div>';
    const { PanelManager } = await import('../PanelManager');
    const overlay = document.getElementById('ui-overlay')!;
    const pm = new PanelManager(overlay, false);
    const a = document.createElement('div');
    overlay.appendChild(a);
    pm.registerLayer('nav-chips', a);
    pm.holdHud();
    expect(a.classList.contains('ds-intro-hold')).toBe(true);
    const late = document.createElement('div');
    overlay.appendChild(late);
    pm.registerLayer('ambient-info', late);
    expect(late.classList.contains('ds-intro-hold')).toBe(true);
    pm.releaseHud();
    expect(a.classList.contains('ds-intro-hold')).toBe(false);
    expect(late.classList.contains('ds-intro-hold')).toBe(false);
    expect(src('style.css')).toMatch(/\.ds-intro-hold \{\s*opacity: 0 !important;/);
    pm.dispose();
  });

  test("SimpleUI holds on 'ds:intro' start, releases on settled or after 6 s", () => {
    const s = src('SimpleUI.ts');
    const i = s.indexOf('private readonly onIntroEvent');
    const body = s.slice(i, i + 1200);
    expect(body).toContain('this.panels.holdHud()');
    expect(body).toContain('window.setTimeout(() => this.panels.releaseHud(), 6000)');
    expect(body).toContain('this.panels.releaseHud();');
  });
});
