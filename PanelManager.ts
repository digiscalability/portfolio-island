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
 */

/** 'aux-controls' = the second-rank touch controls (FEED/EAT/💬/🎤): panels
 *  that must keep USE/JUMP visible (NPC dialogue advances on USE) can hide
 *  just these instead of the whole touch suite. */
export type HudLayer = 'nav-chips' | 'touch-controls' | 'aux-controls' | 'ambient-info';

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
}

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
   *  both the manager and the panel's own ✕/Escape path may call it. */
  close: () => void;
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
}

interface Entry {
  id: string;
  spec: PanelSpec;
  /** spec.el has been seen in the document: only then does leaving it pop
   *  the entry (a modal is registered before its caller appends it). */
  seen: boolean;
}

export class PanelManager {
  // Each entry remembers the element's INLINE display at registration: the
  // restore path must put back what was there (the tier-1 row is display:flex
  // — restoring '' collapsed it to block and stacked its chips vertically).
  private readonly layers = new Map<HudLayer, Array<{ el: HTMLElement; baseDisplay: string }>>();
  private readonly stack: Entry[] = [];
  private readonly scrim: HTMLDivElement;
  private sweeping = false;
  private readonly onKeyDown: (e: KeyboardEvent) => void;

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
    this.scrim.addEventListener('click', () => this.closeTop());
    overlay.appendChild(this.scrim);

    // One Escape for every panel that doesn't own its key. Bubble phase:
    // chat inputs stopPropagation, so their events never arrive here — they
    // keep owning Escape without any registration.
    this.onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || this.stack.length === 0) return;
      const top = this.stack[this.stack.length - 1];
      if (top.spec.ownEscape) return;
      e.preventDefault();
      this.closeTop();
    };
    document.addEventListener('keydown', this.onKeyDown);
  }

  /** Register a HUD element into a layer at creation time. */
  registerLayer(layer: HudLayer, el: HTMLElement): void {
    const list = this.layers.get(layer) ?? [];
    list.push({ el, baseDisplay: el.style.display });
    this.layers.set(layer, list);
    // A panel may already be open when a late element registers (the coin
    // counter is created on first update) — apply the current policy to it.
    this.applyState();
  }

  /**
   * Open a panel: closes every open panel not in spec.allow, pushes onto the
   * stack, applies layer policy + scrim.
   */
  open(id: string, spec: PanelSpec): void {
    const top = this.stack[this.stack.length - 1];
    if (top && top.id === id) {
      // Same-id re-open: replace in place, never fire close() (see header).
      if (spec.el !== top.spec.el) top.seen = false;
      top.spec = spec;
      this.applyState();
      this.checkSoon();
      return;
    }
    this.sweeping = true;
    try {
      for (let i = this.stack.length - 1; i >= 0; i--) {
        const entry = this.stack[i];
        if (spec.allow?.includes(entry.id)) continue;
        this.stack.splice(i, 1);
        try {
          entry.spec.close();
        } catch {
          /* one broken teardown must not strand the sweep */
        }
      }
    } finally {
      this.sweeping = false;
    }
    this.stack.push({ id, spec, seen: false });
    this.applyState();
    this.checkSoon();
  }

  /** A panel closed itself (its own ✕ / Escape path). No-op during a sweep. */
  notifyClosed(id: string): void {
    if (this.sweeping) return;
    const idx = this.stack.findIndex((e) => e.id === id);
    if (idx !== -1) this.stack.splice(idx, 1);
    // Re-derive even for an id that is not open: a close path that named the
    // wrong id has still removed its DOM, and the detached-panel pop below is
    // what takes its scrim down.
    this.applyState();
  }

  /** Escape / scrim-tap: close the top panel. False when the stack is empty. */
  closeTop(): boolean {
    const top = this.stack[this.stack.length - 1];
    if (!top) return false;
    try {
      top.spec.close(); // its teardown usually calls notifyClosed(id)
    } catch {
      /* still pop below */
    }
    // Idempotence: if close() didn't notify, pop it ourselves.
    const idx = this.stack.indexOf(top);
    if (idx !== -1) this.stack.splice(idx, 1);
    this.applyState();
    return true;
  }

  closeAll(): void {
    this.sweeping = true;
    try {
      for (let i = this.stack.length - 1; i >= 0; i--) {
        try {
          this.stack[i].spec.close();
        } catch {
          /* keep going */
        }
      }
      this.stack.length = 0;
    } finally {
      this.sweeping = false;
    }
    this.applyState();
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
    this.historyFrozen = true;
    this.backQueued = false;
    if (this.history) {
      window.removeEventListener('popstate', this.onPopState);
      window.removeEventListener('pagehide', this.onPageHide);
      window.removeEventListener('pageshow', this.onPageShow);
    }
    this.scrim.remove();
  }

  /**
   * Pop every entry whose element has left the document. Cheap (the stack is
   * one or two deep), so the per-frame isOpen() reads double as the check.
   * True when something popped.
   */
  private pruneDetached(): boolean {
    let popped = false;
    for (let i = this.stack.length - 1; i >= 0; i--) {
      const e = this.stack[i];
      const el = e.spec.el;
      if (!el) continue;
      if (el.isConnected) e.seen = true;
      else if (e.seen) {
        this.stack.splice(i, 1);
        popped = true;
      }
    }
    return popped;
  }

  /** Bring the scrim and layers in line if a panel's element went away. */
  private sync(): void {
    if (!this.sweeping && this.pruneDetached()) this.applyState();
  }

  /** Callers append a panel's element right after open(); look once the
   *  current task is done, so a panel removed before any frame ran still
   *  counts as seen. */
  private checkSoon(): void {
    queueMicrotask(() => this.sync());
  }

  /** Re-derive scrim + layer visibility from the whole stack. */
  private applyState(): void {
    if (!this.sweeping) this.pruneDetached();
    const top = this.stack[this.stack.length - 1];
    this.scrim.style.display = top && top.spec.kind === 'modal' ? 'block' : 'none';
    // Union of hides across ALL open panels (a 2-deep watch stack must keep
    // suppressing what the lower panel suppressed).
    const hidden = new Set<HudLayer>();
    for (const e of this.stack) for (const l of e.spec.hides) hidden.add(l);
    for (const [layer, entries] of this.layers) {
      const hide = hidden.has(layer);
      for (const { el, baseDisplay } of entries) {
        if (this.isTouch) {
          // Absolutely-positioned HUD: display:none reflows nothing.
          el.style.display = hide ? 'none' : baseDisplay;
        } else {
          el.style.opacity = hide ? '0.35' : '';
          el.style.pointerEvents = hide ? 'none' : '';
        }
      }
    }
    this.syncHistory();
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
      this.closeTop();
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
    this.pruneDetached();
    const state = this.historyState();
    if (this.ownTok !== null && !(isPanelState(state) && state.dsTok === this.ownTok)) {
      this.ownTok = null;
      this.ownId = null;
    }
    this.pendingPops = 0;
    this.backQueued = false;
    this.applyState();
  }
}
