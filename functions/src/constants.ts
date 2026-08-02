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
