// NpcChat.ts — client bridge to the server-side NPC brain (the `npcChat` Cloud
// Function). The function holds the Claude key and every guardrail; this module
// just ships {npcId, message} and returns the reply — or signals a fallback so
// the caller shows the NPC's canned lines instead. It NEVER throws to the
// caller: any failure (offline, App Check missing, rate/cap tripped, moderation)
// resolves to { fallback: true } and the NPC gracefully drops to canned dialogue.

import { offerCloudVoice } from './Speech';

export interface NpcReply {
  reply: string | null;
  fallback: boolean;
  reason?: string;
  /** Opaque server-minted id for fetching the ElevenLabs audio of `reply`. */
  voiceKey?: string;
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

// ── Aware proximity greetings ────────────────────────────────────────────────
// Composed CLIENT-SIDE from live world state (the NPC's planner-assigned
// activity, time of day, island mood, day-theme) — instant, $0, and safe:
// every fragment is pre-authored; the "intelligence" is the live state
// selecting them. The LLM engagement stays behind the chat send.

const TIME_GREETS: Array<[number, number, string[]]> = [
  [5, 11, ['Good morning', 'Fine morning', 'Morning, traveller']],
  [11, 17, ['Good afternoon', 'Lovely afternoon', 'Afternoon, traveller']],
  [17, 21, ['Good evening', 'Fine evening', 'Evening, traveller']],
  [21, 29, ['Up late, are we', 'Quiet night tonight', 'The stars are out']],
];

const ACTIVITY_OPENERS: Record<string, string[]> = {
  tend_flowers: ['these beds won’t tend themselves', 'the flowers are thirsty today'],
  patrol: ['all quiet on my rounds so far', 'keeping an eye on the boulevard'],
  mail_round: ['half a postbag still to deliver', 'letters wait for no one'],
  play_music: ['I’ve a tune going in the plaza', 'the plaza wanted music today'],
  lamp_round: ['just seeing to the lamps', 'a lamp untended is a corner unlit'],
  paint_vista: ['trying to catch this light before it moves', 'the coast is posing for me today'],
  keep_light: ['the light must never go out', 'watching over the lighthouse, as ever'],
  shore_gaze: ['the tide has stories today', 'just watching the water roll in'],
  market_visit: ['browsing the stalls for something good', 'market’s lively today'],
  bench_rest: ['resting these old feet a moment', 'just enjoying the view from here'],
  stroll: ['out stretching my legs', 'no better island for a stroll'],
  plaza_gather: ['everyone’s gathering in the plaza', 'you can feel the buzz in the plaza'],
  study: ['deep in my studies today', 'so much to learn about this world'],
  muse: ['lost in thought, I’m afraid', 'pondering the big questions'],
};
const GENERIC_OPENERS = ['taking in the island air', 'a fine day to be on the island'];

const EVENT_TAGS: Record<string, string> = {
  festival: 'It’s festival day — the whole town’s buzzing!',
  market_day: 'It’s market day on the island.',
  music_day: 'It’s music day — listen close.',
  mystery: 'Something mysterious is in the air today…',
  launch_day: 'Word is something big launched today!',
};

const pick = (arr: string[]): string => arr[Math.floor(Math.random() * arr.length)] ?? arr[0];

/**
 * One or two short sentences an NPC says when the visitor walks up: aware of
 * the hour, their current planner-assigned activity, and the day-theme. Also
 * used as the chat opening so the bubble and the conversation flow as one.
 */
export function composeAwareGreeting(opts: {
  activity?: string;
  hour: number;
  event?: string;
}): string {
  const band = TIME_GREETS.find(
    ([from, to]) =>
      (opts.hour >= from && opts.hour < to) || (opts.hour + 24 >= from && opts.hour + 24 < to),
  );
  const greet = pick(band ? band[2] : TIME_GREETS[1][2]);
  const opener = pick((opts.activity && ACTIVITY_OPENERS[opts.activity]) || GENERIC_OPENERS);
  const eventTag =
    opts.event && EVENT_TAGS[opts.event] && Math.random() < 0.5 ? ` ${EVENT_TAGS[opts.event]}` : '';
  return `${greet} — ${opener}.${eventTag}`;
}

export async function askNpc(npcName: string, message: string, opening = false): Promise<NpcReply> {
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
    const call = fns.httpsCallable<{ npcId: string; message: string; opening?: boolean }, NpcReply>(
      functions,
      'npcChat',
    );
    const res = await call(
      opening ? { npcId, message: text, opening: true } : { npcId, message: text },
    );
    const d = res.data;
    if (d && typeof d.fallback === 'boolean') {
      // Cloud voice: start fetching the ElevenLabs audio NOW (it synthesizes
      // while the typewriter animates) and offer it to Speech keyed by the
      // exact reply text — speak() will play it instead of the browser voice.
      // Any failure quietly resolves null and the on-device voice takes over.
      if (!d.fallback && d.reply && typeof d.voiceKey === 'string') {
        offerCloudVoice(d.reply, fetchNpcVoice(d.voiceKey));
      }
      return d;
    }
    return { reply: null, fallback: true, reason: 'bad-shape' };
  } catch {
    // Offline, App Check not configured yet, function not deployed, timeout —
    // all degrade to canned lines. The NPC never appears broken.
    return { reply: null, fallback: true, reason: 'client-error' };
  }
}

/** Fetch the ElevenLabs audio (base64 MP3) for a reply id. Never throws —
 *  every failure (cap, rate, expiry, offline) resolves to null so the caller
 *  falls back to the free on-device voice. */
async function fetchNpcVoice(voiceKey: string): Promise<string | null> {
  try {
    const [{ getFirebaseApp }, fns] = await Promise.all([
      import('./firebaseClient'),
      import('firebase/functions'),
    ]);
    const app = await getFirebaseApp();
    const functions = fns.getFunctions(app, 'us-central1');
    const call = fns.httpsCallable<{ id: string }, { audio: string | null; fallback: boolean }>(
      functions,
      'npcVoice',
    );
    const res = await call({ id: voiceKey });
    return res.data && typeof res.data.audio === 'string' ? res.data.audio : null;
  } catch {
    return null;
  }
}

/**
 * Background deepening of the chat opening: the panel opens INSTANTLY with the
 * composed aware greeting, and this asks the server persona to continue it
 * with a fully-generated line. Fallback/failure resolves silently — the
 * composed line already stands on its own.
 */
export async function askNpcOpening(npcName: string, composedGreeting: string): Promise<NpcReply> {
  return askNpc(npcName, composedGreeting, true);
}
