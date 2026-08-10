// @vitest-environment happy-dom
//
// Mining slice (wave 3): highland ore veins + the bank's satiation split.
import type * as THREE from 'three';
import { beforeAll, describe, expect, test, vi } from 'vitest';

import { saleSplit } from '../economy';
import { Island } from '../Island';
import { WORLD_RADIUS } from '../WorldScale';
import { installHeadlessCanvas } from './helpers/headlessDom';

let island: Island;

beforeAll(() => {
  installHeadlessCanvas();
  island = new Island(WORLD_RADIUS);
}, 120000);

describe('ore veins', () => {
  test('exactly 4 veins, published at their SEATED positions', () => {
    expect(island.oreNodeSites).toHaveLength(4);
    for (const p of island.oreNodeSites) {
      const r = p.length();
      // On the terrain shell, not floating or sunk.
      expect(r).toBeGreaterThan(WORLD_RADIUS - 1);
      expect(r).toBeLessThan(island.maxTerrainRadius());
    }
  });

  test('veins keep clear of the summit trail and the streets', () => {
    // The placement guard slides sites away while trailAt(dir).w > 0.02 or
    // isNearStreet — assert the invariant the guard converges to.
    const trailAt = (island as unknown as { trailAt: (d: THREE.Vector3) => { w: number } }).trailAt;
    for (const p of island.oreNodeSites) {
      const dir = p.clone().normalize();
      expect(trailAt(dir).w).toBeLessThanOrEqual(0.02);
      expect(island.isNearStreet(dir)).toBe(false);
    }
  });

  test('every vein registered a collider', () => {
    const nearVein = (c: { position: THREE.Vector3 }) =>
      island.oreNodeSites.some((s) => s.distanceTo(c.position) < 0.01);
    expect(island.pendingColliders.filter(nearVein).length).toBeGreaterThanOrEqual(4);
  });

  test('builder never leaks draws to the ambient Math.random stream', () => {
    // The shield stashes Math.random, swaps in the seeded local RNG, and
    // restores on exit — so any call the spy sees is a draw that ESCAPED the
    // shield (a multiplayer wire-protocol leak: vehicle placement replays the
    // ambient stream and desyncs across clients if a builder consumes it).
    // Re-running the builder mutates the island (duplicate sites), so this
    // test runs LAST and nothing below reads oreNodeSites.
    const spy = vi.spyOn(Math, 'random');
    (island as unknown as { createOreNodes: () => unknown }).createOreNodes();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('bank satiation split', () => {
  // Mirrors SimpleApp's ORE constants (5c full / 1c satiated, 10/day cap) —
  // change those consciously, with this contract, not by accident.
  const CAP = 10;
  const FULL = 5;
  const SATIATED = 1;

  test('12 ore on a fresh day = 10 full + 2 satiated = 52 coins', () => {
    const { full, earn } = saleSplit(12, 0, CAP, FULL, SATIATED);
    expect(full).toBe(10);
    expect(earn).toBe(52);
  });

  test('cap already spent → everything at the satiated price', () => {
    const { full, earn } = saleSplit(7, 10, CAP, FULL, SATIATED);
    expect(full).toBe(0);
    expect(earn).toBe(7);
  });

  test('oversold ledger never yields a negative full count', () => {
    const { full, earn } = saleSplit(3, 15, CAP, FULL, SATIATED);
    expect(full).toBe(0);
    expect(earn).toBe(3);
  });
});
