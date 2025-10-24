import { GameScene } from './GameScene';
import { SimpleInputManager } from './SimpleInputManager';
import { SimpleRenderer } from './SimpleRenderer';
import { SimpleUI } from './SimpleUI';
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
  private ui!: SimpleUI;
  private isRunning: boolean = false;
  private lastInteractAt: number = 0;

  // FPS tracking
  private frameCount: number = 0;
  private fpsUpdateInterval: number = 0;

  private boundHandlers: {
    beforeUnload?: () => void;
    debugKeydown?: (event: KeyboardEvent) => void;
  } = {};

  constructor() {
    (window as any).__simpleApp = this;
    (window as any).__app = this;
    this.init();
  }

  /**
   * Initialize the application
   */
  private async init(): Promise<void> {
    try {
      console.log('🎮 Starting SimpleApp initialization...');

      // Get or create canvas
      let canvas = document.getElementById('game-canvas') as HTMLCanvasElement;
      if (!canvas) {
        canvas = document.createElement('canvas');
        canvas.id = 'game-canvas';
        document.body.insertBefore(canvas, document.body.firstChild);
      }

      // Always enforce canvas styling so the WebGL output stays on top of the gradient background
      Object.assign(canvas.style, {
        position: 'fixed',
        top: '0',
        left: '0',
        width: '100%',
        height: '100%',
        zIndex: '500',
        display: 'block',
      });

      console.log('✓ Canvas created');

      // Remove legacy DOM overlays that conflict with the simplified UI stack
      this.disableLegacyUI();

      // Create UI first (shows loading screen)
      try {
        this.ui = new SimpleUI('ui-overlay', canvas);
        console.log('✓ UI constructor called with canvas');
        this.ui.showLoading(10);
        console.log('✓ Loading screen shown');
      } catch (uiError) {
        console.error('❌ UI creation failed:', uiError);
        throw uiError;
      }

      // Create renderer
      this.renderer = new SimpleRenderer(canvas);
      console.log('🎨 SimpleRenderer created:', {
        canvas: this.renderer.getCanvas(),
        renderer: this.renderer.getRenderer(),
        devicePixelRatio: this.renderer.getDevicePixelRatio(),
      });
      this.ui.showLoading(50);
      console.log('✓ Renderer created');

      // Create scene (this will also create planet and player)
      this.scene = new GameScene();
      this.ui.showLoading(60);
      await this.scene.ready();
      this.ui.showLoading(90);
      console.log('✓ Scene initialized and ready');

      // Initialize post-processing
      this.renderer.initPostProcessing(this.scene, this.scene.getCamera());
      console.log('✓ Post-processing initialized');

      this.renderer.setPostProcessingEnabled(false);
      console.log('✨ Bloom disabled by default for crisp visuals (Ctrl+B to toggle).');

      this.setupDebugShortcuts();

      // Create input manager
      this.inputManager = new SimpleInputManager();
      this.inputManager.attachToCanvas(canvas);
      console.log('✓ Input manager created');

      // Setup cleanup on page unload
      this.boundHandlers.beforeUnload = () => this.dispose();
      window.addEventListener('beforeunload', this.boundHandlers.beforeUnload);

      // Finish loading and show welcome
      this.ui.showLoading(100);
      setTimeout(() => {
        this.ui.hideLoading();
        this.ui.showWelcome();
      }, 500);

      // Start render loop
      this.startRenderLoop();
      console.log('✓ Render loop started');

      console.log('🌎 DigiScalability Life Island - Simplified Edition initialized!');

      // Debug: Log canvas visibility once so we can confirm it's mounted correctly
      console.log('🖼️ Canvas ready:', {
        width: canvas.width,
        height: canvas.height,
        style: canvas.style.cssText,
      });
    } catch (error) {
      console.error('❌ Failed to initialize app:', error);
      this.showErrorScreen(error as Error);
    }
  }

  /**
   * Remove existing static overlays from index.html so the simplified UI can take over
   */
  private disableLegacyUI(): void {
    const legacyIds = ['loading-screen', 'welcome-modal', 'hud-overlay'];
    legacyIds.forEach((id) => {
      const element = document.getElementById(id);
      if (element) {
        element.remove();
        console.log(`🧹 Removed legacy UI element: ${id}`);
      }
    });
  }

  private setupDebugShortcuts(): void {
    if (this.boundHandlers.debugKeydown) return;

    const handler = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.key.toLowerCase() === 'b') {
        event.preventDefault();
        const enabled = this.renderer.togglePostProcessing();
        console.log(
          enabled
            ? '✨ Bloom enabled (Ctrl+B to toggle).'
            : '✨ Bloom disabled (Ctrl+B to toggle).',
        );
      }
    };

    this.boundHandlers.debugKeydown = handler;
    document.addEventListener('keydown', handler);
  }

  /**
   * Start the main render loop
   */
  private startRenderLoop(): void {
    if (this.isRunning) return;
    this.isRunning = true;

    console.log('🔄 Starting render loop...');
    console.log('🔍 Render loop parameters:', {
      scene: this.scene,
      camera: this.scene.getCamera(),
      sceneChildren: this.scene.children.length,
      hasPlayer: !!this.scene.getPlayer(),
      hasPlanet: this.scene.children.some((child) => child.userData.type === 'planet'),
    });

    this.renderer.startRenderLoop(this.scene, this.scene.getCamera(), (deltaTime: number) =>
      this.update(deltaTime),
    );

    // Debug: Log that render loop is active after 1 second
    setTimeout(() => {
      console.log('✅ Render loop has been active for 1 second, FPS counter should show data');
    }, 1000);
  }

  /**
   * Update game logic (called every frame)
   */
  private update(deltaTime: number): void {
    // Update FPS counter
    this.updateFPS(deltaTime);

    // Only process input if welcome screen is not visible
    if (!this.ui.isWelcomeVisible()) {
      // Get input
      const moveInput = this.inputManager.getMovementInput();
      const cameraInput = this.inputManager.getCameraInput();
      const jumpInput = this.inputManager.getJumpInput();

      // Debug: log when input is detected (only log once per second to avoid spam)
      if (this.frameCount % 60 === 0) {
        // Log every ~60 frames
        if (
          moveInput.forward !== 0 ||
          moveInput.strafe !== 0 ||
          jumpInput ||
          cameraInput.deltaX !== 0 ||
          cameraInput.deltaY !== 0
        ) {
          console.log('🎮 Input detected:', { moveInput, cameraInput, jumpInput });
        }
      }

      // Apply player input
      this.scene.setPlayerMovement(moveInput.forward, moveInput.strafe);
      if (jumpInput) {
        this.scene.playerJump();
      }

      // Apply camera input (mouse/touch)
      this.scene.setCameraInput(cameraInput.deltaX, cameraInput.deltaY);

      // Check for nearby interactable and handle interaction
      const nearby = this.scene.getNearbyInteractable();
      if (nearby) {
        // Show interaction prompt
        let text = '⌨️ Press <strong>E</strong> to interact';
        if (nearby.type === 'mailbox') {
          text = nearby.mailbox.bubbleText || text;
        } else if (nearby.type === 'lamp') {
          text = '💡 Press <strong>E</strong> to toggle lamp';
        }
        this.ui.showInteractionPrompt(text);

        // Debounce interactions to avoid repeated triggers while holding E
        const now = performance.now();
        if (this.inputManager.isKeyPressed('e') && now - this.lastInteractAt > 300) {
          this.scene.interactWith(nearby);
          this.lastInteractAt = now;
        }
      } else {
        // Hide prompt when not near interactable
        this.ui.hideInteractionPrompt();
      }
    } else {
      // Stop player movement when welcome screen is visible
      this.scene.setPlayerMovement(0, 0);
      this.scene.setCameraInput(0, 0);
    }

    // Always update scene (for animations, etc.)
    this.scene.update(deltaTime);
  }

  /**
   * Update FPS counter
   */
  private updateFPS(deltaTime: number): void {
    this.frameCount++;
    this.fpsUpdateInterval += deltaTime;

    if (this.fpsUpdateInterval >= 1.0) {
      // Update every second
      const fps = this.frameCount / this.fpsUpdateInterval;
      this.ui.updateFPS(fps);
      this.frameCount = 0;
      this.fpsUpdateInterval = 0;
    }
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

    if (this.ui) {
      this.ui.dispose();
    }

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

    if (this.boundHandlers.debugKeydown) {
      document.removeEventListener('keydown', this.boundHandlers.debugKeydown);
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
