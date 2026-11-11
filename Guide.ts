/**
 * Guide.ts: First steps (A6) and the "Show me" seam (P2-A5).
 *
 * - Guide is a pure state machine for the five-step guide: move, look,
 *   talk, portfolio, compass. main-simple feeds it one GuideFrame per frame
 *   and the events it sees (a chat opening, the map opening, a coin);
 *   GuideCard.ts draws it. Time is the frames' dt, so tests drive it exactly.
 * - One window event, 'ds:guide-to' {key, label?, source}, sets the compass
 *   the way an island-map pick does. Producers (D's Things to do and route
 *   cards, the guide's own buttons) name a place by key; resolveGuideKey
 *   turns the key into a position, from the same scene getters
 *   openIslandMap reads.
 * - RecruiterRoute is the three-stop card a visitor gets when a hire card
 *   closes before they have walked anywhere (P2-A4).
 * - GOAL_LADDER is one list of everything worth doing, in three rungs, and
 *   NextChip is the 'Next: <goal>' chip the card folds into once the first
 *   steps are over (P2-A12).
 * No DOM and no scene: test/guide.test.ts runs all of it on stubs.
 */
import { fx } from './FxBudget';
import { PASSPORT_META } from './Passport';

// The guide's per-frame tick is a new per-frame effect (perf ledger: DOM
// only, 30 µs/frame or less, on for both tiers).
fx.register('guide', { desktop: true, low: true });

/** Any {x, y, z} (THREE.Vector3 included). */
export interface Vec3Like {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** What the resolver may ask the world. main-simple implements it on the
 *  getters openIslandMap uses (zones, kiosk, bank, school, farm, …). */
export interface GuideWorld {
  /** A district's door (ZonesManager zone position). */
  zone(id: string): Vec3Like | null;
  school(): Vec3Like | null;
  kiosk(): Vec3Like | null;
  bank(): Vec3Like | null;
  /** Where a line can be cast: the fisherman's jetty. */
  shore(): Vec3Like | null;
  carpenter(): Vec3Like | null;
  farm(): Vec3Like | null;
  raceStart(kind: 'land' | 'water'): Vec3Like | null;
  /** The mailbox holding the active parcel. */
  nextMailbox(): Vec3Like | null;
  /** The nearest free build stake. */
  nearestStake(): Vec3Like | null;
  /** The nearest awake villager who talks through Claude Haiku 4.5. */
  nearestAiVillager(): { name: string; pos: Vec3Like } | null;
  /** The beach house on the islet (decision P2-2). */
  beachHouse(): Vec3Like | null;
}

/** A resolved key: where, and how the pill names it. */
export interface GuideHit {
  pos: Vec3Like;
  icon: string;
  label: string;
  /** The district id for a district key: its pick ends at the door. */
  zone: string | null;
}

export const GUIDE_DISTRICTS = [
  'welcome',
  'professional',
  'projects',
  'personal',
  'contact',
] as const;

/** Every key the seam answers. */
export const GUIDE_KEYS: readonly string[] = [
  ...GUIDE_DISTRICTS.map((d) => `district:${d}`),
  'school',
  'kiosk',
  'bank',
  'shore',
  'carpenter',
  'farm',
  'race:land',
  'race:water',
  'mailbox:next',
  'stake:nearest',
  'villager:ai-nearest',
  'beach-house',
];

const PLACES: Record<string, [string, string, (w: GuideWorld) => Vec3Like | null]> = {
  school: ['🏫', 'School', (w) => w.school()],
  kiosk: ['🛒', 'Shop kiosk', (w) => w.kiosk()],
  bank: ['🏦', 'Bank', (w) => w.bank()],
  shore: ['🎣', 'Fishing shore', (w) => w.shore()],
  carpenter: ['🪚', 'Carpenter', (w) => w.carpenter()],
  farm: ['🌾', 'Farm', (w) => w.farm()],
  'race:land': ['🏞️', 'Land race start', (w) => w.raceStart('land')],
  'race:water': ['🌊', 'Water race start', (w) => w.raceStart('water')],
  'mailbox:next': ['📦', 'Parcel', (w) => w.nextMailbox()],
  'stake:nearest': ['🔨', 'Build stake', (w) => w.nearestStake()],
  'beach-house': ['🏖️', 'Beach house', (w) => w.beachHouse()],
};

/** The pill's name for a district: the passport's, so the compass reads the
 *  same whether a pick or the guide set it. */
function districtName(id: string): [string, string] {
  if (id === 'welcome') return ['🏝️', 'Welcome Hub'];
  const meta = (PASSPORT_META as Record<string, { icon: string; label: string }>)[id];
  return meta ? [meta.icon, meta.label] : ['🏝️', id];
}

/** The place a key names, or null for an unknown key or one with no place. */
export function resolveGuideKey(key: string, w: GuideWorld): GuideHit | null {
  if (typeof key !== 'string') return null;
  if (key.startsWith('district:')) {
    const id = key.slice('district:'.length);
    if (!(GUIDE_DISTRICTS as readonly string[]).includes(id)) return null;
    const pos = w.zone(id);
    if (!pos) return null;
    const [icon, label] = districtName(id);
    return { pos, icon, label, zone: id };
  }
  if (key === 'villager:ai-nearest') {
    const v = w.nearestAiVillager();
    return v ? { pos: v.pos, icon: '💬', label: v.name, zone: null } : null;
  }
  const place = Object.prototype.hasOwnProperty.call(PLACES, key) ? PLACES[key] : null;
  if (!place) return null;
  const pos = place[2](w);
  return pos ? { pos, icon: place[0], label: place[1], zone: null } : null;
}

/** The detail of a 'ds:guide-to' event, validated; null when malformed. */
export function readGuideTo(
  detail: unknown,
): { key: string; label: string | null; source: string } | null {
  if (!detail || typeof detail !== 'object') return null;
  const d = detail as { key?: unknown; label?: unknown; source?: unknown };
  if (typeof d.key !== 'string' || d.key.length === 0 || d.key.length > 64) return null;
  const label = typeof d.label === 'string' && d.label.trim() ? d.label.trim().slice(0, 60) : null;
  const source = typeof d.source === 'string' && d.source ? d.source.slice(0, 24) : 'event';
  return { key: d.key, label, source };
}

// ---- First steps (A6) -----------------------------------------------------

export type GuideStep = 'move' | 'look' | 'talk' | 'portfolio' | 'compass';
export const GUIDE_STEPS: readonly GuideStep[] = ['move', 'look', 'talk', 'portfolio', 'compass'];

/** Progress, {v:1, done[], finished, skipped, t, goals[]}. D9 reads it too:
 *  goals[] (the ladder's goals seen done, P2-A12) was added without changing
 *  v, and a reader that does not know it ignores it. */
export const GUIDE_KEY = 'ds_guide_v1';
/** The once-only "controls changed" card for visitors from before the guide. */
export const CONTROLS_KEY = 'ds_controls_v2';

export interface GuideSave {
  v: 1;
  done: GuideStep[];
  finished: boolean;
  skipped: boolean;
  /** Last write, ms since the epoch (0: never written). */
  t: number;
  /** Ladder goals seen done (GOAL_LADDER ids), kept once the first steps are over. */
  goals: string[];
}

/** Where progress lives. A throw from either method keeps it for the session. */
export interface GuideStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

/** Seconds. */
export const GUIDE_TIMING = {
  /** On one step this long, the card shrinks to the Resume chip. */
  stepTimeout: 20,
  /** A finished step's check shows this long before the next step. */
  advance: 0.45,
  /** After the welcome card, a panel, a tour or a room closes. */
  resume: 0.6,
  /** How often the guide asks who the talk step's villager is. */
  talkCheck: 0.5,
  coinLine: 3,
  /** The legacy controls card, unless OK is pressed first. */
  controls: 8,
  /** The finale, unless a button is pressed first. */
  finale: 20,
} as const;

export const GUIDE_GOALS = {
  /** Walk: movement input above this... */
  moveInput: 0.3,
  /** ...for this many seconds, or this far walked. */
  moveSeconds: 1,
  walkU: 4,
  /** Look: this much manual yaw (OrbitCamera.getYaw), in radians: 35°. */
  lookRad: (35 * Math.PI) / 180,
  /** Compass: this close to the pill's target. */
  compassU: 15,
} as const;

/** What arms the guide: Explore (or Escape) on the welcome card, the end of
 *  the full tour, or the close of the panel See the work / Get in touch opened. */
export type GuideArm = 'explore' | 'tour' | 'cta';

/** 'route' is the recruiter route's card (RecruiterRoute) and 'next' the Next
 *  chip (NextChip), drawn by the same GuideCard through the same GuideView. */
export type GuidePhase = 'idle' | 'controls' | 'steps' | 'finale' | 'done' | 'route' | 'next';

/** One frame of what the guide needs to know. main-simple reuses one object. */
export interface GuideFrame {
  dt: number;
  /** The welcome card, the loader, any panel, a tour or a room is up. */
  blocked: boolean;
  /** PanelManager's top panel id. */
  top: string | null;
  /** Keyboard plus joystick walk input. */
  moveMag: number;
  /** How far the player moved this frame, u. */
  walked: number;
  /** OrbitCamera.getYaw(): manual look only, auto-follow does not move it. */
  yaw: number;
  /** Distance to the pill's target, or null with no target. */
  targetDist: number | null;
}

export interface GuideHooks {
  track?(name: string, props: { step: string; outcome: string }): void;
  /** A step was done (the card plays its check, main-simple a blip). */
  completed?(step: GuideStep): void;
  /** The visitor pressed Skip: main-simple fires the compass hint instead. */
  skipped?(): void;
}

export interface GuideOptions {
  /** ds_welcomed was set at boot: a visitor from before the guide. */
  welcomed: boolean;
  /** Read at arming, for a legacy visitor's pre-completed steps. */
  facts(): { npcChatted: boolean; passportCount: number; mapHint: boolean };
  /**
   * The talk step's villager, or null to skip the step: A7's trail villager
   * while they are up. Asked again while the step is ahead or on the card,
   * with the villager the guide names now, so a stand-in for one who went to
   * bed is kept while they are up in turn.
   */
  talkTarget(current: string | null): string | null;
  /** Show the once-only controls card to a legacy visitor (keyboards only). */
  controlsCard: boolean;
}

/** What GuideCard draws. */
export interface GuideView {
  version: number;
  phase: GuidePhase;
  /** The card is on screen (running and not paused). */
  visible: boolean;
  /** The hint gate: data-active='1', and 'ds:guide' {active:true}. */
  active: boolean;
  step: GuideStep | null;
  /** The step whose check is playing, during the 450 ms advance. */
  justDone: GuideStep | null;
  done: readonly GuideStep[];
  /** 20 s on a step: the one-line Resume chip. */
  chip: boolean;
  coinLine: boolean;
  heading: string;
  talkTarget: string | null;
}

/** A stored ds_guide_v1, validated; null when absent or unreadable. */
export function parseGuideSave(raw: string | null): GuideSave | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as Partial<GuideSave> | null;
    if (!o || typeof o !== 'object' || o.v !== 1) return null;
    const list = Array.isArray(o.done) ? (o.done as unknown[]) : [];
    return {
      v: 1,
      done: GUIDE_STEPS.filter((s) => list.includes(s)),
      finished: o.finished === true,
      skipped: o.skipped === true,
      t: typeof o.t === 'number' && Number.isFinite(o.t) ? o.t : 0,
      goals: Array.isArray(o.goals)
        ? (o.goals as unknown[]).filter((x): x is string => typeof x === 'string').slice(0, 64)
        : [],
    };
  } catch {
    return null;
  }
}

export class Guide {
  private readonly save: GuideSave;
  /** A visitor from before the guide: ds_welcomed set and no ds_guide_v1 at boot. */
  private readonly legacy: boolean;
  private phase: GuidePhase = 'idle';
  private heading = 'First steps';
  private step: GuideStep | null = null;
  private justDone: GuideStep | null = null;
  private paused = true;
  private resumeLeft = 0;
  private stepT = 0;
  private chip = false;
  private advanceLeft = 0;
  private moveT = 0;
  private walkedU = 0;
  private yawAcc = 0;
  private lastYaw: number | null = null;
  private coinLeft = 0;
  private phaseLeft = 0;
  private talkTarget: string | null = null;
  private talkT = 0;
  private compassLabel = '';
  private ver = 0;

  constructor(
    private readonly store: GuideStore,
    private readonly hooks: GuideHooks,
    private readonly opts: GuideOptions,
  ) {
    let raw: string | null = null;
    try {
      raw = store.get(GUIDE_KEY);
    } catch {
      /* no storage: a session-only guide */
    }
    const saved = parseGuideSave(raw);
    this.save = saved ?? { v: 1, done: [], finished: false, skipped: false, t: 0, goals: [] };
    this.legacy = opts.welcomed && saved === null;
  }

  /** Bumps on every change the card shows. */
  version(): number {
    return this.ver;
  }

  /** Not finished or skipped: completions still count, arming still works. */
  eligible(): boolean {
    return !this.save.finished && !this.save.skipped && this.phase !== 'done';
  }

  /** Armed and not yet over: the card exists. */
  running(): boolean {
    return this.phase === 'controls' || this.phase === 'steps' || this.phase === 'finale';
  }

  /** The hint gate: running and not collapsed to the chip. */
  isActive(): boolean {
    return this.running() && !this.chip;
  }

  currentStep(): GuideStep | null {
    return this.phase === 'steps' ? this.step : null;
  }

  /** The first steps are over: finished (and the finale has closed) or
   *  skipped, this visit or an earlier one. The Next chip takes over. */
  over(): boolean {
    return (this.save.finished || this.save.skipped) && !this.running();
  }

  /** Ladder goals seen done on this or an earlier visit (ds_guide_v1.goals). */
  goals(): readonly string[] {
    return this.save.goals;
  }

  /**
   * Keep ladder goals as done. Only once the first steps are over: a write
   * before that would stamp t, and arm() reads t === 0 as "a visitor from
   * before the guide, never written".
   */
  addGoals(ids: readonly string[]): void {
    if (!this.over()) return;
    let changed = false;
    for (const id of ids) {
      if (this.save.goals.includes(id)) continue;
      this.save.goals.push(id);
      changed = true;
    }
    if (changed) this.persist();
  }

  /**
   * The villager First steps is sending the visitor to, while it is: the
   * talk step is on the card or still ahead (walk, look), not done, and the
   * card is not collapsed to the chip. The compass names the same villager
   * (compassTarget's talk branch), so the pill and the card never part.
   */
  talkTargetNow(): string | null {
    if (this.phase !== 'steps' || this.chip || this.save.done.includes('talk')) return null;
    return this.talkTarget;
  }

  /** What 'ds:guide' says the guide is on. */
  signalStep(): string | null {
    if (this.phase === 'steps') return this.step;
    return this.phase === 'controls' || this.phase === 'finale' ? this.phase : null;
  }

  /**
   * Start the guide, or resume it at the first undone step. False when it
   * is finished, skipped or already running.
   */
  arm(source: GuideArm): boolean {
    if (this.phase !== 'idle' || this.save.finished || this.save.skipped) return false;
    this.heading = source === 'tour' ? 'The island is yours' : 'First steps';
    let controls = false;
    if (this.legacy && this.save.t === 0) {
      // A visitor from before the guide: what they have done already counts.
      const f = this.opts.facts();
      const pre: GuideStep[] = ['move', 'look'];
      if (f.npcChatted) pre.push('talk');
      if (f.passportCount >= 1) pre.push('portfolio');
      if (f.mapHint) pre.push('compass');
      for (const s of pre) if (!this.save.done.includes(s)) this.save.done.push(s);
      if (this.opts.controlsCard) {
        let seen = false;
        try {
          seen = this.store.get(CONTROLS_KEY) === '1';
          if (!seen) this.store.set(CONTROLS_KEY, '1');
        } catch {
          /* shown once this session */
        }
        controls = !seen;
      }
    }
    this.persist();
    this.paused = true;
    this.resumeLeft = GUIDE_TIMING.resume;
    this.lastYaw = null;
    // Known from the arming on, so the pill names the villager at once.
    this.talkT = 0;
    if (!this.save.done.includes('talk')) this.talkTarget = this.opts.talkTarget(null);
    if (controls) {
      this.phase = 'controls';
      this.phaseLeft = GUIDE_TIMING.controls;
      this.bump();
    } else {
      this.phase = 'steps';
      this.nextStep();
    }
    return true;
  }

  /** One frame. Panel-driven completions count even before arming. */
  frame(f: GuideFrame): void {
    // The finale runs on a finished save: running() keeps its clock going.
    if (!this.eligible() && !this.running()) return;
    if (f.top === 'portfolio-menu' || f.top === 'zone') this.complete('portfolio');
    if (f.top === 'island-map') this.complete('compass');
    if (this.phase === 'idle') return;
    const dt = Math.min(Math.max(f.dt, 0), 0.25);
    const dYaw = this.lastYaw === null ? 0 : Math.abs(f.yaw - this.lastYaw);
    this.lastYaw = f.yaw;
    if (f.blocked) {
      if (!this.paused) {
        this.paused = true;
        this.bump();
      }
      this.resumeLeft = GUIDE_TIMING.resume;
      return;
    }
    if (this.paused) {
      this.resumeLeft -= dt;
      if (this.resumeLeft > 0) return;
      this.paused = false;
      this.bump();
    }
    if (this.coinLeft > 0) {
      this.coinLeft -= dt;
      if (this.coinLeft <= 0) this.bump();
    }
    if (this.phase === 'controls' || this.phase === 'finale') {
      this.phaseLeft -= dt;
      if (this.phaseLeft <= 0) {
        if (this.phase === 'controls') this.controlsDone();
        else this.finish();
      }
      return;
    }
    if (this.advanceLeft > 0) {
      this.advanceLeft -= dt;
      if (this.advanceLeft <= 0) this.nextStep();
      return;
    }
    if (!this.save.done.includes('talk')) {
      this.talkT += dt;
      if (this.talkT >= GUIDE_TIMING.talkCheck) {
        this.talkT = 0;
        this.refreshTalkTarget();
      }
    }
    switch (this.step) {
      case 'move':
        if (f.moveMag > GUIDE_GOALS.moveInput) this.moveT += dt;
        // a teleport (respawn, a room) is not a walk
        if (f.walked > 0 && f.walked < 5) this.walkedU += f.walked;
        if (this.moveT >= GUIDE_GOALS.moveSeconds || this.walkedU >= GUIDE_GOALS.walkU) {
          this.complete('move');
        }
        break;
      case 'look':
        this.yawAcc += dYaw;
        if (this.yawAcc >= GUIDE_GOALS.lookRad) this.complete('look');
        break;
      case 'compass':
        if (f.targetDist !== null && f.targetDist <= GUIDE_GOALS.compassU) this.complete('compass');
        break;
      default:
        break;
    }
    if (this.advanceLeft <= 0 && !this.chip && this.step) {
      this.stepT += dt;
      if (this.stepT >= GUIDE_TIMING.stepTimeout) {
        this.chip = true;
        this.hooks.track?.('guide_step', { step: this.step, outcome: 'timeout' });
        this.bump();
      }
    }
  }

  /**
   * A step's action happened: a chat or quest dialogue opened (talk), the map
   * opened (compass), the work opened (portfolio). Steps done out of order
   * count; done before arming, they are saved and tracked from the arming on.
   */
  complete(step: GuideStep): void {
    if (!this.eligible() || this.save.done.includes(step)) return;
    this.save.done.push(step);
    if (this.phase === 'idle') return;
    this.persist();
    this.hooks.track?.('guide_step', { step, outcome: 'done' });
    this.hooks.completed?.(step);
    if (this.phase === 'steps' && this.step === step) {
      this.justDone = step;
      this.advanceLeft = GUIDE_TIMING.advance;
    }
    this.bump();
  }

  /** A coin was picked up: the coin line shows for 3 s. */
  coin(): void {
    if (!this.running()) return;
    this.coinLeft = GUIDE_TIMING.coinLine;
    this.bump();
  }

  /** The chip was tapped: the card again, with a fresh 20 s. */
  expand(): void {
    if (!this.chip) return;
    this.chip = false;
    this.stepT = 0;
    this.bump();
  }

  /** The controls card's OK (or its 8 s): on to the first undone step. */
  controlsDone(): void {
    if (this.phase !== 'controls') return;
    this.phase = 'steps';
    this.nextStep();
  }

  /** Skip: recorded, and the card goes. On the finale it just closes. */
  skip(): void {
    if (!this.running()) return;
    if (this.phase === 'finale') {
      this.finish();
      return;
    }
    const at = this.signalStep() ?? 'move';
    this.save.skipped = true;
    this.persist();
    this.close();
    this.hooks.track?.('guide_step', { step: at, outcome: 'skipped' });
    this.hooks.skipped?.();
  }

  /** A finale button (or its 20 s): the guide is over. */
  finish(): void {
    if (this.phase === 'finale') this.close();
  }

  /** The compass step names the pill's target; a new one redraws it. */
  setCompassLabel(label: string): void {
    if (label === this.compassLabel) return;
    this.compassLabel = label;
    if (this.phase === 'steps' && this.step === 'compass') this.bump();
  }

  getCompassLabel(): string {
    return this.compassLabel;
  }

  view(): GuideView {
    const running = this.running();
    return {
      version: this.ver,
      phase: this.phase,
      visible: running && !this.paused,
      active: running && !this.chip,
      step: this.phase === 'steps' ? this.step : null,
      justDone: this.justDone,
      done: [...this.save.done],
      chip: this.chip,
      coinLine: this.coinLeft > 0,
      heading: this.heading,
      talkTarget: this.talkTarget,
    };
  }

  /** The next undone step; talk with no villager to talk to is skipped. */
  private nextStep(): void {
    this.justDone = null;
    for (;;) {
      const next = GUIDE_STEPS.find((s) => !this.save.done.includes(s)) ?? null;
      if (!next) {
        this.startFinale();
        return;
      }
      if (next === 'talk') {
        this.talkTarget = this.opts.talkTarget(this.talkTarget);
        if (!this.talkTarget) {
          this.skipTalk();
          continue;
        }
      }
      this.step = next;
      this.stepT = 0;
      this.moveT = 0;
      this.walkedU = 0;
      this.yawAcc = 0;
      this.bump();
      return;
    }
  }

  /** Nobody to talk to: the step is recorded as skipped. */
  private skipTalk(): void {
    this.save.done.push('talk');
    this.persist();
    this.hooks.track?.('guide_step', { step: 'talk', outcome: 'skipped' });
  }

  /**
   * Ask again who the talk step's villager is: one can go to bed mid-guide
   * (the sleep goal walks them home under an "asleep" tag, then hides them).
   * Ahead of the step only the pill shows the answer; on the step the card
   * names the stand-in, and with nobody left the step is skipped.
   */
  private refreshTalkTarget(): void {
    const who = this.opts.talkTarget(this.talkTarget);
    if (who === this.talkTarget) return;
    this.talkTarget = who;
    if (this.step !== 'talk') return;
    if (who) {
      this.bump();
      return;
    }
    this.skipTalk();
    this.nextStep();
  }

  private startFinale(): void {
    this.phase = 'finale';
    this.step = null;
    this.chip = false;
    this.phaseLeft = GUIDE_TIMING.finale;
    this.save.finished = true;
    this.persist();
    this.bump();
  }

  private close(): void {
    this.phase = 'done';
    this.step = null;
    this.justDone = null;
    this.chip = false;
    this.bump();
  }

  private persist(): void {
    this.save.t = Date.now();
    try {
      this.store.set(GUIDE_KEY, JSON.stringify(this.save));
    } catch {
      /* session only */
    }
  }

  private bump(): void {
    this.ver++;
  }
}

// ---- The recruiter route (P2-A4) -------------------------------------------

/** The route's three stops, in order: the work, the experience, the way in. */
export const ROUTE_STOPS: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'projects', label: 'Projects' },
  { id: 'professional', label: 'Professional' },
  { id: 'contact', label: 'Get in touch' },
];
/** A visitor who has walked this far since the page loaded is exploring
 *  already: the route is for one who has only read the card. */
export const ROUTE_WALK_U = 4;
/** What a /z/hire visitor is told once the card closes: the deep link opens
 *  on the hire card and otherwise never says where they are. */
export const ROUTE_PITCH = "You're on Abbas's 3D portfolio island — walk in to see the work.";

/** How the hire card that just closed was opened: the Hiring pill or chip, the
 *  recruiter tour's last stop, or a /z/hire (?zone=hire) link. */
export type RouteSource = 'hire' | 'tour' | 'deeplink';

export interface RouteHooks {
  track?(name: string, props: { stop: string; outcome: string }): void;
}

/**
 * 'Recruiter route · 3 stops': Projects, Professional, Get in touch, each
 * with a 'Show me' that points the compass there, and 'Stay in the menu'.
 * It shows when a hire card closes on a visitor who has walked under 4 u
 * since load, once a visit. A recruiter who read the card and closed it was
 * left on an island nobody had explained (after the recruiter tour: 20 s of
 * nothing). It pauses under panels, tours and rooms like First steps, and
 * comes back 600 ms after.
 */
export class RecruiterRoute {
  private phase: 'idle' | 'shown' | 'done' = 'idle';
  private pitch = false;
  private paused = true;
  private resumeLeft = 0;
  private ver = 0;

  constructor(private readonly hooks: RouteHooks = {}) {}

  /** Never the same number as a Guide's version: GuideCard redraws on change. */
  version(): number {
    return 1_000_000 + this.ver;
  }

  /** On screen or waiting behind a panel: it holds hints, as First steps does. */
  showing(): boolean {
    return this.phase === 'shown';
  }

  /** The hire card closed. False when the route has had its turn this visit,
   *  or the visitor has walked off already. */
  arm(source: RouteSource, walkedU: number): boolean {
    if (this.phase !== 'idle' || !(walkedU < ROUTE_WALK_U)) return false;
    this.phase = 'shown';
    this.pitch = source === 'deeplink';
    this.paused = true;
    this.resumeLeft = GUIDE_TIMING.resume;
    this.hooks.track?.('recruiter_route', { stop: source, outcome: 'shown' });
    this.ver++;
    return true;
  }

  /** One frame: hidden while anything is up, back 600 ms after it goes. */
  frame(dt: number, blocked: boolean): void {
    if (this.phase !== 'shown') return;
    if (blocked) {
      if (!this.paused) {
        this.paused = true;
        this.ver++;
      }
      this.resumeLeft = GUIDE_TIMING.resume;
      return;
    }
    if (!this.paused) return;
    this.resumeLeft -= Math.min(Math.max(dt, 0), 0.25);
    if (this.resumeLeft > 0) return;
    this.paused = false;
    this.ver++;
  }

  /** A stop's 'Show me': the card goes; the caller points the compass there. */
  pick(stop: string): boolean {
    if (this.phase !== 'shown' || !ROUTE_STOPS.some((x) => x.id === stop)) return false;
    this.hooks.track?.('recruiter_route', { stop, outcome: 'show' });
    this.close();
    return true;
  }

  /** 'Stay in the menu': the card goes and nothing else changes. */
  stay(): void {
    if (this.phase !== 'shown') return;
    this.hooks.track?.('recruiter_route', { stop: 'none', outcome: 'stay' });
    this.close();
  }

  view(): GuideView {
    const shown = this.phase === 'shown';
    return {
      version: this.version(),
      phase: shown ? 'route' : 'done',
      visible: shown && !this.paused,
      active: shown,
      step: null,
      justDone: null,
      done: [],
      chip: false,
      coinLine: false,
      heading: 'Recruiter route',
      talkTarget: null,
    };
  }

  /** The card's words. The pitch line is for a visitor a link dropped here. */
  copy(): GuideCopy {
    return {
      title: `Recruiter route · ${ROUTE_STOPS.length} stops`,
      body: this.pitch ? ROUTE_PITCH : '',
      line: null,
      headButton: { id: 'stay', label: 'Stay in the menu' },
      buttons: [],
      rows: ROUTE_STOPS.map((x) => ({
        label: x.label,
        button: { id: `route:${x.id}`, label: 'Show me' },
      })),
      chip: '',
    };
  }

  private close(): void {
    this.phase = 'done';
    this.ver++;
  }
}

// ---- The goal ladder and the Next chip (P2-A12) ----------------------------

/** One thing worth doing on the island. */
export interface GoalDef {
  id: string;
  /** 1 the work, 2 the island, 3 make a mark. */
  rung: 1 | 2 | 3;
  /** In the chip ('Next: <label>') and in a stacked row. */
  label: string;
  /** In a row that shares the card's width with two others. */
  short: string;
  /** What its 'Show me' sends through 'ds:guide-to'. */
  guideKey: string;
}

/**
 * Everything worth doing, in the order the chip offers it. One list: D's
 * Things to do and the crown's 'Next:' read the same goals through
 * 'ds:goals'. Rung 1 is the work (the four stamps, the hire card), rung 2
 * the island, rung 3 making a mark on it. No count is typed in a label.
 */
export const GOAL_LADDER: readonly GoalDef[] = [
  ...(['projects', 'professional', 'personal', 'contact'] as const).map(
    (z): GoalDef => ({
      id: `stamp:${z}`,
      rung: 1,
      label: PASSPORT_META[z].label,
      short: PASSPORT_META[z].label,
      guideKey: `district:${z}`,
    }),
  ),
  { id: 'hire', rung: 1, label: 'The hire card', short: 'Hire card', guideKey: 'panel:hire' },
  {
    id: 'talk',
    rung: 2,
    label: 'Talk to a villager',
    short: 'A villager',
    guideKey: 'villager:ai-nearest',
  },
  { id: 'race', rung: 2, label: 'Run a race', short: 'A race', guideKey: 'race:land' },
  { id: 'catch', rung: 2, label: 'Catch a fish', short: 'Fishing', guideKey: 'shore' },
  { id: 'lesson', rung: 2, label: 'Take a School lesson', short: 'School', guideKey: 'school' },
  { id: 'shop', rung: 2, label: 'Visit the shop', short: 'The shop', guideKey: 'kiosk' },
  { id: 'build', rung: 3, label: 'Build at a stake', short: 'Build', guideKey: 'stake:nearest' },
  {
    id: 'guestbook',
    rung: 3,
    label: 'Sign the guestbook',
    short: 'Guestbook',
    guideKey: 'panel:guestbook',
  },
  {
    id: 'deliveries',
    rung: 3,
    label: 'Deliver every parcel',
    short: 'Parcels',
    guideKey: 'mailbox:next',
  },
  { id: 'crown', rung: 3, label: 'Earn the Golden Crown', short: 'Crown', guideKey: 'kiosk' },
];

/** How many 'Show me' rows the unfolded chip offers: side by side, stacked. */
export const NEXT_ROWS = { across: 3, stacked: 5 } as const;
/** How many accepted quests it lists under them. */
export const NEXT_QUEST_LINES = { across: 2, stacked: 3 } as const;

/** Where the ladder's done goals are kept: Guide, through ds_guide_v1.goals. */
export interface GoalStore {
  goals(): readonly string[];
  addGoals(ids: readonly string[]): void;
}

export interface NextHooks {
  track?(name: string, props: { goal: string; outcome: string }): void;
}

/** What 'ds:goals' carries, less the visit's numbers (main-simple adds them). */
export interface GoalsSummary {
  done: number;
  total: number;
  next: { id: string; label: string; guideKey: string } | null;
  goals: Array<{ id: string; rung: number; label: string; guideKey: string; done: boolean }>;
}

/**
 * The 'Next: <goal>' chip. When the first steps finish or are skipped the
 * card folds into it and it stays: one 44 px line naming the next goal on
 * the ladder. A tap unfolds 'Show me' rows for the next few goals and the
 * quests the visitor has accepted. It hides under panels, tours and rooms
 * and comes back, folded, 600 ms after. It never holds hints.
 *
 * sync() is fed a few times a second with what is done now. A goal seen
 * done stays done (ds_guide_v1.goals), so a reload resumes the ladder.
 */
export class NextChip {
  private readonly doneIds = new Set<string>();
  private enabled = false;
  /** The first sync after it comes on takes stock without tracking. */
  private primed = false;
  private paused = true;
  private resumeLeft = 0;
  private expanded = false;
  private preferred: string | null = null;
  private quests: string[] = [];
  private ver = 0;

  constructor(
    private readonly store: GoalStore,
    private readonly hooks: NextHooks = {},
  ) {
    for (const id of store.goals()) this.doneIds.add(id);
  }

  /** Never the same number as a Guide's or a RecruiterRoute's version. */
  version(): number {
    return 2_000_000 + this.ver;
  }

  /** On: the first steps are over and something is left to offer. */
  showing(): boolean {
    return this.enabled && (this.next() !== null || this.quests.length > 0);
  }

  isDone(id: string): boolean {
    return this.doneIds.has(id);
  }

  /**
   * The next goal: the preferred one while it is undone (the district the
   * compass is on, so the chip and the pill name the same place), else the
   * first undone goal in ladder order.
   */
  next(): GoalDef | null {
    const p = this.preferred;
    if (p && !this.doneIds.has(p)) {
      const goal = GOAL_LADDER.find((g) => g.id === p);
      if (goal) return goal;
    }
    return GOAL_LADDER.find((g) => !this.doneIds.has(g.id)) ?? null;
  }

  /** The next goal, then the undone ones after it in ladder order. */
  rows(n: number): GoalDef[] {
    const first = this.next();
    if (!first) return [];
    return [first, ...GOAL_LADDER.filter((g) => g !== first && !this.doneIds.has(g.id))].slice(
      0,
      Math.max(1, n),
    );
  }

  /**
   * What is true now. `enabled`: the first steps are over and nothing else
   * has the card. `facts`: goal id to done. `preferred`: the goal the compass
   * is on, if any. `quests`: accepted quests, one line each. Returns true
   * when the set of done goals grew (the caller publishes 'ds:goals').
   */
  sync(
    enabled: boolean,
    facts: Readonly<Record<string, boolean>>,
    preferred: string | null,
    quests: readonly string[],
  ): boolean {
    const before = `${this.showing()}|${this.next()?.id ?? ''}|${this.quests.join('\n')}`;
    if (enabled !== this.enabled) {
      this.enabled = enabled;
      this.paused = true;
      this.resumeLeft = 0; // the card it replaces has just gone: no second beat
      this.expanded = false;
    }
    const fresh: string[] = [];
    for (const g of GOAL_LADDER) {
      if (facts[g.id] === true && !this.doneIds.has(g.id)) {
        this.doneIds.add(g.id);
        fresh.push(g.id);
      }
    }
    if (enabled) {
      // Kept only from here on (Guide.addGoals): what was done before the
      // first steps ended is taken as found, not tracked as an achievement.
      this.store.addGoals([...this.doneIds]);
      if (this.primed) {
        for (const id of fresh) this.hooks.track?.('guide_goal', { goal: id, outcome: 'done' });
      }
      this.primed = true;
    }
    this.preferred = preferred;
    this.quests = quests.slice(0, NEXT_QUEST_LINES.stacked);
    const after = `${this.showing()}|${this.next()?.id ?? ''}|${this.quests.join('\n')}`;
    if (after !== before || (fresh.length > 0 && this.expanded)) this.ver++;
    return fresh.length > 0;
  }

  /** One frame: hidden while anything is up, back (folded) 600 ms after. */
  frame(dt: number, blocked: boolean): void {
    if (!this.enabled) return;
    if (blocked) {
      if (!this.paused || this.expanded) {
        this.paused = true;
        this.expanded = false;
        this.ver++;
      }
      this.resumeLeft = GUIDE_TIMING.resume;
      return;
    }
    if (!this.paused) return;
    this.resumeLeft -= Math.min(Math.max(dt, 0), 0.25);
    if (this.resumeLeft > 0) return;
    this.paused = false;
    this.ver++;
  }

  /** The chip was tapped: unfold, or fold again. */
  toggle(): void {
    if (!this.showing()) return;
    this.expanded = !this.expanded;
    this.ver++;
  }

  /** Fold the list away: the visitor walked off. */
  fold(): void {
    if (!this.expanded) return;
    this.expanded = false;
    this.ver++;
  }

  /** A row's 'Show me': the chip folds; the caller points the compass. */
  pick(id: string): GoalDef | null {
    const goal = GOAL_LADDER.find((g) => g.id === id) ?? null;
    if (!goal || !this.showing()) return null;
    this.hooks.track?.('guide_goal', { goal: id, outcome: 'show' });
    if (this.expanded) {
      this.expanded = false;
      this.ver++;
    }
    return goal;
  }

  /** For 'ds:goals': D's Things to do and the crown's 'Next:' read it. */
  summary(): GoalsSummary {
    const next = this.next();
    return {
      done: GOAL_LADDER.filter((g) => this.doneIds.has(g.id)).length,
      total: GOAL_LADDER.length,
      next: next ? { id: next.id, label: next.label, guideKey: next.guideKey } : null,
      goals: GOAL_LADDER.map((g) => ({
        id: g.id,
        rung: g.rung,
        label: g.label,
        guideKey: g.guideKey,
        done: this.doneIds.has(g.id),
      })),
    };
  }

  view(): GuideView {
    const on = this.showing();
    return {
      version: this.version(),
      phase: on ? 'next' : 'done',
      visible: on && !this.paused,
      active: false, // a standing chip never holds hints
      step: null,
      justDone: null,
      done: [],
      chip: !this.expanded,
      coinLine: false,
      heading: 'Next',
      talkTarget: null,
    };
  }

  /** The chip's words. `across`: rows share the width (a phone, a short window). */
  copy(across: boolean): GuideCopy {
    const next = this.next();
    const head = next ? `Next: ${next.label}` : 'Your requests';
    const n = across ? NEXT_ROWS.across : NEXT_ROWS.stacked;
    return {
      title: head,
      body: '',
      line: null,
      headButton: { id: 'next', label: head },
      buttons: [],
      rows: this.rows(n).map((g) => ({
        label: across ? g.short : g.label,
        button: { id: `goal:${g.id}`, label: 'Show me' },
      })),
      lines: this.quests.slice(0, across ? NEXT_QUEST_LINES.across : NEXT_QUEST_LINES.stacked),
      chip: head,
    };
  }
}

// ---- the card's words ------------------------------------------------------

export interface GuideCopyContext {
  touch: boolean;
  /** html[data-look-mode]: 'drag' (press and drag) or 'lock' (opt-in). */
  lookMode: string | null;
  /** html[data-run-key] (A11): 'shift' once Shift runs, else Space. */
  runKey: string | null;
  /** The pill's label, for the compass step. */
  compassLabel: string;
  /** The finale's primary 'Show me': Projects, or the nearest unstamped district. */
  finaleLabel: string;
  /** The talk step's villager has quest lines to say first (a request, an
   *  errand's next step, a reminder not yet heard this session): E opens
   *  those, not the chat, so the card must not promise 'ask anything'. */
  talkQuest?: boolean;
  /** D8's Controls & settings sheet is in this build, so '?' opens it. The
   *  legacy controls card names the key only then: a key that does nothing
   *  is worse than no hint. */
  controlsSheet?: boolean;
}

export interface GuideButton {
  /** 'route:<district>' is a recruiter-route stop's 'Show me'; 'stay' is its
   *  'Stay in the menu'. 'next' folds and unfolds the Next chip; 'goal:<id>'
   *  is one of its 'Show me' rows. */
  id:
    | 'skip'
    | 'resume'
    | 'ok'
    | 'primary'
    | 'school'
    | 'close'
    | 'stay'
    | 'next'
    | `route:${string}`
    | `goal:${string}`;
  label: string;
}

/** One 'Show me' row: what it leads to, and its button. */
export interface GuideRow {
  label: string;
  button: GuideButton;
}

/** The card's text. [X] marks a key cap. */
export interface GuideCopy {
  title: string;
  body: string;
  /** The extra line (a coin picked up). */
  line: string | null;
  /** The header's own button: Skip, Close on the finale, or the route's
   *  'Stay in the menu'. */
  headButton: GuideButton;
  buttons: GuideButton[];
  /** 'Show me' rows (the recruiter route's stops, the Next chip's goals),
   *  under the body. */
  rows?: GuideRow[];
  /** Plain lines under the rows: the Next chip's accepted quests. */
  lines?: string[];
  /** The collapsed one-line chip. */
  chip: string;
}

const STEP_COPY: Record<GuideStep, (c: GuideCopyContext, who: string | null) => string> = {
  move: (c) =>
    c.touch
      ? 'Walk: drag the joystick, bottom left.'
      : 'Walk with [W] [A] [S] [D] or the arrow keys.',
  look: (c) =>
    c.touch
      ? 'Look around: drag across the island.'
      : c.lookMode === 'lock'
        ? 'Move the mouse to look — or [J] / [L] to turn.'
        : 'Drag to look — or [J] / [L] to turn.',
  // Names the villager twice: as the one who talks through Claude Haiku 4.5
  // (four of the townsfolk are scripted, so "villagers talk through..."
  // would overclaim), and in the brief's own clause, 'Walk up to <name> and
  // press [E]', which says who to walk to (E's guide probe reads it too).
  // Without a target the step is skipped (Guide.nextStep), so the fallback
  // is never on screen; it still claims no more than one villager nearby.
  talk: (c, who) => {
    const ask = `${c.touch ? 'tap USE' : 'press [E]'} to ${c.talkQuest ? 'talk' : 'ask anything'}.`;
    return who
      ? `${who} talks through Claude Haiku 4.5. Walk up to ${who} and ${ask}`
      : `A villager nearby talks through Claude Haiku 4.5. Walk up and ${ask}`;
  },
  portfolio: (c) =>
    c.touch
      ? 'See the work: tap ☰, then 📖 Portfolio.'
      : 'See the work: click 📖 Portfolio, top right.',
  compass: (c) => {
    const to = c.compassLabel ? ` to ${c.compassLabel}` : '';
    return c.touch
      ? `Follow the gold ➤ up top${to}. Tap it for the island map.`
      : `Follow the gold ➤ up top${to}. Click it, or press [M], for the island map.`;
  },
};

/** Everything the card says for a view. Never 'agent', never 'live AI'. */
export function guideCopy(v: GuideView, c: GuideCopyContext): GuideCopy {
  // The number of the step the card shows, not how many are done: steps done
  // out of order (the work opened from the welcome card, before walking)
  // made the card read '2/5' over step 1's words.
  const step = v.justDone ?? v.step;
  const n = step ? GUIDE_STEPS.indexOf(step) + 1 : GUIDE_STEPS.length;
  const of = `${n}/${GUIDE_STEPS.length}`;
  const line = v.coinLine ? 'Coins buy food and hats at the shop' : null;
  const chip = `${v.heading} ${of} · Resume`;
  if (v.phase === 'controls') {
    return {
      title: 'Controls changed',
      body: `Drag to look · ${c.runKey === 'shift' ? 'Shift' : 'Space'} to run${
        c.controlsSheet ? ' · ? for all controls' : ''
      }`,
      line,
      headButton: { id: 'skip', label: 'Skip' },
      buttons: [{ id: 'ok', label: 'OK' }],
      chip,
    };
  }
  if (v.phase === 'finale') {
    return {
      title: "You're set. Next: the work.",
      body: '',
      line,
      headButton: { id: 'close', label: 'Close' },
      buttons: [
        { id: 'primary', label: `Show me ${c.finaleLabel}` },
        { id: 'school', label: 'Show me the School' },
      ],
      chip,
    };
  }
  return {
    title: `${v.heading} · ${of}`,
    body: step ? STEP_COPY[step](c, v.talkTarget) : '',
    line,
    headButton: { id: 'skip', label: 'Skip' },
    buttons: [],
    chip,
  };
}
