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

const squashing = new WeakSet<THREE.Object3D>();

/**
 * Volume-preserving squash-and-stretch pop on an object's root scale.
 * amount > 0 stretches tall (jump take-off), < 0 squashes flat (landing).
 * Writes SCALE ONLY (never bone rotations — the documented rest-pose trap),
 * and restores the object's own base scale exactly. Re-entrant calls on the
 * same object are ignored until the current pop settles.
 *
 * NOTE for GLB avatars: scale the wrapper/root whose origin is at FOOT level
 * (SimplePlayer's group origin is mid-body but the gltfModel sits inside it;
 * scaling the player group keeps feet planted well enough at these
 * amplitudes — 60-120ms, ≤12%).
 */
export function squash(obj: THREE.Object3D, amount = 0.12, dur = 0.16): void {
  if (squashing.has(obj)) return;
  squashing.add(obj);
  const bx = obj.scale.x;
  const by = obj.scale.y;
  const bz = obj.scale.z;
  tween(
    dur,
    easeOutBack,
    (v) => {
      // v runs 0→1 with overshoot; envelope peaks early then settles.
      const env = Math.sin(Math.min(1, v) * Math.PI); // 0→1→0
      const s = 1 + amount * env;
      const inv = 1 / Math.sqrt(Math.max(0.25, s));
      obj.scale.set(bx * inv, by * s, bz * inv);
    },
    () => {
      obj.scale.set(bx, by, bz);
      squashing.delete(obj);
    },
  );
}
