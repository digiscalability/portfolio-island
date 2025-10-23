/**
 * SimpleInputManager
 *
 * Simplified input handling for keyboard, mouse, and touch
 * Replaces complex InputManager.ts with focused input gathering
 */
export type InputFrame = {
  time: number;
  movement: { forward: number; strafe: number };
  camera: { deltaX: number; deltaY: number };
  jump: boolean;
};

export type InputRecording = {
  frames: InputFrame[];
  duration: number;
};

export class SimpleInputManager {
  private keys: Set<string> = new Set();
  private mouseInput: { x: number; y: number; lastX: number; lastY: number } = {
    x: 0,
    y: 0,
    lastX: 0,
    lastY: 0,
  };
  private touchInput: { x: number; y: number; lastX: number; lastY: number } = {
    x: 0,
    y: 0,
    lastX: 0,
    lastY: 0,
  };

  private isPointerLocked: boolean = false;

  private recording: boolean = false;
  private recordingStart: number = 0;
  private recordedFrames: InputFrame[] = [];
  private lastMovement: { forward: number; strafe: number } = { forward: 0, strafe: 0 };
  private lastCamera: { deltaX: number; deltaY: number } = { deltaX: 0, deltaY: 0 };
  private lastJump: boolean = false;

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
      this.mouseInput.lastX = this.mouseInput.x;
      this.mouseInput.lastY = this.mouseInput.y;
      this.mouseInput.x = e.clientX;
      this.mouseInput.y = e.clientY;
    });

    document.addEventListener('click', () => {
      if (!this.isPointerLocked && document.pointerLockElement !== document.body) {
        document.body.requestPointerLock?.();
      }
    });

    document.addEventListener('pointerlockchange', () => {
      this.isPointerLocked = document.pointerLockElement === document.body;
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
  public attachToCanvas(_canvas: HTMLCanvasElement): void {
    // Canvas reference not currently used in this simplified manager
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

    this.lastMovement = { forward, strafe };
    return { forward, strafe };
  }

  /**
   * Check if jump is requested (space or touch tap)
   */
  public getJumpInput(): boolean {
    const jump = this.isKeyPressed(' ') || this.isKeyPressed('space');
    this.lastJump = jump;
    this.recordFrame();
    return jump;
  }

  /**
   * Get camera input (mouse or touch delta)
   */
  public getCameraInput(): { deltaX: number; deltaY: number } {
    if (this.isPointerLocked) {
      // Use accumulated mouse movement (mouse events provide event.movementX/Y)
      // For now, return relative to last frame
      const deltaX = this.mouseInput.x - this.mouseInput.lastX;
      const deltaY = this.mouseInput.y - this.mouseInput.lastY;
      const value = { deltaX: deltaX * 0.005, deltaY: deltaY * 0.005 };
      this.lastCamera = value;
      return value;
    } else if (this.touchInput.x !== 0) {
      // Use touch delta
      const deltaX = this.touchInput.x - this.touchInput.lastX;
      const deltaY = this.touchInput.y - this.touchInput.lastY;
      const value = { deltaX: deltaX * 0.01, deltaY: deltaY * 0.01 };
      this.lastCamera = value;
      return value;
    }

    const neutral = { deltaX: 0, deltaY: 0 };
    this.lastCamera = neutral;
    return neutral;
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
    this.touchInput = { x: 0, y: 0, lastX: 0, lastY: 0 };
    this.clearRecording();
  }

  /**
   * Dispose (cleanup listeners if needed)
   */
  public dispose(): void {
    this.reset();
  }

  public startRecording(): void {
    this.recording = true;
    this.recordingStart = this.now();
    this.recordedFrames = [];
  }

  public stopRecording(): InputRecording | null {
    if (!this.recording) {
      return this.getRecording();
    }
    this.recording = false;
    return this.getRecording();
  }

  public isRecording(): boolean {
    return this.recording;
  }

  public clearRecording(): void {
    this.recordedFrames = [];
    this.recordingStart = 0;
  }

  public getRecording(): InputRecording | null {
    if (this.recordedFrames.length === 0) {
      return null;
    }
    const duration = this.recordedFrames[this.recordedFrames.length - 1]?.time ?? 0;
    return {
      frames: [...this.recordedFrames],
      duration,
    };
  }

  public exportRecording(): string | null {
    const recording = this.getRecording();
    if (!recording) return null;
    return JSON.stringify(recording, null, 2);
  }

  public importRecording(json: string): InputRecording {
    const data = JSON.parse(json) as InputRecording;
    this.recordedFrames = Array.isArray(data.frames)
      ? data.frames.map((frame) => ({
          time: frame.time,
          movement: { forward: frame.movement.forward, strafe: frame.movement.strafe },
          camera: { deltaX: frame.camera.deltaX, deltaY: frame.camera.deltaY },
          jump: frame.jump,
        }))
      : [];
    this.recordingStart = 0;
    this.recording = false;
    return {
      frames: [...this.recordedFrames],
      duration: data.duration ?? this.recordedFrames.at(-1)?.time ?? 0,
    };
  }

  private recordFrame(): void {
    if (!this.recording) return;
    const now = this.now();
    if (this.recordingStart === 0) {
      this.recordingStart = now;
    }
    const elapsed = (now - this.recordingStart) / 1000;
    const frame: InputFrame = {
      time: elapsed,
      movement: { ...this.lastMovement },
      camera: { ...this.lastCamera },
      jump: this.lastJump,
    };
    this.recordedFrames.push(frame);
  }

  private now(): number {
    if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
      return performance.now();
    }
    return Date.now();
  }
}
