/**
 * PanelManager — one registry for every HUD panel (approved mobile-HUD
 * Round 3 design, Phase 1).
 *
 * The problems this exists for, all shipped and reported as broken:
 *   - modals STACKED (guestbook under leaderboard under passport…) because
 *     every panel owned its own lifecycle and nobody closed anybody;
 *   - on phones, chips painted OVER the JUMP button and the NPC chat panel
 *     rendered UNDER the touch buttons (z1620 < z1650);
 *   - ~30 modals had no Escape support and no scrim.
 *
 * One stack, one scrim, one Escape listener, and a declarative layer policy
 * (each panel says which HUD layers it suppresses). Touch hides layers
 * outright; desktop dims them to 0.35 — same policy object, softer degrade.
 *
 * LOAD-BEARING RULES (regression-tested in test/panelManager.test.ts):
 *   - SAME-ID RE-OPEN: `open(id)` while `id` is already top REPLACES the spec
 *     without running close(). The shop re-renders itself after every
 *     purchase by calling showShop again — firing its onClose mid-refresh
 *     would unpause the game under the open shop.
 *   - SWEEP GUARD: the exclusivity sweep calls each panel's close(), whose
 *     teardown path usually calls notifyClosed() — which must NO-OP during
 *     the sweep (the sweep owns the stack while it runs).
 *   - DETACHED PANELS POP: a panel registered with its root `el` is popped
 *     once that element has been in the document and has left it, even if
 *     its close path never notified (or notified the wrong id: the
 *     leaderboard's "Guide me" named 'race-leaderboard' and left the scrim up
 *     and the phone controls hidden, UX-01).
 *   - BACK CLOSES THE PANEL, NOT THE ISLAND (UX-02): with a panel open, the
 *     browser's or Android's Back used to leave the site (no history entry,
 *     no popstate listener). Now an open panel owns ONE pushed entry
 *     {dsPanel, dsTok}:
 *       · a fresh open pushes it; a same-id re-open pushes nothing;
 *       · the exclusivity sweep (B opening over A), or a close followed by an
 *         open in the same task, REPLACES it, never back-then-push (a queued
 *         back would land after the push and strand the new panel);
 *       · a close by ✕, Escape, the scrim, a walk-away or a sweep into a
 *         transient panel steps back off it, but only while history.state
 *         still carries our token: anything else could take the visitor off
 *         the site;
 *       · popstate off our entry closes the top panel; our own back() is
 *         counted and ignored;
 *       · `history: false` panels (the welcome card, the drawer, the emote
 *         wheel, the chat input, the tour, NPC dialogue, a deep-linked panel)
 *         never push: Back from there leaves, as it always did;
 *       · pageshow (a bfcache restore) re-syncs the stack with the page.
 *   - FOCUS MOVES IN, STAYS IN AND COMES BACK (D4; FOCUS-01, UX-03): focus
 *     used to stay on BODY behind every panel, Tab walked the dimmed HUD
 *     behind the modals, and the welcome card leaked focus after five Tabs.
 *       · a modal (zone panels, the hire card, the centred modals, the
 *         welcome card, the shop) is aria-modal, makes every other overlay
 *         child inert (tabindex -1 where inert is unsupported), takes focus
 *         once its element is in the document (initialFocus, else its first
 *         heading at tabindex -1) and traps Tab;
 *       · a sheet with initialFocus (the Portfolio menu, the emote wheel)
 *         takes focus too, with no trap and no inert; other sheets keep the
 *         world live and never move focus;
 *       · sheets, #ds-guide and [data-never-inert] (the Leave pill, the live
 *         region) are never made inert;
 *       · on close, a panel still open underneath takes focus back (the hall
 *         panel under the passport crown); otherwise a panel the KEYBOARD
 *         opened returns focus to its opener (the Portfolio pill when the
 *         opener has gone), and one a pointer or the world opened hands focus
 *         back to the world: an HUD chip left holding focus would take the
 *         next Enter (chat) or Space (jump);
 *       · close(reason) says why the manager closed it: 'escape', 'scrim',
 *         'sweep' or 'back' (the welcome card persists ds_welcomed on all but
 *         a scrim tap);
 *       · window 'ds:modal' {open, id, zone?} fires when the top panel turns
 *         into or out of a modal, coalesced per task (a close then an open in
 *         one task, a section switch, fires nothing).
 *   - A MODE IS NOT A PANEL (P2-D2): setMode(name, {hides, hard}) adds a
 *     standing state's hides (being inside a building) to the same layer
 *     policy without touching the stack, the sweep, Escape, the scrim, focus
 *     or history. 'hard' hides outright on desktop too, where a panel only
 *     dims: the Leave button used to sit on top of the weather chip.
 */
import { animateIn, animateOut, fadeIn, staggerIn } from './ui/motion';

/** 'aux-controls' = the second-rank touch controls (FEED/EAT/💬/🎤): panels
 *  that must keep USE/JUMP visible (NPC dialogue advances on USE) can hide
 *  just these instead of the whole touch suite. */
export type HudLayer =
  | 'nav-chips'
  | 'touch-controls'
  | 'aux-controls'
  | 'ambient-info'
  /** JUMP, WAVE, DIVE, FEED and EAT: the touch actions with no use indoors.
   *  They are in 'touch-controls' or 'aux-controls' as well. */
  | 'outdoor-actions';

/** A standing HUD state that is not a panel (see the header). */
export interface ModeSpec {
  hides: HudLayer[];
  /** display:none on desktop as well, instead of the panels' dim. */
  hard?: boolean;
}

/** Why the manager closed a panel: Escape, a tap on the scrim, the exclusivity
 *  sweep (or closeAll), or Back off the panel's history entry. A panel's own
 *  ✕ or button closes it without the manager, through notifyClosed. */
export type CloseReason = 'escape' | 'scrim' | 'sweep' | 'back';

/** What window 'ds:modal' carries (see the header). */
export interface ModalEventDetail {
  open: boolean;
  id: string;
  /** The zone panel's zone ('hire', 'projects', …) when the modal is one. */
  zone?: string;
}

/** The slice of the History API the back-button contract uses. */
export interface HistoryPort {
  readonly state: unknown;
  pushState(data: unknown, unused: string, url?: string | URL | null): void;
  replaceState(data: unknown, unused: string, url?: string | URL | null): void;
  back(): void;
}

export interface PanelManagerOptions {
  /** Where Back is wired: window.history by default; null turns it off. */
  history?: HistoryPort | null;
  /** Called after an entry we pushed earlier turns up with no panel open
   *  (Forward after a close, or a reload), once its state is cleared: the
   *  owner drops the URL params that named the panel. */
  onStaleEntry?: () => void;
  /** Where focus goes when a keyboard-opened panel closes and its opener has
   *  left the page (a Portfolio-menu row): the Portfolio pill. */
  fallbackFocus?: () => HTMLElement | null;
}

/** What Tab can land on inside a panel. */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

const isShown = (el: HTMLElement): boolean => {
  if (el.closest('[hidden], [inert]')) return false;
  for (let n: HTMLElement | null = el; n; n = n.parentElement) {
    const cs = getComputedStyle(n);
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
  }
  return true;
};

/** The panel's controls in tab order (DOM order; nothing here sets tabindex > 0). */
const focusablesIn = (root: HTMLElement): HTMLElement[] =>
  Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(isShown);

/** Focus without scrolling the page; a non-control takes tabindex -1 first.
 *  `reveal`: a Tab step, which the browser brings into view inside the
 *  panel's own scroller. Trapped with preventScroll, Tab walked a long panel
 *  (the hire card, Projects, Contact) off its visible part (WCAG 2.4.11). */
const focusEl = (el: HTMLElement, reveal = false): boolean => {
  if (!el.matches(FOCUSABLE) && !el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1');
  try {
    el.focus({ preventScroll: !reveal });
  } catch {
    el.focus();
  }
  return document.activeElement === el;
};

const INERT_SUPPORTED = typeof HTMLElement !== 'undefined' && 'inert' in HTMLElement.prototype;
let dialogIds = 0;

/** What a pushed entry carries. dsTok is unique per push and per page life. */
interface PanelHistoryState {
  dsPanel: string;
  dsTok: string;
}

const isPanelState = (s: unknown): s is PanelHistoryState =>
  !!s && typeof s === 'object' && typeof (s as PanelHistoryState).dsTok === 'string';

// Per page life, so a token from before a reload can never pass for ours.
// Date, not Math.random: the scene's seeded window must not see a draw.
const PAGE_LIFE = Date.now().toString(36);
let pushes = 0;

/** window.history in a browser. Off under vitest unless a test passes a port:
 *  happy-dom's history.back() navigates the window to about:blank instead of
 *  popping a same-document entry, which would break every suite that closes
 *  a panel. */
const defaultHistory = (): HistoryPort | null =>
  typeof window === 'undefined' || !window.history || import.meta.env.MODE === 'test'
    ? null
    : window.history;

export interface PanelSpec {
  /** 'modal' → shared scrim + manager-owned Escape; 'sheet' → no scrim
   *  (NPC chat, chip drawer, emote wheel — the world stays visible). */
  kind: 'modal' | 'sheet';
  /** Layers suppressed while open. */
  hides: HudLayer[];
  /** Tear down THIS panel's DOM and run its side effects. MUST be idempotent —
   *  both the manager and the panel's own ✕/Escape path may call it. `reason`
   *  says why the manager closed it. */
  close: (reason?: CloseReason) => void;
  /** Panel ids allowed to remain open underneath (watch-frame over picker). */
  allow?: string[];
  /** Panel owns its own Escape (chat inputs that stopPropagation). */
  ownEscape?: boolean;
  /** The panel's root element, for panels whose close removes it. Once it
   *  has been in the document and is no longer, the entry pops by itself. */
  el?: HTMLElement;
  /** false: opening it pushes no history entry, so Back never closes it
   *  (transient sheets, the welcome card, a deep-linked panel). Default true. */
  history?: boolean;
  /** Where focus lands once the panel is in the document. A modal defaults
   *  to its first heading (at tabindex -1), else its element; a sheet takes
   *  focus only when this is given (the Portfolio menu's first row). */
  initialFocus?: () => HTMLElement | null;
  /** The panel moves focus itself (chat inputs, the tour, NPC dialogue): the
   *  manager neither moves focus in nor brings it back. */
  ownFocus?: boolean;
  /** The accessible name for a dialog with no heading to point at. */
  label?: string;
  /** A zone panel's zone id, carried on 'ds:modal'. */
  zone?: string;
}

interface Entry {
  id: string;
  spec: PanelSpec;
  /** spec.el has been seen in the document: only then does leaving it pop
   *  the entry (a modal is registered before its caller appends it). */
  seen: boolean;
  /** Where focus came from when a KEYBOARD opened the panel; null when a
   *  pointer or the world (E at a door, a timer) did. */
  opener: HTMLElement | null;
  /** Its close has run the focus hand-back already. */
  restored: boolean;
  /** Where spec.el sat while open: an exit fades it out there (D11). */
  parent?: ParentNode | null;
}

export class PanelManager {
  // Each entry remembers the element's INLINE display at registration: the
  // restore path must put back what was there (the tier-1 row is display:flex
  // — restoring '' collapsed it to block and stacked its chips vertically).
  private readonly layers = new Map<HudLayer, Array<{ el: HTMLElement; baseDisplay: string }>>();
  /** An element's inline display at its FIRST registration: one in two
   *  layers (JUMP is a touch control and an outdoor action) keeps one base. */
  private readonly bases = new Map<HTMLElement, string>();
  /** Open modes, by name (setMode). */
  private readonly modes = new Map<string, ModeSpec>();
  /** Desktop elements a hard mode took out, and the inline display each had. */
  private readonly hardHidden = new Map<HTMLElement, string>();
  private readonly stack: Entry[] = [];
  /** Panels fading out (D11), by id: a re-open cancels the exit. */
  private readonly exits = new Map<string, () => void>();
  /** The HUD is held hidden for the intro (D11): layer elements carry
   *  .ds-intro-hold until releaseHud() staggers them in. */
  private hudHeld = false;
  private readonly scrim: HTMLDivElement;
  private sweeping = false;
  private readonly onKeyDown: (e: KeyboardEvent) => void;

  // ── Focus contract (see the header) ──
  private readonly overlay: HTMLElement;
  private readonly fallbackFocus: (() => HTMLElement | null) | null;
  /** The last input: a keyboard-opened panel hands focus back to its opener,
   *  a pointer-opened one to the world. */
  private modality: 'keyboard' | 'pointer' = 'pointer';
  /** The entry that closed in this task, so an open in the same task (a menu
   *  row opening its section, the shop re-rendering) inherits its opener. */
  private justClosed: Entry | null = null;
  /** Overlay children this manager made inert, and the tabindex each
   *  fallback-disabled control had before. */
  private readonly inerted = new Set<HTMLElement>();
  private readonly savedTabIndex = new Map<HTMLElement, string | null>();
  /** The modal 'ds:modal' last reported open, and whether a flush is queued. */
  private modalShown: { id: string; zone?: string } | null = null;
  private modalFlushQueued = false;
  private disposed = false;
  private readonly onKeyModality = (): void => {
    this.modality = 'keyboard';
  };
  private readonly onPointerModality = (): void => {
    this.modality = 'pointer';
  };
  private readonly onClickModality = (e: MouseEvent): void => {
    if (e.detail > 0) this.modality = 'pointer'; // a keyboard click() has detail 0
  };
  private readonly onTrapTab = (e: KeyboardEvent): void => this.trapTab(e);

  // ── Back-button contract (see the header) ──
  private readonly history: HistoryPort | null;
  private readonly onStaleEntry: (() => void) | null;
  /** Token and panel of the entry we pushed, while it is the current one. */
  private ownTok: string | null = null;
  private ownId: string | null = null;
  /** popstate events still to come from our own back() calls. */
  private pendingPops = 0;
  /** A close released our entry; the step back runs at the end of the task
   *  unless an open in the same task takes the entry over first. */
  private backQueued = false;
  /** Page teardown (dispose, pagehide): panels still close, history is left
   *  alone. A back() during beforeunload could turn a reload or a link into
   *  a step back. */
  private historyFrozen = false;
  private readonly onPopState = (): void => this.handlePopState();
  private readonly onPageHide = (): void => {
    this.historyFrozen = true;
  };
  private readonly onPageShow = (e: Event): void => {
    this.historyFrozen = false;
    if ((e as PageTransitionEvent).persisted) this.resync();
  };

  constructor(
    overlay: HTMLElement,
    private readonly isTouch: boolean,
    opts: PanelManagerOptions = {},
  ) {
    this.overlay = overlay;
    this.fallbackFocus = opts.fallbackFocus ?? null;
    this.history = opts.history === undefined ? defaultHistory() : opts.history;
    this.onStaleEntry = opts.onStaleEntry ?? null;
    if (this.history) {
      // An entry pushed in an earlier life of this page (a reload while a
      // panel was open) is not ours any more: keep its URL, drop the state.
      if (isPanelState(this.historyState())) this.tryHistory((h) => h.replaceState(null, ''));
      window.addEventListener('popstate', this.onPopState);
      window.addEventListener('pagehide', this.onPageHide);
      window.addEventListener('pageshow', this.onPageShow);
    }
    // One scrim for every modal. It lives INSIDE the overlay so photo mode's
    // `overlay.visibility = hidden` hides it for free, and sits at 1640 —
    // just under the 1650 modal band.
    this.scrim = document.createElement('div');
    Object.assign(this.scrim.style, {
      position: 'fixed',
      inset: '0',
      background: 'rgba(0,0,0,0.45)',
      zIndex: '1640',
      display: 'none',
      pointerEvents: 'auto',
    });
    this.scrim.addEventListener('click', () => this.closeTop('scrim'));
    overlay.appendChild(this.scrim);

    // One Escape for every panel that doesn't own its key. Bubble phase:
    // chat inputs stopPropagation, so their events never arrive here — they
    // keep owning Escape without any registration.
    this.onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || this.stack.length === 0) return;
      const top = this.stack[this.stack.length - 1];
      if (top.spec.ownEscape) return;
      e.preventDefault();
      this.closeTop('escape');
    };
    document.addEventListener('keydown', this.onKeyDown);
    // Capture phase: the lead form's fields stop their keydowns from
    // propagating, and the modality and the Tab trap must still see them.
    document.addEventListener('keydown', this.onKeyModality, true);
    document.addEventListener('pointerdown', this.onPointerModality, true);
    document.addEventListener('mousedown', this.onPointerModality, true);
    document.addEventListener('click', this.onClickModality, true);
    document.addEventListener('keydown', this.onTrapTab, true);
  }

  /** Register a HUD element into a layer at creation time. */
  registerLayer(layer: HudLayer, el: HTMLElement): void {
    const list = this.layers.get(layer) ?? [];
    if (!this.bases.has(el)) this.bases.set(el, el.style.display);
    list.push({ el, baseDisplay: this.bases.get(el) ?? '' });
    this.layers.set(layer, list);
    if (this.hudHeld) el.classList.add('ds-intro-hold');
    // A panel may already be open when a late element registers (the coin
    // counter is created on first update) — apply the current policy to it.
    this.applyState();
  }

  /**
   * Enter or leave a mode: a standing state whose hides join the layer
   * policy (null leaves it). No stack entry, so nothing sweeps it, Escape
   * and Back never close it, and it raises no scrim and moves no focus.
   */
  setMode(name: string, spec: ModeSpec | null): void {
    if (spec) this.modes.set(name, spec);
    else this.modes.delete(name);
    this.applyState();
  }

  /** Is this mode on? */
  inMode(name: string): boolean {
    return this.modes.has(name);
  }

  /**
   * Open a panel: closes every open panel not in spec.allow, pushes onto the
   * stack, applies layer policy + scrim.
   */
  open(id: string, spec: PanelSpec): void {
    this.exits.get(id)?.(); // a re-open cancels a running exit
    const top = this.stack[this.stack.length - 1];
    if (top && top.id === id) {
      // Same-id re-open: replace in place, never fire close() (see header).
      const newEl = spec.el !== top.spec.el;
      if (newEl) top.seen = false;
      top.spec = spec;
      this.applyState();
      this.checkSoon();
      if (newEl) this.focusSoon(top); // the re-render dropped the old element
      return;
    }
    const opener = this.openerFor(spec);
    this.sweeping = true;
    try {
      for (let i = this.stack.length - 1; i >= 0; i--) {
        const entry = this.stack[i];
        if (spec.allow?.includes(entry.id)) continue;
        this.stack.splice(i, 1);
        entry.restored = true; // the panel opening now takes focus
        try {
          entry.spec.close('sweep');
        } catch {
          /* one broken teardown must not strand the sweep */
        }
        this.fadeOut(entry);
      }
    } finally {
      this.sweeping = false;
    }
    const entry: Entry = { id, spec, seen: false, opener, restored: false };
    this.stack.push(entry);
    animateIn(spec.el); // D11: the stack update stays synchronous
    this.applyState();
    this.checkSoon();
    this.focusSoon(entry);
  }

  /** A panel closed itself (its own ✕ / Escape path). No-op during a sweep. */
  notifyClosed(id: string): void {
    if (this.sweeping) return;
    const idx = this.stack.findIndex((e) => e.id === id);
    const gone = idx !== -1 ? this.stack.splice(idx, 1)[0] : null;
    if (gone) this.fadeOut(gone);
    // Re-derive even for an id that is not open: a close path that named the
    // wrong id has still removed its DOM, and the detached-panel pop below is
    // what takes its scrim down.
    this.applyState();
    if (gone) this.handBackFocus(gone);
  }

  /** Escape / scrim-tap / Back: close the top panel. False when the stack is empty. */
  closeTop(reason?: CloseReason): boolean {
    const top = this.stack[this.stack.length - 1];
    if (!top) return false;
    try {
      top.spec.close(reason); // its teardown usually calls notifyClosed(id)
    } catch {
      /* still pop below */
    }
    // Idempotence: if close() didn't notify, pop it ourselves.
    const idx = this.stack.indexOf(top);
    if (idx !== -1) this.stack.splice(idx, 1);
    this.fadeOut(top);
    this.applyState();
    this.handBackFocus(top);
    return true;
  }

  closeAll(): void {
    this.sweeping = true;
    try {
      for (let i = this.stack.length - 1; i >= 0; i--) {
        this.stack[i].restored = true;
        try {
          this.stack[i].spec.close('sweep');
        } catch {
          /* keep going */
        }
        this.fadeOut(this.stack[i]);
      }
      this.stack.length = 0;
    } finally {
      this.sweeping = false;
    }
    this.applyState();
  }

  /** The top panel when it is a modal: toasts never paint over one (D6). */
  topModal(): { id: string; el: HTMLElement | null } | null {
    this.sync();
    const top = this.stack[this.stack.length - 1];
    return top && top.spec.kind === 'modal' ? { id: top.id, el: top.spec.el ?? null } : null;
  }

  /** Any modal open, on top or under a sheet. */
  isModalOpen(): boolean {
    this.sync();
    return this.stack.some((e) => e.spec.kind === 'modal');
  }

  /** The open panel whose element holds `node`, topmost first. */
  panelAt(node: Node | null): string | null {
    if (!node) return null;
    for (let i = this.stack.length - 1; i >= 0; i--) {
      if (this.stack[i].spec.el?.contains(node)) return this.stack[i].id;
    }
    return null;
  }

  isOpen(id?: string): boolean {
    this.sync();
    if (id === undefined) return this.stack.length > 0;
    return this.stack.some((e) => e.id === id);
  }

  current(): string | null {
    this.sync();
    return this.stack.length ? this.stack[this.stack.length - 1].id : null;
  }

  /** Page teardown. Call it before closing panels on the way out: from here
   *  on the history is never touched. */
  dispose(): void {
    document.removeEventListener('keydown', this.onKeyDown);
    document.removeEventListener('keydown', this.onKeyModality, true);
    document.removeEventListener('pointerdown', this.onPointerModality, true);
    document.removeEventListener('mousedown', this.onPointerModality, true);
    document.removeEventListener('click', this.onClickModality, true);
    document.removeEventListener('keydown', this.onTrapTab, true);
    this.disposed = true;
    this.historyFrozen = true;
    this.backQueued = false;
    if (this.history) {
      window.removeEventListener('popstate', this.onPopState);
      window.removeEventListener('pagehide', this.onPageHide);
      window.removeEventListener('pageshow', this.onPageShow);
    }
    this.scrim.remove();
    for (const stop of [...this.exits.values()]) stop();
  }

  /**
   * D11: a closed panel fades out where it was. Its own close removed the
   * element; it goes back, inert and hidden from assistive tech, for 140 ms
   * (reduced motion: a 120 ms opacity ramp), then leaves for good. The stack
   * already moved on synchronously and focus is not held back. Off under
   * test, where the element must be gone the moment close() returns.
   */
  private fadeOut(e: Entry): void {
    const el = e.spec.el;
    const parent = e.parent;
    if (!el || !e.seen || el.isConnected || !parent || !(parent as Node).isConnected) return;
    if (import.meta.env.MODE === 'test' || typeof el.animate !== 'function') return;
    this.exits.get(e.id)?.();
    const hadAria = el.getAttribute('aria-hidden');
    const hadPe = el.style.pointerEvents;
    el.setAttribute('aria-hidden', 'true');
    el.inert = true;
    el.style.pointerEvents = 'none';
    parent.appendChild(el);
    const stop = animateOut(el, () => {
      el.remove();
      if (hadAria === null) el.removeAttribute('aria-hidden');
      else el.setAttribute('aria-hidden', hadAria);
      el.inert = false;
      el.style.pointerEvents = hadPe;
      if (this.exits.get(e.id) === stop) this.exits.delete(e.id);
    });
    if (el.isConnected) this.exits.set(e.id, stop);
  }

  /** D11: hide every HUD layer for the intro ('ds:intro' start). Elements
   *  registered while held are hidden too. */
  holdHud(): void {
    if (this.hudHeld) return;
    this.hudHeld = true;
    for (const el of this.layerEls()) el.classList.add('ds-intro-hold');
  }

  /** D11: the intro settled (or its fallback fired): stagger the HUD in. */
  releaseHud(): void {
    if (!this.hudHeld) return;
    this.hudHeld = false;
    const els = this.layerEls();
    for (const el of els) el.classList.remove('ds-intro-hold');
    staggerIn(els);
  }

  private layerEls(): HTMLElement[] {
    const out = new Set<HTMLElement>();
    for (const list of this.layers.values()) for (const { el } of list) out.add(el);
    return [...out];
  }

  /**
   * Pop every entry whose element has left the document. Cheap (the stack is
   * one or two deep), so the per-frame isOpen() reads double as the check.
   * True when something popped.
   */
  private pruneDetached(): Entry[] {
    const popped: Entry[] = [];
    for (let i = this.stack.length - 1; i >= 0; i--) {
      const e = this.stack[i];
      const el = e.spec.el;
      if (!el) continue;
      if (el.isConnected) {
        e.seen = true;
        e.parent = el.parentNode;
      } else if (e.seen) {
        this.stack.splice(i, 1);
        popped.push(e);
        this.fadeOut(e);
      }
    }
    return popped;
  }

  /** Bring the scrim and layers in line if a panel's element went away. */
  private sync(): void {
    if (this.sweeping) return;
    const popped = this.pruneDetached();
    if (!popped.length) return;
    this.applyState();
    for (const e of popped) this.handBackFocus(e);
  }

  /** Callers append a panel's element right after open(); look once the
   *  current task is done, so a panel removed before any frame ran still
   *  counts as seen. */
  private checkSoon(): void {
    queueMicrotask(() => this.sync());
  }

  /** Re-derive scrim + layer visibility from the whole stack. */
  private applyState(): void {
    const popped = this.sweeping ? [] : this.pruneDetached();
    const top = this.stack[this.stack.length - 1];
    const scrimWas = this.scrim.style.display;
    this.scrim.style.display = top && top.spec.kind === 'modal' ? 'block' : 'none';
    if (scrimWas !== 'block' && this.scrim.style.display === 'block') fadeIn(this.scrim); // D11
    // Union of hides across ALL open panels (a 2-deep watch stack must keep
    // suppressing what the lower panel suppressed).
    const hidden = new Set<HudLayer>();
    for (const e of this.stack) for (const l of e.spec.hides) hidden.add(l);
    // Modes add theirs: 'hard' ones hide outright on desktop too.
    const hard = new Set<HudLayer>();
    for (const m of this.modes.values()) for (const l of m.hides) (m.hard ? hard : hidden).add(l);
    // One verdict per element: it may sit in two layers.
    const verdict = new Map<HTMLElement, { base: string; soft: boolean; hard: boolean }>();
    for (const [layer, entries] of this.layers) {
      for (const { el, baseDisplay } of entries) {
        const v = verdict.get(el) ?? { base: baseDisplay, soft: false, hard: false };
        v.soft = v.soft || hidden.has(layer);
        v.hard = v.hard || hard.has(layer);
        verdict.set(el, v);
      }
    }
    for (const [el, v] of verdict) {
      if (this.isTouch) {
        // Absolutely-positioned HUD: display:none reflows nothing.
        el.style.display = v.soft || v.hard ? 'none' : v.base;
        continue;
      }
      el.style.opacity = v.soft ? '0.35' : '';
      el.style.pointerEvents = v.soft ? 'none' : '';
      if (v.hard) {
        if (!this.hardHidden.has(el)) {
          this.hardHidden.set(el, el.style.display);
          el.style.display = 'none';
        }
      } else if (this.hardHidden.has(el)) {
        el.style.display = this.hardHidden.get(el) ?? '';
        this.hardHidden.delete(el);
      }
    }
    if (!this.sweeping) this.applyInert();
    this.syncHistory();
    this.queueModalEvent();
    for (const e of popped) this.handBackFocus(e);
  }

  // ── Focus contract ────────────────────────────────────────────────────

  /** Who gets focus back when this panel closes (null: the world does). */
  private openerFor(spec: PanelSpec): HTMLElement | null {
    if (this.modality !== 'keyboard') return null;
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || active === document.body) {
      // Focus left with a panel that closed in this task: its opener stands.
      return this.justClosed?.opener ?? null;
    }
    if (spec.el?.contains(active)) return this.justClosed?.opener ?? null;
    // Opened from inside a panel the sweep is about to close: that panel's
    // opener, since the control itself is about to leave the page.
    for (const e of this.stack) {
      if (!spec.allow?.includes(e.id) && e.spec.el?.contains(active)) return e.opener;
    }
    return active;
  }

  /** The manager moves this panel's focus: every modal, and a sheet that
   *  names its initial focus. */
  private managesFocus(e: Entry): boolean {
    if (e.spec.ownFocus) return false;
    return e.spec.kind === 'modal' || !!e.spec.initialFocus;
  }

  /** Once the caller has appended the element (same task), focus into it. */
  private focusSoon(entry: Entry): void {
    queueMicrotask(() => {
      if (this.disposed || this.stack[this.stack.length - 1] !== entry) return;
      this.dress(entry);
      this.focusInto(entry, false);
    });
  }

  /** Put focus inside the panel: its initialFocus, else its first heading,
   *  else the element itself. `force` re-focuses even if focus is already
   *  somewhere inside (a stacked panel closed over this one). */
  private focusInto(entry: Entry, force: boolean): void {
    if (!this.managesFocus(entry)) return;
    const el = entry.spec.el;
    const active = document.activeElement;
    if (!force && el && active instanceof Node && el.contains(active)) return; // it focused itself
    let target = entry.spec.initialFocus?.() ?? null;
    if (!target && el?.isConnected) target = el.querySelector<HTMLElement>('h1, h2, h3') ?? el;
    if (target?.isConnected) focusEl(target);
  }

  /** Dialog semantics, once the content is in: role and aria-modal for a
   *  modal, a name from its first heading (or spec.label), and keyboard
   *  scrolling for a scroller that holds nothing focusable. */
  private dress(entry: Entry): void {
    const el = entry.spec.el;
    if (!el?.isConnected) return;
    if (entry.spec.kind === 'modal') {
      if (!el.getAttribute('role')) el.setAttribute('role', 'dialog');
      el.setAttribute('aria-modal', 'true');
    }
    if (
      el.getAttribute('role') === 'dialog' &&
      !el.hasAttribute('aria-label') &&
      !el.hasAttribute('aria-labelledby')
    ) {
      const h = el.querySelector<HTMLElement>('h1, h2, h3');
      if (h) {
        if (!h.id) h.id = `ds-dialog-title-${++dialogIds}`;
        el.setAttribute('aria-labelledby', h.id);
      } else if (entry.spec.label) {
        el.setAttribute('aria-label', entry.spec.label);
      }
    }
    for (const n of Array.from(el.querySelectorAll<HTMLElement>('div, ul, section'))) {
      const ov = n.style.overflowY || n.style.overflow;
      if (
        (ov === 'auto' || ov === 'scroll') &&
        !n.hasAttribute('tabindex') &&
        !n.querySelector(FOCUSABLE)
      ) {
        n.tabIndex = 0;
      }
    }
  }

  /** A panel left the stack by any path but the sweep: see the header. */
  private handBackFocus(closed: Entry): void {
    if (closed.restored || this.disposed) return;
    closed.restored = true;
    this.justClosed = closed;
    queueMicrotask(() => {
      if (this.justClosed === closed) this.justClosed = null;
    });
    if (!this.managesFocus(closed)) return;
    const active = document.activeElement;
    const el = closed.spec.el;
    const inside = !!el && active instanceof Node && el.contains(active);
    const lost = !active || active === document.body || !active.isConnected;
    if (!inside && !lost) return; // focus already went somewhere on purpose
    const top = this.stack[this.stack.length - 1];
    if (top && this.managesFocus(top) && top.spec.el?.isConnected) {
      this.focusInto(top, true);
      return;
    }
    const opener = closed.opener;
    if (opener) {
      if (opener.isConnected && !opener.closest('[inert]') && focusEl(opener)) return;
      const fb = this.fallbackFocus?.();
      if (fb?.isConnected && focusEl(fb)) return;
    }
    if (inside && active instanceof HTMLElement) active.blur(); // the world keeps its keys
  }

  /** Tab and Shift+Tab wrap inside the top modal, first ↔ last. */
  private trapTab(e: KeyboardEvent): void {
    if (e.key !== 'Tab' || e.altKey || e.ctrlKey || e.metaKey) return;
    const top = this.stack[this.stack.length - 1];
    const el = top?.spec.kind === 'modal' ? top.spec.el : undefined;
    if (!el?.isConnected) return;
    const list = focusablesIn(el);
    e.preventDefault();
    if (!list.length) {
      focusEl(el);
      return;
    }
    const active = document.activeElement;
    let i = active instanceof HTMLElement ? list.indexOf(active) : -1;
    if (i === -1 && active instanceof Node && el.contains(active)) {
      // On the heading or the dialog itself: step from its place in the DOM.
      const after = list.findIndex(
        (f) => !!(active.compareDocumentPosition(f) & Node.DOCUMENT_POSITION_FOLLOWING),
      );
      i = after === -1 ? list.length : after;
      focusEl(e.shiftKey ? list[(i - 1 + list.length) % list.length] : list[i % list.length], true);
      return;
    }
    if (i === -1) {
      focusEl(e.shiftKey ? list[list.length - 1] : list[0], true);
      return;
    }
    focusEl(list[(i + (e.shiftKey ? -1 : 1) + list.length) % list.length], true);
  }

  /** inert on every other overlay child while a modal is on top. */
  private applyInert(): void {
    const top = this.stack[this.stack.length - 1];
    const want = new Set<HTMLElement>();
    const modalEl = top?.spec.kind === 'modal' ? top.spec.el : undefined;
    if (modalEl) {
      const keep = new Set<HTMLElement>([modalEl, this.scrim]);
      for (const e of this.stack) if (e.spec.kind === 'sheet' && e.spec.el) keep.add(e.spec.el);
      for (const c of Array.from(this.overlay.children)) {
        if (!(c instanceof HTMLElement) || keep.has(c) || c.contains(modalEl)) continue;
        if (c.id === 'ds-guide' || c.hasAttribute('data-never-inert')) continue;
        want.add(c);
      }
    }
    for (const c of Array.from(this.inerted)) {
      if (want.has(c)) continue;
      this.setInert(c, false);
      this.inerted.delete(c);
    }
    for (const c of want) {
      if (this.inerted.has(c)) continue;
      this.setInert(c, true);
      this.inerted.add(c);
    }
  }

  private setInert(el: HTMLElement, on: boolean): void {
    if (on) el.setAttribute('inert', '');
    else el.removeAttribute('inert');
    if (INERT_SUPPORTED) return;
    // No inert: take the controls out of the tab order, and put them back.
    if (on) {
      for (const f of Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE))) {
        if (this.savedTabIndex.has(f)) continue;
        this.savedTabIndex.set(f, f.getAttribute('tabindex'));
        f.setAttribute('tabindex', '-1');
      }
      return;
    }
    for (const [f, t] of Array.from(this.savedTabIndex)) {
      if (!el.contains(f)) continue;
      if (t === null) f.removeAttribute('tabindex');
      else f.setAttribute('tabindex', t);
      this.savedTabIndex.delete(f);
    }
  }

  /** 'ds:modal' when the top turns into or out of a modal, once per task. */
  private queueModalEvent(): void {
    if (this.modalFlushQueued || typeof window === 'undefined') return;
    this.modalFlushQueued = true;
    queueMicrotask(() => {
      this.modalFlushQueued = false;
      if (this.disposed) return;
      const top = this.stack[this.stack.length - 1];
      const now = top && top.spec.kind === 'modal' ? { id: top.id, zone: top.spec.zone } : null;
      const was = this.modalShown;
      this.modalShown = now;
      if (!now === !was) return;
      const m = (now ?? was)!;
      const detail: ModalEventDetail = { open: !!now, id: m.id };
      if (m.zone) detail.zone = m.zone;
      try {
        window.dispatchEvent(new CustomEvent('ds:modal', { detail }));
      } catch {
        /* no CustomEvent: nothing listens either */
      }
    });
  }

  // ── Back-button contract ──────────────────────────────────────────────

  /** Bring the session history in line with the stack: one entry of ours
   *  exactly while the top panel is a history panel. */
  private syncHistory(): void {
    if (!this.history || this.sweeping || this.historyFrozen) return;
    const top = this.stack[this.stack.length - 1];
    if (top && top.spec.history !== false) {
      this.backQueued = false; // an open in the same task takes the entry over
      const owned = this.ownTok;
      if (owned !== null) {
        // The sweep, or a close then an open: re-label the entry, never
        // back-then-push (the queued back would land after the push).
        if (this.ownId !== top.id) {
          this.tryHistory((h) => h.replaceState(this.stateFor(top.id, owned), ''));
          this.ownId = top.id; // the token, not the label, is what Back checks
        }
      } else if (this.pendingPops === 0) {
        const tok = `${PAGE_LIFE}:${++pushes}`;
        if (this.tryHistory((h) => h.pushState(this.stateFor(top.id, tok), ''))) {
          this.ownTok = tok;
          this.ownId = top.id;
        }
      }
      // else: our own back() is still in flight; handlePopState pushes after it
      return;
    }
    if (this.ownTok !== null && !this.backQueued) {
      this.backQueued = true;
      queueMicrotask(() => this.releaseEntry());
    }
  }

  private stateFor(id: string, tok: string): PanelHistoryState {
    return { dsPanel: id, dsTok: tok };
  }

  /** A history write the browser refuses (Safari caps pushState at 100 per
   *  30 s; a sandboxed frame may forbid it) costs the Back contract, never
   *  the panel: false instead of a throw out of open() or a close. */
  private tryHistory(write: (h: HistoryPort) => void): boolean {
    if (!this.history) return false;
    try {
      write(this.history);
      return true;
    } catch {
      return false;
    }
  }

  private historyState(): unknown {
    try {
      return this.history?.state ?? null;
    } catch {
      return null;
    }
  }

  /** The panel our entry stood for has closed: step back off the entry, but
   *  only while it is provably ours. If another writer replaced its state, a
   *  back() could leave the site; one stale entry costs one extra Back. */
  private releaseEntry(): void {
    if (!this.backQueued || !this.history || this.historyFrozen) return;
    this.backQueued = false;
    const tok = this.ownTok;
    this.ownTok = null;
    this.ownId = null;
    const state = this.historyState();
    if (tok !== null && isPanelState(state) && state.dsTok === tok) {
      this.pendingPops++;
      if (!this.tryHistory((h) => h.back())) this.pendingPops--;
    }
  }

  private handlePopState(): void {
    if (!this.history) return;
    if (this.pendingPops > 0) {
      // The traversal our own back() asked for. A panel that opened while it
      // was in flight gets its entry now.
      this.pendingPops--;
      this.syncHistory();
      return;
    }
    const state = this.historyState();
    if (this.ownTok !== null) {
      if (isPanelState(state) && state.dsTok === this.ownTok) return; // still ours
      // Back (or Forward) moved off the entry: close the panel it stood for.
      // ownTok is cleared first, so the close releases nothing; a history
      // panel still open underneath gets an entry of its own.
      this.ownTok = null;
      this.ownId = null;
      this.backQueued = false;
      this.closeTop('back');
      return;
    }
    if (isPanelState(state)) {
      // An entry pushed for a panel that has since closed (Forward after a
      // close): make it a plain island entry again.
      this.tryHistory((h) => h.replaceState(null, ''));
      this.onStaleEntry?.();
    }
  }

  /** A bfcache restore (pageshow, persisted): drop entries whose DOM is gone,
   *  forget an entry we are no longer on and any traversal that never came
   *  back, then re-derive (a history panel without an entry gets one). */
  private resync(): void {
    if (!this.history) return;
    const popped = this.pruneDetached();
    const state = this.historyState();
    if (this.ownTok !== null && !(isPanelState(state) && state.dsTok === this.ownTok)) {
      this.ownTok = null;
      this.ownId = null;
    }
    this.pendingPops = 0;
    this.backQueued = false;
    this.applyState();
    for (const e of popped) this.handBackFocus(e);
  }
}
