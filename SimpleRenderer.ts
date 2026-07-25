import * as THREE from 'three';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';

/**
 * SimpleRenderer
 *
 * Simplified WebGL renderer replacing complex Renderer.ts
 * Handles:
 * - WebGL context setup
 * - Post-processing (bloom, bloom only)
 * - Render loop
 * - Shadow map configuration
 */
export class SimpleRenderer {
  private renderer: THREE.WebGLRenderer;
  private composer?: EffectComposer;
  private postProcessingEnabled: boolean = false;

  private scene?: THREE.Scene;
  private camera?: THREE.Camera;
  private renderCallback?: (deltaTime: number) => void;

  private animationId: number = 0;
  private clock: THREE.Clock = new THREE.Clock();
  private isRunning: boolean = false;

  // Adaptive resolution: render at a fraction of the CSS resolution and let
  // it float with the frame budget. This is the biggest single lever for a
  // slow/loaded GPU (e.g. several tabs sharing one card) since pixel cost
  // scales with the square of the ratio.
  private dprCap: number; // hard ceiling (device tier)
  private dprFloor = 0.6; // never go blurrier than this
  private renderScale = 1; // current multiplier applied on top of dprCap
  private fpsEma = 60; // smoothed frame rate driving the controller
  private qualityAccum = 0; // seconds since the last quality adjustment

  constructor(canvas: HTMLCanvasElement) {
    // Create WebGL renderer with anti-aliasing
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true, // scene is ~45k tris now — plenty of headroom
      alpha: false,
      powerPreference: 'high-performance',
      precision: 'highp',
    });

    // Device-tier pixel-ratio ceiling. Phones/tablets (coarse pointer) and
    // low-core machines can't afford 2x on a scene this dense, so they start
    // lower; the adaptive controller floats down further under load.
    const coarse =
      typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
    const lowCore = (navigator.hardwareConcurrency || 8) <= 4;
    this.dprCap = Math.min(window.devicePixelRatio, coarse || lowCore ? 1.25 : 2);
    this.renderer.setPixelRatio(this.dprCap);
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.08;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    // Limit shadow resolution for better performance on mobile
    this.renderer.shadowMap.autoUpdate = true;

    // Set a clear background color for debugging
    this.renderer.setClearColor(0xa8d8f0, 1);

    console.log('🎨 SimpleRenderer configured:', {
      size: [window.innerWidth, window.innerHeight],
      pixelRatio: this.renderer.getPixelRatio(),
      clearColor: '#' + this.renderer.getClearColor(new THREE.Color()).getHexString(),
      shadowMap: this.renderer.shadowMap.enabled,
    });

    // Responsive resize
    window.addEventListener('resize', () => this.onWindowResize());
  }

  /**
   * Initialize post-processing effects
   */
  public initPostProcessing(scene: THREE.Scene, camera: THREE.Camera): void {
    if (this.composer) return; // Already initialized

    // Create effect composer
    this.composer = new EffectComposer(this.renderer);
    this.composer.setSize(window.innerWidth, window.innerHeight);

    // Render pass
    const renderPass = new RenderPass(scene, camera);
    this.composer.addPass(renderPass);

    // Bloom effect (UnrealBloomPass: resolution, strength, radius, threshold)
    const bloomPass = new UnrealBloomPass(
      new THREE.Vector2(window.innerWidth, window.innerHeight),
      0.4, // strength — subtle glow
      0.6, // radius — tight halos
      0.85, // threshold — only bright emissives bloom
    );
    this.composer.addPass(bloomPass);

    // Output pass (tone mapping, gamma)
    const outputPass = new OutputPass();
    this.composer.addPass(outputPass);
  }

  /**
   * Start the render loop
   */
  public startRenderLoop(
    scene: THREE.Scene,
    camera: THREE.Camera,
    onUpdate: (deltaTime: number) => void,
  ): void {
    if (this.isRunning) return;

    this.scene = scene;
    this.camera = camera;
    this.renderCallback = onUpdate;
    this.isRunning = true;
    this.clock.start();

    const animate = () => {
      this.animationId = requestAnimationFrame(animate);

      // Backgrounded tab: skip ALL sim + GPU work. rAF is already throttled
      // when hidden, but a tab can still receive occasional catch-up frames —
      // and with several tabs open that wasted render is exactly what makes
      // the others stutter. Presence is kept alive by Multiplayer's own 1s
      // heartbeat, so nothing is lost by going fully idle here.
      if (typeof document !== 'undefined' && document.hidden) {
        this.clock.getDelta(); // drain so the resume frame isn't a huge dt
        return;
      }

      // Clamp dt: after a stall (alt-tab, GC pause) getDelta can be huge and
      // would teleport physics/animation on the catch-up frame.
      const deltaTime = Math.min(this.clock.getDelta(), 0.05);

      // Update game logic
      if (this.renderCallback) {
        this.renderCallback(deltaTime);
      }

      // Render
      this.render();

      // Float the render resolution to hold the frame budget
      this.updateAdaptiveResolution(deltaTime);
    };

    animate();
  }

  /**
   * Nudge the internal render scale toward whatever the GPU can sustain.
   * Runs at most ~once/second with hysteresis so it settles instead of
   * oscillating. Costs nothing when already at the ceiling and healthy.
   */
  private updateAdaptiveResolution(deltaTime: number): void {
    if (deltaTime <= 0) return;
    // Exponential moving average of instantaneous FPS
    const instFps = 1 / deltaTime;
    this.fpsEma += (instFps - this.fpsEma) * 0.1;

    this.qualityAccum += deltaTime;
    if (this.qualityAccum < 1) return;
    this.qualityAccum = 0;

    const prev = this.renderScale;
    if (this.fpsEma < 45 && this.renderScale > this.dprFloor / this.dprCap) {
      // Struggling: shed ~15% of the pixels
      this.renderScale = Math.max(this.dprFloor / this.dprCap, this.renderScale - 0.15);
    } else if (this.fpsEma > 57 && this.renderScale < 1) {
      // Plenty of headroom: claw resolution back gently
      this.renderScale = Math.min(1, this.renderScale + 0.1);
    }
    if (this.renderScale !== prev) {
      this.renderer.setPixelRatio(this.dprCap * this.renderScale);
      if (this.composer) {
        this.composer.setSize(window.innerWidth, window.innerHeight);
      }
    }
  }

  /**
   * Stop the render loop
   */
  public stopRenderLoop(): void {
    if (this.animationId) {
      cancelAnimationFrame(this.animationId);
      this.animationId = 0;
    }
    this.isRunning = false;
  }

  /**
   * Render a single frame
   */
  private render(): void {
    if (!this.scene || !this.camera) {
      console.warn('⚠️ Render called but scene or camera missing:', {
        scene: !!this.scene,
        camera: !!this.camera,
      });
      return;
    }

    if (this.postProcessingEnabled && this.composer) {
      this.composer.render();
    } else {
      this.renderer.render(this.scene, this.camera);
    }
  }

  /**
   * Set post-processing enabled/disabled
   */
  public setPostProcessingEnabled(enabled: boolean): void {
    this.postProcessingEnabled = enabled;
  }

  public isPostProcessingEnabled(): boolean {
    return this.postProcessingEnabled;
  }

  public togglePostProcessing(): boolean {
    this.postProcessingEnabled = !this.postProcessingEnabled;
    return this.postProcessingEnabled;
  }

  /**
   * Get the WebGL renderer
   */
  public getRenderer(): THREE.WebGLRenderer {
    return this.renderer;
  }

  /**
   * Get canvas element
   */
  public getCanvas(): HTMLCanvasElement {
    return this.renderer.domElement;
  }

  /**
   * Handle window resize
   */
  private onWindowResize(): void {
    const width = window.innerWidth;
    const height = window.innerHeight;

    this.renderer.setSize(width, height);

    if (this.composer) {
      this.composer.setSize(width, height);
    }

    if (this.camera && 'aspect' in this.camera) {
      (this.camera as THREE.PerspectiveCamera).aspect = width / height;
      (this.camera as THREE.PerspectiveCamera).updateProjectionMatrix();
    }
  }

  /**
   * Get device pixel ratio
   */
  public getDevicePixelRatio(): number {
    return this.renderer.getPixelRatio();
  }

  /**
   * Dispose resources
   */
  public dispose(): void {
    this.stopRenderLoop();

    if (this.composer) {
      this.composer.dispose();
    }

    this.renderer.dispose();
  }
}
