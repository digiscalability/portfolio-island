import * as THREE from 'three';

import { Island } from './Island';
import { OrbitCamera } from './OrbitCamera';
import { SimplePlayer } from './SimplePlayer';
import { TownPlanner, type TownPlanResult } from './TownPlanner';
import { ZonesManager } from './ZonesManager';
import { Mailbox } from './Mailbox';
import { loadGLTFWithFallbacks } from './utils/GLTFModelLoader';

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
    this.background = new THREE.Color(0x87ceeb); // Sky blue
    this.fog = new THREE.Fog(0x87ceeb, 500, 1000); // Extended fog for visibility

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

    // Create orbit camera (with terrain collision so hills don't block the view)
    this.orbitCamera = new OrbitCamera(this.camera, this.player);
    this.orbitCamera.setCollisionMesh(this.island.getSurfaceMesh());

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
    const ambientLight = new THREE.AmbientLight(0xfff6e8, 0.55);
    this.add(ambientLight);
    this.lights.ambient = ambientLight;

    // Directional light (warm sun)
    const sunLight = new THREE.DirectionalLight(0xfff1d6, 1.35);
    sunLight.position.set(30, 40, 30);
    sunLight.castShadow = true;

    // Setup shadow properties (optimized for performance)
    sunLight.shadow.mapSize.width = 1024;
    sunLight.shadow.mapSize.height = 1024;
    sunLight.shadow.camera.near = 0.1;
    sunLight.shadow.camera.far = 100;
    sunLight.shadow.camera.left = -50;
    sunLight.shadow.camera.right = 50;
    sunLight.shadow.camera.top = 50;
    sunLight.shadow.camera.bottom = -50;
    sunLight.shadow.bias = -0.0001;

    this.add(sunLight);
    this.lights.sun = sunLight;

    // Hemisphere light for natural gradual lighting (sky blue / warm ground)
    const hemiLight = new THREE.HemisphereLight(0xbfe3ff, 0x4a6b32, 0.8);
    this.add(hemiLight);
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
    ) => {
      const R = this.island.getRadius() + radiusOffset;
      const cosLat = Math.cos(latitude);
      const pos = new THREE.Vector3(
        Math.cos(angle) * R * cosLat,
        Math.sin(latitude) * R,
        Math.sin(angle) * R * cosLat,
      );
      mesh.position.copy(pos);
      // Align asset's +Y with outward surface normal
      const outward = pos.clone().normalize();
      mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), outward);
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
      placeOnSphere(mailbox.mesh, angle, lat, 0.5);
    });

    result.lamps.forEach((lamp, index) => {
      const angle =
        (index / Math.max(result.lamps.length, 1)) * Math.PI * 2 +
        Math.PI / Math.max(result.lamps.length, 1);
      placeOnSphere(lamp.group, angle, -0.1, 0.3); // slight south latitude
    });

    // Houses: TownPlanner lays them out on a flat grid, which floats them far off
    // an r≈18 sphere. Re-project each onto the surface at spread angles/latitudes.
    const HOUSE_LATS = [0.45, -0.5, 0.2, -0.3];
    result.houses.forEach((house, index) => {
      const angle = index * 2.399963 + Math.PI / 5;
      placeOnSphere(house.mesh, angle, HOUSE_LATS[index % HOUSE_LATS.length], 0);
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

    const placeOnSphere = (obj: THREE.Object3D, angle: number, latitude: number) => {
      const R = this.island.getRadius();
      const cosLat = Math.cos(latitude);
      const pos = new THREE.Vector3(
        Math.cos(angle) * R * cosLat,
        Math.sin(latitude) * R,
        Math.sin(angle) * R * cosLat,
      );
      obj.position.copy(pos);
      obj.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), pos.clone().normalize());
      obj.rotateY(Math.random() * Math.PI * 2); // random yaw around the surface normal
    };

    const enableShadows = (root: THREE.Object3D) =>
      root.traverse((c) => {
        if ((c as THREE.Mesh).isMesh) {
          c.castShadow = true;
          c.receiveShadow = true;
        }
      });

    let treeCount = 0;
    let rockCount = 0;

    const tree = await loadGLTFWithFallbacks('/assets/models/tree.glb');
    if (tree) {
      const N = 14;
      for (let i = 0; i < N; i++) {
        const inst = tree.scene.clone(true);
        // keep a band around the equator so props don't clash with the north-pole spawn
        placeOnSphere(inst, i * GOLDEN, Math.random() * 1.4 - 0.7);
        inst.scale.multiplyScalar(0.8 + Math.random() * 0.5);
        enableShadows(inst);
        this.add(inst);
        this.colliders.push({ position: inst.position.clone(), radius: 0.6 });
        treeCount++;
      }
    }

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

    console.log('🌲 Scattered Blender toon props:', { trees: treeCount, rocks: rockCount });
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
        // Push player away from collider
        const direction = playerPos.clone().sub(collider.position).normalize();
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
      | { type: 'zone'; zone: any; distance: number },
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
