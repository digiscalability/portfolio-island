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

import { sfx } from './Sfx'; // duckForVoice: the sfx bus steps back under speech

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

// ── master-bus coupling ──────────────────────────────────────────────────────
// The HUD mute is the ONE switch for all sound. Speech historically ignored it
// (speechSynthesis never touches an AudioContext, and the cloud path connected
// straight to ctx.destination and even resumed a deliberately-suspended ctx,
// un-muting music+sfx). All playback now consults the AudioManager master.
type MasterLike = {
  isMuted?: () => boolean;
  getEffectiveVolume?: () => number;
  getDestination?: () => AudioNode;
};
function master(): MasterLike | undefined {
  return (window as unknown as { audioManager?: MasterLike }).audioManager;
}
function masterMuted(): boolean {
  try {
    return master()?.isMuted?.() ?? false;
  } catch {
    return false;
  }
}
function masterVolume(): number {
  try {
    return master()?.getEffectiveVolume?.() ?? 1;
  } catch {
    return 1;
  }
}
// ElevenLabs MP3s are mastered hot — was the loudest thing in the app, ungained.
// 0.9 through the 0.7 master ≈ 0.63 effective: still the clearest channel.
const SPEECH_LEVEL = 0.9;

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
  sfx.duckForVoice(false); // whatever was speaking, the bed comes back
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
// Max delay before giving up and speaking locally. Turbo renders in ~1-2s;
// 6s covers cold function starts while the reply text types out.
const CLOUD_WAIT_MS = 6_000;
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
  if (!enabled || masterMuted() || gen !== speakGen) return;
  if (b64) {
    // WEB AUDIO FIRST (the mobile fix): an HTMLAudioElement.play() that fires
    // 1-2s after the Send tap is OUTSIDE the gesture window, and iOS/Android
    // block it — desktop heard the voice, phones never did. The game's shared
    // AudioContext (window.audioManager, same pipe Chat voice clips use) is
    // unlocked by the first real interaction, and an unlocked context may
    // start sources programmatically forever after.
    try {
      const ctx = cloudAudioCtx();
      if (ctx) {
        // NEVER resume a master-muted ctx: the HUD mute suspends it on purpose,
        // and resuming here used to un-mute music+sfx as a side effect.
        if (ctx.state === 'suspended' && !masterMuted()) void ctx.resume().catch(() => {});
        const buf = await ctx.decodeAudioData(base64ToArrayBuffer(b64));
        if (!enabled || masterMuted() || gen !== speakGen) return; // re-check after the decode await
        stopCloudAudio();
        if (ttsSupported()) window.speechSynthesis.cancel(); // never overlap voices
        const src = ctx.createBufferSource();
        // Cap dead air before it plays: TTS models occasionally emit 0.8-1.2s
        // mid-line stalls ("weird gaps"). We have the raw PCM right here, so
        // clamp every internal silence to a natural beat, model be damned.
        src.buffer = compressBufferSilences(ctx, buf);
        // Route through the master bus (one mute/volume knob), levelled — the
        // raw MP3 straight into ctx.destination was the loudest thing in the app.
        const g = ctx.createGain();
        g.gain.value = SPEECH_LEVEL;
        src.connect(g);
        g.connect(master()?.getDestination?.() ?? ctx.destination);
        cloudSrc = src;
        src.onended = () => {
          if (cloudSrc === src) cloudSrc = null;
          sfx.duckForVoice(false);
        };
        sfx.duckForVoice(true); // sfx bus steps back while the NPC speaks
        src.start();
        return;
      }
    } catch {
      /* decode/context failure → element path below */
    }
    // No Web Audio available — element playback (fine on desktop). Mirrors the
    // master volume numerically since it can't route through the bus.
    try {
      stopCloudAudio();
      if (ttsSupported()) window.speechSynthesis.cancel();
      const a = new Audio(`data:audio/mpeg;base64,${b64}`);
      a.volume = Math.max(0, Math.min(1, SPEECH_LEVEL * masterVolume()));
      cloudAudioEl = a;
      a.addEventListener('ended', () => {
        if (cloudAudioEl === a) cloudAudioEl = null;
        sfx.duckForVoice(false);
      });
      sfx.duckForVoice(true);
      await a.play();
      return;
    } catch {
      /* autoplay/decode failure → browser voice below */
    }
  }
  if (gen === speakGen) speakLocal(text, rate, pitch, variant);
}

let cloudSrc: AudioBufferSourceNode | null = null;
let ownAudioCtx: AudioContext | null = null;

/** The game's shared (gesture-unlocked) AudioContext, else a lazily-created
 *  own one — same lookup Chat.ts uses for voice-clip playback. */
function cloudAudioCtx(): AudioContext | null {
  const am = (window as unknown as { audioManager?: { ensureCtx?: () => AudioContext } })
    .audioManager;
  if (am?.ensureCtx) {
    try {
      return am.ensureCtx();
    } catch {
      /* fall through */
    }
  }
  if (ownAudioCtx) return ownAudioCtx;
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  ownAudioCtx = new Ctor();
  return ownAudioCtx;
}

function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

// ── silence compression (pure — unit-tested in test/speech.test.ts) ──────────
// Find sample ranges to DELETE so that: leading silence ≤ edgeKeepS, trailing
// silence ≤ edgeKeepS, and every internal silence run ≥ minRunS is shortened
// to maxKeepS. "Silent" = windowed peak below `threshold` (windowed so the
// MP3 noise floor doesn't defeat a raw-sample test).
export function silenceCutRanges(
  mono: Float32Array,
  sampleRate: number,
  threshold = 0.012,
  minRunS = 0.45,
  maxKeepS = 0.3,
  edgeKeepS = 0.15,
): Array<[number, number]> {
  const win = Math.max(1, Math.floor(sampleRate * 0.02)); // 20ms windows
  const nWin = Math.ceil(mono.length / win);
  const silent = new Array<boolean>(nWin);
  for (let w = 0; w < nWin; w++) {
    let peak = 0;
    const end = Math.min(mono.length, (w + 1) * win);
    for (let i = w * win; i < end; i++) {
      const a = Math.abs(mono[i]);
      if (a > peak) peak = a;
    }
    silent[w] = peak < threshold;
  }
  const cuts: Array<[number, number]> = [];
  let runStart = -1;
  for (let w = 0; w <= nWin; w++) {
    const isSil = w < nWin && silent[w];
    if (isSil && runStart < 0) runStart = w;
    if (!isSil && runStart >= 0) {
      const s0 = runStart * win;
      const s1 = Math.min(mono.length, w * win);
      const runS = (s1 - s0) / sampleRate;
      const atStart = s0 === 0;
      const atEnd = s1 >= mono.length;
      const keepS = atStart || atEnd ? edgeKeepS : maxKeepS;
      const minS = atStart || atEnd ? keepS : minRunS;
      if (runS > minS) {
        // Keep `keepS` of the run (split around the kept beat for internal
        // runs; anchored for edges) and cut the rest.
        const keep = Math.floor(keepS * sampleRate);
        if (atStart) cuts.push([s0, s1 - keep]);
        else if (atEnd) cuts.push([s0 + keep, s1]);
        else cuts.push([s0 + keep, s1]);
      }
      runStart = -1;
    }
  }
  return cuts;
}

/** Rebuild an AudioBuffer with the silence cut-ranges removed. Returns the
 *  original buffer untouched when there is nothing worth cutting. */
function compressBufferSilences(ctx: AudioContext, buf: AudioBuffer): AudioBuffer {
  try {
    const mono = buf.getChannelData(0);
    const cuts = silenceCutRanges(mono, buf.sampleRate);
    if (!cuts.length) return buf;
    const removed = cuts.reduce((n, [a, b]) => n + (b - a), 0);
    const outLen = buf.length - removed;
    if (outLen <= 0 || removed < buf.sampleRate * 0.1) return buf;
    const out = ctx.createBuffer(buf.numberOfChannels, outLen, buf.sampleRate);
    for (let ch = 0; ch < buf.numberOfChannels; ch++) {
      const src = buf.getChannelData(ch);
      const dst = out.getChannelData(ch);
      let di = 0;
      let si = 0;
      for (const [a, b] of cuts) {
        dst.set(src.subarray(si, a), di);
        di += a - si;
        si = b;
      }
      dst.set(src.subarray(si), di);
    }
    return out;
  } catch {
    return buf; // never let trimming break playback
  }
}

function stopCloudAudio(): void {
  sfx.duckForVoice(false);
  if (cloudSrc) {
    try {
      cloudSrc.stop();
    } catch {
      /* ignore */
    }
    cloudSrc = null;
  }
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
  if (!enabled || masterMuted()) return;
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
  if (!enabled || masterMuted() || !ttsSupported()) return;
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
    // speechSynthesis can't route through the master bus — mirror its volume.
    u.volume = Math.max(0, Math.min(1, masterVolume()));
    // Duck the sfx bus for the utterance's duration (Chrome fires onend for
    // cancelled utterances too; cancelSpeech unducks belt-and-braces).
    u.onstart = () => sfx.duckForVoice(true);
    u.onend = () => sfx.duckForVoice(false);
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
