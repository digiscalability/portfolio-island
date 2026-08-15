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
