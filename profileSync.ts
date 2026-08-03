/**
 * Cloud-backed player profile.
 *
 * name / hat / owned hats / coins are mirrored to Firebase RTDB under
 * `profiles/{uid}` (the anonymous-auth uid). localStorage stays the immediate,
 * offline cache; this adds durable cloud storage that survives a localStorage
 * clear and is the foundation for true cross-device sync once an account is
 * linked (anonymous auth is per-device on its own).
 */
export interface Profile {
  name?: string;
  hat?: string | null;
  ownedHats?: string[];
  coins?: number;
  /** Unspent bird-feed charges (a consumable, unlike the owned-once hats). */
  birdFeed?: number;
  /** Body colours as hex strings, keyed by part (outfit/pants/hair/skin). */
  colors?: Record<string, string>;
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
