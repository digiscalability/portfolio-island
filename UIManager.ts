import * as THREE from 'three';
import { AppointmentSystem } from './AppointmentSystem';
import type { ChatMessage } from './ChatSystem';
import { ChatSystem } from './ChatSystem';
import { FeedbackSystem } from './FeedbackSystem';
import { Zone } from './Zones';

export class UIManager {
  // Fade in all main UI elements (HUD, overlays) for immersive transition
  public fadeInUI(duration: number = 900) {
    const elements: (HTMLElement | undefined)[] = [this.hud, this.interactionPanel, this.chatWindow, this.dialogueBox];
    elements.forEach((el) => {
      if (el) {
        el.style.transition = `opacity ${duration}ms`;
        el.style.opacity = '1';
      }
    });
  }

  // Set all main UI elements to hidden (opacity 0)
  public hideUI() {
    const elements: (HTMLElement | undefined)[] = [this.hud, this.interactionPanel, this.chatWindow, this.dialogueBox];
    elements.forEach((el) => {
      if (el) {
        el.style.opacity = '0';
      }
    });
  }
  // Live region for polite announcements and toasts
  private liveRegion?: HTMLElement;
  // Focus trap bookkeeping: map modal element -> saved state
  private focusTrapMap: Map<HTMLElement, { lastFocused: Element | null; ariaHiddenElems: HTMLElement[]; keyHandler: (e: KeyboardEvent) => void }> = new Map();
  private profileData?: any;
  private emojiTooltip?: HTMLElement;
  private container: HTMLElement;
  private chatSystem: ChatSystem;
  private feedbackSystem: FeedbackSystem;
  private appointmentSystem: AppointmentSystem;

  // UI Elements
  private loadingScreen?: HTMLElement;
  private welcomeScreen?: HTMLElement;
  private hud?: HTMLElement;
  private interactionPanel?: HTMLElement;
  private chatWindow?: HTMLElement;
  private chatMessages?: HTMLElement;
  private chatInput?: HTMLInputElement;
  private dialogueBox?: HTMLElement;
  private dialogueQueue: string[] = [];
  private dialogueTitle: string = '';
  private dialogueVisible: boolean = false;
  private environmentPanel?: HTMLElement;
  public environmentControlsCallback?: (action: string, value?: any) => void;

  constructor(containerId: string) {
    const container = document.getElementById(containerId);
    if (!container) {
      throw new Error(`Container with id ${containerId} not found`);
    }
    this.container = container;

    this.chatSystem = new ChatSystem();
    this.feedbackSystem = new FeedbackSystem();
    this.appointmentSystem = new AppointmentSystem();

    this.createUI();
    this.setupChatSystem();
    // Create emoji tooltip after UI is set up
    this.emojiTooltip = this.createEmojiTooltip();
    this.container.appendChild(this.emojiTooltip);
    // Hide UI initially for fade-in after onboarding
    this.hideUI();
    // Show onboarding if first visit
    setTimeout(() => this.checkOnboarding(), 200);
  }

  // Speech bubble helpers (anchored to world position)
  private createSpeechBubbleEl(): HTMLDivElement {
    const el = document.createElement('div');
    el.className = 'speech-bubble hidden';
    el.innerHTML = `<div class="sb-title"></div><div class="sb-text"></div><div class="sb-tail"></div>`;
    el.style.left = '0px'; el.style.top = '0px';
    // ensure tail position var exists
    el.style.setProperty('--tail-left', '50%');
    this.container.appendChild(el);
    return el;
  }

  // bubble pool to allow multiple simultaneous anchored bubbles
  private bubblePool: HTMLDivElement[] = [];
  private bubbleOwnerMap: Map<any, HTMLDivElement> = new Map();
  private bubbleTimeouts: Map<HTMLDivElement, number> = new Map();
  // map owner -> absolute expiry (performance.now() in ms)
  private bubbleExpiry: Map<any, number> = new Map();
  private nextBubbleIndex: number = 0;

  private ensureBubblePool(size: number = 6) {
    while (this.bubblePool.length < size) this.bubblePool.push(this.createSpeechBubbleEl());
  }

  // Show a speech bubble anchored to a scene object. Owner is expected to have `.mesh: THREE.Object3D` or be a THREE.Object3D.
  public showSpeechBubbleForObject(owner: any, title: string, text: string, seconds: number = 4): () => void {
    if (!owner) return () => {};
    // ensure pool
    this.ensureBubblePool(6);

    // if owner already has assigned bubble, reuse it
    let el = this.bubbleOwnerMap.get(owner);
    if (!el) {
      // pick next available
      el = this.bubblePool[this.nextBubbleIndex % this.bubblePool.length];
      this.nextBubbleIndex++;
      this.bubbleOwnerMap.set(owner, el);
    }

    const titleEl = el.querySelector('.sb-title') as HTMLElement | null;
    const bodyEl = el.querySelector('.sb-text') as HTMLElement | null;
    if (titleEl) titleEl.textContent = title;
    if (bodyEl) bodyEl.textContent = text;

    // compute anchor position from bounding box top
    try {
      const camera = (window as any).engine?.sceneManager?.getCamera?.() as THREE.Camera | undefined;
      const canvas = document.getElementById('game-canvas') as HTMLCanvasElement | null;
      let worldPos: THREE.Vector3 | null = null;
      const mesh = (owner.mesh || owner) as THREE.Object3D;
      if (mesh) {
        const box = new THREE.Box3();
        try { box.setFromObject(mesh); } catch (e) { box.makeEmpty(); box.expandByPoint(mesh.position); }
        if (box.isEmpty()) {
          worldPos = mesh.getWorldPosition(new THREE.Vector3());
        } else {
          const centerX = (box.min.x + box.max.x) / 2;
          const centerZ = (box.min.z + box.max.z) / 2;
          worldPos = new THREE.Vector3(centerX, box.max.y, centerZ);
        }
      }

      if (!camera || !canvas || !worldPos) {
        // fallback: place offscreen
        el.style.left = '50%'; el.style.top = '50%';
        el.classList.remove('hidden'); el.classList.add('show');
        // timeout hide
        if (this.bubbleTimeouts.has(el)) { window.clearTimeout(this.bubbleTimeouts.get(el)!); this.bubbleTimeouts.delete(el); }
        const id = window.setTimeout(() => { el.classList.remove('show'); setTimeout(()=>el.classList.add('hidden'), 180); this.bubbleTimeouts.delete(el); this.bubbleOwnerMap.delete(owner); }, seconds*1000);
        this.bubbleTimeouts.set(el, id as any);
        return () => { if (this.bubbleTimeouts.has(el)) { window.clearTimeout(this.bubbleTimeouts.get(el)!); this.bubbleTimeouts.delete(el); el.classList.remove('show'); setTimeout(()=>el.classList.add('hidden'), 120); this.bubbleOwnerMap.delete(owner); } };
      }

      const vector = worldPos.clone().project(camera as THREE.Camera);
      if (vector.z > 1 || vector.z < -1) {
        // behind camera: hide bubble
        el.classList.remove('show'); setTimeout(()=>el.classList.add('hidden'), 180);
        return () => {};
      }

  // Use bounding client rect to properly account for CSS sizing and DPR
  const rect = canvas.getBoundingClientRect();
  const width = rect.width || window.innerWidth;
  const height = rect.height || window.innerHeight;
  let x = (vector.x * 0.5 + 0.5) * width + rect.left;
  let y = (-vector.y * 0.5 + 0.5) * height + rect.top;

      // initial placement: place bubble horizontally centered at x, and above anchor by 14px
      // show briefly hidden to measure size
      el.style.left = `${x}px`;
      el.style.top = `${y - 48}px`;
      el.classList.remove('hidden');
      // ensure we can measure after layout
      requestAnimationFrame(() => {
        try {
          const rect = el.getBoundingClientRect();
          let left = x - rect.width/2;
          // clamp within viewport with small margin
          const margin = 8;
          const overflowLeft = Math.max(0, margin - left);
          const overflowRight = Math.max(0, (left + rect.width) - (width - margin));
          if (overflowLeft > 0) left += overflowLeft;
          if (overflowRight > 0) left -= overflowRight;
          // compute tail position inside bubble (px from left)
          const tailX = Math.max(8, Math.min(rect.width - 8, x - left));
          el.style.left = `${left}px`;
          // keep bubble slightly above anchor
          el.style.top = `${y - rect.height - 12}px`;
          el.style.setProperty('--tail-left', `${tailX}px`);
          // show
          el.classList.add('show');
        } catch (e) { el.classList.add('show'); }
      });

      // clear any existing timeout
      if (this.bubbleTimeouts.has(el)) { window.clearTimeout(this.bubbleTimeouts.get(el)!); this.bubbleTimeouts.delete(el); }
      const id = window.setTimeout(() => {
        // hide with transition then mark owner free
        try { el.classList.remove('show'); } catch (e) {}
        setTimeout(()=>{ try { el.classList.add('hidden'); } catch (e){}; this.bubbleTimeouts.delete(el); this.bubbleOwnerMap.delete(owner); this.bubbleExpiry.delete(owner); }, 180);
      }, seconds*1000);
      this.bubbleTimeouts.set(el, id as any);
      // store expiry timestamp so per-frame updater can also hide/clean
      this.bubbleExpiry.set(owner, performance.now() + seconds*1000);

      return () => {
        if (this.bubbleTimeouts.has(el)) { window.clearTimeout(this.bubbleTimeouts.get(el)!); this.bubbleTimeouts.delete(el); }
        try { el.classList.remove('show'); } catch (e) {}
        setTimeout(()=>{ try { el.classList.add('hidden'); } catch (e){}; this.bubbleOwnerMap.delete(owner); this.bubbleExpiry.delete(owner); }, 120);
      };
    } catch (e) {
      // fallback hide
      el.classList.remove('show'); setTimeout(()=>el.classList.add('hidden'), 180);
      return () => {};
    }
  }

  // Backwards-compatible: allow legacy showSpeechBubble/showSpeechBubbleTimed using explicit screen coords
  private _speechTimeoutId?: number | null = null;
  public showSpeechBubble(title: string, text: string, screenX: number, screenY: number): void {
    this.ensureBubblePool(1);
    const el = this.bubblePool[0];
    const t = el.querySelector('.sb-title') as HTMLElement | null;
    const b = el.querySelector('.sb-text') as HTMLElement | null;
    if (t) t.textContent = title;
    if (b) b.textContent = text;
    el.style.left = `${screenX}px`;
    el.style.top = `${screenY - 48}px`;
    el.classList.remove('hidden'); el.classList.add('show');
  }

  public hideSpeechBubble(): void {
    this.ensureBubblePool(1);
    const el = this.bubblePool[0];
    el.classList.remove('show'); setTimeout(()=>el.classList.add('hidden'), 180);
  }

  public showSpeechBubbleTimed(title: string, text: string, screenX: number, screenY: number, seconds: number = 4): () => void {
    if (this._speechTimeoutId) { window.clearTimeout(this._speechTimeoutId); this._speechTimeoutId = null; }
    this.showSpeechBubble(title, text, screenX, screenY);
    const id = window.setTimeout(() => { this.hideSpeechBubble(); this._speechTimeoutId = null; }, seconds * 1000);
    this._speechTimeoutId = id as any;
    return () => { if (this._speechTimeoutId) { window.clearTimeout(this._speechTimeoutId); this._speechTimeoutId = null; this.hideSpeechBubble(); } };
  }

  // Interaction hint (small UI bubble for 'Press E to interact')
  private hintEl?: HTMLDivElement;
  private createInteractionHint(): HTMLDivElement {
    const el = document.createElement('div');
    el.className = 'interaction-hint hidden';
    el.setAttribute('role', 'status');
    // content wrapper
    const inner = document.createElement('div');
    inner.className = 'interaction-hint-inner';
    inner.textContent = 'Press E to interact';
    // small arrow pointing down
    const arrow = document.createElement('div');
    arrow.className = 'interaction-hint-arrow';
    el.appendChild(inner);
    el.appendChild(arrow);
    this.container.appendChild(el);
    return el;
  }

  public showInteractionHint(screenX: number, screenY: number) {
    if (!this.hintEl) this.hintEl = this.createInteractionHint();
    const el = this.hintEl;
    // position with pixel center alignment
    el.style.left = `${screenX}px`;
    el.style.top = `${screenY - 38}px`;
    el.classList.remove('hidden');
    // trigger show state for transitions
    requestAnimationFrame(() => { el.classList.add('show'); el.classList.remove('hidden'); });
  }

  public hideInteractionHint() {
    if (!this.hintEl) return;
    const el = this.hintEl;
    el.classList.remove('show');
    // wait for transition then hide from layout
    setTimeout(() => { try { el.classList.add('hidden'); } catch (e) {} }, 220);
  }

  public setProfileData(data: any) {
    this.profileData = data;
  }

  private checkOnboarding(): void {
    try {
      const seen = localStorage.getItem('ds_seen_onboarding');
      if (!seen) {
        this.showOnboarding();
      }
    } catch (e) {
      // ignore
    }
  }

  private showOnboarding(): void {
    // Avoid creating multiple onboarding overlays if one already exists
    try {
      if (document.getElementById('onboarding-overlay')) return;
    } catch (e) { }
    // Build a 3-step onboarding flow with accessible controls
    const overlay = document.createElement('div');
    overlay.className = 'interaction-panel onboarding';
    overlay.id = 'onboarding-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'onboarding-title');
    overlay.innerHTML = `
      <div id="onboarding-step-1" class="onboarding-step">
        <h2 id="onboarding-title">Welcome to Messenger Planet</h2>
        <p>Step 1: Movement — Use <strong>WASD</strong> or <strong>arrow keys</strong> to move around.</p>
        <div style="display:flex; gap:10px; justify-content:flex-end; margin-top:16px;">
          <button id="onboarding-next-1" class="btn primary">Next</button>
          <button id="onboarding-skip" class="btn secondary">Skip</button>
        </div>
      </div>
      <div id="onboarding-step-2" class="onboarding-step hidden">
        <h3>Interaction</h3>
        <p>Step 2: Press <strong>E</strong> or <strong>Space</strong> to interact with zones and objects.</p>
        <div style="display:flex; gap:10px; justify-content:flex-end; margin-top:16px;">
          <button id="onboarding-back-2" class="btn secondary">Back</button>
          <button id="onboarding-next-2" class="btn primary">Next</button>
        </div>
      </div>
      <div id="onboarding-step-3" class="onboarding-step hidden">
        <h3>Tips & Accessibility</h3>
        <p>Step 3: Toggle chat with <strong>C</strong>. Press <strong>Tab</strong> to navigate UI. Use high-contrast mode in settings if needed.</p>
        <div style="display:flex; gap:10px; justify-content:flex-end; margin-top:16px;">
          <button id="onboarding-back-3" class="btn secondary">Back</button>
          <button id="onboarding-finish" class="btn primary">Finish</button>
        </div>
      </div>
    `;

    // append a semi-opaque backdrop to block underlying clicks (avoid duplicates)
    try {
      if (!document.getElementById('onboarding-backdrop')) {
        const backdrop = document.createElement('div'); backdrop.className = 'onboarding-backdrop'; backdrop.id = 'onboarding-backdrop'; this.container.appendChild(backdrop);
      }
    } catch (e) { }
    this.container.appendChild(overlay);
    // Ensure onboarding overlay receives keyboard and pointer events
    try {
      // hide the welcome screen while onboarding is active to avoid it intercepting clicks
      if (this.welcomeScreen) this.welcomeScreen.classList.add('hidden');
      overlay.tabIndex = -1;
      overlay.style.zIndex = '2200';
      overlay.style.pointerEvents = 'auto';
      // focus so keyboard handlers (Escape) work and to make screen readers announce
      setTimeout(() => { try { (overlay as HTMLElement).focus(); } catch (e) {} }, 20);
      try { this.activateFocusTrap(overlay); } catch (e) { }
    } catch (e) { }

    setTimeout(() => {
      const next1 = document.getElementById('onboarding-next-1');
      const skip = document.getElementById('onboarding-skip');
      const back2 = document.getElementById('onboarding-back-2');
      const next2 = document.getElementById('onboarding-next-2');
      const back3 = document.getElementById('onboarding-back-3');
      const finish = document.getElementById('onboarding-finish');

      const step1 = document.getElementById('onboarding-step-1');
      const step2 = document.getElementById('onboarding-step-2');
      const step3 = document.getElementById('onboarding-step-3');

      const focusable = (el: HTMLElement | null) => el ? el.querySelector('button') as HTMLElement | null : null;

      if (next1) next1.addEventListener('click', () => {
        if (step1 && step2) { step1.classList.add('hidden'); step2.classList.remove('hidden'); focusable(step2)?.focus(); }
      });
      if (skip) skip.addEventListener('click', () => this.completeOnboarding());
      if (back2) back2.addEventListener('click', () => { if (step2 && step1) { step2.classList.add('hidden'); step1.classList.remove('hidden'); focusable(step1)?.focus(); } });
      if (next2) next2.addEventListener('click', () => { if (step2 && step3) { step2.classList.add('hidden'); step3.classList.remove('hidden'); focusable(step3)?.focus(); } });
      if (back3) back3.addEventListener('click', () => { if (step3 && step2) { step3.classList.add('hidden'); step2.classList.remove('hidden'); focusable(step2)?.focus(); } });
      if (finish) finish.addEventListener('click', () => this.completeOnboarding());

      // keyboard navigation within onboarding
      overlay.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') this.completeOnboarding();
      });

      // trap focus: basic implementation
      const firstButton = overlay.querySelector('button') as HTMLElement | null;
      firstButton && firstButton.focus();
    }, 0);
    // Additional HDRI quick-loads (requires rendererCtrl available)
    (async () => {
      try {
        const engine = (window as any).engine as any;
        const rendererCtrl = engine?.getRendererController?.();
        if (!rendererCtrl) return;
        const r = await fetch('/assets/asset-manifest.json');
        if (!r.ok) return;
        const m = await r.json();
        const hdris = (m.textures || []).filter((t: string) => /\.hdr$/i.test(t));
        if (!hdris.length) return;
        const panelEl = document.getElementById('graphics-settings');
        if (!panelEl) return;
        const quick = document.createElement('div'); quick.style.marginTop = '10px'; quick.innerHTML = '<strong>Quick HDRI</strong>';
        hdris.forEach((h: string) => {
          const row = document.createElement('div'); row.style.display = 'flex'; row.style.gap = '8px'; row.style.marginTop = '6px';
          const label = document.createElement('div'); label.textContent = h.replace(/\.[^/.]+$/, ''); label.style.flex = '1'; label.style.fontSize = '13px'; label.style.color = 'var(--muted)';
          const btn = document.createElement('button'); btn.className = 'btn'; btn.textContent = 'Load';
          btn.addEventListener('click', async () => {
            try {
              const url = '/assets/' + h;
              const env = await rendererCtrl.loadEnvironmentFromUrl(url);
              if (env) {
                const eng = (window as any).engine as any;
                const scene = eng?.getScene?.();
                if (scene) scene.environment = env;
                try { this.showToast('HDRI applied'); } catch (e) { /* fallback noop */ }
              } else { try { this.showToast('Failed to load HDRI'); } catch (e) {} }
            } catch (e) { try { this.showToast('Failed to load HDRI'); } catch (err) {} }
          });
          row.appendChild(label); row.appendChild(btn); quick.appendChild(row);
        });
        panelEl.appendChild(quick);
      } catch (e) { }
    })();
  }

  private completeOnboarding(): void {
    // Remove any onboarding overlays/backdrops (may be duplicated due to earlier errors)
    try {
      const overlays = Array.from(document.querySelectorAll('#onboarding-overlay')) as HTMLElement[];
      overlays.forEach(o => o.remove());
    } catch (e) { }
    try {
      const backs = Array.from(document.querySelectorAll('#onboarding-backdrop')) as HTMLElement[];
      backs.forEach(b => b.remove());
    } catch (e) { }
    // make sure welcome screen is hidden after onboarding completes
    if (this.welcomeScreen) this.welcomeScreen.classList.add('hidden');
    try {
      localStorage.setItem('ds_seen_onboarding', '1');
    } catch (e) {
      // ignore
    }
  }

  // --- Emoji Tooltip Methods ---
  private createEmojiTooltip(): HTMLElement {
    const tooltip = document.createElement('div');
    tooltip.className = 'emoji-tooltip hidden';
    tooltip.style.position = 'fixed';
    tooltip.style.pointerEvents = 'none';
    tooltip.style.zIndex = '9999';
    tooltip.style.fontSize = '32px';
    tooltip.style.background = 'rgba(255,255,255,0.95)';
    tooltip.style.borderRadius = '16px';
    tooltip.style.padding = '8px 18px';
    tooltip.style.boxShadow = '0 4px 16px rgba(0,0,0,0.12)';
    tooltip.style.transform = 'translate(-50%, -120%)';
    tooltip.style.transition = 'opacity 0.2s';
    return tooltip;
  }

  // Throttled/clamped emoji tooltip with simple debounce to avoid jitter
  private currentEmojiRef: any = null;
  private lastTooltipUpdate: number = 0;
  private tooltipUpdateInterval: number = 120; // ms
  private pendingTooltipRAF: number | null = null;

  public showEmojiTooltip(emojiObj: any, emojiChar: string = '😊'): void {
    if (!this.emojiTooltip || !emojiObj || !emojiObj.mesh) return;

    // If camera or canvas missing, bail
    const camera = (window as any).engine?.sceneManager?.getCamera?.();
    const canvas = document.getElementById('game-canvas') as HTMLCanvasElement;
    if (!camera || !canvas) return;

    // If called for the same emoji, just update position (throttled)
    const now = performance.now();
    const updatePosition = () => {
      // Project world position to screen
      const worldPos = emojiObj.mesh.position;
      const vector = worldPos.clone().project(camera);

      // If behind camera or invalid, hide
      if (vector.z > 1 || vector.z < -1) {
        this.hideEmojiTooltip();
        return;
      }

      const width = canvas.width || window.innerWidth;
      const height = canvas.height || window.innerHeight;
      let x = (vector.x * 0.5 + 0.5) * width;
      let y = (-vector.y * 0.5 + 0.5) * height;

      // Clamp to viewport with small margin
      const margin = 12;
      x = Math.max(margin, Math.min(x, window.innerWidth - margin));
      y = Math.max(margin, Math.min(y, window.innerHeight - margin));

      const tip = this.emojiTooltip!;
      tip.textContent = emojiChar;
      tip.style.left = `${x}px`;
      tip.style.top = `${y}px`;
      tip.classList.remove('hidden');
      this.lastTooltipUpdate = performance.now();
    };

    // cancel any pending raf
    if (this.pendingTooltipRAF) {
      cancelAnimationFrame(this.pendingTooltipRAF);
      this.pendingTooltipRAF = null;
    }

    // If switching to a new emoji, show immediately
    if (this.currentEmojiRef !== emojiObj) {
      this.currentEmojiRef = emojiObj;
      updatePosition();
      return;
    }

    // Throttle updates to avoid jitter
    if (now - this.lastTooltipUpdate > this.tooltipUpdateInterval) {
      updatePosition();
    } else {
      // schedule next frame
      this.pendingTooltipRAF = requestAnimationFrame(() => {
        updatePosition();
        this.pendingTooltipRAF = null;
      });
    }
  }

  public hideEmojiTooltip(): void {
    if (!this.emojiTooltip) return;
    this.emojiTooltip.classList.add('hidden');
    this.currentEmojiRef = null;
    if (this.pendingTooltipRAF) {
      cancelAnimationFrame(this.pendingTooltipRAF);
      this.pendingTooltipRAF = null;
    }
  }

  // Per-frame update: reposition anchored bubbles and cleanup expired ones.
  // deltaTime in seconds
  public update(deltaTime: number = 0.016): void {
    try {
      if (!this.bubbleOwnerMap || !this.bubbleOwnerMap.size) return;
      const camera = (window as any).engine?.sceneManager?.getCamera?.() as THREE.Camera | undefined;
      const canvas = document.getElementById('game-canvas') as HTMLCanvasElement | null;
      if (!camera || !canvas) return;

      const now = performance.now();
      // collect visible bubble layout info first
      const layouts: Array<{ owner: any; el: HTMLDivElement; x: number; y: number; width: number; height: number; desiredLeft: number; desiredTop: number; tailAnchorX: number; }> = [];
      for (const [owner, el] of Array.from(this.bubbleOwnerMap.entries())) {
        // if expiry reached, ensure hidden
        const expiry = this.bubbleExpiry.get(owner);
        if (expiry && now >= expiry) {
          // trigger hide and cleanup
          try { el.classList.remove('show'); } catch (e) {}
          setTimeout(() => { try { el.classList.add('hidden'); } catch (e) {} }, 160);
          this.bubbleOwnerMap.delete(owner);
          this.bubbleExpiry.delete(owner);
          // cancel any pending timeout
          if (this.bubbleTimeouts.has(el)) { window.clearTimeout(this.bubbleTimeouts.get(el)!); this.bubbleTimeouts.delete(el); }
          continue;
        }

        // reposition bubble anchored to owner's bounding-box top
        try {
          const mesh = (owner.mesh || owner) as THREE.Object3D;
          if (!mesh) { continue; }
          const box = new THREE.Box3();
          try { box.setFromObject(mesh); } catch (e) { box.makeEmpty(); box.expandByPoint(mesh.position); }
          const worldPos = box.isEmpty() ? mesh.getWorldPosition(new THREE.Vector3()) : new THREE.Vector3((box.min.x + box.max.x)/2, box.max.y, (box.min.z + box.max.z)/2);
          const vector = worldPos.clone().project(camera as THREE.Camera);
          if (vector.z > 1 || vector.z < -1) { el.classList.remove('show'); setTimeout(()=>el.classList.add('hidden'), 160); continue; }
      const rect = canvas.getBoundingClientRect();
      const width = rect.width || window.innerWidth;
      const height = rect.height || window.innerHeight;
      const x = (vector.x * 0.5 + 0.5) * width + rect.left;
      const y = (-vector.y * 0.5 + 0.5) * height + rect.top;
          // ensure visible for measurement
          if (!el.classList.contains('show')) el.classList.remove('hidden');
          const elRect = el.getBoundingClientRect();
          let left = x - elRect.width / 2;
          const margin = 8;
          if (left < margin) left = margin;
          if (left + elRect.width > width - margin) left = width - elRect.width - margin;
          const top = y - elRect.height - 12;
          const tailAnchorX = Math.max(8, Math.min(elRect.width - 8, x - left));
          layouts.push({ owner, el, x, y, width: elRect.width, height: elRect.height, desiredLeft: left, desiredTop: top, tailAnchorX });
        } catch (e) { /* tolerate per-bubble errors */ }
      }

      // Simple stacking / collision avoidance: sort by desiredTop (ascending means higher on screen first)
      layouts.sort((a, b) => a.desiredTop - b.desiredTop);
      // naive pairwise resolve: if two rects overlap vertically/horizontally, push the lower one up
      for (let i = 0; i < layouts.length; i++) {
        const A = layouts[i];
        for (let j = i + 1; j < layouts.length; j++) {
          const B = layouts[j];
          // check overlap between A and B
          const ax1 = A.desiredLeft, ax2 = A.desiredLeft + A.width;
          const ay1 = A.desiredTop, ay2 = A.desiredTop + A.height;
          const bx1 = B.desiredLeft, bx2 = B.desiredLeft + B.width;
          const by1 = B.desiredTop, by2 = B.desiredTop + B.height;
          const overlapX = Math.max(0, Math.min(ax2, bx2) - Math.max(ax1, bx1));
          const overlapY = Math.max(0, Math.min(ay2, by2) - Math.max(ay1, by1));
          if (overlapX > 8 && overlapY > 8) {
            // push B upward by enough to clear overlap + small gap
            const shift = overlapY + 6;
            B.desiredTop = Math.max(8, B.desiredTop - shift);
            // after moving B, need to re-evaluate against earlier items, so restart inner loop
          }
        }
      }

      // apply layouts to DOM and recompute tail positions
      for (const L of layouts) {
        try {
          L.el.style.left = `${L.desiredLeft}px`;
          L.el.style.top = `${L.desiredTop}px`;
          L.el.style.setProperty('--tail-left', `${Math.max(8, Math.min(L.width - 8, L.tailAnchorX))}px`);
          // ensure show state
          L.el.classList.add('show');
        } catch (e) { /* ignore per-element errors */ }
      }
    } catch (e) { /* overall UI update tolerant */ }
  }

  private createUI(): void {
    // ...existing code...
    // Create loading screen
    this.loadingScreen = this.createLoadingScreen();
    this.container.appendChild(this.loadingScreen);

    // Create welcome screen
    this.welcomeScreen = this.createWelcomeScreen();
    this.container.appendChild(this.welcomeScreen);

    // Create HUD
    this.hud = this.createHUD();
    this.container.appendChild(this.hud);

    // Create interaction panel
    this.interactionPanel = this.createInteractionPanel();
    this.container.appendChild(this.interactionPanel);

    // Create chat window
    this.chatWindow = this.createChatWindow();
    this.container.appendChild(this.chatWindow);

  // Create dialogue box (for in-game messages)
  this.dialogueBox = this.createDialogueBox();
  this.container.appendChild(this.dialogueBox);

  // Create environment controls panel
  this.environmentPanel = this.createEnvironmentPanel();
  this.container.appendChild(this.environmentPanel);

  // Create customization modal and append
  const customModal = this.createCustomizationModal();
  this.container.appendChild(customModal);
    // Create gallery modal and append
    const gallery = this.createGalleryModal();
    this.container.appendChild(gallery);
    // create a polite live region for announcements/toasts
    this.liveRegion = this.createLiveRegion();
    this.container.appendChild(this.liveRegion);
  }

  private createLiveRegion(): HTMLElement {
    const lr = document.createElement('div');
    lr.className = 'sr-only';
    lr.setAttribute('aria-live', 'polite');
    lr.setAttribute('role', 'status');
    lr.id = 'ui-live-region';
    return lr;
  }

  // Simple toast helper that also updates live region for screen readers
  public showToast(message: string, opts?: { duration?: number }) {
    const duration = (opts && opts.duration) || 2200;
    try {
      // visual toast
      const t = document.createElement('div');
      t.className = 'toast';
      t.textContent = message;
      t.style.position = 'fixed';
      t.style.bottom = '18px';
      t.style.right = '18px';
      t.style.background = 'rgba(0,0,0,0.7)';
      t.style.color = 'white';
      t.style.padding = '8px 12px';
      t.style.borderRadius = '8px';
      t.style.zIndex = '3000';
      document.body.appendChild(t);
      setTimeout(() => t.remove(), duration);
    } catch (e) { }
    try {
      if (this.liveRegion) {
        this.liveRegion.textContent = message;
        // clear after duration + a bit
        setTimeout(() => { if (this.liveRegion) this.liveRegion.textContent = ''; }, duration + 400);
      }
    } catch (e) { }
  }

  // Focus trap helpers: mark other siblings as aria-hidden and trap Tab within modal
  private activateFocusTrap(modal: HTMLElement) {
    if (this.focusTrapMap.has(modal)) return;
    const last = document.activeElement;
    // find elements that are siblings of modal container and hide them
    const ariaHiddenElems: HTMLElement[] = [];
    try {
      const all = Array.from(document.body.children) as HTMLElement[];
      all.forEach((el) => {
        if (el === modal || el.contains(modal)) return;
        const wasHidden = el.getAttribute('aria-hidden');
        if (wasHidden !== 'true') {
          el.setAttribute('aria-hidden', 'true');
          ariaHiddenElems.push(el);
        }
      });
    } catch (e) { }

    const keyHandler = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const focusable = modal.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
      if (!focusable || focusable.length === 0) return;
      const first = focusable[0] as HTMLElement;
      const lastF = focusable[focusable.length - 1] as HTMLElement;
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); lastF.focus(); }
      else if (!e.shiftKey && document.activeElement === lastF) { e.preventDefault(); first.focus(); }
    };
    window.addEventListener('keydown', keyHandler);
    this.focusTrapMap.set(modal, { lastFocused: last, ariaHiddenElems, keyHandler });
  }

  private deactivateFocusTrap(modal: HTMLElement) {
    const info = this.focusTrapMap.get(modal);
    if (!info) return;
    try {
      info.ariaHiddenElems.forEach((el) => el.removeAttribute('aria-hidden'));
    } catch (e) { }
    window.removeEventListener('keydown', info.keyHandler);
    try { (info.lastFocused as HTMLElement | null)?.focus(); } catch (e) { }
    this.focusTrapMap.delete(modal);
  }

  // Gallery modal creation
  private createGalleryModal(): HTMLElement {
    const modal = document.createElement('div');
    modal.id = 'gallery-modal';
    modal.className = 'gallery-modal hidden';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.innerHTML = `
      <div class="gallery-backdrop" id="gallery-backdrop"></div>
      <div class="gallery-content" role="document">
        <button id="gallery-close" class="gallery-btn" aria-label="Close">✕</button>
        <button id="gallery-prev" class="gallery-btn" aria-label="Previous">◀</button>
        <div class="gallery-image-wrap"><img id="gallery-image" src="" alt="Gallery image" /></div>
        <button id="gallery-next" class="gallery-btn" aria-label="Next">▶</button>
        <div class="gallery-caption" id="gallery-caption"></div>
        <div class="gallery-thumbs" id="gallery-thumbs" aria-hidden="true"></div>
      </div>
    `;

    setTimeout(() => {
      const close = document.getElementById('gallery-close');
      const prev = document.getElementById('gallery-prev');
      const next = document.getElementById('gallery-next');
      const backdrop = document.getElementById('gallery-backdrop');
      // live region for announcements
      const live = document.createElement('div'); live.id = 'gallery-live'; live.setAttribute('aria-live','polite'); live.className = 'sr-only'; modal.appendChild(live);

      const onKey = (e: KeyboardEvent) => {
        if (document.getElementById('gallery-modal')?.classList.contains('hidden')) return;
        if (e.key === 'Escape') this.closeGallery();
        if (e.key === 'ArrowLeft') this.navigateGallery(-1);
        if (e.key === 'ArrowRight') this.navigateGallery(1);
        if (e.key === '+' || e.key === '=') this.zoomGallery(1.1);
        if (e.key === '-' || e.key === '_') this.zoomGallery(0.9);
        // trap focus: keep focus in modal
        if (e.key === 'Tab') {
          const focusable = modal.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
          if (!focusable || !focusable.length) return;
          const first = focusable[0] as HTMLElement;
          const last = focusable[focusable.length - 1] as HTMLElement;
          if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
          else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        }
      };

      if (close) close.addEventListener('click', () => this.closeGallery());
      if (prev) prev.addEventListener('click', () => this.navigateGallery(-1));
      if (next) next.addEventListener('click', () => this.navigateGallery(1));
      if (backdrop) backdrop.addEventListener('click', () => this.closeGallery());
      // touch: swipe handlers
      const imgWrap = modal.querySelector('.gallery-image-wrap') as HTMLElement | null;
      if (imgWrap) {
        let startX = 0, startY = 0, startDist = 0, pinch = false, lastTap = 0;
        let originX = 0, originY = 0;
        imgWrap.addEventListener('touchstart', (ev: TouchEvent) => {
          if (ev.touches.length === 1) {
            startX = ev.touches[0].clientX; startY = ev.touches[0].clientY; pinch = false;
            const now = Date.now();
            if (now - lastTap < 350) {
              // double tap: toggle zoom in/out centered where tapped
              const t = ev.touches[0];
              const rect = (imgWrap.querySelector('#gallery-image') as HTMLElement).getBoundingClientRect();
              const cx = t.clientX - rect.left - rect.width/2;
              const cy = t.clientY - rect.top - rect.height/2;
              if (this.galleryZoom > 1.05) {
                this.galleryZoom = 1; this.galleryPanX = 0; this.galleryPanY = 0;
              } else {
                this.galleryZoom = 2; // quick zoom
                this.galleryPanX = -cx; this.galleryPanY = -cy;
              }
              this.zoomGallery(1);
            }
            lastTap = now;
          } else if (ev.touches.length === 2) {
            pinch = true;
            const dx = ev.touches[0].clientX - ev.touches[1].clientX;
            const dy = ev.touches[0].clientY - ev.touches[1].clientY;
            startDist = Math.sqrt(dx*dx+dy*dy);
            // store midpoint as origin for centering
            originX = (ev.touches[0].clientX + ev.touches[1].clientX) / 2;
            originY = (ev.touches[0].clientY + ev.touches[1].clientY) / 2;
          }
        }, { passive: true });
        imgWrap.addEventListener('touchmove', (ev: TouchEvent) => {
          if (pinch && ev.touches.length === 2) {
            const dx = ev.touches[0].clientX - ev.touches[1].clientX; const dy = ev.touches[0].clientY - ev.touches[1].clientY; const dist = Math.sqrt(dx*dx+dy*dy);
            const factor = dist / (startDist || dist || 1);
            // compute center delta to keep pinch centered
            const midX = (ev.touches[0].clientX + ev.touches[1].clientX) / 2;
            const midY = (ev.touches[0].clientY + ev.touches[1].clientY) / 2;
            // delta from previous origin
            const dxOrigin = midX - originX; const dyOrigin = midY - originY;
            // apply pan shift scaled by zoom change
            this.galleryPanX += dxOrigin; this.galleryPanY += dyOrigin;
            // apply zoom
            this.zoomGallery(factor);
            startDist = dist; originX = midX; originY = midY;
          } else if (!pinch && ev.touches.length === 1 && this.galleryZoom > 1) {
            // panning while zoomed
            const tx = ev.touches[0].clientX; const ty = ev.touches[0].clientY;
            const dx = tx - startX; const dy = ty - startY;
            startX = tx; startY = ty;
            this.galleryPanX += dx; this.galleryPanY += dy;
            const imgEl = document.getElementById('gallery-image') as HTMLImageElement | null;
            if (imgEl) imgEl.style.transform = `translate(${this.galleryPanX}px, ${this.galleryPanY}px) scale(${this.galleryZoom})`;
          }
        }, { passive: true });
        imgWrap.addEventListener('touchend', (ev: TouchEvent) => {
          if (!pinch && ev.changedTouches.length === 1) {
            const dx = ev.changedTouches[0].clientX - startX;
            if (Math.abs(dx) > 50 && this.galleryZoom <= 1.05) { if (dx < 0) this.navigateGallery(1); else this.navigateGallery(-1); }
          }
          // clamp pan to reasonable bounds to avoid runaway
          const imgEl = document.getElementById('gallery-image') as HTMLImageElement | null;
          if (imgEl) {
            const rect = imgEl.getBoundingClientRect();
            // gentle clamp
            this.galleryPanX = Math.max(-rect.width * (this.galleryZoom - 1), Math.min(rect.width * (this.galleryZoom - 1), this.galleryPanX));
            this.galleryPanY = Math.max(-rect.height * (this.galleryZoom - 1), Math.min(rect.height * (this.galleryZoom - 1), this.galleryPanY));
            imgEl.style.transform = `translate(${this.galleryPanX}px, ${this.galleryPanY}px) scale(${this.galleryZoom})`;
          }
          pinch = false;
        });
      }
      window.addEventListener('keydown', onKey);
    }, 0);

    return modal;
  }

  private galleryItems: Array<{ src: string; caption?: string }> = [];
  private galleryIndex: number = 0;
  private galleryZoom: number = 1;
  private galleryPanX: number = 0;
  private galleryPanY: number = 0;
  private lastFocusedBeforeGallery: Element | null = null;

  public openGallery(items: Array<{ src: string; caption?: string }>, startIndex: number = 0) {
    if (!items || !items.length) return;
    this.galleryItems = items;
    this.galleryIndex = Math.max(0, Math.min(startIndex, items.length - 1));
    this.galleryZoom = 1;
    this.galleryPanX = 0;
    this.galleryPanY = 0;
    const modal = document.getElementById('gallery-modal');
    const img = document.getElementById('gallery-image') as HTMLImageElement | null;
    const caption = document.getElementById('gallery-caption');
    if (!modal || !img) return;
    // store last focused element to restore focus on close
    this.lastFocusedBeforeGallery = document.activeElement;
    img.style.transform = 'scale(1)';
    // try thumbnail for main display first (same naming scheme)
    try {
      const name = this.galleryItems[this.galleryIndex].src.split('/').pop() || '';
      const base = name.replace(/\.[^/.]+$/, '');
      img.src = `/assets/thumbs/${base}.webp`;
      img.onerror = () => { img.onerror = null; img.src = this.galleryItems[this.galleryIndex].src; };
    } catch (e) {
      img.src = this.galleryItems[this.galleryIndex].src;
    }
    if (caption) caption.textContent = this.galleryItems[this.galleryIndex].caption || '';
    modal.classList.remove('hidden');
  try { this.activateFocusTrap(modal); } catch (e) { }
    // update aria-disabled on nav buttons
    this.updateGalleryNavState();
    // announce via live region
    const live = document.getElementById('gallery-live');
    if (live) live.textContent = `Image ${this.galleryIndex + 1} of ${this.galleryItems.length}`;
    // focus for accessibility
    const closeBtn = document.getElementById('gallery-close') as HTMLElement | null;
    closeBtn && closeBtn.focus();

    // populate thumbnail strip
    try {
      const thumbs = document.getElementById('gallery-thumbs');
      if (thumbs) {
        thumbs.innerHTML = '';
        thumbs.setAttribute('aria-hidden', 'false');
        this.galleryItems.forEach((it, idx) => {
          const t = document.createElement('button');
          t.className = 'gallery-thumb';
          t.setAttribute('role', 'button');
          t.setAttribute('aria-label', `Open image ${idx + 1}`);
          t.setAttribute('data-index', String(idx));
          t.tabIndex = 0;
          const im = document.createElement('img');
          // use generated thumbnail if present under assets/thumbs/<name>.webp
          try {
            const name = it.src.split('/').pop();
            const base = name ? name.replace(/\.[^/.]+$/, '') : '';
            im.src = `/assets/thumbs/${base}.webp`;
            // if thumb fails to load, replace with original
            im.onerror = () => { im.onerror = null; im.src = it.src; };
          } catch (e) { im.src = it.src; }
          im.alt = it.caption || `Image ${idx + 1}`;
          im.loading = 'lazy';
          im.style.width = '88px';
          im.style.height = '60px';
          im.style.objectFit = 'cover';
          im.style.borderRadius = '6px';
          t.appendChild(im);
          t.addEventListener('click', () => {
            this.galleryIndex = idx;
            this.galleryZoom = 1;
            this.galleryPanX = 0; this.galleryPanY = 0;
            const gimg = document.getElementById('gallery-image') as HTMLImageElement | null;
            const captionEl = document.getElementById('gallery-caption');
            if (gimg) { gimg.src = this.galleryItems[this.galleryIndex].src; gimg.style.transform = 'translate(0px, 0px) scale(1)'; }
            if (captionEl) captionEl.textContent = this.galleryItems[this.galleryIndex].caption || '';
            this.updateGalleryNavState();
            this.updateThumbSelection();
            const live2 = document.getElementById('gallery-live'); if (live2) live2.textContent = `Image ${this.galleryIndex + 1} of ${this.galleryItems.length}`;
          });
          t.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); (t as HTMLElement).click(); } });
          thumbs.appendChild(t);
        });
        // highlight selected
        this.updateThumbSelection();
      }
    } catch (e) { /* non-fatal */ }
  }

  public closeGallery() {
    const modal = document.getElementById('gallery-modal');
    if (!modal) return;
    modal.classList.add('hidden');
    // reset image
    const img = document.getElementById('gallery-image') as HTMLImageElement | null;
    if (img) { img.src = ''; img.style.transform = 'scale(1)'; }
    this.galleryItems = [];
    this.galleryIndex = 0;
    this.galleryZoom = 1;
    // restore focus
    try { (this.lastFocusedBeforeGallery as HTMLElement | null)?.focus(); } catch (e) { }
    const live = document.getElementById('gallery-live'); if (live) live.textContent = '';
    try { this.deactivateFocusTrap(modal); } catch (e) { }
  }

  public navigateGallery(delta: number) {
    if (!this.galleryItems.length) return;
    this.galleryIndex = (this.galleryIndex + delta + this.galleryItems.length) % this.galleryItems.length;
    const img = document.getElementById('gallery-image') as HTMLImageElement | null;
    const caption = document.getElementById('gallery-caption');
    if (img) { img.src = this.galleryItems[this.galleryIndex].src; img.style.transform = `scale(${this.galleryZoom})`; }
    if (caption) caption.textContent = this.galleryItems[this.galleryIndex].caption || '';
    // update nav aria state and announce
    this.updateGalleryNavState();
    const live = document.getElementById('gallery-live');
    if (live) live.textContent = `Image ${this.galleryIndex + 1} of ${this.galleryItems.length}`;

    // update thumbnail selection when navigating
    this.updateThumbSelection();
  }

  private updateThumbSelection() {
    const thumbs = document.getElementById('gallery-thumbs');
    if (!thumbs) return;
    Array.from(thumbs.children).forEach((c) => {
      const idx = parseInt((c as HTMLElement).getAttribute('data-index') || '-1');
      if (idx === this.galleryIndex) (c as HTMLElement).classList.add('selected'); else (c as HTMLElement).classList.remove('selected');
    });
    // scroll selected into view
    const sel = thumbs.querySelector('.selected') as HTMLElement | null;
    if (sel) sel.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
  }

  private updateGalleryNavState() {
    const prev = document.getElementById('gallery-prev');
    const next = document.getElementById('gallery-next');
    if (!prev || !next) return;
    if (this.galleryItems.length <= 1) {
      prev.setAttribute('aria-disabled', 'true'); prev.setAttribute('tabindex', '-1');
      next.setAttribute('aria-disabled', 'true'); next.setAttribute('tabindex', '-1');
    } else {
      prev.removeAttribute('aria-disabled'); prev.setAttribute('tabindex', '0');
      next.removeAttribute('aria-disabled'); next.setAttribute('tabindex', '0');
    }
  }

  public zoomGallery(factor: number) {
    // multiplicative zoom while clamping
    this.galleryZoom = Math.max(0.2, Math.min(5, this.galleryZoom * factor));
    const img = document.getElementById('gallery-image') as HTMLImageElement | null;
    if (img) {
      // apply translate + scale for pan support
      img.style.transform = `translate(${this.galleryPanX}px, ${this.galleryPanY}px) scale(${this.galleryZoom})`;
    }
  }

  private createDialogueBox(): HTMLElement {
    const box = document.createElement('div');
    box.className = 'dialogue-box hidden';
    box.innerHTML = `
      <div class="dialogue-inner">
        <div class="dialogue-label" id="dialogue-label">Messenger</div>
        <div class="dialogue-text" id="dialogue-text">Hello, welcome!</div>
        <div class="dialogue-tail"></div>
        <div class="dialogue-next" id="dialogue-next">▶</div>
      </div>
    `;

    setTimeout(() => {
      const next = box.querySelector('#dialogue-next');
      if (next) next.addEventListener('click', () => this.advanceDialogue());
    }, 0);

    return box;
  }

  private createEnvironmentPanel(): HTMLElement {
    const panel = document.createElement('div');
    panel.className = 'environment-panel hidden';
    panel.id = 'environment-panel';
    panel.style.cssText = `
      position: fixed;
      top: 80px;
      right: 20px;
      background: rgba(0, 0, 0, 0.85);
      color: white;
      padding: 20px;
      border-radius: 12px;
      min-width: 280px;
      max-width: 320px;
      z-index: 1000;
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5);
      backdrop-filter: blur(10px);
    `;

    panel.innerHTML = `
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;">
        <h3 style="margin: 0; font-size: 18px;">🌍 Environment</h3>
        <button id="env-close" style="background: transparent; border: none; color: white; font-size: 24px; cursor: pointer; padding: 0; width: 30px; height: 30px;">×</button>
      </div>

      <div style="margin-bottom: 20px;">
        <label style="display: block; margin-bottom: 8px; font-size: 14px;">
          Time of Day
        </label>
        <input type="range" id="env-time" min="0" max="100" value="35"
          style="width: 100%; cursor: pointer;" />
        <div style="display: flex; justify-content: space-between; font-size: 11px; color: #aaa; margin-top: 4px;">
          <span>🌙 Night</span>
          <span>🌅 Sunrise</span>
          <span>☀️ Day</span>
          <span>🌆 Sunset</span>
        </div>
      </div>

      <div style="margin-bottom: 20px;">
        <label style="display: flex; align-items: center; cursor: pointer;">
          <input type="checkbox" id="env-auto" checked
            style="width: 18px; height: 18px; cursor: pointer; margin-right: 8px;" />
          <span>Auto Day/Night Cycle</span>
        </label>
      </div>

      <div style="margin-bottom: 20px;">
        <label style="display: block; margin-bottom: 8px; font-size: 14px;">
          Cycle Speed (minutes)
        </label>
        <input type="range" id="env-speed" min="60" max="600" value="180" step="30"
          style="width: 100%; cursor: pointer;" />
        <div style="text-align: center; font-size: 12px; color: #aaa; margin-top: 4px;">
          <span id="env-speed-label">3 min</span>
        </div>
      </div>

      <div style="border-top: 1px solid rgba(255,255,255,0.2); padding-top: 16px; margin-top: 16px;">
        <div style="font-size: 13px; margin-bottom: 12px; color: #ccc;">Quick Presets</div>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px;">
          <button class="env-preset" data-time="0.0" style="padding: 8px; background: rgba(10,10,26,0.7); border: 1px solid #4a4a6a; color: white; border-radius: 6px; cursor: pointer; font-size: 12px;">🌙 Midnight</button>
          <button class="env-preset" data-time="0.25" style="padding: 8px; background: rgba(255,170,102,0.3); border: 1px solid #ff6b35; color: white; border-radius: 6px; cursor: pointer; font-size: 12px;">🌅 Sunrise</button>
          <button class="env-preset" data-time="0.5" style="padding: 8px; background: rgba(135,206,235,0.4); border: 1px solid #87ceeb; color: white; border-radius: 6px; cursor: pointer; font-size: 12px;">☀️ Noon</button>
          <button class="env-preset" data-time="0.75" style="padding: 8px; background: rgba(255,69,0,0.4); border: 1px solid #ff4500; color: white; border-radius: 6px; cursor: pointer; font-size: 12px;">🌆 Sunset</button>
        </div>
      </div>
    `;

    // Event listeners (set up after a tick to ensure DOM is ready)
    setTimeout(() => {
      const closeBtn = panel.querySelector('#env-close') as HTMLButtonElement;
      const timeSlider = panel.querySelector('#env-time') as HTMLInputElement;
      const autoCheckbox = panel.querySelector('#env-auto') as HTMLInputElement;
      const speedSlider = panel.querySelector('#env-speed') as HTMLInputElement;
      const speedLabel = panel.querySelector('#env-speed-label') as HTMLElement;
      const presetButtons = panel.querySelectorAll('.env-preset');

      if (closeBtn) {
        closeBtn.addEventListener('click', () => {
          panel.classList.add('hidden');
        });
      }

      if (timeSlider) {
        timeSlider.addEventListener('input', () => {
          const value = parseFloat(timeSlider.value) / 100;
          if (this.environmentControlsCallback) {
            this.environmentControlsCallback('setTime', value);
          }
        });
      }

      if (autoCheckbox) {
        autoCheckbox.addEventListener('change', () => {
          if (this.environmentControlsCallback) {
            this.environmentControlsCallback('setAutoCycle', autoCheckbox.checked);
          }
        });
      }

      if (speedSlider && speedLabel) {
        speedSlider.addEventListener('input', () => {
          const seconds = parseFloat(speedSlider.value);
          const minutes = Math.round(seconds / 60 * 10) / 10;
          speedLabel.textContent = `${minutes} min`;
          if (this.environmentControlsCallback) {
            this.environmentControlsCallback('setCycleSpeed', seconds);
          }
        });
      }

      presetButtons.forEach(btn => {
        btn.addEventListener('click', () => {
          const time = parseFloat((btn as HTMLElement).dataset.time || '0.5');
          timeSlider.value = String(time * 100);
          if (this.environmentControlsCallback) {
            this.environmentControlsCallback('setTime', time);
          }
        });
      });
    }, 0);

    return panel;
  }

  public toggleEnvironmentPanel(): void {
    if (this.environmentPanel) {
      this.environmentPanel.classList.toggle('hidden');
    }
  }

  public showEnvironmentPanel(): void {
    if (this.environmentPanel) {
      this.environmentPanel.classList.remove('hidden');
    }
  }

  public hideEnvironmentPanel(): void {
    if (this.environmentPanel) {
      this.environmentPanel.classList.add('hidden');
    }
  }

  private createLoadingScreen(): HTMLElement {
    const screen = document.createElement('div');
    screen.className = 'loading-screen';
  screen.innerHTML = `
      <h2>Loading DigiScalability Life Island...</h2>
      <div class="loading-dots"><span></span><span></span><span></span></div>
      <div class="loading-progress">
        <div class="loading-progress-bar" id="loading-progress-bar"></div>
      </div>
      <p id="loading-message">Preparing your experience</p>
      <div style="margin-top:14px;"><button id="loading-retry" class="btn secondary hidden">Retry</button></div>
    `;

    // Retry handler
    setTimeout(() => {
      const retry = document.getElementById('loading-retry');
      if (retry) retry.addEventListener('click', () => this.onRetryLoad());
    }, 0);
    return screen;
  }

  private onRetryLoad(): void {
    const retryBtn = document.getElementById('loading-retry');
    const msg = document.getElementById('loading-message');
    if (retryBtn) retryBtn.classList.add('hidden');
    if (msg) msg.textContent = 'Retrying...';

    // Simple strategy: reload the page to retry assets
    setTimeout(() => location.reload(), 600);
  }

  private createWelcomeScreen(): HTMLElement {
    const screen = document.createElement('div');
    screen.className = 'welcome-screen';
    screen.innerHTML = `
      <div class="welcome-card">
        <div class="planet-wrap">
          <div class="planet-graphic" id="planet-graphic">
            <!-- Title SVG placed over planet -->
            <img src="/assets/title-handdrawn.svg" alt="title" style="width:240px; height:auto; position:absolute; left:50%; top:50%; transform:translate(-50%,-50%) rotate(-90deg);" />
          </div>
        </div>
        <div class="title-controls">
          <div style="text-align:center; margin-bottom:12px; font-family: 'Bebas Neue', sans-serif; font-size:28px; color:#0b4f4f;">Syed Abbas Ali — Life Island</div>
          <button id="start-exploration" class="begin-button">BEGIN</button>
        </div>
      </div>
      <div class="side-icons" id="side-icons">
        <button class="side-icon" id="icon-profile" aria-label="Open profile"> <img src="/assets/profile-avatar.svg" alt="profile" style="width:28px; height:28px; border-radius:6px;"/></button>
        <button class="side-icon" id="icon-mute" aria-pressed="false" aria-label="Toggle audio">🔈</button>
        <button class="side-icon" id="icon-emote" aria-label="Show emote">😊</button>
      </div>
    `;

    // Add event listeners
    setTimeout(() => {
      const startBtn = document.getElementById('start-exploration');
      const customizeBtn = document.getElementById('customize-character');

  if (startBtn) startBtn.addEventListener('click', () => { try { this.completeOnboarding(); } catch (e) {} this.hideWelcomeScreen(); });
      if (customizeBtn) customizeBtn.addEventListener('click', () => console.log('Customization not yet implemented'));

  const iconCustomize = document.getElementById('icon-customize');
  const iconProfile = document.getElementById('icon-profile');
  const iconMute = document.getElementById('icon-mute');

      if (iconCustomize) iconCustomize.addEventListener('click', () => {
        const modal = document.getElementById('customization-modal');
        if (modal) modal.classList.remove('hidden');
      });
      if (iconProfile) iconProfile.addEventListener('click', () => {
        // open the business zone / profile panel
        const eng = (window as any).engine as any;
        try {
          const zone = eng?.getZonesManager?.().getZoneById?.('business-hub');
          if (zone) this.showInteractionPanel(zone as any);
        } catch (e) { }
      });
  if (iconMute) iconMute.addEventListener('click', () => this.toggleAudio());
  // hide emote quick button in simplified runtime; keep spawnEmote() available for dev/testing
  try { (window as any).spawnEmote = () => { try { this.spawnEmote(); } catch (e) { } }; } catch (e) {}
      // instantiate planet thumbnail
      const planetContainer = document.getElementById('planet-graphic');
      if (planetContainer) {
        // dynamic import to avoid bundler ordering issues
        import('./PlanetThumbnail').then((m) => {
          const instance = m.createPlanetThumbnail(planetContainer as HTMLElement);
          // store on element for disposal later
          (planetContainer as any).__thumbnail = instance;
          // listen for the thumbnail's BEGIN event and transition into the experience
          try {
            planetContainer.addEventListener('planet-begin', () => {
              try {
                // dispose the thumbnail visual
                const inst = (planetContainer as any).__thumbnail;
                if (inst && typeof inst.dispose === 'function') inst.dispose();
              } catch (e) { }
              // hide welcome/onboarding UI so player can interact
              try { this.completeOnboarding(); } catch (e) { }
              try { this.hideWelcomeScreen(); } catch (e) { }
            });
          } catch (e) { }
        }).catch((e) => console.warn('thumbnail load failed', e));
      }
      // Listen for HDRI applied events and show toast
      window.addEventListener('ds:hdri-applied', (e: any) => {
        try {
          const file = e?.detail?.file || 'unknown.hdr';
          try { this.showToast(`Environment applied: ${file}`); } catch (err) { }
        } catch (err) { }
      });
    }, 0);

    return screen;
  }

  private createHUD(): HTMLElement {
    const hud = document.createElement('div');
    hud.className = 'hud';
    hud.innerHTML = `
      <div class="pill" id="hud-deliveries">Deliveries: 0/5</div>
      <div id="hud-objective">Walk to the glowing mailbox</div>
    `;

    // Environment controls button
    const envBtn = document.createElement('button');
    envBtn.id = 'hud-env-btn';
    envBtn.className = 'hud-button';
    envBtn.innerHTML = '🌤️';
    envBtn.title = 'Environment Controls (E)';
    envBtn.style.cssText = `
      position: absolute;
      top: 12px;
      right: 12px;
      width: 44px;
      height: 44px;
      background: rgba(0, 0, 0, 0.6);
      border: 2px solid rgba(255, 255, 255, 0.3);
      border-radius: 50%;
      color: white;
      font-size: 22px;
      cursor: pointer;
      transition: all 0.3s ease;
      z-index: 100;
      display: flex;
      align-items: center;
      justify-content: center;
    `;
    envBtn.addEventListener('mouseenter', () => {
      envBtn.style.background = 'rgba(135, 206, 235, 0.8)';
      envBtn.style.transform = 'scale(1.1)';
    });
    envBtn.addEventListener('mouseleave', () => {
      envBtn.style.background = 'rgba(0, 0, 0, 0.6)';
      envBtn.style.transform = 'scale(1)';
    });
    envBtn.addEventListener('click', () => {
      this.toggleEnvironmentPanel();
    });
    hud.appendChild(envBtn);

    // Ambient indicator
    const ambient = document.createElement('div');
    ambient.id = 'hud-ambient';
    ambient.className = 'hud-ambient';
    ambient.style.position = 'absolute';
    ambient.style.right = '12px';
    ambient.style.top = '64px'; // Moved down to make room for env button
    ambient.style.background = 'rgba(0,0,0,0.6)';
    ambient.style.color = 'white';
    ambient.style.padding = '6px 10px';
    ambient.style.borderRadius = '10px';
    ambient.style.fontSize = '13px';
    ambient.style.display = 'none';
    ambient.textContent = '';
    hud.appendChild(ambient);

  // occlusion indicator (hidden by default)
  const occ = document.createElement('div');
  occ.id = 'hud-occlusion';
  occ.style.position = 'absolute';
  occ.style.left = '12px';
  occ.style.top = '12px';
  occ.style.background = 'rgba(255,255,255,0.06)';
  occ.style.color = 'white';
  occ.style.padding = '6px 10px';
  occ.style.borderRadius = '8px';
  occ.style.fontSize = '12px';
  occ.style.display = 'none';
  occ.style.zIndex = '120';
  occ.textContent = '';
  hud.appendChild(occ);

    // Listen to audio start/stop events
    window.addEventListener('ds:ambient-start', (e: any) => {
      try {
        const key = e?.detail?.key || '';
        ambient.textContent = `Ambient: ${key}`;
        ambient.style.display = 'block';
      } catch (err) { }
    });
    window.addEventListener('ds:ambient-stop', (e: any) => {
      try {
        const key = e?.detail?.key || '';
        // if stopping current, hide
        if (ambient.textContent && ambient.textContent.indexOf(key) !== -1) {
          ambient.style.display = 'none';
          ambient.textContent = '';
        }
      } catch (err) { }
    });
    return hud;
  }

  // HUD occlusion indicator API
  public showOcclusionIndicator(text: string = 'Camera occluded', strength: number = 0.6): void {
    const el = document.getElementById('hud-occlusion');
    if (!el) return;
    el.textContent = text;
    el.style.display = 'block';
    el.style.opacity = String(Math.max(0.3, Math.min(1, strength)));
  }

  public hideOcclusionIndicator(): void {
    const el = document.getElementById('hud-occlusion');
    if (!el) return;
    el.style.display = 'none';
  }

  // Add mobile HUD elements like large interact button and joystick settings
  public showMobileHUD(): void {
    // interact button
    if (!document.getElementById('mobile-interact')) {
      const btn = document.createElement('button');
      btn.id = 'mobile-interact';
      btn.className = 'mobile-interact';
      btn.textContent = 'Interact';
      btn.addEventListener('touchstart', (e) => {
        e.preventDefault();
        const im = (window as any).engine?.getInputManager?.();
        if (im && typeof im.pressAction === 'function') {
          im.pressAction();
        }
      });
      btn.addEventListener('touchend', (e) => {
        e.preventDefault();
        const im = (window as any).engine?.getInputManager?.();
        if (im && typeof im.releaseAction === 'function') {
          im.releaseAction();
        }
      });
      document.body.appendChild(btn);
    }

    // joystick sensitivity control
    if (!document.getElementById('joystick-settings')) {
      const panel = document.createElement('div');
      panel.id = 'joystick-settings';
      panel.className = 'joystick-settings';
      panel.innerHTML = `<label>Joystick Sensitivity <input id="joystick-sens" type="range" min="0.3" max="2" step="0.1" value="1" /></label>
        <div style="margin-top:8px; display:flex; gap:8px;">
          <button id="sens-low" class="btn">Low</button>
          <button id="sens-med" class="btn primary">Medium</button>
          <button id="sens-high" class="btn">High</button>
        </div>`;
      document.body.appendChild(panel);
      setTimeout(() => {
        const input = document.getElementById('joystick-sens') as HTMLInputElement | null;
        if (input) {
          // initialize from persisted joystick or VirtualJoystick
          const vj = (window as any).virtualJoystick as any;
          if (vj && typeof vj.sensitivity === 'number') {
            input.value = String(vj.sensitivity);
          } else {
            try {
              const stored = localStorage.getItem('ds_joystick_sensitivity');
              if (stored) input.value = stored;
            } catch (e) { }
          }

          input.addEventListener('input', () => {
            const v = parseFloat(input.value);
            const vj2 = (window as any).virtualJoystick as any;
            if (vj2 && typeof vj2.setSensitivity === 'function') vj2.setSensitivity(v);
            try { localStorage.setItem('ds_joystick_sensitivity', String(v)); } catch (e) { }
          });
        }
        const low = document.getElementById('sens-low');
        const med = document.getElementById('sens-med');
        const high = document.getElementById('sens-high');
  if (low) low.addEventListener('click', () => { const vj = (window as any).virtualJoystick as any; if (vj && typeof vj.setSensitivity === 'function') { vj.setSensitivity(0.6); (document.getElementById('joystick-sens') as HTMLInputElement).value = '0.6'; localStorage.setItem('ds_joystick_sensitivity','0.6'); } });
  if (med) med.addEventListener('click', () => { const vj = (window as any).virtualJoystick as any; if (vj && typeof vj.setSensitivity === 'function') { vj.setSensitivity(1.0); (document.getElementById('joystick-sens') as HTMLInputElement).value = '1'; localStorage.setItem('ds_joystick_sensitivity','1'); } });
  if (high) high.addEventListener('click', () => { const vj = (window as any).virtualJoystick as any; if (vj && typeof vj.setSensitivity === 'function') { vj.setSensitivity(1.6); (document.getElementById('joystick-sens') as HTMLInputElement).value = '1.6'; localStorage.setItem('ds_joystick_sensitivity','1.6'); } });
      }, 0);
    }
  }

  // Audio settings panel
  public showAudioSettings(): void {
    if (document.getElementById('audio-settings-panel')) return;
    const panel = document.createElement('div');
    panel.id = 'audio-settings-panel';
    panel.className = 'interaction-panel';
    panel.innerHTML = `
      <h3>Audio Settings</h3>
      <label>Volume <input id="audio-vol" type="range" min="0" max="1" step="0.01" value="1" /></label>
      <div style="margin-top:12px; display:flex; gap:8px;">
        <button id="audio-mute" class="btn">Mute/Unmute</button>
        <button id="audio-close" class="btn secondary">Close</button>
      </div>
    `;
    this.container.appendChild(panel);
    setTimeout(() => {
      const vol = document.getElementById('audio-vol') as HTMLInputElement | null;
      const mute = document.getElementById('audio-mute');
      const close = document.getElementById('audio-close');
      const am = (window as any).audioManager as import('./AudioManager').AudioManager | undefined;
      if (vol && am) {
        vol.value = String(am.getVolume());
        vol.addEventListener('input', () => { am.setVolume(parseFloat(vol.value)); });
      }
      if (mute && am) mute.addEventListener('click', () => { am.toggleMute(); });
      if (close) close.addEventListener('click', () => panel.remove());
      // Populate quick audio list from asset manifest
      (async () => {
        try {
          const r = await fetch('/assets/asset-manifest.json');
          if (!r.ok) return;
          const m = await r.json();
          if (Array.isArray(m.audio) && m.audio.length) {
            const list = document.createElement('div');
            list.style.marginTop = '12px';
            list.innerHTML = '<strong>Available audio</strong>';
            (m.audio || []).forEach((a: string) => {
              const row = document.createElement('div');
              row.style.display = 'flex'; row.style.gap = '8px'; row.style.alignItems = 'center'; row.style.marginTop = '8px';
              const label = document.createElement('div'); label.textContent = a.replace(/\.[^/.]+$/, ''); label.style.flex = '1'; label.style.fontSize = '13px'; label.style.color = 'var(--muted)';
              const play = document.createElement('button'); play.className = 'btn'; play.textContent = 'Preview';
              play.addEventListener('click', () => { try { const audio = new Audio('/assets/' + a); audio.play(); } catch (e) { console.warn('preview failed', e); } });
              row.appendChild(label); row.appendChild(play); list.appendChild(row);
            });
            panel.appendChild(list);
          }
        } catch (e) { /* ignore manifest errors */ }
      })();
    }, 0);
  }

  // Simple customization modal
  private createCustomizationModal(): HTMLElement {
    const modal = document.createElement('div');
    modal.className = 'interaction-panel hidden';
    modal.id = 'customization-modal';
    modal.innerHTML = `
      <h2>Customize Character</h2>
      <div class="customization-options">
        <div class="customization-option">
          <label>Skin Tone</label>
          <div class="color-options" id="skin-options"></div>
        </div>
        <div class="customization-option">
          <label>Outfit Color</label>
          <div class="color-options" id="outfit-options"></div>
        </div>
        <div class="customization-option">
          <label>Hair Color</label>
          <div class="color-options" id="hair-options"></div>
        </div>
      </div>
      <div class="customization-buttons">
        <button class="primary" id="apply-customize">Apply</button>
        <button class="secondary" id="close-customize">Cancel</button>
      </div>
    `;
    setTimeout(() => {
      // Color palettes
      const skinColors = [0xffddaa, 0xf2c49b, 0xe1a16a, 0x8d5524, 0xc68642, 0xffe0bd, 0xf1c27d, 0x7f4a19];
      const outfitColors = [0xff6b6b, 0x5b6cff, 0x88dd88, 0xffd166, 0x6ee7b7, 0x3b82f6, 0xf472b6, 0x22223b];
      const hairColors = [0x8b4513, 0x22223b, 0xf1c27d, 0x000000, 0xffffff, 0xc68642, 0x6d4c41, 0xdeb887];

      function makeColorOption(color: number, group: HTMLElement, selected: boolean): HTMLDivElement {
        const el = document.createElement('div');
        el.className = 'color-option' + (selected ? ' selected' : '');
        el.style.background = `#${color.toString(16).padStart(6, '0')}`;
        el.addEventListener('click', () => {
          Array.from(group.children).forEach((c: Element) => (c as HTMLElement).classList.remove('selected'));
          el.classList.add('selected');
        });
        el.dataset.color = color.toString();
        return el;
      }

      // Populate color pickers
  const skinGroup = document.getElementById('skin-options') as HTMLElement;
  const outfitGroup = document.getElementById('outfit-options') as HTMLElement;
  const hairGroup = document.getElementById('hair-options') as HTMLElement;
  if (skinGroup) skinColors.forEach((c, i) => skinGroup.appendChild(makeColorOption(c, skinGroup, i === 0)));
  if (outfitGroup) outfitColors.forEach((c, i) => outfitGroup.appendChild(makeColorOption(c, outfitGroup, i === 0)));
  if (hairGroup) hairColors.forEach((c, i) => hairGroup.appendChild(makeColorOption(c, hairGroup, i === 0)));

      // Apply customization
      const applyBtn = document.getElementById('apply-customize');
      if (applyBtn) applyBtn.addEventListener('click', () => {
        const getSelected = (group: HTMLElement): number | undefined => {
          const sel = group.querySelector('.selected') as HTMLElement | null;
          return sel ? parseInt(sel.dataset.color || '') : undefined;
        };
        const skin = getSelected(skinGroup);
        const outfit = getSelected(outfitGroup);
        const hair = getSelected(hairGroup);
        // Update player customization
        const globalEngine = (window as any).engine;
        if (globalEngine && globalEngine.player) {
          globalEngine.player.updateCustomization({ skinColor: skin, outfitColor: outfit, hairColor: hair });
        }
        modal.classList.add('hidden');
      });
      // Cancel button
      const closeBtn = document.getElementById('close-customize');
      if (closeBtn) closeBtn.addEventListener('click', () => modal.classList.add('hidden'));
    }, 0);
    return modal;
  }

  // Graphics/effects settings panel
  public showGraphicsSettings(): void {
    if (document.getElementById('graphics-settings')) return;
    const panel = document.createElement('div');
    panel.id = 'graphics-settings';
    panel.className = 'interaction-panel';
    panel.innerHTML = `
      <h3>Graphics & Effects</h3>
      <div style="margin-bottom:8px; display:flex; gap:8px;">
        <button id="graphics-warm" class="btn">Warm Preset</button>
      </div>
      <label>Postprocessing <input id="pp-toggle" type="checkbox" checked /></label>
      <div style="margin-top:8px;">
        <label>Import HDRI URL <input id="hdri-url" type="text" placeholder="/assets/your.hdr" style="width: 240px;" /></label>
        <button id="hdri-load" class="btn">Load</button>
        <div style="margin-top:8px;">Or upload HDRI: <input id="hdri-file" type="file" accept=".hdr,.exr" /></div>
      </div>
      <div style="margin-top:8px;">
        <label>SSAO Radius <input id="ssao-radius" type="range" min="0" max="12" step="1" value="8" /></label>
        <label>SSAO MinDist <input id="ssao-min" type="range" min="0.001" max="0.02" step="0.001" value="0.005" /></label>
        <label>SSAO MaxDist <input id="ssao-max" type="range" min="0.05" max="0.6" step="0.01" value="0.2" /></label>
        <label>Bloom Strength <input id="bloom-strength" type="range" min="0" max="2" step="0.05" value="0.3" /></label>
        <label>Exposure <input id="exposure" type="range" min="0.2" max="2" step="0.05" value="1" /></label>
        <label style="display:block; margin-top:8px;">House Warm Lights <input id="house-warm-toggle" type="checkbox" checked />
          <div style="margin-top:6px;"><label>Warm Intensity <input id="house-warm-intensity" type="range" min="0" max="2" step="0.05" value="0.55" /></label></div>
        </label>
      </div>
      <div style="margin-top:12px; display:flex; gap:8px; justify-content:flex-end;">
        <button id="hdri-boost-toggle" class="btn">HDR Boost</button>
        <button id="hdri-restore" class="btn secondary">Restore Visuals</button>
        <button id="graphics-close" class="btn secondary">Close</button>
      </div>
    `;
    this.container.appendChild(panel);

    setTimeout(() => {
      const toggle = document.getElementById('pp-toggle') as HTMLInputElement | null;
      const ssaoRadius = document.getElementById('ssao-radius') as HTMLInputElement | null;
      const ssaoMin = document.getElementById('ssao-min') as HTMLInputElement | null;
      const ssaoMax = document.getElementById('ssao-max') as HTMLInputElement | null;
      const bloomStrength = document.getElementById('bloom-strength') as HTMLInputElement | null;
      const exposure = document.getElementById('exposure') as HTMLInputElement | null;
      const close = document.getElementById('graphics-close');
      const engine = (window as any).engine as any;
      const rendererCtrl = engine?.getRendererController?.();
      if (toggle && rendererCtrl) {
        toggle.checked = true;
        // restore saved value
        try { const saved = localStorage.getItem('ds_graphics_postprocessing'); if (saved !== null) toggle.checked = saved === '1'; } catch (e) {}
        toggle.addEventListener('change', () => { rendererCtrl.setPostProcessingEnabled(toggle.checked); try { localStorage.setItem('ds_graphics_postprocessing', toggle.checked ? '1' : '0'); } catch (e) {} });
      }
      const hdriUrl = document.getElementById('hdri-url') as HTMLInputElement | null;
      const hdriLoad = document.getElementById('hdri-load');
      const hdriFile = document.getElementById('hdri-file') as HTMLInputElement | null;
      if (hdriLoad && hdriUrl && rendererCtrl) {
        hdriLoad.addEventListener('click', async () => {
          const url = hdriUrl.value.trim();
          if (!url) { try { this.showToast('Please enter an HDRI URL'); } catch (e) {} return; }
          const env = await rendererCtrl.loadEnvironmentFromUrl(url);
          if (env) {
            const eng = (window as any).engine as any;
            const scene = eng?.getScene?.();
            if (scene) scene.environment = env;
            try { this.showToast('HDRI loaded and applied'); } catch (e) {}
          } else { try { this.showToast('Failed to load HDRI'); } catch (e) {} }
        });
      }
      if (hdriFile && rendererCtrl) {
        hdriFile.addEventListener('change', async () => {
          const f = hdriFile.files && hdriFile.files[0];
          if (!f) return;
          const blobUrl = URL.createObjectURL(f);
          const env = await rendererCtrl.loadEnvironmentFromUrl(blobUrl);
          if (env) {
            const eng = (window as any).engine as any;
            const scene = eng?.getScene?.();
            if (scene) scene.environment = env;
            try { this.showToast('HDRI uploaded and applied'); } catch (e) {}
          } else {
            try { this.showToast('Failed to load uploaded HDRI'); } catch (e) {}
          }
        });
      }
      // restore saved sliders
      try {
        const savedSSAO = localStorage.getItem('ds_graphics_ssao');
        if (savedSSAO && ssaoRadius && ssaoMin && ssaoMax) {
          const s = JSON.parse(savedSSAO);
          ssaoRadius.value = String(s.kernelRadius || ssaoRadius.value);
          ssaoMin.value = String(s.minDistance || ssaoMin.value);
          ssaoMax.value = String(s.maxDistance || ssaoMax.value);
          rendererCtrl && rendererCtrl.setSSAOParams({ kernelRadius: parseFloat(ssaoRadius.value), minDistance: parseFloat(ssaoMin.value), maxDistance: parseFloat(ssaoMax.value) });
        }
      } catch (e) { }
      if (ssaoRadius && rendererCtrl) ssaoRadius.addEventListener('input', () => { rendererCtrl.setSSAOParams({ kernelRadius: parseFloat(ssaoRadius.value) }); try { const cur = { kernelRadius: parseFloat(ssaoRadius.value), minDistance: parseFloat(ssaoMin?.value || '0'), maxDistance: parseFloat(ssaoMax?.value || '0') }; localStorage.setItem('ds_graphics_ssao', JSON.stringify(cur)); } catch (e) {} });
      if (ssaoMin && rendererCtrl) ssaoMin.addEventListener('input', () => { rendererCtrl.setSSAOParams({ minDistance: parseFloat(ssaoMin.value) }); try { const cur = { kernelRadius: parseFloat(ssaoRadius?.value || '0'), minDistance: parseFloat(ssaoMin.value), maxDistance: parseFloat(ssaoMax?.value || '0') }; localStorage.setItem('ds_graphics_ssao', JSON.stringify(cur)); } catch (e) {} });
      if (ssaoMax && rendererCtrl) ssaoMax.addEventListener('input', () => { rendererCtrl.setSSAOParams({ maxDistance: parseFloat(ssaoMax.value) }); try { const cur = { kernelRadius: parseFloat(ssaoRadius?.value || '0'), minDistance: parseFloat(ssaoMin?.value || '0'), maxDistance: parseFloat(ssaoMax.value) }; localStorage.setItem('ds_graphics_ssao', JSON.stringify(cur)); } catch (e) {} });
      try {
        const savedBloom = localStorage.getItem('ds_graphics_bloom');
        if (savedBloom && bloomStrength) { const sb = JSON.parse(savedBloom); bloomStrength.value = String(sb.strength || bloomStrength.value); rendererCtrl && rendererCtrl.setBloomParams({ strength: parseFloat(bloomStrength.value) }); }
      } catch (e) { }
      if (bloomStrength && rendererCtrl) bloomStrength.addEventListener('input', () => { rendererCtrl.setBloomParams({ strength: parseFloat(bloomStrength.value) }); try { localStorage.setItem('ds_graphics_bloom', JSON.stringify({ strength: parseFloat(bloomStrength.value) })); } catch (e) {} });
      try {
        const savedExposure = localStorage.getItem('ds_graphics_exposure');
        if (savedExposure && exposure) { exposure.value = savedExposure; rendererCtrl && rendererCtrl.setExposure(parseFloat(exposure.value)); }
      } catch (e) { }
      if (exposure && rendererCtrl) exposure.addEventListener('input', () => { rendererCtrl.setExposure(parseFloat(exposure.value)); try { localStorage.setItem('ds_graphics_exposure', exposure.value); } catch (e) {} });
      const hdriBoost = document.getElementById('hdri-boost-toggle');
      const hdriRestore = document.getElementById('hdri-restore');
      const warmBtn = document.getElementById('graphics-warm');
      if (warmBtn && rendererCtrl) warmBtn.addEventListener('click', () => {
        try {
          // apply warmer preset values
          rendererCtrl.setBloomParams({ strength: 0.45, radius: 0.6, threshold: 0.9 });
          rendererCtrl.setSSAOParams({ kernelRadius: 10, minDistance: 0.006, maxDistance: 0.25 });
          rendererCtrl.setExposure(1.05);
          // persist presets
          try { localStorage.setItem('ds_graphics_bloom', JSON.stringify({ strength: 0.45 })); } catch (e) {}
          try { localStorage.setItem('ds_graphics_ssao', JSON.stringify({ kernelRadius: 10, minDistance: 0.006, maxDistance: 0.25 })); } catch (e) {}
          try { localStorage.setItem('ds_graphics_exposure', String(1.05)); } catch (e) {}
          // update UI elements
          const b = document.getElementById('bloom-strength') as HTMLInputElement | null; if (b) b.value = '0.45';
          const eInp = document.getElementById('exposure') as HTMLInputElement | null; if (eInp) eInp.value = '1.05';
          const ss = document.getElementById('ssao-radius') as HTMLInputElement | null; if (ss) ss.value = '10';
        } catch (err) { console.warn('warm preset apply failed', err); }
      });
      if (hdriBoost) hdriBoost.addEventListener('click', () => {
        try {
          const fn = (window as any).makeHDRIVisible as Function | undefined;
          if (fn) { fn({}); hdriBoost.textContent = 'HDR Boost (applied)'; }
          else { try { this.showToast('HDRI helper not available'); } catch (e) {} }
        } catch (e) { console.warn('HDR boost failed', e); }
      });
      if (hdriRestore) hdriRestore.addEventListener('click', () => {
        try {
          const fn = (window as any).restoreOriginalMaterials as Function | undefined;
          if (fn) { fn(); if (hdriBoost) hdriBoost.textContent = 'HDR Boost'; }
          else { try { this.showToast('Restore helper not available'); } catch (e) {} }
        } catch (e) { console.warn('restore visuals failed', e); }
      });
      if (close) close.addEventListener('click', () => panel.remove());
      // House warm light controls
      try {
        const houseToggle = document.getElementById('house-warm-toggle') as HTMLInputElement | null;
        const houseIntensity = document.getElementById('house-warm-intensity') as HTMLInputElement | null;
        const applyHouseSettings = (enabled: boolean, intensity: number) => {
          try {
            const eng = (window as any).engine as any;
            const scene = eng?.getScene?.() as THREE.Scene | undefined;
            if (!scene) return;
            scene.traverse((obj: any) => {
              try {
                if (obj && obj.isLight && obj.userData && obj.userData.isHouseWarmLight) {
                  obj.visible = !!enabled;
                  obj.intensity = intensity;
                }
              } catch (e) {}
            });
          } catch (e) { }
        };

        // restore saved values
        try {
          const saved = localStorage.getItem('ds_house_warm_light');
          if (saved && houseToggle && houseIntensity) {
            const s = JSON.parse(saved);
            houseToggle.checked = !!s.enabled;
            houseIntensity.value = String(typeof s.intensity === 'number' ? s.intensity : parseFloat(houseIntensity.value));
            applyHouseSettings(houseToggle.checked, parseFloat(houseIntensity.value));
          } else if (houseIntensity && houseToggle) {
            applyHouseSettings(houseToggle.checked, parseFloat(houseIntensity.value));
          }
        } catch (e) { if (houseToggle && houseIntensity) applyHouseSettings(houseToggle.checked, parseFloat(houseIntensity.value)); }

        if (houseToggle && houseIntensity) {
          houseToggle.addEventListener('change', () => {
            const enabled = houseToggle.checked;
            const intensity = parseFloat(houseIntensity.value || '0.55');
            applyHouseSettings(enabled, intensity);
            try { localStorage.setItem('ds_house_warm_light', JSON.stringify({ enabled, intensity })); } catch (e) {}
          });
          houseIntensity.addEventListener('input', () => {
            const enabled = houseToggle.checked;
            const intensity = parseFloat(houseIntensity.value || '0.55');
            applyHouseSettings(enabled, intensity);
            try { localStorage.setItem('ds_house_warm_light', JSON.stringify({ enabled, intensity })); } catch (e) {}
          });
        }
      } catch (e) { /* tolerant */ }
    }, 0);
    // persist default graphics settings when shown
    try { localStorage.setItem('ds_graphics_panel_opened', '1'); } catch (e) { }
  }

  // Save and restore graphics presets + panel state
  public saveGraphicsPreset(name: string, settings: any): void {
    try { localStorage.setItem('ds_graphics_preset_' + name, JSON.stringify(settings)); } catch (e) { }
  }

  public loadGraphicsPreset(name: string): any | null {
    try { const v = localStorage.getItem('ds_graphics_preset_' + name); return v ? JSON.parse(v) : null; } catch (e) { return null; }
  }

  public saveUIState(): void {
    try {
      const panels = {
        graphicsOpened: !!localStorage.getItem('ds_graphics_panel_opened')
      };
      localStorage.setItem('ds_ui_state', JSON.stringify(panels));
    } catch (e) { }
  }

  public restoreUIState(): void {
    try {
      const raw = localStorage.getItem('ds_ui_state');
      if (!raw) return;
      const state = JSON.parse(raw);
      if (state.graphicsOpened) this.showGraphicsSettings();
    } catch (e) { }
  }

  private audioEnabled: boolean = true;

  private toggleAudio(): void {
    const am = (window as any).audioManager as import('./AudioManager').AudioManager | undefined;
    if (am) {
      const muted = am.toggleMute();
      this.audioEnabled = !muted;
      // Update icon if present
      const icon = document.getElementById('icon-mute');
      if (icon) icon.textContent = muted ? '🔇' : '🔈';
      // small visual feedback
      const msg = document.createElement('div');
      msg.className = 'toast';
      msg.textContent = muted ? 'Audio muted' : 'Audio enabled';
      msg.style.position = 'fixed';
      msg.style.bottom = '24px';
      msg.style.left = '50%';
      msg.style.transform = 'translateX(-50%)';
      msg.style.background = 'rgba(0,0,0,0.7)';
      msg.style.color = 'white';
      msg.style.padding = '8px 14px';
      msg.style.borderRadius = '10px';
      msg.style.zIndex = '1200';
      document.body.appendChild(msg);
      setTimeout(() => msg.remove(), 1200);
    } else {
      this.audioEnabled = !this.audioEnabled;
      try { this.showToast(`Audio ${this.audioEnabled ? 'enabled' : 'muted'}`); } catch (e) { }
    }
  }

  private spawnEmote(): void {
    // spawn a transient emote bubble in center of screen
    const el = document.createElement('div');
    el.className = 'emote-bubble';
    el.textContent = '😊';
    el.style.position = 'fixed';
    el.style.left = '50%';
    el.style.top = '60%';
    el.style.transform = 'translate(-50%,-50%) scale(0.6)';
    el.style.fontSize = '36px';
    el.style.zIndex = '200';
    document.body.appendChild(el);
    // animate and remove
    requestAnimationFrame(() => { el.style.transition = 'transform 800ms cubic-bezier(.2,.8,.2,1), opacity 800ms'; el.style.transform = 'translate(-50%,-120%) scale(1)'; el.style.opacity = '0'; });
    setTimeout(() => el.remove(), 900);
  }

  private createInteractionPanel(): HTMLElement {
    const panel = document.createElement('div');
    panel.className = 'interaction-panel hidden';
    panel.innerHTML = `
      <h2 id="panel-title">Zone Title</h2>
      <p id="panel-description">Zone description goes here.</p>
      <div id="panel-content"></div>
      <button id="panel-close">Close</button>
    `;

    setTimeout(() => {
      const closeBtn = document.getElementById('panel-close');
      if (closeBtn) {
        closeBtn.addEventListener('click', () => this.hideInteractionPanel());
      }
    }, 0);

    return panel;
  }

  private createChatWindow(): HTMLElement {
    const chatWindow = document.createElement('div');
    chatWindow.className = 'chat-window hidden';
    chatWindow.innerHTML = `
      <div class="chat-header">
        <div style="display:flex; gap:12px; align-items:center;">
          <div style="width:40px;height:40px;border-radius:10px;background:linear-gradient(90deg,var(--primary),var(--primary-600));display:flex;align-items:center;justify-content:center;color:white;font-weight:700;">A</div>
          <div>
            <div style="font-weight:700">AI Guide</div>
            <div style="font-size:12px; color:var(--muted)">I'm here to help — press C to toggle</div>
          </div>
        </div>
        <button class="chat-close" id="chat-close">×</button>
      </div>
      <div class="chat-messages" id="chat-messages"></div>
      <div class="chat-input-container">
        <input type="text" id="chat-input" placeholder="Ask me anything..." />
        <button id="chat-send">Send</button>
      </div>
    `;

    setTimeout(() => {
      this.chatMessages = document.getElementById('chat-messages') as HTMLElement;
      this.chatInput = document.getElementById('chat-input') as HTMLInputElement;

      const closeBtn = document.getElementById('chat-close');
      const sendBtn = document.getElementById('chat-send');

      if (closeBtn) {
        closeBtn.addEventListener('click', () => this.hideChatWindow());
      }

      if (sendBtn && this.chatInput) {
        sendBtn.addEventListener('click', () => this.sendChatMessage());
        this.chatInput.addEventListener('keypress', (e) => {
          if (e.key === 'Enter') this.sendChatMessage();
        });
      }
    }, 0);

    return chatWindow;
  }

  private setupChatSystem(): void {
    this.chatSystem.onMessage((message) => {
      this.addChatMessage(message);
    });

    // Display initial messages
    this.chatSystem.getMessages().forEach((message) => {
      this.addChatMessage(message);
    });
  }

  private addChatMessage(message: ChatMessage): void {
    if (!this.chatMessages) return;

    const messageEl = document.createElement('div');
    messageEl.className = `chat-message ${message.sender}`;
    messageEl.textContent = message.text;
    this.chatMessages.appendChild(messageEl);

    // Scroll to bottom
    this.chatMessages.scrollTop = this.chatMessages.scrollHeight;
  }

  private async sendChatMessage(): Promise<void> {
    if (!this.chatInput) return;

    const text = this.chatInput.value.trim();
    if (!text) return;

    this.chatInput.value = '';
    await this.chatSystem.sendMessage(text);
  }

  // Public methods for showing/hiding UI elements
  public updateLoadingProgress(progress: number): void {
    const progressBar = document.getElementById('loading-progress-bar');
    if (progressBar) {
      progressBar.style.width = `${progress * 100}%`;
    }
  }

  public hideLoadingScreen(): void {
    if (this.loadingScreen) {
      this.loadingScreen.classList.add('hidden');
      setTimeout(() => {
        this.showWelcomeScreen();
      }, 500);
    }
  }

  public showWelcomeScreen(): void {
    if (this.welcomeScreen) {
      this.welcomeScreen.classList.remove('hidden');
    }
  }

  public hideWelcomeScreen(): void {
    if (this.welcomeScreen) {
      this.welcomeScreen.classList.add('hidden');
      const overlay = document.getElementById('onboarding-overlay'); if (overlay) overlay.remove();
      const backdrop = document.getElementById('onboarding-backdrop'); if (backdrop) backdrop.remove();
    }
  }

  public updateHUD(text: string): void {
    const objective = document.getElementById('hud-objective');
    if (objective) {
      objective.textContent = text;
    }
  }

  public showInteractionPanel(zone: Zone): void {
    if (!this.interactionPanel) return;

    const title = document.getElementById('panel-title');
    const description = document.getElementById('panel-description');
    const content = document.getElementById('panel-content');

    if (title) title.textContent = zone.name;
    if (description) description.textContent = zone.description;

    // Add zone-specific content
    if (content) {
      switch (zone.id) {
        case 'business-hub':
          content.innerHTML = this.createBusinessHubContent();
          break;
        case 'hobby-cove':
          content.innerHTML = this.createHobbyCoveContent();
          break;
        case 'achievement-hall':
          content.innerHTML = this.createAchievementHallContent();
          break;
        case 'memory-garden':
          content.innerHTML = this.createMemoryGardenContent();
          break;
        case 'contact-dock':
          content.innerHTML = this.createContactDockContent();
          break;
        default:
          content.innerHTML = `<p>More content about ${zone.name} coming soon!</p>`;
      }
      // Attach lightweight handlers (project links, audio previews) after content inserted
      setTimeout(() => {
        // Project links and gallery triggers
        Array.from(content.querySelectorAll('[data-project-link], [data-image-src], [data-gallery]')).forEach((el) => {
          el.addEventListener('click', (e) => {
            const projectUrl = (el as HTMLElement).getAttribute('data-project-link');
            const imageSrc = (el as HTMLElement).getAttribute('data-image-src');
            const gallery = (el as HTMLElement).getAttribute('data-gallery');
            if (gallery) {
              // comma-separated list
              const items = gallery.split(',').map(s => s.trim()).filter(Boolean).map(s => ({ src: s }));
              if (items.length) this.openGallery(items, 0);
              return;
            }
            if (imageSrc) {
              this.openGallery([{ src: imageSrc }], 0);
              return;
            }
            if (projectUrl) {
              // if it's an image link, open in gallery, else open new tab
              if (/(\.png|\.jpg|\.jpeg|\.svg|\.webp)$/i.test(projectUrl)) {
                this.openGallery([{ src: projectUrl }], 0);
              } else {
                window.open(projectUrl, '_blank');
              }
            }
          });
        });
        // Audio previews
        Array.from(content.querySelectorAll('[data-audio-src]')).forEach((el) => {
          el.addEventListener('click', (e) => {
            const src = (el as HTMLElement).getAttribute('data-audio-src');
            if (!src) return;
            try {
              const audio = new Audio(src);
              audio.play();
            } catch (err) { console.warn('preview play failed', err); }
          });
        });
      }, 0);
    }

    this.interactionPanel.classList.remove('hidden');
  }

  public hideInteractionPanel(): void {
    if (this.interactionPanel) {
      this.interactionPanel.classList.add('hidden');
    }
  }

  public showChatWindow(): void {
    if (this.chatWindow) {
      this.chatWindow.classList.remove('hidden');
    }
  }

  public hideChatWindow(): void {
    if (this.chatWindow) {
      this.chatWindow.classList.add('hidden');
    }
  }

  public toggleChatWindow(): void {
    if (this.chatWindow) {
      if (this.chatWindow.classList.contains('hidden')) {
        this.showChatWindow();
      } else {
        this.hideChatWindow();
      }
    }
  }

  private createContactDockContent(): string {
    // Personalized contact/portfolio card for Syed
    return `
      <div style="margin-top: 10px; display:flex; gap:12px; align-items:flex-start;">
        <img src="/assets/profile-avatar.svg" alt="Syed Abbas Ali" style="width:96px; height:96px; border-radius:12px;" />
        <div style="flex:1">
          <h3 style="margin:0;">Syed Abbas Ali</h3>
          <div style="color:var(--muted); font-size:13px; margin-bottom:8px;">Engineer, designer, and creator. I build web apps, experiments, and small tools.</div>
          <div style="display:flex; gap:8px; flex-wrap:wrap; margin-top:6px;">
            <button id="open-chat" class="btn">Chat</button>
            <button id="open-feedback" class="btn">Feedback</button>
            <button id="open-appointment" class="btn">Schedule</button>
            <a href="/assets/project-thumbnail.svg" target="_blank" class="btn" style="text-decoration:none;">View Portfolio</a>
          </div>
        </div>
      </div>
      <div style="margin-top:12px; display:flex; gap:12px;">
        <img src="/assets/project-thumbnail.svg" style="width:120px; height:80px; border-radius:8px;" alt="project" />
        <img src="/assets/achievement-badge.svg" style="width:80px; height:80px;" alt="badge" />
      </div>
    `;
  }

  // --- Zone content generators ---
  private createBusinessHubContent(): string {
    const projects = (this.profileData && Array.isArray(this.profileData.projects) && this.profileData.projects.length) ? this.profileData.projects : [
      { title: 'Project One', description: 'A web tool for visual storytelling.', url: '/assets/project-thumbnail.svg' },
      { title: 'Project Two', description: 'An experiment in UI/UX and microinteractions.', url: '/assets/project-thumbnail.svg' },
    ];

    const cards = projects.map((p: any) => {
      const galleryAttr = Array.isArray(p.gallery) && p.gallery.length ? ` data-gallery="${p.gallery.join(',')}"` : '';
      const imgSrc = p.image || '/assets/project-thumbnail.svg';
      return `
      <button class="project-card" data-project-link="${p.url || '#'}" data-image-src="${imgSrc}"${galleryAttr} style="width:200px; cursor:pointer; text-align:left; border: none; background: transparent; padding:0;">
        <img src="${imgSrc}" style="width:100%; height:120px; object-fit:cover; border-radius:8px; display:block;" alt="${p.title}" />
        <div style="padding:8px;"><strong>${p.title}</strong><div style="font-size:12px; color:var(--muted)">${p.description || ''}</div></div>
      </button>
    `;
    }).join('');

    return `
      <div style="display:flex; flex-direction:column; gap:10px;">
        <p style="margin:0; color:var(--muted)">${this.profileData?.headline || 'Selected portfolio work by Syed. Click a card to open the project.'}</p>
        <div style="display:flex; gap:12px; flex-wrap:wrap; margin-top:8px;">${cards}</div>
      </div>
    `;
  }

  private createHobbyCoveContent(): string {
    const hobbies = (this.profileData && Array.isArray(this.profileData.hobbies) && this.profileData.hobbies.length) ? this.profileData.hobbies : [
      { title: 'Music Sketch', image: '/assets/hobby-music.svg', audio: '/assets/ambient-hobby.mp3' },
      { title: 'Art Sketch', image: '/assets/hobby-art.svg', audio: '' },
    ];

    const cards = hobbies.map((h: any) => `
      <button class="hobby-card" data-audio-src="${h.audio || ''}" style="width:180px; cursor:pointer; text-align:center; border:none; background:transparent; padding:0;">
        <img src="${h.image || '/assets/hobby-music.svg'}" style="width:100%; height:100px; object-fit:cover; border-radius:10px; display:block;" alt="${h.title}" />
        <div style="padding:8px;"><strong>${h.title}</strong><div style="font-size:12px; color:var(--muted)">${h.description || ''}</div></div>
      </button>
    `).join('');

    const authorLine = this.profileData?.author ? `<div style="font-size:13px; color:var(--muted)">Curated by <strong>${this.profileData.author}</strong></div>` : '';
    return `
      <div style="display:flex; flex-direction:column; gap:10px;">
        ${authorLine}
        <p style="margin:0; color:var(--muted)">${this.profileData?.hobbyIntro || 'Music and art experiments. Tap cards to preview.'}</p>
        <div style="display:flex; gap:12px; flex-wrap:wrap; margin-top:8px;">${cards}</div>
      </div>
    `;
  }

  private createAchievementHallContent(): string {
    const timeline = (this.profileData && Array.isArray(this.profileData.timeline) && this.profileData.timeline.length) ? this.profileData.timeline : [
      { year: '2016', text: 'Graduated with Honors' },
      { year: '2019', text: 'Launched First Product' },
      { year: '2022', text: 'Open Source Contributions' },
    ];

    const items = timeline.map((t: any) => `<li style="margin-bottom:8px;"><img src="/assets/achievement-badge.svg" style="width:36px; vertical-align:middle; margin-right:8px;"/> ${t.year} — ${t.text}</li>`).join('');

    return `
      <div style="display:flex; flex-direction:column; gap:12px;">
        <p style="margin:0; color:var(--muted)">${this.profileData?.timelineIntro || 'A timeline of milestones and selected awards.'}</p>
        <ol style="margin:8px 0 0 20px; padding:0;">${items}</ol>
      </div>
    `;
  }

  private createMemoryGardenContent(): string {
    const memories = (this.profileData && Array.isArray(this.profileData.memories) && this.profileData.memories.length) ? this.profileData.memories : [
      { title: 'A quiet essay about beginnings', image: '/assets/project-thumbnail.svg' },
      { title: 'Photos from trips and projects', image: '/assets/project-thumbnail.svg' },
    ];

    const cards = memories.map((m: any) => `
      <button style="width:220px; border:none; background:transparent; padding:0;" data-image-src="${m.image || '/assets/project-thumbnail.svg'}" class="memory-card">
        <img src="${m.image || '/assets/project-thumbnail.svg'}" style="width:100%; height:120px; object-fit:cover; border-radius:8px; display:block;" alt="${m.title}" />
        <div style="padding:8px; font-size:13px; color:var(--muted)">${m.title}</div>
      </button>
    `).join('');

    const authorInfo = this.profileData?.author ? `<div style="font-size:13px; color:var(--muted)">About ${this.profileData.author}</div>` : '';
    return `
      <div style="display:flex; flex-direction:column; gap:10px;">
        ${authorInfo}
        <p style="margin:0; color:var(--muted)">${this.profileData?.bioIntro || "Personal stories, writing, and photos from Syed's life and travels."}</p>
        <div style="display:flex; gap:12px; margin-top:8px; flex-wrap:wrap;">${cards}</div>
      </div>
    `;
  }

  public getChatSystem(): ChatSystem {
    return this.chatSystem;
  }

  public getFeedbackSystem(): FeedbackSystem {
    return this.feedbackSystem;
  }

  public getAppointmentSystem(): AppointmentSystem {
    return this.appointmentSystem;
  }

  // Dialogue helpers
  // showDialogue optionally accepts screenX/screenY to anchor/animate from an NPC bubble
  public showDialogue(title: string, text: string, screenX?: number, screenY?: number): void {
    if (!this.dialogueBox) return;
    this.dialogueQueue = [text];
    this.dialogueTitle = title;
    this.renderDialogue();

    // If anchored coordinates provided, position the dialogue box near that point and animate to center
    try {
      const el = this.dialogueBox;
      if (typeof screenX === 'number' && typeof screenY === 'number') {
        // place the dialogue at the anchor point initially (offset a bit)
        el.style.left = `${screenX}px`;
        el.style.top = `${screenY - 48}px`;
        el.classList.remove('hidden');
        // force starting transform scale/opacity, then animate to centered position
        el.style.transition = 'transform 280ms cubic-bezier(.2,.9,.2,1), opacity 220ms';
        el.style.transform = 'translate(-50%,-50%) scale(0.9)';
        el.style.opacity = '0';
        // allow layout to settle
        requestAnimationFrame(() => {
          // move to center
          el.style.left = '50%';
          el.style.top = '50%';
          el.style.transform = 'translate(-50%,-50%) scale(1)';
          el.style.opacity = '1';
        });
      } else {
        el.classList.remove('hidden');
        el.style.left = '';
        el.style.top = '';
        el.style.transform = '';
        el.style.opacity = '';
      }
    } catch (e) { /* ignore UI animation errors */ }

    this.dialogueVisible = true;
    // listen for keyboard advance
    window.addEventListener('keydown', this.onDialogueKey);
    // Dispatch a custom event so other systems can react to dialogue start
    try {
      const ev = new CustomEvent('ui:dialogue-start', { detail: { title, text } });
      window.dispatchEvent(ev);
    } catch (e) { }
  }

  public hideDialogue(): void {
    if (!this.dialogueBox) return;
    this.dialogueBox.classList.add('hidden');
    this.dialogueVisible = false;
    window.removeEventListener('keydown', this.onDialogueKey);
    // Dispatch a custom event so other systems can react to dialogue end/close
    try {
      const ev = new CustomEvent('ui:dialogue-end', { detail: { title: this.dialogueTitle } });
      window.dispatchEvent(ev);
    } catch (e) { }
  }

  private onDialogueKey = (e: KeyboardEvent) => {
    if (!this.dialogueVisible) return;
    if (e.key === ' ' || e.key.toLowerCase() === 'e') {
      e.preventDefault();
      this.advanceDialogue();
    }
  };

  private advanceDialogue(): void {
    if (this.dialogueQueue.length > 1) {
      // remove current and show next
      this.dialogueQueue.shift();
      this.renderDialogue();
    } else {
      this.hideDialogue();
    }
  }

  private renderDialogue(): void {
    if (!this.dialogueBox) return;
    const label = this.dialogueBox.querySelector('#dialogue-label');
    const body = this.dialogueBox.querySelector('#dialogue-text');
    if (label) (label as HTMLElement).textContent = this.dialogueTitle;
    if (body) (body as HTMLElement).textContent = this.dialogueQueue[0] || '';
  }

  public updateDeliveryCounter(completed: number, total: number): void {
    const el = document.getElementById('hud-deliveries');
    if (el) el.textContent = `Deliveries: ${completed}/${total}`;
  }

  /**
   * Cleanup method to clear all timeouts and prevent memory leaks
   */
  public dispose(): void {
    // Clear all bubble timeouts
    this.bubbleTimeouts.forEach((timeoutId) => {
      try {
        window.clearTimeout(timeoutId);
      } catch (e) {
        // ignore
      }
    });
    this.bubbleTimeouts.clear();
    this.bubbleOwnerMap.clear();
    this.bubbleExpiry.clear();

    // Remove all bubble elements from DOM
    this.bubblePool.forEach((el) => {
      try {
        if (el.parentNode) {
          el.parentNode.removeChild(el);
        }
      } catch (e) {
        // ignore
      }
    });
    this.bubblePool = [];

    // Clear emoji tooltip
    try {
      if (this.emojiTooltip && this.emojiTooltip.parentNode) {
        this.emojiTooltip.parentNode.removeChild(this.emojiTooltip);
      }
    } catch (e) {
      // ignore
    }

    // Clear live region
    try {
      if (this.liveRegion && this.liveRegion.parentNode) {
        this.liveRegion.parentNode.removeChild(this.liveRegion);
      }
    } catch (e) {
      // ignore
    }
  }
}

