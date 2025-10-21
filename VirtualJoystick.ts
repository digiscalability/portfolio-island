export class VirtualJoystick {
  private container: HTMLElement;
  private stick: HTMLElement;
  private base: HTMLElement;
  private active: boolean = false;
  private startX = 0;
  private startY = 0;
  private deltaX = 0;
  private deltaY = 0;
  public sensitivity: number = 1.0;
  // Store bound handlers for cleanup
  private boundHandlers: {
    touchstart: (e: TouchEvent) => void;
    touchmove: (e: TouchEvent) => void;
    touchend: (e: TouchEvent) => void;
  } = {} as any;
  private isDisposed: boolean = false;

  constructor() {
    this.container = document.createElement('div');
    this.container.className = 'virtual-joystick';
    this.base = document.createElement('div');
    this.base.className = 'vj-base';
    this.stick = document.createElement('div');
    this.stick.className = 'vj-stick';
    this.base.appendChild(this.stick);
    this.container.appendChild(this.base);

    this.loadPersistence();
    this.setupListeners();
    document.body.appendChild(this.container);
    this.hide();
  }

  private setupListeners() {
    // Store bound handlers for cleanup
    this.boundHandlers = {
      touchstart: (e) => this.onTouchStart(e),
      touchmove: (e) => this.onTouchMove(e),
      touchend: (e) => this.onTouchEnd(e),
    };

    this.container.addEventListener('touchstart', this.boundHandlers.touchstart, { passive: false });
    this.container.addEventListener('touchmove', this.boundHandlers.touchmove, { passive: false });
    this.container.addEventListener('touchend', this.boundHandlers.touchend);
  }

  private onTouchStart(e: TouchEvent) {
    if (!e.touches || e.touches.length === 0) return;
    const t = e.touches[0];
    this.active = true;
    // position base around touch start for comfortable reach
    this.startX = t.clientX;
    this.startY = t.clientY;
    this.container.style.left = `${Math.max(12, this.startX - 60)}px`;
    this.container.style.bottom = `${Math.max(12, window.innerHeight - this.startY - 60)}px`;
    this.show();
    e.preventDefault();
  }

  private onTouchMove(e: TouchEvent) {
    if (!this.active || !e.touches || e.touches.length === 0) return;
    const t = e.touches[0];
    this.deltaX = t.clientX - this.startX;
    this.deltaY = t.clientY - this.startY;
    const max = 50;
    const dx = Math.max(-max, Math.min(max, this.deltaX));
    const dy = Math.max(-max, Math.min(max, this.deltaY));
    this.stick.style.transform = `translate(${dx}px, ${dy}px)`;
    e.preventDefault();
  }

  private onTouchEnd(_e: TouchEvent) {
    this.active = false;
    this.deltaX = 0;
    this.deltaY = 0;
    this.stick.style.transform = '';
    // hide after a short timeout
    setTimeout(() => this.hide(), 600);
  }

  public getAxes(): { x: number; y: number } {
    // Normalize to -1..1
    const max = 50;
    return { x: Math.max(-1, Math.min(1, (this.deltaX / max) * this.sensitivity)), y: Math.max(-1, Math.min(1, (this.deltaY / max) * this.sensitivity)) };
  }

  // Persistence helpers
  private loadPersistence() {
    try {
      const v = localStorage.getItem('ds_joystick_sensitivity');
      if (v) this.sensitivity = parseFloat(v);
    } catch (e) { /* ignore */ }
  }

  private savePersistence() {
    try {
      localStorage.setItem('ds_joystick_sensitivity', String(this.sensitivity));
    } catch (e) { /* ignore */ }
  }

  // Allow external setting to persist
  public setSensitivity(v: number) {
    this.sensitivity = v;
    this.savePersistence();
  }

  public show(): void {
    this.container.style.opacity = '1';
    this.container.style.transition = 'opacity 180ms';
  }

  public hide(): void {
    this.container.style.opacity = '0.24';
    this.container.style.transition = 'opacity 600ms';
  }

  /**
   * Cleanup method to remove all event listeners and DOM elements
   */
  public dispose(): void {
    if (this.isDisposed) return;
    this.isDisposed = true;

    // Remove event listeners
    this.container.removeEventListener('touchstart', this.boundHandlers.touchstart);
    this.container.removeEventListener('touchmove', this.boundHandlers.touchmove);
    this.container.removeEventListener('touchend', this.boundHandlers.touchend);

    // Remove from DOM
    try {
      if (this.container.parentNode) {
        this.container.parentNode.removeChild(this.container);
      }
    } catch (e) {
      // ignore
    }
  }
}
