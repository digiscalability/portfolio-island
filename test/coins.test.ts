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

/** A coin record (B9): the transforms the old per-coin Mesh carried, plus a
 *  plain `mesh` stand-in for the probes. */
interface CoinRec {
  pos: THREE.Vector3;
  quat: THREE.Quaternion;
  home: THREE.Vector3;
  respawnAt: number;
  trail?: boolean;
  collectT0?: number;
  idx: number;
  spin: number;
  mesh: { name: string; position: THREE.Vector3; visible: boolean };
}

interface Coins {
  setOnMeadowCoin(cb: ((e: { trail: boolean }) => void) | null): void;
  setOnCoinCollected(cb: (total: number) => void): void;
  addCoins(n: number): void;
  spendCoins(n: number): boolean;
  collectMeadowCoin(c: CoinRec, t: number): void;
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

const coin = (trail = false): CoinRec => {
  const pos = new THREE.Vector3(0, 76, 0);
  return {
    pos,
    quat: new THREE.Quaternion(),
    home: pos.clone(),
    respawnAt: 0,
    trail,
    idx: 0,
    spin: 0,
    mesh: { name: 'coin_0', position: pos, visible: true },
  };
};

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

describe('a pickup says where it popped: window ds:coin (B9 to D11)', () => {
  test('once per pickup, value 1, before the count moves; meadow and trail alike', () => {
    const order: string[] = [];
    const seen: Array<{ x: number; y: number; value: number }> = [];
    const onCoin = (e: Event) => {
      order.push('ds:coin');
      seen.push((e as CustomEvent).detail);
    };
    window.addEventListener('ds:coin', onCoin);
    scene.setOnCoinCollected(() => order.push('count'));
    scene.collectMeadowCoin(coin(), 30);
    scene.trailCoinsLeft = 2;
    scene.collectMeadowCoin(coin(true), 31);
    window.removeEventListener('ds:coin', onCoin);
    expect(order).toEqual(['ds:coin', 'count', 'ds:coin', 'count']);
    expect(seen).toHaveLength(2);
    for (const d of seen) {
      expect(d.value).toBe(1);
      expect(Object.keys(d).sort()).toEqual(['value', 'x', 'y']);
    }
  });

  test('x and y stay on screen: the centre when behind the camera or with none', () => {
    const sc = scene as unknown as { camera?: THREE.PerspectiveCamera };
    const saved = sc.camera;
    const seen: Array<{ x: number; y: number }> = [];
    const onCoin = (e: Event) => seen.push((e as CustomEvent).detail);
    window.addEventListener('ds:coin', onCoin);
    const cam = new THREE.PerspectiveCamera(60, 1, 0.1, 500);
    cam.position.set(0, 80, 0);
    sc.camera = cam;
    cam.lookAt(0, 200, 0); // turned away: the coin at y 76 is behind it
    scene.collectMeadowCoin(coin(), 50);
    cam.lookAt(40, 76, 0); // in front but far off to the side of the frame
    scene.collectMeadowCoin(coin(), 51);
    sc.camera = undefined;
    scene.collectMeadowCoin(coin(), 52);
    sc.camera = saved;
    window.removeEventListener('ds:coin', onCoin);
    const W = window.innerWidth;
    const H = window.innerHeight;
    expect(seen[0]).toEqual({ x: Math.round(W / 2), y: Math.round(H / 2), value: 1 });
    expect(seen[2]).toEqual({ x: Math.round(W / 2), y: Math.round(H / 2), value: 1 });
    for (const d of seen) {
      expect(Number.isFinite(d.x) && Number.isFinite(d.y)).toBe(true);
      expect(d.x).toBeGreaterThanOrEqual(0);
      expect(d.x).toBeLessThanOrEqual(W);
      expect(d.y).toBeGreaterThanOrEqual(0);
      expect(d.y).toBeLessThanOrEqual(H);
    }
  });

  test('addCoins and spendCoins dispatch nothing', () => {
    const cb = vi.fn();
    window.addEventListener('ds:coin', cb);
    scene.addCoins(3);
    scene.spendCoins(1);
    window.removeEventListener('ds:coin', cb);
    expect(cb).not.toHaveBeenCalled();
  });

  test('the pickup is saved (ds_coins) and starts the pop from where it lies', () => {
    const c = coin();
    c.pos.set(1, 76, 2); // the magnet has pulled it toward the visitor
    const before = scene.coinsCollected;
    scene.collectMeadowCoin(c, 40);
    expect(localStorage.getItem('ds_coins')).toBe(String(before + 1));
    expect(c.collectT0).toBe(40);
    expect(c.home.toArray()).toEqual([1, 76, 2]);
    expect(c.respawnAt).toBe(160); // a meadow coin respawns after 120 s
    const t = coin(true);
    scene.trailCoinsLeft = 3;
    scene.collectMeadowCoin(t, 41);
    expect(t.respawnAt).toBe(0); // trail coins are one-shot
  });
});
