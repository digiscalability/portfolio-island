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

// CO-E2 review: programs ride the boot race (s1-int desktop: 154 on 19 of 48
// A/A loads, 165 or 166 on the rest), so a per-side median jumps by the whole
// gap when the two sides land in different modes. Programs are judged on the
// race's mix instead, and every counter's floor is its resampled A/A spread.
describe('perf gate: the boot-race mix and the counter floors (CO-E2)', () => {
  type Row = {
    verdict: string;
    delta: number;
    sigma: number | null;
    stratified?: boolean;
    thresholdUsed?: number;
    withinThreshold?: boolean;
  };
  const gate = createRequire(import.meta.url)('../tools/perf-gate.cjs') as {
    judgeCounter: (
      a: number[],
      b: number[],
      t: number | null,
      floor?: number | null,
      o?: { cycles?: number },
    ) => Row;
    judgeMixCounter: (
      a: number[],
      b: number[],
      ma: number[],
      mb: number[],
      t: number | null,
      floor?: number | null,
      o?: { cycles?: number; name?: string },
    ) => Row;
    mixValue: (values: number[], modes: number[]) => number | null;
    aaSpread: (
      x: { a: number[]; b: number[]; ma?: number[] | null; mb?: number[] | null },
      o?: { name?: string; n?: number; resamples?: number },
    ) => number | null;
    metricTable: (
      prof: string,
      a: Array<Record<string, unknown>>,
      b: Array<Record<string, unknown>>,
      floor?: unknown,
      o?: { cycles?: number },
    ) => Record<string, Row & { rule?: string }>;
    floorQuiet: (floor: unknown) => { known: boolean; busy: string[] };
  };
  // The builder's 48 desktop A/A loads on s1-int, programs 30 s after the card.
  const A = [
    154, 154, 154, 154, 165, 165, 165, 166, 165, 165, 165, 165, 165, 165, 154, 165, 165, 154, 154,
    154, 165, 154, 154, 154,
  ];
  const B = [
    165, 154, 154, 165, 165, 154, 165, 165, 165, 166, 165, 165, 165, 154, 166, 165, 154, 165, 154,
    165, 166, 165, 154, 154,
  ];
  const pool = [...A, ...B];
  // A seeded resampler for the test's own A/As.
  const lcg = (seed: number) => {
    let s = seed;
    return () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
  };

  test("a side's mix value moves with the mode mix, not by the whole gap", () => {
    // 12 early and 12 late: the median sits between the modes (159.5).
    const half = [...Array(12).fill(154), ...Array(12).fill(165)];
    expect(gate.mixValue(half, half)).toBeCloseTo(159.5, 6);
    // 13 late: the median jumps to 165; the mix value moves by 11/24.
    const more = [...Array(11).fill(154), ...Array(13).fill(165)];
    expect(gate.mixValue(more, more)).toBeCloseTo(154 + (11 * 13) / 24, 6);
  });

  test("the review's A/A: per-side medians fail 'programs' in about 1 of 6 resamples; the mix almost never", () => {
    const draw = (rnd: () => number) =>
      Array.from({ length: 24 }, () => pool[Math.floor(rnd() * 48)]);
    const rnd = lcg(48);
    let medianFails = 0;
    let mixFails = 0;
    let mixOutside = 0;
    const runs = 200;
    for (let r = 0; r < runs; r++) {
      const a = draw(rnd);
      const b = draw(rnd);
      // The committed floor for this counter was its paired sigma, 3.6.
      if (gate.judgeCounter(a, b, 5, 3.6, { cycles: 24 }).verdict === 'fail') medianFails++;
      const m = gate.judgeMixCounter(a, b, a, b, 5, null, { cycles: 24, name: 't' });
      if (m.verdict === 'fail') mixFails++;
      if (!m.withinThreshold) mixOutside++;
    }
    expect(medianFails / runs).toBeGreaterThan(0.08);
    // The mix's A/A spread: about 11 x 0.14 = 1.6 programs (sd), so |delta|
    // over 5 is about 1 in 800.
    expect(mixFails / runs).toBeLessThanOrEqual(0.01);
    expect(mixOutside / runs).toBeLessThanOrEqual(0.01);
  });

  test('a real regression still fails on the mix: +6 programs in every load, or a race always lost', () => {
    const plus6 = B.map((x) => x + 6);
    expect(gate.judgeMixCounter(A, plus6, A, plus6, 5, null, { cycles: 24 }).verdict).toBe('fail');
    // B always lands in the late mode, 6 programs higher still: +11 on the mix.
    const late = B.map(() => 171);
    expect(gate.judgeMixCounter(A, late, A, late, 5, null, { cycles: 24 }).verdict).toBe('fail');
    // An improvement of any size passes.
    const fewer = B.map((x) => x - 40);
    expect(gate.judgeMixCounter(A, fewer, A, fewer, 5, null, { cycles: 6 }).verdict).toBe('pass');
  });

  test("a counter's floor is the 99th percentile of its resampled A/A spread, the same on every run", () => {
    const mixFloor = gate.aaSpread({ a: A, b: B, ma: A, mb: B }, { name: 'desktop:programs' });
    const medianFloor = gate.aaSpread({ a: A, b: B }, { name: 'desktop:programs' });
    expect(gate.aaSpread({ a: A, b: B, ma: A, mb: B }, { name: 'desktop:programs' })).toBe(
      mixFloor,
    );
    // On the per-side median the spread is the whole gap: such a floor would
    // hide a +10 regression. On the mix it stays under T (5).
    expect(medianFloor).toBeGreaterThanOrEqual(10);
    expect(mixFloor).toBeGreaterThan(1);
    expect(mixFloor).toBeLessThan(5);
  });

  test('metricTable judges both programs rows on the mix', () => {
    const cyc = (p: number) => ({
      views: {},
      programs: p,
      programsAfterViews: p + 2,
      nodes: 7400,
      textureMB: 18.5,
      welcomeMs: 5000,
      worldGenMs: 1400,
      longestTaskBeforeCardMs: 300,
      longTasksBeforeCard: 4,
      bytesBeforeCardKB: 811,
    });
    const rows = gate.metricTable('desktop', A.map(cyc), B.map(cyc), null, { cycles: 24 });
    for (const k of ['programs (30 s after the card)', 'programs after the views']) {
      expect(rows[k].stratified).toBe(true);
      expect(rows[k].rule).toMatch(/boot-race mix/);
      expect(rows[k].verdict).toBe('pass');
    }
  });

  test('a floor recorded on a busy host is marked, and the gate says so', () => {
    const q = { recorded: { quiet: { desktop: true, lowtier: false } } };
    expect(gate.floorQuiet(q)).toEqual({ known: true, busy: ['lowtier'] });
    expect(gate.floorQuiet({ recorded: {} })).toEqual({ known: false, busy: [] });
  });
});

// Wave-1 integration: the A/B could not reach PASS on this rig, and its
// welcome_visible rule could not catch a +341 ms shift. A paired sign test
// fails a shift above T that the pairs agree on, however wide sigma is, and
// CPU p95 still over T/2 at 24 cycles is judged by the FxBudget proxy.
describe('perf gate: the sign test and the 24-cycle CPU proxy (wave-1 integration)', () => {
  type Row = {
    verdict: string;
    delta: number;
    sigma: number | null;
    valid?: boolean;
    rule?: string;
    unresolvable?: string;
    directVerdict?: string;
    sign?: { over: number; n: number; needed: number | null; fail: boolean };
    strata?: Record<string, unknown>;
  };
  type Cycle = Record<string, unknown>;
  const gate = createRequire(import.meta.url)('../tools/perf-gate.cjs') as {
    SIGN_ALPHA: number;
    signCritical: (n: number, alpha?: number) => number | null;
    judge: (a: number[], b: number[], threshold: number | null) => Row;
    stratify: (
      a: number[],
      b: number[],
      ma: number[],
      mb: number[],
    ) => { a: number[]; b: number[]; stratified: boolean; strata: Record<string, unknown> };
    metricTable: (
      prof: string,
      a: Cycle[],
      b: Cycle[],
      floor?: unknown,
      o?: { cycles?: number },
    ) => Record<string, Row>;
  };
  const lcg = (seed: number) => {
    let s = seed;
    return () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
  };
  const gauss = (seed: number) => {
    const u = lcg(seed);
    return () => Math.sqrt(-2 * Math.log(u() || 1e-9)) * Math.cos(2 * Math.PI * u());
  };

  test('the sign test fails at 8 of 8, 11 of 12 and 19 of 24, never at 6', () => {
    expect(gate.SIGN_ALPHA).toBe(0.005);
    expect(gate.signCritical(6)).toBeNull();
    expect(gate.signCritical(8)).toBe(8);
    expect(gate.signCritical(12)).toBe(11);
    expect(gate.signCritical(24)).toBe(19);
    // At the sigma band's own 2.5% it would be 6 of 6, 10 of 12, 18 of 24.
    expect([6, 12, 24].map((n) => gate.signCritical(n, 0.025))).toEqual([6, 10, 18]);
  });

  // The integration's 24 desktop pairs (verify/perf/ab): main in three
  // boot-race modes (154 and 158 programs, ~650 ms faster than 165), the
  // build in one (160).
  const mainWelcome = [
    5431, 5400, 4694, 5361, 4685, 5266, 5313, 5304, 5327, 5320, 5324, 5338, 5443, 5300, 5327, 4700,
    5292, 5248, 5345, 5265, 5418, 4589, 5332, 4633,
  ];
  const mainProgs = [
    165, 165, 154, 165, 158, 165, 165, 165, 165, 165, 165, 165, 166, 165, 165, 154, 165, 165, 165,
    165, 165, 154, 165, 154,
  ];
  const intWelcome = [
    5699, 5761, 5669, 5701, 5573, 5576, 5572, 5599, 5628, 5618, 5666, 5713, 5630, 5613, 5685, 5584,
    5657, 5661, 5613, 5669, 5536, 5512, 5613, 5618,
  ];
  const intProgs = mainProgs.map(() => 160);

  test('the +341 ms welcome_visible of wave 1 fails by the sign test, though sigma is over T/2', () => {
    const st = gate.stratify(mainWelcome, intWelcome, mainProgs, intProgs);
    // One side in one mode: no like-with-like pairs, and the strata say so.
    expect(st.stratified).toBe(false);
    expect(st.strata).toMatchObject({ modesA: { early: 5, late: 19 }, modesB: { one: 24 } });
    const r = gate.judge(st.a, st.b, 150);
    expect(r.delta).toBe(341);
    expect(r.valid).toBe(false);
    expect(r.sign).toMatchObject({ over: 23, n: 24, needed: 19, fail: true });
    expect(r.verdict).toBe('fail');
    // At 12 cycles too (12 of 12 over T); at 6 the test cannot fail, so the run escalates.
    expect(gate.judge(st.a.slice(0, 12), st.b.slice(0, 12), 150).verdict).toBe('fail');
    expect(gate.judge(st.a.slice(0, 6), st.b.slice(0, 6), 150).verdict).toBe('inconclusive');
    // The same loads with the build 500 ms faster: only main's five early-mode
    // pairs are still over T, far short of 19, so the sign test stays quiet.
    const faster = intWelcome.map((x) => x - 500);
    expect(gate.judge(mainWelcome, faster, 150).sign).toMatchObject({ over: 5, fail: false });
  });

  test('A/A with noise as large as T never fails (1,000 runs each of 6, 12 and 24 cycles)', () => {
    const g = gauss(4111);
    let fails = 0;
    for (let run = 0; run < 1000; run++) {
      for (const n of [6, 12, 24]) {
        const a = Array.from({ length: n }, () => 5000 + 150 * g());
        const b = Array.from({ length: n }, () => 5000 + 150 * g());
        if (gate.judge(a, b, 150).verdict === 'fail') fails++;
      }
    }
    expect(fails).toBe(0);
  });

  test('a shift of 2 x T on a bimodal side fails; a shift of T / 2 does not fail by sign', () => {
    const g = gauss(99);
    const modeA = Array.from({ length: 24 }, (_, i) => (i % 4 === 0 ? 4650 : 5300));
    const a = modeA.map((x) => x + 20 * g());
    // Pairs in cycle order across the modes: sigma is wide, every pair over T.
    const shifted = a.map((x, i) => (i % 4 === 0 ? 5300 : x) + 300 + 20 * g());
    const r = gate.judge(a, shifted, 150);
    expect(r.valid).toBe(false);
    expect(r.verdict).toBe('fail');
    expect(
      gate.judge(
        a,
        a.map((x) => x + 75 + 20 * g()),
        150,
      ).sign?.fail,
    ).toBe(false);
  });

  const cyc = (cpuP95: number, us: Record<string, number>): Cycle => {
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
      views: { spawn: view(-0.1), hub: view(-0.62), projects: view(-0.38) },
      programs: 160,
      programsAfterViews: 160,
      nodes: 7400,
      textureMB: 18.5,
      welcomeMs: 5000,
      worldGenMs: 1400,
      longestTaskBeforeCardMs: 300,
      longTasksBeforeCard: 4,
      bytesBeforeCardKB: 811,
    };
  };
  // CPU p95 whose pairs straddle T: sigma over T/2, delta within T.
  const noisy = (n: number, us: Record<string, number>) => {
    const g = gauss(7);
    const a = Array.from({ length: n }, () => cyc(17 + 1.6 * g(), us));
    const b = Array.from({ length: n }, () => cyc(17 + 1.6 * g(), us));
    return { a, b };
  };

  test('CPU p95 with sigma over T/2 at 24 cycles is judged by the FxBudget proxy, and says so', () => {
    const { a, b } = noisy(24, { guide: 5 });
    const rows = gate.metricTable('desktop', a, b, null, { cycles: 24 });
    const hub = rows['hub: CPU p95 ms'];
    expect(hub.valid).toBe(false);
    expect(hub.directVerdict).toBe('inconclusive');
    expect(hub.rule).toMatch(/proxy: FxBudget/);
    expect(hub.unresolvable).toMatch(/sigma .* > T\/2 0.5 at 24 cycles/);
    expect(hub.verdict).toBe('pass');
    // An effect over its budget on side B fails it.
    const hot = noisy(24, { guide: 400 });
    expect(
      gate.metricTable('desktop', hot.a, hot.b, null, { cycles: 24 })['hub: CPU p95 ms'].verdict,
    ).toBe('fail');
    // Before 24 cycles the run escalates instead.
    const twelve = gate.metricTable('desktop', a.slice(0, 12), b.slice(0, 12), null, {
      cycles: 12,
    });
    expect(twelve['hub: CPU p95 ms'].verdict).toBe('inconclusive');
    // No FxBudget timings on side B (main registers none): the proxy cannot stand in.
    const bare = noisy(24, {});
    const r = gate.metricTable('desktop', bare.a, bare.b, null, { cycles: 24 })['hub: CPU p95 ms'];
    expect(r.verdict).toBe('inconclusive');
    expect(r.unresolvable).toBeUndefined();
  });

  test('the sign test fails a timing the floor rule would only report', () => {
    const a = Array.from({ length: 24 }, (_, i) => cyc(16 + (i % 3), { guide: 5 }));
    const b = a.map((c) => ({ ...c, worldGenMs: 1400 + 80 }));
    const floor = { profiles: { desktop: { 'world_gen ms': 30 } } };
    const r = gate.metricTable('desktop', a, b, floor, { cycles: 24 })['world_gen ms'];
    expect(r.unresolvable).toMatch(/T 50 < 2 x floor 30/);
    expect(r.rule).toMatch(/sign test: 24 of 24 pairs over T/);
    expect(r.verdict).toBe('fail');
  });
});
