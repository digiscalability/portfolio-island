// agentSession.ts — server-gated access to the ElevenLabs reception agent.
//
// WHY THIS EXISTS. An ElevenLabs Agent widget connects the BROWSER DIRECTLY to
// ElevenLabs over WebRTC — unlike npcVoice, our server is not naturally in the
// path, so none of tts.ts's protections apply. A public agent_id is a bearer
// token anyone can paste into their own page and talk through on our bill. The
// fix is to make the agent PRIVATE (platform_settings.auth.enable_auth) so a
// connection requires a SIGNED URL, and to mint that URL here, behind the same
// layered gates the TTS path already proved out.
//
// This was written after the 2026-08-16 incident: an leaked API key was used to
// create 17 unauthorized voice clones and burn ~129,000 credits in a day, while
// Island's own capped TTS spend was ~1,900. The lesson was not "add caps to the
// island" — those worked — it was "every surface that can spend money needs
// them, including the ones you haven't opened yet." This file is that lesson
// applied BEFORE the surface opens rather than after.
//
// Defense layers (deliberately mirroring tts.ts, same order, same reasons):
//   1. App Check + auth — raises the bar past casual scripting.
//   2. agentFetch/{ip} — EVERY call counts, including ones that fail later, so
//      a mint-in-a-loop can't probe for free.
//   3. agentRate/{ip} — signed URLs per IP-hour. A real visitor needs one.
//   4. daily + monthly session caps, ACCOUNTED BEFORE RETURN (an un-awaited
//      write dies when Cloud Run freezes the instance post-response).
//   5. Client IP = the LAST X-Forwarded-For entry (appended by Google's front
//      end, unforgeable) — req.ip trusts the leftmost, attacker-supplied one.
//
// A signed URL is valid for 15 minutes and buys ONE conversation, itself capped
// agent-side (max_duration_seconds 300, silence_end_call_timeout 20s,
// daily_limit 50, concurrency 3, bursting off). Layers here bound how many
// sessions get minted; those bound what one session can cost.
//
// All RTDB nodes here (agentRate, agentFetch, agentUsage) are UNLISTED in the
// database rules => default-deny => Admin-SDK-only, and the janitor prunes them.

import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { defineSecret } from 'firebase-functions/params';
import * as admin from 'firebase-admin';
import { ipKey, nextIpWindow, lastForwardedIp } from './pure';
import {
  AGENT_MONTHLY_SESSION_CAP,
  AGENT_DAILY_SESSION_CAP,
  AGENT_IP_MAX_PER_WINDOW,
  AGENT_FETCH_MAX_PER_WINDOW,
  RECEPTION_AGENT_ID,
} from './constants';

const ELEVENLABS_API_KEY = defineSecret('ELEVENLABS_API_KEY');

const AGENT_IP_WINDOW_MS = 60 * 60 * 1000; // 1h window (mints + all calls)

export const agentSession = onCall(
  {
    region: 'us-central1',
    secrets: [ELEVENLABS_API_KEY],
    enforceAppCheck: true, // raises the bar; NOT the money gate
    maxInstances: 5,
    // Pin the money path's parallelism explicitly — same reasoning as npcVoice:
    // at <1 vCPU Cloud Run forces concurrency 1 today, but that is an implicit
    // memory->CPU mapping, and a future memory bump must not silently buy 80.
    concurrency: 1,
    timeoutSeconds: 20,
    memory: '256MiB',
  },
  async (request): Promise<{ url: string | null; reason?: string }> => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in first.');

    const db = admin.database();
    const now = Date.now();
    const ip = ipKey(
      lastForwardedIp(request.rawRequest.headers['x-forwarded-for'], request.rawRequest.ip),
    );

    // Layer 2: every call counts, even ones rejected below.
    const fetchTx = await db
      .ref(`agentFetch/${ip}`)
      .transaction((prev) =>
        nextIpWindow(prev as { c?: number; t?: number } | null, now, AGENT_IP_WINDOW_MS),
      )
      .catch(() => null);
    const fetchCount = (fetchTx?.snapshot?.val() as { c?: number } | null)?.c ?? 0;
    if (!fetchTx?.committed || fetchCount > AGENT_FETCH_MAX_PER_WINDOW) {
      return { url: null, reason: 'rate' };
    }

    // Layer 3: signed URLs minted per IP-hour.
    const rateTx = await db
      .ref(`agentRate/${ip}`)
      .transaction((prev) =>
        nextIpWindow(prev as { c?: number; t?: number } | null, now, AGENT_IP_WINDOW_MS),
      )
      .catch(() => null);
    const rateCount = (rateTx?.snapshot?.val() as { c?: number } | null)?.c ?? 0;
    if (!rateTx?.committed || rateCount > AGENT_IP_MAX_PER_WINDOW) {
      return { url: null, reason: 'rate' };
    }

    // Layer 4: daily + monthly session caps on the Melbourne calendar, matching
    // every other budget key in this codebase.
    const dayKey = new Date(now).toLocaleDateString('en-CA', { timeZone: 'Australia/Melbourne' });
    const monthKey = dayKey.slice(0, 7);
    const monthRef = db.ref(`agentUsage/${monthKey}`);
    const usage = (await monthRef.get()).val() as {
      sessions?: number;
      daily?: Record<string, { sessions?: number }>;
    } | null;
    const usedMonth = usage?.sessions ?? 0;
    const usedToday = usage?.daily?.[dayKey]?.sessions ?? 0;
    if (usedMonth >= AGENT_MONTHLY_SESSION_CAP || usedToday >= AGENT_DAILY_SESSION_CAP) {
      console.error('ALERT agentSession-cap-hit', { monthKey, usedMonth, usedToday });
      return { url: null, reason: 'cap' };
    }

    let signedUrl = '';
    try {
      const resp = await fetch(
        `https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(RECEPTION_AGENT_ID)}`,
        { headers: { 'xi-api-key': ELEVENLABS_API_KEY.value() } },
      );
      if (!resp.ok) {
        // 4xx = configuration (agent id wrong, auth not enabled): log WITHOUT
        // the ALERT prefix so a config gap can't page like an outage.
        // 429/5xx = systemic, and worth waking someone for.
        if (resp.status === 429 || resp.status >= 500) {
          console.error('ALERT agentSession-mint-failed', { status: resp.status });
        } else {
          console.warn('agentSession mint rejected', { status: resp.status });
        }
        return { url: null, reason: 'error' };
      }
      const body = (await resp.json()) as { signed_url?: string };
      signedUrl = typeof body.signed_url === 'string' ? body.signed_url : '';
      if (!signedUrl) return { url: null, reason: 'error' };
    } catch (err) {
      console.error('ALERT agentSession-mint-failed', { err: String(err) });
      return { url: null, reason: 'error' };
    }

    // Bill BEFORE returning. An un-awaited counter write is the textbook
    // casualty of Cloud Run freezing the instance after the response — and this
    // counter is the denial-of-wallet stop.
    await monthRef
      .transaction((v) => {
        const cur = (v ?? {}) as {
          sessions?: number;
          daily?: Record<string, { sessions?: number }>;
        };
        const daily = cur.daily ?? {};
        return {
          ...cur,
          sessions: (cur.sessions ?? 0) + 1,
          daily: {
            ...daily,
            [dayKey]: { sessions: (daily[dayKey]?.sessions ?? 0) + 1 },
          },
        };
      })
      .catch((e) => console.error('ALERT agentSession-accounting-failed', { msg: String(e) }));

    return { url: signedUrl };
  },
);
