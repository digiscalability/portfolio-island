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

beforeAll(() => {
  installHeadlessCanvas();
  new Island(75); // warm the shared caches — first build in a process differs
  at75 = kelpCount(new Island(75));
  at100 = kelpCount(new Island(100));
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
