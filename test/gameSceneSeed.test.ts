// @vitest-environment happy-dom
//
// GAMESCENE SEED CENSUS — the GameScene half of the seeded window.
//
// GameScene.initialize runs world generation under a fixed mulberry32 stream
// (installSeededRandom … restoreRandom) so every client builds the same map.
// tierParity, staticFreeze and oreNodes pin the Island half (new Island()).
// Nothing pinned what GameScene's own builders take from the stream after it,
// and three spends Math.random draws on every uuid: 4 per Object3D, Material,
// BufferGeometry and InterleavedBuffer, 8 per Texture (Texture.uuid plus its
// Source.uuid), plus 8 for the shared geometry the FIRST Sprite in a process
// mints. So a builder that adds, removes or reorders one object silently
// re-rolls everything drawn after it.
//
// This suite measures the builders it can run headless — createDustPool,
// createCoins (which runs createArrivalTrail) and createNameTags — on a plain
// THREE.Scene adopted as a GameScene, after the same seeded Island tierParity
// builds, with the generator left running between them. Every number below
// was MEASURED by this census on main's code, never derived from a formula.
//
// Two pins, deliberately separate:
//  - GOLDEN_GS_DRAWS, per-builder draw counts. Never re-blessed. A stage-2
//    change that removes objects (B9 coins, B13 pin atlas, B14 dust) burns
//    exactly what they cost, at the same call site, so these stay equal.
//  - GOLDEN_GS_PLACEMENT, a digest over what the builders COMPUTE: dust pool
//    size, coin and trail transforms, and the villager each pin follows. It is
//    independent of which objects carry them, so B9/B14 can swap Meshes for
//    instances without touching it.
// Both are pinned for a COLD first build (this file's first Island: each test
// file gets a fresh process, so three's module caches start empty) and a
// WARM one, because browsers build cold and the first-of-kind costs differ.
//
// The in-browser census (window.__dsSeedDraws) is pinned separately in
// test/golden/seedDraws.json by the seed probe; this suite checks that file's
// shape and that it agrees with the per-builder counts here.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as THREE from 'three';
import { beforeAll, describe, expect, test, vi } from 'vitest';

import { GameScene } from '../GameScene';
import { Island } from '../Island';
import { SimpleRenderer } from '../SimpleRenderer';
import { WORLD_RADIUS } from '../WorldScale';
import { installHeadlessCanvas } from './helpers/headlessDom';

// Byte-identical to GameScene.installSeededRandom (as tierParity's).
const seeded = (): (() => number) => {
  let s = 0x1a2b3c4d >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const fnv1a = (s: string): string => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
};

/** The private builder surface this suite drives. */
interface Builders {
  island: Island;
  coins: Array<{ mesh: THREE.Object3D; respawnAt: number; trail?: boolean }>;
  dustPuffs: unknown[];
  nameTags: Array<{ target: { name: string } }>;
  trailCoinsLeft: number;
  coinsCollected: number;
  hasLocalCoinRecord: boolean;
  createDustPool(): void;
  createCoins(): void;
  createNameTags(): void;
}

interface Census {
  island: number;
  dustPool: number;
  coins: number;
  nameTags: number;
  placement: string;
  /** Coin transforms alone (no trail), for the fresh/arrived comparison. */
  coinRows: string[];
  trailRows: string[];
  pins: number;
}

const v5 = (x: number): string => x.toFixed(5);

const build = (arrived: boolean): Census => {
  try {
    localStorage.clear();
    if (arrived) localStorage.setItem('ds_arrived', '1');
  } catch {
    /* happy-dom always has storage */
  }
  // Adopted OUTSIDE the counted stream: in the app the GameScene exists (its
  // uuid minted by real randomness) before initialize installs the seed.
  const scene = new THREE.Scene() as unknown as Builders;
  Object.setPrototypeOf(scene, GameScene.prototype);
  const spy = vi.spyOn(SimpleRenderer, 'isLowTierDevice').mockReturnValue(false);
  const gen = seeded();
  let draws = 0;
  const real = Math.random;
  Math.random = () => {
    draws++;
    return gen();
  };
  const take = (fn: () => void): number => {
    const before = draws;
    fn();
    return draws - before;
  };
  let census: Omit<Census, 'placement' | 'coinRows' | 'trailRows' | 'pins'>;
  try {
    const island = take(() => {
      scene.island = new Island(WORLD_RADIUS);
    });
    Object.assign(scene, {
      coins: [],
      dustPuffs: [],
      nameTags: [],
      trailCoinsLeft: 0,
      coinsCollected: 0,
      hasLocalCoinRecord: false,
    });
    const dustPool = take(() => scene.createDustPool());
    const coins = take(() => scene.createCoins());
    const nameTags = take(() => scene.createNameTags());
    census = { island, dustPool, coins, nameTags };
  } finally {
    Math.random = real;
    spy.mockRestore();
  }
  const row = (o: THREE.Object3D): string => {
    const p = o.position;
    const q = o.quaternion;
    return `${v5(p.x)},${v5(p.y)},${v5(p.z)}|${v5(q.x)},${v5(q.y)},${v5(q.z)},${v5(q.w)}`;
  };
  const coinRows = scene.coins.filter((c) => !c.trail).map((c) => row(c.mesh));
  const trailRows = scene.coins.filter((c) => c.trail).map((c) => row(c.mesh));
  const pins = scene.nameTags.map((t) => t.target.name);
  const placement = fnv1a(
    [
      `dust:${scene.dustPuffs.length}`,
      ...coinRows.map((r) => `coin:${r}`),
      ...trailRows.map((r) => `trail:${r}`),
      ...pins.map((n) => `pin:${n}`),
    ].join(';'),
  );
  return { ...census, placement, coinRows, trailRows, pins: pins.length };
};

let cold: Census;
let warm: Census;
let warmArrived: Census;

beforeAll(() => {
  installHeadlessCanvas();
  cold = build(false); // this file's FIRST Island: three's caches start empty
  warm = build(false);
  warmArrived = build(true);
}, 300000);

// (a) Per-builder seeded draws, measured on main. NEVER re-blessed.
const GOLDEN_GS_DRAWS = {
  dustPool: 148,
  coins: 588,
  nameTags: 448,
};

// (b) What the builders compute, digested. Re-bless only for a DELIBERATE
// placement change, and never in the same commit as a draw-count change.
const GOLDEN_GS_PLACEMENT = {
  cold: 'e7e08e01',
  warm: '34d792b3',
};

describe('the GameScene builders take a fixed share of the seeded stream', () => {
  test('per-builder draws match the golden, cold and warm', () => {
    const pick = (c: Census) => ({ dustPool: c.dustPool, coins: c.coins, nameTags: c.nameTags });
    // One assertion per build so a mismatch prints every actual at once.
    expect(pick(warm)).toEqual(GOLDEN_GS_DRAWS);
    expect(pick(cold)).toEqual(GOLDEN_GS_DRAWS);
  });

  test('a returning visitor consumes the SAME stream as a first-time one', () => {
    // ds_arrived='1' skips the arrival trail. Its Meshes would have minted one
    // uuid each, so the skip burns that many and every later draw lines up.
    expect(warmArrived.trailRows).toHaveLength(0);
    expect(warm.trailRows.length).toBeGreaterThan(0);
    expect(warmArrived.coins).toBe(warm.coins);
    expect(warmArrived.dustPool).toBe(warm.dustPool);
    expect(warmArrived.nameTags).toBe(warm.nameTags);
    // The coins themselves land identically: the trail draws come after them.
    expect(warmArrived.coinRows).toEqual(warm.coinRows);
  });

  test('the placements match the golden, cold and warm', () => {
    expect({ cold: cold.placement, warm: warm.placement }).toEqual(GOLDEN_GS_PLACEMENT);
  });

  test('the harness reproduces tierParity’s warm Island stream', () => {
    // tierParity.test.ts GOLDEN.draws: the census starts exactly where the
    // pinned Island half ends, so the counts above sit on the real stream.
    expect(warm.island).toBe(49771);
    // The cold build pays first-of-kind costs on top (measured). A browser's
    // cold Island is pinned by seedDraws.json marks.island instead (50006):
    // the app warms different caches before new Island() than this file does.
    expect(cold.island).toBe(50083);
  });
});

/** test/golden/seedDraws.json: the in-browser census from the seed probe. */
interface SeedGolden {
  marks: Record<string, number>;
  total: number;
}
const CHECKPOINTS = [
  'island',
  'dustPool',
  'coins',
  'vehicles',
  'zones',
  'placeAssets',
  'nameTags',
  'restore',
];

describe('the in-browser census golden (test/golden/seedDraws.json)', () => {
  const golden = JSON.parse(
    readFileSync(join(process.cwd(), 'test', 'golden', 'seedDraws.json'), 'utf8'),
  ) as SeedGolden;

  test('has every checkpoint, in window order, cumulative', () => {
    expect(Object.keys(golden.marks)).toEqual(CHECKPOINTS);
    for (let i = 1; i < CHECKPOINTS.length; i++) {
      expect(golden.marks[CHECKPOINTS[i]]).toBeGreaterThanOrEqual(golden.marks[CHECKPOINTS[i - 1]]);
    }
    expect(golden.total).toBe(golden.marks.restore);
  });

  test('every checkpoint is published by GameScene.initialize', () => {
    const scene = readFileSync(join(process.cwd(), 'GameScene.ts'), 'utf8');
    for (const label of CHECKPOINTS) expect(scene).toContain(`this.seedMark('${label}');`);
  });

  test('each in-browser span holds at least the builder it brackets', () => {
    // The spans also carry the builders this suite cannot run headless (sway
    // phases, butterflies, fireflies, smoke, guide sparkles), so they bound
    // the per-builder counts from above.
    const m = golden.marks;
    expect(m.coins - m.dustPool).toBeGreaterThanOrEqual(GOLDEN_GS_DRAWS.coins);
    expect(m.nameTags - m.placeAssets).toBeGreaterThanOrEqual(GOLDEN_GS_DRAWS.nameTags);
    expect(m.dustPool - m.island).toBeGreaterThanOrEqual(GOLDEN_GS_DRAWS.dustPool);
  });
});
