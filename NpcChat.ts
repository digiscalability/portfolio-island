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

/** Which NPCs have an LLM brain wired up. Others use canned dialogue only. */
export const AI_NPCS: Record<string, string> = {
  // display name (as in NPC_PERSONALITIES) → server persona id (PERSONAS in functions)
  Storyteller: 'storyteller',
  'Elder Sage': 'elder_sage',
  Guard: 'guard',
};

/** Per-NPC spoken-voice character (browser SpeechSynthesis). `variant` picks a
 *  DIFFERENT system voice per NPC when the device has several, so they don't all
 *  sound identical; rate/pitch shape the delivery. No cloud TTS cost. */
export interface VoiceProfile { rate: number; pitch: number; variant: number }
export const VOICE_PROFILES: Record<string, VoiceProfile> = {
  Storyteller: { rate: 0.95, pitch: 1.08, variant: 0 }, // warm, lilting
  'Elder Sage': { rate: 0.85, pitch: 0.82, variant: 1 }, // slow, deep, wise
  Guard: { rate: 1.04, pitch: 0.98, variant: 2 }, // brisk, firm
};

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
    const call = fns.httpsCallable<{ npcId: string; message: string }, NpcReply>(functions, 'npcChat');
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
