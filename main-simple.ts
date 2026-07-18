import { DeliverySystem } from './DeliverySystem';
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
  private deliverySystem!: DeliverySystem;
  private isRunning: boolean = false;

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
        this.ui = new SimpleUI('ui-overlay');
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

      // Initialize delivery system
      this.deliverySystem = new DeliverySystem();
      this.ui.showLoading(95);
      console.log('✓ Delivery system initialized');

      // Assign the full quest chain across the mailboxes (round-robin) and
      // route mailbox interaction through the delivery system
      const mailboxes = this.scene.getMailboxes();
      this.deliverySystem.assignDestinations(mailboxes);
      this.scene.setOnMailboxInteract((mailbox) =>
        this.deliverySystem.collectFromMailbox(mailbox),
      );
      console.log(`✓ Quest deliveries assigned across ${mailboxes.length} mailboxes`);

      // Setup quest completion callback
      this.deliverySystem.setOnQuestComplete((quest) => {
        console.log(`🎉 Quest "${quest.name}" completed!`);
        this.ui.showQuestComplete(quest);
      });

      // Setup zone interaction callback
      this.scene.setOnZoneInteract((zone) => {
        console.log(`🎯 Opening zone: ${zone.name}`);
        this.ui.showZonePanel(zone);
      });

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

      // Start background music
      this.startBackgroundMusic();

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
      } else if (event.key.toLowerCase() === 'c') {
        // Toggle character customization
        if (this.ui['customizeDiv']) {
          this.ui.hideCustomize();
        } else {
          this.ui.showCustomize((part, value) => {
            console.log(`🎨 Changed ${part} to ${value}`);
            // TODO: Apply customization to player
          });
        }
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
        } else if (nearby.type === 'zone') {
          text = `🎯 Press <strong>E</strong> to explore ${nearby.zone.name}`;
        }
        this.ui.showInteractionPrompt(text);

        // Consume the latched press: fires at most once per physical E press,
        // immune to both key auto-repeat and taps shorter than one frame.
        if (this.inputManager.consumeKeyPress('e')) {
          this.scene.interactWith(nearby);
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

    // Quest compass: point at the active delivery's mailbox
    this.updateQuestCompass();

    // Always update scene (for animations, etc.)
    this.scene.update(deltaTime);
  }

  /**
   * Compute the bearing from the camera's forward direction to the active
   * delivery target (both projected onto the player's tangent plane) and
   * feed it to the HUD compass. Hidden when the chain is complete.
   */
  private updateQuestCompass(): void {
    const active = this.deliverySystem?.getActiveDeliveries?.() ?? [];
    const target = active.length > 0 ? active[0] : null;
    if (!target || !target.destination) {
      this.ui.updateQuestCompass(null);
      return;
    }
    const player = this.scene.getPlayer();
    const playerPos = player.getWorldPosition();
    const normal = player.getSurfaceNormal();
    const targetPos = target.destination.mesh.position;

    const project = (v: { clone(): any }) => {
      const p = (v as any).clone();
      return p.sub(normal.clone().multiplyScalar(p.dot(normal)));
    };
    const toTarget = project(targetPos.clone().sub(playerPos));
    const camForward = project(this.scene.getOrbitCamera().getForwardDirection());
    if (toTarget.lengthSq() < 1e-6 || camForward.lengthSq() < 1e-6) {
      this.ui.updateQuestCompass(null);
      return;
    }
    toTarget.normalize();
    camForward.normalize();
    const cross = camForward.clone().cross(toTarget);
    const angleRad = Math.atan2(cross.dot(normal), camForward.dot(toTarget));
    // great-circle distance on the planet surface
    const R = playerPos.length();
    const arc = playerPos.clone().normalize().angleTo(targetPos.clone().normalize());
    this.ui.updateQuestCompass({
      angleRad,
      distance: arc * R,
      label: '\uD83D\uDCEC Delivery',
    });
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
   * Start background music
   */
  private async startBackgroundMusic(): Promise<void> {
    try {
      // Create audio manager if not exists
      if (!(window as any).audioManager) {
        (window as any).audioManager = new (await import('./AudioManager')).AudioManager();
      }
      const audioManager = (window as any).audioManager;

      // Try to load a background music file
      // For now, we'll create a simple generative ambient track
      console.log('🎵 Generating ambient background music...');

      // Create a simple ambient audio buffer
      const ctx = audioManager.ensureCtx();
      const sampleRate = ctx.sampleRate;
      const duration = 120; // 2 minutes
      const frameCount = sampleRate * duration;

      const buffer = ctx.createBuffer(2, frameCount, sampleRate); // Stereo

      // Generate simple ambient tones
      for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
        const channelData = buffer.getChannelData(channel);
        for (let i = 0; i < frameCount; i++) {
          // Create gentle sine waves with some randomness
          const t = i / sampleRate;
          const freq1 = 220 + Math.sin(t * 0.1) * 20; // Slow modulation
          const freq2 = 330 + Math.sin(t * 0.15) * 30;
          const wave1 = Math.sin(t * freq1 * 2 * Math.PI) * 0.3;
          const wave2 = Math.sin(t * freq2 * 2 * Math.PI) * 0.2;
          const noise = (Math.random() - 0.5) * 0.05; // Subtle noise

          channelData[i] = (wave1 + wave2 + noise) * 0.1; // Low volume
        }
      }

      // Load the buffer and play
      await audioManager.loadAudioBuffer(buffer, 'background_music');
      audioManager.playBackground('background_music');

      console.log('🎵 Ambient background music started');
    } catch (error) {
      console.warn('Failed to start background music:', error);
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

// Idempotent boot: guard against any double module evaluation (HMR edge cases,
// prerendered/duplicated page targets) constructing two apps on one canvas.
const bootState = window as unknown as { __lifeIslandBooted?: boolean };
const bootApp = () => {
  if (bootState.__lifeIslandBooted) return;
  bootState.__lifeIslandBooted = true;
  new SimpleApp();
};

// Initialize app when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootApp);
} else {
  bootApp();
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
