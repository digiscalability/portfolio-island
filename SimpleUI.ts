/**
 * SimpleUI - Simplified UI manager for the basic app
 * Handles loading screen, welcome message, interaction prompts, and FPS display
 */
export class SimpleUI {
  private overlay: HTMLElement;
  private loadingDiv: HTMLElement | null = null;
  private welcomeDiv: HTMLElement | null = null;
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

    this.createFPSDisplay();
    this.createMuteButton();
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
      top: '88px',
      right: '10px',
      background: 'rgba(0, 0, 0, 0.55)',
      padding: '5px 9px',
      borderRadius: '10px',
      fontSize: '14px',
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
  }

  /**
   * Touch controls (joystick + E / Jump buttons), created only on touch
   * devices. Buttons dispatch synthetic keyboard events so every existing
   * input path (interaction, dialogue advance, jump) works unchanged;
   * the analog joystick is merged into movement in main-simple.
   */
  private createTouchControls(): void {
    const isTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
    if (!isTouch) return;

    // Joystick
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

    // Action buttons: synthetic key events reuse every existing input path
    const makeButton = (label: string, bottom: string, code: string, key: string) => {
      const btn = document.createElement('div');
      btn.textContent = label;
      Object.assign(btn.style, {
        position: 'absolute',
        right: '30px',
        bottom,
        width: '62px',
        height: '62px',
        borderRadius: '50%',
        background: 'rgba(255,255,255,0.16)',
        border: '2px solid rgba(255,255,255,0.3)',
        color: 'white',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: '20px',
        fontFamily: 'system-ui, sans-serif',
        pointerEvents: 'auto',
        touchAction: 'none',
        userSelect: 'none',
      });
      const fire = (type: 'keydown' | 'keyup') => {
        const ev = new KeyboardEvent(type, { code, key, bubbles: true });
        window.dispatchEvent(ev);
        document.dispatchEvent(ev);
      };
      btn.addEventListener('touchstart', (e) => {
        e.preventDefault();
        e.stopPropagation();
        btn.style.background = 'rgba(255,255,255,0.35)';
        fire('keydown');
      }, { passive: false });
      btn.addEventListener('touchend', (e) => {
        e.stopPropagation();
        btn.style.background = 'rgba(255,255,255,0.16)';
        fire('keyup');
      });
      this.overlay.appendChild(btn);
    };
    makeButton('E', '116px', 'KeyE', 'e');
    makeButton('⤒', '34px', 'Space', ' ');
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
        maxWidth: '400px',
      });
      this.overlay.appendChild(this.welcomeDiv);
    }

    // Returning visitors get a brief hello instead of the full tutorial
    const returning = localStorage.getItem('ds_welcomed') === '1';
    const isTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
    const controlsLine = isTouch
      ? 'Drag the joystick to move, buttons to jump and interact.'
      : 'Use WASD to move, mouse to look around, space to jump.';
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
    return this.welcomeDiv !== null;
  }

  /**
   * Show interaction prompt
   */
  showInteractionPrompt(text: string): void {
    if (!this.interactionDiv) {
      this.interactionDiv = document.createElement('div');
      Object.assign(this.interactionDiv.style, {
        position: 'absolute',
        bottom: '100px',
        left: '50%',
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

    this.interactionDiv.innerHTML = text;
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
        top: '10px',
        right: '10px',
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
      top: '35px',
      right: '10px',
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
        top: '10px',
        left: '10px',
        background: 'rgba(0, 0, 0, 0.55)',
        color: 'white',
        padding: '5px 12px',
        borderRadius: '12px',
        fontSize: '12px',
        fontFamily: 'system-ui, sans-serif',
        pointerEvents: 'none',
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
  updateMinimap(data: {
    player: { lon: number; lat: number; heading: number };
    npcs: Array<{ lon: number; lat: number; hasQuest: boolean }>;
    zones: Array<{ lon: number; lat: number; color: string }>;
    delivery: { lon: number; lat: number } | null;
  }): void {
    const W = 190;
    const H = 108;
    if (!this.mapCanvas) {
      this.mapCanvas = document.createElement('canvas');
      this.mapCanvas.width = W;
      this.mapCanvas.height = H;
      Object.assign(this.mapCanvas.style, {
        position: 'absolute',
        top: '40px',
        left: '10px',
        borderRadius: '10px',
        border: '1px solid rgba(255,255,255,0.25)',
        pointerEvents: 'none',
      });
      this.overlay.appendChild(this.mapCanvas);
    }
    const ctx = this.mapCanvas.getContext('2d');
    if (!ctx) return;
    const px = (lon: number) => ((lon / (Math.PI * 2) + 0.5) % 1) * W;
    const py = (lat: number) => (1 - (lat / Math.PI + 0.5)) * H;
    // Background: sea-to-land gradient feel
    ctx.fillStyle = 'rgba(10, 26, 34, 0.78)';
    ctx.fillRect(0, 0, W, H);
    // Faint latitude lines
    ctx.strokeStyle = 'rgba(255,255,255,0.07)';
    ctx.lineWidth = 1;
    for (const lat of [-0.9, -0.45, 0, 0.45, 0.9]) {
      ctx.beginPath();
      ctx.moveTo(0, py(lat));
      ctx.lineTo(W, py(lat));
      ctx.stroke();
    }
    // Zone plazas
    for (const z of data.zones) {
      ctx.fillStyle = z.color;
      ctx.beginPath();
      ctx.arc(px(z.lon), py(z.lat), 4, 0, Math.PI * 2);
      ctx.fill();
    }
    // NPCs
    for (const n of data.npcs) {
      if (n.hasQuest) {
        ctx.fillStyle = '#ffd34a';
        ctx.beginPath();
        ctx.arc(px(n.lon), py(n.lat), 3, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = 'rgba(255, 211, 74, 0.5)';
        ctx.beginPath();
        ctx.arc(px(n.lon), py(n.lat), 5, 0, Math.PI * 2);
        ctx.stroke();
      } else {
        ctx.fillStyle = 'rgba(255, 190, 130, 0.85)';
        ctx.beginPath();
        ctx.arc(px(n.lon), py(n.lat), 1.8, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    // Delivery target
    if (data.delivery) {
      const pulse = 3 + Math.sin(performance.now() / 250) * 1.2;
      ctx.fillStyle = '#ff5252';
      ctx.beginPath();
      ctx.arc(px(data.delivery.lon), py(data.delivery.lat), pulse, 0, Math.PI * 2);
      ctx.fill();
    }
    // Player: heading arrow
    const x = px(data.player.lon);
    const y = py(data.player.lat);
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(data.player.heading);
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.moveTo(0, -6);
    ctx.lineTo(4, 4);
    ctx.lineTo(0, 1.5);
    ctx.lineTo(-4, 4);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
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
            border:none;padding:7px 14px;border-radius:8px;font-weight:700;
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
        top: '60px',
        right: '10px',
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
        top: '14px',
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
      this.compassLabel.textContent = `${state.label} \u2022 ${Math.round(state.distance)}m`;
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
    const contents: { [key: string]: string } = {
      welcome: `
        <h2 style="margin-top: 0; color: #4CAF50;">🏠 Welcome to the DigiScalability World</h2>
        <p><strong>DigiScalability</strong> is a Melbourne-based venture studio building
        AI-powered products — and this island is its living 3D portfolio.</p>
        <p>Walk the planet to explore:</p>
        <ul style="text-align: left; display: inline-block;">
          <li><strong>Professional Experience</strong> — the builder behind the studio</li>
          <li><strong>Project Portfolio</strong> — RankPilot, ChocoMate, and more</li>
          <li><strong>Personal Life</strong> — food, family recipes, creative tools</li>
          <li><strong>Get In Touch</strong> — work with DigiScalability</li>
        </ul>
        <p style="margin-top: 20px;"><em>WASD to move, mouse to look, E to interact.
        Glowing mailboxes hold deliveries — follow the quest chain around the world!</em></p>
      `,
      professional: `
        <h2 style="margin-top: 0; color: #2196F3;">💼 Professional Experience</h2>
        <p>Syed Abbas Ali — solo founder & full-stack AI builder. Day job in tech,
        a venture studio after hours, hospitality management roots.</p>
        <h3>Core Stack</h3>
        <div style="display: flex; flex-wrap: wrap; gap: 10px; justify-content: center; margin: 20px 0;">
          <span style="background: #333; padding: 5px 10px; border-radius: 15px;">Next.js</span>
          <span style="background: #333; padding: 5px 10px; border-radius: 15px;">TypeScript</span>
          <span style="background: #333; padding: 5px 10px; border-radius: 15px;">Firebase / GCP</span>
          <span style="background: #333; padding: 5px 10px; border-radius: 15px;">Python</span>
          <span style="background: #333; padding: 5px 10px; border-radius: 15px;">Three.js</span>
          <span style="background: #333; padding: 5px 10px; border-radius: 15px;">LLM / AI Automation</span>
        </div>
        <p>Ships end-to-end: product, code, infra, and the AI pipelines that glue
        them together — n8n automations, local model inference, and agentic tooling.</p>
      `,
      projects: `
        <h2 style="margin-top: 0; color: #FF9800;">🚀 Project Portfolio</h2>
        <div style="text-align: left;">
          <h3>📈 RankPilot</h3>
          <p><em>Flagship — live</em> — AI-powered SEO & search-visibility platform.
          Audits, schema, and LLM-readiness for the answer-engine era.</p>
          <h3>🍫 ChocoMate</h3>
          <p>Direct-to-consumer chocolate brand — e-commerce build, brand, and
          content pipeline.</p>
          <h3>📖 Bano's Cookbook</h3>
          <p>Digitising a family's 1981 handwritten recipes into a living cookbook
          app — heritage meets modern web.</p>
          <h3>🤝 Insta Services</h3>
          <p>Services marketplace — Java EE API with a full Jetpack Compose
          Android client.</p>
          <h3>🌍 This Island</h3>
          <p>The world you're standing on: Three.js spherical world, sphere-walking
          physics, Blender-authored assets, quest-driven exploration.</p>
        </div>
      `,
      personal: `
        <h2 style="margin-top: 0; color: #E91E63;">🎨 Personal Life</h2>
        <p>Melbourne, Australia. Builder by day and night — but not only of software.</p>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin: 20px 0;">
          <div>
            <h3>🍽️ Food Ventures</h3>
            <p>Hospitality management background; exploring kitchen-to-market
            concepts from steak frites to desserts</p>
          </div>
          <div>
            <h3>👵 Family Heritage</h3>
            <p>Preserving handwritten family recipes from 1981 — the heart behind
            Bano's Cookbook</p>
          </div>
          <div>
            <h3>🎬 Creative Tooling</h3>
            <p>Blender, DaVinci Resolve, ComfyUI — a full content studio for
            product storytelling</p>
          </div>
          <div>
            <h3>📚 Always Learning</h3>
            <p>Computer science degree, a Masters of IT nearly done, and a new
            experiment every week</p>
          </div>
        </div>
      `,
      contact: `
        <h2 style="margin-top: 0; color: #9C27B0;">📬 Get In Touch</h2>
        <p>Work with DigiScalability — product builds, AI automation, SEO/LLM
        visibility, or something new.</p>
        <div style="margin: 30px 0;">
          <p><strong>Web:</strong> digiscalability.com</p>
          <p><strong>Flagship:</strong> RankPilot — AI search visibility</p>
          <p><strong>Based in:</strong> Melbourne, Australia</p>
        </div>
        <div style="background: #333; padding: 20px; border-radius: 10px; margin: 20px 0;">
          <h3>💬 Coming Soon</h3>
          <p>An AI concierge for instant questions, plus in-world appointment
          booking — right here on the island.</p>
        </div>
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
          <span id="dialogue-hint">Press <strong style="color:rgba(160,200,255,0.8)">E</strong> to continue</span>
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
        hint.innerHTML = 'Press <strong style="color:rgba(160,200,255,0.8)">E</strong> to close';
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
