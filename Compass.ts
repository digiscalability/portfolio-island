/**
 * The gold ➤ compass arrow's bearing.
 *
 * SimpleUI draws the glyph with `rotate(bearing − 90°)`: at 0° the ➤ points
 * right and at −90° straight up the screen, where the camera looks. CSS
 * rotate() turns clockwise, so the bearing must be POSITIVE for a target to
 * the camera's right and negative for one to its left.
 *
 * main-simple used to send atan2((camForward × toTarget) · n, camForward ·
 * toTarget), with n the outward surface normal. For a target on the right
 * that cross product points INTO the planet, so the sign was flipped and the
 * arrow showed every off-axis target on the mirror side (measured: 24 of 24
 * samples on the wrong side, mean error 148°). Every compass user shares this
 * one pill — the portfolio guide, deliveries, island-map picks, the race
 * guide and "Ask the townsfolk" — so they are all fixed here. The radar and
 * the island-map heading are separate code paths.
 *
 * Pure, so test/compassArrow.test.ts runs it without a scene.
 */

/** Any {x, y, z} (THREE.Vector3 included). */
export interface Vec3Like {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/**
 * Signed angle in radians, (−π, π], from `camForward` to `toTarget` about
 * `normal`: positive when the target is to the RIGHT (clockwise on screen),
 * 0 straight ahead, ±π behind. Both directions should be projected onto the
 * tangent plane of `normal`; their lengths do not matter.
 *
 * This is exactly the negation of the old atan2((camForward × toTarget) · n,
 * …): it uses (toTarget × camForward) · n, whose terms are the old ones
 * negated, so even the ±0 and ±π edge cases mirror.
 */
export function compassBearing(camForward: Vec3Like, toTarget: Vec3Like, normal: Vec3Like): number {
  const cx = toTarget.y * camForward.z - toTarget.z * camForward.y;
  const cy = toTarget.z * camForward.x - toTarget.x * camForward.z;
  const cz = toTarget.x * camForward.y - toTarget.y * camForward.x;
  const dot = camForward.x * toTarget.x + camForward.y * toTarget.y + camForward.z * toTarget.z;
  return Math.atan2(cx * normal.x + cy * normal.y + cz * normal.z, dot);
}
