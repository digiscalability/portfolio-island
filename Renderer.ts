import * as THREE from 'three';

export class Renderer {
  public getCanvas(): HTMLCanvasElement {
    return this.renderer.domElement;
  }
  public renderer: THREE.WebGLRenderer;
  private composer: any = null;
  private ssaoPass: any = null;
  private fxaaPass: any = null;
  private bloomPass: any = null;
  private vignettePass: any = null;
  private postProcessingEnabled: boolean = true;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false,
    });
    this.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setClearColor(0x87ceeb, 1); // sky blue
  // Use physically correct lighting and sRGB output for nicer shading
  try { (this.renderer as any).physicallyCorrectLights = true; } catch (e) { /* ignore */ }
  // Set output color space for Three.js r152+
  try {
    if ('outputColorSpace' in this.renderer) {
      (this.renderer as any).outputColorSpace = THREE.SRGBColorSpace;
    } else {
      (this.renderer as any).outputEncoding = 3001; // sRGBEncoding fallback
    }
  } catch (e) { /* ignore */ }
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    // Reduced exposure to fix glowing/bright terrain appearance
    this.renderer.toneMappingExposure = 0.75;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  // Handle window resize and DPR changes
    let resizeTimeout: number | null = null;
    const onWindowResize = () => {
      if (resizeTimeout) window.clearTimeout(resizeTimeout);
      resizeTimeout = window.setTimeout(() => {
        this.onResize();
        resizeTimeout = null;
      }, 120);
    };

    window.addEventListener('resize', onWindowResize);
    // Observe DPR changes via media query
    if ((window as any).matchMedia) {
      const mq = (window as any).matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
      try {
        mq.addEventListener && mq.addEventListener('change', onWindowResize);
      } catch (e) {
        // older browsers
        mq.addListener && mq.addListener(onWindowResize);
      }
    }
  }

  // Setup post-processing passes and a simple procedurally-generated equirectangular environment
  public async setupPostProcessing(scene: THREE.Scene, camera: THREE.Camera) {
    try {
      const mod = await import('three/addons/postprocessing/EffectComposer.js');
      const { EffectComposer } = mod as any;
      const rpMod = await import('three/addons/postprocessing/RenderPass.js');
      const { RenderPass } = rpMod as any;
  // Optional post-processing modules are intentionally not eagerly imported here because
  // they are feature-flagged and commented-out in this build to reduce bundle size and
  // avoid platform-specific shader issues. If you enable SSAO/FXAA later, import the
  // modules at that time.

      this.composer = new EffectComposer(this.renderer);
      const renderPass = new RenderPass(scene, camera);
      this.composer.addPass(renderPass);

      // SSAO for contact shadows/occlusion (disabled by default; can be enabled later)
      try {
        // If we later enable SSAO we can instantiate it from the `ss` module above.
      } catch (e) {
        console.warn('SSAO pass init failed', e);
      }

      // FXAA for antialiasing (disabled by default). We only enable it on platforms that
      // support standard derivatives to avoid shader compile warnings.
      try {
        try {
          const gl = this.renderer.getContext();
          const supportsDerivatives = !!(gl && (gl.getExtension ? (gl.getExtension('OES_standard_derivatives') || (window as any).WebGL2RenderingContext && gl instanceof (window as any).WebGL2RenderingContext) : false));
          if (!supportsDerivatives) {
            console.warn('FXAA skipped: OES_standard_derivatives not available on this device.');
          }
        } catch (innerErr) {
          console.warn('FXAA init check failed, skipping FXAA', innerErr);
        }
      } catch (e) {
        console.warn('FXAA init failed', e);
      }

          // Bloom pass (optional) - tuned to be less aggressive by default
          try {
      const bloomMod = await import('three/addons/postprocessing/UnrealBloomPass.js');
      const { UnrealBloomPass } = bloomMod as any;
            const bloomPass = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.3, 0.4, 1.0);
            // Increase threshold to prevent terrain from glowing - only brightest emissive should bloom
            bloomPass.threshold = 1.2;
            bloomPass.strength = 0.2;
            bloomPass.radius = 0.4;
            this.bloomPass = bloomPass;
            this.composer.addPass(bloomPass);
          } catch (e) {
            console.warn('Bloom pass init failed', e);
          }

  // Create a simple equirectangular environment from a canvas gradient and generate PMREM
      try {
        const canvas = document.createElement('canvas');
        canvas.width = 1024;
        canvas.height = 512;
        const ctx = canvas.getContext('2d')!;
  const g = ctx.createLinearGradient(0, 0, 0, canvas.height);
  // warmer sunrise-like gradient
  g.addColorStop(0, '#ffd8b3');
  g.addColorStop(0.6, '#ffd1a6');
  g.addColorStop(1, '#d9f0c6');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        const tex = new THREE.CanvasTexture(canvas);
        tex.mapping = (THREE as any).EquirectangularReflectionMapping;
        const pmrem = new THREE.PMREMGenerator(this.renderer);
        pmrem.compileEquirectangularShader();
        const env = pmrem.fromEquirectangular(tex as any).texture;
        scene.environment = env;
        tex.dispose();
        pmrem.dispose();
        // Try to load a higher-fidelity HDR from assets if present (non-blocking). Prefer local HDRs for realistic lighting.
        try {
          const hdrCandidates = [
            'assets/hdri_venice_sunset_1k.hdr',
            'assets/hdri_studio_small_1k.hdr',
            'assets/hdri_studio_small_01_1k.hdr'
          ];
          // attempt to load with an overall timeout to avoid hanging
          const timeoutMs = 1800;
          for (const p of hdrCandidates) {
            try {
              const loaded = await Promise.race([
                this.loadEnvironmentFromUrl(p),
                new Promise((res) => setTimeout(() => res(null), timeoutMs))
              ] as any);
              if (loaded) {
                // clamp and apply environment safely
                this.applyEnvironment(scene, loaded);
                break;
              }
            } catch (ee) { /* ignore single-file load errors */ }
          }
        } catch (e) { /* ignore HDR attempts */ }
      } catch (e) {
        console.warn('env map generation failed', e);
      }

      // ensure composer size matches renderer
      this.composer.setSize(window.innerWidth, window.innerHeight);
    } catch (e) {
      console.warn('Post-processing modules not available', e);
      this.composer = null;
    }
  }

  // Exposed controls for UI
  public setPostProcessingEnabled(enabled: boolean) {
    this.postProcessingEnabled = enabled;
  }

  public setSSAOParams(params: { kernelRadius?: number; minDistance?: number; maxDistance?: number }) {
    if (!this.ssaoPass) return;
    if (typeof params.kernelRadius === 'number') this.ssaoPass.kernelRadius = params.kernelRadius;
    if (typeof params.minDistance === 'number') this.ssaoPass.minDistance = params.minDistance;
    if (typeof params.maxDistance === 'number') this.ssaoPass.maxDistance = params.maxDistance;
  }

  public setFXAAResolution() {
    if (!this.fxaaPass) return;
    try {
      const pixelRatio = Math.max(1, window.devicePixelRatio || 1);
      (this.fxaaPass.uniforms as any)['resolution'].value.x = 1 / (window.innerWidth * pixelRatio);
      (this.fxaaPass.uniforms as any)['resolution'].value.y = 1 / (window.innerHeight * pixelRatio);
    } catch (e) { }
  }

  public setBloomParams(params: { strength?: number; radius?: number; threshold?: number }) {
    if (!this.bloomPass) return;
    if (typeof params.strength === 'number') this.bloomPass.strength = params.strength;
    if (typeof params.radius === 'number') this.bloomPass.radius = params.radius;
    if (typeof params.threshold === 'number') this.bloomPass.threshold = params.threshold;
  }

  public setVignette(strength: number) {
    // Simple vignette via CSS overlay or later ShaderPass; for now adjust via composer uniforms if shader exists
    if (!this.vignettePass) return;
    try { (this.vignettePass.uniforms as any)['strength'].value = strength; } catch (e) { }
  }

  public setExposure(exposure: number) {
    try { this.renderer.toneMappingExposure = exposure; } catch (e) { }
  }

  public async loadEnvironmentFromUrl(url: string) {
    try {
      // Use RGBELoader from three/addons (HDRLoader deprecated in newer three.js versions)
      let tex: any = null;
      try {
        const mod = await import('three/addons/loaders/RGBELoader.js');
        const { RGBELoader } = mod as any;
        const loader = new RGBELoader();
        tex = await new Promise((resolve, reject) => loader.load(url, resolve, undefined, reject));
      } catch (rgbeErr) {
        throw rgbeErr;
      }
      const pmrem = new THREE.PMREMGenerator(this.renderer);
      const env = pmrem.fromEquirectangular(tex as any).texture;
      try { (tex as any).dispose && (tex as any).dispose(); } catch (e) { }
      // clamp intensity by creating a lightweight wrapper that sets envMapIntensity on materials when applied
      pmrem.dispose();
      return env;
    } catch (e) {
      console.warn('loadEnvironmentFromUrl failed', e);
      return null;
    }
  }

  // Apply an environment texture to the scene with safe clamping of intensity and background.
  private applyEnvironment(scene: THREE.Scene, env: THREE.Texture) {
    try {
      // clamp environment intensity via scene.environment and tune renderer exposure
      scene.environment = env;
      try { scene.background = env; } catch (e) { /* some builds don't allow using pmrem as background */ }
      // walk materials and gently increase envMapIntensity only to a safe maximum
      let changed = 0;
      scene.traverse((obj: any) => {
        if (!obj || !obj.material) return;
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        mats.forEach((m: any) => {
          try {
            if (m && (m.isMeshStandardMaterial || m.isMeshPhysicalMaterial)) {
              // clamp existing intensity
              m.envMap = env;
              m.envMapIntensity = Math.min(0.8, typeof m.envMapIntensity === 'number' ? Math.max(m.envMapIntensity, 0.6) : 0.6);
              changed++;
            }
          } catch (e) { }
        });
      });
      // safe guard: reduce bloom/exposure if env appears very bright
      try {
        // If renderer exposure is >1.4 reduce it slightly to avoid blowouts
        if ((this.renderer as any).toneMappingExposure > 1.4) this.renderer.toneMappingExposure = 1.2;
        // tighten bloom defaults
        if (this.bloomPass) {
          this.bloomPass.strength = Math.min(this.bloomPass.strength || 0.18, 0.5);
          this.bloomPass.threshold = Math.max(this.bloomPass.threshold || 1.0, 0.9);
        }
      } catch (e) { }
      return changed;
    } catch (e) { console.warn('applyEnvironment failed', e); }
    return 0;
  }

  private onResize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    // Cap DPR to reduce GPU usage on low-end devices
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h, false);
  }

  // Public helper to manually set size (useful for testing)
  public setSize(width: number, height: number): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(width, height, false);
    try {
      if (this.composer && typeof this.composer.setSize === 'function') this.composer.setSize(width, height);
    } catch (e) { /* ignore */ }
  }

  public render(scene: THREE.Scene, camera: THREE.Camera): void {
    if (this.postProcessingEnabled && this.composer) {
      try {
        this.composer.render();
        return;
      } catch (e) {
        console.warn('composer render failed, falling back to renderer', e);
      }
    }
    this.renderer.render(scene, camera);
  }

  public getRenderer(): THREE.WebGLRenderer {
    return this.renderer;
  }
}

