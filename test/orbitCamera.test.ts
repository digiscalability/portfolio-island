// The orbit camera's look and follow, run for real on a fake player at the
// north pole (A4, A5). Look is by displacement: how far the pointer moved,
// never how many frames it took.
import * as THREE from 'three';
import { afterEach, describe, expect, test } from 'vitest';

import { a11y } from '../Accessibility';
import { OrbitCamera } from '../OrbitCamera';
import { SimpleInputManager } from '../SimpleInputManager';
import type { SimplePlayer } from '../SimplePlayer';

const DEG = 180 / Math.PI;
const R = 100;

/** The slice of SimplePlayer the camera reads. */
class FakePlayer {
  pos = new THREE.Vector3(0, R, 0);
  vel = new THREE.Vector3();
  facing = new THREE.Vector3(0, 0, -1);
  getWorldPositionInto(out: THREE.Vector3) {
    return out.copy(this.pos);
  }
  getWorldPosition() {
    return this.pos.clone();
  }
  getSurfaceNormalInto(out: THREE.Vector3) {
    return out.copy(this.pos).normalize();
  }
  getSurfaceNormal() {
    return this.pos.clone().normalize();
  }
  getVelocityInto(out: THREE.Vector3) {
    return out.copy(this.vel);
  }
  getWorldDirection(out: THREE.Vector3) {
    return out.copy(this.facing);
  }
}

const rig = () => {
  const camera = new THREE.PerspectiveCamera(60, 16 / 10, 0.1, 1000);
  const player = new FakePlayer();
  const cam = new OrbitCamera(camera, player as unknown as SimplePlayer);
  cam.snapToPlayer();
  return { camera, player, cam };
};
/** The camera's heading on the tangent plane at the pole, degrees, + = turned LEFT. */
const heading = (camera: THREE.PerspectiveCamera): number => {
  const f = camera.getWorldDirection(new THREE.Vector3());
  return Math.atan2(-f.x, -f.z) * DEG;
};
const run = (cam: OrbitCamera, seconds: number, dt: number) => {
  for (let t = 0; t < seconds - 1e-9; t += dt) cam.update(dt);
};
/** 300 px of mouse, spread evenly over `frames` frames at `dt`. */
const drag = (
  cam: OrbitCamera,
  px: number,
  frames: number,
  dt: number,
  source: 'mouse' | 'touch' = 'mouse',
) => {
  const k = source === 'touch' ? SimpleInputManager.TOUCH_K : SimpleInputManager.MOUSE_K;
  for (let i = 0; i < frames; i++) {
    cam.setInput((px / frames) * k, 0, source);
    cam.update(dt);
  }
};

afterEach(() => {
  a11y.reducedMotion = false;
  delete (globalThis as { __dsFx?: unknown }).__dsFx;
});

describe('look by displacement (A4)', () => {
  test('the same 300 px ends on the same yaw at 60 and 120 Hz', () => {
    const turned: number[] = [];
    for (const [frames, dt] of [
      [30, 1 / 60],
      [60, 1 / 120],
    ] as const) {
      const { camera, cam } = rig();
      const h0 = heading(camera);
      drag(cam, 300, frames, dt);
      run(cam, 0.6, dt);
      turned.push(h0 - heading(camera));
    }
    // 300 px × 0.0035 rad/px = 60.2° to the right
    for (const t of turned) expect(t).toBeCloseTo(300 * SimpleInputManager.MOUSE_K * DEG, 1);
    expect(Math.abs(turned[0] - turned[1]) / turned[0]).toBeLessThan(0.02);
  });

  test('a 1-frame flick and a 120-frame drag land on the same yaw', () => {
    const yaws: number[] = [];
    for (const frames of [1, 5, 30, 60, 120]) {
      const { cam } = rig();
      drag(cam, 300, frames, 1 / 60);
      run(cam, 0.6, 1 / 60);
      yaws.push(cam.getYaw());
    }
    for (const y of yaws) expect(y * DEG).toBeCloseTo(-300 * SimpleInputManager.MOUSE_K * DEG, 2);
  });

  test('the live camera turns with the pose: no lag, no cut across the orbit', () => {
    const { camera, player, cam } = rig();
    const d0 = camera.position.distanceTo(player.pos);
    const h0 = heading(camera);
    drag(cam, 300, 1, 1 / 60);
    run(cam, 0.3, 1 / 60);
    expect(h0 - heading(camera)).toBeCloseTo(60.16, 0);
    expect(Math.abs(camera.position.distanceTo(player.pos) - d0)).toBeLessThan(0.05);
  });

  test('getYawTarget holds the whole input at once; getYaw eases onto it', () => {
    const { cam } = rig();
    cam.setInput(150 * SimpleInputManager.TOUCH_K, 0, 'touch');
    expect(cam.getYawTarget() * DEG).toBeCloseTo(-51.57, 1);
    cam.update(1 / 60);
    const after1 = cam.getYaw();
    expect(Math.abs(after1)).toBeGreaterThan(0);
    expect(Math.abs(after1)).toBeLessThan(Math.abs(cam.getYawTarget()));
    run(cam, 1.2, 1 / 60);
    expect(cam.getYaw()).toBeCloseTo(cam.getYawTarget(), 6);
  });

  test('a finger eases slower than a mouse (70 ms against 40 ms)', () => {
    const frac = (source: 'mouse' | 'touch'): number => {
      const { cam } = rig();
      cam.setInput(0.5, 0, source);
      cam.update(1 / 60);
      return cam.getYaw() / cam.getYawTarget();
    };
    expect(frac('mouse')).toBeCloseTo(1 - Math.exp(-1 / 60 / 0.04), 6);
    expect(frac('touch')).toBeCloseTo(1 - Math.exp(-1 / 60 / 0.07), 6);
  });

  test('pitch accumulates at 0.8 of the input and stays inside −0.18..π/4', () => {
    const { cam } = rig();
    const p0 = (cam as unknown as { pitch: number }).pitch;
    cam.setInput(0, 0.1);
    run(cam, 0.5, 1 / 60);
    expect((cam as unknown as { pitch: number }).pitch - p0).toBeCloseTo(0.08, 6);
    cam.setInput(0, 50);
    run(cam, 0.5, 1 / 60);
    expect((cam as unknown as { pitch: number }).pitch).toBeCloseTo(Math.PI / 4, 6);
    cam.setInput(0, -50);
    run(cam, 0.5, 1 / 60);
    expect((cam as unknown as { pitch: number }).pitch).toBeCloseTo(-0.18, 6);
  });

  test('setYaw turns at once, relative to getYaw', () => {
    const { camera, cam } = rig();
    const h0 = heading(camera);
    cam.setYaw(cam.getYaw() + Math.PI / 6);
    expect(heading(camera) - h0).toBeCloseTo(30, 1);
    expect(cam.getYawTarget()).toBeCloseTo(cam.getYaw(), 12);
  });
});

describe('the touch fling (A4)', () => {
  const flung = (rate: number): number => {
    const { cam } = rig();
    cam.fling(rate);
    run(cam, 2, 1 / 60);
    return cam.getYawTarget() * DEG;
  };

  test('keeps turning after a fast swipe, never past 30° in all', () => {
    // 600, 1,800 and 9,000 px/s at k = 0.006 rad/px
    for (const v of [600, 1800, 9000]) {
      const added = -flung(v * SimpleInputManager.TOUCH_K);
      expect(added, `${v} px/s`).toBeGreaterThanOrEqual(5);
      expect(added, `${v} px/s`).toBeLessThanOrEqual(30 + 1e-9);
    }
    // ω·τ below the cap: 1.0 rad/s × 0.15 s ≈ 8.6°
    expect(-flung(1)).toBeCloseTo(8.6, 0);
  });

  test('turns the way the finger went', () => {
    expect(flung(-3)).toBeGreaterThan(0); // a leftward swipe keeps turning left
  });

  test('none under reduced motion, none with the lookFling switch off', () => {
    a11y.reducedMotion = true;
    expect(flung(5)).toBe(0);
    a11y.reducedMotion = false;
    (globalThis as { __dsFx?: { lookFling?: boolean } }).__dsFx = { lookFling: false };
    expect(flung(5)).toBe(0);
  });

  test('a finger back on the glass catches it', () => {
    const { cam } = rig();
    cam.fling(5);
    run(cam, 0.05, 1 / 60);
    const caught = cam.getYawTarget();
    cam.setInput(0.001, 0, 'touch');
    run(cam, 1, 1 / 60);
    expect(cam.getYawTarget()).toBeCloseTo(caught - 0.001, 9);
  });
});

describe('keyboard look (A4)', () => {
  test('L held 1 s turns 90° right, J 90° left', () => {
    const { cam } = rig();
    for (let i = 0; i < 60; i++) {
      cam.keyLook(1, 0, 1 / 60);
      cam.update(1 / 60);
    }
    expect(cam.getYawTarget() * DEG).toBeCloseTo(-90, 6);
    for (let i = 0; i < 60; i++) {
      cam.keyLook(-1, 0, 1 / 60);
      cam.update(1 / 60);
    }
    expect(cam.getYawTarget() * DEG).toBeCloseTo(0, 6);
  });

  test('I tilts up at 60°/s, inside the clamp', () => {
    const { cam } = rig();
    const pitch = () => (cam as unknown as { pitch: number }).pitch;
    const p0 = pitch();
    for (let i = 0; i < 30; i++) {
      cam.keyLook(0, 1, 1 / 60);
      cam.update(1 / 60);
    }
    run(cam, 0.4, 1 / 60);
    expect((pitch() - p0) * DEG).toBeCloseTo(30, 4);
    for (let i = 0; i < 120; i++) {
      cam.keyLook(0, 1, 1 / 60);
      cam.update(1 / 60);
    }
    run(cam, 0.4, 1 / 60);
    expect(pitch()).toBeCloseTo(Math.PI / 4, 6);
  });

  test('R puts the camera behind the player within 0.3 s; at once under reduced motion', () => {
    for (const reduced of [false, true]) {
      a11y.reducedMotion = reduced;
      const { camera, player, cam } = rig();
      // the player faces east (+X); the camera starts south of them looking north
      player.facing.set(1, 0, 0);
      cam.recentre();
      if (!reduced) run(cam, 0.3, 1 / 60);
      const f = camera.getWorldDirection(new THREE.Vector3()).setY(0).normalize();
      expect(f.x, `reduced=${reduced}`).toBeGreaterThan(Math.cos((5 * Math.PI) / 180));
    }
  });
});

describe('auto-follow waits for a manual look to finish (A4)', () => {
  /** Follow turn (deg) during `seconds` while the player walks diagonally away. */
  const followTurn = (
    cam: OrbitCamera,
    camera: THREE.PerspectiveCamera,
    player: FakePlayer,
    seconds: number,
  ) => {
    const fd = (cam as unknown as { followDir: THREE.Vector3 }).followDir;
    const f0 = fd.clone();
    for (let t = 0; t < seconds - 1e-9; t += 1 / 60) {
      // diagonally away from the camera and to its right
      const f = camera.getWorldDirection(new THREE.Vector3()).setY(0).normalize();
      const right = new THREE.Vector3(-f.z, 0, f.x);
      player.vel.copy(f).add(right).normalize().multiplyScalar(5);
      cam.update(1 / 60);
    }
    return f0.angleTo(fd) * DEG;
  };

  test('held at 0 for 1.0 s, then back', () => {
    const { camera, player, cam } = rig();
    cam.setInput(0.2, 0);
    run(cam, 0.3, 1 / 60); // the look itself lands
    expect(followTurn(cam, camera, player, 0.6)).toBeLessThan(0.01); // still inside the hold
    run(cam, 1.2, 1 / 60); // hold over, ramp over
    expect(followTurn(cam, camera, player, 0.5)).toBeGreaterThan(5);
  });
});
