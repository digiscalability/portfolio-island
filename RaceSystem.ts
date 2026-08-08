import * as THREE from 'three';

import { a11y } from './Accessibility';
import type { Island } from './Island';

/**
 * RaceSystem — checkpoint time-trials that give the vehicles a purpose.
 *
 * Two circuits, each a ring of gates around the planet:
 *   • land  — for cars, high on the north cap (a circle of latitude on land)
 *   • water — for boats/jetskis, offshore (a circle of latitude on the sea)
 *
 * Gate 0 is the start/finish line. Board the matching vehicle, drive through
 * the glowing start ring to arm the clock, hit every checkpoint in order, then
 * cross the start line again to bank the lap. Best times persist in
 * localStorage. Gates float faintly always (discoverable on foot) and light up
 * when you're in a vehicle that can run that circuit.
 *
 * All geometry is spherical: a checkpoint is a unit surface direction, capture
 * is a single dot-product test (dir·gate ≥ cos(captureRadius / R)), and each
 * gate is oriented with makeBasis so its hole-axis points along the direction
 * of travel — you drive *through* it, not past it.
 */

export type RidingKind = 'boat' | 'jetski' | 'car' | null;
type CircuitKind = 'land' | 'water';

export interface RaceHudStatus {
  line1: string;
  line2?: string;
}
export interface RaceEvent {
  kind: 'start' | 'checkpoint' | 'finish' | 'abort';
  text: string;
  timeSec?: number; // finish: numeric lap time (for the leaderboard)
  circuit?: CircuitKind; // finish: which circuit
  improved?: boolean; // finish: was this a new personal best
}

interface Circuit {
  kind: CircuitKind;
  dirs: THREE.Vector3[]; // unit surface directions, [0] is start/finish
  surfaceR: number[]; // cached surface radius per gate (terrain is static)
  gates: THREE.Group[];
  rings: THREE.Mesh[]; // the torus per gate (for cheap per-frame recolour)
}

const CAPTURE_WORLD = 1.7; // world-space capture radius around a gate centre
const RING_RADIUS = 1.15;
const RING_TUBE = 0.13;
const GATE_CLEARANCE = 1.4; // keep gate centres this far off a structure footprint

export class RaceSystem {
  private scene: THREE.Scene;
  private island: Island;
  private circuits: Partial<Record<CircuitKind, Circuit>> = {};
  // Big structures (houses/buildings/stalls/fountain) to steer land gates clear of
  private obstacles: Array<{ position: THREE.Vector3; radius: number }> = [];

  public onEvent?: (e: RaceEvent) => void;
  public onHud?: (s: RaceHudStatus | null) => void;

  // Live race state (only one circuit active at a time)
  private state: 'idle' | 'running' = 'idle';
  private active: CircuitKind | null = null;
  private nextIdx = 0; // index of the next gate to hit (0 == "return to start")
  private startT = 0;
  private mustLeaveStart = false; // block re-arm until we exit the start gate
  private lastDir = new THREE.Vector3();
  private pulse = 0;
  private best: Record<CircuitKind, number | null> = { land: null, water: null };
  /** ?race=&beat= challenge target — woven into the HUD lines while set. */
  private challenge: { kind: CircuitKind; ms: number } | null = null;
  public setChallenge(kind: CircuitKind, ms: number | null): void {
    this.challenge = ms != null ? { kind, ms } : null;
  }

  // scratch
  private _dir = new THREE.Vector3();
  private _x = new THREE.Vector3();
  private _y = new THREE.Vector3();
  private _z = new THREE.Vector3();
  private _m = new THREE.Matrix4();

  constructor(
    scene: THREE.Scene,
    island: Island,
    obstacles: Array<{ position: THREE.Vector3; radius: number }> = [],
  ) {
    this.scene = scene;
    this.island = island;
    // LIVE reference (not a filtered snapshot): GameScene keeps pushing
    // colliders after construction (zone buildings, quest mailboxes, async
    // GLB props) — snapshotting here made gates blind to all of them. The
    // size filter moved into obstacleClearance.
    this.obstacles = obstacles;
    this.best.land = this.loadBest('land');
    this.best.water = this.loadBest('water');
  }

  /** Build both circuits + their gate meshes and add them to the scene. */
  public build(): void {
    // Land ring sits on the open grass between town and beach, phase-shifted so
    // gate 0 doesn't land on the town centre; gates nudge clear of buildings.
    this.circuits.land = this.buildCircuit('land', 5, 0.38, false, 0.6);
    this.circuits.water = this.buildCircuit('water', 6, 0.12, true, 0);
    // Everything starts dim (on foot)
    this.paintCircuit('land');
    this.paintCircuit('water');
  }

  /**
   * World position of a circuit's start/finish gate, for "guide me to the
   * race" CTAs (the compass needs somewhere to point). Null before build().
   */
  public getStartPosition(kind: CircuitKind): THREE.Vector3 | null {
    const c = this.circuits[kind];
    if (!c || c.dirs.length === 0) return null;
    return c.dirs[0].clone().multiplyScalar(c.surfaceR[0]);
  }

  private buildCircuit(
    kind: CircuitKind,
    count: number,
    latTarget: number,
    wantWater: boolean,
    phase: number,
  ): Circuit {
    const dirs: THREE.Vector3[] = [];
    const surfaceR: number[] = [];
    for (let k = 0; k < count; k++) {
      const lon = (Math.PI * 2 * k) / count + phase;
      const dir = this.findValidDir(lon, latTarget, wantWater);
      dirs.push(dir);
      surfaceR.push(this.surfaceRadiusFor(dir, wantWater));
    }

    const gates: THREE.Group[] = [];
    const rings: THREE.Mesh[] = [];
    const ringGeo = new THREE.TorusGeometry(RING_RADIUS, RING_TUBE, 10, 28);
    for (let k = 0; k < count; k++) {
      const g = new THREE.Group();
      g.name = `race_gate_${kind}_${k}`;
      const mat = new THREE.MeshStandardMaterial({
        color: 0x0a0a0a,
        emissive: 0x2266aa,
        emissiveIntensity: 0.4,
        metalness: 0.2,
        roughness: 0.5,
        transparent: true,
        opacity: 0.9,
      });
      const ring = new THREE.Mesh(ringGeo, mat);
      g.add(ring);
      // A slim post so the ring reads as a gate on the ground/water
      const postMat = new THREE.MeshStandardMaterial({ color: 0x223344, roughness: 0.7 });
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.08, RING_RADIUS, 6), postMat);
      post.position.y = -RING_RADIUS * 0.5;
      g.add(post);

      this.placeGate(g, dirs[k], dirs[(k + 1) % count], dirs[(k - 1 + count) % count], surfaceR[k]);
      this.scene.add(g);
      gates.push(g);
      rings.push(ring);
    }
    return { kind, dirs, surfaceR, gates, rings };
  }

  /**
   * Orient + seat a gate: hole-axis (local Z) points along the travel tangent,
   * up (local Y) is the surface normal, so you drive through the ring. Centre is
   * lifted by ~RING_RADIUS so the ring spans the vehicle height.
   */
  private placeGate(
    g: THREE.Group,
    dir: THREE.Vector3,
    nextDir: THREE.Vector3,
    prevDir: THREE.Vector3,
    surfaceR: number,
  ): void {
    // Travel tangent along the circuit, projected to be perpendicular to `dir`.
    this._z.copy(nextDir).sub(prevDir);
    this._z.addScaledVector(dir, -this._z.dot(dir)).normalize();
    if (this._z.lengthSq() < 1e-6) {
      // Degenerate — fall back to an arbitrary tangent
      this._z.set(0, 1, 0).addScaledVector(dir, -dir.y).normalize();
    }
    this._y.copy(dir); // surface up
    this._x.crossVectors(this._y, this._z).normalize();
    this._z.crossVectors(this._x, this._y).normalize(); // re-orthogonalise
    this._m.makeBasis(this._x, this._y, this._z);
    g.quaternion.setFromRotationMatrix(this._m);
    g.position.copy(dir).multiplyScalar(surfaceR + RING_RADIUS * 0.82);
  }

  private surfaceRadiusFor(dir: THREE.Vector3, wantWater: boolean): number {
    if (wantWater) return this.island.seaLevel();
    return this.island.sampleSurfaceByDirection(dir, 0).position.length();
  }

  /**
   * Find a surface direction near (lon, latTarget) whose land/water matches
   * `wantWater`, searching latitude outward in both directions. Returns the
   * first fully-clear, flat land spot; if the whole column is congested, falls
   * back to the *clearest* land candidate rather than clipping a structure.
   */
  private findValidDir(lon: number, latTarget: number, wantWater: boolean): THREE.Vector3 {
    let best: THREE.Vector3 | null = null;
    let bestClearance = -Infinity;
    for (let step = 0; step <= 24; step++) {
      for (const s of step === 0 ? [0] : [step, -step]) {
        const lat = latTarget + s * 0.02;
        if (lat <= 0.02 || lat >= 1.4) continue;
        const d = this.island.dirAt(lon, lat);
        if (this.island.isOverWater(d) !== wantWater) continue;
        if (wantWater) return d;
        // Never park a land gate ON a road — the lat slide was street-blind
        // and could seat a gate + posts mid-pavement.
        if (this.island.isNearStreet(d)) continue;
        // Land: prefer reasonably flat ground (normal roughly radial).
        const sample = this.island.sampleSurfaceByDirection(d, 0);
        if (sample.normal.dot(d) <= 0.72) continue;
        const clearance = this.obstacleClearance(sample.position);
        if (clearance >= GATE_CLEARANCE) return d; // fully clear — take it
        if (clearance > bestClearance) {
          bestClearance = clearance;
          best = d;
        }
      }
    }
    return best ?? this.island.dirAt(lon, latTarget);
  }

  /** Signed margin from the nearest structure footprint (negative = inside).
   *  Only the sizeable footprints matter — lamps/mailboxes are pass-through. */
  private obstacleClearance(pos: THREE.Vector3): number {
    let margin = Infinity;
    for (const o of this.obstacles) {
      if (o.radius < 1.2) continue;
      margin = Math.min(margin, pos.distanceTo(o.position) - o.radius);
    }
    return margin;
  }

  // ---- runtime ------------------------------------------------------------

  /** Advance the race. Call once per frame with the player's world position. */
  public update(dt: number, playerWorldPos: THREE.Vector3, riding: RidingKind): void {
    this.pulse += dt;
    const circuitKind: CircuitKind | null =
      riding === 'car' ? 'land' : riding === 'boat' || riding === 'jetski' ? 'water' : null;

    // On foot (or between circuits): make sure any run is abandoned and gates dim.
    if (!circuitKind) {
      if (this.state === 'running') this.abort();
      this._dir.set(0, 0, 0);
      this.animateGates(null);
      this.onHud?.(null);
      return;
    }

    this._dir.copy(playerWorldPos).normalize();
    const moving = this.lastDir.lengthSq() > 0 && this._dir.angleTo(this.lastDir) > 1e-4;
    this.lastDir.copy(this._dir);

    const c = this.circuits[circuitKind]!;

    if (this.state === 'running' && this.active !== circuitKind) {
      // Switched vehicle class mid-race — abandon the old run.
      this.abort();
    }

    if (this.state === 'idle') {
      // Clear the re-arm lock once we've driven clear of the start gate.
      if (this.mustLeaveStart && !this.captured(this._dir, c.dirs[0])) {
        this.mustLeaveStart = false;
      }
      if (!this.mustLeaveStart && moving && this.captured(this._dir, c.dirs[0])) {
        this.arm(circuitKind);
      } else {
        const b = this.best[circuitKind];
        const chal = this.challenge?.kind === circuitKind ? this.challenge.ms / 1000 : null;
        this.onHud?.({
          line1: `🏁 ${circuitKind === 'land' ? 'Land' : 'Water'} circuit — drive through the ring to start`,
          line2:
            chal != null
              ? `⚔️ Beat ${formatTime(chal)}${b != null ? ` · your best ${formatTime(b)}` : ''}`
              : b != null
                ? `Best ${formatTime(b)}`
                : `${c.dirs.length} checkpoints`,
        });
      }
    } else if (this.state === 'running') {
      const target = c.dirs[this.nextIdx];
      if (this.captured(this._dir, target)) {
        if (this.nextIdx === 0) {
          this.finish(circuitKind);
        } else {
          this.nextIdx = (this.nextIdx + 1) % c.dirs.length;
          const passed = this.nextIdx === 0 ? c.dirs.length - 1 : this.nextIdx - 1;
          this.onEvent?.({
            kind: 'checkpoint',
            text:
              this.nextIdx === 0
                ? `✅ Last checkpoint — back to the line!`
                : `✅ Checkpoint ${passed}/${c.dirs.length - 1}`,
          });
        }
      }
      if (this.state === 'running') {
        const elapsed = (performance.now() - this.startT) / 1000;
        const cp = this.nextIdx === 0 ? c.dirs.length - 1 : this.nextIdx - 1;
        const chal = this.challenge?.kind === circuitKind ? this.challenge.ms / 1000 : null;
        this.onHud?.({
          line1: `🏁 ${formatTime(elapsed)}`,
          line2: `CP ${cp}/${c.dirs.length - 1}${
            chal != null
              ? ` · ⚔️ beat ${formatTime(chal)}`
              : this.best[circuitKind] != null
                ? ` · best ${formatTime(this.best[circuitKind]!)}`
                : ''
          }`,
        });
      }
    }

    this.animateGates(circuitKind);
  }

  private arm(kind: CircuitKind): void {
    this.state = 'running';
    this.active = kind;
    this.nextIdx = 1 % this.circuits[kind]!.dirs.length;
    this.startT = performance.now();
    this.onEvent?.({ kind: 'start', text: '🏁 Go! Hit every checkpoint.' });
  }

  private finish(kind: CircuitKind): void {
    const elapsed = (performance.now() - this.startT) / 1000;
    const prev = this.best[kind];
    const improved = prev == null || elapsed < prev;
    if (improved) {
      this.best[kind] = elapsed;
      this.saveBest(kind, elapsed);
    }
    this.onEvent?.({
      kind: 'finish',
      text: improved
        ? `🏆 ${formatTime(elapsed)} — new best!`
        : `🏁 ${formatTime(elapsed)} (best ${formatTime(prev!)})`,
      timeSec: elapsed,
      circuit: kind,
      improved,
    });
    this.state = 'idle';
    this.active = null;
    this.mustLeaveStart = true; // must clear the line before a new lap arms
  }

  private abort(): void {
    if (this.state !== 'running') return;
    this.state = 'idle';
    this.active = null;
    this.mustLeaveStart = false;
    this.onEvent?.({ kind: 'abort', text: '🏁 Race abandoned.' });
  }

  private captured(dir: THREE.Vector3, gate: THREE.Vector3): boolean {
    const cos = Math.cos(CAPTURE_WORLD / this.island.getRadius());
    return dir.dot(gate) >= cos;
  }

  // ---- visuals ------------------------------------------------------------

  /** Recolour gates for the active circuit; dim the other one. */
  private animateGates(activeKind: CircuitKind | null): void {
    (['land', 'water'] as CircuitKind[]).forEach((k) => {
      if (k === activeKind) this.paintCircuit(k);
      else this.paintCircuit(k, true);
    });
  }

  private paintCircuit(kind: CircuitKind, forceDim = false): void {
    const c = this.circuits[kind];
    if (!c) return;
    const running = this.state === 'running' && this.active === kind;
    // Reduced motion: hold a steady glow instead of a throbbing pulse
    const glow = a11y.reducedMotion ? 1.4 : 1.1 + Math.sin(this.pulse * 4) * 0.7;
    for (let i = 0; i < c.rings.length; i++) {
      const mat = c.rings[i].material as THREE.MeshStandardMaterial;
      if (forceDim) {
        // On foot / the other circuit: still a soft glowing ring (discoverable).
        // The START ring stays white so the compass-guided visitor arriving
        // on foot sees THE start line, not undifferentiated scenery.
        if (i === 0) {
          mat.emissive.setHex(0xffffff);
          mat.emissiveIntensity = 0.9;
        } else {
          mat.emissive.setHex(0x2f6fb0);
          mat.emissiveIntensity = 0.6;
        }
        continue;
      }
      let color = 0x3388dd; // pending (blue)
      let intensity = 0.75;
      const isTarget = running ? i === this.nextIdx : i === 0;
      if (running && this.isPassed(i)) {
        color = 0x2ecc71; // passed (green)
        intensity = 0.6;
      }
      if (i === 0 && !running) {
        color = 0xffffff; // start line invites when idle + eligible
        intensity = 0.85;
      }
      if (isTarget) {
        color = 0xffcc33; // next target (gold, pulsing)
        intensity = glow;
      }
      mat.emissive.setHex(color);
      mat.emissiveIntensity = intensity;
    }
  }

  private isPassed(i: number): boolean {
    // nextIdx is the next gate to hit; gates 1..nextIdx-1 are done. Gate 0 is
    // the finish, only "passed" once we've looped (nextIdx wrapped to 0).
    if (this.nextIdx === 0) return i !== 0; // all checkpoints done, heading home
    return i >= 1 && i < this.nextIdx;
  }

  // ---- persistence --------------------------------------------------------

  public getBest(kind: CircuitKind): number | null {
    return this.best[kind];
  }

  private loadBest(kind: CircuitKind): number | null {
    try {
      const v = localStorage.getItem(`ds_race_best2_${kind}`);
      return v ? parseFloat(v) : null;
    } catch {
      return null;
    }
  }

  private saveBest(kind: CircuitKind, t: number): void {
    try {
      localStorage.setItem(`ds_race_best2_${kind}`, String(t));
    } catch {
      /* ignore */
    }
  }
}

function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  const cs = Math.floor((sec * 100) % 100);
  return `${m}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}
