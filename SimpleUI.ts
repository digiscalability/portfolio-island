import { a11y } from './Accessibility';
import { linkLabel, markReachedPortfolio, track, trackOnce } from './Analytics';
import { VOICE_MAX_MS } from './Chat';
import { checkName } from './Moderation';
import { Passport, PASSPORT_META, PASSPORT_ZONES, type PassportZone } from './Passport';

/**
 * SimpleUI - Simplified UI manager for the basic app
 * Handles loading screen, welcome message, interaction prompts, and FPS display
 */
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
    this.createTouchControls();
  }

  // ── UX chrome ─────────────────────────────────────────────────────────

  private muteBtn: HTMLElement | null = null;
  private onMuteToggle: (() => boolean) | null = null;
  private joyState = { forward: 0, strafe: 0 };

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
  private onChatSend: ((text: string) => void) | null = null;
  private onMicDown: (() => void) | null = null;
  private onMicUp: (() => void) | null = null;
  private micBtn: HTMLElement | null = null;

  public isChatInputOpen(): boolean { return this.chatInput !== null; }
  public setOnChatSend(cb: (text: string) => void): void { this.onChatSend = cb; }
  public setOnMicDown(cb: () => void): void { this.onMicDown = cb; }
  public setOnMicUp(cb: () => void): void { this.onMicUp = cb; }

  private toastEl: HTMLDivElement | null = null;
  private toastTimer = 0;
  /** Brief auto-dismissing status toast (bottom-centre) — e.g. "Muted <name>". */
  public toast(message: string): void {
    if (!this.toastEl) {
      this.toastEl = document.createElement('div');
      Object.assign(this.toastEl.style, {
        position: 'absolute', left: '50%', bottom: 'calc(var(--sab, 0px) + 150px)',
        transform: 'translateX(-50%)', background: 'rgba(12,12,20,0.92)', color: '#fff',
        padding: '9px 16px', borderRadius: '12px', fontSize: '14px',
        fontFamily: 'system-ui, sans-serif', pointerEvents: 'none', zIndex: '1750',
        opacity: '0', transition: 'opacity 0.2s ease', whiteSpace: 'nowrap',
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

  /** Hide the mobile 🎤 button where voice can't work (e.g. iOS Safari, where
   *  MediaRecorder doesn't support opus) — text chat still works there.
   *  Defaults visible; call once Chat.voiceSupported is known. */
  public setVoiceSupported(supported: boolean): void {
    if (this.micBtn) this.micBtn.style.display = supported ? '' : 'none';
  }

  /** Open the one-line chat input (Enter sends, Esc/blur cancels). */
  public openChatInput(): void {
    if (this.chatInput) { this.chatInput.focus(); return; }
    const input = document.createElement('input');
    input.type = 'text';
    input.maxLength = 120;
    input.setAttribute('aria-label', 'Type a message to nearby players');
    input.placeholder = 'Say something…';
    Object.assign(input.style, {
      position: 'absolute',
      left: '50%', bottom: 'calc(var(--sab, 0px) + 96px)', transform: 'translateX(-50%)',
      width: 'min(70vw, 420px)', padding: '10px 14px', borderRadius: '12px',
      border: 'none', fontSize: '15px', fontFamily: 'system-ui, sans-serif',
      background: 'rgba(12,12,20,0.92)', color: '#fff', outline: '2px solid rgba(120,170,255,0.9)',
      pointerEvents: 'auto', zIndex: '1700',
    });
    // Quick-phrase chips (touch only): sending a canned greeting without a
    // keyboard, which is otherwise painful to do over a full-screen 3D canvas.
    let chipsRow: HTMLElement | null = null;

    const close = () => {
      // Idempotent: removing the focused input fires `blur`, whose handler also
      // calls close() — guard so the second call doesn't double-remove (which
      // throws NotFoundError). Null the ref first, then detach.
      if (this.chatInput !== input) return;
      this.chatInput = null;
      input.remove();
      chipsRow?.remove();
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation(); // critical: don't leak movement/hotkeys to the game while typing
      if (e.key === 'Enter') { const t = input.value; close(); if (t.trim()) this.onChatSend?.(t); }
      else if (e.key === 'Escape') close();
    });
    input.addEventListener('blur', close);
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
          close();
          this.onChatSend?.(phrase);
        });
        chipsRow!.appendChild(chip);
      });
      this.overlay.appendChild(chipsRow);
    }

    this.chatInput = input;
    input.focus();
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

  private createMuteButton(): void {
    this.muteBtn = document.createElement('div');
    let muted = false;
    try {
      muted = !!JSON.parse(localStorage.getItem('ds_audio_settings') ?? '{}').muted;
    } catch {
      /* default unmuted */
    }
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
      this.muteBtn.textContent = nowMuted ? '🔇' : '🔊';
      this.muteBtn.setAttribute('aria-pressed', String(nowMuted));
    });
    this.makeHudButtonAccessible(this.muteBtn, 'Toggle sound', muted);
    this.overlay.appendChild(this.muteBtn);
    this.createReducedMotionButton();
    this.createCustomizeButton();
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
      top: 'calc(var(--sat, 0px) + 10px)',
      left: '50%',
      transform: 'translateX(-50%)',
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
      this.showZonePanel({ id: 'contact', name: 'contact' });
    });
    this.makeHudButtonAccessible(btn, 'Work with me — open contact');
    this.overlay.appendChild(btn);
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
      ${rows}`;
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

    // Joystick
    const base = document.createElement('div');
    Object.assign(base.style, {
      position: 'absolute',
      left: 'calc(var(--sal, 0px) + 26px)',
      bottom: 'calc(var(--sab, 0px) + 26px)',
      width: '110px',
      height: '110px',
      borderRadius: '50%',
      background: 'rgba(255,255,255,0.12)',
      border: '2px solid rgba(255,255,255,0.25)',
      pointerEvents: 'auto',
      touchAction: 'none',
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
    this.overlay.appendChild(base);

    const moveThumb = (dx: number, dy: number) => {
      thumb.style.left = `${31 + dx}px`;
      thumb.style.top = `${31 + dy}px`;
    };
    const handleTouch = (e: TouchEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const rect = base.getBoundingClientRect();
      const t = e.touches[0];
      let dx = t.clientX - (rect.left + rect.width / 2);
      let dy = t.clientY - (rect.top + rect.height / 2);
      const len = Math.hypot(dx, dy);
      const max = 40;
      if (len > max) {
        dx = (dx / len) * max;
        dy = (dy / len) * max;
      }
      moveThumb(dx, dy);
      this.joyState.strafe = dx / max;
      this.joyState.forward = -dy / max;
    };
    base.addEventListener('touchstart', handleTouch, { passive: false });
    base.addEventListener('touchmove', handleTouch, { passive: false });
    base.addEventListener('touchend', (e) => {
      e.stopPropagation();
      this.joyState.forward = 0;
      this.joyState.strafe = 0;
      moveThumb(0, 0);
    });

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
    ) => {
      const btn = document.createElement('div');
      btn.innerHTML =
        `<div style="font-size:24px;line-height:1;">${icon}</div>` +
        `<div style="font-size:10px;font-weight:700;letter-spacing:1px;margin-top:2px;opacity:0.9;">${caption}</div>`;
      Object.assign(btn.style, {
        position: 'absolute',
        right: 'calc(var(--sar, 0px) + 26px)',
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
      const fire = (type: 'keydown' | 'keyup') => {
        const ev = new KeyboardEvent(type, { code, key, bubbles: true });
        window.dispatchEvent(ev);
        document.dispatchEvent(ev);
      };
      btn.addEventListener('touchstart', (e) => {
        e.preventDefault();
        e.stopPropagation();
        btn.style.transform = 'scale(0.9)';
        btn.style.filter = 'brightness(1.35)';
        fire('keydown');
      }, { passive: false });
      const release = (e: Event) => {
        e.stopPropagation();
        btn.style.transform = 'scale(1)';
        btn.style.filter = 'none';
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
    chatBtn.addEventListener('click', (e) => { e.stopPropagation(); this.openChatInput(); });
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
    const micDown = (e: Event) => { e.preventDefault(); this.onMicDown?.(); };
    const micUp = (e: Event) => { e.preventDefault(); this.onMicUp?.(); };
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
      if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) { e.preventDefault(); this.onMicDown?.(); }
    });
    micBtn.addEventListener('keyup', (e) => {
      if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); this.onMicUp?.(); }
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
      this.loadingDiv.innerHTML = `
        <div style="display:flex;flex-direction:column;align-items:center;max-width:320px;padding:0 24px;">
          <div id="ld-planet" style="width:76px;height:76px;border-radius:50%;
               background:radial-gradient(circle at 34% 30%, #7fc96b 0 38%, #4e9e57 38% 52%, #2f7fbf 52% 100%);
               box-shadow:0 0 34px rgba(80,170,220,0.45), inset -8px -10px 20px rgba(0,0,0,0.45);
               margin-bottom:20px;"></div>
          <div style="font-family:'Bebas Neue',system-ui,sans-serif;font-size:25px;letter-spacing:1.5px;">
            DIGISCALABILITY LIFE ISLAND</div>
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
        this.loadingTarget < 55 ? 'Waking the island…'
        : this.loadingTarget < 90 ? 'Raising the mountains and filling the sea…'
        : this.loadingTarget < 100 ? 'Planting trees and lighting the lamps…'
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
  showWelcome(): void {
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

    // Two CTAs route straight to the real portfolio content, so a recruiter who
    // won't explore still reaches the work and the contact links in one click.
    const ctaRow = `
      <div style="display:flex; gap:10px; flex-wrap:wrap; justify-content:center; margin:0 0 16px;">
        <button data-cta="projects" style="flex:1 1 140px; padding:12px 14px; border:none; border-radius:10px;
          background:linear-gradient(135deg,#5b6cff,#8a4de0); color:#fff; font-size:15px; font-weight:600; cursor:pointer;">
          🚀 See the work</button>
        <button data-cta="contact" style="flex:1 1 140px; padding:12px 14px; border-radius:10px;
          background:rgba(38,38,51,0.5); color:#fff; border:1px solid rgba(255,255,255,0.18); font-size:15px; font-weight:600; cursor:pointer;">
          📬 Get in touch</button>
      </div>`;

    this.welcomeDiv.innerHTML = returning
      ? `<h2 style="margin: 0 0 14px 0; color: #4CAF50;">👋 Welcome back!</h2>
         ${ctaRow}
         <p style="margin:0; font-size:12px; color:#9aa;">…or press any key to keep exploring.</p>`
      : `
      <h2 style="margin: 0 0 8px 0; color: #4CAF50;">DigiScalability Life Island</h2>
      <p style="margin: 0 0 18px 0; font-size:15px; line-height:1.5;">
        I'm <strong>Abbas</strong> — I build AI-powered products. This is my portfolio,
        hand-built in Three.js, that you can actually walk through.</p>
      ${ctaRow}
      <p style="margin: 0 0 6px 0; font-size: 12px; color: #9aa;">${controlsLine}</p>
      <p style="margin: 0; font-size: 12px; color: #7fbf8a;">…or just start exploring — press any key.</p>
    `;

    // CTA buttons: track, navigate to the section, then dismiss. stopPropagation
    // so the outside-click dismiss below doesn't double-fire.
    this.welcomeDiv.querySelectorAll('button[data-cta]').forEach((b) => {
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        const cta = (b as HTMLElement).dataset.cta!;
        track('welcome_cta', { cta });
        this.hideWelcome();
        this.showZonePanel({ id: cta, name: cta });
      });
    });

    // Dismiss on any key ("start exploring") or a click OUTSIDE the modal.
    // Two exemptions: keyboard activation of a focused CTA (Enter/Space) and
    // clicks landing inside the modal — both must reach the CTA handler first.
    const hideWelcome = (ev?: Event) => {
      if (ev?.type === 'keydown' && ev.target instanceof HTMLButtonElement) return;
      if (
        ev?.type === 'click' &&
        ev.target instanceof Node &&
        this.welcomeDiv?.contains(ev.target)
      )
        return;
      this.hideWelcome();
      document.removeEventListener('keydown', hideWelcome);
      document.removeEventListener('click', hideWelcome);
    };
    document.addEventListener('keydown', hideWelcome);
    document.addEventListener('click', hideWelcome);
    if (returning) window.setTimeout(hideWelcome, 2600);
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
        bottom: 'calc(var(--sab, 0px) + 96px)',
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
    modal.appendChild(input);
    modal.appendChild(btn);
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
        fontSize: '16px',
        // Pop-in: created hidden/short, springs to place on the next frame
        opacity: '0',
        transform: 'translateX(-50%) translateY(10px) scale(0.9)',
        transition: 'transform 0.16s cubic-bezier(0.34, 1.56, 0.64, 1), opacity 0.16s ease',
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
      pointerEvents: 'none',
    });
    this.overlay.appendChild(this.playerCountDiv);
    this.updatePlayerCount(1); // Start with 1 (self)
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
      items: Array<{ id: string; icon: string; name: string; price: number; owned: boolean; equipped: boolean }>;
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
        const btnLabel = it.equipped ? 'Equipped' : it.owned ? 'Equip' : `${it.price} 🪙`;
        const disabled = it.equipped || (!it.owned && state.coins < it.price);
        return `
        <div style="display:flex;align-items:center;gap:12px;padding:9px 0;border-bottom:1px solid rgba(255,255,255,0.08);">
          <div style="font-size:24px;">${it.icon}</div>
          <div style="flex:1;">
            <div style="font-weight:600;">${it.name}</div>
            <div style="font-size:12px;color:#aaa;">${it.owned ? 'Owned' : `${it.price} coins`}</div>
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
    const escHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        this.hideShop();
        onClose();
        document.removeEventListener('keydown', escHandler);
      }
    };
    document.addEventListener('keydown', escHandler);
  }

  hideShop(): void {
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
        bottom: 'calc(var(--sab, 0px) + 20px)',
        left: 'calc(var(--sal, 0px) + 20px)',
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

  showZonePanel(zone: any): void {
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

    // Funnel: which sections a visitor actually reaches, and the outbound
    // clicks that are the real conversion. Once-per-session so re-opening the
    // same panel doesn't inflate the numbers.
    const zid = String(zone?.id ?? 'unknown');
    trackOnce('zone_explored', { zone: zid });
    // "Reached the actual work" = any real section, not the intro or an unknown.
    if (zid !== 'welcome' && zid !== 'unknown') {
      markReachedPortfolio();
      trackOnce('reached_portfolio', { first: zid });
    }
    if (zone?.id === 'contact') trackOnce('contact_opened');

    // Passport: stamp this zone. A new stamp shows brief progress; the fourth
    // triggers the reward flow via the onComplete callback wired in main-simple.
    if (this.passport?.visit(zid)) {
      trackOnce('passport_stamp', { zone: zid, count: this.passport.count() });
      if (!this.passport.isComplete()) {
        const meta = PASSPORT_META[zid as PassportZone];
        this.toast(`🛂 Passport stamped: ${meta.label} (${this.passport.count()}/${this.passport.total()})`);
      }
    }
    // Delegated: catches every link in the panel without touching the markup
    this.zonePanelDiv.addEventListener('click', (e) => {
      const a = (e.target as HTMLElement)?.closest?.('a');
      if (a instanceof HTMLAnchorElement && a.href) {
        track('external_link', { to: linkLabel(a.href), from: String(zone?.id ?? 'unknown') });
      }
    });

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
    }
  }

  /**
   * Get color for zone
   */
  private getZoneColor(zoneId: string): string {
    const colors: { [key: string]: string } = {
      welcome: '#4CAF50',
      professional: '#2196F3',
      projects: '#FF9800',
      personal: '#E91E63',
      contact: '#9C27B0',
    };
    return colors[zoneId] || '#666';
  }

  /**
   * Get content for zone
   */
  private getZoneContent(zone: any): string {
    // Shared button styles for the clickable portfolio links. Links are the
    // owner's own curated URLs (a visitor chooses to click), opened in a new
    // tab with rel=noopener — the portfolio's whole point is to be actionable.
    const link = (
      href: string,
      label: string,
      opts: { primary?: boolean } = {},
    ): string => {
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

    const contents: { [key: string]: string } = {
      welcome: `
        <h2 style="margin-top: 0; color: #4CAF50;">🏠 Welcome to the DigiScalability World</h2>
        <p><strong>DigiScalability</strong> is a Melbourne-based venture studio building
        AI-powered products — and this island is its living 3D portfolio.</p>
        <p style="text-align:left;">Walk the planet to explore:</p>
        <ul style="text-align: left; display: inline-block; line-height:1.7;">
          <li><strong>Professional</strong> — the builder behind the studio</li>
          <li><strong>Projects</strong> — RankPilot, ChocoMate, and more</li>
          <li><strong>Personal</strong> — food, family recipes, creative tools</li>
          <li><strong>Get In Touch</strong> — work with DigiScalability</li>
        </ul>
        <p style="margin-top: 18px; font-size:14px; color:#bbb;"><em>WASD to move, mouse to
        look, E to interact. Swim, and drive the boats, jetskis &amp; cars around the island.</em></p>
      `,
      professional: `
        <h2 style="margin-top: 0; color: #2196F3;">💼 Professional</h2>
        <p>Abbas Ali — solo founder &amp; full-stack AI builder. Day job in tech,
        a venture studio after hours, hospitality-management roots, CS degree with an
        MIT (Deakin) nearly done.</p>
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
        <div style="text-align: left;">
          <h3 style="margin-bottom:4px;">📈 RankPilot <span style="font-size:12px;color:#8f8;">● live</span></h3>
          <p style="margin-top:4px;">Flagship — AI-powered SEO &amp; search-visibility
          platform. Audits, schema, and LLM-readiness for the answer-engine era.</p>
          ${link('https://rankpilot-h3jpc.web.app', '↗ Visit RankPilot', { primary: true })}
          <h3 style="margin-bottom:4px;margin-top:22px;">🍫 ChocoMate</h3>
          <p style="margin-top:4px;">Direct-to-consumer chocolate brand — e-commerce
          build, brand, and content pipeline.</p>
          ${link('https://chocomate.au', '↗ chocomate.au')}
          <h3 style="margin-bottom:4px;margin-top:22px;">🌐 DigiScalability</h3>
          <p style="margin-top:4px;">The studio itself — services, case studies, and
          the SEO/LLM-visibility practice behind RankPilot.</p>
          ${link('https://digiscalability.com', '↗ digiscalability.com')}
          <h3 style="margin-bottom:4px;margin-top:22px;">📖 Bano's Cookbook &amp; more</h3>
          <p style="margin-top:4px;">Digitising a family's 1981 handwritten recipes;
          a services marketplace (Insta Services); and this Three.js island world.</p>
          ${link('https://github.com/digiscalability', '💻 See more on GitHub')}
        </div>
      `,
      personal: `
        <h2 style="margin-top: 0; color: #E91E63;">🎨 Personal</h2>
        <p>Melbourne, Australia. Builder by day and night — but not only of software.</p>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 18px; margin: 18px 0; text-align:left;">
          <div><h3 style="margin:0 0 4px;">🍽️ Food Ventures</h3>
            <p style="font-size:14px;">Hospitality roots; kitchen-to-market concepts from
            steak frites to desserts.</p></div>
          <div><h3 style="margin:0 0 4px;">👵 Family Heritage</h3>
            <p style="font-size:14px;">Preserving handwritten family recipes from 1981 —
            the heart behind Bano's Cookbook.</p></div>
          <div><h3 style="margin:0 0 4px;">🎬 Creative Tooling</h3>
            <p style="font-size:14px;">Blender, DaVinci Resolve, ComfyUI — a full studio
            for product storytelling.</p></div>
          <div><h3 style="margin:0 0 4px;">📚 Always Learning</h3>
            <p style="font-size:14px;">A CS degree, a Masters of IT nearly done, and a
            new experiment every week.</p></div>
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
  showDialogue(name: string, lines: string[]): void {
    this.dialogueLines = lines;
    this.dialogueIndex = 0;
    this.dialogueActive = true;

    if (!this.dialogueDiv) {
      this.dialogueDiv = document.createElement('div');
      Object.assign(this.dialogueDiv.style, {
        position: 'absolute',
        bottom: '30px',
        left: '50%',
        width: 'min(600px, 90%)',
        background: 'rgba(10, 10, 20, 0.92)',
        color: '#f0f0f0',
        padding: '0',
        borderRadius: '16px',
        pointerEvents: 'auto',
        fontSize: '16px',
        border: '2px solid rgba(120, 160, 255, 0.4)',
        boxShadow: '0 8px 32px rgba(0, 0, 0, 0.5), inset 0 1px 0 rgba(255, 255, 255, 0.05)',
        opacity: '0',
        transform: 'translateX(-50%) translateY(16px) scale(0.96)',
        transition:
          'opacity 0.3s ease, transform 0.28s cubic-bezier(0.34, 1.4, 0.64, 1)',
        zIndex: '1600',
        overflow: 'hidden',
        cursor: 'pointer',
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
          this.dialogueDiv.style.transform = 'translateX(-50%) translateY(0) scale(1)';
        }
      });
    }

    this.dialogueDiv.innerHTML = `
      <div style="
        padding: 6px 16px;
        background: linear-gradient(135deg, rgba(80, 130, 255, 0.3), rgba(120, 80, 255, 0.2));
        border-bottom: 1px solid rgba(120, 160, 255, 0.2);
        font-size: 13px;
        font-weight: 700;
        letter-spacing: 1.5px;
        text-transform: uppercase;
        color: rgba(160, 200, 255, 0.9);
      ">${name}</div>
      <div style="padding: 16px 20px; min-height: 60px;">
        <div id="dialogue-text" style="
          line-height: 1.6;
          font-size: 15px;
          min-height: 24px;
        "></div>
        <div style="
          text-align: right;
          margin-top: 10px;
          font-size: 12px;
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
    if (this.overlay && this.overlay.parentNode) {
      this.overlay.parentNode.removeChild(this.overlay);
    }
  }
}
