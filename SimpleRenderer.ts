import * as THREE from 'three';
// Bloom/post-processing addons are type-only at module scope (erased from the
// bundle) and loaded lazily as a parallel chunk in initPostProcessing() — see
// there. Keeps the ~40KB of postprocessing code out of the critical bundle that
// blocks first paint; it's still fetched and warmed well before the reveal.
import type { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import type { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import type { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';

import { GradeShader, isSoftLook } from './SoftLook';
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
  private gradePass?: ShaderPass; // ?look=soft time-of-day grade
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
  private lowStreak = 0; // consecutive 1Hz decisions under the low bar
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
  /** rAF timestamp jitter the limiter absorbs, so a healthy cadence doesn't
   *  spuriously drop to half rate. Shared with deliveredFps below — the two
   *  MUST agree or the controller expects a rate the limiter cannot produce. */
  private static readonly FRAME_CAP_TOLERANCE_S = 0.001;

  /**
   * The frame rate the limiter can actually DELIVER at this refresh + cap.
   *
   * The limiter renders only once a whole capped interval has accumulated, so
   * the delivered rate is quantised to `hz / skipsPerRender` — it is NOT the
   * cap. At a 60fps cap that is 60->60, 75->37.5, 90->45, 120->60, 144->48,
   * 165->55, 240->60. Four of the seven standard refresh rates do not land on
   * 60, and the thresholds used to be derived from the CAP, which is how a
   * perfectly healthy 90Hz phone ended up sitting exactly on its own shed bar.
   *
   * This models the loop in startRenderLoop; test/feelRegressions.test.ts
   * simulates that loop and asserts the two agree at every snapped rate, so
   * they cannot drift apart.
   */
  private static deliveredFps(hz: number, capFps: number): number {
    if (capFps <= 0) return hz;
    const skips = Math.max(1, Math.ceil((1 / capFps - SimpleRenderer.FRAME_CAP_TOLERANCE_S) * hz));
    return hz / skips;
  }
  private refreshSamples = 0;
  /**
   * Plausible frame intervals collected during the sampling window; the
   * refresh estimate is their MEDIAN.
   *
   * It used to be the MINIMUM ("the shortest clean frame IS the refresh"),
   * which is a one-way ratchet: rAF timestamp jitter runs +-1-2ms in real
   * browsers, and a delta shortened by jitter can only bias the estimate HIGH
   * — mis-binning one snap step up takes just 1.6ms at 90Hz (11.11 -> 9.52ms
   * reads as 120Hz) and 0.76ms at 120Hz. Over 60 samples the min GUARANTEES
   * the worst outlier wins. A high mis-bin is not cosmetic: deliveredFps(120,
   * 60) predicts 60 while the true-90Hz loop delivers 45, which silently
   * reinstates the sits-on-its-own-shed-bar bug the threshold derivation fix
   * removed. The median ignores outliers on BOTH sides for free.
   */
  private refreshDts: number[] = [];
  private frameCapFps = 0; // 0 = uncapped; set once the refresh estimate lands
  private frameAccum = 0; // wall-time accrued across skipped rAF frames
  private fpsLowThreshold = 45; // shed quality below this (60Hz default)
  private fpsHighThreshold = 57; // recover quality above this

  // Quality governor: when renderScale is pinned at its floor and the frame
  // rate is still under budget, engage discrete rungs in order — R1 bloom PASS
  // off (desktop only; the low tier never builds a composer), R2 shadow map at
  // half rate, R3 half the grass — and release them in REVERSE as headroom
  // returns. Per-direction cooldowns on top of the low/high hysteresis stop
  // it oscillating; rung 3 additionally waits 3x as long to release.
  // NONE of these rungs may switch RENDERING PATH: composer vs direct-to-canvas
  // tone-map in different places and differ by 21% mean luminance, so a governor
  // that toggled the composer was strobing the whole image (see engageRung).
  private qualityRung = 0;
  private static readonly MAX_QUALITY_RUNG = 3;
  private static readonly RUNG_ENGAGE_COOLDOWN_S = 4;
  private static readonly RUNG_RELEASE_COOLDOWN_S = 12;
  private rungCooldown = 0; // seconds since the last rung change
  /**
   * Longest single frame the governor will treat as a frame RATE (2fps).
   *
   * Bounds two different things at once: the clocks bank at most this per
   * frame (so a 60s alt-tab cannot instantly satisfy a 12s cooldown), and any
   * frame longer than this is a stall rather than a rate, so it is kept out of
   * the FPS average entirely. Deliberately far above the physics clamp of
   * 0.05 — 0.05 IS a frame rate (20fps), and treating it as the floor was the
   * bug this replaces. Below 2fps nothing is playable anyway.
   */
  private static readonly GOVERNOR_MAX_DT = 0.5;
  /** Consecutive frames longer than GOVERNOR_MAX_DT. 1-2 is an event and is
   *  ignored; 3+ is this machine's actual frame rate. */
  private stallRun = 0;
  /** The governor makes NO decisions until armed — see armGovernor. */
  private governorArmed = false;
  private governorArmAccum = 0; // visible wall time toward the self-arm fallback
  private static readonly GOVERNOR_ARM_FALLBACK_S = 10;
  private bloomSuspendedByGovernor = false;
  private shadowFramePhase = 0;
  /** Interior mode holds this true: the outdoor world is provably frozen while
   *  indoors, so every depth pass there is pure waste. See setShadowFreeze. */
  private shadowFrozen = false;

  constructor(canvas: HTMLCanvasElement) {
    // Create WebGL renderer with anti-aliasing
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true, // native MSAA for the low tier (no composer) and any direct-path frame; the composer carries its own samples:4 target
      alpha: false,
      powerPreference: 'high-performance',
      precision: 'highp',
    });

    // Device-tier ceiling, then clamped by the pixel budget for this viewport.
    this.dprCap = this.budgetedDpr(window.innerWidth, window.innerHeight);
    this.renderer.setPixelRatio(this.dprCap);
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    // Tone mapping is theme-scoped: ACES suits the continuous PBR default,
    // but it desaturates/skews the flat authored colors a cel look depends on
    // (the documented "ACES fights cel" problem) — the toon theme runs the
    // color-preserving Neutral curve instead. Renderer-level on purpose:
    // per-material toneMapped=false is ignored under the composer but honored
    // on the mobile direct path, which would fork the look between devices.
    this.renderer.toneMapping = isRealTheme()
      ? THREE.ACESFilmicToneMapping
      : THREE.NeutralToneMapping;
    // Real theme runs a touch hotter: continuous PBR + the soft sky PMREM
    // read dimmer than the toon ramp at the same exposure.
    this.renderer.toneMappingExposure = isRealTheme() ? 1.14 : 1.0;
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
    const [{ EffectComposer }, { RenderPass }, { UnrealBloomPass }, { OutputPass }, shaderPassMod] =
      await Promise.all([
        import('three/addons/postprocessing/EffectComposer.js'),
        import('three/addons/postprocessing/RenderPass.js'),
        import('three/addons/postprocessing/UnrealBloomPass.js'),
        import('three/addons/postprocessing/OutputPass.js'),
        import('three/addons/postprocessing/ShaderPass.js'),
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

    // ?look=soft experiment: taste-tuned bloom + a time-of-day grade AFTER
    // OutputPass (display-referred sRGB — the space grades are authored in).
    if (isSoftLook()) {
      // Soft knee on the bloom high-pass kills sea-specular sparkle pop;
      // strength is re-modulated per frame by setGradeDayFactor below.
      const highPass = (
        bloomPass as unknown as {
          highPassUniforms?: Record<string, { value: number }>;
        }
      ).highPassUniforms;
      if (highPass?.smoothWidth) highPass.smoothWidth.value = 0.15;
      const gradePass = new shaderPassMod.ShaderPass(GradeShader);
      this.gradePass = gradePass;
      this.composer.addPass(gradePass);
      console.log('🎞️ SoftLook: day-graded composer chain active');
    }
  }

  /** Per-frame hook for the ?look=soft grade: 0 = night, 1 = full day.
   *  Also breathes the bloom with the cycle (subtle by day, warm at night). */
  public setGradeDayFactor(day: number): void {
    if (this.gradePass) {
      this.gradePass.uniforms.uDay.value = day;
      if (this.bloomPass) this.bloomPass.strength = 0.15 + (1 - day) * 0.35;
    }
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
        // Forget any stall run in progress. Without this a tab hidden mid-dip
        // resumes with stallRun already >= 3, so the first slow resume frame
        // (texture re-upload) counts as a RATE rather than the isolated stall
        // it is, and drags the EMA down before a single healthy frame lands.
        this.stallRun = 0;
        return;
      }

      const rawDt = this.clock.getDelta();

      // Refresh-rate sampling window (~1s, uncapped): frameCapFps stays 0
      // until the estimate lands, so the cap below is inert meanwhile.
      if (this.refreshSamples < SimpleRenderer.REFRESH_SAMPLE_FRAMES) {
        if (rawDt > 0.004 && rawDt < 0.05) {
          this.refreshDts.push(rawDt);
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
        if (this.frameAccum < interval - SimpleRenderer.FRAME_CAP_TOLERANCE_S) return;
        wallDt = this.frameAccum;
        // ZERO, not `%= interval`: wallDt above consumed the WHOLE
        // accumulator, so keeping the remainder re-injected it into the next
        // frame and simulated time ran ahead of the wall clock. The 1ms
        // tolerance lets a frame render while frameAccum is a hair BELOW
        // interval, and `%=` then returns the entire accumulator — so on a
        // 120Hz phone the deltas came out 16.6/24.9/16.5/24.8ms, ~2.5x real
        // time. That inflated BOTH player movement and cloud drift (and the
        // 16/25 cadence is itself the judder that reads as "blurry").
        // The comment above always described this behaviour; the code did not.
        this.frameAccum = 0;
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
      //
      // WALL time, not the physics-clamped deltaTime. The 0.05 clamp above is
      // right for physics and WRONG for a controller that measures frame rate:
      // it floored the governor's view at 20fps and stretched every one of its
      // clocks. See updateAdaptiveResolution.
      this.updateAdaptiveResolution(wallDt);

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
    if (this.refreshDts.length === 0) return; // all frames janky — keep defaults
    // MEDIAN, not min — see refreshDts. Sorting a <=60-element array once at
    // boot costs nothing.
    const sorted = [...this.refreshDts].sort((a, b) => a - b);
    const observed = 1 / sorted[sorted.length >> 1];
    this.refreshDts.length = 0; // one-shot; free the samples
    let hz = 60;
    for (const r of [60, 75, 90, 120, 144, 165, 240]) {
      if (Math.abs(r - observed) < Math.abs(hz - observed)) hz = r;
    }
    // Cap only when it changes anything: on a true-60Hz phone the limiter
    // would just add skip judder for zero savings.
    //
    // THE CAP QUANTISES — AND THAT IS A FEATURE, NOT THE BUG IT LOOKS LIKE.
    // The limiter delivers hz/ceil(hz/60): 37.5 at 75Hz, 45 at 90Hz, 48 at
    // 144Hz, 55 at 165Hz (see deliveredFps). That reads as "the 60fps cap
    // undershoots by 25% on a 90Hz phone", and it was reported as exactly that
    // once already. It is deliberate: an integer divisor of the refresh is the
    // ONLY rate a vsynced display can show with PERFECTLY EVEN pacing. Pacing
    // to a 60fps deadline instead delivers 22.2/11.1ms alternation at 90Hz
    // (1:2 pulldown) and a double-length frame 15x/second at 75Hz — the same
    // artifact class as the shipped frameAccum bug whose 16/25ms cadence
    // players reported as "feels doubled"/"blurry" (see the limiter's note).
    // Even-but-slower beats faster-but-juddering on a game that is constant
    // full-screen panning; a 3-judge design review (perception/thermal/
    // engineering, 2026-08-17) upheld it 3-0 against deadline pacing, and 2-1
    // against raising 144Hz to hz/2=72 (even, but +50% GPU on the thermally
    // weakest tier for a ceiling the codebase itself sets at 60). The governor
    // is honest about these rates via deliveredFps; do not "fix" this again
    // without re-running that argument.
    if (SimpleRenderer.isLowTierDevice() && hz > 66) this.frameCapFps = 60;
    // Cap the ADAPTIVE target. `hz` comes from the fastest frame observed during
    // the sample window, so one quick boot frame (light scene, not yet built)
    // can snap it to 120/165 — a rate this WebGL scene can't hold. The controller
    // then sheds+claws resolution every time FPS wobbles under that ceiling, and
    // each change reallocates the drawing buffer (a flash pre-reorder; a sharpness
    // shimmer regardless). 90fps is smooth and actually reachable, so pin the
    // ceiling there — true 60Hz is unaffected (60 < 90), and a genuine 120/165Hz
    // display simply stops shedding to chase a rate it wasn't sustaining anyway.
    // 60, not 90. At 90 the shed bar is 67.5fps and the recovery bar 85.5 —
    // a scene with 2.1M verts, a per-frame 2048² shadow pass and a 13-pass
    // bloom chain never satisfies that, so every 90/120/144Hz display parked
    // at the resolution FLOOR permanently and rendered soft forever. A true
    // 60Hz panel is unaffected (min(60,60) === min(60,90)); this only stops
    // the faster displays chasing a rate they were never sustaining.
    const ADAPTIVE_TARGET_CAP = 60;
    const capped = Math.min(hz, ADAPTIVE_TARGET_CAP);
    // DERIVE FROM WHAT THE LIMITER DELIVERS, NOT FROM THE CAP.
    //
    // This used to be `Math.min(capped, this.frameCapFps)`, i.e. the cap — and
    // since the snap list's smallest entry is 60, `capped` is ALWAYS 60 and the
    // whole calculation was dead code that could only ever reproduce the 45/57
    // field initializers. Meanwhile the limiter quantises the real rate to
    // hz/skipsPerRender, which is 60 on only three of the seven standard
    // refresh rates. MEASURED by simulating the limiter loop:
    //   60Hz -> 60.00 ok          144Hz -> 48.00  never releases (48 < 57)
    //   75Hz -> 37.50 SHEDS FOREVER (37.5 < 45)   165Hz -> 55.00  never releases
    //   90Hz -> 45.00 sits EXACTLY on its own shed bar   120/240Hz -> 60.00 ok
    // So a perfectly healthy 90Hz budget Android — the commonest low-tier panel
    // there is — read as struggling, sheds resolution, and could never reach a
    // release bar of 57 it was structurally incapable of producing. Combined
    // with reverse-order releases and a claw-back gated on `qualityRung === 0`,
    // that is a one-way ratchet to floor quality on healthy hardware.
    // Now: 90Hz gets 33.75/42.75 and its native 45 reads healthy, as it is.
    const delivered = SimpleRenderer.deliveredFps(hz, this.frameCapFps);
    const target = Math.min(capped, delivered);
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
  private updateAdaptiveResolution(wallDt: number): void {
    if (wallDt <= 0) return;
    // TRUE WALL TIME, BOUNDED — not the physics dt.
    //
    // This used to be handed `Math.min(wallDt, 0.05)`, the clamp that stops a
    // stall teleporting the player. Correct there, corrosive here, because
    // every number this controller owns is derived from its dt:
    //   * instFps = 1/dt was FLOORED AT 20, so the governor could not tell
    //     20fps from 5fps — it read the machines it exists for as identical.
    //   * qualityAccum made the "~1Hz" decision cadence 1/(0.05 x realFps):
    //     at a true 10fps that is 20 rendered frames, i.e. 2.0s of WALL time.
    //   * rungCooldown made ENGAGE 4s -> 8s and RELEASE 12s -> 24s of wall.
    // So its reaction time degraded in exact proportion to how badly the
    // device was drowning. On any machine holding above 20fps the clamp never
    // bound and this changes nothing at all.
    const dt = Math.min(wallDt, SimpleRenderer.GOVERNOR_MAX_DT);

    // A STALL IS NOT A FRAME RATE — BUT A RUN OF THEM IS.
    //
    // alt-tab, a GC pause or a shader-compile storm can hand back a
    // multi-second frame, and feeding that to the EMA reads as ~2fps and would
    // shed quality the instant someone returns to the tab. So an ISOLATED
    // over-long frame is excluded. But "exclude every frame over 0.5s" alone
    // was a regression on the worst machines there are: a device sustaining
    // 1.5fps has EVERY frame over the threshold, so fpsEma would sit at its
    // initial 60 forever and the governor would never shed a thing — while the
    // OLD clamped-dt code at least read it as 20fps and did act. Worse, if the
    // EMA happened to be frozen above the high bar the claw-back would keep
    // ADDING resolution to a machine at 1.5fps.
    //
    // Three in a row is no longer an event; it is how fast this thing runs.
    // dt is already bounded, so instFps then floors at 2fps rather than being
    // discarded.
    const overLong = wallDt > SimpleRenderer.GOVERNOR_MAX_DT;
    this.stallRun = overLong ? this.stallRun + 1 : 0;
    const isolatedStall = overLong && this.stallRun < 3;
    if (!isolatedStall) {
      const instFps = 1 / dt;
      // Time-based, like every other smoother in this codebase. A per-FRAME
      // 0.1 is a ~10-frame window, i.e. 0.17s at 60fps but 0.08s at 120 — the
      // same hitch was judged differently on different hardware, and a single
      // GC pause could drag the EMA under the bar before the next 1Hz decision.
      //
      // ...and CAPPED, which matters much more now that dt is honest. A single
      // 300ms hitch would otherwise take 33% of the average with it. SIMULATED
      // over 3 minutes of "fast machine, 300ms hitch every 5s": the EMA settles
      // at 41.3 uncapped against a 45 shed bar, with lowStreak reaching 1 on
      // every decision — no shed, but only because of the >= 2 guard. Capped it
      // settles at 45.8 with lowStreak 0. The cap binds only for frames slower
      // than 4.6fps, so it limits how far ONE hitch can move the average
      // without limiting where the average goes when EVERY frame is slow:
      // simulated true 5/10/20/30fps converge identically capped or not, and
      // true 3fps still converges (3.01, settling 6.3s instead of 4.0s).
      const emaAlpha = Math.min(0.25, 1 - Math.exp(-dt / 0.75));
      this.fpsEma += (instFps - this.fpsEma) * emaAlpha;
    }

    this.rungCooldown += dt; // genuinely elapsed, and bounded

    // NOT ARMED: measure, but decide NOTHING. The render loop starts
    // immediately before the 2.5s whole-planet fly-in — the single heaviest,
    // least representative view in the game, already quality-managed by its
    // own intro-lite mode — and with the clocks on true wall time the ladder
    // could walk rungs off those atypical seconds (time-to-rung-1 is a
    // constant ~9s now, where the old clamped clock made it 180 RENDERED
    // frames, i.e. 45s of slack at 4fps). main-simple arms on the fly-in
    // resolve (both intro branches); armGovernor then DISCARDS everything
    // measured here. The wall-clock fallback exists so a caller that never
    // arms — an error path, a minimal harness — degrades to a 10s-delayed
    // governor rather than a permanently absent one.
    if (!this.governorArmed) {
      this.governorArmAccum += dt;
      if (this.governorArmAccum >= SimpleRenderer.GOVERNOR_ARM_FALLBACK_S) this.armGovernor();
      return;
    }

    // NO DECISION ON A SAMPLE WE JUST REFUSED TO TRUST. The excluded frame's
    // time must not buy a decision either: banking it on qualityAccum let the
    // FIRST VISIBLE FRAME after a 60s alt-tab tip the accumulator over 1 and
    // shed resolution on a 60-second-old EMA — reallocating (blanking) the
    // drawing buffer at the exact moment of refocus, which is the artifact the
    // "adjust first, then draw" ordering above exists to prevent.
    if (isolatedStall) return;
    this.qualityAccum += dt;
    if (this.qualityAccum < 1) return;
    // Keep the remainder rather than zeroing it. dt can now be up to 0.5, so
    // discarding the overshoot stretched the "1Hz" decision to as much as 1.5s
    // on the slowest machines — the very ones this change is meant to speed up.
    // Bounded by 1 + GOVERNOR_MAX_DT on entry, so this can never leave enough
    // to fire a second decision immediately.
    this.qualityAccum -= 1;

    // Capped at 0.9 so the lever can never become a NO-OP: dprFloor doubles
    // as a floor on dprCap (budgetedDpr), so on a 4K panel both land on 0.6,
    // scaleFloor computes to exactly 1.0, and then `renderScale > scaleFloor`
    // and `renderScale < 1` are BOTH false — the governor is frozen while the
    // machine sits permanently at 0.6 effective DPR.
    const scaleFloor = Math.min(0.9, this.dprFloor / this.dprCap);
    const prev = this.renderScale;
    if (this.fpsEma < this.fpsLowThreshold) {
      this.lowStreak += 1;
      if (this.renderScale > scaleFloor && this.lowStreak >= 2) {
        // Struggling, and for a SECOND consecutive decision — one bad second
        // (a shader compile, walking into a dense district) is not a reason
        // to drop resolution. Shed 0.08/decision against a 0.1 restore, so
        // the ratio now favours RECOVERY; at 0.15-down/0.1-up the scale sat
        // near the floor whenever load oscillated around the threshold,
        // which is exactly "sharp when I stand still, soft when I walk".
        this.renderScale = Math.max(scaleFloor, this.renderScale - 0.08);
      } else if (
        this.renderScale <= scaleFloor &&
        this.qualityRung < SimpleRenderer.MAX_QUALITY_RUNG &&
        this.rungCooldown >= SimpleRenderer.RUNG_ENGAGE_COOLDOWN_S
      ) {
        // Resolution is at the floor and it's still not enough: next rung
        this.setQualityRung(this.qualityRung + 1);
      }
    } else {
      // RESET ON ANY DECISION THAT IS NOT LOW, not only on one above the HIGH
      // bar. lowStreak is documented as "consecutive decisions under the low
      // bar", but with the reset living inside the high branch it actually
      // meant "since the last decision above 57" — so a machine parked in the
      // 45-57 hysteresis dead band (exactly where the hysteresis is designed to
      // park a borderline device) kept a stale lowStreak of 1 indefinitely, and
      // the NEXT isolated hitch, minutes later, sheds immediately.
      // Latent before, reachable now: an honest dt means one 150ms hitch moves
      // a 50fps EMA to 42.1 and trips the bar, where the old clamped dt could
      // only reach 48.07 and never tripped it. Sustained-load descent is
      // unaffected — every decision there is below the bar, so this never runs.
      this.lowStreak = 0;
      if (this.fpsEma > this.fpsHighThreshold && this.qualityRung > 0) {
        // Headroom is back: release rungs first (reverse order)... but keep the
        // GRASS rung (rung 3, the deepest + most visible) STICKY, so grass
        // doesn't pop 44k<->22k on a borderline device that holds FPS at
        // half-grass but not full ("grass going less and more randomly").
        //
        // STICKY IN TIME, NOT IN RATE. This used to demand `fpsHighThreshold + 8`.
        // applyRefreshEstimate caps the adaptive target at 60 on EVERY display, so
        // fpsHighThreshold is 57 and that bar was 65 — ABOVE VSYNC on the commonest
        // panel there is, and unreachable no matter how healthy the machine got.
        // Because releases are strictly reverse-order and the resolution claw-back
        // below is gated on `qualityRung === 0`, one bad dip that walked the ladder
        // to rung 3 pinned the WHOLE session at floor resolution + no bloom +
        // half-rate shadows + half grass, permanently. There is only 3fps of room
        // between the release bar and the cap, so no rate margin can work here;
        // asking for the SAME rate sustained 3x longer expresses "don't pop grass
        // on a borderline device" without asking for a frame rate that cannot exist.
        const releaseCooldown =
          this.qualityRung === SimpleRenderer.MAX_QUALITY_RUNG
            ? SimpleRenderer.RUNG_RELEASE_COOLDOWN_S * 3
            : SimpleRenderer.RUNG_RELEASE_COOLDOWN_S;
        if (this.fpsEma > this.fpsHighThreshold && this.rungCooldown >= releaseCooldown) {
          this.setQualityRung(this.qualityRung - 1);
        }
      } else if (this.fpsEma > this.fpsHighThreshold && this.renderScale < 1) {
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
        this.bloomPass?.setSize(
          Math.ceil(window.innerWidth / 2),
          Math.ceil(window.innerHeight / 2),
        );
      }
    }
  }

  /**
   * SOLE writer of shadowMap.autoUpdate after construction.
   *
   * Two systems used to write the raw field: the governor's rung 2
   * (autoUpdate=false at engage, =true at release) and GameScene's interior
   * mode (save on enter, blind restore on exit). Save/restore does not compose
   * with a second writer — the interleavings both broke:
   *   enter at rung 2 -> saved `false`; the cheap frozen interior lifts fpsEma,
   *   the governor RELEASES rung 2 (autoUpdate=true, silently defeating the
   *   interior freeze); exit restores the stale `false` — and with rung < 2
   *   render()'s half-rate re-arm never fires, so the OUTDOOR shadow map stays
   *   frozen for the rest of the session while the sun keeps moving.
   *   enter at rung 0 -> saved `true`; governor ENGAGES rung 2 indoors; exit
   *   restores `true` — the governor believes rung 2 is engaged while shadows
   *   run at full rate, and the saving is silently gone.
   * Deriving the field from BOTH inputs makes every interleaving converge.
   */
  private applyShadowPolicy(): void {
    this.renderer.shadowMap.autoUpdate = !this.shadowFrozen && this.qualityRung < 2;
  }

  /**
   * Interior mode: park the depth pass while the outdoor world is provably
   * frozen (GameScene.update early-returns into updateInteriorMode, so nothing
   * that casts a shadow can move). Replaces GameScene's save/restore of the
   * raw field — see applyShadowPolicy for why that broke.
   */
  public setShadowFreeze(frozen: boolean): void {
    if (this.shadowFrozen === frozen) return;
    this.shadowFrozen = frozen;
    this.applyShadowPolicy();
    // Unfreezing: refresh once immediately, whatever the rung — the sun kept
    // moving while indoors, and at rung >= 2 the next half-rate re-arm is
    // otherwise up to 2 frames away with a map that is minutes stale.
    if (!frozen) this.renderer.shadowMap.needsUpdate = true;
  }

  /**
   * Start governing. Called by main-simple when the intro fly-in resolves
   * (both branches funnel through afterIntro), or by the 10s wall-clock
   * fallback in updateAdaptiveResolution if that call never arrives.
   *
   * Resets the EMA and every decision clock: whatever was measured before
   * this moment was the intro — the heaviest, least representative seconds
   * the game has — and a stale-low EMA carried across the arm would shed on
   * the very first decision, which is the exact behaviour arming exists to
   * prevent. Idempotent; the reset must not fire twice.
   */
  public armGovernor(): void {
    if (this.governorArmed) return;
    this.governorArmed = true;
    this.fpsEma = 60;
    this.qualityAccum = 0;
    this.rungCooldown = 0;
    this.lowStreak = 0;
    this.stallRun = 0;
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
        // Bloom off — the BLOOM PASS, not the whole composer.
        //
        // This used to call setPostProcessingEnabled(false), which does not turn
        // bloom off so much as switch RENDERING PATHS: composer.render() draws to
        // a linear-HDR target and tone-maps ONCE in OutputPass, while the direct
        // path tone-maps per material inside every fragment shader. The two
        // genuinely render different images. MEASURED here, 12 readings, whole
        // frame: composer 127.8 mean luminance vs direct 100.5 — the governor's
        // FIRST and supposedly gentlest lever was a 21% full-screen brightness
        // DROP, engaged ahead of shadows and grass, on machines already struggling.
        //
        // Disabling the pass instead leaves RenderPass -> OutputPass intact, so
        // tone mapping still happens once in the same place. MEASURED: 127.70 ->
        // 127.57, a 0.11% change, which is just bloom's own additive light going
        // away. Nothing else about the image moves.
        //
        // HONEST COST: this is a WEAKER rung. Interleaved GPU timing, 150 rounds:
        // composer+bloom 10.48ms, bloom pass off 9.85ms, composer off 9.11ms — so
        // the pass is 0.63ms of the 1.37ms that composer-off used to save, i.e.
        // 46%. The other 54% is the HDR target, the MSAA resolve and the OutputPass
        // blit, which are fixed costs of being in a composer at all. Machines that
        // used to recover on R1 will now walk to R2/R3 — which is exactly why the
        // rung-3 release fix above is part of this change and not a follow-up.
        if (this.bloomPass) {
          // Snapshot the SAME field the release restores, or a governor engage
          // taken while bloom is already off would re-enable it on release.
          this.bloomSuspendedByGovernor = this.bloomPass.enabled;
          this.bloomPass.enabled = false;
        } else {
          this.bloomSuspendedByGovernor = false; // low tier: no composer was built
        }
        break;
      case 2:
        // Shadow half-rate: render() re-arms needsUpdate every 2nd frame.
        this.applyShadowPolicy();
        // One last full refresh before dropping to half rate — unless the
        // interior freeze holds, where a depth pass is exactly the waste the
        // freeze exists to stop.
        if (!this.shadowFrozen) this.renderer.shadowMap.needsUpdate = true;
        break;
      case 3:
        // Grass density 0.5 — Island's golden-spiral scatter keeps any prefix
        // uniform. Optional-chained end to end so it degrades to a no-op if
        // the GameScene accessor / Island method aren't present.
        (this.scene as { getIsland?: () => { setGrassBudget?: (f: number) => void } } | undefined)
          ?.getIsland?.()
          ?.setGrassBudget?.(0.5);
        break;
    }
  }

  private releaseRung(rung: number): void {
    switch (rung) {
      case 3:
        (this.scene as { getIsland?: () => { setGrassBudget?: (f: number) => void } } | undefined)
          ?.getIsland?.()
          ?.setGrassBudget?.(1);
        break;
      case 2:
        // Recompute, don't assign: while the interior freeze holds, a governor
        // release must NOT switch the depth pass back on. The old raw
        // `autoUpdate = true` here did exactly that — and then the interior's
        // exit path restored the stale `false` it had saved on entry, freezing
        // the OUTDOOR shadow map for the rest of the session while the sun
        // kept moving. See applyShadowPolicy.
        this.applyShadowPolicy();
        break;
      case 1:
        // Restores the pass, never the render path — see engageRung. Keyed to the
        // same field it snapshotted, so a user who turned bloom off themselves
        // does not get it forced back on.
        if (this.bloomSuspendedByGovernor && this.bloomPass) this.bloomPass.enabled = true;
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
    // moves slowly enough that a one-frame-stale map is invisible. Suspended
    // by the interior freeze — a half-rate depth pass indoors is still a
    // depth pass indoors.
    if (this.qualityRung >= 2 && !this.shadowFrozen) {
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

  /**
   * Turn the BLOOM PASS on/off without switching rendering path.
   *
   * This is what callers almost always mean by "skip bloom for a moment".
   * setPostProcessingEnabled swaps composer.render() for renderer.render(),
   * which moves tone mapping from OutputPass into every material and changes
   * mean luminance by 21% — a full-screen brightness change, not a bloom
   * change. Disabling the pass leaves RenderPass -> OutputPass intact and
   * measures 0.11%. Inert on the low tier, which never builds a composer.
   */
  public setBloomEnabled(enabled: boolean): void {
    if (this.bloomPass) this.bloomPass.enabled = enabled;
  }

  /** Ctrl+B. Toggles the BLOOM PASS and reports its true state — see
   *  setBloomEnabled. This used to flip postProcessingEnabled, i.e. the whole
   *  COMPOSER: the one remaining user-reachable render-path switch (the 21%
   *  luminance step), and a lying label besides — with the governor holding
   *  rung 1 (bloom pass off), switching the composer back on printed "Bloom
   *  enabled" while zero bloom rendered, and attributed the brightness jump
   *  to bloom. A user toggle deliberately overrides a governor rung-1 hold:
   *  explicit intent wins, and the suspend flag snapshots at engage time so
   *  a later release does not fight it. */
  public toggleBloom(): boolean {
    if (!this.bloomPass) return false; // low tier: nothing to toggle
    this.bloomPass.enabled = !this.bloomPass.enabled;
    return this.bloomPass.enabled;
  }

  /** Whether a composer was ever constructed (false on the low tier). */
  public isPostProcessingAvailable(): boolean {
    return !!this.composer;
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
      const aspect = width / height;
      // Aspect-aware framing lives in GameScene (it owns the OrbitCamera that
      // owns fov). Fall back to the plain aspect write if no scene is wired.
      const scene = this.scene as unknown as { applyFraming?: (a: number) => void };
      if (typeof scene?.applyFraming === 'function') {
        scene.applyFraming(aspect);
      } else {
        (this.camera as THREE.PerspectiveCamera).aspect = aspect;
        (this.camera as THREE.PerspectiveCamera).updateProjectionMatrix();
      }
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
