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

import { DISTRICTS, RING_DISTRICT_LONS, ZONE_LAT, dirFor } from './Districts';
import { WORLD_RADIUS } from './WorldScale';
import type { Mood } from './WorldState';

/**
 * Metres of surface distance -> geodesic angle. Same contract as Island.arc(),
 * but this module is function-level with no island instance, so it reads the
 * world radius directly. Never write a bare radian here — every anchor spacing
 * below is a real distance a villager walks.
 */
function arc(metres: number): number {
  return metres / WORLD_RADIUS;
}

/**
 * How far OUT of a plaza centre an NPC stands.
 *
 * Each district seats its landmark building at the plaza centre with a
 * 1.7-radius collider, and the wander loop keeps NPCs 2.0u clear of it. 2.75u
 * is comfortably outside the wall and still on the plaza apron rather than out
 * on the grass — bounded on BOTH sides, which is why it must stay a real
 * distance rather than an angle that grows with the world.
 */
const PLAZA_APRON = arc(2.75);

/**
 * The welcome-plaza apron as world-ish dirs — the fallback stage if the
 * bandstand could not be placed, so play_music always has somewhere legal.
 */
export function plazaFallback(): THREE.Vector3[] {
  return [
    dirFor(0.9, Math.PI / 2 - arc(4.5))
      .clone()
      .multiplyScalar(WORLD_RADIUS),
  ];
}

// ── Activities + poses ───────────────────────────────────────────────────────

export type PoseId = 'walk' | 'kneel' | 'inspect' | 'play' | 'paint' | 'sit' | 'sleep' | 'watch';

export type ActivityId =
  | 'tend_flowers'
  | 'tend_crops'
  | 'patrol'
  | 'mail_round'
  | 'play_music'
  | 'lamp_round'
  | 'paint_vista'
  | 'keep_light'
  | 'shore_gaze'
  | 'market_visit'
  | 'bench_rest'
  | 'stroll'
  | 'sleep'
  | 'plaza_gather'
  | 'study'
  | 'muse';

type AnchorSource =
  | 'flowers'
  | 'crops'
  | 'bandstand'
  | 'easel'
  | 'lamps'
  | 'mailboxes'
  | 'stalls'
  | 'benches'
  | 'lighthouse'
  | 'plaza'
  | 'boulevard'
  | 'vista'
  | 'home'
  | 'door';

export interface ActivityDef {
  /** Full pre-authored line for the Island Times board ("tending the flower beds"). */
  label: string;
  /** Short badge text for the floating pin; undefined ⇒ show the role instead. */
  short?: string;
  emoji: string;
  pose: PoseId;
  anchorSource: AnchorSource;
  dwell: [number, number]; // seconds [min, max] spent at the anchor
  /** Idle facing at the anchor: 'sea' looks seaward (away from the pole),
   *  'center' looks at the anchor set's centre (the lighthouse). Unset ⇒ keep
   *  the arrival yaw. Player proximity always overrides (the greet turn wins). */
  face?: 'sea' | 'center';
}

// The ONLY activities that exist. This table is the client's enum whitelist for
// validating server plans, and the source of every world-visible label.
export const ACTIVITY_DEFS: Record<ActivityId, ActivityDef> = {
  tend_flowers: {
    label: 'tending the flower beds',
    short: 'tending',
    emoji: '🌷',
    pose: 'kneel',
    anchorSource: 'flowers',
    dwell: [18, 34],
  },
  tend_crops: {
    label: 'working the crop rows',
    short: 'farming',
    emoji: '🌾',
    pose: 'kneel',
    anchorSource: 'crops',
    dwell: [20, 36],
  },
  patrol: {
    label: 'on patrol along the boulevard',
    short: 'on patrol',
    emoji: '🛡️',
    pose: 'watch',
    anchorSource: 'boulevard',
    dwell: [5, 9],
  },
  mail_round: {
    label: 'running the mail round',
    short: 'mail run',
    emoji: '✉️',
    pose: 'inspect',
    anchorSource: 'mailboxes',
    dwell: [4, 8],
  },
  play_music: {
    label: 'playing a tune in the plaza',
    short: 'playing',
    emoji: '🎵',
    pose: 'play',
    anchorSource: 'bandstand',
    dwell: [50, 90],
  },
  lamp_round: {
    label: 'checking the lamps for the night',
    short: 'checking lamps',
    emoji: '🔦',
    pose: 'watch',
    anchorSource: 'lamps',
    dwell: [7, 13],
  },
  paint_vista: {
    label: 'painting the coastal view',
    short: 'painting',
    emoji: '🎨',
    pose: 'paint',
    anchorSource: 'easel',
    dwell: [40, 80],
    face: 'sea',
  },
  keep_light: {
    label: 'keeping the lighthouse',
    short: 'on watch',
    emoji: '🗼',
    pose: 'watch',
    anchorSource: 'lighthouse',
    dwell: [30, 60],
    face: 'center',
  },
  shore_gaze: {
    label: 'watching the tide roll in',
    short: 'gazing out',
    emoji: '🌊',
    pose: 'watch',
    anchorSource: 'vista',
    dwell: [25, 40],
    face: 'sea',
  },
  market_visit: {
    label: 'browsing the market stalls',
    short: 'at market',
    emoji: '🛒',
    pose: 'inspect',
    anchorSource: 'stalls',
    dwell: [12, 22],
  },
  bench_rest: {
    label: 'resting on a bench',
    short: 'resting',
    emoji: '🪑',
    pose: 'sit',
    anchorSource: 'benches',
    dwell: [20, 40],
  },
  stroll: {
    label: 'out for a stroll',
    emoji: '🚶',
    pose: 'walk',
    anchorSource: 'home',
    dwell: [4, 9],
  },
  sleep: {
    label: 'fast asleep',
    short: 'asleep',
    emoji: '💤',
    pose: 'sleep',
    anchorSource: 'door', // walk to the nearest cottage door, then step "inside"
    dwell: [60, 120],
  },
  plaza_gather: {
    label: 'joining the gathering in the plaza',
    short: 'gathering',
    emoji: '🎉',
    pose: 'watch',
    anchorSource: 'plaza',
    dwell: [30, 60],
  },
  study: {
    label: 'studying how the world is built',
    short: 'studying',
    emoji: '📚',
    pose: 'inspect',
    anchorSource: 'home',
    dwell: [20, 40],
  },
  muse: {
    label: 'lost in thought',
    short: 'thinking',
    emoji: '🤔',
    pose: 'sit',
    anchorSource: 'home',
    dwell: [25, 45],
  },
};

// Poses are whole-group modulation of the existing bob/roll/lift channels
// (npc.glb is unrigged/clipless — no skeletal animation). Applied while idle.
export const POSE_PRESETS: Record<
  PoseId,
  { bobAmp: number; bobFreq: number; rollAmp: number; lift: number }
> = {
  walk: { bobAmp: 0.015, bobFreq: 2.0, rollAmp: 0.0, lift: 0.0 },
  kneel: { bobAmp: 0.006, bobFreq: 1.1, rollAmp: 0.0, lift: -0.14 },
  inspect: { bobAmp: 0.02, bobFreq: 2.6, rollAmp: 0.05, lift: 0.0 },
  play: { bobAmp: 0.05, bobFreq: 4.4, rollAmp: 0.14, lift: 0.0 },
  paint: { bobAmp: 0.012, bobFreq: 1.6, rollAmp: 0.03, lift: 0.0 },
  sit: { bobAmp: 0.008, bobFreq: 1.2, rollAmp: 0.0, lift: -0.16 },
  sleep: { bobAmp: 0.004, bobFreq: 0.7, rollAmp: 0.0, lift: -0.18 },
  watch: { bobAmp: 0.014, bobFreq: 1.4, rollAmp: 0.05, lift: 0.0 },
};

// ── Schedules ────────────────────────────────────────────────────────────────
// Hour bands (0–24; use to > 24 to wrap past midnight). `moods` swaps the
// activity when the island is in that mood. Personas absent here use GENERIC.

interface ScheduleRow {
  from: number;
  to: number;
  activity: ActivityId;
  moods?: Partial<Record<Mood, ActivityId>>;
}

const GENERIC: ScheduleRow[] = [
  { from: 6, to: 10, activity: 'stroll', moods: { festive: 'plaza_gather' } },
  { from: 10, to: 14, activity: 'market_visit', moods: { festive: 'plaza_gather' } },
  {
    from: 14,
    to: 18,
    activity: 'stroll',
    moods: { mysterious: 'shore_gaze', festive: 'plaza_gather' },
  },
  { from: 18, to: 22, activity: 'bench_rest', moods: { festive: 'plaza_gather' } },
  { from: 22, to: 30, activity: 'sleep' }, // 22:00 → 06:00
];

const DEFAULT_SCHEDULES: Record<string /* personaId */, ScheduleRow[]> = {
  // Heroes (deep routines)
  gardener: [
    { from: 6, to: 7, activity: 'stroll' },
    { from: 7, to: 17, activity: 'tend_flowers' },
    { from: 17, to: 21, activity: 'bench_rest' },
    { from: 21, to: 30, activity: 'sleep' },
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
    { from: 10, to: 20, activity: 'play_music', moods: { calm: 'stroll' } },
    { from: 20, to: 21, activity: 'bench_rest' },
    { from: 21, to: 34, activity: 'sleep' },
  ],
  night_watch: [
    { from: 20, to: 30, activity: 'lamp_round' }, // 20:00 → 06:00
    { from: 6, to: 20, activity: 'sleep' },
  ],
  // The Sailor never enters the wander loop (GameScene anchors him to his
  // boat, Fisherman-style) — this schedule only labels his badge/Island Times.
  sailor: [
    { from: 6, to: 20, activity: 'shore_gaze' },
    { from: 20, to: 30, activity: 'sleep' },
  ],
  mayor: [
    { from: 8, to: 12, activity: 'plaza_gather' },
    { from: 12, to: 14, activity: 'stroll', moods: { festive: 'plaza_gather' } },
    { from: 14, to: 18, activity: 'plaza_gather' },
    { from: 18, to: 21, activity: 'bench_rest' },
    { from: 21, to: 32, activity: 'sleep' },
  ],
  farmer: [
    { from: 5, to: 6, activity: 'stroll' },
    { from: 6, to: 12, activity: 'tend_crops' },
    { from: 12, to: 13, activity: 'bench_rest' },
    { from: 13, to: 18, activity: 'tend_crops' },
    { from: 18, to: 20, activity: 'stroll' },
    { from: 20, to: 29, activity: 'sleep' },
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
  village_baker: [
    // (Baker has a bespoke machine too, but keep a schedule as a safety net)
    { from: 6, to: 16, activity: 'market_visit' },
    { from: 16, to: 22, activity: 'bench_rest' },
    { from: 22, to: 30, activity: 'sleep' },
  ],
};

// ── Anchors (populated once by GameScene after island build) ─────────────────

interface AnchorSet {
  flowers: THREE.Vector3[];
  crops: THREE.Vector3[]; // the Farmer's furrows — his own land, not hers
  bandstand: THREE.Vector3[]; // the Musician's stage
  easel: THREE.Vector3[]; // the Artist's easel
  lamps: THREE.Vector3[];
  mailboxes: THREE.Vector3[];
  stalls: THREE.Vector3[];
  benches: THREE.Vector3[];
  lighthouse: THREE.Vector3[]; // orbit ring around the tower
  plaza: THREE.Vector3[]; // the 5 district plazas
  vista: THREE.Vector3[]; // coastal viewpoints
  doors: THREE.Vector3[]; // cottage doorsteps — sleep walks here, then hides
}
let ANCHORS: AnchorSet | null = null;
// The lighthouse tower's unit dir — the look-at target for face:'center'.
let LIGHTHOUSE_CENTRE: THREE.Vector3 | null = null;
// personaId → door index: balanced sleeping arrangements, computed once by the
// scene at setup (it knows every NPC's home AND all the doors).
let DOOR_ASSIGNMENTS: Record<string, number> = {};

/** Install the scene's balanced persona→door map for the sleep walk. */
export function setDoorAssignments(map: Record<string, number>): void {
  DOOR_ASSIGNMENTS = map;
}

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
    const d = centre
      .clone()
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
  crops: THREE.Vector3[];
  bandstand: THREE.Vector3[];
  easel: THREE.Vector3[];
  lamps: THREE.Vector3[];
  mailboxes: THREE.Vector3[];
  stalls: THREE.Vector3[];
  benches: THREE.Vector3[];
  lighthouseDir: THREE.Vector3 | null;
  vistas: THREE.Vector3[];
  doors?: THREE.Vector3[];
}): void {
  ANCHORS = {
    flowers: a.flowers.map(toDir),
    crops: a.crops.map(toDir),
    // Fall back to the old anchor if a station failed to place, so a missing
    // prop degrades to the previous behaviour instead of a stuck NPC.
    bandstand: (a.bandstand.length ? a.bandstand : []).map(toDir),
    easel: (a.easel.length ? a.easel : []).map(toDir),
    lamps: a.lamps.map(toDir),
    mailboxes: a.mailboxes.map(toDir),
    stalls: a.stalls.map(toDir),
    benches: a.benches.map(toDir),
    // 3.75u: the old 2.5u ring EQUALLED the plinth base radius, so all four
    // keeper waypoints sat ON the rock wall. Must stay a real distance —
    // as an angle it would have re-created that bug at a smaller radius and
    // walked the keeper off the headland at a larger one.
    lighthouse: a.lighthouseDir
      ? ringAround(a.lighthouseDir.clone().normalize(), arc(3.75), 4)
      : [],
    // EVERY plaza anchor is the APRON in front of the hall, never the hall.
    // Each district seats its landmark building at exactly dirFor(d.lon,
    // d.lat) with a 1.7-radius collider (2.0u NPC keep-out), so the raw
    // centre is unreachable: the musician and the gatherers walked into the
    // wall and stayed there, stride playing, for the whole 50-90s dwell.
    // Only 'welcome' had been nudged; the four ring plazas had not.
    plaza: DISTRICTS.map((d) =>
      d.id === 'welcome' ? dirFor(0.9, Math.PI / 2 - 0.09) : dirFor(d.lon, d.lat - PLAZA_APRON),
    ),
    vista: a.vistas.map(toDir),
    doors: (a.doors ?? []).map(toDir),
  };
  LIGHTHOUSE_CENTRE = a.lighthouseDir ? a.lighthouseDir.clone().normalize() : null;
}

const _fv = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

/**
 * Resolve a Goal's `face` hint into a world direction at `posDir` (the anchor
 * the NPC stands on), written into `out` (tangent-plane projection happens in
 * the caller against the live surface normal). Returns false when undefined
 * (degenerate at the pole / no lighthouse) — caller keeps the arrival yaw.
 */
export function computeFaceDir(
  face: 'sea' | 'center',
  posDir: THREE.Vector3,
  out: THREE.Vector3,
): boolean {
  if (face === 'sea') {
    // Seaward = due "south" on this pole-centred island: the tangent component
    // of −ŷ at posDir, i.e. straight away from the pole, toward the shoreline.
    out.copy(posDir).multiplyScalar(posDir.dot(UP)).sub(UP);
    return out.lengthSq() > 1e-6 ? (out.normalize(), true) : false;
  }
  if (!LIGHTHOUSE_CENTRE) return false;
  _fv.copy(LIGHTHOUSE_CENTRE).sub(posDir); // chord toward the tower
  out.copy(_fv).addScaledVector(posDir, -_fv.dot(posDir)); // tangent projection
  return out.lengthSq() > 1e-6 ? (out.normalize(), true) : false;
}

// ── Plan (server override, Phase 2) ──────────────────────────────────────────

let CURRENT_PLAN: { assignments: Record<string, ActivityId> } | null = null;

const PLAN_MAX_AGE_MS = 48 * 60 * 60 * 1000;

/** Accept a server plan; keep only assignments whose activity id is known.
 *  A stale plan (updatedAt older than ~48h — the planner stopped running) is
 *  DROPPED so NPCs fall back to their persona-correct default schedules, per
 *  the "defaults on failure" design. Plans without updatedAt (the ?plan= dev
 *  override) skip the staleness gate. */
export function setPlan(plan: unknown): void {
  const p = plan as { assignments?: Record<string, unknown>; updatedAt?: unknown } | null;
  if (!p || typeof p !== 'object' || !p.assignments) {
    CURRENT_PLAN = null;
    return;
  }
  if (typeof p.updatedAt === 'number' && Date.now() - p.updatedAt > PLAN_MAX_AGE_MS) {
    CURRENT_PLAN = null;
    return;
  }
  const clean: Record<string, ActivityId> = {};
  for (const [id, act] of Object.entries(p.assignments)) {
    // hasOwnProperty, not `in`: `in` walks the prototype chain, so ids like
    // 'constructor' would "validate" and wedge the NPC on an undefined def.
    if (typeof act === 'string' && Object.prototype.hasOwnProperty.call(ACTIVITY_DEFS, act)) {
      clean[id] = act as ActivityId;
    }
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
  /** Idle facing hint at the anchor (resolve via computeFaceDir). */
  face?: 'sea' | 'center';
}

// Minimal shape the resolver needs from the NPC's wander state.
interface GoalState {
  home: THREE.Vector3;
  rot: number; // rotation index through an anchor list (advanced here)
}

// Patrol waypoints: the 4 ring-plaza lons + the midpoint between each adjacent
// pair, in ring order (hoisted — pickAnchor used to allocate this per pick).
// The plaza legs step OUT to the apron by PLAZA_APRON for the same reason the
// plaza anchors do: dirFor(districtLon, ZONE_LAT) IS the zone hall's seat, so
// half of the guard's eight waypoints were the insides of four buildings.
// Midpoints keep ZONE_LAT — the street between plazas is clear.
const BOULEVARD_WAYPOINTS: Array<[number, number]> = RING_DISTRICT_LONS.flatMap((lon, i) => {
  const next = RING_DISTRICT_LONS[(i + 1) % RING_DISTRICT_LONS.length];
  const half = lon + ((next - lon + Math.PI * 2) % (Math.PI * 2) || Math.PI * 2) / 2;
  return [
    [lon, ZONE_LAT - PLAZA_APRON],
    [half, ZONE_LAT],
  ] as Array<[number, number]>;
});

const _ja = new THREE.Vector3();
const _jb = new THREE.Vector3();

function jitterDir(home: THREE.Vector3, arc: number, out: THREE.Vector3): void {
  _ja.set(0, 1, 0);
  if (Math.abs(home.y) > 0.9) _ja.set(1, 0, 0);
  _jb.crossVectors(home, _ja).normalize(); // east tangent
  _ja.crossVectors(home, _jb).normalize(); // north tangent
  const ang = Math.random() * Math.PI * 2;
  out
    .copy(home)
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
function pickAnchor(
  source: AnchorSource,
  s: GoalState,
  outDir: THREE.Vector3,
  personaId?: string | null,
): boolean {
  if (source === 'home') {
    jitterDir(s.home, arc(3), outDir);
    return true;
  }
  if (source === 'door') {
    // Sleep: walk to this persona's ASSIGNED cottage door (balanced by the
    // scene at setup so the town doesn't pile behind one popular cottage);
    // personas without an assignment fall back to the nearest door. Stable per
    // NPC either way — sleep re-picks its goal every dwell, and a shifting
    // door would have them shuffling between houses all night.
    const doors = ANCHORS?.doors;
    if (!doors || !doors.length) return false; // → home-jitter fallback
    const assigned = personaId != null ? DOOR_ASSIGNMENTS[personaId] : undefined;
    if (assigned !== undefined && doors[assigned]) {
      outDir.copy(doors[assigned]);
      return true;
    }
    let best = doors[0];
    let bestAngle = Infinity;
    for (const d of doors) {
      const a = d.angleTo(s.home);
      if (a < bestAngle) {
        bestAngle = a;
        best = d;
      }
    }
    outDir.copy(best);
    return true;
  }
  if (source === 'boulevard') {
    // Rotate through the ring plazas PLUS a midpoint between each pair, all at
    // ZONE_LAT — 8 short legs that hug the boulevard parallel instead of the
    // 90° great-circle chords (which peaked well inland of the street). The
    // pole hub is excluded: its lon 0 duplicated the Professional plaza, so the
    // old list visited that plaza twice per loop.
    const wp = BOULEVARD_WAYPOINTS[s.rot % BOULEVARD_WAYPOINTS.length];
    s.rot += 1;
    outDir.copy(dirFor(wp[0], wp[1]));
    clampShore(outDir);
    return true;
  }
  if (!ANCHORS) return false;
  const list = ANCHORS[source as keyof AnchorSet] as THREE.Vector3[] | undefined;
  if (!list || !list.length) return false;
  outDir.copy(list[s.rot % list.length]);
  s.rot += 1;
  // Shared-anchor separation: two NPCs whose rotation seeds collide mod the
  // list length land on the SAME anchor and used to stand coincident — the
  // "villagers clustering" read. A ~1u jitter spreads same-anchor visitors
  // like people at a counter. STALLS ONLY: every other anchor set (aprons,
  // bandstand, easel, lighthouse ring) is precision-placed against collider
  // walls, and jittering those re-opens the anchor-inside-a-wall bug class.
  if (source === 'stalls') jitterDir(outDir, arc(1.0), outDir);
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
  _dayFactor: number, // reserved — hour is the sole gate while hour↔daylight stay coupled
  mood: Mood | undefined,
  s: GoalState,
  outDir: THREE.Vector3,
): Goal | null {
  if (!personaId) return null; // e.g. Market Vendor → default wander
  const sched = DEFAULT_SCHEDULES[personaId] ?? GENERIC;
  const row = matchRow(sched, hour);
  let activity: ActivityId = row ? row.activity : 'stroll';
  if (row?.moods && mood && row.moods[mood]) activity = row.moods[mood]!;

  // Daily server plan overrides the DAY-TIME activity only (hour-gated to
  // 06:00–20:00, so the evening wind-down bands — bench_rest/stroll after
  // 20:00 — can't be re-tasked back into day work) — and never INTO or OUT
  // of sleep: the schedule's sleep window always wins, and a planned 'sleep'
  // can't flatten the town at midday (setPlan validated ids via hasOwnProperty,
  // so the extra guard here is belt-and-braces).
  const planned = CURRENT_PLAN?.assignments?.[personaId];
  if (
    planned &&
    planned !== 'sleep' &&
    Object.prototype.hasOwnProperty.call(ACTIVITY_DEFS, planned) &&
    activity !== 'sleep' &&
    hour >= 6 &&
    hour < 20
  ) {
    activity = planned;
  }

  const def = ACTIVITY_DEFS[activity];
  // Evening bench_rest rests NEAR HOME: pick the bench closest to the NPC's
  // home instead of rotating the island-wide bench list, so nobody hikes
  // across the dark island to sit down at 21:00. Per-goal only (a few calls
  // per NPC per minute) and allocation-free — mirrors the nearest-door loop.
  let anchored = false;
  if (activity === 'bench_rest' && (hour >= 20 || hour < 6)) {
    const benches = ANCHORS?.benches;
    if (benches && benches.length) {
      let best = benches[0];
      let bestAngle = Infinity;
      for (const b of benches) {
        const a = b.angleTo(s.home);
        if (a < bestAngle) {
          bestAngle = a;
          best = b;
        }
      }
      outDir.copy(best);
      anchored = true;
    }
  }
  if (!anchored && !pickAnchor(def.anchorSource, s, outDir, personaId)) {
    jitterDir(s.home, arc(3), outDir); // graceful fallback if anchors missing
  }
  return {
    activity,
    pose: def.pose,
    dwellMin: def.dwell[0],
    dwellMax: def.dwell[1],
    face: def.face,
  };
}
