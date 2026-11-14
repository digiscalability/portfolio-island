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
 * MOT-06: the flight's ORIENTATION turns on its own ease, a cosine-ramped
 * trapezoid: the turn rate rises smoothly over the first TOUR_TURN_RAMP of
 * the leg, holds, and falls over the last. Its peak slope is 1/(1 − ramp)
 * (1.11) against easeInOutSine's π/2 (1.57), so the same turn in the same
 * time peaks 29% slower. Under easeInOutSine leg 1 peaked at 106-116 deg/s,
 * and at that rate any frame over ~18 ms broke the probe's 2 deg/frame bar.
 */
export const TOUR_TURN_RAMP = 0.1;
/** No leg turns the camera faster than this (deg/s): 2 deg holds to 25 ms frames. */
export const TOUR_TURN_PEAK_DEG_S = 80;
/**
 * No single frame turns the tour camera more than this (deg). A slow frame
 * (a busy host, a GC pause) would otherwise turn rate × dt: at 80 deg/s a
 * 25 ms frame is 2 deg. The camera lags the rail by the excess and catches
 * up on the next frames (80 deg/s is 1.33 deg at 60 fps); the leg lands only
 * once it has caught up.
 */
export const TOUR_TURN_MAX_STEP_DEG = 1.8;
/** easeTourTurn's peak slope (de/dk), reached on the plateau. */
export const TOUR_TURN_PEAK_SLOPE = 1 / (1 - TOUR_TURN_RAMP);

/** The tour's orientation ease: 0 → 1, flat ends, continuous rate and acceleration. */
export function easeTourTurn(k: number): number {
  const c = Math.min(1, Math.max(0, k));
  const a = TOUR_TURN_RAMP;
  const p = TOUR_TURN_PEAK_SLOPE;
  if (c > 0.5) return 1 - easeTourTurn(1 - c);
  if (c < a) return p * (c / 2 - (a / (2 * Math.PI)) * Math.sin((Math.PI * c) / a));
  return p * (a / 2 + (c - a));
}

/**
 * MOT-06: a leg long enough that a turn whose largest rate is `maxDegPerE`
 * (degrees per unit of ease) stays under TOUR_TURN_PEAK_DEG_S on easeTourTurn.
 */
export function tourTurnFloor(maxDegPerE: number): number {
  return (TOUR_TURN_PEAK_SLOPE * Math.abs(maxDegPerE)) / TOUR_TURN_PEAK_DEG_S;
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

// ---- The villager stop ("N townsfolk talk through Claude Haiku 4.5") ----
// A play review found the stop framed a villager 11 u away from behind, 15% of
// a desktop frame tall (10% on a phone), with a market awning, a signpost, a
// tree canopy or a parked car filling the foreground. One ray to the head
// was the only test. The camera now sits closer, and each candidate bearing
// is scored on the whole frame and on which way the villager faces.

/** Camera height above the villager and set-back along the bearing (u): about
 *  6.6 u from the feet, so a 1.8 u villager is about a quarter of the frame. */
export const TOUR_VILLAGER_ALT = 3.4;
export const TOUR_VILLAGER_BACK = 5.6;

/** Candidate bearings about the villager's up (12 = every 30 degrees). */
export const TOUR_BEARINGS = 12;

/** The frame's sample points, in normalised device coordinates: 5 across the
 *  inner 90% by 4 down, the lower rows where foreground props intrude. */
export const TOUR_CLUTTER_GRID: ReadonlyArray<readonly [number, number]> = (() => {
  const pts: Array<readonly [number, number]> = [];
  for (const y of [-0.85, -0.45, 0, 0.45]) {
    for (const x of [-0.9, -0.45, 0, 0.45, 0.9]) pts.push([x, y] as const);
  }
  return pts;
})();

/** A grid ray counts as clutter when it hits something nearer than this share
 *  of the camera's distance to the villager. */
export const TOUR_CLUTTER_NEAR = 1.0;

/** How much a face-on view is worth against clutter: a bearing that sees the
 *  villager's back costs as much as this share of the grid blocked. */
export const TOUR_FACE_WEIGHT = 0.4;

/** One candidate bearing for the villager stop. */
export interface TourBearing {
  /** Turn about the villager's up (radians), as frameTourStop takes it. */
  turn: number;
  /** Nothing between the camera and the villager's head. */
  headClear: boolean;
  /** Share of TOUR_CLUTTER_GRID's rays blocked near the camera (0..1). */
  clutter: number;
  /** cos of the angle between the villager's front and the way to the camera
   *  (1 = face on, -1 = their back). */
  facing: number;
}

/** The cost of one bearing: clutter, plus TOUR_FACE_WEIGHT for a back view. */
export function tourBearingCost(b: TourBearing): number {
  return b.clutter + (TOUR_FACE_WEIGHT * (1 - b.facing)) / 2;
}

/**
 * The bearing to frame a villager from: the cheapest whose head is clear.
 * Ties go to the earlier candidate. null when every head ray is blocked (the
 * caller keeps its default framing).
 */
export function pickTourBearing(cands: readonly TourBearing[]): TourBearing | null {
  let best: TourBearing | null = null;
  let bestCost = Infinity;
  for (const c of cands) {
    if (!c.headClear) continue;
    const cost = tourBearingCost(c);
    if (cost < bestCost - 1e-9) {
      best = c;
      bestCost = cost;
    }
  }
  return best;
}

/** Villagers up and about, in the stop's order, scored for the stop. */
export const TOUR_VILLAGER_TRIES = 4;

/** What each later place in that order costs, against tourBearingCost. */
export const TOUR_VILLAGER_RANK_COST = 0.05;
