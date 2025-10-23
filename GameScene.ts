import type { Material, Object3D } from 'three';
import * as THREE from 'three';

import { OrbitCamera } from './OrbitCamera';
import { SimplePlanet } from './SimplePlanet';
import { SimplePlayer } from './SimplePlayer';

/**
 * GameScene
 *
 * Unified scene composition replacing SceneManager and complex hierarchies
 * Follows Messenger's simple scene pattern with ready state promise
 *
 * Manages:
 * - 3D scene graph (planet, player, lights, sky)
 * - Camera setup
 * - Lighting configuration
 * - Ready state for async initialization
 */
export class GameScene extends THREE.Scene {
  private planet!: SimplePlanet;
  private player!: SimplePlayer;
  private camera!: THREE.PerspectiveCamera;
  private orbitCamera!: OrbitCamera;
  private elapsedTime: number = 0;

  private lights: {
    sun?: THREE.DirectionalLight;
    ambient?: THREE.AmbientLight;
    skyLight?: THREE.Light;
  } = {};

  // Ready state (like Messenger)
  private readyPromise: Promise<void>;
  private readyResolve!: () => void;

  constructor() {
    super();
    this.name = 'GameScene';
    this.background = new THREE.Color(0x87ceeb); // Sky blue
    this.fog = new THREE.Fog(0x87ceeb, 80, 200);

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
    // Create camera
    this.camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 500);

    // Create planet
    this.planet = new SimplePlanet(18);
    this.add(this.planet);
    await this.planet.ready();

    // Create player above planet
    this.player = new SimplePlayer(this.planet, new THREE.Vector3(0, 22, 0));
    this.add(this.player);

    // Setup lights
    this.setupLighting();

    // Create orbit camera
    this.orbitCamera = new OrbitCamera(this.camera, this.player);

    // Handle window resize
    window.addEventListener('resize', () => this.onWindowResize());

    // Mark as ready
    this.readyResolve();
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

    // Setup shadow properties
    sunLight.shadow.mapSize.width = 2048;
    sunLight.shadow.mapSize.height = 2048;
    sunLight.shadow.camera.near = 0.1;
    sunLight.shadow.camera.far = 100;
    sunLight.shadow.camera.left = -50;
    sunLight.shadow.camera.right = 50;
    sunLight.shadow.camera.top = 50;
    sunLight.shadow.camera.bottom = -50;

    this.add(sunLight);
    this.lights.sun = sunLight;

    // Hemisphere light for natural gradual lighting
    const hemiLight = new THREE.HemisphereLight(0x87ceeb, 0x2d5016, 0.6);
    this.add(hemiLight);
  }

  /**
   * Update scene (call from render loop)
   */
  public update(deltaTime: number): void {
    if (!this.player) return;
    if (deltaTime <= 0) return;

    this.elapsedTime += deltaTime;

    if (this.orbitCamera) {
      this.player.setCameraFrame(
        this.orbitCamera.getForwardDirection(),
        this.orbitCamera.getRightDirection(),
      );
    }

    // Update player physics
    this.player.update(deltaTime);

    // Update camera
    if (this.orbitCamera) {
      this.orbitCamera.update(deltaTime);
    }
  }

  /**
   * Get the ready state promise
   */
  public async ready(): Promise<void> {
    return this.readyPromise;
  }

  /**
   * Get planet instance
   */
  public getPlanet(): SimplePlanet {
    return this.planet;
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
   * Get total elapsed simulation time
   */
  public getElapsedTime(): number {
    return this.elapsedTime;
  }

  /**
   * Set player movement input
   */
  public setPlayerMovement(forward: number, strafe: number): void {
    if (this.player) {
      const cameraForward = this.orbitCamera?.getForwardDirection();
      const cameraRight = this.orbitCamera?.getRightDirection();
      this.player.setMovement(forward, strafe, cameraForward, cameraRight);
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
    if (this.planet) {
      this.planet.dispose();
    }
    if (this.player) {
      this.player.dispose();
    }

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
