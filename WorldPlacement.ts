/**
 * WorldPlacement — world-size-aware placement helpers shared by GameScene and
 * the headless test suite.
 *
 * Lives OUTSIDE GameScene deliberately: the tests construct real Islands under
 * happy-dom (test/islandRadius.test.ts) and must be able to import these
 * without dragging in GameScene's 10k-line import graph.
 */
import type * as THREE from 'three';

import { Island } from './Island';
import { OrbitCamera } from './OrbitCamera';

/**
 * The hand-authored fauna site lists ([lon, lat]), hoisted from GameScene so
 * the headless test suite can pin the placement gates against the REAL data.
 * Weighted toward the hub/high latitudes where players actually walk — do not
 * regenerate these mechanically.
 */
export const BIRD_SPOTS: Array<[number, number]> = [
  // First spot sits ~6u off spawn — inside the flush radius it would
  // flee before the player ever saw a bird on the ground.
  [0.55, 1.24],
  [2.4, 1.32],
  [4.2, 1.22],
  [1.4, 1.05],
  [5.6, 0.95],
  [0.35, 0.8],
  [1.9, 0.75],
  [3.4, 0.9],
  [5.0, 0.34],
  [2.0, 0.34],
  [0.5, 0.6],
  [4.4, 0.55],
];

export const CAT_SPOTS_AUTHORED: Array<[number, number]> = [
  [0.9, 1.18],
  [2.7, 1.06],
  [4.7, 1.12],
  [1.7, 0.82],
  [3.9, 0.7],
  [5.3, 0.5],
  [0.35, 0.95], // bengal — meadow west of the hub
  [5.75, 0.74], // persian — lawn near the shore road
];

export const FLOCK_ANCHORS: Array<[number, number]> = [
  [5.0, 0.24],
  [2.0, 0.24],
  [3.6, 0.24],
  [0.9, 1.05],
];

/**
 * Grow a hand-authored [lon, lat] site list to `target` entries.
 *
 * These lists are NOT arithmetic — the bird spots are "weighted toward the
 * hub/high latitudes where players actually walk (the old set was mostly remote
 * shores nobody visited)". Inventing new coordinates would throw that judgement
 * away. So extras reuse an authored spot's LATITUDE (keeping the band, and the
 * intent) and offset only the LONGITUDE by a golden angle, which spreads them
 * around the ring without clumping.
 *
 * Generated candidates (never the authored prefix — those are hand-vetted) can
 * be filtered through `accept`; failures are DROPPED, so the result may fall
 * short of `target`. That is intentional: a missing bird beats a bird standing
 * inside the summit, which is exactly what ungated generation produced at R=75.
 *
 * Returns the original array untouched when it is already long enough, so the
 * reference world is bit-identical.
 */
export function growSiteRing(
  sites: Array<[number, number]>,
  target: number,
  accept?: (lon: number, lat: number) => boolean,
): Array<[number, number]> {
  if (target <= sites.length) return sites;
  const golden = Math.PI * (3 - Math.sqrt(5));
  const out = sites.slice();
  for (let i = sites.length; i < target; i++) {
    const [baseLon, lat] = sites[i % sites.length];
    const lon = (baseLon + golden * (1 + Math.floor(i / sites.length))) % (Math.PI * 2);
    if (accept && !accept(lon, lat)) continue;
    out.push([lon, lat]);
  }
  return out;
}

/**
 * Elevation ceiling for generated ground-fauna spots, as a fraction of the
 * relief ceiling so it tracks MAX_DISPLACEMENT at any radius. 0.35 ≈ 3.2u
 * above sea at R=50 — above that is hillside/crag, where a pecking bird or a
 * lounging cat reads wrong AND where the ungated generator actually put one
 * (bird spot #17 landed inside the summit's crag zone at R=75).
 */
const FAUNA_MAX_ELEV_FRACTION = 0.35;

/** Ground fauna can stand here: on land, off the streets, below the hills. */
export function faunaElevOk(island: Island, dir: THREE.Vector3): boolean {
  const relief = island.getRadius() / Island.REFERENCE_RADIUS;
  return (
    island.analyticSurface(dir).radius - island.seaLevel() <=
    Island.MAX_DISPLACEMENT * FAUNA_MAX_ELEV_FRACTION * relief
  );
}

export function faunaGroundSpotOk(island: Island, lon: number, lat: number): boolean {
  const dir = island.dirAt(lon, lat);
  return !island.isNearStreet(dir) && !island.isOverWater(dir) && faunaElevOk(island, dir);
}

/**
 * The camera distance below which the player counts as "near the ground" —
 * close-range ambience (dust, sparkles, smoke, butterflies, guide sparkles)
 * only renders inside this.
 *
 * Worst case chase pose: player on the highest summit, camera at max zoom and
 * max height. The old literal (`radius + 6`) was tuned when relief topped out
 * lower; once relief scaled with the radius, standing on any hill pushed the
 * camera past it and ALL ambient life silently vanished — the "not rendering
 * properly" report. The fly-in sits at ~3.7x the radius, so near/far stays
 * unambiguous.
 */
export function camNearThreshold(island: Island): number {
  return island.maxTerrainRadius() + OrbitCamera.MAX_DISTANCE + OrbitCamera.MAX_HEIGHT * 0.5 + 2;
}
