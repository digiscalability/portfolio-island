/**
 * The world's size, in one place.
 *
 * This module exists because the radius used to be declared at a CALL SITE —
 * `new Island(50)` inside GameScene — which meant nothing outside the scene
 * could see it. Anything that needed the number copied it: SoftLook baked
 * `50.35` (sea shell + 0.25) into a global shader chunk, and at any other radius
 * that silently switched height fog off with no error and no test to catch it.
 *
 * It must import NOTHING. Island imports SimpleRenderer, SimpleRenderer imports
 * SoftLook — so anything both Island and SoftLook depend on has to be a leaf, or
 * the graph goes circular.
 *
 * Two unit systems live in this codebase and radius is the exchange rate:
 *  - ANGULAR (lon/lat, claim arcs, wander steps) — scales for free.
 *  - ABSOLUTE (buildings, colliders, speeds, relief heights) — does not.
 * Write spacing as `metres / radius`, never as a radian you worked out by hand.
 */

/** The radius every absolute constant in the codebase was authored against. */
export const REFERENCE_RADIUS = 50;

/** The live world radius. Changing this is a migration, not an edit — see §3 of
 *  the R50→R75 plan and test/radiusUnits.test.ts before touching it. */
export const WORLD_RADIUS = 75;

/**
 * Namespace for anything PERSISTED that is only comparable within one world size.
 *
 * Race times are the case that forced this: a lap at R=75 is ~50% longer, and
 * submitRaceTime rejects any time slower than the stored best. Ship a bigger
 * world against the old records and every board freezes permanently at times
 * nobody can ever beat — and the cloud copy survives a client redeploy, so the
 * only fix would be deleting the RTDB node by hand.
 *
 * Derived from the radius, so resizing the world always starts a fresh board
 * rather than requiring someone to remember this.
 */
export const WORLD_ERA = `r${WORLD_RADIUS}`;

/** Calm water surface offset above the base sphere, at REFERENCE_RADIUS. */
export const SEA_OFFSET = 0.1;

/**
 * Multiplier on absolute RELIEF heights so the world's silhouette (height over
 * radius, i.e. the angular profile you actually see) is radius-invariant.
 * Deliberately NOT applied to wave amplitude: swell is ridden by boats and
 * swimmers, which stay human-sized.
 */
export function reliefScale(radius: number = WORLD_RADIUS): number {
  return radius / REFERENCE_RADIUS;
}

/** Radius of the calm water surface at a given world radius. */
export function seaLevelFor(radius: number = WORLD_RADIUS): number {
  return radius + SEA_OFFSET * reliefScale(radius);
}

/**
 * Surface-area multiplier vs the reference world — for populations scattered
 * across the whole sphere (grass, trees, rocks, clouds, coins, fauna spots).
 *
 * These were all HARD CAPS, not densities: `placed < TREE_CAP` stops at 96 no
 * matter how much ground there is, so growing the world silently thins it out
 * rather than failing loudly. R=75 is 2.25x the area.
 */
export function areaScale(radius: number = WORLD_RADIUS): number {
  const k = radius / REFERENCE_RADIUS;
  return k * k;
}

/**
 * Circumference multiplier — for populations strung along a LINE rather than
 * spread over the surface: the coastal palm belt, boulevard lamp spacing, the
 * shoreline. These grow with x1.5, not x2.25; using areaScale here would crowd
 * the shore and double-count the lamps.
 */
export function beltScale(radius: number = WORLD_RADIUS): number {
  return radius / REFERENCE_RADIUS;
}
