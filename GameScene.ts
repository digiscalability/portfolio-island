import * as THREE from 'three';

import { EnvironmentCycle } from './EnvironmentCycle';
import { Island } from './Island';
import { Mailbox } from './Mailbox';
import { Materials } from './Materials';
import { OrbitCamera } from './OrbitCamera';
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
   * Initialize scene components
   */
  private async initialize(): Promise<void> {
    // Create camera with extended far plane
    this.camera = new THREE.PerspectiveCamera(
      60,
      window.innerWidth / window.innerHeight,
      0.1,
      2000,
    );

    // Create spherical island
    this.island = new Island(18); // 18 unit radius like Messenger
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
    this.createChimneySmoke();

    // Navigation + traversal rewards
    this.createGuideSparkles();
    this.createCoins();

    // Create player on island surface with spherical physics
    this.player = new SimplePlayer();
    this.player.setPlanet(new THREE.Vector3(0, 0, 0), this.island.getRadius());
    // Ground the player on the actual displaced terrain, not the ideal sphere
    this.player.setGroundSampler((outwardDir) => {
      const sampled = this.island.sampleSurfaceByDirection(outwardDir, 0);
      return sampled.position.length();
    });
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

    // Mark as ready
    this.readyResolve();
  }

  /**
   * Setup lighting for the scene
   */
  private setupLighting(): void {
    // Ambient light for base illumination
    const ambientLight = new THREE.AmbientLight(0xfff6e8, 0.4); // was washing out material colors
    this.add(ambientLight);
    this.lights.ambient = ambientLight;

    // Directional light (warm sun)
    const sunLight = new THREE.DirectionalLight(0xfff1d6, 1.35);
    sunLight.position.set(30, 40, 30);
    sunLight.castShadow = true;

    // Setup shadow properties (optimized for performance)
    sunLight.shadow.mapSize.width = 2048;
    sunLight.shadow.mapSize.height = 2048;
    sunLight.shadow.camera.near = 0.1;
    sunLight.shadow.camera.far = 100;
    sunLight.shadow.camera.left = -50;
    sunLight.shadow.camera.right = 50;
    sunLight.shadow.camera.top = 50;
    sunLight.shadow.camera.bottom = -50;
    sunLight.shadow.bias = -0.0001;

    this.add(sunLight);
    this.lights.sun = sunLight;

    // Hemisphere light for natural gradual lighting (sky blue / warm ground).
    // Intensity lifted for the toon ramp — its stepped shading crushes
    // unlit undersides (tree canopies) to near-black without ambient fill.
    const hemiLight = new THREE.HemisphereLight(0xbfe3ff, 0x4a6b32, 0.85);
    this.add(hemiLight);
    this.hemiLight = hemiLight;

    // Soft fill light from below-opposite to reduce harsh shadows on planet's far side
    const fillLight = new THREE.DirectionalLight(0xd4e8ff, 0.25);
    fillLight.position.set(-20, -30, -20);
    this.add(fillLight);

    // Sky dome — gradient sphere that moves with the camera
    this.createSkyDome();

    // Puffy clouds drifting around the planet
    this.createClouds();

    // A few birds circling below the clouds
    this.createBirds();
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
      // already the model's forward (beak at -Z) — no extra yaw needed
      bird.position.set(planetR + 3 + Math.random() * 2.5, 0, 0);
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
      const blobCount = 3 + Math.floor(Math.random() * 3);
      for (let b = 0; b < blobCount; b++) {
        const r = 0.7 + Math.random() * 0.9;
        const blob = new THREE.Mesh(new THREE.DodecahedronGeometry(r, 0), cloudMat);
        blob.position.set(b * 1.1 - (blobCount - 1) * 0.55, (Math.random() - 0.5) * 0.4, (Math.random() - 0.5) * 0.8);
        blob.scale.y = 0.55;
        blob.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, 0);
        blob.castShadow = true;
        cloud.add(blob);
      }
      cloud.position.set(planetR + 6 + Math.random() * 4, 0, 0);
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
   * Spinning collectible coins scattered across the open meadows —
   * traversal rewards between districts (A Short Hike-style). Collected
   * on touch with a chime; each respawns after 45 seconds.
   */
  private createCoins(): void {
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
          y + (Math.random() - 0.5) * 0.2,
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
        exponent: { value: 0.5 },
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

    // Spread quest mailboxes across latitudes so the delivery chain sends the
    // player exploring the whole planet, not one band.
    const MAILBOX_LATS = [0.55, -0.45, 0.15, -0.2, 0.35, -0.6];
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

    // Replace colliders with sphere-surface positions (TownPlanner placed them at Y=0)
    this.colliders = [
      ...result.mailboxes.map((m) => ({ position: m.mesh.position.clone(), radius: 1 })),
      ...result.lamps.map((l) => ({ position: l.group.position.clone(), radius: 0.5 })),
      ...result.houses.map((h) => ({ position: h.mesh.position.clone(), radius: 1.6 })),
    ];
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

    // Trees: gentle sway around their surface-aligned base orientation
    for (const tr of this.swayTrees) {
      this._swayQuat.setFromAxisAngle(
        GameScene._swayAxis,
        Math.sin(time * 1.1 + tr.phase) * 0.018,
      );
      tr.group.quaternion.copy(tr.baseQuat).multiply(this._swayQuat);
    }

    // NPCs: subtle idle bob along their surface normal
    if (this.island) {
      for (let i = 0; i < this.island.npcTargets.length; i++) {
        const npc = this.island.npcTargets[i];
        const data = npc.meshRef.userData as { bobBase?: THREE.Vector3 };
        if (!data.bobBase) data.bobBase = npc.meshRef.position.clone();
        this._npcNormal.copy(data.bobBase).normalize();
        npc.meshRef.position
          .copy(data.bobBase)
          .addScaledVector(this._npcNormal, (Math.sin(time * 2 + i * 1.7) + 1) * 0.015);
      }

      // Grass wind (GPU-side — just advance the shared uniform)
      this.island.grassTimeUniform.value = time;
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

    // Chimney smoke: puffs loop up the normal, growing and fading
    for (const puff of this.smokePuffs) {
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
          s.visible = true;
        }
      }
    }
    if (!guideVisible) {
      for (const s of this.guideSparkles) s.visible = false;
    }

    // Coins: spin in place, collect on touch, respawn after 45s
    for (const c of this.coins) {
      if (!c.mesh.visible) {
        if (c.respawnAt > 0 && time > c.respawnAt) {
          c.mesh.visible = true;
          c.respawnAt = 0;
        }
        continue;
      }
      this._npcNormal.copy(c.mesh.position).normalize();
      c.mesh.rotateOnWorldAxis(this._npcNormal, deltaTime * 2.5);
      if (c.mesh.position.distanceToSquared(playerPos) < 0.9) {
        c.mesh.visible = false;
        c.respawnAt = time + 45;
        sfx.coin();
      }
    }

    // Keep the sky gradient oriented to the camera's local "up" so the
    // mood doesn't shift as the player circumnavigates
    if (this.skyUpUniform && this.camera) {
      this.skyUpUniform.value.copy(this.camera.position).normalize();
    }

    // Day/night + weather cycle
    if (this.envCycle) {
      this.envCycle.update(deltaTime, playerPos, time);
    }
  }

  public getEnvironmentCycle(): EnvironmentCycle | null {
    return this.envCycle;
  }

  /**
   * Check and resolve player collisions with assets
   */
  private checkPlayerCollisions(): void {
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
  public interactWith(
    interactable:
      | { type: 'mailbox'; mailbox: Mailbox; distance: number }
      | { type: 'lamp'; lamp: TownPlanResult['lamps'][number]; distance: number }
      | { type: 'zone'; zone: any; distance: number }
      | { type: 'npc'; npcData: { name: string; dialogue: string[] }; distance: number },
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

    if (interactable.type === 'npc') {
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
