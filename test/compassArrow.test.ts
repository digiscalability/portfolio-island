// The gold ➤ compass arrow points at its target (A1).
//
// SimpleUI rotates the glyph by `bearing − 90°` (0° points right, −90° up the
// screen, CSS rotate() is clockwise), so the bearing main-simple hands it must
// be positive for a target on the RIGHT. It was the mirror image: every
// off-axis sample in the audit pointed to the wrong side.
import * as THREE from 'three';
import { describe, expect, test } from 'vitest';

import {
  compassBearing,
  compassTarget,
  DISTRICT_HYSTERESIS_U,
  nearestWithHysteresis,
  type CompassState,
} from '../Compass';

const DEG = 180 / Math.PI;
/** Wrap to (−180, 180]. */
const wrap = (d: number): number => {
  let x = ((d % 360) + 360) % 360;
  if (x > 180) x -= 360;
  return x;
};
/** The rotate() SimpleUI.updateQuestCompass writes: (angleRad · 180/π) − 90. */
const arrowCssDeg = (bearingRad: number): number => wrap(bearingRad * DEG - 90);
/** Where the drawn arrow points, in degrees clockwise from screen-up. */
const arrowScreenDeg = (bearingRad: number): number => wrap(arrowCssDeg(bearingRad) + 90);

// The camera above the north pole, looking down −Z; the surface normal is +Y.
// Screen-right is then +X (forward × up).
const N = new THREE.Vector3(0, 1, 0);
const FWD = new THREE.Vector3(0, 0, -1);

describe('the arrow points where the target is', () => {
  test('target right: the glyph keeps its rest pose, pointing right (0°)', () => {
    const deg = arrowCssDeg(compassBearing(FWD, new THREE.Vector3(1, 0, 0), N));
    expect(Math.abs(deg)).toBeLessThanOrEqual(10);
  });

  test('target left: the glyph turns half a circle (±180°)', () => {
    const deg = arrowCssDeg(compassBearing(FWD, new THREE.Vector3(-1, 0, 0), N));
    expect(Math.abs(Math.abs(deg) - 180)).toBeLessThanOrEqual(10);
  });

  test('target ahead: the glyph points up the screen (−90°)', () => {
    const deg = arrowCssDeg(compassBearing(FWD, new THREE.Vector3(0, 0, -1), N));
    expect(Math.abs(deg - -90)).toBeLessThanOrEqual(10);
  });

  test('target behind: the glyph points down the screen (+90°)', () => {
    const deg = arrowCssDeg(compassBearing(FWD, new THREE.Vector3(0, 0, 1), N));
    expect(Math.abs(deg - 90)).toBeLessThanOrEqual(10);
  });

  test('24 off-axis targets: the arrow points to the target side, error < 5°', () => {
    // Bearing θ is measured clockwise from forward, as the eye reads it.
    const right = FWD.clone().cross(N); // +X
    let sameSide = 0;
    let errSum = 0;
    for (let i = 0; i < 24; i++) {
      const theta = (7.5 + i * 15) / DEG; // never exactly ahead or behind
      const target = FWD.clone()
        .multiplyScalar(Math.cos(theta))
        .addScaledVector(right, Math.sin(theta));
      const drawn = arrowScreenDeg(compassBearing(FWD, target, N));
      const want = wrap(theta * DEG);
      if (Math.sign(drawn) === Math.sign(want)) sameSide++;
      errSum += Math.abs(wrap(drawn - want));
    }
    expect(sameSide).toBe(24);
    expect(errSum / 24).toBeLessThan(5);
  });

  test('anywhere on the planet, with any heading', () => {
    // A tangent frame at an arbitrary surface point: normal n, a heading f in
    // its tangent plane, and screen-right r = f × n.
    const n = new THREE.Vector3(0.3, -0.5, 0.81).normalize();
    const seed = new THREE.Vector3(1, 0.2, 0);
    const f = seed.addScaledVector(n, -seed.dot(n)).normalize();
    const r = f.clone().cross(n);
    for (const d of [-170, -120, -60, -15, 15, 60, 120, 170]) {
      const t = f
        .clone()
        .multiplyScalar(Math.cos(d / DEG))
        .addScaledVector(r, Math.sin(d / DEG))
        .multiplyScalar(37); // length does not matter
      expect(compassBearing(f, t, n) * DEG).toBeCloseTo(d, 9);
    }
  });

  test('it is the old formula with the sign flipped, nothing else', () => {
    const n = new THREE.Vector3(0, 1, 0);
    const f = new THREE.Vector3(0.6, 0, -0.8);
    for (const t of [
      new THREE.Vector3(1, 0, 0),
      new THREE.Vector3(-0.2, 0, 0.9),
      new THREE.Vector3(0.7, 0, 0.7),
      new THREE.Vector3(-1, 0, -0.1),
    ]) {
      const cross = f.clone().cross(t);
      const old = Math.atan2(cross.dot(n), f.dot(t));
      expect(compassBearing(f, t, n)).toBeCloseTo(-old, 12);
    }
  });
});

// ---- one target at a time (A7 with P2-A3) ---------------------------------
describe('compassTarget: the pill picks one target, in order', () => {
  const none: CompassState = {
    mapPick: false,
    arrivalHold: false,
    raceGuide: false,
    aiGuide: false,
    trailVillager: false,
    projectsUnstamped: false,
    districtUnstamped: false,
    parcelActive: false,
    passportComplete: false,
    deliveryOptIn: false,
  };
  const all: CompassState = {
    mapPick: true,
    arrivalHold: true,
    raceGuide: true,
    aiGuide: true,
    trailVillager: true,
    projectsUnstamped: true,
    districtUnstamped: true,
    parcelActive: true,
    passportComplete: false,
    deliveryOptIn: true,
  };

  test('the order table: each source wins over everything after it', () => {
    const order: Array<[keyof CompassState, string]> = [
      ['mapPick', 'map'],
      ['arrivalHold', 'hold'],
      ['raceGuide', 'race'],
      ['aiGuide', 'ai'],
      ['trailVillager', 'trail'],
      ['projectsUnstamped', 'projects'],
      ['districtUnstamped', 'district'],
    ];
    const s: CompassState = { ...all };
    for (const [key, source] of order) {
      expect(compassTarget(s), `${key} on`).toBe(source);
      s[key] = false;
    }
    // Only the parcel is left: the visitor collected one this session.
    expect(compassTarget(s)).toBe('parcel');
    expect(compassTarget(none)).toBeNull();
  });

  test('no candidate, so the branch is skipped', () => {
    // No trail villager (asleep, out of range, or no trail at all): Projects.
    expect(compassTarget({ ...none, trailVillager: false, projectsUnstamped: true })).toBe(
      'projects',
    );
    // Projects stamped: the nearest other district.
    expect(compassTarget({ ...none, districtUnstamped: true })).toBe('district');
    // Nothing left and no parcel opted into: the pill hides.
    expect(compassTarget({ ...none, parcelActive: true })).toBeNull();
  });

  test('Parcel never shows before 4 stamps unless a parcel was collected', () => {
    // The courier chain always has an active parcel. After the first stamp it
    // used to take the pill for the rest of the visit (GD-01, GP-01).
    const afterFirstStamp = { ...none, districtUnstamped: true, parcelActive: true };
    expect(compassTarget(afterFirstStamp)).toBe('district');
    // Every district stamped but one, and no parcel collected: still districts.
    expect(compassTarget({ ...afterFirstStamp, deliveryOptIn: false })).toBe('district');
    // A parcel collected this session: once the districts are done, parcels.
    expect(compassTarget({ ...none, parcelActive: true, deliveryOptIn: true })).toBe('parcel');
    // The passport complete: parcels, opted in or not.
    expect(compassTarget({ ...none, parcelActive: true, passportComplete: true })).toBe('parcel');
    // Before the fourth stamp and without a parcel collected: never a parcel.
    for (const projectsUnstamped of [true, false]) {
      for (const districtUnstamped of [true, false]) {
        const pick = compassTarget({
          ...none,
          projectsUnstamped,
          districtUnstamped,
          parcelActive: true,
          passportComplete: false,
          deliveryOptIn: false,
        });
        expect(pick).not.toBe('parcel');
      }
    }
  });

  test('Projects breaks the 103.3 m tie with Professional', () => {
    // Both unstamped and equally far: the Projects branch comes first.
    expect(compassTarget({ ...none, projectsUnstamped: true, districtUnstamped: true })).toBe(
      'projects',
    );
  });
});

describe('nearestWithHysteresis: districts switch only when another is 12 u closer', () => {
  test('the nearest wins when nothing is held', () => {
    expect(
      nearestWithHysteresis(null, [
        { id: 'personal', dist: 80 },
        { id: 'contact', dist: 60 },
      ]),
    ).toBe('contact');
  });

  test('the held district stays until another is at least 12 u closer', () => {
    const at = (contact: number) =>
      nearestWithHysteresis('personal', [
        { id: 'personal', dist: 70 },
        { id: 'contact', dist: contact },
      ]);
    expect(at(65)).toBe('personal');
    expect(at(58.5)).toBe('personal');
    expect(at(58)).toBe('contact');
    expect(DISTRICT_HYSTERESIS_U).toBe(12);
  });

  test('a held district that is gone (stamped) is dropped', () => {
    expect(nearestWithHysteresis('projects', [{ id: 'contact', dist: 90 }])).toBe('contact');
    expect(nearestWithHysteresis('projects', [])).toBeNull();
  });
});
