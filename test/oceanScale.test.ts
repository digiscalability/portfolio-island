// @vitest-environment happy-dom
//
// Seafloor life lives in a depth-gated SHORELINE RING (kelp 1.2-3.2u deep),
// so its habitat grows with the CIRCUMFERENCE, not the surface area. It was
// scaled by areaScale, which inflated density 1.67x on a ring that widens only
// ~6.5% — the R=75->100 flip took kelp 360 -> 640. The counts are re-based on
// beltScale so R=75 is byte-identical and R=100 is honest.
import * as THREE from 'three';
import { beforeAll, describe, expect, test } from 'vitest';

import { Island } from '../Island';
import {
  MANTA_DEPTH_MID,
  MANTA_DEPTH_SWING,
  MANTA_FLOOR_CLEAR,
  MANTA_MIN_DEPTH,
  mantaCircuitLonLat,
  mantaDepthFor,
  solveMantaRing,
} from '../WorldPlacement';
import { UNDERWATER_FOG_DENSITY } from '../WorldScale';
import { installHeadlessCanvas } from './helpers/headlessDom';

const kelpCount = (isl: Island): number => {
  let n = 0;
  isl.mesh.traverse((o) => {
    const im = o as THREE.InstancedMesh;
    if (im.isInstancedMesh && /kelp_chunk/.test(o.name || '')) n += im.count;
  });
  return n;
};

let at75: number;
let at100: number;
let isl75: Island;
let isl100: Island;

beforeAll(() => {
  installHeadlessCanvas();
  new Island(75); // warm the shared caches — first build in a process differs
  isl75 = new Island(75);
  isl100 = new Island(100);
  at75 = kelpCount(isl75);
  at100 = kelpCount(isl100);
}, 300000);

describe('seafloor life scales with the shore, not the surface', () => {
  test('R=75 is unchanged by the re-basing (160*areaScale == 240*beltScale)', () => {
    expect(at75).toBe(360);
  });

  test('R=100 grows with the CIRCUMFERENCE, not the area', () => {
    // belt: 360 * (100/75) = 480. area would have been 360 * (100/75)^2 = 640.
    expect(at100).toBe(480);
    expect(at100).toBeLessThan(600); // nowhere near the area-scaled 640
  });

  test('density per unit of shoreline is preserved across the flip', () => {
    // Counts over circumference must match to within rounding.
    expect(at100 / 100).toBeCloseTo(at75 / 75, 2);
  });
});

describe('underwater murk is human-scale', () => {
  test('the submerged density is an absolute constant, not radius-derived', () => {
    // THE POINT OF THIS TEST is that the radius must not own this value. The
    // old code reached ~0.12 only by multiplying the island fog (0.45/R), so
    // the R=75->100 flip silently dropped it to 0.090 (-25%). Assert the
    // INVARIANT (a bare constant in a sane band), not one blessed literal —
    // the value itself is art direction and was retuned to 0.07 once the
    // dive, the bait ball and the manta gave the murk something to hide.
    expect(UNDERWATER_FOG_DENSITY).toBeGreaterThan(0.02);
    expect(UNDERWATER_FOG_DENSITY).toBeLessThan(0.2);
  });

  test('a diver can see the biggest animal whole', () => {
    // The manta spans 5.2u, so framing it needs ~10u of standoff. FogExp2 is
    // 1 - exp(-(d*x)^2); at 0.12 that was 76% fogged — the murk was hiding
    // the one thing worth diving for.
    const fogAt = (d: number): number => 1 - Math.exp(-Math.pow(d * UNDERWATER_FOG_DENSITY, 2));
    expect(fogAt(10)).toBeLessThan(0.5);
    // ...but the sea must still FADE, or it reads as an aquarium.
    expect(fogAt(25)).toBeGreaterThan(0.85);
  });
});

/**
 * THE MANTA'S CIRCUIT.
 *
 * The shipped ring was centred on the bait ball and clamped with the floor
 * clearance as the OUTER max, so where the reef shelved up to 0.80u the animal
 * was pushed to 0.6u ABOVE MEAN SEA LEVEL — a ray flying over the sea, measured
 * on the live object at 14/144 samples of a full circuit.
 *
 * These assert the INVARIANTS, not the tuned numbers: a depth band is art
 * direction and will move again, but "never leaves the water" and "never sinks
 * into the seabed" must hold at any radius, for any band, forever.
 */
const walkCircuit = (
  island: Island,
  steps = 72,
  phases = 12,
): Array<{ depth: number; floorDepth: number }> => {
  const sea = island.seaLevel();
  const ring = solveMantaRing(island, 2.2, 0.06); // the bait anchor
  const out: Array<{ depth: number; floorDepth: number }> = [];
  for (let p = 0; p < phases; p++) {
    const want = MANTA_DEPTH_MID + MANTA_DEPTH_SWING * Math.sin((p / phases) * Math.PI * 2);
    for (let i = 0; i < steps; i++) {
      const pt = mantaCircuitLonLat(island, ring, (i / steps) * Math.PI * 2);
      const floorDepth = sea - island.analyticSurface(island.dirAt(pt.lon, pt.lat)).radius;
      out.push({ depth: mantaDepthFor(floorDepth, want), floorDepth });
    }
  }
  return out;
};

describe('the manta stays in the sea', () => {
  for (const [label, get] of [
    ['R=100 (live)', (): Island => isl100],
    ['R=75 (the previous world)', (): Island => isl75],
  ] as Array<[string, () => Island]>) {
    describe(label, () => {
      test('never breaches the surface', () => {
        // The bug, stated as an invariant. Depth is measured DOWN from mean sea
        // level, so any sample <= 0 is an animal in the air.
        const worst = Math.min(...walkCircuit(get()).map((s) => s.depth));
        expect(worst).toBeGreaterThanOrEqual(MANTA_MIN_DEPTH);
      });

      test('never sinks into the seabed', () => {
        // The wingtip reaches MANTA_FLOOR_CLEAR below the origin at full bank
        // and full flap, so anything less than that clearance is a wing through
        // the reef. Only meaningful where the column can hold the animal at all.
        const holds = walkCircuit(get()).filter(
          (s) => s.floorDepth >= MANTA_MIN_DEPTH + MANTA_FLOOR_CLEAR,
        );
        expect(holds.length).toBeGreaterThan(0);
        for (const s of holds) {
          expect(s.floorDepth - s.depth).toBeGreaterThanOrEqual(MANTA_FLOOR_CLEAR - 1e-9);
        }
      });
    });
  }

  test('the solved circuit has NO column too thin to hold the animal', () => {
    // Without this the "never sinks" test above could pass vacuously: a solver
    // that returned a terrible ring would have almost every sample filtered out
    // as "column too thin" and the few survivors would still be clear.
    const thin = walkCircuit(isl100).filter(
      (s) => s.floorDepth < MANTA_MIN_DEPTH + MANTA_FLOOR_CLEAR,
    );
    expect(thin.length).toBe(0);
  });

  test('the circuit is SOLVED onto deep water, not left on the anchor', () => {
    // A ring centred on the bait anchor cannot clear the shelf at ANY radius —
    // measured minimum floor there: R=4 -> 1.96u, R=6 -> 1.22u, R=7.5 -> 0.82u.
    // So the solver must actually move the centre; if it ever returns the
    // anchor unchanged at R=100, it has stopped doing its job.
    const solved = solveMantaRing(isl100, 2.2, 0.06);
    const moved = Math.hypot(solved.lon - 2.2, solved.lat - 0.06);
    expect(moved).toBeGreaterThan(0);
    expect(solved.minFloor).toBeGreaterThan(MANTA_MIN_DEPTH + MANTA_FLOOR_CLEAR);
  });

  test('the animal sits below the diver EYE line, not the diver', () => {
    // MEASURED live: a diver's body bottoms out at 3.87u but the chase camera
    // trails 1.43u above them, so the player's eye never gets below ~2.49u.
    // Tuning depth against the BODY is what made the old band read as "swimming
    // on the ceiling" — the whole band has to clear the EYE, not the swimmer.
    const DIVER_EYE_DEPTH = 2.49;
    const samples = walkCircuit(isl100, 72, 24).map((s) => s.depth);
    const below = samples.filter((d) => d > DIVER_EYE_DEPTH).length;
    expect(below / samples.length).toBeGreaterThan(0.6);
  });

  test('the clamp can never be re-inverted into the shipped bug', () => {
    // The original was max(floor + clear, min(sea - 1.3, want)) — the floor
    // outranking the surface. Pin the ordering directly on a column too thin
    // to satisfy both: the animal must sink, never fly.
    expect(mantaDepthFor(0.8, MANTA_DEPTH_MID)).toBeGreaterThanOrEqual(MANTA_MIN_DEPTH);
    // ...and where there IS room, the floor still wins over an over-deep want.
    expect(mantaDepthFor(5.0, 99)).toBeCloseTo(5.0 - MANTA_FLOOR_CLEAR, 6);
    // ...and a shallow want is honoured as-is when nothing constrains it.
    expect(mantaDepthFor(9.0, 2.2)).toBeCloseTo(2.2, 6);
  });
});
