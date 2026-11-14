/**
 * Juice — the game-feel kernel (Wave 3 of the uplift roadmap).
 *
 * Three feel primitives (researched: Swink/Holmér/Vlambeer canon, adversarially
 * verified for this stack). They are AVAILABLE to callers, not force-adopted —
 * several hand-rolled easings stay inline on purpose (see expDecay's note):
 *   1. expDecay — frame-rate-INDEPENDENT smoothing. Critical here because the
 *      adaptive-resolution governor makes dt genuinely variable: a naive
 *      `a = lerp(a, b, 0.1)` feels different on every quality rung.
 *      (Only for smoothing-style follows — never convert the day/night
 *      palette lerps, which are time-parameterized, not smoothing.)
 *   2. Spring — damped position+velocity spring for overshoot-and-settle
 *      motion (camera bias, prop settles).
 *   3. A pooled micro-tween scheduler for one-shot pops (squash-stretch,
 *      scale-ins) with the standard juice easings.
 *
 * The whole module is allocation-light: tweens are pooled, tick() is O(active).
 * Chill-filter policy lives with the CALLERS (shake caps, reduced-motion
 * gates) — this file is mechanism, not taste.
 */
import * as THREE from 'three';

import { a11y } from './Accessibility';

/** Frame-rate-independent exponential approach: returns the new value of `a`
 *  moving toward `b` with rate `k` (higher = snappier; ~5-15 typical).
 *  NOTE the exact form: `b + (a-b)*exp(-k*dt)`. Sites written as the lerp-FACTOR
 *  form `lerp(a, b, 1 - exp(-k*dt))` are algebraically the same but round
 *  differently — do NOT swap them onto this helper, or the feel shifts a hair. */
export function expDecay(a: number, b: number, k: number, dt: number): number {
  return b + (a - b) * Math.exp(-k * dt);
}

/** Vector3 variant of expDecay, in place. */
export function expDecayV3(a: THREE.Vector3, b: THREE.Vector3, k: number, dt: number): void {
  const t = 1 - Math.exp(-k * dt);
  a.lerp(b, t);
}

/** Critically-tunable damped spring (scalar). halfLife ~0.1-0.3s reads
 *  "alive"; damping < 1 overshoots (the settle wobble juice wants). */
export class Spring {
  public value: number;
  public velocity = 0;
  constructor(
    value = 0,
    public frequency = 6, // rad/s-ish stiffness
    public damping = 0.6, // <1 overshoots, 1 critical
  ) {
    this.value = value;
  }
  update(target: number, dt: number): number {
    // Semi-implicit integration — stable at our dt range.
    const f = this.frequency;
    this.velocity += (target - this.value) * f * f * dt - 2 * f * this.damping * this.velocity * dt;
    this.value += this.velocity * dt;
    return this.value;
  }
  snap(v: number): void {
    this.value = v;
    this.velocity = 0;
  }
}

// ── easings ─────────────────────────────────────────────────────────────────

export const easeOutQuad = (t: number): number => 1 - (1 - t) * (1 - t);
export const easeOutBack = (t: number): number => {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
};

// ── pooled micro-tweens ─────────────────────────────────────────────────────

type Ease = (t: number) => number;
interface Tween {
  active: boolean;
  t: number;
  dur: number;
  ease: Ease;
  apply: (v: number) => void;
  done?: () => void;
}

const pool: Tween[] = [];
const active: Tween[] = [];

/** Schedule a one-shot tween: apply(eased 0→1) each frame for `dur` seconds. */
export function tween(
  dur: number,
  ease: Ease,
  apply: (v: number) => void,
  done?: () => void,
): void {
  const tw =
    pool.pop() ?? ({ active: false, t: 0, dur: 0, ease: easeOutQuad, apply: () => {} } as Tween);
  tw.active = true;
  tw.t = 0;
  tw.dur = Math.max(0.016, dur);
  tw.ease = ease;
  tw.apply = apply;
  tw.done = done;
  active.push(tw);
}

/** Tick all tweens. Call ONCE per frame from the main update loop. */
export function tick(dt: number): void {
  for (let i = active.length - 1; i >= 0; i--) {
    const tw = active[i];
    tw.t += dt;
    const raw = Math.min(1, tw.t / tw.dur);
    tw.apply(tw.ease(raw));
    if (raw >= 1) {
      tw.active = false;
      const done = tw.done;
      tw.done = undefined;
      active.splice(i, 1);
      pool.push(tw);
      done?.();
    }
  }
}

// ── squash & stretch ────────────────────────────────────────────────────────

/** The squash spring (B4): s(t) = 1 + A·e^(−ζωt)·sin(ωt), ω = 2π / 0.24 s,
 *  ζ = 0.32, over 0.45 s. It peaks at t = atan(1/ζ)/ω ≈ 48 ms, undershoots at
 *  ≈ 168 ms and sits within 1% of rest by 450 ms. */
export const SQUASH_OMEGA = (2 * Math.PI) / 0.24;
export const SQUASH_ZETA = 0.32;
export const SQUASH_DUR = 0.45;

/** The spring's first peak for A = 1, so `amount` stays the visible peak
 *  (the callers' amounts were tuned as peaks under the old envelope). */
const springPeak = (zeta: number): number => {
  const t = Math.atan(1 / zeta) / SQUASH_OMEGA;
  return Math.exp(-zeta * SQUASH_OMEGA * t) * Math.sin(SQUASH_OMEGA * t);
};

/** s(t) for an impulse of visible peak `amount`. Reduced motion: 40% of the
 *  amount, critically damped (ζ = 1: the impulse response ωt·e^(−ωt), which
 *  swells once and settles without crossing back), peaking at 1/ω ≈ 38 ms. */
export function squashSpring(t: number, amount: number, reduced = false): number {
  if (reduced) {
    const x = SQUASH_OMEGA * t;
    return 1 + 0.4 * amount * Math.E * x * Math.exp(-x);
  }
  const a = amount / springPeak(SQUASH_ZETA);
  return 1 + a * Math.exp(-SQUASH_ZETA * SQUASH_OMEGA * t) * Math.sin(SQUASH_OMEGA * t);
}

interface SquashLive {
  /** The object's own scale, cached on the first trigger of an impulse. */
  base: THREE.Vector3;
  /** Bumped by every trigger: a superseded tween goes quiet. */
  gen: number;
  active: boolean;
  /** The pivot offset last added to position, and the position it left. */
  offset: THREE.Vector3;
  wrote: THREE.Vector3;
  /** The spring's current value and this impulse's pivot, for squashPivot. */
  s: number;
  pivotY: number;
  /** The owner writes position every frame and adds squashPivot itself. */
  mover: boolean;
}

const squashLive = new WeakMap<THREE.Object3D, SquashLive>();
const _sqUp = new THREE.Vector3();

/** Take this impulse's pivot offset back out, unless something else has
 *  rewritten the position since (a mover that writes it every frame). */
function unpivot(obj: THREE.Object3D, live: SquashLive): void {
  if (live.offset.lengthSq() > 0 && obj.position.distanceToSquared(live.wrote) < 1e-12) {
    obj.position.sub(live.offset);
  }
  live.offset.set(0, 0, 0);
}

/**
 * Volume-preserving squash-and-stretch on an object's root scale: a damped
 * spring impulse (B4). amount > 0 stretches tall first (jump take-off, a
 * greet), < 0 squashes flat first (landing). x and z scale by 1/√s.
 * Writes SCALE (and, with a pivot, POSITION) only — never bone rotations, the
 * documented rest-pose trap — and restores the object's own base scale.
 *
 * - A re-trigger restarts the impulse from the cached base scale (cached on
 *   the first trigger while none runs), so pops never compound.
 * - `opts.pivotY`: the object's foot height in its own local units (the
 *   player group's feet sit at −0.7). The object is scaled about that point
 *   instead of its origin, so the feet stay planted.
 * - `opts.mover`: the object's owner rewrites its position every frame
 *   AFTER Juice ticks (the player group, a cat), which would erase a pivot
 *   written here. Juice then leaves position alone, and the owner adds
 *   `squashPivot(obj, out)` right after its own position write.
 * - `dur` is accepted and ignored: the spring sets the length (0.45 s).
 */
export function squash(
  obj: THREE.Object3D,
  amount = 0.12,
  dur = SQUASH_DUR,
  opts?: { pivotY?: number; mover?: boolean },
): void {
  void dur;
  let live = squashLive.get(obj);
  if (!live) {
    live = {
      base: obj.scale.clone(),
      gen: 0,
      active: false,
      offset: new THREE.Vector3(),
      wrote: new THREE.Vector3(),
      s: 1,
      pivotY: 0,
      mover: false,
    };
    squashLive.set(obj, live);
  } else if (!live.active) {
    live.base.copy(obj.scale);
  }
  const L = live;
  const gen = ++L.gen;
  L.active = true;
  const pivotY = opts?.pivotY ?? 0;
  if (L.mover || opts?.mover) unpivot(obj, L);
  L.pivotY = pivotY;
  L.mover = opts?.mover === true;
  L.s = 1;
  const mover = L.mover;
  const reduced = a11y.reducedMotion;
  const b = L.base;
  tween(
    SQUASH_DUR,
    (t) => t,
    (v) => {
      if (L.gen !== gen) return;
      const s = Math.max(0.25, squashSpring(v * SQUASH_DUR, amount, reduced));
      const inv = 1 / Math.sqrt(s);
      obj.scale.set(b.x * inv, b.y * s, b.z * inv);
      L.s = s;
      if (pivotY !== 0 && !mover) {
        unpivot(obj, L);
        // The foot sits at position + up · scale.y · pivotY: hold it still.
        _sqUp.set(0, 1, 0).applyQuaternion(obj.quaternion);
        L.offset.copy(_sqUp).multiplyScalar(b.y * (1 - s) * pivotY);
        obj.position.add(L.offset);
        L.wrote.copy(obj.position);
      }
    },
    () => {
      if (L.gen !== gen) return;
      obj.scale.copy(b);
      unpivot(obj, L);
      L.s = 1;
      L.active = false;
    },
  );
}

/**
 * The foot-pivot offset of a running `mover` squash, written into `out` (no
 * allocation): position + this keeps the feet where they were. Null when no
 * pivoted mover squash runs on `obj`. Read it AFTER the owner's position and
 * quaternion writes for the frame.
 */
export function squashPivot(obj: THREE.Object3D, out: THREE.Vector3): THREE.Vector3 | null {
  const L = squashLive.get(obj);
  if (!L || !L.active || !L.mover || L.pivotY === 0 || L.s === 1) return null;
  return out
    .set(0, 1, 0)
    .applyQuaternion(obj.quaternion)
    .multiplyScalar(L.base.y * (1 - L.s) * L.pivotY);
}
