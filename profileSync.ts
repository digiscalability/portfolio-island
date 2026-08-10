/**
 * Cloud-backed player profile.
 *
 * name / hat / owned hats / coins are mirrored to Firebase RTDB under
 * `profiles/{uid}` (the anonymous-auth uid). localStorage stays the immediate,
 * offline cache; this adds durable cloud storage that survives a localStorage
 * clear and is the foundation for true cross-device sync once an account is
 * linked (anonymous auth is per-device on its own).
 */
/**
 * Adopt-once merge for CURRENCY (the Consumable Law applied to coins).
 *
 * Coins used to max-merge from the cloud ("coins only go up") — but coins are
 * SPENT: the profile sync resolves seconds after boot, behind an 800ms
 * debounced save, so "take the higher" refunded every purchase made in that
 * window (buy the rod, reload before the save lands, keep rod AND balance —
 * a live exploit until Phase 0 of the economy). Same rule the feed
 * consumables established: the cloud value is adopted ONLY when this device
 * has no local record at all (fresh device / cleared storage), and never
 * again after.
 *
 * Returns the value to adopt, or null to keep local truth. Pure — pinned by
 * test/profileSync.test.ts.
 */
/** Union merge for lesson completion — additive, never regresses (pure, tested). */
export function mergeLessons(local: string[], cloud: unknown): string[] {
  const set = new Set(local);
  if (Array.isArray(cloud)) for (const l of cloud) if (typeof l === 'string') set.add(l);
  return [...set].sort();
}

/**
 * Bank vault ops — the ONLY shared money (economy spec Decision 1). Server
 * validates via a Cloud Function transaction; the client credits coins ONLY
 * on an applied ack. Every call carries a fresh idempotency key so replays
 * (double-tap, reload mid-request) can never mutate twice.
 */
export async function vaultOp(
  op: 'deposit' | 'withdraw' | 'balance',
  amount = 0,
): Promise<{ balance: number; applied: boolean } | null> {
  try {
    const fns = await import('firebase/functions');
    const { getFirebaseRealtime } = await import('./firebaseClient');
    const { app } = await getFirebaseRealtime();
    const call = fns.httpsCallable(fns.getFunctions(app, 'us-central1'), 'vaultOp');
    const key =
      typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const res = await call({ op, amount, key });
    const d = res.data as { balance?: number; applied?: boolean };
    return { balance: Math.max(0, Number(d.balance) || 0), applied: !!d.applied };
  } catch {
    return null; // offline / unauthenticated — caller refunds on deposit
  }
}

export function coinAdoptValue(hasLocalRecord: boolean, cloudCoins: unknown): number | null {
  if (hasLocalRecord) return null;
  if (typeof cloudCoins !== 'number' || !Number.isFinite(cloudCoins)) return null;
  return Math.max(0, Math.floor(cloudCoins));
}

export interface Profile {
  /** Completed school lesson ids — UNION-merged (per-account, additive). */
  lessons?: string[];
  name?: string;
  hat?: string | null;
  ownedHats?: string[];
  coins?: number;
  /** Unspent feed charges (consumables, unlike the owned-once hats). */
  birdFeed?: number;
  catFeed?: number;
  fishFeed?: number;
  /** Body colours as hex strings, keyed by part (outfit/pants/hair/skin). */
  colors?: Record<string, string>;
  /** Last visit epoch ms (latest-wins merge) — powers return-visit deltas. */
  lastSeen?: number;
}

let saveTimer: number | undefined;
let pending: Profile = {};

/** Read the stored profile for this visitor (null if none / offline). */
export async function loadProfile(): Promise<{ profile: Profile | null; uid: string } | null> {
  try {
    // Dynamic import keeps the ~76KB-gzipped Firebase chunk off the critical
    // path — it loads only when a profile is actually read/written, not at boot.
    const { getFirebaseRealtime } = await import('./firebaseClient');
    const { db, uid } = await getFirebaseRealtime();
    const { ref, get } = await import('firebase/database');
    const snap = await get(ref(db, `profiles/${uid}`));
    return { profile: snap.exists() ? (snap.val() as Profile) : null, uid };
  } catch {
    return null; // offline / blocked — localStorage still holds everything
  }
}

/** Merge a patch into the cloud profile (debounced; coalesces rapid changes). */
export function saveProfile(patch: Profile): void {
  pending = { ...pending, ...patch };
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    const data = pending;
    pending = {};
    void (async () => {
      try {
        const { getFirebaseRealtime } = await import('./firebaseClient');
        const { db, uid } = await getFirebaseRealtime();
        const { ref, update } = await import('firebase/database');
        await update(ref(db, `profiles/${uid}`), { ...data, t: Date.now() });
      } catch {
        /* offline — the localStorage cache still has it */
      }
    })();
  }, 800);
}
