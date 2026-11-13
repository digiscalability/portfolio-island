import { a11y } from './Accessibility';
import { linkLabel, markReachedPortfolio, track, trackOnce } from './Analytics';
import type { BoardRead } from './Boards';
import { VOICE_MAX_MS } from './Chat';
import { DISTRICTS } from './Districts';
import { GUIDE_KEY, GUIDE_STEPS, type GoalsSummary, type GuideStep } from './Guide';
import { checkName, safePeerName } from './Moderation';
import { ACTIVITY_DEFS } from './NpcActivities';
import { AI_NPCS, routeQuestion, type QuestionRoute } from './NpcChat';
import { PanelManager } from './PanelManager';
import { Passport, PASSPORT_META, PASSPORT_ZONES, type PassportZone } from './Passport';
import { rumorOfTheDay } from './Secrets';
import { buildShareUrl, setUrlParam, share } from './Share';
import {
  speak,
  cancelSpeech,
  isSpeechSupported,
  isSpeechEnabled,
  setSpeechEnabled,
  isSttSupported,
  startListening,
} from './Speech';
import {
  ensureIconSprite,
  icon,
  iconNode,
  type IconName,
  PARCEL_GLYPH,
  DISTRICT_GLYPHS,
} from './ui/icons';
import { type InputMode, keyTextPlain, promptKeysHtml, renderKeyText } from './ui/keycaps';
import { DS } from './ui/tokens';
import { WORLD_ERA } from './WorldScale';
import { EVENT_META } from './WorldState';
import type { NoticeState, NpcPlan } from './WorldState';

/** What 'ds:goals' carries (main-simple.publishGoals, P2-A12): the ladder,
 *  and the visit's numbers for the crown's summary (P2-D10). */
type VisitGoals = GoalsSummary & {
  visit?: { stamps: number; villagers: number; coins: number; secrets: number; minutes: number };
};

/**
 * Haptics on? The settings sheet's switch (ds_haptics: '1' on, '0' off)
 * decides (D8, HAPTIC-01). Until the visitor has chosen, it follows the gate
 * it replaces: off under reduced motion, on otherwise. A buzz is not motion,
 * so a reduced-motion visitor can now turn it on, and anyone can turn it off.
 */
export function hapticsEnabled(): boolean {
  try {
    const v = localStorage.getItem('ds_haptics');
    if (v === '1') return true;
    if (v === '0') return false;
  } catch {
    /* storage blocked: the default */
  }
  return !a11y.reducedMotion;
}

/**
 * Tiny haptic tap for touch feedback (Android; iOS ignores vibrate — a
 * harmless no-op). Off when the Haptics setting is (see hapticsEnabled).
 * Exported so game events elsewhere (landings, race checkpoints, coins) can
 * adopt it too. The vocabulary (D15, HAPTIC-01): stick engage 10 ms, a
 * button press 12 ms, the stick reaching its run colour 10 ms, an
 * interaction that worked (a door, a talk) 18 ms, and [12, 40, 12] when the
 * shop refuses a purchase.
 */
export function hapticPulse(ms: number | number[]): void {
  if (!hapticsEnabled()) return;
  try {
    navigator.vibrate?.(ms);
  } catch {
    /* unsupported or blocked by permissions policy */
  }
}

/**
 * The compass pill's narrow-screen label (D16). Under 480 px the pill keeps
 * the destination's icon (a first token with no letter or digit) plus a
 * short name: the first word after the icon, skipping a leading article, cut
 * at 9 characters. A race counter stays whole ('Ring 3/7'), so 'Finish line'
 * reads 'Finish'. iconOnly (under 340 px) keeps just the icon, or the short
 * name when the label has no icon.
 */
export function compassShortLabel(label: string, iconOnly = false): string {
  const words = label.trim().split(/\s+/).filter(Boolean);
  const icon = words.length && !/[\p{L}\p{N}]/u.test(words[0]) ? words.shift()! : '';
  if (words.length > 1 && /^(the|a|an)$/i.test(words[0])) words.shift();
  let name = (words[0] ?? '').slice(0, 9);
  if (name && /^\d+\/\d+$/.test(words[1] ?? '')) name = `${name} ${words[1]}`;
  if (iconOnly && icon) return icon;
  return [icon, name].filter(Boolean).join(' ');
}

/**
 * SimpleUI - Simplified UI manager for the basic app
 * Handles loading screen, welcome message, interaction prompts, and FPS display
 */
/** "While you were away" payload for the returning-visitor welcome card. */
export interface AwayDelta {
  daysAway: number;
  editions: number;
  headline: string | null;
  weather: string | null;
  /** Resolves to the number of guestbook signatures since last visit. */
  guestbookSince: Promise<number | null>;
}

/** Data contract for the Island Journal — main-simple supplies a provider. */
/** One inventory line: what you hold, and what it's for. */
export interface InventoryRow {
  icon: string;
  label: string;
  count: number;
  /** What to do with it — kept short; rendered muted beside the count. */
  hint: string;
}
/**
 * What the player currently HOLDS. Deliberately NOT the Journal (which is
 * progress: n-of-m collections) and NOT the Shop (which is what you can buy).
 * Sections mirror the economy's own groupings.
 */
export interface InventoryData {
  coins: number;
  /** Sellable raw resources: catch, harvest, materials. */
  goods: InventoryRow[];
  /** Re-buyable charges: feed and meals. */
  supplies: InventoryRow[];
  /** Tool ownership — a strip, not rows (4 booleans is not 4 lines). */
  tools: Array<{ icon: string; name: string; owned: boolean }>;
  /** Equipped hat + how many of the set are owned. */
  hats: { equipped: string | null; owned: number; total: number };
  /** A quest item physically in hand, if any (the Baker's fish). */
  carrying?: { icon: string; label: string; hint: string } | null;
}

export interface JournalData {
  stamps: Array<{ icon: string; label: string; has: boolean }>;
  hats: Array<{ icon: string; name: string; owned: boolean }>;
  races: Array<{ label: string; best: number | null }>;
  deliveries: { done: number; total: number };
  coins: number;
  /** Rumor-driven discovery ledger: cryptic lines for what's still out there. */
  secrets?: { found: number; total: number; rumors: string[] };
  /** Visit ledger: distinct days + current no-punishment streak. */
  visits?: { days: number; streak: number };
  /** Earning & building guide (wave 3): each economy loop, built from the
   *  REAL constants in main-simple — never hand-copied numbers. */
  loops?: Array<{ icon: string; title: string; detail: string }>;
}

/**
 * The ONE chip recipe for the top-right HUD column. Every persistent chip
 * (online, coin, feed, Say hi, completion) spreads this and overrides only
 * what genuinely differs (accent color, pointerEvents) — the column used to
 * be five hand-rolled recipes with four backgrounds, three radii and two
 * font sizes, which is exactly how it drifted into the screenshotted mess.
 * Height is FIXED (30px + 38px row pitch = 8px gutters) so the column reads
 * as one designed unit; fontFamily is deliberately absent — the overlay's
 * system UI stack cascades (see createOverlay).
 */
const CHIP: Partial<CSSStyleDeclaration> = {
  position: 'absolute',
  boxSizing: 'border-box',
  height: '30px',
  display: 'flex',
  alignItems: 'center',
  gap: '6px',
  padding: '0 12px',
  borderRadius: '999px',
  fontSize: '13px',
  fontWeight: '600',
  background: 'rgba(12, 16, 28, 0.72)',
  border: '1px solid rgba(255,255,255,0.18)',
  color: '#fff',
  boxShadow: '0 3px 10px rgba(0,0,0,0.3)',
  cursor: 'pointer',
  pointerEvents: 'auto',
  userSelect: 'none',
};

/** Round icon-only variant (🔊 ♿ 🎨 😀 📸 🎒): same skin, 30px circle. */
const CHIP_ICON: Partial<CSSStyleDeclaration> = {
  ...CHIP,
  width: '30px',
  padding: '0',
  justifyContent: 'center',
  borderRadius: '50%',
  fontSize: '15px',
};

/**
 * The owner's identity links, in ONE place. LinkedIn is the PERSONAL profile
 * (the old /in/ slug here was the brand page); GitHub buttons open this
 * island's repo, not the bare org profile; the CV is the web CV on the main
 * site. test/claimsPanels.test.ts pins these.
 */
const OWNER = {
  linkedin: 'https://www.linkedin.com/in/-abbas-ali',
  repo: 'https://github.com/digiscalability/portfolio-island',
  cv: 'https://digiscalability.com/about',
  email: 'admin@digiscalability.com',
} as const;

/** One message in the toast queue (D6): a toast or a flash. */
interface QueuedMessage {
  text: string;
  /** An unprompted line (onboarding, world news) rather than an outcome. */
  hint: boolean;
  kind: 'toast' | 'flash';
  /** The message is stale, and drops, once this returns true: a hint the
   *  visitor already acted on, or an outcome tied to a place they left. */
  until?: () => boolean;
  /** Times it has come on screen: the first show and at most one more. */
  shows: number;
  /** Time on screen so far, ms. Past READ_MS it counts as read. */
  seenMs: number;
  /** When it last came on screen (Date.now()). */
  shownAt: number;
  /** Inside a building (the Leave pill up) when it last showed. */
  inside: boolean;
  /** Where the visitor stood when it last showed: the radar distance to each
   *  fixed landmark (null before the minimap's first update). */
  place: number[] | null;
}

/** A message on screen this long has been read: a modal, an outcome or the
 *  guide that takes it down after that drops it instead of re-queueing it.
 *  Wave-1 integration: '🧭 You have arrived.' showed at the door, stepped
 *  aside for the hall panel and came back inside every hall; the compass
 *  hint showed four times in 26 s on a phone. */
const READ_MS = { outcome: 1000, hint: 1500 } as const;
/** The first show and one more after a step aside, never a third. */
const MAX_SHOWS = 2;
/** A visitor this far (radar units: 1 is the 1.35 rad radar edge, so 0.15 is
 *  about 20 u on the radius-100 world) from where a message last showed has
 *  left that place: a message stepped aside there does not come back. */
const PLACE_MOVE = 0.15;

/** A message stays inside a panel for this long after the visitor's last
 *  action there counts as that panel's own outcome (P2-D3). The message
 *  clocks read Date.now(), which the suites' fake timers move along with
 *  the timers; performance.now() they leave alone. */
const PANEL_ACTION_MS = 8000;

export class SimpleUI {
  private overlay: HTMLElement;
  private loadingDiv: HTMLElement | null = null;
  private welcomeDiv: HTMLElement | null = null;
  private nameModalDiv: HTMLElement | null = null;
  private recordingDiv: HTMLElement | null = null;
  private recordingRaf = 0;
  private passport: Passport | null = null;
  public setPassport(p: Passport): void {
    this.passport = p;
  }
  private interactionDiv: HTMLElement | null = null;
  private fpsDiv: HTMLElement | null = null;
  private playerCountDiv: HTMLElement | null = null;
  private envBadgeDiv: HTMLElement | null = null;
  private customizeDiv: HTMLElement | null = null;
  private zonePanelDiv: HTMLElement | null = null;
  private dialogueDiv: HTMLElement | null = null;
  private dialogueLines: string[] = [];
  private dialogueIndex: number = 0;
  private typewriterTimer: number = 0;
  private typewriterText: string = '';
  private typewriterPos: number = 0;
  private dialogueActive: boolean = false;
  // One registry for every panel (mobile-HUD Round 3): exclusivity, scrim,
  // Escape, and the chip/touch-control hide policy. See PanelManager.ts.
  public panels!: PanelManager;
  // The touch control scheme at boot (D7): on-screen buttons and the phone
  // drawer. A coarse pointer that cannot hover (a phone, a tablet), or the
  // dev flag ?touch=1 exactly. A touchscreen laptop boots the desktop scheme;
  // its first trusted touch on the world reveals the touch controls.
  private readonly isTouch: boolean = SimpleUI.bootTouchScheme();

  /** The boot scheme's test: (pointer: coarse) and (hover: none), or ?touch=1. */
  static bootTouchScheme(): boolean {
    if (typeof window === 'undefined') return false;
    try {
      if (new URLSearchParams(window.location.search).get('touch') === '1') return true;
    } catch {
      /* no location: the media queries decide */
    }
    try {
      const mm = window.matchMedia;
      if (typeof mm !== 'function') return false;
      return (
        mm.call(window, '(pointer: coarse)').matches && mm.call(window, '(hover: none)').matches
      );
    } catch {
      return false;
    }
  }

  /** The touch scheme at boot. A11 and A13 choose copy with it; the input
   *  in use now is getInputMode(). */
  isTouchDevice(): boolean {
    return this.isTouch;
  }

  /** The input in use now (D7): the last trusted key, or the last trusted
   *  pointer's type (a mouse counts as the keyboard scheme). */
  getInputMode(): InputMode {
    return this.lastInput === 'touch' ? 'touch' : 'keyboard';
  }

  /** The HUD root — photo mode hides it for one frame to shoot a clean scene. */
  getOverlay(): HTMLElement {
    return this.overlay;
  }

  // ── Interior enter/exit chrome ─────────────────────────────────────────
  private fadeDiv: HTMLElement | null = null;
  /**
   * The door veil, made ahead. Made in the same task as its first use, the
   * div went in at opacity 0 and was set to 1 before any style pass, so the
   * first door cut straight to black and held the whole 470 ms there.
   */
  private ensureFadeDiv(): HTMLElement {
    if (!this.fadeDiv) {
      this.fadeDiv = document.createElement('div');
      this.fadeDiv.dataset.veil = '1';
      this.fadeDiv.setAttribute('aria-hidden', 'true');
      Object.assign(this.fadeDiv.style, {
        position: 'fixed',
        inset: '0',
        background: '#000',
        opacity: '0',
        // Gentle door bloom — was a brisk 0.28s cut; timings below (470ms
        // mid, 520ms release) are coupled to this duration.
        transition: 'opacity 0.45s ease',
        pointerEvents: 'none',
        zIndex: '2000',
      });
      this.overlay.appendChild(this.fadeDiv);
      // Its opacity-0 style is computed now, so the next change transitions.
      void getComputedStyle(this.fadeDiv).opacity;
    }
    return this.fadeDiv;
  }

  /** Fade to black, run midCb at the peak, fade back in — for door transitions. */
  fadeThrough(midCb: () => void): void {
    hapticPulse(18); // D15: an interaction that worked (a door)
    const d = this.ensureFadeDiv();
    d.style.pointerEvents = 'auto';
    d.style.opacity = '1';
    window.setTimeout(() => {
      try {
        midCb();
      } catch {
        /* keep the fade sane even if the swap throws */
      }
      requestAnimationFrame(() => {
        d.style.opacity = '0';
      });
      window.setTimeout(() => {
        d.style.pointerEvents = 'none';
      }, 520);
    }, 470);
  }

  /** The sections left to lay out ahead; null until the prewarm starts. */
  private zonePrewarmQueue: string[] | null = null;
  /** How many sections the prewarm has laid out (read by the probes). */
  zonePrewarmed = 0;

  /**
   * Lay the zone panel out once ahead, in idle time (w1-fix, CO-A5). The
   * first showZonePanel cost 155-198 ms at 4x CPU, inside the first door's
   * fade, against 11-17 ms on the next call: nearly all of it the first
   * style, layout and glyph pass over the panel's markup (its emoji and text
   * runs), not the markup itself. This lays a hidden copy of each section's
   * panel out, one section per idle slice, hall sections first, and makes
   * the door veil ahead so its first use fades. Nothing is opened, tracked
   * or stamped, and the copy leaves the document in the same task.
   * Idempotent: showWelcome starts it, and A's room warm may call it too.
   */
  prewarmZonePanel(): void {
    this.ensureFadeDiv();
    if (this.zonePrewarmQueue) return;
    this.zonePrewarmQueue = ['welcome', 'professional', 'projects', 'personal', 'contact', 'hire'];
    const step = (): void => {
      const id = this.zonePrewarmQueue?.shift();
      if (!id || this.messagesStopped) return;
      try {
        this.layoutZoneOffscreen(id);
        this.zonePrewarmed++;
        if (this.zonePrewarmQueue?.length) this.whenIdle(step, 600);
      } catch {
        /* a prewarm never breaks the page; the real call builds it anyway */
      }
    };
    this.whenIdle(step, 1200);
  }

  /** requestIdleCallback with a deadline, or a timeout where there is none. */
  private whenIdle(cb: () => void, timeout: number): void {
    const ric = (
      window as unknown as {
        requestIdleCallback?: (c: () => void, o?: { timeout: number }) => number;
      }
    ).requestIdleCallback;
    if (typeof ric === 'function') ric.call(window, cb, { timeout });
    else window.setTimeout(cb, Math.min(timeout, 200));
  }

  /** One section's panel, built and laid out where no one sees it, then gone. */
  private layoutZoneOffscreen(id: string): void {
    const compact = window.innerHeight <= 500;
    const box = document.createElement('div');
    box.setAttribute('aria-hidden', 'true');
    box.setAttribute('inert', '');
    Object.assign(box.style, {
      position: 'fixed',
      left: '0',
      top: '0',
      visibility: 'hidden',
      pointerEvents: 'none',
      contain: 'layout style',
      color: 'white',
      padding: '20px',
      textAlign: 'center',
      fontSize: '15px',
      width: 'min(500px, calc(100vw - 24px))',
      boxSizing: 'border-box',
    });
    // Parsed in a template (an inert document: nothing loads), and without
    // its images, so the prewarm fetches nothing.
    const tpl = document.createElement('template');
    tpl.innerHTML = this.getZoneContent({ id, name: id });
    tpl.content.querySelectorAll('img, iframe, video, audio, source').forEach((n) => n.remove());
    box.appendChild(document.importNode(tpl.content, true));
    const nav = this.sectionNav(id, compact);
    if (nav) box.prepend(nav);
    box.appendChild(this.makeShareButton('🔗 Share this zone', { surface: 'prewarm', url: '' }));
    this.overlay.appendChild(box);
    void box.offsetHeight; // the style, layout and glyph pass, now
    box.remove();
  }

  private leaveBtn: HTMLButtonElement | null = null;
  /** The building's name came with the call (else the hall panel names it). */
  private leaveTitled = false;
  /**
   * The visitor's last real input (D7, replacing P2-D2's local flag): a
   * trusted key, or a trusted pointerdown's pointerType. The touch buttons,
   * the prompt's own click and the touch discs send untrusted keys, which
   * never flip it to the keyboard: the trusted pointerdown before them has
   * already said 'touch' or 'mouse'.
   */
  private lastInput: 'keyboard' | 'mouse' | 'touch' = this.isTouch ? 'touch' : 'mouse';
  private readonly onInputKey = (e: KeyboardEvent): void => {
    if (!e.isTrusted) return;
    // A phone's soft keyboard sends trusted keys too: typing into the chat
    // field, or an IME composing, says nothing about the scheme. A hardware
    // keyboard still switches the mode with any key pressed outside a field.
    if (e.isComposing || e.key === 'Process' || e.key === 'Unidentified') return;
    const t = e.target;
    if (
      t instanceof HTMLElement &&
      (t.isContentEditable || t.matches('input, textarea, select, [contenteditable]'))
    ) {
      return;
    }
    this.setInput('keyboard');
  };
  private readonly onInputPointer = (e: Event): void => {
    if (!e.isTrusted) return;
    const type = (e as PointerEvent).pointerType;
    const touch = type === 'touch' || type === 'pen';
    this.setInput(touch ? 'touch' : 'mouse');
    // A touchscreen laptop boots the desktop scheme: its first trusted touch
    // on the world brings the touch controls in, beside the desktop chips.
    if (touch && !this.isTouch && e.target instanceof HTMLCanvasElement) {
      this.revealTouchControls();
    }
  };

  /** Touch controls fade to 0.35 (style.css, data-touch-idle) after this
   *  long of keyboard-only play. */
  private static readonly TOUCH_IDLE_MS = 10_000;
  private touchIdleTimer = 0;

  /** Record the input in use; a change of mode re-renders the prompt. */
  private setInput(input: 'keyboard' | 'mouse' | 'touch'): void {
    const before = this.getInputMode();
    this.lastInput = input;
    const mode = this.getInputMode();
    trackOnce('input_mode', { mode });
    if (input === 'keyboard') {
      // Ten seconds of keys and nothing else: the touch controls step back.
      if (!this.touchIdleTimer && !this.overlay.hasAttribute('data-touch-idle')) {
        this.touchIdleTimer = window.setTimeout(() => {
          this.touchIdleTimer = 0;
          if (this.lastInput === 'keyboard') this.overlay.setAttribute('data-touch-idle', '1');
        }, SimpleUI.TOUCH_IDLE_MS);
      }
    } else {
      if (this.touchIdleTimer) {
        clearTimeout(this.touchIdleTimer);
        this.touchIdleTimer = 0;
      }
      if (input === 'touch') this.overlay.removeAttribute('data-touch-idle');
    }
    if (mode !== before) this.rerenderPrompt();
  }

  /** The touch controls came in on a desktop-scheme device (D7). */
  private touchRevealed = false;
  private revealTouchControls(): void {
    if (this.touchRevealed || this.isTouch) return;
    this.touchRevealed = true;
    this.createTouchControls(true);
    track('touch_controls_revealed');
  }

  /** The prompt in the mode now in use (its text has not changed). */
  private rerenderPrompt(): void {
    const text = this.lastPromptText;
    if (!text || !this.interactionDiv) return;
    this.lastPromptMode = null;
    this.showInteractionPrompt(text);
  }

  /**
   * "← Leave", shown while inside a building (P2-D2, INT-07): a real button
   * with a name, a focus ring and a 44 px box, where there was a div only a
   * mouse could use. It is the overlay's FIRST child, so the first Tab from
   * the room lands on it, and it takes focus itself when the visitor came in
   * by keyboard. The HUD steps aside for the room ('interior' mode: the
   * minimap, the weather chip and stamina, and the touch actions with no
   * use indoors), and the live region says where the visitor is and how to
   * get out, once per entry.
   *
   * `title` is the building's name. Without one, a hall's panel names it
   * (showZonePanel, in the same task), else it is 'the building'.
   */
  showLeaveButton(onLeave: () => void, title?: string): void {
    this.hideLeaveButton();
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = '← Leave';
    b.dataset.leave = '1';
    Object.assign(b.style, {
      position: 'fixed',
      top: 'calc(var(--sat, 0px) + 14px)',
      left: 'calc(var(--sal, 0px) + 14px)',
      boxSizing: 'border-box',
      minHeight: '44px',
      background: 'rgba(12,16,28,0.82)',
      color: '#fff',
      padding: '9px 16px',
      borderRadius: '999px',
      border: '1px solid rgba(255,255,255,0.25)',
      fontSize: '14px',
      fontWeight: '600',
      fontFamily: 'system-ui, sans-serif',
      cursor: 'pointer',
      pointerEvents: 'auto',
      userSelect: 'none',
      zIndex: '1900',
      boxShadow: '0 3px 10px rgba(0,0,0,0.4)',
    });
    b.addEventListener('click', () => onLeave());
    // Never inert: a hall panel (a modal) is open whenever this is, and the
    // way out must stay a click away over it (D4).
    b.dataset.neverInert = '1';
    this.leaveBtn = b;
    this.leaveTitled = false;
    this.overlay.prepend(b);
    this.setLeaveTitle(title?.trim() || '');
    this.leaveTitled = !!title?.trim();
    this.panels.setMode('interior', { hides: ['ambient-info', 'outdoor-actions'], hard: true });
    // By keyboard (E at the door): focus goes to the way out. A hall's panel
    // takes it from here a moment later, and hands it back to the room.
    if (this.lastInput === 'keyboard') {
      try {
        b.focus({ preventScroll: true });
      } catch {
        b.focus();
      }
    }
    // A task later: a hall's panel, opened right after this, may name the
    // building. Said once per entry.
    queueMicrotask(() => {
      if (this.leaveBtn !== b) return;
      const name = b.dataset.title || 'the building';
      this.announce(
        this.isTouch
          ? `Inside ${name}. Tap Leave or walk to the door to leave.`
          : `Inside ${name}. Press Escape or walk to the door to leave.`,
        SimpleUI.ROOM_ANNOUNCE_HOLD_MS,
      );
    });
  }

  /** The room announcement keeps the live region this long. */
  private static readonly ROOM_ANNOUNCE_HOLD_MS = 2500;

  /** Name the building on the Leave button ('' : the default). */
  private setLeaveTitle(title: string): void {
    const b = this.leaveBtn;
    if (!b) return;
    if (title) b.dataset.title = title;
    else delete b.dataset.title;
    const label = `Leave ${title || 'the building'}`;
    b.setAttribute('aria-label', label);
    b.title = label;
  }

  hideLeaveButton(): void {
    const b = this.leaveBtn;
    if (!b) return;
    // Focus goes back to the body: a removed button would strand it.
    if (document.activeElement === b) b.blur();
    b.remove();
    this.leaveBtn = null;
    this.leaveTitled = false;
    this.liveHoldUntil = 0; // outdoors again: the room line holds nothing back
    this.panels.setMode('interior', null);
  }

  constructor(id: string) {
    // Create or get overlay
    // The chrome's icon sprite (D13), once per page.
    if (typeof document !== 'undefined' && document.body) ensureIconSprite();
    this.overlay = document.getElementById(id) as HTMLElement;
    if (!this.overlay) {
      this.overlay = document.createElement('div');
      this.overlay.id = id;
      document.body.appendChild(this.overlay);
    }

    // Style the overlay
    Object.assign(this.overlay.style, {
      position: 'fixed',
      top: '0',
      left: '0',
      width: '100%',
      height: '100%',
      pointerEvents: 'none',
      zIndex: '1000',
      // Match the site's own stack (style.css) — the old 'Arial' here
      // overrode it for every HUD child and read dated next to system-ui.
      // D12: the system UI stack (index.html's --font-ui); Inter is dropped.
      fontFamily:
        "var(--font-ui, system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif)",
    });
    // Safe-area insets published as inheriting custom properties so every
    // edge-anchored HUD child can offset itself off notches / home
    // indicators with calc(var(--sa*) + Npx). Resolve to 0 on desktop.
    this.overlay.style.setProperty('--sat', 'env(safe-area-inset-top, 0px)');
    this.overlay.style.setProperty('--sar', 'env(safe-area-inset-right, 0px)');
    this.overlay.style.setProperty('--sab', 'env(safe-area-inset-bottom, 0px)');
    this.overlay.style.setProperty('--sal', 'env(safe-area-inset-left, 0px)');

    // Back closes the open panel (its pushed history entry); an entry left
    // over from a closed panel loses its ?zone= when the visitor lands on it.
    // A keyboard-opened panel whose opener has gone (a menu row) hands focus
    // to the Portfolio pill, or to ☰ on a phone, where the pill is a drawer row.
    if (!this.panels)
      this.panels = new PanelManager(this.overlay, this.isTouch, {
        onStaleEntry: () => setUrlParam('zone', null),
        fallbackFocus: () => (this.isTouch ? this.drawerToggleEl : this.portfolioBtnEl),
      });
    this.initMessageSignals();
    this.createFPSDisplay();
    this.createMuteButton();
    this.createPortfolioButton();
    this.createContactCTA();
    this.createHiringChip();
    this.createPhotoButton();
    this.createSayHiButton();
    this.createCompletionButton();
    this.createInventoryButton();
    this.createControlsRow();
    this.createEmoteButton();
    this.createTouchControls();
    this.initResponsiveHud();
    // ? or H: the Controls & settings sheet (D8).
    window.addEventListener('keydown', this.onControlsKey);
    // Keyboard or pointer: where the Leave button puts focus (P2-D2).
    document.addEventListener('keydown', this.onInputKey, true);
    document.addEventListener('pointerdown', this.onInputPointer, true);
  }

  /**
   * Watch for short-landscape phones and reflow the minimap off the left-edge
   * chat/mic stack. Portrait restores the full-size disc. The change handler
   * early-returns unless the boolean actually flips, so a spurious media event
   * never triggers layout work.
   */
  private initResponsiveHud(): void {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    this.shortLandscapeMql = window.matchMedia('(max-height: 500px) and (orientation: landscape)');
    this.shortLandscape = this.shortLandscapeMql.matches;
    this.onShortLandscapeChange = () => {
      const v = this.shortLandscapeMql!.matches;
      if (v === this.shortLandscape) return; // no thrash
      this.shortLandscape = v;
      this.applyResponsiveHud();
    };
    this.shortLandscapeMql.addEventListener?.('change', this.onShortLandscapeChange);
    // Narrow portrait (iPhone SE class, 375x667): the 172px radar is 46% of
    // the screen width, and the top bar's three tenants (compass pill /
    // tier-1 chips / radar) measured three overlapping pairs. Recompose, not
    // scale: smaller radar, chips drop to a second row below the compass.
    this.narrowPortraitMql = window.matchMedia('(max-width: 400px) and (orientation: portrait)');
    this.narrowPortrait = this.narrowPortraitMql.matches;
    this.onNarrowPortraitChange = () => {
      const v = this.narrowPortraitMql!.matches;
      if (v === this.narrowPortrait) return;
      this.narrowPortrait = v;
      this.applyResponsiveHud();
    };
    this.narrowPortraitMql.addEventListener?.('change', this.onNarrowPortraitChange);
    this.applyResponsiveHud();
  }

  /** Apply the current breakpoint state to reflowable HUD elements. */
  private applyResponsiveHud(): void {
    const short = this.shortLandscape;
    const narrow = this.narrowPortrait && !short;
    if (this.mapCanvas) {
      // Shrink the 172px disc (60% short-landscape, 70% narrow-portrait) and
      // seat it clear of its neighbours. Restore is the EXPLICIT '172px' —
      // '' used to fall back to the attribute size, which the DPR backing
      // store made 344.
      this.mapCanvas.style.width = short ? '104px' : narrow ? '120px' : '172px';
      this.mapCanvas.style.height = 'auto';
      this.mapCanvas.style.top = short
        ? 'calc(var(--sat, 0px) + 8px)'
        : 'calc(var(--sat, 0px) + 44px)';
    }
    // Tier-1 chips drop below the compass line on narrow portrait (top 35
    // overlapped the compass pill's y14-53 band by 18px); the emote chip and
    // drawer follow, keeping their 8px rhythm.
    if (this.tier1Row) {
      this.tier1Row.style.top = narrow
        ? 'calc(var(--sat, 0px) + 58px)'
        : 'calc(var(--sat, 0px) + 35px)';
    }
    if (this.emoteBtnEl) {
      this.emoteBtnEl.style.top = narrow
        ? 'calc(var(--sat, 0px) + 110px)'
        : 'calc(var(--sat, 0px) + 88px)';
    }
    if (this.drawerListEl) {
      this.drawerListEl.style.top = narrow
        ? 'calc(var(--sat, 0px) + 106px)'
        : 'calc(var(--sat, 0px) + 84px)';
    }
    if (this.interactionDiv) this.applyPromptAnchor(this.interactionDiv);
    if (this.toastEl) this.applyToastAnchor(this.toastEl);
    if (this.bulletinEl) this.bulletinEl.style.top = this.bulletinTop();
    // Short landscape (SE on its side, 667x375): the emote chip sits at
    // right+10 and the 74px action column at right+26 — in PORTRAIT they
    // never meet (WAVE is 300px lower), but landscape lifts WAVE into the
    // emote's row and the two MEASURED a 27x33 overlap with both taking
    // taps. Push the emote clear of the column.
    if (this.emoteBtnEl) {
      // Restore branches by surface: touch tier-2 lives at right+10 (108 in
      // short landscape, clear of the action column), desktop sits in the
      // icon row at +124 at EVERY height — the short branch must be gated on
      // isTouch too, or a short DESKTOP window (max-height 500 is just a
      // resized browser) parks 😀 on the 🎨 slot.
      this.emoteBtnEl.style.right = this.isTouch
        ? short
          ? // 194, not 108: DIVE now tops the SECOND column (right 112-186,
            // y≈89-163 while swimming in short landscape) — 108 parked the
            // emote inside that box. 194 clears both columns.
            'calc(var(--sar, 0px) + 194px)'
          : 'calc(var(--sar, 0px) + 10px)'
        : 'calc(var(--sar, 0px) + 124px)';
    }
    // Same class of bug on the left: short-landscape raises the radar to
    // top+8, straight under the day/weather badge at top+10 (measured 64x26).
    if (this.envBadgeDiv) {
      this.envBadgeDiv.style.left = short
        ? 'calc(var(--sal, 0px) + 122px)'
        : 'calc(var(--sal, 0px) + 10px)';
    }
    // The 52px 🎤 stacked over 💬 would reach y≈89 on a 375-tall screen,
    // into the radar (top 8, 104 tall): short landscape seats it beside 💬,
    // still above the joystick's 166px hit square.
    if (this.micBtn) {
      Object.assign(this.micBtn.style, {
        left: short ? 'calc(var(--sal, 0px) + 86px)' : 'calc(var(--sal, 0px) + 26px)',
        bottom: short ? 'calc(var(--sab, 0px) + 174px)' : 'calc(var(--sab, 0px) + 234px)',
      });
    }
  }

  /**
   * Interaction-prompt placement per breakpoint. It is TAPPABLE (fires the
   * synthetic KeyE), so unlike the purely visual lanes it must clear the
   * joystick's 166px hit square and the action column outright — a prompt
   * over either one steals the input.
   */
  private applyPromptAnchor(el: HTMLElement): void {
    if (!this.isTouch) {
      Object.assign(el.style, {
        bottom: 'calc(var(--sab, 0px) + 100px)',
        left: '50%',
        maxWidth: 'min(440px, calc(100vw - 32px))',
      });
      return;
    }
    if (this.shortLandscape) {
      // The free band in landscape is the horizontal centre, between the
      // joystick (x<=166) and the action column (x>=567 at 667 wide).
      // Nudged right of true centre so the pill sits inside it.
      Object.assign(el.style, {
        bottom: 'calc(var(--sab, 0px) + 36px)',
        left: 'calc(50% + 30px)',
        maxWidth: 'min(56vw, 340px)',
      });
      return;
    }
    // Portrait: above the whole control band. max-content up to 440 (D6):
    // a shrink-to-fit box at left 50% was 195 px wide at 390, so 'Tap USE
    // to talk to Elder Sage — ask anything' wrapped to three lines.
    Object.assign(el.style, {
      bottom: 'calc(var(--sab, 0px) + 300px)',
      left: '50%',
      maxWidth: 'min(440px, calc(100vw - 32px))',
    });
  }

  /**
   * Toast placement. The bottom lane is stacked (chat-input 96 · breath 150 ·
   * recording 200 · toast 250), but 250 from the bottom of a 375-tall
   * LANDSCAPE screen is y88-125 — inside the top-centre bulletin's y66-126.
   * The two "opposite ends of the screen" lanes literally intersect there,
   * so landscape drops the toast into the lower half.
   */
  /**
   * Bulletin lane. The default top+66 sits between the radar and the chip
   * row on a roomy screen; on both small-phone breakpoints it lands ON one
   * of them, so each gets its own clearance (all three measured):
   * - short landscape: below the tier-1 chips (top+35, 44 tall) — 53x13.
   * - narrow portrait: below BOTH the pushed-down chips (top+58, ending
   *   y102) and the radar (top+44, 120px, ending y164) — 36x36 and 36x98.
   *   A centred full-width banner can never clear a left-hand radar
   *   sideways, so it clears it vertically.
   */
  private bulletinTop(): string {
    if (!this.isTouch) return 'calc(var(--sat, 0px) + 66px)';
    if (this.shortLandscape) return 'calc(var(--sat, 0px) + 88px)';
    if (this.narrowPortrait) return 'calc(var(--sat, 0px) + 172px)';
    return 'calc(var(--sat, 0px) + 66px)';
  }

  private applyToastAnchor(el: HTMLElement): void {
    const short = this.isTouch && this.shortLandscape;
    const guide = this.guideRect();
    // Desktop: the bulletin's lane under the compass pill whenever no
    // bulletin is up (FM-09: the bottom +250 lane covered the avatar's
    // torso), and First steps' card is clear of it (a desktop window 500 px
    // tall or less puts the card at top +60 too, A6). Narrow windows keep
    // the bottom lane, clear of the icon row.
    if (!this.isTouch && !this.bulletinShowing() && window.innerWidth >= 900) {
      el.dataset.lane = 'top';
      delete el.dataset.bottom;
      // While the race HUD shows, the lane drops below its measured bottom.
      const race = this.raceVisible ? this.raceDiv?.getBoundingClientRect() : null;
      Object.assign(el.style, {
        top:
          race && race.height > 0
            ? `${Math.ceil(race.bottom + 8)}px`
            : 'calc(var(--sat, 0px) + 66px)',
        bottom: '',
        maxWidth: 'min(92vw, 440px)',
        left: '50%',
      });
      if (!guide || !SimpleUI.near(el.getBoundingClientRect(), guide)) return;
    }
    el.dataset.lane = 'bottom';
    // Portrait touch: 350, not 250 — the action column starts at y381 on a
    // 667-tall screen, so the 250 lane put toast text straight across the
    // WAVE button (measured 74x36). 350 clears it and still sits below the
    // prompt's 300 lane.
    let bottom = short ? 96 : this.isTouch ? 350 : 250;
    // On touch the toast sits ABOVE the interaction prompt, 8 px clear (D6):
    // a two-line prompt reached into the 350 lane.
    const prompt = this.interactionDiv;
    if (this.isTouch && prompt?.isConnected) {
      const r = prompt.getBoundingClientRect();
      if (r.height > 0 && getComputedStyle(prompt).display !== 'none') {
        bottom = Math.max(bottom, Math.ceil(window.innerHeight - r.top + 8));
      }
    }
    const place = (px: number): void => {
      el.dataset.bottom = String(px); // the offset as data, for the probes and the tests
      Object.assign(el.style, {
        top: '',
        bottom: `calc(var(--sab, 0px) + ${px}px)`,
        maxWidth: short ? 'min(56vw, 360px)' : 'min(92vw, 440px)',
        // Landscape: nudged into the free centre band like the prompt, so
        // the pill clears the joystick ring instead of grazing it.
        left: short ? 'calc(50% + 30px)' : '50%',
      });
    };
    place(bottom);
    // First steps' card (A6): the toast steps above it, 8 px clear, only
    // where the card is in its lane and there is room above the card below
    // the compass pill. That is the phone's card, low on the screen. In short
    // landscape the card sits in a top lane (top +60), and lifting over it
    // put every toast on the compass pill (124x37 at 844x390, wave-1
    // integration); the 96 px lane is clear of that card.
    if (guide) {
      const r = el.getBoundingClientRect();
      if (SimpleUI.near(r, guide) && guide.top - 8 - r.height >= this.topClear()) {
        place(Math.max(bottom, Math.ceil(window.innerHeight - guide.top + 8)));
      }
    }
  }

  /**
   * The flash's place: centred at 38% of the height, unless First steps'
   * card is there. Then it goes 8 px above the card where that fits below
   * the compass pill (a phone's card, low on the screen), else 8 px below it
   * (short landscape, where A6 puts the card at top +60: the 38% flash
   * covered the card's last line, 226x33 px at 844x390 and 267x38 at
   * 667x375, wave-1 integration). Re-run while the flash shows (watchShown):
   * the card changes with each step and folds to its chip.
   */
  private anchorFlash(el: HTMLElement): void {
    const guide = this.guideRect();
    const vh = window.innerHeight;
    const h = el.offsetHeight;
    const w = el.offsetWidth;
    let mid: number | null = null; // the flash's centre, when it moves
    if (guide && h > 0) {
      const at = new DOMRect(window.innerWidth / 2 - w / 2, vh * 0.38 - h / 2, w, h);
      if (SimpleUI.near(at, guide)) {
        if (guide.top - 8 - h >= this.topClear()) mid = guide.top - 8 - h / 2;
        else if (guide.bottom + 8 + h <= vh - 8) mid = guide.bottom + 8 + h / 2;
      }
    }
    el.style.top = mid === null ? '38%' : `${Math.round(mid)}px`;
    if (mid === null) delete el.dataset.lane;
    else el.dataset.lane = 'guide';
  }

  /** First steps' card or chip (A6, #ds-guide) where it stands on screen,
   *  or null while it is hidden. A card still fading in counts: GuideCard
   *  shows each card and the NextChip with a 180 ms opacity animation from
   *  0, and the resize that tells watchShown the chip arrived comes in its
   *  first frame. Read as hidden then, the "Compass set" toast stayed on the
   *  chip until the next 120 ms poll (wave-2 integration, 390x844, 1 run in
   *  2; 2 runs in 14 here before this). */
  private guideRect(): DOMRect | null {
    const g = typeof document === 'undefined' ? null : document.getElementById('ds-guide');
    if (!g?.isConnected) return null;
    const cs = getComputedStyle(g);
    if (cs.display === 'none' || cs.visibility === 'hidden') return null;
    if (parseFloat(cs.opacity) < 0.05) {
      const fading =
        typeof g.getAnimations === 'function' &&
        g.getAnimations().some((a) => a.playState === 'running' || a.pending);
      if (!fading) return null;
    }
    const r = g.getBoundingClientRect();
    return r.width > 0 && r.height > 0 ? r : null;
  }

  /** The highest a lifted toast or a moved flash may reach: 8 px under the
   *  compass pill, or 8 px from the top while the pill is hidden. */
  private topClear(): number {
    const c = this.compassDiv;
    if (c?.isConnected && c.style.display !== 'none') {
      const r = c.getBoundingClientRect();
      if (r.height > 0) return r.bottom + 8;
    }
    return 8;
  }

  /** Do two boxes meet, or come within `pad` px of each other? */
  private static near(a: DOMRect, b: DOMRect, pad = 8): boolean {
    return (
      a.width > 0 &&
      a.height > 0 &&
      a.left < b.right + pad &&
      b.left < a.right + pad &&
      a.top < b.bottom + pad &&
      b.top < a.bottom + pad
    );
  }

  // ── Mobile chip drawer (mobile-HUD Round 3, Phase 3) ──────────────────
  // Touch only. Desktop keeps the authored top-right chip column untouched.
  // Genre synthesis: one ☰ owns all secondary functions (Genshin), fan-out
  // with auto-collapse (Pocket Camp), ambient info stays while actions hide
  // (Sky:CotL). Tier 1 row: [👥][🪙][☰]. Tier 2: 😀 alone. Everything else
  // fans out of ☰ as labeled pills.

  private tier1Row: HTMLElement | null = null;
  private drawerListEl: HTMLElement | null = null;
  private drawerToggleEl: HTMLElement | null = null;
  private drawerCatcher: HTMLElement | null = null;
  private drawerOpen = false;
  private drawerIdleTimer: number | undefined;
  private emoteBtnEl: HTMLElement | null = null;

  /** Tier-1 host row (touch): one flex row, registered ONCE as nav-chips. */
  private getTier1Row(): HTMLElement {
    if (this.tier1Row) return this.tier1Row;
    const row = document.createElement('div');
    Object.assign(row.style, {
      position: 'absolute',
      top: 'calc(var(--sat, 0px) + 35px)',
      right: 'calc(var(--sar, 0px) + 10px)',
      display: 'flex',
      gap: '8px',
      alignItems: 'center',
      pointerEvents: 'none', // chips carry their own pointerEvents:auto
      zIndex: '1500',
    });
    this.overlay.appendChild(row);
    this.panels.registerLayer('nav-chips', row);
    this.tier1Row = row;
    return row;
  }

  /** Move a chip into the tier-1 row (touch). The 🪙/feed chips are created
   *  lazily AFTER ☰, so they insert BEFORE the toggle to keep [👥][🪙][☰]. */
  private tierChip(el: HTMLElement): void {
    // relative, NOT static: it flows in the flex row the same, but keeps the
    // chip a containing block so the .hud-btn::after 44px tap pad anchors to
    // THE CHIP — static re-anchored every pad to the whole row and scrambled
    // hit-testing across it (verified on the SE audit).
    Object.assign(el.style, { position: 'relative', top: '', right: '', left: '', bottom: '' });
    const row = this.getTier1Row();
    if (this.drawerToggleEl && this.drawerToggleEl.parentElement === row) {
      row.insertBefore(el, this.drawerToggleEl);
    } else {
      row.appendChild(el);
    }
  }

  /**
   * Home a secondary chip. Desktop: authored absolute spot + nav-chips layer
   * (zero change from today). Touch: re-homed into the ☰ drawer as a labeled
   * 40px pill row. `label` wraps chips whose own textContent is icon-only or
   * DYNAMIC (mute swaps 🔇/🔊, completion rewrites '🏝 n%') — a label span
   * INSIDE those would be wiped by their textContent writes, so it lives in
   * a wrapper row that forwards taps to the chip.
   */
  private chipHost(
    el: HTMLElement,
    opts: { drawer?: boolean; label?: string; order?: number } = {},
  ): void {
    if (!this.isTouch || !opts.drawer) {
      this.overlay.appendChild(el);
      this.panels.registerLayer('nav-chips', el);
      return;
    }
    // One row shape for every item (D13): 44 px tall, a 24 px icon, then a
    // 15 px/600 label, so every label starts at the same x. An icon-only chip
    // takes its label inside it; a frozen label's emoji takes the icon slot.
    Object.assign(el.style, {
      // relative, NOT static — same in-flow layout, but the chip stays a
      // containing block for its .hud-btn::after tap pad (see tierChip).
      position: 'relative',
      top: '',
      right: '',
      left: '',
      bottom: '',
      height: '', // clear the CHIP recipe's fixed 30px — drawer rows are 44px
      width: '100%',
      boxSizing: 'border-box',
      minHeight: '44px',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'flex-start',
      gap: '12px',
      padding: '0 12px',
      borderRadius: '10px',
      fontSize: '15px',
      fontWeight: '600',
    });
    el.classList.add('ds-drawer-row');
    // The CHIP recipe's 1 px border on every row, so a borderless pill's
    // label does not start a pixel left of the rest.
    if (!el.style.borderStyle) el.style.border = '1px solid transparent';
    if (opts.label) SimpleUI.chipText(el, opts.label);
    else SimpleUI.slotLeadingEmoji(el);
    // The CTA rows (Work with me, Hiring) carry a 3 px left accent, drawn
    // inside the row so it moves no label.
    if (opts.order === 1 || opts.order === 2) el.classList.add('ds-drawer-cta');
    // Business priority beats creation order: flex `order` puts Work-with-me
    // in slot #1 regardless of which create* ran first.
    if (opts.order !== undefined) el.style.order = String(opts.order);
    this.getDrawerList().appendChild(el);
  }

  /** The drawer's (initially hidden) pill column + the ☰ toggle that owns it. */
  private getDrawerList(): HTMLElement {
    if (this.drawerListEl) return this.drawerListEl;
    const list = document.createElement('div');
    Object.assign(list.style, {
      position: 'absolute',
      top: 'calc(var(--sat, 0px) + 84px)',
      right: 'calc(var(--sar, 0px) + 10px)',
      display: 'none',
      flexDirection: 'column',
      gap: '6px',
      padding: '10px',
      background: 'rgba(12,12,20,0.94)',
      border: '1px solid rgba(255,255,255,0.15)',
      borderRadius: '14px',
      boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
      pointerEvents: 'auto',
      zIndex: '1510',
      // Short-landscape phones: scroll instead of running off the screen.
      maxHeight: 'calc(100dvh - var(--sat, 0px) - var(--sab, 0px) - 140px)',
      overflowY: 'auto',
    });
    // Selection auto-collapse. Chips that open a PANEL already collapse the
    // drawer for free (the open() exclusivity sweep closes it); this covers
    // the stateless chips (mute, reduced motion, photo). Deferred a tick so
    // the chip's own handler runs against a live DOM.
    list.addEventListener('click', () => {
      window.setTimeout(() => this.closeDrawer(), 0);
    });
    this.overlay.appendChild(list);
    this.drawerListEl = list;

    const t = document.createElement('div');
    t.appendChild(iconNode('menu', 22));
    Object.assign(t.style, {
      width: '44px',
      height: '44px',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: 'rgba(0, 0, 0, 0.55)',
      borderRadius: '10px',
      fontSize: '17px',
      color: '#fff',
      cursor: 'pointer',
      pointerEvents: 'auto',
      userSelect: 'none',
      position: 'relative',
    });
    // One-time discoverability pulse: "Work with me" moved a tap deep, the
    // dot says where it went. Cleared forever on first open.
    let dot: HTMLElement | null = null;
    try {
      if (!localStorage.getItem('ds_drawer_seen')) {
        dot = document.createElement('span');
        Object.assign(dot.style, {
          position: 'absolute',
          top: '4px',
          right: '4px',
          width: '9px',
          height: '9px',
          borderRadius: '50%',
          background: '#12b76a',
          boxShadow: '0 0 6px rgba(18,183,106,0.9)',
          animation: a11y.reducedMotion ? '' : 'ds-drawer-pulse 1.6s ease-in-out infinite',
        });
        t.appendChild(dot);
        const style = document.createElement('style');
        style.textContent =
          '@keyframes ds-drawer-pulse { 0%,100% { transform: scale(1); } 50% { transform: scale(1.45); } }';
        document.head.appendChild(style);
      }
    } catch {
      /* no storage — no dot */
    }
    t.addEventListener('click', (e) => {
      e.stopPropagation();
      if (dot) {
        dot.remove();
        dot = null;
        try {
          localStorage.setItem('ds_drawer_seen', '1');
        } catch {
          /* fine */
        }
      }
      this.toggleDrawer();
    });
    this.makeHudButtonAccessible(t, 'Open island menu');
    t.dataset.guide = 'drawer-toggle'; // First steps rings it (A6)
    list.id = 'ds-drawer';
    list.setAttribute('role', 'group');
    list.setAttribute('aria-label', 'Island menu');
    t.setAttribute('aria-controls', 'ds-drawer');
    t.setAttribute('aria-expanded', 'false');
    this.drawerToggleEl = t;
    this.getTier1Row().appendChild(t);
    return list;
  }

  private toggleDrawer(): void {
    if (this.drawerOpen) {
      this.closeDrawer();
      return;
    }
    const list = this.getDrawerList();
    this.drawerOpen = true;
    track('drawer_opened');
    // Registered as a panel so ANY panel opening collapses the drawer free
    // via the exclusivity sweep. Hides the touch controls while open: the
    // WAVE/JUMP column (z1650) otherwise paints OVER the drawer list (z1510)
    // and steals its taps — on an iPhone SE the last two rows (Sound, Reduce
    // motion) were half-covered by WAVE.
    this.panels.open('drawer', {
      kind: 'sheet',
      hides: ['touch-controls', 'aux-controls'],
      close: () => this.closeDrawer(),
      history: false, // transient: Back is not spent on it
    });
    list.style.display = 'flex';
    this.drawerToggleEl?.setAttribute('aria-expanded', 'true');
    // 😀 tier-2 chip yields its spot while the drawer occupies it.
    if (this.emoteBtnEl) this.emoteBtnEl.style.visibility = 'hidden';
    // Staggered 22ms slide-in per row; instant under reduced motion.
    const rows = Array.from(list.children) as HTMLElement[];
    rows.forEach((r, i) => {
      if (a11y.reducedMotion) {
        r.style.opacity = '1';
        r.style.transform = '';
        return;
      }
      r.style.opacity = '0';
      r.style.transform = 'translateX(14px)';
      r.style.transition = 'opacity 0.16s ease, transform 0.16s ease';
      window.setTimeout(() => {
        r.style.opacity = '1';
        r.style.transform = '';
      }, 22 * i);
    });
    // Outside tap closes (transparent catcher UNDER the drawer's z).
    const catcher = document.createElement('div');
    Object.assign(catcher.style, {
      position: 'fixed',
      inset: '0',
      zIndex: '1505',
      pointerEvents: 'auto',
      background: 'transparent',
    });
    catcher.addEventListener('click', () => this.closeDrawer());
    this.overlay.appendChild(catcher);
    this.drawerCatcher = catcher;
    // 8s IDLE auto-collapse — idle meaning untouched. The timer re-arms on
    // any interaction with the list (scroll, touch, press, and keyboard focus
    // or keys), otherwise the drawer vanished mid-read under a slow reader's
    // finger. It never collapses while focus is inside it: a keyboard user
    // walking the rows would lose them, and the focus with them (D4).
    const arm = (): void => {
      if (this.drawerIdleTimer) clearTimeout(this.drawerIdleTimer);
      this.drawerIdleTimer = window.setTimeout(() => {
        if (this.drawerListEl?.contains(document.activeElement)) arm();
        else this.closeDrawer();
      }, 8000);
    };
    if (!list.dataset.idleRearm) {
      list.dataset.idleRearm = '1';
      for (const ev of ['pointerdown', 'scroll', 'touchmove', 'focusin', 'keydown'] as const) {
        list.addEventListener(ev, () => this.drawerOpen && arm(), { passive: true });
      }
    }
    arm();
  }

  private closeDrawer(): void {
    if (!this.drawerOpen) return;
    this.drawerOpen = false;
    if (this.drawerIdleTimer) {
      clearTimeout(this.drawerIdleTimer);
      this.drawerIdleTimer = undefined;
    }
    this.drawerCatcher?.remove();
    this.drawerCatcher = null;
    if (this.drawerListEl) this.drawerListEl.style.display = 'none';
    this.drawerToggleEl?.setAttribute('aria-expanded', 'false');
    if (this.emoteBtnEl) this.emoteBtnEl.style.visibility = '';
    this.panels.notifyClosed('drawer'); // no-op during a sweep
  }

  // ── UX chrome ─────────────────────────────────────────────────────────

  private muteBtn: HTMLElement | null = null;
  private onMuteToggle: (() => boolean) | null = null;
  private joyState = { forward: 0, strafe: 0 };
  // Short-landscape phones (max-height 500 + landscape): the portrait-tuned
  // 172px minimap covers ~46% of the screen and collides with the left-edge
  // 💬/🎤 stack. Tracked so a media change that doesn't flip this does no work.
  private shortLandscape = false;
  private shortLandscapeMql: MediaQueryList | null = null;
  private onShortLandscapeChange: (() => void) | null = null;
  private narrowPortrait = false;
  private narrowPortraitMql: MediaQueryList | null = null;
  private onNarrowPortraitChange: (() => void) | null = null;
  private mapDpr = 1; // minimap backing-store scale (min(devicePixelRatio, 2))
  private onMinimapClick: (() => void) | null = null;

  /** App hook: tapping the minimap (or pressing M) opens the island map. */
  public setOnMinimapClick(cb: () => void): void {
    this.onMinimapClick = cb;
  }

  /**
   * Full island map (expansion: "make the map clickable and expandable").
   * Top-down polar view from the pole — every shop, provider and free build
   * plot, each clickable to set the compass. `onPick` receives the chosen POI.
   */
  public showIslandMap(
    pois: Array<{
      icon: string;
      label: string;
      pos: { x: number; y: number; z: number };
      /** District accent (zone POIs only) — halo + legend chip border. */
      color?: string;
      /** A sprite glyph in place of the emoji (P2-D8). Without one, '📦' and
       *  a parcel or delivery label take the parcel glyph, and Contact's '📬'
       *  the mail glyph, so the two never read alike. */
      glyph?: 'parcel' | 'mail';
    }>,
    onPick: (poi: {
      icon: string;
      label: string;
      pos: { x: number; y: number; z: number };
    }) => void,
    opts?: {
      /** You-are-here marker + heading arrow. */
      playerPos?: { x: number; y: number; z: number } | null;
      playerFwd?: { x: number; y: number; z: number } | null;
      /** The compass pill's current target — haloed so the map visibly
       *  agrees with the pill that opened it. */
      targetPos?: { x: number; y: number; z: number } | null;
    },
  ): void {
    const modal = this.buildCenteredModal('min(92vw, 520px)', 'island-map');
    const title = document.createElement('h2');
    title.textContent = '🗺️ Island map';
    Object.assign(title.style, { margin: '0 0 8px', color: '#8a9bff', fontSize: '17px' });
    modal.appendChild(title);
    const hint = document.createElement('p');
    hint.textContent = 'Tap anything to set your compass to it.';
    Object.assign(hint.style, { margin: '0 0 10px', fontSize: '13px', color: '#aab' });
    modal.appendChild(hint);

    // Height-aware: width-only sizing produced a 430px disc on a 375px-tall
    // landscape phone — taller than the screen. 0.62×height leaves room for
    // the modal's title/hint/legend, so the whole round map fits unscrolled.
    const D = Math.min(
      430,
      Math.floor(window.innerWidth * 0.8),
      Math.floor(window.innerHeight * 0.62),
    );
    const dpr = Math.min(window.devicePixelRatio || 1, 2); // the minimap DPR lesson
    const canvas = document.createElement('canvas');
    canvas.width = D * dpr;
    canvas.height = D * dpr;
    Object.assign(canvas.style, {
      width: `${D}px`,
      height: `${D}px`,
      borderRadius: '50%',
      cursor: 'pointer',
      display: 'block',
      margin: '0 auto',
    });
    modal.appendChild(canvas);
    const ctx = canvas.getContext('2d');
    const hits: Array<{ x: number; y: number; poi: (typeof pois)[number] }> = [];
    // The parcel and Contact's mail never share a glyph (P2-D8).
    const glyphOf = (poi: (typeof pois)[number]): 'parcel' | 'mail' | null =>
      poi.glyph ??
      (poi.icon === '📦' || /\b(parcel|deliver)/i.test(poi.label)
        ? 'parcel'
        : poi.icon === '📬'
          ? 'mail'
          : null);
    // No 2D context (a locked-down browser, a test DOM): the legend below is
    // still the whole map, as it is for a screen reader.
    if (ctx) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const cx = D / 2;
      const cy = D / 2;
      const R = D / 2 - 6;
      // Polar projection from the pole: r grows with distance from the pole
      // (lat π/2 = centre, shore lat ~0.24 = rim).
      const SHORE_LAT = 0.2;
      const project = (pos: { x: number; y: number; z: number }): { x: number; y: number } => {
        const len = Math.hypot(pos.x, pos.y, pos.z) || 1;
        const lat = Math.asin(Math.max(-1, Math.min(1, pos.y / len)));
        const lon = Math.atan2(pos.z, pos.x);
        const r = (R * (Math.PI / 2 - lat)) / (Math.PI / 2 - SHORE_LAT);
        return { x: cx + Math.cos(lon) * Math.min(r, R), y: cy + Math.sin(lon) * Math.min(r, R) };
      };
      // Sea, land, plaza ring.
      ctx.fillStyle = '#17435e';
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#4d8a46';
      ctx.beginPath();
      ctx.arc(cx, cy, R * 0.94, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(232, 217, 184, 0.5)';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(cx, cy, (R * (Math.PI / 2 - 0.4636)) / (Math.PI / 2 - SHORE_LAT), 0, Math.PI * 2);
      ctx.stroke();
      // POIs.
      ctx.font = '16px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (const poi of pois) {
        const p = project(poi.pos);
        // District POIs get their accent as a soft halo — the map used to
        // render five identical glyphs with nothing tying them to the coloured
        // beacons the radar and the 3D world already use.
        if (poi.color) {
          ctx.fillStyle = poi.color;
          ctx.globalAlpha = 0.28;
          ctx.beginPath();
          ctx.arc(p.x, p.y, 12, 0, Math.PI * 2);
          ctx.fill();
          ctx.globalAlpha = 1;
        }
        const glyph = glyphOf(poi);
        if (glyph && typeof Path2D === 'function') {
          // The sprite's glyph, 18 px on the 24 px grid, light on the map.
          ctx.save();
          ctx.translate(p.x - 9, p.y - 9);
          ctx.scale(0.75, 0.75);
          ctx.strokeStyle = '#fff6d8';
          ctx.lineWidth = 2;
          ctx.lineCap = 'round';
          ctx.lineJoin = 'round';
          ctx.stroke(new Path2D(glyph === 'parcel' ? PARCEL_GLYPH : DISTRICT_GLYPHS.contact));
          ctx.restore();
        } else {
          ctx.fillText(poi.icon, p.x, p.y);
        }
        hits.push({ x: p.x, y: p.y, poi });
      }
      // The compass pill's current target: a gold halo, so the map a visitor
      // opened FROM the pill visibly agrees with it. Static ring on purpose —
      // the modal canvas draws once, and reduced-motion needs no special case.
      if (opts?.targetPos) {
        const tp = project(opts.targetPos);
        ctx.strokeStyle = '#ffd54a';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(tp.x, tp.y, 12.5, 0, Math.PI * 2);
        ctx.stroke();
      }
      // You-are-here + heading. The heading arrow's screen direction comes from
      // projecting a point a step ahead — the polar projection's own math, so
      // it is correct at any longitude without a tangent-frame derivation.
      if (opts?.playerPos) {
        const pp = project(opts.playerPos);
        if (opts.playerFwd) {
          const ahead = project({
            x: opts.playerPos.x + opts.playerFwd.x * 3,
            y: opts.playerPos.y + opts.playerFwd.y * 3,
            z: opts.playerPos.z + opts.playerFwd.z * 3,
          });
          const dx = ahead.x - pp.x;
          const dy = ahead.y - pp.y;
          const len = Math.hypot(dx, dy);
          if (len > 0.01) {
            ctx.strokeStyle = 'rgba(255,255,255,0.9)';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(pp.x, pp.y);
            ctx.lineTo(pp.x + (dx / len) * 11, pp.y + (dy / len) * 11);
            ctx.stroke();
          }
        }
        ctx.fillStyle = '#ffffff';
        ctx.strokeStyle = 'rgba(0,0,0,0.7)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(pp.x, pp.y, 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    }
    const pick = (poi: (typeof pois)[number]): void => {
      modal.remove();
      this.panels.notifyClosed('island-map');
      onPick(poi);
    };
    canvas.addEventListener('click', (e) => {
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      let best: (typeof hits)[number] | null = null;
      let bestD = 22;
      for (const h of hits) {
        const d = Math.hypot(h.x - mx, h.y - my);
        if (d < bestD) {
          bestD = d;
          best = h;
        }
      }
      if (best) pick(best.poi);
    });
    // The canvas is a picture of the legend below: the legend is the
    // accessible path, so screen readers skip the canvas (UX-15).
    canvas.setAttribute('aria-hidden', 'true');
    // Legend — every provider as a tappable chip (works even where map dots
    // crowd each other). Repeats share one chip that picks the nearest of
    // them: four 'Ore vein' chips became one 'Ore veins (4)' (UX-15).
    const legend = document.createElement('div');
    Object.assign(legend.style, {
      display: 'flex',
      flexWrap: 'wrap',
      gap: '6px',
      justifyContent: 'center',
      marginTop: '10px',
      maxHeight: '150px',
      overflowY: 'auto',
    });
    const groups = new Map<string, Array<(typeof pois)[number]>>();
    for (const poi of pois) {
      const key = `${poi.icon} ${poi.label}`;
      groups.set(key, [...(groups.get(key) ?? []), poi]);
    }
    const plural = (label: string): string =>
      label.replace(
        /^(.*?)(\s+\(.*)?$/,
        (_m, head: string, tail = '') =>
          `${head}${/(?:ch|sh|s|x|z)$/.test(head) ? 'es' : 's'}${tail}`,
      );
    const nearest = (list: Array<(typeof pois)[number]>): (typeof pois)[number] => {
      const p = opts?.playerPos;
      if (!p) return list[0];
      const d2 = (q: { x: number; y: number; z: number }): number =>
        (q.x - p.x) ** 2 + (q.y - p.y) ** 2 + (q.z - p.z) ** 2;
      return list.reduce((a, b) => (d2(b.pos) < d2(a.pos) ? b : a));
    };
    for (const list of groups.values()) {
      const poi = list[0];
      const chip = document.createElement('button');
      chip.type = 'button';
      const glyph = glyphOf(poi);
      const words = list.length > 1 ? `${plural(poi.label)} (${list.length})` : poi.label;
      if (glyph) {
        SimpleUI.chipContent(chip, glyph, words);
        chip.dataset.glyph = glyph;
        Object.assign(chip.style, { display: 'inline-flex', alignItems: 'center', gap: '5px' });
      } else {
        chip.textContent = `${poi.icon} ${words}`;
      }
      Object.assign(chip.style, {
        padding: '5px 9px',
        minHeight: this.isTouch ? '44px' : '36px',
        borderRadius: '999px',
        // District chips wear their accent — same colour as the map halo,
        // the radar beacon and the in-world plaza tint.
        border: `1px solid ${poi.color ?? 'rgba(255,255,255,0.18)'}`,
        background: 'rgba(255,255,255,0.06)',
        color: '#dfe6ff',
        fontSize: '12px',
        cursor: 'pointer',
      });
      chip.addEventListener('click', () => pick(list.length > 1 ? nearest(list) : poi));
      legend.appendChild(chip);
    }
    modal.appendChild(legend);
    this.overlay.appendChild(modal);
    trackOnce('island_map_opened');
  }

  /**
   * The School's lessons card (P2-D8): one row per lesson, done or not, with
   * its reward. Each row not done has one 'Show me', which sends that row's
   * key through 'ds:guide-to' (A's P2-A9 opens this from the School, wave 4).
   * A centred modal under the manager: Escape, Back and focus as every other.
   */
  public showLessons(
    rows: ReadonlyArray<{
      id: string;
      title: string;
      done: boolean;
      reward: number;
      guideKey?: string;
    }>,
  ): void {
    const modal = this.buildCenteredModal('min(420px, calc(100vw - 32px))', 'lessons');
    const title = document.createElement('h2');
    title.textContent = 'School lessons';
    Object.assign(title.style, { margin: '0 0 6px', color: '#8a9bff' });
    modal.appendChild(title);
    const lede = document.createElement('p');
    lede.textContent = 'Each lesson teaches one of the island’s trades, and pays a few coins.';
    Object.assign(lede.style, { margin: '0 0 12px', fontSize: '13px', color: '#c5cfdd' });
    modal.appendChild(lede);
    const list = document.createElement('ul');
    list.className = 'ds-controls-todo';
    list.dataset.lessons = '1';
    for (const r of rows) {
      const li = document.createElement('li');
      li.dataset.lesson = r.id;
      if (r.done) li.dataset.done = '1';
      const text = document.createElement('span');
      text.className = 'ds-controls-todo-text';
      const strong = document.createElement('strong');
      strong.textContent = r.title;
      const sub = document.createElement('span');
      sub.textContent = r.done ? 'Learned' : `Reward: ${Math.max(0, Math.round(r.reward))} coins`;
      text.append(strong, sub);
      li.appendChild(text);
      if (r.done) {
        const done = document.createElement('span');
        done.className = 'ds-controls-todo-done';
        done.appendChild(iconNode('check', 16));
        done.append(' Done');
        li.appendChild(done);
      } else if (r.guideKey) {
        const key = r.guideKey;
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = 'Show me';
        b.dataset.showMe = key;
        b.setAttribute('aria-label', `Show me: ${r.title}`);
        b.addEventListener('click', () => {
          this.closeCenteredModal(modal, 'lessons');
          this.guideTo(key, 'lessons');
        });
        li.appendChild(b);
      }
      list.appendChild(li);
    }
    modal.appendChild(list);
    trackOnce('lessons_opened');
    this.overlay.appendChild(modal);
  }

  /** Wire the mute button to the audio system (returns new muted state). */
  setOnMuteToggle(cb: () => boolean): void {
    this.onMuteToggle = cb;
  }

  /** Joystick vector for touch devices ({0,0} on desktop). */
  getJoystick(): { forward: number; strafe: number } {
    return this.joyState;
  }

  // ── Proximity chat ────────────────────────────────────────────────────

  private chatInput: HTMLInputElement | null = null;
  // Preserved chat draft: an accidental blur (soft-keyboard collapse, tap-away)
  // must not silently discard typed text — restored if the input reopens soon.
  private chatDraft = '';
  private chatDraftTime = 0;
  private onChatSend: ((text: string) => void) | null = null;
  private onMicDown: (() => void) | null = null;
  private onMicUp: (() => void) | null = null;
  private micBtn: HTMLElement | null = null;
  /** 💬 and 🎤 on touch: 52px circles in the action discs' family (D3,
   *  DA-14), where they were 10px-radius squares of 55% black. Centred by
   *  line-height, not flex: the mic's support check and PanelManager restore
   *  their display to ''. */
  private static readonly AUX_DISC: Partial<CSSStyleDeclaration> = {
    position: 'absolute',
    width: '52px',
    height: '52px',
    boxSizing: 'border-box',
    borderRadius: '50%',
    background: DS.hudSurface,
    boxShadow: `inset 0 0 0 2px ${DS.lineStrong}, 0 3px 10px rgba(0,0,0,0.3)`,
    fontSize: '20px',
    lineHeight: '52px',
    textAlign: 'center',
    // The chat and mic glyphs are ui/icons.ts strokes in currentColor (D13).
    color: 'white',
    pointerEvents: 'auto',
    userSelect: 'none',
  };

  public isChatInputOpen(): boolean {
    return this.chatInput !== null;
  }
  public setOnChatSend(cb: (text: string) => void): void {
    this.onChatSend = cb;
  }
  public setOnMicDown(cb: () => void): void {
    this.onMicDown = cb;
  }
  public setOnMicUp(cb: () => void): void {
    this.onMicUp = cb;
  }

  private toastEl: HTMLDivElement | null = null;
  private toastTimer = 0;
  private pumpTimer = 0;
  /** Messages waiting to show, oldest first: toasts and flashes (D6). */
  private toastQueue: QueuedMessage[] = [];
  /** The message on screen now, while toastBusy. */
  private shownMessage: QueuedMessage | null = null;
  private toastBusy = false;
  /** A fading flash: toasts wait out its 300 ms fade. */
  private flashFadeUntil = 0;
  /** A toast whose dwell just ended: the next message waits out its 200 ms
   *  fade. A flash is a second element, and one that arrived in that window
   *  showed over the fading toast (wave-1 integration: the 'Next:' flash on
   *  leaving a hall, 2.0 s after the passport toast). A hint taken down at
   *  once (stepHintAside) has no fade to wait for. */
  private toastFadeUntil = 0;
  /**
   * Brief auto-dismissing status toast — e.g. "Muted <name>".
   *
   * Mobile-finish rules, each fixing a shipped defect found on the SE audit:
   * - WRAPS with a max width (the old nowrap clipped 25-60px off BOTH edges
   *   of a 375px screen on any long message);
   * - QUEUES instead of silently overwriting (away-digest, streak, first-coin
   *   and featured-special all funnel here and clobbered each other mid-read);
   * - DEFERS while the loader or welcome modal is up (the once-per-day
   *   featured toast fired under the opaque loader and burned its
   *   localStorage key without ever being seen).
   *
   * One message at a time (D6, P2-D3): toasts and flashes share this queue,
   * so a flash and a toast are never on screen together. Nothing paints over
   * an open modal: a message waits for it to close, unless it answers what
   * the visitor just did inside it (a shop purchase, 'Link copied'), which
   * shows inside the panel instead. An outcome takes the place of a hint on
   * screen at once, and a message whose `until()` has come true is dropped,
   * hint or outcome (an arrival toast can pass `until: () =>
   * scene.isInsideInterior()`).
   */
  public toast(message: string, opts?: { hint?: boolean; until?: () => boolean }): void {
    this.enqueue(this.queued(message, 'toast', !!opts?.hint, opts?.until));
  }

  /** A fresh queue entry: never shown yet. */
  private queued(
    text: string,
    kind: QueuedMessage['kind'],
    hint: boolean,
    until?: () => boolean,
  ): QueuedMessage {
    return {
      text,
      hint,
      kind,
      until,
      shows: 0,
      seenMs: 0,
      shownAt: 0,
      inside: false,
      place: null,
    };
  }

  /** The radar distance to each fixed landmark, from the last minimap update
   *  (the cruise liner moves, so it is left out). */
  private placeFix: number[] | null = null;

  /** The visitor has gone in or out, or walked off from where `m` showed. */
  private leftPlace(m: QueuedMessage): boolean {
    if (m.inside !== this.isInside()) return true;
    const a = m.place;
    const b = this.placeFix;
    if (!a || !b || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > PLACE_MOVE) return true;
    return false;
  }

  private enqueue(m: QueuedMessage): void {
    if (this.messagesStopped) return;
    if (!m.hint && this.panelOwnsMessage()) {
      this.panelNote(m);
      return;
    }
    // Drop exact duplicates already waiting, or on screen now — a queue of
    // three "+1 🪙" adds nothing.
    if (this.toastQueue.some((q) => q.text === m.text)) return;
    if (this.toastBusy && this.shownMessage?.text === m.text) return;
    this.toastQueue.push(m);
    // Outcomes beat hints (GP-08): the refund waited 5.9 s behind an 88-char
    // hint. The hint bows out and goes back to the head of the queue.
    if (!m.hint && this.shownMessage?.hint && this.mayShow(m)) this.stepHintAside();
    this.pumpToasts();
  }

  /**
   * May this message show now? Nothing paints over an open modal (P2-D3:
   * 'Secret found' printed across the Welcome hall's body text). Hints — the
   * unprompted onboarding and world lines (compass, coins, districts, streak,
   * world news) — also wait while any panel, the menu or the tour is open
   * (the first-run compass hint landed on the contact form and on the
   * recruiter tour), while the first-steps guide is active (A6), and on touch
   * while an interaction prompt is up (it covered a third of 'Tap USE to talk
   * to…', PROMPT-01).
   *
   * `shown`: the hint is on screen already. A prompt no longer takes it
   * down: the toast lane steps above the prompt instead (applyToastAnchor).
   * Taking it down made it blink — a passing villager's prompt hid 'Lost?'
   * five times in 16 s on a phone, each for 0.1-0.5 s (wave-1 integration).
   */
  private mayShow(m: QueuedMessage, shown = false): boolean {
    if (this.panels.isModalOpen()) return false;
    if (!m.hint) return true;
    if (this.panels.isOpen() || this.guideActive()) return false;
    if (shown) return true;
    // The first beat after the welcome card belongs to First steps, which
    // arms on Explore and comes up 600 ms after the card goes (A6).
    if (Date.now() - this.welcomeClosedAt < 600) return false;
    return !(this.isTouch && this.interactionDiv !== null);
  }

  /** Inside a building: the Leave pill is up. */
  private isInside(): boolean {
    return this.leaveBtn !== null;
  }

  private welcomeClosedAt = -Infinity;

  /**
   * Dequeue the next message that may show now, or null to wait: outcomes
   * first, then hints, oldest first within each. Stale messages drop:
   * - one whose until() has come true, hint or outcome (the talk hint
   *   returned after the visitor had already talked, GP-08);
   * - one that showed already, stepped aside, and whose place has changed
   *   since: the visitor went into a building or came out ('🏝️ The Hub —
   *   the town square' stepped aside for the PIN pad and came back inside
   *   the beach house). A message that never showed keeps its turn: the
   *   passport stamp waits out the hall panel, and the visitor may have
   *   left the hall by the time it shows.
   */
  private takeToast(): QueuedMessage | null {
    const inside = this.isInside();
    this.toastQueue = this.toastQueue.filter(
      (q) => !q.until?.() && !(q.shows > 0 && (q.inside !== inside || this.leftPlace(q))),
    );
    const pick =
      this.toastQueue.find((q) => !q.hint && this.mayShow(q)) ??
      this.toastQueue.find((q) => q.hint && this.mayShow(q)) ??
      null;
    if (pick) this.toastQueue.splice(this.toastQueue.indexOf(pick), 1);
    return pick;
  }

  /**
   * The message on screen bows out the moment it may no longer show: a modal
   * opened over it, or (a hint) a panel, the menu, the tour or the guide came
   * up, or its until() came true. Measured before this: the talk hint stayed
   * over a freshly opened hire card for the rest of its dwell.
   *
   * While it may stay, it keeps its lane clear of First steps' card, which
   * grows with each step, folds to its chip and moves over a prompt while
   * the message shows: on every poll, and in the same frame the card
   * resizes (at 844x390 the step-3 card grew 39 px into a flash 8 px below
   * it, for one 100 ms monitor sample before the poll moved it). Polls only
   * while a message shows (6 s at most).
   */
  private watchShown(m: QueuedMessage): void {
    if (this.shownWatch) window.clearInterval(this.shownWatch);
    this.unwatchGuide();
    const reanchor = (): void => {
      if (m.kind === 'flash') {
        if (this.flashEl) this.anchorFlash(this.flashEl);
      } else if (this.toastEl) {
        this.applyToastAnchor(this.toastEl);
      }
    };
    const guide = document.getElementById('ds-guide');
    if (guide && typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(() => {
        if (this.shownMessage === m && this.toastBusy) reanchor();
      });
      ro.observe(guide);
      this.guideResize = ro;
    }
    const iv = window.setInterval(() => {
      if (this.shownMessage !== m || !this.toastBusy) {
        window.clearInterval(iv);
        if (this.shownWatch === iv) {
          this.shownWatch = 0;
          this.unwatchGuide();
        }
        return;
      }
      // On screen as the visitor goes through a door: it goes, and takeToast
      // drops it rather than bring it back (re-verify: 'The Hub - the town
      // square' stayed up into the beach house). Walking on does not take it
      // down; only a message that already stepped aside stays behind.
      if (this.mayShow(m, true) && !m.until?.() && m.inside === this.isInside()) {
        reanchor();
        return;
      }
      window.clearInterval(iv);
      this.shownWatch = 0;
      this.unwatchGuide();
      this.stepHintAside(true);
    }, 120);
    this.shownWatch = iv;
  }

  /** watchShown's poll, while a message shows. */
  private shownWatch = 0;
  /** watchShown's eye on First steps' card, while a message shows. */
  private guideResize: ResizeObserver | null = null;
  private unwatchGuide(): void {
    this.guideResize?.disconnect();
    this.guideResize = null;
  }

  /** dispose() ran: the queue takes nothing more and arms no timer. */
  private messagesStopped = false;

  /**
   * End the message queue for good (dispose): every timer it runs on (the
   * pump's re-poll, the dwell, the panel note, the live region, the prompt's
   * read-out, the shown message's watch) is cleared and none re-arms. They
   * ran on after the UI was gone: a test file's environment torn down under
   * a pending pump failed the run with 'document is not defined'.
   */
  private stopMessages(): void {
    this.messagesStopped = true;
    for (const t of [
      this.pumpTimer,
      this.toastTimer,
      this.panelNoteTimer,
      this.liveTimer,
      this.liveHoldTimer,
      this.promptAnnounceTimer,
    ]) {
      if (t) clearTimeout(t);
    }
    this.liveHoldTimer = 0;
    this.liveHeld = null;
    if (this.shownWatch) window.clearInterval(this.shownWatch);
    this.unwatchGuide();
    this.pumpTimer = 0;
    this.toastTimer = 0;
    this.panelNoteTimer = 0;
    this.liveTimer = 0;
    this.promptAnnounceTimer = 0;
    this.shownWatch = 0;
    this.toastQueue = [];
    this.shownMessage = null;
    this.toastBusy = false;
  }

  /**
   * Take the hint on screen down NOW, with no fade, and put it back at the
   * head of the queue (`any`: whatever is on screen, the opening of a modal).
   * The hire card, the Portfolio panels, the menu and the centred modals call
   * this as they open: waiting for the poll above left the compass hint
   * painted over a just-opened hire card for a tick plus the 200 ms fade
   * (measured at 390x844).
   *
   * It drops instead of going back when it is stale (until() true), when it
   * has been read (on screen READ_MS in all), or when it has had its one
   * re-show already (MAX_SHOWS).
   */
  private stepHintAside(any = false): void {
    const m = this.shownMessage;
    if (m === null || !this.toastBusy || !(m.hint || any)) return;
    if (this.toastTimer) clearTimeout(this.toastTimer);
    if (m.kind === 'flash') {
      this.flashEl?.remove();
      this.flashEl = null;
    } else if (this.toastEl) {
      // Hide with the fade switched off, flush styles so the hide lands
      // unanimated, then switch the fade back on for the next toast.
      const el = this.toastEl;
      const fade = el.style.transition;
      el.style.transition = 'none';
      el.style.opacity = '0';
      void getComputedStyle(el).opacity;
      el.style.transition = fade;
    }
    this.shownMessage = null;
    this.toastBusy = false;
    m.seenMs += Math.max(0, Date.now() - m.shownAt);
    const read = m.seenMs >= (m.hint ? READ_MS.hint : READ_MS.outcome);
    const back = !read && m.shows < MAX_SHOWS && !m.until?.();
    if (back && !this.toastQueue.some((q) => q.text === m.text)) this.toastQueue.unshift(m);
    this.schedulePump(250);
  }

  /** One pending pump at a time: a sooner request replaces a later one. */
  private schedulePump(ms: number): void {
    if (this.messagesStopped) return;
    if (this.pumpTimer) clearTimeout(this.pumpTimer);
    this.pumpTimer = window.setTimeout(() => {
      this.pumpTimer = 0;
      this.pumpToasts();
    }, ms);
  }

  private pumpToasts(): void {
    if (this.messagesStopped || this.toastBusy || this.toastQueue.length === 0) return;
    // Not while an opaque loader or the welcome/name modal owns the screen,
    // nor before the fly-in settles (a returning visitor read a special
    // before the card, FM-12), nor over a fading flash or toast — re-checked
    // on a short poll so deferred messages surface right after.
    const fade = Math.max(this.flashFadeUntil, this.toastFadeUntil) - Date.now();
    const wait = this.isLoadingVisible() || this.isWelcomeVisible() || this.introHold() || fade > 0;
    const m = wait ? null : this.takeToast();
    if (m === null) {
      this.schedulePump(fade > 0 ? Math.ceil(fade) : 700);
      return;
    }
    this.toastBusy = true;
    this.shownMessage = m;
    m.shows += 1;
    m.shownAt = Date.now();
    m.inside = this.isInside();
    m.place = this.placeFix ? [...this.placeFix] : null;
    // Dwell scales with LENGTH: the flat 2000ms burned one-shot content —
    // a 120-char school lesson (shown only via toast, key already spent)
    // vanished half-read. ~180wpm reading rate ≈ 50ms/char, floor 2s, cap 6s.
    // Flashes take the same rule (they were a flat 1.8 s).
    const dwell = Math.min(6000, Math.max(2000, m.text.length * 50));
    if (m.kind === 'flash') this.showFlash(m.text, dwell);
    else this.showToast(m.text, dwell);
    // Read out on its first show only: a re-show after a step aside is the
    // same line, and the live region read 'Lost?' seven times in 33 s.
    if (m.shows === 1) this.announce(keyTextPlain(m.text, this.getInputMode()));
    this.watchShown(m);
  }

  private showToast(text: string, dwell: number): void {
    if (!this.toastEl) {
      this.toastEl = document.createElement('div');
      // Bottom-centre lane on phones, stacked so concurrent notices don't
      // overlap (chat-input 96 · breath 150 · recording 200 · toast 350 ·
      // prompt 300, lifted over the prompt and the guide card); the top lane
      // under the compass pill on desktop (see applyToastAnchor).
      Object.assign(this.toastEl.style, {
        position: 'absolute',
        left: '50%',
        transform: 'translateX(-50%)',
        width: 'max-content',
        maxWidth: 'min(92vw, 440px)',
        textAlign: 'center',
        background: 'rgba(12,12,20,0.92)',
        color: '#fff',
        padding: '9px 16px',
        borderRadius: '12px',
        fontSize: '14px',
        lineHeight: '1.35',
        fontFamily: 'system-ui, sans-serif',
        pointerEvents: 'none',
        zIndex: '1750',
        opacity: '0',
        transition: 'opacity 0.2s ease',
      });
      this.overlay.appendChild(this.toastEl);
    }
    // Keys as k() nodes, built from text nodes: a toast can carry a
    // visitor's name, so its text never becomes markup (D7).
    renderKeyText(this.toastEl, text, this.getInputMode());
    this.applyToastAnchor(this.toastEl); // the lanes depend on what else is up
    this.toastEl.style.opacity = '1';
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => {
      if (this.toastEl) this.toastEl.style.opacity = '0';
      this.toastBusy = false;
      this.shownMessage = null;
      // The next message waits out this 200 ms fade (pumpToasts).
      this.toastFadeUntil = Date.now() + 200;
      // 250ms gap between queued toasts so consecutive ones read as separate.
      this.schedulePump(250);
    }, dwell);
  }

  // ── Messages: the panel's own outcomes, the guide, the intro, the live region ──

  /** The visitor's last press inside an open panel, and which panel. */
  private lastPanelAction: { id: string; at: number } | null = null;
  private panelNoteTimer = 0;

  /** The top modal asked for this message: the visitor acted inside it a
   *  moment ago (a purchase, a Copy, a share, a vault deposit). The welcome
   *  card is not one: its every button closes it. */
  private panelOwnsMessage(): boolean {
    const top = this.panels.topModal();
    const a = this.lastPanelAction;
    return (
      !!top?.el &&
      top.id !== 'welcome' &&
      !!a &&
      a.id === top.id &&
      Date.now() - a.at < PANEL_ACTION_MS
    );
  }

  /**
   * Show an outcome INSIDE the open modal: a status line pinned to the
   * bottom of its scroller, never a toast painted over it (P2-D3). A
   * microtask later, because the shop re-renders itself right after its own
   * toast; a panel gone by then hands the message back to the queue.
   */
  private panelNote(m: QueuedMessage): void {
    queueMicrotask(() => {
      if (this.messagesStopped) return;
      const top = this.panels.topModal();
      const el = top?.el;
      if (!el?.isConnected) {
        if (!this.toastQueue.some((q) => q.text === m.text)) this.toastQueue.push(m);
        this.pumpToasts();
        return;
      }
      let note = Array.from(el.children).find(
        (c): c is HTMLElement => c instanceof HTMLElement && c.dataset.panelNote === '1',
      );
      if (!note) {
        note = document.createElement('div');
        note.dataset.panelNote = '1';
        note.setAttribute('role', 'status'); // read out by the dialog itself
        Object.assign(note.style, {
          position: 'sticky',
          bottom: '0',
          margin: '12px 0 0',
          padding: '9px 14px',
          borderRadius: '10px',
          background: 'rgba(28,34,52,0.97)',
          border: '1px solid rgba(143,193,255,0.35)',
          color: '#fff',
          fontSize: '14px',
          lineHeight: '1.35',
          textAlign: 'center',
          zIndex: '1',
        });
        el.appendChild(note);
      }
      renderKeyText(note, m.text, this.getInputMode());
      const shown = note;
      if (this.panelNoteTimer) clearTimeout(this.panelNoteTimer);
      this.panelNoteTimer = window.setTimeout(
        () => shown.remove(),
        Math.min(6000, Math.max(2000, m.text.length * 50)),
      );
    });
  }

  /** The latest 'ds:guide' {active, step} (A6), until the card itself exists. */
  private lastGuide: { active: boolean } | null = null;

  /** First steps is on screen and teaching: hints wait (D6). The card's own
   *  data-active wins; before it exists, the last 'ds:guide' event. */
  private guideActive(): boolean {
    const el = typeof document === 'undefined' ? null : document.getElementById('ds-guide');
    if (el) return el.dataset.active === '1';
    return this.lastGuide?.active === true;
  }

  /** The guide has armed at least once this page life: it teaches the
   *  compass itself, so the welcome's first-run compass hint stands down. */
  private guideArmed(): boolean {
    return this.lastGuide !== null || !!document.getElementById('ds-guide');
  }

  // The intro hold (D6, FM-12): 'ds:intro' settled (A8), or 3.5 s after the
  // loader hides where nobody sends it. With no loader at all (an embed, a
  // test) there is nothing to wait for.
  private introPhase: 'none' | 'started' | 'settled' = 'none';
  private introStartedAt = 0;
  private loaderEverShown = false;
  private loaderHiddenAt = 0;
  private static readonly INTRO_HOLD_MS = 3500;
  /** A 'start' whose 'settled' never comes holds no longer than this. */
  private static readonly INTRO_MAX_MS = 20000;

  private introHold(): boolean {
    if (this.introPhase === 'settled') return false;
    const now = Date.now();
    if (this.introPhase === 'started') return now - this.introStartedAt < SimpleUI.INTRO_MAX_MS;
    if (!this.loaderEverShown) return false;
    return this.loadingDiv !== null || now - this.loaderHiddenAt < SimpleUI.INTRO_HOLD_MS;
  }

  /** The visually hidden polite live region: toasts, flashes, the bulletin,
   *  the interaction prompt (debounced) and compass target changes (D6;
   *  UX-05: every notice was silent to screen readers). */
  private liveEl: HTMLDivElement | null = null;
  private liveTimer = 0;
  /** A line that must be heard out (the room announcement) holds the region
   *  until this time; the latest line that arrives meanwhile follows it. */
  private liveHoldUntil = 0;
  private liveHeld: string | null = null;
  private liveHoldTimer = 0;

  /**
   * Say `text` through the live region. `holdMs` keeps it there that long:
   * entering a hall stamps the passport, the compass retargets, and
   * 'Compass: Personal' replaced 'Inside Project Portfolio…' 15 ms after it
   * was written, before a screen reader could have read a word of it.
   */
  private announce(text: string, holdMs = 0): void {
    if (!text || this.messagesStopped) return;
    const now = Date.now();
    if (now < this.liveHoldUntil) {
      this.liveHeld = text; // the latest state is the one worth saying next
      if (!this.liveHoldTimer) {
        this.liveHoldTimer = window.setTimeout(() => {
          this.liveHoldTimer = 0;
          const next = this.liveHeld;
          this.liveHeld = null;
          this.liveHoldUntil = 0;
          if (next) this.announce(next);
        }, this.liveHoldUntil - now);
      }
      return;
    }
    if (holdMs > 0) this.liveHoldUntil = now + holdMs;
    if (!this.liveEl) {
      const el = document.createElement('div');
      el.className = 'ds-sr-only';
      el.setAttribute('role', 'status');
      el.setAttribute('aria-live', 'polite');
      el.setAttribute('aria-atomic', 'true');
      el.dataset.neverInert = '1'; // a modal's inert must not silence it
      this.overlay.appendChild(el);
      this.liveEl = el;
    }
    const el = this.liveEl;
    if (this.liveTimer) clearTimeout(this.liveTimer);
    if (el.textContent !== text) {
      el.textContent = text;
      return;
    }
    // The same line again: clear, then re-set, so it is read again.
    el.textContent = '';
    this.liveTimer = window.setTimeout(() => {
      el.textContent = text;
    }, 60);
  }

  /** Window listeners: the guide, the intro, and the panel's own actions. */
  private initMessageSignals(): void {
    if (typeof window === 'undefined') return;
    window.addEventListener('ds:guide', this.onGuideEvent);
    window.addEventListener('ds:intro', this.onIntroEvent);
    window.addEventListener('ds:coin', this.onCoinEvent);
    // The ladder and the visit's numbers (P2-D10), kept from boot: main-simple
    // publishes in the same task as it opens the crown's card.
    window.addEventListener('ds:goals', this.onGoalsEvent);
    // Capture: a press inside a modal marks the next outcome as its own,
    // whatever the control does with the event afterwards.
    for (const type of ['pointerdown', 'keydown', 'click'] as const) {
      this.overlay.addEventListener(type, this.onPanelAction, true);
    }
  }

  /** The latest 'ds:goals' detail (P2-D10); null until main-simple sends one
   *  (it never does without a Next chip). */
  private goals: VisitGoals | null = null;
  private readonly onGoalsEvent = (e: Event): void => {
    const d = (e as CustomEvent<VisitGoals | null>).detail;
    if (d && Array.isArray(d.goals)) this.goals = d;
  };

  /** The latest 'ds:goals' detail, for tests and probes. */
  getGoals(): VisitGoals | null {
    return this.goals;
  }

  private readonly onGuideEvent = (e: Event): void => {
    const d = (e as CustomEvent<{ active?: boolean }>).detail;
    this.lastGuide = { active: !!d?.active };
    if (this.lastGuide.active) this.stepHintAside();
    else this.schedulePump(0);
  };

  private readonly onIntroEvent = (e: Event): void => {
    const phase = (e as CustomEvent<{ phase?: string }>).detail?.phase;
    if (phase === 'start' && this.introPhase === 'none') {
      this.introPhase = 'started';
      this.introStartedAt = Date.now();
      // D11: the HUD waits out the intro and staggers in once it settles,
      // or after 6 s if 'settled' never comes. No 'start', no hide.
      this.panels.holdHud();
      window.setTimeout(() => this.panels.releaseHud(), 6000);
    } else if (phase === 'settled') {
      this.introPhase = 'settled';
      this.panels.releaseHud();
      // A tick later: afterIntro opens the welcome card right after it says
      // settled, and the card must win that race.
      this.schedulePump(0);
    }
  };

  private readonly onPanelAction = (e: Event): void => {
    const id = this.panels.panelAt(e.target as Node | null);
    if (id) this.lastPanelAction = { id, at: Date.now() };
  };

  /** Is the bulletin banner up (the desktop toast lane yields to it)? */
  private bulletinShowing(): boolean {
    return !!this.bulletinEl && this.bulletinEl.style.opacity === '1';
  }

  private bulletinEl: HTMLDivElement | null = null;
  private bulletinBodyEl: HTMLDivElement | null = null;
  private bulletinTimer = 0;
  /**
   * The "living world" beat: a top-centre banner announcing the island's mood +
   * headline for the day, tinted with the mood accent, auto-dismissing. Fed by
   * the server-owned world/island doc via WorldState.connectWorldState — the
   * headline is server-authored + pre-approved, but we render it with
   * textContent (never innerHTML) so no markup can ever reach the DOM.
   */
  public showWorldBulletin(headline: string, accent: string): void {
    // The RTDB doc typically lands within the first seconds — right on top
    // of the first-run welcome modal (z1700 beats it). Hold the banner until
    // the visitor has actually arrived; it re-checks until the modal closes.
    if (this.isLoadingVisible() || this.isWelcomeVisible()) {
      window.setTimeout(() => this.showWorldBulletin(headline, accent), 1500);
      return;
    }
    if (!this.bulletinEl) {
      this.bulletinEl = document.createElement('div');
      Object.assign(this.bulletinEl.style, {
        position: 'absolute',
        left: '50%',
        top: this.bulletinTop(),
        transform: 'translateX(-50%) translateY(-8px)',
        maxWidth: 'min(90vw, 520px)',
        background: 'rgba(12,14,22,0.9)',
        color: '#f2f6ff',
        padding: '10px 18px',
        borderRadius: '14px',
        fontFamily: 'system-ui, sans-serif',
        fontSize: '14px',
        lineHeight: '1.35',
        textAlign: 'center',
        pointerEvents: 'none',
        zIndex: '1700',
        border: '1px solid rgba(255,255,255,0.12)',
        borderTop: '3px solid #fff',
        boxShadow: '0 6px 24px rgba(0,0,0,0.35)',
        opacity: '0',
        transition: 'opacity 0.4s ease, transform 0.4s ease',
      });
      const label = document.createElement('div');
      label.textContent = 'The island today';
      Object.assign(label.style, {
        fontSize: '11px',
        letterSpacing: '0.08em',
        textTransform: 'uppercase',
        opacity: '0.6',
        marginBottom: '2px',
      });
      this.bulletinBodyEl = document.createElement('div');
      this.bulletinEl.appendChild(label);
      this.bulletinEl.appendChild(this.bulletinBodyEl);
      this.overlay.appendChild(this.bulletinEl);
    }
    if (this.bulletinBodyEl) this.bulletinBodyEl.textContent = headline; // textContent: no markup injection
    this.bulletinEl.style.borderTopColor = accent;
    this.bulletinEl.style.opacity = '1';
    this.bulletinEl.style.transform = 'translateX(-50%) translateY(0)';
    this.announce(`The island today: ${headline}`);
    // A desktop toast in the bulletin's lane steps down to the bottom lane
    // while the banner is up, and back after.
    if (this.toastEl) this.applyToastAnchor(this.toastEl);
    if (this.bulletinTimer) clearTimeout(this.bulletinTimer);
    this.bulletinTimer = window.setTimeout(() => {
      if (this.bulletinEl) {
        this.bulletinEl.style.opacity = '0';
        this.bulletinEl.style.transform = 'translateX(-50%) translateY(-8px)';
      }
      if (this.toastEl) this.applyToastAnchor(this.toastEl);
    }, 7000);
  }

  private coachMarkShown = false;
  /**
   * One-shot proximity coach mark: the first time another visitor comes within
   * chat range, surface how to interact (chat / talk / mute) — otherwise those
   * affordances are undiscoverable. Persisted so it shows at most once, ever.
   */
  showProximityCoachMark(): void {
    if (this.coachMarkShown) return;
    this.coachMarkShown = true;
    try {
      if (localStorage.getItem('ds_coach_proximity') === '1') return;
      localStorage.setItem('ds_coach_proximity', '1');
    } catch {
      /* storage blocked — still show it this session */
    }

    const el = document.createElement('div');
    el.setAttribute('role', 'status');
    el.textContent = this.isTouch
      ? '👋 Someone’s nearby! Tap 💬 to say hi · hold 🎤 to talk · tap their name to mute.'
      : '👋 Someone’s nearby! Press Enter to say hi · hold V to talk · tap their name to mute.';
    Object.assign(el.style, {
      position: 'absolute',
      left: '50%',
      top: 'calc(var(--sat, 0px) + 52px)',
      transform: 'translateX(-50%)',
      maxWidth: 'min(90vw, 460px)',
      background: 'rgba(12,12,20,0.95)',
      color: '#fff',
      padding: '11px 16px',
      borderRadius: '12px',
      fontSize: '14px',
      lineHeight: '1.4',
      textAlign: 'center',
      fontFamily: 'system-ui, sans-serif',
      border: '1px solid rgba(120,170,255,0.5)',
      boxShadow: '0 6px 20px rgba(0,0,0,0.45)',
      pointerEvents: 'auto',
      cursor: 'pointer',
      zIndex: '1600',
      transition: 'opacity 0.3s ease',
    });
    const remove = () => {
      el.style.opacity = '0';
      window.setTimeout(() => el.remove(), 320);
    };
    el.addEventListener('click', remove);
    this.overlay.appendChild(el);
    trackOnce('coach_proximity_shown');
    window.setTimeout(remove, 9000);
  }

  /** The passport "stamp book": the four zones, stamped or not, + the reward. */
  showPassport(): void {
    const pp = this.passport;
    const modal = this.buildCenteredModal('min(360px, calc(100vw - 32px))', 'passport');
    const stamps = PASSPORT_ZONES.map((z) => {
      const meta = PASSPORT_META[z];
      const done = !!pp?.has(z);
      return `<div style="display:flex;flex-direction:column;align-items:center;gap:5px;padding:14px 8px;
        border-radius:12px;border:2px ${done ? 'solid #12b76a' : 'dashed rgba(255,255,255,0.2)'};
        background:${done ? 'rgba(18,183,106,0.12)' : 'rgba(255,255,255,0.03)'};">
        <span style="font-size:24px;filter:${done ? 'none' : 'grayscale(1)'};opacity:${done ? '1' : '0.5'};">${meta.icon}</span>
        <span style="font-size:12px;">${meta.label}</span>
        <span style="font-size:12px;color:${done ? '#4ade80' : '#7d8ea6'};">${done ? '✓ Stamped' : 'Not yet'}</span>
      </div>`;
    }).join('');
    const complete = !!pp?.isComplete();
    modal.insertAdjacentHTML(
      'beforeend',
      `<h2 style="margin:0 0 4px;color:#8a9bff;">🛂 Portfolio Passport</h2>
       <p style="margin:0 0 16px;font-size:13px;color:#aab;">Visit all four zones to earn the Founder's Golden Crown 👑</p>
       <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:16px;">${stamps}</div>
       <div style="font-size:14px;font-weight:600;color:${complete ? '#4ade80' : '#ccd'};">
         ${complete ? '👑 Complete — crown unlocked & equipped!' : `${pp?.count() ?? 0} / ${pp?.total() ?? 4} stamped`}</div>`,
    );
    trackOnce('passport_opened');
    this.overlay.appendChild(modal);
  }

  /** Reward celebration fired when the last stamp lands (see Passport.onComplete).
   *  The last stamp lands inside a hall, from showZonePanel: the crown stacks
   *  OVER that hall's panel (allow: ['zone']) instead of sweeping it, and on
   *  close focus goes back to the panel's heading (PanelManager). Its entry,
   *  Escape and the CTA close only the crown (INT-02). */
  showPassportComplete(): void {
    const modal = this.buildCenteredModal('min(380px, calc(100vw - 32px))', 'passport-complete', {
      allow: ['zone'],
    });
    modal.style.border = '1px solid rgba(255,213,74,0.55)';
    modal.insertAdjacentHTML(
      'beforeend',
      `<div style="font-size:48px;line-height:1;">👑</div>
       <h2 style="margin:10px 0 6px;color:#ffd54a;">Portfolio complete!</h2>
       <p style="margin:0 0 18px;font-size:15px;line-height:1.5;">
         You explored every zone of the island. The <strong>Founder's Golden Crown</strong>
         is now yours — and equipped. Thanks for taking the full tour.</p>`,
    );
    // Your visit, from the latest 'ds:goals' (P2-D10). Without one the block
    // stays out and the button falls back to 'Keep exploring'.
    const goals = this.goals;
    if (goals?.visit) modal.appendChild(this.visitSummaryBlock(goals.visit));
    const next = goals?.next ?? null;
    const cta = document.createElement('button');
    cta.type = 'button';
    cta.dataset.crownNext = next ? next.id : '';
    cta.textContent = next ? `Next: ${next.label} →` : 'Keep exploring →';
    Object.assign(cta.style, {
      padding: '11px 22px',
      borderRadius: '10px',
      border: 'none',
      background: 'linear-gradient(135deg,#f5b301,#e08a00)',
      color: '#241a00',
      fontSize: '15px',
      fontWeight: '700',
      cursor: 'pointer',
    });
    cta.addEventListener('click', () => {
      modal.remove();
      this.panels.notifyClosed('passport-complete');
      // The crown leads somewhere: the ladder's next goal, through the seam
      // every 'Show me' uses.
      if (next) this.guideTo(next.guideKey, 'crown');
    });
    modal.appendChild(cta);
    // The single highest-intent share moment in the app — the visitor just
    // finished the whole tour and is being congratulated. Hand them the link.
    const shareRow = document.createElement('div');
    shareRow.style.cssText = 'margin-top:12px;';
    shareRow.appendChild(
      this.makeShareButton('📣 Share the island', {
        surface: 'passport_complete',
        url: buildShareUrl(),
        title: 'DigiScalability Life Island',
        text: 'I explored every zone of this 3D portfolio island and earned the Founder’s Crown 👑 — take the tour:',
      }),
    );
    modal.appendChild(shareRow);
    trackOnce('passport_complete');
    this.overlay.appendChild(modal);
  }

  /**
   * 'Your visit' (P2-D10): districts stamped, villagers talked to, coins
   * earned, secrets found and minutes on the island, from the visit field
   * of 'ds:goals'. Numbers only, built with textContent.
   */
  private visitSummaryBlock(v: VisitGoals['visit']): HTMLElement {
    const box = document.createElement('div');
    box.className = 'ds-visit';
    box.dataset.visit = '1';
    Object.assign(box.style, { margin: '0 0 16px', textAlign: 'left' });
    const h = document.createElement('h3');
    h.textContent = 'Your visit';
    h.className = 'ds-caption';
    Object.assign(h.style, {
      margin: '0 0 8px',
      fontSize: '12px',
      fontWeight: '700',
      letterSpacing: '0.08em',
      textTransform: 'uppercase',
      color: '#9fb0c8',
    });
    box.appendChild(h);
    const dl = document.createElement('dl');
    Object.assign(dl.style, {
      display: 'grid',
      gridTemplateColumns: 'repeat(auto-fit, minmax(96px, 1fr))',
      gap: '8px',
      margin: '0',
    });
    const n = (x: unknown): number =>
      typeof x === 'number' && Number.isFinite(x) ? Math.max(0, Math.round(x)) : 0;
    const rows: Array<[string, string, number]> = [
      ['stamps', 'Districts stamped', n(v?.stamps)],
      ['villagers', 'Villagers talked to', n(v?.villagers)],
      ['coins', 'Coins earned', n(v?.coins)],
      ['secrets', 'Secrets found', n(v?.secrets)],
      ['minutes', 'Minutes here', n(v?.minutes)],
    ];
    for (const [id, label, value] of rows) {
      const cell = document.createElement('div');
      cell.dataset.visitStat = id;
      Object.assign(cell.style, {
        display: 'flex',
        flexDirection: 'column-reverse',
        padding: '8px 6px',
        borderRadius: '10px',
        background: 'rgba(255,255,255,0.05)',
        border: '1px solid rgba(255,255,255,0.1)',
      });
      const dt = document.createElement('dt');
      dt.textContent = label;
      Object.assign(dt.style, { fontSize: '12px', color: '#c3cede' });
      const dd = document.createElement('dd');
      dd.textContent = String(value);
      Object.assign(dd.style, { margin: '0', fontSize: '20px', fontWeight: '700', color: '#fff' });
      cell.append(dt, dd);
      dl.appendChild(cell);
    }
    box.appendChild(dl);
    return box;
  }

  /** The Portfolio menu's 'Your visit' row (P2-D10): the summary on its own.
   *  Before any 'ds:goals' it shows the passport's count and zeros. */
  showVisitSummary(): void {
    const modal = this.buildCenteredModal('min(380px, calc(100vw - 32px))', 'visit');
    const title = document.createElement('h2');
    title.textContent = 'Your visit';
    Object.assign(title.style, { margin: '0 0 12px', color: '#8a9bff' });
    modal.appendChild(title);
    const visit = this.goals?.visit ?? {
      stamps: this.passport?.count() ?? 0,
      villagers: 0,
      coins: 0,
      secrets: 0,
      minutes: 0,
    };
    const block = this.visitSummaryBlock(visit);
    block.querySelector('h3')?.remove();
    modal.appendChild(block);
    const shareRow = document.createElement('div');
    shareRow.appendChild(
      this.makeShareButton('📣 Share the island', {
        surface: 'visit_summary',
        url: buildShareUrl(),
        title: 'DigiScalability Life Island',
        text: 'A 3D portfolio island you can walk around — take the tour:',
      }),
    );
    modal.appendChild(shareRow);
    trackOnce('visit_summary_opened');
    this.overlay.appendChild(modal);
  }

  /**
   * Build a centered, dismissible modal shell (backdrop click + × close). Shared
   * by the passport views; content is appended by the caller.
   */
  /**
   * The bank vault panel (economy P2). Rebuilt in place on every balance
   * change — the same re-render-on-action pattern the shop uses. Coins shown
   * are the LOCAL pocket; balance is the server's last ack.
   */
  private vaultDiv: HTMLElement | null = null;

  public showVaultPanel(
    balance: number,
    pocket: number,
    step: number,
    on: {
      deposit: () => void;
      withdraw: () => void;
      depositAll?: () => void;
      withdrawAll?: () => void;
    },
  ): void {
    this.vaultDiv?.remove();
    const modal = this.buildCenteredModal('min(340px, calc(100vw - 32px))', 'vault', {
      label: 'Island Bank',
    });
    this.vaultDiv = modal;
    const h = document.createElement('div');
    h.innerHTML = `<div style="font-size:28px">🏦</div>
      <div style="font-weight:600;margin:6px 0 2px">Island Bank</div>
      <div style="opacity:.75;font-size:13px">The teller keeps your vault to the coin.</div>
      <div style="margin:14px 0;font-size:15px">Vault: <strong>${balance} 🪙</strong>
        &nbsp;·&nbsp; Pocket: <strong>${pocket} 🪙</strong></div>`;
    modal.appendChild(h);
    const row = document.createElement('div');
    Object.assign(row.style, { display: 'flex', gap: '10px', justifyContent: 'center' });
    const mk = (label: string, fn: () => void): HTMLButtonElement => {
      const b = document.createElement('button');
      b.textContent = label;
      Object.assign(b.style, {
        padding: '10px 14px',
        borderRadius: '10px',
        border: '1px solid rgba(255,255,255,0.25)',
        background: 'rgba(255,255,255,0.08)',
        color: 'white',
        cursor: 'pointer',
        fontSize: '14px',
      });
      b.addEventListener('click', fn);
      return b;
    };
    row.appendChild(mk(`⬇️ Deposit ${step}`, on.deposit));
    row.appendChild(mk(`⬆️ Withdraw ${step}`, on.withdraw));
    modal.appendChild(row);
    if (on.depositAll || on.withdrawAll) {
      const row2 = document.createElement('div');
      Object.assign(row2.style, {
        display: 'flex',
        gap: '10px',
        justifyContent: 'center',
        marginTop: '8px',
      });
      if (on.depositAll) row2.appendChild(mk('⬇️ Deposit all', on.depositAll));
      if (on.withdrawAll) row2.appendChild(mk('⬆️ Withdraw all', on.withdrawAll));
      modal.appendChild(row2);
    }
    this.overlay.appendChild(modal);
  }

  public closeVaultPanel(): void {
    this.vaultDiv?.remove();
    this.vaultDiv = null;
    this.panels.notifyClosed('vault');
  }

  /** Coin receipt / history — the last transactions with their source + amount.
   *  Opened by tapping the coin HUD chip. Labels are trusted fixed strings, but
   *  escaped defensively since some carry a provider name. */
  public showReceipt(entries: ReadonlyArray<{ label: string; amount: number; t: number }>): void {
    this.receiptDiv?.remove();
    const modal = this.buildCenteredModal('min(360px, calc(100vw - 32px))', 'receipt', {
      label: 'Coin history',
    });
    this.receiptDiv = modal;
    const now = Date.now();
    const esc = (s: string): string =>
      s.replace(/[<>&]/g, (c) => (c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&amp;'));
    const ago = (t: number): string => {
      const s = Math.max(0, Math.round((now - t) / 1000));
      if (s < 60) return `${s}s ago`;
      const m = Math.round(s / 60);
      return m < 60 ? `${m}m ago` : `${Math.round(m / 60)}h ago`;
    };
    const rows = entries.length
      ? entries
          .slice()
          .reverse()
          .map((e) => {
            const gain = e.amount > 0;
            const amt = `${gain ? '+' : '−'}${Math.abs(e.amount)} 🪙`;
            return `<div style="display:flex;justify-content:space-between;gap:12px;padding:7px 2px;border-top:1px solid rgba(255,255,255,0.08);font-size:14px;">
              <span style="opacity:.9">${esc(e.label)}</span>
              <span style="white-space:nowrap"><strong style="color:${gain ? '#7fe08a' : '#ff9a7a'}">${amt}</strong>
                <span style="opacity:.5;font-size:12px;margin-left:8px">${ago(e.t)}</span></span>
            </div>`;
          })
          .join('')
      : '<div style="opacity:.6;font-size:13px;padding:14px 0">No coin activity yet — sell, race, or run an errand.</div>';
    const h = document.createElement('div');
    h.innerHTML = `<div style="font-size:24px">📜</div>
      <div style="font-weight:600;margin:6px 0 2px">Coin history</div>
      <div style="opacity:.7;font-size:13px;margin-bottom:8px">Your last ${entries.length} transactions</div>
      <div style="text-align:left;max-height:min(50vh,320px);overflow-y:auto">${rows}</div>`;
    modal.appendChild(h);
    this.overlay.appendChild(modal);
  }

  public closeReceipt(): void {
    this.receiptDiv?.remove();
    this.receiptDiv = null;
    this.panels.notifyClosed('receipt');
  }

  /**
   * Shared centred-modal shell. Every call site passes a distinguishing `id`
   * so the PanelManager gives all of them exclusivity (no more stacked
   * modals), a scrim, Escape, and the chip-hide policy — in one place.
   * A modal that removes itself outside the ✕ path (timed success screens)
   * must call `this.panels.notifyClosed(id)` alongside its remove().
   */
  private buildCenteredModal(
    width: string,
    id = 'modal',
    opts: {
      /** Panels left open underneath: the passport crown over a hall panel. */
      allow?: string[];
      /** The dialog's name when its title is not a heading (axe
       *  aria-dialog-name: the coin history, the bank, the build modals). */
      label?: string;
      /** Runs once when the modal closes by the manager (Escape, the scrim,
       *  Back, a sweep), its × or closeCenteredModal. */
      onClose?: () => void;
    } = {},
  ): HTMLElement {
    const modal = document.createElement('div');
    let closed = false;
    const closedOnce = (): void => {
      if (closed) return;
      closed = true;
      opts.onClose?.();
    };
    this.modalClosed.set(modal, closedOnce);
    this.panels.open(id, {
      kind: 'modal',
      hides: ['nav-chips', 'touch-controls', 'aux-controls'],
      close: () => {
        modal.remove();
        closedOnce();
      },
      el: modal, // a removed modal pops even if its close path never notifies
      allow: opts.allow,
      label: opts.label,
    });
    this.stepHintAside(true); // nothing paints over a modal (D6)
    Object.assign(modal.style, {
      position: 'fixed',
      top: '50%',
      left: '50%',
      transform: 'translate(-50%, -50%)',
      background: 'rgba(12, 12, 20, 0.96)',
      color: 'white',
      padding: '24px',
      borderRadius: '16px',
      pointerEvents: 'auto',
      zIndex: '1650',
      width,
      textAlign: 'center',
      border: '1px solid rgba(255,255,255,0.15)',
      boxShadow: '0 12px 40px rgba(0,0,0,0.5)',
      // A centered modal taller than the screen (island map in phone
      // landscape: 430px canvas + legend on a 375px viewport) clipped its ×,
      // title and legend with NO scroll path — body overflow is hidden and
      // position:fixed escapes the page. Clamp + scroll inside instead.
      maxHeight: 'calc(100dvh - 32px)',
      overflowY: 'auto',
      boxSizing: 'border-box',
    });
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    const close = document.createElement('button');
    close.textContent = '×';
    close.setAttribute('aria-label', 'Close');
    Object.assign(close.style, {
      position: 'absolute',
      top: '2px',
      right: '4px',
      background: 'transparent',
      color: 'white',
      border: 'none',
      fontSize: '24px',
      cursor: 'pointer',
      // A bare '×' was a ~26×30px target — this is the ONLY explicit dismiss
      // on all the centered modals, so give it the full 44px thumb box
      // (glyph stays visually where it was; the box grew around it).
      width: '44px',
      height: '44px',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '0',
    });
    close.addEventListener('click', () => this.closeCenteredModal(modal, id));
    modal.appendChild(close);
    // Short landscape: a scroll cue on a modal taller than the screen (D5).
    // A frame later, once its caller has filled and appended it.
    if (window.innerHeight <= 500) {
      requestAnimationFrame(() => {
        if (modal.isConnected) this.addScrollFade(modal, 'rgba(12,12,20,0.96)');
      });
    }
    return modal;
  }

  /** Each centred modal's close hook (buildCenteredModal's onClose). */
  private readonly modalClosed = new WeakMap<HTMLElement, () => void>();

  /** Close a centred modal from one of its own controls: what its × does. */
  private closeCenteredModal(modal: HTMLElement, id: string): void {
    modal.remove();
    this.panels.notifyClosed(id);
    this.modalClosed.get(modal)?.();
  }

  /**
   * One share button, consistent everywhere. Calls Share.share() and toasts the
   * outcome the user can't otherwise see (clipboard copy); native sheet and
   * user-dismissal need no follow-up noise.
   */
  private makeShareButton(
    label: string,
    opts: { surface: string; url: string; title?: string; text?: string },
  ): HTMLButtonElement {
    const btn = document.createElement('button');
    // The share icon from the sprite, in place of a leading emoji (D13).
    SimpleUI.chipContent(btn, 'share', label.replace(/^\p{Extended_Pictographic}\uFE0F?\s*/u, ''));
    Object.assign(btn.style, {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '7px',
      padding: '9px 16px',
      minHeight: this.isTouch ? '44px' : '', // a thumb target (it measured 38)
      borderRadius: '10px',
      border: '1px solid rgba(120,160,255,0.45)',
      background: 'rgba(80,130,255,0.18)',
      color: '#cfe0ff',
      fontSize: '14px',
      fontWeight: '600',
      cursor: 'pointer',
    });
    btn.addEventListener('click', () => {
      void share(opts).then((outcome) => {
        if (outcome === 'copied') this.toast('🔗 Link copied — paste it anywhere!');
        else if (outcome === 'failed') this.toast('Could not share on this device.');
      });
    });
    return btn;
  }

  /** Escape user-provided text before it goes into innerHTML. Guestbook notes
   *  and peer names are shown to OTHER visitors, so this is a real XSS guard —
   *  cleanChatText masks slurs but does not neutralise markup. Takes unknown
   *  because network fields are not type-checked on arrival. */
  private escapeHtml(s: unknown): string {
    return String(s ?? '').replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
    );
  }

  /** Contact-zone lead form → a PRIVATE leads node (owner-only), giving a real
   *  "get in touch" path beyond the mailto link. Email is used only to reply. */
  private appendLeadForm(container: HTMLElement): void {
    const form = document.createElement('div');
    // Anchor id: ReceptionDesk inserts itself BEFORE this block. It loads via a
    // dynamic import, so it always resolves after this synchronous append and
    // cannot rely on append order for placement.
    form.id = 'lead-form-block';
    form.style.cssText =
      'margin-top:18px;text-align:left;border-top:1px solid rgba(255,255,255,0.12);padding-top:16px;';
    // 16px on touch: same anti-focus-zoom defense the chat inputs carry — iOS
    // zooms any focused field under 16px even where user-scalable=no is ignored
    // (in-app webviews), and this is the site's primary conversion form.
    // font-family:inherit: form controls default to the UA font, which left
    // the message box in monospace. aria-label + autocomplete: the fields
    // had placeholders only (axe: unlabelled form fields).
    const field = `width:100%;box-sizing:border-box;${this.isTouch ? 'min-height:44px;' : ''}margin:0 0 8px;padding:9px 11px;border:none;border-radius:8px;background:rgba(255,255,255,0.1);color:#fff;font-family:inherit;font-size:${this.isTouch ? '16px' : '14px'};outline:1px solid rgba(255,255,255,0.15);`;
    form.innerHTML = `
      <h3 style="margin:0 0 4px;font-size:15px;">Or send a message</h3>
      <p style="margin:0 0 10px;font-size:12px;color:#9aa;">Straight to my inbox — I'll reply personally.</p>
      <input id="lead-name" aria-label="Your name (optional)" autocomplete="name" placeholder="Your name (optional)" maxlength="80" style="${field}" />
      <input id="lead-email" type="email" aria-label="Your email" autocomplete="email" placeholder="Your email" maxlength="120" style="${field}" />
      <textarea id="lead-msg" aria-label="Your message" autocomplete="off" placeholder="A role, a project, or a question" maxlength="1000" rows="3" style="${field}resize:vertical;"></textarea>
      <button id="lead-send" style="width:100%;${this.isTouch ? 'min-height:44px;' : ''}padding:11px;border:none;border-radius:10px;background:linear-gradient(135deg,#9C27B0,#6a1b9a);color:#fff;font-size:15px;font-weight:600;cursor:pointer;">Send message</button>
      <p id="lead-error" role="alert" hidden style="margin:8px 0 0;font-size:13px;line-height:1.4;color:#ffb4a8;"></p>
      <p style="margin:8px 0 0;font-size:12px;color:#889;">Your email is used only to reply. <a href="/privacy.html" target="_blank" rel="noopener" style="color:#b39ddb;${this.isTouch ? 'display:inline-flex;align-items:center;justify-content:center;min-height:44px;min-width:44px;' : ''}">Privacy</a></p>`;
    container.appendChild(form);
    // Keep keystrokes out of the game while typing.
    form
      .querySelectorAll('input,textarea')
      .forEach((el) => el.addEventListener('keydown', (e) => e.stopPropagation()));
    const btn = form.querySelector('#lead-send') as HTMLButtonElement | null;
    // Errors show inline (D6, UX-05): a role=alert line, aria-invalid on the
    // field and focus on it. A toast here landed over the email and message
    // fields on a phone, and screen readers never heard it.
    const errEl = form.querySelector<HTMLElement>('#lead-error')!;
    const emailEl = form.querySelector('#lead-email') as HTMLInputElement;
    this.clearFormErrorOnInput(errEl, form.querySelectorAll<HTMLElement>('input,textarea'));
    btn?.addEventListener('click', async () => {
      const name = (form.querySelector('#lead-name') as HTMLInputElement).value;
      const email = emailEl.value;
      const msg = (form.querySelector('#lead-msg') as HTMLTextAreaElement).value;
      if (!email.trim()) {
        this.formError(errEl, 'Please add your email.', emailEl);
        return;
      }
      btn.disabled = true;
      btn.textContent = 'Sending…';
      // The import is INSIDE the try. Boards is lazy-loaded at five sites and
      // imported statically nowhere, so it is always a separate chunk; on a
      // flaky connection the rejection used to escape this async handler,
      // leaving the site's primary conversion control disabled on "Sending…"
      // forever with the typed message stranded.
      let ok = false;
      try {
        const { submitLead } = await import('./Boards');
        ok = await submitLead(name, email, msg);
      } catch {
        ok = false;
      }
      if (ok) {
        track('lead_submitted');
        form.innerHTML = `<p style="font-size:15px;color:#a5d6a7;text-align:center;padding:12px 0;">✓ Thanks${
          name.trim() ? ', ' + this.escapeHtml(name.trim()) : ''
        }! I'll be in touch soon.</p>`;
      } else {
        btn.disabled = false;
        btn.textContent = 'Send message';
        // submitLead returns false for BOTH a malformed email and any backend
        // failure (auth, rules, offline, blocked domain). Blaming the address
        // for a network fault sends a recruiter with a perfectly good email
        // into a retype loop and then away. Re-test client-side and only
        // accuse the address when it is actually wrong.
        track('lead_failed'); // the missing half of the funnel — success was tracked, failure never
        const good = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim());
        this.formError(
          errEl,
          good
            ? 'Could not send — try again, or email admin@digiscalability.com.'
            : 'Please check your email address.',
          good ? null : emailEl,
        );
      }
    });
  }

  /** An inline form error (D6): the form's role=alert line says it, the
   *  field at fault gets aria-invalid and focus. `field` null: nothing the
   *  visitor typed is wrong (a network failure), so focus stays put. */
  private formError(errEl: HTMLElement, msg: string, field: HTMLElement | null): void {
    errEl.textContent = msg;
    errEl.hidden = false;
    const form = errEl.parentElement;
    form?.querySelectorAll('[aria-invalid]').forEach((f) => f.removeAttribute('aria-invalid'));
    if (!field) return;
    field.setAttribute('aria-invalid', 'true');
    field.setAttribute('aria-describedby', errEl.id);
    field.focus();
  }

  /** Typing again clears the error. */
  private clearFormErrorOnInput(errEl: HTMLElement, fields: Iterable<HTMLElement>): void {
    for (const f of fields) {
      f.addEventListener('input', () => {
        if (errEl.hidden) return;
        errEl.hidden = true;
        errEl.textContent = '';
        errEl.parentElement
          ?.querySelectorAll('[aria-invalid]')
          .forEach((n) => n.removeAttribute('aria-invalid'));
      });
    }
  }

  /** Global race leaderboard: fastest laps per circuit. */
  async showLeaderboard(): Promise<void> {
    const modal = this.buildCenteredModal('min(360px, calc(100vw - 32px))', 'leaderboard');
    modal.insertAdjacentHTML(
      'beforeend',
      `<h2 style="margin:0 0 4px;color:#8a9bff;">🏁 Leaderboard</h2>
       <p style="margin:0 0 14px;font-size:13px;color:#aab;">Fastest checkpoint laps. Board a vehicle and race!</p>
       <div id="lb-body" style="text-align:left;">Loading…</div>`,
    );
    trackOnce('leaderboard_opened');
    this.overlay.appendChild(modal);
    const fmt = (ms: number) => `${(ms / 1000).toFixed(2)}s`;
    const section = (title: string, entries: Array<{ name: string; timeMs: number }>) =>
      `<h3 style="margin:14px 0 6px;font-size:14px;color:#cdd;">${title}</h3>` +
      (entries.length
        ? entries
            .map(
              (e, i) =>
                `<div style="display:flex;justify-content:space-between;padding:5px 8px;border-radius:8px;
                  background:${i === 0 ? 'rgba(245,179,1,0.14)' : 'rgba(255,255,255,0.03)'};margin:3px 0;font-size:13px;">
                  <span>${i + 1}. ${this.escapeHtml(e.name)}</span><span style="font-variant-numeric:tabular-nums;">${fmt(e.timeMs)}</span></div>`,
            )
            .join('')
        : `<p style="margin:2px 0 0;font-size:12px;color:#889;">No times yet — be the first!</p>`);
    const body = modal.querySelector<HTMLElement>('#lb-body');
    // A failed read says so, with a Retry (D10): it used to print 'No times
    // yet — be the first!' over a blocked or offline backend.
    const load = async (): Promise<void> => {
      if (body) body.textContent = 'Loading…';
      // Both circuits or the error: half a leaderboard reads as a quiet one.
      const res = await this.readBoard(async (b) => {
        const [land, water] = await Promise.all([
          b.readLeaderboard('land'),
          b.readLeaderboard('water'),
        ]);
        return land.ok && water.ok
          ? { ok: true as const, entries: [land.entries, water.entries] }
          : { ok: false as const };
      });
      if (!body || !modal.isConnected) return;
      if (!res.ok) {
        this.boardError(body, "Couldn't reach the leaderboard. Check your connection.", load);
        return;
      }
      body.innerHTML =
        section('🚗 Land circuit', res.entries[0]) + section('⛵ Water circuit', res.entries[1]);
    };
    await load();
    modal.appendChild(this.makeRaceGuideButton(modal, 'leaderboard', 'leaderboard'));
  }

  /** A Boards read as a result. The import sits inside the try: Boards is
   *  its own chunk, and a failed chunk load is a failed read too. */
  private async readBoard<T>(
    read: (boards: typeof import('./Boards')) => Promise<BoardRead<T>>,
  ): Promise<BoardRead<T>> {
    try {
      return await read(await import('./Boards'));
    } catch {
      return { ok: false };
    }
  }

  /** A board that could not be read: the line, and a 44 px Retry (D10). */
  private boardError(body: HTMLElement, message: string, retry: () => Promise<void>): void {
    body.textContent = '';
    const line = document.createElement('p');
    line.setAttribute('role', 'alert');
    line.dataset.boardError = '1';
    line.textContent = message;
    Object.assign(line.style, {
      margin: '4px 0 10px',
      fontSize: '13px',
      lineHeight: '1.4',
      color: '#ffb4a8',
    });
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = 'Retry';
    btn.dataset.boardRetry = '1';
    Object.assign(btn.style, {
      minHeight: '44px',
      minWidth: '96px',
      padding: '0 18px',
      borderRadius: '10px',
      border: '1px solid rgba(143,155,255,0.8)',
      background: 'rgba(76,91,224,0.14)',
      color: '#fff',
      fontSize: '14px',
      fontWeight: '600',
      cursor: 'pointer',
    });
    btn.addEventListener('click', () => {
      btn.disabled = true;
      void retry();
    });
    body.append(line, btn);
  }

  /** "Take me to the start line" — closes the modal and compass-guides there.
   *  `panelId` is the id the modal was opened under (buildCenteredModal). */
  private makeRaceGuideButton(
    modal: HTMLElement,
    from: string,
    panelId: 'leaderboard' | 'race-leaderboard',
  ): HTMLButtonElement {
    const go = document.createElement('button');
    go.textContent = '📍 Guide me to the start line';
    Object.assign(go.style, {
      width: '100%',
      marginTop: '12px',
      padding: '10px',
      border: '1px solid rgba(255,215,121,0.4)',
      borderRadius: '10px',
      background: 'rgba(38,38,51,0.5)',
      color: '#ffd479',
      fontSize: '14px',
      fontWeight: '600',
      cursor: 'pointer',
    });
    go.addEventListener('click', () => {
      track('race_guide', { from });
      modal.remove();
      // The opener's id. This named 'race-leaderboard' for both callers, so
      // the Leaderboard's button left 'leaderboard' on the stack: scrim up,
      // chips dimmed, phone controls hidden under "Follow the compass" (UX-01).
      this.panels.notifyClosed(panelId);
      this.raceGuided = true;
      this.onRaceGuide?.();
    });
    return go;
  }

  /**
   * Auto-surfaced a beat after a race finish: the circuit's global top times
   * with the player's fresh run highlighted, plus a Share button. The global
   * board was otherwise buried two clicks deep in the Portfolio menu — you could
   * set a record and never know a leaderboard existed.
   */
  async showRaceLeaderboard(
    circuit: 'land' | 'water',
    playerTimeMs: number | null,
    playerName: string,
  ): Promise<void> {
    const modal = this.buildCenteredModal('min(360px, calc(100vw - 32px))', 'race-leaderboard');
    const title = circuit === 'land' ? '🚗 Land Circuit' : '⛵ Water Circuit';
    const fmt = (ms: number) => `${(ms / 1000).toFixed(2)}s`;
    modal.insertAdjacentHTML(
      'beforeend',
      `<h2 style="margin:0 0 4px;color:#8a9bff;">🏁 ${title}</h2>
       <p style="margin:0 0 12px;font-size:13px;color:#aab;">${
         playerTimeMs != null
           ? `Your run: <strong style="color:#ffd54a;">${fmt(playerTimeMs)}</strong>`
           : 'Global top times'
       }</p>
       <p id="rlb-status" role="status" style="margin:0 0 10px;font-size:14px;line-height:1.4;color:#dfe6ff;">${
         playerTimeMs != null ? 'Saving your time…' : 'Loading…'
       }</p>
       <div id="rlb-body" style="text-align:left;"></div>`,
    );
    trackOnce('leaderboard_opened');
    const shareRow = document.createElement('div');
    shareRow.style.cssText = 'margin-top:14px;';
    shareRow.appendChild(
      this.makeShareButton('📣 Challenge a friend', {
        surface: 'race_finish',
        // The link carries the gauntlet: recipients land guided to this
        // circuit's start line with "beat <time>" on their race HUD.
        url: buildShareUrl(
          playerTimeMs != null ? { race: circuit, beat: playerTimeMs } : { race: circuit },
        ),
        title: 'DigiScalability Life Island',
        text:
          playerTimeMs != null
            ? `I ran ${fmt(playerTimeMs)} on the ${circuit} circuit of this 3D island 🏁 — beat me:`
            : 'Race me around this 3D portfolio island 🏁',
      }),
    );
    modal.appendChild(shareRow);
    modal.appendChild(this.makeRaceGuideButton(modal, 'race_finish', 'race-leaderboard'));
    this.overlay.appendChild(modal);
    const status = modal.querySelector<HTMLElement>('#rlb-status');
    const body = modal.querySelector<HTMLElement>('#rlb-body');
    if (!status || !body) return;
    // The visitor's best lap, which RaceSystem keeps on this device whatever
    // the backend does.
    let localBestMs: number | null = null;
    try {
      const v = parseFloat(localStorage.getItem(`ds_race_best_${WORLD_ERA}_${circuit}`) ?? '');
      if (Number.isFinite(v) && v > 0) localBestMs = Math.round(v * 1000);
    } catch {
      /* no storage: the run's own time stands in */
    }
    const bestMs = localBestMs ?? playerTimeMs;
    const boardName = safePeerName(playerName);
    const mineIn = (entries: Array<{ name: string; timeMs: number }>): number =>
      playerTimeMs == null
        ? -1
        : entries.findIndex(
            (e) => e.timeMs === playerTimeMs && (e.name === playerName || e.name === boardName),
          );
    // An honest finish (P2-D6): 'Saving your time…' until the read returns,
    // "You're #N" only when the read-back holds this run, the failure with a
    // Retry, and no claim at all on an empty or failed read. It used to claim
    // a place on the board whenever the read came back empty, which is also
    // what a blocked backend returned.
    const load = async (): Promise<void> => {
      status.textContent = playerTimeMs != null ? 'Saving your time…' : 'Loading…';
      status.style.color = '#dfe6ff';
      body.textContent = '';
      let res = await this.readBoard((b) => b.readLeaderboard(circuit));
      // A new best is written as the race ends and read here 1.2 s later: a
      // read that beat the write gets one more look.
      if (
        res.ok &&
        playerTimeMs != null &&
        playerTimeMs === localBestMs &&
        mineIn(res.entries) < 0
      ) {
        await new Promise<void>((r) => window.setTimeout(r, SimpleUI.RACE_REREAD_MS));
        if (!modal.isConnected) return;
        const again = await this.readBoard((b) => b.readLeaderboard(circuit));
        if (again.ok) res = again;
      }
      if (!modal.isConnected) return;
      if (!res.ok) {
        status.textContent = '';
        this.boardError(
          body,
          bestMs != null
            ? `Couldn't reach the leaderboard — your best ${fmt(bestMs)} is saved on this device.`
            : "Couldn't reach the leaderboard.",
          load,
        );
        return;
      }
      const entries = res.entries;
      const mine = mineIn(entries);
      if (!entries.length) {
        status.textContent =
          bestMs != null
            ? `No times on the leaderboard yet. Your best ${fmt(bestMs)} is saved on this device.`
            : 'No times on the leaderboard yet.';
        return;
      }
      if (mine >= 0) {
        status.textContent = `You're #${mine + 1} on the leaderboard.`;
        status.style.color = '#ffd54a';
      } else {
        status.textContent = 'Top times on this circuit:';
      }
      body.innerHTML = entries
        .map((e, i) => {
          const me = i === mine;
          return `<div style="display:flex;justify-content:space-between;padding:6px 9px;border-radius:8px;
          background:${me ? 'rgba(245,179,1,0.22)' : i === 0 ? 'rgba(245,179,1,0.10)' : 'rgba(255,255,255,0.03)'};
          margin:3px 0;font-size:13px;${me ? 'outline:1px solid rgba(245,179,1,0.5);' : ''}">
          <span>${i + 1}. ${this.escapeHtml(e.name)}${me ? ' (you)' : ''}</span>
          <span style="font-variant-numeric:tabular-nums;">${fmt(e.timeMs)}</span></div>`;
        })
        .join('');
    };
    await load();
  }

  /** The wait before the race finish reads the board a second time. */
  private static readonly RACE_REREAD_MS = 1500;

  /** Guestbook: read recent notes + leave one. */
  async showGuestbook(): Promise<void> {
    const modal = this.buildCenteredModal('min(400px, calc(100vw - 32px))', 'guestbook');
    modal.insertAdjacentHTML(
      'beforeend',
      `<h2 style="margin:0 0 4px;color:#8a9bff;">✍️ Guestbook</h2>
       <p style="margin:0 0 12px;font-size:13px;color:#aab;">Leave a note for the next visitor.</p>
       <div style="display:flex;gap:8px;margin-bottom:12px;">
         <input id="gb-msg" aria-label="Your guestbook note" maxlength="200" placeholder="Say hi…" style="flex:1;padding:9px 12px;border-radius:10px;
           border:none;font-family:inherit;font-size:${this.isTouch ? '16px' : '14px'};background:rgba(255,255,255,0.1);color:#fff;outline:1px solid rgba(120,170,255,0.5);" />
         <button id="gb-sign" class="ds-press" disabled style="padding:9px 16px;border:none;border-radius:10px;background:${DS.primary};
           color:#fff;font-size:14px;font-weight:600;cursor:pointer;">Sign</button>
       </div>
       <p id="gb-error" role="alert" hidden style="margin:-4px 0 10px;font-size:13px;line-height:1.4;color:#ffb4a8;text-align:left;"></p>
       <div id="gb-body" style="text-align:left;max-height:40vh;overflow:auto;">Loading…</div>`,
    );
    // Sign waits for a note (D6): an empty Sign did nothing, silently.
    const gbInput = modal.querySelector<HTMLInputElement>('#gb-msg');
    const gbSign = modal.querySelector<HTMLButtonElement>('#gb-sign');
    const gbError = modal.querySelector<HTMLElement>('#gb-error')!;
    const syncSign = (): void => {
      if (gbSign) {
        gbSign.disabled = !gbInput?.value.trim();
        gbSign.style.opacity = gbSign.disabled ? '0.5' : '1';
        gbSign.style.cursor = gbSign.disabled ? 'default' : 'pointer';
      }
    };
    gbInput?.addEventListener('input', syncSign);
    syncSign();
    if (gbInput) this.clearFormErrorOnInput(gbError, [gbInput]);
    trackOnce('guestbook_opened');
    this.overlay.appendChild(modal);
    const body = modal.querySelector<HTMLElement>('#gb-body');
    // A failed read says so, with a Retry (D10): 'No notes yet — be the
    // first to sign!' was what a blocked or offline backend printed too.
    const render = async (): Promise<void> => {
      const res = await this.readBoard((b) => b.readGuestbook());
      if (!body || !modal.isConnected) return;
      if (!res.ok) {
        this.boardError(body, "Couldn't reach the guestbook. Check your connection.", async () => {
          body.textContent = 'Loading…';
          await render();
        });
        return;
      }
      const entries = res.entries;
      body.innerHTML = entries.length
        ? entries
            .map(
              (e) =>
                `<div style="padding:8px 10px;border-radius:10px;background:rgba(255,255,255,0.04);margin:6px 0;">
                  <div style="font-size:13px;font-weight:600;color:#bcd;">${this.escapeHtml(e.name)}</div>
                  <div style="font-size:13px;color:#eee;">${this.escapeHtml(e.msg)}</div></div>`,
            )
            .join('')
        : `<p style="font-size:12px;color:#889;">No notes yet — be the first to sign!</p>`;
    };
    await render();
    const input = modal.querySelector('#gb-msg') as HTMLInputElement | null;
    input?.addEventListener('keydown', (e) => e.stopPropagation()); // don't leak to game
    const name = (() => {
      try {
        return localStorage.getItem('ds_player_name') || 'Guest';
      } catch {
        return 'Guest';
      }
    })();
    const sign = async () => {
      const msg = input?.value.trim();
      if (!msg) return;
      // The import sits inside the try (as the lead form's does): Boards is
      // its own chunk, and a failed chunk load is a note that was not posted.
      let ok = false;
      try {
        const { signGuestbook } = await import('./Boards');
        ok = await signGuestbook(name, msg);
      } catch {
        ok = false;
      }
      if (ok) {
        if (input) input.value = '';
        syncSign();
        this.toast('✍️ Signed the guestbook!'); // shows inside the open guestbook (P2-D3)
        track('guestbook_signed');
        try {
          localStorage.setItem('ds_said_hi', '1');
        } catch {
          /* no storage */
        }
        this.onProgressMade?.();
        await render();
      } else {
        this.formError(gbError, 'Message could not be posted.', input);
      }
    };
    modal.querySelector('#gb-sign')?.addEventListener('click', () => void sign());
    input?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') void sign();
    });
  }

  /**
   * Cache the latest server notice + daily plan for the Island Times board.
   * Called from the world-beat subscription in main-simple. Pure state store —
   * the board reads these lazily when opened, so a beat mid-session is free.
   */
  public setIslandTimes(
    notice: NoticeState | null,
    plan: NpcPlan | null,
    archive: Array<{ day: string; lines: number[]; visitors?: number }> | null = null,
  ): void {
    this.latestNotice = notice;
    this.latestPlan = plan;
    this.latestArchive = archive;
  }

  /**
   * "📰 The Island Times" — a read-only front page composed ENTIRELY from
   * pre-authored strings + integers: notice-line templates (indexed by the
   * server), activity labels from ACTIVITY_DEFS, persona display names, and
   * numeric counts. Nothing user-generated can reach this by construction, so
   * it can never carry injected text — but we still escapeHtml defensively.
   */
  async showIslandTimes(): Promise<void> {
    const modal = this.buildCenteredModal('min(420px, calc(100vw - 32px))', 'island-times');
    try {
      localStorage.setItem('ds_read_times', '1');
    } catch {
      /* no storage */
    }
    this.onProgressMade?.();
    const T = SimpleUI.NOTICE_TEMPLATES;
    const notice = this.latestNotice;
    const plan = this.latestPlan;
    const day = notice?.day ?? new Date().toISOString().slice(0, 10);

    // Headline lines: server-chosen indices, bounded to our template list.
    const lines = (notice?.lines ?? [])
      .filter((i) => Number.isInteger(i) && i >= 0 && i < T.length)
      .map((i) => T[i]);
    if (!lines.length) lines.push(T[0]); // always show something

    // Count strip — numbers only, each shown only if present. Labels must match
    // the semantics the analyst sends: these are TOTALS (leads all-time, not
    // "new leads" — that mislabel overstated daily activity on the board).
    const c = notice?.counts ?? {};
    const countBits = [
      c.visitors != null ? `${c.visitors} visitor${c.visitors === 1 ? '' : 's'} today` : null,
      c.leads != null ? `${c.leads} lead${c.leads === 1 ? '' : 's'}` : null,
      c.guestbook != null ? `${c.guestbook} guestbook note${c.guestbook === 1 ? '' : 's'}` : null,
      c.races != null ? `${c.races} racer${c.races === 1 ? '' : 's'}` : null,
      // Integers only — the "nothing user-generated by construction" invariant
      // stays intact (the count arrives via setBuildCount, not the analyst).
      this.buildCount > 0
        ? `${this.buildCount} structure${this.buildCount === 1 ? '' : 's'} raised by visitors`
        : null,
    ].filter(Boolean) as string[];

    // Day-theme masthead line — pre-authored EVENT_META strings only (the
    // event id was already enum-checked in parseNpcPlan; `?? null` guards the
    // dev/?plan= path where event is absent).
    const ev = plan?.event ? (EVENT_META[plan.event] ?? null) : null;

    // "Who's about today" — from the daily plan's persona→activity map.
    const doing: string[] = [];
    if (plan?.assignments) {
      for (const [id, act] of Object.entries(plan.assignments)) {
        const name = SimpleUI.ID_TO_NAME[id];
        const def = (
          ACTIVITY_DEFS as Record<string, { label?: string; emoji?: string } | undefined>
        )[act];
        if (name && def?.label)
          doing.push(`${def.emoji ?? '•'}  The ${name} is ${def.label} today.`);
      }
    }

    const esc = (s: string) => this.escapeHtml(s);
    modal.insertAdjacentHTML(
      'beforeend',
      `<h2 style="margin:0 0 2px;color:#ffd479;">📰 The Island Times</h2>
       <p style="margin:0 0 14px;font-size:12px;color:#9aa;letter-spacing:0.5px;text-transform:uppercase;">${esc(day)}${
         ev ? ` · ${esc(`${ev.emoji} ${ev.label}`)}` : ''
       }</p>
       <div style="text-align:left;">
         <div style="font-size:15px;line-height:1.55;color:#eee;border-left:3px solid #ffd479;padding-left:12px;">
           ${lines.map(esc).join(' ')}
         </div>
         ${
           countBits.length
             ? `<p style="margin:12px 0 0;font-size:12px;color:#9ab;">${esc(countBits.join('  ·  '))}</p>`
             : ''
         }
         ${
           doing.length
             ? `<h3 style="margin:18px 0 8px;font-size:13px;color:#8a9bff;text-transform:uppercase;letter-spacing:0.5px;">Who's about today</h3>
                <div style="max-height:34vh;overflow:auto;">${doing
                  .map(
                    (l) =>
                      `<div style="padding:5px 0;font-size:13px;color:#dde;border-bottom:1px solid rgba(255,255,255,0.05);">${esc(l)}</div>`,
                  )
                  .join('')}</div>`
             : `<p style="margin:16px 0 0;font-size:12px;color:#889;">The town's plans for today haven't been posted yet — check back soon.</p>`
         }
       </div>`,
    );
    // Past editions: durable, visible proof the pipeline has been running
    // nightly — one day's edition could be faked; a dated archive can't.
    const past = (this.latestArchive ?? []).filter((e) => e.day !== day).slice(0, 7);
    if (past.length) {
      const rows = past
        .map((e) => {
          const line = T[e.lines[0] ?? 0] ?? T[0];
          return `<div style="padding:4px 0;font-size:12px;color:#9ab;border-bottom:1px solid rgba(255,255,255,0.04);">
            <span style="color:#788;">${esc(e.day)}</span> — ${esc(line)}</div>`;
        })
        .join('');
      modal.insertAdjacentHTML(
        'beforeend',
        `<h3 style="margin:16px 0 6px;font-size:12px;color:#8a9bff;text-transform:uppercase;letter-spacing:0.5px;text-align:left;">Past editions</h3>
         <div style="text-align:left;max-height:18vh;overflow:auto;">${rows}</div>`,
      );
    }
    // Rumor corner: the SAME rumor-of-the-day the townsfolk are whispering
    // (deterministic Melbourne-day pick, synced with the npcChat function) —
    // the paper and the NPCs never disagree, and both point at a real secret.
    modal.insertAdjacentHTML(
      'beforeend',
      `<h3 style="margin:16px 0 4px;font-size:12px;color:#e0b04a;text-transform:uppercase;letter-spacing:0.5px;text-align:left;">🗝️ Rumor corner</h3>
       <p style="margin:0;font-size:13px;color:#cbd;font-style:italic;text-align:left;">“${rumorOfTheDay()}”</p>`,
    );
    // The byline is the proof-of-autonomy line — without it the board reads as
    // hand-authored flavour text instead of a nightly agent pipeline.
    modal.insertAdjacentHTML(
      'beforeend',
      `<p style="margin:14px 0 0;font-size:12px;color:#788;font-style:italic;">
        Compiled nightly by the island's AI analyst · daily jobs assigned by the AI town planner</p>`,
    );
    trackOnce('island_times_opened');
    this.overlay.appendChild(modal);
  }

  private emoteWheel: HTMLElement | null = null;
  private emoteWheelCatcher: HTMLElement | null = null;
  /** 😀 button in the top-right icon row: opens a small emote wheel. Emotes are
   *  sent through the normal chat pipeline, so they get proximity bubbles,
   *  moderation and muting for free — no separate protocol. */
  private createEmoteButton(): void {
    const btn = document.createElement('div');
    SimpleUI.chipContent(btn, 'smile');
    Object.assign(btn.style, {
      ...CHIP_ICON,
      top: 'calc(var(--sat, 0px) + 88px)',
      right: 'calc(var(--sar, 0px) + 124px)', // icon row slot 4 (38px pitch)
    });
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleEmoteWheel();
    });
    this.makeHudButtonAccessible(btn, 'Send an emote');
    if (this.isTouch) {
      // Tier 2: the one-tap social action sits alone under the tier-1 row
      // (high frequency — one tap, never buried in the drawer). Yields its
      // spot via visibility while the drawer fans out over it.
      Object.assign(btn.style, {
        top: 'calc(var(--sat, 0px) + 84px)',
        right: 'calc(var(--sar, 0px) + 10px)',
      });
    }
    this.emoteBtnEl = btn;
    this.overlay.appendChild(btn);
    this.panels.registerLayer('nav-chips', btn);
  }

  private toggleEmoteWheel(): void {
    if (this.emoteWheel) {
      this.emoteWheel.remove();
      this.emoteWheel = null;
      this.emoteWheelCatcher?.remove();
      this.emoteWheelCatcher = null;
      this.panels.notifyClosed('emote-wheel');
      return;
    }
    // A menu of emotes (UX-15): focus lands on the first, the arrows walk
    // the 4x2 grid, and Escape closes it (PanelManager) with focus back on 😀.
    const wheel = document.createElement('div');
    wheel.setAttribute('role', 'menu');
    wheel.setAttribute('aria-label', 'Emotes');
    this.panels.open('emote-wheel', {
      kind: 'sheet',
      hides: ['nav-chips'], // the wheel opens exactly over the chip column
      close: () => {
        this.emoteWheel?.remove();
        this.emoteWheel = null;
        this.emoteWheelCatcher?.remove();
        this.emoteWheelCatcher = null;
      },
      history: false, // transient: Back is not spent on it
      el: wheel,
      initialFocus: () => wheel.querySelector<HTMLElement>('button'),
    });
    // Outside tap dismisses (drawer's catcher pattern). Without it, touch had
    // NO dismissal: hides:['nav-chips'] hides the 😀 toggle itself and phones
    // have no Escape — the only way out was sending an emote you didn't want.
    const catcher = document.createElement('div');
    Object.assign(catcher.style, {
      position: 'fixed',
      inset: '0',
      zIndex: '1690', // under the wheel's 1700
      pointerEvents: 'auto',
      background: 'transparent',
    });
    catcher.addEventListener('click', () => this.toggleEmoteWheel());
    this.overlay.appendChild(catcher);
    this.emoteWheelCatcher = catcher;
    Object.assign(wheel.style, {
      position: 'absolute',
      top: 'calc(var(--sat, 0px) + 132px)',
      right: 'calc(var(--sar, 0px) + 10px)',
      display: 'grid',
      gridTemplateColumns: 'repeat(4, 1fr)',
      gap: '6px',
      background: 'rgba(12,12,20,0.96)',
      padding: '10px',
      borderRadius: '12px',
      border: '1px solid rgba(255,255,255,0.15)',
      pointerEvents: 'auto',
      zIndex: '1700',
      boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
    });
    // Single-codepoint emoji (no ZWJ sequences) so they survive text cleaning.
    const side = this.isTouch ? '48px' : '40px'; // a thumb target on touch
    ['👋', '😂', '❤️', '🎉', '👍', '🔥', '😮', '🙌'].forEach((emo) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = emo;
      b.setAttribute('role', 'menuitem');
      b.setAttribute('aria-label', `Send ${emo}`);
      Object.assign(b.style, {
        width: side,
        height: side,
        fontSize: '20px',
        background: 'rgba(255,255,255,0.06)',
        border: '1px solid rgba(255,255,255,0.12)',
        borderRadius: '10px',
        cursor: 'pointer',
      });
      b.addEventListener('click', () => {
        this.onChatSend?.(emo);
        track('emote_sent', { emote: emo });
        this.toggleEmoteWheel();
      });
      wheel.appendChild(b);
    });
    const steps: Record<string, number> = {
      ArrowLeft: -1,
      ArrowRight: 1,
      ArrowUp: -4,
      ArrowDown: 4,
    };
    wheel.addEventListener('keydown', (e) => {
      const step = steps[e.key];
      if (step === undefined) return;
      const items = Array.from(wheel.querySelectorAll<HTMLElement>('button'));
      const i = items.indexOf(document.activeElement as HTMLElement);
      e.preventDefault();
      items[(Math.max(0, i) + step + items.length) % items.length]?.focus();
    });
    this.emoteWheel = wheel;
    this.overlay.appendChild(wheel);
  }

  /** Hide the mobile 🎤 button where voice can't work (e.g. iOS Safari, where
   *  MediaRecorder doesn't support opus) — text chat still works there.
   *  Defaults visible; call once Chat.voiceSupported is known. */
  public setVoiceSupported(supported: boolean): void {
    if (this.micBtn) this.micBtn.style.display = supported ? '' : 'none';
  }

  /** Open the one-line chat input (Enter sends, Esc/blur cancels). */
  public openChatInput(): void {
    if (this.chatInput) {
      this.chatInput.focus();
      return;
    }
    const input = document.createElement('input');
    input.type = 'text';
    input.maxLength = 120;
    input.setAttribute('aria-label', 'Type a message to nearby players');
    input.placeholder = 'Say something…';
    Object.assign(input.style, {
      position: 'absolute',
      left: '50%',
      bottom: 'calc(var(--sab, 0px) + 96px)',
      transform: 'translateX(-50%)',
      // Touch: wider (nothing else competes — the panel hides touch-controls)
      // and 16px, which kills iOS's focus auto-zoom even where
      // user-scalable=no is ignored.
      width: this.isTouch ? 'min(92vw, 420px)' : 'min(70vw, 420px)',
      padding: '10px 14px',
      borderRadius: '12px',
      border: 'none',
      fontSize: this.isTouch ? '16px' : '15px',
      fontFamily: 'system-ui, sans-serif',
      background: 'rgba(12,12,20,0.92)',
      color: '#fff',
      outline: '1px solid rgba(120,170,255,0.55)', // was 2px @ 0.9 — the brightest glow in the HUD
      pointerEvents: 'auto',
      zIndex: '1700',
    });
    // Quick-phrase chips (touch only): sending a canned greeting without a
    // keyboard, which is otherwise painful to do over a full-screen 3D canvas.
    let chipsRow: HTMLElement | null = null;
    let vvHandler: (() => void) | null = null;

    const close = () => {
      // Idempotent: removing the focused input fires `blur`, whose handler also
      // calls close() — guard so the second call doesn't double-remove (which
      // throws NotFoundError). Null the ref first, then detach.
      if (this.chatInput !== input) return;
      this.chatInput = null;
      input.remove();
      chipsRow?.remove();
      if (vvHandler && window.visualViewport) {
        window.visualViewport.removeEventListener('resize', vvHandler);
        window.visualViewport.removeEventListener('scroll', vvHandler);
      }
      // Blur-race safe: during another panel's open sweep this is a no-op.
      this.panels.notifyClosed('chat-input');
    };
    // Hiding touch-controls is what STRUCTURALLY kills the chips-over-JUMP
    // collision: while typing, JUMP isn't there to collide with. The input's
    // own Escape handler (stopPropagation) owns the key.
    this.panels.open('chat-input', {
      kind: 'sheet',
      hides: ['touch-controls', 'aux-controls'],
      ownEscape: true,
      close,
      history: false, // transient: Back is not spent on it
    });
    input.addEventListener('keydown', (e) => {
      e.stopPropagation(); // critical: don't leak movement/hotkeys to the game while typing
      if (e.key === 'Enter') {
        const t = input.value;
        this.chatDraft = '';
        close();
        if (t.trim()) this.onChatSend?.(t);
      } else if (e.key === 'Escape') {
        this.chatDraft = '';
        close();
      }
    });
    // Blur (soft-keyboard collapse, tap-away) must PRESERVE the draft, not drop
    // it. Guard on `chatInput === input`: close() removes the still-focused
    // input, which fires a second blur — without the guard a just-sent or
    // just-cleared message would be resurrected as a draft.
    input.addEventListener('blur', () => {
      if (this.chatInput === input) {
        this.chatDraft = input.value;
        this.chatDraftTime = performance.now();
      }
      close();
    });
    this.overlay.appendChild(input);

    if (this.isTouch) {
      chipsRow = document.createElement('div');
      Object.assign(chipsRow.style, {
        position: 'absolute',
        left: '50%',
        bottom: 'calc(var(--sab, 0px) + 140px)',
        transform: 'translateX(-50%)',
        display: 'flex',
        gap: '8px',
        flexWrap: 'wrap',
        justifyContent: 'center',
        // 92vw is safe now: the chat panel's policy hides touch-controls,
        // so JUMP isn't there to collide with.
        width: 'min(92vw, 460px)',
        pointerEvents: 'auto',
        zIndex: '1700',
      });
      ['👋 Hi!', 'Nice island!', 'How do I race?', '🎉 GG'].forEach((phrase) => {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.textContent = phrase;
        Object.assign(chip.style, {
          padding: '8px 12px',
          borderRadius: '999px',
          border: '1px solid rgba(255,255,255,0.2)',
          background: 'rgba(12,12,20,0.9)',
          color: '#fff',
          fontSize: '17px', // match the input: no iOS zoom, bigger tap targets
          cursor: 'pointer',
        });
        // pointerdown + preventDefault: fire before the input's blur→close and
        // keep focus off the chip, so the tap reliably sends and dismisses.
        chip.addEventListener('pointerdown', (e) => {
          e.preventDefault();
          this.chatDraft = '';
          close();
          this.onChatSend?.(phrase);
        });
        chipsRow!.appendChild(chip);
      });
      this.overlay.appendChild(chipsRow);
    }

    // Mobile: lift the input (and chips) above the soft keyboard using the
    // VisualViewport API. Best-effort — if unavailable, the input just stays at
    // its default position, same as before.
    if (this.isTouch && window.visualViewport) {
      const vv = window.visualViewport;
      vvHandler = () => {
        const keyboardInset = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
        const lift = keyboardInset + 12;
        input.style.bottom = `calc(var(--sab, 0px) + ${lift}px)`;
        if (chipsRow) chipsRow.style.bottom = `calc(var(--sab, 0px) + ${lift + 46}px)`;
      };
      vv.addEventListener('resize', vvHandler);
      vv.addEventListener('scroll', vvHandler);
      window.setTimeout(vvHandler, 60); // after focus settles + keyboard animates in
    }

    // Restore a recently-preserved draft so an accidental blur didn't cost the
    // message. ~30s window: long enough to survive a fumbled keyboard dismissal,
    // short enough not to resurface a stale thought a minute later.
    if (this.chatDraft && performance.now() - this.chatDraftTime < 30000) {
      input.value = this.chatDraft;
    }
    this.chatInput = input;
    input.focus();
    const caret = input.value.length;
    if (caret) input.setSelectionRange(caret, caret);
  }

  /**
   * Make a styled HUD <div> behave like a real button for assistive tech and
   * keyboard users: announced with a label, focusable, and activated by Enter
   * or Space (which just re-fires the existing click handler, so click logic
   * stays in one place). `pressed`, when given, reflects a toggle's on/off
   * state via aria-pressed. Pairs with the `.hud-btn:focus-visible` ring in
   * style.css.
   */
  /** A chip's content (D13): an icon from the sprite, then its text. */
  private static chipContent(el: HTMLElement, name: IconName | null, text = ''): void {
    const kids: Node[] = [];
    if (name) kids.push(iconNode(name, 18));
    if (text) {
      const s = document.createElement('span');
      s.className = 'ds-chip-label';
      s.textContent = text;
      kids.push(s);
    }
    el.replaceChildren(...kids);
  }

  /** Swap a chip's icon, keeping its text. */
  private static chipIcon(el: HTMLElement, name: IconName): void {
    const old = [...el.children].find((c) => c.classList.contains('ds-ic'));
    const next = iconNode(name, 18);
    if (old) old.replaceWith(next);
    else el.prepend(next);
  }

  /** Set a chip's text, keeping its icon. */
  private static chipText(el: HTMLElement, text: string): void {
    let s = [...el.children].find((c) => c.classList.contains('ds-chip-label'));
    if (!s) {
      s = document.createElement('span');
      s.className = 'ds-chip-label';
      el.appendChild(s);
    }
    if (s.textContent !== text) s.textContent = text;
  }

  /**
   * A frozen label in a drawer row ('💼 Work with me', '📖 Portfolio'): its
   * emoji goes in the row's 24 px icon slot and its words line up with every
   * other label. The text is unchanged: the whitespace node between the two
   * spans keeps textContent as ruled, and a flex row lays it out as nothing.
   */
  private static slotLeadingEmoji(el: HTMLElement): void {
    if (el.querySelector('.ds-ic, .ds-ic-slot')) return;
    const t = el.textContent ?? '';
    const m = /^(\p{Extended_Pictographic}\uFE0F?)(\s+)(.+)$/u.exec(t);
    if (!m) return;
    const slot = document.createElement('span');
    slot.className = 'ds-ic-slot';
    slot.setAttribute('aria-hidden', 'true');
    slot.textContent = m[1];
    const label = document.createElement('span');
    label.className = 'ds-chip-label';
    label.textContent = m[3];
    el.replaceChildren(slot, document.createTextNode(m[2]), label);
  }

  /** Mute's icon: silent whenever the game is effectively silent. */
  private setMuteIcon(silent: boolean): void {
    if (this.muteBtn) SimpleUI.chipIcon(this.muteBtn, silent ? 'volume-x' : 'volume');
  }

  private makeHudButtonAccessible(el: HTMLElement, label: string, pressed?: boolean): void {
    el.setAttribute('role', 'button');
    el.setAttribute('tabindex', '0');
    el.setAttribute('aria-label', label);
    // Surface the same copy to SIGHTED mouse users. The HUD was aria-labeled
    // but visually mute: touch gets labelled drawer pills, screen readers get
    // aria, and desktop — the recruiter surface — got bare emoji (🎒 😀 🏝 0%).
    // The guard keeps the two chips that set richer titles before calling this.
    if (!el.title) el.title = label;
    el.classList.add('hud-btn');
    // The 44px tap pad is a ::after anchored to .hud-btn's own box — which
    // requires the chip to BE a containing block. tierChip/chipHost write
    // inline position:'static' (beating the stylesheet's .hud-btn
    // position:relative), which re-anchored every drawer chip's pad to the
    // whole drawer LIST and scrambled hit-testing across it. Enforce a
    // positioned box here, preserving inline absolute where a chip set one.
    if (getComputedStyle(el).position === 'static') el.style.position = 'relative';
    if (pressed !== undefined) el.setAttribute('aria-pressed', String(pressed));
    el.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        // The key is spent on THIS control. Without the stop, the same Enter
        // bubbled on to the window-level chat hotkey (main-simple), which
        // popped the multiplayer name prompt over whatever the chip opened,
        // and Space reached the document-level movement handler as a jump.
        e.stopPropagation();
        el.click();
      }
    });
    // The stop also means a chip that KEEPS focus owns every later Enter and
    // Space. A mouse click focuses a tabindex=0 chip, so after clicking the
    // Portfolio chip and closing the menu, Enter re-opened the menu instead
    // of chat. A pointer click (detail = click count, >= 1) hands focus back;
    // the keyboard path's el.click() above has detail 0 and keeps it.
    el.addEventListener('click', (e: MouseEvent) => {
      if (e.detail > 0) el.blur();
    });
  }

  // ── Island Journal ────────────────────────────────────────────────────────
  // (JournalData is declared at module scope below the class.)
  // One overlay unifying every collection into n-of-m meters (the Zeigarnik
  // pull the engagement research prescribed: visible incomplete sets bring
  // visitors back). Data comes from a provider closure set by main-simple —
  // the UI owns zero game state.
  private journalProvider: (() => JournalData) | null = null;
  setJournalProvider(fn: () => JournalData): void {
    this.journalProvider = fn;
  }

  showJournal(): void {
    // The Journal is the "every way to earn" home, buried two layers deep —
    // and until now UNMEASURED (completion/inventory/portfolio all track,
    // this didn't), so there was no way to see that nobody finds it.
    trackOnce('journal_opened');
    const data = this.journalProvider?.();
    if (!data) return;
    const modal = this.buildCenteredModal('min(430px, calc(100vw - 32px))', 'journal');
    const meter = (label: string, n: number, m: number): string => {
      const pct = m > 0 ? Math.round((n / m) * 100) : 0;
      return `<div style="margin:10px 0 2px;display:flex;justify-content:space-between;font-size:13px;">
          <span style="color:#ccd;">${label}</span><span style="color:#8a9bff;font-weight:600;">${n} / ${m}</span></div>
        <div style="height:7px;border-radius:5px;background:rgba(255,255,255,0.1);overflow:hidden;">
          <div style="width:${pct}%;height:100%;border-radius:5px;background:linear-gradient(90deg,#5b6cff,#8a4de0);"></div></div>`;
    };
    const stampRow = data.stamps
      .map(
        (s) =>
          `<span title="${s.label}" style="font-size:20px;${s.has ? '' : 'filter:grayscale(1);opacity:0.35;'}">${s.icon}</span>`,
      )
      .join(' ');
    const hatRow = data.hats
      .map(
        (h) =>
          `<span title="${h.name}" style="font-size:20px;${h.owned ? '' : 'filter:grayscale(1);opacity:0.35;'}">${h.icon}</span>`,
      )
      .join(' ');
    const raceRows = data.races
      .map(
        (r) =>
          `<div style="display:flex;justify-content:space-between;font-size:13px;margin:4px 0;">
            <span style="color:#ccd;">${r.label}</span>
            <span style="color:${r.best != null ? '#4ade80' : '#667'};font-weight:600;">${
              r.best != null ? r.best.toFixed(1) + 's' : 'not yet run'
            }</span></div>`,
      )
      .join('');
    modal.insertAdjacentHTML(
      'beforeend',
      `<h2 style="margin:0 0 2px;color:#8a9bff;">📔 Island Journal</h2>
       <p style="margin:0 0 10px;font-size:13px;color:#aab;">Everything you've found so far — and what's still out there.</p>
       ${meter('🛂 Zone stamps', data.stamps.filter((s) => s.has).length, data.stamps.length)}
       <div style="margin:6px 0 2px;">${stampRow}</div>
       ${meter('🎩 Hats collected', data.hats.filter((h) => h.owned).length, data.hats.length)}
       <div style="margin:6px 0 2px;letter-spacing:2px;">${hatRow}</div>
       ${meter('📬 Deliveries', data.deliveries.done, data.deliveries.total)}
       ${
         data.secrets
           ? `${meter('🗝️ Island secrets', data.secrets.found, data.secrets.total)}
              ${
                data.secrets.rumors.length
                  ? `<div style="margin:6px 0 0;font-size:12px;color:#9aa;font-style:italic;line-height:1.5;">
                       ${data.secrets.rumors.map((r) => `“${r}”`).join('<br>')}</div>`
                  : `<div style="margin:6px 0 0;font-size:12px;color:#4ade80;">Every secret found — true islander.</div>`
              }`
           : ''
       }
       ${
         data.loops
           ? `<div style="margin:14px 0 4px;font-size:13px;color:#ccd;font-weight:600;">💰 Earning &amp; building</div>
              ${data.loops
                .map(
                  (l) =>
                    `<div style="display:flex;gap:8px;margin:5px 0;font-size:13px;line-height:1.45;">
                       <span style="font-size:15px;">${l.icon}</span>
                       <span><strong style="color:#dfe6ff;">${l.title}</strong> — <span style="color:#9ab;">${l.detail}</span></span></div>`,
                )
                .join('')}
              <button id="journal-map" style="display:block;width:100%;margin:8px 0 2px;padding:9px;background:#26263340;color:#cfe0ff;
                border:1px solid rgba(120,160,255,0.35);border-radius:10px;font-size:13px;cursor:pointer;">🗺️ Open the island map (M)</button>`
           : ''
       }
       <div style="margin:14px 0 4px;font-size:13px;color:#ccd;font-weight:600;">🏁 Race bests</div>
       ${raceRows}
       <div style="display:flex;justify-content:space-between;margin-top:14px;padding-top:10px;border-top:1px solid rgba(255,255,255,0.12);font-size:13px;">
         <span style="color:#ccd;">🪙 Coins collected</span><span style="color:#ffd54a;font-weight:700;">${data.coins}</span></div>
       ${
         data.visits
           ? `<div style="display:flex;justify-content:space-between;margin-top:6px;font-size:13px;">
                <span style="color:#ccd;">📅 Days visited</span>
                <span style="color:#8a9bff;font-weight:600;">${data.visits.days}${data.visits.streak > 1 ? ` · ${data.visits.streak}-day streak` : ''}</span></div>`
           : ''
       }`,
    );
    modal.querySelector('#journal-map')?.addEventListener('click', () => {
      modal.remove();
      this.panels.notifyClosed('journal');
      this.onOpenMap?.();
    });
    this.overlay.appendChild(modal);
  }

  // ── Inventory ("Your Pack") ───────────────────────────────────────────────
  // The Journal answers "what have I found"; the Shop answers "what can I
  // buy". Neither answered "what am I carrying" — and five of the raw
  // resources (fish, timber, wheat, produce, ore) had NO on-screen home at
  // all: the feed chip shows only feed/meals, and timber appeared solely in
  // the build chooser while standing at a stake. Same provider convention as
  // the journal: the UI owns zero game state.
  private inventoryProvider: (() => InventoryData) | null = null;
  setInventoryProvider(fn: () => InventoryData): void {
    this.inventoryProvider = fn;
  }

  /** True while the pack is on screen — main-simple uses this to re-render it
   *  on change (the game does NOT pause behind a modal). */
  isInventoryOpen(): boolean {
    return this.panels.isOpen('inventory');
  }

  /** Escape before interpolating into any HTML template. Every string in the
   *  pack is game-authored today (catalogue names, fixed hints), but a panel
   *  that renders "what the player holds" is exactly the kind of surface a
   *  future feature bolts a player-named item onto — so escape at the sink. */
  private static esc(s: string): string {
    return s.replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
    );
  }

  private packDiv: HTMLElement | null = null;

  showInventory(): void {
    const data = this.inventoryProvider?.();
    if (!data) return;
    // Drop the previous element FIRST. Same-id re-open replaces the panel
    // SPEC in place and deliberately never fires close() (the rule the shop
    // depends on), so the old DOM node would survive and the re-render would
    // stack a second modal on top of a stale one — measured: the stale copy
    // still read "4 fish" after the value moved to 9. Same guard showShop
    // uses via hideShop().
    this.packDiv?.remove();
    const modal = this.buildCenteredModal('min(420px, calc(100vw - 32px))', 'inventory');
    this.packDiv = modal;

    const E = SimpleUI.esc;
    const row = (r: InventoryRow, dim: boolean): string =>
      `<div style="display:flex;align-items:center;gap:10px;margin:7px 0;min-height:40px;
         ${dim ? 'opacity:0.42;' : ''}">
         <span style="font-size:20px;width:24px;text-align:center;">${E(r.icon)}</span>
         <span style="flex:1;text-align:left;font-size:13px;">
           <strong style="color:#dfe6ff;">${E(r.label)}</strong>
           <span style="display:block;color:#9ab;font-size:12px;line-height:1.35;">${E(r.hint)}</span>
         </span>
         <span style="color:${r.count > 0 ? '#8a9bff' : '#667'};font-weight:700;font-size:15px;
           min-width:2.2em;text-align:right;">${r.count}</span>
       </div>`;

    const section = (title: string, rows: InventoryRow[]): string => {
      if (!rows.length) return '';
      // Held first, empties after — the pack should lead with what you have,
      // but still show the empties so the loops stay discoverable.
      const sorted = [...rows].sort((a, b) => (b.count > 0 ? 1 : 0) - (a.count > 0 ? 1 : 0));
      return `<div style="margin:14px 0 2px;font-size:13px;color:#ccd;font-weight:600;">${title}</div>
              ${sorted.map((r) => row(r, r.count === 0)).join('')}`;
    };

    const toolStrip = data.tools
      .map(
        (t) =>
          `<span title="${SimpleUI.esc(t.name)}" style="font-size:20px;${t.owned ? '' : 'filter:grayscale(1);opacity:0.35;'}">${SimpleUI.esc(t.icon)}</span>`,
      )
      .join(' ');

    const held = data.goods.reduce((n, r) => n + r.count, 0);

    modal.insertAdjacentHTML(
      'beforeend',
      `<h2 style="margin:0 0 2px;color:#8a9bff;">🎒 Your Pack</h2>
       <p style="margin:0 0 8px;font-size:13px;color:#aab;">Everything you're carrying right now.</p>
       <div style="display:flex;justify-content:center;gap:8px;margin:0 0 4px;">
         <span style="background:#3a341acc;border:1px solid #b39b3a;border-radius:999px;
           padding:4px 12px;font-size:13px;color:#ffd54a;font-weight:700;">🪙 ${data.coins}</span>
         ${
           held > 0
             ? `<span style="background:#3a2f1acc;border:1px solid #8a6238;border-radius:999px;
                  padding:4px 12px;font-size:13px;color:#e8d5a8;font-weight:600;">📦 ${held} to sell</span>`
             : ''
         }
       </div>
       <div style="max-height:52vh;overflow:auto;text-align:left;">
         ${
           data.carrying
             ? `<div style="margin:12px 0 2px;font-size:13px;color:#ccd;font-weight:600;">🤲 In hand</div>
                <div style="display:flex;align-items:center;gap:10px;margin:7px 0;min-height:40px;
                  background:rgba(90,130,255,0.10);border:1px solid rgba(120,160,255,0.3);
                  border-radius:10px;padding:6px 10px;">
                  <span style="font-size:20px;">${E(data.carrying.icon)}</span>
                  <span style="flex:1;font-size:13px;"><strong style="color:#dfe6ff;">${E(data.carrying.label)}</strong>
                    <span style="display:block;color:#9ab;font-size:12px;">${E(data.carrying.hint)}</span></span>
                </div>`
             : ''
         }
         ${section('📦 Goods to sell', data.goods)}
         ${section('🧺 Supplies', data.supplies)}
         <div style="margin:14px 0 4px;font-size:13px;color:#ccd;font-weight:600;">🧰 Tools</div>
         <div style="letter-spacing:3px;margin:2px 0 4px;">${toolStrip}</div>
         <div style="display:flex;justify-content:space-between;margin-top:12px;padding-top:10px;
           border-top:1px solid rgba(255,255,255,0.12);font-size:13px;">
           <span style="color:#ccd;">🎩 Hats</span>
           <span style="color:#8a9bff;font-weight:600;">${
             data.hats.equipped ? `${E(data.hats.equipped)} equipped · ` : ''
           }${data.hats.owned} of ${data.hats.total}</span></div>
       </div>
       <button id="pack-shop" style="display:block;width:100%;margin:12px 0 0;padding:10px;
         background:#26263340;color:#cfe0ff;border:1px solid rgba(120,160,255,0.35);
         border-radius:10px;font-size:13px;cursor:pointer;min-height:40px;">🛒 Open the Island Shop</button>`,
    );
    modal.querySelector('#pack-shop')?.addEventListener('click', () => {
      modal.remove();
      this.packDiv = null;
      this.panels.notifyClosed('inventory');
      this.onOpenShop?.();
    });
    this.overlay.appendChild(modal);
    trackOnce('inventory_opened');
  }

  private onOpenShop: (() => void) | null = null;
  /** App hook: the pack's shop button routes here. */
  setOnOpenShop(fn: () => void): void {
    this.onOpenShop = fn;
  }

  private onOpenMap: (() => void) | null = null;

  /** App hook: the journal's map button routes here (openIslandMap). */
  public setOnOpenMap(cb: () => void): void {
    this.onOpenMap = cb;
  }

  private buildCount = 0;

  /** Total visitor-built structures (Times count strip). Integers only. */
  public setBuildCount(n: number): void {
    this.buildCount = Math.max(0, Math.floor(n));
  }

  /** Build chooser at a free stake — the labeled cost button IS the confirm. */
  public showBuildChooser(
    rows: Array<{
      icon: string;
      name: string;
      timber: number;
      coins: number;
      affordable: boolean;
      shortfall: string;
      kind: number;
    }>,
    wallet: { timber: number; coins: number; built: number; cap: number },
    onPick: (kind: number) => void,
  ): void {
    const modal = this.buildCenteredModal('min(420px, calc(100vw - 32px))', 'build-chooser', {
      label: 'Raise a structure',
    });
    modal.style.textAlign = 'left';
    modal.insertAdjacentHTML(
      'beforeend',
      `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
         <div style="font-size:17px;font-weight:700;">🔨 Raise a structure</div>
         <div style="display:flex;gap:8px;align-items:center;">
           <span style="background:#3a2f1acc;border:1px solid #8a6238;border-radius:999px;padding:3px 10px;font-size:13px;">🪵 ${wallet.timber}</span>
           <span style="background:#3a341acc;border:1px solid #b39b3a;border-radius:999px;padding:3px 10px;font-size:13px;">🪙 ${wallet.coins}</span>
         </div>
       </div>
       <div id="chooser-rows">
       ${rows
         .map(
           (r) => `
         <div style="display:flex;align-items:center;gap:11px;min-height:44px;padding:7px 4px;border-bottom:1px solid rgba(255,255,255,0.07);${r.affordable ? '' : 'opacity:0.62;'}">
           <span style="font-size:20px;">${r.icon}</span>
           <span style="flex:1;">
             <strong style="text-transform:capitalize;">${r.name}</strong>
             <span style="display:block;font-size:12px;color:${r.affordable ? '#9ab' : '#e0a0a0'};">
               ${r.affordable ? `${r.timber} 🪵 + ${r.coins} 🪙` : r.shortfall}
             </span>
           </span>
           ${
             r.affordable
               ? `<button data-build-kind="${r.kind}" style="background:#2f6b3a;color:#eaffea;border:1px solid #4a9a58;border-radius:10px;padding:8px 13px;font-size:13px;cursor:pointer;">Build · ${r.timber}🪵+${r.coins}🪙</button>`
               : `<span style="font-size:12px;color:#778;">${r.timber}🪵+${r.coins}🪙</span>`
           }
         </div>`,
         )
         .join('')}
       </div>
       <div style="margin-top:10px;font-size:12px;color:#89a;">Your builds: ${wallet.built}/${wallet.cap} · Everyone sees what you build.</div>`,
    );
    modal.querySelectorAll('button[data-build-kind]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const kind = Number((btn as HTMLElement).dataset.buildKind);
        modal.remove();
        this.panels.notifyClosed('build-chooser');
        onPick(kind);
      });
    });
    this.overlay.appendChild(modal);
  }

  /** Options on the player's OWN build: reclaim timber, or replace. */
  public showBuildOptions(
    build: { icon: string; name: string; timber: number },
    onAction: (action: 'reclaim' | 'replace') => void,
  ): void {
    const modal = this.buildCenteredModal('min(340px, calc(100vw - 32px))', 'build-options', {
      label: `Your ${build.name}`,
    });
    modal.insertAdjacentHTML(
      'beforeend',
      `<div style="font-size:17px;font-weight:700;margin-bottom:4px;">${build.icon} Your ${build.name}</div>
       <div style="font-size:13px;color:#9ab;margin-bottom:14px;">Reclaim returns the timber — the carpenter keeps the coins as his labour fee.</div>
       <button id="build-reclaim" style="display:block;width:100%;margin:6px 0;padding:11px;background:#3a2f1a;color:#ffe9c9;border:1px solid #8a6238;border-radius:10px;font-size:14px;cursor:pointer;">🪵 Reclaim timber (+${build.timber} 🪵)</button>
       <button id="build-replace" style="display:block;width:100%;margin:6px 0;padding:11px;background:#26263a;color:#cfe0ff;border:1px solid rgba(120,160,255,0.35);border-radius:10px;font-size:14px;cursor:pointer;">🔨 Replace with something else…</button>
       <button id="build-cancel" style="display:block;width:100%;margin:6px 0;padding:9px;background:none;color:#889;border:none;font-size:13px;cursor:pointer;">Leave it standing</button>`,
    );
    const close = () => {
      modal.remove();
      this.panels.notifyClosed('build-options');
    };
    modal.querySelector('#build-reclaim')?.addEventListener('click', () => {
      close();
      onAction('reclaim');
    });
    modal.querySelector('#build-replace')?.addEventListener('click', () => {
      close();
      onAction('replace');
    });
    modal.querySelector('#build-cancel')?.addEventListener('click', close);
    this.overlay.appendChild(modal);
  }

  private createMuteButton(): void {
    this.muteBtn = document.createElement('div');
    let muted = false;
    let volume = 0.7; // matches AudioManager's DEFAULT_VOLUME
    try {
      const s = JSON.parse(localStorage.getItem('ds_audio_settings') ?? '{}');
      muted = !!s.muted;
      if (s.v === 2 && typeof s.volume === 'number') volume = s.volume;
    } catch {
      /* defaults */
    }
    this.hudMuted = muted;
    this.hudVolume = volume;
    // 🔇 whenever the game is EFFECTIVELY silent — muted OR volume 0. The
    // slider path already hinted 🔇 at zero, but a reload with a persisted
    // volume of 0 booted showing 🔊 over a silent game.
    this.setMuteIcon(muted || volume === 0);
    Object.assign(this.muteBtn.style, {
      ...CHIP_ICON,
      top: 'calc(var(--sat, 0px) + 88px)',
      right: 'calc(var(--sar, 0px) + 10px)', // icon row slot 1 (38px pitch)
    });
    this.muteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!this.onMuteToggle || !this.muteBtn) return;
      const nowMuted = this.onMuteToggle();
      this.hudMuted = nowMuted;
      // Volume 0 keeps the 🔇 even when unmuted — unmuting a zero-volume game
      // produces no sound, and an icon that claims otherwise is the same
      // lying-control class Ctrl+B just got fixed for.
      this.setMuteIcon(nowMuted || this.hudVolume === 0);
      this.muteBtn.setAttribute('aria-pressed', String(nowMuted));
      // Tapping the button also surfaces the volume pill for a few seconds —
      // the only mobile path to the slider (no hover on touch).
      this.showVolumePill(3500);
    });
    // "game sound", not "all sound": the live reception call deliberately
    // plays outside the master bus (you don't mute a phone call you started
    // with the music knob — see ReceptionDesk's header), so a label claiming
    // "all" was untrue for exactly that surface.
    this.makeHudButtonAccessible(
      this.muteBtn,
      'Toggle game sound (music, effects, voices — live calls excluded)',
      muted,
    );
    this.chipHost(this.muteBtn, { drawer: true, label: 'Sound', order: 9 });
    this.createVolumePill(volume);
    this.createReducedMotionButton();
    this.createCustomizeButton();
  }

  /**
   * Master-volume slider in a popover pill beside the 🔊 button. The icon row
   * is fully packed (♿ at +48, 🎨 at +86, 😀/📸/🎒 beyond, the wide Portfolio
   * pill below at +126), so a permanently-visible slider has nowhere to live
   * at 320px-wide viewports — instead the pill OVERLAYS the ♿/🎨 slots
   * temporarily (opaque, higher z) while hovered/tapped, and vanishes after.
   */
  private volumePill: HTMLDivElement | null = null;
  private hudMuted = false;
  /** Mirrors the slider so the mute icon can reflect EFFECTIVE silence
   *  (muted OR volume 0) from every update path, not just the slider's. */
  private hudVolume = 0.7;
  private volumePillHideTimer: number | undefined;

  private createVolumePill(initialVolume: number): void {
    const pill = document.createElement('div');
    Object.assign(pill.style, {
      position: 'absolute',
      top: 'calc(var(--sat, 0px) + 88px)',
      // Desktop (D13): left of the whole icon row (its six 30 px chips end at
      // +230), so it covers none of its neighbours. Touch keeps the ♿ slot's
      // edge: there the icons live in the drawer, closed by then.
      right: this.isTouch ? 'calc(var(--sar, 0px) + 48px)' : 'calc(var(--sar, 0px) + 238px)',
      background: 'rgba(0, 0, 0, 0.85)',
      padding: '8px 12px',
      borderRadius: '10px',
      display: 'none',
      alignItems: 'center',
      pointerEvents: 'auto',
      zIndex: '10', // floats over the ♿/🎨 buttons while visible
      boxShadow: '0 3px 10px rgba(0,0,0,0.3)',
    });
    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = '0';
    slider.max = '100';
    slider.step = '5';
    slider.value = String(Math.round(initialVolume * 100));
    slider.setAttribute('aria-label', 'Master volume');
    Object.assign(slider.style, {
      width: '96px',
      height: '18px',
      accentColor: '#5b6cff',
      cursor: 'pointer',
      margin: '0',
    });
    slider.addEventListener('input', () => {
      const v = Math.max(0, Math.min(100, Number(slider.value))) / 100;
      this.hudVolume = v;
      this.onVolumeChange?.(v);
      // Raising the volume while muted unmutes (the expected convention);
      // dragging to 0 hints 🔇 without flipping the stored muted flag.
      if (v > 0 && this.hudMuted && this.onMuteToggle) {
        this.hudMuted = this.onMuteToggle();
      }
      if (this.muteBtn) {
        this.setMuteIcon(this.hudMuted || v === 0);
        this.muteBtn.setAttribute('aria-pressed', String(this.hudMuted));
      }
      this.showVolumePill(3500); // keep it up while adjusting
    });
    pill.appendChild(slider);
    this.overlay.appendChild(pill);
    // NOT registered as a nav-chips layer member: registerLayer snapshots
    // baseDisplay at registration — 'none' for this popover — so the very
    // panel transition that SURFACES it on touch (the drawer's selection
    // auto-collapse right after tapping Sound) re-applied 'none' and the
    // slider vanished before a finger could reach it. It manages its own
    // visibility (showVolumePill/hideVolumePill timers).
    this.volumePill = pill;

    // Desktop: hover/focus over button or pill keeps it open.
    const open = () => this.showVolumePill(900);
    this.muteBtn?.addEventListener('mouseenter', open);
    this.muteBtn?.addEventListener('focus', open);
    pill.addEventListener('mouseenter', () => this.showVolumePill(900));
    pill.addEventListener('mouseleave', () => this.showVolumePill(600));
    slider.addEventListener('focus', () => this.showVolumePill(4000));
    slider.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.hideVolumePill();
      // The value keys belong to the slider: ← used to turn the volume down
      // AND walk the avatar 4.4 u (PANEL-01).
      if (/^(Arrow(Up|Down|Left|Right)|Home|End|PageUp|PageDown)$/.test(e.key)) {
        e.stopPropagation();
        this.showVolumePill(4000);
      }
    });
  }

  /** Show the pill and (re)arm its auto-hide. */
  private showVolumePill(hideAfterMs: number): void {
    if (!this.volumePill) return;
    this.volumePill.style.display = 'flex';
    if (this.volumePillHideTimer) clearTimeout(this.volumePillHideTimer);
    this.volumePillHideTimer = window.setTimeout(() => this.hideVolumePill(), hideAfterMs);
  }

  private hideVolumePill(): void {
    if (this.volumePillHideTimer) clearTimeout(this.volumePillHideTimer);
    this.volumePillHideTimer = undefined;
    if (this.volumePill) this.volumePill.style.display = 'none';
  }

  private onVolumeChange: ((v: number) => void) | null = null;
  /** Wire the master-volume slider (0..1). */
  setOnVolumeChange(cb: (v: number) => void): void {
    this.onVolumeChange = cb;
  }

  private onCustomizeToggle: (() => void) | null = null;
  setOnCustomizeToggle(cb: () => void): void {
    this.onCustomizeToggle = cb;
  }

  /** 🎨 button (also bound to the C key): opens the appearance editor. */
  private createCustomizeButton(): void {
    const btn = document.createElement('div');
    SimpleUI.chipContent(btn, 'palette');
    btn.title = 'Customize appearance (C)';
    Object.assign(btn.style, {
      ...CHIP_ICON,
      // Icon row (see createMuteButton): 🔊 ♿ 🎨 😀 📸 🎒 sit side by side at
      // a 38px pitch so the wide "📖 Portfolio" pill below has a clear row of
      // its own. They used to stack vertically and the pill covered them.
      top: 'calc(var(--sat, 0px) + 88px)',
      right: 'calc(var(--sar, 0px) + 86px)', // icon row slot 3
    });
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.onCustomizeToggle?.();
    });
    this.makeHudButtonAccessible(btn, 'Customize appearance');
    this.chipHost(btn, { drawer: true, label: 'Customize', order: 7 });
  }

  /** ♿ toggle: dampens the fly-in, camera swoop, and pulsing gates. */
  private createReducedMotionButton(): void {
    const btn = document.createElement('div');
    SimpleUI.chipContent(btn, 'motion-off');
    btn.title = 'Reduced motion — dampens the fly-in, camera swoop, and pulsing effects';
    Object.assign(btn.style, {
      ...CHIP_ICON,
      top: 'calc(var(--sat, 0px) + 88px)',
      right: 'calc(var(--sar, 0px) + 48px)', // icon row slot 2 (38px pitch)
      transition: 'background 0.15s ease, border-color 0.15s ease',
    });
    const render = () => {
      // Active = the HUD's indigo accent, not green — green is reserved for
      // the Work-with-me conversion pill, and a second green chip in the
      // same column made them read as siblings.
      btn.style.background = a11y.reducedMotion
        ? 'rgba(91, 108, 255, 0.35)'
        : (CHIP.background as string);
      btn.style.borderColor = a11y.reducedMotion
        ? 'rgba(91, 108, 255, 0.85)'
        : 'rgba(255,255,255,0.18)';
      btn.setAttribute('aria-pressed', String(a11y.reducedMotion));
    };
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      a11y.setReducedMotion(!a11y.reducedMotion);
      render();
    });
    this.makeHudButtonAccessible(btn, 'Toggle reduced motion', a11y.reducedMotion);
    render();
    this.chipHost(btn, { drawer: true, label: 'Reduce motion', order: 10 });
  }

  private portfolioMenuDiv: HTMLElement | null = null;

  // "Meet the AI townsfolk" welcome CTA → the app guides the visitor to the
  // nearest chatty persona (compass override until they talk to one).
  private onMeetAi: (() => void) | null = null;
  public setOnMeetAi(cb: () => void): void {
    this.onMeetAi = cb;
  }

  // Welcome/leaderboard CTAs the app fulfils: start the cinematic tour, or
  // compass-guide to the race start line (analyst issue #6 — the race was
  // undiscoverable until you accidentally drove through a gate).
  private onTour: (() => void) | null = null;
  public setOnTour(cb: () => void): void {
    this.onTour = cb;
  }
  private onRecruitTour: (() => void) | null = null;
  public setOnRecruitTour(cb: () => void): void {
    this.onRecruitTour = cb;
  }
  private onRaceGuide: (() => void) | null = null;
  public setOnRaceGuide(cb: () => void): void {
    this.onRaceGuide = cb;
  }

  // Fired whenever a completion-meter item flips done inside the UI layer
  // (guestbook signed, Times read, hi said) so the app can recompute the pill.
  private onProgressMade: (() => void) | null = null;
  public setOnProgressMade(cb: () => void): void {
    this.onProgressMade = cb;
  }

  // ── "Island Times" notice board ────────────────────────────────────────
  // The pre-authored notice lines. This list MUST stay in the same order as
  // functions/src/analyst.ts NOTICE_TEMPLATES — the server writes only the
  // integer index of a line, never its text, so a mismatch would show the
  // wrong (but still safe, pre-authored) sentence. A parity vitest guards it.
  private static readonly NOTICE_TEMPLATES: readonly string[] = [
    'A steady day on the island.', // 0
    'New faces arrived from across the sea.', // 1
    'The racing circuits saw fresh records.', // 2
    'The guestbook gained some kind words.', // 3
    'The market and plazas were busy today.', // 4
    'A quiet, restful day in the districts.', // 5
    'The couriers had a full postbag.', // 6
    'Word of the island is spreading.', // 7
  ];
  // persona id → display name, inverted from AI_NPCS (display name → id).
  private static readonly ID_TO_NAME: Record<string, string> = Object.fromEntries(
    Object.entries(AI_NPCS).map(([name, id]) => [id, name]),
  );
  private latestNotice: NoticeState | null = null;
  private latestPlan: NpcPlan | null = null;
  private latestArchive: Array<{ day: string; lines: number[]; visitors?: number }> | null = null;

  /**
   * Persistent "Portfolio" button (top-right): opens a menu so a visitor can
   * jump straight to any section — About / Projects / Contact etc. — without
   * having to navigate the 3D world. The world stays for those who explore.
   */
  private createPortfolioButton(): void {
    const btn = document.createElement('div');
    btn.textContent = '📖 Portfolio';
    Object.assign(btn.style, {
      position: 'absolute',
      // Own row, clear of the 🎨 ♿ 🔊 icon row above (which sits at +88).
      // This pill is wide and was overlapping them at +118.
      top: 'calc(var(--sat, 0px) + 126px)',
      right: 'calc(var(--sar, 0px) + 10px)',
      // The indigo primary, darkened for AA: white text 5.41-5.75:1, where
      // #5b6cff gave 4.17 (DA-01).
      background: DS.primary,
      color: 'white',
      padding: '7px 12px',
      borderRadius: '999px', // pill like every other chip in the column
      fontSize: '13px',
      fontWeight: '700',
      cursor: 'pointer',
      pointerEvents: 'auto',
      userSelect: 'none',
      boxShadow: '0 3px 10px rgba(0,0,0,0.3)',
    });
    btn.classList.add('ds-press'); // hover/press darken, never brighten below AA
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.togglePortfolioMenu();
    });
    this.makeHudButtonAccessible(btn, 'Open portfolio menu');
    // First steps' anchor (A6): the pill on desktop, its drawer row on touch.
    btn.dataset.guide = this.isTouch ? 'drawer-portfolio' : 'portfolio-chip';
    this.portfolioBtnEl = btn;
    // Drawer row 3: Work with me keeps #1 and the Hiring row takes #2 (D5).
    this.chipHost(btn, { drawer: true, order: 3 });
  }

  /** The Portfolio pill: where a keyboard user's focus lands when the panel
   *  they opened from the menu closes (PanelManager fallbackFocus). */
  private portfolioBtnEl: HTMLElement | null = null;

  /**
   * Persistent "Work with me" pill (top-center). A portfolio's whole job is to
   * convert, but the only always-visible path to contact was buried in the
   * Portfolio menu. This routes straight to the Contact zone from anywhere.
   */
  private createContactCTA(): void {
    const btn = document.createElement('div');
    btn.textContent = '💼 Work with me';
    // The one element that is this pill, on the HUD and re-hosted in the phone
    // drawer: icon sweeps and DOM censuses exempt it by this hook, and
    // test/uiLocks.test.ts pins the ruling it carries.
    btn.dataset.cta = 'work-with-me';
    Object.assign(btn.style, {
      position: 'absolute',
      // Stacked just below the 📖 Portfolio pill (top-right conversion column),
      // clear of the top-center quest/delivery tracker.
      top: 'calc(var(--sat, 0px) + 164px)',
      right: 'calc(var(--sar, 0px) + 10px)',
      // Green, reserved for this pill, darkened for AA: white text 5.39-6.15:1
      // (it was 2.97). Same hue family, so the ruling's pin still holds.
      background: DS.ctaWork,
      color: 'white',
      padding: '7px 14px',
      borderRadius: '999px',
      fontSize: '13px',
      fontWeight: '700',
      cursor: 'pointer',
      pointerEvents: 'auto',
      userSelect: 'none',
      boxShadow: '0 3px 10px rgba(0,0,0,0.3)',
      zIndex: '1200',
    });
    btn.classList.add('ds-press');
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      track('cta_pill_click');
      this.showZonePanel({ id: 'contact', name: 'contact' }, { source: 'cta' });
    });
    this.makeHudButtonAccessible(btn, 'Work with me — open contact');
    // Drawer slot #1 (Abbas's ruling): the business CTA leads the fan-out,
    // with the ☰ pulse dot covering discoverability. Watch contact/portfolio
    // analytics for a week; promoting it back to tier 1 is a 3-line revert.
    this.chipHost(btn, { drawer: true, order: 1 });
  }

  /**
   * The recruiter path in one click (D5, UX-07): a 'Hiring? CV & contact'
   * text chip at +278 on desktop, below the completion pill, and drawer row
   * #2 on a phone. It opens the hire card, where the Work-with-me pill (left
   * exactly as ruled: its slot, label, green and cta_pill_click) opens
   * Contact, which lacks the CV and the availability line. The glyph is a
   * page with lines until D13's icon sprite lands.
   */
  private createHiringChip(): void {
    const btn = document.createElement('div');
    // The sprite's file-text icon (D13), distinct from the CV's file-user.
    SimpleUI.chipContent(btn, 'file-text', 'Hiring? CV & contact');
    (btn.firstElementChild as SVGElement | null)?.style.setProperty('color', '#ffd479');
    btn.dataset.hiringChip = '1';
    Object.assign(btn.style, {
      ...CHIP,
      top: 'calc(var(--sat, 0px) + 278px)', // the row below the completion pill (38px pitch)
      right: 'calc(var(--sar, 0px) + 10px)',
    });
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      track('hire_chip_click');
      this.showHireCard('cta');
    });
    this.makeHudButtonAccessible(btn, 'Hiring? Open the CV and contact card');
    this.chipHost(btn, { drawer: true, order: 2 });
  }

  /** Photo mode entry — the game loop owns the actual capture (renderer flag). */
  private onPhotoRequest: (() => void) | null = null;
  public setOnPhotoRequest(fn: () => void): void {
    this.onPhotoRequest = fn;
  }

  /** 📸 icon in the utility row — demoted from its own full-width pill row
   *  (a camera is a utility, not a conversion CTA; the tall right-edge stack
   *  was the screenshotted clutter). The P shortcut lives in the tooltip. */
  private createPhotoButton(): void {
    const btn = document.createElement('div');
    SimpleUI.chipContent(btn, 'camera');
    btn.title = 'Take a photo (P)';
    Object.assign(btn.style, {
      ...CHIP_ICON,
      top: 'calc(var(--sat, 0px) + 88px)',
      right: 'calc(var(--sar, 0px) + 162px)', // icon row slot 5
    });
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.onPhotoRequest?.();
    });
    this.makeHudButtonAccessible(btn, 'Take a photo of the island (P)');
    this.chipHost(btn, { drawer: true, label: 'Photo', order: 6 });
  }

  // ── Tour mode overlay (caption bar + skip) ───────────────────────────────
  // The rail itself lives in main-simple; this is just the chrome: a caption
  // bar that crossfades per stop and a skip control (button or Esc).
  private tourCaptionDiv: HTMLElement | null = null;
  private tourSkipBtn: HTMLElement | null = null;
  private tourEscHandler: ((e: KeyboardEvent) => void) | null = null;
  private tourCaptionSwap: number | null = null;

  showTourOverlay(onSkip: () => void): void {
    this.hideTourOverlay();
    // The tour was the OTHER surface bypassing PanelManager: for its whole
    // ~90s the full touch suite stayed painted (dead — movement is zeroed —
    // but visible, and captions rendered across the button columns). A
    // scrimless sheet that clears every HUD layer: the island IS the show.
    this.panels.open('tour', {
      kind: 'sheet',
      hides: ['nav-chips', 'touch-controls', 'aux-controls', 'ambient-info'],
      close: () => onSkip(),
      ownEscape: true, // tour has its own Escape → skip handler below
      history: false, // transient: Back is not spent on it
    });
    const cap = document.createElement('div');
    cap.setAttribute('role', 'status'); // each stop's caption is read out (UX-05)
    Object.assign(cap.style, {
      position: 'absolute',
      left: '50%',
      bottom: 'calc(var(--sab, 0px) + 46px)',
      transform: 'translateX(-50%)',
      maxWidth: 'min(560px, calc(100vw - 40px))',
      background: 'rgba(6, 10, 20, 0.78)',
      color: '#fff',
      padding: '13px 22px',
      borderRadius: '14px',
      fontSize: '15px',
      lineHeight: '1.45',
      textAlign: 'center',
      fontFamily: 'system-ui, sans-serif',
      pointerEvents: 'none',
      zIndex: '1900',
      transition: 'opacity 0.3s',
      opacity: '0',
      boxShadow: '0 6px 24px rgba(0,0,0,0.4)',
    });
    this.overlay.appendChild(cap);
    this.tourCaptionDiv = cap;

    const skip = document.createElement('button');
    skip.textContent = this.isTouch ? '✕ Skip tour' : '✕ Skip tour (Esc)';
    Object.assign(skip.style, {
      position: 'absolute',
      top: 'calc(var(--sat, 0px) + 14px)',
      left: 'calc(var(--sal, 0px) + 14px)',
      background: 'rgba(6, 10, 20, 0.7)',
      color: '#dfe6f2',
      border: '1px solid rgba(255,255,255,0.25)',
      padding: '8px 14px',
      borderRadius: '999px',
      fontSize: '13px',
      fontWeight: '600',
      fontFamily: 'system-ui, sans-serif',
      cursor: 'pointer',
      pointerEvents: 'auto',
      zIndex: '1900',
    });
    const doSkip = () => onSkip();
    skip.addEventListener('click', (e) => {
      e.stopPropagation();
      doSkip();
    });
    this.overlay.appendChild(skip);
    this.tourSkipBtn = skip;
    // Skip sits in the Day badge's corner. The ambient-info layer hides the
    // badge on touch, but desktop only DIMS layers, which left it showing
    // through under Skip; hide it outright for the tour.
    if (this.envBadgeDiv) this.envBadgeDiv.style.visibility = 'hidden';

    this.tourEscHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') doSkip();
    };
    document.addEventListener('keydown', this.tourEscHandler);
  }

  setTourCaption(text: string): void {
    const cap = this.tourCaptionDiv;
    if (!cap) return;
    if (this.tourCaptionSwap !== null) window.clearTimeout(this.tourCaptionSwap);
    cap.style.opacity = '0';
    this.tourCaptionSwap = window.setTimeout(() => {
      cap.textContent = text;
      cap.style.opacity = '1';
      this.tourCaptionSwap = null;
    }, 300);
  }

  hideTourOverlay(): void {
    if (this.tourCaptionSwap !== null) {
      window.clearTimeout(this.tourCaptionSwap);
      this.tourCaptionSwap = null;
    }
    const hadOverlay = this.tourCaptionDiv !== null;
    this.tourCaptionDiv?.remove();
    this.tourCaptionDiv = null;
    this.tourSkipBtn?.remove();
    this.tourSkipBtn = null;
    if (this.envBadgeDiv) this.envBadgeDiv.style.visibility = '';
    if (this.tourEscHandler) {
      document.removeEventListener('keydown', this.tourEscHandler);
      this.tourEscHandler = null;
    }
    // Restore the HUD layers (no-op during a sweep). Guarded so the
    // defensive hideTourOverlay() at the top of showTourOverlay never pops
    // an unrelated panel.
    if (hadOverlay) this.panels.notifyClosed('tour');
  }

  /**
   * 👋 pill in the top-right conversion column (below 📸): the lowest-friction
   * way to leave a trace — a two-field note that lands in the public guestbook,
   * or goes straight to Abbas when the visitor adds an email for a reply.
   * (Analyst issue #5: zero guestbook entries → the friction was too high.)
   */
  private createSayHiButton(): void {
    const btn = document.createElement('div');
    SimpleUI.chipContent(btn, 'hand', 'Say hi');
    Object.assign(btn.style, {
      ...CHIP,
      top: 'calc(var(--sat, 0px) + 202px)', // row below Work-with-me (38px pitch)
      right: 'calc(var(--sar, 0px) + 10px)',
    });
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.showSayHi();
    });
    this.makeHudButtonAccessible(btn, 'Say hi — leave a quick note');
    this.chipHost(btn, { drawer: true, order: 4 });
  }

  showSayHi(): void {
    const modal = this.buildCenteredModal('min(360px, calc(100vw - 32px))', 'say-hi');
    const savedName = (() => {
      try {
        return localStorage.getItem('ds_player_name') || '';
      } catch {
        return '';
      }
    })();
    // 16px on touch: the textarea below AUTOFOCUSES, so an under-16px size
    // fires iOS's focus zoom the instant the panel opens (see chat inputs).
    const field =
      'width:100%;box-sizing:border-box;padding:9px 12px;border-radius:10px;border:none;' +
      `font-size:${this.isTouch ? '16px' : '14px'};background:rgba(255,255,255,0.1);color:#fff;` +
      'outline:1px solid rgba(120,170,255,0.4);margin:0 0 8px;font-family:inherit;';
    modal.insertAdjacentHTML(
      'beforeend',
      `<h2 style="margin:0 0 4px;color:#8a9bff;">👋 Say hi</h2>
       <p style="margin:0 0 12px;font-size:13px;color:#aab;">Leave a note on the island — takes five seconds.</p>
       <input id="sh-name" aria-label="Your name (optional)" autocomplete="nickname" maxlength="24" placeholder="Your name (optional)" value="${this.escapeHtml(savedName)}" style="${field}" />
       <textarea id="sh-msg" aria-label="Your note" maxlength="200" rows="3" placeholder="Hi Abbas! 👋" style="${field}resize:none;"></textarea>
       <input id="sh-email" aria-label="Your email, only if you'd like a reply (optional)" autocomplete="email" maxlength="80" type="email" placeholder="Email — only if you'd like a reply (optional)" style="${field}" />
       <button id="sh-send" class="ds-press" style="width:100%;padding:11px;border:none;border-radius:10px;margin-top:2px;
         background:${DS.primary};color:#fff;font-size:15px;font-weight:600;cursor:pointer;">Send 👋</button>
       <p id="sh-error" role="alert" hidden style="margin:8px 0 0;font-size:13px;line-height:1.4;color:#ffb4a8;"></p>
       <p style="margin:9px 0 0;font-size:12px;color:#788;">Notes appear in the public guestbook — with an email it goes straight to Abbas instead.</p>`,
    );
    this.overlay.appendChild(modal);
    trackOnce('say_hi_opened');
    modal.querySelectorAll('input, textarea').forEach((el) => {
      el.addEventListener('keydown', (e) => e.stopPropagation()); // don't leak to game
    });
    const msgEl = modal.querySelector('#sh-msg') as HTMLTextAreaElement | null;
    const nameEl = modal.querySelector('#sh-name') as HTMLInputElement | null;
    const emailEl = modal.querySelector('#sh-email') as HTMLInputElement | null;
    const sendBtn = modal.querySelector('#sh-send') as HTMLButtonElement | null;
    // Inline errors, as the lead form's (D6).
    const errEl = modal.querySelector<HTMLElement>('#sh-error')!;
    this.clearFormErrorOnInput(errEl, modal.querySelectorAll<HTMLElement>('input, textarea'));
    msgEl?.focus();
    sendBtn?.addEventListener('click', () => {
      void (async () => {
        const msg = msgEl?.value.trim() ?? '';
        if (!msg) {
          this.formError(errEl, 'Write a little something first!', msgEl);
          return;
        }
        const email = emailEl?.value.trim() ?? '';
        if (email && !/^\S+@\S+\.\S+$/.test(email)) {
          this.formError(errEl, 'Please check your email address.', emailEl);
          return;
        }
        const name = nameEl?.value.trim() || 'Traveller';
        if (!sendBtn) return;
        sendBtn.disabled = true;
        sendBtn.textContent = 'Sending…';
        // Import inside the try, same as the contact form: a failed chunk
        // fetch used to escape this handler and strand the button disabled.
        let ok = false;
        try {
          const boards = await import('./Boards');
          ok = email
            ? await boards.submitLead(name, email, msg)
            : await boards.signGuestbook(name, msg);
        } catch {
          ok = false;
        }
        if (ok) {
          try {
            localStorage.setItem('ds_said_hi', '1');
          } catch {
            /* no storage */
          }
          track('say_hi_sent', { channel: email ? 'lead' : 'guestbook' });
          this.onProgressMade?.();
          modal.innerHTML = `<h2 style="margin:0 0 8px;color:#4CAF50;">👋 Sent!</h2>
            <p style="margin:0;font-size:14px;color:#cde;">${
              email
                ? "It's on its way to Abbas — he'll reply by email."
                : 'Your note is in the island guestbook. Thanks for stopping by!'
            }</p>`;
          window.setTimeout(() => {
            modal.remove();
            this.panels.notifyClosed('say-hi');
          }, 2200);
        } else {
          sendBtn.disabled = false;
          sendBtn.textContent = 'Send 👋';
          this.formError(errEl, 'Could not send — try again in a moment.', null);
        }
      })();
    });
  }

  // ── Island completion meter ──────────────────────────────────────────────
  // A quiet "🏝 43%" pill (top-right column). Clicking opens the checklist —
  // the visitor-goal loop from the audit: give explorers a reason to see
  // everything, with a hint per unfinished item.
  private completionBtn: HTMLElement | null = null;
  private completionPct = 0;
  private completionItems: Array<{ icon: string; label: string; done: boolean; hint: string }> = [];

  /** 🎒 Your Pack — the held-inventory panel. Desktop: icon-row slot (demoted
   *  from its own pill row with 📸); touch re-homes it into the ☰ drawer. */
  private createInventoryButton(): void {
    const btn = document.createElement('div');
    SimpleUI.chipContent(btn, 'backpack');
    btn.title = 'Your pack (inventory)';
    Object.assign(btn.style, {
      ...CHIP_ICON,
      top: 'calc(var(--sat, 0px) + 88px)',
      right: 'calc(var(--sar, 0px) + 200px)', // icon row slot 6
    });
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.showInventory();
    });
    this.makeHudButtonAccessible(btn, 'Your pack (inventory)');
    this.chipHost(btn, { drawer: true, label: 'Your Pack', order: 5 });
  }

  private createCompletionButton(): void {
    const btn = document.createElement('div');
    SimpleUI.chipContent(btn, 'map', '…');
    Object.assign(btn.style, {
      ...CHIP,
      top: 'calc(var(--sat, 0px) + 240px)', // last row of the column
      right: 'calc(var(--sar, 0px) + 10px)',
    });
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.showCompletionModal();
    });
    this.makeHudButtonAccessible(btn, 'Island completion checklist');
    this.chipHost(btn, { drawer: true, label: 'Progress · 0%', order: 8 });
    this.completionBtn = btn;
  }

  /** True after the first setCompletion — so the boot call (which reports a
   *  returning visitor's standing total) reads as BASELINE, not progress. */
  private completionSeeded = false;

  /** App-computed progress: percentage + the checklist items behind it. */
  public setCompletion(
    pct: number,
    items: Array<{ icon: string; label: string; done: boolean; hint: string }>,
  ): void {
    const prev = this.completionPct;
    const seeded = this.completionSeeded;
    this.completionSeeded = true;
    this.completionPct = pct;
    this.completionItems = items;
    // Desktop gets words — a bare "🏝 0%" reads as a loading artifact on a
    // first visit. Touch keeps the compact form (the drawer already labels
    // it "Progress", and the tier-1 row has no room for prose).
    if (this.completionBtn) {
      // The drawer row reads 'Progress · n%' (D13); desktop keeps its words.
      SimpleUI.chipText(
        this.completionBtn,
        this.isTouch ? `Progress · ${pct}%` : `${pct}% explored`,
      );
    }
    // Introduce the checklist at the FIRST increment — the moment the number
    // visibly moves is the discovery moment; a welcome-close toast would
    // have been documentation (and that slot is the orientation hint's).
    try {
      if (seeded && pct > prev && !localStorage.getItem('ds_hint_checklist')) {
        localStorage.setItem('ds_hint_checklist', '1');
        this.toast('🏝 That ticked up — tap the percentage for everything worth doing here.', {
          hint: true,
        });
      }
    } catch {
      /* no storage */
    }
  }

  showCompletionModal(): void {
    const modal = this.buildCenteredModal('min(390px, calc(100vw - 32px))', 'completion');
    trackOnce('completion_opened');
    const rows = this.completionItems
      .map(
        (it) =>
          `<div style="display:flex;gap:9px;align-items:flex-start;padding:7px 9px;border-radius:10px;
             background:${it.done ? 'rgba(18,183,106,0.10)' : 'rgba(255,255,255,0.03)'};margin:4px 0;text-align:left;">
             <span style="font-size:15px;line-height:1.3;">${it.done ? '✅' : '⬜'}</span>
             <div style="flex:1;">
               <div style="font-size:14px;font-weight:600;color:${it.done ? '#9fd8b8' : '#e8edf5'};">${it.icon} ${this.escapeHtml(it.label)}</div>
               ${it.done ? '' : `<div style="font-size:12px;color:#93a;color:#8fa0b8;margin-top:1px;">${this.escapeHtml(this.touchifyPlain(it.hint))}</div>`}
             </div>
           </div>`,
      )
      .join('');
    modal.insertAdjacentHTML(
      'beforeend',
      `<h2 style="margin:0 0 4px;color:#8a9bff;">🏝 Island completion — ${this.completionPct}%</h2>
       <p style="margin:0 0 12px;font-size:13px;color:#aab;">${
         this.completionPct >= 100
           ? 'You have seen it all. Abbas would genuinely love to hear from you. 💚'
           : 'Everything worth doing on the island, in one list.'
       }</p>
       <div style="max-height:56vh;overflow:auto;">${rows}</div>
       <button id="completion-journal" style="width:100%;margin-top:10px;padding:10px 12px;border-radius:10px;
         background:rgba(38,38,51,0.5);color:#dfe6f2;border:1px solid rgba(255,255,255,0.16);
         font-size:13px;cursor:pointer;">
         📔 Island Journal — collections &amp; every way to earn</button>`,
    );
    // The checklist says WHAT there is; the Journal says HOW it's going.
    // They never referenced each other — same panel-hop pattern as the
    // journal's own map button.
    modal.querySelector('#completion-journal')?.addEventListener('click', () => {
      modal.remove();
      this.panels.notifyClosed('completion');
      this.showJournal();
    });
    this.overlay.appendChild(modal);
  }

  /** Object URL of the previewed photo — revoked when replaced or closed. */
  private photoUrl: string | null = null;

  /**
   * Photo preview modal: the composited share card with Share / Download.
   * The buttons are fresh user gestures, which keeps iOS's share-sheet
   * transient-activation requirement satisfied (capture happened frames ago).
   */
  showPhotoPreview(card: Blob, postcardPose?: string): void {
    if (this.photoUrl) URL.revokeObjectURL(this.photoUrl);
    this.photoUrl = URL.createObjectURL(card);
    const modal = this.buildCenteredModal('min(440px, calc(100vw - 32px))', 'photo-preview');
    const closeX = modal.querySelector('button');
    closeX?.addEventListener('click', () => {
      if (this.photoUrl) URL.revokeObjectURL(this.photoUrl);
      this.photoUrl = null;
    });
    modal.insertAdjacentHTML(
      'beforeend',
      `<h2 style="margin:0 0 10px;color:#8a9bff;font-size:17px;">📸 Your island shot</h2>
       <img src="${this.photoUrl}" alt="Island photo" style="width:100%;border-radius:10px;display:block;margin-bottom:14px;" />`,
    );
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:10px;justify-content:center;flex-wrap:wrap;';
    const file = new File([card], 'life-island.jpg', { type: 'image/jpeg' });
    // Plain button (not makeShareButton) so the file-attached share fires once.
    const shareBtn = document.createElement('button');
    shareBtn.textContent = '📣 Share photo';
    Object.assign(shareBtn.style, {
      padding: '9px 16px',
      borderRadius: '10px',
      border: '1px solid rgba(120,160,255,0.45)',
      background: 'rgba(80,130,255,0.18)',
      color: '#cfe0ff',
      fontSize: '14px',
      fontWeight: '600',
      cursor: 'pointer',
    });
    shareBtn.addEventListener('click', () => {
      void share({
        surface: 'photo',
        // ?pc= carries the exact camera pose + hour: the recipient lands on
        // the sender's view, not the homepage.
        url: buildShareUrl(postcardPose ? { pc: postcardPose } : {}),
        title: 'DigiScalability Life Island',
        text: 'Snapped on the DigiScalability Life Island 🏝️ — stand where I stood:',
        file,
      }).then((outcome) => {
        if (outcome === 'copied') this.toast('🔗 Link copied — the photo saved via Download.');
        else if (outcome === 'failed') this.toast('Could not share on this device.');
      });
    });
    const dl = document.createElement('a');
    dl.textContent = '⬇️ Download';
    dl.href = this.photoUrl;
    dl.download = 'life-island.jpg';
    Object.assign(dl.style, {
      padding: '9px 16px',
      borderRadius: '10px',
      border: '1px solid rgba(255,255,255,0.25)',
      background: 'rgba(255,255,255,0.08)',
      color: '#fff',
      fontSize: '14px',
      fontWeight: '600',
      textDecoration: 'none',
    });
    row.appendChild(shareBtn);
    row.appendChild(dl);
    modal.appendChild(row);
    this.overlay.appendChild(modal);
  }

  /**
   * "Time travelled" pill for ?hour= visitors — bottom-center, tap to return
   * to the live clock. The revert callback clears debugHour + strips the param.
   */
  showTimeOverridePill(label: string, onRevert: () => void): void {
    const pill = document.createElement('div');
    pill.textContent = `${label} — tap to return to live time`;
    // Touch: tucked under the minimap on the left — the old bottom-centre
    // anchor sat this persistent pill ON the FEED button (100% covered) and
    // across the joystick zone on a 667px screen. Desktop keeps the centre.
    const anchor = this.isTouch
      ? { top: 'calc(var(--sat, 0px) + 228px)', left: '10px', transform: '', maxWidth: '46vw' }
      : { bottom: 'calc(var(--sab, 0px) + 64px)', left: '50%', transform: 'translateX(-50%)' };
    Object.assign(pill.style, {
      position: 'absolute',
      ...anchor,
      background: 'rgba(10, 14, 30, 0.82)',
      border: '1px solid rgba(140,160,255,0.26)',
      color: '#dbe4ff',
      padding: '8px 16px',
      borderRadius: '999px',
      fontSize: '13px',
      fontFamily: 'system-ui, sans-serif',
      cursor: 'pointer',
      pointerEvents: 'auto',
      userSelect: 'none',
      zIndex: '1300',
      boxShadow: '0 4px 14px rgba(0,0,0,0.4)',
    });
    pill.addEventListener('click', () => {
      onRevert();
      pill.remove();
      this.toast('🕐 Back to live island time.');
    });
    this.overlay.appendChild(pill);
  }

  private togglePortfolioMenu(): void {
    if (this.portfolioMenuDiv) {
      this.portfolioMenuDiv.remove();
      this.portfolioMenuDiv = null;
      this.panels.notifyClosed('portfolio-menu');
      return;
    }
    trackOnce('portfolio_opened');
    this.hideZonePanel();
    // Phones: WAVE/JUMP/USE and the 💬/🎤 buttons (z 1650) drew over this
    // menu (z 1600), so a tap on Guestbook, Island Times, Your Pack or Island
    // Journal could land on a touch control. The menu clears them, as every
    // modal does; they come back when it closes.
    const menu = document.createElement('div');
    // A dialog by name, but a sheet: no aria-modal, no Tab trap, no inert.
    // Focus moves to its first row and comes back to the pill on close (D4;
    // Enter on the pill used to leave focus there, 9 Tabs from the rows).
    this.panels.open('portfolio-menu', {
      kind: 'sheet',
      hides: ['nav-chips', 'touch-controls', 'aux-controls'],
      close: () => {
        this.portfolioMenuDiv?.remove();
        this.portfolioMenuDiv = null;
      },
      el: menu,
      // The first row, or the section '‹ Portfolio' came back from (UX-08).
      initialFocus: () => {
        const want = this.menuFocusSection;
        this.menuFocusSection = null;
        return (
          (want ? menu.querySelector<HTMLElement>(`button[data-section="${want}"]`) : null) ??
          menu.querySelector<HTMLElement>('button[data-section]')
        );
      },
    });
    this.stepHintAside();
    menu.setAttribute('role', 'dialog');
    menu.setAttribute('aria-labelledby', 'ds-portfolio-menu-title');
    Object.assign(menu.style, {
      position: 'fixed',
      top: '50%',
      left: '50%',
      transform: 'translate(-50%, -50%)',
      background: 'rgb(12, 12, 20)', // opaque: no minimap or compass through it (D16)
      color: 'white',
      padding: '24px',
      borderRadius: '16px',
      pointerEvents: 'auto',
      zIndex: '1600',
      width: 'min(340px, calc(100vw - 32px))',
      textAlign: 'center',
      border: '1px solid rgba(255,255,255,0.15)',
      boxShadow: '0 12px 40px rgba(0,0,0,0.5)',
      // The hire row made the menu ~708px tall: on a 375x667 phone its title
      // and × sat off-screen. Clamp + scroll inside, like the other modals.
      maxHeight: 'calc(100dvh - 32px)',
      overflowY: 'auto',
    });
    // Two labelled groups (D5, UX-19): the six portfolio entries, then the
    // island's. It mixed 6 portfolio items with 7 game items under one title,
    // with Passport, a game item, first and the only filled button. Now the
    // Hiring row leads as the one filled button (#ffd479 on #1b1400, 13:1).
    // The sprite's icons in the rows (D13): Hiring's file-text, the
    // districts' glyphs (DISTRICT_GLYPHS), no emoji in the chrome.
    const sections: Array<{ id: string; label: string; icon: IconName }> = [
      // The hire card is reachable from here too: a recruiter who dismissed
      // the welcome card must not have to find the pill again.
      { id: 'hire', label: 'Hiring? CV, experience and contact', icon: 'file-text' },
      { id: 'welcome', label: 'About this world', icon: 'home' },
      { id: 'professional', label: 'Professional', icon: 'briefcase' },
      { id: 'projects', label: 'Projects', icon: 'rocket' },
      { id: 'personal', label: 'Personal', icon: 'heart' },
      { id: 'contact', label: 'Get in touch', icon: 'mail' },
    ];
    const row =
      'display:flex;align-items:center;gap:10px;width:100%;min-height:44px;margin:6px 0;padding:11px 12px;border-radius:10px;font-size:15px;cursor:pointer;text-align:left;';
    const rows = sections
      .map((s) =>
        s.id === 'hire'
          ? `<button data-section="${s.id}" style="${row}background:#ffd479;color:#1b1400;border:1px solid #ffd479;font-weight:700;">${icon(s.icon)}<span>${s.label}</span></button>`
          : `<button data-section="${s.id}" style="${row}background:#26263340;color:#fff;border:1px solid rgba(255,255,255,0.12);">${icon(s.icon)}<span>${s.label}</span></button>`,
      )
      .join('');
    const pp = this.passport;
    const ppLabel = pp
      ? pp.isComplete()
        ? `<span>Passport</span>${icon('crown', 16)}`
        : `<span>Passport ${pp.count()}/${pp.total()}</span>`
      : '<span>Passport</span>';
    const tile =
      'display:flex;align-items:center;justify-content:center;gap:7px;min-height:44px;padding:10px 8px;background:#26263340;color:#fff;border:1px solid rgba(255,255,255,0.12);border-radius:10px;font-size:14px;cursor:pointer;';
    // The group headers take the 11 px uppercase caption class (D13).
    const group = 'margin:14px 0 2px;text-align:left;';
    menu.innerHTML = `
      <h2 id="ds-portfolio-menu-title" style="margin:0 0 4px; color:#8a9bff;display:flex;align-items:center;justify-content:center;gap:8px;">${icon('book', 22)}<span>Portfolio</span></h2>
      <p style="margin:0 0 4px; font-size:13px; color:#aab;">Jump to any section — or close this and explore the island.</p>
      <div role="group" aria-labelledby="ds-menu-group-portfolio">
        <h3 id="ds-menu-group-portfolio" class="ds-caption" style="${group}">Portfolio</h3>
        ${rows}
      </div>
      <div role="group" aria-labelledby="ds-menu-group-island">
        <h3 id="ds-menu-group-island" class="ds-caption" style="${group}">Island</h3>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:6px;">
          <button data-journal style="${tile}">${icon('book', 16)}<span>Journal</span></button>
          <button data-pack style="${tile}">${icon('backpack', 16)}<span>Pack</span></button>
          <button data-passport="1" style="${tile}">${icon('passport', 16)}${ppLabel}</button>
          <button data-board="leaderboard" style="${tile}">${icon('trophy', 16)}<span>Leaderboard</span></button>
          <button data-board="guestbook" style="${tile}">${icon('pen', 16)}<span>Guestbook</span></button>
          <button data-board="times" style="${tile}">${icon('news', 16)}<span>Island Times</span></button>
        </div>
        <button data-visit style="${tile}width:100%;margin-top:8px;">${icon('compass', 16)}<span>Your visit</span></button>
        <button data-controls style="${tile}width:100%;margin-top:8px;">${icon('keyboard', 16)}<span>Controls &amp; settings</span></button>
      </div>`;

    // close button: named, and the 44px box every other × has (it measured
    // 14x28 and was announced as 'times').
    const close = document.createElement('button');
    close.textContent = '×';
    close.setAttribute('aria-label', 'Close portfolio menu');
    Object.assign(close.style, {
      position: 'absolute',
      top: '4px',
      right: '6px',
      width: '44px',
      height: '44px',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '0',
      background: 'transparent',
      color: 'white',
      border: 'none',
      fontSize: '24px',
      cursor: 'pointer',
    });
    close.addEventListener('click', () => this.togglePortfolioMenu());
    menu.appendChild(close);
    menu.querySelectorAll('button[data-section]').forEach((b) => {
      b.addEventListener('click', () => {
        const id = (b as HTMLElement).dataset.section!;
        this.togglePortfolioMenu();
        this.showZonePanel({ id, name: id });
      });
    });
    menu.querySelector('button[data-passport]')?.addEventListener('click', () => {
      this.togglePortfolioMenu();
      this.showPassport();
    });
    menu.querySelector('button[data-pack]')?.addEventListener('click', () => {
      this.togglePortfolioMenu();
      this.showInventory();
    });
    menu.querySelector('button[data-controls]')?.addEventListener('click', () => {
      this.togglePortfolioMenu();
      this.showControls('menu');
    });
    menu.querySelector('button[data-visit]')?.addEventListener('click', () => {
      this.togglePortfolioMenu();
      this.showVisitSummary();
    });
    menu.querySelector('button[data-journal]')?.addEventListener('click', () => {
      this.togglePortfolioMenu();
      this.showJournal();
    });
    menu.querySelectorAll('button[data-board]').forEach((b) => {
      b.addEventListener('click', () => {
        const board = (b as HTMLElement).dataset.board;
        this.togglePortfolioMenu();
        if (board === 'leaderboard') void this.showLeaderboard();
        else if (board === 'times') void this.showIslandTimes();
        else void this.showGuestbook();
      });
    });
    this.portfolioMenuDiv = menu;
    this.overlay.appendChild(menu);
    if (window.innerHeight <= 500) this.addScrollFade(menu, 'rgb(12, 12, 20)');
  }

  // ── Controls & settings (D8) ───────────────────────────────────────────
  // One reference for every control, a "Things to do" list that points the
  // compass, and the settings the input layer reads. Opened by ? or H, the
  // Portfolio menu, the phone drawer and a strip on both welcome cards.

  /** The keyboard rows. `run` and `zoom` depend on html[data-run-key] (A11
   *  ships the Shift run and the wheel zoom together, in wave 3). */
  private controlsKeyboardRows(): Array<[string, string]> {
    const runKey = document.documentElement.getAttribute('data-run-key');
    const rows: Array<[string, string]> = [
      ['Move', '<kbd>W</kbd> <kbd>A</kbd> <kbd>S</kbd> <kbd>D</kbd> or the arrow keys'],
      [
        'Look',
        'drag with the mouse · <kbd>J</kbd> <kbd>L</kbd> turn · <kbd>I</kbd> <kbd>K</kbd> tilt · <kbd>R</kbd> recentre',
      ],
    ];
    if (runKey) rows.push(['Zoom', 'mouse wheel, or <kbd>=</kbd> and <kbd>−</kbd>']);
    rows.push(
      [
        'Run',
        runKey === 'shift'
          ? 'hold <kbd>Shift</kbd> while moving'
          : 'hold <kbd>Space</kbd> while moving',
      ],
      ['Jump', '<kbd>Space</kbd> (hold in water to stay afloat)'],
      ['Dive', 'hold <kbd>Shift</kbd> in water'],
      ['Use', '<kbd>E</kbd> — talk, enter, sit, whatever the prompt says'],
      ['Wave', '<kbd>Q</kbd>'],
      ['Map', '<kbd>M</kbd>'],
      ['Feed', '<kbd>F</kbd>, with feed from the shop'],
      ['Eat', '<kbd>G</kbd>, with a cooked meal'],
      ['Chat', '<kbd>Enter</kbd>'],
      ['Talk aloud', 'hold <kbd>V</kbd>'],
      ['Photo', '<kbd>P</kbd>'],
      ['Appearance', '<kbd>C</kbd>'],
      ['Close', '<kbd>Esc</kbd>'],
      ['This sheet', '<kbd>?</kbd> or <kbd>H</kbd>'],
    );
    return rows;
  }

  private static readonly CONTROLS_TOUCH_ROWS: ReadonlyArray<[string, string]> = [
    ['Move', 'drag the joystick, bottom left'],
    ['Look', 'swipe anywhere on the world'],
    ['Use', '👆 USE — talk, enter, sit, whatever the prompt says'],
    ['Jump', '⤒ JUMP (hold in water to stay afloat)'],
    ['Wave', '👋 WAVE'],
    ['Dive', '🤿 DIVE, shown while you swim'],
    ['Feed', '🌾 FEED, shown once you carry feed'],
    ['Eat', '🍽️ EAT, shown once you carry a meal'],
    ['Chat', '💬 above the joystick'],
    ['Talk aloud', 'hold 🎤'],
    ['Map', 'tap the compass pill or the minimap'],
    ['Menu', '☰ — Work with me, Portfolio, photo, sound and this sheet'],
  ];

  /**
   * The nearest way to earn, for the shop's short-of-coins line (P2-D7): the
   * first undone earning goal on the ladder ('ds:goals'), else deliveries.
   * Its key is the one Things to do gives that system.
   */
  private nearestEarn(): { key: string; title: string; label: string } {
    const ways: Array<{ goal: string; key: string; title: string; label: string }> = [
      {
        goal: 'deliveries',
        key: 'mailbox:next',
        title: 'Deliveries',
        label: 'A glowing mailbox holds a paid delivery.',
      },
      {
        goal: 'lesson',
        key: 'school',
        title: 'The School’s lessons',
        label: 'Each School lesson pays a few coins.',
      },
      {
        goal: 'catch',
        key: 'shore',
        title: 'Fishing',
        label: 'The Fisherman buys every catch.',
      },
    ];
    const keys = new Set(this.thingsToDo().map((t) => t.key));
    const goals = this.goals?.goals;
    const open = ways.filter(
      (w) => keys.has(w.key) && !goals?.some((g) => g.id === w.goal && g.done),
    );
    const pick = open[0] ?? ways[0];
    return { key: pick.key, title: pick.title, label: pick.label };
  }

  /** One line per system; `key` is a 'ds:guide-to' key the compass can take. */
  private thingsToDo(): Array<{ icon: string; title: string; how: string; key?: string }> {
    const pp = this.passport;
    const nextStamp = pp ? PASSPORT_ZONES.find((z) => !pp.has(z)) : PASSPORT_ZONES[0];
    // The action in the visitor's own scheme: a key, or the touch button.
    const use = this.isTouch ? 'tap 👆 USE' : 'press E';
    const feed = this.isTouch ? 'tap 🌾 FEED' : 'press F';
    const eat = this.isTouch ? 'tap 🍽️ EAT' : 'press G';
    const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
    return [
      {
        icon: '🎣',
        title: 'Fishing',
        how: `Buy a rod at the shop, stand at a shore and ${use} to cast. The Fisherman buys the catch.`,
        key: 'shore',
      },
      {
        icon: '🪓',
        title: 'Chopping',
        how: 'An axe from the shop fells trees. Sell the timber to the Carpenter, or build with it.',
        key: 'carpenter',
      },
      {
        icon: '🐦',
        title: 'Feeding birds',
        how: `Feed from the shop calls nearby birds, cats or fish: ${feed}.`,
      },
      {
        icon: '🍽️',
        title: 'Eating',
        how: `A cooked meal refills your stamina: ${eat}.`,
      },
      {
        icon: '🔨',
        title: 'Building',
        how: `Hammer stakes mark free plots. Bring timber and coins, and ${use} at a stake.`,
        key: 'stake:nearest',
      },
      {
        icon: '🏁',
        title: 'Races',
        how: 'Board a vehicle and cross a start line. Your best lap goes on the Leaderboard.',
        key: 'race:land',
      },
      {
        icon: '📦',
        title: 'Deliveries',
        how: `A glowing mailbox holds a delivery. ${cap(use)} to collect it, and the next one lights up.`,
        key: 'mailbox:next',
      },
      {
        icon: '🏫',
        title: 'The School’s lessons',
        how: 'Each lesson at the School teaches one of the island’s trades, and pays a few coins.',
        key: 'school',
      },
      {
        icon: '🛒',
        title: 'The shop',
        how: 'Tools, hats, feed and food, for the coins you find and earn.',
        key: 'kiosk',
      },
      {
        icon: '🛂',
        title: 'Passport stamps',
        how: 'Walk into each district’s hall to stamp your passport. A full passport earns a crown.',
        ...(nextStamp ? { key: `district:${nextStamp}` } : {}),
      },
      // Decision P2-2: the beach house is findable. Its door has a code, and
      // the Sailor is who to ask (P2-D9; his line is package C's P2-C6).
      {
        icon: '🏖️',
        title: 'The beach house',
        how: 'Visit the beach house on the islet (ask the Sailor).',
        key: 'beach-house',
      },
    ];
  }

  /**
   * The Things to do rows. Once 'ds:goals' has fired they are the ladder's
   * goals in ladder order (P2-D10), each with the static row's icon and how
   * where one shares its key; the static rows stay as the fallback.
   */
  private todoRows(): Array<{
    icon: string;
    title: string;
    how: string;
    key?: string;
    done?: boolean;
  }> {
    const fixed = this.thingsToDo();
    const goals = this.goals?.goals;
    if (!goals || goals.length === 0) return fixed;
    const byKey = new Map(fixed.filter((r) => r.key).map((r) => [r.key as string, r]));
    const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
    return goals.map((g) => {
      const zone = g.id.startsWith('stamp:') ? g.id.slice('stamp:'.length) : null;
      const meta = zone ? (PASSPORT_META as Record<string, { icon: string }>)[zone] : undefined;
      const same = byKey.get(g.guideKey);
      return {
        icon: meta?.icon ?? same?.icon ?? '⭐',
        title: esc(g.label),
        how: zone ? 'Walk into its hall to stamp your passport.' : (same?.how ?? ''),
        key: g.guideKey,
        done: g.done,
      };
    });
  }

  /** Write a setting and tell the input layer (SimpleInputManager re-reads
   *  its three look keys on 'ds:settings'). */
  private writeSetting(key: string, value: string): void {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* storage blocked: the setting holds for nothing, and says nothing */
    }
    try {
      window.dispatchEvent(new CustomEvent('ds:settings', { detail: { key } }));
    } catch {
      /* no CustomEvent: nothing listens either */
    }
  }

  /**
   * The Controls & settings sheet. `source` says where it was opened from
   * (controls_opened); `tab` opens it on a tab other than Controls.
   *
   * Opened from the welcome card (its strip, or ? while it is up), the card
   * steps aside unread and comes back when the sheet closes: it is parked,
   * not dismissed, so ds_welcomed is not burned and isWelcomeVisible() stays
   * true for main-simple (the world takes no input, and First steps waits
   * for the card's own Explore).
   */
  public showControls(
    source: 'key' | 'menu' | 'drawer' | 'welcome' = 'menu',
    tab: 'controls' | 'todo' | 'settings' = 'controls',
  ): void {
    if (this.welcomeDiv) {
      this.welcomeParked = true;
      this.hideWelcome(false); // not a dismissal: the sheet's close re-shows it
    }
    const modal = this.buildCenteredModal('min(560px, calc(100vw - 32px))', 'controls', {
      // A task later: the manager is still closing the sheet when this runs.
      onClose: () => queueMicrotask(() => this.unparkWelcome()),
    });
    modal.classList.add('ds-controls');
    track('controls_opened', { source });

    // Mouse lock is offered wherever there is a mouse: every desktop, and a
    // touchscreen laptop (the touch scheme, but a fine pointer as well).
    let finePointer = false;
    try {
      finePointer = window.matchMedia?.('(any-pointer: fine)').matches === true;
    } catch {
      /* no matchMedia: the touch scheme alone decides */
    }
    const hasMouse = !this.isTouch || finePointer;
    const readFlag = (key: string): boolean => {
      try {
        return localStorage.getItem(key) === '1';
      } catch {
        return false;
      }
    };
    let sens = 1;
    try {
      const v = Number.parseFloat(localStorage.getItem('ds_look_sens') ?? '');
      if (Number.isFinite(v)) sens = Math.min(2, Math.max(0.5, v));
    } catch {
      /* the default */
    }

    const rows = (list: ReadonlyArray<[string, string]>): string =>
      `<dl class="ds-controls-rows">${list
        .map(([what, how]) => `<div><dt>${what}</dt><dd>${how}</dd></div>`)
        .join('')}</dl>`;
    const todo = this.todoRows();
    const tabs: Array<[typeof tab, string]> = [
      ['controls', 'Controls'],
      ['todo', 'Things to do'],
      ['settings', 'Settings'],
    ];
    const check = (id: string, label: string, hint: string, on: boolean): string =>
      `<label class="ds-controls-setting" for="${id}">
         <input type="checkbox" id="${id}" ${on ? 'checked' : ''} />
         <span><strong>${label}</strong><small>${hint}</small></span>
       </label>`;

    modal.insertAdjacentHTML(
      'beforeend',
      `<h2 style="margin:0 0 12px;color:#8a9bff;">Controls &amp; settings</h2>
       <div role="tablist" aria-label="Controls and settings">
         ${tabs
           .map(
             ([id, label]) =>
               `<button type="button" role="tab" id="ds-ctl-tab-${id}" data-tab="${id}" aria-controls="ds-ctl-panel-${id}"
                  aria-selected="${id === tab}" tabindex="${id === tab ? 0 : -1}">${label}</button>`,
           )
           .join('')}
       </div>
       <div role="tabpanel" id="ds-ctl-panel-controls" aria-labelledby="ds-ctl-tab-controls" ${tab === 'controls' ? '' : 'hidden'}>
         <div class="ds-controls-switch" role="group" aria-label="Control scheme">
           <button type="button" data-scheme="keys" aria-pressed="${!this.isTouch}">Keyboard &amp; mouse</button>
           <button type="button" data-scheme="touch" aria-pressed="${this.isTouch}">Touch</button>
         </div>
         <div data-scheme-rows="keys" ${this.isTouch ? 'hidden' : ''}>${rows(this.controlsKeyboardRows())}</div>
         <div data-scheme-rows="touch" ${this.isTouch ? '' : 'hidden'}>${rows(SimpleUI.CONTROLS_TOUCH_ROWS)}</div>
       </div>
       <div role="tabpanel" id="ds-ctl-panel-todo" aria-labelledby="ds-ctl-tab-todo" ${tab === 'todo' ? '' : 'hidden'}>
         <ul class="ds-controls-todo">
           ${todo
             .map(
               (it) =>
                 `<li${it.done ? ' data-done="1"' : ''}><span class="ds-controls-todo-text"><strong>${it.icon} ${it.title}</strong>
                    ${it.how ? `<span>${it.how}</span>` : ''}</span>${
                      it.done
                        ? '<span class="ds-controls-todo-done">✓ Done</span>'
                        : it.key
                          ? `<button type="button" data-show-me="${it.key}" aria-label="Show me: ${it.title}">Show me</button>`
                          : ''
                    }</li>`,
             )
             .join('')}
         </ul>
       </div>
       <div role="tabpanel" id="ds-ctl-panel-settings" aria-labelledby="ds-ctl-tab-settings" ${tab === 'settings' ? '' : 'hidden'}>
         <label class="ds-controls-setting ds-controls-range" for="ds-set-sens">
           <span><strong>Look sensitivity</strong><small>How far the view turns for the same drag or swipe.</small></span>
           <span class="ds-controls-range-row">
             <input type="range" id="ds-set-sens" min="0.5" max="2" step="0.1" value="${sens}" />
             <output for="ds-set-sens">${sens.toFixed(1)}×</output>
           </span>
         </label>
         ${check('ds-set-invert', 'Invert vertical look', 'Dragging down tilts the view up.', readFlag('ds_look_invert'))}
         ${
           !hasMouse
             ? ''
             : check(
                 'ds-set-lock',
                 'Mouse lock',
                 'Opt in: a click captures the cursor and the view follows the mouse without a drag. Esc releases it.',
                 readFlag('ds_mouse_lock'),
               )
         }
         ${
           this.isTouch
             ? check(
                 'ds-set-haptics',
                 'Haptics',
                 'A short buzz on the touch buttons, where the phone supports it.',
                 hapticsEnabled(),
               )
             : ''
         }
       </div>`,
    );

    // Tabs: click, and Left/Right/Home/End with a roving tabindex.
    const tabEls = [...modal.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    const select = (id: string, focus: boolean): void => {
      for (const t of tabEls) {
        const on = t.dataset.tab === id;
        t.setAttribute('aria-selected', String(on));
        t.tabIndex = on ? 0 : -1;
        const panel = modal.querySelector<HTMLElement>(`#ds-ctl-panel-${t.dataset.tab}`);
        if (panel) panel.hidden = !on;
        if (on && focus) t.focus();
      }
      modal.scrollTop = 0;
    };
    for (const [i, t] of tabEls.entries()) {
      t.addEventListener('click', () => select(t.dataset.tab ?? 'controls', false));
      t.addEventListener('keydown', (e) => {
        const step =
          e.key === 'ArrowRight'
            ? 1
            : e.key === 'ArrowLeft'
              ? -1
              : e.key === 'Home'
                ? -i
                : e.key === 'End'
                  ? tabEls.length - 1 - i
                  : 0;
        if (!step) return;
        e.preventDefault();
        e.stopPropagation();
        const next = tabEls[(i + step + tabEls.length) % tabEls.length];
        select(next.dataset.tab ?? 'controls', true);
      });
    }
    // Keyboard & mouse · Touch.
    const schemeBtns = [...modal.querySelectorAll<HTMLButtonElement>('button[data-scheme]')];
    for (const b of schemeBtns) {
      b.addEventListener('click', () => {
        for (const o of schemeBtns) o.setAttribute('aria-pressed', String(o === b));
        for (const r of modal.querySelectorAll<HTMLElement>('[data-scheme-rows]')) {
          r.hidden = r.dataset.schemeRows !== b.dataset.scheme;
        }
      });
    }
    // Show me: the compass takes it from here, and the sheet steps aside (a
    // parked welcome card comes back over the island, with the compass set).
    for (const b of modal.querySelectorAll<HTMLButtonElement>('button[data-show-me]')) {
      b.addEventListener('click', () => {
        const key = b.dataset.showMe ?? '';
        this.closeCenteredModal(modal, 'controls');
        this.guideTo(key, 'controls');
      });
    }
    // Settings write through at once: no Save button to forget.
    const sensEl = modal.querySelector<HTMLInputElement>('#ds-set-sens');
    const sensOut = modal.querySelector<HTMLOutputElement>('output[for="ds-set-sens"]');
    sensEl?.addEventListener('input', () => {
      const v = Math.min(2, Math.max(0.5, Number.parseFloat(sensEl.value) || 1));
      if (sensOut) sensOut.textContent = `${v.toFixed(1)}×`;
      this.writeSetting('ds_look_sens', String(v));
    });
    // The slider owns the keys that move it: they must not reach the world.
    // Escape and Tab still go on to the manager (a blanket stop here left
    // Escape dead while the slider had focus).
    sensEl?.addEventListener('keydown', (e) => {
      if (/^(Arrow(Up|Down|Left|Right)|Home|End|PageUp|PageDown)$/.test(e.key)) {
        e.stopPropagation();
      }
    });
    const wire = (id: string, key: string): void => {
      const el = modal.querySelector<HTMLInputElement>(`#${id}`);
      el?.addEventListener('change', () => this.writeSetting(key, el.checked ? '1' : '0'));
    };
    wire('ds-set-invert', 'ds_look_invert');
    wire('ds-set-lock', 'ds_mouse_lock');
    wire('ds-set-haptics', 'ds_haptics');

    this.overlay.appendChild(modal);
  }

  /** The welcome card stepped aside for the Controls sheet (showControls). */
  private welcomeParked = false;
  /** What the open (or parked) welcome card was shown with. */
  private welcomeArgs: AwayDelta | null | undefined = undefined;

  /** The sheet closed: the parked welcome card comes back. */
  private unparkWelcome(): void {
    if (!this.welcomeParked) return;
    this.welcomeParked = false;
    if (!this.messagesStopped && !this.welcomeDiv) this.showWelcome(this.welcomeArgs);
  }

  /** ? or H opens the sheet, and closes it again (D8). Typing never does:
   *  a field, or a panel that owns the keyboard, keeps the key. */
  private readonly onControlsKey = (e: KeyboardEvent): void => {
    if (e.defaultPrevented || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key !== '?' && e.key !== 'h' && e.key !== 'H') return;
    const t = e.target;
    if (
      t instanceof HTMLElement &&
      (t.isContentEditable || t.matches('input, textarea, select, [role="textbox"]'))
    ) {
      return;
    }
    if (this.isLoadingVisible() || this.nameModalDiv) return;
    const top = this.panels.current();
    if (top === 'controls') {
      this.panels.closeTop('escape');
      return;
    }
    // Over the bare island, the welcome card, the menu or the drawer only:
    // any other panel (a hall panel, a shop, a chat) keeps its place.
    if (top !== null && top !== 'welcome' && top !== 'portfolio-menu' && top !== 'drawer') return;
    e.preventDefault();
    this.showControls(top === 'welcome' ? 'welcome' : 'key');
  };

  /** The phone drawer's Controls row (D8). Desktop reaches the sheet from
   *  the Portfolio menu and by ? or H, so it gets no chip of its own. */
  private createControlsRow(): void {
    if (!this.isTouch) return;
    const btn = document.createElement('div');
    SimpleUI.chipContent(btn, 'keyboard', 'Controls & settings');
    btn.dataset.controlsRow = '1';
    Object.assign(btn.style, { ...CHIP });
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.showControls('drawer');
    });
    this.makeHudButtonAccessible(btn, 'Controls and settings');
    // After the ten rows that were there: the drawer's order is Abbas's.
    this.chipHost(btn, { drawer: true, order: 11 });
  }

  /**
   * Touch controls (joystick + E / Jump buttons), created only on touch
   * devices. Buttons dispatch synthetic keyboard events so every existing
   * input path (interaction, dialogue advance, jump) works unchanged;
   * the analog joystick is merged into movement in main-simple.
   */
  private createTouchControls(revealed = false): void {
    if (!this.isTouch && !revealed) return;

    // Joystick — the visible ring sits inside a larger INVISIBLE hit region
    // (the whole ~166px lower-left corner): a blind thumb landing a little
    // outside the ring must still engage it, not dead-tap. The ring itself
    // stays at its old spot (26px in from the safe-area corner).
    const hit = document.createElement('div');
    Object.assign(hit.style, {
      position: 'absolute',
      left: 'var(--sal, 0px)',
      bottom: 'var(--sab, 0px)',
      width: '166px',
      height: '166px',
      pointerEvents: 'auto',
      touchAction: 'none',
    });
    const base = document.createElement('div');
    Object.assign(base.style, {
      position: 'absolute',
      left: '26px',
      bottom: '26px',
      width: '110px',
      height: '110px',
      borderRadius: '50%',
      background: 'rgba(255,255,255,0.12)',
      border: '2px solid rgba(255,255,255,0.25)',
      // The wrapper owns all touch events; ring + thumb are visuals only
      pointerEvents: 'none',
    });
    const thumb = document.createElement('div');
    Object.assign(thumb.style, {
      position: 'absolute',
      left: '31px',
      top: '31px',
      width: '44px',
      height: '44px',
      borderRadius: '50%',
      background: 'rgba(255,255,255,0.45)',
    });
    base.appendChild(thumb);
    base.dataset.guide = 'joystick'; // First steps' ghost thumb sits on the ring (A6)
    // D15: the 11 px uppercase MOVE caption under the ring, for the first
    // session only (until the stick is first engaged; without storage, for
    // the page's life).
    let moveSeen = false;
    try {
      moveSeen = localStorage.getItem('ds_move_seen') === '1';
    } catch {
      /* storage blocked: show it */
    }
    let caption: HTMLDivElement | null = null;
    if (!moveSeen) {
      caption = document.createElement('div');
      caption.className = 'ds-caption';
      caption.textContent = 'Move';
      Object.assign(caption.style, {
        position: 'absolute',
        left: '0',
        top: 'calc(100% + 3px)',
        width: '100%',
        textAlign: 'center',
        pointerEvents: 'none',
        textShadow: '0 1px 2px rgba(0,0,0,0.7)',
      });
      base.appendChild(caption);
    }
    hit.appendChild(base);
    hit.classList.add('ds-touch-ctl'); // fades after keyboard-only play (D7)
    this.overlay.appendChild(hit);
    this.panels.registerLayer('touch-controls', hit);

    // Thumb and ring move by transform (D11's compositor-only rule); the
    // ring's left/bottom stay at its 26 px rest spot.
    const moveThumb = (dx: number, dy: number) => {
      thumb.style.transform = dx || dy ? `translate(${dx}px, ${dy}px)` : '';
    };
    // D15 (JOY-01): a FLOATING origin. The stick's zero is wherever the
    // thumb lands, so a touchdown anywhere in the 166 px square reads |v| = 0
    // instead of a full-speed lurch. The ring follows the thumb but is
    // clamped so the 110 px ring stays inside the square (its centre within
    // 55..111 px of the square's left and top); a landing beyond the clamp
    // shows the thumb off-centre in the ring, still at rest.
    const HIT = 166;
    const RING = 110;
    const REST = 26; // the ring's home: left/bottom 26 px
    const MAX = 40; // the thumb's travel
    // Hysteresis: engage at 12% deflection; once engaged, release only below
    // 8%, renormalised from 8% so the output is continuous on the way down.
    const ENGAGE = 0.12;
    const RELEASE = 0.08;
    // The run colour mirrors A's rim run (main-simple's STICK_RUN_MAG 0.95
    // held for STICK_RUN_MS 250): D reads no A code, so the two are named
    // here and must move together.
    const STICK_RUN_MAG = 0.95;
    const STICK_RUN_MS = 250;
    const RING_BORDER = '2px solid rgba(255,255,255,0.25)';
    const RING_RUN = '2px solid #ffb547';
    let originX = 0;
    let originY = 0;
    let ringCx = 0; // the ring centre, client px, for the thumb's offset
    let ringCy = 0;
    let engaged = false;
    let runTimer: number | null = null;
    let running = false;
    const setRun = (on: boolean): void => {
      if (running === on) return;
      running = on;
      base.style.border = on ? RING_RUN : RING_BORDER;
      if (on) hapticPulse(10);
    };
    const clearRun = (): void => {
      if (runTimer !== null) window.clearTimeout(runTimer);
      runTimer = null;
      setRun(false);
    };
    // Identifier-tracked: e.touches[0] is the earliest finger ON THE PAGE,
    // so with a camera finger already down the joystick read the WRONG
    // finger and movement lurched. Track the pad's own finger by identifier.
    let joyTouchId: number | null = null;
    const applyJoyTouch = (t: Touch) => {
      const dx = t.clientX - originX;
      const dy = t.clientY - originY;
      const len = Math.hypot(dx, dy);
      const mag = Math.min(1, len / MAX);
      // The thumb shows where the finger is relative to the drawn ring.
      let tx = t.clientX - ringCx;
      let ty = t.clientY - ringCy;
      const tl = Math.hypot(tx, ty);
      if (tl > MAX) {
        tx = (tx / tl) * MAX;
        ty = (ty / tl) * MAX;
      }
      moveThumb(tx, ty);
      if (!engaged && mag >= ENGAGE) engaged = true;
      else if (engaged && mag < RELEASE) engaged = false;
      const out = engaged ? (mag - RELEASE) / (1 - RELEASE) : 0;
      if (out > 0 && len > 0) {
        this.joyState.strafe = (dx / len) * out;
        this.joyState.forward = (-dy / len) * out;
      } else {
        this.joyState.strafe = 0;
        this.joyState.forward = 0;
      }
      if (out >= STICK_RUN_MAG) {
        if (runTimer === null && !running) {
          runTimer = window.setTimeout(() => {
            runTimer = null;
            const j = this.joyState;
            if (joyTouchId !== null && Math.hypot(j.forward, j.strafe) >= STICK_RUN_MAG)
              setRun(true);
          }, STICK_RUN_MS);
        }
      } else clearRun();
    };
    hit.addEventListener(
      'touchstart',
      (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (joyTouchId !== null || e.changedTouches.length === 0) return;
        const t = e.changedTouches[0];
        joyTouchId = t.identifier;
        engaged = false;
        // The ring jumps to the thumb (no transition on the way in).
        const r = hit.getBoundingClientRect();
        const cx = Math.max(RING / 2, Math.min(HIT - RING / 2, t.clientX - r.left));
        const cy = Math.max(RING / 2, Math.min(HIT - RING / 2, t.clientY - r.top));
        base.style.transition = 'none';
        thumb.style.transition = 'none';
        base.style.transform = `translate(${cx - RING / 2 - REST}px, ${cy - (HIT - REST - RING / 2)}px)`;
        originX = t.clientX;
        originY = t.clientY;
        ringCx = r.left + cx;
        ringCy = r.top + cy;
        hapticPulse(10); // first-engage tick
        if (caption) {
          caption.remove();
          caption = null;
          try {
            localStorage.setItem('ds_move_seen', '1');
          } catch {
            /* storage blocked: the caption simply returns next visit */
          }
        }
        applyJoyTouch(t);
      },
      { passive: false },
    );
    hit.addEventListener(
      'touchmove',
      (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (joyTouchId === null) return;
        for (let i = 0; i < e.changedTouches.length; i++) {
          const t = e.changedTouches[i];
          if (t.identifier === joyTouchId) {
            applyJoyTouch(t);
            break;
          }
        }
      },
      { passive: false },
    );
    // touchcancel too: a notification shade / incoming call mid-walk fires
    // cancel, not end — without it joyState stuck non-zero and the player
    // walked on forever.
    const resetJoy = (e: TouchEvent) => {
      e.stopPropagation();
      if (joyTouchId === null) return;
      for (let i = 0; i < e.changedTouches.length; i++) {
        if (e.changedTouches[i].identifier === joyTouchId) {
          joyTouchId = null;
          engaged = false;
          clearRun();
          this.joyState.forward = 0;
          this.joyState.strafe = 0;
          // D15: the thumb eases home over 120 ms (release only; set
          // synchronously, before the move, so it is readable at once) and
          // the ring drifts back to its rest spot over 200 ms.
          thumb.style.transition = 'transform 120ms cubic-bezier(.2,.9,.3,1)';
          base.style.transition = 'transform 200ms ease-out';
          moveThumb(0, 0);
          base.style.transform = '';
          break;
        }
      }
    };
    hit.addEventListener('touchend', resetJoy);
    hit.addEventListener('touchcancel', resetJoy);

    // Action buttons: synthetic key events reuse every existing input path.
    // z-index 1650 keeps them ABOVE the dialogue panel (1600) so the touch
    // controls are never hidden behind it — the reported "keys behind the
    // dialogue" bug. Each button shows an icon + caption so its job is clear
    // without a physical key.
    // One disc recipe (D3, DA-14): the 74px box stays the hit target; inside
    // it a 72px circle (the 1px transparent border clips the fill) in the HUD
    // surface with a 2px ring in the action's accent. The 50%-alpha tints let
    // the world decide the captions' contrast: 2.04-3.6:1 over sand and sky.
    const makeButton = (
      icon: string,
      caption: string,
      bottom: string,
      code: string,
      key: string,
      ring: string,
      rightPx = 26,
      layer: 'touch-controls' | 'aux-controls' = 'touch-controls',
    ): HTMLElement => {
      const btn = document.createElement('div');
      btn.classList.add('ds-touch-ctl');
      // D15: a named button for assistive tech: 'Use (E)', 'Jump (Space)'.
      const keyName = key === ' ' ? 'Space' : key.length === 1 ? key.toUpperCase() : key;
      btn.setAttribute('role', 'button');
      btn.setAttribute(
        'aria-label',
        `${caption.charAt(0)}${caption.slice(1).toLowerCase()} (${keyName})`,
      );
      btn.innerHTML =
        `<div style="font-size:24px;line-height:1;">${icon}</div>` +
        `<div style="font-size:11px;font-weight:700;letter-spacing:0.6px;text-transform:uppercase;margin-top:2px;text-shadow:0 1px 2px rgba(0,0,0,0.6);">${caption}</div>`;
      Object.assign(btn.style, {
        position: 'absolute',
        right: `calc(var(--sar, 0px) + ${rightPx}px)`,
        bottom: `calc(var(--sab, 0px) + ${bottom})`,
        width: '74px',
        height: '74px',
        boxSizing: 'border-box',
        borderRadius: '50%',
        background: DS.hudSurface,
        backgroundClip: 'padding-box',
        border: '1px solid transparent',
        boxShadow: `inset 0 0 0 2px ${ring}, 0 3px 10px rgba(0,0,0,0.3)`,
        color: 'white',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: 'system-ui, sans-serif',
        pointerEvents: 'auto',
        touchAction: 'none',
        userSelect: 'none',
        zIndex: '1650',
      });
      const fire = (type: 'keydown' | 'keyup', repeat = false) => {
        const ev = new KeyboardEvent(type, { code, key, bubbles: true, repeat });
        window.dispatchEvent(ev);
        document.dispatchEvent(ev);
      };
      // Keepalive while held: SimpleInputManager purges keys silent for 2s
      // (phantom-key guard) and synthetic buttons have no OS auto-repeat, so
      // a held JUMP died mid-swim. Re-fire with repeat:true so edge-triggered
      // (!e.repeat) press handlers don't see it as a new press.
      let holdRepeat: number | null = null;
      btn.addEventListener(
        'touchstart',
        (e) => {
          e.preventDefault();
          e.stopPropagation();
          btn.style.transform = 'scale(0.9)';
          btn.style.filter = 'brightness(1.15)';
          hapticPulse(12);
          fire('keydown');
          if (holdRepeat === null) {
            holdRepeat = window.setInterval(() => fire('keydown', true), 700);
          }
        },
        { passive: false },
      );
      const release = (e: Event) => {
        e.stopPropagation();
        btn.style.transform = 'scale(1)';
        btn.style.filter = 'none';
        if (holdRepeat !== null) {
          window.clearInterval(holdRepeat);
          holdRepeat = null;
        }
        fire('keyup');
      };
      btn.addEventListener('touchend', release);
      btn.addEventListener('touchcancel', release);
      this.overlay.appendChild(btn);
      this.panels.registerLayer(layer, btn);
      return btn;
    };
    // Stacked bottom-right: interact (primary, lowest for thumb reach),
    // jump/swim (hold), wave.
    // D13: the chrome draws its glyphs from ui/icons.ts, not emoji.
    makeButton(icon('hand', 26), 'USE', '36px', 'KeyE', 'e', DS.ringUse).dataset.guide =
      'use-button';
    // JUMP, WAVE and the contextual DIVE, FEED and EAT have no use inside a
    // room: the 'interior' mode takes this layer out (P2-D2). USE, the
    // joystick, chat and the mic stay.
    const outdoor = (btn: HTMLElement): HTMLElement => {
      this.panels.registerLayer('outdoor-actions', btn);
      return btn;
    };
    outdoor(makeButton('⤒', 'JUMP', '124px', 'Space', ' ', DS.ringJump));
    outdoor(makeButton(icon('wave', 26), 'WAVE', '212px', 'KeyQ', 'q', DS.ringWave));
    // DIVE — touch's only route to the free dive (Shift is desktop-only).
    // Contextual like FEED/EAT: it exists only while actually SWIMMING, so a
    // walker never sees it. Gated on isSwimming(), NOT isInWater(): the
    // latter is true within 1.2u of a surface that swings +/-0.45 with the
    // waves, so a player standing at the waterline would watch it strobe.
    // SECOND COLUMN top slot, not a 4th primary row at 300px: that row put
    // its top at y≈1-16 on short-landscape phones — directly over the tier-1
    // chip row — and its preventDefault ate coin/drawer taps while swimming
    // (the exact collision the FEED comment below documents). It also sat in
    // the tappable prompt lane (bottom+300) in portrait.
    this.diveBtnEl = makeButton(
      icon('dive', 26),
      'DIVE',
      '212px',
      'ShiftLeft',
      'Shift',
      DS.ringDive,
      112,
      'aux-controls',
    );
    this.diveBtnEl.style.visibility = 'hidden';
    outdoor(this.diveBtnEl);
    // FEED goes in a SECOND COLUMN beside USE rather than extending the stack
    // to 374px: on a short landscape phone (the UI explicitly supports
    // max-height 500px) a 4th row would sit over the coin chip and the icon
    // row, and unlike those chips it captures taps.
    // FEED/EAT are 'aux-controls' AND contextual (mobile-finish pass): a
    // fresh visitor owns no feed and no meals, so a first boot on an iPhone
    // SE showed five permanent buttons for a three-action game — the FTUE
    // budget is 5-6 controls TOTAL and HUD should appear when it becomes
    // relevant. main-simple flips these via setAuxActionAvailable as
    // inventory changes; visibility (not display) so PanelManager's layer
    // display toggling and this contextual gate never fight over one prop.
    this.feedBtnEl = makeButton(
      icon('feed', 26),
      'FEED',
      '36px',
      'KeyF',
      'f',
      DS.ringFeed,
      112,
      'aux-controls',
    );
    // EAT stacks over FEED in the second column (124px over 36px, same 112 inset)
    this.eatBtnEl = makeButton(
      icon('eat', 26),
      'EAT',
      '124px',
      'KeyG',
      'g',
      DS.ringEat,
      112,
      'aux-controls',
    );
    this.feedBtnEl.style.visibility = 'hidden';
    this.eatBtnEl.style.visibility = 'hidden';
    outdoor(this.feedBtnEl);
    outdoor(this.eatBtnEl);

    // Proximity chat: 💬 opens the text input, 🎤 is press-hold-to-talk.
    // Stacked above the joystick (which spans bottom 26–136px here) so
    // neither control overlaps it.
    const chatBtn = document.createElement('div');
    chatBtn.innerHTML = icon('chat', 22);
    chatBtn.classList.add('ds-aux-disc');
    Object.assign(chatBtn.style, {
      ...SimpleUI.AUX_DISC,
      left: 'calc(var(--sal, 0px) + 26px)',
      // 174, not 152: the joystick's INVISIBLE hit square is 166px tall from
      // the bottom edge, so 152 put the lower 14px of this button inside it
      // (measured, both orientations) — a drag starting there opened chat
      // instead of moving. 166 + 8px gap.
      bottom: 'calc(var(--sab, 0px) + 174px)',
      cursor: 'pointer',
      // Match the other touch buttons: sit above the dialogue panel (1600)
      // so it isn't hidden behind (and its taps swallowed by) it mid-NPC-chat.
      zIndex: '1650',
    });
    chatBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      // Route through the app when wired: desktop's Enter path wraps chat in
      // ensureNamed (lazy one-time name ask). This button is the ONLY chat
      // entry on phones — calling openChatInput() directly skipped the gate,
      // so every mobile visitor chatted as the anonymous default forever.
      if (this.onChatOpenRequest) this.onChatOpenRequest();
      else this.openChatInput();
    });
    this.makeHudButtonAccessible(chatBtn, 'Open chat');
    this.overlay.appendChild(chatBtn);
    this.panels.registerLayer('aux-controls', chatBtn);

    const micBtn = document.createElement('div');
    this.micBtn = micBtn;
    micBtn.innerHTML = icon('mic', 22);
    micBtn.classList.add('ds-aux-disc');
    Object.assign(micBtn.style, {
      ...SimpleUI.AUX_DISC,
      // 8px above 💬 (174 + 52 + 8); short landscape moves it beside 💬
      // instead (applyResponsiveHud), clear of the shrunk radar above.
      left: 'calc(var(--sal, 0px) + 26px)',
      bottom: 'calc(var(--sab, 0px) + 234px)',
      cursor: 'pointer',
      touchAction: 'none',
      zIndex: '1650',
    });
    const micDown = (e: Event) => {
      e.preventDefault();
      this.onMicDown?.();
    };
    const micUp = (e: Event) => {
      e.preventDefault();
      this.onMicUp?.();
    };
    micBtn.addEventListener('touchstart', micDown, { passive: false });
    micBtn.addEventListener('touchend', micUp);
    // touchcancel (interrupted touch, e.g. an incoming call) and mouseleave
    // (mouse dragged/released off the button) must also release the mic —
    // otherwise it stays live until the 8s safety timer, breaking the
    // "mic only live while held" contract. micUp/stopRecording is a no-op
    // when not recording, so a stray mouseleave is harmless.
    micBtn.addEventListener('touchcancel', micUp);
    micBtn.addEventListener('mouseleave', micUp);
    micBtn.addEventListener('mousedown', micDown);
    micBtn.addEventListener('mouseup', micUp);
    // Not makeHudButtonAccessible: that activates on a synthetic *click*
    // (Enter/Space), which is wrong for a hold control — a keyboard user
    // pressing Enter would fire mic-on with no way to release it. Wire real
    // hold semantics: keydown starts (edge-triggered, ignoring OS repeat),
    // keyup stops.
    micBtn.setAttribute('role', 'button');
    micBtn.setAttribute('tabindex', '0');
    micBtn.setAttribute('aria-label', 'Hold to talk to nearby players (or hold the V key)');
    micBtn.classList.add('hud-btn'); // reuse the existing :focus-visible ring
    micBtn.addEventListener('keydown', (e) => {
      if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) {
        e.preventDefault();
        this.onMicDown?.();
      }
    });
    micBtn.addEventListener('keyup', (e) => {
      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        this.onMicUp?.();
      }
    });
    this.overlay.appendChild(micBtn);
    this.panels.registerLayer('aux-controls', micBtn);
  }

  private feedBtnEl: HTMLElement | null = null;
  private eatBtnEl: HTMLElement | null = null;
  private diveBtnEl: HTMLElement | null = null;
  /**
   * Contextual FEED/EAT (mobile-finish): the buttons exist only while the
   * action is actually possible (owns feed / owns meals). Uses visibility so
   * it composes with PanelManager's display-based layer hiding. Desktop is
   * untouched — these buttons are touch-only to begin with.
   */
  setAuxActionAvailable(kind: 'feed' | 'eat' | 'dive', available: boolean): void {
    const el = kind === 'feed' ? this.feedBtnEl : kind === 'eat' ? this.eatBtnEl : this.diveBtnEl;
    if (el) el.style.visibility = available ? '' : 'hidden';
  }

  /**
   * Show loading screen with progress
   */
  showLoading(progress: number): void {
    this.loaderEverShown = true; // toasts now wait out the intro (introHold)
    if (!this.loadingDiv) {
      // FULLSCREEN opaque backdrop: the first frames can render before the
      // camera is placed (degenerate inside-the-planet views) — nothing
      // behind the loader may ever be visible.
      this.loadingDiv = document.createElement('div');
      Object.assign(this.loadingDiv.style, {
        position: 'absolute',
        inset: '0',
        width: '100%',
        height: '100%',
        background: '#0a121c',
        color: 'white',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        textAlign: 'center',
        pointerEvents: 'auto',
        zIndex: '3000',
        transition: 'opacity 0.45s ease',
      });
      this.overlay.appendChild(this.loadingDiv);
    }

    // Built ONCE. Re-writing innerHTML on every progress call (as before) threw
    // away the bar's CSS transition each time, so it jumped instead of filling.
    if (!this.loadingBar) {
      // The orbiting moon + planet pulse are CSS transform keyframes on
      // will-change layers: the compositor keeps them moving through the long
      // synchronous world-generation block that freezes the JS-driven bar —
      // WITHOUT them the whole screen sits dead for seconds on phones and
      // reads as a hang.
      this.loadingDiv.innerHTML = `
        <style>
          @keyframes ld-spin { to { transform: rotate(360deg); } }
          @keyframes ld-pulse { 0%,100% { transform: scale(1); } 50% { transform: scale(1.06); } }
        </style>
        <div style="display:flex;flex-direction:column;align-items:center;max-width:320px;padding:0 24px;">
          <div style="position:relative;width:104px;height:104px;margin-bottom:18px;">
            <div id="ld-planet" style="position:absolute;inset:14px;border-radius:50%;
                 background:radial-gradient(circle at 34% 30%, #7fc96b 0 38%, #4e9e57 38% 52%, #2f7fbf 52% 100%);
                 box-shadow:0 0 22px rgba(80,170,220,0.32), inset -8px -10px 20px rgba(0,0,0,0.45);
                 will-change:transform;animation:ld-pulse 2.6s ease-in-out infinite;"></div>
            <div id="ld-orbit" style="position:absolute;inset:0;will-change:transform;animation:ld-spin 1.8s linear infinite;">
              <div style="position:absolute;top:0;left:50%;width:9px;height:9px;margin-left:-4.5px;
                   border-radius:50%;background:#cfe4f7;box-shadow:0 0 10px rgba(160,200,240,0.8);"></div>
            </div>
          </div>
          <div style="font-family:var(--font-display, 'Bebas Neue', sans-serif);font-size:min(48px,12vw);line-height:1.05;letter-spacing:1.5px;">
            DIGISCALABILITY LIFE ISLAND</div>
          <div style="color:#a9bdd4;font-size:13px;margin-top:6px;max-width:290px;">
            Abbas Ali's hand-built 3D portfolio — a living 3D world where
            ${Object.keys(AI_NPCS).length} villagers talk through Claude Haiku 4.5.</div>
          <div id="ld-msg" style="color:#8fa6bd;font-size:13px;margin:8px 0 16px;min-height:16px;"></div>
          <div style="width:230px;height:7px;background:rgba(255,255,255,0.12);border-radius:6px;overflow:hidden;">
            <div id="ld-bar" style="width:0%;height:100%;border-radius:6px;
                 background:linear-gradient(90deg,#4CAF50,#7fd18b);transition:width 0.35s ease;"></div>
          </div>
          <div id="ld-pct" style="color:#6e8298;font-size:12px;margin-top:8px;">0%</div>
          ${
            document.getElementById('boot-fallback')
              ? `<button id="ld-skip" type="button" style="margin-top:18px;padding:10px 16px;border-radius:999px;
                  border:1px solid rgba(255,255,255,0.22);background:rgba(255,255,255,0.06);color:#cfe0ff;
                  font-family:inherit;font-size:14px;font-weight:600;cursor:pointer;">Quick version (no 3D) →</button>`
              : ''
          }
        </div>`;
      // 48px, not 25: on a cold desktop load the big static loader title is
      // replaced before it ever paints, so this title is the first large text
      // and must outsize the welcome paragraph, or LCP lands on that paragraph
      // ~15 s in (a PageSpeed lab artefact; phones already were fine). 12vw
      // caps it on narrow phones: before Bebas Neue arrives, the fallback
      // font's unbreakable "DIGISCALABILITY" measured 384px at 48px.
      this.loadingBar = this.loadingDiv.querySelector('#ld-bar');
      this.loadingPct = this.loadingDiv.querySelector('#ld-pct');
      this.loadingMsg = this.loadingDiv.querySelector('#ld-msg');
      this.loadingDiv
        .querySelector('#ld-skip')
        ?.addEventListener('click', () => this.openQuickVersion());
      // World generation is a single long synchronous stretch with no progress
      // events inside it, so a bar pinned to real milestones sits dead for
      // ~15s and reads as a hang. This eases toward the target and, once
      // caught up, creeps a little further so it always looks alive.
      this.loadingTimer = window.setInterval(() => {
        const ceiling = Math.min(this.loadingTarget + 7, 99);
        this.loadingShown += (ceiling - this.loadingShown) * 0.06;
        if (this.loadingBar) this.loadingBar.style.width = `${this.loadingShown.toFixed(1)}%`;
        if (this.loadingPct) this.loadingPct.textContent = `${Math.round(this.loadingShown)}%`;
      }, 120);
    }
    this.loadingTarget = Math.max(this.loadingTarget, Math.max(0, Math.min(100, progress)));
    if (this.loadingMsg) {
      const msg =
        this.loadingTarget < 55
          ? 'Waking the island…'
          : this.loadingTarget < 90
            ? 'Raising the mountains and filling the sea…'
            : this.loadingTarget < 100
              ? 'Planting trees and lighting the lamps…'
              : 'Ready';
      this.loadingMsg.textContent = msg;
    }
    if (this.loadingTarget >= 100) {
      this.loadingShown = 100;
      if (this.loadingBar) this.loadingBar.style.width = '100%';
      if (this.loadingPct) this.loadingPct.textContent = '100%';
    }
  }

  private loadingBar: HTMLElement | null = null;
  private loadingPct: HTMLElement | null = null;
  private loadingMsg: HTMLElement | null = null;
  private loadingTarget = 0;
  private loadingShown = 0;
  private loadingTimer = 0;

  /**
   * Hide loading screen (fades the backdrop out over the arriving scene)
   */
  hideLoading(): void {
    if (this.loadingTimer) {
      clearInterval(this.loadingTimer);
      this.loadingTimer = 0;
    }
    if (this.loadingDiv) {
      this.loaderHiddenAt = Date.now();
      const el = this.loadingDiv;
      // Blank the CSS planet + orbiting moon BEFORE the fade. The loader is
      // opaque and fades out (0.45s) ON TOP of the already-running 3D fly-in, so
      // its planet-shaped graphic crossfades over the real planet flying in
      // behind it — a transient "double planet" at the reveal (a confirmed
      // secondary contributor to the reported doubling). Removing them makes the
      // fade a plain dark-to-scene wipe with nothing planet-shaped to double
      // against; it also stops two will-change CSS animations compositing over
      // the heaviest frames.
      el.querySelector('#ld-planet')?.remove();
      el.querySelector('#ld-orbit')?.remove();
      this.loadingDiv = null;
      this.loadingBar = null;
      this.loadingPct = null;
      this.loadingMsg = null;
      el.style.opacity = '0';
      window.setTimeout(() => el.remove(), 500);
    }
  }

  isLoadingVisible(): boolean {
    return this.loadingDiv !== null;
  }

  /** What #bf-reason says while the quick version is open on purpose. */
  private static readonly QUICK_REASON = 'and it is waiting behind this card.';

  /**
   * The loader's way out: index.html's #boot-fallback card (who, the work,
   * the contact links), opened on purpose, with a Back button. Loading goes
   * on behind it. World generation is one long synchronous task, so a tap
   * made during it lands when it ends; no yields were added to world gen
   * (they would move the seeded build).
   */
  private openQuickVersion(): void {
    const card = document.getElementById('boot-fallback');
    if (!card) return;
    track('loader_skip', { waited_s: Math.round(performance.now() / 1000) });
    // The card's stock wording is for a browser that CAN'T run the island.
    const why = document.getElementById('bf-reason');
    if (why) {
      why.dataset.stock ??= why.textContent ?? '';
      why.textContent = SimpleUI.QUICK_REASON;
    }
    const retry = document.getElementById('bf-retry');
    if (retry) retry.hidden = true; // "Try again" reloads: wrong here
    let back = document.getElementById('bf-back');
    if (!back) {
      back = document.createElement('button');
      back.id = 'bf-back';
      (back as HTMLButtonElement).type = 'button';
      back.textContent = '← Back to the island';
      back.className = 'ds-press';
      back.style.cssText =
        `padding:10px 22px;border-radius:10px;border:none;background:${DS.primary};` +
        'color:#fff;font-family:inherit;font-size:15px;font-weight:700;cursor:pointer;';
      back.addEventListener('click', () => {
        // The boot guard rewrites the reason if the island failed while this
        // card was up: there is nothing to go back to, so start over.
        if (why && why.textContent !== SimpleUI.QUICK_REASON) {
          window.location.reload();
          return;
        }
        this.closeQuickVersion();
      });
      if (retry?.parentElement) retry.parentElement.insertBefore(back, retry);
      else (card.firstElementChild ?? card).appendChild(back);
    }
    card.hidden = false;
    back.focus();
  }

  /** Close the quick version and put the card back as index.html wrote it
   *  (main-simple's init-failure path reuses the card with its own wording). */
  public closeQuickVersion(): void {
    const back = document.getElementById('bf-back');
    if (!back) return; // not opened from the loader
    back.remove();
    const why = document.getElementById('bf-reason');
    if (why?.dataset.stock !== undefined) {
      why.textContent = why.dataset.stock;
      delete why.dataset.stock;
    }
    const retry = document.getElementById('bf-retry');
    if (retry) retry.hidden = false;
    const card = document.getElementById('boot-fallback');
    if (card) card.hidden = true;
  }

  /**
   * Show welcome message
   */
  showWelcome(awayDelta?: AwayDelta | null): void {
    this.welcomeArgs = awayDelta;
    this.welcomeParked = false;
    // The first door's panel and veil, laid out in idle time behind the card.
    this.prewarmZonePanel();
    if (!this.welcomeDiv) {
      this.welcomeDiv = document.createElement('div');
      Object.assign(this.welcomeDiv.style, {
        position: 'absolute',
        top: '50%',
        left: '50%',
        transform: 'translate(-50%, -50%)',
        // Opaque (D9): at 0.9 the Mayor's bubble and his pin read through
        // the card on a phone, where it covers the plaza.
        background: 'rgb(8, 10, 16)',
        color: 'white',
        padding: '22px',
        borderRadius: '15px',
        textAlign: 'center',
        pointerEvents: 'auto',
        width: 'min(400px, calc(100vw - 32px))',
        maxHeight: 'calc(100dvh - 32px)',
        overflowY: 'auto',
      });
      this.welcomeDiv.setAttribute('role', 'dialog');
      this.welcomeDiv.setAttribute('aria-modal', 'true');
      this.welcomeDiv.setAttribute('aria-label', 'Welcome to DigiScalability Life Island');
      // Above the touch buttons' 1650: on the SE audit the welcome (z:auto)
      // rendered UNDER five z1650 buttons that stole its taps. Belt to the
      // layer-hiding braces below — desktop dims layers instead of hiding.
      this.welcomeDiv.style.zIndex = '1655';
      this.overlay.appendChild(this.welcomeDiv);
    }

    // THE onboarding surface routes through PanelManager like every other
    // panel — this was one of only two surfaces that bypassed it, so the
    // touch policy that clears the HUD for panels never ran at the single
    // most crowded moment of the whole product (fresh boot on a phone:
    // welcome + minimap + chips + 7 touch controls + pills, 9 surfaces).
    // A stray tap on the scrim closes the card without burning ds_welcomed
    // (FM-06: an outside tap on a phone used to spend the pitch unread); the
    // sweep and every explicit choice still persist. The card takes focus
    // itself (tabIndex -1, below), so Space and Enter do nothing on a fresh
    // card and the first Tab reaches the Hiring pill (FM-02).
    const card = this.welcomeDiv;
    this.panels.open('welcome', {
      kind: 'modal',
      hides: ['nav-chips', 'touch-controls', 'aux-controls', 'ambient-info'],
      close: (reason) => this.hideWelcome(reason !== 'scrim'),
      ownEscape: true, // welcome keeps its own Escape listener below
      history: false, // the landing card: Back from it leaves, as before
      el: card,
      initialFocus: () => card,
    });
    this.stepHintAside(true);

    trackOnce('welcome_shown');

    // Returning visitors get a brief hello; first-timers get the pitch + CTAs.
    //
    // GUARDED, and it is not paranoia: this was the ONE bare localStorage read
    // left in this file (16 of 17 siblings already catch). On iOS Safari with
    // "Block All Cookies" it throws SecurityError HERE — after the card has
    // been appended and panels.open() has raised the scrim and hidden the
    // touch controls, but BEFORE innerHTML fills the card and before the
    // Escape listener is attached. The visitor got a dimmed screen with an
    // empty black box, no controls, and no Escape; and because welcomeDiv
    // stayed non-null, isWelcomeVisible() gated out movement, camera, jump and
    // interaction for the whole session. Default to the FULL pitch: showing a
    // returning visitor the pitch twice is a far cheaper failure than bricking
    // a first-time one.
    let returning = false;
    try {
      returning = localStorage.getItem('ds_welcomed') === '1';
    } catch {
      /* storage blocked — show the full pitch */
    }
    // Every card button is a 44px thumb target on touch (phone.cjs: the
    // Hiring pill measured 40 and Explore 42).
    const tap = this.isTouch ? 'min-height:44px;' : '';
    // A phone on its side (height 500 or less): the card drops the villager
    // line and tightens its padding, so Explore is on screen without a scroll
    // (at 844x390 the full card was 68 px taller than the screen).
    const compact = window.innerHeight <= 500;
    this.welcomeDiv.style.padding = compact ? '14px 22px' : '22px';

    // The card says less (D9, FM-11): one filled primary, two outline CTAs,
    // a neutral way in, and the rest behind one disclosure. The controls line
    // and the compass footnote are gone: First steps teaches both, a step at
    // a time, once the card closes (A6).

    // The recruiter pill is the card's ONE filled primary, in the indigo
    // (decision 2 covers the HUD pill, not this card): full width, 15 px/700,
    // 46 px tall. Same data-recruit contract. It opens the HIRE CARD at once
    // (showHireCard); the highlights tour is a secondary button inside it.
    const recruiterPill = `
      <button data-recruit class="ds-press" style="width:100%; min-height:46px; box-sizing:border-box; padding:10px 14px; margin:0 0 10px;
        border:none; border-radius:10px; background:${DS.primary}; color:#fff; font-size:15px; font-weight:700; cursor:pointer;">
        📄 Hiring? CV, experience and contact</button>`;

    // The work and the contact path, as outlines: a recruiter who won't
    // explore still reaches everything in one click.
    const outline =
      'background:rgba(76,91,224,0.14); color:#fff; border:1px solid rgba(143,155,255,0.8);';
    const ctaRow = `
      <div style="display:flex; gap:10px; flex-wrap:wrap; justify-content:center; margin:0 0 10px;">
        <button data-cta="projects" style="flex:1 1 140px; ${tap}padding:12px 14px; border-radius:10px;
          ${outline} font-size:15px; font-weight:600; cursor:pointer;">
          🚀 See the work</button>
        <button data-cta="contact" style="flex:1 1 140px; ${tap}padding:12px 14px; border-radius:10px;
          ${outline} font-size:15px; font-weight:600; cursor:pointer;">
          📬 Get in touch</button>
      </div>`;

    // Explicit dismiss, so the pitch stays put until the visitor chooses to
    // leave it. A NEUTRAL outline: green is Work with me's alone, and the
    // filled primary is the Hiring pill's. A returning visitor who left First
    // steps unfinished is told how much of it is left.
    const stepsLeft = returning ? this.guideStepsLeft() : null;
    const exploreLabel =
      stepsLeft === null
        ? '🧭 Explore the island →'
        : `🧭 Explore (${stepsLeft} quick step${stepsLeft === 1 ? '' : 's'} left)`;
    const exploreBtn = `
      <button data-dismiss="1" style="width:100%; ${tap}padding:11px 14px; margin:0 0 10px; border-radius:10px;
        background:rgba(38,38,51,0.5); color:#fff; border:1px solid rgba(255,255,255,0.28); font-size:15px; font-weight:600; cursor:pointer;">
        ${exploreLabel}</button>`;

    // The three guided experiences (meet a villager, the full tour, a race)
    // wait behind one disclosure: seven same-weight buttons was choice
    // overload. Same data-* analytics contracts; 44 px targets on touch.
    const chipPad = this.isTouch ? `${tap}padding:12px 8px;` : 'padding:8px 8px;';
    const chip =
      'border-radius:10px; background:rgba(38,38,51,0.5); color:#dfe6f2; border:1px solid rgba(255,255,255,0.16); font-size:13px; cursor:pointer;';
    const secondaryRow = `
      <button type="button" data-more aria-expanded="false" aria-controls="wlc-more" style="${tap}padding:6px 10px; margin:0;
        background:none; border:none; color:#b9c6da; font-size:13px; cursor:pointer;">
        More ways to explore ▾</button>
      <div id="wlc-more" hidden style="gap:8px; margin:6px 0 0;">
        <button data-meet-ai="1" style="flex:1; ${chipPad} ${chip}">💬 Ask the townsfolk</button>
        <button data-tour="1" style="flex:1; ${chipPad} ${chip}">🎬 Full tour</button>
        <button data-race="1" style="flex:1; ${chipPad} ${chip}">🏁 Try a race</button>
      </div>`;

    // "While you were away": the living world's deltas, so a return visit is
    // GREETED with what changed rather than the same static card. Weather
    // glyph + headline are whatever's cached; the guestbook count patches in
    // asynchronously below.
    const WGLYPH: Record<string, string> = { rain: '🌧️', snow: '❄️', cloudy: '⛅', clear: '☀️' };
    const awayHtml = awayDelta
      ? `<div style="margin:0 0 12px; padding:10px 12px; border-radius:10px;
           background:rgba(80,130,255,0.10); border:1px solid rgba(120,160,255,0.25);
           font-size:13px; line-height:1.55; text-align:left;">
           <div style="font-weight:600; color:#8a9bff; margin-bottom:2px;">While you were away (${awayDelta.daysAway}d)</div>
           ${awayDelta.editions > 0 ? `📰 ${awayDelta.editions} new edition${awayDelta.editions > 1 ? 's' : ''} of the Island Times<br>` : ''}
           ${awayDelta.headline ? `🏝️ ${this.escapeHtml(awayDelta.headline)} ${awayDelta.weather ? (WGLYPH[awayDelta.weather] ?? '') : ''}<br>` : ''}
           <span id="wlc-gb">✍️ checking the guestbook…</span>
         </div>`
      : '';
    // The way to every control, on both cards (D8): a 13 px text link, not a
    // fifth button. The card steps aside for the sheet and comes back after.
    const stripTap = this.isTouch
      ? 'display:inline-flex; align-items:center; justify-content:center; min-height:44px; min-width:44px;'
      : '';
    const controlsStrip = `
      <p data-controls-strip style="margin:8px 0 0; font-size:13px; line-height:1.4; color:#aab6c8;">
        <a href="#controls" data-controls style="color:#c9d4ff; text-decoration:underline; ${stripTap}">Controls &amp; settings</a>${
          this.isTouch
            ? ''
            : ' (press <kbd style="font:inherit; padding:0 5px; border:1px solid rgba(255,255,255,0.3); border-radius:4px;">?</kbd>)'
        }</p>`;
    // The returning card shows progress (D9): the passport, stamp by stamp.
    const progressHtml = this.passportProgressLine();
    // The returning card is a HELLO, not a menu: progress + delta + the
    // Hiring pill + the two CTAs + an explicit way in. The guided chips stay
    // on the first-run card (a returning visitor already knows they exist).
    // The card never auto-closes, so Explore is the obvious way out.
    // The title is the page's h1 (axe: no level-one heading), sized as the
    // h2 it replaced.
    this.welcomeDiv.innerHTML = returning
      ? `<h1 style="margin: 0 0 12px 0; font-family: var(--font-display, 'Bebas Neue', sans-serif); font-weight: 400; font-size: 40px; line-height: 1.05; letter-spacing: 0.5px; color: #4CAF50;">👋 Welcome back!</h1>
         ${progressHtml}
         ${awayHtml}
         ${recruiterPill}
         ${ctaRow}
         ${exploreBtn}
         ${controlsStrip}`
      : `
      <h1 style="margin: 0 0 8px 0; font-family: var(--font-display, 'Bebas Neue', sans-serif); font-weight: 400; font-size: 40px; line-height: 1.05; letter-spacing: 0.5px; color: #4CAF50;">DigiScalability Life Island</h1>
      <p style="margin: 0 0 10px 0; font-size:15px; line-height:1.5;">
        I'm <strong>Abbas</strong> — I build AI products end to end, and this island is my
        portfolio. Walk up to a district to open it, or jump straight there below.</p>
      ${
        compact
          ? ''
          : `<p data-ai-line style="margin: 0 0 14px 0; font-size:14px; line-height:1.5; color:#cdd6e4;">
        ${Object.keys(AI_NPCS).length} villagers talk through <strong>Claude Haiku 4.5</strong> —
        walk up and ask them anything.</p>`
      }
      ${recruiterPill}
      ${ctaRow}
      ${exploreBtn}
      ${secondaryRow}
      ${controlsStrip}
    `;
    this.welcomeDiv.querySelector('a[data-controls]')?.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.showControls('welcome');
    });
    // The disclosure: the three guided ways in, shown on request.
    const more = this.welcomeDiv.querySelector<HTMLButtonElement>('button[data-more]');
    const moreRow = this.welcomeDiv.querySelector<HTMLElement>('#wlc-more');
    more?.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!moreRow) return;
      const open = moreRow.hidden;
      moreRow.hidden = !open;
      moreRow.style.display = open ? 'flex' : 'none';
      more.setAttribute('aria-expanded', String(open));
      more.textContent = open ? 'More ways to explore ▴' : 'More ways to explore ▾';
    });

    // Dismiss only on an explicit choice — a CTA, the Explore button, or
    // Escape. The old "any key / click-outside" dismiss evaporated the pitch
    // the instant a visitor pressed W to move. (A scrim tap closes it too,
    // without persisting: see the panels.open above.)
    const onEscape = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') closeWelcome();
    };
    const closeWelcome = () => {
      this.hideWelcome();
      document.removeEventListener('keydown', onEscape);
    };
    this.welcomeEscape = onEscape; // hideWelcome drops it on any other close

    // Move focus INTO the dialog: aria-modal was set but focus never
    // followed, so keyboard/screen-reader users started outside their own
    // welcome card. The dialog itself, not 'See the work': a focused button
    // made Space or Enter open Projects on a card whose own line says
    // 'space to jump' (FM-02). PanelManager traps Tab inside it.
    this.welcomeDiv.tabIndex = -1;
    this.welcomeDiv.focus();

    // A CTA that opens a panel (or the tour) skips the compass hint: the
    // visitor is going somewhere specific, and the hint landed on the
    // contact form. Explore keeps it; so do Ask the townsfolk and Try a
    // race, which hand the visitor to that very compass.
    this.welcomeDiv.querySelectorAll('button[data-cta]').forEach((b) => {
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        const cta = (b as HTMLElement).dataset.cta!;
        track('welcome_cta', { cta });
        this.skipCompassHint = true;
        closeWelcome();
        this.showZonePanel({ id: cta, name: cta }, { source: 'cta' });
      });
    });
    this.welcomeDiv.querySelector('button[data-dismiss]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      track('welcome_cta', { cta: 'explore' });
      closeWelcome();
    });
    this.welcomeDiv.querySelector('button[data-meet-ai]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      track('welcome_cta', { cta: 'meet_ai' });
      closeWelcome();
      this.onMeetAi?.();
    });
    this.welcomeDiv.querySelector('button[data-tour]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      track('welcome_cta', { cta: 'tour' });
      this.skipCompassHint = true;
      closeWelcome();
      this.onTour?.();
    });
    this.welcomeDiv.querySelector('button[data-recruit]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      // 'hire', not the old 'recruit': the pill now opens the hire card, and
      // the dashboard must not merge it with the tour's historical clicks.
      track('welcome_cta', { cta: 'hire' });
      this.skipCompassHint = true;
      closeWelcome();
      this.showHireCard('cta');
    });
    this.welcomeDiv.querySelector('button[data-race]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      track('welcome_cta', { cta: 'race' });
      this.raceGuided = true;
      closeWelcome();
      this.onRaceGuide?.();
    });

    document.addEventListener('keydown', onEscape);
    // No auto-close on the returning card any more. It closed itself after
    // 2.6 s (7 s with a delta) unless hovered, and it now carries the Hiring
    // pill: a recruiter coming back for the CV lost the one-click path before
    // reaching for it. It closes by choice only — Explore, Escape or any CTA.
    // Patch the guestbook line in when the async count lands (line vanishes on
    // failure/zero — never show a broken stat).
    if (awayDelta) {
      void awayDelta.guestbookSince.then((n) => {
        const el = this.welcomeDiv?.querySelector('#wlc-gb');
        if (!el) return;
        if (n != null && n > 0) {
          el.textContent = `✍️ ${n} traveller${n > 1 ? 's' : ''} signed the guestbook`;
        } else {
          (el as HTMLElement).style.display = 'none';
        }
      });
    }
  }

  /**
   * Push-to-talk recording indicator: a pulsing red dot + elapsed seconds +
   * a progress bar toward the max clip length. Driven by Chat's REAL start/stop
   * callbacks, so it appears only while the mic is genuinely live (never during
   * a permission prompt or after a denial).
   */
  showRecordingIndicator(): void {
    if (!this.recordingDiv) {
      const div = document.createElement('div');
      div.setAttribute('role', 'status');
      div.setAttribute('aria-live', 'assertive');
      Object.assign(div.style, {
        position: 'absolute',
        left: '50%',
        // Own row in the bottom-centre lane (see toast): clears the chat input
        // (96) and interaction prompt (100) it used to sit exactly on top of.
        bottom: 'calc(var(--sab, 0px) + 200px)',
        transform: 'translateX(-50%)',
        background: 'rgba(20,0,0,0.82)',
        color: '#fff',
        padding: '8px 14px',
        borderRadius: '999px',
        fontSize: '13px',
        fontFamily: 'system-ui, sans-serif',
        fontWeight: '600',
        display: 'flex',
        alignItems: 'center',
        gap: '9px',
        pointerEvents: 'none',
        zIndex: '1750',
        border: '1px solid rgba(255,90,90,0.5)',
        boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
      });
      div.innerHTML = `
        <span class="rec-dot" style="width:10px;height:10px;border-radius:50%;background:#ff4d4d;box-shadow:0 0 8px #ff4d4d;"></span>
        <span class="rec-label">Recording…</span>
        <span style="position:relative;width:52px;height:4px;border-radius:2px;background:rgba(255,255,255,0.2);overflow:hidden;">
          <span class="rec-bar" style="position:absolute;left:0;top:0;height:100%;width:0%;background:#ff6b6b;"></span>
        </span>`;
      // Pulse the dot without a stylesheet, and respect reduced-motion.
      if (!a11y.reducedMotion) {
        const dot = div.querySelector('.rec-dot') as HTMLElement | null;
        dot?.animate([{ opacity: 1 }, { opacity: 0.3 }, { opacity: 1 }], {
          duration: 900,
          iterations: Infinity,
        });
      }
      this.overlay.appendChild(div);
      this.recordingDiv = div;
    }
    const label = this.recordingDiv.querySelector('.rec-label') as HTMLElement | null;
    const bar = this.recordingDiv.querySelector('.rec-bar') as HTMLElement | null;
    const start = performance.now();
    const tick = () => {
      if (!this.recordingDiv) return;
      const elapsed = performance.now() - start;
      const frac = Math.min(1, elapsed / VOICE_MAX_MS);
      if (label) label.textContent = `Recording ${(elapsed / 1000).toFixed(1)}s`;
      if (bar) bar.style.width = `${(frac * 100).toFixed(0)}%`;
      this.recordingRaf = requestAnimationFrame(tick);
    };
    this.recordingRaf = requestAnimationFrame(tick);
  }

  hideRecordingIndicator(): void {
    if (this.recordingRaf) {
      cancelAnimationFrame(this.recordingRaf);
      this.recordingRaf = 0;
    }
    if (this.recordingDiv) {
      this.recordingDiv.remove();
      this.recordingDiv = null;
    }
  }

  /**
   * Hide welcome message
   */
  /** @param persist false ONLY for page teardown — see dispose(). Every other
   *  caller is a real dismissal and must burn the key. */
  hideWelcome(persist = true): void {
    if (this.welcomeEscape) {
      document.removeEventListener('keydown', this.welcomeEscape);
      this.welcomeEscape = null;
    }
    if (this.welcomeDiv) {
      this.welcomeDiv.remove();
      this.welcomeDiv = null;
      this.welcomeClosedAt = Date.now();
      this.panels.notifyClosed('welcome'); // no-op during a sweep
      // TEARDOWN IS NOT DISMISSAL. beforeunload -> dispose() -> hideWelcome()
      // used to burn ds_welcomed for a visitor who closed the tab while the
      // card was still on screen, unread. They came back to the trimmed
      // "Welcome back!" branch and permanently lost the pitch, the secondary
      // CTA row and the one-time compass hint (the Hiring pill is now on both
      // cards). On a portfolio, first-visit bounce is most of the
      // traffic, so this was burning the pitch for the majority of visitors.
      // Same class as the featured toast that fired under the opaque loader
      // and burned its key unseen (see the toast queue notes above).
      if (!persist) return;
      let wasFirstEver = false;
      try {
        wasFirstEver = !localStorage.getItem('ds_welcomed');
        localStorage.setItem('ds_welcomed', '1');
      } catch {
        /* full welcome every visit */
      }
      // The FIRST post-welcome moment belongs to orientation, not economy —
      // it used to belong to nothing (the "Today's special" fish-price toast
      // was the first text a fresh visitor read). One toast, once ever,
      // naming the one persistent wayfinding surface. The toast queue defers
      // under the welcome/loader, so this lands the second the island shows.
      // Copy says "tap" only: works as click on desktop, no key names.
      // skipCompassHint: closed by a CTA that opens a panel or the tour (see
      // showWelcome). It is a field, not a parameter: the signature above is
      // pinned by the teardown test.
      const skipHint = this.skipCompassHint;
      this.skipCompassHint = false;
      // It stands down once First steps arms (A6 teaches the compass and fires
      // this hint itself on Skip), once the visitor opens the map, or when a
      // race guide already put the compass to work (CO-D2: on a phone it
      // stacked on the start-line message).
      try {
        if (wasFirstEver && !skipHint && !localStorage.getItem('ds_hint_compass')) {
          localStorage.setItem('ds_hint_compass', '1');
          this.toast('🧭 The gold ➤ up top points to your next stop — tap it for the island map.', {
            hint: true,
            until: () => this.guideArmed() || this.compassPillUsed || this.raceGuided,
          });
        }
      } catch {
        /* no storage — skip the one-time hint rather than repeat it forever */
      }
    }
  }

  /**
   * First steps' quick steps still to do, for the returning card's Explore
   * (D9): read from ds_guide_v1 = {v:1, done[], finished, skipped, t}, which
   * package A's guide writes. Null when there is nothing to say: the key is
   * absent or unparseable, or the guide was finished or skipped.
   */
  private guideStepsLeft(): number | null {
    try {
      const raw = localStorage.getItem(GUIDE_KEY);
      if (!raw) return null;
      const save = JSON.parse(raw) as {
        v?: unknown;
        done?: unknown;
        finished?: unknown;
        skipped?: unknown;
      } | null;
      if (!save || save.v !== 1 || !Array.isArray(save.done)) return null;
      if (save.finished === true || save.skipped === true) return null;
      const done = new Set(
        save.done.filter((s): s is GuideStep => (GUIDE_STEPS as readonly unknown[]).includes(s)),
      );
      const left = GUIDE_STEPS.length - done.size;
      return left > 0 ? left : null;
    } catch {
      return null; // no storage, or not JSON
    }
  }

  /** The returning card's passport line (D9): how far, and what is left.
   *  Empty before the passport is wired (setPassport). */
  private passportProgressLine(): string {
    const pp = this.passport;
    if (!pp) return '';
    const left = PASSPORT_ZONES.filter((z) => !pp.has(z)).map((z) => PASSPORT_META[z].label);
    const text = pp.isComplete()
      ? '🛂 Passport complete — every district stamped 👑'
      : left.length === PASSPORT_ZONES.length
        ? `🛂 Passport: no stamps yet — ${left.join(', ')} to visit`
        : `🛂 Passport: ${pp.count()} of ${pp.total()} stamps — ${left.join(', ')} to go`;
    return `<p data-passport-progress style="margin:0 0 12px; font-size:14px; line-height:1.45; color:#dfe6f2;">${text}</p>`;
  }

  /** Set by a welcome CTA that opens a panel or the tour; read once by
   *  hideWelcome to skip the first-run compass hint. */
  private skipCompassHint = false;
  /** The compass pill opened the map, or a race guide set the compass: the
   *  first-run compass hint is stale (its until()). */
  private compassPillUsed = false;
  private raceGuided = false;
  /** The open card's Escape listener: a scrim tap or the sweep closes the
   *  card without it, so hideWelcome drops it. */
  private welcomeEscape: ((e: KeyboardEvent) => void) | null = null;

  /**
   * Check if welcome is visible
   */
  isWelcomeVisible(): boolean {
    // The name modal counts as blocking too, so movement/interaction stays
    // suspended (and typing your name never drives the player).
    // A card parked under the Controls sheet is still the visitor's next
    // screen: the world keeps waiting for it (D8).
    return this.welcomeDiv !== null || this.nameModalDiv !== null || this.welcomeParked;
  }

  /** Any PanelManager panel (zone card, modal, menu, sheet) open right now?
   *  The window-level Enter→chat hotkey stands down while one is. */
  isPanelOpen(): boolean {
    return this.panels.isOpen();
  }

  /**
   * First-visit name entry. Shows a centered modal; on submit it persists the
   * name and calls onDone(name). Returning visitors (saved name) skip it.
   */
  promptName(defaultName: string, onDone: (name: string) => void): void {
    const modal = document.createElement('div');
    Object.assign(modal.style, {
      position: 'absolute',
      inset: '0',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      gap: '18px',
      background: 'rgba(6,10,20,0.85)',
      pointerEvents: 'auto',
      zIndex: '3200',
      color: 'white',
      fontFamily: 'system-ui, sans-serif',
      textAlign: 'center',
      padding: '24px',
    });
    // A named dialog with a labelled field and an announced error (UX-15:
    // it had no role, the input's only name was its placeholder, and the
    // validation line was silent).
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', 'ds-name-title');
    modal.innerHTML = `
      <div id="ds-name-title" style="font-size:24px;font-weight:700;">🌎 Welcome to Life Island</div>
      <label for="ds-name-input" style="opacity:0.85;font-size:15px;max-width:320px;">What should other visitors call you?</label>
    `;
    const input = document.createElement('input');
    input.id = 'ds-name-input';
    input.type = 'text';
    input.maxLength = 20;
    input.placeholder = 'Your name';
    input.value = defaultName || '';
    Object.assign(input.style, {
      padding: '11px 14px',
      fontSize: '17px',
      borderRadius: '12px',
      border: '1px solid rgba(120,160,255,0.35)',
      background: 'rgba(255,255,255,0.1)',
      color: 'white',
      textAlign: 'center',
      width: 'min(300px, 80vw)',
      outline: 'none',
    });
    const btn = document.createElement('button');
    btn.textContent = 'Enter the island →';
    btn.className = 'ds-press';
    Object.assign(btn.style, {
      padding: '12px 26px',
      fontSize: '17px',
      fontWeight: '700',
      borderRadius: '12px',
      border: 'none',
      background: DS.primary, // the green gave white text 2.78:1
      color: 'white',
      cursor: 'pointer',
    });
    // Inline validation message (offensive / too-short names)
    const err = document.createElement('div');
    err.setAttribute('role', 'alert');
    Object.assign(err.style, {
      color: '#ff9a9a',
      fontSize: '13px',
      marginTop: '9px',
      minHeight: '16px',
    });
    let done = false;
    const submit = (): void => {
      if (done) return;
      const raw = input.value.trim() || defaultName || 'Visitor';
      // Names are shown to every other visitor — filter before they land
      const check = checkName(raw);
      if (!check.ok) {
        err.textContent = check.reason ?? 'Please pick another name.';
        input.focus();
        return;
      }
      done = true;
      modal.remove();
      this.nameModalDiv = null;
      onDone(check.name);
    };
    // stopPropagation so keystrokes (incl. WASD/Space) never reach the game
    // input handlers while the field is focused.
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') submit();
    });
    btn.addEventListener('click', submit);
    // Never a gate: browsing must not require naming yourself. Skip proceeds
    // anonymously (caller gets '' and saves nothing; main-simple's
    // ensureNamed remembers the skip for the rest of the session).
    const skip = document.createElement('button');
    skip.textContent = 'Skip — just browsing';
    Object.assign(skip.style, {
      background: 'transparent',
      border: 'none',
      color: 'rgba(255,255,255,0.65)',
      fontSize: '13px',
      textDecoration: 'underline',
      cursor: 'pointer',
      padding: '4px 12px',
      minHeight: '44px', // was a 129x23 target
    });
    skip.addEventListener('click', () => {
      if (done) return;
      done = true;
      modal.remove();
      this.nameModalDiv = null;
      onDone('');
    });
    modal.appendChild(input);
    modal.appendChild(btn);
    modal.appendChild(skip);
    modal.appendChild(err);
    this.overlay.appendChild(modal);
    this.nameModalDiv = modal;
    window.setTimeout(() => input.focus(), 60);
  }

  /**
   * Show interaction prompt
   */
  /** Has ANY proximity prompt ever shown this session? The lost-visitor
   *  recovery hint keys off its absence — an engaged player has seen dozens. */
  private promptEverShown = false;
  hasSeenInteractionPrompt(): boolean {
    return this.promptEverShown;
  }

  showInteractionPrompt(text: string): void {
    this.promptEverShown = true;
    // Called every frame while a target is in range — skip the innerHTML
    // parse/replace when the prompt hasn't changed (it changes only when the
    // TARGET changes). Cleared in hideInteractionPrompt.
    // Text plus input mode: a switch from keys to touch re-renders it (D7).
    const mode = this.getInputMode();
    if (text === this.lastPromptText && mode === this.lastPromptMode && this.interactionDiv) return;
    this.lastPromptText = text;
    this.lastPromptMode = mode;
    if (!this.interactionDiv) {
      this.interactionDiv = document.createElement('div');
      // The guide card's anchor (A6 keeps 8 px above it).
      this.interactionDiv.dataset.hud = 'prompt';
      Object.assign(this.interactionDiv.style, {
        position: 'absolute',
        // bottom/left/maxWidth come from applyPromptAnchor (breakpoint-aware,
        // and re-applied on rotation) right after this style block.
        width: 'max-content',
        background: 'rgba(0, 0, 0, 0.8)',
        color: 'white',
        padding: '10px 18px', // was 15px 25px — the prompt is a hint, not a card
        borderRadius: '22px',
        textAlign: 'center',
        pointerEvents: 'auto',
        cursor: 'pointer',
        fontSize: '14px',
        // Pop-in: created hidden/short, springs to place on the next frame
        opacity: '0',
        transform: 'translateX(-50%) translateY(10px) scale(0.9)',
        transition: 'transform 0.16s cubic-bezier(0.34, 1.56, 0.64, 1), opacity 0.16s ease',
      });
      this.applyPromptAnchor(this.interactionDiv);
      // Tap the prompt itself to trigger it — the natural phone instinct.
      // Same synthetic 'e' the USE button and dialogue panel fire, so every
      // interaction path (talk / board / sit / stand / zone) runs unchanged.
      this.interactionDiv.addEventListener('click', () => {
        for (const type of ['keydown', 'keyup'] as const) {
          const ev = new KeyboardEvent(type, { code: 'KeyE', key: 'e', bubbles: true });
          window.dispatchEvent(ev);
          document.dispatchEvent(ev);
        }
      });
      this.overlay.appendChild(this.interactionDiv);
      const el = this.interactionDiv;
      requestAnimationFrame(() => {
        el.style.opacity = '1';
        el.style.transform = 'translateX(-50%) translateY(0) scale(1)';
      });
    }

    this.interactionDiv.innerHTML = this.touchify(text, mode);
    // Read out once the text has held for 600 ms: this runs every frame while
    // a target is in range, and only a CHANGE gets this far (D6).
    if (this.promptAnnounceTimer) clearTimeout(this.promptAnnounceTimer);
    const el = this.interactionDiv;
    this.promptAnnounceTimer = window.setTimeout(() => {
      this.promptAnnounceTimer = 0;
      if (this.interactionDiv === el) this.announce(el.textContent ?? '');
    }, 600);
    // A toast already up on a phone steps above the prompt, hint or not. A
    // hint used to bow out here, and a passing villager's prompt made it
    // blink (wave-1 integration); a waiting hint still waits for the prompt
    // to go (mayShow).
    if (this.isTouch && this.toastEl && this.toastBusy) this.applyToastAnchor(this.toastEl);
  }

  private promptAnnounceTimer = 0;

  /**
   * The prompt's keys in the input in use (D7): 'Press <strong>X</strong>'
   * (any case, a keyboard-emoji prefix dropped) and '[Key]' tokens become a
   * keycap on the keyboard, and the glyph pill of the button that fires the
   * key on touch ('Tap USE', 'Hold JUMP', 'eat with EAT').
   */
  private touchify(html: string, mode: InputMode = this.getInputMode()): string {
    return promptKeysHtml(html, mode);
  }

  /**
   * Plain-text sibling of touchify, for text that is escaped into markup
   * elsewhere (the pack's hints). Toasts and flashes do not use it: they
   * render their keys as nodes when they show (renderKeyText).
   */
  private touchifyPlain(text: string): string {
    return keyTextPlain(text, this.getInputMode());
  }

  /**
   * Hide interaction prompt
   */
  hideInteractionPrompt(): void {
    this.lastPromptText = null;
    if (this.promptAnnounceTimer) {
      clearTimeout(this.promptAnnounceTimer);
      this.promptAnnounceTimer = 0;
    }
    if (this.interactionDiv) {
      this.interactionDiv.remove();
      this.interactionDiv = null;
      if (this.isTouch && this.toastEl && this.toastBusy) this.applyToastAnchor(this.toastEl);
    }
  }

  /**
   * Create FPS display
   */
  private createFPSDisplay(): void {
    // FPS is a dev readout — visitors shouldn't see it. ?debug shows it.
    const debug = new URLSearchParams(window.location.search).has('debug');
    if (debug) {
      this.fpsDiv = document.createElement('div');
      Object.assign(this.fpsDiv.style, {
        position: 'absolute',
        // Bottom-right: a dev readout has no business leading the top-right
        // column (it read as the first chip of the HUD in ?debug screenshots).
        bottom: 'calc(var(--sab, 0px) + 10px)',
        right: 'calc(var(--sar, 0px) + 10px)',
        background: 'rgba(0, 0, 0, 0.7)',
        color: 'white',
        padding: '5px 10px',
        borderRadius: '5px',
        fontSize: '12px',
        fontFamily: 'monospace',
        pointerEvents: 'none',
      });
      this.overlay.appendChild(this.fpsDiv);
      this.fpsDiv.textContent = 'FPS: --';
    }

    // Create player count display
    this.playerCountDiv = document.createElement('div');
    Object.assign(this.playerCountDiv.style, {
      ...CHIP,
      top: 'calc(var(--sat, 0px) + 12px)', // column row 1 (38px pitch)
      right: 'calc(var(--sar, 0px) + 10px)',
    });
    this.playerCountDiv.addEventListener('click', (e) => {
      e.stopPropagation();
      this.showRoster();
    });
    this.makeHudButtonAccessible(this.playerCountDiv, 'Show who is online');
    if (this.isTouch) {
      this.tierChip(this.playerCountDiv); // tier-1 row: [👥][🪙][☰]
    } else {
      this.overlay.appendChild(this.playerCountDiv);
      this.panels.registerLayer('nav-chips', this.playerCountDiv);
    }
    this.updatePlayerCount(1); // Start with 1 (self)
  }

  private rosterProvider: (() => Array<{ id: string; name: string; muted: boolean }>) | null = null;
  private onPeerMuteToggle: ((id: string) => boolean) | null = null;
  public setRosterProvider(fn: () => Array<{ id: string; name: string; muted: boolean }>): void {
    this.rosterProvider = fn;
  }
  public setOnPeerMuteToggle(fn: (id: string) => boolean): void {
    this.onPeerMuteToggle = fn;
  }

  /** The peer ids Chat persists as muted (ds_muted_peers); empty if unreadable. */
  private static savedMutedPeers(): Set<string> {
    try {
      const raw: unknown = JSON.parse(localStorage.getItem('ds_muted_peers') ?? '[]');
      return new Set(Array.isArray(raw) ? raw.map((x) => String(x)) : []);
    } catch {
      return new Set();
    }
  }

  /** Roster panel: who's on the island right now, with a per-peer mute toggle. */
  showRoster(): void {
    // Chat keeps the visitor's mutes across reloads (ds_muted_peers) and drops
    // those peers' text and voice; the provider's flag starts false on every
    // load, so a muted peer read 'Mute' here. Either source counts.
    const saved = SimpleUI.savedMutedPeers();
    const peers = (this.rosterProvider?.() ?? []).map((p) =>
      saved.has(String(p.id)) ? { ...p, muted: true } : p,
    );
    const modal = this.buildCenteredModal('min(340px, calc(100vw - 32px))', 'roster');
    let rowsHtml: string;
    if (peers.length === 0) {
      // This copy begged visitors to share for months without giving them a
      // button. The invite button below the rows is the actual invite path.
      rowsHtml = `<p style="margin:12px 0;font-size:14px;color:#aab;">You're the only one exploring right now —
        invite someone and wander together. 👋</p>`;
    } else {
      rowsHtml = peers
        .map(
          (
            p,
          ) => `<div data-peer="${this.escapeHtml(p.id)}" style="display:flex;align-items:center;justify-content:space-between;
            gap:10px;padding:10px 12px;margin:6px 0;background:rgba(255,255,255,0.04);border-radius:10px;">
            <span style="font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">👤 ${this.escapeHtml(p.name)}</span>
            <button data-mute="${this.escapeHtml(p.id)}" style="flex:0 0 auto;padding:6px 12px;border-radius:8px;border:1px solid rgba(255,255,255,0.2);
              background:${p.muted ? 'rgba(255,90,90,0.25)' : 'rgba(255,255,255,0.08)'};color:#fff;font-size:13px;cursor:pointer;">
              ${p.muted ? '🔇 Muted' : '🔊 Mute'}</button>
          </div>`,
        )
        .join('');
    }
    modal.insertAdjacentHTML(
      'beforeend',
      `<h2 style="margin:0 0 4px;color:#8a9bff;">👥 On the island (${peers.length + 1})</h2>
       <p style="margin:0 0 12px;font-size:13px;color:#aab;">Tap a name's button to mute their chat &amp; voice.</p>
       ${rowsHtml}`,
    );
    modal.querySelectorAll('button[data-mute]').forEach((b) => {
      b.addEventListener('click', () => {
        const id = (b as HTMLElement).dataset.mute!;
        const muted = this.onPeerMuteToggle?.(id) ?? false;
        (b as HTMLElement).textContent = muted ? '🔇 Muted' : '🔊 Mute';
        (b as HTMLElement).style.background = muted
          ? 'rgba(255,90,90,0.25)'
          : 'rgba(255,255,255,0.08)';
      });
    });
    const inviteRow = document.createElement('div');
    inviteRow.style.cssText = 'margin-top:12px;';
    inviteRow.appendChild(
      this.makeShareButton('💌 Invite a friend', {
        surface: 'roster',
        url: buildShareUrl(),
        title: 'DigiScalability Life Island',
        text: 'Come wander around this 3D portfolio island with me 🏝️',
      }),
    );
    modal.appendChild(inviteRow);
    trackOnce('roster_opened');
    this.overlay.appendChild(modal);
  }

  /**
   * Update FPS display
   */
  updateFPS(fps: number): void {
    if (this.fpsDiv) {
      this.fpsDiv.textContent = `FPS: ${fps.toFixed(1)}`;
    }
  }

  /**
   * Environment badge (weather · time of day · place) in the top-left.
   * Lazy-created so it only appears once the cycle reports something.
   */
  setEnvironmentBadge(text: string): void {
    if (!this.envBadgeDiv) {
      this.envBadgeDiv = document.createElement('div');
      Object.assign(this.envBadgeDiv.style, {
        position: 'absolute',
        top: 'calc(var(--sat, 0px) + 10px)',
        left: 'calc(var(--sal, 0px) + 10px)',
        background: 'rgba(0, 0, 0, 0.55)',
        color: 'white',
        padding: '5px 12px',
        borderRadius: '12px',
        fontSize: '12px',
        fontFamily: 'system-ui, sans-serif',
        pointerEvents: 'auto',
        cursor: 'pointer',
        // Never grow past the left third — keeps it clear of the centered
        // delivery pill on phones while still showing temp + time of day.
        maxWidth: 'calc(50vw - 58px)',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        // D15: a 44 px touch target on phones, as the compass pill has
        // (34 px line + 2 × 5 px padding).
        ...(this.isTouch ? { lineHeight: '34px', minWidth: '44px', boxSizing: 'border-box' } : {}),
      });
      this.envBadgeDiv.title = 'Live weather settings';
      this.envBadgeDiv.addEventListener('click', (e) => {
        e.stopPropagation();
        this.toggleWeatherPopover();
      });
      this.overlay.appendChild(this.envBadgeDiv);
      // Ambient HUD like the radar: the tour and the welcome card clear it.
      // Unregistered, it stayed under the tour's Skip button (same corner).
      this.panels.registerLayer('ambient-info', this.envBadgeDiv);
      if (this.tourSkipBtn) this.envBadgeDiv.style.visibility = 'hidden'; // born mid-tour
    }
    this.envBadgeDiv.textContent = text;
  }

  private weatherPopover: HTMLElement | null = null;
  private onWeatherConsent: ((on: boolean) => void) | null = null;
  private weatherConsentState = false;

  /** Wire the live-weather opt-in (current state + a setter). */
  setWeatherConsentHandler(current: boolean, cb: (on: boolean) => void): void {
    this.weatherConsentState = current;
    this.onWeatherConsent = cb;
  }

  /**
   * Consent popover for live weather. Location data only leaves the device
   * after an explicit opt-in here, so this is the gate — not a silent fetch.
   */
  private toggleWeatherPopover(): void {
    if (this.weatherPopover) {
      this.weatherPopover.remove();
      this.weatherPopover = null;
      return;
    }
    const pop = document.createElement('div');
    Object.assign(pop.style, {
      position: 'absolute',
      top: 'calc(var(--sat, 0px) + 42px)',
      left: 'calc(var(--sal, 0px) + 10px)',
      background: 'rgba(10, 16, 28, 0.96)',
      color: '#e6edf7',
      padding: '13px 15px',
      borderRadius: '12px',
      fontSize: '13px',
      lineHeight: '1.5',
      fontFamily: 'system-ui, sans-serif',
      maxWidth: '270px',
      pointerEvents: 'auto',
      zIndex: '1500',
      border: '1px solid rgba(255,255,255,0.14)',
    });
    const on = this.weatherConsentState;
    pop.innerHTML = `
      <div style="font-weight:700;margin-bottom:5px;">🌦️ Live weather</div>
      <div style="color:#aebbcd;margin-bottom:10px;">
        Match the island's sky to your real local weather. This shares your
        approximate location with a weather service. Day and night already follow
        your device clock — that never leaves your device.
      </div>
      <button id="wx-toggle" style="background:${on ? '#c0392b' : '#4CAF50'};color:#fff;border:none;padding:6px 12px;border-radius:8px;cursor:pointer;font-size:13px;">
        ${on ? 'Turn off' : 'Turn on'}
      </button>
      <a href="/privacy.html" target="_blank" rel="noopener" style="color:#7fb2ff;margin-left:10px;font-size:12px;">Privacy</a>
    `;
    (pop.querySelector('#wx-toggle') as HTMLButtonElement).addEventListener('click', () => {
      const next = !this.weatherConsentState;
      this.weatherConsentState = next;
      this.onWeatherConsent?.(next);
      pop.remove();
      this.weatherPopover = null;
    });
    this.overlay.appendChild(pop);
    this.weatherPopover = pop;
  }

  private coinDiv: HTMLElement | null = null;
  private _coinShown = 0; // the number the counter is currently displaying
  private _coinAnim = 0; // rAF id for the count-up tween
  /** Set by main-simple: opens the coin receipt when the HUD chip is tapped. */
  public onCoinChipClick?: () => void;
  /** Set by main-simple: routes the touch 💬 button through the same
   *  ensureNamed wrapper as desktop's Enter (lazy name ask before first chat). */
  public onChatOpenRequest?: () => void;
  private receiptDiv: HTMLElement | null = null;
  private shopDiv: HTMLElement | null = null;
  private mapCanvas: HTMLCanvasElement | null = null;

  /**
   * Minimap (top-left, under the environment badge): equirectangular
   * projection of the sphere. Zone plazas as colored dots, NPCs as amber
   * dots (gold + halo when they hold a quest), the delivery target as a
   * pulsing red dot, and the player as a white heading arrow.
   */
  /**
   * GTA-style circular radar: north-up, player fixed at the centre. Every
   * entity arrives already projected onto the player-centred tangent plane
   * (rx = +east, ry = +north, dist = 1 at the radar edge) so this method is
   * pure drawing. Objectives past the edge clamp to the ring as chevrons.
   */
  updateMinimap(data: {
    heading: number;
    npcs: Array<{ rx: number; ry: number; dist: number; hasQuest: boolean }>;
    zones: Array<{ rx: number; ry: number; dist: number; color: string; label?: string }>;
    delivery: { rx: number; ry: number; dist: number } | null;
    peers?: Array<{ rx: number; ry: number; dist: number; waving: boolean }>;
    online?: number;
  }): void {
    // Where the visitor stands, for the message queue (leftPlace).
    this.placeFix = data.zones.filter((z) => z.label !== 'Cruise').map((z) => z.dist);
    const D = 172; // square canvas (the radar disc), in CSS px
    if (!this.mapCanvas) {
      this.mapCanvas = document.createElement('canvas');
      // DPR-sized backing store (capped ×2): a 172-texel canvas CSS-scaled
      // onto a DPR-3 phone was the blurry-minimap report. All draw code stays
      // in D-space via the per-frame setTransform below.
      this.mapDpr = Math.min(window.devicePixelRatio || 1, 2);
      this.mapCanvas.width = D * this.mapDpr;
      this.mapCanvas.height = D * this.mapDpr;
      Object.assign(this.mapCanvas.style, {
        position: 'absolute',
        top: 'calc(var(--sat, 0px) + 40px)',
        left: 'calc(var(--sal, 0px) + 10px)',
        width: `${D}px`, // explicit CSS size — was attribute-implied
        maxWidth: 'calc(100vw - var(--sal, 0px) - var(--sar, 0px) - 20px)',
        height: 'auto',
        borderRadius: '50%',
        border: '2px solid rgba(255,255,255,0.28)',
        boxShadow: '0 6px 18px rgba(0,0,0,0.4)',
        pointerEvents: 'none',
      });
      this.overlay.appendChild(this.mapCanvas);
      this.panels.registerLayer('ambient-info', this.mapCanvas);
      // Expandable map: tapping the radar opens the full island map.
      this.mapCanvas.style.pointerEvents = 'auto';
      this.mapCanvas.style.cursor = 'pointer';
      this.mapCanvas.title = 'Open the island map (M)';
      this.mapCanvas.addEventListener('click', () => this.onMinimapClick?.());
      // A canvas created while already in short-landscape must adopt the
      // shrunk layout immediately (the media listener only fires on changes).
      this.applyResponsiveHud();
    }
    const ctx = this.mapCanvas.getContext('2d');
    if (!ctx) return;
    // Re-assert every frame (cheap): a stray save/restore imbalance anywhere
    // in the draw code must never silently drop the DPR transform.
    ctx.setTransform(this.mapDpr, 0, 0, this.mapDpr, 0, 0);
    const t = performance.now();
    const peers = data.peers ?? [];
    const cx = D / 2;
    const cy = D / 2;
    const R = D / 2 - 3; // radar radius
    // Text-boost when the DISPLAY is smaller than the 172px draw space
    // (applyResponsiveHud shrinks the disc to 104/120px on small phones):
    // fixed 8px fonts rendered at ~5px effective there. Geometry stays in
    // D-space; only the type grows to hold its on-screen size.
    const shownW = parseFloat(this.mapCanvas.style.width) || D;
    const ts = Math.min(1.7, Math.max(1, D / shownW));
    // normalized radar coords → screen; ry is +north so it draws UP
    const sx = (rx: number) => cx + rx * R;
    const sy = (ry: number) => cy - ry * R;

    ctx.clearRect(0, 0, D, D);

    // ── Disc: clip to the circle, then paint everything inside ──────────
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.clip();

    const bg = ctx.createRadialGradient(cx, cy, 4, cx, cy, R);
    bg.addColorStop(0, 'rgba(18, 46, 58, 0.92)');
    bg.addColorStop(1, 'rgba(6, 16, 24, 0.92)');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, D, D);

    // Range rings + N-S / E-W crosshair for orientation
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 1;
    for (const rr of [0.4, 0.72]) {
      ctx.beginPath();
      ctx.arc(cx, cy, R * rr, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.moveTo(cx, cy - R);
    ctx.lineTo(cx, cy + R);
    ctx.moveTo(cx - R, cy);
    ctx.lineTo(cx + R, cy);
    ctx.stroke();

    // clamp helper: keep off-radar objectives on the ring as a chevron
    const place = (o: { rx: number; ry: number; dist: number }) => {
      if (o.dist <= 1) return { x: sx(o.rx), y: sy(o.ry), edge: false };
      const k = 0.92 / o.dist;
      return { x: sx(o.rx * k), y: sy(o.ry * k), edge: true };
    };

    // ── District plazas: glowing beacons (clamp to ring if off-radar) ───
    // Rim labels carry the NAME too: RADAR_RANGE (1.35 rad) is narrower than
    // the 1.57 rad district spacing, so neighbouring districts are ALWAYS
    // edge-clamped — anonymous coloured dots taught nobody the island's
    // shape. In-range zones draw first, nearest first, and claim their label
    // boxes; a label whose text box would overlap one already drawn is
    // dropped (D16), so crossings never smear text over text.
    const labelBoxes: Array<{ x: number; y: number; w: number; h: number }> = [];
    // D16: every minimap label is 10.5 px/600 ON SCREEN (ts converts to the
    // 172 px draw space) with a 2 px stroke, so its cap height is >= 7 px.
    const labelFont = `600 ${(10.5 * ts).toFixed(1)}px system-ui, sans-serif`;
    const labelStroke = 2 * ts;
    // A name wider than its spot allows slides in along its row, so
    // 'Professional' near the east or west rim stays whole: the disc clips
    // whatever crosses it ('Work' never reached that far). Call with the
    // label's font set; y is the row's middle.
    const fitX = (label: string, x: number, y: number): number => {
      const half = ctx.measureText(label).width / 2 + 2;
      const reach = Math.max(
        0,
        Math.sqrt(Math.max(0, (R - 2) * (R - 2) - (y - cy) * (y - cy))) - half,
      );
      return cx + Math.max(-reach, Math.min(reach, x - cx));
    };
    const placed = data.zones
      .map((z) => ({ z, p: place(z) }))
      .sort((a, b) => Number(a.p.edge) - Number(b.p.edge) || a.z.dist - b.z.dist);
    const collides = (x: number, y: number, w: number, h: number): boolean =>
      labelBoxes.some((r) => Math.abs(r.x - x) * 2 < r.w + w && Math.abs(r.y - y) * 2 < r.h + h);
    for (const { z, p } of placed) {
      if (p.edge) {
        ctx.fillStyle = z.color;
        ctx.globalAlpha = 0.6;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 2.4, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
        if (z.label) {
          // Nudge the text toward the centre so it stays inside the disc.
          const ny = p.y + (cy - p.y) * 0.16;
          ctx.save();
          ctx.font = labelFont;
          const nx = fitX(z.label, p.x + (cx - p.x) * 0.16, ny);
          const w = ctx.measureText(z.label).width + labelStroke;
          const h = 10.5 * ts;
          if (!collides(nx, ny, w, h)) {
            labelBoxes.push({ x: nx, y: ny, w, h });
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.lineWidth = labelStroke;
            ctx.strokeStyle = 'rgba(0,0,0,0.85)';
            ctx.strokeText(z.label, nx, ny);
            ctx.fillStyle = 'rgba(255,255,255,0.85)';
            ctx.fillText(z.label, nx, ny);
          }
          ctx.restore();
        }
        continue;
      }
      ctx.save();
      ctx.shadowColor = z.color;
      ctx.shadowBlur = 8;
      ctx.fillStyle = z.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      // Name the zone under its dot. Stroked first so it stays legible over
      // both the dark disc and a bright marker.
      if (z.label) {
        ctx.save();
        ctx.font = labelFont;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.lineWidth = labelStroke;
        ctx.strokeStyle = 'rgba(0,0,0,0.85)';
        const ly = p.y + 5.5 + 5.25 * ts;
        const lx = fitX(z.label, p.x, ly);
        const lw = ctx.measureText(z.label).width + labelStroke;
        if (!collides(lx, ly, lw, 10.5 * ts)) {
          labelBoxes.push({ x: lx, y: ly, w: lw, h: 10.5 * ts });
          ctx.strokeText(z.label, lx, p.y + 5.5);
          ctx.fillStyle = 'rgba(255,255,255,0.95)';
          ctx.fillText(z.label, lx, p.y + 5.5);
        }
        ctx.restore();
      }
      ctx.strokeStyle = z.color;
      ctx.globalAlpha = 0.35;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 6.5, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // ── NPCs (only when within radar range) ─────────────────────────────
    for (const n of data.npcs) {
      if (n.dist > 1) continue;
      const x = sx(n.rx);
      const y = sy(n.ry);
      if (n.hasQuest) {
        ctx.fillStyle = '#ffd34a';
        ctx.beginPath();
        ctx.arc(x, y, 3, 0, Math.PI * 2);
        ctx.fill();
        // Quest halo: phase frozen (not hidden) under reduced motion — canvas
        // drawing is unreachable by the CSS blanket, so the gate lives here.
        const qp = a11y.reducedMotion ? 0 : Math.sin(t / 260);
        ctx.strokeStyle = `rgba(255, 211, 74, ${0.35 + 0.25 * qp})`;
        ctx.beginPath();
        ctx.arc(x, y, 5 + 1.2 * qp, 0, Math.PI * 2);
        ctx.stroke();
      } else {
        ctx.fillStyle = 'rgba(255, 190, 130, 0.8)';
        ctx.beginPath();
        ctx.arc(x, y, 1.8, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // ── Other players online: cyan blips with a soft glow ───────────────
    for (const p of peers) {
      if (p.dist > 1) continue;
      const x = sx(p.rx);
      const y = sy(p.ry);
      if (p.waving) {
        const r = 5 + ((t / 90) % 6);
        ctx.strokeStyle = `rgba(63, 224, 255, ${Math.max(0, 0.6 - r / 12)})`;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.stroke();
        ctx.lineWidth = 1;
      }
      ctx.save();
      ctx.shadowColor = '#3fe0ff';
      ctx.shadowBlur = 7;
      ctx.fillStyle = '#3fe0ff';
      ctx.beginPath();
      ctx.arc(x, y, 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.beginPath();
      ctx.arc(x, y, 1.1, 0, Math.PI * 2);
      ctx.fill();
    }

    // ── Delivery target: pulsing crosshair (edge chevron if off-radar) ──
    if (data.delivery) {
      const p = place(data.delivery);
      if (p.edge) {
        // arrow on the ring pointing outward toward the objective
        const ang = Math.atan2(p.y - cy, p.x - cx);
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(ang);
        ctx.fillStyle = '#ff5252';
        ctx.beginPath();
        ctx.moveTo(4, 0);
        ctx.lineTo(-3, -4);
        ctx.lineTo(-3, 4);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      } else {
        // Delivery crosshair: same phase-freeze as the quest halo — it can
        // pulse for an entire multi-minute delivery otherwise.
        const dp = a11y.reducedMotion ? 0 : Math.sin(t / 250);
        const pulse = 3 + dp * 1.4;
        ctx.strokeStyle = `rgba(255, 82, 82, ${0.5 + 0.3 * dp})`;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(p.x, p.y, pulse + 3, 0, Math.PI * 2);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(p.x - pulse - 5, p.y);
        ctx.lineTo(p.x - pulse - 1, p.y);
        ctx.moveTo(p.x + pulse + 1, p.y);
        ctx.lineTo(p.x + pulse + 5, p.y);
        ctx.stroke();
        ctx.lineWidth = 1;
        ctx.fillStyle = '#ff5252';
        ctx.beginPath();
        ctx.arc(p.x, p.y, 2.6, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // ── You: fixed at the centre, arrow rotates to heading (north-up) ───
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(data.heading); // 0 = facing north = arrow up
    const cone = ctx.createLinearGradient(0, 0, 0, -22);
    cone.addColorStop(0, 'rgba(120, 200, 255, 0.35)');
    cone.addColorStop(1, 'rgba(120, 200, 255, 0)');
    ctx.fillStyle = cone;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(-10, -22);
    ctx.lineTo(10, -22);
    ctx.closePath();
    ctx.fill();
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.7)';
    ctx.shadowBlur = 3;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.moveTo(0, -8);
    ctx.lineTo(5, 5);
    ctx.lineTo(0, 2);
    ctx.lineTo(-5, 5);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    ctx.restore();

    ctx.restore(); // release the disc clip

    // ── Compass ring: N always at the top (north-up) + E/S/W ticks ──────
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.stroke();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const dirs: Array<[string, number, number, string, string]> = [
      ['N', cx, cy - R + 9, `700 ${(10 * ts).toFixed(1)}px system-ui, sans-serif`, '#ff6b6b'],
      [
        'E',
        cx + R - 8,
        cy,
        `600 ${(8 * ts).toFixed(1)}px system-ui, sans-serif`,
        'rgba(255,255,255,0.6)',
      ],
      [
        'S',
        cx,
        cy + R - 8,
        `600 ${(8 * ts).toFixed(1)}px system-ui, sans-serif`,
        'rgba(255,255,255,0.6)',
      ],
      [
        'W',
        cx - R + 8,
        cy,
        `600 ${(8 * ts).toFixed(1)}px system-ui, sans-serif`,
        'rgba(255,255,255,0.6)',
      ],
    ];
    for (const [ch, tx, ty, font, color] of dirs) {
      ctx.font = font;
      ctx.fillStyle = color;
      ctx.fillText(ch, tx, ty + 0.5);
    }

    // ── Online count pill along the bottom of the ring ──────────────────
    const online = data.online ?? peers.length + 1;
    const label = `${online} ONLINE`;
    ctx.font = `700 ${(9 * ts).toFixed(1)}px system-ui, sans-serif`;
    const tw = ctx.measureText(label).width;
    const pillW = tw + 22;
    const pillH = 15 * ts;
    const pillX = cx - pillW / 2;
    const pillY = D - pillH - 1;
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.beginPath();
    ctx.roundRect(pillX, pillY, pillW, pillH, 7);
    ctx.fill();
    ctx.fillStyle = '#3fe0ff';
    ctx.beginPath();
    ctx.arc(pillX + 9, pillY + pillH / 2, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    ctx.textAlign = 'left';
    ctx.fillText(label, pillX + 15, pillY + pillH / 2 + 0.5);
  }

  /**
   * Island shop panel. Rows come from the caller (main-simple owns the
   * catalog + owned/equipped state); button clicks call `onAction(id)`
   * and the caller re-renders by calling showShop again.
   */
  // Session-sticky shop tab — deliberately NOT reset in hideShop: showShop
  // calls hideShop() on every purchase re-render, and the tab must survive.
  private shopTab: 'tools' | 'supplies' | 'hats' = 'tools';

  showShop(
    state: {
      coins: number;
      items: Array<{
        id: string;
        icon: string;
        name: string;
        price: number;
        // Hats are owned once and equipped; consumables are re-buyable and
        // report how many charges the player is carrying. `desc` is the
        // one-line "what it does"; `category` drives the tabs.
        desc?: string;
        category?: 'tools' | 'supplies' | 'hats';
        equippable?: boolean;
        owned?: boolean;
        equipped?: boolean;
        consumable?: boolean;
        charges?: number;
        held?: number;
      }>;
    },
    onAction: (id: string) => void,
    onClose: () => void,
  ): void {
    // A purchase re-renders the shop: keep keyboard focus on the row it was
    // on, where the re-render would drop it to BODY (D4).
    const was = this.shopDiv?.contains(document.activeElement)
      ? (document.activeElement as HTMLElement)
      : null;
    const keepId = was?.getAttribute('data-shop-id') ?? null;
    const keepTab = was?.getAttribute('data-shop-tab') ?? null;
    this.hideShop();
    this.shopDiv = document.createElement('div');
    Object.assign(this.shopDiv.style, {
      position: 'absolute',
      top: '50%',
      left: '50%',
      transform: 'translate(-50%, -50%)',
      width: 'min(420px, 92%)',
      maxHeight: 'calc(100dvh - 32px)',
      overflowY: 'auto',
      background: 'rgba(12, 12, 24, 0.95)',
      color: 'white',
      borderRadius: '16px',
      border: '1px solid rgba(255, 211, 74, 0.3)', // shop gold, dimmed
      padding: '18px 20px',
      pointerEvents: 'auto',
      zIndex: '1700',
      fontFamily: 'system-ui, sans-serif',
    });
    // Nothing in the open tab to buy (P2-D7): one 12 px line names the
    // nearest way to earn, with a 'Show me' on a Things to do key. It heads
    // the rows: under ten hats it sat below the fold on a phone.
    const earnLine = (tab: 'tools' | 'supplies' | 'hats'): string => {
      const inTab = state.items.filter((it) => (it.category ?? 'hats') === tab);
      const buyable = inTab.filter((it) => it.consumable || !it.owned);
      if (buyable.length === 0 || buyable.some((it) => it.price <= state.coins)) return '';
      const earn = this.nearestEarn();
      return `<div data-shop-earn style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin:0 0 10px;font-size:12px;color:#c5cfdd;">
          <span>Short of coins? ${earn.label}</span>
          <button type="button" data-shop-earn-key="${earn.key}" aria-label="Show me: ${earn.title}" style="flex:none;min-height:${this.isTouch ? '44px' : '32px'};padding:0 12px;border-radius:8px;border:1px solid rgba(143,155,255,0.8);background:rgba(76,91,224,0.14);color:#fff;font-size:12px;font-weight:600;cursor:pointer;">Show me</button>
        </div>`;
    };
    const rowsFor = (tab: 'tools' | 'supplies' | 'hats'): string =>
      earnLine(tab) +
      state.items
        .filter((it) => (it.category ?? 'hats') === tab)
        .map((it) => {
          // Owned non-equippable tools get a quiet "Owned ✓" — the old code
          // showed a live dead-end Equip button on the rod and axe.
          const ownedTool = it.owned && !it.equippable && !it.consumable;
          const btnLabel = it.consumable
            ? `${it.price} 🪙`
            : it.equipped
              ? 'Equipped'
              : ownedTool
                ? 'Owned ✓'
                : it.owned
                  ? 'Equip'
                  : `${it.price} 🪙`;
          const disabled = it.consumable
            ? state.coins < it.price
            : !!it.equipped || ownedTool || (!it.owned && state.coins < it.price);
          const short = state.coins < it.price && !it.owned;
          const subBits = [
            it.desc ?? '',
            it.consumable && it.held ? `carrying ${it.held}` : '',
            it.consumable ? `${it.charges} uses` : '',
            short && !it.owned ? `need ${it.price - state.coins} more 🪙` : '',
          ].filter(Boolean);
          return `
        <div style="display:flex;align-items:center;gap:12px;padding:9px 0;border-bottom:1px solid rgba(255,255,255,0.08);">
          <div style="font-size:24px;">${it.icon}</div>
          <div style="flex:1;">
            <div style="font-weight:600;">${it.name}</div>
            <div style="font-size:12px;color:${short && !it.owned ? '#e0a0a0' : '#aab'};line-height:1.35;">${subBits.join(' · ')}</div>
          </div>
          <button data-shop-id="${it.id}" ${disabled ? 'disabled' : ''} style="
            background:${it.equipped || ownedTool ? '#2e7d32' : '#ffd34a'};
            color:${it.equipped || ownedTool ? 'white' : '#332200'};
            border:none;padding:10px 16px;border-radius:8px;font-weight:700;min-height:40px;white-space:nowrap;
            cursor:${disabled ? 'default' : 'pointer'};opacity:${disabled && !it.equipped && !ownedTool ? 0.45 : 1};
          ">${btnLabel}</button>
        </div>`;
        })
        .join('');
    const tabBtn = (tab: 'tools' | 'supplies' | 'hats', label: string): string =>
      `<button data-shop-tab="${tab}" style="flex:1;padding:8px 4px;border-radius:10px;font-size:13px;font-weight:700;cursor:pointer;
        border:1px solid ${this.shopTab === tab ? 'rgba(255,211,74,0.7)' : 'rgba(255,255,255,0.12)'};
        background:${this.shopTab === tab ? 'rgba(255,211,74,0.14)' : 'transparent'};
        color:${this.shopTab === tab ? '#ffd34a' : 'rgba(255,255,255,0.55)'};">${label}</button>`;
    this.shopDiv.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
        <h3 style="margin:0;color:#ffd34a;">🛒 Island Shop</h3>
        <div style="display:flex;gap:12px;align-items:center;">
          <span style="color:#ffd34a;font-weight:800;font-size:17px;background:rgba(255,211,74,0.12);padding:4px 12px;border-radius:999px;">🪙 ${state.coins}</span>
          <button type="button" id="shop-close" aria-label="Close the shop" style="cursor:pointer;font-size:17px;width:44px;height:44px;padding:0;background:transparent;border:none;color:#fff;">✕</button>
        </div>
      </div>
      <div id="shop-tabs" style="display:flex;gap:6px;margin-bottom:8px;">
        ${tabBtn('tools', '🛠️ Tools')}${tabBtn('supplies', '🌾 Supplies')}${tabBtn('hats', '🎩 Hats')}
      </div>
      <div id="shop-rows">${rowsFor(this.shopTab)}</div>
    `;
    // Tab switch re-renders ONLY the rows container — never panels.open,
    // never hideShop (the same-id re-open rule stays untouched).
    const bindRows = (): void => {
      this.shopDiv!.querySelectorAll('button[data-shop-id]').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const id = (btn as HTMLElement).getAttribute('data-shop-id');
          if (!id) return;
          const item = state.items.find((it) => it.id === id);
          onAction(id);
          // A hat goes on (bought or owned): say who sees it (P2-D7). The
          // button was enabled, so the equip went through; main-simple's
          // equip path is A's and does not change.
          if (item?.equippable && !item.equipped && (item.owned || state.coins >= item.price)) {
            this.toast(`${item.name} on — other visitors see it too`);
          }
        });
      });
      this.shopDiv!.querySelector<HTMLElement>('button[data-shop-earn-key]')?.addEventListener(
        'click',
        (e) => {
          e.stopPropagation();
          const key = (e.currentTarget as HTMLElement).dataset.shopEarnKey ?? '';
          this.hideShop();
          onClose();
          this.guideTo(key, 'shop');
        },
      );
    };
    // Desktop, Hats open: the panel docks left so the avatar stays in view
    // (P2-D7). Everywhere else it stays centred.
    const dock = (): void => {
      const d = this.shopDiv;
      if (!d) return;
      const docked = !this.isTouch && this.shopTab === 'hats';
      d.dataset.docked = docked ? 'left' : '';
      Object.assign(
        d.style,
        docked
          ? {
              left: 'calc(var(--sal, 0px) + 16px)',
              transform: 'translateY(-50%)',
              width: 'min(380px, calc(100vw - 32px))',
            }
          : { left: '50%', transform: 'translate(-50%, -50%)', width: 'min(420px, 92%)' },
      );
    };
    dock();
    this.shopDiv.querySelectorAll('button[data-shop-tab]').forEach((tb) => {
      tb.addEventListener('click', (e) => {
        e.stopPropagation();
        this.shopTab = (tb as HTMLElement).getAttribute('data-shop-tab') as typeof this.shopTab;
        const rows = this.shopDiv!.querySelector('#shop-rows');
        if (rows) rows.innerHTML = rowsFor(this.shopTab);
        this.shopDiv!.querySelectorAll('button[data-shop-tab]').forEach((b) => {
          const active = (b as HTMLElement).getAttribute('data-shop-tab') === this.shopTab;
          (b as HTMLElement).style.border = active
            ? '1px solid rgba(255,211,74,0.7)'
            : '1px solid rgba(255,255,255,0.12)';
          (b as HTMLElement).style.background = active ? 'rgba(255,211,74,0.14)' : 'transparent';
          (b as HTMLElement).style.color = active ? '#ffd34a' : 'rgba(255,255,255,0.55)';
        });
        bindRows();
        dock();
      });
    });
    this.overlay.appendChild(this.shopDiv);
    bindRows();
    // D15: a tap on a refused (disabled, unaffordable) buy buzzes
    // [12, 40, 12]. A disabled button fires no click, but its touchstart
    // still bubbles here.
    this.shopDiv!.querySelector('#shop-rows')?.addEventListener(
      'touchstart',
      (e) => {
        const b = (e.target as Element | null)?.closest?.('button[data-shop-id]');
        const it = b && state.items.find((x) => x.id === b.getAttribute('data-shop-id'));
        if (b && (b as HTMLButtonElement).disabled && it && !it.owned && state.coins < it.price) {
          hapticPulse([12, 40, 12]);
        }
      },
      { passive: true },
    );
    // Panel registry: exclusivity + chip/touch-control hiding. ownEscape —
    // the document-level Esc handler below already owns the key (letting the
    // manager also act would double-fire onClose). The SAME-ID RE-OPEN rule
    // is load-bearing here: showShop re-renders itself after every purchase,
    // and the sweep firing onClose mid-refresh would unpause the game.
    const shop = this.shopDiv;
    this.panels.open('shop', {
      kind: 'modal',
      hides: ['nav-chips', 'touch-controls', 'aux-controls'],
      ownEscape: true,
      close: () => {
        this.hideShop();
        onClose();
      },
      el: shop,
      initialFocus: () => {
        const sel = keepId
          ? `button[data-shop-id="${keepId}"]:not([disabled])`
          : keepTab
            ? `button[data-shop-tab="${keepTab}"]`
            : '';
        return (sel ? shop.querySelector<HTMLElement>(sel) : null) ?? shop.querySelector('h3');
      },
    });
    this.stepHintAside(true); // nothing paints over a modal (D6)
    this.shopDiv.querySelector('#shop-close')?.addEventListener('click', () => {
      this.hideShop();
      onClose();
    });
    // Torn down by hideShop, not just by Escape: showShop re-renders after
    // every purchase (and bird feed is re-buyable), so a self-removing
    // handler would stack one listener per buy.
    const escHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        this.hideShop();
        onClose();
      }
    };
    this.shopEsc = escHandler;
    document.addEventListener('keydown', escHandler);
  }

  private shopEsc: ((e: KeyboardEvent) => void) | null = null;

  hideShop(): void {
    if (this.shopEsc) {
      document.removeEventListener('keydown', this.shopEsc);
      this.shopEsc = null;
    }
    if (this.shopDiv) {
      this.shopDiv.remove();
      this.shopDiv = null;
      this.panels.notifyClosed('shop'); // no-op during a manager sweep
    }
  }

  isShopOpen(): boolean {
    return this.shopDiv !== null;
  }

  /** Coin counter chip under the online-count in the top-right. */
  updateCoinCounter(total: number): void {
    if (!this.coinDiv) {
      this.coinDiv = document.createElement('div');
      Object.assign(this.coinDiv.style, {
        ...CHIP,
        top: 'calc(var(--sat, 0px) + 50px)', // column row 2 (38px pitch)
        right: 'calc(var(--sar, 0px) + 10px)',
        color: '#ffd34a', // the coin accent survives the shared recipe
        pointerEvents: 'auto', // tap the chip to open the coin receipt
        cursor: 'pointer',
        transition: 'transform 0.12s ease',
        fontVariantNumeric: 'tabular-nums', // D11: digits keep one width
      });
      this.coinDiv.title = 'Coin history';
      this.coinDiv.addEventListener('click', () => this.onCoinChipClick?.());
      // The full recipe, not hand-rolled role/aria: this also brings the
      // .hud-btn 44px tap pad (the visual chip is 30px tall) plus keyboard
      // focus + Enter/Space activation. Title above survives its guard.
      this.makeHudButtonAccessible(this.coinDiv, 'Open coin history');
      this.coinDiv.dataset.guide = 'coin-chip';
      if (this.isTouch) {
        this.tierChip(this.coinDiv); // inserts BEFORE ☰ to keep [👥][🪙][☰]
      } else {
        this.overlay.appendChild(this.coinDiv);
        this.panels.registerLayer('nav-chips', this.coinDiv);
      }
      SimpleUI.chipContent(this.coinDiv, 'coin', String(total));
      this._coinShown = total;
      return; // no bump on first render
    }
    const from = this._coinShown;
    const delta = total - from;
    // D11: a coin in flight (ds:coin) lands first; the chip counts when it
    // arrives. A's pays (no ds:coin) pop through the delta at once.
    if (this.coinFlights > 0 && delta > 0) {
      this.coinPending = total;
      return;
    }
    // Reduced motion: no count-up, no pop — just the value.
    if (a11y.reducedMotion || delta === 0) {
      SimpleUI.chipText(this.coinDiv, String(total));
      this._coinShown = total;
      return;
    }
    const el = this.coinDiv;
    // Amount-aware pop (D11): 1.12 + 0.13 x min(1, |delta|/50), at most 1.25.
    // Green flash on a gain, coral on a spend.
    // The chip keeps one width through the count (tabular digits; the wider
    // of the two ends).
    el.style.minWidth = '';
    const w0 = el.offsetWidth;
    SimpleUI.chipText(el, String(total));
    el.style.minWidth = `${Math.max(w0, el.offsetWidth)}px`;
    SimpleUI.chipText(el, String(from));
    const scale = Math.min(1.25, 1.12 + 0.13 * Math.min(1, Math.abs(delta) / 50));
    el.style.transform = `scale(${scale.toFixed(2)})`;
    el.style.color = delta > 0 ? '#7fe08a' : '#ff9a7a';
    window.setTimeout(() => {
      el.style.transform = 'scale(1)';
      el.style.color = '#ffd34a';
    }, 170);
    // Count the number UP (or down) instead of snapping — the change is legible.
    if (this._coinAnim) cancelAnimationFrame(this._coinAnim);
    const dur = Math.min(650, 140 + Math.abs(delta) * 12);
    const start = performance.now();
    const step = (): void => {
      const p = Math.min(1, (performance.now() - start) / dur);
      const v = Math.round(from + delta * (1 - (1 - p) * (1 - p)));
      SimpleUI.chipText(el, String(v));
      this._coinShown = v;
      if (p < 1) {
        this._coinAnim = requestAnimationFrame(step);
      } else {
        SimpleUI.chipText(el, String(total));
        this._coinShown = total;
        this._coinAnim = 0;
        el.style.minWidth = '';
      }
    };
    this._coinAnim = requestAnimationFrame(step);
  }

  /** Coins in the air (D11) and the total waiting for them to land. */
  private coinFlights = 0;
  private coinPending: number | null = null;

  /**
   * D11 (contract with B9): 'ds:coin' {x, y, value} fires as a meadow or
   * trail coin is collected, before the total updates. A 22 px coin flies
   * from the pickup to the chip over 420 ms, then the chip counts and pops.
   * Reduced motion, or no visible chip: no flight, the chip counts in place.
   */
  private readonly onCoinEvent = (e: Event): void => {
    const d = (e as CustomEvent<{ x?: number; y?: number }>).detail;
    const chip = this.coinDiv;
    if (!chip || a11y.reducedMotion || !d || !Number.isFinite(d.x) || !Number.isFinite(d.y)) return;
    const r = chip.getBoundingClientRect();
    if (r.width < 1 || getComputedStyle(chip).visibility === 'hidden') return;
    const coin = document.createElement('div');
    coin.dataset.coinFlight = '1';
    coin.setAttribute('aria-hidden', 'true');
    Object.assign(coin.style, {
      position: 'fixed',
      left: `${d.x! - 11}px`,
      top: `${d.y! - 11}px`,
      width: '22px',
      height: '22px',
      borderRadius: '50%',
      background: 'radial-gradient(circle at 35% 30%, #fff3b0, #ffd34a 45%, #c99a1c)',
      boxShadow: '0 0 0 2px #8a6a10 inset, 0 2px 6px rgba(0,0,0,0.35)',
      pointerEvents: 'none',
      zIndex: '1700',
    });
    this.overlay.appendChild(coin);
    this.coinFlights++;
    let landed = false;
    const land = (): void => {
      if (landed) return;
      landed = true;
      coin.remove();
      this.coinFlights = Math.max(0, this.coinFlights - 1);
      if (this.coinFlights === 0 && this.coinPending !== null) {
        const t = this.coinPending;
        this.coinPending = null;
        this.updateCoinCounter(t);
      }
    };
    const dx = r.left + r.width / 2 - d.x!;
    const dy = r.top + r.height / 2 - d.y!;
    // It lands when the flight finishes (its last frame sits on the chip);
    // the timer is the fallback for a browser without Web Animations.
    if (typeof coin.animate === 'function') {
      coin.animate(
        [
          { transform: 'translate(0, 0) scale(1)' },
          { transform: `translate(${dx * 0.35}px, ${dy * 0.35 - 40}px) scale(1.1)`, offset: 0.4 },
          { transform: `translate(${dx}px, ${dy}px) scale(0.7)` },
        ],
        { duration: 420, easing: 'ease-in-out', fill: 'forwards' },
      ).onfinish = () => requestAnimationFrame(land);
    }
    window.setTimeout(land, 600);
  };

  private feedDiv: HTMLElement | null = null;

  /**
   * Bird-feed charges, as a chip beside the coin counter. Hidden at zero so
   * players who never buy any never see it.
   *
   * NOT on the +88px row: that is the 🎨 ♿ 🔊 icon row (see
   * createCustomizeButton), and a chip there paints straight over all three.
   * It shares the coin chip's row instead, to its left.
   */
  updateFeedCounters(bird: number, cat: number, fish: number, meals = 0): void {
    const total = bird + cat + fish + meals;
    if (!this.feedDiv) {
      if (total <= 0) return;
      this.feedDiv = document.createElement('div');
      Object.assign(this.feedDiv.style, {
        ...CHIP,
        top: 'calc(var(--sat, 0px) + 50px)', // shares the coin row
        right: 'calc(var(--sar, 0px) + 90px)', // clear of a 4-digit coin chip
        color: '#e8d9a0',
        pointerEvents: 'none',
        transition: 'transform 0.12s ease',
        whiteSpace: 'nowrap',
      });
      if (this.isTouch) {
        // Into the tier-1 row (registered as a unit) — NOT layer-registered
        // itself: this chip toggles its own display at zero charges, and the
        // manager's touch policy writes the same property.
        this.tierChip(this.feedDiv);
      } else {
        this.overlay.appendChild(this.feedDiv);
      }
    }
    if (total <= 0) {
      this.feedDiv.style.display = 'none';
      return;
    }
    // Only show the types you actually hold; F throws the right one for where
    // you aim (water → fish, land → the animal you're pointing at).
    const parts: string[] = [];
    if (bird > 0) parts.push(`🌾 ${bird}`);
    if (cat > 0) parts.push(`🐈 ${cat}`);
    if (fish > 0) parts.push(`🐟 ${fish}`);
    if (meals > 0) parts.push(`🍽️ ${meals}`);
    // Two verbs share this chip now — show only the ones you can actually do.
    const hints: string[] = [];
    if (bird + cat + fish > 0) hints.push('F feed');
    if (meals > 0) hints.push('G eat');
    // 'flex', not 'block' — the CHIP recipe centers its content with flex;
    // a block re-show dropped the icon/text baseline out of center.
    this.feedDiv.style.display = 'flex';
    this.feedDiv.textContent = `${parts.join('  ')}  ·  ${hints.join(' · ')}`;
    this.feedDiv.style.transform = 'scale(1.35)';
    const el = this.feedDiv;
    window.setTimeout(() => {
      el.style.transform = 'scale(1)';
    }, 130);
  }

  private raceDiv: HTMLElement | null = null;
  private raceLine1: HTMLElement | null = null;
  private raceLine2: HTMLElement | null = null;

  /**
   * Top-centre race panel: live lap time + checkpoint progress while driving a
   * circuit, or a "drive through the ring to start" hint. Pass null to hide it
   * (on foot / not near a circuit).
   */
  updateRaceHud(status: { line1: string; line2?: string } | null): void {
    // Null first, BEFORE the lazy build: this runs every frame, and a
    // visitor who never rides used to get the whole panel appended (hidden)
    // on their first frame on foot.
    if (!status) {
      if (this.raceDiv && this.raceVisible) {
        this.raceDiv.style.opacity = '0';
        this.raceDiv.style.display = 'none';
        this.raceVisible = false;
      }
      return;
    }
    if (!this.raceDiv) {
      this.raceDiv = document.createElement('div');
      this.raceDiv.dataset.hud = 'race';
      Object.assign(this.raceDiv.style, {
        position: 'absolute',
        // Below the compass pill (P2-D7): at +12 it sat over the pill, 83% of
        // it on desktop and 88% on the phone.
        top: 'calc(var(--sat, 0px) + 62px)',
        left: '50%',
        transform: 'translateX(-50%)',
        background: 'rgba(0, 0, 0, 0.6)',
        color: '#fff',
        padding: '6px 14px',
        borderRadius: '12px',
        textAlign: 'center',
        fontFamily: 'system-ui, sans-serif',
        pointerEvents: 'none',
        zIndex: '1200',
        opacity: '0',
        transition: 'opacity 0.2s ease',
        display: 'none',
      });
      this.raceLine1 = document.createElement('div');
      Object.assign(this.raceLine1.style, {
        fontSize: '17px',
        fontWeight: '700',
        fontVariantNumeric: 'tabular-nums',
      });
      this.raceLine2 = document.createElement('div');
      Object.assign(this.raceLine2.style, {
        fontSize: '12px',
        color: '#cfe0ff',
        marginTop: '1px',
      });
      this.raceDiv.appendChild(this.raceLine1);
      this.raceDiv.appendChild(this.raceLine2);
      this.overlay.appendChild(this.raceDiv);
    }
    if (!this.raceVisible) {
      this.raceDiv.style.display = 'block';
      this.raceDiv.style.opacity = '1';
      this.raceVisible = true;
    }
    // textContent only on change — line1 still updates per frame during a
    // running race (the timer string differs each frame), so nothing visible
    // changes; the win is the idle "drive through the ring" state.
    if (this.raceLine1 && status.line1 !== this.raceLastLine1) {
      this.raceLastLine1 = status.line1;
      this.raceLine1.textContent = status.line1;
    }
    const line2 = status.line2 ?? '';
    if (this.raceLine2 && line2 !== this.raceLastLine2) {
      this.raceLastLine2 = line2;
      this.raceLine2.textContent = line2;
      this.raceLine2.style.display = line2 ? 'block' : 'none';
    }
  }

  private breathWrap: HTMLDivElement | null = null;
  private breathFill: HTMLDivElement | null = null;
  private waterVignette: HTMLDivElement | null = null;
  private staminaWrap: HTMLDivElement | null = null;
  private staminaFill: HTMLDivElement | null = null;

  // Last-written caches for the per-frame HUD writers (prompt, race panel,
  // meters, vignettes). Style/text writes are skipped when the value hasn't
  // changed — these are called EVERY frame and used to rewrite identical
  // strings (including a rebuilt radial-gradient) into the style engine.
  // Percentages quantize to 1% — imperceptible on a 160px bar behind a
  // 0.12s width transition; opacities compare by exact string (they vary
  // continuously while swimming, and quantizing would step the fade).
  private lastPromptText: string | null = null;
  private lastPromptMode: InputMode | null = null;
  private raceVisible = false;
  private raceLastLine1: string | null = null;
  private raceLastLine2: string | null = null;
  private lastStaminaShow: boolean | null = null;
  private lastStaminaPct = -1;
  private lastBreathShow: boolean | null = null;
  private lastBreathPct = -1;
  private lastVignetteOpacity = '';
  private lastVignetteDeep: boolean | null = null;
  private lastWashOpacity = '';
  // The two vignette states, prebuilt (the template literal was rebuilt and
  // re-parsed by the style engine every frame while swimming).
  private static readonly VIGNETTE_DEEP =
    'radial-gradient(circle at 50% 45%, rgba(60,140,190,0.05) 30%, rgba(20,40,60,0.85) 100%)';
  private static readonly VIGNETTE_SHALLOW =
    'radial-gradient(circle at 50% 45%, rgba(60,140,190,0.05) 30%, rgba(10,40,70,0.85) 100%)';

  /**
   * Stamina meter (run = hold Space/JUMP while moving). Same visual language
   * as the breath meter, one row above it; hidden while full and not running
   * so the HUD stays quiet during normal walking.
   */
  updateStamina(stamina: number, running: boolean): void {
    const show = running || stamina < 0.999;
    if (!this.staminaWrap) {
      if (!show) return; // never build the DOM for a full, idle meter
      this.staminaWrap = document.createElement('div');
      Object.assign(this.staminaWrap.style, {
        position: 'absolute',
        bottom: 'calc(var(--sab, 0px) + 170px)',
        left: '50%',
        transform: 'translateX(-50%)',
        width: '160px',
        height: '10px',
        borderRadius: '6px',
        background: 'rgba(0,0,0,0.5)',
        border: '1px solid rgba(255,255,255,0.35)',
        overflow: 'hidden',
        opacity: '0',
        transition: 'opacity 0.3s ease',
        pointerEvents: 'none',
        zIndex: '1100',
      });
      this.staminaFill = document.createElement('div');
      Object.assign(this.staminaFill.style, {
        height: '100%',
        width: '100%',
        borderRadius: '5px',
        transition: 'width 0.12s linear, background 0.3s ease',
      });
      const label = document.createElement('div');
      label.textContent = '⚡';
      Object.assign(label.style, {
        position: 'absolute',
        left: '-20px',
        top: '-4px',
        fontSize: '13px',
      });
      this.staminaWrap.appendChild(this.staminaFill);
      this.staminaWrap.appendChild(label);
      this.overlay.appendChild(this.staminaWrap);
      this.panels.registerLayer('ambient-info', this.staminaWrap);
    }
    if (show !== this.lastStaminaShow) {
      this.lastStaminaShow = show;
      this.staminaWrap.style.opacity = show ? '1' : '0';
    }
    const pct = Math.round(Math.max(0, Math.min(1, stamina)) * 100);
    if (this.staminaFill && pct !== this.lastStaminaPct) {
      this.lastStaminaPct = pct;
      this.staminaFill.style.width = `${pct}%`;
      // amber while healthy, red when nearly spent
      const hue = 12 + 30 * (pct / 100);
      this.staminaFill.style.background = `hsl(${hue}, 85%, 52%)`;
    }
  }

  /**
   * Swim UX: a breath meter (bottom-centre) + an underwater vignette that
   * closes in and reddens as oxygen runs out. Both fade away on dry land.
   */
  updateBreath(oxygen: number, inWater: boolean): void {
    const show = inWater || oxygen < 0.999;
    if (!this.breathWrap) {
      // Never build the meter+vignette DOM for a session that stays dry
      // (mirrors updateStamina's guard) — this runs every frame from boot.
      if (!show) return;
      this.waterVignette = document.createElement('div');
      Object.assign(this.waterVignette.style, {
        position: 'absolute',
        inset: '0',
        pointerEvents: 'none',
        opacity: '0',
        transition: 'opacity 0.4s ease',
        zIndex: '900',
      });
      this.overlay.appendChild(this.waterVignette);

      this.breathWrap = document.createElement('div');
      Object.assign(this.breathWrap.style, {
        position: 'absolute',
        bottom: 'calc(var(--sab, 0px) + 150px)',
        left: '50%',
        transform: 'translateX(-50%)',
        width: '160px',
        height: '12px',
        borderRadius: '7px',
        background: 'rgba(0,0,0,0.5)',
        border: '1px solid rgba(255,255,255,0.35)',
        overflow: 'hidden',
        opacity: '0',
        transition: 'opacity 0.3s ease',
        pointerEvents: 'none',
        zIndex: '1100',
      });
      this.breathFill = document.createElement('div');
      Object.assign(this.breathFill.style, {
        height: '100%',
        width: '100%',
        borderRadius: '6px',
        transition: 'width 0.12s linear, background 0.3s ease',
      });
      const label = document.createElement('div');
      label.textContent = '🫧';
      Object.assign(label.style, {
        position: 'absolute',
        left: '-22px',
        top: '-4px',
        fontSize: '15px',
      });
      this.breathWrap.appendChild(this.breathFill);
      this.breathWrap.appendChild(label);
      this.overlay.appendChild(this.breathWrap);
    }
    const danger = 1 - Math.max(0, Math.min(1, oxygen));
    if (show !== this.lastBreathShow) {
      this.lastBreathShow = show;
      this.breathWrap!.style.opacity = show ? '1' : '0';
    }
    const pct = Math.round(Math.max(0, Math.min(1, oxygen)) * 100);
    if (this.breathFill && pct !== this.lastBreathPct) {
      this.lastBreathPct = pct;
      this.breathFill.style.width = `${pct}%`;
      // green → amber → red as it drains
      const hue = 120 * (pct / 100);
      this.breathFill.style.background = `hsl(${hue}, 80%, 50%)`;
    }
    if (this.waterVignette) {
      const strength = inWater ? String(0.35 + danger * 0.55) : '0';
      if (strength !== this.lastVignetteOpacity) {
        this.lastVignetteOpacity = strength;
        this.waterVignette.style.opacity = strength;
      }
      // deepen from teal to a drowning red-tinged dark as oxygen falls —
      // two prebuilt states, written only when the state flips
      const deep = danger > 0.5;
      if (deep !== this.lastVignetteDeep) {
        this.lastVignetteDeep = deep;
        this.waterVignette.style.background = deep
          ? SimpleUI.VIGNETTE_DEEP
          : SimpleUI.VIGNETTE_SHALLOW;
      }
    }
  }

  private underwaterWash: HTMLDivElement | null = null;

  /**
   * CAMERA-submersion wash (distinct from the swim vignette above, which keys
   * on the PLAYER). The sea surface is backface-culled, so looking up from
   * below shows bare sky — this full-screen teal is what sells "under the
   * water" for zero GPU cost (no new render pass, per the post-crisis ban).
   */
  setUnderwater(f: number): void {
    if (f <= 0 && !this.underwaterWash) return; // never build the div dry
    if (!this.underwaterWash) {
      this.underwaterWash = document.createElement('div');
      Object.assign(this.underwaterWash.style, {
        position: 'absolute',
        inset: '0',
        pointerEvents: 'none',
        zIndex: '890', // under the swim vignette (900) and all HUD
        background:
          'linear-gradient(rgba(16,74,102,0.55) 0%, rgba(9,48,68,0.62) 55%, rgba(6,34,50,0.7) 100%)',
        opacity: '0',
      });
      this.overlay.appendChild(this.underwaterWash);
    }
    const op = String(Math.max(0, Math.min(1, f)) * 0.85);
    if (op !== this.lastWashOpacity) {
      this.lastWashOpacity = op;
      this.underwaterWash.style.opacity = op;
    }
  }

  /** Brief centred splash message (used for the drown/rescue). */
  private flashEl: HTMLDivElement | null = null;
  /**
   * A flash joins the toast queue as an outcome (D6): one message at a time,
   * so it never shares the screen with a toast (FM-09: a flash, a toast and a
   * prompt stacked at 35 s), never paints over an open modal (UX-04: 'Secret
   * found' across the Projects text), and dwells 50 ms a character, 2-6 s.
   */
  flashMessage(text: string): void {
    this.enqueue(this.queued(text, 'flash', false));
  }

  private showFlash(text: string, dwell: number): void {
    // Single slot: each call used to append a NEW div at the identical
    // anchor, so two flashes within ~2s superimposed their text (reachable
    // first-session: ?race= landing + arrival trail). Replace, don't stack.
    this.flashEl?.remove();
    const el = document.createElement('div');
    this.flashEl = el;
    renderKeyText(el, text, this.getInputMode());
    Object.assign(el.style, {
      position: 'absolute',
      top: '38%',
      left: '50%',
      maxWidth: 'min(92vw, 440px)',
      textAlign: 'center',
      transform: 'translate(-50%, -50%) scale(0.9)',
      background: 'rgba(0,0,0,0.78)',
      color: 'white',
      padding: '10px 18px',
      borderRadius: '12px',
      fontSize: '15px',
      fontFamily: 'system-ui, sans-serif',
      pointerEvents: 'none',
      zIndex: '2000',
      opacity: '0',
      transition: 'opacity 0.25s ease, transform 0.25s cubic-bezier(0.34,1.56,0.64,1)',
    });
    this.overlay.appendChild(el);
    this.anchorFlash(el); // clear of First steps' card
    requestAnimationFrame(() => {
      el.style.opacity = '1';
      el.style.transform = 'translate(-50%, -50%) scale(1)';
    });
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => {
      el.style.opacity = '0';
      this.toastBusy = false;
      this.shownMessage = null;
      // The next toast waits out this 300 ms fade (pumpToasts).
      this.flashFadeUntil = Date.now() + 300;
      this.schedulePump(300);
      window.setTimeout(() => {
        el.remove();
        if (this.flashEl === el) this.flashEl = null;
      }, 300);
    }, dwell);
  }

  /**
   * Update player count display
   */
  updatePlayerCount(count: number): void {
    if (this.playerCountDiv) {
      const text = `${count} online`;
      if (!this.playerCountDiv.querySelector('.ds-ic')) {
        SimpleUI.chipContent(this.playerCountDiv, 'users', text);
      } else {
        SimpleUI.chipText(this.playerCountDiv, text);
      }
    }
  }

  /**
   * Show character customization panel
   */
  // Preset swatches per body part (first entry ≈ the model default)
  private static readonly CUSTOMIZE_PALETTES: Record<string, number[]> = {
    outfit: [0xf3b359, 0x4a90e2, 0xe84a5f, 0x4caf50, 0x9b59b6, 0x1abc9c, 0xff8ab0, 0x2c2c33],
    pants: [0x6f7c95, 0x2a3a5a, 0x5a4632, 0x2c2c33, 0x8a7d5a, 0x37516e],
    hair: [0x6c594b, 0x201a15, 0xd9a441, 0xb5482e, 0xaaaaaa, 0x5566cc],
    skin: [0xffe0bd, 0xf3b98a, 0xd8955c, 0xa9713f, 0x7a4a24, 0xe8c39e],
  };
  private static readonly CUSTOMIZE_LABELS: Record<string, string> = {
    outfit: 'Outfit',
    pants: 'Pants',
    hair: 'Hair',
    skin: 'Skin',
  };
  /** Swatch names, in CUSTOMIZE_PALETTES order: a screen reader heard
   *  '#f3b359' (UX-15). Skin tones are numbered, not named. */
  private static readonly CUSTOMIZE_NAMES: Record<string, string[]> = {
    outfit: ['mustard', 'blue', 'red', 'green', 'purple', 'teal', 'pink', 'charcoal'],
    pants: ['slate', 'navy', 'brown', 'charcoal', 'khaki', 'denim'],
    hair: ['brown', 'black', 'blonde', 'auburn', 'grey', 'blue'],
    skin: ['tone 1', 'tone 2', 'tone 3', 'tone 4', 'tone 5', 'tone 6'],
  };

  /**
   * Appearance editor: colour swatches per body part + a picker over owned
   * hats. Recolours the live model through the callbacks and persists via the
   * caller. A pick moves the active highlight in place.
   */
  showCustomize(opts: {
    colors: Record<string, number | undefined>;
    ownedHats: string[];
    equippedHat: string | null;
    hats: Array<{ id: string; icon: string }>;
    onColor: (part: string, hex: number) => void;
    onHat: (id: string | null) => void;
  }): void {
    if (!this.customizeDiv) {
      this.customizeDiv = document.createElement('div');
      Object.assign(this.customizeDiv.style, {
        position: 'absolute',
        background: 'rgba(0, 0, 0, 0.9)',
        color: 'white',
        padding: '14px 16px',
        borderRadius: '12px',
        pointerEvents: 'auto',
        fontFamily: 'system-ui, sans-serif',
        fontSize: '13px',
        maxWidth: '272px',
        zIndex: '1400',
      });
      if (this.isTouch) {
        // Bottom-left is the joystick's corner — anchoring the panel there
        // covers the stick and traps movement (you can't walk while recolouring,
        // which defeats "preview while moving"). Float it top-centre and let it
        // scroll, clear of both the joystick and the action buttons in portrait
        // and short-landscape alike.
        Object.assign(this.customizeDiv.style, {
          top: 'calc(var(--sat, 0px) + 10px)',
          left: '50%',
          transform: 'translateX(-50%)',
          maxHeight: 'calc(100dvh - var(--sat, 0px) - 20px)',
          overflowY: 'auto',
        });
      } else {
        Object.assign(this.customizeDiv.style, {
          bottom: 'calc(var(--sab, 0px) + 20px)',
          left: 'calc(var(--sal, 0px) + 20px)',
        });
      }
      this.overlay.appendChild(this.customizeDiv);
    }
    // Sheet, NOT modal, and touch-controls stay: "preview while moving" is the
    // point of this panel (see the touch-layout comment above) — hiding the
    // joystick would trap the player mid-recolour. A caller re-opening it
    // re-renders it → protected by the same-id re-open rule.
    this.panels.open('customize', {
      kind: 'sheet',
      hides: ['nav-chips'],
      close: () => this.hideCustomize(),
    });

    const hexStr = (h: number) => `#${h.toString(16).padStart(6, '0')}`;
    // Named, pressed-state swatches in a 6-column grid: 32px on desktop and
    // a 44px thumb target on touch, where they were 23px and named by hex
    // (UX-15). A pick updates the highlight IN PLACE, so focus stays on the
    // swatch it was on (the old innerHTML rewrite dropped it).
    const sw = this.isTouch ? 44 : 32;
    this.customizeDiv.style.maxWidth = this.isTouch ? 'min(340px, calc(100vw - 24px))' : '272px';
    const swatchRow = (part: string): string => {
      const cur = opts.colors[part];
      const label = SimpleUI.CUSTOMIZE_LABELS[part];
      const names = SimpleUI.CUSTOMIZE_NAMES[part] ?? [];
      const swatches = SimpleUI.CUSTOMIZE_PALETTES[part]
        .map((hex, i) => {
          const active = cur === hex;
          const name = `${label}: ${names[i] ?? hexStr(hex)}`;
          return `<button type="button" data-part="${part}" data-hex="${hex}" aria-label="${name}" aria-pressed="${active}" title="${name}" style="width:${sw}px;height:${sw}px;border-radius:6px;border:2px solid ${active ? '#fff' : 'transparent'};background:${hexStr(hex)};cursor:pointer;margin:0;padding:0;"></button>`;
        })
        .join('');
      return `<div style="margin-bottom:7px;"><div style="font-size:12px;color:#bbb;margin-bottom:2px;">${label}</div><div role="group" aria-label="${label}" style="display:grid;grid-template-columns:repeat(6, ${sw}px);gap:4px;">${swatches}</div></div>`;
    };
    const hatBtn = (id: string | null, icon: string): string => {
      const active = (opts.equippedHat ?? null) === id;
      const name = id ? `Hat: ${id.replace(/[-_]/g, ' ')}` : 'No hat';
      return `<button type="button" data-hat="${id ?? ''}" aria-label="${name}" aria-pressed="${active}" title="${name}" style="font-size:17px;min-width:${sw}px;min-height:${sw}px;padding:3px 7px;border-radius:8px;border:2px solid ${active ? '#fff' : 'transparent'};background:rgba(255,255,255,0.12);cursor:pointer;margin:2px;">${icon}</button>`;
    };
    const ownedBtns = opts.hats
      .filter((h) => opts.ownedHats.includes(h.id))
      .map((h) => hatBtn(h.id, h.icon))
      .join('');
    const hatRow = `<div style="margin-bottom:6px;"><div style="font-size:12px;color:#bbb;margin-bottom:2px;">Hat</div><div style="display:flex;flex-wrap:wrap;align-items:center;">${hatBtn(null, '🚫')}${ownedBtns || '<span style="font-size:12px;color:#888;margin-left:4px;">buy hats at the 🛒 shop</span>'}</div></div>`;

    this.customizeDiv.innerHTML = `
      <div style="font-weight:700;margin-bottom:9px;">🎨 Appearance</div>
      ${swatchRow('outfit')}${swatchRow('pants')}${swatchRow('hair')}${swatchRow('skin')}
      ${hatRow}
      <button id="close-customize" class="ds-press" style="background:${DS.primary};color:white;border:none;padding:6px 13px;min-height:${this.isTouch ? 44 : 32}px;border-radius:8px;cursor:pointer;margin-top:6px;">Done</button>
    `;

    const root = this.customizeDiv;
    const mark = (group: NodeListOf<HTMLElement>, on: HTMLElement): void => {
      for (const b of Array.from(group)) {
        b.style.borderColor = b === on ? '#fff' : 'transparent';
        b.setAttribute('aria-pressed', String(b === on));
      }
    };
    root.querySelectorAll<HTMLElement>('button[data-hex]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const part = btn.dataset.part!;
        const hex = parseInt(btn.dataset.hex!, 10);
        opts.onColor(part, hex);
        opts.colors[part] = hex; // a later re-open starts from it
        mark(root.querySelectorAll<HTMLElement>(`button[data-part="${part}"]`), btn);
      });
    });
    root.querySelectorAll<HTMLElement>('button[data-hat]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.hat ? btn.dataset.hat : null;
        opts.onHat(id);
        opts.equippedHat = id;
        mark(root.querySelectorAll<HTMLElement>('button[data-hat]'), btn);
      });
    });
    const closeBtn = this.customizeDiv.querySelector('#close-customize') as HTMLButtonElement;
    closeBtn.addEventListener('click', () => this.hideCustomize());
  }

  /**
   * Hide customization panel
   */
  hideCustomize(): void {
    if (this.customizeDiv) {
      this.customizeDiv.remove();
      this.customizeDiv = null;
      this.panels.notifyClosed('customize');
    }
  }

  /**
   * Show quest completion notification
   */
  showQuestComplete(quest: { name: string; reward?: { value: string } }): void {
    const div = document.createElement('div');
    Object.assign(div.style, {
      position: 'absolute',
      top: '20%',
      left: '50%',
      transform: 'translateX(-50%)',
      background: 'rgba(0, 0, 0, 0.9)',
      color: 'white',
      padding: '14px 22px',
      borderRadius: '14px',
      textAlign: 'center',
      pointerEvents: 'none',
      fontSize: '15px',
      border: '1px solid rgba(76,175,80,0.55)', // was 2px full-alpha green
      zIndex: '1500',
      transition: 'opacity 0.5s',
    });
    div.innerHTML = `
      <div style="font-size:28px;margin-bottom:8px;">🎉 Quest Complete!</div>
      <div style="color:#4CAF50;font-weight:bold;">${this.escapeHtml(quest.name)}</div>
      ${quest.reward ? `<div style="margin-top:8px;font-size:14px;color:#ccc;">${this.escapeHtml(quest.reward.value)}</div>` : ''}
    `;
    this.overlay.appendChild(div);
    setTimeout(() => {
      div.style.opacity = '0';
      setTimeout(() => div.remove(), 500);
    }, 3000);
  }

  /**
   * Show zone interaction panel
   */
  private compassDiv: HTMLDivElement | null = null;
  private compassArrow: HTMLDivElement | null = null;
  private _compassTf = ''; // last-written transform (change-guard)
  private _compassText = ''; // last-written label (change-guard)
  private compassLabel: HTMLDivElement | null = null;

  /**
   * Quest compass: an arrow at the top of the screen pointing toward the
   * active delivery (angle is relative to the camera's forward direction),
   * with the remaining distance. Pass null to hide.
   */
  updateQuestCompass(state: { angleRad: number; distance: number; label: string } | null): void {
    if (!state) {
      if (this.compassDiv) this.compassDiv.style.display = 'none';
      return;
    }
    if (!this.compassDiv) {
      this.compassDiv = document.createElement('div');
      Object.assign(this.compassDiv.style, {
        position: 'fixed',
        top: 'calc(var(--sat, 0px) + 14px)',
        left: '50%',
        transform: 'translateX(-50%)',
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        background: 'rgba(0, 0, 0, 0.55)',
        borderRadius: '20px',
        padding: '6px 14px',
        // A 44px thumb target on touch: it measured 39 (phone.cjs).
        boxSizing: 'border-box',
        minHeight: this.isTouch ? '44px' : '',
        zIndex: '1200',
        // The one ALWAYS-visible wayfinding element used to be inert
        // (pointerEvents none) \u2014 it pointed at things but could never hand
        // off to the map. Now it's the map's front door. The hit area stays
        // the pill's own box (no ::after pad) so camera-drag touches beside
        // it are never intercepted.
        pointerEvents: 'auto',
        cursor: 'pointer',
        fontFamily: 'sans-serif',
      });
      this.compassDiv.setAttribute('role', 'button');
      this.compassDiv.dataset.guide = 'compass';
      this.compassDiv.setAttribute('tabindex', '0');
      this.compassDiv.setAttribute('aria-label', 'Open the island map');
      this.compassDiv.title = 'Open the island map';
      const openMap = (): void => {
        this.compassPillUsed = true;
        track('compass_pill_tap');
        // The existing map seam (journal's map button uses it too) \u2014 one
        // entry path into openIslandMap, multiple callers.
        this.onOpenMap?.();
      };
      this.compassDiv.addEventListener('click', (e) => {
        e.stopPropagation();
        openMap();
      });
      this.compassDiv.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          openMap();
        }
      });
      this.compassArrow = document.createElement('div');
      this.compassArrow.textContent = '\u27A4';
      Object.assign(this.compassArrow.style, {
        fontSize: '20px',
        color: '#ffd54a',
        transition: 'transform 0.12s linear',
        transformOrigin: '50% 50%',
        pointerEvents: 'none', // one hit target: the pill itself
      });
      this.compassLabel = document.createElement('div');
      Object.assign(this.compassLabel.style, {
        color: 'white',
        fontSize: '13px',
        whiteSpace: 'nowrap',
        pointerEvents: 'none',
      });
      this.compassDiv.appendChild(this.compassArrow);
      this.compassDiv.appendChild(this.compassLabel);
      this.overlay.appendChild(this.compassDiv);
    }
    // Change-guards on every write: this runs EVERY FRAME, and unconditional
    // style/textContent writes invalidate layout 60\u00d7/s on phones for values
    // (rounded degrees / whole metres) that change a few times a second.
    if (this.compassDiv.style.display !== 'flex') this.compassDiv.style.display = 'flex';
    if (this.compassArrow) {
      // arrow glyph points right at 0deg; screen-up (camera forward) is -90deg
      const deg = (state.angleRad * 180) / Math.PI - 90;
      const tf = `rotate(${deg.toFixed(1)}deg)`;
      if (this._compassTf !== tf) {
        this._compassTf = tf;
        this.compassArrow.style.transform = tf;
      }
    }
    if (this.compassLabel) {
      // Narrow screens keep the destination's icon (the label's first token)
      // AND a short name (D16): a bare "103m" was direction with no subject.
      // Icon-only only below 340 px.
      const w = window.innerWidth;
      const text =
        w < 480
          ? `${compassShortLabel(state.label, w < 340)} ${Math.round(state.distance)}m`
          : `${state.label} \u2022 ${Math.round(state.distance)}m`;
      if (this._compassText !== text) {
        this._compassText = text;
        this.compassLabel.textContent = text;
      }
    }
    // A new target is read out once, by its label (never the metres, which
    // change every few frames).
    if (state.label !== this._compassAnnounced) {
      this._compassAnnounced = state.label;
      this.announce(`Compass: ${state.label}`);
    }
  }

  private _compassAnnounced = '';

  /**
   * The recruiter front door: name, role, availability, experience, the
   * guardrails in this island's code, and LinkedIn / CV / code / email. A zone
   * panel with id 'hire', so ?zone=hire (and /z/hire) deep-link to it.
   */
  public showHireCard(source: 'menu' | 'deeplink' | 'cta' | 'npc' = 'cta'): void {
    this.showZonePanel({ id: 'hire', name: 'Hiring' }, { source });
  }

  /**
   * Open a zone panel. `source` says how ('proximity' alone stamps the
   * passport; 'landmark' is a world landmark's way in, which never stamps,
   * for A's P2-A11 and P2-A13). `anchor` opens the panel scrolled to a part
   * of it: a Projects card by its data-project id, or an element id (P2-D5).
   */
  showZonePanel(
    zone: any,
    opts?: {
      /** 'npc': a villager's route button (P2-D4). */
      source?: 'proximity' | 'menu' | 'deeplink' | 'cta' | 'strip' | 'landmark' | 'npc';
      anchor?: string;
    },
  ): void {
    const source = opts?.source ?? 'menu';
    // Inside a hall, its own panel (opened by the door) names the building
    // for the Leave button, when the caller gave no name (P2-D2).
    if (source === 'proximity' && this.leaveBtn && !this.leaveTitled) {
      const name = typeof zone?.name === 'string' ? zone.name.trim() : '';
      if (name && name !== zone?.id) this.setLeaveTitle(name);
    }
    // A switch along the section strip keeps the panel's history mode: a
    // deep-linked card never pushes an entry, and Back from it still leaves.
    const history = source === 'strip' ? this.zoneHistory : source !== 'deeplink';
    this.zoneHistory = history;
    // Short landscape (a phone on its side, height 500 or less): the panel
    // takes the whole height, its nav goes on one row, and the hire card's
    // LinkedIn, CV and Code stay pinned in view (D5, UX-09).
    const compact = window.innerHeight <= 500;
    this.hideZonePanel(); // Hide any existing panel

    this.zonePanelDiv = document.createElement('div');
    Object.assign(this.zonePanelDiv.style, {
      position: 'fixed',
      top: '50%',
      left: '50%',
      transform: 'translate(-50%, -50%)',
      // Opaque: at 0.9 the minimap's labels read through the card's top-left
      // corner on a phone, where the card overlaps the minimap.
      background: 'rgb(0, 0, 0)',
      color: 'white',
      padding: '20px',
      borderRadius: '14px',
      textAlign: 'center',
      pointerEvents: 'auto',
      fontSize: '15px',
      // 1650 (was 1500): the modal band. At 1500 the manager's scrim (1640)
      // would grey out and swallow the panel's own clicks.
      zIndex: '1650',
      // 1px accent, not the old 3px full-alpha frame — the zone hue should
      // sign the panel, not floodlight it.
      border: `1px solid ${this.getZoneColor(zone.id)}`,
      // Explicit width, not just maxWidth: an absolutely-positioned box with
      // no width shrinks-to-fit at HALF its containing block (CSS2 §10.3.7
      // preferred width vs available), so phones rendered the portfolio —
      // the site's core content — in a skinny ~180px ribbon of wrapped text.
      width: 'min(500px, calc(100vw - 24px))',
      boxSizing: 'border-box',
      // 70vh gave a 273 px card at 844x390, the links below the fold.
      maxHeight: compact ? 'calc(100dvh - 24px - var(--sat, 0px) - var(--sab, 0px))' : '70vh',
      overflowY: 'auto',
    });
    // The hire card and the Portfolio panels clear the touch controls too: at
    // z 1650 WAVE/JUMP/USE sat above this modal's scrim, so a tap on them
    // beside the card waved, jumped or fired E at the world (inside a
    // building, at its nearest hotspot) instead of closing the card.
    this.panels.open('zone', {
      kind: 'modal',
      hides: ['nav-chips', 'touch-controls', 'aux-controls'],
      close: () => this.hideZonePanel(),
      el: this.zonePanelDiv,
      // A ?zone= deep link opens on the visitor's landing entry: there is no
      // entry of ours to step back off, and Back from it leaves the site.
      history,
      // 'ds:modal' carries it: closing the hire card says zone 'hire' (P2-D8).
      zone: String(zone?.id ?? 'unknown'),
      // Opened at a card (P2-D5): focus takes that card's heading, so Tab goes
      // on from the project and a screen reader names it. Else the panel's h2.
      ...(opts?.anchor ? { initialFocus: () => this.anchorHeading(opts.anchor ?? '') } : {}),
    });
    this.stepHintAside(true); // nothing paints over a modal (D6)

    const content = this.getZoneContent(zone);
    this.zonePanelDiv.innerHTML = content;
    // A dialog named by its heading; PanelManager focuses that heading once
    // the panel is in, so ↑/↓, PageUp/PageDown and Space scroll it (D4).
    this.zonePanelDiv.setAttribute('role', 'dialog');
    this.zonePanelDiv.setAttribute('aria-modal', 'true');
    const heading = this.zonePanelDiv.querySelector('h2');
    if (heading) {
      heading.id = 'ds-zone-title';
      this.zonePanelDiv.setAttribute('aria-labelledby', heading.id);
    }
    const nav = this.sectionNav(String(zone?.id ?? 'unknown'), compact);
    if (nav) {
      this.zonePanelDiv.prepend(nav);
      this.zonePanelDiv.dataset.zone = String(zone.id);
      this.zonePanelDiv.addEventListener('keydown', this.onSectionKey);
    }
    // Panel thumbnails are lazy + optional: if an image is missing (or blocked)
    // it hides itself rather than showing a broken-image glyph. Attached here
    // (not via an inline onerror handler) so a strict CSP can't neutralise it.
    this.zonePanelDiv.querySelectorAll('img').forEach((img) => {
      img.addEventListener('error', () => {
        (img as HTMLImageElement).style.display = 'none';
      });
    });

    // Funnel: which sections a visitor actually reaches, and the outbound
    // clicks that are the real conversion. Once-per-session so re-opening the
    // same panel doesn't inflate the numbers.
    const zid = String(zone?.id ?? 'unknown');
    // Copy buttons (hire card + contact panel): the address is also on screen
    // as selectable text, so a blocked clipboard still leaves a way to copy.
    this.zonePanelDiv.querySelectorAll<HTMLButtonElement>('button[data-copy]').forEach((b) => {
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        this.copyText(b.dataset.copy ?? '', b, zid);
      });
    });
    // The recruiter highlights tour, demoted to a secondary button inside the
    // hire card. It ends back on this card (main-simple endTour).
    this.zonePanelDiv.querySelector('button[data-hire-tour]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      track('hire_cta', { cta: 'tour' });
      this.hideZonePanel();
      this.onRecruitTour?.();
    });
    // The hire card's second way to reach Abbas: the Contact panel, at its
    // message form (D5).
    this.zonePanelDiv.querySelector('button[data-hire-contact]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      track('hire_cta', { cta: 'message' });
      this.showZonePanel(
        { id: 'contact', name: 'contact' },
        { source: 'cta', anchor: 'lead-form-block' },
      );
    });
    // Selected work: each row opens Projects at that project's card (P2-D5).
    this.zonePanelDiv
      .querySelectorAll<HTMLButtonElement>('button[data-open-project]')
      .forEach((b) => {
        b.addEventListener('click', (e) => {
          e.stopPropagation();
          const project = b.dataset.openProject ?? '';
          track('hire_cta', { cta: `project_${project}` });
          this.showZonePanel(
            { id: 'projects', name: 'projects' },
            { source: 'cta', anchor: project },
          );
        });
      });
    trackOnce('zone_explored', { zone: zid, source });
    // "Reached the actual work" = any real section, not the intro or an unknown.
    if (zid !== 'welcome' && zid !== 'unknown') {
      markReachedPortfolio();
      trackOnce('reached_portfolio', { first: zid });
    }
    if (zone?.id === 'contact') {
      trackOnce('contact_opened');
      // Voice desk goes ABOVE the written form — the lead form's own heading
      // ("Or send a message") already reads as the secondary option.
      const panel = this.zonePanelDiv;
      void import('./ReceptionDesk').then(({ appendReceptionDesk }) => {
        if (this.zonePanelDiv !== panel) return;
        appendReceptionDesk(panel);
        // The desk lands above the form: an anchor on the form re-aims.
        if (opts?.anchor) this.scrollToAnchor(opts.anchor, false);
      });
      this.appendLeadForm(this.zonePanelDiv);
    }

    // Delegated: catches every link in the panel without touching the markup
    this.zonePanelDiv.addEventListener('click', (e) => {
      const a = (e.target as HTMLElement)?.closest?.('a');
      if (a instanceof HTMLAnchorElement && a.href) {
        track('external_link', { to: linkLabel(a.href), from: String(zone?.id ?? 'unknown') });
      }
    });

    // Share footer — the ?zone= deep link has round-tripped for months without
    // a single UI element ever advertising it. Every panel now hands the
    // visitor the link.
    if (zid !== 'unknown') {
      const footer = document.createElement('div');
      footer.style.cssText =
        'margin-top:16px;padding-top:12px;border-top:1px solid rgba(255,255,255,0.12);';
      const hire = zid === 'hire';
      footer.appendChild(
        this.makeShareButton(hire ? '🔗 Share this card' : '🔗 Share this zone', {
          surface: `zone_${zid}`,
          url: buildShareUrl({ zone: zid }),
          title: hire
            ? 'Abbas Ali — AI & software engineer, Melbourne'
            : 'DigiScalability Life Island',
          text: hire
            ? 'Abbas Ali — AI & software engineer, Melbourne. CV, experience and contact:'
            : `Walk through the ${String(zone?.name ?? zid)} zone of this 3D portfolio island:`,
        }),
      );
      this.zonePanelDiv.appendChild(footer);
    }

    // Add close button
    const closeBtn = document.createElement('button');
    closeBtn.textContent = '×';
    Object.assign(closeBtn.style, {
      position: 'absolute',
      top: '10px',
      right: '15px',
      background: 'transparent',
      color: 'white',
      border: 'none',
      fontSize: '24px',
      cursor: 'pointer',
      padding: '0',
      width: '44px', // thumb-sized (was 30px)
      height: '44px',
      borderRadius: '50%',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
    });
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.addEventListener('click', () => this.hideZonePanel());
    // In the sticky nav where there is one, so it never scrolls away.
    if (nav) {
      Object.assign(closeBtn.style, { top: compact ? '4px' : '2px', right: '6px' });
      nav.appendChild(closeBtn);
    } else this.zonePanelDiv.appendChild(closeBtn);

    this.overlay.appendChild(this.zonePanelDiv);
    if (compact) {
      // The hire card's LinkedIn, CV and Code pin under the nav while the
      // card scrolls; every panel that overflows gets a 24 px bottom fade.
      const panel = this.zonePanelDiv;
      const actions = panel.querySelector<HTMLElement>('[data-hire-actions]');
      if (actions) {
        Object.assign(actions.style, {
          position: 'sticky',
          zIndex: '1',
          background: '#000',
          margin: '0 -20px',
          padding: '4px 12px',
          borderBottom: '1px solid rgba(255,255,255,0.12)',
        });
        // Sticky offsets count from inside the panel's 20 px padding (the
        // nav's -20px puts it flush): the bar sits right under the nav.
        actions.style.top = `${(nav ? nav.offsetHeight : 0) - 20}px`;
      }
      this.addScrollFade(panel, '#000');
    }
    if (nav) {
      // A Tab step scrolls its control in clear of the sticky header (and of
      // the pinned action bar in short landscape), never under it (2.4.11).
      const pinned = compact
        ? this.zonePanelDiv.querySelector<HTMLElement>('[data-hire-actions]')
        : null;
      this.zonePanelDiv.style.scrollPaddingTop = `${nav.offsetHeight + (pinned?.offsetHeight ?? 0) + 8}px`;
    }
    // Opened at a card or a block (P2-D5): it scrolls in under the nav.
    if (opts?.anchor) this.scrollToAnchor(opts.anchor, true);

    // Reflect the open zone in the URL so a visitor can copy/share a deep link
    // (e.g. /?zone=projects); cleared again on close. Param-scoped so it never
    // clobbers ?hour=/?theme=.
    setUrlParam('zone', zid);

    // Escape is PanelManager's, which closes only the TOP panel. The panel's
    // own document listener closed it too, under a passport crown stacked over
    // it, taking the Get In Touch form with the crown (INT-02).

    // Passport: stamp ONLY when the visitor physically walked up to the zone
    // ('proximity'). Opening the same panel from the top-right Portfolio menu, a
    // welcome CTA, or a deep link no longer stamps — the 👑 crown now means the
    // island was actually explored, not that five buttons were clicked. The menu
    // still opens every panel, so a hurried recruiter loses no content.
    // LAST, once the panel is whole (INT-02): the fourth stamp fires
    // onComplete, main-simple's reward opens showPassportComplete, and that
    // used to sweep this very panel mid-build, throw on the null panel, and
    // leave the visitor indoors with no content and no Leave pill. The crown
    // now stacks over the panel (allow: ['zone']).
    if (source === 'proximity' && this.passport?.visit(zid)) {
      trackOnce('passport_stamp', { zone: zid, count: this.passport.count() });
      if (!this.zonePanelDiv) return; // a reward that closed the panel after all
      if (!this.passport.isComplete()) {
        const meta = PASSPORT_META[zid as PassportZone];
        // A hint: it would land on the panel this walk-up just opened, so it
        // waits for the panel to close.
        this.toast(
          `🛂 Passport stamped: ${meta.label} (${this.passport.count()}/${this.passport.total()})`,
          { hint: true },
        );
      }
    }
  }

  /** The section a switch keeps: whether the open zone panel pushes history. */
  private zoneHistory = true;
  /** The menu row '‹ Portfolio' asks the next menu to focus. */
  private menuFocusSection: string | null = null;

  /** The portfolio sections, in the strip's order (D5, UX-08). */
  private static readonly SECTIONS: ReadonlyArray<{ id: string; label: string }> = [
    { id: 'hire', label: 'Hiring' },
    { id: 'welcome', label: 'About' },
    { id: 'professional', label: 'Professional' },
    { id: 'projects', label: 'Projects' },
    { id: 'personal', label: 'Personal' },
    { id: 'contact', label: 'Contact' },
  ];

  /**
   * A portfolio section's sticky header (D5, UX-08): '‹ Portfolio' back to
   * the menu, at this section's row, and a strip with every section one
   * action away (44 px chips on a phone). ← and → switch sections while the
   * panel has focus. Reading Hire, Professional, Projects and Contact took 12
   * clicks on desktop and 16 taps on a phone. Null for other zones.
   */
  private sectionNav(zid: string, compact: boolean): HTMLElement | null {
    const sections = SimpleUI.SECTIONS;
    const at = sections.findIndex((s) => s.id === zid);
    if (at < 0) return null;
    const h = this.isTouch ? 44 : 32;
    const nav = document.createElement('div');
    nav.dataset.panelNav = '1';
    Object.assign(nav.style, {
      position: 'sticky',
      top: '-20px', // the panel's 20 px padding: flush with the scrollport's edge
      zIndex: '2',
      margin: '-20px -20px 14px',
      // One row in short landscape leaves the × room at its end; on two rows
      // the × shares the first with '‹ Portfolio' and the strip gets the width.
      padding: compact ? '8px 56px 8px 12px' : '8px 12px',
      background: '#000',
      borderBottom: '1px solid rgba(255,255,255,0.12)',
      display: 'flex',
      flexDirection: compact ? 'row' : 'column',
      alignItems: compact ? 'center' : 'flex-start',
      gap: compact ? '8px' : '6px',
      textAlign: 'left',
    });
    const back = document.createElement('button');
    back.type = 'button';
    back.dataset.navBack = '1';
    back.textContent = '‹ Portfolio';
    Object.assign(back.style, {
      flex: 'none',
      minHeight: `${h}px`,
      padding: '0 12px',
      borderRadius: '10px',
      background: 'transparent',
      color: '#cfe0ff',
      border: '1px solid rgba(255,255,255,0.18)',
      fontSize: '13px',
      fontWeight: '600',
      cursor: 'pointer',
    });
    back.addEventListener('click', (e) => {
      e.stopPropagation();
      this.menuFocusSection = zid; // the menu opens with this row focused
      this.togglePortfolioMenu(); // it closes this panel first
    });
    nav.appendChild(back);
    const strip = document.createElement('nav');
    strip.setAttribute('aria-label', 'Portfolio sections');
    Object.assign(strip.style, {
      display: 'flex',
      gap: '5px',
      overflowX: 'auto',
      maxWidth: '100%',
      minWidth: '0',
      scrollbarWidth: 'none',
    });
    const accent = this.getZoneColor(zid);
    for (const s of sections) {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.goto = s.id;
      b.textContent = s.label;
      const here = s.id === zid;
      if (here) b.setAttribute('aria-current', 'page');
      Object.assign(b.style, {
        flex: 'none',
        minHeight: `${h}px`,
        padding: this.isTouch ? '0 14px' : '0 11px',
        borderRadius: '999px',
        background: here ? 'rgba(255,255,255,0.08)' : 'transparent',
        color: here ? '#fff' : '#b8c4d6',
        border: `1px solid ${here ? accent : 'rgba(255,255,255,0.14)'}`,
        fontSize: '13px',
        fontWeight: here ? '700' : '600',
        cursor: here ? 'default' : 'pointer',
      });
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!here) this.switchSection(s.id);
      });
      strip.appendChild(b);
    }
    nav.appendChild(strip);
    // Keep this section's chip in view on a narrow strip.
    requestAnimationFrame(() => {
      const cur = strip.querySelector<HTMLElement>('[aria-current]');
      if (cur && strip.scrollWidth > strip.clientWidth) {
        strip.scrollLeft = cur.offsetLeft - strip.clientWidth / 2 + cur.offsetWidth / 2;
      }
    });
    return nav;
  }

  /** ← / → between sections while the panel has focus (not in a text field). */
  private onSectionKey = (e: KeyboardEvent): void => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    const zid = this.zonePanelDiv?.dataset.zone;
    const sections = SimpleUI.SECTIONS;
    const at = sections.findIndex((s) => s.id === zid);
    if (at < 0) return;
    e.preventDefault();
    e.stopPropagation(); // the world never takes the arrow either
    const step = e.key === 'ArrowRight' ? 1 : -1;
    this.switchSection(sections[(at + step + sections.length) % sections.length].id);
  };

  /** One action per section: the zone param follows, scrollTop starts at 0. */
  private switchSection(id: string): void {
    this.showZonePanel({ id, name: id }, { source: 'strip' });
  }

  /** The open panel's anchor: a Projects card by data-project, else an id. */
  private anchorTarget(anchor: string): HTMLElement | null {
    const panel = this.zonePanelDiv;
    // Ids only (A's landmarks pass theirs through): no selector syntax.
    if (!panel || !/^[a-z][\w-]*$/i.test(anchor)) return null;
    return panel.querySelector<HTMLElement>(`[data-project="${anchor}"], #${anchor}`);
  }

  /** The anchor's own heading takes focus: never a field (no phone keyboard). */
  private anchorHeading(anchor: string): HTMLElement | null {
    const target = this.anchorTarget(anchor);
    return target?.querySelector<HTMLElement>('h3, h4') ?? target;
  }

  /** Where scrollToAnchor last left the panel's scroller. */
  private anchorScrollTop = -1;

  /**
   * Scroll the open panel so its anchor's top sits just under the sticky
   * section nav (P2-D5), then ring its border once, never under reduced
   * motion. `first` false re-aims after content lands above the anchor (the
   * reception desk above the message form), unless the scroller has moved
   * since: the visitor's own scroll, or the browser's scroll anchoring that
   * already kept the anchor in place.
   */
  private scrollToAnchor(anchor: string, first: boolean): void {
    const panel = this.zonePanelDiv;
    const target = this.anchorTarget(anchor);
    if (!panel || !target) return;
    if (!first && panel.scrollTop !== this.anchorScrollTop) return;
    const nav = panel.querySelector<HTMLElement>('[data-panel-nav]');
    const below = panel.getBoundingClientRect().top + panel.clientTop + (nav?.offsetHeight ?? 0);
    panel.scrollTop += target.getBoundingClientRect().top - below - 8;
    this.anchorScrollTop = panel.scrollTop;
    if (!first || a11y.reducedMotion || typeof target.animate !== 'function') return;
    // A ring drawn once, of which only the opacity moves (perfBudget: transform
    // and opacity only; animating the outline repainted it every frame). It
    // sits 3 px outside the card, 2 px wide, on the card's radius; the plain
    // rows (digiscalability, banos, insta) ring square, as before.
    const cs = getComputedStyle(target);
    const radius = parseFloat(cs.borderTopLeftRadius) || 0;
    // An absolute inset counts from inside the card's border: 5 px past it.
    const out = (side: 'Top' | 'Right' | 'Bottom' | 'Left'): string =>
      `${-5 - (parseFloat(cs[`border${side}Width`]) || 0)}px`;
    const ring = document.createElement('div');
    ring.dataset.anchorRing = '1';
    ring.setAttribute('aria-hidden', 'true');
    Object.assign(ring.style, {
      position: 'absolute',
      top: out('Top'),
      right: out('Right'),
      bottom: out('Bottom'),
      left: out('Left'),
      borderRadius: radius ? `${radius + 5}px` : '0',
      border: '2px solid rgba(255, 212, 121, 0.95)',
      boxShadow: '0 0 18px rgba(255, 212, 121, 0.33)',
      pointerEvents: 'none',
      opacity: '0',
    });
    const placed = cs.position === 'static'; // the ring's containing block
    if (placed) target.style.position = 'relative';
    target.appendChild(ring);
    const done = (): void => {
      ring.remove();
      if (placed) target.style.position = '';
    };
    const run = ring.animate([{ opacity: 0 }, { opacity: 1, offset: 0.35 }, { opacity: 0 }], {
      duration: 1400,
      easing: 'ease-in-out',
    });
    if (run) {
      run.onfinish = done;
      run.oncancel = done;
    } else done();
  }

  /**
   * A 24 px fade at the bottom of a scroller that overflows, gone at the end
   * (D5, UX-09: no scroll cue anywhere in short landscape).
   */
  private addScrollFade(scroller: HTMLElement, bg: string): void {
    const fade = document.createElement('div');
    fade.dataset.scrollFade = '1';
    fade.setAttribute('aria-hidden', 'true');
    // Flush with the scroller's bottom edge. A sticky inset counts from inside
    // the scroller's padding (the nav's top: -20px is the same rule), so
    // bottom 0 floated the fade 20 px up, over the labels of the hire card's
    // LinkedIn, CV and Code at 844x390.
    const pad = parseFloat(getComputedStyle(scroller).paddingBottom) || 0;
    Object.assign(fade.style, {
      position: 'sticky',
      bottom: `${-pad}px`,
      height: '24px',
      marginTop: '-24px',
      pointerEvents: 'none',
      background: `linear-gradient(to bottom, rgba(0,0,0,0), ${bg})`,
      zIndex: '1',
      opacity: '0',
    });
    scroller.appendChild(fade);
    const place = (): void => {
      const end = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2;
      fade.style.opacity = scroller.scrollHeight > scroller.clientHeight + 2 && !end ? '1' : '0';
    };
    scroller.addEventListener('scroll', place, { passive: true });
    requestAnimationFrame(place);
    // Content that lands later (a board's rows and its Guide me, after an
    // await) went in below the fade, which then rode above it and stayed
    // hidden until a scroll: the fade moves back to the end (before a panel
    // note, which must stay legible) and re-measures once the content is in.
    let queued = false;
    const observer = new MutationObserver(() => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        if (!scroller.isConnected) {
          observer.disconnect();
          return;
        }
        const note =
          Array.from(scroller.children).find(
            (c) => c instanceof HTMLElement && c.dataset.panelNote === '1',
          ) ?? null;
        if (fade.nextElementSibling !== note) scroller.insertBefore(fade, note);
        place();
      });
    });
    observer.observe(scroller, { childList: true, subtree: true });
  }

  /**
   * Hide zone interaction panel
   */
  hideZonePanel(): void {
    if (this.zonePanelDiv) {
      // Hang up first: removing the panel DOM does not close the agent's
      // WebSocket, so a visitor who walks away mid-call would otherwise leave
      // it listening — and billing — until the 300s agent-side ceiling.
      // Import only if the module was already loaded (contact panel opened).
      void import('./ReceptionDesk').then((m) => m.stopReceptionCall());
      this.zonePanelDiv.remove();
      this.zonePanelDiv = null;
      this.panels.notifyClosed('zone');
      // Drop ONLY the ?zone= deep link when the panel closes — the old
      // whole-search wipe also destroyed ?hour=/?theme=.
      setUrlParam('zone', null);
    }
  }

  /**
   * Get color for zone
   */
  private getZoneColor(zoneId: string): string {
    // The hire card is a panel, not a district: it signs itself in the amber
    // of the Hiring pill that opens it.
    if (zoneId === 'hire') return '#ffd479';
    // Derive from the single DISTRICTS source of truth (was a hardcoded hex-string
    // copy that could drift from the 3D markers + minimap dots).
    const d = DISTRICTS.find((x) => x.id === zoneId);
    return d ? `#${d.color.toString(16).padStart(6, '0')}` : '#666';
  }

  /**
   * Copy text (the contact email) and say so ON THE BUTTON — a toast would
   * land over or under the open panel. Clipboard API first; when it is blocked
   * (permissions, insecure context, old WebViews) the on-screen address is
   * SELECTED instead, so Ctrl/Cmd+C or the OS menu finishes the job.
   */
  private copyText(text: string, btn: HTMLButtonElement, from: string): void {
    // The resting label, captured ONCE: a second click inside the 2 s window
    // would otherwise capture "Copied ✓" and leave it stuck there.
    const label = (btn.dataset.label ??= btn.textContent ?? 'Copy');
    const settle = (msg: string): void => {
      btn.textContent = msg;
      window.setTimeout(() => {
        btn.textContent = label;
      }, 2000);
    };
    const selectInstead = (): void => {
      try {
        const target = btn.parentElement?.querySelector('[data-email]');
        const sel = window.getSelection();
        if (target && sel) {
          const range = document.createRange();
          range.selectNodeContents(target);
          sel.removeAllRanges();
          sel.addRange(range);
        }
      } catch {
        /* selection unsupported — the address is still visible */
      }
      track('email_copied', { from, ok: false });
      settle('Selected — copy it');
    };
    try {
      void navigator.clipboard.writeText(text).then(() => {
        track('email_copied', { from, ok: true });
        settle('Copied ✓');
      }, selectInstead);
    } catch {
      selectInstead(); // navigator.clipboard is undefined outside secure contexts
    }
  }

  /**
   * Get content for zone
   */
  /**
   * A link's or a button's label in the chrome (D13): a leading emoji becomes
   * the sprite's icon. CV and Hiring differ (file-user, file-text), and so do
   * Code and Source (code, source). A label with no known emoji is unchanged.
   */
  private static iconLabel(label: string): string {
    const m = /^(\p{Extended_Pictographic}\uFE0F?|↗)\s*(.+)$/u.exec(label);
    if (!m) return label;
    const [, mark, text] = m;
    const pick: Record<string, IconName> = {
      '🔗': 'user',
      '📄': 'file-user',
      '💻': /\bsource\b/i.test(text) ? 'source' : 'code',
      '🌐': 'link',
      '🧭': 'compass',
      '↗': 'external',
      '▶️': 'play',
      '▶': 'play',
      '📸': 'camera',
      '✉️': 'mail',
      '✉': 'mail',
      '🎬': 'play',
    };
    const name = pick[mark];
    return name ? `${icon(name, 16)}<span>${text}</span>` : label;
  }

  private getZoneContent(zone: any): string {
    // Shared button styles for the clickable portfolio links. Links are the
    // owner's own curated URLs (a visitor chooses to click), opened in a new
    // tab with rel=noopener — the portfolio's whole point is to be actionable.
    // `small` is the second-rank row (socials, the pre-launch demo).
    const link = (
      href: string,
      label: string,
      opts: { primary?: boolean; small?: boolean } = {},
    ): string => {
      // 44px thumb targets on touch: the links measured 37-39 (phone.cjs).
      const base =
        'display:inline-flex;align-items:center;gap:6px;margin:5px 6px 5px 0;padding:9px 15px;border-radius:10px;text-decoration:none;font-size:14px;transition:transform 0.1s ease;' +
        (this.isTouch ? 'min-height:44px;box-sizing:border-box;' : '');
      const size = opts.small
        ? `padding:${this.isTouch ? '9px 12px' : '6px 11px'};font-size:13px;`
        : '';
      const style = opts.primary
        ? base + size + `background:${DS.primary};color:#fff;font-weight:600;border:none;`
        : base + size + 'background:#2a2a37;color:#e8e8f0;border:1px solid rgba(255,255,255,0.14);';
      const cls = opts.primary ? ' class="ds-press"' : '';
      return `<a href="${href}" target="_blank" rel="noopener noreferrer"${cls} style="${style}">${SimpleUI.iconLabel(label)}</a>`;
    };
    // Counted from the client roster, never typed: the panel said 18 while the
    // roster (and the server personas it must match) had grown to 24.
    const aiCount = Object.keys(AI_NPCS).length;
    // The address as SELECTABLE TEXT plus a Copy button (wired in
    // showZonePanel). It used to exist only inside a mailto: button, which
    // does nothing visible on a machine with no mail client.
    const emailRow = (withMailto: boolean): string => `
      <div style="display:flex;align-items:center;justify-content:center;flex-wrap:wrap;gap:8px;margin:10px 0 6px;">
        <span data-email style="user-select:all;-webkit-user-select:all;cursor:text;font-size:15px;font-weight:600;color:#fff;
          background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.16);border-radius:8px;padding:8px 12px;">${OWNER.email}</span>
        <button type="button" data-copy="${OWNER.email}" title="Copy the email address" style="${this.isTouch ? 'min-height:44px;' : ''}padding:8px 14px;border-radius:8px;
          border:1px solid rgba(120,160,255,0.45);background:rgba(80,130,255,0.18);color:#cfe0ff;font-size:14px;font-weight:600;cursor:pointer;">Copy</button>
        ${withMailto ? link(`mailto:${OWNER.email}`, '✉️ Email', { small: true }) : ''}
      </div>`;
    // One work-history row: role (+ where) left, dates right.
    const xp = (role: string, where: string, when: string): string =>
      `<li style="display:flex;justify-content:space-between;align-items:baseline;gap:10px;padding:6px 0;border-top:1px solid rgba(255,255,255,0.08);">
        <span><strong>${role}</strong>${where ? `, ${where}` : ''}</span>
        <span style="white-space:nowrap;color:#aab6c8;font-size:13px;">${when}</span></li>`;
    const chip = (t: string): string =>
      `<span style="background:#33333f;padding:5px 11px;border-radius:15px;font-size:13px;">${t}</span>`;
    // Optional lazy thumbnail — hidden by the error handler in showZonePanel if
    // the asset isn't present, so the panels never depend on the images shipping.
    // Its intrinsic size reserves the box before it loads: a lazy load grew the
    // card under a Projects panel opened at a lower card (P2-D5).
    const thumb = (src: string, alt: string, w: number, h: number): string =>
      `<img src="${src}" alt="${alt}" loading="lazy" width="${w}" height="${h}" style="width:100%;height:auto;max-height:150px;object-fit:cover;
        object-position:top;border-radius:10px;margin:8px 0 4px;display:block;border:1px solid rgba(255,255,255,0.08);" />`;
    // `project`: the card's data-project id, the anchor the hire card's
    // Selected work rows open Projects at (P2-D5).
    const card = (inner: string, project?: string): string =>
      `<div${project ? ` data-project="${project}"` : ''} style="background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.1);
        border-radius:12px;padding:14px;margin:12px 0;text-align:left;">${inner}</div>`;
    // One Selected work row: an outline button that opens Projects at a card.
    const workRow = (project: string, name: string, status: string): string =>
      `<button type="button" data-open-project="${project}" style="display:flex;justify-content:space-between;align-items:center;gap:10px;width:100%;margin:6px 0 0;${
        this.isTouch ? 'min-height:44px;' : ''
      }padding:9px 12px;border-radius:10px;background:transparent;color:#e8edf5;border:1px solid rgba(255,212,121,0.4);font-size:14px;text-align:left;cursor:pointer;">
        <span><strong>${name}</strong> · ${status}</span><span aria-hidden="true" style="color:#ffd479;">›</span></button>`;

    const contents: { [key: string]: string } = {
      welcome: `
        <h2 style="margin-top: 0; color: #4CAF50;">🏝️ Welcome to Life Island</h2>
        <p>This island is <strong>Abbas Ali's portfolio</strong>: a living 3D world, hand-built
        in Three.js and TypeScript, where ${aiCount} villagers talk through Claude Haiku 4.5.
        It's live and open source (MIT).</p>
        <p style="text-align:left;margin-bottom:4px;">Follow the
        <strong style="color:#ffd54a;">➤ compass</strong> to each district, or just wander:</p>
        <ul style="text-align: left; display: inline-block; line-height:1.7;margin-top:4px;">
          <li>💼 <strong>Professional</strong> — experience, stack and education</li>
          <li>🚀 <strong>Projects</strong> — this island, RankPilot (pre-launch) &amp; more</li>
          <li>🎨 <strong>Personal</strong> — kitchens, family recipes, creative tools</li>
          <li>📬 <strong>Contact</strong> — hiring, or have a project?</li>
        </ul>
        <p style="margin-top:12px; font-size:14px; color:#cdd;">🛂 Visit all four
        <em>in person</em> to stamp your <strong>Passport</strong> and earn the Founder's Crown 👑.</p>
        <p style="margin-top: 12px; font-size:13px; color:#aaa;"><em>${
          this.isTouch
            ? 'Drag the joystick to move, swipe to look, 👆 USE to interact'
            : 'WASD to move, drag or J/L to look, E to interact'
        }. Swim, and drive the boats, jetskis &amp; cars around the island.</em></p>
      `,
      professional: `
        <h2 style="margin-top: 0; color: #2196F3;">💼 Professional</h2>
        <p><strong>Abbas Ali</strong> — AI &amp; software engineer, Melbourne.</p>
        <p style="font-size:14px;">I build AI products end to end and make them safe to put in
        front of the public: the model call and its guardrails, the realtime client, the cloud
        functions and the tests.</p>
        <p style="font-size:14px;color:#bcd;background:rgba(90,140,255,0.12);
          border-radius:10px;padding:8px 12px;margin:10px 0;">🛠️ <strong>Now:</strong>
          founder &amp; lead developer at DigiScalability (solo, since Jan 2025), building this
          open-source (MIT) island, digiscalability.com and RankPilot (pre-launch). Before that:
          software engineer (remote contract) at TechNova Solutions, Dec 2023 – Nov 2024.</p>
        <h3 style="margin-bottom:8px;">Core Stack</h3>
        <div style="display: flex; flex-wrap: wrap; gap: 8px; justify-content: center; margin: 12px 0 18px;">
          ${chip('TypeScript')} ${chip('React')} ${chip('Next.js')} ${chip('Three.js')}
          ${chip('Firebase / GCP')} ${chip('Claude API')} ${chip('PostgreSQL')}
          ${chip('Docker')} ${chip('GitHub Actions')}
        </div>
        <h3 style="margin-bottom:6px;">Education</h3>
        <p style="font-size:14px;margin:0 0 4px;">BSc Computer Science, SZABIST, Islamabad (2016)</p>
        <p style="font-size:14px;margin:0;">Master of Information Technology (coursework), Deakin
        University, 2017–2019: 11 of 16 credit points completed</p>
        <div style="margin-top:16px;">
          ${link(OWNER.linkedin, '🔗 LinkedIn', { primary: true })}
          ${link(OWNER.cv, '📄 CV')}
          ${link(OWNER.repo, '💻 GitHub')}
          ${link('https://digiscalability.com', '🌐 digiscalability.com')}
        </div>
        ${emailRow(true)}
      `,
      projects: `
        <h2 style="margin-top: 0; color: #FF9800;">🚀 Projects</h2>
        ${card(
          `
          <h3 style="margin:0 0 2px;">🏝️ This Island <span style="font-size:12px;color:#ffd479;">● you are standing in it</span></h3>
          <p style="margin:6px 0;font-size:14px;">The flagship: a multiplayer 3D world (Three.js +
          TypeScript) where <strong>${aiCount} villagers talk through Claude Haiku 4.5</strong>. A
          scheduled planner agent assigns their jobs each morning, they follow real daily schedules
          (and sleep in the cottages at night), and a nightly analyst agent (Claude Sonnet) emails a
          usage digest and files GitHub issues about its own island.</p>
          <p style="margin:6px 0;font-size:13px;color:#cdd6e4;">Three.js + TypeScript + Firebase +
          Claude · open source (MIT) · ~280 KB app + 175 KB three.js (brotli) · a hard
          monthly token cap on the model calls.</p>
          <p style="margin:6px 0;font-size:13px;color:#cdd6e4;">Proof it runs itself: read the
          📰 Island Times (Portfolio menu) — compiled nightly by the analyst — or walk up to a
          villager and ask what they're doing today.</p>
          <div style="margin-top:8px;">
            ${link(OWNER.repo, '💻 Source')}
            ${link(`${OWNER.repo}#how-it-is-built`, "🧭 How it's built")}
          </div>
        `,
          'island',
        )}
        ${card(`
          <h3 style="margin:0 0 6px;">🛡️ How the AI is kept safe and cheap</h3>
          <ul style="margin:0;padding-left:18px;font-size:13px;line-height:1.5;">
            <li><strong>The key stays server-side.</strong> Claude Haiku 4.5 is called from a
            Firebase callable function that enforces App Check; the API key lives in Secret
            Manager, never in the browser.</li>
            <li><strong>Hard caps.</strong> Per-IP burst limits (anonymous IDs are free to mint, so
            limits are keyed by IP) and a monthly token cap. When either trips, the villager falls
            back to its scripted lines.</li>
            <li><strong>Visitor text is data.</strong> The persona rules treat what you type as a
            traveller's words, never as instructions, and it never joins the system prompt.</li>
            <li><strong>Moderation both ways.</strong> A filter checks the visitor's message before
            the model sees it, and the model's reply before it reaches the page.</li>
            <li><strong>The planner can't write prose.</strong> The daily planner may only choose ids
            from fixed pools; its reply is validated and unknown ids are dropped, so no planner text
            reaches a public surface.</li>
          </ul>
          <div style="margin-top:8px;">
            ${link(`${OWNER.repo}#for-reviewers-10-min`, '🧭 Read the architecture')}
            ${link(`${OWNER.repo}/blob/main/functions/src/index.ts`, '💻 See the code')}
          </div>
        `)}
        ${card(
          `
          <h3 style="margin:0 0 2px;">📈 RankPilot <span style="font-size:12px;color:#ffcc80;">● live, pre-launch</span></h3>
          <p style="margin:6px 0;font-size:14px;"><strong style="color:#ffcc80;">Problem:</strong>
          search is shifting from ten blue links to AI answers — and most sites are invisible to
          the models doing the answering.</p>
          <p style="margin:6px 0;font-size:14px;"><strong style="color:#ffcc80;">Built:</strong>
          a platform that audits a site's schema, content &amp; LLM-readiness and shows exactly
          what to fix. Solo build.</p>
          <p style="margin:6px 0;font-size:13px;color:#cdd6e4;"><strong>Status:</strong> live, pre-launch: no users beyond test accounts.</p>
          <div style="margin-top:6px;">${link('https://rankpilot-h3jpc.web.app', '↗ Pre-launch demo', { small: true })}</div>
        `,
          'rankpilot',
        )}
        ${card(
          `
          <h3 style="margin:0 0 2px;">🍫 ChocoMate <span style="font-size:12px;color:#aab;">● paused</span></h3>
          ${thumb('/assets/panels/chocomate.webp', 'ChocoMate storefront', 820, 384)}
          <p style="margin:6px 0;font-size:14px;">Direct-to-consumer chocolate brand —
          the storefront, brand system, and content pipeline, end to end. Paused.</p>
          <div style="margin-top:6px;">${link('https://chocomate.au', '↗ chocomate.au', { small: true })}</div>
        `,
          'chocomate',
        )}
        <div style="text-align:left;">
          <div data-project="digiscalability">
          <h3 style="margin-bottom:4px;margin-top:14px;">🌐 digiscalability.com</h3>
          <p style="margin-top:4px;font-size:14px;">My business site, built solo: Next.js 15 +
          Firebase on Vercel.
          ${link('https://digiscalability.com', '↗ digiscalability.com')}</p>
          </div>
          <div data-project="banos">
          <h3 style="margin-bottom:4px;margin-top:14px;">📖 Bano's Cookbook</h3>
          <p style="margin-top:4px;font-size:14px;">Digitising my mother's (Ammi's) handwritten recipes from 1981.</p>
          </div>
          <div data-project="insta">
          <h3 style="margin-bottom:4px;margin-top:14px;">🧰 Insta Services API</h3>
          <p style="margin-top:4px;font-size:14px;">Modernising an inherited 2016 Java system
          (Java API + Android app) with login rate limiting, health checks and nightly
          backups.</p>
          </div>
        </div>
        ${emailRow(true)}
      `,
      personal: `
        <h2 style="margin-top: 0; color: #E91E63;">🎨 Personal</h2>
        <p>Melbourne, Victoria. Not everything here is software: those cottages are the
        Personal district, the market stalls nod to the food side, and the family recipes
        are real.</p>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin: 16px 0; text-align:left;">
          <div><h3 style="margin:0 0 4px;">🍽️ Kitchens</h3>
            <p style="font-size:14px;">Chef at Mr. Miyagi and Baxter Tavern, Melbourne,
            2019 – 2024.</p></div>
          <div><h3 style="margin:0 0 4px;">📖 Family Heritage</h3>
            <p style="font-size:14px;">Preserving my mother's (Ammi's) handwritten recipes from 1981 — the heart behind Bano's Cookbook.</p></div>
          <div><h3 style="margin:0 0 4px;">🎬 Creative Tooling</h3>
            <p style="font-size:14px;">Blender, DaVinci Resolve, ComfyUI — a full studio
            for product storytelling and 3D worlds like this one.</p></div>
          <div><h3 style="margin:0 0 4px;">📚 Always Learning</h3>
            <p style="font-size:14px;">BSc Computer Science (SZABIST, 2016), and Master of IT
            coursework at Deakin: 11 of 16 credit points completed.</p></div>
        </div>
        <div style="margin-top:8px;">
          ${link('https://youtube.com/@DigiScalability', '▶️ Creative builds', { primary: true })}
          ${link('https://instagram.com/digiscalability', '📸 Instagram')}
        </div>
        ${emailRow(true)}
      `,
      contact: `
        <h2 style="margin-top: 0; color: #9C27B0;">📬 Get In Touch</h2>
        <p style="font-size:17px;font-weight:600;margin:0 0 6px;">Hiring, or have a project? This reaches me directly.</p>
        ${emailRow(true)}
        <div style="margin: 12px 0 2px; display:flex; flex-wrap:wrap; justify-content:center;">
          ${link(OWNER.linkedin, '🔗 LinkedIn', { primary: true })}
          ${link(OWNER.repo, '💻 GitHub')}
          ${link(OWNER.cv, '📄 CV')}
        </div>
        <div style="margin: 0 0 6px; display:flex; flex-wrap:wrap; justify-content:center;">
          ${link('https://x.com/digiscalability', '𝕏 Twitter', { small: true })}
          ${link('https://instagram.com/digiscalability', '📸 Instagram', { small: true })}
          ${link('https://youtube.com/@DigiScalability', '▶️ YouTube', { small: true })}
        </div>
        <p style="font-size:13px; color:#999;">Melbourne, Victoria. X, Instagram and YouTube
        are @digiscalability; LinkedIn is my personal profile.</p>
      `,
      // The recruiter front door (showHireCard / ?zone=hire). Copy comes from
      // the approved fact sheet only. The availability line appears HERE and
      // nowhere else in the app. LinkedIn leads (filled), then CV, then Code:
      // the fact sheet makes LinkedIn the primary hiring link, and hire.html
      // and digiscalability.com/about lead with it too.
      hire: `
        <div style="font-size:12px;letter-spacing:1.2px;text-transform:uppercase;color:#ffd479;font-weight:700;margin:0 0 6px;display:flex;align-items:center;justify-content:center;gap:6px;">${icon('file-text', 16)}<span>Hiring?</span></div>
        <h2 style="margin:0 0 2px;color:#fff;font-family:var(--font-display, 'Bebas Neue', sans-serif);font-weight:400;font-size:40px;line-height:1.05;letter-spacing:0.5px;">Abbas Ali</h2>
        <p style="margin:0 0 10px;font-size:15px;font-weight:600;color:#cfe0ff;">AI &amp; software engineer · Melbourne</p>
        <p style="margin:0 0 12px;font-size:14px;line-height:1.55;color:#dde3ee;">I build AI
        products end to end and make them safe to put in front of the public: the model call and
        its guardrails, the realtime client, the cloud functions and the tests.</p>
        <p style="margin:0 0 10px;padding:9px 12px;border-radius:10px;background:rgba(18,183,106,0.14);border:1px solid rgba(120,220,170,0.4);font-size:14px;line-height:1.45;color:#d7f5e6;">
          Open to AI and software engineering roles in Melbourne (full-time or contract).</p>
        <div data-hire-actions style="display:flex;flex-wrap:wrap;justify-content:center;">
          ${link(OWNER.linkedin, '🔗 LinkedIn', { primary: true })}
          ${link(OWNER.cv, '📄 CV')}
          ${link(OWNER.repo, '💻 Code')}
        </div>
        ${emailRow(false)}
        <div style="display:flex;flex-wrap:wrap;justify-content:center;gap:8px;margin:10px 0 0;">
          <button type="button" data-hire-contact style="flex:1 1 180px;${this.isTouch ? 'min-height:44px;' : ''}padding:10px 14px;border-radius:10px;
            background:rgba(38,38,51,0.5);color:#dfe6f2;border:1px solid rgba(255,212,121,0.45);font-size:14px;font-weight:600;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:7px;">
            ${icon('send', 16)}<span>Send a message</span></button>
          <button type="button" data-hire-tour style="flex:1 1 180px;${this.isTouch ? 'min-height:44px;' : ''}padding:10px 14px;border-radius:10px;
            background:rgba(38,38,51,0.5);color:#dfe6f2;border:1px solid rgba(255,255,255,0.16);font-size:14px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:7px;">
            ${icon('play', 16)}<span>Or watch the highlights tour (under a minute)</span></button>
        </div>
        <div data-selected-work style="margin:16px 0 0;text-align:left;">
          <h3 style="margin:0 0 2px;font-size:15px;">Selected work</h3>
          ${workRow('island', 'This island', 'open source (MIT)')}
          ${workRow('rankpilot', 'RankPilot', 'live, pre-launch: no users beyond test accounts')}
          ${workRow('digiscalability', 'digiscalability.com', 'Next.js 15 + Firebase')}
        </div>
        <p data-education style="margin:14px 0 0;font-size:13px;line-height:1.5;text-align:left;color:#dde3ee;">
          <strong>Education:</strong> BSc Computer Science, SZABIST, Islamabad (2016) · Master of
          Information Technology (coursework), Deakin University, 2017–2019: 11 of 16 credit points
          completed</p>
        <h3 style="margin:16px 0 4px;font-size:15px;text-align:left;">Experience</h3>
        <ul style="margin:0;padding:0;list-style:none;text-align:left;font-size:13px;line-height:1.45;">
          ${xp('Founder &amp; lead developer', 'DigiScalability, Melbourne', 'Jan 2025 – present')}
          ${xp('Software engineer (remote contract)', 'TechNova Solutions', 'Dec 2023 – Nov 2024')}
          ${xp('Chef', 'Mr. Miyagi and Baxter Tavern, Melbourne', '2019 – 2024')}
          ${xp('Software developer', 'Event Technologies, Islamabad', 'Oct 2016 – Sep 2017')}
          ${xp('Freelance full-stack developer', '', 'Aug 2015 – Oct 2017')}
        </ul>
        <h3 style="margin:16px 0 6px;font-size:15px;text-align:left;">Guardrails I ship, in this island's open-source (MIT) code</h3>
        <ul style="margin:0;padding-left:18px;text-align:left;font-size:13px;line-height:1.5;">
          <li>${aiCount} villagers talk through Claude Haiku 4.5 behind a Firebase callable: the API
          key lives in Secret Manager, and App Check guards the call.</li>
          <li>Per-IP burst limits (anonymous IDs are free to mint, so limits are keyed by IP) and a
          hard monthly token cap that falls back to scripted lines.</li>
          <li>Moderation on input and output; visitor text is fenced as data, never instructions.</li>
          <li>A scheduled planner picks each day's jobs and events by index from pre-written pools;
          ids are validated on server and client, so no planner text reaches a public surface.</li>
          <li>A Vitest suite, typecheck, lint and Prettier run in CI (GitHub Actions) on every push.</li>
        </ul>
      `,
    };

    // The fallback takes a ?zone= deep link's own text: escaped (security).
    return (
      contents[zone.id] ||
      `<h2>${this.escapeHtml(zone.name)}</h2><p>${this.escapeHtml(zone.description)}</p>`
    );
  }

  /**
   * Show dialogue panel with typewriter effect (Messenger-inspired)
   */
  private npcChatDiv: HTMLDivElement | null = null;
  private npcTypeTimer = 0;
  private npcSttStop: (() => void) | null = null;
  /**
   * Free-text conversation panel for an AI-brained NPC. Shows an opening line, a
   * scrolling transcript and a text input; on send it calls `onSend(text)` —
   * which routes to the server brain and returns the line to display (a real
   * reply, or a canned fallback) — showing a "…" thinking state meanwhile. NPC
   * lines TYPE OUT character-by-character and are SPOKEN in the NPC's voice (per
   * `voice` rate/pitch, free on-device TTS) unless muted. Input keystrokes are
   * stopped from reaching the game's movement handlers.
   */
  public showNpcChat(
    name: string,
    opening: string,
    onSend: (text: string) => Promise<string>,
    voice: { rate: number; pitch: number; variant: number } = { rate: 1, pitch: 1, variant: 0 },
  ): void {
    this.closeNpcChat();
    // (reduced-motion is read per line inside npcLine, not cached here — a
    // cached copy left the ♿ toggle stale for the life of the panel)
    const panel = document.createElement('div');
    Object.assign(panel.style, {
      position: 'absolute',
      left: '50%',
      // --sab: the only bottom-anchored surface that omitted it — on
      // home-indicator phones the panel bottomed into the unsafe swipe zone.
      bottom: 'calc(var(--sab, 0px) + 28px)',
      transform: 'translateX(-50%)',
      width: 'min(560px, 92%)',
      background: 'rgba(10,10,20,0.94)',
      color: '#f0f0f0',
      borderRadius: '16px',
      border: '1px solid rgba(120,160,255,0.22)', // de-glow: was 2px @ 0.4
      boxShadow: '0 6px 20px rgba(0,0,0,0.35)',
      // 1660: above the touch buttons (1650). Belt-and-braces — the panel
      // policy hides them on touch anyway; this covers ?touch-on-desktop.
      zIndex: '1660',
      fontFamily: 'system-ui, sans-serif',
      overflow: 'hidden',
      pointerEvents: 'auto',
    });
    // Sheet, not modal: the world (and the NPC you're talking to) stays
    // visible behind the conversation. The input's own Escape handler owns
    // the key (stopPropagation), so ownEscape.
    this.panels.open('npc-chat', {
      kind: 'sheet',
      hides: ['nav-chips', 'touch-controls', 'aux-controls'],
      ownEscape: true,
      close: () => this.closeNpcChat(),
    });
    const header = document.createElement('div');
    Object.assign(header.style, {
      padding: '8px 16px',
      fontWeight: '600',
      background: 'linear-gradient(135deg, rgba(80,130,255,0.16), rgba(120,80,255,0.10))',
      borderBottom: '1px solid rgba(120,160,255,0.2)',
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      gap: '10px',
    });
    // The name and the model chip share one wrapping group. On one line the
    // longer chip broke 'Lighthouse Keeper' in two at 390 px and pushed the
    // close button off the header at 320 px: the chip now drops under the
    // name when the row is short, and a name longer than the row ellipsises.
    const who = document.createElement('span');
    Object.assign(who.style, {
      display: 'flex',
      flexWrap: 'wrap',
      alignItems: 'center',
      gap: '4px 10px',
      flex: '1 1 auto',
      minWidth: '0',
    });
    const title = document.createElement('span');
    title.textContent = name;
    Object.assign(title.style, {
      whiteSpace: 'nowrap',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      maxWidth: '100%',
    });
    who.appendChild(title);
    // The differentiator, made legible: this is a REAL model conversation, not
    // a dialogue tree — visitors couldn't tell (fallbacks look identical).
    // The chip names the model and nothing more (the Fact Sheet's wording,
    // as on First steps' talk card): villagers are chat characters, one
    // model call a message. Neutral, 12 px (D10): the amber pill read as a
    // status light. Its old label is banned copy (claimsPanels).
    const aiBadge = document.createElement('span');
    aiBadge.textContent = 'Claude Haiku 4.5';
    aiBadge.dataset.npcModel = '1';
    Object.assign(aiBadge.style, {
      flex: 'none',
      fontSize: '12px',
      fontWeight: '600',
      lineHeight: '1.3',
      color: '#cfd8e6',
      background: 'rgba(255,255,255,0.06)',
      border: '1px solid rgba(207,216,230,0.4)',
      borderRadius: '20px',
      padding: '1px 8px',
      whiteSpace: 'nowrap',
    });
    aiBadge.title =
      'This villager talks through Claude Haiku 4.5: one model call per message. ' +
      "If the model can't be reached, it answers with its written lines and this chip says so.";
    who.appendChild(aiBadge);
    header.appendChild(who);
    this.npcChatBadge = aiBadge; // markNpcChatOffline re-labels it on a fallback
    const touch = this.isTouch;
    const controls = document.createElement('span');
    Object.assign(controls.style, {
      display: 'flex',
      flex: 'none', // the name gives way, never the close button
      gap: touch ? '0' : '12px', // on touch the two 44 px boxes sit edge to edge
      alignItems: 'center',
    });
    // The header's controls are buttons drawn as bare glyphs: a name, a role
    // and the keyboard come with them (D4). On touch each is a 44 px thumb
    // box (phone.cjs measured the ✕ at 39x47). Its top stays inside the
    // panel there: the panel's overflow clips, so the ✕'s -13px top margin
    // left the top 5 px of its box unreachable.
    const glyphButton = (glyph: string, label: string): HTMLButtonElement => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = glyph;
      b.setAttribute('aria-label', label);
      Object.assign(b.style, {
        font: 'inherit',
        color: 'inherit',
        background: 'none',
        border: 'none',
        cursor: 'pointer',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        boxSizing: 'border-box',
      });
      return b;
    };
    const thumbBox = { minWidth: '44px', minHeight: '44px', padding: '0' };
    // Voice mute toggle (only if the browser can speak).
    if (isSpeechSupported()) {
      const voiceBtn = glyphButton('🔊', 'NPC voice');
      const render = () => {
        const on = isSpeechEnabled();
        voiceBtn.textContent = on ? '🔊' : '🔇';
        voiceBtn.setAttribute('aria-pressed', String(on));
      };
      render();
      Object.assign(voiceBtn.style, {
        fontSize: '15px',
        userSelect: 'none',
        ...(touch ? { ...thumbBox, margin: '-8px 0' } : { padding: '0' }),
      });
      voiceBtn.title = 'Toggle NPC voice';
      voiceBtn.addEventListener('click', () => {
        setSpeechEnabled(!isSpeechEnabled());
        render();
      });
      controls.appendChild(voiceBtn);
    }
    const closeBtn = glyphButton('✕', 'Close chat');
    // Was a bare ~16×18px glyph — the panel's only explicit dismiss. Pad to a
    // real thumb box (negative margin keeps the header's visual rhythm).
    Object.assign(closeBtn.style, {
      opacity: '0.7',
      ...(touch
        ? { ...thumbBox, margin: '-8px -13px -8px 0' }
        : { padding: '13px', margin: '-13px' }),
    });
    closeBtn.addEventListener('click', () => this.closeNpcChat());
    controls.appendChild(closeBtn);
    header.appendChild(controls);
    panel.appendChild(header);
    const log = document.createElement('div');
    // A log: each new line is read out once (UX-05: 0 live regions). The
    // typewriter's partial text is hidden from screen readers; each NPC line
    // carries its whole text in a visually hidden twin.
    log.setAttribute('role', 'log');
    log.setAttribute('aria-live', 'polite');
    log.setAttribute('aria-label', `Conversation with ${name}`);
    log.tabIndex = 0; // a scroller: the keyboard can page back through it
    Object.assign(log.style, {
      padding: '12px 16px',
      maxHeight: '38vh',
      overflowY: 'auto',
      fontSize: '15px',
      lineHeight: '1.4',
      display: 'flex',
      flexDirection: 'column',
      gap: '8px',
    });
    panel.appendChild(log);
    const playerLine = (text: string): void => {
      const row = document.createElement('div');
      row.textContent = text; // textContent: player text never becomes markup
      Object.assign(row.style, {
        alignSelf: 'flex-end',
        background: 'rgba(90,140,255,0.25)',
        padding: '6px 10px',
        borderRadius: '10px',
        maxWidth: '80%',
      });
      log.appendChild(row);
      log.scrollTop = log.scrollHeight;
    };
    // NPC line: speak it, and type it out char-by-char (unless reduced motion).
    // `voiced=false` for the composed OPENING: it was already spoken by the
    // walk-up greet bubble, and re-speaking it here in the on-device voice
    // right before the cloud-voiced continuation arrives made the panel open
    // with a jarring robot-then-premium voice switch.
    const npcLine = (text: string, voiced = true): void => {
      const line = document.createElement('div');
      Object.assign(line.style, { alignSelf: 'flex-start', color: '#dfe6ff', maxWidth: '90%' });
      const row = document.createElement('span');
      row.setAttribute('aria-hidden', 'true'); // the typewriter's partial text
      const whole = document.createElement('span');
      whole.className = 'ds-sr-only';
      whole.textContent = `${name}: ${text}`; // what the log reads out, once
      line.append(row, whole);
      log.appendChild(line);
      if (voiced) speak(text, voice.rate, voice.pitch, voice.variant);
      // 'ds:npc-speaking' while this line types (D10; B8's nod and sway). The
      // latest line owns the signal: an earlier one still typing must not
      // end it early.
      const turn = ++this.npcSpeakTurn;
      const done = (): void => {
        if (this.npcSpeakTurn === turn) this.setNpcSpeaking(name, false);
      };
      this.setNpcSpeaking(name, true);
      if (a11y.reducedMotion) {
        row.textContent = text;
        log.scrollTop = log.scrollHeight;
        // Nothing types: the line counts as spoken for its reading time.
        this.npcSpeakTimer = window.setTimeout(done, Math.min(6000, text.length * 18));
        return;
      }
      let i = 0;
      const step = (): void => {
        row.textContent = text.slice(0, i); // textContent: no markup injection
        log.scrollTop = log.scrollHeight;
        if (i < text.length) {
          i += 1;
          this.npcTypeTimer = window.setTimeout(step, 18);
        } else {
          done();
        }
      };
      step();
    };
    npcLine(opening, false);
    const inputRow = document.createElement('div');
    Object.assign(inputRow.style, {
      display: 'flex',
      gap: '8px',
      padding: '10px 12px',
      borderTop: '1px solid rgba(255,255,255,0.08)',
    });
    // 44 px thumb targets on touch: the mic, the field and Send measured 38
    // tall (phone.cjs).
    const tall = touch ? { minHeight: '44px', boxSizing: 'border-box' } : {};
    const input = document.createElement('input');
    input.type = 'text';
    input.maxLength = 300;
    input.placeholder = `Say something to ${name}…`;
    Object.assign(input.style, {
      flex: '1',
      // A field's automatic minimum is its ~20-character intrinsic width: on
      // a 390 px phone the row overflowed, and the panel's clip cut Send.
      minWidth: '0',
      padding: '8px 12px',
      borderRadius: '10px',
      border: '1px solid rgba(255,255,255,0.15)',
      background: 'rgba(255,255,255,0.06)',
      color: '#fff',
      fontSize: this.isTouch ? '16px' : '15px', // 16px kills iOS focus zoom
      outline: 'none',
      ...tall,
    });
    const send = document.createElement('button');
    send.textContent = 'Send';
    send.className = 'ds-press';
    Object.assign(send.style, {
      padding: '8px 16px',
      borderRadius: '10px',
      border: 'none',
      cursor: 'pointer',
      background: DS.primary, // #5a8cff gave white text 3.17:1
      color: '#fff',
      fontWeight: '600',
      ...tall,
    });
    // Mic button (speech-to-text) — only where the browser supports it.
    const mic = isSttSupported() ? document.createElement('button') : null;
    if (mic) {
      mic.textContent = '🎤';
      mic.title = 'Talk to this character';
      Object.assign(mic.style, {
        padding: '8px 12px',
        borderRadius: '10px',
        border: '1px solid rgba(255,255,255,0.15)',
        cursor: 'pointer',
        background: 'rgba(255,255,255,0.06)',
        color: '#fff',
        fontSize: '15px',
        ...tall,
        ...(touch ? { minWidth: '44px' } : {}),
      });
      inputRow.appendChild(mic);
    }
    inputRow.appendChild(input);
    inputRow.appendChild(send);
    panel.appendChild(inputRow);
    // Typing must not drive the player: stop key events reaching window/document.
    for (const ev of ['keydown', 'keyup', 'keypress'])
      input.addEventListener(ev, (e) => e.stopPropagation());
    // 'ds:npc-typing' (D10; B8 leans the villager in): true on input, false
    // 1.5 s after the last keystroke, or on send.
    input.addEventListener('input', () => {
      this.setNpcTyping(name, true);
      if (this.npcTypingTimer) clearTimeout(this.npcTypingTimer);
      this.npcTypingTimer = window.setTimeout(() => this.setNpcTyping(name, false), 1500);
    });
    let busy = false;
    const doSend = async (): Promise<void> => {
      const text = input.value.trim();
      if (!text || busy) return;
      busy = true;
      input.value = '';
      send.disabled = true;
      this.setNpcTyping(name, false); // sent: the visitor has stopped typing
      // The input stays ENABLED: disabling a focused field blurs it, which
      // collapses the phone keyboard on every message — and the later
      // programmatic focus() can't reopen it without a user gesture. The
      // `busy` guard above already prevents double-sends; the user just
      // composes their next line while the villager thinks.
      // The user has spoken: any still-pending opening-deepening is stale
      // from here on (see appendNpcChatLine).
      if (this.npcChatAppend?.name === name) this.npcChatAppend.engaged = true;
      playerLine(text);
      const thinking = document.createElement('div');
      thinking.textContent = '…';
      thinking.dataset.npcThinking = '1';
      Object.assign(thinking.style, { alignSelf: 'flex-start', color: '#8ea2d8' });
      log.appendChild(thinking);
      log.scrollTop = log.scrollHeight;
      // A slow model call says so after 3 s (D10): the bare '…' read as a
      // hang. NpcChat gives up at 12 s and the written lines take over.
      const slow = window.setTimeout(() => {
        thinking.textContent = `${name} is thinking…`;
        log.scrollTop = log.scrollHeight;
      }, SimpleUI.NPC_THINKING_MS);
      // What the question is about, if the portfolio or the compass can
      // answer it (P2-D4). The send goes to the model either way.
      const route = routeQuestion(text, name);
      this.npcSendFellBack = false;
      let reply = '…';
      try {
        reply = await onSend(text);
      } catch {
        reply = '…';
      }
      clearTimeout(slow);
      thinking.remove();
      if (this.npcChatDiv !== panel) return; // closed while the villager thought
      // The model could not answer (markNpcChatOffline fired during the
      // send): a routed question gets its answer, not the next written line,
      // which had nothing to do with what was asked.
      npcLine(route && this.npcSendFellBack ? route.line : reply);
      if (route?.action) log.appendChild(this.npcRouteButton(route));
      log.scrollTop = log.scrollHeight;
      busy = false;
      send.disabled = false;
      // Only re-focus if focus was actually lost (desktop click on Send blurs
      // the field) — refocusing an already-focused input is a no-op anyway,
      // and on touch the field never blurred, keeping the keyboard up.
      if (document.activeElement !== input) input.focus();
    };
    send.addEventListener('click', () => void doSend());
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        void doSend();
      } else if (e.key === 'Escape') {
        // Step out of the conversation from the keyboard — same as ✕. The
        // stopPropagation listeners above keep this from reaching the game.
        e.preventDefault();
        this.closeNpcChat();
      }
    });
    // Speech-to-text: click 🎤 to dictate; interim text streams into the input,
    // and the settled phrase auto-sends when you pause (click again to stop
    // early). Guarded so closing the panel mid-dictation never fires a stray send.
    if (mic) {
      const setRec = (on: boolean): void => {
        mic.style.background = on ? 'rgba(230,80,80,0.9)' : 'rgba(255,255,255,0.06)';
        mic.textContent = on ? '●' : '🎤';
      };
      mic.addEventListener('click', () => {
        if (this.npcSttStop) {
          this.npcSttStop();
          return;
        } // second click = stop early
        setRec(true);
        this.npcSttStop = startListening({
          onInterim: (t) => {
            input.value = t;
          },
          onFinal: (t) => {
            input.value = t;
          },
          onEnd: () => {
            this.npcSttStop = null;
            setRec(false);
            if (this.npcChatDiv === panel && input.value.trim()) void doSend();
          },
          onError: () => {
            input.placeholder = 'Mic unavailable — type instead';
          },
        });
      });
    }
    this.overlay.appendChild(panel);
    this.npcChatDiv = panel;
    // Keyboard lift (same mechanism as openChatInput): iOS overlays the
    // keyboard without resizing the layout viewport, so without this the
    // bottom-anchored panel — input included — sits under ~260px of keyboard
    // and typing is blind. visualViewport is the only honest signal.
    if (this.isTouch && window.visualViewport) {
      const vv = window.visualViewport;
      const lift = () => {
        if (this.npcChatDiv !== panel) {
          vv.removeEventListener('resize', lift);
          vv.removeEventListener('scroll', lift);
          return;
        }
        const keyboardInset = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
        panel.style.bottom = `calc(var(--sab, 0px) + ${28 + keyboardInset}px)`;
      };
      vv.addEventListener('resize', lift);
      vv.addEventListener('scroll', lift);
    }
    // Expose this panel's NPC-line appender so the app can deepen the opening
    // in the background (composed greeting → generated continuation).
    this.npcChatAppend = { name, npcLine, engaged: false };
    window.setTimeout(() => input.focus(), 50);
  }

  private npcChatAppend: {
    name: string;
    npcLine: (text: string) => void;
    /** True once the user has SENT a message in this panel — the point where
     *  a late opening-deepening stops being "the NPC keeps talking" and
     *  becomes an interruption. */
    engaged: boolean;
  } | null = null;

  /** Append an NPC-side line to the OPEN chat panel for `name` (typewriter +
   *  voice, same as a reply). No-ops if the panel closed or switched NPCs —
   *  a late background continuation must never resurrect a dismissed chat —
   *  and DROPS once the user has engaged: speak() strict-cancels whatever is
   *  in flight, so a continuation landing after a question cut off the NPC's
   *  direct ANSWER mid-sentence and then appended stale greeting flavour
   *  below it. The composed opening already stands on its own; the moment
   *  the user asks something, the conversation has moved past it. */
  public appendNpcChatLine(name: string, text: string): void {
    if (this.npcChatDiv && this.npcChatAppend?.name === name && !this.npcChatAppend.engaged) {
      this.npcChatAppend.npcLine(text);
    }
  }

  private npcChatBadge: HTMLElement | null = null;
  /** The send in flight came back as a written line (markNpcChatOffline). */
  private npcSendFellBack = false;

  /**
   * The next action under a routed reply (P2-D4): one 44 px indigo-outline
   * button that opens the panel, the hire card, or points the compass. Green
   * stays Work with me's alone.
   */
  private npcRouteButton(route: QuestionRoute): HTMLButtonElement {
    const action = route.action!;
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = action.label;
    b.dataset.npcRoute = route.kind;
    Object.assign(b.style, {
      alignSelf: 'flex-start',
      minHeight: '44px',
      padding: '0 16px',
      borderRadius: '10px',
      border: '1px solid rgba(143,155,255,0.8)',
      background: 'rgba(76,91,224,0.14)',
      color: '#fff',
      font: 'inherit',
      fontSize: '14px',
      fontWeight: '600',
      cursor: 'pointer',
    });
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      if (action.hire) {
        track('npc_route', { to: 'hire' });
        this.showHireCard('npc'); // the modal sweeps the chat closed
      } else if (action.zone) {
        track('npc_route', { to: action.zone });
        this.showZonePanel({ id: action.zone, name: action.zone }, { source: 'npc' });
      } else if (action.guideKey) {
        track('npc_route', { to: action.guideKey });
        // The visitor is about to walk: the conversation ends here.
        this.closeNpcChat();
        this.guideTo(action.guideKey, 'npc');
      }
    });
    return b;
  }

  /**
   * 'Show me': point the compass at a place by key, through the one seam
   * main-simple listens on ('ds:guide-to' {key, source}, P2-A5). With no
   * event to send, the island map opens instead, so the button never
   * dead-ends.
   */
  private guideTo(key: string, source: string): void {
    try {
      window.dispatchEvent(new CustomEvent('ds:guide-to', { detail: { key, source } }));
    } catch {
      this.onOpenMap?.();
    }
  }

  /** '<name> is thinking…' replaces the bare '…' after this long. */
  private static readonly NPC_THINKING_MS = 3000;

  // 'ds:npc-speaking' and 'ds:npc-typing' (D10): what each last said, so an
  // event fires on a change only, and a close ends whatever was on.
  private npcSpeakingName: string | null = null;
  private npcTypingName: string | null = null;
  private npcSpeakTurn = 0;
  private npcSpeakTimer = 0;
  private npcTypingTimer = 0;

  private setNpcSpeaking(name: string, speaking: boolean): void {
    if ((this.npcSpeakingName === name) === speaking) return;
    this.npcSpeakingName = speaking ? name : null;
    this.npcSignal('ds:npc-speaking', { name, speaking });
  }

  private setNpcTyping(name: string, typing: boolean): void {
    if (!typing && this.npcTypingTimer) {
      clearTimeout(this.npcTypingTimer);
      this.npcTypingTimer = 0;
    }
    if ((this.npcTypingName === name) === typing) return;
    this.npcTypingName = typing ? name : null;
    this.npcSignal('ds:npc-typing', { name, typing });
  }

  private npcSignal(type: string, detail: Record<string, unknown>): void {
    try {
      window.dispatchEvent(new CustomEvent(type, { detail }));
    } catch {
      /* no CustomEvent: nothing listens either */
    }
  }

  /**
   * The villager answered from its written lines: the model call fell back
   * (App Check, a rate or spend cap, moderation, offline). The header names
   * the model, which did not answer this time; say so.
   * No-op unless `name`'s chat is the one open.
   */
  public markNpcChatOffline(name: string): void {
    const badge = this.npcChatBadge;
    if (!badge || !this.npcChatDiv || this.npcChatAppend?.name !== name) return;
    this.npcSendFellBack = true; // showNpcChat's send reads it (P2-D4)
    badge.textContent = 'offline replies';
    badge.dataset.offline = '1';
    badge.style.color = '#b8c2d0';
    badge.style.borderColor = 'rgba(184,194,208,0.45)';
    badge.title =
      "Claude Haiku 4.5 can't be reached right now, so this villager is answering with its written lines.";
  }

  public closeNpcChat(): void {
    this.npcChatAppend = null;
    this.npcChatBadge = null;
    if (this.npcTypeTimer) {
      clearTimeout(this.npcTypeTimer);
      this.npcTypeTimer = 0;
    }
    if (this.npcSpeakTimer) {
      clearTimeout(this.npcSpeakTimer);
      this.npcSpeakTimer = 0;
    }
    // The villager stops talking and the visitor stops typing with the panel.
    this.npcSpeakTurn += 1;
    if (this.npcSpeakingName) this.setNpcSpeaking(this.npcSpeakingName, false);
    if (this.npcTypingName) this.setNpcTyping(this.npcTypingName, false);
    cancelSpeech();
    // Null the panel BEFORE stopping dictation so the recogniser's onEnd guard
    // (npcChatDiv === panel) sees it's gone and skips the auto-send.
    const div = this.npcChatDiv;
    this.npcChatDiv = null;
    const stopStt = this.npcSttStop;
    this.npcSttStop = null;
    if (stopStt) stopStt();
    if (div) {
      div.remove();
      this.panels.notifyClosed('npc-chat');
      // Fire only on a real close (div existed) — showNpcChat's defensive
      // closeNpcChat() on a fresh open must not ping the app, and the app's
      // safety poll must not double-release.
      this.onNpcChatClosed?.();
    }
  }

  private onNpcChatClosed: (() => void) | null = null;

  /** App hook: release the NPC dialogue hold + camera when the chat closes
   *  by ANY path (✕, Escape, replacement by a new chat). */
  public setOnNpcChatClosed(cb: (() => void) | null): void {
    this.onNpcChatClosed = cb;
  }

  // ── Beach-house wall screen: watch web content in-game ─────────────────
  // The picker asks WHAT to watch; the frame is a sandboxed iframe that
  // SimpleApp pins over the in-world TV's projected rect every frame, so
  // the page plays ON the wall. Sites that refuse embedding get the ↗
  // escape hatch to a real tab (their block, not ours).
  private watchDiv: HTMLElement | null = null;
  private watchPickerDiv: HTMLElement | null = null;
  private onWatchClosed: (() => void) | null = null;

  /** youtube watch/short/shortlink → embed form; other https URLs pass
   *  through untouched; anything else (http, garbage) is rejected. */
  private static toEmbedUrl(raw: string): string | null {
    try {
      const u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw.trim()}`);
      const yt = /(^|\.)youtube\.com$/i.test(u.hostname);
      const v = yt && u.pathname === '/watch' ? u.searchParams.get('v') : null;
      if (v) return `https://www.youtube.com/embed/${v}?autoplay=1`;
      if (u.hostname === 'youtu.be' && u.pathname.length > 1) {
        return `https://www.youtube.com/embed/${u.pathname.slice(1)}?autoplay=1`;
      }
      if (yt && u.pathname.startsWith('/shorts/')) {
        return `https://www.youtube.com/embed/${u.pathname.split('/')[2]}?autoplay=1`;
      }
      if (u.protocol !== 'https:') return null;
      return u.href;
    } catch {
      return null;
    }
  }

  public showWatchPicker(onPick: (url: string) => void): void {
    this.closeWatchPicker();
    const panel = document.createElement('div');
    Object.assign(panel.style, {
      position: 'absolute',
      left: '50%',
      top: '50%',
      transform: 'translate(-50%, -50%)',
      width: 'min(380px, 92%)',
      background: 'rgba(12,12,20,0.96)',
      border: '1px solid rgba(255,255,255,0.15)',
      borderRadius: '14px',
      boxShadow: '0 10px 28px rgba(0,0,0,0.4)',
      padding: '18px',
      zIndex: '1650', // was 1640 — level with the scrim, which greyed it out
      pointerEvents: 'auto',
      color: '#f0f0f0',
    });
    this.panels.open('watch-picker', {
      kind: 'modal',
      hides: ['nav-chips', 'touch-controls', 'aux-controls'],
      close: () => this.closeWatchPicker(),
      el: panel,
      label: 'The wall screen',
      // its link field (focused 50 ms after open, below)
      initialFocus: () => panel.querySelector<HTMLElement>('input'),
    });
    this.stepHintAside(true);
    panel.innerHTML = `
      <div style="font-weight:600; font-size:15px; margin-bottom:4px;">📺 The wall screen</div>
      <div style="font-size:13px; color:#aab; margin-bottom:12px;">What shall we watch? Paste a YouTube link (or any https page).</div>
    `;
    const presets = document.createElement('div');
    Object.assign(presets.style, { display: 'flex', gap: '8px', marginBottom: '10px' });
    const preset = (label: string, url: string): void => {
      const b = document.createElement('button');
      b.textContent = label;
      Object.assign(b.style, {
        flex: '1',
        padding: '9px 10px',
        borderRadius: '10px',
        border: '1px solid rgba(255,255,255,0.15)',
        background: 'rgba(80,130,255,0.14)',
        color: '#dfe6ff',
        fontSize: '13px',
        cursor: 'pointer',
      });
      b.addEventListener('click', () => {
        this.closeWatchPicker();
        onPick(url);
      });
      presets.appendChild(b);
    };
    // A regular upload, NOT a live stream — live-stream embeds die with
    // "recording not available" once the stream rotates (playtest-caught).
    preset('📻 Lofi beats', 'https://www.youtube.com/embed/lTRiuFIWV54?autoplay=1');
    panel.appendChild(presets);
    const row = document.createElement('div');
    Object.assign(row.style, { display: 'flex', gap: '8px' });
    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'youtube.com/watch?v=… or any https link';
    Object.assign(input.style, {
      flex: '1',
      padding: '9px 11px',
      borderRadius: '10px',
      border: '1px solid rgba(255,255,255,0.15)',
      background: 'rgba(255,255,255,0.06)',
      color: '#fff',
      // 16px on touch: this input autofocuses — under 16px iOS zooms on open.
      fontSize: this.isTouch ? '16px' : '13.5px',
    });
    for (const ev of ['keydown', 'keyup', 'keypress'])
      input.addEventListener(ev, (e) => e.stopPropagation()); // typing must not walk the room
    const go = document.createElement('button');
    go.textContent = 'Watch';
    go.className = 'ds-press';
    Object.assign(go.style, {
      padding: '9px 16px',
      borderRadius: '10px',
      border: 'none',
      background: DS.primary,
      color: '#fff',
      fontWeight: '600',
      fontSize: '14px',
      cursor: 'pointer',
    });
    const submit = (): void => {
      const url = SimpleUI.toEmbedUrl(input.value);
      if (!url) {
        input.style.border = '1px solid rgba(230,90,90,0.7)';
        input.placeholder = 'https links only — try a YouTube URL';
        input.value = '';
        return;
      }
      this.closeWatchPicker();
      onPick(url);
    };
    go.addEventListener('click', submit);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submit();
      else if (e.key === 'Escape') this.closeWatchPicker();
    });
    row.appendChild(input);
    row.appendChild(go);
    panel.appendChild(row);
    const close = document.createElement('button');
    close.textContent = '✕';
    close.setAttribute('aria-label', 'Close');
    Object.assign(close.style, {
      position: 'absolute',
      top: '0',
      right: '0',
      background: 'none',
      border: 'none',
      color: '#99a',
      fontSize: '17px',
      cursor: 'pointer',
      // 44px thumb box around the small glyph (same fix as the modal ×).
      width: '44px',
      height: '44px',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '0',
    });
    close.addEventListener('click', () => this.closeWatchPicker());
    panel.appendChild(close);
    this.overlay.appendChild(panel);
    this.watchPickerDiv = panel;
    window.setTimeout(() => input.focus(), 50);
  }

  public closeWatchPicker(): void {
    if (this.watchPickerDiv) {
      this.watchPickerDiv.remove();
      this.watchPickerDiv = null;
      this.panels.notifyClosed('watch-picker');
    }
  }

  /** The playing frame. `onClose` fires exactly once, on ANY close path. */
  public showWatchFrame(url: string, onClose: () => void): void {
    this.closeWatchFrame();
    this.onWatchClosed = onClose;
    const wrap = document.createElement('div');
    Object.assign(wrap.style, {
      position: 'absolute',
      left: '0px',
      top: '0px',
      width: '320px',
      height: '180px',
      background: '#000',
      borderRadius: '4px',
      overflow: 'visible',
      zIndex: '1580', // under touch buttons (1650) + Leave (1900)
      pointerEvents: 'auto',
      boxShadow: '0 0 0 2px rgba(20,22,28,0.9)',
    });
    const iframe = document.createElement('iframe');
    iframe.src = url;
    iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-presentation');
    iframe.setAttribute('allow', 'autoplay; encrypted-media; picture-in-picture; fullscreen');
    // NO referrerpolicy override: YouTube's player REQUIRES the embedding
    // origin in the referrer and throws "Error 153 — player configuration
    // error" under no-referrer (playtest-caught). The browser default
    // (strict-origin-when-cross-origin) sends exactly the origin, no path.
    Object.assign(iframe.style, {
      width: '100%',
      height: '100%',
      border: '0',
      borderRadius: '4px',
      background: '#000',
    });
    wrap.appendChild(iframe);
    // Chrome row floats ABOVE the frame so it never covers the content.
    const chrome = document.createElement('div');
    Object.assign(chrome.style, {
      position: 'absolute',
      top: '-34px',
      right: '0',
      display: 'flex',
      gap: '6px',
      alignItems: 'center',
    });
    const hint = document.createElement('span');
    hint.textContent = 'blank? that site refuses embedding →';
    Object.assign(hint.style, { fontSize: '12px', color: 'rgba(255,255,255,0.55)' });
    chrome.appendChild(hint);
    const mkChip = (label: string): HTMLElement => {
      const c = document.createElement('a');
      c.textContent = label;
      Object.assign(c.style, {
        padding: '5px 10px',
        borderRadius: '8px',
        background: 'rgba(12,12,20,0.9)',
        border: '1px solid rgba(255,255,255,0.2)',
        color: '#dfe6ff',
        fontSize: '13px',
        cursor: 'pointer',
        textDecoration: 'none',
      });
      chrome.appendChild(c);
      return c;
    };
    const open = mkChip('↗ tab') as HTMLAnchorElement;
    open.href = url;
    open.target = '_blank';
    open.rel = 'noopener noreferrer';
    const x = mkChip('✕ stop');
    x.addEventListener('click', () => this.closeWatchFrame());
    wrap.appendChild(chrome);
    this.overlay.appendChild(wrap);
    this.watchDiv = wrap;
  }

  /** Pin the frame over the in-world screen's projected rect (per frame). */
  public positionWatchFrame(rect: { x: number; y: number; w: number; h: number }): void {
    if (!this.watchDiv) return;
    this.watchDiv.style.left = `${rect.x.toFixed(1)}px`;
    this.watchDiv.style.top = `${rect.y.toFixed(1)}px`;
    this.watchDiv.style.width = `${rect.w.toFixed(1)}px`;
    this.watchDiv.style.height = `${rect.h.toFixed(1)}px`;
  }

  public isWatchOpen(): boolean {
    return !!this.watchDiv || !!this.watchPickerDiv;
  }

  public closeWatchFrame(): void {
    this.closeWatchPicker();
    if (this.watchDiv) {
      this.watchDiv.remove();
      this.watchDiv = null;
      const cb = this.onWatchClosed;
      this.onWatchClosed = null;
      cb?.();
    }
  }

  // ── Door PIN pad (the beach house's coded lock) ────────────────────────
  // A game mechanic, not security: the code ships in the client bundle.
  private pinDiv: HTMLElement | null = null;
  /** A wrong code was entered this session: the pad says who knows it. */
  private pinMissed = false;

  public showPinPad(expected: string, onSuccess: () => void): void {
    this.closePinPad();
    const panel = document.createElement('div');
    Object.assign(panel.style, {
      position: 'absolute',
      left: '50%',
      top: '50%',
      transform: 'translate(-50%, -50%)',
      width: '240px',
      background: 'rgba(12,12,20,0.96)',
      border: '1px solid rgba(255,255,255,0.15)',
      borderRadius: '14px',
      boxShadow: '0 10px 28px rgba(0,0,0,0.4)',
      padding: '16px',
      zIndex: '1650', // was 1640 — level with the scrim, which greyed it out
      pointerEvents: 'auto',
      color: '#f0f0f0',
      textAlign: 'center',
    });
    // Digits come from the on-screen grid (or real keyboard) — the synthetic
    // touch buttons aren't needed here, so hiding them kills mis-taps.
    this.panels.open('pin-pad', {
      kind: 'modal',
      hides: ['nav-chips', 'touch-controls', 'aux-controls'],
      close: () => this.closePinPad(),
      el: panel,
      label: 'Door code',
      initialFocus: () => panel, // its own keydown takes the digits
    });
    this.stepHintAside(true);
    panel.innerHTML = `
      <div style="font-weight:600; font-size:15px; margin-bottom:2px;">🔒 The door is locked</div>
      <div style="font-size:12px; color:#aab; margin-bottom:10px;">Enter the door code</div>
      <div id="pin-dots" style="letter-spacing:8px; font-size:20px; min-height:28px; margin-bottom:10px;">····</div>
    `;
    const dots = panel.querySelector('#pin-dots') as HTMLElement;
    // The locked door points to the Sailor (P2-D9, decision P2-2): after the
    // first wrong code of the session, one line under the pad, once. A pad
    // reopened later in the session carries it from the start.
    const hint = (): void => {
      if (panel.querySelector('[data-pin-hint]')) return;
      const line = document.createElement('div');
      line.dataset.pinHint = '1';
      line.setAttribute('role', 'status');
      line.textContent = 'Ask the Sailor at the harbour.';
      Object.assign(line.style, {
        marginTop: '12px',
        fontSize: '13px',
        lineHeight: '1.4',
        color: '#cfd8e6',
      });
      panel.appendChild(line);
    };
    let entered = '';
    const paint = (): void => {
      dots.textContent = (entered.replace(/./g, '●') + '····').slice(0, 4);
    };
    const press = (d: string): void => {
      if (entered.length >= 4) return;
      entered += d;
      paint();
      if (entered.length === 4) {
        if (entered === expected) {
          this.closePinPad();
          onSuccess();
        } else {
          this.pinMissed = true;
          hint();
          dots.style.color = '#ff8a8a';
          panel.style.transform = 'translate(-50%, -50%) translateX(6px)';
          window.setTimeout(() => {
            panel.style.transform = 'translate(-50%, -50%)';
            dots.style.color = '';
            entered = '';
            paint();
          }, 320);
        }
      }
    };
    const grid = document.createElement('div');
    Object.assign(grid.style, {
      display: 'grid',
      gridTemplateColumns: 'repeat(3, 1fr)',
      gap: '8px',
    });
    for (const d of ['1', '2', '3', '4', '5', '6', '7', '8', '9', '⌫', '0', '✕']) {
      const b = document.createElement('button');
      b.textContent = d;
      Object.assign(b.style, {
        padding: '10px 0',
        borderRadius: '10px',
        border: '1px solid rgba(255,255,255,0.15)',
        background: 'rgba(255,255,255,0.06)',
        color: '#fff',
        fontSize: '17px',
        cursor: 'pointer',
      });
      b.addEventListener('click', () => {
        if (d === '⌫') {
          entered = entered.slice(0, -1);
          paint();
        } else if (d === '✕') {
          this.closePinPad();
        } else {
          press(d);
        }
      });
      grid.appendChild(b);
    }
    panel.appendChild(grid);
    if (this.pinMissed) hint();
    // Keyboard digits work too (stopPropagation keeps them out of the game)
    const keyHandler = (e: KeyboardEvent): void => {
      if (/^[0-9]$/.test(e.key)) press(e.key);
      else if (e.key === 'Backspace') {
        entered = entered.slice(0, -1);
        paint();
      } else if (e.key === 'Escape') this.closePinPad();
      e.stopPropagation();
    };
    panel.tabIndex = -1;
    panel.addEventListener('keydown', keyHandler);
    this.overlay.appendChild(panel);
    this.pinDiv = panel;
    panel.focus();
  }

  public closePinPad(): void {
    if (this.pinDiv) {
      this.pinDiv.remove();
      this.pinDiv = null;
      this.panels.notifyClosed('pin-pad');
    }
  }

  public isNpcChatOpen(): boolean {
    return !!this.npcChatDiv;
  }

  showDialogue(name: string, lines: string[]): void {
    hapticPulse(18); // D15: an interaction that worked (a talk)
    this.dialogueLines = lines;
    this.dialogueIndex = 0;
    this.dialogueActive = true;
    // THE policy exception: touch-controls STAY — mobile dialogue advance
    // re-fires the USE button's synthetic KeyE (see the click handler below),
    // so hiding the buttons would strand the conversation. Sheet: the NPC
    // you're talking to must stay visible.
    this.panels.open('dialogue', {
      kind: 'sheet',
      // touch-controls STAY (mobile advance re-fires USE) but the aux rank
      // hides: the 💬 chip painted over this panel's bottom-left text on the
      // SE, and EAT sat inside its tap-to-advance region firing KeyG.
      hides: ['nav-chips', 'aux-controls'],
      close: () => this.hideDialogue(),
      history: false, // transient: Back is not spent on it
    });

    if (!this.dialogueDiv) {
      this.dialogueDiv = document.createElement('div');
      // On touch the dialogue shares the base of the screen with the joystick
      // (bottom-left, ~136px ring) and the USE/JUMP/WAVE column (far right, up to
      // ~286px tall, z 1650). A centred full-width panel tucks UNDER those controls
      // — the "too crowded on small phones" report. So on touch we reflow it into
      // the clear zone: a compact bar left of the button column, lifted above the
      // joystick ring. Desktop (no touch controls) keeps the centred panel.
      const centerX = this.isTouch ? '' : 'translateX(-50%) ';
      const layout: Record<string, string> = this.isTouch
        ? {
            left: 'calc(var(--sal, 0px) + 14px)',
            right: 'calc(var(--sar, 0px) + 106px)',
            bottom: 'calc(var(--sab, 0px) + 150px)',
            maxWidth: '460px',
          }
        : {
            left: '50%',
            width: 'min(520px, 90%)', // was 600 — dialogue reads, not looms
            bottom: '30px',
          };
      Object.assign(this.dialogueDiv.style, {
        position: 'absolute',
        background: 'rgba(10, 10, 20, 0.92)',
        color: '#f0f0f0',
        padding: '0',
        borderRadius: '16px',
        pointerEvents: 'auto',
        fontSize: '15px',
        border: '1px solid rgba(120, 160, 255, 0.22)', // de-glow twin of the chat panel
        boxShadow: '0 6px 20px rgba(0, 0, 0, 0.35), inset 0 1px 0 rgba(255, 255, 255, 0.05)',
        opacity: '0',
        transform: `${centerX}translateY(16px) scale(0.96)`,
        transition: 'opacity 0.3s ease, transform 0.28s cubic-bezier(0.34, 1.4, 0.64, 1)',
        zIndex: '1600',
        overflow: 'hidden',
        cursor: 'pointer',
        ...layout,
      });
      // Tap anywhere on the panel to advance — the primary way to progress
      // dialogue on touch (no keyboard). Routes through the same synthetic 'e'
      // the USE button fires, so main-simple's dialogue handler runs unchanged.
      this.dialogueDiv.addEventListener('click', () => {
        const ev = new KeyboardEvent('keydown', { code: 'KeyE', key: 'e', bubbles: true });
        window.dispatchEvent(ev);
        document.dispatchEvent(ev);
      });
      this.overlay.appendChild(this.dialogueDiv);
      requestAnimationFrame(() => {
        if (this.dialogueDiv) {
          this.dialogueDiv.style.opacity = '1';
          this.dialogueDiv.style.transform = `${centerX}translateY(0) scale(1)`;
        }
      });
    }

    // clamp() lets every dimension shrink on small viewports and settle at the
    // original desktop values on large ones, so the panel never cramps its text
    // on a phone yet stays comfortable on a monitor — no media-query branching.
    this.dialogueDiv.innerHTML = `
      <div style="
        padding: clamp(4px, 1vh, 6px) clamp(12px, 4vw, 16px);
        background: linear-gradient(135deg, rgba(80, 130, 255, 0.16), rgba(120, 80, 255, 0.10));
        border-bottom: 1px solid rgba(120, 160, 255, 0.2);
        font-size: clamp(11px, 2.9vw, 13px);
        font-weight: 700;
        letter-spacing: 1px;
        text-transform: uppercase;
        color: rgba(160, 200, 255, 0.9);
      ">${this.escapeHtml(name)}</div>
      <div style="padding: clamp(10px, 1.8vh, 16px) clamp(14px, 4vw, 20px); min-height: clamp(36px, 7vh, 60px);">
        <div id="dialogue-sr" class="ds-sr-only" role="status" aria-live="polite"></div>
        <div id="dialogue-text" aria-hidden="true" style="
          line-height: 1.5;
          font-size: clamp(13px, 3.5vw, 15px);
          min-height: clamp(18px, 4vh, 24px);
        "></div>
        <div style="
          text-align: right;
          margin-top: clamp(5px, 1vh, 10px);
          font-size: clamp(10px, 2.6vw, 12px);
          color: rgba(160, 200, 255, 0.85);
        ">
          <span id="dialogue-hint">${this.isTouch ? 'Tap to continue' : 'Press <strong style="color:#dce9ff">E</strong> to continue'}</span>
        </div>
      </div>
    `;

    this.startTypewriter(lines[0]);
  }

  private startTypewriter(text: string): void {
    this.typewriterText = text;
    // The whole line, once, to screen readers (the dialogue's role=status;
    // the typed-out text itself is aria-hidden).
    const sr = this.dialogueDiv?.querySelector('#dialogue-sr');
    if (sr) sr.textContent = text;
    if (this.typewriterTimer) cancelAnimationFrame(this.typewriterTimer);
    // Reduced motion: full line instantly — the same rule the free-chat
    // panel's typewriter has always had (npcLine). Read per line, so the ♿
    // toggle takes effect mid-dialogue.
    if (a11y.reducedMotion) {
      this.typewriterPos = text.length;
      const textEl = this.dialogueDiv?.querySelector('#dialogue-text');
      if (textEl) textEl.textContent = text;
      return;
    }
    this.typewriterPos = 0;
    this.tickTypewriter();
  }

  private tickTypewriter(): void {
    if (!this.dialogueDiv) return;
    const textEl = this.dialogueDiv.querySelector('#dialogue-text');
    if (!textEl) return;

    if (this.typewriterPos < this.typewriterText.length) {
      this.typewriterPos += 1;
      textEl.textContent = this.typewriterText.substring(0, this.typewriterPos);
      this.typewriterTimer = requestAnimationFrame(() => {
        setTimeout(() => this.tickTypewriter(), 25);
      });
    } else {
      textEl.textContent = this.typewriterText;
    }
  }

  advanceDialogue(): boolean {
    if (!this.dialogueActive) return false;

    // If typewriter still animating, complete it instantly
    if (this.typewriterPos < this.typewriterText.length) {
      this.typewriterPos = this.typewriterText.length;
      const textEl = this.dialogueDiv?.querySelector('#dialogue-text');
      if (textEl) textEl.textContent = this.typewriterText;
      return true;
    }

    this.dialogueIndex++;
    if (this.dialogueIndex < this.dialogueLines.length) {
      this.startTypewriter(this.dialogueLines[this.dialogueIndex]);
      const hint = this.dialogueDiv?.querySelector('#dialogue-hint');
      if (hint && this.dialogueIndex === this.dialogueLines.length - 1) {
        hint.innerHTML = this.isTouch
          ? 'Tap to close'
          : 'Press <strong style="color:#dce9ff">E</strong> to close';
      }
      return true;
    }

    this.hideDialogue();
    return false;
  }

  hideDialogue(): void {
    this.dialogueActive = false;
    if (this.dialogueDiv) {
      this.dialogueDiv.style.opacity = '0';
      const div = this.dialogueDiv;
      setTimeout(() => div.remove(), 300);
      this.dialogueDiv = null;
      this.panels.notifyClosed('dialogue');
    }
    if (this.typewriterTimer) {
      cancelAnimationFrame(this.typewriterTimer);
      this.typewriterTimer = 0;
    }
  }

  isDialogueActive(): boolean {
    return this.dialogueActive;
  }

  /**
   * Dispose of UI elements
   */
  dispose(): void {
    // First: the closes below must not step the history back. This runs on
    // beforeunload, where a back() could turn a reload or a link into Back.
    this.panels.dispose();
    // Then the message queue: no closing panel below may re-arm its timers.
    this.stopMessages();
    window.removeEventListener('ds:guide', this.onGuideEvent);
    window.removeEventListener('ds:intro', this.onIntroEvent);
    window.removeEventListener('ds:coin', this.onCoinEvent);
    window.removeEventListener('ds:goals', this.onGoalsEvent);
    window.removeEventListener('keydown', this.onControlsKey);
    document.removeEventListener('keydown', this.onInputKey, true);
    document.removeEventListener('pointerdown', this.onInputPointer, true);
    if (this.touchIdleTimer) clearTimeout(this.touchIdleTimer);
    for (const type of ['pointerdown', 'keydown', 'click'] as const) {
      this.overlay.removeEventListener(type, this.onPanelAction, true);
    }
    if (this.compassDiv) {
      this.compassDiv.remove();
      this.compassDiv = null;
    }
    this.hideLoading();
    // false: this is page teardown, not a dismissal. The card may still be on
    // screen unread — do not burn ds_welcomed on a first-visit bounce.
    this.hideWelcome(false);
    this.hideInteractionPrompt();
    this.hideCustomize();
    this.hideZonePanel();
    this.hideDialogue();
    if (this.fpsDiv) {
      this.fpsDiv.remove();
      this.fpsDiv = null;
    }
    if (this.playerCountDiv) {
      this.playerCountDiv.remove();
      this.playerCountDiv = null;
    }
    if (this.shortLandscapeMql && this.onShortLandscapeChange) {
      this.shortLandscapeMql.removeEventListener?.('change', this.onShortLandscapeChange);
      this.onShortLandscapeChange = null;
    }
    if (this.overlay && this.overlay.parentNode) {
      this.overlay.parentNode.removeChild(this.overlay);
    }
  }
}
