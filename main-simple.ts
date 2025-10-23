import { GameScene } from './GameScene';
import { GraphicsDebug } from './GraphicsDebug';
import { SimpleInputManager, type InputRecording } from './SimpleInputManager';
import { SimpleRenderer } from './SimpleRenderer';
import logger from './src/utils/Logger';
import './style.css';

/**
 * SimpleApp
 *
 * Simplified main application entry point following Messenger's pattern
 * Replaces the 500+ line main.ts with focused initialization
 *
 * Responsibilities:
 * - Setup WebGL canvas
 * - Initialize renderer, scene, camera
 * - Setup input handling
 * - Start render loop
 * - Handle cleanup
 */
class SimpleApp {
  private renderer!: SimpleRenderer;
  private scene!: GameScene;
  private inputManager!: SimpleInputManager;
  private isRunning: boolean = false;
  private debugEnabled: boolean = false;
  private debugInitialized: boolean = false;
  private graphicsDebug?: GraphicsDebug;

  private boundHandlers: {
    beforeUnload?: () => void;
  } = {};

  constructor() {
    this.debugEnabled = this.detectDebugMode();
    (window as unknown as { __app?: SimpleApp }).__app = this;
    (window as typeof window & { enableDebugTools?: () => void }).enableDebugTools = () =>
      this.enableDebugFeatures();
    this.init();
  }

  /**
   * Initialize the application
   */
  private async init(): Promise<void> {
    try {
      // Get or create canvas
      let canvas = document.getElementById('game-canvas') as HTMLCanvasElement;
      if (!canvas) {
        canvas = document.createElement('canvas');
        canvas.id = 'game-canvas';
        document.body.insertBefore(canvas, document.body.firstChild);
        // Set styles
        Object.assign(canvas.style, {
          position: 'fixed',
          top: '0',
          left: '0',
          width: '100%',
          height: '100%',
          zIndex: '1',
        });
      }

      console.log('🎮 Initializing SimpleApp...');

      // Create renderer
      this.renderer = new SimpleRenderer(canvas);
      console.log('✓ Renderer created');

      // Create scene (this will also create planet and player)
      this.scene = new GameScene();
      await this.scene.ready();
      console.log('✓ Scene initialized and ready');

      // Initialize post-processing
      this.renderer.initPostProcessing(this.scene, this.scene.getCamera());
      console.log('✓ Post-processing initialized');

      // Create input manager
      this.inputManager = new SimpleInputManager();
      this.inputManager.attachToCanvas(canvas);
      console.log('✓ Input manager created');

      // Setup cleanup on page unload
      this.boundHandlers.beforeUnload = () => this.dispose();
      window.addEventListener('beforeunload', this.boundHandlers.beforeUnload);

      // Start render loop
      this.startRenderLoop();
      console.log('✓ Render loop started');

      console.log('🌎 DigiScalability Life Island - Simplified Edition initialized!');

      if (this.debugEnabled) {
        this.enableDebugFeatures();
      }
    } catch (error) {
      console.error('❌ Failed to initialize app:', error);
      this.showErrorScreen(error as Error);
    }
  }

  private detectDebugMode(): boolean {
    if (typeof window === 'undefined') {
      return false;
    }

    try {
      const hash = window.location?.hash ?? '';
      const search = window.location?.search ?? '';
      const debugParams = hash.includes('debug') || search.includes('debug=1');
      const forced = Boolean(window.__FORCE_DEBUG);
      const preset = Boolean((window as typeof window & { __DEBUG_MODE?: boolean }).__DEBUG_MODE);
      return debugParams || forced || preset;
    } catch {
      return false;
    }
  }

  /**
   * Start the main render loop
   */
  private startRenderLoop(): void {
    if (this.isRunning) return;
    this.isRunning = true;

    this.renderer.startRenderLoop(this.scene, this.scene.getCamera(), (deltaTime: number) =>
      this.update(deltaTime),
    );
  }

  /**
   * Update game logic (called every frame)
   */
  private update(deltaTime: number): void {
    // Get input
    const moveInput = this.inputManager.getMovementInput();
    const cameraInput = this.inputManager.getCameraInput();
    const jumpInput = this.inputManager.getJumpInput();

    // Apply player input
    this.scene.setPlayerMovement(moveInput.forward, moveInput.strafe);
    if (jumpInput) {
      this.scene.playerJump();
    }

    // Apply camera input (mouse/touch)
    this.scene.setCameraInput(cameraInput.deltaX, cameraInput.deltaY);

    // Update scene (this updates player physics, camera, etc.)
    this.scene.update(deltaTime);
  }

  private enableDebugFeatures(): void {
    if (this.debugInitialized) return;
    if (!this.scene || !this.renderer || !this.inputManager) return;

    this.debugInitialized = true;
    (window as typeof window & { __DEBUG_MODE?: boolean }).__DEBUG_MODE = true;
    window.__DEBUG_PLAYER = true;

    try {
      logger.init();
    } catch (error) {
      console.warn('Logger initialization failed', error);
    }

    this.exposeDebugGlobals();
    this.exposeInputRecorder();
    this.registerDebugCommands();

    try {
      const playerObject = this.scene.getPlayer().getMesh();
      const planetObject = this.scene.getPlanet();
      if (!this.graphicsDebug) {
        this.graphicsDebug = new GraphicsDebug(document.body, undefined, this.scene, {
          player: playerObject,
          planet: planetObject,
        });
      }
    } catch (error) {
      console.warn('GraphicsDebug setup failed', error);
    }

    window.toggleDebugOverlay = (enabled: boolean) => {
      logger.setEnabled(enabled);
    };

    console.info(
      '🔧 Debug tools enabled. Use window.scene, window.camera, and window.__INPUT_RECORDER.',
    );
  }

  private exposeDebugGlobals(): void {
    const globalWindow = window as typeof window & {
      scene?: GameScene;
      camera?: ReturnType<GameScene['getCamera']>;
      renderer?: ReturnType<SimpleRenderer['getRenderer']>;
      player?: ReturnType<GameScene['getPlayer']>;
      planet?: ReturnType<GameScene['getPlanet']>;
      orbitCamera?: ReturnType<GameScene['getOrbitCamera']>;
      runCameraFlyIn?: (duration?: number) => Promise<void>;
      listRecentLogs?: () => unknown[];
    };

    globalWindow.scene = this.scene;
    globalWindow.camera = this.scene.getCamera();
    globalWindow.renderer = this.renderer.getRenderer();
    globalWindow.player = this.scene.getPlayer();
    globalWindow.planet = this.scene.getPlanet();
    globalWindow.orbitCamera = this.scene.getOrbitCamera();
    globalWindow.runCameraFlyIn = async (duration?: number) => {
      await this.scene.getOrbitCamera().flyInFromDistant(duration ?? 2000);
    };
    globalWindow.listRecentLogs = () => window.__LOGGER?.getRecent?.() ?? [];
  }

  private exposeInputRecorder(): void {
    const recorder = {
      start: () => this.inputManager.startRecording(),
      stop: () => this.inputManager.stopRecording(),
      export: () => this.inputManager.exportRecording(),
      clear: () => this.inputManager.clearRecording(),
      get: () => this.inputManager.getRecording(),
      isRecording: () => this.inputManager.isRecording(),
    } satisfies {
      start(): void;
      stop(): InputRecording | null;
      export(): string | null;
      clear(): void;
      get(): InputRecording | null;
      isRecording(): boolean;
    };

    (window as typeof window & { __INPUT_RECORDER?: typeof recorder }).__INPUT_RECORDER = recorder;
  }

  private registerDebugCommands(): void {
    const globalWindow = window as typeof window & {
      captureInput?: (seconds?: number) => Promise<InputRecording | null>;
      enableDebugTools?: () => void;
    };

    globalWindow.captureInput = async (seconds: number = 5) => {
      this.inputManager.startRecording();
      await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
      return this.inputManager.stopRecording();
    };

    globalWindow.enableDebugTools = () => this.enableDebugFeatures();
  }

  /**
   * Display error screen on initialization failure
   */
  private showErrorScreen(error: Error): void {
    const errorDiv = document.createElement('div');
    Object.assign(errorDiv.style, {
      position: 'fixed',
      top: '0',
      left: '0',
      width: '100%',
      height: '100%',
      background: '#1a1a1a',
      color: '#ff6b6b',
      fontFamily: 'monospace',
      padding: '20px',
      zIndex: '9999',
      overflow: 'auto',
    });

    errorDiv.innerHTML = `
      <h1>❌ Initialization Error</h1>
      <p>${error.message}</p>
      <pre>${error.stack || ''}</pre>
      <button onclick="location.reload()" style="
        background: #ff6b6b;
        color: white;
        border: none;
        padding: 10px 20px;
        margin-top: 20px;
        cursor: pointer;
        font-size: 16px;
      ">Reload Page</button>
    `;

    document.body.appendChild(errorDiv);
  }

  /**
   * Cleanup and dispose resources
   */
  private dispose(): void {
    console.log('🛑 Disposing resources...');

    if (this.inputManager) {
      this.inputManager.dispose();
    }

    if (this.scene) {
      this.scene.dispose();
    }

    if (this.renderer) {
      this.renderer.dispose();
    }

    if (this.boundHandlers.beforeUnload) {
      window.removeEventListener('beforeunload', this.boundHandlers.beforeUnload);
    }

    this.isRunning = false;
  }
}

// Initialize app when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => new SimpleApp());
} else {
  new SimpleApp();
}

// Global debug helpers
(window as any).getGameState = () => {
  return {
    isRunning: (window as any).__app?.isRunning || false,
    timestamp: new Date().toISOString(),
  };
};

console.log('%c🌎 Welcome to DigiScalability Life Island', 'color: #4ade80; font-size: 16px; font-weight: bold');
console.log('%cSimplified architecture ready for deployment', 'color: #60a5fa');
