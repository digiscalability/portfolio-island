import * as THREE from 'three';
// Bloom/post-processing addons are type-only at module scope (erased from the
// bundle) and loaded lazily as a parallel chunk in initPostProcessing() — see
// there. Keeps the ~40KB of postprocessing code out of the critical bundle that
// blocks first paint; it's still fetched and warmed well before the reveal.
import type { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import type { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';

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
  private bloomPass?: UnrealBloomPass;
  private postProcessingEnabled: boolean = false;

  // Hard ceiling on rendered pixels (width·height·dpr²). Without it a retina
  // or large desktop screen renders 4–8M pixels THROUGH the bloom chain and
  // stutters — the "laggy on different screen sizes". Adaptive resolution then
  // floats DOWN from here under load.
  private static readonly PIXEL_BUDGET = 2_500_000;
  private resizeTimer = 0;
  private lastAppliedWidth = 0;
  private lastAppliedHeight = 0;

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
      antialias: true, // native MSAA: the whole image on the low tier (no composer) and the bloom-off path elsewhere
      alpha: false,
      powerPreference: 'high-performance',
      precision: 'highp',
    });

    // Device-tier ceiling, then clamped by the pixel budget for this viewport.
    this.dprCap = this.budgetedDpr(window.innerWidth, window.innerHeight);
    this.renderer.setPixelRatio(this.dprCap);
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.08;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
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

  /** Coarse-pointer (phone/tablet) or low-core device — the tier that gets a
   * lower DPR cap and skips the composer entirely (see initPostProcessing).
   * Same heuristic GameScene/Island use for shadow-map size and grass count. */
  public static isLowTierDevice(): boolean {
    const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
    const lowCore = (navigator.hardwareConcurrency || 8) <= 4;
    return coarse || lowCore;
  }

  /** Device-tier DPR ceiling: phones/tablets and low-core machines can't
   * afford 2× on a scene this dense. */
  private tierDprCeiling(): number {
    return Math.min(window.devicePixelRatio || 1, SimpleRenderer.isLowTierDevice() ? 1.25 : 2);
  }

  /** Tier ceiling, further clamped so width·height·dpr² ≤ PIXEL_BUDGET. */
  private budgetedDpr(width: number, height: number): number {
    const ceil = this.tierDprCeiling();
    const maxByBudget = Math.sqrt(SimpleRenderer.PIXEL_BUDGET / Math.max(1, width * height));
    return Math.max(this.dprFloor, Math.min(ceil, maxByBudget));
  }

  /**
   * Initialize post-processing effects
   */
  public async initPostProcessing(scene: THREE.Scene, camera: THREE.Camera): Promise<void> {
    if (this.composer) return; // Already initialized

    // Coarse/low-core tier: no composer at all. On tile GPUs the ~13 bloom
    // passes and the two full-canvas HalfFloat targets cost more than bloom
    // is worth, and the direct path renders into the natively antialiased
    // canvas — faster AND sharper. Returning before the imports also keeps
    // the postprocessing chunk from ever being fetched.
    if (SimpleRenderer.isLowTierDevice()) return;

    // Lazy-load the postprocessing addons as a parallel chunk (kept out of the
    // critical bundle via the type-only imports above). Awaited by the caller
    // before warmUp(), so bloom is still fully compiled ahead of the reveal.
    const [{ EffectComposer }, { RenderPass }, { UnrealBloomPass }, { OutputPass }] =
      await Promise.all([
        import('three/addons/postprocessing/EffectComposer.js'),
        import('three/addons/postprocessing/RenderPass.js'),
        import('three/addons/postprocessing/UnrealBloomPass.js'),
        import('three/addons/postprocessing/OutputPass.js'),
      ]);

    // Explicit MSAA render target: EffectComposer's default target has
    // samples: 0, which routed every frame around the canvas's native MSAA —
    // the shipped image had zero antialiasing. clone() preserves `samples`,
    // so both ping-pong buffers inherit it; HalfFloatType keeps bloom's HDR
    // input intact. Desktop-only by the tier gate above.
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    const msaaTarget = new THREE.WebGLRenderTarget(size.x, size.y, {
      type: THREE.HalfFloatType,
      samples: 4,
    });
    this.composer = new EffectComposer(this.renderer, msaaTarget);
    this.composer.setSize(window.innerWidth, window.innerHeight);

    // Render pass
    const renderPass = new RenderPass(scene, camera);
    this.composer.addPass(renderPass);

    // Bloom effect (UnrealBloomPass: resolution, strength, radius, threshold).
    // Rendered at HALF resolution — bloom is a blur, so the halving is
    // invisible but its multi-pass downsample chain costs ~4× less.
    const bloomPass = new UnrealBloomPass(
      new THREE.Vector2(Math.ceil(window.innerWidth / 2), Math.ceil(window.innerHeight / 2)),
      0.4, // strength — subtle glow
      0.6, // radius — tight halos
      0.85, // threshold — only bright emissives bloom
    );
    bloomPass.setSize(Math.ceil(window.innerWidth / 2), Math.ceil(window.innerHeight / 2));
    this.bloomPass = bloomPass;
    this.composer.addPass(bloomPass);

    // Output pass (tone mapping, gamma)
    const outputPass = new OutputPass();
    this.composer.addPass(outputPass);
  }

  /**
   * Render one throwaway frame while the loading screen still covers the
   * canvas. This compiles the post-processing (bloom/output) shader programs
   * and primes the first shadow-map render — work that otherwise lands on the
   * very first visible frame as a hitch during the reveal.
   */
  public warmUp(scene: THREE.Scene, camera: THREE.Camera): void {
    this.scene = scene;
    this.camera = camera;
    try {
      // compile() walks the ENTIRE scene and builds every shader program up
      // front. A single hidden render only compiles what that one viewpoint
      // happened to see — everything else compiled mid-fly-in, and each
      // compile stalls a frame, which is what shows as a white flash. The
      // heavy sea shader (wave normals + surf) made this much more visible.
      this.renderer.compile(scene, camera);
      if (this.postProcessingEnabled && this.composer) {
        this.composer.render();
      } else {
        this.renderer.render(scene, camera);
      }
    } catch {
      /* warm-up is best-effort */
    }
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
      const effectiveDpr = this.dprCap * this.renderScale;
      this.renderer.setPixelRatio(effectiveDpr);
      if (this.composer) {
        // Must be setPixelRatio, not setSize: the composer caches its pixel
        // ratio and setSize multiplies by the STALE cached value, so the
        // scene+bloom targets never shrank and the controller was a no-op.
        // setPixelRatio re-runs setSize internally with the new ratio.
        this.composer.setPixelRatio(effectiveDpr);
        // Composer resize resets bloom to full res — keep it at half.
        this.bloomPass?.setSize(Math.ceil(window.innerWidth / 2), Math.ceil(window.innerHeight / 2));
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
   * Set post-processing enabled/disabled. A no-op enable when no composer
   * exists (low-tier skip in initPostProcessing) — the flag must not claim
   * bloom is on while render() falls through to the direct path.
   */
  public setPostProcessingEnabled(enabled: boolean): void {
    this.postProcessingEnabled = enabled && !!this.composer;
  }

  public isPostProcessingEnabled(): boolean {
    return this.postProcessingEnabled;
  }

  /** Whether a composer was ever constructed (false on the low tier). */
  public isPostProcessingAvailable(): boolean {
    return !!this.composer;
  }

  public togglePostProcessing(): boolean {
    if (!this.composer) return false; // low tier: nothing to toggle
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
    // Debounce: resize fires many times per second during a window drag, and
    // reallocating the composer's render targets on every event is what makes
    // resizing stutter. The canvas CSS-stretches until the drag settles.
    if (this.resizeTimer) clearTimeout(this.resizeTimer);
    this.resizeTimer = window.setTimeout(() => {
      this.resizeTimer = 0;
      // Ignore the mobile address-bar show/hide. It fires resize with a
      // height change of ~60-120px and no width change, and reallocating the
      // composer's render targets for it produces a one-frame white flash
      // while scrolling/driving on a phone. The canvas CSS-stretches over the
      // difference, which is imperceptible at this magnitude.
      const dh = Math.abs(window.innerHeight - this.lastAppliedHeight);
      const dw = Math.abs(window.innerWidth - this.lastAppliedWidth);
      if (dw === 0 && dh > 0 && dh <= 140) return;
      this.applyViewportSize();
    }, 150);
  }

  private applyViewportSize(): void {
    const width = window.innerWidth;
    const height = window.innerHeight;
    this.lastAppliedWidth = width;
    this.lastAppliedHeight = height;

    // Re-derive the pixel-budget ceiling for the new viewport; keep the
    // adaptive scale the controller has settled on.
    this.dprCap = this.budgetedDpr(width, height);
    this.renderer.setPixelRatio(this.dprCap * this.renderScale);
    this.renderer.setSize(width, height);

    if (this.composer) {
      // Push the re-derived cap (and the settled adaptive scale) into the
      // composer's cached pixel ratio first — setSize alone would keep the
      // stale ratio (see updateAdaptiveResolution) — then apply the new dims.
      this.composer.setPixelRatio(this.dprCap * this.renderScale);
      this.composer.setSize(width, height);
      // composer.setSize resets bloom to full res — keep it at half.
      this.bloomPass?.setSize(Math.ceil(width / 2), Math.ceil(height / 2));
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
