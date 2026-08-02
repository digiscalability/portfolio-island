/**
 * npcPlanner — the once-daily "brain" that assigns each NPC a day's focus.
 *
 * A single Claude Haiku call reads compact, truthful island state and returns
 * strict JSON that INDEX-SELECTS from fixed pools: a per-persona activity id, an
 * event id, and notice-line indices. Everything is validated against these pools
 * (unknown ids dropped) before it is written to world/island/npcPlan — never any
 * free prose to a world-visible node (the standing invariant). On ANY failure,
 * or if the monthly token cap is hit, a deterministic seededPick fallback still
 * writes a valid plan, so the world never stalls.
 *
 * The client (NpcActivities.ts) validates activity ids a second time against its
 * own ACTIVITY_DEFS and falls back to the default schedule for anything unknown,
 * so client + server pools drifting can only degrade to defaults, never break.
 */

import { onSchedule } from 'firebase-functions/v2/scheduler';
import { defineSecret } from 'firebase-functions/params';
import * as admin from 'firebase-admin';
import Anthropic from '@anthropic-ai/sdk';

const ANTHROPIC_API_KEY = defineSecret('ANTHROPIC_API_KEY');

const PLANNER_MONTHLY_TOKEN_CAP = 4_000_000; // shared budget guard (mirrors npcChat)
const STALE_PRESENCE_MS = 2 * 60 * 1000;

// Persona ids — must match PERSONAS keys (index.ts) + AI_NPCS (client NpcChat.ts).
const PERSONA_IDS = [
  'storyteller', 'elder_sage', 'guard', 'village_baker', 'island_explorer',
  'young_student', 'fisherman', 'artist', 'wanderer', 'gardener', 'architect',
  'musician', 'lighthouse_keeper', 'tourist', 'cartographer', 'philosopher',
  'courier', 'night_watch',
] as const;

// Activity ids — must match the client's ActivityId union (NpcActivities.ts).
const ACTIVITY_IDS = [
  'tend_flowers', 'patrol', 'mail_round', 'play_music', 'lamp_round',
  'paint_vista', 'keep_light', 'shore_gaze', 'market_visit', 'bench_rest',
  'stroll', 'sleep', 'plaza_gather', 'study', 'muse',
] as const;
type ActivityId = (typeof ACTIVITY_IDS)[number];
const ACTIVITY_SET = new Set<string>(ACTIVITY_IDS);

// Event ids — the day's flavour (shown on the Island Times board; can bias tone).
const EVENT_IDS = ['quiet_day', 'market_day', 'music_day', 'festival', 'mystery', 'launch_day'] as const;
type EventId = (typeof EVENT_IDS)[number];

// mulberry32 deterministic pick (mirrors index.ts).
function seededPick<T>(arr: readonly T[], seed: number): T {
  let t = (seed + 0x6d2b79f5) >>> 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const r = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return arr[Math.floor(r * arr.length)];
}

async function countLivePresence(db: admin.database.Database, now: number): Promise<number> {
  const val = (await db.ref('presence/island').get()).val() as Record<string, { t?: number }> | null;
  if (!val) return 0;
  let live = 0;
  for (const e of Object.values(val)) if (now - (typeof e?.t === 'number' ? e.t : 0) <= STALE_PRESENCE_MS) live++;
  return live;
}

// Deterministic, always-valid plan (the fallback + the LLM's safety net).
function fallbackPlan(seed: number): { event: EventId; assignments: Record<string, ActivityId> } {
  const event = seededPick(EVENT_IDS, seed);
  const assignments: Record<string, ActivityId> = {};
  // Leave assignments empty by default → the client uses each NPC's own default
  // schedule (already persona-correct). The fallback only sets the event.
  return { event, assignments };
}

export const planner = onSchedule(
  {
    schedule: '0 6 * * *', // 6am daily
    timeZone: 'Australia/Melbourne',
    region: 'us-central1',
    secrets: [ANTHROPIC_API_KEY],
    timeoutSeconds: 60,
    memory: '256MiB',
  },
  async () => {
    const db = admin.database();
    const now = Date.now();
    const day = new Date(now).toLocaleDateString('en-CA', { timeZone: 'Australia/Melbourne' }); // YYYY-MM-DD
    const month = day.slice(0, 7);
    const seed = Math.floor(now / (24 * 60 * 60 * 1000));

    // Compact, truthful state for the prompt.
    const [online, gbSnap, histSnap, tokSnap] = await Promise.all([
      countLivePresence(db, now),
      db.ref('guestbook/island').get(),
      db.ref('worldHistory/island').orderByKey().limitToLast(8).get(),
      db.ref(`aiUsage/${month}/tokens`).get(),
    ]);
    const guestbookCount = Object.keys((gbSnap.val() as object) ?? {}).length;
    const recentMoods = Object.values((histSnap.val() as Record<string, { mood?: string }>) ?? {})
      .map((b) => b.mood)
      .filter(Boolean);
    const usedTokens = (tokSnap.val() as number | null) ?? 0;

    let plan = fallbackPlan(seed);
    let usedNow = 0;
    let source: 'llm' | 'fallback' = 'fallback';

    if (usedTokens < PLANNER_MONTHLY_TOKEN_CAP) {
      try {
        const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY.value() });
        const sys =
          'You are the day-planner for "Portfolio Island", a small 3D world (the portfolio of Abbas, a solo founder). Each day you assign every townsperson a focus for the day and pick a day-theme, choosing ONLY from fixed lists. Match each persona to a fitting activity (e.g. the gardener tends flowers, the guard patrols, the musician plays). Vary it day to day. Reply with ONLY minified JSON, no prose.';
        const user =
          `Personas: ${PERSONA_IDS.join(', ')}\n` +
          `Activities (choose one per persona): ${ACTIVITY_IDS.join(', ')}\n` +
          `Events (choose one): ${EVENT_IDS.join(', ')}\n` +
          `Today: ${online} visitors online now, ${guestbookCount} guestbook notes total, recent island moods: ${recentMoods.join(', ') || 'none'}.\n` +
          `Return JSON exactly: {"event":"<eventId>","assignments":{"<personaId>":"<activityId>", ...}}. Include every persona. Use only ids from the lists.`;
        const resp = await anthropic.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 400,
          system: sys,
          messages: [{ role: 'user', content: user }],
        });
        usedNow = (resp.usage?.input_tokens ?? 0) + (resp.usage?.output_tokens ?? 0);
        const block = resp.content.find((b) => b.type === 'text');
        const text = block && 'text' in block ? block.text : '';
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]) as { event?: unknown; assignments?: Record<string, unknown> };
          const event = (EVENT_IDS as readonly string[]).includes(parsed.event as string)
            ? (parsed.event as EventId)
            : plan.event;
          const assignments: Record<string, ActivityId> = {};
          if (parsed.assignments && typeof parsed.assignments === 'object') {
            for (const [id, act] of Object.entries(parsed.assignments)) {
              if ((PERSONA_IDS as readonly string[]).includes(id) && typeof act === 'string' && ACTIVITY_SET.has(act)) {
                assignments[id] = act as ActivityId;
              }
            }
          }
          if (Object.keys(assignments).length) {
            plan = { event, assignments };
            source = 'llm';
          } else {
            plan = { event, assignments: {} }; // event only; NPCs keep defaults
          }
        }
      } catch (err) {
        const e = err as { status?: number; message?: string };
        console.error('ALERT planner-llm-failed', { status: e.status, msg: e.message });
        // plan stays the deterministic fallback
      }
    }

    // Write the plan (scoped subpath; safe now that director uses .update()).
    await db.ref('world/island/npcPlan').set({ day, event: plan.event, assignments: plan.assignments, updatedAt: now });

    // Account tokens (best-effort) into the shared monthly + daily buckets.
    if (usedNow) {
      await db.ref(`aiUsage/${month}/tokens`).transaction((c) => (c || 0) + usedNow);
      await db.ref(`aiUsage/${month}/calls`).transaction((c) => (c || 0) + 1);
      await db.ref(`aiUsage/${month}/daily/${day}/tokens`).transaction((c) => (c || 0) + usedNow);
      await db.ref(`aiUsage/${month}/daily/${day}/calls`).transaction((c) => (c || 0) + 1);
    }
    console.log(`planner(${source}) event=${plan.event} assigned=${Object.keys(plan.assignments).length} tokens=${usedNow}`);
  },
);
