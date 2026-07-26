import * as THREE from 'three';

import { EnvironmentCycle } from './EnvironmentCycle';
import { Island } from './Island';
import { Mailbox } from './Mailbox';
import { Materials } from './Materials';
import { OrbitCamera } from './OrbitCamera';
import { RaceSystem, type RaceEvent, type RaceHudStatus } from './RaceSystem';
import { sfx } from './Sfx';
import { SimplePlayer } from './SimplePlayer';
import { TownPlanner, type TownPlanResult } from './TownPlanner';
import { loadGLTFWithFallbacks } from './utils/GLTFModelLoader';
import { ZonesManager } from './ZonesManager';

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

  // Player-centred radar tangent basis (recomputed each minimap refresh).
  // The minimap is a GTA-style local radar: north-up, player at the centre.
  private static readonly RADAR_RANGE = 1.35; // radians of arc to the radar edge
  private radarUp = new THREE.Vector3(0, 1, 0);
  private radarNorth = new THREE.Vector3(0, 0, 1);
  private radarEast = new THREE.Vector3(1, 0, 0);

  // Birds orbiting the planet with flapping wings
  private birds: Array<{
    pivot: THREE.Object3D;
    wingL: THREE.Mesh;
    wingR: THREE.Mesh;
    speed: number;
    phase: number;
  }> = [];

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
    speed: number;
    phase: number;
    turnAt: number;
    jumpT0: number; // -1 = swimming, else jump start time (s)
    jumpDur: number;
    depth: number; // metres the body sits below the wave surface
  }> = [];
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
  } | null = null;

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
  // NPCs turn to face the player within FACE_RANGE and greet within GREET_RANGE
  private static readonly NPC_FACE_RANGE = 4.5;
  private static readonly NPC_GREET_RANGE = 3.2;
  private static readonly _localUp = new THREE.Vector3(0, 1, 0);
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
    this.fog = new THREE.FogExp2(0xa8d8f0, 0.012);

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
      60,
      window.innerWidth / window.innerHeight,
      0.1,
      2000,
    );

    // Create spherical island
    // 22u radius (was 18, Messenger parity): with the player scaled to
    // ~1.58u the world reads noticeably bigger — longer blocks, gentler
    // horizon. All placement is lon/lat-based so the districts spread
    // automatically; physical spacing grows with the radius.
    this.island = new Island(22);
    this.add(this.island.mesh);
    // Unify the art direction: stepped toon shading on every prop (abeto-style)
    this.toonifyIslandMaterials();

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
      [/^npc_placeholder_\d+$/, 0.5],
      [/^central_statue$/, 0.55],
      [/^town_fountain$/, 2.3],
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
    // or after this async init finishes.
    this.races = new RaceSystem(this, this.island, this.colliders);
    this.races.onEvent = (e) => this.onRaceEventCb?.(e);
    this.races.onHud = (s) => this.onRaceHudCb?.(s);
    this.races.build();

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
    // Spawn ON the terrain at the north pole (the ideal-sphere height can be
    // inside or above a terrain bump, which used to cause a slide at spawn)
    const spawnDir = new THREE.Vector3(0, 1, 0);
    const spawnSample = this.island.sampleSurfaceByDirection(spawnDir, 0);
    const spawnHeight = spawnSample.position.length() + 0.75;
    // Set playerPosition (internal field) so physics starts at the north pole
    this.player.setWorldPosition(new THREE.Vector3(0, spawnHeight, 0));
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
    }

    // Create orbit camera (with terrain collision so hills don't block the view)
    this.orbitCamera = new OrbitCamera(this.camera, this.player);
    this.orbitCamera.setCollisionMesh(this.island.mesh); // terrain + all props

    // Create zones manager for portfolio content
    this.zonesManager = new ZonesManager(this.island, this);

    // Place decorative assets via TownPlanner
    await this.placeAssets();

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

    // The Fisherman stands at the shore and casts a line
    this.setupFisherman();
    // The Baker works his oven at the village bakery
    this.setupBaker();
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
    const coarse =
      typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
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

  /**
   * Small birds orbiting the planet below the cloud layer, wings
   * flapping in update(). Pure ambient life — no interaction.
   */
  private createBirds(): void {
    const bodyMat = new THREE.MeshToonMaterial({ color: 0x4a4a55 });
    const wingMat = new THREE.MeshToonMaterial({ color: 0x666677, side: THREE.DoubleSide });
    const planetR = this.island ? this.island.getRadius() : 18;
    for (let i = 0; i < 4; i++) {
      const pivot = new THREE.Object3D();
      pivot.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI * 2, Math.random() * Math.PI);
      const bird = new THREE.Group();
      // Body — small elongated sphere pointing along travel direction (-Z of pivot spin)
      const body = new THREE.Mesh(new THREE.SphereGeometry(0.09, 6, 5), bodyMat);
      body.scale.set(1, 0.9, 1.9);
      bird.add(body);
      // Beak
      const beak = new THREE.Mesh(new THREE.ConeGeometry(0.03, 0.08, 4), wingMat);
      beak.rotation.x = -Math.PI / 2;
      beak.position.z = -0.2;
      bird.add(beak);
      // Wings — thin flattened boxes hinged at the body sides
      const wingGeo = new THREE.BoxGeometry(0.34, 0.015, 0.15);
      wingGeo.translate(0.17, 0, 0); // hinge at inner edge
      const wingL = new THREE.Mesh(wingGeo, wingMat);
      wingL.position.set(0.06, 0.02, 0);
      bird.add(wingL);
      const wingR = new THREE.Mesh(wingGeo, wingMat);
      wingR.position.set(-0.06, 0.02, 0);
      wingR.rotation.y = Math.PI;
      bird.add(wingR);
      // pivot.rotateY carries the bird along its local -Z, which is
      // already the model's forward (beak at -Z) — no extra yaw needed.
      bird.position.set(planetR + 3 + Math.random() * 2.5, 0, 0);
      // Roll the bird upright. At its +X orbit position, radially-outward
      // is +X but the model's up (+Y) points along the pivot's +Y (the
      // orbit axis) — so it flew banked on its side, one wing toward the
      // planet and one into space. Roll -90° about the forward (Z) axis so
      // up → radial-out and the wings spread horizontally (level flight).
      bird.rotation.z = -Math.PI / 2;
      pivot.add(bird);
      pivot.name = `bird_pivot_${i}`;
      this.add(pivot);
      this.birds.push({
        pivot,
        wingL,
        wingR,
        speed: 0.12 + Math.random() * 0.08,
        phase: Math.random() * Math.PI * 2,
      });
    }
  }

  // [bodyColour, finColour, scale] — shared by the ocean fish + the catch.
  private static readonly FISH_TYPES: Array<[number, number, number]> = [
    [0xff7a33, 0xffe0b0, 0.5], // clownfish orange
    [0x39a6e6, 0xa6e6ff, 0.5], // blue tang
    [0xccd4dc, 0xf0f6fa, 0.42], // silver
    [0xd98a3a, 0xf2c48a, 0.55], // koi gold
    [0x415a68, 0xb0c8d4, 0.8], // big dark
  ];

  /** One low-poly fish: elongated body + dorsal fin + a rear tail pivot. */
  private buildFish(bodyC: number, finC: number): { group: THREE.Group; tail: THREE.Object3D } {
    const g = new THREE.Group();
    const bodyMat = new THREE.MeshToonMaterial({ color: bodyC });
    const finMat = new THREE.MeshToonMaterial({ color: finC, side: THREE.DoubleSide });
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
    const N = 22;
    for (let i = 0; i < N; i++) {
      const [bc, fc, sc] = GameScene.FISH_TYPES[i % GameScene.FISH_TYPES.length];
      const { group, tail } = this.buildFish(bc, fc);
      group.scale.setScalar(sc);
      // Place over open water (a random dir below the shoreline latitude)
      let dir = new THREE.Vector3(0, -1, 0);
      for (let attempt = 0; attempt < 12; attempt++) {
        const lon = Math.random() * Math.PI * 2;
        const lat = -0.28 + Math.random() * 0.5; // −0.28..0.22
        dir = this.island.dirAt(lon, lat);
        if (dir.y < Math.sin(0.22)) break;
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
        speed: 1.1 + Math.random() * 1.5,
        phase: Math.random() * Math.PI * 2,
        turnAt: 0,
        jumpT0: -1,
        jumpDur: 0,
        // Ride right at the surface so backs/fins break through the (now more
        // opaque) water and read clearly; jumps do the rest.
        depth: 0.02 + Math.random() * 0.07,
      });
    }
    console.log(`🐟 ${this.fish.length} fish in the ocean`);
  }

  /** Swim + wiggle + jump the fish. Cheap: analytic wave surface, no raycasts. */
  private updateFish(deltaTime: number, time: number): void {
    if (this.fish.length === 0 || !this.island) return;
    const seaT = this.island.seaTimeUniform.value;
    const R = this.island.getRadius();
    const shoreY = Math.sin(0.24);
    for (const f of this.fish) {
      // Occasional gentle turn, and a rare leap
      if (time > f.turnAt) {
        f.turnAt = time + 2 + Math.random() * 4;
        f.heading.applyAxisAngle(f.dir, (Math.random() - 0.5) * 1.4).normalize();
        if (f.jumpT0 < 0 && Math.random() < 0.3) {
          f.jumpT0 = time;
          f.jumpDur = 0.85 + Math.random() * 0.4;
        }
      }
      // Steer back to open water if drifting up toward the beach
      if (f.dir.y > shoreY - 0.06) {
        this._fishDown.set(0, -1, 0).addScaledVector(f.dir, f.dir.y).normalize();
        f.heading.lerp(this._fishDown, 0.1);
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
          this.spawnRipple(f.dir.clone().multiplyScalar(waveR), 1.5, 0.9);
          this.spawnSpray(f.dir.clone().multiplyScalar(waveR), f.heading, 3, 3.2);
        } else {
          radius = waveR + Math.sin(p * Math.PI) * 1.3;
          pitch = Math.cos(p * Math.PI) * 0.9;
        }
      }
      f.group.position.copy(f.dir).multiplyScalar(radius);
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
    const faceFor = (dir: THREE.Vector3, normal: THREE.Vector3, pos: THREE.Vector3): THREE.Vector3 => {
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
    let best: { pos: THREE.Vector3; dir: THREE.Vector3; normal: THREE.Vector3; clear: number } | null =
      null;
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
      const panel = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.05, 1.7), i % 2 ? stripe2 : stripe);
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
      new THREE.PlaneGeometry(1.5, 0.56),
      new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(canvas), transparent: true, side: THREE.DoubleSide }),
    );
    sign.position.set(0, 1.75, -1.35);
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
        dir: spotPlace.dir,
        r: spotPlace.position.length(),
        n: spotPlace.normal,
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
    };
    console.log('🎣 Fisherman routine set up (shore + stall)');
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
      let bobberFwd = 2.6;
      let bobberDrop = 0.14;
      if (F.state === 'cast') {
        // Whip the rod back then forward, then the line lands
        const p = Math.min(st / 1.0, 1);
        theta = 1.35 - Math.sin(p * Math.PI) * 0.85;
        bobberFwd = 0.6 + p * 2.0;
        if (p >= 1) {
          F.state = 'wait';
          F.t0 = time;
          F.waitDur = 3 + Math.random() * 5;
          this.spawnRipple(F.bobber.getWorldPosition(new THREE.Vector3()), 1.0, 0.9);
        }
      } else if (F.state === 'wait') {
        theta = 0.9 + Math.sin(time * 0.8) * 0.05;
        bobberDrop = 0.14 - Math.sin(time * 1.6) * 0.05;
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
        bobberFwd = 2.6 - p * 1.9;
        bobberDrop = 0.14 - p * 0.7;
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
        F.caught.position.copy(F.rig.localToWorld(bobberLocal.clone())).addScaledVector(F.spot.n, -0.18);
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
      pos.copy(n).multiplyScalar(THREE.MathUtils.lerp(from.r, to.r, ease));
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
      const hand = F.npc.meshRef.position.clone().addScaledVector(F.stand.n, 1.1).addScaledVector(F.stand.face, 0.3);
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
    const box = (w: number, h: number, d: number, mat: THREE.Material, x: number, y: number, z: number) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
      m.position.set(x, y, z);
      m.castShadow = true;
      g.add(m);
      return m;
    };
    // Counter (front −Z toward customers) on legs
    box(2.4, 0.14, 0.95, wood, 0, 0.92, -0.95);
    for (const sx of [-1.05, 1.05]) for (const sz of [-1.32, -0.6]) box(0.1, 0.92, 0.1, dark, sx, 0.46, sz);
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
      new THREE.PlaneGeometry(1.5, 0.56),
      new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(canvas), transparent: true, side: THREE.DoubleSide }),
    );
    sign.position.set(0, 1.75, -1.35);
    sign.rotation.y = Math.PI;
    g.add(sign);
    const ovenLocal = new THREE.Vector3(1.75, 0.55, -0.28);
    const kneadLocal = new THREE.Vector3(-0.55, 1.06, -0.9);
    const slots: THREE.Vector3[] = [];
    for (let i = 0; i < 4; i++) slots.push(new THREE.Vector3(0.15 + i * 0.34, 1.03, -0.9));
    return { group: g, ovenLocal, kneadLocal, slots, ovenGlow };
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
          glow((1 - p) / 0.25 * 0.4);
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
    const planetR = this.island ? this.island.getRadius() : 18;
    for (let i = 0; i < 10; i++) {
      const pivot = new THREE.Object3D();
      // Random orbit plane
      pivot.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI * 2, Math.random() * Math.PI);
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
      radii.forEach((r, idx) => {
        const blob = new THREE.Mesh(new THREE.SphereGeometry(r, 9, 7), cloudMat);
        if (idx === 0) {
          blob.position.set(0, r * 0.35, 0);
        } else {
          const side = idx % 2 === 1 ? 1 : -1;
          if (idx % 2 === 1) xCursor += r * 0.9;
          blob.position.set(side * (coreR * 0.55 + xCursor * 0.6), r * 0.32, (Math.random() - 0.5) * 0.5);
        }
        blob.scale.y = 0.6;
        blob.rotation.y = Math.random() * Math.PI; // yaw only — never tilt
        blob.castShadow = true;
        cloud.add(blob);
      });
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
      this.waterRings.push({ mesh, mat, t0: -1, life: 1, maxScale: 1, normal: new THREE.Vector3() });
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
  private spawnSpray(origin: THREE.Vector3, dir: THREE.Vector3, count: number, speed: number): void {
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
  private questMarkers: Array<{ mesh: THREE.Group; npcName: string; base: THREE.Vector3; normal: THREE.Vector3 }> = [];

  // Floating role labels ("🥖 Baker") above every NPC, readable from afar.
  private nameTags: Array<{
    sprite: THREE.Sprite;
    target: { position: THREE.Vector3; meshRef: THREE.Object3D };
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
      marker.position.copy(base).addScaledVector(normal, 2.1);
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
      const sprite = GameScene.makeNameSprite(info.emoji, info.role);
      this.add(sprite);
      this.nameTags.push({ sprite, target: npc });
    }
    console.log(`🏷️ ${this.nameTags.length} NPC name pins created`);
  }

  /** Canvas pill (emoji + role) rendered as a camera-facing sprite. */
  private static makeNameSprite(emoji: string, role: string): THREE.Sprite {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      const text = `${emoji} ${role}`;
      ctx.font = '600 30px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const w = Math.min(248, ctx.measureText(text).width + 30);
      // Pill background
      ctx.fillStyle = 'rgba(10,14,26,0.85)';
      ctx.beginPath();
      ctx.roundRect(128 - w / 2, 12, w, 40, 20);
      ctx.fill();
      ctx.strokeStyle = 'rgba(170,205,255,0.7)';
      ctx.lineWidth = 2.5;
      ctx.stroke();
      ctx.fillStyle = '#ffffff';
      ctx.fillText(text, 128, 33);
    }
    const tex = new THREE.CanvasTexture(canvas);
    const sprite = new THREE.Sprite(
      // depthWrite:false so pills never occlude each other; depthTest stays TRUE
      // so terrain hides pins on the far side of the planet (no x-ray labels).
      new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }),
    );
    sprite.scale.set(1.7, 0.42, 1);
    sprite.renderOrder = 2;
    return sprite;
  }

  public getCoinsCollected(): number {
    return this.coinsCollected;
  }

  /**
   * Spinning collectible coins scattered across the open meadows —
   * traversal rewards between districts (A Short Hike-style). Collected
   * on touch with a chime; each respawns after 45 seconds.
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
      if (fwd.lengthSq() < 1e-6) fwd.copy(new THREE.Vector3(0, 1, 0).addScaledVector(dir, -dir.y)).normalize();
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
    return this.activeVehicle >= 0 ? this.vehicles[this.activeVehicle]?.kind ?? null : null;
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

  /** Nearest boardable vehicle to the player within range, or -1. */
  public nearestBoardable(): number {
    if (this.activeVehicle >= 0) return -1;
    const p = this.player.getWorldPosition();
    let best = -1;
    let bestD = 3.2; // board range
    this.vehicles.forEach((v, i) => {
      if (v.occupied) return;
      const d = v.group.position.distanceTo(p);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    return best;
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
    this.activeVehicle = -1;
    this.player.setRiding(false);
    this.orbitCamera?.setRideMode(false);
    this.orbitCamera?.setFollowVelocity(null);
    // step to the vehicle's side (perpendicular to heading) so we don't land
    // on the hull/roof
    const side = this._fxScratch.crossVectors(v.forward, v.dir).normalize();
    const dropDir = v.dir.clone().addScaledVector(side, 1.8 / this.island.getRadius()).normalize();
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
    for (const c of this.colliders) {
      if (c.radius >= 1.2 && this.pushCarOutOf(world, c.position, c.radius)) pushed = true;
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
        const speed = v.kind === 'jetski' ? 10 : isCar ? 9 : 6.5;
        if (this._vehFwd.length() > 0.02) {
          this._vehFwd.normalize();
          this._vehTangent
            .copy(this._vehFwd)
            .addScaledVector(v.dir, -this._vehFwd.dot(v.dir))
            .normalize();
          const theta = (speed * deltaTime) / R;
          this._vehNext
            .copy(v.dir)
            .multiplyScalar(Math.cos(theta))
            .addScaledVector(this._vehTangent, Math.sin(theta))
            .normalize();
          const onValidGround = isCar
            ? !this.island.isOverWater(this._vehNext) // cars keep off the sea
            : this.island.isOverWater(this._vehNext) && // craft keep on the sea…
              this._vehNext.y >= GameScene.SEA_EDGE_Y; // …but not past the sea edge
          if (onValidGround) {
            v.dir.copy(this._vehNext);
            v.forward.copy(this._vehTangent);
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
        // Bank into turns + pitch (motion feel)
        v.group.rotateOnAxis(GameScene._localForward, -this.vehicleMove.strafe * 0.35);
        v.group.rotateOnAxis(GameScene._localRight, -Math.abs(this.vehicleMove.forward) * 0.1);

        // Cars: roll the wheels (visible spokes), steer the fronts, and kick
        // up a dust trail so the driving actually READS as motion.
        if (isCar && v.wheels.length) {
          const dirSign = this.vehicleMove.forward < -0.01 ? -1 : 1;
          // wheel radius 0.2 * car scale 1.12 ≈ 0.224 — roll = arc / radius
          const roll = (moving ? dirSign * speed : 0) * deltaTime / 0.224;
          const steer = Math.max(-1, Math.min(1, this.vehicleMove.strafe)) * 0.5;
          for (const w of v.wheels) {
            w.rotation.x -= roll;
            if (w.userData.isFront) w.rotation.y = steer;
          }
          this._carDustAccum += deltaTime;
          if (moving && this._carDustAccum > 0.1) {
            this._carDustAccum = 0;
            const rear = v.dir
              .clone()
              .multiplyScalar(surfaceR)
              .addScaledVector(v.forward, -1.5);
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
        topColor: { value: new THREE.Color(0x4a90d9) },
        bottomColor: { value: new THREE.Color(0xd4e8f7) },
        horizonColor: { value: new THREE.Color(0xa8d8f0) },
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
    const planner = new TownPlanner(this);
    const result = await planner.generate({
      size: 80,
      roadSpacing: 80,
      roadWidth: 6,
      blockInset: 4,
      treesPerBlock: [1, 3],
    });

    // Position assets on the sphere surface
    // For a sphere centred at origin, equatorial points are at (cos(a)*R, 0, sin(a)*R).
    // We orient each asset so its local +Y aligns with the outward surface normal.
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
      // Shared spacing registry with Island's own props — stops clustering
      dir = this.island.claimDir(dir, clearArc);
      // Seat on the DISPLACED terrain, not the ideal sphere (hills are ±4
      // units — ideal-sphere placement left props floating over valleys)
      let R = this.island.getRadius();
      try {
        R = this.island.sampleSurfaceByDirection(dir, 0).position.length();
      } catch {
        /* ideal-sphere fallback */
      }
      const pos = dir.clone().multiplyScalar(R + radiusOffset);
      mesh.position.copy(pos);
      // Align asset's +Y with outward surface normal
      mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    };

    // The delivery loop needs several mailboxes; TownPlanner yields one per block,
    // so top up to a minimum before projecting everything onto the sphere.
    const MIN_MAILBOXES = 4;
    while (result.mailboxes.length < MIN_MAILBOXES) {
      const mailbox = new Mailbox();
      this.add(mailbox.mesh);
      result.mailboxes.push(mailbox);
    }

    // Spread quest mailboxes across the ISLAND's latitude bands (coastal
    // road up to the highlands) so the delivery chain still tours the whole
    // map — southern latitudes are open ocean now.
    const MAILBOX_LATS = [0.55, 0.3, 0.95, 0.42, 0.75, 1.1];
    result.mailboxes.forEach((mailbox, index) => {
      const angle = index * 2.399963; // golden angle spread
      const lat = MAILBOX_LATS[index % MAILBOX_LATS.length];
      mailbox.mesh.scale.setScalar(0.55); // real-scale: roadside mailbox, not a monument
      placeOnSphere(mailbox.mesh, angle, lat, -0.02, 0.3);
    });

    result.lamps.forEach((lamp, index) => {
      const angle =
        (index / Math.max(result.lamps.length, 1)) * Math.PI * 2 +
        Math.PI / Math.max(result.lamps.length, 1);
      placeOnSphere(lamp.group, angle, -0.1, -0.04, 0.25);
    });

    // Houses: TownPlanner lays them out on a flat grid, which floats them far off
    // an r≈18 sphere. Re-project each onto the surface at spread angles/latitudes.
    const HOUSE_LATS = [0.45, -0.5, 0.2, -0.3];
    result.houses.forEach((house, index) => {
      const angle = index * 2.399963 + Math.PI / 5;
      placeOnSphere(house.mesh, angle, HOUSE_LATS[index % HOUSE_LATS.length], -0.15, 0.4);
    });

    // APPEND TownPlanner colliders at their re-projected sphere positions
    // (their flat-grid originals sat at Y=0 and were never merged). This
    // used to ASSIGN the array — wiping the island prop colliders
    // registered in initialize() and leaving houses/trees ghost-walkable.
    this.colliders.push(
      ...result.mailboxes.map((m) => ({ position: m.mesh.position.clone(), radius: 1 })),
      ...result.lamps.map((l) => ({ position: l.group.position.clone(), radius: 0.5 })),
      ...result.houses.map((h) => ({ position: h.mesh.position.clone(), radius: 1.6 })),
    );
    this.mailboxes = result.mailboxes;
    this.lamps = result.lamps;

    console.log('🏝️ Island assets placed:', {
      colliders: this.colliders.length,
      mailboxes: this.mailboxes.length,
      lamps: this.lamps.length,
    });
  }

  /**
   * Scatter low-poly toon props (Blender-exported glb) onto the sphere surface.
   * Uses the same "+Y = outward normal" projection the lamps/mailboxes use, so
   * props sit flush on the planet instead of the flat-grid TownPlanner placement.
   */
  private async scatterProps(): Promise<void> {
    const GOLDEN = 2.399963; // golden angle for even angular spread

    const placeOnSphere = (obj: THREE.Object3D, angle: number, latitude: number, clearArc = 0.22) => {
      const cosLat = Math.cos(latitude);
      let dir = new THREE.Vector3(
        Math.cos(angle) * cosLat,
        Math.sin(latitude),
        Math.sin(angle) * cosLat,
      ).normalize();
      dir = this.island.claimDir(dir, clearArc); // shared anti-cluster registry
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
        placeOnSphere(inst, i * GOLDEN + 1.0, Math.random() * 1.6 - 0.8);
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

    // Update player physics
    this.player.update(deltaTime);

    // Check collisions with assets
    this.checkPlayerCollisions();

    // Update camera
    if (this.orbitCamera) {
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

    // Birds: orbit + wing flap
    for (const b of this.birds) {
      b.pivot.rotateY(b.speed * deltaTime);
      const flap = Math.sin(time * 9 + b.phase) * 0.55;
      b.wingL.rotation.z = flap;
      b.wingR.rotation.z = -flap;
    }

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
        const data = npc.meshRef.userData as {
          greetT0?: number;
          lastGreetAt?: number;
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
          };
        }
        const w = data.wander;
        let moving = false;
        if (w.state === 'idle') {
          if (time > w.until) {
            w.target.copy(this.randomDirNear(w.home, 0.1));
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
            w.until = time + 3 + Math.random() * 7;
          } else {
            this._wanderAxis.crossVectors(w.dir, w.target);
            if (this._wanderAxis.lengthSq() > 1e-10) {
              this._wanderAxis.normalize();
              // ~0.5 u/s stroll on the R=18 sphere
              w.dir.applyAxisAngle(this._wanderAxis, Math.min(0.028 * deltaTime, remaining));
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
        // Walk bob is faster/taller than the idle breathing bob
        const bob = moving
          ? (Math.sin(time * 9 + i * 1.7) + 1) * 0.03
          : (Math.sin(time * 2 + i * 1.7) + 1) * 0.015;
        npc.meshRef.position
          .copy(w.dir)
          .multiplyScalar(w.radius)
          .addScaledVector(this._npcNormal, bob + hop);
        npc.position.copy(npc.meshRef.position);

        // Notice the player: when they walk near, turn to face them and greet
        // once (throttled). Makes the townsfolk feel aware, not scripted props.
        this._wanderFwd2.subVectors(npcPlayerW, npc.meshRef.position);
        const toPlayerDist = this._wanderFwd2.length();
        let faceFwd: THREE.Vector3 | null = moving ? this._wanderFwd : null;
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
          .multiply(this._wanderYawQ.setFromAxisAngle(GameScene._localUp, w.yaw));
      }

      // Grass wind (GPU-side — just advance the shared uniform)
      this.island.grassTimeUniform.value = time;
    }

    // Sea waves (GPU-side + shared with the CPU swim/boat sampler) + the tide
    this.island.seaTimeUniform.value = time;
    this.island.updateTide(time);
    this.updateVehicles(deltaTime);
    this.races?.update(deltaTime, this.player.getWorldPosition(), this.getActiveVehicleKind());
    this.updateWaterFX(deltaTime);
    this.updateFish(deltaTime, time);
    this.updateFisherman(time, deltaTime);
    this.updateBaker(time, deltaTime);
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
    const camNear = this.camera ? this.camera.position.length() < 45 : true;
    for (const g of this.ambientGroups) g.visible = camNear;

    // Chimney smoke: puffs loop up the normal, growing and fading
    for (const puff of this.smokePuffs) {
      puff.mesh.visible = camNear;
      const ph = (time * 0.22 + puff.offset) % 1;
      puff.mesh.position
        .copy(puff.base)
        .addScaledVector(puff.normal, 0.1 + ph * 1.1);
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
          const ZL2 = 0.4636;
          const anchors = [
            this.island.dirAt(0, ZL2),
            this.island.dirAt(1.2566, ZL2),
            this.island.dirAt(2.5133, ZL2),
            this.island.dirAt(3.7699, ZL2),
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
        c.respawnAt = time + 45;
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
      ff.material.opacity = fireflyGlow * (0.35 + 0.65 * Math.max(0, Math.sin(time * 2.2 + ff.phase * 3)));
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
      p.mesh.position.copy(p.origin).addScaledVector(p.dir, t * 1.6).addScaledVector(p.normal, 0.05 + t * 0.15);
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
      this._swayQuat.setFromAxisAngle(
        GameScene._swayAxis,
        Math.sin(t * 26) * 0.14 * (1 - t / 0.6),
      );
      w.obj.quaternion.copy(w.baseQuat).multiply(this._swayQuat);
    }

    // Quest markers: follow their (wandering) NPC, bob + spin
    for (const m of this.questMarkers) {
      const owner = this.island.npcTargets.find((n) => n.name === m.npcName);
      if (owner) {
        m.base.copy(owner.meshRef.position);
        m.normal.copy(m.base).normalize();
      }
      m.mesh.position
        .copy(m.base)
        .addScaledVector(m.normal, 2.1 + Math.sin(time * 2.4) * 0.12);
      m.mesh.rotateOnWorldAxis(m.normal, deltaTime * 1.8);
    }

    // NPC name pins: follow each (wandering) NPC, sit just above the head,
    // scale with camera distance so they stay legible from afar, and fade
    // out when you're right next to the NPC (so the pin never covers them).
    for (const tag of this.nameTags) {
      const pos = tag.target.position;
      this._tagNormal.copy(pos).normalize();
      tag.sprite.position
        .copy(pos)
        .addScaledVector(this._tagNormal, 1.82 + Math.sin(time * 2 + pos.x) * 0.05);
      const dist = this.camera.position.distanceTo(tag.sprite.position);
      // Constant-ish on-screen size: sprites attenuate ∝1/dist, so scale ∝dist.
      const s = THREE.MathUtils.clamp(dist * 0.055, 1.1, 3.6);
      tag.sprite.scale.set(s * 1.7, s * 0.42, 1);
      // Fade: hidden hugging-close, full through mid range, gone past the horizon
      const op =
        dist < 2.6 ? 0
        : dist < 6 ? (dist - 2.6) / 3.4
        : dist < 62 ? 1
        : dist < 88 ? 1 - (dist - 62) / 26
        : 0;
      const mat = tag.sprite.material as THREE.SpriteMaterial;
      mat.opacity = op;
      tag.sprite.visible = op > 0.02;
    }

    // Drain colliders queued by async GLB placements (e.g. the orchard/
    // forest trees, which finish loading after the registration pass)
    if (this.island.pendingColliders.length > 0) {
      this.colliders.push(...this.island.pendingColliders);
      console.log(`🧱 +${this.island.pendingColliders.length} async prop colliders (total ${this.colliders.length})`);
      this.island.pendingColliders.length = 0;
    }

    // Day/night + weather cycle
    if (this.envCycle) {
      this.envCycle.update(deltaTime, playerPos, time);
    }
    // AFTER the cycle, which owns the sun's direction each frame
    this.updateSunShadow(playerPos);
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

    for (const collider of this.colliders) {
      const dist = playerPos.distanceTo(collider.position);
      const minDist = playerRadius + collider.radius;

      // If player is overlapping with this collider
      if (dist < minDist) {
        // Push player away TANGENTIALLY: a radial component here shoves the
        // player into the terrain (visible as being 'dug in' while walking
        // past props) or launches them off it — grounding owns the radial axis.
        const normal = playerPos.clone().normalize();
        const direction = playerPos.clone().sub(collider.position);
        direction.sub(normal.clone().multiplyScalar(direction.dot(normal)));
        if (direction.lengthSq() < 1e-6) direction.copy(normal.clone().cross(new THREE.Vector3(0, 1, 0.001)));
        direction.normalize();
        const pushDistance = minDist - dist + 0.01; // Small buffer to prevent re-collision
        playerPos.addScaledVector(direction, pushDistance);

        // Update player position
        this.player.setWorldPosition(playerPos);
        this.player.updateWorldMatrix();
      }
    }
  }

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
    | null {
    if (!this.player) return null;

    const playerPos = this.player.getWorldPosition();

    // Check if player has moved far enough to invalidate cache
    if (this.cachedNearby && playerPos.distanceTo(this.lastPlayerPos) < this.cacheDistanceThreshold) {
      return this.cachedNearby;
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

    // Check zones
    const nearbyZone = this.zonesManager.getNearbyZone(playerPos, this.interactionRange);
    if (nearbyZone && nearbyZone.distance < nearestDist) {
      nearest = { type: 'zone' as const, zone: nearbyZone.zone, distance: nearbyZone.distance };
      nearestDist = nearbyZone.distance;
    }

    // Check NPCs
    for (const npc of this.island.npcTargets) {
      const d = npc.meshRef.getWorldPosition(new THREE.Vector3()).distanceTo(playerPos);
      if (d < nearestDist) {
        nearest = { type: 'npc' as const, npcData: { name: npc.name, dialogue: npc.dialogue }, distance: d };
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
    const ZL = 0.4636;
    return {
      heading,
      npcs: this.island.npcTargets.map((n) => ({
        ...this.worldToRadar(n.meshRef.position),
        hasQuest: questNames.has(n.name),
      })),
      // Labels are short by necessity — the radar disc is only 172px, so
      // anything longer than ~8 characters collides with its neighbours.
      zones: [
        { ...this.worldToRadar(this.island.dirAt(0, ZL)), color: '#2196F3', label: 'Work' },
        { ...this.worldToRadar(this.island.dirAt(1.2566, ZL)), color: '#FF9800', label: 'Projects' },
        { ...this.worldToRadar(this.island.dirAt(2.5133, ZL)), color: '#E91E63', label: 'Life' },
        { ...this.worldToRadar(this.island.dirAt(3.7699, ZL)), color: '#9C27B0', label: 'Contact' },
        { ...this.worldToRadar(new THREE.Vector3(0, 1, 0)), color: '#4CAF50', label: 'Hub' },
      ],
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
      | { type: 'bench'; benchGroup: THREE.Object3D; distance: number },
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

  private onNPCInteractCallback: ((npcData: { name: string; dialogue: string[] }) => void) | null = null;

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

  /**
   * Set player movement input (camera-relative)
   */
  public setPlayerMovement(forward: number, strafe: number): void {
    if (this.player && this.orbitCamera) {
      // getForwardDirection/getRightDirection are already projected onto the tangent plane
      const cameraForward = this.orbitCamera.getForwardDirection();
      const cameraRight = this.orbitCamera.getRightDirection();

      // Build world-space movement direction from camera orientation
      const moveDir = new THREE.Vector3();
      moveDir.addScaledVector(cameraForward, forward);
      moveDir.addScaledVector(cameraRight, strafe);

      // Full 3D vector — tangent directions have a Y component on a sphere
      this.player.setMovementVector(moveDir);

      // Rotate player to face movement direction. Yaw is defined around the
      // surface normal, so express moveDir in the player's tangent frame first.
      if (moveDir.length() > 0.01) {
        const normal = this.player.getSurfaceNormal();
        const alignQuat = new THREE.Quaternion().setFromUnitVectors(
          new THREE.Vector3(0, 1, 0),
          normal,
        );
        const local = moveDir.clone().applyQuaternion(alignQuat.clone().invert());
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

    // Dispose island resources
    if (this.island && this.island.mesh) {
      this.island.mesh.geometry.dispose();
      if (Array.isArray(this.island.mesh.material)) {
        this.island.mesh.material.forEach(mat => mat.dispose());
      } else {
        this.island.mesh.material.dispose();
      }
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
