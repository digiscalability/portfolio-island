/**
 * Social boards — race leaderboard + guestbook, persisted to the life-island
 * RTDB. Firebase is imported lazily (same pattern as profileSync) so nothing
 * here touches the startup critical path. All reads/writes are best-effort:
 * a blocked/offline backend must never break the game.
 */
import { cleanChatText, safePeerName } from './Moderation';

export type CircuitKind = 'land' | 'water';
export interface LeaderEntry {
  name: string;
  timeMs: number;
}
export interface GuestEntry {
  name: string;
  msg: string;
  t: number;
}

/** Submit a race time; keeps only the player's personal best per circuit. */
export async function submitRaceTime(
  circuit: CircuitKind,
  timeSec: number,
  name: string,
): Promise<void> {
  try {
    const { getFirebaseRealtime } = await import('./firebaseClient');
    const { ref, get, set } = await import('firebase/database');
    const { db, uid } = await getFirebaseRealtime();
    const path = `leaderboard/island/${circuit}/${uid}`;
    const timeMs = Math.round(timeSec * 1000);
    const existing = await get(ref(db, path));
    const prev = existing.val()?.timeMs;
    if (typeof prev === 'number' && prev <= timeMs) return; // not an improvement
    await set(ref(db, path), { name: safePeerName(name), timeMs, t: Date.now() });
  } catch {
    /* best-effort */
  }
}

/** Top-N fastest times for a circuit, ascending. */
export async function getLeaderboard(circuit: CircuitKind, topN = 10): Promise<LeaderEntry[]> {
  try {
    const { getFirebaseRealtime } = await import('./firebaseClient');
    const { ref, get } = await import('firebase/database');
    const { db } = await getFirebaseRealtime();
    const snap = await get(ref(db, `leaderboard/island/${circuit}`));
    const val = snap.val() as Record<string, { name?: string; timeMs?: number }> | null;
    if (!val) return [];
    return Object.values(val)
      .filter((v): v is { name?: string; timeMs: number } => !!v && typeof v.timeMs === 'number')
      .map((v) => ({ name: safePeerName(v.name || 'Guest'), timeMs: v.timeMs }))
      .sort((a, b) => a.timeMs - b.timeMs)
      .slice(0, topN);
  } catch {
    return [];
  }
}

/** Sign the guestbook. Returns false if the message was empty after cleaning. */
export async function signGuestbook(name: string, msg: string): Promise<boolean> {
  const clean = cleanChatText(msg);
  if (!clean) return false;
  try {
    const { getFirebaseRealtime } = await import('./firebaseClient');
    const { ref, push, set } = await import('firebase/database');
    const { db, uid } = await getFirebaseRealtime();
    const entryRef = push(ref(db, 'guestbook/island'));
    await set(entryRef, { id: uid, name: safePeerName(name), msg: clean, t: Date.now() });
    return true;
  } catch {
    return false;
  }
}

/**
 * Submit a contact lead. Writes to leads/island, which is NOT world-readable
 * (see rules: no .read) — submitted emails stay private to the site owner.
 * Returns false on an obviously-invalid email or a write failure.
 */
export async function submitLead(name: string, email: string, message: string): Promise<boolean> {
  const cleanEmail = email.trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(cleanEmail)) return false;
  try {
    const { getFirebaseRealtime } = await import('./firebaseClient');
    const { ref, push, set } = await import('firebase/database');
    const { db, uid } = await getFirebaseRealtime();
    // Attribution context (owner-only, best-effort): which channel/campaign
    // produced this lead, and how long they explored before writing. Captured
    // at boot into sessionStorage by main-simple; without it a lead email
    // can't tell a Show HN visitor from a LinkedIn one.
    let ctx = '';
    try {
      const entry = sessionStorage.getItem('ds_entry');
      ctx = JSON.stringify({
        ...(entry ? (JSON.parse(entry) as object) : {}),
        dwellS: Math.round(performance.now() / 1000),
      }).slice(0, 500);
    } catch {
      /* no storage — lead still submits */
    }
    const entryRef = push(ref(db, 'leads/island'));
    await set(entryRef, {
      id: uid,
      name: safePeerName(name).slice(0, 80),
      email: cleanEmail.slice(0, 120),
      // Kept verbatim (private, owner-only); length is capped by the rules too.
      message: message.trim().slice(0, 1000),
      ...(ctx ? { ctx } : {}),
      t: Date.now(),
    });
    return true;
  } catch {
    return false;
  }
}

/** Most-recent guestbook entries, newest first. */
export async function getGuestbook(limitN = 25): Promise<GuestEntry[]> {
  try {
    const { getFirebaseRealtime } = await import('./firebaseClient');
    const { ref, query, limitToLast, get } = await import('firebase/database');
    const { db } = await getFirebaseRealtime();
    const snap = await get(query(ref(db, 'guestbook/island'), limitToLast(limitN)));
    const val = snap.val() as Record<string, Partial<GuestEntry>> | null;
    if (!val) return [];
    return Object.values(val)
      .filter((v): v is GuestEntry => !!v && typeof v.msg === 'string')
      .map((v) => ({ name: safePeerName(v.name || 'Guest'), msg: v.msg, t: v.t || 0 }))
      .sort((a, b) => b.t - a.t);
  } catch {
    return [];
  }
}
