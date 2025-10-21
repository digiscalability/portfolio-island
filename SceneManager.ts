import * as THREE from 'three';
import { Environment } from './Environment';
import { Lighting } from './Lighting';

export class SceneManager {
  public scene: THREE.Scene;
  public camera: THREE.PerspectiveCamera;
  public lighting: Lighting;
  public environment: Environment;

  constructor() {
    // Create scene
    this.scene = new THREE.Scene();

    // Setup fog (will be dynamically updated by environment system)
    this.scene.fog = new THREE.Fog(0x87ceeb, 50, 200);

    // Create camera
    this.camera = new THREE.PerspectiveCamera(
      60,
      window.innerWidth / window.innerHeight,
      0.1,
      1000
    );
    this.camera.position.set(0, 10, 30);

    // Setup lighting
    this.lighting = new Lighting(this.scene);

    // Setup environment (sky, clouds, sun, moon, stars, day/night cycle)
    this.environment = new Environment(this.scene, this.lighting.directionalLight);

    // Handle window resize
    window.addEventListener('resize', () => this.onResize());
  }

  private onResize(): void {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
  }

  public update(deltaTime: number): void {
    this.lighting.update(deltaTime);
    this.environment.update(deltaTime);
  }

  public getScene(): THREE.Scene {
    return this.scene;
  }

  public getCamera(): THREE.PerspectiveCamera {
    return this.camera;
  }
}

