// Cloud formation invariants (approved sky design, Slice A).
//
// The bug this suite exists for: the old cloud band (R+6.5) was never
// relief-scaled, so at R=75 clouds drifted straight THROUGH the mountain.
// Every spec must now satisfy the two-family altitude policy.
import * as THREE from 'three';
import { describe, expect, test } from 'vitest';

import { buildCloudFormations, orbitMaxLat } from '../CloudFormations';
import { reliefScale } from '../WorldScale';

const RADII = [50, 75] as const;

/** Deterministic rng so counts/geometry are reproducible per run. */
function seeded(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
}

const SUMMIT_LAT_MIN = 0.73; // the summit band the equatorial family must never reach
const MAX_DISPLACEMENT = 9.2;

describe.each(RADII)('cloud formations at R=%i', (r) => {
  const specs = buildCloudFormations(r, seeded(42 + r));

  test('two-family altitude policy: no cloud can ever clip terrain', () => {
    const rs = reliefScale(r);
    const reliefCeiling = r + MAX_DISPLACEMENT * rs;
    for (const s of specs) {
      const maxLat = orbitMaxLat(s.orbitEuler);
      const clearsSummitBand = maxLat < SUMMIT_LAT_MIN;
      const ridesAboveAllRelief = s.altitude > reliefCeiling + 0.5;
      expect(
        clearsSummitBand || ridesAboveAllRelief,
        `${s.kind} (${s.set}) maxLat=${maxLat.toFixed(2)} alt=${(s.altitude - r).toFixed(2)}`,
      ).toBe(true);
      // And the band floor itself is relief-scaled (the original bug).
      expect(s.altitude).toBeGreaterThan(r + 6.5 * rs - 1e-6);
    }
  });

  test('counts scale with area; both sets present; exactly one tower', () => {
    const clusters = specs.filter((s) => s.kind === 'cluster').length;
    const slabs = specs.filter((s) => s.kind === 'slab').length;
    expect(specs.filter((s) => s.kind === 'tower')).toHaveLength(1);
    expect(specs.filter((s) => s.kind === 'cirrus')).toHaveLength(1);
    if (r === 75) {
      expect(clusters).toBe(9);
      expect(slabs).toBe(6);
    } else {
      expect(clusters).toBe(4);
      expect(slabs).toBe(3);
    }
  });

  test('vertex budget holds and every geometry is vertex-colored, finite', () => {
    let totalVerts = 0;
    for (const s of specs) {
      const pos = s.geometry.getAttribute('position');
      totalVerts += pos.count;
      expect(s.geometry.getAttribute('color'), `${s.kind} missing colors`).toBeTruthy();
      for (let i = 0; i < pos.count; i++) {
        expect(Number.isFinite(pos.getX(i) + pos.getY(i) + pos.getZ(i))).toBe(true);
      }
      const col = s.geometry.getAttribute('color') as THREE.BufferAttribute;
      for (let i = 0; i < col.count; i += 97) {
        const v = col.getX(i);
        expect(v).toBeGreaterThan(0.5);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
    expect(totalVerts).toBeLessThanOrEqual(24000); // the plan's ledger ceiling
  });

  test('draw-call ledger: steady-state well under the old 41', () => {
    const fair = specs.filter((s) => s.set === 'fair').length;
    const storm = specs.filter((s) => s.set === 'storm').length;
    expect(Math.max(fair, storm)).toBeLessThan(41);
    if (r === 75) expect(fair).toBeLessThanOrEqual(15);
  });
});
