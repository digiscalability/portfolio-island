import { inject } from '@vercel/analytics';
import * as THREE from 'three';

import { a11y } from './Accessibility';
import { startDwellTracking, track, trackOnce } from './Analytics';
import { applyCelShadowPatch } from './CelLook';
import { Chat, PROXIMITY_RADIUS } from './Chat';
import { DeliverySystem } from './DeliverySystem';
import { DISTRICTS } from './Districts';
import { featuredSell, saleSplit, type ProviderKey } from './economy';
import { EnvironmentCycle } from './EnvironmentCycle';
import { GameScene } from './GameScene';
import { HudLabels, type BubbleCandidate } from './HudLabels';
import { expDecay, expDecayV3, tick as juiceTick } from './Juice';
import { Multiplayer } from './Multiplayer';
import { askNpc, askNpcOpening, composeAwareGreeting, isAiNpc, voiceProfileFor } from './NpcChat';
import { NpcQuestSystem } from './NpcQuests';
import { Passport, PASSPORT_META, PASSPORT_ZONES, type PassportZone } from './Passport';
import {
  coinAdoptValue,
  inventoryAdoptValue,
  mealsAdoptValue,
  mergeLessons,
  mergeTools,
  vaultOp,
  loadProfile,
  saveProfile,
} from './profileSync';
import { SECRETS, Secrets } from './Secrets';
import { sfx } from './Sfx';
import { decodePostcardPose } from './Share';
import { SimpleInputManager, consumePinchZoomFactor } from './SimpleInputManager';
import type { BodyPart, HatId } from './SimplePlayer';
import { SimpleRenderer } from './SimpleRenderer';
import { SimpleUI } from './SimpleUI';
import { applySoftLookFogPatch } from './SoftLook';
import { cancelSpeech } from './Speech';
import { isRealTheme } from './Theme';
import { placeBench, subscribeBenches } from './worldBenches';
import { BUILD_KIND_IDS, placeBuild, removeBuild, subscribeBuilds } from './worldBuilds';
import { WORLD_ERA } from './WorldScale';
import { connectWorldState, getWorldState, moodNpcFlavor, MOOD_META } from './WorldState';

import './style.css';

// Analytics MUST fire at module evaluation, not after the world boots: the old
// idle-deferred inject meant every visitor who bounced during the loading
// screen (or hit the WebGL fallback) was invisible — the top of the funnel was
// unmeasured. inject() is cookieless and failure-safe; custom events stay lazy.
try {
  inject({ mode: import.meta.env.PROD ? 'production' : 'development' });
} catch {
  /* ad-blocker / offline — never let analytics break the app */
}

// Capture the entry context ONCE for lead attribution: which channel and
// campaign produced this session. Read back by Boards.submitLead so the lead
// email can say "came from the Show HN link" instead of arriving anonymous.
try {
  if (!sessionStorage.getItem('ds_entry')) {
    const sp = new URLSearchParams(location.search);
    const utm: Record<string, string> = {};
    for (const k of ['utm_source', 'utm_medium', 'utm_campaign']) {
      const v = sp.get(k);
      if (v) utm[k] = v.slice(0, 60);
    }
    sessionStorage.setItem(
      'ds_entry',
      JSON.stringify({ ref: document.referrer.slice(0, 200), utm, t: Date.now() }),
    );
  }
} catch {
  /* no storage — attribution is best-effort */
}

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
  private chat?: Chat;
  // Hybrid DOM bubble labels (mobile-HUD Round 3 P5) + reusable per-frame pools
  private hudLabels: HudLabels | null = null;
  private readonly hudCandidates: BubbleCandidate[] = [];
  private readonly hudScratch: THREE.Vector3[] = [];
  private isRunning: boolean = false;
  // "Meet the AI townsfolk" compass override (welcome CTA → cleared on AI chat)
  private aiGuideTarget: THREE.Vector3 | null = null;
  // Island-map pick: explicit user intent, outranks every other compass
  // source; cleared on arrival (<6u) or a fresh pick.
  private mapGuideTarget: THREE.Vector3 | null = null;
  private mapGuideLabel = '';
  // "Beat the lap record" CTA → compass points at the start gate until a race starts
  private raceGuideTarget: THREE.Vector3 | null = null;

  // Tour mode: a skippable cinematic rail over the districts for the visitor
  // who won't touch WASD (the Breton camera-rail pattern from the audit).
  // While active the orbit camera is suspended and this drives the scene
  // camera directly; the world (NPCs, sea, activities) keeps living.
  private tour: {
    stops: Array<{
      caption: string;
      look: THREE.Vector3; // surface point the camera studies
      dir: THREE.Vector3; // camera position direction (unit, from planet centre)
      r: number; // camera position radius
    }>;
    idx: number;
    t: number;
    phase: 'fly' | 'dwell';
    fromDir: THREE.Vector3;
    fromR: number;
    fromLook: THREE.Vector3;
  } | null = null;
  // Tour scratch (kept allocation-free per frame)
  private readonly _tourDir = new THREE.Vector3();
  private readonly _tourLook = new THREE.Vector3();
  private readonly _tourUp = new THREE.Vector3();
  private readonly _tourAxis = new THREE.Vector3();
  private readonly _tourQ = new THREE.Quaternion();

  // Completion meter recompute throttle (localStorage reads are cheap; 2.5s
  // keeps the pill fresh without touching storage every frame)
  private completionAccum = 0;

  // Island shop (hat cosmetics, paid with meadow coins)
  private readonly hatCatalog: Array<{ id: HatId; icon: string; name: string; price: number }> = [
    { id: 'cap', icon: '🧢', name: 'Explorer Cap', price: 8 },
    { id: 'party', icon: '🥳', name: 'Party Hat', price: 10 },
    { id: 'flower', icon: '🌸', name: 'Flower Crown', price: 12 },
    { id: 'chef', icon: '👨‍🍳', name: "Chef's Toque", price: 14 },
    { id: 'top', icon: '🎩', name: 'Top Hat', price: 15 },
    { id: 'headphones', icon: '🎧', name: 'Headphones', price: 16 },
    { id: 'pirate', icon: '🏴‍☠️', name: 'Pirate Hat', price: 18 },
    { id: 'wizard', icon: '🧙', name: 'Wizard Hat', price: 20 },
    { id: 'crown', icon: '👑', name: 'Golden Crown', price: 25 },
    { id: 'halo', icon: '😇', name: 'Halo', price: 40 },
  ];
  // Consumables: re-buyable and spent by use, unlike hats (owned once, then
  // equipped). Charges persist locally and in the cloud profile.
  private static readonly AXE_ID = 'woodaxe';
  private static readonly AXE_PRICE = 60;
  private static readonly TIMBER_SELL_PRICE = 5;
  private static readonly TIMBER_SATIATED_PRICE = 1;
  private static readonly DAILY_SELL_CAP = 10; // icebox + timber rack satiation
  // Harvest loop (wave 3): sickle cuts crops at the farm; wheat goes to the
  // Baker (two-stop route pays more), veg to the canteen cart. Produce priced
  // BELOW fish so the densest loop can't dominate (merge ruling K1).
  private static readonly SICKLE_ID = 'harvestsickle';
  private static readonly SICKLE_PRICE = 25;
  private static readonly WHEAT_SELL_PRICE = 4;
  private static readonly WHEAT_SATIATED_PRICE = 1;
  private static readonly PRODUCE_SELL_PRICE = 2;
  private static readonly PRODUCE_SATIATED_PRICE = 1;
  private ownedSickle = false;
  private wheat = 0;
  private produce = 0;
  // Mining loop (wave 3): pickaxe cracks highland ore veins; the bank assays
  // ore — a resource with satiation, never raw coins at the rock.
  private static readonly PICKAXE_ID = 'pickaxe';
  private static readonly PICKAXE_PRICE = 80;
  private static readonly ORE_SELL_PRICE = 5;
  private static readonly ORE_SATIATED_PRICE = 1;
  private ownedPickaxe = false;
  private ore = 0;
  // Construction catalog costs (timber + coins), keyed by BUILD_PLOTS kind.
  private static readonly BUILD_COSTS: Record<
    'bench' | 'signpost' | 'lantern' | 'gazebo' | 'planter' | 'campfire',
    { timber: number; coins: number; icon: string; name: string }
  > = {
    bench: { timber: 4, coins: 10, icon: '🪑', name: 'bench' },
    signpost: { timber: 3, coins: 5, icon: '🪧', name: 'signpost' },
    lantern: { timber: 8, coins: 15, icon: '🏮', name: 'lantern' },
    gazebo: { timber: 20, coins: 40, icon: '⛩️', name: 'gazebo' },
    planter: { timber: 3, coins: 5, icon: '🌸', name: 'planter' },
    campfire: { timber: 6, coins: 12, icon: '🔥', name: 'campfire' },
  };
  /** My own cloud builds: plot → slot, maintained from the subscribe stream
   *  (`own` flag) + placeBuild acks. Cloud is truth on a fresh device. */
  private ownBuilds = new Map<number, number>();
  private timberSellArmedAt = 0;
  private freshBuildToasts = 0;
  private ownedAxe = false;
  private lessons: string[] = [];
  private vaultBusy = false;
  private static readonly LESSONS: Array<[string, string]> = [
    [
      'move',
      '🏃 Lesson 1 — WASD or the joystick to walk; Space to jump. The island is round: keep walking and you come home.',
    ],
    [
      'fish',
      '🎣 Lesson 2 — buy the rod at the shop, stand at any shore, E to cast. Reel when the float dips.',
    ],
    [
      'chop',
      '🪓 Lesson 3 — the axe fells trees in three swings. Timber sells at the carpenter. Stumps regrow.',
    ],
    [
      'feed',
      '🌾 Lesson 4 — feeds from the shop call nearby birds, cats or fish. They remember kindness.',
    ],
    [
      'chat',
      '💬 Lesson 5 — walk up to any villager and press E. Two dozen of them will really talk with you.',
    ],
    [
      'build',
      '🔨 Lesson 6 — hammer-stakes mark free plots. Chop timber, bring coins, press E at a stake to raise something everyone sees — forever.',
    ],
  ];
  private timber = 0;
  private static readonly ROD_ID = 'fishingrod';
  private static readonly ROD_PRICE = 40;
  private static readonly FISH_SELL_PRICE = 3;
  private static readonly FISH_SATIATED_PRICE = 1;
  // Local truth like the feed consumables (LOCAL-STATE law: never max-merge a
  // consumable from the cloud). Rod is a boolean own-flag; fish are inventory.
  private ownedRod = false;
  private fishCaught = 0;
  private static readonly BIRD_FEED_ID = 'birdfeed';
  private static readonly BIRD_FEED_PRICE = 6;
  private static readonly BIRD_FEED_CHARGES = 5;
  private birdFeed = 0;
  /** True once this device owns a feed count, so the cloud can't re-grant. */
  private hasLocalBirdFeed = false;
  private static readonly CAT_FEED_ID = 'catfeed';
  private static readonly CAT_FEED_PRICE = 6;
  private static readonly CAT_FEED_CHARGES = 5;
  private catFeed = 0;
  private hasLocalCatFeed = false;
  private static readonly FISH_FEED_ID = 'fishfeed';
  private static readonly FISH_FEED_PRICE = 6;
  private static readonly FISH_FEED_CHARGES = 5;
  private fishFeed = 0;
  private hasLocalFishFeed = false;
  // Cooked-food consumables (wave 5): BUY at a provider, press G to EAT —
  // restores a fraction of the 0..1 stamina bar. Coin SINK only (never sold),
  // and a Consumable-Law localStorage item: adopt-once from the cloud, NEVER
  // max-merged (max-merge would refund every meal eaten).
  private static readonly SOUP_PRICE = 3;
  private static readonly FISHMEAL_PRICE = 5;
  private static readonly PIE_PRICE = 8;
  private static readonly MEAL_STAMINA = { soup: 0.45, fish: 0.65, pie: 1.0 } as const;
  private meals = { pie: 0, fish: 0, soup: 0 };
  /** Drown fee buffered between onDrownFee and the respawn flash (one message). */
  private pendingDrownFee = 0;
  private hasLocalMeals = false;
  /** True once this device owns a raw-inventory record (blocks cloud adopt). */
  private hasLocalInventory = false;
  // Daily special: one provider pays a premium today (rotates by date; market
  // day lifts it 2→2.5). Boosts ONLY the full price so the faucet stays capped.
  private featured: { provider: ProviderKey | ''; mult: number } = { provider: '', mult: 2 };
  private ownedHats: Set<string> = new Set();
  private equippedHat: string | null = null;
  private passport: Passport | null = null;

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
  private prevWalkPhase: number = -1; // last sampled walk-cycle phase (-1 = stride inactive)
  private airborneTime: number = 0;
  private prevJumpHeld: boolean = false;
  private lastSwimWarnAt = 0; // throttle for the shoreline-barrier hint
  private currentThrottle = 0; // last vehicle throttle magnitude (for engine sfx)

  // Scratch vectors reused every frame to keep the update loop allocation-free
  // (mobile minor-GC hitch reduction). Never hold a reference to these across
  // frames — each consumer copies into them fresh before use.
  private readonly _listenerPos = new THREE.Vector3();
  private readonly _listenerFwd = new THREE.Vector3();
  private readonly _listenerUp = new THREE.Vector3(0, 1, 0);
  private readonly _qcPlayerPos = new THREE.Vector3();
  private readonly _qcNormal = new THREE.Vector3();
  private readonly _qcToTarget = new THREE.Vector3();
  private readonly _qcCamFwd = new THREE.Vector3();
  private readonly _qcCross = new THREE.Vector3();
  private readonly _qcTmp = new THREE.Vector3();

  private boundHandlers: {
    beforeUnload?: () => void;
    debugKeydown?: (event: KeyboardEvent) => void;
    chatKeydown?: (event: KeyboardEvent) => void;
    chatKeyup?: (event: KeyboardEvent) => void;
    mutePointerDown?: (event: PointerEvent) => void;
    mutePointerUp?: (event: PointerEvent) => void;
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

      // Global shader-chunk patches, BEFORE any material compiles — the
      // program cache never rebuilds compiled ones. Cel shadow edges for the
      // default cel theme; the ?look=soft fog experiment for ?theme=real.
      applyCelShadowPatch();
      applySoftLookFogPatch();

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

      // Accessibility prefs (reduced motion) — seed before anything animates
      a11y.init();

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

      // Create scene (this will also create planet and player).
      // performance.mark bracketing: `world_gen` is the long synchronous block
      // (the GameScene constructor runs Island + all placement inline) — the
      // number to watch when tuning boot. Inspect via
      // performance.getEntriesByType('measure') in the console.
      performance.mark('boot:worldgen-start');
      this.scene = new GameScene();
      performance.mark('boot:worldgen-end');
      performance.measure('world_gen', 'boot:worldgen-start', 'boot:worldgen-end');
      // The interior window renders the island into a texture, so the scene
      // needs the WebGLRenderer. Structural handoff — no import either way.
      this.scene.setRendererRef(this.renderer);
      this.ui.showLoading(60);
      await this.scene.ready();
      performance.mark('boot:scene-ready');
      performance.measure('scene_ready', 'boot:worldgen-start', 'boot:scene-ready');
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
        track('quest_completed', { id: quest.id });
        // Finale: finishing all ten deliveries makes good on the NPC's promise
        // ("unlock something special") — grant the rare 😇 Halo + 25 coins, once.
        if (this.deliverySystem.isAllComplete()) {
          track('delivery_all_complete');
          this.grantCourierReward();
        }
      });

      // Pickup ding + analytics on every completed delivery
      this.deliverySystem.setOnDeliveryComplete((d) => {
        sfx.collect();
        track('delivery_completed', {
          id: d.id,
          count: this.deliverySystem.getCompletedCount(),
        });
      });

      // Walking up to a zone building + E now STEPS INSIDE it (3D interior) and
      // shows the content over the room. Proximity is still the only path that
      // stamps the passport. (Menu/deep-link opens still just show the panel.)
      this.scene.setOnZoneInteract((zone) => {
        console.log(`🎯 Entering zone: ${zone.name}`);
        this.enterBuilding(zone.id, true, zone);
      });
      // Cottage doors: walk up + E → step inside a cosy room.
      this.scene.setOnHouseEnter((id) => {
        // The beach house has a coded lock (a mechanic, not security — the
        // code ships client-side). Unlocks stay for the session.
        if (id.startsWith('islet_') && !this.isletUnlocked) {
          this.ui.showPinPad('5673', () => {
            this.isletUnlocked = true;
            sfx.collect();
            this.enterBuilding(id, false);
          });
          return;
        }
        this.enterBuilding(id, false);
      });

      // NPC quests: stateful dialogue + rewards layered over ambient lines
      this.npcQuests = new NpcQuestSystem();
      this.scene.setQuestMarkers(this.npcQuests.getGiverNamesWithAvailableQuests());

      // Restore the shop wardrobe (owned + equipped hats) + consumables
      try {
        this.ownedHats = new Set(JSON.parse(localStorage.getItem('ds_owned_hats') ?? '[]'));
        this.equippedHat = localStorage.getItem('ds_hat');
        if (this.equippedHat) this.scene.equipPlayerHat(this.equippedHat as HatId);
      } catch {
        /* fresh wardrobe */
      }
      try {
        const raw = localStorage.getItem('ds_bird_feed');
        this.hasLocalBirdFeed = raw !== null;
        this.ownedRod = localStorage.getItem('ds_rod') === '1';
        this.ownedAxe = localStorage.getItem('ds_axe') === '1';
        this.lessons = mergeLessons(
          [],
          JSON.parse(localStorage.getItem('ds_lessons') ?? '[]') as unknown,
        );
        this.timber = Math.max(0, parseInt(localStorage.getItem('ds_timber') ?? '0', 10) || 0);
        this.ownedSickle = localStorage.getItem('ds_sickle') === '1';
        this.wheat = Math.max(0, parseInt(localStorage.getItem('ds_wheat') ?? '0', 10) || 0);
        this.produce = Math.max(0, parseInt(localStorage.getItem('ds_produce') ?? '0', 10) || 0);
        this.ownedPickaxe = localStorage.getItem('ds_pickaxe') === '1';
        this.ore = Math.max(0, parseInt(localStorage.getItem('ds_ore') ?? '0', 10) || 0);
        this.fishCaught = Math.max(
          0,
          parseInt(localStorage.getItem('ds_fish_caught') ?? '0', 10) || 0,
        );
        this.birdFeed = Math.max(0, parseInt(raw ?? '0', 10) || 0);
        const rawCat = localStorage.getItem('ds_cat_feed');
        this.hasLocalCatFeed = rawCat !== null;
        this.catFeed = Math.max(0, parseInt(rawCat ?? '0', 10) || 0);
        const rawFish = localStorage.getItem('ds_fish_feed');
        this.hasLocalFishFeed = rawFish !== null;
        this.fishFeed = Math.max(0, parseInt(rawFish ?? '0', 10) || 0);
        // Any raw-inventory key present = this device already has a record,
        // so the cloud must not re-grant (Consumable Law).
        //
        // THIS MUST RUN BEFORE THE ds_meals PARSE BELOW. It used to sit after
        // it, inside the same try: a corrupt ds_meals blob threw in
        // JSON.parse, control jumped to the catch, and this assignment never
        // ran — leaving hasLocalInventory at its `false` default. syncProfile
        // then saw "no local record", passed inventoryAdoptValue's guard, and
        // OVERWROTE the fish/timber/wheat/produce/ore loaded twenty lines
        // earlier with the cloud basket. One bad meals blob refunded every
        // resource sold since the last cloud push.
        this.hasLocalInventory = [
          'ds_fish_caught',
          'ds_timber',
          'ds_wheat',
          'ds_produce',
          'ds_ore',
        ].some((k) => localStorage.getItem(k) !== null);
        const rawMeals = localStorage.getItem('ds_meals');
        this.hasLocalMeals = rawMeals !== null;
        // Own try: a corrupt blob must cost only the meals, never the flags
        // set above it.
        if (rawMeals) {
          try {
            Object.assign(this.meals, JSON.parse(rawMeals));
          } catch {
            /* keep the zeroed defaults; hasLocalMeals stays true so the
               cloud does not re-grant meals either */
          }
        }
      } catch {
        this.birdFeed = 0;
      }
      this.refreshFeedHud();

      // Restore saved body colours (applied now; re-applied when the GLTF loads)
      try {
        const stored = JSON.parse(localStorage.getItem('ds_appearance') ?? '{}') as Record<
          string,
          string
        >;
        const player = this.scene.getPlayer();
        for (const key of Object.keys(stored)) {
          const hex = parseInt(stored[key].replace('#', ''), 16);
          if (Number.isFinite(hex)) player?.setBodyColor(key as BodyPart, hex);
        }
      } catch {
        /* default colours */
      }

      // Multiplayer: other visitors on the same island, waves included
      this.multiplayer = new Multiplayer(this.scene, this.scene.getPlayer());
      this.multiplayer.onCount((count) => this.ui.updatePlayerCount(count));
      this.multiplayer.setHat((this.equippedHat as HatId) ?? null);

      // Proximity chat: text bubbles + push-to-talk voice between nearby
      // visitors. Wired to the mobile chat/mic HUD buttons and to
      // Enter/V(oice) on desktop (see setupDebugShortcuts-adjacent binding
      // below, near the input manager setup).
      this.chat = new Chat(this.multiplayer);
      // DOM twins live in the overlay so photo mode hides them for free.
      this.hudLabels = new HudLabels(this.ui.getOverlay());
      // Expandable island map: tap the radar (or press M) for the full map.
      this.ui.setOnMinimapClick(() => this.openIslandMap());
      this.ui.setOnOpenMap(() => this.openIslandMap());
      this.ui.setVoiceSupported(this.chat.voiceSupported);
      this.multiplayer.setChatHandler((msg) => this.chat?.onWire(msg));
      this.ui.setOnChatSend((text) => this.chat?.sendText(text));
      this.ui.setOnMicDown(() => void this.chat?.startRecording());
      this.ui.setOnMicUp(() => this.chat?.stopRecording());
      // Show the "● Recording Xs" indicator only while the mic is truly live.
      this.chat.setOnRecordingStart(() => this.ui.showRecordingIndicator());
      this.chat.setOnRecordingStop(() => this.ui.hideRecordingIndicator());

      // Portfolio Passport: visiting all four work zones unlocks the Founder's
      // Golden Crown — the mechanic that routes explorers through the real work.
      this.passport = new Passport();
      this.passport.setOnComplete(() => this.grantPassportReward());
      this.ui.setPassport(this.passport);

      // Roster: click the online-count to see who's here and mute per peer.
      this.ui.setRosterProvider(() => this.multiplayer?.getPeerList() ?? []);
      this.ui.setOnPeerMuteToggle((id) => {
        const muted = this.chat?.toggleMute(id) ?? false;
        this.multiplayer?.setPeerMuted(id, muted);
        return muted;
      });

      // Tap a peer (their avatar or name) to mute/unmute them. A tap is
      // distinguished from a camera-orbit drag by small movement + short time,
      // so it coexists with OrbitCamera's own pointer handling on the canvas.
      const muteCanvas = document.getElementById('game-canvas');
      if (muteCanvas) {
        let tapX = 0;
        let tapY = 0;
        let tapT = 0;
        this.boundHandlers.mutePointerDown = (e: PointerEvent) => {
          tapX = e.clientX;
          tapY = e.clientY;
          tapT = performance.now();
        };
        this.boundHandlers.mutePointerUp = (e: PointerEvent) => {
          if (this.ui.isChatInputOpen()) return;
          if (Math.hypot(e.clientX - tapX, e.clientY - tapY) > 6) return; // was a drag
          if (performance.now() - tapT > 400) return; // was a long-press
          const hits = this.scene.rayCastFromCamera(e.clientX, e.clientY);
          for (const h of hits) {
            const id = this.multiplayer?.peerIdForObject(h.object);
            if (!id) continue;
            const muted = this.chat?.toggleMute(id) ?? false;
            this.multiplayer?.setPeerMuted(id, muted);
            const name = this.multiplayer?.getPeerName(id) ?? 'player';
            this.ui.toast(`${muted ? '🔇 Muted' : '🔊 Unmuted'} ${name}`);
            break; // only the nearest peer under the tap
          }
        };
        muteCanvas.addEventListener('pointerdown', this.boundHandlers.mutePointerDown);
        muteCanvas.addEventListener('pointerup', this.boundHandlers.mutePointerUp);
      }

      // Setup NPC interaction callback (quest dialogue wins when relevant)
      this.scene.setOnNPCInteract((npcData) => {
        console.log(`💬 Talking to: ${npcData.name}`);
        // The Market Vendor runs the island shop.
        if (npcData.name === 'Market Vendor') {
          sfx.blip();
          this.openShop();
          return;
        }
        // Quest steps take PRIORITY over idle chat, so a quest-giver still gives
        // its quest (and fetch pickups / completions still fire) even though it
        // is also an AI NPC. When it has no active quest step, it falls through
        // to free-text chat below.
        const talk = this.npcQuests.onTalk(npcData.name, this.scene.getCoinsCollected());
        if (talk) {
          this.ui.showDialogue(npcData.name, talk.lines);
          this.beginNpcDialogue(npcData.name);
          if (talk.accepted) {
            sfx.blip();
            this.scene.setQuestMarkers(this.npcQuests.getGiverNamesWithAvailableQuests());
          }
          // Fetch quest: picked the fish up at the Fisherman — carry it in hand
          if (talk.pickedUp) {
            sfx.collect();
            this.scene.setPlayerCarryingFish(true);
          }
          if (talk.completed) {
            const q = talk.completed;
            // Delivering the fish → the Baker bakes it into a pie before your eyes
            if (q.id === 'baker_catch') this.scene.deliverFishToBaker();
            this.scene.addCoins(q.rewardCoins);
            sfx.questComplete();
            this.ui.showQuestComplete({
              name: `${q.giverName}'s request`,
              reward: { type: 'message', value: `+${q.rewardCoins} 🪙 reward` },
            } as any);
            this.scene.setQuestMarkers(this.npcQuests.getGiverNamesWithAvailableQuests());
          }
          return;
        }
        // No active quest for this NPC → intelligent free-text conversation if it
        // has a brain wired up. On ANY failure (function/App Check/rate/spend
        // cap/moderation/offline) askNpc returns a fallback and we cycle the
        // NPC's authored canned lines, so the NPC never appears broken.
        if (isAiNpc(npcData.name)) {
          this.aiGuideTarget = null; // meet-the-townsfolk guide fulfilled
          this.markDone('ds_npc_chatted');
          sfx.blip();
          const canned = npcData.dialogue;
          let ci = 1; // first fallback skips the opening line (canned[0])
          // Aware opening: same live-state composition as the proximity bubble
          // (planner-assigned activity + hour + day-theme), so the walk-up line
          // and the conversation flow as one — no more static canned[0].
          const aware = composeAwareGreeting({
            activity: this.scene.getNpcActivity(npcData.name),
            hour: this.scene.getEnvironmentCycle()?.getHour() ?? 12,
            event: getWorldState()?.npcPlan?.event,
          });
          this.ui.showNpcChat(
            npcData.name,
            aware || canned[0] || 'Hello, traveller.',
            async (text) => {
              track('npc_chat_sent', { npc: npcData.name });
              const res = await askNpc(npcData.name, text);
              if (res.reply && !res.fallback) return res.reply;
              return canned[ci++ % canned.length] ?? '…';
            },
            voiceProfileFor(npcData.name),
          );
          this.beginNpcDialogue(npcData.name);
          // Deepen the opening in the background: the composed line shows
          // instantly; when the persona's generated continuation arrives the
          // NPC simply keeps talking. Failures resolve silently — the
          // composed opening already stands on its own.
          // NPC memory: visitor facts ride the LLM-ONLY copy of the greeting
          // (the displayed bubble stays clean) — the model naturally works
          // "back after three days, still in that crown" into its reply.
          // Facts are data inside the greeting quote, within the 300-char cap.
          void askNpcOpening(npcData.name, this.withVisitorFacts(aware)).then((res) => {
            if (res.reply && !res.fallback) {
              this.ui.appendNpcChatLine(npcData.name, res.reply);
            }
          });
          return;
        }
        // Non-AI, non-quest NPC → canned dialogue, led by a living-world mood line.
        let lines = npcData.dialogue;
        const flavor = moodNpcFlavor();
        if (flavor) lines = [flavor, ...lines];
        this.ui.showDialogue(npcData.name, lines);
        this.beginNpcDialogue(npcData.name);
      });
      // Release the hold + camera the moment the chat panel closes by any
      // path (✕, Escape, replaced by a new chat) — the per-frame poll below
      // is the belt for the canned-dialogue panel, this is the braces.
      this.ui.setOnNpcChatClosed(() => this.endNpcDialogue());

      // Living world: subscribe to the server-owned world/island beat (a mood +
      // pre-authored headline the scheduled director evolves every few hours).
      // Surface it as a bulletin banner; it also colours NPC tone via
      // moodNpcFlavor() above. Degrades to silence if the backend/beat is
      // absent (e.g. before the director is deployed). ?mood=festive previews.
      // Today's special from the local date first (works with zero backend).
      this.refreshFeatured(false);
      connectWorldState((s) => {
        this.ui.showWorldBulletin(s.headline, MOOD_META[s.mood].accent);
        track('world_beat_seen', { mood: s.mood });
        // Market day (world beat) lifts the special's premium 2 → 2.5.
        if (s.npcPlan?.event === 'market_day') this.refreshFeatured(true);
        // Hand the day's NPC assignments to the activity engine (Phase 2).
        if (s.npcPlan) this.scene.setNpcActivities(s.npcPlan);
        // Feed the "Island Times" board its notice + plan + past editions.
        // Cached lazily — the board reads it only when the visitor opens it.
        this.ui.setIslandTimes(s.notice ?? null, s.npcPlan ?? null, s.noticeArchive ?? null);
      });

      // Restore the carried fish if a fetch quest was mid-delivery on reload
      if (this.npcQuests.isCarryingFetchItem()) {
        this.scene.setPlayerCarryingFish(true);
      }

      // Environment badge: weather · time of day · place
      this.scene.getEnvironmentCycle()?.onStatus((status) => {
        this.ui.setEnvironmentBadge(status);
      });

      // Live weather is opt-in (it shares approximate location) — the badge is
      // the consent gate. Day/night runs off the device clock regardless.
      this.ui.setWeatherConsentHandler(EnvironmentCycle.hasWeatherConsent(), (on) => {
        this.scene.getEnvironmentCycle()?.setWeatherConsent(on);
        this.ui.flashMessage(on ? '🌦️ Live weather on' : '🌤️ Live weather off');
      });

      // Photo mode: capture the next rendered frame, brand it, preview it.
      this.ui.setOnPhotoRequest(() => this.capturePhoto());

      // ?hour= override: let a shared link show the island at a chosen time so
      // daytime visitors can see the night art (stars/moon/fireflies/windows).
      this.applyHourParam();

      // First-ever visit lands in golden daylight regardless of local clock:
      // an evening recruiter used to land on a near-black island that looked
      // nothing like the sunny OG card they clicked. One session only — the
      // live clock (and the night art) takes over from the second visit; an
      // explicit ?hour= share link always wins.
      try {
        const env = this.scene.getEnvironmentCycle();
        if (env && env.debugHour === null && !localStorage.getItem('ds_visited')) {
          localStorage.setItem('ds_visited', '1');
          env.debugHour = 10.5;
        }
      } catch {
        /* no storage */
      }

      // Last-seen heartbeat: read the PREVIOUS visit's timestamp before
      // overwriting, then keep it fresh (60s interval + pagehide) so even a
      // crashed tab records roughly when the visit ended. Powers the
      // "while you were away" welcome delta; mirrored to the cloud profile
      // (latest-wins) by syncProfile for future cross-device use.
      try {
        this.prevSeenAt = parseInt(localStorage.getItem('ds_last_seen') ?? '', 10) || 0;
        const beat = () => {
          try {
            localStorage.setItem('ds_last_seen', String(Date.now()));
          } catch {
            /* no storage */
          }
        };
        beat();
        window.setInterval(beat, 60_000);
        window.addEventListener('pagehide', beat);
        // Daily date-stamp: one entry per distinct day (no-punishment streak —
        // the journal celebrates presence, never scolds absence).
        const today = new Date().toISOString().slice(0, 10);
        const days: string[] = JSON.parse(localStorage.getItem('ds_visit_days') ?? '[]');
        if (!days.includes(today)) {
          days.push(today);
          localStorage.setItem('ds_visit_days', JSON.stringify(days.slice(-120)));
          const ledger = this.visitLedger();
          if (ledger.streak >= 2) {
            window.setTimeout(
              () => this.ui.toast(`📅 Day ${ledger.streak} in a row — the island kept a light on.`),
              6000,
            );
          }
        }
      } catch {
        /* no storage */
      }

      // Coin counter (persisted across visits + mirrored to the cloud profile)
      this.ui.updateCoinCounter(this.scene.getCoinsCollected());
      this.scene.setOnCoinCollected((total) => {
        this.ui.updateCoinCounter(total);
        this.refreshPackIfOpen(); // coins need NO keypress — walking into one counts
        saveProfile({ coins: total });
        if (total >= 100) trackOnce('coins_milestone', { n: 100 });
        else if (total >= 50) trackOnce('coins_milestone', { n: 50 });
        // One-time pointer at the earning guide, on the first coin.
        try {
          if (!localStorage.getItem('ds_hint_earn')) {
            localStorage.setItem('ds_hint_earn', '1');
            this.ui.toast('🪙 Coins! The 📔 Journal (Portfolio menu) lists every way to earn.');
          }
        } catch {
          /* no storage */
        }
      });

      // Arrival breadcrumb trail finished: the first-visit quick win lands.
      this.scene.setOnArrivalTrail(() => {
        this.markDone('ds_arrived');
        this.ui.flashMessage('🏝️ Welcome to the island — you’ve got the hang of it!');
        sfx.questComplete();
        trackOnce('arrival_trail_done');
      });

      // Island Journal: one panel unifying every collection into n-of-m
      // meters. Race bests read straight off their storage keys (the key IS
      // RaceSystem's persistence contract) to avoid new plumbing.
      this.ui.setJournalProvider(() => {
        const best = (kind: string): number | null => {
          try {
            const v = parseFloat(localStorage.getItem(`ds_race_best_${WORLD_ERA}_${kind}`) ?? '');
            return Number.isFinite(v) ? v : null;
          } catch {
            return null;
          }
        };
        return {
          stamps: PASSPORT_ZONES.map((z) => ({
            icon: PASSPORT_META[z].icon,
            label: PASSPORT_META[z].label,
            has: this.passport?.has(z) ?? false,
          })),
          hats: this.hatCatalog.map((h) => ({
            icon: h.icon,
            name: h.name,
            owned: this.ownedHats.has(h.id),
          })),
          races: [
            { label: '🏞️ Land circuit', best: best('land') },
            { label: '🌊 Water circuit', best: best('water') },
          ],
          deliveries: {
            done: this.deliverySystem?.getCompletedCount() ?? 0,
            total: this.deliverySystem?.getTotalCount() ?? 10,
          },
          coins: this.scene.getCoinsCollected(),
          loops: [
            {
              icon: '🎣',
              title: `Fishing (rod ${SimpleApp.ROD_PRICE} 🪙)`,
              detail: `cast at the shore, sell to the fisherman — ${SimpleApp.FISH_SELL_PRICE} 🪙/fish, first ${SimpleApp.DAILY_SELL_CAP}/day`,
            },
            {
              icon: '🪓',
              title: `Timber (axe ${SimpleApp.AXE_PRICE} 🪙)`,
              detail: `fell trees, sell to the Carpenter (${SimpleApp.TIMBER_SELL_PRICE} 🪙/log) or build at the stakes`,
            },
            {
              icon: '🪚',
              title: `Farming (sickle ${SimpleApp.SICKLE_PRICE} 🪙)`,
              detail: `cut crops at the farm — Baker pays ${SimpleApp.WHEAT_SELL_PRICE} 🪙/wheat, canteen ${SimpleApp.PRODUCE_SELL_PRICE} 🪙/veg`,
            },
            {
              icon: '⛏️',
              title: `Mining (pickaxe ${SimpleApp.PICKAXE_PRICE} 🪙)`,
              detail: `crack highland ore veins, the bank assays ore — ${SimpleApp.ORE_SELL_PRICE} 🪙 each`,
            },
            {
              icon: '📚',
              title: 'School',
              detail: `${SimpleApp.LESSONS.length} lessons, 10 🪙 each — one-time`,
            },
            {
              icon: '🏗️',
              title: 'Building',
              detail: `your builds ${this.ownBuilds.size}/6 — choose at any 🔨 stake: signposts & planters 3🪵, campfires 6🪵, lanterns 8🪵, gazebos 20🪵`,
            },
            {
              icon: '🍽️',
              title: 'Food & rest',
              detail: `meals refill stamina — Canteen Soup ${SimpleApp.SOUP_PRICE}🪙, Grilled Fish ${SimpleApp.FISHMEAL_PRICE}🪙, Baker's Pie ${SimpleApp.PIE_PRICE}🪙 (full + a 20s stroll). Press G to eat.`,
            },
          ],
          secrets: {
            found: this.secrets.count(),
            total: this.secrets.total(),
            // Up to three cryptic pulls — a full list would read as a checklist,
            // not a mystery.
            rumors: this.secrets.unfoundRumors().slice(0, 3),
          },
          visits: this.visitLedger(),
        };
      });

      // The pack: what you're CARRYING (the journal is what you've found, the
      // shop is what you can buy). Same provider convention — read live, cache
      // nothing, and never write a ds_* key from the UI layer: main-simple is
      // the sole author of every value here, which is the whole safety
      // argument behind the Consumable Law.
      this.ui.setInventoryProvider(() => ({
        coins: this.scene.getCoinsCollected(),
        goods: [
          {
            icon: '🐟',
            label: 'Fish',
            count: this.fishCaught,
            hint: `sell at the jetty — ${SimpleApp.FISH_SELL_PRICE}🪙 each, first ${SimpleApp.DAILY_SELL_CAP}/day`,
          },
          {
            icon: '🪵',
            label: 'Timber',
            count: this.timber,
            hint: `sell to the Carpenter (${SimpleApp.TIMBER_SELL_PRICE}🪙), or build at any 🔨 stake`,
          },
          {
            icon: '🌾',
            label: 'Wheat',
            count: this.wheat,
            hint: `sell to the Baker — ${SimpleApp.WHEAT_SELL_PRICE}🪙 each`,
          },
          {
            icon: '🥬',
            label: 'Produce',
            count: this.produce,
            hint: `canteen cart or market grocer — ${SimpleApp.PRODUCE_SELL_PRICE}🪙 each`,
          },
          {
            icon: '🪨',
            label: 'Ore',
            count: this.ore,
            hint: `assayed at the bank — ${SimpleApp.ORE_SELL_PRICE}🪙 each`,
          },
        ],
        supplies: [
          // 🐦, not 🌾: the wheat row above already owns 🌾, and two rows with
          // the same glyph in one panel is a mis-read waiting to happen.
          { icon: '🐦', label: 'Bird feed', count: this.birdFeed, hint: 'press F near birds' },
          { icon: '🐈', label: 'Cat feed', count: this.catFeed, hint: 'press F near cats' },
          { icon: '🐠', label: 'Fish feed', count: this.fishFeed, hint: 'press F over water' },
          {
            icon: '🥧',
            label: "Baker's pie",
            count: this.meals.pie,
            hint: 'press G — refills stamina',
          },
          {
            icon: '🍤',
            label: 'Grilled fish',
            count: this.meals.fish,
            hint: 'press G — refills stamina',
          },
          {
            icon: '🍲',
            label: 'Canteen soup',
            count: this.meals.soup,
            hint: 'press G — refills stamina',
          },
        ],
        tools: [
          { icon: '🎣', name: 'Fishing rod', owned: this.ownedRod },
          { icon: '🪓', name: 'Axe', owned: this.ownedAxe },
          { icon: '🌾', name: 'Sickle', owned: this.ownedSickle },
          { icon: '⛏️', name: 'Pickaxe', owned: this.ownedPickaxe },
        ],
        hats: {
          equipped: this.hatCatalog.find((h) => h.id === this.equippedHat)?.name ?? null,
          owned: this.ownedHats.size,
          total: this.hatCatalog.length,
        },
        // The one holding with no other UI anywhere: nothing tells you you're
        // carrying the Fisherman's snapper, or who wants it.
        carrying: this.npcQuests.isCarryingFetchItem()
          ? { icon: '🐟', label: "The Fisherman's snapper", hint: 'take it to the Village Baker' }
          : null,
      }));
      this.ui.setOnOpenShop(() => this.openShop());

      // Drowning: washed back to shore. The teleport is a hard cut across
      // potentially half the map, so it gets the same 0.45s veil doors use —
      // with the camera snapped UNDER the veil (otherwise the orbit cam
      // visibly whips from the drowning spot to the shore). One message, not
      // two: the fee (buffered from onDrownFee, which fires first in
      // respawnFromDrown) rides the same line instead of a separate toast.
      this.scene.setOnDrownRespawn(() => {
        const fee = this.pendingDrownFee;
        this.pendingDrownFee = 0;
        this.ui.fadeThrough(() => this.scene.snapCameraToPlayer());
        this.ui.flashMessage(
          fee > 0
            ? `🌊 You nearly drowned! Washed ashore — ${fee} 🪙 to the shore patrol.`
            : '🌊 You nearly drowned! Washed ashore.',
        );
        sfx.land();
      });

      // Vehicle time-trials: banner on start/checkpoint/finish + live lap HUD
      this.scene.setOnRaceEvent((e) => {
        if (e.kind === 'finish') {
          sfx.questComplete();
          // Racing paid NOTHING before — the most complete loop in the game had
          // no reward. Every finish now pays out (bigger on a PB).
          const reward = e.improved ? 15 : 5;
          this.scene.addCoins(reward);
          this.ui.updateCoinCounter(this.scene.getCoinsCollected());
          this.ui.flashMessage(`${e.text}  ·  +${reward} 🪙`);
          // ?race=&beat= challenge verdict (one-shot: cleared either way).
          if (
            this.raceChallenge &&
            e.circuit === this.raceChallenge.kind &&
            typeof e.timeSec === 'number'
          ) {
            const beaten = e.timeSec * 1000 < this.raceChallenge.ms;
            window.setTimeout(
              () =>
                this.ui.flashMessage(
                  beaten
                    ? '🏆 Challenge beaten — send them YOUR time!'
                    : '⚔️ Challenge stands — one more lap?',
                ),
              2000,
            );
            track('race_challenge_result', { beaten });
            if (beaten) {
              this.raceChallenge = null;
              if (e.circuit) this.scene.setRaceChallenge(e.circuit, null);
            }
          }
          track('race_finish', {
            circuit: e.circuit ?? 'unknown',
            timeMs: Math.round((e.timeSec ?? 0) * 1000),
            improved: !!e.improved,
          });
          this.markDone('ds_raced');
          const name = this.multiplayer?.selfName ?? 'Guest';
          if (e.improved && e.circuit && typeof e.timeSec === 'number') {
            void import('./Boards').then((b) => b.submitRaceTime(e.circuit!, e.timeSec!, name));
          }
          // Surface the (otherwise buried) global leaderboard a beat after the
          // finish, with a Share button — turns every PB into a share prompt.
          if (e.circuit) {
            const circuit = e.circuit;
            const tMs = typeof e.timeSec === 'number' ? Math.round(e.timeSec * 1000) : null;
            window.setTimeout(() => void this.ui.showRaceLeaderboard(circuit, tMs, name), 1200);
          }
          return;
        }
        this.ui.flashMessage(e.text);
        if (e.kind === 'start') {
          sfx.raceGo();
          this.raceGuideTarget = null; // the guide CTA is fulfilled
          track('race_start', { circuit: e.circuit ?? 'unknown' });
        } else if (e.kind === 'checkpoint') sfx.checkpoint();
      });
      this.scene.setOnRaceHud((s) => this.ui.updateRaceHud(s));

      // "Meet the AI townsfolk" welcome CTA: compass-guide to the Storyteller
      // until the visitor actually talks to an AI NPC (cleared there).
      this.ui.setOnMeetAi(() => {
        this.aiGuideTarget =
          this.scene.getNpcPosition('Storyteller') ?? this.scene.getNpcPosition('Elder Sage');
        if (this.aiGuideTarget) {
          this.ui.flashMessage(
            '🤖 Follow the compass — walk up to the Storyteller and ask anything',
          );
        }
      });

      // Cinematic tour + race guide CTAs (welcome modal / leaderboards) and the
      // UI-side completion flags (guestbook, Times, say-hi) refreshing the pill.
      this.ui.setOnTour(() => this.startTour());
      this.ui.setOnRecruitTour(() => this.startTour(true));
      this.ui.setOnRaceGuide(() => this.guideToRace());
      this.ui.setOnProgressMade(() => this.refreshCompletion());
      this.refreshCompletion();

      // 🎨 button / C key: toggle the appearance editor
      this.ui.setOnCustomizeToggle(() => {
        if (this.ui['customizeDiv']) this.ui.hideCustomize();
        else this.openCustomize();
      });

      // Mute button → THE one switch for all sound (music + sfx + NPC voice +
      // peer voice — speech reads the master state inside Speech/Chat).
      this.ui.setOnMuteToggle(() => {
        const am = (window as unknown as { audioManager?: { toggleMute(): boolean } }).audioManager;
        if (am) {
          const muted = am.toggleMute();
          if (muted) cancelSpeech(); // silence any line mid-sentence, immediately
          return muted;
        }
        // Pre-audio-boot (the AudioManager is created on an idle timer ~5s in):
        // the old handler returned false here — a silent no-op click. Flip the
        // persisted flag instead; the constructor reads it moments later.
        let muted = true;
        try {
          const s = JSON.parse(localStorage.getItem('ds_audio_settings') ?? '{}');
          muted = !s.muted;
          localStorage.setItem('ds_audio_settings', JSON.stringify({ ...s, muted }));
        } catch {
          /* no storage — still report muted so the icon gives feedback */
        }
        if (muted) cancelSpeech();
        return muted;
      });

      // Volume slider → master volume (ramped + persisted by AudioManager).
      this.ui.setOnVolumeChange((v) => {
        const am = (window as unknown as { audioManager?: { setVolume(v: number): void } })
          .audioManager;
        if (am) {
          am.setVolume(v);
          return;
        }
        // Pre-audio-boot: persist directly; the AudioManager constructor
        // reads it when the idle music start creates it (same pattern as
        // the pre-boot mute path above).
        try {
          const s = JSON.parse(localStorage.getItem('ds_audio_settings') ?? '{}');
          localStorage.setItem(
            'ds_audio_settings',
            JSON.stringify({ ...s, v: 2, volume: Math.max(0, Math.min(1, v)) }),
          );
        } catch {
          /* no storage */
        }
      });

      // Initialize post-processing. Awaited so the lazily-loaded bloom addons
      // are constructed before warmUp() compiles their shaders ahead of reveal.
      // On the coarse/low-core tier this never constructs a composer (nor
      // fetches the chunk) — phones stay on the native antialiased canvas.
      if (SimpleRenderer.isLowTierDevice()) {
        console.log('📱 Low-tier device: bloom skipped, native MSAA path.');
      } else {
        await this.renderer.initPostProcessing(this.scene, this.scene.getCamera());
        console.log('✓ Post-processing initialized');

        this.renderer.setPostProcessingEnabled(true);
        console.log('✨ Bloom enabled by default (Ctrl+B to toggle).');
      }

      this.setupDebugShortcuts();

      // Create input manager
      this.inputManager = new SimpleInputManager();
      this.inputManager.attachToCanvas(canvas);
      console.log('✓ Input manager created');

      // Chat keybindings: Enter opens the text input; V is push-to-talk
      // voice (no existing hotkey uses V — checked SimpleInputManager and
      // this file's debug shortcuts, which use C and Ctrl+B). Bound on
      // window rather than through SimpleInputManager so the chat input's
      // own keydown handler (which calls stopPropagation) can fully own
      // the keyboard while it's focused.
      this.boundHandlers.chatKeydown = (e: KeyboardEvent) => {
        if (this.ui.isChatInputOpen()) return; // the input owns the keyboard while typing
        if (e.key === 'Enter') {
          // First time a name becomes visible to OTHERS — ask for it here
          // (lazily), not as a gate on the whole site.
          this.ensureNamed(() => this.ui.openChatInput());
          return;
        }
        if ((e.key === 'v' || e.key === 'V') && !e.repeat) {
          void this.chat?.startRecording();
        }
      };
      this.boundHandlers.chatKeyup = (e: KeyboardEvent) => {
        if (e.key === 'v' || e.key === 'V') this.chat?.stopRecording();
      };
      window.addEventListener('keydown', this.boundHandlers.chatKeydown);
      window.addEventListener('keyup', this.boundHandlers.chatKeyup);

      // Setup cleanup on page unload
      this.boundHandlers.beforeUnload = () => this.dispose();
      window.addEventListener('beforeunload', this.boundHandlers.beforeUnload);

      // ?theme=real: set the sky PMREM environment BEFORE the shader
      // precompile below, so every material compiles once with its envmap
      // defines instead of recompiling mid-fly-in when the env appears.
      if (isRealTheme()) {
        this.scene.applyRealEnvironment(this.renderer.getRenderer());
      }

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

      // Shared benches: render every visitor's builds as they stream in
      // (write path is charged + rules-capped; see worldBenches.ts).
      void subscribeBenches((b) => this.scene.renderWorldBench(b.plot));
      {
        // Builds stream: render + own-map + fresh-build discovery pulse +
        // away digest (count compared to last visit, after the replay burst).
        let totalBuilds = 0;
        const subscribedAt = Date.now();
        void subscribeBuilds(
          (b) => {
            this.scene.renderWorldBuild(b.plot, b.kind);
            totalBuilds++;
            this.ui.setBuildCount(totalBuilds);
            if (b.own) this.ownBuilds.set(b.plot, b.slot);
            // A build raised in the last two minutes by SOMEONE ELSE gets a
            // one-toast pulse (session cap 2 — discovery, not spam).
            if (
              !b.own &&
              b.t &&
              Date.now() - b.t < 120_000 &&
              Date.now() - subscribedAt > 3000 &&
              this.freshBuildToasts < 2
            ) {
              this.freshBuildToasts++;
              const seat = this.scene.plotSeat('build', b.plot);
              if (seat) this.scene.spawnDust(seat.clone(), 4);
              // resolveKind, not the raw wire index: the renderer clamps a
              // gazebo request on a small plot back to the plot default, and
              // the toast must name what actually appeared.
              const kindName = GameScene.resolveKind(b.plot, b.kind) ?? 'structure';
              this.ui.toast(`🔨 A visitor just raised a ${kindName} — it's on your map.`);
            }
          },
          (r) => {
            // Remote (or my own from another tab) reclaim: tear down live.
            this.scene.removeWorldBuild(r.plot);
            if (this.ownBuilds.get(r.plot) === r.slot) this.ownBuilds.delete(r.plot);
            totalBuilds = Math.max(0, totalBuilds - 1);
            this.ui.setBuildCount(totalBuilds);
          },
        );
        // Away digest: 3s after subscribe (past the child-added replay burst)
        // compare the total to the last visit's count.
        window.setTimeout(() => {
          try {
            const seen = parseInt(localStorage.getItem('ds_seen_builds') ?? '0', 10) || 0;
            if (totalBuilds > seen && seen > 0) {
              this.ui.toast(
                `🏘️ Visitors raised ${totalBuilds - seen} structure${totalBuilds - seen > 1 ? 's' : ''} while you were away.`,
              );
            }
            localStorage.setItem('ds_seen_builds', String(totalBuilds));
          } catch {
            /* no storage */
          }
        }, 3000);
      }
      this.scene.onDrownFee = (fee) => {
        // Buffered into the respawn flash (one message per event, not two
        // simultaneous surfaces) — see setOnDrownRespawn.
        this.pendingDrownFee = fee;
        this.ui.updateCoinCounter(this.scene.getCoinsCollected());
      };

      // Pitch FIRST: a recruiter learns who Abbas is before anything is asked
      // of them. The name prompt used to gate the whole site ("name yourself
      // for a multiplayer game" before the portfolio pitch) — it is now lazy,
      // asked only when a social feature actually needs a name (ensureNamed).
      const afterIntro = () => {
        let saved: string | null = null;
        try {
          saved = localStorage.getItem('ds_player_name');
        } catch {
          /* no storage */
        }
        if (saved) this.multiplayer?.setName(saved);
        // ?tour=1 share links go straight into the cinematic rail (skippable);
        // ?pc= postcard links land on the sender's exact view; other deep
        // links get their shared content directly; everyone else, the pitch.
        const sp = new URLSearchParams(window.location.search);
        const wantTour = sp.get('tour') === '1';
        if (sp.get('recruit') === '1') this.startTour(true);
        else if (wantTour) this.startTour();
        else if (this.applyPostcardParam(sp.get('pc'))) {
          /* postcard view active — welcome deferred to its dismiss */
        } else if (this.applyRaceChallengeParam(sp)) {
          /* challenge accepted — guided straight to the start line */
        } else if (!this.openDeepLinkZone()) this.ui.showWelcome(this.buildAwayDelta());
      };
      // Start the fly-in BEFORE the first frame renders: its first act is
      // placing the camera at the distant start, so no frame can ever show
      // the degenerate pre-placement view. The opaque loader then fades
      // out over the already-moving cinematic. Reduced-motion skips the
      // swoop entirely and drops straight into the settled follow view.
      if (a11y.reducedMotion) {
        afterIntro();
      } else {
        // INTRO-LITE: the fly-in is the single heaviest view in the game — the
        // whole planet in frustum, so chunk culling recovers nothing and every
        // tree/cloud/blade renders at once. At the resulting frame rate the
        // orbiting planet judders ("feels doubled" — classic low-fps double
        // image, plus half-res bloom ghosting on the bright rim). Half the
        // grass and skip bloom for the 2.5s swoop; nobody can see blades or
        // bloom detail from 280u anyway. Restored the frame the intro settles
        // (governor conflict window is ~0: rungs need 4s+ at the scale floor
        // before they touch either lever).
        // THE COMPOSER NOW STAYS ON. This used to call
        // setPostProcessingEnabled(false), which is not "skip bloom" — it swaps
        // composer.render() for renderer.render(), moving tone mapping out of
        // OutputPass and into every material. The two paths render genuinely
        // different images.
        //
        // HOW BIG THAT STEP ACTUALLY WAS — measured back-to-back at FIXED camera
        // poses (both paths rendered from one pose, so no camera drift is folded
        // in), because the honest answer is "it depends on the framing":
        //   distant start (whole planet)   +16.6%
        //   1500ms, WHERE THE RESTORE FIRES  +8.0%
        //   settled ground view            +26.9%
        // So the mid-swoop timing below was already doing most of the work: it
        // moved the step off the worst framing (arrival, ~27%) onto one of the
        // cheapest, and the camera's own motion masked it further — frame to
        // frame across the restore it measured only ~3%. This change is
        // therefore a cleanup of a MITIGATED defect, not a rescue from a
        // 21% flash. The earlier note here read "+22%" from the settled-view
        // measurement and did not distinguish the two framings.
        //
        // Disabling the bloom PASS instead keeps RenderPass -> OutputPass, so
        // tone mapping still happens once in the same place. MEASURED at those
        // same five poses, worst case 0.039%. The step is now gone rather than
        // hidden, and the render path never switches at all.
        //
        // GRASS PAYS FOR IT. Holding the composer through the swoop costs real
        // fill rate with the whole planet in frustum, so the grass lever leans
        // harder to compensate. MEASURED over the real 2.5s flight, median /
        // p95 / worst frame:
        //   grass 0.5 + composer OFF (before)   22.0 / 45.3 / 48.2 ms
        //   grass 0.5 + composer ON             26.3 / 47.0 / 51.2
        //   grass 0.3 + composer ON  (this)     22.7 / 42.7 / 48.7
        //   grass 0.2 + composer ON             22.3 / 42.0 / 45.6
        // 0.3 lands at parity on the median (run-to-run noise here is ~2ms) and
        // BETTER on p95, which is the number judder is actually made of. Nobody
        // can resolve a blade from 280u; the bloom detail was never visible
        // either. 0.2 measured better still and is there if a slow machine needs
        // it — this stops at 0.3 because parity was the bar.
        this.scene.getIsland().setGrassBudget(0.3);
        this.renderer.setBloomEnabled(false);
        // RESTORE MID-SWOOP, NOT ON ARRIVAL. Firing on the frame the camera
        // settles put the biggest visual discontinuity in the game at the exact
        // moment the player first looks at the island — read as the screen
        // "glitching". The brightness half of that is gone now, but grass
        // 0.3 -> 1.0 is still a whole-image change, so it keeps riding in under
        // the motion at 1.5s of a 2.5s flight. The heavy part of the swoop —
        // the whole planet in frustum — is the FIRST second, which still runs
        // lean, so the judder this was protecting is intact.
        //
        // Bonus, and the reason warmUp below finally does its job: warmUp
        // branches on postProcessingEnabled, and this function used to set it
        // false BEFORE warmUp ran. So the bloom/output programs were never
        // compiled behind the loader on this path — they compiled mid-swoop, at
        // the same 1500ms moment as the brightness step. Only reduced-motion
        // users (who skip this block) ever got a warmed composer.
        const restoreIntroQuality = (): void => {
          this.scene.getIsland().setGrassBudget(1);
          this.renderer.setBloomEnabled(true);
        };
        window.setTimeout(restoreIntroQuality, 1500);
        this.scene
          .getOrbitCamera()
          .flyInFromDistant(2500)
          .then(() => {
            restoreIntroQuality(); // idempotent — covers a skipped/short flight
            afterIntro();
          });
      }

      // Warm the post-processing + shadow shaders on a hidden frame (camera is
      // already at the distant fly-in start) so the first VISIBLE frame doesn't
      // hitch — a cause of the reveal flash.
      this.renderer.warmUp(this.scene, this.scene.getCamera());

      // Start render loop
      this.startRenderLoop();
      console.log('✓ Render loop started');

      // Hold the loader a touch longer so a couple of clean frames render
      // before it fades over them (was 350ms — too eager, revealed mid-warmup).
      setTimeout(() => this.ui.hideLoading(), 500);

      // Register the service worker for instant repeat visits + offline shell.
      // Production only (SW caching would fight Vite HMR in dev), on load so it
      // never competes with the initial render.
      if (import.meta.env.PROD && 'serviceWorker' in navigator) {
        window.addEventListener('load', () => {
          navigator.serviceWorker.register('/sw.js').catch(() => {
            /* SW is a progressive enhancement — ignore failures */
          });
        });
      }

      // Background music synthesis is heavy — it generates a minute of stereo
      // samples with per-sample trig on the main thread. Running it during
      // init (as before) stalled the opening fly-in: the startup "lag". Defer
      // it to an idle slot after first paint; audio needs a user gesture to
      // play anyway, so nothing is lost by generating it lazily.
      const startMusic = () => void this.startBackgroundMusic();
      // Cloud profile: reconcile name/hat/coins once Firebase auth has settled.
      const syncProfile = () => void this.syncProfile();
      const idle = (cb: () => void, timeout: number) => {
        if ('requestIdleCallback' in window) {
          (
            window as unknown as {
              requestIdleCallback: (c: () => void, o?: { timeout: number }) => void;
            }
          ).requestIdleCallback(cb, { timeout });
        } else {
          setTimeout(cb, timeout / 3);
        }
      };
      idle(startMusic, 5000);
      idle(syncProfile, 4000);
      // (Vercel Analytics inject() moved to module top — pre-boot pageviews.)

      // Browsers create AudioContexts suspended until a user gesture; nothing
      // resumed it before, so music (and now SFX) stayed silent. Resume once
      // on the first key/click, unless the user has muted.
      const resumeAudio = () => {
        window.removeEventListener('keydown', resumeAudio);
        window.removeEventListener('pointerdown', resumeAudio);
        try {
          const am = (
            window as unknown as {
              audioManager?: { ensureCtx(): AudioContext; isMuted(): boolean };
            }
          ).audioManager;
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
    // welcome-modal / hud-overlay were deleted from index.html; the pre-JS
    // #loading-screen placeholder is the only static element left to retire.
    const legacyIds = ['loading-screen'];
    legacyIds.forEach((id) => {
      const element = document.getElementById(id);
      if (element) {
        element.remove();
        console.log(`🧹 Removed legacy UI element: ${id}`);
      }
    });
  }

  /** Passport complete: grant + auto-equip the Golden Crown, persist, celebrate. */
  private grantPassportReward(): void {
    const hat = 'crown';
    if (!this.ownedHats.has(hat)) {
      this.ownedHats.add(hat);
      try {
        localStorage.setItem('ds_owned_hats', JSON.stringify([...this.ownedHats]));
      } catch {
        /* ignore */
      }
    }
    this.equippedHat = hat;
    try {
      localStorage.setItem('ds_hat', hat);
    } catch {
      /* ignore */
    }
    this.scene.equipPlayerHat(hat as HatId);
    this.multiplayer?.setHat(hat as HatId);
    this.ui.showPassportComplete();
  }

  /** True while a photo capture is composing, so P/📸 don't stack requests. */
  private capturing = false;
  /** Previous visit's last heartbeat (epoch ms; 0 = first visit / unknown). */
  private prevSeenAt = 0;
  /** The rumor-driven discovery loop (see Secrets.ts). */
  private secrets = new Secrets();
  private secretSpots: Array<{ id: string; pos: THREE.Vector3 }> = [];

  /** Resolve the nine secret spots to world positions (once; the landmarks
   *  all exist by the time the first proximity sweep runs). */
  private resolveSecretSpots(): void {
    if (this.secretSpots.length) return;
    const island = this.scene.getIsland();
    const add = (id: string, pos: THREE.Vector3 | null | undefined) => {
      if (pos) this.secretSpots.push({ id, pos: pos.clone() });
    };
    const surf = (dir: THREE.Vector3 | null | undefined): THREE.Vector3 | null => {
      if (!dir) return null;
      try {
        return island.sampleSurfaceByDirection(dir, 0).position;
      } catch {
        return null;
      }
    };
    add('lighthouse', surf(island.lighthouseDir));
    add('summit', surf(island.trailSummitDir));
    add('garden', surf(island.gardenDir));
    add('scarecrow', surf(island.farmDir));
    add('bandstand', island.bandstandSites[0]);
    add('easel', island.easelSites[0]);
    const sc = this.scene.getObjectByName('story_circle');
    if (sc) add('story-circle', sc.getWorldPosition(new THREE.Vector3()));
    add('heron-shore', surf(island.dirAt(2.1, 0.22)));
    add(
      'hall',
      this.scene
        .getZonesManager()
        .getZones()
        .find((z) => z.id === 'welcome')
        ?.getPosition(),
    );
  }

  /**
   * Photo mode: hide the HUD for one frame, capture the drawing buffer, brand
   * it into a share card, and preview it. The renderer captures in-frame (no
   * preserveDrawingBuffer) so the HUD must be hidden BEFORE the capture frame
   * and restored after.
   */
  private async capturePhoto(): Promise<void> {
    if (this.capturing) return;
    this.capturing = true;
    const overlay = this.ui.getOverlay();
    const prevVis = overlay?.style.visibility ?? '';
    try {
      if (overlay) overlay.style.visibility = 'hidden';
      // Let the hidden-HUD state paint, then grab the very next rendered frame.
      await new Promise((r) => requestAnimationFrame(() => r(null)));
      const shot = await this.renderer.captureFrame();
      if (overlay) overlay.style.visibility = prevVis;
      if (!shot) {
        this.ui.flashMessage('📸 Capture failed — try again.');
        return;
      }
      const { composePhotoCard, encodePostcardPose } = await import('./Share');
      const card = await composePhotoCard(shot);
      track('photo_captured');
      this.markDone('ds_photo_taken');
      // State-carrying link: the shared postcard drops its recipient onto
      // THIS exact view at THIS hour (the Wordle-grade share from the
      // engagement research — the link carries the moment, not the homepage).
      let pc: string | undefined;
      try {
        const cam = this.scene.getCamera();
        const hour = this.scene.getEnvironmentCycle()?.getHour() ?? 12;
        pc = encodePostcardPose(cam.position, cam.quaternion, hour);
      } catch {
        /* pose is a bonus — share still works without it */
      }
      this.ui.showPhotoPreview(card, pc);
    } catch {
      if (overlay) overlay.style.visibility = prevVis;
      this.ui.flashMessage('📸 Capture failed — try again.');
    } finally {
      this.capturing = false;
    }
  }

  /**
   * Apply a /?hour=<0-24> override to the day/night clock and show a revert
   * pill. Lets a shared night link reveal the art most daytime visitors never
   * see. The revert restores the live clock and strips the param.
   */
  private applyHourParam(): void {
    try {
      const raw = new URLSearchParams(location.search).get('hour');
      if (raw === null) return;
      const h = Number(raw);
      if (!Number.isFinite(h) || h < 0 || h > 24) return;
      const env = this.scene.getEnvironmentCycle();
      if (!env) return;
      env.debugHour = h;
      const hh = Math.floor(h) % 24;
      const label = `🕐 ${((hh + 11) % 12) + 1}${hh < 12 ? 'am' : 'pm'}`;
      this.ui.showTimeOverridePill(label, () => {
        env.debugHour = null;
        try {
          const sp = new URLSearchParams(location.search);
          sp.delete('hour');
          const q = sp.toString();
          history.replaceState(null, '', `${location.pathname}${q ? `?${q}` : ''}`);
        } catch {
          /* ignore */
        }
      });
    } catch {
      /* ignore */
    }
  }

  /**
   * ?pc= postcard link: land the visitor on the SENDER'S exact view at the
   * sender's hour (state-carrying share). Camera is suspended on the saved
   * pose until they tap the pill to start exploring — which also skips the
   * welcome modal (they came for a specific view, not the pitch).
   * Returns true when a valid pose was applied.
   */
  private applyPostcardParam(token: string | null): boolean {
    if (!token) return false;
    try {
      const pose = decodePostcardPose(token);
      if (!pose) return false;
      const env = this.scene.getEnvironmentCycle();
      if (env) env.debugHour = pose.hour;
      const cam = this.scene.getCamera();
      this.scene.setCameraSuspended(true);
      cam.position.set(pose.pos[0], pose.pos[1], pose.pos[2]);
      cam.quaternion.set(pose.quat[0], pose.quat[1], pose.quat[2], pose.quat[3]);
      cam.up.copy(cam.position).normalize(); // spherical world: up = radial
      cam.updateMatrixWorld(true);
      track('postcard_open');
      // The pill helper appends its own "— tap to return" suffix; keep the
      // label bare or the instruction doubles.
      this.ui.showTimeOverridePill('📸 Postcard view', () => {
        // The saved pose is the SENDER'S view anywhere on the planet, so the
        // release glide back to the visitor's spawn is unbounded in length —
        // door grammar for everyone: veil, cut underneath.
        this.ui.fadeThrough(() => {
          this.scene.setCameraSuspended(false);
          this.scene.snapCameraToPlayer();
        });
        if (env) env.debugHour = null;
        try {
          const sp = new URLSearchParams(location.search);
          sp.delete('pc');
          const q = sp.toString();
          history.replaceState(null, '', `${location.pathname}${q ? `?${q}` : ''}`);
        } catch {
          /* ignore */
        }
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * "While you were away" delta for the returning-visitor welcome card — the
   * cheapest conversion of the already-living world into a felt reason to
   * return. Built SYNCHRONOUSLY from what's cached (world state arrives via
   * RTDB during the fly-in); the guestbook count patches in async. Null for
   * first-timers and short gaps — the card stays as it was.
   */
  private buildAwayDelta(): import('./SimpleUI').AwayDelta | null {
    const HOURS_12 = 12 * 3600 * 1000;
    let welcomed = false;
    try {
      welcomed = localStorage.getItem('ds_welcomed') === '1';
    } catch {
      /* no storage */
    }
    if (!welcomed || !this.prevSeenAt || Date.now() - this.prevSeenAt < HOURS_12) return null;
    const daysAway = Math.max(1, Math.round((Date.now() - this.prevSeenAt) / 86_400_000));
    const ws = getWorldState();
    // Island Times editions published since the last visit (YYYY-MM-DD days).
    const sinceDay = new Date(this.prevSeenAt).toISOString().slice(0, 10);
    const editions = (ws?.noticeArchive ?? []).filter((e) => e.day > sinceDay).length;
    const prevSeen = this.prevSeenAt;
    return {
      daysAway,
      editions,
      headline: ws?.headline ?? null,
      weather: ws?.weather ?? null,
      guestbookSince: (async () => {
        try {
          const { getGuestbook } = await import('./Boards');
          const entries = await getGuestbook(25);
          return entries.filter((e) => e.t > prevSeen).length;
        } catch {
          return null;
        }
      })(),
    };
  }

  /** ?race=land|water&beat=<ms> challenge link: guide straight to that start
   *  line, arm a "beat their time" HUD target, and suppress the welcome pitch. */
  private applyRaceChallengeParam(sp: URLSearchParams): boolean {
    const kind = sp.get('race');
    if (kind !== 'land' && kind !== 'water') return false;
    const beat = parseInt(sp.get('beat') ?? '', 10);
    this.raceChallenge = Number.isFinite(beat) && beat > 5000 ? { kind, ms: beat } : null;
    this.scene.setRaceChallenge(kind, this.raceChallenge?.ms ?? null);
    this.raceGuideTarget = this.scene.getRaceStartPosition(kind);
    const label = kind === 'land' ? '🏞️ land circuit' : '🌊 water circuit';
    this.ui.flashMessage(
      this.raceChallenge
        ? `🏁 Challenge: beat ${(this.raceChallenge.ms / 1000).toFixed(1)}s on the ${label}!`
        : `🏁 Race challenge — follow the compass to the ${label}!`,
    );
    track('race_challenge_open');
    return true;
  }

  private raceChallenge: { kind: 'land' | 'water'; ms: number } | null = null;

  /** Append return-visit facts and (sometimes) an island rumor to an NPC
   *  greeting's LLM copy (never the displayed text). The rumor sentence is
   *  authored and injected VERBATIM — the model flavors around it but cannot
   *  corrupt directions it never generates. Server clamps openings to 300. */
  private withVisitorFacts(aware: string): string {
    let out = aware;
    const facts: string[] = [];
    if (this.prevSeenAt) {
      const days = Math.round((Date.now() - this.prevSeenAt) / 86_400_000);
      if (days >= 1) facts.push(`returning after ${days} day${days > 1 ? 's' : ''} away`);
    }
    if (this.equippedHat) {
      const hat = this.hatCatalog.find((h) => h.id === this.equippedHat);
      if (hat) facts.push(`wearing the ${hat.name}`);
    }
    if (facts.length) out = `${out} (The traveller is ${facts.join(', ')}.)`;
    const rumors = this.secrets.unfoundRumors();
    if (rumors.length && Math.random() < 0.45) {
      const r = rumors[Math.floor(Math.random() * rumors.length)];
      out = `${out} (If it fits, mention this island rumor word-for-word: "${r}")`;
    }
    return out.slice(0, 300);
  }

  /**
   * One-time finale reward for delivering all ten packages: +25 coins and the
   * rare 😇 Halo (normally the priciest hat), owned + equipped. Guarded so a
   * refresh after completion doesn't re-grant. Mirrors the passport crown flow.
   */
  private grantCourierReward(): void {
    try {
      if (localStorage.getItem('ds_courier_reward') === '1') return;
      localStorage.setItem('ds_courier_reward', '1');
    } catch {
      /* storage blocked — still grant for this session */
    }
    this.scene.addCoins(25);
    this.ui.updateCoinCounter(this.scene.getCoinsCollected());
    const hat: HatId = 'halo';
    if (!this.ownedHats.has(hat)) {
      this.ownedHats.add(hat);
      try {
        localStorage.setItem('ds_owned_hats', JSON.stringify([...this.ownedHats]));
      } catch {
        /* ignore */
      }
    }
    this.equippedHat = hat;
    try {
      localStorage.setItem('ds_hat', hat);
    } catch {
      /* ignore */
    }
    this.scene.equipPlayerHat(hat);
    this.multiplayer?.setHat(hat);
    saveProfile({ hat, ownedHats: [...this.ownedHats], coins: this.scene.getCoinsCollected() });
    this.ui.flashMessage('🌟 Master Courier! +25 coins and the rare 😇 Halo — equipped.');
  }

  /**
   * Step inside a building: fade to black → move the camera into the interior
   * room → (zones) show the content panel over it → a Leave button. The player
   * world is frozen (GameScene.update), so leaving drops them back at the door.
   */
  // Short content shown on the interior side walls so entering a building
  // actually SHOWS the portfolio, not just its name (the full panel still opens).
  private static readonly INTERIOR_CONTENT: Record<string, [string, string]> = {
    welcome: ['5 districts\nto explore', 'Hand-built\nin Three.js'],
    professional: ['Abbas Ali\nFull-stack\nAI builder', 'Next.js · TS\nFirebase\nPython'],
    projects: ['RankPilot\nlive AI-SEO\nplatform', 'ChocoMate\nBano’s\nInsta Services'],
    personal: ['Food · Family\nCreative\ntooling', 'Melbourne,\nAustralia'],
    contact: ['Work with\nDigiScalability', 'admin@\ndigiscalability\n.com'],
  };

  // Which themed furniture set each zone building opens into (houses → cottage).
  private static readonly INTERIOR_THEMES: Record<string, string> = {
    welcome: 'hall',
    professional: 'office',
    projects: 'workshop',
    personal: 'home',
    contact: 'post',
  };

  // What building the player is currently inside (for hotspot actions + leave).
  private insideZone: { id: string; name: string } | null = null;
  private insideIsZone = false;

  /** Execute the interior hotspot the player pressed E on. */
  private runInteriorAction(hs: { action: string; text?: string }): void {
    if (hs.action === 'leave') {
      this.exitBuilding(this.insideIsZone);
    } else if (hs.action === 'room') {
      // Fixtures that change the room itself. GameScene owns the state and
      // returns the line to flash, so the two stay in step.
      this.ui.flashMessage(this.scene.toggleInteriorFixture(hs.text ?? ''));
    } else if (hs.action === 'times') {
      void this.ui.showIslandTimes();
    } else if (hs.action === 'watch') {
      // The beach-house wall screen: ask what to watch, then hand the wall
      // to a sandboxed browser frame while the interior camera takes the
      // cinema shot. Game audio ducks under whatever plays.
      this.watchOpenedAt = performance.now();
      this.ui.showWatchPicker((url) => {
        this.watchOpenedAt = performance.now();
        this.scene.startInteriorWatch();
        sfx.duckForVoice(true);
        this.ui.showWatchFrame(url, () => {
          this.scene.stopInteriorWatch();
          sfx.duckForVoice(false);
        });
      });
    } else if (hs.action === 'panel' && this.insideZone) {
      this.ui.showZonePanel(
        { id: this.insideZone.id, name: this.insideZone.name },
        { source: 'proximity' },
      );
    } else if (hs.text) {
      this.ui.flashMessage(hs.text);
    }
  }

  private enterBuilding(id: string, isZone: boolean, zone?: { id: string; name: string }): void {
    if (this.scene.isInsideInterior()) return;
    const d = DISTRICTS.find((x) => x.id === id);
    const islet = !isZone && id.startsWith('islet_');
    const title = isZone
      ? (zone?.name ?? d?.name ?? id)
      : islet
        ? "Brother's Beach House"
        : 'A cosy home';
    const wall = isZone ? (d?.accent ?? 0xcfc4ae) : islet ? 0x9fd0dc : 0xe0c9a8;
    const theme = isZone ? (SimpleApp.INTERIOR_THEMES[id] ?? 'hall') : islet ? 'beach' : 'cottage';
    this.insideZone = isZone ? (zone ?? { id, name: title }) : null;
    this.insideIsZone = isZone;
    const [left, right] = isZone
      ? (SimpleApp.INTERIOR_CONTENT[id] ?? ['', ''])
      : islet
        ? ['Across the\nwater', 'Waves at\nthe door']
        : ['A place to\nrest', 'Someone\nlives here'];
    sfx.blip();
    this.markDone('ds_entered_building');
    this.ui.fadeThrough(() => {
      this.scene.enterInterior(title, wall, left, right, theme, isZone ? undefined : id);
      if (isZone && zone) {
        this.ui.showZonePanel({ id: zone.id, name: zone.name }, { source: 'proximity' });
      }
      this.ui.showLeaveButton(() => this.exitBuilding(isZone));
    });
  }

  private exitBuilding(isZone: boolean): void {
    this.ui.closeWatchFrame(); // stop any wall-screen playback (fires onClose)
    this.ui.fadeThrough(() => {
      this.scene.exitInterior();
      this.ui.hideLeaveButton();
      if (isZone) this.ui.hideZonePanel();
    });
  }

  /** Open a section directly from a /?zone=<id> deep link, if present + valid. */
  /** Open a ?zone= deep link. Returns true when a panel was opened (the
   *  caller then skips the welcome modal — shared content comes first). */
  private openDeepLinkZone(): boolean {
    try {
      const z = new URLSearchParams(location.search).get('zone');
      if (!z) return false;
      if (['welcome', 'professional', 'projects', 'personal', 'contact'].includes(z)) {
        this.ui.hideWelcome();
        this.ui.showZonePanel({ id: z, name: z }, { source: 'deeplink' });
        return true;
      }
    } catch {
      /* ignore */
    }
    return false;
  }

  /**
   * Lazy naming: run `then` once the visitor has a name, prompting only the
   * first time a social feature (race leaderboard, chat) actually needs one.
   * An empty name from the prompt (skip) proceeds anonymously without saving.
   */
  private ensureNamed(then: () => void): void {
    try {
      if (localStorage.getItem('ds_player_name')) {
        then();
        return;
      }
    } catch {
      /* no storage — proceed to prompt */
    }
    this.ui.promptName('', (name) => {
      if (name) {
        this.multiplayer?.setName(name);
        saveProfile({ name });
      }
      then();
    });
  }

  private setupDebugShortcuts(): void {
    if (this.boundHandlers.debugKeydown) return;

    const handler = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.key.toLowerCase() === 'b') {
        event.preventDefault();
        if (!this.renderer.isPostProcessingAvailable()) {
          console.log('✨ Bloom unavailable on this device tier (no composer).');
          return;
        }
        // toggleBloom, not the old togglePostProcessing: that flipped the whole
        // COMPOSER — the render-path switch whose 21% brightness step this
        // message then attributed to "bloom". The composer now stays resident
        // for the whole session everywhere; Ctrl+B toggles the pass it names.
        const enabled = this.renderer.toggleBloom();
        console.log(
          enabled
            ? '✨ Bloom enabled (Ctrl+B to toggle).'
            : '✨ Bloom disabled (Ctrl+B to toggle).',
        );
      } else if (event.key.toLowerCase() === 'c') {
        // Toggle the appearance editor
        if (this.ui['customizeDiv']) {
          this.ui.hideCustomize();
        } else {
          this.openCustomize();
        }
      } else if (event.key.toLowerCase() === 'p' && !event.ctrlKey && !event.metaKey) {
        // Photo mode — but not while typing in chat / the name field.
        const el = document.activeElement as HTMLElement | null;
        const typing =
          el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
        if (!typing) {
          event.preventDefault();
          void this.capturePhoto();
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
    // Signals the boot guard in index.html that the app really is running, so
    // it stands down (a late error must not blank a playable game). Distinct
    // from __lifeIslandBooted, which is set before construction as a
    // double-boot latch and so can't prove init succeeded.
    (window as unknown as { __lifeIslandReady?: boolean }).__lifeIslandReady = true;
    // Funnel denominator: pageviews vs world_ready shows how many visitors
    // actually got the 3D scene running (device/WebGL compatibility signal).
    // `ms` is time-to-interactive from navigation start — the cold-start cost.
    performance.mark('boot:world-ready');
    // world_gen measure exists whenever init() got as far as the GameScene.
    const genMeasure = performance.getEntriesByName('world_gen')[0];
    trackOnce('world_ready', {
      touch: this.ui.isTouchDevice(),
      ms: Math.round(performance.now()),
      // The synchronous world-generation slice of that total — the tunable part.
      genMs: genMeasure ? Math.round(genMeasure.duration) : -1,
    });
    // Begin dwell tracking now that the world is up (fires session_end on leave).
    startDwellTracking();

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

    // Juice kernel: advance all micro-tweens (hat pops, squash-stretch,
    // pickup ceremonies). Here, not GameScene.update — this always runs
    // (interior mode early-returns would freeze a mid-pop tween).
    juiceTick(deltaTime);

    // Completion meter: recompute on a slow cadence (plus immediately at each
    // flag site) so passport stamps landed elsewhere still surface here.
    // The secret-spot proximity sweep rides the same 2.5s cadence — nine
    // distance checks against static points, effectively free.
    this.completionAccum += deltaTime;
    if (this.completionAccum > 2.5) {
      this.completionAccum = 0;
      this.refreshCompletion();
      this.sweepSecrets();
    }

    // Only process input once the loader and welcome screen are gone
    if (!this.ui.isWelcomeVisible() && !this.ui.isLoadingVisible()) {
      // In-person dialogue upkeep: release the hold when every conversation
      // panel is gone (covers the canned panel, which has no close callback),
      // and drive the push-in/release camera rail while it owns the camera.
      if (this.npcDialogueName && !this.ui.isNpcChatOpen() && !this.ui.isDialogueActive()) {
        this.endNpcDialogue();
      }
      if (this.npcCine) this.updateNpcCine(deltaTime);
      // Cinematic tour: the rail owns the camera and the player stands still.
      // Everything else in the world keeps running (that's the point of it).
      if (this.tour) {
        this.scene.setPlayerMovement(0, 0);
        this.ui.hideInteractionPrompt();
        this.updateTour(deltaTime);
      } else if (this.scene.isInsideInterior()) {
        if (this.ui.isWatchOpen()) {
          // Watching the wall screen (or picking): the room holds still, the
          // frame stays pinned to the in-world TV, and E steps away from it.
          // The 0.5s guard means the press that OPENED the screen can never
          // be the press that closes it, however the frames interleave.
          this.scene.setInteriorMove(0, 0);
          this.ui.hideInteractionPrompt();
          const rect = this.scene.getInteriorScreenRect();
          if (rect) this.ui.positionWatchFrame(rect);
          if (
            performance.now() - this.watchOpenedAt > 500 &&
            this.inputManager.consumeKeyPress('e')
          ) {
            sfx.blip();
            this.ui.closeWatchFrame();
          }
        } else {
          // Inside a building: the world is frozen; WASD/joystick walks the
          // room (GameScene's interior mode) and E interacts with the hotspot.
          const moveInput = this.inputManager.getMovementInput();
          const joy = this.ui.getJoystick();
          this.scene.setInteriorMove(
            Math.max(-1, Math.min(1, moveInput.forward + joy.forward)),
            Math.max(-1, Math.min(1, moveInput.strafe + joy.strafe)),
          );
          const hs = this.scene.getInteriorHotspot();
          if (hs) {
            this.ui.showInteractionPrompt(hs.label);
            if (this.inputManager.consumeKeyPress('e')) {
              sfx.blip();
              this.runInteriorAction(hs);
            }
          } else {
            this.ui.hideInteractionPrompt();
          }
        }
      } else if (this.ui.isDialogueActive() || this.ui.isNpcChatOpen()) {
        // A conversation is open (canned panel or AI chat): you're standing
        // WITH someone — movement is suppressed, the villager is held, and
        // the camera two-shot completes the in-person framing.
        this.scene.setPlayerMovement(0, 0);
        this.ui.hideInteractionPrompt();
        const cameraInput = this.inputManager.getCameraInput();
        this.scene.setCameraInput(cameraInput.deltaX, cameraInput.deltaY);

        if (this.ui.isDialogueActive()) {
          if (this.inputManager.consumeKeyPress('e')) {
            sfx.blip();
            this.ui.advanceDialogue();
          }
          // Drifting apart closes dialogue. Track the ACTUAL conversation
          // partner by name, not getNearbyInteractable — the old nearest-
          // interactable check closed the panel whenever a bench/lamp stood
          // marginally closer than the (now held-in-place) villager.
          if (this.npcDialogueName) {
            const npcPos = this.scene.getNpcPosition(this.npcDialogueName);
            const playerPos = this.scene.getPlayer()?.getWorldPosition();
            if (!npcPos || !playerPos || npcPos.distanceTo(playerPos) > 4.5) {
              this.ui.hideDialogue();
            }
          } else {
            const nearby = this.scene.getNearbyInteractable();
            if (!nearby || nearby.type !== 'npc') {
              this.ui.hideDialogue();
            }
          }
        } else {
          // AI chat: sustained walk intent (joystick, or WASD with the input
          // unfocused) steps out of the conversation — the mobile escape
          // hatch, since suppressed movement can't trigger a walk-away.
          const moveInput = this.inputManager.getMovementInput();
          const joy = this.ui.getJoystick();
          const mag =
            Math.abs(moveInput.forward + joy.forward) + Math.abs(moveInput.strafe + joy.strafe);
          this.chatWalkAwayT = mag > 0.4 ? this.chatWalkAwayT + deltaTime : 0;
          if (this.chatWalkAwayT > 0.45) {
            this.chatWalkAwayT = 0;
            this.ui.closeNpcChat();
          }
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
      } else if (this.scene.isRidingVehicle()) {
        // Driving a boat/jetski: WASD/joystick steers the craft; E hops off
        const moveInput = this.inputManager.getMovementInput();
        const joy = this.ui.getJoystick();
        const vFwd = Math.max(-1, Math.min(1, moveInput.forward + joy.forward));
        const vStrafe = Math.max(-1, Math.min(1, moveInput.strafe + joy.strafe));
        this.scene.setVehicleMove(vFwd, vStrafe);
        this.currentThrottle = Math.max(Math.abs(vFwd), Math.abs(vStrafe) * 0.5);
        const cameraInput = this.inputManager.getCameraInput();
        this.scene.setCameraInput(cameraInput.deltaX, cameraInput.deltaY);
        this.ui.showInteractionPrompt('🚤 Press <strong>E</strong> to hop off');
        if (this.inputManager.consumeKeyPress('e')) {
          this.scene.disembarkVehicle();
          this.ui.hideInteractionPrompt();
        }
        this.ui.updateBreath(1, false);
        this.ui.setUnderwater(this.scene.getSubmergedFactor());
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
        // Swim: hold Space to stay afloat in water (same key jumps on land)
        if (player) player.setSwimIntent(jumpInput);
        // Free dive: hold Shift in water to swim DOWN. Independent of Space,
        // so you can hold both; the dive branch outranks the float branch.
        if (player) {
          player.setDiveIntent(this.inputManager.getDiveInput());
          // The touch DIVE button appears only while actually swimming.
          this.ui.setAuxActionAvailable('dive', player.isSwimming());
        }
        // HOLD Space while moving = run (stamina-gated). Tap stays jump —
        // held Space never re-jumps, so the two share the key cleanly.
        if (player) {
          const runMag =
            Math.abs(moveInput.forward + joy.forward) + Math.abs(moveInput.strafe + joy.strafe);
          player.setRunIntent(jumpInput && runMag > 0.3);
          this.ui.updateStamina(player.getStamina(), player.isRunning());
          // One-time nudge: winded while carrying food → teach the G/eat verb.
          if (
            player.getStamina() < 0.15 &&
            this.meals.pie + this.meals.fish + this.meals.soup > 0
          ) {
            try {
              if (!localStorage.getItem('ds_hint_eat')) {
                localStorage.setItem('ds_hint_eat', '1');
                this.ui.toast('😮‍💨 Winded? Press G to eat and restore stamina.');
              }
            } catch {
              /* no storage */
            }
          }
        }
        if (jumpInput && player && !player.isInWater()) {
          // Edge-triggered: one blip per press, only from the ground
          if (player.isOnGround() && !this.prevJumpHeld) sfx.jump();
          this.scene.playerJump();
        }
        this.prevJumpHeld = jumpInput;
        // Breath meter + underwater vignette
        if (player) this.ui.updateBreath(player.getOxygen(), player.isInWater());
        // Camera-submersion wash (independent of the player: the chase cam can
        // dip under a wave while the swimmer's head is still above it)
        this.ui.setUnderwater(this.scene.getSubmergedFactor());
        // Shoreline barrier: nudge the swimmer back with a throttled hint
        if (player && player.isBeyondSwimLimit()) {
          const now = performance.now();
          if (now - this.lastSwimWarnAt > 4500) {
            this.lastSwimWarnAt = now;
            this.ui.flashMessage('🌊 The current pulls you back to shore');
          }
        }

        // Wave at nearby visitors — peers see it, and the townsfolk wave back
        if (this.inputManager.consumeKeyPress('q')) {
          this.multiplayer?.wave();
          this.scene.greetNearbyNPCs();
          sfx.blip();
        }

        // Scatter a handful of bird feed ahead of you; nearby birds fly in
        if (this.inputManager.consumeKeyPress('f')) this.tossFeed();

        // Eat a cooked meal to restore stamina (G — the new food verb)
        if (this.inputManager.consumeKeyPress('g')) this.eatMeal();

        // Full island map (same as tapping the radar)
        if (this.inputManager.consumeKeyPress('m')) this.openIslandMap();

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
          const onFoot = speed > 0.8 && this.airborneTime < 0.12;
          // Prefer clip-synced footfalls: the avatar exposes its normalised
          // walk-cycle phase (added by the avatar rig this wave). Firing on the
          // two mid-stride plants locks footsteps to the animation instead of a
          // distance accumulator that visibly drifts as speed varies. The getter
          // is optional — fall back to the accumulator when it's absent.
          const walkPhase = (player as { getWalkCyclePhase?: () => number }).getWalkCyclePhase?.();
          if (typeof walkPhase === 'number') {
            if (onFoot) {
              // Two footfalls per cycle; alt-foot falls out of which plant fired.
              if (this.crossedPhase(this.prevWalkPhase, walkPhase, 0.25)) {
                this.stepAlt = false;
                sfx.footstep(this.stepAlt);
                this.scene.spawnDust(player.getWorldPosition(), 1);
              }
              if (this.crossedPhase(this.prevWalkPhase, walkPhase, 0.75)) {
                this.stepAlt = true;
                sfx.footstep(this.stepAlt);
                this.scene.spawnDust(player.getWorldPosition(), 1);
              }
              this.prevWalkPhase = walkPhase;
            } else {
              // Not striding: reset so a resumed walk never fires from a stale phase.
              this.prevWalkPhase = -1;
            }
          } else if (onFoot) {
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
        let buildOpp: ReturnType<SimpleApp['nearestBuildOpportunity']> = null;
        const board = this.scene.nearestBoardable();
        const nearby = this.scene.getNearbyInteractable();
        // Nearest thing wins: the vehicle only takes the prompt when it is
        // actually the closest interactable — a parked car used to shadow
        // every NPC, mailbox and cottage door within its 3.2u board range.
        if (board.idx >= 0 && board.dist < (nearby?.distance ?? Infinity)) {
          // A vehicle is within reach (swim up to craft / walk up to a car)
          const kind = this.scene.vehicleKind(board.idx);
          const icon = kind === 'jetski' ? '🌊' : kind === 'car' ? '🚗' : '⛵';
          const verb = kind === 'car' ? 'drive' : 'ride';
          this.ui.showInteractionPrompt(`${icon} Press <strong>E</strong> to ${verb}`);
          if (this.inputManager.consumeKeyPress('e')) {
            this.scene.boardVehicle(board.idx);
            sfx.blip();
            track('vehicle_enter', { kind });
          }
        } else if (player && player.isInWater() && !player.isSwimming()) {
          // In the water and sinking: tell them how to swim
          this.ui.showInteractionPrompt('🏊 Hold <strong>Space</strong> to swim');
        } else if (this.scene.isFishingActive()) {
          // Line is in the water: reeling outranks every other interaction.
          this.ui.showInteractionPrompt(
            this.scene.isFishBiting()
              ? '❗ Press <strong>E</strong> — something is biting!'
              : '🎣 Press <strong>E</strong> to reel in',
          );
          if (this.inputManager.consumeKeyPress('e')) {
            if (this.scene.reelLine() === 'fish') {
              this.fishCaught++;
              this.persistFish();
              sfx.coin();
              this.ui.toast(`🐟 Caught one! (${this.fishCaught} in the basket)`);
              track('fish_caught', { held: this.fishCaught });
            } else {
              sfx.blip();
              this.ui.toast('…nothing yet. Wait for the float to dip.');
            }
          }
        } else if (this.fishCaught > 0 && this.scene.isNearFisherman()) {
          // Selling to the fisherman: the economy's first coin SOURCE. Wins
          // over the generic NPC prompt only while there's fish to sell.
          const { full: fFull, earn: fEarn } = saleSplit(
            this.fishCaught,
            this.dailySold('ds_fish_day', 0),
            SimpleApp.DAILY_SELL_CAP,
            this.featuredPrice('fisherman', SimpleApp.FISH_SELL_PRICE),
            SimpleApp.FISH_SATIATED_PRICE,
          );
          this.ui.showInteractionPrompt(
            `${this.featuredStar('fisherman')}🐟 Press <strong>E</strong> to sell ${this.fishCaught} fish (+${fEarn} 🪙)${fFull === 0 ? ' · icebox full' : ''}`,
          );
          if (this.inputManager.consumeKeyPress('e')) {
            // Icebox satiation (approved economy spec): first 10/day at full
            // price, the rest at 1c — surfaced diegetically so it never reads
            // as a bug.
            const overflow = this.fishCaught - fFull;
            const earned = fEarn;
            this.scene.addCoins(earned);
            this.dailySold('ds_fish_day', this.fishCaught);
            track('fish_sold', { count: this.fishCaught, earned, satiated: overflow > 0 });
            const fpos = this.scene.fishermanPos();
            if (fpos) this.scene.sellHandoff(fpos, { coins: earned, providerName: null });
            this.fishCaught = 0;
            this.persistFish();
            sfx.coin();
            this.ui.toast(
              overflow > 0
                ? `🪙 +${earned} — "Icebox is full — ${SimpleApp.FISH_SATIATED_PRICE} coin each now."`
                : `🪙 +${earned} — the fisherman tips his hat.`,
            );
          }
        } else if (this.timber > 0 && this.scene.isNearCarpenter()) {
          const { full: fullPriced } = saleSplit(
            this.timber,
            this.dailySold('ds_timber_day', 0),
            SimpleApp.DAILY_SELL_CAP,
            SimpleApp.TIMBER_SELL_PRICE,
            SimpleApp.TIMBER_SATIATED_PRICE,
          );
          // Tranche: while full-price allowance remains, one press sells ONLY
          // the full-priced logs — one tap used to launder a whole gazebo's
          // savings into the 1-coin satiated bin. The satiated tail (and any
          // sale while a build is within reach) needs an armed second press.
          const tranche = fullPriced > 0 ? fullPriced : this.timber;
          const trancheEarn =
            fullPriced > 0
              ? fullPriced * this.featuredPrice('carpenter', SimpleApp.TIMBER_SELL_PRICE)
              : this.timber * SimpleApp.TIMBER_SATIATED_PRICE;
          const couldBuild = this.timber >= 3 && this.scene.freePlotSummary().length > 0;
          const needsArm = couldBuild || fullPriced === 0;
          const armed = performance.now() / 1000 - this.timberSellArmedAt < 3;
          this.ui.showInteractionPrompt(
            needsArm && !armed
              ? `${this.featuredStar('carpenter')}🪵 Press <strong>E</strong> to sell ${tranche} timber (+${trancheEarn} 🪙)${fullPriced === 0 ? ' · rack stocked' : ''} — or keep it: 🔨 builds start at 3 🪵`
              : `🪵 Press <strong>E</strong>${needsArm ? ' again' : ''} to sell ${tranche} timber (+${trancheEarn} 🪙)${fullPriced === 0 ? ' · rack stocked' : ''}`,
          );
          if (this.inputManager.consumeKeyPress('e')) {
            if (needsArm && !armed) {
              this.timberSellArmedAt = performance.now() / 1000;
              sfx.blip();
            } else {
              this.timberSellArmedAt = 0;
              this.scene.addCoins(trancheEarn);
              this.dailySold('ds_timber_day', tranche);
              const cpos = this.scene.carpenterRackPos();
              if (cpos)
                this.scene.sellHandoff(cpos, {
                  coins: trancheEarn,
                  providerName: 'Carpenter',
                  line: 'Fine timber — much obliged.',
                });
              track('timber_sold', {
                count: tranche,
                earned: trancheEarn,
                satiated: fullPriced === 0,
              });
              this.timber -= tranche;
              this.persistTimber();
              sfx.coin();
              this.ui.toast(
                fullPriced === 0
                  ? `🪙 +${trancheEarn} — "Rack's stocked — ${SimpleApp.TIMBER_SATIATED_PRICE} coin each now."`
                  : `🪙 +${trancheEarn} — the carpenter nods approvingly.`,
              );
              if (this.timber >= 3) {
                this.ui.toast(`🪧 "That'd make a fine signpost," the carpenter says.`);
              }
            }
          }
        } else if (this.wheat > 0 && this.scene.isNearBaker()) {
          const { full: wFull, earn: wEarn } = saleSplit(
            this.wheat,
            this.dailySold('ds_wheat_day', 0),
            SimpleApp.DAILY_SELL_CAP,
            this.featuredPrice('baker', SimpleApp.WHEAT_SELL_PRICE),
            SimpleApp.WHEAT_SATIATED_PRICE,
          );
          this.ui.showInteractionPrompt(
            `${this.featuredStar('baker')}🌾 Press <strong>E</strong> to sell ${this.wheat} wheat (+${wEarn} 🪙)${wFull === 0 ? ' · ovens full' : ''}`,
          );
          if (this.inputManager.consumeKeyPress('e')) {
            this.scene.addCoins(wEarn);
            this.dailySold('ds_wheat_day', this.wheat);
            track('wheat_sold', { count: this.wheat, earned: wEarn });
            const bpos = this.scene.bakerPos();
            if (bpos)
              this.scene.sellHandoff(bpos, {
                coins: wEarn,
                providerName: 'Village Baker',
                line: 'Fresh sheaves! Straight to the oven.',
              });
            this.wheat = 0;
            this.persistHarvest();
            sfx.coin();
            this.ui.toast(
              wFull === 0
                ? `🪙 +${wEarn} — "Ovens are full — 1 coin a sheaf now."`
                : `🪙 +${wEarn} — the baker beams at the fresh sheaves.`,
            );
          }
        } else if (this.produce > 0 && this.scene.isNearCanteen()) {
          const { full: pFull, earn: pEarn } = saleSplit(
            this.produce,
            this.dailySold('ds_produce_day', 0),
            SimpleApp.DAILY_SELL_CAP,
            this.featuredPrice('canteen', SimpleApp.PRODUCE_SELL_PRICE),
            SimpleApp.PRODUCE_SATIATED_PRICE,
          );
          this.ui.showInteractionPrompt(
            `${this.featuredStar('canteen')}🥬 Press <strong>E</strong> to sell ${this.produce} produce (+${pEarn} 🪙)${pFull === 0 ? ' · pot brimming' : ''}`,
          );
          if (this.inputManager.consumeKeyPress('e')) {
            this.scene.addCoins(pEarn);
            this.dailySold('ds_produce_day', this.produce);
            track('produce_sold', { count: this.produce, earned: pEarn });
            const cpos2 = this.scene.canteenPos();
            if (cpos2) this.scene.sellHandoff(cpos2, { coins: pEarn, providerName: null });
            this.produce = 0;
            this.persistHarvest();
            sfx.coin();
            this.ui.toast(
              pFull === 0
                ? `🪙 +${pEarn} — "Pot's already brimming — 1 coin each."`
                : `🪙 +${pEarn} — the canteen crew cheers the fresh veg.`,
            );
          }
        } else if (this.produce > 0 && this.scene.isNearMarketVendor()) {
          // Grocer: a SECOND produce outlet across the districts — SHARES the
          // canteen's ds_produce_day cap (two locations, one faucet: farm
          // output stays 60c/day, never doubled).
          const { full: gFull, earn: gEarn } = saleSplit(
            this.produce,
            this.dailySold('ds_produce_day', 0),
            SimpleApp.DAILY_SELL_CAP,
            SimpleApp.PRODUCE_SELL_PRICE,
            SimpleApp.PRODUCE_SATIATED_PRICE,
          );
          this.ui.showInteractionPrompt(
            `🥕 Press <strong>E</strong> to sell ${this.produce} produce (+${gEarn} 🪙)${gFull === 0 ? ' · stall stocked' : ''}`,
          );
          if (this.inputManager.consumeKeyPress('e')) {
            this.scene.addCoins(gEarn);
            this.dailySold('ds_produce_day', this.produce);
            track('produce_sold', { count: this.produce, earned: gEarn, at: 'grocer' });
            const gpos = this.scene.marketVendorPos();
            if (gpos)
              this.scene.sellHandoff(gpos, {
                coins: gEarn,
                providerName: 'Market Vendor',
                line: 'Lovely veg — the stall thanks you.',
              });
            this.produce = 0;
            this.persistHarvest();
            sfx.coin();
            this.ui.toast(
              gFull === 0
                ? `🪙 +${gEarn} — "Stall's stocked — 1 coin each now."`
                : `🪙 +${gEarn} — the grocer weighs your basket and smiles.`,
            );
          }
        } else if (this.scene.isNearCanteen()) {
          // Empty-handed at the canteen: BUY a bowl of soup (the faceless cart
          // is now two-way). Reachable only when produce === 0 (the sell
          // branch above consumes that case).
          this.ui.showInteractionPrompt(
            '🥣 Press <strong>E</strong> to buy soup (3 🪙) — eat with G',
          );
          if (this.inputManager.consumeKeyPress('e')) {
            if (!this.scene.spendCoins(SimpleApp.SOUP_PRICE)) {
              this.ui.toast('🪙 Soup is 3 coins.');
            } else {
              this.meals.soup++;
              this.persistMeals();
              this.refreshFeedHud();
              sfx.coin();
              track('meal_bought', { kind: 'soup', at: 'canteen' });
              this.ui.toast('🥣 A warm bowl — press G when your legs need it.');
            }
          }
        } else if (this.ore > 0 && this.scene.isNearBank()) {
          const { full: oFull, earn: oEarn } = saleSplit(
            this.ore,
            this.dailySold('ds_ore_day', 0),
            SimpleApp.DAILY_SELL_CAP,
            this.featuredPrice('bank', SimpleApp.ORE_SELL_PRICE),
            SimpleApp.ORE_SATIATED_PRICE,
          );
          this.ui.showInteractionPrompt(
            `${this.featuredStar('bank')}⛏️ Press <strong>E</strong> to assay ${this.ore} ore (+${oEarn} 🪙)${oFull === 0 ? ' · assay stocked' : ''}`,
          );
          if (this.inputManager.consumeKeyPress('e')) {
            this.scene.addCoins(oEarn);
            this.dailySold('ds_ore_day', this.ore);
            track('ore_sold', { count: this.ore, earned: oEarn });
            const opos = this.scene.bankPos();
            if (opos)
              this.scene.sellHandoff(opos, {
                coins: oEarn,
                providerName: 'Teller',
                line: 'Assayed and weighed — good ore.',
              });
            this.ore = 0;
            this.persistOre();
            sfx.coin();
            this.ui.toast(
              oFull === 0
                ? `🪙 +${oEarn} — "Assay office is stocked — 1 coin each now."`
                : `🪙 +${oEarn} — the teller weighs the ore approvingly.`,
            );
          }
        } else if (this.lessons.length < SimpleApp.LESSONS.length && this.scene.isNearSchool()) {
          const next = SimpleApp.LESSONS.find(([id]) => !this.lessons.includes(id));
          if (next) {
            this.ui.showInteractionPrompt(
              `📚 Press <strong>E</strong> to take lesson ${this.lessons.length + 1}/${SimpleApp.LESSONS.length} (+10 🪙)`,
            );
            if (this.inputManager.consumeKeyPress('e')) {
              this.lessons.push(next[0]);
              this.persistLessons();
              this.scene.addCoins(10);
              sfx.coin();
              this.ui.toast(next[1]);
              track('lesson_done', { id: next[0], total: this.lessons.length });
            }
          }
        } else if (
          (buildOpp = this.nearestBuildOpportunity()) !== null &&
          // A far/unaffordable stake is only an ADVERT — never let it shadow
          // an actionable tool prompt (the farm's edge stake was eclipsing
          // "Press E to harvest" for sickle owners standing in the crops).
          (buildOpp.dist < 3.5 ||
            !(
              (this.ownedAxe && this.scene.nearestChoppableTree() !== null) ||
              (this.ownedSickle && this.scene.nearestHarvestableCrop() !== null) ||
              (this.ownedPickaxe && this.scene.nearestOreNode() !== null)
            ))
        ) {
          const b = buildOpp;
          if (b.own) {
            // Your own structure: reclaim/replace options.
            this.ui.showInteractionPrompt(
              `${b.icon} Your ${b.name} — press <strong>E</strong> for options`,
            );
            if (this.inputManager.consumeKeyPress('e')) this.openBuildOptions(b.plot);
          } else if (b.system === 'build' && b.dist < 3.5) {
            // The chooser IS the confirm: E opens it whether or not anything
            // is affordable — the rows explain themselves (shortfall lines).
            this.ui.showInteractionPrompt(
              `🔨 Press <strong>E</strong> to build here — choose what to raise`,
            );
            if (this.inputManager.consumeKeyPress('e')) this.openBuildChooser(b.plot);
          } else if (b.system === 'bench' && b.dist < 3.5) {
            if (b.affordable) {
              this.ui.showInteractionPrompt(
                `${b.icon} Press <strong>E</strong> to build a ${b.name} here (${b.timber} 🪵 + ${b.coins} 🪙) — everyone will see it`,
              );
              if (this.inputManager.consumeKeyPress('e')) void this.buildHere(b);
            } else {
              this.ui.showInteractionPrompt(
                `${b.icon} A ${b.name} could go here — needs ${b.timber} 🪵 + ${b.coins} 🪙 (you have ${this.timber} 🪵, ${this.scene.getCoinsCollected()} 🪙)`,
              );
            }
          } else {
            // 3.5-6u: the stake advertises itself from a distance.
            this.ui.showInteractionPrompt(
              b.system === 'build'
                ? `🔨 A build stake is just ahead — walk up to choose what to raise`
                : `${b.icon} A ${b.name} plot is just ahead (${b.timber} 🪵 + ${b.coins} 🪙)`,
            );
          }
        } else if (this.scene.isNearHospital()) {
          this.ui.showInteractionPrompt(
            '🏥 Press <strong>E</strong> to get a checkup (10 🪙 · 60s speed boost)',
          );
          if (this.inputManager.consumeKeyPress('e')) {
            if (!this.scene.spendCoins(10)) {
              this.ui.toast('🪙 Checkups are 10 coins.');
            } else {
              this.scene.getPlayer()?.setSprintUntil(performance.now() / 1000 + 60);
              sfx.coin();
              track('checkup', {});
              this.ui.toast('🏥 "All clear! Off you go — briskly, now."');
            }
          }
        } else if (this.scene.isNearBank()) {
          this.ui.showInteractionPrompt('🏦 Press <strong>E</strong> to visit the vault');
          if (this.inputManager.consumeKeyPress('e')) void this.openVault();
        } else if (this.scene.isNearKiosk()) {
          this.ui.showInteractionPrompt('🛒 Press <strong>E</strong> to browse the kiosk');
          if (this.inputManager.consumeKeyPress('e')) {
            sfx.blip();
            this.openShop();
          }
        } else if (this.scene.isNearNoticeBoard()) {
          this.ui.showInteractionPrompt('📰 Press <strong>E</strong> to read the Island Times');
          if (this.inputManager.consumeKeyPress('e')) void this.ui.showIslandTimes();
        } else if (nearby) {
          // Show interaction prompt
          let text = '⌨️ Press <strong>E</strong> to interact';
          if (nearby.type === 'mailbox') {
            // State-aware copy: the glowing mailbox's prompt should CONFIRM
            // "this is the one" — the old generic line never did.
            text = nearby.mailbox.bubbleText
              ? esc(nearby.mailbox.bubbleText)
              : nearby.mailbox.hasDelivery
                ? '📬 Press <strong>E</strong> to collect the delivery'
                : '📭 Press <strong>E</strong> to check the mailbox';
          } else if (nearby.type === 'lamp') {
            text = '💡 Press <strong>E</strong> to toggle the lamp';
          } else if (nearby.type === 'zone') {
            text = `🚪 Press <strong>E</strong> to enter ${esc(nearby.zone.name)}`;
          } else if (nearby.type === 'house_door') {
            text = '🚪 Press <strong>E</strong> to enter';
          } else if (nearby.type === 'npc') {
            // AI townsfolk advertise free-text chat — "talk" alone reads as a
            // canned dialogue tree, and visitors never discover the real LLM.
            text = isAiNpc(nearby.npcData.name)
              ? `💬 Press <strong>E</strong> to talk to <strong>${esc(nearby.npcData.name)}</strong> — ask anything`
              : `💬 Press <strong>E</strong> to talk to <strong>${esc(nearby.npcData.name)}</strong>`;
          } else if (nearby.type === 'bench') {
            text = '🪑 Press <strong>E</strong> to sit down';
          }
          this.ui.showInteractionPrompt(text);

          if (this.inputManager.consumeKeyPress('e')) {
            this.scene.interactWith(nearby);
          }
        } else if (this.ownedAxe && this.scene.nearestChoppableTree()) {
          const t = this.scene.nearestChoppableTree();
          const swing = (t?.hits ?? 0) + 1;
          this.ui.showInteractionPrompt(
            `🪓 Press <strong>E</strong> to chop (${Math.min(swing, 3)}/3)`,
          );
          if (this.inputManager.consumeKeyPress('e')) {
            const r = this.scene.chopNearestTree(performance.now() / 1000);
            if (r?.felled) {
              this.timber += r.timber;
              this.persistTimber();
              this.ui.toast(`🪵 Timber! +${r.timber} (${this.timber} in the pack)`);
              track('tree_felled', { timber: this.timber });
            }
          }
        } else if (this.ownedSickle && this.scene.nearestHarvestableCrop() !== null) {
          const idx = this.scene.nearestHarvestableCrop()!;
          const kind = this.scene.getIslandFarmCropKind(idx);
          this.ui.showInteractionPrompt(
            kind === 'wheat'
              ? '🌾 Press <strong>E</strong> to cut wheat'
              : `🥬 Press <strong>E</strong> to harvest ${kind}`,
          );
          if (this.inputManager.consumeKeyPress('e')) {
            const r = this.scene.harvestNearestCrop(performance.now() / 1000);
            if (r) {
              if (r.yieldKind === 'wheat') this.wheat += r.yieldN;
              else this.produce += r.yieldN;
              this.persistHarvest();
              track('crop_harvested', { kind: r.kind });
              this.ui.toast(
                r.yieldKind === 'wheat'
                  ? `🌾 Wheat! +${r.yieldN} (${this.wheat} in the pack) — the Baker buys these.`
                  : `🥬 ${r.kind}! +${r.yieldN} (${this.produce} in the pack) — the canteen buys these.`,
              );
            }
          }
        } else if (this.ownedPickaxe && this.scene.nearestOreNode() !== null) {
          const hits = this.scene.getOreNodeHits();
          this.ui.showInteractionPrompt(
            `⛏️ Press <strong>E</strong> to mine (${Math.min(hits + 1, 4)}/4)`,
          );
          if (this.inputManager.consumeKeyPress('e')) {
            const r = this.scene.mineNearestNode(performance.now() / 1000);
            if (r && r.ore > 0) {
              this.ore += r.ore;
              this.persistOre();
              track('ore_mined', { total: this.ore });
              this.ui.toast(`⛏️ Ore! +${r.ore} (${this.ore} in the pack) — the bank assays these.`);
            }
          }
        } else if (this.ownedRod && this.scene.canCastHere()) {
          // Lowest interaction priority: NPCs, mailboxes and doors all win
          // over casting, so the shore never shadows a conversation.
          this.ui.showInteractionPrompt('🎣 Press <strong>E</strong> to cast a line');
          if (this.inputManager.consumeKeyPress('e')) {
            this.scene.tryCastLine(performance.now() / 1000);
          }
        } else if (!this.ownedPickaxe && this.scene.nearestOreNode() !== null) {
          // Advert only — AFTER the cast branch so it never shadows an action.
          this.ui.showInteractionPrompt('⛏️ An ore vein — needs a Pickaxe (80 🪙 at the kiosk)');
        } else if (!this.ownedSickle && this.scene.nearestHarvestableCrop() !== null) {
          this.ui.showInteractionPrompt('🪚 Ripe crops — needs a Sickle (25 🪙 at the kiosk)');
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
    const envCycle = this.scene.getEnvironmentCycle();
    const weather = envCycle?.getWeather() ?? 'clear';
    sfx.setRainLevel(weather === 'rain' ? 1 : 0);

    // Wind bed: always breathing faintly, stronger under weather. Birdsong:
    // sparse chirps in fair daylight only — the missing ambience layer the
    // deep-dive flagged (we had the rare voice layer and lacked the common one).
    const day = envCycle?.getDayFactor() ?? 1;
    const windByWeather =
      weather === 'rain' ? 1 : weather === 'snow' ? 0.7 : weather === 'cloudy' ? 0.65 : 0.35;
    sfx.setWindLevel(windByWeather);
    sfx.setBirdsong(day > 0.35 && (weather === 'clear' || weather === 'cloudy'));

    // Ambient sea swell — a distant murmur inland, coastal near the shore,
    // full when in the water (quantised so setSeaLevel only fires on changes).
    const audioPlayer = this.scene.getPlayer();
    if (audioPlayer) {
      const wp = audioPlayer.getWorldPosition();
      const lat = Math.asin(Math.max(-1, Math.min(1, wp.y / (wp.length() || 1))));
      let sea = lat < 0.5 ? 0.45 : 0.15;
      if (audioPlayer.isInWater()) sea = 1;
      sfx.setSeaLevel(sea);
      // Diegetic bandstand theme: audible only near the stage AND only while
      // the Musician is actually playing (his LIVE activity, not the clock —
      // moods and daily plans can reroute him). Fades over ~18u.
      const stage = this.scene.getIsland().bandstandSites[0];
      const playing = stage && this.scene.getNpcActivity('Musician') === 'play_music';
      sfx.setBandstandLevel(playing ? Math.max(0, 1 - wp.distanceTo(stage) / 18) : 0);
      // Ambient meows near cats: occasional calls, fading over ~9u.
      sfx.setMeowLevel(Math.max(0, 1 - this.scene.getNearestCatDistance(wp) / 9));
    }
    // Vehicle engine loop while driving; silent on foot
    if (this.scene.isRidingVehicle()) {
      sfx.setEngine(this.scene.getActiveVehicleKind(), this.currentThrottle);
    } else {
      sfx.setEngine(null, 0);
    }

    // Multiplayer: broadcast our state (incl. the vehicle index + transform
    // we're driving) and interpolate peers, then apply peers' vehicles onto
    // the shared world vehicles — so a peer drives the real craft (right
    // colour) and a car they park stays there for anyone to drive.
    this.multiplayer?.setVehicle(this.scene.getActiveVehicleState());
    this.multiplayer?.update(deltaTime);
    this.chat?.update(deltaTime);

    // HudLabels (R3 P5): the ≤4 nearest sentence bubbles inside 14u swap to
    // crisp DOM twins — sprite text can't beat the DPR-capped framebuffer.
    // Candidates only exist while someone is actually speaking, so this whole
    // block is ~free on quiet frames. ?domlabels=0 kills it inside update().
    if (this.hudLabels) {
      this.hudCandidates.length = 0;
      let scratchIdx = 0;
      const grabScratch = (): THREE.Vector3 => {
        while (this.hudScratch.length <= scratchIdx) this.hudScratch.push(new THREE.Vector3());
        return this.hudScratch[scratchIdx++];
      };
      if (this.chat) {
        for (const b of this.chat.getLiveBubbles()) {
          this.hudCandidates.push({
            key: b.key,
            text: b.text,
            sprite: b.sprite,
            worldPos: b.sprite.getWorldPosition(grabScratch()),
            theme: 'chat',
          });
        }
      }
      // NPC speech bubbles are DELIBERATELY not twinned (Abbas's call — he
      // prefers the smaller sprite look). It also removes a feedback loop:
      // the NPC candidate was gated on sprite.visible, which HudLabels
      // itself clears on promote — the representation flipped every frame
      // (the reported flicker/double). Chat bubbles can't loop: their
      // source is the bubble lifetime list, not visibility.
      this.hudLabels.update(this.scene.getCamera(), this.hudCandidates);
    }

    // First time a real visitor comes within chat range, surface how to
    // interact (idempotent + persisted, so this is effectively free after once).
    if (this.multiplayer && this.multiplayer.nearestPeerDistance() < PROXIMITY_RADIUS) {
      this.ui.showProximityCoachMark();
    }

    // Drive the Web Audio listener from the local player + camera each frame so
    // positional voice (and spatial sfx) is heard from the character's location
    // and facing. Nothing else updates the listener, so without this the whole
    // 3D audio field sits inert at the origin.
    const am = (
      window as unknown as {
        audioManager?: {
          updateListener?: (
            p: { x: number; y: number; z: number },
            f?: { x: number; y: number; z: number },
            u?: { x: number; y: number; z: number },
          ) => void;
        };
      }
    ).audioManager;
    if (am?.updateListener && this.scene) {
      // Vector3 satisfies the {x,y,z} shape updateListener reads, and it copies
      // the values out synchronously, so reusing these scratches is safe.
      const lp = this._listenerPos.copy(this.scene.getPlayer().getWorldPosition());
      const fwd = this.scene.getCamera().getWorldDirection(this._listenerFwd);
      am.updateListener(lp, fwd, this._listenerUp);
    }
    if (this.multiplayer) {
      this.scene.syncRemoteVehicles(this.multiplayer.getRemoteVehicleStates());
    }

    // Always update scene (for animations, etc.)
    this.scene.update(deltaTime);
  }

  /**
   * Compute the bearing from the camera's forward direction to the active
   * delivery target (both projected onto the player's tangent plane) and
   * feed it to the HUD compass. Hidden when the chain is complete.
   */
  private updateQuestCompass(): void {
    const player = this.scene.getPlayer();
    if (!player) {
      this.ui.updateQuestCompass(null);
      return;
    }
    // Copy into scratch (getWorldPosition/getSurfaceNormal return fresh clones)
    // so the active-delivery path allocates nothing.
    const playerPos = this._qcPlayerPos.copy(player.getWorldPosition());
    const normal = this._qcNormal.copy(player.getSurfaceNormal());

    // PORTFOLIO first for new visitors: until the first district is stamped,
    // the compass guides to the nearest unstamped zone even while the
    // auto-active delivery chain runs (it used to read "📬 Delivery" from the
    // very first frame, steering every new visitor to a mini-game before
    // they'd seen a single piece of Abbas's work). After the first stamp,
    // active deliveries take priority as before.
    const active = this.deliverySystem?.getActiveDeliveries?.() ?? [];
    const delivery = active.length > 0 ? active[0] : null;
    const zone = this.nearestUnstampedZone(playerPos);
    const portfolioFirst = (this.passport?.count() ?? 0) === 0;
    // Map-pick arrival check: the guide fulfils itself.
    if (this.mapGuideTarget && playerPos.distanceTo(this.mapGuideTarget) < 6) {
      this.mapGuideTarget = null;
      this.ui.toast('🧭 You have arrived.');
    }
    let targetPos: THREE.Vector3 | null = null;
    let label = '';
    if (this.mapGuideTarget) {
      // Island-map pick — explicit intent, outranks everything until reached.
      targetPos = this.mapGuideTarget;
      label = this.mapGuideLabel;
    } else if (this.aiGuideTarget) {
      // "Meet the AI townsfolk" welcome CTA — outranks everything until the
      // visitor talks to an AI NPC (cleared in the chat-open branch).
      targetPos = this.aiGuideTarget;
      label = '🤖 The Storyteller';
    } else if (this.raceGuideTarget) {
      // "Beat the lap record" CTA — explicit intent, cleared when a race starts.
      targetPos = this.raceGuideTarget;
      label = '🏁 Race start';
    } else if (zone && (portfolioFirst || !delivery?.destination)) {
      targetPos = zone.pos;
      label = `${PASSPORT_META[zone.id].icon} ${PASSPORT_META[zone.id].label}`;
    } else if (delivery?.destination) {
      targetPos = delivery.destination.mesh.position;
      label = '📬 Delivery';
    }
    if (!targetPos) {
      this.ui.updateQuestCompass(null);
      this.scene.setGuideTarget(null);
      return;
    }

    // Feed the in-world breadcrumb trail the same target as the HUD compass
    this.scene.setGuideTarget(targetPos);

    // Bearing vectors projected onto the player's tangent plane (reused scratch).
    const toTarget = this.projectTangent(
      this._qcToTarget,
      this._qcTmp.copy(targetPos).sub(playerPos),
      normal,
    );
    const camForward = this.projectTangent(
      this._qcCamFwd,
      this.scene.getOrbitCamera().getForwardDirection(),
      normal,
    );
    if (toTarget.lengthSq() < 1e-6 || camForward.lengthSq() < 1e-6) {
      this.ui.updateQuestCompass(null);
      return;
    }
    toTarget.normalize();
    camForward.normalize();
    const cross = this._qcCross.copy(camForward).cross(toTarget);
    const angleRad = Math.atan2(cross.dot(normal), camForward.dot(toTarget));
    // great-circle distance on the planet surface
    const R = playerPos.length();
    // _qcTmp and _qcCross are free again here; reuse them for the two great-circle endpoints.
    const arc = this._qcTmp
      .copy(playerPos)
      .normalize()
      .angleTo(this._qcCross.copy(targetPos).normalize());
    this.ui.updateQuestCompass({
      angleRad,
      distance: arc * R,
      label,
    });
  }

  /**
   * Nearest passport zone the visitor hasn't stamped yet, for the compass
   * guide-me fallback. Returns null once the passport is complete (compass off)
   * or before the passport exists. Only the four stamp zones count \u2014 the pole
   * Welcome hub is the intro, not a destination.
   */
  /** Assemble every shop/provider/build-spot POI and open the island map.
   *  Picking one sets the compass (mapGuideTarget — top of the chain). */
  private openIslandMap(): void {
    const pois: Array<{ icon: string; label: string; pos: THREE.Vector3 }> = [];
    const add = (icon: string, label: string, pos: THREE.Vector3 | null): void => {
      if (pos) pois.push({ icon, label, pos });
    };
    for (const z of this.scene.getZonesManager().getZones()) {
      add('🏛️', z.name, z.getPosition());
    }
    add('🛒', 'Shop kiosk', this.scene.kioskPos());
    add('📰', 'Notice board', this.scene.noticeBoardPos());
    add('🏦', 'Bank', this.scene.bankPos());
    add('🏫', 'School', this.scene.schoolPos());
    add('🏥', 'Hospital', this.scene.hospitalPos());
    add('🪚', "Carpenter's rack (sell timber)", this.scene.carpenterRackPos());
    add('🌾', 'Farm', this.scene.farmPos());
    add('🎣', 'Fisherman (sell fish)', this.scene.fishermanPos());
    add('🥧', 'Bakery (sell wheat)', this.scene.bakerPos());
    add('🍲', 'Canteen (sell produce · buy soup)', this.scene.canteenPos());
    add('🥕', 'Grocer (sell produce)', this.scene.marketVendorPos());
    for (const n of this.scene.oreNodeSummary()) {
      add('⛏️', n.rich ? 'Ore vein' : 'Ore vein (depleted)', n.pos);
    }
    const PLOT_ICONS = {
      bench: '🪑',
      signpost: '🪧',
      lantern: '🏮',
      gazebo: '⛩️',
      planter: '🌸',
      campfire: '🔥',
    } as const;
    // Grouped: one entry per kind pointing at the NEAREST free plot (22 raw
    // stake pins drowned the map), plus every BUILT structure as a real POI.
    {
      const playerPos = this.scene.getPlayer()?.getWorldPosition() ?? null;
      const nearestOf = (items: Array<{ pos: THREE.Vector3 }>) => {
        let best = items[0];
        let bestD = Infinity;
        for (const it of items) {
          const d = playerPos ? it.pos.distanceTo(playerPos) : 0;
          if (d < bestD) {
            bestD = d;
            best = it;
          }
        }
        return best;
      };
      const free = this.scene.freePlotSummary();
      const freeBenches = free.filter((f) => f.kind === 'bench');
      const freeBuilds = free.filter((f) => f.kind !== 'bench');
      if (freeBenches.length) {
        add('🪑', `Free bench plots (${freeBenches.length}) — nearest`, nearestOf(freeBenches).pos);
      }
      if (freeBuilds.length) {
        add(
          '🔨',
          `Free build plots (${freeBuilds.length}) — choose what to raise`,
          nearestOf(freeBuilds).pos,
        );
      }
      for (const b of this.scene.builtPlotSummary()) {
        if (b.system !== 'build') continue;
        add(
          PLOT_ICONS[b.kind as keyof typeof PLOT_ICONS] ?? '🔨',
          `Visitor-built ${b.kind}`,
          b.pos,
        );
      }
    }
    this.ui.showIslandMap(pois, (poi) => {
      this.mapGuideTarget = new THREE.Vector3(poi.pos.x, poi.pos.y, poi.pos.z);
      this.mapGuideLabel = `${poi.icon} ${poi.label}`;
      this.ui.toast(`🧭 Compass set: ${poi.icon} ${poi.label}`);
      track('map_guide_set', { label: poi.label });
    });
  }

  private nearestUnstampedZone(
    playerPos: THREE.Vector3,
  ): { pos: THREE.Vector3; id: PassportZone } | null {
    if (!this.passport || this.passport.isComplete()) return null;
    let best: { pos: THREE.Vector3; id: PassportZone } | null = null;
    let bestD = Infinity;
    for (const z of this.scene.getZonesManager().getZones()) {
      if (!this.passport.isStampZone(z.id) || this.passport.has(z.id)) continue;
      const zp = z.getPosition();
      const d = zp.distanceToSquared(playerPos);
      if (d < bestD) {
        bestD = d;
        best = { pos: zp, id: z.id as PassportZone };
      }
    }
    return best;
  }

  // \u2500\u2500 Tour mode: skippable cinematic rail (welcome CTA / ?tour=1) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  private static readonly TOUR_FLY_S = 2.6; // seconds flying between stops
  private static readonly TOUR_DWELL_S = 6.0; // seconds studying each stop

  /**
   * Build the rail and hand the camera to it. Stops are derived from live
   * world state (zone plazas + a working NPC), so the tour survives layout
   * changes for free. No-op if already touring or inside a building.
   */
  private startTour(recruiter = false): void {
    if (this.tour || this.scene.isInsideInterior()) return;
    this.tourRecruiter = recruiter;
    const zones = new Map(
      this.scene
        .getZonesManager()
        .getZones()
        .map((z) => [z.id, z.getPosition()] as const),
    );
    const stops: Array<{ caption: string; look: THREE.Vector3; dir: THREE.Vector3; r: number }> =
      [];
    const addStop = (
      p: THREE.Vector3 | null | undefined,
      caption: string,
      alt: number,
      back: number,
    ) => {
      if (!p) return;
      const up = p.clone().normalize();
      const tan = new THREE.Vector3(0, 1, 0).cross(up);
      if (tan.lengthSq() < 0.05) tan.set(1, 0, 0).cross(up);
      tan.normalize();
      const camPos = p.clone().addScaledVector(up, alt).addScaledVector(tan, back);
      stops.push({
        caption,
        look: p.clone().addScaledVector(up, 1.4),
        dir: camPos.clone().normalize(),
        r: camPos.length(),
      });
    };
    if (recruiter) {
      // RECRUITER MODE \u2014 the 60-second play-to-hire path (the deep-dive
      // critic's top flag: nothing routed a visitor from playing to hiring).
      // Four punchy stops, shorter dwell, and it ENDS on the contact panel.
      addStop(
        zones.get('welcome'),
        'Abbas Ali \u2014 full-stack + AI engineer. This whole planet is his hand-built portfolio.',
        24,
        8,
      );
      addStop(
        zones.get('professional'),
        'The engineering: Three.js, TypeScript, Firebase, real-time multiplayer \u2014 all custom.',
        9.5,
        14,
      );
      addStop(
        this.scene.getNpcPosition('Storyteller') ?? this.scene.getNpcPosition('Gardener'),
        'Every villager is a live AI agent with a voice \u2014 planned, scheduled, and reported on by LLMs.',
        6.5,
        9,
      );
      addStop(
        zones.get('contact'),
        "That's the 60-second version \u2014 the contact form sends Abbas a real email.",
        8.5,
        13,
      );
    } else {
      addStop(
        zones.get('welcome'),
        "Welcome to Life Island \u2014 Abbas Ali's portfolio, built as a living planet you can walk around.",
        24,
        8,
      );
      addStop(
        zones.get('professional'),
        'The Professional District \u2014 full-stack and AI engineering. Step inside the office for the story.',
        9.5,
        14,
      );
      addStop(
        zones.get('projects'),
        'The Projects District \u2014 ventures under construction: RankPilot, ChocoMate, and friends.',
        9.5,
        14,
      );
      addStop(
        this.scene.getNpcPosition('Gardener') ?? this.scene.getNpcPosition('Guard'),
        'Every townsperson is a live AI agent \u2014 planned each morning, reported on nightly. Talk to anyone.',
        // High enough to clear tree canopies \u2014 NPC positions are live, so a low
        // camera is occlusion roulette (a prod capture found a tree filling it).
        6.5,
        9,
      );
      addStop(
        zones.get('personal'),
        'The Personal District \u2014 the human behind the code, and the cottages the townsfolk sleep in.',
        9.5,
        14,
      );
      addStop(
        zones.get('contact'),
        'Get In Touch \u2014 the Post Office sends Abbas a real email. The island is yours from here.',
        8.5,
        13,
      );
    }
    if (stops.length === 0) return;
    track(recruiter ? 'recruit_tour_start' : 'tour_start');
    const cam = this.scene.getCamera();
    this.scene.setCameraSuspended(true);
    this.ui.hideInteractionPrompt();
    const playerPos = this.scene.getPlayer()?.getWorldPosition() ?? stops[0].look.clone();
    this.tour = {
      stops,
      idx: 0,
      t: 0,
      phase: 'fly',
      fromDir: cam.position.clone().normalize(),
      fromR: Math.max(cam.position.length(), 20),
      fromLook: playerPos.clone(),
    };
    this.ui.showTourOverlay(() => this.endTour(true));
    this.ui.setTourCaption(stops[0].caption);
  }

  private updateTour(dt: number): void {
    const tour = this.tour;
    if (!tour) return;
    const cam = this.scene.getCamera();
    const stop = tour.stops[tour.idx];
    tour.t += dt;
    if (tour.phase === 'fly') {
      // Reduced motion: the tour becomes a slideshow — hard-cut to the stop
      // pose and start the dwell. Captions, pacing, the recruiter ending and
      // the E2E rail all behave identically; only the flight is gone. (The
      // fly phase is the game's single largest uninitiated camera move, and
      // ?tour=1 / ?recruit=1 share links auto-start it on page load.)
      if (a11y.reducedMotion) {
        cam.position.copy(stop.dir).multiplyScalar(stop.r);
        cam.up.copy(this._tourUp.copy(cam.position).normalize());
        cam.lookAt(stop.look);
        tour.phase = 'dwell';
        tour.t = 0;
        return;
      }
      const k = Math.min(1, tour.t / SimpleApp.TOUR_FLY_S);
      const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
      this.slerpDirs(this._tourDir, tour.fromDir, stop.dir, e);
      // Altitude hop: arcing over the terrain beats a chord that dips through it
      const r = tour.fromR + (stop.r - tour.fromR) * e + Math.sin(Math.PI * e) * 7;
      cam.position.copy(this._tourDir).multiplyScalar(r);
      this._tourLook.copy(tour.fromLook).lerp(stop.look, e);
      cam.up.copy(this._tourUp.copy(cam.position).normalize());
      cam.lookAt(this._tourLook);
      if (k >= 1) {
        tour.phase = 'dwell';
        tour.t = 0;
      }
    } else {
      // Gentle drift around the stop while the caption is read — held static
      // under reduced motion (a rotation the user cannot stop, however slow,
      // is still uninitiated full-viewport motion).
      const up = this._tourUp.copy(stop.look).normalize();
      if (!a11y.reducedMotion) {
        this._tourQ.setFromAxisAngle(up, 0.045 * dt);
        stop.dir.applyQuaternion(this._tourQ);
      }
      cam.position.copy(stop.dir).multiplyScalar(stop.r);
      cam.up.copy(up);
      cam.lookAt(stop.look);
      if (tour.t >= SimpleApp.TOUR_DWELL_S) this.advanceTourStop();
    }
  }

  private advanceTourStop(): void {
    const tour = this.tour;
    if (!tour) return;
    if (tour.idx + 1 >= tour.stops.length) {
      this.endTour(false);
      return;
    }
    const cam = this.scene.getCamera();
    const prev = tour.stops[tour.idx];
    tour.idx += 1;
    tour.phase = 'fly';
    tour.t = 0;
    tour.fromDir.copy(cam.position).normalize();
    tour.fromR = cam.position.length();
    tour.fromLook.copy(prev.look);
    this.ui.setTourCaption(tour.stops[tour.idx].caption);
  }

  private endTour(skipped: boolean): void {
    if (!this.tour) return;
    this.tour = null;
    this.ui.hideTourOverlay();
    // The return from the last tour stop to the follow pose is a
    // planet-scale camera lerp — the door grammar (0.45s veil, hard cut
    // underneath) is the scene-transition language everywhere else, so the
    // tour ends the same way for EVERYONE (reduced motion included; the
    // veil is an opacity fade, the accessibility-recommended replacement).
    this.ui.fadeThrough(() => {
      this.scene.setCameraSuspended(false);
      this.scene.snapCameraToPlayer();
    });
    const recruiter = this.tourRecruiter;
    this.tourRecruiter = false;
    track(
      recruiter
        ? skipped
          ? 'recruit_tour_skip'
          : 'recruit_tour_complete'
        : skipped
          ? 'tour_skip'
          : 'tour_complete',
    );
    if (recruiter && !skipped) {
      // The play-to-hire path CONVERTS: the highlights end on the contact
      // panel with the lead form ready, not on an empty meadow.
      this.ui.showZonePanel({ id: 'contact', name: 'Get In Touch' }, { source: 'cta' });
      return;
    }
    this.ui.flashMessage('\ud83e\udded The island is yours \u2014 walk anywhere, talk to anyone');
  }

  private tourRecruiter = false;

  // \u2500\u2500 In-person dialogue: NPC hold + camera push-in \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  // While a conversation panel is open the villager is held in place
  // (GameScene wander loop) and, motion allowing, the camera glides into a
  // two-shot over the player's shoulder. Closing by ANY path releases both.
  private npcDialogueName: string | null = null;
  private npcCine: {
    name: string;
    pos: THREE.Vector3; // eased camera position (the rail state)
    look: THREE.Vector3; // eased look target
    prevFov: number;
    ending: number; // <0 = active; >=0 = seconds into the release glide
  } | null = null;
  private chatWalkAwayT = 0; // sustained walk intent closes the chat
  private watchOpenedAt = 0; // wall-screen open time — same-press close guard
  private isletUnlocked = false; // beach-house door code accepted this session
  private readonly _cineUp = new THREE.Vector3();
  private readonly _cineAxis = new THREE.Vector3();
  private readonly _cineSide = new THREE.Vector3();
  private readonly _cineDesired = new THREE.Vector3();
  private readonly _cineLookT = new THREE.Vector3();
  private readonly _cineTmp = new THREE.Vector3();

  private beginNpcDialogue(name: string): void {
    this.npcDialogueName = name;
    this.chatWalkAwayT = 0;
    this.scene.setNpcDialogueHold(name);
    // The camera push-in is optional flavor on top of the hold: skip it under
    // reduced motion, during the tour, or when another rail (postcard hold /
    // an ending cine) already owns the suspended camera.
    if (this.tour || this.npcCine || a11y.reducedMotion || this.scene.isCameraSuspended()) return;
    const cam = this.scene.getCamera();
    const player = this.scene.getPlayer();
    if (!cam || !player) return;
    this.npcCine = {
      name,
      pos: cam.position.clone(),
      look: player.getWorldPosition().clone(),
      prevFov: cam.fov,
      ending: -1,
    };
    this.scene.setCameraSuspended(true);
  }

  private endNpcDialogue(): void {
    if (!this.npcDialogueName && !this.npcCine) return;
    this.npcDialogueName = null;
    this.scene.setNpcDialogueHold(null);
    if (this.npcCine && this.npcCine.ending < 0) this.npcCine.ending = 0;
  }

  private updateNpcCine(dt: number): void {
    const c = this.npcCine;
    if (!c) return;
    const cam = this.scene.getCamera();
    // Pinch accumulates while the orbit camera is suspended and would land as
    // one distance jump on resume \u2014 drain and discard it every rail frame.
    consumePinchZoomFactor();
    const playerPos = this.scene.getPlayer()?.getWorldPosition() ?? null;
    const npcPos = this.scene.getNpcPosition(c.name);
    // Any close path (\u2715 / Escape / walk-away / panel replaced) or a lost
    // subject \u2192 glide home.
    if (
      c.ending < 0 &&
      (!playerPos || !npcPos || (!this.ui.isNpcChatOpen() && !this.ui.isDialogueActive()))
    ) {
      c.ending = 0;
    }
    if (c.ending < 0 && playerPos && npcPos) {
      // Two-shot: slightly behind + beside the player, looking past their
      // shoulder at the villager's face. Recomputed from LIVE positions each
      // frame (the held NPC still breathes/hops); expDecay soaks it into a
      // slow push-in. All eases are exp-based \u2014 Hz-independent.
      const up = this._cineUp.copy(playerPos).normalize();
      const axis = this._cineAxis.subVectors(playerPos, npcPos);
      axis.addScaledVector(up, -axis.dot(up));
      // Degenerate (player atop the NPC): any tangent will do — up.y is
      // always > sin(0.29) on the island, so X never parallels up.
      if (axis.lengthSq() < 1e-6) axis.set(1, 0, 0).addScaledVector(up, -up.x);
      axis.normalize();
      const side = this._cineSide.crossVectors(up, axis);
      const desired = this._cineDesired
        .copy(playerPos)
        .addScaledVector(axis, 2.05)
        .addScaledVector(side, 1.25)
        .addScaledVector(up, 1.6);
      // Never sink the shot into a hillside: clamp above the analytic surface.
      const island = this.scene.getIsland();
      if (island) {
        const cd = this._cineTmp.copy(desired).normalize();
        const minR = island.analyticSurface(cd).radius + 0.5;
        if (desired.length() < minR) desired.setLength(minR);
      }
      const desiredLook = this._cineLookT
        .copy(npcPos)
        .addScaledVector(up, 1.35)
        .lerp(this._cineTmp.copy(playerPos).addScaledVector(up, 1.4), 0.3);
      // Slow, savoured push-in (~2s to settle — was k 3.2/4.5/3.0, which
      // read as a snap zoom): the look leads the dolly slightly, the FOV
      // narrows last, like a camera operator leaning in.
      expDecayV3(c.pos, desired, 1.5, dt);
      expDecayV3(c.look, desiredLook, 2.1, dt);
      cam.fov = expDecay(cam.fov, c.prevFov - 8, 1.3, dt);
      cam.updateProjectionMatrix();
    } else {
      // Release glide: look eases back onto the player and FOV restores, THEN
      // the orbit camera resumes \u2014 its own position ease carries the camera
      // home without a whip-pan (rotation snaps on resume, so the final look
      // target must already be near the player).
      c.ending += dt;
      if (playerPos) {
        const up = this._cineUp.copy(playerPos).normalize();
        expDecayV3(c.look, this._cineTmp.copy(playerPos).addScaledVector(up, 1.4), 10, dt);
      }
      cam.fov = expDecay(cam.fov, c.prevFov, 12, dt);
      cam.updateProjectionMatrix();
      if (c.ending > 0.35) {
        cam.fov = c.prevFov; // exact restore \u2014 updateFov may never run (pre-ride)
        cam.updateProjectionMatrix();
        this.scene.setCameraSuspended(false);
        this.npcCine = null;
        return;
      }
    }
    cam.position.copy(c.pos);
    cam.up.copy(this._cineUp.copy(c.pos).normalize());
    cam.lookAt(c.look);
  }

  /**
   * Constant-speed rotation from direction `a` to `b` (unit vectors) by
   * fraction `t`, written into `out`. Plain lerp+normalize is speed-warped on
   * big arcs; the stops are up to ~90\u00b0 apart so the warp would be visible.
   */
  private slerpDirs(out: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3, t: number): void {
    const angle = a.angleTo(b);
    if (angle < 1e-4) {
      out.copy(b);
      return;
    }
    this._tourAxis.copy(a).cross(b);
    if (this._tourAxis.lengthSq() < 1e-8) {
      // Near-antipodal: any perpendicular axis works
      this._tourAxis.set(0, 1, 0).cross(a);
      if (this._tourAxis.lengthSq() < 1e-8) this._tourAxis.set(1, 0, 0).cross(a);
    }
    this._tourAxis.normalize();
    this._tourQ.setFromAxisAngle(this._tourAxis, angle * t);
    out.copy(a).applyQuaternion(this._tourQ).normalize();
  }

  /** "Beat the lap record" CTA \u2192 compass to the land start gate (water fallback). */
  private guideToRace(): void {
    const pos = this.scene.getRaceStartPosition('land') ?? this.scene.getRaceStartPosition('water');
    if (!pos) return;
    this.raceGuideTarget = pos;
    this.ui.flashMessage(
      '\ud83c\udfc1 Follow the compass to the start gate \u2014 grab a car and drive through the glowing rings',
    );
  }

  /** Discovery sweep: standing within ~5.5u of an unfound secret finds it —
   *  flash with its revealed name, chime, a few coins, journal tick. */
  private sweepSecrets(): void {
    if (this.secrets.count() >= this.secrets.total()) return;
    this.resolveSecretSpots();
    const p = this.scene.getPlayer()?.getWorldPosition();
    if (!p) return;
    for (const s of this.secretSpots) {
      if (this.secrets.has(s.id) || p.distanceToSquared(s.pos) > 30) continue;
      if (!this.secrets.discover(s.id)) continue;
      const def = SECRETS.find((d) => d.id === s.id);
      this.ui.flashMessage(`🔍 Secret found: ${def?.title ?? s.id}!`);
      sfx.collect();
      this.scene.addCoins(3);
      this.ui.updateCoinCounter(this.scene.getCoinsCollected());
      track('secret_found', { id: s.id, n: this.secrets.count() });
      if (this.secrets.count() === this.secrets.total()) {
        window.setTimeout(
          () => this.ui.flashMessage('🗝️ All nine island secrets found — true islander!'),
          2200,
        );
        trackOnce('secrets_complete');
      }
    }
  }

  /** Distinct visit days + the current consecutive-day streak ending today. */
  private visitLedger(): { days: number; streak: number } {
    try {
      const days: string[] = JSON.parse(localStorage.getItem('ds_visit_days') ?? '[]');
      const set = new Set(days);
      let streak = 0;
      const d = new Date();
      for (;;) {
        if (!set.has(d.toISOString().slice(0, 10))) break;
        streak++;
        d.setDate(d.getDate() - 1);
      }
      return { days: set.size, streak };
    } catch {
      return { days: 1, streak: 1 };
    }
  }

  /** Set a one-shot completion flag + refresh the meter immediately. */
  private markDone(key: string): void {
    try {
      localStorage.setItem(key, '1');
    } catch {
      /* no storage */
    }
    this.refreshCompletion();
  }

  /**
   * The visitor-goal loop: everything worth doing on the island, one weight
   * each. Stamps read the live passport; one-shot acts are localStorage flags
   * set at their event sites (and re-polled every 2.5s, so flags flipped deep
   * inside the UI layer surface without extra wiring).
   */
  private refreshCompletion(): void {
    const flag = (k: string): boolean => {
      try {
        return localStorage.getItem(k) === '1';
      } catch {
        return false;
      }
    };
    const stampIds = (Object.keys(PASSPORT_META) as PassportZone[]).filter(
      (id) => this.passport?.isStampZone(id) ?? false,
    );
    const items = [
      ...stampIds.map((id) => ({
        icon: PASSPORT_META[id].icon,
        label: `Visit ${PASSPORT_META[id].label}`,
        done: this.passport?.has(id) ?? false,
        hint: 'Walk into the district plaza \u2014 the compass points the way.',
      })),
      {
        icon: '\ud83d\udcac',
        label: 'Talk with an AI townsperson',
        done: flag('ds_npc_chatted'),
        hint: 'Walk up to anyone with a name tag and press E.',
      },
      {
        icon: '\ud83c\udfc1',
        label: 'Finish a race',
        done: flag('ds_raced'),
        hint: 'Hop in a car or boat and drive through the white start ring.',
      },
      {
        icon: '\ud83d\udcec',
        label: 'Complete the courier chain',
        done: flag('ds_courier_reward'),
        hint: 'Deliver every parcel \u2014 glowing mailboxes have one waiting.',
      },
      {
        icon: '\ud83d\udc4b',
        label: 'Say hi or sign the guestbook',
        done: flag('ds_said_hi'),
        hint: 'The \ud83d\udc4b Say hi button \u2014 five seconds, promise.',
      },
      {
        icon: '\ud83d\udcf0',
        label: 'Read the Island Times',
        done: flag('ds_read_times'),
        hint: '\ud83d\udcd6 Portfolio menu \u2192 Island Times: the AI-compiled daily.',
      },
      {
        icon: '\ud83d\udcf8',
        label: 'Take an island photo',
        done: flag('ds_photo_taken'),
        hint: 'Press P (or the \ud83d\udcf8 pill) anywhere pretty.',
      },
      {
        icon: '\ud83c\udfe0',
        label: 'Step inside a building',
        done: flag('ds_entered_building'),
        hint: 'Walk to any door and press E.',
      },
    ];
    const done = items.filter((i) => i.done).length;
    this.ui.setCompletion(Math.round((done / items.length) * 100), items);
  }

  /**
   * True when a normalised walk phase [0,1) swept past `thr` between the
   * previous and current sample, accounting for the 1\u21920 wrap. `prev < 0` marks
   * a freshly (re)started stride, so nothing has been crossed yet.
   */
  private crossedPhase(prev: number, cur: number, thr: number): boolean {
    if (prev < 0) return false;
    if (cur >= prev) return prev < thr && thr <= cur;
    return thr > prev || thr <= cur; // wrapped past 1.0 this frame
  }

  /** Project `v` onto the tangent plane defined by `normal`, writing into `out`. */
  private projectTangent(
    out: THREE.Vector3,
    v: THREE.Vector3,
    normal: THREE.Vector3,
  ): THREE.Vector3 {
    out.copy(v);
    return out.addScaledVector(normal, -out.dot(normal));
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
          items: [
            {
              id: SimpleApp.BIRD_FEED_ID,
              icon: '🌾',
              name: 'Bird Feed',
              price: SimpleApp.BIRD_FEED_PRICE,
              category: 'supplies' as const,
              desc: 'Press F to scatter — nearby birds fly in to eat',
              consumable: true,
              charges: SimpleApp.BIRD_FEED_CHARGES,
              held: this.birdFeed,
            },
            {
              id: SimpleApp.CAT_FEED_ID,
              icon: '🐈',
              name: 'Cat Feed',
              price: SimpleApp.CAT_FEED_PRICE,
              category: 'supplies' as const,
              desc: 'Aim near a cat and press F — it trots over for dinner',
              consumable: true,
              charges: SimpleApp.CAT_FEED_CHARGES,
              held: this.catFeed,
            },
            {
              id: SimpleApp.FISH_FEED_ID,
              icon: '🐟',
              name: 'Fish Feed',
              price: SimpleApp.FISH_FEED_PRICE,
              category: 'supplies' as const,
              desc: 'Throw onto the water — the school comes to nibble',
              consumable: true,
              charges: SimpleApp.FISH_FEED_CHARGES,
              held: this.fishFeed,
            },
            {
              id: 'canteensoup',
              icon: '🥣',
              name: 'Canteen Soup',
              price: SimpleApp.SOUP_PRICE,
              category: 'supplies' as const,
              desc: 'Warm bowl from the canteen — press G to eat, restores stamina',
              consumable: true,
              charges: 1,
              held: this.meals.soup,
            },
            {
              id: 'grilledfish',
              icon: '🍤',
              name: 'Grilled Fish',
              price: SimpleApp.FISHMEAL_PRICE,
              category: 'supplies' as const,
              desc: "Off the fisherman's grill — a hearty bite of energy (press G)",
              consumable: true,
              charges: 1,
              held: this.meals.fish,
            },
            {
              id: 'bakerspie',
              icon: '🥧',
              name: "Baker's Pie",
              price: SimpleApp.PIE_PRICE,
              category: 'supplies' as const,
              desc: 'Fresh from the oven — press G: full stamina + a 20s well-fed stroll',
              consumable: true,
              charges: 1,
              held: this.meals.pie,
            },
            {
              id: SimpleApp.ROD_ID,
              icon: '🎣',
              name: 'Fishing Rod',
              price: SimpleApp.ROD_PRICE,
              category: 'tools' as const,
              desc: 'Cast at the shore — the fisherman pays 3 🪙 a fish',
              owned: this.ownedRod,
            },
            {
              id: SimpleApp.AXE_ID,
              icon: '🪓',
              name: 'Wood Axe',
              price: SimpleApp.AXE_PRICE,
              category: 'tools' as const,
              desc: 'Three swings fell a tree — sell timber or build at the stakes',
              owned: this.ownedAxe,
            },
            {
              id: SimpleApp.SICKLE_ID,
              icon: '🪚',
              name: 'Harvest Sickle',
              price: SimpleApp.SICKLE_PRICE,
              category: 'tools' as const,
              desc: 'Cut crops at the farm — wheat to the Baker, veg to the canteen',
              owned: this.ownedSickle,
            },
            {
              id: SimpleApp.PICKAXE_ID,
              icon: '⛏️',
              name: 'Pickaxe',
              price: SimpleApp.PICKAXE_PRICE,
              category: 'tools' as const,
              desc: 'Four solid swings crack an ore vein — the bank assays ore, 5 🪙 each',
              owned: this.ownedPickaxe,
            },
            ...this.hatCatalog.map((h) => ({
              ...h,
              category: 'hats' as const,
              desc: 'Wear it well — hats persist and other visitors see them',
              equippable: true,
              owned: this.ownedHats.has(h.id),
              equipped: this.equippedHat === h.id,
            })),
          ],
        },
        (id) => {
          if (id === SimpleApp.AXE_ID) {
            if (this.ownedAxe) return;
            if (!this.scene.spendCoins(SimpleApp.AXE_PRICE)) return;
            this.ownedAxe = true;
            try {
              localStorage.setItem('ds_axe', '1');
            } catch {
              /* no storage */
            }
            sfx.coin();
            this.syncTools();
            track('axe_bought', {});
            this.ui.toast('🪓 Wood axe! Three good swings fell a tree.');
            render();
            return;
          }
          if (id === SimpleApp.SICKLE_ID) {
            if (this.ownedSickle) return;
            if (!this.scene.spendCoins(SimpleApp.SICKLE_PRICE)) return;
            this.ownedSickle = true;
            try {
              localStorage.setItem('ds_sickle', '1');
            } catch {
              /* no storage */
            }
            sfx.coin();
            this.syncTools();
            track('sickle_bought', {});
            this.ui.toast('🪚 Sickle! Crops at the farm are yours to cut.');
            render();
            return;
          }
          if (id === SimpleApp.PICKAXE_ID) {
            if (this.ownedPickaxe) return;
            if (!this.scene.spendCoins(SimpleApp.PICKAXE_PRICE)) return;
            this.ownedPickaxe = true;
            try {
              localStorage.setItem('ds_pickaxe', '1');
            } catch {
              /* no storage */
            }
            sfx.coin();
            this.syncTools();
            track('pickaxe_bought', {});
            this.ui.toast('⛏️ Pickaxe! Ore veins glint on the highland scree.');
            render();
            return;
          }
          if (id === SimpleApp.ROD_ID) {
            if (this.ownedRod) return;
            if (!this.scene.spendCoins(SimpleApp.ROD_PRICE)) return;
            this.ownedRod = true;
            try {
              localStorage.setItem('ds_rod', '1');
            } catch {
              /* no storage */
            }
            sfx.coin();
            this.syncTools();
            track('rod_bought', {});
            this.ui.toast('🎣 Fishing rod! Stand at the shore and press E to cast.');
            render();
            return;
          }
          if (id === SimpleApp.BIRD_FEED_ID) {
            // Consumable: buy another handful as often as you can afford it.
            if (!this.scene.spendCoins(SimpleApp.BIRD_FEED_PRICE)) return;
            this.birdFeed += SimpleApp.BIRD_FEED_CHARGES;
            this.persistBirdFeed();
            this.refreshFeedHud();
            sfx.coin();
            track('bird_feed_bought', { charges: this.birdFeed });
            render();
            return;
          }
          if (id === SimpleApp.CAT_FEED_ID) {
            if (!this.scene.spendCoins(SimpleApp.CAT_FEED_PRICE)) return;
            this.catFeed += SimpleApp.CAT_FEED_CHARGES;
            this.persistCatFeed();
            this.refreshFeedHud();
            sfx.coin();
            track('cat_feed_bought', { charges: this.catFeed });
            render();
            return;
          }
          if (id === SimpleApp.FISH_FEED_ID) {
            if (!this.scene.spendCoins(SimpleApp.FISH_FEED_PRICE)) return;
            this.fishFeed += SimpleApp.FISH_FEED_CHARGES;
            this.persistFishFeed();
            this.refreshFeedHud();
            sfx.coin();
            track('fish_feed_bought', { charges: this.fishFeed });
            render();
            return;
          }
          // Cooked-food meals: pure coin sink, +1 charge each, eaten with G.
          const mealBuy: Record<string, { price: number; key: 'soup' | 'fish' | 'pie' }> = {
            canteensoup: { price: SimpleApp.SOUP_PRICE, key: 'soup' },
            grilledfish: { price: SimpleApp.FISHMEAL_PRICE, key: 'fish' },
            bakerspie: { price: SimpleApp.PIE_PRICE, key: 'pie' },
          };
          if (mealBuy[id]) {
            const { price, key } = mealBuy[id];
            if (!this.scene.spendCoins(price)) return;
            this.meals[key]++;
            this.persistMeals();
            this.refreshFeedHud();
            sfx.coin();
            track('meal_bought', { kind: key, at: 'shop' });
            render();
            return;
          }
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
          saveProfile({ hat: id, ownedHats: [...this.ownedHats] });
          track('hat_equipped', { hat: id });
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
   * Re-render the pack if it is open. The game does NOT pause behind a modal
   * — loose coins are picked up by PROXIMITY ALONE (no keypress), and E/F/G
   * keep firing — so a static panel goes stale while you read it. Cheap
   * because PanelManager's same-id re-open replaces in place without firing
   * close(). Called from the funnels every mutation already passes through.
   */
  private refreshPackIfOpen(): void {
    if (this.ui.isInventoryOpen()) this.ui.showInventory();
  }

  private refreshFeedHud(): void {
    this.ui.updateFeedCounters(
      this.birdFeed,
      this.catFeed,
      this.fishFeed,
      this.meals.pie + this.meals.fish + this.meals.soup,
    );
    // Contextual touch buttons (mobile-finish): FEED/EAT exist only while
    // the action is possible — a fresh visitor sees three buttons, not five.
    this.ui.setAuxActionAvailable('feed', this.birdFeed + this.catFeed + this.fishFeed > 0);
    this.ui.setAuxActionAvailable('eat', this.meals.pie + this.meals.fish + this.meals.soup > 0);
    this.refreshPackIfOpen();
  }

  /**
   * Daily sell counter (icebox / timber rack satiation). Local-date keyed;
   * returns how many of today's cap remain. Soft-trust: clock changes only
   * cheat the player's own island.
   */
  private dailySold(key: string, add: number): number {
    const today = new Date().toISOString().slice(0, 10);
    let n = 0;
    try {
      const raw = JSON.parse(localStorage.getItem(key) ?? 'null') as {
        d?: string;
        n?: number;
      } | null;
      if (raw && raw.d === today) n = Math.max(0, raw.n ?? 0);
      if (add > 0) localStorage.setItem(key, JSON.stringify({ d: today, n: n + add }));
    } catch {
      /* no storage — satiation just never kicks in */
    }
    return n;
  }

  /**
   * The vault panel — the only shared money (economy spec Decision 1).
   * Deposit: coins leave the LOCAL balance first, then the server ack
   * confirms; a failed/unapplied call refunds. Withdraw: server first,
   * local credit only on applied ack. Both are idempotency-keyed.
   */
  private async openVault(): Promise<void> {
    if (this.vaultBusy) return;
    this.vaultBusy = true;
    const res = await vaultOp('balance');
    this.vaultBusy = false;
    if (!res) {
      this.ui.toast('🏦 "Vault link is down — try again in a moment."');
      return;
    }
    const step = 10;
    const render = (balance: number): void => {
      this.ui.showVaultPanel(balance, this.scene.getCoinsCollected(), step, {
        deposit: async () => {
          if (this.vaultBusy) return;
          if (!this.scene.spendCoins(step)) {
            this.ui.toast(`🪙 You need ${step} coins on you to deposit.`);
            return;
          }
          this.vaultBusy = true;
          const r = await vaultOp('deposit', step);
          this.vaultBusy = false;
          if (!r || !r.applied) {
            this.scene.addCoins(step); // refund — the vault never took it
            this.ui.toast('🏦 "Hm, the ledger jammed. Your coins are safe."');
            return;
          }
          sfx.coin();
          track('vault_deposit', { amount: step, balance: r.balance });
          render(r.balance);
        },
        withdraw: async () => {
          if (this.vaultBusy) return;
          this.vaultBusy = true;
          const r = await vaultOp('withdraw', step);
          this.vaultBusy = false;
          if (!r) {
            this.ui.toast('🏦 "Vault link is down — try again in a moment."');
            return;
          }
          if (!r.applied) {
            this.ui.toast('🏦 "Your vault has less than that in it."');
            render(r.balance);
            return;
          }
          this.scene.addCoins(step); // credit ONLY on ack
          sfx.coin();
          track('vault_withdraw', { amount: step, balance: r.balance });
          render(r.balance);
        },
      });
    };
    render(res.balance);
  }

  /** Charge first, refund on any non-ack — same shape as the vault. */
  /**
   * The nearest free plot (bench OR structure) with its costs and an
   * AFFORDABLE flag. The first version silently skipped plots the player
   * couldn't pay for — with 5 timber, lantern and gazebo stakes showed NO
   * prompt at all, which read as "all I can build is signposts" (Abbas's
   * report). Now the stake always explains itself. Cheap: plot seats are
   * cached in GameScene (no raycasts on this per-frame path).
   */
  private nearestBuildOpportunity(): {
    system: 'bench' | 'build';
    plot: number;
    icon: string;
    name: string;
    timber: number;
    coins: number;
    affordable: boolean;
    dist: number;
    own: boolean;
  } | null {
    const coins = this.scene.getCoinsCollected();
    const playerPos = this.scene.getPlayer()?.getWorldPosition();
    const distTo = (system: 'bench' | 'build', plot: number): number => {
      const seat = this.scene.plotSeat(system, plot);
      return seat && playerPos ? seat.distanceTo(playerPos) : 99;
    };
    // My own nearby build wins the slot (reclaim/replace options).
    if (playerPos) {
      for (const [plot] of this.ownBuilds) {
        const d = distTo('build', plot);
        if (d < 3.5) {
          const kind = GameScene.resolveKind(plot, undefined);
          const rendered = this.scene
            .builtPlotSummary()
            .find((s) => s.system === 'build' && s.plot === plot);
          const c =
            SimpleApp.BUILD_COSTS[rendered?.kind === 'bench' ? 'bench' : (rendered?.kind ?? kind)];
          return {
            system: 'build',
            plot,
            ...c,
            affordable: false,
            dist: d,
            own: true,
          };
        }
      }
    }
    // 6u scan: <3.5u is actionable, 3.5-6u renders as a walk-up advert.
    const benchPlot = this.scene.nearestFreePlot(6);
    if (benchPlot !== null) {
      const c = SimpleApp.BUILD_COSTS.bench;
      return {
        system: 'bench',
        plot: benchPlot,
        ...c,
        affordable: this.timber >= c.timber && coins >= c.coins,
        dist: distTo('bench', benchPlot),
        own: false,
      };
    }
    const buildPlot = this.scene.nearestFreeBuildPlot(6);
    if (buildPlot !== null) {
      const kind = GameScene.BUILD_PLOTS[buildPlot].defaultKind;
      const c = SimpleApp.BUILD_COSTS[kind];
      return {
        system: 'build',
        plot: buildPlot,
        ...c,
        affordable: this.timber >= c.timber && coins >= c.coins,
        dist: distTo('build', buildPlot),
        own: false,
      };
    }
    return null;
  }

  /** Charge first, refund on any non-ack — same shape as the vault. For the
   *  build system this also owns the CONSTRUCTION MOMENT: scaffold + three
   *  hammer beats while the cloud write is in flight (min 1.6s so fast
   *  networks still get the moment), then the pop-in reveal. */
  private async buildHere(b: {
    system: 'bench' | 'build';
    plot: number;
    icon: string;
    name: string;
    timber: number;
    coins: number;
    kind?: number;
  }): Promise<void> {
    if (this.timber < b.timber || !this.scene.spendCoins(b.coins)) return;
    this.timber -= b.timber;
    this.persistTimber();
    if (b.system === 'build') {
      this.scene.beginConstruction(b.plot, performance.now() / 1000);
      sfx.blip();
    }
    const sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms));
    const [res] =
      b.system === 'bench'
        ? [await placeBench(b.plot)]
        : await Promise.all([placeBuild(b.plot, b.kind), sleep(1600)]);
    if (typeof res !== 'number') {
      if (b.system === 'build') this.scene.cancelConstruction(b.plot);
      this.timber += b.timber;
      this.persistTimber();
      this.scene.addCoins(b.coins);
      this.ui.toast(
        res === 'full'
          ? `${b.icon} "That's plenty of building for one visitor," says the carpenter — reclaim timber at one of your builds.`
          : `${b.icon} The build cart is stuck — materials returned.`,
      );
      return;
    }
    if (b.system === 'bench') {
      this.scene.renderWorldBench(b.plot);
    } else {
      this.ownBuilds.set(b.plot, res);
      this.scene.finishConstruction(b.plot, b.kind);
    }
    sfx.coin();
    track('build_placed', { system: b.system, kind: b.name, plot: b.plot, slot: res });
    const PAYOFF: Record<string, string> = {
      signpost: '🪧 Raised! Travellers will read it forever.',
      lantern: '🏮 Raised! Watch it light when night falls.',
      gazebo: "⛩️ The island's grandest visitor build — and it's yours.",
      planter: '🌸 Raised! Fresh blooms for every passer-by.',
      campfire: '🔥 Raised! The embers glow after dark.',
      bench: '🪑 Built! Reload the page — it will still be here.',
    };
    this.ui.toast(PAYOFF[b.name] ?? `${b.icon} Built! Everyone sees it — forever.`);
  }

  /** Build chooser at a free plot: rows = allowed kinds for the plot size,
   *  the explicit labeled cost button IS the purchase confirm. */
  private openBuildChooser(plot: number): void {
    const site = GameScene.BUILD_PLOTS[plot];
    if (!site) return;
    const kinds = (['signpost', 'lantern', 'gazebo', 'planter', 'campfire'] as const).filter(
      (k) => k !== 'gazebo' || site.size === 'L',
    );
    const coins = this.scene.getCoinsCollected();
    this.ui.showBuildChooser(
      kinds.map((k) => {
        const c = SimpleApp.BUILD_COSTS[k];
        const wire = BUILD_KIND_IDS.indexOf(k);
        const shortTimber = Math.max(0, c.timber - this.timber);
        const shortCoins = Math.max(0, c.coins - coins);
        return {
          icon: c.icon,
          name: c.name,
          timber: c.timber,
          coins: c.coins,
          affordable: shortTimber === 0 && shortCoins === 0,
          shortfall:
            shortTimber > 0
              ? `need ${shortTimber} more 🪵 (chop ${Math.ceil(shortTimber / 3)} tree${Math.ceil(shortTimber / 3) > 1 ? 's' : ''})`
              : shortCoins > 0
                ? `need ${shortCoins} more 🪙`
                : '',
          kind: wire,
        };
      }),
      { timber: this.timber, coins, built: this.ownBuilds.size, cap: 6 },
      (choice) => {
        const c = SimpleApp.BUILD_COSTS[BUILD_KIND_IDS[choice] ?? 'signpost'];
        void this.buildHere({ system: 'build', plot, ...c, kind: choice });
      },
    );
    track('build_chooser_open', { plot });
  }

  /** Options on your OWN build: reclaim the timber (coins stay spent — the
   *  carpenter keeps his labour fee) or replace via reclaim + chooser. */
  private openBuildOptions(plot: number): void {
    const slot = this.ownBuilds.get(plot);
    if (slot === undefined) return;
    const rendered = this.scene
      .builtPlotSummary()
      .find((s) => s.system === 'build' && s.plot === plot);
    const kindName = rendered && rendered.kind !== 'bench' ? rendered.kind : 'signpost';
    const c = SimpleApp.BUILD_COSTS[kindName];
    this.ui.showBuildOptions({ icon: c.icon, name: c.name, timber: c.timber }, async (action) => {
      const ok = await removeBuild(slot);
      if (!ok) {
        this.ui.toast('🔨 The carpenter is busy — try again shortly.');
        return;
      }
      this.ownBuilds.delete(plot);
      this.scene.removeWorldBuild(plot);
      this.timber += c.timber;
      this.persistTimber();
      sfx.blip();
      track('build_reclaimed', { plot, kind: c.name, replace: action === 'replace' });
      this.ui.toast(`🪵 +${c.timber} reclaimed — the carpenter keeps his labour fee.`);
      if (action === 'replace') this.openBuildChooser(plot);
    });
  }

  private persistLessons(): void {
    try {
      localStorage.setItem('ds_lessons', JSON.stringify(this.lessons));
    } catch {
      /* no storage */
    }
    saveProfile({ lessons: this.lessons });
  }

  private persistHarvest(): void {
    try {
      localStorage.setItem('ds_wheat', String(this.wheat));
      localStorage.setItem('ds_produce', String(this.produce));
    } catch {
      /* no storage */
    }
    this.syncInventory();
  }

  private persistOre(): void {
    try {
      localStorage.setItem('ds_ore', String(this.ore));
    } catch {
      /* no storage */
    }
    this.syncInventory();
  }

  private persistTimber(): void {
    try {
      localStorage.setItem('ds_timber', String(this.timber));
    } catch {
      /* no storage */
    }
    this.syncInventory();
  }

  private persistFish(): void {
    try {
      localStorage.setItem('ds_fish_caught', String(this.fishCaught));
    } catch {
      /* no storage */
    }
    this.syncInventory();
  }

  /** Mirror the raw inventory to the cloud profile. Consumable Law: this is
   *  a one-way PUSH — the pull side (inventoryAdoptValue) only ever adopts on
   *  a device that has no local record, so a sale is never refunded. */
  private syncInventory(): void {
    this.hasLocalInventory = true;
    this.refreshPackIfOpen(); // fish/timber/wheat/produce/ore all persist through here
    saveProfile({
      inventory: {
        fish: this.fishCaught,
        timber: this.timber,
        wheat: this.wheat,
        produce: this.produce,
        ore: this.ore,
      },
    });
  }

  /** Owned tools are monotonic own-flags — union-merged, so buying a rod on
   *  one device makes it owned everywhere and nothing can revoke it. */
  private syncTools(): void {
    const owned: string[] = [];
    if (this.ownedRod) owned.push(SimpleApp.ROD_ID);
    if (this.ownedAxe) owned.push(SimpleApp.AXE_ID);
    if (this.ownedSickle) owned.push(SimpleApp.SICKLE_ID);
    if (this.ownedPickaxe) owned.push(SimpleApp.PICKAXE_ID);
    saveProfile({ tools: owned });
  }

  private persistBirdFeed(): void {
    this.hasLocalBirdFeed = true;
    try {
      localStorage.setItem('ds_bird_feed', String(this.birdFeed));
    } catch {
      /* session-only */
    }
    saveProfile({ birdFeed: this.birdFeed });
  }

  private persistCatFeed(): void {
    this.hasLocalCatFeed = true;
    try {
      localStorage.setItem('ds_cat_feed', String(this.catFeed));
    } catch {
      /* session-only */
    }
    saveProfile({ catFeed: this.catFeed });
  }

  private persistFishFeed(): void {
    this.hasLocalFishFeed = true;
    try {
      localStorage.setItem('ds_fish_feed', String(this.fishFeed));
    } catch {
      /* session-only */
    }
    saveProfile({ fishFeed: this.fishFeed });
  }

  private persistMeals(): void {
    this.hasLocalMeals = true;
    try {
      localStorage.setItem('ds_meals', JSON.stringify(this.meals));
    } catch {
      /* session-only */
    }
    saveProfile({ meals: { ...this.meals } });
  }

  /** The full price for a sale, doubled (×2.5 on market day) when this
   *  provider is today's special. Satiated tail is unaffected (kept at 1c by
   *  the caller), so the extra faucet is bounded by cap × base × (mult-1). */
  private featuredPrice(provider: ProviderKey, base: number): number {
    return this.featured.provider === provider ? Math.round(base * this.featured.mult) : base;
  }

  /** One-time-per-day nudge + a ⭐ prompt prefix for the featured provider. */
  private featuredStar(provider: ProviderKey): string {
    return this.featured.provider === provider ? "⭐ Today's special! " : '';
  }

  /** Recompute today's special from the local date (offline-safe); market day
   *  from the world beat lifts the multiplier. */
  private refreshFeatured(marketDay = false): void {
    const dayKey = new Date().toISOString().slice(0, 10);
    this.featured = featuredSell(dayKey, marketDay);
    try {
      // Keyed by day AND tier: boot calls this with marketDay=false before the
      // world beat lands, so a day-only key burned the one-shot and the
      // "Market day!" upgrade could never announce itself.
      const key = `ds_hint_special_${dayKey}${marketDay ? '_market' : ''}`;
      if (!localStorage.getItem(key)) {
        localStorage.setItem(key, '1');
        const label: Record<ProviderKey, string> = {
          fisherman: 'the fisherman',
          baker: 'the Baker',
          canteen: 'the canteen',
          bank: 'the bank',
          carpenter: 'the Carpenter',
        };
        this.ui.toast(
          `⭐ ${marketDay ? 'Market day! ' : ''}${label[this.featured.provider as ProviderKey]} is paying extra today.`,
        );
      }
    } catch {
      /* no storage */
    }
  }

  /** Eat one cooked meal (G / the EAT button): restore stamina, smallest
   *  sufficient first so a pie is never wasted topping off a near-full bar. */
  private eatMeal(): void {
    if (this.ui.isShopOpen() || this.ui['customizeDiv']) return;
    const player = this.scene.getPlayer();
    if (player && player.getStamina() > 0.95) {
      this.ui.flashMessage('😋 Still full of energy');
      return;
    }
    const pick = (['soup', 'fish', 'pie'] as const).find((k) => this.meals[k] > 0);
    if (!pick) {
      this.ui.flashMessage('🍽️ No food — buy soup, grilled fish or a pie at the Island Shop');
      return;
    }
    this.meals[pick]--;
    this.persistMeals();
    this.refreshFeedHud();
    const gained = player?.addStamina(SimpleApp.MEAL_STAMINA[pick]) ?? 0;
    if (pick === 'pie') player?.boostSprint(20); // well-fed stroll (1.35 passive)
    this.scene.showEatGesture();
    sfx.blip();
    track('meal_eaten', { kind: pick, gained: +gained.toFixed(2) });
    this.ui.toast(
      pick === 'pie'
        ? '🥧 Delicious — fully rested, with a spring in your step (20s)'
        : '🍽️ Tasty — stamina restored',
    );
  }

  /**
   * One Feed action (F / the FEED button). It looks at where you're aiming and
   * throws the right feed: over water → fish food; over land → whichever of
   * cats/birds you're pointing at (falling back to the other land feed if you
   * only hold one). A charge is spent only once the scene confirms the throw
   * landed somewhere sane, so a wasted press never costs feed.
   */
  private tossFeed(): void {
    if (this.ui.isShopOpen() || this.ui['customizeDiv']) return;
    const aim = this.scene.classifyFeedAim();
    if (aim.surface === 'water') {
      if (this.fishFeed <= 0) {
        this.ui.flashMessage('🐟 No fish feed — buy some at the Island Shop');
        return;
      }
      if (!this.scene.throwFishFeed()) {
        this.ui.flashMessage('🐟 Aim at the open water');
        return;
      }
      this.fishFeed--;
      this.persistFishFeed();
      this.refreshFeedHud();
      track('fish_feed_thrown', { left: this.fishFeed });
      return;
    }
    // Land: try the feed for the animal you're aiming at first, then the other.
    const order: Array<'cat' | 'bird'> = aim.land === 'cat' ? ['cat', 'bird'] : ['bird', 'cat'];
    for (const kind of order) {
      if (kind === 'cat' && this.catFeed > 0) {
        if (!this.scene.throwCatFeed()) {
          this.ui.flashMessage('🐈 Not here — try over open ground');
          return;
        }
        this.catFeed--;
        this.persistCatFeed();
        this.refreshFeedHud();
        track('cat_feed_thrown', { left: this.catFeed });
        return;
      }
      if (kind === 'bird' && this.birdFeed > 0) {
        if (!this.scene.throwBirdFeed()) {
          this.ui.flashMessage('🌾 Not here — try over open ground');
          return;
        }
        this.birdFeed--;
        this.persistBirdFeed();
        this.refreshFeedHud();
        track('bird_feed_thrown', { left: this.birdFeed });
        return;
      }
    }
    this.ui.flashMessage('🌾 No feed — buy Bird, Cat or Fish feed at the Island Shop');
  }

  /**
   * Open the appearance editor (C): live-recolour body parts + pick an owned
   * hat. Each change applies to the model immediately and persists (local +
   * cloud profile).
   */
  private openCustomize(): void {
    const player = this.scene.getPlayer();
    if (!player) return;
    const appr = player.getAppearance();
    const colors: Record<string, number | undefined> = { ...appr };
    this.ui.showCustomize({
      colors,
      ownedHats: [...this.ownedHats],
      equippedHat: this.equippedHat,
      hats: this.hatCatalog.map((h) => ({ id: h.id, icon: h.icon })),
      onColor: (part, hex) => {
        player.setBodyColor(part as BodyPart, hex);
        this.saveAppearance();
      },
      onHat: (id) => {
        this.equippedHat = id;
        try {
          if (id) localStorage.setItem('ds_hat', id);
          else localStorage.removeItem('ds_hat');
        } catch {
          /* session-only */
        }
        this.scene.equipPlayerHat((id as HatId) ?? null);
        this.multiplayer?.setHat((id as HatId) ?? null);
        saveProfile({ hat: id, ownedHats: [...this.ownedHats] });
      },
    });
  }

  /** Persist the current body colours to localStorage + the cloud profile. */
  private saveAppearance(): void {
    const colors = this.currentColorsHex();
    try {
      localStorage.setItem('ds_appearance', JSON.stringify(colors));
    } catch {
      /* session-only */
    }
    saveProfile({ colors });
  }

  /**
   * Pull the cloud profile once Firebase auth settles and reconcile it with
   * local state. Each field merges by the contract its DATA TYPE demands:
   *   - UNION (monotonic, can never regress): owned hats, lessons, owned tools.
   *   - ADOPT-ONCE (only on a device with no local record): coins, feed
   *     charges, meals, raw inventory. NEVER max-merge these — "take the
   *     higher" was a live exploit (buy the rod, reload before the debounced
   *     save lands, keep both the rod and the balance), so it was removed;
   *     see coinAdoptValue / mealsAdoptValue / inventoryAdoptValue.
   *   - Equipped hat is restored only when NO hat is currently equipped.
   *   - Name is written back but never overridden — it stays owned by
   *     localStorage / the on-visit prompt.
   * Then the merged state is pushed back so the cloud reflects this device.
   */
  private async syncProfile(): Promise<void> {
    const res = await loadProfile();
    if (!res) return;
    const { profile } = res;
    if (profile) {
      if (profile.ownedHats?.length) {
        this.ownedHats = new Set<string>([...profile.ownedHats, ...this.ownedHats]);
        try {
          localStorage.setItem('ds_owned_hats', JSON.stringify([...this.ownedHats]));
        } catch {
          /* session-only */
        }
      }
      if (profile.hat && !this.equippedHat) {
        this.equippedHat = profile.hat;
        try {
          localStorage.setItem('ds_hat', profile.hat);
        } catch {
          /* session-only */
        }
        this.scene.equipPlayerHat(profile.hat as HatId);
        this.multiplayer?.setHat(profile.hat as HatId);
      }
      // ADOPT-ONCE, not max-merge: the old "take the higher" refunded every
      // purchase made before the debounced save landed (the rod exploit).
      // Cross-device coin sync is intentionally dead until the bank vault
      // ships — see docs/superpowers/specs/2026-08-10-economy-design.md P0.
      {
        const adopt = coinAdoptValue(this.scene.hasLocalCoins(), profile.coins);
        if (adopt !== null) this.scene.setCoins(adopt);
      }
      // Lessons are per-ACCOUNT: union both ways, save back if the union grew.
      {
        const merged = mergeLessons(this.lessons, profile.lessons);
        if (merged.length !== this.lessons.length) {
          this.lessons = merged;
          this.persistLessons();
        }
      }
      // Consumables must NOT max-merge the way coins do. Coins only go up, but
      // feed is SPENT: this sync resolves seconds after boot and behind an
      // 800ms-debounced write, so "take the higher" would hand back every
      // charge thrown in the meantime (and infinitely, by reloading mid-throw).
      // The cloud value is only adopted when this device has no count at all.
      if (!this.hasLocalBirdFeed && typeof profile.birdFeed === 'number') {
        this.hasLocalBirdFeed = true;
        this.birdFeed = Math.max(0, Math.floor(profile.birdFeed));
        try {
          localStorage.setItem('ds_bird_feed', String(this.birdFeed));
        } catch {
          /* session-only */
        }
        this.refreshFeedHud();
      }
      // Same adopt-once guard for cat + fish feed — NEVER max-merge a
      // consumable (it refunds every charge spent since boot).
      if (!this.hasLocalCatFeed && typeof profile.catFeed === 'number') {
        this.hasLocalCatFeed = true;
        this.catFeed = Math.max(0, Math.floor(profile.catFeed));
        try {
          localStorage.setItem('ds_cat_feed', String(this.catFeed));
        } catch {
          /* session-only */
        }
        this.refreshFeedHud();
      }
      if (!this.hasLocalFishFeed && typeof profile.fishFeed === 'number') {
        this.hasLocalFishFeed = true;
        this.fishFeed = Math.max(0, Math.floor(profile.fishFeed));
        try {
          localStorage.setItem('ds_fish_feed', String(this.fishFeed));
        } catch {
          /* session-only */
        }
        this.refreshFeedHud();
      }
      // Owned tools: UNION merge (monotonic own-flags — a stale device can
      // never revoke a tool you bought elsewhere).
      {
        const before = [
          this.ownedRod && SimpleApp.ROD_ID,
          this.ownedAxe && SimpleApp.AXE_ID,
          this.ownedSickle && SimpleApp.SICKLE_ID,
          this.ownedPickaxe && SimpleApp.PICKAXE_ID,
        ].filter((v): v is string => typeof v === 'string');
        const merged = mergeTools(before, profile.tools);
        if (merged.length > before.length) {
          const has = (id: string) => merged.includes(id);
          this.ownedRod = has(SimpleApp.ROD_ID);
          this.ownedAxe = has(SimpleApp.AXE_ID);
          this.ownedSickle = has(SimpleApp.SICKLE_ID);
          this.ownedPickaxe = has(SimpleApp.PICKAXE_ID);
          try {
            if (this.ownedRod) localStorage.setItem('ds_rod', '1');
            if (this.ownedAxe) localStorage.setItem('ds_axe', '1');
            if (this.ownedSickle) localStorage.setItem('ds_sickle', '1');
            if (this.ownedPickaxe) localStorage.setItem('ds_pickaxe', '1');
          } catch {
            /* session-only */
          }
        }
      }
      // Raw inventory: adopt-once, same contract as meals.
      {
        const adopted = inventoryAdoptValue(this.hasLocalInventory, profile.inventory);
        if (adopted) {
          this.hasLocalInventory = true;
          this.fishCaught = adopted.fish;
          this.timber = adopted.timber;
          this.wheat = adopted.wheat;
          this.produce = adopted.produce;
          this.ore = adopted.ore;
          try {
            localStorage.setItem('ds_fish_caught', String(this.fishCaught));
            localStorage.setItem('ds_timber', String(this.timber));
            localStorage.setItem('ds_wheat', String(this.wheat));
            localStorage.setItem('ds_produce', String(this.produce));
            localStorage.setItem('ds_ore', String(this.ore));
          } catch {
            /* session-only */
          }
        }
      }
      // Cooked-food meals: adopt-once (never max-merge — that would refund
      // every meal already eaten on this device). Routed through the TESTED
      // helper: the inline copy this replaced skipped its Number.isFinite
      // gate, so a non-numeric cloud value (the rules validate only name and
      // coins) turned this.meals into NaN and poisoned the HUD total.
      {
        const adoptedMeals = mealsAdoptValue(this.hasLocalMeals, profile.meals);
        if (adoptedMeals) {
          this.hasLocalMeals = true;
          this.meals = adoptedMeals;
          try {
            localStorage.setItem('ds_meals', JSON.stringify(this.meals));
          } catch {
            /* session-only */
          }
          this.refreshFeedHud();
        }
      }
      // Body colours: apply the cloud choice for any part not set locally
      if (profile.colors) {
        const player = this.scene.getPlayer();
        const local = player?.getAppearance() ?? {};
        for (const key of Object.keys(profile.colors)) {
          if (local[key as BodyPart] === undefined) {
            const hex = parseInt(profile.colors[key].replace('#', ''), 16);
            if (Number.isFinite(hex)) player?.setBodyColor(key as BodyPart, hex);
          }
        }
      }
    }
    saveProfile({
      name: this.multiplayer?.selfName,
      hat: this.equippedHat,
      ownedHats: [...this.ownedHats],
      coins: this.scene.getCoinsCollected(),
      birdFeed: this.birdFeed,
      catFeed: this.catFeed,
      fishFeed: this.fishFeed,
      colors: this.currentColorsHex(),
      // Latest-wins by construction (this session IS the latest activity);
      // the "away" card reads the local ds_last_seen — this field is for
      // future cross-device deltas.
      lastSeen: Date.now(),
    });
  }

  /** Current body colours as hex strings (for persistence). */
  private currentColorsHex(): Record<string, string> {
    const appr = this.scene.getPlayer()?.getAppearance() ?? {};
    const out: Record<string, string> = {};
    for (const key of Object.keys(appr)) {
      const hex = appr[key as BodyPart];
      if (typeof hex === 'number') out[key] = `#${hex.toString(16).padStart(6, '0')}`;
    }
    return out;
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
      // 60s loop (was 120): halves synthesis cost/memory; the pad+melody
      // cycles still line up, and it loops seamlessly for ambience.
      const duration = 60;
      const N = sr * duration;
      const buffer = ctx.createBuffer(2, N, sr);

      // --- Musical constants ---
      const TAU = 2 * Math.PI;
      // Pentatonic scale frequencies (C major pentatonic across two octaves)
      const NOTE = {
        C3: 130.81,
        D3: 146.83,
        E3: 164.81,
        G3: 196.0,
        A3: 220.0,
        C4: 261.63,
        D4: 293.66,
        E4: 329.63,
        G4: 392.0,
        A4: 440.0,
        C5: 523.25,
        E5: 659.25,
        G5: 783.99,
      };

      // Chord progression: 10s per chord, cycles every 40s
      const chords = [
        { bass: NOTE.C3, tones: [NOTE.C4, NOTE.E4, NOTE.G4] }, // Cmaj
        { bass: NOTE.A3 * 0.5, tones: [NOTE.A3, NOTE.C4, NOTE.E4] }, // Am
        { bass: NOTE.G3 * 0.5, tones: [NOTE.G3, NOTE.D4, NOTE.G4] }, // G5sus
        { bass: NOTE.C3, tones: [NOTE.E4, NOTE.G4, NOTE.C5] }, // Cmaj (inv)
      ];
      const chordDur = 10;

      // Melody: sequence of pentatonic notes with timing
      const melodyNotes = [
        NOTE.E4,
        NOTE.G4,
        NOTE.A4,
        NOTE.G4,
        NOTE.E4,
        NOTE.C4,
        NOTE.D4,
        NOTE.E4,
        NOTE.G4,
        NOTE.C5,
        NOTE.A4,
        NOTE.G4,
        NOTE.E4,
        NOTE.D4,
        NOTE.C4,
        NOTE.E4,
        NOTE.A4,
        NOTE.G4,
        NOTE.E4,
        NOTE.G4,
        NOTE.C5,
        NOTE.A4,
        NOTE.G4,
        NOTE.E4,
      ];
      const melNoteDur = 2.5;

      // Soft waveform: sine with a touch of 2nd harmonic for warmth
      const soft = (phase: number) =>
        Math.sin(phase) * 0.85 + Math.sin(phase * 2) * 0.12 + Math.sin(phase * 3) * 0.03;

      // ADSR envelope
      const env = (
        t: number,
        atk: number,
        dec: number,
        sus: number,
        rel: number,
        total: number,
      ) => {
        if (t < 0 || t > total) return 0;
        if (t < atk) return t / atk;
        if (t < atk + dec) return 1 - (1 - sus) * ((t - atk) / dec);
        if (t < total - rel) return sus;
        return sus * (1 - (t - (total - rel)) / rel);
      };

      // Seeded PRNG for deterministic variation
      let seed = 42;
      const rand = () => {
        seed = (seed * 16807) % 2147483647;
        return seed / 2147483647;
      };

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

      // Fill the buffer in idle time-slices instead of one ~1s synchronous
      // block. That block used to land right as the loader faded — freezing
      // rAF mid-reveal (the "flash" + "random lag right before the island
      // opens"). State (ch / i / lp) is carried across slices; output is
      // byte-identical to the old loop.
      await new Promise<void>((resolve) => {
        let ch = 0;
        let i = 0;
        let d = buffer.getChannelData(0);
        let lp = 0;
        let panShift = 0;
        const SLICE = 40000; // samples per slice (~a few ms) — caps each task

        const fill = (deadline?: { timeRemaining: () => number; didTimeout: boolean }) => {
          const hasTime = () =>
            deadline ? deadline.timeRemaining() > 3 || deadline.didTimeout : true;
          while (ch < 2) {
            let budget = SLICE;
            while (i < N && budget-- > 0 && hasTime()) {
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
              const melT = t % melNoteDur;
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
                  birdVal += Math.sin((rel / sr) * freq * TAU) * bEnv;
                }
              }

              // --- Mix ---
              d[i] = padVal * 0.045 + melVal * 0.05 + arpVal * 0.025 + wind * 0.02 + birdVal * 0.03;
              i++;
            }
            if (i >= N) {
              ch++;
              if (ch >= 2) {
                resolve();
                return;
              }
              d = buffer.getChannelData(ch);
              lp = 0;
              panShift = ch === 0 ? 0 : 0.4;
              i = 0;
            } else {
              break; // out of budget/time — resume next slice
            }
          }
          if (typeof requestIdleCallback === 'function') {
            requestIdleCallback(fill, { timeout: 500 });
          } else {
            setTimeout(() => fill(undefined), 0);
          }
        };
        if (typeof requestIdleCallback === 'function') {
          requestIdleCallback(fill, { timeout: 500 });
        } else {
          setTimeout(() => fill(undefined), 0);
        }
      });

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

    if (this.chat) {
      this.chat.dispose();
    }

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

    if (this.boundHandlers.chatKeydown) {
      window.removeEventListener('keydown', this.boundHandlers.chatKeydown);
    }

    if (this.boundHandlers.chatKeyup) {
      window.removeEventListener('keyup', this.boundHandlers.chatKeyup);
    }

    const muteCanvas = document.getElementById('game-canvas');
    if (muteCanvas && this.boundHandlers.mutePointerDown) {
      muteCanvas.removeEventListener('pointerdown', this.boundHandlers.mutePointerDown);
    }
    if (muteCanvas && this.boundHandlers.mutePointerUp) {
      muteCanvas.removeEventListener('pointerup', this.boundHandlers.mutePointerUp);
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
  // Exposed for headless E2E verification (drive update(), start the tour,
  // read state). The client is untrusted by design, so this adds no surface.
  (window as unknown as { app?: SimpleApp }).app = new SimpleApp();
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

console.log(
  '%c🌎 Welcome to DigiScalability Life Island',
  'color: #4ade80; font-size: 16px; font-weight: bold',
);
console.log('%cSimplified architecture ready for deployment', 'color: #60a5fa');
