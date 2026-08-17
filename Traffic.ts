import * as THREE from 'three';

import { EXTERIOR_LIGHTS_DAY_CUTOFF } from './EnvironmentCycle';

/**
 * Ring traffic — cars that actually drive the island, for TWO draw calls by
 * day and four at night.
 *
 * WHY RINGS. The island's two orbital roads are constant-latitude circles:
 * the boulevard at lat 0.4636 and the coastal road at 0.28 (Island's street
 * network builds both as closed loops). A closed one-way ring never makes a
 * decision, and the two rings never touch (they sit ~18u apart), so junction
 * arbitration — the thing that makes traffic hard on a sphere — is
 * structurally nonexistent here rather than merely unimplemented. A car is
 * one scalar: its longitude.
 *
 * WHY IT CANNOT BREAK THE WORLD. Every other placement system on the island
 * runs inside GameScene's seeded-random window, where three's generateUUID
 * spends four Math.random draws per object and any new allocation re-rolls
 * every later placement (multiplayer addresses the parked cars BY INDEX).
 * This system is constructed AFTER restoreRandom(), outside that window
 * entirely — the safest possible anchor, and the reason it needs no RNG
 * shield of its own.
 *
 * WHAT IT IS NOT. These cars are decoration and are never pushed into
 * GameScene.vehicles: they are not boardable and not networked. The eight
 * parked cars remain the only drivable, index-addressed fleet.
 */

/** A lane is a closed circle of constant latitude, walked in one direction. */
interface Lane {
  lat: number;
  /** +1 eastbound, -1 westbound — opposing rings read as two-way traffic. */
  dir: 1 | -1;
  speed: number;
  /** Cached terrain radius around the ring; the road is static, so this is
   *  sampled once and lerped forever after — no per-frame terrain query. */
  radii: Float32Array;
  /** Circle radius on the sphere: R*cos(lat). Converts metres to radians. */
  ringRadius: number;
}

interface TrafficCar {
  lane: number;
  lon: number;
  /** Eased 0..1 throttle so yielding looks like braking, not teleporting. */
  throttle: number;
}

const LUT = 128; // radius samples per ring (~4.6u apart on the boulevard)

export class TrafficSystem {
  private readonly lanes: Lane[] = [];
  private readonly cars: TrafficCar[] = [];
  private readonly bodies: THREE.InstancedMesh;
  private readonly wash: THREE.InstancedMesh;
  private readonly island: {
    dirAt(lon: number, lat: number): THREE.Vector3;
    analyticSurface(dir: THREE.Vector3): { radius: number };
    getRadius(): number;
  };

  // Per-frame scratch — this class allocates nothing after construction.
  private readonly _dir = new THREE.Vector3();
  private readonly _ahead = new THREE.Vector3();
  private readonly _pos = new THREE.Vector3();
  private readonly _tan = new THREE.Vector3();
  private readonly _up = new THREE.Vector3();
  private readonly _right = new THREE.Vector3();
  private readonly _m = new THREE.Matrix4();
  private readonly _q = new THREE.Quaternion();
  private readonly _s = new THREE.Vector3(1, 1, 1);
  private readonly _washScale = new THREE.Vector3(3.0, 7.0, 1);
  private readonly _flat = new THREE.Vector3(0, 0, 1);

  constructor(
    island: {
      dirAt(lon: number, lat: number): THREE.Vector3;
      analyticSurface(dir: THREE.Vector3): { radius: number };
      getRadius(): number;
    },
    parent: THREE.Object3D,
  ) {
    this.island = island;
    const R = island.getRadius();

    // Boulevard runs east, coastal runs west: opposing streams read as a
    // living town rather than a conveyor. Counts give ~94u and ~151u of
    // headway — sparse enough that a stopped car never jams the ring.
    const spec: Array<{ lat: number; dir: 1 | -1; speed: number; count: number }> = [
      { lat: 0.4636, dir: 1, speed: 7.0, count: 6 },
      { lat: 0.28, dir: -1, speed: 6.0, count: 4 },
    ];

    for (const s of spec) {
      const radii = new Float32Array(LUT);
      for (let i = 0; i < LUT; i++) {
        const d = island.dirAt((i / LUT) * Math.PI * 2, s.lat);
        radii[i] = island.analyticSurface(d).radius;
      }
      this.lanes.push({
        lat: s.lat,
        dir: s.dir,
        speed: s.speed,
        radii,
        ringRadius: R * Math.cos(s.lat),
      });
      const laneIdx = this.lanes.length - 1;
      for (let c = 0; c < s.count; c++) {
        this.cars.push({ lane: laneIdx, lon: (c / s.count) * Math.PI * 2, throttle: 1 });
      }
    }

    // ONE geometry, ONE material, every car — a merged vertex-coloured body.
    // instanceColor MULTIPLIES vertexColor in three, so the paintwork is
    // authored WHITE and tinted per instance, while the near-black glass and
    // wheels stay dark whatever the tint.
    this.bodies = new THREE.InstancedMesh(
      TrafficSystem.buildCarGeometry(),
      new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.1 }),
      this.cars.length,
    );
    this.bodies.name = 'traffic_cars';
    this.bodies.castShadow = true;
    this.bodies.frustumCulled = false; // the fleet wraps the planet
    const palette = [0xd94f4f, 0x4f7fd9, 0xe0c24a, 0x63b86a, 0xdedede, 0xc06fd0];
    for (let i = 0; i < this.cars.length; i++) {
      this.bodies.setColorAt(i, new THREE.Color(palette[i % palette.length]));
    }
    if (this.bodies.instanceColor) this.bodies.instanceColor.needsUpdate = true;
    parent.add(this.bodies);

    // Headlight WASH — the night-visibility payload. A moving pool of light
    // on exactly the stretches the static lamps cannot reach: a 7u wash at
    // 7 u/s sweeps a whole boulevard block every ~13s. Same recipe as the
    // lamp light pools (additive, no depth write, polygon-offset down), and
    // deliberately NOT a real light: MeshBasic never enters the fragment
    // light loop, so this costs nothing per lit fragment on the terrain.
    this.wash = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({
        map: TrafficSystem.buildWashTexture(),
        transparent: true,
        opacity: 0.55,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -3,
        polygonOffsetUnits: -3,
      }),
      this.cars.length,
    );
    this.wash.name = 'traffic_headlight_wash';
    this.wash.renderOrder = 2;
    this.wash.frustumCulled = false;
    (this.wash.userData as Record<string, unknown>).ignoreOcclusion = true;
    parent.add(this.wash);

    this.update(0, 1, null, null); // seat everything before the first frame
  }

  /** Terrain radius under a longitude, lerped from the cached ring. */
  private radiusAt(lane: Lane, lon: number): number {
    const f = (((lon / (Math.PI * 2)) % 1) + 1) % 1;
    const x = f * LUT;
    const i = Math.floor(x);
    const t = x - i;
    const a = lane.radii[i % LUT];
    const b = lane.radii[(i + 1) % LUT];
    return a + (b - a) * t;
  }

  /**
   * Advance the fleet.
   *
   * `npcs` and `playerPos` drive the yield: ten cars against ~28 villagers is
   * 280 squared-distance tests a frame (~0.01ms), and without it the fleet
   * drives straight through the townsfolk — the most visible bug traffic
   * could ship. Cars ease their throttle down rather than snapping to a
   * stop, so a yield reads as braking.
   */
  public update(
    dt: number,
    dayFactor: number,
    npcs: ReadonlyArray<{ position: THREE.Vector3 }> | null,
    playerPos: THREE.Vector3 | null,
  ): void {
    const lit = dayFactor < EXTERIOR_LIGHTS_DAY_CUTOFF;
    // Off the render list entirely by day — same shared cutoff as every
    // other exterior light, so the day/night flip stays one event.
    this.wash.visible = lit;

    for (let c = 0; c < this.cars.length; c++) {
      const car = this.cars[c];
      const lane = this.lanes[car.lane];

      // Where the car is, and where its bonnet points.
      const dir = this.island.dirAt(car.lon, lane.lat);
      this._dir.copy(dir);
      const r = this.radiusAt(lane, car.lon);
      this._pos.copy(this._dir).multiplyScalar(r + 0.35);

      // WORLD LAW 1: a car stands PLUMB on the radial, never on the terrain
      // normal — the parked fleet already learned this (a slope-normal car
      // reads as crashed). Forward is the ring tangent projected onto the
      // tangent plane, so the body never pitches into the hill.
      this._up.copy(this._dir);
      const aheadLon = car.lon + lane.dir * 0.01;
      this._ahead.copy(this.island.dirAt(aheadLon, lane.lat));
      this._tan.subVectors(this._ahead, this._dir);
      this._tan.addScaledVector(this._up, -this._tan.dot(this._up)).normalize();

      // Yield: brake for anything close AHEAD of us, not merely near us.
      let want = 1;
      const brakeAt = 6.5;
      if (npcs) {
        for (let i = 0; i < npcs.length; i++) {
          const p = npcs[i].position;
          const dx = p.x - this._pos.x;
          const dy = p.y - this._pos.y;
          const dz = p.z - this._pos.z;
          const d2 = dx * dx + dy * dy + dz * dz;
          if (d2 > brakeAt * brakeAt) continue;
          if (dx * this._tan.x + dy * this._tan.y + dz * this._tan.z <= 0) continue; // behind
          want = 0;
          break;
        }
      }
      if (want > 0 && playerPos) {
        const dx = playerPos.x - this._pos.x;
        const dy = playerPos.y - this._pos.y;
        const dz = playerPos.z - this._pos.z;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < brakeAt * brakeAt && dx * this._tan.x + dy * this._tan.y + dz * this._tan.z > 0) {
          want = 0;
        }
      }
      // Ease: brisk on the brakes, gentle on the throttle.
      const k = want < car.throttle ? 6 : 1.6;
      car.throttle += (want - car.throttle) * Math.min(1, k * dt);

      // Metres → radians of longitude around a circle of radius R*cos(lat).
      if (dt > 0) {
        car.lon += (lane.dir * lane.speed * car.throttle * dt) / Math.max(1e-3, lane.ringRadius);
        if (car.lon > Math.PI * 2) car.lon -= Math.PI * 2;
        else if (car.lon < 0) car.lon += Math.PI * 2;
      }

      // Body transform: +Y radial, +Z along travel.
      this._right.crossVectors(this._up, this._tan).normalize();
      this._m.makeBasis(this._right, this._up, this._tan);
      this._q.setFromRotationMatrix(this._m);
      this.bodies.setMatrixAt(c, this._m.compose(this._pos, this._q, this._s));

      // Wash: a pool on the road ahead, flat to the ground.
      if (lit) {
        this._ahead
          .copy(this._dir)
          .addScaledVector(this._tan, 4.0 / Math.max(1e-3, r))
          .normalize();
        const wr = this.radiusAt(lane, Math.atan2(this._ahead.z, this._ahead.x));
        this._pos.copy(this._ahead).multiplyScalar(wr + 0.05);
        this._q.setFromUnitVectors(this._flat, this._ahead);
        // Roll the quad so its long axis lies along the road.
        this._m.compose(this._pos, this._q, this._washScale);
        this.wash.setMatrixAt(c, this._m);
      }
    }
    this.bodies.instanceMatrix.needsUpdate = true;
    if (lit) this.wash.instanceMatrix.needsUpdate = true;
  }

  /** Merged, vertex-coloured toy car — one geometry for the whole fleet. */
  private static buildCarGeometry(): THREE.BufferGeometry {
    const parts: THREE.BufferGeometry[] = [];
    const push = (geo: THREE.BufferGeometry, hex: number, pos: [number, number, number]): void => {
      geo.translate(pos[0], pos[1], pos[2]);
      const g = geo.toNonIndexed();
      geo.dispose();
      const n = g.attributes.position.count;
      const col = new Float32Array(n * 3);
      const c = new THREE.Color(hex);
      for (let i = 0; i < n; i++) {
        col[i * 3] = c.r;
        col[i * 3 + 1] = c.g;
        col[i * 3 + 2] = c.b;
      }
      g.setAttribute('color', new THREE.BufferAttribute(col, 3));
      g.deleteAttribute('uv');
      parts.push(g);
    };
    // WHITE paint: instanceColor multiplies, so white = "take the tint".
    push(new THREE.BoxGeometry(1.5, 0.5, 3.1), 0xffffff, [0, 0.42, 0]);
    push(new THREE.BoxGeometry(1.25, 0.45, 1.5), 0xffffff, [0, 0.86, -0.15]);
    push(new THREE.BoxGeometry(1.28, 0.3, 0.06), 0x2a3038, [0, 0.86, 0.62]); // windscreen
    for (const [x, z] of [
      [-0.78, 1.02],
      [0.78, 1.02],
      [-0.78, -1.02],
      [0.78, -1.02],
    ] as const) {
      // A CylinderGeometry stands on +Y; a wheel's axle runs across the car,
      // so rotate it onto X BEFORE the translate bakes its position in.
      const w = new THREE.CylinderGeometry(0.32, 0.32, 0.24, 8);
      w.rotateZ(Math.PI / 2);
      push(w, 0x1c1c20, [x, 0.3, z]);
    }
    return mergeSimple(parts);
  }

  /** 64px radial gradient — the same warm pool the street lamps cast. */
  private static buildWashTexture(): THREE.CanvasTexture {
    const size = 64;
    const cv = document.createElement('canvas');
    cv.width = cv.height = size;
    const ctx = cv.getContext('2d');
    if (ctx) {
      const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
      g.addColorStop(0, 'rgba(255,246,214,0.9)');
      g.addColorStop(0.5, 'rgba(255,232,170,0.35)');
      g.addColorStop(1, 'rgba(255,220,140,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, size, size);
    }
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  public dispose(): void {
    this.bodies.geometry.dispose();
    (this.bodies.material as THREE.Material).dispose();
    this.bodies.dispose();
    this.wash.geometry.dispose();
    const wm = this.wash.material as THREE.MeshBasicMaterial;
    wm.map?.dispose();
    wm.dispose();
    this.wash.dispose();
    this.bodies.removeFromParent();
    this.wash.removeFromParent();
  }
}

/** Concat position+normal+color attributes — all parts are non-indexed. */
function mergeSimple(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  let total = 0;
  for (const p of parts) total += p.attributes.position.count;
  const pos = new Float32Array(total * 3);
  const nrm = new Float32Array(total * 3);
  const col = new Float32Array(total * 3);
  let o = 0;
  for (const p of parts) {
    const pa = p.attributes.position.array as ArrayLike<number>;
    const na = p.attributes.normal.array as ArrayLike<number>;
    const ca = p.attributes.color.array as ArrayLike<number>;
    const n = p.attributes.position.count;
    for (let i = 0; i < n * 3; i++) {
      pos[o * 3 + i] = pa[i];
      nrm[o * 3 + i] = na[i];
      col[o * 3 + i] = ca[i];
    }
    o += n;
    p.dispose();
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}
