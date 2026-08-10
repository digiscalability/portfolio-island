// @vitest-environment happy-dom
//
// Radius invariants — the guard the R50->R75 migration did not have.
//
// Before this file existed, the whole suite passed on a world with the wrong
// radius: no test constructed an Island at all, so every radius-dependent law
// lived only in prose. These assertions run against a REAL island built at two
// different radii, so a law that holds at 50 but breaks at 75 fails here rather
// than in someone's browser.
//
// Adding a radius? Add it to RADII. The cost is ~1.6s for both.

import * as THREE from 'three';
import { describe, expect, test, beforeAll } from 'vitest';

import { Island } from '../Island';
import { installHeadlessCanvas } from './helpers/headlessDom';

/** Private tuning constants, read for the headroom law they participate in. */
const waveConsts = Island as unknown as { WAVE_AMP: number; TIDE_AMP: number };
/** The sum of sine terms peaks at 1.8x the amplitude (see Island.ts wave block). */
const WAVE_PEAK_FACTOR = 1.8;

const RADII = [50, 75] as const;

/** Evenly-distributed directions — a golden spiral, not a lat/lon grid (which
 *  oversamples the poles and would weight the whole test toward the ice caps). */
function goldenSpiral(n: number): THREE.Vector3[] {
  const out: THREE.Vector3[] = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const y = 1 - (i / (n - 1)) * 2;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const th = golden * i;
    out.push(new THREE.Vector3(Math.cos(th) * r, y, Math.sin(th) * r).normalize());
  }
  return out;
}

/** The terrain mesh is the densest geometry in the group (sea is ~1/6 of it,
 *  grass/rocks are instanced with tiny source geometry). */
function terrainVertexCount(island: Island): number {
  let max = 0;
  island.mesh.traverse((o: THREE.Object3D) => {
    const g = (o as THREE.Mesh).geometry as THREE.BufferGeometry | undefined;
    const n = g?.attributes?.position?.count ?? 0;
    if (n > max) max = n;
  });
  return max;
}

/** SphereGeometry(r, seg, seg) yields (seg+1)^2 vertices. */
function segmentsFromVertexCount(count: number): number {
  return Math.round(Math.sqrt(count)) - 1;
}

describe('island radius invariants', () => {
  beforeAll(() => installHeadlessCanvas());

  const built = new Map<number, Island>();
  const islandAt = (r: number): Island => {
    let i = built.get(r);
    if (!i) {
      i = new Island(r);
      built.set(r, i);
    }
    return i;
  };

  test('ordering: the sampler ray always clears the displacement ceiling', () => {
    // If this inverts, raycasts start INSIDE the summits and grounding fails
    // silently on high terrain — no error, NPCs and shadows just stop seating.
    expect(Island.SAMPLE_RAY_DISP).toBeGreaterThan(Island.MAX_DISPLACEMENT);
  });

  test.each(RADII)('headroom: the sea can never reach the beach floor at R=%i', (r) => {
    // Documented failure this guards: 0.425 sea vs a 0.3 land floor let the
    // ocean poke up through the beach.
    //
    // Relief scales with the world; WAVES DO NOT (boats and swimmers are
    // human-sized). So this margin WIDENS as the world grows — but it is
    // exactly the kind of asymmetry that breaks silently if someone later
    // decides swell should scale after all.
    const s = r / Island.REFERENCE_RADIUS;
    const seaMax =
      Island.SEA_OFFSET * s + waveConsts.WAVE_AMP * WAVE_PEAK_FACTOR + waveConsts.TIDE_AMP;
    expect(seaMax).toBeLessThan(Island.LAND_FLOOR * s);
  });

  describe.each(RADII)('at radius %i', (r) => {
    test('vertex spacing is pinned regardless of radius', () => {
      const seg = segmentsFromVertexCount(terrainVertexCount(islandAt(r)));
      expect(seg).toBe(Math.round(r * 5.8));
      // 2*PI*r / (5.8*r) = 2*PI/5.8, constant at ANY radius. This is why the
      // 1.7u summit trail resolves at 50 and still resolves at 75 — and why
      // the docs' old "128x128 / spacing degrades when you grow" was wrong.
      expect((2 * Math.PI * r) / seg).toBeCloseTo((2 * Math.PI) / 5.8, 3);
    });

    test('seaLevel() matches the constant and an actual mesh sits there', () => {
      const island = islandAt(r);
      const s = r / Island.REFERENCE_RADIUS;
      expect(island.seaLevel()).toBeCloseTo(r + Island.SEA_OFFSET * s, 6);
      // The CPU sampler (what boats ride) and the sea mesh (what you see) must
      // agree. Both read Island.SEA_OFFSET today; this fails if either is ever
      // hardcoded to a literal instead.
      let found = false;
      island.mesh.traverse((o: THREE.Object3D) => {
        const g = (o as THREE.Mesh).geometry as THREE.BufferGeometry | undefined;
        if (found || !g?.attributes?.position) return;
        g.computeBoundingSphere();
        const br = g.boundingSphere?.radius ?? 0;
        if (Math.abs(br - island.seaLevel()) < 1e-3) found = true;
      });
      expect(found).toBe(true);
    });

    test('every sampled surface radius respects the clamps', () => {
      const island = islandAt(r);
      const lo = r * 0.86;
      const hi = r + Island.MAX_DISPLACEMENT * (r / Island.REFERENCE_RADIUS);
      for (const dir of goldenSpiral(500)) {
        const got = island.analyticSurface(dir).radius;
        expect(got).toBeGreaterThanOrEqual(lo - 1e-6);
        expect(got).toBeLessThanOrEqual(hi + 1e-6);
      }
    });
  });

  test('the land/sea split holds its shape across radii', () => {
    // The continent mask is latitude-driven and therefore angular, so growing
    // the world must not drown or beach the island. Catches a coastline
    // constant that was secretly absolute.
    const dirs = goldenSpiral(500);
    const landFraction = (r: number): number => {
      const island = islandAt(r);
      const sea = island.seaLevel();
      let land = 0;
      for (const d of dirs) if (island.analyticSurface(d).radius > sea) land++;
      return land / dirs.length;
    };
    const [a, b] = RADII.map(landFraction);
    expect(Math.abs(a - b)).toBeLessThan(0.02);
  });
});
