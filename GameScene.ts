import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

import { DISTRICTS, RING_DISTRICT_LONS, ZONE_LAT, districtAccentAt } from './Districts';
import { EnvironmentCycle } from './EnvironmentCycle';
import { Island } from './Island';
import { Mailbox } from './Mailbox';
import { Materials } from './Materials';
import * as NpcActivities from './NpcActivities';
import { AI_NPCS, composeAwareGreeting, isAiNpc, voiceProfileFor } from './NpcChat';
import { OrbitCamera } from './OrbitCamera';
import { RaceSystem, type RaceEvent, type RaceHudStatus } from './RaceSystem';
import { sfx } from './Sfx';
import { SimplePlayer } from './SimplePlayer';
import { isSpeechEnabled, speak } from './Speech';
import { isRealTheme } from './Theme';
import type { TownPlanResult } from './TownPlanner'; // type-only: the TownPlanner class is no longer used (Island.ts owns the town); this keeps the lamp typing
import { loadGLTFWithFallbacks } from './utils/GLTFModelLoader';
import { getWorldState } from './WorldState';
import { ZonesManager } from './ZonesManager';

/** A villager's cached limb bones: rest pose, swing axis, current angle. */
type NpcLimbCache = Array<{
  b: THREE.Object3D;
  rest: THREE.Quaternion;
  axis: THREE.Vector3;
  ang: number;
}>;

/**
 * GameScene
 *
 * Spherical island scene composition inspired by Messenger
 * Manages:
 * - Spherical planet/island
 * - Player movement and sphere-walking physics
 * - Houses, trees, mailboxes as decorative assets
 * - Interactive zones for portfolio content
 * - Camera and lighting
 */
export class GameScene extends THREE.Scene {
  private island!: Island;
  private player!: SimplePlayer;
  private camera!: THREE.PerspectiveCamera;
  private orbitCamera!: OrbitCamera;

  private lights: {
    sun?: THREE.DirectionalLight;
    ambient?: THREE.AmbientLight;
    skyLight?: THREE.Light;
  } = {};

  // Asset colliders for collision detection
  private colliders: Array<{
    position: THREE.Vector3;
    radius: number;
  }> = [];

  // Animation mixers for GLTF models
  private animationMixers: THREE.AnimationMixer[] = [];

  // Drifting cloud pivots (rotated in update for slow orbits)
  private cloudPivots: THREE.Object3D[] = [];
  // Shared cloud material — every cloud's blobs are merged into one mesh, so
  // weather/time-of-day tinting is a single material write per frame
  private cloudMat: THREE.MeshStandardMaterial | null = null;
  private cloudWet = 0; // smoothed 0-1 overcast mix (weather flips are discrete)
  // Fake pools of warm lamplight on the terrain (one InstancedMesh of
  // additive discs); update() fades them in as dayFactor falls
  private lampPoolMat: THREE.MeshBasicMaterial | null = null;
  // The warm bulb materials of every street lamp — update() switches them on at
  // dusk and off by day so the lamps read as actually lit, not always-glowing.
  private lampBulbMats: THREE.MeshStandardMaterial[] = [];
  // Moving contact shadows under the wandering villagers (the static
  // grounding-shadow mesh only covers props). One InstancedMesh, re-placed
  // each frame under each NPC's feet.
  private npcShadowMesh: THREE.InstancedMesh | null = null;
  private readonly _nsPos = new THREE.Vector3();
  private readonly _nsDir = new THREE.Vector3();
  private readonly _nsQuat = new THREE.Quaternion();
  private readonly _nsScl = new THREE.Vector3();
  private readonly _nsMat = new THREE.Matrix4();
  private readonly _nsWorld = new THREE.Vector3();

  // Player-centred radar tangent basis (recomputed each minimap refresh).
  // The minimap is a GTA-style local radar: north-up, player at the centre.
  private static readonly RADAR_RANGE = 1.35; // radians of arc to the radar edge
  private radarUp = new THREE.Vector3(0, 1, 0);
  private radarNorth = new THREE.Vector3(0, 0, 1);
  private radarEast = new THREE.Vector3(1, 0, 0);

  // Seagull flocks circling shoreline anchors in rigid V-formations: each
  // flock shares ONE pivot (the leader entry rotates it), wingmen ride fixed
  // trailing offsets — coordinated flight instead of stacked parallel circles.
  private birds: Array<{
    pivot: THREE.Object3D;
    bird: THREE.Group;
    wingL: THREE.Mesh;
    wingR: THREE.Mesh;
    dirLocal: THREE.Vector3;
    tangentOff: THREE.Vector3; // V-formation offset in the pivot-local tangent plane
    altOff: number; // V-formation drop below the leader's altitude
    alt: number;
    speed: number;
    size: number; // per-bird base scale — the night-roost lerp targets this
    phase: number;
    lead: boolean; // exactly one per flock — rotates the shared pivot
  }> = [];

  // Ground birds feeding around fixed spots; walking up flushes them into
  // the sky. While pecking they run a little FSM: jab bursts → head-up
  // scans → short tangent hops around the home spot.
  private groundBirds: Array<{
    bird: THREE.Group;
    wingL: THREE.Mesh;
    wingR: THREE.Mesh;
    tail: THREE.Mesh;
    legs: THREE.Group;
    basePos: THREE.Vector3; // home spot (respawn + wander tether)
    curPos: THREE.Vector3; // current perch — moves with hops
    baseQuat: THREE.Quaternion; // pure surface alignment, NO yaw baked in
    up: THREE.Vector3;
    away: THREE.Vector3; // flushed flight direction (tangent, away from approach)
    mode: 'peck' | 'flee' | 'gone' | 'flyto';
    feed: 'jab' | 'scan' | 'hop';
    feedUntil: number; // when the current feed sub-state ends
    size: number; // species-rolled base scale — the night roost targets this
    // Feeding: while a thrown pile is active the bird's basePos is MOVED to a
    // spot by the pile, so the existing tether/hop/flush logic just works;
    // homePos restores it afterwards.
    homePos: THREE.Vector3;
    homeAnal: number;
    // The home SURFACE FRAME. Landing at a pile rebases up/baseQuat onto the
    // pile's normal, which can be ~45 deg away on a R=50 planet; without these
    // the bird would stand tilted at home forever after one feed.
    homeUp: THREE.Vector3;
    homeQuat: THREE.Quaternion;
    feastUntil: number;
    flyFrom: THREE.Vector3;
    flyTo: THREE.Vector3;
    flyT0: number;
    flyDur: number;
    heading: number; // yaw about the surface normal (radians)
    hopFrom: THREE.Vector3;
    hopTo: THREE.Vector3;
    hopT0: number;
    analBase: number; // analytic radius at basePos — hop reseating reference
    t0: number;
    phase: number;
    respawnAt: number;
  }> = [];
  private readonly _gbScratch = new THREE.Vector3();
  private readonly _gbScratch2 = new THREE.Vector3();
  private readonly _gbQuat = new THREE.Quaternion();
  private static readonly GROUND_HOP_DUR = 0.28;
  // Villager limb bones, in swing order: [legL, legR, armL, armR], and the
  // amplitude each takes of the leg swing (arms counter-swing at 70%).
  private static readonly NPC_LIMB_BONES = ['legL', 'legR', 'armL', 'armR'];
  // Angular slack (~4u of arc on R=50) within which a blocked NPC counts as
  // having arrived at its anchor rather than abandoning it.
  private static readonly NPC_ARRIVE_ENOUGH = 0.08;
  /** How far behind its counter a vendor stands, in world units of arc. */
  private static readonly VENDOR_STAND_BACK = 1.15;
  private static readonly NPC_LIMB_MIX = [1, -1, -0.7, 0.7];
  private readonly _npcLimbQ = new THREE.Quaternion();
  private static readonly AXIS_X = new THREE.Vector3(1, 0, 0);
  private static readonly AXIS_Y = new THREE.Vector3(0, 1, 0);

  // Cats prowling the grass near the villages: they sit, stroll to a nearby
  // spot, step away if you crowd them, and trot in to eat thrown cat treats.
  // Modelled on the ground-bird FSM but they WALK (no flight/roost).
  private cats: Array<{
    cat: THREE.Group;
    legs: THREE.Group; // 4 hip pivots, child order [FL, FR, BL, BR]
    tailJoints: THREE.Object3D[]; // nested chain, base→tip
    head: THREE.Object3D; // neck pivot (dip/look)
    gait: number; // 0 = still, 1 = full stride — eased so legs settle smoothly
    headingTarget: number; // yaw the cat is turning toward (heading eases to it)
    basePos: THREE.Vector3; // home (respawn + roam tether)
    curPos: THREE.Vector3; // current stance
    baseQuat: THREE.Quaternion; // surface alignment, NO yaw baked in
    up: THREE.Vector3;
    away: THREE.Vector3; // flee tangent (away from the player)
    homePos: THREE.Vector3; // restore point + surface frame after a feast
    homeUp: THREE.Vector3;
    homeQuat: THREE.Quaternion;
    homeRadius: number; // raycast-true radius at home — the reseat reference
    homeAnal: number; // analytic radius at home — reseat DELTA reference
    analBase: number; // analytic radius at the CURRENT base (moves with feeding)
    mode: 'sit' | 'walk' | 'trot' | 'eat' | 'flee';
    walkFrom: THREE.Vector3;
    walkTo: THREE.Vector3;
    walkT0: number;
    walkDur: number;
    stateUntil: number; // when the current sit/eat/flee sub-state ends
    heading: number; // yaw about the surface normal (radians)
    size: number;
    phase: number;
    feastUntil: number;
  }> = [];
  private readonly _catScratch = new THREE.Vector3();
  private readonly _catScratch2 = new THREE.Vector3();
  private readonly _catQuat = new THREE.Quaternion();

  // Herons wading at the shoreline — mostly still, with a slow neck sway and
  // the occasional slow fishing dip.
  private herons: Array<{
    neck: THREE.Object3D; // shoulder pivot (sway + dip)
    neckRestX: number; // base forward lean the sway/dip compose onto
    phase: number;
    dipT0: number; // -1 = not dipping, else start time
    nextDip: number; // time of the next fishing dip
  }> = [];
  private static readonly CAT_CALL_RADIUS = 22; // cats within this trot in to treats
  private static readonly CAT_MAX = 5; // per throw
  private static readonly CAT_FEAST_SECONDS = 24;
  private static readonly CAT_WALK_SPEED = 1.1; // u/s stroll
  private static readonly CAT_TROT_SPEED = 2.6; // u/s to food

  // Trees swaying gently around their surface-aligned base orientation
  private swayTrees: Array<{
    group: THREE.Object3D;
    baseQuat: THREE.Quaternion;
    phase: number;
  }> = [];

  // Butterflies fluttering around flower clusters
  private butterflies: Array<{
    group: THREE.Group;
    wingL: THREE.Mesh;
    wingR: THREE.Mesh;
    base: THREE.Vector3;
    normal: THREE.Vector3;
    tanA: THREE.Vector3;
    tanB: THREE.Vector3;
    phase: number;
  }> = [];

  // Fish swimming in the surrounding ocean (a few types), occasional jumps.
  private fish: Array<{
    group: THREE.Group;
    tail: THREE.Object3D;
    dir: THREE.Vector3; // unit position on the sphere (over water)
    heading: THREE.Vector3; // unit tangent travel direction
    home: THREE.Vector3; // school/solo anchor — a soft tether keeps fish visible
    speed: number;
    phase: number;
    turnAt: number;
    jumpT0: number; // -1 = swimming, else jump start time (s)
    jumpDur: number;
    depth: number; // metres the body sits below the wave surface
    feedTarget: THREE.Vector3 | null; // unit dir of an active fish-feed pile
    feedUntil: number; // eat-until timestamp (s); 0 = not feeding
  }> = [];
  private activeFishJumps = 0; // cap concurrent leaps so splash pools never starve
  // Fish-feed: bread thrown ONTO the water; nearby fish swim to it and nibble.
  private static readonly FISH_FEED_THROW_DIST = 6.0; // reach past the beach
  private static readonly FISH_FEED_CALL_RADIUS = 26; // fish within this come in
  private static readonly FISH_FEED_MAX = 7;
  private static readonly FISH_FEED_FEAST_SECONDS = 20;
  private static readonly FISH_FEED_PILE_LIFE = 24;
  private fishFeedPiles: Array<{
    pile: THREE.Group;
    toss: THREE.Group;
    from: THREE.Vector3;
    dir: THREE.Vector3; // unit dir — the pile re-floats on the wave every frame
    t0: number;
    landed: boolean;
  }> = [];
  private _fishWakeAccum = 0; // dorsal-wake ripple throttle
  private readonly _fishCam = new THREE.Vector3();
  private readonly _fishHome = new THREE.Vector3();
  private readonly _fishAxis = new THREE.Vector3();
  private readonly _fishZ = new THREE.Vector3();
  private readonly _fishX = new THREE.Vector3();
  private readonly _fishMat = new THREE.Matrix4();
  private readonly _fishDown = new THREE.Vector3();

  // The Fisherman's full routine: cast at the shore → randomly hook a fish →
  // carry it to his stall → sell it (coin pops, catch goes on the counter) →
  // walk back and repeat. Anchored + animated in updateFisherman(); the wander
  // loop skips him.
  private fisherman: {
    npc: { position: THREE.Vector3; meshRef: THREE.Object3D; name: string; dialogue: string[] };
    rig: THREE.Group; // rod + line + bobber, world-placed at the fishing spot
    rod: THREE.Mesh;
    rodTip: THREE.Object3D;
    line: THREE.Mesh;
    bobber: THREE.Mesh;
    caught: THREE.Group | null; // the hooked fish (on the line, then carried)
    // Fishing spot (at the water) + shop stand, surface-projected
    spot: { dir: THREE.Vector3; r: number; n: THREE.Vector3; seaward: THREE.Vector3 };
    stand: { dir: THREE.Vector3; r: number; n: THREE.Vector3; face: THREE.Vector3 };
    shop: THREE.Group;
    slots: THREE.Vector3[]; // world display positions on the stall counter
    sold: THREE.Object3D[]; // fish laid on the counter (FIFO capped)
    coins: Array<{ mesh: THREE.Mesh; t0: number }>; // sale coin-pops
    state: 'cast' | 'wait' | 'reel' | 'toShop' | 'sell' | 'toSpot';
    t0: number; // state start time (s)
    waitDur: number;
    hasCatch: boolean;
    catchIdx: number; // FISH_TYPES index of the current catch
    castLen: number; // seaward cast length, sized at setup so the bobber hangs over open water
    dropBase: number; // bobber local -Y offset that seats it ON the calm sea surface
  } | null = null;

  // The Sailor lives on a little rowboat just offshore, drifting a slow
  // circle and riding the REAL wave math (waveHeightAt — the same surface
  // the shader displaces). Anchored + animated in updateSailor(); the wander
  // loop skips him like the Fisherman.
  private sailor: {
    npc: { position: THREE.Vector3; meshRef: THREE.Object3D; name: string; dialogue: string[] };
    boat: THREE.Group;
    center: THREE.Vector3; // drift-circle centre (unit dir, open water)
    t1: THREE.Vector3; // tangent basis at the centre
    t2: THREE.Vector3;
    angle: number;
    radiusArc: number; // drift circle angular radius
    driftRate: number; // rad/s along the circle
  } | null = null;
  private readonly _sailDir = new THREE.Vector3();
  private readonly _sailFwd = new THREE.Vector3();
  private readonly _sailTmp = new THREE.Vector3();

  /** Market Vendors, pinned behind their stall counters (a minimal station). */
  private vendors: Array<{
    npc: { position: THREE.Vector3; meshRef: THREE.Object3D; name: string; dialogue: string[] };
    pos: THREE.Vector3; // world stand position
    quat: THREE.Quaternion; // surface-aligned + facing the street
    phase: number;
  }> = [];

  // The Baker's routine: knead dough → bake it in the oven → lay the pie on the
  // counter, on a loop. A quest can inject a one-off "fish pie" bake. Props
  // (dough / pie / oven glow) are children of the bakery group (local space).
  private baker: {
    npc: { position: THREE.Vector3; meshRef: THREE.Object3D; name: string; dialogue: string[] };
    bakery: THREE.Group;
    ovenGlow: THREE.Mesh;
    dough: THREE.Group;
    pie: THREE.Group | null;
    questFish: THREE.Group | null; // the delivered fish, during the special bake
    stand: { dir: THREE.Vector3; r: number; n: THREE.Vector3; face: THREE.Vector3 };
    ovenLocal: THREE.Vector3; // oven-door position in bakery-local space
    kneadLocal: THREE.Vector3; // prep spot on the counter
    slots: THREE.Vector3[]; // local counter display positions
    pies: THREE.Object3D[]; // displayed pies (FIFO capped)
    state: 'knead' | 'toOven' | 'bake' | 'toCounter' | 'display' | 'fishBake';
    t0: number;
    fishPie: boolean; // the pie currently in the oven is the quest fish pie
  } | null = null;

  // The fish the player carries during the Baker's fetch quest (child of player).
  private carriedFish: THREE.Group | null = null;
  // Generic gold coin-pops (sales / rewards), rising + spinning + fading.
  private popCoins: Array<{ mesh: THREE.Mesh; t0: number; n: THREE.Vector3 }> = [];

  // Looping smoke puffs rising from house chimneys
  private smokePuffs: Array<{
    mesh: THREE.Mesh;
    material: THREE.MeshBasicMaterial;
    base: THREE.Vector3;
    normal: THREE.Vector3;
    offset: number;
  }> = [];

  // Breadcrumb sparkles leading toward the active delivery target.
  // Terrain resampling is throttled; per-frame we only bob/spin.
  private guideTarget: THREE.Vector3 | null = null;
  private guideSparkles: THREE.Mesh[] = [];
  private guideRefreshAt: number = 0;

  // Collectible coins scattered across the meadows
  private coins: Array<{ mesh: THREE.Mesh; respawnAt: number }> = [];
  private coinsCollected = 0;
  private onCoinCollected?: (total: number) => void;

  // Rideable watercraft: boats + jetskis that float on the waves offshore.
  // `dir` is the unit surface direction (position); `forward` is the last
  // travel tangent (drives orientation). Boarded by swimming up + E.
  private vehicles: Array<{
    group: THREE.Object3D;
    kind: 'boat' | 'jetski' | 'car';
    dir: THREE.Vector3;
    forward: THREE.Vector3;
    bob: number;
    occupied: boolean;
    // Cars ground on the (expensive-to-sample) terrain — cache the surface
    // radius + normal and only re-sample while actually being driven.
    radius: number;
    normal: THREE.Vector3;
    wheels: THREE.Object3D[]; // car wheel pivots (spin + steer), else empty
  }> = [];

  // Indices of vehicles currently driven by a REMOTE peer — their transform
  // comes from the network, so the local vehicle update skips them.
  private remoteHeldVehicles = new Set<number>();
  private parkedCars: THREE.Object3D[] = []; // collected during collider pass
  private activeVehicle: number = -1; // index into vehicles, or -1
  private vehicleMove = { forward: 0, strafe: 0 };
  private onDrownRespawn?: () => void;

  // Vehicle time-trials (land + water checkpoint circuits)
  private races?: RaceSystem;
  private onRaceEventCb?: (e: RaceEvent) => void;
  private onRaceHudCb?: (s: RaceHudStatus | null) => void;

  // Fireflies that take over from the butterflies after dark
  private fireflies: Array<{
    mesh: THREE.Mesh;
    material: THREE.MeshBasicMaterial;
    base: THREE.Vector3;
    normal: THREE.Vector3;
    tanA: THREE.Vector3;
    tanB: THREE.Vector3;
    phase: number;
  }> = [];

  // Sittable benches (collected from the island at init)
  private benchGroups: THREE.Object3D[] = [];

  // Close-range ambience groups, hidden while the camera is far (fly-in):
  // from a distance they read as debris stuck mid-air around the planet
  private ambientGroups: THREE.Object3D[] = [];

  // Micro-animation state: dust puffs (footsteps/landings) + prop wiggles
  private dustPuffs: Array<{
    mesh: THREE.Mesh;
    mat: THREE.MeshBasicMaterial;
    t0: number;
    origin: THREE.Vector3;
    dir: THREE.Vector3;
    normal: THREE.Vector3;
  }> = [];
  private wiggles: Array<{ obj: THREE.Object3D; baseQuat: THREE.Quaternion; t0: number }> = [];

  // Water FX pools: expanding foam rings (swim/wake) + spray droplets
  // (splash/bow-spray/rooster-tail). Both are pooled flat on the sea.
  private waterRings: Array<{
    mesh: THREE.Mesh;
    mat: THREE.MeshBasicMaterial;
    t0: number;
    life: number;
    maxScale: number;
    normal: THREE.Vector3;
  }> = [];
  private waterSpray: Array<{
    mesh: THREE.Mesh;
    mat: THREE.MeshBasicMaterial;
    t0: number;
    life: number;
    origin: THREE.Vector3;
    vel: THREE.Vector3;
  }> = [];
  private _fxScratch = new THREE.Vector3();

  // Sky-dome "up" uniform so the gradient follows the camera around the sphere
  private skyUpUniform: { value: THREE.Vector3 } | null = null;

  // Sky color uniforms + lights handed to the day/night + weather cycle
  private skyColorUniforms: {
    topColor: { value: THREE.Color };
    bottomColor: { value: THREE.Color };
    horizonColor: { value: THREE.Color };
  } | null = null;
  private hemiLight: THREE.HemisphereLight | null = null;
  private envCycle: EnvironmentCycle | null = null;
  private realGradeDone = false; // one-shot latch for the real-theme grade

  // Scratch objects for the guide-trail math
  private readonly _guideAxis = new THREE.Vector3();
  private readonly _guideDir = new THREE.Vector3();
  private readonly _playerDir = new THREE.Vector3();
  private readonly _targetDir = new THREE.Vector3();

  // Scratch objects for per-frame ambient animation (no allocations in update)
  private static readonly _swayAxis = new THREE.Vector3(1, 0, 0);
  private readonly _swayQuat = new THREE.Quaternion();
  private readonly _npcNormal = new THREE.Vector3();
  private readonly _wanderAxis = new THREE.Vector3();
  private readonly _wanderFwd = new THREE.Vector3();
  private readonly _wanderFwd2 = new THREE.Vector3();
  private readonly _wanderZ = new THREE.Vector3();
  private readonly _wanderYawQ = new THREE.Quaternion();
  private readonly _npcRollQ = new THREE.Quaternion();
  private readonly _goalScratch = new THREE.Vector3();
  // Per-NPC persona id (parallel to island.npcTargets); null = no activity brain
  private npcPersonaIds: (string | null)[] = [];
  // Day/night grading endpoints (lerped per frame — no allocations)
  private static readonly _ambientDay = new THREE.Color(0xfff6e8);
  private static readonly _ambientNight = new THREE.Color(0x2c3a5e);
  private static readonly _cloudClear = new THREE.Color(0xffffff);
  private static readonly _cloudStorm = new THREE.Color(0x8a95a5);
  private static readonly _cloudDusk = new THREE.Color(0xffc9a0);
  // NPCs turn to face the player within FACE_RANGE and greet within GREET_RANGE
  private static readonly NPC_FACE_RANGE = 4.5;
  private static readonly NPC_GREET_RANGE = 3.2;
  private static readonly _localUp = new THREE.Vector3(0, 1, 0);
  /** Model-forward indoors (+z). The step roll tips about this axis. */
  private static readonly _localFwd = new THREE.Vector3(0, 0, 1);
  private static readonly _localForward = new THREE.Vector3(0, 0, 1);
  private static readonly _localRight = new THREE.Vector3(1, 0, 0);
  // Sea edge: watercraft can't sail south of this (dir.y = sin latitude) into
  // the featureless far side of the planet.
  //
  // This was 0.05 — level with the equator — which combined with the shoreline
  // (now as low as y≈0.14 where the coast bulges) left a navigable channel
  // barely 2 units wide. Boats were effectively rail-bound. At -0.45 there is
  // ~14 units of open water to roam and the island can be freely circled,
  // while the empty south pole stays out of reach.
  private static readonly SEA_EDGE_Y = -0.45;
  // Half-width of the sun's shadow box. Small = sharp shadows, but it must
  // still cover what the chase camera can see behind the player.
  private static readonly SHADOW_EXTENT = 17;
  private rimLight?: THREE.DirectionalLight;
  private _sunDir = new THREE.Vector3();
  private _atmDir = new THREE.Vector3(); // scratch: player surface dir for district atmosphere
  private _atmAccent = new THREE.Color(); // scratch: nearest-district accent

  // Mailbox instances for interaction tracking
  private mailboxes: Mailbox[] = [];

  // Lamp interactables (for optional interactions)
  private lamps: TownPlanResult['lamps'] = [];

  // Zone manager for portfolio content
  private zonesManager!: ZonesManager;

  // Generic interactable query distance
  private interactionRange: number = 2.5;

  // Cache for nearby interactable to avoid checking every frame
  private cachedNearby: any = null;
  private lastPlayerPos: THREE.Vector3 = new THREE.Vector3();
  private cacheDistanceThreshold: number = 0.5; // Only update if moved this far
  private readyPromise: Promise<void>;
  private readyResolve!: () => void;

  // Callbacks for interactions
  private onZoneInteractCallback?: (zone: any) => void;
  private onMailboxInteractCallback?: (mailbox: Mailbox) => boolean;

  constructor() {
    super();
    this.name = 'GameScene';
    this.background = null; // sky dome handles it
    this.fog = new THREE.FogExp2(0xa8d8f0, 0.009); // atmospheric depth. Keep density×R ≈ 0.45 (0.02@R22, 0.015@R30, 0.009@R50) so the far side of the bigger island stays visible instead of washing to fog — a fixed 0.015 hid exactly the extra world the grow was meant to reveal. EnvironmentCycle reads this as baseFogDensity.

    // Create ready promise
    this.readyPromise = new Promise((resolve) => {
      this.readyResolve = resolve;
    });

    this.initialize();
  }

  /**
   * Seed Math.random with a FIXED sequence for the duration of world
   * generation, then restore the real RNG. Every client runs the same
   * generation code in the same order, so a fixed seed makes them build the
   * IDENTICAL map — the prerequisite for a shared multiplayer world (props in
   * the same place for everyone, and vehicle indices that line up so a car
   * can be networked by index). Runtime randomness (multiplayer ids, FX)
   * stays truly random because it happens after generation, once restored.
   */
  private static installSeededRandom(seedInit = 0x1a2b3c4d): () => void {
    const real = Math.random;
    let s = seedInit >>> 0;
    Math.random = () => {
      // mulberry32
      s = (s + 0x6d2b79f5) >>> 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    return () => {
      Math.random = real;
    };
  }

  /**
   * Initialize scene components
   */
  private async initialize(): Promise<void> {
    const restoreRandom = GameScene.installSeededRandom();
    try {
      // Create camera with extended far plane
      this.camera = new THREE.PerspectiveCamera(
        50, // narrowed from 60: flatter perspective, straighter horizon — reads as a bigger world
        window.innerWidth / window.innerHeight,
        0.1,
        2000,
      );

      // Create spherical island
      // 22u radius (was 18, Messenger parity): with the player scaled to
      // ~1.58u the world reads noticeably bigger — longer blocks, gentler
      // horizon. All placement is lon/lat-based so the districts spread
      // automatically; physical spacing grows with the radius.
      this.island = new Island(50); // grown 30→40→50: bigger walkable world + all lon/lat placement spreads further apart, de-clustering the districts. setPlanet below reads getRadius() so it follows automatically.
      this.add(this.island.mesh);
      // Unify the art direction. Toon (?theme=toon): stepped shading on every
      // prop (abeto-style). Real (default): materials stay MeshStandardMaterial
      // (they're authored that way) + a saturation grade — continuous PBR
      // lighting reads more muted than the toon ramp, so colors get a one-time
      // punch-up to keep the island's candy palette. The grade runs on the
      // FIRST update (see update()), not here: zones/NPCs/town props don't
      // exist yet at this point and would be missed.
      if (!isRealTheme()) this.toonifyIslandMaterials();

      // Register trees for the gentle ambient sway in update()
      this.island.mesh.traverse((obj) => {
        if (/^tree_\d+$/.test(obj.name)) {
          this.swayTrees.push({
            group: obj,
            baseQuat: obj.quaternion.clone(),
            phase: Math.random() * Math.PI * 2,
          });
        }
      });

      // Ambient life anchored to island sites
      this.createButterflies();
      this.createFireflies();
      this.createChimneySmoke();
      this.createDustPool();

      // Solid props: register colliders so the player can't walk through
      // them. Only TownPlanner props ever registered before — the island's
      // own houses/trees/cars/stalls were all ghost-walkable. Radii are
      // footprints, not bounding spheres (tree = trunk, so you can walk
      // under the canopy). Positions are static — captured post-seating,
      // and GLB replacements land on the same spots.
      // Cars are drivable now (not obstacles) — collect them here and DON'T
      // give them a static collider, so a driven car leaves no ghost wall.
      const COLLIDER_RADII: Array<[RegExp, number]> = [
        [/^house_\d+$/, 2.3],
        [/^building_placeholder_\d+$/, 2.1],
        [/^tree_\d+$/, 0.45],
        [/^stall_\d+$/, 1.5],
        [/^lamp_\d+$/, 0.2],
        [/^bench_\d+$/, 0.85],
        [/^construction_\d+$/, 0.8],
        [/^mailbox_\d+$/, 0.35],
        // npc_placeholder colliders removed: they froze at SPAWN positions
        // while the live NPCs wander districts away — the player bumped into
        // invisible walls at 20 empty plaza spots and ghosted through every
        // actual townsperson. Live NPC collision runs in checkPlayerCollisions.
        [/^central_statue$/, 0.55],
        [/^town_fountain$/, 2.3],
        [/^lighthouse$/, 2.0], // solid tower base — was walk-through
        [/^pillar_\d+$/, 0.45], // hub lantern pillars — were walk-through
        [/^gatepost_\d+$/, 0.22], // district entry-gate posts (straddle the avenue; slimmed 2026-08)
      ];
      this.island.mesh.updateMatrixWorld(true);
      let colliderCount = 0;
      this.island.mesh.traverse((obj) => {
        if (/^bench_\d+$/.test(obj.name)) this.benchGroups.push(obj);
        if (obj.name === 'ambient_sparkles' || obj.name === 'ambient_dust') {
          this.ambientGroups.push(obj);
        }
        if (/^car_\d+$/.test(obj.name)) {
          this.parkedCars.push(obj);
          return;
        }
        for (const [re, radius] of COLLIDER_RADII) {
          if (re.test(obj.name)) {
            this.colliders.push({
              position: obj.getWorldPosition(new THREE.Vector3()),
              radius,
            });
            colliderCount++;
            break;
          }
        }
      });
      console.log(`🧱 Registered ${colliderCount} island prop colliders`);

      // Soft contact shadows so props read as sitting ON the ground
      this.createGroundingShadows();

      // Navigation + traversal rewards
      this.createGuideSparkles();
      this.createCoins();
      this.createVehicles();
      this.createWaterFX();

      // Checkpoint race circuits (land for cars, water for boats/jetskis). Gate
      // events/HUD forward through GameScene fields so main can wire them before
      // or after this async init finishes. NOTE: build() is deferred until the
      // zone-building colliders are pushed (below) so gates avoid the 5
      // landmark buildings — building at construction time seated gates
      // inside footprints the car physically couldn't reach.
      this.races = new RaceSystem(this, this.island, this.colliders);
      this.races.onEvent = (e) => this.onRaceEventCb?.(e);
      this.races.onHud = (s) => this.onRaceHudCb?.(s);

      // Create player on island surface with spherical physics
      this.player = new SimplePlayer();
      this.player.setPlanet(new THREE.Vector3(0, 0, 0), this.island.getRadius());
      // Ground the player on the actual displaced terrain, not the ideal sphere
      this.player.setGroundSampler((outwardDir) => {
        const sampled = this.island.sampleSurfaceByDirection(outwardDir, 0);
        return sampled.position.length();
      });
      // Water: float/drown physics needs the wavy surface height + a water test
      this.player.setWaterSampler((outwardDir) => ({
        surface: this.island.waveHeightAt(outwardDir, this.island.seaTimeUniform.value),
        isWater: this.island.isOverWater(outwardDir),
      }));
      // Drowning: bounce the player back to dry land at the nearest shore
      this.player.setOnDrown(() => this.respawnFromDrown());
      // Spawn ON the terrain just OFF the pole: the Welcome Hub town hall sits
      // exactly at the north pole, so a (0,1,0) spawn started the player
      // INSIDE the building — physics then ejected them in an arbitrary
      // direction with the camera clipping the walls. ~7u east lands on the
      // open plaza edge, clear of the hall's footprint, its collider, and the
      // door-prompt range. (Terrain-sampled: the ideal-sphere height can be
      // inside or above a terrain bump, which used to cause a slide at spawn.)
      // Lon π/4 (0.10,1,0.10), not lon 0: the lon-0 meridian holds BOTH the
      // hall door and a lantern pillar 3.6u dead ahead — spawning between
      // avenues gives a clear walk in every direction.
      const spawnDir = new THREE.Vector3(0.1, 1, 0.1).normalize();
      const spawnSample = this.island.sampleSurfaceByDirection(spawnDir, 0);
      const spawnHeight = spawnSample.position.length() + 0.75;
      this.player.setWorldPosition(spawnDir.clone().multiplyScalar(spawnHeight));
      this.player.updateWorldMatrix();
      this.add(this.player);

      // Setup lights
      this.setupLighting();

      // Day/night + weather matched to the visitor's clock and location
      // (needs the sun, hemisphere light, and sky uniforms from setupLighting)
      if (this.lights.sun && this.hemiLight && this.skyColorUniforms) {
        this.envCycle = new EnvironmentCycle(
          this,
          this.lights.sun,
          this.hemiLight,
          this.skyColorUniforms,
        );
        // Share the LIVE horizon Color with the sea's fresnel uniform (by
        // reference — the cycle lerps it in place), so the water's sky
        // reflection tracks day/dusk/night for free. Wave 2 added both ends of
        // this seam but couldn't wire them across file ownership; this is the
        // one-line connection.
        this.island.bindSeaSkyColor(this.skyColorUniforms.horizonColor.value);
      }

      // Create orbit camera (with terrain collision so hills don't block the view)
      this.orbitCamera = new OrbitCamera(this.camera, this.player);
      this.orbitCamera.setCollisionMesh(this.island.mesh); // terrain + all props

      // Create zones manager for portfolio content
      this.zonesManager = new ZonesManager(this.island, this);
      // Zone landmark buildings are added under THIS scene, not island.mesh, so
      // the collider traverse (above) never registers them. Push their footprint
      // colliders explicitly. Radius (1.7) < interactionRange (2.5) so a player
      // stopped at the wall is still close enough to open the panel/enter.
      for (const zone of this.zonesManager.getZones()) {
        this.colliders.push({ position: zone.getPosition(), radius: 1.7 });
      }
      // Camera collision must ALSO see the zone buildings (they live under the
      // scene, not island.mesh) — orbiting behind a hall used to swing the
      // camera straight through its shell.
      this.orbitCamera.setCollisionMesh(
        this.island.mesh,
        ...this.zonesManager.getZones().map((z) => z.marker),
      );

      // Now that every big footprint is registered, lay the race circuits.
      this.races.build();

      // Place quest mailboxes (Island.ts owns the town proper)
      await this.placeAssets();

      // Warm light pools under the lamps (needs both lamp populations placed)
      this.createLampLightPools();

      // Scatter low-poly toon props (Blender-exported glb) correctly onto the sphere
      await this.scatterProps();

      // Handle window resize
      window.addEventListener('resize', () => this.onWindowResize());

      // Debug scene state
      console.log('🏝️ GameScene initialized (spherical island):', {
        children: this.children.length,
        island: { radius: this.island.getRadius() },
        player: { position: this.player.position },
        camera: { position: this.camera.position },
        zones: this.zonesManager.getZoneCount(),
      });

      // Floating identity pins above every NPC
      this.createNameTags();
      this.setupNpcActivities();

      // The Fisherman stands at the shore and casts a line
      this.setupFisherman();
      // The Baker works his oven at the village bakery
      this.setupBaker();
      // The Sailor drifts on his rowboat just offshore
      this.setupSailor();
      // The two Market Vendors mind their stall pitches
      this.setupVendors();
    } finally {
      // Generation done — restore true randomness for runtime/FX.
      restoreRandom();
    }

    // Mark as ready
    this.readyResolve();
  }

  /**
   * Setup lighting for the scene
   */
  /**
   * Soft dark discs under every registered prop — the classic stylised
   * "contact shadow". Two reasons it earns its place even with real shadows on:
   * the sun's shadow box is tight around the player (so props further out cast
   * nothing), and a grounding blob reads correctly at every sun angle, whereas
   * a cast shadow stretches away at dawn/dusk and leaves the base floating.
   * One InstancedMesh = one draw call for the lot.
   */
  private createGroundingShadows(): void {
    const props = this.colliders.filter((c) => c.radius >= 0.3);
    if (props.length === 0) return;

    // Radial falloff blob, drawn once into a small canvas
    const size = 64;
    const cv = document.createElement('canvas');
    cv.width = cv.height = size;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    grad.addColorStop(0, 'rgba(0,0,0,0.55)');
    grad.addColorStop(0.55, 'rgba(0,0,0,0.28)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;

    const mat = new THREE.MeshBasicMaterial({
      map: tex,
      transparent: true,
      depthWrite: false,
      // Lift off the terrain in depth rather than in position — a positional
      // offset on a curved surface either floats on slopes or sinks on crests.
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    const mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), mat, props.length);
    mesh.name = 'grounding_shadows';
    mesh.renderOrder = 1;
    mesh.frustumCulled = false;
    (mesh.userData as Record<string, unknown>).ignoreOcclusion = true;

    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const dir = new THREE.Vector3();
    const scl = new THREE.Vector3();
    const pos = new THREE.Vector3();
    const PLANE_NORMAL = new THREE.Vector3(0, 0, 1);
    for (let i = 0; i < props.length; i++) {
      const c = props[i];
      dir.copy(c.position).normalize();
      const s = this.island.sampleSurfaceByDirection(dir, 0);
      pos.copy(dir).multiplyScalar(s.position.length() + 0.02);
      q.setFromUnitVectors(PLANE_NORMAL, s.normal);
      // Quad width = 2 * (footprint + margin). An additive margin beats a
      // multiplier here because the collider means different things by size: a
      // tree's radius is its TRUNK (0.45) with a much wider canopy overhead,
      // while a house's radius already IS its footprint. Scaling both by one
      // factor under-shadows trees and over-shadows buildings.
      const r = c.radius * 2 + 1.1;
      scl.set(r, r, 1);
      mesh.setMatrixAt(i, m.compose(pos, q, scl));
    }
    mesh.instanceMatrix.needsUpdate = true;
    this.add(mesh);
    console.log(`🌑 ${props.length} grounding shadows (1 draw call)`);
  }

  /**
   * Fake pools of warm lamplight on the terrain under every street lamp — the
   * night-time twin of the grounding shadows: one InstancedMesh of additive
   * radial-gradient discs, faded in by update() as dayFactor falls. Reads as
   * cast light without adding a single real light.
   */
  private createLampLightPools(): void {
    // Island boulevard lamps are the groups named lamp_<i>; TownPlanner lamps
    // arrive via placeAssets() in this.lamps — collect both populations.
    const anchors: THREE.Object3D[] = [];
    this.traverse((obj) => {
      if (/^lamp_\d+$/.test(obj.name)) anchors.push(obj);
    });
    for (const lamp of this.lamps) anchors.push(lamp.group);
    if (anchors.length === 0) return;

    // Collect the warm bulb materials (non-black emissive) so update() can dim
    // them by day and light them at night, in lockstep with the light pools.
    this.lampBulbMats = [];
    const seenBulb = new Set<string>();
    for (const a of anchors) {
      a.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const mm of mats) {
          const m = mm as THREE.MeshStandardMaterial;
          if (!m || !m.emissive) continue;
          if (m.emissive.r + m.emissive.g + m.emissive.b < 0.02) continue;
          if (seenBulb.has(m.uuid)) continue;
          seenBulb.add(m.uuid);
          this.lampBulbMats.push(m);
        }
      });
    }

    const size = 64;
    const cv = document.createElement('canvas');
    cv.width = cv.height = size;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    grad.addColorStop(0, 'rgba(255,214,140,0.85)');
    grad.addColorStop(0.45, 'rgba(255,190,110,0.35)');
    grad.addColorStop(1, 'rgba(255,170,80,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;

    const mat = new THREE.MeshBasicMaterial({
      map: tex,
      transparent: true,
      opacity: 0, // update() fades this in at night
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      // Same depth-lift trick as the grounding shadows (positional offsets
      // float on slopes); one step nearer so pools draw over the shadow discs.
      polygonOffset: true,
      polygonOffsetFactor: -3,
      polygonOffsetUnits: -3,
    });
    const mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), mat, anchors.length);
    mesh.name = 'lamp_light_pools';
    mesh.renderOrder = 2;
    mesh.frustumCulled = false;
    (mesh.userData as Record<string, unknown>).ignoreOcclusion = true;

    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const dir = new THREE.Vector3();
    const scl = new THREE.Vector3();
    const pos = new THREE.Vector3();
    const world = new THREE.Vector3();
    const PLANE_NORMAL = new THREE.Vector3(0, 0, 1);
    for (let i = 0; i < anchors.length; i++) {
      anchors[i].getWorldPosition(world);
      dir.copy(world).normalize();
      const s = this.island.sampleSurfaceByDirection(dir, 0);
      pos.copy(dir).multiplyScalar(s.position.length() + 0.03);
      q.setFromUnitVectors(PLANE_NORMAL, s.normal);
      scl.set(2.6, 2.6, 1);
      mesh.setMatrixAt(i, m.compose(pos, q, scl));
    }
    mesh.instanceMatrix.needsUpdate = true;
    this.add(mesh);
    this.lampPoolMat = mat;
    console.log(`💡 ${anchors.length} lamp light pools (1 draw call)`);
  }

  private setupLighting(): void {
    // Light rig: a dominant warm KEY (sun), a cool sky FILL, and a RIM to
    // separate silhouettes. The old rig ran ambient 0.4 + hemi 0.85 + fill 0.25
    // (≈1.5 of flat fill) against a 1.35 sun — the fill drowned the key, so
    // nothing had form. Key:fill is now ≈2:1, which is what gives stylised
    // scenes their shape. Fill can't go much lower: the toon ramp crushes
    // unlit undersides (tree canopies) to black without it.
    const ambientLight = new THREE.AmbientLight(0xfff6e8, 0.22);
    this.add(ambientLight);
    this.lights.ambient = ambientLight;

    // Directional light (warm sun) — the key
    const sunLight = new THREE.DirectionalLight(0xfff1d6, 1.6);
    sunLight.position.set(30, 40, 30);
    sunLight.castShadow = true;

    // Setup shadow properties (optimized for performance). The shadow map is
    // re-rendered every frame; a 2048² depth pass is a real cost on weaker
    // GPUs, so phones/tablets and low-core machines drop to 1024².
    const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
    const lowCore = (navigator.hardwareConcurrency || 8) <= 4;
    const shadowRes = coarse || lowCore ? 1024 : 2048;
    sunLight.shadow.mapSize.width = shadowRes;
    sunLight.shadow.mapSize.height = shadowRes;
    // The box used to be a fixed ±50 around the origin so it could cover the
    // whole planet — which spent 2048² on a 100-unit span (~20 texels/unit) and
    // is why contact shadows read mushy. It now FOLLOWS the player (see
    // updateSunShadow) over a ±SHADOW_EXTENT span, roughly tripling the
    // effective resolution where the camera is actually looking.
    sunLight.shadow.camera.near = 1;
    sunLight.shadow.camera.far = 120;
    sunLight.shadow.camera.left = -GameScene.SHADOW_EXTENT;
    sunLight.shadow.camera.right = GameScene.SHADOW_EXTENT;
    sunLight.shadow.camera.top = GameScene.SHADOW_EXTENT;
    sunLight.shadow.camera.bottom = -GameScene.SHADOW_EXTENT;
    sunLight.shadow.bias = -0.0004;
    // normalBias offsets along the surface normal — the fix for acne on a
    // curved planet, where a flat depth bias alone either acnes or peter-pans.
    sunLight.shadow.normalBias = 0.035;

    this.add(sunLight);
    // A DirectionalLight aims at its target's world position; the target must
    // be in the scene graph to have one. Parked on the player each frame.
    this.add(sunLight.target);
    this.lights.sun = sunLight;

    // Hemisphere light for natural gradual lighting (sky blue / warm ground).
    // Intensity lifted for the toon ramp — its stepped shading crushes
    // unlit undersides (tree canopies) to near-black without ambient fill.
    const hemiLight = new THREE.HemisphereLight(0xbfe3ff, 0x4a6b32, 0.62);
    this.add(hemiLight);
    this.hemiLight = hemiLight;

    // Soft fill from below-opposite so the planet's far side isn't pure black
    const fillLight = new THREE.DirectionalLight(0xd4e8ff, 0.18);
    fillLight.position.set(-20, -30, -20);
    this.add(fillLight);

    // RIM: a cool back-light roughly opposite the key. This is what separates
    // a prop's silhouette from the terrain behind it — the single biggest
    // reason stylised scenes read as "lit" rather than "flat shaded".
    const rimLight = new THREE.DirectionalLight(0xcfe6ff, 0.55);
    rimLight.position.set(-34, 26, -30);
    this.add(rimLight);
    this.rimLight = rimLight;

    // Sky dome — gradient sphere that moves with the camera
    this.createSkyDome();

    // Puffy clouds drifting around the planet
    this.createClouds();

    // A few birds circling below the clouds
    this.createBirds();

    // Schools of fish in the surrounding ocean
    this.createFish();
  }

  /** One low-poly gull; shared materials are passed in by the callers. */
  private buildBird(
    bodyMat: THREE.Material,
    wingMat: THREE.Material,
    beakMat: THREE.Material,
    extras?: { belly?: THREE.Material; shape?: [number, number, number] },
  ): {
    bird: THREE.Group;
    wingL: THREE.Mesh;
    wingR: THREE.Mesh;
    tail: THREE.Mesh;
    legs: THREE.Group;
  } {
    const bird = new THREE.Group();
    // Body — small elongated sphere pointing along travel direction (-Z);
    // per-species shape squashes/stretches it (plump robin vs sleek gull).
    const body = new THREE.Mesh(new THREE.SphereGeometry(0.11, 6, 5), bodyMat);
    const shape = extras?.shape ?? [1, 0.9, 1.9];
    body.scale.set(shape[0], shape[1], shape[2]);
    bird.add(body);
    // Distinct head — the old single-blob body read as a lump; a head sphere
    // with eye dots gives every bird a real silhouette up close.
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.075, 6, 5), bodyMat);
    head.position.set(0, 0.075, -0.155 * shape[2] * 0.6 - 0.06);
    bird.add(head);
    const eyeMat = GameScene.birdMat(0x1c1a18);
    for (const ex of [-0.048, 0.048]) {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.014, 5, 4), eyeMat);
      eye.position.set(ex, head.position.y + 0.02, head.position.z - 0.05);
      bird.add(eye);
    }
    const beak = new THREE.Mesh(new THREE.ConeGeometry(0.032, 0.09, 4), beakMat);
    beak.rotation.x = -Math.PI / 2;
    beak.position.set(0, head.position.y - 0.005, head.position.z - 0.105);
    bird.add(beak);
    // Belly/breast patch — cheap two-tone (robin red-breast, pigeon chest).
    if (extras?.belly) {
      const belly = new THREE.Mesh(new THREE.SphereGeometry(0.095, 6, 5), extras.belly);
      belly.scale.set(shape[0] * 0.88, shape[1] * 0.72, shape[2] * 1.32);
      belly.position.set(0, -0.045, -0.02);
      bird.add(belly);
    }
    // Tail — small tapered fan at the rear, tip raised; completes the
    // folded-wing silhouette on the ground and the cross in flight.
    const tailGeo = new THREE.BoxGeometry(0.11, 0.012, 0.2);
    tailGeo.translate(0, 0, 0.1); // hinge at the body end
    {
      const tp = tailGeo.attributes.position;
      for (let vi = 0; vi < tp.count; vi++) {
        if (tp.getZ(vi) > 0.15) tp.setX(vi, tp.getX(vi) * 0.45);
      }
      tp.needsUpdate = true;
      tailGeo.computeVertexNormals();
    }
    const tail = new THREE.Mesh(tailGeo, wingMat);
    tail.position.set(0, 0.03, 0.09 * shape[2]);
    tail.rotation.x = -0.16; // NEGATIVE x lifts a +Z tail tip in this model
    bird.add(tail);
    // Legs — thin stilts so grounded birds STAND on the terrain instead of
    // sitting belly-deep in the grass. Flying birds fold them back flat
    // under the tail (rotation.x set by the caller).
    const legs = new THREE.Group();
    const legGeo = new THREE.CylinderGeometry(0.012, 0.012, 0.1, 4);
    for (const lx of [-0.045, 0.045]) {
      const leg = new THREE.Mesh(legGeo, beakMat);
      leg.position.set(lx, -0.05, 0.02);
      legs.add(leg);
      // Tiny forward foot nub
      const foot = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.012, 0.05), beakMat);
      foot.position.set(lx, -0.1, 0);
      legs.add(foot);
    }
    legs.position.y = -0.08; // hang from the belly; feet ~0.185 below origin
    bird.add(legs);
    // Wings — LONG tapered panels hinged at the body sides. The old 0.34u
    // stubs were invisible from the ground: all you could read at flight
    // altitude was the body's bank, which looked like "tilting" instead of
    // flapping. Span ~0.65 per wing (wingspan ≈ 3× body) makes every beat
    // legible from below.
    const wingGeo = new THREE.BoxGeometry(0.65, 0.015, 0.24);
    wingGeo.translate(0.325, 0, 0); // hinge at inner edge
    // Taper: pull the outer-edge rear corners forward for a swept tip.
    {
      const pos = wingGeo.attributes.position;
      for (let vi = 0; vi < pos.count; vi++) {
        if (pos.getX(vi) > 0.6 && pos.getZ(vi) > 0.1) pos.setZ(vi, 0.02);
      }
      pos.needsUpdate = true;
      wingGeo.computeVertexNormals();
    }
    const wingL = new THREE.Mesh(wingGeo, wingMat);
    wingL.position.set(0.07, 0.02, 0);
    bird.add(wingL);
    const wingR = new THREE.Mesh(wingGeo, wingMat);
    wingR.position.set(-0.07, 0.02, 0);
    wingR.rotation.y = Math.PI;
    bird.add(wingR);
    return { bird, wingL, wingR, tail, legs };
  }

  /** One low-poly cat. Forward is -Z (same as the bird/fish). Materials shared
   *  via the birdMat toon cache — no new allocations. ~0.4u long at size 1. */
  private buildCat(
    bodyMat: THREE.Material,
    accentMat: THREE.Material,
    darkMat: THREE.Material,
  ): {
    cat: THREE.Group;
    tailJoints: THREE.Object3D[];
    legs: THREE.Group;
    head: THREE.Object3D;
  } {
    const cat = new THREE.Group();
    const body = new THREE.Mesh(new THREE.SphereGeometry(0.09, 8, 6), bodyMat);
    body.scale.set(1.05, 0.95, 2.0); // stretched along -Z
    body.castShadow = true;
    cat.add(body);
    // Paler underside so the cat reads two-tone from the side.
    const belly = new THREE.Mesh(new THREE.SphereGeometry(0.085, 7, 5), accentMat);
    belly.scale.set(0.9, 0.6, 1.85);
    belly.position.set(0, -0.045, 0);
    cat.add(belly);
    // HEAD PIVOT at the neck so the head can dip/look independently of the
    // body (face parts are children, positioned relative to the pivot).
    const head = new THREE.Object3D();
    head.position.set(0, 0.05, -0.15);
    cat.add(head);
    const skull = new THREE.Mesh(new THREE.SphereGeometry(0.075, 7, 6), bodyMat);
    skull.position.set(0, 0.005, -0.05);
    skull.castShadow = true;
    head.add(skull);
    for (const ex of [-0.045, 0.045]) {
      const ear = new THREE.Mesh(new THREE.ConeGeometry(0.03, 0.06, 4), bodyMat);
      ear.position.set(ex, 0.065, -0.045);
      ear.rotation.z = ex < 0 ? 0.4 : -0.4;
      head.add(ear);
    }
    const muzzle = new THREE.Mesh(new THREE.SphereGeometry(0.032, 6, 5), accentMat);
    muzzle.scale.set(1, 0.8, 0.9);
    muzzle.position.set(0, -0.022, -0.112);
    head.add(muzzle);
    const nose = new THREE.Mesh(new THREE.SphereGeometry(0.012, 5, 4), darkMat);
    nose.position.set(0, -0.01, -0.14);
    head.add(nose);
    const eyeMat = GameScene.birdMat(0x1c1a18);
    for (const ex of [-0.03, 0.03]) {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.013, 5, 4), eyeMat);
      eye.position.set(ex, 0.028, -0.098);
      head.add(eye);
    }
    // Legs — 4 HIP PIVOTS (child order [FL, FR, BL, BR]); each carries a
    // cylinder hanging below it so a swing pivots from the hip like a real
    // step, not a scissor about the leg's middle. Feet ~0.12 below the origin.
    const legs = new THREE.Group();
    const legGeo = new THREE.CylinderGeometry(0.018, 0.016, 0.12, 5);
    const LEGS: Array<[number, number]> = [
      [-0.05, -0.13],
      [0.05, -0.13],
      [-0.05, 0.13],
      [0.05, 0.13],
    ];
    for (const [lx, lz] of LEGS) {
      const hip = new THREE.Object3D();
      hip.position.set(lx, 0.0, lz);
      const leg = new THREE.Mesh(legGeo, bodyMat);
      leg.position.set(0, -0.06, 0);
      leg.castShadow = true;
      hip.add(leg);
      legs.add(hip);
    }
    cat.add(legs);
    // Tail — a NESTED CHAIN of pivots so it flows as a travelling wave (each
    // joint parented to the last, animated with a phase-delayed sine) instead
    // of the whole tail swinging as one rigid stick.
    const tailJoints: THREE.Object3D[] = [];
    const radii = [0.032, 0.028, 0.024, 0.019, 0.014];
    let parent: THREE.Object3D = cat;
    for (let i = 0; i < radii.length; i++) {
      const joint = new THREE.Object3D();
      joint.position.set(0, i === 0 ? 0.02 : 0, i === 0 ? 0.16 : 0.045);
      joint.rotation.x = -0.28; // base curl-up per joint (compounds up the chain)
      parent.add(joint);
      const s = new THREE.Mesh(new THREE.SphereGeometry(radii[i], 6, 5), bodyMat);
      s.position.set(0, 0, 0.022);
      s.castShadow = true;
      joint.add(s);
      tailJoints.push(joint);
      parent = joint;
    }
    return { cat, tailJoints, legs, head };
  }

  /** One low-poly grey heron, standing (~1.15u tall). Returns the neck pivot
   *  for the idle sway + fishing dip. Model forward = -Z (beak points -Z). */
  private buildHeron(): { group: THREE.Group; neck: THREE.Object3D; neckRestX: number } {
    const bodyMat = GameScene.birdMat(0x8b97a3); // slate blue-grey
    const paleMat = GameScene.birdMat(0xc6ced6);
    const legMat = GameScene.birdMat(0x3c3a36);
    const beakMat = GameScene.birdMat(0xe0a83a);
    const eyeMat = GameScene.birdMat(0x1a1a1a);
    const g = new THREE.Group();
    // Long stilt legs + flat feet.
    for (const lx of [-0.055, 0.055]) {
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.017, 0.017, 0.68, 5), legMat);
      leg.position.set(lx, 0.34, 0.02);
      leg.castShadow = true;
      g.add(leg);
      const foot = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.02, 0.12), legMat);
      foot.position.set(lx, 0.005, -0.01);
      g.add(foot);
    }
    // Body — a horizontal ovoid, tail lifted at the back.
    const body = new THREE.Mesh(new THREE.SphereGeometry(0.13, 8, 6), bodyMat);
    body.scale.set(1, 0.82, 1.7);
    body.position.set(0, 0.74, 0);
    body.castShadow = true;
    g.add(body);
    const belly = new THREE.Mesh(new THREE.SphereGeometry(0.12, 7, 5), paleMat);
    belly.scale.set(0.85, 0.5, 1.55);
    belly.position.set(0, 0.7, 0.01);
    g.add(belly);
    const tail = new THREE.Mesh(new THREE.ConeGeometry(0.055, 0.24, 5), bodyMat);
    tail.rotation.x = -Math.PI / 2 - 0.35;
    tail.position.set(0, 0.79, 0.19);
    g.add(tail);
    // NECK pivot at the shoulder — leans up-and-forward; the head tips it into
    // the classic heron S. This pivot carries the whole neck + head.
    const neck = new THREE.Object3D();
    neck.position.set(0, 0.82, -0.12);
    const neckRestX = 0.45;
    neck.rotation.x = neckRestX;
    const col = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.04, 0.42, 6), bodyMat);
    col.position.set(0, 0.2, 0);
    col.castShadow = true;
    neck.add(col);
    const headPivot = new THREE.Object3D();
    headPivot.position.set(0, 0.41, 0);
    headPivot.rotation.x = -0.85; // tip the head forward off the neck (the S)
    const skull = new THREE.Mesh(new THREE.SphereGeometry(0.048, 6, 5), bodyMat);
    headPivot.add(skull);
    const beak = new THREE.Mesh(new THREE.ConeGeometry(0.02, 0.24, 5), beakMat);
    beak.rotation.x = -Math.PI / 2;
    beak.position.set(0, 0.0, -0.15);
    headPivot.add(beak);
    for (const ex of [-0.026, 0.026]) {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.009, 4, 4), eyeMat);
      eye.position.set(ex, 0.018, -0.03);
      headPivot.add(eye);
    }
    neck.add(headPivot);
    g.add(neck);
    return { group: g, neck, neckRestX };
  }

  private createHerons(): void {
    if (!this.island) return;
    // Wade at the very edge of a couple of quiet beaches (lat just above the
    // waterline so the feet are in the shallows).
    const SPOTS: Array<[number, number]> = [
      [2.1, 0.22],
      [4.35, 0.2],
    ];
    for (let i = 0; i < SPOTS.length; i++) {
      const { group, neck, neckRestX } = this.buildHeron();
      const size = 0.95 + Math.random() * 0.2;
      group.scale.setScalar(size);
      const dir = this.island.dirAt(SPOTS[i][0], SPOTS[i][1]);
      const s = this.island.sampleSurfaceByDirection(dir, 0);
      // Seat the feet on the sand/shallows; if the spot sampled below sea, lift
      // it to just above the waterline so the heron stands, not sinks.
      const footR = Math.max(s.position.length(), this.island.seaLevel() + 0.02);
      group.position.copy(dir).multiplyScalar(footR);
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), s.normal);
      group.quaternion
        .copy(q)
        .multiply(this._catQuat.setFromAxisAngle(GameScene.AXIS_Y, Math.random() * Math.PI * 2));
      group.name = `heron_${i}`;
      this.add(group);
      this.herons.push({
        neck,
        neckRestX,
        phase: Math.random() * Math.PI * 2,
        dipT0: -1,
        nextDip: performance.now() / 1000 + 4 + Math.random() * 8,
      });
    }
    console.log(`🪶 ${this.herons.length} herons at the shore`);
  }

  /** Idle the herons: a slow neck sway, and every so often a slow fishing dip
   *  (the neck swings the head down to the water and back up). */
  private updateHerons(time: number): void {
    for (const h of this.herons) {
      let dip = 0;
      if (h.dipT0 >= 0) {
        const p = (time - h.dipT0) / 2.2; // 2.2s dip
        if (p >= 1) {
          h.dipT0 = -1;
          h.nextDip = time + 6 + Math.random() * 10;
        } else {
          dip = Math.sin(p * Math.PI) * 0.7; // gentle forward-down reach and back
        }
      } else if (time > h.nextDip) {
        h.dipT0 = time;
      }
      h.neck.rotation.x = h.neckRestX + dip;
      h.neck.rotation.y = Math.sin(time * 0.4 + h.phase) * 0.12; // slow look
    }
  }

  // Bird materials cached per colour (fishMat pattern) — species mixing
  // would otherwise allocate ~20 duplicate MeshToonMaterials.
  private static birdMatCache = new Map<number, THREE.MeshToonMaterial>();
  private static birdMat(color: number, doubleSide = false): THREE.MeshToonMaterial {
    const key = color + (doubleSide ? 0x2000000 : 0);
    let m = GameScene.birdMatCache.get(key);
    if (!m) {
      m = new THREE.MeshToonMaterial({
        color,
        side: doubleSide ? THREE.DoubleSide : THREE.FrontSide,
      });
      GameScene.birdMatCache.set(key, m);
    }
    return m;
  }

  /**
   * Seagull flocks circling low over the shoreline in banked loops — a
   * V-FORMATION of three over each of two beach anchors plus one loner.
   * Each flock shares one pivot: the leader flies the circle and the
   * wingmen hold rigid behind-and-beside offsets (real formations are
   * near-rigid), instead of the old stacked parallel circles that read as
   * birds glued side by side. They roost (fade out) at night; update()
   * runs the orbit, soar, and flap/glide cycle.
   */
  private createBirds(): void {
    const bodyMat = GameScene.birdMat(0xf4f6f8);
    const wingMat = GameScene.birdMat(0xdfe5ea, true);
    const beakMat = GameScene.birdMat(0xf2b04a);
    // Juvenile gull plumage — one mottled-grey wingman per trio so the
    // flocks read as a mixed family, not three copies.
    const juvBodyMat = GameScene.birdMat(0xd8d1c5);
    const juvWingMat = GameScene.birdMat(0xb4aa9a, true);
    const planetR = this.island ? this.island.getRadius() : 18;
    const up = new THREE.Vector3(0, 1, 0);
    // Four full trios. The old layout (3+3+1, all anchored at shoreline
    // lat 0.24) meant the spawn plaza had NO birds overhead — from the hub
    // you could only ever see one distant trio ("I only see 3"). The fourth
    // flock circles high over the hub itself, visible the moment you spawn.
    const FLOCKS: Array<{ lon: number; lat: number; count: number }> = [
      { lon: 5.0, lat: 0.24, count: 3 },
      { lon: 2.0, lat: 0.24, count: 3 },
      { lon: 3.6, lat: 0.24, count: 3 },
      { lon: 0.9, lat: 1.05, count: 3 },
    ];
    // Trailing V slots relative to the leader (x across, y altitude drop,
    // z BEHIND — the flock flies -Z in pivot-local space).
    // Wide enough that the ~2.3u-wingspan birds never overlap: overlapped
    // wingmen read as a single bird from the ground.
    const V_SLOTS = [
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(-2.4, -0.5, 2.6),
      new THREE.Vector3(2.4, -0.5, 2.6),
    ];
    let fi = 0;
    for (const flock of FLOCKS) {
      const pivot = new THREE.Object3D();
      // Aim the pivot's spin axis (+Y) at a point just above the shoreline
      // so the flock traces a small circle over the beach instead of a
      // great-circle orbit through the far hemisphere.
      const anchor = this.island ? this.island.dirAt(flock.lon, flock.lat) : up.clone();
      pivot.quaternion.setFromUnitVectors(up, anchor);
      pivot.name = `bird_pivot_${fi}`;
      this.add(pivot);
      // Wider, quicker loops: at the old 0.25 rad/s the linear speed was a
      // walking-pace ~1.8u/s hover. ~0.5 rad/s over a ~9u circle ≈ 4.5u/s —
      // still a lazy thermal circle, but visibly FLYING.
      const theta = 0.14 + Math.random() * 0.04;
      const alt = planetR + 0.1 + (2.8 + fi * 0.9);
      const speed = 0.45 + Math.random() * 0.12;
      const dirLocal = new THREE.Vector3(Math.sin(theta), Math.cos(theta), 0);
      for (let j = 0; j < flock.count; j++) {
        // Second wingman is a mottled juvenile; every bird gets size jitter.
        const juv = j === 2;
        const { bird, wingL, wingR, legs } = this.buildBird(
          juv ? juvBodyMat : bodyMat,
          juv ? juvWingMat : wingMat,
          beakMat,
        );
        legs.rotation.x = -1.25; // legs tucked back in flight
        const slot = V_SLOTS[j];
        const tangentOff = new THREE.Vector3(slot.x, 0, slot.z);
        bird.position
          .copy(dirLocal)
          .multiplyScalar(alt + slot.y)
          .add(tangentOff);
        // Near the pivot pole the model's up (+Y) already points radially
        // out. Gentle bank only — at 0.28 the lean dominated the read from
        // the ground ("tilting instead of flapping"); the flutter carries
        // the motion now.
        bird.rotation.z = 0.16;
        // Gulls are big birds: ~1.55× makes the wingbeat legible from the
        // beach below; jitter (juveniles run smaller) breaks the clone look.
        // The roost lerp scales toward this per-bird size, not 1.
        const size = (juv ? 1.3 : 1.55) * (0.92 + Math.random() * 0.16);
        bird.scale.setScalar(size);
        pivot.add(bird);
        this.birds.push({
          pivot,
          bird,
          wingL,
          wingR,
          dirLocal,
          tangentOff,
          altOff: slot.y,
          alt,
          speed,
          size,
          phase: Math.random() * Math.PI * 2,
          lead: j === 0,
        });
      }
      fi++;
    }
    this.createGroundBirds();
  }

  /**
   * Small birds pecking at the ground around plazas, parks, and the shore.
   * Approach within ~3.2u and they flush — a fast climbing flight away —
   * then land again at the same spot a while after the coast is clear.
   */
  private createGroundBirds(): void {
    if (!this.island) return;
    // Mixed species — body/wing/beak/belly colours, body shape, size range.
    // Cycled over the spots so every cluster of visited spots shows variety.
    const SPECIES: Array<{
      body: number;
      wing: number;
      beak: number;
      belly?: number;
      shape: [number, number, number];
      size: [number, number];
    }> = [
      // sparrow — warm brown, buff belly, compact
      {
        body: 0xa08a70,
        wing: 0x84705a,
        beak: 0x6b5138,
        belly: 0xcfbb9c,
        shape: [1.05, 0.95, 1.6],
        size: [0.8, 0.95],
      },
      // gull — white/pale grey, the beach classic
      { body: 0xf4f6f8, wing: 0xdfe5ea, beak: 0xf2b04a, shape: [1, 0.9, 1.9], size: [1.0, 1.2] },
      // pigeon — blue-grey with a lighter chest
      {
        body: 0x8a93a6,
        wing: 0x6f7a90,
        beak: 0x5a5f6e,
        belly: 0xb9c0cf,
        shape: [1.1, 1.0, 1.7],
        size: [0.85, 1.0],
      },
      // blackbird — near-black with the orange beak
      { body: 0x2e2b29, wing: 0x1f1d1c, beak: 0xf2a83a, shape: [1, 0.9, 1.75], size: [0.78, 0.95] },
      // robin — brown back, red breast, plump and small (floor 0.72: the
      // 0.5-0.62 band was screenshot-proven to vanish into the grass tufts)
      {
        body: 0x8c7663,
        wing: 0x6f5d4e,
        beak: 0x5c4a38,
        belly: 0xd97b4a,
        shape: [1.15, 1.05, 1.5],
        size: [0.72, 0.85],
      },
    ];
    // [lon, lat] peck spots: plaza rim, park grass, beach sand — weighted
    // toward the hub/high latitudes where players actually walk (the old
    // set was mostly remote shores nobody visited: "no bird on the floor").
    const SPOTS: Array<[number, number]> = [
      // First spot sits ~6u off spawn — inside the flush radius it would
      // flee before the player ever saw a bird on the ground.
      [0.55, 1.24],
      [2.4, 1.32],
      [4.2, 1.22],
      [1.4, 1.05],
      [5.6, 0.95],
      [0.35, 0.8],
      [1.9, 0.75],
      [3.4, 0.9],
      [5.0, 0.34],
      [2.0, 0.34],
      [0.5, 0.6],
      [4.4, 0.55],
    ];
    for (let i = 0; i < SPOTS.length; i++) {
      const sp = SPECIES[i % SPECIES.length];
      const { bird, wingL, wingR, tail, legs } = this.buildBird(
        GameScene.birdMat(sp.body),
        GameScene.birdMat(sp.wing, true),
        GameScene.birdMat(sp.beak),
        {
          belly: sp.belly !== undefined ? GameScene.birdMat(sp.belly) : undefined,
          shape: sp.shape,
        },
      );
      const size = sp.size[0] + Math.random() * (sp.size[1] - sp.size[0]);
      bird.scale.setScalar(size);
      const dir = this.island.dirAt(SPOTS[i][0], SPOTS[i][1]);
      // Seat on the RAYCAST mesh, not the analytic field: where the two
      // diverge the analytic radius sat under the rendered terrain and the
      // birds were buried. Startup-only, so 12 raycasts is fine.
      // Lift = foot height (~0.185 local × scale): the bird STANDS on its
      // legs instead of sitting belly-deep in the grass.
      const s = this.island.sampleSurfaceByDirection(dir, 0);
      bird.position.copy(s.position).addScaledVector(s.normal, 0.185 * size + 0.005);
      // baseQuat = pure surface alignment; yaw lives in `heading` so the
      // feeding FSM can turn/face freely without re-baking the quaternion.
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), s.normal);
      bird.quaternion.copy(q);
      const heading = Math.random() * Math.PI * 2;
      bird.rotateY(heading);
      bird.name = `ground_bird_${i}`;
      this.add(bird);
      // Flushed flight heads along a fixed tangent (away from the island
      // interior reads best: use the local east tangent, varied per bird).
      const away = new THREE.Vector3()
        .crossVectors(s.normal, new THREE.Vector3(0, 1, 0))
        .normalize();
      if (away.lengthSq() < 0.5) away.set(1, 0, 0);
      away.applyAxisAngle(s.normal, Math.random() * Math.PI * 2);
      this.groundBirds.push({
        bird,
        wingL,
        wingR,
        tail,
        legs,
        basePos: bird.position.clone(),
        curPos: bird.position.clone(),
        baseQuat: q.clone(),
        up: s.normal.clone(),
        away,
        mode: 'peck',
        feed: 'jab',
        // The update clock is absolute performance.now()/1000, so the
        // stagger must be too — a bare 1-3s constant is already in the past
        // by the first frame after asset loading.
        feedUntil: performance.now() / 1000 + 1 + Math.random() * 2,
        size,
        heading,
        hopFrom: bird.position.clone(),
        hopTo: bird.position.clone(),
        hopT0: 0,
        analBase: this.island.analyticSurface(dir).radius,
        homePos: bird.position.clone(),
        homeAnal: this.island.analyticSurface(dir).radius,
        homeUp: s.normal.clone(),
        homeQuat: q.clone(),
        feastUntil: 0,
        flyFrom: bird.position.clone(),
        flyTo: bird.position.clone(),
        flyT0: 0,
        flyDur: 1,
        t0: 0,
        phase: Math.random() * Math.PI * 2,
        respawnAt: 0,
      });
    }
    this.createCats();
    this.createHerons();
  }

  private createCats(): void {
    if (!this.island) return;
    // [body, accent (paler underside/muzzle), dark (nose)] per coat.
    const SPECIES: Array<[number, number, number]> = [
      [0xd98a3a, 0xf0d3a8, 0x2a1c12], // ginger
      [0x8a8480, 0xc4beb4, 0x2a2622], // grey tabby
      [0x2e2b29, 0x6a6560, 0x151311], // black
      [0xf1efe9, 0xd8d2c8, 0x3a3530], // white
      [0x4a4642, 0xf1efe9, 0x1a1714], // tuxedo (dark coat, white bib)
    ];
    // Grass near the plazas/streets where players actually walk.
    const SPOTS: Array<[number, number]> = [
      [0.9, 1.18],
      [2.7, 1.06],
      [4.7, 1.12],
      [1.7, 0.82],
      [3.9, 0.7],
      [5.3, 0.5],
    ];
    for (let i = 0; i < SPOTS.length; i++) {
      const sp = SPECIES[i % SPECIES.length];
      const { cat, tailJoints, legs, head } = this.buildCat(
        GameScene.birdMat(sp[0]),
        GameScene.birdMat(sp[1]),
        GameScene.birdMat(sp[2]),
      );
      const size = 0.9 + Math.random() * 0.3;
      cat.scale.setScalar(size);
      const dir = this.island.dirAt(SPOTS[i][0], SPOTS[i][1]);
      // Raycast seat (startup-only) — the analytic field sits under the mesh.
      const s = this.island.sampleSurfaceByDirection(dir, 0);
      cat.position.copy(s.position).addScaledVector(s.normal, 0.12 * size + 0.005);
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), s.normal);
      const heading = Math.random() * Math.PI * 2;
      cat.quaternion.copy(q).multiply(this._catQuat.setFromAxisAngle(GameScene.AXIS_Y, heading));
      cat.name = `cat_${i}`;
      this.add(cat);
      const anal = this.island.analyticSurface(dir).radius;
      const away = new THREE.Vector3().crossVectors(s.normal, new THREE.Vector3(0, 1, 0));
      if (away.lengthSq() < 0.5) away.set(1, 0, 0);
      away.normalize().applyAxisAngle(s.normal, Math.random() * Math.PI * 2);
      this.cats.push({
        cat,
        tailJoints,
        legs,
        head,
        gait: 0,
        headingTarget: heading,
        basePos: cat.position.clone(),
        curPos: cat.position.clone(),
        baseQuat: q.clone(),
        up: s.normal.clone(),
        away,
        homePos: cat.position.clone(),
        homeUp: s.normal.clone(),
        homeQuat: q.clone(),
        homeRadius: cat.position.length(),
        homeAnal: anal,
        analBase: anal,
        mode: 'sit',
        walkFrom: cat.position.clone(),
        walkTo: cat.position.clone(),
        walkT0: 0,
        walkDur: 1,
        // Absolute clock, like the ground birds — a bare constant is already
        // in the past by the first frame after asset load.
        stateUntil: performance.now() / 1000 + 1 + Math.random() * 3,
        heading,
        size,
        phase: Math.random() * Math.PI * 2,
        feastUntil: 0,
      });
    }
    console.log(`🐈 ${this.cats.length} cats prowling the grass`);
  }

  /** Yaw (about the surface normal) that faces a world direction. Cat model
   *  forward = -Z, same convention as the birds. */
  private catHeadingFor(c: GameScene['cats'][number], worldDir: THREE.Vector3): number {
    this._catQuat.copy(c.baseQuat).invert();
    this._catScratch2.copy(worldDir).applyQuaternion(this._catQuat);
    return Math.atan2(-this._catScratch2.x, -this._catScratch2.z);
  }

  /** Pick a stroll target tethered ~1.5u around home (or head back to it) and
   *  put the cat into a timed walk. Reseats via the analytic delta. */
  private startCatWalk(c: GameScene['cats'][number], time: number): void {
    if (!this.island) return;
    const ref = Math.abs(c.up.y) > 0.94 ? GameScene.AXIS_X : GameScene.AXIS_Y;
    const t1 = this._catScratch.crossVectors(c.up, ref).normalize();
    const t2 = this._catScratch2.crossVectors(c.up, t1).normalize();
    const a = Math.random() * Math.PI * 2;
    const dist = 0.7 + Math.random() * 1.1;
    c.walkTo
      .copy(c.curPos)
      .addScaledVector(t1, Math.cos(a) * dist)
      .addScaledVector(t2, Math.sin(a) * dist);
    if (c.walkTo.distanceToSquared(c.basePos) > 2.6 * 2.6) {
      c.walkTo.sub(c.basePos).setLength(1.4).add(c.basePos);
    }
    this.seatCatTarget(c, c.walkTo);
    c.walkFrom.copy(c.curPos);
    c.walkT0 = time;
    c.walkDur = Math.max(0.6, c.walkFrom.distanceTo(c.walkTo) / GameScene.CAT_WALK_SPEED);
    c.headingTarget = this.catHeadingFor(c, this._catScratch.copy(c.walkTo).sub(c.walkFrom));
    c.mode = 'walk';
  }

  /** Snap a target point onto the surface using the raycast-true home radius +
   *  the analytic delta at the target direction (no runtime raycasts). */
  private seatCatTarget(c: GameScene['cats'][number], target: THREE.Vector3): void {
    if (!this.island) return;
    const dir = this._catScratch.copy(target).normalize();
    const r = c.basePos.length() + (this.island.analyticSurface(dir).radius - c.analBase);
    target.copy(dir).multiplyScalar(r + 0.12 * c.size + 0.005);
  }

  /** Send the nearest idle cats trotting in to a fresh treat pile. */
  private callCatsToFeed(pos: THREE.Vector3, time: number): void {
    if (!this.island) return;
    const near = this.cats
      .filter((c) => c.mode !== 'trot' && c.mode !== 'eat' && c.feastUntil <= time)
      .map((c) => ({ c, d: c.curPos.distanceTo(pos) }))
      .filter((e) => e.d < GameScene.CAT_CALL_RADIUS)
      .sort((a, b) => a.d - b.d)
      .slice(0, GameScene.CAT_MAX);
    const pileUp = this._catScratch.copy(pos).normalize();
    const ref = Math.abs(pileUp.y) > 0.94 ? GameScene.AXIS_X : GameScene.AXIS_Y;
    const t1 = new THREE.Vector3().crossVectors(pileUp, ref).normalize();
    const t2 = new THREE.Vector3().crossVectors(pileUp, t1).normalize();
    for (let i = 0; i < near.length; i++) {
      const c = near[i].c;
      const a = (i / Math.max(1, near.length)) * Math.PI * 2 + Math.random() * 0.4;
      const r = 0.5 + Math.random() * 0.4;
      c.walkTo
        .copy(pos)
        .addScaledVector(t1, Math.cos(a) * r)
        .addScaledVector(t2, Math.sin(a) * r);
      this.seatCatTarget(c, c.walkTo);
      c.walkFrom.copy(c.curPos);
      c.walkT0 = time;
      c.walkDur = THREE.MathUtils.clamp(near[i].d / GameScene.CAT_TROT_SPEED, 0.6, 6);
      c.mode = 'trot';
      c.feastUntil = time + c.walkDur + GameScene.CAT_FEAST_SECONDS;
      c.headingTarget = this.catHeadingFor(c, this._catScratch2.copy(c.walkTo).sub(c.walkFrom));
    }
  }

  /**
   * Start a short tangent hop toward a random nearby point, tethered to
   * ~1u around the bird's home spot. Reseats the landing height with the
   * cheap analytic field applied as a DELTA from the raycast-accurate
   * home height — no runtime raycasts.
   */
  private startGroundBirdHop(g: GameScene['groundBirds'][number], time: number): void {
    if (!this.island) return;
    // Tangent basis around the surface normal (fall back off the pole).
    const ref = Math.abs(g.up.y) > 0.94 ? GameScene.AXIS_X : GameScene.AXIS_Y;
    const t1 = this._gbScratch.crossVectors(g.up, ref).normalize();
    const t2 = this._gbScratch2.crossVectors(g.up, t1).normalize();
    const a = Math.random() * Math.PI * 2;
    const dist = 0.25 + Math.random() * 0.3;
    g.hopTo
      .copy(g.curPos)
      .addScaledVector(t1, Math.cos(a) * dist)
      .addScaledVector(t2, Math.sin(a) * dist);
    // Tether: never wander more than ~1u from home (spots are claimed
    // off-street; drifting could walk a bird onto pavement or into a prop).
    if (g.hopTo.distanceToSquared(g.basePos) > 1.0) {
      g.hopTo.sub(g.basePos).setLength(0.55).add(g.basePos);
    }
    const dir = this._gbScratch.copy(g.hopTo).normalize();
    const r = g.basePos.length() + (this.island.analyticSurface(dir).radius - g.analBase);
    g.hopTo.copy(dir).multiplyScalar(r);
    g.hopFrom.copy(g.curPos);
    g.hopT0 = time;
    g.feed = 'hop';
    g.feedUntil = time + GameScene.GROUND_HOP_DUR;
    g.heading = this.groundBirdHeadingFor(g, this._gbScratch.copy(g.hopTo).sub(g.hopFrom));
  }

  // ── Bird feed ─────────────────────────────────────────────────────────
  private static readonly FEED_THROW_DIST = 3.6; // how far ahead it lands
  private static readonly FEED_CALL_RADIUS = 38; // birds within this fly in
  private static readonly FEED_MAX_BIRDS = 8;
  private static readonly FEED_FEAST_SECONDS = 26;
  private static readonly FEED_PILE_LIFE = 30;
  private static feedGrainGeo: THREE.BufferGeometry | null = null;
  private feedPiles: Array<{
    pile: THREE.Group; // grains lying on the ground
    toss: THREE.Group; // grains in flight
    from: THREE.Vector3;
    to: THREE.Vector3;
    up: THREE.Vector3;
    t0: number;
    landed: boolean;
  }> = [];
  private readonly _feedUp = new THREE.Vector3();
  private readonly _feedFwd = new THREE.Vector3();
  private readonly _feedDir = new THREE.Vector3();
  private readonly _feedTmp = new THREE.Vector3();

  /**
   * Toss a handful of seed onto the ground a few metres ahead and call every
   * nearby ground bird in to eat it. Returns false if there is nowhere sane
   * to throw (no island/player yet, or the spot is under water), so the
   * caller can keep the player's charge.
   */
  public throwBirdFeed(): boolean {
    if (!this.island || !this.player) return false;
    // Not at night: the ground birds are roosted (scaled to nothing and
    // hidden), so they would pop in at full size, fly over and dissolve on
    // landing. Returning false keeps the player's charge.
    if (this.envCycle && this.envCycle.getDayFactor() < 0.3) return false;
    const origin = this.player.getWorldPosition();
    const up = this._feedUp.copy(origin).normalize();
    // Aim along the camera's tangent forward so the feed lands where you look.
    this._feedFwd.copy(this.orbitCamera.getForwardDirection());
    this._feedFwd.addScaledVector(up, -this._feedFwd.dot(up));
    if (this._feedFwd.lengthSq() < 1e-4) {
      this._feedFwd.copy(this.player.getForwardDirection());
      this._feedFwd.addScaledVector(up, -this._feedFwd.dot(up));
    }
    if (this._feedFwd.lengthSq() < 1e-4) return false;
    this._feedFwd.normalize();
    const ang = GameScene.FEED_THROW_DIST / Math.max(1, origin.length());
    this._feedDir
      .copy(up)
      .multiplyScalar(Math.cos(ang))
      .addScaledVector(this._feedFwd, Math.sin(ang))
      .normalize();
    let surf: { position: THREE.Vector3; normal: THREE.Vector3 };
    try {
      surf = this.island.sampleSurfaceByDirection(this._feedDir, 0);
    } catch {
      return false;
    }
    if (surf.position.length() < this.island.seaLevel() + 0.15) return false; // in the sea

    const time = performance.now() / 1000;
    const pos = this.spawnFeedPile(origin, up, surf.position, surf.normal, 0xd9bd7a, 'bird_feed');
    this.callBirdsToFeed(pos, time);
    sfx.blip();
    return true;
  }

  /**
   * Toss a handful of cat treats onto the ground ahead and call every nearby
   * cat in to eat. Land-only (same sea refusal as bird feed), but NO night
   * guard — cats prowl day and night. Returns false to keep the charge.
   */
  public throwCatFeed(): boolean {
    if (!this.island || !this.player) return false;
    const origin = this.player.getWorldPosition();
    const up = this._feedUp.copy(origin).normalize();
    this._feedFwd.copy(this.orbitCamera.getForwardDirection());
    this._feedFwd.addScaledVector(up, -this._feedFwd.dot(up));
    if (this._feedFwd.lengthSq() < 1e-4) {
      this._feedFwd.copy(this.player.getForwardDirection());
      this._feedFwd.addScaledVector(up, -this._feedFwd.dot(up));
    }
    if (this._feedFwd.lengthSq() < 1e-4) return false;
    this._feedFwd.normalize();
    const ang = GameScene.FEED_THROW_DIST / Math.max(1, origin.length());
    this._feedDir
      .copy(up)
      .multiplyScalar(Math.cos(ang))
      .addScaledVector(this._feedFwd, Math.sin(ang))
      .normalize();
    let surf: { position: THREE.Vector3; normal: THREE.Vector3 };
    try {
      surf = this.island.sampleSurfaceByDirection(this._feedDir, 0);
    } catch {
      return false;
    }
    if (surf.position.length() < this.island.seaLevel() + 0.15) return false; // in the sea
    const time = performance.now() / 1000;
    const pos = this.spawnFeedPile(origin, up, surf.position, surf.normal, 0xc98b6a, 'cat_feed');
    this.callCatsToFeed(pos, time);
    sfx.blip();
    return true;
  }

  /**
   * Build a grain pile (pops in) + a toss group (grains in flight) on a
   * surface point, push a pile record, cap the shared array, return the pile
   * world position. Shared by bird + cat feed (the pile is neutral food; the
   * caller's call-to-feed decides which animal answers).
   */
  private spawnFeedPile(
    origin: THREE.Vector3,
    up: THREE.Vector3,
    surfPos: THREE.Vector3,
    surfNormal: THREE.Vector3,
    colorHex: number,
    name: string,
  ): THREE.Vector3 {
    if (!GameScene.feedGrainGeo) GameScene.feedGrainGeo = new THREE.SphereGeometry(0.035, 4, 3);
    const grainMat = GameScene.birdMat(colorHex);
    const pile = new THREE.Group();
    pile.position.copy(surfPos).addScaledVector(surfNormal, 0.02);
    pile.quaternion.setFromUnitVectors(GameScene.AXIS_Y, surfNormal);
    for (let i = 0; i < 16; i++) {
      const grain = new THREE.Mesh(GameScene.feedGrainGeo, grainMat);
      const a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random()) * 0.42;
      grain.position.set(Math.cos(a) * r, 0.012 + Math.random() * 0.02, Math.sin(a) * r);
      grain.scale.setScalar(0.7 + Math.random() * 0.7);
      pile.add(grain);
    }
    pile.scale.setScalar(0.001);
    pile.name = name;
    this.add(pile);
    const toss = new THREE.Group();
    for (let i = 0; i < 7; i++) {
      const grain = new THREE.Mesh(GameScene.feedGrainGeo, grainMat);
      grain.position.set(
        (Math.random() - 0.5) * 0.3,
        (Math.random() - 0.5) * 0.2,
        (Math.random() - 0.5) * 0.3,
      );
      toss.add(grain);
    }
    this.add(toss);
    const time = performance.now() / 1000;
    this.feedPiles.push({
      pile,
      toss,
      from: origin.clone().addScaledVector(up, 1.1),
      to: pile.position.clone(),
      up: surfNormal.clone(),
      t0: time,
      landed: false,
    });
    // Cap live piles (bird + cat share this) so a spammed key can't carpet the
    // island and leave animals miming at bare ground.
    while (this.feedPiles.length > 3) this.removeFeedPile(0);
    return pile.position;
  }

  /**
   * Toss bread ONTO the water ahead and call nearby fish in to nibble. This is
   * the water counterpart of bird feed: the throw is REFUSED unless it lands
   * over water (the inverse of the land feeds), the pile floats on the wave,
   * and the fish rise to it. Returns false to keep the charge.
   */
  public throwFishFeed(): boolean {
    if (!this.island || !this.player) return false;
    const origin = this.player.getWorldPosition();
    const up = this._feedUp.copy(origin).normalize();
    this._feedFwd.copy(this.orbitCamera.getForwardDirection());
    this._feedFwd.addScaledVector(up, -this._feedFwd.dot(up));
    if (this._feedFwd.lengthSq() < 1e-4) {
      this._feedFwd.copy(this.player.getForwardDirection());
      this._feedFwd.addScaledVector(up, -this._feedFwd.dot(up));
    }
    if (this._feedFwd.lengthSq() < 1e-4) return false;
    this._feedFwd.normalize();
    const ang = GameScene.FISH_FEED_THROW_DIST / Math.max(1, origin.length());
    this._feedDir
      .copy(up)
      .multiplyScalar(Math.cos(ang))
      .addScaledVector(this._feedFwd, Math.sin(ang))
      .normalize();
    // Must land IN water (inverse of the land feeds). No raycast — the seabed
    // would sample far below; the pile floats on the wave surface instead.
    if (!this.island.isOverWater(this._feedDir)) return false;

    if (!GameScene.feedGrainGeo) GameScene.feedGrainGeo = new THREE.SphereGeometry(0.035, 4, 3);
    const seaT = this.island.seaTimeUniform.value;
    const grainMat = GameScene.birdMat(0xe8dcbf); // pale bread
    const pile = new THREE.Group();
    pile.position.copy(this._feedDir).multiplyScalar(this.island.waveHeightAt(this._feedDir, seaT));
    pile.quaternion.setFromUnitVectors(GameScene.AXIS_Y, this._feedDir);
    for (let i = 0; i < 14; i++) {
      const crumb = new THREE.Mesh(GameScene.feedGrainGeo, grainMat);
      const a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random()) * 0.5;
      crumb.position.set(Math.cos(a) * r, 0.005, Math.sin(a) * r);
      crumb.scale.set(1.2 + Math.random() * 0.9, 0.5, 1.2 + Math.random() * 0.9); // flat, floating
      pile.add(crumb);
    }
    pile.scale.setScalar(0.001);
    pile.name = 'fish_feed';
    this.add(pile);
    const toss = new THREE.Group();
    for (let i = 0; i < 7; i++) {
      const crumb = new THREE.Mesh(GameScene.feedGrainGeo, grainMat);
      crumb.position.set(
        (Math.random() - 0.5) * 0.3,
        (Math.random() - 0.5) * 0.2,
        (Math.random() - 0.5) * 0.3,
      );
      toss.add(crumb);
    }
    this.add(toss);
    const time = performance.now() / 1000;
    this.fishFeedPiles.push({
      pile,
      toss,
      from: origin.clone().addScaledVector(up, 1.1),
      dir: this._feedDir.clone(),
      t0: time,
      landed: false,
    });
    while (this.fishFeedPiles.length > 3) this.removeFishFeedPile(0);
    this.callFishToFeed(this._feedDir, time);
    sfx.blip();
    return true;
  }

  /**
   * What a feed throw would target right now, so one Feed control can pick the
   * right feed by where you aim: 'water' → fish food; 'land' → the nearer of
   * cats/birds to the land aim point. 'none' when there's nowhere sane to aim.
   */
  public classifyFeedAim(): { surface: 'water' | 'land' | 'none'; land: 'cat' | 'bird' } {
    const fallback = { surface: 'none' as const, land: 'bird' as const };
    if (!this.island || !this.player) return fallback;
    const origin = this.player.getWorldPosition();
    const up = this._feedUp.copy(origin).normalize();
    this._feedFwd.copy(this.orbitCamera.getForwardDirection());
    this._feedFwd.addScaledVector(up, -this._feedFwd.dot(up));
    if (this._feedFwd.lengthSq() < 1e-4) {
      this._feedFwd.copy(this.player.getForwardDirection());
      this._feedFwd.addScaledVector(up, -this._feedFwd.dot(up));
    }
    if (this._feedFwd.lengthSq() < 1e-4) return fallback;
    this._feedFwd.normalize();
    const R = Math.max(1, origin.length());
    // Look out at the fish-throw distance first: water is detected before the
    // shorter land throw would land.
    const ang = GameScene.FISH_FEED_THROW_DIST / R;
    this._feedDir
      .copy(up)
      .multiplyScalar(Math.cos(ang))
      .addScaledVector(this._feedFwd, Math.sin(ang))
      .normalize();
    if (this.island.isOverWater(this._feedDir)) return { surface: 'water', land: 'bird' };
    // Land: pick whichever animal is nearer the land aim point.
    const ang2 = GameScene.FEED_THROW_DIST / R;
    const landDir = this._feedTmp
      .copy(up)
      .multiplyScalar(Math.cos(ang2))
      .addScaledVector(this._feedFwd, Math.sin(ang2))
      .normalize();
    let landPt: THREE.Vector3;
    try {
      landPt = this.island.sampleSurfaceByDirection(landDir, 0).position;
    } catch {
      return { surface: 'none', land: 'bird' };
    }
    let catD = Infinity;
    let birdD = Infinity;
    for (const c of this.cats) catD = Math.min(catD, c.curPos.distanceToSquared(landPt));
    for (const g of this.groundBirds) birdD = Math.min(birdD, g.homePos.distanceToSquared(landPt));
    return { surface: 'land', land: catD < birdD ? 'cat' : 'bird' };
  }

  /** Set the nearest idle fish swimming toward a fresh bread pile. */
  private callFishToFeed(dir: THREE.Vector3, time: number): void {
    if (!this.island) return;
    const maxAng = GameScene.FISH_FEED_CALL_RADIUS / this.island.getRadius();
    const near = this.fish
      .filter((f) => f.jumpT0 < 0 && (f.feedTarget === null || f.feedUntil <= time))
      .map((f) => ({ f, a: f.dir.angleTo(dir) }))
      .filter((e) => e.a < maxAng)
      .sort((a, b) => a.a - b.a)
      .slice(0, GameScene.FISH_FEED_MAX);
    for (const { f } of near) {
      f.feedTarget = dir.clone();
      f.feedUntil = time + GameScene.FISH_FEED_FEAST_SECONDS;
    }
  }

  private removeFishFeedPile(idx: number): void {
    const p = this.fishFeedPiles[idx];
    if (!p) return;
    for (const f of this.fish) {
      if (f.feedTarget && f.feedTarget.angleTo(p.dir) < 0.05) {
        f.feedTarget = null;
        f.feedUntil = 0;
      }
    }
    this.remove(p.pile);
    this.remove(p.toss);
    this.fishFeedPiles.splice(idx, 1);
  }

  /** Arc the tossed bread over, then float + dwindle the pile on the waves. */
  private updateFishFeedPiles(time: number): void {
    if (!this.island) return;
    const seaT = this.island.seaTimeUniform.value;
    for (let i = this.fishFeedPiles.length - 1; i >= 0; i--) {
      const p = this.fishFeedPiles[i];
      const age = time - p.t0;
      const FLIGHT = 0.5;
      // Re-float on the wave every frame (same seaT the fish ride) so it bobs
      // with the surface instead of sinking or hovering.
      p.pile.position.copy(p.dir).multiplyScalar(this.island.waveHeightAt(p.dir, seaT));
      if (!p.landed) {
        const t = Math.min(1, age / FLIGHT);
        p.toss.position
          .lerpVectors(p.from, p.pile.position, t)
          .addScaledVector(p.dir, Math.sin(Math.PI * t) * 0.5);
        p.toss.rotation.y = t * 6;
        if (t >= 1) {
          p.landed = true;
          p.toss.visible = false;
        }
      } else {
        const life = age - FLIGHT;
        const grow = Math.min(1, life / 0.25);
        const left =
          1 -
          Math.max(0, life - GameScene.FISH_FEED_PILE_LIFE * 0.6) /
            (GameScene.FISH_FEED_PILE_LIFE * 0.4);
        p.pile.scale.setScalar(Math.max(0.001, grow * THREE.MathUtils.clamp(left, 0, 1)));
        if (life > GameScene.FISH_FEED_PILE_LIFE) this.removeFishFeedPile(i);
      }
    }
  }

  /** Send the nearest ground birds flying in to a fresh pile. */
  private callBirdsToFeed(pos: THREE.Vector3, time: number): void {
    if (!this.island) return;
    const near = this.groundBirds
      .filter((g) => g.mode !== 'flyto' && g.feastUntil <= time)
      .map((g) => ({ g, d: g.curPos.distanceTo(pos) }))
      .filter((e) => e.d < GameScene.FEED_CALL_RADIUS)
      .sort((a, b) => a.d - b.d)
      .slice(0, GameScene.FEED_MAX_BIRDS);
    for (let i = 0; i < near.length; i++) {
      const g = near[i].g;
      // Ring the pile so they don't all land on the same grain.
      const a = (i / Math.max(1, near.length)) * Math.PI * 2 + Math.random() * 0.4;
      const r = 0.45 + Math.random() * 0.5;
      const ref =
        Math.abs(this._feedUp.copy(pos).normalize().y) > 0.94 ? GameScene.AXIS_X : GameScene.AXIS_Y;
      const t1 = this._feedTmp.crossVectors(this._feedUp, ref).normalize();
      const t2 = this._feedDir.crossVectors(this._feedUp, t1).normalize();
      const land = pos
        .clone()
        .addScaledVector(t1, Math.cos(a) * r)
        .addScaledVector(t2, Math.sin(a) * r);
      // Height from the pile's RAYCAST radius plus the analytic DELTA — the
      // analytic radius used absolutely is what buried the birds when the two
      // fields diverge (see the seating comment in createGroundBirds).
      const landDir = this._feedFwd.copy(land).normalize();
      const dr =
        this.island.analyticSurface(landDir).radius -
        this.island.analyticSurface(this._feedTmp.copy(pos).normalize()).radius;
      land.copy(landDir).multiplyScalar(pos.length() + dr + 0.185 * g.size + 0.005);
      g.flyFrom.copy(g.mode === 'gone' ? g.homePos : g.bird.position);
      g.flyTo.copy(land);
      g.flyT0 = time;
      g.flyDur = THREE.MathUtils.clamp(near[i].d / 9, 0.9, 3.2);
      g.mode = 'flyto';
      g.feastUntil = time + g.flyDur + GameScene.FEED_FEAST_SECONDS;
      g.bird.visible = true;
      g.bird.scale.setScalar(g.size);
    }
  }

  /**
   * Point a fed bird's bookkeeping back at its home spot. The SURFACE FRAME
   * (up/baseQuat) deliberately stays on the pile — the climb-out still has to
   * launch off the ground the bird is standing on — and is restored when it
   * lands back home.
   */
  private releaseFeastingBird(g: GameScene['groundBirds'][number]): void {
    g.feastUntil = 0;
    g.basePos.copy(g.homePos);
    g.analBase = g.homeAnal;
  }

  /** Rebuild a bird's escape tangent for the surface it is standing on now. */
  private pickGroundBirdEscape(
    g: GameScene['groundBirds'][number],
    player: THREE.Vector3 | null,
  ): void {
    if (player) {
      this._gbScratch.copy(g.curPos).sub(player);
      this._gbScratch.addScaledVector(g.up, -this._gbScratch.dot(g.up));
      if (this._gbScratch.lengthSq() > 0.1) {
        g.away.copy(this._gbScratch).normalize();
        g.heading = this.groundBirdHeadingFor(g, g.away);
        return;
      }
    }
    const ref = Math.abs(g.up.y) > 0.94 ? GameScene.AXIS_X : GameScene.AXIS_Y;
    g.away.crossVectors(g.up, ref).normalize();
    g.away.applyAxisAngle(g.up, Math.random() * Math.PI * 2);
    g.heading = this.groundBirdHeadingFor(g, g.away);
  }

  private removeFeedPile(idx: number): void {
    const p = this.feedPiles[idx];
    if (!p) return;
    // Let go of any bird still committed to this pile, or it would land and
    // mime eating at bare ground for the rest of its feast (and be excluded
    // from the next throw's candidate list).
    for (const g of this.groundBirds) {
      if (g.feastUntil <= 0) continue;
      const anchor = g.mode === 'flyto' ? g.flyTo : g.curPos;
      if (anchor.distanceToSquared(p.to) < 9) {
        this.releaseFeastingBird(g);
        if (g.mode === 'flyto') {
          // Mid-flight with nowhere to land: turn it into a scatter home.
          g.mode = 'flee';
          g.t0 = performance.now() / 1000;
          g.curPos.copy(g.bird.position);
          this.pickGroundBirdEscape(g, null);
        }
      }
    }
    // Same for any cat committed to this pile: send it home so it doesn't
    // trot to (or sit miming at) a pile that no longer exists.
    for (const c of this.cats) {
      if (c.mode !== 'trot' && c.mode !== 'eat') continue;
      const anchor = c.mode === 'trot' ? c.walkTo : c.curPos;
      if (anchor.distanceToSquared(p.to) < 9) {
        c.up.copy(c.homeUp);
        c.baseQuat.copy(c.homeQuat);
        c.analBase = c.homeAnal;
        c.basePos.copy(c.homePos);
        c.feastUntil = 0;
        c.walkFrom.copy(c.curPos);
        c.walkTo.copy(c.homePos);
        c.walkT0 = performance.now() / 1000;
        c.walkDur = Math.max(0.8, c.walkFrom.distanceTo(c.walkTo) / GameScene.CAT_WALK_SPEED);
        c.headingTarget = this.catHeadingFor(c, this._catScratch.copy(c.walkTo).sub(c.walkFrom));
        c.mode = 'walk';
      }
    }
    this.remove(p.pile);
    this.remove(p.toss);
    this.feedPiles.splice(idx, 1);
  }

  /** Arc the tossed grains over, pop the pile in, then let it dwindle away. */
  private updateFeedPiles(time: number): void {
    for (let i = this.feedPiles.length - 1; i >= 0; i--) {
      const p = this.feedPiles[i];
      const age = time - p.t0;
      const FLIGHT = 0.5;
      if (!p.landed) {
        const t = Math.min(1, age / FLIGHT);
        p.toss.position
          .lerpVectors(p.from, p.to, t)
          .addScaledVector(p.up, Math.sin(Math.PI * t) * 0.5);
        p.toss.rotation.y = t * 6;
        if (t >= 1) {
          p.landed = true;
          p.toss.visible = false;
        }
      } else {
        // Pop in, hold, then dwindle as it gets eaten.
        const life = age - FLIGHT;
        const grow = Math.min(1, life / 0.25);
        const left =
          1 - Math.max(0, life - GameScene.FEED_PILE_LIFE * 0.6) / (GameScene.FEED_PILE_LIFE * 0.4);
        const s = grow * THREE.MathUtils.clamp(left, 0, 1);
        p.pile.scale.setScalar(Math.max(0.001, s));
        if (life > GameScene.FEED_PILE_LIFE) {
          this.removeFeedPile(i);
        }
      }
    }
  }

  /** Yaw (about the bird's surface normal) that faces a world direction. */
  private groundBirdHeadingFor(
    g: GameScene['groundBirds'][number],
    worldDir: THREE.Vector3,
  ): number {
    // Express the direction in the bird's surface frame; model forward = -Z.
    this._gbQuat.copy(g.baseQuat).invert();
    this._gbScratch2.copy(worldDir).applyQuaternion(this._gbQuat);
    return Math.atan2(-this._gbScratch2.x, -this._gbScratch2.z);
  }

  // [bodyColour, finColour, scale] — shared by the ocean fish + the catch.
  private static readonly FISH_TYPES: Array<[number, number, number]> = [
    [0xff7a33, 0xffe0b0, 0.5], // clownfish orange
    [0x39a6e6, 0xa6e6ff, 0.5], // blue tang
    [0xccd4dc, 0xf0f6fa, 0.42], // silver
    [0xd98a3a, 0xf2c48a, 0.55], // koi gold
    [0x415a68, 0xb0c8d4, 0.8], // big dark
  ];

  // Fish materials are cached per colour: buildFish is ALSO called every
  // fisherman catch cycle (~every 15-30s), which used to allocate two fresh
  // MeshToonMaterials each time with no dispose — slow GPU-program churn.
  private static fishMatCache = new Map<number, THREE.MeshToonMaterial>();
  private static fishMat(color: number, doubleSide = false): THREE.MeshToonMaterial {
    const key = color + (doubleSide ? 0x2000000 : 0);
    let m = GameScene.fishMatCache.get(key);
    if (!m) {
      m = new THREE.MeshToonMaterial({
        color,
        side: doubleSide ? THREE.DoubleSide : THREE.FrontSide,
      });
      GameScene.fishMatCache.set(key, m);
    }
    return m;
  }

  /** One low-poly fish: elongated body + dorsal fin + a rear tail pivot. */
  private buildFish(bodyC: number, finC: number): { group: THREE.Group; tail: THREE.Object3D } {
    const g = new THREE.Group();
    const bodyMat = GameScene.fishMat(bodyC);
    const finMat = GameScene.fishMat(finC, true);
    const body = new THREE.Mesh(new THREE.OctahedronGeometry(0.32, 0), bodyMat);
    body.scale.set(0.55, 0.72, 1.5); // elongated along −Z (forward)
    body.castShadow = true;
    g.add(body);
    const dorsal = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.26, 3), finMat);
    dorsal.position.set(0, 0.24, 0.04);
    g.add(dorsal);
    const tail = new THREE.Object3D();
    tail.position.set(0, 0, 0.4);
    const tailFin = new THREE.Mesh(new THREE.ConeGeometry(0.18, 0.32, 3), finMat);
    tailFin.rotation.x = -Math.PI / 2; // flare toward +Z (behind)
    tailFin.scale.set(1, 0.45, 1);
    tailFin.position.set(0, 0, 0.16);
    tail.add(tailFin);
    g.add(tail);
    return { group: g, tail };
  }

  /**
   * A few types of low-poly fish circling the coastal ocean. They swim just
   * under the wave surface (backs breaking through so they read through the
   * near-opaque water) and occasionally leap with a splash. Seeded placement
   * → identical on every client; runtime wander is ambient (not networked).
   */
  private createFish(): void {
    if (!this.island) return;
    // Shore-band SCHOOLS, not scattered loners: from the beach (eye ~2u up)
    // the visible sea only reaches ~14u to the horizon, and the old spawn
    // band spread 22 fish over most of the southern hemisphere — at any
    // moment 2-4 were on screen. Three 6-fish schools tethered off the
    // busiest beaches + 4 wide-roaming big solos keep the same headcount
    // where people actually look. One colour per school (real fish school
    // by species).
    const SCHOOLS: Array<[number, number]> = [
      [5.0, 0.14], // the fisherman's beach — the busiest shore
      [1.26, 0.12],
      [3.77, 0.15],
    ];
    const N = 22;
    for (let i = 0; i < N; i++) {
      const solo = i >= 18;
      const [bc, fc, sc] = solo
        ? GameScene.FISH_TYPES[3 + (i % 2)]
        : GameScene.FISH_TYPES[Math.floor(i / 6) % 3];
      const { group, tail } = this.buildFish(bc, fc);
      group.scale.setScalar(solo ? sc * 1.15 : sc * 0.85);
      let dir: THREE.Vector3 = new THREE.Vector3(0, -1, 0);
      let home: THREE.Vector3;
      if (solo) {
        for (let attempt = 0; attempt < 12; attempt++) {
          const lon = Math.random() * Math.PI * 2;
          const lat = 0.02 + Math.random() * 0.16; // visible offshore band
          dir = this.island.dirAt(lon, lat);
          if (dir.y < Math.sin(0.22)) break;
        }
        home = dir.clone();
      } else {
        const [aLon, aLat] = SCHOOLS[Math.floor(i / 6)];
        home = this.island.dirAt(aLon, aLat);
        dir = this.island.dirAt(
          aLon + (Math.random() - 0.5) * 0.06,
          aLat + (Math.random() - 0.5) * 0.05,
        );
      }
      // Initial tangent heading
      const ref = Math.abs(dir.y) > 0.9 ? GameScene._localForward : GameScene._localUp;
      const heading = new THREE.Vector3().crossVectors(ref, dir).normalize();
      this.add(group);
      this.fish.push({
        group,
        tail,
        dir,
        heading,
        home,
        speed: 1.1 + Math.random() * 1.5,
        phase: Math.random() * Math.PI * 2,
        turnAt: 0,
        jumpT0: -1,
        jumpDur: 0,
        // Ride right at the surface so backs/fins break through the (now more
        // opaque) water and read clearly; jumps do the rest.
        depth: 0.02 + Math.random() * 0.07,
        feedTarget: null,
        feedUntil: 0,
      });
    }
    console.log(`🐟 ${this.fish.length} fish in the ocean (3 schools + 4 solos)`);
  }

  /** Prowl the cats: sit → stroll → (fed) trot in → eat → home, plus a calm
   *  step-away if the player crowds them. Sole writer of cat transforms. All
   *  motion is eased (heading, gait, tail, head) so nothing snaps. */
  private updateCats(deltaTime: number, time: number): void {
    if (this.cats.length === 0 || !this.island) return;
    const player = this.player ? this.player.getWorldPosition() : null;
    const turnLerp = 1 - Math.exp(-9 * deltaTime); // heading easing
    const gaitLerp = 1 - Math.exp(-7 * deltaTime); // stride fade-in/out
    for (const c of this.cats) {
      // Calm step-away if the player closes in while idle (feeding cats let
      // you approach — that's the point of the treats).
      if (player && (c.mode === 'sit' || c.mode === 'walk')) {
        if (player.distanceToSquared(c.curPos) < 1.8 * 1.8) {
          this._catScratch.copy(c.curPos).sub(player);
          this._catScratch.addScaledVector(c.up, -this._catScratch.dot(c.up));
          if (this._catScratch.lengthSq() > 0.05) c.away.copy(this._catScratch).normalize();
          c.walkFrom.copy(c.curPos);
          c.walkTo.copy(c.curPos).addScaledVector(c.away, 2.2);
          this.seatCatTarget(c, c.walkTo);
          c.walkT0 = time;
          c.walkDur = Math.max(
            0.5,
            c.walkFrom.distanceTo(c.walkTo) / (GameScene.CAT_TROT_SPEED * 0.9),
          );
          c.headingTarget = this.catHeadingFor(c, this._catScratch2.copy(c.walkTo).sub(c.walkFrom));
          c.mode = 'flee';
        }
      }

      const moving = c.mode === 'walk' || c.mode === 'trot' || c.mode === 'flee';

      // ── Position + mode transitions ──────────────────────────────────────
      if (c.mode === 'sit') {
        c.cat.position.copy(c.curPos);
        if (time > c.stateUntil) this.startCatWalk(c, time);
      } else if (moving) {
        const t = Math.min(1, (time - c.walkT0) / c.walkDur);
        // Linear along the path (constant speed → the leg cadence matches), but
        // reseated onto the surface each frame so it doesn't cut the chord.
        this._catScratch.lerpVectors(c.walkFrom, c.walkTo, t);
        const dir = this._catScratch2.copy(this._catScratch).normalize();
        const r = c.basePos.length() + (this.island.analyticSurface(dir).radius - c.analBase);
        const cadence = c.mode === 'walk' ? 7 : 11;
        const bob = Math.abs(Math.sin(time * cadence + c.phase)) * 0.014 * c.gait;
        c.cat.position.copy(dir).multiplyScalar(r + 0.12 * c.size + 0.005 + bob);
        if (t >= 1) {
          c.curPos.copy(c.walkTo);
          if (c.mode === 'trot') {
            // Arrived at the treats: rebase the surface frame onto the pile
            // (up to ~45deg off on R=50) so the cat sits level while it eats.
            const d = this._catScratch.copy(c.walkTo).normalize();
            const s = this.island.analyticSurface(d);
            c.up.copy(s.normal);
            c.baseQuat.setFromUnitVectors(GameScene.AXIS_Y, s.normal);
            c.basePos.copy(c.walkTo);
            c.analBase = s.radius;
            c.mode = 'eat';
          } else {
            c.mode = 'sit';
            c.stateUntil = time + 2 + Math.random() * 4;
          }
        }
      } else if (c.mode === 'eat') {
        c.cat.position.copy(c.curPos);
        const feasting = c.feastUntil > time;
        if (!feasting) {
          // Treats gone: restore the home surface frame and stroll home.
          c.up.copy(c.homeUp);
          c.baseQuat.copy(c.homeQuat);
          c.analBase = c.homeAnal;
          c.basePos.copy(c.homePos);
          c.feastUntil = 0;
          c.walkFrom.copy(c.curPos);
          c.walkTo.copy(c.homePos);
          c.walkT0 = time;
          c.walkDur = Math.max(0.8, c.walkFrom.distanceTo(c.walkTo) / GameScene.CAT_WALK_SPEED);
          c.headingTarget = this.catHeadingFor(c, this._catScratch.copy(c.walkTo).sub(c.walkFrom));
          c.mode = 'walk';
        } else if (player && player.distanceToSquared(c.curPos) < 1.1 * 1.1) {
          // Startled off its food: end the feast and bolt.
          c.feastUntil = 0;
          this._catScratch.copy(c.curPos).sub(player);
          this._catScratch.addScaledVector(c.up, -this._catScratch.dot(c.up));
          if (this._catScratch.lengthSq() > 0.05) c.away.copy(this._catScratch).normalize();
          c.walkFrom.copy(c.curPos);
          c.walkTo.copy(c.curPos).addScaledVector(c.away, 2.5);
          this.seatCatTarget(c, c.walkTo);
          c.walkT0 = time;
          c.walkDur = 0.9;
          c.headingTarget = this.catHeadingFor(c, this._catScratch2.copy(c.walkTo).sub(c.walkFrom));
          c.mode = 'flee';
        }
      }

      // ── Eased gait + heading (nothing snaps) ─────────────────────────────
      c.gait += ((moving ? 1 : 0) - c.gait) * gaitLerp;
      let dh = c.headingTarget - c.heading;
      dh = Math.atan2(Math.sin(dh), Math.cos(dh)); // shortest-path wrap
      c.heading += dh * turnLerp;

      // ── Legs: swing the hip pivots in diagonal pairs, amplitude by gait ──
      const cadence = c.mode === 'trot' || c.mode === 'flee' ? 11 : 7;
      const swing = Math.sin(time * cadence + c.phase) * 0.6 * c.gait;
      c.legs.children[0].rotation.x = swing; // FL
      c.legs.children[3].rotation.x = swing; // BR
      c.legs.children[1].rotation.x = -swing; // FR
      c.legs.children[2].rotation.x = -swing; // BL

      // ── Tail: base curl-up + a travelling wave down the nested chain ─────
      const active = Math.max(c.gait, c.mode === 'eat' ? 0.7 : 0);
      const wagSpeed = c.mode === 'eat' ? 7 : 3 + c.gait * 3;
      const ampY = 0.1 + 0.16 * active;
      const ampX = 0.05 + 0.06 * active;
      for (let j = 0; j < c.tailJoints.length; j++) {
        const ph = time * wagSpeed - j * 0.7 + c.phase;
        c.tailJoints[j].rotation.set(-0.28 + Math.sin(ph) * ampX, Math.sin(ph) * ampY, 0);
      }

      // ── Head: dip to the food while eating, gentle look-around when idle ─
      if (c.mode === 'eat') {
        c.head.rotation.set(-0.5 + Math.sin(time * 6 + c.phase) * 0.06, 0, 0); // nose-down
      } else {
        c.head.rotation.set(0, c.mode === 'sit' ? Math.sin(time * 0.7 + c.phase) * 0.18 : 0, 0);
      }

      // ── Orient the body: surface align + eased yaw + a gentle walking roll ─
      c.cat.quaternion.copy(c.baseQuat);
      c.cat.rotateY(c.heading);
      const roll = Math.sin(time * cadence * 0.5 + c.phase) * 0.05 * c.gait;
      if (roll !== 0) c.cat.rotateZ(roll);
    }
  }

  /** Soft dark discs that follow the villagers' feet — the moving twin of the
   *  static grounding shadows. One InstancedMesh; analytic normal (no raycasts),
   *  radius taken from each NPC's own seated radius so it sits under the feet. */
  private updateNpcShadows(): void {
    if (!this.island) return;
    const npcs = this.island.getNPCInstances();
    if (npcs.length === 0) return;
    if (!this.npcShadowMesh || this.npcShadowMesh.count !== npcs.length) {
      if (this.npcShadowMesh) {
        this.remove(this.npcShadowMesh);
        (this.npcShadowMesh.material as THREE.Material).dispose();
        this.npcShadowMesh.geometry.dispose();
      }
      const size = 64;
      const cv = document.createElement('canvas');
      cv.width = cv.height = size;
      const ctx = cv.getContext('2d');
      if (!ctx) return;
      const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
      grad.addColorStop(0, 'rgba(0,0,0,0.6)');
      grad.addColorStop(0.5, 'rgba(0,0,0,0.34)');
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, size, size);
      const tex = new THREE.CanvasTexture(cv);
      tex.colorSpace = THREE.SRGBColorSpace;
      const mat = new THREE.MeshBasicMaterial({
        map: tex,
        transparent: true,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      });
      this.npcShadowMesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), mat, npcs.length);
      this.npcShadowMesh.name = 'npc_shadows';
      this.npcShadowMesh.renderOrder = 1;
      this.npcShadowMesh.frustumCulled = false;
      (this.npcShadowMesh.userData as Record<string, unknown>).ignoreOcclusion = true;
      this.add(this.npcShadowMesh);
    }
    const mesh = this.npcShadowMesh;
    const PLANE_NORMAL = GameScene._localForward; // (0,0,1)
    for (let i = 0; i < npcs.length; i++) {
      const o = npcs[i].group;
      o.getWorldPosition(this._nsWorld);
      this._nsDir.copy(this._nsWorld).normalize();
      const s = this.island.analyticSurface(this._nsDir);
      // Radius = the NPC's own seated radius (its feet sit on the surface), so
      // the disc lands under the feet regardless of analytic/raycast drift.
      this._nsPos.copy(this._nsDir).multiplyScalar(this._nsWorld.length() + 0.03);
      this._nsQuat.setFromUnitVectors(PLANE_NORMAL, s.normal);
      this._nsScl.set(1.15, 1.15, 1);
      mesh.setMatrixAt(i, this._nsMat.compose(this._nsPos, this._nsQuat, this._nsScl));
    }
    mesh.instanceMatrix.needsUpdate = true;
  }

  /** Swim + wiggle + jump the fish. Cheap: analytic wave surface, no raycasts. */
  private updateFish(deltaTime: number, time: number): void {
    if (this.fish.length === 0 || !this.island) return;
    const seaT = this.island.seaTimeUniform.value;
    const R = this.island.getRadius();
    const shoreY = Math.sin(0.24);
    // Far-hemisphere cull: fish behind the horizon still burned full wave
    // sampling + basis math (frustum culling only saves the draw).
    this._fishCam.copy(this.camera.position).normalize();
    let wakeBest: (typeof this.fish)[number] | null = null;
    let wakeBestD2 = 400; // only wake fish within 20u of the camera
    let wakeBestR = 0;
    this._fishWakeAccum += deltaTime;
    for (const f of this.fish) {
      if (f.dir.dot(this._fishCam) < -0.05) {
        f.group.visible = false;
        continue;
      }
      f.group.visible = true;
      const feeding = f.feedTarget !== null && time < f.feedUntil;
      // Occasional gentle turn, and a rare leap
      if (time > f.turnAt) {
        f.turnAt = time + 2 + Math.random() * 4;
        // Don't randomize heading while swimming to bread — the noise fights
        // the feed steer and the fish never arrives. Jumps still allowed.
        if (!feeding) f.heading.applyAxisAngle(f.dir, (Math.random() - 0.5) * 1.4).normalize();
        // Jumps launch off a RISING crest (sampled 0.2s ahead) with an entry
        // splash — the old launch was silent/dry and wave-blind. Capped at 2
        // concurrent jumpers so the ripple/spray pools never starve.
        if (f.jumpT0 < 0 && Math.random() < 0.3 && this.activeFishJumps < 2) {
          const wNow = this.island.waveHeightAt(f.dir, seaT);
          const wNext = this.island.waveHeightAt(f.dir, seaT + 0.2);
          if (wNext > wNow) {
            f.jumpT0 = time;
            f.jumpDur = 0.85 + Math.random() * 0.4;
            this.activeFishJumps++;
            this.spawnRipple(f.dir.clone().multiplyScalar(wNow), 0.9, 0.7);
            this.spawnSpray(f.dir.clone().multiplyScalar(wNow), f.heading, 2, 2.2);
          }
        }
      }
      // Fish feed OVERRIDES the beach-avoid + school tether: swim to the bread
      // floating on the surface and rise so the back breaks through. The great-
      // circle advance below then carries the fish in; the wave-Y seats it.
      if (feeding) {
        if (f.dir.angleTo(f.feedTarget as THREE.Vector3) > 0.03) {
          this._fishHome
            .copy(f.feedTarget as THREE.Vector3)
            .addScaledVector(f.dir, -(f.feedTarget as THREE.Vector3).dot(f.dir));
          if (this._fishHome.lengthSq() > 1e-8) f.heading.lerp(this._fishHome.normalize(), 0.35);
        }
        f.depth += (0 - f.depth) * 0.05; // rise to the surface at the bread
      } else {
        if (f.feedTarget !== null) {
          f.feedTarget = null; // feast timed out
          f.depth = 0.05;
        }
        // Steer back to open water if drifting up toward the beach
        if (f.dir.y > shoreY - 0.06) {
          this._fishDown.set(0, -1, 0).addScaledVector(f.dir, f.dir.y).normalize();
          f.heading.lerp(this._fishDown, 0.1);
        }
        // Soft school tether: drifting >0.12 rad (~6u) from home turns the fish
        // back, so schools stay parked off their beach instead of dispersing.
        if (f.dir.angleTo(f.home) > 0.12) {
          this._fishHome.copy(f.home).addScaledVector(f.dir, -f.home.dot(f.dir));
          if (this._fishHome.lengthSq() > 1e-8) {
            f.heading.lerp(this._fishHome.normalize(), 0.08);
          }
        }
      }
      // Keep heading tangent, advance along the great circle
      f.heading.addScaledVector(f.dir, -f.heading.dot(f.dir)).normalize();
      this._fishAxis.crossVectors(f.dir, f.heading);
      if (this._fishAxis.lengthSq() > 1e-8) {
        this._fishAxis.normalize();
        f.dir.applyAxisAngle(this._fishAxis, (f.speed * deltaTime) / R).normalize();
        f.heading.crossVectors(this._fishAxis, f.dir).normalize();
      }
      // Radius: swim near the surface, or arc up for a jump
      const waveR = this.island.waveHeightAt(f.dir, seaT);
      let radius = waveR - f.depth;
      let pitch = 0;
      if (f.jumpT0 >= 0) {
        const p = (time - f.jumpT0) / f.jumpDur;
        if (p >= 1) {
          f.jumpT0 = -1;
          this.activeFishJumps = Math.max(0, this.activeFishJumps - 1);
          this.spawnRipple(f.dir.clone().multiplyScalar(waveR), 1.5, 0.9);
          this.spawnSpray(f.dir.clone().multiplyScalar(waveR), f.heading, 3, 3.2);
        } else {
          radius = waveR + Math.sin(p * Math.PI) * 1.3;
          pitch = Math.cos(p * Math.PI) * 0.9;
        }
      }
      f.group.position.copy(f.dir).multiplyScalar(radius);
      // Track the nearest surface fish for the dorsal wake (no extra pass)
      if (f.jumpT0 < 0) {
        const d2 = f.group.position.distanceToSquared(this.camera.position);
        if (d2 < wakeBestD2) {
          wakeBestD2 = d2;
          wakeBest = f;
          wakeBestR = waveR;
        }
      }
      // Orient: local +Y → up (dir), local −Z → heading
      this._fishZ.copy(f.heading).multiplyScalar(-1);
      this._fishX.crossVectors(f.dir, this._fishZ).normalize();
      this._fishZ.crossVectors(this._fishX, f.dir).normalize();
      this._fishMat.makeBasis(this._fishX, f.dir, this._fishZ);
      f.group.quaternion.setFromRotationMatrix(this._fishMat);
      if (pitch !== 0) f.group.rotateX(pitch);
      // Tail swish
      f.tail.rotation.y = Math.sin(time * 10 + f.phase) * 0.5;
    }
    // Dorsal wake: the nearest surface fish cuts a small foam ring every
    // 0.5s — between jumps they read as floating debris without one.
    if (wakeBest && this._fishWakeAccum > 0.5) {
      this._fishWakeAccum = 0;
      this.spawnRipple(wakeBest.dir.clone().multiplyScalar(wakeBestR), 0.55, 0.6);
    }
  }

  /** Surface radius + normal along a direction (raycast, ideal-sphere fallback). */
  /** Quaternion orienting local +Y → up and model-forward (−Z) → fwd. */
  private orientQuat(up: THREE.Vector3, fwd: THREE.Vector3): THREE.Quaternion {
    const z = fwd.clone().multiplyScalar(-1);
    const x = new THREE.Vector3().crossVectors(up, z).normalize();
    z.crossVectors(x, up).normalize();
    return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, up, z));
  }

  /** Orient an object so its local +Y = up and its model-forward (−Z) = fwd. */
  private orientObj(obj: THREE.Object3D, up: THREE.Vector3, fwd: THREE.Vector3): void {
    obj.quaternion.copy(this.orientQuat(up, fwd));
  }

  // Footprints of things placed via findPlacement (kept separate from the
  // player-collision `colliders`, though it also reads those) so later
  // placements avoid earlier ones.
  private placedObstacles: Array<{ pos: THREE.Vector3; radius: number }> = [];

  /**
   * Context-aware placement: search outward from an anchor for a surface spot
   * that respects land/water, slope, pathways, and other objects, then orient
   * the thing to face the street / water / a target. Returns null only if the
   * whole search area is unusable (caller can fall back).
   *
   * This is the single seam every prop should go through instead of a
   * hand-picked lon/lat — it "knows" about the world around the spot.
   */
  private findPlacement(intent: {
    anchor: THREE.Vector3; // unit dir to search around
    footprint: number; // world-unit half-clearance the object needs
    searchArc?: number; // max angular search radius (rad)
    water?: boolean; // must be over water (default false → dry land)
    minLat?: number; // latitude floor (rad)
    maxLat?: number; // latitude ceiling (rad)
    maxSlope?: number; // reject steeper ground (rad)
    avoidStreet?: boolean; // keep off pathways (default: true on land)
    face?: 'street' | 'water' | 'inland' | 'anchor' | 'point';
    facePoint?: THREE.Vector3; // for face:'point'
    register?: boolean; // record the footprint for later placements (default true)
  }): {
    dir: THREE.Vector3;
    position: THREE.Vector3;
    normal: THREE.Vector3;
    faceDir: THREE.Vector3;
    quaternion: THREE.Quaternion;
  } | null {
    const island = this.island;
    if (!island) return null;
    const R = island.getRadius();
    const searchArc = intent.searchArc ?? 0.3;
    const maxSlope = intent.maxSlope ?? 0.32;
    const water = !!intent.water;
    const avoidStreet = intent.avoidStreet ?? !water;
    const minLat = intent.minLat ?? (water ? -Math.PI / 2 : 0.3);
    const maxLat = intent.maxLat ?? Math.PI / 2;
    const anchor = intent.anchor.clone().normalize();

    // Tangent frame at the anchor for a geodesic golden-spiral search
    const ref = Math.abs(anchor.y) > 0.9 ? GameScene._localForward : GameScene._localUp;
    const tanX = new THREE.Vector3().crossVectors(ref, anchor).normalize();
    const tanY = new THREE.Vector3().crossVectors(anchor, tanX).normalize();

    // Only STRUCTURES (houses/buildings, radius ≥ 1.2) and previously-placed
    // things are hard obstacles. Small props (lamps, mailboxes, benches,
    // flowers) are fine to sit beside — requiring metres of clearance from
    // every lamppost would leave nowhere to build in a village.
    // Trees are a special case: their collider is only the ~0.35 trunk, but the
    // canopy is much wider, so avoid clipping foliage by keeping clear of the
    // tree centres.
    const treeCanopy = 1.4;
    const trees = this.swayTrees.map((t) => t.group.position);
    const clearOf = (pos: THREE.Vector3): number => {
      let min = Infinity;
      for (const c of this.colliders)
        if (c.radius >= 1.2) min = Math.min(min, pos.distanceTo(c.position) - c.radius);
      for (const o of this.placedObstacles) min = Math.min(min, pos.distanceTo(o.pos) - o.radius);
      for (const t of trees) min = Math.min(min, pos.distanceTo(t) - treeCanopy);
      return min;
    };
    const faceFor = (
      dir: THREE.Vector3,
      normal: THREE.Vector3,
      pos: THREE.Vector3,
    ): THREE.Vector3 => {
      const proj = (v: THREE.Vector3) =>
        v.clone().addScaledVector(normal, -v.dot(normal)).normalize();
      const seaward = proj(new THREE.Vector3(0, -1, 0).addScaledVector(dir, dir.y));
      const mode = intent.face ?? (avoidStreet ? 'street' : 'water');
      if (mode === 'water') return seaward;
      if (mode === 'inland') return seaward.negate();
      if (mode === 'anchor') return proj(anchor.clone().multiplyScalar(R).sub(pos));
      if (mode === 'point' && intent.facePoint) return proj(intent.facePoint.clone().sub(pos));
      // 'street': face the nearest pathway, else fall back to inland
      const sd = island.nearestStreetDir(dir, 0.4);
      if (sd) return proj(sd.multiplyScalar(R).sub(pos));
      return seaward.negate();
    };

    const golden = Math.PI * (3 - Math.sqrt(5));
    const N = 120;
    let best: {
      pos: THREE.Vector3;
      dir: THREE.Vector3;
      normal: THREE.Vector3;
      clear: number;
    } | null = null;
    for (let i = 0; i < N; i++) {
      const arc = searchArc * Math.sqrt((i + 0.5) / N); // area-uniform outward
      const ang = i * golden;
      const tangent = tanX
        .clone()
        .multiplyScalar(Math.cos(ang))
        .addScaledVector(tanY, Math.sin(ang));
      const dir = anchor
        .clone()
        .multiplyScalar(Math.cos(arc))
        .addScaledVector(tangent, Math.sin(arc))
        .normalize();

      const lat = Math.asin(THREE.MathUtils.clamp(dir.y, -1, 1));
      if (lat < minLat || lat > maxLat) continue;
      if (island.isOverWater(dir) !== water) continue;
      if (avoidStreet && island.isNearStreet(dir)) continue;

      let position: THREE.Vector3;
      let normal: THREE.Vector3;
      if (water) {
        position = dir.clone().multiplyScalar(island.waveHeightAt(dir, 0));
        normal = dir.clone();
      } else {
        const s = island.sampleSurfaceByDirection(dir, 0.02);
        const raw = (s as { rawNormal?: THREE.Vector3 }).rawNormal ?? s.normal;
        if (raw.angleTo(dir) > maxSlope) continue; // too steep
        position = s.position.clone();
        normal = s.normal.clone();
      }

      const clear = clearOf(position);
      if (clear >= intent.footprint) {
        const faceDir = faceFor(dir, normal, position);
        if (intent.register ?? true)
          this.placedObstacles.push({ pos: position.clone(), radius: intent.footprint });
        return { dir, position, normal, faceDir, quaternion: this.orientQuat(normal, faceDir) };
      }
      if (!best || clear > best.clear) best = { pos: position, dir, normal, clear };
    }

    // Best-effort: nothing perfectly clear, take the roomiest valid-terrain spot
    if (best) {
      const faceDir = faceFor(best.dir, best.normal, best.pos);
      if (intent.register ?? true)
        this.placedObstacles.push({ pos: best.pos.clone(), radius: intent.footprint });
      return {
        dir: best.dir,
        position: best.pos,
        normal: best.normal,
        faceDir,
        quaternion: this.orientQuat(best.normal, faceDir),
      };
    }
    return null;
  }

  /** A little beachfront fish stall: counter, awning, ice crate, sign. Returns
   * the group + local counter slot positions where sold fish are laid out. */
  private buildFishShop(): { group: THREE.Group; slots: THREE.Vector3[] } {
    const g = new THREE.Group();
    const wood = new THREE.MeshToonMaterial({ color: 0x9c6b3f });
    const dark = new THREE.MeshToonMaterial({ color: 0x5c3d22 });
    const stripe = new THREE.MeshToonMaterial({ color: 0x2f7fae, side: THREE.DoubleSide });
    const stripe2 = new THREE.MeshToonMaterial({ color: 0xf2f2f2, side: THREE.DoubleSide });
    // Counter (front toward the beach = −Z), on legs
    const counter = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.14, 0.95), wood);
    counter.position.set(0, 0.92, -0.95);
    counter.castShadow = true;
    g.add(counter);
    for (const sx of [-1.05, 1.05])
      for (const sz of [-1.32, -0.6]) {
        const leg = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.92, 0.1), dark);
        leg.position.set(sx, 0.46, sz);
        g.add(leg);
      }
    // Back posts + a striped awning slanting toward the beach
    for (const sx of [-1.15, 1.15]) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 2.1, 6), dark);
      post.position.set(sx, 1.05, 0.15);
      post.castShadow = true;
      g.add(post);
    }
    for (let i = 0; i < 5; i++) {
      const panel = new THREE.Mesh(
        new THREE.BoxGeometry(0.52, 0.05, 1.7),
        i % 2 ? stripe2 : stripe,
      );
      panel.position.set(-1.04 + i * 0.52, 2.05 - 0.28, -0.55);
      panel.rotation.x = -0.32;
      panel.castShadow = true;
      g.add(panel);
    }
    // Ice crate on the counter
    const crate = new THREE.Mesh(
      new THREE.BoxGeometry(0.95, 0.22, 0.66),
      new THREE.MeshToonMaterial({ color: 0xd4eaf4 }),
    );
    crate.position.set(-0.72, 1.1, -0.95);
    g.add(crate);
    // "Fresh Fish" sign hanging under the awning
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 96;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.fillStyle = '#20303c';
      ctx.fillRect(0, 0, 256, 96);
      ctx.font = '600 34px system-ui, sans-serif';
      ctx.fillStyle = '#ffe0a0';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('🐟 Fresh Fish', 128, 50);
    }
    const sign = new THREE.Mesh(
      // 1.0×0.375 keeps the 256×96 canvas aspect. The old 1.5×0.56 plane at
      // y1.75 topped out at 2.03 — through the sloping awning, whose
      // underside sits at ≈1.48 over the sign's z.
      new THREE.PlaneGeometry(1.0, 0.375),
      new THREE.MeshBasicMaterial({
        map: new THREE.CanvasTexture(canvas),
        transparent: true,
        side: THREE.DoubleSide,
      }),
    );
    // Hangs UNDER the awning: top 1.42 clears the panel underside (≈1.48 at
    // z=−1.35), bottom 1.04 clears the counter top (0.99).
    sign.position.set(0, 1.23, -1.35);
    sign.rotation.y = Math.PI; // face the beach/water side (front = −Z)
    g.add(sign);
    // Counter display slots
    const slots: THREE.Vector3[] = [];
    for (let i = 0; i < 5; i++) slots.push(new THREE.Vector3(0.15 + (i - 2) * 0.34, 1.02, -0.95));
    return { group: g, slots };
  }

  /**
   * Relocate the Fisherman to the shore and set up his fishing routine (rig +
   * a fish stall). The routine runs in updateFisherman(); the wander loop skips
   * him.
   */
  private setupFisherman(): void {
    if (!this.island) return;
    const npc = this.island.npcTargets.find((n) => n.name === 'Fisherman');
    if (!npc) return;
    // Fishing spot: the water's edge on the widest open beach (the gap between
    // district plazas at lon 0/1.26/2.51/3.77), facing out to sea.
    const spotPlace = this.findPlacement({
      anchor: this.island.dirAt(5.0, 0.3),
      footprint: 1.0,
      searchArc: 0.18,
      minLat: 0.285,
      maxLat: 0.33,
      avoidStreet: false,
      face: 'water',
      register: false, // a person barely blocks — don't reserve the spot
    });
    if (!spotPlace) return;
    const seaward = spotPlace.faceDir;

    // Fish stall: on land just behind the spot, its front facing inland toward
    // the village where customers come down from.
    const stallPlace = this.findPlacement({
      anchor: spotPlace.dir.clone().addScaledVector(seaward, -0.07).normalize(),
      footprint: 2.2,
      searchArc: 0.2,
      minLat: 0.3,
      maxLat: 0.46,
      face: 'inland',
    });
    if (!stallPlace) return;

    // ── Hug the waterline ────────────────────────────────────────────────
    // The placement band above (lat 0.285-0.33) is dry land: the continent
    // mask makes everything above sinLat ~0.28+coastWarp FULL land with the
    // 0.75 land floor, so the raw spot sits 0.65-1.5u ABOVE the waterline —
    // and the real waterline (lat ~0.20 ± coast warp) is 4-6.5u further
    // seaward, so a fixed 2.6u cast landed the bobber on dry sand. March
    // seaward along the great circle with the ANALYTIC terrain (setup-only,
    // zero per-frame cost) until his feet are ankle-deep, size the cast so
    // the bobber hangs over open water, and solve the line drop that seats
    // it exactly ON the calm sea surface. Wading is safe: the wander loop
    // skips him and updateFisherman() re-anchors his position every frame.
    const seaR = this.island.seaLevel();
    const marchAxis = new THREE.Vector3().crossVectors(spotPlace.dir, seaward).normalize();
    const probe = new THREE.Vector3();
    const step = 0.004; // ~0.2u of arc at R=50
    let spotDir = spotPlace.dir;
    let spotR = spotPlace.position.length();
    let spotN = spotPlace.normal;
    for (let a = step; a <= 0.24; a += step) {
      probe.copy(spotPlace.dir).applyAxisAngle(marchAxis, a);
      const s = this.island.analyticSurface(probe);
      if (s.radius < seaR - 0.06) {
        spotDir = probe.clone();
        spotR = s.radius;
        spotN = s.normal;
        break;
      }
    }
    // Cast length: the first arc where the water is deep enough that wave
    // troughs (~0.45 below mean sea) never expose the sand under the bobber;
    // falls back to the deepest point within ~5u.
    let castArc = step;
    let bestDepth = -Infinity;
    for (let a = step; a <= 0.1; a += step) {
      probe.copy(spotDir).applyAxisAngle(marchAxis, a);
      const depth = seaR - this.island.analyticSurface(probe).radius;
      if (depth > bestDepth) {
        bestDepth = depth;
        castArc = a;
      }
      if (depth > 0.55) break;
    }
    const castLen = THREE.MathUtils.clamp(castArc * spotR + 0.4, 2.0, 4.0);
    // Bobber local -Y at which it sits ON the sea surface (floored above the
    // terrain in case a freak coast leaves the whole cast shallow).
    const spotPos = spotDir.clone().multiplyScalar(spotR);
    const bobW = new THREE.Vector3(0.12, 0, -castLen)
      .applyQuaternion(this.orientQuat(spotN, seaward))
      .add(spotPos);
    const bobTerrain = this.island.analyticSurface(bobW.clone().normalize()).radius;
    const dropBase = Math.min(bobW.length() - seaR, bobW.length() - bobTerrain - 0.06);

    // Rig (rod + line + bobber): world-placed each frame, children forward = −Z
    const rig = new THREE.Group();
    const rod = new THREE.Mesh(
      new THREE.CylinderGeometry(0.018, 0.03, 1.4, 6),
      new THREE.MeshToonMaterial({ color: 0x6b4a2a }),
    );
    rod.castShadow = true;
    rig.add(rod);
    const rodTip = new THREE.Object3D();
    rig.add(rodTip);
    const line = new THREE.Mesh(
      new THREE.CylinderGeometry(0.006, 0.006, 1, 4),
      new THREE.MeshBasicMaterial({ color: 0xeeeeee }),
    );
    rig.add(line);
    const bobber = new THREE.Mesh(
      new THREE.SphereGeometry(0.07, 8, 6),
      new THREE.MeshToonMaterial({ color: 0xdd3b3b, emissive: 0x551111 }),
    );
    rig.add(bobber);
    this.add(rig);

    // Build + place the stall, then bake its counter slots into world space
    const { group: shop, slots: localSlots } = this.buildFishShop();
    shop.position.copy(stallPlace.position);
    shop.quaternion.copy(stallPlace.quaternion);
    this.add(shop);
    shop.updateMatrixWorld(true);
    const slots = localSlots.map((s) => shop.localToWorld(s.clone()));

    this.fisherman = {
      npc,
      rig,
      rod,
      rodTip,
      line,
      bobber,
      caught: null,
      spot: {
        dir: spotDir,
        r: spotR,
        n: spotN,
        seaward,
      },
      stand: {
        dir: stallPlace.dir,
        r: stallPlace.position.length(),
        n: stallPlace.normal,
        face: stallPlace.faceDir,
      },
      shop,
      slots,
      sold: [],
      coins: [],
      state: 'cast',
      t0: performance.now() / 1000,
      waitDur: 0,
      hasCatch: false,
      catchIdx: 0,
      castLen,
      dropBase,
    };
    console.log(
      `🎣 Fisherman set up: feet ${(seaR - spotR).toFixed(2)}u deep, cast ${castLen.toFixed(1)}u`,
    );
  }

  /** A gold coin that pops above the stall on a sale, rising + spinning + fading. */
  private spawnFishermanCoin(pos: THREE.Vector3, up: THREE.Vector3): void {
    const F = this.fisherman;
    if (!F) return;
    const mesh = new THREE.Mesh(
      new THREE.CylinderGeometry(0.12, 0.12, 0.03, 12),
      new THREE.MeshBasicMaterial({ color: 0xffd34a, transparent: true, opacity: 1 }),
    );
    mesh.position.copy(pos);
    mesh.quaternion.setFromUnitVectors(GameScene._localUp, up);
    mesh.userData.n = up.clone();
    this.add(mesh);
    F.coins.push({ mesh, t0: performance.now() / 1000 });
  }

  /**
   * The fisherman's routine state machine: cast → wait for a bite → reel (a
   * ~60% chance of a fish) → carry the catch to his stall → sell it (coin pop,
   * fish laid on the counter) → walk back → cast again.
   */
  /**
   * Swing a villager's arms and legs on the same walk cycle the player uses.
   *
   * npc.glb is rigged by scripts/rig-npc.py with the SAME bone names the
   * player's rig uses (armL/armR/legL/legR), so this is the identical
   * name-match + `rotation.x` swing as SimplePlayer's procedural cycle —
   * contralateral (each arm opposes the same-side leg), arms at 70% of the
   * leg amplitude, eased back to rest when the NPC stops.
   *
   * The phase is the wander loop's accumulated ground distance (`w.dist`, the
   * same channel the bob and waddle ride) rather than wall time, so the stride
   * stays locked to the feet at any speed, and `i * 1.7` keeps the crowd from
   * marching in lockstep.
   */
  private swingNpcLimbs(
    ref: THREE.Object3D,
    w: { dist: number },
    moving: boolean,
    idx: number,
    deltaTime: number,
  ): void {
    const ud = ref.userData as { limbs?: NpcLimbCache | null };
    if (ud.limbs === undefined) ud.limbs = this.cacheNpcLimbs(ref);
    const limbs = ud.limbs;
    if (!limbs) return;
    // Contralateral swing: each arm opposes the same-side leg, arms at 70% of
    // the leg amplitude. 0.34 rad, not the player's 0.55 — villagers stroll at
    // ~1.4u/s where the player's figure is sprinting, and screenshot-checked
    // 0.55 put them in a near-splits stride.
    const swing = Math.sin(w.dist * 8 + idx * 1.7) * 0.34;
    const ease = 1 - Math.min(1, 8 * deltaTime);
    for (let n = 0; n < limbs.length; n++) {
      const l = limbs[n];
      l.ang = moving ? swing * GameScene.NPC_LIMB_MIX[n] : l.ang * ease;
      // Compose ONTO the rest pose. Writing bone.rotation.x directly (as the
      // player does with its own rig) DESTROYS the rest orientation — these
      // bones are authored pointing straight down and carry a non-identity
      // rest rotation, so overwriting one Euler component threw the arms and
      // legs upward. Rotating about the model's own side-axis, expressed in
      // bone space, is also independent of however the exporter rolled them.
      l.b.quaternion.copy(l.rest).multiply(this._npcLimbQ.setFromAxisAngle(l.axis, l.ang));
    }
  }

  /**
   * Cache the four limb bones with their REST orientation and the swing axis
   * (the villager's local X — its side axis — expressed in each bone's own
   * space). Returns null for unrigged villagers (the /assetKits fallback
   * models have no bones) so they are never re-traversed.
   */
  private cacheNpcLimbs(ref: THREE.Object3D): NpcLimbCache | null {
    const found: Record<string, THREE.Object3D> = {};
    ref.traverse((o) => {
      if ((o as THREE.Bone).isBone && GameScene.NPC_LIMB_BONES.includes(o.name)) found[o.name] = o;
    });
    if (!GameScene.NPC_LIMB_BONES.every((n) => found[n])) return null;
    ref.updateMatrixWorld(true);
    const groupQ = ref.getWorldQuaternion(new THREE.Quaternion());
    const sideWorld = new THREE.Vector3(1, 0, 0).applyQuaternion(groupQ);
    return GameScene.NPC_LIMB_BONES.map((n) => {
      const b = found[n];
      const boneQ = b.getWorldQuaternion(new THREE.Quaternion());
      return {
        b,
        rest: b.quaternion.clone(),
        axis: sideWorld.clone().applyQuaternion(boneQ.invert()).normalize(),
        ang: 0,
      };
    });
  }

  /**
   * Pin both Market Vendors behind their stall counters.
   *
   * They are the only personas the activity engine deliberately has no plan
   * for (getGoal returns null ⇒ plain random wander), and they used to spawn
   * in the Personal hamlet — a district away from every stall — so six market
   * stalls stood unstaffed while two vendors drifted around the wrong
   * neighbourhood. Island.ts now spawns them at their pitches; this pins them
   * there and the wander loop skips them, exactly like the Fisherman/Baker.
   */
  private setupVendors(): void {
    if (!this.island) return;
    const found = this.island.npcTargets.filter((n) => n.name === 'Market Vendor');
    const stalls = this.island.stallProps;
    for (let vi = 0; vi < found.length; vi++) {
      const npc = found[vi];
      // Stand BEHIND a real stall: take the stall's own seat and step away
      // from the shopper spot in front of it. Deriving from the actual prop
      // (rather than a hardcoded lat) survives claimOffStreet sliding it.
      let dir = npc.meshRef.position.clone().normalize();
      // Both pitches on the NORTH kerb (indices 0..2), spread apart. The south
      // row sits on the shoreline slope, where a 1.15u step back also drops
      // ~2.5u of terrain — the vendor ended up correctly behind the counter
      // but well below it. The north row is flat.
      const si = vi === 0 ? 0 : 2;
      if (stalls[si] && this.island.stallSites[si]) {
        // Rotate the stall's dir by a fixed ARC along the away-from-shopper
        // tangent. Adding a chord to a radius-50 vector and re-normalising
        // loses most of the offset to the radial component, which is why the
        // first attempt landed a vendor ~3u out instead of just behind.
        const up = stalls[si].clone().normalize();
        const behind = stalls[si].clone().sub(this.island.stallSites[si]);
        behind.addScaledVector(up, -behind.dot(up)); // tangent only
        if (behind.lengthSq() > 1e-6) {
          behind.normalize();
          const ang = GameScene.VENDOR_STAND_BACK / this.island.getRadius();
          dir = up.multiplyScalar(Math.cos(ang)).addScaledVector(behind, Math.sin(ang)).normalize();
        }
      }
      let surf: { position: THREE.Vector3; normal: THREE.Vector3 };
      try {
        surf = this.island.sampleSurfaceByDirection(dir, 0);
      } catch {
        continue;
      }
      const quat = new THREE.Quaternion().setFromUnitVectors(GameScene.AXIS_Y, surf.normal);
      npc.meshRef.position.copy(surf.position);
      npc.meshRef.quaternion.copy(quat);
      // Face the market street: the counter is between the two stall rows, so
      // look along the tangent toward the nearest boulevard point.
      const street = this.island.nearestStreetDir(dir, 0.6);
      if (street) {
        const target = street.multiplyScalar(this.island.getRadius());
        this._sailTmp.subVectors(target, surf.position);
        this._sailTmp.addScaledVector(surf.normal, -this._sailTmp.dot(surf.normal));
        if (this._sailTmp.lengthSq() > 1e-6) {
          npc.meshRef.quaternion.copy(this.orientQuat(surf.normal, this._sailTmp.normalize()));
        }
      }
      npc.position.copy(surf.position);
      this.vendors.push({
        npc,
        pos: surf.position.clone(),
        quat: npc.meshRef.quaternion.clone(),
        phase: Math.random() * Math.PI * 2,
      });
    }
  }

  /** Vendors keep their pitch: a slow serving sway, arms working the counter. */
  private updateVendors(time: number): void {
    for (const v of this.vendors) {
      const bob = (Math.sin(time * 1.6 + v.phase) + 1) * 0.02;
      v.npc.meshRef.position.copy(v.pos).addScaledVector(v.pos.clone().normalize(), bob);
      v.npc.meshRef.quaternion.copy(v.quat);
      const limbs = (v.npc.meshRef.userData as { limbs?: NpcLimbCache | null }).limbs;
      if (limbs === undefined) {
        (v.npc.meshRef.userData as { limbs?: NpcLimbCache | null }).limbs = this.cacheNpcLimbs(
          v.npc.meshRef,
        );
        continue;
      }
      if (!limbs) continue;
      // Hands busy over the counter: arms swing gently out of phase.
      const a = Math.sin(time * 1.9 + v.phase) * 0.4 - 0.35;
      const b = Math.sin(time * 1.9 + v.phase + 1.1) * 0.4 - 0.35;
      limbs[2].ang = a;
      limbs[3].ang = b;
      limbs[2].b.quaternion
        .copy(limbs[2].rest)
        .multiply(this._npcLimbQ.setFromAxisAngle(limbs[2].axis, a));
      limbs[3].b.quaternion
        .copy(limbs[3].rest)
        .multiply(this._npcLimbQ.setFromAxisAngle(limbs[3].axis, b));
    }
  }

  private updateFisherman(time: number, dt: number): void {
    const F = this.fisherman;
    if (!F || !this.island) return;
    const bob = (Math.sin(time * 2) + 1) * 0.008;

    // Sale coins: rise + spin + fade, independent of state
    for (let i = F.coins.length - 1; i >= 0; i--) {
      const c = F.coins[i];
      const p = (time - c.t0) / 1.0;
      if (p >= 1) {
        this.remove(c.mesh);
        F.coins.splice(i, 1);
        continue;
      }
      c.mesh.position.addScaledVector(c.mesh.userData.n as THREE.Vector3, dt * 0.9);
      c.mesh.rotation.y += dt * 6;
      (c.mesh.material as THREE.MeshBasicMaterial).opacity = 1 - p;
    }

    if (F.state === 'cast' || F.state === 'wait' || F.state === 'reel') {
      // Standing at the water with the rig out
      F.rig.visible = true;
      F.npc.meshRef.position
        .copy(F.spot.dir)
        .multiplyScalar(F.spot.r)
        .addScaledVector(F.spot.n, bob);
      F.npc.position.copy(F.npc.meshRef.position);
      this.orientObj(F.npc.meshRef, F.spot.n, F.spot.seaward);
      F.rig.position.copy(F.npc.meshRef.position);
      F.rig.quaternion.copy(F.npc.meshRef.quaternion);

      const st = time - F.t0;
      let theta = 0.85; // rod elevation over the water
      let bobberFwd = F.castLen;
      let bobberDrop = F.dropBase;
      if (F.state === 'cast') {
        // Whip the rod back then forward, then the line lands
        const p = Math.min(st / 1.0, 1);
        theta = 1.35 - Math.sin(p * Math.PI) * 0.85;
        bobberFwd = 0.6 + p * (F.castLen - 0.6);
        // Arc the bobber over the water: dropBase sits AT the surface, so a
        // straight slide would drag it submerged for the whole flight.
        bobberDrop = F.dropBase - Math.sin(p * Math.PI) * 0.4;
        if (p >= 1) {
          F.state = 'wait';
          F.t0 = time;
          F.waitDur = 3 + Math.random() * 5;
          this.spawnRipple(F.bobber.getWorldPosition(new THREE.Vector3()), 1.0, 0.9);
        }
      } else if (F.state === 'wait') {
        theta = 0.9 + Math.sin(time * 0.8) * 0.05;
        bobberDrop = F.dropBase - Math.sin(time * 1.6) * 0.05;
        if (st > F.waitDur) {
          F.state = 'reel';
          F.t0 = time;
          F.hasCatch = Math.random() < 0.6;
          if (F.hasCatch) {
            F.catchIdx = Math.floor(Math.random() * GameScene.FISH_TYPES.length);
            const [bc, fc, sc] = GameScene.FISH_TYPES[F.catchIdx];
            const cf = this.buildFish(bc, fc).group;
            cf.scale.setScalar(sc * 0.7);
            this.add(cf);
            F.caught = cf;
          }
          this.spawnRipple(F.bobber.getWorldPosition(new THREE.Vector3()), 0.7, 0.8);
        }
      } else {
        // reel: pull the rod up, the bobber (and catch) lift out of the water
        const p = Math.min(st / 1.4, 1);
        theta = 0.9 + p * 0.7;
        bobberFwd = F.castLen - p * (F.castLen - 0.7);
        bobberDrop = F.dropBase - p * 0.7;
        if (p >= 1) {
          F.state = F.hasCatch ? 'toShop' : 'cast';
          F.t0 = time;
        }
      }

      // Rig geometry (rod up + seaward = −Z; line to the bobber)
      const hand = new THREE.Vector3(0.12, 0.9, -0.05);
      const rodDir = new THREE.Vector3(0, Math.sin(theta), -Math.cos(theta));
      F.rod.quaternion.setFromUnitVectors(GameScene._localUp, rodDir);
      F.rod.position.copy(hand).addScaledVector(rodDir, 0.7);
      F.rodTip.position.copy(hand).addScaledVector(rodDir, 1.4);
      const bobberLocal = new THREE.Vector3(0.12, -bobberDrop, -bobberFwd);
      F.bobber.position.copy(bobberLocal);
      const delta = bobberLocal.clone().sub(F.rodTip.position);
      const len = delta.length() || 0.001;
      F.line.position.copy(F.rodTip.position).add(bobberLocal).multiplyScalar(0.5);
      F.line.quaternion.setFromUnitVectors(GameScene._localUp, delta.multiplyScalar(1 / len));
      F.line.scale.set(1, len, 1);
      // Dangle the hooked fish just under the bobber while reeling
      if (F.state === 'reel' && F.caught) {
        F.caught.position
          .copy(F.rig.localToWorld(bobberLocal.clone()))
          .addScaledVector(F.spot.n, -0.18);
        this.orientObj(F.caught, F.spot.n, F.spot.seaward);
        F.caught.rotateX(Math.PI / 2 + Math.sin(time * 20) * 0.3); // flapping
      }
      return;
    }

    if (F.state === 'toShop' || F.state === 'toSpot') {
      // Walk between the fishing spot and the stall
      F.rig.visible = false;
      const from = F.state === 'toShop' ? F.spot : F.stand;
      const to = F.state === 'toShop' ? F.stand : F.spot;
      const fromW = from.dir.clone().multiplyScalar(from.r);
      const toW = to.dir.clone().multiplyScalar(to.r);
      const p = Math.min((time - F.t0) / 2.2, 1);
      const ease = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
      const pos = fromW.clone().lerp(toW, ease);
      const n = pos.clone().normalize();
      // Endpoint radii are exact; mid-walk, blend toward the analytic terrain
      // so the (now much lower) waterline spot doesn't leave him floating
      // above or cutting into the beach slope on the way. Analytic terrain is
      // ~0.003ms and this walk branch already allocates per frame.
      const chordR = THREE.MathUtils.lerp(from.r, to.r, ease);
      const terrR = this.island.analyticSurface(n).radius;
      pos.copy(n).multiplyScalar(THREE.MathUtils.lerp(chordR, terrR, Math.sin(Math.PI * p)));
      const walkBob = Math.abs(Math.sin(time * 8)) * 0.04;
      F.npc.meshRef.position.copy(pos).addScaledVector(n, walkBob);
      F.npc.position.copy(F.npc.meshRef.position);
      const travel = toW.clone().sub(fromW);
      travel.addScaledVector(n, -travel.dot(n)).normalize();
      this.orientObj(F.npc.meshRef, n, travel);
      // Carry the catch overhead on the way to the stall
      if (F.caught && F.state === 'toShop') {
        F.caught.position.copy(pos).addScaledVector(n, 1.15).addScaledVector(travel, 0.25);
        this.orientObj(F.caught, n, travel);
        F.caught.rotateZ(Math.sin(time * 6) * 0.2);
      }
      if (p >= 1) {
        F.state = F.state === 'toShop' ? 'sell' : 'cast';
        F.t0 = time;
      }
      return;
    }

    // state === 'sell': lay the catch on the counter, pop a coin
    F.rig.visible = false;
    F.npc.meshRef.position
      .copy(F.stand.dir)
      .multiplyScalar(F.stand.r)
      .addScaledVector(F.stand.n, bob);
    F.npc.position.copy(F.npc.meshRef.position);
    this.orientObj(F.npc.meshRef, F.stand.n, F.stand.face);
    const sp2 = Math.min((time - F.t0) / 1.4, 1);
    const slot = F.slots[F.sold.length % F.slots.length];
    if (F.caught) {
      const hand = F.npc.meshRef.position
        .clone()
        .addScaledVector(F.stand.n, 1.1)
        .addScaledVector(F.stand.face, 0.3);
      F.caught.position.copy(hand).lerp(slot, Math.min(sp2 * 1.3, 1));
      this.orientObj(F.caught, F.stand.n, F.stand.face);
    }
    if (sp2 >= 1) {
      if (F.caught) {
        F.caught.position.copy(slot);
        F.sold.push(F.caught);
        if (F.sold.length > F.slots.length) {
          const old = F.sold.shift();
          if (old) this.remove(old);
        }
        F.caught = null;
        this.spawnFishermanCoin(slot.clone().addScaledVector(F.stand.n, 0.6), F.stand.n);
      }
      F.state = 'toSpot';
      F.t0 = time;
    }
  }

  /** A small golden pie (optionally topped with a little fish for fish pies). */
  private buildPie(fishTopped = false): THREE.Group {
    const g = new THREE.Group();
    const tin = new THREE.Mesh(
      new THREE.CylinderGeometry(0.16, 0.14, 0.06, 12),
      new THREE.MeshToonMaterial({ color: 0x8a5a2f }),
    );
    tin.position.y = 0.03;
    tin.castShadow = true;
    g.add(tin);
    const crust = new THREE.Mesh(
      new THREE.SphereGeometry(0.15, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2),
      new THREE.MeshToonMaterial({ color: 0xe2b566 }),
    );
    crust.scale.y = 0.55;
    crust.position.y = 0.06;
    crust.castShadow = true;
    g.add(crust);
    if (fishTopped) {
      const fish = new THREE.Mesh(
        new THREE.OctahedronGeometry(0.07),
        new THREE.MeshToonMaterial({ color: 0xff7a33 }),
      );
      fish.scale.set(0.5, 0.45, 1.4);
      fish.position.set(0, 0.14, 0);
      g.add(fish);
    }
    return g;
  }

  /** A village bakery stall: counter, awning, a brick oven with a glowing door
   * + chimney, and a "Bakery" sign. Returns the group + local anchors. */
  private buildBakery(): {
    group: THREE.Group;
    ovenLocal: THREE.Vector3;
    kneadLocal: THREE.Vector3;
    slots: THREE.Vector3[];
    ovenGlow: THREE.Mesh;
  } {
    const g = new THREE.Group();
    const wood = new THREE.MeshToonMaterial({ color: 0x9c6b3f });
    const dark = new THREE.MeshToonMaterial({ color: 0x5c3d22 });
    const brick = new THREE.MeshToonMaterial({ color: 0x9a5140 });
    const box = (
      w: number,
      h: number,
      d: number,
      mat: THREE.Material,
      x: number,
      y: number,
      z: number,
    ) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
      m.position.set(x, y, z);
      m.castShadow = true;
      g.add(m);
      return m;
    };
    // Counter (front −Z toward customers) on legs
    box(2.4, 0.14, 0.95, wood, 0, 0.92, -0.95);
    for (const sx of [-1.05, 1.05])
      for (const sz of [-1.32, -0.6]) box(0.1, 0.92, 0.1, dark, sx, 0.46, sz);
    // Back posts + a warm striped awning
    for (const sx of [-1.15, 1.15]) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 2.1, 6), dark);
      post.position.set(sx, 1.05, 0.15);
      post.castShadow = true;
      g.add(post);
    }
    const awnA = new THREE.MeshToonMaterial({ color: 0xd9843a, side: THREE.DoubleSide });
    const awnB = new THREE.MeshToonMaterial({ color: 0xf2e0c0, side: THREE.DoubleSide });
    for (let i = 0; i < 5; i++) {
      const panel = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.05, 1.7), i % 2 ? awnB : awnA);
      panel.position.set(-1.04 + i * 0.52, 1.77, -0.55);
      panel.rotation.x = -0.32;
      g.add(panel);
    }
    // Brick OVEN on the right (+X): base + dome + dark door + glow + chimney
    box(1.1, 1.0, 1.1, brick, 1.75, 0.5, 0.35);
    const dome = new THREE.Mesh(
      new THREE.SphereGeometry(0.62, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2),
      brick,
    );
    dome.position.set(1.75, 1.0, 0.35);
    dome.castShadow = true;
    g.add(dome);
    box(0.55, 0.55, 0.12, new THREE.MeshToonMaterial({ color: 0x160b04 }), 1.75, 0.5, -0.22);
    const ovenGlow = new THREE.Mesh(
      new THREE.PlaneGeometry(0.5, 0.5),
      new THREE.MeshBasicMaterial({
        color: 0xff8433,
        transparent: true,
        opacity: 0,
        side: THREE.DoubleSide,
        // Draw over the dark door recess (which is opaque + at the same depth)
        // rather than z-fighting behind it.
        depthTest: false,
        depthWrite: false,
      }),
    );
    ovenGlow.position.set(1.75, 0.5, -0.29);
    ovenGlow.renderOrder = 3;
    g.add(ovenGlow);
    box(0.22, 0.6, 0.22, brick, 1.75, 1.55, 0.35);
    // "Bakery" sign facing customers (−Z)
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 96;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.fillStyle = '#5a3410';
      ctx.fillRect(0, 0, 256, 96);
      ctx.font = '600 34px system-ui, sans-serif';
      ctx.fillStyle = '#ffe6b0';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('🥧 Bakery', 128, 50);
    }
    const sign = new THREE.Mesh(
      // 1.0×0.375 keeps the canvas aspect; the old 1.5×0.56 plane at y1.75
      // poked through the sloping awning (underside ≈1.48 at the sign's z) —
      // same geometry and fix as the fish-stall sign.
      new THREE.PlaneGeometry(1.0, 0.375),
      new THREE.MeshBasicMaterial({
        map: new THREE.CanvasTexture(canvas),
        transparent: true,
        side: THREE.DoubleSide,
      }),
    );
    // Under the awning: top 1.42 vs awning underside ≈1.48; bottom 1.04 vs
    // counter top 0.99.
    sign.position.set(0, 1.23, -1.35);
    sign.rotation.y = Math.PI;
    g.add(sign);
    const ovenLocal = new THREE.Vector3(1.75, 0.55, -0.28);
    const kneadLocal = new THREE.Vector3(-0.55, 1.06, -0.9);
    const slots: THREE.Vector3[] = [];
    for (let i = 0; i < 4; i++) slots.push(new THREE.Vector3(0.15 + i * 0.34, 1.03, -0.9));
    return { group: g, ovenLocal, kneadLocal, slots, ovenGlow };
  }

  /**
   * Put the Sailor on a rowboat drifting a slow circle in open water off the
   * hamlet coast. The boat rides waveHeightAt (the CPU mirror of the sea
   * shader) so it bobs on the SAME swell the player sees; the Sailor is
   * re-anchored to the deck every frame. Chat works the moment you swim or
   * jetski alongside — same proximity interaction as every NPC.
   */
  private setupSailor(): void {
    if (!this.island) return;
    const npc = this.island.npcTargets.find((n) => n.name === 'Sailor');
    if (!npc) return;

    // Open water off the hamlet beach: lat 0.14 is well below the shoreline
    // band (~0.2-0.3 with coast warp) — verified deep at setup, with a
    // seaward nudge fallback if a freak coast warp makes it shallow.
    const center = this.island.dirAt(2.6, 0.14);
    const seaR = this.island.seaLevel();
    if (this.island.analyticSurface(center).radius > seaR - 0.4) {
      center.copy(this.island.dirAt(2.6, 0.09));
    }
    const t1 = new THREE.Vector3(0, 1, 0).cross(center).normalize();
    if (t1.lengthSq() < 0.5) t1.set(1, 0, 0);
    const t2 = new THREE.Vector3().crossVectors(center, t1).normalize();

    // Rowboat: hull + rim + bench, toon browns matching the beached props.
    const hullMat = new THREE.MeshToonMaterial({ color: 0x7a5230 });
    const trimMat = new THREE.MeshToonMaterial({ color: 0x5c3d22 });
    const boat = new THREE.Group();
    const hull = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.34, 2.0), hullMat);
    hull.position.y = 0.17;
    hull.castShadow = true;
    boat.add(hull);
    // Bow wedge (forward = -Z, matching orientQuat's convention)
    const bow = new THREE.Mesh(new THREE.ConeGeometry(0.5, 0.7, 4), hullMat);
    bow.rotation.x = -Math.PI / 2;
    bow.rotation.y = Math.PI / 4;
    bow.scale.set(1, 1, 0.68);
    bow.position.set(0, 0.17, -1.3);
    boat.add(bow);
    for (const rz of [-0.6, 0.5]) {
      const rib = new THREE.Mesh(new THREE.BoxGeometry(1.08, 0.06, 0.12), trimMat);
      rib.position.set(0, 0.36, rz);
      boat.add(rib);
    }
    const bench = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.06, 0.3), trimMat);
    bench.position.set(0, 0.28, 0.15);
    boat.add(bench);
    boat.name = 'sailor_boat';
    this.add(boat);

    this.sailor = {
      npc: npc as {
        position: THREE.Vector3;
        meshRef: THREE.Object3D;
        name: string;
        dialogue: string[];
      },
      boat,
      center,
      t1,
      t2,
      angle: Math.random() * Math.PI * 2,
      radiusArc: 0.02, // ~1u circle at R50
      driftRate: 0.045, // one lazy lap every ~2.3 minutes
    };
    console.log('⛵ Sailor set up on his boat offshore');
  }

  /** Drift + wave-ride the Sailor's boat and keep him standing on the deck. */
  private updateSailor(time: number, dt: number): void {
    const S = this.sailor;
    if (!S || !this.island) return;
    S.angle += S.driftRate * dt;
    // Drift-circle direction: centre tipped toward the rotating tangent.
    const sinA = Math.sin(S.radiusArc);
    this._sailDir
      .copy(S.center)
      .multiplyScalar(Math.cos(S.radiusArc))
      .addScaledVector(S.t1, Math.cos(S.angle) * sinA)
      .addScaledVector(S.t2, Math.sin(S.angle) * sinA)
      .normalize();
    // Ride the real swell (0.7 of full amplitude — a hull damps the chop).
    const calm = this.island.seaLevel();
    const surf = this.island.waveHeightAt(this._sailDir, this.island.seaTimeUniform.value);
    const r = calm + (surf - calm) * 0.7 - 0.06; // hull sits slightly INTO the water
    S.boat.position.copy(this._sailDir).multiplyScalar(r);
    // Face along the drift (derivative of the circle), up = radial; then a
    // gentle rock so it reads afloat even between swells.
    this._sailFwd
      .copy(S.t1)
      .multiplyScalar(-Math.sin(S.angle))
      .addScaledVector(S.t2, Math.cos(S.angle));
    this._sailTmp
      .copy(this._sailFwd)
      .addScaledVector(this._sailDir, -this._sailFwd.dot(this._sailDir));
    S.boat.quaternion.copy(this.orientQuat(this._sailDir, this._sailTmp.normalize()));
    S.boat.rotateX(Math.sin(time * 0.9) * 0.05);
    S.boat.rotateZ(Math.sin(time * 0.7 + 1.3) * 0.045);
    // The Sailor stands amidships, riding every motion of the deck.
    S.npc.meshRef.position.copy(S.boat.position).addScaledVector(this._sailDir, 0.36);
    S.npc.meshRef.quaternion.copy(S.boat.quaternion);
    S.npc.position.copy(S.npc.meshRef.position);
  }

  /** Relocate the Baker to his bakery and start his baking routine. */
  private setupBaker(): void {
    if (!this.island) return;
    const npc = this.island.npcTargets.find((n) => n.name === 'Village Baker');
    if (!npc) return;
    // Context-aware placement: a clear spot in the village (near the cottages,
    // off the pathways, on flat ground), with the counter + sign facing the
    // nearest street where customers walk.
    const place = this.findPlacement({
      anchor: this.island.dirAt(2.5, 0.52),
      footprint: 2.2,
      searchArc: 0.5,
      minLat: 0.34,
      maxLat: 0.66,
      face: 'inland', // counter + sign face the island/village, not the sea
    });
    if (!place) return;

    const { group: bakery, ovenLocal, kneadLocal, slots, ovenGlow } = this.buildBakery();
    bakery.position.copy(place.position);
    bakery.quaternion.copy(place.quaternion);
    this.add(bakery);

    const dough = new THREE.Group();
    const ball = new THREE.Mesh(
      new THREE.SphereGeometry(0.14, 10, 8),
      new THREE.MeshToonMaterial({ color: 0xf0e2c0 }),
    );
    ball.scale.y = 0.65;
    ball.castShadow = true;
    dough.add(ball);
    dough.position.copy(kneadLocal);
    bakery.add(dough);

    this.baker = {
      npc,
      bakery,
      ovenGlow,
      dough,
      pie: null,
      questFish: null,
      stand: { dir: place.dir, r: place.position.length(), n: place.normal, face: place.faceDir },
      ovenLocal,
      kneadLocal,
      slots,
      pies: [],
      state: 'knead',
      t0: performance.now() / 1000,
      fishPie: false,
    };
    console.log('🥧 Bakery + baker routine set up');
  }

  /** A gold coin-pop rising + spinning + fading (sales / quest rewards). */
  private spawnCoinPop(pos: THREE.Vector3, up: THREE.Vector3): void {
    const mesh = new THREE.Mesh(
      new THREE.CylinderGeometry(0.12, 0.12, 0.03, 12),
      new THREE.MeshBasicMaterial({ color: 0xffd34a, transparent: true, opacity: 1 }),
    );
    mesh.position.copy(pos);
    mesh.quaternion.setFromUnitVectors(GameScene._localUp, up);
    this.add(mesh);
    this.popCoins.push({ mesh, t0: performance.now() / 1000, n: up.clone() });
  }

  /** Show/hide a fish carried in the player's hands (Baker fetch quest). */
  public setPlayerCarryingFish(on: boolean): void {
    if (on && !this.carriedFish) {
      const [bc, fc, sc] = GameScene.FISH_TYPES[0];
      const f = this.buildFish(bc, fc).group;
      f.scale.setScalar(sc * 0.62);
      // Held up above the head so it reads from the normal follow-cam (behind)
      f.position.set(0, 1.75, -0.1);
      f.rotation.set(-0.5, 0, 0);
      this.player.add(f);
      this.carriedFish = f;
    } else if (!on && this.carriedFish) {
      this.player.remove(this.carriedFish);
      this.carriedFish = null;
    }
  }

  /** Quest payoff: hand the fish to the Baker → he bakes it into a fish pie. */
  public deliverFishToBaker(): void {
    this.setPlayerCarryingFish(false);
    const B = this.baker;
    if (!B) return;
    const [bc, fc, sc] = GameScene.FISH_TYPES[0];
    const f = this.buildFish(bc, fc).group;
    f.scale.setScalar(sc * 0.7);
    f.position.copy(B.kneadLocal);
    B.bakery.add(f);
    B.questFish = f;
    B.pie = null;
    B.state = 'fishBake';
    B.t0 = performance.now() / 1000;
    B.fishPie = true;
  }

  /** Baker routine state machine: knead → oven → bake → pie → counter, looping,
   * with a one-off 'fishBake' the quest injects. */
  private updateBaker(time: number, _dt: number): void {
    const B = this.baker;
    if (!B || !this.island) return;
    const bob = (Math.sin(time * 2) + 1) * 0.008;
    const standW = B.stand.dir.clone().multiplyScalar(B.stand.r);
    const kneadBob = B.state === 'knead' ? Math.abs(Math.sin(time * 7)) * 0.05 : 0;
    B.npc.meshRef.position.copy(standW).addScaledVector(B.stand.n, bob + kneadBob);
    B.npc.position.copy(B.npc.meshRef.position);
    // Face the oven while baking, else the counter/customers
    const ovenW = B.bakery.localToWorld(B.ovenLocal.clone());
    let faceDir = B.stand.face;
    if (B.state === 'toOven' || B.state === 'bake' || B.state === 'fishBake') {
      faceDir = ovenW.clone().sub(standW);
      faceDir.addScaledVector(B.stand.n, -faceDir.dot(B.stand.n)).normalize();
    }
    this.orientObj(B.npc.meshRef, B.stand.n, faceDir);

    const st = time - B.t0;
    const glow = (v: number) => {
      (B.ovenGlow.material as THREE.MeshBasicMaterial).opacity = Math.max(0, Math.min(1, v));
    };
    const slot = () => B.slots[B.pies.length % B.slots.length];
    const depositPie = () => {
      if (!B.pie) return;
      B.pie.position.copy(slot());
      B.pies.push(B.pie);
      if (B.pies.length > B.slots.length) {
        const old = B.pies.shift();
        if (old) B.bakery.remove(old);
      }
      B.pie = null;
    };

    switch (B.state) {
      case 'knead':
        B.dough.visible = true;
        B.dough.position.copy(B.kneadLocal);
        B.dough.scale.set(
          1 + Math.sin(time * 7) * 0.14,
          0.65 + Math.sin(time * 7 + 1) * 0.12,
          1 + Math.cos(time * 7) * 0.14,
        );
        glow(0);
        if (st > 2.5) {
          B.state = 'toOven';
          B.t0 = time;
        }
        break;
      case 'toOven': {
        const p = Math.min(st / 1.2, 1);
        B.dough.visible = true;
        B.dough.scale.setScalar(1);
        B.dough.position.copy(B.kneadLocal).lerp(B.ovenLocal, p);
        if (p >= 1) {
          B.state = 'bake';
          B.t0 = time;
        }
        break;
      }
      case 'bake': {
        const p = Math.min(st / 3, 1);
        B.dough.visible = false;
        glow(Math.sin(p * Math.PI) * 0.7 + (p < 1 ? 0.2 : 0));
        if (p >= 1) {
          B.pie = this.buildPie(false);
          B.pie.position.copy(B.ovenLocal);
          B.bakery.add(B.pie);
          B.state = 'toCounter';
          B.t0 = time;
        }
        break;
      }
      case 'toCounter': {
        const p = Math.min(st / 1.2, 1);
        glow((1 - p) * 0.4);
        if (B.pie) B.pie.position.copy(B.ovenLocal).lerp(slot(), p);
        if (p >= 1) {
          B.state = 'display';
          B.t0 = time;
        }
        break;
      }
      case 'display':
        glow(0);
        if (st > 0.4) {
          depositPie();
          B.state = 'knead';
          B.t0 = time;
        }
        break;
      case 'fishBake': {
        const p = Math.min(st / 4.5, 1);
        B.dough.visible = false;
        if (p < 0.35) {
          if (B.questFish) {
            B.questFish.visible = true;
            B.questFish.position.copy(B.kneadLocal).lerp(B.ovenLocal, p / 0.35);
          }
          glow(0.25);
        } else if (p < 0.75) {
          if (B.questFish) B.questFish.visible = false;
          glow(Math.sin(((p - 0.35) / 0.4) * Math.PI) * 1.0 + 0.35);
          if (!B.pie && p > 0.68) {
            B.pie = this.buildPie(true);
            B.pie.position.copy(B.ovenLocal);
            B.bakery.add(B.pie);
          }
        } else {
          glow(((1 - p) / 0.25) * 0.4);
          if (B.pie) B.pie.position.copy(B.ovenLocal).lerp(slot(), (p - 0.75) / 0.25);
        }
        if (p >= 1) {
          if (B.questFish) {
            B.bakery.remove(B.questFish);
            B.questFish = null;
          }
          if (B.pie) {
            this.spawnCoinPop(
              B.bakery.localToWorld(slot().clone()).addScaledVector(B.stand.n, 0.55),
              B.stand.n,
            );
          }
          depositPie();
          B.fishPie = false;
          B.state = 'knead';
          B.t0 = time;
        }
        break;
      }
    }
  }

  /**
   * Low-poly clouds orbiting the planet on randomized great circles.
   * Each cloud hangs off a pivot at the origin; rotating the pivot in
   * update() drifts the cloud around the planet and its shadow across
   * the terrain.
   */
  private createClouds(): void {
    const cloudMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 1.0,
      transparent: true,
      opacity: 0.92,
    });
    this.cloudMat = cloudMat;
    const planetR = this.island ? this.island.getRadius() : 18;
    // 18 (was 10): the R50 sky read sparse — more cover, same tight ceiling.
    for (let i = 0; i < 18; i++) {
      const pivot = new THREE.Object3D();
      // Random orbit plane
      pivot.rotation.set(
        Math.random() * Math.PI,
        Math.random() * Math.PI * 2,
        Math.random() * Math.PI,
      );
      const cloud = new THREE.Group();
      // Classic cartoon cloud: one big smooth dome + smaller overlapping
      // flanks, bottoms aligned to a flat base, all flattened along the SAME
      // axis with no random tilt. (The old version random-rotated each
      // already-flattened faceted blob — squashing every one along a
      // different axis, which read as a stack of stones.)
      const coreR = 0.9 + Math.random() * 0.5;
      const flanks = 2 + Math.floor(Math.random() * 3); // 2-4 per side pattern
      const radii: number[] = [coreR];
      for (let f = 0; f < flanks; f++) radii.push(coreR * (0.5 + Math.random() * 0.3));
      let xCursor = 0;
      // Blobs baked into ONE geometry per cloud (the per-tree merge pattern):
      // ~40 blob meshes → 10 draws, and none in the shadow pass — with the
      // ±17u player-following shadow box clouds almost never intersected it
      // but were submitted to the depth pass every frame.
      const parts: THREE.BufferGeometry[] = [];
      radii.forEach((r, idx) => {
        const blobGeo = new THREE.SphereGeometry(r, 9, 7);
        blobGeo.scale(1, 0.6, 1);
        blobGeo.rotateY(Math.random() * Math.PI); // yaw only — never tilt
        if (idx === 0) {
          blobGeo.translate(0, r * 0.35, 0);
        } else {
          const side = idx % 2 === 1 ? 1 : -1;
          if (idx % 2 === 1) xCursor += r * 0.9;
          blobGeo.translate(
            side * (coreR * 0.55 + xCursor * 0.6),
            r * 0.32,
            (Math.random() - 0.5) * 0.5,
          );
        }
        parts.push(blobGeo);
      });
      cloud.add(new THREE.Mesh(mergeGeometries(parts, false), cloudMat));
      // One consistent cloud ceiling (tight altitude band) — a wide random
      // band read as clouds "stacked" vertically instead of a sky layer
      cloud.position.set(planetR + 6.5 + Math.random() * 1.2, 0, 0);
      // Lie flat relative to the planet: the cloud sits on the pivot's +X
      // (radial), but its flat-bottom/spread axes were pivot-tangent, so
      // clouds stood on their side depending on the pivot's random
      // orientation. Rotating 90° maps the cloud's local "up" onto the
      // radial axis — flat base toward the ground, spread along the sky.
      cloud.rotation.z = -Math.PI / 2;
      const cloudData = cloud.userData as Record<string, unknown>;
      cloudData.ignoreOcclusion = true;
      pivot.add(cloud);
      const pivotData = pivot.userData as Record<string, unknown>;
      pivotData.driftSpeed = 0.01 + Math.random() * 0.02;
      pivot.name = `cloud_pivot_${i}`;
      this.add(pivot);
      this.cloudPivots.push(pivot);
    }
  }

  /**
   * Butterflies hovering near flower clusters: two wing triangles flapping
   * fast while the body drifts in a slow figure-8 above its home flowers.
   */
  private createButterflies(): void {
    const WING_COLORS = [0xffa04a, 0xf5f5ff, 0xc48ae0, 0xffd34a, 0x7ab8ff];
    const bodyMat = new THREE.MeshToonMaterial({ color: 0x33302a });
    for (let i = 0; i < this.island.flowerSites.length; i++) {
      const site = this.island.flowerSites[i];
      const group = new THREE.Group();
      const wingMat = new THREE.MeshToonMaterial({
        color: WING_COLORS[i % WING_COLORS.length],
        side: THREE.DoubleSide,
      });
      const wingGeo = new THREE.PlaneGeometry(0.09, 0.07);
      wingGeo.translate(0.045, 0, 0); // hinge at the body
      const wingL = new THREE.Mesh(wingGeo, wingMat);
      group.add(wingL);
      const wingR = new THREE.Mesh(wingGeo, wingMat);
      wingR.rotation.y = Math.PI;
      group.add(wingR);
      const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.012, 0.06, 2, 4), bodyMat);
      body.rotation.x = Math.PI / 2;
      group.add(body);

      const normal = site.clone().normalize();
      // Build a tangent frame for the drift path
      const tanA = new THREE.Vector3(0, 1, 0).cross(normal);
      if (tanA.lengthSq() < 1e-4) tanA.set(1, 0, 0);
      tanA.normalize();
      const tanB = normal.clone().cross(tanA).normalize();
      group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), normal);
      this.add(group);
      this.butterflies.push({
        group,
        wingL,
        wingR,
        base: site.clone(),
        normal,
        tanA,
        tanB,
        phase: Math.random() * Math.PI * 2,
      });
    }
  }

  /**
   * Five glowing breadcrumb sparkles that arc ahead of the player along
   * the great-circle route to the active delivery — in-world navigation
   * so the HUD compass isn't the only cue. Hidden when no target.
   */
  private createGuideSparkles(): void {
    const geo = new THREE.OctahedronGeometry(0.11, 0);
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffe066,
      transparent: true,
      opacity: 0.9,
    });
    for (let i = 0; i < 5; i++) {
      const sparkle = new THREE.Mesh(geo, mat);
      sparkle.visible = false;
      sparkle.name = `guide_sparkle_${i}`;
      this.add(sparkle);
      this.guideSparkles.push(sparkle);
    }
  }

  /** Set (or clear) the world position the guide sparkles lead toward. */
  public setGuideTarget(pos: THREE.Vector3 | null): void {
    this.guideTarget = pos;
  }

  /**
   * Fireflies: 3 per flower cluster, wandering slowly with a blinking
   * glow. Invisible by day — they take over from the butterflies after
   * dark (drives from EnvironmentCycle's day factor in update()).
   */
  private createFireflies(): void {
    const geo = new THREE.SphereGeometry(0.04, 6, 5);
    for (const site of this.island.flowerSites) {
      const normal = site.clone().normalize();
      const tanA = new THREE.Vector3(0, 1, 0).cross(normal);
      if (tanA.lengthSq() < 1e-4) tanA.set(1, 0, 0);
      tanA.normalize();
      const tanB = normal.clone().cross(tanA).normalize();
      for (let f = 0; f < 3; f++) {
        const material = new THREE.MeshBasicMaterial({
          color: 0xffe27a,
          transparent: true,
          opacity: 0,
          depthWrite: false,
        });
        const mesh = new THREE.Mesh(geo, material);
        mesh.visible = false;
        this.add(mesh);
        this.fireflies.push({
          mesh,
          material,
          base: site.clone(),
          normal,
          tanA,
          tanB,
          phase: Math.random() * Math.PI * 2,
        });
      }
    }
  }

  /**
   * Pooled dust puffs for footsteps and landings: small fading spheres
   * that scatter along the surface tangent. 18 puffs cover a landing
   * ring (6) plus a trail of footsteps without allocation.
   */
  private createDustPool(): void {
    const geo = new THREE.SphereGeometry(1, 6, 5);
    for (let i = 0; i < 18; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0xd8cfc0,
        transparent: true,
        opacity: 0,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.visible = false;
      this.add(mesh);
      this.dustPuffs.push({
        mesh,
        mat,
        t0: -1,
        origin: new THREE.Vector3(),
        dir: new THREE.Vector3(),
        normal: new THREE.Vector3(),
      });
    }
  }

  // ── Water FX ────────────────────────────────────────────────────────

  private createWaterFX(): void {
    const ringGeo = new THREE.RingGeometry(0.4, 0.55, 20);
    for (let i = 0; i < 24; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0xe8f6ff,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(ringGeo, mat);
      mesh.visible = false;
      this.add(mesh);
      this.waterRings.push({
        mesh,
        mat,
        t0: -1,
        life: 1,
        maxScale: 1,
        normal: new THREE.Vector3(),
      });
    }
    const dropGeo = new THREE.SphereGeometry(0.07, 5, 4);
    for (let i = 0; i < 44; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0xf0fbff,
        transparent: true,
        opacity: 0,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(dropGeo, mat);
      mesh.visible = false;
      this.add(mesh);
      this.waterSpray.push({
        mesh,
        mat,
        t0: -1,
        life: 1,
        origin: new THREE.Vector3(),
        vel: new THREE.Vector3(),
      });
    }
  }

  /** Expanding foam ring flat on the water at `center` (normal = radial). */
  private spawnRipple(center: THREE.Vector3, maxScale: number, life = 1.1): void {
    const time = performance.now() / 1000;
    for (const r of this.waterRings) {
      if (r.mesh.visible) continue;
      r.normal.copy(center).normalize();
      r.mesh.position.copy(center);
      r.mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), r.normal);
      r.mesh.scale.setScalar(0.4);
      r.t0 = time;
      r.life = life;
      r.maxScale = maxScale;
      r.mat.opacity = 0.5;
      r.mesh.visible = true;
      return;
    }
  }

  /** Fling `count` spray droplets from `origin` along `dir` (splash/wake). */
  private spawnSpray(
    origin: THREE.Vector3,
    dir: THREE.Vector3,
    count: number,
    speed: number,
  ): void {
    const time = performance.now() / 1000;
    const up = this._fxScratch.copy(origin).normalize();
    let spawned = 0;
    for (const s of this.waterSpray) {
      if (s.mesh.visible) continue;
      s.origin.copy(origin);
      // mostly along dir, biased upward, with a little scatter
      s.vel
        .copy(dir)
        .multiplyScalar(0.5 + Math.random() * 0.6)
        .addScaledVector(up, 0.7 + Math.random() * 0.6)
        .add(
          new THREE.Vector3(
            (Math.random() - 0.5) * 0.5,
            (Math.random() - 0.5) * 0.5,
            (Math.random() - 0.5) * 0.5,
          ),
        )
        .normalize()
        .multiplyScalar(speed * (0.6 + Math.random() * 0.5));
      s.t0 = time;
      s.life = 0.6 + Math.random() * 0.3;
      s.mesh.position.copy(origin);
      s.mesh.scale.setScalar(0.6 + Math.random() * 0.7);
      s.mat.opacity = 0.9;
      s.mesh.visible = true;
      if (++spawned >= count) break;
    }
  }

  private _rippleAccum = 0;

  /** Animate the rings/spray + emit swim & wake foam. Called from update(). */
  private updateWaterFX(deltaTime: number): void {
    const time = performance.now() / 1000;

    // Emit foam under the swimmer + behind moving craft (throttled)
    this._rippleAccum += deltaTime;
    const emit = this._rippleAccum > 0.14;
    if (emit) this._rippleAccum = 0;

    // NB: spawnRipple/spawnSpray use this._fxScratch internally, so callers
    // pass their OWN fresh vectors (never _fxScratch) to avoid aliasing.
    if (this.player.isSwimming()) {
      const p = this.player.getWorldPosition();
      const dir = p.clone().normalize();
      const surf = this.island.waveHeightAt(dir, this.island.seaTimeUniform.value);
      const onSurf = dir.clone().multiplyScalar(surf + 0.02);
      if (emit && this.player.getTangentialSpeed() > 0.4) this.spawnRipple(onSurf, 1.6, 1.0);
      else if (emit && Math.random() < 0.5) this.spawnRipple(onSurf, 1.1, 1.2);
    }
    // Entry splash
    if (this.player.consumeWaterEntry()) {
      const p = this.player.getWorldPosition();
      const dir = p.clone().normalize();
      const surf = this.island.waveHeightAt(dir, this.island.seaTimeUniform.value);
      const onSurf = dir.clone().multiplyScalar(surf);
      this.spawnRipple(onSurf, 2.4, 1.1);
      this.spawnSpray(onSurf, dir.clone(), 10, 5);
      sfx.splash();
    }

    // Vehicle wakes + spray
    if (this.activeVehicle >= 0) {
      const v = this.vehicles[this.activeVehicle];
      const speedInput = Math.abs(this.vehicleMove.forward) + Math.abs(this.vehicleMove.strafe);
      if (speedInput > 0.1) {
        const stern = v.group.position
          .clone()
          .addScaledVector(v.forward, v.kind === 'jetski' ? -1.0 : -1.6);
        if (emit) this.spawnRipple(stern.clone(), v.kind === 'jetski' ? 1.4 : 2.2, 1.0);
        // jetski throws a rooster tail; boat a lighter bow/stern spray
        const back = v.forward.clone().multiplyScalar(-1);
        this.spawnSpray(stern, back, v.kind === 'jetski' ? 3 : 1, v.kind === 'jetski' ? 6 : 4);
      }
    }

    // Animate rings: expand + fade
    for (const r of this.waterRings) {
      if (!r.mesh.visible) continue;
      const a = (time - r.t0) / r.life;
      if (a >= 1) {
        r.mesh.visible = false;
        continue;
      }
      const sc = 0.4 + a * r.maxScale;
      r.mesh.scale.setScalar(sc);
      r.mat.opacity = 0.5 * (1 - a);
    }

    // Animate spray: ballistic arc under gentle gravity, fade
    for (const s of this.waterSpray) {
      if (!s.mesh.visible) continue;
      const a = (time - s.t0) / s.life;
      if (a >= 1) {
        s.mesh.visible = false;
        continue;
      }
      // integrate velocity with light gravity toward planet centre
      s.vel.addScaledVector(this._fxScratch.copy(s.origin).normalize(), -14 * deltaTime);
      s.mesh.position.addScaledVector(s.vel, deltaTime);
      s.mat.opacity = 0.9 * (1 - a);
    }
  }

  /** Kick up `count` dust puffs at a world position (footstep: 1, landing: 6). */
  public spawnDust(center: THREE.Vector3, count: number): void {
    const time = performance.now() / 1000;
    this._npcNormal.copy(center).normalize();
    let spawned = 0;
    for (const p of this.dustPuffs) {
      if (p.mesh.visible) continue;
      const ang = Math.random() * Math.PI * 2;
      // Random tangent direction on the surface
      p.dir
        .set(Math.cos(ang), Math.sin(ang) * 0.3, Math.sin(ang))
        .addScaledVector(this._npcNormal, -this._npcNormal.dot(p.dir))
        .normalize();
      p.origin.copy(center).addScaledVector(this._npcNormal, -0.55);
      p.normal.copy(this._npcNormal);
      p.t0 = time;
      p.mesh.visible = true;
      if (++spawned >= count) break;
    }
  }

  /** Brief wobble for a mailbox that just handed over a delivery. */
  public wiggleMailbox(mb: Mailbox): void {
    const existing = this.wiggles.find((w) => w.obj === mb.mesh);
    if (existing) {
      existing.t0 = performance.now() / 1000;
      return;
    }
    this.wiggles.push({
      obj: mb.mesh,
      baseQuat: mb.mesh.quaternion.clone(),
      t0: performance.now() / 1000,
    });
  }

  /** Register a listener for coin pickups (receives the new total). */
  public setOnCoinCollected(cb: (total: number) => void): void {
    this.onCoinCollected = cb;
  }

  /** Race banner events (start / checkpoint / finish) for transient messages. */
  public setOnRaceEvent(cb: (e: RaceEvent) => void): void {
    this.onRaceEventCb = cb;
  }

  /** Persistent race HUD status (null hides it — on foot / not racing). */
  public setOnRaceHud(cb: (s: RaceHudStatus | null) => void): void {
    this.onRaceHudCb = cb;
  }

  /** Grant coins directly (quest rewards) — persists and updates the HUD. */
  public addCoins(n: number): void {
    this.coinsCollected += n;
    try {
      localStorage.setItem('ds_coins', String(this.coinsCollected));
    } catch {
      /* session-only counter */
    }
    this.onCoinCollected?.(this.coinsCollected);
  }

  /** Spend coins in the shop. Returns false (no change) if unaffordable. */
  public spendCoins(n: number): boolean {
    if (this.coinsCollected < n) return false;
    this.addCoins(-n);
    return true;
  }

  /** Set the coin total absolutely (applying a synced cloud profile). */
  public setCoins(total: number): void {
    this.coinsCollected = Math.max(0, Math.floor(total));
    try {
      localStorage.setItem('ds_coins', String(this.coinsCollected));
    } catch {
      /* session-only counter */
    }
    this.onCoinCollected?.(this.coinsCollected);
  }

  /** Equip a cosmetic hat on the player (shop purchase). */
  public equipPlayerHat(id: import('./SimplePlayer').HatId | null): void {
    this.player?.equipHat(id);
  }

  // Quest "!" markers floating above NPC quest givers
  private questMarkers: Array<{
    mesh: THREE.Group;
    npcName: string;
    base: THREE.Vector3;
    normal: THREE.Vector3;
  }> = [];

  // Floating labels above every NPC: role by default ("🥖 Baker"), swapped to
  // the current activity while working ("🌷 tending"). Canvas/texture retained
  // so the pill can be redrawn when the activity changes (a few times/day).
  private nameTags: Array<{
    sprite: THREE.Sprite;
    target: { position: THREE.Vector3; meshRef: THREE.Object3D };
    ctx: CanvasRenderingContext2D | null;
    tex: THREE.CanvasTexture;
    emoji: string;
    role: string;
    shown: string;
  }> = [];
  private readonly _tagNormal = new THREE.Vector3();

  /** Show a bobbing "!" above each named NPC (clears markers not in the list). */
  public setQuestMarkers(npcNames: string[]): void {
    // Remove stale markers
    for (let i = this.questMarkers.length - 1; i >= 0; i--) {
      if (!npcNames.includes(this.questMarkers[i].npcName)) {
        this.remove(this.questMarkers[i].mesh);
        this.questMarkers.splice(i, 1);
      }
    }
    // Add new ones
    for (const name of npcNames) {
      if (this.questMarkers.some((m) => m.npcName === name)) continue;
      const npc = this.island.npcTargets.find((n) => n.name === name);
      if (!npc) continue;
      const marker = new THREE.Group();
      const mat = new THREE.MeshBasicMaterial({ color: 0xffd34a });
      const bar = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.32, 0.09), mat);
      bar.position.y = 0.14;
      marker.add(bar);
      const dot = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.09, 0.09), mat);
      dot.position.y = -0.12;
      marker.add(dot);
      const base = npc.meshRef.getWorldPosition(new THREE.Vector3());
      const normal = base.clone().normalize();
      // 2.7: the "!" spans −0.165..+0.30 locally and bobs ±0.12, so its
      // lowest point is offset−0.285 = 2.415 — 0.12 above the name pill's
      // near-range top (bottom 1.60 + height 0.69 ≈ 2.29). At 2.1 it sat
      // INSIDE the pill.
      marker.position.copy(base).addScaledVector(normal, 2.7);
      marker.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), normal);
      this.add(marker);
      this.questMarkers.push({ mesh: marker, npcName: name, base, normal });
    }
  }

  // NPC name → floating-pin identity (emoji + short trade label). Lets a
  // visitor read who's who from across the district without walking up.
  private static readonly NPC_ROLES: Record<string, { emoji: string; role: string }> = {
    'Elder Sage': { emoji: '🧙', role: 'Sage' },
    'Village Baker': { emoji: '🥖', role: 'Baker' },
    'Island Explorer': { emoji: '🧭', role: 'Explorer' },
    'Young Student': { emoji: '📚', role: 'Student' },
    'Market Vendor': { emoji: '🛒', role: 'Shop' },
    Fisherman: { emoji: '🎣', role: 'Fisher' },
    Artist: { emoji: '🎨', role: 'Artist' },
    Guard: { emoji: '🛡️', role: 'Guard' },
    Storyteller: { emoji: '📖', role: 'Storyteller' },
    Wanderer: { emoji: '🚶', role: 'Wanderer' },
    Gardener: { emoji: '🌷', role: 'Gardener' },
    Architect: { emoji: '📐', role: 'Architect' },
    Musician: { emoji: '🎵', role: 'Musician' },
    'Lighthouse Keeper': { emoji: '🗼', role: 'Keeper' },
    Tourist: { emoji: '📷', role: 'Tourist' },
    Cartographer: { emoji: '🗺️', role: 'Mapmaker' },
    Philosopher: { emoji: '🤔', role: 'Philosopher' },
    Courier: { emoji: '✉️', role: 'Courier' },
    'Night Watch': { emoji: '🔦', role: 'Watch' },
  };

  /** Build a floating identity pin above every NPC (once, after placement). */
  private createNameTags(): void {
    for (const npc of this.island.npcTargets) {
      const info = GameScene.NPC_ROLES[npc.name] ?? { emoji: '📍', role: npc.name };
      const canvas = document.createElement('canvas');
      canvas.width = 256;
      canvas.height = 96; // room for the two-line role+activity pill
      const ctx = canvas.getContext('2d');
      GameScene.drawNamePill(ctx, info.emoji, info.role);
      const tex = new THREE.CanvasTexture(canvas);
      const sprite = new THREE.Sprite(
        // depthWrite:false so pills never occlude each other; depthTest stays TRUE
        // so terrain hides pins on the far side of the planet (no x-ray labels).
        new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }),
      );
      // 0.63 = 0.42 × (96/64): the canvas grew, the scale compensates, so a
      // single-line pill renders at exactly the pre-two-line world size.
      sprite.scale.set(1.7, 0.63, 1);
      // Anchor the sprite's BOTTOM at its position: the constant-screen-size
      // scaling in the tag loop grew the centre-anchored pill DOWNWARD into
      // the dressed heads (hair/hats top out ≈1.33 world) past ~20u camera
      // distance. Bottom-anchored, growth only ever goes upward.
      sprite.center.set(0.5, 0);
      sprite.renderOrder = 2;
      this.add(sprite);
      this.nameTags.push({
        sprite,
        target: npc,
        ctx,
        tex,
        emoji: info.emoji,
        role: info.role,
        shown: info.role,
      });
    }
    console.log(`🏷️ ${this.nameTags.length} NPC name pins created`);
  }

  /** Draw the identity pill onto a name-tag canvas (redrawable). One centred
   *  line (emoji + role); with `sub` (the current activity), a second smaller
   *  gold line below it — identity stays readable while the badge shows work. */
  private static drawNamePill(
    ctx: CanvasRenderingContext2D | null,
    emoji: string,
    label: string,
    sub?: string,
  ): void {
    if (!ctx) return;
    ctx.clearRect(0, 0, 256, 96);
    const text = `${emoji} ${label}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '600 30px system-ui, sans-serif';
    const w1 = ctx.measureText(text).width;
    ctx.font = '500 22px system-ui, sans-serif';
    const w2 = sub ? ctx.measureText(sub).width : 0;
    const w = Math.min(250, Math.max(w1, w2) + 28);
    const h = sub ? 76 : 40;
    const top = (96 - h) / 2;
    ctx.fillStyle = 'rgba(10,14,26,0.85)';
    ctx.beginPath();
    ctx.roundRect(128 - w / 2, top, w, h, 20);
    ctx.fill();
    ctx.strokeStyle = 'rgba(170,205,255,0.7)';
    ctx.lineWidth = 2.5;
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.font = '600 30px system-ui, sans-serif';
    ctx.fillText(text, 128, sub ? top + 22 : 48);
    if (sub) {
      ctx.fillStyle = '#ffd479';
      ctx.font = '500 22px system-ui, sans-serif';
      ctx.fillText(sub, 128, top + 55);
    }
  }

  /** Update a name pin: role line + optional activity sub-line. Cheap: only
   *  redraws when the combined text actually changes (a few times/NPC/day). */
  private setNpcBadge(i: number, role: string, sub?: string): void {
    const tag = this.nameTags[i];
    const key = sub ? `${role}|${sub}` : role;
    if (!tag || tag.shown === key) return;
    tag.shown = key;
    GameScene.drawNamePill(tag.ctx, tag.emoji, role, sub);
    tag.tex.needsUpdate = true;
  }

  // ── NPC speech bubble ──
  // ONE shared in-world bubble (only one NPC speaks at a time): shown above an
  // AI NPC when the visitor walks up, carrying the aware proximity greeting.
  // Same CanvasTexture-sprite idiom as the name pins; positioned in the tag
  // update loop; auto-hides after a few seconds.
  private npcBubble: {
    sprite: THREE.Sprite;
    ctx: CanvasRenderingContext2D;
    tex: THREE.CanvasTexture;
  } | null = null;
  private npcBubbleFor = -1;
  private npcBubbleUntil = 0;

  private showNpcSpeechBubble(i: number, text: string, time: number): void {
    if (!this.npcBubble) {
      const canvas = document.createElement('canvas');
      canvas.width = 512;
      canvas.height = 160;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const tex = new THREE.CanvasTexture(canvas);
      const sprite = new THREE.Sprite(
        new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }),
      );
      sprite.scale.set(3.4, 1.06, 1);
      // Bottom-anchored so it stacks cleanly on top of the (also bottom-
      // anchored) name pill without ever growing down into it.
      sprite.center.set(0.5, 0);
      sprite.renderOrder = 3;
      sprite.visible = false;
      this.add(sprite);
      this.npcBubble = { sprite, ctx, tex };
    }
    const { ctx, tex, sprite } = this.npcBubble;
    ctx.clearRect(0, 0, 512, 160);
    // Word-wrap into ≤3 lines of ~34 chars (the composer keeps lines short).
    const words = text.split(' ');
    const lines: string[] = [];
    let cur = '';
    for (const w of words) {
      if ((cur + ' ' + w).trim().length > 34 && cur) {
        lines.push(cur.trim());
        cur = w;
      } else cur = `${cur} ${w}`;
      if (lines.length === 2) break;
    }
    if (cur.trim() && lines.length < 3) lines.push(cur.trim());
    const lh = 34;
    const h = 28 + lines.length * lh;
    const top = (160 - h) / 2;
    ctx.fillStyle = 'rgba(250,248,242,0.95)';
    ctx.beginPath();
    ctx.roundRect(16, top, 480, h, 18);
    ctx.fill();
    ctx.strokeStyle = 'rgba(60,50,40,0.4)';
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.fillStyle = '#2c2620';
    ctx.font = '500 26px "Patrick Hand", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    lines.forEach((ln, k) => ctx.fillText(ln, 256, top + 24 + k * lh));
    tex.needsUpdate = true;
    sprite.visible = true;
    this.npcBubbleFor = i;
    this.npcBubbleUntil = time + 6.5;
  }

  /** The named NPC's current activity id (for the aware chat opening). */
  public getNpcActivity(name: string): string | undefined {
    const t = this.island.npcTargets.find((n) => n.name === name);
    return (t?.meshRef.userData as { wander?: { activity?: string } } | undefined)?.wander
      ?.activity;
  }

  /** Hand the island's activity anchors to NpcActivities + map persona ids. */
  private setupNpcActivities(): void {
    const vistas = [
      // NOT the lighthouse's own coords (5.4, 0.34) — that put the Artist
      // waist-deep in the tower's rock plinth. 4.5u SW, still coastal.
      this.island.dirAt(5.32, 0.315),
      this.island.dirAt(2.2, 0.33),
      this.island.dirAt(4.6, 0.35),
      this.island.dirAt(0.9, 0.33),
    ].map((d) => this.island.sampleSurfaceByDirection(d, 0).position.clone());
    NpcActivities.setAnchors({
      flowers: this.island.flowerBedSites,
      crops: this.island.cropRowSites,
      // Stations fall back to the old anchor sets if a build was skipped
      // (unsamplable terrain), so a missing prop can never strand an NPC.
      bandstand: this.island.bandstandSites.length
        ? this.island.bandstandSites
        : NpcActivities.plazaFallback(),
      easel: this.island.easelSites.length ? this.island.easelSites : vistas,
      lamps: this.island.lampSites,
      mailboxes: this.island.mailboxSites,
      stalls: this.island.stallSites,
      benches: this.island.benchSites,
      lighthouseDir: this.island.lighthouseDir,
      vistas,
      doors: this.island.houseDoors.map((d) => d.position),
    });
    NpcActivities.applyPlanOverrideFromUrl();
    this.npcPersonaIds = this.island.npcTargets.map((n) => AI_NPCS[n.name] ?? null);
    // Balanced sleeping arrangements: greedy nearest-door with a per-door cap,
    // so the town spreads across the cottages instead of piling behind one
    // popular door (14 sleepers once shared a single house). Computed ONCE —
    // sleep re-picks goals all night, so assignments must be stable.
    const doorDirs = this.island.houseDoors.map((d) => d.position.clone().normalize());
    if (doorDirs.length) {
      const personas: Array<{ id: string; home: THREE.Vector3 }> = [];
      this.island.npcTargets.forEach((n, i) => {
        const id = this.npcPersonaIds[i];
        if (id) personas.push({ id, home: n.meshRef.position.clone().normalize() });
      });
      const cap = Math.ceil(personas.length / doorDirs.length);
      const load = new Array<number>(doorDirs.length).fill(0);
      const assign: Record<string, number> = {};
      for (const p of personas) {
        const order = doorDirs
          .map((d, i) => ({ i, a: d.angleTo(p.home) }))
          .sort((x, y) => x.a - y.a);
        const pick = order.find((o) => load[o.i] < cap) ?? order[0];
        load[pick.i]++;
        assign[p.id] = pick.i;
      }
      NpcActivities.setDoorAssignments(assign);
    }
  }

  /** Apply a daily server plan (world/island/npcPlan) to the activity engine. */
  public setNpcActivities(plan: unknown): void {
    NpcActivities.setPlan(plan);
  }

  public getCoinsCollected(): number {
    return this.coinsCollected;
  }

  /**
   * Spinning collectible coins scattered across the open meadows —
   * traversal rewards between districts (A Short Hike-style). Collected
   * on touch with a chime; each respawns after 120 seconds.
   */
  private createCoins(): void {
    try {
      this.coinsCollected = parseInt(localStorage.getItem('ds_coins') ?? '0', 10) || 0;
    } catch {
      /* counter starts at 0 */
    }
    const geo = new THREE.CylinderGeometry(0.16, 0.16, 0.045, 12);
    const mat = new THREE.MeshToonMaterial({ color: 0xffd34a });
    mat.emissive = new THREE.Color(0x554411);
    const golden = Math.PI * (3 - Math.sqrt(5));
    const dir = new THREE.Vector3();
    for (let i = 0; i < 20; i++) {
      const y = 1 - ((i + 0.5) / 20) * 2;
      const rAt = Math.sqrt(Math.max(0, 1 - y * y));
      const th = golden * i * 7.3;
      dir
        .set(
          Math.cos(th) * rAt + (Math.random() - 0.5) * 0.2,
          // Island-only world: |y| mirrors southern spots onto the north cap,
          // and the max() keeps every coin above the shoreline band
          Math.max(Math.abs(y + (Math.random() - 0.5) * 0.2), Math.sin(0.3)),
          Math.sin(th) * rAt + (Math.random() - 0.5) * 0.2,
        )
        .normalize();
      const sampled = this.island.sampleSurfaceByDirection(dir, 0);
      const coin = new THREE.Mesh(geo, mat);
      coin.position.copy(sampled.position).addScaledVector(sampled.normal, 0.35);
      // Stand on edge, aligned to the surface
      coin.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), sampled.normal);
      coin.rotateX(Math.PI / 2);
      coin.castShadow = true;
      coin.name = `coin_${i}`;
      this.add(coin);
      this.coins.push({ mesh: coin, respawnAt: 0 });
    }
  }

  // ── Watercraft ────────────────────────────────────────────────────────

  private buildBoat(): THREE.Group {
    const g = new THREE.Group();
    const hullMat = new THREE.MeshToonMaterial({ color: 0xb5532f });
    const woodMat = new THREE.MeshToonMaterial({ color: 0xe0c08a });
    // Hull: a tapered box with a raised bow
    const hull = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.5, 3.2), hullMat);
    hull.position.y = 0.25;
    g.add(hull);
    const bow = new THREE.Mesh(new THREE.ConeGeometry(0.7, 1.0, 4), hullMat);
    bow.rotation.x = -Math.PI / 2;
    bow.rotation.z = Math.PI / 4;
    bow.scale.set(1, 0.7, 1);
    bow.position.set(0, 0.25, 2.0);
    g.add(bow);
    // Deck + a little cabin
    const deck = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.08, 2.6), woodMat);
    deck.position.y = 0.5;
    g.add(deck);
    const cabin = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.6, 0.9), woodMat);
    cabin.position.set(0, 0.85, -0.7);
    g.add(cabin);
    g.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) o.castShadow = true;
    });
    return g;
  }

  private buildJetski(): THREE.Group {
    const g = new THREE.Group();
    const bodyMat = new THREE.MeshToonMaterial({ color: 0x27c2d6 });
    const seatMat = new THREE.MeshToonMaterial({ color: 0x223344 });
    const hull = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.35, 2.0), bodyMat);
    hull.position.y = 0.2;
    g.add(hull);
    const nose = new THREE.Mesh(new THREE.ConeGeometry(0.36, 0.8, 4), bodyMat);
    nose.rotation.x = -Math.PI / 2;
    nose.rotation.z = Math.PI / 4;
    nose.position.set(0, 0.24, 1.3);
    g.add(nose);
    const seat = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.18, 0.9), seatMat);
    seat.position.set(0, 0.42, -0.2);
    g.add(seat);
    const bars = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.08, 0.1), seatMat);
    bars.position.set(0, 0.5, 0.45);
    g.add(bars);
    g.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) o.castShadow = true;
    });
    return g;
  }

  /**
   * Boats + jetskis on the water off the beach, and the parked island cars
   * turned into drivable land vehicles.
   */
  private createVehicles(): void {
    const SPOTS: Array<{ kind: 'boat' | 'jetski'; lon: number; lat: number }> = [
      { kind: 'boat', lon: 0.3, lat: 0.14 },
      { kind: 'boat', lon: 3.4, lat: 0.12 },
      { kind: 'jetski', lon: 1.5, lat: 0.15 },
      { kind: 'jetski', lon: 4.6, lat: 0.13 },
    ];
    for (const s of SPOTS) {
      const dir = this.island.dirAt(s.lon, s.lat);
      const group = s.kind === 'boat' ? this.buildBoat() : this.buildJetski();
      group.name = `vehicle_${this.vehicles.length}`;
      group.scale.setScalar(1.1);
      // forward tangent points "uphill" toward the shore initially
      const north = new THREE.Vector3(0, 1, 0).addScaledVector(dir, -dir.y).normalize();
      const v = {
        group,
        kind: s.kind,
        dir: dir.clone(),
        forward: north,
        bob: Math.random() * 6,
        occupied: false,
        radius: 0,
        normal: dir.clone(),
        wheels: [] as THREE.Object3D[],
      };
      this.vehicles.push(v);
      this.add(group);
      this.placeWaterVehicle(v);
    }

    // Parked island cars → drivable land vehicles (collected in the collider
    // pass, colliders skipped). Keep their spot + heading; ground on terrain.
    for (const car of this.parkedCars) {
      const dir = car.getWorldPosition(new THREE.Vector3()).normalize();
      const sampled = this.island.sampleSurfaceByDirection(dir, 0);
      const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(car.quaternion);
      fwd.addScaledVector(sampled.normal, -fwd.dot(sampled.normal)).normalize();
      if (fwd.lengthSq() < 1e-6)
        fwd.copy(new THREE.Vector3(0, 1, 0).addScaledVector(dir, -dir.y)).normalize();
      const wheels: THREE.Object3D[] = [];
      car.traverse((o) => {
        if (o.userData && o.userData.isWheel) {
          // steer(Y) then roll(X): steer must be the outer rotation
          if (o.userData.isFront) o.rotation.order = 'YXZ';
          wheels.push(o);
        }
      });
      const v = {
        group: car,
        kind: 'car' as const,
        dir: dir.clone(),
        forward: fwd,
        bob: 0,
        occupied: false,
        radius: sampled.position.length() + 0.06, // smaller car → wheels sit lower
        normal: sampled.normal.clone(),
        wheels,
      };
      this.vehicles.push(v);
      this.placeVehicle(v, v.radius, v.normal);
    }
  }

  /** Place a water craft at the live wave surface (up = radial). */
  private placeWaterVehicle(v: {
    group: THREE.Object3D;
    dir: THREE.Vector3;
    forward: THREE.Vector3;
  }): void {
    const surf = this.island.waveHeightAt(v.dir, this.island.seaTimeUniform.value);
    this.placeVehicle(v as never, surf, v.dir);
  }

  /**
   * Position + orient a vehicle: sits at `surfaceR` along its dir, +Z faces
   * travel (`forward`, re-projected tangent to `up`), +Y is `up` (radial for
   * water, terrain normal for cars).
   */
  private placeVehicle(
    v: { group: THREE.Object3D; dir: THREE.Vector3; forward: THREE.Vector3 },
    surfaceR: number,
    up: THREE.Vector3,
  ): void {
    v.group.position.copy(v.dir).multiplyScalar(surfaceR);
    const zAxis = v.forward.clone();
    zAxis.addScaledVector(up, -zAxis.dot(up));
    if (zAxis.lengthSq() < 1e-6) {
      zAxis.set(0, 1, 0).addScaledVector(up, -up.y);
    }
    zAxis.normalize();
    const xAxis = new THREE.Vector3().crossVectors(up, zAxis).normalize();
    const yAxis = new THREE.Vector3().crossVectors(zAxis, xAxis).normalize();
    v.group.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(xAxis, yAxis, zAxis));
  }

  /** True while the player is riding a boat/jetski. */
  public isRidingVehicle(): boolean {
    return this.activeVehicle >= 0;
  }

  /** Kind of vehicle the local player is currently riding (null if on foot).
   * Broadcast over multiplayer so peers can render the craft under a rider. */
  public getActiveVehicleKind(): 'boat' | 'jetski' | 'car' | null {
    return this.activeVehicle >= 0 ? (this.vehicles[this.activeVehicle]?.kind ?? null) : null;
  }

  /** Full state of the vehicle the local player drives, for broadcasting: the
   * shared-index + exact world transform. Peers move THEIR copy of the same
   * vehicle to match, so it's the real craft (correct colour) and it stays put
   * when dropped. Null when on foot. */
  public getActiveVehicleState(): {
    idx: number;
    kind: 'boat' | 'jetski' | 'car';
    pos: [number, number, number];
    quat: [number, number, number, number];
  } | null {
    if (this.activeVehicle < 0) return null;
    const v = this.vehicles[this.activeVehicle];
    if (!v) return null;
    const p = v.group.position;
    const q = v.group.quaternion;
    return {
      idx: this.activeVehicle,
      kind: v.kind,
      pos: [+p.x.toFixed(2), +p.y.toFixed(2), +p.z.toFixed(2)],
      quat: [+q.x.toFixed(3), +q.y.toFixed(3), +q.z.toFixed(3), +q.w.toFixed(3)],
    };
  }

  /**
   * Apply peer-driven vehicle transforms to the local (identical, thanks to
   * seeded generation) world vehicles. Held vehicles are moved + marked
   * occupied so locals can't board them; released ones are left exactly where
   * the peer dropped them and re-opened for boarding — so a car another player
   * parks is right there for you to drive.
   */
  public syncRemoteVehicles(
    list: Array<{ idx: number; pos: THREE.Vector3; quat: THREE.Quaternion }>,
  ): void {
    const nowHeld = new Set<number>();
    for (const s of list) {
      const v = this.vehicles[s.idx];
      if (!v || s.idx === this.activeVehicle) continue; // never override my ride
      v.group.position.copy(s.pos);
      v.group.quaternion.copy(s.quat);
      // Keep the logical fields in step so idle placement / a later local
      // boarding uses the dropped location, not the original spawn.
      v.dir.copy(s.pos).normalize();
      v.radius = s.pos.length();
      v.normal.copy(v.dir);
      v.occupied = true;
      nowHeld.add(s.idx);
    }
    // Release vehicles no longer held remotely: leave them put, reopen boarding
    for (const idx of this.remoteHeldVehicles) {
      if (!nowHeld.has(idx) && idx !== this.activeVehicle) {
        const v = this.vehicles[idx];
        if (v) v.occupied = false;
      }
    }
    this.remoteHeldVehicles = nowHeld;
  }

  /** Steer the active vehicle (camera-relative, like player movement). */
  public setVehicleMove(forward: number, strafe: number): void {
    this.vehicleMove.forward = forward;
    this.vehicleMove.strafe = strafe;
  }

  // Hop-off hysteresis: the vehicle you just left is suppressed until you've
  // once been >3.4u away — disembarking drops you 1.8u beside the craft, so
  // without this the very next frame re-prompted "Press E to drive".
  private lastDisembarked = -1;

  /** Nearest boardable vehicle within range: {idx, dist} (idx -1 = none).
   *  Distance is exposed so the interaction chain can let the CLOSEST thing
   *  win — the old boolean check let a parked car shadow every NPC/door/bench
   *  within its 3.2u range. */
  public nearestBoardable(): { idx: number; dist: number } {
    if (this.activeVehicle >= 0) return { idx: -1, dist: Infinity };
    const p = this.player.getWorldPosition();
    if (
      this.lastDisembarked >= 0 &&
      this.vehicles[this.lastDisembarked] &&
      this.vehicles[this.lastDisembarked].group.position.distanceTo(p) > 3.4
    ) {
      this.lastDisembarked = -1;
    }
    let best = -1;
    let bestD = 3.2; // board range
    this.vehicles.forEach((v, i) => {
      if (v.occupied || i === this.lastDisembarked) return;
      const d = v.group.position.distanceTo(p);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    return { idx: best, dist: best >= 0 ? bestD : Infinity };
  }

  public vehicleKind(index: number): 'boat' | 'jetski' | 'car' | null {
    return this.vehicles[index]?.kind ?? null;
  }

  /** Board a vehicle: suspend player physics, pull the chase cam back. */
  public boardVehicle(index: number): void {
    const v = this.vehicles[index];
    if (!v || v.occupied) return;
    v.occupied = true;
    this.activeVehicle = index;
    this.vehicleMove.forward = 0;
    this.vehicleMove.strafe = 0;
    this.player.setRiding(true, v.kind === 'car' ? 'boat' : v.kind); // car sits like the boat helm
    this.orbitCamera?.setRideMode(true);
  }

  /**
   * Hop off beside the vehicle: into the water next to a boat/jetski (start
   * afloat), or onto the ground next to a car. Never teleported far away.
   */
  public disembarkVehicle(): void {
    if (this.activeVehicle < 0) return;
    const v = this.vehicles[this.activeVehicle];
    v.occupied = false;
    this.lastDisembarked = this.activeVehicle; // suppress instant re-prompt
    this.activeVehicle = -1;
    this.player.setRiding(false);
    this.orbitCamera?.setRideMode(false);
    this.orbitCamera?.setFollowVelocity(null);
    // step to the vehicle's side (perpendicular to heading) so we don't land
    // on the hull/roof
    const side = this._fxScratch.crossVectors(v.forward, v.dir).normalize();
    const dropDir = v.dir
      .clone()
      .addScaledVector(side, 1.8 / this.island.getRadius())
      .normalize();
    if (v.kind === 'car') {
      const s = this.island.sampleSurfaceByDirection(dropDir, 0);
      this.player.setWorldPosition(dropDir.multiplyScalar(s.position.length() + 0.75));
    } else {
      const surf = this.island.waveHeightAt(dropDir, this.island.seaTimeUniform.value);
      this.player.setWorldPosition(dropDir.multiplyScalar(surf + 0.55));
    }
    this.player.updateWorldMatrix();
    this.player.resetOxygen();
  }

  private _vehFwd = new THREE.Vector3();
  private _vehTangent = new THREE.Vector3();
  private _vehNext = new THREE.Vector3();
  private _vehBank = 0; // eased bank angle, driven by the applied turn rate
  // NPC obstacle-avoidance scratch (wander loop, allocation-free)
  private _npcColWorld = new THREE.Vector3();
  private _npcColPush = new THREE.Vector3();
  private _vehVel = new THREE.Vector3();
  private _carColWorld = new THREE.Vector3();
  private _carColPush = new THREE.Vector3();
  private _carDustAccum = 0;
  private static readonly CAR_COLLIDE_RADIUS = 1.0;

  /**
   * Slide a driving car's surface direction out of any town-structure footprint
   * it has entered (tangential push, like the player's own collision — the
   * radial axis is owned by grounding). Mutates `dir` in place.
   */
  private resolveCarCollision(dir: THREE.Vector3, surfaceR: number): void {
    const world = this._carColWorld.copy(dir).multiplyScalar(surfaceR);
    let pushed = false;
    // ≥0.3 (was ≥1.2): the old filter let cars drive clean through all 48
    // tree trunks, benches, gate posts, the statue and construction blocks —
    // only lamp poles (0.2) stay pass-through. Gate posts remain drivable-
    // between (4.2u spacing vs 1.4u exclusion per post).
    for (const c of this.colliders) {
      if (c.radius >= 0.3 && this.pushCarOutOf(world, c.position, c.radius)) pushed = true;
    }
    for (const o of this.placedObstacles) {
      if (this.pushCarOutOf(world, o.pos, o.radius)) pushed = true;
    }
    if (pushed) dir.copy(world).normalize();
  }

  /** One car-vs-collider resolve: tangential push out of the footprint. */
  private pushCarOutOf(world: THREE.Vector3, center: THREE.Vector3, cr: number): boolean {
    const dx = world.x - center.x;
    const dy = world.y - center.y;
    const dz = world.z - center.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const minDist = GameScene.CAR_COLLIDE_RADIUS + cr;
    if (dist >= minDist || dist < 1e-4) return false;
    // Strip the radial component so the push stays along the surface.
    this._carColPush.set(dx, dy, dz);
    this._carColPush.addScaledVector(world, -this._carColPush.dot(world) / world.lengthSq());
    if (this._carColPush.lengthSq() < 1e-6) return false;
    this._carColPush.normalize().multiplyScalar(minDist - dist + 0.02);
    world.add(this._carColPush);
    return true;
  }

  /** Per-frame: bob idle craft, drive the active one, keep the rider aboard. */
  private updateVehicles(deltaTime: number): void {
    if (this.vehicles.length === 0) return;
    const R = this.island.getRadius();
    for (let i = 0; i < this.vehicles.length; i++) {
      const v = this.vehicles[i];
      const isCar = v.kind === 'car';

      // A peer is driving this one — its transform is set by syncRemoteVehicles;
      // don't bob/re-place it here or we'd fight the networked position.
      if (this.remoteHeldVehicles.has(i)) continue;

      if (i === this.activeVehicle && this.orbitCamera) {
        // Drive: camera-relative move → step along a great circle. Cars stay
        // on land, boats/jetskis stay on water.
        const camF = this.orbitCamera.getForwardDirection();
        const camR = this.orbitCamera.getRightDirection();
        this._vehFwd
          .copy(camF)
          .multiplyScalar(this.vehicleMove.forward)
          .addScaledVector(camR, this.vehicleMove.strafe);
        let moving = false;
        // Real-metric speeds (1u≈1m): jetski 57.6km/h, car 46.8, boat 39.6 —
        // all clearly faster than the 28.8km/h sprint. The old 6.5u/s boat
        // was slower than running, so vehicles weren't worth boarding.
        const speed = v.kind === 'jetski' ? 16 : isCar ? 13 : 11;
        let appliedTurn = 0;
        if (this._vehFwd.length() > 0.02) {
          this._vehFwd.normalize();
          this._vehTangent
            .copy(this._vehFwd)
            .addScaledVector(v.dir, -this._vehFwd.dot(v.dir))
            .normalize();
          // Rotational inertia: ease the craft heading toward the input
          // tangent at a per-craft max turn rate instead of snapping — a
          // stick reversal now carves a U-turn (radius speed/TURN ≈ 4-5u)
          // instead of teleport-flipping the hull 180°.
          const TURN = v.kind === 'jetski' ? 3.0 : isCar ? 3.5 : 2.2; // rad/s
          const cross = this._vehNext.crossVectors(v.forward, this._vehTangent);
          const ang = Math.atan2(cross.dot(v.dir), v.forward.dot(this._vehTangent));
          appliedTurn = THREE.MathUtils.clamp(ang, -TURN * deltaTime, TURN * deltaTime);
          v.forward.applyAxisAngle(v.dir, appliedTurn).normalize();
          // Keep forward tangent to the sphere (numerical drift guard)
          v.forward.addScaledVector(v.dir, -v.forward.dot(v.dir)).normalize();
          const theta = (speed * deltaTime) / R;
          this._vehNext
            .copy(v.dir)
            .multiplyScalar(Math.cos(theta))
            .addScaledVector(v.forward, Math.sin(theta))
            .normalize();
          const onValidGround = isCar
            ? !this.island.isOverWater(this._vehNext) // cars keep off the sea
            : this.island.isOverWater(this._vehNext) && // craft keep on the sea…
              this._vehNext.y >= GameScene.SEA_EDGE_Y; // …but not past the sea edge
          if (onValidGround) {
            v.dir.copy(this._vehNext);
            moving = true;
          }
        }

        // Surface + up axis differ by terrain (car) vs waves (craft). Cars
        // re-sample the (expensive) terrain only while actually driving.
        let surfaceR: number;
        let up: THREE.Vector3;
        if (isCar) {
          if (moving) {
            const s = this.island.sampleSurfaceByDirection(v.dir, 0);
            v.radius = s.position.length() + 0.06;
            v.normal.copy(s.normal);
          }
          surfaceR = v.radius;
          up = v.normal;
          // Town collision: cars slide off building/stall footprints instead of
          // driving through them (watercraft roam open sea, so skip them).
          if (moving) this.resolveCarCollision(v.dir, surfaceR);
        } else {
          surfaceR = this.island.waveHeightAt(v.dir, this.island.seaTimeUniform.value);
          up = v.dir;
        }
        this.placeVehicle(v, surfaceR, up);
        // Bank into turns + pitch (motion feel). Bank follows the ACTUAL
        // applied turn rate (eased above), so it sweeps in and out with the
        // carve instead of popping on raw digital strafe.
        const turnRatio =
          deltaTime > 0 ? THREE.MathUtils.clamp(appliedTurn / deltaTime / 3.5, -1, 1) : 0;
        this._vehBank += (turnRatio * 0.35 - this._vehBank) * Math.min(1, 8 * deltaTime);
        v.group.rotateOnAxis(GameScene._localForward, -this._vehBank);
        v.group.rotateOnAxis(GameScene._localRight, -Math.abs(this.vehicleMove.forward) * 0.1);

        // Cars: roll the wheels (visible spokes), steer the fronts, and kick
        // up a dust trail so the driving actually READS as motion.
        if (isCar && v.wheels.length) {
          const dirSign = this.vehicleMove.forward < -0.01 ? -1 : 1;
          // wheel radius 0.2 * car scale 1.12 ≈ 0.224 — roll = arc / radius
          const roll = ((moving ? dirSign * speed : 0) * deltaTime) / 0.224;
          const steer = Math.max(-1, Math.min(1, this.vehicleMove.strafe)) * 0.5;
          for (const w of v.wheels) {
            w.rotation.x -= roll;
            if (w.userData.isFront) w.rotation.y = steer;
          }
          this._carDustAccum += deltaTime;
          if (moving && this._carDustAccum > 0.1) {
            this._carDustAccum = 0;
            const rear = v.dir.clone().multiplyScalar(surfaceR).addScaledVector(v.forward, -1.5);
            this.spawnDust(rear, 2);
          }
        }

        // Seat the rider; camera follows via playerPosition + trails motion.
        // Lower seat for the smaller car so the rider sits on it, not above.
        const seat = isCar ? 0.72 : 0.9;
        this.player.setWorldPosition(v.dir.clone().multiplyScalar(surfaceR + seat));
        const alignQ = new THREE.Quaternion().setFromUnitVectors(GameScene._localUp, v.dir);
        const local = v.forward.clone().applyQuaternion(alignQ.invert());
        this.player.setRotation(Math.atan2(local.x, local.z));
        this.player.updateWorldMatrix();
        this.orbitCamera.setFollowVelocity(
          moving ? this._vehVel.copy(v.forward).multiplyScalar(speed) : this._vehVel.set(0, 0, 0),
        );
      } else if (!isCar) {
        // Idle water craft bob on the swell (parked cars stay put)
        v.bob += deltaTime;
        this.placeWaterVehicle(v);
        v.group.position.addScaledVector(v.dir, Math.sin(v.bob * 1.4) * 0.06);
      }
    }
  }

  private respawnFromDrown(): void {
    const p = this.player.getWorldPosition();
    const lon = Math.atan2(p.z, p.x);
    // nearest dry beach at this longitude
    let placed = false;
    for (let lat = 0.32; lat <= 0.6; lat += 0.03) {
      const d = this.island.dirAt(lon, lat);
      if (!this.island.isOverWater(d)) {
        const s = this.island.sampleSurfaceByDirection(d, 0);
        this.player.setWorldPosition(d.clone().multiplyScalar(s.position.length() + 0.75));
        placed = true;
        break;
      }
    }
    if (!placed) {
      const s = this.island.sampleSurfaceByDirection(new THREE.Vector3(0, 1, 0), 0);
      this.player.setWorldPosition(new THREE.Vector3(0, s.position.length() + 0.75, 0));
    }
    this.player.updateWorldMatrix();
    this.player.resetOxygen();
    this.onDrownRespawn?.();
  }

  public setOnDrownRespawn(cb: () => void): void {
    this.onDrownRespawn = cb;
  }

  /**
   * Cozy chimney smoke: 3 looping puffs per chimney that rise along the
   * surface normal, growing and fading before wrapping back down.
   */
  private createChimneySmoke(): void {
    const puffGeo = new THREE.SphereGeometry(1, 6, 5);
    for (const site of this.island.chimneySites) {
      for (let p = 0; p < 3; p++) {
        const material = new THREE.MeshBasicMaterial({
          color: 0xe8e8e8,
          transparent: true,
          opacity: 0,
          depthWrite: false,
        });
        const mesh = new THREE.Mesh(puffGeo, material);
        this.add(mesh);
        this.smokePuffs.push({
          mesh,
          material,
          base: site.position.clone(),
          normal: site.normal.clone(),
          offset: p / 3,
        });
      }
    }
  }

  /**
   * Swap every opaque MeshStandardMaterial under the island for a
   * MeshToonMaterial with the shared gradient ramp — one consistent
   * cel-shaded look across terrain and props (messenger.abeto.co style).
   * Transparent/emissive-only materials (glass, sparkles, glow) keep
   * their original shading.
   */
  /**
   * ?theme=real: give the PBR materials an environment to reflect. A tiny
   * equirectangular gradient built from the day sky palette is PMREM-filtered
   * once (~a few ms, off the hot path) and set as scene.environment — this is
   * what stops un-toonified MeshStandardMaterials reading as "gray plastic".
   * EnvironmentCycle then drives scene.environmentIntensity with the day
   * factor so reflections dim at night. Needs the renderer, so main-simple
   * calls it after both exist (real theme only).
   */
  public applyRealEnvironment(renderer: THREE.WebGLRenderer): void {
    const c = document.createElement('canvas');
    c.width = 64;
    c.height = 32;
    const ctx = c.getContext('2d')!;
    const grad = ctx.createLinearGradient(0, 0, 0, 32);
    // Stops matched to PALETTE.day (EnvironmentCycle) so PBR water/materials
    // reflect the SAME sky that is drawn behind them. Were the old sky-dome
    // inits (#4a90d9/#a8d8f0/#7fb0c9), a bluer/paler sky than the rendered one.
    grad.addColorStop(0.0, '#2a6fd6'); // zenith = PALETTE.day.top
    grad.addColorStop(0.45, '#79b7e6'); // horizon = PALETTE.day.horizon
    grad.addColorStop(0.55, '#aecfe8'); // haze just below the horizon line
    grad.addColorStop(1.0, '#35708f'); // "ground" = sea-deep bounce light
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 64, 32);

    const equirect = new THREE.CanvasTexture(c);
    equirect.mapping = THREE.EquirectangularReflectionMapping;
    equirect.colorSpace = THREE.SRGBColorSpace;

    const pmrem = new THREE.PMREMGenerator(renderer);
    const envRT = pmrem.fromEquirectangular(equirect);
    this.environment = envRT.texture;
    this.environmentIntensity = 1;
    equirect.dispose();
    pmrem.dispose();
    console.log('🌐 Real theme: sky PMREM environment applied');
  }

  /**
   * Real theme's counterpart to toonify: one-time saturation/lightness lift on
   * every island material color. Continuous PBR shading + the soft sky PMREM
   * mute the flat-color palette (the toon ramp used to do the punching); this
   * restores it. Vertex-colored surfaces (terrain, grass) are graded where
   * their colors are BUILT (Island.ts — material.color is white there, so an
   * HSL lift here would do nothing). Materials are mutated in place (they're
   * the live ones) and deduped so shared materials aren't graded twice.
   */
  private gradeRealMaterials(): void {
    const seen = new Set<string>();
    let count = 0;
    // Whole scene, not just island.mesh (toonify's old scope): the zone plaza
    // discs, NPCs and other scene-level props are big fixed-color surfaces
    // that read washed-out if left out of the grade. The guards below make
    // this safe — only non-vertex-colored MeshStandardMaterials are touched.
    this.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh) return;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const mat of mats) {
        const m = mat as THREE.MeshStandardMaterial;
        if (!m || !m.isMeshStandardMaterial || seen.has(m.uuid)) continue;
        seen.add(m.uuid);
        if (m.vertexColors) continue; // graded at color-build time in Island
        m.color.offsetHSL(0, 0.12, 0.02);
        count++;
      }
    });
    console.log('🎨 Real theme: graded', count, 'materials (+sat)');
  }

  private toonifyIslandMaterials(): void {
    const gradientMap = Materials.createGradientMap();
    const cache = new Map<string, THREE.MeshToonMaterial>();
    const convert = (mat: THREE.Material): THREE.Material => {
      if (!(mat instanceof THREE.MeshStandardMaterial)) return mat;
      if (mat.transparent) return mat;
      const cached = cache.get(mat.uuid);
      if (cached) return cached;
      const toon = new THREE.MeshToonMaterial({
        color: mat.color.clone(),
        emissive: mat.emissive.clone(),
        emissiveIntensity: mat.emissiveIntensity,
        map: mat.map,
        vertexColors: mat.vertexColors,
        gradientMap,
      });
      // Carry custom onBeforeCompile injections through the swap (currently
      // just the terrain material's wet-sand band). The chunks they target
      // (<common>, <begin_vertex>, <color_fragment>) exist in the toon shaders
      // too, and Material.onBeforeCompile defaults to a no-op, so copying it
      // is free for every uncustomised material — and the default
      // customProgramCacheKey (onBeforeCompile.toString()) keeps the terrain
      // toon clone on its own shader program without splitting the others.
      toon.onBeforeCompile = mat.onBeforeCompile;
      cache.set(mat.uuid, toon);
      return toon;
    };
    this.island.mesh.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh) return;
      if (Array.isArray(mesh.material)) {
        mesh.material = mesh.material.map(convert);
      } else if (mesh.material) {
        mesh.material = convert(mesh.material);
      }
    });
    console.log('🎨 Toonified island materials:', cache.size, 'unique materials converted');
  }

  private createSkyDome(): void {
    const skyGeo = new THREE.SphereGeometry(800, 32, 16);
    const skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: {
        // Seeded from PALETTE.day (EnvironmentCycle overwrites per-frame): no
        // first-frame palette pop, and a correct look if the cycle fails to init.
        topColor: { value: new THREE.Color(0x2a6fd6) },
        bottomColor: { value: new THREE.Color(0xc0def2) },
        horizonColor: { value: new THREE.Color(0x79b7e6) },
        offset: { value: 0 },
        // Lower exponent = the top-sky blue arrives at lower elevations;
        // the follow camera mostly frames 0-30 deg where 0.5 left the sky
        // horizon-pale (washed near-white after ACES tone mapping)
        exponent: { value: 0.35 },
        // Camera's local up (updated per frame): the gradient follows the
        // player around the sphere instead of being world-Y locked, so the
        // sky doesn't wash out on the far side of the planet
        uUp: { value: new THREE.Vector3(0, 1, 0) },
      },
      vertexShader: `
        varying vec3 vWorldPosition;
        void main() {
          vec4 worldPos = modelMatrix * vec4(position, 1.0);
          vWorldPosition = worldPos.xyz;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform vec3 topColor;
        uniform vec3 bottomColor;
        uniform vec3 horizonColor;
        uniform float offset;
        uniform float exponent;
        uniform vec3 uUp;
        varying vec3 vWorldPosition;
        void main() {
          float h = dot(normalize(vWorldPosition + offset), uUp);
          float t = max(h, 0.0);
          vec3 sky = mix(horizonColor, topColor, pow(t, exponent));
          float b = max(-h, 0.0);
          sky = mix(sky, bottomColor, pow(b, 0.8));
          gl_FragColor = vec4(sky, 1.0);
        }
      `,
    });
    const skyDome = new THREE.Mesh(skyGeo, skyMat);
    skyDome.name = 'SkyDome';
    skyDome.renderOrder = -1;
    this.add(skyDome);
    this.skyUpUniform = skyMat.uniforms.uUp as { value: THREE.Vector3 };
    this.skyColorUniforms = {
      topColor: skyMat.uniforms.topColor as { value: THREE.Color },
      bottomColor: skyMat.uniforms.bottomColor as { value: THREE.Color },
      horizonColor: skyMat.uniforms.horizonColor as { value: THREE.Color },
    };
  }

  /**
   * Place decorative assets on the island surface
   */
  private async placeAssets(): Promise<void> {
    // Island.ts is the SOLE town authority: it hand-places the district houses,
    // office towers, market stalls and the 10 boulevard lamps along its street
    // network. The old TownPlanner flat-grid pass that ran here duplicated those
    // props and re-projected them onto random, often sub-shoreline latitudes
    // (houses and lamps ended up underwater on the north-cap island) — it has
    // been removed. Only the quest mailboxes the delivery loop needs land here.

    // Seat an asset on the DISPLACED terrain with +Y along the outward normal.
    const placeOnSphere = (
      mesh: THREE.Object3D,
      angle: number,
      latitude: number, // radians from equator, positive = north
      radiusOffset: number,
      clearArc: number = 0.2,
    ) => {
      const cosLat = Math.cos(latitude);
      let dir = new THREE.Vector3(
        Math.cos(angle) * cosLat,
        Math.sin(latitude),
        Math.sin(angle) * cosLat,
      ).normalize();
      // Shared spacing registry + keep OFF the streets (roadside is fine, on-road isn't)
      dir = this.island.claimOffStreet(dir, clearArc);
      let R = this.island.getRadius();
      try {
        R = this.island.sampleSurfaceByDirection(dir, 0).position.length();
      } catch {
        /* ideal-sphere fallback */
      }
      mesh.position.copy(dir.clone().multiplyScalar(R + radiusOffset));
      mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    };

    // Quest mailboxes: spread across the ISLAND's habitable latitude bands
    // (coastal road up to the highlands) so the delivery chain tours the whole
    // map. Every latitude here is ABOVE the shoreline (sin(0.27)); southern
    // latitudes are open ocean.
    const MAILBOX_LATS = [0.55, 0.3, 0.95, 0.42, 0.75];
    const mailboxes: Mailbox[] = [];
    for (let i = 0; i < MAILBOX_LATS.length; i++) {
      const mailbox = new Mailbox();
      this.add(mailbox.mesh);
      mailbox.mesh.scale.setScalar(0.55); // real-scale: roadside mailbox, not a monument
      placeOnSphere(mailbox.mesh, i * 2.399963, MAILBOX_LATS[i], -0.02, 0.3);
      mailboxes.push(mailbox);
    }

    // APPEND colliders (never ASSIGN — that would wipe the island prop colliders
    // registered in initialize() and leave houses/trees ghost-walkable).
    this.colliders.push(
      ...mailboxes.map((m) => ({ position: m.mesh.position.clone(), radius: 1 })),
    );
    this.mailboxes = mailboxes;
    this.lamps = []; // boulevard lamps live in Island.ts (named lamp_<i>); collected separately

    console.log('🏝️ Island assets placed:', {
      colliders: this.colliders.length,
      mailboxes: this.mailboxes.length,
    });
  }

  /**
   * Scatter low-poly toon props (Blender-exported glb) onto the sphere surface.
   * Uses the same "+Y = outward normal" projection the lamps/mailboxes use, so
   * props sit flush on the planet instead of the flat-grid TownPlanner placement.
   */
  private async scatterProps(): Promise<void> {
    const GOLDEN = 2.399963; // golden angle for even angular spread

    const placeOnSphere = (
      obj: THREE.Object3D,
      angle: number,
      latitude: number,
      clearArc = 0.22,
    ) => {
      const cosLat = Math.cos(latitude);
      let dir = new THREE.Vector3(
        Math.cos(angle) * cosLat,
        Math.sin(latitude),
        Math.sin(angle) * cosLat,
      ).normalize();
      dir = this.island.claimOffStreet(dir, clearArc); // shared anti-cluster registry + off streets
      // Seat on the displaced terrain, not the ideal sphere
      let R = this.island.getRadius();
      try {
        R = this.island.sampleSurfaceByDirection(dir, 0).position.length();
      } catch {
        /* ideal-sphere fallback */
      }
      obj.position.copy(dir.clone().multiplyScalar(R - 0.07)); // roots sunk: bury-not-float
      obj.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
      obj.rotateY(Math.random() * Math.PI * 2); // random yaw around the surface normal
    };

    const enableShadows = (root: THREE.Object3D) =>
      root.traverse((c) => {
        if ((c as THREE.Mesh).isMesh) {
          c.castShadow = true;
          c.receiveShadow = true;
        }
      });

    let rockCount = 0;

    // NOTE: the tree.glb scatter is gone. At ~5.6u native height the GLB
    // trees towered 3x over the houses and their bare trunk + ball canopy
    // read as "gray poles with green balls" ringing the spawn. The island's
    // 48 in-scale procedural trees carry the forest now.

    const rock = await loadGLTFWithFallbacks('/assets/models/rock.glb');
    if (rock) {
      const N = 8;
      for (let i = 0; i < N; i++) {
        const inst = rock.scene.clone(true);
        placeOnSphere(inst, i * GOLDEN + 1.0, 0.3 + Math.random() * 0.8); // above-shore band (was -0.8..0.8: half sat underwater)
        inst.scale.multiplyScalar(0.6 + Math.random() * 0.6);
        enableShadows(inst);
        this.add(inst);
        rockCount++;
      }
    }

    console.log('🌲 Scattered Blender toon props:', { rocks: rockCount });
  }

  /**
   * Update scene (call from render loop)
   */
  public update(deltaTime: number): void {
    if (!this.player) return;

    // Inside a building: freeze the island world (player physics, camera
    // follow, NPCs, everything) and run the interior free-walk mode instead.
    // The spherical physics state is untouched, so exiting drops the player
    // back at the door.
    if (this.insideInterior) {
      this.updateInteriorMode(deltaTime);
      return;
    }

    // Real theme's saturation grade, deferred to the first update so the
    // whole populated scene (zones, NPCs, town props — added after
    // construction) is in the traverse. Dedupe inside makes re-runs safe.
    if (isRealTheme() && !this.realGradeDone) {
      this.realGradeDone = true;
      this.gradeRealMaterials();
    }

    // Update player physics
    this.player.update(deltaTime);

    // Check collisions with assets
    this.checkPlayerCollisions();

    // Update camera (suspended while the tour rail drives it directly)
    if (this.orbitCamera && !this.cameraSuspended) {
      this.orbitCamera.update(deltaTime);
    }

    // Update GLTF animations
    this.animationMixers.forEach((mixer) => {
      mixer.update(deltaTime);
    });

    // Update mailboxes (for pulse animation)
    const time = performance.now() / 1000;
    this.mailboxes.forEach((mailbox) => {
      mailbox.update(time);
    });

    // Drift clouds around the planet
    for (const pivot of this.cloudPivots) {
      pivot.rotateY((pivot.userData.driftSpeed as number) * deltaTime);
    }

    // Gull flocks: V-formation orbit + soar + flap/glide cycle + night roost
    const birdDay = this.envCycle ? this.envCycle.getDayFactor() : 1;
    // Birds shelter in bad weather. Gulls will ride out a squall in reality,
    // but a sky full of circling birds through heavy rain reads as a bug, and
    // "the sky empties before the rain" is a detail people recognise. Ground
    // birds stay out (they forage in drizzle) but stop hopping about.
    const wet = this.envCycle
      ? this.envCycle.getWeather() === 'rain' || this.envCycle.getWeather() === 'snow'
      : false;
    for (const b of this.birds) {
      // Roost after dusk — or take cover in rain: shrink away in place, and
      // return at dawn / when it clears (toward the bird's own base size).
      const roostTarget = birdDay < 0.3 || wet ? 0.001 : b.size;
      const s = THREE.MathUtils.lerp(b.bird.scale.x, roostTarget, 1 - Math.exp(-3 * deltaTime));
      b.bird.scale.setScalar(s);
      b.bird.visible = s > 0.05;
      if (!b.bird.visible) continue;
      // One rotation per flock — the leader carries the shared pivot and the
      // wingmen ride along in their rigid V slots.
      if (b.lead) b.pivot.rotateY(b.speed * deltaTime);
      // FLUTTER, not freeze: real birds beat their wings most of the time.
      // The old cycle flapped 35% and held the wings rigid for the rest, so
      // whenever you looked up you mostly caught a dead-winged glide. Now:
      // ~2.2 beats/s for 75% of the cycle — a two-harmonic stroke (snappy,
      // deep power stroke down; shallow, quick recovery up) — and the brief
      // glide bouts keep a live tremor so the wings never look frozen.
      const flapCycle = (time * 0.31 + b.phase) % 1;
      let flap: number;
      if (flapCycle < 0.75) {
        const w = time * 14 + b.phase;
        const stroke = Math.sin(w) + 0.3 * Math.sin(2 * w + 0.7);
        flap = stroke > 0 ? stroke * 0.32 : stroke * 0.62;
      } else {
        flap = 0.15 + Math.sin(time * 6 + b.phase) * 0.05;
      }
      // THE bug behind "tilting instead of flapping": wingR carries
      // rotation.y = π, which already reverses how its z-rotation reads, so
      // the old `-flap` "mirror" put the wings in ANTI-phase — left tip up
      // while right tip down, the whole bird see-sawing like one rigid
      // plank. Same sign on both = both tips beat up and down TOGETHER.
      b.wingL.rotation.z = flap;
      b.wingR.rotation.z = flap;
      // Slow soar: the whole formation drifts up and down as it circles
      // (per-flock phase via the shared pivot id keeps the V together).
      b.bird.position
        .copy(b.dirLocal)
        // Soar bob trimmed ±0.5 → ±0.2: the big vertical wander was part of
        // what read as "tilting around" instead of flying + flapping.
        .multiplyScalar(b.alt + b.altOff + Math.sin(time * 0.5 + b.pivot.id) * 0.2)
        .add(b.tangentOff);
    }

    // Ground birds: feeding FSM (jab → scan → hop) → flush when the player
    // closes in → land again later.
    const gbPlayer = this.player ? this.player.getWorldPosition() : null;
    for (const g of this.groundBirds) {
      if (g.mode === 'peck') {
        // Night roost, matching the flocks: shrink away after dusk and grow
        // back at dawn (ground birds used to feed at 3am while gulls slept).
        const gRoost = birdDay < 0.3 ? 0.001 : g.size;
        const gScale = THREE.MathUtils.lerp(g.bird.scale.x, gRoost, 1 - Math.exp(-3 * deltaTime));
        g.bird.scale.setScalar(gScale);
        g.bird.visible = gScale > 0.05;
        if (!g.bird.visible) continue;
        // Advance the feed sub-state when its timer runs out.
        if (time > g.feedUntil) {
          // Leaving scan: fold the current wiggle offset into heading so
          // the head doesn't snap back on exit.
          if (g.feed === 'scan') g.heading += Math.sin((time - g.hopT0) * 1.1) * 0.45;
          if (g.feed === 'hop') {
            // Land, then maybe chain another hop (birds bounce in runs).
            g.curPos.copy(g.hopTo);
            if (Math.random() < 0.4) this.startGroundBirdHop(g, time);
            else {
              g.feed = Math.random() < 0.75 ? 'jab' : 'scan';
              g.hopT0 = time; // doubles as the scan-entry wiggle anchor
              g.feedUntil = time + 1.0 + Math.random() * 1.4;
            }
          } else {
            // Hunkered down in the wet: keep pecking and scanning, but no
            // hopping about the place.
            const r = wet ? 0.5 + Math.random() * 0.5 : Math.random();
            if (r < 0.3) this.startGroundBirdHop(g, time);
            else if (r < 0.62) {
              g.feed = 'scan';
              g.hopT0 = time; // wiggle anchor — starts the look-around at 0
              g.feedUntil = time + 0.8 + Math.random() * 1.2;
            } else {
              g.feed = 'jab';
              g.feedUntil = time + 1.2 + Math.random() * 1.2;
            }
          }
        }
        // Pitch convention (proven by the beak's rotation.x = -PI/2):
        // NEGATIVE rotateX = nose-down in this model.
        let pitch = 0;
        let yaw = g.heading;
        if (g.feed === 'hop') {
          // Little parabolic bounce between perches, nose dipped into it.
          const ht = Math.min(1, (time - g.hopT0) / GameScene.GROUND_HOP_DUR);
          g.bird.position
            .lerpVectors(g.hopFrom, g.hopTo, ht)
            .addScaledVector(g.up, Math.sin(Math.PI * ht) * 0.14);
          pitch = -0.18 * Math.sin(Math.PI * ht);
        } else if (g.feed === 'jab') {
          // Sharp distinct DOWN-jabs (pow narrows the sine into pecks),
          // not the old continuous nodding.
          const s = Math.max(0, Math.sin(time * 9 + g.phase * 7));
          pitch = -Math.pow(s, 0.65) * 0.6;
          g.bird.position.copy(g.curPos);
        } else {
          // Vigilance: head UP, slowly looking around — real feeding birds
          // alternate head-down pecking with head-up scanning. The wiggle
          // is anchored at scan entry (hopT0) so it starts and stays smooth.
          pitch = 0.1;
          yaw = g.heading + Math.sin((time - g.hopT0) * 1.1) * 0.45;
          g.bird.position.copy(g.curPos);
        }
        g.bird.quaternion.copy(g.baseQuat);
        g.bird.rotateY(yaw);
        g.bird.rotateX(pitch);
        // Wings stay FOLDED along the body on the ground (screenshot-verified:
        // spread wings on a grounded bird read as a crashed glider, not a
        // bird). Occasional quick ruffle = feather shuffle between pecks.
        const ruffle =
          g.feed !== 'hop' && Math.sin(time * 0.23 + g.phase) > 0.96
            ? Math.sin(time * 26 + g.phase) * 0.35
            : 0;
        // Folded = swept back, drooped over the body sides AND compacted:
        // a full-span 0.65u panel can't hide behind a 0.4u body no matter
        // the angle (screenshot: splayed "paper plane"), so the fold also
        // shortens the wing — the flee branch restores full span.
        g.wingL.scale.x = 0.55;
        g.wingR.scale.x = 0.55;
        g.wingL.rotation.y = -1.15;
        g.wingR.rotation.y = Math.PI + 1.15;
        // Same z sign on both — the π-yawed right wing reverses z visually.
        g.wingL.rotation.z = -0.32 + ruffle;
        g.wingR.rotation.z = -0.32 + ruffle;
        // Tail: resting raised tilt with the occasional quick flick.
        g.tail.rotation.x =
          -0.16 + (Math.sin(time * 0.37 + g.phase * 2) > 0.985 ? Math.sin(time * 30) * 0.3 : 0);
        // Feeding birds tolerate a much closer approach — that's the point of
        // throwing feed. When the pile is finished they scatter home.
        const feasting = g.feastUntil > time;
        if (!feasting && g.feastUntil > 0) {
          // Pile finished: aim the bookkeeping home and scatter. The escape
          // tangent must be rebuilt HERE — g.away was built against the home
          // normal and is not tangent to the ground the bird is standing on.
          this.releaseFeastingBird(g);
          this.pickGroundBirdEscape(g, gbPlayer);
          g.mode = 'flee';
          g.t0 = time;
          continue;
        }
        const flushR = feasting ? 1.4 : 3.2;
        if (gbPlayer && gbPlayer.distanceToSquared(g.curPos) < flushR * flushR) {
          // Flushed mid-hop: sync curPos to the rendered spot first so the
          // climb starts where the bird visibly IS, not its takeoff perch.
          if (g.feed === 'hop') g.curPos.copy(g.bird.position);
          // Flushed OFF a pile: end the feast too, or basePos stays parked on
          // the pile and the respawn gate (player > 5u from basePos) keeps the
          // bird invisible for as long as the player stands by their own feed.
          if (feasting) this.releaseFeastingBird(g);
          g.mode = 'flee';
          g.t0 = time;
          // Flee away from the player, tangent to the ground.
          this._gbScratch.copy(g.curPos).sub(gbPlayer);
          this._gbScratch.addScaledVector(g.up, -this._gbScratch.dot(g.up));
          if (this._gbScratch.lengthSq() > 0.1) g.away.copy(this._gbScratch).normalize();
          g.heading = this.groundBirdHeadingFor(g, g.away); // face the escape
          sfx.blip();
        }
      } else if (g.mode === 'flyto') {
        // Answering thrown feed: arc across to the pile and land on it.
        const ft = Math.min(1, (time - g.flyT0) / g.flyDur);
        g.bird.position
          .lerpVectors(g.flyFrom, g.flyTo, ft)
          .addScaledVector(g.up, Math.sin(Math.PI * ft) * (1.2 + g.flyDur * 1.4));
        const climbing = ft < 0.5;
        this._gbScratch.copy(g.flyTo).sub(g.flyFrom);
        if (this._gbScratch.lengthSq() > 1e-6) {
          g.heading = this.groundBirdHeadingFor(g, this._gbScratch);
        }
        g.bird.quaternion.copy(g.baseQuat);
        g.bird.rotateY(g.heading);
        g.bird.rotateX(climbing ? 0.3 : -0.2); // nose up on the climb, down to land
        g.legs.rotation.x = ft > 0.75 ? 0 : -1.25; // gear down on approach
        g.wingL.scale.x = 1;
        g.wingR.scale.x = 1;
        g.wingL.rotation.y = 0;
        g.wingR.rotation.y = Math.PI;
        const wf = Math.sin(time * 18 + g.phase) * (climbing ? 1.0 : 0.7);
        g.wingL.rotation.z = wf;
        g.wingR.rotation.z = wf;
        g.bird.scale.setScalar(g.size);
        if (ft >= 1) {
          // Touch down: the landing spot BECOMES the bird's base, so the
          // existing tether/hop/flush logic feeds it here with no new cases.
          g.mode = 'peck';
          g.feed = 'jab';
          g.feedUntil = time + 0.6;
          g.curPos.copy(g.flyTo);
          g.basePos.copy(g.flyTo);
          const dir = this._gbScratch.copy(g.flyTo).normalize();
          const s = this.island.analyticSurface(dir);
          g.analBase = s.radius;
          g.up.copy(s.normal);
          g.baseQuat.setFromUnitVectors(GameScene.AXIS_Y, s.normal);
          g.legs.rotation.x = 0;
        }
      } else if (g.mode === 'flee') {
        const t = time - g.t0;
        if (t > 2.6) {
          g.mode = 'gone';
          g.bird.visible = false;
          // Short absence (was 22-42s): flushing every bird then finding the
          // area empty for half a minute read as "no birds on the ground".
          g.respawnAt = time + 8 + Math.random() * 8;
          continue;
        }
        // Climb-out from the CURRENT perch: accelerate up and away, nose
        // lifted, fast flapping.
        g.bird.position
          .copy(g.curPos)
          .addScaledVector(g.up, t * t * 1.6 + t * 0.8)
          .addScaledVector(g.away, t * 4.2);
        g.bird.quaternion.copy(g.baseQuat);
        g.bird.rotateY(g.heading);
        g.bird.rotateX(0.35); // POSITIVE = nose lifted into the climb
        g.tail.rotation.x = -0.16;
        g.legs.rotation.x = -Math.min(1.25, t * 2.5); // tuck legs after takeoff
        const fastFlap = Math.sin(time * 24 + g.phase) * 1.1; // panicked burst
        g.wingL.scale.x = 1; // full span again
        g.wingR.scale.x = 1;
        g.wingL.rotation.y = 0; // wings snap OPEN for the climb-out
        g.wingR.rotation.y = Math.PI;
        g.wingL.rotation.z = fastFlap;
        g.wingR.rotation.z = fastFlap; // same sign — π yaw flips z visually
      } else if (
        time > g.respawnAt &&
        birdDay >= 0.3 && // no landings at night — they're roosting
        (!gbPlayer || gbPlayer.distanceToSquared(g.basePos) > 5 * 5)
      ) {
        // Coast clear — settle back onto the home spot facing a new way,
        // growing in via the roost lerp instead of popping. Landing home also
        // restores the home SURFACE FRAME: a bird that fed at a pile has been
        // flying with that pile's normal, which is up to ~45deg off here.
        g.mode = 'peck';
        g.feed = 'jab';
        g.feedUntil = time + 1 + Math.random();
        g.heading = Math.random() * Math.PI * 2;
        g.up.copy(g.homeUp);
        g.baseQuat.copy(g.homeQuat);
        this.pickGroundBirdEscape(g, null);
        g.curPos.copy(g.basePos);
        g.bird.visible = true;
        g.bird.scale.setScalar(0.06 * g.size);
        g.bird.position.copy(g.basePos);
        g.bird.quaternion.copy(g.baseQuat);
        g.bird.rotateY(g.heading);
        g.legs.rotation.x = 0; // legs back down for landing
      }
    }

    this.updateFeedPiles(time);
    this.updateFishFeedPiles(time);

    // Trees: gentle sway + a slow wind gust that rolls through every ~25s so
    // the whole canopy leans together, not just idle jitter.
    const gust = 1 + 0.7 * Math.max(0, Math.sin(time * 0.25));
    for (const tr of this.swayTrees) {
      this._swayQuat.setFromAxisAngle(
        GameScene._swayAxis,
        Math.sin(time * 1.1 + tr.phase) * 0.018 * gust,
      );
      tr.group.quaternion.copy(tr.baseQuat).multiply(this._swayQuat);
    }

    // NPCs: wander their district (stroll → pause → stroll) with a walk
    // bob, facing eased toward the travel direction, plus the greet hop
    if (this.island) {
      const npcPlayerW = this.player.getWorldPosition();
      for (let i = 0; i < this.island.npcTargets.length; i++) {
        const npc = this.island.npcTargets[i];
        // The Fisherman + Baker run their own routines — skip the wander for them
        if (this.fisherman && npc === this.fisherman.npc) continue;
        if (this.baker && npc === this.baker.npc) continue;
        if (this.sailor && npc === this.sailor.npc) continue;
        // Market Vendors mind their pitches — they don't wander off to shop.
        if (this.vendors.some((v) => v.npc === npc)) continue;
        const data = npc.meshRef.userData as {
          greetT0?: number;
          lastGreetAt?: number;
          lastSpokeAt?: number; // aware proximity-greeting throttle
          wander?: {
            home: THREE.Vector3;
            dir: THREE.Vector3;
            target: THREE.Vector3;
            state: 'idle' | 'walk';
            until: number;
            yaw: number;
            radius: number;
            normal: THREE.Vector3;
            nextSampleAt: number;
            dist: number; // accumulated ground distance — waddle/bob phase
            roll: number; // current waddle roll (eased to 0 when idle)
            rot: number; // rotation index through an activity's anchor list
            activity?: NpcActivities.ActivityId; // current scheduled activity
            pose?: NpcActivities.PoseId; // idle pose while at an anchor
            nextDwell?: number; // seconds to dwell on arrival at the goal
            faceDir?: THREE.Vector3; // lazily-allocated idle facing (reused)
            faceActive?: boolean; // faceDir holds a valid dir for this goal
            blockedT?: number; // seconds spent grinding a footprint (give-up)
          };
        };
        if (!data.wander) {
          const home = npc.meshRef.position.clone().normalize();
          data.wander = {
            home,
            dir: home.clone(),
            target: home.clone(),
            state: 'idle',
            until: time + 2 + Math.random() * 6,
            yaw: Math.random() * Math.PI * 2,
            radius: 0,
            normal: new THREE.Vector3(0, 1, 0),
            nextSampleAt: 0,
            dist: 0,
            roll: 0,
            rot: (Math.random() * 100) | 0,
          };
        }
        const w = data.wander;
        let moving = false;
        if (w.state === 'idle') {
          if (time > w.until) {
            // Ask the activity engine where this NPC should go next (persona +
            // hour + mood). null (e.g. Market Vendor) → the plain random wander.
            const goal =
              this.npcPersonaIds.length > i
                ? NpcActivities.getGoal(
                    this.npcPersonaIds[i],
                    this.envCycle ? this.envCycle.getHour() : 12,
                    this.envCycle ? this.envCycle.getDayFactor() : 1,
                    getWorldState()?.mood,
                    w,
                    this._goalScratch,
                  )
                : null;
            if (goal) {
              w.target.copy(this._goalScratch);
              w.activity = goal.activity;
              w.pose = goal.pose;
              w.nextDwell = goal.dwellMin + Math.random() * (goal.dwellMax - goal.dwellMin);
              // Activity facing (artist paints SEAWARD, keeper watches the
              // tower): resolve the hint into a world dir once per goal; the
              // orientation block applies it while idle (player-greet wins).
              if (goal.face) {
                w.faceDir ??= new THREE.Vector3(); // one-time per NPC
                w.faceActive = NpcActivities.computeFaceDir(
                  goal.face,
                  this._goalScratch,
                  w.faceDir,
                );
              } else {
                w.faceActive = false;
              }
              const role = GameScene.NPC_ROLES[npc.name]?.role ?? npc.name;
              this.setNpcBadge(i, role, NpcActivities.ACTIVITY_DEFS[goal.activity].short);
            } else {
              w.target.copy(this.randomDirNear(w.home, 0.1));
              w.activity = undefined;
              w.pose = undefined;
              w.faceActive = false;
              w.nextDwell = 3 + Math.random() * 7;
            }
            // Island-only world: never pick a stroll target below the
            // shoreline — NPCs were wandering into the surf
            if (w.target.y < Math.sin(0.3)) {
              w.target.y = Math.sin(0.3) + 0.02;
              w.target.normalize();
            }
            w.state = 'walk';
          }
        } else {
          const remaining = w.dir.angleTo(w.target);
          if (remaining < 0.004) {
            w.state = 'idle';
            w.until = time + (w.nextDwell ?? 3 + Math.random() * 7);
          } else {
            this._wanderAxis.crossVectors(w.dir, w.target);
            if (this._wanderAxis.lengthSq() > 1e-10) {
              this._wanderAxis.normalize();
              // ~1.4 u/s stroll on the R=50 sphere (a 5 km/h human walk)
              const step = Math.min(0.028 * deltaTime, remaining);
              w.dir.applyAxisAngle(this._wanderAxis, step);
              // Obstacle avoidance: slide the NPC's ground point out of the
              // big structure footprints (houses/stalls/fountain/buildings)
              // so townsfolk stop phasing through cottage walls. Same
              // tangential push the car uses; NPC radius 0.3.
              if (w.radius > 0) {
                this._npcColWorld.copy(w.dir).multiplyScalar(w.radius);
                let npcPushed = false;
                for (const c of this.colliders) {
                  if (c.radius < 1.2) continue;
                  const dx = this._npcColWorld.x - c.position.x;
                  const dy = this._npcColWorld.y - c.position.y;
                  const dz = this._npcColWorld.z - c.position.z;
                  const d2 = dx * dx + dy * dy + dz * dz;
                  const min = c.radius + 0.3;
                  if (d2 >= min * min || d2 < 1e-8) continue;
                  const d = Math.sqrt(d2);
                  this._npcColPush.set(dx, dy, dz);
                  this._npcColPush.addScaledVector(
                    this._npcColWorld,
                    -this._npcColPush.dot(this._npcColWorld) / this._npcColWorld.lengthSq(),
                  );
                  if (this._npcColPush.lengthSq() < 1e-6) continue;
                  this._npcColPush.normalize().multiplyScalar(min - d + 0.02);
                  this._npcColWorld.add(this._npcColPush);
                  npcPushed = true;
                }
                if (npcPushed) {
                  w.dir.copy(this._npcColWorld).normalize();
                  // Give-up guard. Several activity anchors sit ON a building
                  // footprint (the musician's plaza, the keeper's tower), and
                  // the old guard just idled for 2s and re-picked the SAME
                  // unreachable spot — measured live, five townsfolk were
                  // walking 100% of the time while blocked 50% of it, shoving
                  // a wall forever and never doing their job. Now a blocked
                  // NPC ARRIVES where it stands: it keeps the activity and
                  // pose and works from just outside the wall, which is what
                  // a person would do. Only a goal it has barely approached
                  // is abandoned outright.
                  w.blockedT = (w.blockedT ?? 0) + deltaTime;
                  if (w.blockedT > 1.5) {
                    w.blockedT = 0;
                    w.state = 'idle';
                    const nearGoal = w.dir.angleTo(w.target) < GameScene.NPC_ARRIVE_ENOUGH;
                    if (nearGoal) {
                      // Close enough — settle in and run the activity here.
                      w.until = time + (w.nextDwell ?? 3 + Math.random() * 7);
                      w.target.copy(w.dir);
                    } else {
                      // Genuinely walled off en route: give up on this anchor
                      // and let the next pick rotate to a different one.
                      w.rot += 1;
                      w.until = time + 1.5;
                    }
                  }
                } else if (w.blockedT) {
                  // DECAY, never hard-reset. The push only re-fires on a frame
                  // whose step re-consumes the 0.02u overshoot, which above
                  // ~71fps is only every 2nd-4th frame — a hard reset here made
                  // the whole give-up dead on any high-refresh display.
                  w.blockedT = Math.max(0, w.blockedT - deltaTime * 0.5);
                }
              }
              // Gait phase = accumulated ground distance, so cadence tracks
              // actual motion. (radius is 0 until the first surface sample —
              // one frame of missed phase, invisible.)
              w.dist += step * w.radius;
              // Travel direction (tangent) = axis × dir
              this._wanderFwd.crossVectors(this._wanderAxis, w.dir).normalize();
              moving = true;
            } else {
              w.state = 'idle';
              w.until = time + 2;
            }
          }
        }
        // PERF: terrain sampling is ~1.9ms a call — 20 NPCs sampling every
        // frame cost 37ms and dropped the game to 22 FPS. Cache the surface
        // radius + normal per NPC (staggered ~6Hz refresh while walking);
        // the per-frame position is the analytic dir × radius, so motion
        // stays perfectly smooth at near-zero sampling cost.
        if (w.radius === 0 || (moving && time > w.nextSampleAt)) {
          const sampled = this.island.sampleSurfaceByDirection(w.dir, 0.02);
          w.radius = sampled.position.length();
          w.normal.copy(sampled.normal);
          w.nextSampleAt = time + 0.15 + (i % 5) * 0.012;
        }
        this._npcNormal.copy(w.normal);
        // Greet hop
        let hop = 0;
        if (typeof data.greetT0 === 'number') {
          const gt = time - data.greetT0;
          if (gt < 0.4) hop = Math.sin((gt / 0.4) * Math.PI) * 0.25;
          else delete data.greetT0;
        }
        // Walk bob is faster/taller than the idle breathing bob. While
        // walking it runs on the gait-distance phase: 2π/stepLength ≈ 8 rad/u
        // for a 0.75u stroll step. (The old ×18 was tuned for the R=18-era
        // 0.5u/s stroll; at today's 1.4u/s it vibrated every NPC at 4Hz.)
        let bob = moving
          ? (Math.sin(w.dist * 8 + i * 1.7) + 1) * 0.03
          : (Math.sin(time * 2 + i * 1.7) + 1) * 0.015;
        // Waddle: roll about the local forward axis at HALF the footfall
        // frequency (left step / right step), eased out on stopping so the
        // body settles upright instead of freezing mid-lean.
        let rollTarget = moving ? Math.sin(w.dist * 4 + i * 1.7) * 0.07 : 0;
        // Activity pose: while standing at an anchor, the pose preset drives the
        // idle motion (kneel low + slow, play bouncy, sleep near-still) and a
        // vertical `lift` (a crouch/lie via the surface-normal offset — no extra
        // terrain sampling). This whole-group modulation is the pose vocabulary
        // on top of the limb swing below.
        let lift = 0;
        if (!moving && w.pose) {
          const p = NpcActivities.POSE_PRESETS[w.pose];
          if (p) {
            bob = (Math.sin(time * p.bobFreq + i * 1.7) + 1) * p.bobAmp;
            rollTarget = Math.sin(time * p.bobFreq * 0.5 + i) * p.rollAmp;
            lift = p.lift;
          }
        }
        w.roll += (rollTarget - w.roll) * Math.min(1, 12 * deltaTime);
        this.swingNpcLimbs(npc.meshRef, w, moving, i, deltaTime);
        // Night: an NPC that has ARRIVED at its sleep spot (the nearest cottage
        // door) steps "inside" — hidden until the schedule wakes it. The walk
        // home stays visible, so visitors see the townsfolk head in at dusk.
        // Tags/quest markers mirror this in their own loops; interaction skips
        // hidden NPCs.
        npc.meshRef.visible = !(w.activity === 'sleep' && !moving);
        npc.meshRef.position
          .copy(w.dir)
          .multiplyScalar(w.radius)
          .addScaledVector(this._npcNormal, bob + hop + lift);
        npc.position.copy(npc.meshRef.position);

        // Notice the player: when they walk near, turn to face them and greet
        // once (throttled). Makes the townsfolk feel aware, not scripted props.
        this._wanderFwd2.subVectors(npcPlayerW, npc.meshRef.position);
        const toPlayerDist = this._wanderFwd2.length();
        let faceFwd: THREE.Vector3 | null = moving ? this._wanderFwd : null;
        // Idle activity facing: project the goal's face dir onto the live
        // tangent plane (_wanderFwd is free while idle — reuse as scratch).
        // The player-proximity block below still overrides it (greet wins).
        if (!moving && w.faceActive && w.faceDir) {
          this._wanderFwd
            .copy(w.faceDir)
            .addScaledVector(this._npcNormal, -w.faceDir.dot(this._npcNormal));
          if (this._wanderFwd.lengthSq() > 1e-6) faceFwd = this._wanderFwd.normalize();
        }
        if (toPlayerDist < GameScene.NPC_FACE_RANGE) {
          // project player direction onto the NPC's tangent plane
          this._wanderFwd2.addScaledVector(this._npcNormal, -this._wanderFwd2.dot(this._npcNormal));
          if (this._wanderFwd2.lengthSq() > 1e-6) faceFwd = this._wanderFwd2.normalize();
          if (
            toPlayerDist < GameScene.NPC_GREET_RANGE &&
            (data.lastGreetAt === undefined || time - data.lastGreetAt > 12)
          ) {
            data.greetT0 = time;
            data.lastGreetAt = time;
            // Aware proximity greeting: AI townsfolk SPEAK first — a bubble +
            // voice line composed from live state (their planner-assigned
            // activity, the hour, the day-theme). Throttled per NPC; one
            // bubble at a time; skipped for sleepers and non-AI NPCs.
            if (
              isAiNpc(npc.name) &&
              npc.meshRef.visible &&
              (data.lastSpokeAt === undefined || time - data.lastSpokeAt > 120) &&
              time > this.npcBubbleUntil
            ) {
              data.lastSpokeAt = time;
              const ws = getWorldState();
              const text = composeAwareGreeting({
                activity: w.activity,
                hour: this.envCycle ? this.envCycle.getHour() : 12,
                event: ws?.npcPlan?.event,
              });
              this.showNpcSpeechBubble(i, text, time);
              if (isSpeechEnabled()) {
                const v = voiceProfileFor(npc.name);
                speak(text, v.rate, v.pitch, v.variant);
              }
            }
          }
        }

        // Orientation: surface-aligned, yaw eased toward the desired facing
        // (the player when close, otherwise the travel direction)
        this._swayQuat.setFromUnitVectors(GameScene._localUp, this._npcNormal);
        if (faceFwd) {
          this._wanderZ.set(0, 0, 1).applyQuaternion(this._swayQuat);
          const cosA = THREE.MathUtils.clamp(this._wanderZ.dot(faceFwd), -1, 1);
          const sinA = this._npcNormal.dot(this._wanderAxis.crossVectors(this._wanderZ, faceFwd));
          const yawTarget = Math.atan2(sinA, cosA);
          let dYaw = yawTarget - w.yaw;
          while (dYaw > Math.PI) dYaw -= Math.PI * 2;
          while (dYaw < -Math.PI) dYaw += Math.PI * 2;
          w.yaw += dYaw * Math.min(1, 6 * deltaTime);
        }
        npc.meshRef.quaternion
          .copy(this._swayQuat)
          .multiply(this._wanderYawQ.setFromAxisAngle(GameScene._localUp, w.yaw))
          .multiply(this._npcRollQ.setFromAxisAngle(GameScene._localForward, w.roll));
      }

      // Grass wind (GPU-side — just advance the shared uniform)
      this.island.grassTimeUniform.value = time;
    }

    // Sea waves (GPU-side + shared with the CPU swim/boat sampler) + the tide
    this.island.seaTimeUniform.value = time;
    this.island.updateTide(time);
    // Summit beacon: slow spin + gentle bob so the reward reads as alive
    if (this.island.summitBeacon) {
      this.island.summitBeacon.rotation.y = time * 0.7;
      this.island.summitBeacon.position.y = 1.35 + Math.sin(time * 1.6) * 0.12;
    }
    this.updateVehicles(deltaTime);
    this.races?.update(deltaTime, this.player.getWorldPosition(), this.getActiveVehicleKind());
    this.updateWaterFX(deltaTime);
    this.updateFish(deltaTime, time);
    this.updateCats(deltaTime, time);
    this.updateNpcShadows();
    this.updateHerons(time);
    this.updateFisherman(time, deltaTime);
    this.updateBaker(time, deltaTime);
    this.updateSailor(time, deltaTime);
    this.updateVendors(time);
    // Carried quest fish: gentle wiggle in the player's hands
    if (this.carriedFish) this.carriedFish.rotation.z = Math.sin(time * 5) * 0.15;
    // Generic gold coin-pops
    for (let i = this.popCoins.length - 1; i >= 0; i--) {
      const c = this.popCoins[i];
      const p = (time - c.t0) / 1.0;
      if (p >= 1) {
        this.remove(c.mesh);
        this.popCoins.splice(i, 1);
        continue;
      }
      c.mesh.position.addScaledVector(c.n, deltaTime * 0.9);
      c.mesh.rotation.y += deltaTime * 6;
      (c.mesh.material as THREE.MeshBasicMaterial).opacity = 1 - p;
    }

    // Butterflies: slow figure-8 drift + fast wing flap
    for (const bf of this.butterflies) {
      const t = time * 0.6 + bf.phase;
      bf.group.position
        .copy(bf.base)
        .addScaledVector(bf.normal, 0.35 + Math.sin(time * 1.3 + bf.phase) * 0.1)
        .addScaledVector(bf.tanA, Math.sin(t) * 0.35)
        .addScaledVector(bf.tanB, Math.sin(t * 2) * 0.18);
      const flap = Math.sin(time * 14 + bf.phase) * 1.05;
      bf.wingL.rotation.y = flap;
      bf.wingR.rotation.y = Math.PI - flap;
    }

    // Close-range ambience only exists near the ground: while the camera
    // is far (cinematic fly-in), dust/sparkles/smoke/butterflies read as
    // debris hovering around the planet
    // Threshold tracks radius (R + ~5u): the chase cam orbits a few units above
    // the surface, so |cam| ≈ R+5 in play and ≫ that on the fly-in. A hardcoded
    // 45 (tuned at R40) went PERMANENTLY false at R50 — |cam|≈55 — silently
    // hiding ambient life, chimney smoke AND the delivery guide sparkles.
    const camNear = this.camera
      ? this.camera.position.length() < this.island.getRadius() + 6
      : true;
    for (const g of this.ambientGroups) g.visible = camNear;

    // Chimney smoke: puffs loop up the normal, growing and fading
    for (const puff of this.smokePuffs) {
      puff.mesh.visible = camNear;
      const ph = (time * 0.22 + puff.offset) % 1;
      puff.mesh.position.copy(puff.base).addScaledVector(puff.normal, 0.1 + ph * 1.1);
      puff.mesh.position.x += Math.sin(time * 0.8 + puff.offset * 7) * 0.06 * ph;
      const s = 0.05 + ph * 0.16;
      puff.mesh.scale.set(s, s, s);
      puff.material.opacity = 0.4 * Math.sin(ph * Math.PI);
    }

    const playerPos = this.player.getWorldPosition();

    // Guide sparkles: arc ahead of the player along the great circle to
    // the delivery target. Terrain resampling runs on a 0.15s throttle;
    // every frame just bobs/spins around the cached base position.
    let guideVisible = false;
    if (this.guideTarget) {
      this._playerDir.copy(playerPos).normalize();
      this._targetDir.copy(this.guideTarget).normalize();
      const totalAngle = this._playerDir.angleTo(this._targetDir);
      this._guideAxis.crossVectors(this._playerDir, this._targetDir);
      const R = playerPos.length();
      if (totalAngle > 0.08 && this._guideAxis.lengthSq() > 1e-8) {
        guideVisible = true;
        const refresh = time > this.guideRefreshAt;
        if (refresh) this.guideRefreshAt = time + 0.15;
        this._guideAxis.normalize();
        for (let i = 0; i < this.guideSparkles.length; i++) {
          const s = this.guideSparkles[i];
          const sData = s.userData as { base?: THREE.Vector3; normal?: THREE.Vector3 };
          if (refresh || !sData.base) {
            const arcAngle = Math.min((2.0 + i * 1.6) / R, totalAngle * 0.9);
            this._guideDir.copy(this._playerDir).applyAxisAngle(this._guideAxis, arcAngle);
            const sampled = this.island.sampleSurfaceByDirection(this._guideDir, 0);
            sData.base = (sData.base ?? new THREE.Vector3()).copy(sampled.position);
            sData.normal = (sData.normal ?? new THREE.Vector3()).copy(sampled.normal);
          }
          s.position
            .copy(sData.base as THREE.Vector3)
            .addScaledVector(sData.normal as THREE.Vector3, 0.45 + Math.sin(time * 2.5 + i) * 0.08);
          s.rotation.y = time * 2 + i;
          const sc = 0.85 + Math.sin(time * 3 + i * 0.8) * 0.15;
          s.scale.set(sc, sc, sc);
          s.visible = camNear;
        }
      }
    }
    if (!guideVisible) {
      for (const s of this.guideSparkles) s.visible = false;
    }

    // Coins: spin in place; on touch they fly up, spin fast, and shrink
    // away (0.45s) before hiding; respawn after 45s
    for (const c of this.coins) {
      const cu = c.mesh.userData as { homePos?: THREE.Vector3; collectT0?: number };
      if (typeof cu.collectT0 === 'number') {
        const ct = time - cu.collectT0;
        const home = cu.homePos as THREE.Vector3;
        if (ct >= 0.45) {
          c.mesh.visible = false;
          delete cu.collectT0;
          c.mesh.position.copy(home);
          c.mesh.scale.setScalar(1);
        } else {
          this._npcNormal.copy(home).normalize();
          c.mesh.position.copy(home).addScaledVector(this._npcNormal, ct * 2.4);
          c.mesh.scale.setScalar(Math.max(0.01, 1 - ct / 0.45));
          c.mesh.rotateOnWorldAxis(this._npcNormal, deltaTime * 18);
        }
        continue;
      }
      if (!c.mesh.visible) {
        if (c.respawnAt > 0 && time > c.respawnAt) {
          // Respawn at a FRESH random meadow spot (away from the plazas)
          // instead of the same place every time
          const anchors = [
            ...RING_DISTRICT_LONS.map((l) => this.island.dirAt(l, ZONE_LAT)),
            new THREE.Vector3(0, 1, 0),
          ];
          const dir = new THREE.Vector3();
          for (let attempt = 0; attempt < 8; attempt++) {
            dir
              .set(
                Math.random() * 2 - 1,
                // island-only: respawns stay on the north cap, above shore
                Math.sin(0.3) + Math.random() * (1 - Math.sin(0.3)),
                Math.random() * 2 - 1,
              )
              .normalize();
            if (dir.y < Math.sin(0.3)) continue;
            if (anchors.every((a) => dir.angleTo(a) > 0.2)) break;
          }
          const sampled = this.island.sampleSurfaceByDirection(dir, 0);
          c.mesh.position.copy(sampled.position).addScaledVector(sampled.normal, 0.35);
          c.mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), sampled.normal);
          c.mesh.rotateX(Math.PI / 2);
          const cuR = c.mesh.userData as { homePos?: THREE.Vector3 };
          if (cuR.homePos) cuR.homePos.copy(c.mesh.position);
          c.mesh.visible = true;
          c.respawnAt = 0;
        }
        continue;
      }
      this._npcNormal.copy(c.mesh.position).normalize();
      c.mesh.rotateOnWorldAxis(this._npcNormal, deltaTime * 2.5);
      if (c.mesh.position.distanceToSquared(playerPos) < 0.9) {
        if (!cu.homePos) cu.homePos = c.mesh.position.clone();
        cu.homePos.copy(c.mesh.position);
        cu.collectT0 = time;
        // 120s (was 45s): a 45s cycle made the meadow an infinite coin farm, so
        // hat prices were a timer, not a choice. Slower respawn makes race +
        // quest + delivery rewards the sane way to kit out.
        c.respawnAt = time + 120;
        sfx.coin();
        this.coinsCollected++;
        try {
          localStorage.setItem('ds_coins', String(this.coinsCollected));
        } catch {
          /* session-only counter */
        }
        this.onCoinCollected?.(this.coinsCollected);
      }
    }

    // Day/night handoff for the small life: butterflies by day,
    // blinking fireflies wandering the flower clusters by night
    const dayFactor = this.envCycle ? this.envCycle.getDayFactor() : 1;
    const butterfliesOut = dayFactor > 0.25 && camNear;
    for (const bf of this.butterflies) {
      bf.group.visible = butterfliesOut;
    }
    const fireflyGlow = 1 - dayFactor;
    for (const ff of this.fireflies) {
      if (fireflyGlow < 0.05 || !camNear) {
        ff.mesh.visible = false;
        continue;
      }
      ff.mesh.visible = true;
      const t = time * 0.4 + ff.phase;
      ff.mesh.position
        .copy(ff.base)
        .addScaledVector(ff.normal, 0.35 + Math.sin(time * 0.9 + ff.phase) * 0.15)
        .addScaledVector(ff.tanA, Math.sin(t) * 0.5)
        .addScaledVector(ff.tanB, Math.sin(t * 1.7 + 1.3) * 0.5);
      // Blink: each firefly pulses on its own rhythm
      ff.material.opacity =
        fireflyGlow * (0.35 + 0.65 * Math.max(0, Math.sin(time * 2.2 + ff.phase * 3)));
    }

    // Keep the sky gradient oriented to the camera's local "up" so the
    // mood doesn't shift as the player circumnavigates
    if (this.skyUpUniform && this.camera) {
      this.skyUpUniform.value.copy(this.camera.position).normalize();
    }

    // Dust puffs: scatter along the tangent, grow and fade over 0.5s
    for (const p of this.dustPuffs) {
      if (!p.mesh.visible) continue;
      const t = time - p.t0;
      if (t > 0.5) {
        p.mesh.visible = false;
        continue;
      }
      p.mesh.position
        .copy(p.origin)
        .addScaledVector(p.dir, t * 1.6)
        .addScaledVector(p.normal, 0.05 + t * 0.15);
      const s = 0.05 + t * 0.28;
      p.mesh.scale.set(s, s, s);
      p.mat.opacity = 0.45 * (1 - t / 0.5);
    }

    // Prop wiggles (mailbox thank-you wobble): decaying shake, then restore
    for (let i = this.wiggles.length - 1; i >= 0; i--) {
      const w = this.wiggles[i];
      const t = time - w.t0;
      if (t > 0.6) {
        w.obj.quaternion.copy(w.baseQuat);
        this.wiggles.splice(i, 1);
        continue;
      }
      this._swayQuat.setFromAxisAngle(GameScene._swayAxis, Math.sin(t * 26) * 0.14 * (1 - t / 0.6));
      w.obj.quaternion.copy(w.baseQuat).multiply(this._swayQuat);
    }

    // Quest markers: follow their (wandering) NPC, bob + spin
    for (const m of this.questMarkers) {
      const owner = this.island.npcTargets.find((n) => n.name === m.npcName);
      if (owner) {
        m.base.copy(owner.meshRef.position);
        m.normal.copy(m.base).normalize();
      }
      // 2.7 matches setQuestMarkers: keeps the bobbing "!" clear of the
      // bottom-anchored name pill below it.
      m.mesh.position.copy(m.base).addScaledVector(m.normal, 2.7 + Math.sin(time * 2.4) * 0.12);
      m.mesh.rotateOnWorldAxis(m.normal, deltaTime * 1.8);
      // A sleeping quest-giver is "inside" — no marker floating over the doorstep.
      if (owner) m.mesh.visible = owner.meshRef.visible;
    }

    // NPC name pins: follow each (wandering) NPC, sit just above the head,
    // scale with camera distance so they stay legible from afar, and fade
    // out when you're right next to the NPC (so the pin never covers them).
    for (const tag of this.nameTags) {
      const pos = tag.target.position;
      this._tagNormal.copy(pos).normalize();
      // Bottom-anchored (see createNameTags), so 1.55 IS the pill's bottom
      // edge: 0.17 above the tallest dressed head (wizard hat ≈1.33 world
      // after the 0.6×1.07 NPC group scale) at every camera distance.
      tag.sprite.position
        .copy(pos)
        .addScaledVector(this._tagNormal, 1.55 + Math.sin(time * 2 + pos.x) * 0.05);
      const dist = this.camera.position.distanceTo(tag.sprite.position);
      // Constant-ish on-screen size: sprites attenuate ∝1/dist, so scale ∝dist.
      const s = THREE.MathUtils.clamp(dist * 0.055, 1.1, 3.6);
      // 0.63 aspect matches the 256×96 two-line pill canvas (0.42 was the old
      // 64px canvas — it squished the role+activity pill every frame).
      tag.sprite.scale.set(s * 1.7, s * 0.63, 1);
      // Fade: hidden hugging-close, full through mid range, gone past the horizon
      const op =
        dist < 2.6
          ? 0
          : dist < 6
            ? (dist - 2.6) / 3.4
            : dist < 62
              ? 1
              : dist < 88
                ? 1 - (dist - 62) / 26
                : 0;
      const mat = tag.sprite.material as THREE.SpriteMaterial;
      mat.opacity = op;
      // No pin over an empty doorstep while its NPC sleeps "inside".
      tag.sprite.visible = op > 0.02 && tag.target.meshRef.visible;
    }

    // Speech bubble follows its speaker just above the name pin; auto-hides.
    if (this.npcBubble && this.npcBubble.sprite.visible) {
      const tag = this.nameTags[this.npcBubbleFor];
      if (time > this.npcBubbleUntil || !tag || !tag.target.meshRef.visible) {
        this.npcBubble.sprite.visible = false;
      } else {
        // Both sprites are bottom-anchored, so the pill's current world
        // height IS its scale.y — seat the bubble 0.12 above the pill's top
        // so the distance-scaled pill can never grow up into it.
        this.npcBubble.sprite.position
          .copy(tag.sprite.position)
          .addScaledVector(
            this._tagNormal.copy(tag.target.position).normalize(),
            tag.sprite.scale.y + 0.12,
          );
      }
    }

    // Drain colliders queued by async GLB placements (e.g. the orchard/
    // forest trees, which finish loading after the registration pass)
    if (this.island.pendingColliders.length > 0) {
      this.colliders.push(...this.island.pendingColliders);
      console.log(
        `🧱 +${this.island.pendingColliders.length} async prop colliders (total ${this.colliders.length})`,
      );
      this.island.pendingColliders.length = 0;
    }

    // Day/night + weather cycle
    if (this.envCycle) {
      this.envCycle.update(deltaTime, playerPos, time);
      this.updateAtmosphereGrade(deltaTime);
    }
    // Animate the zone markers (orb bob + slow spin). ZonesManager.update was
    // never called, so Zone.update() had been dead code — the markers sat
    // perfectly static, losing the "this is alive, come here" affordance.
    this.zonesManager.update(time);
    // AFTER the cycle, which owns the sun's direction each frame
    this.updateSunShadow(playerPos);
  }

  /**
   * Per-frame day/night + weather grading owned by GameScene: ambient retint
   * (lamps/windows/fireflies need a dark cool floor to pop against), cloud
   * tint/coverage, and the lamp light pools. Zero allocations.
   */
  private updateAtmosphereGrade(deltaTime: number): void {
    if (!this.envCycle) return;
    const day = this.envCycle.getDayFactor();
    const ambient = this.lights.ambient;
    if (ambient) {
      // 0.22 warm by day → 0.10 cool blue at night (floor keeps shapes readable)
      ambient.intensity = 0.1 + 0.12 * day;
      ambient.color.lerpColors(GameScene._ambientNight, GameScene._ambientDay, day);
    }
    if (this.cloudMat) {
      const w = this.envCycle.getWeather();
      const wet = w === 'rain' ? 1 : w === 'snow' ? 0.7 : w === 'cloudy' ? 0.55 : 0;
      // Weather flips are discrete — ease so the cloudscape doesn't pop
      this.cloudWet += (wet - this.cloudWet) * Math.min(1, deltaTime * 0.5);
      // Dusk proxy: dayFactor's smoothstep midpoint = sun at the horizon
      const dusk = Math.max(0, 1 - Math.abs(day * 2 - 1));
      this.cloudMat.color
        .copy(GameScene._cloudClear)
        .lerp(GameScene._cloudDusk, dusk * 0.6 * (1 - this.cloudWet))
        .lerp(GameScene._cloudStorm, this.cloudWet);
      this.cloudMat.opacity = 0.92 + 0.06 * this.cloudWet;
    }
    if (this.lampPoolMat) {
      this.lampPoolMat.opacity = 0.55 * (1 - day);
    }
    // Street lamps switch on at dusk: near-off by day, warm and bright at
    // night (matches the light pools' 1-day fade).
    if (this.lampBulbMats.length) {
      const glow = 0.05 + 1.35 * (1 - day);
      for (const m of this.lampBulbMats) m.emissiveIntensity = glow;
    }
    // Per-district atmosphere: nudge the fog toward the nearest plaza's accent by
    // proximity, so arriving in a district gives a subtle warm/cool shift (the
    // "you have arrived somewhere" cue). Runs AFTER EnvironmentCycle writes
    // fog.color from the sky horizon; faded by daylight so night stays true.
    if (this.player && this.fog) {
      this._atmDir.copy(this.player.getWorldPosition()).normalize();
      const w = districtAccentAt(this._atmDir, this._atmAccent) * 0.12 * day;
      if (w > 0) (this.fog as THREE.FogExp2).color.lerp(this._atmAccent, w);
    }
  }

  /**
   * Park the sun's shadow box on the player. EnvironmentCycle sets the sun's
   * position on an arc from the origin — that vector is the light DIRECTION.
   * We keep the direction but re-seat the light above the player and aim it at
   * them, so the tight ortho box is always spent where the camera is looking
   * instead of being smeared across the whole planet.
   */
  private updateSunShadow(playerPos: THREE.Vector3): void {
    const sun = this.lights.sun;
    if (!sun) return;
    this._sunDir.copy(sun.position).normalize();
    if (this._sunDir.lengthSq() < 1e-6) return;
    sun.position.copy(playerPos).addScaledVector(this._sunDir, 55);
    sun.target.position.copy(playerPos);
    sun.target.updateMatrixWorld();
    // Rim tracks the day cycle — a bright rim over a dark night scene would
    // read as a light leak. Keeps a little at night for moonlit separation.
    if (this.rimLight) {
      const day = this.envCycle ? this.envCycle.getDayFactor() : 1;
      this.rimLight.intensity = 0.12 + 0.43 * day;
    }
  }

  public getEnvironmentCycle(): EnvironmentCycle | null {
    return this.envCycle;
  }

  /**
   * Check and resolve player collisions with assets
   */
  private checkPlayerCollisions(): void {
    // Seated players sit INSIDE the bench's collider by design
    if (this.player.isSeated()) return;
    const playerPos = this.player.getWorldPosition();
    const playerRadius = 0.4; // Player collision radius

    // Shared tangential push. Returns the push distance (0 = no overlap).
    const pushOut = (center: THREE.Vector3, radius: number): number => {
      const dist = playerPos.distanceTo(center);
      const minDist = playerRadius + radius;
      if (dist >= minDist) return 0;
      // Push player away TANGENTIALLY: a radial component here shoves the
      // player into the terrain (visible as being 'dug in' while walking
      // past props) or launches them off it — grounding owns the radial axis.
      const normal = playerPos.clone().normalize();
      const direction = playerPos.clone().sub(center);
      direction.sub(normal.clone().multiplyScalar(direction.dot(normal)));
      if (direction.lengthSq() < 1e-6)
        direction.copy(normal.clone().cross(new THREE.Vector3(0, 1, 0.001)));
      direction.normalize();
      const pushDistance = minDist - dist + 0.01; // Small buffer to prevent re-collision
      playerPos.addScaledVector(direction, pushDistance);
      this.player.setWorldPosition(playerPos);
      this.player.updateWorldMatrix();
      return pushDistance;
    };

    // Causation: running into something should FEEL like contact, not a
    // silent teleport. Throttled dust puff + soft thud, plus a canopy shake
    // when the thing you hit is a tree.
    const bumpFeedback = (center: THREE.Vector3, push: number) => {
      const now = performance.now() / 1000;
      if (push < 0.06 || this.player.getTangentialSpeed() < 2) return;
      if (now - this.lastBumpAt < 0.4) return;
      this.lastBumpAt = now;
      this._bumpScratch.copy(center).lerp(playerPos, 0.5);
      this.spawnDust(this._bumpScratch, 2);
      sfx.land();
      for (const t of this.swayTrees) {
        if (t.group.position.distanceToSquared(center) < 0.36) {
          t.phase += 2.4; // one-shot kick — the canopy visibly shudders
          break;
        }
      }
    };

    for (const collider of this.colliders) {
      const push = pushOut(collider.position, collider.radius);
      if (push > 0) bumpFeedback(collider.position, push);
    }

    // Parked vehicles are solid on foot (the camera already treated them as
    // solid — feet now agree). Positions are live, so a driven-then-parked
    // car blocks at its NEW spot with no ghost wall at the old one.
    for (let i = 0; i < this.vehicles.length; i++) {
      if (i === this.activeVehicle || this.remoteHeldVehicles.has(i)) continue;
      const v = this.vehicles[i];
      const isCar = v.kind === 'car';
      // Watercraft only block while the player is actually in the water.
      if (!isCar && !this.player.isInWater()) continue;
      const push = pushOut(v.group.position, isCar ? 1.1 : 0.9);
      if (push > 0) bumpFeedback(v.group.position, push);
    }

    // Live townsfolk are solid too — and being bumped triggers the existing
    // greet hop/turn, so pushed NPCs visibly react instead of ghosting.
    for (const npc of this.island.npcTargets) {
      const mesh = npc.meshRef;
      if (!mesh || !mesh.visible) continue; // sleepers/hidden skip
      const push = pushOut(mesh.position, 0.45);
      if (push > 0.02) {
        const data = mesh.userData as { greetT0?: number };
        if (typeof data.greetT0 !== 'number') data.greetT0 = performance.now() / 1000;
      }
    }
  }

  // Throttle for collision bump feedback (dust/thud once per 0.4s)
  private lastBumpAt = 0;
  private readonly _bumpScratch = new THREE.Vector3();

  /**
   * Check if player is near any interactable and return interaction data
   * Uses caching to avoid expensive distance calculations every frame
   */
  public getNearbyInteractable():
    | { type: 'mailbox'; mailbox: Mailbox; distance: number }
    | { type: 'lamp'; lamp: TownPlanResult['lamps'][number]; distance: number }
    | { type: 'zone'; zone: any; distance: number }
    | { type: 'npc'; npcData: { name: string; dialogue: string[] }; distance: number }
    | { type: 'bench'; benchGroup: THREE.Object3D; distance: number }
    | { type: 'house_door'; id: string; distance: number }
    | null {
    if (!this.player) return null;

    const playerPos = this.player.getWorldPosition();

    // Check if player has moved far enough to invalidate cache
    if (
      this.cachedNearby &&
      playerPos.distanceTo(this.lastPlayerPos) < this.cacheDistanceThreshold
    ) {
      // NPCs MOVE while the player stands still — revalidate cached NPC hits
      // so the prompt can't say "talk to X" after X wandered away (and E
      // can't open a chat across the map).
      if (this.cachedNearby.type === 'npc') {
        const name = this.cachedNearby.npcData.name;
        const live = this.island.npcTargets.find((n) => n.name === name);
        if (
          !live ||
          !live.meshRef.visible ||
          live.meshRef.position.distanceTo(playerPos) > this.interactionRange
        ) {
          this.cachedNearby = null; // fall through to a fresh scan
        } else {
          return this.cachedNearby;
        }
      } else {
        return this.cachedNearby;
      }
    }

    // Update cache position
    this.lastPlayerPos.copy(playerPos);

    let nearest: any = null;
    let nearestDist = this.interactionRange;

    // Check mailboxes
    for (const mailbox of this.mailboxes) {
      const d = mailbox.mesh.position.distanceTo(playerPos);
      if (d < nearestDist) {
        nearest = { type: 'mailbox' as const, mailbox, distance: d };
        nearestDist = d;
      }
    }

    // Check lamps (toggle on/off)
    for (const lamp of this.lamps) {
      const d = lamp.group.position.distanceTo(playerPos);
      if (d < nearestDist) {
        nearest = { type: 'lamp' as const, lamp, distance: d };
        nearestDist = d;
      }
    }

    // Check zones. Zone distance is CENTER-measured: the 1.7 collider + 0.4
    // player radius means a visitor at the door is always ≥2.05u away, so
    // benches/NPCs loitering at the plaza kept shadowing the portfolio's core
    // "enter" prompt. A 0.9u bias makes the doorway win locally while distant
    // zones still lose fairly.
    const nearbyZone = this.zonesManager.getNearbyZone(playerPos, this.interactionRange);
    if (nearbyZone && nearbyZone.distance - 0.9 < nearestDist) {
      nearest = { type: 'zone' as const, zone: nearbyZone.zone, distance: nearbyZone.distance };
      nearestDist = nearbyZone.distance - 0.9;
    }

    // Check NPCs (skip ones asleep "inside" — no talking to an empty doorstep)
    for (const npc of this.island.npcTargets) {
      if (!npc.meshRef.visible) continue;
      const d = npc.meshRef.getWorldPosition(new THREE.Vector3()).distanceTo(playerPos);
      if (d < nearestDist) {
        nearest = {
          type: 'npc' as const,
          npcData: { name: npc.name, dialogue: npc.dialogue },
          distance: d,
        };
        nearestDist = d;
      }
    }

    // Check benches (sit down)
    for (const bench of this.benchGroups) {
      const d = bench.getWorldPosition(new THREE.Vector3()).distanceTo(playerPos);
      if (d < nearestDist && d < 2.2) {
        nearest = { type: 'bench' as const, benchGroup: bench, distance: d };
        nearestDist = d;
      }
    }

    // Check cottage doors (enter). Anchor sits just outside the wall collider,
    // so the pushed-out player is right on top of it when facing the door.
    for (const dr of this.island.houseDoors) {
      const d = dr.position.distanceTo(playerPos);
      if (d < nearestDist && d < 2.4) {
        nearest = { type: 'house_door' as const, id: dr.id, distance: d };
        nearestDist = d;
      }
    }

    this.cachedNearby = nearest;
    return nearest;
  }

  /**
   * Set mailbox interaction callback (returns true if a delivery was collected)
   */
  public setOnMailboxInteract(callback: (mailbox: Mailbox) => boolean): void {
    this.onMailboxInteractCallback = callback;
  }

  /**
   * Interact with a mailbox (open/collect delivery)
   */
  public interactWithMailbox(mailbox: Mailbox): void {
    // Delegate to the delivery/quest system when wired (main-simple)
    if (this.onMailboxInteractCallback) {
      const collected = this.onMailboxInteractCallback(mailbox);
      if (!collected) {
        mailbox.setBubbleText('📭 No mail today');
        setTimeout(() => mailbox.setBubbleText(undefined), 2000);
      }
      return;
    }

    // Fallback behavior (no delivery system attached)
    if (mailbox.hasDelivery) {
      console.log('📬 Collected delivery from mailbox!');
      mailbox.setHasDelivery(false);
      mailbox.setBubbleText('✅ Mail collected!');

      // Reset text after 2 seconds
      setTimeout(() => {
        mailbox.setBubbleText(undefined);
      }, 2000);
    } else {
      console.log('📭 Mailbox is empty');
      mailbox.setBubbleText('📭 No mail today');

      // Reset text after 2 seconds
      setTimeout(() => {
        mailbox.setBubbleText(undefined);
      }, 2000);
    }
  }

  /**
   * Interact with generic interactable
   */
  /** Random unit direction within maxArc radians of an anchor direction. */
  private randomDirNear(anchor: THREE.Vector3, maxArc: number): THREE.Vector3 {
    const t1 = new THREE.Vector3(0, 1, 0).cross(anchor);
    if (t1.lengthSq() < 1e-6) t1.set(1, 0, 0);
    t1.normalize();
    const t2 = anchor.clone().cross(t1).normalize();
    const bearing = Math.random() * Math.PI * 2;
    const r = maxArc * (0.35 + 0.65 * Math.random());
    return anchor
      .clone()
      .multiplyScalar(Math.cos(r))
      .addScaledVector(t1, Math.sin(r) * Math.cos(bearing))
      .addScaledVector(t2, Math.sin(r) * Math.sin(bearing))
      .normalize();
  }

  /**
   * Minimap data: equirectangular lon/lat of the player (with heading),
   * NPCs (quest givers flagged), zone plazas, and the delivery target.
   */
  /**
   * Recompute the player-centred tangent basis for the radar: up = radial,
   * north = +Y pole projected onto the tangent plane, east = up × north.
   */
  private updateRadarBasis(): void {
    const pos = this.player.getWorldPosition();
    this.radarUp.copy(pos).normalize();
    // North: world +Y projected off the radial, then normalized. Degenerates
    // only at the exact poles, where we fall back to a fixed tangent.
    this.radarNorth.set(0, 1, 0).addScaledVector(this.radarUp, -this.radarUp.y);
    if (this.radarNorth.lengthSq() < 1e-6) this.radarNorth.set(0, 0, 1);
    this.radarNorth.normalize();
    // East = north × up (right-handed as seen from OUTSIDE the sphere —
    // same as geographic ECEF, where Ẑpole × X̂surface = Ŷ = 90°E).
    // The previous up × north gave WEST, mirroring the whole radar
    // left-right: forward travel still matched (the mirror flips heading
    // and displacement bearing together) but turns and strafes drew on the
    // wrong side.
    this.radarEast.crossVectors(this.radarNorth, this.radarUp).normalize();
  }

  /**
   * Project a world position onto the north-up radar. Returns normalized
   * coords where hypot(rx,ry) = 1 is the radar edge (RADAR_RANGE arc);
   * ry is +north (drawn up), rx is +east (drawn right). `dist` = the same
   * hypot so the caller can clamp/hide anything past the edge.
   * Call updateRadarBasis() first (getMinimapData does).
   */
  public worldToRadar(worldPos: THREE.Vector3): { rx: number; ry: number; dist: number } {
    const dir = worldPos.clone().normalize();
    const theta = Math.acos(THREE.MathUtils.clamp(dir.dot(this.radarUp), -1, 1));
    const bearing = Math.atan2(dir.dot(this.radarEast), dir.dot(this.radarNorth));
    const r = theta / GameScene.RADAR_RANGE;
    return { rx: r * Math.sin(bearing), ry: r * Math.cos(bearing), dist: r };
  }

  public getMinimapData(): {
    heading: number;
    npcs: Array<{ rx: number; ry: number; dist: number; hasQuest: boolean }>;
    zones: Array<{ rx: number; ry: number; dist: number; color: string; label: string }>;
    delivery: { rx: number; ry: number; dist: number } | null;
  } {
    this.updateRadarBasis();
    // Heading: the CAMERA's tangent-projected forward — the same vector
    // setPlayerMovement builds moveDir from. Movement is camera-relative
    // (W walks along camera-forward), so deriving the radar arrow from the
    // identical source guarantees "press W" moves you exactly toward the
    // arrow, and the FOV cone always matches what's up-screen. (Deriving it
    // from the player model's quaternion was wrong twice over: the model
    // faces +Z-along-travel — see setPlayerMovement's atan2(local.x,
    // local.z) — and it holds its LAST walk direction while you orbit the
    // camera, so the arrow disagreed with both view and next movement.)
    const fwd = this.orbitCamera
      ? this.orbitCamera.getForwardDirection()
      : new THREE.Vector3(0, 0, 1).applyQuaternion(this.player.quaternion);
    const heading = Math.atan2(fwd.dot(this.radarEast), fwd.dot(this.radarNorth));
    const questNames = new Set(this.questMarkers.map((m) => m.npcName));
    return {
      heading,
      npcs: this.island.npcTargets.map((n) => ({
        ...this.worldToRadar(n.meshRef.position),
        hasQuest: questNames.has(n.name),
      })),
      // Labels are short by necessity — the radar disc is only 172px, so
      // anything longer than ~8 characters collides with its neighbours.
      // Dots come from the shared DISTRICTS source of truth (Districts.ts).
      zones: DISTRICTS.map((d) => ({
        ...this.worldToRadar(this.island.dirAt(d.lon, d.lat)),
        color: '#' + d.color.toString(16).padStart(6, '0'),
        label: d.radar,
      })),
      delivery: this.guideTarget ? this.worldToRadar(this.guideTarget) : null,
    };
  }

  /** Sit the player on a bench: seat position + facing from the bench frame. */
  public sitOnBench(bench: THREE.Object3D): void {
    bench.updateWorldMatrix(true, false);
    const seatWorld = bench.localToWorld(new THREE.Vector3(0, 0.62, 0.06));
    const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(
      bench.getWorldQuaternion(new THREE.Quaternion()),
    );
    this.player.sitDown(seatWorld, fwd);
    sfx.blip();
    this.cachedNearby = null;
    this.lastPlayerPos.set(Infinity, Infinity, Infinity);
  }

  public standUpFromBench(): void {
    this.player.standUp();
    sfx.blip();
    this.cachedNearby = null;
    this.lastPlayerPos.set(Infinity, Infinity, Infinity);
  }

  public isPlayerSeated(): boolean {
    return this.player ? this.player.isSeated() : false;
  }

  public interactWith(
    interactable:
      | { type: 'mailbox'; mailbox: Mailbox; distance: number }
      | { type: 'lamp'; lamp: TownPlanResult['lamps'][number]; distance: number }
      | { type: 'zone'; zone: any; distance: number }
      | { type: 'npc'; npcData: { name: string; dialogue: string[] }; distance: number }
      | { type: 'bench'; benchGroup: THREE.Object3D; distance: number }
      | { type: 'house_door'; id: string; distance: number },
  ): void {
    // Interaction may change interactable state (delivery collected, lamp toggled)
    // — invalidate the proximity cache so the prompt refreshes immediately.
    this.cachedNearby = null;
    this.lastPlayerPos.set(Infinity, Infinity, Infinity);

    if (interactable.type === 'mailbox') {
      this.interactWithMailbox(interactable.mailbox);
      return;
    }

    if (interactable.type === 'lamp') {
      const l = interactable.lamp;
      l.isOn = !l.isOn;
      l.light.intensity = l.isOn ? 1.6 : 0.0;
      console.log(l.isOn ? '💡 Lamp turned ON' : '💡 Lamp turned OFF');
      return;
    }

    if (interactable.type === 'zone') {
      this.interactWithZone(interactable.zone);
      return;
    }

    if (interactable.type === 'bench') {
      this.sitOnBench(interactable.benchGroup);
      return;
    }

    if (interactable.type === 'house_door') {
      this.onHouseEnterCb?.(interactable.id);
      return;
    }

    if (interactable.type === 'npc') {
      // Little greeting hop from the NPC being addressed
      const target = this.island.npcTargets.find((n) => n.name === interactable.npcData.name);
      if (target) {
        (target.meshRef.userData as { greetT0?: number }).greetT0 = performance.now() / 1000;
      }
      if (this.onNPCInteractCallback) {
        this.onNPCInteractCallback(interactable.npcData);
      }
      return;
    }
  }

  private onNPCInteractCallback: ((npcData: { name: string; dialogue: string[] }) => void) | null =
    null;

  public setOnNPCInteract(callback: (npcData: { name: string; dialogue: string[] }) => void): void {
    this.onNPCInteractCallback = callback;
  }

  /** Player waved (Q): nearby townsfolk hop a friendly greeting back. */
  public greetNearbyNPCs(): void {
    if (!this.island) return;
    const p = this.player.getWorldPosition();
    const now = performance.now() / 1000;
    for (const npc of this.island.npcTargets) {
      if (npc.meshRef.position.distanceTo(p) < 6) {
        (npc.meshRef.userData as { greetT0?: number }).greetT0 = now;
      }
    }
  }

  /**
   * Set zone interaction callback
   */
  public setOnZoneInteract(callback: (zone: any) => void): void {
    this.onZoneInteractCallback = callback;
  }

  /**
   * Interact with a zone (show portfolio content)
   */
  public interactWithZone(zone: any): void {
    console.log('🎯 Interacting with zone:', zone.name);
    if (this.onZoneInteractCallback) {
      this.onZoneInteractCallback(zone);
    }
  }

  // ── Enterable interiors ────────────────────────────────────────────────
  // A single reusable room built once, hidden 300u below the island so the
  // CAMERA can teleport into it while the (unmoved) player and the whole
  // spherical-physics world stay put. Enclosed box → you only ever see the
  // room; the far island is occluded by the walls anyway. No player-physics or
  // collider changes (the exact blockers the design flagged), no 2nd scene.
  private insideInterior = false;
  private interiorGroup: THREE.Group | null = null;
  private interiorWallMat: THREE.MeshStandardMaterial | null = null;
  private interiorRugMat: THREE.MeshStandardMaterial | null = null;
  private interiorPosters: Array<{ ctx: CanvasRenderingContext2D; tex: THREE.CanvasTexture }> = [];
  private interiorSets: Record<string, THREE.Group> = {};
  private interiorFire: THREE.PointLight | null = null;
  private interiorTime = 0;
  private onHouseEnterCb: ((id: string) => void) | null = null;
  private static readonly INTERIOR_ORIGIN = new THREE.Vector3(0, -300, 0);

  // ── The view out of the window ──
  // The room is parked 300u under the island, so there is nothing outside it
  // to see. Rather than fake a backdrop, a second camera is placed where the
  // building REALLY stands and renders the island into a texture that becomes
  // the window pane. Refreshed on a timer, not per frame: at 4Hz and quarter
  // resolution this costs a fraction of a frame, and the outside world does
  // not change fast enough for anyone to notice the difference.
  private interiorWindowMat: THREE.MeshBasicMaterial | null = null;
  private interiorViewTarget: THREE.WebGLRenderTarget | null = null;
  private interiorViewCam: THREE.PerspectiveCamera | null = null;
  private interiorViewFrom = new THREE.Vector3();
  private interiorViewLook = new THREE.Vector3();
  private interiorViewAccum = 0;
  private interiorRainNode: THREE.Object3D | null = null;
  private shadowAutoUpdateWas: boolean | null = null;
  /** Hand the shadow map back. Must run on EVERY exit path, or the world
   *  outside silently keeps whatever shadows it had when you stepped in. */
  private restoreShadowAutoUpdate(): void {
    if (this.shadowAutoUpdateWas === null) return;
    const r = this.rendererRef?.getRenderer();
    if (r) {
      r.shadowMap.autoUpdate = this.shadowAutoUpdateWas;
      r.shadowMap.needsUpdate = true; // one refresh, or the first outdoor frame keeps the stale map
    }
    this.shadowAutoUpdateWas = null;
  }
  private interiorVelF = 0;
  private interiorVelS = 0;
  private interiorStride = 0;
  private interiorStepPhase = 0;
  private interiorStepAt = 0;
  private interiorStepAlt = false;
  private _interiorTiltQ = new THREE.Quaternion();
  // Working fixtures. State lives here so the prompt, the visuals and the
  // window all agree; it deliberately persists across buildings, because a
  // visitor who prefers the light off should not have to say so eleven times.
  private interiorCurtains: Array<{ mesh: THREE.Mesh; open: number; shut: number }> = [];
  private interiorCurtainT = 0; // 0 = open, 1 = drawn
  private interiorCurtainsShut = false;
  private interiorLamp: THREE.PointLight | null = null;
  private interiorBulb: THREE.Mesh | null = null;
  private interiorLampOn = true;

  /** Work a room fixture. Returns the line to flash. */
  public toggleInteriorFixture(which: string): string {
    if (which === 'curtains') {
      this.interiorCurtainsShut = !this.interiorCurtainsShut;
      return this.interiorCurtainsShut
        ? 'You draw the curtains. 🪟'
        : 'You draw the curtains back. ☀️';
    }
    this.interiorLampOn = !this.interiorLampOn;
    return this.interiorLampOn ? 'The lamp comes on. 💡' : 'You switch the lamp off. 🌙';
  }
  // 2.0s heartbeat, plus an immediate refresh whenever the clock crosses a
  // five-minute bucket or the weather turns. Measured 3.1ms per pass at
  // 384x288 and 2.9ms at 512x384 — near-identical, because the cost is
  // CPU-side draw-call submission (102 calls) and not fill rate, so
  // resolution was never the lever; frequency is. 2.5Hz cost ~8ms/sec to
  // re-render a mostly unchanged view; 0.5Hz costs ~1.6ms/sec and still lets
  // the world outside move.
  private static readonly INTERIOR_VIEW_INTERVAL = 2.0;
  private interiorViewBucket = -1;
  private interiorViewWeather = '';
  private interiorBlobMat: THREE.MeshBasicMaterial | null = null;
  /** Structural type, not the SimpleRenderer class: GameScene is imported BY
   *  the renderer's owner, and a real import here would close the cycle. */
  private rendererRef: { getRenderer(): THREE.WebGLRenderer } | null = null;
  public setRendererRef(r: { getRenderer(): THREE.WebGLRenderer }): void {
    this.rendererRef = r;
  }

  public setOnHouseEnter(cb: (id: string) => void): void {
    this.onHouseEnterCb = cb;
  }
  public isInsideInterior(): boolean {
    return this.insideInterior;
  }

  private buildInterior(): void {
    if (this.interiorGroup) return;
    const g = new THREE.Group();
    g.position.copy(GameScene.INTERIOR_ORIGIN);
    g.visible = false;
    const wallMat = new THREE.MeshStandardMaterial({ color: 0xe8e2d6, roughness: 0.92 });
    this.interiorWallMat = wallMat;
    // Shared material cache: themed sets reuse one material per colour so the
    // whole six-room wardrobe costs a handful of materials, not one per prop.
    const mats = new Map<number, THREE.MeshStandardMaterial>();
    const matFor = (color: number, rough = 0.85): THREE.MeshStandardMaterial => {
      let m = mats.get(color);
      if (!m) {
        m = new THREE.MeshStandardMaterial({ color, roughness: rough });
        mats.set(color, m);
      }
      return m;
    };
    const box = (
      parent: THREE.Object3D,
      w: number,
      h: number,
      d: number,
      color: number,
      x: number,
      y: number,
      z: number,
      ry = 0,
      rx = 0,
    ): THREE.Mesh => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), matFor(color));
      m.position.set(x, y, z);
      m.rotation.set(rx, ry, 0);
      parent.add(m);
      return m;
    };
    const cyl = (
      parent: THREE.Object3D,
      rTop: number,
      rBot: number,
      h: number,
      color: number,
      x: number,
      y: number,
      z: number,
      rx = 0,
    ): THREE.Mesh => {
      const m = new THREE.Mesh(new THREE.CylinderGeometry(rTop, rBot, h, 12), matFor(color));
      m.position.set(x, y, z);
      m.rotation.x = rx;
      parent.add(m);
      return m;
    };

    // ── Shell: plank floor, walls, ceiling with beams, skirting ──
    // Wood-plank floor via a tiny CanvasTexture — reads as boards, not plastic.
    const fcv = document.createElement('canvas');
    fcv.width = 256;
    fcv.height = 256;
    const fx = fcv.getContext('2d');
    if (fx) {
      for (let r = 0; r < 8; r++) {
        fx.fillStyle = r % 2 ? '#826140' : '#8f7050';
        fx.fillRect(0, r * 32, 256, 32);
        fx.fillStyle = 'rgba(56,40,24,0.55)';
        fx.fillRect(0, r * 32, 256, 2); // plank seam
        fx.fillRect((r * 96) % 256, r * 32, 2, 32); // staggered butt joint
      }
    }
    const ftex = new THREE.CanvasTexture(fcv);
    ftex.colorSpace = THREE.SRGBColorSpace;
    ftex.wrapS = ftex.wrapT = THREE.RepeatWrapping;
    ftex.repeat.set(2, 2);
    const floor = new THREE.Mesh(
      new THREE.BoxGeometry(8, 0.2, 8),
      new THREE.MeshStandardMaterial({ map: ftex, roughness: 0.9 }),
    );
    g.add(floor);
    box(g, 8, 0.2, 8, 0xe8e2d6, 0, 4, 0).material = wallMat; // ceiling (wall tint)
    const rug = new THREE.Mesh(
      new THREE.BoxGeometry(4.6, 0.06, 3.4),
      new THREE.MeshStandardMaterial({ color: 0xb06a72, roughness: 0.9 }),
    );
    rug.position.set(0, 0.13, 0.3);
    g.add(rug);
    this.interiorRugMat = rug.material as THREE.MeshStandardMaterial;
    for (const [x, z, ry] of [
      [0, -4, 0],
      [0, 4, 0],
      [-4, 0, Math.PI / 2],
      [4, 0, Math.PI / 2],
    ] as const) {
      const wall = new THREE.Mesh(new THREE.BoxGeometry(8, 4, 0.2), wallMat);
      wall.position.set(x, 2, z);
      wall.rotation.y = ry;
      g.add(wall);
    }
    // Ceiling beams + skirting boards — the cheap trims that make a box a room.
    for (const bz of [-2.4, 0, 2.4]) box(g, 7.6, 0.18, 0.3, 0x6e5236, 0, 3.78, bz);
    box(g, 7.6, 0.25, 0.08, 0x74573a, 0, 0.23, -3.84);
    box(g, 7.6, 0.25, 0.08, 0x74573a, 0, 0.23, 3.84);
    box(g, 0.08, 0.25, 7.6, 0x74573a, -3.84, 0.23, 0);
    box(g, 0.08, 0.25, 7.6, 0x74573a, 3.84, 0.23, 0);

    // ── Wall dressing ──
    // Four 8x4 flats in a single flat tint read as the inside of a cardboard
    // box, however nice the furniture is. Real rooms break the HEIGHT: a
    // panelled wainscot below the hand, a dado rail capping it, a picture rail
    // near the ceiling. That is three horizontals and a rhythm of verticals,
    // and it costs a few boxes. In the SHELL, so all six themes inherit it.
    const wcv = document.createElement('canvas');
    wcv.width = 128;
    wcv.height = 128;
    const wx2 = wcv.getContext('2d');
    if (wx2) {
      // Near-white speckle: the material's colour is re-tinted per building
      // and a map MULTIPLIES, so anything darker here would mute every room.
      wx2.fillStyle = '#ffffff';
      wx2.fillRect(0, 0, 128, 128);
      for (let i = 0; i < 2400; i++) {
        wx2.fillStyle = `rgba(122,112,98,${0.03 + Math.random() * 0.05})`;
        wx2.fillRect(Math.random() * 128, Math.random() * 128, 1.5, 1.5);
      }
    }
    const wtex = new THREE.CanvasTexture(wcv);
    wtex.colorSpace = THREE.SRGBColorSpace;
    wtex.wrapS = wtex.wrapT = THREE.RepeatWrapping;
    wtex.repeat.set(3, 1.6);
    wallMat.map = wtex;
    wallMat.needsUpdate = true;

    const panelMat = matFor(0xdcd5c7, 0.94);
    const railMat = matFor(0x8a7355, 0.8);
    // Built once facing +z and rotated onto each wall. Room-ward is DECREASING
    // z here: the wall's inner face is 3.9, so the field sits at 3.875 and the
    // stiles stand proud of it at 3.855.
    const dressWall = (rotY: number, gap?: [number, number]): void => {
      const w = new THREE.Group();
      w.rotation.y = rotY;
      g.add(w);
      const spans: Array<[number, number]> = gap
        ? [
            [-3.88, gap[0]],
            [gap[1], 3.88],
          ]
        : [[-3.88, 3.88]];
      for (const [a, b] of spans) {
        const width = b - a;
        if (width < 0.25) continue;
        const cx = (a + b) / 2;
        const field = new THREE.Mesh(new THREE.BoxGeometry(width, 0.74, 0.03), panelMat);
        field.position.set(cx, 0.66, 3.875);
        w.add(field);
        const dado = new THREE.Mesh(new THREE.BoxGeometry(width, 0.1, 0.09), railMat);
        dado.position.set(cx, 1.08, 3.845);
        w.add(dado);
        const picture = new THREE.Mesh(new THREE.BoxGeometry(width, 0.07, 0.06), railMat);
        picture.position.set(cx, 3.12, 3.86);
        w.add(picture);
        // Stiles roughly every metre, and always one at each end of the span
        // so a run never stops in mid-air beside the doorway.
        const n = Math.max(1, Math.round(width / 0.98));
        for (let i = 0; i <= n; i++) {
          const stile = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.74, 0.05), railMat);
          stile.position.set(a + (width * i) / n, 0.66, 3.855);
          w.add(stile);
        }
      }
    };
    dressWall(0, [-2.45, -1.15]); // front wall — leave the doorway clear
    dressWall(Math.PI);
    dressWall(Math.PI / 2);
    dressWall(-Math.PI / 2);
    // Front wall dressing (the wall with no poster): a glowing window + a door,
    // so the orbit's "empty" quadrant reads lived-in instead of blank.
    box(g, 1.9, 1.5, 0.1, 0x6e5236, 1.8, 2.3, 3.86);
    // The pane used to be a flat 0xcfe4ff rectangle: identical at 2am in a
    // storm and 1pm in sunshine, and showing nothing at all. It now carries a
    // live render of the island taken from where this building actually
    // stands, so the view out of it IS the real world outside — real terrain,
    // real sea, real sky, real weather, real villagers walking past.
    const paneMat = new THREE.MeshBasicMaterial({ color: 0xcfe4ff });
    this.interiorWindowMat = paneMat;
    const pane = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 1.2), paneMat);
    pane.position.set(1.8, 2.3, 3.79);
    pane.rotation.y = Math.PI;
    g.add(pane);
    box(g, 0.06, 1.2, 0.06, 0x6e5236, 1.8, 2.3, 3.78); // mullion
    box(g, 1.6, 0.06, 0.06, 0x6e5236, 1.8, 2.3, 3.78);
    box(g, 1.1, 2.3, 0.1, 0x5c4127, -1.8, 1.15, 3.86); // door
    const knob = new THREE.Mesh(new THREE.SphereGeometry(0.06, 8, 8), matFor(0xc9a227, 0.4));
    knob.position.set(-1.42, 1.15, 3.78);
    g.add(knob);

    // ── Fixtures you can actually work ──
    // Both live in the SHELL rather than a theme, so all six rooms and all
    // eleven enterable buildings get them from one implementation. Both also
    // exist to make the window matter: draw the curtains and the view is gone;
    // kill the light and the window becomes the only thing lighting the room.
    const curtainMat = matFor(0xb2564e, 0.95);
    for (const side of [-1, 1]) {
      // 0.82 wide, not 0.42: the pane is 1.6 across, so a pair of narrow
      // panels met in the middle and still left daylight down both edges —
      // "drawn" has to actually mean drawn. Each panel now covers exactly half.
      const c = new THREE.Mesh(new THREE.BoxGeometry(0.82, 1.36, 0.07), curtainMat);
      // Open, a curtain must clear the GLASS entirely or it reads as a blind
      // stuck half-drawn. The pane spans x 1.0-2.6 and each panel is 0.82
      // wide, so its centre sits at 1.8 +/- 1.21 to tuck its inner edge to the
      // glass edge. Shut at +/- 0.41 the pair meet exactly in the middle and
      // between them cover the full 1.6.
      const open = 1.8 + side * 1.21;
      c.position.set(open, 2.3, 3.74);
      c.castShadow = false;
      g.add(c);
      this.interiorCurtains.push({ mesh: c, open, shut: 1.8 + side * 0.41 });
    }
    box(g, 2.75, 0.1, 0.12, 0x4a3a28, 1.8, 3.02, 3.74); // curtain rail, wider than the pull
    // Pendant lamp over the middle of the room.
    box(g, 0.04, 0.55, 0.04, 0x3a3a3a, 0, 3.7, 0);
    const pendantShade = new THREE.Mesh(
      new THREE.ConeGeometry(0.34, 0.3, 10, 1, true),
      matFor(0x5c4127),
    );
    pendantShade.position.set(0, 3.4, 0);
    pendantShade.rotation.x = Math.PI;
    (pendantShade.material as THREE.MeshStandardMaterial).side = THREE.DoubleSide;
    g.add(pendantShade);
    const bulb = new THREE.Mesh(
      new THREE.SphereGeometry(0.1, 10, 8),
      new THREE.MeshBasicMaterial({ color: 0xffe8b8 }),
    );
    bulb.position.set(0, 3.32, 0);
    g.add(bulb);
    this.interiorBulb = bulb;
    const pendantLight = new THREE.PointLight(0xffd9a0, 1.35, 11, 2);
    pendantLight.position.set(0, 3.25, 0);
    g.add(pendantLight);
    this.interiorLamp = pendantLight;
    // Light switch by the door, at hand height.
    box(g, 0.14, 0.2, 0.05, 0xf0ece2, -2.75, 1.35, 3.82);

    // ── Themed furniture sets (built once, toggled per building) ──
    const set = (name: string): THREE.Group => {
      const s = new THREE.Group();
      s.visible = false;
      g.add(s);
      this.interiorSets[name] = s;
      return s;
    };
    const W = 0x6e5236; // trim wood
    const D = 0x5c4127; // dark wood

    // office — the Professional HQ: desk, monitor, chair, cabinet, plant, clock.
    const office = set('office');
    box(office, 2.4, 0.12, 1.0, D, 0, 0.95, -2.6);
    for (const [lx, lz] of [
      [-1.05, -2.25],
      [1.05, -2.25],
      [-1.05, -2.95],
      [1.05, -2.95],
    ] as const)
      box(office, 0.12, 0.9, 0.12, D, lx, 0.45, lz);
    box(office, 0.95, 0.6, 0.06, 0x22262e, 0, 1.66, -2.75); // monitor
    box(office, 0.12, 0.3, 0.12, 0x33383f, 0, 1.16, -2.75);
    box(office, 0.6, 0.09, 0.35, 0xd7dbe0, 0.65, 1.06, -2.45); // keyboard? papers
    box(office, 0.55, 0.1, 0.55, 0x3a3f47, 0, 0.62, -1.65); // chair seat
    box(office, 0.55, 0.72, 0.09, 0x3a3f47, 0, 1.05, -1.94);
    cyl(office, 0.06, 0.06, 0.5, 0x22262e, 0, 0.3, -1.65);
    box(office, 0.65, 1.5, 0.6, 0x7d838c, 3.2, 0.85, -2.9); // filing cabinet
    box(office, 0.5, 0.05, 0.05, 0xb9bec5, 3.2, 1.12, -2.58);
    box(office, 0.5, 0.05, 0.05, 0xb9bec5, 3.2, 0.62, -2.58);
    cyl(office, 0.22, 0.28, 0.42, 0xb0603e, -3.1, 0.31, -2.9); // plant
    const leaves = new THREE.Mesh(new THREE.SphereGeometry(0.45, 10, 8), matFor(0x4c7a43));
    leaves.position.set(-3.1, 0.95, -2.9);
    office.add(leaves);
    cyl(office, 0.3, 0.3, 0.06, 0xf2efe8, 2.7, 3.1, -3.86, Math.PI / 2); // clock
    cyl(office, 0.05, 0.05, 0.02, 0x2c2c2c, 2.7, 3.1, -3.81, Math.PI / 2);

    // workshop — Projects: workbench, pegboard + tools, blueprint table, crates.
    const shop = set('workshop');
    box(shop, 2.6, 0.14, 1.0, W, 0, 0.95, -2.6); // bench top
    for (const lx of [-1.15, 1.15] as const) {
      box(shop, 0.14, 0.9, 0.14, D, lx, 0.45, -2.25);
      box(shop, 0.14, 0.9, 0.14, D, lx, 0.45, -2.95);
    }
    box(shop, 0.5, 0.22, 0.3, 0x7d838c, -0.6, 1.13, -2.6); // vice-ish block
    box(shop, 1.8, 1.1, 0.06, 0xcdb289, -2.85, 2.1, -3.86); // pegboard
    box(shop, 0.09, 0.5, 0.05, 0x8a2f2b, -3.35, 2.1, -3.8); // tools on it
    box(shop, 0.4, 0.09, 0.05, 0x55595e, -2.85, 2.3, -3.8);
    box(shop, 0.09, 0.4, 0.05, 0x2e6b8a, -2.35, 2.0, -3.8);
    box(shop, 1.4, 0.08, 1.0, D, 2.6, 0.98, -1.7, 0, -0.35); // drafting table
    const bp = new THREE.Mesh(new THREE.PlaneGeometry(1.15, 0.8), matFor(0x2f5aa0, 0.95));
    bp.position.set(2.6, 1.05, -1.68);
    bp.rotation.x = -Math.PI / 2 - 0.35;
    shop.add(bp);
    for (const [lx, lz] of [
      [2.0, -1.35],
      [3.2, -1.35],
      [2.0, -2.05],
      [3.2, -2.05],
    ] as const)
      box(shop, 0.1, 0.95, 0.1, D, lx, 0.48, lz);
    cyl(shop, 0.25, 0.28, 0.55, W, 1.1, 0.38, -1.4); // stool
    box(shop, 0.85, 0.75, 0.85, 0xb5854e, -3.0, 0.48, -2.55); // crates
    box(shop, 0.7, 0.6, 0.7, 0xc09055, -2.85, 1.16, -2.7);

    // home — Personal: sofa, coffee table, fireplace, bookshelf, floor lamp.
    const home = set('home');
    box(home, 2.2, 0.5, 0.9, 0x9c5a63, 1.6, 0.42, 2.55); // sofa base
    box(home, 2.2, 0.62, 0.28, 0x9c5a63, 1.6, 0.95, 2.94);
    box(home, 0.28, 0.62, 0.9, 0x8c4f58, 0.56, 0.75, 2.55);
    box(home, 0.28, 0.62, 0.9, 0x8c4f58, 2.64, 0.75, 2.55);
    box(home, 1.0, 0.09, 0.6, W, 0.9, 0.5, 1.2); // coffee table
    for (const [lx, lz] of [
      [0.5, 0.98],
      [1.3, 0.98],
      [0.5, 1.42],
      [1.3, 1.42],
    ] as const)
      box(home, 0.08, 0.42, 0.08, D, lx, 0.24, lz);
    this.buildFireplace(home, -1); // left wall
    box(home, 0.38, 2.2, 1.6, D, 3.6, 1.28, -2.2); // bookshelf
    for (const [by, bc] of [
      [0.7, 0xa54242],
      [1.35, 0x3f6f8a],
      [1.95, 0xc9a227],
    ] as const)
      box(home, 0.3, 0.34, 1.35, bc, 3.58, by, -2.2);
    cyl(home, 0.045, 0.045, 1.7, 0x2c2c2c, -1.7, 0.95, 2.8); // floor lamp
    const shade = new THREE.Mesh(
      new THREE.ConeGeometry(0.3, 0.35, 12, 1, true),
      matFor(0xf0d9a8, 0.7),
    );
    shade.position.set(-1.7, 1.95, 2.8);
    home.add(shade);

    // post — Contact: service counter, pigeonhole wall, parcels, brass scale.
    const post = set('post');
    box(post, 2.8, 1.0, 0.7, W, 0, 0.6, -1.9); // counter
    box(post, 3.1, 0.1, 0.95, D, 0, 1.13, -1.9);
    box(post, 0.28, 1.75, 2.4, D, 3.8, 1.6, -2.2); // pigeonholes backing
    for (const sy of [1.05, 1.6, 2.15] as const)
      box(post, 0.3, 0.06, 2.4, 0xcdb289, 3.78, sy, -2.2);
    for (const sz of [-3.2, -2.55, -1.85, -1.2] as const)
      box(post, 0.3, 1.6, 0.06, 0xcdb289, 3.78, 1.6, sz);
    box(post, 0.7, 0.55, 0.6, 0xb5854e, -2.9, 0.38, -2.7); // parcels
    box(post, 0.55, 0.45, 0.5, 0xc09055, -2.75, 0.88, -2.85);
    box(post, 0.45, 0.4, 0.45, 0xb5854e, -2.2, 0.3, -3.0);
    cyl(post, 0.16, 0.2, 0.08, 0xc9a227, 0.8, 1.22, -1.9); // scale base
    cyl(post, 0.03, 0.03, 0.4, 0xc9a227, 0.8, 1.45, -1.9);
    cyl(post, 0.18, 0.18, 0.03, 0xc9a227, 0.8, 1.68, -1.9);

    // hall — Welcome town hall: podium, banners, visitor benches, notice board.
    const hall = set('hall');
    box(hall, 1.2, 0.5, 1.2, D, 0, 0.35, -2.5); // dais
    box(hall, 0.5, 1.05, 0.5, W, 0, 1.12, -2.5); // lectern
    box(hall, 0.7, 0.08, 0.55, D, 0, 1.68, -2.42, 0, -0.3);
    for (const bx of [-2.5, 2.5] as const) {
      const banner = new THREE.Mesh(new THREE.PlaneGeometry(0.72, 2.1), matFor(0x4caf50, 0.9));
      banner.position.set(bx, 2.55, -3.78);
      hall.add(banner);
      box(hall, 0.9, 0.07, 0.07, W, bx, 3.66, -3.76);
    }
    for (const bz of [0.7, 1.9] as const) {
      box(hall, 2.1, 0.12, 0.5, W, 0, 0.5, bz);
      box(hall, 0.12, 0.5, 0.45, D, -0.9, 0.25, bz);
      box(hall, 0.12, 0.5, 0.45, D, 0.9, 0.25, bz);
    }
    box(hall, 1.5, 1.05, 0.07, 0xcdb289, 3.8, 2.05, -2.2, Math.PI / 2); // notice board
    for (const [py, pz] of [
      [2.3, -2.6],
      [2.05, -1.95],
      [1.75, -2.35],
    ] as const)
      box(hall, 0.03, 0.34, 0.26, 0xf5f2ea, 3.74, py, pz);

    // cottage — the houses: bed, round table + stools, hearth, kitchen shelf.
    const cot = set('cottage');
    box(cot, 1.1, 0.38, 2.0, D, -3.0, 0.3, -2.5); // bed frame
    box(cot, 1.0, 0.16, 1.9, 0xefe9dc, -3.0, 0.57, -2.5);
    box(cot, 0.8, 0.14, 0.42, 0xf7f3ea, -3.0, 0.68, -3.25);
    // Blanket gets a DEDICATED material: its colour varies per house, and the
    // shared matFor cache would tint every 0xa54242 prop island-wide with it.
    this.cottageBlanketMat = new THREE.MeshStandardMaterial({ color: 0xa54242, roughness: 0.9 });
    const blanket = new THREE.Mesh(new THREE.BoxGeometry(1.02, 0.15, 1.05), this.cottageBlanketMat);
    blanket.position.set(-3.0, 0.63, -2.05);
    cot.add(blanket);
    cyl(cot, 0.7, 0.7, 0.09, W, 1.6, 0.86, -1.6); // round table
    cyl(cot, 0.09, 0.12, 0.82, D, 1.6, 0.41, -1.6);
    cyl(cot, 0.24, 0.26, 0.5, D, 0.75, 0.29, -1.3); // stools
    cyl(cot, 0.24, 0.26, 0.5, D, 2.45, 0.29, -1.9);
    this.buildFireplace(cot, 1); // right wall
    box(cot, 1.6, 0.08, 0.4, W, -2.4, 1.7, -3.78); // kitchen shelf
    cyl(cot, 0.12, 0.12, 0.28, 0x8a9a5b, -2.9, 1.88, -3.78);
    cyl(cot, 0.1, 0.1, 0.24, 0xb0603e, -2.45, 1.86, -3.78);
    cyl(cot, 0.11, 0.11, 0.3, 0x7d6b8f, -2.0, 1.89, -3.78);
    // Floating 💤 over the bed — shown only while a sleeping NPC occupies it.
    {
      const zcv = document.createElement('canvas');
      zcv.width = zcv.height = 128;
      const zx = zcv.getContext('2d');
      if (zx) {
        zx.font = '96px system-ui, sans-serif';
        zx.textAlign = 'center';
        zx.textBaseline = 'middle';
        zx.fillText('💤', 64, 70);
      }
      const ztex = new THREE.CanvasTexture(zcv);
      ztex.colorSpace = THREE.SRGBColorSpace;
      const zzz = new THREE.Sprite(
        new THREE.SpriteMaterial({ map: ztex, transparent: true, depthWrite: false }),
      );
      zzz.scale.set(0.55, 0.55, 1);
      zzz.position.set(-3.0, 1.55, -2.5);
      zzz.visible = false;
      cot.add(zzz);
      this.interiorZzz = zzz;
    }
    // Optional decor groups — each house shows a seeded 2-of-4 subset so the
    // six cottages stop being clones. Placed in corners / on furniture so the
    // (cached, superset) collider layout stays honest for every combination.
    this.cottageExtras = [];
    const extra = (): THREE.Group => {
      const e = new THREE.Group();
      e.visible = false;
      cot.add(e);
      this.cottageExtras.push(e);
      return e;
    };
    const vase = extra(); // flowers on the round table
    cyl(vase, 0.09, 0.11, 0.22, 0x7d6b8f, 1.6, 1.0, -1.6);
    for (const [fx, fz, fc] of [
      [1.52, -1.66, 0xd9536f],
      [1.68, -1.58, 0xe0b13e],
      [1.6, -1.5, 0xf0f0e8],
    ] as const) {
      const fl = new THREE.Mesh(new THREE.SphereGeometry(0.055, 8, 6), matFor(fc));
      fl.position.set(fx, 1.22, fz);
      vase.add(fl);
    }
    const books = extra(); // little wall shelf of books (front-right wall)
    box(books, 0.06, 0.08, 1.1, W, 3.8, 1.85, 1.2);
    box(books, 0.05, 0.3, 0.24, 0xa54242, 3.79, 2.04, 0.85);
    box(books, 0.05, 0.34, 0.22, 0x3f6f8a, 3.79, 2.06, 1.15);
    box(books, 0.05, 0.28, 0.2, 0x8a9a5b, 3.79, 2.03, 1.45);
    const basket = extra(); // pet basket by the hearth
    cyl(basket, 0.38, 0.42, 0.16, 0xb5854e, 2.2, 0.18, -3.0);
    cyl(basket, 0.3, 0.3, 0.08, 0xd9c8b0, 2.2, 0.26, -3.0);
    const chest = extra(); // storage chest at the foot of the bed
    box(chest, 0.85, 0.45, 0.5, D, -3.05, 0.33, -1.15);
    box(chest, 0.89, 0.1, 0.54, W, -3.05, 0.6, -1.15);
    const clasp = new THREE.Mesh(new THREE.SphereGeometry(0.045, 8, 6), matFor(0xc9a227, 0.4));
    clasp.position.set(-3.05, 0.48, -0.88);
    chest.add(clasp);

    // Fireplace glow — one shared light, repositioned per themed set and only
    // switched on for sets that have a hearth. Flicker runs in the interior
    // camera update (zero cost while outside).
    const fire = new THREE.PointLight(0xff9a3c, 0, 7, 1.4);
    g.add(fire);
    this.interiorFire = fire;
    // Three framed posters — a big title on the back wall + a content panel on
    // each side wall — all re-drawn per building on enter (so you SEE the
    // portfolio content inside the building, not just a title).
    this.interiorPosters = [];
    const makePoster = (w: number, h: number, x: number, y: number, z: number, ry: number) => {
      const cv = document.createElement('canvas');
      cv.width = 512;
      cv.height = Math.round((512 * h) / w);
      const ctx = cv.getContext('2d');
      const tex = new THREE.CanvasTexture(cv);
      tex.colorSpace = THREE.SRGBColorSpace;
      const m = new THREE.Mesh(
        new THREE.PlaneGeometry(w, h),
        new THREE.MeshStandardMaterial({ map: tex, transparent: true }),
      );
      m.position.set(x, y, z);
      m.rotation.y = ry;
      g.add(m);
      if (ctx) this.interiorPosters.push({ ctx, tex });
    };
    makePoster(3.6, 1.9, 0, 2.5, -3.88, 0); // back — title
    makePoster(2.6, 1.7, -3.88, 1.95, 0.4, Math.PI / 2); // left — content
    makePoster(2.6, 1.7, 3.88, 1.95, 0.4, -Math.PI / 2); // right — content
    // Bright, linear-falloff room light so all four walls read clearly (the
    // island's scene ambient is deliberately low, and the sun may face away
    // from a room 300u under the map). A second low fill kills dark corners.
    const lamp = new THREE.PointLight(0xfff4e0, 3.2, 24, 1);
    lamp.position.set(0, 3.4, 0);
    g.add(lamp);
    const fill = new THREE.PointLight(0xd8e2ff, 1.2, 20, 1);
    fill.position.set(2.5, 1.6, 2.5);
    g.add(fill);
    this.interiorGroup = g;
    this.add(g);
  }

  /** A brick hearth with a glowing firebox, against the left (side=-1) or
   *  right (side=+1) wall at z≈-2 — clear of that wall's content poster. */
  private buildFireplace(parent: THREE.Group, side: -1 | 1): void {
    const brick = new THREE.MeshStandardMaterial({ color: 0x9a5a48, roughness: 0.95 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x1c1512, roughness: 1 });
    const wood = new THREE.MeshStandardMaterial({ color: 0x6e5236, roughness: 0.85 });
    const glow = new THREE.MeshBasicMaterial({ color: 0xff8c3a });
    const addBox = (
      geo: THREE.BoxGeometry,
      mat: THREE.Material,
      x: number,
      y: number,
      z: number,
    ) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      parent.add(m);
      return m;
    };
    addBox(new THREE.BoxGeometry(0.5, 2.6, 1.4), brick, side * 3.62, 1.3, -2.0); // chimney breast
    addBox(new THREE.BoxGeometry(0.25, 0.85, 0.85), dark, side * 3.4, 0.55, -2.0); // firebox
    addBox(new THREE.BoxGeometry(0.62, 0.1, 1.6), wood, side * 3.55, 1.72, -2.0); // mantel
    const fire = new THREE.Mesh(new THREE.PlaneGeometry(0.62, 0.5), glow);
    fire.position.set(side * 3.32, 0.5, -2.0);
    fire.rotation.y = side === -1 ? Math.PI / 2 : -Math.PI / 2;
    parent.add(fire);
    addBox(new THREE.BoxGeometry(0.16, 0.14, 0.7), dark, side * 3.34, 0.22, -2.0); // log
  }

  /** Rug tint + hearth-light anchor per themed set (hearth rooms only). */
  private static readonly INTERIOR_RUGS: Record<string, number> = {
    office: 0x51687d,
    workshop: 0xa8793e,
    home: 0xb06a72,
    post: 0x7d6b8f,
    hall: 0x5d8a58,
    cottage: 0x9c5f4e,
  };
  private static readonly INTERIOR_FIRE_POS: Record<string, [number, number, number]> = {
    home: [-3.05, 0.85, -2.0],
    cottage: [3.05, 0.85, -2.0],
  };

  // ── Interior free-walk mode ──
  // Inside a building the player walks the room on WASD/joystick: flat-floor
  // movement with wall + furniture collision, a third-person follow camera,
  // and per-theme interaction hotspots. All in room space — the spherical
  // world stays frozen and the player's physics state is never touched.
  private interiorMoveF = 0;
  private interiorMoveS = 0;
  private interiorYaw = Math.PI;
  private interiorCamYaw = Math.PI;
  private interiorActiveTheme = 'cottage';
  private interiorColliders: Record<
    string,
    Array<{ minX: number; maxX: number; minZ: number; maxZ: number }>
  > = {};
  private interiorHotspot: { label: string; action: string; text?: string } | null = null;
  private static readonly INTERIOR_WALK_BOUND = 3.35; // wall clamp (inner face 3.9 − radius/skirting)
  private static readonly INTERIOR_PLAYER_R = 0.32;
  // 0.80, not 0.68 — the feet were 0.12u UNDER the floorboards. Derived, not
  // guessed: SimplePlayer normalises the GLB with `model.position.y +=
  // -0.7 - box.min.y`, so the soles sit exactly 0.70 below the player origin,
  // while the floor Box(8, 0.2, 8) at y=0 has its top face at +0.10.
  // 0.68 - 0.70 = -0.02 against a floor at +0.10; 0.80 - 0.70 = 0.10, flush.
  // Nothing downstream needs compensating: the camera is PLAYER_Y + 1.25 and
  // looks at p.y + 0.85, so both rise together and the framing pitch is
  // unchanged, and hotspot radii are x/z only.
  private static readonly INTERIOR_PLAYER_Y = 0.8;

  /** Per-theme interaction hotspots (room-local x/z, trigger radius). The door
   *  "leave" spot is appended to every theme at lookup time. */
  private static readonly INTERIOR_HOTSPOTS: Record<
    string,
    Array<{
      id?: string;
      x: number;
      z: number;
      r: number;
      label: string;
      action: string;
      text?: string;
    }>
  > = {
    office: [
      {
        x: 0,
        z: -2.6,
        r: 1.4,
        label: '💻 Press <strong>E</strong> to browse the work',
        action: 'panel',
      },
      {
        x: -3.1,
        z: -2.9,
        r: 1.1,
        label: '🌱 Press <strong>E</strong> to water the plant',
        action: 'toast',
        text: 'You water the office plant. It looks 2% happier. 🌱',
      },
    ],
    workshop: [
      {
        x: 2.6,
        z: -1.7,
        r: 1.3,
        label: '📐 Press <strong>E</strong> to study the blueprints',
        action: 'panel',
      },
      {
        x: -3.0,
        z: -2.6,
        r: 1.2,
        label: '📦 Press <strong>E</strong> to peek in the crates',
        action: 'toast',
        text: 'Prototype parts, spare ideas, and one suspiciously good chocolate bar. 🍫',
      },
    ],
    home: [
      {
        x: -3.3,
        z: -2.0,
        r: 1.3,
        label: '🔥 Press <strong>E</strong> to warm your hands',
        action: 'toast',
        text: 'You warm your hands by the fire. Cosy. 🔥',
      },
      {
        x: 3.5,
        z: -2.2,
        r: 1.2,
        label: '📚 Press <strong>E</strong> to browse the bookshelf',
        action: 'toast',
        text: 'Cookbooks, sketchpads, and a well-worn map of Melbourne. 📚',
      },
      {
        x: 1.6,
        z: 2.5,
        r: 1.2,
        label: '🛋️ Press <strong>E</strong> to flop on the sofa',
        action: 'toast',
        text: 'Five stars. Would flop again. 🛋️',
      },
    ],
    post: [
      {
        x: 0,
        z: -1.9,
        r: 1.4,
        label: '📮 Press <strong>E</strong> to ring the counter bell',
        action: 'panel',
      },
      {
        x: -2.7,
        z: -2.8,
        r: 1.2,
        label: '📦 Press <strong>E</strong> to check the parcels',
        action: 'toast',
        text: 'One is addressed to "The Fastest Racer on the Island". 👀',
      },
    ],
    hall: [
      {
        x: 3.4,
        z: -2.2,
        r: 1.3,
        label: '📰 Press <strong>E</strong> to read the notice board',
        action: 'times',
      },
      {
        x: 0,
        z: -2.5,
        r: 1.2,
        label: '🎤 Press <strong>E</strong> to stand at the lectern',
        action: 'toast',
        text: 'You clear your throat. The benches listen politely. 🎤',
      },
    ],
    cottage: [
      {
        id: 'bed',
        x: -3.0,
        z: -2.5,
        r: 1.3,
        label: '💤 Press <strong>E</strong> to test the bed',
        action: 'toast',
        text: 'Tempting… but the island awaits. 💤',
      },
      {
        x: 3.3,
        z: -2.0,
        r: 1.3,
        label: '🔥 Press <strong>E</strong> to warm your hands',
        action: 'toast',
        text: 'The hearth crackles softly. 🔥',
      },
      {
        x: -2.4,
        z: -3.3,
        r: 1.1,
        label: '🫙 Press <strong>E</strong> to inspect the jars',
        action: 'toast',
        text: 'Pickles, jam, and something best left unlabelled. 🫙',
      },
    ],
  };
  private static readonly INTERIOR_DOOR_HOTSPOT = {
    x: -1.8,
    z: 3.3,
    r: 1.0,
    label: '🚪 Press <strong>E</strong> to head outside',
    action: 'leave',
  };

  /** World position of a named NPC (the "meet the AI townsfolk" guide), or null. */
  public getNpcPosition(name: string): THREE.Vector3 | null {
    const t = this.island.npcTargets.find((n) => n.name === name);
    return t ? t.meshRef.position : null;
  }

  /** Feed WASD/joystick input into the interior walk (from main-simple). */
  public setInteriorMove(forward: number, strafe: number): void {
    this.interiorMoveF = forward;
    this.interiorMoveS = strafe;
  }

  // NPCs asleep "inside" the cottage the player entered, temporarily borrowed
  // into the room. The wander loop re-claims position/orientation/visibility
  // on the first frame after exit, so no restore bookkeeping is needed.
  private interiorOccupants: THREE.Object3D[] = [];
  private interiorZzz: THREE.Sprite | null = null;
  // Cottage variation: seeded per-house decor — dedicated tint materials plus
  // optional prop groups toggled per house (2 of 4 shown).
  private cottageBlanketMat: THREE.MeshStandardMaterial | null = null;
  private cottageExtras: THREE.Group[] = [];

  /** Show the NPCs sleeping behind THIS cottage's door (cap 2: bed + rug).
   *  A sleeper's wander target IS the door dir it walked to, so matching it
   *  against this house's door identifies the room's occupants. */
  private placeCottageOccupants(houseId: string): void {
    this.interiorOccupants = [];
    const door = this.island.houseDoors.find((d) => d.id === houseId);
    if (!door) return;
    const doorDir = this._goalScratch.copy(door.position).normalize();
    const o = GameScene.INTERIOR_ORIGIN;
    // Lying poses: pitched onto the back, body along z (bed) / x (rugs). Three
    // spots — matches the balanced per-door cap (18 personas / 6 doors).
    const SPOTS: Array<{ x: number; y: number; z: number; euler: THREE.Euler }> = [
      { x: -3.0, y: 0.82, z: -2.35, euler: new THREE.Euler(-Math.PI / 2, 0, 0) }, // in the bed
      { x: 1.2, y: 0.42, z: -0.6, euler: new THREE.Euler(-Math.PI / 2, Math.PI / 2, 0, 'YXZ') }, // on the rug
      { x: 0.4, y: 0.42, z: 1.7, euler: new THREE.Euler(-Math.PI / 2, -Math.PI / 2, 0, 'YXZ') }, // by the door wall
    ];
    for (const npc of this.island.npcTargets) {
      const w = (npc.meshRef.userData as { wander?: { activity?: string; target: THREE.Vector3 } })
        .wander;
      if (!w || npc.meshRef.visible || w.activity !== 'sleep') continue;
      if (w.target.angleTo(doorDir) > 0.05) continue; // asleep behind a different door
      const spot = SPOTS[this.interiorOccupants.length];
      if (!spot) break;
      npc.meshRef.visible = true;
      npc.meshRef.position.set(o.x + spot.x, o.y + spot.y, o.z + spot.z);
      npc.meshRef.quaternion.setFromEuler(spot.euler);
      this.interiorOccupants.push(npc.meshRef);
    }
    if (this.interiorZzz) this.interiorZzz.visible = this.interiorOccupants.length > 0;
  }

  /** The hotspot the player is standing near (null when none) — main-simple
   *  shows the prompt and executes the action on E. */
  public getInteriorHotspot(): { label: string; action: string; text?: string } | null {
    return this.interiorHotspot;
  }

  /** Lazily derive furniture colliders for a themed set from its own meshes:
   *  world-space Box3 per prop → room-local AABB; overhead items (beams,
   *  banners, wall clocks) are skipped by their floor clearance. */
  private buildInteriorColliders(theme: string): void {
    if (this.interiorColliders[theme] || !this.interiorGroup) return;
    const set = this.interiorSets[theme];
    if (!set) return;
    const wasVisible = set.visible;
    set.visible = true; // Box3.setFromObject ignores invisible subtrees
    this.interiorGroup.updateMatrixWorld(true);
    const o = GameScene.INTERIOR_ORIGIN;
    const boxes: Array<{ minX: number; maxX: number; minZ: number; maxZ: number }> = [];
    const b = new THREE.Box3();
    for (const child of set.children) {
      if ((child as THREE.Sprite).isSprite) continue; // markers (💤) never block
      b.setFromObject(child);
      if (b.isEmpty()) continue;
      if (b.min.y - o.y > 1.45) continue; // overhead — walk under it
      boxes.push({
        minX: b.min.x - o.x,
        maxX: b.max.x - o.x,
        minZ: b.min.z - o.z,
        maxZ: b.max.z - o.z,
      });
    }
    set.visible = wasVisible;
    this.interiorColliders[theme] = boxes;

    // CONTACT SHADOWS, for free, from the boxes we just measured.
    // No interior mesh casts or receives a shadow and every interior light is
    // an unshadowed point light, so all the furniture floats a little. A real
    // shadow-casting point light would be a six-face cube depth render; a soft
    // blob under each footprint reads almost as well for one unlit quad.
    // The AABB pass above is already exactly the right filter — it skips
    // sprites and skips anything mounted above head height.
    if (!this.interiorBlobMat) {
      const bcv = document.createElement('canvas');
      bcv.width = 64;
      bcv.height = 64;
      const bx = bcv.getContext('2d');
      if (bx) {
        const grad = bx.createRadialGradient(32, 32, 2, 32, 32, 30);
        grad.addColorStop(0, 'rgba(0,0,0,1)');
        grad.addColorStop(0.55, 'rgba(0,0,0,0.55)');
        grad.addColorStop(1, 'rgba(0,0,0,0)');
        bx.fillStyle = grad;
        bx.fillRect(0, 0, 64, 64);
      }
      const btex = new THREE.CanvasTexture(bcv);
      this.interiorBlobMat = new THREE.MeshBasicMaterial({
        map: btex,
        transparent: true,
        depthWrite: false,
        opacity: 0.4,
        // WHITE, not black. MeshBasicMaterial multiplies colour by the map,
        // and the map is already black with a soft alpha falloff — tinting it
        // black too just multiplies black by black and makes `color` a no-op
        // that looks deliberate to the next reader.
        color: 0xffffff,
      });
    }
    for (const b of boxes) {
      const w = b.maxX - b.minX;
      const d = b.maxZ - b.minZ;
      // Desk legs are 0.12 x 0.12 = 0.014 u^2 — one blob each would be four
      // smudges under one desk instead of one shadow.
      if (w * d < 0.1) continue;
      // 1.7x the footprint, not 1.25x. A contact shadow is mostly HIDDEN by
      // the thing casting it — at 1.25x almost the whole quad sat under the
      // desk and only a hairline showed, which is why the first attempt looked
      // like nothing had changed. The visible part is the fringe, so the
      // fringe has to be wide enough to see.
      const blob = new THREE.Mesh(new THREE.PlaneGeometry(w * 1.7, d * 1.7), this.interiorBlobMat);
      // Sit just above whichever surface is actually underneath. The rug is
      // Box(4.6, 0.06, 3.4) at (0, 0.13, 0.3), so its top face is 0.16 —
      // a blob at the floor's 0.105 is BURIED by it, and the furniture
      // standing on the rug was the furniture that looked most adrift.
      const cx2 = (b.minX + b.maxX) / 2;
      const cz2 = (b.minZ + b.maxZ) / 2;
      const overRug = Math.abs(cx2) < 2.3 && Math.abs(cz2 - 0.3) < 1.7;
      blob.position.set(cx2, overRug ? 0.17 : 0.105, cz2);
      blob.rotation.x = -Math.PI / 2;
      // Parented to the SET, so the existing per-theme visible toggle carries
      // them and they never show under another room's furniture.
      set.add(blob);
    }
  }

  private interiorWallBlocked(x: number, z: number): boolean {
    const B = GameScene.INTERIOR_WALK_BOUND;
    return Math.abs(x) > B || Math.abs(z) > B;
  }

  private interiorFurnitureBlocked(x: number, z: number): boolean {
    const R = GameScene.INTERIOR_PLAYER_R;
    for (const c of this.interiorColliders[this.interiorActiveTheme] ?? []) {
      if (x > c.minX - R && x < c.maxX + R && z > c.minZ - R && z < c.maxZ + R) return true;
    }
    return false;
  }

  /** Step inside: re-theme the room (wall tint, themed furniture set, rug,
   *  hearth, posters) and start the free-walk mode — the player walks the room
   *  with wall/furniture collision and interacts with per-theme hotspots.
   *  main-simple owns the fade, the content panel (zones), and Leave. */
  public enterInterior(
    title: string,
    wallColor: number,
    left = '',
    right = '',
    theme = 'cottage',
    houseId?: string,
  ): void {
    this.buildInterior();
    if (this.interiorWallMat) {
      this.interiorWallMat.color.set(wallColor).lerp(new THREE.Color(0xffffff), 0.55);
    }
    const active = this.interiorSets[theme] ? theme : 'cottage';
    for (const [name, s] of Object.entries(this.interiorSets)) s.visible = name === active;
    this.interiorRugMat?.color.set(GameScene.INTERIOR_RUGS[active] ?? 0xb06a72);
    if (this.interiorFire) {
      const fp = GameScene.INTERIOR_FIRE_POS[active];
      this.interiorFire.intensity = fp ? 1.6 : 0;
      if (fp) this.interiorFire.position.set(fp[0], fp[1], fp[2]);
    }
    this.drawPoster(0, title, true);
    this.drawPoster(1, left, false);
    this.drawPoster(2, right, false);
    if (this.interiorGroup) this.interiorGroup.visible = true;
    this.insideInterior = true;
    // Free-walk: place the player's VISUAL group just inside the door and hold
    // the broadcast position at the door outside (peers keep seeing them
    // there, not 300u under the map). The physics state is untouched — exit
    // re-syncs the group from it, dropping them back exactly where they were.
    this.interiorActiveTheme = active;
    this.buildInteriorColliders(active);
    // Park the shadow map for the session. The world is provably frozen while
    // inside (update() early-returns into updateInteriorMode), so nothing that
    // casts a shadow can move, yet the renderer was re-rendering a 2048^2
    // desktop / 1024^2 mobile depth pass on EVERY interior frame. The interior
    // player sits at y=-300, far outside the shadow camera's ortho box parked
    // on the outdoor position, so nothing indoors was being shadowed anyway.
    const renderer = this.rendererRef?.getRenderer();
    if (renderer) {
      this.shadowAutoUpdateWas = renderer.shadowMap.autoUpdate;
      renderer.shadowMap.autoUpdate = false;
    }
    // Aim the window's camera BEFORE the player's visual group is teleported
    // into the room — getWorldPosition() is still the doorstep they walked to.
    this.aimInteriorOutlook();
    this.player.setPositionHold(this.player.getWorldPosition());
    const o = GameScene.INTERIOR_ORIGIN;
    this.player.position.set(o.x - 1.8, o.y + GameScene.INTERIOR_PLAYER_Y, o.z + 2.6);
    this.interiorYaw = Math.PI; // facing into the room (model +z convention)
    this.interiorCamYaw = Math.PI;
    this.player.quaternion.setFromAxisAngle(GameScene._localUp, Math.PI);
    this.interiorMoveF = 0;
    this.interiorMoveS = 0;
    this.interiorHotspot = null;
    // Cottage variation: deterministic per-house decor from the house number —
    // blanket/rug/wall palettes + a 2-of-4 subset of the optional prop groups,
    // so the six cottages read as different homes, stable across visits.
    if (active === 'cottage') {
      const seed = houseId ? parseInt(houseId.replace(/\D/g, ''), 10) || 0 : 0;
      const BLANKETS = [0xa54242, 0x3f6f8a, 0x8a9a5b, 0xc9a227];
      const RUG_VARIANTS = [0x9c5f4e, 0x51687d, 0x5d8a58, 0x7d6b8f, 0xb06a72];
      const WALL_VARIANTS = [0xe0c9a8, 0xd8cbb5, 0xcfd4c2, 0xe2c2b8, 0xd6c4d4, 0xc9d0da];
      this.cottageBlanketMat?.color.set(BLANKETS[seed % BLANKETS.length]);
      this.interiorRugMat?.color.set(RUG_VARIANTS[seed % RUG_VARIANTS.length]);
      this.interiorWallMat?.color
        .set(WALL_VARIANTS[seed % WALL_VARIANTS.length])
        .lerp(new THREE.Color(0xffffff), 0.35);
      const a = seed % this.cottageExtras.length;
      const b =
        (a + 1 + ((seed >> 1) % (this.cottageExtras.length - 1))) % this.cottageExtras.length;
      this.cottageExtras.forEach((g, i) => (g.visible = i === a || i === b));
    }
    // Cottage at night: reveal whoever is asleep behind THIS door.
    this.interiorOccupants = [];
    if (this.interiorZzz) this.interiorZzz.visible = false;
    if (active === 'cottage' && houseId) this.placeCottageOccupants(houseId);
  }

  /**
   * Decide what this building actually looks out ON, and point the window's
   * camera at it.
   *
   * Called while the player still stands on the doorstep, so their position is
   * the building's real position on the sphere. They walked IN, so the camera
   * behind them is looking at the building; reverse that and you are looking
   * away from it — which is what a window in the front wall sees. Raised to
   * first-floor height so the view clears the doorstep props.
   */
  private aimInteriorOutlook(): void {
    const stand = this.player.getWorldPosition();
    const up = stand.clone().normalize();
    // The chase camera sits behind the player looking at them and on into the
    // building; the outward look is its reverse, flattened to the ground plane
    // so the window never stares at the sky or into the dirt.
    const away = this.camera.getWorldDirection(new THREE.Vector3()).negate();
    away.addScaledVector(up, -away.dot(up));
    if (away.lengthSq() < 1e-6) {
      // Degenerate (camera straight overhead): fall back to any tangent.
      away.crossVectors(up, new THREE.Vector3(0, 1, 0));
      if (away.lengthSq() < 1e-6) away.set(1, 0, 0);
    }
    away.normalize();
    this.interiorViewFrom.copy(stand).addScaledVector(up, 2.2);
    this.interiorViewLook.copy(this.interiorViewFrom).addScaledVector(away, 30);
    this.interiorViewAccum = GameScene.INTERIOR_VIEW_INTERVAL; // force a frame-1 refresh
  }

  /**
   * Render the island from outside the building into the window pane.
   *
   * Costs one extra scene render at quarter resolution, four times a second.
   * The interior group is hidden for the pass: the room is 300u below and out
   * of frame anyway, but a stray near-plane clip would put the room inside its
   * own window, and that is a cheap guarantee to buy.
   */
  private refreshInteriorView(): void {
    const renderer = this.rendererRef?.getRenderer();
    if (!renderer || !this.interiorWindowMat) return;
    if (!this.interiorViewTarget) {
      // 384x288, not 512x384: the pane is ~220px on screen at a normal viewing
      // distance, so 512 was oversampled by more than 2x. Measured 2.85ms per
      // pass at 512; this is ~44% fewer pixels for no visible difference.
      this.interiorViewTarget = new THREE.WebGLRenderTarget(384, 288, {
        depthBuffer: true,
        stencilBuffer: false,
      });
      // LINEAR, not sRGB. three forces LinearSRGBColorSpace on every non-XR
      // render target (WebGLRenderer, r180) and NoToneMapping with it, so
      // tagging the texture sRGB made the sampler decode already-linear
      // radiance a second time — the view came out roughly 2.3x too dark in
      // the midtones and over-contrasted, reading as "it's gloomy outside"
      // rather than as a bug. The pane's material keeps toneMapped=true so the
      // main pass grades the sample exactly once.
      this.interiorViewTarget.texture.colorSpace = THREE.LinearSRGBColorSpace;
      // far MUST reach the sky. SkyDome is radius 800 and the starfields sit at
      // ~700-770; at the 400 I first used, the whole sky was clipped away and
      // the window showed a pale void at midnight instead of stars.
      this.interiorViewCam = new THREE.PerspectiveCamera(55, 4 / 3, 0.3, 2000);
      this.interiorWindowMat.color.set(0xffffff); // stop tinting the render
      this.interiorWindowMat.map = this.interiorViewTarget.texture;
      this.interiorWindowMat.needsUpdate = true;
    }
    const cam = this.interiorViewCam;
    if (!cam) return;
    cam.up.copy(this.interiorViewFrom).normalize();
    cam.position.copy(this.interiorViewFrom);
    cam.lookAt(this.interiorViewLook);
    cam.updateMatrixWorld(true);
    const roomWasVisible = this.interiorGroup?.visible ?? false;
    if (this.interiorGroup) this.interiorGroup.visible = false;
    // EnvironmentCycle parks the rain/snow volume on the PLAYER every frame
    // (EnvironmentCycle.ts:815), and the player is indoors — so the weather
    // was falling nowhere near the building and the window showed a dry night
    // in a storm. Borrow the volume for the pass: nobody indoors can see it.
    if (!this.interiorRainNode) {
      this.traverse((o) => {
        if (o.name === 'precipitation') this.interiorRainNode = o;
      });
    }
    const rain = this.interiorRainNode;
    const rainHome = rain ? this._goalScratch.copy(rain.position) : null;
    if (rain) {
      // Offset FORWARD, not onto the lens. Centred on the camera the nearest
      // drops sit at arm's length and read as a white wall; the main camera
      // never sees that because it trails the player. Six units ahead puts the
      // lens at the volume's rear edge, which is the same view the chase
      // camera gets.
      rain.position
        .copy(this.interiorViewFrom)
        .addScaledVector(
          this._npcNormal.copy(this.interiorViewLook).sub(this.interiorViewFrom).normalize(),
          6,
        );
    }
    // The sky gradient is oriented by a uUp uniform written every frame from
    // the MAIN camera's position (see updateAmbient). Indoors that camera is
    // 300u UNDER the island, so uUp points at the planet's core and the window
    // would render the sky upside down — horizon colours overhead, top colour
    // at the ground. Point it at the building's real up for the pass.
    const skyUp = this.skyUpUniform;
    const skyUpHome = skyUp ? this._npcColWorld.copy(skyUp.value) : null;
    if (skyUp) skyUp.value.copy(cam.up);
    const prevTarget = renderer.getRenderTarget();
    renderer.setRenderTarget(this.interiorViewTarget);
    renderer.render(this, cam);
    renderer.setRenderTarget(prevTarget);
    if (skyUp && skyUpHome) skyUp.value.copy(skyUpHome);
    if (rain && rainHome) rain.position.copy(rainHome);
    if (this.interiorGroup) this.interiorGroup.visible = roomWasVisible;
  }

  /** Draw a framed poster: title (big) or a content panel of \n-split lines. */
  private drawPoster(i: number, text: string, big: boolean): void {
    const p = this.interiorPosters[i];
    if (!p) return;
    const cv = p.ctx.canvas;
    const ctx = p.ctx;
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.fillStyle = 'rgba(250,248,242,0.94)';
    ctx.fillRect(10, 10, cv.width - 20, cv.height - 20);
    ctx.strokeStyle = 'rgba(60,50,40,0.35)';
    ctx.lineWidth = 5;
    ctx.strokeRect(10, 10, cv.width - 20, cv.height - 20);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = big ? '#3a2f26' : '#40382f';
    const lines = (text || '').split('\n');
    const fs = big ? 60 : 40;
    const lh = fs * 1.28;
    ctx.font = `bold ${fs}px system-ui, "Segoe UI", sans-serif`;
    const startY = cv.height / 2 - ((lines.length - 1) * lh) / 2;
    lines.forEach((ln, k) => ctx.fillText(ln, cv.width / 2, startY + k * lh));
    p.tex.needsUpdate = true;
  }

  public exitInterior(): void {
    this.insideInterior = false;
    if (this.interiorGroup) this.interiorGroup.visible = false;
    this.interiorHotspot = null;
    this.restoreShadowAutoUpdate();
    // Borrowed sleepers: hide now; the wander loop re-claims their position,
    // orientation, and visibility on the first world frame after exit.
    for (const m of this.interiorOccupants) m.visible = false;
    this.interiorOccupants = [];
    if (this.interiorZzz) this.interiorZzz.visible = false;
    // Release the broadcast hold and snap the visual group back onto the
    // untouched physics state — the player reappears at the door they entered.
    this.player.setPositionHold(null);
    this.player.updateWorldMatrix();
  }

  /** The interior frame: walk the player, follow with the camera, flicker the
   *  hearth, and detect the nearest interaction hotspot. Room space is flat
   *  (+y up), so this never touches the spherical-physics machinery. */
  private updateInteriorMode(deltaTime: number): void {
    this.interiorTime += deltaTime;
    // Window refresh, on CHANGE rather than on a clock. The old fixed 2.5Hz
    // tick spent ~8ms of every second re-rendering a view that had usually not
    // changed. Now it re-renders when the world outside actually differs: a
    // new five-minute bucket of the clock (which is what moves the sun and the
    // light), or a change of weather. The slow heartbeat underneath is
    // deliberate and not free — it is what keeps villagers, birds and the sea
    // moving out there, which is most of what sells the view as a window
    // rather than a photograph. At 0.5Hz it costs a quarter of what it did.
    this.interiorViewAccum += deltaTime;
    const bucket = this.envCycle ? Math.floor(this.envCycle.getHour() * 12) : -1;
    const weather = this.envCycle ? this.envCycle.getWeather() : '';
    if (bucket !== this.interiorViewBucket || weather !== this.interiorViewWeather) {
      this.interiorViewBucket = bucket;
      this.interiorViewWeather = weather;
      this.interiorViewAccum = GameScene.INTERIOR_VIEW_INTERVAL;
    }
    if (this.interiorViewAccum >= GameScene.INTERIOR_VIEW_INTERVAL) {
      this.interiorViewAccum = 0;
      this.refreshInteriorView();
    }
    // Hearth flicker (fire is 0 in hearthless rooms).
    if (this.interiorFire && this.interiorFire.intensity > 0) {
      const t = this.interiorTime;
      this.interiorFire.intensity = 1.55 + Math.sin(t * 11) * 0.22 + Math.sin(t * 23 + 1.7) * 0.14;
    }

    const o = GameScene.INTERIOR_ORIGIN;
    const p = this.player.position;
    // WEIGHT. The keyboard hands us raw ±1 integers and the old code applied
    // them straight to position: full 2.3 u/s on the first frame, dead stop on
    // release. That is what made walking indoors feel like sliding a chess
    // piece. Ramping the INPUT (not the position) keeps the collision resolve
    // below untouched while giving the body a moment to lean into a step and a
    // moment to settle out of one. Rise is quicker than fall so it still feels
    // responsive rather than floaty.
    const targetF = this.interiorMoveF;
    const targetS = this.interiorMoveS;
    const wantMove = Math.abs(targetF) + Math.abs(targetS) > 0.05;
    const ramp = Math.min(1, (wantMove ? 9 : 12) * deltaTime);
    this.interiorVelF += (targetF - this.interiorVelF) * ramp;
    this.interiorVelS += (targetS - this.interiorVelS) * ramp;
    if (Math.abs(this.interiorVelF) < 0.004) this.interiorVelF = 0;
    if (Math.abs(this.interiorVelS) < 0.004) this.interiorVelS = 0;
    const f = this.interiorVelF;
    const s = this.interiorVelS;
    const moving = Math.abs(f) + Math.abs(s) > 0.02;
    if (moving) {
      // Camera-relative move dir (model-forward = +z): fwd(yaw) = (sin, 0, cos).
      const cy = this.interiorCamYaw;
      const dirX = Math.sin(cy) * f + -Math.cos(cy) * s;
      const dirZ = Math.cos(cy) * f + Math.sin(cy) * s;
      const len = Math.hypot(dirX, dirZ);
      if (len > 1e-4) {
        const spd = (2.6 * Math.min(1, len)) / len;
        const nx = p.x - o.x + dirX * spd * deltaTime;
        const nz = p.z - o.z + dirZ * spd * deltaTime;
        // Axis-separated resolve → the player slides along walls + furniture.
        // Walls are ALWAYS solid. Furniture is skipped only while the current
        // spot already overlaps a piece (edge cases only — normal play can't
        // walk in), so a stuck player can escape but never leave the room.
        const curX = p.x - o.x;
        const curZ = p.z - o.z;
        const overlap = this.interiorFurnitureBlocked(curX, curZ);
        const okX =
          !this.interiorWallBlocked(nx, curZ) &&
          (overlap || !this.interiorFurnitureBlocked(nx, curZ));
        const midX = okX ? nx : curX;
        const okZ =
          !this.interiorWallBlocked(midX, nz) &&
          (overlap || !this.interiorFurnitureBlocked(midX, nz));
        const beforeX = p.x;
        const beforeZ = p.z;
        if (okX) p.x = o.x + nx;
        if (okZ) p.z = o.z + nz;
        // Advance the stride by DISTANCE walked, not by wall-clock. A fixed
        // sin(time*9) keeps pumping at the same rate while you ease in, stop,
        // or grind against a wall — the same 4Hz-vibration bug already fixed
        // for the villagers outdoors. Tying phase to metres means the feet
        // stop when you stop and slow when a chair slows you.
        this.interiorStride += Math.hypot(p.x - beforeX, p.z - beforeZ) * 3.6;
        // Face travel, shortest-arc eased.
        const targetYaw = Math.atan2(dirX, dirZ);
        let dYaw = targetYaw - this.interiorYaw;
        while (dYaw > Math.PI) dYaw -= Math.PI * 2;
        while (dYaw < -Math.PI) dYaw += Math.PI * 2;
        this.interiorYaw += dYaw * Math.min(1, 10 * deltaTime);
        this.player.quaternion.setFromAxisAngle(GameScene._localUp, this.interiorYaw);
      }
    }
    // Drive the real walk clip. Until now the mixer was never ticked indoors —
    // GameScene early-returns above SimplePlayer.update() — so the avatar slid
    // about with dead legs and a hand-rolled body sine standing in for a gait.
    // With the clip running, that sine would double up on the clip's own
    // vertical motion, so it is gone; the weight-shift roll stays, because the
    // clip does not lean into corners.
    const gait = Math.min(1, Math.hypot(f, s));
    this.player.tickInteriorAnimation(deltaTime, gait * 2.6);
    p.y = o.y + GameScene.INTERIOR_PLAYER_Y;

    // Footfalls, driven off the WALK CLIP's own phase rather than a distance
    // accumulator — now that the mixer ticks indoors the clip is the honest
    // source of when a foot actually lands. Fire on the two crossings per
    // cycle, alternating timbre. No dust: these are floorboards.
    if (gait > 0.25) {
      const phase = this.player.getWalkCyclePhase();
      for (const mark of [0.25, 0.75]) {
        // Crossed this mark since the last frame (handles the 1->0 wrap).
        const crossed =
          this.interiorStepPhase < mark
            ? phase >= mark
            : phase < this.interiorStepPhase && phase >= mark;
        if (crossed && this.interiorTime - this.interiorStepAt > 0.18) {
          this.interiorStepAt = this.interiorTime;
          this.interiorStepAlt = !this.interiorStepAlt;
          // The rug is Box(4.6, 0.06, 3.4) at (0, 0.13, 0.3): stepping off the
          // boards onto it should be audible, so it gets its own duller voice.
          const onRug = Math.abs(p.x - o.x) < 2.3 && Math.abs(p.z - o.z - 0.3) < 1.7;
          sfx.footstepWood(this.interiorStepAlt, onRug);
          break;
        }
      }
      this.interiorStepPhase = phase;
    }
    if (gait > 0.001) {
      // Compose a small roll onto the heading — a walker's body tips into each
      // step. Half the bob's frequency so it is one lean per stride, not two.
      this._interiorTiltQ.setFromAxisAngle(
        GameScene._localFwd,
        Math.sin(this.interiorStride * 0.5) * 0.055 * gait,
      );
      this.player.quaternion
        .setFromAxisAngle(GameScene._localUp, this.interiorYaw)
        .multiply(this._interiorTiltQ);
    }

    // Follow camera: eased behind the player's heading, clamped inside walls.
    let dCam = this.interiorYaw - this.interiorCamYaw;
    while (dCam > Math.PI) dCam -= Math.PI * 2;
    while (dCam < -Math.PI) dCam += Math.PI * 2;
    this.interiorCamYaw += dCam * Math.min(1, 3 * deltaTime);
    const cy = this.interiorCamYaw;
    const camX = THREE.MathUtils.clamp(p.x - o.x - Math.sin(cy) * 2.4, -3.6, 3.6);
    const camZ = THREE.MathUtils.clamp(p.z - o.z - Math.cos(cy) * 2.4, -3.6, 3.6);
    this.camera.up.set(0, 1, 0);
    this.camera.position.set(o.x + camX, o.y + GameScene.INTERIOR_PLAYER_Y + 1.25, o.z + camZ);
    this.camera.lookAt(p.x, p.y + 0.85, p.z);

    // Fixtures: curtains slide, the lamp fades. Both eased rather than snapped
    // so pressing E reads as working something, not as a state flip.
    const curtainWant = this.interiorCurtainsShut ? 1 : 0;
    if (Math.abs(this.interiorCurtainT - curtainWant) > 0.001) {
      this.interiorCurtainT += (curtainWant - this.interiorCurtainT) * Math.min(1, 6 * deltaTime);
      for (const c of this.interiorCurtains) {
        c.mesh.position.x = c.open + (c.shut - c.open) * this.interiorCurtainT;
      }
    }
    if (this.interiorLamp) {
      const lampWant = this.interiorLampOn ? 1.35 : 0;
      this.interiorLamp.intensity +=
        (lampWant - this.interiorLamp.intensity) * Math.min(1, 9 * deltaTime);
      if (this.interiorBulb) {
        (this.interiorBulb.material as THREE.MeshBasicMaterial).color.setHex(
          this.interiorLampOn ? 0xffe8b8 : 0x6b6a63,
        );
      }
    }

    // Floating 💤 bob while a sleeper occupies the bed.
    if (this.interiorZzz?.visible) {
      this.interiorZzz.position.y = 1.55 + Math.sin(this.interiorTime * 2.2) * 0.09;
    }

    // Nearest hotspot (theme spots + the door), for the prompt + E action.
    const spots = GameScene.INTERIOR_HOTSPOTS[this.interiorActiveTheme] ?? [];
    let found: { id?: string; label: string; action: string; text?: string } | null = null;
    let bestD = Infinity;
    const px = p.x - o.x;
    const pz = p.z - o.z;
    // Shell fixtures are appended to EVERY theme, like the door — one
    // implementation serving all six rooms. Labels reflect current state so
    // the prompt never offers to do what you just did.
    const shellSpots = [
      {
        x: -2.75,
        z: 3.0,
        r: 1.0,
        label: this.interiorLampOn
          ? '💡 Press <strong>E</strong> to switch the lamp off'
          : '💡 Press <strong>E</strong> to switch the lamp on',
        action: 'room',
        text: 'lamp',
      },
      {
        x: 1.8,
        z: 2.95,
        r: 1.05,
        label: this.interiorCurtainsShut
          ? '🪟 Press <strong>E</strong> to open the curtains'
          : '🪟 Press <strong>E</strong> to draw the curtains',
        action: 'room',
        text: 'curtains',
      },
    ];
    for (const h of [...spots, ...shellSpots, GameScene.INTERIOR_DOOR_HOTSPOT]) {
      const d = Math.hypot(px - h.x, pz - h.z);
      if (d < h.r && d < bestD) {
        bestD = d;
        found = h;
      }
    }
    // An occupied bed changes the interaction — you don't "test" someone's bed.
    if (found?.id === 'bed' && this.interiorOccupants.length > 0) {
      found = {
        label: '🤫 Press <strong>E</strong> to whisper goodnight',
        action: 'toast',
        text: 'You whisper goodnight. The blanket rises and falls. 💤',
      };
    }
    this.interiorHotspot = found;
  }

  /**
   * Get the ready state promise
   */
  public async ready(): Promise<void> {
    return this.readyPromise;
  }

  /**
   * Get player instance
   */
  public getPlayer(): SimplePlayer {
    return this.player;
  }

  /**
   * Get camera instance
   */
  public getCamera(): THREE.PerspectiveCamera {
    return this.camera;
  }

  /**
   * Get mailboxes
   */
  public getMailboxes(): Mailbox[] {
    return this.mailboxes;
  }

  /**
   * Get zones manager
   */
  public getZonesManager(): ZonesManager {
    return this.zonesManager;
  }

  /**
   * Get orbit camera controller
   */
  public getOrbitCamera(): OrbitCamera {
    return this.orbitCamera;
  }

  /** Start/finish gate of a race circuit, for the compass guide CTA. */
  public getRaceStartPosition(kind: 'land' | 'water'): THREE.Vector3 | null {
    return this.races?.getStartPosition(kind) ?? null;
  }

  // Tour mode drives the camera directly along a cinematic rail; the orbit
  // follow-cam must not fight it, so its per-frame update is suspended while
  // the rail runs. The world (NPCs, sea, activities) keeps running throughout.
  private cameraSuspended = false;
  public setCameraSuspended(on: boolean): void {
    this.cameraSuspended = on;
  }

  // setPlayerMovement scratch — called every input frame, keep allocation-free
  private _moveDir = new THREE.Vector3();
  private _moveAlignQ = new THREE.Quaternion();
  private _moveLocal = new THREE.Vector3();

  /**
   * Set player movement input (camera-relative)
   */
  public setPlayerMovement(forward: number, strafe: number): void {
    if (this.player && this.orbitCamera) {
      // getForwardDirection/getRightDirection are already projected onto the tangent plane
      const cameraForward = this.orbitCamera.getForwardDirection();
      const cameraRight = this.orbitCamera.getRightDirection();

      // Build world-space movement direction from camera orientation
      const moveDir = this._moveDir.set(0, 0, 0);
      moveDir.addScaledVector(cameraForward, forward);
      moveDir.addScaledVector(cameraRight, strafe);

      // Full 3D vector — tangent directions have a Y component on a sphere
      this.player.setMovementVector(moveDir);

      // Face the movement direction. Yaw is defined around the surface
      // normal, so express moveDir in the player's tangent frame first.
      // setRotation is a target heading — the player eases onto it
      // (shortest arc) in its own update, so reversals sweep, not snap.
      if (moveDir.length() > 0.01) {
        const normal = this.player.getSurfaceNormal();
        this._moveAlignQ.setFromUnitVectors(GameScene._localUp, normal);
        const local = this._moveLocal.copy(moveDir).applyQuaternion(this._moveAlignQ.invert());
        this.player.setRotation(Math.atan2(local.x, local.z));
      }
    }
  }

  /**
   * Request player jump
   */
  public playerJump(): void {
    if (this.player) {
      this.player.jump();
    }
  }

  /**
   * Set camera input
   */
  public setCameraInput(deltaYaw: number, deltaPitch: number): void {
    if (this.orbitCamera) {
      this.orbitCamera.setInput(deltaYaw, deltaPitch);
    }
  }

  /**
   * Get directional light
   */
  public getSunLight(): THREE.DirectionalLight | undefined {
    return this.lights.sun;
  }

  /**
   * Get island instance
   */
  public getIsland(): Island {
    return this.island;
  }

  /**
   * Handle window resize
   */
  private onWindowResize(): void {
    const width = window.innerWidth;
    const height = window.innerHeight;

    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  /**
   * Raycast from camera
   */
  public rayCastFromCamera(x: number, y: number): THREE.Intersection[] {
    const raycaster = new THREE.Raycaster();
    const mouse = new THREE.Vector2(
      (x / window.innerWidth) * 2 - 1,
      -(y / window.innerHeight) * 2 + 1,
    );

    raycaster.setFromCamera(mouse, this.camera);
    // Explicitly set .camera too: this recurses the whole scene, which now
    // contains Sprites (zone icons, project plaques, fireflies), and Sprite
    // raycasting needs raycaster.camera or it logs a console error per sprite.
    raycaster.camera = this.camera;
    const hits = raycaster.intersectObjects(this.children, true);
    return hits;
  }

  /**
   * Dispose of scene resources
   */
  public dispose(): void {
    if (this.player) {
      this.player.dispose();
    }
    // Teardown can happen mid-visit (page unload while inside), so hand the
    // shadow map back here too rather than only on the normal exit path.
    this.restoreShadowAutoUpdate();
    // The window's render target owns a GPU texture and depth buffer; the
    // traverse below only reaches scene-graph descendants, and this is not one.
    this.interiorViewTarget?.dispose();
    this.interiorViewTarget = null;
    this.interiorViewCam = null;

    // Dispose island resources. island.mesh is the island GROUP (dozens of
    // child meshes), NOT a Mesh — it has no geometry/material of its own, so the
    // old island.mesh.geometry.dispose() read .dispose off undefined and threw
    // "Cannot read properties of undefined (reading 'dispose')" on every
    // teardown / page unload (the long-standing 2-per-load LIVE error). Traverse
    // the group and dispose each descendant's geometry (incl. its three-mesh-bvh
    // bounds tree) and material, all null-guarded.
    if (this.island && this.island.mesh) {
      this.island.mesh.traverse((obj: THREE.Object3D) => {
        const g = (obj as THREE.Mesh).geometry;
        g?.disposeBoundsTree?.();
        g?.dispose?.();
        const mat = (obj as THREE.Mesh).material;
        if (Array.isArray(mat)) mat.forEach((m) => m?.dispose?.());
        else mat?.dispose?.();
      });
    }

    // Stop and dispose animation mixers
    this.animationMixers.forEach((mixer) => {
      try {
        mixer.stopAllAction();
      } catch {
        // Ignore mixer cleanup issues
      }
    });
    this.animationMixers = [];

    // Dispose all materials and geometries
    this.traverse((obj: THREE.Object3D) => {
      const geometry = (obj as { geometry?: THREE.BufferGeometry }).geometry;
      geometry?.disposeBoundsTree?.();
      geometry?.dispose?.();

      const material = (obj as { material?: THREE.Material | THREE.Material[] }).material;
      if (Array.isArray(material)) {
        material.forEach((mat) => mat.dispose());
      } else {
        material?.dispose?.();
      }
    });
  }
}
