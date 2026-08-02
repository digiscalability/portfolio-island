// NpcActivities.ts — the client "brain" for persona-driven NPC activities.
//
// Pure data + trig: per-persona daily SCHEDULES map (hour + mood) → an activity;
// each activity resolves to a surface ANCHOR to walk to + a POSE preset. The
// GameScene wander loop calls getGoal() only on the idle→walk transition (a few
// times per NPC per minute — effectively free), then drives the existing
// great-circle walk + cached-terrain grounding to that anchor. No THREE beyond
// Vector3; module-level scratch vectors ⇒ zero per-frame allocations.
//
// A once-daily server "planner" may override the day's assignment per NPC by
// setPlan() — but ONLY by picking activity ids from this file's ACTIVITY_DEFS
// (index-selection invariant); unknown ids fall back to the default schedule.

import * as THREE from 'three';
import { DISTRICTS, ZONE_LAT, dirFor } from './Districts';
import type { Mood } from './WorldState';

// ── Activities + poses ───────────────────────────────────────────────────────

export type PoseId = 'walk' | 'kneel' | 'inspect' | 'play' | 'paint' | 'sit' | 'sleep' | 'watch';

export type ActivityId =
  | 'tend_flowers' | 'patrol' | 'mail_round' | 'play_music' | 'lamp_round'
  | 'paint_vista' | 'keep_light' | 'shore_gaze' | 'market_visit'
  | 'bench_rest' | 'stroll' | 'sleep' | 'plaza_gather' | 'study' | 'muse';

type AnchorSource =
  | 'flowers' | 'lamps' | 'mailboxes' | 'stalls' | 'benches'
  | 'lighthouse' | 'plaza' | 'boulevard' | 'vista' | 'home';

export interface ActivityDef {
  /** Full pre-authored line for the Island Times board ("tending the flower beds"). */
  label: string;
  /** Short badge text for the floating pin; undefined ⇒ show the role instead. */
  short?: string;
  emoji: string;
  pose: PoseId;
  anchorSource: AnchorSource;
  dwell: [number, number]; // seconds [min, max] spent at the anchor
}

// The ONLY activities that exist. This table is the client's enum whitelist for
// validating server plans, and the source of every world-visible label.
export const ACTIVITY_DEFS: Record<ActivityId, ActivityDef> = {
  tend_flowers: { label: 'tending the flower beds', short: 'tending', emoji: '🌷', pose: 'kneel', anchorSource: 'flowers', dwell: [18, 34] },
  patrol:       { label: 'on patrol along the boulevard', short: 'on patrol', emoji: '🛡️', pose: 'watch', anchorSource: 'boulevard', dwell: [5, 9] },
  mail_round:   { label: 'running the mail round', short: 'mail run', emoji: '✉️', pose: 'inspect', anchorSource: 'mailboxes', dwell: [4, 8] },
  play_music:   { label: 'playing a tune in the plaza', short: 'playing', emoji: '🎵', pose: 'play', anchorSource: 'plaza', dwell: [50, 90] },
  lamp_round:   { label: 'checking the lamps for the night', short: 'checking lamps', emoji: '🔦', pose: 'watch', anchorSource: 'lamps', dwell: [7, 13] },
  paint_vista:  { label: 'painting the coastal view', short: 'painting', emoji: '🎨', pose: 'paint', anchorSource: 'vista', dwell: [40, 80] },
  keep_light:   { label: 'keeping the lighthouse', short: 'on watch', emoji: '🗼', pose: 'watch', anchorSource: 'lighthouse', dwell: [30, 60] },
  shore_gaze:   { label: 'watching the tide roll in', short: 'gazing out', emoji: '🌊', pose: 'watch', anchorSource: 'vista', dwell: [25, 40] },
  market_visit: { label: 'browsing the market stalls', short: 'at market', emoji: '🛒', pose: 'inspect', anchorSource: 'stalls', dwell: [12, 22] },
  bench_rest:   { label: 'resting on a bench', short: 'resting', emoji: '🪑', pose: 'sit', anchorSource: 'benches', dwell: [20, 40] },
  stroll:       { label: 'out for a stroll', emoji: '🚶', pose: 'walk', anchorSource: 'home', dwell: [4, 9] },
  sleep:        { label: 'fast asleep', short: 'asleep', emoji: '💤', pose: 'sleep', anchorSource: 'home', dwell: [60, 120] },
  plaza_gather: { label: 'joining the gathering in the plaza', short: 'gathering', emoji: '🎉', pose: 'watch', anchorSource: 'plaza', dwell: [30, 60] },
  study:        { label: 'studying how the world is built', short: 'studying', emoji: '📚', pose: 'inspect', anchorSource: 'home', dwell: [20, 40] },
  muse:         { label: 'lost in thought', short: 'thinking', emoji: '🤔', pose: 'sit', anchorSource: 'home', dwell: [25, 45] },
};

// Poses are whole-group modulation of the existing bob/roll/lift channels
// (npc.glb is unrigged/clipless — no skeletal animation). Applied while idle.
export const POSE_PRESETS: Record<PoseId, { bobAmp: number; bobFreq: number; rollAmp: number; lift: number }> = {
  walk:    { bobAmp: 0.015, bobFreq: 2.0, rollAmp: 0.0, lift: 0.0 },
  kneel:   { bobAmp: 0.006, bobFreq: 1.1, rollAmp: 0.0, lift: -0.14 },
  inspect: { bobAmp: 0.02, bobFreq: 2.6, rollAmp: 0.05, lift: 0.0 },
  play:    { bobAmp: 0.05, bobFreq: 4.4, rollAmp: 0.14, lift: 0.0 },
  paint:   { bobAmp: 0.012, bobFreq: 1.6, rollAmp: 0.03, lift: 0.0 },
  sit:     { bobAmp: 0.008, bobFreq: 1.2, rollAmp: 0.0, lift: -0.16 },
  sleep:   { bobAmp: 0.004, bobFreq: 0.7, rollAmp: 0.0, lift: -0.18 },
  watch:   { bobAmp: 0.014, bobFreq: 1.4, rollAmp: 0.05, lift: 0.0 },
};

// ── Schedules ────────────────────────────────────────────────────────────────
// Hour bands (0–24; use to > 24 to wrap past midnight). `moods` swaps the
// activity when the island is in that mood. Personas absent here use GENERIC.

interface ScheduleRow { from: number; to: number; activity: ActivityId; moods?: Partial<Record<Mood, ActivityId>> }

const GENERIC: ScheduleRow[] = [
  { from: 6, to: 10, activity: 'stroll', moods: { festive: 'plaza_gather' } },
  { from: 10, to: 14, activity: 'market_visit', moods: { festive: 'plaza_gather' } },
  { from: 14, to: 18, activity: 'stroll', moods: { mysterious: 'shore_gaze', festive: 'plaza_gather' } },
  { from: 18, to: 22, activity: 'bench_rest', moods: { festive: 'plaza_gather' } },
  { from: 22, to: 30, activity: 'sleep' }, // 22:00 → 06:00
];

const DEFAULT_SCHEDULES: Record<string /* personaId */, ScheduleRow[]> = {
  // Heroes (deep routines)
  gardener: [
    { from: 5, to: 7, activity: 'stroll' },
    { from: 7, to: 17, activity: 'tend_flowers' },
    { from: 17, to: 21, activity: 'bench_rest' },
    { from: 21, to: 29, activity: 'sleep' },
  ],
  guard: [
    { from: 6, to: 20, activity: 'patrol' },
    { from: 20, to: 30, activity: 'sleep' },
  ],
  courier: [
    { from: 8, to: 18, activity: 'mail_round' },
    { from: 18, to: 22, activity: 'bench_rest' },
    { from: 22, to: 32, activity: 'sleep' },
  ],
  musician: [
    { from: 10, to: 21, activity: 'play_music', moods: { calm: 'stroll' } },
    { from: 21, to: 34, activity: 'sleep' },
  ],
  night_watch: [
    { from: 20, to: 30, activity: 'lamp_round' }, // 20:00 → 06:00
    { from: 6, to: 20, activity: 'sleep' },
  ],
  artist: [
    { from: 9, to: 18, activity: 'paint_vista' },
    { from: 18, to: 22, activity: 'stroll' },
    { from: 22, to: 33, activity: 'sleep' },
  ],
  lighthouse_keeper: [
    { from: 7, to: 13, activity: 'keep_light' },
    { from: 13, to: 15, activity: 'shore_gaze' },
    { from: 15, to: 31, activity: 'keep_light' }, // stays by the light day + night
  ],
  // fisherman: handled by its own state machine (skipped in the wander loop)
  // Flavor routines for the rest (all others fall to GENERIC)
  elder_sage: [
    { from: 7, to: 12, activity: 'muse' },
    { from: 12, to: 18, activity: 'stroll' },
    { from: 18, to: 22, activity: 'bench_rest' },
    { from: 22, to: 31, activity: 'sleep' },
  ],
  young_student: [
    { from: 8, to: 16, activity: 'study' },
    { from: 16, to: 20, activity: 'stroll' },
    { from: 20, to: 32, activity: 'sleep' },
  ],
  philosopher: [
    { from: 8, to: 20, activity: 'muse' },
    { from: 20, to: 32, activity: 'sleep' },
  ],
  village_baker: [ // (Baker has a bespoke machine too, but keep a schedule as a safety net)
    { from: 6, to: 16, activity: 'market_visit' },
    { from: 16, to: 22, activity: 'bench_rest' },
    { from: 22, to: 30, activity: 'sleep' },
  ],
};

// ── Anchors (populated once by GameScene after island build) ─────────────────

interface AnchorSet {
  flowers: THREE.Vector3[];
  lamps: THREE.Vector3[];
  mailboxes: THREE.Vector3[];
  stalls: THREE.Vector3[];
  benches: THREE.Vector3[];
  lighthouse: THREE.Vector3[]; // orbit ring around the tower
  plaza: THREE.Vector3[]; // the 5 district plazas
  vista: THREE.Vector3[]; // coastal viewpoints
}
let ANCHORS: AnchorSet | null = null;

const SHORE_Y = Math.sin(0.3); // matches GameScene shoreline clamp

function clampShore(d: THREE.Vector3): void {
  if (d.y < SHORE_Y) {
    d.y = SHORE_Y + 0.02;
    d.normalize();
  }
}
function toDir(v: THREE.Vector3): THREE.Vector3 {
  const d = v.clone().normalize();
  clampShore(d);
  return d;
}

// Small ring of dirs around a centre dir (for the lighthouse orbit).
function ringAround(centre: THREE.Vector3, arc: number, n: number): THREE.Vector3[] {
  const out: THREE.Vector3[] = [];
  const up = Math.abs(centre.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  const east = new THREE.Vector3().crossVectors(centre, up).normalize();
  const north = new THREE.Vector3().crossVectors(centre, east).normalize();
  for (let k = 0; k < n; k++) {
    const a = (k / n) * Math.PI * 2;
    const d = centre.clone()
      .addScaledVector(east, Math.cos(a) * arc)
      .addScaledVector(north, Math.sin(a) * arc)
      .normalize();
    clampShore(d);
    out.push(d);
  }
  return out;
}

export function setAnchors(a: {
  flowers: THREE.Vector3[];
  lamps: THREE.Vector3[];
  mailboxes: THREE.Vector3[];
  stalls: THREE.Vector3[];
  benches: THREE.Vector3[];
  lighthouseDir: THREE.Vector3 | null;
  vistas: THREE.Vector3[];
}): void {
  ANCHORS = {
    flowers: a.flowers.map(toDir),
    lamps: a.lamps.map(toDir),
    mailboxes: a.mailboxes.map(toDir),
    stalls: a.stalls.map(toDir),
    benches: a.benches.map(toDir),
    lighthouse: a.lighthouseDir ? ringAround(a.lighthouseDir.clone().normalize(), 0.05, 4) : [],
    plaza: DISTRICTS.map((d) => dirFor(d.lon, d.lat)),
    vista: a.vistas.map(toDir),
  };
}

// ── Plan (server override, Phase 2) ──────────────────────────────────────────

let CURRENT_PLAN: { assignments: Record<string, ActivityId> } | null = null;

/** Accept a server plan; keep only assignments whose activity id is known. */
export function setPlan(plan: unknown): void {
  const p = plan as { assignments?: Record<string, unknown> } | null;
  if (!p || typeof p !== 'object' || !p.assignments) {
    CURRENT_PLAN = null;
    return;
  }
  const clean: Record<string, ActivityId> = {};
  for (const [id, act] of Object.entries(p.assignments)) {
    if (typeof act === 'string' && (act as ActivityId) in ACTIVITY_DEFS) clean[id] = act as ActivityId;
  }
  CURRENT_PLAN = Object.keys(clean).length ? { assignments: clean } : null;
}

/** Dev override: ?plan=gardener:tend_flowers,guard:patrol — previews assignments. */
export function applyPlanOverrideFromUrl(): void {
  try {
    const raw = new URLSearchParams(window.location.search).get('plan');
    if (!raw) return;
    const assignments: Record<string, string> = {};
    for (const pair of raw.split(',')) {
      const [id, act] = pair.split(':');
      if (id && act) assignments[id.trim()] = act.trim();
    }
    setPlan({ assignments });
  } catch {
    /* ignore */
  }
}

// ── Goal resolver ────────────────────────────────────────────────────────────

export interface Goal {
  activity: ActivityId;
  pose: PoseId;
  dwellMin: number;
  dwellMax: number;
}

// Minimal shape the resolver needs from the NPC's wander state.
interface GoalState {
  home: THREE.Vector3;
  rot: number; // rotation index through an anchor list (advanced here)
}

const _ja = new THREE.Vector3();
const _jb = new THREE.Vector3();

function jitterDir(home: THREE.Vector3, arc: number, out: THREE.Vector3): void {
  _ja.set(0, 1, 0);
  if (Math.abs(home.y) > 0.9) _ja.set(1, 0, 0);
  _jb.crossVectors(home, _ja).normalize(); // east tangent
  _ja.crossVectors(home, _jb).normalize(); // north tangent
  const ang = Math.random() * Math.PI * 2;
  out.copy(home)
    .addScaledVector(_jb, Math.cos(ang) * arc)
    .addScaledVector(_ja, Math.sin(ang) * arc)
    .normalize();
  clampShore(out);
}

function matchRow(sched: ScheduleRow[], hour: number): ScheduleRow | null {
  for (const r of sched) {
    if ((hour >= r.from && hour < r.to) || (hour + 24 >= r.from && hour + 24 < r.to)) return r;
  }
  return null;
}

// Pick the anchor for an activity, writing a unit dir into outDir. Returns false
// if no anchor is available (caller then falls back to a home stroll).
function pickAnchor(source: AnchorSource, s: GoalState, outDir: THREE.Vector3): boolean {
  if (source === 'home') {
    jitterDir(s.home, 0.06, outDir);
    return true;
  }
  if (source === 'boulevard') {
    // Rotate through the 5 plaza lons at ZONE_LAT — a street-following patrol.
    const lons = DISTRICTS.map((d) => d.lon);
    const lon = lons[s.rot % lons.length];
    s.rot += 1;
    outDir.copy(dirFor(lon, ZONE_LAT));
    clampShore(outDir);
    return true;
  }
  if (!ANCHORS) return false;
  const list = ANCHORS[source as keyof AnchorSet] as THREE.Vector3[] | undefined;
  if (!list || !list.length) return false;
  outDir.copy(list[s.rot % list.length]);
  s.rot += 1;
  return true;
}

/**
 * Resolve the NPC's next goal. Returns null for NPCs with no schedule (the two
 * Market Vendors) so they keep the plain random wander. Writes the next waypoint
 * dir into `outDir`.
 */
export function getGoal(
  personaId: string | null,
  hour: number,
  _dayFactor: number,
  mood: Mood | undefined,
  s: GoalState,
  outDir: THREE.Vector3,
): Goal | null {
  if (!personaId) return null; // e.g. Market Vendor → default wander
  const sched = DEFAULT_SCHEDULES[personaId] ?? GENERIC;
  const row = matchRow(sched, hour);
  let activity: ActivityId = row ? row.activity : 'stroll';
  if (row?.moods && mood && row.moods[mood]) activity = row.moods[mood]!;

  // Daily server plan overrides the day-time activity (never the sleep window).
  const planned = CURRENT_PLAN?.assignments?.[personaId];
  if (planned && planned in ACTIVITY_DEFS && activity !== 'sleep') activity = planned;

  const def = ACTIVITY_DEFS[activity];
  if (!pickAnchor(def.anchorSource, s, outDir)) {
    jitterDir(s.home, 0.06, outDir); // graceful fallback if anchors missing
  }
  return { activity, pose: def.pose, dwellMin: def.dwell[0], dwellMax: def.dwell[1] };
}
