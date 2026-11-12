// The orbit camera's look and follow, run for real on a fake player at the
// north pole (A4, A5). Look is by displacement: how far the pointer moved,
// never how many frames it took.
import * as THREE from 'three';
import { afterEach, describe, expect, test, vi } from 'vitest';

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

// ---- A5: the follow takes only motion away from the camera ----------------

const followDirOf = (cam: OrbitCamera): THREE.Vector3 =>
  (cam as unknown as { followDir: THREE.Vector3 }).followDir;
/** Signed angle (deg) of the follow direction from where it started, about +Y. */
const followYaw = (start: THREE.Vector3, now: THREE.Vector3): number =>
  Math.atan2(start.clone().cross(now).y, start.dot(now)) * DEG;
/** Walk in a fixed WORLD direction for `seconds`, with input `input` each frame. */
const walk = (
  cam: OrbitCamera,
  player: FakePlayer,
  dir: THREE.Vector3,
  seconds: number,
  input: [number, number] = [1, 0],
) => {
  player.vel.copy(dir).normalize().multiplyScalar(5.6);
  for (let t = 0; t < seconds - 1e-9; t += 1 / 60) {
    cam.setMoveInput(input[0], input[1]);
    cam.update(1 / 60);
  }
};

describe('strafing walks a straight line (A5)', () => {
  // At rest the camera sits south of the player: followDir +Z, looking -Z.

  test('a sideways walk leaves the camera where it is', () => {
    const { player, cam } = rig();
    const f0 = followDirOf(cam).clone();
    walk(cam, player, new THREE.Vector3(1, 0, 0), 2, [0, 1]); // D, held 2 s
    expect(Math.abs(followYaw(f0, followDirOf(cam)))).toBeLessThan(0.5);
  });

  test('walking toward the camera does not swing it round', () => {
    const { player, cam } = rig();
    const f0 = followDirOf(cam).clone();
    walk(cam, player, new THREE.Vector3(0, 0, 1), 2, [-1, 0]); // S
    expect(Math.abs(followYaw(f0, followDirOf(cam)))).toBeLessThan(0.5);
  });

  test('walking away a little off-axis settles behind the motion within 1.5 s', () => {
    const { player, cam } = rig();
    // 25° off straight-away (north), toward the east
    const dir = new THREE.Vector3(
      Math.sin((25 * Math.PI) / 180),
      0,
      -Math.cos((25 * Math.PI) / 180),
    );
    walk(cam, player, dir, 1.5);
    const behind = dir.clone().negate();
    expect(followDirOf(cam).angleTo(behind) * DEG).toBeLessThan(2);
  });

  test('the swing never turns faster than 1.2 rad/s on foot, 4.0 riding', () => {
    for (const ride of [false, true]) {
      const { player, cam } = rig();
      (cam as unknown as { followStrength: number }).followStrength = 50; // make the cap bind
      cam.setRideMode(ride);
      const dir = new THREE.Vector3(Math.sin(0.4), 0, -Math.cos(0.4)); // 23° off
      player.vel.copy(dir).multiplyScalar(5);
      let prev = followDirOf(cam).clone();
      let fastest = 0;
      for (let i = 0; i < 30; i++) {
        cam.setMoveInput(1, 0);
        cam.update(1 / 60);
        fastest = Math.max(fastest, prev.angleTo(followDirOf(cam)) * 60);
        prev = followDirOf(cam).clone();
      }
      expect(fastest, `ride=${ride}`).toBeLessThanOrEqual((ride ? 4.0 : 1.2) + 1e-6);
      expect(fastest, `ride=${ride}`).toBeGreaterThan((ride ? 4.0 : 1.2) * 0.9);
    }
  });

  test('riding, motion toward the camera still swings it behind (the gate is open)', () => {
    // Boarding facing away: the car drives at the camera. On foot that is the
    // step the gate leaves alone; a craft cannot strafe, so riding follows it
    // (stage-1 carry-over: 15.1 deg/s against main's 37.2).
    const turned = (ride: boolean): number => {
      const { player, cam } = rig();
      cam.setRideMode(ride);
      const f0 = followDirOf(cam).clone();
      walk(cam, player, new THREE.Vector3(0, 0, 1), 0.5, [1, 0]); // toward the camera
      return followYaw(f0, followDirOf(cam));
    };
    expect(Math.abs(turned(false))).toBeLessThan(0.5);
    expect(Math.abs(turned(true))).toBeGreaterThan(20);
  });

  test('riding with the stick back keeps the gate: S drives at the camera, no circling', () => {
    // Steering is camera-relative and a craft has no reverse: open, the
    // camera would swing behind and the craft turn round again.
    const { player, cam } = rig();
    cam.setRideMode(true);
    const f0 = followDirOf(cam).clone();
    walk(cam, player, new THREE.Vector3(0, 0, 1), 1, [-1, 0]); // S, toward the camera
    expect(Math.abs(followYaw(f0, followDirOf(cam)))).toBeLessThan(0.5);
  });

  test('the follow waits 0.35 s after the input direction turns by more than 45°', () => {
    const { player, cam } = rig();
    const dir = new THREE.Vector3(Math.sin(0.4), 0, -Math.cos(0.4));
    walk(cam, player, dir, 0.1, [1, 0]); // W
    const f0 = followDirOf(cam).clone();
    walk(cam, player, dir, 0.3, [0.7, 0.7]); // W+D: exactly 45°, no hold
    expect(followDirOf(cam).angleTo(f0)).toBeGreaterThan(0);
    const f1 = followDirOf(cam).clone();
    walk(cam, player, dir, 0.3, [0, -1]); // A: a 135° swing, the follow holds
    expect(followDirOf(cam).angleTo(f1)).toBe(0);
    walk(cam, player, dir, 0.3, [0, -1]);
    expect(followDirOf(cam).angleTo(f1)).toBeGreaterThan(0);
  });
});

/**
 * Walk by CAMERA-RELATIVE input for `seconds`, as main-simple does: forward
 * is where the camera looks, so a turning camera turns the walk with it.
 * Returns the fastest follow turn seen, rad/s. The player stays at the pole
 * (velocity only), which keeps the tangent plane exactly XZ.
 */
const steer = (
  cam: OrbitCamera,
  camera: THREE.PerspectiveCamera,
  player: FakePlayer,
  input: [number, number],
  seconds: number,
): number => {
  let prev = followDirOf(cam).clone();
  let fastest = 0;
  for (let t = 0; t < seconds - 1e-9; t += 1 / 60) {
    const f = camera.getWorldDirection(new THREE.Vector3()).setY(0).normalize();
    const right = new THREE.Vector3(-f.z, 0, f.x);
    const dir = f.multiplyScalar(input[0]).addScaledVector(right, input[1]).normalize();
    player.vel.copy(dir).multiplyScalar(5.6);
    player.facing.copy(dir);
    cam.setMoveInput(input[0], input[1]);
    cam.update(1 / 60);
    fastest = Math.max(fastest, prev.angleTo(followDirOf(cam)) * 60);
    prev = followDirOf(cam).clone();
  }
  return fastest;
};

describe('reduced motion: a gentle follow on foot, a calm recentre once still (A5, CO-A2)', () => {
  test('W+A held 3 s: the camera comes round behind the walk, never faster than 0.59 rad/s', () => {
    // With no follow at all (stage 1), W plus a side key walked a straight
    // diagonal: a keyboard visitor steering by the compass arrow walked away
    // from the target (103 m out to 211 m in the reduced-motion follow probe).
    a11y.reducedMotion = true;
    const { camera, player, cam } = rig();
    const f0 = followDirOf(cam).clone();
    const fastest = steer(cam, camera, player, [1, -1], 3);
    expect(fastest).toBeLessThanOrEqual(0.59 + 1e-6);
    // and it does turn: most of 3 s x 0.59 rad/s = 101°, to the walk's side
    const turned = followYaw(f0, followDirOf(cam));
    expect(Math.abs(turned)).toBeGreaterThan(60);
    expect(Math.abs(turned)).toBeLessThanOrEqual(0.59 * 3 * DEG + 0.1);
    // W+A walks north-west from a camera to the south: the spot behind the
    // walk is south-east, so the follow direction swings from +Z toward +X
    // (positive about +Y), and the view turns left with the walk
    expect(turned).toBeGreaterThan(0);
  });

  test('the same walk without reduced motion turns at up to 1.2 rad/s', () => {
    const { camera, player, cam } = rig();
    const fastest = steer(cam, camera, player, [1, -1], 3);
    expect(fastest).toBeGreaterThan(0.59 + 0.2);
    expect(fastest).toBeLessThanOrEqual(1.2 + 1e-6);
  });

  test('D alone turns under 3°/s; S (toward the camera) turns nothing', () => {
    for (const input of [
      [0, 1],
      [-1, 0],
    ] as Array<[number, number]>) {
      a11y.reducedMotion = true;
      const { camera, player, cam } = rig();
      const f0 = followDirOf(cam).clone();
      steer(cam, camera, player, input, 2);
      expect(Math.abs(followYaw(f0, followDirOf(cam))) / 2, `input ${input}`).toBeLessThan(3);
    }
  });

  test('straight away (W) holds the camera where it is: nothing to follow', () => {
    a11y.reducedMotion = true;
    const { camera, player, cam } = rig();
    const f0 = followDirOf(cam).clone();
    expect(steer(cam, camera, player, [1, 0], 2)).toBeLessThan(1e-6);
    expect(followDirOf(cam).angleTo(f0) * DEG).toBeLessThan(0.01);
  });

  test('a manual look still holds the follow off for 1.0 s', () => {
    a11y.reducedMotion = true;
    const { camera, player, cam } = rig();
    cam.setInput(0.2, 0);
    run(cam, 0.3, 1 / 60); // the look lands
    const looked = followDirOf(cam).clone();
    steer(cam, camera, player, [1, -1], 0.6); // inside the hold
    expect(followDirOf(cam).angleTo(looked) * DEG).toBeLessThan(0.01);
    steer(cam, camera, player, [1, -1], 2); // hold and ramp over
    expect(followDirOf(cam).angleTo(looked) * DEG).toBeGreaterThan(5);
  });

  test('moving: under 5°/s; stopped 0.5 s: recentres behind the facing at ≤ 34°/s', () => {
    a11y.reducedMotion = true;
    const { player, cam } = rig();
    player.facing.set(1, 0, 0); // strafing east, facing east
    const f0 = followDirOf(cam).clone();
    walk(cam, player, new THREE.Vector3(1, 0, 0), 2, [0, 1]);
    expect(Math.abs(followYaw(f0, followDirOf(cam))) / 2).toBeLessThan(5);
    // stop
    player.vel.set(0, 0, 0);
    let prev = followDirOf(cam).clone();
    let fastest = 0;
    let behindAt = -1;
    for (let i = 1; i <= 6 * 60; i++) {
      cam.update(1 / 60);
      const now = followDirOf(cam);
      fastest = Math.max(fastest, (prev.angleTo(now) * DEG) / (1 / 60));
      prev = now.clone();
      if (i === 29) expect(now.angleTo(f0) * DEG).toBeLessThan(0.5); // still waiting at 0.48 s
      if (behindAt < 0 && now.angleTo(new THREE.Vector3(-1, 0, 0)) * DEG < 1) behindAt = i / 60;
    }
    expect(fastest).toBeLessThanOrEqual(34);
    expect(behindAt).toBeGreaterThan(0.5);
    expect(behindAt).toBeLessThan(6);
  });

  test('the view does not swing as the visitor walks off sideways', () => {
    a11y.reducedMotion = true;
    const { camera, player, cam } = rig();
    player.facing.set(1, 0, 0);
    const h0 = heading(camera);
    let worst = 0;
    player.vel.set(3.4, 0, 0);
    for (let i = 0; i < 120; i++) {
      player.pos.x += 3.4 / 60; // the visitor really moves (a flat patch at the pole)
      cam.setMoveInput(0, 1);
      cam.update(1 / 60);
      worst = Math.max(worst, Math.abs(heading(camera) - h0));
    }
    expect(worst).toBeLessThan(3);
  });

  test('a manual look cancels the recentre', () => {
    a11y.reducedMotion = true;
    const { player, cam } = rig();
    player.facing.set(1, 0, 0);
    walk(cam, player, new THREE.Vector3(1, 0, 0), 0.5, [0, 1]);
    player.vel.set(0, 0, 0);
    cam.setInput(0.3, 0); // look around while standing
    run(cam, 0.3, 1 / 60);
    const looked = followDirOf(cam).clone();
    run(cam, 4, 1 / 60);
    expect(followDirOf(cam).angleTo(looked) * DEG).toBeLessThan(0.01);
  });

  test('riding still follows, capped at 0.6 rad/s', () => {
    a11y.reducedMotion = true;
    const { player, cam } = rig();
    (cam as unknown as { followStrength: number }).followStrength = 50;
    cam.setRideMode(true);
    const dir = new THREE.Vector3(Math.sin(0.4), 0, -Math.cos(0.4));
    player.vel.copy(dir).multiplyScalar(5);
    let prev = followDirOf(cam).clone();
    let fastest = 0;
    for (let i = 0; i < 30; i++) {
      cam.setMoveInput(1, 0);
      cam.update(1 / 60);
      fastest = Math.max(fastest, prev.angleTo(followDirOf(cam)) * 60);
      prev = followDirOf(cam).clone();
    }
    expect(fastest).toBeLessThanOrEqual(0.6 + 1e-6);
    expect(fastest).toBeGreaterThan(0.5);
  });
});

// ---- A2 meets A5: a frame the world takes no input is not a stop -----------

/** `seconds` of frames behind a panel that is not walkable: held, no input. */
const heldFor = (cam: OrbitCamera, seconds: number) => {
  for (let t = 0; t < seconds - 1e-9; t += 1 / 60) {
    cam.holdMoveInput();
    cam.update(1 / 60);
  }
};
const BEHIND_EAST = new THREE.Vector3(-1, 0, 0); // the camera's spot behind a player facing +X

describe('held frames are not a stop: no recentre behind a panel (A2 × A5)', () => {
  test('walk, then 3 s behind a panel: the camera holds still', () => {
    // The integration review: A held 1.2 s, then the Portfolio menu at once,
    // and the view turned 90° behind the open menu in 3 s.
    a11y.reducedMotion = true;
    const { player, cam } = rig();
    player.facing.set(1, 0, 0); // strafed east, facing east
    walk(cam, player, new THREE.Vector3(1, 0, 0), 1.2, [0, 1]);
    player.vel.set(0, 0, 0);
    const f0 = followDirOf(cam).clone();
    heldFor(cam, 3);
    expect(followDirOf(cam).angleTo(f0) * DEG).toBeLessThan(0.01);
  });

  test('the idle clock pauses behind the panel and carries on after it', () => {
    a11y.reducedMotion = true;
    const { player, cam } = rig();
    player.facing.set(1, 0, 0);
    walk(cam, player, new THREE.Vector3(1, 0, 0), 1, [0, 1]);
    player.vel.set(0, 0, 0);
    run(cam, 0.3, 1 / 60); // still for 0.3 s, then the panel opens
    heldFor(cam, 3);
    const f0 = followDirOf(cam).clone();
    run(cam, 0.1, 1 / 60); // 0.4 s still in all: not yet
    expect(followDirOf(cam).angleTo(f0) * DEG).toBeLessThan(0.01);
    run(cam, 0.3, 1 / 60); // 0.7 s: under way
    expect(followDirOf(cam).angleTo(f0) * DEG).toBeGreaterThan(1);
    run(cam, 4, 1 / 60);
    expect(followDirOf(cam).angleTo(BEHIND_EAST) * DEG).toBeLessThan(1);
  });

  test('a recentre under way waits behind the panel, then finishes', () => {
    a11y.reducedMotion = true;
    const { player, cam } = rig();
    player.facing.set(1, 0, 0);
    walk(cam, player, new THREE.Vector3(1, 0, 0), 1, [0, 1]);
    player.vel.set(0, 0, 0);
    run(cam, 1.2, 1 / 60); // 0.5 s still, then about 0.7 s of turning
    const f1 = followDirOf(cam).clone();
    expect(f1.angleTo(new THREE.Vector3(0, 0, 1)) * DEG).toBeGreaterThan(10);
    heldFor(cam, 3);
    expect(followDirOf(cam).angleTo(f1) * DEG).toBeLessThan(0.01);
    run(cam, 4, 1 / 60);
    expect(followDirOf(cam).angleTo(BEHIND_EAST) * DEG).toBeLessThan(1);
  });

  test('a key held through the panel walks on after it, with no turn in between', () => {
    // The phone case: the joystick still pushed as the drawer opens.
    a11y.reducedMotion = true;
    const { player, cam } = rig();
    player.facing.set(1, 0, 0);
    walk(cam, player, new THREE.Vector3(1, 0, 0), 1, [0, 1]);
    const f0 = followDirOf(cam).clone();
    heldFor(cam, 3); // D still down behind the panel, the world deaf to it
    walk(cam, player, new THREE.Vector3(1, 0, 0), 1, [0, 1]); // the panel closes; D walks on
    expect(followDirOf(cam).angleTo(f0) * DEG).toBeLessThan(0.5);
  });
});

// ---- A10: the intro fly-in ------------------------------------------------
// flyInFromDistant runs on its own requestAnimationFrame loop with a
// Date.now clock (clamped to 100 ms a frame). Both are stubbed here, so a
// flight is driven frame by frame at any frame time, stalls included.

/** A flight in flight: step it one frame at a time. */
const flight = (frameMs: (i: number) => number, duration = 2500) => {
  const r = rig();
  let now = 1_000_000;
  let queued: (() => void) | null = null;
  vi.stubGlobal('requestAnimationFrame', (cb: () => void) => {
    queued = cb;
    return 1;
  });
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const follow = { pos: r.camera.position.clone(), quat: r.camera.quaternion.clone() };
  let landed = false;
  const done = r.cam.flyInFromDistant(duration).then(() => {
    landed = true;
  });
  // the call itself draws the first pose
  const frames: Array<{ pos: THREE.Vector3; quat: THREE.Quaternion; dt: number }> = [
    { pos: r.camera.position.clone(), quat: r.camera.quaternion.clone(), dt: 0 },
  ];
  let i = 0;
  /** One animation frame; false once the flight has landed. */
  const step = (): boolean => {
    if (!queued || frames.length > 2000) return false;
    const dt = frameMs(i++);
    now += dt;
    const cb: () => void = queued;
    queued = null;
    cb();
    frames.push({ pos: r.camera.position.clone(), quat: r.camera.quaternion.clone(), dt });
    return true;
  };
  const run = (): void => {
    while (step()) {
      /* to the end */
    }
  };
  return {
    ...r,
    follow,
    frames,
    step,
    run,
    done,
    landed: () => landed,
    flying: () => r.cam.isFlyingIn(),
  };
};
/** The view's turn between consecutive frames, degrees. */
const turns = (frames: Array<{ quat: THREE.Quaternion }>): number[] =>
  frames.slice(1).map((f, i) => frames[i].quat.angleTo(f.quat) * DEG);

describe('the intro fly-in: a curved approach that never swings the view (A10)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test('it starts 244 u out looking at the planet, and lands exactly on the follow pose', async () => {
    const f = flight(() => 1000 / 60);
    const first = f.frames[0];
    expect(first.pos.distanceTo(f.player.pos)).toBeGreaterThan(200);
    // looking at the island's centre: the view axis passes through the origin
    const view = new THREE.Vector3(0, 0, -1).applyQuaternion(first.quat);
    expect(view.angleTo(first.pos.clone().negate()) * DEG).toBeLessThan(0.01);
    expect(f.flying()).toBe(true);
    f.run();
    await f.done;
    expect(f.landed()).toBe(true);
    expect(f.flying()).toBe(false);
    const last = f.frames[f.frames.length - 1];
    expect(last.pos.distanceTo(f.follow.pos)).toBeLessThan(1e-9);
    expect(last.quat.angleTo(f.follow.quat) * DEG).toBeLessThan(1e-6);
    // the follow update resumes on that pose without a jump
    f.cam.update(1 / 60);
    expect(f.camera.position.distanceTo(f.follow.pos)).toBeLessThan(1e-6);
    expect(f.camera.quaternion.angleTo(f.follow.quat) * DEG).toBeLessThan(0.01);
  });

  test('2.5 s at 60 Hz: 150 frames, give or take the last', () => {
    const f = flight(() => 1000 / 60);
    f.run();
    expect(f.frames.length - 1).toBeGreaterThanOrEqual(150);
    expect(f.frames.length - 1).toBeLessThanOrEqual(152);
  });

  test('the view never turns more than 1.5° in a frame, at 60, 38 and 24 fps', () => {
    for (const ms of [1000 / 60, 26.1, 41.7]) {
      const f = flight(() => ms);
      f.run();
      const t = turns(f.frames);
      expect(Math.max(...t), `${ms.toFixed(1)} ms frames`).toBeLessThanOrEqual(1.5);
      // and it does turn: the whole way from the planet to the follow view
      const total = t.reduce((a, b) => a + b, 0);
      expect(total, `${ms.toFixed(1)} ms frames`).toBeGreaterThan(40);
    }
  });

  test('uneven frames and stalls: still 1.5° a frame at most, and it still lands', async () => {
    // The audit's flight: p50 26 ms, p95 39 ms, four frames over 50 ms, one
    // of 123 ms as the intro-lite levers restored.
    const uneven = (i: number): number =>
      i === 40 ? 123 : i % 11 === 5 ? 62 : i % 3 === 0 ? 39 : 24;
    const f = flight(uneven);
    f.run();
    await f.done;
    expect(f.landed()).toBe(true);
    expect(Math.max(...turns(f.frames))).toBeLessThanOrEqual(1.5);
    expect(f.frames[f.frames.length - 1].quat.angleTo(f.follow.quat) * DEG).toBeLessThan(1e-6);
  });

  test('the view holds on the planet for the first 30%, then turns', () => {
    const f = flight(() => 1000 / 60);
    f.run();
    const t = turns(f.frames);
    const early = t.slice(0, 40); // 0.67 s of 2.5 s: before 30% (0.75 s)
    // only the bearing's drift, well under half a degree a frame
    expect(Math.max(...early)).toBeLessThan(0.5);
    const late = t.slice(60, 130);
    expect(late.reduce((a, b) => a + b, 0)).toBeGreaterThan(30);
  });

  test('the camera comes down the whole way without rising, and decelerates', () => {
    const f = flight(() => 1000 / 60);
    f.run();
    const r = f.frames.map((x) => x.pos.length());
    for (let i = 1; i < r.length; i++) {
      expect(r[i], `frame ${i}`).toBeLessThanOrEqual(r[i - 1] + 1e-9);
    }
    // ease-out: more than 45% of the descent is done in the first fifth
    const whole = r[0] - r[r.length - 1];
    expect(r[0] - r[30]).toBeGreaterThan(whole * 0.45);
    // and the last half second moves it under 2 u
    expect(r[120] - r[r.length - 1]).toBeLessThan(2);
  });

  test('a stalled first render does not eat the flight: the clock counts 100 ms a frame at most', () => {
    const f = flight((i) => (i === 0 ? 2300 : 1000 / 60)); // warmUp's 2.3 s before frame 2
    f.run();
    // 100 ms counted for the stall: about 144 more frames, not 12
    expect(f.frames.length - 1).toBeGreaterThan(140);
  });

  test('look input is ignored during the flight, and update() stands down', () => {
    const f = flight(() => 1000 / 60);
    for (let i = 0; i < 30; i++) f.step();
    const pose = { pos: f.camera.position.clone(), quat: f.camera.quaternion.clone() };
    f.cam.setInput(0.4, 0.1);
    f.cam.update(1 / 60);
    expect(f.camera.position.distanceTo(pose.pos)).toBe(0);
    expect(f.camera.quaternion.angleTo(pose.quat)).toBe(0);
    f.run();
    expect(f.cam.getYaw()).toBe(0);
  });

  test('reduced motion never flies: it snaps to the follow pose and resolves at once', async () => {
    a11y.reducedMotion = true;
    const f = flight(() => 1000 / 60);
    await f.done;
    expect(f.landed()).toBe(true);
    expect(f.flying()).toBe(false);
    expect(f.frames[0].pos.distanceTo(f.follow.pos)).toBeLessThan(1e-9);
    expect(f.step()).toBe(false); // no animation frame was ever asked for
  });
});

describe('handing the camera back from a rail (w2 integration, conversation release)', () => {
  test('adoptView puts the follow on the side of the given point; getFollowPose moves nothing', () => {
    const { camera, player, cam } = rig();
    const before = camera.position.clone();
    const pos = new THREE.Vector3();
    const look = new THREE.Vector3();
    cam.getFollowPose(pos, look);
    // reading the pose leaves the camera where it was
    expect(camera.position.distanceTo(before)).toBeLessThan(1e-9);
    // a rail left the camera on the other side of the player
    const n = player.pos.clone().normalize();
    const away = before.clone().sub(player.pos);
    away.addScaledVector(n, -away.dot(n));
    const other = player.pos.clone().addScaledVector(away.normalize(), -3).addScaledVector(n, 1.5);
    cam.adoptView(other);
    cam.getFollowPose(pos, look);
    const side = (p: THREE.Vector3) => {
      const d = p.clone().sub(player.pos);
      return d.addScaledVector(n, -d.dot(n)).normalize();
    };
    // the follow pose now sits on the rail's side: the resume swings nothing round
    expect(side(pos).dot(side(other))).toBeGreaterThan(0.999);
    // and the pose is what update() eases to: a snap lands on it exactly
    cam.snapToPlayer();
    expect(camera.position.distanceTo(pos)).toBeLessThan(1e-6);
  });
});
