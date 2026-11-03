/**
 * FxBudget: one switch and one stopwatch for every new per-frame effect.
 *
 * - `fx.register(name, { desktop, low })` sets the effect's tier defaults (the
 *   perf ledger's tier column). Effects register from their own modules, so
 *   this file never changes per effect.
 * - `fx.on(name)` is the effect's switch: `globalThis.__dsFx[name]` (a boolean
 *   set by the perf gate, a probe or the console) overrides the tier default.
 *   It is read every call, so a runtime toggle takes effect on the next frame.
 * - `fx.time(name, fn)` runs `fn`. With `?perf=1` it also adds the call's µs
 *   to `globalThis.__dsFx.stats[name]`; without it, `fn` is called directly
 *   and nothing else happens (no clock read, no allocation).
 *
 * The perf gate (tools/perf-gate.cjs) reads `__dsFx.stats` deltas over a
 * measurement window and divides by the frames it counted there, which gives
 * µs per rendered frame even when the low-tier frame limiter skips rAF ticks.
 * `__dsFx.effects` lists what registered, for the gate's ledger table.
 *
 * This module imports nothing, so any module (SimpleRenderer included) can
 * register an effect at load time without an import cycle.
 */

export type FxTier = 'desktop' | 'low';

export interface FxDefaults {
  desktop: boolean;
  low: boolean;
}

export interface FxStat {
  /** Calls timed so far. */
  calls: number;
  /** Total microseconds spent inside fn. */
  us: number;
  /** The slowest single call, in microseconds. */
  maxUs: number;
}

export interface DsFxGlobal {
  /** Per-effect switches: `true`/`false` override the tier default. */
  [name: string]: unknown;
  /** µs accounting, filled only with ?perf=1. */
  stats?: Record<string, FxStat>;
  /** Registered effects and their tier defaults (the ledger). */
  effects?: Record<string, FxDefaults>;
}

// FxBudget owns this global (declared here, not in global.d.ts, so no other
// package has to edit a shared file to use it).
declare global {
  var __dsFx: DsFxGlobal | undefined;
}

const registry = new Map<string, FxDefaults>();
let tierOverride: FxTier | null = null;
let tierCache: FxTier | null = null;
let perfOverride: boolean | null = null;
let perfCache: boolean | null = null;

function globalFx(): DsFxGlobal {
  const g = globalThis.__dsFx;
  if (g && typeof g === 'object') return g;
  const fresh: DsFxGlobal = {};
  globalThis.__dsFx = fresh;
  return fresh;
}

/** The renderer's tier rule (SimpleRenderer.isLowTierDevice): a coarse
 *  pointer or 4 cores or fewer. test/fxBudget.test.ts pins that they agree. */
function detectTier(): FxTier {
  const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  const cores = (typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : undefined) || 8;
  return coarse || cores <= 4 ? 'low' : 'desktop';
}

function currentTier(): FxTier {
  if (tierOverride) return tierOverride;
  if (!tierCache) tierCache = detectTier();
  return tierCache;
}

function perfEnabled(): boolean {
  if (perfOverride !== null) return perfOverride;
  if (perfCache === null) {
    perfCache =
      typeof location !== 'undefined' && new URLSearchParams(location.search).get('perf') === '1';
  }
  return perfCache;
}

function record(name: string, us: number): void {
  const g = globalFx();
  const stats = (g.stats ??= {});
  const s = (stats[name] ??= { calls: 0, us: 0, maxUs: 0 });
  s.calls += 1;
  s.us += us;
  if (us > s.maxUs) s.maxUs = us;
}

export const fx = {
  /** Declare an effect and its tier defaults. Re-registering replaces them. */
  register(name: string, defaults: FxDefaults): void {
    registry.set(name, { desktop: !!defaults.desktop, low: !!defaults.low });
    const g = globalFx();
    (g.effects ??= {})[name] = { desktop: !!defaults.desktop, low: !!defaults.low };
  },

  /** Is the effect on? A boolean in globalThis.__dsFx[name] wins; else the tier default. */
  on(name: string): boolean {
    const g = globalThis.__dsFx;
    const flag = g ? g[name] : undefined;
    if (typeof flag === 'boolean') return flag;
    const d = registry.get(name);
    if (!d) return false; // unregistered effects stay off
    return d[currentTier()];
  },

  /** Run fn; with ?perf=1 also add its µs to __dsFx.stats[name]. */
  time<T>(name: string, fn: () => T): T {
    if (!perfEnabled()) return fn();
    const t0 = performance.now();
    try {
      return fn();
    } finally {
      record(name, (performance.now() - t0) * 1000);
    }
  },

  /** The tier the defaults resolve against. */
  tier(): FxTier {
    return currentTier();
  },

  /** Force a tier (tests, tools); null returns to detection. */
  setTier(tier: FxTier | null): void {
    tierOverride = tier;
    tierCache = null;
  },

  /** Force µs accounting on or off (tests, tools); null re-reads ?perf=1. */
  setPerf(on: boolean | null): void {
    perfOverride = on;
    perfCache = null;
  },

  /** Registered effects with their defaults and current switch state. */
  registered(): Array<{ name: string; defaults: FxDefaults; on: boolean }> {
    return [...registry.entries()].map(([name, defaults]) => ({
      name,
      defaults: { ...defaults },
      on: fx.on(name),
    }));
  },

  /** Forget every registration and every stat (tests). */
  reset(): void {
    registry.clear();
    tierOverride = null;
    tierCache = null;
    perfOverride = null;
    perfCache = null;
    const g = globalThis.__dsFx;
    if (g) {
      delete g.stats;
      delete g.effects;
    }
  },
};
