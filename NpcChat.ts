// NpcChat.ts — client bridge to the server-side NPC brain (the `npcChat` Cloud
// Function). The function holds the Claude key and every guardrail; this module
// just ships {npcId, message} and returns the reply — or signals a fallback so
// the caller shows the NPC's canned lines instead. It NEVER throws to the
// caller: any failure (offline, App Check missing, rate/cap tripped, moderation)
// resolves to { fallback: true } and the NPC gracefully drops to canned dialogue.

export interface NpcReply {
  reply: string | null;
  fallback: boolean;
  reason?: string;
}

/** Per-NPC spoken-voice character (browser SpeechSynthesis). `variant` picks a
 *  DIFFERENT system voice per NPC when the device has several, so they don't all
 *  sound identical; rate/pitch shape the delivery. No cloud TTS cost. */
export interface VoiceProfile {
  rate: number;
  pitch: number;
  variant: number;
}

// One list drives everything: the display name (as in NPC_PERSONALITIES), the
// server persona id (must match PERSONAS in functions/src/index.ts), and a
// distinct voice (rate/pitch). `variant` (the array index) rotates the actual
// system voice. Market Vendor is excluded — it runs the shop, not a chat.
const AI_NPC_DEFS: Array<{ name: string; id: string; rate: number; pitch: number }> = [
  { name: 'Storyteller', id: 'storyteller', rate: 0.95, pitch: 1.08 },
  { name: 'Elder Sage', id: 'elder_sage', rate: 0.85, pitch: 0.82 },
  { name: 'Guard', id: 'guard', rate: 1.04, pitch: 0.98 },
  { name: 'Village Baker', id: 'village_baker', rate: 1.0, pitch: 1.1 },
  { name: 'Island Explorer', id: 'island_explorer', rate: 1.1, pitch: 1.05 },
  { name: 'Young Student', id: 'young_student', rate: 1.12, pitch: 1.22 },
  { name: 'Fisherman', id: 'fisherman', rate: 0.88, pitch: 0.9 },
  { name: 'Artist', id: 'artist', rate: 0.98, pitch: 1.15 },
  { name: 'Wanderer', id: 'wanderer', rate: 0.85, pitch: 0.9 },
  { name: 'Gardener', id: 'gardener', rate: 0.96, pitch: 1.06 },
  { name: 'Architect', id: 'architect', rate: 1.0, pitch: 0.95 },
  { name: 'Musician', id: 'musician', rate: 1.06, pitch: 1.12 },
  { name: 'Lighthouse Keeper', id: 'lighthouse_keeper', rate: 0.9, pitch: 0.88 },
  { name: 'Tourist', id: 'tourist', rate: 1.1, pitch: 1.16 },
  { name: 'Cartographer', id: 'cartographer', rate: 1.0, pitch: 0.92 },
  { name: 'Philosopher', id: 'philosopher', rate: 0.88, pitch: 0.96 },
  { name: 'Courier', id: 'courier', rate: 1.16, pitch: 1.0 },
  { name: 'Night Watch', id: 'night_watch', rate: 0.9, pitch: 0.85 },
];

/** Display name → server persona id, for every NPC with an LLM brain. */
export const AI_NPCS: Record<string, string> = Object.fromEntries(
  AI_NPC_DEFS.map((d) => [d.name, d.id]),
);

/** Display name → spoken-voice profile (variant = array index). */
export const VOICE_PROFILES: Record<string, VoiceProfile> = Object.fromEntries(
  AI_NPC_DEFS.map((d, i) => [d.name, { rate: d.rate, pitch: d.pitch, variant: i }]),
);

export function isAiNpc(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(AI_NPCS, name);
}

export function voiceProfileFor(name: string): VoiceProfile {
  return VOICE_PROFILES[name] ?? { rate: 1, pitch: 1, variant: 0 };
}

export async function askNpc(npcName: string, message: string): Promise<NpcReply> {
  const npcId = AI_NPCS[npcName];
  if (!npcId) return { reply: null, fallback: true, reason: 'not-ai' };
  const text = message.trim().slice(0, 300);
  if (!text) return { reply: null, fallback: true, reason: 'empty' };
  try {
    const [{ getFirebaseApp }, fns] = await Promise.all([
      import('./firebaseClient'),
      import('firebase/functions'),
    ]);
    const app = await getFirebaseApp();
    const functions = fns.getFunctions(app, 'us-central1');
    const call = fns.httpsCallable<{ npcId: string; message: string }, NpcReply>(
      functions,
      'npcChat',
    );
    const res = await call({ npcId, message: text });
    const d = res.data;
    if (d && typeof d.fallback === 'boolean') return d;
    return { reply: null, fallback: true, reason: 'bad-shape' };
  } catch {
    // Offline, App Check not configured yet, function not deployed, timeout —
    // all degrade to canned lines. The NPC never appears broken.
    return { reply: null, fallback: true, reason: 'client-error' };
  }
}
