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

  test('the top rung is sticky in TIME, never behind an impossible frame rate', () => {
    // The sticky release bar used to be `fpsHighThreshold + 8`. applyRefreshEstimate
    // caps the adaptive target at 60 on EVERY display, so fpsHighThreshold is 57 and
    // that bar was 65 — above vsync on the commonest panel there is. Releases are
    // strictly reverse-order and the resolution claw-back is gated on
    // `qualityRung === 0`, so one dip that walked the ladder to rung 3 pinned the
    // WHOLE session at floor resolution + no bloom + half-rate shadows + half grass.
    const s = src('SimpleRenderer.ts');
    expect(s).not.toContain('this.fpsHighThreshold + 8');
    expect(s).toContain('SimpleRenderer.RUNG_RELEASE_COOLDOWN_S * 3');

    // ...and the arithmetic that made it impossible, so a future margin can't
    // reintroduce it: any rate bar must sit strictly below the achievable cap.
    const cap = Number(/ADAPTIVE_TARGET_CAP = (\d+)/.exec(s)?.[1]);
    const highRatio = Number(/this\.fpsHighThreshold = target \* ([\d.]+)/.exec(s)?.[1]);
    expect(cap).toBe(60);
    expect(highRatio).toBe(0.95);
    expect(cap * highRatio).toBeLessThan(cap); // 57 < 60: reachable
    expect(cap * highRatio + 8).toBeGreaterThan(cap); // 65 > 60: why +8 could never fire
  });
});

describe('no quality rung may switch RENDERING PATH', () => {
  // composer.render() draws to a linear-HDR target and tone-maps once in
  // OutputPass; renderer.render() tone-maps per material in every fragment
  // shader. MEASURED whole-frame, 12 readings: composer 127.8 mean luminance vs
  // direct 100.5. So rung 1 "turning bloom off" was really a 21% full-screen
  // brightness DROP — the governor's gentlest-sounding lever, engaged first, on
  // machines already struggling. Disabling the PASS instead measured 127.70 ->
  // 127.57 (0.11%), and on the live ladder rung 1 now moves luminance 0.008%.
  // engageRung + releaseRung with COMMENTS STRIPPED — these assertions are about
  // the code, and the prose below explains the very call it must not make.
  const ladder = (): string => {
    const s = src('SimpleRenderer.ts');
    const i = s.indexOf('private engageRung');
    const j = s.indexOf('public stopRenderLoop');
    expect(i, 'engageRung not found').toBeGreaterThan(-1);
    expect(j).toBeGreaterThan(i);
    return s
      .slice(i, j)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
  };

  test('rung 1 toggles the bloom PASS, not the composer', () => {
    const l = ladder();
    expect(l).toContain('this.bloomPass.enabled = false');
    expect(l).toContain('this.bloomPass.enabled = true');
    expect(l).not.toContain('setPostProcessingEnabled');
  });

  test('the suspend flag is keyed to the field the release restores', () => {
    // It used to snapshot postProcessingEnabled while release re-enabled the
    // composer. Once the rung writes bloomPass.enabled, snapshotting the other
    // field means an engage taken while bloom is already off re-enables it on
    // release — turning bloom ON for a user who had deliberately turned it off.
    expect(ladder()).toContain('this.bloomSuspendedByGovernor = this.bloomPass.enabled');
  });

  test('the intro fly-in does not switch it either', () => {
    // The governor was the RARE path; intro-lite ran on every non-reduced-motion
    // load. Measured back-to-back at fixed camera poses, the old lever stepped
    // +8.0% at the 1500ms restore point (+26.9% settled, +16.6% at the distant
    // start); the bloom pass measures 0.039% worst-case across the same poses.
    const m = src('main-simple.ts');
    expect(m).toContain('this.renderer.setBloomEnabled(false)');
    expect(m).toContain('this.renderer.setBloomEnabled(true)');
    // Exactly one setPostProcessingEnabled call survives in the app, and it
    // turns the composer ON at boot. Nothing may ever turn it off again —
    // that is what makes warmUp compile the bloom/output programs behind the
    // loader instead of mid-swoop.
    const calls = m.match(/this\.renderer\.setPostProcessingEnabled\((true|false)\)/g) ?? [];
    expect(calls).toEqual(['this.renderer.setPostProcessingEnabled(true)']);
  });

  test('the low tier, which never builds a composer, is guarded not asserted', () => {
    // bloomPass is undefined wherever initPostProcessing early-returns. A `!`
    // here throws inside setQualityRung's while-loop AFTER the rung counter has
    // been incremented but BEFORE the cooldown resets — leaving the governor
    // wedged and dropping a frame on every decision.
    const l = ladder();
    expect(l).toContain('if (this.bloomPass)');
    expect(l).not.toContain('this.bloomPass!');
  });
});
