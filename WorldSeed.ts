// WorldSeed.ts — the seeded window's three tools.
//
// GameScene.initialize builds the world under one fixed Math.random stream
// (installSeededRandom … restoreRandom), so every client builds the same map:
// parked cars become vehicles that multiplayer addresses by index, and rocks
// push colliders. three spends draws on every uuid it mints, so a change that
// adds, removes or reorders one object inside the window re-rolls everything
// drawn after it. These helpers let a change keep the stream byte-identical:
//
// - burnDraws(n) stands in for removed code: it takes exactly the draws the
//   census MEASURED at that site (gameSceneSeed, drawNeutral, the seed probe),
//   never a number worked out from a formula.
// - withLocalRng(fn, seed) builds something new inside the window without
//   touching the stream: fn draws from its own mulberry32.
// - seedMark(label) lets Island publish checkpoints to a census recorder
//   (drawNeutral.test.ts installs one); in the browser nothing listens.

/** A census recorder: called with each checkpoint's label, in window order. */
export type SeedMarkRecorder = (label: string) => void;

declare global {
  // Installed only by a census (drawNeutral.test.ts), and only while the
  // seeded window is open. GameScene installs none, so window.__dsSeedDraws
  // keeps its own checkpoints. A var: only a var inside `declare global`
  // types a property of globalThis.
  var __dsSeedMark: SeedMarkRecorder | undefined;
}

/**
 * Call Math.random exactly `n` times. Inside the seeded window that advances
 * the shared stream by `n`, so the code after it draws what it drew before.
 * `n` is the census's measured value for the code this replaces; a fraction
 * or a negative count is a formula, and throws.
 */
export function burnDraws(n: number): void {
  if (!Number.isInteger(n) || n < 0) {
    throw new RangeError(`burnDraws(${n}): pass the census's measured draw count`);
  }
  // The draws must survive the production bundle. Rollup lists Math.random as
  // a pure function, so a bare `Math.random();` whose value goes unused is
  // tree-shaken away: MEASURED, the seed probe's returning visitor came out
  // 20 draws short of the golden. So every draw feeds `sum`, and `sum` feeds a
  // branch no bundler can prove dead (Math.random is never negative).
  let sum = 0;
  for (let i = 0; i < n; i++) sum += Math.random();
  if (sum < 0) throw new RangeError('Math.random() returned a negative number');
}

/**
 * Run `fn` with Math.random swapped for a local mulberry32 seeded with `seed`
 * (the same generator as GameScene.installSeededRandom), and put the caller's
 * Math.random back in a finally block, so `fn` takes zero draws from the
 * stream around it even when it throws. Same seed, same draws. Returns what
 * `fn` returns.
 */
export function withLocalRng<T>(fn: () => T, seed: number): T {
  const stashedRandom = Math.random;
  let s = seed >>> 0;
  Math.random = (): number => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  try {
    return fn();
  } finally {
    Math.random = stashedRandom;
  }
}

/** Publish a checkpoint to the census recorder when one is installed;
 *  otherwise do nothing. It never draws. */
export function seedMark(label: string): void {
  globalThis.__dsSeedMark?.(label);
}
