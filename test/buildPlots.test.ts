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
      expect(island.isNearStreet(dir), `${p.kind} @ ${p.lon},${p.lat} is on a street`).toBe(false);
      expect(island.isOverWater(dir), `${p.kind} @ ${p.lon},${p.lat} is over water`).toBe(false);
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
        expect(ang, `build${i} (${GameScene.BUILD_PLOTS[i].kind}) crowds ${name}`).toBeGreaterThan(
          minArc,
        );
      }
    }
  });

  test('gazebo plots sit on near-flat ground (rigid multi-post structure)', () => {
    for (let i = 0; i < GameScene.BUILD_PLOTS.length; i++) {
      const p = GameScene.BUILD_PLOTS[i];
      if (p.kind !== 'gazebo') continue;
      const dir = island.dirAt(p.lon, p.lat);
      const a = island.analyticSurface(dir);
      expect(
        a.normal.dot(dir),
        `gazebo plot ${i} on a slope (cos ${a.normal.dot(dir).toFixed(3)})`,
      ).toBeGreaterThanOrEqual(0.995);
    }
  });

  test('kind-per-index snapshot (append-only — the cloud stores the index)', () => {
    expect(GameScene.BUILD_PLOTS.map((p) => p.kind)).toEqual([
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
    ]);
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
    const render = (GameScene.prototype as unknown as Record<string, (p: number) => void>)[
      'renderWorldBuild'
    ].bind(stub);
    const spy = vi.spyOn(Math, 'random');
    render(0); // signpost
    render(6); // lantern
    render(12); // gazebo
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    expect((stub.builtBuildPlots as Map<number, unknown>).size).toBe(3);
  });
});
