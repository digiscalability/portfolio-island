// tts.ts — ElevenLabs cloud voice for NPC chat replies (the costed upgrade the
// Speech.ts header always anticipated). Same server-proxy + spend-cap shape as
// the NPC brain: the key lives in Secret Manager, the client can only voice
// text the SERVER just wrote (npcChat drops each scrubbed reply into
// ttsQueue/{id} and hands the id back), and every call sits behind layered
// limits. Synthesized audio is cached in RTDB by (voice, text) hash, so
// replays and the repeating canned openings cost exactly once. Any failure
// returns fallback:true and the client degrades to the free on-device
// SpeechSynthesis voice — the NPC never goes silent because a quota ran out.
//
// Defense layers (each one hardened after an adversarial review):
//   1. ttsFetch/{ip}: EVERY call (even cache hits) counts — caps the RTDB
//      download + egress a cached-audio loop could otherwise drain.
//   2. one-shot id claim: a reply id buys at most ONE paid synth, atomically —
//      parallel duplicates of the same id can't multi-bill.
//   3. ttsRate/{ip}: paid synths per hour.
//   4. daily + monthly character caps, ACCOUNTED BEFORE RETURN (un-awaited
//      writes die when Cloud Run freezes the instance post-response).
//   5. Client IP = the LAST X-Forwarded-For entry (appended by Google's front
//      end, unforgeable) — req.ip trusts the leftmost, attacker-supplied one.
//
// DEPLOY NOTE: defineSecret runs at module load for the whole codebase — the
// ELEVENLABS_API_KEY secret must EXIST in Secret Manager before ANY functions
// deploy succeeds (same gotcha as GITHUB_TOKEN):
//   firebase functions:secrets:set ELEVENLABS_API_KEY --account digiscalability@gmail.com
//
// All RTDB nodes here (ttsQueue, ttsCache, ttsCacheAt, ttsRate, ttsFetch,
// ttsUsage) are UNLISTED in the database rules ⇒ default-deny ⇒
// Admin-SDK-only. The janitor prunes them (ttsCache via the ttsCacheAt index
// so it never downloads the audio blobs).

import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { defineSecret } from 'firebase-functions/params';
import * as admin from 'firebase-admin';
import { createHash } from 'node:crypto';
import { ipKey, nextIpWindow, lastForwardedIp } from './pure';
import {
  TTS_MONTHLY_CHAR_CAP,
  TTS_DAILY_CHAR_CAP,
  TTS_IP_MAX_PER_WINDOW,
  TTS_FETCH_MAX_PER_WINDOW,
} from './constants';

const ELEVENLABS_API_KEY = defineSecret('ELEVENLABS_API_KEY');

const TTS_IP_WINDOW_MS = 60 * 60 * 1000; // 1h window (paid synths + all fetches)
export const TTS_QUEUE_TTL_MS = 15 * 60 * 1000; // reply ids are short-lived
export const TTS_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // audio cache retention
// Turbo v2.5 — the researched end-state for one-shot short dialogue. The
// docs are explicit that eleven_v3 (alpha) is "not suitable for real-time or
// conversational use cases": on <250-char prompts it produces exactly the
// variable pacing / weird gaps the owner reported (measured: 1.0s dead air
// mid-line in a real prod render). Turbo is the sanctioned quality/latency
// middle ground at 0.5 credits/char — and it was never actually heard at
// full bitrate (its earlier stint shipped at the launch 32kbps setting).
const TTS_MODEL = 'eleven_turbo_v2_5';
// style MUST stay 0 for chat — style exaggeration reintroduces instability
// (per the docs); expressiveness comes from the voice cast, not the knob.
const TTS_VOICE_SETTINGS = {
  stability: 0.5,
  similarity_boost: 0.75,
  style: 0,
  use_speaker_boost: true,
};
// Bump when the model/settings/bitrate change so stale cached renders
// re-synthesize (the cache key would otherwise keep serving old audio).
const TTS_RENDER_VERSION = 'v4';
// Full-quality audio: the launch 22kHz/32kbps setting was voicemail-grade and
// read as "robotic" regardless of model. ~16KB/s; a reply is 100-250KB.
const TTS_OUTPUT = 'mp3_44100_128';
const TTS_MAX_CHARS = 500; // replies are 1-2 short sentences; hard ceiling

// personaId → ElevenLabs voice id, VERIFIED against this account's
// GET /v1/voices on 2026-08-03 (the classic premades — Rachel, Arnold, Josh,
// Clyde… — are "legacy" and absent from newer accounts; the original cast had
// 9 of them). A missing voice fails that synth → fallback:true → browser
// voice; nothing breaks (and 4xx logs WITHOUT the ALERT prefix so a config
// gap can't page like an outage).
const VOICES: Record<string, string> = {
  storyteller: 'EXAVITQu4vr4xnSDxMaL', // Sarah — mature narrator (the abbas_test1 clone
  // was tried here and pulled: the clone's SOURCE audio limits it, not the model)
  elder_sage: 'JBFqnCBsd6RMkjVDRZzb', // George — warm, captivating storyteller
  guard: 'SOYHLrjzK2X1ezoPC6cr', // Harry — fierce warrior (good-humoured watchman)
  village_baker: 'XrExE9yKIg1WjnnlVkGX', // Matilda — knowledgeable, friendly
  island_explorer: 'TX3LPaxmHKxFdv7VOQHJ', // Liam — energetic
  young_student: 'cgSgspJ2msm6clMCkdW9', // Jessica — playful, bright
  fisherman: 'onwK4e9ZLuTAKqWW03F9', // Daniel — steady, calm
  artist: 'FGY2WhTYpPnrIDTdsKH5', // Laura — quirky enthusiast
  wanderer: 'N2lVS1w4EtoT3dr4eOWO', // Callum — husky trickster
  gardener: 'pFZP5JQG7iQjIQuC4Bku', // Lily — velvety, gentle
  architect: 'nPczCjzI2devNBz1zQrb', // Brian — deep, measured
  musician: 'IKne3meq5aSn9XLyUdCD', // Charlie — deep, confident, energetic
  lighthouse_keeper: 'pqHfZKP75CvOlQylNhV4', // Bill — wise, mature
  tourist: 'hpp4J3VqNfWAUOO0d1Us', // Bella — bright, warm, delighted
  cartographer: 'Xb7hH8MSUJpSbSDYk0k2', // Alice — clear, precise
  philosopher: 'SAz9YHcvj6GT2YYXdXww', // River — relaxed, musing
  courier: 'iP95p4xoKVk53GoZ742B', // Chris — charming, down-to-earth
  night_watch: 'CwhRBWXzGAHq8TQ4Fs17', // Roger — laid-back, resonant
  sailor: 'pNInz6obpgDQGcFmaJgB', // Adam — dominant, firm (a captain's bark)
  mayor: 'cjVigY5qzO86Huf0OWal', // Eric — smooth, trustworthy (a politician's polish)
  farmer: '56AoDkrOh6qfVPDXZ7Pt', // Cassidy — plain-spoken, warm
  // Economy P2 — premade library picks (no clones):
  carpenter: 'pqHfZKP75CvOlQylNhV4', // Bill — trustworthy older craftsman
  teller: 'cjVigY5qzO86Huf0OWal', // Eric — smooth, professional counter voice
};
const DEFAULT_VOICE = 'JBFqnCBsd6RMkjVDRZzb'; // George — verified present

// Server-side twin of the client's sanitizeForSpeech PLUS prosody
// normalization: the voice reads words, not *stage directions*, markdown, or
// emoji — and not the LLM's pause-punctuation either. Em/en-dashes and
// ellipses are DOCUMENTED pause operators in ElevenLabs models ("punctuation
// stops"), and Claude-style replies are full of both; commas and full stops
// carry the same meaning without the dead air.
/* eslint-disable no-misleading-character-class */
const EMOJI_RE =
  /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}]/gu;
/* eslint-enable no-misleading-character-class */
function speakable(text: string): string {
  const t = text
    .replace(/\*[^*]*\*/g, ' ') // *stage directions* are silent
    .replace(/\[[^\]]*\]/g, ' ') // bracketed text gets spoken on v2 models
    .replace(/[_~`*#]/g, ' ')
    .replace(EMOJI_RE, ' ')
    .replace(/…|\.{3,}/g, '.') // ellipsis = heavy hesitant stop → period
    .replace(/\s*[–—]+\s*/g, ', ') // em/en-dash = audible beat stop → comma
    .replace(/\s+--+\s+/g, ', ') // stacked ASCII dashes = longer stop
    .replace(/([!?.,;:])\1+/g, '$1') // !!!, ??, ",," → single
    .replace(/\s+([,.!?;:])/g, '$1')
    .replace(/,\s*([.!?])/g, '$1') // ",." artifacts from the rewrites
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, TTS_MAX_CHARS);
  // Unterminated text causes trailing artifacts — always end on a full stop.
  return t && !/[.!?]$/.test(t) ? `${t}.` : t;
}

export const npcVoice = onCall(
  {
    region: 'us-central1',
    secrets: [ELEVENLABS_API_KEY],
    enforceAppCheck: true, // raises the bar (headless-browser token mint); NOT the money gate
    maxInstances: 5,
    // Pin the money path's parallelism explicitly: at <1 vCPU Cloud Run forces
    // concurrency 1 TODAY, but that's an implicit memory→CPU mapping — a
    // future innocuous memory bump must not silently buy concurrency 80.
    concurrency: 1,
    timeoutSeconds: 30,
    memory: '256MiB',
  },
  async (request): Promise<{ audio: string | null; fallback: boolean; reason?: string }> => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in first.');

    // The ONLY accepted input is an opaque reply id npcChat minted — never free
    // text. That closes the "synthesize arbitrary text through my key" hole.
    const data = (request.data ?? {}) as { id?: unknown };
    const id = typeof data.id === 'string' ? data.id : '';
    if (!/^[A-Za-z0-9_-]{8,24}$/.test(id)) throw new HttpsError('invalid-argument', 'Bad id.');

    const db = admin.database();
    const now = Date.now();

    // Layer 1: EVERY call counts — a cached-audio replay loop is "free" of
    // ElevenLabs cost but not of RTDB download + egress. Atomic (transaction),
    // and keyed on the unforgeable last-XFF client IP.
    const ip = ipKey(
      lastForwardedIp(request.rawRequest.headers['x-forwarded-for'], request.rawRequest.ip),
    );
    const fetchTx = await db
      .ref(`ttsFetch/${ip}`)
      .transaction((prev) =>
        nextIpWindow(prev as { c?: number; t?: number } | null, now, TTS_IP_WINDOW_MS),
      )
      .catch(() => null);
    const fetchCount = (fetchTx?.snapshot?.val() as { c?: number } | null)?.c ?? 0;
    if (!fetchTx?.committed || fetchCount > TTS_FETCH_MAX_PER_WINDOW) {
      return { audio: null, fallback: true, reason: 'rate' };
    }

    const q = (await db.ref(`ttsQueue/${id}`).get()).val() as {
      x?: string;
      p?: string;
      t?: number;
      s?: number;
    } | null;
    if (!q || typeof q.x !== 'string' || typeof q.t !== 'number' || now - q.t > TTS_QUEUE_TTL_MS) {
      return { audio: null, fallback: true, reason: 'expired' };
    }
    const text = speakable(q.x);
    if (!text) return { audio: null, fallback: true, reason: 'empty' };
    const voice = VOICES[q.p ?? ''] ?? DEFAULT_VOICE;

    // Cache: replays and repeated lines skip the PAID gates below (they're
    // still counted by layer 1 above).
    const key = createHash('sha1').update(`${TTS_RENDER_VERSION}|${voice}|${text}`).digest('hex');
    const cacheRef = db.ref(`ttsCache/${key}`);
    const hit = (await cacheRef.get()).val() as { a?: string } | null;
    if (hit?.a) return { audio: hit.a, fallback: false };

    // Layer 2: claim the id — one reply id buys at most ONE paid synth, even
    // under a parallel burst (transaction aborts for every caller but the first).
    const claim = await db
      .ref(`ttsQueue/${id}/s`)
      .transaction((v) => (v ? undefined : now))
      .catch(() => null);
    if (!claim?.committed) return { audio: null, fallback: true, reason: 'used' };

    // Layer 3: paid synths per IP-hour.
    const rateTx = await db
      .ref(`ttsRate/${ip}`)
      .transaction((prev) =>
        nextIpWindow(prev as { c?: number; t?: number } | null, now, TTS_IP_WINDOW_MS),
      )
      .catch(() => null);
    const rateCount = (rateTx?.snapshot?.val() as { c?: number } | null)?.c ?? 0;
    if (!rateTx?.committed || rateCount > TTS_IP_MAX_PER_WINDOW) {
      return { audio: null, fallback: true, reason: 'rate' };
    }

    // Layer 4: daily + monthly character caps (Melbourne calendar, matching
    // the Anthropic budget). One read covers both counters.
    const dayKey = new Date(now).toLocaleDateString('en-CA', { timeZone: 'Australia/Melbourne' });
    const monthKey = dayKey.slice(0, 7);
    const monthRef = db.ref(`ttsUsage/${monthKey}`);
    const usage = (await monthRef.get()).val() as {
      chars?: number;
      daily?: Record<string, { chars?: number }>;
    } | null;
    const usedMonth = usage?.chars ?? 0;
    const usedToday = usage?.daily?.[dayKey]?.chars ?? 0;
    if (usedMonth >= TTS_MONTHLY_CHAR_CAP || usedToday >= TTS_DAILY_CHAR_CAP) {
      console.error('ALERT npcVoice-cap-hit', { monthKey, usedMonth, usedToday });
      return { audio: null, fallback: true, reason: 'cap' };
    }

    let audioB64 = '';
    try {
      const resp = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=${TTS_OUTPUT}`,
        {
          method: 'POST',
          headers: {
            'xi-api-key': ELEVENLABS_API_KEY.value(),
            'content-type': 'application/json',
          },
          body: JSON.stringify({ text, model_id: TTS_MODEL, voice_settings: TTS_VOICE_SETTINGS }),
        },
      );
      if (!resp.ok) {
        // 4xx = configuration (missing voice id, bad request): log WITHOUT the
        // ALERT prefix so it can't page like an outage. 429/5xx = systemic.
        if (resp.status === 429 || resp.status >= 500) {
          console.error('ALERT npcVoice-tts-failed', { status: resp.status });
        } else {
          console.warn('npcVoice synth rejected', { status: resp.status, voice });
        }
        return { audio: null, fallback: true, reason: 'error' };
      }
      audioB64 = Buffer.from(await resp.arrayBuffer()).toString('base64');
    } catch (err) {
      console.error('ALERT npcVoice-tts-failed', { err: String(err) });
      return { audio: null, fallback: true, reason: 'error' };
    }

    // Bill + cache BEFORE returning — un-awaited writes are the textbook
    // casualty of Cloud Run freezing the instance after the response, and this
    // counter is the denial-of-wallet stop. One transaction covers month,
    // day, and call counters atomically; ttsCacheAt mirrors the timestamp so
    // the janitor can prune the cache without downloading audio blobs.
    await Promise.all([
      monthRef.transaction((v) => {
        const cur = (v ?? {}) as {
          chars?: number;
          calls?: number;
          daily?: Record<string, { chars?: number }>;
        };
        const daily = cur.daily ?? {};
        return {
          ...cur,
          chars: (cur.chars ?? 0) + text.length,
          calls: (cur.calls ?? 0) + 1,
          daily: { ...daily, [dayKey]: { chars: (daily[dayKey]?.chars ?? 0) + text.length } },
        };
      }),
      cacheRef.set({ a: audioB64, t: now }),
      db.ref(`ttsCacheAt/${key}`).set(now),
    ]).catch((e) => console.error('ALERT npcVoice-accounting-failed', { msg: String(e) }));
    return { audio: audioB64, fallback: false };
  },
);
