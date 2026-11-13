// @vitest-environment happy-dom
//
// SignPainter (C6): one canvas generator for every board. Boards are built
// inside GameScene.initialize's seeded window, so the painter must be a pure
// function of its spec: the same canvas operations every time, and never a
// Math.random draw. The face arrives late (Bebas Neue from the Google CSS
// today, D12's self-hosted file later): the board paints at once and repaints
// the same texture when document.fonts.load resolves, never awaiting it.
import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  createSignTexture,
  paintSign,
  PROJECT_BOARDS,
  SIGN_COLORS,
  SIGN_FONT_FAMILY,
  SIGN_SIZES,
  signFamily,
  signFontPx,
  type SignSpec,
} from '../SignPainter';
import { installHeadlessCanvas } from './helpers/headlessDom';

/** A 2D context that records every call and property write, in order. */
function recordingCtx(): { ctx: CanvasRenderingContext2D; ops: string[] } {
  const ops: string[] = [];
  const target: Record<string, unknown> = {
    measureText: (s: string) => {
      ops.push(`measureText(${s})`);
      return { width: String(s).length * 30 };
    },
  };
  const ctx = new Proxy(target, {
    get: (t, p) =>
      p in t
        ? t[p as string]
        : (...args: unknown[]) => {
            ops.push(`${String(p)}(${args.map((a) => JSON.stringify(a)).join(',')})`);
          },
    set: (t, p, v) => {
      ops.push(`${String(p)}=${JSON.stringify(v)}`);
      t[p as string] = v;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, ops };
}

const GATE: SignSpec = { kind: 'gate', text: 'Professional', band: 0x7fa8c9 };
const PLAQUE: SignSpec = { kind: 'plaque', text: 'RankPilot', sub: 'Pre-launch', band: 0xc9a06a };

// WCAG relative luminance and contrast, for the 7:1 lettering bar.
const lin = (c: number): number => {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const lum = (hex: string): number => {
  const n = parseInt(hex.slice(1), 16);
  return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
};
const contrast = (a: string, b: string): number => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the painter is deterministic', () => {
  test('the same spec paints the same operations, with no Math.random', () => {
    const spy = vi.spyOn(Math, 'random');
    const a = recordingCtx();
    const b = recordingCtx();
    paintSign(a.ctx, GATE, signFamily(false));
    paintSign(b.ctx, GATE, signFamily(false));
    expect(spy).not.toHaveBeenCalled();
    expect(a.ops.length).toBeGreaterThan(10);
    expect(a.ops).toEqual(b.ops);
    const c = recordingCtx();
    const d = recordingCtx();
    paintSign(c.ctx, PLAQUE, signFamily(true), 0, 72);
    paintSign(d.ctx, PLAQUE, signFamily(true), 0, 72);
    expect(c.ops).toEqual(d.ops);
    expect(spy).not.toHaveBeenCalled();
  });

  test('timber, frame, band and lettering in the decided colours, capitals', () => {
    const r = recordingCtx();
    paintSign(r.ctx, GATE, signFamily(true));
    expect(r.ops).toContain(`fillStyle="${SIGN_COLORS.timber}"`);
    expect(r.ops).toContain(`fillStyle="${SIGN_COLORS.plank}"`);
    expect(r.ops).toContain(`strokeStyle="${SIGN_COLORS.frame}"`);
    expect(r.ops).toContain('fillStyle="#7fa8c9"'); // the district band
    expect(r.ops).toContain(`strokeStyle="${SIGN_COLORS.stroke}"`);
    expect(r.ops).toContain('lineWidth=4'); // the 4 px ink stroke
    expect(r.ops).toContain(`fillStyle="${SIGN_COLORS.letter}"`);
    expect(r.ops.some((o) => o.startsWith('fillText("PROFESSIONAL"'))).toBe(true);
    expect(r.ops).toContain(
      `font="${signFontPx('gate')}px 'Bebas Neue', 'Arial Narrow', 'Roboto Condensed', Impact, sans-serif"`,
    );
  });

  test('a plaque paints its status as a second line', () => {
    const r = recordingCtx();
    paintSign(r.ctx, PLAQUE, signFamily(true));
    expect(r.ops.some((o) => o.startsWith('fillText("RANKPILOT"'))).toBe(true);
    expect(r.ops.some((o) => o.startsWith('fillText("PRE-LAUNCH"'))).toBe(true);
  });
});

describe('legibility and memory', () => {
  test('lettering against the timber field is 7:1 or better; the stroke edge more', () => {
    expect(contrast(SIGN_COLORS.letter, SIGN_COLORS.timber)).toBeGreaterThanOrEqual(7);
    expect(contrast(SIGN_COLORS.letter, SIGN_COLORS.stroke)).toBeGreaterThanOrEqual(12);
  });

  test("the main line's cap height is 0.21 u or more on both boards", () => {
    // 1440x900 at a 50 deg vertical field: 10 px at 20 u and 24 px at 8 u
    // both need about 0.21 u. Bebas Neue's cap height is 0.7 em.
    const cap = (kind: 'gate' | 'plaque', boardH: number): number =>
      ((signFontPx(kind) * 0.7) / SIGN_SIZES[kind].h) * boardH;
    expect(cap('gate', 0.45)).toBeGreaterThanOrEqual(0.21);
    expect(cap('plaque', 0.585)).toBeGreaterThanOrEqual(0.21);
  });

  test("canvas sizes keep today's texture memory (gate 512x128, plaque 320x72)", () => {
    expect(SIGN_SIZES.gate).toEqual({ w: 512, h: 128 });
    expect(SIGN_SIZES.plaque).toEqual({ w: 320, h: 72 });
  });
});

describe('the late face (the D12 contract)', () => {
  test("the family is exactly 'Bebas Neue'", () => {
    expect(SIGN_FONT_FAMILY).toBe('Bebas Neue');
    expect(signFamily(true).startsWith("'Bebas Neue', ")).toBe(true);
    expect(signFamily(false)).not.toContain('Bebas');
  });

  test('paints at once, repaints the same texture when the font loads, never draws', async () => {
    installHeadlessCanvas();
    let resolveLoad: (faces: unknown[]) => void = () => {};
    const loads: string[] = [];
    // The Google stylesheet has registered the face but it is not loaded yet.
    const face = { family: '"Bebas Neue"', status: 'unloaded' };
    const fonts = {
      [Symbol.iterator]: () => [face][Symbol.iterator](),
      // FontFaceSet.check answers true for a family it has no face for; the
      // painter must not trust it.
      check: () => true,
      addEventListener: () => {},
      ready: new Promise(() => {}),
      load: (font: string) => {
        loads.push(font);
        return new Promise<unknown[]>((res) => {
          resolveLoad = res;
        });
      },
    };
    Object.defineProperty(document, 'fonts', { value: fonts, configurable: true });
    const spy = vi.spyOn(Math, 'random');
    // Count only the painting: the texture's own uuids are three's (and are
    // built under withLocalRng in Island).
    spy.mockImplementation(() => 0.5);
    const tex = createSignTexture([GATE]);
    const ctorDraws = spy.mock.calls.length;
    expect(tex).not.toBeNull();
    expect(loads).toEqual(["64px 'Bebas Neue'"]);
    const v0 = tex!.version;
    spy.mockClear();
    face.status = 'loaded';
    resolveLoad([face]);
    await new Promise((r) => setTimeout(r, 0));
    expect(tex!.version).toBeGreaterThan(v0); // needsUpdate: the same texture
    expect(spy).not.toHaveBeenCalled(); // the repaint draws nothing
    expect(ctorDraws).toBe(8); // CanvasTexture: Texture + Source uuids, no more
  });
});

describe('the Projects boards (C8, decision 14)', () => {
  test('the five board strings equal the decision-14 table, in site order', () => {
    expect(PROJECT_BOARDS).toEqual([
      { name: 'RankPilot', status: 'Pre-launch' },
      { name: 'ChocoMate', status: 'Paused' },
      { name: 'Life Island', status: 'This island' },
      { name: "Bano's Cookbook", status: "Ammi's recipes" },
      { name: 'Insta Services API', status: 'Modernising' },
    ]);
  });

  test('no board says studio or grandmother', () => {
    const all = PROJECT_BOARDS.map((b) => `${b.name} ${b.status}`.toLowerCase()).join(' ');
    expect(all).not.toContain('studio');
    expect(all).not.toContain('grandmother');
  });

  test('every board fits its row on the fallback face without shrinking past the floor', () => {
    const r = recordingCtx();
    PROJECT_BOARDS.forEach((b, i) =>
      paintSign(
        r.ctx,
        { kind: 'plaque', text: b.name, sub: b.status, band: 0xc9a06a },
        signFamily(true),
        0,
        i * 72,
      ),
    );
    expect(r.ops.filter((o) => o.startsWith('fillText(')).length).toBe(10);
  });
});
