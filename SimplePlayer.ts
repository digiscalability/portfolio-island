import * as THREE from 'three';
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js';

import { a11y } from './Accessibility';
import { applyCelRim, isCelTheme } from './CelLook';
import { fx } from './FxBudget';
import { easeOutBack, tween as juiceTween } from './Juice';
import { Materials } from './Materials';
import { loadGLTFWithFallbacks, setupModelAnimation } from './utils/GLTFModelLoader';

/** A remote player's rendered avatar — the SAME rigged model the local
 * player uses, so a visitor looks identical on every screen. */
export interface RemoteAvatar {
  body: THREE.Group;
  headBone: THREE.Object3D | null;
  update: (dt: number, speed: number) => void;
  // Pose byte broadcast by the owner (0 on-foot, 1 swimming, 2 riding, 3 airborne)
  // so peers strike the right pose instead of always walk-cycling upright.
  setPose: (pose: number) => void;
  // Vertical + horizontal speed of the peer, so a DIVING visitor reads as
  // diving rather than as a flat surface swimmer. Derived by Multiplayer from
  // the position stream — see swimPitchTarget.
  setSwimMotion: (radialRate: number, tangSpeed: number) => void;
  // Play the arm-raise wave gesture (mirrors the local player's Q wave).
  wave: () => void;
  dispose: () => void;
}

/* --------------------------------------------------------------------------
 * SWIM PITCH — one definition, used by the local player AND by every remote
 * peer. Kept as a pure module function on purpose: a pose written twice and
 * fixed once is this codebase's single most repeated defect (CLAUDE.md world
 * law 2, "fix both or other players stay broken"), and the remote copy had
 * already drifted to a hardcoded 1.35.
 * ----------------------------------------------------------------------- */

/** Near-flat crawl. */
export const SWIM_PRONE = 1.35;
/** Upright-ish water tread. */
export const SWIM_TREAD = 0.45;
/**
 * Ceiling on the travel-aligned dive pitch, in radians.
 *
 * A player holding dive with no forward input descends straight down, and a
 * perfectly aligned body there (PI) would be a literal handstand. Bounded by
 * TWO independent limits, which very nearly agree:
 *
 * READABILITY, chosen by staging three pitches on the real avatar: 2.45 rad
 * (140 deg) is a head-first plunge with the legs vertical — readable, but it
 * stops looking like swimming; 2.04 (117 deg) is what an ordinary dive settles
 * into and looks right; 2.2 (126 deg) is head-down and angled with the legs
 * trailing up behind, still a swimmer at the steepest descent the game allows.
 *
 * THE SEABED. Pitch rotates the model about its own origin, which sits at the
 * FEET, so a head-down body reaches further below the player root than an
 * upright one and DIVE_FLOOR_GAP (0.85) stops being enough. Measured on the
 * rig, lowest vertex below the root: pitch 0 -> 0.700 (exactly playerHeight,
 * which validates the probe), 1.35 -> 0.443, 2.04 -> 0.751, 2.15 -> 0.835,
 * 2.20 -> 0.870, 2.45 -> 1.017. Anything past ~2.17 pokes the head through the
 * floor at the clamp; 2.15 keeps the whole body inside the existing gap with
 * 0.015u to spare and costs no dive depth.
 *
 * NOTE this is the OPPOSITE correction to the one an earlier review guessed at.
 * It rejected a proposed fixed SWIM_DIVE = 1.85 as "reads as falling" and
 * suggested ~1.6 — i.e. LESS pitch. Measured on a real descent, the body was
 * already 104-123 degrees away from its direction of travel at pitch 0.65,
 * descending broadside-on. It reads as falling because it is not aligned with
 * where it is going; the fix is MORE pitch, tracked to the travel direction,
 * not a smaller constant.
 */
export const SWIM_DIVE_MAX = 2.15;
/** Vertical rate (u/s) below which the pose ignores the water's own motion. */
export const SWIM_VERT_DEADBAND = 0.25;
/** Descent rate a full dive holds; the alignment weight is normalised by it. */
export const SWIM_DIVE_SPEED = 2.6;

/**
 * Limb deltas for a REMOTE peer's riding pose, as offsets from the rig rest
 * (world law 2: arms rest at -PI, legs at +PI).
 *
 * The pose byte says only "riding" — it carries no boat/jetski split — so one
 * blended attitude has to serve both. These sit between the local player's two
 * variants in applyRidePose (arms -0.5 boat / -0.95 jetski, legs 0.0 / -1.15),
 * which is what they were originally chosen for; they were just never anchored
 * to the rest, so they landed 180 degrees out.
 */
export const RIDE_PEER_ARM_X = -0.7;
export const RIDE_PEER_LEG_X = -0.6;

/**
 * The body pitch a swimmer should hold, in radians.
 *
 * rotation.x = theta puts the feet->head axis at (0, cos theta, sin theta):
 * 0 upright, PI/2 horizontal head-forward, past that head-DOWN. Travel in the
 * same frame is (0, radialRate, tangSpeed), so the pitch that points the body
 * where it is going is just the atan2 of the two — no forward vector needed,
 * because the avatar already faces its horizontal heading.
 *
 * @param radialRate u/s away from the planet centre — NEGATIVE while descending
 * @param tangSpeed  u/s across the surface
 * @param moving     stroking rather than holding station
 * @param diving     the dive is being held (local: isDiving; remote: inferred)
 */
export function swimPitchTarget(
  radialRate: number,
  tangSpeed: number,
  moving: boolean,
  diving: boolean,
): number {
  let target = moving ? SWIM_PRONE : SWIM_TREAD;
  const vertical = Math.abs(radialRate);
  if (vertical > SWIM_VERT_DEADBAND) {
    const align = Math.min(SWIM_DIVE_MAX, Math.atan2(Math.max(0, tangSpeed), radialRate));
    const w = Math.min(1, (vertical - SWIM_VERT_DEADBAND) / (SWIM_DIVE_SPEED - SWIM_VERT_DEADBAND));
    target += (align - target) * w;
  }
  // HOLDING AT DEPTH IS STILL DIVING. The pitch above is derived from the
  // vertical RATE, and a diver who has reached the floor — or the 4.2u depth
  // ceiling — has a rate of zero. Without this floor the body eases all the
  // way back to TREAD and stands bolt upright 4u down while the player is
  // still holding the dive key. Face-down and streamlined is what hovering at
  // the bottom should look like.
  return diving ? Math.max(target, SWIM_PRONE) : target;
}

/** Cosmetic hats sold in the island shop. */
export type HatId =
  | 'party'
  | 'top'
  | 'crown'
  | 'cap'
  | 'flower'
  | 'wizard'
  | 'halo'
  | 'pirate'
  | 'chef'
  | 'headphones';

/** Recolourable body parts (mapped to the model's named materials). */
export type BodyPart = 'outfit' | 'pants' | 'hair' | 'skin';
const PART_MATERIAL: Record<BodyPart, string> = {
  outfit: 'Jacket',
  pants: 'Pants',
  hair: 'Hair',
  skin: 'Skin',
};

type LimbKey = 'armL' | 'armR' | 'legL' | 'legR';
const LIMB_KEYS: readonly LimbKey[] = ['armL', 'armR', 'legL', 'legR'];
const _limbAxisX = new THREE.Vector3(1, 0, 0);
const _limbTurn = new THREE.Quaternion();
const _limbDelta = new THREE.Quaternion();
const _swimTurn = new THREE.Quaternion();
const _swimResid = new THREE.Quaternion();
const _swimIdent = new THREE.Quaternion();

// ── The gait layer (B3) ─────────────────────────────────────────────────────
// MEASURED on player.glb (world law 3, rig read in a unit test): the Walk clip
// lasts 1.0 s and swings each leg 0.65 rad about its rest (each arm 0.50).
// The legs are 0.61 u from hip to sole. A planted foot moves back at the
// leg's angular speed times its length, so the body speed a stride carries is
// v = 2π · f · 0.61 · swing · g (f cycles/s, g the swing gain).
/** The Walk clip's leg swing about rest, radians (measured). */
export const GAIT_SWING = 0.65;
/** Hip-to-sole length, u. */
export const GAIT_LEG = 0.61;
/** Peak leg angle about rest: 0.9 rad, so the gain caps at 0.9 / swing. */
export const GAIT_G_MAX = 0.9 / GAIT_SWING;

/** Gait cadence in cycles/s at ground speed `v` (u/s). The brief's
 *  0.9 + 0.12v, raised where the capped stride cannot carry the speed. */
export function gaitCadence(v: number): number {
  const s = Math.max(0, v);
  return Math.max(0.9 + 0.12 * s, s / (2 * Math.PI * GAIT_LEG * GAIT_SWING * GAIT_G_MAX));
}

/** The legs' swing gain at ground speed `v`: 1 at a stroll, gMax at a walk
 *  and above. The arms take 1 + 0.6(g − 1). */
export function gaitLegGain(v: number): number {
  const s = Math.max(0, v);
  const g = s / (2 * Math.PI * gaitCadence(s) * GAIT_LEG * GAIT_SWING);
  return THREE.MathUtils.clamp(g, 1, GAIT_G_MAX);
}

/** Analog stick speed: the target speed's share at deflection `m` (0..1).
 *  A keyboard (m = 1) keeps the full speed. */
export function stickSpeedScale(m: number): number {
  return 0.35 + 0.65 * THREE.MathUtils.smoothstep(m, 0.12, 0.7);
}

/** Heading: the turn-rate cap (rad/s), the ease rate, and the pivot that
 *  opens a turn over 120°. Tuned so a 180° reversal at a walk reaches 90% of
 *  the turn in about 0.33 s with a peak of 716°/s (slide.cjs turn180; the
 *  1/60 s simulation in test/limbLayers.test.ts). */
export const TURN_CAP = 12.5;
export const TURN_EASE = 11;
export const TURN_PIVOT_S = 0.12;
const TURN_PIVOT_ARC = (120 * Math.PI) / 180;

/** One heading step: returns the yaw change for this substep. `pivot` is the
 *  pivot's remaining seconds (state the caller keeps). Pure, for the tests. */
export function headingStep(arc: number, dt: number, pivot: number): number {
  const eased = arc * (1 - Math.exp(-TURN_EASE * dt));
  // The pivot: the first 120 ms of a turn over 120° plants and swings the
  // body round from 35% of the cap, so a reversal reads as a turn.
  const capRate = pivot > 0 ? TURN_CAP * (0.35 + 0.65 * (1 - pivot / TURN_PIVOT_S)) : TURN_CAP;
  const cap = capRate * dt;
  return THREE.MathUtils.clamp(eased, -cap, cap);
}
/**
 * One frame of a swim arm's angle about its rest X (B5): a phase oscillator,
 * so the arm never jumps. It turns at the tread's own rate blended with the
 * stroke's, and is pulled (4/s) toward the tread angle by (1 − strokeW) and
 * toward the stroke clock by strokeW; while swimW is below 1 it is pulled
 * toward the clip's own angle instead, so entry and exit start and end on
 * the clip. Blending TARGETS instead (a slerp, or a wrapped lerp) is
 * discontinuous where the windmilling stroke passes the far side of the
 * tread or the clip: MEASURED, 123° and 39° one-frame arm flips. The
 * per-frame change is bounded by (rate + 4π)·dt, about 19° at 60 Hz.
 */
export function swimArmStep(
  theta: number,
  clipAngle: number,
  tread: number,
  treadVel: number,
  stroke: number,
  strokeRate: number,
  strokeW: number,
  swimW: number,
  dt: number,
): number {
  const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
  const swim = (1 - strokeW) * wrap(tread - theta) + strokeW * wrap(stroke - theta);
  const pull = (1 - swimW) * wrap(clipAngle - theta) + swimW * swim;
  const turn = swimW * THREE.MathUtils.lerp(treadVel, strokeRate, strokeW);
  return theta + dt * (turn + 4 * pull);
}

/** A limb's angle about its OWN rest X (rest⁻¹·q), the frame swim poses
 *  compose in (rest·Rx(angle)). */
function restLocalAngleX(rest: THREE.Quaternion, q: THREE.Quaternion): number {
  const d = _limbDelta.copy(rest).invert().multiply(q);
  if (d.w < 0) d.set(-d.x, -d.y, -d.z, -d.w);
  return 2 * Math.atan2(d.x, d.w);
}

/**
 * An arm of the swim pose, written into `out`: rest·Rx(theta), carrying the
 * part of `q` (the clip or the land pose) that is not a turn about the rest X
 * — its small y/z residual — scaled out by swimW. No large slerp, so nothing
 * flips where the windmill passes the far side of the clip.
 */
function swimArmQuat(
  out: THREE.Quaternion,
  rest: THREE.Quaternion,
  q: THREE.Quaternion,
  theta: number,
  swimW: number,
): THREE.Quaternion {
  const alpha = restLocalAngleX(rest, q);
  // residual E = Rx(alpha)⁻¹ · rest⁻¹ · q, faded toward identity by swimW
  _swimResid
    .copy(_swimTurn.setFromAxisAngle(_limbAxisX, -alpha))
    .multiply(_limbDelta.copy(rest).invert().multiply(q));
  _swimResid.slerp(_swimIdent, swimW);
  return out
    .copy(rest)
    .multiply(_swimTurn.setFromAxisAngle(_limbAxisX, theta))
    .multiply(_swimResid);
}

/** The swim stroke's clock rate, rad/s: tread 3.2, stroke 7. */
export const SWIM_TREAD_RATE = 3.2;
export const SWIM_STROKE_RATE = 7;
fx.register('gait', { desktop: true, low: true });
fx.register('squash', { desktop: true, low: true });

/**
 * THE CLIP LAYER: world law 2's cached-quaternion rule, applied to the
 * AnimationMixer's own output, for the local avatar and every remote peer.
 *
 * three r180's PropertyMixer writes a bone only when the MIXED value changed
 * since its last apply (PropertyMixer.apply), so while a track holds still —
 * Idle's legs are constant STEP keys — the mixer never rewrites that bone. A
 * pose written onto the live bone after the mixer (`rotation.x += …`) then
 * survives into the next frame, and the next frame's pose lands on top of it.
 * MEASURED on the live build: one standing jump spun legL from 3.06 to -12.04
 * rad, legs up through the torso until the visitor walked, and a skipped arm
 * frame jumped the hand +0.50 u and then -1.02 u on landing.
 *
 * So the clip output is cached per limb: restore() puts it back immediately
 * before mixer.update (a bone the mixer skips still carries the clip),
 * capture() records it immediately after, and additive poses go through
 * onClip(). Absolute poses (wave, swim, ride, sit, dance) keep their
 * rest-anchored writes: they never read the live value, so they cannot stack.
 */
class LimbClip {
  private readonly clip: Record<LimbKey, THREE.Quaternion> = {
    armL: new THREE.Quaternion(),
    armR: new THREE.Quaternion(),
    legL: new THREE.Quaternion(),
    legR: new THREE.Quaternion(),
  };
  /** The bind pose, cached on the first capture() (world law 2's rest
   *  quaternion). Read-only after that: poses compose onto it. */
  readonly rest: Record<LimbKey, THREE.Quaternion> = {
    armL: new THREE.Quaternion(),
    armR: new THREE.Quaternion(),
    legL: new THREE.Quaternion(),
    legR: new THREE.Quaternion(),
  };
  private held = false;

  constructor(private readonly bone: (k: LimbKey) => THREE.Object3D | null) {}

  /** Before mixer.update: every limb back on the last clip output. */
  restore(): void {
    if (!this.held) return;
    for (const k of LIMB_KEYS) this.bone(k)?.quaternion.copy(this.clip[k]);
  }

  /** After mixer.update — and once at load, from the bind pose, which is the
   *  mixer's own original state (saveOriginalState at play()). */
  capture(): void {
    for (const k of LIMB_KEYS) {
      const b = this.bone(k);
      if (!b) continue;
      this.clip[k].copy(b.quaternion);
      if (!this.held) this.rest[k].copy(b.quaternion);
    }
    this.held = true;
  }

  /** The clip's swing about the parent X axis, measured from the rest: the
   *  signed angle of clip · rest⁻¹ (a quaternion read, so it never sees the
   *  ±π Euler flip). 0 before the first capture. */
  clipAngleX(k: LimbKey): number {
    if (!this.held) return 0;
    const d = _limbDelta.copy(this.rest[k]).invert().premultiply(this.clip[k]);
    if (d.w < 0) d.set(-d.x, -d.y, -d.z, -d.w);
    return 2 * Math.atan2(d.x, d.w);
  }

  /** The clip quaternion of one limb (read-only use). */
  clipOf(k: LimbKey): THREE.Quaternion {
    return this.clip[k];
  }

  /**
   * The clip pose turned `angle` about the PARENT's X axis: Rx(angle) · clip.
   * That is exactly what `rotation.x += angle` produced on a frame the mixer
   * had rewritten (MEASURED equal on player.glb, and it keeps the clip's Euler
   * y/z, so a later absolute rotation.x write still lands where it did). The
   * other order, clip · Rx, would turn the arms about their own splayed axis:
   * 0.05-0.08 u off at the hand.
   */
  onClip(k: LimbKey, angle: number): void {
    const b = this.bone(k);
    if (!b || !this.held) return;
    b.quaternion.copy(_limbTurn.setFromAxisAngle(_limbAxisX, angle)).multiply(this.clip[k]);
  }
}

/**
 * SimplePlayer
 *
 * A simplified player controller for flat ground
 * Features:
 * - Simple position and velocity
 * - Gravity and ground sticking (flat floor)
 * - WASD/arrow key movement
 * - Spacebar jump
 */
export class SimplePlayer extends THREE.Group {
  private mesh: THREE.Group;
  private playerPosition: THREE.Vector3 = new THREE.Vector3(0, 0.7, 0);
  private velocity: THREE.Vector3 = new THREE.Vector3();
  private acceleration: THREE.Vector3 = new THREE.Vector3();

  private yaw: number = 0; // rotation around Y axis
  private targetYaw: number = 0; // heading setRotation asked for; yaw eases onto it in update()
  private yawVel: number = 0; // yaw rad/s actually applied this frame — drives the turn lean
  private leanRoll: number = 0; // eased roll into turns (on-foot only)
  private turnPivot = 0; // seconds left of a >120° turn's pivot (B3)
  private lastTurnArc = 0; // the heading's remaining arc after the last step

  // ── The gait layer (B3) ──────────────────────────────────────────────────
  // Additive swings per limb (rad about the parent X, onto the clip), summed
  // with the air pose in applyAirWavePose; the body's bob, stance roll and
  // forward lean, written once each in writeBody.
  private readonly gaitAdd: Record<LimbKey, number> = { armL: 0, armR: 0, legL: 0, legR: 0 };
  private gaitG = 1;
  private gaitF = 0.9;
  private gaitBob = 0;
  private gaitRoll = 0;
  private gaitLean = 0;
  private gaitDt = 0;
  private gaitSpeed = 0;
  /** gltfModel.position.y as the load seating left it: every body offset
   *  (bob, toss/chop dip, landing pivot) is written from it, once a frame. */
  private modelBaseY: number | null = null;
  private bodyDip = 0;
  private readonly boundGait: () => void;
  // The landing spring (B4): vertical scale, its velocity, the leg absorb.
  private landSy = 1;
  private landVy = 0;
  private legAbsorbT = 0;
  private squashDt = 0;
  private modelBaseScale: THREE.Vector3 | null = null;
  private static readonly LEG_ABSORB_S = 0.08;
  private readonly boundSquash: () => void;

  private speed: number = 5.6; // movement speed. Was 8.0 (bumped 5.5→7.0→8.0 with the R30→40→50 grows — but 8.0 is a 28.8km/h SPRINT next to the 1.4u/s villagers). Calmed to 5.6 (~20km/h brisk walk, island crossing ~31s): relaxed pacing IS the product now, and vehicles exist for distance.
  // Hospital checkup buff (economy P3): multiplies the base speed until the
  // deadline passes. Applied where `speed` is READ so the tuned base never
  // mutates (no drift if buffs overlap or the tab sleeps through the expiry).
  private sprintUntil = 0;

  public setSprintUntil(t: number): void {
    this.sprintUntil = t;
  }

  // ── Stamina + run (hold Space while moving on ground) ──────────────────
  // Tap Space = jump (edge-triggered, unchanged); HOLDING it while moving
  // engages the run — compatible because held Space never re-jumps. Water
  // keeps Space = stay-afloat (run never engages while swimming).
  private stamina = 1; // 0..1
  private runIntent = false;
  private running = false;
  private static readonly RUN_MULT = 1.45;
  private static readonly STAMINA_DRAIN = 0.22; // /s → ~4.5s of full sprint
  private static readonly STAMINA_REGEN = 0.16; // /s → ~6s to refill
  private static readonly STAMINA_REENGAGE = 0.25; // hysteresis: no flicker at 0

  public setRunIntent(on: boolean): void {
    this.runIntent = on;
  }

  public getStamina(): number {
    return this.stamina;
  }

  /** Eat/refill: add a fraction of a full bar (0..1), clamped. Returns the
   *  actual gain (0 when already full) so the caller can react. */
  public addStamina(frac: number): number {
    const before = this.stamina;
    this.stamina = THREE.MathUtils.clamp(this.stamina + frac, 0, 1);
    return this.stamina - before;
  }

  /** Extend the speed buff, NEVER shortening a longer active one — the pie's
   *  well-fed stroll shares the sprintUntil channel with the hospital checkup,
   *  and setSprintUntil(now+20) would truncate a live 60s checkup. */
  public boostSprint(sec: number): void {
    this.sprintUntil = Math.max(this.sprintUntil, performance.now() / 1000 + sec);
  }

  public isRunning(): boolean {
    return this.running;
  }

  /** Per-frame stamina bookkeeping — called from update() with the frame dt. */
  private updateStamina(dt: number): void {
    const moving = this.velocity.lengthSq() > 1.2;
    const wantRun = this.runIntent && this.isGrounded && !this.swimming && moving;
    if (this.running) {
      this.running = wantRun && this.stamina > 0;
    } else {
      this.running = wantRun && this.stamina > SimplePlayer.STAMINA_REENGAGE;
    }
    this.stamina = THREE.MathUtils.clamp(
      this.stamina + (this.running ? -SimplePlayer.STAMINA_DRAIN : SimplePlayer.STAMINA_REGEN) * dt,
      0,
      1,
    );
  }

  private effectiveSpeed(): number {
    const buff = performance.now() / 1000 < this.sprintUntil ? 1.35 : 1;
    // Run and the checkup buff don't stack — the stronger one wins (a
    // multiplicative 1.96x broke the walk-clip cadence ceiling).
    return this.speed * Math.max(buff, this.running ? SimplePlayer.RUN_MULT : 1);
  }
  private jumpForce: number = 8;
  private gravityStrength: number = 25; // gravitational acceleration

  private isGrounded: boolean = false;
  private groundLevel: number = 0; // Y position of ground (flat mode only)

  // Spherical planet physics
  private planetCenter: THREE.Vector3 = new THREE.Vector3(0, 0, 0);
  private planetRadius: number = 0; // 0 = flat ground mode

  // Optional terrain sampler: given the outward unit direction, returns the
  // distance from planet center to the actual (displaced) terrain surface.
  // Without it, grounding falls back to the ideal sphere radius.
  private groundSampler: ((outwardDir: THREE.Vector3) => number) | null = null;

  // Water: given the outward unit direction, returns the wavy water-surface
  // radius there and whether it is open water (terrain below the sea).
  private waterSampler:
    | ((outwardDir: THREE.Vector3) => { surface: number; isWater: boolean })
    | null = null;
  private swimIntent = false; // swim button held this frame
  private inWater = false; // over open water right now
  private swimming = false; // afloat (in water + intent held)
  private oxygen = 1; // 1 = full breath, 0 = drowned
  private onDrown: (() => void) | null = null;
  private static readonly SWIM_FLOAT = 0.55; // player centre above the surface while afloat
  private static readonly DROWN_RATE = 0.16; // oxygen/sec while under (≈6s)
  private static readonly RECOVER_RATE = 0.5; // oxygen/sec refill out of danger
  // Shoreline barrier: the island is the north cap, so `dir.y` (= sin latitude)
  // shrinks as you swim out to sea. Past this a current pushes you back so the
  // open ocean isn't a place to get lost forever.
  // Swimmers get a shorter leash than boats (drowning is a real risk out
  // there), but 0.05 was only ~2 units of water once the irregular coastline
  // dropped the shore to y≈0.14 in places — you were turned back almost at the
  // beach. -0.08 gives room to actually swim offshore.
  private static readonly SWIM_LIMIT_Y = -0.08;
  private static readonly _poleUp = new THREE.Vector3(0, 1, 0);
  private _swimTangent = new THREE.Vector3();
  private beyondSwimLimit = false; // true while the swim-back current is active

  // ── Free dive ──────────────────────────────────────────────────────────
  // Going under used to be ONLY the failure state: release the swim button
  // and gravity pulled you down while the breath drained to a drown. So the
  // entire seafloor — kelp, coral, the schools, the caustics — was content
  // you could only reach by dying. This turns the existing sink into a
  // DELIBERATE descent, reusing the oxygen, the drown, the breath bar, the
  // swim pose and the submerged camera grade that all already exist.
  private diveIntent = false; // dive key/button held this frame
  private diving = false; // MEASURED: the head is genuinely under
  private lastTerrainDist = 0; // seabed radius, cached by updateGroundState
  private static readonly DIVE_SPEED = 2.6; // u/s descent
  private static readonly DIVE_MAX_DEPTH = 4.2; // u below the live wave surface
  private static readonly DIVE_FLOOR_GAP = 0.85; // playerHeight 0.7 + 0.15 skin
  // 0.055/s ≈ 18s under. The column is only 4.2u and swim speed is 4.42 u/s,
  // so a shorter breath than this ends the dive before you have looked at
  // anything — the whole point of the feature. The drown at 0.16/s stays
  // exactly as it was for the accidental case.
  private static readonly DIVE_DRAIN = 0.055;
  private static readonly ASCEND_SPEED = 3.4; // u/s back toward the surface
  // Clears the wave envelope (WAVE_AMP 0.2 x max|w| 1.8 + tide 0.09 = 0.45)
  // with margin, so surfacing never leaves you bobbing half-under.
  private static readonly ASCEND_SNAP = 0.6;

  public setDiveIntent(held: boolean): void {
    this.diveIntent = held;
  }
  /** True while the head is actually below the surface under a held dive. */
  public isDiving(): boolean {
    return this.diving;
  }

  private moveInput: THREE.Vector3 = new THREE.Vector3(); // (x=strafe, y=unused, z=forward)
  private wantJump: boolean = false;
  private rideActive = false; // physics suspended while riding a boat/jetski
  private rideKind: 'boat' | 'jetski' = 'boat';
  private rideBob = 0; // idle-sway clock for the riding pose

  // Procedural walk-cycle state (used when no GLTF model is loaded)
  private legPivots: THREE.Group[] = [];
  private armPivots: THREE.Group[] = [];
  private walkPhase: number = 0;
  private wasAirborne: boolean = false;
  private squashTime: number = 0;

  // Sitting (on benches): physics frozen, legs posed forward
  private seated: boolean = false;
  private legLBone: THREE.Bone | null = null;
  private legRBone: THREE.Bone | null = null;
  private armLBone: THREE.Bone | null = null;
  private armRBone: THREE.Bone | null = null;
  private swimPhase = 0; // stroke-cycle clock
  // B5's eased swim weights: the clip-to-swim blend, the tread-to-stroke
  // blend and its hysteresis target, the last swim pose per limb (the exit
  // eases out of it), the body's pitch and roll at the exit, and whether the
  // stroke clock has been seeded for this swim.
  private swimW = 0;
  private strokeW = 0;
  private strokeTarget = 0;
  private swimSeeded = false;
  private readonly swimTargetQ: Record<LimbKey, THREE.Quaternion> = {
    armL: new THREE.Quaternion(),
    armR: new THREE.Quaternion(),
    legL: new THREE.Quaternion(),
    legR: new THREE.Quaternion(),
  };
  /** Each limb's swim angle about its rest X (swimArmStep for the arms). */
  private readonly swimAng: Record<LimbKey, number> = { armL: 0, armR: 0, legL: 0, legR: 0 };
  private swimExitPitch = 0;
  private swimExitRoll = 0;
  private wasInWater = false; // edge-detect for the entry splash
  private justEnteredWater = false;
  private swimPoseActive = false; // swim pose currently overriding the mixer

  // Jump/air pose (on-foot only): eases 0→1 while airborne, back on land.
  private airPoseWeight = 0;
  private airLegWeight = 0; // the legs' share, faded faster on landing (B4)
  // The mixer's last output for the four limbs (see LimbClip).
  private readonly limbClip = new LimbClip((k) =>
    k === 'armL'
      ? this.armLBone
      : k === 'armR'
        ? this.armRBone
        : k === 'legL'
          ? this.legLBone
          : this.legRBone,
  );
  // Arm-wave gesture: seconds of the ~1.2s wave remaining (0 = idle).
  private waveTime = 0;
  private static readonly WAVE_DURATION = 1.2;
  // Feed-toss gesture: windup → underhand scatter → settle (0 = idle).
  private feedTossTime = 0;
  private static readonly FEED_TOSS_DURATION = 0.7;
  // Rod-cast gesture (fishing): over-shoulder windup → forward snap → settle.
  // Doubles as the hook-set yank on reel — the same flick reads as both.
  private castTime = 0;
  private static readonly CAST_DURATION = 0.8;
  // Axe-chop gesture (timber): BOTH arms overhead → down-strike → settle.
  // GameScene syncs the tree shudder/chips to the strike at ~0.22s.
  private chopTime = 0;
  private static readonly CHOP_DURATION = 0.55;
  /** The hanging rest pose expressed on the POSITIVE side (+PI == -PI). Used
   *  as the blend base for gestures whose payload sits forward (positive
   *  rotation.x), so the envelope settle never sweeps back over the head. */
  private static readonly SETTLE_REST = Math.PI;
  // While the line is out, the rod arm holds forward-up (~the fisherman's
  // theta) instead of hanging — the bone-parented rod points over the water.
  // rodHoldW is the eased 0..1 weight: the WRITE must be absolute-by-weight
  // (like the wave), because the mixer rewrites the bone every frame and an
  // incremental per-frame lerp loses that fight (measured: arm stayed at
  // rest −2.93 with the hold "active").
  private rodHold = false;
  private rodHoldW = 0;

  public setRodHold(on: boolean): void {
    this.rodHold = on;
  }
  // The walk clip's rate is gaitCadence(speed) × its length (B3), at all
  // three sites: update, tickInteriorAnimation and the remote peer.

  // Per-frame scratch (avoid allocating in update()/updateWorldMatrix hot paths)
  private _normalScratch = new THREE.Vector3();
  private _vecScratch = new THREE.Vector3();
  // Physics-path scratch (gravity dir / ground radial / water radial — the
  // three consumers run strictly in sequence inside update(), so one field
  // serves all without aliasing). _moveScratch/_vNormScratch belong to
  // applyMovement, which previously cloned ~6 vectors per substep — doubled
  // by the substep split exactly when the frame budget was already blown.
  private _radialScratch = new THREE.Vector3();
  private _moveScratch = new THREE.Vector3();
  private _vNormScratch = new THREE.Vector3();
  private _alignQuat = new THREE.Quaternion();
  private _yawQuat = new THREE.Quaternion();

  // Shop cosmetics: hat attached to the head bone (or fallback head)
  private currentHat: THREE.Group | null = null;
  private pendingHatId: HatId | null = null;
  // Player-chosen body colours (applied by material name; re-applied when the
  // GLTF finishes loading so a choice made during the fly-in isn't lost).
  private appearance: Partial<Record<BodyPart, number>> = {};

  // GLTF model support
  private gltfModel: THREE.Group | null = null;
  private animationMixer: THREE.AnimationMixer | null = null;
  private idleAction: THREE.AnimationAction | null = null;
  private walkAction: THREE.AnimationAction | null = null;

  constructor() {
    super();
    this.name = 'SimplePlayer';
    this.boundGait = this.applyGait.bind(this);
    this.boundSquash = this.applyLandSquash.bind(this);

    const group = new THREE.Group();

    // Material names match the GLTF model's, so setBodyColor() recolours both
    // the fallback body (no model) and the real model by the same lookup.
    const shirtMat = Materials.createToonMaterial(0x4a90e2);
    shirtMat.name = 'Jacket';
    const skinMat = Materials.createToonMaterial(0xffddaa);
    skinMat.name = 'Skin';
    const pantsMat = Materials.createToonMaterial(0x2a3a5a);
    pantsMat.name = 'Pants';
    const shoeMat = Materials.createToonMaterial(0x3d2b1a);
    shoeMat.name = 'Shoe';
    const hairMat = Materials.createToonMaterial(0x3a2a1a);
    hairMat.name = 'Hair';
    const eyeMat = Materials.createToonMaterial(0x1a1a1a);

    // Legs — pivoted at the hip so they can swing in the walk cycle
    for (const lx of [-0.12, 0.12]) {
      const legPivot = new THREE.Group();
      legPivot.position.set(lx, -0.08, 0);
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.09, 0.55, 8), pantsMat);
      leg.position.set(0, -0.27, 0);
      leg.castShadow = true;
      legPivot.add(leg);
      const shoe = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.1, 0.22), shoeMat);
      shoe.position.set(0, -0.57, 0.03);
      shoe.castShadow = true;
      legPivot.add(shoe);
      group.add(legPivot);
      this.legPivots.push(legPivot);
    }

    // Torso
    const torso = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.18, 0.6, 8), shirtMat);
    torso.position.y = 0.22;
    torso.castShadow = true;
    // No self-shadow acne on the fallback body either (see the GLB path).
    torso.receiveShadow = false;
    group.add(torso);

    // Arms — pivoted at the shoulder for the walk swing
    for (const ax of [-0.32, 0.32]) {
      const armPivot = new THREE.Group();
      armPivot.position.set(ax, 0.35, 0);
      armPivot.rotation.z = ax > 0 ? -0.12 : 0.12;
      const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.05, 0.5, 7), shirtMat);
      arm.position.set(0, -0.25, 0);
      arm.castShadow = true;
      armPivot.add(arm);
      const hand = new THREE.Mesh(new THREE.SphereGeometry(0.06, 6, 6), skinMat);
      hand.position.set(0, -0.5, 0);
      armPivot.add(hand);
      group.add(armPivot);
      this.armPivots.push(armPivot);
    }

    // Head
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.22, 12, 12), skinMat);
    head.position.y = 0.72;
    head.castShadow = true;
    head.receiveShadow = false;
    group.add(head);

    // Hair (cap on top)
    const hair = new THREE.Mesh(
      new THREE.SphereGeometry(0.21, 10, 8, 0, Math.PI * 2, 0, Math.PI * 0.5),
      hairMat,
    );
    hair.position.y = 0.76;
    group.add(hair);

    // Eyes
    for (const [ex, ey, ez] of [
      [-0.08, 0.76, 0.17],
      [0.08, 0.76, 0.17],
    ] as [number, number, number][]) {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.04, 6, 6), eyeMat);
      eye.position.set(ex, ey, ez);
      group.add(eye);
      const pupilHighlight = new THREE.Mesh(
        new THREE.SphereGeometry(0.015, 4, 4),
        new THREE.MeshBasicMaterial({ color: 0xffffff }),
      );
      pupilHighlight.position.set(ex + 0.015, ey + 0.015, ez + 0.02);
      group.add(pupilHighlight);
    }

    // Mouth — small curve
    const mouth = new THREE.Mesh(new THREE.TorusGeometry(0.04, 0.01, 4, 8, Math.PI), eyeMat);
    mouth.position.set(0, 0.66, 0.18);
    mouth.rotation.x = Math.PI;
    group.add(mouth);

    this.mesh = group;
    this.add(this.mesh);
    this.collectCloseFadeParts(this.mesh); // the close-camera fade's list (B11)

    // Start at center with player height above ground
    this.playerPosition.set(0, 0.7, 0);
    this.isGrounded = true;
    this.updateWorldMatrix();

    // Try to load GLTF character model asynchronously
    this.loadGLTFCharacter();
  }

  /**
   * Set spherical planet for physics. Call from GameScene after construction.
   */
  public setPlanet(center: THREE.Vector3, radius: number): void {
    this.planetCenter = center.clone();
    this.planetRadius = radius;
  }

  /**
   * Provide a terrain height sampler so grounding follows the displaced
   * terrain instead of the ideal sphere (hills rise ~4 units above radius).
   */
  public setGroundSampler(sampler: (outwardDir: THREE.Vector3) => number): void {
    this.groundSampler = sampler;
  }

  /** Water-surface sampler (see updateWaterState). */
  public setWaterSampler(
    sampler: (outwardDir: THREE.Vector3) => { surface: number; isWater: boolean },
  ): void {
    this.waterSampler = sampler;
  }

  /** Called when oxygen hits zero (GameScene respawns the player). */
  public setOnDrown(cb: () => void): void {
    this.onDrown = cb;
  }

  /** Hold the swim button to stay afloat; release in water to drown. */
  public setSwimIntent(held: boolean): void {
    this.swimIntent = held;
  }

  public isInWater(): boolean {
    return this.inWater;
  }
  public isSwimming(): boolean {
    return this.swimming;
  }
  public getOxygen(): number {
    return this.oxygen;
  }
  /** True while the shoreline current is actively pushing the swimmer back. */
  public isBeyondSwimLimit(): boolean {
    return this.beyondSwimLimit;
  }
  /** Reset breath (call on respawn after a drown). */
  public resetOxygen(): void {
    this.oxygen = 1;
  }
  /** Suspend physics while riding a vehicle (GameScene drives the transform). */
  public setRiding(active: boolean, kind: 'boat' | 'jetski' = 'boat'): void {
    this.rideActive = active;
    this.rideKind = kind;
    if (active) {
      this.velocity.set(0, 0, 0);
      // Leaving the water for the deck: drop the swim tilt + state so the
      // rider doesn't stay in a prone swim pose on the vehicle.
      this.clearSwimPose();
      this.swimPoseActive = false;
      this.inWater = false;
      this.swimming = false;
      this.airPoseWeight = 0;
      this.airLegWeight = 0;
    } else {
      // Back to swimming/walking: neutralise the posed bones + model tilt so
      // the mixer / swim pose take over cleanly.
      if (this.gltfModel) this.gltfModel.rotation.set(0, 0, 0);
      else this.mesh.rotation.set(0, 0, 0);
      this.leanRoll = 0;
      this.yawVel = 0;
      for (const b of [this.armLBone, this.armRBone, this.legLBone, this.legRBone]) {
        if (b) b.rotation.set(0, 0, 0);
      }
      for (const p of [...this.legPivots, ...this.armPivots]) p.rotation.x = 0;
    }
  }

  /**
   * Recolour a body part by its material name (works on the fallback body and
   * the GLTF model + the added hair cap). Stored so it survives a model reload.
   */
  public setBodyColor(part: BodyPart, hex: number): void {
    this.appearance[part] = hex;
    const matName = PART_MATERIAL[part];
    const recolour = (root: THREE.Object3D) => {
      root.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh && !(mesh as THREE.SkinnedMesh).isSkinnedMesh) return;
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const m of mats) {
          const sm = m as THREE.MeshStandardMaterial;
          if (sm && sm.name === matName && sm.color) sm.color.setHex(hex);
        }
      });
    };
    recolour(this);
    if (this.gltfModel) recolour(this.gltfModel);
  }

  /** Re-apply every stored colour (call after the GLTF model swaps in). */
  private reapplyAppearance(): void {
    for (const key of Object.keys(this.appearance) as BodyPart[]) {
      const hex = this.appearance[key];
      if (typeof hex === 'number') this.setBodyColor(key, hex);
    }
  }

  /** Current chosen colours (for the customiser to show the active swatch). */
  public getAppearance(): Partial<Record<BodyPart, number>> {
    return { ...this.appearance };
  }

  /**
   * Equip a shop hat (null removes). Attaches to the GLTF head bone so it
   * tracks animation; queued if the model hasn't finished loading yet.
   */
  public equipHat(id: HatId | null): void {
    // Find the attachment point: head bone (GLTF) or the fallback head
    let parent: THREE.Object3D | null = null;
    if (this.gltfModel) {
      this.gltfModel.traverse((o) => {
        if (!parent && (o as THREE.Bone).isBone && o.name === 'head') parent = o;
      });
    }
    if (!parent && !this.gltfModel) {
      this.pendingHatId = id;
      parent = this.mesh; // fallback model: hat sits on the group
    }
    if (!parent) {
      this.pendingHatId = id;
      return;
    }
    if (this.currentHat) {
      this.currentHat.parent?.remove(this.currentHat);
      this.currentHat = null;
      this.collectCloseFadeParts(); // the old hat leaves the fade's list (B11)
    }
    if (!id) return;
    const hat = SimplePlayer.buildHat(id);
    // Head bone: crown of the head is ~0.34 above the bone origin.
    // Fallback group: head sphere top is ~0.95.
    hat.position.set(0, this.gltfModel ? 0.36 : 0.95, 0);
    parent.add(hat);
    this.currentHat = hat;
    this.collectCloseFadeParts(); // the new hat fades with the body (B11)
    // Equip ceremony: the hat scale-pops in with a settle (easeOutBack) —
    // pure root-scale tween, no bones touched.
    const base = hat.scale.x;
    hat.scale.setScalar(0.01);
    juiceTween(0.32, easeOutBack, (v) => hat.scale.setScalar(Math.max(0.01, base * v)));
  }

  // ── The close-camera fade (B11) ─────────────────────────────────────────
  // With the camera nearer than CLOSE_FADE_IN the avatar and its hat fade to
  // CLOSE_FADE_ALPHA, so a camera pressed up against the player (a wall
  // behind it, a small room) looks through them instead of into the back of
  // their head. Past CLOSE_FADE_OUT they come back.
  //
  // NO PROGRAM CHANGES HANDS. three keys every program on whether its material
  // is opaque (transparent false, NormalBlending), so flipping `transparent`
  // at fade time would compile a second variant of each dress program in the
  // very frame the camera closes in. The dress therefore always runs the
  // non-opaque variant, from the first compile: solid, it is drawn in the
  // opaque list with CustomBlending One/Zero, which writes exactly what no
  // blending writes; faded, it moves to the transparent list with
  // NormalBlending. Both states share one cache key, and a fade is uniform
  // and render-state writes only.
  //
  // OWN MATERIALS ONLY: the body's are collected when the model lands and the
  // hat's when it is equipped, both built for this player. Anything attached
  // later (a rod, a tool) may share a cached material with the world, and the
  // shared ink material is never written: the hull meshes are hidden instead.
  private static readonly CLOSE_FADE_IN = 1.1;
  private static readonly CLOSE_FADE_OUT = 1.3;
  public static readonly CLOSE_FADE_ALPHA = 0.35;
  private static readonly CLOSE_FADE_S = 0.12;
  private closeFadeBodyMats: THREE.Material[] = [];
  private closeFadeBodyHulls: THREE.Object3D[] = [];
  /** The body's and the hat's, flattened: what a fade frame walks. */
  private closeFadeMats: THREE.Material[] = [];
  private closeFadeHulls: THREE.Object3D[] = [];
  /** 0 solid .. 1 fully faded. */
  private closeFade = 0;
  private closeFadeNear = false;

  /** The avatar's own materials and hull meshes under `root`, as built. */
  private static closeFadePartsOf(
    root: THREE.Object3D,
    mats: THREE.Material[],
    hulls: THREE.Object3D[],
  ): void {
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || !mesh.material) return;
      const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      // The authored outline (player.glb's PlayerOutline) and any baked ink.
      if (
        mesh.userData.isCelHull ||
        mesh.name === 'PlayerOutline' ||
        list.some((m) => m.name === 'Outline')
      ) {
        hulls.push(mesh);
        return;
      }
      for (const m of list) if (m && !mats.includes(m)) mats.push(m);
    });
  }

  /**
   * Rebuild the fade's lists. `body` is passed when a body lands (the
   * procedural one, then the GLB): its materials are collected then and never
   * again. Every call re-reads the hat. Cel theme only.
   */
  private collectCloseFadeParts(body?: THREE.Object3D): void {
    if (!isCelTheme()) return;
    if (body) {
      this.applyCloseFade(0); // hand the old body back solid
      this.closeFadeBodyMats = [];
      this.closeFadeBodyHulls = [];
      SimplePlayer.closeFadePartsOf(body, this.closeFadeBodyMats, this.closeFadeBodyHulls);
    }
    const mats = [...this.closeFadeBodyMats];
    const hulls = [...this.closeFadeBodyHulls];
    if (this.currentHat) SimplePlayer.closeFadePartsOf(this.currentHat, mats, hulls);
    this.closeFadeMats = mats;
    this.closeFadeHulls = hulls;
    for (const m of mats) {
      if (m.forceSinglePass) continue; // prepared on an earlier call
      m.forceSinglePass = true; // one draw each when faded, double-sided or not
      m.needsUpdate = true; // pick the non-opaque variant before its first draw
    }
    this.applyCloseFade(this.closeFade);
  }

  /** Write fade `f` (0 solid .. 1 faded) to the lists: uniforms and render
   *  state only, the same program either way. */
  private applyCloseFade(f: number): void {
    const solid = f <= 0;
    const alpha = 1 - (1 - SimplePlayer.CLOSE_FADE_ALPHA) * f;
    for (const m of this.closeFadeMats) {
      m.opacity = alpha;
      m.transparent = !solid;
      m.blending = solid ? THREE.CustomBlending : THREE.NormalBlending;
      m.blendSrc = THREE.OneFactor;
      m.blendDst = THREE.ZeroFactor;
    }
    for (const h of this.closeFadeHulls) h.visible = solid;
  }

  /**
   * Per frame: `camDistance` is the camera's distance to the avatar's torso.
   * Fades in under CLOSE_FADE_IN, out over CLOSE_FADE_OUT, linearly over
   * CLOSE_FADE_S. Does nothing, and allocates nothing, while settled.
   */
  public updateCloseFade(camDistance: number, deltaTime: number): void {
    if (camDistance < SimplePlayer.CLOSE_FADE_IN) this.closeFadeNear = true;
    else if (camDistance > SimplePlayer.CLOSE_FADE_OUT) this.closeFadeNear = false;
    const target = this.closeFadeNear ? 1 : 0;
    if (this.closeFade === target) return;
    const step = Math.max(0, deltaTime) / SimplePlayer.CLOSE_FADE_S;
    this.closeFade =
      target > this.closeFade
        ? Math.min(1, this.closeFade + step)
        : Math.max(0, this.closeFade - step);
    this.applyCloseFade(this.closeFade);
  }

  /** The avatar's current opacity: 1 solid, CLOSE_FADE_ALPHA fully faded. */
  public getCloseFadeAlpha(): number {
    return 1 - (1 - SimplePlayer.CLOSE_FADE_ALPHA) * this.closeFade;
  }

  // Base model loaded once, then skeleton-cloned per remote player.
  private static remoteBasePromise: Promise<{
    scene: THREE.Group;
    animations: THREE.AnimationClip[];
  } | null> | null = null;

  /**
   * Build a remote-player avatar from the SAME rigged GLB the local player
   * uses (skeleton-cloned so animation is independent). This is why other
   * visitors used to look different to you than they do to themselves — the
   * local player was the GLTF hero while peers were a crude cylinder figure.
   * Returns null if the model can't load (caller keeps its procedural body).
   */
  public static async createRemoteAvatar(): Promise<RemoteAvatar | null> {
    if (!this.remoteBasePromise) {
      this.remoteBasePromise = loadGLTFWithFallbacks('/assets/models/player.glb', { scale: 0.88 })
        .then((r) => (r ? { scene: r.scene, animations: r.animations } : null))
        .catch(() => null);
    }
    const base = await this.remoteBasePromise;
    if (!base) return null;

    const model = cloneSkeleton(base.scene) as THREE.Group;
    // SkeletonUtils.clone SHARES materials with the base (and every other peer),
    // so per-peer body-colour sync needs independent material instances. Clone
    // them once here (geometry stays shared — cheap) and track for disposal.
    // Each clone also takes the island's toon look, as the local player's
    // dress does (B15): a peer wears what they see themselves wearing.
    const clonedMats: THREE.Material[] = [];
    const own = (x: THREE.Material): THREE.Material => {
      const c = SimplePlayer.celDress(x.clone());
      clonedMats.push(c);
      return c;
    };
    model.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh && !(m as THREE.SkinnedMesh).isSkinnedMesh) return;
      if (Array.isArray(m.material)) {
        m.material = m.material.map(own);
      } else if (m.material) {
        m.material = own(m.material as THREE.Material);
      }
    });
    const body = new THREE.Group();
    body.add(model);
    body.updateMatrixWorld(true);

    // Feet calibration to local -0.7 (same as the local player) so the peer
    // group origin lines up with the broadcast player-centre position.
    try {
      const box = new THREE.Box3().setFromObject(model);
      if (Number.isFinite(box.min.y)) model.position.y += -0.7 - box.min.y;
    } catch {
      /* keep default placement */
    }

    // Limb bones captured for the broadcast swim/ride/air poses + the wave.
    let headBone: THREE.Object3D | null = null;
    let armLBone: THREE.Object3D | null = null;
    let armRBone: THREE.Object3D | null = null;
    let legLBone: THREE.Object3D | null = null;
    let legRBone: THREE.Object3D | null = null;
    model.traverse((o) => {
      if ((o as THREE.SkinnedMesh).isSkinnedMesh) {
        // Cull the peer like an NPC, not from anywhere on the planet. A skinned
        // mesh's bind-pose bounds don't follow the bones, so — exactly as
        // NPC.ts does — inflate the object-level boundingSphere 2.5x (it rides
        // matrixWorld and Frustum.intersectsObject prefers it) instead of the
        // blunt frustumCulled=false. Peers use player.glb (~13 skinned parts,
        // heavier than a villager's), so at N peers this turns each client's
        // peer render + skinning + shadow cost from O(total peers) into
        // O(peers on-screen). The clone is already skeleton-bound here
        // (SkeletonUtils.clone), so computeBoundingSphere skins correctly.
        const sm = o as THREE.SkinnedMesh;
        sm.computeBoundingSphere();
        if (sm.boundingSphere) sm.boundingSphere.radius *= 2.5;
      }
      if (o instanceof THREE.Mesh) {
        o.castShadow = true;
        // Peers get the same treatment as the local player (World Law 2): no
        // receiveShadow, so a walking peer does not flicker with self-shadow
        // acne on every other visitor's screen. Still casts a grounding shadow.
        o.receiveShadow = false;
      }
      if ((o as THREE.Bone).isBone) {
        if (o.name === 'head') headBone = headBone ?? o;
        else if (o.name === 'armL') armLBone = o;
        else if (o.name === 'armR') armRBone = o;
        else if (o.name === 'legL') legLBone = o;
        else if (o.name === 'legR') legRBone = o;
      }
    });

    // No runtime hair cap: hair is authored in the GLB (fringe + helmet from
    // scripts/reshape-avatar-face.py, both on the 'Hair' material, so custom
    // hair colours recolour them through the normal material-name path). The
    // old procedural hair_cap sphere could not hug the rounded head — its rim
    // always poked out somewhere and read as a beard/band.

    // Idle/walk blend so peers never freeze in the bind (T) pose
    let mixer: THREE.AnimationMixer | null = null;
    let idle: THREE.AnimationAction | null = null;
    let walk: THREE.AnimationAction | null = null;
    if (base.animations.length) {
      mixer = new THREE.AnimationMixer(model);
      const idleClip = base.animations.find((c) => /idle/i.test(c.name));
      const walkClip = base.animations.find((c) => /walk|run/i.test(c.name));
      if (idleClip) {
        idle = mixer.clipAction(idleClip);
        idle.play();
      }
      if (walkClip) {
        walk = mixer.clipAction(walkClip);
        walk.setEffectiveWeight(0);
        walk.play();
      }
      if (!idle && !walk) mixer.clipAction(base.animations[0]).play();
    }
    // The peer's own clip layer (LimbClip), seeded from the fresh clone's bind
    // pose before any pose touches it.
    const clip = new LimbClip((k) =>
      k === 'armL' ? armLBone : k === 'armR' ? armRBone : k === 'legL' ? legLBone : legRBone,
    );
    clip.capture();

    // Broadcast pose (0 foot, 1 swim, 2 ride, 3 air) + eased override weight, so
    // a swimming/riding/jumping peer strikes the right pose instead of always
    // walk-cycling upright. Applied AFTER mixer.update, which does NOT rewrite a
    // limb whose clip value holds still — hence the clip layer around it;
    // activePose remembers the last non-foot pose so it eases back out. Wave
    // overrides the right arm regardless of pose.
    let curPose = 0;
    let activePose = 0;
    let poseW = 0;
    let swimClock = 0;
    let waveT = 0;
    // Peer swim motion, fed by Multiplayer from the position stream, plus the
    // eased pitch — eased here rather than sent, so a 10Hz packet rate can't
    // make a visitor's body snap between attitudes.
    let swimRadial = 0;
    let swimTang = 0;
    let swimPitchR = 0;
    // The peer's swim weights (B5) and its limb writer.
    let peerSwimW = 0;
    let peerStrokeW = 0;
    let peerStrokeTarget = 0;
    let peerSwimSeeded = false;
    const peerBone = (k: LimbKey): THREE.Object3D | null =>
      k === 'armL' ? armLBone : k === 'armR' ? armRBone : k === 'legL' ? legLBone : legRBone;
    let peerArmL = 0;
    let peerArmR = 0;
    // How far the peer's arms still sit from the clip (the exit runs on until
    // they arrive, as the local player's does).
    let peerArmsOff = 0;
    const qTarget = new THREE.Quaternion();
    const qTurn = new THREE.Quaternion();
    const peerSwimLimb = (k: LimbKey, angle: number, swimW: number): void => {
      const b = peerBone(k);
      if (!b) return;
      qTarget.copy(clip.rest[k]).multiply(qTurn.setFromAxisAngle(_limbAxisX, angle));
      b.quaternion.copy(clip.clipOf(k)).slerp(qTarget, swimW);
    };
    // The peer's gait layer (B3): bob, stance roll and lean, written from the
    // seated base like the local player's writeBody.
    const baseY = model.position.y;
    let gaitBob = 0;
    let gaitRoll = 0;
    let gaitLean = 0;

    const update = (dt: number, speed: number): void => {
      if (mixer) {
        clip.restore();
        mixer.update(dt);
        clip.capture();
      }
      const overriding = curPose !== 0;
      if (walk) {
        const w = overriding ? 0 : THREE.MathUtils.clamp(speed / 3, 0, 1);
        walk.setEffectiveWeight(w);
        // Cadence follows measured ground speed (B3, the local player's curve).
        walk.timeScale = gaitCadence(speed) * walk.getClip().duration;
        if (idle) idle.setEffectiveWeight(1 - w);
      }
      const k = Math.min(1, 10 * dt);
      if (curPose !== 0) activePose = curPose;
      poseW += ((overriding ? 1 : 0) - poseW) * k;
      // B5: the swim pose has its own weights, at the local player's rates —
      // swimW in at 6/s and out at 5/s, strokeW at 4/s with the 0.6/0.3 u/s
      // hysteresis — in place of the shared 10/s poseW.
      const swimming = curPose === 1;
      peerSwimW += ((swimming ? 1 : 0) - peerSwimW) * Math.min(1, (swimming ? 6 : 5) * dt);
      if (!swimming || swimTang < 0.3) peerStrokeTarget = 0;
      else if (swimTang > 0.6) peerStrokeTarget = 1;
      peerStrokeW += (peerStrokeTarget - peerStrokeW) * Math.min(1, 4 * dt);
      const weight =
        activePose === 1 ? (swimming || peerSwimSeeded ? Math.max(peerSwimW, 0.002) : 0) : poseW;
      if (weight > 0.001 && activePose !== 0) {
        if (activePose === 1) {
          // Swimming: face-down tilt + alternating overhead crawl + flutter
          // kick. The pitch comes from the SHARED swimPitchTarget, driven by
          // the peer's own vertical/horizontal speed (Multiplayer derives both
          // from the position stream), so a DIVING visitor reads as diving.
          // This used to be a hardcoded 1.35 that had already drifted from the
          // local pose — the exact failure world law 2 exists to prevent.
          if (!peerSwimSeeded) {
            // Entry: the stroke clock and the arms start where the arms are.
            peerArmL = restLocalAngleX(clip.rest.armL, clip.clipOf('armL'));
            peerArmR = restLocalAngleX(clip.rest.armR, clip.clipOf('armR'));
            swimClock = peerArmL;
            peerSwimSeeded = true;
          }
          const rate = THREE.MathUtils.lerp(SWIM_TREAD_RATE, SWIM_STROKE_RATE, peerStrokeW);
          swimClock += dt * rate;
          const s = Math.sin(swimClock);
          const s2 = Math.sin(swimClock * 2);
          const sw = peerSwimW;
          // A descending peer is "diving" by the same deadband the local
          // player uses.
          const target = swimPitchTarget(
            swimRadial,
            swimTang,
            peerStrokeW > 0.5,
            swimRadial < -SWIM_VERT_DEADBAND,
          );
          swimPitchR += (target - swimPitchR) * Math.min(1, 6 * dt);
          model.rotation.x = swimPitchR * sw;
          // Clamped exactly as the local pose is: past PRONE this stops being
          // "how flat" and would over-drive the roll and the leg trail.
          const prone = Math.min(1, swimPitchR / SWIM_PRONE);
          model.rotation.z = s * (a11y.reducedMotion ? 0.09 : 0.18) * prone * sw;
          // The same pose as applySwimPose, on the peer's own cached rest
          // (world law 2: remote peers keep their own copies — fix both). A
          // crawl is a WINDMILL turning forward over the top (the clock
          // rises); the two arms sit half a revolution apart; the stroke
          // blends with the tread by strokeW and with the clip by swimW.
          // test/swimStroke.test.ts measures this copy's hand path against
          // the local one on player.glb.
          const legT = 0.3 * prone;
          const c = Math.cos(swimClock);
          peerArmL = swimArmStep(
            peerArmL,
            restLocalAngleX(clip.rest.armL, clip.clipOf('armL')),
            0.55 + s * 0.35,
            0.35 * c * rate,
            swimClock,
            SWIM_STROKE_RATE,
            peerStrokeW,
            sw,
            dt,
          );
          peerArmR = swimArmStep(
            peerArmR,
            restLocalAngleX(clip.rest.armR, clip.clipOf('armR')),
            0.55 - s * 0.35,
            -0.35 * c * rate,
            swimClock + Math.PI,
            SWIM_STROKE_RATE,
            peerStrokeW,
            sw,
            dt,
          );
          if (armLBone)
            swimArmQuat(armLBone.quaternion, clip.rest.armL, clip.clipOf('armL'), peerArmL, sw);
          if (armRBone)
            swimArmQuat(armRBone.quaternion, clip.rest.armR, clip.clipOf('armR'), peerArmR, sw);
          const off = (a: number) => Math.abs(Math.atan2(Math.sin(a), Math.cos(a)));
          peerArmsOff = Math.max(
            off(restLocalAngleX(clip.rest.armL, clip.clipOf('armL')) - peerArmL),
            off(restLocalAngleX(clip.rest.armR, clip.clipOf('armR')) - peerArmR),
          );
          peerSwimLimb('legL', legT + s2 * 0.35, sw);
          peerSwimLimb('legR', legT - s2 * 0.35, sw);
          if (!swimming && peerSwimW < 0.002 && peerArmsOff < 0.02) peerSwimSeeded = false;
        } else if (activePose === 2) {
          // Riding: forward lean, hands forward onto the helm, knees up.
          model.rotation.set(0.12 * poseW, 0, 0);
          // REST-ANCHORED (world law 2), exactly like the swim block above and
          // like applyRidePose does for the local player. This used to lerp
          // FROM the live rotation.x TO a raw -0.7 / -0.6, which broke twice
          // over. MEASURED on the shipped build, settled (poseW = 1):
          //   arms (0.12,  0.81, -0.57)  legs (0,  0.89, -0.46)
          // i.e. all four limbs pointing UP over the head and BACKWARD, for
          // the whole ride — against the local rider's arms (0, -0.88, 0.48)
          // and legs (0, -1, 0). The raw target was the 180-degree flip the
          // law names; -PI/+PI + delta puts it back.
          //
          // The lerp FROM the live value was the second half. MEASURED over a
          // 4s walk cycle, the mixer swings armL.rotation.x across -3.115 ..
          // +3.133 and CROSSES the +/-PI boundary 6 times, so the arc taken on
          // mount depended on which frame you happened to mount. Worse, the
          // shortest path from +PI to a raw -0.6 runs THROUGH ZERO: the legs
          // measured (0,-0.82,0.57) -> (0,-0.03,1.00) -> (0,0.76,0.65) ->
          // (0,1.00,0.07) in four frames, sweeping up through the torso and
          // over the head every single time a peer got on a boat.
          //
          // The byte carries no vehicle kind (boat vs jetski), so one blended
          // attitude serves both; the local deltas straddle these values.
          if (armLBone) armLBone.rotation.x = -Math.PI + RIDE_PEER_ARM_X * poseW;
          if (armRBone) armRBone.rotation.x = -Math.PI + RIDE_PEER_ARM_X * poseW;
          if (legLBone) legLBone.rotation.x = Math.PI + RIDE_PEER_LEG_X * poseW;
          if (legRBone) legRBone.rotation.x = Math.PI + RIDE_PEER_LEG_X * poseW;
        } else {
          // Airborne: arms up, knees tucked, composed onto the clip output
          // (LimbClip), never onto the live bone, which the mixer may not
          // have rewritten this frame.
          model.rotation.set(0, 0, 0);
          clip.onClip('armL', -0.85 * poseW);
          clip.onClip('armR', -0.85 * poseW);
          clip.onClip('legL', -0.45 * poseW);
          clip.onClip('legR', -0.45 * poseW);
        }
      } else {
        // On foot: the local player's gait layer (B3) on the peer's own clip —
        // stride gain, bob, stance roll and lean, from the streamed speed.
        const gw = walk ? walk.getEffectiveWeight() : 0;
        const reduced = a11y.reducedMotion;
        const calm = reduced ? 0.5 : 1;
        if (gw > 0.001 && fx.on('gait')) {
          const g = gaitLegGain(speed);
          const ga = 1 + 0.6 * (g - 1);
          clip.onClip('legL', (g - 1) * clip.clipAngleX('legL') * gw);
          clip.onClip('legR', (g - 1) * clip.clipAngleX('legR') * gw);
          clip.onClip('armL', (ga - 1) * clip.clipAngleX('armL') * gw);
          clip.onClip('armR', (ga - 1) * clip.clipAngleX('armR') * gw);
          const dur = walk ? walk.getClip().duration || 1 : 1;
          const phase = walk ? (((walk.time % dur) + dur) % dur) / dur : 0;
          const run = THREE.MathUtils.smoothstep(speed, 5.8, 8.0);
          gaitBob =
            THREE.MathUtils.lerp(0.035, 0.06, run) *
            gw *
            calm *
            0.5 *
            (1 + Math.cos(4 * Math.PI * phase));
          gaitRoll = -0.05 * Math.sin(2 * Math.PI * phase) * gw * calm;
          const leanTarget = reduced ? 0 : THREE.MathUtils.lerp(0.07, 0.17, run) * gw;
          gaitLean += (leanTarget - gaitLean) * Math.min(1, 8 * dt);
        } else {
          gaitBob = 0;
          gaitRoll = 0;
          gaitLean += (0 - gaitLean) * Math.min(1, 8 * dt);
        }
        model.rotation.set(gaitLean, 0, gaitRoll);
      }
      model.position.y = baseY - (weight > 0.001 ? 0 : gaitBob);
      if (waveT > 0) {
        waveT = Math.max(0, waveT - dt);
        const elapsed = SimplePlayer.WAVE_DURATION - waveT;
        const env = Math.min(Math.min(1, elapsed / 0.15), Math.min(1, waveT / 0.25));
        if (armRBone) {
          // Same rest-relative rule as the local player: the arm hangs at
          // -PI, and -2.6 is a delta from it. Written raw it swung the hand
          // down and behind the hip — peers waved backwards too.
          armRBone.rotation.x = -Math.PI + -2.6 * env;
          armRBone.rotation.z = Math.sin(elapsed * 14) * 0.4 * env;
        }
      }
    };
    const setPose = (pose: number): void => {
      curPose = pose;
    };
    const setSwimMotion = (radialRate: number, tangSpeed: number): void => {
      swimRadial = radialRate;
      swimTang = tangSpeed;
    };
    const wave = (): void => {
      waveT = SimplePlayer.WAVE_DURATION;
    };
    const dispose = (): void => {
      mixer?.stopAllAction();
      // Materials were cloned per-peer above, so disposing them here is safe
      // (geometry stays shared with the base and is NOT disposed).
      for (const m of clonedMats) m.dispose();
    };

    return { body, headBone, update, setPose, setSwimMotion, wave, dispose };
  }

  /**
   * A dress material in the island's look (B15): an opaque standard material
   * becomes toon on the shared ramp under the cel theme (Materials.toonify:
   * its uuid comes from the converter's own generator, never the world's
   * seeded stream). Anything else, and everything under ?theme=real, is
   * returned as it came.
   */
  private static celDress(mat: THREE.Material): THREE.Material {
    const std = mat as THREE.MeshStandardMaterial;
    if (!isCelTheme() || !std.isMeshStandardMaterial || std.transparent) return mat;
    return Materials.toonify(std);
  }

  /** Procedural toon hats sold in the island shop (also used by remote avatars). */
  public static buildHat(id: HatId): THREE.Group {
    const g = new THREE.Group();
    g.name = 'player_hat';
    if (id === 'party') {
      const cone = new THREE.Mesh(
        new THREE.ConeGeometry(0.14, 0.32, 10),
        Materials.createToonMaterial(0xe84a5f),
      );
      cone.position.y = 0.16;
      g.add(cone);
      const pom = new THREE.Mesh(
        new THREE.SphereGeometry(0.05, 8, 6),
        Materials.createToonMaterial(0xfff5e0),
      );
      pom.position.y = 0.34;
      g.add(pom);
      g.rotation.z = 0.12;
    } else if (id === 'top') {
      const brim = new THREE.Mesh(
        new THREE.CylinderGeometry(0.24, 0.24, 0.03, 14),
        Materials.createToonMaterial(0x22222c),
      );
      g.add(brim);
      const crownPart = new THREE.Mesh(
        new THREE.CylinderGeometry(0.14, 0.15, 0.28, 14),
        Materials.createToonMaterial(0x22222c),
      );
      crownPart.position.y = 0.15;
      g.add(crownPart);
      const band = new THREE.Mesh(
        new THREE.CylinderGeometry(0.152, 0.155, 0.06, 14),
        Materials.createToonMaterial(0xc0392b),
      );
      band.position.y = 0.05;
      g.add(band);
    } else if (id === 'crown') {
      const goldMat = new THREE.MeshStandardMaterial({
        color: 0xffd34a,
        metalness: 0.7,
        roughness: 0.3,
        emissive: 0x553d00,
        emissiveIntensity: 0.25,
      });
      const ring = new THREE.Mesh(
        new THREE.CylinderGeometry(0.17, 0.19, 0.12, 10, 1, true),
        goldMat,
      );
      ring.material.side = THREE.DoubleSide;
      g.add(ring);
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2;
        const spike = new THREE.Mesh(new THREE.ConeGeometry(0.035, 0.11, 4), goldMat);
        spike.position.set(Math.cos(a) * 0.17, 0.11, Math.sin(a) * 0.17);
        g.add(spike);
      }
    } else if (id === 'cap') {
      // Baseball cap: dome + forward brim
      const capMat = Materials.createToonMaterial(0x3f6fb5);
      const dome = new THREE.Mesh(
        new THREE.SphereGeometry(0.2, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.5),
        capMat,
      );
      dome.scale.y = 0.75;
      g.add(dome);
      const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.15, 0.025, 10), capMat);
      brim.scale.z = 1.4;
      brim.position.set(0, 0.01, 0.2);
      g.add(brim);
      const button = new THREE.Mesh(
        new THREE.SphereGeometry(0.035, 8, 6),
        Materials.createToonMaterial(0x2c4f85),
      );
      button.position.y = 0.155;
      g.add(button);
    } else if (id === 'flower') {
      // Flower crown: leafy ring with alternating blooms
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(0.18, 0.035, 8, 16),
        Materials.createToonMaterial(0x4a8c3a),
      );
      ring.rotation.x = Math.PI / 2;
      ring.position.y = 0.04;
      g.add(ring);
      const BLOOM_COLORS = [0xe84a5f, 0xf7c948, 0xba68c8, 0xff8a65];
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        const bloom = new THREE.Mesh(
          new THREE.SphereGeometry(0.045, 8, 6),
          Materials.createToonMaterial(BLOOM_COLORS[i % BLOOM_COLORS.length]),
        );
        bloom.position.set(Math.cos(a) * 0.18, 0.07, Math.sin(a) * 0.18);
        g.add(bloom);
      }
    } else if (id === 'wizard') {
      // Wizard hat: tall starry cone with a wide floppy brim
      const feltMat = Materials.createToonMaterial(0x4b3a8c);
      const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.3, 0.03, 14), feltMat);
      g.add(brim);
      const cone = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.42, 12), feltMat);
      cone.position.y = 0.22;
      cone.rotation.z = 0.1;
      g.add(cone);
      const starMat = new THREE.MeshStandardMaterial({
        color: 0xffe066,
        emissive: 0xccaa22,
        emissiveIntensity: 0.5,
      });
      for (const [sx, sy, sz] of [
        [0.09, 0.16, 0.1],
        [-0.08, 0.28, 0.05],
        [0.02, 0.1, -0.12],
      ]) {
        const star = new THREE.Mesh(new THREE.OctahedronGeometry(0.028), starMat);
        star.position.set(sx, sy, sz);
        g.add(star);
      }
    } else if (id === 'pirate') {
      // Pirate bicorn: dark oval brim + rounded crown + white skull
      const blackMat = Materials.createToonMaterial(0x1c1c22);
      const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.27, 0.29, 0.03, 16), blackMat);
      brim.scale.x = 0.78;
      g.add(brim);
      const crown = new THREE.Mesh(
        new THREE.SphereGeometry(0.18, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.55),
        blackMat,
      );
      crown.scale.set(0.85, 0.7, 1);
      crown.position.y = 0.05;
      g.add(crown);
      const skull = new THREE.Mesh(
        new THREE.SphereGeometry(0.05, 8, 6),
        Materials.createToonMaterial(0xf3ecdd),
      );
      skull.scale.set(1, 1.15, 0.55);
      skull.position.set(0, 0.09, 0.19);
      g.add(skull);
    } else if (id === 'chef') {
      // Chef's toque: white band + a tall puffy top
      const whiteMat = Materials.createToonMaterial(0xf7f7f2);
      const band = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.13, 16), whiteMat);
      band.position.y = 0.06;
      g.add(band);
      const puff = new THREE.Mesh(new THREE.SphereGeometry(0.2, 14, 10), whiteMat);
      puff.scale.y = 0.9;
      puff.position.y = 0.22;
      g.add(puff);
    } else if (id === 'headphones') {
      // Headphones: an arc band over the head + two accented ear cups
      const bandMat = Materials.createToonMaterial(0x2c2c33);
      const cupMat = Materials.createToonMaterial(0x3a3a44);
      const accentMat = Materials.createToonMaterial(0xe84a5f);
      const band = new THREE.Mesh(new THREE.TorusGeometry(0.2, 0.022, 8, 20, Math.PI), bandMat);
      band.position.y = -0.02;
      g.add(band);
      for (const sx of [-0.2, 0.2]) {
        const cup = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 0.06, 14), cupMat);
        cup.rotation.z = Math.PI / 2;
        cup.position.set(sx, -0.02, 0);
        g.add(cup);
        const ring = new THREE.Mesh(new THREE.TorusGeometry(0.055, 0.013, 6, 14), accentMat);
        ring.rotation.y = Math.PI / 2;
        ring.position.set(sx * 1.04, -0.02, 0);
        g.add(ring);
      }
    } else {
      // halo — floats just above the head, glowing
      const halo = new THREE.Mesh(
        new THREE.TorusGeometry(0.14, 0.025, 10, 22),
        new THREE.MeshStandardMaterial({
          color: 0xffe680,
          emissive: 0xffd700,
          emissiveIntensity: 1.2,
          metalness: 0.4,
          roughness: 0.2,
        }),
      );
      halo.rotation.x = Math.PI / 2;
      halo.position.y = 0.22;
      g.add(halo);
    }
    g.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) o.castShadow = true;
    });
    // The crown's gold, the star and the halo are authored standard: toon, on
    // the shared ramp, like the hats built toon above (B15).
    if (isCelTheme()) Materials.toonifyTree(g);
    return g;
  }

  /** Whether the player is currently standing on the ground (for SFX etc.). */
  public isOnGround(): boolean {
    return this.isGrounded;
  }

  public isSeated(): boolean {
    return this.seated;
  }

  /**
   * Sit at a world position facing `faceDir` (surface-tangent). Physics
   * freezes; the model is posed (GLTF: mixer paused + leg bones forward,
   * fallback: hip pivots forward) until standUp().
   */
  public sitDown(seatPos: THREE.Vector3, faceDir: THREE.Vector3): void {
    this.seated = true;
    this.velocity.set(0, 0, 0);
    // Drop any swim tilt, exactly as setRiding does. update() returns at the
    // seated branch BEFORE the swimPoseActive self-heal, and applySitPose only
    // writes limb bones — never the model root — so sitting on the frame you
    // leave the water used to hold the tilt for the whole seated period. It
    // was a one-frame race at 1.35; a head-down dive pitch makes it obvious.
    this.clearSwimPose();
    this.swimPoseActive = false;
    this.playerPosition.copy(seatPos);
    // Orient: up = surface normal, forward (+Z of the model) = faceDir
    const up = this.getSurfaceNormal();
    const fwd = faceDir
      .clone()
      .sub(up.clone().multiplyScalar(faceDir.dot(up)))
      .normalize();
    // Write the seat facing into YAW, not into the quaternion. Writing the
    // quaternion here was DEAD CODE: updateWorldMatrix (below, and again on
    // every seated frame) unconditionally rebuilds it as
    // `yawQuat(surfaceNormal, this.yaw) * alignQuat`, and sitDown never set
    // this.yaw — so the carefully built seat basis was discarded on the same
    // line that applied it, and you sat facing whichever way you happened to
    // walk up. Solving for yaw instead means the one owner of the transform
    // keeps owning it.
    const align = this._alignQuat.setFromUnitVectors(SimplePlayer._poleUp, up);
    const ref = new THREE.Vector3(0, 0, 1).applyQuaternion(align); // model +Z at yaw 0
    this.yaw = Math.atan2(up.dot(ref.clone().cross(fwd)), ref.dot(fwd));
    this.updateWorldMatrix();
  }

  /** Stand up from a bench: unfreeze physics with a small forward step. */
  public standUp(): void {
    if (!this.seated) return;
    this.seated = false;
    const up = this.getSurfaceNormal();
    const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(this.quaternion);
    fwd.sub(up.clone().multiplyScalar(fwd.dot(up))).normalize();
    this.playerPosition.addScaledVector(fwd, 0.7).addScaledVector(up, 0.15);
    this.updateWorldMatrix();
  }

  /** Pose applied every frame while seated. */
  private applySitPose(): void {
    if (this.gltfModel) {
      // Mixer is paused while seated (update() skips it) — pose the leg
      // bones directly; the mixer re-drives them on stand-up.
      if (!this.legLBone || !this.legRBone) {
        this.gltfModel.traverse((o) => {
          const bone = o as THREE.Bone;
          if (!bone.isBone) return;
          if (o.name === 'legL') this.legLBone = bone;
          if (o.name === 'legR') this.legRBone = bone;
        });
      }
      // REST-ANCHORED (world law 2), same conversion as the ride pose: the
      // GLB's legs rest at R_x(PI), so a raw -1.35 wiped it and gave a limb
      // axis of (0, 0.22, -0.98) — thighs up and BACK, through the bench.
      // PI - 1.35 = 1.79 -> (0, -0.22, 0.98): forward over the seat edge.
      // The procedural values below are NOT touched; that rig's rest is
      // identity, which is why the same constant sent the two rigs opposite
      // ways and is the tell that this branch was wrong.
      if (this.legLBone) this.legLBone.rotation.x = Math.PI - 1.35;
      if (this.legRBone) this.legRBone.rotation.x = Math.PI - 1.35;
    } else if (this.legPivots.length === 2) {
      this.legPivots[0].rotation.x = -1.45;
      this.legPivots[1].rotation.x = -1.45;
      this.armPivots[0].rotation.x = -0.25;
      this.armPivots[1].rotation.x = -0.25;
    }
  }

  /** Read-and-clear the "entered the water this frame" edge (entry splash). */
  public consumeWaterEntry(): boolean {
    const v = this.justEnteredWater;
    this.justEnteredWater = false;
    return v;
  }

  /**
   * Prone swim pose + stroke cycle. Tilts the body face-down along the
   * surface and drives an alternating overhead arm pull with a flutter
   * kick. Runs with the GLTF mixer paused (bones posed directly) or on the
   * procedural pivots. dt advances the stroke clock; `moving` picks the
   * cadence (a gentle tread when holding station).
   */
  // Eased body pitch while in water: → PRONE when stroking, → TREAD when
  // holding station, → along the DIRECTION OF TRAVEL while descending or
  // rising. Zeroed by clearSwimPose so every exit path resets it.
  private swimPitch = 0;

  /**
   * Last radius, so the pose can see the vertical motion the VELOCITY HIDES.
   *
   * The dive does not move the body through `this.velocity` — it writes the
   * radius directly (`playerPosition.setLength`) and then actively KILLS the
   * radial velocity so gravity can't compound the descent. So a pitch derived
   * from `this.velocity` would be blind to the entire dive. The frame-to-frame
   * radius is the only honest source, and it also picks up the float, the
   * rate-limited ascent and the wave bob for free.
   *
   * 0 means "no previous sample" — first frame in the water reports no vertical
   * rate rather than a garbage one, which also absorbs teleports and respawns.
   */
  private poseDist = 0;

  private applySwimPose(dt: number, afloat: boolean, tangSpeed = 0): void {
    // B5: eased weights instead of switches. swimW carries the clip into the
    // swim pose at 6/s (and out at 5/s, blendSwimExit); strokeW moves between
    // tread and stroke at 4/s, toward stroke above 0.6 u/s and toward tread
    // below 0.3 u/s (the old hard 0.4 u/s gate popped the arms).
    if (this.swimW < 0.001 && !this.swimSeeded) {
      // Entry: the stroke clock and both arms start where the arms already
      // are (their clip angles about rest), so the first frame does not jump.
      const rest = this.limbClip.rest;
      for (const k of LIMB_KEYS) {
        this.swimAng[k] = restLocalAngleX(rest[k], this.limbClip.clipOf(k));
      }
      this.swimPhase = this.swimAng.armL;
      this.swimSeeded = true;
    }
    this.swimW += (1 - this.swimW) * Math.min(1, 6 * dt);
    if (!afloat || tangSpeed < 0.3) this.strokeTarget = 0;
    else if (tangSpeed > 0.6) this.strokeTarget = 1;
    this.strokeW += (this.strokeTarget - this.strokeW) * Math.min(1, 4 * dt);
    const moving = this.strokeW > 0.5;
    const rate = THREE.MathUtils.lerp(SWIM_TREAD_RATE, SWIM_STROKE_RATE, this.strokeW);
    this.swimPhase += dt * rate;
    const s = Math.sin(this.swimPhase);
    const s2 = Math.sin(this.swimPhase * 2);
    // The body LIES DOWN into the stroke and rights itself to tread — the
    // old fixed 1.15 pitch read as "standing at a lean" in both states.
    // min(1,k·dt) composes across the ≤20ms physics substeps.
    // POINT THE BODY WHERE IT IS GOING. The surface poses stay exactly as
    // authored for horizontal swimming; swimPitchTarget only bends them once
    // the swimmer is genuinely moving up or down. Shared with remote peers.
    const dist = this.playerPosition.length();
    const radialRate = this.poseDist > 0 ? (dist - this.poseDist) / Math.max(dt, 1e-4) : 0;
    this.poseDist = dist;
    const pitchTarget = swimPitchTarget(radialRate, tangSpeed, moving, this.diving);
    this.swimPitch += (pitchTarget - this.swimPitch) * Math.min(1, 6 * dt);
    // CLAMPED at 1: past PRONE this is no longer "how flat" but "how far past
    // flat", and it drives the leg trail and the roll. Unclamped, a 2.15 dive
    // pitch would push it to 1.59 and swing the legs 0.48 rad instead of 0.3.
    const prone = Math.min(1, this.swimPitch / SWIM_PRONE); // 0..1 how flat
    // Legs trail BEHIND the body as it flattens, flutter riding on top.
    //
    // legL/legR have a NON-identity rest of exactly R_x(PI) (the bone's +Y
    // runs DOWN the limb), so rotation.x reads PI when the leg hangs neutral
    // and the Walk clip swings PI +/- 0.65. The old base of 0.3 was an
    // absolute write that wiped that PI and flipped each leg 180 degrees to
    // point up along the body — which the face-down swimPitch then aimed
    // straight at the head. Anchor to PI and the authored +0.3 trailing bias
    // is correct as written: measured on the rig, PI+0.3 moves the foot to
    // model z -0.15 (BACK) and PI-0.3 to +0.15 (forward).
    const legBase = Math.PI + 0.3 * prone;
    if (this.gltfModel) {
      if (!this.armLBone || !this.legLBone) {
        this.gltfModel.traverse((o) => {
          const b = o as THREE.Bone;
          if (!b.isBone) return;
          if (o.name === 'legL') this.legLBone = b;
          if (o.name === 'legR') this.legRBone = b;
          if (o.name === 'armL') this.armLBone = b;
          if (o.name === 'armR') this.armRBone = b;
        });
      }
      // Face-down along the water, rolling with the stroke only while prone.
      // Reduced motion: half the roll (0.09).
      const roll = a11y.reducedMotion ? 0.09 : 0.18;
      this.gltfModel.rotation.x = this.swimPitch;
      this.gltfModel.rotation.z = s * roll * prone;
      // Alternating front-crawl while stroking; soft sculling tread idle.
      // A crawl is a WINDMILL, not an oscillation, and it has a DIRECTION:
      // under the prone pitch the limb points along (cos(t+p), sin(t+p)) in
      // (up, forward), so t must RISE with the phase — the hand travels
      // forward over the top (the recovery) and back under the body (the
      // pull). MEASURED on the live rig (world law 3): the first windmill,
      // `REST_X - swimPhase`, moved every hand backward over the top.
      // test/swimStroke.test.ts checks the hand path on player.glb for this
      // copy and the remote-peer copy. The two arms sit half a revolution
      // apart.
      //
      // B5: every limb composes onto its cached REST quaternion (world law 2)
      // and is slerped from the clip by swimW, so entry, the tread/stroke
      // change and exit ease instead of popping:
      //   limb = slerp(clip, rest·Rx(angle), swimW)
      // with each arm's angle stepped by swimArmStep between the tread
      // (0.55 ± 0.35·sin) and the stroke clock by strokeW. The arms rest at
      // Euler (−3.1328, ∓0.0931, ±0.0939), not Rx(±π), so rest·Rx moves the
      // hands up to 0.10 u from the old absolute writes, by design (rig
      // --compare's swim row). The legs rest at exactly Rx(π), so theirs are
      // unchanged: Rx(π + 0.3·prone ± flutter).
      const sw = this.swimW;
      const kw = this.strokeW;
      const c = Math.cos(this.swimPhase);
      const a = this.swimAng;
      const rest = this.limbClip.rest;
      a.armL = swimArmStep(
        a.armL,
        restLocalAngleX(rest.armL, this.limbClip.clipOf('armL')),
        0.55 + s * 0.35,
        0.35 * c * rate,
        this.swimPhase,
        SWIM_STROKE_RATE,
        kw,
        sw,
        dt,
      );
      a.armR = swimArmStep(
        a.armR,
        restLocalAngleX(rest.armR, this.limbClip.clipOf('armR')),
        0.55 - s * 0.35,
        -0.35 * c * rate,
        this.swimPhase + Math.PI,
        SWIM_STROKE_RATE,
        kw,
        sw,
        dt,
      );
      for (const k of ['armL', 'armR'] as const) {
        const b = this.limbBone(k);
        if (b) swimArmQuat(b.quaternion, rest[k], this.limbClip.clipOf(k), a[k], sw);
      }
      // Flutter kick behind the travel direction (small angles: a slerp from
      // the clip by swimW cannot flip).
      a.legL = legBase - Math.PI + s2 * 0.35;
      a.legR = legBase - Math.PI - s2 * 0.35;
      this.swimLimb('legL', a.legL, sw);
      this.swimLimb('legR', a.legR, sw);
    } else if (this.legPivots.length === 2 && this.armPivots.length === 2) {
      this.mesh.rotation.x = this.swimPitch;
      this.mesh.rotation.z = s * 0.18 * prone;
      this.armPivots[0].rotation.x = moving ? -1.4 + s * 1.3 : -1.1 + s * 0.5;
      this.armPivots[1].rotation.x = moving ? -1.4 - s * 1.3 : -1.1 - s * 0.5;
      // Procedural fallback avatar: its pivots have an IDENTITY rest (0 is
      // already legs-down), so this path keeps the small offset and must NOT
      // take the GLB's PI base — the two rigs genuinely differ here.
      const pivotKick = 0.3 * prone;
      this.legPivots[0].rotation.x = pivotKick + s2 * 0.35;
      this.legPivots[1].rotation.x = pivotKick - s2 * 0.35;
    }
  }

  /**
   * One limb of the swim pose (B5): its angle composed on the cached rest,
   * slerped from the clip by swimW. Quaternions throughout, so nothing reads
   * a live Euler near ±π; the angle itself never jumps (swimArmStep), and
   * clip and target stay close while swimW is between 0 and 1.
   */
  private swimLimb(k: LimbKey, angle: number, swimW: number): void {
    const b = this.limbBone(k);
    if (!b) return;
    const q = this.swimTargetQ[k]
      .copy(this.limbClip.rest[k])
      .multiply(_swimTurn.setFromAxisAngle(_limbAxisX, angle));
    b.quaternion.copy(this.limbClip.clipOf(k)).slerp(q, swimW);
  }

  private limbBone(k: LimbKey): THREE.Bone | null {
    return k === 'armL'
      ? this.armLBone
      : k === 'armR'
        ? this.armRBone
        : k === 'legL'
          ? this.legLBone
          : this.legRBone;
  }

  /**
   * Out of the water (B5): swimW falls at 5/s, and each limb slerps from what
   * the land layers wrote this frame toward the last swim pose by swimW; the
   * body's pitch and roll ease to 0 with it in writeBody. Replaces the old
   * exit's `rotation.x = 0` writes, which by this rig's convention pointed
   * every limb straight UP for a frame (the 151° exit pop).
   */
  private blendSwimExit(dt: number): void {
    if (!this.swimSeeded) return;
    this.swimW += (0 - this.swimW) * Math.min(1, 5 * dt);
    if (this.swimW < 0.001) this.swimW = 0;
    // Each limb's swim angle walks back to the angle the land layers just
    // wrote, at most 6 rad/s, and the pose is rebuilt on that angle; the
    // exit ends once swimW is spent AND every angle has arrived, so an arm
    // left overhead swings down instead of snapping.
    let settled = this.swimW === 0;
    const rest = this.limbClip.rest;
    for (const k of LIMB_KEYS) {
      const b = this.limbBone(k);
      if (!b) continue;
      const alpha = restLocalAngleX(rest[k], b.quaternion);
      const d = Math.atan2(Math.sin(alpha - this.swimAng[k]), Math.cos(alpha - this.swimAng[k]));
      const step = THREE.MathUtils.clamp(d * Math.min(1, 6 * dt), -6 * dt, 6 * dt);
      this.swimAng[k] += step;
      if (Math.abs(d - step) > 0.01) settled = false;
      if (k === 'armL' || k === 'armR') {
        swimArmQuat(b.quaternion, rest[k], b.quaternion, this.swimAng[k], this.swimW);
      } else {
        const q = this.swimTargetQ[k]
          .copy(rest[k])
          .multiply(_swimTurn.setFromAxisAngle(_limbAxisX, this.swimAng[k]));
        b.quaternion.slerp(q, this.swimW);
      }
    }
    if (settled) {
      this.swimW = 0;
      this.strokeW = 0;
      this.strokeTarget = 0;
      this.swimSeeded = false;
    }
  }

  /**
   * Riding pose — distinct from walking and swimming. Jetski: seated,
   * leaning forward with knees up and hands on the bars. Boat: standing at
   * the helm, hands forward. Mixer stays paused; bones posed directly (or
   * the procedural pivots) with a gentle idle sway.
   */
  private applyRidePose(dt: number): void {
    this.rideBob += dt * 2.2;
    const sway = Math.sin(this.rideBob) * 0.05;
    const jetski = this.rideKind === 'jetski';
    const lean = jetski ? 0.32 : 0.06;
    const legX = jetski ? -1.15 : 0.0;
    const armX = jetski ? -0.95 : -0.5;
    if (this.gltfModel) {
      if (!this.armLBone || !this.legLBone) {
        this.gltfModel.traverse((o) => {
          const b = o as THREE.Bone;
          if (!b.isBone) return;
          if (o.name === 'legL') this.legLBone = b;
          if (o.name === 'legR') this.legRBone = b;
          if (o.name === 'armL') this.armLBone = b;
          if (o.name === 'armR') this.armRBone = b;
        });
      }
      this.gltfModel.rotation.set(lean, 0, sway);
      // REST-ANCHORED, like the swim/wave/chop poses. legX/armX below were
      // authored for the PROCEDURAL rig, whose pivots have an IDENTITY rest,
      // and this branch reused them raw — wiping the GLB's non-identity rest
      // exactly as world law 2 warns. MEASURED on the live rig before the fix:
      // legL.rotation.x = 0 gave a limb axis of (0, 1, 0), i.e. BOTH LEGS
      // POINTING STRAIGHT UP the torso, and armR = -0.5 gave (0, 0.88, -0.48),
      // up and BACKWARD off the helm. Every second of every ride, dead centre
      // of the chase frame.
      //
      // The two rigs differ by exactly their rest, so the conversion is
      // GLB = REST + procedural, the same relation the swim legs already use
      // (`Math.PI + 0.3 * prone` there against `0.3 * prone` here). Limb axis
      // is (0, cos t, sin t) with +Z forward, which makes the results:
      //   boat legs   PI + 0.0  = 3.14 -> (0,-1.00, 0.00) straight down, standing
      //   jetski legs PI - 1.15 = 1.99 -> (0,-0.41, 0.91) knees up and forward
      //   boat arms  -PI - 0.5  = -3.64 -> (0,-0.88, 0.48) down and forward, at the helm
      //   jetski arms -PI - 0.95 = -4.09 -> (0,-0.59, 0.81) forward onto the bars
      if (this.legLBone) this.legLBone.rotation.x = Math.PI + legX;
      if (this.legRBone) this.legRBone.rotation.x = Math.PI + legX;
      if (this.armLBone) this.armLBone.rotation.x = -Math.PI + armX;
      if (this.armRBone) this.armRBone.rotation.x = -Math.PI + armX;
    } else if (this.legPivots.length === 2 && this.armPivots.length === 2) {
      this.mesh.rotation.set(lean, 0, sway);
      this.legPivots[0].rotation.x = legX;
      this.legPivots[1].rotation.x = legX;
      this.armPivots[0].rotation.x = armX;
      this.armPivots[1].rotation.x = armX;
    }
  }

  /** Undo the swim tilt when leaving the water (mixer resumes on land). */
  private clearSwimPose(): void {
    this.swimPitch = 0; // next water entry eases in from upright again
    // Drop the radius sample too, or the first frame of the NEXT swim measures
    // a vertical rate across the whole walk between the two swims.
    this.poseDist = 0;
    if (this.gltfModel) {
      // B5: the pitch and roll ease out with swimW in writeBody.
      this.swimExitPitch = this.swimW > 0 ? this.gltfModel.rotation.x / this.swimW : 0;
      this.swimExitRoll = this.swimW > 0 ? this.gltfModel.rotation.z / this.swimW : 0;
    } else {
      this.mesh.rotation.x = 0;
      this.mesh.rotation.z = 0;
    }
  }

  /** Cache the four limb bones once (used by the air pose + wave). */
  private ensureLimbBones(): void {
    if (!this.gltfModel) return;
    if (this.armLBone && this.armRBone && this.legLBone && this.legRBone) return;
    this.gltfModel.traverse((o) => {
      const b = o as THREE.Bone;
      if (!b.isBone) return;
      if (o.name === 'legL') this.legLBone = b;
      else if (o.name === 'legR') this.legRBone = b;
      else if (o.name === 'armL') this.armLBone = b;
      else if (o.name === 'armR') this.armRBone = b;
    });
  }

  /** Start the ~1.2s arm-raise wave gesture (triggered by the local Q wave). */
  public triggerWave(): void {
    this.waveTime = SimplePlayer.WAVE_DURATION;
  }

  /** The right-hand attachment point for held tools (rod, axe). Props parented
   *  here ride the swing gestures for free. GLTF bone on the real avatar,
   *  shoulder pivot on the fallback body; null before either exists. */
  public getHandAnchor(): THREE.Object3D | null {
    if (this.gltfModel) {
      this.ensureLimbBones();
      return this.armRBone;
    }
    return this.armPivots.length === 2 ? this.armPivots[1] : null;
  }

  /** Party groove — post-mixer arm pumps for the beach-house dance floor.
   *  Call AFTER tickInteriorAnimation each frame; the clips self-heal the
   *  bones the frame this stops being called. 120bpm to match the room. */
  public applyPartyDance(t: number): void {
    const b = t * 2 * Math.PI;
    if (this.gltfModel) {
      this.ensureLimbBones();
      // REST-ANCHORED (world law 2). The -0.9 +/- sin*0.6 below was authored for
      // the PROCEDURAL rig (identity rest) and this branch reused it raw, so it
      // wiped the GLB's -PI arm rest. MEASURED across a full beat before the fix:
      // the arm axis y stayed in +0.203..+0.943 and z in -0.62..-0.33 — BOTH arms
      // locked up over the head and BEHIND it for the entire dance, oscillating
      // between up-back and further-up-back. Same conversion as the ride, swim
      // and wave poses: GLB = REST + procedural.
      const pump = Math.sin(b) * 0.6;
      if (this.armLBone) this.armLBone.rotation.x = -Math.PI + (-0.9 + pump);
      if (this.armRBone) this.armRBone.rotation.x = -Math.PI + (-0.9 - pump);
    } else if (this.armPivots.length === 2) {
      this.armPivots[0].rotation.x = -0.9 + Math.sin(b) * 0.6;
      this.armPivots[1].rotation.x = -0.9 - Math.sin(b) * 0.6;
    }
  }

  /** Start the feed-toss gesture (windup, underhand scatter, settle). Called
   *  only AFTER the scene confirms the throw — a refused throw (night, over
   *  sea) must not wind up an arm for nothing. The wave owns armR while it
   *  plays, so a mid-wave toss skips the gesture rather than fight it. */
  public triggerFeedToss(): void {
    if (this.waveTime > 0) return;
    this.feedTossTime = SimplePlayer.FEED_TOSS_DURATION;
  }

  /** Rod flick for cast/hook-set. Same arm-ownership rule as the toss: the
   *  wave owns armR while it plays, so skip rather than fight it. */
  public triggerCastGesture(): void {
    if (this.waveTime > 0 || this.feedTossTime > 0) return;
    this.castTime = SimplePlayer.CAST_DURATION;
    this.chopTime = 0; // newest tool gesture wins
  }

  /** Two-hand overhead axe swing (timber loop). */
  public triggerChopGesture(): void {
    if (this.waveTime > 0 || this.feedTossTime > 0) return;
    this.chopTime = SimplePlayer.CHOP_DURATION;
    this.castTime = 0;
  }

  /**
   * Jump/air pose + arm-wave, applied on top of the mixer output (which has
   * already written these bones this frame). Air: arms up + knees tucked,
   * eased in while airborne and back on land. Wave: the right arm raises and
   * wags for ~1.2s, overriding the air pose on that arm. On-foot only —
   * update() returns earlier for swim/ride/seat, so isGrounded is the gate.
   */
  private applyAirWavePose(dt: number): void {
    // B4: the air pose rises at 10/s and fades at 25/s on the LEGS, so the
    // tucked knees are gone by the landing frame instead of lifting the soles
    // through it. The arms keep the 10/s fade: they lift no sole, and a 25/s
    // drop on top of the touchdown squash jerked the hands 0.2 u in a frame.
    const k = Math.min(1, 10 * dt);
    const kLeg = Math.min(1, (this.isGrounded ? 25 : 10) * dt);
    this.airPoseWeight += ((this.isGrounded ? 0 : 1) - this.airPoseWeight) * k;
    this.airLegWeight += ((this.isGrounded ? 0 : 1) - this.airLegWeight) * kLeg;
    const aw = this.airPoseWeight;
    let waveEnv = 0;
    let waveElapsed = 0;
    if (this.waveTime > 0) {
      this.waveTime = Math.max(0, this.waveTime - dt);
      waveElapsed = SimplePlayer.WAVE_DURATION - this.waveTime;
      waveEnv = Math.min(Math.min(1, waveElapsed / 0.15), Math.min(1, this.waveTime / 0.25));
    }
    const wag = Math.sin(waveElapsed * 14) * 0.4;
    // Feed toss: a quick windup behind the hip, an underhand scatter swing
    // forward-up, then the mixer reclaims the arm as the envelope fades. The
    // whole pose is post-mixer like the wave, so it self-heals every frame.
    let tossEnv = 0;
    let tossAng = 0;
    let tossLean = 0;
    let tossCrouch = 0;
    if (this.feedTossTime > 0) {
      this.feedTossTime = Math.max(0, this.feedTossTime - dt);
      const te = SimplePlayer.FEED_TOSS_DURATION - this.feedTossTime;
      // MIRRORED 2026-08-11 (same inversion as the rod/chop): positive
      // rotation.x is visually forward on this +Z-facing model, so the old
      // windup swung toward the face and the scatter threw BEHIND — while the
      // feed pile lands in front.
      tossAng =
        te < 0.14
          ? -(te / 0.14) * 0.6 // windup: arm swings back (behind the hip)
          : -0.6 + Math.min(1, (te - 0.14) / 0.16) * 2.1; // scatter: underhand to +1.5, forward
      tossEnv = Math.min(1, this.feedTossTime / 0.26); // settle-out ease
      // Opposite arm counterweights slightly during the swing.
      tossLean = te > 0.14 ? 0.35 * tossEnv : 0;
      // Whole-body windup: knees bend + the body dips into the throw, then
      // releases through the scatter — the gesture reads from the legs up.
      tossCrouch = (te < 0.14 ? te / 0.14 : Math.max(0, 1 - (te - 0.14) / 0.22)) * tossEnv;
    }
    // Rod cast: over-shoulder windup (arm toward straight-up-back), then the
    // forward snap, settling out while the line flies. Same absolute-target +
    // lerp-by-envelope scheme as the toss (targets sit far from ±PI, so the
    // Euler sign-flip trap the wave dodges does not apply here).
    let castEnv = 0;
    let castAng = 0;
    if (this.castTime > 0) {
      this.castTime = Math.max(0, this.castTime - dt);
      const ce = SimplePlayer.CAST_DURATION - this.castTime;
      // MIRRORED 2026-08-11: the model faces +Z, so positive rotation.x is the
      // visually-FORWARD side (measured; the old -1.85 snap whipped the rod
      // down-BEHIND the avatar — the reported "inversed" rod).
      castAng =
        ce < 0.18
          ? -(ce / 0.18) * 0.35 // windup: rod arm rises up-and-back (real back)
          : -0.35 + Math.min(1, (ce - 0.18) / 0.2) * 2.2; // snap: whip to +1.85 (forward-down)
      castEnv = Math.min(1, this.castTime / 0.3);
    }
    // Axe chop: BOTH arms overhead, then a hard down-strike with a body dip —
    // the strike lands at ~0.22s, which GameScene syncs chips/shudder to.
    let chopEnv = 0;
    let chopAng = 0;
    let chopCrouch = 0;
    if (this.chopTime > 0) {
      this.chopTime = Math.max(0, this.chopTime - dt);
      const he = SimplePlayer.CHOP_DURATION - this.chopTime;
      // MIRRORED 2026-08-11 (same front/back inversion as the rod): the model
      // faces +Z, so POSITIVE rotation.x is the visually-forward side. Measured
      // live before the flip: the strike ended at limb.fwd -0.78 — the blade
      // swung down BEHIND the avatar while the tree stood in front (the impact
      // FX spawn at the tree independently, which is why it still read "fine").
      chopAng =
        he < 0.16
          ? -(he / 0.16) * 0.25 // overhead windup (up, slightly back — really back now)
          : // Strike ENDS forward-DOWN at +2.2 — the blade swings THROUGH the
            // trunk in front, not to a forward salute.
            -0.25 + Math.min(1, (he - 0.16) / 0.12) * 2.45;
      chopEnv = Math.min(1, this.chopTime / 0.22);
      // Dip INTO the strike, release through it — weight behind the axe.
      // The dip is the ONLY lower-body write: additive knee bends were
      // measured ACCUMULATING on this rig (legR drifted +2.29 rad in 14
      // frames — the leg pointed at the sky), so legs stay mixer-owned.
      chopCrouch = (he < 0.16 ? he / 0.16 : Math.max(0, 1 - (he - 0.16) / 0.24)) * chopEnv;
    }
    // Rod-hold weight eases toward its flag so entry/exit never pop.
    this.rodHoldW += ((this.rodHold ? 1 : 0) - this.rodHoldW) * Math.min(1, 6 * dt);
    if (this.gltfModel) {
      this.ensureLimbBones();
      // ADDITIVE layers compose onto the clip output (LimbClip), never onto the
      // live bone: the air pose, plus the toss's opposite-arm counterweight and
      // knee bend. Summed per limb, so the two stack exactly as the old '+='
      // pair did on a frame the mixer had rewritten. The absolute writes below
      // then override a limb as before (the wave or toss on armR, the chop).
      const tossing = !(waveEnv > 0 && this.armRBone) && tossEnv > 0;
      const air = aw > 0.001 ? aw : 0;
      // The gait layer's stride gain (B3, applyGait) joins the same sum.
      const g = this.gaitAdd;
      const addArmL = -0.85 * air + (tossing ? tossLean : 0) + g.armL;
      const addArmR = -0.85 * air + g.armR;
      // B4's 80 ms leg absorb at touchdown: a small forward flex, 0.12 rad at
      // its peak (a straight leg lifts its sole 0.61·(1 − cos 0.12) = 0.004 u).
      const absorb =
        this.legAbsorbT > 0
          ? -0.12 * Math.sin(Math.PI * (1 - this.legAbsorbT / SimplePlayer.LEG_ABSORB_S))
          : 0;
      const airLeg = this.airLegWeight > 0.001 ? this.airLegWeight : 0;
      const addLeg = -0.45 * airLeg + (tossing ? 0.5 * tossCrouch : 0) + absorb;
      if (addArmL !== 0) this.limbClip.onClip('armL', addArmL);
      if (addArmR !== 0) this.limbClip.onClip('armR', addArmR);
      if (addLeg + g.legL !== 0) this.limbClip.onClip('legL', addLeg + g.legL);
      if (addLeg + g.legR !== 0) this.limbClip.onClip('legR', addLeg + g.legR);
      if (waveEnv > 0 && this.armRBone) {
        // Bone convention, measured on the live rig: rotation.x = 0 points the
        // limb UP, +/-PI points it DOWN (that IS the arm's rest), and -1.6 is
        // forward-horizontal. The old target of -2.6 therefore sat 0.17rad off
        // hanging — the arm never rose, it just wagged backwards at the hip,
        // which is the "inverse wave". -0.55 raises it up and slightly forward.
        // Interpolate from an explicit PI base rather than from the live value:
        // near PI the Euler flips between +3.13 and -3.13 frame to frame, and
        // lerping from a value whose SIGN flips makes the arm pick a different
        // direction each frame.
        // -2.6 was authored as a delta FROM that rest (the air pose just above
        // correctly uses +=); written raw it is a +0.54 swing, so the arm went
        // down-and-back. Applied to the rest it lands up-and-forward.
        const REST_X = -Math.PI;
        this.armRBone.rotation.x = REST_X + -2.6 * waveEnv;
        this.armRBone.rotation.z = wag * waveEnv;
      } else if (tossEnv > 0) {
        if (this.armRBone) {
          // Blended against +PI — see SETTLE_REST (forward targets must not
          // settle through the overhead windmill).
          this.armRBone.rotation.x = THREE.MathUtils.lerp(
            SimplePlayer.SETTLE_REST,
            tossAng,
            tossEnv,
          );
        }
        // The counterweight lean and the knee bend went onto the clip above.
      } else if (castEnv > 0 && this.armRBone) {
        this.armRBone.rotation.x = THREE.MathUtils.lerp(SimplePlayer.SETTLE_REST, castAng, castEnv);
      } else if (this.rodHoldW > 0.01 && this.armRBone) {
        // Held rod: absolute-by-weight (mixer-proof) at forward-up-30°.
        // +1.15, not -1.15: the model faces +Z, so the positive side is the
        // visually-forward one (at -1.15 the rod jutted over the shoulder
        // into the chase camera with the tip 1.18u BEHIND the player).
        this.armRBone.rotation.x = THREE.MathUtils.lerp(
          SimplePlayer.SETTLE_REST,
          1.15,
          this.rodHoldW,
        );
      } else if (chopEnv > 0) {
        // Two-hand grip: both arms track the same swing. Blended against
        // +PI (SETTLE_REST), not the mixer's live -PI: the strike target is
        // on the POSITIVE (forward) side now, and lerping it against -PI
        // passes through 0 — a full windmill over the head as the envelope
        // fades (measured: +2.14 → +0.45 → -2.27). +PI is the SAME hanging
        // pose, so the settle stays short and reads as a follow-through.
        if (this.armRBone) {
          this.armRBone.rotation.x = THREE.MathUtils.lerp(
            SimplePlayer.SETTLE_REST,
            chopAng,
            chopEnv,
          );
        }
        if (this.armLBone) {
          this.armLBone.rotation.x = THREE.MathUtils.lerp(
            SimplePlayer.SETTLE_REST,
            chopAng,
            chopEnv,
          );
        }
      }
      // Body dip rides the CACHED seating base (modelBaseY): an additive
      // per-frame offset on gltfModel.position.y would accumulate.
      // writeBody turns it into the one gltfModel.position.y write.
      this.bodyDip = Math.max(tossCrouch, chopCrouch);
    } else if (this.armPivots.length === 2 && this.legPivots.length === 2) {
      if (aw > 0.001) {
        this.armPivots[0].rotation.x += -0.85 * aw;
        this.armPivots[1].rotation.x += -0.85 * aw;
        this.legPivots[0].rotation.x += -0.45 * aw;
        this.legPivots[1].rotation.x += -0.45 * aw;
      }
      if (waveEnv > 0) {
        const arm = this.armPivots[1]; // right shoulder pivot
        arm.rotation.x = THREE.MathUtils.lerp(arm.rotation.x, -2.6, waveEnv);
        // Blend back to the rest splay (-0.12) as the wave eases out.
        arm.rotation.z = wag * waveEnv + -0.12 * (1 - waveEnv);
      } else if (tossEnv > 0) {
        const arm = this.armPivots[1];
        arm.rotation.x = THREE.MathUtils.lerp(arm.rotation.x, tossAng, tossEnv);
        this.armPivots[0].rotation.x += tossLean;
        // Knees only on the fallback body — its mesh.position.y is rewritten
        // per frame by the walk bounce, so no cached dip is needed or safe.
        this.legPivots[0].rotation.x += 0.5 * tossCrouch;
        this.legPivots[1].rotation.x += 0.5 * tossCrouch;
      } else if (castEnv > 0) {
        const arm = this.armPivots[1];
        arm.rotation.x = THREE.MathUtils.lerp(arm.rotation.x, castAng, castEnv);
      } else if (this.rodHoldW > 0.01) {
        const arm = this.armPivots[1];
        arm.rotation.x = THREE.MathUtils.lerp(arm.rotation.x, 1.15, this.rodHoldW);
      } else if (chopEnv > 0) {
        this.armPivots[0].rotation.x = THREE.MathUtils.lerp(
          this.armPivots[0].rotation.x,
          chopAng,
          chopEnv,
        );
        this.armPivots[1].rotation.x = THREE.MathUtils.lerp(
          this.armPivots[1].rotation.x,
          chopAng,
          chopEnv,
        );
      }
    }
  }

  /**
   * Normalised walk-cycle phase (0..1 across one full gait cycle) so footstep
   * code can fire on the two mid-stride plants (~0.25 and ~0.75) instead of a
   * distance accumulator that drifts as speed varies. Tracks the walk clip's
   * (speed-scaled) time, or the procedural walk phase in the fallback body.
   */
  /**
   * Drive the idle/walk blend and the mixer from an EXTERNAL ground speed.
   *
   * Indoors, GameScene early-returns before `update()` runs, so the mixer was
   * never ticked and the avatar slid around the room in a frozen T-pose-ish
   * idle — the legs simply did not move. This mirrors the blend in `update()`
   * but takes speed as an argument, because `this.velocity` is zero in the
   * room: the interior loop writes position directly and never touches the
   * spherical physics. Deliberately does NOT run the air/wave pose, which
   * writes these same bones after the mixer and assumes a grounded/airborne
   * state that does not exist indoors.
   */
  public tickInteriorAnimation(deltaTime: number, speed: number): void {
    const dt = Math.min(Math.max(deltaTime, 0), 0.1);
    if (this.walkAction && this.idleAction) {
      const target = speed > 0.4 ? 1 : 0;
      const w = THREE.MathUtils.lerp(
        this.walkAction.getEffectiveWeight(),
        target,
        Math.min(1, 10 * dt),
      );
      this.walkAction.setEffectiveWeight(w);
      this.idleAction.setEffectiveWeight(1 - w);
      // B3's cadence; the 0.4 u/s blend gate above stays.
      this.walkAction.timeScale = gaitCadence(speed) * this.walkAction.getClip().duration;
    }
    if (this.animationMixer) {
      // Same clip layer as update(): applyPartyDance writes the arms after this.
      this.ensureLimbBones();
      this.limbClip.restore();
      this.animationMixer.update(dt);
      this.limbClip.capture();
    }
    // Indoors the body stands on its seated base: no bob, roll or lean
    // carried in from the last frame outside.
    this.gaitDt = dt;
    this.clearGait();
    this.gaitLean = 0;
    this.leanRoll = 0;
    this.bodyDip = 0;
    this.writeBody();
  }

  /**
   * The gait layer (B3), after the clip is captured and before the air pose.
   * - Stride: each leg's clip swing about rest scaled by gaitLegGain (arms by
   *   1 + 0.6(g − 1)), as an additive angle onClip; quaternion reads only, so
   *   the ±π rest never flips (world law 2).
   * - Bob: lowest at phases 0 and 0.5, where the legs are at full spread and
   *   the hip sits lowest (0.035 u walking, 0.06 u running).
   * - Stance roll 0.05 rad toward the leg that carries the body: legR across
   *   phases 0-0.5 (the Walk clip has legL trailing at phase 0), legL after.
   * - Forward lean, eased at 8/s: 0.07 rad walking, 0.17 rad running.
   * Reduced motion keeps the stride, halves the bob and roll, drops the lean.
   * Everything scales with the walk weight, so a standing avatar is untouched.
   */
  private applyGait(): void {
    const dt = this.gaitDt;
    const v = this.gaitSpeed;
    const w = this.walkAction && this.isGrounded ? this.walkAction.getEffectiveWeight() : 0;
    const g = gaitLegGain(v);
    this.gaitG = g;
    this.gaitF = gaitCadence(v);
    const ga = 1 + 0.6 * (g - 1);
    const clip = this.limbClip;
    this.gaitAdd.legL = (g - 1) * clip.clipAngleX('legL') * w;
    this.gaitAdd.legR = (g - 1) * clip.clipAngleX('legR') * w;
    this.gaitAdd.armL = (ga - 1) * clip.clipAngleX('armL') * w;
    this.gaitAdd.armR = (ga - 1) * clip.clipAngleX('armR') * w;
    const reduced = a11y.reducedMotion;
    const run = THREE.MathUtils.smoothstep(v, 5.8, 8.0);
    const phase = this.getWalkCyclePhase();
    const calm = reduced ? 0.5 : 1;
    const bobAmp = THREE.MathUtils.lerp(0.035, 0.06, run) * w * calm;
    this.gaitBob = bobAmp * 0.5 * (1 + Math.cos(4 * Math.PI * phase));
    this.gaitRoll = -0.05 * Math.sin(2 * Math.PI * phase) * w * calm;
    const leanTarget = reduced ? 0 : THREE.MathUtils.lerp(0.07, 0.17, run) * w;
    this.gaitLean += (leanTarget - this.gaitLean) * Math.min(1, 8 * dt);
  }

  /** The gait layer at rest: no swing, bob or roll; the lean eases out. */
  private clearGait(): void {
    this.gaitAdd.legL = this.gaitAdd.legR = this.gaitAdd.armL = this.gaitAdd.armR = 0;
    this.gaitBob = 0;
    this.gaitRoll = 0;
    this.gaitLean += (0 - this.gaitLean) * Math.min(1, 8 * this.gaitDt);
  }

  /**
   * The rigged body's one writer for each channel it owns on land:
   * gltfModel.position.y (the seated base, the toss/chop dip and the gait bob),
   * rotation.z (turn lean plus stance roll) and rotation.x (forward lean).
   * Swim, ride and seat return before it and own these while they run.
   */
  private writeBody(): void {
    const m = this.gltfModel;
    if (!m) return;
    if (this.modelBaseY !== null) {
      // The landing pivot: scaling y by landSy about the model origin moves
      // the soles by (1 − sy)·S, S the sole's offset from that origin. The
      // sole sits at −0.7 (the seating), so S = −0.7 − modelBaseY.
      const sole = -0.7 - this.modelBaseY;
      m.position.y =
        this.modelBaseY - 0.09 * this.bodyDip - this.gaitBob + (1 - this.landSy) * sole;
    }
    // Out of the water, the swim pitch and roll ease out with swimW (B5).
    m.rotation.z = this.leanRoll + this.gaitRoll + this.swimExitRoll * this.swimW;
    m.rotation.x = this.gaitLean + this.swimExitPitch * this.swimW;
  }

  /**
   * The landing spring (B4), on the rigged model's vertical scale `landSy`:
   * - rising (radial velocity > 0): stretch up to 1.15, eased by the spring;
   * - touchdown: sy snaps to 0.82 (reduced motion 0.93) and springs home
   *   at ω 18, ζ 0.45, so the deepest squash is the touchdown frame;
   * - an 80 ms leg absorb rides the same touchdown (legAbsorb, onClip).
   * writeBody adds the pivot that keeps the soles on the ground.
   */
  private applyLandSquash(): void {
    const dt = this.squashDt;
    const reduced = a11y.reducedMotion;
    let target = 1;
    if (!this.isGrounded) {
      const n = this.getSurfaceNormalInto(this._normalScratch);
      const vRad = this.velocity.dot(n);
      if (vRad > 0) target = Math.min(1.15, 1 + vRad * 0.02);
      this.wasAirborne = true;
    } else if (this.wasAirborne) {
      this.wasAirborne = false;
      this.landSy = reduced ? 1 - 0.18 * 0.4 : 0.82;
      this.landVy = 0;
      this.legAbsorbT = SimplePlayer.LEG_ABSORB_S;
    }
    // Semi-implicit spring toward the target.
    const w = 18;
    const z = 0.45;
    this.landVy += ((target - this.landSy) * w * w - 2 * z * w * this.landVy) * dt;
    this.landSy += this.landVy * dt;
    this.legAbsorbT = Math.max(0, this.legAbsorbT - dt);
  }

  /** The gait layer's state this frame (probes read it; B3). */
  public getGaitState(): { g: number; f: number; bob: number; roll: number; lean: number } {
    return {
      g: this.gaitG,
      f: this.gaitF,
      bob: this.gaitBob,
      roll: this.gaitRoll,
      lean: this.gaitLean,
    };
  }

  public getWalkCyclePhase(): number {
    if (this.walkAction) {
      const dur = this.walkAction.getClip().duration || 1;
      return (((this.walkAction.time % dur) + dur) % dur) / dur;
    }
    const twoPi = Math.PI * 2;
    return (((this.walkPhase % twoPi) + twoPi) % twoPi) / twoPi;
  }

  /**
   * Recolour a rigged body by material name (peers apply the owner's chosen
   * colours here). Shares the local player's material-name mapping. Static so
   * Multiplayer can call it on a remote avatar whose materials were cloned
   * per-peer.
   */
  public static applyBodyColors(
    root: THREE.Object3D,
    cols: Partial<Record<BodyPart, number>>,
  ): void {
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh && !(mesh as THREE.SkinnedMesh).isSkinnedMesh) return;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const m of mats) {
        const sm = m as THREE.MeshStandardMaterial;
        if (!sm || !sm.name || !sm.color) continue;
        for (const key of Object.keys(cols) as BodyPart[]) {
          const hex = cols[key];
          if (typeof hex === 'number' && sm.name === PART_MATERIAL[key]) sm.color.setHex(hex);
        }
      }
    });
  }

  /** Speed along the surface (gravity axis removed) — drives footstep cadence. */
  public getTangentialSpeed(): number {
    const n = this.getSurfaceNormal();
    return this.velocity
      .clone()
      .sub(n.clone().multiplyScalar(this.velocity.dot(n)))
      .length();
  }

  public getSurfaceNormal(): THREE.Vector3 {
    return this.getSurfaceNormalInto(new THREE.Vector3());
  }

  /** Allocation-free surface normal into a caller-owned vector (hot paths). */
  public getSurfaceNormalInto(out: THREE.Vector3): THREE.Vector3 {
    if (this.planetRadius <= 0) return out.set(0, 1, 0);
    out.copy(this.playerPosition).sub(this.planetCenter);
    const len = out.length();
    if (len < 0.001) return out.set(0, 1, 0);
    return out.divideScalar(len);
  }

  /**
   * Attempt to load GLTF character model (async, non-blocking)
   */
  private async loadGLTFCharacter(): Promise<void> {
    try {
      console.log('🎭 Loading GLTF character model...');

      // Intended toon player (Blender-authored, rigged with Idle+Walk clips).
      // The old Superhero kit fallbacks (12.6k tris + ~15MB of 4K textures)
      // are gone; if this fails the primitive capsule mesh remains.
      const gltfResult = await loadGLTFWithFallbacks('/assets/models/player.glb', {
        // v2 model is natively 1.8u; scaled to ~1.58u so the world reads
        // bigger around the player (feet re-calibrate below, so the scaled
        // model still lands exactly on the physics floor).
        scale: 0.88,
      });

      if (gltfResult) {
        // Remove the simple mesh
        this.remove(this.mesh);

        // Add the GLTF model
        this.gltfModel = gltfResult.scene;
        this.add(this.gltfModel);
        // The dress in the island's look (B15): player.glb's standard
        // materials become toon on the shared ramp, before the rim and the
        // close-camera fade pick them up by name. Names, colours and shader
        // hooks carry over, so setBodyColor still finds every part.
        if (isCelTheme()) Materials.toonifyTree(this.gltfModel);

        // Self-calibrate: place the model's feet at local -playerHeight (0.7)
        // regardless of where the exporter put the mesh origin.
        //
        // CRITICAL: Box3.setFromObject() always measures in WORLD space (it
        // walks matrixWorld). By the time this GLTF resolves, the player has
        // already been positioned on the sphere (world Y ~18.7 at spawn), so
        // the "local" offset below was actually a world-space number — it
        // shoved the mesh ~18.7 units through the planet and made the player
        // invisible. Zero the player's own world transform before measuring
        // so the box reflects gltfModel's position relative to its parent,
        // then restore.
        try {
          const savedPos = this.position.clone();
          const savedQuat = this.quaternion.clone();
          this.position.set(0, 0, 0);
          this.quaternion.identity();
          this.updateMatrixWorld(true);

          const box = new THREE.Box3().setFromObject(this.gltfModel);

          this.position.copy(savedPos);
          this.quaternion.copy(savedQuat);
          this.updateMatrixWorld(true);

          if (Number.isFinite(box.min.y)) {
            this.gltfModel.position.y += -0.7 - box.min.y;
          }
        } catch {
          /* keep default placement */
        }
        // The seated base every body offset is written from (writeBody).
        this.modelBaseY = this.gltfModel.position.y;

        // Skinned meshes are culled against their rest-pose bounds; on a small
        // planet the camera regularly proves those bounds wrong — disable.
        this.gltfModel.traverse((obj) => {
          if ((obj as THREE.SkinnedMesh).isSkinnedMesh) obj.frustumCulled = false;
        });

        // Setup animations: keep idle+walk actions for speed-based blending
        if (gltfResult.animations.length > 0) {
          this.animationMixer = new THREE.AnimationMixer(gltfResult.scene);
          const idleClip = gltfResult.animations.find((c) => /idle/i.test(c.name));
          const walkClip = gltfResult.animations.find((c) => /walk|run/i.test(c.name));
          if (idleClip) {
            this.idleAction = this.animationMixer.clipAction(idleClip);
            this.idleAction.play();
          }
          if (walkClip) {
            this.walkAction = this.animationMixer.clipAction(walkClip);
            this.walkAction.setEffectiveWeight(0);
            this.walkAction.play();
          }
          if (!this.idleAction && !this.walkAction) {
            this.animationMixer = setupModelAnimation(
              gltfResult.scene,
              gltfResult.animations,
              'idle',
            );
          }
        }
        // Seed the clip layer from the fresh model's bind pose, before any pose
        // can touch the limbs (LimbClip).
        this.ensureLimbBones();
        this.limbClip.capture();

        // Enable shadows + the cel rim on the garment/skin materials.
        // Rim SKIPS Eye/EyeShine/Blush (face accents would sparkle) and the
        // authored PlayerOutline hull (rimming ink breaks the silhouette).
        if (this.gltfModel) {
          const RIM_MATS = new Set(['Jacket', 'Pants', 'Skin', 'Shoe', 'Hair']);
          this.gltfModel.traverse((obj) => {
            if (obj instanceof THREE.Mesh) {
              obj.castShadow = true;
              // NO receiveShadow on the avatar. The single directional shadow
              // map covers the whole planet, so its texels are large against a
              // ~1.7u character — the mesh self-shadows into coarse acne, and
              // because the body DEFORMS every frame (walk cycle) and the
              // shadow map re-renders, that acne DANCES. MEASURED: 19.3% of the
              // player's screen pixels oscillated with receiveShadow on, 5.2%
              // with it off (the rest is honest limb motion) — the "user
              // flickering". The avatar still CASTS its grounding shadow;
              // stylized characters simply don't receive self-shadow, and the
              // minor loss (not darkening under a tree) reads fine on the cel
              // planet. normalBias would be the alternative but it is a GLOBAL
              // knob (0.035 today) and raising it enough to kill this risks
              // detaching world shadows everywhere.
              obj.receiveShadow = false;
              for (const m of Array.isArray(obj.material) ? obj.material : [obj.material]) {
                if (m && RIM_MATS.has(m.name) && !m.userData.celRim) {
                  m.userData.celRim = true;
                  applyCelRim(m);
                }
              }
            }
          });
        }

        // Hair is authored in the GLB (fringe + helmet, both on the 'Hair'
        // material) — no runtime cap. The old procedural hair_cap sphere
        // could not hug the rounded head; its rim always poked out somewhere
        // and read as a beard or a floating band.

        // The close-camera fade's list (B11): the fresh model's own materials,
        // before a hat or anything hand-held is attached.
        if (this.gltfModel) this.collectCloseFadeParts(this.gltfModel);

        // Apply a hat equipped before the model finished loading
        if (this.pendingHatId) {
          const hatId = this.pendingHatId;
          this.pendingHatId = null;
          this.equipHat(hatId);
        }
        // Re-apply any body colours chosen before the model swapped in
        this.reapplyAppearance();

        console.log(`✅ Loaded GLTF character from: ${gltfResult.loadedUrl}`);
      }
    } catch (error) {
      console.warn('⚠️ Failed to load GLTF character, keeping simple mesh:', error);
      // Keep the simple mesh if GLTF loading fails
    }
  }

  /**
   * Update player physics and position
   */
  public update(deltaTime: number): void {
    if (deltaTime <= 0) return;
    // Stamina ticks in every mobile state (drains only while the run is
    // actually engaged; regenerates seated/riding/idle for free).
    this.updateStamina(Math.min(deltaTime, 0.1));

    // Seated on a bench: physics + animation mixer paused, sit pose held
    if (this.seated) {
      this.applySitPose();
      this.updateWorldMatrix();
      return;
    }

    // Riding a boat/jetski: GameScene owns the transform (position + yaw set
    // in updateVehicles, right after this). Hold a dedicated riding pose —
    // NOT the walk/idle mixer or the swim pose — and skip all physics.
    if (this.rideActive) {
      this.applyRidePose(Math.min(deltaTime, 0.05));
      return;
    }

    // Substep instead of truncating: the old hard clamp to 20ms silently
    // DROPPED wall time below 50fps — the player ran in slow motion (8.0 →
    // 4.8u/s at 30fps) while NPCs and vehicles, which integrate the raw dt,
    // kept true speed. Recursing on the remainder in ≤20ms slices preserves
    // every millisecond (max 3 slices at the renderer's 50ms cap), and the
    // animation/pose code inside each slice sums to the same total time.
    if (deltaTime > 0.021) {
      this.update(0.02);
      this.update(deltaTime - 0.02);
      return;
    }
    const safeDeltaTime = Math.max(0, Math.min(deltaTime, 0.02));

    // Ease heading onto targetYaw (shortest arc, ~12 rad/s exponential) so
    // direction reversals sweep around instead of teleport-flipping 180°.
    // Scalar yaw only — the up-vector alignment in updateWorldMatrix is
    // untouched, so this smooths purely in the tangent frame.
    // B3: the step is capped at TURN_CAP rad/s, and a fresh turn over 120°
    // opens with a 120 ms pivot (headingStep). The old uncapped 12/s ease
    // spun the first frame of a reversal at about 2160°/s.
    {
      const dYaw = this.targetYaw - this.yaw;
      const arc = Math.atan2(Math.sin(dYaw), Math.cos(dYaw)); // wrap to ±π
      const absArc = Math.abs(arc);
      if (absArc > TURN_PIVOT_ARC && this.lastTurnArc <= TURN_PIVOT_ARC) {
        this.turnPivot = TURN_PIVOT_S;
      }
      const step = headingStep(arc, safeDeltaTime, this.turnPivot);
      this.turnPivot = Math.max(0, this.turnPivot - safeDeltaTime);
      this.lastTurnArc = Math.abs(arc - step);
      this.yaw += step;
      this.yawVel = step / safeDeltaTime;
    }

    // Apply gravity (spherical toward planet center, or flat -Y).
    // Descent is weighted 1.6× — a symmetric parabola reads as moon gravity
    // on the way down; the apex (jumpForce²/2g = 1.28u) is unchanged, only
    // the fall shortens (0.32s → 0.25s) for a snappier landing.
    if (this.planetRadius > 0) {
      const gravDir = this._radialScratch
        .copy(this.planetCenter)
        .sub(this.playerPosition)
        .normalize();
      const falling = !this.isGrounded && !this.inWater && this.velocity.dot(gravDir) > 0;
      this.velocity.addScaledVector(
        gravDir,
        this.gravityStrength * (falling ? 1.6 : 1) * safeDeltaTime,
      );
    } else {
      this.acceleration.set(0, -this.gravityStrength, 0);
      this.velocity.addScaledVector(this.acceleration, safeDeltaTime);
    }

    // Clamp velocity to prevent infinite speeds
    const maxVelocity = 50;
    if (this.velocity.length() > maxVelocity) {
      this.velocity.normalize().multiplyScalar(maxVelocity);
    }

    // Apply movement input, or settle to rest: a short eased deceleration
    // (~0.5u of drift) instead of the old zero-inertia stop — releasing the
    // stick reads as settling, not freezing. Hard stops (bench seat,
    // teleports, degenerate input) still call stopMovement() directly.
    if (this.moveInput && this.moveInput.length() > 0.01) {
      this.applyMovement(safeDeltaTime);
    } else {
      this.settleMovement(safeDeltaTime);
    }

    // Integrate position
    this.playerPosition.addScaledVector(this.velocity, safeDeltaTime);

    // Clamp player position to reasonable bounds
    const maxBounds = 500;
    this.playerPosition.x = Math.max(-maxBounds, Math.min(maxBounds, this.playerPosition.x));
    this.playerPosition.z = Math.max(-maxBounds, Math.min(maxBounds, this.playerPosition.z));

    // Ground detection and sticking
    this.updateGroundState();

    // Water: float when swimming, sink + drown otherwise (overrides the
    // seafloor grounding above so you don't just walk along the bottom)
    this.updateWaterState(safeDeltaTime);

    // Handle jump — impulse along the surface normal, not world +Y.
    // (World-Y only points "up" at the sphere's north pole; anywhere else
    // it is partly tangential and grounding instantly re-sticks the player.)
    if (this.wantJump && this.isGrounded && !this.inWater) {
      const jumpNormal = this.getSurfaceNormal();
      this.velocity.addScaledVector(jumpNormal, this.jumpForce);
      this.isGrounded = false;
      this.wantJump = false;
    } else if (this.inWater) {
      this.wantJump = false; // no jumping out of the sea
    }

    // ── In water: swim pose overrides the walk/idle animation ───────────
    if (this.inWater) {
      const surfN = this.getSurfaceNormalInto(this._normalScratch);
      const tang = this._vecScratch
        .copy(this.velocity)
        .addScaledVector(surfN, -this.velocity.dot(surfN))
        .length();
      // B5: the mixer keeps running in water (walk and idle hold the weights
      // they had at entry), so the swim pose slerps from a live clip.
      if (this.animationMixer) {
        this.ensureLimbBones();
        this.limbClip.restore();
        this.animationMixer.update(safeDeltaTime);
        this.limbClip.capture();
      }
      this.applySwimPose(safeDeltaTime, this.swimming, tang);
      this.swimPoseActive = true;
      this.updateWorldMatrix();
      return;
    }
    if (this.swimPoseActive) {
      // Just climbed out: the limbs and the body ease out of the swim pose
      // with swimW (blendSwimExit, writeBody); nothing is written raw here.
      this.clearSwimPose();
      this.swimPoseActive = false;
      this.leanRoll = 0;
      this.airPoseWeight = 0;
      this.airLegWeight = 0;
      this.gaitLean = 0;
    }

    // Procedural walk cycle for the built-in model: swing limbs from their
    // hip/shoulder pivots and bounce the body, scaled by tangential speed.
    if (!this.gltfModel && this.legPivots.length === 2 && this.armPivots.length === 2) {
      const surfNormal = this.getSurfaceNormalInto(this._normalScratch);
      const tangential = this._vecScratch
        .copy(this.velocity)
        .addScaledVector(surfNormal, -this.velocity.dot(surfNormal))
        .length();
      if (tangential > 0.5 && this.isGrounded) {
        this.walkPhase += safeDeltaTime * (4 + tangential * 1.6);
        const swing = Math.sin(this.walkPhase) * 0.55;
        this.legPivots[0].rotation.x = swing;
        this.legPivots[1].rotation.x = -swing;
        this.armPivots[0].rotation.x = -swing * 0.7;
        this.armPivots[1].rotation.x = swing * 0.7;
        // Bouncy step + slight forward lean while moving
        this.mesh.position.y = Math.abs(Math.sin(this.walkPhase)) * 0.06;
        this.mesh.rotation.x = 0.06;
      } else {
        // Ease limbs back to rest, then breathe gently
        const k = Math.min(1, 8 * safeDeltaTime);
        for (const p of [...this.legPivots, ...this.armPivots]) {
          p.rotation.x *= 1 - k;
        }
        this.mesh.rotation.x *= 1 - k;
        this.mesh.position.y = Math.sin(performance.now() / 500) * 0.015;
      }
    }

    // Squash-and-stretch. The rigged model (B4) runs a landing spring scaled
    // about the FEET (landSquash, writeBody's pivot term); the procedural
    // fallback keeps its old eased pulse about its origin.
    if (this.gltfModel) {
      this.squashDt = safeDeltaTime;
      if (fx.on('squash')) fx.time('squash', this.boundSquash);
      else this.landSy = 1;
      const base = this.modelBaseScale ?? (this.modelBaseScale = this.gltfModel.scale.clone());
      const inv = 1 / Math.sqrt(this.landSy);
      this.gltfModel.scale.set(base.x * inv, base.y * this.landSy, base.z * inv);
    } else {
      const activeModel: THREE.Object3D = this.mesh;
      const ud = activeModel.userData as { baseScale?: THREE.Vector3 };
      if (!ud.baseScale) ud.baseScale = activeModel.scale.clone();
      const base = ud.baseScale;
      let sx = 1;
      let sy = 1;
      let kSpring = Math.min(1, 10 * safeDeltaTime);
      if (!this.isGrounded) {
        const ssNormal = this.getSurfaceNormalInto(this._normalScratch);
        const vAlong = Math.abs(this.velocity.dot(ssNormal));
        sy = Math.min(1.15, 1 + vAlong * 0.02);
        sx = 2 - sy;
        this.wasAirborne = true;
      } else {
        if (this.wasAirborne) {
          this.wasAirborne = false;
          this.squashTime = 0.12;
        }
        if (this.squashTime > 0) {
          this.squashTime -= safeDeltaTime;
          sy = 0.85;
          sx = 1.12;
          kSpring = Math.min(1, 20 * safeDeltaTime);
        }
      }
      activeModel.scale.x += (base.x * sx - activeModel.scale.x) * kSpring;
      activeModel.scale.y += (base.y * sy - activeModel.scale.y) * kSpring;
      activeModel.scale.z += (base.z * sx - activeModel.scale.z) * kSpring;
    }

    // Roll into turns while on foot on the ground: proportional to turn
    // rate, clamped subtle, eased. Negative z leans toward the model's +X
    // (its right), matching a positive-yaw (rightward) turn. Swim/ride
    // return above and own the model rotation; leanRoll is re-zeroed on
    // those state exits so the lean always eases back in from neutral.
    // B3: −yawVel × 0.06, clamped 0.10. The rigged model's rotation.z is
    // written once, in writeBody, with the stance roll added.
    {
      const leanTarget = this.isGrounded ? Math.max(-0.1, Math.min(0.1, -this.yawVel * 0.06)) : 0;
      this.leanRoll += (leanTarget - this.leanRoll) * Math.min(1, 10 * safeDeltaTime);
      if (!this.gltfModel) this.mesh.rotation.z = this.leanRoll;
    }

    // Blend idle/walk by tangential speed. Weights are set directly every
    // frame (no fadeIn/fadeOut scheduling — interleaved fades can strand both
    // actions at weight 0 when the speed oscillates around the threshold).
    if (this.idleAction && this.walkAction) {
      const normal = this.getSurfaceNormalInto(this._normalScratch);
      const spd = this._vecScratch
        .copy(this.velocity)
        .addScaledVector(normal, -this.velocity.dot(normal))
        .length();
      const target = spd > 0.8 ? 1 : 0;
      const k = Math.min(1, 10 * safeDeltaTime);
      const w = THREE.MathUtils.lerp(this.walkAction.getEffectiveWeight(), target, k);
      this.walkAction.setEffectiveWeight(w);
      this.idleAction.setEffectiveWeight(1 - w);
      // Cadence follows ground speed (B3): gaitCadence cycles/s, times the
      // clip's length, because timeScale is unitless.
      this.walkAction.timeScale = gaitCadence(spd) * this.walkAction.getClip().duration;
      this.gaitSpeed = spd;
    }

    // Update GLTF animations, bracketed by the clip layer (LimbClip): restore,
    // so a limb the mixer skips this frame carries the clip and not the last
    // frame's pose (or a swim/ride/sit pose left on it), then capture.
    if (this.animationMixer) {
      this.ensureLimbBones();
      this.limbClip.restore();
      this.animationMixer.update(safeDeltaTime);
      this.limbClip.capture();
    }

    // The gait layer (B3): stride gain, bob, stance roll and lean, read off the
    // clip just captured. Off (fx), every term is 0.
    this.gaitDt = safeDeltaTime;
    if (this.gltfModel && fx.on('gait')) fx.time('gait', this.boundGait);
    else this.clearGait();

    // Jump/air pose + arm-wave: applied AFTER the mixer, composed onto the
    // captured clip. Reached only on foot — swim/ride/seat return earlier — so
    // isGrounded gates the air pose.
    this.applyAirWavePose(safeDeltaTime);
    this.blendSwimExit(safeDeltaTime);
    this.writeBody();

    // Update mesh position
    this.updateWorldMatrix();
  }

  /**
   * Check ground state and apply ground sticking
   */
  private updateGroundState(): void {
    const playerHeight = 0.7;

    if (this.planetRadius > 0) {
      // Spherical ground: keep player on the terrain surface. When a ground
      // sampler is attached, follow the actual displaced terrain (hills and
      // valleys); otherwise fall back to the ideal sphere radius.
      const surfaceNormal = this._radialScratch.copy(this.playerPosition).sub(this.planetCenter);
      const dist = surfaceNormal.length();
      surfaceNormal.divideScalar(dist);
      let terrainDist = this.planetRadius;
      if (this.groundSampler) {
        try {
          const sampled = this.groundSampler(surfaceNormal);
          if (Number.isFinite(sampled) && sampled > 0) terrainDist = sampled;
        } catch {
          // keep sphere fallback
        }
      }
      const groundDist = terrainDist + playerHeight;
      // The dive's floor clamp needs the seabed radius, and it is already in
      // hand here — updateGroundState runs immediately before updateWaterState
      // every frame, so this is same-frame fresh and costs no extra sampling.
      this.lastTerrainDist = terrainDist;

      // SNAP-DOWN while walking downhill: the check used to be binary
      // (dist <= groundDist), so every substep the terrain fell away faster
      // than gravity closed the gap went AIRBORNE — then fast-fell (1.6x),
      // caught the slope, landed, and repeated. MEASURED on a 1.31-gradient
      // slope: height scalloped +0.67u above ground with speed spiking
      // 6.4 -> 15.4 u/s, and every micro-landing fired the squash pulse,
      // half-raised the air-pose arms, muted footsteps and dropped jump
      // inputs. A grounded player moving downward within 0.35u of the ground
      // now STAYS grounded (0.35 covers a 20ms substep at run speed on
      // slopes to ~65 deg; real cliff edges exceed it within a frame or
      // two). The vRad <= 0.5 guard exempts the jump impulse (+8 radial), so
      // jumping still leaves the ground; water runs after and overrides.
      const gap = dist - groundDist;
      const vRad = this.velocity.dot(surfaceNormal);
      if (gap <= 0 || (this.isGrounded && vRad <= 0.5 && gap < 0.35)) {
        this.isGrounded = true;
        this.lastGroundedAtMs = performance.now();
        // Cancel velocity component going into the planet
        if (vRad < 0) {
          this.velocity.addScaledVector(surfaceNormal, -vRad);
        }
        // Snap exactly to surface
        this.playerPosition.copy(surfaceNormal.multiplyScalar(groundDist));
      } else {
        this.isGrounded = false;
      }
    } else {
      // Flat ground
      if (this.playerPosition.y <= this.groundLevel + playerHeight) {
        if (!this.isGrounded) {
          this.isGrounded = true;
          this.velocity.y = 0;
        }
        this.playerPosition.y = this.groundLevel + playerHeight;
      } else {
        this.isGrounded = false;
      }
    }
  }

  /**
   * Water physics. Runs after grounding: on open water it overrides the
   * seafloor stick so the player floats (swim button held) or sinks and
   * drowns (button released). On land it just tops the breath back up.
   */
  private updateWaterState(dt: number): void {
    this.inWater = false;
    this.swimming = false;
    this.beyondSwimLimit = false;
    this.diving = false;
    if (this.planetRadius <= 0 || !this.waterSampler) {
      this.oxygen = Math.min(1, this.oxygen + dt * SimplePlayer.RECOVER_RATE);
      return;
    }
    const dir = this._radialScratch.copy(this.playerPosition).sub(this.planetCenter);
    const dist = dir.length();
    dir.divideScalar(dist);
    let water: { surface: number; isWater: boolean };
    try {
      water = this.waterSampler(dir);
    } catch {
      return;
    }
    // Not over water (or already above the surface on land) → recover breath
    if (!water.isWater || dist > water.surface + 1.2) {
      this.oxygen = Math.min(1, this.oxygen + dt * SimplePlayer.RECOVER_RATE);
      this.wasInWater = false;
      return;
    }
    this.inWater = true;
    // Rising edge → let GameScene spawn an entry splash once
    if (!this.wasInWater) this.justEnteredWater = true;
    this.wasInWater = true;
    const floatDist = water.surface + SimplePlayer.SWIM_FLOAT;

    // DIVE FIRST. A dive must work with the swim button also held (the two
    // are independent inputs), so this branch has to outrank the float arm or
    // it would be swallowed by it.
    if (this.diveIntent) {
      this.swimming = true; // keeps the swim pose, the 0.79x swim speed, ripples
      this.isGrounded = false;
      const vRad = this.velocity.dot(dir);
      this.velocity.addScaledVector(dir, -vRad * 0.9); // gravity must not compound the descent
      this.applyShorelineCurrent(dir, dt);
      // Hover clear of the seabed, and never past the column.
      const deepest = Math.max(
        this.lastTerrainDist + SimplePlayer.DIVE_FLOOR_GAP,
        water.surface - SimplePlayer.DIVE_MAX_DEPTH,
      );
      const newDist = Math.max(deepest, dist - SimplePlayer.DIVE_SPEED * dt);
      // setLength, NOT copy(center).addScaledVector(dir, …): the latter
      // rebuilds the position from the PRE-push direction and so erases the
      // shoreline current applied two lines up — the leash would silently do
      // nothing for the whole descent, turning the dive into a barrier bypass.
      if (newDist < dist) this.playerPosition.setLength(newDist);
      // Derived from the REAL post-write radius, not from `newDist`: in
      // shallow water the clamp can leave newDist below the surface without
      // any write happening, and the breath would drain for a dive that never
      // occurred.
      this.diving = this.playerPosition.length() < water.surface - 0.15;
      this.oxygen = this.diving
        ? Math.max(0, this.oxygen - dt * SimplePlayer.DIVE_DRAIN)
        : Math.min(1, this.oxygen + dt * SimplePlayer.RECOVER_RATE);
      // Oxygen 0 under a held dive is still the ordinary drown — one failure
      // path, not a new one.
      if (this.oxygen <= 0 && this.onDrown) this.onDrown();
    } else if (this.swimIntent) {
      // Afloat: ease the body to the wave surface, kill the radial velocity
      // so gravity can't drag it under, and refill the breath.
      this.swimming = true;
      this.isGrounded = false;
      // Rate-limited ascent: after a dive the body is up to 4.7u down, and a
      // 9*dt lerp toward the float line reads as being yanked up by a winch.
      // Rise at a swimmer's pace, then snap the last stretch.
      const target = dir.clone().multiplyScalar(floatDist);
      if (floatDist - dist > SimplePlayer.ASCEND_SNAP) {
        this.playerPosition.setLength(Math.min(floatDist, dist + SimplePlayer.ASCEND_SPEED * dt));
      } else {
        this.playerPosition.lerp(target, Math.min(1, 9 * dt));
      }
      const vRad = this.velocity.dot(dir);
      this.velocity.addScaledVector(dir, -vRad * 0.9);
      // Refill ONLY at the surface. Without this gate, alternating dive and
      // float holds station 4u down while the breath REFILLS at 0.5/s against
      // a 0.055/s drain — infinite air, discoverable by mashing two keys.
      if (this.playerPosition.length() >= water.surface - 0.15) {
        this.oxygen = Math.min(1, this.oxygen + dt * SimplePlayer.RECOVER_RATE);
      } else {
        this.oxygen = Math.max(0, this.oxygen - dt * SimplePlayer.DIVE_DRAIN);
        if (this.oxygen <= 0 && this.onDrown) this.onDrown();
      }
      this.applyShorelineCurrent(dir, dt);
    } else {
      // Drowning: let gravity pull the player under and drain the breath.
      // (updateGroundState will still catch them on the seafloor.)
      this.oxygen = Math.max(0, this.oxygen - dt * SimplePlayer.DROWN_RATE);
      if (this.oxygen <= 0 && this.onDrown) {
        this.onDrown();
      }
    }
  }

  /**
   * Shoreline barrier — past the swim limit a current nudges you back toward
   * the island. It composes with your own strokes, so you can still swim
   * along the shore; you just can't make headway into the deep ocean.
   * Hoisted out of the float arm so a DIVE cannot be used to slip past it.
   */
  private applyShorelineCurrent(dir: THREE.Vector3, dt: number): void {
    const overshoot = SimplePlayer.SWIM_LIMIT_Y - dir.y;
    if (overshoot <= 0) {
      this.beyondSwimLimit = false;
      return;
    }
    this.beyondSwimLimit = true;
    this._swimTangent
      .copy(SimplePlayer._poleUp)
      .addScaledVector(dir, -SimplePlayer._poleUp.dot(dir));
    if (this._swimTangent.lengthSq() > 1e-6) {
      this._swimTangent.normalize();
      const strength = Math.min(1, overshoot / 0.1);
      this.playerPosition.addScaledVector(this._swimTangent, 4.0 * strength * dt);
    }
  }

  /**
   * Apply movement input (input already in world space from GameScene)
   */
  private applyMovement(_deltaTime: number): void {
    // If no input, stop immediately
    if (!this.moveInput || this.moveInput.length() === 0) {
      this.velocity.x = 0;
      this.velocity.z = 0;
      return;
    }

    // Safety check: ensure move input is finite
    if (!Number.isFinite(this.moveInput.x) || !Number.isFinite(this.moveInput.z)) {
      this.velocity.x = 0;
      this.velocity.z = 0;
      return;
    }

    // B3: the stick's deflection sets the speed, read before the direction is
    // normalised (a keyboard is always 1: unchanged). D15's joystick reports
    // 0..1; 0.15 holds about 2.0 u/s and 0.7 or more the full 5.6.
    const stick = stickSpeedScale(this.moveInput.length());

    // moveInput is already in world space (from GameScene.setPlayerMovement)
    const moveDir = this._moveScratch.copy(this.moveInput);

    // The normal is invariant for this whole substep (playerPosition doesn't
    // move here) — compute it ONCE; three sites used to each allocate one.
    const normal = this.planetRadius > 0 ? this.getSurfaceNormalInto(this._normalScratch) : null;

    // For spherical world, project move direction onto tangent plane
    if (normal) {
      moveDir.addScaledVector(normal, -moveDir.dot(normal));
    }

    const moveLength = moveDir.length();
    if (moveLength > 0.01) {
      moveDir.normalize();
    } else {
      this.stopMovement();
      return;
    }

    const accelRate = 8; // blend rate toward target — was 12; the softer ramp (~0.4s to full stride) is part of the calm-locomotion pass
    const t = Math.min(1, accelRate * Math.max(0.001, _deltaTime));

    if (normal) {
      // Spherical world: the tangent direction is a full 3D vector (it has a
      // Y component almost everywhere on the sphere). Decompose velocity into
      // normal + tangential parts, steer ONLY the tangential part toward the
      // move target, and preserve the normal part (gravity/jump).
      // (The old code lerped velocity.x/z only, which is not tangent to the
      // sphere away from the poles — walking used to launch the player off
      // the planet and bend paths into orbits.)
      const vNormal = this._vNormScratch.copy(normal).multiplyScalar(this.velocity.dot(normal));
      const vTangent = this._vecScratch.copy(this.velocity).sub(vNormal);
      // Swimming stays at ~4.4u/s (multiplier retuned 0.55→0.79 when walk
      // speed calmed 8.0→5.6): the shoreline current pushes back at up to
      // 4.0u/s, so a slower crawl would turn the swim limit into a hard
      // wall. Hierarchy holds: feet(4.4) < boat(11) < jetski(16).
      //
      // UPHILL COSTS: grade ahead read from the ground sampler (analytic,
      // ~0.003ms) scales the target down to 55% on the steepest climbs, so a
      // hill reads as effort instead of a free escalator (the ground snap is
      // unlimited, so speed was previously slope-independent). GATED to
      // grounded-and-dry: while swimming this would sample the SEABED and cut
      // swim speed below the 4.0 u/s shoreline current, and it must not
      // touch air control mid-jump. Downhill (grade < 0) is unchanged.
      let slopeCost = 1;
      if (this.isGrounded && !this.swimming && this.groundSampler && moveDir.lengthSq() > 1e-6) {
        try {
          const ahead = SimplePlayer._slopeAhead
            .copy(this.playerPosition)
            .addScaledVector(moveDir, 0.6)
            .normalize();
          const grade = (this.groundSampler(ahead) - this.groundSampler(normal)) / 0.6;
          slopeCost = THREE.MathUtils.clamp(1 / (1 + Math.max(0, grade) * 0.9), 0.55, 1);
        } catch {
          /* sampler unavailable — full speed */
        }
      }
      // moveDir is not read again — scale it in place as the steer target.
      const target = moveDir.multiplyScalar(
        this.effectiveSpeed() * (this.swimming ? 0.79 : 1) * slopeCost * stick,
      ); // moveDir already tangent-projected
      vTangent.lerp(target, t);
      this.velocity.copy(vTangent.add(vNormal));
    } else {
      // Flat ground: steer horizontal components, gravity owns Y
      const sp = this.effectiveSpeed() * stick;
      this.velocity.x = THREE.MathUtils.lerp(this.velocity.x, moveDir.x * sp, t);
      this.velocity.z = THREE.MathUtils.lerp(this.velocity.z, moveDir.z * sp, t);
    }
  }

  /**
   * Eased stop: decay the tangential velocity toward zero (exp rate 10/s —
   * Hz-independent, composes correctly across the 20ms substeps) and snap
   * the last 0.15 u/s so the walk-blend and footstep gates (0.8) aren't
   * grazed forever by an asymptotic tail.
   */
  private settleMovement(dt: number): void {
    if (this.planetRadius > 0) {
      const normal = this.getSurfaceNormalInto(this._normalScratch);
      const vN = normal.multiplyScalar(this.velocity.dot(normal)); // aliases the scratch — nothing reads the unit normal after
      this.velocity.sub(vN); // tangential part, in place
      const sp = this.velocity.length();
      this.velocity.multiplyScalar(sp < 0.15 ? 0 : Math.exp(-10 * dt));
      this.velocity.add(vN);
    } else {
      this.velocity.x = 0;
      this.velocity.z = 0;
    }
    this.moveInput.set(0, 0, 0);
  }

  /**
   * Stop movement immediately (zero the tangential velocity, keep the
   * normal/vertical part so gravity and jumps still resolve)
   */
  private stopMovement(): void {
    if (this.planetRadius > 0) {
      const normal = this.getSurfaceNormalInto(this._normalScratch);
      const vNormal = normal.multiplyScalar(this.velocity.dot(normal)); // aliases the scratch, consumed here
      this.velocity.copy(vNormal);
    } else {
      this.velocity.x = 0;
      this.velocity.z = 0;
    }
    this.moveInput.set(0, 0, 0);
  }

  /**
   * Set movement input (-1 to 1)
   */
  public setMovement(forward: number, strafe: number): void {
    // Sideways is SLOWER than forward — a person side-steps at roughly 60%
    // of walking pace. Driving strafe at full speed made crabbing sideways
    // as fast as running, which reads as skating rather than walking.
    this.moveInput.set(strafe * 0.6, 0, forward);
    this.moveInput.clampLength(0, 1);
  }

  /**
   * Set movement as a full world-space direction vector. On a sphere the
   * tangent direction has a Y component almost everywhere; passing only the
   * X/Z components (the old path) collapsed input to zero near latitudes
   * where the tangent points mostly up/down — the player couldn't cross
   * those bands. applyMovement projects this onto the tangent plane.
   */
  public setMovementVector(dir: THREE.Vector3): void {
    this.moveInput.copy(dir);
    this.moveInput.clampLength(0, 1);
  }

  /**
   * Request jump
   */
  /** Last wall-clock ms the ground check passed — the coyote window's clock. */
  private lastGroundedAtMs = 0;
  private static readonly _slopeAhead = new THREE.Vector3();
  private static readonly COYOTE_MS = 120;

  /**
   * Whether a jump pressed NOW would fire. Shared with the jump SFX gate so
   * sound and physics can never disagree. Coyote time (120ms) covers slope
   * crests and step edges where the binary ground check blinked airborne on
   * the exact frame of the keypress; the radial-velocity guard (< 2) keeps a
   * real jump (which sets +8 radial) from double-firing inside the window.
   */
  public canJump(): boolean {
    if (this.isGrounded) return true;
    if (this.planetRadius <= 0) return false;
    return (
      performance.now() - this.lastGroundedAtMs < SimplePlayer.COYOTE_MS &&
      this.velocity.dot(this.getSurfaceNormal()) < 2
    );
  }

  public jump(): void {
    if (this.canJump()) {
      if (this.planetRadius > 0) {
        const surfaceNormal = this.getSurfaceNormal();
        // A coyote jump starts mid-fall: cancel the accumulated downward
        // radial velocity FIRST, or the impulse fights up to ~-4.8 u/s of
        // fall (g x 120ms at the 1.6x fall rate) and the jump tops out at a
        // fraction of its height. Grounded jumps never see this because the
        // ground snap already zeroed the inward component.
        const vRad = this.velocity.dot(surfaceNormal);
        if (vRad < 0) this.velocity.addScaledVector(surfaceNormal, -vRad);
        this.velocity.addScaledVector(surfaceNormal, this.jumpForce);
        this.isGrounded = false;
        // Burn the window: one coyote jump per fall.
        this.lastGroundedAtMs = 0;
      } else {
        this.wantJump = true;
      }
    }
  }

  /**
   * Set player heading (yaw, radians about the surface normal). On foot the
   * yaw eases onto it (shortest arc) in update(); riding/seated snap because
   * GameScene owns the transform there and update() returns before easing.
   */
  public setRotation(yaw: number, _pitch?: number): void {
    this.targetYaw = yaw;
    if (this.rideActive || this.seated) this.yaw = yaw;
  }

  /**
   * Get player world position (allocates a fresh vector — kept for callers
   * that store the result; per-frame callers should use getWorldPositionInto).
   */
  public getWorldPosition(): THREE.Vector3 {
    return this.getWorldPositionInto(new THREE.Vector3());
  }

  /** Allocation-free world position into a caller-owned vector (hot paths). */
  public getWorldPositionInto(out: THREE.Vector3): THREE.Vector3 {
    return out.copy(this.positionHold ?? this.playerPosition);
  }

  // While set, getWorldPosition* report THIS instead of the live position —
  // used while the player walks around a building interior (the hidden room
  // sits 300u under the map) so multiplayer peers keep seeing them at the
  // door they entered, not floating beneath the planet.
  private positionHold: THREE.Vector3 | null = null;
  public setPositionHold(v: THREE.Vector3 | null): void {
    this.positionHold = v ? v.clone() : null;
  }

  /**
   * Get current velocity (world space)
   */
  public getVelocity(): THREE.Vector3 {
    return this.velocity.clone();
  }

  /** Allocation-free velocity into a caller-owned vector (hot paths). The
   *  live field is never handed out — callers mutate their copy freely. */
  public getVelocityInto(out: THREE.Vector3): THREE.Vector3 {
    return out.copy(this.velocity);
  }

  /**
   * Set player world position (for collision resolution)
   */
  public setWorldPosition(position: THREE.Vector3): void {
    this.playerPosition.copy(position);
  }

  /**
   * Get player forward direction
   */
  public getForwardDirection(): THREE.Vector3 {
    return new THREE.Vector3(0, 0, -1).applyAxisAngle(new THREE.Vector3(0, 1, 0), this.yaw);
  }

  /**
   * Get player yaw rotation
   */
  public getYaw(): number {
    return this.yaw;
  }

  /**
   * Check if player is grounded
   */
  public getIsGrounded(): boolean {
    return this.isGrounded;
  }

  /**
   * Update world matrix from position — orients player to stand upright on sphere surface
   */
  public updateWorldMatrix(): void {
    this.position.copy(this.playerPosition);

    if (this.planetRadius > 0) {
      // Align player "up" with surface normal, then yaw around that normal.
      // Scratch quats/vector — this runs every frame.
      const surfaceNormal = this.getSurfaceNormalInto(this._normalScratch);
      const alignQuat = this._alignQuat.setFromUnitVectors(SimplePlayer._poleUp, surfaceNormal);
      const yawQuat = this._yawQuat.setFromAxisAngle(surfaceNormal, this.yaw);
      this.quaternion.multiplyQuaternions(yawQuat, alignQuat);
    } else {
      this.rotation.order = 'YXZ';
      this.rotation.y = this.yaw;
      this.rotation.x = 0;
    }

    this.updateMatrix();
    this.updateMatrixWorld(true);
  }

  /**
   * Dispose resources
   */
  public dispose(): void {
    // Dispose animation mixer
    if (this.animationMixer) {
      try {
        this.animationMixer.stopAllAction();
      } catch {
        // Ignore cleanup issues
      }
      this.animationMixer = null;
    }

    this.traverse((obj: THREE.Object3D) => {
      if (obj instanceof THREE.Mesh) {
        if (obj.geometry) obj.geometry.dispose();
        if (obj.material) {
          if (Array.isArray(obj.material)) {
            obj.material.forEach((m: THREE.Material) => m.dispose());
          } else {
            obj.material.dispose();
          }
        }
      }
    });
  }
}
