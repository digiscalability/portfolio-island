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

/** Progress, {v:1, done[], finished, skipped, t}. D9 reads it too. */
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

export type GuidePhase = 'idle' | 'controls' | 'steps' | 'finale' | 'done';

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
    this.save = saved ?? { v: 1, done: [], finished: false, skipped: false, t: 0 };
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
}

export interface GuideButton {
  id: 'skip' | 'resume' | 'ok' | 'primary' | 'school' | 'close';
  label: string;
}

/** The card's text. [X] marks a key cap. */
export interface GuideCopy {
  title: string;
  body: string;
  /** The extra line (a coin picked up). */
  line: string | null;
  /** The header's own button: Skip, or Close on the finale. */
  headButton: GuideButton;
  buttons: GuideButton[];
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
      body: `Drag to look · ${c.runKey === 'shift' ? 'Shift' : 'Space'} to run`,
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
