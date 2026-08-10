/**
 * Shared player-built STRUCTURES (signposts, lanterns, gazebos) — the timber
 * sink grown past benches into a small construction catalog.
 *
 * Byte-level clone of the worldBenches trust model (that file is the audited
 * template): keys are `{uid}_{slot}` with slot 0-5 — per-visitor cap of SIX
 * builds by key construction; write-once; payload is nothing but a plot index
 * 0-13 (into GameScene.BUILD_PLOTS, whose INDEX fixes the structure kind) and
 * a timestamp — the worst possible vandalism is "a pre-authored structure
 * exists at a pre-authored spot". `world/buildHidden/{uid}` is the admin-only
 * kill switch. Firebase stays lazily imported.
 */

export interface WorldBuild {
  uid: string;
  slot: number;
  plot: number; // 0-13, index into GameScene.BUILD_PLOTS (index fixes the kind)
}

export async function subscribeBuilds(
  onBuild: (b: WorldBuild) => void,
): Promise<(() => void) | null> {
  try {
    const [{ getFirebaseRealtime }, rtdb] = await Promise.all([
      import('./firebaseClient'),
      import('firebase/database'),
    ]);
    const { db } = await getFirebaseRealtime();
    const hiddenSnap = await rtdb.get(rtdb.ref(db, 'world/buildHidden'));
    const hidden = (hiddenSnap.val() as Record<string, boolean> | null) ?? {};
    const buildsRef = rtdb.ref(db, 'world/builds');
    const off = rtdb.onChildAdded(buildsRef, (snap) => {
      const key = snap.key ?? '';
      const sep = key.lastIndexOf('_');
      if (sep <= 0) return;
      const uid = key.slice(0, sep);
      const slot = Number(key.slice(sep + 1));
      if (hidden[uid]) return; // kill switch
      const v = snap.val() as { plot?: number } | null;
      const plot = Number(v?.plot);
      if (!Number.isInteger(plot) || plot < 0 || plot > 13 || !Number.isInteger(slot)) return;
      onBuild({ uid, slot, plot });
    });
    return () => off();
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
export async function placeBuild(plot: number): Promise<number | 'full' | null> {
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
      await rtdb.set(ref, { plot, t: Date.now() });
      return slot;
    }
    return 'full';
  } catch {
    return null;
  }
}
