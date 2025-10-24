import type { Material, Object3D } from 'three';
import * as THREE from 'three';

import { Mailbox } from './Mailbox';
import { Materials } from './Materials';
import { OrbitCamera } from './OrbitCamera';
import { SimplePlayer } from './SimplePlayer';
import { TownPlanner, type TownPlanResult } from './TownPlanner';

/**
 * GameScene
 *
 * Simple flat-ground scene composition
 * Manages:
 * - Flat floor/ground plane
 * - Player movement and physics
 * - Houses, trees, mailboxes as decorative assets
 * - Camera and lighting
 */
export class GameScene extends THREE.Scene {
  private ground!: THREE.Mesh;
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

  // Generic interactable query distance
  private interactionRange: number = 2.5;

  // Ready state
  private readyPromise: Promise<void>;
  private readyResolve!: () => void;

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

    // Create ground floor
    this.createGround();

    // Create player on floor
    this.player = new SimplePlayer();
    this.add(this.player);

    // Setup lights
    this.setupLighting();

    // Create orbit camera
    this.orbitCamera = new OrbitCamera(this.camera, this.player);

    // Place decorative assets via TownPlanner
    await this.placeAssets();

    // Handle window resize
    window.addEventListener('resize', () => this.onWindowResize());

    // Debug scene state
    console.log('🏠 GameScene initialized (flat ground):', {
      children: this.children.length,
      ground: { position: this.ground.position },
      player: { position: this.player.position },
      camera: { position: this.camera.position },
    });

    // Mark as ready
    this.readyResolve();
  }

  /**
   * Create a flat ground plane
   */
  private createGround(): void {
    const groundGeo = new THREE.PlaneGeometry(200, 200);
    const groundMat = Materials.createToonMaterial(0x4a9b5c); // Green grass color

    this.ground = new THREE.Mesh(groundGeo, groundMat);
    this.ground.rotation.x = -Math.PI / 2; // Rotate to be horizontal
    this.ground.receiveShadow = true;
    this.ground.name = 'Ground';
    this.ground.userData.type = 'ground'; // For raycasting

    this.add(this.ground);
  }

  /**
   * Setup lighting for the scene
   */
  private setupLighting(): void {
    // Ambient light for base illumination
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
    this.add(ambientLight);
    this.lights.ambient = ambientLight;

    // Directional light (sun)
    const sunLight = new THREE.DirectionalLight(0xffffff, 1.2);
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

    // Hemisphere light for natural gradual lighting
    const hemiLight = new THREE.HemisphereLight(0x87ceeb, 0x2d5016, 0.6);
    this.add(hemiLight);
  }

  /**
   * Place decorative assets on the ground
   */
  private async placeAssets(): Promise<void> {
    const planner = new TownPlanner(this);
    const result = await planner.generate({
      size: 200,
      roadSpacing: 40,
      roadWidth: 6,
      blockInset: 4,
      treesPerBlock: [2, 6],
    });

    // Record colliders and interactables
    this.colliders.push(...result.colliders);
    this.mailboxes = result.mailboxes;
    this.lamps = result.lamps;

    console.log('🏙️ Town generated:', {
      colliders: this.colliders.length,
      mailboxes: this.mailboxes.length,
      lamps: this.lamps.length,
    });
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
   */
  public getNearbyInteractable():
    | { type: 'mailbox'; mailbox: Mailbox; distance: number }
    | { type: 'lamp'; lamp: TownPlanResult['lamps'][number]; distance: number }
    | null {
    if (!this.player) return null;

    const playerPos = this.player.getWorldPosition();
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

    return nearest;
  }

  /**
   * Interact with a mailbox (open/collect delivery)
   */
  public interactWithMailbox(mailbox: Mailbox): void {
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
      | { type: 'lamp'; lamp: TownPlanResult['lamps'][number]; distance: number },
  ): void {
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
      // Get camera's forward and right directions (projected onto ground plane)
      const cameraForward = this.orbitCamera.getForwardDirection();
      const cameraRight = this.orbitCamera.getRightDirection();

      // Project onto XZ plane (ignore Y component for ground-level movement)
      cameraForward.y = 0;
      cameraRight.y = 0;
      cameraForward.normalize();
      cameraRight.normalize();

      // Build world-space movement direction from camera orientation
      const moveDir = new THREE.Vector3();
      moveDir.addScaledVector(cameraForward, forward);
      moveDir.addScaledVector(cameraRight, strafe);

      // Pass the world-space movement direction directly
      // setMovement expects (forward, strafe) but we pass normalized world direction
      this.player.setMovement(moveDir.z, moveDir.x);

      // Rotate player to face movement direction
      if (moveDir.length() > 0.01) {
        const targetYaw = Math.atan2(moveDir.x, moveDir.z);
        this.player.setRotation(targetYaw);
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
   * Get ground mesh
   */
  public getGround(): THREE.Mesh {
    return this.ground;
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
    if (this.ground) {
      (this.ground.geometry as THREE.BufferGeometry).dispose();
      ((this.ground.material as THREE.Material) || this.ground.material).dispose();
    }
    if (this.player) {
      this.player.dispose();
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
    this.traverse((obj: Object3D) => {
      const geometry = (obj as { geometry?: THREE.BufferGeometry }).geometry;
      geometry?.dispose?.();

      const material = (obj as { material?: Material | Material[] }).material;
      if (Array.isArray(material)) {
        material.forEach((mat) => mat.dispose());
      } else {
        material?.dispose?.();
      }
    });
  }
}
