import * as THREE from 'three';
import { BloomPass } from 'three/addons/postprocessing/BloomPass.js';
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

  constructor(canvas: HTMLCanvasElement) {
    // Create WebGL renderer with anti-aliasing
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true, // scene is ~45k tris now — plenty of headroom
      alpha: false,
      powerPreference: 'high-performance',
      precision: 'highp',
    });

    // Configure renderer
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    // Limit shadow resolution for better performance on mobile
    this.renderer.shadowMap.autoUpdate = true;

    // Set a clear background color for debugging
    this.renderer.setClearColor(0x87ceeb, 1); // Sky blue

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

    // Bloom effect
    const bloomPass = new BloomPass(
      1.0, // strength
      25, // radius
      4.0, // threshold
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

      // Get delta time
      const deltaTime = this.clock.getDelta();

      // Update game logic
      if (this.renderCallback) {
        this.renderCallback(deltaTime);
      }

      // Render
      this.render();
    };

    animate();
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
