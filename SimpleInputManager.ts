// Pinch-zoom channel: SimpleInputManager accumulates a multiplicative orbit-
// distance factor from two-finger canvas gestures; OrbitCamera consumes (and
// resets) it once per frame in update(). Module-level because the two objects
// have no reference to each other — look deltas route through main-simple →
// GameScene.setCameraInput, but distance is OrbitCamera-internal state.
const pinchState = { factor: 1 };

/** Consume the pending pinch-zoom factor (1 = no change). Spreading two
 *  fingers yields < 1 (zoom in), pinching them together yields > 1. */
export function consumePinchZoomFactor(): number {
  const f = pinchState.factor;
  pinchState.factor = 1;
  return f;
}

/**
 * SimpleInputManager
 *
 * Simplified input handling for keyboard, mouse, and touch
 * Replaces complex InputManager.ts with focused input gathering
 */
export class SimpleInputManager {
  private keys: Set<string> = new Set();
  // Keys pressed since the game loop last consumed them. Latching presses in the
  // event handler (instead of polling isKeyPressed) guarantees a fast tap is
  // never missed even if keydown+keyup both land between two frames.
  private pressedSinceLastPoll: Set<string> = new Set();
  // Last keydown timestamp per key. Genuinely held keys re-fire keydown via OS
  // auto-repeat every ~35ms; a key with no event for STALE_KEY_MS is a phantom
  // (stray synthetic keydown with no keyup) and gets dropped by purgeStaleKeys.
  private lastKeyEventAt: Map<string, number> = new Map();
  private static readonly STALE_KEY_MS = 2000;
  private mouseInput: { x: number; y: number; lastX: number; lastY: number } = {
    x: 0,
    y: 0,
    lastX: 0,
    lastY: 0,
  };
  private mouseDelta: { x: number; y: number } = { x: 0, y: 0 };
  // Camera-look touch: the first finger that lands on the game canvas claims
  // the camera (joystick/buttons are their own DOM targets and never reach
  // here), identified by Touch.identifier so a second finger — e.g. the
  // joystick thumb — can come and go without stealing the look gesture.
  // Deltas accumulate into touchDelta and are consumed (zeroed) by
  // getCameraInput, mirroring the pointer-locked mouseDelta path.
  private cameraTouchId: number | null = null;
  private touchLast: { x: number; y: number } = { x: 0, y: 0 };
  private touchDelta: { x: number; y: number } = { x: 0, y: 0 };
  // Pinch-to-zoom: a SECOND canvas finger converts the look gesture into a
  // pinch (look deltas suspend while it's down). Joystick/button fingers
  // never qualify — only touches whose target is the canvas.
  private pinchTouchId: number | null = null;
  private pinchLastDist = 0;
  // Touch feeds the same raw-pixel pipeline as the mouse; a small boost
  // compensates for a phone swipe covering far fewer CSS pixels than a
  // desktop mouse motion.
  private static readonly TOUCH_SENSITIVITY = 1.3;

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
      const k = e.key.toLowerCase();
      this.keys.add(k);
      this.lastKeyEventAt.set(k, performance.now());
      // Latch the press edge (ignore OS auto-repeat) for consumeKeyPress()
      if (!e.repeat) {
        this.pressedSinceLastPoll.add(k);
      }
      // Debug: Log first few key presses
      if (this.keys.size <= 3) {
        console.log('⌨️ Key pressed:', k);
      }
    });

    document.addEventListener('keyup', (e) => {
      const k = e.key.toLowerCase();
      this.keys.delete(k);
      this.lastKeyEventAt.delete(k);
    });

    // Focus-loss hygiene: if the window blurs (alt-tab, dev tools, automation)
    // while a key is down, the keyup is never delivered and the key sticks —
    // the player then "walks on their own" forever. Clear all input state.
    window.addEventListener('blur', () => this.reset());
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') this.reset();
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
    // Listeners stay passive: the canvas has touch-action: none, so the
    // browser never scrolls/refreshes for touches that start there anyway.
    document.addEventListener(
      'touchstart',
      (e) => {
        for (let i = 0; i < e.changedTouches.length; i++) {
          const t = e.changedTouches[i];
          if (t.target !== this.canvas) continue;
          if (this.cameraTouchId === null) {
            this.cameraTouchId = t.identifier;
            // Seed last position so the first move computes a true delta
            // (not clientX - 0, which snapped the camera on gesture start)
            this.touchLast.x = t.clientX;
            this.touchLast.y = t.clientY;
          } else if (this.pinchTouchId === null && t.identifier !== this.cameraTouchId) {
            // Second canvas finger: the look gesture becomes a pinch-zoom.
            this.pinchTouchId = t.identifier;
            const a = this.findTouch(e.touches, this.cameraTouchId);
            this.pinchLastDist = a ? Math.hypot(t.clientX - a.clientX, t.clientY - a.clientY) : 0;
            // Suspend look: drop any delta accumulated but not yet consumed
            this.touchDelta.x = 0;
            this.touchDelta.y = 0;
          }
        }
      },
      { passive: true },
    );

    document.addEventListener(
      'touchmove',
      (e) => {
        if (this.cameraTouchId === null) return;
        if (this.pinchTouchId !== null) {
          // Pinch: both fingers' CURRENT positions drive the distance ratio.
          // Spreading (dist grows) zooms in — orbit distance scales inversely.
          const a = this.findTouch(e.touches, this.cameraTouchId);
          const b = this.findTouch(e.touches, this.pinchTouchId);
          if (a && b) {
            const dist = Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY);
            // Ignore near-degenerate spans: the ratio explodes as fingers meet
            if (this.pinchLastDist > 10 && dist > 10) {
              pinchState.factor *= this.pinchLastDist / dist;
            }
            this.pinchLastDist = dist;
            // Track the camera finger so look resumes without a snap when the
            // second finger lifts
            this.touchLast.x = a.clientX;
            this.touchLast.y = a.clientY;
          }
          return;
        }
        for (let i = 0; i < e.changedTouches.length; i++) {
          const t = e.changedTouches[i];
          if (t.identifier === this.cameraTouchId) {
            this.touchDelta.x += t.clientX - this.touchLast.x;
            this.touchDelta.y += t.clientY - this.touchLast.y;
            this.touchLast.x = t.clientX;
            this.touchLast.y = t.clientY;
            break;
          }
        }
      },
      { passive: true },
    );

    // Release only when THE camera/pinch fingers lift — joystick/button
    // fingers ending must not cancel an in-flight look gesture. Ending one
    // of two pinch fingers falls back to one-finger look, re-seeded to the
    // survivor's current position so there's no delta snap.
    const endCameraTouch = (e: TouchEvent) => {
      if (this.cameraTouchId === null) return;
      for (let i = 0; i < e.changedTouches.length; i++) {
        const id = e.changedTouches[i].identifier;
        if (id === this.pinchTouchId) {
          this.pinchTouchId = null;
          const a =
            this.cameraTouchId !== null ? this.findTouch(e.touches, this.cameraTouchId) : null;
          if (a) {
            this.touchLast.x = a.clientX;
            this.touchLast.y = a.clientY;
          }
        } else if (id === this.cameraTouchId) {
          if (this.pinchTouchId !== null) {
            // Camera finger lifted mid-pinch: promote the other finger to look
            this.cameraTouchId = this.pinchTouchId;
            this.pinchTouchId = null;
            const b = this.findTouch(e.touches, this.cameraTouchId);
            if (b) {
              this.touchLast.x = b.clientX;
              this.touchLast.y = b.clientY;
            }
          } else {
            this.cameraTouchId = null;
          }
        }
      }
    };
    document.addEventListener('touchend', endCameraTouch);
    document.addEventListener('touchcancel', endCameraTouch);
  }

  /** Find an active touch by identifier (TouchList has no .find). */
  private findTouch(list: TouchList, id: number): Touch | null {
    for (let i = 0; i < list.length; i++) {
      if (list[i].identifier === id) return list[i];
    }
    return null;
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
   * Drop keys that stopped sending events (phantom keydowns with no keyup).
   * Held keys are kept alive by OS auto-repeat.
   */
  private purgeStaleKeys(): void {
    if (this.keys.size === 0) return;
    const now = performance.now();
    for (const k of [...this.keys]) {
      const last = this.lastKeyEventAt.get(k);
      if (last === undefined || now - last > SimpleInputManager.STALE_KEY_MS) {
        this.keys.delete(k);
        this.lastKeyEventAt.delete(k);
      }
    }
  }

  /**
   * Check if a key is pressed
   */
  public isKeyPressed(key: string): boolean {
    this.purgeStaleKeys();
    return this.keys.has(key.toLowerCase());
  }

  /**
   * Consume a latched key press (edge-triggered, auto-repeat-proof).
   * Returns true at most once per physical press, no matter how the
   * keydown/keyup timing interleaves with the render loop.
   */
  public consumeKeyPress(key: string): boolean {
    const k = key.toLowerCase();
    if (this.pressedSinceLastPoll.has(k)) {
      this.pressedSinceLastPoll.delete(k);
      return true;
    }
    return false;
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
    } else if (this.touchDelta.x !== 0 || this.touchDelta.y !== 0) {
      // Consume-and-zero, same contract as the mouse path above
      const deltaX = this.touchDelta.x * SimpleInputManager.TOUCH_SENSITIVITY;
      const deltaY = this.touchDelta.y * SimpleInputManager.TOUCH_SENSITIVITY;
      this.touchDelta.x = 0;
      this.touchDelta.y = 0;
      return { deltaX, deltaY };
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
    this.pressedSinceLastPoll.clear();
    this.lastKeyEventAt.clear();
    this.mouseInput = { x: 0, y: 0, lastX: 0, lastY: 0 };
    this.mouseDelta = { x: 0, y: 0 };
    this.cameraTouchId = null;
    this.touchLast = { x: 0, y: 0 };
    this.touchDelta = { x: 0, y: 0 };
    this.pinchTouchId = null;
    this.pinchLastDist = 0;
    pinchState.factor = 1;
  }

  /**
   * Dispose (cleanup listeners if needed)
   */
  public dispose(): void {
    this.reset();
  }
}
