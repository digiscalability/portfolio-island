import { a11y } from './Accessibility';

/**
 * SimpleUI - Simplified UI manager for the basic app
 * Handles loading screen, welcome message, interaction prompts, and FPS display
 */
export class SimpleUI {
  private overlay: HTMLElement;
  private loadingDiv: HTMLElement | null = null;
  private welcomeDiv: HTMLElement | null = null;
  private nameModalDiv: HTMLElement | null = null;
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
    });
    this.overlay.appendChild(this.muteBtn);
    this.createReducedMotionButton();
  }

  /** ♿ toggle: dampens the fly-in, camera swoop, and pulsing gates. */
  private createReducedMotionButton(): void {
    const btn = document.createElement('div');
    btn.textContent = '♿';
    btn.title = 'Reduced motion — dampens the fly-in, camera swoop, and pulsing effects';
    Object.assign(btn.style, {
      position: 'absolute',
      top: 'calc(var(--sat, 0px) + 124px)',
      right: 'calc(var(--sar, 0px) + 10px)',
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
    };
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      a11y.setReducedMotion(!a11y.reducedMotion);
      render();
    });
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
      top: 'calc(var(--sat, 0px) + 118px)',
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
    this.overlay.appendChild(btn);
  }

  private togglePortfolioMenu(): void {
    if (this.portfolioMenuDiv) {
      this.portfolioMenuDiv.remove();
      this.portfolioMenuDiv = null;
      return;
    }
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
    menu.innerHTML = `
      <h2 style="margin:0 0 4px; color:#8a9bff;">📖 Portfolio</h2>
      <p style="margin:0 0 16px; font-size:13px; color:#aab;">Jump to any section — or close this and explore the island.</p>
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

    this.loadingDiv.innerHTML = `
      <div style="font-size: 24px; margin-bottom: 14px;">🌎 Loading DigiScalability Life Island</div>
      <div style="width: 220px; height: 18px; background: #223; border-radius: 10px; margin-bottom: 10px;">
        <div style="width: ${progress}%; height: 100%; background: #4CAF50; border-radius: 10px; transition: width 0.3s;"></div>
      </div>
      <div style="color:#9ab;">${progress}%</div>
    `;
  }

  /**
   * Hide loading screen (fades the backdrop out over the arriving scene)
   */
  hideLoading(): void {
    if (this.loadingDiv) {
      const el = this.loadingDiv;
      this.loadingDiv = null;
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
      this.overlay.appendChild(this.welcomeDiv);
    }

    // Returning visitors get a brief hello instead of the full tutorial
    const returning = localStorage.getItem('ds_welcomed') === '1';
    const controlsLine = this.isTouch
      ? 'Drag the joystick to move · 👆 USE to interact · ⤒ JUMP (hold to swim) · 👋 WAVE. Tap a dialogue to continue.'
      : 'Use WASD to move, mouse to look around, space to jump, Q to wave at other visitors.';
    this.welcomeDiv.innerHTML = returning
      ? `<h2 style="margin: 0; color: #4CAF50;">👋 Welcome back!</h2>`
      : `
      <h2 style="margin: 0 0 20px 0; color: #4CAF50;">Welcome to DigiScalability Life Island</h2>
      <p style="margin: 0 0 20px 0;">${controlsLine}</p>
      <p style="margin: 0 0 20px 0; font-size: 14px; color: #ccc;">Press any key to start exploring!</p>
    `;

    // Auto-hide on any key press
    const hideWelcome = () => {
      this.hideWelcome();
      document.removeEventListener('keydown', hideWelcome);
      document.removeEventListener('click', hideWelcome);
    };
    document.addEventListener('keydown', hideWelcome);
    document.addEventListener('click', hideWelcome);
    if (returning) window.setTimeout(hideWelcome, 1600);
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
    let done = false;
    const submit = (): void => {
      if (done) return;
      done = true;
      const name = (input.value.trim() || defaultName || 'Visitor').slice(0, 20);
      modal.remove();
      this.nameModalDiv = null;
      onDone(name);
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
        pointerEvents: 'none',
        // Never grow past the left third — keeps it clear of the centered
        // delivery pill on phones while still showing temp + time of day.
        maxWidth: 'calc(50vw - 58px)',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
      });
      this.overlay.appendChild(this.envBadgeDiv);
    }
    this.envBadgeDiv.textContent = text;
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
    zones: Array<{ rx: number; ry: number; dist: number; color: string }>;
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
  showCustomize(onCustomize?: (part: string, value: string) => void): void {
    if (!this.customizeDiv) {
      this.customizeDiv = document.createElement('div');
      Object.assign(this.customizeDiv.style, {
        position: 'absolute',
        bottom: '20px',
        left: '20px',
        background: 'rgba(0, 0, 0, 0.9)',
        color: 'white',
        padding: '15px',
        borderRadius: '10px',
        pointerEvents: 'auto',
        fontSize: '14px',
      });
      this.overlay.appendChild(this.customizeDiv);
    }

    this.customizeDiv.innerHTML = `
      <div style="margin-bottom: 10px; font-weight: bold;">🎨 Customize Character</div>
      <div style="margin-bottom: 5px;">
        <label>Hair: </label>
        <select id="hair-select" style="background: #333; color: white; border: none; padding: 2px;">
          <option value="short">Short</option>
          <option value="long">Long</option>
          <option value="curly">Curly</option>
        </select>
      </div>
      <div style="margin-bottom: 5px;">
        <label>Top: </label>
        <select id="top-select" style="background: #333; color: white; border: none; padding: 2px;">
          <option value="shirt">Shirt</option>
          <option value="jacket">Jacket</option>
          <option value="hoodie">Hoodie</option>
        </select>
      </div>
      <div style="margin-bottom: 5px;">
        <label>Bottom: </label>
        <select id="bottom-select" style="background: #333; color: white; border: none; padding: 2px;">
          <option value="pants">Pants</option>
          <option value="shorts">Shorts</option>
          <option value="skirt">Skirt</option>
        </select>
      </div>
      <div style="margin-bottom: 5px;">
        <label>Shoes: </label>
        <select id="shoes-select" style="background: #333; color: white; border: none; padding: 2px;">
          <option value="sneakers">Sneakers</option>
          <option value="boots">Boots</option>
          <option value="sandals">Sandals</option>
        </select>
      </div>
      <button id="close-customize" style="background: #4CAF50; color: white; border: none; padding: 5px 10px; border-radius: 3px; cursor: pointer; margin-top: 5px;">Close</button>
    `;

    // Add event listeners
    const selects = ['hair', 'top', 'bottom', 'shoes'];
    selects.forEach(part => {
      const select = this.customizeDiv!.querySelector(`#${part}-select`) as HTMLSelectElement;
      select.addEventListener('change', () => {
        if (onCustomize) {
          onCustomize(part, select.value);
        }
      });
    });

    const closeBtn = this.customizeDiv!.querySelector('#close-customize') as HTMLButtonElement;
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
