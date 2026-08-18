import * as THREE from 'three';

import { a11y } from './Accessibility';
import { BASE_VFOV } from './Framing';
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
  // Bloom targets: distance/height ease toward these each frame (the slow-
  // bloom camera language) — ride swaps and pinch both write the TARGET, so
  // mode changes breathe instead of snapping and pinch gets a soft landing.
  private distanceTarget: number = 4.4;
  private heightTarget: number = 1.5;

  private yaw: number = 0; // horizontal rotation around player
  private pitch: number = -0.12; // vertical tilt: near eye-level (was -0.35, a downward/aerial look)

  private yawVelocity: number = 0;
  private pitchVelocity: number = 0;

  private yawInput: number = 0;
  private pitchInput: number = 0;

  private smoothness: number = 0.16; // interpolation factor for smooth camera — was 0.2; the slightly lazier follow is part of the calm-locomotion pass (pairs with the 8.0→5.6 walk speed)
  private damping: number = 0.9; // velocity damping (higher = more responsive)
  private mouseSensitivity: number = 0.005; // mouse input multiplier (raw pixels -> radians)
  // True only while flyInFromDistant owns the camera. The intro fly-in runs on
  // its OWN requestAnimationFrame loop and writes camera.position directly; the
  // main render loop still calls update() every frame (cameraSuspended is false
  // during the intro), so WITHOUT this guard the follow-camera drags each
  // fly-in pose toward the settled follow pose by a variable per-frame amount —
  // two writers on two rAF loops, i.e. the frame-to-frame pose noise that reads
  // as the "juddery / feels-doubled" reveal. update() no-ops while this holds so
  // the swoop is the fly-in's alone.
  private flyingIn = false;

  private minPitch: number = -0.18; // Don't look too far down (prevents ground clipping)
  private maxPitch: number = Math.PI * 0.25; // Don't look too far up
  // Public statics so world-size-derived formulas (camNearThreshold in
  // WorldPlacement.ts) can reason about the chase cam's worst-case reach
  // without a live camera instance.
  public static readonly MAX_DISTANCE = 12;
  public static readonly MAX_HEIGHT = 8;
  private minDistance: number = 2;
  private maxDistance: number = OrbitCamera.MAX_DISTANCE;
  private minHeight: number = 0.8; // Minimum height to keep ground visible
  private maxHeight: number = OrbitCamera.MAX_HEIGHT;

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
   *
   * Flattened ONCE here rather than walked recursively per frame: the island
   * group holds thousands of children at R=75 and `intersectObjects(...,
   * recursive)` was a full-graph traversal every frame. Meshes that opted out
   * of raycasting via an own-property no-op `raycast` (grass chunks, sea) are
   * skipped, as is anything too small to meaningfully block a view ray —
   * except the FIRST root (the terrain), which is always included.
   */
  public setCollisionMesh(...roots: Array<THREE.Object3D | undefined>): void {
    this.collisionRoots = roots.filter((r): r is THREE.Object3D => !!r);
    const flat: THREE.Mesh[] = [];
    const MIN_BLOCKING_RADIUS = 1.2;
    this.collisionRoots.forEach((root, rootIndex) => {
      root.traverse((o: THREE.Object3D) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh || !m.geometry) return;
        // Own-property raycast = an explicit opt-out (the prototype's raycast
        // is the BVH-accelerated real one).
        if (Object.prototype.hasOwnProperty.call(m, 'raycast')) return;
        if (rootIndex > 0 || m !== root) {
          if (!m.geometry.boundingSphere) m.geometry.computeBoundingSphere();
          const r = m.geometry.boundingSphere?.radius ?? 0;
          const s = m.getWorldScale(this._flattenScale);
          // The size filter applies to EVERY root. The old `&& rootIndex !== 0`
          // escape hatch was meant to exempt "the FIRST root (the terrain)",
          // but roots[0] is the island GROUP, so it exempted every descendant
          // — houses, stalls, coins, flowers, fauna — and left ~1,600 meshes
          // being bounding-sphere tested EVERY frame by the chase camera.
          // Nothing under 1.2u can meaningfully block a view ray, and the
          // terrain's own sphere (~109u at R=100) passes on its own merits.
          if (r * Math.max(s.x, s.y, s.z) < MIN_BLOCKING_RADIUS) return;
        }
        flat.push(m);
      });
    });
    this.collisionMeshes = flat;
    this.raycaster.firstHitOnly = true; // BVH fast path on the terrain leg
  }

  private collisionMeshes: THREE.Mesh[] = [];
  private _flattenScale = new THREE.Vector3();

  private _reducedVel = new THREE.Vector3();
  /** Feed an external motion vector for the chase-cam to trail (riding). */
  public setFollowVelocity(v: THREE.Vector3 | null): void {
    // Reduced motion: keep the chase-cam close to the craft (less swoop/trail)
    this.externalVelocity =
      v && a11y.reducedMotion ? this._reducedVel.copy(v).multiplyScalar(0.25) : v;
  }

  // Look-ahead state (see updateCameraPosition) + the ride FOV ease.
  private lookAhead = new THREE.Vector3();
  private _lookAheadTarget = new THREE.Vector3();

  // Per-frame scratch (updateCameraPosition + update ran ~10 heap
  // allocations per frame — the densest cluster in the codebase; same
  // convention as SimplePlayer's _normalScratch/_vecScratch).
  private _camPlayerPos = new THREE.Vector3();
  private _camNormal = new THREE.Vector3();
  private _camVel = new THREE.Vector3();
  private _camRight = new THREE.Vector3();
  private _camDir = new THREE.Vector3();
  private _desired = new THREE.Vector3();
  private _currentCamPos = new THREE.Vector3();
  private _quat = new THREE.Quaternion();
  private baseFov = 0; // captured on first ride; 0 = fov untouched so far
  private fovTarget = 0;

  /** Pull the camera back a little for driving; restore on foot. Also eases
   *  the FOV out a touch while riding (speed reads as speed) — skipped under
   *  reduced motion, and a no-op for non-perspective cameras. */
  public setRideMode(on: boolean): void {
    if (on === this.rideMode) return;
    this.rideMode = on;
    // Bloom, don't snap: write the TARGETS and let update() breathe the
    // frame out/in over ~1.5s (reduced motion keeps the old instant swap).
    this.distanceTarget = on ? OrbitCamera.RIDE_DISTANCE : OrbitCamera.WALK_DISTANCE;
    this.heightTarget = on ? OrbitCamera.RIDE_HEIGHT : OrbitCamera.WALK_HEIGHT;
    if (a11y.reducedMotion) {
      this.distance = this.distanceTarget;
      this.height = this.heightTarget;
    }
    const cam = this.camera as THREE.PerspectiveCamera;
    if (!cam.isPerspectiveCamera || a11y.reducedMotion) return;
    // baseFov used to be captured HERE, on the first ride only — so a resize
    // before you ever boarded anything baked the wrong base in forever. It is
    // seeded from the live camera on first use instead, and setBaseFov (the
    // aspect-aware framing path) is now its owner.
    if (!this.baseFov) this.baseFov = cam.fov;
    this.fovTarget = on ? this.baseFov + 6 : this.baseFov;
  }

  /** Live base fov, for callers that need to snapshot it (the NPC push-in)
   *  rather than reading the momentary animated cam.fov. */
  public getBaseFov(): number {
    const cam = this.camera as THREE.PerspectiveCamera;
    if (!this.baseFov && cam.isPerspectiveCamera) this.baseFov = cam.fov;
    return this.baseFov || BASE_VFOV;
  }

  /**
   * SINGLE OWNER of the resting fov (aspect-aware framing calls this).
   * Re-derives fovTarget rather than snapping cam.fov, so it composes with the
   * ride bloom and the NPC push-in instead of fighting them: if the camera is
   * currently offset from its base (riding), the same offset is preserved
   * against the new base.
   */
  public setBaseFov(deg: number): void {
    const cam = this.camera as THREE.PerspectiveCamera;
    if (!cam.isPerspectiveCamera) return;
    const prevBase = this.getBaseFov();
    if (Math.abs(prevBase - deg) < 0.01) return;
    const offset = this.fovTarget ? this.fovTarget - prevBase : 0;
    this.baseFov = deg;
    if (this.fovTarget) {
      this.fovTarget = deg + offset;
    } else {
      // Nothing is animating fov — apply immediately so the first frame after
      // a resize is already correctly framed.
      cam.fov = deg;
      cam.updateProjectionMatrix();
    }
  }

  /** Per-frame FOV ease toward fovTarget (frame-rate independent). Rate 1.6
   *  — slowed from 4 alongside the ride bloom so speed swells in rather
   *  than kicking. */
  private updateFov(deltaTime: number): void {
    const cam = this.camera as THREE.PerspectiveCamera;
    if (!cam.isPerspectiveCamera || this.fovTarget === 0) return;
    const next = this.fovTarget + (cam.fov - this.fovTarget) * Math.exp(-1.6 * deltaTime);
    if (Math.abs(next - cam.fov) > 0.01) {
      cam.fov = next;
      cam.updateProjectionMatrix();
    }
  }

  /**
   * Update camera position based on player and orbit state.
   * Spherical-aware: uses the planet surface normal as "up" and keeps a
   * parallel-transported follow direction so the camera trails the player.
   */
  private updateCameraPosition(deltaTime: number): void {
    const playerPos = this.player.getWorldPositionInto(this._camPlayerPos);
    const surfaceNormal = this.player.getSurfaceNormalInto(this._camNormal); // "up" here

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
    // (addScaledVector(n, -v·n) — the allocation-free projection idiom).
    this.followDir.addScaledVector(surfaceNormal, -this.followDir.dot(surfaceNormal));
    if (this.followDir.lengthSq() < 1e-6) {
      // Degenerate after projection — re-seed (cold path, alloc is fine)
      const seed = new THREE.Vector3(1, 0, 0);
      this.followDir.copy(seed).addScaledVector(surfaceNormal, -seed.dot(surfaceNormal));
    }
    this.followDir.normalize();

    // Manual orbit: user yaw input rotates the follow direction around "up"
    if (Math.abs(this.yawVelocity) > 1e-5 && deltaTime > 0) {
      const yawQuat = this._quat.setFromAxisAngle(surfaceNormal, this.yawVelocity * deltaTime);
      this.followDir.applyQuaternion(yawQuat);
    }

    // Auto-follow: swing behind the tangential motion. While riding, use
    // the vehicle's velocity (the player's own is zero); a stronger pull so
    // the chase cam keeps up with the faster craft.
    if (deltaTime > 0) {
      // COPY into scratch, never mutate in place: setFollowVelocity stores
      // GameScene's vector by REFERENCE, and the projection below mutates.
      const vTangent = this.externalVelocity
        ? this._camVel.copy(this.externalVelocity)
        : this.player.getVelocityInto(this._camVel);
      vTangent.addScaledVector(surfaceNormal, -vTangent.dot(surfaceNormal));
      if (vTangent.lengthSq() > 0.25) {
        const desired = this._desired.copy(vTangent).normalize().negate(); // behind the motion
        const strength = this.rideMode ? this.followStrength * 1.8 : this.followStrength;
        const k = Math.min(1, strength * deltaTime);
        this.followDir.lerp(desired, k).normalize();
      }
      // Velocity look-ahead: bias the look target along the (tangent-plane)
      // motion so the camera frames where you're GOING, not where you are.
      // Spring-smoothed via frame-rate-independent decay — raw velocity would
      // twitch the frame on every collision nudge. Reduced motion trims it
      // the same way setFollowVelocity does.
      const aheadCap = this.rideMode ? 2.4 : 1.4;
      const scale = a11y.reducedMotion ? 0.25 : 1;
      this._lookAheadTarget
        .copy(vTangent)
        .multiplyScalar(0.16 * scale)
        .clampLength(0, aheadCap * scale);
      const lk = 1 - Math.exp(-3.5 * deltaTime);
      this.lookAhead.lerp(this._lookAheadTarget, lk);
    }

    // --- Build the camera ray (pitch around the tangent right axis) ---
    // (_quat is safe to reuse here — its yaw use above is fully consumed.)
    const right = this._camRight.copy(surfaceNormal).cross(this.followDir).normalize();
    const pitchQuat = this._quat.setFromAxisAngle(right, this.pitch);
    const cameraDir = this._camDir.copy(this.followDir).applyQuaternion(pitchQuat).normalize();

    // Target point: player + up*height (toward torso level) + look-ahead
    this.targetPosition
      .copy(playerPos)
      .addScaledVector(surfaceNormal, this.height * 0.5)
      .add(this.lookAhead);

    // Point-of-interest bias (feed piles etc): ease a bounded fraction of
    // the look target toward the focus point so the camera acknowledges the
    // little scene without taking control. Eases in AND out (the amount
    // keeps decaying to the target 0/1), reduced-motion-trimmed like the
    // look-ahead above.
    if (deltaTime > 0) {
      // Slow bloom in (~2s to full interest), slightly quicker fade out —
      // the camera drifts its attention over rather than flicking it.
      const fk = 1 - Math.exp(-(this.focusActive ? 1.1 : 2.0) * deltaTime);
      this.focusAmt += ((this.focusActive ? 1 : 0) - this.focusAmt) * fk;
      if (this.focusAmt > 0.001) {
        this._focusBias.subVectors(this.focusTarget, this.targetPosition).clampLength(0, 2.4);
        const fScale = a11y.reducedMotion ? 0.25 : 1;
        this.targetPosition.addScaledVector(this._focusBias, 0.38 * this.focusAmt * fScale);
      }
    }

    // Camera collision: pull in when terrain or a building blocks the view ray
    let effectiveDistance = this.distance;
    if (this.collisionMeshes.length > 0) {
      try {
        this.raycaster.set(this.targetPosition, cameraDir);
        this.raycaster.far = this.distance + 0.5;
        const hits = this.raycaster.intersectObjects(this.collisionMeshes, false);
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

  // Point-of-interest state: the last focus point sticks around while the
  // bias fades out, so clearing the focus never snaps the frame.
  private readonly focusTarget = new THREE.Vector3();
  private focusActive = false;
  private focusAmt = 0;
  private readonly _focusBias = new THREE.Vector3();

  /** Hard-cut the camera to its computed follow pose (no ease) — used when
   *  returning from the interior room 300u below the island, where the
   *  position lerp would visibly swoop up through the terrain. */
  public snapToPlayer(): void {
    this.updateCameraPosition(0);
    if (Number.isFinite(this.cameraPosition.x)) this.camera.position.copy(this.cameraPosition);
    if (Number.isFinite(this.targetPosition.x)) this.camera.lookAt(this.targetPosition);
  }

  /** Soft camera interest in a world point (null = fade back out). */
  public setFocusPoint(p: THREE.Vector3 | null): void {
    if (p) {
      this.focusTarget.copy(p);
      this.focusActive = true;
    } else {
      this.focusActive = false;
    }
  }

  /**
   * Update camera in response to player movement and input
   */
  public update(deltaTime: number, _input?: { moveX?: number; moveY?: number }): void {
    if (deltaTime <= 0) return;
    // The intro fly-in owns the camera on its own rAF loop; the follow-update
    // must stand down or the two fight every frame (see flyingIn). Resumes
    // seamlessly — the fly-in ends exactly on the follow pose it started from.
    if (this.flyingIn) return;

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
    if (pinch !== 1) this.setDistance(this.distanceTarget * pinch);

    // Yaw is applied to the follow direction inside updateCameraPosition;
    // pitch accumulates here as before.
    this.pitch += this.pitchVelocity * safeDeltaTime;

    // Clamp pitch to valid range
    this.pitch = Math.max(this.minPitch, Math.min(this.maxPitch, this.pitch));

    // Slow-bloom frame: distance/height breathe toward their targets (ride
    // boards, pinch) at ~1.5s to settle. Pinch still lands quickly enough to
    // feel direct; the collision pull-in downstream stays instant.
    const bloomK = 1 - Math.exp(-1.6 * safeDeltaTime);
    this.distance += (this.distanceTarget - this.distance) * bloomK;
    this.height += (this.heightTarget - this.height) * bloomK;

    // Validate distance and height with safeguards
    this.distance = Math.max(this.minDistance, Math.min(this.maxDistance, this.distance));
    this.height = Math.max(this.minHeight, Math.min(this.maxHeight, this.height));

    // Update camera position
    this.updateCameraPosition(safeDeltaTime);

    // Ride FOV ease (no-op until the first ride; reduced-motion never arms it)
    this.updateFov(safeDeltaTime);

    // Smooth transition of camera
    const currentCamPos = this._currentCamPos;
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
    this.distanceTarget = Math.max(this.minDistance, Math.min(this.maxDistance, distance || 6));
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
    this.heightTarget = Math.max(this.minHeight, Math.min(this.maxHeight, height || 1.5));
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
      // Defence-in-depth: the caller gates the fly-in behind reducedMotion
      // today (main-simple intro), but the primitive itself must never fly
      // under the setting either — the gate should not live one file away
      // from the motion it guards.
      if (a11y.reducedMotion) {
        this.snapToPlayer();
        resolve();
        return;
      }
      const startPos = this.cameraPosition.clone();

      // Start from far away
      const farAwayPos = this.player
        .getWorldPosition()
        .clone()
        .add(targetOffset || new THREE.Vector3(0, 25, 40))
        .multiplyScalar(2.5);

      this.cameraPosition.copy(farAwayPos);
      this.camera.position.copy(farAwayPos);

      // Take the camera off the follow-update for the duration of the swoop —
      // update() no-ops while this holds, so the fly-in is the SOLE writer and
      // its smooth lerp is what renders (not a lerp fighting the follow).
      this.flyingIn = true;

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
          // Hand the camera back to the follow-update on the pose the swoop
          // ended on (== startPos, the settled follow pose) — seamless resume.
          this.flyingIn = false;
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
