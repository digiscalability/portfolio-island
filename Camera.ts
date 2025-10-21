import * as THREE from 'three';
import { Player } from './Player';

export class CameraController {
  // Animate camera from a distant planet view to the player (cinematic fly-in)
  public async flyInFromDistantView(duration: number = 1800, farOffset?: THREE.Vector3) {
    // Start from a far offset (default: above and back)
    const playerPosition = this.player.getPosition();
    const startOffset = farOffset ? farOffset.clone() : new THREE.Vector3(0, 18, 32);
    const endOffset = this.offset.clone();
    // Temporarily set camera to far position
    const cam = this.camera;
    cam.position.copy(playerPosition.clone().add(startOffset));
    cam.lookAt(playerPosition);
    // Animate position and lookAt
    const startTime = performance.now();
    return new Promise<void>((resolve) => {
      const animate = () => {
        const now = performance.now();
        const t = Math.min(1, (now - startTime) / duration);
        // Ease in (smoothstep)
        const tt = t * t * (3 - 2 * t);
        const curOffset = startOffset.clone().lerp(endOffset, tt);
        cam.position.copy(playerPosition.clone().add(curOffset));
        cam.lookAt(playerPosition);
        if (t < 1) {
          requestAnimationFrame(animate);
        } else {
          // Ensure final position
          cam.position.copy(playerPosition.clone().add(endOffset));
          cam.lookAt(playerPosition);
          resolve();
        }
      };
      animate();
    });
  }
  private camera: THREE.PerspectiveCamera;
  private player: Player;
  private scene?: THREE.Scene;
  // optional ground provider (e.g., Island) that exposes getSurfaceNormal(pos) and getSurfacePosition(dir)
  private groundProvider?: any;
  private offset: THREE.Vector3;
  private smoothness: number = 0.2;
  private lookAtSmooth: number = 5.0; // larger = faster
  private prevPlayerPos: THREE.Vector3 | null = null;
  private raycaster: THREE.Raycaster = new THREE.Raycaster();
  // optional explicit occluder list to limit raycast scope (performance)
  private occluderObjects?: THREE.Object3D[];
  // sweep throttling: minimum seconds between performing the expensive pivot sweeps
  private sweepThrottleInterval: number = 0.08; // seconds
  private lastSweepTime: number = 0; // seconds (performance.now()/1000)
  // occlusion smoothing
  private occlusionBlend: number = 0; // 0 = no occlusion, 1 = fully clamped
  private occlusionSmoothTime: number = 0.25; // seconds to blend into/out-of occluded position
  private occlusionIgnorePredicate?: (obj: THREE.Object3D) => boolean;
  // smart pivoting: when occluded, attempt offset sweeps around player yaw to find alternative camera positions
  private smartPivotEnabled: boolean = true;
  private pivotSweepAngles: number[] = [0, 15, -15, 30, -30].map(a => a * (Math.PI / 180));
  private occlusionLayerMask: number = 0; // bitmask of layers to IGNORE in occlusion tests (if object.layers.mask & mask) != 0 => ignored
  private occlusionCallback?: (blend: number) => void;
  // yaw follow factor: 0 = ignore player's yaw (camera maintains own yaw), 1 = fully use player's yaw
  private yawFollowFactor: number = 1.0;
  // animation state for temporary offset tweens
  private animStartOffset?: THREE.Vector3;
  private animTargetOffset?: THREE.Vector3;
  private animDuration: number = 0;
  private animElapsed: number = 0;
  private minHeightAboveSurface: number = 0.6; // meters above surface to prevent camera going inside geometry
  private minPitchDeg: number = 12;
  private maxPitchDeg: number = 65;
  // Dynamic FOV enhancement
  private baseFOV: number = 55;
  private currentFOV: number = 55;
  private targetFOV: number = 55;
  private fovSmoothSpeed: number = 6.0;
  private speedFOVBoost: number = 8.0; // extra FOV degrees when at max speed
  private sprintFOVBoost: number = 5.0; // extra FOV when sprinting
  // Look-ahead prediction
  private lookAheadDistance: number = 0;
  private lookAheadSpeed: number = 4.0;
  private maxLookAhead: number = 2.5;

  constructor(camera: THREE.PerspectiveCamera, player: Player, scene?: THREE.Scene, groundProvider?: any) {
    this.camera = camera;
    this.player = player;
    this.scene = scene;
    this.groundProvider = groundProvider;
    // Default offset for third-person action game (over-shoulder view)
    this.offset = new THREE.Vector3(0.8, 1.8, 4.5);
    // Responsive but stable settings for action gameplay
    this.smoothness = 0.12;      // Slightly more smooth to reduce jitter
    this.lookAtSmooth = 5.0;     // Moderate look-at speed
    this.yawFollowFactor = 0.5;  // Moderate yaw tracking (reduced from 0.65)
    this.minHeightAboveSurface = 0.5;
    this.sweepThrottleInterval = 0.3; // Less frequent sweeps (was 0.22)
    this.occlusionSmoothTime = 0.6; // Slower occlusion blend (was 0.5)
    this.prevPlayerPos = this.player.getPosition();
    // Third-person action game FOV (wider for better awareness)
    this.baseFOV = 65; // Wider FOV than 55 for action games
    this.camera.fov = this.baseFOV;
    this.currentFOV = this.baseFOV;
    this.targetFOV = this.baseFOV;
    this.camera.updateProjectionMatrix();
  }

  // Quick helper to set conservative third-person camera preset tuned to character model sizes
  public setThirdPersonPreset(overrides?: { offset?: THREE.Vector3; smoothness?: number; lookAtSmooth?: number; yawFollow?: number; minHeight?: number }) {
    try {
      this.offset = overrides?.offset ?? new THREE.Vector3(0.8, 1.8, 4.5);
      this.smoothness = typeof overrides?.smoothness === 'number' ? overrides.smoothness : 0.12;
      this.lookAtSmooth = typeof overrides?.lookAtSmooth === 'number' ? overrides.lookAtSmooth : 5.0;
      this.minHeightAboveSurface = typeof overrides?.minHeight === 'number' ? overrides.minHeight : 0.5;
      this.setYawFollowFactor(typeof overrides?.yawFollow === 'number' ? overrides.yawFollow : 0.5);
    } catch (e) { /* ignore */ }
  }

  // Apply one of a few named presets useful for debugging and tuning camera placement
  public applyPreset(name: 'close' | 'default' | 'wide' = 'default') {
    switch (name) {
      case 'close':
        // Close combat view - tight over-shoulder
        this.setThirdPersonPreset({ offset: new THREE.Vector3(0.6, 1.2, 2.8), smoothness: 0.08, lookAtSmooth: 6.0, yawFollow: 0.6, minHeight: 0.4 });
        this.setPitchLimits(8, 55);
        break;
      case 'wide':
        // Wide exploration view - more cinematic
        this.setThirdPersonPreset({ offset: new THREE.Vector3(1.2, 2.4, 6.5), smoothness: 0.15, lookAtSmooth: 4.0, yawFollow: 0.4, minHeight: 0.7 });
        this.setPitchLimits(12, 70);
        break;
      default:
        // Default action game view - over-shoulder
        this.setThirdPersonPreset({ offset: new THREE.Vector3(0.8, 1.8, 4.5), smoothness: 0.12, lookAtSmooth: 5.0, yawFollow: 0.5, minHeight: 0.5 });
        this.setPitchLimits(10, 65);
        break;
    }
  }

  // Provide ground provider at runtime (useful if engine constructs camera before island is ready)
  public setGroundProvider(provider: any) {
    this.groundProvider = provider;
  }

  // deltaTime in seconds
  public update(deltaTime: number = 0.016): void {

    // advance any offset animation
    if (this.animTargetOffset && this.animStartOffset && this.animDuration > 0) {
      this.animElapsed = Math.min(this.animDuration, this.animElapsed + deltaTime);
      const t = Math.min(1, this.animElapsed / Math.max(0.0001, this.animDuration));
      // ease (smoothstep)
      const tt = t * t * (3 - 2 * t);
      const cur = new THREE.Vector3().copy(this.animStartOffset).lerp(this.animTargetOffset, tt);
      this.offset.copy(cur);
      if (t >= 1) { this.animStartOffset = undefined; this.animTargetOffset = undefined; this.animDuration = 0; this.animElapsed = 0; }
    }
    const playerPosition = this.player.getPosition();

    // Determine local up (surface normal) from groundProvider when available
    let localUp = new THREE.Vector3(0, 1, 0);
    try {
      if (this.groundProvider && typeof this.groundProvider.getSurfaceNormal === 'function') {
        const n = this.groundProvider.getSurfaceNormal(playerPosition);
        if (n && n.lengthSq() > 0.0001) localUp.copy(n.normalize());
      }
    } catch (e) { }
  // Compute a stable player forward vector projected onto tangent plane so camera follows slopes gracefully.
  // Use player's stable quaternion, not movement-based calculation
  let forward = new THREE.Vector3(0, 0, -1);
    try {
      // Always use player's quaternion for consistent forward direction
      forward = new THREE.Vector3(0, 0, -1).applyQuaternion(this.player.mesh.quaternion).normalize();
    } catch (e) {
      forward = new THREE.Vector3(0, 0, -1);
    }

    // project forward onto tangent plane
    const forwardProj = forward.clone().sub(localUp.clone().multiplyScalar(forward.dot(localUp)));
    if (forwardProj.lengthSq() < 1e-4) {
      // fallback: derive any tangent vector
      forwardProj.copy(new THREE.Vector3(0, 0, -1).applyQuaternion(this.player.mesh.quaternion));
      forwardProj.sub(localUp.clone().multiplyScalar(forwardProj.dot(localUp)));
    }
    forwardProj.normalize();
    const right = new THREE.Vector3().crossVectors(forwardProj, localUp).normalize();

    // Blend camera yaw with player's yaw (yawFollowFactor). This makes the camera less twitchy when
    // the player's model rotates quickly due to animation changes.
    try {
      const camYawQuat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, -1), forwardProj.clone());
      const playerYawQuat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, -1), new THREE.Vector3(0, 0, -1).applyQuaternion(this.player.mesh.quaternion));
      // slerp between camera follow and player yaw
      camYawQuat.slerp(playerYawQuat, this.yawFollowFactor);
    } catch (e) {}

    // ENFORCE camera always behind player: offset is always -forward direction
    // Remove yaw blending, always use player's forwardProj for camera placement
    // build desired offset in local tangent-space coordinates: right (x), up (y), -forward (z behind)
    const clampedOffset = this.offset.clone();
    // clamp vertical offset relative to depth to avoid extreme top-down views
    const maxY = Math.max(1.2, Math.abs(clampedOffset.z) * 1.6);
    clampedOffset.y = Math.max(0.8, Math.min(maxY, clampedOffset.y));

    const desiredOffset = new THREE.Vector3();
    desiredOffset.addScaledVector(right, clampedOffset.x);
    desiredOffset.addScaledVector(localUp, clampedOffset.y);
    desiredOffset.addScaledVector(forwardProj, -Math.abs(clampedOffset.z)); // always behind

    const desiredPos = playerPosition.clone().add(desiredOffset);

    // Camera collision: cast a ray from playerPosition toward desiredPos and compute a clamped position
    let clampedPos = desiredPos.clone();
    let isOccluded = false;
    if (this.scene) {
      try {
        const dir = desiredPos.clone().sub(playerPosition);
        const dist = dir.length();
        if (dist > 0.001) {
          dir.normalize();
          this.raycaster.set(playerPosition, dir);
          // build a filtered occluder list to avoid foliage/noise and reduce raycast flakiness
          let targetObjects: THREE.Object3D[];
          if (this.occluderObjects && this.occluderObjects.length) targetObjects = this.occluderObjects;
          else {
            targetObjects = this.scene.children.filter((c: any) => {
              if (!c) return false;
              if (c === this.player.mesh) return false;
              if (c.userData && c.userData.ignoreOcclusion) return false;
              if (c.name && /foliage|leaf|grass|bush|decal|plane/i.test(c.name)) return false;
              return true;
            });
          }
          const intersects = this.raycaster.intersectObjects(targetObjects, true);
          for (const it of intersects) {
            let obj: any = it.object;
            let skip = false;
            while (obj) {
              if (obj === this.player.mesh) { skip = true; break; }
              if (this.occlusionIgnorePredicate && this.occlusionIgnorePredicate(obj)) { skip = true; break; }
              try { if (this.occlusionLayerMask && (obj.layers && (obj.layers.mask & this.occlusionLayerMask))) { skip = true; break; } } catch (e) { }
              if (obj.name && /foliage|leaf|grass|bush|decal|plane/i.test(obj.name)) { skip = true; break; }
              if (obj.userData && obj.userData.ignoreOcclusion) { skip = true; break; }
              obj = obj.parent;
            }
            if (skip) continue;
            if (it.distance < dist) {
              const hitPoint = it.point.clone();
              clampedPos = hitPoint.clone().add(playerPosition.clone().sub(hitPoint).normalize().multiplyScalar(0.35));
              isOccluded = true;
              break;
            }
          }
        }
      } catch (e) { /* non-fatal, keep desiredPos */ }
    }

    // If occluded and smart pivot is enabled, try sweeping offsets around yaw to find an alternative unclipped camera position
    if (isOccluded && this.smartPivotEnabled && this.scene) {
      const originalOffset = this.offset.clone();
      const yawEuler = new THREE.Euler().setFromQuaternion(this.player.mesh.quaternion, 'YXZ');
      const baseYaw = yawEuler.y || 0;
      let foundBetter: THREE.Vector3 | null = null;
      let bestDistDelta = 1e9;

      // throttle expensive sweep attempts to avoid per-frame cost
      const now = (typeof performance !== 'undefined' && performance.now) ? (performance.now() / 1000) : Date.now() / 1000;
      if (now - this.lastSweepTime >= this.sweepThrottleInterval) {
        this.lastSweepTime = now;
        for (const a of this.pivotSweepAngles) {
          const yawQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), baseYaw + a);
          const altOffset = originalOffset.clone().applyQuaternion(yawQuat);
          const altPos = playerPosition.clone().add(altOffset);
          const dirAlt = altPos.clone().sub(playerPosition);
          const distAlt = dirAlt.length();
          if (distAlt <= 0.001) continue;
          dirAlt.normalize();
          this.raycaster.set(playerPosition, dirAlt);
          const targetObjectsAlt = this.occluderObjects && this.occluderObjects.length ? this.occluderObjects : this.scene.children;
          const intersectsAlt = this.raycaster.intersectObjects(targetObjectsAlt, true);
          let occludedAlt = false;
          for (const it of intersectsAlt) {
            let obj: any = it.object; let skip = false;
            while (obj) {
              if (obj === this.player.mesh) { skip = true; break; }
              if (this.occlusionIgnorePredicate && this.occlusionIgnorePredicate(obj)) { skip = true; break; }
              try { if (this.occlusionLayerMask && (obj.layers && (obj.layers.mask & this.occlusionLayerMask))) { skip = true; break; } } catch (e) { }
              if (obj.name && /foliage|leaf|grass|bush|decal|plane/i.test(obj.name)) { skip = true; break; }
              if (obj.userData && obj.userData.ignoreOcclusion) { skip = true; break; }
              obj = obj.parent;
            }
            if (skip) continue;
            if (it.distance < distAlt) { occludedAlt = true; break; }
          }
          if (!occludedAlt) {
            const delta = altPos.distanceTo(desiredPos);
            if (delta < bestDistDelta) { bestDistDelta = delta; foundBetter = altPos.clone(); }
          }
        }
        if (foundBetter) {
          clampedPos = foundBetter;
        }
      }
    }

    // Blend occlusion over time so camera doesn't snap. occlusionBlend moves toward 1 when occluded, toward 0 otherwise.
    const blendDelta = deltaTime / Math.max(0.001, this.occlusionSmoothTime);
    if (isOccluded) this.occlusionBlend = Math.min(1, this.occlusionBlend + blendDelta);
    else this.occlusionBlend = Math.max(0, this.occlusionBlend - blendDelta);

    // notify callback about occlusion blend (if any)
    try { if (this.occlusionCallback) this.occlusionCallback(this.occlusionBlend); } catch (e) { }

    // Interpolate between desiredPos and clampedPos by occlusionBlend to produce target position
    const targetPos = desiredPos.clone().lerp(clampedPos, this.occlusionBlend);

    // Safety clamp: ensure camera remains at least minHeightAboveSurface above player's surface
    try {
      // compute vector from player's surface point to targetPos
      const playerPos = playerPosition.clone();
      const height = targetPos.clone().sub(playerPos).length();
      if (height < this.minHeightAboveSurface) {
        const dir = targetPos.clone().sub(playerPos).normalize();
        const safe = playerPos.clone().add(dir.multiplyScalar(this.minHeightAboveSurface));
        targetPos.copy(safe);
      }
    } catch (e) { }

    // Clamp how far the camera may move in a single frame to reduce snapping/jitter
    try {
      const maxMove = Math.max(0.5, 3.0 * deltaTime); // world units per frame
      const delta = targetPos.clone().sub(this.camera.position);
      if (delta.length() > maxMove) {
        targetPos.copy(this.camera.position.clone().add(delta.normalize().multiplyScalar(maxMove)));
      }
    } catch (e) {}

    // Smooth camera movement (damping factor scaled by frame rate)
    const damping = Math.max(0.001, this.smoothness);
    const t = 1 - Math.exp(-damping * Math.max(0.001, deltaTime * 60));
    this.camera.position.lerp(targetPos, t);
    // Smooth lookAt interpolation: always look at player head level and use surface normal as up vector
    const lookAtTarget = playerPosition.clone();
    lookAtTarget.y += 1.5; // head-level target
    try {
      // Build a matrix that looks from camera.position toward lookAtTarget using localUp to avoid sudden roll
      const lookMat = new THREE.Matrix4();
      lookMat.lookAt(this.camera.position, lookAtTarget, localUp);
      const desiredQuat = new THREE.Quaternion().setFromRotationMatrix(lookMat);
      const lookT = 1 - Math.exp(-this.lookAtSmooth * Math.max(0.001, deltaTime));
      this.camera.quaternion.slerp(desiredQuat, lookT);
      // Constrain pitch so the camera doesn't go over the top or under the character too far
      try {
        const e = new THREE.Euler().setFromQuaternion(this.camera.quaternion, 'YXZ');
        const maxPitch = Math.abs(this.maxPitchDeg) || 80;
        const minPitch = Math.max(0, this.minPitchDeg || 0);
        const clamped = THREE.MathUtils.clamp(THREE.MathUtils.radToDeg(e.x), -maxPitch, -minPitch);
        e.x = THREE.MathUtils.degToRad(clamped);
        this.camera.quaternion.setFromEuler(e);
      } catch (ee) {}
    } catch (e) {
      // fallback to instant lookAt if anything goes wrong
      this.camera.lookAt(lookAtTarget);
    }

    // Dynamic FOV based on player speed for enhanced sense of motion
    try {
      const playerVelocity = this.player.getVelocity ? this.player.getVelocity() : new THREE.Vector3(0, 0, 0);
      const speed = playerVelocity.length();
      const maxSpeed = 8.0; // approximate max player speed
      const speedRatio = Math.min(1, speed / maxSpeed);

      // Calculate target FOV based on speed
      const speedBoost = speedRatio * this.speedFOVBoost;

      // Add sprint boost if player is sprinting (check for sprint state)
      let sprintBoost = 0;
      try {
        const isSprinting = (this.player as any).isSprinting?.() || false;
        if (isSprinting) sprintBoost = this.sprintFOVBoost;
      } catch (e) { /* ignore */ }

      this.targetFOV = this.baseFOV + speedBoost + sprintBoost;

      // Smoothly interpolate current FOV to target
      const fovDelta = this.targetFOV - this.currentFOV;
      const fovChangeSpeed = this.fovSmoothSpeed * deltaTime;
      this.currentFOV += fovDelta * Math.min(1, fovChangeSpeed);

      // Apply FOV to camera
      this.camera.fov = this.currentFOV;
      this.camera.updateProjectionMatrix();
    } catch (e) {
      // Fallback: maintain base FOV
      if (this.camera.fov !== this.baseFOV) {
        this.camera.fov = this.baseFOV;
        this.camera.updateProjectionMatrix();
      }
    }

    // Look-ahead: offset camera target slightly in movement direction for better anticipation
    try {
      if (this.prevPlayerPos) {
        const movement = playerPosition.clone().sub(this.prevPlayerPos);
        const moveSpeed = movement.length() / Math.max(0.001, deltaTime);

        if (moveSpeed > 0.5) {
          // Calculate look-ahead based on movement speed
          const targetLookAhead = Math.min(this.maxLookAhead, moveSpeed * 0.3);
          const lookAheadDelta = targetLookAhead - this.lookAheadDistance;
          this.lookAheadDistance += lookAheadDelta * Math.min(1, this.lookAheadSpeed * deltaTime);
        } else {
          // Reduce look-ahead when slowing down
          this.lookAheadDistance *= Math.max(0, 1 - (deltaTime * 3.0));
        }
      }
    } catch (e) { /* ignore */ }

    // Store current position for next frame's velocity calculation
    this.prevPlayerPos = playerPosition.clone();
  }

  // Allow caller to provide a predicate to exclude certain objects from occlusion tests
  public setOcclusionIgnorePredicate(pred: (obj: THREE.Object3D) => boolean): void {
    this.occlusionIgnorePredicate = pred;
  }

  // Allow tuning of occlusion smoothing duration
  public setOcclusionSmoothTime(seconds: number): void {
    this.occlusionSmoothTime = Math.max(0.01, seconds);
  }

  public enableSmartPivot(enabled: boolean): void {
    this.smartPivotEnabled = !!enabled;
  }

  public setOcclusionLayerMask(mask: number): void {
    this.occlusionLayerMask = mask >>> 0;
  }

  public setOcclusionCallback(cb: (blend: number) => void): void {
    this.occlusionCallback = cb;
  }

  // Control how strongly camera follows player's yaw. 0 = independent, 1 = fully follow player's yaw
  public setYawFollowFactor(factor: number): void {
    this.yawFollowFactor = THREE.MathUtils.clamp(factor, 0, 1);
  }

  // Provide an explicit list of objects to consider as occluders. Using a smaller set improves raycast performance.
  public setOccluderObjects(objs: THREE.Object3D[] | undefined): void {
    this.occluderObjects = objs && objs.length ? objs.slice() : undefined;
  }

  // Set minimum seconds between pivot sweep attempts (throttle). Default ~0.08s.
  public setSweepThrottleInterval(seconds: number): void {
    this.sweepThrottleInterval = Math.max(0, seconds);
  }

  public setLookAtSmooth(val: number): void {
    this.lookAtSmooth = Math.max(0.1, val);
  }

  public setOffset(offset: THREE.Vector3): void {
    this.offset.copy(offset);
  }

  public setSmoothness(smoothness: number): void {
    this.smoothness = THREE.MathUtils.clamp(smoothness, 0.001, 1);
  }

  public setYOffset(y: number): void {
    this.offset.y = y;
  }

  public setFOV(fov: number): void {
    this.camera.fov = fov;
    this.camera.updateProjectionMatrix();
  }

  // Animate the camera offset over duration (seconds). Easing uses smoothstep.
  public animateOffset(target: THREE.Vector3, duration: number) {
    this.animStartOffset = this.offset.clone();
    this.animTargetOffset = target.clone();
    this.animDuration = Math.max(0, duration);
    this.animElapsed = 0;
  }

  // Safety clamp: ensure camera stays at least this distance above the surface along the player-to-camera vector
  public setMinHeightAboveSurface(meters: number) {
    this.minHeightAboveSurface = Math.max(0, meters);
  }

  // Set allowed pitch range in degrees (angle between forward and camera vector). Keeps camera from going too high or low.
  public setPitchLimits(minDeg: number, maxDeg: number) {
    this.minPitchDeg = Math.max(0, Math.min(89, minDeg));
    this.maxPitchDeg = Math.max(this.minPitchDeg + 1, Math.min(89, maxDeg));
  }

}


