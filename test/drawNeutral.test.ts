// @vitest-environment happy-dom
//
// DRAW-NEUTRAL CENSUS: the Island half of the seeded window, cold and warm.
//
// GameScene.initialize builds new Island() under a fixed mulberry32 stream
// (installSeededRandom ... restoreRandom), so every client builds the same
// map. three.js takes a uuid from that stream for every Object3D, Material,
// BufferGeometry and InterleavedBuffer (4 draws), every Texture (8: the
// Texture's uuid and its Source's), and once per process 8 more for the
// geometry the first Sprite creates. A builder that adds, removes or reorders
// one object therefore re-rolls everything drawn after it, including the
// parked cars multiplayer addresses BY INDEX.
//
// Island.seedMark() checkpoints the build at five builder boundaries: after
// the CBD facade burn (C7 removed TextureGenerator.createBuildingTextures and
// burns its 450 draws there), after the construction loop, after
// the gate boards, before createRocks and at the end of the constructor. This
// suite installs a recorder for those checkpoints and counts the seeded draws
// taken at each one, for two builds:
//  - COLD: the file's first Island. Vitest's default forks pool isolates each
//    test file in a fresh process, so three's sprite cache and Island's module
//    caches start empty.
//  - WARM: the second Island in the same process.
// Both must equal test/fixtures/islandSeed.json, recorded on main before any
// stage-2 change. A change inside new Island() keeps them by burning exactly
// the draws the census measures at the site it changes, or by building under
// a local RNG shield. The fixture is never re-blessed.
//
// NODE'S BUILDS, NOT THE BROWSER'S. Both builds run under happy-dom and the
// headless canvas, and the browser's build matches neither. Recorded in
// Chromium on a built dist, on both tiers, its draws between the five
// checkpoints are 29784 / 6257 / 284 / 9907 (46232 from the first to the
// last), against 29442 / 6276 / 284 / 10311 (46313) cold and
// 29434 / 6247 / 284 / 10036 (46001) warm here. This suite pins node's two
// builds; the seed probe (`npm run probe -- seed`, against
// test/golden/seedDraws.json) pins the browser's seeded window. So a burn
// sized from this census alone, above all a first-of-kind one (the first
// Sprite, the first build of a cached geometry or texture), is confirmed
// with the seed probe before it lands.
//
// The counts do not depend on the device tier. Of the tier gates inside new
// Island(), the grass and the ink build under local RNG shields and the sea's
// tessellation costs the same draws on both tiers: every checkpoint measured
// identical with isLowTierDevice forced either way, cold and warm. tierParity
// pins the totals.
//
// SELF-CHECK. The two builds first differ at plaque #0, the process's first
// Sprite: cold minus warm is 0 at the building-texture checkpoint and exactly
// the first-Sprite cost at the construction checkpoint. If this file ever ran
// warm (a shared process, or a cache an import warmed), the gap there would be
// 0 and the suite fails instead of comparing two warm builds.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type * as THREE from 'three';
import { Vector3 } from 'three';
import { beforeAll, describe, expect, test } from 'vitest';

import { Island } from '../Island';
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

/** Cumulative seeded draws at each checkpoint, in the order they fired. */
interface Census {
  marks: Record<string, number>;
  total: number;
}

const CHECKPOINTS = [
  'island:buildingTextures',
  'island:constructionBlocks',
  'island:gateBoards',
  'island:beforeRocks',
  'island:end',
];

/** One new Island() on a fresh seeded stream, counted, with a recorder. */
const build = (): { census: Census; island: Island } => {
  const gen = seeded();
  let draws = 0;
  const marks: Record<string, number> = {};
  const g = globalThis as { __dsSeedMark?: (label: string) => void };
  const real = Math.random;
  Math.random = () => {
    draws++;
    return gen();
  };
  g.__dsSeedMark = (label) => {
    marks[label] = draws;
  };
  let island: Island;
  try {
    island = new Island(WORLD_RADIUS);
  } finally {
    Math.random = real;
    delete g.__dsSeedMark;
  }
  return { census: { marks, total: draws }, island };
};

interface Fixture {
  firstSpriteCost: number;
  cold: Census;
  warm: Census;
}

const fixture = JSON.parse(
  readFileSync(join(process.cwd(), 'test', 'fixtures', 'islandSeed.json'), 'utf8'),
) as Fixture;

let cold: Census;
let warm: Census;
let warmIsland: Island;

beforeAll(() => {
  installHeadlessCanvas();
  cold = build().census; // this file's FIRST Island: the caches start empty
  const second = build();
  warm = second.census;
  warmIsland = second.island;
}, 300000);

describe('new Island() takes a fixed share of the seeded stream', () => {
  test('every checkpoint fires once per build, in build order, cumulative', () => {
    for (const c of [cold, warm]) {
      expect(Object.keys(c.marks)).toEqual(CHECKPOINTS);
      for (let i = 1; i < CHECKPOINTS.length; i++) {
        expect(c.marks[CHECKPOINTS[i]]).toBeGreaterThanOrEqual(c.marks[CHECKPOINTS[i - 1]]);
      }
      // The last checkpoint closes the constructor: nothing draws after it.
      expect(c.marks['island:end']).toBe(c.total);
    }
  });

  test('the cold build matches the fixture', () => {
    // One assertion per build so a mismatch prints every checkpoint at once.
    expect(cold).toEqual(fixture.cold);
  });

  test('the warm build matches the fixture', () => {
    expect(warm).toEqual(fixture.warm);
  });

  test('self-check: the first build really was cold', () => {
    const gap = (label: string): number => cold.marks[label] - warm.marks[label];
    expect(gap('island:buildingTextures')).toBe(0);
    // Measured on three 0.180: the first Sprite's shared BufferGeometry and
    // InterleavedBuffer, 4 draws each.
    expect(fixture.firstSpriteCost).toBe(8);
    expect(gap('island:constructionBlocks')).toBe(fixture.firstSpriteCost);
  });

  test("the warm build sits on tierParity's pinned stream", () => {
    // tierParity.test.ts GOLDEN.draws, also a warm build from the same seed:
    // both suites measure the same world.
    expect(warm.total).toBe(49771);
  });
});

describe('what new Island() builds', () => {
  test('no light enters its scene graph (decision P2-1)', () => {
    // three bakes the light COUNT into every lit program, so a light that
    // joins at dusk re-links the world. The porch lights and the lighthouse
    // spots are still constructed for their seeded draws (the counts above),
    // but none of them is added. worldLook pins how; this pins the result.
    const lights: string[] = [];
    warmIsland.mesh.traverse((o) => {
      if ((o as { isLight?: boolean }).isLight) lights.push(o.type);
    });
    expect(lights).toEqual([]);
  });
});

describe('ink on everything that stands (C4, desktop cel)', () => {
  const hullsUnder = (name: RegExp): number[] => {
    const out: number[] = [];
    warmIsland.mesh.traverse((o) => {
      if (!name.test(o.name)) return;
      let n = 0;
      o.traverse((c) => {
        if (c.userData.isCelHull) n++;
      });
      out.push(n);
    });
    return out;
  };

  test('every parked car carries hulls (chassis and cabin)', () => {
    const cars = hullsUnder(/^car_\d+$/);
    expect(cars.length).toBe(8);
    for (const n of cars) expect(n).toBe(2);
  });

  test('the fountain, the bandstand and the gates carry hulls', () => {
    expect(hullsUnder(/^town_fountain$/)[0]).toBeGreaterThan(0);
    expect(hullsUnder(/^bandstand$/)[0]).toBeGreaterThan(0);
    const gates = hullsUnder(/^district_gate_\d+$/);
    expect(gates.length).toBe(4);
    for (const n of gates) expect(n).toBeGreaterThan(0);
  });

  test('ground clutter is never inked', () => {
    // Grass, rocks and flowers are instanced, and no hull hangs off an
    // instanced part (the fleets get their own merged hull after load).
    const inkedClutter: string[] = [];
    warmIsland.mesh.traverse((o) => {
      if (!o.userData.isCelHull) return;
      const p = o.parent as THREE.Object3D & { isInstancedMesh?: boolean };
      if (p?.isInstancedMesh || /grass|rock|flower|petal|stem|kelp|coral/i.test(p?.name ?? '')) {
        inkedClutter.push(p.name);
      }
    });
    expect(inkedClutter).toEqual([]);
  });
});

describe('the Projects district dioramas (C8)', () => {
  const tris = (g: THREE.BufferGeometry): number =>
    (g.getIndex()?.count ?? g.getAttribute('position').count) / 3;

  test('each diorama: 600 triangles or fewer, a 2.3 u footprint, 6.5 u tall or less', () => {
    for (let i = 0; i < 5; i++) {
      const parts = Island.dioramaParts(i);
      const n = parts.reduce((a, g) => a + tris(g), 0);
      expect(n).toBeLessThanOrEqual(600);
      for (const g of parts) {
        g.computeBoundingBox();
        const b = g.boundingBox!;
        expect(Math.max(-b.min.x, b.max.x, -b.min.z, b.max.z)).toBeLessThanOrEqual(1.15 + 1e-6);
        expect(b.max.y).toBeLessThanOrEqual(6.5);
      }
    }
  });

  test('the district: 3k triangles, 3 materials and 15 draws or fewer, ink on', () => {
    const district = warmIsland.mesh.getObjectByName('projects-dioramas');
    expect(district).toBeDefined();
    let draws = 0;
    let triangles = 0;
    const mats = new Set<string>();
    let hulls = 0;
    district!.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      if (m.userData.isCelHull) {
        hulls++;
        draws++;
        return;
      }
      draws += Array.isArray(m.material) ? m.material.length : 1;
      triangles += tris(m.geometry);
      for (const x of Array.isArray(m.material) ? m.material : [m.material]) mats.add(x.uuid);
    });
    expect(draws).toBeLessThanOrEqual(15);
    expect(triangles).toBeLessThanOrEqual(3000);
    expect(mats.size).toBeLessThanOrEqual(3);
    expect(hulls).toBeGreaterThan(0);
  });

  test('the five work-site anchors keep their names, and nothing else hangs off them', () => {
    const names: string[] = [];
    warmIsland.mesh.traverse((o) => {
      if (/^construction_\d+$/.test(o.name)) {
        names.push(o.name);
        expect(o.children.length).toBe(0);
        // Plumb (C0's lock): local +Y is the radial up.
        const up = new Vector3(0, 1, 0).applyQuaternion(o.quaternion);
        expect(up.angleTo(o.position.clone().normalize())).toBeLessThan(1e-6);
      }
    });
    expect(names).toEqual([0, 1, 2, 3, 4].map((i) => `construction_${i}`));
  });
});
