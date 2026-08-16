// Locks for the "too fast / blurry" regressions.
//
// Both speed reports traced to the SAME class of bug the R=75->100 flip has
// now produced four times: an ANGULAR rate (or an accumulated delta) left
// alone while the thing it multiplies grew. These pin the arithmetic so the
// next radius change can't quietly re-inflate them.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import { buildCloudFormations } from '../CloudFormations';

const src = (f: string): string => readFileSync(join(process.cwd(), f), 'utf8');

/** Mean LINEAR cloud speed (u/s) = mean(omega * altitude). */
const meanLinearCloudSpeed = (radius: number): number => {
  const specs = buildCloudFormations(radius);
  const total = specs.reduce((sum, s) => sum + s.driftSpeed * s.altitude, 0);
  return total / specs.length;
};

describe('cloud drift is a LINEAR speed, not an angular one', () => {
  // NOTE ON METHOD: an earlier version of this compared the MEAN linear speed
  // at R=75 against R=100 and demanded a ratio under 1.4. That failed at
  // 1.546 — and the test was the thing that was wrong: the two radii build
  // DIFFERENT NUMBERS of formations (36 vs 14), so they consume different
  // rng() draws and the means carry sampling noise, not just the radius
  // factor. Comparing the authored BOUNDS removes the sampling entirely.
  // ...and comparing the OBSERVED min/max still wasn't noise-free (0.96 vs
  // 0.87 across the two radii) for the same reason: with a finite, differing
  // number of samples the extremes are themselves random. The only quantity
  // with no sampling in it is the AUTHORED band every draw must land inside.
  const AUTHORED = { min: 0.86, max: 0.86 + 1.71 };

  test('every cloud sits in the authored u/s band at ANY radius', () => {
    // This is the real guarantee: drift is authored in world-units-per-second
    // and divided by THIS island's altitude, so the achievable linear band is
    // identical at any world size. The bug — a bare angular constant — put
    // R=100 at 1.14x-3.43x this band instead.
    for (const radius of [50, 75, 100, 140]) {
      for (const s of buildCloudFormations(radius)) {
        const linear = s.driftSpeed * s.altitude;
        expect(linear).toBeGreaterThanOrEqual(AUTHORED.min - 1e-9);
        expect(linear).toBeLessThanOrEqual(AUTHORED.max + 1e-9);
      }
    }
  });

  test('and that band is the shipped R=75 feel, not the inflated one', () => {
    // Pre-fix R=100 ran a mean of ~2.30 u/s against R=75's ~1.71.
    expect(meanLinearCloudSpeed(100)).toBeLessThan(2.0);
  });
});

describe('the frame limiter reports true wall time', () => {
  test('the accumulator is cleared, not carried', () => {
    // `wallDt = frameAccum` consumes the WHOLE accumulator, so keeping
    // `frameAccum %= interval` re-injected the remainder into the next frame
    // and simulated time outran the clock (~2.5x on a jittery 120Hz phone) —
    // inflating player movement AND cloud drift, and producing the irregular
    // 16/25ms cadence that reads as judder.
    const s = src('SimpleRenderer.ts');
    expect(s).toContain('this.frameAccum = 0;');
    expect(s).not.toContain('this.frameAccum %= interval;');
  });
});

describe('the resolution governor can actually recover', () => {
  test('restore is not slower than shed, and shedding needs a sustained dip', () => {
    const s = src('SimpleRenderer.ts');
    expect(s).toContain('this.renderScale - 0.08'); // shed
    expect(s).toContain('this.renderScale + 0.1'); // restore — now the faster of the two
    expect(s).toContain('lowStreak');
  });

  test('scaleFloor can never become a no-op', () => {
    // dprFloor doubles as a floor on dprCap, so on a 4K panel both landed on
    // 0.6 and scaleFloor computed to exactly 1.0 — freezing the lever while
    // the machine sat permanently at 0.6 effective DPR.
    expect(src('SimpleRenderer.ts')).toContain('Math.min(0.9, this.dprFloor / this.dprCap)');
  });
});
