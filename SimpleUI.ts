import { a11y } from './Accessibility';
import { linkLabel, markReachedPortfolio, track, trackOnce } from './Analytics';
import { VOICE_MAX_MS } from './Chat';
import { DISTRICTS } from './Districts';
import { checkName } from './Moderation';
import { ACTIVITY_DEFS } from './NpcActivities';
import { AI_NPCS } from './NpcChat';
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
import { EVENT_META } from './WorldState';
import type { NoticeState, NpcPlan } from './WorldState';

/**
 * Tiny haptic tap for touch feedback (Android; iOS ignores vibrate — a
 * harmless no-op). Gated OFF under reduced motion. Exported so game events
 * elsewhere (landings, race checkpoints, coins) can adopt it too.
 */
export function hapticPulse(ms: number): void {
  if (a11y.reducedMotion) return;
  try {
    navigator.vibrate?.(ms);
  } catch {
    /* unsupported or blocked by permissions policy */
  }
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
  // Touch device? Drives on-screen buttons + rewrites key-name prompts
  // ("Press E") into tap language ("Tap USE") pointing at those buttons.
  private readonly isTouch: boolean =
    typeof window !== 'undefined' &&
    ('ontouchstart' in window ||
      (navigator.maxTouchPoints ?? 0) > 0 ||
      // ?touch forces the mobile control scheme on desktop for testing
      (typeof location !== 'undefined' && location.search.includes('touch')));

  /** Whether the touch control scheme is active (used as an analytics dimension). */
  isTouchDevice(): boolean {
    return this.isTouch;
  }

  /** The HUD root — photo mode hides it for one frame to shoot a clean scene. */
  getOverlay(): HTMLElement {
    return this.overlay;
  }

  // ── Interior enter/exit chrome ─────────────────────────────────────────
  private fadeDiv: HTMLElement | null = null;
  /** Fade to black, run midCb at the peak, fade back in — for door transitions. */
  fadeThrough(midCb: () => void): void {
    if (!this.fadeDiv) {
      this.fadeDiv = document.createElement('div');
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
    }
    const d = this.fadeDiv;
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

  private leaveBtn: HTMLElement | null = null;
  /** "← Leave" button shown while inside a building. */
  showLeaveButton(onLeave: () => void): void {
    this.hideLeaveButton();
    const b = document.createElement('div');
    b.textContent = '← Leave';
    Object.assign(b.style, {
      position: 'fixed',
      top: 'calc(var(--sat, 0px) + 14px)',
      left: 'calc(var(--sal, 0px) + 14px)',
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
    this.leaveBtn = b;
    this.overlay.appendChild(b);
  }
  hideLeaveButton(): void {
    this.leaveBtn?.remove();
    this.leaveBtn = null;
  }

  constructor(id: string) {
    // Create or get overlay
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
      fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif",
    });
    // Safe-area insets published as inheriting custom properties so every
    // edge-anchored HUD child can offset itself off notches / home
    // indicators with calc(var(--sa*) + Npx). Resolve to 0 on desktop.
    this.overlay.style.setProperty('--sat', 'env(safe-area-inset-top, 0px)');
    this.overlay.style.setProperty('--sar', 'env(safe-area-inset-right, 0px)');
    this.overlay.style.setProperty('--sab', 'env(safe-area-inset-bottom, 0px)');
    this.overlay.style.setProperty('--sal', 'env(safe-area-inset-left, 0px)');

    if (!this.panels) this.panels = new PanelManager(this.overlay, this.isTouch);
    this.createFPSDisplay();
    this.createMuteButton();
    this.createPortfolioButton();
    this.createContactCTA();
    this.createPhotoButton();
    this.createSayHiButton();
    this.createCompletionButton();
    this.createInventoryButton();
    this.createEmoteButton();
    this.createTouchControls();
    this.initResponsiveHud();
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
      this.emoteBtnEl.style.right = short
        ? 'calc(var(--sar, 0px) + 108px)'
        : 'calc(var(--sar, 0px) + 10px)';
    }
    // Same class of bug on the left: short-landscape raises the radar to
    // top+8, straight under the day/weather badge at top+10 (measured 64x26).
    if (this.envBadgeDiv) {
      this.envBadgeDiv.style.left = short
        ? 'calc(var(--sal, 0px) + 122px)'
        : 'calc(var(--sal, 0px) + 10px)';
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
        maxWidth: 'calc(100vw - 32px)',
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
    // Portrait: above the whole control band.
    Object.assign(el.style, {
      bottom: 'calc(var(--sab, 0px) + 300px)',
      left: '50%',
      maxWidth: 'calc(100vw - 32px)',
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
    Object.assign(el.style, {
      // Portrait touch: 350, not 250 — the action column starts at y381 on a
      // 667-tall screen, so the 250 lane put toast text straight across the
      // WAVE button (measured 74x36). 350 clears it and still sits below the
      // prompt's 300 lane.
      bottom: short
        ? 'calc(var(--sab, 0px) + 96px)'
        : this.isTouch
          ? 'calc(var(--sab, 0px) + 350px)'
          : 'calc(var(--sab, 0px) + 250px)',
      maxWidth: short ? 'min(56vw, 360px)' : 'min(92vw, 440px)',
      // Landscape: nudged into the free centre band like the prompt, so the
      // pill clears the joystick ring instead of grazing it.
      left: short ? 'calc(50% + 30px)' : '50%',
    });
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
    Object.assign(el.style, {
      // relative, NOT static — same in-flow layout, but the chip stays a
      // containing block for its .hud-btn::after tap pad (see tierChip).
      position: 'relative',
      top: '',
      right: '',
      left: '',
      bottom: '',
      boxSizing: 'border-box',
      minHeight: '40px',
      display: 'flex',
      alignItems: 'center',
      borderRadius: '10px',
      fontSize: '13px',
    });
    let item: HTMLElement = el;
    if (opts.label) {
      const row = document.createElement('div');
      Object.assign(row.style, {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        minHeight: '40px',
        padding: '0 4px',
        borderRadius: '10px',
        cursor: 'pointer',
        pointerEvents: 'auto',
      });
      const span = document.createElement('span');
      span.textContent = opts.label;
      Object.assign(span.style, { fontSize: '13px', fontWeight: '600', color: '#fff' });
      row.appendChild(el);
      row.appendChild(span);
      // Tapping the label fires the chip. composedPath guard: el.click()
      // bubbles back through this row — without it, infinite recursion.
      row.addEventListener('click', (e) => {
        if (!e.composedPath().includes(el)) el.click();
      });
      item = row;
    } else {
      Object.assign(el.style, { width: '100%' });
    }
    // Business priority beats creation order: flex `order` puts Work-with-me
    // in slot #1 regardless of which create* ran first.
    if (opts.order !== undefined) item.style.order = String(opts.order);
    this.getDrawerList().appendChild(item);
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
    t.textContent = '☰';
    Object.assign(t.style, {
      width: '44px',
      height: '44px',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: 'rgba(0, 0, 0, 0.55)',
      borderRadius: '10px',
      fontSize: '18px',
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
    });
    list.style.display = 'flex';
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
    // 8s idle auto-collapse.
    this.drawerIdleTimer = window.setTimeout(() => this.closeDrawer(), 8000);
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
    Object.assign(title.style, { margin: '0 0 8px', color: '#8a9bff', fontSize: '18px' });
    modal.appendChild(title);
    const hint = document.createElement('p');
    hint.textContent = 'Tap anything to set your compass to it.';
    Object.assign(hint.style, { margin: '0 0 10px', fontSize: '12.5px', color: '#aab' });
    modal.appendChild(hint);

    const D = Math.min(430, Math.floor(window.innerWidth * 0.8));
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
    if (!ctx) return;
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
    const hits: Array<{ x: number; y: number; poi: (typeof pois)[number] }> = [];
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
      ctx.fillText(poi.icon, p.x, p.y);
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
    // Legend — every provider as a tappable chip (works even where map dots
    // crowd each other).
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
    for (const poi of pois) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.textContent = `${poi.icon} ${poi.label}`;
      Object.assign(chip.style, {
        padding: '5px 9px',
        borderRadius: '999px',
        // District chips wear their accent — same colour as the map halo,
        // the radar beacon and the in-world plaza tint.
        border: `1px solid ${poi.color ?? 'rgba(255,255,255,0.18)'}`,
        background: 'rgba(255,255,255,0.06)',
        color: '#dfe6ff',
        fontSize: '12px',
        cursor: 'pointer',
      });
      chip.addEventListener('click', () => pick(poi));
      legend.appendChild(chip);
    }
    modal.appendChild(legend);
    this.overlay.appendChild(modal);
    trackOnce('island_map_opened');
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
  private toastQueue: string[] = [];
  private toastBusy = false;
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
   */
  public toast(message: string): void {
    // Drop exact duplicates already waiting — a queue of three "+1 🪙" adds
    // nothing.
    if (this.toastQueue.includes(message)) return;
    this.toastQueue.push(message);
    this.pumpToasts();
  }

  private pumpToasts(): void {
    if (this.toastBusy || this.toastQueue.length === 0) return;
    // Not while an opaque loader or the welcome/name modal owns the screen —
    // re-checked on a short poll so deferred messages surface right after.
    if (this.isLoadingVisible() || this.isWelcomeVisible()) {
      window.setTimeout(() => this.pumpToasts(), 700);
      return;
    }
    const message = this.toastQueue.shift()!;
    this.toastBusy = true;
    if (!this.toastEl) {
      this.toastEl = document.createElement('div');
      // Bottom-centre lane, stacked so concurrent notices don't overlap:
      // chat-input 96 · breath 150 · recording 200 · toast 250 · prompt 300.
      Object.assign(this.toastEl.style, {
        position: 'absolute',
        left: '50%',
        transform: 'translateX(-50%)',
        width: 'max-content',
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
      this.applyToastAnchor(this.toastEl);
      this.overlay.appendChild(this.toastEl);
    }
    this.toastEl.textContent = message;
    this.toastEl.style.opacity = '1';
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => {
      if (this.toastEl) this.toastEl.style.opacity = '0';
      this.toastBusy = false;
      // 250ms gap between queued toasts so consecutive ones read as separate.
      window.setTimeout(() => this.pumpToasts(), 250);
    }, 2000);
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
    if (this.bulletinTimer) clearTimeout(this.bulletinTimer);
    this.bulletinTimer = window.setTimeout(() => {
      if (this.bulletinEl) {
        this.bulletinEl.style.opacity = '0';
        this.bulletinEl.style.transform = 'translateX(-50%) translateY(-8px)';
      }
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
      fontSize: '13.5px',
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
        <span style="font-size:26px;filter:${done ? 'none' : 'grayscale(1)'};opacity:${done ? '1' : '0.5'};">${meta.icon}</span>
        <span style="font-size:12px;">${meta.label}</span>
        <span style="font-size:11px;color:${done ? '#4ade80' : '#7d8ea6'};">${done ? '✓ Stamped' : 'Not yet'}</span>
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

  /** Reward celebration fired when the last stamp lands (see Passport.onComplete). */
  showPassportComplete(): void {
    const modal = this.buildCenteredModal('min(380px, calc(100vw - 32px))', 'passport-complete');
    modal.style.border = '1px solid rgba(255,213,74,0.55)';
    modal.insertAdjacentHTML(
      'beforeend',
      `<div style="font-size:52px;line-height:1;">👑</div>
       <h2 style="margin:10px 0 6px;color:#ffd54a;">Portfolio complete!</h2>
       <p style="margin:0 0 18px;font-size:15px;line-height:1.5;">
         You explored every zone of the island. The <strong>Founder's Golden Crown</strong>
         is now yours — and equipped. Thanks for taking the full tour.</p>`,
    );
    const cta = document.createElement('button');
    cta.textContent = 'Wear it with pride →';
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
    on: { deposit: () => void; withdraw: () => void },
  ): void {
    this.vaultDiv?.remove();
    const modal = this.buildCenteredModal('min(340px, calc(100vw - 32px))', 'vault');
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
    this.overlay.appendChild(modal);
  }

  public closeVaultPanel(): void {
    this.vaultDiv?.remove();
    this.vaultDiv = null;
    this.panels.notifyClosed('vault');
  }

  /**
   * Shared centred-modal shell. Every call site passes a distinguishing `id`
   * so the PanelManager gives all of them exclusivity (no more stacked
   * modals), a scrim, Escape, and the chip-hide policy — in one place.
   * A modal that removes itself outside the ✕ path (timed success screens)
   * must call `this.panels.notifyClosed(id)` alongside its remove().
   */
  private buildCenteredModal(width: string, id = 'modal'): HTMLElement {
    const modal = document.createElement('div');
    this.panels.open(id, {
      kind: 'modal',
      hides: ['nav-chips', 'touch-controls', 'aux-controls'],
      close: () => modal.remove(),
    });
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
    });
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    const close = document.createElement('button');
    close.textContent = '×';
    close.setAttribute('aria-label', 'Close');
    Object.assign(close.style, {
      position: 'absolute',
      top: '8px',
      right: '14px',
      background: 'transparent',
      color: 'white',
      border: 'none',
      fontSize: '24px',
      cursor: 'pointer',
    });
    close.addEventListener('click', () => {
      modal.remove();
      this.panels.notifyClosed(id);
    });
    modal.appendChild(close);
    return modal;
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
    btn.textContent = label;
    Object.assign(btn.style, {
      padding: '9px 16px',
      borderRadius: '10px',
      border: '1px solid rgba(120,160,255,0.45)',
      background: 'rgba(80,130,255,0.18)',
      color: '#cfe0ff',
      fontSize: '13.5px',
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
   *  cleanChatText masks slurs but does not neutralise markup. */
  private escapeHtml(s: string): string {
    return s.replace(
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
    const field =
      'width:100%;box-sizing:border-box;margin:0 0 8px;padding:9px 11px;border:none;border-radius:8px;background:rgba(255,255,255,0.1);color:#fff;font-size:14px;outline:1px solid rgba(255,255,255,0.15);';
    form.innerHTML = `
      <h3 style="margin:0 0 4px;font-size:15px;">Or send a message</h3>
      <p style="margin:0 0 10px;font-size:12px;color:#9aa;">Straight to my inbox — I'll reply personally.</p>
      <input id="lead-name" placeholder="Your name (optional)" maxlength="80" style="${field}" />
      <input id="lead-email" type="email" placeholder="Your email" maxlength="120" style="${field}" />
      <textarea id="lead-msg" placeholder="What are you working on?" maxlength="1000" rows="3" style="${field}resize:vertical;"></textarea>
      <button id="lead-send" style="width:100%;padding:11px;border:none;border-radius:10px;background:linear-gradient(135deg,#9C27B0,#6a1b9a);color:#fff;font-size:15px;font-weight:600;cursor:pointer;">Send message</button>
      <p style="margin:8px 0 0;font-size:11px;color:#889;">Your email is used only to reply. <a href="/privacy.html" style="color:#b39ddb;">Privacy</a></p>`;
    container.appendChild(form);
    // Keep keystrokes out of the game while typing.
    form
      .querySelectorAll('input,textarea')
      .forEach((el) => el.addEventListener('keydown', (e) => e.stopPropagation()));
    const btn = form.querySelector('#lead-send') as HTMLButtonElement | null;
    btn?.addEventListener('click', async () => {
      const name = (form.querySelector('#lead-name') as HTMLInputElement).value;
      const email = (form.querySelector('#lead-email') as HTMLInputElement).value;
      const msg = (form.querySelector('#lead-msg') as HTMLTextAreaElement).value;
      if (!email.trim()) {
        this.toast('Please add your email.');
        return;
      }
      btn.disabled = true;
      btn.textContent = 'Sending…';
      const { submitLead } = await import('./Boards');
      const ok = await submitLead(name, email, msg);
      if (ok) {
        track('lead_submitted');
        form.innerHTML = `<p style="font-size:15px;color:#a5d6a7;text-align:center;padding:12px 0;">✓ Thanks${
          name.trim() ? ', ' + this.escapeHtml(name.trim()) : ''
        }! I'll be in touch soon.</p>`;
      } else {
        btn.disabled = false;
        btn.textContent = 'Send message';
        this.toast('Please check your email address.');
      }
    });
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
    const { getLeaderboard } = await import('./Boards');
    const [land, water] = await Promise.all([getLeaderboard('land'), getLeaderboard('water')]);
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
    const body = modal.querySelector('#lb-body');
    if (body)
      body.innerHTML = section('🚗 Land circuit', land) + section('⛵ Water circuit', water);
    modal.appendChild(this.makeRaceGuideButton(modal, 'leaderboard'));
  }

  /** "Take me to the start line" — closes the modal and compass-guides there. */
  private makeRaceGuideButton(modal: HTMLElement, from: string): HTMLButtonElement {
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
      this.panels.notifyClosed('race-leaderboard');
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
       <div id="rlb-body" style="text-align:left;">Loading…</div>`,
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
    modal.appendChild(this.makeRaceGuideButton(modal, 'race_finish'));
    this.overlay.appendChild(modal);
    const { getLeaderboard } = await import('./Boards');
    const entries = await getLeaderboard(circuit);
    const body = modal.querySelector('#rlb-body');
    if (!body) return;
    if (!entries.length) {
      body.innerHTML = `<p style="margin:2px 0 0;font-size:13px;color:#889;">No times yet — you're on the board!</p>`;
      return;
    }
    let highlighted = false;
    body.innerHTML = entries
      .map((e, i) => {
        const mine =
          !highlighted &&
          playerTimeMs != null &&
          e.name === playerName &&
          e.timeMs === playerTimeMs;
        if (mine) highlighted = true;
        return `<div style="display:flex;justify-content:space-between;padding:6px 9px;border-radius:8px;
          background:${mine ? 'rgba(245,179,1,0.22)' : i === 0 ? 'rgba(245,179,1,0.10)' : 'rgba(255,255,255,0.03)'};
          margin:3px 0;font-size:13px;${mine ? 'outline:1px solid rgba(245,179,1,0.5);' : ''}">
          <span>${i + 1}. ${this.escapeHtml(e.name)}${mine ? ' (you)' : ''}</span>
          <span style="font-variant-numeric:tabular-nums;">${fmt(e.timeMs)}</span></div>`;
      })
      .join('');
  }

  /** Guestbook: read recent notes + leave one. */
  async showGuestbook(): Promise<void> {
    const modal = this.buildCenteredModal('min(400px, calc(100vw - 32px))', 'guestbook');
    modal.insertAdjacentHTML(
      'beforeend',
      `<h2 style="margin:0 0 4px;color:#8a9bff;">✍️ Guestbook</h2>
       <p style="margin:0 0 12px;font-size:13px;color:#aab;">Leave a note for the next visitor.</p>
       <div style="display:flex;gap:8px;margin-bottom:12px;">
         <input id="gb-msg" maxlength="200" placeholder="Say hi…" style="flex:1;padding:9px 12px;border-radius:10px;
           border:none;font-size:14px;background:rgba(255,255,255,0.1);color:#fff;outline:1px solid rgba(120,170,255,0.5);" />
         <button id="gb-sign" style="padding:9px 16px;border:none;border-radius:10px;background:linear-gradient(135deg,#5b6cff,#8a4de0);
           color:#fff;font-size:14px;font-weight:600;cursor:pointer;">Sign</button>
       </div>
       <div id="gb-body" style="text-align:left;max-height:40vh;overflow:auto;">Loading…</div>`,
    );
    trackOnce('guestbook_opened');
    this.overlay.appendChild(modal);
    const { getGuestbook, signGuestbook } = await import('./Boards');
    const body = modal.querySelector('#gb-body');
    const render = async () => {
      const entries = await getGuestbook();
      if (!body) return;
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
      const ok = await signGuestbook(name, msg);
      if (ok) {
        if (input) input.value = '';
        this.toast('✍️ Signed the guestbook!');
        track('guestbook_signed');
        try {
          localStorage.setItem('ds_said_hi', '1');
        } catch {
          /* no storage */
        }
        this.onProgressMade?.();
        await render();
      } else {
        this.toast('Message could not be posted.');
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
      `<p style="margin:14px 0 0;font-size:11px;color:#788;font-style:italic;">
        Compiled nightly by the island's AI analyst · daily jobs assigned by the AI town planner</p>`,
    );
    trackOnce('island_times_opened');
    this.overlay.appendChild(modal);
  }

  private emoteWheel: HTMLElement | null = null;
  /** 😀 button in the top-right icon row: opens a small emote wheel. Emotes are
   *  sent through the normal chat pipeline, so they get proximity bubbles,
   *  moderation and muting for free — no separate protocol. */
  private createEmoteButton(): void {
    const btn = document.createElement('div');
    btn.textContent = '😀';
    Object.assign(btn.style, {
      position: 'absolute',
      top: 'calc(var(--sat, 0px) + 88px)',
      right: 'calc(var(--sar, 0px) + 148px)',
      background: 'rgba(0, 0, 0, 0.55)',
      padding: '7px 11px',
      borderRadius: '10px',
      fontSize: '15px',
      cursor: 'pointer',
      pointerEvents: 'auto',
      userSelect: 'none',
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
      this.panels.notifyClosed('emote-wheel');
      return;
    }
    this.panels.open('emote-wheel', {
      kind: 'sheet',
      hides: ['nav-chips'], // the wheel opens exactly over the chip column
      close: () => {
        this.emoteWheel?.remove();
        this.emoteWheel = null;
      },
    });
    const wheel = document.createElement('div');
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
    ['👋', '😂', '❤️', '🎉', '👍', '🔥', '😮', '🙌'].forEach((emo) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = emo;
      b.setAttribute('aria-label', `Send ${emo}`);
      Object.assign(b.style, {
        width: '40px',
        height: '40px',
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
          fontSize: '16px', // match the input: no iOS zoom, bigger tap targets
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
        el.click();
      }
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
          `<span title="${s.label}" style="font-size:22px;${s.has ? '' : 'filter:grayscale(1);opacity:0.35;'}">${s.icon}</span>`,
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
       <p style="margin:0 0 10px;font-size:12.5px;color:#aab;">Everything you've found so far — and what's still out there.</p>
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
                    `<div style="display:flex;gap:8px;margin:5px 0;font-size:12.5px;line-height:1.45;">
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
           <span style="display:block;color:#9ab;font-size:11.5px;line-height:1.35;">${E(r.hint)}</span>
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
          `<span title="${SimpleUI.esc(t.name)}" style="font-size:22px;${t.owned ? '' : 'filter:grayscale(1);opacity:0.35;'}">${SimpleUI.esc(t.icon)}</span>`,
      )
      .join(' ');

    const held = data.goods.reduce((n, r) => n + r.count, 0);

    modal.insertAdjacentHTML(
      'beforeend',
      `<h2 style="margin:0 0 2px;color:#8a9bff;">🎒 Your Pack</h2>
       <p style="margin:0 0 8px;font-size:12.5px;color:#aab;">Everything you're carrying right now.</p>
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
                    <span style="display:block;color:#9ab;font-size:11.5px;">${E(data.carrying.hint)}</span></span>
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
    const modal = this.buildCenteredModal('min(420px, calc(100vw - 32px))', 'build-chooser');
    modal.style.textAlign = 'left';
    modal.insertAdjacentHTML(
      'beforeend',
      `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
         <div style="font-size:17px;font-weight:700;">🔨 Raise a structure</div>
         <div style="display:flex;gap:8px;align-items:center;">
           <span style="background:#3a2f1acc;border:1px solid #8a6238;border-radius:999px;padding:3px 10px;font-size:12.5px;">🪵 ${wallet.timber}</span>
           <span style="background:#3a341acc;border:1px solid #b39b3a;border-radius:999px;padding:3px 10px;font-size:12.5px;">🪙 ${wallet.coins}</span>
         </div>
       </div>
       <div id="chooser-rows">
       ${rows
         .map(
           (r) => `
         <div style="display:flex;align-items:center;gap:11px;min-height:44px;padding:7px 4px;border-bottom:1px solid rgba(255,255,255,0.07);${r.affordable ? '' : 'opacity:0.62;'}">
           <span style="font-size:22px;">${r.icon}</span>
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
    const modal = this.buildCenteredModal('min(340px, calc(100vw - 32px))', 'build-options');
    modal.insertAdjacentHTML(
      'beforeend',
      `<div style="font-size:17px;font-weight:700;margin-bottom:4px;">${build.icon} Your ${build.name}</div>
       <div style="font-size:12.5px;color:#9ab;margin-bottom:14px;">Reclaim returns the timber — the carpenter keeps the coins as his labour fee.</div>
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
    this.muteBtn.textContent = muted || volume === 0 ? '🔇' : '🔊';
    Object.assign(this.muteBtn.style, {
      position: 'absolute',
      top: 'calc(var(--sat, 0px) + 88px)',
      right: 'calc(var(--sar, 0px) + 10px)',
      background: 'rgba(0, 0, 0, 0.55)',
      padding: '7px 11px',
      borderRadius: '10px',
      fontSize: '15px',
      cursor: 'pointer',
      pointerEvents: 'auto',
      userSelect: 'none',
    });
    this.muteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!this.onMuteToggle || !this.muteBtn) return;
      const nowMuted = this.onMuteToggle();
      this.hudMuted = nowMuted;
      // Volume 0 keeps the 🔇 even when unmuted — unmuting a zero-volume game
      // produces no sound, and an icon that claims otherwise is the same
      // lying-control class Ctrl+B just got fixed for.
      this.muteBtn.textContent = nowMuted || this.hudVolume === 0 ? '🔇' : '🔊';
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
    this.chipHost(this.muteBtn, { drawer: true, label: 'Sound', order: 8 });
    this.createVolumePill(volume);
    this.createReducedMotionButton();
    this.createCustomizeButton();
  }

  /**
   * Master-volume slider in a popover pill beside the 🔊 button. The icon row
   * is fully packed (♿ at +56, 🎨 at +102, the wide Portfolio pill below at
   * +126), so a permanently-visible slider has nowhere to live at 320px-wide
   * viewports — instead the pill OVERLAYS the ♿/🎨 slots temporarily (opaque,
   * higher z) while hovered/tapped, and vanishes after.
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
      right: 'calc(var(--sar, 0px) + 52px)',
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
        this.muteBtn.textContent = this.hudMuted || v === 0 ? '🔇' : '🔊';
        this.muteBtn.setAttribute('aria-pressed', String(this.hudMuted));
      }
      this.showVolumePill(3500); // keep it up while adjusting
    });
    pill.appendChild(slider);
    this.overlay.appendChild(pill);
    this.panels.registerLayer('nav-chips', pill);
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
    btn.textContent = '🎨';
    btn.title = 'Customize appearance (C)';
    Object.assign(btn.style, {
      position: 'absolute',
      // Icon row (see createMuteButton): 🎨 ♿ 🔊 sit side by side so the wide
      // "📖 Portfolio" pill below them has a clear row of its own. They used to
      // stack vertically at the same right edge and the pill covered them.
      top: 'calc(var(--sat, 0px) + 88px)',
      right: 'calc(var(--sar, 0px) + 102px)',
      background: 'rgba(0, 0, 0, 0.55)',
      padding: '7px 11px',
      borderRadius: '10px',
      fontSize: '15px',
      cursor: 'pointer',
      pointerEvents: 'auto',
      userSelect: 'none',
    });
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.onCustomizeToggle?.();
    });
    this.makeHudButtonAccessible(btn, 'Customize appearance');
    this.chipHost(btn, { drawer: true, label: 'Customize', order: 6 });
  }

  /** ♿ toggle: dampens the fly-in, camera swoop, and pulsing gates. */
  private createReducedMotionButton(): void {
    const btn = document.createElement('div');
    btn.textContent = '♿';
    btn.title = 'Reduced motion — dampens the fly-in, camera swoop, and pulsing effects';
    Object.assign(btn.style, {
      position: 'absolute',
      top: 'calc(var(--sat, 0px) + 88px)',
      right: 'calc(var(--sar, 0px) + 56px)', // 46px pitch; the buttons are 43px wide
      padding: '7px 11px',
      borderRadius: '10px',
      fontSize: '15px',
      cursor: 'pointer',
      pointerEvents: 'auto',
      userSelect: 'none',
      transition: 'background 0.15s ease',
    });
    const render = () => {
      btn.style.background = a11y.reducedMotion
        ? 'rgba(80, 180, 120, 0.75)'
        : 'rgba(0, 0, 0, 0.55)';
      btn.setAttribute('aria-pressed', String(a11y.reducedMotion));
    };
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      a11y.setReducedMotion(!a11y.reducedMotion);
      render();
    });
    this.makeHudButtonAccessible(btn, 'Toggle reduced motion', a11y.reducedMotion);
    render();
    this.chipHost(btn, { drawer: true, label: 'Reduce motion', order: 9 });
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
      background: 'linear-gradient(135deg, #5b6cff, #8a4de0)',
      color: 'white',
      padding: '7px 12px',
      borderRadius: '10px',
      fontSize: '13px',
      fontWeight: '600',
      fontFamily: 'system-ui, sans-serif',
      cursor: 'pointer',
      pointerEvents: 'auto',
      userSelect: 'none',
      boxShadow: '0 3px 10px rgba(0,0,0,0.3)',
    });
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.togglePortfolioMenu();
    });
    this.makeHudButtonAccessible(btn, 'Open portfolio menu');
    this.chipHost(btn, { drawer: true, order: 2 });
  }

  /**
   * Persistent "Work with me" pill (top-center). A portfolio's whole job is to
   * convert, but the only always-visible path to contact was buried in the
   * Portfolio menu. This routes straight to the Contact zone from anywhere.
   */
  private createContactCTA(): void {
    const btn = document.createElement('div');
    btn.textContent = '💼 Work with me';
    Object.assign(btn.style, {
      position: 'absolute',
      // Stacked just below the 📖 Portfolio pill (top-right conversion column),
      // clear of the top-center quest/delivery tracker.
      top: 'calc(var(--sat, 0px) + 164px)',
      right: 'calc(var(--sar, 0px) + 10px)',
      background: 'linear-gradient(135deg, #12b76a, #0e9f6e)',
      color: 'white',
      padding: '7px 14px',
      borderRadius: '999px',
      fontSize: '13px',
      fontWeight: '700',
      fontFamily: 'system-ui, sans-serif',
      cursor: 'pointer',
      pointerEvents: 'auto',
      userSelect: 'none',
      boxShadow: '0 3px 10px rgba(0,0,0,0.3)',
      zIndex: '1200',
    });
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

  /** Photo mode entry — the game loop owns the actual capture (renderer flag). */
  private onPhotoRequest: (() => void) | null = null;
  public setOnPhotoRequest(fn: () => void): void {
    this.onPhotoRequest = fn;
  }

  /** 📸 pill in the top-right conversion column (below Work-with-me). */
  private createPhotoButton(): void {
    const btn = document.createElement('div');
    btn.textContent = this.isTouch ? '📸' : '📸 P';
    Object.assign(btn.style, {
      position: 'absolute',
      top: 'calc(var(--sat, 0px) + 202px)',
      right: 'calc(var(--sar, 0px) + 10px)',
      background: 'rgba(12, 16, 28, 0.72)',
      border: '1px solid rgba(255,255,255,0.22)',
      color: 'white',
      padding: '7px 12px',
      borderRadius: '999px',
      fontSize: '13px',
      fontWeight: '600',
      fontFamily: 'system-ui, sans-serif',
      cursor: 'pointer',
      pointerEvents: 'auto',
      userSelect: 'none',
      boxShadow: '0 3px 10px rgba(0,0,0,0.3)',
    });
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.onPhotoRequest?.();
    });
    // The chip reads "📸 P" — the bare P is a keyboard shortcut nothing else
    // explains, so the label (now also the hover tooltip) names it.
    this.makeHudButtonAccessible(btn, 'Take a photo of the island (P)');
    this.chipHost(btn, { drawer: true, label: 'Photo', order: 5 });
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
    });
    const cap = document.createElement('div');
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
      fontSize: '15.5px',
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
    btn.textContent = '👋 Say hi';
    Object.assign(btn.style, {
      position: 'absolute',
      top: 'calc(var(--sat, 0px) + 240px)',
      right: 'calc(var(--sar, 0px) + 10px)',
      background: 'rgba(12, 16, 28, 0.72)',
      border: '1px solid rgba(255,255,255,0.22)',
      color: 'white',
      padding: '7px 12px',
      borderRadius: '999px',
      fontSize: '13px',
      fontWeight: '600',
      fontFamily: 'system-ui, sans-serif',
      cursor: 'pointer',
      pointerEvents: 'auto',
      userSelect: 'none',
      boxShadow: '0 3px 10px rgba(0,0,0,0.3)',
    });
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.showSayHi();
    });
    this.makeHudButtonAccessible(btn, 'Say hi — leave a quick note');
    this.chipHost(btn, { drawer: true, order: 3 });
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
    const field =
      'width:100%;box-sizing:border-box;padding:9px 12px;border-radius:10px;border:none;' +
      'font-size:14px;background:rgba(255,255,255,0.1);color:#fff;' +
      'outline:1px solid rgba(120,170,255,0.4);margin:0 0 8px;font-family:inherit;';
    modal.insertAdjacentHTML(
      'beforeend',
      `<h2 style="margin:0 0 4px;color:#8a9bff;">👋 Say hi</h2>
       <p style="margin:0 0 12px;font-size:13px;color:#aab;">Leave a note on the island — takes five seconds.</p>
       <input id="sh-name" maxlength="24" placeholder="Your name (optional)" value="${this.escapeHtml(savedName)}" style="${field}" />
       <textarea id="sh-msg" maxlength="200" rows="3" placeholder="Hi Abbas! 👋" style="${field}resize:none;"></textarea>
       <input id="sh-email" maxlength="80" type="email" placeholder="Email — only if you'd like a reply (optional)" style="${field}" />
       <button id="sh-send" style="width:100%;padding:11px;border:none;border-radius:10px;margin-top:2px;
         background:linear-gradient(135deg,#5b6cff,#8a4de0);color:#fff;font-size:14.5px;font-weight:600;cursor:pointer;">Send 👋</button>
       <p style="margin:9px 0 0;font-size:11px;color:#788;">Notes appear in the public guestbook — with an email it goes straight to Abbas instead.</p>`,
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
    msgEl?.focus();
    sendBtn?.addEventListener('click', () => {
      void (async () => {
        const msg = msgEl?.value.trim() ?? '';
        if (!msg) {
          this.toast('Write a little something first!');
          return;
        }
        const email = emailEl?.value.trim() ?? '';
        if (email && !/^\S+@\S+\.\S+$/.test(email)) {
          this.toast('Please check your email address.');
          return;
        }
        const name = nameEl?.value.trim() || 'Traveller';
        if (!sendBtn) return;
        sendBtn.disabled = true;
        sendBtn.textContent = 'Sending…';
        const boards = await import('./Boards');
        const ok = email
          ? await boards.submitLead(name, email, msg)
          : await boards.signGuestbook(name, msg);
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
          this.toast('Could not send — try again in a moment.');
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

  /** 🎒 Your Pack — the held-inventory panel. Desktop gets its own chip under
   *  the completion pill; touch re-homes it into the ☰ drawer. */
  private createInventoryButton(): void {
    const btn = document.createElement('div');
    btn.textContent = '🎒';
    Object.assign(btn.style, {
      position: 'absolute',
      top: 'calc(var(--sat, 0px) + 316px)',
      right: 'calc(var(--sar, 0px) + 10px)',
      background: 'rgba(12, 16, 28, 0.72)',
      border: '1px solid rgba(255,255,255,0.22)',
      color: 'white',
      padding: '7px 12px',
      borderRadius: '999px',
      fontSize: '13px',
      fontWeight: '600',
      fontFamily: 'system-ui, sans-serif',
      cursor: 'pointer',
      pointerEvents: 'auto',
      userSelect: 'none',
      boxShadow: '0 3px 10px rgba(0,0,0,0.3)',
    });
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.showInventory();
    });
    this.makeHudButtonAccessible(btn, 'Your pack (inventory)');
    this.chipHost(btn, { drawer: true, label: 'Your Pack', order: 4 });
  }

  private createCompletionButton(): void {
    const btn = document.createElement('div');
    btn.textContent = '🏝 …';
    Object.assign(btn.style, {
      position: 'absolute',
      top: 'calc(var(--sat, 0px) + 278px)',
      right: 'calc(var(--sar, 0px) + 10px)',
      background: 'rgba(12, 16, 28, 0.72)',
      border: '1px solid rgba(255,255,255,0.22)',
      color: 'white',
      padding: '7px 12px',
      borderRadius: '999px',
      fontSize: '13px',
      fontWeight: '600',
      fontFamily: 'system-ui, sans-serif',
      cursor: 'pointer',
      pointerEvents: 'auto',
      userSelect: 'none',
      boxShadow: '0 3px 10px rgba(0,0,0,0.3)',
    });
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.showCompletionModal();
    });
    this.makeHudButtonAccessible(btn, 'Island completion checklist');
    this.chipHost(btn, { drawer: true, label: 'Progress', order: 7 });
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
      this.completionBtn.textContent = this.isTouch ? `🏝 ${pct}%` : `🏝 ${pct}% explored`;
    }
    // Introduce the checklist at the FIRST increment — the moment the number
    // visibly moves is the discovery moment; a welcome-close toast would
    // have been documentation (and that slot is the orientation hint's).
    try {
      if (seeded && pct > prev && !localStorage.getItem('ds_hint_checklist')) {
        localStorage.setItem('ds_hint_checklist', '1');
        this.toast('🏝 That ticked up — tap the percentage for everything worth doing here.');
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
               <div style="font-size:13.5px;font-weight:600;color:${it.done ? '#9fd8b8' : '#e8edf5'};">${it.icon} ${this.escapeHtml(it.label)}</div>
               ${it.done ? '' : `<div style="font-size:12px;color:#93a;color:#8fa0b8;margin-top:1px;">${this.escapeHtml(it.hint)}</div>`}
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
      `<h2 style="margin:0 0 10px;color:#8a9bff;font-size:18px;">📸 Your island shot</h2>
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
      fontSize: '13.5px',
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
      fontSize: '13.5px',
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
    this.panels.open('portfolio-menu', {
      kind: 'sheet',
      hides: ['nav-chips'],
      close: () => {
        this.portfolioMenuDiv?.remove();
        this.portfolioMenuDiv = null;
      },
    });
    const menu = document.createElement('div');
    Object.assign(menu.style, {
      position: 'fixed',
      top: '50%',
      left: '50%',
      transform: 'translate(-50%, -50%)',
      background: 'rgba(12, 12, 20, 0.95)',
      color: 'white',
      padding: '24px',
      borderRadius: '16px',
      pointerEvents: 'auto',
      zIndex: '1600',
      width: 'min(340px, calc(100vw - 32px))',
      textAlign: 'center',
      border: '1px solid rgba(255,255,255,0.15)',
      boxShadow: '0 12px 40px rgba(0,0,0,0.5)',
    });
    const sections: Array<{ id: string; label: string }> = [
      { id: 'welcome', label: '🏠 About this world' },
      { id: 'professional', label: '💼 Professional' },
      { id: 'projects', label: '🚀 Projects' },
      { id: 'personal', label: '🎨 Personal' },
      { id: 'contact', label: '📬 Get in touch' },
    ];
    const rows = sections
      .map(
        (s) =>
          `<button data-section="${s.id}" style="display:block;width:100%;margin:7px 0;padding:12px;
            background:#26263340;color:#fff;border:1px solid rgba(255,255,255,0.12);
            border-radius:10px;font-size:15px;cursor:pointer;text-align:left;">${s.label}</button>`,
      )
      .join('');
    const pp = this.passport;
    const ppLabel = pp
      ? pp.isComplete()
        ? '🛂 Passport — complete 👑'
        : `🛂 Passport — ${pp.count()}/${pp.total()} stamped`
      : '🛂 Passport';
    menu.innerHTML = `
      <h2 style="margin:0 0 4px; color:#8a9bff;">📖 Portfolio</h2>
      <p style="margin:0 0 14px; font-size:13px; color:#aab;">Jump to any section — or close this and explore the island.</p>
      <button data-passport="1" style="display:block;width:100%;margin:0 0 12px;padding:12px;
        background:linear-gradient(135deg,rgba(18,183,106,0.28),rgba(14,159,110,0.18));color:#fff;
        border:1px solid rgba(120,220,170,0.45);border-radius:10px;font-size:14px;font-weight:600;
        cursor:pointer;text-align:center;">${ppLabel}</button>
      ${rows}
      <div style="display:flex;gap:8px;margin-top:10px;">
        <button data-board="leaderboard" style="flex:1;padding:11px;background:#26263340;color:#fff;
          border:1px solid rgba(255,255,255,0.12);border-radius:10px;font-size:14px;cursor:pointer;">🏁 Leaderboard</button>
        <button data-board="guestbook" style="flex:1;padding:11px;background:#26263340;color:#fff;
          border:1px solid rgba(255,255,255,0.12);border-radius:10px;font-size:14px;cursor:pointer;">✍️ Guestbook</button>
      </div>
      <button data-board="times" style="display:block;width:100%;margin-top:8px;padding:11px;background:#26263340;color:#fff;
        border:1px solid rgba(255,215,121,0.28);border-radius:10px;font-size:14px;cursor:pointer;">📰 Island Times</button>
      <button data-pack style="display:block;width:100%;margin-top:8px;padding:11px;background:#26263340;color:#fff;
        border:1px solid rgba(138,155,255,0.35);border-radius:10px;font-size:14px;cursor:pointer;">🎒 Your Pack</button>
      <button data-journal style="display:block;width:100%;margin-top:8px;padding:11px;background:#26263340;color:#fff;
        border:1px solid rgba(138,155,255,0.35);border-radius:10px;font-size:14px;cursor:pointer;">📔 Island Journal</button>`;
    // close button
    const close = document.createElement('button');
    close.textContent = '×';
    Object.assign(close.style, {
      position: 'absolute',
      top: '10px',
      right: '14px',
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
  }

  /**
   * Touch controls (joystick + E / Jump buttons), created only on touch
   * devices. Buttons dispatch synthetic keyboard events so every existing
   * input path (interaction, dialogue advance, jump) works unchanged;
   * the analog joystick is merged into movement in main-simple.
   */
  private createTouchControls(): void {
    if (!this.isTouch) return;

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
    hit.appendChild(base);
    this.overlay.appendChild(hit);
    this.panels.registerLayer('touch-controls', hit);

    const moveThumb = (dx: number, dy: number) => {
      thumb.style.left = `${31 + dx}px`;
      thumb.style.top = `${31 + dy}px`;
    };
    // Identifier-tracked: e.touches[0] is the earliest finger ON THE PAGE,
    // so with a camera finger already down the joystick read the WRONG
    // finger and movement lurched. Track the pad's own finger by identifier.
    let joyTouchId: number | null = null;
    const applyJoyTouch = (t: Touch) => {
      const rect = base.getBoundingClientRect();
      let dx = t.clientX - (rect.left + rect.width / 2);
      let dy = t.clientY - (rect.top + rect.height / 2);
      const len = Math.hypot(dx, dy);
      const max = 40;
      if (len > max) {
        dx = (dx / len) * max;
        dy = (dy / len) * max;
      }
      moveThumb(dx, dy);
      // ~12% radial dead zone, renormalized so the range past it still spans
      // 0..1: a resting thumb's 2-3px jitter must not creep the player or
      // flicker the idle/walk animation.
      const DEAD = 0.12;
      const mag = Math.min(1, len / max);
      if (mag < DEAD) {
        this.joyState.strafe = 0;
        this.joyState.forward = 0;
      } else {
        const scale = (mag - DEAD) / (1 - DEAD) / (mag * max);
        this.joyState.strafe = dx * scale;
        this.joyState.forward = -dy * scale;
      }
    };
    hit.addEventListener(
      'touchstart',
      (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (joyTouchId !== null || e.changedTouches.length === 0) return;
        const t = e.changedTouches[0];
        joyTouchId = t.identifier;
        hapticPulse(5); // first-engage tick
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
          this.joyState.forward = 0;
          this.joyState.strafe = 0;
          moveThumb(0, 0);
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
    const makeButton = (
      icon: string,
      caption: string,
      bottom: string,
      code: string,
      key: string,
      tint: string,
      rightPx = 26,
      layer: 'touch-controls' | 'aux-controls' = 'touch-controls',
    ): HTMLElement => {
      const btn = document.createElement('div');
      btn.innerHTML =
        `<div style="font-size:24px;line-height:1;">${icon}</div>` +
        `<div style="font-size:10px;font-weight:700;letter-spacing:1px;margin-top:2px;opacity:0.9;">${caption}</div>`;
      Object.assign(btn.style, {
        position: 'absolute',
        right: `calc(var(--sar, 0px) + ${rightPx}px)`,
        bottom: `calc(var(--sab, 0px) + ${bottom})`,
        width: '74px',
        height: '74px',
        borderRadius: '50%',
        background: tint,
        border: '1.5px solid rgba(255,255,255,0.28)', // quieter touch-button rim
        boxShadow: '0 3px 10px rgba(0,0,0,0.3)',
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
          hapticPulse(8);
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
    makeButton('👆', 'USE', '36px', 'KeyE', 'e', 'rgba(80,150,90,0.5)');
    makeButton('⤒', 'JUMP', '124px', 'Space', ' ', 'rgba(70,120,190,0.5)');
    makeButton('👋', 'WAVE', '212px', 'KeyQ', 'q', 'rgba(160,120,60,0.5)');
    // DIVE — touch's only route to the free dive (Shift is desktop-only).
    // Contextual like FEED/EAT: it exists only while actually SWIMMING, so a
    // walker never sees it. Gated on isSwimming(), NOT isInWater(): the
    // latter is true within 1.2u of a surface that swings +/-0.45 with the
    // waves, so a player standing at the waterline would watch it strobe.
    this.diveBtnEl = makeButton(
      '🤿',
      'DIVE',
      '300px',
      'ShiftLeft',
      'Shift',
      'rgba(60,140,175,0.5)',
      26,
      'aux-controls',
    );
    this.diveBtnEl.style.visibility = 'hidden';
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
      '🌾',
      'FEED',
      '36px',
      'KeyF',
      'f',
      'rgba(150,130,70,0.5)',
      112,
      'aux-controls',
    );
    // EAT stacks over FEED in the second column (124px over 36px, same 112 inset)
    this.eatBtnEl = makeButton(
      '🍽️',
      'EAT',
      '124px',
      'KeyG',
      'g',
      'rgba(150,90,70,0.5)',
      112,
      'aux-controls',
    );
    this.feedBtnEl.style.visibility = 'hidden';
    this.eatBtnEl.style.visibility = 'hidden';

    // Proximity chat: 💬 opens the text input, 🎤 is press-hold-to-talk.
    // Stacked above the joystick (which spans bottom 26–136px here) so
    // neither control overlaps it.
    const chatBtn = document.createElement('div');
    chatBtn.textContent = '💬';
    Object.assign(chatBtn.style, {
      position: 'absolute',
      left: 'calc(var(--sal, 0px) + 26px)',
      // 174, not 152: the joystick's INVISIBLE hit square is 166px tall from
      // the bottom edge, so 152 put the lower 14px of this button inside it
      // (measured, both orientations) — a drag starting there opened chat
      // instead of moving. 166 + 8px gap.
      bottom: 'calc(var(--sab, 0px) + 174px)',
      background: 'rgba(0,0,0,0.55)',
      padding: '7px 11px',
      borderRadius: '10px',
      fontSize: '15px',
      cursor: 'pointer',
      pointerEvents: 'auto',
      userSelect: 'none',
      // Match the other touch buttons: sit above the dialogue panel (1600)
      // so it isn't hidden behind (and its taps swallowed by) it mid-NPC-chat.
      zIndex: '1650',
    });
    chatBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.openChatInput();
    });
    this.makeHudButtonAccessible(chatBtn, 'Open chat');
    this.overlay.appendChild(chatBtn);
    this.panels.registerLayer('aux-controls', chatBtn);

    const micBtn = document.createElement('div');
    this.micBtn = micBtn;
    micBtn.textContent = '🎤';
    Object.assign(micBtn.style, {
      position: 'absolute',
      left: 'calc(var(--sal, 0px) + 26px)',
      bottom: 'calc(var(--sab, 0px) + 220px)', // rides 46px above 💬 (see there)
      background: 'rgba(0,0,0,0.55)',
      padding: '7px 11px',
      borderRadius: '10px',
      fontSize: '15px',
      cursor: 'pointer',
      pointerEvents: 'auto',
      userSelect: 'none',
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
          <div style="font-family:'Bebas Neue',system-ui,sans-serif;font-size:25px;letter-spacing:1.5px;">
            DIGISCALABILITY LIFE ISLAND</div>
          <div style="color:#a9bdd4;font-size:12.5px;margin-top:3px;max-width:290px;">
            Abbas Ali's hand-built 3D portfolio — a living island run by AI agents</div>
          <div id="ld-msg" style="color:#8fa6bd;font-size:12.5px;margin:8px 0 16px;min-height:16px;"></div>
          <div style="width:230px;height:7px;background:rgba(255,255,255,0.12);border-radius:6px;overflow:hidden;">
            <div id="ld-bar" style="width:0%;height:100%;border-radius:6px;
                 background:linear-gradient(90deg,#4CAF50,#7fd18b);transition:width 0.35s ease;"></div>
          </div>
          <div id="ld-pct" style="color:#6e8298;font-size:11px;margin-top:8px;">0%</div>
        </div>`;
      this.loadingBar = this.loadingDiv.querySelector('#ld-bar');
      this.loadingPct = this.loadingDiv.querySelector('#ld-pct');
      this.loadingMsg = this.loadingDiv.querySelector('#ld-msg');
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
      const el = this.loadingDiv;
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

  /**
   * Show welcome message
   */
  showWelcome(awayDelta?: AwayDelta | null): void {
    if (!this.welcomeDiv) {
      this.welcomeDiv = document.createElement('div');
      Object.assign(this.welcomeDiv.style, {
        position: 'absolute',
        top: '50%',
        left: '50%',
        transform: 'translate(-50%, -50%)',
        background: 'rgba(0, 0, 0, 0.9)',
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
    this.panels.open('welcome', {
      kind: 'modal',
      hides: ['nav-chips', 'touch-controls', 'aux-controls', 'ambient-info'],
      close: () => this.hideWelcome(),
      ownEscape: true, // welcome keeps its own Escape listener below
    });

    trackOnce('welcome_shown');

    // Returning visitors get a brief hello; first-timers get the pitch + CTAs.
    const returning = localStorage.getItem('ds_welcomed') === '1';
    const controlsLine = this.isTouch
      ? 'Drag the joystick to move · 👆 USE to interact · ⤒ JUMP (hold to swim) · 👋 WAVE.'
      : 'WASD to move · mouse to look · space to jump · Q to wave.';

    // Primary CTAs: the work and the contact path. A recruiter who won't
    // explore still reaches everything in one click.
    const ctaRow = `
      <div style="display:flex; gap:10px; flex-wrap:wrap; justify-content:center; margin:0 0 10px;">
        <button data-cta="projects" style="flex:1 1 140px; padding:12px 14px; border:none; border-radius:10px;
          background:linear-gradient(135deg,#5b6cff,#8a4de0); color:#fff; font-size:15px; font-weight:600; cursor:pointer;">
          🚀 See the work</button>
        <button data-cta="contact" style="flex:1 1 140px; padding:12px 14px; border-radius:10px;
          background:rgba(38,38,51,0.5); color:#fff; border:1px solid rgba(255,255,255,0.18); font-size:15px; font-weight:600; cursor:pointer;">
          📬 Get in touch</button>
      </div>`;

    // The recruiter pill — PROMOTED from a 12px footnote link below the
    // controls line. The primary audience got the least visible control on
    // the card while "Beat the lap record" had a real button: hierarchy
    // exactly inverted from the audience priority. Same data-recruit
    // contract; amber border borrowed from the old meet-AI button.
    const recruiterPill = `
      <button data-recruit style="width:100%; padding:10px 14px; margin:0 0 12px; border-radius:10px;
        background:rgba(38,38,51,0.5); color:#ffe3a3; border:1px solid rgba(255,212,121,0.45); font-size:13.5px; font-weight:600; cursor:pointer;">
        ⏱️ Hiring? Watch the 60-second highlights</button>`;

    // Explicit dismiss button so the pitch stays put until the visitor chooses
    // to leave it (moving with WASD no longer evaporates it). The line under
    // it names the compass pill — the card's one pointer at the persistent
    // wayfinding surface that is literally on screen behind it.
    const exploreBtn = `
      <button data-dismiss="1" style="width:100%; padding:11px 14px; margin:0 0 4px; border:none; border-radius:10px;
        background:linear-gradient(135deg,#12b76a,#0e9f6e); color:#fff; font-size:15px; font-weight:700; cursor:pointer;">
        🧭 Explore the island →</button>
      <p style="margin:0 0 12px; font-size:11px; color:#8fa0b5;">
        The gold ➤ pill at the top of your screen points to your next stop.</p>`;

    // Tertiary chip row: three near-duplicate "guided experiences" (meet-AI /
    // tour / race) collapsed from two full-width tiers into one 13px line —
    // seven same-weight buttons was choice overload, and two of these call
    // the same tour rail anyway. Same data-* analytics contracts. 44px-tall
    // touch targets via padding despite the small type.
    const chipPad = this.isTouch ? 'padding:12px 8px;' : 'padding:8px 8px;';
    const secondaryRow = `
      <div style="display:flex; gap:8px; margin:0 0 12px;">
        <button data-meet-ai="1" style="flex:1; ${chipPad} border-radius:10px;
          background:rgba(38,38,51,0.5); color:#dfe6f2; border:1px solid rgba(255,255,255,0.16); font-size:13px; cursor:pointer;">
          🤖 Ask the townsfolk</button>
        <button data-tour="1" style="flex:1; ${chipPad} border-radius:10px;
          background:rgba(38,38,51,0.5); color:#dfe6f2; border:1px solid rgba(255,255,255,0.16); font-size:13px; cursor:pointer;">
          🎬 Full tour</button>
        <button data-race="1" style="flex:1; ${chipPad} border-radius:10px;
          background:rgba(38,38,51,0.5); color:#dfe6f2; border:1px solid rgba(255,255,255,0.16); font-size:13px; cursor:pointer;">
          🏁 Try a race</button>
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
           ${awayDelta.headline ? `🏝️ ${awayDelta.headline} ${awayDelta.weather ? (WGLYPH[awayDelta.weather] ?? '') : ''}<br>` : ''}
           <span id="wlc-gb">✍️ checking the guestbook…</span>
         </div>`
      : '';
    this.welcomeDiv.innerHTML = returning
      ? `<h2 style="margin: 0 0 12px 0; color: #4CAF50;">👋 Welcome back!</h2>
         ${awayHtml}
         ${ctaRow}
         ${secondaryRow}
         <p style="margin:0; font-size:12px; color:#9aa;">Dive back in — this closes on its own.</p>`
      : `
      <h2 style="margin: 0 0 8px 0; color: #4CAF50;">DigiScalability Life Island</h2>
      <p style="margin: 0 0 12px 0; font-size:15px; line-height:1.5;">
        I'm <strong>Abbas</strong> — I build AI-powered products, and this island is my
        portfolio. Every building holds a real project: walk up to open it, or jump
        straight there below.</p>
      ${
        // Progressive disclosure on short phones (SE 667px): the AI-agent
        // detail paragraph is the "Ask the townsfolk" chip's job — on a
        // screen this size the full pitch pushed the CTAs below the fold.
        this.isTouch && window.innerHeight < 700
          ? ''
          : `<p style="margin: 0 0 14px 0; font-size:13.5px; line-height:1.5; color:#cdd6e4;">
        The townsfolk are <strong>live AI agents</strong> — a planner sets their jobs
        each morning, an analyst files a nightly report. Walk up to anyone and ask
        them anything.</p>`
      }
      ${recruiterPill}
      ${ctaRow}
      ${exploreBtn}
      ${secondaryRow}
      <p style="margin: 0; font-size: 12px; color: #9aa;">${controlsLine}</p>
    `;

    // Dismiss only on an explicit choice — a CTA, the Explore button, or
    // Escape. The old "any key / click-outside" dismiss evaporated the pitch
    // the instant a visitor pressed W to move.
    const onEscape = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') closeWelcome();
    };
    const closeWelcome = () => {
      this.hideWelcome();
      document.removeEventListener('keydown', onEscape);
    };

    // Move focus INTO the dialog: aria-modal was set but focus never
    // followed, so keyboard/screen-reader users started outside their own
    // welcome card.
    (this.welcomeDiv.querySelector('button[data-cta="projects"]') as HTMLElement | null)?.focus();

    this.welcomeDiv.querySelectorAll('button[data-cta]').forEach((b) => {
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        const cta = (b as HTMLElement).dataset.cta!;
        track('welcome_cta', { cta });
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
      closeWelcome();
      this.onTour?.();
    });
    this.welcomeDiv.querySelector('button[data-recruit]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      track('welcome_cta', { cta: 'recruit' });
      closeWelcome();
      this.onRecruitTour?.();
    });
    this.welcomeDiv.querySelector('button[data-race]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      track('welcome_cta', { cta: 'race' });
      closeWelcome();
      this.onRaceGuide?.();
    });

    document.addEventListener('keydown', onEscape);
    // The delta card earns a longer look; the plain welcome-back stays snappy.
    // But INTENT cancels the clock: the card used to vanish unconditionally —
    // under the visitor's cursor mid-reach for a button. First hover / focus /
    // touch means they're reading it; from then on it closes only by choice.
    if (returning) {
      // 7000 (was 5600) with a delta card: the guestbook line patches in
      // ASYNC and could appear with under a second left to read it.
      const autoClose = window.setTimeout(closeWelcome, awayDelta ? 7000 : 2600);
      const cancelAuto = () => window.clearTimeout(autoClose);
      this.welcomeDiv.addEventListener('pointerenter', cancelAuto, { once: true });
      this.welcomeDiv.addEventListener('focusin', cancelAuto, { once: true });
      this.welcomeDiv.addEventListener('touchstart', cancelAuto, { once: true, passive: true });
    }
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
  hideWelcome(): void {
    if (this.welcomeDiv) {
      this.welcomeDiv.remove();
      this.welcomeDiv = null;
      this.panels.notifyClosed('welcome'); // no-op during a sweep
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
      try {
        if (wasFirstEver && !localStorage.getItem('ds_hint_compass')) {
          localStorage.setItem('ds_hint_compass', '1');
          this.toast('🧭 The gold ➤ up top points to your next stop — tap it for the island map.');
        }
      } catch {
        /* no storage — skip the one-time hint rather than repeat it forever */
      }
    }
  }

  /**
   * Check if welcome is visible
   */
  isWelcomeVisible(): boolean {
    // The name modal counts as blocking too, so movement/interaction stays
    // suspended (and typing your name never drives the player).
    return this.welcomeDiv !== null || this.nameModalDiv !== null;
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
    modal.innerHTML = `
      <div style="font-size:26px;font-weight:700;">🌎 Welcome to Life Island</div>
      <div style="opacity:0.85;font-size:15px;max-width:320px;">What should other visitors call you?</div>
    `;
    const input = document.createElement('input');
    input.type = 'text';
    input.maxLength = 20;
    input.placeholder = 'Your name';
    input.value = defaultName || '';
    Object.assign(input.style, {
      padding: '11px 14px',
      fontSize: '16px',
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
    Object.assign(btn.style, {
      padding: '12px 26px',
      fontSize: '16px',
      fontWeight: '700',
      borderRadius: '12px',
      border: 'none',
      background: 'linear-gradient(135deg,#4CAF50,#3d8b40)',
      color: 'white',
      cursor: 'pointer',
    });
    // Inline validation message (offensive / too-short names)
    const err = document.createElement('div');
    Object.assign(err.style, {
      color: '#ff9a9a',
      fontSize: '12.5px',
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
    // anonymously (caller gets '' and saves nothing — asked again next time
    // a social feature needs it).
    const skip = document.createElement('button');
    skip.textContent = 'Skip — just browsing';
    Object.assign(skip.style, {
      background: 'transparent',
      border: 'none',
      color: 'rgba(255,255,255,0.65)',
      fontSize: '13px',
      textDecoration: 'underline',
      cursor: 'pointer',
      padding: '4px',
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
    if (!this.interactionDiv) {
      this.interactionDiv = document.createElement('div');
      Object.assign(this.interactionDiv.style, {
        position: 'absolute',
        // bottom/left/maxWidth come from applyPromptAnchor (breakpoint-aware,
        // and re-applied on rotation) right after this style block.
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

    this.interactionDiv.innerHTML = this.touchify(text);
  }

  /**
   * Rewrite keyboard prompts into touch language on phones/tablets. Desktop
   * gets the text unchanged. Maps each key to the on-screen button that fires
   * it so "Press E / Space / Q" becomes "Tap USE / JUMP / WAVE".
   */
  private touchify(html: string): string {
    if (!this.isTouch) return html;
    return html
      .replace(/Press <strong>E<\/strong>/g, 'Tap <strong>👆 USE</strong>')
      .replace(/Press <strong>Space<\/strong>/g, 'Tap <strong>⤒ JUMP</strong>')
      .replace(/Hold <strong>Space<\/strong>/g, 'Hold <strong>⤒ JUMP</strong>')
      .replace(/Press <strong>Q<\/strong>/g, 'Tap <strong>👋 WAVE</strong>');
  }

  /**
   * Hide interaction prompt
   */
  hideInteractionPrompt(): void {
    if (this.interactionDiv) {
      this.interactionDiv.remove();
      this.interactionDiv = null;
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
        top: 'calc(var(--sat, 0px) + 10px)',
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
      position: 'absolute',
      top: 'calc(var(--sat, 0px) + 35px)',
      right: 'calc(var(--sar, 0px) + 10px)',
      background: 'rgba(0, 0, 0, 0.7)',
      color: 'white',
      padding: '5px 10px',
      borderRadius: '5px',
      fontSize: '12px',
      fontFamily: 'monospace',
      pointerEvents: 'auto',
      cursor: 'pointer',
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

  /** Roster panel: who's on the island right now, with a per-peer mute toggle. */
  showRoster(): void {
    const peers = this.rosterProvider?.() ?? [];
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
          ) => `<div data-peer="${p.id}" style="display:flex;align-items:center;justify-content:space-between;
            gap:10px;padding:10px 12px;margin:6px 0;background:rgba(255,255,255,0.04);border-radius:10px;">
            <span style="font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">👤 ${p.name}</span>
            <button data-mute="${p.id}" style="flex:0 0 auto;padding:6px 12px;border-radius:8px;border:1px solid rgba(255,255,255,0.2);
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
      });
      this.envBadgeDiv.title = 'Live weather settings';
      this.envBadgeDiv.addEventListener('click', (e) => {
        e.stopPropagation();
        this.toggleWeatherPopover();
      });
      this.overlay.appendChild(this.envBadgeDiv);
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
      fontSize: '12.5px',
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
      <button id="wx-toggle" style="background:${on ? '#c0392b' : '#4CAF50'};color:#fff;border:none;padding:6px 12px;border-radius:8px;cursor:pointer;font-size:12.5px;">
        ${on ? 'Turn off' : 'Turn on'}
      </button>
      <a href="/privacy.html" target="_blank" rel="noopener" style="color:#7fb2ff;margin-left:10px;font-size:11.5px;">Privacy</a>
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
    // shape. Overlap-skip keeps crossings (two rim dots close together)
    // from smearing text over text.
    const rimLabels: Array<{ x: number; y: number }> = [];
    for (const z of data.zones) {
      const p = place(z);
      if (p.edge) {
        ctx.fillStyle = z.color;
        ctx.globalAlpha = 0.6;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 2.4, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
        if (z.label && !rimLabels.some((r) => Math.hypot(r.x - p.x, r.y - p.y) < 26)) {
          rimLabels.push({ x: p.x, y: p.y });
          // Nudge the text toward the centre so it stays inside the disc.
          const nx = p.x + (cx - p.x) * 0.16;
          const ny = p.y + (cy - p.y) * 0.16;
          ctx.save();
          ctx.font = '600 8px system-ui, sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.lineWidth = 2.5;
          ctx.strokeStyle = 'rgba(0,0,0,0.85)';
          ctx.strokeText(z.label, nx, ny);
          ctx.fillStyle = 'rgba(255,255,255,0.85)';
          ctx.fillText(z.label, nx, ny);
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
        ctx.font = '600 8.5px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.lineWidth = 2.5;
        ctx.strokeStyle = 'rgba(0,0,0,0.85)';
        ctx.strokeText(z.label, p.x, p.y + 5.5);
        ctx.fillStyle = 'rgba(255,255,255,0.95)';
        ctx.fillText(z.label, p.x, p.y + 5.5);
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
      ['N', cx, cy - R + 9, '700 10px system-ui, sans-serif', '#ff6b6b'],
      ['E', cx + R - 8, cy, '600 8px system-ui, sans-serif', 'rgba(255,255,255,0.6)'],
      ['S', cx, cy + R - 8, '600 8px system-ui, sans-serif', 'rgba(255,255,255,0.6)'],
      ['W', cx - R + 8, cy, '600 8px system-ui, sans-serif', 'rgba(255,255,255,0.6)'],
    ];
    for (const [ch, tx, ty, font, color] of dirs) {
      ctx.font = font;
      ctx.fillStyle = color;
      ctx.fillText(ch, tx, ty + 0.5);
    }

    // ── Online count pill along the bottom of the ring ──────────────────
    const online = data.online ?? peers.length + 1;
    const label = `${online} ONLINE`;
    ctx.font = '700 9px system-ui, sans-serif';
    const tw = ctx.measureText(label).width;
    const pillW = tw + 22;
    const pillH = 15;
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
    const rowsFor = (tab: 'tools' | 'supplies' | 'hats'): string =>
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
          <span style="color:#ffd34a;font-weight:800;font-size:16px;background:rgba(255,211,74,0.12);padding:4px 12px;border-radius:999px;">🪙 ${state.coins}</span>
          <span id="shop-close" style="cursor:pointer;font-size:18px;padding:2px 8px;">✕</span>
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
          if (id) onAction(id);
        });
      });
    };
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
      });
    });
    this.overlay.appendChild(this.shopDiv);
    bindRows();
    // Panel registry: exclusivity + chip/touch-control hiding. ownEscape —
    // the document-level Esc handler below already owns the key (letting the
    // manager also act would double-fire onClose). The SAME-ID RE-OPEN rule
    // is load-bearing here: showShop re-renders itself after every purchase,
    // and the sweep firing onClose mid-refresh would unpause the game.
    this.panels.open('shop', {
      kind: 'modal',
      hides: ['nav-chips', 'touch-controls', 'aux-controls'],
      ownEscape: true,
      close: () => {
        this.hideShop();
        onClose();
      },
    });
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
        position: 'absolute',
        top: 'calc(var(--sat, 0px) + 60px)',
        right: 'calc(var(--sar, 0px) + 10px)',
        background: 'rgba(0, 0, 0, 0.55)',
        color: '#ffd34a',
        padding: '4px 10px',
        borderRadius: '10px',
        fontSize: '12px',
        fontFamily: 'system-ui, sans-serif',
        pointerEvents: 'none',
        transition: 'transform 0.12s ease',
      });
      if (this.isTouch) {
        this.tierChip(this.coinDiv); // inserts BEFORE ☰ to keep [👥][🪙][☰]
      } else {
        this.overlay.appendChild(this.coinDiv);
        this.panels.registerLayer('nav-chips', this.coinDiv);
      }
      this.coinDiv.textContent = `🪙 ${total}`;
      return; // no bump on first render
    }
    this.coinDiv.textContent = `🪙 ${total}`;
    // Bump: quick scale-up that springs back
    this.coinDiv.style.transform = 'scale(1.35)';
    const el = this.coinDiv;
    window.setTimeout(() => {
      el.style.transform = 'scale(1)';
    }, 130);
  }

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
        position: 'absolute',
        top: 'calc(var(--sat, 0px) + 60px)',
        right: 'calc(var(--sar, 0px) + 74px)',
        background: 'rgba(0, 0, 0, 0.55)',
        color: '#e8d9a0',
        padding: '4px 10px',
        borderRadius: '10px',
        fontSize: '12px',
        fontFamily: 'system-ui, sans-serif',
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
    this.feedDiv.style.display = 'block';
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
    if (!this.raceDiv) {
      this.raceDiv = document.createElement('div');
      Object.assign(this.raceDiv.style, {
        position: 'absolute',
        top: 'calc(var(--sat, 0px) + 12px)',
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
        fontSize: '11px',
        color: '#cfe0ff',
        marginTop: '1px',
      });
      this.raceDiv.appendChild(this.raceLine1);
      this.raceDiv.appendChild(this.raceLine2);
      this.overlay.appendChild(this.raceDiv);
    }
    if (!status) {
      this.raceDiv.style.opacity = '0';
      this.raceDiv.style.display = 'none';
      return;
    }
    this.raceDiv.style.display = 'block';
    this.raceDiv.style.opacity = '1';
    if (this.raceLine1) this.raceLine1.textContent = status.line1;
    if (this.raceLine2) {
      this.raceLine2.textContent = status.line2 ?? '';
      this.raceLine2.style.display = status.line2 ? 'block' : 'none';
    }
  }

  private breathWrap: HTMLDivElement | null = null;
  private breathFill: HTMLDivElement | null = null;
  private waterVignette: HTMLDivElement | null = null;
  private staminaWrap: HTMLDivElement | null = null;
  private staminaFill: HTMLDivElement | null = null;

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
    this.staminaWrap.style.opacity = show ? '1' : '0';
    if (this.staminaFill) {
      this.staminaFill.style.width = `${Math.max(0, Math.min(1, stamina)) * 100}%`;
      // amber while healthy, red when nearly spent
      const hue = 12 + 30 * Math.max(0, Math.min(1, stamina));
      this.staminaFill.style.background = `hsl(${hue}, 85%, 52%)`;
    }
  }

  /**
   * Swim UX: a breath meter (bottom-centre) + an underwater vignette that
   * closes in and reddens as oxygen runs out. Both fade away on dry land.
   */
  updateBreath(oxygen: number, inWater: boolean): void {
    if (!this.breathWrap) {
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
    // Meter only matters in water (or briefly while recovering)
    const show = inWater || oxygen < 0.999;
    this.breathWrap!.style.opacity = show ? '1' : '0';
    if (this.breathFill) {
      this.breathFill.style.width = `${Math.max(0, oxygen) * 100}%`;
      // green → amber → red as it drains
      const hue = 120 * Math.max(0, oxygen);
      this.breathFill.style.background = `hsl(${hue}, 80%, 50%)`;
    }
    if (this.waterVignette) {
      const strength = inWater ? 0.35 + danger * 0.55 : 0;
      this.waterVignette.style.opacity = String(strength);
      // deepen from teal to a drowning red-tinged dark as oxygen falls
      const edge = danger > 0.5 ? '20,40,60' : '10,40,70';
      this.waterVignette.style.background = `radial-gradient(circle at 50% 45%, rgba(60,140,190,0.05) 30%, rgba(${edge},0.85) 100%)`;
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
    this.underwaterWash.style.opacity = String(Math.max(0, Math.min(1, f)) * 0.85);
  }

  /** Brief centred splash message (used for the drown/rescue). */
  private flashEl: HTMLDivElement | null = null;
  flashMessage(text: string): void {
    // Single slot: each call used to append a NEW div at the identical
    // anchor, so two flashes within ~2s superimposed their text (reachable
    // first-session: ?race= landing + arrival trail). Replace, don't stack.
    this.flashEl?.remove();
    const el = document.createElement('div');
    this.flashEl = el;
    el.textContent = text;
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
    requestAnimationFrame(() => {
      el.style.opacity = '1';
      el.style.transform = 'translate(-50%, -50%) scale(1)';
    });
    window.setTimeout(() => {
      el.style.opacity = '0';
      window.setTimeout(() => {
        el.remove();
        if (this.flashEl === el) this.flashEl = null;
      }, 300);
    }, 1800);
  }

  /**
   * Update player count display
   */
  updatePlayerCount(count: number): void {
    if (this.playerCountDiv) {
      this.playerCountDiv.textContent = `👥 ${count} online`;
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

  /**
   * Appearance editor: colour swatches per body part + a picker over owned
   * hats. Recolours the live model through the callbacks and persists via the
   * caller. Re-renders itself after each pick to move the active highlight.
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
    // joystick would trap the player mid-recolour. Re-renders itself on every
    // swatch tap → protected by the same-id re-open rule.
    this.panels.open('customize', {
      kind: 'sheet',
      hides: ['nav-chips'],
      close: () => this.hideCustomize(),
    });

    const hexStr = (h: number) => `#${h.toString(16).padStart(6, '0')}`;
    const swatchRow = (part: string): string => {
      const cur = opts.colors[part];
      const swatches = SimpleUI.CUSTOMIZE_PALETTES[part]
        .map((hex) => {
          const active = cur === hex;
          return `<button data-part="${part}" data-hex="${hex}" title="${hexStr(hex)}" style="width:23px;height:23px;border-radius:6px;border:2px solid ${active ? '#fff' : 'transparent'};background:${hexStr(hex)};cursor:pointer;margin:2px;padding:0;"></button>`;
        })
        .join('');
      return `<div style="margin-bottom:7px;"><div style="font-size:11px;color:#bbb;margin-bottom:2px;">${SimpleUI.CUSTOMIZE_LABELS[part]}</div><div style="display:flex;flex-wrap:wrap;">${swatches}</div></div>`;
    };
    const hatBtn = (id: string | null, icon: string): string => {
      const active = (opts.equippedHat ?? null) === id;
      return `<button data-hat="${id ?? ''}" style="font-size:16px;padding:3px 7px;border-radius:8px;border:2px solid ${active ? '#fff' : 'transparent'};background:rgba(255,255,255,0.12);cursor:pointer;margin:2px;">${icon}</button>`;
    };
    const ownedBtns = opts.hats
      .filter((h) => opts.ownedHats.includes(h.id))
      .map((h) => hatBtn(h.id, h.icon))
      .join('');
    const hatRow = `<div style="margin-bottom:6px;"><div style="font-size:11px;color:#bbb;margin-bottom:2px;">Hat</div><div style="display:flex;flex-wrap:wrap;align-items:center;">${hatBtn(null, '🚫')}${ownedBtns || '<span style="font-size:11px;color:#888;margin-left:4px;">buy hats at the 🛒 shop</span>'}</div></div>`;

    this.customizeDiv.innerHTML = `
      <div style="font-weight:700;margin-bottom:9px;">🎨 Appearance</div>
      ${swatchRow('outfit')}${swatchRow('pants')}${swatchRow('hair')}${swatchRow('skin')}
      ${hatRow}
      <button id="close-customize" style="background:#4CAF50;color:white;border:none;padding:6px 13px;border-radius:8px;cursor:pointer;margin-top:6px;">Done</button>
    `;

    this.customizeDiv.querySelectorAll<HTMLElement>('button[data-hex]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const part = btn.dataset.part!;
        const hex = parseInt(btn.dataset.hex!, 10);
        opts.onColor(part, hex);
        opts.colors[part] = hex; // reflect for the re-render highlight
        this.showCustomize(opts);
      });
    });
    this.customizeDiv.querySelectorAll<HTMLElement>('button[data-hat]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.hat ? btn.dataset.hat : null;
        opts.onHat(id);
        opts.equippedHat = id;
        this.showCustomize(opts);
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
      <div style="color:#4CAF50;font-weight:bold;">${quest.name}</div>
      ${quest.reward ? `<div style="margin-top:8px;font-size:14px;color:#ccc;">${quest.reward.value}</div>` : ''}
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
      this.compassDiv.setAttribute('tabindex', '0');
      this.compassDiv.setAttribute('aria-label', 'Open the island map');
      this.compassDiv.title = 'Open the island map';
      const openMap = (): void => {
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
    this.compassDiv.style.display = 'flex';
    if (this.compassArrow) {
      // arrow glyph points right at 0deg; screen-up (camera forward) is -90deg
      const deg = (state.angleRad * 180) / Math.PI - 90;
      this.compassArrow.style.transform = `rotate(${deg.toFixed(1)}deg)`;
    }
    if (this.compassLabel) {
      // Narrow screens: drop the WORDS but keep the destination's icon (the
      // label's first token) \u2014 a bare "103m" was direction with no subject,
      // the least useful string a compass can show.
      const compact = window.innerWidth < 480;
      this.compassLabel.textContent = compact
        ? `${state.label.split(' ')[0]} ${Math.round(state.distance)}m`
        : `${state.label} \u2022 ${Math.round(state.distance)}m`;
    }
  }

  showZonePanel(zone: any, opts?: { source?: 'proximity' | 'menu' | 'deeplink' | 'cta' }): void {
    const source = opts?.source ?? 'menu';
    this.hideZonePanel(); // Hide any existing panel

    this.zonePanelDiv = document.createElement('div');
    Object.assign(this.zonePanelDiv.style, {
      position: 'fixed',
      top: '50%',
      left: '50%',
      transform: 'translate(-50%, -50%)',
      background: 'rgba(0, 0, 0, 0.9)',
      color: 'white',
      padding: '20px',
      borderRadius: '14px',
      textAlign: 'center',
      pointerEvents: 'auto',
      fontSize: '14.5px',
      // 1650 (was 1500): the modal band. At 1500 the manager's scrim (1640)
      // would grey out and swallow the panel's own clicks.
      zIndex: '1650',
      // 1px accent, not the old 3px full-alpha frame — the zone hue should
      // sign the panel, not floodlight it.
      border: `1px solid ${this.getZoneColor(zone.id)}`,
      maxWidth: '500px',
      maxHeight: '70vh',
      overflowY: 'auto',
    });
    this.panels.open('zone', {
      kind: 'modal',
      hides: ['nav-chips'],
      close: () => this.hideZonePanel(),
    });

    const content = this.getZoneContent(zone);
    this.zonePanelDiv.innerHTML = content;
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
      void import('./ReceptionDesk').then(({ appendReceptionDesk }) => {
        if (this.zonePanelDiv) appendReceptionDesk(this.zonePanelDiv);
      });
      this.appendLeadForm(this.zonePanelDiv);
    }

    // Passport: stamp ONLY when the visitor physically walked up to the zone
    // ('proximity'). Opening the same panel from the top-right Portfolio menu, a
    // welcome CTA, or a deep link no longer stamps — the 👑 crown now means the
    // island was actually explored, not that five buttons were clicked. The menu
    // still opens every panel, so a hurried recruiter loses no content.
    if (source === 'proximity' && this.passport?.visit(zid)) {
      trackOnce('passport_stamp', { zone: zid, count: this.passport.count() });
      if (!this.passport.isComplete()) {
        const meta = PASSPORT_META[zid as PassportZone];
        this.toast(
          `🛂 Passport stamped: ${meta.label} (${this.passport.count()}/${this.passport.total()})`,
        );
      }
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
      footer.appendChild(
        this.makeShareButton('🔗 Share this zone', {
          surface: `zone_${zid}`,
          url: buildShareUrl({ zone: zid }),
          title: 'DigiScalability Life Island',
          text: `Walk through the ${String(zone?.name ?? zid)} zone of this 3D portfolio island:`,
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
      width: '30px',
      height: '30px',
      borderRadius: '50%',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
    });
    closeBtn.addEventListener('click', () => this.hideZonePanel());
    this.zonePanelDiv.appendChild(closeBtn);

    this.overlay.appendChild(this.zonePanelDiv);

    // Reflect the open zone in the URL so a visitor can copy/share a deep link
    // (e.g. /?zone=projects); cleared again on close. Param-scoped so it never
    // clobbers ?hour=/?theme=.
    setUrlParam('zone', zid);

    // Add keyboard listener for escape
    const escapeHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        this.hideZonePanel();
        document.removeEventListener('keydown', escapeHandler);
      }
    };
    document.addEventListener('keydown', escapeHandler);
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
    // Derive from the single DISTRICTS source of truth (was a hardcoded hex-string
    // copy that could drift from the 3D markers + minimap dots).
    const d = DISTRICTS.find((x) => x.id === zoneId);
    return d ? `#${d.color.toString(16).padStart(6, '0')}` : '#666';
  }

  /**
   * Get content for zone
   */
  private getZoneContent(zone: any): string {
    // Shared button styles for the clickable portfolio links. Links are the
    // owner's own curated URLs (a visitor chooses to click), opened in a new
    // tab with rel=noopener — the portfolio's whole point is to be actionable.
    const link = (href: string, label: string, opts: { primary?: boolean } = {}): string => {
      const base =
        'display:inline-flex;align-items:center;gap:6px;margin:5px 6px 5px 0;padding:9px 15px;border-radius:10px;text-decoration:none;font-size:14px;transition:transform 0.1s ease;';
      const style = opts.primary
        ? base +
          'background:linear-gradient(135deg,#5b6cff,#8a4de0);color:#fff;font-weight:600;border:none;'
        : base + 'background:#2a2a37;color:#e8e8f0;border:1px solid rgba(255,255,255,0.14);';
      return `<a href="${href}" target="_blank" rel="noopener noreferrer" style="${style}">${label}</a>`;
    };
    const chip = (t: string): string =>
      `<span style="background:#33333f;padding:5px 11px;border-radius:15px;font-size:13px;">${t}</span>`;
    // Optional lazy thumbnail — hidden by the error handler in showZonePanel if
    // the asset isn't present, so the panels never depend on the images shipping.
    const thumb = (src: string, alt: string): string =>
      `<img src="${src}" alt="${alt}" loading="lazy" style="width:100%;max-height:150px;object-fit:cover;
        object-position:top;border-radius:10px;margin:8px 0 4px;display:block;border:1px solid rgba(255,255,255,0.08);" />`;
    const card = (inner: string): string =>
      `<div style="background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.1);
        border-radius:12px;padding:14px;margin:12px 0;text-align:left;">${inner}</div>`;

    const contents: { [key: string]: string } = {
      welcome: `
        <h2 style="margin-top: 0; color: #4CAF50;">🏝️ Welcome to the DigiScalability World</h2>
        <p><strong>DigiScalability</strong> is a Melbourne venture studio building AI-powered
        products — and this island is its living 3D portfolio, hand-built in Three.js.</p>
        <p style="text-align:left;margin-bottom:4px;">Follow the
        <strong style="color:#ffd54a;">➤ compass</strong> to each district, or just wander:</p>
        <ul style="text-align: left; display: inline-block; line-height:1.7;margin-top:4px;">
          <li>💼 <strong>Professional</strong> — the builder behind the studio</li>
          <li>🚀 <strong>Projects</strong> — RankPilot, ChocoMate &amp; more</li>
          <li>🎨 <strong>Personal</strong> — food, family recipes, creative tools</li>
          <li>📬 <strong>Contact</strong> — work with DigiScalability</li>
        </ul>
        <p style="margin-top:12px; font-size:13.5px; color:#cdd;">🛂 Visit all four
        <em>in person</em> to stamp your <strong>Passport</strong> and earn the Founder's Crown 👑.</p>
        <p style="margin-top: 12px; font-size:13px; color:#aaa;"><em>${
          this.isTouch
            ? 'Drag the joystick to move, drag to look, 👆 USE to interact'
            : 'WASD to move, mouse to look, E to interact'
        }. Swim, and drive the boats, jetskis &amp; cars around the island.</em></p>
      `,
      professional: `
        <h2 style="margin-top: 0; color: #2196F3;">💼 Professional</h2>
        <p>Abbas Ali — solo founder &amp; full-stack AI builder. Day job in tech,
        a venture studio after hours, hospitality-management roots, CS degree with an
        MIT (Deakin) nearly done.</p>
        <p style="font-size:13.5px;color:#bcd;background:rgba(90,140,255,0.12);
          border-radius:10px;padding:8px 12px;margin:10px 0;">🛠️ <strong>Now:</strong>
          building <strong>RankPilot</strong> — see the Projects district. 🚀</p>
        <h3 style="margin-bottom:8px;">Core Stack</h3>
        <div style="display: flex; flex-wrap: wrap; gap: 8px; justify-content: center; margin: 12px 0 18px;">
          ${chip('Next.js')} ${chip('TypeScript')} ${chip('Firebase / GCP')}
          ${chip('Python')} ${chip('Three.js')} ${chip('LLM / AI Automation')}
        </div>
        <p style="font-size:14px;">Ships end-to-end: product, code, infra, and the AI
        pipelines that glue them together — n8n automations, local model inference,
        agentic tooling.</p>
        <div style="margin-top:16px;">
          ${link('https://linkedin.com/in/digiscalability', '🔗 LinkedIn', { primary: true })}
          ${link('https://github.com/digiscalability', '💻 GitHub')}
          ${link('https://digiscalability.com', '🌐 digiscalability.com')}
        </div>
      `,
      projects: `
        <h2 style="margin-top: 0; color: #FF9800;">🚀 Projects</h2>
        ${card(`
          <h3 style="margin:0 0 2px;">🏝️ This Island <span style="font-size:11px;color:#ffd479;">● you are standing in it</span></h3>
          <p style="margin:6px 0;font-size:13.5px;">The flagship: a multiplayer 3D world where
          <strong>every townsperson is a live AI agent</strong>. An LLM planner assigns their jobs each
          morning, they follow real daily schedules (and sleep in the cottages at night), and an
          autonomous analyst emails me a nightly report and files GitHub issues about its own island.</p>
          <p style="margin:6px 0;font-size:12.5px;color:#cdd6e4;">Three.js + TypeScript + Firebase +
          Claude · 18 conversational agents · runs at 60fps on a ~300KB core bundle · the whole
          agent fleet costs under $0.10/day with hard token caps.</p>
          <p style="margin:6px 0;font-size:12.5px;color:#cdd6e4;">Proof it runs itself: read the
          📰 Island Times (Portfolio menu) — compiled nightly by the analyst — or just walk up to
          anyone and ask what they're doing today.</p>
        `)}
        ${card(`
          <h3 style="margin:0 0 2px;">📈 RankPilot <span style="font-size:11px;color:#8f8;">● live</span></h3>
          ${thumb('/assets/panels/rankpilot.webp', 'RankPilot dashboard')}
          <p style="margin:6px 0;font-size:13.5px;"><strong style="color:#ffcc80;">Problem:</strong>
          search is shifting from ten blue links to AI answers — and most sites are invisible to
          the models doing the answering.</p>
          <p style="margin:6px 0;font-size:13.5px;"><strong style="color:#ffcc80;">Built:</strong>
          a platform that audits a site's schema, content &amp; LLM-readiness and shows exactly
          what to fix. Solo build, live and in daily use.</p>
          <div style="margin-top:8px;">${link('https://rankpilot-h3jpc.web.app', '↗ Visit RankPilot', { primary: true })}</div>
        `)}
        ${card(`
          <h3 style="margin:0 0 2px;">🍫 ChocoMate</h3>
          ${thumb('/assets/panels/chocomate.webp', 'ChocoMate storefront')}
          <p style="margin:6px 0;font-size:13.5px;">Direct-to-consumer chocolate brand —
          the storefront, brand system, and content pipeline, end to end.</p>
          <div style="margin-top:8px;">${link('https://chocomate.au', '↗ chocomate.au')}</div>
        `)}
        <div style="text-align:left;">
          <h3 style="margin-bottom:4px;margin-top:14px;">🌐 DigiScalability</h3>
          <p style="margin-top:4px;font-size:13.5px;">The studio itself — services, case studies,
          and the SEO/LLM-visibility practice behind RankPilot.
          ${link('https://digiscalability.com', '↗ digiscalability.com')}</p>
          <h3 style="margin-bottom:4px;margin-top:14px;">📖 Bano's Cookbook &amp; more</h3>
          <p style="margin-top:4px;font-size:13.5px;">Digitising a family's 1981 handwritten recipes;
          a services marketplace (Insta Services); and this Three.js island world.
          ${link('https://github.com/digiscalability', '💻 GitHub')}</p>
        </div>
      `,
      personal: `
        <h2 style="margin-top: 0; color: #E91E63;">🎨 Personal</h2>
        <p>Melbourne, Australia. Builder by day and night — but not only of software.
        A lot of this island is personal: those cottages are the Personal district,
        the market stalls nod to the food side, and the recipes below are real.</p>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin: 16px 0; text-align:left;">
          <div><h3 style="margin:0 0 4px;">🍽️ Food Ventures</h3>
            <p style="font-size:13.5px;">Hospitality roots; kitchen-to-market concepts from
            steak frites to desserts — the Bayside commissary idea in progress.</p></div>
          <div><h3 style="margin:0 0 4px;">👵 Family Heritage</h3>
            <p style="font-size:13.5px;">Preserving a grandmother's handwritten recipes from
            1981 — the heart behind Bano's Cookbook.</p></div>
          <div><h3 style="margin:0 0 4px;">🎬 Creative Tooling</h3>
            <p style="font-size:13.5px;">Blender, DaVinci Resolve, ComfyUI — a full studio
            for product storytelling and 3D worlds like this one.</p></div>
          <div><h3 style="margin:0 0 4px;">📚 Always Learning</h3>
            <p style="font-size:13.5px;">A CS degree, a Masters of IT nearly done, and a
            new experiment shipped most weeks.</p></div>
        </div>
        <div style="margin-top:8px;">
          ${link('https://youtube.com/@DigiScalability', '▶️ Creative builds', { primary: true })}
          ${link('https://instagram.com/digiscalability', '📸 Instagram')}
        </div>
      `,
      contact: `
        <h2 style="margin-top: 0; color: #9C27B0;">📬 Get In Touch</h2>
        <p>Work with DigiScalability — product builds, AI automation, SEO/LLM
        visibility, or something new. Melbourne, Australia.</p>
        <div style="margin: 22px 0; display:flex; flex-wrap:wrap; justify-content:center;">
          ${link('mailto:admin@digiscalability.com', '✉️ Email', { primary: true })}
          ${link('https://linkedin.com/in/digiscalability', '🔗 LinkedIn')}
          ${link('https://github.com/digiscalability', '💻 GitHub')}
          ${link('https://x.com/digiscalability', '𝕏 Twitter')}
          ${link('https://instagram.com/digiscalability', '📸 Instagram')}
          ${link('https://youtube.com/@DigiScalability', '▶️ YouTube')}
        </div>
        <p style="font-size:13px; color:#999;">All channels @digiscalability.</p>
      `,
    };

    return contents[zone.id] || `<h2>${zone.name}</h2><p>${zone.description}</p>`;
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
    const title = document.createElement('span');
    title.textContent = name;
    header.appendChild(title);
    // The differentiator, made legible: this is a REAL model conversation, not
    // a dialogue tree — visitors couldn't tell (fallbacks look identical).
    const aiBadge = document.createElement('span');
    aiBadge.textContent = '✨ live AI';
    Object.assign(aiBadge.style, {
      fontSize: '10.5px',
      fontWeight: '700',
      letterSpacing: '0.5px',
      color: '#ffd479',
      border: '1px solid rgba(255,212,121,0.5)',
      borderRadius: '20px',
      padding: '2px 8px',
      whiteSpace: 'nowrap',
    });
    aiBadge.title = 'A live language-model conversation — every reply is generated, not scripted';
    header.appendChild(aiBadge);
    const controls = document.createElement('span');
    Object.assign(controls.style, { display: 'flex', gap: '12px', alignItems: 'center' });
    // Voice mute toggle (only if the browser can speak).
    if (isSpeechSupported()) {
      const voiceBtn = document.createElement('span');
      const render = () => {
        voiceBtn.textContent = isSpeechEnabled() ? '🔊' : '🔇';
      };
      render();
      Object.assign(voiceBtn.style, { cursor: 'pointer', fontSize: '15px', userSelect: 'none' });
      voiceBtn.title = 'Toggle NPC voice';
      voiceBtn.addEventListener('click', () => {
        setSpeechEnabled(!isSpeechEnabled());
        render();
      });
      controls.appendChild(voiceBtn);
    }
    const closeBtn = document.createElement('span');
    closeBtn.textContent = '✕';
    Object.assign(closeBtn.style, { cursor: 'pointer', opacity: '0.7' });
    closeBtn.addEventListener('click', () => this.closeNpcChat());
    controls.appendChild(closeBtn);
    header.appendChild(controls);
    panel.appendChild(header);
    const log = document.createElement('div');
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
      const row = document.createElement('div');
      Object.assign(row.style, { alignSelf: 'flex-start', color: '#dfe6ff', maxWidth: '90%' });
      log.appendChild(row);
      if (voiced) speak(text, voice.rate, voice.pitch, voice.variant);
      if (a11y.reducedMotion) {
        row.textContent = text;
        log.scrollTop = log.scrollHeight;
        return;
      }
      let i = 0;
      const step = (): void => {
        row.textContent = text.slice(0, i); // textContent: no markup injection
        log.scrollTop = log.scrollHeight;
        if (i < text.length) {
          i += 1;
          this.npcTypeTimer = window.setTimeout(step, 18);
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
    const input = document.createElement('input');
    input.type = 'text';
    input.maxLength = 300;
    input.placeholder = `Say something to ${name}…`;
    Object.assign(input.style, {
      flex: '1',
      padding: '8px 12px',
      borderRadius: '10px',
      border: '1px solid rgba(255,255,255,0.15)',
      background: 'rgba(255,255,255,0.06)',
      color: '#fff',
      fontSize: this.isTouch ? '16px' : '15px', // 16px kills iOS focus zoom
      outline: 'none',
    });
    const send = document.createElement('button');
    send.textContent = 'Send';
    Object.assign(send.style, {
      padding: '8px 16px',
      borderRadius: '10px',
      border: 'none',
      cursor: 'pointer',
      background: '#5a8cff',
      color: '#fff',
      fontWeight: '600',
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
      });
      inputRow.appendChild(mic);
    }
    inputRow.appendChild(input);
    inputRow.appendChild(send);
    panel.appendChild(inputRow);
    // Typing must not drive the player: stop key events reaching window/document.
    for (const ev of ['keydown', 'keyup', 'keypress'])
      input.addEventListener(ev, (e) => e.stopPropagation());
    let busy = false;
    const doSend = async (): Promise<void> => {
      const text = input.value.trim();
      if (!text || busy) return;
      busy = true;
      input.value = '';
      send.disabled = true;
      input.disabled = true;
      // The user has spoken: any still-pending opening-deepening is stale
      // from here on (see appendNpcChatLine).
      if (this.npcChatAppend?.name === name) this.npcChatAppend.engaged = true;
      playerLine(text);
      const thinking = document.createElement('div');
      thinking.textContent = '…';
      Object.assign(thinking.style, { alignSelf: 'flex-start', color: '#8ea2d8' });
      log.appendChild(thinking);
      log.scrollTop = log.scrollHeight;
      let reply = '…';
      try {
        reply = await onSend(text);
      } catch {
        reply = '…';
      }
      thinking.remove();
      npcLine(reply);
      busy = false;
      send.disabled = false;
      input.disabled = false;
      input.focus();
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

  public closeNpcChat(): void {
    this.npcChatAppend = null;
    if (this.npcTypeTimer) {
      clearTimeout(this.npcTypeTimer);
      this.npcTypeTimer = 0;
    }
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
      hides: ['nav-chips'],
      close: () => this.closeWatchPicker(),
    });
    panel.innerHTML = `
      <div style="font-weight:600; font-size:15px; margin-bottom:4px;">📺 The wall screen</div>
      <div style="font-size:12.5px; color:#aab; margin-bottom:12px;">What shall we watch? Paste a YouTube link (or any https page).</div>
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
      fontSize: '13.5px',
    });
    for (const ev of ['keydown', 'keyup', 'keypress'])
      input.addEventListener(ev, (e) => e.stopPropagation()); // typing must not walk the room
    const go = document.createElement('button');
    go.textContent = 'Watch';
    Object.assign(go.style, {
      padding: '9px 16px',
      borderRadius: '10px',
      border: 'none',
      background: '#5a8cff',
      color: '#fff',
      fontWeight: '600',
      fontSize: '13.5px',
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
    Object.assign(close.style, {
      position: 'absolute',
      top: '8px',
      right: '10px',
      background: 'none',
      border: 'none',
      color: '#99a',
      fontSize: '16px',
      cursor: 'pointer',
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
    Object.assign(hint.style, { fontSize: '11px', color: 'rgba(255,255,255,0.55)' });
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
        fontSize: '12.5px',
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
    });
    panel.innerHTML = `
      <div style="font-weight:600; font-size:14.5px; margin-bottom:2px;">🔒 The door is locked</div>
      <div style="font-size:12px; color:#aab; margin-bottom:10px;">Enter the door code</div>
      <div id="pin-dots" style="letter-spacing:8px; font-size:22px; min-height:28px; margin-bottom:10px;">····</div>
    `;
    const dots = panel.querySelector('#pin-dots') as HTMLElement;
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
        fontSize: '16px',
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
        fontSize: '14.5px',
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
      ">${name}</div>
      <div style="padding: clamp(10px, 1.8vh, 16px) clamp(14px, 4vw, 20px); min-height: clamp(36px, 7vh, 60px);">
        <div id="dialogue-text" style="
          line-height: 1.5;
          font-size: clamp(13px, 3.5vw, 15px);
          min-height: clamp(18px, 4vh, 24px);
        "></div>
        <div style="
          text-align: right;
          margin-top: clamp(5px, 1vh, 10px);
          font-size: clamp(10px, 2.6vw, 12px);
          color: rgba(160, 200, 255, 0.5);
        ">
          <span id="dialogue-hint">${this.isTouch ? 'Tap to continue' : 'Press <strong style="color:rgba(160,200,255,0.8)">E</strong> to continue'}</span>
        </div>
      </div>
    `;

    this.startTypewriter(lines[0]);
  }

  private startTypewriter(text: string): void {
    this.typewriterText = text;
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
          : 'Press <strong style="color:rgba(160,200,255,0.8)">E</strong> to close';
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
    if (this.compassDiv) {
      this.compassDiv.remove();
      this.compassDiv = null;
    }
    this.hideLoading();
    this.hideWelcome();
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
