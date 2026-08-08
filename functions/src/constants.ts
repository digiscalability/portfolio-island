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
 *  credits/month and turbo v2.5 bills 0.5 credits/char, so 150k chars ≈ 57%
 *  of the plan — a hard denial-of-wallet stop that still leaves the owner
 *  headroom for other use. Cache hits don't count against it. */
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
