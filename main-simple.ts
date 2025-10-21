import { GameScene } from './GameScene';
import { SimpleInputManager } from './SimpleInputManager';
import { SimpleRenderer } from './SimpleRenderer';
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

  private boundHandlers: {
    beforeUnload?: () => void;
  } = {};

  constructor() {
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
      this.renderer.initPostProcessing(
        this.scene,
        this.scene.getCamera()
      );
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

    } catch (error) {
      console.error('❌ Failed to initialize app:', error);
      this.showErrorScreen(error as Error);
    }
  }

  /**
   * Start the main render loop
   */
  private startRenderLoop(): void {
    if (this.isRunning) return;
    this.isRunning = true;

    this.renderer.startRenderLoop(
      this.scene,
      this.scene.getCamera(),
      (deltaTime: number) => this.update(deltaTime)
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
