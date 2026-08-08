import { a11y } from './Accessibility';
import { linkLabel, markReachedPortfolio, track, trackOnce } from './Analytics';
import { VOICE_MAX_MS } from './Chat';
import { DISTRICTS } from './Districts';
import { checkName } from './Moderation';
import { ACTIVITY_DEFS } from './NpcActivities';
import { AI_NPCS } from './NpcChat';
import { Passport, PASSPORT_META, PASSPORT_ZONES, type PassportZone } from './Passport';
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
export interface JournalData {
  stamps: Array<{ icon: string; label: string; has: boolean }>;
  hats: Array<{ icon: string; name: string; owned: boolean }>;
  races: Array<{ label: string; best: number | null }>;
  deliveries: { done: number; total: number };
  coins: number;
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
        transition: 'opacity 0.28s ease',
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
      }, 320);
    }, 300);
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
      fontFamily: 'Arial, sans-serif',
    });
    // Safe-area insets published as inheriting custom properties so every
    // edge-anchored HUD child can offset itself off notches / home
    // indicators with calc(var(--sa*) + Npx). Resolve to 0 on desktop.
    this.overlay.style.setProperty('--sat', 'env(safe-area-inset-top, 0px)');
    this.overlay.style.setProperty('--sar', 'env(safe-area-inset-right, 0px)');
    this.overlay.style.setProperty('--sab', 'env(safe-area-inset-bottom, 0px)');
    this.overlay.style.setProperty('--sal', 'env(safe-area-inset-left, 0px)');

    this.createFPSDisplay();
    this.createMuteButton();
    this.createPortfolioButton();
    this.createContactCTA();
    this.createPhotoButton();
    this.createSayHiButton();
    this.createCompletionButton();
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
  }

  /** Apply the current short-landscape state to reflowable HUD elements. */
  private applyResponsiveHud(): void {
    if (this.mapCanvas) {
      const short = this.shortLandscape;
      // Shrink the 172px disc to ~60% and raise it so its lower arc clears the
      // 🎤 button (bottom+198); portrait ('' + 40px) restores the tuned layout.
      this.mapCanvas.style.width = short ? '104px' : '';
      this.mapCanvas.style.height = 'auto';
      this.mapCanvas.style.top = short
        ? 'calc(var(--sat, 0px) + 8px)'
        : 'calc(var(--sat, 0px) + 40px)';
    }
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
  /** Brief auto-dismissing status toast (bottom-centre) — e.g. "Muted <name>". */
  public toast(message: string): void {
    if (!this.toastEl) {
      this.toastEl = document.createElement('div');
      // Bottom-centre lane, stacked so concurrent notices don't overlap:
      // chat-input 96 · interaction-prompt 100 · breath 150 · recording 200 ·
      // toast 250 (highest — it can co-occur with any of the others).
      Object.assign(this.toastEl.style, {
        position: 'absolute',
        left: '50%',
        bottom: 'calc(var(--sab, 0px) + 250px)',
        transform: 'translateX(-50%)',
        background: 'rgba(12,12,20,0.92)',
        color: '#fff',
        padding: '9px 16px',
        borderRadius: '12px',
        fontSize: '14px',
        fontFamily: 'system-ui, sans-serif',
        pointerEvents: 'none',
        zIndex: '1750',
        opacity: '0',
        transition: 'opacity 0.2s ease',
        whiteSpace: 'nowrap',
      });
      this.overlay.appendChild(this.toastEl);
    }
    this.toastEl.textContent = message;
    this.toastEl.style.opacity = '1';
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => {
      if (this.toastEl) this.toastEl.style.opacity = '0';
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
    if (!this.bulletinEl) {
      this.bulletinEl = document.createElement('div');
      Object.assign(this.bulletinEl.style, {
        position: 'absolute',
        left: '50%',
        top: 'calc(var(--sat, 0px) + 66px)',
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
    const modal = this.buildCenteredModal('min(360px, calc(100vw - 32px))');
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
    const modal = this.buildCenteredModal('min(380px, calc(100vw - 32px))');
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
    cta.addEventListener('click', () => modal.remove());
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
  private buildCenteredModal(width: string): HTMLElement {
    const modal = document.createElement('div');
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
    close.addEventListener('click', () => modal.remove());
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
    const modal = this.buildCenteredModal('min(360px, calc(100vw - 32px))');
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
    const modal = this.buildCenteredModal('min(360px, calc(100vw - 32px))');
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
    const modal = this.buildCenteredModal('min(400px, calc(100vw - 32px))');
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
    const modal = this.buildCenteredModal('min(420px, calc(100vw - 32px))');
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
    this.overlay.appendChild(btn);
  }

  private toggleEmoteWheel(): void {
    if (this.emoteWheel) {
      this.emoteWheel.remove();
      this.emoteWheel = null;
      return;
    }
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
      width: 'min(70vw, 420px)',
      padding: '10px 14px',
      borderRadius: '12px',
      border: 'none',
      fontSize: '15px',
      fontFamily: 'system-ui, sans-serif',
      background: 'rgba(12,12,20,0.92)',
      color: '#fff',
      outline: '2px solid rgba(120,170,255,0.9)',
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
    };
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
        width: 'min(86vw, 460px)',
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
          fontSize: '14px',
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
    el.classList.add('hud-btn');
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
    const data = this.journalProvider?.();
    if (!data) return;
    const modal = this.buildCenteredModal('min(430px, calc(100vw - 32px))');
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
       <div style="margin:14px 0 4px;font-size:13px;color:#ccd;font-weight:600;">🏁 Race bests</div>
       ${raceRows}
       <div style="display:flex;justify-content:space-between;margin-top:14px;padding-top:10px;border-top:1px solid rgba(255,255,255,0.12);font-size:13px;">
         <span style="color:#ccd;">🪙 Coins collected</span><span style="color:#ffd54a;font-weight:700;">${data.coins}</span></div>`,
    );
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
    this.muteBtn.textContent = muted ? '🔇' : '🔊';
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
      this.muteBtn.textContent = nowMuted ? '🔇' : '🔊';
      this.muteBtn.setAttribute('aria-pressed', String(nowMuted));
      // Tapping the button also surfaces the volume pill for a few seconds —
      // the only mobile path to the slider (no hover on touch).
      this.showVolumePill(3500);
    });
    this.makeHudButtonAccessible(this.muteBtn, 'Toggle all sound (music, effects, voices)', muted);
    this.overlay.appendChild(this.muteBtn);
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
    this.overlay.appendChild(btn);
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
    this.overlay.appendChild(btn);
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
    this.overlay.appendChild(btn);
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
    this.overlay.appendChild(btn);
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
    this.makeHudButtonAccessible(btn, 'Take a photo of the island');
    this.overlay.appendChild(btn);
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
    const cap = document.createElement('div');
    Object.assign(cap.style, {
      position: 'absolute',
      left: '50%',
      bottom: 'calc(var(--sab, 0px) + 46px)',
      transform: 'translateX(-50%)',
      maxWidth: 'min(620px, calc(100vw - 40px))',
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
    this.tourCaptionDiv?.remove();
    this.tourCaptionDiv = null;
    this.tourSkipBtn?.remove();
    this.tourSkipBtn = null;
    if (this.tourEscHandler) {
      document.removeEventListener('keydown', this.tourEscHandler);
      this.tourEscHandler = null;
    }
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
    this.overlay.appendChild(btn);
  }

  showSayHi(): void {
    const modal = this.buildCenteredModal('min(360px, calc(100vw - 32px))');
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
          window.setTimeout(() => modal.remove(), 2200);
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
    this.overlay.appendChild(btn);
    this.completionBtn = btn;
  }

  /** App-computed progress: percentage + the checklist items behind it. */
  public setCompletion(
    pct: number,
    items: Array<{ icon: string; label: string; done: boolean; hint: string }>,
  ): void {
    this.completionPct = pct;
    this.completionItems = items;
    if (this.completionBtn) this.completionBtn.textContent = `🏝 ${pct}%`;
  }

  showCompletionModal(): void {
    const modal = this.buildCenteredModal('min(390px, calc(100vw - 32px))');
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
       <div style="max-height:56vh;overflow:auto;">${rows}</div>`,
    );
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
    const modal = this.buildCenteredModal('min(440px, calc(100vw - 32px))');
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
    Object.assign(pill.style, {
      position: 'absolute',
      bottom: 'calc(var(--sab, 0px) + 64px)',
      left: '50%',
      transform: 'translateX(-50%)',
      background: 'rgba(10, 14, 30, 0.82)',
      border: '1px solid rgba(140,160,255,0.4)',
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
      return;
    }
    trackOnce('portfolio_opened');
    this.hideZonePanel();
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
    ) => {
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
        border: '2px solid rgba(255,255,255,0.4)',
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
          btn.style.filter = 'brightness(1.35)';
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
    };
    // Stacked bottom-right: interact (primary, lowest for thumb reach),
    // jump/swim (hold), wave.
    makeButton('👆', 'USE', '36px', 'KeyE', 'e', 'rgba(80,150,90,0.5)');
    makeButton('⤒', 'JUMP', '124px', 'Space', ' ', 'rgba(70,120,190,0.5)');
    makeButton('👋', 'WAVE', '212px', 'KeyQ', 'q', 'rgba(160,120,60,0.5)');
    // FEED goes in a SECOND COLUMN beside USE rather than extending the stack
    // to 374px: on a short landscape phone (the UI explicitly supports
    // max-height 500px) a 4th row would sit over the coin chip and the icon
    // row, and unlike those chips it captures taps.
    makeButton('🌾', 'FEED', '36px', 'KeyF', 'f', 'rgba(150,130,70,0.5)', 112);

    // Proximity chat: 💬 opens the text input, 🎤 is press-hold-to-talk.
    // Stacked above the joystick (which spans bottom 26–136px here) so
    // neither control overlaps it.
    const chatBtn = document.createElement('div');
    chatBtn.textContent = '💬';
    Object.assign(chatBtn.style, {
      position: 'absolute',
      left: 'calc(var(--sal, 0px) + 26px)',
      bottom: 'calc(var(--sab, 0px) + 152px)',
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

    const micBtn = document.createElement('div');
    this.micBtn = micBtn;
    micBtn.textContent = '🎤';
    Object.assign(micBtn.style, {
      position: 'absolute',
      left: 'calc(var(--sal, 0px) + 26px)',
      bottom: 'calc(var(--sab, 0px) + 198px)',
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
                 box-shadow:0 0 34px rgba(80,170,220,0.45), inset -8px -10px 20px rgba(0,0,0,0.45);
                 will-change:transform;animation:ld-pulse 2.6s ease-in-out infinite;"></div>
            <div style="position:absolute;inset:0;will-change:transform;animation:ld-spin 1.8s linear infinite;">
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
        padding: '30px',
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
      this.overlay.appendChild(this.welcomeDiv);
    }

    trackOnce('welcome_shown');

    // Returning visitors get a brief hello; first-timers get the pitch + CTAs.
    const returning = localStorage.getItem('ds_welcomed') === '1';
    const controlsLine = this.isTouch
      ? 'Drag the joystick to move · 👆 USE to interact · ⤒ JUMP (hold to swim) · 👋 WAVE.'
      : 'WASD to move · mouse to look · space to jump · Q to wave.';

    // Three CTAs: the work, the contact path, and the differentiator — meeting
    // the live-AI townsfolk (guided; no competitor portfolio has them). A
    // recruiter who won't explore still reaches everything in one click.
    const ctaRow = `
      <div style="display:flex; gap:10px; flex-wrap:wrap; justify-content:center; margin:0 0 10px;">
        <button data-cta="projects" style="flex:1 1 140px; padding:12px 14px; border:none; border-radius:10px;
          background:linear-gradient(135deg,#5b6cff,#8a4de0); color:#fff; font-size:15px; font-weight:600; cursor:pointer;">
          🚀 See the work</button>
        <button data-cta="contact" style="flex:1 1 140px; padding:12px 14px; border-radius:10px;
          background:rgba(38,38,51,0.5); color:#fff; border:1px solid rgba(255,255,255,0.18); font-size:15px; font-weight:600; cursor:pointer;">
          📬 Get in touch</button>
      </div>
      <button data-meet-ai="1" style="width:100%; padding:11px 14px; margin:0 0 16px; border-radius:10px;
        background:rgba(38,38,51,0.5); color:#fff; border:1px solid rgba(255,212,121,0.45); font-size:14.5px; font-weight:600; cursor:pointer;">
        🤖 Meet the AI townsfolk</button>`;

    // Explicit dismiss button so the pitch stays put until the visitor chooses
    // to leave it (moving with WASD no longer evaporates it).
    const exploreBtn = `
      <button data-dismiss="1" style="width:100%; padding:11px 14px; margin:0 0 12px; border:none; border-radius:10px;
        background:linear-gradient(135deg,#12b76a,#0e9f6e); color:#fff; font-size:15px; font-weight:700; cursor:pointer;">
        🧭 Explore the island →</button>`;

    // Secondary row: the guided 90-second camera tour (for the recruiter who
    // won't touch WASD) and the race CTA (analyst issue #6 — the circuits were
    // invisible unless you stumbled into a gate).
    const secondaryRow = `
      <div style="display:flex; gap:8px; margin:0 0 12px;">
        <button data-tour="1" style="flex:1; padding:9px 10px; border-radius:10px;
          background:rgba(38,38,51,0.5); color:#dfe6f2; border:1px solid rgba(255,255,255,0.16); font-size:13px; cursor:pointer;">
          🎬 90-second tour</button>
        <button data-race="1" style="flex:1; padding:9px 10px; border-radius:10px;
          background:rgba(38,38,51,0.5); color:#dfe6f2; border:1px solid rgba(255,255,255,0.16); font-size:13px; cursor:pointer;">
          🏁 Beat the lap record</button>
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
        I'm <strong>Abbas</strong> — I build AI-powered products. This is my portfolio,
        hand-built in Three.js, that you can actually walk through.</p>
      <p style="margin: 0 0 16px 0; font-size:13.5px; line-height:1.5; color:#cdd6e4;">
        Every townsperson is a <strong>live AI agent</strong> — an AI planner assigns their
        jobs each morning, and an AI analyst reports on the island nightly.
        Walk up and ask them anything.</p>
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
    this.welcomeDiv.querySelector('button[data-race]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      track('welcome_cta', { cta: 'race' });
      closeWelcome();
      this.onRaceGuide?.();
    });

    document.addEventListener('keydown', onEscape);
    // The delta card earns a longer look; the plain welcome-back stays snappy.
    if (returning) window.setTimeout(closeWelcome, awayDelta ? 5600 : 2600);
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
      try {
        localStorage.setItem('ds_welcomed', '1');
      } catch {
        /* full welcome every visit */
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
      padding: '12px 16px',
      fontSize: '18px',
      borderRadius: '12px',
      border: '2px solid rgba(120,160,255,0.5)',
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
  showInteractionPrompt(text: string): void {
    if (!this.interactionDiv) {
      this.interactionDiv = document.createElement('div');
      Object.assign(this.interactionDiv.style, {
        position: 'absolute',
        // Clear the touch buttons / home indicator on phones
        bottom: 'calc(var(--sab, 0px) + 100px)',
        left: '50%',
        maxWidth: 'calc(100vw - 32px)',
        background: 'rgba(0, 0, 0, 0.8)',
        color: 'white',
        padding: '15px 25px',
        borderRadius: '25px',
        textAlign: 'center',
        pointerEvents: 'auto',
        cursor: 'pointer',
        fontSize: '16px',
        // Pop-in: created hidden/short, springs to place on the next frame
        opacity: '0',
        transform: 'translateX(-50%) translateY(10px) scale(0.9)',
        transition: 'transform 0.16s cubic-bezier(0.34, 1.56, 0.64, 1), opacity 0.16s ease',
      });
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
    this.overlay.appendChild(this.playerCountDiv);
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
    const modal = this.buildCenteredModal('min(340px, calc(100vw - 32px))');
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
    const D = 172; // square canvas (the radar disc)
    if (!this.mapCanvas) {
      this.mapCanvas = document.createElement('canvas');
      this.mapCanvas.width = D;
      this.mapCanvas.height = D;
      Object.assign(this.mapCanvas.style, {
        position: 'absolute',
        top: 'calc(var(--sat, 0px) + 40px)',
        left: 'calc(var(--sal, 0px) + 10px)',
        maxWidth: 'calc(100vw - var(--sal, 0px) - var(--sar, 0px) - 20px)',
        height: 'auto',
        borderRadius: '50%',
        border: '2px solid rgba(255,255,255,0.28)',
        boxShadow: '0 6px 18px rgba(0,0,0,0.4)',
        pointerEvents: 'none',
      });
      this.overlay.appendChild(this.mapCanvas);
      // A canvas created while already in short-landscape must adopt the
      // shrunk layout immediately (the media listener only fires on changes).
      this.applyResponsiveHud();
    }
    const ctx = this.mapCanvas.getContext('2d');
    if (!ctx) return;
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
    for (const z of data.zones) {
      const p = place(z);
      if (p.edge) {
        ctx.fillStyle = z.color;
        ctx.globalAlpha = 0.6;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 2.4, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
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
        ctx.strokeStyle = `rgba(255, 211, 74, ${0.35 + 0.25 * Math.sin(t / 260)})`;
        ctx.beginPath();
        ctx.arc(x, y, 5 + 1.2 * Math.sin(t / 260), 0, Math.PI * 2);
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
        const pulse = 3 + Math.sin(t / 250) * 1.4;
        ctx.strokeStyle = `rgba(255, 82, 82, ${0.5 + 0.3 * Math.sin(t / 250)})`;
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
  showShop(
    state: {
      coins: number;
      items: Array<{
        id: string;
        icon: string;
        name: string;
        price: number;
        // Hats are owned once and equipped; consumables are re-buyable and
        // report how many charges the player is carrying.
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
      border: '2px solid rgba(255, 211, 74, 0.5)',
      padding: '18px 20px',
      pointerEvents: 'auto',
      zIndex: '1700',
      fontFamily: 'system-ui, sans-serif',
    });
    const rows = state.items
      .map((it) => {
        const btnLabel = it.consumable
          ? `${it.price} 🪙`
          : it.equipped
            ? 'Equipped'
            : it.owned
              ? 'Equip'
              : `${it.price} 🪙`;
        const disabled = it.consumable
          ? state.coins < it.price
          : !!it.equipped || (!it.owned && state.coins < it.price);
        const sub = it.consumable
          ? `${it.price} coins · ${it.charges} throws${it.held ? ` · carrying ${it.held}` : ''}`
          : it.owned
            ? 'Owned'
            : `${it.price} coins`;
        return `
        <div style="display:flex;align-items:center;gap:12px;padding:9px 0;border-bottom:1px solid rgba(255,255,255,0.08);">
          <div style="font-size:24px;">${it.icon}</div>
          <div style="flex:1;">
            <div style="font-weight:600;">${it.name}</div>
            <div style="font-size:12px;color:#aaa;">${sub}</div>
          </div>
          <button data-shop-id="${it.id}" ${disabled ? 'disabled' : ''} style="
            background:${it.equipped ? '#2e7d32' : '#ffd34a'};
            color:${it.equipped ? 'white' : '#332200'};
            border:none;padding:10px 16px;border-radius:8px;font-weight:700;min-height:40px;
            cursor:${disabled ? 'default' : 'pointer'};opacity:${disabled && !it.equipped ? 0.45 : 1};
          ">${btnLabel}</button>
        </div>`;
      })
      .join('');
    this.shopDiv.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
        <h3 style="margin:0;color:#ffd34a;">🛒 Island Shop</h3>
        <div style="display:flex;gap:12px;align-items:center;">
          <span style="color:#ffd34a;font-weight:700;">🪙 ${state.coins}</span>
          <span id="shop-close" style="cursor:pointer;font-size:18px;padding:2px 8px;">✕</span>
        </div>
      </div>
      <div style="font-size:12px;color:#9ab;margin-bottom:6px;">Hats for the well-dressed courier. Purchases persist.</div>
      ${rows}
    `;
    this.overlay.appendChild(this.shopDiv);
    this.shopDiv.querySelectorAll('button[data-shop-id]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = (btn as HTMLElement).getAttribute('data-shop-id');
        if (id) onAction(id);
      });
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
      this.overlay.appendChild(this.coinDiv);
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
  updateFeedCounters(bird: number, cat: number, fish: number): void {
    const total = bird + cat + fish;
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
      this.overlay.appendChild(this.feedDiv);
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
    this.feedDiv.style.display = 'block';
    this.feedDiv.textContent = `${parts.join('  ')}  ·  F to feed`;
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

  /** Brief centred splash message (used for the drown/rescue). */
  flashMessage(text: string): void {
    const el = document.createElement('div');
    el.textContent = text;
    Object.assign(el.style, {
      position: 'absolute',
      top: '38%',
      left: '50%',
      transform: 'translate(-50%, -50%) scale(0.9)',
      background: 'rgba(0,0,0,0.78)',
      color: 'white',
      padding: '14px 22px',
      borderRadius: '14px',
      fontSize: '18px',
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
      window.setTimeout(() => el.remove(), 300);
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
      padding: '20px 30px',
      borderRadius: '15px',
      textAlign: 'center',
      pointerEvents: 'none',
      fontSize: '18px',
      border: '2px solid #4CAF50',
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
        pointerEvents: 'none',
        fontFamily: 'sans-serif',
      });
      this.compassArrow = document.createElement('div');
      this.compassArrow.textContent = '\u27A4';
      Object.assign(this.compassArrow.style, {
        fontSize: '20px',
        color: '#ffd54a',
        transition: 'transform 0.12s linear',
        transformOrigin: '50% 50%',
      });
      this.compassLabel = document.createElement('div');
      Object.assign(this.compassLabel.style, {
        color: 'white',
        fontSize: '13px',
        whiteSpace: 'nowrap',
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
      // Narrow screens: drop the label (the arrow already shows direction),
      // keep only the distance so the centered pill stays compact and clear
      // of the top-left env badge.
      const compact = window.innerWidth < 480;
      this.compassLabel.textContent = compact
        ? `${Math.round(state.distance)}m`
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
      padding: '30px',
      borderRadius: '15px',
      textAlign: 'center',
      pointerEvents: 'auto',
      fontSize: '16px',
      zIndex: '1500',
      border: `3px solid ${this.getZoneColor(zone.id)}`,
      maxWidth: '500px',
      maxHeight: '70vh',
      overflowY: 'auto',
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
      this.zonePanelDiv.remove();
      this.zonePanelDiv = null;
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
    const reduce = a11y.reducedMotion; // respect reduced-motion: no typewriter
    const panel = document.createElement('div');
    Object.assign(panel.style, {
      position: 'absolute',
      left: '50%',
      bottom: '28px',
      transform: 'translateX(-50%)',
      width: 'min(560px, 92%)',
      background: 'rgba(10,10,20,0.94)',
      color: '#f0f0f0',
      borderRadius: '16px',
      border: '2px solid rgba(120,160,255,0.4)',
      boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
      zIndex: '1620',
      fontFamily: 'system-ui, sans-serif',
      overflow: 'hidden',
      pointerEvents: 'auto',
    });
    const header = document.createElement('div');
    Object.assign(header.style, {
      padding: '8px 16px',
      fontWeight: '600',
      background: 'linear-gradient(135deg, rgba(80,130,255,0.3), rgba(120,80,255,0.2))',
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
      if (reduce) {
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
      fontSize: '15px',
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
    // Expose this panel's NPC-line appender so the app can deepen the opening
    // in the background (composed greeting → generated continuation).
    this.npcChatAppend = { name, npcLine };
    window.setTimeout(() => input.focus(), 50);
  }

  private npcChatAppend: { name: string; npcLine: (text: string) => void } | null = null;

  /** Append an NPC-side line to the OPEN chat panel for `name` (typewriter +
   *  voice, same as a reply). No-ops if the panel closed or switched NPCs —
   *  a late background continuation must never resurrect a dismissed chat. */
  public appendNpcChatLine(name: string, text: string): void {
    if (this.npcChatDiv && this.npcChatAppend?.name === name) {
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
    if (div) div.remove();
  }

  public isNpcChatOpen(): boolean {
    return !!this.npcChatDiv;
  }

  showDialogue(name: string, lines: string[]): void {
    this.dialogueLines = lines;
    this.dialogueIndex = 0;
    this.dialogueActive = true;

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
            width: 'min(600px, 90%)',
            bottom: '30px',
          };
      Object.assign(this.dialogueDiv.style, {
        position: 'absolute',
        background: 'rgba(10, 10, 20, 0.92)',
        color: '#f0f0f0',
        padding: '0',
        borderRadius: '16px',
        pointerEvents: 'auto',
        fontSize: '16px',
        border: '2px solid rgba(120, 160, 255, 0.4)',
        boxShadow: '0 8px 32px rgba(0, 0, 0, 0.5), inset 0 1px 0 rgba(255, 255, 255, 0.05)',
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
        background: linear-gradient(135deg, rgba(80, 130, 255, 0.3), rgba(120, 80, 255, 0.2));
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
    this.typewriterPos = 0;
    if (this.typewriterTimer) cancelAnimationFrame(this.typewriterTimer);
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
