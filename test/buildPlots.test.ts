// @vitest-environment happy-dom
//
// BUILD_PLOTS invariants (expansion slice 1). This suite is the AUTHORITY on
// plot placement — the authored lon/lats get nudged until it passes, then a
// screenshot pass rules on looks.
import * as THREE from 'three';
import { beforeAll, describe, expect, test, vi } from 'vitest';

import { GameScene } from '../GameScene';
import { Island } from '../Island';
import { WORLD_RADIUS } from '../WorldScale';
import { installHeadlessCanvas } from './helpers/headlessDom';

let island: Island;

beforeAll(() => {
  installHeadlessCanvas();
  island = new Island(WORLD_RADIUS);
}, 120000);

// Fixed stations a plot must never crowd (lon, lat) — school, bank, hospital,
// carpenter, playground.
const STATIONS: Array<[number, number]> = [
  [2.3, 0.62],
  [5.95, 1.22],
  [0.15, 0.68],
  [0.35, 0.56],
  [2.45, 0.6],
];

describe('BUILD_PLOTS placement', () => {
  test('every plot is off-street and on land', () => {
    for (const p of GameScene.BUILD_PLOTS) {
      const dir = island.dirAt(p.lon, p.lat);
      expect(island.isNearStreet(dir), `${p.defaultKind} @ ${p.lon},${p.lat} is on a street`).toBe(
        false,
      );
      expect(island.isOverWater(dir), `${p.defaultKind} @ ${p.lon},${p.lat} is over water`).toBe(
        false,
      );
    }
  });

  test('plots keep clear of each other, benches, and stations (≥4m arc)', () => {
    const minArc = island.arc(4);
    const all: Array<[string, number, number]> = [
      ...GameScene.BUILD_PLOTS.map(
        (p, i) => [`build${i}`, p.lon, p.lat] as [string, number, number],
      ),
      ...GameScene.BENCH_PLOTS.map((p, i) => [`bench${i}`, p[0], p[1]] as [string, number, number]),
      ...STATIONS.map((p, i) => [`station${i}`, p[0], p[1]] as [string, number, number]),
    ];
    for (let i = 0; i < GameScene.BUILD_PLOTS.length; i++) {
      const a = island.dirAt(GameScene.BUILD_PLOTS[i].lon, GameScene.BUILD_PLOTS[i].lat);
      for (const [name, lon, lat] of all) {
        if (name === `build${i}`) continue;
        const b = island.dirAt(lon, lat);
        const ang = a.angleTo(b);
        expect(
          ang,
          `build${i} (${GameScene.BUILD_PLOTS[i].defaultKind}) crowds ${name}`,
        ).toBeGreaterThan(minArc);
      }
    }
  });

  test('L plots sit on near-flat ground (any L plot can host a gazebo)', () => {
    for (let i = 0; i < GameScene.BUILD_PLOTS.length; i++) {
      const p = GameScene.BUILD_PLOTS[i];
      if (p.size !== 'L') continue;
      const dir = island.dirAt(p.lon, p.lat);
      const a = island.analyticSurface(dir);
      expect(
        a.normal.dot(dir),
        `gazebo plot ${i} on a slope (cos ${a.normal.dot(dir).toFixed(3)})`,
      ).toBeGreaterThanOrEqual(0.995);
    }
  });

  test('defaultKind-per-index snapshot (append-only — the cloud stores the index)', () => {
    expect(GameScene.BUILD_PLOTS.map((p) => p.defaultKind)).toEqual([
      'signpost',
      'signpost',
      'signpost',
      'signpost',
      'signpost',
      'signpost',
      'lantern',
      'lantern',
      'lantern',
      'lantern',
      'lantern',
      'lantern',
      'gazebo',
      'gazebo',
      'planter',
      'campfire',
      'gazebo',
      'gazebo',
    ]);
    expect(GameScene.BUILD_PLOTS.map((p) => p.size)).toEqual([
      ...Array.from({ length: 12 }, () => 'S'),
      'L',
      'L',
      'S',
      'S',
      'L',
      'L',
    ]);
  });

  test('resolveKind: valid wins, gazebo clamps to L plots, junk degrades to default', () => {
    expect(GameScene.resolveKind(0)).toBe('signpost'); // legacy record, no kind
    expect(GameScene.resolveKind(0, 1)).toBe('lantern'); // chooser pick
    expect(GameScene.resolveKind(0, 3)).toBe('planter');
    expect(GameScene.resolveKind(0, 2)).toBe('signpost'); // gazebo on S -> default
    expect(GameScene.resolveKind(12, 2)).toBe('gazebo'); // gazebo on L -> allowed
    expect(GameScene.resolveKind(0, 99)).toBe('signpost'); // out of range
    expect(GameScene.resolveKind(0, -1)).toBe('signpost');
    expect(GameScene.resolveKind(0, 1.5)).toBe('signpost'); // non-integer junk
  });
});

describe('renderWorldBuild determinism', () => {
  test('never consumes Math.random (identical structures on every client)', () => {
    const scene = new THREE.Scene() as unknown as GameScene;
    // Borrow the real method onto a stub carrying only what it reads.
    const proto = GameScene.prototype as unknown as Record<string, unknown>;
    const stub = Object.assign(scene, {
      island,
      builtBuildPlots: new Map(),
      plotSamples: new Map(),
      lampBulbMats: [],
      colliders: [],
      plotSample: proto['plotSample'],
      renderWorldBuildShielded: proto['renderWorldBuildShielded'],
      refreshPlotMarkers: () => {}, // stake refresh not under test
    });
    const render = (
      GameScene.prototype as unknown as Record<string, (p: number, k?: number, c?: boolean) => void>
    )['renderWorldBuild'].bind(stub);
    const spy = vi.spyOn(Math, 'random');
    render(0); // signpost (legacy record)
    render(6); // lantern
    render(12); // gazebo
    render(14, 3); // planter via chooser kind
    render(15, 4); // campfire via chooser kind
    render(1, 2); // gazebo REQUESTED on an S plot -> clamps to signpost
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    expect((stub.builtBuildPlots as Map<number, unknown>).size).toBe(6);
    // The clamped record renders the plot default: no gazebo colliders pushed.
    expect((stub.colliders as unknown[]).length).toBe(4); // from plot 12 only
    // Glow materials joined the night ramp for lantern + campfire.
    expect((stub.lampBulbMats as unknown[]).length).toBe(2);
  });

  test('removeWorldBuild restores colliders, glow list, and the plot', () => {
    const scene = new THREE.Scene() as unknown as GameScene;
    const proto = GameScene.prototype as unknown as Record<string, unknown>;
    const stub = Object.assign(scene, {
      island,
      builtBuildPlots: new Map(),
      plotSamples: new Map(),
      lampBulbMats: [],
      colliders: [],
      plotSample: proto['plotSample'],
      renderWorldBuildShielded: proto['renderWorldBuildShielded'],
      refreshPlotMarkers: () => {},
    });
    const bound = GameScene.prototype as unknown as Record<
      string,
      (p: number, k?: number, c?: boolean) => void
    >;
    const render = bound['renderWorldBuild'].bind(stub);
    const remove = bound['removeWorldBuild'].bind(stub);
    render(12); // gazebo: 4 colliders
    render(6); // lantern: 1 glow material
    expect((stub.colliders as unknown[]).length).toBe(4);
    expect((stub.lampBulbMats as unknown[]).length).toBe(1);
    remove(12);
    remove(6);
    expect((stub.builtBuildPlots as Map<number, unknown>).size).toBe(0);
    expect((stub.colliders as unknown[]).length).toBe(0);
    expect((stub.lampBulbMats as unknown[]).length).toBe(0);
  });
});
