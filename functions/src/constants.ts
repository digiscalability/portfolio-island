// constants.ts — the single source of truth for tunables shared across the
// island's functions. These were previously duplicated per-file (the 4M cap
// existed in three places), so tuning one copy silently desynced the others —
// the cap gate, the digest's "% of cap" line, and the planner/analyst guards
// must all agree.

/** Shared monthly Anthropic token budget across npcChat + planner + analyst. */
export const MONTHLY_TOKEN_CAP = 4_000_000;

/** npcChat per-IP calls allowed per rate window; the analyst's "burst-limit
 *  hits" metric counts IPs that exceeded this same threshold. */
export const IP_MAX_PER_WINDOW = 8;

/** Monthly ElevenLabs TTS character budget (npcVoice). The plan carries 131k
 *  credits/month; eleven_v3 bills 1 credit/char (2x turbo's 0.5), so 75k
 *  chars ≈ 57% of the plan — HALVED from the old 150k when the model moved
 *  turbo→v3 (2026-08-16) to hold the same $ ceiling; the cap is a char count,
 *  not a $ amount, so it does NOT self-adjust on a model swap — recompute it
 *  by hand any time TTS_MODEL or its credit rate changes. Cache hits don't
 *  count against it. */
export const TTS_MONTHLY_CHAR_CAP = 75_000;

/** Daily ElevenLabs sub-cap (~5% of the month): one bad day — organic spike or
 *  slow abuse — degrades to the browser voice instead of eating the month. */
export const TTS_DAILY_CHAR_CAP = 4_000;

/** npcVoice PAID synths allowed per IP per hour. Legitimate use is one synth
 *  per NPC reply and npcChat already caps replies at 8/min, so this is
 *  throughput only an abuser needs more of. */
export const TTS_IP_MAX_PER_WINDOW = 12;

/** npcVoice TOTAL calls (cache hits included) per IP per hour — bounds the
 *  RTDB-download/egress a cached-audio replay loop could drain. The real
 *  client calls npcVoice exactly once per reply, so this is ~15× headroom. */
export const TTS_FETCH_MAX_PER_WINDOW = 120;

// ── ElevenLabs reception agent (agentSession.ts) ────────────────────────────
// The agent is a SEPARATE billing bucket from TTS credits: Creator bundles a
// monthly allowance of agent MINUTES, and over-bundle minutes bill per minute.
// So these caps count SESSIONS, not characters. Each session is itself bounded
// agent-side (max_duration_seconds 300 = 5 min worst case), which is what makes
// a session count a meaningful proxy for spend.

/** The public-facing reception agent ("Abbas AI" for DigiScalability). */
export const RECEPTION_AGENT_ID = 'agent_7101k6t5qqfsemwsnnvkrewd1frw';

/** Monthly signed-URL mints. At the 5-minute agent-side ceiling this is a
 *  worst case of 300 × 5 = 1500 minutes, well past the plan bundle — so the
 *  DAILY cap below is the real stop and this is the backstop against a slow
 *  month-long drip. Revise once real per-session minute data exists. */
export const AGENT_MONTHLY_SESSION_CAP = 300;

/** Daily sessions. A portfolio reception desk getting more than 25 genuine
 *  calls in a day is a good problem worth being told about — the cap degrades
 *  to "unavailable" rather than silently spending. Mirrors TTS_DAILY_CHAR_CAP's
 *  intent: one bad day must not eat the month. */
export const AGENT_DAILY_SESSION_CAP = 25;

/** Signed URLs minted per IP-hour. A real visitor needs one; a couple more
 *  covers a refresh or a dropped connection. */
export const AGENT_IP_MAX_PER_WINDOW = 4;

/** TOTAL agentSession calls per IP-hour (rejected ones included) — bounds the
 *  probing a caller can do against the mint endpoint itself. */
export const AGENT_FETCH_MAX_PER_WINDOW = 30;

/**
 * The island's nine secret rumors — SYNC CONTRACT with the client's
 * Secrets.ts SECRETS[].rumor (same nine sentences, same order). NPCs share
 * the rumor-of-the-day WORD-FOR-WORD (authored lore the LLM flavors around
 * but never generates), and the client's Island Times prints the same one:
 * both sides pick RUMORS[rumorIndexForDay(melbourneDayKey)] so the paper and
 * the townsfolk always agree.
 */
export const RUMORS = [
  'They say the keeper tends a spark that has never once gone out.',
  'Something glints where the trail runs out of mountain.',
  'The Gardener hums to something hidden behind her walls.',
  'Farmhands swear the scarecrow wears a different smile at dusk.',
  'Listen close at the bandstand — the wind hums along.',
  'The Artist never shows anyone what is on the canvas.',
  'Old tales gather wherever the logs make a ring.',
  'Two grey fishers know the quietest stretch of shore.',
  'Every journey on this island is said to begin at the same door.',
] as const;

/** Deterministic rumor pick from a YYYY-MM-DD day key (char-code sum). Must
 *  match the client-side formula in Secrets.ts rumorOfTheDay. */
export function rumorIndexForDay(dayKey: string): number {
  let h = 0;
  for (let i = 0; i < dayKey.length; i++) h += dayKey.charCodeAt(i);
  return h % RUMORS.length;
}
