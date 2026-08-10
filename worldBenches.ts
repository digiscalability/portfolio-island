/**
 * Shared player-built benches — the timber sink and the economy's one piece of
 * PUBLIC persistent content (spec Decision 2, Abbas's ruling).
 *
 * Trust model, enforced by database.rules.json (deployed): keys are
 * `{uid}_{slot}` with slot 0-3 — per-visitor cap of FOUR by key construction;
 * write-once (no edits, no deletes from clients); payload is nothing but a
 * plot index 0-7 and a timestamp, so the worst possible vandalism is "a bench
 * exists at a pre-authored spot". `world/benchHidden/{uid}` is the
 * admin-only kill switch — hidden builders' benches are filtered client-side.
 *
 * Firebase is imported lazily like every other cloud seam (Boards, profileSync).
 */

export interface WorldBench {
  uid: string;
  slot: number;
  plot: number; // 0-7, index into GameScene.BENCH_PLOTS
}

export async function subscribeBenches(
  onBench: (b: WorldBench) => void,
): Promise<(() => void) | null> {
  try {
    const [{ getFirebaseRealtime }, rtdb] = await Promise.all([
      import('./firebaseClient'),
      import('firebase/database'),
    ]);
    const { db } = await getFirebaseRealtime();
    const hiddenSnap = await rtdb.get(rtdb.ref(db, 'world/benchHidden'));
    const hidden = (hiddenSnap.val() as Record<string, boolean> | null) ?? {};
    const benchesRef = rtdb.ref(db, 'world/benches');
    const off = rtdb.onChildAdded(benchesRef, (snap) => {
      const key = snap.key ?? '';
      const sep = key.lastIndexOf('_');
      if (sep <= 0) return;
      const uid = key.slice(0, sep);
      const slot = Number(key.slice(sep + 1));
      if (hidden[uid]) return; // kill switch
      const v = snap.val() as { plot?: number } | null;
      const plot = Number(v?.plot);
      if (!Number.isInteger(plot) || plot < 0 || plot > 7 || !Number.isInteger(slot)) return;
      onBench({ uid, slot, plot });
    });
    return () => off();
  } catch {
    return null; // offline — the world just has no guest benches this session
  }
}

/**
 * Place a bench on `plot`. Finds the caller's first unused slot (0-3);
 * returns the slot on success, 'full' when all four are used, null on
 * network/auth failure. The caller charges timber+coins BEFORE calling and
 * refunds on any non-number result — same credit-on-ack shape as the vault.
 */
export async function placeBench(plot: number): Promise<number | 'full' | null> {
  try {
    const [{ getFirebaseRealtime }, rtdb] = await Promise.all([
      import('./firebaseClient'),
      import('firebase/database'),
    ]);
    const { db, uid } = await getFirebaseRealtime();
    for (let slot = 0; slot < 4; slot++) {
      const ref = rtdb.ref(db, `world/benches/${uid}_${slot}`);
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
