// Aspect-aware framing. three.js fov is the VERTICAL angle, so a fixed fov is
// pure Hor+ with no floor — measured 24.3 deg horizontal on a portrait phone,
// which turned the world into a corridor on half the audience's devices.
import { describe, expect, test } from 'vitest';

import { BASE_VFOV, framingFov, horizontalFov } from '../Framing';

const ASPECTS = {
  portraitPhone: 393 / 852,
  squareish: 1,
  laptop16x10: 16 / 10,
  hd: 16 / 9,
  ultrawide21x9: 21 / 9,
  superwide32x9: 32 / 9,
  shortLandscape: 900 / 420,
};

describe('framingFov', () => {
  test('DESKTOP IS UNTOUCHED: 16:10 and wider return BASE_VFOV exactly', () => {
    for (const a of [
      ASPECTS.laptop16x10,
      ASPECTS.hd,
      ASPECTS.ultrawide21x9,
      ASPECTS.superwide32x9,
      ASPECTS.shortLandscape,
    ]) {
      expect(framingFov(a)).toBe(BASE_VFOV);
    }
  });

  test('portrait opens up, and gains real horizontal field', () => {
    const a = ASPECTS.portraitPhone;
    const before = horizontalFov(BASE_VFOV, a);
    const after = horizontalFov(framingFov(a), a);
    expect(before).toBeLessThan(30); // the corridor
    expect(after).toBeGreaterThan(before + 8); // materially wider
    expect(framingFov(a)).toBeGreaterThan(BASE_VFOV);
  });

  test('never exceeds the fish-eye ceiling, however tall the window', () => {
    for (const a of [0.2, 0.35, 0.5, 0.75]) {
      expect(framingFov(a)).toBeLessThanOrEqual(68);
    }
  });

  test('monotonic: narrower windows never get a SMALLER vertical fov', () => {
    let prev = 0;
    for (const a of [2.5, 2.0, 1.6, 1.2, 1.0, 0.75, 0.5]) {
      const f = framingFov(a);
      expect(f).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = f;
    }
  });

  test('garbage aspects fall back to the authored fov', () => {
    expect(framingFov(0)).toBe(BASE_VFOV);
    expect(framingFov(-1)).toBe(BASE_VFOV);
    expect(framingFov(NaN)).toBe(BASE_VFOV);
  });
});
