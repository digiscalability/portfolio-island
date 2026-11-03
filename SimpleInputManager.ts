import { focusedControlOwnsKey } from './keyGuards';

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
 * How a desktop pointer looks around. 'drag' (the default): press and drag on
 * the world with either button. 'lock': the opt-in pointer lock (localStorage
 * ds_mouse_lock = '1', written by the settings sheet), where a click captures
 * the cursor and plain movement looks. Mirrored on <html data-look-mode> for
 * the settings rows, the guide's copy and the probes.
 */
export type LookMode = 'drag' | 'lock';

/** One frame of look input, already in radians (sensitivity and invert applied). */
export interface CameraInput {
  /** > 0 turns the view right. */
  deltaX: number;
  /** > 0 moves the camera as a downward drag does (ds_look_invert flips it). */
  deltaY: number;
  /** The device that produced it: the camera eases a finger a little slower. */
  source: 'mouse' | 'touch';
  /** A touch fling released this frame, rad/s, > 0 turning right (0 = none). */
  fling: number;
}

/** One press of a mouse or pen button on the world, from pointerdown to up. */
interface DragState {
  pointerId: number;
  button: number;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  startedAt: number;
  /** Farthest the pointer has been from where it went down (CSS px). */
  moved: number;
  /** Past the click threshold: movement now looks. */
  active: boolean;
  /** Movement while the press could still be a click, released on activation. */
  pendingX: number;
  pendingY: number;
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
  // Look movement from the mouse or pen, in CSS px: a drag on the world, or
  // plain movement while the opt-in pointer lock holds.
  private mouseDelta: { x: number; y: number } = { x: 0, y: 0 };
  // Camera-look touch: the first finger that lands on the game canvas claims
  // the camera (joystick/buttons are their own DOM targets and never reach
  // here), identified by Touch.identifier so a second finger — e.g. the
  // joystick thumb — can come and go without stealing the look gesture.
  // Deltas accumulate into touchDelta and are consumed (zeroed) by
  // getCameraInput, mirroring the mouse path.
  private cameraTouchId: number | null = null;
  private touchLast: { x: number; y: number } = { x: 0, y: 0 };
  private touchDelta: { x: number; y: number } = { x: 0, y: 0 };
  // Pinch-to-zoom: a SECOND canvas finger converts the look gesture into a
  // pinch (look deltas suspend while it's down). Joystick/button fingers
  // never qualify — only touches whose target is the canvas.
  private pinchTouchId: number | null = null;
  private pinchLastDist = 0;

  // ---- Look sensitivity: radians per CSS pixel ----------------------------
  // Mouse 90° ≈ 450 px; touch 90° ≈ 260 px (a swipe covers far fewer CSS
  // pixels than a desk-wide mouse sweep). Both scale by ds_look_sens
  // (0.5-2.0, the settings sheet's slider); ds_look_invert = '1' flips pitch.
  public static readonly MOUSE_K = 0.0035;
  public static readonly TOUCH_K = 0.006;
  private lookSens = 1;
  private lookInvert = false;
  // Touch fling: the camera finger's recent positions; at finger-up, a swipe
  // averaging over FLING_MIN_PX_S across its last FLING_WINDOW_MS flings.
  private touchTrail: Array<{ t: number; x: number }> = [];
  private pendingFling = 0; // rad/s, + = turning right
  private static readonly FLING_WINDOW_MS = 80;
  private static readonly FLING_MIN_PX_S = 500;

  // ---- Press-and-drag look (the desktop default) -------------------------
  // A press on the world captures the pointer and drags look while a button
  // is held. A press that moves under CLICK_PX and ends within CLICK_MS stays
  // a click — the peer-mute tap in main-simple needs exactly that.
  private static readonly CLICK_PX = 6;
  private static readonly CLICK_MS = 300;
  private drag: DragState | null = null;
  // The last press was a drag: its trailing click must not request the lock.
  private lastPressWasDrag = false;
  // A right-drag of CLICK_PX or more swallows the context menu that follows it
  // (Windows opens it on release). A plain right-click still gets its menu.
  private suppressMenuUntil = 0;

  // ---- The opt-in pointer lock -------------------------------------------
  private lockOptIn = false;
  private lockAllowed: () => boolean = () => true;
  private lockPill: HTMLDivElement | null = null;
  private lockPillTimer = 0;
  private static readonly LOCK_PILL_MS = 3000;

  private isPointerLocked: boolean = false;
  private canvas?: HTMLCanvasElement;
  // Every listener registers with this signal, so dispose() really detaches.
  private readonly listeners = new AbortController();

  constructor() {
    this.setupKeyboardListeners();
    this.setupMouseListeners();
    this.setupTouchListeners();
    this.readLookSettings();
    // The settings sheet fires window 'ds:settings' {key} after each write.
    // Capture phase, so the event is heard whether it is dispatched on window
    // or on the document.
    window.addEventListener('ds:settings', () => this.readLookSettings(), {
      capture: true,
      signal: this.listeners.signal,
    });
  }

  /**
   * Setup keyboard event listeners
   */
  private setupKeyboardListeners(): void {
    const signal = this.listeners.signal;
    document.addEventListener(
      'keydown',
      (e) => {
        // Browser and OS chords are never game input: Ctrl+C copies the email
        // on the contact card (it used to open the appearance editor over it),
        // Ctrl+W closes the tab, Alt+Tab leaves. Nothing is held or latched
        // while Ctrl, Meta or Alt is down. Shift still counts (the dive key).
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        const k = e.key.toLowerCase();
        // A focused control keeps the keys it uses (keyGuards.ts): a text field
        // every key, so typing "feed the birds" never fires the one-shot verbs
        // or walks; a slider or select its arrows; a button or link Space and
        // Enter. Holding counts too, not just the latch: a key typed into a
        // field used to walk the avatar behind it.
        if (focusedControlOwnsKey(k, e.target)) return;
        this.keys.add(k);
        this.lastKeyEventAt.set(k, performance.now());
        // Latch the press edge (ignore OS auto-repeat) for consumeKeyPress().
        if (!e.repeat) {
          this.pressedSinceLastPoll.add(k);
        }
        // Debug: Log first few key presses
        if (this.keys.size <= 3) {
          console.log('⌨️ Key pressed:', k);
        }
      },
      { signal },
    );

    document.addEventListener(
      'keyup',
      (e) => {
        const k = e.key.toLowerCase();
        this.keys.delete(k);
        this.lastKeyEventAt.delete(k);
      },
      { signal },
    );

    // Focus-loss hygiene: if the window blurs (alt-tab, dev tools, automation)
    // while a key is down, the keyup is never delivered and the key sticks —
    // the player then "walks on their own" forever. Clear all input state
    // (a drag in flight ends too).
    window.addEventListener('blur', () => this.reset(), { signal });
    document.addEventListener(
      'visibilitychange',
      () => {
        if (document.visibilityState === 'hidden') this.reset();
      },
      { signal },
    );
  }

  /**
   * Setup mouse event listeners
   */
  private setupMouseListeners(): void {
    const signal = this.listeners.signal;
    document.addEventListener(
      'mousemove',
      (e) => {
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
      },
      { signal },
    );

    document.addEventListener(
      'pointerlockchange',
      () => {
        const locked = !!this.canvas && document.pointerLockElement === this.canvas;
        if (locked && !this.isPointerLocked) {
          // A drag in flight hands over to the lock, which looks on its own.
          this.endDrag();
          this.showLockPill();
        }
        this.isPointerLocked = locked;
        if (!locked) {
          this.mouseDelta.x = 0;
          this.mouseDelta.y = 0;
        }
      },
      { signal },
    );
  }

  /**
   * Setup touch event listeners
   */
  private setupTouchListeners(): void {
    const signal = this.listeners.signal;
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
            this.touchTrail = [{ t: performance.now(), x: t.clientX }];
          } else if (this.pinchTouchId === null && t.identifier !== this.cameraTouchId) {
            // Second canvas finger: the look gesture becomes a pinch-zoom.
            this.pinchTouchId = t.identifier;
            const a = this.findTouch(e.touches, this.cameraTouchId);
            this.pinchLastDist = a ? Math.hypot(t.clientX - a.clientX, t.clientY - a.clientY) : 0;
            // Suspend look: drop any delta accumulated but not yet consumed
            this.touchDelta.x = 0;
            this.touchDelta.y = 0;
            this.touchTrail = []; // a pinch never flings
          }
        }
      },
      { passive: true, signal },
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
            const now = performance.now();
            this.touchTrail.push({ t: now, x: t.clientX });
            // keep only what the fling window can still use
            while (
              this.touchTrail.length > 2 &&
              now - this.touchTrail[0].t > 2 * SimpleInputManager.FLING_WINDOW_MS
            ) {
              this.touchTrail.shift();
            }
            break;
          }
        }
      },
      { passive: true, signal },
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
            this.touchTrail = [];
          } else {
            this.cameraTouchId = null;
            if (e.type === 'touchend') this.releaseFling();
            this.touchTrail = [];
          }
        }
      }
    };
    document.addEventListener('touchend', endCameraTouch, { signal });
    document.addEventListener('touchcancel', endCameraTouch, { signal });
  }

  /** Find an active touch by identifier (TouchList has no .find). */
  private findTouch(list: TouchList, id: number): Touch | null {
    for (let i = 0; i < list.length; i++) {
      if (list[i].identifier === id) return list[i];
    }
    return null;
  }

  /**
   * The camera finger lifted: if its last 80 ms averaged over 500 px/s
   * sideways, hand the camera a fling at ω = v·k. The average runs over the
   * moves inside the window (the finger may rest a frame before it lifts);
   * a finger that stopped moving earlier than that never flings.
   */
  private releaseFling(): void {
    const trail = this.touchTrail;
    if (trail.length < 2) return;
    const now = performance.now();
    const last = trail[trail.length - 1];
    if (now - last.t > SimpleInputManager.FLING_WINDOW_MS) return;
    let first = trail.length - 1;
    while (first > 0 && last.t - trail[first - 1].t <= SimpleInputManager.FLING_WINDOW_MS) {
      first--;
    }
    if (first === trail.length - 1) first = trail.length - 2; // one move: from the sample before it
    const dtMs = Math.max(last.t - trail[first].t, 4);
    const v = ((last.x - trail[first].x) / dtMs) * 1000; // px/s, + = rightward
    if (Math.abs(v) <= SimpleInputManager.FLING_MIN_PX_S) return;
    this.pendingFling = v * SimpleInputManager.TOUCH_K * this.lookSens;
  }

  /**
   * Attach to the canvas: press-and-drag look, and the opt-in pointer lock.
   *
   * The old click → requestPointerLock path is gone: every first click on the
   * world captured the cursor without warning, and a click beside an open
   * sheet (the Portfolio menu) then left the sheet unclickable.
   */
  public attachToCanvas(canvas: HTMLCanvasElement): void {
    this.canvas = canvas;
    const signal = this.listeners.signal;
    canvas.style.cursor = 'grab';

    canvas.addEventListener('pointerdown', (e) => this.onPointerDown(e), { signal });
    canvas.addEventListener('pointermove', (e) => this.onPointerMove(e), { signal });
    canvas.addEventListener('pointerup', (e) => this.onPointerEnd(e), { signal });
    canvas.addEventListener('pointercancel', (e) => this.onPointerEnd(e), { signal });
    canvas.addEventListener('lostpointercapture', (e) => this.onPointerEnd(e), { signal });
    canvas.addEventListener(
      'contextmenu',
      (e) => {
        if (performance.now() < this.suppressMenuUntil) {
          e.preventDefault();
          this.suppressMenuUntil = 0;
        }
      },
      { signal },
    );
    canvas.addEventListener('click', () => this.requestLockOnClick(), { signal });
  }

  /** A mouse or pen button (left or right) went down on the world. */
  private onPointerDown(e: PointerEvent): void {
    if (e.pointerType !== 'mouse' && e.pointerType !== 'pen') return; // touch has its own path
    if (e.button !== 0 && e.button !== 2) return;
    if (this.isPointerLocked || this.drag) return; // locked: plain movement already looks
    try {
      this.canvas?.setPointerCapture(e.pointerId);
    } catch {
      /* a pointer the browser no longer tracks: drag without capture */
    }
    this.drag = {
      pointerId: e.pointerId,
      button: e.button,
      startX: e.clientX,
      startY: e.clientY,
      lastX: e.clientX,
      lastY: e.clientY,
      startedAt: performance.now(),
      moved: 0,
      active: false,
      pendingX: 0,
      pendingY: 0,
    };
    this.lastPressWasDrag = false;
    if (this.canvas) this.canvas.style.cursor = 'grabbing';
  }

  /** Movement during a press. Until the press stops being a click, it is held back. */
  private onPointerMove(e: PointerEvent): void {
    const d = this.drag;
    if (!d || e.pointerId !== d.pointerId) return;
    const dx = e.clientX - d.lastX;
    const dy = e.clientY - d.lastY;
    d.lastX = e.clientX;
    d.lastY = e.clientY;
    d.moved = Math.max(d.moved, Math.hypot(e.clientX - d.startX, e.clientY - d.startY));
    if (!d.active) {
      d.pendingX += dx;
      d.pendingY += dy;
      const held = performance.now() - d.startedAt;
      if (d.moved < SimpleInputManager.CLICK_PX && held < SimpleInputManager.CLICK_MS) return;
      // It is a drag: release what was held back, so the look follows the
      // whole movement, not the movement minus the first 6 px.
      d.active = true;
      this.mouseDelta.x += d.pendingX;
      this.mouseDelta.y += d.pendingY;
      d.pendingX = 0;
      d.pendingY = 0;
      return;
    }
    this.mouseDelta.x += dx;
    this.mouseDelta.y += dy;
  }

  /** pointerup, pointercancel or lostpointercapture: the press is over. */
  private onPointerEnd(e: PointerEvent): void {
    const d = this.drag;
    if (!d || e.pointerId !== d.pointerId) return;
    if (e.type === 'pointerup' && d.button === 2 && d.moved >= SimpleInputManager.CLICK_PX) {
      this.suppressMenuUntil = performance.now() + 700;
    }
    this.endDrag();
  }

  /** Finish the press in flight (also on blur and when the lock engages). */
  private endDrag(): void {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    this.lastPressWasDrag = d.active;
    try {
      if (this.canvas?.hasPointerCapture?.(d.pointerId)) {
        this.canvas.releasePointerCapture(d.pointerId);
      }
    } catch {
      /* already released */
    }
    if (this.canvas) this.canvas.style.cursor = 'grab';
  }

  /** The opt-in lock: a plain click on the world (never a drag, never over a panel). */
  private requestLockOnClick(): void {
    const canvas = this.canvas;
    if (!canvas || !this.lockOptIn || this.isPointerLocked) return;
    if (this.lastPressWasDrag) return;
    // Touch-primary devices have no pointer to lock — every world tap fired
    // a doomed request plus an unhandled promise rejection. Same coarse
    // check the renderer tier uses.
    if (typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches) return;
    if (!this.lockAllowed()) return;
    if (document.pointerLockElement !== canvas) {
      // requestPointerLock returns a promise on modern Chrome — an expired
      // user gesture (or an embedded/browser-pane doc) rejects it; benign.
      (canvas.requestPointerLock?.() as Promise<void> | undefined)?.catch?.(() => {});
    }
  }

  /**
   * May a click lock the pointer right now? main-simple answers "only while no
   * panel is open", so the lock can never strand an open sheet or card.
   */
  public setPointerLockGuard(allowed: () => boolean): void {
    this.lockAllowed = allowed;
  }

  /** Let go of the pointer lock (a panel opened, or the setting went off). */
  public releasePointerLock(): void {
    if (this.isPointerLocked && typeof document.exitPointerLock === 'function') {
      document.exitPointerLock();
    }
  }

  /** The look mode in force: 'lock' only when the visitor opted in. */
  public getLookMode(): LookMode {
    return this.lockOptIn ? 'lock' : 'drag';
  }

  /**
   * Read the look settings the settings sheet writes (at boot, and again on
   * each 'ds:settings'), and mirror the mode on <html data-look-mode>.
   */
  private readLookSettings(): void {
    let lock = false;
    let sens = Number.NaN;
    let invert = false;
    try {
      lock = localStorage.getItem('ds_mouse_lock') === '1';
      sens = Number.parseFloat(localStorage.getItem('ds_look_sens') ?? '');
      invert = localStorage.getItem('ds_look_invert') === '1';
    } catch {
      /* storage blocked: the defaults (press and drag, 1×, not inverted) */
    }
    this.lookSens = Number.isFinite(sens) ? Math.min(2, Math.max(0.5, sens)) : 1;
    this.lookInvert = invert;
    this.lockOptIn = lock;
    if (!lock) this.releasePointerLock();
    document.documentElement.setAttribute('data-look-mode', this.getLookMode());
  }

  /** The reminder that the cursor is captured: top centre, 12 px, for 3 s. */
  private showLockPill(): void {
    let pill = this.lockPill;
    if (!pill) {
      pill = document.createElement('div');
      pill.id = 'ds-lock-pill';
      pill.setAttribute('role', 'status');
      pill.setAttribute('aria-live', 'polite');
      pill.textContent = 'Mouse locked — Esc to release';
      Object.assign(pill.style, {
        position: 'fixed',
        // Under the compass pill, which owns the top centre at +14px.
        top: 'calc(var(--sat, 0px) + 56px)',
        left: '50%',
        transform: 'translateX(-50%)',
        padding: '4px 12px',
        borderRadius: '999px',
        background: 'rgba(16, 24, 38, 0.9)',
        border: '1px solid rgba(255, 255, 255, 0.14)',
        color: '#ffffff',
        fontFamily: 'system-ui, sans-serif',
        fontSize: '12px',
        lineHeight: '1.4',
        whiteSpace: 'nowrap',
        zIndex: '1300',
        pointerEvents: 'none',
      });
      (document.getElementById('ui-overlay') ?? document.body).appendChild(pill);
      this.lockPill = pill;
    }
    pill.style.display = 'block';
    window.clearTimeout(this.lockPillTimer);
    this.lockPillTimer = window.setTimeout(() => {
      if (this.lockPill) this.lockPill.style.display = 'none';
    }, SimpleInputManager.LOCK_PILL_MS);
  }

  /**
   * Drop keys that stopped sending events (phantom keydowns with no keyup).
   *
   * This USED to purge on a timer, on the premise that "held keys are kept
   * alive by OS auto-repeat". They are not: auto-repeat only repeats the
   * MOST RECENTLY pressed key. Hold W and then press anything else — another
   * key, or a modifier — and W's repeat stops while the key is still
   * physically down, so the timer purged it and the player stopped walking
   * mid-stride. That is the "can't hold W for long" bug.
   *
   * A held key is only ever really lost when the window stops receiving its
   * keyup, which happens on focus loss — and the blur/visibilitychange
   * handlers already clear all input state for that case. So the purge now
   * only runs when the document does NOT have focus, which is the one
   * situation the timer was ever right about.
   */
  private purgeStaleKeys(): void {
    if (this.keys.size === 0) return;
    if (typeof document !== 'undefined' && document.hasFocus && document.hasFocus()) return;
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
   * Drop every latched press. main-simple calls this each frame while the
   * welcome card, the loader, a tour or a non-walkable panel owns the
   * moment: a key pressed there must not fire when it closes (E behind the
   * Projects panel used to seat the avatar on the bench beside it, and M on
   * the welcome card opened the map the moment Explore was clicked).
   */
  public clearLatched(): void {
    this.pressedSinceLastPoll.clear();
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
   * Free-dive hold. Shift ONLY — deliberately NOT Control: this handler never
   * calls preventDefault, so teaching the player to hold Ctrl while pressing
   * WASD means Ctrl+W closes the browser tab (and Ctrl+S, Ctrl+D, Ctrl+A all
   * fire their browser actions). Space is already triple-booked (tap = jump,
   * hold in water = float, hold + WASD = run), so the free modifier it is.
   * purgeStaleKeys only runs while the document is UNFOCUSED, so a held
   * modifier is never purged despite modifiers having no OS auto-repeat.
   */
  public getDiveInput(): boolean {
    return this.isKeyPressed('shift');
  }

  /**
   * Consume this frame's look: the mouse (drag, or movement under the
   * opt-in lock) plus the camera finger, in radians, with the sensitivity
   * and invert settings applied, and any fling released since last time.
   */
  public getCameraInput(): CameraInput {
    const kSens = this.lookSens;
    const pitchSign = this.lookInvert ? -1 : 1;
    let deltaX = 0;
    let deltaY = 0;
    let source: CameraInput['source'] = 'mouse';
    if (this.mouseDelta.x !== 0 || this.mouseDelta.y !== 0) {
      deltaX += this.mouseDelta.x * SimpleInputManager.MOUSE_K * kSens;
      deltaY += this.mouseDelta.y * SimpleInputManager.MOUSE_K * kSens * pitchSign;
      this.mouseDelta.x = 0;
      this.mouseDelta.y = 0;
    }
    if (this.touchDelta.x !== 0 || this.touchDelta.y !== 0) {
      // Consume-and-zero, same contract as the mouse path above
      deltaX += this.touchDelta.x * SimpleInputManager.TOUCH_K * kSens;
      deltaY += this.touchDelta.y * SimpleInputManager.TOUCH_K * kSens * pitchSign;
      this.touchDelta.x = 0;
      this.touchDelta.y = 0;
      source = 'touch';
    }
    const fling = this.pendingFling;
    this.pendingFling = 0;
    if (fling !== 0) source = 'touch';
    return { deltaX, deltaY, source, fling };
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
    this.endDrag();
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
    this.touchTrail = [];
    this.pendingFling = 0;
    pinchState.factor = 1;
  }

  /**
   * Dispose: clear the state and detach every listener.
   */
  public dispose(): void {
    this.reset();
    this.listeners.abort();
    window.clearTimeout(this.lockPillTimer);
    this.lockPill?.remove();
    this.lockPill = null;
  }
}
