import { inject } from '@vercel/analytics';
import * as THREE from 'three';

import { a11y } from './Accessibility';
import { isOwnerVisit, startDwellTracking, track, trackOnce } from './Analytics';
import { setInkVisible } from './CelLook';
import type { Chat } from './Chat';
import {
  compassBearing,
  compassTarget,
  nearestNeighbourTour,
  nearestWithHysteresis,
  type CompassState,
} from './Compass';
import { DeliverySystem } from './DeliverySystem';
import { DISTRICTS } from './Districts';
import { featuredSell, saleSplit, type ProviderKey } from './economy';
import { EnvironmentCycle } from './EnvironmentCycle';
import {
  easeInOutSine,
  tourCaption,
  tourFirstLegLift,
  tourLegDuration,
  TOUR_DWELL_S,
} from './Framing';
import { fx } from './FxBudget';
import { GameScene, type Exhibits } from './GameScene';
import {
  Guide,
  guideCopy,
  NextChip,
  readGuideTo,
  RecruiterRoute,
  resolveGuideKey,
  type GuideArm,
  type GuideButton,
  type GuideFrame,
  type GuideStore,
  type GuideWorld,
  type RouteSource,
} from './Guide';
import { GuideCard } from './GuideCard';
import { HudLabels, type BubbleCandidate } from './HudLabels';
import { expDecay, expDecayV3, tick as juiceTick } from './Juice';
import { enterOpensChat } from './keyGuards';
import { worldInputBlocked } from './keyGuards';
import { Materials } from './Materials';
import type { Multiplayer } from './Multiplayer';
import {
  AI_NPCS,
  askNpc,
  askNpcOpening,
  composeAwareGreeting,
  isAiNpc,
  voiceProfileFor,
} from './NpcChat';
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
import type { RaceEvent } from './RaceSystem';
import { SECRETS, Secrets } from './Secrets';
import { sfx } from './Sfx';
import { decodePostcardPose } from './Share';
import { PROJECT_BOARDS } from './SignPainter';
import { SimpleInputManager, consumePinchZoomFactor } from './SimpleInputManager';
import type { BodyPart, HatId } from './SimplePlayer';
import { SimpleRenderer } from './SimpleRenderer';
import { SimpleUI } from './SimpleUI';
import { applySoftLookFogPatch } from './SoftLook';
import { cancelSpeech } from './Speech';
import { isRealTheme } from './Theme';
import { placeBench, subscribeBenches } from './worldBenches';
import { BUILD_KIND_IDS, placeBuild, removeBuild, subscribeBuilds } from './worldBuilds';
import { WORLD_ERA, WORLD_RADIUS } from './WorldScale';
import { connectWorldState, getWorldState, moodNpcFlavor, MOOD_META } from './WorldState';

import './style.css';

// Analytics MUST fire at module evaluation, not after the world boots: the old
// idle-deferred inject meant every visitor who bounced during the loading
// screen (or hit the WebGL fallback) was invisible — the top of the funnel was
// unmeasured. inject() is cookieless and failure-safe; custom events stay lazy.
try {
  inject({
    mode: import.meta.env.PROD ? 'production' : 'development',
    // Owner opt-out: after one visit with ?owner=1 this browser's pageviews
    // stop counting too, not just the custom events (Analytics.isOwnerVisit).
    beforeSend: (event) => (isOwnerVisit() ? null : event),
  });
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
 * GameScene accessors from a package that merges after A in wave 4, read
 * through optional calls so this branch is green on its own (P2-A8): B's
 * nearest unoccupied vehicle of a kind, written into `out` with no allocation.
 */
type RaceScene = GameScene & {
  nearestVehiclePos?: (kind: 'car' | 'boat' | 'jetski', out: THREE.Vector3) => THREE.Vector3 | null;
};

/**
 * Chat.ts's PROXIMITY_RADIUS (0.35 x the world radius), copied so Chat.ts can
 * be its own chunk (wave-4 bundle carry-over). test/mainLocks pins the two equal.
 */
const CHAT_PROXIMITY_RADIUS = 0.35 * WORLD_RADIUS;

/** One stop on the cinematic tour rail (SimpleApp.startTour). */
interface TourStop {
  caption: string;
  look: THREE.Vector3; // surface point the camera studies
  dir: THREE.Vector3; // camera position direction (unit, from planet centre)
  r: number; // camera position radius
  alt: number; // camera height above the subject
  back: number; // camera set-back along the tangent
  /** A villager stop: who to frame, in order of preference. Re-read (and
   *  held in place) when the leg to it starts, because villagers walk. */
  villagers?: readonly string[];
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
 *
 * Exported for test/interiorEntry.test.ts, which drives single methods on a
 * stub. Importing this module still boots the app unless
 * window.__lifeIslandBooted is already set (see bootApp below).
 */
export class SimpleApp {
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
  // source; cleared on arrival or a fresh pick (see updateQuestCompass).
  private mapGuideTarget: THREE.Vector3 | null = null;
  /** Whatever the compass pill currently points at — the island map halos it
   *  so the two wayfinding surfaces visibly agree. */
  private lastCompassTarget: THREE.Vector3 | null = null;
  private mapGuideLabel = '';
  /** The pill's label this frame, '' when it is hidden. A probe hook: the
   *  phone pill shows only the label's first word. */
  public compassLabel = '';
  /** A district pick ends at that district's door, not 6 u short of it. */
  private mapGuideZone: string | null = null;
  /** After any map-pick arrival the pill holds on the reached spot for 8 s. */
  private arrivalHold: { pos: THREE.Vector3; label: string; until: number } | null = null;
  /** The zone whose door prompt is up this frame (set where it is shown). */
  private doorPromptZone: string | null = null;
  /** The villager the first-visit coins lead to, chosen once at afterIntro
   *  (A7). Null: no awake AI villager within 30 u. */
  private trailVillager: string | null = null;
  /** The trail branch is over for this visit: the visitor reached or talked
   *  to the villager, stamped a district or picked a place, even with coins
   *  still down (a missed coin must not pull the pill back to spawn). */
  private trailDone = false;
  /** The district the pill is on: it switches only when another is 12 u closer. */
  private compassDistrict: string | null = null;
  /** A parcel was collected this session: deliveries may take the pill. */
  private deliveryOptIn = false;
  /**
   * The pack lines ('+1 (n in the pack)') and finished deliveries, counted.
   * A pack line goes stale (its toast until()) once a newer pack line or a
   * delivery follows it: four quick harvests queued four cabbage lines, about
   * 2.5 s each, and the 'Delivered. The next parcel waits near …' line waited
   * 5.4 s behind them on desktop (wave-3 integration, p2/gather).
   */
  private packToastSeq = 0;
  private deliveryToastSeq = 0;

  /** A pack line that gives way to the next pack line or a delivery. */
  private packToast(text: string): void {
    const pack = ++this.packToastSeq;
    const delivered = this.deliveryToastSeq;
    this.ui.toast(text, {
      until: () => this.packToastSeq !== pack || this.deliveryToastSeq !== delivered,
    });
  }
  /** Passport stamps seen, for the "Next:" flash after stamps 1-3. */
  private stampsSeen = -1;
  private pendingNextFlash = false;
  private readonly districtDists: Array<{ id: string; dist: number }> = [];
  // "Beat the lap record" CTA → compass points at the start gate until a race starts
  private raceGuideTarget: THREE.Vector3 | null = null;
  /** P2-A8: the CTA's guide leads to a parked car first, then the start. */
  private raceGuideViaCar = false;
  /** P2-A8: a race runs (set on 'start', cleared on 'finish' and 'abort').
   *  While it is set, main-simple's unprompted hints wait and keep their
   *  once-ever keys (guideHoldsHints, hintsQuiet). */
  private racing = false;
  /** P2-A8: the next ring, written by getRaceNextGate (no allocation). */
  private readonly _qcRaceGate = new THREE.Vector3();
  /** P2-A8: the nearest parked car, written by nearestVehiclePos. */
  private readonly _qcCar = new THREE.Vector3();

  // Tour mode: a skippable cinematic rail over the districts for the visitor
  // who won't touch WASD (the Breton camera-rail pattern from the audit).
  // While active the orbit camera is suspended and this drives the scene
  // camera directly; the world (NPCs, sea, activities) keeps living.
  private tour: {
    stops: TourStop[];
    idx: number;
    t: number;
    phase: 'fly' | 'dwell';
    fromDir: THREE.Vector3;
    fromR: number;
    fromLook: THREE.Vector3;
    /** The villager this tour is holding in place (GameScene dialogue hold). */
    held: string | null;
    /** A9: this leg's flight time (legDuration), seconds. */
    legS: number;
    /** A9: the view direction the leg leaves on (unit). */
    fromView: THREE.Vector3;
    /** MOT-06: the camera's orientation as the leg leaves (continuous with the frame before). */
    fromQuat: THREE.Quaternion;
  } | null = null;
  /** afterIntro has run: the welcome card, if any, is up or already closed. */
  private introSettled = false;
  // Tour scratch (kept allocation-free per frame)
  private readonly _tourDir = new THREE.Vector3();
  private readonly _tourLook = new THREE.Vector3();
  private readonly _tourUp = new THREE.Vector3();
  private readonly _tourFromPos = new THREE.Vector3();
  private readonly _tourViewA = new THREE.Vector3();
  private readonly _tourViewB = new THREE.Vector3();
  private readonly _tourAxis = new THREE.Vector3();
  private readonly _tourQ = new THREE.Quaternion();
  private readonly _tourToQuat = new THREE.Quaternion();
  private readonly _tourArcQ = new THREE.Quaternion();
  private readonly _tourMat = new THREE.Matrix4();
  // Villager line-of-sight probe (firstHitOnly: the terrain's BVH fast path)
  private readonly _tourRay = Object.assign(new THREE.Raycaster(), { firstHitOnly: true });

  // Completion meter recompute throttle (localStorage reads are cheap; 2.5s
  // keeps the pill fresh without touching storage every frame)
  private completionAccum = 0;
  private lostAccum = 0; // in-world seconds, for the lost-visitor recovery hint

  /** A coarse pointer (phones, tablets): the rooms warm early (CO-A5). */
  private readonly coarsePointer =
    typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  /**
   * A phone or tablet: a coarse pointer that cannot hover. It takes the calm
   * entry instead of the intro fly-in (A10, decision 6). Not
   * isLowTierDevice(), which also catches laptops with 4 cores or fewer; a
   * fine pointer always flies in.
   */
  private readonly calmEntry =
    this.coarsePointer && typeof matchMedia === 'function' && matchMedia('(hover: none)').matches;
  /** The canvas a calm entry holds at opacity 0 until the loader starts to fade. */
  private calmEntryCanvas: HTMLCanvasElement | null = null;
  /** The fly-in's second priming of its ink and shadow levers (see init). */
  private primeIntroAgain: (() => void) | null = null;

  /**
   * The calm entry's cross-fade: the world comes up over 600 ms while the
   * loader fades out above it. Opacity only, so it stays on the compositor.
   * The inline styles are cleared afterwards whether or not a frame ever ran
   * the transition (a hidden tab): the canvas can never be left invisible.
   */
  private startCalmEntryFade(): void {
    const canvas = this.calmEntryCanvas;
    if (!canvas) return;
    this.calmEntryCanvas = null;
    canvas.style.transition = 'opacity 600ms ease-out';
    requestAnimationFrame(() => {
      canvas.style.opacity = '1';
    });
    window.setTimeout(() => {
      canvas.style.transition = '';
      canvas.style.opacity = '';
    }, 700);
  }
  /**
   * A calm entry's card waits for the late models' first draws (w2
   * integration). The player, villager and bench GLBs land after the boot
   * pre-compile, so their skinned and instanced toon programs can only link
   * on the frames that first draw them. The fly-in hides those frames before
   * its card; a calm entry showed the card at once, so they fell after it.
   * MEASURED, low tier without KHR_parallel_shader_compile: +4 programs in a
   * 224 ms frame and +4 in a 274 ms one, 0-0.3 s after the card (main, with
   * the fly-in, linked the same 8 before its card). So afterIntro runs once
   * no program has linked for LATE_LINK_QUIET_MS over at least two frames,
   * and never sooner than the loader's fade, nor later than LATE_LINK_CAP_MS
   * (a slow network or a hidden tab must not hold the card back).
   */
  private whenLateModelsLinked(then: () => void): void {
    const LATE_LINK_MIN_MS = 600;
    const LATE_LINK_QUIET_MS = 400;
    const LATE_LINK_CAP_MS = 3000;
    const info = this.renderer.getRenderer().info;
    const count = (): number => info.programs?.length ?? 0;
    const start = performance.now();
    let last = count();
    let quietSince = start;
    let quietFrames = 0;
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      window.clearTimeout(cap);
      then();
    };
    const cap = window.setTimeout(finish, LATE_LINK_CAP_MS);
    const tick = (): void => {
      if (done) return;
      const now = performance.now();
      const n = count();
      if (n !== last) {
        last = n;
        quietSince = now;
        quietFrames = 0;
      } else quietFrames++;
      if (
        now - start >= LATE_LINK_MIN_MS &&
        now - quietSince >= LATE_LINK_QUIET_MS &&
        quietFrames >= 2
      ) {
        finish();
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
  private roomsWarmStarted = false;
  /**
   * CO-A5. At 4x CPU the idle warm's 9 s ceiling fires 6-7 s late on a busy
   * thread, and a door entered in that gap compiled under the veil: +13-15
   * programs, a 370-1110 ms frame and 0.83-1.50 s of black. On a coarse
   * pointer the warm starts at afterIntro, while the welcome card is up, or
   * at the first walk input after the fly-in, whichever comes first. Never
   * during the fly-in. Bound once: it is a setTimeout callback.
   */
  private readonly warmRoomsEarly = (): void => {
    if (this.roomsWarmStarted || !this.coarsePointer) return;
    this.roomsWarmStarted = true;
    void this.scene.warmInterior();
    this.prewarmZonePanel();
  };
  /** Skip's compass hint has shown this visit: the trail-end toast then
   *  leaves out its own clause about the gold ➤ (w1-fix nit). */
  private guideSkipHintShown = false;
  private bootTarget: THREE.WebGLRenderTarget | null = null;
  /**
   * The render target the boot pre-compile binds (w1-fix): a 1x1 stand-in
   * for the composer's buffer where there is a composer, and the canvas
   * (null) on the low tier, which never builds one. Only bound for compile
   * calls; nothing is ever drawn into it.
   */
  private bootCompileTarget(): THREE.WebGLRenderTarget | null {
    if (!this.renderer.isPostProcessingAvailable()) return null;
    this.bootTarget ??= new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType });
    return this.bootTarget;
  }
  private disposeBootCompileTarget(): void {
    this.bootTarget?.dispose();
    this.bootTarget = null;
  }
  /**
   * CO-A5 remainder (w1-fix). The first showZonePanel cost 156-184 ms at 4x
   * CPU inside the door fade's callback. D's SimpleUI.prewarmZonePanel lays
   * the panels out ahead in idle slices; both room warms ask for it.
   * Optional: A merges before D, and on main SimpleUI has no such method.
   * It is idempotent, and it schedules its own idle work.
   */
  private prewarmZonePanel(): void {
    (this.ui as SimpleUI & { prewarmZonePanel?: () => void }).prewarmZonePanel?.();
  }
  /**
   * The 9 s idle ceiling, on every device. Once the early warm has started
   * it stands down: warmInterior would return at once (it is idempotent),
   * but a second, empty warm call still reads as a warm to the hitch probe,
   * which then blames the warm for an unrelated frame after it.
   */
  private readonly warmRoomsIdle = (): void => {
    if (this.roomsWarmStarted) return;
    this.roomsWarmStarted = true;
    void this.scene.warmInterior();
    this.prewarmZonePanel();
  };

  // Island shop (hat cosmetics, paid with meadow coins)
  private readonly hatCatalog: Array<{ id: HatId; icon: string; name: string; price: number }> = [
    // 5, not 8 (P2-A9): the arrival trail's 5 coins buy a first hat.
    { id: 'cap', icon: '🧢', name: 'Explorer Cap', price: 5 },
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

  /** Double-rAF paint yield for the boot narration: lets the loader's last
   *  showLoading(n) actually render before a long synchronous block. Races a
   *  100ms timeout because rAF NEVER fires in a hidden tab — a bare rAF
   *  await would stall boot indefinitely for a background-tab visitor. */
  private static paintYield(): Promise<void> {
    if (document.visibilityState !== 'visible') return Promise.resolve();
    return new Promise((resolve) => {
      const t = window.setTimeout(resolve, 100); // hidden-mid-yield safety
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          clearTimeout(t);
          resolve();
        }),
      );
    });
  }

  /** Post-first-paint scheduler: run `cb` in an idle slot, no later than
   *  `timeout` ms. Used to keep fire-and-forget work (Firebase subscriptions,
   *  music synthesis, profile sync) OFF the boot window — the Firebase chunk
   *  alone is ~270KB raw whose fetch+eval+anonymous-auth contended with the
   *  world-gen block and the postprocessing fetch. */
  private idleDefer(cb: () => void, timeout: number): void {
    if ('requestIdleCallback' in window) {
      (
        window as unknown as {
          requestIdleCallback: (c: () => void, o?: { timeout: number }) => void;
        }
      ).requestIdleCallback(cb, { timeout });
    } else {
      setTimeout(cb, timeout / 3);
    }
  }
  private timberSellArmedAt = 0;
  private freshBuildToasts = 0;
  private ownedAxe = false;
  private lessons: string[] = [];
  private vaultBusy = false;
  private static readonly LESSONS: Array<[string, string]> = [
    [
      'move',
      '🏃 Lesson 1 — WASD to walk, Space to jump, hold Shift to run. The island is round: keep walking and you come home.',
    ],
    [
      'fish',
      '🎣 Lesson 2 — buy the rod at the shop, stand at any shore, press E to cast. Reel when the float dips.',
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
      '💬 Lesson 5 — walk up to any villager and press E. Most of them will really talk with you.',
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
  /** P2-A6: when E went down during the fishing wait (-1 = not held). */
  private fishEarlyHoldAt = -1;
  /** P2-A6: holding E this long during the wait reels in early. */
  private static readonly FISH_EARLY_REEL_MS = 600;
  /** P2-A6: a vendor that just sold or sold to you ignores E until then (ms). */
  private readonly vendorLockUntil = new Map<string, number>();
  private static readonly VENDOR_LOCK_MS = 1000;
  /** P2-A6: the shop panel was open last frame (its close locks the kiosk). */
  private shopWasOpen = false;
  /** A11: when the touch stick reached the rim (-1 = not at the rim). */
  private stickRimSince = -1;
  private static readonly STICK_RUN_MAG = 0.95;
  private static readonly STICK_RUN_MS = 250;
  /** A11: ?legacyrun=1 keeps hold-Space (and hold-JUMP) running, for one release. */
  private static readonly LEGACY_RUN = ((): boolean => {
    try {
      return new URLSearchParams(location.search).get('legacyrun') === '1';
    } catch {
      return false;
    }
  })();
  private airborneTime: number = 0;
  private prevJumpHeld: boolean = false;
  private lastSwimWarnAt = 0; // throttle for the shoreline-barrier hint
  /**
   * In the water with a villager in reach (last frame's prompt chain): the
   * visitor stays afloat without Space, and the talk prompt outranks the
   * swim hint (w2 integration). The Sailor drifts 5 u off the jetty, so his
   * prompt showed only while Space was held: on a phone, JUMP held and USE
   * tapped at once, no thumb left to steer. The beach-house code is his line.
   */
  private talkAfloat = false;
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
  private readonly _audioPos = new THREE.Vector3(); // per-frame ambient sea-swell probe
  private readonly _qcCross = new THREE.Vector3();
  private readonly _qcTmp = new THREE.Vector3();
  private readonly _hintPos = new THREE.Vector3(); // talk-hint proximity probe

  private boundHandlers: {
    beforeUnload?: () => void;
    debugKeydown?: (event: KeyboardEvent) => void;
    chatKeydown?: (event: KeyboardEvent) => void;
    chatKeyup?: (event: KeyboardEvent) => void;
    mutePointerDown?: (event: PointerEvent) => void;
    mutePointerUp?: (event: PointerEvent) => void;
    popState?: () => void;
    guideTo?: (event: Event) => void;
    guideWelcomeClick?: (event: Event) => void;
    guideWelcomeKey?: (event: KeyboardEvent) => void;
    interiorEscape?: (event: KeyboardEvent) => void;
    guideModal?: (event: Event) => void;
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

      // Global shader-chunk patch, BEFORE any material compiles — the
      // program cache never rebuilds compiled ones: the ?look=soft fog
      // experiment for ?theme=real. (The cel shadow-edge patch is gone: it had
      // matched nothing since three r165 and warned on every load. CelLook.)
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
      // A name for the 3D view (axe: unlabelled canvas). The panels the
      // Portfolio menu opens carry the same work and contact details as text.
      canvas.setAttribute('role', 'img');
      canvas.setAttribute(
        'aria-label',
        "Life Island, Abbas Ali's portfolio as a live 3D world. The Portfolio menu has the same work and contact details as text.",
      );

      console.log('✓ Canvas created');

      // Remove legacy DOM overlays that conflict with the simplified UI stack
      this.disableLegacyUI();

      // Accessibility prefs (reduced motion) — seed before anything animates
      a11y.init();

      // A11: the run key, read at render time by the guide's copy and D8's
      // Controls sheet (and by the probes). Set before the first welcome or
      // guide render.
      document.documentElement.setAttribute(
        'data-run-key',
        SimpleApp.LEGACY_RUN ? 'space' : 'shift',
      );

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
      // Start the postprocessing-chunk fetch NOW so its round trip overlaps
      // the multi-second world-gen block below instead of following it
      // (initPostProcessing awaits the same cached promise). Tier-gated
      // inside — phones still never fetch the chunk.
      SimpleRenderer.preloadPostProcessing();
      // Multiplayer is its own chunk (wave-3 bundle carry-over): nothing needs
      // it before the world is built, so its fetch starts here and overlaps
      // world-gen; the await where it is constructed is then only a microtask.
      // A failed fetch resolves null: the island plays solo, chat stays off.
      const multiplayerModule = import('./Multiplayer').catch((e: unknown) => {
        console.warn('Multiplayer chunk failed to load; playing solo:', e);
        return null;
      });
      // Chat rides with Multiplayer (wave-4 bundle carry-over): no peers, no
      // chat, so it is its own chunk too. A failed fetch leaves chat off.
      const chatModule = import('./Chat').catch((e: unknown) => {
        console.warn('Chat chunk failed to load; chat stays off:', e);
        return null;
      });
      console.log('🎨 SimpleRenderer created:', {
        canvas: this.renderer.getCanvas(),
        renderer: this.renderer.getRenderer(),
        devicePixelRatio: this.renderer.getDevicePixelRatio(),
      });
      this.ui.showLoading(50);
      console.log('✓ Renderer created');
      // Let the 50% actually PAINT before the longest synchronous block —
      // without a yield the 10→95 narration collapses into one jump at the
      // first await. Guarded: rAF never fires in a hidden tab, so a bare
      // rAF await would stall boot for a background-tab visitor.
      await SimpleApp.paintYield();

      // Create scene (this will also create planet and player).
      // performance.mark bracketing: `world_gen_sync` is the long synchronous
      // constructor block (Island + all placement inline); `world_gen` is the
      // TRUE generation total through scene.ready() — the builder passes
      // after the constructor's first await used to be silently attributed
      // to scene_ready, steering tuning at the wrong phase. Inspect via
      // performance.getEntriesByType('measure') in the console.
      performance.mark('boot:worldgen-start');
      this.scene = new GameScene();
      performance.mark('boot:worldgen-sync');
      performance.measure('world_gen_sync', 'boot:worldgen-start', 'boot:worldgen-sync');
      // The interior window renders the island into a texture, so the scene
      // needs the WebGLRenderer. Structural handoff — no import either way.
      this.scene.setRendererRef(this.renderer);
      this.ui.showLoading(60);
      await SimpleApp.paintYield();
      await this.scene.ready();
      performance.mark('boot:scene-ready');
      performance.measure('world_gen', 'boot:worldgen-start', 'boot:scene-ready');
      performance.measure('scene_ready', 'boot:worldgen-start', 'boot:scene-ready');
      this.ui.showLoading(90);
      console.log('✓ Scene initialized and ready');
      // The villagers' seats as the world was built, before the first frame
      // walks anyone: the arrival trail was laid toward one of them, and the
      // pill points there while its coins are down (A7). npcTargets[].position
      // follows the villager from the first frame on.
      for (const t of this.scene.getIsland().npcTargets ?? []) {
        if (!this.npcSeats.has(t.name)) this.npcSeats.set(t.name, t.position.clone());
      }

      // Initialize delivery system
      this.deliverySystem = new DeliverySystem();
      this.ui.showLoading(95);
      console.log('✓ Delivery system initialized');

      // Assign the full quest chain across the mailboxes (round-robin) and
      // route mailbox interaction through the delivery system
      const mailboxes = this.scene.getMailboxes();
      // P2-A6: hand the chain to the mailboxes in a nearest-neighbour tour
      // from the hub (the Welcome pole), so consecutive parcels are
      // neighbours. Progress is keyed by delivery id, so saves survive.
      const hubR = mailboxes[0]?.mesh.position.length() ?? 0;
      const tour = nearestNeighbourTour(
        mailboxes.map((m) => m.mesh.position),
        new THREE.Vector3(0, hubR, 0),
      );
      this.deliverySystem.assignDestinations(tour.map((i) => mailboxes[i]));
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
        // P2-A9: a delivery pays +3 (the chain's halo still waits at the end).
        this.payCoins(SimpleApp.DELIVERY_PAY, 'Delivery');
        // The visitor chose the courier chain: from now on the pill may point
        // at parcels (after the districts, compassTarget's branch 7).
        this.deliveryOptIn = true;
        // P2-A6: name where the next parcel waits. The pack lines still
        // queued from the farm step aside for it (packToast).
        this.deliveryToastSeq += 1;
        const next = this.deliverySystem.getActiveDeliveries()[0]?.destination;
        const near = next ? this.districtNear(next.mesh.position) : null;
        if (near) {
          this.ui.toast(`📬 Delivered. The next parcel waits near ${this.districtLabel(near)}.`);
        }
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
      // P2-A10: the Gardener counts meadow pickups, not held coins, so a
      // shop purchase or a lesson's pay no longer moves the quest. Without
      // the scene's feed, the held-coins arithmetic as before.
      if (typeof this.scene.setOnMeadowCoin === 'function') {
        this.npcQuests.useMeadowCounter();
        this.scene.setOnMeadowCoin((e) => this.npcQuests.onMeadowCoin(e));
      }
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
        this.schoolEnrolled = localStorage.getItem('ds_school_enrolled') === '1';
        this.lessonActs = new Set(
          mergeLessons([], JSON.parse(localStorage.getItem('ds_lesson_acts') ?? '[]') as unknown),
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

      // Multiplayer: other visitors on the same island, waves included.
      // Loaded lazily (started beside preloadPostProcessing above).
      const mpMod = await multiplayerModule;
      const multiplayer = mpMod ? new mpMod.Multiplayer(this.scene, this.scene.getPlayer()) : null;
      this.multiplayer = multiplayer;
      multiplayer?.onCount((count) => this.ui.updatePlayerCount(count));
      multiplayer?.setHat((this.equippedHat as HatId) ?? null);

      // Proximity chat: text bubbles + push-to-talk voice between nearby
      // visitors. Wired to the mobile chat/mic HUD buttons and to
      // Enter/V(oice) on desktop (see setupDebugShortcuts-adjacent binding
      // below, near the input manager setup). No multiplayer, no chat.
      const chatMod = multiplayer ? await chatModule : null;
      this.chat = multiplayer && chatMod ? new chatMod.Chat(multiplayer) : undefined;
      // DOM twins live in the overlay so photo mode hides them for free.
      this.hudLabels = new HudLabels(this.ui.getOverlay());
      // Expandable island map: tap the radar (or press M) for the full map.
      this.ui.setOnMinimapClick(() => this.openIslandMap());
      this.ui.setOnOpenMap(() => this.openIslandMap());
      // One 'Show me' seam (P2-A5): any surface names a place by key and the
      // compass points there, exactly as an island-map pick does.
      this.boundHandlers.guideTo = (e: Event) => {
        const req = readGuideTo((e as CustomEvent).detail);
        if (req) this.guideTo(req.key, req.label, req.source);
      };
      window.addEventListener('ds:guide-to', this.boundHandlers.guideTo);
      this.ui.setVoiceSupported(this.chat?.voiceSupported ?? false);
      multiplayer?.setChatHandler((msg) => this.chat?.onWire(msg));
      this.ui.setOnChatSend((text) => this.chat?.sendText(text));
      this.ui.setOnMicDown(() => void this.chat?.startRecording());
      this.ui.setOnMicUp(() => this.chat?.stopRecording());
      // Show the "● Recording Xs" indicator only while the mic is truly live.
      this.chat?.setOnRecordingStart(() => this.ui.showRecordingIndicator());
      this.chat?.setOnRecordingStop(() => this.ui.hideRecordingIndicator());

      // Portfolio Passport: visiting all four work zones unlocks the Founder's
      // Golden Crown — the mechanic that routes explorers through the real work.
      this.passport = new Passport();
      // P2-A9: seed the paid-stamps record now, before any stamp of this
      // visit can land, so a fresh visitor's first stamp pays.
      this.payStamps();
      this.passport.setOnComplete(() => this.grantPassportReward());
      this.ui.setPassport(this.passport);
      // First steps (A6): the guide and its card, armed later by the welcome
      // card, the full tour or a CTA panel closing.
      this.setupGuide();

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
      this.scene.setOnNPCInteract((npcData) => this.onNpcInteract(npcData));
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
      // Deferred to an idle slot: this is the first Firebase touch, and the
      // chunk's fetch+eval+auth used to land inside the boot window. 1.5s max
      // keeps the world beat arriving during the fly-in (buildAwayDelta).
      this.idleDefer(
        () =>
          connectWorldState((s) => {
            this.ui.showWorldBulletin(s.headline, MOOD_META[s.mood].accent);
            track('world_beat_seen', { mood: s.mood });
            // Market day (world beat) lifts the special's premium 2 → 2.5.
            if (s.npcPlan?.event === 'market_day') this.refreshFeatured(true);
            // Hand the day's NPC assignments to the activity engine (Phase 2).
            if (s.npcPlan) this.scene.setNpcActivities(s.npcPlan);
            // Feed the "Island Times" board its notice + plan + past editions.
            // Cached lazily — the board reads it only when the visitor opens.
            this.ui.setIslandTimes(s.notice ?? null, s.npcPlan ?? null, s.noticeArchive ?? null);
          }),
        1500,
      );

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
              () =>
                this.hintLater(`📅 Day ${ledger.streak} in a row — the island kept a light on.`),
              6000,
            );
          }
        }
      } catch {
        /* no storage */
      }

      // Coin counter (persisted across visits + mirrored to the cloud profile)
      this.ui.updateCoinCounter(this.scene.getCoinsCollected());
      // Tap the coin HUD chip → the coin receipt (recent transactions).
      this.ui.onCoinChipClick = () => this.ui.showReceipt(this.scene.getTransactionLog());
      // Touch 💬 goes through the SAME lazy-naming gate as desktop's Enter —
      // without this, phones (whose only chat entry is that button) chatted
      // under the anonymous default name forever.
      this.ui.onChatOpenRequest = () => this.ensureNamed(() => this.ui.openChatInput());
      this.scene.setOnCoinCollected((total) => {
        this.ui.updateCoinCounter(total);
        this.refreshPackIfOpen(); // coins need NO keypress — walking into one counts
        saveProfile({ coins: total });
        if (total >= 100) trackOnce('coins_milestone', { n: 100 });
        else if (total >= 50) trackOnce('coins_milestone', { n: 50 });
        // One-time pointer at the earning guide, on the first coin collected
        // AFTER the welcome card. The spawn often sits on a trail coin, so it
        // was collected mid fly-in and the coin tip became the first text a
        // visitor read, ahead of the pitch and the compass hint. The key is
        // not burned until the tip can actually show.
        this.guide?.coin();
        // While the guide holds hints the tip waits for a later coin (A6).
        if (this.guideHoldsHints()) return;
        try {
          const welcomePending = !this.introSettled || this.ui.isWelcomeVisible();
          if (!welcomePending && !localStorage.getItem('ds_hint_earn')) {
            localStorage.setItem('ds_hint_earn', '1');
            this.ui.toast('🪙 Coins! The 📔 Journal (Portfolio menu) lists every way to earn.', {
              hint: true,
              until: this.journalSeenNow,
            });
          }
        } catch {
          /* no storage */
        }
      });

      // Arrival breadcrumb trail finished: the first-visit quick win lands.
      this.scene.setOnArrivalTrail(() => {
        this.markDone('ds_arrived');
        // Hand off to the NEXT thing, not a dead-end congratulation — the
        // old copy celebrated and left the visitor standing there. While
        // First steps runs, the guide owns the next step: the trail ends at
        // its talk villager, so a flash sending the visitor to Projects
        // landed on the look or talk card, or over the villager's chat. Else
        // a hint toast (D6 holds it behind panels), naming no place the pill
        // might not show.
        // With the guide skipped this visit, Skip's own hint has just said
        // what the gold ➤ does; the trail's end does not say it again.
        if (!this.guideHoldsHints()) {
          this.ui.toast(
            this.guideSkipHintShown
              ? '🏝️ You’ve got the hang of it.'
              : '🏝️ You’ve got the hang of it — the gold ➤ up top points to your next stop.',
            {
              hint: true,
            },
          );
        }
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
      this.scene.setOnRaceEvent((e) => this.onRaceEvent(e));
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
      // The recruiter tour now starts from a button INSIDE the hire card,
      // which may be open while the visitor stands in a building — where the
      // tour cannot run. Say so instead of leaving a dead button.
      this.ui.setOnRecruitTour(() => {
        this.startTour(true);
        if (!this.tour)
          this.ui.flashMessage('🎬 Step outside first — the tour flies over the island.');
      });
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

      // Create input manager. Look is press-and-drag; the pointer lock is an
      // opt-in setting (ds_mouse_lock) and never engages while a panel is
      // open, so it can never strand an open sheet or card under a captured
      // cursor.
      this.inputManager = new SimpleInputManager();
      this.inputManager.attachToCanvas(canvas);
      this.inputManager.setPointerLockGuard(() => !this.ui.panels.isOpen());
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
          // Enter belongs to whatever already used it. A focused button or
          // link activates itself on Enter, and this window listener ran as
          // well, so "See the work" opened Projects AND the name prompt,
          // and a second Enter published "Visitor". Chat opens only from the
          // bare world: nothing focused, no welcome card, no panel open
          // (keyGuards.ts, exercised in test/keyGuards.test.ts).
          if (!enterOpensChat(e, this.ui)) return;
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

      // Indoors, Escape leaves (P2-A1). Capture phase on window: it reads the
      // panels as they stood when the key went down, before PanelManager's
      // document listener closes the top one.
      this.boundHandlers.interiorEscape = (e: KeyboardEvent) => this.onInteriorEscape(e);
      window.addEventListener('keydown', this.boundHandlers.interiorEscape, true);

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
        // Compile the permutation the FIRST FRAME will actually use. Lights
        // are born visible and only get gated once update() runs — i.e. after
        // this — so without priming we compiled the night permutation and the
        // first daylight frame invalidated every lit program at once, mid
        // fly-in. See GameScene.primeExteriorLightGate.
        this.scene.primeExteriorLightGate();
        // ...and against the target the first frame draws into (w1-fix).
        // three keys every program on the bound render target (output colour
        // space, tone mapping): compiled against the canvas, the boot pass
        // built its 44 programs as TONE_MAPPING variants, and the first
        // composer frame linked about 47 more, synchronously. Desktop draws
        // the scene into the composer's buffer, and any non-XR target gives
        // the same keys, so a 1x1 stand-in binds them. The low tier has no
        // composer and draws to the canvas, so it compiles against that.
        const three = this.renderer.getRenderer();
        const sceneTarget = this.bootCompileTarget();
        let pending: Promise<unknown> | null = null;
        const bound = three.getRenderTarget();
        three.setRenderTarget(sceneTarget);
        try {
          // compileAsync compiles synchronously and then polls, so the
          // target only has to be bound for the call itself.
          if (typeof gl.compileAsync === 'function') {
            pending = gl.compileAsync(this.scene, this.scene.getCamera());
          } else {
            gl.compile(this.scene, this.scene.getCamera());
          }
        } finally {
          three.setRenderTarget(bound);
        }
        // Behind the loader no frame is drawn and compileAsync never flushes:
        // send the queued links now (C's hook asks too; one flush per task).
        Materials.flushAfterCompile(three);
        if (pending) await pending;
        console.log('✓ Shaders pre-compiled');
      } catch (e) {
        console.warn('Shader pre-compile skipped:', e);
      }

      // Shared benches + builds: rendered as they stream in — but SUBSCRIBED
      // from an idle slot, not the boot window (the second/third of the three
      // Firebase touches that defeated Multiplayer's deliberate deferral).
      // subscribedAt is stamped when the subscription actually starts, so the
      // 3s replay-burst guard and the away digest keep their semantics.
      this.idleDefer(() => {
        void subscribeBenches((b) => this.scene.renderWorldBench(b.plot));
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
              this.hintLater(`🔨 A visitor just raised a ${kindName} — it's on your map.`);
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
              this.hintLater(
                `🏘️ Visitors raised ${totalBuilds - seen} structure${totalBuilds - seen > 1 ? 's' : ''} while you were away.`,
              );
            }
            localStorage.setItem('ds_seen_builds', String(totalBuilds));
          } catch {
            /* no storage */
          }
        }, 3000);
      }, 1500);
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
        this.introSettled = true; // the welcome card (if any) opens below
        // The intro is over (A8): D holds its toasts and staggers the HUD in
        // on this. Exactly one settled per load, after exactly one start.
        window.dispatchEvent(new CustomEvent('ds:intro', { detail: { phase: 'settled' } }));
        // The governor starts measuring only NOW. The fly-in is the single
        // heaviest, least representative view in the game (whole planet in
        // frustum, intro-lite quality), and with the governor's clocks on true
        // wall time it could walk the rung ladder off those 2.5 atypical
        // seconds. Arming here — both branches funnel through afterIntro —
        // discards everything it saw during the intro and starts the decision
        // clocks from zero on the world it will actually govern. If this call
        // is somehow never reached, the governor self-arms after 10s of
        // visible wall time (see SimpleRenderer.armGovernor).
        this.renderer.armGovernor();
        // The trail villager is chosen once, here, so the pill names them from
        // behind the card on; phones end the intro facing them (A7), with the
        // coins that lead there on screen.
        this.visitStartedAt = performance.now(); // the visit's minutes ('ds:goals')
        this.chooseTrailVillager();
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
        // Phones warm the rooms while the card is up (CO-A5). The fly-in is
        // over, so the intro stays light; one task later, so the warm's
        // synchronous room build never joins the boot block (reduced motion
        // reaches here before the first frame).
        window.setTimeout(this.warmRoomsEarly, 0);
      };
      // Start the fly-in BEFORE the first frame renders: its first act is
      // placing the camera at the distant start, so no frame can ever show
      // the degenerate pre-placement view. The opaque loader then fades
      // out over the already-moving cinematic. Reduced-motion skips the
      // swoop entirely and drops straight into the settled follow view.
      if (a11y.reducedMotion) {
        // Reduced motion skips the swoop — but the camera STILL needs placing
        // in the follow pose. The non-reduced path does that via
        // flyInFromDistant (whose own reduced-motion guard just snapToPlayer()s
        // and resolves); this branch never called it, so the camera was left at
        // its distant pre-placement position. MEASURED: 243u from the player,
        // cameraSuspended=false — every reduced-motion visitor got a washed-out
        // distant planet that never came in, and it never self-corrected
        // (update() lerps distance toward distanceTarget, not the whole pose).
        // snapToPlayer is the exact init flyInFromDistant ends on.
        window.dispatchEvent(new CustomEvent('ds:intro', { detail: { phase: 'start' } }));
        this.scene.getOrbitCamera().snapToPlayer();
        afterIntro();
      } else if (this.calmEntry) {
        // CALM ENTRY (A10, decision 6): a phone skips the swoop. MEASURED on
        // the phone profile at 4x CPU (PERF-08): the fly-in drew 28 frames at
        // 7 fps and the welcome card came up at 14.6 s; with this entry, the
        // reduced-motion one, it came up at 9.8 s with 6 long tasks before it
        // instead of 35. Keyed on a coarse pointer that cannot hover, never on
        // isLowTierDevice(): that also catches 4-core laptops, which keep the
        // fly-in. The camera is seated in the follow pose and the world fades
        // in under the loader's own fade (startCalmEntryFade): opacity only.
        window.dispatchEvent(new CustomEvent('ds:intro', { detail: { phase: 'start' } }));
        canvas.style.opacity = '0';
        this.calmEntryCanvas = canvas;
        this.scene.getOrbitCamera().snapToPlayer();
        // Faced now, before the first frame: afterIntro's own call would
        // turn the camera in clear view once the world has faded in.
        this.chooseTrailVillager();
        // The card waits for the late GLBs' first draws (whenLateModelsLinked).
        this.whenLateModelsLinked(() => {
          afterIntro();
        });
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
        // DOMINANT fly-in cost is the scene render itself (whole planet in
        // frustum, nothing culls) — confirmed by the judder root-cause
        // investigation. Two more levers for the heavy first ~1.5s, both
        // imperceptible from ~280u and both restored mid-swoop under motion:
        //   • drop the effective resolution — sheds fragments across the whole
        //     heavy scene, not just the composer;
        //   • freeze the shadow pass — skips a full-scene 2048² depth render
        //     EVERY frame while contact shadows are invisible from orbit anyway.
        //     warmUp's renderer.compile() still warms the depth shader (compile
        //     is independent of the freeze), so the 1.5s unfreeze never hitches.
        this.renderer.setIntroResolution(0.7);
        this.renderer.setShadowFreeze(true);
        //   • hide the ink outlines — one shared MATERIAL flag (never
        //     Object3D.visible: coins and birds use that as game state, and
        //     input is live during the swoop). MEASURED at a fixed fly-in
        //     pose: 1,563 of the frame's 5,077 draws were ink hulls, lines a
        //     fraction of a pixel wide from that distance. No-op where no ink
        //     is built (low tier, ?theme=real).
        setInkVisible(false);
        // RESTORE MID-SWOOP, NOT ON ARRIVAL. Firing on the frame the camera
        // settles put the biggest visual discontinuity in the game at the exact
        // moment the player first looks at the island — read as the screen
        // "glitching". The brightness half of that is gone now, but grass
        // 0.3 -> 1.0 is still a whole-image change, so it keeps riding in under
        // the motion, 1.1s into a 2.5s flight. The heavy part of the swoop —
        // the whole planet in frustum — is the FIRST second, which still runs
        // lean, so the judder this was protecting is intact.
        //
        // Bonus, and the reason warmUp below finally does its job: warmUp
        // branches on postProcessingEnabled, and this function used to set it
        // false BEFORE warmUp ran. So the bloom/output programs were never
        // compiled behind the loader on this path — they compiled mid-swoop, at
        // the same 1500ms moment as the brightness step. Only reduced-motion
        // users (who skip this block) ever got a warmed composer.
        // GRASS and BLOOM want OPPOSITE restore timing.
        //   Grass 0.3 -> 1.0 is a whole-image change, so it rides in mid-swoop
        //   (1100ms) where the camera's own motion HIDES the pop.
        //   Bloom is the reverse: turning it on mid-swoop is the "world
        //   first-loading bloom flicker". Bloom is half-res, so on a fast-moving
        //   bright planet rim at intro-lite fps its halo lags the edge frame to
        //   frame — the exact ghosting this block disables bloom to avoid in the
        //   FIRST place. Re-enabling it at 1500ms of a 2500ms flight put it back
        //   on for ~1s of motion. So bloom waits for ARRIVAL, when the camera is
        //   still and there is nothing to ghost (the on-step itself is
        //   imperceptible — measured mean +0.24/255 at the settled view).
        // The four intro-lite levers come back STAGGERED, under camera motion
        // (A10, MOT-10): grass at 1.1 s, resolution and ink at 1.5 s, shadows
        // at 1.9 s, each in a timer of its own. All four in one task cost a
        // 123 ms frame 1.43 s into the flight, at the moment the view turned
        // fastest. By 1.1 s the camera is about 40 u up and still closing at
        // speed, so the whole-image changes hide in the motion and the frame
        // has lightened enough (closer camera, more culled) to afford full
        // quality for the final approach. Each is idempotent, so the arrival
        // .then calls all three again to cover a skipped/short flight.
        let inkBack = false;
        let shadowsBack = false;
        const restoreIntroGrass = (): void => this.scene.getIsland().setGrassBudget(1);
        const restoreIntroShadows = (): void => {
          shadowsBack = true;
          this.renderer.setShadowFreeze(false);
        };
        const restoreIntroQuality = (): void => {
          inkBack = true;
          this.renderer.setIntroResolution(null);
          setInkVisible(true);
        };
        // Every clock starts at the swoop's FIRST FRAME, like the fly-in's
        // own stall-immune clock. Started here, it ran out before any frame
        // drew: warmUp below compiles every program synchronously. MEASURED
        // (hardware GL, dev server): scheduled at 2253ms, render loop at
        // 4573ms, timer ran at 4574ms, first frame 4729ms; a production build
        // shows the same ~2.5s from world gen to the first frame. So all four
        // levers were restored before the visitor saw the swoop: the
        // intro-lite never engaged.
        requestAnimationFrame(() => window.setTimeout(restoreIntroGrass, 1100));
        requestAnimationFrame(() => window.setTimeout(restoreIntroQuality, 1500));
        requestAnimationFrame(() => window.setTimeout(restoreIntroShadows, 1900));
        // PRIME UNDER THE LOADER. Hidden ink and a frozen shadow pass are not
        // drawn in warmUp's hidden frame, so their programs linked when the
        // levers came back, in clear view. MEASURED on the staggered timers:
        // +2 programs and a 90 ms frame as the ink returned, +5 and 160 ms as
        // the shadow pass resumed (before the stagger: +7 in one 170-220 ms
        // frame). Two frames behind the loader draw them instead: one draws
        // the ink, the next runs the shadow pass, and each lever goes back on
        // the frame after. Two frames, not one: the fly-in clock forgives
        // 100 ms a frame, so two shorter stalls cost the flight less than one
        // long one. The shadow map also holds a real frame through the swoop
        // now, where it was empty until the unfreeze.
        //
        // It runs twice: on the swoop's first frame, and again as the loader
        // starts to fade (below, beside hideLoading). The avatar GLBs land
        // about half a second in, and their SKINNED ink and depth variants
        // cannot link before the meshes exist: after one priming, MEASURED
        // one program still linked at each restore (a 60-80 ms frame each).
        // A lever that is back for good is never touched again.
        const primeIntroLevers = (): void => {
          if (inkBack || shadowsBack) return;
          setInkVisible(true);
          requestAnimationFrame(() => {
            if (!inkBack) setInkVisible(false);
            if (shadowsBack) return;
            this.renderer.setShadowFreeze(false);
            requestAnimationFrame(() => {
              if (!shadowsBack) this.renderer.setShadowFreeze(true);
            });
          });
        };
        requestAnimationFrame(primeIntroLevers);
        this.primeIntroAgain = primeIntroLevers;
        window.dispatchEvent(new CustomEvent('ds:intro', { detail: { phase: 'start' } }));
        this.scene
          .getOrbitCamera()
          .flyInFromDistant(2500)
          .then(() => {
            // idempotent — covers a skipped/short flight
            restoreIntroGrass();
            restoreIntroQuality();
            restoreIntroShadows();
            // FADE bloom in, don't snap it. Enabling at arrival avoids the
            // rim-ghosting-during-motion, but a hard enable is a bloom POP right
            // as the reveal settles and the eye lands on the scene — read as a
            // flicker at the tail of the fly-in. A short ramp makes bloom arrive.
            this.renderer.fadeBloomIn(650);
            afterIntro();
          });
      }

      // Warm the post-processing + shadow shaders on a hidden frame (camera is
      // already at the distant fly-in start) so the first VISIBLE frame doesn't
      // hitch — a cause of the reveal flash.
      // warmUp's renderer.compile runs against whatever is bound, so bind the
      // boot compile's target for it too, or it re-links the 44 programs as
      // canvas variants, synchronously. Its composer.render binds its own
      // targets and puts this one back.
      {
        const three = this.renderer.getRenderer();
        const bound = three.getRenderTarget();
        three.setRenderTarget(this.bootCompileTarget());
        try {
          this.renderer.warmUp(this.scene, this.scene.getCamera());
        } finally {
          three.setRenderTarget(bound);
          this.disposeBootCompileTarget();
        }
      }

      // Start render loop
      this.startRenderLoop();
      console.log('✓ Render loop started');

      // Hold the loader a touch longer so a couple of clean frames render
      // before it fades over them (was 350ms — too eager, revealed mid-warmup).
      setTimeout(() => this.ui.hideLoading(), 500);
      // A calm entry (A10) brings the world up under that same fade.
      setTimeout(() => this.startCalmEntryFade(), 500);
      // The fly-in primes its two levers once more while the loader is still
      // all but opaque: the avatar GLBs are usually in by now.
      setTimeout(() => {
        this.primeIntroAgain?.();
        this.primeIntroAgain = null;
      }, 500);

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
      this.idleDefer(startMusic, 5000);
      this.idleDefer(syncProfile, 4000);
      // The room behind every door — 219 meshes plus 39 shader programs — is
      // otherwise built and compiled on the frame the player first presses E.
      // Warm it in idle time instead. Scheduled last: music and profile sync
      // both surface sooner. See GameScene.warmInterior for the measurements.
      // This stays the ceiling on every device; phones start sooner, at
      // afterIntro (warmRoomsEarly), and then the ceiling stands down.
      this.idleDefer(this.warmRoomsIdle, 9000);
      // (Vercel Analytics inject() moved to module top — pre-boot pageviews.)

      // Browsers create AudioContexts suspended until a user gesture; nothing
      // resumed it before, so music (and now SFX) stayed silent. Resume on the
      // first key/click AFTER the audio system exists, unless the user muted.
      //
      // STAY ARMED UNTIL THERE IS SOMETHING TO UNLOCK. This used to detach
      // both listeners FIRST and look for window.audioManager second — but the
      // manager is created ~5s later (idle(startMusic, 5000) + a dynamic
      // import), so any tap or keypress during the load window burned the
      // one-shot on nothing. The context was then created 'suspended' outside
      // any gesture: Chrome self-heals via sticky activation, Safari/iOS do
      // NOT — the whole session stayed silent (music, sfx, voice) while the
      // HUD showed 🔊, and the only rescue was toggling mute on and off.
      const resumeAudio = () => {
        try {
          const am = (
            window as unknown as {
              audioManager?: { ensureCtx(): AudioContext; isMuted(): boolean };
            }
          ).audioManager;
          if (!am) return; // not booted yet — keep the listeners armed
          window.removeEventListener('keydown', resumeAudio);
          window.removeEventListener('pointerdown', resumeAudio);
          // ensureCtx() INSIDE the gesture handler: if the context does not
          // exist yet this creates it mid-gesture, which WebKit treats as
          // unlocked from birth. When muted, do nothing — mute's deliberate
          // suspend stands, and unmute resumes in its own click gesture.
          // (AudioManager also keeps its own lightweight always-on fallback
          // for OS interruptions later in the session; this listener only
          // covers the boot window.)
          if (!am.isMuted()) void am.ensureCtx().resume();
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
    // The crown's card reads the latest 'ds:goals' (P2-D10): send it the
    // ladder as it stands with this stamp, before the card opens.
    this.syncGoals(this.goalsWereOn);
    this.publishGoals();
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
        this.dropUrlParam('hour');
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
          // Pinches banked while the orbit camera was suspended (look is
          // drained by the free-roam branch; pinch only drains inside
          // OrbitCamera.update, which suspension skips) — discard before
          // resuming or they land as one distance jump.
          consumePinchZoomFactor();
          this.scene.setCameraSuspended(false);
          this.scene.snapCameraToPlayer();
        });
        if (env) env.debugHour = null;
        this.dropUrlParam('pc');
      });
      return true;
    } catch {
      return false;
    }
  }

  /** Params a pill has handed back this page life: ?hour= and ?pc=. */
  private readonly droppedUrlParams = new Set<string>();

  /**
   * A pill gave its moment back (the ?hour= clock, the ?pc= postcard view):
   * take its param out of the address bar for the rest of the page's life.
   * The entry keeps its state. An open panel's entry carries PanelManager's
   * {dsPanel, dsTok} (D2), and the null written here before left the panel
   * unable to step back off its entry when it closed: the first Back then
   * stayed on the island and put ?hour= back. The entry below a panel's own
   * still carries the param, and the step back a closing panel takes (or a
   * Back) lands there, so every popstate drops these params again.
   */
  private dropUrlParam(name: string): void {
    this.droppedUrlParams.add(name);
    if (!this.boundHandlers.popState) {
      this.boundHandlers.popState = () => this.stripDroppedUrlParams();
      window.addEventListener('popstate', this.boundHandlers.popState);
    }
    this.stripDroppedUrlParams();
  }

  /** Take every dropped param out of the current entry's URL, state untouched. */
  private stripDroppedUrlParams(): void {
    try {
      const sp = new URLSearchParams(location.search);
      let changed = false;
      for (const name of this.droppedUrlParams) {
        if (!sp.has(name)) continue;
        sp.delete(name);
        changed = true;
      }
      if (!changed) return;
      const q = sp.toString();
      history.replaceState(history.state, '', `${location.pathname}${q ? `?${q}` : ''}`);
    } catch {
      /* ignore */
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
    this.scene.floatCoinsAtPlayer(25);
    this.scene.logTransaction('Courier finale', 25);
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
    professional: ['Abbas Ali\nAI & software\nengineer', 'Next.js · TS\nThree.js\nFirebase'],
    projects: ['RankPilot\nAI-SEO app\n(pre-launch)', 'Bano’s\nInsta Services\nChocoMate'],
    personal: ['Kitchens · Family\nCreative\ntooling', 'Melbourne,\nVictoria'],
    contact: ['Hiring, or\na project?', 'admin@\ndigiscalability\n.com'],
  };

  /** The contact email the Contact hall shows and copies (Fact Sheet). */
  private static readonly OWNER_EMAIL = 'admin@digiscalability.com';
  /**
   * What each hall shows (P2-A11), handed to B's enterInterior as its
   * exhibits (P2-B12). Written from the Public Fact Sheet and the panels'
   * copy: no 'agent', no typed counts, Bano's Cookbook is Ammi's recipes,
   * and DigiScalability is one person. Body text is 48 canvas px (B's
   * EXHIBIT_FONT), so a side poster holds about four short lines. A chip
   * with an id on the Projects posters becomes a pegboard spot that opens
   * that card (at most four). INTERIOR_CONTENT stays as the fallback.
   */
  private static readonly INTERIOR_EXHIBITS: Record<string, Exhibits> = {
    welcome: {
      left: { lines: ['The Hub', 'Every avenue starts here'] },
      right: { lines: ['The wall map:', 'press E to set the compass'] },
    },
    professional: {
      left: { lines: ['Now: founder & lead developer, DigiScalability', 'since Jan 2025'] },
      right: {
        lines: ['The stack'],
        chips: [
          { label: 'TypeScript' },
          { label: 'Three.js' },
          { label: 'Firebase' },
          { label: 'Next.js' },
        ],
      },
      screen: { lines: ['CV · LinkedIn · GitHub — press E'] },
    },
    projects: {
      left: {
        lines: ['Press E at a card'],
        chips: [
          { label: 'RankPilot · pre-launch', id: 'rankpilot' },
          { label: 'ChocoMate · paused', id: 'chocomate' },
        ],
      },
      right: {
        lines: ['Press E at a card'],
        chips: [
          { label: 'Bano’s Cookbook', id: 'banos' },
          { label: 'Insta Services API', id: 'insta' },
          { label: 'digiscalability.com' },
        ],
      },
      screen: { lines: ['This island — open source (MIT)'] },
    },
    personal: {
      left: { lines: ['Melbourne kitchens', '2017–2024, then back to code'] },
      right: { lines: ['Bano’s Cookbook:', 'Ammi’s handwritten recipes from 1981'] },
    },
    contact: {
      left: { lines: ['Hiring?', 'Press E at the counter for CV & contact'] },
      right: { lines: ['Email'], chips: [{ label: SimpleApp.OWNER_EMAIL }] },
    },
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
  private runInteriorAction(hs: { action: string; text?: string; arg?: string }): void {
    // P2-A11: the hotspot's arg (P2-B12) decides when it names one.
    if (hs.arg && this.runExhibitArg(hs.arg)) return;
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

  /**
   * An exhibit's action by its arg (P2-A11). Returns false for an arg this
   * build does not know, so the hotspot's own action runs.
   * - 'hire': the hire card, tracked as hire_cta {cta: 'interior'};
   * - 'project' or 'project:<id>': Projects, at that card when named;
   * - 'copy:email': the email to the clipboard, 'Copied' in the flash;
   *   blocked, the Contact panel at its form;
   * - 'compass': the compass to the nearest unstamped district (Projects
   *   once all are stamped), through 'ds:guide-to';
   * - 'times': the Island Times, as before.
   */
  private runExhibitArg(arg: string): boolean {
    if (arg === 'hire') {
      this.ui.showHireCard('cta');
      track('hire_cta', { cta: 'interior' });
      return true;
    }
    if (arg === 'project' || arg.startsWith('project:')) {
      const anchor = arg.startsWith('project:') ? arg.slice('project:'.length) : '';
      this.ui.showZonePanel(
        { id: 'projects', name: 'projects' },
        anchor ? { source: 'landmark', anchor } : { source: 'landmark' },
      );
      return true;
    }
    if (arg === 'copy:email') {
      const email = SimpleApp.OWNER_EMAIL;
      const blocked = (): void =>
        this.ui.showZonePanel(
          { id: 'contact', name: 'contact' },
          { source: 'landmark', anchor: 'lead-form-block' },
        );
      const clip = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
      if (!clip?.writeText) {
        blocked();
        return true;
      }
      clip.writeText(email).then(
        () => this.ui.flashMessage(`✉️ Copied — ${email}`),
        () => blocked(),
      );
      return true;
    }
    if (arg === 'compass') {
      const from = this.insideZone ? this.zonePos(this.insideZone.id) : null;
      const passport = this.passport;
      let best = 'projects';
      let bestD = Infinity;
      if (from && passport) {
        for (const z of this.zoneList ?? []) {
          if (!passport.isStampZone(z.id) || passport.has(z.id)) continue;
          const d = from.distanceToSquared(z.pos);
          if (d < bestD) {
            bestD = d;
            best = z.id;
          }
        }
      }
      window.dispatchEvent(
        new CustomEvent('ds:guide-to', { detail: { key: `district:${best}`, source: 'interior' } }),
      );
      return true;
    }
    if (arg === 'times') {
      void this.ui.showIslandTimes();
      return true;
    }
    return false;
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
      // P2-A11: a hall gets its exhibits (houseId undefined for halls).
      const exhibits = isZone ? SimpleApp.INTERIOR_EXHIBITS[id] : undefined;
      this.scene.enterInterior(title, wall, left, right, theme, isZone ? undefined : id, exhibits);
      // No carry-over (INT-12): a key pressed on the doorstep, in the gap
      // between the last outdoor frame and this swap, never fires in the room.
      this.inputManager.clearLatched();
      // Leave FIRST, and the panel in its own try. The fourth passport stamp
      // lands inside showZonePanel and its celebration used to sweep the hall
      // panel mid-build, so the panel threw (INT-02); fadeThrough's catch
      // swallowed it and this line never ran. The visitor stood in the room
      // with no Leave and no panel. Whatever a panel does, the way out exists.
      // P2-D2's optional title: 'Leave <room>'.
      this.ui.showLeaveButton(() => this.exitBuilding(isZone), title);
      if (isZone && zone) {
        try {
          this.ui.showZonePanel({ id: zone.id, name: zone.name }, { source: 'proximity' });
        } catch (e) {
          console.warn('Zone panel failed inside the building:', e);
        }
      }
    });
  }

  /** The door veil is already closing on the way out: a second Leave, E at
   *  the door or Escape must not start another. */
  private leavingBuilding = false;

  private exitBuilding(isZone: boolean): void {
    if (this.leavingBuilding) return;
    this.leavingBuilding = true;
    this.ui.closeWatchFrame(); // stop any wall-screen playback (fires onClose)
    this.ui.fadeThrough(() => {
      this.leavingBuilding = false;
      this.scene.exitInterior();
      // No carry-over (INT-12): Q pressed in the room, in the gap before
      // this swap, used to wave on the first frame outside.
      this.inputManager.clearLatched();
      this.ui.hideLeaveButton();
      if (isZone) this.ui.hideZonePanel();
    });
  }

  /**
   * Indoors, Escape leaves (P2-A1). Heard on window in the capture phase, so
   * it reads the room as it stood when the key went down: PanelManager and
   * SimpleInputManager listen on the document, which runs later. With a panel
   * open (the hall panel, the emote wheel, the chat line) or the name prompt
   * up, the press is theirs: the panel closes and the visitor stays inside.
   * With the wall screen on, it steps away from the screen. Only a press that
   * finds nothing open leaves, so one Escape never does both, whatever order
   * the document listeners run in.
   */
  private onInteriorEscape(e: KeyboardEvent): void {
    if (e.key !== 'Escape' || e.repeat || e.defaultPrevented) return;
    if (!this.scene?.isInsideInterior()) return;
    if (this.ui.panels.isOpen() || this.ui.isWelcomeVisible()) return;
    if (this.ui.isWatchOpen()) {
      this.ui.closeWatchFrame();
      return;
    }
    this.exitBuilding(this.insideIsZone);
  }

  /** Open a section directly from a /?zone=<id> deep link, if present + valid. */
  /** Open a ?zone= deep link. Returns true when a panel was opened (the
   *  caller then skips the welcome modal — shared content comes first). */
  private openDeepLinkZone(): boolean {
    try {
      const z = new URLSearchParams(location.search).get('zone');
      if (!z) return false;
      // 'hire' is the recruiter card (SimpleUI.showHireCard), not a district;
      // api/z.js serves its /z/hire share route.
      if (['welcome', 'professional', 'projects', 'personal', 'contact', 'hire'].includes(z)) {
        this.ui.hideWelcome();
        // A /z/hire visitor has seen no welcome card: the route that follows
        // the hire card opens with where they are (P2-A4).
        if (z === 'hire') this.hireCardSource = 'deeplink';
        this.ui.showZonePanel({ id: z, name: z }, { source: 'deeplink' });
        return true;
      }
    } catch {
      /* ignore */
    }
    return false;
  }

  /**
   * Vehicle time-trials: the banner on start, checkpoint and finish. A finish
   * pays out, answers a ?race=&beat= challenge, and goes to the board under
   * the visitor's name (P2-A7).
   */
  private onRaceEvent(e: RaceEvent): void {
    // P2-A8 quiet laps: hints wait from 'Go!' to the finish or the abort.
    if (e.kind === 'start') this.racing = true;
    else if (e.kind === 'finish' || e.kind === 'abort') this.racing = false;
    if (e.kind === 'finish') {
      sfx.questComplete();
      // Racing paid NOTHING before — the most complete loop in the game had
      // no reward. Every finish now pays out (bigger on a PB).
      const reward = e.improved ? 15 : 5;
      this.scene.addCoins(reward);
      this.scene.floatCoinsAtPlayer(reward);
      this.scene.logTransaction(e.improved ? 'Race — new best!' : 'Race finish', reward);
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
      if (e.circuit) {
        const circuit = e.circuit;
        const timeSec = typeof e.timeSec === 'number' ? e.timeSec : null;
        // The board shows a name, so the first finish asks for one (decision
        // P2-8): once a session, and Skip goes up as 'Guest'. Times used to go
        // up under the placeholder minted for the name tag ('Sunny Courier').
        this.ensureNamed(() => {
          const name = this.boardName();
          // EVERY finish is sent, not only a local best: Boards keeps the
          // better time itself, and a best set while the write failed (or
          // before the visitor had a name) never reached the board otherwise.
          if (timeSec !== null) this.submitRaceTime(circuit, timeSec, name);
          // Surface the (otherwise buried) global leaderboard a beat after
          // the finish, with a Share button — turns every PB into a share
          // prompt.
          const tMs = timeSec !== null ? Math.round(timeSec * 1000) : null;
          window.setTimeout(() => void this.ui.showRaceLeaderboard(circuit, tMs, name), 1200);
        });
      }
      return;
    }
    this.ui.flashMessage(e.text);
    if (e.kind === 'start') {
      sfx.raceGo();
      this.raceGuideTarget = null; // the guide CTA is fulfilled
      this.raceGuideViaCar = false;
      track('race_start', { circuit: e.circuit ?? 'unknown' });
    } else if (e.kind === 'checkpoint') sfx.checkpoint();
  }

  /** The name a race time goes up under: the one the visitor chose, else
   *  'Guest'. Never the placeholder minted for the name tag. */
  private boardName(): string {
    let saved: string | null = null;
    try {
      saved = localStorage.getItem('ds_player_name');
    } catch {
      /* no storage: a name typed this session still counts */
    }
    if (!saved && !this.nameTyped) return 'Guest';
    return this.multiplayer?.selfName ?? saved ?? 'Guest';
  }

  /** Boards loads lazily (Firebase stays off the boot path), and the write
   *  is fire-and-forget: Boards.submitRaceTime never throws. */
  private submitRaceTime(circuit: 'land' | 'water', timeSec: number, name: string): void {
    void import('./Boards').then((b) => b.submitRaceTime(circuit, timeSec, name));
  }

  /** "Skip — just browsing" is remembered for the session (instance flag +
   *  sessionStorage, so a reload in the same tab keeps it). */
  private nameSkipped = false;
  /** The visitor typed a name at the prompt this session (storage may not keep it). */
  private nameTyped = false;
  private static readonly NAME_SKIP_KEY = 'ds_name_skipped';

  /**
   * Lazy naming: run `then` once the visitor has a name, prompting only the
   * first time a social feature (race leaderboard, chat) actually needs one.
   * An empty name from the prompt (skip) proceeds anonymously without saving,
   * and the skip is REMEMBERED for the session: asking again on every chat
   * open re-gated the visitor who had already said no.
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
    let skipped = this.nameSkipped;
    try {
      skipped ||= sessionStorage.getItem(SimpleApp.NAME_SKIP_KEY) === '1';
    } catch {
      /* no session storage — the instance flag still holds for this page */
    }
    if (skipped) {
      then();
      return;
    }
    this.ui.promptName('', (name) => {
      if (name) {
        this.nameTyped = true;
        this.multiplayer?.setName(name);
        saveProfile({ name });
      } else {
        this.nameSkipped = true;
        try {
          sessionStorage.setItem(SimpleApp.NAME_SKIP_KEY, '1');
        } catch {
          /* no session storage */
        }
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
      }
      // C (appearance editor) and P (photo) used to live here, on a raw
      // document listener: Ctrl+C on the contact card opened the editor over
      // it, and both fired behind any open panel. They are latched verbs in
      // update() now, beside Q, F, G and M.
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
    // Re-set by the free-walk branch only while a district's door prompt shows.
    this.doorPromptZone = null;
    this.guideMoveMag = 0; // free walk sets it below

    // Juice kernel: advance all micro-tweens (hat pops, squash-stretch,
    // pickup ceremonies). Here, not GameScene.update — this always runs
    // (interior mode early-returns would freeze a mid-pop tween).
    juiceTick(deltaTime);

    // Completion meter: recompute on a slow cadence (plus immediately at each
    // flag site) so passport stamps landed elsewhere still surface here.
    // The secret-spot proximity sweep rides the same 2.5s cadence — nine
    // distance checks against static points, effectively free.
    // Wall time spent actually IN the world (welcome dismissed) — feeds the
    // lost-visitor recovery hint below. A room is not the world: nobody is
    // lost in one, so the clock stops at the door (P2-A1, INT-11).
    const indoors = this.scene.isInsideInterior();
    if (!this.ui.isWelcomeVisible() && !indoors) this.lostAccum += deltaTime;
    this.completionAccum += deltaTime;
    if (this.completionAccum > 2.5) {
      this.completionAccum = 0;
      this.refreshCompletion();
      this.sweepSecrets();
      // main-simple's own hints held while the guide ran (A6) go out now;
      // indoors they wait for the door (hintLater holds them there too).
      if (this.heldHints.length && !indoors && !this.guideHoldsHints()) {
        for (const m of this.heldHints.splice(0)) this.ui.toast(m, { hint: true });
      }
      const hintsHeld = this.guideHoldsHints();
      // DISTRICT-ENTRY CARDS: one toast, once ever per district, at the
      // boundary (dot > 0.90 = inside the accent tint, same threshold the
      // terrain colouring uses). The crossing was silent — the ground tint
      // was the only signal a visitor had entered anywhere. Five once-ever
      // keys cap this at five toasts, lifetime.
      try {
        // hasTrailCoins guard: minute one's toast budget belongs to the
        // orientation + talk hints — district cards start after the arrival
        // trail is done. Never indoors (P2-A1): the avatar stands frozen at
        // the door outside, so every outdoor hint below read that spot and
        // fired over the room ('a villager nearby…', a district's card).
        if (
          !indoors &&
          !hintsHeld &&
          !this.ui.isWelcomeVisible() &&
          !this.tour &&
          !this.scene.hasTrailCoins()
        ) {
          const p = this.scene.getPlayer()?.getWorldPosition();
          if (p) {
            const len = p.length() || 1;
            let bestDot = -Infinity;
            let bestId = '';
            for (const d of DISTRICTS) {
              const cl = Math.cos(d.lat ?? Math.PI / 2);
              const dx = Math.cos(d.lon) * cl;
              const dy = Math.sin(d.lat ?? Math.PI / 2);
              const dz = Math.sin(d.lon) * cl;
              const dot = (p.x * dx + p.y * dy + p.z * dz) / len;
              if (dot > bestDot) {
                bestDot = dot;
                bestId = d.id;
              }
            }
            const DISTRICT_INTRO: Record<string, string> = {
              welcome: '🏝️ The Hub — the town square. Every avenue starts here.',
              professional: '💼 Professional — what I do, my experience, and how to work with me.',
              projects: '🚀 Projects — the shipped work. Walk up to a building to open it.',
              personal: '🎨 Personal — the human behind the code.',
              contact: '📬 Contact — message me, or talk to my AI receptionist.',
            };
            const key = `ds_hint_district_${bestId}`;
            if (bestDot > 0.9 && DISTRICT_INTRO[bestId] && !localStorage.getItem(key)) {
              localStorage.setItem(key, '1');
              this.ui.toast(DISTRICT_INTRO[bestId], { hint: true, until: this.indoorsNow });
            }
          }
        }
      } catch {
        /* no storage */
      }
      // LOST-VISITOR RECOVERY: a full minute in the world with zero proximity
      // prompts ever shown and zero passport stamps means they walked the
      // wrong way off spawn and have been in silence since. Strict conditions
      // — an engaged player has seen dozens of prompts — so this fires for
      // exactly the visitor who needs it, once ever.
      try {
        if (
          this.lostAccum > 60 &&
          !indoors &&
          !hintsHeld &&
          !this.tour &&
          !localStorage.getItem('ds_hint_map') &&
          !this.ui.hasSeenInteractionPrompt() &&
          (this.passport?.count() ?? 0) === 0
        ) {
          localStorage.setItem('ds_hint_map', '1');
          this.showLostHint();
        }
      } catch {
        /* no storage */
      }
      // ...and the stall trigger beside it (A8): no stamp yet and under 10 u
      // travelled in the last 30 s of free roam, at most twice a visit; a
      // panel, the guide, a tour or a room restarts the window. The once-ever
      // clause above needs a minute with no prompt at all; an idle visitor
      // heard nothing for 54-59 s.
      this.checkLostStall(hintsHeld);
      // One-time "a villager nearby talks through Claude Haiku 4.5" discovery
      // hint, fired while APPROACHING (4x the E-prompt range, derived not
      // hand-written) — the product's differentiator otherwise only announces
      // itself inside 2.5u. Only an AI villager sets it off: near one of the 4
      // scripted ones (the market vendors, the first mate, the deckhand) the line
      // would be untrue. The key is also set where NPC chat opens, so a visitor
      // who found the feature themselves never gets taught what they already know.
      try {
        if (
          !localStorage.getItem('ds_hint_talk') &&
          !indoors &&
          !hintsHeld &&
          !this.ui.isWelcomeVisible() &&
          !this.tour &&
          this.aiVillagerWithin(4 * this.scene.getInteractionRange())
        ) {
          localStorage.setItem('ds_hint_talk', '1');
          this.ui.toast(
            this.ui.isTouchDevice()
              ? '💬 A villager nearby talks through Claude Haiku 4.5 — walk up and tap USE to ask anything.'
              : '💬 A villager nearby talks through Claude Haiku 4.5 — walk up and press E to ask anything.',
            { hint: true, until: this.talkHintStaleOrChatted },
          );
        }
      } catch {
        /* no storage */
      }
    }

    // Any open panel needs the cursor: let go of the opt-in pointer lock.
    if (this.ui.panels.isOpen()) this.inputManager.releasePointerLock();
    // P2-A10: the coin hint points at the Journal; once it has been open the
    // hint is stale. Read here, not from 'ds:modal', which does not fire for
    // a journal opened over another modal.
    if (!this.journalSeen && this.ui.panels.isOpen('journal')) this.journalSeen = true;
    // P2-A14: Customise closed: the follow pose comes back.
    if (this.customizeMirror && !this.ui['customizeDiv']) {
      this.customizeMirror = false;
      this.scene.getOrbitCamera().setMirrorPose(false);
    }
    // P2-A6: the kiosk's 1.0 s lock runs from the shop panel's close, and a
    // finished cast forgets an E held during its wait.
    const shopOpen = this.ui.panels.isOpen('shop');
    if (this.shopWasOpen && !shopOpen) this.lockVendor('kiosk');
    this.shopWasOpen = shopOpen;
    if (this.fishEarlyHoldAt >= 0 && !this.scene.isFishingActive()) this.fishEarlyHoldAt = -1;

    // Only process input once the loader and welcome screen are gone
    if (!this.ui.isWelcomeVisible() && !this.ui.isLoadingVisible()) {
      // In-person dialogue upkeep: release the hold when every conversation
      // panel is gone (covers the canned panel, which has no close callback),
      // and drive the push-in/release camera rail while it owns the camera.
      if (this.npcDialogueName && !this.ui.isNpcChatOpen() && !this.ui.isDialogueActive()) {
        this.endNpcDialogue();
      }
      if (this.npcCine) this.updateNpcCine(deltaTime);
      // C closes the appearance editor while it is on top, whatever the
      // avatar is doing (in free walk the verb below also opens it).
      if (
        !this.tour &&
        this.ui.panels.current() === 'customize' &&
        this.inputManager.consumeKeyPress('c')
      ) {
        this.ui.hideCustomize();
      }
      // Cinematic tour: the rail owns the camera and the player stands still.
      // Everything else in the world keeps running (that's the point of it).
      if (this.tour) {
        this.scene.setPlayerMovement(0, 0);
        this.ui.hideInteractionPrompt();
        // Swipes/pinches on the canvas bank into touchDelta/pinchState while
        // the rail owns the camera, then fire as ONE whip on exit — drain and
        // discard every frame (same failure mode the npcCine drain names).
        this.inputManager.getCameraInput();
        consumePinchZoomFactor();
        // Presses during the tour are for the tour: none fires after it.
        this.inputManager.clearLatched();
        this.updateTour(deltaTime);
      } else if (worldInputBlocked(this.ui.panels.current())) {
        // A panel that is not walkable (Projects, the Portfolio menu, the
        // shop, the map…) owns the keyboard: W or ↓ held behind it used to
        // walk the avatar while it scrolled, and E seated it on the bench
        // beside it. keyGuards.ts lists the walkable sheets.
        this.holdWorldInput();
        this.ui.hideInteractionPrompt();
      } else if (this.scene.isInsideInterior()) {
        // Interiors never feed the orbit camera either — same banking, same
        // whip on stepping out the door. Drain both interior branches; the
        // walk branch hands the yaw to the room camera (P2-A11).
        const roomLook = this.inputManager.getCameraInput();
        consumePinchZoomFactor();
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
          // Looking around (P2-A11): a drag or J/L turns the room camera.
          // As outdoors, + turns right (OrbitCamera.keyLook, 90°/s); the
          // room's yaw grows to the left, hence the sign. Pinch and wheel
          // stay drained.
          const keyTurn =
            (this.inputManager.isKeyPressed('l') ? 1 : 0) -
            (this.inputManager.isKeyPressed('j') ? 1 : 0);
          const turn = roomLook.deltaX + keyTurn * (Math.PI / 2) * Math.min(deltaTime, 0.1);
          if (turn !== 0) this.scene.setInteriorLook?.(-turn);
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
        this.dropUnusedPresses();
      } else if (this.ui.isDialogueActive() || this.ui.isNpcChatOpen()) {
        // A conversation is open (canned panel or AI chat): you're standing
        // WITH someone — movement is suppressed, the villager is held, and
        // the camera two-shot completes the in-person framing.
        this.scene.setPlayerMovement(0, 0);
        this.ui.hideInteractionPrompt();
        this.applyLook(deltaTime);
        // Talking from the water (the Sailor's boat): afloat for the whole
        // conversation, never held on Space while typing (talkAfloat).
        const talker = this.scene.getPlayer();
        if (talker?.isInWater()) talker.setSwimIntent(true);

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
        this.dropUnusedPresses();
      } else if (this.scene.isPlayerSeated()) {
        // Seated on a bench: movement suppressed, E stands back up
        this.scene.setPlayerMovement(0, 0);
        this.ui.showInteractionPrompt('🪑 Press <strong>E</strong> to stand up');
        this.applyLook(deltaTime);
        if (this.inputManager.consumeKeyPress('e')) {
          this.scene.standUpFromBench();
          this.ui.hideInteractionPrompt();
        }
        this.dropUnusedPresses();
      } else if (this.scene.isRidingVehicle()) {
        // Driving a boat/jetski: WASD/joystick steers the craft; E hops off
        const moveInput = this.inputManager.getMovementInput();
        const joy = this.ui.getJoystick();
        const vFwd = Math.max(-1, Math.min(1, moveInput.forward + joy.forward));
        const vStrafe = Math.max(-1, Math.min(1, moveInput.strafe + joy.strafe));
        this.scene.setVehicleMove(vFwd, vStrafe);
        this.scene.getOrbitCamera().setMoveInput(vFwd, vStrafe);
        this.currentThrottle = Math.max(Math.abs(vFwd), Math.abs(vStrafe) * 0.5);
        this.applyLook(deltaTime);
        // P2-A6: the glyph of the vehicle being ridden, as the board prompt.
        const rideKind = this.scene.getActiveVehicleKind();
        const rideIcon = rideKind === 'jetski' ? '🌊' : rideKind === 'car' ? '🚗' : '⛵';
        this.ui.showInteractionPrompt(`${rideIcon} Press <strong>E</strong> to hop off`);
        this.maybeHint(
          'ride',
          'Steer with [W] [A] [S] [D]; press [E] to hop off.',
          'Steer with the stick; tap USE to hop off.',
        );
        if (this.inputManager.consumeKeyPress('e')) {
          this.scene.disembarkVehicle();
          this.ui.hideInteractionPrompt();
        }
        this.dropUnusedPresses();
        this.ui.updateBreath(1, false);
        this.ui.setUnderwater(this.scene.getSubmergedFactor());
      } else {
        // Get input
        const moveInput = this.inputManager.getMovementInput();
        const jumpInput = this.inputManager.getJumpInput();

        // Apply player input (keyboard merged with the touch joystick)
        const joy = this.ui.getJoystick();
        const walkForward = Math.max(-1, Math.min(1, moveInput.forward + joy.forward));
        const walkStrafe = Math.max(-1, Math.min(1, moveInput.strafe + joy.strafe));
        this.guideMoveMag = Math.hypot(walkForward, walkStrafe);
        // CO-A5: a phone's first steps after the fly-in start the room warm
        // too, if afterIntro has not already.
        if (
          !this.roomsWarmStarted &&
          (walkForward !== 0 || walkStrafe !== 0) &&
          !this.scene.getOrbitCamera().isFlyingIn()
        ) {
          this.warmRoomsEarly();
        }
        this.scene.setPlayerMovement(walkForward, walkStrafe);
        // The chase camera reads the input direction too: it holds its follow
        // when the direction swings, and under reduced motion recentres once
        // the visitor stands still.
        this.scene.getOrbitCamera().setMoveInput(walkForward, walkStrafe);
        const player = this.scene.getPlayer();
        // Swim: hold Space to stay afloat in water (same key jumps on land).
        // A villager in reach keeps the visitor afloat too (talkAfloat).
        if (player) player.setSwimIntent(jumpInput || this.talkAfloat);
        // Free dive: hold Shift in water to swim DOWN. Independent of Space,
        // so you can hold both; the dive branch outranks the float branch.
        if (player) {
          player.setDiveIntent(this.inputManager.getDiveInput());
          // The touch DIVE button appears only while actually swimming.
          this.ui.setAuxActionAvailable('dive', player.isSwimming());
        }
        // A11: HOLD Shift while moving on land = run (stamina-gated); on
        // touch, the stick held at the rim for 250 ms. Space only jumps (and
        // floats in water, where Shift still dives). ?legacyrun=1 keeps the
        // old hold-Space run for one release.
        if (player) {
          const runMag =
            Math.abs(moveInput.forward + joy.forward) + Math.abs(moveInput.strafe + joy.strafe);
          player.setRunIntent(this.runIntent(jumpInput, joy, player.isInWater()) && runMag > 0.3);
          this.ui.updateStamina(player.getStamina(), player.isRunning());
          // One-time nudge: winded while carrying food → teach the G/eat verb.
          if (
            player.getStamina() < 0.15 &&
            this.meals.pie + this.meals.fish + this.meals.soup > 0
          ) {
            try {
              if (!localStorage.getItem('ds_hint_eat')) {
                localStorage.setItem('ds_hint_eat', '1');
                this.ui.toast('😮‍💨 Winded? Press G to eat and restore stamina.', { hint: true });
              }
            } catch {
              /* no storage */
            }
          }
        }
        if (jumpInput && player && !player.isInWater()) {
          // Edge-triggered — SOUND AND PHYSICS TOGETHER, one jump per
          // physical press. The sound was edge-gated but playerJump() still
          // ran every held frame, so holding Space bunny-hopped SILENTLY on
          // each landing (snap-down makes landings frequent on slopes) while
          // the run-share comment claims held Space never re-jumps. Both now
          // share the same edge and the same canJump predicate.
          if (player.canJump() && !this.prevJumpHeld) {
            sfx.jump();
            this.scene.playerJump();
          }
        }
        this.prevJumpHeld = jumpInput;
        // A13: the first-use and first-encounter hints, once each.
        if (player) this.updateFirstHints(deltaTime, player);
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

        // Appearance editor (C) and photo mode (P). Latched like the verbs
        // above, so they fire only here in free walk: never from a field or
        // a focused control, never behind a panel, never as Ctrl/Meta+C, and
        // never late (a press at the wheel or on a bench is dropped there).
        if (this.inputManager.consumeKeyPress('c')) {
          if (this.ui['customizeDiv']) {
            this.ui.hideCustomize();
          } else {
            this.openCustomize();
          }
        }
        if (this.inputManager.consumeKeyPress('p')) void this.capturePhoto();

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
              // A13: on the heel strikes, phases 0.0 and 0.5 (crossedPhase
              // counts a wrap past 1.0, e.g. 0.97 to 0.03, as crossing 0).
              if (this.crossedPhase(this.prevWalkPhase, walkPhase, 0.0)) {
                this.stepAlt = false;
                sfx.footstep(this.stepAlt);
                this.scene.spawnDust(player.getWorldPosition(), 1);
              }
              if (this.crossedPhase(this.prevWalkPhase, walkPhase, 0.5)) {
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

        // Apply camera input (drag, swipe, keyboard look)
        this.applyLook(deltaTime);

        // Check for nearby interactable and handle interaction.
        // Interpolated values are HTML-escaped: the prompt renders via
        // innerHTML (for the <strong> keycap), and names/bubble text must
        // never become an XSS vector once they turn dynamic (multiplayer).
        const esc = (s: string) =>
          s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        let buildOpp: ReturnType<SimpleApp['nearestBuildOpportunity']> = null;
        const board = this.scene.nearestBoardable();
        const nearby = this.scene.getNearbyInteractable();
        // P2-A13: a Projects work site within 3.5 u (5 squared distances).
        const landmark = player
          ? this.nearestLandmark(player.getWorldPositionInto(this._landmarkPos))
          : null;
        this.talkAfloat = !!player && player.isInWater() && nearby?.type === 'npc';
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
        } else if (player && player.isInWater() && !player.isSwimming() && !this.talkAfloat) {
          // In the water and sinking: tell them how to swim. A villager in
          // reach outranks it (talkAfloat): the talk prompt shows below.
          this.ui.showInteractionPrompt('🏊 Hold <strong>Space</strong> to swim');
        } else if (this.scene.isFishingActive()) {
          // Line is in the water: reeling outranks every other interaction.
          // P2-A6: the landing splashes, the bite DIPS the float. Until it
          // dips, E only says "not yet"; holding E for 0.6 s reels in early.
          const biting = this.scene.isFishBiting();
          this.ui.showInteractionPrompt(
            biting
              ? '❗ Press <strong>E</strong> — something is biting!'
              : this.ui.isTouchDevice()
                ? '🎣 Watch the float — tap <strong>👆 USE</strong> when it dips'
                : '🎣 Watch the float — press <strong>E</strong> when it dips',
          );
          const pressed = this.inputManager.consumeKeyPress('e');
          let reel = biting && pressed;
          if (!biting) {
            if (pressed) {
              this.fishEarlyHoldAt = performance.now();
              this.ui.flashMessage('Not yet — wait for the float to dip');
            } else if (this.fishEarlyHoldAt >= 0 && !this.inputManager.isKeyPressed('e')) {
              this.fishEarlyHoldAt = -1;
            }
            reel =
              this.fishEarlyHoldAt >= 0 &&
              performance.now() - this.fishEarlyHoldAt >= SimpleApp.FISH_EARLY_REEL_MS;
          }
          if (reel) {
            this.fishEarlyHoldAt = -1;
            if (this.scene.reelLine() === 'fish') {
              this.fishEver = true; // a rung-2 goal (P2-A12)
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
            this.scene.logTransaction('Sold fish', earned);
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
              this.scene.logTransaction('Sold timber', trancheEarn);
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
            this.scene.logTransaction('Sold wheat', wEarn);
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
          if (this.vendorPress('canteen')) {
            this.lockVendor('canteen');
            this.scene.addCoins(pEarn);
            this.scene.logTransaction('Sold produce', pEarn);
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
            this.scene.logTransaction('Sold produce', gEarn);
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
          if (this.vendorPress('canteen')) {
            if (!this.scene.spendCoins(SimpleApp.SOUP_PRICE)) {
              this.ui.toast('🪙 Soup is 3 coins.');
            } else {
              this.lockVendor('canteen');
              this.meals.soup++;
              this.persistMeals();
              this.refreshFeedHud();
              sfx.spend();
              this.scene.logTransaction('Bought soup', -SimpleApp.SOUP_PRICE);
              this.scene.floatCoinsAtPlayer(SimpleApp.SOUP_PRICE, true);
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
            this.scene.logTransaction('Sold ore', oEarn);
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
          // P2-A9: the School teaches by doing. E enrols and opens the
          // lessons card; a lesson pays the first time its action happens.
          this.ui.showInteractionPrompt(
            this.schoolEnrolled
              ? `📚 Press <strong>E</strong> for your lessons (${this.lessons.length}/${SimpleApp.LESSONS.length} learned)`
              : '📚 Press <strong>E</strong> — the School: learn by doing, 10 🪙 a lesson',
          );
          if (this.inputManager.consumeKeyPress('e')) this.openSchool();
        } else if (
          (buildOpp = this.nearestBuildOpportunity()) !== null &&
          // A stake never shadows an actionable tool prompt (the farm's edge
          // stake was eclipsing "Press E to harvest" for sickle owners
          // standing in the crops). P2-A6: a near stake no longer escapes
          // this either, so harvest presses beside the farm stake harvest.
          !(
            (this.ownedAxe && this.scene.nearestChoppableTree() !== null) ||
            (this.ownedSickle && this.scene.nearestHarvestableCrop() !== null) ||
            (this.ownedPickaxe && this.scene.nearestOreNode() !== null)
          ) &&
          // Nor a nearer interactable: the courier tour's first mailbox
          // stands 3-6 u from a bench plot's advert.
          !(nearby && nearby.distance < buildOpp.dist) &&
          // Nor a work site's info prompt (P2-A13): RankPilot's site showed
          // only the bench plot's advert. An own build still wins its slot.
          !(landmark && landmark.dist < 3.5 && !buildOpp.own)
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
              sfx.spend();
              this.scene.logTransaction('Checkup', -10);
              this.scene.floatCoinsAtPlayer(10, true);
              track('checkup', {});
              this.ui.toast('🏥 "All clear! Off you go — briskly, now."');
            }
          }
        } else if (this.scene.isNearBank()) {
          this.ui.showInteractionPrompt(
            '🏦 Press <strong>E</strong> — the vault keeps your coins safe between visits',
          );
          if (this.inputManager.consumeKeyPress('e')) void this.openVault();
        } else if (this.scene.isNearKiosk()) {
          this.ui.showInteractionPrompt('🛒 Press <strong>E</strong> to browse the kiosk');
          if (this.vendorPress('kiosk')) {
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
            // P2-A6: a glowing mailbox names its key before its message.
            const bubble = nearby.mailbox.bubbleText;
            text = bubble
              ? nearby.mailbox.hasDelivery
                ? `📬 Press <strong>E</strong> — ${esc(bubble.replace(/^📬\s*/u, ''))}`
                : esc(bubble)
              : nearby.mailbox.hasDelivery
                ? '📬 Press <strong>E</strong> to collect the delivery'
                : '📭 Press <strong>E</strong> to check the mailbox';
          } else if (nearby.type === 'lamp') {
            text = '💡 Press <strong>E</strong> to toggle the lamp';
          } else if (nearby.type === 'zone') {
            text = `🚪 Press <strong>E</strong> to enter ${esc(nearby.zone.name)}`;
            // A district map pick has arrived once this prompt is up.
            this.doorPromptZone = String(nearby.zone.id);
          } else if (nearby.type === 'house_door') {
            text = '🚪 Press <strong>E</strong> to enter';
          } else if (nearby.type === 'npc') {
            // AI townsfolk advertise free-text chat — "talk" alone reads as a
            // canned dialogue tree, and visitors never discover the real LLM.
            // The prompt says what THIS press does (P2-A7): a quest giver has
            // a request, an errand's next villager is expecting the visitor,
            // and 'ask anything' shows only when E opens the chat.
            const who = nearby.npcData.name;
            const held = this.scene.getCoinsCollected();
            const quest = this.npcQuests.talkKind(who, held);
            text =
              quest === 'offer'
                ? `💬 Press <strong>E</strong> — <strong>${esc(who)}</strong> has a request`
                : quest === 'errand'
                  ? `💬 Press <strong>E</strong> — <strong>${esc(who)}</strong> is expecting you`
                  : isAiNpc(who) && !this.questLinesFirst(who, held)
                    ? `💬 Press <strong>E</strong> to talk to <strong>${esc(who)}</strong> — ask anything`
                    : `💬 Press <strong>E</strong> to talk to <strong>${esc(who)}</strong>`;
          } else if (nearby.type === 'bench') {
            text = '🪑 Press <strong>E</strong> to sit down';
          }
          this.ui.showInteractionPrompt(text);

          if (this.inputManager.consumeKeyPress('e')) {
            this.scene.interactWith(nearby);
          }
        } else if (landmark && !this.toolActionHere()) {
          // P2-A13: a Projects work site says what it is, from the boards'
          // table, and E opens Projects at its card. Below talk, doors,
          // vehicles and tool actions; 'landmark' never stamps the passport.
          const site = PROJECT_BOARDS[landmark.i];
          this.ui.showInteractionPrompt(
            `🏗️ Press <strong>E</strong> — ${esc(site?.name ?? 'Projects')} · ${esc(site?.status ?? '')}`,
          );
          if (this.inputManager.consumeKeyPress('e')) {
            this.ui.showZonePanel(
              { id: 'projects', name: 'projects' },
              { source: 'landmark', anchor: SimpleApp.LANDMARK_ANCHORS[landmark.i] },
            );
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
              this.packToast(`🪵 Timber! +${r.timber} (${this.timber} in the pack)`);
              track('tree_felled', { timber: this.timber });
              this.learnLesson('chop');
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
              this.packToast(
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
              this.packToast(
                `⛏️ Ore! +${r.ore} (${this.ore} in the pack) — the bank assays these.`,
              );
            }
          }
        } else if (this.ownedRod && this.scene.canCastHere()) {
          // Lowest interaction priority: NPCs, mailboxes and doors all win
          // over casting, so the shore never shadows a conversation.
          this.ui.showInteractionPrompt('🎣 Press <strong>E</strong> to cast a line');
          if (this.inputManager.consumeKeyPress('e')) {
            if (this.scene.tryCastLine(performance.now() / 1000)) this.learnLesson('fish');
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
      // The welcome card or the loader owns the moment: no movement, no
      // banked camera input, and no latched press firing once it closes (C,
      // P, M and E on the card used to act the moment Explore was clicked).
      this.holdWorldInput();
    }

    // Quest compass: point at the active delivery's mailbox
    this.updateQuestCompass();
    // First steps (A6): one bound tick, timed under FxBudget's 'guide'.
    if (this.guide && fx.on('guide')) {
      this.guideDt = deltaTime;
      fx.time('guide', this.boundGuideTick);
    }

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
      const wp = audioPlayer.getWorldPositionInto(this._audioPos);
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
    if (this.multiplayer && this.multiplayer.nearestPeerDistance() < CHAT_PROXIMITY_RADIUS) {
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
      const lp = this.scene.getPlayer().getWorldPositionInto(this._listenerPos);
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
   * This frame the world takes no input: the welcome card, the loader or a
   * non-walkable panel owns the moment. Movement goes to zero in whatever
   * the avatar is doing (on foot, driving, indoors), latched presses are
   * dropped, and banked look and pinch input is drained so it cannot land
   * as one whip when the moment ends — the tour branch's drain, for all.
   * The chase camera is told the frame is held, not still: taken for a stop,
   * it used to start the reduced-motion recentre behind an open panel.
   */
  private holdWorldInput(): void {
    this.scene.getOrbitCamera().holdMoveInput();
    this.scene.setPlayerMovement(0, 0);
    if (this.scene.isRidingVehicle()) {
      this.scene.setVehicleMove(0, 0);
      this.currentThrottle = 0;
    }
    if (this.scene.isInsideInterior()) this.scene.setInteriorMove(0, 0);
    this.inputManager.clearLatched();
    this.inputManager.getCameraInput();
    consumePinchZoomFactor();
  }

  /**
   * The end of a frame spent indoors, in a conversation, on a bench or at the
   * wheel: every press the frame did not act on is dropped. Those moments use
   * E and R at most, and the walk verbs (Q, F, G, M, C, P) act only in free
   * walk, so a press kept for later fired when the moment ended: P in the car
   * took a photo on hop-off, C on the bench opened the appearance editor on
   * standing up, R indoors recentred the camera outside. The 📸 and 🎨 HUD
   * buttons call their handlers directly, so the latch never touches them.
   */
  private dropUnusedPresses(): void {
    this.inputManager.clearLatched();
  }

  /**
   * This frame's look, wherever the camera follows the visitor (on foot,
   * driving, seated, in a conversation): the drag or swipe in radians from
   * SimpleInputManager, with any fling it released; J/L to turn and I/K to
   * tilt; R to recentre behind the player. Typing never gets here: a focused
   * field keeps its keys (keyGuards.ts), and blocked frames drain instead.
   */
  private applyLook(deltaTime: number): void {
    const cam = this.scene.getOrbitCamera();
    const look = this.inputManager.getCameraInput();
    cam.setInput(look.deltaX, look.deltaY, look.source);
    if (look.fling !== 0) cam.fling(look.fling);
    const held = (k: string): number => (this.inputManager.isKeyPressed(k) ? 1 : 0);
    cam.keyLook(held('l') - held('j'), held('i') - held('k'), deltaTime);
    if (this.inputManager.consumeKeyPress('r')) cam.recentre();
  }

  /**
   * Point the HUD compass at ONE target, in Compass.compassTarget's order
   * (A7 with P2-A3), and feed it the bearing from the camera's forward
   * direction, both projected onto the player's tangent plane. Hidden when
   * nothing is left to point at.
   */
  private updateQuestCompass(): void {
    const player = this.scene.getPlayer();
    if (!player) {
      this.ui.updateQuestCompass(null);
      return;
    }
    // Into-variants write the scratches directly — the old .copy(clone())
    // pattern kept the scratch but still paid the allocation each frame.
    // Indoors the pill is hidden (P2-A1, INT-11): the avatar stands frozen at
    // the door outside, so the pill kept a bearing and a label for a walk the
    // room cannot make. Picks, stamps and the "Next:" flash wait at the door.
    if (this.scene.isInsideInterior()) {
      this.arrivalHold = null;
      this.lastCompassTarget = null;
      this.compassLabel = '';
      this.ui.updateQuestCompass(null);
      return;
    }
    const playerPos = player.getWorldPositionInto(this._qcPlayerPos);
    const normal = player.getSurfaceNormalInto(this._qcNormal);
    const now = performance.now();

    // Map-pick arrival. A district pick ends at its door: its door prompt is
    // up, or the visitor is within 3.2 u (the old 6 u let go before the
    // prompt's 3.4 u, and the pill swung to a mailbox on the plaza). Any
    // other pick ends at 6 u. Either way the pill holds on the spot for 8 s,
    // and a district's hold still names it, as its door prompt does.
    if (this.mapGuideTarget) {
      const d = playerPos.distanceTo(this.mapGuideTarget);
      const zone = this.mapGuideZone;
      if (zone !== null ? this.doorPromptZone === zone || d < 3.2 : d < 6) {
        const name = DISTRICTS.find((x) => x.id === zone)?.name;
        const verb = this.ui.isTouchDevice() ? '🚪 Tap USE to enter' : '🚪 Press E to enter';
        const enter = name ? `${verb} ${name}` : verb;
        this.arrivalHold = {
          pos: this.mapGuideTarget,
          label: zone !== null ? enter : '✓ Here',
          until: now + 8000,
        };
        this.mapGuideTarget = null;
        this.mapGuideZone = null;
        this.ui.toast('🧭 You have arrived.');
      }
    }
    if (this.arrivalHold && (now > this.arrivalHold.until || this.scene.isInsideInterior())) {
      this.arrivalHold = null;
    }

    const passport = this.passport;
    const projects = this.zonePos('projects');
    const district = this.nearestDistrict(playerPos);
    const active = this.deliverySystem?.getActiveDeliveries?.() ?? [];
    const delivery = active.length > 0 ? active[0] : null;
    if ((passport?.count() ?? 0) > 0) this.trailDone = true;
    // The pill points where the coins lead, the villager's seat, so the two
    // never fork when the villager has wandered a few steps. Within 4 u of
    // the seat (or once any conversation opens) the trail has done its job;
    // a villager who wanders up to a visitor standing still does not end it.
    let trailPos =
      this.trailVillager && !this.trailDone && this.scene.hasTrailCoins()
        ? this.trailSeat(this.trailVillager)
        : null;
    // A villager who has gone to bed ends the trail: nobody is at the seat.
    if (trailPos && this.trailVillager && !this.villagerUp(this.trailVillager)) {
      this.trailDone = true;
      trailPos = null;
    }
    if (trailPos && playerPos.distanceTo(trailPos) < SimpleApp.TRAIL_REACHED_U) {
      this.trailDone = true; // arrived: the next target takes over
      trailPos = null;
    }
    // Until the visitor has talked to them, the pill names the villager First
    // steps sends them to, where they stand now: a reload has no trail coins,
    // and the trail ends at its seat before a word is said, so the card said
    // "Walk up to Mayor" over a pill on Projects. Until the first stamp, as
    // the trail.
    const talkWho =
      !trailPos && (passport?.count() ?? 0) === 0 ? (this.guide?.talkTargetNow() ?? null) : null;
    const talkPos = talkWho ? this.scene.getNpcPosition(talkWho) : null;
    const st = this._compassState;
    // P2-A8: a running race has the pill, ring by ring. A race that ended
    // without its event (a teardown) lets the quiet-laps flag go here too.
    const gate = this.scene.getRaceNextGate?.(this._qcRaceGate) ?? null;
    if (!gate) this.racing = false;
    st.racing = gate !== null;
    st.mapPick = this.mapGuideTarget !== null;
    st.arrivalHold = this.arrivalHold !== null;
    // Behind the welcome card, while First steps will arm as it closes, the
    // pill waits: it named Projects there and the villager after Explore.
    const g = this.guide;
    st.guidePending =
      !!g && g.eligible() && !g.running() && this.ui.isWelcomeVisible() && !this.tour;
    st.raceGuide = this.raceGuideTarget !== null;
    st.aiGuide = this.aiGuideTarget !== null;
    st.trailVillager = trailPos !== null;
    st.talkStep = talkPos !== null;
    st.projectsUnstamped = !!passport && !!projects && !passport.has('projects');
    st.districtUnstamped = district !== null;
    st.parcelActive = !!delivery?.destination;
    st.passportComplete = passport?.isComplete() ?? false;
    st.deliveryOptIn = this.deliveryOptIn;
    st.goal = this.goalTarget !== null;
    let targetPos: THREE.Vector3 | null = null;
    let label = '';
    switch (compassTarget(st)) {
      case 'racing':
        // Rings are 1..n-1 in order; index 0 is the start gate, which is
        // also the finish once every ring is through.
        targetPos = this._qcRaceGate;
        label = gate && gate.idx >= 1 ? `🏁 Ring ${gate.idx}/${gate.n - 1}` : '🏁 Finish line';
        break;
      case 'map':
        // Island-map pick or a 'ds:guide-to' key: explicit intent, until reached.
        targetPos = this.mapGuideTarget;
        label = this.mapGuideLabel;
        break;
      case 'hold':
        targetPos = this.arrivalHold?.pos ?? null;
        label = this.arrivalHold?.label ?? '';
        break;
      case 'race':
        // "Beat the lap record" CTA, cleared when a race starts. From the
        // CTA it leads to the nearest parked car until the visitor drives
        // one, then to the start gate (P2-A8). Without B's accessor, the gate.
        targetPos = this.raceGuideTarget;
        label = '🏁 Race start';
        if (this.raceGuideViaCar) {
          const inCar = this.scene.isRidingVehicle() && this.scene.getActiveVehicleKind() === 'car';
          const car = inCar
            ? null
            : ((this.scene as RaceScene).nearestVehiclePos?.('car', this._qcCar) ?? null);
          if (car) {
            targetPos = car;
            label = '🚗 Grab a car';
          }
        }
        break;
      case 'ai':
        // "Ask the townsfolk": cleared once the visitor talks to an AI villager.
        targetPos = this.aiGuideTarget;
        label = '🤖 The Storyteller';
        break;
      case 'trail':
        // The villager the first-visit coins lead to, by name.
        targetPos = trailPos;
        label = this.trailVillager ?? '';
        break;
      case 'talk':
        // The villager First steps sends them to, wherever they have wandered.
        targetPos = talkPos;
        label = talkWho ?? '';
        break;
      case 'projects':
        targetPos = projects;
        label = `${PASSPORT_META.projects.icon} ${PASSPORT_META.projects.label}`;
        break;
      case 'district':
        targetPos = district ? this.zonePos(district) : null;
        label = district ? this.districtLabel(district) : '';
        break;
      case 'parcel':
        // Its own glyph: 📬 means the Contact district only.
        targetPos = delivery?.destination?.mesh.position ?? null;
        label = '📦 Parcel';
        break;
      case 'goal':
        // The Next chip's goal (P2-A12): only when nothing above has the pill.
        targetPos = this.goalTarget?.pos ?? null;
        label = this.goalTarget?.label ?? '';
        break;
    }
    this.lastCompassTarget = targetPos ?? null;
    this.compassLabel = targetPos ? label : '';

    // After each of stamps 1-3, once, outside and with no panel up: where next.
    const stamps = passport?.count() ?? 0;
    if (this.stampsSeen < 0) this.stampsSeen = stamps;
    else if (stamps > this.stampsSeen) {
      this.stampsSeen = stamps;
      if (stamps <= 3) this.pendingNextFlash = true;
    }
    if (
      this.pendingNextFlash &&
      targetPos &&
      (st.projectsUnstamped || st.districtUnstamped) &&
      !this.scene.isInsideInterior() &&
      !this.ui.panels.isOpen()
    ) {
      this.pendingNextFlash = false;
      const next = st.projectsUnstamped
        ? `${PASSPORT_META.projects.icon} ${PASSPORT_META.projects.label}`
        : this.districtLabel(district ?? '');
      this.ui.flashMessage(`Next: ${next} — the gold arrow points the way.`);
    }

    if (!targetPos) {
      this.ui.updateQuestCompass(null);
      this.scene.setGuideTarget(null);
      return;
    }

    // Feed the in-world breadcrumb trail the same target as the HUD compass —
    // EXCEPT while the first-visit arrival coins are still down: two golden
    // trails pointing different ways is a fork, not a path. The coins lead to
    // the nearest villager (where the talk hint fires), the completion hint
    // (or First steps' talk step) hands off to the ➤ arrow, and THEN the
    // sparkles resume toward the pill's target — a chain. Target-based
    // suppression (null), never visibility-based: reduced-motion users keep
    // their breadcrumbs by design.
    this.scene.setGuideTarget(this.scene.hasTrailCoins() ? null : targetPos);

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
    // Positive = target to the RIGHT, the sign SimpleUI's rotate(angle − 90°)
    // needs. The old atan2((camForward × toTarget) · normal, …) was mirrored:
    // every off-axis arrow pointed to the wrong side (Compass.ts).
    const angleRad = compassBearing(camForward, toTarget, normal);
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

  /** Reused by updateQuestCompass every frame (no allocation). */
  private readonly _compassState: CompassState = {
    racing: false,
    mapPick: false,
    arrivalHold: false,
    guidePending: false,
    raceGuide: false,
    aiGuide: false,
    trailVillager: false,
    talkStep: false,
    projectsUnstamped: false,
    districtUnstamped: false,
    parcelActive: false,
    passportComplete: false,
    deliveryOptIn: false,
    goal: false,
  };

  /** The districts' door positions, read once: zones never move, and
   *  Zone.getPosition() clones on every call. */
  private zoneList: Array<{ id: string; pos: THREE.Vector3 }> | null = null;
  private zonePos(id: string): THREE.Vector3 | null {
    if (!this.zoneList) {
      this.zoneList = this.scene
        .getZonesManager()
        .getZones()
        .map((z) => ({ id: String(z.id), pos: z.getPosition() }));
    }
    for (const z of this.zoneList) if (z.id === id) return z.pos;
    return null;
  }

  /**
   * The unstamped district the pill points at (compassTarget's branch 7):
   * the nearest, but the current one is kept until another is 12 u closer.
   * Null once the passport is complete. Only the four stamp zones count; the
   * Welcome hub is the intro, not a destination.
   */
  private nearestDistrict(playerPos: THREE.Vector3): string | null {
    const passport = this.passport;
    if (!passport || passport.isComplete()) {
      this.compassDistrict = null;
      return null;
    }
    this.zonePos('projects'); // fills zoneList
    const pool = this.districtDists;
    let n = 0;
    for (const z of this.zoneList ?? []) {
      if (!passport.isStampZone(z.id) || passport.has(z.id)) continue;
      const c = pool[n] ?? (pool[n] = { id: z.id, dist: 0 });
      c.id = z.id;
      c.dist = playerPos.distanceTo(z.pos);
      n++;
    }
    pool.length = n;
    this.compassDistrict = nearestWithHysteresis(this.compassDistrict, pool);
    return this.compassDistrict;
  }

  /**
   * P2-A6: the stamp district nearest a point, stamped or not, with no
   * hysteresis and no compass state (nearestDistrict's pool is the pill's).
   */
  private districtNear(pos: THREE.Vector3): string | null {
    this.zonePos('projects'); // fills zoneList
    let best: string | null = null;
    let bestD = Infinity;
    for (const z of this.zoneList ?? []) {
      if (this.passport && !this.passport.isStampZone(z.id)) continue;
      const d = pos.distanceTo(z.pos);
      if (d < bestD) {
        bestD = d;
        best = z.id;
      }
    }
    return best;
  }

  private districtLabel(id: string): string {
    const meta = (PASSPORT_META as Record<string, { icon: string; label: string }>)[id];
    return meta ? `${meta.icon} ${meta.label}` : id;
  }

  /** How near an awake AI villager must stand to be the trail villager. */
  private static readonly TRAIL_VILLAGER_RANGE = 30;
  /** Within this of the trail villager, the trail has done its job. */
  private static readonly TRAIL_REACHED_U = 4;

  /**
   * compassTarget's branch 4: the villager the first-visit coins lead to.
   * That is the trail's own villager (GameScene names it once B10 exposes
   * getTrailVillager; until then the same seat search createArrivalTrail
   * makes) when it is an awake AI villager within 30 u. Otherwise the
   * nearest awake AI villager within 30 u, and with none the branch is
   * skipped. Reads positions only: no draw from any random stream.
   */
  private trailChosen = false;
  /**
   * The trail villager is chosen once per load, then faced (A7). afterIntro
   * calls this; a calm entry calls it first, before the first frame, since
   * its afterIntro waits for the late models (whenLateModelsLinked).
   */
  private chooseTrailVillager(): void {
    if (this.trailChosen) return;
    this.trailChosen = true;
    this.trailVillager = this.pickTrailVillager();
    this.faceTrailVillager();
  }

  private pickTrailVillager(): string | null {
    const player = this.scene.getPlayer();
    if (!player) return null;
    const p = player.getWorldPosition();
    const targets = this.scene.getIsland().npcTargets;
    const range = SimpleApp.TRAIL_VILLAGER_RANGE;
    const awakeNear = (name: string): number | null => {
      if (!isAiNpc(name)) return null;
      const t = targets.find((x) => x.name === name);
      if (!t || !t.meshRef.visible || this.scene.getNpcActivity(name) === 'sleep') return null;
      const d = t.meshRef.position.distanceTo(p);
      return d <= range ? d : null;
    };
    const named =
      (this.scene as unknown as { getTrailVillager?: () => string | null }).getTrailVillager?.() ??
      this.trailSeatVillager();
    if (named && awakeNear(named) !== null) return named;
    let best: string | null = null;
    let bestD = Infinity;
    for (const name of Object.keys(AI_NPCS)) {
      const d = awakeNear(name);
      if (d !== null && d < bestD) {
        bestD = d;
        best = name;
      }
    }
    return best;
  }

  /** In the world and not headed for bed: the sleep goal walks a villager
   *  home under an "asleep" tag, then hides them inside. Villagers get their
   *  first goal seconds after the intro, so the pick above cannot know. */
  private villagerUp(name: string): boolean {
    const t = this.scene.getIsland().npcTargets.find((x) => x.name === name);
    return !!t && t.meshRef.visible && this.scene.getNpcActivity(name) !== 'sleep';
  }

  /**
   * Who First steps sends the visitor to talk to (Guide's talkTarget): the
   * trail villager while they are up. Once they have gone to bed, the
   * stand-in the guide names already, while that one is up; else the nearest
   * awake villager who talks, within 30 u; with none, null, and the talk step
   * is skipped. At night the card and the pill used to name a villager whose
   * tag read "asleep" on the walk home.
   */
  private talkVillager(current: string | null): string | null {
    const trail = this.trailVillager;
    if (trail && this.villagerUp(trail)) return trail;
    if (current && this.villagerUp(current)) return current;
    const near = this.guideWorld.nearestAiVillager();
    const p = this.scene.getPlayer()?.getWorldPosition();
    if (!near || !p) return null;
    const d = Math.hypot(near.pos.x - p.x, near.pos.y - p.y, near.pos.z - p.z);
    return d <= SimpleApp.TRAIL_VILLAGER_RANGE ? near.name : null;
  }

  /** Each villager's seat as the world was built (filled once, after
   *  scene.ready): where the arrival trail was laid toward. */
  private readonly npcSeats = new Map<string, THREE.Vector3>();
  private trailSeat(name: string): THREE.Vector3 | null {
    return this.npcSeats.get(name) ?? null;
  }

  /** createArrivalTrail's search, on the same build-time seats: the seat
   *  nearest the spawn direction, beyond 0.04 rad, among the AI villagers
   *  (B10's rule). */
  private trailSeatVillager(): string | null {
    const spawnDir = new THREE.Vector3(0.1, 1, 0.1).normalize(); // the player spawn
    const dir = new THREE.Vector3();
    let best = Infinity;
    let who: string | null = null;
    for (const [name, seat] of this.npcSeats) {
      if (!isAiNpc(name)) continue;
      const d = dir.copy(seat).normalize().angleTo(spawnDir);
      if (d > 0.04 && d < best) {
        best = d;
        who = name;
      }
    }
    return who;
  }

  /** How far right of dead ahead phones see the trail's end at Explore. */
  private static readonly TRAIL_VIEW_OFFSET = (20 * Math.PI) / 180;

  /**
   * Phones end the intro facing the trail villager, so the coins that lead
   * to them are on screen (A7): the view turns to the villager's seat, the
   * end of the trail, then 20° past it. Dead ahead, the trail ran straight
   * away from the camera through the avatar, whose body hid every coin
   * (measured at 390x844: 0 of 4 seen; at 20°, the coins clear the avatar
   * and the villager stays on screen). OrbitCamera.setYaw hard-cuts, like
   * snapToPlayer; a positive bearing is a target on the right, and a
   * positive yaw turns the view left, so the view turns by −bearing, plus
   * the offset to put the seat on the right.
   */
  private faceTrailVillager(): void {
    if (!this.coarsePointer) return;
    const name = this.trailVillager;
    const npc = name ? (this.trailSeat(name) ?? this.scene.getNpcPosition(name)) : null;
    const player = this.scene.getPlayer();
    if (!npc || !player) return;
    const cam = this.scene.getOrbitCamera();
    const p = player.getWorldPositionInto(this._qcPlayerPos);
    const n = player.getSurfaceNormalInto(this._qcNormal);
    const to = this.projectTangent(this._qcToTarget, this._qcTmp.copy(npc).sub(p), n);
    const fwd = this.projectTangent(this._qcCamFwd, cam.getForwardDirection(), n);
    if (to.lengthSq() < 1e-6 || fwd.lengthSq() < 1e-6) return;
    const bearing = compassBearing(fwd.normalize(), to.normalize(), n);
    cam.setYaw(cam.getYaw() - bearing + SimpleApp.TRAIL_VIEW_OFFSET);
  }

  /** The 30 s travel window for the stall trigger: one sample per 2.5 s. */
  private readonly lostTrail: THREE.Vector3[] = [];
  private lostStallHints = 0;
  private static readonly LOST_STALL_SAMPLES = 12; // 12 x 2.5 s = 30 s
  private static readonly LOST_STALL_U = 10;
  private static readonly LOST_STALL_MAX = 2;

  /** The lost-visitor hint, one line for both triggers. */
  private showLostHint(): void {
    this.ui.toast(
      this.ui.isTouchDevice()
        ? '🗺️ Lost? Tap the radar for the island map — pick a spot and the gold arrow guides you.'
        : '🗺️ Lost? Click the radar or press M for the island map — pick a spot and the gold arrow guides you.',
      { hint: true, until: this.indoorsNow },
    );
  }

  /**
   * The stall trigger, sampled on the 2.5 s cadence: under 10 u travelled
   * in the last 30 s of free roam, with no passport stamp. Fires at most
   * twice a visit, and the window starts over after it fires.
   *
   * Only free-roam time counts. Anything that holds the visitor clears the
   * window, which starts over when it lets go: any panel (the menu, a hall
   * panel, the hire card, NPC chat, a quest dialogue), the guide holding
   * hints, a tour, a room, a line in the water or a bench. Checking those
   * only at the instant of firing let a visitor who read a panel for 30 s
   * hear 'Lost?' the moment they closed it.
   */
  private checkLostStall(hintsHeld: boolean): void {
    const trail = this.lostTrail;
    const p = this.scene.getPlayer()?.getWorldPosition();
    const freeRoam =
      !!p &&
      !hintsHeld &&
      !this.ui.isWelcomeVisible() &&
      !this.ui.isLoadingVisible() &&
      !this.ui.panels.isOpen() &&
      !this.tour &&
      !this.scene.isInsideInterior() &&
      !this.scene.isFishingActive() &&
      !this.scene.isPlayerSeated();
    if (!freeRoam || this.lostStallHints >= SimpleApp.LOST_STALL_MAX) {
      trail.length = 0;
      return;
    }
    trail.push(p);
    if (trail.length > SimpleApp.LOST_STALL_SAMPLES + 1) trail.shift();
    if (trail.length <= SimpleApp.LOST_STALL_SAMPLES) return;
    let travelled = 0;
    for (let i = 1; i < trail.length; i++) travelled += trail[i].distanceTo(trail[i - 1]);
    if (travelled >= SimpleApp.LOST_STALL_U || (this.passport?.count() ?? 0) > 0) return;
    this.lostStallHints++;
    trail.length = 0;
    try {
      localStorage.setItem('ds_hint_map', '1'); // the same hint: the once-ever clause stands down
    } catch {
      /* no storage */
    }
    this.showLostHint();
  }

  /** Point the pill at a picked place: top of the chain until it is reached. */
  private setMapPick(pos: THREE.Vector3, label: string, zone: string | null): void {
    this.mapGuideTarget = pos;
    this.mapGuideLabel = label;
    this.mapGuideZone = zone;
    this.arrivalHold = null;
    this.trailDone = true; // the visitor chose a place: the trail is not called back
  }

  /**
   * The world as the 'Show me' resolver sees it (Guide.resolveGuideKey): the
   * same getters openIslandMap builds its POIs from.
   */
  private readonly guideWorld: GuideWorld = {
    zone: (id) => this.zonePos(id),
    school: () => this.scene.schoolPos(),
    kiosk: () => this.scene.kioskPos(),
    bank: () => this.scene.bankPos(),
    // The fisherman's jetty: where a line can be cast.
    shore: () => this.scene.fishermanPos(),
    carpenter: () => this.scene.carpenterRackPos(),
    farm: () => this.scene.farmPos(),
    raceStart: (kind) => this.scene.getRaceStartPosition(kind),
    nextMailbox: () =>
      this.deliverySystem?.getActiveDeliveries?.()?.[0]?.destination?.mesh.position ?? null,
    nearestStake: () => {
      const p = this.scene.getPlayer()?.getWorldPosition();
      let best: THREE.Vector3 | null = null;
      let bestD = Infinity;
      for (const f of this.scene.freePlotSummary()) {
        if (f.kind === 'bench') continue;
        const d = p ? f.pos.distanceTo(p) : 0;
        if (d < bestD) {
          bestD = d;
          best = f.pos;
        }
      }
      return best;
    },
    nearestAiVillager: () => {
      const p = this.scene.getPlayer()?.getWorldPosition();
      let best: { name: string; pos: THREE.Vector3 } | null = null;
      let bestD = Infinity;
      for (const t of this.scene.getIsland().npcTargets) {
        if (!isAiNpc(t.name) || !t.meshRef.visible) continue;
        if (this.scene.getNpcActivity(t.name) === 'sleep') continue;
        const d = p ? t.meshRef.position.distanceTo(p) : 0;
        if (d < bestD) {
          bestD = d;
          best = { name: t.name, pos: t.meshRef.position };
        }
      }
      return best;
    },
    beachHouse: () =>
      this.scene.getIsland().houseDoors.find((d) => d.id === 'islet_beach_house')?.position ?? null,
  };

  /**
   * Point the compass at a place named by key (P2-A5's 'ds:guide-to' seam),
   * exactly as an island-map pick does: top of the chain, under the arrival
   * rule (a district ends at its door), with the 'Compass set' toast. An
   * unknown key opens the island map instead, so a 'Show me' never dead-ends.
   */
  private guideTo(key: string, label: string | null, source: string): void {
    // Two ladder goals are panels, not places (P2-A12): their 'Show me'
    // opens them, whoever sends the key.
    if (key === 'panel:hire') {
      this.ui.showHireCard('menu');
      return;
    }
    if (key === 'panel:guestbook') {
      void this.ui.showGuestbook();
      return;
    }
    const hit = resolveGuideKey(key, this.guideWorld);
    if (!hit) {
      this.openIslandMap();
      return;
    }
    const shown = label ?? `${hit.icon} ${hit.label}`;
    this.setMapPick(new THREE.Vector3(hit.pos.x, hit.pos.y, hit.pos.z), shown, hit.zone);
    this.compassSetToast(`🧭 Compass set: ${shown}`);
    track('map_guide_set', { label: label ?? hit.label, source });
  }

  /**
   * The 'Compass set' toast, unless the guide card is out (wave-3 carry-over:
   * at 390x844 it landed on the First steps card). While First steps runs
   * unfolded, the recruiter route shows or the Next chip's list is open, the
   * card already names the goal and the compass pill shows the new label, so
   * the toast is dropped rather than held: a held one would arrive late,
   * after the visitor had moved on. D's toast anchor is the backstop.
   */
  private compassSetToast(text: string): void {
    if (this.guideCardOut()) return;
    this.ui.toast(text);
  }

  /** The guide card is unfolded: First steps (not the chip), the recruiter
   *  route, or the Next chip's open list. */
  private guideCardOut(): boolean {
    return (
      (this.guide?.isActive() ?? false) ||
      (this.route?.showing() ?? false) ||
      (this.nextChip?.isExpanded() ?? false)
    );
  }

  // ── First steps (A6) ─────────────────────────────────────────────────
  private guide: Guide | null = null;
  private guideCard: GuideCard | null = null;
  private guideDt = 0;
  /** This frame's walk input (keyboard plus joystick); 0 outside free walk. */
  private guideMoveMag = 0;
  private guidePromptT = 0;
  /** See the work / Get in touch closed the card: arm when the panel goes. */
  private guideArmOnPanelsClosed = false;
  private guidePrevValid = false;
  private readonly _guidePos = new THREE.Vector3();
  private readonly _guidePrev = new THREE.Vector3();
  private readonly _guideFrame: GuideFrame = {
    dt: 0,
    blocked: false,
    top: null,
    moveMag: 0,
    walked: 0,
    yaw: 0,
    targetDist: null,
  };
  /** The recruiter route (P2-A4), made with the guide. */
  private route: RecruiterRoute | null = null;
  /** How far the visitor has walked since the page loaded, u. */
  private walkedSinceLoad = 0;
  /** How the hire card now open was opened, when not by the pill or a chip. */
  private hireCardSource: RouteSource | null = null;
  // ── The goal ladder and the Next chip (P2-A12) ──────────────────────
  private nextChip: NextChip | null = null;
  /** Which surface #ds-guide last drew: one at a time on the one card. */
  private guideSurface: 'route' | 'steps' | 'next' | null = null;
  private goalsT = 0;
  private goalsPublishT = 0;
  private goalsWereOn = false;
  /** Where the chip's goal is, when it names a place: the compass's last
   *  resort (Compass.compassTarget's 'goal'). */
  private goalTarget: { pos: THREE.Vector3; label: string } | null = null;
  private readonly _goalPos = new THREE.Vector3();
  private readonly _goalFacts: Record<string, boolean> = {};
  // What only this session saw happen (the rest is read from the world).
  private hireSeen = false;
  private fishEver = false;
  private shopOpened = false;
  private readonly villagersTalked = new Set<string>();
  private coinsEarned = 0;
  private coinsSeen = -1;
  private visitStartedAt = 0;
  /** Bound once: FxBudget times it every frame. */
  private readonly boundGuideTick = (): void => this.guideTick();
  /** main-simple's own unprompted hints, held while the guide runs. */
  private readonly heldHints: string[] = [];

  private setupGuide(): void {
    const store: GuideStore = {
      get: (k) => localStorage.getItem(k),
      set: (k, v) => localStorage.setItem(k, v),
    };
    const flag = (k: string): boolean => {
      try {
        return localStorage.getItem(k) === '1';
      } catch {
        return false;
      }
    };
    this.guide = new Guide(
      store,
      {
        track: (name, props) => track(name, props),
        completed: () => sfx.blip(),
        skipped: () => {
          // Skip fires the compass hint instead; the gate is open by now.
          this.renderGuide();
          this.guideSkipHintShown = true;
          this.ui.toast(
            '🧭 The gold ➤ up top points to your next stop — tap it for the island map.',
            { hint: true },
          );
        },
      },
      {
        // Read now, at boot: Explore writes ds_welcomed for a first visit.
        welcomed: flag('ds_welcomed'),
        facts: () => ({
          npcChatted: flag('ds_npc_chatted'),
          passportCount: this.passport?.count() ?? 0,
          mapHint: flag('ds_hint_map'),
        }),
        talkTarget: (current) => this.talkVillager(current),
        controlsCard: !this.ui.isTouchDevice(),
      },
    );
    // The recruiter route (P2-A4) arms when a hire card closes. D4's 'ds:modal'
    // says which panel that was: {open: false, id: 'zone', zone: 'hire'}.
    this.route = new RecruiterRoute({ track: (name, props) => track(name, props) });
    // The Next chip (P2-A12) takes the card once the first steps are over.
    if (this.guide) {
      this.nextChip = new NextChip(this.guide, { track: (name, props) => track(name, props) });
    }
    this.boundHandlers.guideModal = (e: Event) => this.onModalEvent((e as CustomEvent).detail);
    window.addEventListener('ds:modal', this.boundHandlers.guideModal);
    // No card yet: #ds-guide is made when the guide first arms (renderGuide).
    // How the welcome card closes decides how the guide arms. Capture phase,
    // ahead of the buttons' own handlers: arming writes ds_hint_compass
    // before hideWelcome reads it, so the card's one-time compass hint never
    // lands on top of the guide.
    this.boundHandlers.guideWelcomeClick = (e: Event) => this.onWelcomeExit(e.target, null);
    this.ui.getOverlay().addEventListener('click', this.boundHandlers.guideWelcomeClick, true);
    this.boundHandlers.guideWelcomeKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') this.onWelcomeExit(null, 'explore');
    };
    window.addEventListener('keydown', this.boundHandlers.guideWelcomeKey, true);
  }

  /** The First steps card, #ds-guide. Made once, by renderGuide, when the
   *  guide first runs. */
  private createGuideCard(): GuideCard {
    return new GuideCard(this.ui.getOverlay(), {
      touch: this.ui.isTouchDevice(),
      reducedMotion: () => a11y.reducedMotion,
      onButton: (id) => this.onGuideButton(id),
      // D6's hook; before it lands, the prompt element itself.
      prompt: () =>
        document.querySelector<HTMLElement>('[data-hud="prompt"]') ??
        (this.ui as unknown as { interactionDiv?: HTMLElement | null }).interactionDiv ??
        null,
    });
  }

  /** Explore (or Escape) arms now; See the work and Get in touch arm when
   *  their panel closes; the full tour arms at its end. Hiring, Ask the
   *  townsfolk and Try a race set their own course. */
  private onWelcomeExit(target: EventTarget | null, forced: GuideArm | null): void {
    const card = this.ui
      .getOverlay()
      .querySelector('[role="dialog"][aria-label="Welcome to DigiScalability Life Island"]');
    if (!card) return;
    let exit = forced;
    if (!exit) {
      const b = (target as Element | null)?.closest?.('button') as HTMLElement | null;
      if (!b || !card.contains(b)) return;
      if (b.hasAttribute('data-dismiss')) exit = 'explore';
      else if (b.dataset.cta === 'projects' || b.dataset.cta === 'contact') exit = 'cta';
      else return;
    }
    if (exit === 'explore') this.armGuide('explore');
    else this.guideArmOnPanelsClosed = true;
  }

  /** Arm the guide; arming counts as the compass hint shown (ds_hint_compass).
   *  The card and its first 'ds:guide' appear now, at the arming. */
  private armGuide(source: GuideArm): boolean {
    if (!this.guide?.arm(source)) return false;
    try {
      localStorage.setItem('ds_hint_compass', '1');
    } catch {
      /* no storage */
    }
    this.guidePrevValid = false;
    this.renderGuide();
    return true;
  }

  /**
   * A modal opened or closed (D4's 'ds:modal'). A hire card closing arms the
   * recruiter route for a visitor who has not walked anywhere yet: one who
   * read the card and closed it stood on an island nobody had explained.
   */
  private onModalEvent(detail: unknown): void {
    const d = detail as { open?: unknown; id?: unknown; zone?: unknown } | null;
    if (!d || d.id !== 'zone' || d.zone !== 'hire') return;
    if (d.open === true) this.hireSeen = true; // a rung-1 goal (P2-A12)
    if (d.open !== false) return;
    const source = this.hireCardSource ?? 'hire';
    this.hireCardSource = null;
    this.armRoute(source);
  }

  /** Arm the route; like arming First steps, that counts as the compass hint
   *  shown (ds_hint_compass). */
  private armRoute(source: RouteSource): boolean {
    if (!this.route?.arm(source, this.walkedSinceLoad)) return false;
    try {
      localStorage.setItem('ds_hint_compass', '1');
    } catch {
      /* no storage */
    }
    this.renderGuide();
    return true;
  }

  /** While the guide runs, or may arm as the welcome card closes, main-simple
   *  fires no unprompted hints: talk, coin, lost, district, specials. */
  private guideHoldsHints(): boolean {
    // A running race holds them too (P2-A8 quiet laps): nothing fires and
    // no ds_hint_* key burns between 'Go!' and the finish or the abort.
    if (this.racing) return true;
    const g = this.guide;
    if (!g) return false;
    // The recruiter route holds them the same way while it is up.
    if (g.isActive() || this.route?.showing()) return true;
    return g.eligible() && !g.running() && (!this.introSettled || this.ui.isWelcomeVisible());
  }

  /**
   * A place hint that has not shown by the time the visitor is in a room is
   * dropped (D6's until()). On a phone a hint waits while a prompt is up, so
   * one fired on a doorstep came up over the room once the hall panel closed
   * (measured at 390x844: 'A villager nearby talks…', indoors).
   */
  private readonly indoorsNow = (): boolean => this.scene.isInsideInterior();
  /** The talk hint, dropped the same way, hands its once-ever key back
   *  unless the visitor has talked to a villager by then: it is the one
   *  line that says the villagers answer, and it fires again outside. */
  private readonly talkHintStale = (): boolean => {
    if (!this.scene.isInsideInterior()) return false;
    try {
      if (localStorage.getItem('ds_npc_chatted') !== '1') localStorage.removeItem('ds_hint_talk');
    } catch {
      /* no storage */
    }
    return true;
  };

  /** P2-A10: the talk hint is also stale once the visitor has chatted. */
  private readonly talkHintStaleOrChatted = (): boolean => {
    if (this.talkHintStale()) return true;
    try {
      return localStorage.getItem('ds_npc_chatted') === '1';
    } catch {
      return false;
    }
  };
  /** P2-A10: the Journal has been open this visit (the coin hint's until). */
  private journalSeen = false;
  private readonly journalSeenNow = (): boolean => this.journalSeen;

  /** One of main-simple's own unprompted hints: now, or once the guide lets
   *  go; one that comes due inside a room waits for the door (P2-A1). */
  private hintLater(message: string): void {
    if (!this.guideHoldsHints() && !this.scene.isInsideInterior()) {
      this.ui.toast(message, { hint: true });
      return;
    }
    if (!this.heldHints.includes(message)) this.heldHints.push(message);
  }

  /** The guide's frame (FxBudget 'guide'): DOM writes only when it changed. */
  private guideTick(): void {
    const g = this.guide;
    if (!g) return;
    const ui = this.ui;
    if (
      this.guideArmOnPanelsClosed &&
      !ui.isWelcomeVisible() &&
      !ui.panels.isOpen() &&
      !this.tour
    ) {
      this.guideArmOnPanelsClosed = false;
      this.armGuide('cta');
    }
    const f = this._guideFrame;
    f.dt = this.guideDt;
    f.top = ui.panels.current();
    f.blocked =
      f.top !== null ||
      ui.isWelcomeVisible() ||
      ui.isLoadingVisible() ||
      this.tour !== null ||
      this.scene.isInsideInterior();
    const player = this.scene.getPlayer();
    f.walked = 0;
    f.targetDist = null;
    if (player) {
      const p = player.getWorldPositionInto(this._guidePos);
      if (this.guidePrevValid) f.walked = p.distanceTo(this._guidePrev);
      this._guidePrev.copy(p);
      this.guidePrevValid = true;
      if (this.lastCompassTarget) f.targetDist = p.distanceTo(this.lastCompassTarget);
      // a teleport (respawn, a room) is not a walk
      if (f.walked > 0 && f.walked < 5) this.walkedSinceLoad += f.walked;
    }
    f.moveMag = this.guideMoveMag;
    f.yaw = this.scene.getOrbitCamera().getYaw();
    // The recruiter route has the card while it shows: First steps waits
    // behind it like behind a panel, and comes back 600 ms after it goes.
    const route = this.route;
    route?.frame(f.dt, f.blocked);
    if (route?.showing()) f.blocked = true;
    // A finished save still runs its finale (a clock, the pause rules).
    if (g.eligible() || g.running()) {
      g.setCompassLabel(this.compassLabel);
      g.frame(f);
    }
    // The Next chip (P2-A12): what is done is read twice a second, and at
    // once when the first steps end, so the chip follows them within a frame.
    const chip = this.nextChip;
    if (chip) {
      this.goalsT += f.dt;
      const on = g.over() && !route?.showing();
      if (this.goalsT >= 0.5 || on !== this.goalsWereOn) {
        this.goalsT = 0;
        this.syncGoals(on);
      }
      // Walking off folds the list: it is for choosing where to go.
      if (this.guideMoveMag > 0.3) chip.fold();
      chip.frame(f.dt, f.blocked);
      this.goalsPublishT += f.dt;
      if (on && this.goalsPublishT >= 15) this.publishGoals();
    }
    this.renderGuide();
    this.guidePromptT += f.dt;
    if (this.guidePromptT > 0.25) {
      this.guidePromptT = 0;
      this.guideCard?.checkPrompt();
    }
  }

  /**
   * Redraw the card when the guide changed (never per frame otherwise).
   *
   * The card itself is made the first time the guide runs. Before that the
   * page carries no #ds-guide and no 'ds:guide' event: D6 reads either one
   * as "the guide armed" and stands the welcome's compass hint down, and a
   * visit that never arms the guide (Ask the townsfolk, Hiring, a race)
   * still needs that hint.
   */
  private renderGuide(): void {
    const g = this.guide;
    if (!g) return;
    const route = this.route ?? null;
    const chip = this.nextChip ?? null;
    const routeUp = route !== null && route.showing();
    const chipUp = chip !== null && chip.showing();
    if (!this.guideCard && !g.running() && !routeUp && !chipUp) return;
    const card = (this.guideCard ??= this.createGuideCard());
    // One surface at a time on the one card: the recruiter route while it
    // shows, else First steps while it runs, else the Next chip. With none
    // wanted, the one that was up draws its own end (the card goes, and
    // 'ds:guide' says so).
    const want = routeUp ? 'route' : g.running() ? 'steps' : chipUp ? 'next' : null;
    const surface = want ?? this.guideSurface ?? null;
    this.guideSurface = want;
    if (surface === 'route' && route !== null) {
      if (card.version() !== route.version()) card.render(route.view(), route.copy());
      return;
    }
    if (surface === 'next' && chip !== null) {
      if (card.version() !== chip.version()) {
        // the same rule as GuideCard's rows: side by side on a phone or in
        // a short window
        card.render(chip.view(), chip.copy(this.ui.isTouchDevice() || innerHeight <= 500));
      }
      return;
    }
    if (card.version() === g.version()) return;
    const v = g.view();
    const root = document.documentElement;
    card.render(
      v,
      guideCopy(v, {
        touch: this.ui.isTouchDevice(),
        lookMode: root.getAttribute('data-look-mode'),
        runKey: root.getAttribute('data-run-key'),
        compassLabel: this.compassLabel,
        finaleLabel: PASSPORT_META[this.guideFinaleDistrict()].label,
        // P2-A7: with quest lines to say first, E does not open the chat.
        talkQuest:
          v.step === 'talk' &&
          v.talkTarget !== null &&
          this.questLinesFirst(v.talkTarget, this.scene.getCoinsCollected()),
        // '?' is named only where D8's Controls & settings sheet answers it.
        controlsSheet:
          typeof (this.ui as unknown as { showControls?: unknown }).showControls === 'function',
      }),
    );
  }

  /** The finale's 'Show me': Projects until it is stamped, then the nearest
   *  unstamped district, and Projects again once all four are stamped. */
  private guideFinaleDistrict(): PassportZone {
    const passport = this.passport;
    if (!passport || !passport.has('projects')) return 'projects';
    const d = this.compassDistrict;
    if (d && passport.isStampZone(d) && !passport.has(d)) return d as PassportZone;
    return PASSPORT_ZONES.find((z) => !passport.has(z)) ?? 'projects';
  }

  private onGuideButton(id: GuideButton['id']): void {
    const g = this.guide;
    if (!g) return;
    if (id === 'skip') g.skip();
    else if (id === 'resume') g.expand();
    else if (id === 'ok') g.controlsDone();
    else if (id === 'close') g.finish();
    else if (id === 'stay') this.route?.stay();
    else if (id === 'next') this.nextChip?.toggle();
    else if (id.startsWith('goal:')) {
      // A goal's 'Show me', through the same seam (P2-A5).
      const goal = this.nextChip?.pick(id.slice('goal:'.length));
      if (goal) {
        window.dispatchEvent(
          new CustomEvent('ds:guide-to', { detail: { key: goal.guideKey, source: 'next' } }),
        );
      }
    } else if (id.startsWith('route:')) {
      // A stop's 'Show me': the compass goes there through the seam every
      // producer uses (P2-A5), and First steps arms, because a visitor who
      // has only read a card has not been shown how to walk.
      const stop = id.slice('route:'.length);
      if (this.route?.pick(stop)) {
        window.dispatchEvent(
          new CustomEvent('ds:guide-to', { detail: { key: `district:${stop}`, source: 'route' } }),
        );
        this.armGuide('cta');
      }
    } else {
      const key = id === 'school' ? 'school' : `district:${this.guideFinaleDistrict()}`;
      g.finish();
      // The finale's 'Show me' goes through the seam every producer uses
      // (P2-A5): the School leads to its lessons, a district to its door.
      window.dispatchEvent(new CustomEvent('ds:guide-to', { detail: { key, source: 'guide' } }));
    }
    this.renderGuide();
  }

  /** A '1' flag in storage (the one-shot acts refreshCompletion reads too). */
  private storedFlag(key: string): boolean {
    try {
      return localStorage.getItem(key) === '1';
    } catch {
      return false;
    }
  }

  /** What is done on the ladder right now (P2-A12): goal id to done. One
   *  object, refilled twice a second. */
  private goalFacts(): Record<string, boolean> {
    const f = this._goalFacts;
    const passport = this.passport;
    for (const z of PASSPORT_ZONES) f[`stamp:${z}`] = passport?.has(z) ?? false;
    f.hire = this.hireSeen;
    f.talk = this.villagersTalked.size > 0 || this.storedFlag('ds_npc_chatted');
    f.race = this.storedFlag('ds_raced');
    f.catch = this.fishEver || this.fishCaught > 0;
    f.lesson = this.lessons.length > 0;
    f.shop =
      this.shopOpened || this.ownedRod || this.ownedAxe || this.ownedSickle || this.ownedPickaxe;
    f.build = this.ownBuilds.size > 0;
    f.guestbook = this.storedFlag('ds_said_hi');
    const total = this.deliverySystem?.getTotalCount?.() ?? 0;
    f.deliveries =
      this.storedFlag('ds_courier_reward') ||
      (total > 0 && (this.deliverySystem?.getCompletedCount?.() ?? 0) >= total);
    f.crown = this.ownedHats.has('crown');
    return f;
  }

  /**
   * Feed the Next chip what is true now: the done goals, the goal the
   * compass is on (so the chip and the pill name the same district), and the
   * accepted quests. Then find where its goal is, for the compass's last
   * resort. `on`: the first steps are over and the route card is not up.
   */
  private syncGoals(on: boolean): void {
    const chip = this.nextChip;
    if (!chip) return;
    const coins = this.scene.getCoinsCollected();
    if (this.coinsSeen >= 0 && coins > this.coinsSeen) this.coinsEarned += coins - this.coinsSeen;
    this.coinsSeen = coins;
    const quests = this.npcQuests
      .getActiveQuests(coins)
      .map((q) => `${q.giver}: ${q.label} ${q.progress}`);
    const passport = this.passport;
    const preferred =
      passport && !passport.isComplete() ? `stamp:${this.guideFinaleDistrict()}` : null;
    const grew = chip.sync(on, this.goalFacts(), preferred, quests);
    const next = on ? chip.next() : null;
    const hit = next ? resolveGuideKey(next.guideKey, this.guideWorld) : null;
    this.goalTarget = hit
      ? {
          pos: this._goalPos.set(hit.pos.x, hit.pos.y, hit.pos.z),
          label: `${hit.icon} ${hit.label}`,
        }
      : null;
    if (grew || on !== this.goalsWereOn) {
      this.goalsWereOn = on;
      this.publishGoals();
    }
  }

  /**
   * window 'ds:goals' {done, total, next, goals, visit}: the ladder for D's
   * Things to do, and the visit's numbers for the crown's summary (P2-D10).
   * Sent when a goal is done, when the chip comes on, every 15 s while it is
   * on, and as the passport completes.
   */
  private publishGoals(): void {
    const chip = this.nextChip;
    if (!chip) return;
    this.goalsPublishT = 0;
    const started = this.visitStartedAt || performance.now();
    window.dispatchEvent(
      new CustomEvent('ds:goals', {
        detail: {
          ...chip.summary(),
          visit: {
            stamps: this.passport?.count() ?? 0,
            villagers: this.villagersTalked.size,
            coins: this.coinsEarned,
            secrets: this.secrets.count(),
            minutes: Math.round((performance.now() - started) / 60000),
          },
        },
      }),
    );
  }

  /** Assemble every shop/provider/build-spot POI and open the island map.
   *  Picking one sets the compass (mapGuideTarget — top of the chain). */
  private openIslandMap(): void {
    this.guide?.complete('compass');
    const pois: Array<{ icon: string; label: string; pos: THREE.Vector3; color?: string }> = [];
    const add = (icon: string, label: string, pos: THREE.Vector3 | null, color?: string): void => {
      if (pos) pois.push({ icon, label, pos, color });
    };
    // A district pick ends at the district's door: remember which POIs are districts.
    const zoneOf = new Map<object, string>();
    for (const z of this.scene.getZonesManager().getZones()) {
      // Real district identity, not five identical 🏛️: the passport icon the
      // rest of the app already uses, haloed in the district's own accent
      // (same single source of truth as the radar beacons and plaza tints).
      const meta = (PASSPORT_META as Record<string, { icon: string }>)[z.id];
      const d = DISTRICTS.find((x) => x.id === z.id);
      const before = pois.length;
      add(
        meta?.icon ?? '🏝️',
        z.name,
        z.getPosition(),
        d ? `#${d.color.toString(16).padStart(6, '0')}` : undefined,
      );
      if (pois.length > before) zoneOf.set(pois[before], String(z.id));
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
    this.ui.showIslandMap(
      pois,
      (poi) => {
        this.setMapPick(
          new THREE.Vector3(poi.pos.x, poi.pos.y, poi.pos.z),
          `${poi.icon} ${poi.label}`,
          zoneOf.get(poi) ?? null,
        );
        this.compassSetToast(`🧭 Compass set: ${poi.icon} ${poi.label}`);
        track('map_guide_set', { label: poi.label, source: 'map' });
      },
      {
        playerPos: this.scene.getPlayer()?.getWorldPosition() ?? null,
        playerFwd: this.scene.getOrbitCamera().getForwardDirection(),
        // Halo the pill's current target so map and pill visibly agree.
        targetPos: this.lastCompassTarget,
      },
    );
  }

  // \u2500\u2500 Tour mode: skippable cinematic rail (welcome CTA / ?tour=1) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  // A9: each leg's flight time comes from legDuration (Framing.tourLegDuration),
  // and the dwell is Framing.TOUR_DWELL_S (4.0 s, the plan's floor; was 6.0).

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
    const stops: TourStop[] = [];
    const addStop = (
      p: THREE.Vector3 | null | undefined,
      caption: string,
      alt: number,
      back: number,
      villagers?: readonly string[],
    ) => {
      if (!p) return;
      const stop: TourStop = {
        caption,
        look: new THREE.Vector3(),
        dir: new THREE.Vector3(),
        r: 0,
        alt,
        back,
        villagers,
      };
      this.frameTourStop(stop, p);
      stops.push(stop);
    };
    // Counted from the client roster (AI_NPCS), never typed into a caption.
    const aiCount = Object.keys(AI_NPCS).length;
    // Villager stops name a preference order, then the whole AI roster as a
    // fallback, so an awake villager is almost always on hand to frame.
    const villagerStop = (preferred: string[]): [THREE.Vector3 | null, string[]] => {
      const names = [...preferred, ...Object.keys(AI_NPCS)];
      const who = this.tourVillager(names);
      return [who ? this.scene.getNpcPosition(who) : null, names];
    };
    const [storyteller, storytellerNames] = villagerStop(['Storyteller', 'Gardener']);
    const [gardener, gardenerNames] = villagerStop(['Gardener', 'Guard']);
    if (recruiter) {
      // RECRUITER MODE \u2014 the short play-to-hire path (the deep-dive
      // critic's top flag: nothing routed a visitor from playing to hiring).
      // Four punchy stops, shorter dwell, and it ENDS on the hire card.
      addStop(
        zones.get('welcome'),
        'Abbas Ali \u2014 AI & software engineer, Melbourne. This whole planet is his hand-built portfolio.',
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
        storyteller,
        `${aiCount} villagers talk through Claude Haiku 4.5, with a voice \u2014 planned each morning.`,
        6.5,
        9,
        storytellerNames,
      );
      addStop(
        zones.get('contact'),
        "That's the short version \u2014 next: his CV, experience and contact details.",
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
      // P2-A13 (C8 hand-off): the stop frames the work sites, not the hall.
      const sites = this.workSitesCentre();
      addStop(
        sites ?? zones.get('projects'),
        'The Projects District \u2014 this island, RankPilot (pre-launch), Bano\u2019s Cookbook and more.',
        sites ? SimpleApp.SITES_TOUR_ALT : 9.5,
        sites ? SimpleApp.SITES_TOUR_BACK : 14,
      );
      addStop(
        gardener,
        `${aiCount} townsfolk talk through Claude Haiku 4.5 \u2014 planned each morning, reported on nightly.`,
        // High enough to clear tree canopies \u2014 NPC positions are live, so a low
        // camera is occlusion roulette (a prod capture found a tree filling it).
        6.5,
        9,
        gardenerNames,
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
    // A9: 'Stop n of m · ' is baked in once the stops are known.
    for (let i = 0; i < stops.length; i++) {
      stops[i].caption = tourCaption(i + 1, stops.length, stops[i].caption);
    }
    track(recruiter ? 'recruit_tour_start' : 'tour_start');
    const cam = this.scene.getCamera();
    this.scene.setCameraSuspended(true);
    this.ui.hideInteractionPrompt();
    // A9: the first leg leaves from the orbit camera's own look target, so
    // its first frame turns nothing (it was seeded at the player's feet).
    const fromLook = stops[0].look.clone();
    if (this.scene.getPlayer()) {
      this.scene.getOrbitCamera().getFollowPose(this._tourFromPos, fromLook);
    }
    this.tour = {
      stops,
      idx: 0,
      t: 0,
      phase: 'fly',
      fromDir: cam.position.clone().normalize(),
      fromR: Math.max(cam.position.length(), 20),
      fromLook,
      held: null,
      legS: 0,
      fromView: new THREE.Vector3(),
      fromQuat: cam.quaternion.clone(),
    };
    this.holdTourVillager(stops[0]);
    this.tour.legS = this.legDuration(this.tour, stops[0]);
    this.ui.showTourOverlay(() => this.endTour(true));
    // The opening caption shows at once (it introduces the whole planet);
    // every later caption swaps in on LANDING (landTourStop).
    this.ui.setTourCaption(stops[0].caption);
  }

  /** Place the camera for a stop that studies surface point `p`, set back
   *  along the default tangent turned `turn` radians about the local up. */
  private frameTourStop(stop: TourStop, p: THREE.Vector3, turn = 0): void {
    const up = p.clone().normalize();
    const tan = new THREE.Vector3(0, 1, 0).cross(up);
    if (tan.lengthSq() < 0.05) tan.set(1, 0, 0).cross(up);
    tan.normalize();
    if (turn) tan.applyAxisAngle(up, turn);
    const camPos = p.clone().addScaledVector(up, stop.alt).addScaledVector(tan, stop.back);
    stop.look.copy(p).addScaledVector(up, 1.4);
    stop.dir.copy(camPos).normalize();
    stop.r = camPos.length();
  }

  /**
   * An AI villager (one of AI_NPCS, never one of the 4 scripted ones) is
   * visible within `radius` of the player. Gates the one-time talk hint, which
   * says the villager talks through Claude Haiku 4.5. A villager indoors (asleep,
   * or vanished at a hold) has a hidden mesh, so `meshRef.visible` keeps the
   * hint from pointing at someone the visitor cannot see.
   */
  private aiVillagerWithin(radius: number): boolean {
    const p = this.scene.getPlayer()?.getWorldPositionInto(this._hintPos);
    if (!p) return false;
    const targets = this.scene.getIsland().npcTargets;
    return targets.some(
      (n) => isAiNpc(n.name) && n.meshRef.visible && n.meshRef.position.distanceTo(p) < radius,
    );
  }

  /**
   * First of `names` who is up and about. Asleep villagers are hidden indoors,
   * and one walking to bed vanishes the moment a hold stops it; falls back to
   * any villager with a position.
   */
  private tourVillager(names: readonly string[]): string | null {
    const targets = this.scene.getIsland().npcTargets;
    for (const n of names) {
      const t = targets.find((x) => x.name === n);
      if (t?.meshRef.visible && this.scene.getNpcActivity(n) !== 'sleep') return n;
    }
    return names.find((n) => this.scene.getNpcPosition(n)) ?? null;
  }

  /**
   * At the START of the leg to a villager stop: re-read where the villager is
   * now and hold them there for the flight and the dwell. The stop used to
   * keep the position read when the tour began, ~20 s earlier, so the camera
   * landed on wherever the villager had been (a prod capture: a parked car and
   * trees under a caption about villagers).
   */
  private holdTourVillager(stop: TourStop): void {
    const tour = this.tour;
    if (!tour || !stop.villagers) return;
    const who = this.tourVillager(stop.villagers);
    const p = who ? this.scene.getNpcPosition(who) : null;
    if (!who || !p) return; // keep the start-of-tour framing
    this.frameTourStop(stop, p, this.clearTourBearing(stop, p));
    // Never take over a real conversation's hold (none can start mid-tour,
    // but the slot is shared).
    if (!this.npcDialogueName) {
      this.scene.setNpcDialogueHold(who);
      tour.held = who;
    }
  }

  /**
   * A bearing (turn about the villager's up) whose camera can SEE the
   * villager. Villagers stand among buildings and trees, and one fixed
   * bearing parked the camera behind them: SEEN in a capture, the held
   * Storyteller dead centre in the frame and hidden by an office block.
   * Tries eight bearings against the chase camera's own view-blocker list
   * (terrain + every mesh big enough to block a view ray; it ray-tests that
   * list every frame, so eight rays once per leg cost nothing).
   */
  private clearTourBearing(stop: TourStop, p: THREE.Vector3): number {
    // Private on OrbitCamera; read here rather than widening its API.
    const blockers = (this.scene.getOrbitCamera() as unknown as { collisionMeshes?: THREE.Mesh[] })
      .collisionMeshes;
    if (!blockers?.length) return 0;
    const probe: TourStop = { ...stop, look: new THREE.Vector3(), dir: new THREE.Vector3() };
    const camPos = new THREE.Vector3();
    const toCam = new THREE.Vector3();
    for (let k = 0; k < 8; k++) {
      const turn = (k * Math.PI) / 4;
      this.frameTourStop(probe, p, turn);
      camPos.copy(probe.dir).multiplyScalar(probe.r);
      toCam.subVectors(camPos, probe.look);
      const dist = toCam.length();
      this._tourRay.set(probe.look, toCam.divideScalar(dist));
      this._tourRay.near = 0.5; // clear of the villager's own head
      this._tourRay.far = dist;
      if (this._tourRay.intersectObjects(blockers, false).length === 0) return turn;
    }
    return 0; // every bearing blocked: keep the default framing
  }

  /** Let the tour's villager walk on again. */
  private releaseTourVillager(): void {
    const tour = this.tour;
    if (!tour?.held) return;
    if (!this.npcDialogueName) this.scene.setNpcDialogueHold(null);
    tour.held = null;
  }

  /**
   * A9: the leg about to fly to `stop`: its arc round the planet sets the
   * time (Framing.tourLegDuration), lengthened when the view would turn
   * faster than 120 deg/s at the ease's peak. Seeds the leg's first view.
   */
  private legDuration(tour: NonNullable<SimpleApp['tour']>, stop: TourStop): number {
    const arcDeg = THREE.MathUtils.radToDeg(tour.fromDir.angleTo(stop.dir));
    const fromPos = this._tourFromPos.copy(tour.fromDir).multiplyScalar(tour.fromR);
    const viewA = this._tourViewA.subVectors(tour.fromLook, fromPos);
    tour.fromView.copy(viewA).normalize();
    const viewB = this._tourViewB.copy(stop.dir).multiplyScalar(stop.r);
    viewB.subVectors(stop.look, viewB);
    const turnDeg =
      viewA.lengthSq() > 1e-9 && viewB.lengthSq() > 1e-9
        ? THREE.MathUtils.radToDeg(viewA.angleTo(viewB))
        : 0;
    return tourLegDuration(arcDeg, turnDeg);
  }

  /** A9: the first leg's rise (+3 u over 0.5 s, gone by landing); 0 on later legs. */
  private firstLegLift(tour: NonNullable<SimpleApp['tour']>, e: number): number {
    return tour.idx === 0 ? tourFirstLegLift(tour.t, e) : 0;
  }

  /** The camera has arrived: start the dwell and show THIS stop's caption.
   *  Swapping it at take-off described the next stop for the whole flight. */
  private landTourStop(): void {
    const tour = this.tour;
    if (!tour) return;
    tour.phase = 'dwell';
    tour.t = 0;
    if (tour.idx > 0) this.ui.setTourCaption(tour.stops[tour.idx].caption);
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
        this.landTourStop();
        return;
      }
      const k = Math.min(1, tour.t / tour.legS);
      const e = easeInOutSine(k);
      this.slerpDirs(this._tourDir, tour.fromDir, stop.dir, e);
      // Altitude hop: arcing over the terrain beats a chord that dips through it
      // (A9: the first leg also lifts 3 u over its first 0.5 s, firstLegLift).
      const r =
        tour.fromR +
        (stop.r - tour.fromR) * e +
        Math.sin(Math.PI * e) * 7 +
        this.firstLegLift(tour, e);
      cam.position.copy(this._tourDir).multiplyScalar(r);
      // MOT-06: the ORIENTATION slerps from the camera's own at take-off to
      // the stop's dwell pose (lookAt with the dwell's up), so both seams are
      // continuous and the turn per frame is the leg's turn under the ease.
      // Slerping the view direction and re-deriving it with lookAt spun the
      // camera ~10 deg/frame where the view passed the nadir (leg 1, 178 deg
      // from the radial), because lookAt's yaw is undefined straight down.
      // The slerp runs in a frame carried round the planet with the camera
      // (arc = fromDir -> stop.dir, eased like the position), so the horizon
      // stays near level mid-flight instead of rolling by the leg's arc.
      this.tourStopQuat(this._tourToQuat, stop);
      const arc = this._tourArcQ.setFromUnitVectors(tour.fromDir, stop.dir);
      this._tourToQuat.premultiply(this._tourQ.copy(arc).invert());
      cam.quaternion.slerpQuaternions(tour.fromQuat, this._tourToQuat, e);
      cam.quaternion.premultiply(this._tourQ.identity().slerp(arc, e));
      cam.up.copy(this._tourUp.copy(stop.look).normalize());
      if (k >= 1) this.landTourStop();
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
      if (tour.t >= TOUR_DWELL_S) this.advanceTourStop();
    }
  }

  /** MOT-06: the orientation the dwell gives `stop` (camera at stop.dir × r, looking at stop.look, up = the look point's radial). */
  private tourStopQuat(out: THREE.Quaternion, stop: TourStop): void {
    const eye = this._tourLook.copy(stop.dir).multiplyScalar(stop.r);
    const up = this._tourViewB.copy(stop.look).normalize();
    this._tourMat.lookAt(eye, stop.look, up);
    out.setFromRotationMatrix(this._tourMat);
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
    this.releaseTourVillager();
    tour.idx += 1;
    tour.phase = 'fly';
    tour.t = 0;
    tour.fromDir.copy(cam.position).normalize();
    tour.fromR = cam.position.length();
    tour.fromLook.copy(prev.look);
    tour.fromQuat.copy(cam.quaternion);
    // The caption stays on the stop being left until the camera lands.
    this.holdTourVillager(tour.stops[tour.idx]);
    tour.legS = this.legDuration(tour, tour.stops[tour.idx]);
  }

  private endTour(skipped: boolean): void {
    if (!this.tour) return;
    this.releaseTourVillager();
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
      // The play-to-hire path CONVERTS: the highlights end on the hire card
      // (CV, experience, LinkedIn, email), not on an empty meadow — and not
      // on the old client-services contact pitch. When that card closes the
      // recruiter route takes over (P2-A4): the tour used to end on 20 s of
      // nothing.
      this.hireCardSource = 'tour';
      this.ui.showHireCard('cta');
      return;
    }
    // The full tour hands over to the guide, headed 'The island is yours'
    // (A6); with the guide done, the old line.
    if (!recruiter && this.armGuide('tour')) return;
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
    /** The pose the release glide starts from (its first frame sets it). */
    from: { pos: THREE.Vector3; look: THREE.Vector3; up: THREE.Vector3; fov: number } | null;
    /** A9: seconds since the push-in began (its ease-in ramp). */
    age: number;
  } | null = null;
  /** A9: the push-in's rates ramp in over this long, so its first frame turns almost nothing. */
  private static readonly NPC_CINE_RAMP_S = 0.6;
  /** The release glide's length: the old 0.35 s whip-panned the last frame (w2 integration). */
  private static readonly NPC_CINE_RELEASE_S = 0.6;
  private readonly _cineGoalPos = new THREE.Vector3();
  private readonly _cineGoalLook = new THREE.Vector3();
  private readonly _cineOffA = new THREE.Vector3();
  private readonly _cineOffB = new THREE.Vector3();
  private readonly _cineQuat = new THREE.Quaternion();
  private readonly _cineQuatId = new THREE.Quaternion();
  private readonly _cineQuatTo = new THREE.Quaternion();
  private readonly _cineNormal = new THREE.Vector3();
  /** The surface normal under the player: the orbit camera's up. */
  private cineNormal(): THREE.Vector3 {
    const p = this.scene.getPlayer();
    return p ? p.getSurfaceNormalInto(this._cineNormal) : this._cineNormal.copy(this.camera0Up);
  }
  private readonly camera0Up = new THREE.Vector3(0, 1, 0);
  private chatWalkAwayT = 0; // sustained walk intent closes the chat
  private watchOpenedAt = 0; // wall-screen open time — same-press close guard
  private isletUnlocked = false; // beach-house door code accepted this session
  private readonly _cineUp = new THREE.Vector3();
  private readonly _cineAxis = new THREE.Vector3();
  private readonly _cineSide = new THREE.Vector3();
  private readonly _cineDesired = new THREE.Vector3();
  private readonly _cineLookT = new THREE.Vector3();
  private readonly _cineTmp = new THREE.Vector3();

  /**
   * E on a villager: the shop for the Market Vendor, a quest step or the
   * quest lines first where there are any (questLinesFirst), then the chat
   * for a villager who talks through Claude Haiku 4.5, else their own lines.
   */
  private onNpcInteract(npcData: { name: string; dialogue: string[] }): void {
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
    // A reminder or a thank-you ('status') is not a step: it shows once a
    // session, and after that E opens the chat (P2-A7). A quest giver who
    // talks through Claude Haiku 4.5 used to answer every press with the
    // same written line for the rest of the visit, quest done or not.
    const coins = this.scene.getCoinsCollected();
    const talk = this.questLinesFirst(npcData.name, coins)
      ? this.npcQuests.onTalk(npcData.name, coins)
      : null;
    if (talk) {
      this.questLinesShown.add(npcData.name);
      this.guide?.complete('talk');
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
        this.scene.floatCoinsAtPlayer(q.rewardCoins);
        this.scene.logTransaction('Quest reward', q.rewardCoins);
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
      this.openVillagerChat(npcData);
      return;
    }
    // Non-AI, non-quest NPC → canned dialogue, led by a living-world mood line.
    let lines = npcData.dialogue;
    const flavor = moodNpcFlavor();
    if (flavor) lines = [flavor, ...lines];
    this.ui.showDialogue(npcData.name, lines);
    this.beginNpcDialogue(npcData.name);
  }

  /**
   * The free-text conversation with a villager who talks through Claude
   * Haiku 4.5. On ANY failure (function, App Check, rate or spend cap,
   * moderation, offline) askNpc returns a fallback and the villager cycles
   * their authored lines, so they never appear broken.
   */
  private openVillagerChat(npcData: { name: string; dialogue: string[] }): void {
    this.aiGuideTarget = null; // meet-the-townsfolk guide fulfilled
    this.markDone('ds_npc_chatted');
    this.guide?.complete('talk');
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
        this.learnLesson('chat');
        const res = await askNpc(npcData.name, text);
        if (res.reply && !res.fallback) return res.reply;
        // A written line stands in (askNpc counted it as npc_fallback),
        // so the header stops promising a generated reply.
        this.ui.markNpcChatOffline(npcData.name);
        return canned[ci++ % canned.length] ?? '…';
      },
      voiceProfileFor(npcData.name),
    );
    this.beginNpcDialogue(npcData.name);
    try {
      // Found the feature themselves — the discovery hint would only
      // teach what they already know.
      localStorage.setItem('ds_hint_talk', '1');
    } catch {
      /* no storage */
    }
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
  }

  /** Villagers whose quest lines have shown this session (P2-A7). */
  private readonly questLinesShown = new Set<string>();

  /**
   * Does E on this villager open quest dialogue (true), or go on to the chat
   * or their ambient lines (false)? A step always does: a request to accept,
   * a pickup, a delivery, a completion. A reminder or a thank-you does once a
   * session for a villager who talks through Claude Haiku 4.5; one of the
   * scripted few has nothing else to say, so theirs always shows.
   */
  private questLinesFirst(name: string, coins: number): boolean {
    const kind = this.npcQuests.talkKind(name, coins);
    if (kind === null) return false;
    if (kind !== 'status') return true;
    return !(isAiNpc(name) && this.questLinesShown.has(name));
  }

  private beginNpcDialogue(name: string): void {
    this.villagersTalked.add(name); // the visit's count, and a rung-2 goal (P2-A12)
    this.npcDialogueName = name;
    this.chatWalkAwayT = 0;
    this.trailDone = true; // talking to a villager is what the trail was for
    this.scene.setNpcDialogueHold(name);
    // The camera push-in is optional flavor on top of the hold: skip it under
    // reduced motion, during the tour, or when another rail (postcard hold /
    // an ending cine) already owns the suspended camera.
    if (this.tour || this.npcCine || a11y.reducedMotion || this.scene.isCameraSuspended()) return;
    const cam = this.scene.getCamera();
    const player = this.scene.getPlayer();
    if (!cam || !player) return;
    // A9: the push-in starts on the orbit camera's own pose and look target
    // (lookAhead and the chest offset included), not the player's feet: the
    // first frame turned 11.8 deg when the look was seeded at the root.
    const pos = new THREE.Vector3();
    const look = new THREE.Vector3();
    this.scene.getOrbitCamera().getFollowPose(pos, look);
    this.npcCine = {
      name,
      pos,
      look,
      prevFov: cam.fov,
      ending: -1,
      from: null,
      age: 0,
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
      // A9: the rates ramp in (smoothstep over NPC_CINE_RAMP_S), so the
      // first frame leaves the orbit camera's pose almost untouched; it
      // turned 12 deg when the push-in started at full rate from the feet.
      c.age += dt;
      const ru = Math.min(1, c.age / SimpleApp.NPC_CINE_RAMP_S);
      const ramp = ru * ru * (3 - 2 * ru);
      expDecayV3(c.pos, desired, 1.5 * ramp, dt);
      expDecayV3(c.look, desiredLook, 2.1 * ramp, dt);
      cam.fov = expDecay(cam.fov, c.prevFov - 8, 1.3 * ramp, dt);
      cam.updateProjectionMatrix();
    } else {
      // Release glide (w2 integration): the camera glides ONTO the orbit
      // camera's follow pose (position, look target, up and FOV), so the
      // resume frame's lookAt turns nothing. It used to ease only the look
      // toward the player for 0.35 s and leave the rest to the resume, whose
      // lookAt snapped onto the orbit target: 15 deg in one frame on main,
      // and 50-112 deg when the follow sat on the far side, the position ease
      // then swinging the camera past the avatar's head. The follow is first
      // turned to the two-shot's side (adoptView), and the offset turns about
      // the look target, so the path never cuts through the avatar.
      const oc = this.scene.getOrbitCamera();
      if (!c.from) {
        if (playerPos) oc.adoptView(c.pos);
        c.from = { pos: c.pos.clone(), look: c.look.clone(), up: cam.up.clone(), fov: cam.fov };
      }
      c.ending += dt;
      const f = c.from;
      const u = Math.min(1, c.ending / SimpleApp.NPC_CINE_RELEASE_S);
      const k = u * u * (3 - 2 * u); // smoothstep: no step at either end
      if (u >= 1 || !playerPos) {
        cam.fov = c.prevFov; // exact restore \u2014 updateFov may never run (pre-ride)
        cam.updateProjectionMatrix();
        if (playerPos) {
          oc.getFollowPose(this._cineGoalPos, this._cineGoalLook);
          cam.position.copy(this._cineGoalPos);
          cam.up.copy(this.cineNormal());
          cam.lookAt(this._cineGoalLook);
        }
        this.scene.setCameraSuspended(false);
        this.npcCine = null;
        return;
      }
      oc.getFollowPose(this._cineGoalPos, this._cineGoalLook);
      c.look.lerpVectors(f.look, this._cineGoalLook, k);
      // The offset from the look target: its direction slerps, its length lerps.
      const offA = this._cineOffA.subVectors(f.pos, f.look);
      const offB = this._cineOffB.subVectors(this._cineGoalPos, this._cineGoalLook);
      const lenA = offA.length();
      const lenB = offB.length();
      if (lenA > 1e-6 && lenB > 1e-6) {
        offA.divideScalar(lenA);
        offB.divideScalar(lenB);
        // The full turn, then k of it (slerpQuaternions copies its first
        // argument into the target first, so the two must not alias).
        this._cineQuatTo.setFromUnitVectors(offA, offB);
        this._cineQuat.slerpQuaternions(this._cineQuatId, this._cineQuatTo, k);
        offA.applyQuaternion(this._cineQuat).multiplyScalar(lenA + (lenB - lenA) * k);
        c.pos.copy(c.look).add(offA);
      } else {
        c.pos.lerpVectors(f.pos, this._cineGoalPos, k);
      }
      cam.fov = f.fov + (c.prevFov - f.fov) * k;
      cam.updateProjectionMatrix();
      cam.position.copy(c.pos);
      cam.up.lerpVectors(f.up, this.cineNormal(), k).normalize();
      cam.lookAt(c.look);
      return;
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
    this.raceGuideViaCar = true;
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
    // P2-A9: new stamps pay +5 each (the cadence and every flag site land here).
    this.payStamps();
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
   * P2-A6: after a sale or a purchase, vendor `id` ignores E for 1.0 s, so a
   * double press never sells and then buys (the canteen) or reopens the shop
   * just closed (the kiosk).
   */
  private lockVendor(id: string): void {
    this.vendorLockUntil.set(id, performance.now() + SimpleApp.VENDOR_LOCK_MS);
  }

  /** P2-A6: E pressed at vendor `id` and not swallowed by its lock. */
  private vendorPress(id: string): boolean {
    if (!this.inputManager.consumeKeyPress('e')) return false;
    return performance.now() >= (this.vendorLockUntil.get(id) ?? 0);
  }

  /**
   * A13: may a first-use hint show now? Never under a panel, never indoors,
   * never on a tour, the welcome card or a conversation, and never while
   * the First steps card or the Next chip's list is out.
   */
  private hintsQuiet(): boolean {
    return (
      this.racing ||
      this.ui.panels.isOpen() ||
      this.ui.isWelcomeVisible() ||
      this.scene.isInsideInterior() ||
      this.tour !== null ||
      this.npcCine !== null ||
      (this.guide?.isActive() ?? false) ||
      (this.nextChip?.isExpanded() ?? false)
    );
  }

  /** A13: hints already shown on this device (mirrors ds_hint_* in localStorage). */
  private readonly hintsShown = new Set<string>();

  /**
   * A13: show hint `id` once per device (ds_hint_<id>), in the visitor's
   * scheme: '[Key]' tokens on a keyboard (D7 renders them as keycaps), the
   * touch words on a phone. Returns true when it showed.
   */
  private maybeHint(id: string, keys: string, touch: string): boolean {
    if (this.hintsShown.has(id) || this.hintsQuiet()) return false;
    const key = `ds_hint_${id}`;
    try {
      if (localStorage.getItem(key)) {
        this.hintsShown.add(id);
        return false;
      }
      localStorage.setItem(key, '1');
    } catch {
      /* no storage: show it this session only */
    }
    this.hintsShown.add(id);
    this.ui.toast(this.ui.isTouchDevice() ? touch : keys, { hint: true });
    return true;
  }

  /** A13: seconds of walking without running (the run hint waits for 3). */
  private walkHeldS = 0;
  /** A13: the encounter scans run at about 3 Hz, not every frame. */
  private hintScanIn = 0;

  /**
   * A13: free walk's hints. Run after 3 s of walking without running, swim
   * the first time the visitor swims, and the first time a shore, a tree or
   * a free build stake is within 6 u.
   */
  private updateFirstHints(
    dt: number,
    player: { isInWater(): boolean; isRunning(): boolean; isSwimming(): boolean },
  ): void {
    if (this.hintsShown.size >= 6) return;
    const walking = this.guideMoveMag > 0.3 && !player.isInWater() && !player.isRunning();
    this.walkHeldS = walking ? this.walkHeldS + dt : 0;
    if (this.walkHeldS >= 3) {
      if (SimpleApp.LEGACY_RUN) {
        this.maybeHint(
          'run',
          'Hold [Space] while moving to run.',
          'Hold JUMP while moving to run.',
        );
      } else {
        this.maybeHint('run', 'Hold [Shift] to run.', 'Push the stick to the edge to run.');
      }
    }
    if (player.isSwimming()) {
      this.maybeHint(
        'swim',
        'Hold [Space] to stay afloat; hold [Shift] to dive.',
        'Hold JUMP to stay afloat; hold DIVE to dive.',
      );
    }
    this.hintScanIn -= dt;
    if (this.hintScanIn > 0 || this.hintsQuiet()) return;
    this.hintScanIn = 0.33;
    if (!this.hintsShown.has('fish') && this.scene.canCastHere()) {
      this.maybeHint(
        'fish',
        this.ownedRod
          ? '🎣 A shore: press [E] to cast, and reel when the float dips.'
          : '🎣 A shore: with a rod from the shop, press [E] here to cast.',
        this.ownedRod
          ? '🎣 A shore: tap USE to cast, and reel when the float dips.'
          : '🎣 A shore: with a rod from the shop, tap USE here to cast.',
      );
    }
    if (!this.hintsShown.has('chop') && this.scene.nearestChoppableTree(6) !== null) {
      this.maybeHint(
        'chop',
        this.ownedAxe
          ? '🪓 A tree: press [E] beside it to chop.'
          : '🪓 A tree: with an axe from the shop, press [E] beside it to chop.',
        this.ownedAxe
          ? '🪓 A tree: tap USE beside it to chop.'
          : '🪓 A tree: with an axe from the shop, tap USE beside it to chop.',
      );
    }
    if (!this.hintsShown.has('build')) {
      const b = this.nearestBuildOpportunity();
      if (b && !b.own && b.dist <= 6) {
        this.maybeHint(
          'build',
          '🔨 A build stake: press [E] at it to build.',
          '🔨 A build stake: tap USE at it to build.',
        );
      }
    }
  }

  /**
   * A11: a lesson's toast, in the scheme the visitor plays with. Lesson 1
   * names Shift on desktop and the stick on touch (touchifyPlain does not
   * map Shift); under ?legacyrun=1 it names the old hold-Space run.
   */
  private lessonCopy(lesson: [string, string]): string {
    if (lesson[0] !== 'move') return lesson[1];
    if (this.ui.isTouchDevice()) {
      return SimpleApp.LEGACY_RUN
        ? '🏃 Lesson 1 — the joystick to walk, JUMP to jump, hold JUMP while moving to run. The island is round: keep walking and you come home.'
        : '🏃 Lesson 1 — the joystick to walk, JUMP to jump, push the stick to the edge to run. The island is round: keep walking and you come home.';
    }
    return SimpleApp.LEGACY_RUN
      ? '🏃 Lesson 1 — WASD to walk, Space to jump, hold Space while moving to run. The island is round: keep walking and you come home.'
      : lesson[1];
  }

  /**
   * A11: is the visitor asking to run this frame? Shift held on land, or on
   * touch the stick at 0.95 or more for 250 ms. Under ?legacyrun=1, the old
   * hold-Space (and hold-JUMP) run. The caller adds the runMag > 0.3 gate.
   */
  private runIntent(
    jumpInput: boolean,
    joy: { forward: number; strafe: number },
    inWater: boolean,
  ): boolean {
    if (SimpleApp.LEGACY_RUN) return jumpInput;
    const now = performance.now();
    if (Math.hypot(joy.forward, joy.strafe) >= SimpleApp.STICK_RUN_MAG) {
      if (this.stickRimSince < 0) this.stickRimSince = now;
    } else {
      this.stickRimSince = -1;
    }
    const stickRun = this.stickRimSince >= 0 && now - this.stickRimSince >= SimpleApp.STICK_RUN_MS;
    return !inWater && (this.inputManager.getRunInput() || stickRun);
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
    this.shopOpened = true; // a rung-2 goal (P2-A12)
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
            sfx.spend();
            this.scene.logTransaction('Bought axe', -SimpleApp.AXE_PRICE);
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
            sfx.spend();
            this.scene.logTransaction('Bought sickle', -SimpleApp.SICKLE_PRICE);
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
            sfx.spend();
            this.scene.logTransaction('Bought pickaxe', -SimpleApp.PICKAXE_PRICE);
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
            sfx.spend();
            this.scene.logTransaction('Bought rod', -SimpleApp.ROD_PRICE);
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
            sfx.spend();
            this.scene.logTransaction('Bird feed', -SimpleApp.BIRD_FEED_PRICE);
            track('bird_feed_bought', { charges: this.birdFeed });
            render();
            return;
          }
          if (id === SimpleApp.CAT_FEED_ID) {
            if (!this.scene.spendCoins(SimpleApp.CAT_FEED_PRICE)) return;
            this.catFeed += SimpleApp.CAT_FEED_CHARGES;
            this.persistCatFeed();
            this.refreshFeedHud();
            sfx.spend();
            this.scene.logTransaction('Cat feed', -SimpleApp.CAT_FEED_PRICE);
            track('cat_feed_bought', { charges: this.catFeed });
            render();
            return;
          }
          if (id === SimpleApp.FISH_FEED_ID) {
            if (!this.scene.spendCoins(SimpleApp.FISH_FEED_PRICE)) return;
            this.fishFeed += SimpleApp.FISH_FEED_CHARGES;
            this.persistFishFeed();
            this.refreshFeedHud();
            sfx.spend();
            this.scene.logTransaction('Fish feed', -SimpleApp.FISH_FEED_PRICE);
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
            sfx.spend();
            this.scene.logTransaction(`Bought ${key}`, -price);
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
            sfx.spend();
            this.scene.logTransaction(`Bought ${item.name}`, -item.price);
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
          // P2-A14: the camera comes round to the front so the hat shows.
          this.scene.getOrbitCamera().setMirrorPose(true);
          render();
        },
        () => {
          // The follow pose returns with the shop's close (P2-A14).
          this.scene.getOrbitCamera().setMirrorPose(false);
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
    // LOCAL date, not toISOString() (which is UTC): the cap is meant to reset at
    // the player's own midnight. toISOString reset it at UTC midnight — ~10-11am
    // in Melbourne — so an evening + next-morning session read as the same day.
    const d = new Date();
    const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
      d.getDate(),
    ).padStart(2, '0')}`;
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
    const MAX_OP = 500; // matches the per-op cap in functions/src/vault.ts
    const render = (balance: number): void => {
      const pocket = this.scene.getCoinsCollected();
      // Amount-parametrized so the same server-ack discipline backs the fixed
      // step AND the new "all" buttons: deposit charges local-first + refunds on
      // non-ack; withdraw credits only on applied ack; both idempotency-keyed.
      const doDeposit = (amount: number) => async (): Promise<void> => {
        if (this.vaultBusy) return;
        if (amount <= 0) {
          this.ui.toast('🪙 Nothing in your pocket to deposit.');
          return;
        }
        if (!this.scene.spendCoins(amount)) {
          this.ui.toast(`🪙 You need ${amount} coins on you to deposit.`);
          return;
        }
        this.vaultBusy = true;
        const r = await vaultOp('deposit', amount);
        this.vaultBusy = false;
        if (!r || !r.applied) {
          this.scene.addCoins(amount); // refund — the vault never took it
          this.ui.toast('🏦 "Hm, the ledger jammed. Your coins are safe."');
          return;
        }
        sfx.spend();
        this.scene.floatCoinsAtPlayer(amount, true);
        this.scene.logTransaction('Vault deposit', -amount);
        track('vault_deposit', { amount, balance: r.balance });
        render(r.balance);
      };
      const doWithdraw = (amount: number) => async (): Promise<void> => {
        if (this.vaultBusy) return;
        if (amount <= 0) {
          this.ui.toast('🏦 "Your vault is empty."');
          return;
        }
        this.vaultBusy = true;
        const r = await vaultOp('withdraw', amount);
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
        this.scene.addCoins(amount); // credit ONLY on ack
        this.scene.floatCoinsAtPlayer(amount);
        this.scene.logTransaction('Vault withdraw', amount);
        sfx.coin();
        track('vault_withdraw', { amount, balance: r.balance });
        render(r.balance);
      };
      this.ui.showVaultPanel(balance, pocket, step, {
        deposit: doDeposit(step),
        withdraw: doWithdraw(step),
        depositAll: doDeposit(Math.min(pocket, MAX_OP)),
        withdrawAll: doWithdraw(Math.min(balance, MAX_OP)),
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
    this.learnLesson('build');
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

  // ── Work-site landmarks (P2-A13) ────────────────────────────────────
  /** The Projects card each construction_<i> site opens, in WORK_SITES
   *  order (SignPainter.PROJECT_BOARDS names the same five). */
  private static readonly LANDMARK_ANCHORS = ['rankpilot', 'chocomate', 'island', 'banos', 'insta'];
  private static readonly LANDMARK_U = 3.5;
  /** The five sites' world positions, read once (they never move). */
  private landmarkSites: Array<THREE.Vector3 | null> | null = null;
  private readonly _landmarkPos = new THREE.Vector3();
  private readonly _landmark = { i: 0, dist: 0 };

  /** The nearest work site within 3.5 u, or null. The returned object is
   *  reused frame to frame. */
  private nearestLandmark(p: THREE.Vector3): { i: number; dist: number } | null {
    if (!this.landmarkSites) {
      const root = this.scene.getIsland()?.mesh;
      if (!root) return null;
      const sites: Array<THREE.Vector3 | null> = [];
      let found = 0;
      for (let i = 0; i < SimpleApp.LANDMARK_ANCHORS.length; i++) {
        const o = root.getObjectByName(`construction_${i}`);
        sites.push(o ? o.getWorldPosition(new THREE.Vector3()) : null);
        if (o) found++;
      }
      if (found === 0) return null; // not built yet: look again next frame
      this.landmarkSites = sites;
    }
    const max = SimpleApp.LANDMARK_U * SimpleApp.LANDMARK_U;
    let best = -1;
    let bestD = max;
    for (let i = 0; i < this.landmarkSites.length; i++) {
      const s = this.landmarkSites[i];
      if (!s) continue;
      const d = s.distanceToSquared(p);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    if (best < 0) return null;
    this._landmark.i = best;
    this._landmark.dist = Math.sqrt(bestD);
    return this._landmark;
  }

  /** The tour's Projects stop (P2-A13): the five sites ring the hall 20-76 u
   *  apart, too wide for one frame, so the stop studies the centre of the
   *  closest three, RankPilot, Bano's Cookbook and Insta Services API
   *  (20-45 u apart). Measured at 1440x900: the Insta Services API and
   *  Bano's Cookbook dioramas are in frame (the hall stop showed none). */
  private static readonly SITES_TOUR = [0, 3, 4];
  private static readonly SITES_TOUR_ALT = 16;
  private static readonly SITES_TOUR_BACK = 20;

  /** The tour's sites' centre on the surface; null before the island has them. */
  private workSitesCentre(): THREE.Vector3 | null {
    this.nearestLandmark(this._landmarkPos.set(0, 0, 0));
    const all = this.landmarkSites ?? [];
    const sites = SimpleApp.SITES_TOUR.map((i) => all[i]).filter((s): s is THREE.Vector3 => !!s);
    if (sites.length === 0) return null;
    const c = new THREE.Vector3();
    let r = 0;
    for (const s of sites) {
      c.add(s);
      r += s.length();
    }
    return c.normalize().multiplyScalar(r / sites.length);
  }

  /** A tool action is available here (chop, harvest, ore, cast): it
   *  outranks a landmark's info prompt. */
  private toolActionHere(): boolean {
    return (
      (this.ownedAxe && this.scene.nearestChoppableTree() !== null) ||
      (this.ownedSickle && this.scene.nearestHarvestableCrop() !== null) ||
      (this.ownedPickaxe && this.scene.nearestOreNode() !== null) ||
      (this.ownedRod && this.scene.canCastHere())
    );
  }

  // ── The economy's first-visit pays (P2-A9) ──────────────────────────
  private static readonly LESSON_PAY = 10;
  private static readonly STAMP_PAY = 5;
  private static readonly DELIVERY_PAY = 3;
  /** The School has been opened once (ds_school_enrolled). */
  private schoolEnrolled = false;
  /** Lesson actions that have happened on this device (ds_lesson_acts),
   *  paid or not: enrolment pays the ones already done. */
  private lessonActs = new Set<string>();
  /** Passport stamps already paid (ds_stamp_paid); -1 until first read. */
  private stampsPaid = -1;

  /** One of A's pays: coins, the float, the ledger line and the counter.
   *  Never 'ds:coin' (B9 fires it for pickups only); D11's chip pops
   *  through the counter delta. */
  private payCoins(n: number, why: string): void {
    this.scene.addCoins(n);
    this.scene.floatCoinsAtPlayer(n);
    this.scene.logTransaction(why, n);
    this.ui.updateCoinCounter(this.scene.getCoinsCollected());
  }

  /**
   * Passport stamps pay +5 each, compared against ds_stamp_paid. With no
   * record yet, the record starts at today's count: a returning visitor
   * gets no back-pay. Passport.ts is unchanged.
   */
  private payStamps(): void {
    const passport = this.passport;
    if (!passport) return;
    const n = passport.count();
    if (this.stampsPaid < 0) {
      let saved: number | null = null;
      try {
        const raw = localStorage.getItem('ds_stamp_paid');
        if (raw !== null) saved = Math.max(0, parseInt(raw, 10) || 0);
      } catch {
        /* no storage: count from now */
      }
      this.stampsPaid = saved ?? n;
      if (saved === null) this.persistStampsPaid();
    }
    if (n <= this.stampsPaid) return;
    const pay = (n - this.stampsPaid) * SimpleApp.STAMP_PAY;
    this.stampsPaid = n;
    this.persistStampsPaid();
    this.payCoins(pay, 'Passport stamp');
  }

  private persistStampsPaid(): void {
    try {
      localStorage.setItem('ds_stamp_paid', String(this.stampsPaid));
    } catch {
      /* session only */
    }
  }

  /** A lesson's row title, in the visitor's scheme (A11): no WASD or Space
   *  on touch. */
  private lessonTitle(id: string): string {
    const touch = this.ui.isTouchDevice();
    switch (id) {
      case 'move':
        if (touch) return 'Walk with the joystick, push it to the edge to run';
        return SimpleApp.LEGACY_RUN
          ? 'Walk with WASD, hold Space while moving to run'
          : 'Walk with WASD, hold Shift to run';
      case 'fish':
        return 'Cast a line at any shore';
      case 'chop':
        return 'Fell a tree with the axe';
      case 'feed':
        return 'Throw feed to the birds, cats or fish';
      case 'chat':
        return 'Ask a villager anything';
      case 'build':
        return 'Raise something at a build stake';
      default:
        return id;
    }
  }

  /** Where a lesson's 'Show me' sends the compass (none for moving). */
  private lessonGuideKey(id: string): string | undefined {
    switch (id) {
      case 'fish':
        return this.ownedRod ? 'shore' : 'kiosk';
      case 'chop':
        return this.ownedAxe ? 'carpenter' : 'kiosk';
      case 'feed':
        return 'kiosk';
      case 'chat':
        return 'villager:ai-nearest';
      case 'build':
        return 'stake:nearest';
      default:
        return undefined;
    }
  }

  /** The School's E: enrol on the first visit (paying every lesson whose
   *  action has already happened; moving always has), then the card. */
  private openSchool(): void {
    if (!this.schoolEnrolled) {
      this.schoolEnrolled = true;
      try {
        localStorage.setItem('ds_school_enrolled', '1');
      } catch {
        /* session only */
      }
      this.noteLessonAct('move');
      let paid = 0;
      for (const [id] of SimpleApp.LESSONS) {
        if (this.lessonActs.has(id) && !this.lessons.includes(id)) {
          this.payLesson(id, false);
          paid += SimpleApp.LESSON_PAY;
        }
      }
      if (paid > 0) {
        sfx.coin();
        this.ui.toast(`📚 Enrolled — +${paid} 🪙 for what you have already learned.`);
      }
    }
    this.ui.showLessons(
      SimpleApp.LESSONS.map(([id]) => ({
        id,
        title: this.lessonTitle(id),
        done: this.lessons.includes(id),
        reward: SimpleApp.LESSON_PAY,
        guideKey: this.lessonGuideKey(id),
      })),
    );
  }

  /** Record a lesson's action; once enrolled, its first time pays. */
  private learnLesson(id: string): void {
    this.noteLessonAct(id);
    if (!this.schoolEnrolled || this.lessons.includes(id)) return;
    this.payLesson(id, true);
  }

  private noteLessonAct(id: string): void {
    if (this.lessonActs.has(id)) return;
    this.lessonActs.add(id);
    try {
      localStorage.setItem('ds_lesson_acts', JSON.stringify([...this.lessonActs]));
    } catch {
      /* session only */
    }
  }

  /**
   * Pay one lesson once. lesson_learned {id, n} replaces lesson_done, whose
   * meaning (a School press) this would change; the two series never mix.
   */
  private payLesson(id: string, announce: boolean): void {
    if (this.lessons.includes(id)) return;
    this.lessons.push(id);
    this.persistLessons();
    this.payCoins(SimpleApp.LESSON_PAY, 'School lesson');
    track('lesson_learned', { id, n: this.lessons.length });
    const lesson = SimpleApp.LESSONS.find(([l]) => l === id);
    if (announce && lesson) {
      sfx.coin();
      this.ui.toast(`${this.lessonCopy(lesson)} (+${SimpleApp.LESSON_PAY} 🪙)`);
    }
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
      // Never on a FIRST visit: this used to be the first text a brand-new
      // visitor read after the welcome — a fish-price note, before they knew
      // what a coin was. The orientation toast owns that slot now; the daily
      // key means the special fires normally from their next visit.
      if (!localStorage.getItem(key) && localStorage.getItem('ds_welcomed')) {
        localStorage.setItem(key, '1');
        // Each label opens the sentence: capitalised.
        const label: Record<ProviderKey, string> = {
          fisherman: 'The fisherman',
          baker: 'The Baker',
          canteen: 'The canteen',
          bank: 'The bank',
          carpenter: 'The Carpenter',
        };
        this.hintLater(
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
      this.learnLesson('feed');
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
        this.learnLesson('feed');
        return;
      }
      if (kind === 'bird' && this.birdFeed > 0) {
        // P2-A10: say why. At night the birds roost: cat feed goes instead
        // when the visitor holds some, else the roost line; never spent.
        const why =
          this.scene.throwBirdFeedReason?.() ?? (this.scene.throwBirdFeed() ? 'ok' : 'none');
        if (why === 'night' && this.catFeed > 0) continue;
        if (why === 'night') {
          this.ui.flashMessage('🌙 The birds are roosting — try cat feed, or come back at dawn');
          return;
        }
        if (why !== 'ok') {
          this.ui.flashMessage('🌾 Not here — try over open ground');
          return;
        }
        this.birdFeed--;
        this.persistBirdFeed();
        this.refreshFeedHud();
        track('bird_feed_thrown', { left: this.birdFeed });
        this.learnLesson('feed');
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
    // P2-A14: Customise shows the avatar from the front. It is a sheet with
    // no close callback (and no ds:modal), so the frame tick lets go once
    // its div is gone.
    if (this.ui['customizeDiv']) {
      this.customizeMirror = true;
      this.scene.getOrbitCamera().setMirrorPose(true);
    }
  }
  /** P2-A14: Customise holds the mirror pose until its sheet closes. */
  private customizeMirror = false;

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
        // If the user already gestured during the boot window, sticky
        // activation lets this late resume succeed immediately (Chrome et
        // al). On WebKit, which ignores non-gesture resumes, it is a no-op —
        // the still-armed unlock listener above covers the next gesture.
        const am = (window as any).audioManager;
        if (!am.isMuted()) {
          try {
            void am.ensureCtx().resume();
          } catch {
            /* no audio support — playBackground below will surface it */
          }
        }
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
          // `didTimeout` means the page NEVER went idle for 500ms — i.e. the
          // fly-in, the one window this deferral exists to protect. The old
          // guard read it as "unlimited time" (`|| deadline.didTimeout`), so
          // the time budget switched itself OFF on exactly the busiest frames
          // and ran the full 40k-sample slice inline. Fall back to a wall
          // clock there instead of surrendering the budget.
          // The wall clock is the DEFAULT, not the exception: it covers both
          // didTimeout and the no-deadline setTimeout fallback (browsers
          // without requestIdleCallback). An earlier pass guarded didTimeout
          // but left `deadline === undefined` returning false, which kept the
          // original unbounded 40k-sample slice alive on exactly the weakest
          // browsers. Only a LIVE idle deadline is trusted to time itself.
          const started = performance.now();
          const outOfTime = () =>
            deadline && !deadline.didTimeout
              ? deadline.timeRemaining() <= 3
              : performance.now() - started >= 6;
          while (ch < 2) {
            let budget = SLICE;
            // The clock is read once per CHECK block, not once per sample:
            // timeRemaining() is a real call, and at 5.3M samples it cost more
            // than the synthesis it was guarding. The counter also guarantees
            // forward progress — a pure time test can stop at zero samples and
            // reschedule forever on a permanently busy page.
            let sinceCheck = 0;
            while (i < N && budget-- > 0) {
              if (++sinceCheck >= 4096) {
                sinceCheck = 0;
                if (outOfTime()) break;
              }
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
   * Init failed: hand the visitor to index.html's #boot-fallback card, which
   * carries the portfolio itself (who, the work, the contact links).
   *
   * This used to paint a full-screen z-9999 overlay with the raw error.stack
   * in innerHTML. With no WebGL the boot guard had ALREADY shown the fallback
   * card (z 4000), so the overlay landed on top of it: visitors saw a red
   * JavaScript stack trace instead of the portfolio. Now: the fallback stays
   * on top, nothing from the error is rendered (it is logged, and reported
   * as a short init_failed reason), and the bare overlay is gone.
   */
  private showErrorScreen(error: unknown): void {
    // Tell index.html's boot guard that init already failed and the card is
    // up. Its showFallback() must stand down on this flag: otherwise its 60 s
    // watchdog later rewrites the reason the visitor is reading ("timed out")
    // and sends a second boot_fallback on top of init_failed.
    (window as Window & { __lifeIslandBootFailed?: boolean }).__lifeIslandBootFailed = true;
    const reason = String((error as Error | null)?.message ?? error ?? 'unknown').slice(0, 120);
    track('init_failed', { reason });
    try {
      this.ui?.hideLoading(); // our own loader must not linger behind the card
      // A visitor reading the loader's quick version has no island to go
      // back to now: drop its Back button and skip wording first.
      this.ui?.closeQuickVersion();
    } catch {
      /* the UI may be the thing that failed */
    }
    const fallback = document.getElementById('boot-fallback');
    if (fallback) {
      if (fallback.hidden) {
        // WebGL exists but init still failed (a throw mid-boot). The boot
        // guard only shows the card for errors that ESCAPE, and init() caught
        // this one, so show it here with the guard's own generic wording.
        const why = document.getElementById('bf-reason');
        if (why) why.textContent = 'but something went wrong loading it.';
        fallback.hidden = false;
      }
      document.getElementById('loading-screen')?.style.setProperty('display', 'none');
      return;
    }
    // No fallback markup at all (a stripped page): a plain card, text only.
    const card = document.createElement('div');
    Object.assign(card.style, {
      position: 'fixed',
      inset: '0',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      gap: '14px',
      padding: '24px',
      background: '#0b1220',
      color: '#e6edf7',
      fontFamily: 'system-ui, sans-serif',
      textAlign: 'center',
      zIndex: '4000',
    });
    const msg = document.createElement('p');
    msg.textContent =
      "The 3D island couldn't start in this browser. Abbas Ali's portfolio is also at digiscalability.com.";
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.textContent = 'Try again';
    retry.addEventListener('click', () => location.reload());
    card.append(msg, retry);
    document.body.appendChild(card);
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

    // The audio manager's documented teardown was DEAD CODE — nothing called
    // it, so on teardown/hot-reload the context, its nodes and (since the
    // lifecycle hooks landed) its visibilitychange/pageshow/pointerdown
    // listeners all leaked, and a stray tab-show could poke a manager whose
    // world was gone. Nulling the global matters for the HMR double-boot
    // guard: a re-created app must build a fresh manager, not adopt one
    // whose context is closed.
    const w = window as unknown as { audioManager?: { dispose?: () => void } };
    try {
      w.audioManager?.dispose?.();
    } catch {
      /* best-effort teardown */
    }
    w.audioManager = undefined;

    if (this.boundHandlers.beforeUnload) {
      window.removeEventListener('beforeunload', this.boundHandlers.beforeUnload);
    }

    if (this.boundHandlers.popState) {
      window.removeEventListener('popstate', this.boundHandlers.popState);
    }

    if (this.boundHandlers.guideTo) {
      window.removeEventListener('ds:guide-to', this.boundHandlers.guideTo);
    }

    if (this.boundHandlers.guideWelcomeClick) {
      this.ui
        ?.getOverlay()
        .removeEventListener('click', this.boundHandlers.guideWelcomeClick, true);
    }

    if (this.boundHandlers.guideWelcomeKey) {
      window.removeEventListener('keydown', this.boundHandlers.guideWelcomeKey, true);
    }

    if (this.boundHandlers.interiorEscape) {
      window.removeEventListener('keydown', this.boundHandlers.interiorEscape, true);
    }

    if (this.boundHandlers.guideModal) {
      window.removeEventListener('ds:modal', this.boundHandlers.guideModal);
    }

    this.guideCard?.dispose();

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
