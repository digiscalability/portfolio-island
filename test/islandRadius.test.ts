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
import { OrbitCamera } from '../OrbitCamera';
import {
  BIRD_SPOTS,
  CAT_SPOTS_AUTHORED,
  camNearThreshold,
  faunaElevOk,
  faunaGroundSpotOk,
  growSiteRing,
} from '../WorldPlacement';
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

  describe.each(RADII)('surface sampler at R=%i', (r) => {
    test('ray start clears the highest terrain', () => {
      const island = islandAt(r);
      const s = r / Island.REFERENCE_RADIUS;
      expect(r + Island.SAMPLE_RAY_DISP * s).toBeGreaterThan(island.maxTerrainRadius());
    });

    test('the raycast sampler seats ON the peaks, not on the base sphere', () => {
      // The shipped bug: sampleSurfacePosition's rays started at radius+5.5
      // while terrain reached radius+13.8 — on high ground every ray began
      // INSIDE the mountain and the function silently fell back to base-sphere
      // seating (~10u low on the summit). A behavioral pin, not a formula pin.
      const island = islandAt(r);
      let peakDir = goldenSpiral(2000)[0];
      let peakR = 0;
      for (const d of goldenSpiral(2000)) {
        const rr = island.analyticSurface(d).radius;
        if (rr > peakR) {
          peakR = rr;
          peakDir = d;
        }
      }
      const sampled = (
        island as unknown as {
          sampleSurfacePosition(p: THREE.Vector3, o: number): { position: THREE.Vector3 };
        }
      ).sampleSurfacePosition(peakDir.clone().multiplyScalar(r), 0);
      expect(sampled.position.length()).toBeGreaterThan(r + (peakR - r) * 0.7);
    });

    test('lamp ring parity: alternating kerbs survive the wrap', () => {
      const island = islandAt(r);
      let total = 0;
      let sites = 0;
      let infill = 0;
      island.mesh.traverse((o: THREE.Object3D) => {
        if (!/^lamp_\d+$/.test(o.name)) return;
        total++;
        if (o.userData.boulevardRing === 'sites') sites++;
        if (o.userData.boulevardRing === 'infill') infill++;
      });
      // 37 at R=50 is the historical "💡 37 lamp light pools" boot log —
      // external validation that the generated ring reproduces the hand list
      // (20 boulevard + 17 porch/plaza/tower lamps).
      expect(total).toBe(r === Island.REFERENCE_RADIUS ? 37 : 49);
      // The invariant the odd count broke: each ring's i%2 kerb pattern must
      // survive the wrap, which requires an even count per ring. (Strict
      // by-longitude alternation across BOTH rings interleaved never held —
      // the original hand list didn't have it either.)
      expect(sites % 2).toBe(0);
      expect(infill).toBe(sites);
    });
  });

  describe.each(RADII)('placement gates at R=%i', (r) => {
    test('every authored fauna spot is on land at fauna-plausible elevation', () => {
      // Authored spots are NEVER gated in production (hand-vetted), so this
      // asserts the parts that would indicate real data rot — water/elevation —
      // and deliberately NOT isNearStreet: cat #2 legitimately lounges beside
      // the avenue (measured: on-street at both radii, and always has been).
      const island = islandAt(r);
      for (const [lon, lat] of [...BIRD_SPOTS, ...CAT_SPOTS_AUTHORED]) {
        const dir = island.dirAt(lon, lat);
        expect(island.isOverWater(dir), `authored (${lon}, ${lat}) in water`).toBe(false);
        expect(faunaElevOk(island, dir), `authored (${lon}, ${lat}) too high`).toBe(true);
      }
    });

    test('growSiteRing never emits a generated spot the gate rejects', () => {
      const island = islandAt(r);
      const accept = (lon: number, lat: number): boolean => faunaGroundSpotOk(island, lon, lat);
      const grown = growSiteRing(BIRD_SPOTS, 27, accept);
      for (let i = BIRD_SPOTS.length; i < grown.length; i++) {
        expect(accept(grown[i][0], grown[i][1])).toBe(true);
      }
    });

    test('regression: the summit bird spot fails the gate', () => {
      // Ungated generation put bird spot #17 on the summit flank — measured
      // 5.25u above sea at R=75 (elevFrac 0.38-0.40 at both radii), well past
      // the 0.35 ceiling. (Cat #13, flagged in review as street-tight, was
      // MEASURED legal: 2.73u from the centreline vs a 1.9u keep-out — it
      // passes the gate and should.)
      const island = islandAt(r);
      const birds = growSiteRing(BIRD_SPOTS, 27); // NO gate — reproduce the bug
      expect(faunaGroundSpotOk(island, birds[17][0], birds[17][1])).toBe(false);
      const cats = growSiteRing(CAT_SPOTS_AUTHORED, 18);
      expect(faunaGroundSpotOk(island, cats[13][0], cats[13][1])).toBe(true);
    });

    test('camNearThreshold: summit chase pose is near, fly-in is far', () => {
      const island = islandAt(r);
      const t = camNearThreshold(island);
      // Highest possible in-play camera: summit + max zoom.
      expect(t).toBeGreaterThan(island.maxTerrainRadius() + OrbitCamera.MAX_DISTANCE);
      // The cinematic fly-in orbits at ~3.7x the radius — must always read far.
      expect(t).toBeLessThan(r * 2);
    });
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

  describe.each(RADII)('grass chunks at R=%i', (r) => {
    test('every chunk sphere is tight — culling is alive', () => {
      const island = islandAt(r);
      const grass = island.mesh.getObjectByName('grass');
      expect(grass, 'grass group missing').toBeTruthy();
      const chunks = (grass as THREE.Group).children as THREE.InstancedMesh[];
      expect(chunks.length).toBeGreaterThanOrEqual(10); // cap + 6 mid + 8 low wedges, tolerate empties
      let total = 0;
      for (const c of chunks) {
        total += c.count;
        const bs = c.geometry === undefined ? null : c.boundingSphere;
        expect(bs, `${c.name} has no bounding sphere`).toBeTruthy();
        // THE invariant chunking exists for: a sphere centred near the planet
        // core means a degenerate slot leaked in and every chunk once again
        // intersects the frustum from everywhere — culling silently dead.
        expect(bs!.center.length(), `${c.name} sphere reaches the planet centre`).toBeGreaterThan(
          0.5 * r,
        );
        // And it must stay a sector, not the whole shell.
        expect(bs!.radius).toBeLessThan(1.2 * r);
      }
      expect(total).toBe((island as unknown as { grassFullCount: number }).grassFullCount);
      expect(total).toBeGreaterThan(10000); // live blades, not slots
    });

    test('setGrassBudget trims per chunk and restores cleanly', () => {
      const island = islandAt(r);
      const grass = island.mesh.getObjectByName('grass') as THREE.Group;
      const chunks = grass.children as THREE.InstancedMesh[];
      const full = chunks.map((c) => c.count);
      island.setGrassBudget(0.5);
      chunks.forEach((c, i) => {
        expect(c.count).toBe(Math.max(1, Math.round(full[i] * 0.5)));
      });
      island.setGrassBudget(1);
      chunks.forEach((c, i) => {
        expect(c.count).toBe(full[i]);
      });
    });
  });

  describe.each(RADII)('seafloor life at R=%i', (r) => {
    test('exactly ≤5 draws: 4 kelp chunks + 1 coral mesh, spheres tight', () => {
      const island = islandAt(r);
      const sf = island.mesh.getObjectByName('seafloor_life');
      expect(sf, 'seafloor_life group missing').toBeTruthy();
      const kids = (sf as THREE.Group).children;
      expect(kids.length).toBeLessThanOrEqual(5); // the audit's draw ledger
      const kelp = kids.filter((c) => c.name.startsWith('kelp_chunk_')) as THREE.InstancedMesh[];
      expect(kelp.length).toBeGreaterThanOrEqual(3); // tolerate one empty octant
      for (const c of kelp) {
        // Same invariant as grass: a sphere reaching the core = culling dead.
        expect(c.boundingSphere, `${c.name} has no bounding sphere`).toBeTruthy();
        expect(c.boundingSphere!.center.length()).toBeGreaterThan(0.5 * r);
      }
      expect(kids.some((c) => c.name === 'coral_layer')).toBe(true);
    });

    test('no kelp strand can breach the sea surface', () => {
      const island = islandAt(r);
      const sf = island.mesh.getObjectByName('seafloor_life') as THREE.Group;
      const sea = island.seaLevel();
      const KELP_H = 1.6;
      const m = new THREE.Matrix4();
      const pos = new THREE.Vector3();
      const q = new THREE.Quaternion();
      const s = new THREE.Vector3();
      for (const c of sf.children) {
        if (!c.name.startsWith('kelp_chunk_')) continue;
        const inst = c as THREE.InstancedMesh;
        for (let i = 0; i < inst.count; i++) {
          inst.getMatrixAt(i, m);
          m.decompose(pos, q, s);
          // Root radius + full strand height must stay below MEAN sea level
          // (waves add ±WAVE_AMP, hence the placement's 0.85 headroom factor).
          expect(pos.length() + s.y * KELP_H).toBeLessThan(sea + 0.4);
        }
      }
    });

    test('kelp population scales with world area', () => {
      const counts = RADII.map((rr) => {
        const sf = islandAt(rr).mesh.getObjectByName('seafloor_life') as THREE.Group;
        let n = 0;
        for (const c of sf.children) {
          if (c.name.startsWith('kelp_chunk_')) n += (c as THREE.InstancedMesh).count;
        }
        return n;
      });
      expect(counts[0]).toBeGreaterThan(50);
      // R=75 carries ~2.25× the surface of R=50 — the bed should grow with it
      // (placement rejection makes it inexact; 1.5× is the floor).
      expect(counts[1]).toBeGreaterThan(counts[0] * 1.5);
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
