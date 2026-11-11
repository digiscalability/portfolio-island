// The renderer's perf levers, driven (not read): half-rate shadows (E2) and
// the night bloom threshold (P2-E5).
//
// SimpleRenderer needs a WebGL context to construct, so these build a bare
// instance from its prototype, give it the fields the lever reads, and stand a
// counter in for three's renderer: a shadow pass runs when shadowMap.autoUpdate
// or shadowMap.needsUpdate is set, and needsUpdate is cleared after it, which
// is WebGLShadowMap.render's own rule. The source locks for the same code are
// in test/feelRegressions.test.ts.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { fx } from '../FxBudget';
import { SimpleRenderer } from '../SimpleRenderer';

type Bare = Record<string, unknown> & {
  renderer: { shadowMap: { autoUpdate: boolean; needsUpdate: boolean }; render: () => void };
  shadowPasses: number;
  frames: number;
};

/** A SimpleRenderer without a GL context: just the state the levers read. */
function bare(opts: { lowTier?: boolean; param?: boolean | null; bloomPass?: boolean } = {}): Bare {
  // FxBudget carries the same tier rule as the renderer (test/fxBudget.test.ts
  // pins that they agree); node has neither a pointer nor a phone's core count.
  fx.setTier(opts.lowTier ? 'low' : 'desktop');
  const r = Object.create(SimpleRenderer.prototype) as Bare;
  r.shadowPasses = 0;
  r.frames = 0;
  const shadowMap = { autoUpdate: true, needsUpdate: false };
  r.renderer = {
    shadowMap,
    render: () => {
      r.frames += 1;
      if (shadowMap.autoUpdate || shadowMap.needsUpdate) r.shadowPasses += 1;
      shadowMap.needsUpdate = false;
    },
  };
  Object.assign(r, {
    contextLost: false,
    scene: {},
    camera: {},
    postProcessingEnabled: false,
    composer: undefined,
    bloomPass: opts.bloomPass ? { enabled: true } : undefined,
    pendingCapture: null,
    shadowFrozen: false,
    shadowFramePhase: 0,
    qualityRung: 0,
    halfShadowParam: opts.param ?? null,
    lowTier: !!opts.lowTier,
    halfShadowApplied: false,
  });
  // What the constructor does: derive autoUpdate from the policy.
  call(r, 'applyShadowPolicy');
  return r;
}

function call(r: Bare, method: string, ...args: unknown[]): unknown {
  const fn = (SimpleRenderer.prototype as unknown as Record<string, (...a: unknown[]) => unknown>)[
    method
  ];
  return fn.apply(r, args);
}

/** Render n frames; returns how many of them ran a shadow pass. */
function run(r: Bare, n: number): number {
  const before = r.shadowPasses;
  for (let i = 0; i < n; i++) call(r, 'render');
  return r.shadowPasses - before;
}

beforeEach(() => {
  delete globalThis.__dsFx;
  // SimpleRenderer registers the lever at module load; another file's
  // fx.reset() must not leave it unregistered here.
  fx.register('halfShadow', { desktop: false, low: true });
});
afterEach(() => {
  delete globalThis.__dsFx;
  fx.setTier(null);
});

describe('half-rate shadows (E2)', () => {
  test('the low tier refreshes the shadow map every other frame by default', () => {
    const r = bare({ lowTier: true });
    expect(r.renderer.shadowMap.autoUpdate).toBe(false);
    expect(run(r, 20)).toBe(10);
  });

  test('desktop stays at full rate, whatever the fx switch says (decision 12)', () => {
    const r = bare({ lowTier: false });
    expect(r.renderer.shadowMap.autoUpdate).toBe(true);
    expect(run(r, 20)).toBe(20);
    globalThis.__dsFx = { halfShadow: true };
    expect(run(r, 20)).toBe(20);
  });

  test('?halfshadow=1 halves it on desktop and ?halfshadow=0 restores full rate on the low tier', () => {
    expect(run(bare({ lowTier: false, param: true }), 20)).toBe(10);
    const low = bare({ lowTier: true, param: false });
    expect(low.renderer.shadowMap.autoUpdate).toBe(true);
    expect(run(low, 20)).toBe(20);
    // The URL wins over the switch in both directions.
    globalThis.__dsFx = { halfShadow: true };
    expect(run(low, 20)).toBe(20);
    globalThis.__dsFx = { halfShadow: false };
    expect(run(bare({ lowTier: false, param: true }), 20)).toBe(10);
  });

  test('turning the lever off mid-page hands the map back at full rate (the --fx off side)', () => {
    const r = bare({ lowTier: true });
    expect(run(r, 10)).toBe(5);
    globalThis.__dsFx = { halfShadow: false };
    // Without the flip check autoUpdate stayed false and nothing re-armed the
    // map: 0 passes, a frozen shadow that read as a saving.
    expect(run(r, 10)).toBe(10);
    expect(r.renderer.shadowMap.autoUpdate).toBe(true);
  });

  test('turning it back on returns to half rate at once: one pass in any two frames', () => {
    // The perf gate's --fx pair is two frames a side, so a refresh forced on
    // the flip would read as 2 passes in 2 frames half the time.
    for (const framesBefore of [1, 2]) {
      // Either phase of the every-other-frame re-arm when the lever goes off.
      delete globalThis.__dsFx;
      const r = bare({ lowTier: true });
      run(r, framesBefore);
      globalThis.__dsFx = { halfShadow: false };
      expect(run(r, 4)).toBe(4);
      globalThis.__dsFx = { halfShadow: true };
      expect(run(r, 2)).toBe(1);
      expect(r.renderer.shadowMap.autoUpdate).toBe(false);
      expect(run(r, 20)).toBe(10);
    }
  });

  test('the interior freeze wins over the lever, in both states and across a flip', () => {
    const r = bare({ lowTier: true });
    call(r, 'setShadowFreeze', true);
    expect(run(r, 10)).toBe(0);
    globalThis.__dsFx = { halfShadow: false };
    expect(run(r, 10)).toBe(0);
    expect(r.renderer.shadowMap.autoUpdate).toBe(false);
    // Unfreezing refreshes once and returns to the lever's rate.
    call(r, 'setShadowFreeze', false);
    expect(run(r, 10)).toBe(10);
    globalThis.__dsFx = { halfShadow: true };
    call(r, 'setShadowFreeze', true);
    call(r, 'setShadowFreeze', false);
    const passes = run(r, 10);
    expect(passes).toBeGreaterThanOrEqual(5);
    expect(passes).toBeLessThanOrEqual(6);
  });

  test('governor rung 2 composes with the lever: half rate either way, no double halving', () => {
    const r = bare({ lowTier: false });
    r.qualityRung = 2;
    call(r, 'applyShadowPolicy');
    expect(run(r, 20)).toBe(10);
    const low = bare({ lowTier: true });
    low.qualityRung = 2;
    call(low, 'applyShadowPolicy');
    expect(run(low, 20)).toBe(10);
  });
});

describe('the governor steps over rungs that shed nothing (E2)', () => {
  const walk = (r: Bare, dir: 1 | -1): number[] => {
    const seen: number[] = [];
    for (let i = 0; i < 4; i++) {
      const next = call(r, 'rungStep', dir) as number;
      if (next < 0 || next > 3 || next === r.qualityRung) break;
      r.qualityRung = next;
      seen.push(next);
    }
    return seen;
  };

  test('desktop walks every rung: bloom, shadows, grass', () => {
    const r = bare({ lowTier: false, bloomPass: true });
    expect(walk(r, 1)).toEqual([1, 2, 3]);
    expect(walk(r, -1)).toEqual([2, 1, 0]);
  });

  test('the low tier goes straight to grass: no bloom pass, shadows already at half rate', () => {
    const r = bare({ lowTier: true });
    expect(walk(r, 1)).toEqual([3]);
    expect(walk(r, -1)).toEqual([0]);
  });

  test('with ?halfshadow=0 the low tier keeps rung 2 as its first lever', () => {
    const r = bare({ lowTier: true, param: false });
    expect(walk(r, 1)).toEqual([2, 3]);
    expect(walk(r, -1)).toEqual([2, 0]);
  });

  test('with ?halfshadow=1 desktop skips rung 2', () => {
    const r = bare({ lowTier: false, param: true, bloomPass: true });
    expect(walk(r, 1)).toEqual([1, 3]);
    expect(walk(r, -1)).toEqual([1, 0]);
  });
});

describe('night bloom stays on the bulbs (P2-E5)', () => {
  const night = SimpleRenderer.BLOOM_NIGHT_THRESHOLD;
  const day = SimpleRenderer.BLOOM_DAY_THRESHOLD;

  /** A bare renderer with a stand-in bloom pass at the day threshold. */
  const withBloom = (
    tier: 'desktop' | 'low' = 'desktop',
  ): Bare & { bloomPass: { threshold: number } } => {
    const r = bare({ lowTier: tier === 'low', bloomPass: true }) as Bare & {
      bloomPass: { threshold: number; enabled: boolean };
    };
    r.bloomPass.threshold = day;
    // applyBloomNight is an instance field (bound once in the constructor),
    // which a bare prototype copy lacks: bind the real method the same way.
    const proto = SimpleRenderer.prototype as unknown as {
      setBloomNight: (d: number) => void;
      writeBloomThreshold: () => void;
    };
    r.bloomNightDay = 1;
    r.applyBloomNight = (): void => proto.writeBloomThreshold.call(r);
    r.setBloomNight = proto.setBloomNight;
    return r;
  };

  beforeEach(() => {
    fx.register('bloomNight', { desktop: true, low: false });
  });

  test('the curve: 0.85 by day, 1.0 at night, a smoothstep between day factors 0.3 and 0.8', () => {
    expect(day).toBe(0.85);
    expect(night).toBe(1.0);
    expect(SimpleRenderer.bloomNightThreshold(1)).toBeCloseTo(0.85, 10);
    expect(SimpleRenderer.bloomNightThreshold(0.8)).toBeCloseTo(0.85, 10);
    expect(SimpleRenderer.bloomNightThreshold(0.3)).toBeCloseTo(1.0, 10);
    expect(SimpleRenderer.bloomNightThreshold(0)).toBeCloseTo(1.0, 10);
    // Halfway through the ramp a smoothstep is at 0.5.
    expect(SimpleRenderer.bloomNightThreshold(0.55)).toBeCloseTo(0.925, 10);
    // The golden hour's day factor (0.198 at 06 and 18 h) is still the night value.
    expect(SimpleRenderer.bloomNightThreshold(0.198)).toBeCloseTo(1.0, 10);
  });

  test('the threshold never leaves [0.85, 1.0] and never rises with the day factor', () => {
    let last = Infinity;
    for (let d = -0.5; d <= 1.5; d += 0.01) {
      const v = SimpleRenderer.bloomNightThreshold(d);
      expect(v).toBeGreaterThanOrEqual(0.85 - 1e-12);
      expect(v).toBeLessThanOrEqual(1.0 + 1e-12);
      expect(v).toBeLessThanOrEqual(last + 1e-12);
      last = v;
    }
  });

  test('setBloomNight writes the curve to the bloom pass on desktop', () => {
    const r = withBloom();
    (r.setBloomNight as (d: number) => void)(0);
    expect(r.bloomPass.threshold).toBeCloseTo(1.0, 10);
    (r.setBloomNight as (d: number) => void)(1);
    expect(r.bloomPass.threshold).toBeCloseTo(0.85, 10);
    (r.setBloomNight as (d: number) => void)(0.55);
    expect(r.bloomPass.threshold).toBeCloseTo(0.925, 10);
  });

  test("with the switch off the threshold stays at today's 0.85 (decision P2-3's alternative)", () => {
    const r = withBloom();
    globalThis.__dsFx = { bloomNight: false };
    (r.setBloomNight as (d: number) => void)(0);
    expect(r.bloomPass.threshold).toBe(0.85);
    // The switch is live: back on, the night value returns.
    globalThis.__dsFx = { bloomNight: true };
    (r.setBloomNight as (d: number) => void)(0);
    expect(r.bloomPass.threshold).toBeCloseTo(1.0, 10);
  });

  test('without a composer (the low tier) it does nothing', () => {
    const r = bare({ lowTier: true });
    const proto = SimpleRenderer.prototype as unknown as { setBloomNight: (d: number) => void };
    expect(() => proto.setBloomNight.call(r, 0)).not.toThrow();
    expect(r.bloomPass).toBeUndefined();
    // Registered off for the low tier, so a composer there would keep 0.85.
    expect(fx.on('bloomNight')).toBe(false);
  });

  test('the lever is timed under its own name with ?perf=1', () => {
    const r = withBloom();
    fx.setPerf(true);
    try {
      (r.setBloomNight as (d: number) => void)(0);
      (r.setBloomNight as (d: number) => void)(0);
      expect(globalThis.__dsFx?.stats?.bloomNight?.calls).toBe(2);
    } finally {
      fx.setPerf(null);
    }
  });

  test('the source: registered desktop-only, one bound method, the day constant reused', () => {
    const s = readFileSync(join(process.cwd(), 'SimpleRenderer.ts'), 'utf8');
    expect(s).toContain("fx.register('bloomNight', { desktop: true, low: false });");
    expect(s).toContain("fx.time('bloomNight', this.applyBloomNight);");
    expect(s).toContain(
      'private readonly applyBloomNight = (): void => this.writeBloomThreshold();',
    );
    expect(s).toContain('THREE.MathUtils.smoothstep(day, 0.3, 0.8)');
    // The pass is built at the day threshold, and nothing else writes it.
    expect(s).toContain('SimpleRenderer.BLOOM_DAY_THRESHOLD, // threshold');
    expect(s.match(/\.threshold = /g) ?? []).toHaveLength(1);
  });
});
