import * as THREE from 'three';
// Bloom/post-processing addons are type-only at module scope (erased from the
// bundle) and loaded lazily as a parallel chunk in initPostProcessing() — see
// there. Keeps the ~40KB of postprocessing code out of the critical bundle that
// blocks first paint; it's still fetched and warmed well before the reveal.
import type { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import type { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';

import { isRealTheme } from './Theme';

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
  private contextLost = false; // true between webglcontextlost and ...restored

  // Frame limiter + refresh-derived thresholds. The first ~60 rAF callbacks
  // run UNCAPPED while the shortest frame interval is recorded — that cadence
  // IS the display refresh (janky frames only ever run longer). Then the
  // coarse/low-core tier is capped at 60fps (90/120Hz phones render at full
  // refresh for zero gameplay gain, and the thermal throttling that buys
  // degrades the rest of the session), and the adaptive controller's
  // thresholds are scaled to the achievable rate — against the old hardcoded
  // 45/57 a struggling 120Hz desktop at 70fps read as "healthy".
  private static readonly REFRESH_SAMPLE_FRAMES = 60;
  private refreshSamples = 0;
  private minFrameDt = Infinity; // shortest plausible frame seen while sampling
  private frameCapFps = 0; // 0 = uncapped; set once the refresh estimate lands
  private frameAccum = 0; // wall-time accrued across skipped rAF frames
  private fpsLowThreshold = 45; // shed quality below this (60Hz default)
  private fpsHighThreshold = 57; // recover quality above this

  // Quality governor: when renderScale is pinned at its floor and the frame
  // rate is still under budget, engage discrete rungs in order — R1 bloom off
  // (desktop only; the low tier never builds a composer), R2 shadow map at
  // half rate, R3 half the grass — and release them in REVERSE as headroom
  // returns. Per-direction cooldowns on top of the low/high hysteresis stop
  // it oscillating.
  private qualityRung = 0;
  private static readonly MAX_QUALITY_RUNG = 3;
  private static readonly RUNG_ENGAGE_COOLDOWN_S = 4;
  private static readonly RUNG_RELEASE_COOLDOWN_S = 12;
  private rungCooldown = 0; // seconds since the last rung change
  private bloomSuspendedByGovernor = false;
  private shadowFramePhase = 0;

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
    // Real theme runs a touch hotter: continuous PBR + the soft sky PMREM
    // read dimmer than the toon ramp at the same exposure.
    this.renderer.toneMappingExposure = isRealTheme() ? 1.14 : 1.08;
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

    // WebGL context-loss resilience. Under GPU memory pressure a mobile browser
    // can drop the context: the canvas goes black while the DOM HUD stays on
    // top, and a drop→restore cycle reads as a full-screen flash. We can't stop
    // a real driver/memory loss, but we (a) preventDefault so the browser will
    // actually fire `restored` (without it the context never comes back),
    // (b) skip rendering while lost so nothing throws, and (c) re-prime shaders
    // + shadows on restore so the first frame back is clean, not white garbage.
    // The real frequency fix is memory: the low tier skips the bloom composer
    // (its full-res HalfFloat targets are the biggest mobile GPU-memory cost).
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.contextLost = true;
      console.warn('⚠️ WebGL context lost — pausing render until restore');
    });
    canvas.addEventListener('webglcontextrestored', () => {
      this.contextLost = false;
      this.renderer.shadowMap.needsUpdate = true;
      if (this.scene && this.camera) {
        try {
          this.renderer.compile(this.scene, this.camera);
        } catch {
          /* best-effort re-prime */
        }
      }
      console.info('✓ WebGL context restored — re-primed');
    });
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

      const rawDt = this.clock.getDelta();

      // Refresh-rate sampling window (~1s, uncapped): frameCapFps stays 0
      // until the estimate lands, so the cap below is inert meanwhile.
      if (this.refreshSamples < SimpleRenderer.REFRESH_SAMPLE_FRAMES) {
        if (rawDt > 0.004 && rawDt < 0.05) {
          this.minFrameDt = Math.min(this.minFrameDt, rawDt);
        }
        if (++this.refreshSamples === SimpleRenderer.REFRESH_SAMPLE_FRAMES) {
          this.applyRefreshEstimate();
        }
      }

      // Frame limiter: skip whole rAF frames until a full cap interval has
      // accumulated. Skipped time is NOT lost — it stays in frameAccum, so
      // the deltaTime handed to the update callback stays true wall-time and
      // game speed is unchanged. The 1ms tolerance absorbs rAF timestamp
      // jitter so a healthy cadence doesn't spuriously drop to half rate.
      let wallDt = rawDt;
      if (this.frameCapFps > 0) {
        this.frameAccum += rawDt;
        const interval = 1 / this.frameCapFps;
        if (this.frameAccum < interval - 0.001) return;
        wallDt = this.frameAccum;
        this.frameAccum %= interval;
      }

      // Clamp dt: after a stall (alt-tab, GC pause) getDelta can be huge and
      // would teleport physics/animation on the catch-up frame.
      const deltaTime = Math.min(wallDt, 0.05);

      // Update game logic
      if (this.renderCallback) {
        this.renderCallback(deltaTime);
      }

      // Float the render resolution to hold the frame budget — BEFORE render().
      // A pixel-ratio change reallocates (blanks) the WebGL drawing buffer, so it
      // MUST be followed by an in-frame render() into the freshly-sized buffer.
      // Running it AFTER render() left the just-drawn frame discarded and the
      // browser composited the blank buffer for one frame — the white/black
      // flash. Adjust first, then draw.
      this.updateAdaptiveResolution(deltaTime);

      // Render
      this.render();
    };

    animate();
  }

  /**
   * One-off after the sampling window: snap the observed refresh to a
   * standard rate, engage the low-tier 60fps cap when the display actually
   * runs faster, and scale the adaptive controller's thresholds to the
   * achievable frame rate (the 45/57 defaults assume 60Hz). Snapping matters:
   * an un-snapped 64Hz estimate on a true 60Hz display would put the recover
   * threshold above vsync and the controller could never claw quality back.
   */
  private applyRefreshEstimate(): void {
    if (!Number.isFinite(this.minFrameDt) || this.minFrameDt <= 0) return; // all frames janky — keep defaults
    const observed = 1 / this.minFrameDt;
    let hz = 60;
    for (const r of [60, 75, 90, 120, 144, 165, 240]) {
      if (Math.abs(r - observed) < Math.abs(hz - observed)) hz = r;
    }
    // Cap only when it changes anything: on a true-60Hz phone the limiter
    // would just add skip judder for zero savings.
    if (SimpleRenderer.isLowTierDevice() && hz > 66) this.frameCapFps = 60;
    // Cap the ADAPTIVE target. `hz` comes from the fastest frame observed during
    // the sample window, so one quick boot frame (light scene, not yet built)
    // can snap it to 120/165 — a rate this WebGL scene can't hold. The controller
    // then sheds+claws resolution every time FPS wobbles under that ceiling, and
    // each change reallocates the drawing buffer (a flash pre-reorder; a sharpness
    // shimmer regardless). 90fps is smooth and actually reachable, so pin the
    // ceiling there — true 60Hz is unaffected (60 < 90), and a genuine 120/165Hz
    // display simply stops shedding to chase a rate it wasn't sustaining anyway.
    const ADAPTIVE_TARGET_CAP = 90;
    const capped = Math.min(hz, ADAPTIVE_TARGET_CAP);
    const target = this.frameCapFps > 0 ? Math.min(capped, this.frameCapFps) : capped;
    this.fpsLowThreshold = target * 0.75; // = 45 at 60Hz, same ratio as before
    this.fpsHighThreshold = target * 0.95; // = 57 at 60Hz
  }

  /**
   * Nudge the internal render scale toward whatever the GPU can sustain.
   * Runs at most ~once/second with hysteresis so it settles instead of
   * oscillating. Costs nothing when already at the ceiling and healthy.
   * When renderScale alone can't hold the budget the quality-rung ladder
   * takes over (engage order R1→R3, release order R3→R1, then resolution
   * recovers last).
   */
  private updateAdaptiveResolution(deltaTime: number): void {
    if (deltaTime <= 0) return;
    // Exponential moving average of instantaneous FPS
    const instFps = 1 / deltaTime;
    this.fpsEma += (instFps - this.fpsEma) * 0.1;

    this.rungCooldown += deltaTime;
    this.qualityAccum += deltaTime;
    if (this.qualityAccum < 1) return;
    this.qualityAccum = 0;

    const scaleFloor = this.dprFloor / this.dprCap;
    const prev = this.renderScale;
    if (this.fpsEma < this.fpsLowThreshold) {
      if (this.renderScale > scaleFloor) {
        // Struggling: shed ~15% of the pixels
        this.renderScale = Math.max(scaleFloor, this.renderScale - 0.15);
      } else if (
        this.qualityRung < SimpleRenderer.MAX_QUALITY_RUNG &&
        this.rungCooldown >= SimpleRenderer.RUNG_ENGAGE_COOLDOWN_S
      ) {
        // Resolution is at the floor and it's still not enough: next rung
        this.setQualityRung(this.qualityRung + 1);
      }
    } else if (this.fpsEma > this.fpsHighThreshold) {
      if (this.qualityRung > 0) {
        // Headroom is back: release rungs first (reverse order)... but keep the
        // GRASS rung (rung 3, the deepest + most visible) STICKY — release it
        // only with clear EXTRA headroom, so grass doesn't pop 44k<->22k on a
        // borderline device that holds FPS at half-grass but not full ("grass
        // going less and more randomly").
        const releaseBar =
          this.qualityRung === SimpleRenderer.MAX_QUALITY_RUNG
            ? this.fpsHighThreshold + 8
            : this.fpsHighThreshold;
        if (this.fpsEma > releaseBar && this.rungCooldown >= SimpleRenderer.RUNG_RELEASE_COOLDOWN_S) {
          this.setQualityRung(this.qualityRung - 1);
        }
      } else if (this.renderScale < 1) {
        // ...then claw resolution back gently
        this.renderScale = Math.min(1, this.renderScale + 0.1);
      }
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

  /** Step the governor to `next`, applying/releasing each rung in order. */
  private setQualityRung(next: number): void {
    const target = Math.max(0, Math.min(SimpleRenderer.MAX_QUALITY_RUNG, next));
    while (this.qualityRung < target) this.engageRung(++this.qualityRung);
    while (this.qualityRung > target) this.releaseRung(this.qualityRung--);
    this.rungCooldown = 0;
  }

  private engageRung(rung: number): void {
    switch (rung) {
      case 1:
        // Bloom off. Remember whether it was actually on so release doesn't
        // force bloom onto someone who toggled it off themselves (Ctrl+B).
        // On the low tier (no composer) both calls are inert no-ops.
        this.bloomSuspendedByGovernor = this.postProcessingEnabled;
        this.setPostProcessingEnabled(false);
        break;
      case 2:
        // Shadow half-rate: render() re-arms needsUpdate every 2nd frame.
        this.renderer.shadowMap.autoUpdate = false;
        this.renderer.shadowMap.needsUpdate = true;
        break;
      case 3:
        // Grass density 0.5 — Island's golden-spiral scatter keeps any prefix
        // uniform. Optional-chained end to end so it degrades to a no-op if
        // the GameScene accessor / Island method aren't present.
        (this.scene as { getIsland?: () => { setGrassBudget?: (f: number) => void } } | undefined)
          ?.getIsland?.()?.setGrassBudget?.(0.5);
        break;
    }
  }

  private releaseRung(rung: number): void {
    switch (rung) {
      case 3:
        (this.scene as { getIsland?: () => { setGrassBudget?: (f: number) => void } } | undefined)
          ?.getIsland?.()?.setGrassBudget?.(1);
        break;
      case 2:
        this.renderer.shadowMap.autoUpdate = true;
        break;
      case 1:
        if (this.bloomSuspendedByGovernor) this.setPostProcessingEnabled(true);
        this.bloomSuspendedByGovernor = false;
        break;
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

  /** One-shot photo-mode capture resolver; see captureFrame(). */
  private pendingCapture: ((blob: Blob | null) => void) | null = null;

  /**
   * Resolve with a JPEG of the NEXT rendered frame. The canvas has no
   * preserveDrawingBuffer (deliberate — permanent memory/perf cost), so the
   * capture must happen in the same task as the draw, before the browser
   * composites and the buffer is cleared. render() honours this flag right
   * after its draw call.
   */
  public captureFrame(): Promise<Blob | null> {
    return new Promise((resolve) => {
      this.pendingCapture?.(null); // a second request supersedes an unserved one
      this.pendingCapture = resolve;
    });
  }

  /**
   * Render a single frame
   */
  private render(): void {
    if (this.contextLost) return; // GL context gone — resume on webglcontextrestored

    if (!this.scene || !this.camera) {
      console.warn('⚠️ Render called but scene or camera missing:', {
        scene: !!this.scene,
        camera: !!this.camera,
      });
      return;
    }

    // Governor rung 2+: refresh the shadow map every OTHER frame. The sun
    // moves slowly enough that a one-frame-stale map is invisible.
    if (this.qualityRung >= 2) {
      this.shadowFramePhase ^= 1;
      if (this.shadowFramePhase === 1) this.renderer.shadowMap.needsUpdate = true;
    }

    if (this.postProcessingEnabled && this.composer) {
      this.composer.render();
    } else {
      this.renderer.render(this.scene, this.camera);
    }

    // Photo mode: read the drawing buffer in the SAME task as the draw
    // (toBlob snapshots the bitmap at call time; without preserveDrawingBuffer
    // the buffer is invalid after compositing).
    if (this.pendingCapture) {
      const deliver = this.pendingCapture;
      this.pendingCapture = null;
      this.renderer.domElement.toBlob((b) => deliver(b), 'image/jpeg', 0.95);
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

    // The setPixelRatio/setSize calls above reallocate (blank) the canvas AND the
    // composer's HalfFloat targets. This runs OUTSIDE the rAF loop (debounced
    // resize), so without an immediate redraw a compositor tick before the next
    // rAF would present the cleared (black) canvas / uninitialized (white)
    // composer target — a resize flash the address-bar guard only partly dodges.
    // Draw one frame straight into the fresh buffers.
    this.render();
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
