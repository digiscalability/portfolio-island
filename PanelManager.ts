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
 */

/** 'aux-controls' = the second-rank touch controls (FEED/EAT/💬/🎤): panels
 *  that must keep USE/JUMP visible (NPC dialogue advances on USE) can hide
 *  just these instead of the whole touch suite. */
export type HudLayer = 'nav-chips' | 'touch-controls' | 'aux-controls' | 'ambient-info';

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
}

interface Entry {
  id: string;
  spec: PanelSpec;
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

  constructor(
    overlay: HTMLElement,
    private readonly isTouch: boolean,
  ) {
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
      top.spec = spec;
      this.applyState();
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
    this.stack.push({ id, spec });
    this.applyState();
  }

  /** A panel closed itself (its own ✕ / Escape path). No-op during a sweep. */
  notifyClosed(id: string): void {
    if (this.sweeping) return;
    const idx = this.stack.findIndex((e) => e.id === id);
    if (idx === -1) return;
    this.stack.splice(idx, 1);
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
    if (id === undefined) return this.stack.length > 0;
    return this.stack.some((e) => e.id === id);
  }

  current(): string | null {
    return this.stack.length ? this.stack[this.stack.length - 1].id : null;
  }

  dispose(): void {
    document.removeEventListener('keydown', this.onKeyDown);
    this.scrim.remove();
  }

  /** Re-derive scrim + layer visibility from the whole stack. */
  private applyState(): void {
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
  }
}
