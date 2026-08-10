/**
 * Shared player-built STRUCTURES (signposts, lanterns, gazebos, planters,
 * campfires) — the timber sink grown past benches into a construction catalog.
 *
 * Byte-level clone of the worldBenches trust model (that file is the audited
 * template): keys are `{uid}_{slot}` with slot 0-5 — per-visitor cap of SIX
 * builds by key construction; create-or-delete-own, never overwrite; payload
 * is a plot index (into GameScene.BUILD_PLOTS), a timestamp, and an OPTIONAL
 * kind index into BUILD_KIND_IDS (records without it — every pre-choice
 * build — render the plot's default kind, forever). The worst possible
 * vandalism stays "a pre-authored structure exists at a pre-authored spot".
 * `world/buildHidden/{uid}` is the admin-only kill switch. Firebase stays
 * lazily imported.
 */

/** Wire values for the record's optional `kind` — APPEND-ONLY, order is the
 *  contract (database.rules.json validates 0..BUILD_KIND_IDS.length-1). */
export const BUILD_KIND_IDS = ['signpost', 'lantern', 'gazebo', 'planter', 'campfire'] as const;
export type BuildKindId = (typeof BUILD_KIND_IDS)[number];

/** Highest valid plot index on the wire (mirrored in database.rules.json). */
export const MAX_PLOT = 17;

export interface WorldBuild {
  uid: string;
  slot: number;
  plot: number; // 0..MAX_PLOT, index into GameScene.BUILD_PLOTS
  kind?: number; // optional index into BUILD_KIND_IDS; absent = plot default
  t?: number; // server-side placement timestamp (ms) when present
  own: boolean; // true when this record belongs to the local visitor
}

export async function subscribeBuilds(
  onBuild: (b: WorldBuild) => void,
  onRemove?: (r: { uid: string; slot: number; plot: number }) => void,
): Promise<(() => void) | null> {
  try {
    const [{ getFirebaseRealtime }, rtdb] = await Promise.all([
      import('./firebaseClient'),
      import('firebase/database'),
    ]);
    const { db, uid: authUid } = await getFirebaseRealtime();
    const hiddenSnap = await rtdb.get(rtdb.ref(db, 'world/buildHidden'));
    const hidden = (hiddenSnap.val() as Record<string, boolean> | null) ?? {};
    const buildsRef = rtdb.ref(db, 'world/builds');
    const parseKey = (key: string): { uid: string; slot: number } | null => {
      const sep = key.lastIndexOf('_');
      if (sep <= 0) return null;
      return { uid: key.slice(0, sep), slot: Number(key.slice(sep + 1)) };
    };
    const offAdd = rtdb.onChildAdded(buildsRef, (snap) => {
      const id = parseKey(snap.key ?? '');
      if (!id || hidden[id.uid] || !Number.isInteger(id.slot)) return;
      const v = snap.val() as { plot?: number; kind?: number; t?: number } | null;
      const plot = Number(v?.plot);
      if (!Number.isInteger(plot) || plot < 0 || plot > MAX_PLOT) return;
      const kind = Number(v?.kind);
      const t = Number(v?.t);
      onBuild({
        uid: id.uid,
        slot: id.slot,
        plot,
        // Range-clamping beyond the wire bound stays in the RENDERER so this
        // layer never needs re-auditing as kinds append.
        kind: Number.isInteger(kind) && kind >= 0 ? kind : undefined,
        t: Number.isFinite(t) && t > 0 ? t : undefined,
        own: id.uid === authUid,
      });
    });
    const offRemove = onRemove
      ? rtdb.onChildRemoved(buildsRef, (snap) => {
          const id = parseKey(snap.key ?? '');
          if (!id || !Number.isInteger(id.slot)) return;
          const v = snap.val() as { plot?: number } | null;
          const plot = Number(v?.plot);
          if (!Number.isInteger(plot) || plot < 0 || plot > MAX_PLOT) return;
          onRemove({ uid: id.uid, slot: id.slot, plot });
        })
      : null;
    return () => {
      offAdd();
      offRemove?.();
    };
  } catch {
    return null; // offline — the world just has no guest structures this session
  }
}

/**
 * Place a structure on `plot`. Finds the caller's first unused slot (0-5);
 * returns the slot on success, 'full' when all six are used, null on
 * network/auth failure. The caller charges timber+coins BEFORE calling and
 * refunds on any non-number result — same credit-on-ack shape as the vault.
 */
export async function placeBuild(plot: number, kind?: number): Promise<number | 'full' | null> {
  try {
    const [{ getFirebaseRealtime }, rtdb] = await Promise.all([
      import('./firebaseClient'),
      import('firebase/database'),
    ]);
    const { db, uid } = await getFirebaseRealtime();
    for (let slot = 0; slot < 6; slot++) {
      const ref = rtdb.ref(db, `world/builds/${uid}_${slot}`);
      const existing = await rtdb.get(ref);
      if (existing.exists()) continue;
      await rtdb.set(
        ref,
        Number.isInteger(kind) ? { plot, t: Date.now(), kind } : { plot, t: Date.now() },
      );
      return slot;
    }
    return 'full';
  } catch {
    return null;
  }
}

/**
 * Remove the caller's OWN build in `slot` (reclaim flow). The rules allow
 * create-or-delete-own, never overwrite — replacing = remove + fresh place.
 * Returns true on ack; the caller refunds timber only after a true.
 */
export async function removeBuild(slot: number): Promise<boolean> {
  try {
    const [{ getFirebaseRealtime }, rtdb] = await Promise.all([
      import('./firebaseClient'),
      import('firebase/database'),
    ]);
    const { db, uid } = await getFirebaseRealtime();
    await rtdb.remove(rtdb.ref(db, `world/builds/${uid}_${slot}`));
    return true;
  } catch {
    return false;
  }
}
