import * as THREE from 'three';
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js';

export type NPCState = 'Idle' | 'Walk';

export class NPC {
  public group: THREE.Object3D;
  private mixer: THREE.AnimationMixer | null = null;
  private animations: THREE.AnimationClip[] = [];
  private currentAction: THREE.AnimationAction | null = null;
  private state: NPCState = 'Idle';
  private basePosition: THREE.Vector3;
  private targetPosition: THREE.Vector3 | null = null;
  private walkTimer: number = 0;
  private idleTimer: number = 0;
  private islandCenter: THREE.Vector3;
  private islandRadius: number;

  private groundDist: ((dir: THREE.Vector3) => number) | null = null;

  constructor(
    model: THREE.Object3D,
    animations: THREE.AnimationClip[],
    position: THREE.Vector3,
    quaternion: THREE.Quaternion,
    scale: number,
    islandCenter: THREE.Vector3,
    islandRadius: number,
    groundDist?: (dir: THREE.Vector3) => number,
  ) {
    // npc.glb is RIGGED (armL/armR/legL/legR, per scripts/rig-npc.py), so it
    // must be skeleton-cloned: a plain Object3D.clone(true) copies the bone
    // nodes but leaves every villager bound to the SAME skeleton, so all of
    // them would swing in lockstep with whichever one moved last.
    this.group = cloneSkeleton(model);
    this.group.position.copy(position);
    this.group.quaternion.copy(quaternion);
    this.group.scale.setScalar(scale);
    this.group.traverse((object) => {
      if (object instanceof THREE.Mesh) {
        object.castShadow = true;
        object.receiveShadow = true;
        // Skinned bounds are computed in bind space, so a limb swung outside
        // the bind box makes the whole villager pop out of view.
        if ((object as THREE.SkinnedMesh).isSkinnedMesh) object.frustumCulled = false;
      }
    });

    this.animations = animations || [];
    if (this.animations.length) {
      try {
        this.mixer = new THREE.AnimationMixer(this.group);
        // prefer Idle or first clip
        let clip = this.animations.find((a) => /idle/i.test(a.name)) || this.animations[0];
        if (clip) {
          this.currentAction = this.mixer.clipAction(clip);
          this.currentAction.reset();
          this.currentAction.play();
        }
      } catch {
        this.mixer = null;
      }
    }

    this.basePosition = position.clone();
    this.islandCenter = islandCenter.clone();
    this.islandRadius = islandRadius;
    this.groundDist = groundDist ?? null;
    this.idleTimer = 1 + Math.random() * 4;
  }

  /** Distance from island center to the actual terrain along dir (feet offset included). */
  private surfaceRadiusAt(dir: THREE.Vector3): number {
    if (this.groundDist) {
      try {
        const d = this.groundDist(dir);
        if (Number.isFinite(d) && d > 0) return d + 0.03;
      } catch {
        /* fall through to ideal sphere */
      }
    }
    return this.islandRadius + 0.58;
  }

  public update(deltaTime: number) {
    // advance animations
    if (this.mixer) {
      try {
        this.mixer.update(deltaTime);
      } catch {
        /* ignore mixer update */
      }
    }

    // simple state machine: idle for a bit, then walk a short random arc, then idle
    if (this.state === 'Idle') {
      this.idleTimer -= deltaTime;
      // subtle bobbing while idle
      const bob =
        Math.sin(performance.now() * 0.002 + (this.basePosition.x + this.basePosition.z)) * 0.002;
      this.group.position.y = this.basePosition.y + bob;
      if (this.idleTimer <= 0) {
        // start a short walk
        this.startWalk();
      }
    } else if (this.state === 'Walk') {
      if (!this.targetPosition) {
        this.endWalk();
        return;
      }
      this.walkTimer -= deltaTime;
      // move toward target along straight line and project to surface
      // lerp position a bit each frame based on deltaTime
      const current = this.group.position.clone();
      const next = current.lerp(this.targetPosition, Math.min(1, deltaTime * 0.9));
      // ensure on surface radius
      const dir = next.clone().sub(this.islandCenter).normalize();
      const surfacePos = this.islandCenter
        .clone()
        .add(dir.clone().multiplyScalar(this.surfaceRadiusAt(dir)));
      this.group.position.copy(surfacePos);
      // orient to surface normal and forward direction
      try {
        const up = surfacePos.clone().sub(this.islandCenter).normalize();
        const forward = this.targetPosition
          .clone()
          .sub(this.group.position)
          .projectOnPlane(up)
          .normalize();
        if (forward.lengthSq() > 1e-6) {
          const right = new THREE.Vector3().crossVectors(up, forward).normalize();
          const mat = new THREE.Matrix4();
          mat.makeBasis(right, up, forward);
          const q = new THREE.Quaternion().setFromRotationMatrix(mat);
          this.group.quaternion.slerp(q, Math.min(1, deltaTime * 6.0));
        }
      } catch {
        /* ignore orientation update */
      }

      if (this.walkTimer <= 0) {
        this.endWalk();
      }
    }
  }

  // Start patrolling a sequence of surface positions (simple back-and-forth)
  public startPatrol(points: THREE.Vector3[]) {
    if (!points || !points.length) return;
    // use first two points for simple back-and-forth
    const p1 = points[0];
    const p2 = points.length > 1 ? points[1] : points[0];
    // set basePosition to first patrol point
    this.basePosition = p1.clone();
    // schedule a walk to the second point immediately
    this.targetPosition = p2.clone();
    this.state = 'Walk';
    this.walkTimer = 1.0 + Math.random() * 1.2;
  }

  private startWalk() {
    // choose a small random target on the nearby surface (short arc)
    const angle = Math.random() * Math.PI * 2;
    const dist = 0.6 + Math.random() * 1.2; // small step
    const baseDir = this.basePosition.clone().sub(this.islandCenter).normalize();
    // compute a tangent offset
    const right = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), baseDir).normalize();
    const offset = right.applyAxisAngle(baseDir, angle).multiplyScalar(dist);
    const candidate = this.basePosition.clone().add(offset);
    const dir = candidate.clone().sub(this.islandCenter).normalize();
    this.targetPosition = this.islandCenter
      .clone()
      .add(dir.clone().multiplyScalar(this.surfaceRadiusAt(dir)));
    this.state = 'Walk';
    this.walkTimer = 0.6 + Math.random() * 1.2;
    // play walk animation if available
    try {
      if (this.mixer && this.animations.length) {
        const clip = this.animations.find((a) => /walk|run/i.test(a.name)) || this.animations[0];
        if (clip) {
          this.currentAction?.fadeOut(0.2);
          this.currentAction = this.mixer.clipAction(clip);
          this.currentAction.reset().fadeIn(0.2).play();
        }
      }
    } catch {
      /* ignore animation state change */
    }
  }

  private endWalk() {
    this.state = 'Idle';
    this.targetPosition = null;
    this.idleTimer = 2 + Math.random() * 4;
    // restore base position exactly on surface
    const dir = this.basePosition.clone().sub(this.islandCenter).normalize();
    const surfacePos = this.islandCenter
      .clone()
      .add(dir.clone().multiplyScalar(this.surfaceRadiusAt(dir)));
    this.group.position.copy(surfacePos);
    // play idle animation
    try {
      if (this.mixer && this.animations.length) {
        const clip = this.animations.find((a) => /idle/i.test(a.name)) || this.animations[0];
        if (clip) {
          this.currentAction?.fadeOut(0.2);
          this.currentAction = this.mixer.clipAction(clip);
          this.currentAction.reset().fadeIn(0.2).play();
        }
      }
    } catch {
      /* ignore animation state change */
    }
  }
}
