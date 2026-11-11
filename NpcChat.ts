// NpcChat.ts — client bridge to the server-side NPC brain (the `npcChat` Cloud
// Function). The function holds the Claude key and every guardrail; this module
// just ships {npcId, message} and returns the reply — or signals a fallback so
// the caller shows the NPC's canned lines instead. It NEVER throws to the
// caller: any failure (offline, App Check missing, rate/cap tripped, moderation)
// resolves to { fallback: true } and the NPC gracefully drops to canned dialogue.
// Every such fallback is now COUNTED (npc_fallback): with App Check failing,
// the model-backed villagers used to answer in written lines and nothing
// recorded it.

import { track } from './Analytics';
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
  { name: 'Sailor', id: 'sailor', rate: 0.98, pitch: 0.88 },
  { name: 'Mayor', id: 'mayor', rate: 1.06, pitch: 0.94 },
  { name: 'Farmer', id: 'farmer', rate: 0.92, pitch: 0.9 },
  // Economy P2 — appended (lockstep-tested against the server planner list):
  { name: 'Carpenter', id: 'carpenter', rate: 0.94, pitch: 0.9 },
  { name: 'Teller', id: 'teller', rate: 1.02, pitch: 0.96 },
  { name: 'Nurse', id: 'nurse', rate: 1.0, pitch: 1.08 },
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

/**
 * A degraded answer: the caller shows the villager's written lines instead
 * (reply stage), or keeps the composed greeting (opening stage). Counted as
 * npc_fallback {reason, stage}. reason is the server's ('rate', 'cap',
 * 'input', 'output', 'refusal', 'error') or client:<code> for a call that
 * never got a reply: client:functions/unauthenticated is what App Check
 * enforcement returns, client:auth/... a sign-in that failed first.
 */
function fallbackReply(reason: string, opening: boolean): NpcReply {
  track('npc_fallback', { reason, stage: opening ? 'opening' : 'reply' });
  return { reply: null, fallback: true, reason };
}

/** A villager's model call that has not answered by now falls back to the
 *  written lines (D10): a stalled call left the bare '…' up with no end. */
export const NPC_TIMEOUT_MS = 12000;

/** What the callable came back with, before it is counted or voiced. */
type NpcOutcome = { reply: NpcReply } | { fallback: string };

async function callNpc(npcId: string, text: string, opening: boolean): Promise<NpcOutcome> {
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
      { timeout: NPC_TIMEOUT_MS },
    );
    const res = await call(
      opening ? { npcId, message: text, opening: true } : { npcId, message: text },
    );
    const d = res.data;
    if (d && typeof d.fallback === 'boolean') {
      if (d.fallback) return { fallback: String(d.reason ?? 'unknown').slice(0, 40) };
      // A "success" with no text is still a written line on screen.
      if (!d.reply) return { fallback: 'empty-reply' };
      return { reply: d };
    }
    return { fallback: 'bad-shape' };
  } catch (e) {
    // Offline, App Check rejected or not configured, function not deployed,
    // timeout — all degrade to canned lines. The NPC never appears broken,
    // and the error code says which it was.
    const code = (e as { code?: unknown } | null)?.code;
    return { fallback: typeof code === 'string' ? `client:${code}`.slice(0, 60) : 'client-error' };
  }
}

export async function askNpc(npcName: string, message: string, opening = false): Promise<NpcReply> {
  const npcId = AI_NPCS[npcName];
  if (!npcId) return { reply: null, fallback: true, reason: 'not-ai' };
  const text = message.trim().slice(0, 300);
  if (!text) return { reply: null, fallback: true, reason: 'empty' };
  // The callable carries the timeout, and this clock covers what comes before
  // it: the chunk loads, the sign-in and App Check, any of which can stall
  // with the call never made. Whichever answers first is the one counted.
  return new Promise<NpcReply>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(fallbackReply('client:timeout', opening));
    }, NPC_TIMEOUT_MS);
    void callNpc(npcId, text, opening).then((out) => {
      if (settled) return; // the visitor already has a written line
      settled = true;
      clearTimeout(timer);
      if ('fallback' in out) {
        resolve(fallbackReply(out.fallback, opening));
        return;
      }
      const d = out.reply;
      // Cloud voice: start fetching the ElevenLabs audio NOW (it synthesizes
      // while the typewriter animates) and offer it to Speech keyed by the
      // exact reply text — speak() will play it instead of the browser voice.
      // Any failure quietly resolves null and the on-device voice takes over.
      if (typeof d.voiceKey === 'string' && d.reply) {
        offerCloudVoice(d.reply, fetchNpcVoice(d.voiceKey));
      }
      resolve(d);
    });
  });
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

// ── Question routes (P2-D4) ──────────────────────────────────────────────────
// A visitor who asks a villager "what does he build?" or "where is the shop?"
// should leave with the answer and one button that takes them there, whether
// the model answered or not. routeQuestion is pure and client-side: keyword
// routes onto the four portfolio surfaces and the hire card, and "where is"
// questions onto a place the compass can point at ('ds:guide-to' keys).
//
// Copy rules: the lines restate what the panels already say, type no counts,
// and never call a villager anything but a villager. The availability line
// stays on the hire card alone, so no line here states it.
//
// NOTE for whoever adds a route: the roster order tests read this file from
// the villager list to its end for quoted persona ids, so nothing down here
// may carry a property named like the roster's id field with a quoted value.

export type RouteKind = 'projects' | 'professional' | 'personal' | 'contact' | 'hire' | 'place';

/** The one button offered under the reply. Exactly one of zone, hire and
 *  guideKey is set. */
export interface RouteAction {
  label: string;
  /** Open this Portfolio panel. */
  zone?: 'projects' | 'professional' | 'personal';
  /** Open the hire card (CV, experience, contact). */
  hire?: true;
  /** Point the compass at this 'ds:guide-to' key. */
  guideKey?: string;
}

export interface QuestionRoute {
  kind: RouteKind;
  /** What the villager says when the model could not answer. */
  line: string;
  action?: RouteAction;
}

const SHOW_ME = 'Show me';

/** Places a "where is" question can name: [pattern, guide key, line]. The
 *  first match wins, so the specific names come before the district words. */
const PLACE_ROUTES: Array<[RegExp, string, string]> = [
  [
    /\bbeach ?house\b|\bislet\b/,
    'beach-house',
    'The beach house is on the islet out south. Its door wants a code — ask the Sailor at the harbour.',
  ],
  [
    /\bschool\b|\blessons?\b/,
    'school',
    'The School is in the Personal district. Its lessons teach how the island works.',
  ],
  [
    /\b(shop|kiosk|store|market|stalls?)\b/,
    'kiosk',
    'The shop kiosk sells tools, hats, feed and food for coins.',
  ],
  [
    /\bbank\b|\bvault\b/,
    'bank',
    'The Bank is in the Hub. It assays ore and keeps a vault for your coins.',
  ],
  [
    /\b(harbou?r|jetty|dock|pier|shore|fishing|fish)\b/,
    'shore',
    'The Fisherman’s jetty is down on the shore, the place to cast a line. Bring a rod from the shop.',
  ],
  [
    /\b(race|races|racing|circuit|start line|starting line)\b/,
    'race:land',
    'The land circuit has a start line. Board a vehicle and cross it to begin.',
  ],
  [
    /\b(projects?|portfolio|ventures?)\b|\bhis work\b|\bthe work\b/,
    'district:projects',
    'Projects is its own district: every venture has a site there, with this island as the flagship.',
  ],
  [
    /\b(contact|post office|get in touch)\b/,
    'district:contact',
    'Contact is its own district. The Post Office there sends Abbas a real email.',
  ],
  [
    /\b(professional|experience|career)\b/,
    'district:professional',
    'Professional is its own district: Abbas’s experience, role by role.',
  ],
  [
    /\bpersonal\b/,
    'district:personal',
    'Personal is the cottage district: kitchens, family recipes and the creative side.',
  ],
  [
    /\b(hub|town square|town hall|plaza)\b/,
    'district:welcome',
    'The Hub is the town square at the top of the island.',
  ],
];

/** "where is…", "how do I get to…", "take me to…", "which way to…". */
const WHERE =
  /\bwhere(?:'s| is| are| can i find| do i find)?\b|\bhow (?:do|can) i (?:get|go) to\b|\b(?:take|guide|lead|point) me to\b|\bwhich way\b|\bdirections? to\b|\bhow (?:do|can) i find\b/;

const HIRE =
  /\b(hire|hiring|recruit(?:er|ing)?|cv|resume|role|roles|job|jobs|vacancy|position|available|availability|employ(?:er|ment)?)\b/;
const CONTACT =
  /\b(contact|email|e-mail|reach|get in touch|message (?:him|abbas)|talk to (?:him|abbas)|speak (?:to|with) (?:him|abbas)|linkedin)\b/;
/** Who made this, who is he: the person, not the villager being asked. */
const WHO =
  /\bwho(?:'s| is| was)? (?:abbas|he|him|the (?:owner|maker|builder|creator|founder|developer))\b|\bwho (?:made|built|created|runs|owns|designed)\b|\babout (?:abbas|him|the (?:owner|maker|builder|creator|founder))\b/;
const PROJECTS =
  /\b(projects?|portfolio|built|builds?|building|ship(?:s|ped|ping)?|ventures?|products?|rankpilot|chocomate|cookbook|digiscalability)\b|\b(?:his|abbas's|abbas'|the) work\b|\bwork(?:s|ed|ing)? on\b|\binsta services\b/;
/** "How do I build a house?" is about the island's own building, not the portfolio. */
const OWN_BUILD = /\b(?:i|we|me|my)\b[^?.!]{0,16}\bbuild/;
const PROFESSIONAL =
  /\b(experience|background|career|skills?|stack|qualifications?|education|degree|studied|professional)\b/;
const PERSONAL =
  /\b(hobby|hobbies|family|personal|outside (?:of )?work|free time|spare time|chef|kitchens?)\b/;

/**
 * Route a visitor's question. Null when it names nothing the portfolio or
 * the compass can answer ("Nice weather?"): the villager's own reply stands.
 */
export function routeQuestion(text: string): QuestionRoute | null {
  if (typeof text !== 'string') return null;
  const q = text
    .slice(0, 300)
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/é/g, 'e')
    .replace(/\s+/g, ' ')
    .trim();
  if (!q) return null;
  if (WHERE.test(q)) {
    for (const [re, guideKey, line] of PLACE_ROUTES) {
      if (re.test(q)) return { kind: 'place', line, action: { label: SHOW_ME, guideKey } };
    }
  }
  if (HIRE.test(q)) {
    return {
      kind: 'hire',
      line: 'Abbas is an AI and software engineer in Melbourne. His CV, experience and contact details are on one card.',
      action: { label: 'Hiring? CV & contact', hire: true },
    };
  }
  if (CONTACT.test(q)) {
    return {
      kind: 'contact',
      line: 'You can reach Abbas directly: his email, LinkedIn and a message form are on one card.',
      action: { label: 'Hiring? CV & contact', hire: true },
    };
  }
  if (WHO.test(q)) {
    return {
      kind: 'professional',
      line: 'Abbas built this island. He is an AI and software engineer in Melbourne, and the founder of DigiScalability. Professional has his experience.',
      action: { label: 'Open Professional', zone: 'professional' },
    };
  }
  if (PROJECTS.test(q) && !OWN_BUILD.test(q)) {
    return {
      kind: 'projects',
      line: 'Abbas builds AI products end to end. This island is the flagship, and the rest of his work is in Projects.',
      action: { label: 'Open Projects', zone: 'projects' },
    };
  }
  if (PROFESSIONAL.test(q)) {
    return {
      kind: 'professional',
      line: 'Abbas is an AI and software engineer in Melbourne, and the founder of DigiScalability. Professional has his experience and education.',
      action: { label: 'Open Professional', zone: 'professional' },
    };
  }
  if (PERSONAL.test(q)) {
    return {
      kind: 'personal',
      line: 'Not everything here is software: years in Melbourne kitchens, his mother’s handwritten recipes and a creative studio. Personal has that side.',
      action: { label: 'Open Personal', zone: 'personal' },
    };
  }
  return null;
}
