import * as THREE from 'three';
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js';

import { Materials } from './Materials';
import { loadGLTFWithFallbacks, setupModelAnimation } from './utils/GLTFModelLoader';

/** A remote player's rendered avatar — the SAME rigged model the local
 * player uses, so a visitor looks identical on every screen. */
export interface RemoteAvatar {
  body: THREE.Group;
  headBone: THREE.Object3D | null;
  update: (dt: number, speed: number) => void;
  // Pose byte broadcast by the owner (0 on-foot, 1 swimming, 2 riding, 3 airborne)
  // so peers strike the right pose instead of always walk-cycling upright.
  setPose: (pose: number) => void;
  // Play the arm-raise wave gesture (mirrors the local player's Q wave).
  wave: () => void;
  dispose: () => void;
}

/** Cosmetic hats sold in the island shop. */
export type HatId =
  | 'party'
  | 'top'
  | 'crown'
  | 'cap'
  | 'flower'
  | 'wizard'
  | 'halo'
  | 'pirate'
  | 'chef'
  | 'headphones';

/** Recolourable body parts (mapped to the model's named materials). */
export type BodyPart = 'outfit' | 'pants' | 'hair' | 'skin';
const PART_MATERIAL: Record<BodyPart, string> = {
  outfit: 'Jacket',
  pants: 'Pants',
  hair: 'Hair',
  skin: 'Skin',
};

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
  private targetYaw: number = 0; // heading setRotation asked for; yaw eases onto it in update()
  private yawVel: number = 0; // yaw rad/s actually applied this frame — drives the turn lean
  private leanRoll: number = 0; // eased roll into turns (on-foot only)

  private speed: number = 8.0; // movement speed. Bumped 5.5→7.0→8.0 alongside the R30→40→50 grows so crossing the (now much bigger) island stays ~22s — a roomier world, not a tediously long walk.
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

  // Water: given the outward unit direction, returns the wavy water-surface
  // radius there and whether it is open water (terrain below the sea).
  private waterSampler:
    | ((outwardDir: THREE.Vector3) => { surface: number; isWater: boolean })
    | null = null;
  private swimIntent = false; // swim button held this frame
  private inWater = false; // over open water right now
  private swimming = false; // afloat (in water + intent held)
  private oxygen = 1; // 1 = full breath, 0 = drowned
  private onDrown: (() => void) | null = null;
  private static readonly SWIM_FLOAT = 0.55; // player centre above the surface while afloat
  private static readonly DROWN_RATE = 0.16; // oxygen/sec while under (≈6s)
  private static readonly RECOVER_RATE = 0.5; // oxygen/sec refill out of danger
  // Shoreline barrier: the island is the north cap, so `dir.y` (= sin latitude)
  // shrinks as you swim out to sea. Past this a current pushes you back so the
  // open ocean isn't a place to get lost forever.
  // Swimmers get a shorter leash than boats (drowning is a real risk out
  // there), but 0.05 was only ~2 units of water once the irregular coastline
  // dropped the shore to y≈0.14 in places — you were turned back almost at the
  // beach. -0.08 gives room to actually swim offshore.
  private static readonly SWIM_LIMIT_Y = -0.08;
  private static readonly _poleUp = new THREE.Vector3(0, 1, 0);
  private _swimTangent = new THREE.Vector3();
  private beyondSwimLimit = false; // true while the swim-back current is active

  private moveInput: THREE.Vector3 = new THREE.Vector3(); // (x=strafe, y=unused, z=forward)
  private wantJump: boolean = false;
  private rideActive = false; // physics suspended while riding a boat/jetski
  private rideKind: 'boat' | 'jetski' = 'boat';
  private rideBob = 0; // idle-sway clock for the riding pose

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
  private armLBone: THREE.Bone | null = null;
  private armRBone: THREE.Bone | null = null;
  private swimPhase = 0; // stroke-cycle clock
  private wasInWater = false; // edge-detect for the entry splash
  private justEnteredWater = false;
  private swimPoseActive = false; // swim pose currently overriding the mixer

  // Jump/air pose (on-foot only): eases 0→1 while airborne, back on land.
  private airPoseWeight = 0;
  // Arm-wave gesture: seconds of the ~1.2s wave remaining (0 = idle).
  private waveTime = 0;
  private static readonly WAVE_DURATION = 1.2;
  // Ground speed at which the walk clip reads natural at timeScale 1; the clip
  // rate is scaled by tangentialSpeed / this so slow walks don't moonwalk and
  // runs don't foot-slide.
  private static readonly WALK_REF_SPEED = 4.2;

  // Per-frame scratch (avoid allocating in update()/updateWorldMatrix hot paths)
  private _normalScratch = new THREE.Vector3();
  private _vecScratch = new THREE.Vector3();
  private _alignQuat = new THREE.Quaternion();
  private _yawQuat = new THREE.Quaternion();

  // Shop cosmetics: hat attached to the head bone (or fallback head)
  private currentHat: THREE.Group | null = null;
  private pendingHatId: HatId | null = null;
  // Player-chosen body colours (applied by material name; re-applied when the
  // GLTF finishes loading so a choice made during the fly-in isn't lost).
  private appearance: Partial<Record<BodyPart, number>> = {};

  // GLTF model support
  private gltfModel: THREE.Group | null = null;
  private animationMixer: THREE.AnimationMixer | null = null;
  private idleAction: THREE.AnimationAction | null = null;
  private walkAction: THREE.AnimationAction | null = null;

  constructor() {
    super();
    this.name = 'SimplePlayer';

    const group = new THREE.Group();

    // Material names match the GLTF model's, so setBodyColor() recolours both
    // the fallback body (no model) and the real model by the same lookup.
    const shirtMat = Materials.createToonMaterial(0x4a90e2);
    shirtMat.name = 'Jacket';
    const skinMat = Materials.createToonMaterial(0xffddaa);
    skinMat.name = 'Skin';
    const pantsMat = Materials.createToonMaterial(0x2a3a5a);
    pantsMat.name = 'Pants';
    const shoeMat = Materials.createToonMaterial(0x3d2b1a);
    shoeMat.name = 'Shoe';
    const hairMat = Materials.createToonMaterial(0x3a2a1a);
    hairMat.name = 'Hair';
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
    for (const [ex, ey, ez] of [
      [-0.08, 0.76, 0.17],
      [0.08, 0.76, 0.17],
    ] as [number, number, number][]) {
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
    const mouth = new THREE.Mesh(new THREE.TorusGeometry(0.04, 0.01, 4, 8, Math.PI), eyeMat);
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

  /** Water-surface sampler (see updateWaterState). */
  public setWaterSampler(
    sampler: (outwardDir: THREE.Vector3) => { surface: number; isWater: boolean },
  ): void {
    this.waterSampler = sampler;
  }

  /** Called when oxygen hits zero (GameScene respawns the player). */
  public setOnDrown(cb: () => void): void {
    this.onDrown = cb;
  }

  /** Hold the swim button to stay afloat; release in water to drown. */
  public setSwimIntent(held: boolean): void {
    this.swimIntent = held;
  }

  public isInWater(): boolean {
    return this.inWater;
  }
  public isSwimming(): boolean {
    return this.swimming;
  }
  public getOxygen(): number {
    return this.oxygen;
  }
  /** True while the shoreline current is actively pushing the swimmer back. */
  public isBeyondSwimLimit(): boolean {
    return this.beyondSwimLimit;
  }
  /** Reset breath (call on respawn after a drown). */
  public resetOxygen(): void {
    this.oxygen = 1;
  }
  /** Suspend physics while riding a vehicle (GameScene drives the transform). */
  public setRiding(active: boolean, kind: 'boat' | 'jetski' = 'boat'): void {
    this.rideActive = active;
    this.rideKind = kind;
    if (active) {
      this.velocity.set(0, 0, 0);
      // Leaving the water for the deck: drop the swim tilt + state so the
      // rider doesn't stay in a prone swim pose on the vehicle.
      this.clearSwimPose();
      this.swimPoseActive = false;
      this.inWater = false;
      this.swimming = false;
      this.airPoseWeight = 0;
    } else {
      // Back to swimming/walking: neutralise the posed bones + model tilt so
      // the mixer / swim pose take over cleanly.
      if (this.gltfModel) this.gltfModel.rotation.set(0, 0, 0);
      else this.mesh.rotation.set(0, 0, 0);
      this.leanRoll = 0;
      this.yawVel = 0;
      for (const b of [this.armLBone, this.armRBone, this.legLBone, this.legRBone]) {
        if (b) b.rotation.set(0, 0, 0);
      }
      for (const p of [...this.legPivots, ...this.armPivots]) p.rotation.x = 0;
    }
  }

  /**
   * Recolour a body part by its material name (works on the fallback body and
   * the GLTF model + the added hair cap). Stored so it survives a model reload.
   */
  public setBodyColor(part: BodyPart, hex: number): void {
    this.appearance[part] = hex;
    const matName = PART_MATERIAL[part];
    const recolour = (root: THREE.Object3D) => {
      root.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh && !(mesh as THREE.SkinnedMesh).isSkinnedMesh) return;
        // The hair cap we add follows the hair colour (it has no material name)
        if (part === 'hair' && mesh.name === 'hair_cap') {
          const hm = mesh.material as THREE.MeshStandardMaterial;
          hm?.color?.setHex(hex);
          return;
        }
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const m of mats) {
          const sm = m as THREE.MeshStandardMaterial;
          if (sm && sm.name === matName && sm.color) sm.color.setHex(hex);
        }
      });
    };
    recolour(this);
    if (this.gltfModel) recolour(this.gltfModel);
  }

  /** Re-apply every stored colour (call after the GLTF model swaps in). */
  private reapplyAppearance(): void {
    for (const key of Object.keys(this.appearance) as BodyPart[]) {
      const hex = this.appearance[key];
      if (typeof hex === 'number') this.setBodyColor(key, hex);
    }
  }

  /** Current chosen colours (for the customiser to show the active swatch). */
  public getAppearance(): Partial<Record<BodyPart, number>> {
    return { ...this.appearance };
  }

  /**
   * Equip a shop hat (null removes). Attaches to the GLTF head bone so it
   * tracks animation; queued if the model hasn't finished loading yet.
   */
  public equipHat(id: HatId | null): void {
    // Find the attachment point: head bone (GLTF) or the fallback head
    let parent: THREE.Object3D | null = null;
    if (this.gltfModel) {
      this.gltfModel.traverse((o) => {
        if (!parent && (o as THREE.Bone).isBone && o.name === 'head') parent = o;
      });
    }
    if (!parent && !this.gltfModel) {
      this.pendingHatId = id;
      parent = this.mesh; // fallback model: hat sits on the group
    }
    if (!parent) {
      this.pendingHatId = id;
      return;
    }
    if (this.currentHat) {
      this.currentHat.parent?.remove(this.currentHat);
      this.currentHat = null;
    }
    if (!id) return;
    const hat = SimplePlayer.buildHat(id);
    // Head bone: crown of the head is ~0.34 above the bone origin.
    // Fallback group: head sphere top is ~0.94.
    hat.position.set(0, this.gltfModel ? 0.36 : 0.95, 0);
    parent.add(hat);
    this.currentHat = hat;
  }

  // Base model loaded once, then skeleton-cloned per remote player.
  private static remoteBasePromise: Promise<{
    scene: THREE.Group;
    animations: THREE.AnimationClip[];
  } | null> | null = null;

  /**
   * Build a remote-player avatar from the SAME rigged GLB the local player
   * uses (skeleton-cloned so animation is independent). This is why other
   * visitors used to look different to you than they do to themselves — the
   * local player was the GLTF hero while peers were a crude cylinder figure.
   * Returns null if the model can't load (caller keeps its procedural body).
   */
  public static async createRemoteAvatar(): Promise<RemoteAvatar | null> {
    if (!this.remoteBasePromise) {
      this.remoteBasePromise = loadGLTFWithFallbacks('/assets/models/player.glb', { scale: 0.88 })
        .then((r) => (r ? { scene: r.scene, animations: r.animations } : null))
        .catch(() => null);
    }
    const base = await this.remoteBasePromise;
    if (!base) return null;

    const model = cloneSkeleton(base.scene) as THREE.Group;
    // SkeletonUtils.clone SHARES materials with the base (and every other peer),
    // so per-peer body-colour sync needs independent material instances. Clone
    // them once here (geometry stays shared — cheap) and track for disposal.
    const clonedMats: THREE.Material[] = [];
    model.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh && !(m as THREE.SkinnedMesh).isSkinnedMesh) return;
      if (Array.isArray(m.material)) {
        m.material = m.material.map((x) => {
          const c = x.clone();
          clonedMats.push(c);
          return c;
        });
      } else if (m.material) {
        const c = (m.material as THREE.Material).clone();
        clonedMats.push(c);
        m.material = c;
      }
    });
    const body = new THREE.Group();
    body.add(model);
    body.updateMatrixWorld(true);

    // Feet calibration to local -0.7 (same as the local player) so the peer
    // group origin lines up with the broadcast player-centre position.
    try {
      const box = new THREE.Box3().setFromObject(model);
      if (Number.isFinite(box.min.y)) model.position.y += -0.7 - box.min.y;
    } catch {
      /* keep default placement */
    }

    // Limb bones captured for the broadcast swim/ride/air poses + the wave.
    let headBone: THREE.Object3D | null = null;
    let armLBone: THREE.Object3D | null = null;
    let armRBone: THREE.Object3D | null = null;
    let legLBone: THREE.Object3D | null = null;
    let legRBone: THREE.Object3D | null = null;
    model.traverse((o) => {
      if ((o as THREE.SkinnedMesh).isSkinnedMesh) o.frustumCulled = false;
      if (o instanceof THREE.Mesh) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
      if ((o as THREE.Bone).isBone) {
        if (o.name === 'head') headBone = headBone ?? o;
        else if (o.name === 'armL') armLBone = o;
        else if (o.name === 'armR') armRBone = o;
        else if (o.name === 'legL') legLBone = o;
        else if (o.name === 'legR') legRBone = o;
      }
    });

    // Match the local player's added hair cap (the GLB's own patch is sparse).
    // Named `hair_cap` so applyBodyColors can recolour it like the local one.
    let hairCapGeom: THREE.BufferGeometry | null = null;
    if (headBone) {
      const hairMat = new THREE.MeshToonMaterial({ color: 0x6c594b });
      clonedMats.push(hairMat);
      hairCapGeom = new THREE.SphereGeometry(0.21, 14, 10, 0, Math.PI * 2, 0, Math.PI * 0.62);
      const hair = new THREE.Mesh(hairCapGeom, hairMat);
      hair.name = 'hair_cap';
      hair.position.set(0, 0.16, -0.02);
      hair.rotation.x = 0.25;
      hair.castShadow = true;
      (headBone as THREE.Object3D).add(hair);
    }

    // Idle/walk blend so peers never freeze in the bind (T) pose
    let mixer: THREE.AnimationMixer | null = null;
    let idle: THREE.AnimationAction | null = null;
    let walk: THREE.AnimationAction | null = null;
    if (base.animations.length) {
      mixer = new THREE.AnimationMixer(model);
      const idleClip = base.animations.find((c) => /idle/i.test(c.name));
      const walkClip = base.animations.find((c) => /walk|run/i.test(c.name));
      if (idleClip) {
        idle = mixer.clipAction(idleClip);
        idle.play();
      }
      if (walkClip) {
        walk = mixer.clipAction(walkClip);
        walk.setEffectiveWeight(0);
        walk.play();
      }
      if (!idle && !walk) mixer.clipAction(base.animations[0]).play();
    }

    // Broadcast pose (0 foot, 1 swim, 2 ride, 3 air) + eased override weight, so
    // a swimming/riding/jumping peer strikes the right pose instead of always
    // walk-cycling upright. Applied AFTER mixer.update (the clip writes the same
    // limb bones every frame); activePose remembers the last non-foot pose so it
    // eases back out. Wave overrides the right arm regardless of pose.
    let curPose = 0;
    let activePose = 0;
    let poseW = 0;
    let swimClock = 0;
    let waveT = 0;

    const update = (dt: number, speed: number): void => {
      if (mixer) mixer.update(dt);
      const overriding = curPose !== 0;
      if (walk) {
        const w = overriding ? 0 : THREE.MathUtils.clamp(speed / 3, 0, 1);
        walk.setEffectiveWeight(w);
        // Cadence follows measured ground speed so feet don't slide/moonwalk.
        walk.timeScale = THREE.MathUtils.clamp(speed / SimplePlayer.WALK_REF_SPEED, 0.6, 2.1); // ceiling raised 1.6→2.1: at the R50 run speed 8.0 the ratio is 1.9, so a 1.6 cap under-cycled the legs and slid the feet
        if (idle) idle.setEffectiveWeight(1 - w);
      }
      const k = Math.min(1, 10 * dt);
      if (curPose !== 0) activePose = curPose;
      poseW += ((overriding ? 1 : 0) - poseW) * k;
      if (poseW > 0.001 && activePose !== 0) {
        if (activePose === 1) {
          // Swimming: face-down tilt + alternating overhead crawl + flutter kick.
          swimClock += dt * 6;
          const s = Math.sin(swimClock);
          const s2 = Math.sin(swimClock * 2);
          model.rotation.x = 1.15 * poseW;
          model.rotation.z = s * 0.18 * poseW;
          if (armLBone)
            armLBone.rotation.x = THREE.MathUtils.lerp(armLBone.rotation.x, -1.4 + s * 1.3, poseW);
          if (armRBone)
            armRBone.rotation.x = THREE.MathUtils.lerp(armRBone.rotation.x, -1.4 - s * 1.3, poseW);
          if (legLBone)
            legLBone.rotation.x = THREE.MathUtils.lerp(legLBone.rotation.x, s2 * 0.35, poseW);
          if (legRBone)
            legRBone.rotation.x = THREE.MathUtils.lerp(legRBone.rotation.x, -s2 * 0.35, poseW);
        } else if (activePose === 2) {
          // Riding: forward lean, hands forward, knees up.
          model.rotation.set(0.12 * poseW, 0, 0);
          if (armLBone)
            armLBone.rotation.x = THREE.MathUtils.lerp(armLBone.rotation.x, -0.7, poseW);
          if (armRBone)
            armRBone.rotation.x = THREE.MathUtils.lerp(armRBone.rotation.x, -0.7, poseW);
          if (legLBone)
            legLBone.rotation.x = THREE.MathUtils.lerp(legLBone.rotation.x, -0.6, poseW);
          if (legRBone)
            legRBone.rotation.x = THREE.MathUtils.lerp(legRBone.rotation.x, -0.6, poseW);
        } else {
          // Airborne: arms up, knees tucked (additive on top of the mixer).
          model.rotation.set(0, 0, 0);
          if (armLBone) armLBone.rotation.x += -0.85 * poseW;
          if (armRBone) armRBone.rotation.x += -0.85 * poseW;
          if (legLBone) legLBone.rotation.x += -0.45 * poseW;
          if (legRBone) legRBone.rotation.x += -0.45 * poseW;
        }
      } else {
        model.rotation.set(0, 0, 0);
      }
      if (waveT > 0) {
        waveT = Math.max(0, waveT - dt);
        const elapsed = SimplePlayer.WAVE_DURATION - waveT;
        const env = Math.min(Math.min(1, elapsed / 0.15), Math.min(1, waveT / 0.25));
        if (armRBone) {
          armRBone.rotation.x = THREE.MathUtils.lerp(armRBone.rotation.x, -2.6, env);
          armRBone.rotation.z = Math.sin(elapsed * 14) * 0.4 * env;
        }
      }
    };
    const setPose = (pose: number): void => {
      curPose = pose;
    };
    const wave = (): void => {
      waveT = SimplePlayer.WAVE_DURATION;
    };
    const dispose = (): void => {
      mixer?.stopAllAction();
      // Materials were cloned per-peer above, so disposing them here is safe
      // (geometry stays shared with the base and is NOT disposed).
      for (const m of clonedMats) m.dispose();
      hairCapGeom?.dispose();
    };

    return { body, headBone, update, setPose, wave, dispose };
  }

  /** Procedural toon hats sold in the island shop (also used by remote avatars). */
  public static buildHat(id: HatId): THREE.Group {
    const g = new THREE.Group();
    g.name = 'player_hat';
    if (id === 'party') {
      const cone = new THREE.Mesh(
        new THREE.ConeGeometry(0.14, 0.32, 10),
        Materials.createToonMaterial(0xe84a5f),
      );
      cone.position.y = 0.16;
      g.add(cone);
      const pom = new THREE.Mesh(
        new THREE.SphereGeometry(0.05, 8, 6),
        Materials.createToonMaterial(0xfff5e0),
      );
      pom.position.y = 0.34;
      g.add(pom);
      g.rotation.z = 0.12;
    } else if (id === 'top') {
      const brim = new THREE.Mesh(
        new THREE.CylinderGeometry(0.24, 0.24, 0.03, 14),
        Materials.createToonMaterial(0x22222c),
      );
      g.add(brim);
      const crownPart = new THREE.Mesh(
        new THREE.CylinderGeometry(0.14, 0.15, 0.28, 14),
        Materials.createToonMaterial(0x22222c),
      );
      crownPart.position.y = 0.15;
      g.add(crownPart);
      const band = new THREE.Mesh(
        new THREE.CylinderGeometry(0.152, 0.155, 0.06, 14),
        Materials.createToonMaterial(0xc0392b),
      );
      band.position.y = 0.05;
      g.add(band);
    } else if (id === 'crown') {
      const goldMat = new THREE.MeshStandardMaterial({
        color: 0xffd34a,
        metalness: 0.7,
        roughness: 0.3,
        emissive: 0x553d00,
        emissiveIntensity: 0.25,
      });
      const ring = new THREE.Mesh(
        new THREE.CylinderGeometry(0.17, 0.19, 0.12, 10, 1, true),
        goldMat,
      );
      ring.material.side = THREE.DoubleSide;
      g.add(ring);
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2;
        const spike = new THREE.Mesh(new THREE.ConeGeometry(0.035, 0.11, 4), goldMat);
        spike.position.set(Math.cos(a) * 0.17, 0.11, Math.sin(a) * 0.17);
        g.add(spike);
      }
    } else if (id === 'cap') {
      // Baseball cap: dome + forward brim
      const capMat = Materials.createToonMaterial(0x3f6fb5);
      const dome = new THREE.Mesh(
        new THREE.SphereGeometry(0.2, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.5),
        capMat,
      );
      dome.scale.y = 0.75;
      g.add(dome);
      const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.15, 0.025, 10), capMat);
      brim.scale.z = 1.4;
      brim.position.set(0, 0.01, 0.2);
      g.add(brim);
      const button = new THREE.Mesh(
        new THREE.SphereGeometry(0.035, 8, 6),
        Materials.createToonMaterial(0x2c4f85),
      );
      button.position.y = 0.155;
      g.add(button);
    } else if (id === 'flower') {
      // Flower crown: leafy ring with alternating blooms
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(0.18, 0.035, 8, 16),
        Materials.createToonMaterial(0x4a8c3a),
      );
      ring.rotation.x = Math.PI / 2;
      ring.position.y = 0.04;
      g.add(ring);
      const BLOOM_COLORS = [0xe84a5f, 0xf7c948, 0xba68c8, 0xff8a65];
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        const bloom = new THREE.Mesh(
          new THREE.SphereGeometry(0.045, 8, 6),
          Materials.createToonMaterial(BLOOM_COLORS[i % BLOOM_COLORS.length]),
        );
        bloom.position.set(Math.cos(a) * 0.18, 0.07, Math.sin(a) * 0.18);
        g.add(bloom);
      }
    } else if (id === 'wizard') {
      // Wizard hat: tall starry cone with a wide floppy brim
      const feltMat = Materials.createToonMaterial(0x4b3a8c);
      const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.3, 0.03, 14), feltMat);
      g.add(brim);
      const cone = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.42, 12), feltMat);
      cone.position.y = 0.22;
      cone.rotation.z = 0.1;
      g.add(cone);
      const starMat = new THREE.MeshStandardMaterial({
        color: 0xffe066,
        emissive: 0xccaa22,
        emissiveIntensity: 0.5,
      });
      for (const [sx, sy, sz] of [
        [0.09, 0.16, 0.1],
        [-0.08, 0.28, 0.05],
        [0.02, 0.1, -0.12],
      ]) {
        const star = new THREE.Mesh(new THREE.OctahedronGeometry(0.028), starMat);
        star.position.set(sx, sy, sz);
        g.add(star);
      }
    } else if (id === 'pirate') {
      // Pirate bicorn: dark oval brim + rounded crown + white skull
      const blackMat = Materials.createToonMaterial(0x1c1c22);
      const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.27, 0.29, 0.03, 16), blackMat);
      brim.scale.x = 0.78;
      g.add(brim);
      const crown = new THREE.Mesh(
        new THREE.SphereGeometry(0.18, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.55),
        blackMat,
      );
      crown.scale.set(0.85, 0.7, 1);
      crown.position.y = 0.05;
      g.add(crown);
      const skull = new THREE.Mesh(
        new THREE.SphereGeometry(0.05, 8, 6),
        Materials.createToonMaterial(0xf3ecdd),
      );
      skull.scale.set(1, 1.15, 0.55);
      skull.position.set(0, 0.09, 0.19);
      g.add(skull);
    } else if (id === 'chef') {
      // Chef's toque: white band + a tall puffy top
      const whiteMat = Materials.createToonMaterial(0xf7f7f2);
      const band = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.13, 16), whiteMat);
      band.position.y = 0.06;
      g.add(band);
      const puff = new THREE.Mesh(new THREE.SphereGeometry(0.2, 14, 10), whiteMat);
      puff.scale.y = 0.9;
      puff.position.y = 0.22;
      g.add(puff);
    } else if (id === 'headphones') {
      // Headphones: an arc band over the head + two accented ear cups
      const bandMat = Materials.createToonMaterial(0x2c2c33);
      const cupMat = Materials.createToonMaterial(0x3a3a44);
      const accentMat = Materials.createToonMaterial(0xe84a5f);
      const band = new THREE.Mesh(new THREE.TorusGeometry(0.2, 0.022, 8, 20, Math.PI), bandMat);
      band.position.y = -0.02;
      g.add(band);
      for (const sx of [-0.2, 0.2]) {
        const cup = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 0.06, 14), cupMat);
        cup.rotation.z = Math.PI / 2;
        cup.position.set(sx, -0.02, 0);
        g.add(cup);
        const ring = new THREE.Mesh(new THREE.TorusGeometry(0.055, 0.013, 6, 14), accentMat);
        ring.rotation.y = Math.PI / 2;
        ring.position.set(sx * 1.04, -0.02, 0);
        g.add(ring);
      }
    } else {
      // halo — floats just above the head, glowing
      const halo = new THREE.Mesh(
        new THREE.TorusGeometry(0.14, 0.025, 10, 22),
        new THREE.MeshStandardMaterial({
          color: 0xffe680,
          emissive: 0xffd700,
          emissiveIntensity: 1.2,
          metalness: 0.4,
          roughness: 0.2,
        }),
      );
      halo.rotation.x = Math.PI / 2;
      halo.position.y = 0.22;
      g.add(halo);
    }
    g.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) o.castShadow = true;
    });
    return g;
  }

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
    const fwd = faceDir
      .clone()
      .sub(up.clone().multiplyScalar(faceDir.dot(up)))
      .normalize();
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

  /** Read-and-clear the "entered the water this frame" edge (entry splash). */
  public consumeWaterEntry(): boolean {
    const v = this.justEnteredWater;
    this.justEnteredWater = false;
    return v;
  }

  /**
   * Prone swim pose + stroke cycle. Tilts the body face-down along the
   * surface and drives an alternating overhead arm pull with a flutter
   * kick. Runs with the GLTF mixer paused (bones posed directly) or on the
   * procedural pivots. dt advances the stroke clock; `moving` picks the
   * cadence (a gentle tread when holding station).
   */
  private applySwimPose(dt: number, moving: boolean): void {
    this.swimPhase += dt * (moving ? 7 : 3.2);
    const s = Math.sin(this.swimPhase);
    const s2 = Math.sin(this.swimPhase * 2);
    if (this.gltfModel) {
      if (!this.armLBone || !this.legLBone) {
        this.gltfModel.traverse((o) => {
          const b = o as THREE.Bone;
          if (!b.isBone) return;
          if (o.name === 'legL') this.legLBone = b;
          if (o.name === 'legR') this.legRBone = b;
          if (o.name === 'armL') this.armLBone = b;
          if (o.name === 'armR') this.armRBone = b;
        });
      }
      // Face-down along the water, rolling slightly with each stroke
      this.gltfModel.rotation.x = 1.15;
      this.gltfModel.rotation.z = s * 0.18;
      // Alternating overhead crawl
      if (this.armLBone) this.armLBone.rotation.x = -1.4 + s * 1.3;
      if (this.armRBone) this.armRBone.rotation.x = -1.4 - s * 1.3;
      // Small flutter kick
      if (this.legLBone) this.legLBone.rotation.x = s2 * 0.35;
      if (this.legRBone) this.legRBone.rotation.x = -s2 * 0.35;
    } else if (this.legPivots.length === 2 && this.armPivots.length === 2) {
      this.mesh.rotation.x = 1.15;
      this.armPivots[0].rotation.x = -1.4 + s * 1.3;
      this.armPivots[1].rotation.x = -1.4 - s * 1.3;
      this.legPivots[0].rotation.x = s2 * 0.35;
      this.legPivots[1].rotation.x = -s2 * 0.35;
    }
  }

  /**
   * Riding pose — distinct from walking and swimming. Jetski: seated,
   * leaning forward with knees up and hands on the bars. Boat: standing at
   * the helm, hands forward. Mixer stays paused; bones posed directly (or
   * the procedural pivots) with a gentle idle sway.
   */
  private applyRidePose(dt: number): void {
    this.rideBob += dt * 2.2;
    const sway = Math.sin(this.rideBob) * 0.05;
    const jetski = this.rideKind === 'jetski';
    const lean = jetski ? 0.32 : 0.06;
    const legX = jetski ? -1.15 : 0.0;
    const armX = jetski ? -0.95 : -0.5;
    if (this.gltfModel) {
      if (!this.armLBone || !this.legLBone) {
        this.gltfModel.traverse((o) => {
          const b = o as THREE.Bone;
          if (!b.isBone) return;
          if (o.name === 'legL') this.legLBone = b;
          if (o.name === 'legR') this.legRBone = b;
          if (o.name === 'armL') this.armLBone = b;
          if (o.name === 'armR') this.armRBone = b;
        });
      }
      this.gltfModel.rotation.set(lean, 0, sway);
      if (this.legLBone) this.legLBone.rotation.x = legX;
      if (this.legRBone) this.legRBone.rotation.x = legX;
      if (this.armLBone) this.armLBone.rotation.x = armX;
      if (this.armRBone) this.armRBone.rotation.x = armX;
    } else if (this.legPivots.length === 2 && this.armPivots.length === 2) {
      this.mesh.rotation.set(lean, 0, sway);
      this.legPivots[0].rotation.x = legX;
      this.legPivots[1].rotation.x = legX;
      this.armPivots[0].rotation.x = armX;
      this.armPivots[1].rotation.x = armX;
    }
  }

  /** Undo the swim tilt when leaving the water (mixer resumes on land). */
  private clearSwimPose(): void {
    if (this.gltfModel) {
      this.gltfModel.rotation.x = 0;
      this.gltfModel.rotation.z = 0;
    } else {
      this.mesh.rotation.x = 0;
      this.mesh.rotation.z = 0;
    }
  }

  /** Cache the four limb bones once (used by the air pose + wave). */
  private ensureLimbBones(): void {
    if (!this.gltfModel) return;
    if (this.armLBone && this.armRBone && this.legLBone && this.legRBone) return;
    this.gltfModel.traverse((o) => {
      const b = o as THREE.Bone;
      if (!b.isBone) return;
      if (o.name === 'legL') this.legLBone = b;
      else if (o.name === 'legR') this.legRBone = b;
      else if (o.name === 'armL') this.armLBone = b;
      else if (o.name === 'armR') this.armRBone = b;
    });
  }

  /** Start the ~1.2s arm-raise wave gesture (triggered by the local Q wave). */
  public triggerWave(): void {
    this.waveTime = SimplePlayer.WAVE_DURATION;
  }

  /**
   * Jump/air pose + arm-wave, applied on top of the mixer output (which has
   * already written these bones this frame). Air: arms up + knees tucked,
   * eased in while airborne and back on land. Wave: the right arm raises and
   * wags for ~1.2s, overriding the air pose on that arm. On-foot only —
   * update() returns earlier for swim/ride/seat, so isGrounded is the gate.
   */
  private applyAirWavePose(dt: number): void {
    const k = Math.min(1, 10 * dt);
    this.airPoseWeight += ((this.isGrounded ? 0 : 1) - this.airPoseWeight) * k;
    const aw = this.airPoseWeight;
    let waveEnv = 0;
    let waveElapsed = 0;
    if (this.waveTime > 0) {
      this.waveTime = Math.max(0, this.waveTime - dt);
      waveElapsed = SimplePlayer.WAVE_DURATION - this.waveTime;
      waveEnv = Math.min(Math.min(1, waveElapsed / 0.15), Math.min(1, this.waveTime / 0.25));
    }
    const wag = Math.sin(waveElapsed * 14) * 0.4;
    if (this.gltfModel) {
      this.ensureLimbBones();
      if (aw > 0.001) {
        if (this.armLBone) this.armLBone.rotation.x += -0.85 * aw;
        if (this.armRBone) this.armRBone.rotation.x += -0.85 * aw;
        if (this.legLBone) this.legLBone.rotation.x += -0.45 * aw;
        if (this.legRBone) this.legRBone.rotation.x += -0.45 * aw;
      }
      if (waveEnv > 0 && this.armRBone) {
        this.armRBone.rotation.x = THREE.MathUtils.lerp(this.armRBone.rotation.x, -2.6, waveEnv);
        this.armRBone.rotation.z = wag * waveEnv;
      }
    } else if (this.armPivots.length === 2 && this.legPivots.length === 2) {
      if (aw > 0.001) {
        this.armPivots[0].rotation.x += -0.85 * aw;
        this.armPivots[1].rotation.x += -0.85 * aw;
        this.legPivots[0].rotation.x += -0.45 * aw;
        this.legPivots[1].rotation.x += -0.45 * aw;
      }
      if (waveEnv > 0) {
        const arm = this.armPivots[1]; // right shoulder pivot
        arm.rotation.x = THREE.MathUtils.lerp(arm.rotation.x, -2.6, waveEnv);
        // Blend back to the rest splay (-0.12) as the wave eases out.
        arm.rotation.z = wag * waveEnv + -0.12 * (1 - waveEnv);
      }
    }
  }

  /**
   * Normalised walk-cycle phase (0..1 across one full gait cycle) so footstep
   * code can fire on the two mid-stride plants (~0.25 and ~0.75) instead of a
   * distance accumulator that drifts as speed varies. Tracks the walk clip's
   * (speed-scaled) time, or the procedural walk phase in the fallback body.
   */
  /**
   * Drive the idle/walk blend and the mixer from an EXTERNAL ground speed.
   *
   * Indoors, GameScene early-returns before `update()` runs, so the mixer was
   * never ticked and the avatar slid around the room in a frozen T-pose-ish
   * idle — the legs simply did not move. This mirrors the blend in `update()`
   * but takes speed as an argument, because `this.velocity` is zero in the
   * room: the interior loop writes position directly and never touches the
   * spherical physics. Deliberately does NOT run the air/wave pose, which
   * writes these same bones after the mixer and assumes a grounded/airborne
   * state that does not exist indoors.
   */
  public tickInteriorAnimation(deltaTime: number, speed: number): void {
    const dt = Math.min(Math.max(deltaTime, 0), 0.1);
    if (this.walkAction && this.idleAction) {
      const target = speed > 0.4 ? 1 : 0;
      const w = THREE.MathUtils.lerp(
        this.walkAction.getEffectiveWeight(),
        target,
        Math.min(1, 10 * dt),
      );
      this.walkAction.setEffectiveWeight(w);
      this.idleAction.setEffectiveWeight(1 - w);
      this.walkAction.timeScale = THREE.MathUtils.clamp(
        speed / SimplePlayer.WALK_REF_SPEED,
        0.6,
        2.1,
      );
    }
    this.animationMixer?.update(dt);
  }

  public getWalkCyclePhase(): number {
    if (this.walkAction) {
      const dur = this.walkAction.getClip().duration || 1;
      return (((this.walkAction.time % dur) + dur) % dur) / dur;
    }
    const twoPi = Math.PI * 2;
    return (((this.walkPhase % twoPi) + twoPi) % twoPi) / twoPi;
  }

  /**
   * Recolour a rigged body by material name (peers apply the owner's chosen
   * colours here). Shares the local player's material-name mapping; also
   * recolours the added `hair_cap` mesh. Static so Multiplayer can call it on a
   * remote avatar whose materials were cloned per-peer.
   */
  public static applyBodyColors(
    root: THREE.Object3D,
    cols: Partial<Record<BodyPart, number>>,
  ): void {
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh && !(mesh as THREE.SkinnedMesh).isSkinnedMesh) return;
      if (mesh.name === 'hair_cap') {
        if (typeof cols.hair === 'number') {
          (mesh.material as THREE.MeshStandardMaterial)?.color?.setHex(cols.hair);
        }
        return;
      }
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const m of mats) {
        const sm = m as THREE.MeshStandardMaterial;
        if (!sm || !sm.name || !sm.color) continue;
        for (const key of Object.keys(cols) as BodyPart[]) {
          const hex = cols[key];
          if (typeof hex === 'number' && sm.name === PART_MATERIAL[key]) sm.color.setHex(hex);
        }
      }
    });
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
    return this.getSurfaceNormalInto(new THREE.Vector3());
  }

  /** Allocation-free surface normal into a caller-owned vector (hot paths). */
  private getSurfaceNormalInto(out: THREE.Vector3): THREE.Vector3 {
    if (this.planetRadius <= 0) return out.set(0, 1, 0);
    out.copy(this.playerPosition).sub(this.planetCenter);
    const len = out.length();
    if (len < 0.001) return out.set(0, 1, 0);
    return out.divideScalar(len);
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
        // v2 model is natively 1.8u; scaled to ~1.58u so the world reads
        // bigger around the player (feet re-calibrate below, so the scaled
        // model still lands exactly on the physics floor).
        scale: 0.88,
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
            this.animationMixer = setupModelAnimation(
              gltfResult.scene,
              gltfResult.animations,
              'idle',
            );
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

        // Apply a hat equipped before the model finished loading
        if (this.pendingHatId) {
          const hatId = this.pendingHatId;
          this.pendingHatId = null;
          this.equipHat(hatId);
        }
        // Re-apply any body colours chosen before the model swapped in
        this.reapplyAppearance();

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

    // Riding a boat/jetski: GameScene owns the transform (position + yaw set
    // in updateVehicles, right after this). Hold a dedicated riding pose —
    // NOT the walk/idle mixer or the swim pose — and skip all physics.
    if (this.rideActive) {
      this.applyRidePose(Math.min(deltaTime, 0.05));
      return;
    }

    // Substep instead of truncating: the old hard clamp to 20ms silently
    // DROPPED wall time below 50fps — the player ran in slow motion (8.0 →
    // 4.8u/s at 30fps) while NPCs and vehicles, which integrate the raw dt,
    // kept true speed. Recursing on the remainder in ≤20ms slices preserves
    // every millisecond (max 3 slices at the renderer's 50ms cap), and the
    // animation/pose code inside each slice sums to the same total time.
    if (deltaTime > 0.021) {
      this.update(0.02);
      this.update(deltaTime - 0.02);
      return;
    }
    const safeDeltaTime = Math.max(0, Math.min(deltaTime, 0.02));

    // Ease heading onto targetYaw (shortest arc, ~12 rad/s exponential) so
    // direction reversals sweep around instead of teleport-flipping 180°.
    // Scalar yaw only — the up-vector alignment in updateWorldMatrix is
    // untouched, so this smooths purely in the tangent frame.
    {
      const dYaw = this.targetYaw - this.yaw;
      const arc = Math.atan2(Math.sin(dYaw), Math.cos(dYaw)); // wrap to ±π
      const step = arc * (1 - Math.exp(-12 * safeDeltaTime));
      this.yaw += step;
      this.yawVel = step / safeDeltaTime;
    }

    // Apply gravity (spherical toward planet center, or flat -Y).
    // Descent is weighted 1.6× — a symmetric parabola reads as moon gravity
    // on the way down; the apex (jumpForce²/2g = 1.28u) is unchanged, only
    // the fall shortens (0.32s → 0.25s) for a snappier landing.
    if (this.planetRadius > 0) {
      const gravDir = this.planetCenter.clone().sub(this.playerPosition).normalize();
      const falling = !this.isGrounded && !this.inWater && this.velocity.dot(gravDir) > 0;
      this.velocity.addScaledVector(
        gravDir,
        this.gravityStrength * (falling ? 1.6 : 1) * safeDeltaTime,
      );
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

    // Water: float when swimming, sink + drown otherwise (overrides the
    // seafloor grounding above so you don't just walk along the bottom)
    this.updateWaterState(safeDeltaTime);

    // Handle jump — impulse along the surface normal, not world +Y.
    // (World-Y only points "up" at the sphere's north pole; anywhere else
    // it is partly tangential and grounding instantly re-sticks the player.)
    if (this.wantJump && this.isGrounded && !this.inWater) {
      const jumpNormal = this.getSurfaceNormal();
      this.velocity.addScaledVector(jumpNormal, this.jumpForce);
      this.isGrounded = false;
      this.wantJump = false;
    } else if (this.inWater) {
      this.wantJump = false; // no jumping out of the sea
    }

    // ── In water: swim pose overrides the walk/idle animation ───────────
    if (this.inWater) {
      const surfN = this.getSurfaceNormalInto(this._normalScratch);
      const tang = this._vecScratch
        .copy(this.velocity)
        .addScaledVector(surfN, -this.velocity.dot(surfN))
        .length();
      this.applySwimPose(safeDeltaTime, this.swimming && tang > 0.4);
      this.swimPoseActive = true;
      this.updateWorldMatrix();
      return;
    }
    if (this.swimPoseActive) {
      // Just climbed out: drop the tilt and neutralise the posed bones so
      // the mixer resumes cleanly.
      this.clearSwimPose();
      this.swimPoseActive = false;
      this.leanRoll = 0;
      this.airPoseWeight = 0;
      for (const b of [this.armLBone, this.armRBone, this.legLBone, this.legRBone]) {
        if (b) b.rotation.x = 0;
      }
    }

    // Procedural walk cycle for the built-in model: swing limbs from their
    // hip/shoulder pivots and bounce the body, scaled by tangential speed.
    if (!this.gltfModel && this.legPivots.length === 2 && this.armPivots.length === 2) {
      const surfNormal = this.getSurfaceNormalInto(this._normalScratch);
      const tangential = this._vecScratch
        .copy(this.velocity)
        .addScaledVector(surfNormal, -this.velocity.dot(surfNormal))
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
        const ssNormal = this.getSurfaceNormalInto(this._normalScratch);
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

    // Roll into turns while on foot on the ground: proportional to turn
    // rate, clamped subtle, eased. Negative z leans toward the model's +X
    // (its right), matching a positive-yaw (rightward) turn. Swim/ride
    // return above and own the model rotation; leanRoll is re-zeroed on
    // those state exits so the lean always eases back in from neutral.
    {
      const activeModel: THREE.Object3D = this.gltfModel ?? this.mesh;
      const leanTarget = this.isGrounded ? Math.max(-0.12, Math.min(0.12, -this.yawVel * 0.08)) : 0;
      this.leanRoll += (leanTarget - this.leanRoll) * Math.min(1, 10 * safeDeltaTime);
      activeModel.rotation.z = this.leanRoll;
    }

    // Blend idle/walk by tangential speed. Weights are set directly every
    // frame (no fadeIn/fadeOut scheduling — interleaved fades can strand both
    // actions at weight 0 when the speed oscillates around the threshold).
    if (this.idleAction && this.walkAction) {
      const normal = this.getSurfaceNormalInto(this._normalScratch);
      const spd = this._vecScratch
        .copy(this.velocity)
        .addScaledVector(normal, -this.velocity.dot(normal))
        .length();
      const target = spd > 0.8 ? 1 : 0;
      const k = Math.min(1, 10 * safeDeltaTime);
      const w = THREE.MathUtils.lerp(this.walkAction.getEffectiveWeight(), target, k);
      this.walkAction.setEffectiveWeight(w);
      this.idleAction.setEffectiveWeight(1 - w);
      // Cadence follows ground speed so slow walks don't moonwalk / runs slide.
      this.walkAction.timeScale = THREE.MathUtils.clamp(
        spd / SimplePlayer.WALK_REF_SPEED,
        0.6,
        2.1,
      ); // ceiling raised 1.6→2.1 for the R50 run speed 8.0 (ratio 1.9) so the feet don't slide at a full run
    }

    // Update GLTF animations
    if (this.animationMixer) {
      this.animationMixer.update(safeDeltaTime);
    }

    // Jump/air pose + arm-wave: applied AFTER the mixer (the clip writes these
    // same bones every frame). Reached only on foot — swim/ride/seat return
    // earlier — so isGrounded gates the air pose.
    this.applyAirWavePose(safeDeltaTime);

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
   * Water physics. Runs after grounding: on open water it overrides the
   * seafloor stick so the player floats (swim button held) or sinks and
   * drowns (button released). On land it just tops the breath back up.
   */
  private updateWaterState(dt: number): void {
    this.inWater = false;
    this.swimming = false;
    this.beyondSwimLimit = false;
    if (this.planetRadius <= 0 || !this.waterSampler) {
      this.oxygen = Math.min(1, this.oxygen + dt * SimplePlayer.RECOVER_RATE);
      return;
    }
    const toPlayer = this.playerPosition.clone().sub(this.planetCenter);
    const dist = toPlayer.length();
    const dir = toPlayer.divideScalar(dist);
    let water: { surface: number; isWater: boolean };
    try {
      water = this.waterSampler(dir);
    } catch {
      return;
    }
    // Not over water (or already above the surface on land) → recover breath
    if (!water.isWater || dist > water.surface + 1.2) {
      this.oxygen = Math.min(1, this.oxygen + dt * SimplePlayer.RECOVER_RATE);
      this.wasInWater = false;
      return;
    }
    this.inWater = true;
    // Rising edge → let GameScene spawn an entry splash once
    if (!this.wasInWater) this.justEnteredWater = true;
    this.wasInWater = true;
    const floatDist = water.surface + SimplePlayer.SWIM_FLOAT;

    if (this.swimIntent) {
      // Afloat: ease the body to the wave surface, kill the radial velocity
      // so gravity can't drag it under, and refill the breath.
      this.swimming = true;
      this.isGrounded = false;
      const target = dir.clone().multiplyScalar(floatDist);
      this.playerPosition.lerp(target, Math.min(1, 9 * dt));
      const vRad = this.velocity.dot(dir);
      this.velocity.addScaledVector(dir, -vRad * 0.9);
      this.oxygen = Math.min(1, this.oxygen + dt * SimplePlayer.RECOVER_RATE);
      // Shoreline barrier — past the swim limit a current nudges you back toward
      // the island. It composes with your own strokes, so you can still swim
      // along the shore; you just can't make headway into the deep ocean.
      const overshoot = SimplePlayer.SWIM_LIMIT_Y - dir.y;
      if (overshoot > 0) {
        this.beyondSwimLimit = true;
        this._swimTangent
          .copy(SimplePlayer._poleUp)
          .addScaledVector(dir, -SimplePlayer._poleUp.dot(dir));
        if (this._swimTangent.lengthSq() > 1e-6) {
          this._swimTangent.normalize();
          const strength = Math.min(1, overshoot / 0.1);
          this.playerPosition.addScaledVector(this._swimTangent, 4.0 * strength * dt);
        }
      } else {
        this.beyondSwimLimit = false;
      }
    } else {
      // Drowning: let gravity pull the player under and drain the breath.
      // (updateGroundState will still catch them on the seafloor.)
      this.oxygen = Math.max(0, this.oxygen - dt * SimplePlayer.DROWN_RATE);
      if (this.oxygen <= 0 && this.onDrown) {
        this.onDrown();
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
      // Swimming caps at 55% of run speed: an 8u/s front crawl would be 4×
      // Olympic sprint pace and out-swim the boat. 4.4u/s is still heroic
      // but keeps the water traversal hierarchy (feet < boat < jetski).
      const target = moveDir.clone().multiplyScalar(this.speed * (this.swimming ? 0.55 : 1)); // moveDir already tangent-projected
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
   * Set player heading (yaw, radians about the surface normal). On foot the
   * yaw eases onto it (shortest arc) in update(); riding/seated snap because
   * GameScene owns the transform there and update() returns before easing.
   */
  public setRotation(yaw: number, _pitch?: number): void {
    this.targetYaw = yaw;
    if (this.rideActive || this.seated) this.yaw = yaw;
  }

  /**
   * Get player world position (allocates a fresh vector — kept for callers
   * that store the result; per-frame callers should use getWorldPositionInto).
   */
  public getWorldPosition(): THREE.Vector3 {
    return this.getWorldPositionInto(new THREE.Vector3());
  }

  /** Allocation-free world position into a caller-owned vector (hot paths). */
  public getWorldPositionInto(out: THREE.Vector3): THREE.Vector3 {
    return out.copy(this.positionHold ?? this.playerPosition);
  }

  // While set, getWorldPosition* report THIS instead of the live position —
  // used while the player walks around a building interior (the hidden room
  // sits 300u under the map) so multiplayer peers keep seeing them at the
  // door they entered, not floating beneath the planet.
  private positionHold: THREE.Vector3 | null = null;
  public setPositionHold(v: THREE.Vector3 | null): void {
    this.positionHold = v ? v.clone() : null;
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
      // Align player "up" with surface normal, then yaw around that normal.
      // Scratch quats/vector — this runs every frame.
      const surfaceNormal = this.getSurfaceNormalInto(this._normalScratch);
      const alignQuat = this._alignQuat.setFromUnitVectors(SimplePlayer._poleUp, surfaceNormal);
      const yawQuat = this._yawQuat.setFromAxisAngle(surfaceNormal, this.yaw);
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
