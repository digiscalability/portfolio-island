import { DeliverySystem } from './DeliverySystem';
import { GameScene } from './GameScene';
import { Multiplayer } from './Multiplayer';
import { NpcQuestSystem } from './NpcQuests';
import { sfx } from './Sfx';
import type { HatId } from './SimplePlayer';
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
  private npcQuests!: NpcQuestSystem;
  private multiplayer: Multiplayer | null = null;
  private isRunning: boolean = false;

  // Island shop (hat cosmetics, paid with meadow coins)
  private readonly hatCatalog: Array<{ id: HatId; icon: string; name: string; price: number }> = [
    { id: 'cap', icon: '🧢', name: 'Explorer Cap', price: 8 },
    { id: 'party', icon: '🥳', name: 'Party Hat', price: 10 },
    { id: 'flower', icon: '🌸', name: 'Flower Crown', price: 12 },
    { id: 'top', icon: '🎩', name: 'Top Hat', price: 15 },
    { id: 'wizard', icon: '🧙', name: 'Wizard Hat', price: 20 },
    { id: 'crown', icon: '👑', name: 'Golden Crown', price: 25 },
    { id: 'halo', icon: '😇', name: 'Halo', price: 40 },
  ];
  private ownedHats: Set<string> = new Set();
  private equippedHat: string | null = null;

  // FPS tracking
  private frameCount: number = 0;
  private fpsUpdateInterval: number = 0;

  // Minimap refresh throttle (10 Hz is plenty for a 190px map)
  private mapAccum: number = 0;

  // Footstep/landing SFX state. Grounding flickers frame-to-frame while
  // walking (integrate-out then snap-back), so landings are debounced by
  // continuous airborne time rather than raw grounded transitions.
  private stepAccum: number = 0;
  private stepAlt: boolean = false;
  private airborneTime: number = 0;
  private prevJumpHeld: boolean = false;

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
      this.scene.setOnMailboxInteract((mailbox) => {
        const collected = this.deliverySystem.collectFromMailbox(mailbox);
        if (collected) this.scene.wiggleMailbox(mailbox);
        return collected;
      });
      console.log(`✓ Quest deliveries assigned across ${mailboxes.length} mailboxes`);

      // Setup quest completion callback
      this.deliverySystem.setOnQuestComplete((quest) => {
        console.log(`🎉 Quest "${quest.name}" completed!`);
        sfx.questComplete();
        this.ui.showQuestComplete(quest);
      });

      // Pickup ding on every completed delivery
      this.deliverySystem.setOnDeliveryComplete(() => sfx.collect());

      // Setup zone interaction callback
      this.scene.setOnZoneInteract((zone) => {
        console.log(`🎯 Opening zone: ${zone.name}`);
        this.ui.showZonePanel(zone);
      });

      // NPC quests: stateful dialogue + rewards layered over ambient lines
      this.npcQuests = new NpcQuestSystem();
      this.scene.setQuestMarkers(this.npcQuests.getGiverNamesWithAvailableQuests());

      // Restore the shop wardrobe (owned + equipped hats)
      try {
        this.ownedHats = new Set(JSON.parse(localStorage.getItem('ds_owned_hats') ?? '[]'));
        this.equippedHat = localStorage.getItem('ds_hat');
        if (this.equippedHat) this.scene.equipPlayerHat(this.equippedHat as HatId);
      } catch {
        /* fresh wardrobe */
      }

      // Multiplayer: other visitors on the same island, waves included
      this.multiplayer = new Multiplayer(this.scene, this.scene.getPlayer());
      this.multiplayer.onCount((count) => this.ui.updatePlayerCount(count));
      this.multiplayer.setHat((this.equippedHat as HatId) ?? null);

      // Setup NPC interaction callback (quest dialogue wins when relevant)
      this.scene.setOnNPCInteract((npcData) => {
        console.log(`💬 Talking to: ${npcData.name}`);
        // The Market Vendor runs the island shop
        if (npcData.name === 'Market Vendor') {
          sfx.blip();
          this.openShop();
          return;
        }
        const talk = this.npcQuests.onTalk(npcData.name, this.scene.getCoinsCollected());
        this.ui.showDialogue(npcData.name, talk ? talk.lines : npcData.dialogue);
        if (talk?.accepted) {
          sfx.blip();
          this.scene.setQuestMarkers(this.npcQuests.getGiverNamesWithAvailableQuests());
        }
        if (talk?.completed) {
          const q = talk.completed;
          this.scene.addCoins(q.rewardCoins);
          sfx.questComplete();
          this.ui.showQuestComplete({
            name: `${q.giverName}'s request`,
            reward: { type: 'message', value: `+${q.rewardCoins} 🪙 reward` },
          } as any);
          this.scene.setQuestMarkers(this.npcQuests.getGiverNamesWithAvailableQuests());
        }
      });

      // Environment badge: weather · time of day · place
      this.scene.getEnvironmentCycle()?.onStatus((status) => {
        this.ui.setEnvironmentBadge(status);
      });

      // Coin counter (persisted across visits)
      this.ui.updateCoinCounter(this.scene.getCoinsCollected());
      this.scene.setOnCoinCollected((total) => this.ui.updateCoinCounter(total));

      // Mute button → shared AudioManager (created by startBackgroundMusic)
      this.ui.setOnMuteToggle(() => {
        const am = (window as unknown as { audioManager?: { toggleMute(): boolean } }).audioManager;
        return am ? am.toggleMute() : false;
      });

      // Initialize post-processing
      this.renderer.initPostProcessing(this.scene, this.scene.getCamera());
      console.log('✓ Post-processing initialized');

      this.renderer.setPostProcessingEnabled(true);
      console.log('✨ Bloom enabled by default (Ctrl+B to toggle).');

      this.setupDebugShortcuts();

      // Create input manager
      this.inputManager = new SimpleInputManager();
      this.inputManager.attachToCanvas(canvas);
      console.log('✓ Input manager created');

      // Setup cleanup on page unload
      this.boundHandlers.beforeUnload = () => this.dispose();
      window.addEventListener('beforeunload', this.boundHandlers.beforeUnload);

      // Pre-compile every shader program while the loading screen is still
      // up. Otherwise the first rendered frames compile ~50 programs
      // (toonified materials, sky, bloom) mid-fly-in — seconds of jank on
      // every refresh.
      this.ui.showLoading(100);
      try {
        const gl = this.renderer.getRenderer() as unknown as {
          compile: (scene: unknown, camera: unknown) => void;
          compileAsync?: (scene: unknown, camera: unknown) => Promise<unknown>;
        };
        if (typeof gl.compileAsync === 'function') {
          await gl.compileAsync(this.scene, this.scene.getCamera());
        } else {
          gl.compile(this.scene, this.scene.getCamera());
        }
        console.log('✓ Shaders pre-compiled');
      } catch (e) {
        console.warn('Shader pre-compile skipped:', e);
      }

      // Start the fly-in BEFORE the first frame renders: its first act is
      // placing the camera at the distant start, so no frame can ever show
      // the degenerate pre-placement view. The opaque loader then fades
      // out over the already-moving cinematic.
      this.scene
        .getOrbitCamera()
        .flyInFromDistant(2500)
        .then(() => {
          this.ui.showWelcome();
        });

      // Start render loop
      this.startRenderLoop();
      console.log('✓ Render loop started');

      setTimeout(() => this.ui.hideLoading(), 350);

      // Start background music
      this.startBackgroundMusic();

      // Browsers create AudioContexts suspended until a user gesture; nothing
      // resumed it before, so music (and now SFX) stayed silent. Resume once
      // on the first key/click, unless the user has muted.
      const resumeAudio = () => {
        window.removeEventListener('keydown', resumeAudio);
        window.removeEventListener('pointerdown', resumeAudio);
        try {
          const am = (window as unknown as {
            audioManager?: { ensureCtx(): AudioContext; isMuted(): boolean };
          }).audioManager;
          if (am && !am.isMuted()) void am.ensureCtx().resume();
        } catch {
          /* ignore */
        }
      };
      window.addEventListener('keydown', resumeAudio);
      window.addEventListener('pointerdown', resumeAudio);

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

    // Only process input once the loader and welcome screen are gone
    if (!this.ui.isWelcomeVisible() && !this.ui.isLoadingVisible()) {
      // If dialogue is active, E advances/closes it; suppress movement
      if (this.ui.isDialogueActive()) {
        this.scene.setPlayerMovement(0, 0);
        this.ui.hideInteractionPrompt();
        const cameraInput = this.inputManager.getCameraInput();
        this.scene.setCameraInput(cameraInput.deltaX, cameraInput.deltaY);

        if (this.inputManager.consumeKeyPress('e')) {
          sfx.blip();
          this.ui.advanceDialogue();
        }

        // Walking away from the NPC closes dialogue
        const nearby = this.scene.getNearbyInteractable();
        if (!nearby || nearby.type !== 'npc') {
          this.ui.hideDialogue();
        }
      } else if (this.scene.isPlayerSeated()) {
        // Seated on a bench: movement suppressed, E stands back up
        this.scene.setPlayerMovement(0, 0);
        this.ui.showInteractionPrompt('🪑 Press <strong>E</strong> to stand up');
        const cameraInput = this.inputManager.getCameraInput();
        this.scene.setCameraInput(cameraInput.deltaX, cameraInput.deltaY);
        if (this.inputManager.consumeKeyPress('e')) {
          this.scene.standUpFromBench();
          this.ui.hideInteractionPrompt();
        }
      } else {
        // Get input
        const moveInput = this.inputManager.getMovementInput();
        const cameraInput = this.inputManager.getCameraInput();
        const jumpInput = this.inputManager.getJumpInput();

        // Apply player input (keyboard merged with the touch joystick)
        const joy = this.ui.getJoystick();
        this.scene.setPlayerMovement(
          Math.max(-1, Math.min(1, moveInput.forward + joy.forward)),
          Math.max(-1, Math.min(1, moveInput.strafe + joy.strafe)),
        );
        const player = this.scene.getPlayer();
        if (jumpInput) {
          // Edge-triggered: one blip per press, only from the ground
          if (player && player.isOnGround() && !this.prevJumpHeld) sfx.jump();
          this.scene.playerJump();
        }
        this.prevJumpHeld = jumpInput;

        // Wave at nearby visitors
        if (this.inputManager.consumeKeyPress('q') && this.multiplayer) {
          this.multiplayer.wave();
          sfx.blip();
        }

        // Footsteps while walking; thud when landing from a real jump/fall
        if (player) {
          const grounded = player.isOnGround();
          const speed = player.getTangentialSpeed();
          if (!grounded) {
            this.airborneTime += deltaTime;
          } else {
            if (this.airborneTime > 0.12) {
              sfx.land();
              this.scene.spawnDust(player.getWorldPosition(), 6);
            }
            this.airborneTime = 0;
          }
          if (speed > 0.8 && this.airborneTime < 0.12) {
            this.stepAccum += speed * deltaTime;
            if (this.stepAccum > 1.7) {
              this.stepAccum = 0;
              this.stepAlt = !this.stepAlt;
              sfx.footstep(this.stepAlt);
              this.scene.spawnDust(player.getWorldPosition(), 1);
            }
          } else if (speed <= 0.8) {
            // Primed so the first step after moving again lands quickly
            this.stepAccum = 1.0;
          }
        }

        // Apply camera input (mouse/touch)
        this.scene.setCameraInput(cameraInput.deltaX, cameraInput.deltaY);

        // Check for nearby interactable and handle interaction.
        // Interpolated values are HTML-escaped: the prompt renders via
        // innerHTML (for the <strong> keycap), and names/bubble text must
        // never become an XSS vector once they turn dynamic (multiplayer).
        const esc = (s: string) =>
          s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const nearby = this.scene.getNearbyInteractable();
        if (nearby) {
          // Show interaction prompt
          let text = '⌨️ Press <strong>E</strong> to interact';
          if (nearby.type === 'mailbox') {
            text = nearby.mailbox.bubbleText ? esc(nearby.mailbox.bubbleText) : text;
          } else if (nearby.type === 'lamp') {
            text = '💡 Press <strong>E</strong> to toggle lamp';
          } else if (nearby.type === 'zone') {
            text = `🎯 Press <strong>E</strong> to explore ${esc(nearby.zone.name)}`;
          } else if (nearby.type === 'npc') {
            text = `💬 Press <strong>E</strong> to talk to <strong>${esc(nearby.npcData.name)}</strong>`;
          } else if (nearby.type === 'bench') {
            text = '🪑 Press <strong>E</strong> to sit down';
          }
          this.ui.showInteractionPrompt(text);

          if (this.inputManager.consumeKeyPress('e')) {
            this.scene.interactWith(nearby);
          }
        } else if (this.multiplayer && this.multiplayer.nearestPeerDistance() < 4) {
          // Another visitor is close: offer a wave
          this.ui.showInteractionPrompt('👋 Press <strong>Q</strong> to wave');
        } else {
          // Hide prompt when not near interactable
          this.ui.hideInteractionPrompt();
        }
      }
    } else {
      // Stop player movement when welcome screen is visible
      this.scene.setPlayerMovement(0, 0);
      this.scene.setCameraInput(0, 0);
    }

    // Quest compass: point at the active delivery's mailbox
    this.updateQuestCompass();

    // Minimap: player + NPCs + plazas + delivery target + online peers
    // (throttled to 10 Hz). Peers come from Multiplayer (GameScene stays
    // decoupled from the network layer), merged in here.
    this.mapAccum += deltaTime;
    if (this.mapAccum > 0.1) {
      this.mapAccum = 0;
      const mapData = this.scene.getMinimapData();
      // Project peers through the same player-centred radar basis getMinimapData
      // just set up (worldToRadar reads the cached basis).
      const peers = this.multiplayer
        ? this.multiplayer.getPeerWorlds().map((p) => ({
            ...this.scene.worldToRadar(p.pos),
            waving: p.waving,
          }))
        : [];
      this.ui.updateMinimap({
        ...mapData,
        peers,
        online: (this.multiplayer ? this.multiplayer.getPeerCount() : 0) + 1,
      });
    }

    // Rain ambience follows the live weather (no-op unless the level changes)
    sfx.setRainLevel(this.scene.getEnvironmentCycle()?.getWeather() === 'rain' ? 1 : 0);

    // Multiplayer: broadcast state, interpolate remote avatars
    this.multiplayer?.update(deltaTime);

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
      this.scene.setGuideTarget(null);
      return;
    }
    const player = this.scene.getPlayer();
    const playerPos = player.getWorldPosition();
    const normal = player.getSurfaceNormal();
    const targetPos = target.destination.mesh.position;

    // Feed the in-world breadcrumb trail the same target as the HUD compass
    this.scene.setGuideTarget(targetPos);

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
   * Open the island shop: buy hats with coins, equip owned ones. The UI
   * re-renders after every action so balances and buttons stay current.
   */
  private openShop(): void {
    const render = () => {
      this.ui.showShop(
        {
          coins: this.scene.getCoinsCollected(),
          items: this.hatCatalog.map((h) => ({
            ...h,
            owned: this.ownedHats.has(h.id),
            equipped: this.equippedHat === h.id,
          })),
        },
        (id) => {
          const item = this.hatCatalog.find((h) => h.id === id);
          if (!item) return;
          if (!this.ownedHats.has(id)) {
            if (!this.scene.spendCoins(item.price)) return;
            this.ownedHats.add(id);
            try {
              localStorage.setItem('ds_owned_hats', JSON.stringify([...this.ownedHats]));
            } catch {
              /* session-only */
            }
            sfx.coin();
          } else {
            sfx.blip();
          }
          this.equippedHat = id;
          try {
            localStorage.setItem('ds_hat', id);
          } catch {
            /* session-only */
          }
          this.scene.equipPlayerHat(id as HatId);
          this.multiplayer?.setHat(id as HatId);
          render();
        },
        () => {
          /* closed */
        },
      );
    };
    render();
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

      console.log('🎵 Generating ambient background music...');

      const ctx = audioManager.ensureCtx();
      const sr = ctx.sampleRate;
      const duration = 120;
      const N = sr * duration;
      const buffer = ctx.createBuffer(2, N, sr);

      // --- Musical constants ---
      const TAU = 2 * Math.PI;
      // Pentatonic scale frequencies (C major pentatonic across two octaves)
      const NOTE = {
        C3: 130.81, D3: 146.83, E3: 164.81, G3: 196.00, A3: 220.00,
        C4: 261.63, D4: 293.66, E4: 329.63, G4: 392.00, A4: 440.00,
        C5: 523.25, E5: 659.25, G5: 783.99,
      };

      // Chord progression: 10s per chord, cycles every 40s
      const chords = [
        { bass: NOTE.C3, tones: [NOTE.C4, NOTE.E4, NOTE.G4] },        // Cmaj
        { bass: NOTE.A3 * 0.5, tones: [NOTE.A3, NOTE.C4, NOTE.E4] },  // Am
        { bass: NOTE.G3 * 0.5, tones: [NOTE.G3, NOTE.D4, NOTE.G4] },  // G5sus
        { bass: NOTE.C3, tones: [NOTE.E4, NOTE.G4, NOTE.C5] },        // Cmaj (inv)
      ];
      const chordDur = 10;

      // Melody: sequence of pentatonic notes with timing
      const melodyNotes = [
        NOTE.E4, NOTE.G4, NOTE.A4, NOTE.G4, NOTE.E4, NOTE.C4, NOTE.D4, NOTE.E4,
        NOTE.G4, NOTE.C5, NOTE.A4, NOTE.G4, NOTE.E4, NOTE.D4, NOTE.C4, NOTE.E4,
        NOTE.A4, NOTE.G4, NOTE.E4, NOTE.G4, NOTE.C5, NOTE.A4, NOTE.G4, NOTE.E4,
      ];
      const melNoteDur = 2.5;

      // Soft waveform: sine with a touch of 2nd harmonic for warmth
      const soft = (phase: number) =>
        Math.sin(phase) * 0.85 + Math.sin(phase * 2) * 0.12 + Math.sin(phase * 3) * 0.03;

      // ADSR envelope
      const env = (t: number, atk: number, dec: number, sus: number, rel: number, total: number) => {
        if (t < 0 || t > total) return 0;
        if (t < atk) return t / atk;
        if (t < atk + dec) return 1 - (1 - sus) * ((t - atk) / dec);
        if (t < total - rel) return sus;
        return sus * (1 - (t - (total - rel)) / rel);
      };

      // Seeded PRNG for deterministic variation
      let seed = 42;
      const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };

      // Schedule bird chirps (2-note warbles)
      const chirps: { start: number; f1: number; f2: number; dur: number }[] = [];
      for (let s = 2; s < duration; s++) {
        if (rand() < 0.04) {
          const f1 = 2200 + rand() * 1600;
          chirps.push({
            start: (s + rand()) * sr,
            f1,
            f2: f1 * (1.2 + rand() * 0.3),
            dur: (0.08 + rand() * 0.12) * sr,
          });
        }
      }

      for (let ch = 0; ch < 2; ch++) {
        const d = buffer.getChannelData(ch);
        let lp = 0;
        const panShift = ch === 0 ? 0 : 0.4;

        for (let i = 0; i < N; i++) {
          const t = i / sr;

          // --- Chord pad: warm triangle blend, breathing ---
          const chordIdx = Math.floor((t / chordDur) % chords.length);
          const chordT = (t / chordDur) % 1;
          const chord = chords[chordIdx];
          const breathe = 0.4 + 0.6 * Math.sin(t * 0.15 + panShift) ** 2;
          let padVal = soft(t * chord.bass * TAU) * 0.3;
          for (let ci = 0; ci < chord.tones.length; ci++) {
            const detune = 1 + (ci * 0.001 + panShift * 0.002);
            padVal += soft(t * chord.tones[ci] * detune * TAU + ci * 0.5) * 0.2;
          }
          // Crossfade between chords at boundaries
          const xfade = chordT < 0.08 ? chordT / 0.08 : chordT > 0.92 ? (1 - chordT) / 0.08 : 1;
          padVal *= breathe * xfade;

          // --- Melody: pentatonic notes with soft envelope ---
          const melIdx = Math.floor(t / melNoteDur) % melodyNotes.length;
          const melT = (t % melNoteDur);
          const melFreq = melodyNotes[melIdx];
          const melEnv = env(melT, 0.6, 0.4, 0.5, 0.8, melNoteDur);
          const melVal = soft(t * melFreq * TAU + panShift * 1.2) * melEnv;

          // --- Arpeggio sparkle: high notes on beat subdivisions ---
          const arpPeriod = 3.33;
          const arpT = t % arpPeriod;
          const arpIdx = Math.floor(t / arpPeriod) % 3;
          const arpFreqs = [NOTE.C5, NOTE.E5, NOTE.G5];
          const arpEnv = env(arpT, 0.02, 0.3, 0.15, 1.5, arpPeriod);
          const arpVal = Math.sin(t * arpFreqs[arpIdx] * TAU) * arpEnv;

          // --- Subtle wind bed ---
          const raw = (Math.random() - 0.5) * 2;
          const cutoff = 160 + 40 * Math.sin(t * 0.04 + ch);
          const alpha = 1 / (1 + sr / (TAU * cutoff));
          lp += alpha * (raw - lp);
          const wind = lp * (0.2 + 0.1 * Math.sin(t * 0.07));

          // --- Bird warble ---
          let birdVal = 0;
          for (const c of chirps) {
            const rel = i - c.start;
            if (rel >= 0 && rel < c.dur) {
              const p = rel / c.dur;
              const bEnv = Math.sin(p * Math.PI) * 0.15;
              const freq = c.f1 + (c.f2 - c.f1) * Math.sin(p * Math.PI * 3);
              birdVal += Math.sin(rel / sr * freq * TAU) * bEnv;
            }
          }

          // --- Mix ---
          d[i] = padVal * 0.045 + melVal * 0.05 + arpVal * 0.025 + wind * 0.02 + birdVal * 0.03;
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
