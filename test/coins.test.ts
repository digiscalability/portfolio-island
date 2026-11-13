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

describe('the pop faces the camera and stays small on screen (B9 play fix)', () => {
  const px = (scale: number, d: number, fov: number, h: number) =>
    (0.6 * scale * h) / (2 * d * Math.tan(THREE.MathUtils.degToRad(fov) / 2));

  test('next to the camera: capped to COIN_POP_MAX_PX and face-on, never a slab', () => {
    const at = new THREE.Vector3(0.3, 77.75, 0.2);
    const cam = new THREE.Vector3(1.2, 78.3, 2.1); // about 2.2 u away, the 21:00 case
    const q = new THREE.Quaternion();
    const d = cam.distanceTo(at);
    for (const h of [900, 844]) {
      const s = GameScene.coinPopFit(at, cam, 50, h, 1.35, q);
      expect(px(1.35, d, 50, h)).toBeGreaterThan(GameScene.COIN_POP_MAX_PX * 2);
      expect(px(s, d, 50, h)).toBeCloseTo(GameScene.COIN_POP_MAX_PX, 5);
      const face = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
      const toCam = cam.clone().sub(at).normalize();
      expect(face.dot(toCam)).toBeCloseTo(1, 6); // the disc's face, not its rim
    }
  });

  test('at the chase distance a smaller pop is left alone; no viewport only turns it', () => {
    const at = new THREE.Vector3(0, 77.75, 0);
    const cam = new THREE.Vector3(0, 82, 14);
    const q = new THREE.Quaternion();
    expect(GameScene.coinPopFit(at, cam, 50, 900, 1.35, q)).toBe(1.35);
    expect(px(1.35, cam.distanceTo(at), 50, 900)).toBeLessThan(GameScene.COIN_POP_MAX_PX);
    expect(GameScene.coinPopFit(at, new THREE.Vector3(0, 78, 1), 50, 0, 1.2, q)).toBe(1.2);
  });

  test('the live instance: the popped coin is face-on and inside the cap; sparkles clear its disc', () => {
    const sc = scene as unknown as {
      camera?: THREE.PerspectiveCamera;
      coins: CoinRec[];
      coinMesh: THREE.InstancedMesh | null;
      buildCoinInstances(): void;
      writeCoinInstances(t: number, q: THREE.Quaternion | null): void;
      spawnCoinSparks(c: CoinRec, t: number): void;
      coinSparks: Array<{ t0: number; at: THREE.Vector3; vel: THREE.Vector3 }>;
    };
    const savedCam = sc.camera;
    const savedCoins = sc.coins;
    const c = coin();
    sc.coins = [c];
    sc.coinMesh = null;
    const cam = new THREE.PerspectiveCamera(50, 390 / 844, 0.1, 500);
    cam.position.set(0.9, 78.2, 1.9);
    cam.lookAt(0, 77, 0);
    cam.updateMatrixWorld();
    sc.camera = cam;
    sc.buildCoinInstances();
    scene.collectMeadowCoin(c, 100);
    sc.spawnCoinSparks(c, 100);
    sc.writeCoinInstances(100.2, cam.quaternion); // hanging above the head
    const m = new THREE.Matrix4();
    sc.coinMesh!.getMatrixAt(0, m);
    const p = new THREE.Vector3();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    m.decompose(p, q, s);
    const d = cam.position.distanceTo(p);
    expect(s.x).toBeGreaterThan(0);
    expect(px(s.x, d, cam.fov, window.innerHeight)).toBeLessThanOrEqual(
      GameScene.COIN_POP_MAX_PX + 1e-6,
    );
    const face = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
    expect(face.dot(cam.position.clone().sub(p).normalize())).toBeGreaterThan(0.999);
    // Each sparkle starts outside the popped disc (0.3 x 1.35) plus its own
    // radius (0.3 x 0.28), so no rim shows through the face.
    const popAt = c.home.clone().addScaledVector(c.home.clone().normalize(), 1.75);
    expect(sc.coinSparks).toHaveLength(6);
    for (const sp of sc.coinSparks) {
      expect(sp.at.distanceTo(popAt)).toBeGreaterThan(0.3 * 1.35 + 0.3 * 0.28);
    }
    sc.coins = savedCoins;
    sc.coinMesh = null;
    sc.camera = savedCam;
  });
});

describe('the glint sprite is no CanvasTexture (B9 vs the C7 census row)', () => {
  test('glintTexture is a 64 px DataTexture with the star: bright centre, clear rim, cross bars', () => {
    const tex = (GameScene as unknown as { glintTexture(): THREE.Texture }).glintTexture();
    expect((tex as THREE.CanvasTexture).isCanvasTexture).toBeFalsy();
    expect((tex as THREE.DataTexture).isDataTexture).toBe(true);
    const px = GameScene.glintPixels();
    const S = GameScene.GLINT_PX;
    expect(px).toHaveLength(S * S * 4);
    const a = (x: number, y: number) => px[(y * S + x) * 4 + 3];
    expect(a(32, 32)).toBeGreaterThan(240); // the centre
    expect(a(0, 0)).toBe(0); // the corner, past the rim
    expect(a(32, 6)).toBeGreaterThanOrEqual(229); // the vertical bar near its tip
    expect(a(8, 6)).toBe(0); // off the bar, outside the glow
    expect(a(32, 2)).toBeLessThan(20); // the bar stops 4 px short of the edge: glow only
  });

  test('the built coins carry no CanvasTexture', () => {
    const sc = scene as unknown as {
      coins: CoinRec[];
      coinMesh: THREE.InstancedMesh | null;
      coinGlint: THREE.InstancedMesh | null;
      buildCoinInstances(): void;
    };
    const saved = sc.coins;
    sc.coins = [coin()];
    sc.coinMesh = null;
    sc.coinGlint = null;
    sc.buildCoinInstances();
    for (const m of [sc.coinMesh, sc.coinGlint]) {
      if (!m) continue;
      const map = (m.material as THREE.MeshBasicMaterial).map;
      if (map) expect((map as THREE.CanvasTexture).isCanvasTexture).toBeFalsy();
    }
    sc.coins = saved;
    sc.coinMesh = null;
    sc.coinGlint = null;
  });
});
