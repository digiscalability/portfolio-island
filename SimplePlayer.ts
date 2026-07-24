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

  // Procedural walk-cycle state (used when no GLTF model is loaded)
  private legPivots: THREE.Group[] = [];
  private armPivots: THREE.Group[] = [];
  private walkPhase: number = 0;
  private wasAirborne: boolean = false;
  private squashTime: number = 0;

  // Sitting (on benches): physics frozen, legs posed forward
  private seated: boolean = false;
  private legLBone: THREE.Bone | null = null;
  private legRBone: THREE.Bone | null = null;

  // GLTF model support
  private gltfModel: THREE.Group | null = null;
  private animationMixer: THREE.AnimationMixer | null = null;
  private idleAction: THREE.AnimationAction | null = null;
  private walkAction: THREE.AnimationAction | null = null;

  constructor() {
    super();
    this.name = 'SimplePlayer';

    const group = new THREE.Group();

    const shirtMat = Materials.createToonMaterial(0x4a90e2);
    const skinMat = Materials.createToonMaterial(0xffddaa);
    const pantsMat = Materials.createToonMaterial(0x2a3a5a);
    const shoeMat = Materials.createToonMaterial(0x3d2b1a);
    const hairMat = Materials.createToonMaterial(0x3a2a1a);
    const eyeMat = Materials.createToonMaterial(0x1a1a1a);

    // Legs — pivoted at the hip so they can swing in the walk cycle
    for (const lx of [-0.12, 0.12]) {
      const legPivot = new THREE.Group();
      legPivot.position.set(lx, -0.08, 0);
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.09, 0.55, 8), pantsMat);
      leg.position.set(0, -0.27, 0);
      leg.castShadow = true;
      legPivot.add(leg);
      const shoe = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.1, 0.22), shoeMat);
      shoe.position.set(0, -0.57, 0.03);
      shoe.castShadow = true;
      legPivot.add(shoe);
      group.add(legPivot);
      this.legPivots.push(legPivot);
    }

    // Torso
    const torso = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.18, 0.6, 8), shirtMat);
    torso.position.y = 0.22;
    torso.castShadow = true;
    torso.receiveShadow = true;
    group.add(torso);

    // Arms — pivoted at the shoulder for the walk swing
    for (const ax of [-0.32, 0.32]) {
      const armPivot = new THREE.Group();
      armPivot.position.set(ax, 0.35, 0);
      armPivot.rotation.z = ax > 0 ? -0.12 : 0.12;
      const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.05, 0.5, 7), shirtMat);
      arm.position.set(0, -0.25, 0);
      arm.castShadow = true;
      armPivot.add(arm);
      const hand = new THREE.Mesh(new THREE.SphereGeometry(0.06, 6, 6), skinMat);
      hand.position.set(0, -0.5, 0);
      armPivot.add(hand);
      group.add(armPivot);
      this.armPivots.push(armPivot);
    }

    // Head
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.22, 12, 12), skinMat);
    head.position.y = 0.72;
    head.castShadow = true;
    head.receiveShadow = true;
    group.add(head);

    // Hair (cap on top)
    const hair = new THREE.Mesh(
      new THREE.SphereGeometry(0.21, 10, 8, 0, Math.PI * 2, 0, Math.PI * 0.5),
      hairMat,
    );
    hair.position.y = 0.76;
    group.add(hair);

    // Eyes
    for (const [ex, ey, ez] of [[-0.08, 0.76, 0.17], [0.08, 0.76, 0.17]] as [number, number, number][]) {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.04, 6, 6), eyeMat);
      eye.position.set(ex, ey, ez);
      group.add(eye);
      const pupilHighlight = new THREE.Mesh(
        new THREE.SphereGeometry(0.015, 4, 4),
        new THREE.MeshBasicMaterial({ color: 0xffffff }),
      );
      pupilHighlight.position.set(ex + 0.015, ey + 0.015, ez + 0.02);
      group.add(pupilHighlight);
    }

    // Mouth — small curve
    const mouth = new THREE.Mesh(
      new THREE.TorusGeometry(0.04, 0.01, 4, 8, Math.PI),
      eyeMat,
    );
    mouth.position.set(0, 0.66, 0.18);
    mouth.rotation.x = Math.PI;
    group.add(mouth);

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
  /** Whether the player is currently standing on the ground (for SFX etc.). */
  public isOnGround(): boolean {
    return this.isGrounded;
  }

  public isSeated(): boolean {
    return this.seated;
  }

  /**
   * Sit at a world position facing `faceDir` (surface-tangent). Physics
   * freezes; the model is posed (GLTF: mixer paused + leg bones forward,
   * fallback: hip pivots forward) until standUp().
   */
  public sitDown(seatPos: THREE.Vector3, faceDir: THREE.Vector3): void {
    this.seated = true;
    this.velocity.set(0, 0, 0);
    this.playerPosition.copy(seatPos);
    // Orient: up = surface normal, forward (+Z of the model) = faceDir
    const up = this.getSurfaceNormal();
    const fwd = faceDir.clone().sub(up.clone().multiplyScalar(faceDir.dot(up))).normalize();
    const right = up.clone().cross(fwd).normalize();
    const m = new THREE.Matrix4().makeBasis(right, up, fwd);
    this.quaternion.setFromRotationMatrix(m);
    this.updateWorldMatrix();
  }

  /** Stand up from a bench: unfreeze physics with a small forward step. */
  public standUp(): void {
    if (!this.seated) return;
    this.seated = false;
    const up = this.getSurfaceNormal();
    const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(this.quaternion);
    fwd.sub(up.clone().multiplyScalar(fwd.dot(up))).normalize();
    this.playerPosition.addScaledVector(fwd, 0.7).addScaledVector(up, 0.15);
    this.updateWorldMatrix();
  }

  /** Pose applied every frame while seated. */
  private applySitPose(): void {
    if (this.gltfModel) {
      // Mixer is paused while seated (update() skips it) — pose the leg
      // bones directly; the mixer re-drives them on stand-up.
      if (!this.legLBone || !this.legRBone) {
        this.gltfModel.traverse((o) => {
          const bone = o as THREE.Bone;
          if (!bone.isBone) return;
          if (o.name === 'legL') this.legLBone = bone;
          if (o.name === 'legR') this.legRBone = bone;
        });
      }
      if (this.legLBone) this.legLBone.rotation.x = -1.35;
      if (this.legRBone) this.legRBone.rotation.x = -1.35;
    } else if (this.legPivots.length === 2) {
      this.legPivots[0].rotation.x = -1.45;
      this.legPivots[1].rotation.x = -1.45;
      this.armPivots[0].rotation.x = -0.25;
      this.armPivots[1].rotation.x = -0.25;
    }
  }

  /** Speed along the surface (gravity axis removed) — drives footstep cadence. */
  public getTangentialSpeed(): number {
    const n = this.getSurfaceNormal();
    return this.velocity
      .clone()
      .sub(n.clone().multiplyScalar(this.velocity.dot(n)))
      .length();
  }

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

        // The GLB's own hair patch is tiny — from the follow camera the
        // head reads as a bald egg. Hang a fuller toon hair cap off the
        // head bone (tracks idle/walk animation for free). Sizing tuned
        // live against the model (head bone at +0.63, world scale 1).
        if (this.gltfModel) {
          let headBone: THREE.Bone | null = null;
          this.gltfModel.traverse((obj) => {
            if ((obj as THREE.Bone).isBone && obj.name === 'head' && !headBone) {
              headBone = obj as THREE.Bone;
            }
          });
          if (headBone) {
            const hairCap = new THREE.Mesh(
              new THREE.SphereGeometry(0.21, 14, 10, 0, Math.PI * 2, 0, Math.PI * 0.62),
              new THREE.MeshToonMaterial({ color: 0x6c594b }),
            );
            hairCap.name = 'hair_cap';
            hairCap.position.set(0, 0.16, -0.02);
            hairCap.rotation.x = 0.25;
            hairCap.castShadow = true;
            (headBone as THREE.Bone).add(hairCap);
          }
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

    // Seated on a bench: physics + animation mixer paused, sit pose held
    if (this.seated) {
      this.applySitPose();
      this.updateWorldMatrix();
      return;
    }

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

    // Handle jump — impulse along the surface normal, not world +Y.
    // (World-Y only points "up" at the sphere's north pole; anywhere else
    // it is partly tangential and grounding instantly re-sticks the player.)
    if (this.wantJump && this.isGrounded) {
      const jumpNormal = this.getSurfaceNormal();
      this.velocity.addScaledVector(jumpNormal, this.jumpForce);
      this.isGrounded = false;
      this.wantJump = false;
    }

    // Procedural walk cycle for the built-in model: swing limbs from their
    // hip/shoulder pivots and bounce the body, scaled by tangential speed.
    if (!this.gltfModel && this.legPivots.length === 2 && this.armPivots.length === 2) {
      const surfNormal = this.getSurfaceNormal();
      const tangential = this.velocity
        .clone()
        .sub(surfNormal.clone().multiplyScalar(this.velocity.dot(surfNormal)))
        .length();
      if (tangential > 0.5 && this.isGrounded) {
        this.walkPhase += safeDeltaTime * (4 + tangential * 1.6);
        const swing = Math.sin(this.walkPhase) * 0.55;
        this.legPivots[0].rotation.x = swing;
        this.legPivots[1].rotation.x = -swing;
        this.armPivots[0].rotation.x = -swing * 0.7;
        this.armPivots[1].rotation.x = swing * 0.7;
        // Bouncy step + slight forward lean while moving
        this.mesh.position.y = Math.abs(Math.sin(this.walkPhase)) * 0.06;
        this.mesh.rotation.x = 0.06;
      } else {
        // Ease limbs back to rest, then breathe gently
        const k = Math.min(1, 8 * safeDeltaTime);
        for (const p of [...this.legPivots, ...this.armPivots]) {
          p.rotation.x *= 1 - k;
        }
        this.mesh.rotation.x *= 1 - k;
        this.mesh.position.y = Math.sin(performance.now() / 500) * 0.015;
      }

    }

    // Squash-and-stretch on whichever model is active (rigged GLTF or the
    // procedural fallback): elongate while airborne, squash on landing,
    // spring back to neutral. Scales relative to the model's base scale.
    {
      const activeModel: THREE.Object3D = this.gltfModel ?? this.mesh;
      const ud = activeModel.userData as { baseScale?: THREE.Vector3 };
      if (!ud.baseScale) ud.baseScale = activeModel.scale.clone();
      const base = ud.baseScale;
      let sx = 1;
      let sy = 1;
      let kSpring = Math.min(1, 10 * safeDeltaTime);
      if (!this.isGrounded) {
        const ssNormal = this.getSurfaceNormal();
        const vAlong = Math.abs(this.velocity.dot(ssNormal));
        sy = Math.min(1.15, 1 + vAlong * 0.02);
        sx = 2 - sy;
        this.wasAirborne = true;
      } else {
        if (this.wasAirborne) {
          this.wasAirborne = false;
          this.squashTime = 0.12;
        }
        if (this.squashTime > 0) {
          this.squashTime -= safeDeltaTime;
          sy = 0.85;
          sx = 1.12;
          kSpring = Math.min(1, 20 * safeDeltaTime);
        }
      }
      activeModel.scale.x += (base.x * sx - activeModel.scale.x) * kSpring;
      activeModel.scale.y += (base.y * sy - activeModel.scale.y) * kSpring;
      activeModel.scale.z += (base.z * sx - activeModel.scale.z) * kSpring;
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
