// WorldSeed.ts: the seeded window's tools (burnDraws, withLocalRng, seedMark).
//
// Every change inside GameScene.initialize's seeded window leans on these to
// keep the shared stream byte-identical (plan-r3 seededWindow). So each one is
// pinned by BEHAVIOUR, with a Math.random spy counting the ambient draws, the
// way celInk.test.ts pins the ink shield.
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { burnDraws, seedMark, withLocalRng } from '../WorldSeed';

// Byte-identical to GameScene.installSeededRandom (as tierParity's).
const mulberry32 = (seed: number): (() => number) => {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const draw = (n: number): number[] => Array.from({ length: n }, () => Math.random());

afterEach(() => {
  vi.restoreAllMocks();
  globalThis.__dsSeedMark = undefined;
});

describe('withLocalRng', () => {
  test('consumes ZERO ambient draws, however much fn draws', () => {
    const spy = vi.spyOn(Math, 'random');
    spy.mockClear();
    const inner = withLocalRng(() => draw(500), 0x51ed270b);
    expect(inner).toHaveLength(500); // fn really drew…
    expect(spy).toHaveBeenCalledTimes(0); // …and the stream around it paid nothing
  });

  test('is deterministic: the same seed gives the same draws, another seed others', () => {
    const a = withLocalRng(() => draw(64), 0x9e3779b1);
    const b = withLocalRng(() => draw(64), 0x9e3779b1);
    const c = withLocalRng(() => draw(64), 0x9e3779b2);
    expect(b).toEqual(a);
    expect(c).not.toEqual(a);
  });

  test('draws mulberry32, the seeded window’s own generator', () => {
    const gen = mulberry32(0x1a2b3c4d);
    expect(withLocalRng(() => draw(16), 0x1a2b3c4d)).toEqual(
      Array.from({ length: 16 }, () => gen()),
    );
  });

  test('restores the caller’s Math.random when fn throws', () => {
    const before = Math.random;
    expect(() =>
      withLocalRng(() => {
        Math.random();
        throw new Error('builder failed');
      }, 7),
    ).toThrow('builder failed');
    expect(Math.random).toBe(before);
  });

  test('returns fn’s value, and nests without leaking either stream', () => {
    const before = Math.random;
    const out = withLocalRng(() => {
      const outer = Math.random;
      const v = withLocalRng(() => draw(3), 2);
      expect(Math.random).toBe(outer); // the inner shield hands the outer one back
      return v;
    }, 1);
    expect(out).toEqual(withLocalRng(() => draw(3), 2));
    expect(Math.random).toBe(before);
  });
});

describe('burnDraws', () => {
  test.each([0, 1, 20, 148, 450])('burnDraws(%i) takes exactly that many draws', (n) => {
    const spy = vi.spyOn(Math, 'random');
    spy.mockClear();
    burnDraws(n);
    expect(spy).toHaveBeenCalledTimes(n);
  });

  test('advances a seeded stream exactly as the removed code did', () => {
    // Five three uuids (4 draws each) against burnDraws(20): the next draw
    // after either is the same draw.
    const viaBurn = withLocalRng(() => {
      burnDraws(20);
      return Math.random();
    }, 0x1a2b3c4d);
    const viaCode = withLocalRng(() => {
      draw(20);
      return Math.random();
    }, 0x1a2b3c4d);
    expect(viaBurn).toBe(viaCode);
  });

  test('a fraction or a negative count is a formula, and throws', () => {
    expect(() => burnDraws(2.5)).toThrow(RangeError);
    expect(() => burnDraws(-1)).toThrow(RangeError);
    expect(() => burnDraws(Number.NaN)).toThrow(RangeError);
  });

  test('keeps every draw through the production bundler', async () => {
    // Rollup lists Math.random as a pure function, so a bare `Math.random();`
    // whose value goes unused is tree-shaken out of the bundle while every
    // source-level test still passes. That shipped once: the seed probe's
    // returning visitor came out 20 draws short. Bundle a call site the way
    // `vite build` does (tree-shaken, esbuild-minified, es2020) and count.
    const { build } = await import('vite');
    const worldSeed = join(process.cwd(), 'WorldSeed.ts').replace(/\\/g, '/');
    const out = await build({
      configFile: false,
      logLevel: 'silent',
      plugins: [
        {
          name: 'burn-call-site',
          // lib mode hands the entry over resolved against the root.
          resolveId: (id) => (id.endsWith('burn-call-site') ? '\0burn-call-site' : null),
          load: (id) =>
            id === '\0burn-call-site'
              ? `import { burnDraws } from '${worldSeed}';\nexport function run(n) { burnDraws(n); }\n`
              : null,
        },
      ],
      build: {
        write: false,
        minify: 'esbuild',
        target: 'es2020',
        lib: { entry: 'burn-call-site', formats: ['cjs'], fileName: 'burn' },
      },
    });
    const chunk = (Array.isArray(out) ? out[0] : out) as { output: Array<{ code?: string }> };
    const code = chunk.output.find((o) => typeof o.code === 'string')?.code ?? '';
    expect(code).toContain('burnDraws');
    // Run the bundle in its own context, with a Math whose random() counts.
    let draws = 0;
    const counting = Object.create(Math) as Math;
    counting.random = () => {
      draws++;
      return 0.5;
    };
    const mod: { exports: { run?: (n: number) => void } } = { exports: {} };
    runInNewContext(code, { module: mod, exports: mod.exports, Math: counting });
    mod.exports.run?.(20);
    expect(draws).toBe(20);
  }, 60000);
});

describe('seedMark', () => {
  test('does nothing, and draws nothing, with no recorder installed', () => {
    const spy = vi.spyOn(Math, 'random');
    spy.mockClear();
    expect(globalThis.__dsSeedMark).toBeUndefined();
    expect(() => seedMark('island')).not.toThrow();
    expect(spy).toHaveBeenCalledTimes(0);
  });

  test('forwards each label, in order, only while a recorder is installed', () => {
    const marks: string[] = [];
    seedMark('before');
    globalThis.__dsSeedMark = (label) => marks.push(label);
    seedMark('createBuildingTextures');
    seedMark('construction');
    globalThis.__dsSeedMark = undefined;
    seedMark('after');
    expect(marks).toEqual(['createBuildingTextures', 'construction']);
  });
});
