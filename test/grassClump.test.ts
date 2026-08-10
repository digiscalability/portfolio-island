// @vitest-environment happy-dom
//
// Grass clump prototype invariants (?grass=clump A/B).
//
// The contract that matters: the builder runs BEFORE the Phase-A grass
// scatter, whose Math.random order is the vehicle-placement wire protocol —
// so it must be fully deterministic and must never touch Math.random.
import { describe, expect, test, vi } from 'vitest';

import { buildGrassClumpGeometry } from '../Island';

describe('grass clump geometry', () => {
  test('never consumes Math.random (the wire-protocol guard)', () => {
    const spy = vi.spyOn(Math, 'random');
    buildGrassClumpGeometry();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  test('deterministic: two builds are byte-identical', () => {
    const a = buildGrassClumpGeometry().geometry.getAttribute('position');
    const b = buildGrassClumpGeometry().geometry.getAttribute('position');
    expect(a.count).toBe(b.count);
    for (let i = 0; i < a.count; i++) {
      expect(a.getX(i)).toBe(b.getX(i));
      expect(a.getY(i)).toBe(b.getY(i));
      expect(a.getZ(i)).toBe(b.getZ(i));
    }
  });

  test('ledger: 7 blades = 42 verts, all finite, inside the clump envelope', () => {
    const { geometry, height } = buildGrassClumpGeometry();
    const pos = geometry.getAttribute('position');
    expect(pos.count).toBe(42); // 7 single-plane blades × 2 tris × 3 verts
    expect(geometry.getAttribute('color')).toBeTruthy();
    expect(height).toBeGreaterThan(0.088); // taller than one blade of the pair
    for (let i = 0; i < pos.count; i++) {
      expect(Number.isFinite(pos.getX(i) + pos.getY(i) + pos.getZ(i))).toBe(true);
      expect(pos.getY(i)).toBeGreaterThanOrEqual(0); // rooted, nothing underground
      expect(pos.getY(i)).toBeLessThanOrEqual(height + 1e-6);
      // Footprint stays a tuft, not a bush: lateral reach under ~0.25u.
      expect(Math.hypot(pos.getX(i), pos.getZ(i))).toBeLessThan(0.25);
    }
  });

  test('luminance-only vertex colors (instanceColor multiplies — hue there)', () => {
    const { geometry } = buildGrassClumpGeometry();
    const col = geometry.getAttribute('color');
    for (let i = 0; i < col.count; i++) {
      // Grey ramp: r ≈ g ≈ b (the near-black-grass trap was hue × hue).
      expect(Math.abs(col.getX(i) - col.getZ(i))).toBeLessThan(0.02);
      // ColorManagement stores channels LINEAR: sRGB 0xa8 lands ≈0.39.
      expect(col.getX(i)).toBeGreaterThan(0.3);
    }
  });
});
