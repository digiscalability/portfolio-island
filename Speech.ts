// Speech.ts — free, on-device VOICE for the NPCs, both directions:
//   • TTS (SpeechSynthesis): NPCs speak their replies aloud.
//   • STT (SpeechRecognition): the visitor can talk to NPCs with their mic.
// Zero cost, no key, no server. Voices are system-provided (quality varies by
// device) but we rank for the best available + give each NPC a distinct one.
//
// A premium cloud voice (e.g. ElevenLabs) would be a SEPARATE, costed add-on
// behind the same server-proxy + spend-cap pattern as the NPC brain — dynamic
// per-reply cloud TTS on anonymous public traffic is a denial-of-wallet risk,
// so it is deliberately not the default.

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
  if (ttsSupported()) {
    try {
      window.speechSynthesis.cancel();
    } catch {
      /* ignore */
    }
  }
}

/** Speak a line in an NPC's voice (variant picks the voice; rate/pitch shape it).
 *  Reads only real words — stage directions + emoji are stripped. No-op if muted. */
export function speak(text: string, rate = 1, pitch = 1, variant = 0): void {
  if (!enabled || !ttsSupported()) return;
  const clean = sanitizeForSpeech(text);
  if (!clean) return;
  try {
    window.speechSynthesis.cancel(); // never overlap two NPC lines
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
