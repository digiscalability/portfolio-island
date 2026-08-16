/**
 * CloudFormations — pure geometry + orbit specs for the sky's cloud layer
 * (approved sky/clouds design, Slice A). No materials, no canvas, no scene:
 * everything here is node-testable, and GameScene wraps the specs in meshes.
 *
 * Replaces the uniform 41-puff scatter with FORMATIONS:
 *  - fair set: cumulus CLUSTERS (one hero + satellites merged into ONE
 *    geometry), a few loner puffs, one merged cirrus streak mesh
 *  - storm set: wide flat slabs + one cumulonimbus tower, hidden when dry
 *
 * ALTITUDE POLICY (the audit's blocking find): the old band (R+6.5) was never
 * relief-scaled, so at R=75 clouds passed straight through the mountain.
 * The band is now (6.5..7.7) x reliefScale. That still sits below the very
 * summit, so every orbit satisfies ONE of two families, pinned by test:
 *   EQUATORIAL family: the orbit never reaches latitude 0.70, so it can never
 *     cross the summit band (0.73-0.79) at any longitude;
 *   POLAR family: the orbit may cross any latitude but rides ABOVE the relief
 *     ceiling (MAX_DISPLACEMENT x reliefScale + 0.7), keeping the sky over
 *     the pole-hub alive without ever clipping rock.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

import { areaScale, reliefScale } from './WorldScale';

export type FormationKind = 'cluster' | 'loner' | 'cirrus' | 'slab' | 'tower';
export type FormationSet = 'fair' | 'storm';

export interface FormationSpec {
  kind: FormationKind;
  set: FormationSet;
  geometry: THREE.BufferGeometry; // merged, vertex-colored, cloud-local
  altitude: number; // radial offset from planet centre
  orbitEuler: [number, number, number]; // pivot euler; drift spins pivot local-Y
  driftSpeed: number;
  polar: boolean; // true = high-altitude family (may cross any latitude)
}

/** Max latitude an orbit reaches = arccos(|orbitNormalY|) — the pivot's local
 *  Y axis is the orbit normal (drift is a local-Y spin, cloud rides local +X). */
export function orbitMaxLat(euler: [number, number, number]): number {
  const n = new THREE.Vector3(0, 1, 0).applyEuler(new THREE.Euler(...euler));
  return Math.acos(Math.min(1, Math.abs(n.y)));
}

const EQUATORIAL_MAX_LAT = 0.7; // summit band starts at 0.73
const MAX_DISPLACEMENT = 9.2; // Island.MAX_DISPLACEMENT (leaf can't import Island)
// Cloud drift authored in WORLD UNITS PER SECOND, not radians — see the
// conversion at the push() below. This range is the shipped R=75 feel
// (omega 0.01-0.03 rad/s at a mean altitude of ~85.65u).
const CLOUD_LINEAR_MIN = 0.86;
const CLOUD_LINEAR_SPAN = 1.71;

/** Underside-darkened vertex colors: white tops, ~18% darker flat bottoms. */
function bakeCloudColors(geo: THREE.BufferGeometry): void {
  geo.computeBoundingBox();
  const bb = geo.boundingBox as THREE.Box3;
  const pos = geo.getAttribute('position');
  const colors = new Float32Array(pos.count * 3);
  const span = Math.max(1e-3, bb.max.y - bb.min.y);
  for (let i = 0; i < pos.count; i++) {
    const t = (pos.getY(i) - bb.min.y) / span; // 0 bottom .. 1 top
    const v = 0.82 + 0.18 * Math.min(1, t * 1.6);
    colors[i * 3] = v;
    colors[i * 3 + 1] = v;
    colors[i * 3 + 2] = v * 0.995; // whisper of warm
  }
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
}

/** One flat-bottomed cumulus: blob spheres merged, undersides clamped. */
function puffGeometry(rng: () => number, coreR: number, blobCount: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  let xCursor = 0;
  for (let idx = 0; idx < blobCount; idx++) {
    const r = idx === 0 ? coreR : coreR * (0.5 + rng() * 0.3);
    const blob = new THREE.SphereGeometry(r, 9, 7);
    blob.scale(1, 0.6, 1);
    blob.rotateY(rng() * Math.PI); // yaw only — never tilt (the stacked-stones trap)
    if (idx === 0) blob.translate(0, r * 0.35, 0);
    else {
      const side = idx % 2 === 1 ? 1 : -1;
      if (idx % 2 === 1) xCursor += r * 0.9;
      blob.translate(side * (coreR * 0.55 + xCursor * 0.6), r * 0.32, (rng() - 0.5) * 0.5);
    }
    parts.push(blob);
  }
  const merged = mergeGeometries(parts, false) as THREE.BufferGeometry;
  // Flat base: clamp everything below y=0 (the painted-cloud signature).
  const pos = merged.getAttribute('position');
  for (let i = 0; i < pos.count; i++) if (pos.getY(i) < 0) pos.setY(i, 0);
  pos.needsUpdate = true;
  merged.computeVertexNormals();
  return merged;
}

/** A cluster: hero puff + satellites laid around it, ONE merged geometry. */
function clusterGeometry(rng: () => number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const hero = puffGeometry(rng, 1.9 + rng() * 0.6, 5 + Math.floor(rng() * 3));
  parts.push(hero);
  const sats = 2 + Math.floor(rng() * 3);
  for (let sIdx = 0; sIdx < sats; sIdx++) {
    const sat = puffGeometry(rng, 0.7 + rng() * 0.4, 2 + Math.floor(rng() * 2));
    const ang = rng() * Math.PI * 2;
    const d = 2.6 + rng() * 2.2;
    sat.translate(Math.cos(ang) * d, (rng() - 0.5) * 0.3, Math.sin(ang) * d);
    parts.push(sat);
  }
  return mergeGeometries(parts, false) as THREE.BufferGeometry;
}

/** Five thin stretched streaks, one merged mesh — high, lit, never additive. */
function cirrusGeometry(rng: () => number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 5; i++) {
    const s = new THREE.SphereGeometry(0.5, 6, 4);
    s.scale(4.5 + rng() * 2.5, 0.1, 0.7 + rng() * 0.4);
    s.translate((rng() - 0.5) * 10, (rng() - 0.5) * 0.6, (rng() - 0.5) * 8);
    parts.push(s);
  }
  return mergeGeometries(parts, false) as THREE.BufferGeometry;
}

function slabGeometry(rng: () => number): THREE.BufferGeometry {
  const s = new THREE.SphereGeometry(1.6, 10, 6);
  s.scale(2.4 + rng() * 0.8, 0.32, 1.5 + rng() * 0.5);
  const pos = s.getAttribute('position');
  for (let i = 0; i < pos.count; i++) if (pos.getY(i) < -0.1) pos.setY(i, -0.1);
  pos.needsUpdate = true;
  s.computeVertexNormals();
  return s;
}

/** Cumulonimbus: stacked bulges + flat anvil, ~7u tall. Grows via scale.y. */
function towerGeometry(rng: () => number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  let y = 0;
  for (let i = 0; i < 4; i++) {
    const r = 2.2 - i * 0.35 + rng() * 0.2;
    const b = new THREE.SphereGeometry(r, 9, 7);
    b.scale(1, 0.72, 1);
    b.translate((rng() - 0.5) * 0.5, y + r * 0.45, (rng() - 0.5) * 0.5);
    y += r * 0.85;
    parts.push(b);
  }
  const anvil = new THREE.SphereGeometry(2.6, 10, 5);
  anvil.scale(1.5, 0.18, 1.1);
  anvil.translate(0.4, y + 0.4, 0);
  parts.push(anvil);
  return mergeGeometries(parts, false) as THREE.BufferGeometry;
}

function equatorialEuler(rng: () => number): [number, number, number] {
  // Orbit normal within EQUATORIAL_MAX_LAT of the pole: tilt the local Y by
  // at most that angle, then spin freely about world Y.
  const tilt = rng() * EQUATORIAL_MAX_LAT * 0.96;
  const spin = rng() * Math.PI * 2;
  return [tilt, spin, 0];
}

function polarEuler(rng: () => number): [number, number, number] {
  return [Math.PI / 2 - rng() * 0.4, rng() * Math.PI * 2, 0];
}

export function buildCloudFormations(
  radius: number,
  rng: () => number = Math.random,
): FormationSpec[] {
  const rs = reliefScale(radius);
  const bandFloor = 6.5 * rs;
  const bandSpan = 1.2 * rs;
  const polarFloor = MAX_DISPLACEMENT * rs + 0.7; // above ALL relief
  const specs: FormationSpec[] = [];
  const push = (
    kind: FormationKind,
    set: FormationSet,
    geometry: THREE.BufferGeometry,
    polar: boolean,
  ): void => {
    bakeCloudColors(geometry);
    // Hoisted so driftSpeed can divide by it. The rng() ORDER is unchanged —
    // altitude, then orbitEuler, then drift — so the seeded stream still
    // hands out the same draws in the same sequence.
    const altitude = radius + (polar ? polarFloor + rng() * 0.8 : bandFloor + rng() * bandSpan);
    specs.push({
      kind,
      set,
      geometry,
      altitude,
      orbitEuler: polar ? polarEuler(rng) : equatorialEuler(rng),
      // AUTHORED AS A LINEAR SPEED, then converted to the angular rate this
      // shell needs — because what a viewer perceives is metres per second
      // across the sky, not radians.
      //
      // The bug: driftSpeed was a bare angular constant on a shell whose
      // altitude is fully radius-proportional (radius * (1.13 + u*0.024), no
      // absolute term). Linear speed = omega*r, so 0.02 rad/s meant 1.71 u/s
      // at R=75 but 2.28 u/s at R=100 — clouds got 33% faster for free in
      // the radius flip. Same trap as the surf bands, and it hid because at
      // the ZENITH the apparent rate is omega*Rc/(Rc-Robs) = 8.04*omega,
      // which is independent of R by construction: looking straight up
      // looked identical, so nobody caught it in review.
      //
      // The range below reproduces the shipped R=75 feel (omega 0.01-0.03 at
      // altitude ~85.65). Dividing by THIS island's altitude makes it hold at
      // any radius, so the next world-size change cannot re-inflate it.
      driftSpeed: (CLOUD_LINEAR_MIN + rng() * CLOUD_LINEAR_SPAN) / altitude,
      polar,
    });
  };
  const clusters = Math.max(4, Math.round(4 * areaScale(radius)));
  const loners = Math.max(2, Math.round(1.8 * areaScale(radius)));
  const slabs = Math.max(3, Math.round(2.7 * areaScale(radius)));
  for (let i = 0; i < clusters; i++) push('cluster', 'fair', clusterGeometry(rng), i < 2);
  for (let i = 0; i < loners; i++)
    push('loner', 'fair', puffGeometry(rng, 0.9 + rng() * 0.5, 3), i === 0);
  push('cirrus', 'fair', cirrusGeometry(rng), true); // cirrus rides high by nature
  for (let i = 0; i < slabs; i++) push('slab', 'storm', slabGeometry(rng), false);
  push('tower', 'storm', towerGeometry(rng), false);
  return specs;
}
