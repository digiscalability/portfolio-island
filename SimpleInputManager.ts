/**
 * SimpleInputManager
 *
 * Simplified input handling for keyboard, mouse, and touch
 * Replaces complex InputManager.ts with focused input gathering
 */
export class SimpleInputManager {
  private keys: Set<string> = new Set();
  private mouseInput: { x: number; y: number; lastX: number; lastY: number } = {
    x: 0,
    y: 0,
    lastX: 0,
    lastY: 0,
  };
  private mouseDelta: { x: number; y: number } = { x: 0, y: 0 };
  private touchInput: { x: number; y: number; lastX: number; lastY: number } = {
    x: 0,
    y: 0,
    lastX: 0,
    lastY: 0,
  };

  private isPointerLocked: boolean = false;
  private canvas?: HTMLCanvasElement;

  constructor() {
    this.setupKeyboardListeners();
    this.setupMouseListeners();
    this.setupTouchListeners();
  }

  /**
   * Setup keyboard event listeners
   */
  private setupKeyboardListeners(): void {
    document.addEventListener('keydown', (e) => {
      this.keys.add(e.key.toLowerCase());
      // Debug: Log first few key presses
      if (this.keys.size <= 3) {
        console.log('⌨️ Key pressed:', e.key.toLowerCase());
      }
    });

    document.addEventListener('keyup', (e) => {
      this.keys.delete(e.key.toLowerCase());
    });
  }

  /**
   * Setup mouse event listeners
   */
  private setupMouseListeners(): void {
    document.addEventListener('mousemove', (e) => {
      if (this.isPointerLocked) {
        // When locked we can rely on relative movement provided by the browser
        this.mouseDelta.x += e.movementX;
        this.mouseDelta.y += e.movementY;
      } else {
        this.mouseInput.lastX = this.mouseInput.x;
        this.mouseInput.lastY = this.mouseInput.y;
        this.mouseInput.x = e.clientX;
        this.mouseInput.y = e.clientY;
      }
    });

    document.addEventListener('pointerlockchange', () => {
      this.isPointerLocked = document.pointerLockElement === this.canvas;
      if (!this.isPointerLocked) {
        this.mouseDelta.x = 0;
        this.mouseDelta.y = 0;
      }
    });
  }

  /**
   * Setup touch event listeners
   */
  private setupTouchListeners(): void {
    document.addEventListener('touchmove', (e) => {
      if (e.touches.length > 0) {
        this.touchInput.lastX = this.touchInput.x;
        this.touchInput.lastY = this.touchInput.y;
        this.touchInput.x = e.touches[0].clientX;
        this.touchInput.y = e.touches[0].clientY;
      }
    });

    document.addEventListener('touchend', () => {
      this.touchInput.x = 0;
      this.touchInput.y = 0;
    });
  }

  /**
   * Attach to canvas for mouse controls
   */
  public attachToCanvas(canvas: HTMLCanvasElement): void {
    this.canvas = canvas;

    canvas.addEventListener('click', () => {
      if (document.pointerLockElement !== canvas) {
        canvas.requestPointerLock?.();
      }
    });
  }

  /**
   * Check if a key is pressed
   */
  public isKeyPressed(key: string): boolean {
    return this.keys.has(key.toLowerCase());
  }

  /**
   * Get movement input (WASD or arrow keys)
   * Returns { forward: -1 to 1, strafe: -1 to 1 }
   */
  public getMovementInput(): { forward: number; strafe: number } {
    let forward = 0;
    let strafe = 0;

    // Forward/backward
    if (this.isKeyPressed('w') || this.isKeyPressed('arrowup')) forward += 1;
    if (this.isKeyPressed('s') || this.isKeyPressed('arrowdown')) forward -= 1;

    // Strafe
    if (this.isKeyPressed('a') || this.isKeyPressed('arrowleft')) strafe -= 1;
    if (this.isKeyPressed('d') || this.isKeyPressed('arrowright')) strafe += 1;

    return { forward, strafe };
  }

  /**
   * Check if jump is requested (space or touch tap)
   */
  public getJumpInput(): boolean {
    return this.isKeyPressed(' ') || this.isKeyPressed('space');
  }

  /**
   * Get camera input (mouse or touch delta)
   */
  public getCameraInput(): { deltaX: number; deltaY: number } {
    if (this.isPointerLocked) {
      const deltaX = this.mouseDelta.x;
      const deltaY = this.mouseDelta.y;
      this.mouseDelta.x = 0;
      this.mouseDelta.y = 0;
      // Return raw mouse delta - OrbitCamera applies its own sensitivity multiplier
      return { deltaX, deltaY };
    } else if (this.touchInput.x !== 0) {
      // Use touch delta
      const deltaX = this.touchInput.x - this.touchInput.lastX;
      const deltaY = this.touchInput.y - this.touchInput.lastY;
      return { deltaX: deltaX * 0.01, deltaY: deltaY * 0.01 };
    }

    return { deltaX: 0, deltaY: 0 };
  }

  /**
   * Get raw mouse position
   */
  public getMousePosition(): { x: number; y: number } {
    return { x: this.mouseInput.x, y: this.mouseInput.y };
  }

  /**
   * Check if pointer is locked
   */
  public isLocked(): boolean {
    return this.isPointerLocked;
  }

  /**
   * Clear all input state
   */
  public reset(): void {
    this.keys.clear();
    this.mouseInput = { x: 0, y: 0, lastX: 0, lastY: 0 };
    this.mouseDelta = { x: 0, y: 0 };
    this.touchInput = { x: 0, y: 0, lastX: 0, lastY: 0 };
  }

  /**
   * Dispose (cleanup listeners if needed)
   */
  public dispose(): void {
    this.reset();
  }
}
