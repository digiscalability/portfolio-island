// plannerPrompt.ts — the day-planner's prompt and the validator for its reply.
// Pure (no firebase imports): npcPlanner.ts runs it every morning, the vitest
// suite pins it (test/promptBuilders.test.ts), and the evals harness (evals/)
// sends this exact prompt and passes real model replies through this exact
// validator.

/** The fixed pools the planner may choose from. npcPlanner.ts owns the lists;
 *  test/livingNpcs.test.ts pins them to the client. */
export interface PlannerPools {
  personas: readonly string[];
  activities: readonly string[];
  events: readonly string[];
}

/** The compact, truthful island state the planner reads: counts and the
 *  director's moods only, never visitor-authored text. */
export interface PlannerState {
  online: number;
  guestbookCount: number;
  racersTotal: number;
  recentMoods: readonly string[];
  prev: { activeDevices?: number; racePBsNew?: number } | null;
}

/** A validated plan: every value is one of the pools' own ids. */
export interface PlannerPlan {
  event: string;
  assignments: Record<string, string>;
}

export const PLANNER_SYSTEM =
  'You are the day-planner for "Portfolio Island", a small 3D world (the portfolio of Abbas, a solo founder). Each day you assign every townsperson a focus for the day and pick a day-theme, choosing ONLY from fixed lists. Match each persona to a fitting activity (e.g. the gardener tends flowers, the guard patrols, the musician plays). Vary it day to day. Reply with ONLY minified JSON, no prose.';

/** The user turn: the pools, today's state, and the JSON contract. */
export function plannerUserTurn(pools: PlannerPools, s: PlannerState): string {
  return (
    `Personas: ${pools.personas.join(', ')}\n` +
    `Activities (choose one per persona): ${pools.activities.join(', ')}\n` +
    `Events (choose one): ${pools.events.join(', ')}\n` +
    `Today: ${s.online} visitors online now, ${s.guestbookCount} guestbook notes total, ${s.racersTotal} race entries all-time, recent island moods: ${s.recentMoods.join(', ') || 'none'}.\n` +
    (s.prev
      ? `Yesterday: ${s.prev.activeDevices ?? 0} active visitors, ${s.prev.racePBsNew ?? 0} race PBs.\n`
      : '') +
    `Return JSON exactly: {"event":"<eventId>","assignments":{"<personaId>":"<activityId>", ...}}. Include every persona. Use only ids from the lists.`
  );
}

/**
 * Validate the model's reply against the pools. The first-to-last {...} span
 * is parsed as JSON (a malformed span throws; npcPlanner's catch logs it and
 * keeps the fallback plan). An unknown or missing event becomes
 * `fallbackEvent`, and only known-persona → known-activity pairs survive.
 * Returns null when the reply holds no JSON object at all. No model prose can
 * survive: every value in the result equals one of the pools' own ids.
 */
export function parsePlanReply(
  text: string,
  pools: PlannerPools,
  fallbackEvent: string,
): PlannerPlan | null {
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;
  const parsed = JSON.parse(jsonMatch[0]) as { event?: unknown; assignments?: Record<string, unknown> };
  const event = pools.events.includes(parsed.event as string) ? (parsed.event as string) : fallbackEvent;
  const assignments: Record<string, string> = {};
  if (parsed.assignments && typeof parsed.assignments === 'object') {
    for (const [id, act] of Object.entries(parsed.assignments)) {
      if (pools.personas.includes(id) && typeof act === 'string' && pools.activities.includes(act)) {
        assignments[id] = act;
      }
    }
  }
  return { event, assignments };
}
