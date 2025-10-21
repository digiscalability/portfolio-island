export interface InputState {
  forward: boolean;
  backward: boolean;
  left: boolean;
  right: boolean;
  action: boolean;
  jump: boolean;
  sprint: boolean;
}

export interface Axes {
  x: number; // left (-1) to right (+1)
  y: number; // forward (+1) to backward (-1)
}

export class InputManager {
  private keys: InputState;
  private mousePosition: { x: number; y: number };
  private mouseButtons: { left: boolean; right: boolean; middle: boolean };
  private canvas?: HTMLCanvasElement;
  // Store bound handlers for cleanup
  private boundHandlers: {
    keydown: (e: KeyboardEvent) => void;
    keyup: (e: KeyboardEvent) => void;
    mousemove: (e: MouseEvent) => void;
    mousedown: (e: MouseEvent) => void;
    mouseup: (e: MouseEvent) => void;
    touchstart?: (e: TouchEvent) => void;
    touchmove?: (e: TouchEvent) => void;
    touchend?: (e: TouchEvent) => void;
    canvasClick?: () => void;
  } = {} as any;
  private isDisposed: boolean = false;

  constructor(canvas?: HTMLCanvasElement) {
    this.keys = {
      forward: false,
      backward: false,
      left: false,
      right: false,
      action: false,
      jump: false,
      sprint: false,
    };

    this.mousePosition = { x: 0, y: 0 };
    this.mouseButtons = { left: false, right: false, middle: false };

    this.setupListeners();
    if (canvas) this.attachToCanvas(canvas);
  }

  // When false, getInput() / getAxes() will return neutral inputs and pointer-lock won't be requested
  public controlsEnabled: boolean = true;

  // Optionally set a virtual joystick provider
  private joystickProvider?: { getAxes: () => { x: number; y: number }, getSprint?: () => number };
  // track last time joystick had meaningful non-deadzone input
  private joystickLastActive: number = 0;
  // If true, joystick input will be ignored until explicit activation
  private joystickSquelched: boolean = false;
  // How long (ms) of joystick idle before auto-squelch
  private joystickAutoSquelchMs: number = 2000;
  // Axis magnitude threshold to consider an intentional activation
  private joystickActivationThreshold: number = 0.25;

  // Smooth axes state for callers that want analog input
  private axesState: Axes = { x: 0, y: 0 };
  private axesDeadzone = 0.15;
  private axesSmoothing = 0.16; // lerp factor applied per getAxes(true)

  public setJoystickProvider(provider: { getAxes: () => { x: number; y: number } }) {
    this.joystickProvider = provider;
    // When a new provider is attached, start squelched to avoid immediate drift
    this.joystickSquelched = true;
    this.joystickLastActive = 0;
  }

  // Set a joystick provider that may expose analog sprint (e.g., trigger) via getSprint
  public setJoystickProviderAdvanced(provider: { getAxes: () => { x: number; y: number }, getSprint?: () => number }) {
    this.joystickProvider = provider;
  }

  // returns whether joystick is currently squelched (ignored)
  public isJoystickSquelched(): boolean { return this.joystickSquelched; }

  // Manually unsquelch (allow joystick input). Useful after a button press.
  public unsquelchJoystick(): void { this.joystickSquelched = false; this.joystickLastActive = performance.now(); }

  // Manually squelch joystick input until explicit activation
  public squelchJoystick(): void { this.joystickSquelched = true; this.joystickLastActive = 0; }

  // Returns time (ms) since joystick last had meaningful input (in user scale), or Infinity if none
  public getJoystickIdleMs(): number {
    if (!this.joystickLastActive) return Infinity;
    return performance.now() - this.joystickLastActive;
  }

  // Return a continuous sprint value in range 0..1. If a joystick provider exposes getSprint(), prefer that.
  public getSprintValue(): number {
    try {
      if (this.joystickProvider && typeof this.joystickProvider.getSprint === 'function') {
        const v = this.joystickProvider.getSprint();
        return Math.max(0, Math.min(1, v));
      }
    } catch (e) {
      // ignore
    }
    // Keyboard fallback: shift key acts as binary sprint
    return this.keys.sprint ? 1 : 0;
  }

  // Configure deadzone for analog axes (0..1)
  public setAxesDeadzone(deadzone: number) {
    this.axesDeadzone = Math.max(0, Math.min(1, deadzone));
  }

  // Configure smoothing (lerp factor 0..1). 0 = no smoothing, 1 = instant
  public setAxesSmoothing(factor: number) {
    this.axesSmoothing = Math.max(0, Math.min(1, factor));
  }

  // Programmatic action controls (for mobile HUD buttons)
  public pressAction(): void {
    this.keys.action = true;
  }

  public releaseAction(): void {
    this.keys.action = false;
  }

  private setupListeners(): void {
    // Store bound handlers for cleanup
    this.boundHandlers = {
      keydown: (e) => this.handleKeyDown(e),
      keyup: (e) => this.handleKeyUp(e),
      mousemove: (e) => this.handleMouseMove(e),
      mousedown: (e) => this.handleMouseDown(e),
      mouseup: (e) => this.handleMouseUp(e),
    };

    window.addEventListener('keydown', this.boundHandlers.keydown);
    window.addEventListener('keyup', this.boundHandlers.keyup);
    window.addEventListener('mousemove', this.boundHandlers.mousemove);
    window.addEventListener('mousedown', this.boundHandlers.mousedown);
    window.addEventListener('mouseup', this.boundHandlers.mouseup);
  }

  public attachToCanvas(canvas: HTMLCanvasElement): void {
    this.canvas = canvas;
    // Touch handling
    this.boundHandlers.touchstart = (e) => this.handleTouchStart(e);
    this.boundHandlers.touchmove = (e) => this.handleTouchMove(e);
    this.boundHandlers.touchend = (e) => this.handleTouchEnd(e);
    this.boundHandlers.canvasClick = () => {
      // Only request pointer lock when controls are explicitly enabled (prevent early camera grabs during cinematic)
      if (!this.controlsEnabled) return;
      if ((document as any).pointerLockElement !== canvas) {
        try {
          canvas.requestPointerLock && canvas.requestPointerLock();
        } catch (e) {
          // ignore
        }
      }
    };

    canvas.addEventListener('touchstart', this.boundHandlers.touchstart, { passive: false });
    canvas.addEventListener('touchmove', this.boundHandlers.touchmove, { passive: false });
    canvas.addEventListener('touchend', this.boundHandlers.touchend);
    canvas.addEventListener('click', this.boundHandlers.canvasClick);
  }

  // expose the attached canvas if needed
  public getAttachedCanvas(): HTMLCanvasElement | undefined {
    return this.canvas;
  }

  private handleKeyDown(e: KeyboardEvent): void {
    const key = e.key.toLowerCase();
    switch (key) {
      case 'w':
      case 'arrowup':
        this.keys.forward = true;
        break;
      case 's':
      case 'arrowdown':
        this.keys.backward = true;
        break;
      case 'a':
      case 'arrowleft':
        this.keys.left = true;
        break;
      case 'd':
      case 'arrowright':
        this.keys.right = true;
        break;
      case 'e':
      case ' ':
        this.keys.action = true;
        break;
      case 'shift':
        this.keys.sprint = true;
        break;
      case 'space':
        this.keys.jump = true;
        break;
    }
  // Any explicit keyboard input should unsquelch joystick so user can switch seamlessly
  try { this.unsquelchJoystick(); } catch (e) {}
  }

  private handleKeyUp(e: KeyboardEvent): void {
    const key = e.key.toLowerCase();
    switch (key) {
      case 'w':
      case 'arrowup':
        this.keys.forward = false;
        break;
      case 's':
      case 'arrowdown':
        this.keys.backward = false;
        break;
      case 'a':
      case 'arrowleft':
        this.keys.left = false;
        break;
      case 'd':
      case 'arrowright':
        this.keys.right = false;
        break;
      case 'e':
      case ' ':
        this.keys.action = false;
        break;
      case 'shift':
        this.keys.sprint = false;
        break;
      case 'space':
        this.keys.jump = false;
        break;
    }
  }

  private handleMouseMove(e: MouseEvent): void {
    this.mousePosition.x = (e.clientX / window.innerWidth) * 2 - 1;
    this.mousePosition.y = -(e.clientY / window.innerHeight) * 2 + 1;
  }

  private handleTouchStart(e: TouchEvent): void {
    if (!e.touches || e.touches.length === 0) return;
    const t = e.touches[0];
    this.mousePosition.x = (t.clientX / window.innerWidth) * 2 - 1;
    this.mousePosition.y = -(t.clientY / window.innerHeight) * 2 + 1;
    this.keys.action = true;
    e.preventDefault();
    try { this.unsquelchJoystick(); } catch (e) {}
  }

  private handleTouchMove(e: TouchEvent): void {
    if (!e.touches || e.touches.length === 0) return;
    const t = e.touches[0];
    this.mousePosition.x = (t.clientX / window.innerWidth) * 2 - 1;
    this.mousePosition.y = -(t.clientY / window.innerHeight) * 2 + 1;
    e.preventDefault();
  }

  private handleTouchEnd(_e: TouchEvent): void {
    this.keys.action = false;
  }

  private handleMouseDown(e: MouseEvent): void {
    switch (e.button) {
      case 0:
        this.mouseButtons.left = true;
        break;
      case 1:
        this.mouseButtons.middle = true;
        break;
      case 2:
        this.mouseButtons.right = true;
        break;
    }
    try { this.unsquelchJoystick(); } catch (e) {}
  }

  private handleMouseUp(e: MouseEvent): void {
    switch (e.button) {
      case 0:
        this.mouseButtons.left = false;
        break;
      case 1:
        this.mouseButtons.middle = false;
        break;
      case 2:
        this.mouseButtons.right = false;
        break;
    }
  }

  public getInput(): InputState {
    if (!this.controlsEnabled) return { forward: false, backward: false, left: false, right: false, action: false, jump: false, sprint: false };
    const base = { ...this.keys };
    if (this.joystickProvider && !this.joystickSquelched) {
      const axes = this.joystickProvider.getAxes();
      // Map axes to forward/left/right/back
      base.forward = axes.y < -0.25;
      base.backward = axes.y > 0.25;
      base.left = axes.x < -0.25;
      base.right = axes.x > 0.25;
      // update last active if meaningful axis beyond deadzone
      if (Math.abs(axes.x) > this.axesDeadzone || Math.abs(axes.y) > this.axesDeadzone) {
        this.joystickLastActive = performance.now();
      }
    }
    return base;
  }

  // Return analog axes in the range -1..1 (x: left->right, y: forward->backward)
  // If `smooth` is true (default) the returned axes are smoothed using an internal lerp.
  public getAxes(smooth = true): Axes {
    if (!this.controlsEnabled) return { x: 0, y: 0 };
    let rawX = 0;
    let rawY = 0;

    // Keyboard influence
    if (this.keys.left) rawX -= 1;
    if (this.keys.right) rawX += 1;
    if (this.keys.forward) rawY += 1;
    if (this.keys.backward) rawY -= 1;

    // Joystick overrides/augments keyboard
    if (this.joystickProvider && !this.joystickSquelched) {
      try {
        const j = this.joystickProvider.getAxes();
        // prefer joystick's finer control when present
        rawX = j.x !== undefined ? j.x : rawX;
        rawY = j.y !== undefined ? -j.y : rawY; // invert y to match forward-positive
        // update last active on meaningful input
        if (Math.abs(rawX) > this.axesDeadzone || Math.abs(rawY) > this.axesDeadzone) {
          this.joystickLastActive = performance.now();
          // If squelched but user deliberately moves beyond activation threshold, unsquelch
          if (this.joystickSquelched && (Math.abs(rawX) > this.joystickActivationThreshold || Math.abs(rawY) > this.joystickActivationThreshold)) {
            this.joystickSquelched = false;
          }
        }
      } catch (e) {
        // ignore joystick errors
      }
    }

    // Auto-squelch joystick if idle for > joystickAutoSquelchMs
    try {
      if (!this.joystickSquelched && this.joystickLastActive && (performance.now() - this.joystickLastActive) > this.joystickAutoSquelchMs) {
        this.joystickSquelched = true;
      }
    } catch (e) {}

    // clamp
    rawX = Math.max(-1, Math.min(1, rawX));
    rawY = Math.max(-1, Math.min(1, rawY));

    // apply deadzone
    const applyDeadzone = (v: number) => {
      if (Math.abs(v) < this.axesDeadzone) return 0;
      // rescale so that output ramps from 0..1 outside deadzone
      const sign = v < 0 ? -1 : 1;
      const mag = (Math.abs(v) - this.axesDeadzone) / (1 - this.axesDeadzone);
      return Math.max(0, Math.min(1, mag)) * sign;
    };

    const dzX = applyDeadzone(rawX);
    const dzY = applyDeadzone(rawY);

    if (smooth) {
      // lerp current state towards target
      this.axesState.x += (dzX - this.axesState.x) * this.axesSmoothing;
      this.axesState.y += (dzY - this.axesState.y) * this.axesSmoothing;
      return { x: this.axesState.x, y: this.axesState.y };
    }

    // no smoothing, update state and return
    this.axesState.x = dzX;
    this.axesState.y = dzY;
    return { x: dzX, y: dzY };
  }

  public getMousePosition(): { x: number; y: number } {
    return { ...this.mousePosition };
  }

  public getMouseButtons(): { left: boolean; right: boolean; middle: boolean } {
    return { ...this.mouseButtons };
  }

  public isActionPressed(): boolean {
    return this.keys.action;
  }

  public resetAction(): void {
    this.keys.action = false;
  }

  /**
   * Cleanup method to remove all event listeners and prevent memory leaks
   */
  public dispose(): void {
    if (this.isDisposed) return;
    this.isDisposed = true;

    // Remove window listeners
    window.removeEventListener('keydown', this.boundHandlers.keydown);
    window.removeEventListener('keyup', this.boundHandlers.keyup);
    window.removeEventListener('mousemove', this.boundHandlers.mousemove);
    window.removeEventListener('mousedown', this.boundHandlers.mousedown);
    window.removeEventListener('mouseup', this.boundHandlers.mouseup);

    // Remove canvas listeners
    if (this.canvas) {
      if (this.boundHandlers.touchstart) {
        this.canvas.removeEventListener('touchstart', this.boundHandlers.touchstart);
      }
      if (this.boundHandlers.touchmove) {
        this.canvas.removeEventListener('touchmove', this.boundHandlers.touchmove);
      }
      if (this.boundHandlers.touchend) {
        this.canvas.removeEventListener('touchend', this.boundHandlers.touchend);
      }
      if (this.boundHandlers.canvasClick) {
        this.canvas.removeEventListener('click', this.boundHandlers.canvasClick);
      }
      this.canvas = undefined;
    }

    // Clear virtual joystick reference
    this.joystickProvider = undefined;
  }
}

