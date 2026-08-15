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
 *  the R50→R75 plan and test/radiusUnits.test.ts before touching it.
 *
 *  75 -> 100 (2026-08-16). Measured cost of the naive flip: total island verts
 *  1.21M -> 2.11M (+75%), terrain 190k -> 338k, grass tufts 9.7k -> 18.0k,
 *  colliders 102 -> 193, synchronous island build 1.11s -> 3.88s (3.5x). Two
 *  levers land WITH the flip to pay for it: GRASS_SLOT_BUDGET holds grass verts
 *  flat (Island.createGrass) and FAUNA_BELT_CAP freezes the animal cast
 *  (GameScene), because scaling fauna is exactly what blew the draw budget on
 *  the R=50->75 migration. */
export const WORLD_RADIUS = 100;

/**
 * Ceiling on beltScale() for the ANIMAL CAST specifically.
 *
 * Cats/birds/gulls are 12-40 draws EACH — the single most expensive thing per
 * unit of population in the world, and scaling them by the belt is what blew
 * the draw budget on the last migration. Freezing the cast at its R=75 size
 * means creatures sit further apart on a bigger island; the answer to that is
 * making them REACT to you (cheap) rather than adding more of them (expensive).
 */
export const FAUNA_BELT_CAP = 1.5;

/** beltScale clamped for fauna — see FAUNA_BELT_CAP. */
export function faunaBelt(radius: number = WORLD_RADIUS): number {
  return Math.min(beltScale(radius), FAUNA_BELT_CAP);
}

/**
 * Atmospheric fog is tuned as a PRODUCT with the radius (density x R = 0.45,
 * established over three grows: 0.02@R22, 0.015@R30, 0.009@R50) so the far
 * side of the island stays visible at any size. Lives here (leaf) so both
 * GameScene (base density) and EnvironmentCycle (weather multipliers) derive
 * from one number without a circular import.
 */
export const FOG_DENSITY_X_RADIUS = 0.45;

/**
 * Submerged fog density — an ABSOLUTE value, deliberately NOT radius-derived.
 *
 * Island-visibility fog is tuned as a product with the radius (above) so the
 * far side of the island stays visible as the world grows. Underwater murk is
 * the opposite: how far you can see through water is a HUMAN-scale property,
 * like WAVE_AMP, and has nothing to do with how big the planet is.
 *
 * It used to be written as a MULTIPLIER on the island fog (`density *= 1 + f*19`),
 * which silently coupled it to the radius: the R=75->100 flip dropped it from
 * 0.120 to 0.090 (-25%) and opened underwater sight distance from ~14.4u to
 * ~19.2u (+33%) — while the seabed simultaneously got DEEPER. The murk that had
 * been verified at 0.12 quietly stopped being 0.12.
 */
export const UNDERWATER_FOG_DENSITY = 0.12;

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
