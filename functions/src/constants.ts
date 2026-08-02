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

/** Monthly ElevenLabs TTS character budget (npcVoice). Creator plan = 100k
 *  credits/month and flash v2.5 bills 0.5 credits/char, so 150k chars ≈ 75k
 *  credits — a hard denial-of-wallet stop that still leaves the owner ~25% of
 *  the plan for other use. Cache hits don't count against it. */
export const TTS_MONTHLY_CHAR_CAP = 150_000;

/** Daily ElevenLabs sub-cap (~5% of the month): one bad day — organic spike or
 *  slow abuse — degrades to the browser voice instead of eating the month. */
export const TTS_DAILY_CHAR_CAP = 8_000;

/** npcVoice PAID synths allowed per IP per hour. Legitimate use is one synth
 *  per NPC reply and npcChat already caps replies at 8/min, so this is
 *  throughput only an abuser needs more of. */
export const TTS_IP_MAX_PER_WINDOW = 12;

/** npcVoice TOTAL calls (cache hits included) per IP per hour — bounds the
 *  RTDB-download/egress a cached-audio replay loop could drain. The real
 *  client calls npcVoice exactly once per reply, so this is ~15× headroom. */
export const TTS_FETCH_MAX_PER_WINDOW = 120;
