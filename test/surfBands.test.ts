// @vitest-environment happy-dom
//
// The surf bands (foam collar, shallow turquoise, outer edge) are DEPTHS in
// the shader, but what the eye reads is how many METRES of water they cover —
// and those are not the same thing at different radii. The continental shelf
// steepens as the world grows, so a fixed depth sits CLOSER to shore.
// MEASURED across the R=75->100 flip, from the waterline outward: the collar
// went 3.75m -> 3.25m and the shallow band 6.00m -> 5.25m (both ~-13%), in the
// most-looked-at 25 metres of the world.
//
// calibrateSurfBands() solves the depth that lands each band at its authored
// metre offset on the island being built, so the surf reads the same at any
// radius — and reproduces the authored 2.2 / 2.4 / 3.2 at R=75.
//
// The collar was 1.6 (3.75 m of water) until C2: at the shipped camera no
// white edge read at the waterline at all, so it is 2.2 (5.15 m) now.
import * as THREE from 'three';
import { beforeAll, describe, expect, test } from 'vitest';

import { Island } from '../Island';
import { installHeadlessCanvas } from './helpers/headlessDom';

const bandsOf = (isl: Island): THREE.Vector3 =>
  (isl as unknown as { seaBandsUniform: { value: THREE.Vector3 } }).seaBandsUniform.value;

let b75: THREE.Vector3;
let b100: THREE.Vector3;

beforeAll(() => {
  installHeadlessCanvas();
  new Island(75); // warm shared caches
  b75 = bandsOf(new Island(75)).clone();
  b100 = bandsOf(new Island(100)).clone();
}, 300000);

describe('surf bands are calibrated in metres, not baked as depths', () => {
  test('R=75 reproduces the authored depths (2.2 / 2.4 / 3.2)', () => {
    expect(b75.x).toBeCloseTo(2.2, 0);
    // Wider than the collar that never read (1.6), and still inside the shallows.
    expect(b75.x).toBeGreaterThan(1.9);
    expect(b75.x).toBeLessThan(b75.y);
    expect(b75.y).toBeCloseTo(2.4, 0);
    expect(b75.z).toBeCloseTo(3.2, 0);
  });

  test('the bands are SOLVED per radius, not inherited as literals', () => {
    // HONEST FINDING: the depth needed to hit a fixed metre offset turns out to
    // be nearly radius-invariant near the waterline (the old 3.75 m collar
    // solved to 1.81 at R=75 vs 1.79 at R=100), so the R=100 compression is
    // far smaller than the wave-8
    // research predicted — it claimed -19%, a from-the-waterline probe showed
    // ~-13% on the inner bands, and solving for it lands within ~1%.
    //
    // The value of the calibration is therefore CORRECTNESS AND FUTURE-PROOFING
    // rather than a dramatic visual restoration: the bands are now pinned to
    // metres of water by construction, so no future radius change can quietly
    // squeeze the surf again. This test asserts the mechanism (a solved value
    // close to, but not identical to, the authored one) rather than a
    // direction the measurements do not support.
    expect(b100.x).not.toBe(2.2); // solved, not the hardcoded literal
    expect(b100.x).toBeCloseTo(b75.x, 0); // and the solve is stable across radii
    expect(b100.y).toBeCloseTo(b75.y, 0);
  });

  test('bands stay ordered and physically sane at both radii', () => {
    for (const b of [b75, b100]) {
      expect(b.x).toBeGreaterThan(0);
      expect(b.y).toBeGreaterThan(b.x);
      expect(b.z).toBeGreaterThan(b.y);
      expect(b.z).toBeLessThan(12); // never runs away into open ocean
    }
  });
});
