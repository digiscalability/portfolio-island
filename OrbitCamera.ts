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

  private distance: number = 9; // distance from player (farther for better view)
  private height: number = 3.8; // height above player (more elevated)

  private yaw: number = 0; // horizontal rotation around player
  private pitch: number = -0.35; // vertical tilt (looking slightly downward at player)

  private yawVelocity: number = 0;
  private pitchVelocity: number = 0;

  private yawInput: number = 0;
  private pitchInput: number = 0;

  private smoothness: number = 0.2; // interpolation factor for smooth camera
  private damping: number = 0.9; // velocity damping (higher = more responsive)
  private mouseSensitivity: number = 0.005; // mouse input multiplier (raw pixels -> radians)

  private minPitch: number = -0.35; // Don't look too far down (prevents ground clipping)
  private maxPitch: number = Math.PI * 0.25; // Don't look too far up
  private minDistance: number = 2;
  private maxDistance: number = 12;
  private minHeight: number = 0.8; // Minimum height to keep ground visible
  private maxHeight: number = 8;

  constructor(camera: THREE.Camera, player: SimplePlayer) {
    this.camera = camera;
    this.player = player;

    // Initialize camera position
    this.updateCameraPosition();
  }

  /**
   * Update camera position based on player and orbit angles
   * Proper RPG third-person positioning: camera stays close to player, looks at torso
   */
  private updateCameraPosition(): void {
    const playerPos = this.player.getWorldPosition();

    // Target is at player's torso level (not above head)
    this.targetPosition.copy(playerPos);
    this.targetPosition.y += this.height;

    // Calculate camera position orbiting around player
    // Use standard spherical coordinates for predictable third-person feel
    const horizontalDistance = this.distance * Math.cos(this.pitch);
    this.cameraPosition.set(
      this.targetPosition.x + Math.sin(this.yaw) * horizontalDistance,
      this.targetPosition.y + Math.sin(this.pitch) * this.distance,
      this.targetPosition.z + Math.cos(this.yaw) * horizontalDistance,
    );
  }

  /**
   * Update camera in response to player movement and input
   */
  public update(deltaTime: number, _input?: { moveX?: number; moveY?: number }): void {
    if (deltaTime <= 0) return;

    // Safely validate inputs
    const safeDeltaTime = Math.max(0, Math.min(deltaTime, 0.05)); // Clamp to prevent jumps

    // Apply mouse sensitivity to input for smooth look
    const scaledYawInput = (this.yawInput || 0) * this.mouseSensitivity;
    const scaledPitchInput = (this.pitchInput || 0) * this.mouseSensitivity;

    // Update velocities from input
    if (scaledYawInput !== 0 || scaledPitchInput !== 0) {
      // Slightly higher rotational speed for snappier feel
      this.yawVelocity = scaledYawInput * 2.5;
      this.pitchVelocity = scaledPitchInput * 2.5;
    }

    // Apply damping to velocities for smooth motion
    this.yawVelocity *= this.damping;
    this.pitchVelocity *= this.damping;

    // Update angles safely
    this.yaw += this.yawVelocity * safeDeltaTime;
    this.pitch += this.pitchVelocity * safeDeltaTime;

    // Clamp pitch to valid range
    this.pitch = Math.max(this.minPitch, Math.min(this.maxPitch, this.pitch));

    // Validate distance and height with safeguards
    this.distance = Math.max(this.minDistance, Math.min(this.maxDistance, this.distance));
    this.height = Math.max(this.minHeight, Math.min(this.maxHeight, this.height));

    // Update camera position
    this.updateCameraPosition();

    // Smooth transition of camera
    const currentCamPos = new THREE.Vector3();
    this.camera.getWorldPosition(currentCamPos);

    // Safety check: ensure values are finite
    if (!Number.isFinite(currentCamPos.x)) currentCamPos.copy(this.cameraPosition);
    if (!Number.isFinite(this.cameraPosition.x)) this.updateCameraPosition();

    currentCamPos.lerp(this.cameraPosition, this.smoothness);

    // Apply to camera with safety checks
    if (Number.isFinite(currentCamPos.x)) {
      this.camera.position.copy(currentCamPos);
    }

    // Ensure target is valid
    if (Number.isFinite(this.targetPosition.x)) {
      this.camera.lookAt(this.targetPosition);
    }

    // Clear input
    this.yawInput = 0;
    this.pitchInput = 0;
  }

  /**
   * Set camera input (from mouse/gamepad)
   */
  public setInput(deltaYaw: number, deltaPitch: number): void {
    // Validate inputs
    // Invert yaw so moving mouse right rotates view right
    this.yawInput = Number.isFinite(deltaYaw) ? -deltaYaw : 0;
    // DO NOT invert pitch - moving mouse up should look down (FPS standard)
    this.pitchInput = Number.isFinite(deltaPitch) ? deltaPitch : 0;
  }

  /**
   * Set orbit distance from player
   */
  public setDistance(distance: number): void {
    this.distance = Math.max(this.minDistance, Math.min(this.maxDistance, distance || 6));
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
    this.height = Math.max(this.minHeight, Math.min(this.maxHeight, height || 1.5));
  }

  /**
   * Set side offset (shoulder offset)
   */
  public setSideOffset(_offset: number): void {
    // No longer used in simplified camera, but kept for API compatibility
  }

  /**
   * Set smoothness/responsiveness
   */
  public setSmoothness(smoothness: number): void {
    this.smoothness = Math.max(0.01, Math.min(0.5, smoothness || 0.15));
  }

  /**
   * Set mouse sensitivity
   */
  public setMouseSensitivity(sensitivity: number): void {
    this.mouseSensitivity = Math.max(0.0001, Math.min(0.01, sensitivity || 0.002));
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
    // Use forward × up to compute a true right vector (not inverted)
    const right = forward
      .clone()
      .cross(new THREE.Vector3(0, 1, 0))
      .normalize();
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
    targetOffset?: THREE.Vector3,
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
