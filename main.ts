import * as THREE from 'three';
import { AudioManager } from './AudioManager';
import { Engine } from './Engine';
import { GraphicsDebug } from './GraphicsDebug';
import logger from './src/utils/Logger';
import './style.css';
import { UIManager } from './UIManager';
import { VirtualJoystick } from './VirtualJoystick';

// Main application entry point
class App {
  public engine?: Engine;
  private uiManager?: UIManager;
  private boundHandlers: {
    errorHandler?: (ev: ErrorEvent) => void;
    vKeyHandler?: (e: KeyboardEvent) => void;
    beforeUnload?: () => void;
  } = {};

  constructor() {
    // Suppress noisy uncaught errors coming from third-party share-modal.js by converting to warnings
    try {
      this.boundHandlers.errorHandler = (ev: ErrorEvent) => {
        try {
          if (ev.filename && ev.filename.indexOf('share-modal.js') !== -1) {
            ev.preventDefault();
            console.warn('suppressed share-modal.js error:', ev.message);
          }
        } catch (e) { }
      };
      window.addEventListener('error', this.boundHandlers.errorHandler);
    } catch (e) { }

    // Setup cleanup on page unload
    this.boundHandlers.beforeUnload = () => {
      this.dispose();
    };
    window.addEventListener('beforeunload', this.boundHandlers.beforeUnload);

    this.init();
  }

  private async init(): Promise<void> {
    // Get canvas element
    const canvas = document.getElementById('game-canvas') as HTMLCanvasElement;
    if (!canvas) {
      console.error('Canvas element not found');
      return;
    }

    // Initialize client-side logger/overlay when running locally or when forced.
    try {
      const host = location && location.hostname ? location.hostname : '';
      if (host === 'localhost' || host === '127.0.0.1' || (window as any).__FORCE_DEBUG) {
        try { logger.init(); console.info('Client logger initialized (overlay + console hook)'); } catch (e) { console.warn('logger.init failed', e); }
      }
    } catch (e) {}

  // Initialize UI Manager
  this.uiManager = new UIManager('ui-overlay');
  // expose for global access (used for tooltip projections)
  (window as any).uiManager = this.uiManager;
  // restore UI state (panels, presets)
  try { this.uiManager.restoreUIState(); } catch (e) { }

    // Try to fetch public profile data to personalize UI (non-blocking)
    (async () => {
      try {
        const profile: any = { headline: 'Engineer, designer, and creator', projects: [], hobbies: [], timeline: [], memories: [] };
        // Fetch DigiScalability site for content snippets
        try {
          // Skip remote fetching to avoid CORS errors in production
          // Future: Implement a backend proxy or use CORS-enabled endpoints
          const skipRemoteFetch = true;
          if (skipRemoteFetch) {
            console.log('Remote profile fetch disabled to avoid CORS errors');
          } else {
            const r = await fetch('https://digiscalability.com/');
            if (r.ok) {
              const html = await r.text();
            // very small heuristic extraction
            const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
            if (titleMatch) profile.headline = titleMatch[1].trim();
            // parse meta description
            const descMatch = html.match(/<meta\s+name=["']description["']\s+content=["']([^"']+)["']/i) || html.match(/<meta\s+property=["']og:description["']\s+content=["']([^"']+)["']/i);
            if (descMatch && !profile.bioIntro) profile.bioIntro = descMatch[1].trim();
            // parse JSON-LD for author and description
            try {
              const ldMatches = Array.from(html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi));
              for (const lm of ldMatches) {
                try {
                  const parsed = JSON.parse(lm[1]);
                  const collectText = (o: any): string | undefined => {
                    if (!o) return;
                    if (typeof o === 'string') return o;
                    if (Array.isArray(o)) return o.map(collectText).filter(Boolean).join(' ');
                    let res = '';
                    if (o.name) res += ' ' + o.name;
                    if (o.author && typeof o.author === 'object' && o.author.name) res += ' by ' + o.author.name;
                    if (o.description) res += ' ' + (typeof o.description === 'string' ? o.description : (o.description.text || ''));
                    return res.trim();
                  };
                  const info = collectText(parsed);
                  if (info && !profile.bioIntro) profile.bioIntro = info;
                  // author
                  if (!profile.author && parsed.author) {
                    if (typeof parsed.author === 'string') profile.author = parsed.author;
                    else if (parsed.author.name) profile.author = parsed.author.name;
                  }
                } catch (e) { }
              }
            } catch (e) { }
                const projectMatches = Array.from(html.matchAll(/case-studies\/(?:[\w-]+)/gi)).slice(0,6).map(m=>m[0].replace('case-studies/',''));
                // fetch each case-study page and collect images for gallery
                const projects: any[] = [];
                for (const slug of projectMatches) {
                  const url = `https://digiscalability.com/case-studies/${slug}`;
                  try {
                    const rcs = await fetch(url);
                    if (!rcs.ok) { projects.push({ title: slug.replace(/-/g,' '), url }); continue; }
                    const ch = await rcs.text();
                    // try to find og:image
                    const og = ch.match(/<meta\s+property=["']og:image["']\s+content=["']([^"']+)["']/i);
                    const imgs = Array.from(ch.matchAll(/<img[^>]+src=["']([^"']+)["']/gi)).map((mm:any)=>mm[1]).filter(Boolean);
                    // JSON-LD parsing for images
                    try {
                      const jsonldMatches = Array.from(ch.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi));
                      for (const jm of jsonldMatches) {
                        try {
                          const parsed = JSON.parse(jm[1]);
                          const gather = (obj: any) => {
                            if (!obj) return;
                            if (typeof obj === 'string') return;
                            if (Array.isArray(obj)) return obj.forEach(gather);
                            if (obj.image) {
                              if (typeof obj.image === 'string') imgs.push(obj.image);
                              else if (Array.isArray(obj.image)) imgs.push(...obj.image.map((i:any) => typeof i === 'string' ? i : (i.url || '')));
                            }
                            Object.values(obj).forEach(v => { if (typeof v === 'object') gather(v); });
                          };
                          gather(parsed);
                        } catch (e) { }
                      }
                    } catch (e) { }
                    // follow linked portfolio pages (simple heuristic)
                    const linkMatches = Array.from(ch.matchAll(/<a[^>]+href=["']([^"']+)["'][^>]*>/gi)).map((m:any)=>m[1]);
                    const portfolioLinks = linkMatches.filter((u:any)=>/portfolio|work|case-studies/gi.test(u)).slice(0,3);
                    for (const pl of portfolioLinks) {
                      try {
                        const absolute = /^https?:\/\//i.test(pl) ? pl : new URL(pl, url).toString();
                        const rpl = await fetch(absolute);
                        if (!rpl.ok) continue;
                        const ph = await rpl.text();
                        const pimgs = Array.from(ph.matchAll(/<img[^>]+src=["']([^"']+)["']/gi)).map((mm:any)=>mm[1]).filter(Boolean);
                        pimgs.forEach((pi:any) => imgs.push(/^https?:\/\//i.test(pi) ? pi : new URL(pi, absolute).toString()));
                      } catch (e) { /* ignore follow */ }
                    }
                    // build absolute urls where needed
                    const allImgs = [] as string[];
                    if (og && og[1]) allImgs.push(og[1]);
                    imgs.forEach((i: string) => {
                      if (!/^https?:\/\//i.test(i)) {
                        // relative -> absolute
                        try { const u = new URL(i, url); allImgs.push(u.toString()); } catch (e) { }
                      } else allImgs.push(i);
                    });
                    // dedupe
                    const uniq = Array.from(new Set(allImgs)).slice(0,6);
                        projects.push({ title: slug.replace(/-/g,' '), url, image: uniq[0] || '/assets/project-thumbnail.svg', gallery: uniq, description: uniq.length ? `Gallery with ${uniq.length} images` : '' });
                  } catch (e) {
                    projects.push({ title: slug.replace(/-/g,' '), url });
                  }
                }
                if (projects.length) profile.projects = projects;
            // simple team mention
            if (/Abbas/i.test(html)) profile.timeline.push({ year: 'Now', text: 'Lead Developer @ DigiScalability' });
            }
          }
        } catch (e) { console.warn('digiscalability fetch failed', e); }

        // Try fetching banoscookbook as hobby/source for recipes
        // DISABLED to avoid CORS errors - future: implement backend proxy
        /*
        try {
          const r2 = await fetch('https://banoscookbook.com/');
          if (r2.ok) {
            const h = await r2.text();
            if (/recipe/i.test(h)) profile.hobbies.push({ title: 'Cooking Experiments', image: '/assets/hobby-art.svg', description: 'Inspired by Bano Cookbook' });
            try {
              const titleM = h.match(/<title>([^<]+)<\/title>/i);
              if (titleM && !profile.hobbyIntro) profile.hobbyIntro = titleM[1].trim();
              const metaAuth = h.match(/<meta\s+name=["']author["']\s+content=["']([^"']+)["']/i);
              if (metaAuth && !profile.author) profile.author = metaAuth[1].trim();
            } catch (e) {}
          }
        } catch (e) { }
        */

        // Optionally read public LinkedIn (if available) - non-blocking and respectful
        // DISABLED to avoid CORS errors - future: implement backend proxy
        /*
        try {
          const r3 = await fetch('https://www.linkedin.com/in/syed-abbas-ali/');
          if (r3.ok) {
            const l = await r3.text();
            const about = l.match(/About[\s\S]{0,300}?<\/section>/i);
            if (about) profile.bioIntro = 'Experienced engineer and product creator.';
            try {
              const ld = l.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/i);
              if (ld && ld[1]) {
                const parsed = JSON.parse(ld[1]);
                if (parsed.name && !profile.author) profile.author = parsed.name;
                if (parsed.description && !profile.bioIntro) profile.bioIntro = parsed.description;
              }
            } catch (e) { }
          }
        } catch (e) { }
        */

        // Add fallback sample memories
        if (!profile.memories.length) profile.memories = [ { title: 'A quiet essay about beginnings', image: '/assets/project-thumbnail.svg' } ];

        // set into UIManager
        this.uiManager?.setProfileData(profile);
      } catch (e) { console.warn('profile fetch failed', e); }
    })();

    // Load assets with deterministic progress
    const audioManager = new AudioManager();
    (window as any).audioManager = audioManager;

    try {
      await this.loadAssets((p) => this.uiManager?.updateLoadingProgress(p));
      this.uiManager?.hideLoadingScreen();
    } catch (e) {
      const msg = document.getElementById('loading-message');
      const retry = document.getElementById('loading-retry');
      if (msg) msg.textContent = 'Failed to load assets.';
      if (retry) retry.classList.remove('hidden');
      console.error('asset load failed', e);
      return;
    }

    // Initialize Engine
  this.engine = new Engine(canvas);
  // Initialize post-processing after engine constructed
  try {
    // initialize post-processing and then attempt to auto-apply a local HDRI from the manifest
    await this.engine?.initPostProcessing();
    const rendererCtrl = this.engine?.getRendererController?.();
    if (rendererCtrl) {
      (async () => {
        try {
          const r = await fetch('/assets/asset-manifest.json');
          if (!r.ok) return;
          const m = await r.json();
          const hdris = (m.textures || []).filter((t: string) => /\.hdr$/i.test(t) && !/^https?:\/\//i.test(t));
          if (hdris && hdris.length) {
            const first = hdris[0];
            try {
              const env = await rendererCtrl.loadEnvironmentFromUrl('/assets/' + first);
              if (env) {
                const scene = this.engine?.getScene?.();
                if (scene) {
                  scene.environment = env;
                  try { scene.background = env; } catch (e) { /* some three builds don't allow using pmrem as background */ }
                }
                console.log('Auto-applied HDRI:', first);
                try { window.dispatchEvent(new CustomEvent('ds:hdri-applied', { detail: { file: first } })); } catch (e) {}
              }
            } catch (e) { console.warn('failed to load auto HDRI', first, e); }
          }
        } catch (err) { console.warn('auto HDRI apply failed', err); }
      })();
    }
  } catch (e) {
    console.warn('initPostProcessing failed', e);
  }
  // Expose engine and player globally for customization UI
  (window as any).engine = this.engine;
  (window as any).engine.player = this.engine.getPlayer();

  // By default, disable player controls and hide world until the startup flow completes
  try { if (this.engine) this.engine.setControlsEnabled(false); } catch (e) { }
  try { if (this.engine) this.engine.setWorldVisible(false); } catch (e) { }

    // Setup environment controls callback
    if (this.uiManager && this.engine) {
      const sceneManager = this.engine.getSceneManager?.();
      if (sceneManager) {
        this.uiManager.environmentControlsCallback = (action: string, value?: any) => {
          const env = sceneManager.environment;
          if (!env) return;

          switch (action) {
            case 'setTime':
              env.setTimeOfDay(value);
              break;
            case 'setAutoCycle':
              env.setAutoCycle(value);
              break;
            case 'setCycleSpeed':
              env.cycleDuration = value;
              break;
          }
        };
      }

      // Add keyboard shortcut for environment panel (E key)
      this.boundHandlers.vKeyHandler = (e: KeyboardEvent) => {
        if (e.key === 'e' || e.key === 'E') {
          // Don't trigger if typing in input fields
          const target = e.target as HTMLElement;
          if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return;

          this.uiManager?.toggleEnvironmentPanel();
        }
      };
      window.addEventListener('keydown', this.boundHandlers.vKeyHandler);
    }

    // Setup interaction callbacks
    this.setupInteractions();

    // Start the engine
    this.engine.start();

    // Simple performance heuristic: if device reports low memory or low hardware concurrency, reduce rendering quality
    try {
      const hw = (navigator as any).hardwareConcurrency || 4;
      const lowEnd = hw <= 2 || /Mobi|Android/i.test(navigator.userAgent);
      if (lowEnd) {
        console.log('Low-end device heuristics applied: reducing DPR and disabling heavy postprocessing');
        const rendererCtrl = this.engine?.getRendererController?.();
        try { rendererCtrl && rendererCtrl.setPostProcessingEnabled(false); } catch (e) { }
        try { (rendererCtrl as any).setSize && (rendererCtrl as any).setSize(window.innerWidth, window.innerHeight); } catch (e) { }
      }
    } catch (e) { }

    // Expose runtime helpers for quick debugging from console
    try {
      (window as any).disablePostProcessing = () => {
        try { const rc = (window as any).engine?.getRendererController?.(); rc && rc.setPostProcessingEnabled(false); console.log('Post-processing disabled'); } catch (e) { console.warn('disablePostProcessing failed', e); }
      };
      (window as any).enablePostProcessing = () => {
        try { const rc = (window as any).engine?.getRendererController?.(); rc && rc.setPostProcessingEnabled(true); console.log('Post-processing enabled'); } catch (e) { console.warn('enablePostProcessing failed', e); }
      };
      (window as any).adjustCamera = (off: { x?: number; y?: number; z?: number } | null, smooth?: number) => {
        try {
          const eng = (window as any).engine as any;
          const cc = eng && (eng as any).cameraController;
          if (!cc) { console.warn('cameraController not available'); return; }
          if (off) {
            const THREE = require('three');
            const v = new (THREE as any).Vector3(off.x || 0, off.y || 0, off.z || 0);
            cc.setOffset(v);
            console.log('Camera offset set', v);
          }
          if (typeof smooth === 'number') { cc.setSmoothness(smooth); console.log('Camera smoothness set', smooth); }
        } catch (e) { console.warn('adjustCamera failed', e); }
      };
    } catch (e) { }

    // Live camera tuning UI (debug) — only enable when explicitly in dev mode via #dev
    try {
      if (location && location.hash === '#dev') {
        const createCamPanel = () => {
          if (document.getElementById('cam-tuning-panel')) return;
          // existing panel creation code retained for dev builds only
          const panel = document.createElement('div');
          panel.id = 'cam-tuning-panel';
          panel.style.position = 'fixed';
          panel.style.right = '12px';
          panel.style.bottom = '12px';
          panel.style.background = 'rgba(255,255,255,0.96)';
          panel.style.borderRadius = '10px';
          panel.style.padding = '10px';
          panel.style.zIndex = '3000';
          panel.style.fontSize = '12px';
          panel.innerHTML = `<div style="font-weight:700; margin-bottom:6px;">Camera Tuning (dev)</div><div style="font-size:11px; color:#444">Use for development only.</div>`;
          document.body.appendChild(panel);
        };
        createCamPanel();

        // Initialize GraphicsDebug for live tuning
        const rendererCtrl = this.engine?.getRendererController?.();
        const scene = this.engine?.getScene?.();
        if (rendererCtrl && scene) {
    new GraphicsDebug(document.body, rendererCtrl, scene);
        }
      }
    } catch (e) { console.warn('camera tuning panel (dev) failed', e); }

    // Expose a quick helper to make HDRI reflections more visible
    try {
      (window as any).__originalMaterials = (window as any).__originalMaterials || [];
      (window as any).__makeHDRIVisibleState = false;
      (window as any).makeHDRIVisible = async (opts: any = {}) => {
        try {
          const eng = (window as any).engine as any;
          if (!eng) return console.warn('engine not available');
          const scene = eng.getScene();
          if (!scene) return console.warn('scene not available');
          const changed: any[] = [];
          const maxChange = opts.max || 50; // limit changed materials
          let count = 0;
          scene.traverse((obj: any) => {
            if (count >= maxChange) return;
            if (!obj || !obj.material) return;
            let mats: any[] = [];
            if (Array.isArray(obj.material)) mats = obj.material; else mats = [obj.material];
            mats.forEach((m) => {
              // Only tweak materials that are not already fully PBR
              try {
                if (m && (m.isMeshStandardMaterial || m.isMeshPhysicalMaterial)) {
                  // increase envMapIntensity a little
                  // store original if not stored
                  try { (window as any).__originalMaterials.push({ obj, material: m }); } catch (e) {}
                  if (typeof m.envMapIntensity === 'number') m.envMapIntensity = Math.max(m.envMapIntensity || 0, opts.envMapIntensity || 0.8);
                  if (typeof m.metalness === 'number') m.metalness = Math.max(m.metalness || 0, opts.metalness || 0.15);
                  if (typeof m.roughness === 'number') m.roughness = Math.min(typeof m.roughness === 'number' ? m.roughness : 1, opts.roughness || 0.6);
                  changed.push(m);
                  count++;
                } else if (m && (m.isMeshToonMaterial || m.isMeshBasicMaterial)) {
                  // convert a shallow copy to MeshStandardMaterial to reveal reflections for important objects
                  const THREE = require('three');
                  const std = new (THREE as any).MeshStandardMaterial();
                  // try to copy color/normal maps where present
                  try { (window as any).__originalMaterials.push({ obj, material: m }); } catch (e) {}
                  std.color = m.color ? m.color.clone() : std.color;
                  if (m.map) std.map = m.map;
                  std.metalness = opts.metalness || 0.12;
                  std.roughness = opts.roughness || 0.6;
                  std.envMapIntensity = opts.envMapIntensity || 0.8;
                  obj.material = std;
                  changed.push(std);
                  count++;
                }
              } catch (e) { /* ignore material conversion errors */ }
            });
          });
          console.log('makeHDRIVisible changed materials:', changed.length);
          (window as any).__makeHDRIVisibleState = true;
          // small UI toast
          try {
            const el = document.createElement('div'); el.className = 'toast'; el.textContent = 'Visual mode: HDRI boost applied'; el.style.position = 'fixed'; el.style.bottom = '18px'; el.style.left = '18px'; el.style.zIndex = '2000'; el.style.background = 'rgba(0,0,0,0.6)'; el.style.color = 'white'; el.style.padding = '8px 10px'; el.style.borderRadius = '8px'; document.body.appendChild(el); setTimeout(() => el.remove(), 2200);
          } catch (e) { }
        } catch (e) { console.warn('makeHDRIVisible failed', e); }
      };
      (window as any).restoreOriginalMaterials = () => {
        try {
          const list = (window as any).__originalMaterials || [];
          list.forEach((it: any) => { try { it.obj.material = it.material; } catch (e) { } });
          (window as any).__originalMaterials = [];
          (window as any).__makeHDRIVisibleState = false;
          const el = document.createElement('div'); el.className = 'toast'; el.textContent = 'Visual mode: restored'; el.style.position = 'fixed'; el.style.bottom = '18px'; el.style.left = '18px'; el.style.zIndex = '2000'; el.style.background = 'rgba(0,0,0,0.6)'; el.style.color = 'white'; el.style.padding = '8px 10px'; el.style.borderRadius = '8px'; document.body.appendChild(el); setTimeout(() => el.remove(), 1600);
        } catch (e) { console.warn('restoreOriginalMaterials failed', e); }
      };
    } catch (e) { }

    // Mobile: add virtual joystick and attach to InputManager
    const isTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
    if (isTouch) {
      const vj = new VirtualJoystick();
      // expose joystick for debugging
      (window as any).virtualJoystick = vj;
      const im = this.engine.getInputManager();
      im.setJoystickProvider(vj);
    }

    // Setup startup flow: thumbnail -> dialogue -> character -> island
    const startSequence = async () => {
      // Animate camera from distant planet view to player (cinematic fly-in)
      try {
        const eng = (window as any).engine as any;
        const cc = eng && eng.cameraController;
        if (cc && typeof cc.flyInFromDistantView === 'function') {
          await cc.flyInFromDistantView(1800, new THREE.Vector3(0, 18, 32));
        }
      } catch (e) { }

      // Show initial tutorial/dialogue (after fly-in)
      this.uiManager?.showDialogue('Messenger', "Looks like I slept in... I better start today's deliveries.");

      // Wait for dialogue end event from UIManager
      await new Promise<void>((resolve) => {
        const onEnd = () => { window.removeEventListener('ui:dialogue-end', onEnd); resolve(); };
        window.addEventListener('ui:dialogue-end', onEnd);
      });

      // Brief camera focus on character (tuck-in cinematic)
      try {
        const eng = (window as any).engine as any;
        const cc = eng && eng.cameraController;
        if (cc && typeof cc.setSmoothness === 'function') {
          // tighten camera for cinematic then restore
          const prevSmooth = (cc as any).smoothness || 0.08;
          cc.setSmoothness(0.02);
          // snap closer for a second
          const prevOffset = (cc as any).offset ? (cc as any).offset.clone() : new THREE.Vector3(0,4,7);
          cc.setOffset(new THREE.Vector3(0, 2.2, 3.2));
          await new Promise((r) => setTimeout(r, 1200));
          // restore camera
          cc.setOffset(prevOffset);
          cc.setSmoothness(prevSmooth);
        }
      } catch (e) { }

  // enable player controls and close any lingering onboarding/thumbnail overlays
  try { if (this.engine) this.engine.setControlsEnabled(true); } catch (e) { }
  try { if (this.engine) this.engine.setWorldVisible(true); } catch (e) { }
  try { if (this.uiManager) this.uiManager.hideWelcomeScreen(); } catch (e) { }
  // Fade in UI after camera transition
  try { if (this.uiManager) this.uiManager.fadeInUI(900); } catch (e) { }
  try { if (this.uiManager) this.uiManager.showToast('You are in control now'); } catch (e) { }
    };

    // Start the sequence immediately since PlanetThumbnail is missing
    startSequence().catch((err) => console.warn('startSequence failed', err));    // Initialize delivery counter in HUD
    const total = this.engine.getMailboxes().length;
    this.uiManager?.updateDeliveryCounter(0, total);

    // Subscribe to delivery complete to update HUD
    const deliverySystem = this.engine.getDeliverySystem();
    deliverySystem.onDeliveryComplete(() => {
      const completed = deliverySystem.getCompletedCount();
      const tot = deliverySystem.getTotalCount();
      this.uiManager?.updateDeliveryCounter(completed, tot);
    });

    console.log('DigiScalability Life Island initialized successfully!');
  }

  private async loadAssets(onProgress?: (progress: number) => void): Promise<void> {
    // Read manifest from /assets/asset-manifest.json if present
    const manifestUrl = '/assets/asset-manifest.json';
    let manifest: any = { textures: [], audio: [], models: [] };
    try {
      const r = await fetch(manifestUrl);
      if (r.ok) manifest = await r.json();
    } catch (e) {
      console.warn('failed to load manifest', e);
    }

    // Normalize manifest entries:
    const rawTextures: string[] = manifest.textures || [];
    // Separate image textures from HDR/EXR environment maps. TextureLoader cannot load HDR/EXR.
    const textures = rawTextures
      .filter((p: string) => !/\.(hdr|exr)$/i.test(p))
      .map((p: string) => (/^https?:\/\//i.test(p) ? p : `/assets/${p}`));
    // Keep HDR/EXR list for later (Renderer will load these via RGBELoader/HDRLoader)
    const hdrEnvironments = rawTextures
      .filter((p: string) => /\.(hdr|exr)$/i.test(p))
      .map((p: string) => (/^https?:\/\//i.test(p) ? p : `/assets/${p}`));
    // Expose for debugging / quick load buttons in UIManager
    try { (window as any).__hdrEnvironments = hdrEnvironments; } catch (e) { /* ignore */ }

    const audios = (manifest.audio || []).map((p: string) => ({ url: (/^https?:\/\//i.test(p) ? p : `/assets/${p}`), key: p.replace(/^.*[\\/]/, '').replace(/\.[^/.]+$/, '') }));
    const models = (manifest.models || []).map((p: string) => (/^https?:\/\//i.test(p) ? p : `/assets/${p}`));

    const totalItems = textures.length + audios.length + models.length || 1;
    let loaded = 0;

    const loader = new THREE.TextureLoader();

    const texturePromises = textures.map((url: string) => new Promise<void>((resolve) => {
      // TextureLoader is for standard image formats only (jpg/png/webp/svg). It will fail for HDR/EXR.
      loader.load(url, (tex) => {
        loaded++;
        onProgress && onProgress(loaded / totalItems);
        resolve();
      }, undefined, (err) => {
        console.warn('texture load failed', url, err);
        loaded++;
        onProgress && onProgress(loaded / totalItems);
        resolve();
      });
    }));

    // Load audio via AudioManager if available
    const am = (window as any).audioManager as import('./AudioManager').AudioManager | undefined;
    const audioPromises = (am && audios.length) ? audios.map((a: any) => new Promise<void>(async (resolve) => {
      try {
        // Fetch audio HEAD to check size and content-type; large files are deferred to avoid heavy initial decode
        try {
          let size = 0;
          try {
            const head = await fetch(a.url, { method: 'HEAD' });
            if (head.ok) {
              const cl = head.headers.get('content-length');
              size = cl ? parseInt(cl, 10) : 0;
            }
          } catch (headErr) {
            // HEAD may be blocked by servers; fall back to GET probing
          }

          // If size seems large (>1.5MB) defer decoding to avoid main-thread jank
          const DEFER_THRESHOLD = 1500000;
          if (size && size > DEFER_THRESHOLD) {
            // register as deferred audio for later on-demand loading
            try { (window as any).__deferredAudio = (window as any).__deferredAudio || {}; (window as any).__deferredAudio[a.key || a.url] = a.url; } catch (e) {}
            console.log('deferring large audio', a.url, size);
            loaded++; onProgress && onProgress(loaded / totalItems); resolve(); return;
          }

          // Small enough: fetch body and attempt decode now
          const rr = await fetch(a.url);
          if (!rr.ok) { console.warn('audio fetch not ok', a.url, rr.status); throw new Error('audio fetch not ok'); }
          const arr = await rr.arrayBuffer();
          if (typeof am.loadAudioBuffer === 'function') {
            try {
              await am.loadAudioBuffer(arr, a.key);
            } catch (decodeErr) {
              console.warn('audio decode failed', a.url, decodeErr);
              throw decodeErr;
            }
          } else {
            try { await am.loadAudio(a.url, a.key); } catch (e) { console.warn('audio load fallback failed', a.url, e); throw e; }
          }
        } catch (valErr) {
          console.warn('audio validation/decoding failed, skipping audio', a.url, valErr);
          loaded++; onProgress && onProgress(loaded / totalItems); resolve(); return;
        }
      } catch (e) {
        console.warn('audio load failed', a.url, e);
      }
      loaded++;
      onProgress && onProgress(loaded / totalItems);
      resolve();
    })) : audios.map((a: any) => new Promise<void>((resolve) => { loaded++; onProgress && onProgress(loaded / totalItems); resolve(); }));

    // Models: try GLTFLoader if available
    let modelPromises: Array<Promise<void>> = [];
    try {
      const mod = await import('three/addons/loaders/GLTFLoader.js');
      const { GLTFLoader } = mod as any;
      const gltfLoader = new GLTFLoader();
      modelPromises = models.map((url: string) => new Promise<void>((resolve) => {
        gltfLoader.load(url, (g: any) => {
          loaded++;
          onProgress && onProgress(loaded / totalItems);
          resolve();
        }, undefined, (err: any) => {
          console.warn('model load failed', url, err);
          loaded++;
          onProgress && onProgress(loaded / totalItems);
          resolve();
        });
      }));
    } catch (e) {
      // no GLTFLoader, mark models as 'loaded' to avoid blocking
      modelPromises = models.map(() => new Promise<void>((resolve) => { loaded++; onProgress && onProgress(loaded / totalItems); resolve(); }));
    }

    await Promise.all([...texturePromises, ...audioPromises, ...modelPromises]);
    onProgress && onProgress(1);
  }

  // Helper to load deferred audio entries later (decodes into AudioManager)
  public static async loadDeferredAudio(keyOrUrl: string) {
    try {
      const deferred = (window as any).__deferredAudio || {};
      const url = deferred[keyOrUrl] || keyOrUrl;
      if (!url) return console.warn('deferred audio not found', keyOrUrl);
      const am = (window as any).audioManager as any;
      if (!am) return console.warn('audioManager not available');
      const rr = await fetch(url);
      if (!rr.ok) return console.warn('deferred audio fetch failed', url, rr.status);
      const arr = await rr.arrayBuffer();
      if (typeof am.loadAudioBuffer === 'function') {
        await am.loadAudioBuffer(arr, keyOrUrl);
        delete (window as any).__deferredAudio[keyOrUrl];
        console.log('deferred audio loaded', keyOrUrl);
      }
    } catch (e) { console.warn('loadDeferredAudio failed', e); }
  }

  // Debug helper: show element under pointer and log click attempts
  public static installPointerDebug() {
    let active = false;
    let overlay: HTMLElement | null = null;
    const toggle = () => {
      active = !active;
      if (active) {
        overlay = document.createElement('div'); overlay.id = 'pointer-debug'; overlay.style.position = 'fixed'; overlay.style.pointerEvents = 'none'; overlay.style.zIndex = '99999'; overlay.style.padding = '6px 8px'; overlay.style.background = 'rgba(0,0,0,0.6)'; overlay.style.color = 'white'; overlay.style.fontFamily = 'monospace'; overlay.style.fontSize = '12px'; document.body.appendChild(overlay);
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerdown', onDown, true);
      } else {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerdown', onDown, true);
        overlay && overlay.remove(); overlay = null;
      }
    };
    const onMove = (e: PointerEvent) => {
      const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
      if (!overlay) return;
      if (el) {
        overlay.textContent = `${el.tagName.toLowerCase()}${el.id ? '#'+el.id : ''}${el.className ? ' .' + String(el.className).split(' ').join('.') : ''}`;
        overlay.style.left = (e.clientX + 12) + 'px'; overlay.style.top = (e.clientY + 12) + 'px';
      } else {
        overlay.textContent = 'none';
      }
    };
    const onDown = (e: PointerEvent) => {
      const el = document.elementFromPoint((e as any).clientX, (e as any).clientY) as HTMLElement | null;
      console.log('pointerdown target', el);
    };
    (window as any).togglePointerDebug = toggle;
    console.log('pointer debug helper installed. call togglePointerDebug() to enable.');
  }

  // Expose a debug helper to validate assets listed in manifest (checks audio fetch/decode and HDR availability)
  public static async validateManifestAssets(manifestUrl = '/assets/asset-manifest.json') {
    try {
      const r = await fetch(manifestUrl);
      if (!r.ok) return console.warn('manifest fetch failed', r.status);
      const m = await r.json();
      const issues: any[] = [];
      // check HDRs
      const textures = m.textures || [];
      for (const t of textures) {
        if (/\.(hdr|exr)$/i.test(t)) {
          const url = /^https?:\/\//i.test(t) ? t : '/assets/' + t;
          try {
            const rr = await fetch(url, { method: 'HEAD' });
            if (!rr.ok) issues.push({ url, status: rr.status });
          } catch (e) { issues.push({ url, error: e }); }
        }
      }
      // check audios
      const audios = m.audio || [];
      for (const a of audios) {
        const url = /^https?:\/\//i.test(a) ? a : '/assets/' + a;
        try {
          const rr = await fetch(url);
          if (!rr.ok) { issues.push({ url, status: rr.status }); continue; }
          const ct = rr.headers.get('content-type') || '';
          if (!/audio\//i.test(ct)) { issues.push({ url, contentType: ct }); continue; }
        } catch (e) { issues.push({ url, error: e }); }
      }
      if (issues.length) console.warn('manifest validation issues', issues); else console.log('manifest validation: OK');
      return issues;
    } catch (e) { console.warn('manifest validation failed', e); }
  }

  private setupInteractions(): void {
    if (!this.engine || !this.uiManager) return;

    const interactionSystem = this.engine.getInteractionSystem();

    // Handle zone interactions
    interactionSystem.onInteraction((zone: any) => {
      console.log('Interacting with zone:', zone.name);
      this.uiManager?.showInteractionPanel(zone);

      // If it's the contact dock, setup special interactions
      if (zone.id === 'contact-dock') {
        setTimeout(() => {
          this.setupContactDockInteractions();
        }, 100);
      }
    });

    // Handle object interactions (NPCs, mailboxes, etc.) using the InteractionSystem's object callback
    interactionSystem.onObjectInteraction((obj: any) => {
      try {
        if (!this.uiManager) return;
        const title = obj.name || (obj.userData && obj.userData.name) || 'Friend';
        const body = (obj.userData && (obj.userData.dialogue || obj.userData.bubbleText)) || 'Hello!';
        // compute anchored screen position
        try {
          const cam = (this.engine as any).sceneManager?.getCamera?.();
          const canvas = document.getElementById('game-canvas') as HTMLCanvasElement | null;
          const targetPos = (obj.mesh && obj.mesh.position) ? obj.mesh.position : (obj.position || (obj.getWorldPosition ? obj.getWorldPosition(new THREE.Vector3()) : undefined));
          if (cam && canvas && targetPos) {
            const vec = (targetPos as THREE.Vector3).clone().project(cam);
            if (vec.z < 1 && vec.z > -1) {
              const crect = canvas.getBoundingClientRect();
              const x = (vec.x * 0.5 + 0.5) * crect.width + crect.left;
              const y = (-vec.y * 0.5 + 0.5) * crect.height + crect.top;
              if (typeof this.uiManager.showDialogue === 'function') this.uiManager.showDialogue(title, body, x, y - 16);
              else this.uiManager.showSpeechBubbleTimed(title, body, x, y - 16, 4);
            }
          }
        } catch (e) { /* ignore projection errors */ }
      } catch (e) { }
    });

    // Update HUD and world-anchored hints based on nearby zones
    let lastNearbyZoneId: string | null = null;
    setInterval(() => {
      const nearbyZone = interactionSystem.getNearbyZone();
      if (nearbyZone) {
        this.uiManager?.updateHUD(`Press E or Space to interact with ${nearbyZone.name}`);
        // compute screen position for hint and bubble using camera projection
        try {
          const cam = (this.engine as any).sceneManager?.getCamera?.();
          const canvas = document.getElementById('game-canvas') as HTMLCanvasElement | null;
          const targetPos = (nearbyZone.marker && (nearbyZone.marker as any).position) ? (nearbyZone.marker as any).position : nearbyZone.getPosition();
          if (cam && canvas && targetPos) {
            const vec = targetPos.clone().project(cam);
            if (vec.z < 1 && vec.z > -1) {
              const crect = canvas.getBoundingClientRect();
              const x = (vec.x * 0.5 + 0.5) * crect.width + crect.left;
              const y = (-vec.y * 0.5 + 0.5) * crect.height + crect.top;
              // show interaction hint slightly above the object
              this.uiManager?.showInteractionHint(x, y - 12);
              // only show speech bubble when newly approached to avoid noise
              if (lastNearbyZoneId !== nearbyZone.id) {
                this.uiManager?.showSpeechBubble(nearbyZone.name, nearbyZone.description, x, y - 40);
              }
            } else {
              this.uiManager?.hideInteractionHint();
              this.uiManager?.hideSpeechBubble();
            }
          }
        } catch (e) { }
        lastNearbyZoneId = nearbyZone.id;
      } else {
        this.uiManager?.updateHUD('Explore the island and discover the zones!');
        this.uiManager?.hideInteractionHint();
        this.uiManager?.hideSpeechBubble();
        lastNearbyZoneId = null;
      }
    }, 100);

    // Chat toggle removed from global keybindings to simplify runtime UI; UIManager.toggleChatWindow remains callable from UI.

    // Quick reorient: press 'V' to snap player yaw to camera yaw
    this.boundHandlers.vKeyHandler = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === 'v') {
        try {
          const eng = (window as any).engine as any;
          const cam = eng?.sceneManager?.getCamera?.();
          const player = eng?.getPlayer?.();
          if (!cam || !player) return;
          const camEuler = new THREE.Euler().setFromQuaternion(cam.quaternion, 'YXZ');
          const camYaw = camEuler.y || 0;
          if (typeof player.alignToYaw === 'function') player.alignToYaw(camYaw);
        } catch (err) { /* ignore */ }
      }
    };
    window.addEventListener('keydown', this.boundHandlers.vKeyHandler);
  }

  private setupContactDockInteractions(): void {
    const openChatBtn = document.getElementById('open-chat');
    const openFeedbackBtn = document.getElementById('open-feedback');
    const openAppointmentBtn = document.getElementById('open-appointment');

    if (openChatBtn) {
      openChatBtn.addEventListener('click', () => {
        this.uiManager?.hideInteractionPanel();
        this.uiManager?.showChatWindow();
      });
    }

    if (openFeedbackBtn) {
      openFeedbackBtn.addEventListener('click', () => {
        this.showFeedbackForm();
      });
    }

    if (openAppointmentBtn) {
      openAppointmentBtn.addEventListener('click', () => {
        this.showAppointmentForm();
      });
    }
  }

  private showFeedbackForm(): void {
    const content = document.getElementById('panel-content');
    if (!content) return;

    content.innerHTML = `
      <h3>Leave Feedback</h3>
      <input type="text" id="feedback-name" placeholder="Your Name" style="width: 100%; margin-bottom: 10px;" />
      <input type="email" id="feedback-email" placeholder="Your Email" style="width: 100%; margin-bottom: 10px;" />
      <textarea id="feedback-message" placeholder="Your Message" style="width: 100%; margin-bottom: 10px;"></textarea>
      <button id="submit-feedback">Submit Feedback</button>
      <button id="back-to-contact">Back</button>
    `;

    const submitBtn = document.getElementById('submit-feedback');
    const backBtn = document.getElementById('back-to-contact');

    if (submitBtn) {
      submitBtn.addEventListener('click', async () => {
        const name = (document.getElementById('feedback-name') as HTMLInputElement)?.value;
        const email = (document.getElementById('feedback-email') as HTMLInputElement)?.value;
        const message = (document.getElementById('feedback-message') as HTMLTextAreaElement)?.value;

        if (name && email && message) {
          const feedbackSystem = this.uiManager?.getFeedbackSystem();
          const success = await feedbackSystem?.submitFeedback({ name, email, message });

          if (success) {
            this.uiManager?.showToast('Thank you for your feedback!');
            this.uiManager?.hideInteractionPanel();
          } else {
            this.uiManager?.showToast('Failed to submit feedback. Please try again.');
          }
        } else {
          this.uiManager?.showToast('Please fill in all fields.');
        }
      });
    }

    if (backBtn) {
      backBtn.addEventListener('click', () => {
        const zone = this.engine?.getZonesManager().getZoneById('contact-dock');
        if (zone) {
          this.uiManager?.showInteractionPanel(zone);
          setTimeout(() => this.setupContactDockInteractions(), 100);
        }
      });
    }
  }

  private showAppointmentForm(): void {
    const content = document.getElementById('panel-content');
    if (!content) return;

    content.innerHTML = `
      <h3>Schedule Appointment</h3>
      <input type="text" id="appointment-name" placeholder="Your Name" style="width: 100%; margin-bottom: 10px;" />
      <input type="email" id="appointment-email" placeholder="Your Email" style="width: 100%; margin-bottom: 10px;" />
      <input type="date" id="appointment-date" style="width: 100%; margin-bottom: 10px;" />
      <input type="time" id="appointment-time" style="width: 100%; margin-bottom: 10px;" />
      <select id="appointment-duration" style="width: 100%; margin-bottom: 10px;">
        <option value="30">30 minutes</option>
        <option value="60">1 hour</option>
        <option value="90">1.5 hours</option>
      </select>
      <textarea id="appointment-notes" placeholder="Notes (optional)" style="width: 100%; margin-bottom: 10px;"></textarea>
      <button id="submit-appointment">Schedule Appointment</button>
      <button id="back-to-contact-2">Back</button>
    `;

    const submitBtn = document.getElementById('submit-appointment');
    const backBtn = document.getElementById('back-to-contact-2');

    if (submitBtn) {
      submitBtn.addEventListener('click', async () => {
        const name = (document.getElementById('appointment-name') as HTMLInputElement)?.value;
        const email = (document.getElementById('appointment-email') as HTMLInputElement)?.value;
        const date = (document.getElementById('appointment-date') as HTMLInputElement)?.value;
        const time = (document.getElementById('appointment-time') as HTMLInputElement)?.value;
        const duration = parseInt((document.getElementById('appointment-duration') as HTMLSelectElement)?.value);
        const notes = (document.getElementById('appointment-notes') as HTMLTextAreaElement)?.value;

        if (name && email && date && time) {
          const appointmentSystem = this.uiManager?.getAppointmentSystem();
          const success = await appointmentSystem?.scheduleAppointment({
            name,
            email,
            date,
            time,
            duration,
            notes,
          });

          if (success) {
            this.uiManager?.showToast('Appointment scheduled successfully!');
            this.uiManager?.hideInteractionPanel();
          } else {
            this.uiManager?.showToast('Failed to schedule appointment. Please try again.');
          }
        } else {
          this.uiManager?.showToast('Please fill in all required fields.');
        }
      });
    }

    if (backBtn) {
      backBtn.addEventListener('click', () => {
        const zone = this.engine?.getZonesManager().getZoneById('contact-dock');
        if (zone) {
          this.uiManager?.showInteractionPanel(zone);
          setTimeout(() => this.setupContactDockInteractions(), 100);
        }
      });
    }
  }

  /**
   * Cleanup method to dispose all resources and remove event listeners.
   * Called automatically on page unload or can be called manually for hot reload cleanup.
   */
  public dispose(): void {
    // Stop and dispose engine
    if (this.engine) {
      try {
        this.engine.dispose();
      } catch (e) {
        console.warn('Error disposing engine:', e);
      }
      this.engine = undefined;
    }

    // Dispose UI manager
    if (this.uiManager) {
      try {
        this.uiManager.dispose();
      } catch (e) {
        console.warn('Error disposing UIManager:', e);
      }
      this.uiManager = undefined;
    }

    // Remove global event listeners
    if (this.boundHandlers.errorHandler) {
      window.removeEventListener('error', this.boundHandlers.errorHandler);
    }
    if (this.boundHandlers.vKeyHandler) {
      window.removeEventListener('keydown', this.boundHandlers.vKeyHandler);
    }
    if (this.boundHandlers.beforeUnload) {
      window.removeEventListener('beforeunload', this.boundHandlers.beforeUnload);
    }

    // Clear bound handlers
    this.boundHandlers = {};

    // Clear global references
    try {
      delete (window as any).engine;
      delete (window as any).uiManager;
    } catch (e) {
      // ignore
    }
  }
}

// Initialize the app when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => new App());
} else {
  new App();
}

