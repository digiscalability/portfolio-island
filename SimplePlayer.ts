import * as THREE from 'three';

import { Materials } from './Materials';
import type { SimplePlanet } from './SimplePlanet';

/**
 * SimplePlayer
 *
 * A simplified player controller replacing the 834-line Player.ts
 * Following Messenger's simple character movement pattern.
 *
 * Features:
 * - Simple position and velocity
 * - Gravity and ground sticking
 * - Animation state management
 * - No complex quaternion tracking
 */
export class SimplePlayer extends THREE.Group {
  private readonly mesh: THREE.Group;
  private readonly planet: SimplePlanet;

  private readonly playerPosition: THREE.Vector3 = new THREE.Vector3();
  private readonly velocity: THREE.Vector3 = new THREE.Vector3();
  private readonly acceleration: THREE.Vector3 = new THREE.Vector3();

  private readonly cameraForward: THREE.Vector3 = new THREE.Vector3(0, 0, -1);
  private readonly cameraRight: THREE.Vector3 = new THREE.Vector3(1, 0, 0);
  private readonly facingDirection: THREE.Vector3 = new THREE.Vector3(0, 0, -1);

  private readonly moveInput: THREE.Vector3 = new THREE.Vector3(); // (x=strafe, y=unused, z=forward)
  private wantJump: boolean = false;

  private yaw: number = 0; // rotation around local up axis

  private readonly speed: number = 15; // movement speed
  private readonly jumpForce: number = 8;
  private readonly gravityStrength: number = 25; // gravitational acceleration magnitude
  private readonly movementDamping: number = 0.9;

  private isGrounded: boolean = false;
  private readonly groundStickThreshold: number = 0.5;

  private readonly lastGravity: THREE.Vector3 = new THREE.Vector3();
  private debugTelemetryTimer: number = 0;
  private readonly debugTelemetryInterval: number = 0.25;

  constructor(planet: SimplePlanet, startPosition?: THREE.Vector3) {
    super();
    this.name = 'SimplePlayer';
    this.planet = planet;

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

    // Start position
    if (startPosition) {
      this.playerPosition.copy(startPosition);
    } else {
      this.playerPosition.set(0, planet.getRadius() + 2, 0);
    }

    this.updateWorldMatrix();
  }

  /**
   * Update player physics and position
   */
  public update(deltaTime: number): void {
    if (deltaTime <= 0) {
      return;
    }

    // Clamp delta time to prevent large jumps
    deltaTime = Math.min(deltaTime, 0.02);

    // Reset accumulated forces
    this.acceleration.set(0, 0, 0);

    // Apply core forces & controls
    this.applyGravity();
    this.applyMovement(deltaTime);

    if (this.wantJump && this.isGrounded) {
      this.performJump();
    } else {
      this.wantJump = false;
    }

    // Integrate motion
    this.velocity.addScaledVector(this.acceleration, deltaTime);
    this.playerPosition.addScaledVector(this.velocity, deltaTime);

    // Ground correction & orientation update
    this.updateGroundState();
    this.updateWorldMatrix();

    this.emitDebugTelemetry(deltaTime);
  }

  /**
   * Check ground state and apply ground sticking
   */
  private updateGroundState(): void {
    const origin = this.playerPosition.clone();
    const direction = this.planet.getCenter().clone().sub(origin);

    if (direction.lengthSq() === 0) {
      direction.set(0, -1, 0);
    }

    direction.normalize();

    const hit = this.planet.rayCast(origin, direction);

    if (hit && hit.distance <= this.groundStickThreshold + 0.1) {
      if (!this.isGrounded) {
        this.isGrounded = true;
      }

      const surfacePoint = this.planet.getGroundPoint(this.playerPosition);
      this.playerPosition.copy(surfacePoint);

      const up = this.getUpVector();
      const radialVelocity = this.velocity.dot(up);

      if (radialVelocity < 0) {
        this.velocity.addScaledVector(up, -radialVelocity);
      }
    } else {
      this.isGrounded = false;
    }
  }

  /**
   * Apply movement input
   */
  private applyMovement(_deltaTime: number): void {
    const up = this.getUpVector();

    const forward = this.projectOntoTangent(this.cameraForward, up);
    const right = this.projectOntoTangent(this.cameraRight, up);

    const moveDir = new THREE.Vector3();
    moveDir.addScaledVector(forward, this.moveInput.z);
    moveDir.addScaledVector(right, this.moveInput.x);

    if (moveDir.lengthSq() > 0) {
      moveDir.normalize().multiplyScalar(this.speed);

      const radialVelocity = up.clone().multiplyScalar(this.velocity.dot(up));
      this.velocity.copy(radialVelocity).add(moveDir);

      this.facingDirection.copy(moveDir).normalize();
      this.updateYawFromFacing(up);
    } else {
      const radialVelocity = up.clone().multiplyScalar(this.velocity.dot(up));
      const tangentialVelocity = this.velocity
        .clone()
        .sub(radialVelocity)
        .multiplyScalar(this.movementDamping);
      this.velocity.copy(radialVelocity).add(tangentialVelocity);
    }
  }

  private applyGravity(): void {
    const gravityVector = this.planet.getCenter().clone().sub(this.playerPosition);

    if (gravityVector.lengthSq() === 0) {
      return;
    }

    gravityVector.normalize().multiplyScalar(this.gravityStrength);
    this.acceleration.copy(gravityVector);
    this.lastGravity.copy(gravityVector);
  }

  private performJump(): void {
    const up = this.getUpVector();
    const radialVelocity = this.velocity.dot(up);

    if (radialVelocity < 0) {
      this.velocity.addScaledVector(up, -radialVelocity);
    }

    this.velocity.addScaledVector(up, this.jumpForce);
    this.isGrounded = false;
    this.wantJump = false;
  }

  private getUpVector(): THREE.Vector3 {
    const up = this.playerPosition.clone().sub(this.planet.getCenter());
    if (up.lengthSq() === 0) {
      up.set(0, 1, 0);
    }
    return up.normalize();
  }

  private projectOntoTangent(vector: THREE.Vector3, up: THREE.Vector3): THREE.Vector3 {
    const projected = vector.clone().sub(up.clone().multiplyScalar(vector.dot(up)));
    if (projected.lengthSq() === 0) {
      return projected;
    }
    return projected.normalize();
  }

  private updateYawFromFacing(up: THREE.Vector3): void {
    const referenceForward = this.projectOntoTangent(new THREE.Vector3(0, 0, -1), up);
    const facing = this.projectOntoTangent(this.facingDirection, up);

    if (referenceForward.lengthSq() === 0 || facing.lengthSq() === 0) {
      return;
    }

    referenceForward.normalize();
    facing.normalize();

    const referenceRight = new THREE.Vector3().crossVectors(up, referenceForward).normalize();
    this.yaw = Math.atan2(facing.dot(referenceRight), facing.dot(referenceForward));
  }

  private emitDebugTelemetry(deltaTime: number): void {
    if (typeof window === 'undefined') return;
    if (!window.__DEBUG_PLAYER && !window.__LOGGER) return;

    this.debugTelemetryTimer += deltaTime;
    if (this.debugTelemetryTimer < this.debugTelemetryInterval) {
      return;
    }

    this.debugTelemetryTimer = 0;

    const position = this.getPosition();
    const velocity = this.velocity.clone();
    const up = this.getUpVector();

    const formatVec = (vec: THREE.Vector3) =>
      [vec.x, vec.y, vec.z].map((v) => Number(v.toFixed(3)));

    console.debug('SimplePlayer::state', {
      position: formatVec(position),
      velocity: formatVec(velocity),
      speed: Number(velocity.length().toFixed(3)),
      up: formatVec(up),
      gravity: formatVec(this.lastGravity),
    });

    window.__LOGGER?.updateMetrics({
      sceneObjects: this.planet.children.length,
    });
  }

  /**
   * Set movement input (-1 to 1)
   */
  public setMovement(
    forward: number,
    strafe: number,
    cameraForward?: THREE.Vector3,
    cameraRight?: THREE.Vector3,
  ): void {
    this.moveInput.set(strafe, 0, forward);
    this.moveInput.clampLength(0, 1);

    if (cameraForward) {
      this.cameraForward.copy(cameraForward).normalize();
    }

    if (cameraRight) {
      this.cameraRight.copy(cameraRight).normalize();
    }

    if (this.moveInput.lengthSq() > 0) {
      const up = this.getUpVector();
      const forwardVec = this.projectOntoTangent(this.cameraForward, up);
      const rightVec = this.projectOntoTangent(this.cameraRight, up);

      const desiredFacing = new THREE.Vector3();
      desiredFacing.addScaledVector(forwardVec, this.moveInput.z);
      desiredFacing.addScaledVector(rightVec, this.moveInput.x);

      if (desiredFacing.lengthSq() > 0) {
        desiredFacing.normalize();
        this.facingDirection.copy(desiredFacing);
        this.updateYawFromFacing(up);
      }
    }
  }

  public setCameraFrame(forward: THREE.Vector3, right: THREE.Vector3): void {
    this.cameraForward.copy(forward).normalize();
    this.cameraRight.copy(right).normalize();
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

    const up = this.getUpVector();
    let baseForward = this.projectOntoTangent(new THREE.Vector3(0, 0, -1), up);

    if (baseForward.lengthSq() === 0) {
      baseForward = this.projectOntoTangent(new THREE.Vector3(1, 0, 0), up);
    }

    const baseRight = new THREE.Vector3().crossVectors(up, baseForward).normalize();

    const rotatedForward = baseForward
      .clone()
      .multiplyScalar(Math.cos(yaw))
      .add(baseRight.clone().multiplyScalar(Math.sin(yaw)));

    if (rotatedForward.lengthSq() > 0) {
      this.facingDirection.copy(rotatedForward.normalize());
    }
  }

  /**
   * Get player world position
   */
  public getWorldPosition(): THREE.Vector3 {
    return this.getPosition();
  }

  /**
   * Get player position reference
   */
  public getPosition(): THREE.Vector3 {
    return this.playerPosition.clone();
  }

  /**
   * Get player forward direction aligned with the planet surface
   */
  public getForwardDirection(): THREE.Vector3 {
    const forward = this.projectOntoTangent(this.facingDirection, this.getUpVector());
    if (forward.lengthSq() === 0) {
      return new THREE.Vector3(0, 0, -1);
    }
    return forward.normalize();
  }

  /**
   * Expose the character mesh for compatibility with full systems
   */
  public getMesh(): THREE.Group {
    return this.mesh;
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
    const up = this.getUpVector();
    let forward = this.projectOntoTangent(this.facingDirection, up);

    if (forward.lengthSq() === 0) {
      forward = this.projectOntoTangent(new THREE.Vector3(0, 0, -1), up);
    }

    if (forward.lengthSq() === 0) {
      forward = this.projectOntoTangent(new THREE.Vector3(1, 0, 0), up);
    }

    forward.normalize();

    const right = new THREE.Vector3().crossVectors(forward, up).normalize();
    const correctedForward = new THREE.Vector3().crossVectors(up, right).normalize();

    const matrix = new THREE.Matrix4();
    matrix.makeBasis(right, up, correctedForward);

    const quaternion = new THREE.Quaternion().setFromRotationMatrix(matrix);

    this.mesh.quaternion.copy(quaternion);
    this.mesh.position.copy(this.playerPosition);
    this.mesh.updateMatrixWorld();
  }

  /**
   * Dispose resources
   */
  public dispose(): void {
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
