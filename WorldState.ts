// WorldState.ts — the client half of the "living world".
//
// A backend "director" (functions/src/index.ts) evolves a small server-owned
// doc at world/island every few hours — a MOOD plus a PRE-AUTHORED HEADLINE —
// and writes it via the Admin SDK (the node is .write:false, so it can't be
// forged by a modified client). This module subscribes to that doc and surfaces
// it to the app, which reacts: a bulletin banner, a subtle ambience tint, and
// mood-flavoured NPC lines, so the island visibly "lives" between visits.
//
// It degrades to silence if Firebase is unavailable or the node is unset (e.g.
// before the director is deployed). A `?mood=` URL override previews any mood
// locally with no backend — used to verify the client reaction in dev.

export type Mood = 'festive' | 'busy' | 'calm' | 'mysterious' | 'proud';

/** The daily NPC plan the server planner writes to world/island/npcPlan. */
export interface NpcPlan {
  day: string;
  event?: string;
  assignments: Record<string, string>; // personaId → activityId (validated client-side)
  updatedAt?: number;
}

/** The day-theme events the planner may pick — the client-side enum whitelist
 *  AND the pre-authored display strings for the Island Times masthead. Must
 *  mirror EVENT_IDS in functions/src/npcPlanner.ts (parity-tested). */
export const EVENT_META: Record<string, { label: string; emoji: string }> = {
  quiet_day: { label: 'A quiet day', emoji: '🍃' },
  market_day: { label: 'Market day', emoji: '🛒' },
  music_day: { label: 'Music day', emoji: '🎵' },
  festival: { label: 'Festival day', emoji: '🎪' },
  mystery: { label: 'A mysterious day', emoji: '🌫️' },
  launch_day: { label: 'Launch day', emoji: '🚀' },
};

/** The nightly public notice the analyst writes to world/island/notice. */
export interface NoticeState {
  day: string;
  lines: number[]; // indices into the client's NOTICE_TEMPLATES
  counts: Record<string, number>; // numbers only
  updatedAt?: number;
}

export interface WorldState {
  mood: Mood;
  headline: string;
  weather?: string;
  online?: number;
  updatedAt?: number;
  npcPlan?: NpcPlan; // soft-optional — never gates the mood/headline beat
  notice?: NoticeState; // soft-optional — the Island Times board data
  noticeArchive?: Array<{ day: string; lines: number[]; visitors?: number }>; // past editions, newest first
}

/** Soft validation of the 14-day notice archive (same index-selection rules as
 *  the notice). Malformed entries dropped; newest first. */
function parseNoticeArchive(
  v: unknown,
): Array<{ day: string; lines: number[]; visitors?: number }> | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const out: Array<{ day: string; lines: number[]; visitors?: number }> = [];
  for (const e of Object.values(v as Record<string, unknown>)) {
    if (!e || typeof e !== 'object') continue;
    const n = e as { day?: unknown; lines?: unknown; visitors?: unknown };
    if (typeof n.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(n.day)) continue;
    const lines = Array.isArray(n.lines)
      ? n.lines
          .filter(
            (x): x is number => typeof x === 'number' && Number.isInteger(x) && x >= 0 && x < 64,
          )
          .slice(0, 6)
      : [];
    out.push({
      day: n.day,
      lines,
      visitors:
        typeof n.visitors === 'number' && Number.isFinite(n.visitors) ? n.visitors : undefined,
    });
  }
  if (!out.length) return undefined;
  out.sort((a, b) => (a.day < b.day ? 1 : -1));
  return out.slice(0, 14);
}

/** Soft validation of the public notice: integer line indices + numeric counts
 *  only (the composer + template bounds live client-side). Malformed → undefined. */
function parseNotice(v: unknown): NoticeState | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const n = v as { day?: unknown; lines?: unknown; counts?: unknown; updatedAt?: unknown };
  if (typeof n.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(n.day)) return undefined;
  const lines = Array.isArray(n.lines)
    ? n.lines
        .filter(
          (x): x is number => typeof x === 'number' && Number.isInteger(x) && x >= 0 && x < 64,
        )
        .slice(0, 6)
    : [];
  const counts: Record<string, number> = {};
  if (n.counts && typeof n.counts === 'object') {
    for (const [k, val] of Object.entries(n.counts as Record<string, unknown>)) {
      if (k.length <= 24 && typeof val === 'number' && Number.isFinite(val)) counts[k] = val;
    }
  }
  return {
    day: n.day,
    lines,
    counts,
    updatedAt: typeof n.updatedAt === 'number' ? n.updatedAt : undefined,
  };
}

/** Soft, field-by-field validation of the server npcPlan. Malformed → undefined
 *  (the beat still flows). Activity ids get a SECOND enum check in
 *  NpcActivities.setPlan, so unknown ids only ever fall back to defaults. */
function parseNpcPlan(v: unknown): NpcPlan | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const p = v as { day?: unknown; event?: unknown; assignments?: unknown; updatedAt?: unknown };
  if (typeof p.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(p.day)) return undefined;
  const assignments: Record<string, string> = {};
  if (p.assignments && typeof p.assignments === 'object') {
    for (const [id, act] of Object.entries(p.assignments as Record<string, unknown>)) {
      if (id.length <= 32 && typeof act === 'string' && act.length <= 32) assignments[id] = act;
    }
  }
  return {
    day: p.day,
    // Enum-checked, not just length-capped: `event` renders on the Island Times
    // masthead, so it gets the same both-sides validation as every other
    // index-selected field (unknown ids are dropped, never displayed).
    event:
      typeof p.event === 'string' && Object.prototype.hasOwnProperty.call(EVENT_META, p.event)
        ? p.event
        : undefined,
    assignments,
    updatedAt: typeof p.updatedAt === 'number' ? p.updatedAt : undefined,
  };
}

const MOODS: Mood[] = ['festive', 'busy', 'calm', 'mysterious', 'proud'];

/**
 * Client-side per-mood presentation: an accent colour (bulletin + ambience
 * tint), a dev-only fallback headline (the server headline wins in prod), and a
 * small pool of NPC "flavour" lines the dialogue can lead with so the town's
 * tone visibly shifts with the day. These flavour lines are pre-authored + safe
 * (this stays true even in later phases — an LLM may only index-select them).
 */
export const MOOD_META: Record<
  Mood,
  { label: string; accent: string; devHeadline: string; npcFlavor: string[] }
> = {
  festive: {
    label: 'Festive',
    accent: '#ffb457',
    devHeadline: 'The island is buzzing — someone just shipped something big.',
    npcFlavor: [
      "Grand day, isn't it?",
      'Everyone seems in high spirits today!',
      "There's a party mood in the air.",
    ],
  },
  busy: {
    label: 'Busy',
    accent: '#5aa9e6',
    devHeadline: 'Deliveries are flying — the couriers can barely keep up.',
    npcFlavor: [
      'Rushed off my feet today!',
      'So much to do, so little time.',
      'The whole island is hustling.',
    ],
  },
  calm: {
    label: 'Calm',
    accent: '#7fc9a3',
    devHeadline: 'A quiet, golden kind of day on the island.',
    npcFlavor: [
      'Lovely and peaceful today.',
      'Nothing beats a slow island afternoon.',
      'Just soaking up the quiet.',
    ],
  },
  mysterious: {
    label: 'Mysterious',
    accent: '#9b8cff',
    devHeadline: 'A strange fog rolled in overnight — the islanders are whispering.',
    npcFlavor: [
      'Something feels… off today.',
      'Did you see those lights by the shore?',
      "I can't shake a strange feeling.",
    ],
  },
  proud: {
    label: 'Proud',
    accent: '#e08fb0',
    devHeadline: 'Word is a new project just launched — the town is proud.',
    npcFlavor: [
      'Big things happening here lately!',
      "We're all a bit proud today.",
      'Something got finished — you can feel it.',
    ],
  },
};

function isMood(v: unknown): v is Mood {
  return typeof v === 'string' && (MOODS as string[]).includes(v);
}

let current: WorldState | null = null;

/** The live world state, or null if unknown. */
export function getWorldState(): WorldState | null {
  return current;
}

/** A random mood-flavoured NPC line for the current mood, or null if unset. */
export function moodNpcFlavor(): string | null {
  if (!current) return null;
  const pool = MOOD_META[current.mood].npcFlavor;
  return pool[Math.floor(Math.random() * pool.length)] ?? null;
}

/**
 * Subscribe to the living-world state. Calls `onUpdate` whenever the director
 * changes it (and once immediately for a dev override). Never throws.
 */
export function connectWorldState(onUpdate: (s: WorldState) => void): void {
  // Dev/preview override: ?mood=festive (optionally &headline=...). Skips the
  // backend entirely so any mood is previewable before the director is live.
  try {
    const params = new URLSearchParams(window.location.search);
    const override = params.get('mood');
    if (isMood(override)) {
      const s: WorldState = {
        mood: override,
        headline: params.get('headline') || MOOD_META[override].devHeadline,
        updatedAt: Date.now(),
      };
      current = s;
      onUpdate(s);
      return; // override wins; don't also subscribe
    }
  } catch {
    /* no window / bad URL — ignore */
  }

  // Live subscription to the server-owned node (dynamic import, same lazy
  // Firebase path as Multiplayer; costs nothing until it resolves).
  void (async () => {
    try {
      const [{ getFirebaseRealtime }, rtdb] = await Promise.all([
        import('./firebaseClient'),
        import('firebase/database'),
      ]);
      const { db } = await getFirebaseRealtime();
      const { ref, onValue } = rtdb;
      onValue(ref(db, 'world/island'), (snap) => {
        // Validate even though the node is server-owned: guards against a
        // malformed write and keeps free-text out of the render path.
        const v = snap.val() as Partial<WorldState> | null;
        if (!v || !isMood(v.mood) || typeof v.headline !== 'string') return;
        const s: WorldState = {
          mood: v.mood,
          headline: v.headline.slice(0, 160),
          weather: typeof v.weather === 'string' ? v.weather : undefined,
          online: typeof v.online === 'number' ? v.online : undefined,
          updatedAt: typeof v.updatedAt === 'number' ? v.updatedAt : undefined,
          npcPlan: parseNpcPlan((v as { npcPlan?: unknown }).npcPlan),
          notice: parseNotice((v as { notice?: unknown }).notice),
          noticeArchive: parseNoticeArchive((v as { noticeArchive?: unknown }).noticeArchive),
        };
        current = s;
        onUpdate(s);
      });
    } catch {
      /* offline / firebase unavailable — stay silent, world just has no beat */
    }
  })();
}
