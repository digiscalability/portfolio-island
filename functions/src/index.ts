/**
 * Cloud Functions entrypoint.
 *
 * The original HTTP functions (askAI, scheduleAppointment, submitFeedback,
 * getAvailableSlots) were retired on 2026-07-27 — unused, unauthenticated,
 * open-CORS leftovers (askAI also called the paid Gemini API).
 *
 * What remains is a single scheduled janitor: a backstop that prunes stale
 * multiplayer nodes the client-side cleanup (onDisconnect + 12s TTL) can miss
 * when a client dies before its onDisconnect registers, or a clock misbehaves.
 *
 * NOTE: deploying this provisions Cloud Scheduler; do it in a supervised deploy
 *   firebase deploy --only functions --account digiscalability@gmail.com
 */

import { onSchedule } from 'firebase-functions/v2/scheduler';
import * as admin from 'firebase-admin';

admin.initializeApp();

const STALE_PRESENCE_MS = 2 * 60 * 1000; // 2 min without a heartbeat ⇒ dead client
const STALE_EPHEMERAL_MS = 60 * 1000; // chat/voice: client TTL is 12s, so 60s is safe

/** Remove children of `path` whose `t` timestamp is older than `maxAgeMs`. */
async function prune(
  db: admin.database.Database,
  path: string,
  now: number,
  maxAgeMs: number,
): Promise<number> {
  const snap = await db.ref(path).get();
  const val = snap.val() as Record<string, { t?: number }> | null;
  if (!val) return 0;
  const updates: Record<string, null> = {};
  for (const [key, entry] of Object.entries(val)) {
    const t = typeof entry?.t === 'number' ? entry.t : 0;
    if (now - t > maxAgeMs) updates[key] = null;
  }
  const count = Object.keys(updates).length;
  if (count) await db.ref(path).update(updates);
  return count;
}

export const janitor = onSchedule(
  {
    schedule: 'every 6 hours',
    region: 'us-central1',
    timeoutSeconds: 120,
    memory: '256MiB',
  },
  async () => {
    const db = admin.database();
    const now = Date.now();
    const [presence, chat, voice] = await Promise.all([
      prune(db, 'presence/island', now, STALE_PRESENCE_MS),
      prune(db, 'chat/island', now, STALE_EPHEMERAL_MS),
      prune(db, 'voice/island', now, STALE_EPHEMERAL_MS),
    ]);
    console.log(`janitor pruned presence=${presence} chat=${chat} voice=${voice}`);
  },
);
