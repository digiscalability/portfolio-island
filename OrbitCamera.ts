import * as THREE from 'three';

import type { SimplePlayer } from './SimplePlayer';

/**
 * OrbitCamera
 *
 * Simple third-person orbit camera following Messenger's pattern
 * Replaces the complex Camera.ts with focused, clean implementation
 *
 * Features:
 * - Follows player with orbit around target
 * - Smooth damping for stable camera
 * - Supports both keyboard and mouse/touch control
 * - No quaternion micromanagement, simple angles
 */
export class OrbitCamera {
  private camera: THREE.Camera;
  private player: SimplePlayer;

  // Target and orbit parameters
  private targetPosition: THREE.Vector3 = new THREE.Vector3();
  private cameraPosition: THREE.Vector3 = new THREE.Vector3();

  private distance: number = 6; // distance from player
  private height: number = 2.2; // height above player
  private sideOffset: number = 1.2; // side offset (shoulder camera)

  private yaw: number = 0; // horizontal rotation around player
  private pitch: number = 0.3; // vertical tilt

  private yawVelocity: number = 0;
  private pitchVelocity: number = 0;

  private yawInput: number = 0;
  private pitchInput: number = 0;

  private smoothness: number = 0.1; // interpolation factor
  private damping: number = 0.9; // velocity damping

  private minPitch: number = -Math.PI * 0.4;
  private maxPitch: number = Math.PI * 0.4;

  constructor(camera: THREE.Camera, player: SimplePlayer) {
    this.camera = camera;
    this.player = player;

    // Initialize camera position
    this.updateCameraPosition();
  }

  /**
   * Update camera position based on player and orbit angles
   */
  private updateCameraPosition(): void {
    const playerPos = this.player.getWorldPosition();

    // Target is slightly in front and above the player
    this.targetPosition.copy(playerPos);
    this.targetPosition.y += this.height;

    // Calculate camera position in orbit
    const horizontalDistance = this.distance * Math.cos(this.pitch);
    this.cameraPosition.set(
      this.targetPosition.x +
        Math.sin(this.yaw) * horizontalDistance +
        Math.cos(this.yaw) * this.sideOffset,
      this.targetPosition.y + Math.sin(this.pitch) * this.distance,
      this.targetPosition.z +
        Math.cos(this.yaw) * horizontalDistance -
        Math.sin(this.yaw) * this.sideOffset
    );
  }

  /**
   * Update camera in response to player movement and input
   */
  public update(deltaTime: number, _input?: { moveX?: number; moveY?: number }): void {
    if (deltaTime <= 0) return;

    // Update yaw and pitch from input
    if (this.yawInput !== 0 || this.pitchInput !== 0) {
      this.yawVelocity = this.yawInput * 3;
      this.pitchVelocity = this.pitchInput * 3;
    }

    // Apply damping to velocities
    this.yawVelocity *= this.damping;
    this.pitchVelocity *= this.damping;

    // Update angles
    this.yaw += this.yawVelocity * deltaTime;
    this.pitch += this.pitchVelocity * deltaTime;

    // Clamp pitch
    this.pitch = Math.max(this.minPitch, Math.min(this.maxPitch, this.pitch));

    // Update camera position
    this.updateCameraPosition();

    // Smooth transition of camera
    const currentCamPos = new THREE.Vector3();
    this.camera.getWorldPosition(currentCamPos);
    currentCamPos.lerp(this.cameraPosition, this.smoothness);

    // Apply to camera
    this.camera.position.copy(currentCamPos);
    this.camera.lookAt(this.targetPosition);

    // Clear input
    this.yawInput = 0;
    this.pitchInput = 0;
  }

  /**
   * Set camera input (from mouse/gamepad)
   */
  public setInput(deltaYaw: number, deltaPitch: number): void {
    this.yawInput = deltaYaw;
    this.pitchInput = -deltaPitch; // Invert pitch for intuitive control
  }

  /**
   * Set orbit distance from player
   */
  public setDistance(distance: number): void {
    this.distance = Math.max(2, Math.min(12, distance));
  }

  /**
   * Get orbit distance
   */
  public getDistance(): number {
    return this.distance;
  }

  /**
   * Set camera height above player
   */
  public setHeight(height: number): void {
    this.height = height;
  }

  /**
   * Set side offset (shoulder offset)
   */
  public setSideOffset(offset: number): void {
    this.sideOffset = offset;
  }

  /**
   * Set smoothness/responsiveness
   */
  public setSmoothness(smoothness: number): void {
    this.smoothness = Math.max(0.01, Math.min(0.5, smoothness));
  }

  /**
   * Get current camera world position
   */
  public getCameraPosition(): THREE.Vector3 {
    return this.cameraPosition.clone();
  }

  /**
   * Get camera forward direction (towards target)
   */
  public getForwardDirection(): THREE.Vector3 {
    const forward = this.targetPosition.clone().sub(this.cameraPosition).normalize();
    return forward;
  }

  /**
   * Get camera right direction
   */
  public getRightDirection(): THREE.Vector3 {
    const forward = this.getForwardDirection();
    const right = new THREE.Vector3(0, 1, 0).cross(forward).normalize();
    return right;
  }

  /**
   * Get camera up direction
   */
  public getUpDirection(): THREE.Vector3 {
    return new THREE.Vector3(0, 1, 0);
  }

  /**
   * Get current yaw angle
   */
  public getYaw(): number {
    return this.yaw;
  }

  /**
   * Set yaw directly
   */
  public setYaw(yaw: number): void {
    this.yaw = yaw;
  }

  /**
   * Orient camera to match a specific direction
   */
  public lookInDirection(direction: THREE.Vector3): void {
    const targetYaw = Math.atan2(direction.x, direction.z);
    this.setYaw(targetYaw);
  }

  /**
   * Cinematic fly-in from distant view (like Messenger title screen)
   */
  public async flyInFromDistant(
    duration: number = 2000,
    targetOffset?: THREE.Vector3
  ): Promise<void> {
    return new Promise((resolve) => {
      const startTime = Date.now();
      const startPos = this.cameraPosition.clone();

      // Start from far away
      const farAwayPos = this.player
        .getWorldPosition()
        .clone()
        .add(targetOffset || new THREE.Vector3(0, 25, 40))
        .multiplyScalar(2.5);

      this.cameraPosition.copy(farAwayPos);
      this.camera.position.copy(farAwayPos);

      const animate = () => {
        const elapsed = Date.now() - startTime;
        const progress = Math.min(elapsed / duration, 1);

        // Ease in-out cubic
        const easeProgress =
          progress < 0.5
            ? 4 * progress * progress * progress
            : 1 - Math.pow(-2 * progress + 2, 3) / 2;

        this.cameraPosition.lerpVectors(farAwayPos, startPos, easeProgress);
        this.camera.position.copy(this.cameraPosition);
        this.camera.lookAt(this.targetPosition);

        if (progress < 1) {
          requestAnimationFrame(animate);
        } else {
          resolve();
        }
      };

      animate();
    });
  }

  /**
   * Disable/enable camera
   */
  public setEnabled(enabled: boolean): void {
    // Camera can be disabled by other systems if needed
    this.smoothness = enabled ? 0.1 : 0;
  }
}
