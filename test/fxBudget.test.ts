// FxBudget: the per-effect switch and stopwatch every new per-frame effect uses
// (stage-1 item E1). The perf gate toggles effects through __dsFx and reads
// __dsFx.stats, so these semantics are its contract.
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
