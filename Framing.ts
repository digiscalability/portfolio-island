/**
 * Aspect-aware framing. Leaf module — imports NOTHING (same rule as
 * WorldScale.ts), so both SimpleRenderer and GameScene can use it.
 *
 * three.js `PerspectiveCamera.fov` is the VERTICAL angle, so a fixed fov is
 * pure "Hor+": the horizontal field grows with the window and SHRINKS as the
 * window narrows, with no floor. That is right from 16:10 up (a 21:9 monitor
 * earns its extra width) and badly wrong going narrow — MEASURED on a phone in
 * portrait: 24.3 degrees horizontal, with the avatar eating ~29% of the screen
 * WIDTH. The world became a corridor on the platform half the audience uses.
 *
 * The fix is a horizontal FLOOR: above it, nothing changes (desktop framing is
 * byte-identical); below it, vertical fov opens up until the horizontal field
 * reaches the floor, capped so a very tall window cannot fish-eye.
 *
 * NOT three's setFocalLength/filmGauge: the docs are explicit that filmGauge
 * applies to the LARGER axis, which yields "Vert-" above 1:1 — exactly the
 * behaviour ultrawide owners buy the monitor to avoid.
 */

/** The authored vertical fov. Every look in the game was tuned against it. */
export const BASE_VFOV = 50;
// H_FOV_FLOOR below is derived from this same 50 — keep them in step.

/** The narrowest aspect the world has actually been art-directed against.
 *  Everything at or above this keeps BASE_VFOV to the bit. */
const REFERENCE_ASPECT = 16 / 10;

/** Ceiling on the opened-up vertical fov, so a very tall/narrow window widens
 *  the view without distorting into a fish-eye. */
const V_FOV_CEIL = 68;

const toRad = (d: number): number => (d * Math.PI) / 180;
const toDeg = (r: number): number => (r * 180) / Math.PI;

/** Horizontal floor, DERIVED from the reference aspect rather than written as
 *  a literal. A hand-typed 74 (the researcher's figure) is 0.5 degrees above
 *  16:10's true 73.5, which silently nudged every laptop — caught by the
 *  "desktop is untouched" test. Deriving it makes the no-op exact forever. */
const H_FOV_FLOOR = toDeg(2 * Math.atan(Math.tan(toRad(BASE_VFOV) / 2) * REFERENCE_ASPECT));

/** Horizontal fov (degrees) for a given vertical fov and aspect. */
export function horizontalFov(vFovDeg: number, aspect: number): number {
  return toDeg(2 * Math.atan(Math.tan(toRad(vFovDeg) / 2) * aspect));
}

/**
 * The vertical fov to use at this aspect.
 * Returns BASE_VFOV exactly whenever the horizontal field already clears the
 * floor — so 16:10 and everything wider is untouched, to the bit.
 */
export function framingFov(aspect: number): number {
  if (!Number.isFinite(aspect) || aspect <= 0) return BASE_VFOV;
  // >= with a hair of tolerance: the floor IS the 16:10 value, and float
  // round-trips must not push the reference aspect below its own floor.
  if (horizontalFov(BASE_VFOV, aspect) >= H_FOV_FLOOR - 1e-9) return BASE_VFOV;
  const wanted = toDeg(2 * Math.atan(Math.tan(toRad(H_FOV_FLOOR) / 2) / aspect));
  return Math.min(V_FOV_CEIL, wanted);
}

// ── A9: the tour rail's pacing (pure, so test/framing.test.ts sums it) ──────

/** Shortest and longest planned leg between two tour stops, seconds. */
export const TOUR_LEG_MIN_S = 2.6;
export const TOUR_LEG_MAX_S = 3.35;
/** No leg is planned to turn the view faster than this at its peak (deg/s). */
export const TOUR_PEAK_DEG_S = 120;
/**
 * Seconds the camera studies each stop: 4.0, the floor the plan allows. At
 * 4.5 the full tour ran 50.5 s against its 44 s bar, because the districts'
 * legs arc 63-118 deg round the planet and clamped at 4.2 s; the leg ceiling
 * came down to 3.6 s on 2026-11-13 (call made under Abbas's grant), then to
 * 3.35 s on 2026-11-14 (A9, the 44 s bar, also delegated): fm d-tour measured
 * the full tour at 44.0-44.1 s with a 3.45 s ceiling, 43.9 s at 3.40 and
 * 43.5 s at 3.35, so 3.35 is the first that clears the bar with margin.
 */
export const TOUR_DWELL_S = 4.0;
/** The first leg rises this far (u) over its first TOUR_LIFT_S seconds. */
export const TOUR_LIFT_U = 3;
export const TOUR_LIFT_S = 0.5;
/** A caption, "Stop n of m · " included, is at most this many characters. */
export const TOUR_CAPTION_MAX = 110;

/** easeInOutSine: zero slope at both ends; its peak slope is π/2 at k = 0.5. */
export function easeInOutSine(k: number): number {
  const c = Math.min(1, Math.max(0, k));
  return (1 - Math.cos(Math.PI * c)) / 2;
}

/**
 * A leg's duration: clamp(1.6 + arcDeg × 0.035, 2.6, 3.35) s, where arcDeg is
 * the leg's arc around the planet. A leg whose view would turn `turnDeg` with
 * a peak over TOUR_PEAK_DEG_S under easeInOutSine is lengthened until it
 * does not (peak = π/2 × turnDeg / T).
 */
export function tourLegDuration(arcDeg: number, turnDeg = 0): number {
  const base = Math.min(TOUR_LEG_MAX_S, Math.max(TOUR_LEG_MIN_S, 1.6 + arcDeg * 0.035));
  const peakFloor = (Math.PI / 2) * (Math.abs(turnDeg) / TOUR_PEAK_DEG_S);
  return Math.max(base, peakFloor);
}

/** The first leg's extra height: 0 → TOUR_LIFT_U over TOUR_LIFT_S, fading out as the leg lands. */
export function tourFirstLegLift(t: number, e: number): number {
  const u = Math.min(1, Math.max(0, t / TOUR_LIFT_S));
  return TOUR_LIFT_U * u * u * (3 - 2 * u) * (1 - e);
}

/** A stop's caption with its place in the tour baked in. */
export function tourCaption(n: number, m: number, text: string): string {
  return `Stop ${n} of ${m} · ${text}`;
}

/** Characters as the caption renders them (a code point each, so an escaped dash is one). */
export function renderedLength(text: string): number {
  return [...text].length;
}
