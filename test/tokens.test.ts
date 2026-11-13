// @vitest-environment happy-dom
//
// Design tokens (stage-1 item D3): ui/tokens.ts and style.css's --ds-* custom
// properties agree, every pairing the tokens promise passes WCAG AA by
// arithmetic, and the surfaces that failed AA (DA-01, UX-06, DA-14) now wear
// them. The pixel-level checks over the live 3D scene are the contrast
// probe's job; these hold the inputs still.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { appendReceptionDesk } from '../ReceptionDesk';
import { SimpleUI } from '../SimpleUI';
import { cssVarName, DS, type DsToken } from '../ui/tokens';

const src = (f: string): string =>
  readFileSync(join(process.cwd(), f), 'utf8').replace(/\r\n/g, '\n');

// ── colour arithmetic (WCAG 2.x relative luminance) ──────────────────────
type RGB = [number, number, number];
const hex = (h: string): RGB => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as RGB;
const rgba = (s: string): { rgb: RGB; a: number } => {
  const p = /rgba?\(([^)]+)\)/.exec(s)![1].split(',').map(Number);
  return { rgb: [p[0], p[1], p[2]], a: p.length > 3 ? p[3] : 1 };
};
const lin = (c: number): number => {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const lum = ([r, g, b]: RGB): number => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
const ratio = (a: RGB, b: RGB): number => {
  const [x, y] = [lum(a), lum(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};
const over = (fg: RGB, a: number, bg: RGB): RGB => fg.map((v, i) => v * a + bg[i] * (1 - a)) as RGB;
const stops = (gradient: string): string[] => gradient.match(/#[0-9a-f]{6}/gi) ?? [];
const hue = ([r, g, b]: RGB): number => {
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  if (d === 0) return 0;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
};
const WHITE: RGB = [255, 255, 255];

describe('ui/tokens.ts and style.css agree', () => {
  const css = src('style.css');
  const declared = new Map(
    [...css.matchAll(/(--ds-[a-z0-9-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]),
  );

  test('every token has its --ds-* custom property, with the same value', () => {
    for (const token of Object.keys(DS) as DsToken[]) {
      expect(declared.get(cssVarName(token)), token).toBe(DS[token]);
    }
  });

  test('and style.css declares no --ds-* property the tokens do not have', () => {
    const names = new Set((Object.keys(DS) as DsToken[]).map(cssVarName));
    expect([...declared.keys()].filter((n) => !names.has(n))).toEqual([]);
  });

  test('they live on :root, beside (not inside) the legacy --primary block', () => {
    const block = css.slice(css.indexOf('--ds-ink-950') - 400, css.indexOf('--ds-ink-950'));
    expect(block).toContain(':root {');
    expect(css).toContain('--primary: #5b6cff;'); // retired by D17, not here
  });
});

describe('the pairings the tokens promise pass AA', () => {
  test('white text on both stops of the primary: at least 5.4:1', () => {
    const s = stops(DS.primary);
    expect(s).toEqual(['#4c5be0', '#7a45d6']);
    for (const c of s) expect(ratio(WHITE, hex(c)), c).toBeGreaterThanOrEqual(5.4);
  });

  test('white text on both stops of the Work-with-me green: 5.39 and 6.15 to 1', () => {
    const s = stops(DS.ctaWork);
    expect(s).toEqual(['#087a4c', '#067046']);
    for (const c of s) expect(ratio(WHITE, hex(c)), c).toBeGreaterThanOrEqual(5.38); // 5.387, 6.15
  });

  test('a hovered (8% darker) or pressed (15% darker) fill only gains contrast', () => {
    expect(DS.hoverFilter).toBe('brightness(0.92)');
    expect(DS.pressFilter).toBe('brightness(0.85)');
    for (const c of [...stops(DS.primary), ...stops(DS.ctaWork)]) {
      const pressed = hex(c).map((v) => v * 0.85) as RGB;
      expect(ratio(WHITE, pressed)).toBeGreaterThan(ratio(WHITE, hex(c)));
    }
  });

  test('the ruled identity: indigo/violet primary, green only for Work with me', () => {
    for (const c of stops(DS.primary)) {
      const h = hue(hex(c));
      expect(h, c).toBeGreaterThanOrEqual(225);
      expect(h, c).toBeLessThanOrEqual(270);
    }
    for (const c of stops(DS.ctaWork)) {
      const h = hue(hex(c));
      expect(h, c).toBeGreaterThanOrEqual(140);
      expect(h, c).toBeLessThanOrEqual(170);
    }
  });

  test('text and accents on ink-900', () => {
    const ink = hex(DS.ink900);
    expect(ratio(hex(DS.text1), ink)).toBeGreaterThanOrEqual(15);
    expect(ratio(hex(DS.text2), ink)).toBeGreaterThanOrEqual(10);
    expect(ratio(hex(DS.text3), ink)).toBeGreaterThanOrEqual(6);
    for (const t of ['signal', 'info', 'danger', 'success'] as const) {
      expect(ratio(hex(DS[t]), ink), t).toBeGreaterThanOrEqual(4.5);
    }
  });

  test('every district colour reaches 6.9:1 on ink-900', () => {
    const ink = hex(DS.ink900);
    const districts = (Object.keys(DS) as DsToken[]).filter((k) => k.startsWith('district'));
    expect(districts).toHaveLength(5);
    for (const d of districts) {
      expect(ratio(hex(DS[d] as string), ink), d).toBeGreaterThanOrEqual(6.9);
    }
  });

  test('the focus ring: its bands are 9:1 apart, and one beats 3:1 on any ground', () => {
    const [dark, light, keyline] = stops(DS.focusRing).map(hex);
    expect(DS.focusRing).toBe('0 0 0 2px #0b1220, 0 0 0 4px #8fc1ff, 0 0 0 5px #0b1220');
    expect(keyline).toEqual(dark);
    expect(ratio(dark, light)).toBeGreaterThanOrEqual(9);
    for (const ground of ['#ffffff', '#cfe8ff', '#7fa35a', '#e8a15a', '#2b2f55', '#000000']) {
      const best = Math.max(ratio(dark, hex(ground)), ratio(light, hex(ground)));
      expect(best, ground).toBeGreaterThanOrEqual(3);
    }
  });

  test('a touch caption on its disc reaches 7:1 over sand, grass and sky', () => {
    const { rgb, a } = rgba(DS.hudSurface);
    for (const world of ['#e8d9b8', '#7fa35a', '#8fc3ef', '#cfe8ff', '#ffffff']) {
      const disc = over(rgb, a, hex(world));
      expect(ratio(WHITE, disc), world).toBeGreaterThanOrEqual(7);
    }
  });
});

describe('the tokens are worn where AA failed', () => {
  let ui: SimpleUI;
  const byText = (text: string): HTMLElement =>
    [...document.querySelectorAll<HTMLElement>('#ui-overlay button, #ui-overlay a')].find(
      (el) => (el.textContent ?? '').replace(/\s+/g, ' ').trim() === text,
    )!;
  const fill = (el: HTMLElement | null | undefined): string => el?.style.background ?? '';

  beforeEach(() => {
    document.body.innerHTML = '<div id="ui-overlay"></div>';
    localStorage.clear();
    ui = new SimpleUI('ui-overlay');
  });
  afterEach(() => {
    ui.hideZonePanel();
    ui.hideWelcome(false);
    ui.closeNpcChat();
    history.replaceState(null, '', '/');
  });

  test('the Portfolio pill is the primary; Work with me is the reserved green', () => {
    const portfolio = document.querySelector<HTMLElement>('[aria-label="Open portfolio menu"]')!;
    const work = document.querySelector<HTMLElement>('[data-cta="work-with-me"]')!;
    expect(fill(portfolio)).toBe(DS.primary);
    expect(fill(work)).toBe(DS.ctaWork);
    // both darken on hover and press instead of the chips' brighten
    expect(portfolio.classList.contains('ds-press')).toBe(true);
    expect(work.classList.contains('ds-press')).toBe(true);
  });

  // Changed deliberately in D9: the one filled primary was Explore. It is the
  // Hiring pill now, and Explore is a neutral outline (green is Work with
  // me's alone, and a card with two fills has no primary).
  test('the welcome card has one filled primary, the Hiring pill; the rest are outlines', () => {
    ui.showWelcome(null);
    const hiring = document.querySelector<HTMLElement>('button[data-recruit]')!;
    const explore = document.querySelector<HTMLElement>('button[data-dismiss]')!;
    const work = document.querySelector<HTMLElement>('button[data-cta="projects"]')!;
    expect(fill(hiring)).toBe(DS.primary);
    expect(hiring.classList.contains('ds-press')).toBe(true);
    expect(hiring.style.minHeight).toBe('46px');
    expect(hiring.style.fontSize).toBe('15px');
    expect(hiring.style.fontWeight).toBe('700');
    expect(hiring.style.width).toBe('100%');
    for (const b of [explore, work]) {
      expect(b.getAttribute('style')).not.toContain('linear-gradient');
      expect(b.style.border).toMatch(/1px solid/);
    }
    const filled = [...document.querySelectorAll<HTMLElement>('[role="dialog"] button')].filter(
      (b) => (b.getAttribute('style') ?? '').includes('linear-gradient'),
    );
    expect(filled).toEqual([hiring]);
    // and no green fill on the card: green belongs to Work with me
    for (const b of document.querySelectorAll<HTMLElement>('[role="dialog"] button')) {
      expect(b.getAttribute('style') ?? '').not.toMatch(/#12b76a|#0e9f6e|#4caf50|#087a4c/i);
    }
  });

  test('the hire card leads with LinkedIn in the primary', () => {
    ui.showHireCard('cta');
    const linkedIn = byText('LinkedIn'); // D13: the sprite's icon, then the label
    expect(linkedIn.getAttribute('style')).toContain(`background:${DS.primary};`);
  });

  test('NPC chat Send, the name prompt and Customise Done use the primary', () => {
    ui.showNpcChat('Gardener', 'Morning!', async () => 'Hello.');
    expect(fill(byText('Send'))).toBe(DS.primary);
    ui.closeNpcChat();
    ui.promptName('', () => {});
    expect(fill(byText('Enter the island →'))).toBe(DS.primary);
    ui.showCustomize({
      colors: {},
      ownedHats: [],
      equippedHat: null,
      hats: [],
      onColor: () => {},
      onHat: () => {},
    });
    expect(byText('Done').getAttribute('style')).toContain(`background:${DS.primary};`);
    ui.hideCustomize();
  });

  test('the voice-call button uses the AA teal', () => {
    const box = document.createElement('div');
    appendReceptionDesk(box);
    const call = box.querySelector<HTMLElement>('#rd-start')!;
    const s = stops(call.getAttribute('style') ?? '');
    expect(s).toEqual(['#00796b', '#00695c']);
    for (const c of s) expect(ratio(WHITE, hex(c)), c).toBeGreaterThanOrEqual(5.3);
  });

  test('touch discs: the HUD surface, a 2px accent ring, 11px tracked captions', () => {
    history.replaceState(null, '', '/?touch=1');
    document.body.innerHTML = '<div id="ui-overlay"></div>';
    ui = new SimpleUI('ui-overlay');
    const discs = [...document.querySelectorAll<HTMLElement>('#ui-overlay > div')].filter(
      (d) =>
        d.children.length === 2 && /^(USE|JUMP|WAVE)$/.test(d.lastElementChild?.textContent ?? ''),
    );
    expect(discs).toHaveLength(3);
    const ring: Record<string, string> = { USE: DS.ringUse, JUMP: DS.ringJump, WAVE: DS.ringWave };
    for (const d of discs) {
      const name = d.lastElementChild!.textContent!;
      expect(d.style.width, name).toBe('74px'); // the hit box is unchanged...
      expect(d.style.border, name).toContain('1px'); // ...and its fill is 72px inside it
      expect(d.style.backgroundColor, name).toBe(DS.hudSurface);
      expect(d.style.backgroundClip, name).toBe('padding-box');
      expect(d.style.boxShadow, name).toContain(`inset 0 0 0 2px ${ring[name]}`);
      const caption = (d.lastElementChild as HTMLElement).style;
      expect(caption.fontSize, name).toBe(DS.typeCaption);
      expect(caption.textTransform, name).toBe('uppercase');
      expect(parseFloat(caption.letterSpacing), name).toBeGreaterThanOrEqual(0.5);
      expect(caption.opacity, name).toBe(''); // full white, no 0.9
    }
  });

  test('💬 and 🎤 are 52px discs; 💬 keeps its 174px clearance over the joystick', () => {
    history.replaceState(null, '', '/?touch=1');
    document.body.innerHTML = '<div id="ui-overlay"></div>';
    ui = new SimpleUI('ui-overlay');
    const chat = document.querySelector<HTMLElement>('[aria-label="Open chat"]')!;
    const mic = document.querySelector<HTMLElement>('[aria-label^="Hold to talk"]')!;
    for (const b of [chat, mic]) {
      expect(b.style.width).toBe('52px');
      expect(b.style.height).toBe('52px');
      expect(b.style.borderRadius).toBe('50%');
      expect(fill(b)).toBe(DS.hudSurface);
    }
    expect(src('SimpleUI.ts')).toContain("bottom: 'calc(var(--sab, 0px) + 174px)'");
  });
});

describe('the focus ring reaches every focusable HUD and panel control', () => {
  test('style.css draws it from the token, over inline shadows', () => {
    const css = src('style.css');
    const at = css.indexOf('box-shadow: var(--ds-focus-ring) !important;');
    expect(at).toBeGreaterThan(-1);
    const rule = css.slice(css.lastIndexOf('}', at), at);
    for (const sel of ['.hud-btn:focus-visible', '#ui-overlay', 'button', 'a[href]', 'input']) {
      expect(rule, sel).toContain(sel);
    }
    expect(rule).toContain("[role='button']");
    expect(rule).toContain(':focus-visible');
  });
});
