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
 * The order the pill picks its target in (compassTarget) lives here too.
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

/**
 * Where the pill points, one target at a time (A7, with P2-A3's order).
 *
 * The first available source wins:
 * 1. the island-map pick, and for 8 s after it is reached, the arrival hold;
 * 2. the race-start guide;
 * 3. meet-the-townsfolk;
 * 4. the trail villager, while the first-visit coins are down, until the
 *    visitor reaches them, stamps a district or picks a place (a missed coin
 *    must not pull the pill back to the spawn), or the villager goes to bed;
 * 5. the villager First steps sends the visitor to talk to, where they stand
 *    now, while its talk step is on the card or still ahead and no district
 *    is stamped. A reload has no trail coins, and the trail also ends at its
 *    seat before the visitor has said a word; without this the card said
 *    "Walk up to <name>" while the pill named Projects;
 * 6. Projects, until it is stamped (Projects and Professional tie at
 *    103.3 m from the spawn, so "nearest" alone flipped between them);
 * 7. the nearest unstamped district;
 * 8. a parcel, but only once the passport is complete or the visitor has
 *    collected a parcel this session: the ten-stop courier chain used to take
 *    the pill at the first stamp and never give it back;
 * 9. the Next chip's goal (P2-A12), when it names a place: last, so it only
 *    has the pill when nothing above sets a target, and rung 1 (Projects,
 *    then the other districts) always comes first;
 * 10. nothing.
 */
export type CompassSource =
  | 'map'
  | 'hold'
  | 'race'
  | 'ai'
  | 'trail'
  | 'talk'
  | 'projects'
  | 'district'
  | 'parcel'
  | 'goal';

export interface CompassState {
  /** An island-map pick (or a 'ds:guide-to' key) is set. */
  mapPick: boolean;
  /** A map pick was reached under 8 s ago: the pill holds on it. */
  arrivalHold: boolean;
  /** The welcome card is up and First steps arms as it closes. With no
   *  trail or talk villager yet, the pill waits for the guide rather than
   *  fall back: on a reload it read Projects behind the card and then
   *  switched to the villager the moment Explore armed the guide. */
  guidePending: boolean;
  /** "Beat the lap record": the start gate. */
  raceGuide: boolean;
  /** "Ask the townsfolk": the Storyteller. */
  aiGuide: boolean;
  /** A trail villager was chosen at Explore, its coins are still down, and
   *  the visitor has not reached it, stamped a district or picked a place;
   *  the villager has not gone to bed. */
  trailVillager: boolean;
  /** First steps' talk step is on the card or ahead (not collapsed to the
   *  chip), its villager is in the world, and no district is stamped. */
  talkStep: boolean;
  /** Projects exists and is not stamped. */
  projectsUnstamped: boolean;
  /** Another district is unstamped. */
  districtUnstamped: boolean;
  /** An active delivery has a mailbox to go to. */
  parcelActive: boolean;
  passportComplete: boolean;
  /** A parcel was collected this session. */
  deliveryOptIn: boolean;
  /** The Next chip is on and its goal names a place (P2-A12). */
  goal: boolean;
}

export function compassTarget(s: CompassState): CompassSource | null {
  if (s.mapPick) return 'map';
  if (s.arrivalHold) return 'hold';
  if (s.raceGuide) return 'race';
  if (s.aiGuide) return 'ai';
  if (s.trailVillager) return 'trail';
  if (s.talkStep) return 'talk';
  // Not yet the fallbacks: the guide's villager takes the pill once it arms.
  if (s.guidePending) return null;
  if (s.projectsUnstamped) return 'projects';
  if (s.districtUnstamped) return 'district';
  if (s.parcelActive && (s.passportComplete || s.deliveryOptIn)) return 'parcel';
  if (s.goal) return 'goal';
  return null;
}

/** How much closer another district must be before the pill switches to it. */
export const DISTRICT_HYSTERESIS_U = 12;

/**
 * The nearest candidate, except that the current one is kept until another
 * is at least `margin` closer: walking between two districts of nearly equal
 * distance must not flip the pill back and forth.
 */
export function nearestWithHysteresis(
  current: string | null,
  candidates: ReadonlyArray<{ id: string; dist: number }>,
  margin = DISTRICT_HYSTERESIS_U,
): string | null {
  let best: { id: string; dist: number } | null = null;
  let cur: { id: string; dist: number } | null = null;
  for (const c of candidates) {
    if (!best || c.dist < best.dist) best = c;
    if (c.id === current) cur = c;
  }
  if (!best) return null;
  if (cur && best.dist > cur.dist - margin) return cur.id;
  return best.id;
}
