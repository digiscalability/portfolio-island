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

  private speed: number = 5.5; // movement speed (~20s to cross the island — was 18, which circled the planet in 6s)
  private jumpForce: number = 8;
  private gravityStrength: number = 25; // gravitational acceleration

  private isGrounded: boolean = false;
  private groundLevel: number = 0; // Y position of ground (flat mode only)

  // Spherical planet physics
  private planetCenter: THREE.Vector3 = new THREE.Vector3(0, 0, 0);
  private planetRadius: number = 0; // 0 = flat ground mode

  // Optional terrain sampler: given the outward unit direction, returns the
  // distance from planet center to the actual (displaced) terrain surface.
  // Without it, grounding falls back to the ideal sphere radius.
  private groundSampler: ((outwardDir: THREE.Vector3) => number) | null = null;

  private moveInput: THREE.Vector3 = new THREE.Vector3(); // (x=strafe, y=unused, z=forward)
  private wantJump: boolean = false;

  // GLTF model support
  private gltfModel: THREE.Group | null = null;
  private animationMixer: THREE.AnimationMixer | null = null;
  private idleAction: THREE.AnimationAction | null = null;
  private walkAction: THREE.AnimationAction | null = null;

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
   * Set spherical planet for physics. Call from GameScene after construction.
   */
  public setPlanet(center: THREE.Vector3, radius: number): void {
    this.planetCenter = center.clone();
    this.planetRadius = radius;
  }

  /**
   * Provide a terrain height sampler so grounding follows the displaced
   * terrain instead of the ideal sphere (hills rise ~4 units above radius).
   */
  public setGroundSampler(sampler: (outwardDir: THREE.Vector3) => number): void {
    this.groundSampler = sampler;
  }

  /**
   * Get the surface normal at the player's current position (away from planet center).
   * Returns (0,1,0) in flat-ground mode.
   */
  public getSurfaceNormal(): THREE.Vector3 {
    if (this.planetRadius <= 0) return new THREE.Vector3(0, 1, 0);
    const n = this.playerPosition.clone().sub(this.planetCenter);
    const len = n.length();
    if (len < 0.001) return new THREE.Vector3(0, 1, 0);
    return n.divideScalar(len);
  }

  /**
   * Attempt to load GLTF character model (async, non-blocking)
   */
  private async loadGLTFCharacter(): Promise<void> {
    try {
      console.log('🎭 Loading GLTF character model...');

      // Intended toon player (Blender-authored, rigged with Idle+Walk clips).
      // The old Superhero kit fallbacks (12.6k tris + ~15MB of 4K textures)
      // are gone; if this fails the primitive capsule mesh remains.
      const gltfResult = await loadGLTFWithFallbacks('/assets/models/player.glb', {
        scale: 1.0, // v2 model is natively 1.8u — the real-life canon height
      });

      if (gltfResult) {
        // Remove the simple mesh
        this.remove(this.mesh);

        // Add the GLTF model
        this.gltfModel = gltfResult.scene;
        this.add(this.gltfModel);

        // Self-calibrate: place the model's feet at local -playerHeight (0.7)
        // regardless of where the exporter put the mesh origin.
        //
        // CRITICAL: Box3.setFromObject() always measures in WORLD space (it
        // walks matrixWorld). By the time this GLTF resolves, the player has
        // already been positioned on the sphere (world Y ~18.7 at spawn), so
        // the "local" offset below was actually a world-space number — it
        // shoved the mesh ~18.7 units through the planet and made the player
        // invisible. Zero the player's own world transform before measuring
        // so the box reflects gltfModel's position relative to its parent,
        // then restore.
        try {
          const savedPos = this.position.clone();
          const savedQuat = this.quaternion.clone();
          this.position.set(0, 0, 0);
          this.quaternion.identity();
          this.updateMatrixWorld(true);

          const box = new THREE.Box3().setFromObject(this.gltfModel);

          this.position.copy(savedPos);
          this.quaternion.copy(savedQuat);
          this.updateMatrixWorld(true);

          if (Number.isFinite(box.min.y)) {
            this.gltfModel.position.y += -0.7 - box.min.y;
          }
        } catch {
          /* keep default placement */
        }

        // Skinned meshes are culled against their rest-pose bounds; on a small
        // planet the camera regularly proves those bounds wrong — disable.
        this.gltfModel.traverse((obj) => {
          if ((obj as THREE.SkinnedMesh).isSkinnedMesh) obj.frustumCulled = false;
        });

        // Setup animations: keep idle+walk actions for speed-based blending
        if (gltfResult.animations.length > 0) {
          this.animationMixer = new THREE.AnimationMixer(gltfResult.scene);
          const idleClip = gltfResult.animations.find((c) => /idle/i.test(c.name));
          const walkClip = gltfResult.animations.find((c) => /walk|run/i.test(c.name));
          if (idleClip) {
            this.idleAction = this.animationMixer.clipAction(idleClip);
            this.idleAction.play();
          }
          if (walkClip) {
            this.walkAction = this.animationMixer.clipAction(walkClip);
            this.walkAction.setEffectiveWeight(0);
            this.walkAction.play();
          }
          if (!this.idleAction && !this.walkAction) {
            this.animationMixer = setupModelAnimation(gltfResult.scene, gltfResult.animations, 'idle');
          }
        }

        // Enable shadows
        if (this.gltfModel) {
          this.gltfModel.traverse((obj) => {
            if (obj instanceof THREE.Mesh) {
              obj.castShadow = true;
              obj.receiveShadow = true;
            }
          });
        }

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

    // Apply gravity (spherical toward planet center, or flat -Y)
    if (this.planetRadius > 0) {
      const gravDir = this.planetCenter.clone().sub(this.playerPosition).normalize();
      this.velocity.addScaledVector(gravDir, this.gravityStrength * safeDeltaTime);
    } else {
      this.acceleration.set(0, -this.gravityStrength, 0);
      this.velocity.addScaledVector(this.acceleration, safeDeltaTime);
    }

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

    // Blend idle/walk by tangential speed. Weights are set directly every
    // frame (no fadeIn/fadeOut scheduling — interleaved fades can strand both
    // actions at weight 0 when the speed oscillates around the threshold).
    if (this.idleAction && this.walkAction) {
      const normal = this.getSurfaceNormal();
      const vTangent = this.velocity
        .clone()
        .sub(normal.clone().multiplyScalar(this.velocity.dot(normal)));
      const target = vTangent.length() > 0.8 ? 1 : 0;
      const k = Math.min(1, 10 * safeDeltaTime);
      const w = THREE.MathUtils.lerp(this.walkAction.getEffectiveWeight(), target, k);
      this.walkAction.setEffectiveWeight(w);
      this.idleAction.setEffectiveWeight(1 - w);
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
    const playerHeight = 0.7;

    if (this.planetRadius > 0) {
      // Spherical ground: keep player on the terrain surface. When a ground
      // sampler is attached, follow the actual displaced terrain (hills and
      // valleys); otherwise fall back to the ideal sphere radius.
      const toPlayer = this.playerPosition.clone().sub(this.planetCenter);
      const dist = toPlayer.length();
      const surfaceNormal = toPlayer.clone().divideScalar(dist);
      let terrainDist = this.planetRadius;
      if (this.groundSampler) {
        try {
          const sampled = this.groundSampler(surfaceNormal);
          if (Number.isFinite(sampled) && sampled > 0) terrainDist = sampled;
        } catch {
          // keep sphere fallback
        }
      }
      const groundDist = terrainDist + playerHeight;

      if (dist <= groundDist) {
        this.isGrounded = true;
        // Cancel velocity component going into the planet
        const velInto = this.velocity.dot(surfaceNormal);
        if (velInto < 0) {
          this.velocity.addScaledVector(surfaceNormal, -velInto);
        }
        // Snap exactly to surface
        this.playerPosition.copy(surfaceNormal.multiplyScalar(groundDist));
      } else {
        this.isGrounded = false;
      }
    } else {
      // Flat ground
      if (this.playerPosition.y <= this.groundLevel + playerHeight) {
        if (!this.isGrounded) {
          this.isGrounded = true;
          this.velocity.y = 0;
        }
        this.playerPosition.y = this.groundLevel + playerHeight;
      } else {
        this.isGrounded = false;
      }
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
    const moveDir = this.moveInput.clone();

    // For spherical world, project move direction onto tangent plane
    if (this.planetRadius > 0) {
      const normal = this.getSurfaceNormal();
      moveDir.sub(normal.clone().multiplyScalar(moveDir.dot(normal)));
    }

    const moveLength = moveDir.length();
    if (moveLength > 0.01) {
      moveDir.normalize();
    } else {
      this.stopMovement();
      return;
    }

    const accelRate = 12; // units per second to blend towards target
    const t = Math.min(1, accelRate * Math.max(0.001, _deltaTime));

    if (this.planetRadius > 0) {
      // Spherical world: the tangent direction is a full 3D vector (it has a
      // Y component almost everywhere on the sphere). Decompose velocity into
      // normal + tangential parts, steer ONLY the tangential part toward the
      // move target, and preserve the normal part (gravity/jump).
      // (The old code lerped velocity.x/z only, which is not tangent to the
      // sphere away from the poles — walking used to launch the player off
      // the planet and bend paths into orbits.)
      const normal = this.getSurfaceNormal();
      const vNormal = normal.clone().multiplyScalar(this.velocity.dot(normal));
      const vTangent = this.velocity.clone().sub(vNormal);
      const target = moveDir.clone().multiplyScalar(this.speed); // moveDir already tangent-projected
      vTangent.lerp(target, t);
      this.velocity.copy(vTangent.add(vNormal));
    } else {
      // Flat ground: steer horizontal components, gravity owns Y
      this.velocity.x = THREE.MathUtils.lerp(this.velocity.x, moveDir.x * this.speed, t);
      this.velocity.z = THREE.MathUtils.lerp(this.velocity.z, moveDir.z * this.speed, t);
    }
  }

  /**
   * Stop movement immediately (zero the tangential velocity, keep the
   * normal/vertical part so gravity and jumps still resolve)
   */
  private stopMovement(): void {
    if (this.planetRadius > 0) {
      const normal = this.getSurfaceNormal();
      const vNormal = normal.multiplyScalar(this.velocity.dot(normal));
      this.velocity.copy(vNormal);
    } else {
      this.velocity.x = 0;
      this.velocity.z = 0;
    }
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
   * Set movement as a full world-space direction vector. On a sphere the
   * tangent direction has a Y component almost everywhere; passing only the
   * X/Z components (the old path) collapsed input to zero near latitudes
   * where the tangent points mostly up/down — the player couldn't cross
   * those bands. applyMovement projects this onto the tangent plane.
   */
  public setMovementVector(dir: THREE.Vector3): void {
    this.moveInput.copy(dir);
    this.moveInput.clampLength(0, 1);
  }

  /**
   * Request jump
   */
  public jump(): void {
    if (this.isGrounded) {
      if (this.planetRadius > 0) {
        // Jump away from planet surface
        const surfaceNormal = this.getSurfaceNormal();
        this.velocity.addScaledVector(surfaceNormal, this.jumpForce);
        this.isGrounded = false;
      } else {
        this.wantJump = true;
      }
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
   * Get current velocity (world space)
   */
  public getVelocity(): THREE.Vector3 {
    return this.velocity.clone();
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
   * Update world matrix from position — orients player to stand upright on sphere surface
   */
  public updateWorldMatrix(): void {
    this.position.copy(this.playerPosition);

    if (this.planetRadius > 0) {
      // Align player "up" with surface normal, then yaw around that normal
      const surfaceNormal = this.getSurfaceNormal();
      const worldUp = new THREE.Vector3(0, 1, 0);

      // Quaternion that rotates world-Y onto the surface normal
      const alignQuat = new THREE.Quaternion().setFromUnitVectors(worldUp, surfaceNormal);

      // Yaw rotation around surface normal
      const yawQuat = new THREE.Quaternion().setFromAxisAngle(surfaceNormal, this.yaw);

      this.quaternion.multiplyQuaternions(yawQuat, alignQuat);
    } else {
      this.rotation.order = 'YXZ';
      this.rotation.y = this.yaw;
      this.rotation.x = 0;
    }

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
