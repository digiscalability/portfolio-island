// functions/src/pure.ts — dependency-free logic shared by the Cloud Functions
// and unit-tested directly from the repo's vitest suite
// (test/functionsPure.test.ts). Keep this file free of firebase/network
// imports: purity is what makes the money logic (rate window, prune
// selection, deterministic picks) testable without an emulator.

/** mulberry32-style deterministic pick: varied per seed, reproducible within it. */
export function seededPick<T>(arr: readonly T[], seed: number): T {
  let t = (seed + 0x6d2b79f5) >>> 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const r = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return arr[Math.floor(r * arr.length)];
}

/** RTDB-safe key for a caller IP (dots/colons/etc. are illegal in RTDB paths). */
export function ipKey(raw: string | null | undefined): string {
  return (raw || 'noip').replace(/[.:$#[\]/]/g, '_').slice(0, 60);
}

/**
 * Real client IP behind Google's serverless front end: the LAST
 * X-Forwarded-For entry is APPENDED by Google and cannot be client-forged —
 * everything leftward is attacker-suppliable, and Express's req.ip (with the
 * framework's trust-proxy setting) returns the LEFTMOST. Rate-limit buckets
 * keyed on req.ip are therefore attacker-chosen; keyed on this, they're real.
 * Falls back to the socket-derived address when the header is absent.
 */
export function lastForwardedIp(xff: unknown, fallback: string | null | undefined): string {
  const raw = typeof xff === 'string' ? xff : Array.isArray(xff) ? xff.join(',') : '';
  const parts = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length ? parts[parts.length - 1] : fallback || 'noip';
}

/**
 * Fixed-window per-IP rate counter: the next `{c, t}` node to store. `t` is
 * the WINDOW START (kept while within the window), so a steady burst can't
 * slide the window forward and stay under the limit forever.
 */
export function nextIpWindow(
  prev: { c?: number; t?: number } | null,
  now: number,
  windowMs: number,
): { c: number; t: number } {
  const within = !!prev && now - (prev.t ?? 0) < windowMs;
  return { c: within ? (prev?.c ?? 0) + 1 : 1, t: within ? (prev?.t ?? now) : now };
}

/**
 * Children of a pruned node to delete: everything whose `t` (last-seen ms) is
 * older than `maxAgeMs`. A missing/malformed `t` counts as 0 — ancient — so
 * junk entries can't dodge the janitor forever by omitting the field.
 */
export function pruneSelect(
  val: Record<string, { t?: number }> | null,
  now: number,
  maxAgeMs: number,
): Record<string, null> {
  const updates: Record<string, null> = {};
  if (!val) return updates;
  for (const [key, entry] of Object.entries(val)) {
    const t = typeof entry?.t === 'number' ? entry.t : 0;
    if (now - t > maxAgeMs) updates[key] = null;
  }
  return updates;
}
