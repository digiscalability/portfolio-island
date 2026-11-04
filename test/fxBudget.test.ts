// FxBudget: the per-effect switch and stopwatch every new per-frame effect uses
// (stage-1 item E1). The perf gate toggles effects through __dsFx and reads
// __dsFx.stats, so these semantics are its contract.
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { fx } from '../FxBudget';
import { SimpleRenderer } from '../SimpleRenderer';

beforeEach(() => {
  fx.reset();
  delete globalThis.__dsFx;
});
afterEach(() => {
  fx.reset();
  delete globalThis.__dsFx;
  vi.restoreAllMocks();
});

describe('register and tier defaults', () => {
  test('the default follows the tier', () => {
    fx.register('halfShadow', { desktop: false, low: true });
    fx.setTier('desktop');
    expect(fx.on('halfShadow')).toBe(false);
    fx.setTier('low');
    expect(fx.on('halfShadow')).toBe(true);
  });

  test('tier detection agrees with SimpleRenderer.isLowTierDevice in every case', () => {
    // FxBudget imports nothing (no cycle when SimpleRenderer registers its own
    // levers), so it carries the renderer's rule; this pins that they agree.
    const cases: Array<{ coarse: boolean | null; cores: number }> = [
      { coarse: null, cores: 16 },
      { coarse: false, cores: 8 },
      { coarse: true, cores: 8 },
      { coarse: false, cores: 4 },
      { coarse: false, cores: 2 },
      { coarse: true, cores: 2 },
    ];
    for (const c of cases) {
      vi.unstubAllGlobals();
      if (c.coarse === null) vi.stubGlobal('matchMedia', undefined);
      else vi.stubGlobal('matchMedia', () => ({ matches: c.coarse }));
      vi.stubGlobal('navigator', { hardwareConcurrency: c.cores });
      fx.setTier(null);
      const renderer = SimpleRenderer.isLowTierDevice() ? 'low' : 'desktop';
      expect(fx.tier(), JSON.stringify(c)).toBe(renderer);
    }
    vi.unstubAllGlobals();
  });

  test('registering publishes the ledger on __dsFx.effects', () => {
    fx.register('coinGlint', { desktop: true, low: true });
    fx.register('phoneInk', { desktop: true, low: false });
    expect(globalThis.__dsFx?.effects).toEqual({
      coinGlint: { desktop: true, low: true },
      phoneInk: { desktop: true, low: false },
    });
    fx.setTier('low');
    expect(fx.registered()).toEqual([
      { name: 'coinGlint', defaults: { desktop: true, low: true }, on: true },
      { name: 'phoneInk', defaults: { desktop: true, low: false }, on: false },
    ]);
  });

  test('re-registering replaces the defaults', () => {
    fx.setTier('desktop');
    fx.register('dust', { desktop: false, low: false });
    fx.register('dust', { desktop: true, low: false });
    expect(fx.on('dust')).toBe(true);
  });

  test('an unregistered effect is off', () => {
    expect(fx.on('nobodyRegisteredThis')).toBe(false);
  });
});

describe('on(): __dsFx overrides the default', () => {
  test('a boolean in __dsFx wins over the tier default, both ways', () => {
    fx.setTier('desktop');
    fx.register('canopySway', { desktop: true, low: true });
    globalThis.__dsFx = { ...globalThis.__dsFx, canopySway: false };
    expect(fx.on('canopySway')).toBe(false);
    globalThis.__dsFx.canopySway = true;
    fx.register('camRays', { desktop: false, low: false });
    globalThis.__dsFx.camRays = true;
    expect(fx.on('camRays')).toBe(true);
  });

  test('the switch is live: a toggle is seen on the next call', () => {
    fx.setTier('low');
    fx.register('npcGait', { desktop: true, low: true });
    expect(fx.on('npcGait')).toBe(true);
    globalThis.__dsFx!.npcGait = false;
    expect(fx.on('npcGait')).toBe(false);
    delete globalThis.__dsFx!.npcGait;
    expect(fx.on('npcGait')).toBe(true);
  });

  test('non-boolean values do not override', () => {
    fx.setTier('desktop');
    fx.register('idleLife', { desktop: true, low: false });
    globalThis.__dsFx!.idleLife = 'off';
    expect(fx.on('idleLife')).toBe(true);
  });

  test('a switch set before any registration (a probe init script) is kept', () => {
    globalThis.__dsFx = { lookFling: false };
    fx.register('lookFling', { desktop: true, low: true });
    expect(fx.on('lookFling')).toBe(false);
    expect(globalThis.__dsFx.lookFling).toBe(false);
  });
});

describe('time()', () => {
  test('without ?perf=1 it runs fn directly: no clock read, no stats', () => {
    fx.setPerf(false);
    const now = vi.spyOn(performance, 'now');
    let ran = 0;
    const out = fx.time('dust', () => {
      ran++;
      return 42;
    });
    expect(out).toBe(42);
    expect(ran).toBe(1);
    expect(now).not.toHaveBeenCalled();
    expect(globalThis.__dsFx?.stats).toBeUndefined();
  });

  test('with perf on it adds the call µs to __dsFx.stats[name]', () => {
    fx.setPerf(true);
    const ticks = [1000, 1000.25, 2000, 2000.1];
    vi.spyOn(performance, 'now').mockImplementation(() => ticks.shift() ?? 0);
    fx.time('coinGlint', () => undefined);
    fx.time('coinGlint', () => undefined);
    const s = globalThis.__dsFx?.stats?.coinGlint;
    expect(s?.calls).toBe(2);
    expect(s?.us).toBeCloseTo(350, 6);
    expect(s?.maxUs).toBeCloseTo(250, 6);
  });

  test('a throwing fn is still timed, and the error propagates', () => {
    fx.setPerf(true);
    expect(() =>
      fx.time('wave', () => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(globalThis.__dsFx?.stats?.wave?.calls).toBe(1);
  });

  test('?perf=1 in the URL turns accounting on', () => {
    vi.stubGlobal('location', { search: '?owner=1&perf=1' });
    fx.setPerf(null);
    fx.time('squash', () => undefined);
    expect(globalThis.__dsFx?.stats?.squash?.calls).toBe(1);
    vi.unstubAllGlobals();
  });

  test('a URL without perf=1 leaves accounting off', () => {
    vi.stubGlobal('location', { search: '?owner=1' });
    fx.setPerf(null);
    fx.time('squash', () => undefined);
    expect(globalThis.__dsFx?.stats).toBeUndefined();
    vi.unstubAllGlobals();
  });
});

// The perf gate's verdict maths (tools/perf-gate.cjs), which every package's
// --ab acceptance reads. delta is the median paired (B - A) difference, sigma
// its 95% band over both sides; an invalid result (sigma > threshold/2) is
// inconclusive and never fails, so an A/A run cannot fail on noise.
describe('perf gate verdict maths', () => {
  type Row = { verdict: string; delta: number; sigma: number | null; valid?: boolean };
  const gate = createRequire(import.meta.url)('../tools/perf-gate.cjs') as {
    judge: (a: number[], b: number[], threshold: number | null) => Row;
    aaSummary: (profiles: Record<string, unknown>) => {
      exactCountersEqual: boolean;
      outsideThreshold: Array<{ metric: string }>;
      verdictNeverFail: boolean;
    };
  };
  // Seeded Gaussian noise, so every run of this test sees the same numbers.
  const noise = (seed: number) => {
    let s = seed;
    const u = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
    return () => Math.sqrt(-2 * Math.log(u() || 1e-9)) * Math.cos(2 * Math.PI * u());
  };

  const plus = (a: number[], k: number) => a.map((x) => x + k);

  test('an exact counter passes at its threshold and fails one past it', () => {
    const a = [626, 626, 626, 626, 626, 626];
    expect(gate.judge(a, a, 0)).toMatchObject({ verdict: 'pass', delta: 0, sigma: 0 });
    expect(gate.judge(a, plus(a, 2), 2).verdict).toBe('pass');
    expect(gate.judge(a, plus(a, 3), 2).verdict).toBe('fail');
  });

  test('a noisy result is inconclusive even when delta is over the threshold', () => {
    const a = [10.8, 14.0, 10.9, 13.8, 12.4, 12.3];
    const b = [13.1, 11.2, 15.0, 12.1, 14.6, 12.9];
    const r = gate.judge(a, b, 0.5);
    expect(r.delta).toBeGreaterThan(0.5 + 0.1);
    expect(r.valid).toBe(false);
    expect(r.verdict).toBe('inconclusive');
  });

  test('pairing cancels drift that both sides share', () => {
    const a = [6, 7.5, 9, 10.5, 12, 13.5];
    const r = gate.judge(a, plus(a, 0.1), 0.5);
    expect(r.verdict).toBe('pass');
    expect(r.delta).toBeCloseTo(0.1, 6);
  });

  test('a real regression beyond the band fails', () => {
    const g = noise(7);
    const a = Array.from({ length: 12 }, () => 14 + 0.1 * g());
    const b = a.map((x) => x + 2 + 0.1 * g());
    expect(gate.judge(a, b, 1).verdict).toBe('fail');
  });

  test('A/A over noise as large as the threshold never fails (1,000 runs of 6, 12 and 24 cycles)', () => {
    const g = noise(20261104);
    let fails = 0;
    for (let run = 0; run < 1000; run++) {
      for (const n of [6, 12, 24]) {
        const a = Array.from({ length: n }, () => 14 + g());
        const b = Array.from({ length: n }, () => 14 + g());
        if (gate.judge(a, b, 1).verdict === 'fail') fails++;
      }
    }
    expect(fails).toBe(0);
  });

  test('the A/A summary flags an exact counter that moved and a delta over its threshold', () => {
    const aa = gate.aaSummary({
      desktop: {
        verdict: 'inconclusive',
        metrics: {
          'texture MB': { kind: 'exact', range: [18.1, 18.2] },
          'projects: draws': { kind: 'counter', threshold: 0, withinThreshold: false, delta: 1 },
        },
      },
    });
    expect(aa.exactCountersEqual).toBe(false);
    expect(aa.outsideThreshold.map((x) => x.metric)).toEqual(['projects: draws']);
    expect(aa.verdictNeverFail).toBe(true);
  });
});

// CO-E2: the gate judged by plan-r3's budget, its recorded floors, the CPU
// proxy and the boot race's modes.
describe('perf gate budgets, floors and proxies (CO-E2)', () => {
  type Row = {
    verdict: string;
    delta?: number;
    rule?: string;
    unresolvable?: string;
    thresholdUsed?: number;
    withinThreshold?: boolean;
    stratified?: boolean;
  };
  type Cycle = Record<string, unknown>;
  const gate = createRequire(import.meta.url)('../tools/perf-gate.cjs') as {
    THRESHOLDS: Record<string, Record<string, number>>;
    FX_US: Record<string, number>;
    judgeCounter: (
      a: number[],
      b: number[],
      t: number | null,
      floor?: number | null,
      o?: { cycles?: number },
    ) => Row;
    judgeExact: (a: number[], b: number[], t: number | null) => Row;
    bootModes: (p: Array<number | null>) => Array<string | null>;
    stratify: (
      a: number[],
      b: number[],
      ma: number[],
      mb: number[],
    ) => { a: number[]; b: number[]; stratified: boolean };
    cpuProxy: (prof: string, cyclesB: Cycle[]) => { verdict: string; sum?: number };
    metricTable: (
      prof: string,
      a: Cycle[],
      b: Cycle[],
      floor?: unknown,
      o?: { cycles?: number },
    ) => Record<string, Row>;
    poseCheck: (a: Cycle[], b: Cycle[]) => { equal: boolean };
  };

  test("the thresholds are plan-r3's perfBudget", () => {
    expect(gate.THRESHOLDS.desktop).toMatchObject({
      cpuP95: 1.0,
      gpuP50: 2.0,
      drawsSpawn: 50,
      drawsHub: 80,
      drawsProjects: 60,
      programs: 5,
      welcomeMs: 150,
      worldGenMs: 50,
      longTasksBeforeCard: 1,
      bytesBeforeCardKB: 50,
    });
    expect(gate.THRESHOLDS.lowtier).toMatchObject({
      cpuP95: 0.75,
      drawsSpawn: 20,
      drawsHub: 30,
      drawsProjects: 25,
      programs: 3,
      nodes: 150,
      textureMB: 6,
    });
    expect(gate.THRESHOLDS.startup).toMatchObject({
      welcomeMs: 400,
      worldGenMs: 200,
      longTasksBeforeCard: 2,
    });
    expect(gate.FX_US).toEqual({ desktop: 150, lowtier: 80, totalDesktop: 600, totalLowtier: 300 });
  });

  test('a counter passes within max(T, floor), on the per-side medians', () => {
    const a = [212, 215, 212, 215, 212, 215];
    expect(gate.judgeCounter(a, a, 5).verdict).toBe('pass');
    // A delta of 4 against T 3 with no noise fails at once; a recorded floor of 4 lets it pass.
    const b = a.map((x) => x + 4);
    expect(gate.judgeCounter(a, b, 3, null, { cycles: 6 }).verdict).toBe('fail');
    // Noise that straddles the threshold escalates instead of failing early.
    const noisy = [219, 216, 222, 215, 221, 217];
    expect(gate.judgeCounter(a, noisy, 3, null, { cycles: 6 }).verdict).toBe('inconclusive');
    expect(gate.judgeCounter(a, b, 3, 4, { cycles: 6 })).toMatchObject({
      verdict: 'pass',
      thresholdUsed: 4,
    });
    // Past max(T, floor) at 24 cycles it fails; an improvement always passes.
    expect(gate.judgeCounter(a, b, 3, null, { cycles: 24 }).verdict).toBe('fail');
    expect(
      gate.judgeCounter(
        a,
        a.map((x) => x - 50),
        3,
      ).verdict,
    ).toBe('pass');
    expect(
      gate.judgeCounter(
        a,
        a.map((x) => x - 50),
        3,
      ).withinThreshold,
    ).toBe(false);
  });

  test('texture MB stays exact', () => {
    const a = [18.1, 18.1, 18.1];
    expect(gate.judgeExact(a, a, 6).verdict).toBe('pass');
    expect(
      gate.judgeExact(
        a,
        a.map((x) => x + 7),
        6,
      ).verdict,
    ).toBe('fail');
  });

  test("the boot race splits each side at its own programs' midpoint", () => {
    expect(gate.bootModes([212, 215, 212, 215])).toEqual(['early', 'late', 'early', 'late']);
    expect(gate.bootModes([165, 165, 166])).toEqual(['one', 'one', 'one']);
    // Like with like: a late-mode card is never compared with an early one.
    const welcome = gate.stratify(
      [5000, 5600, 5000, 5600],
      [5600, 5000, 5600, 5000],
      [212, 215, 212, 215],
      [215, 212, 215, 212],
    );
    expect(welcome.stratified).toBe(true);
    expect(welcome.a).toEqual([5000, 5000, 5600, 5600]);
    expect(welcome.b).toEqual([5000, 5000, 5600, 5600]);
  });

  const cycle = (cpuP95: number, us: Record<string, number>, pitch = -0.62): Cycle => {
    const view = (p: number) => ({
      cpuP50: 7,
      cpuP95,
      gpuP50: 5,
      draws: 700,
      triangles: 1e6,
      fxUsPerFrame: us,
      pose: { camPitch: -p, ocPitch: p },
    });
    return {
      views: { spawn: view(-0.1), hub: view(pitch), projects: view(-0.38) },
      programs: 212,
      programsAfterViews: 214,
      nodes: 7400,
      textureMB: 18.1,
      welcomeMs: 5000,
      worldGenMs: 1400,
      longestTaskBeforeCardMs: 300,
      longTasksBeforeCard: 6,
      bytesBeforeCardKB: 811,
    };
  };

  test('a CPU budget under 2 x its floor is judged by the FxBudget proxy, and the report says so', () => {
    const a = Array.from({ length: 6 }, (_, i) => cycle(16 + (i % 2), { lookFling: 4 }));
    const floor = { profiles: { desktop: { 'spawn: CPU p95 ms': 0.9 } } };
    const rows = gate.metricTable('desktop', a, a, floor, { cycles: 6 });
    const cpu = rows['spawn: CPU p95 ms'];
    expect(cpu.unresolvable).toMatch(/T 1 < 2 x floor 0.9/);
    expect(cpu.rule).toMatch(/proxy: FxBudget/);
    expect(cpu.verdict).toBe('pass');
    // Over budget on the B side: the proxy fails.
    const hot = Array.from({ length: 6 }, () => cycle(16, { lookFling: 400 }));
    expect(gate.metricTable('desktop', a, hot, floor)['spawn: CPU p95 ms'].verdict).toBe('fail');
    expect(gate.cpuProxy('lowtier', hot).verdict).toBe('fail');
    // A timing with no proxy is reported, never judged.
    const gfloor = { profiles: { desktop: { 'world_gen ms': 30 } } };
    expect(gate.metricTable('desktop', a, a, gfloor)['world_gen ms']).toMatchObject({
      verdict: 'n/a',
    });
  });

  test('the pose check holds the hub and Projects pitch to 0.01 rad', () => {
    const a = Array.from({ length: 4 }, () => cycle(16, {}));
    expect(gate.poseCheck(a, a).equal).toBe(true);
    // Stage 1's fake saving: s1-int eased to -0.12 rad against main's -0.62.
    const eased = Array.from({ length: 4 }, () => cycle(16, {}, -0.12));
    expect(gate.poseCheck(a, eased).equal).toBe(false);
  });
});
