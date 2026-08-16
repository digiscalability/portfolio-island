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

/** Shore crabs (expansion slice 5): beach spots just above the waterline,
 *  kept ≥~10u of arc from the herons, the fisherman and the flock anchors so
 *  every beach has ONE headline animal. */
export const CRAB_SPOTS_AUTHORED: Array<[number, number]> = [
  // Lat 0.23-0.235: ON the sand. 0.25 rendered on the lawn above the beach
  // (screenshot-caught — the shore band tops out around lat 0.26 but this
  // coast's sand narrows well before that).
  [5.18, 0.235],
  [2.28, 0.23],
  [4.22, 0.235],
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

/* ---------------------------------------------------------------------------
 * THE MANTA'S CIRCUIT
 *
 * The manta used to glide a ring centred on the bait ball, holding a depth of
 * 2.4 ± 0.8u and clamped to `max(floor + 1.4, min(sea - 1.3, want))`.
 *
 * MEASURED, and the reason all of this exists: that ring is NOT over uniform
 * water. Three quarters of the circuit crosses a 4.7-5.1u column, but the rest
 * climbs a reef shelf that rises to 0.80u below the surface — and because the
 * floor clearance was the OUTER `max`, it outranked the surface ceiling. On the
 * shelf the animal was pushed to `floor + 1.4` = 0.6u ABOVE MEAN SEA LEVEL.
 * Live probe over a full circuit at both extremes of the depth sine:
 *   14/144 samples airborne (worst 0.60u out of the water, screenshotted)
 *   28/144 shallower than 1u
 *   only 46/144 (32%) below the diver's eye line
 * That is what "the manta swims too shallow" actually was.
 *
 * Re-ordering the clamp alone does NOT fix it: over a 0.80u column there is no
 * depth that is both under the surface and clear of the bottom, so the animal
 * would simply clip through the reef instead of flying over it. A 5.2u-span
 * animal needs deep water, so the CIRCUIT has to move. No ring centred on the
 * bait anchor works — measured minimum floor over a full circuit, by radius:
 *   R=4 -> 1.96u   R=5 -> 1.53u   R=6 -> 1.22u   R=7.5 -> 0.82u   R=9 -> 0.31u
 * — so the centre must shift seaward, which is what solveMantaRing does.
 * ------------------------------------------------------------------------ */

/**
 * Clearance the manta needs under its ORIGIN, in metres.
 *
 * Not a guess and not padding: the wing plate is a flat 5.2u span, so the
 * lowest point is a wingtip, and two things push it down at once —
 *   bank:  `rotateZ(0.18 + 0.1 sin)` tops out at 0.28 rad, and a 2.6u half-span
 *          at 0.28 rad drops 2.6 * sin(0.28) = 0.719u
 *   flap:  the vertex shader adds `mWave * uFlapA * 0.62 * pow(mSpan, 1.6)`,
 *          which at the tip (mSpan = 1) with uFlapA at its 1.0 ceiling is 0.62u
 * Worst case together: 0.719 + 0.62 * cos(0.28) = 1.315u below the origin.
 * 1.4 leaves ~0.08u of margin — TIGHT. Do not shrink it; if the flap amplitude,
 * the bank or the span ever grows, re-derive this from those three numbers.
 */
export const MANTA_FLOOR_CLEAR = 1.4;

/**
 * Depth band, in metres below mean sea level.
 *
 * Anchored to a MEASURED fact about the player, not to taste: a diver's body
 * bottoms out at 3.87u, but the chase camera trails 1.43u above them, so the
 * player's EYE never gets below ~2.49u. Anything shallower than that is seen
 * against the bright surface, which is exactly why the old 1.6-3.2u band read
 * as "swimming on the ceiling" even on the stretches where it wasn't breaching.
 *
 * 2.95 ± 0.55 puts the whole band (2.40-3.50u) at or below the eye line: it
 * rises to meet you at the top of its breath and passes well beneath you at the
 * bottom, and a maxed-out dive can still draw level with it — which is the beat
 * worth having. Deeper than this is not available: the column is only ~5u and
 * MANTA_FLOOR_CLEAR spends 1.4 of it.
 */
export const MANTA_DEPTH_MID = 2.95;
export const MANTA_DEPTH_SWING = 0.55;

/**
 * Never shallower than this, whatever the bottom does.
 *
 * Sized against the LIVE surface, not the mean. `seaLevel()` is mean sea level
 * — tide and swell are visual-only and ride on top of it — and the trough of
 * that motion measures 0.434u BELOW the mean over the manta's water (200 wave
 * clocks x 12 directions). So a non-breaching floor is the wingtip reach plus
 * the trough: 1.315 + 0.434 = 1.749, and 1.85 keeps ~0.1u of skin.
 *
 * The old code's ceiling was 1.3u AND sat inside the floor `max`, so it was
 * routinely overridden; 1.6 (this constant's first value) cleared the mean but
 * would still have shown a wingtip in the air at the bottom of a swell.
 */
export const MANTA_MIN_DEPTH = 1.85;

/** Circuit radius in metres. 7.5 was authored before anyone measured the
 *  seabed under it; 6.0 is what fits in the deep pocket next to the bait ball
 *  (see solveMantaRing). */
export const MANTA_RING = 6.0;

/**
 * Glide speed in u/s — authored as a LINEAR speed, deliberately.
 *
 * The old code held an angular rate (0.084 rad/s) with the radius baked into
 * the feel, so shrinking the ring would have silently slowed the animal down.
 * That is the same trap that inflated cloud drift 33% on the R=75->100 flip:
 * an angular rate on a radius-proportional path is not a speed. 0.084 * 7.5
 * reproduces the shipped 0.63 u/s exactly.
 */
export const MANTA_GLIDE = 0.63;

/** Floor depth the circuit must find to hold the authored band. */
const MANTA_NEED_FLOOR = MANTA_DEPTH_MID + MANTA_FLOOR_CLEAR;

export interface MantaRing {
  lon: number;
  lat: number;
  radius: number;
  /** Shallowest seabed the solved circuit crosses, in metres below sea. */
  minFloor: number;
}

/**
 * A point on the circuit, as lon/lat.
 *
 * Lives here rather than inline in updateManta so the solver, the renderer and
 * the test suite all walk the SAME ring — a test that re-implements the circuit
 * stops testing the shipped path the moment one of them is edited.
 *
 * Returns a small object per call, matching `analyticSurface`, which already
 * mints a Vector3 per frame on this exact code path. The caller expands it to a
 * direction with its own scratch vector, so no Vector3 is allocated per frame.
 */
export function mantaCircuitLonLat(
  island: Island,
  ring: MantaRing,
  angle: number,
): { lon: number; lat: number } {
  const lat = ring.lat + island.arc(Math.sin(angle) * ring.radius);
  // Longitude degrees shrink with latitude — without the cos the "ring" is an
  // ellipse, and progressively worse the further it sits from the equator.
  const lon = ring.lon + island.arc(Math.cos(angle) * ring.radius) / Math.max(0.15, Math.cos(lat));
  return { lon, lat };
}

/**
 * Site the manta's circuit over water that can actually hold it.
 *
 * Walks outward from the bait anchor in 1u steps across 12 compass directions
 * and takes the FIRST (i.e. nearest) centre whose whole circuit clears
 * MANTA_NEED_FLOOR — nearest, because the bait ball is where divers go, and a
 * manta nobody swims past is the same bug as a manta nobody can see. Ties break
 * on the deepest minimum floor. Falls back to the best candidate found if
 * nothing clears, so a reshaped seabed degrades instead of throwing.
 *
 * Deterministic and analytic: zero Math.random draws (it runs inside
 * GameScene.initialize's seeded window, where a single stray draw relocates
 * index-networked vehicles and desyncs multiplayer) and no raycasts
 * (analyticSurface is ~0.003ms). ~2k samples, once, at world build.
 */
export function solveMantaRing(island: Island, lon: number, lat: number): MantaRing {
  const sea = island.seaLevel();
  const radius = MANTA_RING;
  // 48, not 16: at 16 the solver recorded a minimum floor of 4.462 for a ring
  // whose true minimum (walked at 144) is 4.433 — it can accept a circuit
  // ~0.03u shallower than it believes. Harmless against today's threshold,
  // not harmless if the requirement ever tightens. This runs once.
  const SAMPLES = 48;
  const DIRS = 12;

  // Shallowest seabed the SWEPT BAND of a circuit about (cLon, cLat) crosses.
  //
  // The band, not the centre line: the renderer clamps against the ground under
  // the WINGTIPS, 2.4u either side of the path, so a solver that only measured
  // the line would hand back a ring it believed was clear and then watch the
  // tip clamp lift the animal anyway (measured: a 2.30u depth against a 2.40u
  // authored floor, because a tip found ground 0.76u shallower than the line).
  // Both must sample the same geometry or the guarantee is fiction.
  const HALF_SPAN = 2.4;
  const minFloorAround = (cLon: number, cLat: number): number => {
    let worst = Infinity;
    for (const r of [radius - HALF_SPAN, radius, radius + HALF_SPAN]) {
      const probe: MantaRing = { lon: cLon, lat: cLat, radius: r, minFloor: 0 };
      for (let i = 0; i < SAMPLES; i++) {
        const p = mantaCircuitLonLat(island, probe, (i / SAMPLES) * Math.PI * 2);
        const d = sea - island.analyticSurface(island.dirAt(p.lon, p.lat)).radius;
        if (d < worst) worst = d;
      }
    }
    return worst;
  };

  let best: MantaRing = { lon, lat, radius, minFloor: minFloorAround(lon, lat) };
  if (best.minFloor >= MANTA_NEED_FLOOR) return best;

  for (let step = 1; step <= 10; step++) {
    let bestAtStep: MantaRing | null = null;
    for (let d = 0; d < DIRS; d++) {
      const a = (d / DIRS) * Math.PI * 2;
      const cLat = lat + island.arc(Math.sin(a) * step);
      const cLon = lon + island.arc(Math.cos(a) * step) / Math.max(0.15, Math.cos(cLat));
      const minFloor = minFloorAround(cLon, cLat);
      if (!bestAtStep || minFloor > bestAtStep.minFloor) {
        bestAtStep = { lon: cLon, lat: cLat, radius, minFloor };
      }
    }
    if (!bestAtStep) continue;
    if (bestAtStep.minFloor > best.minFloor) best = bestAtStep;
    // Nearest ring that clears the requirement wins outright.
    if (bestAtStep.minFloor >= MANTA_NEED_FLOOR) return bestAtStep;
  }
  return best;
}

/**
 * Where the manta may sit, given the bottom beneath it and where it wants to be.
 *
 * The ORDER is the whole point. The shipped form was
 * `max(floorR + 1.4, min(sea - 1.3, want))`, which lets the floor clearance
 * outrank the surface ceiling and lifts the animal into the air over a shelf.
 * Here the surface always wins: `deepest` collapses toward MANTA_MIN_DEPTH when
 * the column is too thin for both constraints, so a too-shallow bottom makes
 * the manta clip rather than fly. Clipping is recoverable and reads as the
 * animal passing behind the reef; flying does not and reads as a bug.
 * solveMantaRing exists so this branch never gets taken in practice.
 *
 * @param floorDepth metres from mean sea level down to the seabed
 * @param want       metres of depth the animal is breathing toward
 * @returns          metres below mean sea level to place the origin
 */
export function mantaDepthFor(floorDepth: number, want: number): number {
  const deepest = Math.max(MANTA_MIN_DEPTH, floorDepth - MANTA_FLOOR_CLEAR);
  return Math.min(deepest, Math.max(MANTA_MIN_DEPTH, want));
}
