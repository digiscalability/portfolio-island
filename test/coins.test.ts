// @vitest-environment happy-dom
//
// The meadow-coin hook (P2-B7): setOnMeadowCoin fires where a coin on the
// ground is picked up, meadow or arrival trail, and never for coins granted
// by addCoins (a sale, a quest, a race). A's wave-4 economy (P2-A10) reads
// it as scene.setOnMeadowCoin?.(cb).
//
// Behavioural: a real GameScene with its world build switched off; the
// pickup runs through the coin loop's own method.
import * as THREE from 'three';
import { beforeAll, describe, expect, test, vi } from 'vitest';

import { GameScene } from '../GameScene';

interface Coins {
  setOnMeadowCoin(cb: ((e: { trail: boolean }) => void) | null): void;
  addCoins(n: number): void;
  spendCoins(n: number): boolean;
  collectMeadowCoin(c: { mesh: THREE.Mesh; respawnAt: number; trail?: boolean }, t: number): void;
  trailCoinsLeft: number;
  coinsCollected: number;
}

let scene: Coins;

beforeAll(() => {
  const init = vi
    .spyOn(GameScene.prototype as unknown as { initialize: () => Promise<void> }, 'initialize')
    .mockResolvedValue(undefined);
  scene = new GameScene() as unknown as Coins;
  init.mockRestore();
});

const coin = (trail = false): { mesh: THREE.Mesh; respawnAt: number; trail?: boolean } => ({
  mesh: new THREE.Mesh(),
  respawnAt: 0,
  trail,
});

describe('setOnMeadowCoin fires at the pickup, not in addCoins (P2-B7)', () => {
  test('a meadow coin and a trail coin fire it, with trail set', () => {
    const seen: Array<{ trail: boolean }> = [];
    scene.setOnMeadowCoin((e) => seen.push(e));
    const before = scene.coinsCollected;
    scene.collectMeadowCoin(coin(), 10);
    scene.trailCoinsLeft = 2;
    scene.collectMeadowCoin(coin(true), 11);
    expect(seen).toEqual([{ trail: false }, { trail: true }]);
    expect(scene.coinsCollected).toBe(before + 2);
    scene.setOnMeadowCoin(null);
  });

  test('addCoins (a sale, a quest) and spendCoins never fire it', () => {
    const cb = vi.fn();
    scene.setOnMeadowCoin(cb);
    scene.addCoins(5);
    expect(scene.spendCoins(3)).toBe(true);
    expect(cb).not.toHaveBeenCalled();
    scene.setOnMeadowCoin(null);
  });

  test('without a callback a pickup still counts', () => {
    const before = scene.coinsCollected;
    scene.collectMeadowCoin(coin(), 20);
    expect(scene.coinsCollected).toBe(before + 1);
  });
});
