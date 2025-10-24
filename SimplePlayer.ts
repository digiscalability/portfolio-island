import * as THREE from 'three';

import { Materials } from './Materials';
import { loadGLTFWithFallbacks, setupModelAnimation } from './utils/GLTFModelLoader';

/**
 * SimplePlayer
 *
 * A simplified player controller for flat ground
 * Features:
 * - Simple position and velocity
 * - Gravity and ground sticking (flat floor)
 * - WASD/arrow key movement
 * - Spacebar jump
 */
export class SimplePlayer extends THREE.Group {
  private mesh: THREE.Group;
  private playerPosition: THREE.Vector3 = new THREE.Vector3(0, 0.7, 0);
  private velocity: THREE.Vector3 = new THREE.Vector3();
  private acceleration: THREE.Vector3 = new THREE.Vector3();

  private yaw: number = 0; // rotation around Y axis

  private speed: number = 18; // movement speed (faster)
  private jumpForce: number = 8;
  private gravityStrength: number = 25; // gravitational acceleration

  private isGrounded: boolean = false;
  private groundLevel: number = 0; // Y position of ground

  private moveInput: THREE.Vector3 = new THREE.Vector3(); // (x=strafe, y=unused, z=forward)
  private wantJump: boolean = false;

  // GLTF model support
  private gltfModel: THREE.Group | null = null;
  private animationMixer: THREE.AnimationMixer | null = null;

  constructor() {
    super();
    this.name = 'SimplePlayer';

    // Create a simple capsule mesh (cylinder + spheres for head/feet)
    const group = new THREE.Group();

    // Body (cylinder) - vibrant blue like messenger.abeto.co
    const bodyGeo = new THREE.CylinderGeometry(0.4, 0.35, 1.4, 8);
    const bodyMat = Materials.createToonMaterial(0x4a90e2); // Vibrant blue
    const body = new THREE.Mesh(bodyGeo, bodyMat);
    body.castShadow = true;
    body.receiveShadow = true;
    group.add(body);

    // Head (sphere) - warm skin tone
    const headGeo = new THREE.SphereGeometry(0.3, 12, 12);
    const headMat = Materials.createToonMaterial(0xffddaa); // Warm peachy color
    const head = new THREE.Mesh(headGeo, headMat);
    head.position.y = 1.0;
    head.castShadow = true;
    head.receiveShadow = true;
    group.add(head);

    // Eyes - simple black spheres for charm
    const eyeGeo = new THREE.SphereGeometry(0.06, 6, 6);
    const eyeMat = Materials.createToonMaterial(0x1a1a1a); // Dark eyes

    const leftEye = new THREE.Mesh(eyeGeo, eyeMat);
    leftEye.position.set(-0.1, 1.05, 0.2);
    group.add(leftEye);

    const rightEye = new THREE.Mesh(eyeGeo, eyeMat);
    rightEye.position.set(0.1, 1.05, 0.2);
    group.add(rightEye);

    this.mesh = group;
    this.add(this.mesh);

    // Start at center with player height above ground
    this.playerPosition.set(0, 0.7, 0);
    this.isGrounded = true;
    this.updateWorldMatrix();

    // Try to load GLTF character model asynchronously
    this.loadGLTFCharacter();
  }

  /**
   * Attempt to load GLTF character model (async, non-blocking)
   */
  private async loadGLTFCharacter(): Promise<void> {
    try {
      console.log('🎭 Loading GLTF character model...');

      const gltfResult = await loadGLTFWithFallbacks('/assets/models/player.gltf', {
        candidates: [
          '/assets/models/Superhero_Male.gltf',
          '/assets/models/Superhero_Female.gltf',
          '/assetKits/Universal Base Characters[Standard]/Base Characters/Unreal Engine/Superhero_Male.gltf',
          '/assetKits/Universal Base Characters[Standard]/Base Characters/Unreal Engine/Superhero_Female.gltf',
          '/assetKits/Universal Base Characters[Standard]/glTF/Superhero_Male.gltf',
          '/assetKits/Universal Base Characters[Standard]/glTF/Superhero_Female.gltf',
        ],
        scale: 0.8, // Scale to appropriate size for the scene
        overrides: {
          envMapIntensity: 0.7,
          roughnessScale: 1.0,
        },
      });

      if (gltfResult) {
        // Remove the simple mesh
        this.remove(this.mesh);

        // Add the GLTF model
        this.gltfModel = gltfResult.scene;
        this.add(this.gltfModel);

        // Setup animations
        this.animationMixer = setupModelAnimation(gltfResult.scene, gltfResult.animations, 'idle');

        // Enable shadows
        this.gltfModel.traverse((obj) => {
          if (obj instanceof THREE.Mesh) {
            obj.castShadow = true;
            obj.receiveShadow = true;
          }
        });

        console.log(`✅ Loaded GLTF character from: ${gltfResult.loadedUrl}`);
      }
    } catch (error) {
      console.warn('⚠️ Failed to load GLTF character, keeping simple mesh:', error);
      // Keep the simple mesh if GLTF loading fails
    }
  }

  /**
   * Update player physics and position
   */
  public update(deltaTime: number): void {
    if (deltaTime <= 0) return;

    // Clamp delta time to prevent large jumps
    const safeDeltaTime = Math.max(0, Math.min(deltaTime, 0.02));

    // Apply gravity
    this.acceleration.set(0, -this.gravityStrength, 0);
    this.velocity.addScaledVector(this.acceleration, safeDeltaTime);

    // Clamp velocity to prevent infinite speeds
    const maxVelocity = 50;
    if (this.velocity.length() > maxVelocity) {
      this.velocity.normalize().multiplyScalar(maxVelocity);
    }

    // Apply movement input or stop immediately if no input
    if (this.moveInput && this.moveInput.length() > 0.01) {
      this.applyMovement(safeDeltaTime);
    } else {
      // No input: stop immediately with zero inertia
      this.stopMovement();
    }

    // Integrate position
    this.playerPosition.addScaledVector(this.velocity, safeDeltaTime);

    // Clamp player position to reasonable bounds
    const maxBounds = 500;
    this.playerPosition.x = Math.max(-maxBounds, Math.min(maxBounds, this.playerPosition.x));
    this.playerPosition.z = Math.max(-maxBounds, Math.min(maxBounds, this.playerPosition.z));

    // Ground detection and sticking
    this.updateGroundState();

    // Handle jump
    if (this.wantJump && this.isGrounded) {
      this.velocity.y = this.jumpForce;
      this.isGrounded = false;
      this.wantJump = false;
    }

    // Update GLTF animations
    if (this.animationMixer) {
      this.animationMixer.update(safeDeltaTime);
    }

    // Update mesh position
    this.updateWorldMatrix();
  }

  /**
   * Check ground state and apply ground sticking
   */
  private updateGroundState(): void {
    const playerHeight = 0.7; // distance from ground to player center

    if (this.playerPosition.y <= this.groundLevel + playerHeight) {
      if (!this.isGrounded) {
        // Just landed
        this.isGrounded = true;
        this.velocity.y = 0; // Kill velocity
      }

      // Stick to ground
      this.playerPosition.y = this.groundLevel + playerHeight;
    } else {
      this.isGrounded = false;
    }
  }

  /**
   * Apply movement input (input already in world space from GameScene)
   */
  private applyMovement(_deltaTime: number): void {
    // If no input, stop immediately
    if (!this.moveInput || this.moveInput.length() === 0) {
      this.velocity.x = 0;
      this.velocity.z = 0;
      return;
    }

    // Safety check: ensure move input is finite
    if (!Number.isFinite(this.moveInput.x) || !Number.isFinite(this.moveInput.z)) {
      this.velocity.x = 0;
      this.velocity.z = 0;
      return;
    }

    // moveInput is already in world space (from GameScene.setPlayerMovement)
    // Just apply speed smoothly for better feel
    const moveDir = this.moveInput.clone();

    // Normalize safely
    const moveLength = moveDir.length();
    if (moveLength > 0.01) {
      moveDir.normalize();
    } else {
      this.velocity.x = 0;
      this.velocity.z = 0;
      return;
    }

    // Target horizontal velocity
    const targetVX = moveDir.x * this.speed;
    const targetVZ = moveDir.z * this.speed;

    // Smooth acceleration towards target (instant stop handled elsewhere)
    const accelRate = 12; // units per second to blend towards target
    const t = Math.min(1, accelRate * Math.max(0.001, _deltaTime));
    this.velocity.x = THREE.MathUtils.lerp(this.velocity.x, targetVX, t);
    this.velocity.z = THREE.MathUtils.lerp(this.velocity.z, targetVZ, t);
  }

  /**
   * Stop movement immediately
   */
  private stopMovement(): void {
    this.velocity.x = 0;
    this.velocity.z = 0;
    this.moveInput.set(0, 0, 0);
  }

  /**
   * Set movement input (-1 to 1)
   */
  public setMovement(forward: number, strafe: number): void {
    this.moveInput.set(strafe, 0, forward);
    this.moveInput.clampLength(0, 1);
  }

  /**
   * Request jump
   */
  public jump(): void {
    if (this.isGrounded) {
      this.wantJump = true;
    }
  }

  /**
   * Set player rotation (yaw)
   */
  public setRotation(yaw: number, _pitch?: number): void {
    this.yaw = yaw;
  }

  /**
   * Get player world position
   */
  public getWorldPosition(): THREE.Vector3 {
    return this.playerPosition.clone();
  }

  /**
   * Set player world position (for collision resolution)
   */
  public setWorldPosition(position: THREE.Vector3): void {
    this.playerPosition.copy(position);
  }

  /**
   * Get player forward direction
   */
  public getForwardDirection(): THREE.Vector3 {
    return new THREE.Vector3(0, 0, -1).applyAxisAngle(new THREE.Vector3(0, 1, 0), this.yaw);
  }

  /**
   * Get player yaw rotation
   */
  public getYaw(): number {
    return this.yaw;
  }

  /**
   * Check if player is grounded
   */
  public getIsGrounded(): boolean {
    return this.isGrounded;
  }

  /**
   * Update world matrix from position
   */
  public updateWorldMatrix(): void {
    this.position.copy(this.playerPosition);
    this.rotation.order = 'YXZ';
    this.rotation.y = this.yaw;
    this.rotation.x = 0;
    this.updateMatrix();
    this.updateMatrixWorld(true);
  }

  /**
   * Dispose resources
   */
  public dispose(): void {
    // Dispose animation mixer
    if (this.animationMixer) {
      try {
        this.animationMixer.stopAllAction();
      } catch {
        // Ignore cleanup issues
      }
      this.animationMixer = null;
    }

    this.traverse((obj: THREE.Object3D) => {
      if (obj instanceof THREE.Mesh) {
        if (obj.geometry) obj.geometry.dispose();
        if (obj.material) {
          if (Array.isArray(obj.material)) {
            obj.material.forEach((m: THREE.Material) => m.dispose());
          } else {
            obj.material.dispose();
          }
        }
      }
    });
  }
}
