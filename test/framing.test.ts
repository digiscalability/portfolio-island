// Aspect-aware framing. three.js fov is the VERTICAL angle, so a fixed fov is
// pure Hor+ with no floor — measured 24.3 deg horizontal on a portrait phone,
// which turned the world into a corridor on half the audience's devices.
import * as THREE from 'three';
import { describe, expect, test } from 'vitest';

import {
  BASE_VFOV,
  easeInOutSine,
  easeTourTurn,
  framingFov,
  horizontalFov,
  renderedLength,
  tourCaption,
  tourFirstLegLift,
  tourLegDuration,
  tourTurnFloor,
  TOUR_CAPTION_MAX,
  TOUR_DWELL_S,
  TOUR_LEG_MAX_S,
  TOUR_LEG_MIN_S,
  TOUR_PEAK_DEG_S,
  TOUR_TURN_PEAK_DEG_S,
  TOUR_TURN_PEAK_SLOPE,
} from '../Framing';

const ASPECTS = {
  portraitPhone: 393 / 852,
  squareish: 1,
  laptop16x10: 16 / 10,
  hd: 16 / 9,
  ultrawide21x9: 21 / 9,
  superwide32x9: 32 / 9,
  shortLandscape: 900 / 420,
};

describe('framingFov', () => {
  test('DESKTOP IS UNTOUCHED: 16:10 and wider return BASE_VFOV exactly', () => {
    for (const a of [
      ASPECTS.laptop16x10,
      ASPECTS.hd,
      ASPECTS.ultrawide21x9,
      ASPECTS.superwide32x9,
      ASPECTS.shortLandscape,
    ]) {
      expect(framingFov(a)).toBe(BASE_VFOV);
    }
  });

  test('portrait opens up, and gains real horizontal field', () => {
    const a = ASPECTS.portraitPhone;
    const before = horizontalFov(BASE_VFOV, a);
    const after = horizontalFov(framingFov(a), a);
    expect(before).toBeLessThan(30); // the corridor
    expect(after).toBeGreaterThan(before + 8); // materially wider
    expect(framingFov(a)).toBeGreaterThan(BASE_VFOV);
  });

  test('never exceeds the fish-eye ceiling, however tall the window', () => {
    for (const a of [0.2, 0.35, 0.5, 0.75]) {
      expect(framingFov(a)).toBeLessThanOrEqual(68);
    }
  });

  test('monotonic: narrower windows never get a SMALLER vertical fov', () => {
    let prev = 0;
    for (const a of [2.5, 2.0, 1.6, 1.2, 1.0, 0.75, 0.5]) {
      const f = framingFov(a);
      expect(f).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = f;
    }
  });

  test('garbage aspects fall back to the authored fov', () => {
    expect(framingFov(0)).toBe(BASE_VFOV);
    expect(framingFov(-1)).toBe(BASE_VFOV);
    expect(framingFov(NaN)).toBe(BASE_VFOV);
  });
});

describe('A9: the tour rail paces itself', () => {
  test('legs: clamp(1.6 + arc x 0.035, 2.6, 3.35)', () => {
    // A9: 3.35 s keeps the full tour under its 44 s bar (2026-11-14 call).
    expect(TOUR_LEG_MAX_S).toBe(3.35);
    expect(tourLegDuration(0)).toBe(TOUR_LEG_MIN_S);
    expect(tourLegDuration(40)).toBeCloseTo(3.0, 9);
    expect(tourLegDuration(200)).toBe(TOUR_LEG_MAX_S);
  });

  test('a leg whose view would peak over 120 deg/s is lengthened past the clamp', () => {
    // easeInOutSine peaks at pi/2 x the mean rate.
    const T = tourLegDuration(10, 400);
    expect(T).toBeGreaterThan(TOUR_LEG_MAX_S);
    expect(((Math.PI / 2) * 400) / T).toBeCloseTo(TOUR_PEAK_DEG_S, 6);
    expect(tourLegDuration(10, 90)).toBe(TOUR_LEG_MIN_S); // 54 deg/s peak: no change
  });

  test('easeInOutSine: 0, 0.5, 1 with flat ends', () => {
    expect(easeInOutSine(0)).toBe(0);
    expect(easeInOutSine(0.5)).toBeCloseTo(0.5, 12);
    expect(easeInOutSine(1)).toBe(1);
    expect(easeInOutSine(0.01)).toBeLessThan(0.001);
  });

  test('the first leg rises 3 u over 0.5 s and is level again by landing', () => {
    expect(tourFirstLegLift(0, 0)).toBe(0);
    expect(tourFirstLegLift(0.5, 0)).toBeCloseTo(3, 9);
    expect(tourFirstLegLift(2, 1)).toBe(0);
  });

  // The legs' arcs (deg round the planet) as measured on the built island at
  // ?hour=12 (wave-3 A, desktop): the full tour's six legs, the recruiter's four.
  const FULL = [7.2, 63.6, 78.1, 69.1, 116.6, 78.5];
  const RECRUIT = [7.2, 63.6, 17.1, 60.8];
  const total = (arcs: number[]) =>
    arcs.reduce((sum, a) => sum + tourLegDuration(a), 0) + arcs.length * TOUR_DWELL_S;

  test('the recruiter tour is 29 s or less', () => {
    expect(total(RECRUIT)).toBeLessThanOrEqual(29);
  });

  test('the full tour: the dwell is at its 4.0 s floor and the legs keep their clamp', () => {
    expect(TOUR_DWELL_S).toBe(4.0);
    const legs = FULL.reduce((sum, a) => sum + tourLegDuration(a), 0);
    // 2.6 + 5 x 3.35: five of six legs sit at the 3.35 s ceiling (2026-11-14 call).
    expect(legs).toBeCloseTo(19.35, 2);
    // A9, the 44 s bar: 43.35 s planned; fm d-tour measures 43.5 s at ?hour=12
    // (the run adds about 0.15-0.3 s), so the planned total keeps 0.5 s of margin.
    expect(total(FULL)).toBeCloseTo(43.35, 2);
    expect(total(FULL)).toBeLessThanOrEqual(43.5);
  });

  test("captions: the Professional stop plus 'Stop n of 6 · ' is exactly 110 characters", () => {
    const pro =
      'The Professional District — full-stack and AI engineering. Step inside the office for the story.';
    expect(renderedLength(tourCaption(2, 6, pro))).toBe(110);
    expect(TOUR_CAPTION_MAX).toBe(110);
    expect(tourCaption(1, 4, 'x')).toBe('Stop 1 of 4 · x');
  });
});

// MOT-06 (wave 4): the tour's flight, as main-simple's updateTour composes it.
// The old flight slerped the VIEW direction and rebuilt the camera with
// lookAt(up = radial); where the view passed within 2 deg of straight down
// (leg 1, measured 178.1 deg from the radial) lookAt's yaw is undefined and
// the camera spun 9-12 deg in a frame. The orientation slerp has no such pole.
describe('MOT-06: the tour flight turns at most the leg turn under the ease', () => {
  const R = 100;
  const pose = (eye: THREE.Vector3, target: THREE.Vector3) =>
    new THREE.Quaternion().setFromRotationMatrix(
      new THREE.Matrix4().lookAt(eye, target, target.clone().normalize()),
    );
  // A leg like leg 1: a high look-down over one spot, then a stop 64 deg on,
  // the view swinging through the nadir on the way.
  const fromDir = new THREE.Vector3(0, 1, 0);
  const fromEye = fromDir.clone().multiplyScalar(R + 25);
  const fromLook = new THREE.Vector3(0.12, 1, -0.02).normalize().multiplyScalar(R);
  const toDir = new THREE.Vector3(Math.sin(1.12), Math.cos(1.12), 0).normalize();
  const toLook = new THREE.Vector3(Math.sin(1.0), Math.cos(1.0), 0.05)
    .normalize()
    .multiplyScalar(R);
  const fromQ = pose(fromEye, fromLook);
  const toQ = pose(toDir.clone().multiplyScalar(R + 12), toLook);
  const N = 201; // a 3.35 s leg at 60 fps

  function flight(e: number): THREE.Quaternion {
    const arc = new THREE.Quaternion().setFromUnitVectors(fromDir, toDir);
    const local = toQ.clone().premultiply(arc.clone().invert());
    const q = new THREE.Quaternion().slerpQuaternions(fromQ, local, e);
    return q.premultiply(new THREE.Quaternion().slerp(arc, e));
  }
  const steps = (f: (e: number) => THREE.Quaternion, ease = easeTourTurn) => {
    const out: number[] = [];
    let prev = f(0);
    for (let i = 1; i < N; i++) {
      const q = f(ease(i / (N - 1)));
      out.push(THREE.MathUtils.radToDeg(prev.angleTo(q)));
      prev = q;
    }
    return out;
  };

  test('both ends are the poses themselves (continuous seams)', () => {
    expect(flight(0).angleTo(fromQ)).toBeLessThan(1e-6);
    expect(flight(1).angleTo(toQ)).toBeLessThan(1e-6);
  });

  test('no frame turns more than 2 deg at 60 fps, where lookAt spun', () => {
    const s = steps(flight);
    expect(Math.max(...s)).toBeLessThan(2);
    // the old composition on the same leg: a view slerp through the nadir
    const v0 = fromLook.clone().sub(fromEye).normalize();
    const toEye = toDir.clone().multiplyScalar(R + 12);
    const v1 = toLook.clone().sub(toEye).normalize();
    const old = (e: number) => {
      const eye = new THREE.Vector3()
        .copy(fromDir)
        .lerp(toDir, e)
        .normalize()
        .multiplyScalar(R + 20);
      const v = new THREE.Vector3()
        .copy(v0)
        .applyQuaternion(
          new THREE.Quaternion().slerp(new THREE.Quaternion().setFromUnitVectors(v0, v1), e),
        );
      return new THREE.Quaternion().setFromRotationMatrix(
        new THREE.Matrix4().lookAt(eye, eye.clone().add(v), eye.clone().normalize()),
      );
    };
    // measured: 3.08 deg old against 1.38 new on this leg
    expect(Math.max(...steps(old, easeInOutSine))).toBeGreaterThan(2);
  });

  test('the turn ease peaks 29% under the sine and still lands flat', () => {
    expect(easeTourTurn(0)).toBe(0);
    expect(easeTourTurn(1)).toBe(1);
    expect(easeTourTurn(0.5)).toBeCloseTo(0.5, 12);
    expect(easeTourTurn(0.005)).toBeLessThan(1e-4);
    let peak = 0;
    let prev = 0;
    for (let i = 1; i <= 2000; i++) {
      const e = easeTourTurn(i / 2000);
      expect(e).toBeGreaterThanOrEqual(prev);
      peak = Math.max(peak, (e - prev) * 2000);
      prev = e;
    }
    expect(peak).toBeCloseTo(TOUR_TURN_PEAK_SLOPE, 3);
    expect(TOUR_TURN_PEAK_SLOPE / (Math.PI / 2)).toBeLessThan(0.72);
  });

  test('a leg sized by tourTurnFloor turns at most 80 deg/s (1.33 deg per 16.7 ms frame)', () => {
    let maxPerE = 0;
    let prev = flight(0);
    for (let i = 1; i <= 48; i++) {
      const q = flight(i / 48);
      maxPerE = Math.max(maxPerE, THREE.MathUtils.radToDeg(prev.angleTo(q)) * 48);
      prev = q;
    }
    const T = Math.max(TOUR_LEG_MIN_S, tourTurnFloor(maxPerE));
    const frames = Math.round(T * 60);
    let worst = 0;
    let p = flight(0);
    for (let i = 1; i <= frames; i++) {
      const q = flight(easeTourTurn(i / frames));
      worst = Math.max(worst, THREE.MathUtils.radToDeg(p.angleTo(q)) * 60);
      p = q;
    }
    expect(worst).toBeLessThanOrEqual(TOUR_TURN_PEAK_DEG_S * 1.02);
  });
});
