import * as THREE from 'three';

import { a11y } from './Accessibility';
import { BASE_VFOV } from './Framing';
import { expDecay } from './Juice';
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

  private pitch: number = OrbitCamera.DEFAULT_PITCH; // vertical tilt: near eye-level (was -0.35, a downward/aerial look)
  private static readonly DEFAULT_PITCH = -0.12;

  // ---- Look: displacement, not velocity ---------------------------------
  // Drag, swipe and keyboard look ACCUMULATE into a target, in radians, and
  // update() closes the gap with a = 1 − exp(−dt/τ). The turn therefore
  // depends only on how far the pointer moved, never on how many frames it
  // took: the old model set a velocity from each frame's pixels and decayed
  // it per frame, so 300 px turned anything from 0° to ~21° depending on
  // frame timing, and a 1-frame flick barely turned at all.
  // Yaw convention (three.js): + turns the follow direction counter-clockwise
  // about the local up, i.e. the VIEW turns LEFT.
  private yawTarget = 0;
  private yawApplied = 0;
  // Applied yaw that followDir has not turned through yet (updateCameraPosition).
  private yawStepPending = 0;
  private pitchTarget = OrbitCamera.DEFAULT_PITCH;
  private lookTau = OrbitCamera.MOUSE_TAU;
  private static readonly MOUSE_TAU = 0.04; // s
  private static readonly TOUCH_TAU = 0.07; // s
  private static readonly RECENTRE_TAU = 0.06; // s: R lands behind the player in ~0.3 s
  private static readonly PITCH_SCALE = 0.8;
  // Touch fling: after a fast swipe the view keeps turning at ω (rad/s, same
  // sign convention as yaw), decaying by exp(−dt/0.15 s), 30° at most in all.
  private yawVelocity: number = 0;
  private flingLeft = 0;
  private static readonly FLING_TAU = 0.15;
  private static readonly FLING_CAP = (30 * Math.PI) / 180;
  // Auto-follow stands down after any manual look: 0 for 1.0 s, then ramps
  // back over 0.8 s, so a look around is never dragged back mid-glance.
  private sinceManualLook = Number.POSITIVE_INFINITY;
  private static readonly FOLLOW_HOLD_S = 1.0;
  private static readonly FOLLOW_RAMP_S = 0.8;

  // ---- Follow: only motion AWAY from the camera, at a capped rate --------
  // The follow swung the camera behind ANY motion, so holding D (strafe)
  // turned the view at ~145°/s and walked the avatar round in a circle.
  // Now a sideways or backward step leaves the camera be; motion away from
  // it is followed through a smoothstep gate, at most 1.2 rad/s on foot and
  // 2.4 rad/s riding.
  private static readonly FOLLOW_CAP_FOOT = 1.2; // rad/s
  private static readonly FOLLOW_CAP_RIDE = 2.4; // rad/s
  private static readonly FOLLOW_CAP_RIDE_REDUCED = 0.6; // rad/s
  // This frame's movement input in the camera's frame (setMoveInput).
  private moveForward = 0;
  private moveStrafe = 0;
  // The follow pauses for 0.35 s after the input direction turns > 45°.
  private moveRefAngle: number | null = null;
  private followHold = 0;
  private static readonly TURN_HOLD_S = 0.35;
  private static readonly TURN_HOLD_ANGLE = Math.PI / 4;
  // Reduced motion never follows on foot; once the visitor has stood still
  // for 0.5 s, the camera recentres behind their facing at under 34°/s, once
  // per stop (a manual look cancels it).
  private sinceMoveInput = Number.POSITIVE_INFINITY;
  private reducedRecentrePending = false;
  private static readonly REDUCED_IDLE_S = 0.5;
  private static readonly REDUCED_RECENTRE_RATE = 0.59; // rad/s
  // A frame the world takes no input (holdMoveInput) is not a still frame:
  // the movement tracker and the recentre sit it out. `moveHeld` is the
  // request, `inputHeld` what this update() read from it.
  private moveHeld = false;
  private inputHeld = false;

  private smoothness: number = 0.16; // interpolation factor for smooth camera — was 0.2; the slightly lazier follow is part of the calm-locomotion pass (pairs with the 8.0→5.6 walk speed)
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
  // Look scratch (orbitLive, recentre): declared here, outside the
  // allocation-free updateCameraPosition body.
  private _orbitOff = new THREE.Vector3();
  private _orbitQuat = new THREE.Quaternion();
  private _rcNormal = new THREE.Vector3();
  private _rcFacing = new THREE.Vector3();
  private _rcFollow = new THREE.Vector3();
  private _rcCross = new THREE.Vector3();
  private _followCross = new THREE.Vector3();
  private _followQuat = new THREE.Quaternion();
  // The look target last frame, for the reduced-motion carry in update().
  private _prevTarget = new THREE.Vector3();
  private _rmStep = new THREE.Vector3();
  private hasPrevTarget = false;
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
    // Bit-identical to the old inline `fovTarget + (fov-fovTarget)*exp(-1.6*dt)`
    // — expDecay IS that Form-A expression (Juice.ts). The other camera easings
    // stay inline: they use the 1-exp lerp FACTOR form, which rounds differently
    // and would nudge feel if force-fit onto this helper.
    const next = expDecay(cam.fov, this.fovTarget, 1.6, deltaTime);
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

    // Manual look: turn the follow direction about "up" through the yaw that
    // update() applied this frame (parallel transport is kept above).
    if (this.yawStepPending !== 0) {
      const yawQuat = this._quat.setFromAxisAngle(surfaceNormal, this.yawStepPending);
      this.followDir.applyQuaternion(yawQuat).normalize();
      this.yawStepPending = 0;
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
        // Only motion AWAY from the camera is followed: away is 1 walking
        // straight away, 0 sideways or toward the camera.
        const vDir = this._desired.copy(vTangent).normalize();
        const away = Math.min(1, Math.max(0, -vDir.dot(this.followDir)));
        const strength = this.followStrengthFor(away);
        if (strength > 0) {
          // behind the motion, by a capped angular step
          this.turnFollowToward(vDir.negate(), surfaceNormal, strength, deltaTime);
        }
      }
      if (this.reducedRecentreDue()) this.reducedRecentreStep(surfaceNormal, deltaTime);
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

    // Touch fling: keep turning after a fast swipe, ω decaying by
    // exp(−dt/0.15 s), never more than 30° in all. It feeds the yaw TARGET,
    // so the same easing below carries it.
    if (this.yawVelocity !== 0) {
      let step = this.yawVelocity * safeDeltaTime;
      if (Math.abs(step) >= this.flingLeft) step = Math.sign(step) * this.flingLeft;
      this.flingLeft -= Math.abs(step);
      this.yawTarget += step;
      this.yawVelocity *= Math.exp(-safeDeltaTime / OrbitCamera.FLING_TAU);
      if (this.flingLeft <= 1e-6 || Math.abs(this.yawVelocity) < 0.01) {
        this.yawVelocity = 0;
        this.flingLeft = 0;
      }
      this.sinceManualLook = 0;
    } else {
      this.sinceManualLook += safeDeltaTime;
    }

    // Close the gap to the look target. a = 1 − exp(−dt/τ) is frame-rate
    // independent: the same drag ends on the same yaw at 30, 60 or 120 Hz.
    const a = 1 - Math.exp(-safeDeltaTime / this.lookTau);
    // Within 1e-5 rad (0.0006°) the step lands exactly: no endless tail.
    let yawStep = (this.yawTarget - this.yawApplied) * a;
    if (Math.abs(this.yawTarget - this.yawApplied - yawStep) < 1e-5) {
      yawStep = this.yawTarget - this.yawApplied;
    }
    this.yawApplied += yawStep;
    this.yawStepPending += yawStep; // updateCameraPosition turns followDir through it
    const pitchBefore = this.pitch;
    this.pitch += (this.pitchTarget - this.pitch) * a;
    if (Math.abs(this.pitchTarget - this.pitch) < 1e-5) this.pitch = this.pitchTarget;

    // Two-finger pinch (SimpleInputManager publishes a consumable ratio):
    // spreading zooms in, pinching zooms out. setDistance keeps the 2–12
    // clamp, and the per-frame collision pull-in below is unaffected.
    const pinch = consumePinchZoomFactor();
    if (pinch !== 1) this.setDistance(this.distanceTarget * pinch);

    // Clamp pitch to valid range
    this.pitch = Math.max(this.minPitch, Math.min(this.maxPitch, this.pitch));
    const pitchStep = this.pitch - pitchBefore;

    // Slow-bloom frame: distance/height breathe toward their targets (ride
    // boards, pinch) at ~1.5s to settle. Pinch still lands quickly enough to
    // feel direct; the collision pull-in downstream stays instant.
    const bloomK = 1 - Math.exp(-1.6 * safeDeltaTime);
    this.distance += (this.distanceTarget - this.distance) * bloomK;
    this.height += (this.heightTarget - this.height) * bloomK;

    // Validate distance and height with safeguards
    this.distance = Math.max(this.minDistance, Math.min(this.maxDistance, this.distance));
    this.height = Math.max(this.minHeight, Math.min(this.maxHeight, this.height));

    // Movement input this frame: the follow's turn hold and the
    // reduced-motion recentre clock.
    this.trackMoveInput(safeDeltaTime);

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

    // Manual look turns the live camera RIGIDLY with the pose, about the look
    // target. Left to the position ease below, a quick turn cut the chord of
    // the orbit (the camera swung in toward the avatar) and trailed the
    // applied yaw by ~0.1 s.
    if (yawStep !== 0 || pitchStep !== 0) this.orbitLive(currentCamPos, yawStep, pitchStep);

    // Reduced motion: the live camera travels WITH the visitor across the
    // ground instead of trailing them, so walking off never swings the view
    // (the trail turned it ~10° in the first half-second of a strafe). Only
    // the tangential part: jumps and slopes still ease, as before.
    if (a11y.reducedMotion && this.hasPrevTarget) {
      const step = this._rmStep.subVectors(this.targetPosition, this._prevTarget);
      step.addScaledVector(this._camNormal, -step.dot(this._camNormal));
      if (step.lengthSq() < 4) currentCamPos.add(step); // a teleport is a snap's job
    }
    this._prevTarget.copy(this.targetPosition);
    this.hasPrevTarget = true;

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
  }

  /** Rotate a live camera position about the look target: yaw about the
   *  surface normal, then pitch about the camera's right (both as
   *  updateCameraPosition just left them in _camNormal and _camRight). */
  private orbitLive(p: THREE.Vector3, yawStep: number, pitchStep: number): void {
    const off = this._orbitOff.subVectors(p, this.targetPosition);
    if (yawStep !== 0)
      off.applyQuaternion(this._orbitQuat.setFromAxisAngle(this._camNormal, yawStep));
    if (pitchStep !== 0) {
      off.applyQuaternion(this._orbitQuat.setFromAxisAngle(this._camRight, pitchStep));
    }
    p.copy(this.targetPosition).add(off);
  }

  /** 0 for 1.0 s after any manual look, then a linear ramp back to 1 over 0.8 s. */
  private followGain(): number {
    const t = this.sinceManualLook - OrbitCamera.FOLLOW_HOLD_S;
    return t <= 0 ? 0 : Math.min(1, t / OrbitCamera.FOLLOW_RAMP_S);
  }

  /**
   * How hard the camera swings behind motion that is `away` (0..1) from it:
   * the follow strength (1.8× riding) through smoothstep(0.35, 0.9, away),
   * times the manual-look hold. Zero while the input direction has just
   * turned, and on foot under reduced motion.
   */
  private followStrengthFor(away: number): number {
    if (a11y.reducedMotion && !this.rideMode) return 0;
    if (this.followHold > 0) return 0;
    const t = Math.min(1, Math.max(0, (away - 0.35) / (0.9 - 0.35)));
    const gate = t * t * (3 - 2 * t);
    const base = this.rideMode ? this.followStrength * 1.8 : this.followStrength;
    return base * gate * this.followGain();
  }

  /**
   * Turn followDir toward `desired` about `n` by min(angle·(1 − e^(−strength·dt)),
   * cap·dt): the old lerp-and-normalize, with its angular speed capped at
   * 1.2 rad/s on foot, 2.4 riding (0.6 riding under reduced motion).
   */
  private turnFollowToward(
    desired: THREE.Vector3,
    n: THREE.Vector3,
    strength: number,
    dt: number,
  ): void {
    const fd = this.followDir;
    if (!fd) return;
    const cap = !this.rideMode
      ? OrbitCamera.FOLLOW_CAP_FOOT
      : a11y.reducedMotion
        ? OrbitCamera.FOLLOW_CAP_RIDE_REDUCED
        : OrbitCamera.FOLLOW_CAP_RIDE;
    const angle = Math.atan2(this._followCross.copy(fd).cross(desired).dot(n), fd.dot(desired));
    const step = Math.min(Math.abs(angle) * (1 - Math.exp(-strength * dt)), cap * dt);
    if (step > 0) {
      fd.applyQuaternion(this._followQuat.setFromAxisAngle(n, Math.sign(angle) * step)).normalize();
    }
  }

  /** Reduced motion, on foot, idle for 0.5 s since moving, no manual look
   *  since, and the world listening this frame (holdMoveInput). */
  private reducedRecentreDue(): boolean {
    return (
      this.reducedRecentrePending &&
      !this.inputHeld &&
      a11y.reducedMotion &&
      !this.rideMode &&
      this.sinceMoveInput >= OrbitCamera.REDUCED_IDLE_S
    );
  }

  /** One frame of the reduced-motion recentre: behind the player's facing, ≤ 0.59 rad/s. */
  private reducedRecentreStep(n: THREE.Vector3, dt: number): void {
    const fd = this.followDir;
    const behind = this.player.getWorldDirection(this._rcFacing);
    behind.addScaledVector(n, -behind.dot(n));
    if (!fd || behind.lengthSq() < 1e-8) {
      this.reducedRecentrePending = false;
      return;
    }
    behind.normalize().negate();
    const angle = Math.atan2(this._followCross.copy(fd).cross(behind).dot(n), fd.dot(behind));
    const step = Math.min(Math.abs(angle), OrbitCamera.REDUCED_RECENTRE_RATE * dt);
    if (step > 0) {
      fd.applyQuaternion(this._followQuat.setFromAxisAngle(n, Math.sign(angle) * step)).normalize();
    }
    if (Math.abs(angle) - step < 0.005) this.reducedRecentrePending = false;
  }

  /**
   * This frame's movement input in the camera's frame, from main-simple: on
   * foot the keys plus the stick, riding the throttle and steering. Read and
   * cleared by update(): when the input direction turns by more than 45° the
   * follow waits 0.35 s, and under reduced motion the camera recentres once
   * the visitor has had no input for 0.5 s.
   */
  public setMoveInput(forward: number, strafe: number): void {
    this.moveForward = Number.isFinite(forward) ? forward : 0;
    this.moveStrafe = Number.isFinite(strafe) ? strafe : 0;
  }

  /**
   * This frame the world takes no input: a panel that is not walkable, the
   * welcome card or the loader owns the moment (main-simple's holdWorldInput).
   * That is not a stop: the visitor did not stand still, the world stopped
   * listening. Counted as idle, these frames used to set off the
   * reduced-motion recentre 0.5 s after a panel opened, turning the camera
   * behind it. Now the movement tracker skips them and the recentre waits:
   * once input is back, the idle clock carries on from where it stopped, and
   * a recentre that was under way finishes. Read and cleared by update(),
   * like setMoveInput.
   */
  public holdMoveInput(): void {
    this.moveHeld = true;
  }

  /** Track the movement input for the follow's turn hold and the reduced-motion recentre. */
  private trackMoveInput(dt: number): void {
    this.inputHeld = this.moveHeld;
    this.moveHeld = false;
    if (this.inputHeld) {
      // Paused, not idle: the idle clock, the turn hold and its reference
      // direction all keep their values.
      this.moveForward = 0;
      this.moveStrafe = 0;
      return;
    }
    this.followHold = Math.max(0, this.followHold - dt);
    if (Math.hypot(this.moveForward, this.moveStrafe) > 0.1) {
      const ang = Math.atan2(this.moveStrafe, this.moveForward);
      if (this.moveRefAngle === null) {
        this.moveRefAngle = ang;
      } else {
        let d = ang - this.moveRefAngle;
        d = Math.atan2(Math.sin(d), Math.cos(d));
        if (Math.abs(d) > OrbitCamera.TURN_HOLD_ANGLE) {
          this.followHold = OrbitCamera.TURN_HOLD_S;
          this.moveRefAngle = ang;
        }
      }
      this.sinceMoveInput = 0;
      if (a11y.reducedMotion && !this.rideMode) this.reducedRecentrePending = true;
    } else {
      this.moveRefAngle = null;
      this.sinceMoveInput += dt;
    }
    this.moveForward = 0;
    this.moveStrafe = 0;
  }

  /**
   * Look input, in RADIANS: deltaYaw > 0 turns the view right, deltaPitch > 0
   * moves the camera as a downward drag does (pitch × 0.8). It accumulates
   * into the look target; update() eases onto it with τ = 40 ms for a mouse
   * (or keys) and 70 ms for a finger. Ignored during the intro fly-in, so a
   * drag there cannot land as one whip when it ends.
   */
  public setInput(deltaYaw: number, deltaPitch: number, source: 'mouse' | 'touch' = 'mouse'): void {
    if (this.flyingIn) return;
    const dYaw = Number.isFinite(deltaYaw) ? deltaYaw : 0;
    const dPitch = Number.isFinite(deltaPitch) ? deltaPitch : 0;
    if (dYaw === 0 && dPitch === 0) return;
    // + deltaYaw turns the view right: the follow direction turns clockwise
    // about up, which is negative in this file's (three.js) convention.
    this.yawTarget -= dYaw;
    this.pitchTarget = Math.max(
      this.minPitch,
      Math.min(this.maxPitch, this.pitchTarget + dPitch * OrbitCamera.PITCH_SCALE),
    );
    this.lookTau = source === 'touch' ? OrbitCamera.TOUCH_TAU : OrbitCamera.MOUSE_TAU;
    // A finger back on the glass catches a fling, as on any touch list.
    this.yawVelocity = 0;
    this.flingLeft = 0;
    this.sinceManualLook = 0;
    this.reducedRecentrePending = false; // a manual look wins over the recentre
  }

  /**
   * Keyboard look, per frame while the keys are held: `turn` > 0 (L) turns
   * right at 90°/s, `tilt` > 0 (I) tilts the view up at 60°/s, inside the
   * same pitch clamp. Counts as a manual look.
   */
  public keyLook(turn: number, tilt: number, dt: number): void {
    if (this.flyingIn || (turn === 0 && tilt === 0) || !(dt > 0)) return;
    const step = Math.min(dt, 0.1);
    this.yawTarget -= turn * OrbitCamera.KEY_TURN_RATE * step;
    this.pitchTarget = Math.max(
      this.minPitch,
      Math.min(this.maxPitch, this.pitchTarget + tilt * OrbitCamera.KEY_TILT_RATE * step),
    );
    this.lookTau = OrbitCamera.MOUSE_TAU;
    this.yawVelocity = 0;
    this.flingLeft = 0;
    this.sinceManualLook = 0;
    this.reducedRecentrePending = false; // a manual look wins over the recentre
  }
  private static readonly KEY_TURN_RATE = Math.PI / 2; // 90°/s
  private static readonly KEY_TILT_RATE = Math.PI / 3; // 60°/s

  /**
   * Start a touch fling at `rate` rad/s (> 0 keeps turning right). No fling
   * under reduced motion, or with the lookFling effect switched off
   * (globalThis.__dsFx.lookFling === false; FxBudget registers it later).
   */
  public fling(rate: number): void {
    if (!Number.isFinite(rate) || rate === 0 || this.flyingIn || a11y.reducedMotion) return;
    const fx = (globalThis as { __dsFx?: { lookFling?: boolean } }).__dsFx;
    if (fx?.lookFling === false) return;
    this.yawVelocity = -rate;
    this.flingLeft = OrbitCamera.FLING_CAP;
    this.sinceManualLook = 0;
    this.reducedRecentrePending = false; // a manual look wins over the recentre
  }

  /**
   * R: put the camera back behind the player's facing, at the default tilt,
   * over ~0.3 s (a hard cut under reduced motion). Counts as a manual look.
   */
  public recentre(): void {
    if (!this.followDir || this.flyingIn) return;
    const n = this.player.getSurfaceNormalInto(this._rcNormal);
    const behind = this.player.getWorldDirection(this._rcFacing);
    behind.addScaledVector(n, -behind.dot(n));
    if (behind.lengthSq() < 1e-8) return;
    behind.normalize().negate(); // the camera sits opposite the facing
    const fd = this._rcFollow.copy(this.followDir).addScaledVector(n, -this.followDir.dot(n));
    fd.normalize();
    const angle = Math.atan2(this._rcCross.copy(fd).cross(behind).dot(n), fd.dot(behind));
    // Aim the TARGET so the camera ends behind, whatever was still pending.
    this.yawTarget = this.yawApplied + angle;
    this.pitchTarget = OrbitCamera.DEFAULT_PITCH;
    this.yawVelocity = 0;
    this.flingLeft = 0;
    this.sinceManualLook = 0;
    this.reducedRecentrePending = false; // a manual look wins over the recentre
    if (a11y.reducedMotion) {
      this.yawStepPending += this.yawTarget - this.yawApplied;
      this.yawApplied = this.yawTarget;
      this.pitch = this.pitchTarget;
      this.snapToPlayer();
    } else {
      this.lookTau = OrbitCamera.RECENTRE_TAU;
    }
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
   * The manual yaw applied so far, in radians: the sum of every look turn
   * (drag, swipe, keys, fling, R), + counter-clockwise about the local up
   * (the view turned LEFT). Auto-follow does not count. A sphere has no
   * global heading, so only differences mean anything (probe hook).
   */
  public getYaw(): number {
    return this.yawApplied;
  }

  /** Where the manual yaw is heading (same units as getYaw); at finger-up it
   *  already holds the whole swipe, before the easing lands it (probe hook). */
  public getYawTarget(): number {
    return this.yawTarget;
  }

  /** The intro fly-in owns the camera: main-simple starts no heavy work
   *  (the phone room warm) until it lands. */
  public isFlyingIn(): boolean {
    return this.flyingIn;
  }

  /**
   * Turn to this manual yaw at once (same units as getYaw), e.g.
   * setYaw(getYaw() + Math.PI / 12) for 15° to the left: the probes' way to
   * turn the camera without a pointer. Hard-cuts like snapToPlayer.
   */
  public setYaw(yaw: number): void {
    if (!Number.isFinite(yaw) || this.flyingIn) return;
    this.yawStepPending += yaw - this.yawApplied;
    this.yawTarget = yaw;
    this.yawApplied = yaw;
    this.yawVelocity = 0;
    this.flingLeft = 0;
    this.sinceManualLook = 0;
    this.reducedRecentrePending = false; // a manual look wins over the recentre
    this.snapToPlayer();
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
