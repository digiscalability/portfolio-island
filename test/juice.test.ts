// JUICE.SQUASH — the spring impulse (B4).
//
// The old squash was a sine envelope over the tween with a re-entry guard: a
// second pop while one ran was dropped, and each call captured the scale it
// found, so a restart mid-pop would have compounded. It scaled about the
// object's origin, which for the player group (origin mid-body) lifted the
// feet off the ground. This suite pins the spring's shape, the restart and
// the foot pivot.
import * as THREE from 'three';
import { describe, expect, test } from 'vitest';

import {
  easeOutBack,
  expDecay,
  SQUASH_DUR,
  squash,
  squashPivot,
  squashSpring,
  tick,
} from '../Juice';

const DT = 1 / 240;

/** Run the tween scheduler for `sec` seconds. */
function run(sec: number, each?: (t: number) => void): void {
  for (let t = 0; t < sec - 1e-9; t += DT) {
    tick(DT);
    each?.(t + DT);
  }
}

describe('the squash spring (B4)', () => {
  test('peaks at 45-65 ms, undershoots before 200 ms, settles by 450 ms', () => {
    let peakT = 0;
    let peak = -Infinity;
    let underT = 0;
    let under = Infinity;
    for (let t = 0; t <= SQUASH_DUR; t += 0.0005) {
      const s = squashSpring(t, 0.12);
      if (s > peak) {
        peak = s;
        peakT = t;
      }
      if (t > peakT && s < under) {
        under = s;
        underT = t;
      }
    }
    expect(peakT).toBeGreaterThanOrEqual(0.045);
    expect(peakT).toBeLessThanOrEqual(0.065);
    // The amount is the visible peak.
    expect(peak - 1).toBeCloseTo(0.12, 4);
    expect(under, 'it undershoots').toBeLessThan(1);
    expect(underT).toBeLessThan(0.2);
    expect(Math.abs(squashSpring(SQUASH_DUR, 0.12) - 1)).toBeLessThan(0.01);
  });

  test('reduced motion: 40% of the amount, critically damped (no undershoot)', () => {
    let min = Infinity;
    let max = -Infinity;
    for (let t = 0; t <= SQUASH_DUR; t += 0.001) {
      const s = squashSpring(t, 0.12, true);
      min = Math.min(min, s);
      max = Math.max(max, s);
    }
    expect(max - 1).toBeCloseTo(0.048, 4);
    expect(min).toBeGreaterThanOrEqual(1 - 1e-9);
  });

  test('x and z keep the volume: 1/√s', () => {
    const o = new THREE.Object3D();
    o.scale.set(2, 3, 4);
    squash(o, 0.12);
    run(0.05);
    const s = o.scale.y / 3;
    expect(o.scale.x / 2).toBeCloseTo(1 / Math.sqrt(s), 9);
    expect(o.scale.z / 4).toBeCloseTo(1 / Math.sqrt(s), 9);
    run(SQUASH_DUR);
  });

  test('a re-trigger mid-impulse restarts from the cached base and ends on it', () => {
    const o = new THREE.Object3D();
    o.scale.set(0.88, 0.88, 0.88);
    squash(o, 0.14, 0.3);
    run(0.04); // mid-stretch
    expect(o.scale.y).toBeGreaterThan(0.88);
    squash(o, 0.14, 0.3); // restart: must not capture the stretched scale
    run(0.02);
    squash(o, -0.1);
    run(SQUASH_DUR + 0.05);
    expect(o.scale.x).toBeCloseTo(0.88, 6);
    expect(o.scale.y).toBeCloseTo(0.88, 6);
    expect(o.scale.z).toBeCloseTo(0.88, 6);
    // A later pop starts from the (unchanged) base.
    squash(o, 0.1);
    run(SQUASH_DUR + 0.05);
    expect(o.scale.y).toBeCloseTo(0.88, 6);
  });

  test('pivotY: the sole stays put (under 0.005 u) on a tilted object', () => {
    const parent = new THREE.Object3D();
    const o = new THREE.Object3D();
    parent.add(o);
    o.position.set(3, 40, -2);
    o.quaternion.setFromUnitVectors(
      new THREE.Vector3(0, 1, 0),
      new THREE.Vector3(0.3, 1, 0.2).normalize(),
    );
    const sole = () => o.localToWorld(new THREE.Vector3(0, -0.7, 0));
    o.updateMatrixWorld(true);
    const before = sole();
    let worst = 0;
    squash(o, 0.12, 0.16, { pivotY: -0.7 });
    run(SQUASH_DUR + 0.02, () => {
      o.updateMatrixWorld(true);
      worst = Math.max(worst, sole().distanceTo(before));
    });
    expect(worst).toBeLessThan(0.005);
    // ...and the origin is back where it was.
    expect(o.position.distanceTo(new THREE.Vector3(3, 40, -2))).toBeLessThan(1e-9);
  });

  // The app's order (main-simple): Juice ticks first, then the movers write
  // position and orientation (SimplePlayer.updateWorldMatrix, the cat loop).
  const tilt = new THREE.Quaternion().setFromUnitVectors(
    new THREE.Vector3(0, 1, 0),
    new THREE.Vector3(-0.2, 1, 0.4).normalize(),
  );
  const moverRun = (opts: { pivotY: number; mover?: boolean }, addPivot: boolean): number => {
    const o = new THREE.Object3D();
    const home = new THREE.Vector3(1, 2, 3);
    const off = new THREE.Vector3();
    const want = (t: number): THREE.Vector3 =>
      new THREE.Vector3(0, opts.pivotY, 0)
        .applyQuaternion(tilt)
        .add(home)
        .addScaledVector(new THREE.Vector3(1, 0, 0), t);
    let worst = 0;
    squash(o, 0.12, 0.16, opts);
    run(SQUASH_DUR + 0.02, (t) => {
      o.position.copy(home).addScaledVector(new THREE.Vector3(1, 0, 0), t); // the mover
      o.quaternion.copy(tilt);
      if (addPivot) {
        const sq = squashPivot(o, off);
        if (sq) o.position.add(sq);
      }
      o.updateMatrixWorld(true);
      const foot = o.localToWorld(new THREE.Vector3(0, opts.pivotY, 0));
      worst = Math.max(worst, foot.distanceTo(want(t)));
    });
    expect(squashPivot(o, off), 'nothing once the impulse ends').toBeNull();
    return worst;
  };

  test('pivotY on a mover, in the app order: the pivot written in the tick is lost', () => {
    // What B4 shipped first: the sole moves as if scaled about the origin.
    expect(moverRun({ pivotY: -0.7 }, false)).toBeGreaterThan(0.04);
  });

  test('pivotY on a mover: squashPivot after the mover write plants the sole', () => {
    expect(moverRun({ pivotY: -0.7, mover: true }, true)).toBeLessThan(0.005);
    expect(moverRun({ pivotY: -0.12, mover: true }, true)).toBeLessThan(0.005);
  });

  test('the helpers A imports are untouched', () => {
    expect(expDecay(0, 1, 5, 0.1)).toBeCloseTo(1 - Math.exp(-0.5), 12);
    expect(easeOutBack(1)).toBeCloseTo(1, 12);
  });
});
