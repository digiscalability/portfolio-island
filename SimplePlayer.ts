import * as THREE from 'three';
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
  private mesh: THREE.Mesh;
  private position: THREE.Vector3 = new THREE.Vector3();
  private velocity: THREE.Vector3 = new THREE.Vector3();
  private acceleration: THREE.Vector3 = new THREE.Vector3();

  private yaw: number = 0; // rotation around Y axis
  private pitch: number = 0; // rotation around X axis (limited)

  private speed: number = 15; // movement speed
  private jumpForce: number = 8;
  private gravity: number = -25; // gravitational acceleration
  private mass: number = 1;

  private isGrounded: boolean = false;
  private groundStickThreshold: number = 0.5;

  private planet: SimplePlanet;
  private raycaster: THREE.Raycaster = new THREE.Raycaster();

  private moveInput: THREE.Vector3 = new THREE.Vector3(); // (x=forward, y=unused, z=strafe)
  private wantJump: boolean = false;

  constructor(planet: SimplePlanet, startPosition?: THREE.Vector3) {
    super();
    this.name = 'SimplePlayer';
    this.planet = planet;

    // Create a simple capsule mesh (cylinder + spheres for head/feet)
    const group = new THREE.Group();

    // Body (cylinder)
    const bodyGeo = new THREE.CylinderGeometry(0.4, 0.35, 1.4, 8);
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0x3b82f6, roughness: 0.7 });
    const body = new THREE.Mesh(bodyGeo, bodyMat);
    body.castShadow = true;
    body.receiveShadow = true;
    group.add(body);

    // Head (sphere)
    const headGeo = new THREE.SphereGeometry(0.25, 8, 8);
    const headMat = new THREE.MeshStandardMaterial({ color: 0xfdbcb4, roughness: 0.8 });
    const head = new THREE.Mesh(headGeo, headMat);
    head.position.y = 1.0;
    head.castShadow = true;
    head.receiveShadow = true;
    group.add(head);

    this.mesh = group as any;
    this.add(this.mesh);

    // Start position
    if (startPosition) {
      this.position.copy(startPosition);
    } else {
      this.position.set(0, planet.getRadius() + 2, 0);
    }

    this.updateWorldMatrix();
  }

  /**
   * Update player physics and position
   */
  public update(deltaTime: number): void {
    if (deltaTime <= 0) return;

    // Clamp delta time to prevent large jumps
    deltaTime = Math.min(deltaTime, 0.02);

    // Update position from velocity
    this.velocity.addScaledVector(this.acceleration, deltaTime);
    this.position.addScaledVector(this.velocity, deltaTime);

    // Apply gravity
    const gravityForce = new THREE.Vector3(0, this.gravity * this.mass, 0);
    this.acceleration.add(gravityForce).multiplyScalar(deltaTime);

    // Ground detection
    this.updateGroundState();

    // Apply movement input
    if (this.moveInput.length() > 0) {
      this.applyMovement(deltaTime);
    }

    // Handle jump
    if (this.wantJump && this.isGrounded) {
      this.velocity.y = this.jumpForce;
      this.isGrounded = false;
      this.wantJump = false;
    }

    // Update mesh position
    this.updateWorldMatrix();
  }

  /**
   * Check ground state and apply ground sticking
   */
  private updateGroundState(): void {
    // Raycast downward from player position
    const origin = this.position.clone();
    const direction = new THREE.Vector3(0, -1, 0);

    const hit = this.planet.rayCast(origin, direction);

    if (hit && hit.distance < this.groundStickThreshold + 0.1) {
      if (!this.isGrounded) {
        // Just landed
        this.isGrounded = true;
        this.velocity.y = Math.min(this.velocity.y, 0); // Kill upward velocity
      }

      // Stick to ground
      const surfacePoint = this.planet.getGroundPoint(this.position);
      const toSurface = surfacePoint.distanceTo(this.position);

      if (toSurface < this.groundStickThreshold) {
        // Move towards surface
        const dir = surfacePoint.clone().sub(this.position).normalize();
        this.position.addScaledVector(dir, (this.groundStickThreshold - toSurface) * 0.5);
        this.velocity.y = 0; // Kill downward velocity
      }
    } else {
      this.isGrounded = false;
    }
  }

  /**
   * Apply movement input
   */
  private applyMovement(deltaTime: number): void {
    // Get camera forward and right directions
    // This would normally come from the camera controller
    // For now, use player's forward direction
    const forward = new THREE.Vector3(0, 0, -1);
    const right = new THREE.Vector3(1, 0, 0);

    // Apply rotation to forward/right
    forward.applyAxisAngle(new THREE.Vector3(0, 1, 0), this.yaw);
    right.applyAxisAngle(new THREE.Vector3(0, 1, 0), this.yaw);

    // Build movement vector
    const moveDir = new THREE.Vector3();
    moveDir.addScaledVector(forward, this.moveInput.z);
    moveDir.addScaledVector(right, this.moveInput.x);
    moveDir.normalize();

    // Apply speed
    moveDir.multiplyScalar(this.speed);

    // Only apply horizontal movement (preserve gravity)
    this.velocity.x = moveDir.x;
    this.velocity.z = moveDir.z;
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
  public setRotation(yaw: number, pitch?: number): void {
    this.yaw = yaw;
    if (pitch !== undefined) {
      this.pitch = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, pitch));
    }
  }

  /**
   * Get player world position
   */
  public getWorldPosition(): THREE.Vector3 {
    return this.position.clone();
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
  private updateWorldMatrix(): void {
    this.position.y = Math.max(this.position.y, -this.planet.getRadius() * 3);
    this.mesh.position.copy(this.position);
    this.mesh.rotation.order = 'YXZ';
    this.mesh.rotation.y = this.yaw;
    this.mesh.rotation.x = 0;
    this.mesh.updateMatrix();
  }

  /**
   * Dispose resources
   */
  public dispose(): void {
    this.traverse((obj: any) => {
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material) {
        if (Array.isArray(obj.material)) {
          obj.material.forEach((m: any) => m.dispose());
        } else {
          obj.material.dispose();
        }
      }
    });
  }
}
