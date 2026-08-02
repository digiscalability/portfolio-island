import * as THREE from 'three';

import { a11y } from './Accessibility';
import { consumePinchZoomFactor } from './SimpleInputManager';
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

  private distance: number = 4.4; // tight third-person frame — player always reads
  private height: number = 1.5; // height above player (lowered for a grounded, near-eye POV)

  private yaw: number = 0; // horizontal rotation around player
  private pitch: number = -0.12; // vertical tilt: near eye-level (was -0.35, a downward/aerial look)

  private yawVelocity: number = 0;
  private pitchVelocity: number = 0;

  private yawInput: number = 0;
  private pitchInput: number = 0;

  private smoothness: number = 0.2; // interpolation factor for smooth camera
  private damping: number = 0.9; // velocity damping (higher = more responsive)
  private mouseSensitivity: number = 0.005; // mouse input multiplier (raw pixels -> radians)

  private minPitch: number = -0.18; // Don't look too far down (prevents ground clipping)
  private maxPitch: number = Math.PI * 0.25; // Don't look too far up
  private minDistance: number = 2;
  private maxDistance: number = 12;
  private minHeight: number = 0.8; // Minimum height to keep ground visible
  private maxHeight: number = 8;

  // World-space unit vector pointing from the player BACK toward the camera,
  // kept tangent to the sphere via parallel transport each frame. This replaces
  // the old world-anchored yaw frame, which made the camera sit at a fixed
  // world azimuth instead of following behind the player around the planet.
  private followDir: THREE.Vector3 | null = null;
  private followStrength: number = 2.5; // how quickly the camera swings behind motion

  // While riding a vehicle the player's own velocity is zero (GameScene owns
  // the transform), so the auto-follow has nothing to trail. GameScene feeds
  // the craft's travel velocity here so the chase cam still swings behind.
  private externalVelocity: THREE.Vector3 | null = null;
  private rideMode = false;
  private static readonly WALK_DISTANCE = 4.4;
  private static readonly WALK_HEIGHT = 1.5;
  private static readonly RIDE_DISTANCE = 10; // frames the faster craft (16u/s jetski)
  private static readonly RIDE_HEIGHT = 3.4;

  // Optional collision roots for the camera (terrain + props + the zone
  // landmark buildings, which live under the SCENE, not island.mesh): pull
  // the camera in whenever ANYTHING blocks the view ray to the player.
  private collisionRoots: THREE.Object3D[] = [];
  private raycaster: THREE.Raycaster = new THREE.Raycaster();

  constructor(camera: THREE.Camera, player: SimplePlayer) {
    this.camera = camera;
    this.player = player;

    // Initialize camera position
    this.updateCameraPosition(0);
  }

  /**
   * Provide the terrain mesh (and any extra roots, e.g. zone buildings) so
   * the camera can avoid clipping through them.
   */
  public setCollisionMesh(...roots: Array<THREE.Object3D | undefined>): void {
    this.collisionRoots = roots.filter((r): r is THREE.Object3D => !!r);
  }

  private _reducedVel = new THREE.Vector3();
  /** Feed an external motion vector for the chase-cam to trail (riding). */
  public setFollowVelocity(v: THREE.Vector3 | null): void {
    // Reduced motion: keep the chase-cam close to the craft (less swoop/trail)
    this.externalVelocity =
      v && a11y.reducedMotion ? this._reducedVel.copy(v).multiplyScalar(0.25) : v;
  }

  /** Pull the camera back a little for driving; restore on foot. */
  public setRideMode(on: boolean): void {
    if (on === this.rideMode) return;
    this.rideMode = on;
    this.distance = on ? OrbitCamera.RIDE_DISTANCE : OrbitCamera.WALK_DISTANCE;
    this.height = on ? OrbitCamera.RIDE_HEIGHT : OrbitCamera.WALK_HEIGHT;
  }

  /**
   * Update camera position based on player and orbit state.
   * Spherical-aware: uses the planet surface normal as "up" and keeps a
   * parallel-transported follow direction so the camera trails the player.
   */
  private updateCameraPosition(deltaTime: number): void {
    const playerPos = this.player.getWorldPosition();
    const surfaceNormal = this.player.getSurfaceNormal(); // "up" at player's location

    // --- Maintain the tangent follow direction ---
    if (!this.followDir) {
      // Seed (0,0,1): the spawn now sits ~7u EAST of the pole (the town hall
      // occupies the pole itself), so a +x seed would park the camera further
      // east looking straight back INTO the hall. +z puts the camera south of
      // the player — the first frame sweeps the open meadow with the hub
      // reduced to the frame edge (verified by capture after the spawn move).
      const seed = new THREE.Vector3(0, 0, 1);
      if (Math.abs(surfaceNormal.dot(seed)) > 0.9) seed.set(1, 0, 0);
      this.followDir = seed;
    }
    // Parallel transport: re-project onto the current tangent plane
    this.followDir.sub(surfaceNormal.clone().multiplyScalar(this.followDir.dot(surfaceNormal)));
    if (this.followDir.lengthSq() < 1e-6) {
      // Degenerate after projection — re-seed
      const seed = new THREE.Vector3(1, 0, 0);
      this.followDir.copy(seed).sub(surfaceNormal.clone().multiplyScalar(seed.dot(surfaceNormal)));
    }
    this.followDir.normalize();

    // Manual orbit: user yaw input rotates the follow direction around "up"
    if (Math.abs(this.yawVelocity) > 1e-5 && deltaTime > 0) {
      const yawQuat = new THREE.Quaternion().setFromAxisAngle(
        surfaceNormal,
        this.yawVelocity * deltaTime,
      );
      this.followDir.applyQuaternion(yawQuat);
    }

    // Auto-follow: swing behind the tangential motion. While riding, use
    // the vehicle's velocity (the player's own is zero); a stronger pull so
    // the chase cam keeps up with the faster craft.
    if (deltaTime > 0) {
      const vel = this.externalVelocity ? this.externalVelocity.clone() : this.player.getVelocity();
      const vTangent = vel.sub(surfaceNormal.clone().multiplyScalar(vel.dot(surfaceNormal)));
      if (vTangent.lengthSq() > 0.25) {
        const desired = vTangent.normalize().negate(); // behind the motion
        const strength = this.rideMode ? this.followStrength * 1.8 : this.followStrength;
        const k = Math.min(1, strength * deltaTime);
        this.followDir.lerp(desired, k).normalize();
      }
    }

    // --- Build the camera ray (pitch around the tangent right axis) ---
    const right = surfaceNormal.clone().cross(this.followDir).normalize();
    const pitchQuat = new THREE.Quaternion().setFromAxisAngle(right, this.pitch);
    const cameraDir = this.followDir.clone().applyQuaternion(pitchQuat).normalize();

    // Target point: player + up*height (toward torso level)
    this.targetPosition.copy(playerPos).addScaledVector(surfaceNormal, this.height * 0.5);

    // Camera collision: pull in when terrain or a building blocks the view ray
    let effectiveDistance = this.distance;
    if (this.collisionRoots.length > 0) {
      try {
        this.raycaster.set(this.targetPosition, cameraDir);
        this.raycaster.far = this.distance + 0.5;
        const hits = this.raycaster.intersectObjects(this.collisionRoots, true);
        if (hits.length > 0 && hits[0].distance < this.distance) {
          effectiveDistance = Math.max(this.minDistance, hits[0].distance * 0.9);
        }
      } catch {
        // collision is best-effort; keep full distance on raycast issues
      }
    }

    // Camera position
    this.cameraPosition.copy(this.targetPosition).addScaledVector(cameraDir, effectiveDistance);

    // Set camera up to match surface normal for correct lookAt()
    this.camera.up.copy(surfaceNormal);
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

    // Apply damping to velocities for smooth motion. Time-based, not
    // per-frame: `*= 0.9` each frame made the camera twice as stiff at 120Hz
    // as at 60Hz (phones are 90/120Hz now). exp(ln(d)*60*dt) reproduces the
    // 60Hz feel exactly at every refresh rate.
    const dampK = Math.exp(Math.log(this.damping) * 60 * safeDeltaTime);
    this.yawVelocity *= dampK;
    this.pitchVelocity *= dampK;

    // Two-finger pinch (SimpleInputManager publishes a consumable ratio):
    // spreading zooms in, pinching zooms out. setDistance keeps the 2–12
    // clamp, and the per-frame collision pull-in below is unaffected.
    const pinch = consumePinchZoomFactor();
    if (pinch !== 1) this.setDistance(this.distance * pinch);

    // Yaw is applied to the follow direction inside updateCameraPosition;
    // pitch accumulates here as before.
    this.pitch += this.pitchVelocity * safeDeltaTime;

    // Clamp pitch to valid range
    this.pitch = Math.max(this.minPitch, Math.min(this.maxPitch, this.pitch));

    // Validate distance and height with safeguards
    this.distance = Math.max(this.minDistance, Math.min(this.maxDistance, this.distance));
    this.height = Math.max(this.minHeight, Math.min(this.maxHeight, this.height));

    // Update camera position
    this.updateCameraPosition(safeDeltaTime);

    // Smooth transition of camera
    const currentCamPos = new THREE.Vector3();
    this.camera.getWorldPosition(currentCamPos);

    // Safety check: ensure values are finite
    if (!Number.isFinite(currentCamPos.x)) currentCamPos.copy(this.cameraPosition);
    if (!Number.isFinite(this.cameraPosition.x)) this.updateCameraPosition(0);

    // Same Hz-independence for the position ease: convert the tuned per-frame
    // factor (assumed 60Hz) into a rate, then apply it over the real dt.
    const smoothK =
      this.smoothness <= 0
        ? 0
        : 1 - Math.exp(Math.log(1 - Math.min(this.smoothness, 0.95)) * 60 * safeDeltaTime);
    currentCamPos.lerp(this.cameraPosition, smoothK);

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
   * Get camera forward direction projected onto the planet tangent plane
   */
  public getForwardDirection(): THREE.Vector3 {
    const surfaceNormal = this.player.getSurfaceNormal();
    const raw = this.targetPosition.clone().sub(this.cameraPosition).normalize();
    // Project onto tangent plane so movement stays on the surface
    const projected = raw.sub(surfaceNormal.clone().multiplyScalar(raw.dot(surfaceNormal)));
    const len = projected.length();
    return len > 0.001 ? projected.divideScalar(len) : raw;
  }

  /**
   * Get camera right direction projected onto the planet tangent plane
   */
  public getRightDirection(): THREE.Vector3 {
    const surfaceNormal = this.player.getSurfaceNormal();
    const forward = this.getForwardDirection();
    // up × forward gives the LEFTWARD vector — negate for rightward.
    // (This negation was documented but missing: A/D were inverted.)
    return surfaceNormal.clone().cross(forward).normalize().negate();
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
      const startPos = this.cameraPosition.clone();

      // Start from far away
      const farAwayPos = this.player
        .getWorldPosition()
        .clone()
        .add(targetOffset || new THREE.Vector3(0, 25, 40))
        .multiplyScalar(2.5);

      this.cameraPosition.copy(farAwayPos);
      this.camera.position.copy(farAwayPos);

      // Stall-immune clock: elapsed accrues from the FIRST animation frame
      // with per-frame deltas clamped to 100ms. A wall clock from call time
      // let first-render work (texture uploads, GLB decode) consume the
      // whole window before any frame drew — the fly-in appeared skipped.
      let elapsed = 0;
      let last: number | null = null;

      const animate = () => {
        const now = Date.now();
        if (last !== null) elapsed += Math.min(now - last, 100);
        last = now;
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
