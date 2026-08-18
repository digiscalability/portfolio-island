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
import { SimpleRenderer } from '../SimpleRenderer';

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

describe('the controller expects a rate the frame limiter can actually produce', () => {
  // The limiter renders only once a whole capped interval has accumulated, so
  // the delivered rate is quantised to hz/skipsPerRender — NOT the cap. The
  // thresholds used to be derived from the CAP, so a healthy 90Hz budget
  // Android (delivering exactly 45.00) sat ON its own 45 shed bar and could
  // never reach a 57 release bar it was structurally incapable of producing.
  const SNAP_RATES = [60, 75, 90, 120, 144, 165, 240];
  const CAP = 60;

  /** The REAL loop from startRenderLoop, run for 20 simulated seconds. */
  const simulateLimiter = (hz: number, capFps: number): number => {
    if (capFps <= 0) return hz;
    const raw = 1 / hz;
    const interval = 1 / capFps;
    const tolerance = 0.001; // FRAME_CAP_TOLERANCE_S
    let accum = 0;
    let renders = 0;
    const seconds = 20;
    for (let i = 0; i < hz * seconds; i++) {
      accum += raw;
      if (accum < interval - tolerance) continue;
      renders += 1;
      accum = 0; // matches `this.frameAccum = 0` — see the limiter's own note
    }
    return renders / seconds;
  };

  const deliveredFps = (hz: number, cap: number): number =>
    (SimpleRenderer as unknown as { deliveredFps(h: number, c: number): number }).deliveredFps(
      hz,
      cap,
    );

  test('deliveredFps() models the limiter exactly at every snapped rate', () => {
    // This is the anti-drift lock: the formula is a MODEL of the loop, so if
    // anyone retunes the limiter without retuning the model, the controller
    // silently starts expecting an impossible rate again.
    for (const hz of SNAP_RATES) {
      const cap = hz > 66 ? CAP : 0; // isLowTierDevice() && hz > 66
      expect(deliveredFps(hz, cap), `${hz}Hz`).toBeCloseTo(simulateLimiter(hz, cap), 6);
    }
  });

  test('the cap does NOT deliver 60 on four of the seven standard refresh rates', () => {
    // Pinning the surprise itself, because it is the whole reason the old
    // derivation was wrong — and because it is a live perf finding: the 60fps
    // low-tier cap actually renders 45fps on a 90Hz phone.
    expect(deliveredFps(60, 0)).toBe(60);
    expect(deliveredFps(75, CAP)).toBe(37.5);
    expect(deliveredFps(90, CAP)).toBe(45);
    expect(deliveredFps(120, CAP)).toBe(60);
    expect(deliveredFps(144, CAP)).toBe(48);
    expect(deliveredFps(165, CAP)).toBe(55);
    expect(deliveredFps(240, CAP)).toBe(60);
  });

  test('every refresh rate ends up with a REACHABLE release bar', () => {
    // The bug in one assertion: a device must be able to out-run its own
    // recovery threshold, or the ladder is a one-way ratchet.
    for (const hz of SNAP_RATES) {
      const cap = hz > 66 ? CAP : 0;
      const delivered = deliveredFps(hz, cap);
      const target = Math.min(60, delivered);
      const low = target * 0.75;
      const high = target * 0.95;
      expect(delivered, `${hz}Hz must clear its release bar`).toBeGreaterThan(high);
      expect(delivered, `${hz}Hz must sit above its shed bar`).toBeGreaterThan(low);
    }
  });

  test('the refresh estimate is a MEDIAN, immune to the one-way jitter ratchet', () => {
    // The min-based estimate could only ever bias HIGH: rAF jitter shortens
    // deltas, mis-binning one snap step up takes 1.6ms at 90Hz (11.11ms ->
    // 9.52ms reads as 120Hz) and 0.76ms at 120Hz, and over 60 samples the min
    // GUARANTEES the worst outlier wins. A high mis-bin makes deliveredFps
    // predict 60 while the true-90Hz loop delivers 45 — silently reinstating
    // the sits-on-its-own-shed-bar bug the threshold derivation fix removed.
    const s = src('SimpleRenderer.ts');
    expect(s).not.toContain('minFrameDt');
    expect(s).toContain('sorted[sorted.length >> 1]');
    // ...and the median genuinely survives the jitter that breaks the min:
    // 60 true-90Hz samples with five 1.6ms-short outliers.
    const dts = Array(55)
      .fill(1 / 90)
      .concat(Array(5).fill(1 / 90 - 0.0016));
    const sortedDts = [...dts].sort((a, b) => a - b);
    const median = 1 / sortedDts[sortedDts.length >> 1];
    const min = 1 / Math.min(...dts);
    const snapTo = (obs: number): number => {
      let hz = 60;
      for (const r of [60, 75, 90, 120, 144, 165, 240]) {
        if (Math.abs(r - obs) < Math.abs(hz - obs)) hz = r;
      }
      return hz;
    };
    expect(snapTo(median)).toBe(90); // median: correct
    expect(snapTo(min)).toBe(120); // min: mis-binned high — the old behaviour
  });

  test('the OLD cap-derived thresholds failed exactly where measured', () => {
    // Guards the claim, not just the fix: with target = the CAP, four rates
    // could not reach the release bar and one could not even clear the shed bar.
    const oldHigh = 60 * 0.95; // 57 — what `Math.min(capped, frameCapFps)` gave
    const oldLow = 60 * 0.75; // 45
    expect(deliveredFps(90, CAP)).toBeLessThan(oldHigh);
    expect(deliveredFps(144, CAP)).toBeLessThan(oldHigh);
    expect(deliveredFps(165, CAP)).toBeLessThan(oldHigh);
    expect(deliveredFps(75, CAP)).toBeLessThan(oldLow); // sheds forever
    expect(deliveredFps(90, CAP)).toBe(oldLow); // sits exactly ON the bar
  });
});

describe('shadowMap.autoUpdate has exactly one owner', () => {
  // The governor's rung 2 and GameScene's interior mode both used to write the
  // raw field, the interior via save-on-enter/restore-on-exit. Save/restore
  // does not compose with a second writer: a governor RELEASE while indoors
  // was overwritten by the stale saved `false` on exit — freezing the OUTDOOR
  // shadow map for the rest of the session while the sun kept moving (rung < 2
  // means render()'s half-rate re-arm never fires, so nothing ever heals it) —
  // and an ENGAGE while indoors was overwritten by the stale `true`, silently
  // discarding the rung's saving. The renderer now derives the field from
  // freeze + rung in ONE place.
  test('GameScene requests the freeze; it never writes the raw field', () => {
    // Comments stripped: the prose explaining WHY GameScene must not touch the
    // field necessarily names the field.
    const g = src('GameScene.ts')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    expect(g).not.toContain('shadowMap.autoUpdate');
    expect(g).not.toContain('shadowAutoUpdateWas');
    expect(g).toContain('setShadowFreeze?.(true)');
    expect(g).toContain('setShadowFreeze?.(false)');
  });

  test('the renderer writes the raw field in exactly one place: the policy', () => {
    const s = src('SimpleRenderer.ts');
    const writes = s.match(/shadowMap\.autoUpdate =/g) ?? [];
    // ONE raw writer now: applyShadowPolicy. Construction routes THROUGH the
    // policy (not a second raw write) so ?halfshadow=1 takes effect from frame
    // 1 — a single owner is even cleaner than the old construction+policy pair.
    expect(writes).toHaveLength(1);
    expect(s).toContain('this.applyShadowPolicy();');
    // The policy derives the field from freeze + rung + the always-half lever.
    expect(s).toContain('!this.shadowFrozen && this.qualityRung < 2 && !this.alwaysHalfShadow');
  });

  test('the half-rate re-arm and the engage refresh both respect the freeze', () => {
    // Otherwise rung >= 2 (or the ?halfshadow lever) indoors still runs a depth
    // pass every other frame — exactly the waste the interior freeze stops.
    const s = src('SimpleRenderer.ts');
    expect(s).toContain(
      'if ((this.qualityRung >= 2 || this.alwaysHalfShadow) && !this.shadowFrozen) {',
    );
    expect(s).toContain('if (!this.shadowFrozen) this.renderer.shadowMap.needsUpdate = true;');
  });

  test('unfreezing refreshes the map once, whatever the rung', () => {
    // The sun kept moving while indoors; without this the first outdoor frame
    // shows a map minutes stale (and at rung >= 2 the next re-arm is 2 frames
    // away).
    const s = src('SimpleRenderer.ts');
    const i = s.indexOf('public setShadowFreeze');
    const body = s.slice(i, i + 900);
    expect(body).toContain('if (!frozen) this.renderer.shadowMap.needsUpdate = true;');
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

  test('the governor measures WALL time, not the physics-clamped dt', () => {
    // animate() clamps dt to 0.05 so a stall cannot teleport the player. That
    // clamp is 20fps, and handing it to a controller that measures FRAME RATE
    // floored its whole view at 20fps and stretched every clock it owns: the
    // "1Hz" decision became 2.0s of wall at a true 10fps, the 4s engage
    // cooldown 8s, the 12s release 24s. SIMULATED: a true 1.5fps device reached
    // rung 3 at 22.7s instead of never (old code stopped at rung 1 at 106.7s);
    // a true 0.8fps device engaged NOTHING in 120s before, full ladder by 42.5s
    // now. Above 20fps the clamp never bound, so nothing changes there.
    const s = src('SimpleRenderer.ts');
    expect(s).toContain('this.updateAdaptiveResolution(wallDt)');
    expect(s).not.toContain('this.updateAdaptiveResolution(deltaTime)');
  });

  test('a stall is excluded as an EVENT but a RUN of them is a rate', () => {
    // Excluding every frame over the threshold looks right and is a regression
    // on the worst machines: a device at 1.5fps has EVERY frame over it, so the
    // EMA would sit at its 60 initializer forever and the governor would never
    // act — and if the EMA froze above the high bar it would keep ADDING
    // resolution to a dying machine. Run length is what separates the two.
    const s = src('SimpleRenderer.ts');
    expect(s).toContain('this.stallRun = overLong ? this.stallRun + 1 : 0');
    expect(s).toContain('const isolatedStall = overLong && this.stallRun < 3');
    // ...and an excluded frame must not buy a DECISION either, or the first
    // visible frame after a 60s alt-tab sheds on a 60-second-old EMA.
    expect(s).toContain('if (isolatedStall) return;');
  });

  test('lowStreak resets on any decision that is not low', () => {
    // It used to reset only ABOVE the high bar, so a machine parked in the
    // 45-57 hysteresis dead band kept a stale streak of 1 forever and the next
    // isolated hitch — minutes later — sheds. Latent before, reachable once dt
    // is honest: one 150ms hitch moves a 50fps EMA to 42.1 (the clamped dt
    // could only reach 48.07). SIMULATED 15 minutes at 50fps with a hitch a
    // minute: 0 sheds after the fix.
    const s = src('SimpleRenderer.ts');
    const i = s.indexOf('private updateAdaptiveResolution');
    // Ends at armGovernor: its RESET legitimately zeroes qualityAccum (it is
    // discarding the disarmed period, not truncating a live decision cycle).
    const body = s.slice(i, s.indexOf('public armGovernor'));
    // the reset must NOT be the first statement of the high-threshold branch
    expect(body).not.toMatch(
      /else if \(this\.fpsEma > this\.fpsHighThreshold\) \{\s*this\.lowStreak = 0;/,
    );
    expect(body).toContain('this.qualityAccum -= 1;'); // not `= 0`, which discarded up to 0.5s
    expect(body).not.toContain('this.qualityAccum = 0;');
  });

  test('the ladder steps OVER rung 1 where it is inert (low tier)', () => {
    // The low tier never builds a composer, so bloomPass is undefined and
    // rung 1 sheds nothing — yet engaging it reset the cooldown, making a
    // drowning low-tier machine wait a full extra engage window (4s) before
    // the first lever that works there (rung 2), and a recovering one park
    // at the inert rung for a release window (12s) before the claw-back
    // (gated on rung 0) could start. Both decision sites route through
    // rungStep, which skips 1 in either direction when the pass is absent.
    const s = src('SimpleRenderer.ts')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    expect(s).toContain('private rungStep(dir: 1 | -1): number');
    expect(s).toContain('next === 1 && !this.bloomPass ? this.qualityRung + 2 * dir : next');
    expect(s).toContain('this.setQualityRung(this.rungStep(1))');
    expect(s).toContain('this.setQualityRung(this.rungStep(-1))');
    // the raw ±1 decisions must be gone (setQualityRung's internal walk stays)
    expect(s).not.toContain('this.setQualityRung(this.qualityRung + 1)');
    expect(s).not.toContain('this.setQualityRung(this.qualityRung - 1)');
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
    // Bloom is turned back on at arrival via fadeBloomIn (a strength ramp, not a
    // path switch) — the intro must still re-enable bloom, just without the pop.
    expect(m).toContain('this.renderer.fadeBloomIn(');
    // Exactly one setPostProcessingEnabled call survives in the app, and it
    // turns the composer ON at boot. Nothing may ever turn it off again —
    // that is what makes warmUp compile the bloom/output programs behind the
    // loader instead of mid-swoop.
    const calls = m.match(/this\.renderer\.setPostProcessingEnabled\((true|false)\)/g) ?? [];
    expect(calls).toEqual(['this.renderer.setPostProcessingEnabled(true)']);
  });

  test('the governor is DISARMED until the intro resolves', () => {
    // The render loop starts immediately before the 2.5s whole-planet fly-in,
    // and with the clocks on true wall time, time-to-rung-1 is a constant ~9s
    // — so a heavy intro could walk the ladder off the least representative
    // seconds the game has. The gate must sit BEFORE the decision block, arm
    // from afterIntro (both intro branches funnel through it), self-arm after
    // 10s as a fallback, and DISCARD everything measured while disarmed.
    const s = src('SimpleRenderer.ts');
    const gov = s.slice(
      s.indexOf('private updateAdaptiveResolution'),
      s.indexOf('public armGovernor'),
    );
    expect(gov).toContain('if (!this.governorArmed) {');
    // the gate comes before the decision accumulator, not after
    expect(gov.indexOf('governorArmed')).toBeLessThan(gov.indexOf('this.qualityAccum += dt'));
    const arm = s.slice(s.indexOf('public armGovernor'), s.indexOf('private setQualityRung'));
    for (const reset of [
      'this.fpsEma = 60',
      'this.qualityAccum = 0',
      'this.rungCooldown = 0',
      'this.lowStreak = 0',
      'this.stallRun = 0',
    ]) {
      expect(arm, `armGovernor must reset ${reset}`).toContain(reset);
    }
    expect(arm).toContain('if (this.governorArmed) return;'); // idempotent
    expect(s).toContain('GOVERNOR_ARM_FALLBACK_S = 10');
    // ...and main-simple actually arms it where both intro branches converge.
    const m = src('main-simple.ts')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    expect(m).toContain('this.renderer.armGovernor()');
  });

  test('Ctrl+B toggles the bloom PASS and tells the truth about it', () => {
    // It used to call togglePostProcessing — flipping the whole COMPOSER, the
    // one remaining user-reachable render-path switch (the 21% luminance
    // step) — and printed "Bloom enabled/disabled" from the composer flag.
    // With the governor holding rung 1 that message lied: composer back on
    // printed "Bloom enabled" while zero bloom rendered, and the brightness
    // jump got attributed to bloom.
    const m = src('main-simple.ts')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    expect(m).toContain('this.renderer.toggleBloom()');
    expect(m).not.toContain('togglePostProcessing');
    // The composer-toggle API is GONE, not merely unused — nothing may switch
    // rendering path after boot. (setPostProcessingEnabled(true) at boot is
    // pinned by the intro test above.)
    const s = src('SimpleRenderer.ts')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    expect(s).not.toContain('togglePostProcessing');
    expect(s).not.toContain('isPostProcessingEnabled');
    expect(s).toContain('public toggleBloom()');
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
