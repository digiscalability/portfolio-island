
import type { Camera } from 'three';
import * as THREE from 'three';
import type { Axes, InputManager, InputState } from './InputManager';
import { Island } from './Island';
import { Materials } from './Materials';
import DebugOverlay from './src/utils/DebugOverlay';
import { getPendingGLTFLoads, loadGLTFModel } from './src/utils/GLTFModelLoader';
import logger from './src/utils/Logger';

export interface CharacterCustomization {
  skinColor: number;
  outfitColor: number;
  hairColor: number;
}


export class Player {
  public mesh: THREE.Group;
  private modelMesh: THREE.Group | null = null;
  private modelAnimations: THREE.AnimationClip[] = [];
  private modelLoaded: boolean = false;
  private animationMixer: THREE.AnimationMixer | null = null;
  private currentAction: THREE.AnimationAction | null = null;
  private currentAnimationName: string = '';
  private island: Island;
  private speed: number = 4.8; // increased base speed for better feel
  private sprintMultiplier: number = 1.85; // more noticeable sprint difference
  private velocity: THREE.Vector3 = new THREE.Vector3(0,0,0);
  private isAirborne: boolean = false;
  private verticalVelocity: number = 0; // along surface normal, positive = away from center
  private jumpStrength: number = 5.5; // higher jump for better arc
  private gravity: number = 22.0; // Increased from 18.0 for snappier, more responsive jump arc
  private gravityMultiplier: number = 1.0; // dynamic gravity based on height
  private prevJumpPressed: boolean = false;
  // When airborne, reduce horizontal control
  private airborneControlFactor: number = 0.65; // better air control for responsive feel
  // Enhanced movement tuning for smooth, responsive gameplay
  private accel: number = 22; // faster acceleration for snappy response
  private friction: number = 16; // slightly less friction for smoother movement
  private turnSpeed: number = 8.5; // rotation speed when changing direction
  // Input deadzone to avoid gamepad/controller drift
  private inputDeadzone: number = 0.15; // slightly tighter deadzone
  // Position stability threshold to prevent micro-jitter from stick-to-surface corrections
  // Increased threshold to prevent constant micro-adjustments that cause wobbling
  private positionStabilityThreshold: number = 0.2;
  // Frame counter for reducing stickToIsland frequency
  private frameCount: number = 0;
  // Movement smoothing
  private velocitySmoothing: number = 0.12; // smooth velocity changes
  private targetRotation: THREE.Quaternion = new THREE.Quaternion();
  // Stable yaw tracking (separate from full quaternion)
  private currentYaw: number = 0;
  // Landing effects
  private landingTime: number = 0;
  private wasAirborne: boolean = false;
  private customization: CharacterCustomization;
  private debugOverlay: DebugOverlay | null = null;
  private sceneRef: THREE.Scene | null = null;

  constructor(island: Island, customization?: CharacterCustomization) {
    this.island = island;
    this.customization = customization || {
      skinColor: 0xffddaa,
      outfitColor: 0xff6b6b,
      hairColor: 0x8b4513,
    };

    // Start with procedural mesh, then try to load model async
    this.mesh = this.createCharacter();
  // make the procedural character slightly larger by default to be more visible
  this.mesh.scale.setScalar(1.4);
  // place the procedural character on the island surface at a safe spawn location
  // For spherical island, we need to use proper surface sampling, not just Y offset
  const spawnDir = new THREE.Vector3(0, 1, 0).normalize();
  const spawnSurface = island.sampleSurfaceByDirection(spawnDir, 0.0);
  this.mesh.position.copy(spawnSurface.position);
    // Ensure player starts grounded, not airborne
    this.isAirborne = false;
    this.verticalVelocity = 0;

    // Initialize stable yaw from spawn direction
    const spawnYaw = Math.atan2(spawnDir.x, spawnDir.z);
    this.currentYaw = spawnYaw;

    this.stickToIsland(1); // Full snap to surface on spawn

    // Try to load model asynchronously (try .gltf first, then .glb)
    this.tryLoadModel();

    // Create debug overlay if requested via global flag
    try { if ((window as any).__DEBUG_PLAYER) this.debugOverlay = new DebugOverlay(); } catch (e) {}
  }

  private async tryLoadModel() {
    try {
      // try common extensions (.gltf then .glb) in assets first, then search assetKits for glTF files
  let res: { scene: THREE.Group, animations: THREE.AnimationClip[] } | null = null;
  let selectedUrl: string | null = null;
      const candidates = ['/assets/models/Superhero_Female.gltf', '/assets/models/Superhero_Male.gltf', '/assets/models/player.gltf', '/assets/models/player.glb'];
      // per-model scale map (basename -> scalar). Tune these so models appear at sensible size by default.
      const scaleMap: Record<string, number> = {
        'Superhero_Female.gltf': 0.12,
        'Superhero_Female.glb': 0.12,
        'Superhero_Male.gltf': 0.12,
        'Superhero_Male.glb': 0.12,
        'player.gltf': 0.1,
        'player.glb': 0.1,
        'npc.gltf': 0.6,
        'tree.gltf': 0.9,
        'car.gltf': 0.7,
      };
      for (const url of candidates) {
        try {
          res = await loadGLTFModel(url);
          selectedUrl = url;
          if (res) break;
        } catch (e) {
          // try next
        }
      }
      // If still not found, attempt to discover any .gltf files under assetKits folders (best-effort)
      if (!res) {
        try {
          // Asset kits live in a top-level folder; try actual paths from copy_assets.bat
          const kitCandidates = [
            '/assetKits/Universal Base Characters[Standard]/Base Characters/Unreal Engine/Superhero_Male.gltf',
            '/assetKits/Universal Base Characters[Standard]/Base Characters/Unreal Engine/Superhero_Female.gltf',
            '/assetKits/Universal Base Characters[Standard]/glTF/Superhero_Male.gltf',
            '/assetKits/Universal Base Characters[Standard]/glTF/Superhero_Female.gltf'
          ];
          for (const k of kitCandidates) {
            try { res = await loadGLTFModel(k); if (res) { selectedUrl = k; break; } } catch (e) { }
          }
        } catch (e) { /* ignore */ }
      }
      if (!res) throw new Error('player model not found');
      const { scene, animations } = res;
      // Preserve the parent, remove procedural mesh and later add the loaded model to the same parent
      const previousParent = this.mesh.parent || null;
      if (previousParent) previousParent.remove(this.mesh);
    this.modelMesh = scene;
      this.modelAnimations = animations;
      this.modelLoaded = true;
  console.info('Player: loaded model from GLTF, applying in-scene. Animations:', animations.map(a => a.name));
      // Scale the model to an approximate human height (use per-model scale map when available)
      try {
        // compute bounding box of the loaded scene to determine its natural height
        const bbox = new THREE.Box3().setFromObject(scene as any);
        const size = new THREE.Vector3(); bbox.getSize(size);
          const targetHeight = 1.9; // meters in world units for player height (slightly taller)
        let computedScale = 1;
        if (size.y > 1e-4) computedScale = targetHeight / size.y;
        let basename = '';
        if (selectedUrl) basename = selectedUrl.replace(/^.*[\\/]/, '');
        if (!basename && typeof (scene as any).name === 'string') basename = (scene as any).name.replace(/^.*[\\/]/, '');
        const mapped = basename ? scaleMap[basename] : undefined;
        if (typeof mapped === 'number') {
          // respect per-model mapping but apply a global visibility multiplier
          this.modelMesh.scale.setScalar(mapped * 1.15);
        } else {
          // clamp to avoid extreme scales
          const clamped = Math.max(0.02, Math.min(5, computedScale));
          this.modelMesh.scale.setScalar(clamped);
        }
        console.info('Player: model basename for scale lookup:', basename, 'applied scale:', this.modelMesh.scale.x, 'bboxHeight:', size.y);
      } catch (e) {
        this.modelMesh.scale.setScalar(0.1);
      }
      // Ensure materials are fixed for correct encoding/opacity
      try {
        this.modelMesh.traverse((o: any) => {
          if (o && o.isMesh && o.material) {
            try {
              if (Array.isArray(o.material)) o.material.forEach((m: any) => Materials.fixMaterialTextures(m));
              else Materials.fixMaterialTextures(o.material);
            } catch (ee) {}
          }
        });
      } catch (e) {}
      // Rotate to face correct direction
      // this.modelMesh.rotation.y = Math.PI;
    // Copy position/quaternion from procedural mesh
    this.modelMesh.position.copy(this.mesh.position);
    this.modelMesh.quaternion.copy(this.mesh.quaternion);
      // Add the new mesh to the previous parent (if any) so it remains in the scene; otherwise the caller's addToScene will pick it up
      if (previousParent) {
        previousParent.add(this.modelMesh);
      }
      this.mesh = this.modelMesh;
      // Stick to island to ensure correct placement
      this.stickToIsland();
      // AnimationMixer setup
      if (animations && animations.length) {
        this.animationMixer = new THREE.AnimationMixer(this.modelMesh);
        // Play first animation by default (will be replaced by state logic)
        const defaultClip = animations[0];
        this.currentAction = this.animationMixer.clipAction(defaultClip);
        this.currentAction.play();
        this.currentAnimationName = defaultClip.name;
        console.log('Player model animations loaded:', animations.map(a => a.name));
      }
    } catch (e) {
      // Model not found or failed to load, fallback to procedural
      this.modelLoaded = false;
      this.modelMesh = null;
      this.modelAnimations = [];
      this.animationMixer = null;
      this.currentAction = null;
      this.currentAnimationName = '';
      // Already using procedural mesh
      console.warn('Player model not found or failed to load, using procedural mesh.', e);
    }
  }

  private createCharacter(): THREE.Group {
    const group = new THREE.Group();

    // Body (capsule)
    const bodyGeometry = new THREE.CapsuleGeometry(0.3, 1, 8, 16);
  // Keep toon look for body but add subtle specular via MeshStandardMaterial overlay for highlights
  const bodyMaterial = Materials.createCharacterBodyMaterial();
    const body = new THREE.Mesh(bodyGeometry, bodyMaterial);
    body.position.y = 0.5;
    body.castShadow = true;
    group.add(body);

    // Head (sphere)
    const headGeometry = new THREE.SphereGeometry(0.4, 16, 16);
  // Use a standard material for head to allow soft shading and highlights
  const headMaterial = Materials.createStandardMaterial({ color: this.customization.skinColor, metalness: 0.02, roughness: 0.6, envMapIntensity: 0.4 });
  const head = new THREE.Mesh(headGeometry, headMaterial);
    head.position.y = 1.5;
    head.castShadow = true;
    group.add(head);

    // Hair (smaller sphere on top)
    const hairGeometry = new THREE.SphereGeometry(0.35, 16, 16);
  const hairMaterial = Materials.createPBRMaterial({ color: this.customization.hairColor, roughness: 0.6 });
    const hair = new THREE.Mesh(hairGeometry, hairMaterial);
    hair.position.y = 1.8;
    hair.scale.set(1, 0.6, 1);
    hair.castShadow = true;
    group.add(hair);

  // Slightly scale up procedural group to increase visibility
  group.scale.setScalar(1.25);

    // Eyes (simple black spheres)
    const eyeGeometry = new THREE.SphereGeometry(0.08, 8, 8);
  const eyeMaterial = Materials.createStandardMaterial({ color: 0x000000, metalness: 0, roughness: 0.3 });

    const leftEye = new THREE.Mesh(eyeGeometry, eyeMaterial);
    leftEye.position.set(-0.15, 1.55, 0.35);
    group.add(leftEye);

    const rightEye = new THREE.Mesh(eyeGeometry, eyeMaterial);
    rightEye.position.set(0.15, 1.55, 0.35);
    group.add(rightEye);

    return group;
  }

  // accept an optional camera so movement can be interpreted relative to camera yaw (third-person control)
  // Also accept an optional InputManager so we can read analog axes (gamepad/joystick) via getAxes().
  public update(input: InputState, deltaTime: number, camera?: Camera, inputManager?: InputManager): void {
    // Animation update (if model and mixer loaded)
    if (this.modelLoaded && this.animationMixer) {
      this.animationMixer.update(deltaTime);
      // Animation state selection
      let animName = '';
      if (this.isAirborne) {
        animName = 'Jump';
      } else {
        const moveMag = this.velocity.length();
        if (moveMag < 0.05) {
          animName = 'Idle';
        } else if (moveMag < this.speed * 1.1) {
          animName = 'Walk';
        } else {
          animName = 'Run';
        }
      }
      // Find animation clip by name (case-insensitive)
      let clip = this.modelAnimations.find(a => a.name.toLowerCase() === animName.toLowerCase());
      if (!clip) {
        // Fallback: use first animation
        clip = this.modelAnimations[0];
        animName = clip.name;
      }
      if (clip && (!this.currentAction || this.currentAnimationName !== animName)) {
        if (this.currentAction) {
          this.currentAction.fadeOut(0.18);
        }
        this.currentAction = this.animationMixer.clipAction(clip);
        this.currentAction.reset().fadeIn(0.18).play();
        this.currentAnimationName = animName;
      }
    }
    // Calculate movement direction in local space (input vector)
  const moveDirection = new THREE.Vector3();

    // If an InputManager is provided and joystick is squelched, reactivate on explicit inputs
    try {
      if (inputManager && typeof (inputManager as any).isJoystickSquelched === 'function') {
        // if the user pressed any keyboard key or button, unsquelch the joystick provider
        if (input.forward || input.backward || input.left || input.right || input.jump || input.action) {
          try { (inputManager as any).unsquelchJoystick(); } catch (e) {}
        }
      }
    } catch (e) {}

    // Prefer analog axes when an InputManager is supplied
    let axes: Axes | null = null;
    try {
      if (inputManager && typeof (inputManager as any).getAxes === 'function') {
        axes = (inputManager as any).getAxes(true) as Axes;
      }
    } catch (e) {
      axes = null;
    }

    if (axes) {
      // axes.x: left (-1) -> right (+1)
      // axes.y: forward (+1) -> backward (-1)
      // apply deadzone to avoid controller drift
      const applyDead = (v: number) => {
        const dz = this.inputDeadzone;
        if (Math.abs(v) <= dz) return 0;
        const sign = Math.sign(v);
        return sign * ((Math.abs(v) - dz) / (1 - dz));
      };
      moveDirection.x = applyDead(axes.x);
      moveDirection.z = -applyDead(axes.y); // invert to match local forward = -Z
    } else {
      if (input.forward) moveDirection.z -= 1;
      if (input.backward) moveDirection.z += 1;
      if (input.left) moveDirection.x -= 1;
      if (input.right) moveDirection.x += 1;
    }

  const rawMag = moveDirection.length();
  // require a bit larger threshold to avoid tiny drift
  const hasInput = rawMag > 0.02;

    // Determine sprint as continuous 0..1 (prefer InputManager.getSprintValue if available)
    let sprintValue = 0;
    try {
      if (inputManager && typeof (inputManager as any).getSprintValue === 'function') {
        sprintValue = (inputManager as any).getSprintValue();
      } else {
        sprintValue = input.sprint ? 1 : 0;
      }
    } catch (e) {
      sprintValue = input.sprint ? 1 : 0;
    }

    // Compute effective speed (continuous) where sprintValue blends between base and sprintMultiplier
    const currentSpeed = this.speed * (1 + (this.sprintMultiplier - 1) * Math.max(0, Math.min(1, sprintValue)));

    // Convert local input direction into a world-space tangent direction.
    // If a camera is provided, interpret input relative to camera yaw (typical third-person control).
    let desiredVel = new THREE.Vector3(0, 0, 0);
    if (hasInput) {
      // scale movement by axis magnitude but clamp so diagonals don't exceed maximum speed
      const raw = moveDirection.clone();
      const mag = raw.length();
      let dir = new THREE.Vector3();
      let speedScale = 0;
      if (mag > 1e-4) {
        dir.copy(raw).normalize();
        speedScale = Math.min(1, mag);
      }
      let worldDir = new THREE.Vector3();
      if (camera) {
        // extract yaw (Y axis) from camera quaternion and apply it to input
        const camEuler = new THREE.Euler().setFromQuaternion(camera.quaternion, 'YXZ');
        const yaw = camEuler.y || 0;
        const yawQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
        worldDir = dir.clone().applyQuaternion(yawQuat).normalize();
      } else {
        // fallback: interpret input relative to character's current orientation
        worldDir = dir.clone().applyQuaternion(this.mesh.quaternion).normalize();
      }
      // Project movement onto tangent plane (perpendicular to radial direction)
      // This ensures movement stays on the surface and doesn't try to move "into" or "away from" island
      const islandCenter = this.island.getCenter();
      const radial = this.mesh.position.clone().sub(islandCenter).normalize();
      worldDir.projectOnPlane(radial).normalize();

      // Only set desired velocity if projection succeeded (vector not zero)
      if (worldDir.lengthSq() > 0.01) {
        desiredVel.copy(worldDir).multiplyScalar(currentSpeed * speedScale);
      }
    }

    // Smoothly accelerate / decelerate velocity with enhanced smoothing
    const accelFactor = Math.min(1, this.accel * deltaTime);
    if (hasInput) {
      if (this.isAirborne) {
        // limited horizontal control while in air, but preserve momentum
        const airControl = desiredVel.clone().multiplyScalar(this.airborneControlFactor);
        this.velocity.lerp(airControl, accelFactor * 0.5);
      } else {
        // Enhanced ground movement with velocity smoothing
        const smoothFactor = 1.0 - this.velocitySmoothing;
        this.velocity.lerp(desiredVel, accelFactor * smoothFactor);
      }
    } else {
      // apply friction to slow down (less friction while airborne)
      const frictionAmount = this.isAirborne ? this.friction * 0.3 : this.friction;
      const f = Math.min(1, frictionAmount * deltaTime);
      this.velocity.lerp(new THREE.Vector3(0,0,0), f);
    }

    // Hard-stop very small velocities to avoid drifting due to float error
    if (!this.isAirborne && this.velocity.length() < 0.01) {
      this.velocity.set(0,0,0);
    }

    // Handle jump input (rising edge) with enhanced jump feel
    const jumpPressed = !!input.jump;
    if (jumpPressed && !this.prevJumpPressed && !this.isAirborne) {
      // initiate jump away from surface normal; scale by sprint for higher jumps
      const sprintFactor = 1 + 0.45 * sprintValue; // more dramatic sprint jump boost
      this.verticalVelocity = this.jumpStrength * sprintFactor;
      this.isAirborne = true;
      this.wasAirborne = true;
    }
    this.prevJumpPressed = jumpPressed;

    // Apply movement
    if (this.velocity.lengthSq() > 1e-6 || this.isAirborne) {
      const deltaPos = this.velocity.clone().multiplyScalar(deltaTime);
      const oldPos = this.mesh.position.clone();

      // If airborne, apply vertical velocity along the local surface normal
      if (this.isAirborne) {
        // Sample surface near current horizontal direction to find landing target and normal
        const center = this.island.getCenter();
        const dir = this.mesh.position.clone().sub(center).normalize();
        const sampled = this.island.sampleSurfaceByDirection(dir, 0.0);
        const normal = sampled.normal.clone();

        // Calculate height above surface for dynamic gravity
        const heightAboveSurface = this.mesh.position.clone().sub(sampled.position).dot(normal);

        // Dynamic gravity: stronger when higher up (more realistic)
        this.gravityMultiplier = 1.0 + Math.max(0, heightAboveSurface * 0.15);
        const effectiveGravity = this.gravity * this.gravityMultiplier;

        // integrate vertical along normal and horizontal delta in tangent space
        this.mesh.position.add(normal.clone().multiplyScalar(this.verticalVelocity * deltaTime));
        this.mesh.position.add(deltaPos);

        // apply enhanced gravity with better fall curve
        this.verticalVelocity -= effectiveGravity * deltaTime;

        // clamp terminal velocity to avoid extreme falling (realistic terminal velocity)
        const maxFall = -15;
        if (this.verticalVelocity < maxFall) this.verticalVelocity = maxFall;

        // Enhanced landing check: smoother landing detection with proper threshold
        // Threshold accounts for epsilon offset in terrain sampling
        const worldDist = this.mesh.position.clone().sub(sampled.position).dot(normal);
        if (worldDist <= 0.15 && this.verticalVelocity <= 0) {
          this.isAirborne = false;
          this.verticalVelocity = 0;
          this.landingTime = performance.now() / 1000;

          // snap fully to surface when landing to avoid bounce
          this.stickToIsland(1);

          // Emit landing event for effects (dust, sound, etc.)
          if (this.wasAirborne) {
            try {
              window.dispatchEvent(new CustomEvent('player:landed', {
                detail: {
                  position: this.mesh.position.clone(),
                  velocity: this.velocity.length(),
                  hardLanding: this.velocity.length() > currentSpeed * 1.2
                }
              }));
            } catch (e) { /* ignore */ }
          }
          this.wasAirborne = false;
        }
      } else {
        // grounded movement -- move along tangent and then project back to surface
        // apply horizontal delta then project; clamp per-frame move to avoid teleport spikes
        const prevPos = this.mesh.position.clone();
        this.mesh.position.add(deltaPos);

        // More generous movement clamping to allow free roaming
        // Increased multiplier from 1.5 to 2.5 for smoother high-speed movement
        const maxMove = Math.max(1.0, currentSpeed * deltaTime * 2.5);
        const moved = this.mesh.position.clone().sub(prevPos);
        if (moved.length() > maxMove) {
          moved.setLength(maxMove);
          this.mesh.position.copy(prevPos.clone().add(moved));
        }

        // Only stick to island every 3rd frame during movement to reduce jitter
        // This allows smoother movement while still maintaining terrain adherence
        this.frameCount++;
        if (this.frameCount % 5 === 0) {
          this.stickToIsland(0.3);
        }
      }

      // Rotate character to face movement direction with stable yaw tracking
      const moved = this.mesh.position.clone().sub(oldPos);
      const movedLen = moved.length();
      if (movedLen > 1e-4) {
        // Calculate target yaw from movement direction
        const heading = moved.clone().normalize();
        const targetYaw = Math.atan2(heading.x, heading.z);

        // Smooth yaw rotation
        const yawDiff = targetYaw - this.currentYaw;
        // Normalize angle difference to [-PI, PI]
        let normalizedDiff = ((yawDiff + Math.PI) % (Math.PI * 2)) - Math.PI;
        if (normalizedDiff < -Math.PI) normalizedDiff += Math.PI * 2;

        // Enhanced rotation smoothing based on movement state
        const baseRotSpeed = this.turnSpeed;
        const sprintRotBoost = 1.0 + (sprintValue * 0.3); // faster turning when sprinting
        const airborneRotPenalty = this.isAirborne ? 0.6 : 1.0; // slower turning in air
        const effectiveRotSpeed = baseRotSpeed * sprintRotBoost * airborneRotPenalty;

        const rotationAmount = normalizedDiff * Math.min(1, effectiveRotSpeed * deltaTime);
        this.currentYaw += rotationAmount;

        // Build rotation quaternion from stable yaw and surface normal
        const center = this.island.getCenter();
        const radial = this.mesh.position.clone().sub(center).normalize();
        const yawQuat = new THREE.Quaternion().setFromAxisAngle(radial, this.currentYaw);

        // Create forward from yaw rotation
        const worldForward = new THREE.Vector3(0, 0, -1);
        const forward = worldForward.clone().applyQuaternion(yawQuat);
        const right = new THREE.Vector3().crossVectors(radial, forward).normalize();
        const correctedForward = new THREE.Vector3().crossVectors(right, radial).normalize();

        const mat = new THREE.Matrix4();
        mat.makeBasis(right, radial, correctedForward);
        this.targetRotation.setFromRotationMatrix(mat);

        // Gentle quaternion smoothing
        const slerpFactor = 0.2;
        this.mesh.quaternion.slerp(this.targetRotation, slerpFactor);
      }

  // Minimal rotation smoothing: remove procedural sway for simpler, stable feel
  try { this.mesh.rotation.y = THREE.MathUtils.lerp(this.mesh.rotation.y, 0, 0.08); } catch (e) {}
  try { (this.mesh.children[1] as THREE.Mesh).rotation.y = THREE.MathUtils.lerp((this.mesh.children[1] as THREE.Mesh).rotation.y, 0, 0.08); } catch (e) {}
    } else {
      // ensure we stick to island when standing still, but only every 10th frame
      this.frameCount++;
      if (this.frameCount % 10 === 0) {
        this.stickToIsland(0.2);
      }
      // relax rotations
      try { this.mesh.rotation.y = THREE.MathUtils.lerp(this.mesh.rotation.y, 0, 0.1); } catch (e) {}
      try { (this.mesh.children[1] as THREE.Mesh).rotation.y = THREE.MathUtils.lerp((this.mesh.children[1] as THREE.Mesh).rotation.y, 0, 0.1); } catch (e) {}
    }

    // Safety check: ensure player never gets too far from island surface
    // This prevents falling through terrain or getting stuck in weird positions
    try {
      const center = this.island.getCenter();
      const dist = this.mesh.position.distanceTo(center);
      const expectedRadius = this.island.getRadius() + 1.0; // player height offset
      const maxDeviation = 10.0; // Generous tolerance for peaks (4.2) + jumps (2.5) + margin

      // If player is way too far or too close to center, reset to safe position
      if (dist > expectedRadius + maxDeviation || dist < expectedRadius - maxDeviation) {
        console.warn('Player position outside safe bounds, correcting...', { dist, expectedRadius });
        const safeDir = this.mesh.position.clone().sub(center).normalize();
        const safeSampled = this.island.sampleSurfaceByDirection(safeDir, 1.0);
        this.mesh.position.copy(safeSampled.position);
        this.velocity.multiplyScalar(0.8); // Gentle velocity reduction to prevent immediate re-occurrence
        this.isAirborne = false;
        this.verticalVelocity = 0;
      }
    } catch (e) {
      // Fail silently - this is just a safety check
    }

    // Update debug overlay if present
    try {
      if (this.debugOverlay) {
        const lines: string[] = [];
        lines.push(`pos: ${this.mesh.position.x.toFixed(2)},${this.mesh.position.y.toFixed(2)},${this.mesh.position.z.toFixed(2)}`);
        lines.push(`vel: ${this.velocity.x.toFixed(2)},${this.velocity.y.toFixed(2)},${this.velocity.z.toFixed(2)} (mag:${this.velocity.length().toFixed(2)})`);
        lines.push(`airborne: ${this.isAirborne} vY:${this.verticalVelocity.toFixed(2)}`);
        // axes
        try { if (axes) lines.push(`axes: x:${axes.x.toFixed(2)} y:${axes.y.toFixed(2)}`); } catch (e) {}
        // sampled surface at current direction
        try {
          const center = this.island.getCenter();
          const dir = this.mesh.position.clone().sub(center).normalize();
          const sampled = this.island.sampleSurfaceByDirection(dir, 1.0);
          lines.push(`surface: ${sampled.position.x.toFixed(2)},${sampled.position.y.toFixed(2)},${sampled.position.z.toFixed(2)}`);
          lines.push(`normal: ${sampled.normal.x.toFixed(2)},${sampled.normal.y.toFixed(2)},${sampled.normal.z.toFixed(2)}`);
        } catch (e) {}
        try { if (inputManager && typeof (inputManager as any).getJoystickIdleMs === 'function') lines.push(`joyIdle: ${Math.round((inputManager as any).getJoystickIdleMs())}ms`); } catch (e) {}
        try { if (inputManager && typeof (inputManager as any).isJoystickSquelched === 'function') lines.push(`joySquelch: ${ (inputManager as any).isJoystickSquelched() ? 'YES' : 'NO' }`); } catch (e) {}

        // Collect scene/system metrics if we have a scene reference
        const metrics: any = {};
        try {
          if (this.sceneRef) {
            metrics.sceneObjects = this.sceneRef.children.length;
            // count unique geometries and textures
            const geoms = new Set<any>();
            const texs = new Set<any>();
            this.sceneRef.traverse((o: any) => {
              try { if (o && o.geometry) geoms.add(o.geometry); } catch (e) {}
              try { if (o && o.material) {
                if (Array.isArray(o.material)) o.material.forEach((m: any) => m && m.map && texs.add(m.map));
                else if (o.material.map) texs.add(o.material.map);
              } } catch (e) {}
            });
            metrics.geometries = geoms.size;
            metrics.textures = texs.size;
          }
          if ((performance as any).memory) metrics.memoryMB = ((performance as any).memory.usedJSHeapSize || 0) / (1024*1024);
          metrics.pendingGLTF = getPendingGLTFLoads();
        } catch (e) {}

        this.debugOverlay.update({ lines, metrics });
        try { logger.updateMetrics(metrics); } catch (e) {}
      }
    } catch (e) {}
  }

  /**
   * Stick to the island surface. Accepts an optional smoothing factor (0..1)
   */
  private stickToIsland(smooth: number = 1): void {
    // Project the player's position onto the island spherical surface and orient to local normal.
    try {
      const center = this.island.getCenter();
      // Use sampling API to get an accurate surface point + normal near current position
      const dir = this.mesh.position.clone().sub(center);
      let sampleDir = dir.clone();
      if (sampleDir.lengthSq() < 1e-4) sampleDir = new THREE.Vector3(0, 0, -1);
      // Sample surface with NO offset - player should be ON the ground
      const sampled = this.island.sampleSurfaceByDirection(sampleDir.normalize(), 0.0);

      // Check if position correction is significant enough to apply (prevent micro-jitter)
      const distToTarget = this.mesh.position.distanceTo(sampled.position);

      // More aggressive repositioning to prevent floating - reduce threshold
      if (distToTarget > this.positionStabilityThreshold * 0.5) {
        // place the player at the sampled surface
        const blend = Math.max(0, Math.min(1, smooth));
        if (blend >= 0.999) this.mesh.position.copy(sampled.position);
        else this.mesh.position.lerp(sampled.position, blend);
      }

      // Orient player to stand upright on surface using stable yaw
      const radial = sampled.normal.clone();

      // Use stable currentYaw to build consistent rotation
      const yawQuat = new THREE.Quaternion().setFromAxisAngle(radial, this.currentYaw);
      const worldForward = new THREE.Vector3(0, 0, -1);
      const forward = worldForward.clone().applyQuaternion(yawQuat);
      const right = new THREE.Vector3().crossVectors(radial, forward).normalize();
      const correctedForward = new THREE.Vector3().crossVectors(right, radial).normalize();

      const mat = new THREE.Matrix4();
      mat.makeBasis(right, radial, correctedForward);
      const targetQuat = new THREE.Quaternion().setFromRotationMatrix(mat);

      // Extremely gentle orientation smoothing to maintain stability
      const orientationSmoothing = 0.15;
      this.mesh.quaternion.slerp(targetQuat, orientationSmoothing);
    } catch (e) {
      // fallback
      this.mesh.quaternion.set(0, 0, 0, 1);
    }
  }

  public getPosition(): THREE.Vector3 {
    return this.mesh.position.clone();
  }

  public getVelocity(): THREE.Vector3 {
    return this.velocity.clone();
  }

  public isSprinting(): boolean {
    // Check if player is currently moving at sprint speed
    return this.velocity.length() > this.speed * 1.3;
  }

  // Immediately align player's yaw to a given camera yaw (in radians)
  public alignToYaw(yaw: number): void {
    // compute surface normal aligned basis but rotate around up by yaw
    const surfaceNormal = this.mesh.position.clone().sub(this.island.getCenter()).normalize();
    const up = surfaceNormal;
    const yawQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,1,0), yaw);
    // create a forward vector by rotating the world forward by yaw, then project onto tangent
    const forward = new THREE.Vector3(0,0,-1).applyQuaternion(yawQuat).projectOnPlane(up).normalize();
    if (forward.lengthSq() < 1e-6) return;
    const right = new THREE.Vector3().crossVectors(up, forward).normalize();
    const mat = new THREE.Matrix4(); mat.makeBasis(right, up, forward);
    const targetQuat = new THREE.Quaternion().setFromRotationMatrix(mat);
    this.mesh.quaternion.copy(targetQuat);
  }

  public addToScene(scene: THREE.Scene): void {
    scene.add(this.mesh);
    this.sceneRef = scene;
  }

  public updateCustomization(customization: CharacterCustomization): void {
    this.customization = customization;
    // Only update procedural character parts if the model hasn't been replaced by a GLTF
    if (!this.modelLoaded) {
      try { (this.mesh.children[0] as THREE.Mesh).material = Materials.createCharacterBodyMaterial(); } catch (e) {}
      try { (this.mesh.children[1] as THREE.Mesh).material = Materials.createCharacterHeadMaterial(); } catch (e) {}
      try { (this.mesh.children[2] as THREE.Mesh).material = Materials.createPBRMaterial({ color: customization.hairColor, roughness: 0.6 }); } catch (e) {}
    } else {
      // If a GLTF model is loaded, attempt to apply simple color overrides to known nodes (best-effort)
      try {
        this.modelMesh && this.modelMesh.traverse((o: any) => {
          if (!o.isMesh || !o.material) return;
          // common naming: head, hair, body
          const name = (o.name || '').toLowerCase();
          if (name.includes('hair')) {
            // Load hair texture
            const textureLoader = new THREE.TextureLoader();
            const hairTexture = textureLoader.load('/assets/models/T_Hair_2_BaseColor.png');
            o.material.map = hairTexture;
            o.material.needsUpdate = true;
          }
          if (name.includes('head') || name.includes('face')) {
            // For skin, perhaps adjust color or use a skin texture if available
            try { o.material.color && (o.material.color.setHex(customization.skinColor)); } catch (e) {}
          }
          if (name.includes('body') || name.includes('torso') || name.includes('shirt')) {
            // Load body texture
            const textureLoader = new THREE.TextureLoader();
            const bodyTexture = textureLoader.load('/assets/models/T_Superhero_Female_Dark_BaseColor.png');
            o.material.map = bodyTexture;
            o.material.needsUpdate = true;
          }
        });
      } catch (e) { }
    }
  }

  /**
   * Cleanup method to dispose all Three.js resources (geometries, materials, textures).
   * Call this when tearing down the player or on hot reload to prevent memory leaks.
   */
  public dispose(): void {
    // Stop animation mixer
    if (this.animationMixer) {
      try {
        this.animationMixer.stopAllAction();
      } catch (e) {
        // ignore
      }
      this.animationMixer = null;
    }

    // Dispose all geometries, materials, and textures in the character mesh hierarchy
    this.mesh.traverse((obj) => {
      if ((obj as any).isMesh) {
        const mesh = obj as THREE.Mesh;

        // Dispose geometry
        if (mesh.geometry) {
          mesh.geometry.dispose();
        }

        // Dispose material(s)
        if (mesh.material) {
          if (Array.isArray(mesh.material)) {
            mesh.material.forEach((mat) => this.disposeMaterial(mat));
          } else {
            this.disposeMaterial(mesh.material);
          }
        }
      }
    });

    // Remove mesh from parent if attached
    if (this.mesh.parent) {
      this.mesh.parent.remove(this.mesh);
    }

    // Dispose debug overlay if exists
    if (this.debugOverlay) {
      try {
        (this.debugOverlay as any).dispose?.();
      } catch (e) {
        // ignore
      }
      this.debugOverlay = null;
    }

    // Clear model references
    this.modelMesh = null;
    this.modelAnimations = [];
    this.currentAction = null;
    this.sceneRef = null;
  }

  /**
   * Helper method to dispose a material and its textures
   */
  private disposeMaterial(material: THREE.Material): void {
    // Dispose all textures in the material
    const materialWithMaps = material as any;
    if (materialWithMaps.map) materialWithMaps.map.dispose();
    if (materialWithMaps.normalMap) materialWithMaps.normalMap.dispose();
    if (materialWithMaps.roughnessMap) materialWithMaps.roughnessMap.dispose();
    if (materialWithMaps.metalnessMap) materialWithMaps.metalnessMap.dispose();
    if (materialWithMaps.aoMap) materialWithMaps.aoMap.dispose();
    if (materialWithMaps.emissiveMap) materialWithMaps.emissiveMap.dispose();
    if (materialWithMaps.bumpMap) materialWithMaps.bumpMap.dispose();
    if (materialWithMaps.displacementMap) materialWithMaps.displacementMap.dispose();
    if (materialWithMaps.alphaMap) materialWithMaps.alphaMap.dispose();
    if (materialWithMaps.envMap) materialWithMaps.envMap.dispose();

    // Dispose the material itself
    material.dispose();
  }
}

