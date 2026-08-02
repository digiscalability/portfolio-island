// Speech.ts — VOICE for the NPCs, both directions:
//   • TTS: NPCs speak their replies aloud. CLOUD-FIRST for AI chat replies —
//     NpcChat offers ElevenLabs audio (fetched via the capped npcVoice Cloud
//     Function) into a text-keyed registry here, and speak() plays it when the
//     exact same text is spoken. Everything else (greet bubbles, canned lines,
//     any cloud failure/cap/timeout) uses the free on-device SpeechSynthesis.
//   • STT (SpeechRecognition): the visitor can talk to NPCs with their mic.
// The registry design means the UI plumbing never changed: SimpleUI still just
// calls speak(text, ...) — whether that line gets a premium voice is decided
// here, and the browser voice remains the permanent, free fallback.

// ── shared ──────────────────────────────────────────────────────────────────
function ttsSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'speechSynthesis' in window &&
    'SpeechSynthesisUtterance' in window
  );
}

// Voice kill-switch: muted-state persists across visits (ds_voice_muted).
// Speech stays opt-out (it's a big part of the NPCs' charm) but one tap of the
// chat-panel toggle silences every future line until turned back on.
let enabled = true;
try {
  enabled = localStorage.getItem('ds_voice_muted') !== '1';
} catch {
  /* no storage */
}

// ── TTS: voice selection ─────────────────────────────────────────────────────
let cachedVoices: SpeechSynthesisVoice[] = [];
function refreshVoices(): void {
  if (!ttsSupported()) return;
  cachedVoices = window.speechSynthesis.getVoices() || [];
}
if (ttsSupported()) {
  try {
    window.speechSynthesis.onvoiceschanged = refreshVoices;
    refreshVoices();
  } catch {
    /* ignore */
  }
}

// Rank a voice for quality/fit: prefer natural/neural engines, Google/Microsoft,
// and British/Australian English (the island's storybook register).
function voiceScore(v: SpeechSynthesisVoice): number {
  const n = v.name.toLowerCase();
  let s = 0;
  if (/natural|neural/.test(n)) s += 6;
  if (/google/.test(n)) s += 4;
  if (/microsoft/.test(n)) s += 3;
  if (/^en-(gb|au)/i.test(v.lang)) s += 2;
  if (/^en-us/i.test(v.lang)) s += 1;
  return s;
}
function rankedEnglish(): SpeechSynthesisVoice[] {
  return cachedVoices
    .filter((v) => /^en/i.test(v.lang))
    .sort((a, b) => voiceScore(b) - voiceScore(a));
}
// A distinct voice per NPC when the device has several; wraps otherwise.
function pickVoice(variant: number): SpeechSynthesisVoice | null {
  const list = rankedEnglish();
  if (!list.length) return cachedVoices[0] ?? null;
  return list[Math.abs(variant) % list.length];
}

// ── TTS: sanitise what is SPOKEN (not what is shown) ─────────────────────────
// Strip *stage directions* and emoji so the voice reads only the actual words —
// the caption still shows the full text with its actions/flourishes.
// Emoji + symbol/arrow blocks only. Deliberately does NOT include the General
// Punctuation block (U+2000–206F): that holds em-dashes and smart quotes, which
// TTS should keep ("don't", "Abbas—or") rather than mangle into "don t".
// The class intentionally includes ZWJ (200D) + variation-selector (FE0F) as
// standalone code points to strip them; that's what the rule flags as "combined".
// (Block-style disable: Prettier wraps this declaration across lines, so a
// disable-NEXT-LINE comment ends up pointing at the wrong one.)
/* eslint-disable no-misleading-character-class */
const EMOJI_RE =
  /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}]/gu;
/* eslint-enable no-misleading-character-class */
export function sanitizeForSpeech(text: string): string {
  return text
    .replace(/\*[^*]*\*/g, ' ') // *adjusts cap and grins* → (silent)
    .replace(/[_~`*]/g, ' ') // stray markdown emphasis
    .replace(EMOJI_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── TTS: public API ──────────────────────────────────────────────────────────
export function isSpeechSupported(): boolean {
  return ttsSupported();
}
export function isSpeechEnabled(): boolean {
  return enabled;
}
export function setSpeechEnabled(on: boolean): void {
  enabled = on;
  try {
    localStorage.setItem('ds_voice_muted', on ? '0' : '1');
  } catch {
    /* no storage */
  }
  if (!on) cancelSpeech();
}
export function cancelSpeech(): void {
  speakGen++; // invalidate any playCloud still awaiting its fetch
  stopCloudAudio();
  if (ttsSupported()) {
    try {
      window.speechSynthesis.cancel();
    } catch {
      /* ignore */
    }
  }
}

// ── TTS: cloud voice (ElevenLabs via the npcVoice Cloud Function) ────────────
// NpcChat drops { exact reply text → pending base64-MP3 } here the moment a
// reply arrives (the fetch runs while the typewriter animates), and speak()
// consumes it by text match. One-shot entries, tiny bound, stale ones evicted —
// a missed match just means the browser voice speaks, never a stuck line.
const cloudOffers = new Map<string, { p: Promise<string | null>; t: number }>();
const CLOUD_OFFER_TTL_MS = 30_000;
const CLOUD_WAIT_MS = 4_000; // max delay before giving up and speaking locally
let cloudAudioEl: HTMLAudioElement | null = null;
// Generation counter: every new spoken line (and every cancel/mute) bumps it,
// and a playCloud that awoke from its fetch only proceeds if it is STILL the
// newest line. Without this, a slow synth resolves after the panel closed
// (ghost voice) or after a newer line started (kills it, plays the older one).
let speakGen = 0;

/** Offer cloud audio for an upcoming spoken line (keyed by its EXACT text). */
export function offerCloudVoice(text: string, audio: Promise<string | null>): void {
  const now = Date.now();
  for (const [k, v] of cloudOffers) if (now - v.t > CLOUD_OFFER_TTL_MS) cloudOffers.delete(k);
  cloudOffers.delete(text); // re-offer of the same text moves to the back
  while (cloudOffers.size >= 4) {
    const oldest = cloudOffers.keys().next().value;
    if (oldest === undefined) break;
    cloudOffers.delete(oldest);
  }
  cloudOffers.set(text, { p: audio, t: now });
  audio.catch(() => {}); // never surface an unhandled rejection
}

async function playCloud(
  offer: Promise<string | null>,
  text: string,
  rate: number,
  pitch: number,
  variant: number,
  gen: number,
): Promise<void> {
  let b64: string | null = null;
  try {
    b64 = await Promise.race([
      offer,
      new Promise<null>((res) => setTimeout(() => res(null), CLOUD_WAIT_MS)),
    ]);
  } catch {
    b64 = null;
  }
  // Muted, cancelled, or superseded by a newer line while we waited — drop it.
  if (!enabled || gen !== speakGen) return;
  if (b64) {
    try {
      stopCloudAudio();
      if (ttsSupported()) window.speechSynthesis.cancel(); // never overlap voices
      const a = new Audio(`data:audio/mpeg;base64,${b64}`);
      cloudAudioEl = a;
      a.addEventListener('ended', () => {
        if (cloudAudioEl === a) cloudAudioEl = null;
      });
      await a.play();
      return;
    } catch {
      /* autoplay/decode failure → browser voice below */
    }
  }
  if (gen === speakGen) speakLocal(text, rate, pitch, variant);
}

function stopCloudAudio(): void {
  if (!cloudAudioEl) return;
  try {
    cloudAudioEl.pause();
  } catch {
    /* ignore */
  }
  cloudAudioEl = null;
}

/** Speak a line in an NPC's voice. If cloud audio was offered for this exact
 *  text (AI chat replies), that premium voice plays — with the on-device voice
 *  as the fallback for timeouts/caps/failures. Everything else speaks locally.
 *  Reads only real words — stage directions + emoji are stripped. No-op if muted. */
export function speak(text: string, rate = 1, pitch = 1, variant = 0): void {
  if (!enabled) return;
  const gen = ++speakGen; // this is now the newest line; stale fetches stand down
  const offer = cloudOffers.get(text);
  if (offer) {
    cloudOffers.delete(text); // one-shot
    void playCloud(offer.p, text, rate, pitch, variant, gen);
    return;
  }
  speakLocal(text, rate, pitch, variant);
}

function speakLocal(text: string, rate = 1, pitch = 1, variant = 0): void {
  if (!enabled || !ttsSupported()) return;
  const clean = sanitizeForSpeech(text);
  if (!clean) return;
  try {
    // Never overlap two NPC lines — including a still-playing cloud MP3.
    stopCloudAudio();
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(clean.slice(0, 400));
    const v = pickVoice(variant);
    if (v) u.voice = v;
    u.rate = rate;
    u.pitch = pitch;
    u.volume = 1;
    window.speechSynthesis.speak(u);
  } catch {
    /* speech failure never breaks the chat */
  }
}

// ── STT: talk to the NPCs ────────────────────────────────────────────────────
type RecognitionLike = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: unknown) => void) | null;
  onerror: ((e: unknown) => void) | null;
  onend: (() => void) | null;
};
function SRCtor(): (new () => RecognitionLike) | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    SpeechRecognition?: new () => RecognitionLike;
    webkitSpeechRecognition?: new () => RecognitionLike;
  };
  return w.SpeechRecognition || w.webkitSpeechRecognition || null;
}

export function isSttSupported(): boolean {
  return !!SRCtor();
}

export interface SttHandlers {
  onInterim?: (text: string) => void;
  onFinal: (text: string) => void;
  onEnd?: () => void;
  onError?: (kind: string) => void;
}

/**
 * Start a single dictation. Returns a stop() function. Interim results stream
 * via onInterim; the settled transcript arrives via onFinal when the user pauses
 * (or stop() is called). Never throws.
 */
export function startListening(handlers: SttHandlers): () => void {
  const Ctor = SRCtor();
  if (!Ctor) {
    handlers.onEnd?.();
    return () => {};
  }
  cancelSpeech(); // don't let the NPC's own voice bleed into the mic
  const rec = new Ctor();
  rec.lang = 'en-US';
  rec.interimResults = true;
  rec.continuous = false;
  rec.maxAlternatives = 1;
  let finalText = '';
  rec.onresult = (e: unknown) => {
    const ev = e as {
      resultIndex: number;
      results: ArrayLike<{ 0: { transcript: string }; isFinal: boolean }>;
    };
    let interim = '';
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const r = ev.results[i];
      if (r.isFinal) finalText += r[0].transcript;
      else interim += r[0].transcript;
    }
    handlers.onInterim?.((finalText + interim).trim());
  };
  rec.onerror = (e: unknown) => {
    handlers.onError?.(String((e as { error?: string })?.error ?? 'error'));
  };
  rec.onend = () => {
    if (finalText.trim()) handlers.onFinal(finalText.trim());
    handlers.onEnd?.();
  };
  try {
    rec.start();
  } catch {
    handlers.onEnd?.();
  }
  return () => {
    try {
      rec.stop();
    } catch {
      /* ignore */
    }
  };
}
