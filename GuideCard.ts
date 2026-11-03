/**
 * GuideCard.ts: the First steps card (A6), drawn from Guide's view.
 *
 * One #ds-guide element on the HUD overlay, a polite atomic live region.
 * While the guide is active it carries data-active='1' and every change of
 * {active, step} is dispatched as window 'ds:guide', which D6 reads to hold
 * hint toasts. Inline styles, each a var(--ds-*, literal), so the card looks
 * the same with or without D's tokens. Motion is transform and opacity,
 * finite, and none at all under reduced motion; at most three elements
 * animate at once (the card, its check, one ring or the ghost thumb).
 */
import type { GuideButton, GuideCopy, GuideView } from './Guide';

export interface GuideCardOptions {
  touch: boolean;
  reducedMotion(): boolean;
  /** A button: skip, resume (the chip), ok, primary, school, close. */
  onButton(id: GuideButton['id']): void;
  /** The interaction prompt the phone card stays 8 px above, if any. */
  prompt(): HTMLElement | null;
}

/** Which [data-guide] anchors (D13's, added by D6) to ring for a view. */
function anchorsFor(v: GuideView, touch: boolean): { rings: string[]; thumb: boolean } {
  const rings: string[] = [];
  let thumb = false;
  if (v.phase === 'steps' && !v.chip) {
    switch (v.step) {
      case 'move':
        thumb = touch;
        break;
      case 'talk':
        if (touch) rings.push('use-button');
        break;
      case 'portfolio':
        rings.push(touch ? 'drawer-toggle' : 'portfolio-chip');
        break;
      case 'compass':
        rings.push('compass');
        break;
      default:
        break;
    }
  }
  if (v.coinLine && rings.length === 0) rings.push('coin-chip');
  return { rings, thumb };
}

/** A key cap: [W] in the copy. */
function appendWithKeys(parent: HTMLElement, text: string): void {
  const parts = text.split(/(\[[^\]]{1,3}\])/);
  for (const part of parts) {
    if (!part) continue;
    const m = /^\[([^\]]{1,3})\]$/.exec(part);
    if (!m) {
      parent.appendChild(document.createTextNode(part));
      continue;
    }
    const k = document.createElement('kbd');
    k.textContent = m[1];
    Object.assign(k.style, {
      display: 'inline-block',
      minWidth: '1.6em',
      padding: '0 5px',
      margin: '0 1px',
      borderRadius: 'var(--ds-radius-xs, 6px)',
      border: '1px solid var(--ds-line-strong, rgba(255,255,255,0.2))',
      background: 'rgba(255,255,255,0.08)',
      fontFamily: 'inherit',
      fontSize: '12.5px',
      lineHeight: '1.5',
      textAlign: 'center',
      color: 'var(--ds-text-1, #f3f6fb)',
    });
    parent.appendChild(k);
  }
}

export class GuideCard {
  readonly el: HTMLDivElement;
  private renderedVersion = -1;
  private lastSignal: string | null = null;
  private lastShown = false;
  private lastJustDone: string | null = null;
  private lastAnchors = '';
  private decor: HTMLElement[] = [];
  private promptLift = 0;
  private readonly onResize = (): void => {
    this.promptLift = 0;
    this.place();
  };
  private readonly onClick = (e: Event): void => {
    const b = (e.target as Element | null)?.closest?.('[data-g]') as HTMLElement | null;
    if (!b || !this.el.contains(b)) return;
    e.stopPropagation();
    this.opts.onButton(b.dataset.g as GuideButton['id']);
  };

  constructor(
    private readonly overlay: HTMLElement,
    private readonly opts: GuideCardOptions,
  ) {
    const el = document.createElement('div');
    el.id = 'ds-guide';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    el.setAttribute('aria-atomic', 'true');
    el.dataset.active = '0';
    Object.assign(el.style, {
      position: 'absolute',
      display: 'none',
      boxSizing: 'border-box',
      background: 'var(--ds-ink-900, rgba(16,24,38,0.94))',
      border: '1px solid var(--ds-line-strong, rgba(255,255,255,0.14))',
      borderRadius: 'var(--ds-radius-md, 14px)',
      padding: '10px 14px',
      color: 'var(--ds-text-1, #f3f6fb)',
      fontFamily: 'var(--font-ui, system-ui)',
      fontSize: '14px',
      lineHeight: '1.4',
      boxShadow: 'var(--ds-shadow-2, 0 8px 24px rgba(3,6,12,0.45))',
      pointerEvents: 'auto',
      // Under the chip row (1500), the drawer (1510), every panel (1640+) and
      // the toasts (1750), which sit above the card.
      zIndex: '1450',
    });
    el.addEventListener('click', this.onClick);
    overlay.appendChild(el);
    this.el = el;
    window.addEventListener('resize', this.onResize);
    this.place();
  }

  /** The guide view this card last drew. */
  version(): number {
    return this.renderedVersion;
  }

  render(v: GuideView, copy: GuideCopy): void {
    if (v.version === this.renderedVersion) return;
    this.renderedVersion = v.version;
    const signal =
      v.phase === 'steps'
        ? v.step
        : v.phase === 'controls' || v.phase === 'finale'
          ? v.phase
          : null;
    const active = v.active;
    this.el.dataset.active = active ? '1' : '0';
    this.el.dataset.step = signal ?? '';
    const key = `${active}|${signal}`;
    if (key !== this.lastSignal) {
      this.lastSignal = key;
      window.dispatchEvent(new CustomEvent('ds:guide', { detail: { active, step: signal } }));
    }
    if (!v.visible) {
      this.el.style.display = 'none';
      this.lastShown = false;
      this.clearDecor();
      return;
    }
    this.el.replaceChildren();
    if (v.chip) this.drawChip(copy);
    else this.drawCard(v, copy);
    this.el.style.display = 'block';
    this.place();
    const motion = !this.opts.reducedMotion();
    if (!this.lastShown && motion) {
      this.el.animate(
        [
          { opacity: 0, transform: 'translateY(6px)' },
          { opacity: 1, transform: 'none' },
        ],
        { duration: 180, easing: 'ease-out' },
      );
    }
    this.lastShown = true;
    if (v.justDone && v.justDone !== this.lastJustDone && motion) {
      this.el
        .querySelector<HTMLElement>('[data-check]')
        ?.animate([{ transform: 'scale(0.6)' }, { transform: 'scale(1)' }], {
          duration: 180,
          easing: 'ease-out',
        });
    }
    this.lastJustDone = v.justDone;
    this.drawDecor(v);
  }

  /**
   * Keep the phone card at least 8 px above the interaction prompt. Called a
   * few times a second, never per frame. The lift only grows (a resize resets
   * it): a prompt that wraps to two lines raises the card once, instead of
   * the card bobbing every time a prompt comes and goes.
   */
  checkPrompt(): void {
    if (this.el.style.display === 'none' || !this.opts.touch || innerHeight <= 500) return;
    const p = this.opts.prompt();
    if (!p || !p.isConnected) return;
    const cs = getComputedStyle(p);
    const op = parseFloat(cs.opacity);
    if (cs.display === 'none' || cs.visibility === 'hidden' || op < 0.05) return; // NaN: shown
    const r = p.getBoundingClientRect();
    if (r.height <= 0) return;
    const lift = Math.ceil(innerHeight - r.top + 8);
    if (lift > this.promptLift) {
      this.promptLift = lift;
      this.place();
    }
  }

  /**
   * The card's lane. Desktop: left, under the radar. Phone portrait: above
   * the prompt lane, clear of the joystick and the action column. Short
   * landscape: right of the radar, below the compass pill, clear of the
   * chat buttons, the emote chip and the toast lane.
   */
  place(): void {
    const s = this.el.style;
    // The lane and the lift as data, for the probes and the tests.
    this.el.dataset.lift = String(this.promptLift);
    if (innerHeight <= 500) {
      this.el.dataset.lane = 'landscape';
      Object.assign(s, {
        top: 'calc(var(--sat, 0px) + 60px)',
        left: 'calc(var(--sal, 0px) + 146px)',
        bottom: 'auto',
        width: 'min(44vw, 290px)',
      });
    } else if (this.opts.touch) {
      this.el.dataset.lane = 'phone';
      const base = 'calc(var(--sab, 0px) + 350px)';
      Object.assign(s, {
        top: 'auto',
        left: 'calc(50% - min(46vw, 180px))',
        bottom: this.promptLift > 0 ? `max(${base}, ${this.promptLift}px)` : base,
        width: 'min(92vw, 360px)',
      });
    } else {
      this.el.dataset.lane = 'desktop';
      Object.assign(s, {
        top: 'calc(var(--sat, 0px) + 232px)',
        left: 'calc(var(--sal, 0px) + 16px)',
        bottom: 'auto',
        width: '300px',
      });
    }
  }

  dispose(): void {
    window.removeEventListener('resize', this.onResize);
    this.el.removeEventListener('click', this.onClick);
    this.clearDecor();
    this.el.remove();
  }

  private button(b: GuideButton, style: Partial<CSSStyleDeclaration>): HTMLButtonElement {
    const el = document.createElement('button');
    el.type = 'button';
    el.dataset.g = b.id;
    el.textContent = b.label;
    Object.assign(el.style, {
      font: 'inherit',
      cursor: 'pointer',
      color: 'var(--ds-text-1, #f3f6fb)',
      ...style,
    });
    return el;
  }

  private drawChip(copy: GuideCopy): void {
    this.el.style.padding = '0';
    const b = this.button(
      { id: 'resume', label: copy.chip },
      {
        display: 'block',
        width: '100%',
        minHeight: 'var(--ds-hit-target, 44px)',
        padding: '0 14px',
        border: 'none',
        background: 'transparent',
        fontSize: '13px',
        fontWeight: '600',
        textAlign: 'left',
      },
    );
    this.el.appendChild(b);
  }

  private drawCard(v: GuideView, copy: GuideCopy): void {
    this.el.style.padding = '10px 14px';
    const head = document.createElement('div');
    Object.assign(head.style, {
      position: 'relative',
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
      minHeight: '20px',
      paddingRight: '52px',
      fontSize: '12px',
      color: 'var(--ds-text-3, #9fb0c8)',
    });
    const title = document.createElement('span');
    title.textContent = copy.title;
    if (v.phase === 'finale') {
      Object.assign(title.style, {
        fontSize: '14px',
        fontWeight: '700',
        color: 'var(--ds-text-1, #f3f6fb)',
      });
    }
    head.appendChild(title);
    if (v.phase === 'steps') head.appendChild(this.dots(v));
    // Skip (or Close): a 44 px hit area at the card's top right.
    head.appendChild(
      this.button(copy.headButton, {
        position: 'absolute',
        top: '-10px',
        right: '-14px',
        minWidth: '52px',
        height: 'var(--ds-hit-target, 44px)',
        padding: '0 10px',
        border: 'none',
        background: 'transparent',
        fontSize: '12.5px',
        color: 'var(--ds-text-2, #c5cfdd)',
        textDecoration: 'underline',
      }),
    );
    this.el.appendChild(head);
    if (copy.body) {
      const body = document.createElement('div');
      Object.assign(body.style, { marginTop: '6px', display: 'flex', gap: '8px' });
      if (v.justDone) {
        const check = document.createElement('span');
        check.dataset.check = '1';
        check.textContent = '✓';
        Object.assign(check.style, {
          display: 'inline-block',
          color: 'var(--ds-signal, #ffd479)',
          fontWeight: '700',
        });
        body.appendChild(check);
      }
      const text = document.createElement('span');
      appendWithKeys(text, copy.body);
      body.appendChild(text);
      this.el.appendChild(body);
    }
    if (copy.line) {
      const line = document.createElement('div');
      line.textContent = copy.line;
      Object.assign(line.style, {
        marginTop: '6px',
        fontSize: '12.5px',
        color: 'var(--ds-signal, #ffd479)',
      });
      this.el.appendChild(line);
    }
    if (copy.buttons.length) {
      const row = document.createElement('div');
      // Stacked, each the card's width: half a 300 px card cannot hold
      // 'Show me the School' on one line.
      Object.assign(row.style, {
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
        marginTop: '10px',
      });
      copy.buttons.forEach((b, i) =>
        row.appendChild(
          this.button(b, {
            minHeight: 'var(--ds-hit-target, 44px)',
            padding: '0 12px',
            borderRadius: 'var(--ds-radius-sm, 10px)',
            fontSize: '13.5px',
            fontWeight: '600',
            // One filled primary, the indigo; nothing new is green.
            border:
              i === 0 && b.id !== 'ok'
                ? 'none'
                : '1px solid var(--ds-line-strong, rgba(255,255,255,0.2))',
            background:
              i === 0 && b.id !== 'ok'
                ? 'var(--ds-primary, linear-gradient(135deg,#4c5be0,#7a45d6))'
                : 'rgba(255,255,255,0.06)',
          }),
        ),
      );
      this.el.appendChild(row);
    }
  }

  private dots(v: GuideView): HTMLElement {
    const wrap = document.createElement('span');
    wrap.setAttribute('aria-hidden', 'true');
    Object.assign(wrap.style, { display: 'inline-flex', gap: '4px' });
    for (const s of ['move', 'look', 'talk', 'portfolio', 'compass'] as const) {
      const d = document.createElement('span');
      const done = v.done.includes(s);
      const here = v.step === s && !done;
      Object.assign(d.style, {
        width: '6px',
        height: '6px',
        borderRadius: '50%',
        background: done ? 'var(--ds-signal, #ffd479)' : 'transparent',
        border: `1px solid ${done || here ? 'var(--ds-signal, #ffd479)' : 'rgba(255,255,255,0.35)'}`,
        boxSizing: 'border-box',
      });
      wrap.appendChild(d);
    }
    return wrap;
  }

  /** Rings around D's [data-guide] anchors and the joystick's ghost thumb.
   *  Skipped while no anchor exists (before D lands, copy only). */
  private drawDecor(v: GuideView): void {
    const want = anchorsFor(v, this.opts.touch);
    const key = `${want.rings.join(',')}|${want.thumb}`;
    if (key === this.lastAnchors && this.decor.length) return;
    this.lastAnchors = key;
    this.clearDecor();
    const motion = !this.opts.reducedMotion();
    for (const id of want.rings) {
      const a = document.querySelector<HTMLElement>(`[data-guide="${id}"]`);
      const r = a?.getBoundingClientRect();
      if (!r || r.width < 1) continue;
      const ring = document.createElement('div');
      ring.dataset.guideRing = id;
      Object.assign(ring.style, {
        position: 'fixed',
        left: `${r.left - 5}px`,
        top: `${r.top - 5}px`,
        width: `${r.width + 10}px`,
        height: `${r.height + 10}px`,
        boxSizing: 'border-box',
        border: '2px solid var(--ds-signal, #ffd479)',
        borderRadius: `${Math.min(r.height, r.width) / 2 + 5}px`,
        pointerEvents: 'none',
        zIndex: '1660',
      });
      this.overlay.appendChild(ring);
      this.decor.push(ring);
      if (motion) {
        ring.animate(
          [
            { opacity: 1, transform: 'scale(1)' },
            { opacity: 0.25, transform: 'scale(1.12)' },
          ],
          { duration: 900, iterations: 3, direction: 'alternate', easing: 'ease-in-out' },
        );
      }
      break; // one ring at a time
    }
    if (want.thumb) {
      const j = document.querySelector<HTMLElement>('[data-guide="joystick"]');
      const r = j?.getBoundingClientRect();
      if (r && r.width > 0) {
        const t = document.createElement('div');
        t.dataset.guideRing = 'thumb';
        Object.assign(t.style, {
          position: 'fixed',
          left: `${r.left + r.width / 2 - 22}px`,
          top: `${r.top + r.height / 2 - 22}px`,
          width: '44px',
          height: '44px',
          borderRadius: '50%',
          background: 'rgba(255,255,255,0.35)',
          border: '2px solid var(--ds-signal, #ffd479)',
          boxSizing: 'border-box',
          pointerEvents: 'none',
          zIndex: '1660',
        });
        this.overlay.appendChild(t);
        this.decor.push(t);
        if (motion) {
          t.animate([{ transform: 'translateY(0)' }, { transform: 'translateY(-28px)' }], {
            duration: 700,
            iterations: 4,
            direction: 'alternate',
            easing: 'ease-in-out',
          });
        }
      }
    }
  }

  private clearDecor(): void {
    for (const d of this.decor) d.remove();
    this.decor = [];
    this.lastAnchors = '';
  }
}
