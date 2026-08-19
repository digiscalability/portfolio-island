import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { GLTF, GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';

// Accelerate terrain raycasts with a bounds tree (BVH). The island surface is a
// round(radius*5.8)^2 sphere (~378k triangles at R=75, ~168k at R=50) that gets
// raycast hundreds of times at boot (prop / path / shadow placement) and every
// frame (player grounding, camera collision).
// Plain intersectObject is O(triangles) per ray; a BVH makes it O(log n) with
// IDENTICAL hit results. Patched onto THREE's prototypes once — meshes without a
// boundsTree are unaffected (acceleratedRaycast falls back to the stock raycast).
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

import { addGroupHulls, addSkinnedHull, applyCelRim } from './CelLook';
import {
  DISTRICTS,
  RING_DISTRICT_LONS,
  ZONE_LAT,
  DISTRICT_SHIFT,
  districtAccentAt,
} from './Districts';
import { Materials } from './Materials';
import { NPC } from './NPC';
import { SimplePlayer } from './SimplePlayer';
import { SimpleRenderer } from './SimpleRenderer';
import TextureGenerator from './TextureGenerator';
import { isRealTheme } from './Theme';
import {
  REFERENCE_RADIUS as WORLD_REFERENCE_RADIUS,
  SEA_OFFSET as WORLD_SEA_OFFSET,
  areaScale,
  beltScale,
} from './WorldScale';

type IslandMeshUserData = {
  _debug?: boolean;
  _debugHelpers?: THREE.Group;
};

type ORMSplitResult = {
  aoMap: THREE.Texture;
  roughnessMap: THREE.Texture;
  metalnessMap: THREE.Texture;
};

type ModelOverride = {
  envMapIntensity?: number;
  roughnessScale?: number;
  scale?: number;
  ormPacking?: string;
  fitHeight?: number;
  yOffset?: number;
  randomYaw?: boolean;
};

type MaterialWithTextureProps = THREE.Material & {
  map?: THREE.Texture;
  normalMap?: THREE.Texture;
  roughnessMap?: THREE.Texture;
  metalnessMap?: THREE.Texture;
  aoMap?: THREE.Texture;
  emissiveMap?: THREE.Texture;
  bumpMap?: THREE.Texture;
  displacementMap?: THREE.Texture;
  alphaMap?: THREE.Texture;
  envMap?: THREE.Texture;
  emissive?: THREE.Color;
  roughness?: number;
  metalness?: number;
  shininess?: number;
  envMapIntensity?: number;
  userData?: {
    map?: THREE.Texture;
    [key: string]: unknown;
  };
};

const ormTextureCache = new WeakMap<object, ORMSplitResult | null>();
const ormTextureProcessing = new WeakSet<object>();

const getTextureIdentifier = (texture?: THREE.Texture): string =>
  texture?.name && texture.name.length ? texture.name : (texture?.uuid ?? '<unknown>');

const getDiagnostics = () => {
  if (!window.__ormDiagnostics) {
    window.__ormDiagnostics = [];
  }
  return window.__ormDiagnostics;
};

const extractTexture = (material: MaterialWithTextureProps): THREE.Texture | undefined => {
  if (material.map instanceof THREE.Texture) {
    return material.map;
  }
  const userDataMap = material.userData?.map;
  return userDataMap instanceof THREE.Texture ? userDataMap : undefined;
};

type GLTFLoaderConstructor = new () => GLTFLoader;

/**
 * Grass CLUMP geometry — the DEFAULT since the A/B was decided (Abbas's
 * "bigger patches instead of so many instances" ask). `?grass=blades` is the
 * escape hatch back to the old blade pair; there is no `?grass=clump`. One authored TUFT: a tall centre blade
 * ringed by shorter, outward-leaning skirt blades, all single-plane quads at
 * varied yaws (7 yaws supply the multi-angle coverage the old crossed pair
 * bought with double geometry). Ledger per 4 candidates: blade-pair path =
 * 4 instances × 12 verts = 48; clump path = 1 instance × 42 verts — ~12%
 * fewer verts and 75% fewer instances (less per-instance matrix bandwidth,
 * fatter reads-as-carpet silhouette).
 *
 * DETERMINISM: runs BEFORE the Phase-A scatter, so it must not consume
 * Math.random — the seeded stream feeds index-networked vehicle placement.
 * Local mulberry32 with a fixed seed; two calls return identical geometry
 * (pinned by test/grassClump.test.ts).
 */
export function buildGrassClumpGeometry(): { geometry: THREE.BufferGeometry; height: number } {
  let seed = 0x6c04d5 >>> 0;
  const rng = (): number => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  // SHIELD: three.js mints uuids for every BufferGeometry/BufferAttribute via
  // Math.random — inside the seeded-construction window those draws would
  // SHIFT the stream, desyncing this client's vehicle placement from clients
  // on the other grass mode (the test caught exactly this). Route them into
  // the local generator for the duration.
  const stashedRandom = Math.random;
  Math.random = rng;
  try {
    return buildClumpShielded(rng);
  } finally {
    Math.random = stashedRandom;
  }
}

function buildClumpShielded(rng: () => number): {
  geometry: THREE.BufferGeometry;
  height: number;
} {
  const positions: number[] = [];
  const colors: number[] = [];
  // Same luminance-only gradient contract as the blade pair: instanceColor
  // MULTIPLIES vertexColor, so hue lives on the instance, shading here.
  const baseC = new THREE.Color(0xa8a8a8); // hair darker at the crowded base
  const tipC = new THREE.Color(0xffffff);
  const col = new THREE.Color();
  const CLUMP_H = 0.15;
  // FATTER TUFT (2026-08-16, Abbas's ask): 11 blades in a two-ring dome
  // instead of 7 in one skirt — a centre heart, a 4-blade inner ring and a
  // 6-blade outer skirt. Paired with a HARDER stride in the scatter (every
  // 8th candidate, was every 4th) the net is ~21% FEWER grass verts and half
  // the instances, while each surviving tuft reads visibly fuller — the point
  // of the trade. Blade COUNT only costs draws inside this shielded builder,
  // so it can change freely without touching the ambient RNG stream.
  const BLADES = 11;
  const INNER = 5; // b 1..4 inner ring, b 5..10 outer skirt
  const RING_MAX = 0.22;
  for (let b = 0; b < BLADES; b++) {
    // Two rings give the dome its shoulder; one wide skirt read as a spider.
    const ring =
      b === 0
        ? 0
        : b < INNER
          ? 0.05 + rng() * 0.06 // inner ring, close to the heart
          : 0.125 + rng() * 0.095; // outer skirt, out to RING_MAX
    // Angles advance per RING so neither ring combs into a line.
    const ang = (b / BLADES) * Math.PI * 2 + rng() * 0.8;
    const ox = Math.cos(ang) * ring;
    const oz = Math.sin(ang) * ring;
    const h = (b === 0 ? 1 : b < INNER ? 0.72 + rng() * 0.23 : 0.5 + rng() * 0.28) * CLUMP_H;
    const baseW = 0.03 + rng() * 0.014;
    const tipW = baseW * 0.52; // blunt tip — the un-spiky rule from the pair
    const yaw = rng() * Math.PI * 2;
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    // Skirt blades lean outward from the heart — the tuft silhouette.
    const lean = (ring / RING_MAX) * 0.38 * h;
    const lx = Math.cos(ang) * lean;
    const lz = Math.sin(ang) * lean;
    const v = (x: number, y: number, tip: boolean): void => {
      positions.push(x * c + ox + (tip ? lx : 0), y, x * s + oz + (tip ? lz : 0));
      col.copy(baseC).lerp(tipC, y / CLUMP_H);
      colors.push(col.r, col.g, col.b);
    };
    v(-baseW, 0, false);
    v(baseW, 0, false);
    v(tipW, h, true);
    v(-baseW, 0, false);
    v(tipW, h, true);
    v(-tipW, h, true);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.computeVertexNormals();
  return { geometry, height: CLUMP_H };
}

export class Island {
  /** The island root GROUP (terrain, sea, props…). Not a Mesh — the terrain
   *  itself is `surfaceMesh`. Was mistyped as THREE.Mesh, which hid a crash in
   *  GameScene.dispose that read `.geometry` off this group every teardown. */
  public mesh: THREE.Group;
  public radius: number;
  private center: THREE.Vector3;
  private surfaceMesh?: THREE.Mesh;
  private animationMixers: THREE.AnimationMixer[] = [];
  private npcInstances: NPC[] = [];
  public npcTargets: Array<{
    position: THREE.Vector3;
    name: string;
    dialogue: string[];
    meshRef: THREE.Object3D;
  }> = [];
  // Sampled sites exposed for GameScene's ambient life (butterflies, smoke)
  public flowerSites: THREE.Vector3[] = [];
  public chimneySites: Array<{ position: THREE.Vector3; normal: THREE.Vector3 }> = [];
  /** World anchors just OUTSIDE each cottage's door (for the enter interaction). */
  public houseDoors: Array<{ position: THREE.Vector3; id: string }> = [];
  // Activity anchors for the NPC schedule engine (NpcActivities.ts) — world
  // positions of props NPCs walk to and work at. Populated in the build loops.
  public lampSites: THREE.Vector3[] = [];
  /** The two InstancedMesh carrying every street lamp (bodies + bulbs). Held
   *  so the seat pass can rewrite their matrices and so the lamp.glb load can
   *  hide the whole fleet in one line — they are the FALLBACK visual, shown
   *  only until (or unless) the authored model replaces the lamps. */
  private lampFleet: THREE.InstancedMesh[] = [];
  public mailboxSites: THREE.Vector3[] = [];
  public stallSites: THREE.Vector3[] = []; // shopper spots IN FRONT of counters
  public stallProps: THREE.Vector3[] = []; // the stalls themselves
  public benchSites: THREE.Vector3[] = [];
  public flowerBedSites: THREE.Vector3[] = [];
  /** Centre of the Gardener's walled garden (unit dir), null until built. */
  public gardenDir: THREE.Vector3 | null = null;
  /** The Farmer's crop-row working spots, and his field centre. */
  public cropRowSites: THREE.Vector3[] = [];
  // Hanging shop-sign boards + their swing phase — ticked by GameScene.update
  // (the signs live on `root`, never matrix-frozen, so a transform swing works).
  public hangSigns: Array<{ group: THREE.Object3D; phase: number }> = [];
  public farmDir: THREE.Vector3 | null = null;
  // Harvest registry (wave 3): pure post-capture of every crop instance's
  // BUILT matrix — zero RNG, zero new geometry inside the seeded window.
  // GameScene scales instances to near-zero on harvest and ramps them back
  // through these captured matrices (regrow must target the BUILT matrix:
  // pumpkins/wheat carry random size factors a recomputed stage can't know).
  public farmHarvest: Array<{
    kind: string;
    yieldKind: 'produce' | 'wheat';
    yieldN: number;
    index: number;
    layers: Array<{ mesh: THREE.InstancedMesh; built: THREE.Matrix4 }>;
    pos: THREE.Vector3;
    state: 'ripe' | 'regrowing';
    regrowStart: number;
    regrowEnd: number;
  }> = [];
  /** The Musician's stage and the Artist's easel — their own stations. */
  public bandstandSites: THREE.Vector3[] = [];
  public easelSites: THREE.Vector3[] = [];
  public lighthouseDir: THREE.Vector3 | null = null;
  // Colliders for props placed ASYNCHRONOUSLY (GLB loads finish after
  // GameScene's registration pass) — GameScene drains this each frame
  public pendingColliders: Array<{ position: THREE.Vector3; radius: number }> = [];
  // Shared time uniform driving the grass wind vertex shader
  public grassTimeUniform: { value: number } = { value: 0 };
  // Player position (island-local == world, the root sits at origin) for the
  // grass push-aside shader. Default at planet centre → every blade is ~radius
  // away → zero push until someone wires setGrassPlayerPosition.
  public grassPlayerUniform: { value: THREE.Vector3 } = { value: new THREE.Vector3() };
  // A TRAILING copy of the player position (CPU-smoothed by GameScene, ~0.4s
  // behind). The shader pushes blades away from BOTH points and takes the max,
  // so a walked path stays parted briefly and recovers as the trail catches up.
  public grassPlayerPrevUniform: { value: THREE.Vector3 } = { value: new THREE.Vector3() };
  // Sky-horizon colour for the sea's fresnel reflection. Defaults to the day
  // horizon blue; bindSeaSkyColor swaps in EnvironmentCycle's live Color so
  // the water tracks dusk/night with zero per-frame plumbing.
  public seaSkyHorizonUniform: { value: THREE.Color } = { value: new THREE.Color(0x79b7e6) };
  // Shared time uniform driving the sea wave vertex shader
  /**
   * Surf band DEPTHS (collar, shallow, edge), solved per-radius.
   *
   * These were three literals — 1.6 / 2.4 / 3.2 — and they are DEPTHS, but
   * what the eye reads is how many METRES of water the bands cover. Those are
   * not the same thing at different radii: the continental shelf steepens as
   * the world grows, so a fixed depth sits CLOSER to shore. MEASURED from the
   * waterline outward, the R=75->100 flip compressed the visible surf zone:
   * collar 3.75m -> 3.25m, shallow 6.00m -> 5.25m (both about -13%), in the
   * most-looked-at 25 metres of the world.
   *
   * calibrateSurfBands() solves for the depth that lands each band at its
   * authored METRE offset on THIS island, so the surf reads the same at any
   * radius — and reproduces 1.6/2.4/3.2 at R=75 by construction.
   */
  private seaBandsUniform = { value: new THREE.Vector3(1.6, 2.4, 3.2) };

  public seaTimeUniform: { value: number } = { value: 0 };
  // Slow rise/fall of the whole sea surface, shared by the shader and the CPU
  // wave sampler. Amplitude is kept under the ~0.19 height where land begins,
  // so a high tide laps the beach without visually swallowing it.
  public seaTideUniform: { value: number } = { value: 0 };
  // Analytic terrain height, captured from createIsland so the sea mesh can
  // bake per-vertex water depth without 9k raycasts.
  private terrainRadiusFor!: (normal: THREE.Vector3, v: THREE.Vector3) => number;
  // Summit-trail lookup (w: 1 on the path centreline → 0 at its edge; t: 0 at
  // the summit → 1 at the base). Shared with the colour pass, grass, and trees
  // so they can dirt-tint the path and keep vegetation off it.
  private trailAt!: (normal: THREE.Vector3) => { w: number; t: number };
  public trailSummitDir?: THREE.Vector3;
  // Rotated/bobbed by GameScene each frame — the pizzazz for reaching the top.
  public summitBeacon?: THREE.Object3D;
  // Grass instancing handle + full count for the quality governor's budget hook
  private grassChunks: THREE.InstancedMesh[] = [];
  private grassChunkFullCounts: number[] = [];
  private grassFullCount = 0;
  // Radial water-surface offset above the base radius (matches the sea mesh).
  // Land sits >= base+0.3 (continent mask floor); the calm surface at +0.1
  // with wave crests to +0.25 stays just under the beach so waves lap the
  // shore without flooding the districts.
  public static readonly SEA_OFFSET = WORLD_SEA_OFFSET;
  /**
   * The radius every absolute relief constant in this file was authored against.
   * Terrain displacement, the beach floor, the sea offset and the displacement
   * ceiling are all world-unit heights tuned by eye at R=50.
   *
   * Both re-exported from WorldScale so the shader patch in SoftLook — which
   * runs before any Island exists — reads the same numbers these do.
   */
  public static readonly REFERENCE_RADIUS = WORLD_REFERENCE_RADIUS;
  // Minimum land displacement (the beach floor) in createIsland(). Named so the
  // sea-vs-land headroom invariant described just below is TESTABLE rather than
  // only asserted in prose — see test/islandRadius.test.ts. Raised 0.3 -> 0.75
  // when the ocean's crests + tide broke through the beach.
  public static readonly LAND_FLOOR = 0.75;
  // Ceiling on terrain displacement above the base sphere. MUST stay above the
  // tallest landform (floor + peak + crag) or summits clip flat into a mesa,
  // and the surface sampler's ray must start ABOVE this or raycasts begin
  // INSIDE the summit and miss it. That second ordering used to be maintained
  // by hand via a comment; SAMPLE_RAY_DISP now derives from it so the two
  // cannot drift apart. Both are absolute world units and scale with the world.
  public static readonly MAX_DISPLACEMENT = 9.2;
  /** Ray-start headroom for sampleSurfacePosition — always clears MAX_DISPLACEMENT. */
  public static readonly SAMPLE_RAY_DISP = Island.MAX_DISPLACEMENT + 1.8;
  /** Shared scratch raycaster for the surface samplers (never allocate per call). */
  private static readonly _scratchRaycaster = new THREE.Raycaster();

  /**
   * Multiplier on every ABSOLUTE relief height, so the world's silhouette is
   * radius-invariant.
   *
   * Landform EXTENTS are angular (peak reach, trail reach, the islet mask, the
   * shore band), so they stretch with the world for free. Landform HEIGHTS are
   * absolute. Grow the radius without this and the same 7.3u summit sits on a
   * 1.5x wider base: the steepest flank falls from 41.8 deg to 30.8 deg and the
   * island reads flat and pastoral instead of dramatic.
   *
   * Scaling here rather than at ~20 individual constants keeps height/radius —
   * i.e. the ANGULAR profile you actually see — fixed at any size, and is 1.0 at
   * the reference radius, so R=50 output is bit-identical.
   *
   * NOT applied to WAVE_AMP / TIDE_AMP: waves are ridden by boats and swimmers,
   * which do not scale. Swell is a human-scale phenomenon like a door or a cat.
   */
  private get reliefScale(): number {
    return this.radius / Island.REFERENCE_RADIUS;
  }
  // Wave field constants (shared by the sea shader AND the analytic sampler
  // that floats swimmers/boats, so the mesh and the physics agree exactly).
  // NB: the wave sum peaks at 1.8, so the real displacement is AMP * 1.8.
  // Sea can therefore reach SEA_OFFSET + 0.36 + TIDE_AMP ≈ 0.55 above the base
  // sphere — which must stay BELOW the land floor in createIsland(), or the
  // ocean pokes up through the beach (it did: 0.425 sea vs a 0.3 land floor).
  private static readonly WAVE_AMP = 0.2;
  private static readonly TIDE_AMP = 0.09; // radial units above/below mean sea
  private static readonly TIDE_PERIOD = 120; // seconds for a full high→low→high

  constructor(radius: number = 18) {
    this.radius = radius;
    this.center = new THREE.Vector3(0, 0, 0);
    this.mesh = this.createIsland();
    // debug flag (enable via window.__ISLAND_DEBUG = true in console)
    if (typeof window !== 'undefined') {
      const debugFlag = (window as typeof window & { __ISLAND_DEBUG?: boolean }).__ISLAND_DEBUG;
      if (debugFlag) {
        const data = this.mesh.userData as IslandMeshUserData;
        data._debug = true;
      }
    }
  }

  /**
   * Quality-governor hook: draw only a prefix of the grass instances.
   * Instance SLOTS are written in coprime-stride order over the golden-spiral
   * scatter (see createGrass) — a raw spiral prefix would strip everything
   * below a latitude line, the stride makes any prefix spatially uniform.
   */
  public setGrassBudget(fraction: number): void {
    if (!this.grassChunks.length || !this.grassFullCount) return;
    const f = THREE.MathUtils.clamp(fraction, 0.25, 1);
    // Per-chunk prefix trim. Each chunk's append order is the global
    // coprime-stride order restricted to its sector, so a prefix stays a
    // spatially uniform thinning within every sector — adjacent chunks thin at
    // the same expected density and no seam appears at 0.5. Rounding drift vs
    // a global trim is ≤ SECTORS/2 instances. NEVER recompute bounding spheres
    // here — they were built once at full count.
    for (let i = 0; i < this.grassChunks.length; i++) {
      this.grassChunks[i].count = Math.max(1, Math.round(this.grassChunkFullCounts[i] * f));
    }
  }

  /** Per-frame: copy the player's world position into the grass push uniform
   *  (island-local == world — the root group sits at origin). `trail` is the
   *  smoothed trailing point (recovery-over-time). No allocation. */
  public setGrassPlayerPosition(pos: THREE.Vector3, trail?: THREE.Vector3): void {
    this.grassPlayerUniform.value.copy(pos);
    if (trail) this.grassPlayerPrevUniform.value.copy(trail);
  }

  /** Share EnvironmentCycle's live horizon Color BY REFERENCE so the sea's
   *  fresnel sky mix tracks day/dusk/night for free. Safe before or after the
   *  sea shader compiles — the uniform object itself is what's shared. */
  public bindSeaSkyColor(horizon: THREE.Color): void {
    this.seaSkyHorizonUniform.value = horizon;
  }

  /**
   * Seat each prop group's children exactly on the terrain: project the
   * child's bounding box onto its surface normal and shift it so the box
   * base rests at the sampled surface (minus a small sink). Shape-agnostic
   * — wheel bottoms, lamp poles, and mailbox posts all land correctly.
   */
  private seatGroupsOnTerrain(root: THREE.Group, groups: THREE.Group[]): void {
    root.updateMatrixWorld(true);
    const box = new THREE.Box3();
    const dir = new THREE.Vector3();
    const savedPos = new THREE.Vector3();
    const savedQuat = new THREE.Quaternion();
    const SINK = 0.05;
    for (const group of groups) {
      for (const child of group.children) {
        if (child.position.lengthSq() < 1) continue; // not surface-positioned
        // Measure the bbox in the child's LOCAL frame: a world-space AABB of
        // a sphere-aligned (rotated) prop inflates below the true base and
        // over-lifts it. Temporarily zero the transform, measure, restore.
        savedPos.copy(child.position);
        savedQuat.copy(child.quaternion);
        child.position.set(0, 0, 0);
        child.quaternion.identity();
        child.updateMatrixWorld(true);
        box.setFromObject(child);
        child.position.copy(savedPos);
        child.quaternion.copy(savedQuat);
        child.updateMatrixWorld(true);
        if (box.isEmpty()) continue;
        // Local +Y is the surface normal for all these props, so box.min.y
        // is how far the geometry extends below the group origin.
        const minY = box.min.y;
        dir.copy(savedPos).normalize();
        const sampled = this.sampleSurfaceByDirection(dir, 0);
        const surfaceProj = sampled.position.dot(dir);
        const originProj = savedPos.dot(dir);
        const delta = surfaceProj - SINK - minY - originProj;
        if (Math.abs(delta) > 0.02) {
          child.position.addScaledVector(dir, delta);
          child.updateMatrixWorld(true);
          // Keep NPC interaction anchors in sync with the moved mesh
          for (const npc of this.npcTargets) {
            if (npc.meshRef === child) npc.position.copy(child.position);
          }
        }
      }
    }
  }

  /**
   * Wind-blown grass: one InstancedMesh of cross-blade triangles scattered
   * over the sphere (golden-spiral + jitter). Blades are vertex-colored
   * dark base → light tip (fake AO for free) and bend in a vertex shader
   * driven by the shared grassTimeUniform — zero per-frame CPU cost.
   */
  /**
   * Surface sample WITHOUT a raycast — orders of magnitude cheaper than
   * sampleSurfaceByDirection (the oft-quoted 1.24ms/raycast figure predates
   * the BVH; with firstHitOnly a ray is tens of microseconds against the
   * terrain, versus a few analytic noise evaluations here). Use this for bulk
   * placement of thousands of items; keep the raycast version for anything
   * that must hit the real mesh (e.g. props placed after GLB swaps).
   *
   * The normal comes from finite differences: two tangent offsets, crossed.
   */
  /** Low-frequency lateral moisture field (-1..1), shared by the terrain
   *  colour pass and the grass tint so blades match the ground they stand on.
   *  Same formula as createIsland's noise3D — keep them in step. */
  private moistureAt(dir: THREE.Vector3): number {
    const s = 0.3; // ~10-20u features on the r=18 island
    const x = dir.x * this.radius;
    const y = dir.y * this.radius;
    const z = dir.z * this.radius;
    return (
      (Math.sin(x * s) * Math.cos(z * s) +
        Math.sin(y * s) * Math.cos(x * s) +
        Math.sin(z * s) * Math.cos(y * s)) /
      3
    );
  }

  public analyticSurface(dir: THREE.Vector3): { radius: number; normal: THREE.Vector3 } {
    const normal = new THREE.Vector3();
    const radius = this.analyticSurfaceInto(dir, normal);
    return { radius, normal };
  }

  // Scratch vectors for analyticSurfaceInto — module-lifetime, single-threaded,
  // and terrainRadiusFor never re-enters, so reuse is safe.
  private static readonly _asN = new THREE.Vector3();
  private static readonly _asT1 = new THREE.Vector3();
  private static readonly _asT2 = new THREE.Vector3();
  private static readonly _asPA = new THREE.Vector3();
  private static readonly _asPB = new THREE.Vector3();
  private static readonly _asP0 = new THREE.Vector3();
  private static readonly _asV = new THREE.Vector3();

  /** Allocation-free analyticSurface: writes the surface normal into `outNormal`
   *  and returns the terrain radius. Same maths as the object-returning wrapper —
   *  use THIS on hot loops (the 100k-blade grass pass used to allocate ~900k
   *  Vector3s through the wrapper's clones alone). */
  public analyticSurfaceInto(dir: THREE.Vector3, outNormal: THREE.Vector3): number {
    if (!this.terrainRadiusFor) {
      const s = this.sampleSurfaceByDirection(dir, 0);
      outNormal.copy(s.normal);
      return s.position.length();
    }
    const n = Island._asN.copy(dir).normalize();
    const at = (d: THREE.Vector3): number =>
      this.terrainRadiusFor(d, Island._asV.copy(d).multiplyScalar(this.radius));
    const r = at(n);
    const t1 = Island._asT1.set(0, 1, 0).cross(n);
    if (t1.lengthSq() < 1e-8) t1.set(1, 0, 0);
    t1.normalize();
    const t2 = Island._asT2.crossVectors(n, t1).normalize();
    const EPS = 0.02;
    const pA = Island._asPA.copy(n).addScaledVector(t1, EPS).normalize();
    const pB = Island._asPB.copy(n).addScaledVector(t2, EPS).normalize();
    const p0 = Island._asP0.copy(n).multiplyScalar(r);
    const vA = pA.multiplyScalar(at(pA)).sub(p0);
    const vB = pB.multiplyScalar(at(pB)).sub(p0);
    outNormal.crossVectors(vA, vB).normalize();
    if (outNormal.dot(n) < 0) outNormal.negate();
    if (!Number.isFinite(outNormal.x)) outNormal.copy(n);
    return r;
  }

  // Scratch vectors for ringMinRadius (same single-threaded reuse contract
  // as the analyticSurfaceInto scratch set above).
  private static readonly _rmT1 = new THREE.Vector3();
  private static readonly _rmT2 = new THREE.Vector3();
  private static readonly _rmP = new THREE.Vector3();
  private static readonly _rmN = new THREE.Vector3();

  /**
   * Lowest analytic terrain radius on a small ring around `dir` — the farm
   * grounding rule generalised: a rigid base must seat at the LOWEST ground
   * under its footprint, not the centre tangent point, or its downhill edge
   * hangs in mid-air on slopes. `ringRadius` is in world units (the base's
   * footprint radius). Analytic probes only — safe on the world-gen path.
   */
  private ringMinRadius(dir: THREE.Vector3, ringRadius: number, samples = 4): number {
    const t1 = Island._rmT1.set(0, 1, 0).cross(dir);
    if (t1.lengthSq() < 1e-8) t1.set(1, 0, 0);
    t1.normalize();
    const t2 = Island._rmT2.crossVectors(dir, t1).normalize();
    let min = Infinity;
    for (let s = 0; s < samples; s++) {
      const ang = (s / samples) * Math.PI * 2;
      const probe = Island._rmP
        .copy(dir)
        .multiplyScalar(this.radius)
        .addScaledVector(t1, Math.cos(ang) * ringRadius)
        .addScaledVector(t2, Math.sin(ang) * ringRadius)
        .normalize();
      min = Math.min(min, this.analyticSurfaceInto(probe, Island._rmN));
    }
    return min;
  }

  /** Clump tufts are the DEFAULT since Abbas's A/B verdict (2026-08-10);
   *  ?grass=blades remains as the escape hatch back to the blade-pair
   *  stipple (same pattern as the sky's ?sky=smooth). */
  private static isClumpGrass(): boolean {
    try {
      return new URLSearchParams(window.location.search).get('grass') !== 'blades';
    } catch {
      return true;
    }
  }

  private createGrass(): THREE.Group {
    // ── SHIELD (2026-08-16) ────────────────────────────────────────────────
    // Phase A below takes great care to keep its Math.random ORDER identical
    // (see the "burn" calls) because the seeded stream feeds index-networked
    // vehicle placement. But the COUNT was never tier-independent: COUNT is
    // `lowTier ? 32000 : ~124k`, so a phone consumed ~600k FEWER ambient draws
    // than a desktop and every scatter AFTER the grass diverged. Measured
    // before this shield: 157 vs 160 rock instances in an entirely different
    // boulder field — and rocks push COLLIDERS, so a phone player was blocked
    // where a desktop player walked free.
    //
    // Preserving the order was never enough; the fix is to stop spending the
    // SHARED stream here at all. Routing the whole build into a local
    // generator makes grass cost exactly ZERO ambient draws on every tier and
    // every theme, so downstream placement is identical for all clients —
    // the same law as buildGrassClumpGeometry, createOreNodes,
    // buildDistrictAmenities and the cel ink. The alternative (make phones
    // iterate the desktop count and throw the extra away) would buy parity
    // with startup CPU on exactly the devices that can least afford it.
    const stashedRandom = Math.random;
    let gseed = 0x6a55eed0 >>> 0;
    Math.random = (): number => {
      gseed = (gseed + 0x6d2b79f5) >>> 0;
      let t = Math.imul(gseed ^ (gseed >>> 15), 1 | gseed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    try {
      return this.createGrassShielded();
    } finally {
      Math.random = stashedRandom;
    }
  }

  private createGrassShielded(): THREE.Group {
    // Two crossed blades, base at origin.
    //
    // Each blade was ONE triangle converging to a single point — 0.09 wide by
    // 0.3 tall, a 1:3.3 spike, which is why the meadow read as spiky. Now a
    // tapered quad with a BLUNT top: wider at the base, narrower but still
    // flat-topped at the tip, and a little shorter. Two triangles per face
    // instead of one (4 per instance, ~24k total) buys the softer silhouette
    // cheaply, and it stays a single draw call.
    const positions: number[] = [];
    const colors: number[] = [];
    // LUMINANCE ONLY — not green. three.js MULTIPLIES instanceColor by
    // vertexColor, so colouring both green squared the darkness and the blades
    // came out near-black against pale terrain; that contrast, more than the
    // silhouette, is what read as harsh. The per-blade instanceColor now
    // carries the hue and this gradient only shades base→tip.
    const baseC = new THREE.Color(0xb2b2b2);
    const tipC = new THREE.Color(0xffffff);
    // Carpet, not spikes. The giveaway of a spike is the ASPECT RATIO: at
    // 0.116 wide by 0.26 tall each blade was ~1:2.2 and read as its own
    // object. Halving the height while keeping the width takes it to ~1:1.3 —
    // a low tuft. Density (see COUNT below) does the rest: carpet is a
    // property of the crowd, not of one blade.
    const BLADE_H = 0.088;
    const BASE_W = 0.032; // thinner: fine strands, not leaves
    const TIP_W = 0.017; // still blunt — a flat tip is what keeps it un-spiky
    const addBlade = (rotY: number) => {
      const c = Math.cos(rotY);
      const s = Math.sin(rotY);
      const v = (x: number, y: number, z: number, col: THREE.Color) => {
        positions.push(x * c - z * s, y, x * s + z * c);
        colors.push(col.r, col.g, col.b);
      };
      v(-BASE_W, 0, 0, baseC);
      v(BASE_W, 0, 0, baseC);
      v(TIP_W, BLADE_H, 0, tipC);
      v(-BASE_W, 0, 0, baseC);
      v(TIP_W, BLADE_H, 0, tipC);
      v(-TIP_W, BLADE_H, 0, tipC);
    };
    addBlade(0);
    addBlade(Math.PI / 2);
    let geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geo.computeVertexNormals();

    // CLUMP (default; `?grass=blades` opts out): the authored 7-blade tuft and
    // (in Phase B below) materialize every 4th candidate. Phase A runs
    // UNCHANGED either way — its Math.random order is the vehicle-placement
    // wire protocol. SWAY_H feeds the wind shader's bend divisor so the
    // taller tuft bends by the same normalized amount as a blade.
    const clumpMode = Island.isClumpGrass();
    let SWAY_H = BLADE_H;
    if (clumpMode) {
      const clump = buildGrassClumpGeometry();
      geo = clump.geometry;
      SWAY_H = clump.height;
    }

    // Grass is the one material authored directly as toon (everything else is
    // MeshStandardMaterial + the toonify pass). Under ?theme=real it becomes
    // standard too; the sway/push shader injections below target chunks
    // (<common>, <begin_vertex>) present in BOTH materials' vertex shaders.
    const mat = isRealTheme()
      ? new THREE.MeshStandardMaterial({
          vertexColors: true,
          side: THREE.DoubleSide,
          roughness: 0.9,
          metalness: 0,
        })
      : new THREE.MeshToonMaterial({
          vertexColors: true,
          side: THREE.DoubleSide,
          gradientMap: Materials.toonRamp(), // shared: the meadow bands like the world
        });
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = this.grassTimeUniform;
      shader.uniforms.uPlayerPos = this.grassPlayerUniform;
      shader.uniforms.uPlayerPrev = this.grassPlayerPrevUniform;
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          '#include <common>\nuniform float uTime;\nuniform vec3 uPlayerPos;\nuniform vec3 uPlayerPrev;',
        )
        .replace(
          '#include <begin_vertex>',
          [
            '#include <begin_vertex>',
            '#ifdef USE_INSTANCING',
            '  float gPhase = instanceMatrix[3].x * 1.7 + instanceMatrix[3].z * 2.3 + instanceMatrix[3].y * 1.1;',
            '  float gBend = sin(uTime * 2.1 + gPhase) + 0.5 * sin(uTime * 3.6 + gPhase * 1.4);',
            // Traveling gust: a directional wave sweeping the field, layered
            // over the local sway so the wind reads as weather, not twitching.
            '  float gGust = 0.65 + 0.5 * sin(dot(instanceMatrix[3].xz, vec2(0.31, 0.24)) - uTime * 1.5);',
            // Normalised by BLADE_H so the tip bends by the full amount and
            // the base stays planted — keep this divisor in step with the
            // blade height above, or the sway scales wrong.
            // Gentler now the blades are half as tall — a short tuft that
            // swings as far as a long blade did just looks like it's twitching.
            `  transformed.x += gBend * gGust * 0.026 * (position.y / ${SWAY_H});`,
            // Player push: bend away within ~1.2u. `transformed` is blade-local
            // (instanceMatrix applies later), so rotate the world-space "away"
            // into the blade frame — transpose ≈ inverse for the rotation part;
            // the instance scale only jitters the radius by ±20%, fine.
            '  vec3 gAway = transpose(mat3(instanceMatrix)) * (instanceMatrix[3].xyz - uPlayerPos);',
            '  float gPush = max(0.0, 1.0 - length(gAway) / 1.2);',
            // Trailing push: same bend from the CPU-smoothed trail point (~0.4s
            // behind). max() of the two = the walked path stays parted a beat
            // and RECOVERS as the trail catches up — bend with a memory.
            '  vec3 gAway2 = transpose(mat3(instanceMatrix)) * (instanceMatrix[3].xyz - uPlayerPrev);',
            '  float gPush2 = max(0.0, 1.0 - length(gAway2) / 1.2) * 0.7;',
            '  if (gPush2 > gPush) { gAway = gAway2; gPush = gPush2; }',
            `  transformed.xz += normalize(gAway.xz + vec2(1e-4)) * (gPush * gPush * 0.18) * (position.y / ${SWAY_H});`,
            '#endif',
          ].join('\n'),
        );
    };

    // Grass is pure decoration but 6000 instanced blades still cost vertex
    // work every frame (wind shader). Halve it on phones/tablets and
    // low-core machines so the ambient layer doesn't tax weaker GPUs.
    const lowTier = SimpleRenderer.isLowTierDevice();
    // Density is what makes it read as carpet rather than scattered objects.
    // Tripled now that each blade is half the height — 18000 x 4 tris = 72k,
    // still one draw call, and the blades are small enough that the extra
    // vertex work is cheap. Phones keep a lower count.
    // Grass is the single biggest lever in the world and the one place "correct
    // area maths" and "runs on a phone" disagree, so the two tiers diverge
    // DELIBERATELY:
    //
    //  - Desktop ships 55% of proportional density — GRASS_DENSITY_FRACTION
    //    below, i.e. 100k * areaScale(75)=2.25 * 0.55 = ~124k slots (and clump
    //    mode then materialises every 8th, ~15.5k tufts). Blade
    //    geometry is 12 non-indexed verts, so full proportional would be 2.7M
    //    verts every frame, and this is ONE planet-spanning InstancedMesh whose
    //    bounding sphere always intersects the frustum — none of it is ever
    //    culled. The adaptive governor can't rescue it either: its first and
    //    largest lever is render RESOLUTION (fragment-side) while everything the
    //    grow adds is vertex-side.
    //  - Low tier deliberately does NOT grow. Phones keep today's 32k and accept
    //    thinner grass; a device that shipped fine at R=50 has no headroom for
    //    2.25x the vertices. This is a decision, not an oversight.
    //
    // max(1, ...) keeps the reference world exactly as authored.
    //
    // 0.8 -> 0.55 (2026-08-10): 0.8 shipped and the live world went jittery+
    // laggy on desktop. Measured: grass was the largest single render-time
    // slice (~21% at the fly-in viewpoint, 180k->45k blades), and the added
    // load is vertex-side, which the governor cannot shed until its LAST rung —
    // so it hunted resolution once a second (each step reallocates the composer
    // targets = the jitter) without ever recovering (the lag). 0.55 keeps the
    // grass verts within ~25% of the load the R=50 world proved out.
    // If still heavy: 0.4 next, then the real fix — give the governor a
    // vertex-side lever EARLIER than rung 3 (LOCAL-STATE "Deferred" list:
    // animal instancing / terrain LOD / governor vertex-rung).
    // Owner decision (2026-08-16, R=100 flip): HOLD TOTAL VERTS, not density.
    // A proportional 0.55 at areaScale(100)=4.0 would be 220,000 slots and
    // ~1.19M grass verts (+85%) — close to the config that shipped the R=75
    // lag. Expressing the budget as SLOTS instead of a fraction makes the
    // intent radius-proof: the meadow reads ~56% as dense per square metre on
    // the bigger island (more open, more walkable) and costs what it does now.
    // To go back to proportional density, set this to
    // 100000 * areaScale(this.radius) * 0.55.
    const GRASS_SLOT_BUDGET = 123750; // == the measured R=75 slot count
    const GRASS_DENSITY_FRACTION = GRASS_SLOT_BUDGET / (100000 * areaScale(this.radius));
    const COUNT = lowTier
      ? 32000
      : // NB: every scale call in this file passes THIS island's radius — the
        // module-level default (WORLD_RADIUS) builds the wrong world when a
        // test constructs Island(50). Caught by the headless suite: lamps came
        // out identical at both radii.
        Math.round(100000 * Math.max(1, areaScale(this.radius) * GRASS_DENSITY_FRACTION));
    // ── SECTOR CHUNKING ──────────────────────────────────────────────────
    // One planet-spanning InstancedMesh could never frustum-cull: its bounding
    // sphere IS the planet, so all ~1.5M grass verts were submitted every
    // frame from every viewpoint. Split into 8 longitude octants, each with a
    // tight bounding sphere, and the far side of the planet culls — measured
    // 40-60% of grass verts dropped in a normal chase view. Collapsed blades
    // (shore/street/trail/steep) are DROPPED rather than written as degenerate
    // matrices: a slot at the origin would drag every chunk's sphere over the
    // planet centre and silently kill the culling (that's also ~1/3 fewer
    // slots on the GPU). Phase A below runs the ORIGINAL loop byte-for-byte in
    // math and Math.random() order — the seeded stream feeds index-networked
    // vehicle placement across multiplayer clients and must stay bit-identical.
    // Partition: latitude bands x longitude wedges, NOT plain lon octants.
    // Measured: on a NORTH-CAP island every lon octant touches the pole, so a
    // camera near the hub saw all eight and culling was 0-26%. Splitting the
    // cap off and wedging the two lower bands keeps each sphere small:
    //   chunk 0            = polar cap  (lat > 1.1)
    //   chunks 1..6        = mid band   (0.7 < lat <= 1.1), 6 lon wedges
    //   chunks 7..14       = low band   (shore..0.7), 8 lon wedges
    const SECTORS = 15;
    const MID_Y = Math.sin(0.7);
    const CAP_Y = Math.sin(1.1);
    const sectorOf = (d: THREE.Vector3): number => {
      if (d.y > CAP_Y) return 0;
      const lonFrac = (Math.atan2(d.z, d.x) / (Math.PI * 2) + 1) % 1;
      if (d.y > MID_Y) return 1 + Math.min(5, Math.floor(lonFrac * 6));
      return 7 + Math.min(7, Math.floor(lonFrac * 8));
    };
    // Marshal into preallocated typed arrays instead of growing number[][].
    // Phase A writes every surviving blade to a single staging buffer in the
    // coprime-stride VISITATION order (16 matrix floats + 3 colour floats),
    // tagging its sector; a no-RNG bucket pass after the loop distributes that
    // into exact-size per-sector Float32Arrays. Preserves the exact float values
    // (Float32 truncation lands identically whether at push or here) AND the
    // per-sector append order that setGrassBudget's prefix trim depends on.
    const gMat = new Float32Array(COUNT * 16);
    const gCol = new Float32Array(COUNT * 3);
    const gSec = new Uint8Array(COUNT);
    let gN = 0;
    let secMat: Float32Array[] = [];
    let secCol: Float32Array[] = [];
    const dummy = new THREE.Object3D();
    const up = new THREE.Vector3(0, 1, 0);
    const golden = Math.PI * (3 - Math.sqrt(5));
    const dir = new THREE.Vector3();
    // Sit close to the terrain's own meadow green (0x8cc06e) so the blades
    // blend into the ground instead of stippling dark dots across it.
    const GRASS_DRY = new THREE.Color(0xc6cc80);
    const GRASS_LUSH = new THREE.Color(0x74b25c);
    const bladeColor = new THREE.Color();
    const bladeAccent = new THREE.Color(); // reused per-blade district-accent tint
    // Slot order matters: setGrassBudget trims to a PREFIX of instance slots,
    // and the spiral index sweeps latitude pole→pole (then mirrors), so a raw
    // prefix would strip everything below a latitude line. Visiting spiral
    // indices with a stride coprime to COUNT equidistributes them, so any
    // prefix of slots is a uniform sample of the island.
    const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
    let stride = Math.max(1, Math.round(COUNT * 0.618));
    while (gcd(stride, COUNT) !== 1) stride++;
    // (Collapsed blades used to share a degenerate matrix at the origin; they
    // are now DROPPED entirely — see the chunking note. collapsedColor lives
    // on as a scratch Color for Phase B's setColorAt replay.)
    const collapsedColor = new THREE.Color(1, 1, 1);
    const bladeNormal = new THREE.Vector3(); // reused analytic normal out-param
    const SHORE_Y = Math.sin(0.26);
    for (let k = 0; k < COUNT; k++) {
      const i = (k * stride) % COUNT;
      const y = 1 - (i / (COUNT - 1)) * 2;
      const rAt = Math.sqrt(Math.max(0, 1 - y * y));
      const th = golden * i;
      dir
        .set(
          Math.cos(th) * rAt + (Math.random() - 0.5) * 0.08,
          y + (Math.random() - 0.5) * 0.08,
          Math.sin(th) * rAt + (Math.random() - 0.5) * 0.08,
        )
        .normalize();
      // Island-only world: mirror southern candidates onto the north cap
      // (keeps full grass density on the island, none on the seafloor)
      dir.y = Math.abs(dir.y);
      dir.normalize();
      // CHEAP GATES FIRST (dir-only): a third of the 100k candidates collapse
      // (shore band, streets, summit trail) — skip the surface sample and all
      // colour math for those. DETERMINISM: the skipped work consumed exactly 3
      // Math.random() calls (rotate, colour lerp, shade), which are burned
      // below so the seeded stream — and thus every downstream placement,
      // including the index-networked vehicles — stays bit-identical to the
      // unoptimized loop.
      const belowShore = dir.y < SHORE_Y; // post-mirror latitude, same as before
      // Keep the blades off the summit dirt track so it reads as bare earth.
      const onTrail = this.trailAt ? this.trailAt(dir).w > 0.4 : false;
      const cheapCollapse = belowShore || onTrail || this.isNearStreet(dir);
      if (cheapCollapse) {
        Math.random(); // burn: rotateOnAxis yaw
        Math.random(); // burn: colour lerp jitter
        Math.random(); // burn: per-blade shade
        continue; // DROPPED, not degenerate-written — see chunking note above
      }
      // Analytic, not raycast: at 1.24ms per raycast these blades alone used to
      // cost seconds of phone startup and trip the boot watchdog. The Into
      // variant also skips the wrapper's ~9 Vector3 allocations per call.
      const sampledRadius = this.analyticSurfaceInto(dir, bladeNormal);
      dummy.position.copy(dir).multiplyScalar(sampledRadius);
      dummy.quaternion.setFromUnitVectors(up, bladeNormal);
      dummy.rotateOnAxis(up, Math.random() * Math.PI * 2);
      // Slope gate. Measured: the analytic normal tracks the mesh to ~2.7°
      // on ordinary ground but diverges up to ~50° on the mountain crags,
      // where ~2.9-unit rock detail is finer than the 1.08-unit terrain mesh
      // can represent — so blades there were orienting to a surface that
      // isn't the one you see, and leaning wildly. Lawn doesn't grow on
      // cliffs regardless, so collapse the blade past a slope threshold:
      // correct orientation everywhere it does appear, and none where the
      // normal can't be trusted. (Needs the sample, so it can't join the
      // cheap gates — but it only fires on the mountain, a small band.)
      const slopeCos = bladeNormal.dot(dir);
      const tooSteep = slopeCos < 0.86; // ~31 degrees
      // NB: the ternary's random consumption (none when tooSteep) is the
      // SHIPPED stream contract — do not "simplify" it.
      const sc = tooSteep ? 0.0001 : 0.85 + Math.random() * 0.4;
      dummy.scale.set(sc, sc, sc);
      dummy.updateMatrix();
      // Per-blade colour. A single flat green over thousands of instances is
      // what makes the meadow read as plastic; drifting each blade between a
      // dry yellow-green and a deep shade — biased by elevation so low ground
      // is lusher, and by the same lateral moisture field that tints the
      // terrain so blades match the ground they stand on — gives the field
      // depth for free (still one draw call).
      const lush = 1 - THREE.MathUtils.clamp((dir.y - Math.sin(0.28)) * 2.2, 0, 1);
      const moist = this.moistureAt(dir); // +ve = dry patch (matches terrain pass)
      bladeColor
        .copy(GRASS_DRY)
        .lerp(
          GRASS_LUSH,
          THREE.MathUtils.clamp(lush * 0.75 - moist * 0.35 + Math.random() * 0.5, 0, 1),
        );
      // Real theme: same saturation punch-up as the terrain vertex colors
      // (see the terrain color pass) so blades keep matching their ground.
      if (isRealTheme()) bladeColor.offsetHSL(0, 0.1, 0.01);
      // Per-district accent, HALF the terrain strength (blades are denser + more
      // saturated, so they'd over-read). LERP only — instanceColor MULTIPLIES the
      // vertex color, so a darkening multiply here is the near-black-grass trap.
      const gaw = districtAccentAt(dir, bladeAccent);
      if (gaw > 0) bladeColor.lerp(bladeAccent, gaw * 0.07);
      // subtle per-blade brightness so neighbours never match exactly
      const shade = 0.86 + Math.random() * 0.28;
      bladeColor.multiplyScalar(shade);
      if (tooSteep) continue; // dropped AFTER its randoms are consumed
      // Sector by longitude octant. Append order is the global coprime-stride
      // visitation order restricted to the sector, and a uniform sequence
      // restricted to a region stays uniform over that region — so a PREFIX of
      // each chunk (what setGrassBudget draws) remains a spatially uniform
      // thinning, no per-chunk stride machinery needed.
      const sector = sectorOf(dir);
      gMat.set(dummy.matrix.elements, gN * 16);
      gCol[gN * 3] = bladeColor.r;
      gCol[gN * 3 + 1] = bladeColor.g;
      gCol[gN * 3 + 2] = bladeColor.b;
      gSec[gN] = sector;
      gN++;
    }
    // ── Bucket: staging (visitation order) → exact-size per-sector arrays ──
    const secCount = new Int32Array(SECTORS);
    for (let i = 0; i < gN; i++) secCount[gSec[i]]++;
    for (let s = 0; s < SECTORS; s++) {
      secMat.push(new Float32Array(secCount[s] * 16));
      secCol.push(new Float32Array(secCount[s] * 3));
    }
    const secCur = new Int32Array(SECTORS);
    for (let i = 0; i < gN; i++) {
      const s = gSec[i];
      const c = secCur[s]++;
      secMat[s].set(gMat.subarray(i * 16, i * 16 + 16), c * 16);
      secCol[s][c * 3] = gCol[i * 3];
      secCol[s][c * 3 + 1] = gCol[i * 3 + 1];
      secCol[s][c * 3 + 2] = gCol[i * 3 + 2];
    }
    // ── Phase B: materialize one InstancedMesh per sector ────────────────
    // Clump mode: keep every 8th candidate (deterministic stride — zero RNG).
    // Was every 4th; the tuft got fatter (11 blades) so half as many still
    // cover the ground, and the pair nets ~21% fewer verts overall.
    // The per-sector lists are the coprime-stride visitation order, i.e. a
    // spatially uniform sequence, and a stride of a uniform sequence is still
    // uniform — so both the thinning AND setGrassBudget's prefix trims stay
    // even across the island.
    if (clumpMode) {
      const clMat: Float32Array[] = [];
      const clCol: Float32Array[] = [];
      for (let s = 0; s < SECTORS; s++) {
        const srcM = secMat[s];
        const srcC = secCol[s];
        const n = srcM.length / 16;
        const outN = Math.ceil(n / 8);
        const outM = new Float32Array(outN * 16);
        const outC = new Float32Array(outN * 3);
        let j = 0;
        for (let ci = 0; ci < n; ci += 8) {
          outM.set(srcM.subarray(ci * 16, ci * 16 + 16), j * 16);
          outC[j * 3] = srcC[ci * 3];
          outC[j * 3 + 1] = srcC[ci * 3 + 1];
          outC[j * 3 + 2] = srcC[ci * 3 + 2];
          j++;
        }
        clMat.push(outM);
        clCol.push(outC);
      }
      secMat = clMat;
      secCol = clCol;
    }
    const group = new THREE.Group();
    group.name = 'grass';
    this.grassChunks = [];
    this.grassChunkFullCounts = [];
    let placed = 0;
    for (let s = 0; s < SECTORS; s++) {
      const count = secMat[s].length / 16;
      if (count === 0) continue;
      // Shared geometry + shared material: one shader program, one uniform set
      // (uTime/uPlayerPos ride the material, so wind + push stay planet-wide).
      const chunk = new THREE.InstancedMesh(geo, mat, count);
      chunk.instanceMatrix.array.set(secMat[s]);
      for (let ci = 0; ci < count; ci++) {
        // setColorAt (not a raw buffer write) so the instanceColor attribute is
        // created on EVERY chunk — a chunk without it would compile a second
        // shader program variant.
        chunk.setColorAt(
          ci,
          collapsedColor.setRGB(secCol[s][ci * 3], secCol[s][ci * 3 + 1], secCol[s][ci * 3 + 2]),
        );
      }
      chunk.instanceMatrix.needsUpdate = true;
      if (chunk.instanceColor) chunk.instanceColor.needsUpdate = true;
      chunk.name = `grass_sector_${s}`;
      // Opt out of raycasting (mirrors the sea): the orbit camera's collision
      // ray otherwise brute-forces every instance, and a BLADE crossing the
      // eye-ray yanked the camera toward the player.
      chunk.raycast = () => {};
      chunk.castShadow = false;
      // Coarse tier: DoubleSide blades sampling the shadow map for shadows
      // nobody can see at phone DPR — skip the receive entirely there.
      chunk.receiveShadow = !lowTier;
      (chunk.userData as Record<string, unknown>).ignoreOcclusion = true;
      // Bounding sphere ONCE, at full count, BEFORE any budget trim — three
      // computes it from instance matrices, and a sphere computed against a
      // trimmed count would cull live blades at the chunk edge when the budget
      // recovers. If a sphere ever encloses the planet centre, culling has
      // silently died (the degenerate-slot trap) — asserted by the test suite.
      chunk.computeBoundingSphere();
      group.add(chunk);
      this.grassChunks.push(chunk);
      this.grassChunkFullCounts.push(count);
      placed += count;
    }
    // Live blades, not slots: ~1/3 of candidates collapse, and they no longer
    // occupy GPU instances at all.
    this.grassFullCount = placed;
    return group;
  }

  private createIsland(): THREE.Group {
    // Use a sphere geometry for the island surface so objects placed on the sphere align correctly.
    const seg = Math.round(this.radius * 5.8); // tessellation tracks radius (~1.08u/vertex at ANY size) so the 1.7u summit trail + crags always resolve. A fixed 176 left R50 at 1.79u/vertex — the trail fell BETWEEN vertices and went non-walkable (and mesh-raycast grounding went coarse). Now radius-derived so it never goes stale again.
    const geometry = new THREE.SphereGeometry(this.radius, seg, seg);
    // Displace vertices along their normals to create varied hills and valleys on the sphere surface.
    const vertices = geometry.attributes.position.array as Float32Array;
    const v = new THREE.Vector3();
    const n = new THREE.Vector3(); // scratch normal for the displacement loop

    // Simple Perlin-like noise function for more organic terrain
    const noise3D = (x: number, y: number, z: number, scale: number) => {
      const sx = Math.sin(x * scale) * Math.cos(z * scale);
      const sy = Math.sin(y * scale) * Math.cos(x * scale);
      const sz = Math.sin(z * scale) * Math.cos(y * scale);
      return (sx + sy + sz) / 3;
    };

    // Enhanced multi-octave noise for more natural terrain
    const multiOctaveNoise = (x: number, y: number, z: number, n016: number) => {
      let total = 0;
      let frequency = 1.0;
      let amplitude = 1.0;
      let maxValue = 0;

      // 4 octaves for rich detail
      for (let i = 0; i < 4; i++) {
        // Octave 1 is noise3D(x,y,z, 0.08*2.0) = noise3D(x,y,z, 0.16) — the SAME
        // value coastWarp needs below (0.16 === 0.08*2.0 exactly in f64: same
        // 1.28 mantissa, exponent +1). Take it precomputed instead of evaluating
        // it a second time, saving one noise3D per vertex. Bit-identical: the
        // accumulation order and every other octave are unchanged.
        const nv = i === 1 ? n016 : noise3D(x, y, z, 0.08 * frequency);
        total += nv * amplitude;
        maxValue += amplitude;
        amplitude *= 0.5; // each octave half as strong
        frequency *= 2.0; // each octave double frequency
      }

      return total / maxValue;
    };

    // ── Highland range ────────────────────────────────────────────────────
    // Three overlapping peaks strung along a line, so it reads as a RANGE
    // rather than one cone. Sited at lon ~5.0-5.7 / lat ~0.72-0.82: the widest
    // gap between the district plazas (lon 0, 1.26, 2.51, 3.77) and well
    // inland of the fisherman's shore, the boulevard, and the land race ring
    // (lat 0.38) — so it can't swallow town geometry or block a circuit.
    // `reach` is ANGULAR — on this r=22 sphere 0.3 rad is ~6.6 world units,
    // which produced one swollen dome. Narrow reaches give steep, distinct
    // summits; the spacing (~0.2 rad) still overlaps their skirts enough to
    // read as a connected ridge rather than three isolated cones.
    const PEAKS = [
      // Main craggy summit range (the summit trail climbs the 7.3u peak).
      { dir: this.dirAt(5.12, 0.73), height: 4.6, reach: 0.16 },
      { dir: this.dirAt(5.35, 0.79), height: 7.3, reach: 0.245 }, // main summit — wider base leaves room for both trail and craggy faces
      { dir: this.dirAt(5.58, 0.72), height: 4.2, reach: 0.155 },
      { dir: this.dirAt(4.95, 0.67), height: 2.7, reach: 0.12 }, // foothill toward Contact
      // Rolling foothills spread the highland DOWN-slope into a hilly region.
      // Kept BELOW the summit band (lat ~0.55-0.64) so their boosts don't stack
      // onto the 7.3u peak and flat-top against the terrain clamp; inside the
      // Contact(->4.97)–Professional(5.8->) gap so no town geometry is buried.
      // Terrain collision means the player walks OVER them (no ghost props).
      { dir: this.dirAt(5.05, 0.62), height: 1.6, reach: 0.13 },
      { dir: this.dirAt(5.22, 0.57), height: 1.3, reach: 0.12 },
      { dir: this.dirAt(5.45, 0.59), height: 1.7, reach: 0.13 },
      { dir: this.dirAt(5.66, 0.64), height: 1.5, reach: 0.12 },
      { dir: this.dirAt(5.55, 0.54), height: 1.2, reach: 0.11 },
      { dir: this.dirAt(5.3, 0.54), height: 1.1, reach: 0.11 },
      // Gentle rolling GREEN hills in the OTHER three inter-district gaps, so the
      // whole island reads as hilly rather than one mountain + flat lawn. Low
      // (1.6-2.3u ≈ knee-to-shoulder of the ~1.7u player), in the lat 0.6-0.82
      // upland band (clear of the lat-0.4636 boulevard) and centred in each gap
      // clear of district content: Professional(0)-Projects(1.57),
      // Projects-Personal(3.14), Personal-Contact(4.71). Far below the snow line.
      { dir: this.dirAt(0.85, 0.72), height: 1.7, reach: 0.15 },
      { dir: this.dirAt(1.05, 0.62), height: 1.2, reach: 0.13 },
      { dir: this.dirAt(0.7, 0.79), height: 1.4, reach: 0.14 },
      { dir: this.dirAt(2.2, 0.72), height: 1.7, reach: 0.15 },
      { dir: this.dirAt(2.42, 0.63), height: 1.2, reach: 0.13 },
      { dir: this.dirAt(2.03, 0.8), height: 1.4, reach: 0.14 },
      { dir: this.dirAt(4.0, 0.72), height: 1.7, reach: 0.15 },
      { dir: this.dirAt(4.22, 0.62), height: 1.2, reach: 0.13 },
      { dir: this.dirAt(3.83, 0.8), height: 1.4, reach: 0.14 },
    ];
    // cos(reach) per peak, so highlandAt can reject a vertex with one dot
    // product instead of an acos. Monotonic: acos is decreasing, so
    // `ang >= reach` ⟺ `dot <= cos(reach)`. Boot runs highlandAt for every
    // one of ~338k vertices × ~20 peaks; the vast majority are far from any
    // summit and never needed the acos at all.
    const peakCosReach = PEAKS.map((p) => Math.cos(p.reach));
    const ISLET_COS_REACH = Math.cos(0.1); // acos-gate for the southern islet

    // ── Summit trail ──────────────────────────────────────────────────────
    // A spiral switchback carved up the tallest peak, so the summit is
    // reachable on foot instead of being a wall you slide off. Implemented as
    // terrain, not a decal: within a band around the spiral the crag noise is
    // suppressed and the surface is cut slightly, which produces a genuinely
    // flatter ramp the player's grounding sampler follows for free.
    // Post-mortem of the first attempt, so it isn't repeated: the band was
    // ~1.2 units wide on a mesh with ~1.08 units BETWEEN VERTICES — the
    // terrain could not represent it, so it was invisible and the "ramp"
    // never materialised underfoot. This version works WITH the resolution:
    //   • band ~2.2 units half-width (spans several vertices),
    //   • few turns (1.45) so loop spacing (~3 units) exceeds the band,
    //   • the ramp height is an EXPLICIT monotonic profile of distance-to-
    //     summit — not the peak's falloff curve — so the climb is gentle by
    //     construction,
    //   • reach extends past the flank onto the meadow, so the path begins
    //     on walkable grass instead of materialising mid-cliff.
    const trailPeak = PEAKS[1];
    const trailUp = trailPeak.dir.clone();
    const trailA = new THREE.Vector3(0, 1, 0).cross(trailUp);
    if (trailA.lengthSq() < 1e-8) trailA.set(1, 0, 0);
    trailA.normalize();
    const trailB = new THREE.Vector3().crossVectors(trailUp, trailA).normalize();
    const TRAIL_REACH = 0.3; // rad — starts on the meadow below the flank
    const COS_TRAIL_REACH = Math.cos(TRAIL_REACH); // acos-gate threshold
    // ONE wrap, not several. The hard constraint is mesh resolution: the band
    // must be several units wide for vertices to actually fall in its full
    // core (~1.08u vertex spacing), or the terrain never samples the ramp and
    // stays as steep as the rock. A wide band forces few turns so adjacent
    // loops don't merge into a cone — 1.1 turns gives ~6u loop spacing against
    // a ~3.5u trail width. It's a single helical ramp rather than tight
    // switchbacks, but it's actually walkable, which the switchbacks never were.
    const TRAIL_TURNS = 1.1;
    const _tProj = new THREE.Vector3();
    const trailInfo = { w: 0, t: 1 }; // w: 1 on centreline→0 at edge; t: 0 summit→1 base
    const trailAt = (normal: THREE.Vector3): { w: number; t: number } => {
      const dot = normal.dot(trailUp);
      trailInfo.w = 0;
      trailInfo.t = 1;
      // acos-gate: a vertex clearly below cos(reach) is clearly past the reach
      // angle — skip the acos. The -1e-6 leaves a hair of margin so anything
      // near the boundary still takes the exact acos path below.
      if (dot < COS_TRAIL_REACH - 1e-6) return trailInfo;
      const ang = Math.acos(THREE.MathUtils.clamp(dot, -1, 1));
      if (ang > TRAIL_REACH) return trailInfo;
      trailInfo.t = ang / TRAIL_REACH;
      if (ang < 1e-4) {
        trailInfo.w = 1;
        trailInfo.t = 0;
        return trailInfo; // summit plateau: the loops converge into a landing
      }
      _tProj.copy(normal).addScaledVector(trailUp, -normal.dot(trailUp));
      if (_tProj.lengthSq() < 1e-9) {
        trailInfo.w = 1;
        return trailInfo;
      }
      _tProj.normalize();
      const bearing = Math.atan2(_tProj.dot(trailB), _tProj.dot(trailA));
      const wanted = trailInfo.t * TRAIL_TURNS * Math.PI * 2;
      let d = bearing - wanted;
      d = Math.atan2(Math.sin(d), Math.cos(d)); // wrap to -PI..PI
      // Bearing error → real lateral distance, so the band keeps a constant
      // width instead of fanning out near the base
      const lateral = this.radius * ang * Math.abs(d);
      // Full-strength core out to 1.7u (~3 vertices across, so the mesh can
      // represent the ramp) then a SHARP fade to 2.5u, so the rock returns
      // quickly off the path and the flanks between loops stay craggy instead
      // of the whole peak going smooth.
      trailInfo.w = 1 - THREE.MathUtils.smoothstep(lateral, 1.7, 2.5);
      return trailInfo;
    };
    // Stashed so the colour pass, the grass scatter, and the tree loop can
    // all keep their content aligned with (or off) the path.
    this.trailAt = trailAt;
    this.trailSummitDir = trailUp.clone();
    // Explicit ramp endpoints (radial units above the base sphere). The path
    // interpolates between these as trailT goes base→summit, so the climb is
    // gentle BY CONSTRUCTION rather than inheriting the peak's steep falloff.
    // A landing just under the tip leaves a rim to stand a summit marker on.
    const TRAIL_SUMMIT_H = 0.75 + trailPeak.height * 0.94;
    const TRAIL_BASE_H = 1.0;
    const highlandAt = (normal: THREE.Vector3): number => {
      let boost = 0;
      for (let i = 0; i < PEAKS.length; i++) {
        const p = PEAKS[i];
        // acos-gate: skip peaks this vertex is clearly outside without paying
        // the acos. -1e-6 keeps a margin so boundary vertices fall through to
        // the exact geodesic path below (see peakCosReach).
        const dot = normal.dot(p.dir);
        if (dot < peakCosReach[i] - 1e-6) continue;
        // Angular distance on the sphere, so the falloff is geodesic
        const ang = Math.acos(THREE.MathUtils.clamp(dot, -1, 1));
        if (ang >= p.reach) continue;
        const t = 1 - ang / p.reach;
        // smoothstep² gives a broad shoulder with a sharper summit
        const s = t * t * (3 - 2 * t);
        boost += p.height * s * s;
      }
      return boost;
    };

    /**
     * Terrain radius for a surface direction. Extracted from the displacement
     * loop so the SEA mesh can evaluate the same landscape analytically and
     * bake a per-vertex water depth (raycasting 9k sea vertices would take
     * seconds; this is pure maths). `v` is the direction scaled to the base
     * radius, which is the domain the noise was authored in.
     */
    // Hoisted out of the closure: this runs once per vertex (190k at R=75).
    const reliefScale = this.reliefScale;
    const terrainRadiusFor = (normal: THREE.Vector3, v: THREE.Vector3): number => {
      // Enhanced terrain generation with better geographic features
      // Large-scale continents/mountains using multi-octave noise.
      // n016 is evaluated ONCE and threaded into both the octave sum (octave 1)
      // and coastWarp below — it was computed twice per vertex.
      const n016 = noise3D(v.x, v.y, v.z, 0.16);
      const largeTerrain = multiOctaveNoise(v.x, v.y, v.z, n016) * 3.2;

      // Medium-scale hills and valleys with variation
      const mediumTerrain = noise3D(v.x, v.y, v.z, 0.15) * 1.5;

      // Small-scale rolling hills (halved: was crinkling the surface)
      const smallDetail = noise3D(v.x, v.y, v.z, 0.35) * 0.35;

      // No per-vertex random micro noise: it rendered as crumpled-paper
      // wrinkles across the whole planet from any distance.
      const microNoise = 0;

      // Height-based biomes: create flatter areas at lower elevations (beaches/plateaus)
      const baseHeight = largeTerrain + mediumTerrain;
      const heightFactor = Math.max(0, Math.min(1, (baseHeight + 2) / 4));
      const plateauFactor = 1.0 - Math.pow(Math.abs(heightFactor - 0.3) * 3, 2) * 0.3;

      // Combine layers for natural variation with plateau effect
      const noiseDisp =
        (largeTerrain + mediumTerrain * plateauFactor + smallDetail) * 0.95 + microNoise;

      // ── Continent mask: one proper ISLAND on the north cap, ocean below.
      // sin(latitude) = normal.y. Land above lat ~0.28, seafloor below
      // lat ~0.05, smooth beach slope between. Interior valleys are floored
      // at +0.3 so no inland dip ever sits under the sea surface (+0.08).
      // COASTLINE WARP: a pure latitude threshold makes a perfectly circular
      // island. Displacing the whole shore band in/out by longitude-varying
      // noise carves bays and headlands instead. Two octaves — broad inlets
      // plus finer crenellation. Amplitude is capped (~0.062 in sin-latitude)
      // so the coast can never advance far enough inland to swallow the
      // village, the boulevard, or the land race ring.
      const sinLat = normal.y;
      // noise3D averages three sin*cos products, so its practical range is far
      // narrower than ±1 — the first pass at ±0.062 moved the coast by under
      // 1 world unit, which reads as a circle. These amplitudes are tuned
      // empirically against the measured shoreline spread.
      const coastWarp = n016 * 0.105 + noise3D(v.x, v.y, v.z, 0.42) * 0.05;
      const shoreLo = 0.05 + coastWarp;
      const shoreHi = 0.28 + coastWarp;
      const shoreT = THREE.MathUtils.clamp((sinLat - shoreLo) / (shoreHi - shoreLo), 0, 1);
      const mask = shoreT * shoreT * (3 - 2 * shoreT); // smoothstep
      // Ridged noise on the flanks breaks the smooth dome into crags. Two
      // octaves, and the fine one is pitched near the mesh limit: vertex
      // spacing is 2*PI/5.8 = 1.083u at ANY radius, so features below ~2.5
      // units can't be resolved. The old scale of 0.5 was a ~12.6-unit
      // wavelength — a gentle swell, which is exactly why the peaks read as
      // smooth domes rather than rock.
      const highland = highlandAt(normal);
      // Trail works over its FULL reach — NOT gated behind `highland`. The
      // previous version gated it, so the carve died on the lower flank
      // exactly where the climb begins and the path was never walkable.
      const tr = trailAt(normal);
      const trailW = tr.w;
      let crag = 0;
      // Crag only on the tall SUMMIT range (highland > ~1.8), ramped smoothly
      // from the threshold so there is no seam. The gentle inter-district hills
      // (highland < 1.8) stay SMOOTH rolling grass — craggy bumps there both
      // looked wrong for "gentle" hills AND made analytic-seated props (rocks,
      // grass) float against the bumpier raycast mesh.
      if (highland > 1.8) {
        const ridged = 1 - Math.abs(noise3D(v.x, v.y, v.z, 2.2)); // ~2.9u crags
        const coarse = 1 - Math.abs(noise3D(v.x, v.y, v.z, 0.9)); // ~7u buttresses
        crag = (ridged * 0.62 + coarse * 0.38) * (highland - 1.8) * 0.5;
        crag *= 1 - trailW * 0.98; // the path is smooth rock, not crag
      }
      // Land floor raised 0.3 -> 0.75 so the ocean's crests + tide can't break
      // through the beach.
      const rock = Math.max(noiseDisp, Island.LAND_FLOOR) + highland + crag;
      let landDisp = rock;
      if (trailW > 0.001) {
        // EXPLICIT monotonic ramp: height falls smoothly from a summit landing
        // to the meadow as trailT goes 0->1. Because the spiral's arc length
        // per unit radial angle is long (the switchbacks), a height near-linear
        // in radial angle yields a gentle grade along the actual walk.
        const climb = 1 - tr.t;
        const eased = climb * climb * (3 - 2 * climb); // soften the top/bottom joins
        const rampH = TRAIL_BASE_H + (TRAIL_SUMMIT_H - TRAIL_BASE_H) * eased;
        landDisp = rock * (1 - trailW) + rampH * trailW;
      }
      const oceanDisp = -2.4 + noiseDisp * 0.15; // gently rolling seafloor
      let displacement = oceanDisp + (landDisp - oceanDisp) * mask;

      // ── The ISLET: a second small landmass out in the southern sea.
      // Centre lon 5.9 / lat -0.02 (hardcoded unit dir), reach 0.1 rad
      // (~10u across — several mesh vertices, resolvable). Chosen clear of
      // the lat-0.12 water-race ring (coast tops out at lat ~0.08), the
      // sailor circles, fish schools, watercraft spawns and the fisherman.
      // Influence stays far below sinLat 0.25, so no lat-gated build loop's
      // random draws shift (the seeded-stream stays bit-identical). Same
      // 0.75+ land floor idea as the continent: crown ~+2.1 keeps the beach
      // above waves+tide.
      {
        // acos-gate: the islet reaches only 0.1 rad, so almost every vertex is
        // outside it. Compare the dot against cos(0.1) first (+1e-6 margin) and
        // skip the acos entirely for the ~99% that can't be within reach.
        const c = THREE.MathUtils.clamp(
          normal.x * 0.92728 - normal.y * 0.02 - normal.z * 0.3738,
          -1,
          1,
        );
        if (c > ISLET_COS_REACH - 1e-6) {
          const ig = Math.acos(c);
          if (ig < 0.1) {
            const it = THREE.MathUtils.clamp((0.1 - ig) / 0.055, 0, 1);
            const im = it * it * (3 - 2 * it); // smoothstep dome
            // Gentle dome + a pinch of the shared noise so it isn't a cap.
            const isletLand = 0.85 + im * (1.05 + Math.max(0, noiseDisp) * 0.35);
            displacement = Math.max(displacement, oceanDisp + (isletLand - oceanDisp) * im);
          }
        }
      }

      // Clamp radius to prevent terrain from going inside the sphere
      const rawRadius = this.radius + displacement * reliefScale;
      const minRadius = this.radius * 0.86; // deep enough for the seafloor
      // Headroom for the highland range (base floor 0.75 + peak 3.3 + crag
      // ~1.65). At +4.2 the peaks clipped flat into a pale mesa. Keep this
      // BELOW the sampler's maxDisp or raycasts start inside the summits.
      // Headroom for the taller range: main peak 7.3 + floor 0.75 + crag ~0.8
      // ≈ 8.85. Kept below the sampler's ray start (radius + maxDisp 11), or
      // raycasts begin inside the summit and miss it.
      const maxRadius = this.maxTerrainRadius();
      return THREE.MathUtils.clamp(rawRadius, minRadius, maxRadius);
    };
    this.terrainRadiusFor = terrainRadiusFor;

    for (let i = 0; i < vertices.length; i += 3) {
      v.set(vertices[i], vertices[i + 1], vertices[i + 2]);
      // Reuse one scratch normal instead of v.clone() per vertex — ~337k boot
      // allocations gone (R²-scaling). Vector3 has no uuid, so no Math.random
      // draw is consumed: the tierParity golden census stays bit-identical.
      n.copy(v).normalize();
      const R = terrainRadiusFor(n, v);
      vertices[i] = n.x * R;
      vertices[i + 1] = n.y * R;
      vertices[i + 2] = n.z * R;
    }
    geometry.attributes.position.needsUpdate = true;
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere(); // Ensure proper bounding sphere for raycasting

    // Elevation-tinted vertex colors: valleys richer/darker, meadows mid,
    // ridges drier/lighter — the flat monotone read as plastic. A small
    // deterministic per-vertex jitter breaks banding without wrinkle noise.
    {
      // Three signals, not one. Elevation alone (the old version) normalised
      // across the WHOLE sphere — seabed to peak — so the island's actual
      // surface occupied a narrow slice of the ramp and read as flat monotone.
      // Now: elevation is measured ABOVE SEA LEVEL (so the land uses the full
      // ramp), SLOPE exposes rock on steep ground, and a SAND band wraps the
      // shoreline so the coast reads as a beach instead of grass meeting water.
      const posA = geometry.attributes.position;
      const nrmA = geometry.attributes.normal;
      const colors = new Float32Array(posA.count * 3);
      const seabed = new THREE.Color(0x4a6b74);
      const sand = new THREE.Color(0xd8cca0);
      const lowValley = new THREE.Color(0x5a8a45);
      const valley = new THREE.Color(0x6f9c58);
      const meadow = new THREE.Color(0x8cc06e);
      const ridge = new THREE.Color(0xb5c98a);
      const peak = new THREE.Color(0xc8cca0);
      const rock = new THREE.Color(0x8d8878);
      const snow = new THREE.Color(0xf2f6fa);
      const dirt = new THREE.Color(0x9a7550); // the worn summit path
      // Lateral moisture targets — sun-dried and rain-shadow patches that
      // break the concentric elevation bands (greens only; sand/snow untouched)
      const dryMeadow = new THREE.Color(0xaeb767);
      const lushMeadow = new THREE.Color(0x5f9e52);
      const tmp = new THREE.Color();
      const accentScratch = new THREE.Color(); // reused per-vertex district-accent tint
      const vDir = new THREE.Vector3();
      const vNrm = new THREE.Vector3();
      const sea = this.seaLevel();
      // Self-tuning bands. Hard-coded heights are a trap here: this island is
      // far flatter than it looks — land spans only ~0.2-1.0 units above sea
      // (median ~0.3) — so a "0.3 beach" silently painted half the island as
      // sand. Derive the ramp from the ACTUAL distribution instead, using the
      // 95th percentile so one freak peak can't stretch it.
      const aboveList: number[] = [];
      for (let i = 0; i < posA.count; i++) {
        const a = Math.hypot(posA.getX(i), posA.getY(i), posA.getZ(i)) - sea;
        if (a > 0) aboveList.push(a);
      }
      aboveList.sort((a, b) => a - b);
      const landTop = aboveList.length
        ? Math.max(0.25, aboveList[Math.floor(aboveList.length * 0.95)])
        : 1;
      const BEACH_TOP = landTop * 0.2; // sand hugs the waterline only
      const BEACH_FADE = landTop * 0.18;
      const landSpan = Math.max(1e-6, landTop - BEACH_TOP);
      // Snow line, also self-tuning: high enough above the ordinary ground
      // (p95) that rolling hills never whiten, but low enough to cap the
      // highland range. With no range present it lands above the tallest
      // vertex, so no snow appears at all.
      const maxAbove = aboveList.length ? aboveList[aboveList.length - 1] : 1;
      // Snow only on the summit range, not the foothills — with the highland
      // now a rolling hilly region (foothills ~3-4.6u under a ~7.6u summit),
      // the old 0.42 factor snowed the whole massif white. 0.65 keeps the
      // foothills GREEN and caps just the top ~2.5u in snow.
      const snowLine = Math.max(landTop * 1.55, maxAbove * 0.8);
      for (let i = 0; i < posA.count; i++) {
        vDir.set(posA.getX(i), posA.getY(i), posA.getZ(i));
        const r = vDir.length() || 1;
        vDir.divideScalar(r);
        vNrm.set(nrmA.getX(i), nrmA.getY(i), nrmA.getZ(i));
        // 0 where the ground faces straight out, →1 on a cliff face
        const slope = THREE.MathUtils.clamp(1 - vNrm.dot(vDir), 0, 1);
        const above = r - sea;

        if (above < -0.3) {
          // Submerged: fades from sand at the water's edge down to seabed
          // Sand→seabed gradient re-authored for the deeper column: it used
          // to complete by 2.4u, so everything below that was ONE flat tone
          // across the whole floor. /4.6 spreads it over the real depth.
          tmp.copy(seabed).lerp(sand, THREE.MathUtils.clamp((above + 4.6) / 4.3, 0, 1));
          // Seabed dapple (underwater slice): broad light/dark patches so the
          // floor isn't one flat tone. Deterministic from direction — no RNG,
          // one-time CPU like the rest of this color pass.
          const dap =
            Math.sin(vDir.x * 41.0) * Math.sin(vDir.z * 37.0) +
            0.5 * Math.sin((vDir.x + vDir.z) * 23.0);
          tmp.offsetHSL(0, 0, dap * 0.028);
        } else if (above < BEACH_TOP) {
          tmp.copy(sand);
        } else {
          const t = THREE.MathUtils.clamp((above - BEACH_TOP) / landSpan, 0, 1);
          // Weighted toward the greens: most of the island should be meadow,
          // with the pale ridge/peak tones reserved for the genuine high ground.
          if (t < 0.25) tmp.copy(lowValley).lerp(valley, t / 0.25);
          else if (t < 0.62) tmp.copy(valley).lerp(meadow, (t - 0.25) / 0.37);
          else if (t < 0.86) tmp.copy(meadow).lerp(ridge, (t - 0.62) / 0.24);
          else tmp.copy(ridge).lerp(peak, (t - 0.86) / 0.14);
          // Lateral moisture drift: elevation-only bands read as a contour
          // map. Fades out toward the high ground so ridge/peak keep their
          // pale tones. One-time CPU, shared with the grass tint (moistureAt).
          const moist = this.moistureAt(vDir) * (1 - THREE.MathUtils.clamp(t, 0, 1) * 0.7);
          if (moist > 0) tmp.lerp(dryMeadow, Math.min(moist * 1.4, 0.5));
          else tmp.lerp(lushMeadow, Math.min(-moist * 1.2, 0.4));
          // Per-district pastoral accent: nudge the meadow near each plaza toward
          // the district's accent (Professional cooler, Personal warmer/pink, …).
          // Low-strength LERP (never multiply) that fades out with altitude, so
          // only the low grassy land carries district identity — ridge/peak/rock
          // keep their neutral tones. `districtAccentAt` returns 0 between plazas.
          const aw =
            districtAccentAt(vDir, accentScratch) * (1 - THREE.MathUtils.clamp(t, 0, 1) * 0.5);
          if (aw > 0) tmp.lerp(accentScratch, aw * 0.14);
          // Feather the sand upward so the beach doesn't end on a hard line
          const beachFade = THREE.MathUtils.clamp((above - BEACH_TOP) / BEACH_FADE, 0, 1);
          tmp.lerp(sand, (1 - beachFade) * 0.6);
        }
        // Rock breaks through only where the ground is genuinely steep. A low
        // threshold catches every ordinary hill and greys out the meadows.
        tmp.lerp(rock, THREE.MathUtils.smoothstep(slope, 0.26, 0.62) * 0.65);

        // Snow line on the highland peaks. Gated on elevation AND flatness so
        // it settles on summits and shelves but not on sheer rock faces.
        if (above > snowLine) {
          const alt = THREE.MathUtils.clamp(
            (above - snowLine) / Math.max(0.4, snowLine * 0.45),
            0,
            1,
          );
          const settles = 1 - THREE.MathUtils.smoothstep(slope, 0.42, 0.85);
          tmp.lerp(snow, alt * (0.45 + 0.55 * settles));
        }

        // Dirt path: tint the summit trail so the switchback reads as a worn
        // track cut through the rock and snow. Drawn AFTER snow so the path
        // stays bare earth even up in the snowfield.
        const tw = this.trailAt(vDir).w;
        if (tw > 0.01) tmp.lerp(dirt, tw * 0.9);

        // Real theme: vertex colors bypass the material grade in GameScene
        // (material.color is white here), so the saturation punch-up that
        // keeps the candy palette under continuous PBR shading lands at
        // color-build time instead. One-time CPU.
        if (isRealTheme()) tmp.offsetHSL(0, 0.12, 0.01);

        // deterministic jitter from vertex index (no Math.random -> stable)
        const j = 1 + (((i * 2654435761) % 1000) / 1000 - 0.5) * 0.09;
        colors[i * 3] = tmp.r * j;
        colors[i * 3 + 1] = tmp.g * j;
        colors[i * 3 + 2] = tmp.b * j;
      }
      geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    }
    // Use authored grass textures from the Stylized Nature kit to ground the island in the intended art direction
    // No tiling texture: Grass.png repeated 6x around the sphere and its dark
    // tile edges rendered as six meridian stripes converging in ugly pinwheels
    // at BOTH poles. Clean flat color suits the low-poly look and kills the
    // artifact entirely.
    const material = Materials.createPBRMaterial({
      color: 0xffffff, // tint comes from elevation vertex colors
      roughness: 0.85,
      metalness: 0.0,
      envMapIntensity: 0.5,
    });
    material.vertexColors = true;
    // ── Wet-sand band + swash line (LAND half of the beach interface) ─────
    // The sea shader draws the foam collar on the water; this tints the sand:
    // a thin white swash line at the waterline and a darker damp band up the
    // beach. Pure fragment maths keyed on object-space |position| (the island
    // group sits at the origin, so that IS the terrain radius the colour pass
    // used) vs the tide-following waterline. Shares seaTideUniform BY
    // REFERENCE — no per-frame writes, no extra mesh, no raycasts. It is
    // deliberately tide-only (no wave term): duplicating the wave sum here
    // would create a third copy of the math the waveMirror parity test does
    // not pin, free to drift. Chunks targeted (<common>, <begin_vertex>,
    // <color_fragment>) exist in BOTH MeshStandardMaterial (?theme=real) and
    // the MeshToonMaterial swap-in (toonifyIslandMaterials carries this over).
    const shoreWaterline = this.seaLevel().toFixed(4);
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uTide = this.seaTideUniform;
      // Caustic clock: the SAME object as the sea shader's uTime — shared by
      // reference, so the flicker stays phase-locked to the waves for free.
      shader.uniforms.uSeaT = this.seaTimeUniform;
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          '#include <common>\nvarying float vShoreR;\nvarying vec3 vShoreP;',
        )
        .replace(
          '#include <begin_vertex>',
          '#include <begin_vertex>\nvShoreR = length(position);\nvShoreP = position;',
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          '#include <common>\nvarying float vShoreR;\nvarying vec3 vShoreP;\nuniform float uTide;\nuniform float uSeaT;',
        )
        .replace(
          '#include <color_fragment>',
          [
            '#include <color_fragment>',
            `float shoreAbove = vShoreR - (${shoreWaterline} + uTide);`,
            // Damp sand: darkens from the waterline up ~0.45u, gone well before
            // the grass line so meadows never read soggy.
            'float wet = smoothstep(-0.35, 0.0, shoreAbove) * (1.0 - smoothstep(0.08, 0.45, shoreAbove));',
            'diffuseColor.rgb *= 1.0 - wet * 0.22;',
            // Swash line: a thin bright rim right where water meets sand.
            'float swash = 1.0 - smoothstep(0.0, 0.16, abs(shoreAbove - 0.03));',
            'diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.94, 0.97, 0.99), swash * 0.55);',
            // Caustics (underwater slice): two drifting sine sheets, alive only
            // below the waterline and gone by ~2.5u depth. Cell size ~3u.
            'float caust = sin(vShoreP.x * 2.1 + vShoreP.y * 1.3 + uSeaT * 1.1) * sin(vShoreP.z * 2.3 - uSeaT * 0.9);',
            'float cOn = 1.0 - smoothstep(-0.5, -0.15, shoreAbove);',
            // Falloff re-authored for the R=100 water column. The ocean floor
            // sits 5.0u down now (it was 3.75u at R=75 — the displacement is
            // radius-scaled), but this gate still died at 2.5u, so the deeper
            // HALF of the sea was flat unlit colour. Reaching -5.2 keeps light
            // playing all the way to the floor. Shader-only: no draws, no RNG.
            'float cDeep = smoothstep(-5.2, -1.6, shoreAbove);',
            'diffuseColor.rgb += vec3(0.10, 0.14, 0.13) * max(0.0, caust) * cOn * cDeep;',
          ].join('\n'),
        );
    };

    const mesh = new THREE.Mesh(geometry, material);
    // keep a direct reference to the terrain mesh for raycasting / accurate placement
    this.surfaceMesh = mesh;
    // Build the BVH now that the terrain vertices are fully displaced. Every
    // sampleSurfaceByDirection raycast against this mesh then uses it.
    mesh.geometry.computeBoundsTree();
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    mesh.position.copy(this.center);

    // ── Sea: a translucent water sphere just above the base radius. The
    // continent mask sinks all terrain south of the shoreline below this,
    // so the north-cap island stands alone in open ocean. Transparent, so
    // toonify skips it and it keeps its glossy PBR water look. It is a
    // separate mesh from surfaceMesh, so terrain sampling (raycasts
    // surfaceMesh only) and colliders never see it.
    const seaMat = new THREE.MeshStandardMaterial({
      // Deeper + more chroma than the old 0x1f6a9c: ACES lifts and desaturates,
      // and the noon-sky fresnel/haze used to wash the flat base milky. The
      // depth gradient in the fragment pass keys off this base.
      color: 0x176ba8,
      // Was 0.84 — too see-through, the dark seafloor showed through and read
      // as murky glass. 0.92 kills the x-ray look while still letting fish
      // near the surface glimmer through faintly.
      transparent: true,
      opacity: 0.92,
      // Slightly rougher than a mirror: with the wave normals now perturbed,
      // 0.18 made the crests catch the sun as hard laser streaks. 0.3 spreads
      // each glint into something that reads as water.
      roughness: 0.3,
      metalness: 0.12,
    });
    // Animated waves: displace each vertex radially by the SAME sum-of-sines
    // the CPU sampler (waveHeightAt) uses, so swimmers/boats bob in lockstep
    // with the visible surface. Crest foam lightens the colour.
    seaMat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = this.seaTimeUniform;
      shader.uniforms.uAmp = { value: Island.WAVE_AMP };
      shader.uniforms.uTide = this.seaTideUniform;
      shader.uniforms.uSkyHorizon = this.seaSkyHorizonUniform;
      shader.uniforms.uBands = this.seaBandsUniform;
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          '#include <common>\nuniform float uTime;\nuniform float uAmp;\nuniform float uTide;\nvarying float vWave;\nvarying vec2 vFoamUv;',
        )
        // Tilt the NORMAL to match the wave slope. Without this the shader
        // displaces geometry but lights it as a smooth sphere, so the ocean
        // slides around without ever shading like water — the single biggest
        // reason it read as "moving but flat". Uses the analytic gradient of
        // the same sum-of-sines, projected onto the tangent plane.
        .replace(
          '#include <beginnormal_vertex>',
          [
            '#include <beginnormal_vertex>',
            'vec3 wn = normalize(position);',
            'float dwx = 0.6*9.0*cos(wn.x*9.0 + uTime*1.3)',
            '          + 0.5*7.0*cos((wn.x+wn.z)*7.0 + uTime*0.9)',
            '          + 0.18*23.0*cos((wn.x-wn.z)*23.0 + uTime*2.1);',
            'float dwz = 0.4*11.0*cos(wn.z*11.0 - uTime*1.1)',
            '          + 0.5*7.0*cos((wn.x+wn.z)*7.0 + uTime*0.9)',
            '          - 0.18*23.0*cos((wn.x-wn.z)*23.0 + uTime*2.1);',
            'float dwy = 0.12*19.0*cos(wn.y*19.0 + uTime*1.7);',
            'vec3 wgrad = vec3(dwx, dwy, dwz);',
            'wgrad -= wn * dot(wgrad, wn);',
            'objectNormal = normalize(objectNormal - wgrad * uAmp * 0.32);',
          ].join('\n'),
        )
        .replace(
          '#include <begin_vertex>',
          [
            '#include <begin_vertex>',
            'vec3 nrm = normalize(position);',
            // Swell (3 broad terms) + chop (2 fine, faster terms). The chop is
            // what actually makes waves READ as waves — broad swell alone on a
            // planet-sized sphere just looks like a smooth moving surface.
            // MUST stay identical to waveHeightAt() on the CPU or boats and
            // swimmers float off the surface you can see.
            'float w = sin(nrm.x * 9.0 + uTime * 1.3) * 0.6',
            '       + sin(nrm.z * 11.0 - uTime * 1.1) * 0.4',
            '       + sin((nrm.x + nrm.z) * 7.0 + uTime * 0.9) * 0.5',
            '       + sin((nrm.x - nrm.z) * 23.0 + uTime * 2.1) * 0.18',
            '       + sin(nrm.y * 19.0 + uTime * 1.7) * 0.12;',
            'vWave = w;',
            // Lateral anchor for the foam hash — breaks the concentric rings
            'vFoamUv = nrm.xz;',
            // uTide raises/lowers the whole surface far more slowly than the
            // waves, so the waterline creeps up and down the beach.
            'transformed += nrm * (w * uAmp + uTide);',
            'vDepth = aDepth;',
          ].join('\n'),
        );
      shader.vertexShader = shader.vertexShader.replace(
        'uniform float uTide;',
        'uniform float uTide;\nattribute float aDepth;\nvarying float vDepth;',
      );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          '#include <common>\nvarying float vWave;\nvarying float vDepth;\nvarying vec2 vFoamUv;\nuniform float uTime;\nuniform float uTide;\nuniform vec3 uBands;\nuniform vec3 uSkyHorizon;',
        )
        .replace(
          '#include <color_fragment>',
          [
            '#include <color_fragment>',
            // ── Radial depth gradient ─────────────────────────────────────
            // aDepth (baked sea-surface minus analytic terrain) is already on
            // every vertex, so a shore→ocean colour ramp is free. Open ocean
            // bottoms out at d≈2.5*reliefScale (3.75 at R=75; depth values
            // scale with relief but the shore band widens by the same factor,
            // so depth-per-metre at the waterline is unchanged), so the
            // ramp keys 0.5→2.3: near-shore water keeps the turquoise below,
            // offshore saturates to deep azure instead of one flat milky tone.
            // GLSL literals are LINEAR-space like every colour in this block.
            'float d = vDepth - uTide;',
            'diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.006, 0.105, 0.32), smoothstep(0.5, 2.3, d) * 0.6);',
            // Deepen the wave troughs toward a dark teal for a sense of depth
            'diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.03,0.11,0.20), smoothstep(0.0,-1.4,vWave)*0.45);',
            // Whitecaps. Thresholds re-tuned for the new 1.8 wave peak; a
            // narrow band keeps foam on the crest tips instead of washing the
            // whole surface pale.
            'diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.88,0.95,1.0), smoothstep(0.5,1.25,vWave)*0.85);',
            // ── Shoreline surf ────────────────────────────────────────────
            // vDepth is the baked water depth (sea surface minus terrain), so
            // "how close to shore" is known per-vertex without any raycasting.
            // Shallows turn turquoise, then three offset bands of foam sweep
            // shoreward at different speeds — the layering is what sells it as
            // surf rather than a single pulsing ring. The tide shifts the
            // effective depth, so the whole surf line advances and retreats
            // with the water.
            // Ranges are generous because the shallowest water is HIDDEN under
            // the beach — only the depth beyond the visible waterline renders,
            // so a tight band collapses to a hairline.
            // Shallow turquoise tightened 5.0→2.4 (d is declared at the top of
            // this block now): at the old range the open ocean (d≈2.5) still
            // carried ~0.16 of this tint — a big part of the milky noon look.
            // It now dies exactly where the depth gradient takes over.
            'float shallow = 1.0 - smoothstep(0.0, uBands.y, d);',
            'diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.20,0.70,0.72), shallow*shallow*0.7);',
            'float edge = 1.0 - smoothstep(0.0, uBands.z, d);',
            'float s1 = sin(d * 2.6 - uTime * 1.9);',
            'float s2 = sin(d * 4.3 - uTime * 2.7 + 1.7);',
            'float s3 = sin(d * 1.5 - uTime * 1.2 + 3.4);',
            'float surf = max(max(s1, s2 * 0.85), s3 * 0.7);',
            // Hash noise in the foam threshold: the three terms are pure sines
            // of depth, so without it the surf is geometrically perfect
            // concentric rings. Coarse cells (38) keep it from shimmering at
            // phone DPR.
            'float fn = fract(sin(dot(floor(vFoamUv * 38.0), vec2(12.9898, 78.233))) * 43758.5453);',
            'float foam = edge * smoothstep(0.2, 0.9, surf + (fn - 0.5) * 0.45);',
            // Permanent foam collar at the waterline, under the moving surf.
            // The shallowest sea verts hide UNDER the beach, so the visible rim
            // sits at d≈0.2–0.8 — the old 0.9 range faded to nothing exactly
            // there and no line survived. 1.6 keeps an unbroken white edge.
            'foam = max(foam, (1.0 - smoothstep(0.05, uBands.x, d)) * 0.9);',
            'diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.95,0.98,1.0), clamp(foam, 0.0, 1.0) * 0.9);',
          ].join('\n'),
        )
        // Crest sparkle: tighten the specular lobe on wave tips so the sun
        // glints off crests. COLOR-side only — displacement math untouched.
        .replace(
          '#include <roughnessmap_fragment>',
          [
            '#include <roughnessmap_fragment>',
            'roughnessFactor = mix(roughnessFactor, 0.14, smoothstep(0.6, 1.3, vWave));',
          ].join('\n'),
        )
        // Fresnel sky reflection: under the toon theme no envmap exists, so
        // fake the sky bounce analytically. Under ?theme=real the scene HAS a
        // PMREM environment giving the standard-material sea true reflections —
        // the analytic colour mix would double-dip, so only the grazing-angle
        // opacity part is kept there.
        .replace(
          '#include <opaque_fragment>',
          [
            'float fres = pow(1.0 - clamp(dot(normalize(vViewPosition), normal), 0.0, 1.0), 3.0);',
            isRealTheme()
              ? '// real theme: envmap supplies the sky reflection'
              : 'outgoingLight = mix(outgoingLight, uSkyHorizon, fres * 0.4);',
            // Horizon haze: dissolve the distant sea into the LIVE sky-horizon
            // colour so the water no longer meets the sky as a hard line — the
            // single biggest "sells a world, not an object on a table" cue.
            // Distance-keyed so near water stays saturated. Applies to both themes.
            // Pushed out (20→30) and nearly halved (0.75→0.45): the old ramp
            // had most visible water 40-75% sky colour at typical camera
            // heights (sea limb ≈ 24-30u away) — the sea *became* the sky
            // instead of meeting it. Scene FogExp2 (density 0.009, colour =
            // live horizon) still supplies the soft far blend, so this now
            // just feathers the last band and the horizon reads as a LINE
            // with colour depth behind it. Applies to both themes.
            'float horizonHaze = smoothstep(30.0, 64.0, length(vViewPosition));',
            'outgoingLight = mix(outgoingLight, uSkyHorizon, horizonHaze * 0.45);',
            'diffuseColor.a = mix(0.85, 0.97, fres);',
            '#include <opaque_fragment>',
          ].join('\n'),
        );
    };
    // Bake water depth per sea vertex from the analytic terrain height — the
    // shoreline foam and shallow tint key off this. One-time maths, no raycasts.
    // Coarse tier gets 64 segments instead of 96 — pure tessellation (~19k vs
    // ~55k tris of per-frame wave displacement); the wave MATH is untouched,
    // so the CPU waveHeightAt mirror stays exact.
    // Tessellation is tracked to the radius for the same reason the terrain's is:
    // the foam/shallow bands baked into aDepth are WORLD-METRE features, so a
    // fixed segment count makes each sea face span more world as the planet grows
    // and the shoreline collar goes blocky. The wave MATH is untouched either way,
    // so the CPU waveHeightAt mirror stays exact.
    const seaSegs = Math.round(
      (SimpleRenderer.isLowTierDevice() ? 80 : 120) * (this.radius / Island.REFERENCE_RADIUS),
    );
    // Built AT seaLevel() rather than re-deriving it, so what you SEE and what
    // boats RIDE cannot drift apart (test/islandRadius.test.ts pins this).
    const seaGeo = new THREE.SphereGeometry(this.seaLevel(), seaSegs, seaSegs);
    {
      const sp = seaGeo.attributes.position;
      const depth = new Float32Array(sp.count);
      const sn = new THREE.Vector3();
      const sv = new THREE.Vector3();
      const seaR = this.seaLevel();
      for (let i = 0; i < sp.count; i++) {
        sn.set(sp.getX(i), sp.getY(i), sp.getZ(i)).normalize();
        sv.copy(sn).multiplyScalar(this.radius); // noise domain = base radius
        depth[i] = seaR - this.terrainRadiusFor(sn, sv);
      }
      seaGeo.setAttribute('aDepth', new THREE.BufferAttribute(depth, 1));
    }
    // Solve the surf-band depths for THIS radius, once, right after the depth
    // attribute exists. Without this the bands stay at their authored R=75
    // depths and the visible surf zone compresses as the shelf steepens.
    this.seaBandsUniform.value.copy(this.calibrateSurfBands());
    const sea = new THREE.Mesh(seaGeo, seaMat);
    sea.name = 'sea';
    // NOT receiveShadow: it compiles USE_SHADOWMAP into the ocean fragment
    // shader, so every fragment of the largest, most fill-heavy surface runs a
    // PCF shadow-map fetch — and land casters sit above sea level, shadowing the
    // LAND, not open water. Dropping it is a direct fill-rate win (biggest on
    // DPR-capped, fragment-bound phones). Trade-off: a boat/coastal swimmer no
    // longer casts its (barely-visible) shadow onto the water.
    sea.receiveShadow = false;
    sea.position.copy(this.center);
    // Keep the sea out of ALL raycasts: the camera-collision ray must not
    // catch the water sphere (it would jam the chase cam at the waterline),
    // and terrain sampling already targets surfaceMesh only.
    sea.raycast = () => {};

    // Create a conforming 'road' ring made of many small segments that sit on the sphere surface.
    // ── Street network ──────────────────────────────────────────────────
    // A planned city needs streets before lots: the BOULEVARD is a ring
    // through all four district plazas (lat 0.4636); each district also
    // gets an AVENUE from the Welcome pole down through its plaza and a
    // CONNECTOR down to the COASTAL ROAD — a beachfront ring at lat 0.28
    // (worst-case terrain there is +0.2 above sea; 0.24 dipped underwater
    // in places) replacing the old equator country road, which is open
    // ocean now that the island occupies the north cap.
    const pathGroup = new THREE.Group();
    pathGroup.name = 'street_network';
    // Artery centrelines (avenues + connectors), collected as they are built
    // and consumed by the lamp pass — see the push below createStreetPath.
    const arteryLines: THREE.Vector3[][] = [];
    // Districts are evenly spaced on the cardinal points now (Districts.ts is the
    // single source of truth, shared with the zone markers + minimap). Each
    // district's hand-authored site arrays below add SHIFT_* so the buildings and
    // crowds move WITH their plaza + avenue under the respacing.
    const DISTRICT_LONS = RING_DISTRICT_LONS;
    const SHIFT_PROJECTS = DISTRICT_SHIFT[1];
    const SHIFT_PERSONAL = DISTRICT_SHIFT[2];
    const SHIFT_CONTACT = DISTRICT_SHIFT[3];
    const boulevardPts: THREE.Vector3[] = [];
    // Radius-tracked: segment MIDPOINTS must stay closer together than the
    // keepOutArc used when scattering props (see createStreetPath's caller), or
    // trees and rocks seed straight through the road between samples. A fixed 84
    // spaces midpoints 3.35u at R=50 but 5.02u at R=75, which clears the 1.9u
    // floor and lets the scatter in. Also keeps the rigid PlaneGeometry chords
    // short enough not to clip through curving terrain.
    const BOULEVARD_SEGS = Math.round(84 * (this.radius / Island.REFERENCE_RADIUS));
    for (let i = 0; i <= BOULEVARD_SEGS; i++) {
      boulevardPts.push(this.dirAt((i / BOULEVARD_SEGS) * Math.PI * 2, 0.4636));
    }
    pathGroup.add(this.createStreetPath(boulevardPts, 1.7));
    const coastalPts: THREE.Vector3[] = [];
    for (let i = 0; i <= BOULEVARD_SEGS; i++) {
      coastalPts.push(this.dirAt((i / BOULEVARD_SEGS) * Math.PI * 2, 0.28));
    }
    pathGroup.add(this.createStreetPath(coastalPts, 1.3));
    for (const dLon of DISTRICT_LONS) {
      // Avenue: pole plaza → district plaza
      const avenue: THREE.Vector3[] = [];
      // Start at 4.2u from the pole (≈ the enlarged plaza rim) so pavement
      // meets the plaza — the old 1.32 start left a 9u strip of bare grass
      // between plaza edge and avenue that the spawn sat in the middle of.
      const aStart = Math.PI / 2 - 4.2 / this.radius;
      for (let s = 0; s <= 12; s++)
        avenue.push(this.dirAt(dLon, aStart - (s / 12) * (aStart - 0.5)));
      pathGroup.add(this.createStreetPath(avenue, 1.5));
      // Connector: district plaza → coastal road
      const connector: THREE.Vector3[] = [];
      for (let s = 0; s <= 5; s++) connector.push(this.dirAt(dLon, 0.43 - (s / 5) * 0.15));
      pathGroup.add(this.createStreetPath(connector, 1.3));
      // Keep the ARTERY centrelines: the lamp pass below lights these, and
      // measurement is why — against 5238 samples of the street network, 48.8%
      // sat >12u from any lamp, and effectively all of it was here. The
      // boulevard carries 40 of the 57 lamps but is only ~34% of the road
      // length; the pole↔district avenues and their connectors had ZERO.
      // The coastal ring is deliberately NOT collected — the shore stays dark
      // on purpose (see the LAMP_INFILL note), which is the contrast Abbas
      // asked to keep.
      arteryLines.push(
        avenue.map((v) => v.clone()),
        connector.map((v) => v.clone()),
      );
    }
    this.mergeStreetNetwork(pathGroup);

    // ── Urban planning ──────────────────────────────────────────────────
    // Each content zone anchors a district spread around the sphere (the
    // zone plazas sit at lat ~0.4636 = atan(0.5), Welcome at the pole):
    //   Professional (lon 0)      → office towers, statue, parked cars
    //   Projects     (lon 1.2566) → construction/work sites
    //   Personal     (lon 2.5133) → cottage village, fountain square
    //   Contact      (lon 3.7699) → market stalls
    //   Welcome      (north pole) → spawn plaza, benches, flowers
    // Pre-claim the plaza sites so no props squat on the zone markers.
    // ZONE_LAT is imported from Districts.ts (shared). Pre-claim each plaza + pole.
    for (const dLon of DISTRICT_LONS) this.claimDir(this.dirAt(dLon, ZONE_LAT), this.arc(6.5));
    this.claimDir(new THREE.Vector3(0, 1, 0), this.arc(6.5));
    // Reserve the coastal lighthouse footprint so trees/props keep clear of it.
    this.claimDir(this.dirAt(5.4, 0.34), this.arc(15));

    // Add a few low-poly buildings aligned to the surface (placeholders). We'll attempt to replace them with GLTF models if present.
    const buildings = new THREE.Group();
    // generate procedural building textures and use them for PBR-like facades
    const buildingTex = TextureGenerator.createBuildingTextures(512, 512);
    const buildingMat = Materials.createPBRMaterial({
      color: 0xffffff, // WHITE: the albedo map carries the slate facade color.
      // 0xd9c6b3 here MULTIPLIED the same-toned brick map (the near-black-grass
      // class of bug) — with the toon shadow ramp on top, tower faces crushed
      // to a black void at noon.
      map: buildingTex.albedo,
      normalMap: buildingTex.normal,
      roughnessMap: buildingTex.roughness,
      aoMap: buildingTex.ao,
      roughness: 0.65,
      metalness: 0.02,
    });
    const buildingPlaceholders: THREE.Mesh[] = [];
    const buildingSamples: { position: THREE.Vector3; normal: THREE.Vector3 }[] = [];
    // Emissive office-window grids for the CBD towers — they were unlit black
    // slabs at night while every cottage window glowed. ONE shared material +
    // plane geometry across all towers/faces: EnvironmentCycle dedupes by
    // material, so the whole CBD is a single isNightEmissive drive entry.
    // transparent:true deliberately opts the panes OUT of toonify (GameScene
    // skips transparent materials and would otherwise drop the emissiveMap).
    const towerWinTex = TextureGenerator.createOfficeWindowTexture();
    const towerWinMat = new THREE.MeshStandardMaterial({
      map: towerWinTex,
      emissive: 0xffe6a8,
      emissiveMap: towerWinTex,
      emissiveIntensity: 0.15, // day baseline; EnvironmentCycle raises to ~1.3 at night
      transparent: true,
      depthWrite: false,
      roughness: 0.4,
    });
    const towerWinGeom = new THREE.PlaneGeometry(2.2, 4.2);
    // PROFESSIONAL district: two office rows forming a street wall along
    // the boulevard (planned CBD blocks, not a ring). The rows sit 8.8u either
    // side of the boulevard centreline — pavement + sidewalk — which is a REAL
    // WIDTH, not an angle: as a bare latitude it became 13.2u at R=75 and the
    // "street wall" stopped reading as a street at all.
    // Thinned from 8 → 4 towers (one per corner) and spread wider so the CBD
    // reads as a couple of blocks, not a wall — the island felt congested.
    const CBD_ROW_OFFSET = this.arc(8.8);
    const BUILDING_SITES: Array<[number, number]> = [
      [5.8, ZONE_LAT + CBD_ROW_OFFSET],
      [0.48, ZONE_LAT + CBD_ROW_OFFSET],
      [5.8, ZONE_LAT - CBD_ROW_OFFSET],
      [0.48, ZONE_LAT - CBD_ROW_OFFSET],
    ];
    for (let i = 0; i < BUILDING_SITES.length; i++) {
      const [lon, lat] = BUILDING_SITES[i];
      const dir = this.claimOffStreet(this.dirAt(lon, lat), this.arc(5.5)); // roomier: was 4.5u

      // Sample actual terrain surface along this direction
      const sampled = this.sampleSurfaceByDirection(dir, 0.0);
      buildingSamples.push({ position: sampled.position.clone(), normal: sampled.normal.clone() });

      // Real office scale: ~2 storeys, clearly taller than the cottages
      const bGeom = new THREE.BoxGeometry(3.0, 5.2, 3.0);
      const b = new THREE.Mesh(bGeom, buildingMat);

      // FIX: Building geometry is centered, so we need to offset it upward by half its height
      // Position building with base ON surface, not center IN surface
      const buildingHeight = 5.2;
      const offsetPos = sampled.position
        .clone()
        .add(sampled.normal.clone().multiplyScalar(buildingHeight * 0.5));
      b.position.copy(offsetPos);

      // PLUMB. A tower is the least forgiving thing on the island to lean —
      // its verticals are the eye's reference for "upright" in the whole
      // scene. Position follows the terrain; the up-axis is radial.
      const bUp = sampled.position.clone().normalize();
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), bUp);
      b.quaternion.copy(q);
      // Face the boulevard — each tower addresses the street, so the two
      // rows front each other across the pavement like a real CBD block
      this.faceObjectToward(b, bUp, this.dirAt(lon, ZONE_LAT).multiplyScalar(this.radius));
      b.castShadow = true;
      b.receiveShadow = true;
      b.name = `building_placeholder_${i}`;
      // Window grid on all four faces, parented to the tower so it inherits
      // the surface placement/orientation; +0.03 clears the wall (box face is
      // at ±1.5 local) to avoid z-fighting.
      for (let f = 0; f < 4; f++) {
        const wa = (f * Math.PI) / 2;
        const wp = new THREE.Mesh(towerWinGeom, towerWinMat);
        wp.position.set(Math.sin(wa) * 1.53, 0.15, Math.cos(wa) * 1.53);
        wp.rotation.y = wa;
        wp.raycast = () => {}; // decoration only — keep out of interaction picks
        wp.userData.isNightEmissive = true;
        b.add(wp);
      }
      buildings.add(b);
      // Outline Tier 1: ink the tower masses. Guarded path (see addGroupHulls)
      // auto-skips the emissive window planes and any transparent glass.
      addGroupHulls(b, 1.0, () => true);
      buildingPlaceholders.push(b);
    }

    // Procedural houses: add a few more detailed block houses with roofs/windows to make the island feel inhabited
    const houses = new THREE.Group();
    const houseSamples: { position: THREE.Vector3; normal: THREE.Vector3 }[] = [];
    // PERSONAL district: a village street — two staggered cottage rows
    // flanking the boulevard 9.8u either side, garden gaps between lots, rows
    // offset in lon so no cottage stares straight into another.
    // Thinned from 8 → 6 cottages and spread wider (roomier village street).
    //
    // Both the row offset and the along-street spread are REAL DISTANCES. Left
    // as bare radians they became 14.7u and 45u at R=75: six cottages 45u apart
    // is not a village street, it is six houses in a field. (Lon deltas are
    // authored as raw radians here, as they always were — the cos(lat) foreshortening
    // is absorbed into the tuned number, same as before.)
    const HOUSE_ROW_OFFSET = this.arc(9.8);
    const HOUSE_LON_SPREAD = this.arc(30);
    const HOUSE_LON = 2.52 + SHIFT_PERSONAL;
    const HOUSE_SITES: Array<[number, number]> = [
      [HOUSE_LON - HOUSE_LON_SPREAD, ZONE_LAT + HOUSE_ROW_OFFSET],
      [HOUSE_LON, ZONE_LAT + HOUSE_ROW_OFFSET],
      [HOUSE_LON + HOUSE_LON_SPREAD, ZONE_LAT + HOUSE_ROW_OFFSET],
      [HOUSE_LON - HOUSE_LON_SPREAD, ZONE_LAT - HOUSE_ROW_OFFSET],
      // +0.02 stagger so facing cottages don't stare straight at each other.
      [HOUSE_LON + 0.02, ZONE_LAT - HOUSE_ROW_OFFSET],
      [HOUSE_LON + HOUSE_LON_SPREAD, ZONE_LAT - HOUSE_ROW_OFFSET],
    ];
    const houseCount = HOUSE_SITES.length;
    for (let i = 0; i < houseCount; i++) {
      const [lon, lat] = HOUSE_SITES[i];
      const dir = this.claimOffStreet(this.dirAt(lon, lat), this.arc(6)); // roomier: was 5u

      // Sample actual terrain surface along this direction
      const sampled = this.sampleSurfaceByDirection(dir, 0.0);
      houseSamples.push({ position: sampled.position.clone(), normal: sampled.normal.clone() });

      // main body — real-world ratios vs the 1.8u player: ~2.4u walls
      // (single-storey ceiling), footprint 3.4-4.4u. The previous pass
      // still left the player towering over the rooflines.
      const w = 3.4 + Math.random() * 1.0;
      const h = 2.2 + Math.random() * 0.5;
      const d = 2.8 + Math.random() * 0.8;
      const bodyGeom = new THREE.BoxGeometry(w, h, d);
      // Curated warm cottage palette. The old `0xa8c3a8 + random(0x003333)`
      // bled across color channels and produced lime/acid-green/cyan walls.
      const WALL_COLORS = [0xc47a5a, 0xd9a066, 0xb5654a, 0xe0c9a6, 0x9e5b4b, 0xcc8a5d];
      const bodyMat = Materials.createHouseMaterial(WALL_COLORS[i % WALL_COLORS.length]);
      const body = new THREE.Mesh(bodyGeom, bodyMat);
      body.castShadow = true;
      body.receiveShadow = true;

      // roof — taller pyramid to suit the bigger footprint
      const roofGeom = new THREE.ConeGeometry(Math.max(w, d) * 0.82, 1.5, 4);
      const roofMat = Materials.createTrimMaterial(0x8b5a2b);
      const roof = new THREE.Mesh(roofGeom, roofMat);
      roof.castShadow = true;
      roof.receiveShadow = true;
      roof.rotation.y = Math.PI / 4;

      const house = new THREE.Group();
      // FIX: Body geometry is centered at origin, so position.y = h/2 makes BOTTOM at y=0 (on ground)
      body.position.set(0, h * 0.5, 0);
      roof.position.set(0, h + 0.55, 0);
      house.add(body);
      house.add(roof);

      // Foundation plinth (the farm grounding rule): the walls end at y=0, so
      // on sloped lots the downhill wall edge hung over falling terrain. A
      // stone course slightly INSET behind the wall faces runs 1.7u down into
      // the hill — the 0.04 recess reads as a shadow line under the walls, and
      // the door/window planes (at z·0.51) stay proud of it.
      const plinth = new THREE.Mesh(
        new THREE.BoxGeometry(w - 0.08, 1.7, d - 0.08),
        Materials.createTrimMaterial(0x7a6f63),
      );
      plinth.position.set(0, -0.81, 0); // top at y=+0.04, bottom at y=-1.66
      plinth.receiveShadow = true;
      house.add(plinth);

      // Windows as emissive planes
      const winMat = new THREE.MeshStandardMaterial({
        color: 0xffffcc,
        emissive: 0xffe6b3,
        emissiveIntensity: 0.6,
      });
      const winGeom = new THREE.PlaneGeometry(0.7, 0.75);
      const win1 = new THREE.Mesh(winGeom, winMat);
      win1.position.set(w * 0.24, h * 0.58, d * 0.51);
      // EnvironmentCycle collects tagged meshes post-toonify and drives
      // their emissiveIntensity with the day/night cycle
      win1.userData.isNightEmissive = true;
      house.add(win1);
      const win2 = new THREE.Mesh(winGeom, winMat);
      win2.position.set(-w * 0.24, h * 0.58, d * 0.51);
      win2.userData.isNightEmissive = true;
      house.add(win2);
      // Door — 1.9u tall: the 1.8u player walks through with headroom
      const doorMat = new THREE.MeshStandardMaterial({ color: 0x5a3d2b, roughness: 0.7 });
      const door = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 1.9), doorMat);
      door.position.set(0, 0.95, d * 0.51);
      house.add(door);
      // Doorknob
      const knob = new THREE.Mesh(
        new THREE.SphereGeometry(0.06, 6, 6),
        new THREE.MeshStandardMaterial({ color: 0xccaa44, metalness: 0.6 }),
      );
      knob.position.set(0.3, 1.0, d * 0.52);
      house.add(knob);
      // Enterable invitation: a doormat + warm door lamp (the exact idiom the
      // zone buildings use) — the cottages' interiors + sleeping NPCs were
      // effectively hidden behind doors that looked purely decorative.
      // Doormat is a tall buried box, not a 0.05 slab: it sits OUTSIDE the
      // plinth footprint, so on a downhill door approach the old slab floated.
      // Top face stays at the same height (~0.055); the extra 0.3u is berm.
      const doormat = new THREE.Mesh(
        new THREE.BoxGeometry(0.9, 0.35, 0.5),
        new THREE.MeshStandardMaterial({ color: 0xd9c48a, roughness: 1 }),
      );
      doormat.position.set(0, -0.12, d * 0.51 + 0.35);
      doormat.receiveShadow = true;
      house.add(doormat);
      const doorLamp = new THREE.Mesh(
        new THREE.SphereGeometry(0.09, 8, 8),
        new THREE.MeshStandardMaterial({
          color: 0xffe6a8,
          emissive: 0xffc966,
          emissiveIntensity: 0.4,
          roughness: 0.4,
        }),
      );
      doorLamp.position.set(0, 2.05, d * 0.52);
      doorLamp.userData.isNightEmissive = true; // EnvironmentCycle drives it
      house.add(doorLamp);
      // Chimney (every other house)
      if (i % 2 === 0) {
        const chimney = new THREE.Mesh(
          new THREE.BoxGeometry(0.45, 1.1, 0.45),
          Materials.createTrimMaterial(0x884433),
        );
        chimney.position.set(w * 0.25, h + 0.8, -d * 0.15);
        chimney.castShadow = true;
        house.add(chimney);
      }

      // Plumb, like every other built structure — houses sit ON the terrain
      // but stand vertical. Their foundations are buried deep enough to
      // absorb the gap on the downhill side.
      const hUp = sampled.position.clone().normalize();
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), hUp);
      house.quaternion.copy(q);
      // Front door faces the village street (nearest boulevard point)
      this.faceObjectToward(house, hUp, this.dirAt(lon, ZONE_LAT).multiplyScalar(this.radius));
      house.position.copy(sampled.position);
      // Record the chimney tip (post-alignment) for GameScene's smoke puffs
      if (i % 2 === 0) {
        const chimneyTip = new THREE.Vector3(w * 0.25, h + 1.4, -d * 0.15)
          .applyQuaternion(house.quaternion)
          .add(house.position);
        this.chimneySites.push({ position: chimneyTip, normal: sampled.normal.clone() });
      }
      // Enterable-house door anchor: the door plane is buried behind the ~2.3u
      // wall collider, so the player bounces off ~1u short. Put the interaction
      // anchor OUTSIDE the collider (~2.7u out along the door-forward +Z) — right
      // where the tangential push actually stops the player.
      const doorFwd = new THREE.Vector3(0, 0, 1).applyQuaternion(house.quaternion);
      this.houseDoors.push({
        position: house.position.clone().addScaledVector(doorFwd, 2.7),
        id: `house_${i}`,
      });
      // Houses are already positioned by sampleSurfacePosition - no additional offset needed
      house.name = `house_${i}`;
      houses.add(house);
      // Outline Tier 1: body/roof/plinth/chimney get ink; the doormat, knob
      // and porch lamp fall under the 0.6 size floor, windows plane-guard out.
      addGroupHulls(house, 0.6, () => true);
      // Porch light. This used to sit at z = d*0.35 — INSIDE the walls — with
      // a 2u radius, so it lit precisely nothing and every house read as a
      // black slab with two lit windows after dark. It now hangs just proud
      // of the facade (half-depth + 0.6) with the reach to actually wash the
      // front wall and the doorstep. Still ONE light per house, the same one
      // EnvironmentCycle already ramps at dusk via isHouseWarmLight.
      const warmColor = 0xffd6a5;
      const light = new THREE.PointLight(warmColor, 1.9, 8, 2);
      light.position.set(0, h * 0.62, d * 0.5 + 0.6);
      // A sconce beside the door so the glow has a visible source rather than
      // coming from thin air. Tagged isNightEmissive, so it is dark by day.
      const sconceMat = new THREE.MeshStandardMaterial({
        color: 0xfff2d0,
        emissive: 0xffdc9a,
        emissiveIntensity: 0.9,
      });
      const sconce = new THREE.Mesh(new THREE.SphereGeometry(0.16, 8, 6), sconceMat);
      sconce.position.set(w * 0.3, h * 0.66, d * 0.5 + 0.1);
      sconce.userData.isNightEmissive = true;
      house.add(sconce);
      const hood = new THREE.Mesh(
        new THREE.ConeGeometry(0.24, 0.2, 7),
        Materials.createTrimMaterial(0x33291f),
      );
      hood.position.set(w * 0.3, h * 0.66 + 0.22, d * 0.5 + 0.1);
      house.add(hood);
      // don't cast shadows by default (expensive); user can toggle in renderer settings if desired
      light.castShadow = false;
      // tag so the renderer or debug UI can find and tweak these
      const lightData = light.userData as Record<string, unknown>;
      lightData.isHouseWarmLight = true;
      // attach to house so it follows rotation/position on the sphere
      house.add(light);
    }

    // Trees: stylized low-poly trees with clustered dodecahedron canopies.
    // Each tree's 5-7 parts are merged into ONE vertex-coloured mesh so the
    // whole tree is a single draw call (~327 part meshes -> ~48). Colours ride
    // in the vertex `color` attribute, so every tree shares one material; the
    // per-tree group still owns the position/orientation and gets swayed in
    // GameScene, and the `tree_N` name still drives colliders + canopy spacing.
    const trees = new THREE.Group();
    const TRUNK_COLOR = 0x6b4a2a;
    const DARK_TRUNK_COLOR = 0x5a3d1e;
    const PINE_COLOR = 0x2a6e2a;
    const FOLIAGE_COLORS = [0x7ba84e, 0x5aa244, 0x4a9e3e, 0x3a8c3a, 0x2d7a3a]; // ordered dry→lush; canopy indexes this by moisture
    const treeMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.78 });

    // Bake a part's local transform + a flat vertex colour into its geometry,
    // ready to merge into the tree's single mesh.
    const _tm = new THREE.Matrix4();
    const _tq = new THREE.Quaternion();
    const _te = new THREE.Euler();
    const _tp = new THREE.Vector3();
    const _ts = new THREE.Vector3();
    const _tc = new THREE.Color();
    const bakePart = (
      parts: THREE.BufferGeometry[],
      geo: THREE.BufferGeometry,
      colorHex: number,
      pos: [number, number, number],
      rot: [number, number, number] = [0, 0, 0],
      scl: [number, number, number] = [1, 1, 1],
    ): void => {
      _te.set(rot[0], rot[1], rot[2]);
      _tq.setFromEuler(_te);
      _tp.set(pos[0], pos[1], pos[2]);
      _ts.set(scl[0], scl[1], scl[2]);
      geo.applyMatrix4(_tm.compose(_tp, _tq, _ts));
      if (geo.index) geo = geo.toNonIndexed();
      const n = geo.attributes.position.count;
      const col = new Float32Array(n * 3);
      _tc.set(colorHex);
      for (let k = 0; k < n; k++) {
        col[k * 3] = _tc.r;
        col[k * 3 + 1] = _tc.g;
        col[k * 3 + 2] = _tc.b;
      }
      geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
      // Drop uv so every part shares an identical attribute set for the merge
      geo.deleteAttribute('uv');
      parts.push(geo);
    };

    const goldenAngle = Math.PI * (3 - Math.sqrt(5));
    // Grove-based, biome-driven scatter. We generate MORE candidates than we
    // place and accept each by a probability keyed to the moisture/elevation
    // FIELDS already computed for terrain colour: lush low valleys read as
    // dense groves, dry ridges and highlands thin toward clearings + a
    // treeline. Species + canopy colour follow the same fields — conifers on
    // high/dry ground, shrubs in the shore band, broadleaf in the lush lows —
    // so the eye reads distinct biomes instead of a uniform sprinkle. (The
    // Math.random here is seeded via GameScene.installSeededRandom, so the
    // whole layout is reproducible across reloads.)
    // CANDIDATES is also the angular sampling rate against the ~21u moistureAt
    // wavelength, so it has to grow with the sphere or the grove field gets
    // under-sampled and groves land in the wrong places, not just fewer of them.
    const TREE_CANDIDATES = Math.round(290 * areaScale(this.radius));
    const TREE_CAP = Math.round(96 * areaScale(this.radius)); // a HARD cap (`placed < TREE_CAP`), so without this the island silently thins
    let placed = 0;
    for (let i = 0; i < TREE_CANDIDATES && placed < TREE_CAP; i++) {
      const y = 1 - (i / (TREE_CANDIDATES - 1)) * 2;
      const radiusAtY = Math.sqrt(1 - y * y);
      const theta = goldenAngle * i;
      const candidate = new THREE.Vector3(
        Math.cos(theta) * radiusAtY,
        Math.abs(y),
        Math.sin(theta) * radiusAtY,
      ).normalize();
      if (candidate.y < Math.sin(0.29)) continue; // shoreline gate
      if (candidate.y > Math.sin(1.24)) continue; // treeline / snowline gate
      const moist = (this.moistureAt(candidate) + 1) * 0.5; // 0..1 lush
      // Grove density: lush = dense grove, dry/high = clearing. The smooth
      // moisture field (~10-20u features) makes trees clump into contiguous
      // groves and open up meadows between — clumping AND negative space.
      const groveP = 0.36 + moist * 0.7 - Math.max(0, candidate.y - Math.sin(0.92)) * 1.7;
      if (Math.random() > groveP) continue; // a clearing
      const dir = this.claimDir(candidate, this.arc(3.5));
      if (dir.y < Math.sin(0.29)) continue;
      // No trees through the pavement — skip candidates on a street
      if (this.isNearStreet(dir)) continue;
      const sampled = this.sampleSurfaceByDirection(dir, 0.0);
      // Slope gate: no trees on cliff faces (mirrors the grass gate 60 lines
      // down) so trees stop growing on crags and accent the peaks instead.
      if (sampled.normal.dot(dir) < 0.84) continue;
      // Trees grow RADIALLY (straight "up" against gravity, like real trees
      // reaching for light) — NOT tilted with the slope. Playtest-locked:
      // slope-normal trees on hillsides read as falling over. The ring-min
      // seat below still buries the trunk base properly on uneven ground;
      // only the growth direction is vertical.
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);

      // Real tree scale: ~4-6u tall so they read as TREES, not shrubs, beside
      // the ~1.7u player (were 2.4-3.6u — barely taller than the person).
      const scale = 3.6 + Math.random() * 1.6;
      // Species by biome: conifers on peaks/dry ridges, shrubs in the shore
      // band, broadleaf in the lush valleys.
      const elevAbove = sampled.position.length() - this.radius;
      let treeType: number;
      if (elevAbove > 4.2 || moist < 0.32) treeType = 2;
      else if (dir.y < Math.sin(0.44)) treeType = 3;
      else treeType = Math.random() < 0.5 ? 0 : 1;
      // Canopy colour tracks moisture (lusher = deeper green); conifers fixed.
      let fColor =
        treeType === 2
          ? PINE_COLOR
          : FOLIAGE_COLORS[
              Math.min(FOLIAGE_COLORS.length - 1, Math.floor(moist * FOLIAGE_COLORS.length))
            ];
      // Per-district canopy tint (broadleaf only — conifers/shrubs keep their
      // biome colour): blossom-pink near Personal, cool blue-green near
      // Professional, etc. Reads as different trees per district, no new geo.
      if (treeType <= 1) {
        const acc = new THREE.Color();
        const tw = districtAccentAt(dir, acc);
        if (tw > 0) fColor = new THREE.Color(fColor).lerp(acc, tw * 0.45).getHex();
      }
      const parts: THREE.BufferGeometry[] = [];
      const treeGroup = new THREE.Group();

      if (treeType <= 1) {
        // Round canopy tree — tapered trunk + clustered dodecahedrons
        bakePart(
          parts,
          new THREE.CylinderGeometry(0.04 * scale, 0.08 * scale, 0.6 * scale, 6),
          TRUNK_COLOR,
          [0, 0.3 * scale, 0],
        );
        bakePart(
          parts,
          new THREE.DodecahedronGeometry(0.35 * scale, 0),
          fColor,
          [0, 0.75 * scale, 0],
          [i * 0.7, i * 1.3, 0],
        );
        // 2-3 smaller satellite blobs for organic volume
        const blobCount = 2 + (i % 2);
        for (let b = 0; b < blobCount; b++) {
          const angle = (b / blobCount) * Math.PI * 2 + i;
          bakePart(
            parts,
            new THREE.DodecahedronGeometry(0.18 * scale, 0),
            fColor,
            [
              Math.cos(angle) * 0.2 * scale,
              0.7 * scale + (b === 0 ? 0.15 : -0.05) * scale,
              Math.sin(angle) * 0.2 * scale,
            ],
            [b * 1.1, b * 2.3, 0],
          );
        }
      } else if (treeType === 2) {
        // Pine/conifer — tall trunk + layered cone tiers (sharper, taller)
        bakePart(
          parts,
          new THREE.CylinderGeometry(0.03 * scale, 0.06 * scale, 0.8 * scale, 6),
          DARK_TRUNK_COLOR,
          [0, 0.4 * scale, 0],
        );
        for (let t = 0; t < 3; t++) {
          const tierScale = 1 - t * 0.22;
          bakePart(
            parts,
            new THREE.ConeGeometry(0.22 * scale * tierScale, 0.3 * scale, 6),
            PINE_COLOR,
            [0, (0.65 + t * 0.22) * scale, 0],
          );
        }
      } else {
        // Bushy shrub tree — short trunk, wide icosahedron canopy
        bakePart(
          parts,
          new THREE.CylinderGeometry(0.05 * scale, 0.07 * scale, 0.3 * scale, 5),
          TRUNK_COLOR,
          [0, 0.15 * scale, 0],
        );
        bakePart(
          parts,
          new THREE.IcosahedronGeometry(0.4 * scale, 0),
          fColor,
          [0, 0.5 * scale, 0],
          [0, i * 0.9, 0],
          [1.3, 0.8, 1.3],
        );
        // Small accent blob
        bakePart(parts, new THREE.DodecahedronGeometry(0.15 * scale, 0), fColor, [
          0.2 * scale,
          0.55 * scale,
          0.1 * scale,
        ]);
      }

      // Merge the tree's parts into one vertex-coloured mesh → one draw call
      const treeMesh = new THREE.Mesh(mergeGeometries(parts, false), treeMat);
      treeMesh.castShadow = true;
      treeGroup.add(treeMesh);

      // Farm-rule seat: the trunk base sits at the LOWEST ground under its
      // footprint (0.45u ring) minus a 0.12 sink — centre-seated trunks ended
      // mid-air on the downhill side of slopes (the grounding audit's
      // floating-tree defect). The uphill side simply buries a little deeper.
      const seatR = Math.min(sampled.position.length(), this.ringMinRadius(dir, 0.45)) - 0.12;
      treeGroup.position.copy(dir).multiplyScalar(seatR);
      treeGroup.quaternion.copy(q);
      treeGroup.name = `tree_${placed}`;
      const treeData = treeGroup.userData as Record<string, unknown>;
      treeData.ignoreOcclusion = true;
      // Ink the canopy — the user-reported gap: every coastal palm
      // (GameScene.setupPalms) and even the cats standing under these trees
      // carried the cel nib while the trees themselves did not. LEGACY 2-arg
      // form ON PURPOSE so a tree and the palm beside it share the identical
      // 0.016u nib; the filter path's heavier building cap would read as a
      // third pen in the same frame. One merged OPAQUE mesh per tree, so the
      // guarded path's instanced/transparent/plane skips have nothing to do.
      // RNG-free at this call site: the shield lives inside CelLook.
      addGroupHulls(treeGroup);
      trees.add(treeGroup);
      placed++;
    }

    // Mailboxes: seed around homes/structures instead of a perfect orbit
    const mailboxes = new THREE.Group();
    // Spread the 6 mailboxes ONE-PER-DISTRICT (with a second in the cottage
    // village, which has the most homes) instead of clustering all of them in
    // Personal off houseSamples. Because deliveries are anchored to the
    // mailboxes, this scatters pickups across the whole island so a courier
    // run actually tours the map rather than pacing one street. Each site is
    // sampled at the plaza roadside; the per-mailbox stepping below still
    // slides it clear of the pavement and claims the spot.
    const MAILBOX_SITES: Array<[number, number]> = [
      [0.3, 1.3], // welcome — near the spawn plaza
      [6.1, 0.42], // professional
      [1.3 + SHIFT_PROJECTS, 0.42], // projects
      [2.3 + SHIFT_PERSONAL, 0.5], // personal (village)
      [2.75 + SHIFT_PERSONAL, 0.4], // personal (second)
      [3.8 + SHIFT_CONTACT, 0.42], // contact
    ];
    const mailboxSources = MAILBOX_SITES.map(([lon, lat]) => {
      const s = this.sampleSurfaceByDirection(
        this.claimOffStreet(this.dirAt(lon, lat), this.arc(5)),
        0.0,
      );
      return { position: s.position.clone(), normal: s.normal.clone() };
    });
    const mailboxCount = mailboxSources.length;
    for (let i = 0; i < mailboxCount; i++) {
      const sampled = mailboxSources[i];
      if (!sampled) continue;
      // Put the mailbox at the ROADSIDE by the house: step ~2.6u toward the
      // nearest street (clears the ~2u-half-width house footprint so it never
      // sits inside the walls — the old 0.8-1.2u offset buried it in the house),
      // then slide off the pavement and claim the spot so it can't collide.
      const houseDir = sampled.position.clone().normalize();
      const street = this.nearestStreetDir(houseDir, this.arc(35));
      const tangent = new THREE.Vector3();
      if (street) tangent.copy(street).addScaledVector(houseDir, -street.dot(houseDir));
      if (tangent.lengthSq() < 1e-6) {
        tangent.crossVectors(sampled.normal, new THREE.Vector3(0, 1, 0));
        if (tangent.lengthSq() < 1e-6) tangent.set(1, 0, 0);
        tangent.applyAxisAngle(sampled.normal, Math.random() * Math.PI * 2);
      }
      tangent.normalize();
      let mbDir = houseDir
        .clone()
        .addScaledVector(tangent, 2.6 / this.radius)
        .normalize();
      mbDir = this.pushOffStreet(mbDir);
      mbDir = this.claimDir(mbDir, this.arc(2.5));
      const placement = this.sampleSurfaceByDirection(mbDir, 0.03);

      const mb = new THREE.Group();
      // Post
      const postMat = new THREE.MeshStandardMaterial({ color: 0x5a3d2b, roughness: 0.8 });
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.035, 0.5, 6), postMat);
      post.position.y = 0.25;
      mb.add(post);
      // Box body
      const boxMat = Materials.createMailboxMaterial();
      const box = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.16, 0.12), boxMat);
      box.position.y = 0.56;
      mb.add(box);
      // Rounded top (half-cylinder look via a squashed sphere)
      const top = new THREE.Mesh(
        new THREE.SphereGeometry(0.09, 8, 4, 0, Math.PI * 2, 0, Math.PI / 2),
        boxMat,
      );
      top.scale.set(1, 0.5, 0.67);
      top.position.y = 0.64;
      mb.add(top);
      // Flag — DOWN (rotated flat): these six town mailboxes are decorative;
      // a raised red flag is the interactive quest-mailbox signal, and lookal
      // ikes with raised flags taught visitors that prompts are flaky.
      const flag = new THREE.Mesh(
        new THREE.BoxGeometry(0.02, 0.08, 0.06),
        new THREE.MeshStandardMaterial({ color: 0x8a8378 }),
      );
      flag.position.set(0.1, 0.52, 0);
      flag.rotation.z = Math.PI / 2.3;
      mb.add(flag);
      mb.position.copy(placement.position);
      this.mailboxSites.push(placement.position.clone()); // NPC activity anchor (mail round)
      // World Law 1: mailboxes STAND, so they stand PLUMB — radial up, never
      // the sample's tilted normal (measured up to 4.6° of rake). The lamps
      // thirty lines below always did this correctly.
      const mbUp = placement.position.clone().normalize();
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), mbUp);
      mb.quaternion.copy(q);
      // Face the mailbox toward the road (a roadside mailbox addresses the
      // street). faceObjectToward premultiplies about the axis it is handed —
      // pass the plumb axis or it quietly re-tilts the box (CLAUDE.md law 1).
      if (street) {
        this.faceObjectToward(mb, mbUp, street.clone().multiplyScalar(this.radius));
      } else {
        mb.quaternion.premultiply(
          new THREE.Quaternion().setFromAxisAngle(mbUp, Math.random() * Math.PI * 2),
        );
      }
      mb.name = `mailbox_${i}`;
      mb.castShadow = true;
      mb.receiveShadow = true;
      mailboxes.add(mb);
    }

    // (Removed stripes/road centerline boxes to eliminate boundaries)

    // (Freestanding staircases removed — steps rising out of an open field
    // with nothing above them read as leftovers, not architecture.)
    const stairs = new THREE.Group();

    // Add street lamps for evening ambiance
    const lamps = new THREE.Group();
    const lampPositions: THREE.Vector3[] = [];
    // Street lighting: lamps march along the boulevard at regular
    // intervals, alternating kerbs (odd = north lat 0.515, even = south
    // lat 0.412) — mid-block lons chosen clear of building/house columns.
    // GENERATED, not hand-listed. Lamps are a BELT population: the boulevard
    // is 281u round at R=50 and 421u at R=75, so a fixed ten would sit 28u
    // apart — the spacing already judged "genuinely black" and fixed by the
    // infill pass below. Count tracks the circumference; the alternating-kerb
    // pattern and the 2.57u kerb offset are preserved exactly.
    // 2*round(N/2 * belt), NOT round(N * belt): the i%2 alternating-kerb
    // pattern must survive the wrap, and an odd count (15 at R=75) put two
    // consecutive lamps on the same kerb at the seam.
    const LAMP_RING_COUNT = 2 * Math.round(5 * beltScale(this.radius));
    const LAMP_KERB = this.arc(2.57);
    const LAMP_LON_0 = 0.28;
    const LAMP_SITES: Array<[number, number]> = Array.from(
      { length: LAMP_RING_COUNT },
      (_, i): [number, number] => [
        LAMP_LON_0 + (i * Math.PI * 2) / LAMP_RING_COUNT,
        ZONE_LAT + (i % 2 === 0 ? -LAMP_KERB : LAMP_KERB),
      ],
    );
    // INFILL: the ten original lamps sat ~0.63rad apart, which left the road
    // between them genuinely black. These drop a lamp at each midpoint on the
    // OPPOSITE kerb, so the boulevard reads as a lit street rather than a
    // chain of separate glows. They carry no real light (see buildLamp) —
    // bulb plus ground pool is enough at this spacing and costs no fragment
    // work. Nothing else on the island gets lamps: the hills, the shore and
    // the outer paths stay dark on purpose, and the contrast is the point.
    const LAMP_INFILL: Array<[number, number]> = Array.from(
      { length: LAMP_RING_COUNT },
      (_, i): [number, number] => [
        LAMP_LON_0 + ((i + 0.5) * Math.PI * 2) / LAMP_RING_COUNT,
        ZONE_LAT + (i % 2 === 0 ? LAMP_KERB : -LAMP_KERB),
      ],
    );
    // THE FLEET IS TWO DRAWS. buildLamp used to mint 4 meshes + 3 materials
    // PER LAMP (~228 meshes / ~171 materials at R=100, ~114 of them shadow
    // casters, every one cloned again by toonify) — the same shape the trees
    // (one merged vertex-coloured mesh) and rocks (one InstancedMesh) already
    // solved. The body (pole+arm+shade) bakes into ONE vertex-coloured
    // geometry via the trees' bakePart, the bulbs share ONE emissive
    // material, and the per-lamp anchor Groups below carry ONLY the
    // transform + discovery contract: name lamp_<i> (colliders), poolScale +
    // boulevardRing (light pools, tests), position/quaternion/scale (the
    // instance matrix is read straight off the anchor, so the transform math
    // — plumb, faceObjectToward, arm swing — is byte-identical).
    const lampBodyParts: THREE.BufferGeometry[] = [];
    bakePart(lampBodyParts, new THREE.CylinderGeometry(0.06, 0.08, 1.6, 8), 0x3a3a3a, [0, 0.8, 0]);
    bakePart(
      lampBodyParts,
      new THREE.CylinderGeometry(0.04, 0.04, 0.5, 6),
      0x3a3a3a,
      [0.2, 1.55, 0],
      [0, 0, -Math.PI / 4],
    );
    bakePart(
      lampBodyParts,
      new THREE.ConeGeometry(0.2, 0.15, 8),
      0x2a2a2a,
      [0.35, 1.55, 0],
      [0, 0, Math.PI],
    );
    // One material each — trim params mirror Materials.createTrimMaterial.
    const lampBodyMat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      metalness: 0.12,
      roughness: 0.35,
    });
    const lampBulbMat = new THREE.MeshStandardMaterial({
      color: 0xfff4cc,
      emissive: 0xffe8a0,
      emissiveIntensity: 0.8,
    });
    const lampMatrices: THREE.Matrix4[] = [];
    let lampIndex = 0;
    const buildLamp = (
      pos: THREE.Vector3,
      faceTarget: THREE.Vector3,
      withLight: boolean,
      poolScale: number,
    ): void => {
      const i = lampIndex++;
      const sampled = this.sampleSurfacePosition(pos, 0.6);
      this.lampSites.push(sampled.position.clone()); // NPC activity anchor (lamp round)
      // ANCHOR only — the geometry lives in the two InstancedMesh below.
      const lampGroup = new THREE.Group();
      lampGroup.name = `lamp_${i}`;
      // GameScene.createLampLightPools() reads this when it sizes each pool.
      lampGroup.userData.poolScale = poolScale;
      // Lamp height ~4.3u at the bulb. Height is the lever on pool size: a
      // higher source throws a wider, softer circle, so this and the pool
      // scales below move together — raising one without the other gives you
      // either a tall lamp lighting a dot or a floating puddle of light.
      lampGroup.scale.setScalar(2.9);

      // Lamp posts stand PLUMB. Their foot follows the ground, but a post
      // raked over to match a slope looks knocked down, not planted.
      const lampUp = sampled.position.clone().normalize();
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), lampUp);
      lampGroup.position.copy(sampled.position);
      lampGroup.quaternion.copy(q);
      // Swing the arm (local +X) out over the roadway: yaw +Z toward the
      // boulevard centerline, then back off 90° so +X takes its place
      // Yaw about the PLUMB axis, not the slope normal: faceObjectToward
      // premultiplies a rotation about whatever axis it is handed, so passing
      // the slope normal here quietly tilted the post straight back over.
      this.faceObjectToward(lampGroup, lampUp, faceTarget);
      lampGroup.rotateOnAxis(new THREE.Vector3(0, 1, 0), -Math.PI / 2);
      // No per-lamp light. Ten static lights meant the other twenty-seven
      // lamps were pure decoration — you could walk directly under one and
      // nothing touched you. GameScene roams THREE lights onto whichever
      // lamps are nearest the player instead (updateLampFollowLights), so
      // every lamp on the island lights you when you stand under it, at a
      // third of the fragment cost of the old arrangement.
      void withLight;
      lamps.add(lampGroup);
      // The anchor's local matrix IS the instance matrix (lamps sits at
      // identity under the island root).
      lampGroup.updateMatrix();
      lampMatrices.push(lampGroup.matrix.clone());
      lampPositions.push(sampled.position.clone().add(new THREE.Vector3(0, 1.48, 0)));
    };
    for (const [lon, lat] of LAMP_SITES) {
      // claimOffStreet, not claimDir: a couple of boulevard lamps landed on the
      // ribbon where an avenue meets the boulevard; this keeps them at the kerb.
      const pos = this.claimOffStreet(this.dirAt(lon, lat), this.arc(2.5)).multiplyScalar(
        this.radius,
      );
      buildLamp(pos, this.dirAt(lon, 0.4636).multiplyScalar(this.radius), true, 5.8);
      lamps.children[lamps.children.length - 1].userData.boulevardRing = 'sites';
    }
    for (const [lon, lat] of LAMP_INFILL) {
      const pos = this.claimOffStreet(this.dirAt(lon, lat), this.arc(2.5)).multiplyScalar(
        this.radius,
      );
      buildLamp(pos, this.dirAt(lon, 0.4636).multiplyScalar(this.radius), false, 5.8);
      lamps.children[lamps.children.length - 1].userData.boulevardRing = 'infill';
    }
    // PORCH lamps: one beside every house door, so homes read as lived-in
    // after dark instead of black cutouts with two lit windows. Offset along
    // the local tangent (the door already sits proud of the facade, so a
    // sideways step keeps the pole clear of the wall) and aimed back at the
    // doorstep, which is what the arm then reaches over.
    const tangentAt = (p: THREE.Vector3): THREE.Vector3 => {
      const up = p.clone().normalize();
      let side = new THREE.Vector3(0, 1, 0).cross(up);
      if (side.lengthSq() < 1e-4) side = new THREE.Vector3(1, 0, 0).cross(up);
      return side.normalize();
    };
    for (const door of this.houseDoors) {
      buildLamp(
        door.position.clone().addScaledVector(tangentAt(door.position), 1.6),
        door.position,
        false,
        4.6,
      );
    }
    // PLAZA lamps: a pair flanking each district building. The halls are the
    // largest silhouettes on the island and were reading as black slabs after
    // dark; two lamps apiece light the approach without lighting the hall.
    for (const b of buildingSamples) {
      const side = tangentAt(b.position);
      for (const s of [-1, 1]) {
        buildLamp(b.position.clone().addScaledVector(side, s * 5.2), b.position, false, 5.4);
      }
    }
    // ROADSIDE lamps: every other mailbox gets one. Mailboxes already stand
    // where a path meets a home, so they are the cheapest correct answer to
    // "light the paths" — and taking every SECOND one is what leaves the
    // gaps of dark between them.
    for (let i = 0; i < this.mailboxSites.length; i += 2) {
      const p = this.mailboxSites[i];
      buildLamp(p.clone().addScaledVector(tangentAt(p), 1.5), p, false, 4.8);
    }

    // ARTERY lamps: light the pole↔district avenues and their connectors.
    //
    // ⚠️ RNG SHIELD, and it is not optional. three's generateUUID() burns FOUR
    // Math.random draws per Object3D/Material/Geometry, so buildLamp — which
    // mints a Group per lamp — consumes from the seeded stream. This pass runs
    // UPSTREAM of the parked-car claimOffStreet, and multiplayer addresses
    // vehicles BY INDEX, so an unshielded pass here would silently re-roll
    // every car (and every prop placed after) for anyone on a fresh bundle.
    // A local mulberry32 + try/finally makes the pass stream-neutral no matter
    // how many lamps it ends up building — same guard createGrass uses.
    {
      const stashedRandom = Math.random;
      let lseed = 0x9e3779b1 >>> 0;
      Math.random = (): number => {
        lseed = (lseed + 0x6d2b79f5) >>> 0;
        let t = Math.imul(lseed ^ (lseed >>> 15), 1 | lseed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
      try {
        const PITCH = 14; // metres between stations — matches the boulevard's 14.05u
        const KERB = this.arc(2.5);
        const DEDUPE = 9; // skip a station already served by an existing lamp
        let station = 0;
        for (const line of arteryLines) {
          // Walk the centreline by arc length so spacing is even regardless of
          // how coarsely the path itself was sampled (avenues step 8.6u,
          // connectors 3.0u).
          let carry = PITCH * 0.5; // half-pitch in so lamps don't stack on the plaza
          for (let i = 1; i < line.length; i++) {
            const a = line[i - 1];
            const b = line[i];
            const segLen = a.angleTo(b) * this.radius;
            if (segLen < 1e-3) continue;
            for (let d = carry; d < segLen; d += PITCH) {
              const dir = a
                .clone()
                .lerp(b, d / segLen)
                .normalize();
              // DARK ZONES, authored as a rule rather than by omission: no
              // lamp on the beach band or up the highland shoulder. The
              // Contact avenue climbs past a peak, so this genuinely fires.
              const surf = this.analyticSurface(dir).radius;
              const elevAboveSea = surf - this.seaLevel();
              if (dir.y < Math.sin(0.32)) continue; // shore band stays dark
              if (elevAboveSea > Island.MAX_DISPLACEMENT * 0.42 * this.reliefScale) continue;
              // Already lit? (the boulevard's 40 cover the plaza ends)
              let served = false;
              for (const s of this.lampSites) {
                if (s.distanceTo(dir.clone().multiplyScalar(surf)) < DEDUPE) {
                  served = true;
                  break;
                }
              }
              if (served) continue;
              // Kerb offset alternates side by station, like the boulevard.
              const tangent = b.clone().sub(a).normalize();
              const kerb = tangent.clone().cross(dir).normalize();
              const side = station++ % 2 === 0 ? 1 : -1;
              const site = dir
                .clone()
                .addScaledVector(kerb, KERB * side)
                .normalize()
                .multiplyScalar(this.radius);
              // Face the centreline so the arm reaches over the roadway.
              buildLamp(site, dir.clone().multiplyScalar(this.radius), false, 5.2);
              // Tagged so the ring-parity test can assert the HISTORICAL
              // populations are untouched and this pass is purely additive.
              lamps.children[lamps.children.length - 1].userData.boulevardRing = 'artery';
            }
            carry = (((carry - segLen) % PITCH) + PITCH) % PITCH;
          }
        }
      } finally {
        Math.random = stashedRandom;
      }
    }

    // The two instanced draws for the whole fleet (see the block above
    // buildLamp). frustumCulled=false on both: the ring wraps the planet, so
    // all-or-nothing culling of the single object could only ever flicker
    // the fleet — the ~11k body verts are trivial next to 228 draw calls.
    {
      // NAMES MUST NOT START WITH "lamp": tryLoadModels replaces placeholders
      // by NAME PREFIX (findPlaceholders('lamp')), so 'lamp_*_instanced'
      // meshes were themselves treated as placeholders — the loader hid the
      // whole fleet, drove its SHARED materials to opacity 0, and dropped two
      // junk lamp.glb clones at the planet core (both measured live).
      const bodyMesh = new THREE.InstancedMesh(
        mergeGeometries(lampBodyParts, false),
        lampBodyMat,
        lampMatrices.length,
      );
      bodyMesh.name = 'streetlamp_bodies_instanced';
      // NOTE: the merged body makes the ARM a shadow caster (it was not one
      // when the parts were separate meshes). At 0.04u radius the extra
      // diagonal sliver is invisible; splitting the merge to preserve it
      // would cost a third draw call.
      bodyMesh.castShadow = true; // one instanced depth draw replaces ~114 casters
      bodyMesh.frustumCulled = false;
      const bulbMesh = new THREE.InstancedMesh(
        new THREE.SphereGeometry(0.1, 8, 8).translate(0.35, 1.48, 0),
        lampBulbMat,
        lampMatrices.length,
      );
      bulbMesh.name = 'streetlamp_bulbs_instanced';
      // EnvironmentCycle's collectNightAssets dedupes by material, so the
      // whole fleet becomes ONE night-drive entry (it was 57).
      bulbMesh.userData.isNightEmissive = true;
      bulbMesh.frustumCulled = false;
      for (let k = 0; k < lampMatrices.length; k++) {
        bodyMesh.setMatrixAt(k, lampMatrices[k]);
        bulbMesh.setMatrixAt(k, lampMatrices[k]);
      }
      bodyMesh.instanceMatrix.needsUpdate = true;
      bulbMesh.instanceMatrix.needsUpdate = true;
      // Parented to the island ROOT, not to `lamps`: the lampSites re-anchor
      // guard downstream compares lamps.children.length to lampSites.length,
      // and two extra children would silently disable it (leaving the roaming
      // night lights parked ~0.67u above every bulb).
      this.lampFleet = [bodyMesh, bulbMesh];
    }
    // (Electric wires removed: straight chord lines between lamps cut through
    // the planet and pierced props — they were designed for a flat town.)

    // Tiny NPC placeholders (spheres) near buildings to imply life
    const npcs = new THREE.Group();
    const npcPlaceholders: THREE.Mesh[] = [];
    const NPC_SITES: Array<[number, number]> = [
      // welcome greeters near the spawn plaza
      [0.5, 1.3],
      [2.2, 1.32],
      [4.0, 1.3],
      [5.5, 1.33],
      // NPC_SITES is zipped with NPC_PERSONALITIES by INDEX (see the pairing
      // below), so a site is effectively that persona's home. Indices 4 and 5
      // are the two Market Vendors: they used to live here in the Personal
      // hamlet while every stall they are meant to run stands in Contact, so
      // they wandered the wrong district and the bazaar was unstaffed. They
      // now stand BEHIND the middle stall of each row (the counters face the
      // street between the rows, so "behind" is away from it).
      [3.51 + SHIFT_CONTACT, 0.575],
      [3.95 + SHIFT_CONTACT, 0.575],
      [2.51 + SHIFT_PERSONAL, 0.32],
      [2.51 + SHIFT_PERSONAL, 0.6],
      [2.43 + SHIFT_PERSONAL, 0.53],
      // office crowd at the Professional plaza
      [6.11, 0.45],
      [0.17, 0.45],
      [0.0, 0.3],
      [6.21, 0.58],
      // builders at the Projects work sites
      [1.15 + SHIFT_PROJECTS, 0.45],
      // Index 14 is the Lighthouse Keeper. He used to live here in Projects,
      // the far side of the island from the tower he keeps at dirAt(5.4,
      // 0.34) — so `keep_light` was a marathon commute he never finished. He
      // lives at the foot of his own tower now, just off the rock plinth.
      [5.4, 0.42],
      [1.26 + SHIFT_PROJECTS, 0.32],
      // market-goers at the Contact stalls
      [3.69 + SHIFT_CONTACT, 0.51],
      [3.86 + SHIFT_CONTACT, 0.51],
      [3.77 + SHIFT_CONTACT, 0.36],
      // one wanderer out on the coastal road (the equator is ocean now)
      [5.0, 0.28],
      // the Sailor's LAND placeholder — GameScene.setupSailor() relocates him
      // onto his boat offshore (same relocate pattern as the Fisherman)
      [2.6, 0.31],
      // the Mayor holds court at the pole plaza
      [1.4, 1.36],
      // the Farmer works the hamlet's flower fields
      [2.9, 0.55],
      // the sailing crew's LAND placeholders — GameScene.setupSailors()
      // relocates each onto his own rowboat offshore. APPENDED at the end:
      // sites+personalities are zipped BY INDEX, never insert mid-list.
      [0.85, 0.31], // First Mate
      [4.15, 0.31], // Deckhand
      // Economy P1: the Carpenter — timber buyer (see the approved economy
      // spec). Sited in the Professional district off the boulevard; stays a
      // plain dialogue villager until Phase 2 wires his server persona+voice.
      [0.35, 0.56], // Carpenter
      [5.95, 1.22], // Teller — the bank site in the Welcome Hub (economy P2)
      [0.15, 0.66], // Nurse — beside the hospital site (economy P3)
    ];

    // TUCK THREE WORKPLACES AGAINST THEIR DISTRICT HALL.
    //
    // The town's workplaces read as sheds alone in fields because they stood
    // 10-13u from the nearest building. Measured distance to the nearest real
    // structure, before this: Guard 9.9u, Architect 12.6u, Mayor 12.7u — while
    // the Cartographer (4.0u), Courier (3.1u), Night Watch (3.1u) and Keeper
    // (5.1u) already had a stall or the lighthouse at their back and read fine.
    //
    // This moves the SITE, not just the props. A station publishes no activity
    // anchor — it is scenery placed where its persona already stands — so
    // moving a station alone would leave its owner behind, staring at nothing
    // from ten metres away. NPC_SITES is the shared origin for both the spawn
    // (below) and buildTownStations, so editing it here moves villager and
    // workplace together.
    //
    // Indices 0-3 are DELIBERATELY excluded: they are the welcome greeters at
    // the spawn plaza, and pulling two of them onto a hall wall would strip the
    // spot every visitor lands on.
    //
    // Hall wall radii are MEASURED from the built halls, because ZonesManager
    // builds them after createIsland and they cannot be queried from here.
    // They sit exactly at dirAt(district.lon, district.lat) — verified 0.00u
    // offset for four of five, 0.01u for Contact.
    const HALL_WALL_RADIUS: Record<string, number> = {
      welcome: 3.7,
      professional: 3.15,
      projects: 2.72,
      personal: 2.78,
      contact: 2.98,
    };
    // Gap from the hall's wall to the station's centre. The hall's COLLIDER is
    // only 1.7 and NPC avoidance triggers at radius+0.3, so the villager ends
    // up 2.7u+ clear of the push zone — nowhere near the grinding that anchors
    // authored on top of colliders used to cause.
    const HALL_STANDOFF = 1.75;
    const tuckAgainstHall = (siteIndex: number, districtId: string): void => {
      const district = DISTRICTS.find((d) => d.id === districtId);
      const site = NPC_SITES[siteIndex];
      if (!district || !site) return;
      const hall = this.dirAt(district.lon, district.lat).normalize();
      const lived = this.dirAt(site[0], site[1]).normalize();
      // Step off the hall along the tangent pointing at where this persona
      // ALREADY lives, so they end up against their own hall's nearest flank
      // rather than teleported to an arbitrary side of it.
      const tangent = lived.clone().addScaledVector(hall, -lived.dot(hall));
      if (tangent.lengthSq() < 1e-8) return; // already dead-centre on the hall
      tangent.normalize();
      const arc = ((HALL_WALL_RADIUS[districtId] ?? 3.2) + HALL_STANDOFF) / this.radius;
      // Sweep BEARINGS around the hall at that fixed distance, stepping away
      // from the persona's own side in alternating directions, and take the
      // first that is not on a road. The hall's avenues radiate from its
      // centre and are marked by lantern pillars at their departure points —
      // the Mayor's own bearing was 0.17 rad off one, which put a pillar
      // through the middle of his rostrum. Sweeping settles him BETWEEN two
      // avenues, which is also where a rostrum belongs: not blocking a road.
      let dir: THREE.Vector3 | null = null;
      for (let k = 0; k <= 24 && !dir; k++) {
        const offset = (k % 2 === 0 ? 1 : -1) * Math.ceil(k / 2) * 0.1;
        const swept = tangent.clone().applyAxisAngle(hall, offset).normalize();
        const cand = hall
          .clone()
          .multiplyScalar(Math.cos(arc))
          .addScaledVector(swept, Math.sin(arc))
          .normalize();
        if (this.isNearStreet(cand)) continue;
        dir = cand;
      }
      if (!dir) return; // hall ringed by roads — leave the persona where he was
      site[0] = Math.atan2(dir.z, dir.x);
      site[1] = Math.asin(THREE.MathUtils.clamp(dir.y, -1, 1));
    };
    tuckAgainstHall(8, 'personal'); // Guard -> Personal hall
    tuckAgainstHall(12, 'professional'); // Architect -> Professional hall
    tuckAgainstHall(21, 'welcome'); // Mayor -> the civic hall he holds court in

    const NPC_SHIRT_COLORS = [0x4488bb, 0xcc5544, 0x55aa55, 0xddaa33, 0x8866aa, 0xbb6644];
    const NPC_PERSONALITIES = [
      {
        name: 'Elder Sage',
        dialogue: [
          'Welcome to Life Island, traveller.',
          'Each zone tells a chapter of the story.',
          'Seek the glowing mailboxes — they hold deliveries for you.',
        ],
      },
      {
        name: 'Village Baker',
        dialogue: [
          'Nothing beats fresh bread on a tiny planet!',
          'The secret ingredient? Always butter.',
          'Come back anytime — the oven is always warm.',
        ],
      },
      {
        name: 'Island Explorer',
        dialogue: [
          'Have you found all five zones yet?',
          'The compass at the top points to your next delivery.',
          'Press E near a glowing mailbox to collect!',
        ],
      },
      {
        name: 'Young Student',
        dialogue: [
          "I'm learning TypeScript! It's amazing.",
          'Did you know this whole island runs on Three.js?',
          "One day I'll build my own world like this.",
        ],
      },
      {
        name: 'Market Vendor',
        dialogue: [
          'Fresh ideas, get your fresh ideas here!',
          'Special today: one-of-a-kind digital experiences.',
          'Browse the Project Portfolio zone for the full catalogue.',
        ],
      },
      {
        name: 'Market Vendor',
        dialogue: [
          'You look like someone who appreciates quality.',
          'Everything here is handcrafted, pixel by pixel.',
          'Tell your friends about Life Island!',
        ],
      },
      {
        name: 'Fisherman',
        dialogue: [
          'The waters here are unlike any other...',
          "Sometimes I wonder what's beyond the fog.",
          'Patience is the best algorithm.',
        ],
      },
      {
        name: 'Artist',
        dialogue: [
          'Look at how the light catches the terrain!',
          'Every pixel on this planet was placed with care.',
          'The zone markers... they pulse like a heartbeat.',
        ],
      },
      {
        name: 'Guard',
        dialogue: [
          'All clear! No bugs spotted today.',
          'Move along, citizen. Nothing to debug here.',
          'I keep watch over the render pipeline.',
        ],
      },
      {
        name: 'Storyteller',
        dialogue: [
          'Once upon a time, there was an empty sphere...',
          'Then the creator filled it with houses, trees, and dreams.',
          'And the people came, one visitor at a time.',
        ],
      },
      {
        name: 'Wanderer',
        dialogue: [
          '...',
          "I've walked every arc of this sphere.",
          'There are secrets in the spaces between zones.',
        ],
      },
      {
        name: 'Gardener',
        dialogue: [
          'These flowers bloom in every colour of the palette.',
          'A little water, a little sunlight, and voila!',
          'The trees sway even without wind. Magic, I say.',
        ],
      },
      {
        name: 'Architect',
        dialogue: [
          'I designed half the buildings on this island.',
          'The trick is making them sit on a curved surface.',
          'Every house is grounded to the terrain. No floating allowed!',
        ],
      },
      {
        name: 'Musician',
        dialogue: [
          "Can you hear the music? It's procedurally generated.",
          'Each note is chosen from a pentatonic scale.',
          'The birds? Also procedural. Nature imitates code.',
        ],
      },
      {
        name: 'Lighthouse Keeper',
        dialogue: [
          'The beacons guide delivery runners to their targets.',
          'Gold light means a package awaits.',
          "I've been keeping these lights running since version 1.0.",
        ],
      },
      {
        name: 'Tourist',
        dialogue: [
          'What a charming little planet!',
          'I came for the portfolio, stayed for the vibes.',
          'Have you tried walking all the way around?',
        ],
      },
      {
        name: 'Cartographer',
        dialogue: [
          'Five zones, twenty buildings, one sphere.',
          'The Welcome Hub is at the north pole.',
          'Everything else sits along the equator belt.',
        ],
      },
      {
        name: 'Philosopher',
        dialogue: [
          'Is the player walking on the planet...',
          '...or is the planet turning under the player?',
          'Either way, we are all spheres in the end.',
        ],
      },
      {
        name: 'Courier',
        dialogue: [
          'Another day, another delivery!',
          'The quest chain starts with the Welcome packages.',
          'Finish them all and you unlock something special.',
        ],
      },
      {
        name: 'Night Watch',
        dialogue: [
          'The lamps flicker at dusk. Have you noticed?',
          'Press E near a lamp to toggle it.',
          'I prefer the island at night. Quieter.',
        ],
      },
      {
        name: 'Sailor',
        dialogue: [
          'Ahoy! Finest little harbour on any sphere.',
          'The waves here follow real maths, you know.',
          'My brother keeps a beach house on the islet out south — tell him I said hello.',
          'Swim out sometime — the water is warmer than it looks.',
        ],
      },
      {
        name: 'Mayor',
        dialogue: [
          'Welcome, welcome! Every visitor makes the island bigger.',
          'The town hall is always open — that is a campaign promise.',
          'Deliveries up, complaints down. A fine term so far.',
        ],
      },
      {
        name: 'Farmer',
        dialogue: [
          'These fields feed the whole island, you know.',
          'Rain or shine — the code decides, and I adapt.',
          'The Gardener does the flowers. I do the honest crops.',
        ],
      },
      // Sailing crew — appended with their placeholder sites (index-zipped).
      {
        name: 'First Mate',
        dialogue: [
          'The Sailor taught me everything — except how to stay ashore.',
          'Watch the big liner out south. She never stops for anyone.',
          'A calm sea never made a good rower.',
        ],
      },
      {
        name: 'Deckhand',
        dialogue: [
          'First week on the water. The gulls still laugh at my rowing.',
          'One day I will crew that cruise ship. For now — this bucket.',
          'If you see fish jumping, throw them some feed. They remember.',
        ],
      },
      {
        name: 'Carpenter',
        dialogue: [
          'Good timber is worth more than gold out here. Well. Worth five coins.',
          'Fell a tree, bring me the wood. The rack takes ten a day before I am stocked.',
          'Stumps grow back. Give them five minutes and the island forgets the axe.',
        ],
      },
      {
        name: 'Teller',
        dialogue: [
          'Welcome to the Island Bank. Your vault survives any device — the pocket does not.',
          'Deposits go in on your word. Withdrawals come out on mine. That is the whole trick.',
          'No, we do not pay interest. Time is not a coin faucet here.',
        ],
      },
      {
        name: 'Nurse',
        dialogue: [
          'Checkups are ten coins and worth every one — sixty seconds of spring in your step.',
          'Drowning costs five. Swimming lessons are free: hold Space.',
          'The sea patrol fishes out more visitors than you would think.',
        ],
      },
    ];
    const npcSkinMat = new THREE.MeshStandardMaterial({ color: 0xf5c6a0, roughness: 0.7 });
    const npcShoeMat = Materials.createStandardMaterial({ color: 0x3d2b1a, roughness: 0.8 });
    const HAIR_COLORS = [0x3a2a1a, 0x8b6b3a, 0x222222, 0xcc8844, 0x5a3a2a, 0x1a1a2a];
    for (let i = 0; i < NPC_SITES.length; i++) {
      const dir = this.claimDir(this.dirAt(NPC_SITES[i][0], NPC_SITES[i][1]), this.arc(2.5));
      const npcGroup = new THREE.Group();
      const shirtMat = new THREE.MeshStandardMaterial({
        color: NPC_SHIRT_COLORS[i % NPC_SHIRT_COLORS.length],
        roughness: 0.6,
      });
      const pantsMat = Materials.createStandardMaterial({ color: 0x3a4a6a, roughness: 0.7 });
      // Torso
      const body = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.09, 0.22, 8), shirtMat);
      body.position.y = 0.32;
      body.castShadow = true;
      npcGroup.add(body);
      // Legs (two small cylinders)
      for (const lx of [-0.04, 0.04]) {
        const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.03, 0.2, 6), pantsMat);
        leg.position.set(lx, 0.1, 0);
        leg.castShadow = true;
        npcGroup.add(leg);
        const shoe = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.03, 0.07), npcShoeMat);
        shoe.position.set(lx, 0.0, 0.01);
        npcGroup.add(shoe);
      }
      // Arms (two small cylinders at sides)
      for (const ax of [-0.13, 0.13]) {
        const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.02, 0.18, 6), npcSkinMat);
        arm.position.set(ax, 0.28, 0);
        arm.rotation.z = ax > 0 ? -0.15 : 0.15;
        arm.castShadow = true;
        npcGroup.add(arm);
      }
      // Head
      const head = new THREE.Mesh(new THREE.SphereGeometry(0.09, 8, 8), npcSkinMat);
      head.position.y = 0.5;
      head.castShadow = true;
      npcGroup.add(head);
      // Eyes
      const eyeMat = new THREE.MeshStandardMaterial({ color: 0x1a1a2a });
      for (const ex of [-0.03, 0.03]) {
        const eye = new THREE.Mesh(new THREE.SphereGeometry(0.015, 5, 5), eyeMat);
        eye.position.set(ex, 0.52, 0.07);
        npcGroup.add(eye);
      }
      // Hair (half-sphere on top)
      const hairMat = new THREE.MeshStandardMaterial({
        color: HAIR_COLORS[i % HAIR_COLORS.length],
        roughness: 0.8,
      });
      const hair = new THREE.Mesh(
        new THREE.SphereGeometry(0.085, 8, 6, 0, Math.PI * 2, 0, Math.PI * 0.55),
        hairMat,
      );
      hair.position.y = 0.53;
      npcGroup.add(hair);

      const sampled = this.sampleSurfaceByDirection(dir, 0.02);
      npcGroup.position.copy(sampled.position);
      const q = new THREE.Quaternion().setFromUnitVectors(
        new THREE.Vector3(0, 1, 0),
        sampled.normal,
      );
      npcGroup.quaternion.copy(q);
      // Villager scale: raw build is ~0.6u; 2.6x → ~1.56u, a believable
      // adult next to the 1.8u player
      npcGroup.scale.setScalar(2.6);
      npcGroup.name = `npc_placeholder_${i}`;
      npcs.add(npcGroup);
      npcPlaceholders.push(npcGroup as unknown as THREE.Mesh);

      const personality = NPC_PERSONALITIES[i % NPC_PERSONALITIES.length];
      this.npcTargets.push({
        position: sampled.position.clone(),
        name: personality.name,
        dialogue: personality.dialogue,
        meshRef: npcGroup,
      });
    }

    // Floating sparkles around the planet surface — ONE InstancedMesh (was 30
    // separate meshes, each with its own geometry). They're purely decorative
    // and never animated per frame (GameScene only toggles the whole object's
    // .visible by camera distance, keyed off its name), so the scattered
    // positions bake straight into instance matrices. frustumCulled=false: the
    // instances wrap the entire planet shell, so all-or-nothing culling would
    // only ever flicker the layer on/off — cheaper to just always draw it.
    const SPARKLE_COUNT = Math.round(47 * areaScale(this.radius)); // near-free — one InstancedMesh
    const sparkleMat = new THREE.MeshBasicMaterial({
      color: 0xffffee,
      transparent: true,
      opacity: 0.55,
      // See the dust material below for the full reasoning: a transparent that
      // writes depth occludes whatever is drawn after it while being
      // see-through, and every other particle system here (bubbles, rain,
      // marine snow, the jelly bell) already sets this.
      depthWrite: false,
    });
    const particles = new THREE.InstancedMesh(
      new THREE.SphereGeometry(0.04, 4, 4),
      sparkleMat,
      SPARKLE_COUNT,
    );
    particles.name = 'ambient_sparkles';
    particles.frustumCulled = false;
    {
      const m = new THREE.Matrix4();
      for (let i = 0; i < SPARKLE_COUNT; i++) {
        const theta = Math.random() * Math.PI * 2;
        const phi = Math.acos(Math.random() * 2 - 1);
        const r = this.radius + 0.3 + Math.random() * 2;
        m.makeTranslation(
          r * Math.sin(phi) * Math.cos(theta),
          r * Math.sin(phi) * Math.sin(theta),
          r * Math.cos(phi),
        );
        particles.setMatrixAt(i, m);
      }
      particles.instanceMatrix.needsUpdate = true;
    }

    // Tiered fountain for the town square
    const fountain = new THREE.Group();
    const stoneMat = Materials.createTrimMaterial(0x888888);
    // Outer basin
    const outerBasin = new THREE.Mesh(new THREE.CylinderGeometry(2, 2.2, 0.5, 16), stoneMat);
    outerBasin.position.y = 0.25;
    fountain.add(outerBasin);
    // Inner rim
    const innerRim = new THREE.Mesh(new THREE.TorusGeometry(1.9, 0.1, 8, 16), stoneMat);
    innerRim.rotation.x = Math.PI / 2;
    innerRim.position.y = 0.52;
    fountain.add(innerRim);
    // Water surface
    const fWaterMat = new THREE.MeshStandardMaterial({
      color: 0x3399dd,
      transparent: true,
      opacity: 0.7,
      roughness: 0.05,
      metalness: 0.3,
      emissive: 0x1155aa,
      emissiveIntensity: 0.1,
    });
    // Ripple the two water discs' top surface — reuses the shared grass clock
    // (already ticked once/frame), so it's zero per-frame CPU and mints no new
    // material (census-safe). The fountain was dead static in the town square.
    fWaterMat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = this.grassTimeUniform;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nuniform float uTime;')
        .replace(
          '#include <begin_vertex>',
          [
            '#include <begin_vertex>',
            '  if (position.y > 0.0) {',
            '    transformed.y += 0.018 * sin(uTime * 3.0 + position.x * 4.2) * cos(uTime * 2.3 + position.z * 4.2);',
            '  }',
          ].join('\n'),
        );
    };
    const water = new THREE.Mesh(new THREE.CylinderGeometry(1.8, 1.8, 0.08, 16), fWaterMat);
    water.position.y = 0.5;
    fountain.add(water);
    // Central pillar
    const pillar = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.25, 1.2, 10), stoneMat);
    pillar.position.y = 1.0;
    fountain.add(pillar);
    // Upper basin
    const upperBasin = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.8, 0.25, 12), stoneMat);
    upperBasin.position.y = 1.65;
    fountain.add(upperBasin);
    // Upper water
    const upperWater = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.6, 0.06, 12), fWaterMat);
    upperWater.position.y = 1.78;
    fountain.add(upperWater);
    // Spout cap
    const cap = new THREE.Mesh(new THREE.SphereGeometry(0.15, 8, 8), stoneMat);
    cap.position.y = 2.0;
    fountain.add(cap);
    fountain.castShadow = true;
    fountain.name = 'town_fountain';
    // Village square centerpiece, at the edge of the Personal hamlet
    // (the old raw world coords stranded it near the north pole)
    this.placeObjectOnSurface(
      fountain,
      this.claimDir(this.dirAt(2.32 + SHIFT_PERSONAL, 0.5), this.arc(6)).multiplyScalar(
        this.radius,
      ),
      0.02,
      true,
    );

    // Stylized human statue
    const statue = new THREE.Group();
    const bronzeMat = Materials.createPBRMaterial({
      color: 0x8b6914,
      roughness: 0.5,
      metalness: 0.6,
    });
    const marbleMat = Materials.createTrimMaterial(0xd4cfc4);
    // Two-tier pedestal
    const pedestalBase = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.3, 1.0), marbleMat);
    pedestalBase.position.y = 0.15;
    statue.add(pedestalBase);
    const pedestalTop = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.45, 0.7, 10), marbleMat);
    pedestalTop.position.y = 0.65;
    statue.add(pedestalTop);
    // Figure: torso + head + outstretched arm
    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.2, 0.8, 8, 12), bronzeMat);
    torso.position.y = 1.5;
    statue.add(torso);
    const sHead = new THREE.Mesh(new THREE.SphereGeometry(0.15, 10, 10), bronzeMat);
    sHead.position.y = 2.1;
    statue.add(sHead);
    // Outstretched arm
    const sArm = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.05, 0.5, 6), bronzeMat);
    sArm.position.set(0.35, 1.7, 0);
    sArm.rotation.z = -Math.PI / 3;
    statue.add(sArm);
    // Forecourt of the Professional plaza (was stranded near the north
    // pole by raw world coords, same as the fountain)
    this.placeObjectOnSurface(
      statue,
      this.claimDir(this.dirAt(0.18, 0.52), this.arc(4)).multiplyScalar(this.radius),
      0.02,
      true,
    );
    statue.castShadow = true;
    statue.receiveShadow = true;
    statue.name = 'central_statue';

    // Add parked cars along the road — proper body + cabin + wheels
    const cars = new THREE.Group();
    const CAR_COLORS = [
      0xc44040, 0x4488bb, 0x55aa55, 0xddcc44, 0xbb6633, 0x8866aa, 0xdd7744, 0x557788,
    ];
    const wheelMat = Materials.createStandardMaterial({ color: 0x222222, roughness: 0.9 });
    const hubMat = Materials.createStandardMaterial({ color: 0x999999, metalness: 0.6 });
    const glassMat = new THREE.MeshStandardMaterial({
      color: 0x88bbdd,
      roughness: 0.1,
      metalness: 0.3,
      transparent: true,
      opacity: 0.6,
    });
    const bumperMat = Materials.createStandardMaterial({ color: 0x333333, roughness: 0.7 });
    for (let i = 0; i < 8; i++) {
      const carGroup = new THREE.Group();
      const carColor = CAR_COLORS[i % CAR_COLORS.length];
      const bodyMat = Materials.createTrimMaterial(carColor);
      // Lower body / chassis
      const chassis = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.4, 2.6), bodyMat);
      chassis.position.y = 0.35;
      chassis.castShadow = true;
      chassis.receiveShadow = true;
      carGroup.add(chassis);
      // Upper cabin (smaller, centered)
      const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.4, 1.4), bodyMat);
      cabin.position.set(0, 0.75, -0.2);
      cabin.castShadow = true;
      carGroup.add(cabin);
      // Windshield (front glass)
      const windshield = new THREE.Mesh(new THREE.PlaneGeometry(1.0, 0.35), glassMat);
      windshield.position.set(0, 0.75, 0.51);
      windshield.rotation.x = -0.15;
      carGroup.add(windshield);
      // Rear window
      const rearWin = new THREE.Mesh(new THREE.PlaneGeometry(1.0, 0.3), glassMat);
      rearWin.position.set(0, 0.75, -0.91);
      rearWin.rotation.x = Math.PI + 0.15;
      carGroup.add(rearWin);
      // Front bumper
      const fBumper = new THREE.Mesh(new THREE.BoxGeometry(1.35, 0.12, 0.15), bumperMat);
      fBumper.position.set(0, 0.2, 1.35);
      carGroup.add(fBumper);
      // Rear bumper
      const rBumper = new THREE.Mesh(new THREE.BoxGeometry(1.35, 0.12, 0.15), bumperMat);
      rBumper.position.set(0, 0.2, -1.35);
      carGroup.add(rBumper);
      // Headlights
      const headlightMat = new THREE.MeshStandardMaterial({
        color: 0xffffee,
        emissive: 0xffffcc,
        emissiveIntensity: 0.4,
      });
      for (const hx of [-0.45, 0.45]) {
        const hl = new THREE.Mesh(new THREE.SphereGeometry(0.08, 6, 6), headlightMat);
        hl.position.set(hx, 0.35, 1.31);
        hl.scale.set(1, 1, 0.5);
        carGroup.add(hl);
      }
      // Taillights
      const taillightMat = new THREE.MeshStandardMaterial({
        color: 0xff2222,
        emissive: 0xff0000,
        emissiveIntensity: 0.3,
      });
      for (const tx of [-0.45, 0.45]) {
        const tl = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.08, 0.04), taillightMat);
        tl.position.set(tx, 0.35, -1.31);
        carGroup.add(tl);
      }
      // 4 wheels (cylinder on side)
      const wheelGeo = new THREE.CylinderGeometry(0.2, 0.2, 0.12, 10);
      const hubGeo = new THREE.CylinderGeometry(0.08, 0.08, 0.13, 6);
      const WHEEL_POS: [number, number, number][] = [
        [-0.6, 0.15, 0.75],
        [0.6, 0.15, 0.75], // front L, R
        [-0.6, 0.15, -0.75],
        [0.6, 0.15, -0.75], // rear L, R
      ];
      // Wheels are parented to a hub pivot at the axle so the driving code
      // can SPIN them (roll) around local X and STEER the fronts around
      // local Y. A crossed spoke breaks the cylinder's symmetry so the roll
      // is actually visible.
      const spokeMat = Materials.createTrimMaterial(0xbfc4cc);
      for (let wi = 0; wi < WHEEL_POS.length; wi++) {
        const [wx, wy, wz] = WHEEL_POS[wi];
        const pivot = new THREE.Group();
        pivot.position.set(wx, wy, wz);
        pivot.name = 'car_wheel';
        pivot.userData.isWheel = true;
        pivot.userData.isFront = wz > 0;
        const wheel = new THREE.Mesh(wheelGeo, wheelMat);
        wheel.rotation.z = Math.PI / 2; // lay the cylinder onto the axle (local X)
        wheel.castShadow = true;
        pivot.add(wheel);
        const hub = new THREE.Mesh(hubGeo, hubMat);
        hub.rotation.z = Math.PI / 2;
        pivot.add(hub);
        for (let s = 0; s < 2; s++) {
          const spoke = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.03, 0.32), spokeMat);
          spoke.rotation.x = (s * Math.PI) / 2; // cross of two bars across the face
          pivot.add(spoke);
        }
        carGroup.add(pivot);
      }

      // Parallel-parked along the boulevard: kerbside spots in the blocks
      // between districts, alternating sides of the street. 2.43u off the
      // centreline IS the kerb — the boulevard is 1.0u wide plus verge, so this
      // is the tightest tolerance in the whole migration. At R=75 a bare
      // latitude puts them 3.6u out, parked in the grass beside the road.
      const KERB = this.arc(2.43);
      const CAR_SITES: Array<[number, number]> = [
        [0.72, ZONE_LAT - KERB],
        [1.02, ZONE_LAT + KERB],
        [1.62, ZONE_LAT - KERB],
        [2.21, ZONE_LAT + KERB],
        [3.1, ZONE_LAT - KERB],
        [3.35, ZONE_LAT + KERB],
        [4.3, ZONE_LAT - KERB],
        [5.55, ZONE_LAT + KERB],
      ];
      const [carLon, carLat] = CAR_SITES[i % CAR_SITES.length];
      // claimOffStreet, not claimDir: claimDir's jitter was nudging parked cars
      // off their kerb site onto the middle of the boulevard ribbon. This keeps
      // them at the roadside, clear of the walkable path.
      // 2.1u = the car's OWN footprint radius (1.89 x 3.77 after the 1.45 scale),
      // not the 4u it used to ask for. Clearance is mutual, so 2.1 still leaves
      // 4.2u between adjacent cars — a real parallel-parking gap. Asking for
      // double its own size meant a kerb spot almost never satisfied the claim,
      // and since the search reach is proportional to the clearance, it also
      // doubled how far the retry could throw the car from its kerb.
      const pos = this.claimOffStreet(this.dirAt(carLon, carLat), this.arc(2.1)).multiplyScalar(
        this.radius,
      );
      // +0.06 matches GameScene's drive-seat convention (wheel bottoms sit at
      // local −0.0725 after the pivot rework — the old +0.33 predates it and
      // hovered every car 0.26u even on flat ground). GameScene.initVehicles
      // re-seats parked cars on their four wheel contacts at scene init.
      const sampled = this.sampleSurfacePosition(pos, 0.06);
      carGroup.position.copy(sampled.position);
      // Scaled to the ~1.6u player: roof ~1.06u, length ~2.9u — a car the
      // person can plausibly get into (1.55 read oversized next to the
      // shrunk player).
      carGroup.scale.setScalar(1.45); // ~1.3u tall vs the 1.7u player (was 0.99u, toy-sized)
      // Plumb like the rest of the built world. A car does legitimately sit
      // on its road's slope, but the kerb sites are not all road: car_7 came
      // out at 38 degrees, which reads as crashed rather than parked.
      const carUp = sampled.position.clone().normalize();
      carGroup.quaternion.copy(
        new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), carUp),
      );
      // Nose ALONG the street (tangent of the boulevard), direction matching
      // the side of the road it's parked on — reads as kerbside parking
      this.faceObjectToward(
        carGroup,
        carUp,
        this.dirAt(carLon + (i % 2 === 0 ? 0.4 : -0.4), carLat).multiplyScalar(this.radius),
      );
      carGroup.castShadow = true;
      carGroup.name = `car_${i}`;
      cars.add(carGroup);
    }

    // Add market stalls near houses
    const stalls = new THREE.Group();
    // CONTACT district: a market street — stalls line BOTH kerbs of the
    // boulevard through the plaza (staggered rows so counters don't face
    // each other head-on), the classic two-sided bazaar strip.
    // Rows tightened to a ±3.5u kerb setback: the counters used to sit 8-9u off
    // the boulevard they face, so the "two-sided bazaar strip" read as scattered
    // tents. That regression comes straight back as a bare latitude — 3.5u
    // becomes 5.4u at R=75, most of the way back to the spacing this fixed.
    const STALL_SETBACK = this.arc(3.5);
    const STALL_SITES: Array<[number, number]> = [
      [3.51 + SHIFT_CONTACT, ZONE_LAT + STALL_SETBACK],
      [3.73 + SHIFT_CONTACT, ZONE_LAT + STALL_SETBACK],
      [3.95 + SHIFT_CONTACT, ZONE_LAT + STALL_SETBACK],
      // South row staggered in lon so counters don't face each other head-on.
      // Keep clear of the shoreline band (sin-lat 0.28) as the setback grows.
      [3.59 + SHIFT_CONTACT, ZONE_LAT - STALL_SETBACK],
      [3.81 + SHIFT_CONTACT, ZONE_LAT - STALL_SETBACK],
      [4.03 + SHIFT_CONTACT, ZONE_LAT - STALL_SETBACK],
    ];
    for (let i = 0; i < STALL_SITES.length; i++) {
      const stall = this.createStall();
      const [sLon, sLat] = STALL_SITES[i];
      const pos = this.claimOffStreet(this.dirAt(sLon, sLat), this.arc(3)).multiplyScalar(
        this.radius,
      );
      const sampled = this.sampleSurfacePosition(pos, -0.08); // sunk slightly: bury-not-float
      stall.position.copy(sampled.position);
      // NPC activity anchor = a customer's spot IN FRONT of the counter, not
      // the stall's own seat. The stall carries a 1.5-radius collider (1.8u
      // NPC keep-out), so the raw seat was unreachable and every persona
      // scheduled `market_visit` spent midday shoving the canvas. Stepped
      // 2.3u toward the equator, which is the open street side for both rows.
      // Shopper spot = the stall's ACTUAL seat rotated toward the boulevard,
      // which runs between the two rows. Two earlier versions of this were
      // wrong: stepping toward the equator put the south row's shopper behind
      // its own counter, and deriving from the raw lon/lat drifted whenever
      // claimOffStreet slid the stall to resolve a conflict (which then threw
      // the vendor derived from it ~3u off its own pitch).
      const stallDir = sampled.position.clone().normalize();
      const toStreet = this.dirAt(sLon, ZONE_LAT).sub(stallDir);
      toStreet.addScaledVector(stallDir, -toStreet.dot(stallDir)); // tangent
      const shopAng = 2.3 / this.radius;
      const shopDir =
        toStreet.lengthSq() > 1e-8
          ? stallDir
              .clone()
              .multiplyScalar(Math.cos(shopAng))
              .addScaledVector(toStreet.normalize(), Math.sin(shopAng))
              .normalize()
          : stallDir.clone();
      this.stallSites.push(shopDir.multiplyScalar(sampled.position.length()));
      // The stall's OWN seat, so the vendor can be stood behind this exact
      // counter (claimOffStreet may have slid it, so a hardcoded lat drifts).
      this.stallProps.push(sampled.position.clone());
      // Counter at ~0.66u working height for the 1.56u vendors
      stall.scale.setScalar(2.2); // ~3.7u incl. awning (~2.2x the 1.7u player) — already well-proportioned
      // PLUMB, not slope-normal. A market stall is a rigid built structure:
      // real ones stand vertical and their skirt hides the gap downhill (the
      // 0.9-deep ground skirt exists for exactly this). Leaning the whole
      // frame 24 degrees to match a hillside reads as a collapsing tent —
      // same rule the trees follow. The POSITION still tracks the terrain;
      // only the up-axis is radial.
      const stallUp = sampled.position.clone().normalize();
      stall.quaternion.copy(
        new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), stallUp),
      );
      // Counters face the market street (nearest boulevard point)
      this.faceObjectToward(stall, stallUp, this.dirAt(sLon, ZONE_LAT).multiplyScalar(this.radius));
      stall.castShadow = true;
      stall.receiveShadow = true;
      stall.name = `stall_${i}`;
      stalls.add(stall);
      // Outline Tier 1: skirt/table/roof only — posts and goods sit under the
      // 1.0 world-size floor (group scale 2.2 is already applied above).
      addGroupHulls(stall, 1.0, () => true);
    }

    // Signboards removed: unsupported flat planes floating at 0.8u read as
    // glitches (assets hovering in the air), not decor.
    const signboards = new THREE.Group();

    // Add rivers
    const rivers = new THREE.Group();
    // Both on the island (the second used to sit at lat -0.38 — seafloor now)
    const RIVER_SITES: Array<[number, number]> = [
      // 0.28 rad clear of the Contact plaza pre-claim (the old [4.62, 0.4]
      // was inside its claim arc, so claimDir always jittered it — sometimes
      // onto the boulevard).
      [4.45, 0.36],
      [0.72, 0.62],
    ];
    for (let i = 0; i < RIVER_SITES.length; i++) {
      const river = this.createRiver();
      const pos = this.claimDir(
        this.dirAt(RIVER_SITES[i][0], RIVER_SITES[i][1]),
        this.arc(10),
      ).multiplyScalar(this.radius);
      const sampled = this.sampleSurfacePosition(pos, 0.1);
      river.position.copy(sampled.position);
      river.quaternion.copy(
        new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), sampled.normal),
      );
      river.name = `river_${i}`;
      rivers.add(river);
      // Conform the flat plane to the curved terrain: a 10-unit chord floats at
      // its ends on an r=18 sphere, so project every vertex onto the surface.
      rivers.updateMatrixWorld(true);
      river.updateMatrixWorld(true);
      river.traverse((n) => {
        if (!(n instanceof THREE.Mesh)) return;
        const posAttr = n.geometry.attributes.position as THREE.BufferAttribute;
        const v = new THREE.Vector3();
        for (let vi = 0; vi < posAttr.count; vi++) {
          v.fromBufferAttribute(posAttr, vi).applyMatrix4(n.matrixWorld);
          const s = this.sampleSurfacePosition(v, 0.06);
          v.copy(s.position);
          n.worldToLocal(v);
          posAttr.setXYZ(vi, v.x, v.y, v.z);
        }
        posAttr.needsUpdate = true;
        n.geometry.computeVertexNormals();
      });
    }

    // Add mountains
    const mountains = new THREE.Group();
    // All on the island's upland ring (the old third site at lat -0.98 is
    // open ocean now)
    // The highland is TERRAIN now (the rolling PEAKS above), so there are no
    // scattered stand-alone mountain PROPS — they had no colliders (walk-through)
    // and sat near districts. Terrain hills collide naturally (player walks over).
    const MOUNTAIN_SITES: Array<[number, number]> = [];
    for (let i = 0; i < MOUNTAIN_SITES.length; i++) {
      const mountain = this.createMountain();
      const [mLon, mLat] = MOUNTAIN_SITES[i];
      const pos = this.claimDir(this.dirAt(mLon, mLat), this.arc(15)).multiplyScalar(this.radius);
      const sampled = this.sampleSurfacePosition(pos, -0.35); // bedded into terrain
      mountain.position.copy(sampled.position);
      mountain.quaternion.copy(
        new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), sampled.normal),
      );
      mountain.castShadow = true;
      mountain.receiveShadow = true;
      mountain.name = `mountain_${i}`;
      mountains.add(mountain);
    }

    // Add construction blocks
    const constructions = new THREE.Group();
    // PROJECTS district: work-in-progress sites near the Portfolio plaza
    // PROJECTS district: construction lots set back off the boulevard,
    // one per side of the street
    const WORK_SITES: Array<[number, number]> = [
      [1.05 + SHIFT_PROJECTS, 0.65],
      [1.46 + SHIFT_PROJECTS, 0.34],
      // levelled up to match the other districts' density (was only 2 lots)
      [0.95 + SHIFT_PROJECTS, 0.34],
      [1.55 + SHIFT_PROJECTS, 0.66],
      [1.25 + SHIFT_PROJECTS, 0.72],
    ];
    // One per site — names the world after the projects the panel describes.
    const PROJECT_LABELS = [
      'RankPilot',
      'ChocoMate',
      'DigiScalability',
      "Bano's Cookbook",
      'Insta Services',
    ];
    for (let i = 0; i < WORK_SITES.length; i++) {
      const block = this.createConstructionBlock(PROJECT_LABELS[i], i === 0);
      const pos = this.claimOffStreet(
        this.dirAt(WORK_SITES[i][0], WORK_SITES[i][1]),
        this.arc(6),
      ).multiplyScalar(this.radius);
      const sampled = this.sampleSurfacePosition(pos, -0.1); // block base sunk slightly
      block.position.copy(sampled.position);
      // WORLD LAW 1: a multi-storey work-site block stands PLUMB (measured up
      // to 5.5 deg of rake on the slope normal before this).
      block.quaternion.copy(
        new THREE.Quaternion().setFromUnitVectors(
          new THREE.Vector3(0, 1, 0),
          sampled.position.clone().normalize(),
        ),
      );
      block.castShadow = true;
      block.receiveShadow = true;
      block.name = `construction_${i}`;
      constructions.add(block);
    }

    // Flowers — instanced for batching. Each bloom is a stem + 5-petal ring +
    // center of identical static geometry, so instead of ~7 meshes per flower
    // (168 draw calls) we scatter placements once, then render each part family
    // as a single InstancedMesh: 1 stem batch + 1 center batch + one petal
    // batch per colour (~7 draw calls total). Petals bucket by colour so each
    // keeps its own emissive tint (instanceColor can't drive emissive).
    // ⚠️ FROZEN AT BUILD END: the whole `flowers` subtree gets matrixAutoUpdate
    // off (see the static-matrix-freeze pass before `return root`). Anything
    // added here that ANIMATES ITS TRANSFORM must set userData.animated = true
    // (or .dynamic) on that object, or it will be pinned in place.
    const flowers = new THREE.Group();
    flowers.name = 'flowers';
    // One flower hue PER DISTRICT (anchors below are the 4 plazas + the pole),
    // ordered to match FLOWER_ANCHORS: professional=blue, projects=marigold,
    // personal=pink, contact=lavender, welcome=daisy-yellow. So the ring of
    // blooms around each plaza reinforces that district's identity.
    const FLOWER_COLORS = [0x6f9fe0, 0xf4a940, 0xff69b4, 0xb46bd8, 0xf4e04d];
    const stemMat = Materials.createStandardMaterial({ color: 0x3d7a3d });
    // Instanced grass-style sway for the blooms — per-flower phase from the
    // instance position, keyed by height so the stem base stays planted and the
    // head bobs. Injected into the EXISTING materials (no new alloc → census-safe)
    // and reuses the shared grass clock (zero per-frame CPU). Works while the
    // flowers subtree is matrix-frozen (shader never touches the transform).
    const flowerSway = (mat: THREE.Material, headOnly: boolean): void => {
      mat.onBeforeCompile = (shader) => {
        shader.uniforms.uTime = this.grassTimeUniform;
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', '#include <common>\nuniform float uTime;')
          .replace(
            '#include <begin_vertex>',
            [
              '#include <begin_vertex>',
              '#ifdef USE_INSTANCING',
              '  float fPh = instanceMatrix[3].x * 1.6 + instanceMatrix[3].z * 2.1;',
              '  float fBend = sin(uTime * 1.7 + fPh) + 0.4 * sin(uTime * 2.9 + fPh);',
              headOnly
                ? '  float fH = 1.0;'
                : '  float fH = clamp((position.y + 0.125) / 0.25, 0.0, 1.0);',
              '  transformed.x += fBend * 0.022 * fH;',
              '  transformed.z += fBend * 0.012 * fH;',
              '#endif',
            ].join('\n'),
          );
      };
    };
    flowerSway(stemMat, false);
    const FLOWER_ANCHORS: Array<[number, number]> = [
      ...DISTRICT_LONS.map((l) => [l, ZONE_LAT] as [number, number]),
      // Welcome anchor sits on the plaza APRON (lon 0.9, lat 1.38), not at
      // [0, 1.42] where the ring straddled the spawn point and the hall.
      [0.9, 1.38],
    ];
    // The Gardener works ONE real garden, not ten coordinates spread over the
    // whole planet. The old anchors were two off-ring points per plaza — 11-12u
    // out from each centre while the blooms only reach 7.5-10u, so she knelt in
    // bare grass BESIDE the flowers, at sites in five districts up to 78u
    // apart. She spent her life hiking; the owner's words were "the gardener
    // just wandering around... there is no garden".
    this.buildGarden(3.05, 0.52, flowers);
    // The Farmer grows FOOD, on his own land. He used to run the very same
    // `tend_flowers` activity against the very same anchors as the Gardener,
    // so two people knelt at the same patches — "same thing with other npcs".
    // His own dialogue already draws the line: the Gardener does flowers, he
    // does honest crops.
    // Out past the hamlet's last cottage, not wedged between the houses and
    // the garden: a 6.4u-long field needs real room, and a bigger claim arc
    // makes claimOffStreet look further for a clear plot.
    this.buildFarm(2.42, 0.68, flowers);
    // The Musician's stage sits on the welcome apron (where play_music already
    // pointed) and the Artist's easel on the headland her vista already used.
    this.buildBandstand(1.15, 1.3, flowers);
    this.buildEasel(5.32, 0.315, flowers);
    // Everyone else gets their workplace too, built AT their spawn site so no
    // activity or anchor has to change — the props simply appear where the
    // persona already stands and works.
    this.buildTownStations(NPC_SITES, flowers);
    // Pass 1: scatter valid placements (respecting street skips) + colour index
    const bloomUp = new THREE.Vector3(0, 1, 0);
    const bloomOne = new THREE.Vector3(1, 1, 1);
    const blooms: Array<{ mat: THREE.Matrix4; c: number }> = [];
    for (let i = 0; i < 50; i++) {
      const [fLon, fLat] = FLOWER_ANCHORS[Math.floor(i / 10)];
      const ringA = ((i % 10) / 10) * Math.PI * 2;
      // cos(lat) correction keeps the ring CIRCULAR near the pole (raw lon
      // deltas collapsed the welcome ring into a 3u-wide streak).
      // A 10u x 7.5u bed, not an angular one: these anchor every butterfly and
      // three fireflies each, so the ring growing to 15u would scatter the
      // insects that are supposed to be hovering over it.
      const fDir = this.dirAt(
        fLon + (Math.cos(ringA) * this.arc(10)) / Math.cos(fLat),
        fLat + Math.sin(ringA) * this.arc(7.5),
      );
      // Plaza flower rings cross the boulevard — keep blooms off the pavement
      if (this.isNearStreet(fDir)) continue;
      const pos = this.claimDir(fDir, this.arc(0.75)).multiplyScalar(this.radius);
      const sampled = this.sampleSurfacePosition(pos, 0.1);
      const quat = new THREE.Quaternion().setFromUnitVectors(bloomUp, sampled.normal);
      blooms.push({
        mat: new THREE.Matrix4().compose(sampled.position.clone(), quat, bloomOne),
        // Bucket by ANCHOR (= district) instead of cycling all hues at every
        // plaza, so each district's ring is a single identity colour.
        c: Math.floor(i / 10),
      });
      // Every ~8th flower anchors a butterfly cluster (see GameScene)
      if (i % 8 === 0) this.flowerSites.push(sampled.position.clone());
    }

    // Pass 2: build the instanced part batches (world = bloom * partLocal)
    if (blooms.length > 0) {
      const out = new THREE.Matrix4();
      const addBatch = (
        geo: THREE.BufferGeometry,
        mat: THREE.Material,
        name: string,
        picks: number[],
        locals: THREE.Matrix4[],
      ) => {
        const im = new THREE.InstancedMesh(geo, mat, picks.length * locals.length);
        let k = 0;
        for (const i of picks) {
          for (const local of locals) {
            im.setMatrixAt(k++, out.multiplyMatrices(blooms[i].mat, local));
          }
        }
        im.instanceMatrix.needsUpdate = true;
        im.name = name;
        flowers.add(im);
      };
      const all = blooms.map((_, i) => i);
      // Stem: cylinder centred at local y=0.125
      addBatch(new THREE.CylinderGeometry(0.02, 0.025, 0.25, 5), stemMat, 'flower_stems', all, [
        new THREE.Matrix4().makeTranslation(0, 0.125, 0),
      ]);
      // Center: yellow sphere at local y=0.27
      const centerMat = new THREE.MeshStandardMaterial({
        color: 0xffdd44,
        emissive: 0xffdd44,
        emissiveIntensity: 0.3,
      });
      flowerSway(centerMat, true); // rides the flower head
      addBatch(new THREE.SphereGeometry(0.04, 6, 6), centerMat, 'flower_centers', all, [
        new THREE.Matrix4().makeTranslation(0, 0.27, 0),
      ]);
      // Petals: 5 spheres in a ring, scaled flat, one batch per colour
      const petalGeo = new THREE.SphereGeometry(0.05, 6, 6);
      const petalLocals: THREE.Matrix4[] = [];
      for (let p = 0; p < 5; p++) {
        const pa = (p / 5) * Math.PI * 2;
        petalLocals.push(
          new THREE.Matrix4()
            .makeTranslation(Math.cos(pa) * 0.06, 0.27, Math.sin(pa) * 0.06)
            .multiply(new THREE.Matrix4().makeScale(1.2, 0.6, 1.2)),
        );
      }
      for (let c = 0; c < FLOWER_COLORS.length; c++) {
        const picks = all.filter((i) => blooms[i].c === c);
        if (!picks.length) continue;
        const color = FLOWER_COLORS[c];
        const petalMat = new THREE.MeshStandardMaterial({
          color,
          emissive: color,
          emissiveIntensity: 0.15,
        });
        flowerSway(petalMat, true); // petals ride the flower head with the center
        addBatch(petalGeo, petalMat, `flower_petals_${c}`, picks, petalLocals);
      }
    }

    // Add signs for shops/buildings
    const signs = new THREE.Group();
    // (small floating sign planes removed for the same reason)
    // Hanging shop signs at the plaza approaches — a plumb post + a side arm + a
    // board that swings in the wind. SHIELDED (local rng → shared stream + golden
    // census unchanged). The board GROUPS are registered on this.hangSigns; the
    // per-frame swing lives in GameScene.update (signs sit on `root`, never
    // matrix-frozen). Plumb radial up (World Law 1: signposts STAND).
    {
      const stashedRandom = Math.random;
      let hseed = 0x51617a3b >>> 0;
      Math.random = () => {
        hseed = (hseed + 0x6d2b79f5) >>> 0;
        let t = Math.imul(hseed ^ (hseed >>> 15), 1 | hseed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
      try {
        const ramp = Materials.toonRamp();
        const postMat = new THREE.MeshToonMaterial({ color: 0x7a5a38, gradientMap: ramp });
        const boardMat = new THREE.MeshToonMaterial({
          color: 0xcaa367,
          gradientMap: ramp,
          side: THREE.DoubleSide,
        });
        const SIGN_LABELS = ['🛖 Market', '☕ Café', '🍞 Bakery', '🎨 Studio', '✉ Post'];
        const AXIS_Y = new THREE.Vector3(0, 1, 0);
        for (let s = 0; s < DISTRICT_LONS.length && s < SIGN_LABELS.length; s++) {
          const dir = this.dirAt(
            DISTRICT_LONS[s] + this.arc(6) / Math.cos(ZONE_LAT),
            ZONE_LAT - this.arc(4.5),
          );
          if (this.isNearStreet(dir)) continue;
          const cd = this.claimDir(dir, this.arc(1.2)).multiplyScalar(this.radius);
          const sampled = this.sampleSurfacePosition(cd, 0.0);
          const scRoot = new THREE.Group();
          scRoot.position.copy(sampled.position);
          scRoot.quaternion.setFromUnitVectors(AXIS_Y, sampled.position.clone().normalize());
          const post = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.09, 2.4, 6), postMat);
          post.position.y = 1.2;
          post.castShadow = true;
          const arm = new THREE.Mesh(new THREE.BoxGeometry(0.86, 0.08, 0.08), postMat);
          arm.position.set(0.36, 2.28, 0);
          arm.castShadow = true;
          // Board hangs from the arm END and swings about local X (the arm axis).
          const board = new THREE.Group();
          board.position.set(0.7, 2.24, 0);
          const plank = new THREE.Mesh(new THREE.BoxGeometry(0.68, 0.44, 0.05), boardMat);
          plank.position.y = -0.32;
          plank.castShadow = true;
          const linkGeo = new THREE.CylinderGeometry(0.012, 0.012, 0.16, 4);
          const linkL = new THREE.Mesh(linkGeo, postMat);
          linkL.position.set(-0.22, -0.04, 0);
          const linkR = new THREE.Mesh(linkGeo, postMat);
          linkR.position.set(0.22, -0.04, 0);
          const cv = document.createElement('canvas');
          cv.width = 160;
          cv.height = 96;
          const ctx = cv.getContext('2d');
          if (ctx) {
            ctx.fillStyle = '#3a2a17';
            ctx.font = 'bold 30px system-ui, -apple-system, sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(SIGN_LABELS[s], 80, 48);
          }
          const tex = new THREE.CanvasTexture(cv);
          tex.colorSpace = THREE.SRGBColorSpace;
          const face = new THREE.Mesh(
            new THREE.PlaneGeometry(0.62, 0.38),
            new THREE.MeshBasicMaterial({ map: tex, transparent: true }),
          );
          face.position.set(0, -0.32, 0.03);
          board.add(plank, linkL, linkR, face);
          scRoot.add(post, arm, board);
          signs.add(scRoot);
          this.hangSigns.push({ group: board, phase: Math.random() * Math.PI * 2 });
        }
      } finally {
        Math.random = stashedRandom;
      }
    }

    // Add dust/pollen particles for ambiance — ONE InstancedMesh (was 80
    // separate meshes). Same rationale as the sparkles above: decorative,
    // never animated, whole-object visibility toggle keyed off the name.
    const DUST_COUNT = Math.round(125 * areaScale(this.radius)); // near-free — one InstancedMesh
    const dustMat = new THREE.MeshBasicMaterial({
      color: 0xeeddaa,
      transparent: true,
      opacity: 0.35,
      /*
       * A transparent material that WRITES DEPTH occludes everything drawn
       * after it while being see-through itself. Both ambient shells have
       * their object origin at the planet centre, so they sort at ~103u and
       * draw early among the transparents — before every pooled effect,
       * bubble, sprite label and chat pin, all of which were created later and
       * sort by their own real distance.
       *
       * MEASURED IMPACT: none. Flipping this flag on a live frame and diffing
       * the framebuffer gave 0 changed pixels at spawn, 0 across a 10-pose
       * sweep around the island, 0 with a sprite deliberately staged behind a
       * mote, and 0 with the camera 0.4u from a mote (41px on screen). The
       * reason is structural: the motes are scattered at radius+0.3..4.5 over
       * the WHOLE sphere while the terrain rises to radius+18, so most of them
       * are buried in opaque ground that already occludes them correctly, and
       * the transparents they could clip are mostly inactive pool slots at
       * opacity 0.
       *
       * So this is a consistency fix and a removed landmine, not a bug fix —
       * every other particle system in the project (bubbles, rain/snow, marine
       * snow, the jellyfish bell) already sets depthWrite:false, and these two
       * were the last exceptions.
       */
      depthWrite: false,
    });
    const dustParticles = new THREE.InstancedMesh(
      new THREE.SphereGeometry(0.03, 4, 4),
      dustMat,
      DUST_COUNT,
    );
    dustParticles.name = 'ambient_dust';
    dustParticles.frustumCulled = false;
    {
      const m = new THREE.Matrix4();
      for (let i = 0; i < DUST_COUNT; i++) {
        const theta = Math.random() * Math.PI * 2;
        const phi = Math.acos(Math.random() * 2 - 1);
        const r = this.radius + 0.5 + Math.random() * 4;
        m.makeTranslation(
          r * Math.sin(phi) * Math.cos(theta),
          r * Math.sin(phi) * Math.sin(theta),
          r * Math.cos(phi),
        );
        dustParticles.setMatrixAt(i, m);
      }
      dustParticles.instanceMatrix.needsUpdate = true;
    }

    // Park benches near zone plazas
    const benches = new THREE.Group();
    // Benches at the plazas: [lon, lat, latOfPlazaTheyFace]
    // 4.6u from the pole at the plaza rim — the old 10.5u stranded the welcome
    // benches out facing a distant floor. The literal 1.478 was the FROZEN
    // EVALUATION of exactly this expression at R=50; the lantern pillars beside
    // these benches already derive theirs, so at R=75 the two drifted 2u apart
    // and the benches stepped off the (fixed 5.0u) plaza floor entirely.
    const POLE_BENCH_LAT = Math.PI / 2 - this.arc(4.6);
    const BENCH_SITES: Array<[number, number, number]> = [
      [0.8, POLE_BENCH_LAT, 1.5708],
      [3.9, POLE_BENCH_LAT, 1.5708], // welcome / spawn
      [2.44 + SHIFT_PERSONAL, ZONE_LAT - this.arc(3.2), ZONE_LAT],
      [2.6 + SHIFT_PERSONAL, ZONE_LAT - this.arc(3.2), ZONE_LAT],
      [2.51 + SHIFT_PERSONAL, ZONE_LAT + this.arc(4.8), ZONE_LAT], // village
      [6.16, ZONE_LAT - this.arc(3.2), ZONE_LAT],
      [0.13, ZONE_LAT - this.arc(2.2), ZONE_LAT], // professional
      [1.18 + SHIFT_PROJECTS, ZONE_LAT - this.arc(2.2), ZONE_LAT],
      [1.32 + SHIFT_PROJECTS, ZONE_LAT - this.arc(2.2), ZONE_LAT], // projects (was benchless)
      [3.7 + SHIFT_CONTACT, ZONE_LAT - this.arc(2.2), ZONE_LAT],
      [3.85 + SHIFT_CONTACT, ZONE_LAT - this.arc(2.2), ZONE_LAT], // market
    ];
    const benchWoodMat = new THREE.MeshStandardMaterial({ color: 0x8b6b42, roughness: 0.7 });
    const benchLegMat = Materials.createTrimMaterial(0x444444);
    for (let i = 0; i < BENCH_SITES.length; i++) {
      // Benches belong BESIDE the plaza paths, not on them. Claim clearance
      // FIRST, then slide off any pavement — doing it the other way round let
      // claimDir's jitter shove the bench back onto the street.
      const bDir = this.pushOffStreet(
        this.claimDir(this.dirAt(BENCH_SITES[i][0], BENCH_SITES[i][1]), this.arc(5)),
      );
      const bSampled = this.sampleSurfaceByDirection(bDir, 0.0);
      const bench = new THREE.Group();
      // Real park-bench dimensions vs the 1.8u player: 1.7u long,
      // 0.45u seat height, backrest to ~1.0u with a comfortable tilt
      const seat = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.07, 0.5), benchWoodMat);
      seat.position.y = 0.45;
      seat.castShadow = true;
      bench.add(seat);
      const back = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.5, 0.06), benchWoodMat);
      back.position.set(0, 0.76, -0.25);
      back.rotation.x = -0.15;
      back.castShadow = true;
      bench.add(back);
      for (const lx of [-0.72, 0.72]) {
        const leg = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.45, 0.42), benchLegMat);
        leg.position.set(lx, 0.225, 0);
        bench.add(leg);
      }
      bench.position.copy(bSampled.position);
      this.benchSites.push(bSampled.position.clone()); // NPC activity anchor (bench rest)
      // WORLD LAW 1: rigid furniture stands PLUMB — and faceObjectToward takes
      // the SAME axis, or its premultiply re-tilts what was just made vertical.
      const bPlumb = bSampled.position.clone().normalize();
      const bq = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), bPlumb);
      bench.quaternion.copy(bq);
      // Face the plaza this bench belongs to (seat toward it, backrest away)
      this.faceObjectToward(
        bench,
        bPlumb,
        this.dirAt(BENCH_SITES[i][0], BENCH_SITES[i][2]).multiplyScalar(this.radius),
      );
      bench.name = `bench_${i}`;
      bench.castShadow = true;
      benches.add(bench);
      // Outline Tier 1: seat + back (legs fall under the 0.4 size floor).
      addGroupHulls(bench, 0.4, () => true);
    }

    // Instanced wind-blown grass across the whole planet
    const grass = this.createGrass();

    // District amenities + building planters (expansion slices 2-3). Parented
    // to `flowers` DELIBERATELY: that group is skipped by seatGroupsOnTerrain,
    // and both builders self-seat every piece. Both shield the RNG stream.
    this.buildDistrictAmenities(flowers);
    this.buildBuildingPlanters(flowers, houses, buildings, stalls);

    // ── Welcome Plaza: the hub centerpiece ────────────────────────────
    // All four avenues radiate from the north-pole spawn, but the hub held
    // only benches + the zone marker — a hub-and-spoke plan with an empty
    // centre never reads as a place. Lay a paved plaza and four lantern
    // pillars that mark where each avenue departs, framing the marker beam.
    const welcomePlaza = new THREE.Group();
    welcomePlaza.name = 'welcome_plaza';
    const plazaStone = Materials.createTrimMaterial(0xb8b0a4);
    const plazaTrim = Materials.createTrimMaterial(0x9a9186);
    const plazaBase = new THREE.Group();
    // r5.0/5.1 (was 3.4/3.5): the town hall's own foundation slab spans
    // ~r3.6, so the old floor was entirely swallowed by it and the pillars
    // pierced the slab rim. The bigger apron also gives the moved-out
    // pillars (4.6u) pavement to stand on.
    const plazaFloor = new THREE.Mesh(new THREE.CylinderGeometry(5.0, 5.1, 0.1, 48), plazaStone);
    plazaFloor.receiveShadow = true;
    plazaFloor.userData.isPavement = true; // dims with the streets at night
    plazaBase.add(plazaFloor);
    const plazaRing = new THREE.Mesh(new THREE.TorusGeometry(4.55, 0.1, 8, 48), plazaTrim);
    plazaRing.rotation.x = Math.PI / 2;
    plazaRing.position.y = 0.06;
    plazaRing.userData.isPavement = true;
    plazaBase.add(plazaRing);
    this.placeObjectOnSurface(
      plazaBase,
      new THREE.Vector3(0, 1, 0).multiplyScalar(this.radius),
      0.03,
      true,
    );
    // Conform the plaza slab to the sphere: a flat r5.1 disc on a R=75 ball
    // floats its rim by d²/2R ≈ 0.17u of pure tangent sag (measured
    // +0.15..0.19 — a visible lip where the avenues meet the pavement).
    // Bend every vertex so its height ABOVE THE TANGENT PLANE becomes its
    // height above the real terrain along its own radial. In-place vertex
    // edit — no new allocations, so the seeded ambient stream is untouched.
    {
      plazaBase.updateMatrixWorld(true);
      const seatPos = plazaBase.getWorldPosition(new THREE.Vector3());
      const polarUp = seatPos.clone().normalize();
      const v = new THREE.Vector3();
      const n = new THREE.Vector3();
      for (const m of [plazaFloor, plazaRing]) {
        const pos = m.geometry.attributes.position as THREE.BufferAttribute;
        for (let vi = 0; vi < pos.count; vi++) {
          v.fromBufferAttribute(pos, vi);
          m.localToWorld(v);
          const h = v.clone().sub(seatPos).dot(polarUp);
          const dirV = v.clone().normalize();
          const r = this.analyticSurfaceInto(dirV, n);
          v.copy(dirV).multiplyScalar(r + 0.03 + Math.max(0, h));
          m.worldToLocal(v);
          pos.setXYZ(vi, v.x, v.y, v.z);
        }
        pos.needsUpdate = true;
        m.geometry.computeVertexNormals();
        m.geometry.computeBoundingSphere();
      }
    }
    welcomePlaza.add(plazaBase);
    // Four lantern pillars at the avenue departure points — they mark the
    // roads out and frame the central marker beam. Placed toward each
    // DISTRICT_LON so they stay locked to the avenues if districts respace.
    const pillarStone = Materials.createTrimMaterial(0xa89f92);
    for (let pi = 0; pi < DISTRICT_LONS.length; pi++) {
      const dLon = DISTRICT_LONS[pi];
      const pillar = new THREE.Group();
      pillar.name = `pillar_${pi}`; // named so GameScene registers a collider (no walk-through)
      const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.24, 2.1, 8), pillarStone);
      shaft.position.y = 1.05;
      shaft.castShadow = true;
      pillar.add(shaft);
      const capBase = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.16, 0.44), pillarStone);
      capBase.position.y = 2.2;
      pillar.add(capBase);
      const lantern = new THREE.Mesh(
        new THREE.SphereGeometry(0.2, 12, 12),
        new THREE.MeshStandardMaterial({
          color: 0xffdf9a,
          emissive: 0xffb347,
          emissiveIntensity: 0.9,
          roughness: 0.4,
        }),
      );
      lantern.position.y = 2.5;
      lantern.userData.isNightEmissive = true; // EnvironmentCycle lights it at night, dims by day
      pillar.add(lantern);
      this.placeObjectOnSurface(
        pillar,
        this.dirAt(dLon, Math.PI / 2 - 4.6 / this.radius).multiplyScalar(this.radius), // ~4.6u out: clear of the hall's slab, still on the enlarged plaza apron
        0.0,
        true,
      );
      welcomePlaza.add(pillar);
    }

    // District entry gates — a framed arch at the head of each avenue where it
    // meets a ring district. Two stone posts straddle the path, a crossbeam
    // carries the district name, and an accent lantern crowns it. Same stone
    // kit as the hub pillars, so the town reads as one set of streets with
    // signed neighbourhoods rather than four disconnected clusters. Placed a
    // little POLEWARD of each plaza (8u) so you walk UNDER the
    // sign entering a district — and well north of the race lines (lat 0.38 /
    // 0.12) so a gate never fouls a lap.
    const gates = new THREE.Group();
    const gateStone = Materials.createTrimMaterial(0xb2a894);
    const RING_DISTRICTS = DISTRICTS.filter((d) => d.id !== 'welcome');
    const GATE_HALF_WIDTH = 2.1; // post centres 4.2u apart — frames the ~2u avenue with clearance
    for (let gi = 0; gi < RING_DISTRICTS.length; gi++) {
      const d = RING_DISTRICTS[gi];
      const gate = new THREE.Group();
      gate.name = `district_gate_${gi}`;
      // Posts at local ±X. After the gate is faced down the avenue below, local
      // +X becomes "across the street", so the two posts straddle the path.
      const postGeom = new THREE.CylinderGeometry(0.09, 0.12, 2.2, 8);
      const capGeom = new THREE.BoxGeometry(0.3, 0.12, 0.3);
      for (let side = 0; side < 2; side++) {
        const post = new THREE.Group();
        const shaft = new THREE.Mesh(postGeom, gateStone);
        shaft.position.y = 1.1;
        shaft.castShadow = true;
        post.add(shaft);
        const cap = new THREE.Mesh(capGeom, gateStone);
        cap.position.y = 2.26;
        post.add(cap);
        post.position.set(side === 0 ? -GATE_HALF_WIDTH : GATE_HALF_WIDTH, 0, 0);
        post.name = `gatepost_${gi * 2 + side}`; // GameScene registers a collider off this name
        gate.add(post);
      }
      // Crossbeam spanning the posts
      const beam = new THREE.Mesh(
        new THREE.BoxGeometry(GATE_HALF_WIDTH * 2 + 0.3, 0.26, 0.26),
        gateStone,
      );
      beam.position.set(0, 2.45, 0);
      beam.castShadow = true;
      gate.add(beam);
      // Name board on the beam — two back-to-back FrontSide planes so the name
      // reads correctly both approaching (from the pole) and leaving (from the plaza).
      const canvas = document.createElement('canvas');
      canvas.width = 512;
      canvas.height = 128;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        const accentHex = `#${d.accent.toString(16).padStart(6, '0')}`;
        ctx.fillStyle = 'rgba(20,26,38,0.9)';
        ctx.fillRect(0, 0, 512, 128);
        ctx.strokeStyle = accentHex;
        ctx.lineWidth = 6;
        ctx.strokeRect(5, 5, 502, 118);
        ctx.fillStyle = '#f2f6ff';
        ctx.font = 'bold 64px system-ui, "Segoe UI", sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(d.radar, 256, 68);
        const tex = new THREE.CanvasTexture(canvas);
        tex.colorSpace = THREE.SRGBColorSpace;
        // Gate boards are read OBLIQUELY while walking past — anisotropy 4
        // keeps the 64px lettering crisp at an angle (default 1 smears it).
        tex.anisotropy = 4;
        // Unlit so the name stays legible at any hour (matches the project
        // plaques' sprites). Two back-to-back FrontSide planes replace the old
        // single DoubleSide plane: DoubleSide shows the texture MIRRORED from
        // behind, and the gate's +Z faces its PLAZA (faceObjectToward below),
        // so the title read backwards to players arriving from the pole. The
        // -Z face is the one the approach reads — same convention as the zone
        // building's door (+Z toward the pole). Shared geometry + material.
        const boardGeom = new THREE.PlaneGeometry(1.8, 0.45);
        const boardMat = new THREE.MeshBasicMaterial({ map: tex, transparent: true });
        const board = new THREE.Mesh(boardGeom, boardMat);
        board.position.set(0, 2.45, 0.16);
        board.name = 'gate-board';
        board.raycast = () => {}; // decorative — skip interaction/camera rays
        gate.add(board);
        const boardBack = new THREE.Mesh(boardGeom, boardMat);
        boardBack.position.set(0, 2.45, -0.16);
        boardBack.rotation.y = Math.PI; // front toward the pole — read on approach
        boardBack.name = 'gate-board';
        boardBack.raycast = () => {}; // decorative — skip interaction/camera rays
        gate.add(boardBack);
      }
      // Accent lantern crowning the gate — night-emissive, NO PointLight (the
      // rig is already at its 16-light budget).
      const lantern = new THREE.Mesh(
        new THREE.SphereGeometry(0.15, 12, 12),
        new THREE.MeshStandardMaterial({
          color: d.accent,
          emissive: d.accent,
          emissiveIntensity: 0.9,
          roughness: 0.4,
        }),
      );
      lantern.position.set(0, 2.72, 0);
      lantern.userData.isNightEmissive = true;
      gate.add(lantern);
      // Seat at the avenue head, then turn so +Z (and the ±X post span) line up
      // with the street: face the gate toward its plaza.
      const placed = this.placeObjectOnSurface(
        gate,
        // 8u poleward of the plaza. GATE_HALF_WIDTH (2.1u) is absolute and must
        // stay that way — the gate frames a ~2u avenue — so the STANDOFF has to
        // be absolute too, or the gate walks away from the avenue it frames.
        this.dirAt(d.lon, ZONE_LAT + this.arc(8)).multiplyScalar(this.radius),
        -0.05,
        false,
      );
      // Straight mount: align to RADIAL up, not the terrain normal — on the
      // sloped poleward approach the normal leaned the whole gate (the
      // "tilted billboard" playtest note). Sunk 0.05 so the downhill post
      // still seats on the slope.
      const gateUp = placed.position.clone().normalize();
      gate.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), gateUp);
      this.faceObjectToward(gate, gateUp, this.dirAt(d.lon, ZONE_LAT).multiplyScalar(this.radius));
      gates.add(gate);
      // Outline Tier 1: posts + lintel; the district board keeps its clean
      // face (text legibility) — the lantern is emissive-but-opaque so its
      // ink cap is fine.
      addGroupHulls(gate, 0.3, (m) => m.name !== 'gate-board');
    }

    // Group everything and attach to the main mesh as children so the island remains dominant
    const root = new THREE.Group();
    root.add(mesh);
    root.add(welcomePlaza);
    root.add(gates);
    root.add(sea);
    root.add(grass);
    root.add(pathGroup);
    root.add(buildings);
    root.add(houses);
    root.add(trees);
    root.add(mailboxes);
    root.add(lamps);
    root.add(npcs);
    root.add(particles);
    root.add(fountain);
    root.add(statue);
    root.add(cars);
    root.add(flowers);
    root.add(signs);
    root.add(dustParticles);
    root.add(stairs);
    root.add(stalls);
    root.add(signboards);
    root.add(constructions);
    root.add(rivers);
    root.add(mountains);
    root.add(benches);

    // Ground every prop exactly on the terrain: an audit found buildings
    // floating +1.2 and mailboxes sunk -1.3 from inconsistent per-site
    // offsets. Runs before tryLoadModels so GLB replacements inherit the
    // corrected positions.
    // (flowers omitted — instanced blooms are origin-anchored InstancedMeshes
    // that seatGroupsOnTerrain skips; each bloom is grounded at scatter time.)
    this.seatGroupsOnTerrain(root, [
      buildings,
      houses,
      trees,
      lamps,
      npcs,
      cars,
      mailboxes,
      stalls,
      constructions,
      benches,
    ]);

    // SEAT THE LAMP ANCHORS BY HAND, then republish the instance matrices.
    // seatGroupsOnTerrain measures each child's bounding box to find how far
    // its geometry hangs below the group origin — and the lamp anchors are
    // EMPTY groups now (their geometry lives in the instanced fleet), so
    // `box.isEmpty()` skipped every one and the whole fleet floated at the
    // +0.62 sample offset buildLamp deliberately leaves for the seat pass.
    // The pole base is local y=0 by construction, so minY is a known 0 and
    // the same arithmetic applies without a box.
    {
      const dir = new THREE.Vector3();
      const SINK = 0.05;
      for (const anchor of lamps.children) {
        if (!/^lamp_\d+$/.test(anchor.name)) continue;
        dir.copy(anchor.position).normalize();
        const sampled = this.sampleSurfaceByDirection(dir, 0);
        const delta = sampled.position.dot(dir) - SINK - anchor.position.dot(dir);
        if (Math.abs(delta) > 0.02) {
          anchor.position.addScaledVector(dir, delta);
          anchor.updateMatrixWorld(true);
        }
      }
      // Instance matrices are snapshots — they MUST be rewritten from the
      // seated anchors, or the fleet keeps the pre-seat float regardless.
      const anchors = lamps.children.filter((c) => /^lamp_\d+$/.test(c.name));
      for (const fleet of this.lampFleet) {
        for (let i = 0; i < anchors.length && i < fleet.count; i++) {
          anchors[i].updateMatrix();
          fleet.setMatrixAt(i, anchors[i].matrix);
        }
        fleet.instanceMatrix.needsUpdate = true;
        root.add(fleet); // added post-seat, outside `lamps` (see the build block)
      }
    }

    // Re-anchor the published lamp sites to the SEATED meshes: buildLamp
    // records its pre-seat sample (+0.62 float so the seat pass has room to
    // drop it), and the seat pass moves only the meshes — the stale anchors
    // parked the three roaming night lights ~0.67u ABOVE every bulb
    // (measured on all 49 lamps), reading as lamps defying gravity.
    // Children order matches the lampSites push order, so indices hold —
    // guarded so a future lamp parented elsewhere can't scramble the mapping.
    {
      const anchors = lamps.children.filter((c) => /^lamp_\d+$/.test(c.name));
      if (anchors.length === this.lampSites.length) {
        this.lampSites.length = 0;
        for (const l of anchors) {
          this.lampSites.push(l.getWorldPosition(new THREE.Vector3()));
        }
      }
    }

    this.tryLoadModels(buildings, npcs, buildingPlaceholders, npcPlaceholders).catch(() => {
      /* swallow errors */
    });

    // Reward for the climb: a monument on the summit (built after the terrain
    // exists so it seats on the real height).
    const summit = this.createSummitMarker();
    if (summit) root.add(summit);

    // Coastal lighthouse — the tall skyline landmark the roaming experience
    // lacked. At ~13u it breaches the local horizon from neighbouring districts
    // (the 7.3u summit beacon dropped out of sight within ~15-20u), giving a
    // world-space orientation anchor to complement the HUD compass.
    const lighthouse = this.createLighthouse();
    if (lighthouse) root.add(lighthouse);

    // Instanced boulder layer — scree on steep slopes (where grass collapses
    // for steepness) plus a shoreline band, so cliffs and beaches get real rock
    // geometry to back the terrain's rock/steep shading. One draw call.
    const rocks = this.createRocks();
    if (rocks) root.add(rocks);

    // Ore veins (wave 3 mining) — mineral-rich highland spots, shielded.
    const ore = this.createOreNodes();
    if (ore) root.add(ore);

    // Seafloor life — kelp beds + coral on the underwater skirt. Decoration
    // only; deterministic from its own local RNG (see createSeafloorLife).
    const seafloor = this.createSeafloorLife();
    if (seafloor) root.add(seafloor);

    // (The old equator ring road + its decal conversion are gone — the
    // street network is built entirely from createStreetPath segments.)

    // ── Static matrix freeze ────────────────────────────────────────────────
    // These groups are placed once and NEVER transformed again — proven by an
    // exhaustive per-object mutation-site audit (NOT a name/window classifier;
    // that heuristic is what leaked swaying trees / walking NPCs / the moving
    // sun into the static set in the reverted first attempt). Baking their world
    // matrices once and disabling per-frame matrix auto-update stops three
    // recomputing + propagating them every frame (the scene otherwise walks
    // ~1,600 static prop meshes per frame — see OrbitCamera's collision note).
    //
    // ORDER IS LOAD-BEARING: bake via root.updateMatrixWorld(true) while the
    // flags are still default-true, THEN flip them. Flip-first makes the bake
    // skip the multiply and everything renders at the origin. BOTH flags per
    // node (three r0.180): the Scene self-dirties each frame and force-cascades
    // into descendants, so matrixAutoUpdate=false alone still pays the world
    // multiply; matrixWorldAutoUpdate=false skips it too. RNG-neutral (boolean
    // writes + one in-place updateMatrix; no alloc, no Math.random, no draw).
    root.updateMatrixWorld(true);
    const freezeStatic = (o: THREE.Object3D): void =>
      o.traverse((c) => {
        // GUARD: flowers is the designated home for FUTURE animated props — a
        // child that animates its transform MUST set userData.animated (or
        // .dynamic) to opt out, or it will be pinned. See the note at `flowers`.
        if (c.userData && (c.userData.animated || c.userData.dynamic)) return;
        c.matrixAutoUpdate = false;
        c.matrixWorldAutoUpdate = false;
      });
    for (const g of [
      buildings,
      houses,
      gates,
      welcomePlaza,
      pathGroup,
      constructions,
      flowers,
      sea,
    ])
      freezeStatic(g);
    // Terrain: compose-only. KEEP matrixWorldAutoUpdate=true — the BVH raycast
    // and GameScene's collider snapshots call updateMatrixWorld(true) on it.
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();

    return root;
  }

  /**
   * Summit monument at the top of the trail: a stone landing, a cairn, a flag,
   * and a glowing beacon crystal (strong emissive → the bloom pass gives it a
   * halo visible from across the island, so the peak reads as a destination).
   */
  private createSummitMarker(): THREE.Group | null {
    if (!this.trailSummitDir) return null;
    const dir = this.trailSummitDir.clone().normalize();
    const surf = this.sampleSurfaceByDirection(dir, 0);
    const g = new THREE.Group();
    g.name = 'summit_marker';
    g.position.copy(dir).multiplyScalar(surf.position.length() - 0.15);
    g.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), surf.normal);
    (g.userData as Record<string, unknown>).ignoreOcclusion = true;

    // Stone landing
    const stoneMat = new THREE.MeshStandardMaterial({ color: 0x9198a1, roughness: 0.92 });
    const plat = new THREE.Mesh(new THREE.CylinderGeometry(1.15, 1.4, 0.3, 14), stoneMat);
    plat.position.y = 0.15;
    plat.castShadow = true;
    plat.receiveShadow = true;
    g.add(plat);

    // Cairn — a little stack of rocks off to one side
    const rockMat = new THREE.MeshStandardMaterial({ color: 0x767b83, roughness: 0.95 });
    let cy = 0.5;
    let rIdx = 0;
    for (const rr of [0.42, 0.32, 0.22, 0.14]) {
      const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(rr, 0), rockMat);
      rock.position.set(1.0, cy, 0.55);
      rock.rotation.set(rIdx * 1.1, rIdx * 2.3, rIdx);
      rock.castShadow = true;
      g.add(rock);
      cy += rr * 1.4;
      rIdx++;
    }

    // Flagpole + pennant
    const pole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.045, 0.06, 3.4, 8),
      new THREE.MeshStandardMaterial({ color: 0x5a4632, roughness: 0.7 }),
    );
    // 0.83 from the beacon axis (was 0.67): the halo torus sweeps out to
    // 0.665 (0.62 ring + 0.045 tube) and grazed the pole's flank by ~0.05.
    // Clears it by ~0.1 now; still well inside the 1.15 platform top.
    pole.position.set(-0.75, 1.9, -0.35);
    pole.castShadow = true;
    g.add(pole);
    const flagMat = new THREE.MeshStandardMaterial({
      color: 0x4caf50,
      emissive: 0x1c5a22,
      emissiveIntensity: 0.35,
      side: THREE.DoubleSide,
      roughness: 0.6,
    });
    // Flutter the pennant out of its plane — pinned at the pole (x=0), free at
    // the tip (x=1.25). Reuses the shared grass clock: zero per-frame CPU, no new
    // material (census-safe). Its sibling beacon already spins/bobs.
    flagMat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = this.grassTimeUniform;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nuniform float uTime;')
        .replace(
          '#include <begin_vertex>',
          [
            '#include <begin_vertex>',
            '  float flT = position.x / 1.25;',
            '  float flW = sin(uTime * 4.0 + position.x * 3.0) + 0.4 * sin(uTime * 6.5);',
            '  transformed.z += flW * 0.12 * flT * flT;',
            '  transformed.y += flW * 0.03 * flT;',
          ].join('\n'),
        );
    };
    const flagGeo = new THREE.BufferGeometry();
    // Triangular pennant off the top of the pole (+X), in the local XY plane
    flagGeo.setAttribute(
      'position',
      new THREE.Float32BufferAttribute([0, 3.4, 0, 1.25, 3.15, 0, 0, 2.75, 0], 3),
    );
    flagGeo.computeVertexNormals();
    const flag = new THREE.Mesh(flagGeo, flagMat);
    flag.position.set(-0.75, 0, -0.35); // rides its (moved) pole
    g.add(flag);

    // Beacon crystal — the glow. Very high emissive so the bloom halo carries.
    const beacon = new THREE.Mesh(
      new THREE.OctahedronGeometry(0.42, 0),
      new THREE.MeshStandardMaterial({
        color: 0xfff0b0,
        emissive: 0xffcc44,
        emissiveIntensity: 2.2,
        metalness: 0.3,
        roughness: 0.15,
      }),
    );
    beacon.position.set(0, 1.35, 0);
    beacon.name = 'summit_beacon';
    g.add(beacon);
    // A halo ring around it for extra sparkle
    const halo = new THREE.Mesh(
      new THREE.TorusGeometry(0.62, 0.045, 8, 24),
      new THREE.MeshStandardMaterial({
        color: 0xffe680,
        emissive: 0xffd24a,
        emissiveIntensity: 1.6,
      }),
    );
    halo.rotation.x = Math.PI / 2;
    beacon.add(halo);
    this.summitBeacon = beacon;

    console.log(
      `⛰️ Summit monument placed at ${(surf.position.length() - this.seaLevel()).toFixed(1)}u above sea`,
    );
    return g;
  }

  /**
   * Coastal lighthouse: a tapered red/white banded tower with a glowing lantern.
   * Tall enough (~13u) to stay on the skyline from adjacent districts, so it
   * anchors orientation while roaming. Seated on the real terrain height at a
   * reserved coastal spot (see the pre-claim in buildIsland).
   */
  private createLighthouse(): THREE.Group | null {
    const dir = this.dirAt(5.4, 0.34).normalize();
    this.lighthouseDir = dir.clone(); // NPC activity anchor (lighthouse keeper)
    let surf;
    try {
      surf = this.sampleSurfaceByDirection(dir, 0);
    } catch {
      return null;
    }
    const g = new THREE.Group();
    g.name = 'lighthouse';
    g.position.copy(dir).multiplyScalar(surf.position.length() - 0.1);
    g.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), surf.normal);
    (g.userData as Record<string, unknown>).ignoreOcclusion = true;

    const whiteMat = new THREE.MeshStandardMaterial({ color: 0xeef0f2, roughness: 0.7 });
    const redMat = new THREE.MeshStandardMaterial({ color: 0xc9433a, roughness: 0.65 });
    const rockMat = new THREE.MeshStandardMaterial({ color: 0x7d8590, roughness: 0.95 });
    const darkMat = new THREE.MeshStandardMaterial({
      color: 0x33383f,
      roughness: 0.55,
      metalness: 0.25,
    });

    // Rocky base plinth
    const base = new THREE.Mesh(new THREE.CylinderGeometry(1.9, 2.5, 1.2, 12), rockMat);
    base.position.y = 0.6;
    base.castShadow = true;
    base.receiveShadow = true;
    g.add(base);

    // Tapered tower built as stacked segments so the red/white bands are clean
    // (no z-fighting rings). CylinderGeometry(topR, bottomR, height).
    const TOWER_H = 9.5;
    const baseY = 1.2;
    const rBottom = 1.5;
    const rTop = 0.9;
    const SEGS = 5;
    for (let sIdx = 0; sIdx < SEGS; sIdx++) {
      const t0 = sIdx / SEGS;
      const t1 = (sIdx + 1) / SEGS;
      const r0 = rBottom + (rTop - rBottom) * t0;
      const r1 = rBottom + (rTop - rBottom) * t1;
      const seg = new THREE.Mesh(
        new THREE.CylinderGeometry(r1, r0, TOWER_H / SEGS, 16),
        sIdx % 2 === 0 ? whiteMat : redMat,
      );
      seg.position.y = baseY + ((t0 + t1) / 2) * TOWER_H;
      seg.castShadow = true;
      g.add(seg);
    }

    const galleryY = baseY + TOWER_H;
    // Gallery deck
    const gallery = new THREE.Mesh(new THREE.CylinderGeometry(1.15, 1.15, 0.3, 16), darkMat);
    gallery.position.y = galleryY + 0.15;
    gallery.castShadow = true;
    g.add(gallery);
    // Lantern housing
    const housing = new THREE.Mesh(new THREE.CylinderGeometry(0.72, 0.82, 1.1, 12), darkMat);
    housing.position.y = galleryY + 0.85;
    g.add(housing);
    // The lamp — high emissive so the bloom pass carries it as a skyline beacon
    const lamp = new THREE.Mesh(
      new THREE.SphereGeometry(0.52, 16, 16),
      new THREE.MeshStandardMaterial({
        color: 0xfff3c0,
        emissive: 0xffcf5a,
        emissiveIntensity: 2.4,
        metalness: 0.2,
        roughness: 0.15,
      }),
    );
    lamp.position.y = galleryY + 0.85;
    lamp.name = 'lighthouse_lamp';
    g.add(lamp);
    // A faint halo ring for extra glow (mirrors the summit beacon)
    const halo = new THREE.Mesh(
      new THREE.TorusGeometry(0.78, 0.05, 8, 24),
      new THREE.MeshStandardMaterial({
        color: 0xffe680,
        emissive: 0xffd24a,
        emissiveIntensity: 1.6,
      }),
    );
    halo.rotation.x = Math.PI / 2;
    lamp.add(halo);
    // Conical roof
    const roof = new THREE.Mesh(new THREE.ConeGeometry(0.98, 0.95, 12), redMat);
    roof.position.y = galleryY + 1.85;
    roof.castShadow = true;
    g.add(roof);

    // THE BEAM. The lantern glowed but threw nothing — a lighthouse that does
    // not sweep is just a striped tower. Two opposed cones of additive haze
    // (apex at the lantern, laid on their sides so they point out to sea)
    // plus ONE real spotlight riding the same pivot, so the sweep actually
    // lands on the rocks and the water as it passes. GameScene spins the
    // pivot and fades the whole thing in as the light goes.
    const beam = new THREE.Group();
    beam.name = 'lighthouse_beam';
    beam.position.y = galleryY + 0.85;
    // A flat additive cone renders as a solid pipe across the sky (it was
    // unmistakably two beige tubes on the first pass). The fix is a gradient
    // down the cone's V axis — bright at the lantern, gone by the far end —
    // plus FrontSide, since DoubleSide adds the far wall's contribution on
    // top of the near one and doubles everything.
    const gcv = document.createElement('canvas');
    gcv.width = 4;
    gcv.height = 64;
    const gctx = gcv.getContext('2d');
    if (gctx) {
      // Canvas y=0 is the TOP, and textures sample with flipY, so canvas-top
      // lands at v=1 — which on a three.js cone is the APEX. The bright stop
      // therefore belongs at canvas y=0, or the beam glows at the wrong end
      // (it did, on the first pass: solid at the horizon, invisible at the
      // lamp that was supposed to be casting it).
      const grad = gctx.createLinearGradient(0, 0, 0, 64);
      grad.addColorStop(0, 'rgba(255,240,200,1)'); // apex — at the lantern
      grad.addColorStop(0.45, 'rgba(255,233,168,0.35)');
      grad.addColorStop(1, 'rgba(255,233,168,0)'); // far end — nothing
      gctx.fillStyle = grad;
      gctx.fillRect(0, 0, 4, 64);
    }
    const beamTex = new THREE.CanvasTexture(gcv);
    beamTex.colorSpace = THREE.SRGBColorSpace;
    const beamMat = new THREE.MeshBasicMaterial({
      map: beamTex,
      color: 0xffe9a8,
      transparent: true,
      opacity: 0, // GameScene ramps this at dusk
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.FrontSide,
    });
    beam.userData.beamMat = beamMat;
    const BEAM_LEN = 26;
    // TILT. A horizontal beam is wrong on a sphere: the surface curves away
    // beneath it, so it climbs. The lantern sits ~10u above the sea, and over
    // 26u of arc the R=50 surface drops another R(1-cos(26/50)) = 6.6u — so a
    // level beam finishes ~17u in the air, which is exactly how it read.
    // Measured live: the lantern sits 12.1u over the sea and the surface falls
    // another ~3.9u across the beam's horizontal run, so the far end has 16u
    // to lose. 26*sin(t) >= 16 needs t >= 0.66; 0.72 lands it with margin, so
    // the beam meets the water around 22u out and rakes the ground sooner on
    // the landward sweep, where the terrain rises to meet it.
    //
    // R=75 CHECKED — LEAVE IT. The constraint is set by the HORIZONTAL RUN
    // (19.5u), not by BEAM_LEN, and a bigger sphere curves away more GENTLY, so
    // the minimum tilt FALLS from 0.657 to 0.598. 0.72 satisfies it with MORE
    // margin than at R=50 and drifts in the safe direction (~2u across a ~24u
    // sweep). Recorded so the next auditor doesn't re-derive this and "fix" it.
    const BEAM_TILT = 0.72;
    const beamLights: THREE.SpotLight[] = [];
    for (const s of [1, -1]) {
      // The arm carries the downward tilt so the cone keeps its simple local
      // geometry: rotating about Z by -s*t swings the +/-X axis toward -Y.
      const arm = new THREE.Group();
      arm.rotation.z = -s * BEAM_TILT;
      const cone = new THREE.Mesh(new THREE.ConeGeometry(1.05, BEAM_LEN, 12, 1, true), beamMat);
      // Cones are built along +Y: tip it onto the horizontal and push it out
      // so the narrow apex sits at the lantern, not the fat end.
      cone.rotation.z = (s * Math.PI) / 2;
      cone.position.set((s * BEAM_LEN) / 2, 0, 0);
      arm.add(cone);
      // One spotlight per beam, aimed straight down the arm, so BOTH sweeps
      // wash the rocks, trees and water they cross instead of only glowing in
      // the air. decay 1.1 rather than the physical 2: a squared falloff is
      // spent within a few units and would light nothing but the gallery.
      const sl = new THREE.SpotLight(0xffe4a0, 0, 44, 0.3, 0.55, 1.1);
      sl.position.set(0, 0, 0);
      sl.target.position.set(s * BEAM_LEN, 0, 0);
      arm.add(sl, sl.target);
      beamLights.push(sl);
      beam.add(arm);
    }
    beam.userData.beamLights = beamLights;
    g.add(beam);

    console.log('🗼 Lighthouse placed on the coast');
    return g;
  }

  /**
   * Instanced boulders — scree on steep slopes (where grass collapses for
   * steepness) plus a shoreline boulder band. Analytic surface only (no
   * raycasts) so it stays cheap at boot. One InstancedMesh = one draw call.
   */
  private createRocks(): THREE.InstancedMesh | null {
    const geo = new THREE.IcosahedronGeometry(0.5, 0);
    geo.scale(1.0, 0.72, 1.12); // slightly flattened boulder
    const mat = new THREE.MeshStandardMaterial({
      color: 0x8b857a,
      roughness: 0.96,
      flatShading: true,
    }); // warm neutral rock grey
    // NOTE: MAX is NOT the binding constraint — the scatter only ever placed 59
    // of 128 at R=50, so raising the cap alone would have changed nothing.
    // CANDIDATES is what actually gates the count.
    const MAX = Math.round(128 * areaScale(this.radius));
    const inst = new THREE.InstancedMesh(geo, mat, MAX);
    inst.name = 'rocks';
    inst.castShadow = true;
    inst.receiveShadow = true;
    const up = new THREE.Vector3(0, 1, 0);
    const dummy = new THREE.Object3D();
    const golden = Math.PI * (3 - Math.sqrt(5));
    const CANDIDATES = Math.round(400 * areaScale(this.radius));
    let placed = 0;
    for (let i = 0; i < CANDIDATES && placed < MAX; i++) {
      const y = 1 - (i / (CANDIDATES - 1)) * 2;
      const rAtY = Math.sqrt(1 - y * y);
      const theta = golden * i;
      const candidate = new THREE.Vector3(
        Math.cos(theta) * rAtY,
        Math.abs(y),
        Math.sin(theta) * rAtY,
      ).normalize();
      if (candidate.y < Math.sin(0.255)) continue; // below the waterline
      if (this.isNearStreet(candidate)) continue;
      const a = this.analyticSurface(candidate);
      const slopeCos = a.normal.dot(candidate);
      const steep = slopeCos < 0.92; // cliff / scree slope
      const shoreBand = candidate.y < Math.sin(0.4); // boulders just above the surf
      // Rocks belong on scree + shorelines; only an occasional erratic elsewhere.
      if (!steep && !shoreBand && Math.random() > 0.1) continue;
      const dir = this.claimDir(candidate, this.arc(1.5)); // tight — scree clusters
      const a2 = this.analyticSurface(dir);
      dummy.position.copy(dir).multiplyScalar(a2.radius).addScaledVector(a2.normal, -0.14); // sink slightly: bury-not-float
      dummy.quaternion.setFromUnitVectors(up, a2.normal);
      dummy.rotateY(Math.random() * Math.PI * 2);
      const rockScale = 0.45 + Math.random() * (steep ? 1.5 : 0.85);
      dummy.scale.setScalar(rockScale);
      dummy.updateMatrix();
      inst.setMatrixAt(placed, dummy.matrix);
      // Chest-height boulders block; small ones stay kickable-through. The
      // camera ray already saw these (instanced child of island.mesh), so
      // feet and camera finally agree.
      if (rockScale >= 0.8) {
        this.pendingColliders.push({
          position: dummy.position.clone(),
          radius: 0.55 * rockScale,
        });
      }
      placed++;
    }
    inst.count = placed;
    inst.instanceMatrix.needsUpdate = true;
    console.log(`🪨 Rock layer: ${placed} boulders (scree + shoreline)`);
    return placed > 0 ? inst : null;
  }

  // ── Ore veins (wave 3 mining) ─────────────────────────────────────────
  // Four mineral-rich nodes on the highland scree: a boulder cluster with
  // gold-glinting studs. The pickaxe cracks them; GameScene owns the state
  // machine (charges, depletion tint, regen). Published SEATED (claim law).
  public oreNodeSites: THREE.Vector3[] = [];
  public oreStuds: THREE.InstancedMesh | null = null;
  public static readonly ORE_STUDS_PER_NODE = 6;

  private createOreNodes(): THREE.Group | null {
    const stashedRandom = Math.random;
    let seed = 0x5eedc0a1 >>> 0;
    Math.random = () => {
      seed = (seed + 0x6d2b79f5) >>> 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    try {
      return this.createOreNodesShielded();
    } finally {
      Math.random = stashedRandom;
    }
  }

  private createOreNodesShielded(): THREE.Group | null {
    const SITES: Array<[number, number]> = [
      [4.92, 0.7],
      [5.78, 0.66],
      [5.3, 0.52],
      [2.36, 0.3],
    ];
    const g = new THREE.Group();
    g.name = 'ore_nodes';
    const boulderGeo = new THREE.IcosahedronGeometry(0.5, 0);
    boulderGeo.scale(1.0, 0.72, 1.12);
    const boulders = new THREE.InstancedMesh(
      boulderGeo,
      new THREE.MeshToonMaterial({ color: 0x7d7468, gradientMap: Materials.toonRamp() }),
      SITES.length * 3,
    );
    boulders.castShadow = true;
    boulders.raycast = () => {};
    const studs = new THREE.InstancedMesh(
      new THREE.OctahedronGeometry(0.14, 0),
      // WHITE base — the gold/grey lives in instanceColor (which MULTIPLIES
      // vertex color; a colored base would square down to mud).
      new THREE.MeshToonMaterial({ color: 0xffffff, gradientMap: Materials.toonRamp() }),
      SITES.length * Island.ORE_STUDS_PER_NODE,
    );
    studs.raycast = () => {};
    const gold = new THREE.Color(0xe0b13f);
    const dummy = new THREE.Object3D();
    const up = new THREE.Vector3(0, 1, 0);
    let bi = 0;
    let si = 0;
    for (const [lon, lat] of SITES) {
      let dir = this.claimOffStreet(this.dirAt(lon, lat), this.arc(3));
      // Guard: never on the summit trail, never on a street (site 3 sits
      // 0.27 rad from the summit — this loop is load-bearing, vitest-pinned).
      for (let pass = 0; pass < 4; pass++) {
        const onTrail = this.trailAt ? this.trailAt(dir).w > 0.02 : false;
        if (!onTrail && !this.isNearStreet(dir)) break;
        const away = this.trailSummitDir
          ? dir.clone().addScaledVector(this.trailSummitDir, -0.04).normalize()
          : dir.clone();
        dir = this.claimOffStreet(away, this.arc(3));
      }
      const a = this.analyticSurface(dir);
      const centre = dir.clone().multiplyScalar(a.radius);
      this.oreNodeSites.push(centre.clone());
      for (let b = 0; b < 3; b++) {
        const ang = (b / 3) * Math.PI * 2 + Math.random();
        dummy.position
          .copy(centre)
          .addScaledVector(a.normal, -0.14)
          .add(
            new THREE.Vector3(Math.cos(ang), 0, Math.sin(ang))
              .addScaledVector(dir, -Math.cos(ang) * dir.x - Math.sin(ang) * dir.z)
              .normalize()
              .multiplyScalar(0.35 + Math.random() * 0.3),
          );
        dummy.quaternion.setFromUnitVectors(up, a.normal);
        dummy.rotateY(Math.random() * Math.PI * 2);
        dummy.scale.setScalar(0.6 + Math.random() * 0.5);
        dummy.updateMatrix();
        boulders.setMatrixAt(bi++, dummy.matrix);
      }
      for (let s = 0; s < Island.ORE_STUDS_PER_NODE; s++) {
        const ang = Math.random() * Math.PI * 2;
        const r = 0.15 + Math.random() * 0.45;
        dummy.position
          .copy(centre)
          .addScaledVector(a.normal, 0.1 + Math.random() * 0.35)
          .add(
            new THREE.Vector3(Math.cos(ang), 0, Math.sin(ang))
              .addScaledVector(dir, -Math.cos(ang) * dir.x - Math.sin(ang) * dir.z)
              .normalize()
              .multiplyScalar(r),
          );
        dummy.quaternion.setFromUnitVectors(up, a.normal);
        dummy.rotateY(Math.random() * Math.PI * 2);
        dummy.scale.setScalar(0.7 + Math.random() * 0.5);
        dummy.updateMatrix();
        studs.setMatrixAt(si, dummy.matrix);
        studs.setColorAt(si, gold);
        si++;
      }
      this.pendingColliders.push({ position: centre.clone(), radius: 0.6 });
    }
    boulders.instanceMatrix.needsUpdate = true;
    studs.instanceMatrix.needsUpdate = true;
    if (studs.instanceColor) studs.instanceColor.needsUpdate = true;
    boulders.computeBoundingSphere();
    studs.computeBoundingSphere();
    g.add(boulders, studs);
    this.oreStuds = studs;
    console.log(`⛏️ ${SITES.length} ore veins on the highlands`);
    return g;
  }

  /**
   * Seafloor life — kelp beds + a coral/starfish layer on the underwater
   * skirt (underwater slice). Everything here is DECORATION: no colliders,
   * raycast no-ops, no shadows, exactly 5 draws (4 kelp chunks + 1 merged
   * coral mesh). Determinism: a LOCAL mulberry32 stream with a fixed seed —
   * this consumes NOTHING from the shared Math.random stream, so the
   * multiplayer vehicle-placement contract is untouched by construction.
   */
  private createSeafloorLife(): THREE.Group | null {
    let seed = 0x5eaf100d >>> 0;
    const rng = (): number => {
      // mulberry32 (same generator as GameScene.installSeededRandom, own state)
      seed = (seed + 0x6d2b79f5) >>> 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const group = new THREE.Group();
    group.name = 'seafloor_life';
    const sea = this.seaLevel();
    const up = new THREE.Vector3(0, 1, 0);
    const dir = new THREE.Vector3();
    const dummy = new THREE.Object3D();

    // ── Kelp: instanced strands in 4 longitude chunks ────────────────────
    // Strand = 2 crossed ribbons × 4 stacked segments (16 tris / 48 verts),
    // olive→yellow-green tip gradient, base at origin, KELP_H tall.
    const KELP_H = 1.6;
    const kelpPositions: number[] = [];
    const kelpColors: number[] = [];
    const kelpBase = new THREE.Color(0x2f4d22);
    const kelpTip = new THREE.Color(0x93a844);
    const kc = new THREE.Color();
    const addRibbon = (rotY: number): void => {
      const c = Math.cos(rotY);
      const s = Math.sin(rotY);
      const v = (x: number, y: number): void => {
        kelpPositions.push(x * c, y, x * s);
        kc.copy(kelpBase).lerp(kelpTip, y / KELP_H);
        kelpColors.push(kc.r, kc.g, kc.b);
      };
      // Frond tapers toward the tip; a gentle mid bulge reads as a blade
      const w = (y: number): number =>
        0.085 * (1 - (y / KELP_H) * 0.55) * (0.8 + 0.4 * Math.sin((y / KELP_H) * Math.PI));
      const SEGS = 4;
      for (let i = 0; i < SEGS; i++) {
        const y0 = (KELP_H * i) / SEGS;
        const y1 = (KELP_H * (i + 1)) / SEGS;
        const w0 = w(y0);
        const w1 = w(y1);
        v(-w0, y0);
        v(w0, y0);
        v(w1, y1);
        v(-w0, y0);
        v(w1, y1);
        v(-w1, y1);
      }
    };
    addRibbon(0);
    addRibbon(Math.PI / 2);
    const kelpGeo = new THREE.BufferGeometry();
    kelpGeo.setAttribute('position', new THREE.Float32BufferAttribute(kelpPositions, 3));
    kelpGeo.setAttribute('color', new THREE.Float32BufferAttribute(kelpColors, 3));
    kelpGeo.computeVertexNormals();

    const kelpMat = isRealTheme()
      ? new THREE.MeshStandardMaterial({
          vertexColors: true,
          side: THREE.DoubleSide,
          roughness: 0.85,
          metalness: 0,
        })
      : new THREE.MeshToonMaterial({
          vertexColors: true,
          side: THREE.DoubleSide,
          gradientMap: Materials.toonRamp(), // shared 12-step ramp, like the meadow
        });
    kelpMat.onBeforeCompile = (shader) => {
      // Grass wind recipe re-tuned for water: slower (×0.6 of the grass
      // clock), stronger (0.25), bend ∝ (y/H)² so the holdfast stays planted
      // while the tip streams. Shares the public grassTimeUniform — zero new
      // per-frame uniform writes. No player-push terms: nothing walks here.
      shader.uniforms.uTime = this.grassTimeUniform;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nuniform float uTime;')
        .replace(
          '#include <begin_vertex>',
          [
            '#include <begin_vertex>',
            '#ifdef USE_INSTANCING',
            '  float kPhase = instanceMatrix[3].x * 1.7 + instanceMatrix[3].z * 2.3 + instanceMatrix[3].y * 1.1;',
            '  float kSway = sin(uTime * 1.26 + kPhase) + 0.5 * sin(uTime * 2.16 + kPhase * 1.4);',
            `  float kT = position.y / ${KELP_H.toFixed(3)};`,
            '  transformed.x += kSway * 0.25 * kT * kT;',
            '  transformed.z += cos(uTime * 0.96 + kPhase) * 0.12 * kT * kT;',
            '#endif',
          ].join('\n'),
        );
    };

    // Placement: depth band 1.2–3.2 on the underwater skirt (the open ocean
    // bottoms out deeper, so the band self-limits kelp to the island's rim).
    // 60% of strands cluster into 3 beds off the busiest beaches (fisherman
    // lon 5.0, school shores 1.26/3.77); the rest thinly ring the island.
    // Counts scale with world area (160 → 360 at R=75).
    // beltScale, NOT areaScale: kelp/coral/starfish/fans live in a depth-gated
    // SHORELINE RING (kelp 1.2-3.2 deep), so their habitat grows with the
    // CIRCUMFERENCE, not the surface area. Scaling by area inflated density
    // 1.67x on a ring that only widened ~6.5% — measured kelp 360 -> 640 at
    // R=100. Re-based so R=75 is byte-identical (160*2.25 == 240*1.5).
    const KELP_TARGET = Math.round(240 * beltScale(this.radius));
    const beds = [5.0, 1.26, 3.77];
    const chunkMatrices: number[][] = [[], [], [], []];
    let kelpPlaced = 0;
    for (let i = 0; i < KELP_TARGET * 8 && kelpPlaced < KELP_TARGET; i++) {
      let lon: number;
      let lat: number;
      if (rng() < 0.6) {
        const bed = beds[Math.floor(rng() * beds.length) % beds.length];
        lon = bed + (rng() - 0.5) * 0.5;
        lat = 0.02 + rng() * 0.16;
      } else {
        lon = rng() * Math.PI * 2;
        lat = -0.1 + rng() * 0.3;
      }
      if (lat >= 0.22) continue; // stay below the waterline latitude
      dir.set(Math.cos(lat) * Math.cos(lon), Math.sin(lat), Math.cos(lat) * Math.sin(lon));
      const a = this.analyticSurface(dir);
      const depth = sea - a.radius;
      // Upper bound re-authored for the R=100 column (floor is 5.0u down, was
      // 3.75u): the 3.2 ceiling was an R=75 number that kept every frond in a
      // narrow shore ring while the water around it got a third deeper.
      // A gate widening only — the candidate loop and its rng() draws are
      // unchanged, so the seeded stream (and index-networked vehicles) is safe.
      if (depth < 1.2 || depth > 4.3) continue;
      // Never breach the surface: cap strand height to 85% of the water column
      const scale = Math.min(0.75 + rng() * 0.55, (depth * 0.85) / KELP_H);
      dummy.position.copy(dir).multiplyScalar(a.radius - 0.05); // rooted, not floating
      dummy.quaternion.setFromUnitVectors(up, dir); // buoyant — rises radially
      dummy.rotateY(rng() * Math.PI * 2);
      dummy.scale.setScalar(scale);
      dummy.updateMatrix();
      const q = ((Math.atan2(dir.z, dir.x) + Math.PI * 2) % (Math.PI * 2)) / (Math.PI / 2);
      chunkMatrices[Math.min(3, Math.floor(q))].push(...dummy.matrix.elements);
      kelpPlaced++;
    }
    for (let s = 0; s < 4; s++) {
      const count = chunkMatrices[s].length / 16;
      if (count === 0) continue;
      const chunk = new THREE.InstancedMesh(kelpGeo, kelpMat, count);
      chunk.instanceMatrix.array.set(chunkMatrices[s]);
      chunk.instanceMatrix.needsUpdate = true;
      chunk.name = `kelp_chunk_${s}`;
      chunk.raycast = () => {}; // camera/feed rays must never hit a frond
      chunk.castShadow = false;
      chunk.receiveShadow = false;
      chunk.computeBoundingSphere(); // tight per-chunk sphere (grass sector lesson)
      group.add(chunk);
    }

    // ── Coral + starfish: ONE merged static mesh, vertex colors ──────────
    // Shallow band (0.3–1.8) so the warm accents read from the surface and
    // the shore. MeshStandardMaterial → rides the toonify pass like the rest
    // of the island.
    const warm = [0xe8735a, 0xd8a04a, 0xe86a4f].map((c) => new THREE.Color(c));
    const partCol = new THREE.Color();
    const bakeColor = (g: THREE.BufferGeometry, col: THREE.Color): void => {
      const n = g.getAttribute('position').count;
      const arr = new Float32Array(n * 3);
      for (let vi = 0; vi < n; vi++) {
        arr[vi * 3] = col.r;
        arr[vi * 3 + 1] = col.g;
        arr[vi * 3 + 2] = col.b;
      }
      g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
    };
    // 5-point star prism template for the starfish (extruded flat).
    const starShape = new THREE.Shape();
    for (let p = 0; p < 10; p++) {
      const ang = (p / 10) * Math.PI * 2;
      const r = p % 2 === 0 ? 0.16 : 0.065;
      if (p === 0) starShape.moveTo(Math.cos(ang) * r, Math.sin(ang) * r);
      else starShape.lineTo(Math.cos(ang) * r, Math.sin(ang) * r);
    }
    // mergeGeometries refuses to mix indexed + non-indexed parts (it returns
    // null) — Cone is indexed, Icosahedron/Extrude are not. Flatten everything.
    const noIdx = (g: THREE.BufferGeometry): THREE.BufferGeometry =>
      g.index ? g.toNonIndexed() : g;
    const starGeoTemplate = noIdx(
      new THREE.ExtrudeGeometry(starShape, {
        depth: 0.05,
        bevelEnabled: false,
      }),
    );
    starGeoTemplate.rotateX(-Math.PI / 2); // flat on the seabed, points out
    const parts: THREE.BufferGeometry[] = [];
    const seatPart = (
      g: THREE.BufferGeometry,
      surfDepthMin: number,
      surfDepthMax: number,
    ): boolean => {
      // Shared scatter: pick a shoreline-band direction, gate by depth.
      for (let tries = 0; tries < 24; tries++) {
        const lon = rng() * Math.PI * 2;
        const lat = -0.05 + rng() * 0.27;
        dir.set(Math.cos(lat) * Math.cos(lon), Math.sin(lat), Math.cos(lat) * Math.sin(lon));
        const a = this.analyticSurface(dir);
        const depth = sea - a.radius;
        if (depth < surfDepthMin || depth > surfDepthMax) continue;
        // Organic ground clutter — the World Law 1 exception: follows the
        // slope normal like rocks and feed piles do.
        dummy.position.copy(dir).multiplyScalar(a.radius - 0.02);
        dummy.quaternion.setFromUnitVectors(up, a.normal);
        dummy.rotateY(rng() * Math.PI * 2);
        dummy.updateMatrix();
        g.applyMatrix4(dummy.matrix);
        parts.push(g);
        return true;
      }
      return false;
    };
    const CORAL_CLUMPS = Math.round(60 * beltScale(this.radius)); // ring, not area — see KELP_TARGET
    for (let i = 0; i < CORAL_CLUMPS; i++) {
      const nubs = 3 + Math.floor(rng() * 2);
      const clump: THREE.BufferGeometry[] = [];
      partCol.copy(warm[Math.floor(rng() * warm.length) % warm.length]);
      partCol.offsetHSL((rng() - 0.5) * 0.03, 0, (rng() - 0.5) * 0.08);
      for (let n = 0; n < nubs; n++) {
        const nub = noIdx(new THREE.IcosahedronGeometry(0.1 + rng() * 0.12, 0));
        nub.scale(1, 0.6 + rng() * 0.5, 1); // squashed knob
        nub.translate((rng() - 0.5) * 0.4, 0.05, (rng() - 0.5) * 0.4);
        bakeColor(nub, partCol);
        clump.push(nub);
      }
      const merged = mergeGeometries(clump, false) as THREE.BufferGeometry;
      const scale = 0.8 + rng() * 0.9;
      merged.scale(scale, scale, scale);
      seatPart(merged, 0.3, 1.8);
    }
    const STARFISH = Math.round(27 * beltScale(this.radius)); // ring, not area
    for (let i = 0; i < STARFISH; i++) {
      const star = starGeoTemplate.clone();
      partCol.copy(warm[Math.floor(rng() * warm.length) % warm.length]);
      partCol.offsetHSL((rng() - 0.5) * 0.05, 0.05, 0.05 + rng() * 0.06);
      bakeColor(star, partCol);
      const scale = 0.7 + rng() * 0.8;
      star.scale(scale, scale, scale);
      seatPart(star, 0.25, 1.4);
    }
    const FANS = Math.round(4.5 * beltScale(this.radius)); // ring, not area
    for (let i = 0; i < FANS; i++) {
      const fan = noIdx(new THREE.ConeGeometry(0.32, 0.55, 6));
      fan.scale(1, 1, 0.16); // sea fan: a cone flattened into a blade
      fan.translate(0, 0.27, 0);
      partCol.copy(warm[1]).offsetHSL((rng() - 0.5) * 0.06, 0, 0.04);
      bakeColor(fan, partCol);
      seatPart(fan, 0.6, 2.2);
    }
    // Lobsters (expansion slice 5) — merged into the coral layer, +0 draws.
    // Body + tail fan + claw knobs + antennae, rust red, near the rocks in
    // the shallower band.
    for (let i = 0; i < 2; i++) {
      const lobParts: THREE.BufferGeometry[] = [
        noIdx(new THREE.SphereGeometry(0.09, 6, 5)).scale(0.9, 0.6, 1.8),
        noIdx(new THREE.SphereGeometry(0.05, 5, 4))
          .scale(1.6, 0.35, 1)
          .translate(0, 0.01, 0.2),
        noIdx(new THREE.SphereGeometry(0.035, 5, 4))
          .scale(1.2, 0.8, 1)
          .translate(-0.07, 0, -0.14),
        noIdx(new THREE.SphereGeometry(0.035, 5, 4))
          .scale(1.2, 0.8, 1)
          .translate(0.07, 0, -0.14),
        noIdx(new THREE.CylinderGeometry(0.004, 0.006, 0.22, 3))
          .rotateX(1.2)
          .translate(-0.03, 0.05, -0.2),
        noIdx(new THREE.CylinderGeometry(0.004, 0.006, 0.22, 3))
          .rotateX(1.2)
          .translate(0.03, 0.05, -0.2),
      ];
      const lobster = mergeGeometries(lobParts, false) as THREE.BufferGeometry;
      partCol.set(0x8a3a28).offsetHSL((rng() - 0.5) * 0.04, 0, (rng() - 0.5) * 0.05);
      bakeColor(lobster, partCol);
      seatPart(lobster, 0.4, 1.2);
    }
    if (parts.length) {
      const coralGeo = mergeGeometries(parts, false) as THREE.BufferGeometry;
      const coralMat = new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: 0.9,
        metalness: 0,
      });
      const coral = new THREE.Mesh(coralGeo, coralMat);
      coral.name = 'coral_layer';
      coral.raycast = () => {};
      coral.castShadow = false;
      coral.receiveShadow = false;
      group.add(coral);
    }
    console.log(`🪸 Seafloor life: ${kelpPlaced} kelp strands, ${parts.length} coral parts`);
    return group.children.length > 0 ? group : null;
  }

  // ── NPC dressing: variety + faces + persona flair ────────────────────────
  // npc.glb ships ONE mesh with 4 shared materials (Shoe/Pants/Shirt/Skin) and
  // clone(true) SHARES them — all ~20 villagers rendered as identical sage-
  // green clones with featureless heads. Swap in per-persona palette materials
  // (shared per colour — ~16 instances total, zero extra draw-call cost), add
  // eyes + a hair cap so the front reads (the yaw-face-the-player logic was
  // invisible without a face), and give hero personas their activity flair.
  // Toon materials so NPCs join the cel-shaded world (the PBR GLB loads after
  // toonify's traverse and was the only PBR-shaded figure on the island).
  private static npcPaletteCache = new Map<number, THREE.MeshToonMaterial>();

  private static paletteMat(hex: number): THREE.MeshToonMaterial {
    let m = Island.npcPaletteCache.get(hex);
    if (!m) {
      m = Materials.createToonMaterial(hex);
      Island.npcPaletteCache.set(hex, m);
    }
    return m;
  }

  /** Villagers who read as women. npc.glb ships ONE unisex body, so the cues
   *  are procedural primitives parented to the group — the same pattern the
   *  persona hats already use.
   *
   *  This is deliberately SIX of the twenty-five, not the whole cast: the
   *  island stays a mix, and these six are exactly the ones the beach-house
   *  party borrows. That keeps both halves true — everyone on that dance
   *  floor is a woman, and each of them is the same person you meet out on
   *  the island, rather than a costume that only exists behind the door. */
  public static readonly WOMEN_PERSONAS = new Set([
    'Gardener',
    'Artist',
    'Storyteller',
    'Cartographer',
    'Musician',
    'Courier',
  ]);

  /** Dress fabric: its own cache because the skirt needs DoubleSide, and the
   *  shirt materials it shares a colour with are used on closed geometry. */
  private static dressCache = new Map<number, THREE.MeshToonMaterial>();

  private static dressMat(hex: number): THREE.MeshToonMaterial {
    let m = Island.dressCache.get(hex);
    if (!m) {
      m = Materials.createToonMaterial(hex);
      m.side = THREE.DoubleSide;
      m.userData.celRim = true;
      applyCelRim(m);
      Island.dressCache.set(hex, m);
    }
    return m;
  }

  private dressNpc(group: THREE.Object3D, phIdx: number, personaName: string): void {
    const SHIRTS = [0xe08a8a, 0x86b7e0, 0x8fd0a0, 0xe0c07a, 0xb598dd, 0x7fcfc4, 0xe09a5f, 0x9fb3c8];
    const SKINS = [0xf3d3b3, 0xe8bb94, 0xc98d5f, 0xa06a42, 0x7c4e2e];
    const PANTS = [0x5d6b7a, 0x7a6a55, 0x4e5d52];
    const HAIRS = [0x2e2620, 0x4a3220, 0x7a5230, 0xb08d57, 0x8a8a8a, 0x5a4632];
    // Decoupled indices so shirt/skin/hair don't repeat in lockstep. The skin
    // stride MUST stay coprime to SKINS.length (5): the old (phIdx*5+3)%5 was
    // identically 3, so every villager wore the same mid-tan — which is what
    // the sandy/grey hairs clashed against.
    const shirtHex = SHIRTS[phIdx % SHIRTS.length];
    const skinHex = SKINS[(phIdx * 2 + 1) % SKINS.length];
    const pantsHex = PANTS[(phIdx * 7 + 1) % PANTS.length];
    // Hair: keep the per-persona pick when it reads clearly against this skin,
    // otherwise take the maximally-contrasting hair. Guarantees a visible
    // hairline on every skin tone (sandy hair on tan skin was invisible) while
    // preserving variety wherever contrast already holds.
    const lum = (hex: number): number =>
      (0.2126 * ((hex >> 16) & 255) + 0.7152 * ((hex >> 8) & 255) + 0.0722 * (hex & 255)) / 255;
    const skinL = lum(skinHex);
    let hairHex = HAIRS[phIdx % HAIRS.length];
    if (Math.abs(lum(hairHex) - skinL) < 0.22) {
      hairHex = HAIRS.reduce((best, h) =>
        Math.abs(lum(h) - skinL) > Math.abs(lum(best) - skinL) ? h : best,
      );
    }
    group.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      if (o.userData.isCelHull) return; // ink hulls: never recolour, rim, or re-hull
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      const swapped = mats.map((m) => {
        const n = ((m as THREE.Material)?.name ?? '').toLowerCase();
        if (n.includes('shirt')) return Island.paletteMat(shirtHex);
        if (n.includes('skin')) return Island.paletteMat(skinHex);
        if (n.includes('pants')) return Island.paletteMat(pantsHex);
        // Baked hair helmet (reshape-avatar-face.py) — per-persona colour via
        // the same shared-palette path the old runtime hair-sphere used.
        // Eye/EyeShine deliberately match nothing here and stay dark.
        if (n.includes('hair')) return Island.paletteMat(hairHex);
        return m;
      });
      o.material = Array.isArray(o.material) ? swapped : swapped[0];
      // Cel kit: lit-side rim on the villager's palette materials (once per
      // cached material — they're shared across villagers by colour), and an
      // ink hull bound to THIS villager's skeleton. Both no-ops under
      // ?theme=real.
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
        const mat = m as THREE.Material;
        if (mat && !mat.userData.celRim) {
          mat.userData.celRim = true;
          applyCelRim(mat);
        }
      }
      // Hull the garment/skin/hair primitives only. The GLB splits into one
      // SkinnedMesh per material — inflating the tiny Eye/EyeShine/Blush
      // primitives left scratchy ink crescents on the face.
      if ((o as unknown as { isSkinnedMesh?: boolean }).isSkinnedMesh) {
        const matName = (
          (Array.isArray(o.material) ? o.material[0] : o.material)?.name ?? ''
        ).toLowerCase();
        if (!/eye|blush/.test(matName)) {
          addSkinnedHull(o as unknown as THREE.SkinnedMesh);
        } else {
          // The tiny eye/eyeshine/blush face decals sit INSIDE the head's own
          // silhouette, so their sub-texel contribution to the whole-planet
          // 2048 shadow map is invisible — yet NPC.ts blanket-set castShadow on
          // every part, so with autoUpdate they are re-skinned + drawn into the
          // depth pass every frame (~3 parts x 28 villagers). Drop them from
          // the shadow pass; this runs after NPC.ts so it wins.
          (o as THREE.Mesh).castShadow = false;
        }
      }
    });
    // Silhouette variety (deterministic, ±6%)
    group.scale.multiplyScalar(0.95 + (phIdx % 5) * 0.03);
    // Face and hair are baked into npc.glb (eyes + highlights + smile on
    // Eye/EyeShine materials, hair helmet on Hair) — the runtime eye spheres
    // and hair half-sphere this used to add are gone. The baked face rides
    // the root bone, so it follows the walk bob and yaw-face-the-player.
    // Persona flair: hats reuse the player's procedural hat kit; held props
    // are 2-3 primitives. Whole-group pose modulation animates them for free.
    try {
      if (Island.WOMEN_PERSONAS.has(personaName)) {
        // Long hair: a mass behind the authored helmet plus two side locks.
        // Everything sits at z <= 0 or outside the head radius, so the baked
        // face (eyes/highlights/smile on Eye/EyeShine) is never covered — the
        // 1.68 hat anchor puts the crown there, so the skull centre is ~1.46.
        const hair = Island.paletteMat(hairHex);
        const back = new THREE.Mesh(new THREE.SphereGeometry(0.23, 10, 8), hair);
        back.scale.set(1, 1.1, 0.75);
        back.position.set(0, 1.46, -0.09);
        group.add(back);
        for (const sx of [-1, 1]) {
          const lock = new THREE.Mesh(new THREE.CapsuleGeometry(0.062, 0.26, 3, 6), hair);
          lock.position.set(sx * 0.2, 1.26, -0.02);
          lock.rotation.z = sx * 0.07;
          group.add(lock);
        }
        // Dress: an open truncated cone from waist to just above the knee, in
        // the shirt colour so top and skirt read as one garment. Open-ended
        // and DoubleSide so the swinging legs pass through it cleanly — the
        // 0.42 hem clears the widest thigh swing with room to spare.
        const dress = new THREE.Mesh(
          new THREE.CylinderGeometry(0.17, 0.42, 0.55, 12, 1, true),
          Island.dressMat(shirtHex),
        );
        dress.position.set(0, 0.72, 0);
        group.add(dress);
      }
      const HAT_FOR: Record<string, 'wizard' | 'flower' | 'cap' | 'party'> = {
        'Elder Sage': 'wizard',
        Gardener: 'flower',
        'Lighthouse Keeper': 'cap',
        Tourist: 'party',
      };
      const hatId = HAT_FOR[personaName];
      if (hatId) {
        const hat = SimplePlayer.buildHat(hatId);
        hat.position.y = 1.68;
        hat.scale.setScalar(0.9);
        group.add(hat);
      }
      if (personaName === 'Guard') {
        const spear = new THREE.Group();
        const shaft = new THREE.Mesh(
          new THREE.CylinderGeometry(0.025, 0.025, 1.5, 6),
          Island.paletteMat(0x7a5a3a),
        );
        const tip = new THREE.Mesh(
          new THREE.ConeGeometry(0.06, 0.18, 6),
          Island.paletteMat(0xb9c2cc),
        );
        tip.position.y = 0.84;
        spear.add(shaft, tip);
        spear.position.set(0.34, 0.95, 0.05);
        spear.rotation.z = 0.1;
        group.add(spear);
      } else if (personaName === 'Courier') {
        const satchel = new THREE.Mesh(
          new THREE.BoxGeometry(0.22, 0.18, 0.08),
          Island.paletteMat(0x8a5a34),
        );
        satchel.position.set(-0.28, 0.95, 0.02);
        group.add(satchel);
      } else if (personaName === 'Night Watch') {
        const lantern = new THREE.Mesh(
          new THREE.BoxGeometry(0.12, 0.16, 0.12),
          new THREE.MeshStandardMaterial({
            color: 0x3a3630,
            emissive: 0xffc966,
            emissiveIntensity: 0.7,
          }),
        );
        lantern.position.set(0.3, 0.85, 0.08);
        group.add(lantern);
      } else if (personaName === 'Musician') {
        const lute = new THREE.Group();
        const bodyM = new THREE.Mesh(
          new THREE.SphereGeometry(0.16, 8, 6),
          Island.paletteMat(0xa9743f),
        );
        bodyM.scale.set(1, 1.25, 0.35);
        const neck = new THREE.Mesh(
          new THREE.CylinderGeometry(0.02, 0.02, 0.42, 5),
          Island.paletteMat(0x6d4426),
        );
        neck.position.y = 0.3;
        lute.add(bodyM, neck);
        lute.position.set(0.05, 1.05, 0.24);
        lute.rotation.set(0.25, 0, -0.5);
        group.add(lute);
      }
    } catch {
      /* flair is a bonus, never fatal */
    }
  }

  /**
   * Sample the actual displaced island surface near an approximate position.
   * It performs a short raycast from slightly outside the expected surface inward
   * to find the real displaced geometry point and normal. Falls back to radial math
   * if the raycast fails.
   *
   * @param approxPos - an approximate position (usually a vector on the base radius circle)
   * @param desiredOffset - how far above the base radius the caller expects the object to sit (used as a small bias)
   */
  /** Unit direction from (longitude, latitude) in radians. */
  public dirAt(lon: number, lat: number): THREE.Vector3 {
    return new THREE.Vector3(
      Math.cos(lon) * Math.cos(lat),
      Math.sin(lat),
      Math.sin(lon) * Math.cos(lat),
    ).normalize();
  }

  /** Radius of the calm water surface (matches the sea mesh). */
  /** Authored surf-band offsets in METRES from the waterline. Measured at
   *  R=75, where they correspond to depths 1.6 / 2.4 / 3.2. */
  private static readonly SURF_BAND_METRES = [3.75, 6.0, 8.0] as const;

  /**
   * Solve the depth at each authored metre-offset offshore, so the surf bands
   * cover the same WIDTH OF WATER at any radius. ~16 headings x <=48 steps of
   * analyticSurface (~0.003ms each) = a few ms, once, at build.
   */
  private calibrateSurfBands(): THREE.Vector3 {
    const sea = this.seaLevel();
    const acc: number[][] = [[], [], []];
    const golden = Math.PI * (3 - Math.sqrt(5));
    const probe = new THREE.Vector3();
    const axis = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    for (let i = 0; i < 160; i++) {
      const y = 1 - (i / 159) * 2;
      const rad = Math.sqrt(Math.max(0, 1 - y * y));
      const th = golden * i;
      probe.set(Math.cos(th) * rad, y, Math.sin(th) * rad).normalize();
      if (this.isOverWater(probe)) continue; // must start on LAND
      axis.copy(up).cross(probe);
      if (axis.lengthSq() < 1e-6) continue;
      axis.normalize();
      const start = probe.clone();
      let waterline = -1;
      for (let step = 0; step <= 48; step++) {
        const m = step * 0.5;
        probe
          .copy(start)
          .applyAxisAngle(axis, m / this.radius)
          .normalize();
        const depth = sea - this.analyticSurface(probe).radius;
        if (waterline < 0) {
          if (depth > 0) waterline = m;
          continue;
        }
        const off = m - waterline;
        for (let k = 0; k < 3; k++) {
          if (Math.abs(off - Island.SURF_BAND_METRES[k]) < 0.26 && depth > 0) acc[k].push(depth);
        }
        if (off > Island.SURF_BAND_METRES[2] + 1) break;
      }
    }
    const median = (a: number[], fallback: number): number => {
      if (a.length < 4) return fallback;
      a.sort((x, y) => x - y);
      return a[Math.floor(a.length / 2)];
    };
    // Fallbacks are the authored R=75 depths, so a pathological island (or a
    // radius where the shelf never reaches these depths) degrades to today.
    const b = new THREE.Vector3(median(acc[0], 1.6), median(acc[1], 2.4), median(acc[2], 3.2));
    // Keep them ordered and sane whatever the sampler returned.
    b.y = Math.max(b.y, b.x + 0.2);
    b.z = Math.max(b.z, b.y + 0.2);
    return b;
  }

  public seaLevel(): number {
    return this.radius + Island.SEA_OFFSET * this.reliefScale;
  }

  /**
   * Radius of the WAVY water surface along `dir` at time `t` — the same
   * sum-of-sines the sea vertex shader uses, so swimmers and boats ride the
   * exact crests you see. `t` is seconds (pass seaTimeUniform.value).
   */
  public waveHeightAt(dir: THREE.Vector3, t: number): number {
    const n = dir.clone().normalize();
    // Mirrors the sea vertex shader exactly (swell + chop) — see onBeforeCompile
    const w =
      Math.sin(n.x * 9.0 + t * 1.3) * 0.6 +
      Math.sin(n.z * 11.0 - t * 1.1) * 0.4 +
      Math.sin((n.x + n.z) * 7.0 + t * 0.9) * 0.5 +
      Math.sin((n.x - n.z) * 23.0 + t * 2.1) * 0.18 +
      Math.sin(n.y * 19.0 + t * 1.7) * 0.12;
    // + tide, so swimmers, boats and jetskis ride the same surface they see
    return this.seaLevel() + w * Island.WAVE_AMP + this.seaTideUniform.value;
  }

  /**
   * Advance the slow tide. Deliberately visual-only: `seaLevel()` and
   * `isOverWater()` stay pinned to MEAN sea level, so land/water
   * classification never changes underneath gameplay — boats can't strand,
   * the water race gates don't drift, and the shoreline barrier stays put.
   * Only the rendered surface and anything floating on it move.
   */
  public updateTide(t: number): void {
    this.seaTideUniform.value = Math.sin((t / Island.TIDE_PERIOD) * Math.PI * 2) * Island.TIDE_AMP;
  }

  /** Current tide offset (+high / -low), for HUD or shoreline FX. */
  public getTide(): number {
    return this.seaTideUniform.value;
  }

  /**
   * True where `dir` is open water — the terrain there sits below the calm
   * sea surface (with a small margin so the beach isn't counted as sea).
   */
  public isOverWater(dir: THREE.Vector3): boolean {
    // Analytic, not raycast. This is a threshold test against sea level, so
    // sub-facet differences between the smooth function and the faceted mesh
    // are irrelevant — but the cost difference is not: this is called all
    // through world generation AND every frame a boat is moving, at 1.22ms per
    // raycast versus 0.003ms here.
    const terrain = this.terrainRadiusFor
      ? this.terrainRadiusFor(
          dir.clone().normalize(),
          dir.clone().normalize().multiplyScalar(this.radius),
        )
      : this.sampleSurfaceByDirection(dir, 0).position.length();
    return terrain < this.seaLevel() - 0.15;
  }

  /**
   * Yaw an already surface-aligned object so its local +Z faces a target
   * point (projected onto the tangent plane). Used to face houses/stalls
   * toward the road/plaza instead of random spins. Public: GameScene's
   * islet beach house aims its door with it too.
   */
  public faceObjectToward(obj: THREE.Object3D, normal: THREE.Vector3, target: THREE.Vector3): void {
    const proj = (v: THREE.Vector3) => v.clone().sub(normal.clone().multiplyScalar(v.dot(normal)));
    const current = proj(new THREE.Vector3(0, 0, 1).applyQuaternion(obj.quaternion));
    const desired = proj(target.clone().sub(obj.position));
    if (current.lengthSq() < 1e-8 || desired.lengthSq() < 1e-8) return;
    current.normalize();
    desired.normalize();
    const angle = Math.atan2(
      new THREE.Vector3().crossVectors(current, desired).dot(normal),
      current.dot(desired),
    );
    obj.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(normal, angle));
  }

  // Global placement registry: every claimed direction with its clearance,
  // shared across all prop categories (and used by GameScene) so independent
  // scatter passes stop clustering on top of each other.
  private occupiedDirs: Array<{ dir: THREE.Vector3; arc: number }> = [];

  /**
   * Metres of surface distance -> the geodesic angle that spans them.
   *
   * ALWAYS use this for a clearance, a keep-out or a search radius. Writing the
   * radian directly bakes in today's radius: a bare 0.13 means 6.5u at R=50 and
   * 9.75u at R=75, so the town silently spreads while the buildings, roads and
   * people in it stay the same size. That is the entire reason the R50->R75
   * migration was a migration and not an edit.
   *
   * Guarded by test/radiusUnits.test.ts, which fails on any bare-literal arc.
   */
  public arc(metres: number): number {
    return metres / this.radius;
  }

  /**
   * Claim a surface direction with a minimum angular clearance. If the
   * candidate is too close to something already placed, jitter around it
   * (up to 10 tries) before accepting the least-bad candidate.
   */
  public claimDir(candidate: THREE.Vector3, minArc: number, maxSlopeRad?: number): THREE.Vector3 {
    const base = candidate.clone().normalize();
    let best = base.clone();
    let bestClearance = -1;
    const scratchT = new THREE.Vector3();
    for (let attempt = 0; attempt < 10; attempt++) {
      let dir: THREE.Vector3;
      if (attempt === 0) {
        dir = base.clone();
      } else {
        // Search a neighbourhood PROPORTIONAL to the clearance we need, spiralling
        // outward as attempts fail.
        //
        // This used to add a fixed Vector3 of up to (0.25, 0.175, 0.25) to a UNIT
        // direction — an angle of ~0.25 rad, i.e. 12u at R=50 and 19u at R=75. So a
        // parked car that could not fit at its kerb got thrown a fifth of the way
        // across the district and kept the least-bad result: measured kerb offsets
        // were 14.92u against a 2.43u target. An object should look for space NEAR
        // where it belongs, and the size of "near" is its own footprint, not a
        // fixed slice of the planet.
        scratchT.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5);
        scratchT.addScaledVector(base, -scratchT.dot(base)); // project into the tangent plane
        if (scratchT.lengthSq() < 1e-8) continue;
        scratchT.normalize();
        const reach = minArc * (0.6 + (1.4 * attempt) / 9); // 0.6x -> 2.0x of minArc
        dir = base
          .clone()
          .multiplyScalar(Math.cos(reach))
          .addScaledVector(scratchT, Math.sin(reach))
          .normalize();
      }
      // Island-only world: every claim stays above the shoreline. The
      // jitter used to shove crowded losers south of the shore, parking
      // stalls/NPCs on the seafloor.
      if (dir.y < Math.sin(0.29)) {
        dir.y = Math.sin(0.29) + Math.random() * 0.03;
        dir.normalize();
      }
      let clearance = Infinity;
      for (const o of this.occupiedDirs) {
        clearance = Math.min(clearance, dir.angleTo(o.dir) - o.arc);
      }
      // Slope check: structures on steep sites bury their uphill corner and
      // float the downhill one - reject steep candidates so buildings settle
      // on flat-ish ground.
      let slopeOk = true;
      if (typeof maxSlopeRad === 'number') {
        try {
          const s = this.sampleSurfacePosition(dir.clone().multiplyScalar(this.radius), 0);
          const n = (s as { rawNormal?: THREE.Vector3 }).rawNormal ?? s.normal;
          slopeOk = n.angleTo(dir) <= maxSlopeRad;
        } catch {
          slopeOk = true;
        }
      }
      if (clearance >= minArc && slopeOk) {
        this.occupiedDirs.push({ dir, arc: minArc });
        return dir;
      }
      if (clearance > bestClearance) {
        bestClearance = clearance;
        best = dir;
      }
    }
    this.occupiedDirs.push({ dir: best, arc: minArc });
    return best;
  }

  private sampleSurfacePosition(
    approxPos: THREE.Vector3,
    desiredOffset: number = 0,
  ): { position: THREE.Vector3; normal: THREE.Vector3; rawNormal?: THREE.Vector3 } {
    // Enhanced fallback: use nearest point on terrain mesh if available
    const fallbackNormal = approxPos.clone().normalize();
    const fallbackPos = this.center
      .clone()
      .add(fallbackNormal.clone().multiplyScalar(this.radius + desiredOffset));

    try {
      if (!this.surfaceMesh) return { position: fallbackPos, normal: fallbackNormal };

      // direction from center to approx position
      const dir = approxPos.clone().normalize();
      // DERIVED, not guessed: this was a literal 4.5 while the terrain clamp
      // allows MAX_DISPLACEMENT * reliefScale (13.8 at R=75) — every ray that
      // starts below the peaks begins INSIDE the mountain, misses the front
      // face, and this function silently seats the prop on the bare base
      // sphere (lamps/stalls/rivers/flowers buried or floating on every hill).
      // Same derivation as the twin sampler at sampleSurfaceByDirection.
      const maxExpectedDisplacement = Island.SAMPLE_RAY_DISP * this.reliefScale;

      // Try multiple raycast strategies to robustly hit displaced geometry
      const strategies = [] as { start: THREE.Vector3; dir: THREE.Vector3; far: number }[];

      // primary: cast from slightly outside the max displacement inward along center
      const primaryStart = this.center
        .clone()
        .add(dir.clone().multiplyScalar(this.radius + maxExpectedDisplacement + 1.0));
      strategies.push({
        start: primaryStart,
        dir: this.center.clone().sub(primaryStart).normalize(),
        far: maxExpectedDisplacement + 3.0 + this.radius,
      });

      // secondary: cast a short ray outward from a point on the base radius toward the sky (handles cases with overhangs)
      const basePoint = this.center.clone().add(dir.clone().multiplyScalar(this.radius + 0.02));
      const outStart = basePoint.clone().add(dir.clone().multiplyScalar(-1.0)); // slightly inside
      strategies.push({ start: outStart, dir: dir.clone().normalize(), far: 8.0 });

      // tertiary: jittered inward rays to catch nearby displaced peaks (helps when sampling on very bumpy areas)
      const jitterAngles = [0.0, 0.15, -0.15, 0.3, -0.3, 0.45, -0.45];
      for (const a of jitterAngles) {
        const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), a);
        const jDir = dir.clone().applyQuaternion(q).normalize();
        const s = this.center
          .clone()
          .add(jDir.clone().multiplyScalar(this.radius + maxExpectedDisplacement + 1.0));
        strategies.push({
          start: s,
          dir: this.center.clone().sub(s).normalize(),
          far: maxExpectedDisplacement + 3.0 + this.radius,
        });
      }

      // make sure the mesh matrices are up-to-date
      this.surfaceMesh.updateMatrixWorld(true);

      let hit: THREE.Intersection | null = null;
      let usedStrategyStart: THREE.Vector3 | null = null;
      // ONE reused raycaster (was a fresh allocation per strategy — 9 per
      // call), and firstHitOnly so the BVH stops at the nearest face like the
      // twin sampler does.
      const raycaster = Island._scratchRaycaster;
      raycaster.firstHitOnly = true;
      for (const strat of strategies) {
        try {
          raycaster.set(strat.start, strat.dir);
          raycaster.near = 0;
          raycaster.far = strat.far;
          const intersects = raycaster.intersectObject(this.surfaceMesh, true);
          if (intersects && intersects.length) {
            hit = intersects[0];
            usedStrategyStart = strat.start;
            break;
          }
        } catch {
          // ignore and try next
        }
      }

      if (hit) {
        const point = hit.point.clone();
        // remember the strat.start used for debug line (approximate)
        // find the first strategy whose ray would have hit roughly this point (best-effort)
        for (const strat of strategies) {
          const toP = point.clone().sub(strat.start);
          const proj = toP.dot(strat.dir);
          if (proj > 0 && proj < strat.far + 1e-3) {
            usedStrategyStart = strat.start;
            break;
          }
        }
        // compute a world-space normal from the hit face
        let normal = new THREE.Vector3(0, 1, 0);
        if (hit.face) {
          const nm = new THREE.Matrix3().getNormalMatrix(hit.object.matrixWorld);
          normal = hit.face.normal.clone().applyMatrix3(nm).normalize();
        } else {
          normal = point.clone().sub(this.center).normalize();
        }
        const rawNormal = normal.clone(); // unclamped - used for slope tests
        // Clamp tilt: raw face normals on bumpy terrain deviate wildly from "up",
        // laying large props (stalls, mountains, cars) on their sides. Keep the
        // terrain-sampled position but cap orientation at a slight lean.
        {
          const radial = point.clone().sub(this.center).normalize();
          if (normal.dot(radial) < 0) normal.negate();
          // 0.42 (~24°) — raised from 0.21: the old 12° cap made every prop
          // read RADIAL on ordinary hillsides ("trees growing straight up on
          // slopes"). 24° still guards the original failure (raw single-
          // triangle normals laying big props on their sides on crags) while
          // letting assets visibly follow the ground they stand on.
          const MAX_TILT = 0.42;
          const tilt = radial.angleTo(normal);
          if (tilt > MAX_TILT) {
            const axis = new THREE.Vector3().crossVectors(radial, normal);
            normal =
              axis.lengthSq() > 1e-10
                ? radial.clone().applyAxisAngle(axis.normalize(), MAX_TILT).normalize()
                : radial;
          }
        }
        // apply a tiny outward epsilon so placed objects don't z-fight
        // Small epsilon to prevent z-fighting, actual object offsets handled separately
        const epsilon = 0.02;
        const outPos = point.clone().add(normal.clone().multiplyScalar(epsilon + desiredOffset));
        // debug: draw helper sphere + ray.
        // `this.mesh` is assigned only AFTER createIsland() RETURNS, and every
        // prop is placed inside it — so during world generation this read threw
        // TypeError, the outer catch swallowed it, and the method silently
        // returned the base-sphere fallback (RADIAL normal, no terrain height)
        // for all 569 calls. That is why stalls, cars and lamps stood bolt
        // upright on 29-degree ground while houses (which use the OTHER
        // sampler) followed it correctly.
        const rootMesh = this.mesh as THREE.Group | undefined;
        const meshData = (rootMesh?.userData ?? {}) as IslandMeshUserData;
        if (meshData._debug && rootMesh) {
          const helpers = meshData._debugHelpers ?? new THREE.Group();
          if (!meshData._debugHelpers) {
            meshData._debugHelpers = helpers;
          }
          // small sphere at hit point
          const sph = new THREE.Mesh(
            new THREE.SphereGeometry(0.03, 6, 6),
            new THREE.MeshBasicMaterial({ color: 0xff00ff }),
          );
          sph.position.copy(point);
          // line from ray start to hit
          const from = usedStrategyStart ? usedStrategyStart.clone() : primaryStart.clone();
          const lineGeom = new THREE.BufferGeometry().setFromPoints([from.clone(), point.clone()]);
          const line = new THREE.Line(lineGeom, new THREE.LineBasicMaterial({ color: 0x00ffff }));
          helpers.add(sph);
          helpers.add(line);
          // attach helpers if not attached
          if (!helpers.parent) rootMesh.add(helpers);
          // remove helpers shortly to avoid memory growth
          setTimeout(() => {
            helpers.remove(sph);
            helpers.remove(line);
          }, 2000);
        }
        return { position: outPos, normal, rawNormal };
      }
      return { position: fallbackPos, normal: fallbackNormal };
    } catch {
      return { position: fallbackPos, normal: fallbackNormal };
    }
  }

  // Street keep-out registry: segment midpoints with an angular margin so
  // organic scatter (trees, flowers) stays off the pavement. Deliberately
  // separate from claimDir's occupiedDirs — structures PLACED along a street
  // (buildings, cars, lamps) must be allowed closer than a claim would let.
  private streetDirs: Array<{ dir: THREE.Vector3; halfArc: number }> = [];
  // Latitude-banded index over streetDirs. isNearStreet used to linear-scan
  // hundreds of segments with angleTo (an acos) per query — and the grass pass
  // alone makes 100k queries, order 10⁷ trig ops of pure boot time. Each entry
  // is inserted into every band its keep-out arc can reach (|Δy| ≤ chord ≤ arc),
  // so scanning ONLY the query's band is exact, and `angle < halfArc` is
  // replaced by the equivalent squared-chord test (chord = 2·sin(halfArc/2),
  // monotonic in angle for unit vectors — no acos, no sqrt).
  private streetBuckets: Array<Array<{ dir: THREE.Vector3; chordSq: number }>> | null = null;
  private static readonly STREET_BANDS = 24; // y ∈ [-1,1] → band width 1/12

  private streetBandOf(y: number): number {
    const b = Math.floor(((y + 1) / 2) * Island.STREET_BANDS);
    return Math.min(Island.STREET_BANDS - 1, Math.max(0, b));
  }

  private ensureStreetBuckets(): Array<Array<{ dir: THREE.Vector3; chordSq: number }>> {
    if (this.streetBuckets) return this.streetBuckets;
    const buckets: Array<Array<{ dir: THREE.Vector3; chordSq: number }>> = [];
    for (let b = 0; b < Island.STREET_BANDS; b++) buckets.push([]);
    for (const s of this.streetDirs) {
      const chord = 2 * Math.sin(s.halfArc / 2);
      const entry = { dir: s.dir, chordSq: chord * chord };
      const lo = this.streetBandOf(s.dir.y - s.halfArc);
      const hi = this.streetBandOf(s.dir.y + s.halfArc);
      for (let b = lo; b <= hi; b++) buckets[b].push(entry);
    }
    this.streetBuckets = buckets;
    return buckets;
  }

  /** True when a unit direction lands on (or within margin of) a street. */
  public isNearStreet(dir: THREE.Vector3): boolean {
    const bucket = this.ensureStreetBuckets()[this.streetBandOf(dir.y)];
    for (const s of bucket) {
      if (dir.distanceToSquared(s.dir) < s.chordSq) return true;
    }
    return false;
  }

  /** If `dir` sits on a street, slide it sideways off the pavement (benches,
   * props that belong BESIDE a path, not on it). Returns the nudged direction. */
  public pushOffStreet(dir: THREE.Vector3, step = -1, tries = 10): THREE.Vector3 {
    // A metre step, not an angle. This is the one place the two unit systems
    // actively fight: keepOutArc SHRINKS in radians as the world grows while a
    // fixed radian step GROWS in metres, so at R=75 a 0.03 step overshot to
    // 2.25u from a 1.0u-wide road and every prop routed through claimOffStreet
    // inherited the extra setback.
    if (step < 0) step = this.arc(1.5);
    const d = dir.clone().normalize();
    for (let i = 0; i < tries && this.isNearStreet(d); i++) {
      const s = this.nearestStreetDir(d, this.arc(30));
      if (!s) break;
      // Tangent pointing away from the street point (project d−s onto d's plane)
      const away = d.clone().sub(s);
      away.addScaledVector(d, -away.dot(d));
      if (away.lengthSq() < 1e-8) break;
      away.normalize();
      d.addScaledVector(away, step).normalize();
      if (d.y < Math.sin(0.29)) {
        d.y = Math.sin(0.29);
        d.normalize();
      }
    }
    return d;
  }

  /** The nearest street-segment direction (for orienting shops/houses to face
   * the pathway), or null if there are no streets or the nearest is > maxArc. */
  public nearestStreetDir(dir: THREE.Vector3, maxArc = -1): THREE.Vector3 | null {
    if (maxArc < 0) maxArc = this.arc(17.5); // "how far away a street may still be MY street"
    let best: THREE.Vector3 | null = null;
    let bestAng = maxArc;
    for (const s of this.streetDirs) {
      const a = dir.angleTo(s.dir);
      if (a < bestAng) {
        bestAng = a;
        best = s.dir;
      }
    }
    return best ? best.clone() : null;
  }

  /**
   * Reserve a conflict-free surface spot that ALSO sits off the streets.
   * Drop-in replacement for claimDir with the same (dir, arc)→dir signature:
   * slide off any pavement first, claimDir to clear other props, then slide off
   * again in case claimDir's jitter nudged the pick back onto a path. Every
   * hand-placed structure goes through this so nothing lands on a road and
   * nothing double-claims a position. Returns a fresh unit direction.
   */
  /**
   * Spiral outward from `rawDir` for the CLOSEST direction that is off-street
   * and clear of every claimed prop by `clearArc`.
   *
   * `claimOffStreet` throws fourteen random darts and takes the first that
   * clears; in a dense district every dart misses, and it then silently
   * returns its least-bad candidate and registers it anyway — which is how
   * the Night Watch's brazier ended up underneath the fish stall. Walking
   * concentric rings finds the nearest genuinely free plot instead, so a
   * station stays beside its owner rather than landing wherever a lucky dart
   * happened to fall.
   *
   * `maxDrift` is a HARD leash in radians. A workplace that wanders is as
   * wrong as one that clips: unleashed, the Mayor's lectern ended up 16.4u
   * from the plaza he holds court in and the Keeper's yard 11.8u from the
   * tower he keeps. When nothing inside the leash fully clears, this returns
   * the ROOMIEST spot it found rather than falling through to the dart
   * thrower — a slightly tight fit beside the right person beats a perfect
   * fit on the wrong side of the district.
   */
  private claimClearSpot(rawDir: THREE.Vector3, clearArc: number, maxDrift = -1): THREE.Vector3 {
    if (maxDrift < 0) maxDrift = this.arc(6); // leash: 6u of search, not 6u-at-R50
    const centre = rawDir.clone().normalize();
    // maxDrift 0 = EXACT placement. Each district pre-claims a 6.5u disc round
    // its hall, so searching for "clear ground" can never tuck anything against
    // a hall wall — it shoves the station back out to the leash and into the
    // field it was being rescued from. When the caller computed a spot from the
    // hall's own measured geometry it knows something the search does not, so
    // it wins. The footprint is still registered, so later props avoid it.
    if (maxDrift <= 0) {
      this.occupiedDirs.push({ dir: centre, arc: clearArc });
      return centre;
    }
    // Any tangent basis will do; we only need to sweep a full circle in it.
    let tangent = new THREE.Vector3(0, 1, 0).cross(centre);
    if (tangent.lengthSq() < 1e-6) tangent = new THREE.Vector3(1, 0, 0).cross(centre);
    tangent.normalize();
    const bitangent = centre.clone().cross(tangent).normalize();
    const RING_STEP = this.arc(1); // 1u between search rings at any radius
    const rings = Math.max(1, Math.round(maxDrift / RING_STEP));
    let best: THREE.Vector3 | null = null;
    let bestClearance = -Infinity;
    for (let ring = 0; ring <= rings; ring++) {
      const arc = ring * RING_STEP;
      const steps = ring === 0 ? 1 : ring * 8;
      for (let k = 0; k < steps; k++) {
        const a = (k / steps) * Math.PI * 2;
        const out = tangent
          .clone()
          .multiplyScalar(Math.cos(a))
          .addScaledVector(bitangent, Math.sin(a));
        const dir = centre
          .clone()
          .multiplyScalar(Math.cos(arc))
          .addScaledVector(out, Math.sin(arc))
          .normalize();
        if (dir.y < Math.sin(0.29)) continue; // below the habitable band
        if (this.isNearStreet(dir)) continue;
        let clearance = Infinity;
        for (const o of this.occupiedDirs) {
          clearance = Math.min(clearance, dir.angleTo(o.dir) - o.arc);
        }
        if (clearance >= clearArc) {
          this.occupiedDirs.push({ dir, arc: clearArc });
          return dir;
        }
        if (clearance > bestClearance) {
          bestClearance = clearance;
          best = dir.clone();
        }
      }
    }
    const pick = best ?? centre;
    this.occupiedDirs.push({ dir: pick, arc: clearArc });
    return pick;
  }

  public claimOffStreet(rawDir: THREE.Vector3, clearArc: number): THREE.Vector3 {
    // Street-aware claim: like claimDir, but every jittered candidate is first
    // slid off the pavement, and any that still lands on a road is rejected — so
    // the result is BOTH off the road AND clear of other props in one pass, and
    // it registers the FINAL spot. (The earlier pushOff-then-reclaim could
    // re-jitter a crowded pick back onto the road — e.g. a parked car onto the
    // middle of the boulevard.)
    let base = rawDir.clone().normalize();
    if (this.isNearStreet(base)) base = this.pushOffStreet(base);
    let best = base.clone();
    let bestClearance = -Infinity;
    const scratchT = new THREE.Vector3();
    for (let attempt = 0; attempt < 14; attempt++) {
      let dir: THREE.Vector3;
      if (attempt === 0) {
        dir = base.clone();
      } else {
        // Neighbourhood search scaled to the clearance sought — see claimDir for
        // the full rationale. This was a SECOND verbatim copy of the fixed
        // unit-sphere jitter, so fixing claimDir alone left every street-aware
        // placement (cars, stalls, houses, towers, stations) still throwing
        // props up to 19u off their site at R=75.
        scratchT.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5);
        scratchT.addScaledVector(base, -scratchT.dot(base));
        if (scratchT.lengthSq() < 1e-8) continue;
        scratchT.normalize();
        const reach = clearArc * (0.6 + (1.4 * attempt) / 13); // 0.6x -> 2.0x of clearArc
        dir = base
          .clone()
          .multiplyScalar(Math.cos(reach))
          .addScaledVector(scratchT, Math.sin(reach))
          .normalize();
      }
      if (dir.y < Math.sin(0.29)) {
        dir.y = Math.sin(0.29) + Math.random() * 0.03;
        dir.normalize();
      }
      if (this.isNearStreet(dir)) dir = this.pushOffStreet(dir);
      if (this.isNearStreet(dir)) continue; // still on a road after the nudge — reject
      let clearance = Infinity;
      for (const o of this.occupiedDirs) {
        clearance = Math.min(clearance, dir.angleTo(o.dir) - o.arc);
      }
      if (clearance >= clearArc) {
        this.occupiedDirs.push({ dir, arc: clearArc });
        return dir;
      }
      if (clearance > bestClearance) {
        bestClearance = clearance;
        best = dir.clone();
      }
    }
    this.occupiedDirs.push({ dir: best, arc: clearArc });
    return best;
  }

  // ── District amenities (expansion slice 2) ───────────────────────────
  // "Spread shops and social amenities across zones that make sense": each
  // district gets street furniture matching its identity — a coffee kiosk +
  // cafe tables by the Professional hall, a notice board + canteen cart in
  // Projects, a farm stand near the food farm, market tables with parasols
  // in Contact, drinking fountains on the long walks. Two are FUNCTIONAL
  // (kiosk opens the shop, board opens the Island Times); the rest are
  // dressing. Everything self-seats (parented to a group the terrain
  // re-seater skips), stands PLUMB, and faces the nearest street.
  public kioskSite: THREE.Vector3 | null = null;
  public noticeBoardSite: THREE.Vector3 | null = null;
  public canteenSite: THREE.Vector3 | null = null; // produce buyer (wave 3)

  private buildDistrictAmenities(parent: THREE.Group): void {
    // SHIELD (the clump-builder law): the seeded window spans ALL Island
    // construction and the boat anchors draw from the stream AFTER us —
    // claimOffStreet jitter AND uuid mints must route to a local stream.
    const stashedRandom = Math.random;
    let seed = 0xa3e17a5d >>> 0;
    Math.random = () => {
      seed = (seed + 0x6d2b79f5) >>> 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    try {
      this.buildDistrictAmenitiesShielded(parent);
    } finally {
      Math.random = stashedRandom;
    }
  }

  private buildDistrictAmenitiesShielded(parent: THREE.Group): void {
    const wood = Materials.createStandardMaterial({ color: 0xb08a55 });
    const darkWood = Materials.createStandardMaterial({ color: 0x7a5738 });
    const cloth = Materials.createStandardMaterial({ color: 0xc0553f });
    const stone = Materials.createStandardMaterial({ color: 0xa8a294 });
    const metal = Materials.createStandardMaterial({ color: 0x847f78 });
    const paper = Materials.createStandardMaterial({ color: 0xf1e7d0 });
    const AXIS_Y = new THREE.Vector3(0, 1, 0);
    const noIdx = (g: THREE.BufferGeometry): THREE.BufferGeometry =>
      g.index ? g.toNonIndexed() : g;
    const merge = (parts: THREE.BufferGeometry[], mat: THREE.Material): THREE.Mesh => {
      const m = new THREE.Mesh(
        mergeGeometries(parts.map(noIdx), false) as THREE.BufferGeometry,
        mat,
      );
      m.castShadow = true;
      return m;
    };
    const seatAmenity = (
      lon: number,
      lat: number,
      clearM: number,
      build: (g: THREE.Group) => void,
      publish?: 'kiosk' | 'board' | 'canteen',
    ): void => {
      const dir = this.claimOffStreet(this.dirAt(lon, lat), this.arc(clearM));
      // STRUCTURAL apron guarantee: claimOffStreet can slide a prop toward a
      // plaza (its clearances know streets and props, not halls). If it did,
      // slide directly AWAY from that plaza back onto the apron ring —
      // amenities must never end up inside a district hall.
      // Converge: a street push can re-encroach a plaza and vice versa, so
      // iterate until BOTH constraints hold (4 passes always suffice with a
      // 1m slack between the 5.5m slide target and the 4.5m trigger).
      for (let guardPass = 0; guardPass < 4; guardPass++) {
        let moved = false;
        if (this.isNearStreet(dir)) {
          dir.copy(this.pushOffStreet(dir));
          moved = true;
        }
        for (const dLon of RING_DISTRICT_LONS) {
          const plaza = this.dirAt(dLon, ZONE_LAT);
          if (dir.angleTo(plaza) >= this.arc(4.5)) continue;
          const away = dir.clone().addScaledVector(plaza, -dir.dot(plaza)).normalize();
          dir
            .copy(plaza)
            .multiplyScalar(Math.cos(this.arc(5.5)))
            .addScaledVector(away, Math.sin(this.arc(5.5)))
            .normalize();
          moved = true;
        }
        if (!moved) break;
      }
      let seat: { position: THREE.Vector3; normal: THREE.Vector3 };
      try {
        seat = this.sampleSurfaceByDirection(dir, 0);
      } catch {
        return; // unsamplable — skip rather than float a prop
      }
      const g = new THREE.Group();
      g.position.copy(seat.position);
      const up = seat.position.clone().normalize(); // PLUMB — never the slope
      g.quaternion.setFromUnitVectors(AXIS_Y, up);
      const street = this.nearestStreetDir(dir, this.arc(25));
      if (street) this.faceObjectToward(g, up, street.multiplyScalar(this.radius));
      build(g);
      parent.add(g);
      // Publish the SEATED position — claimOffStreet slides props, so the
      // authored lon/lat must never be read back for proximity checks.
      if (publish === 'kiosk') this.kioskSite = seat.position.clone();
      if (publish === 'canteen') this.canteenSite = seat.position.clone();
      if (publish === 'board') this.noticeBoardSite = seat.position.clone();
    };

    // Coffee kiosk (FUNCTIONAL — opens the shop) on the Professional apron.
    seatAmenity(
      0.34,
      ZONE_LAT - this.arc(6),
      3.5,
      (g) => {
        g.add(
          merge(
            [
              new THREE.BoxGeometry(1.3, 0.8, 0.9).translate(0, 0.4, 0), // skirt
              new THREE.BoxGeometry(1.5, 0.08, 1.0).translate(0, 0.86, 0), // counter
            ],
            wood,
          ),
          merge(
            [0, 1, 2, 3].map((i) =>
              new THREE.BoxGeometry(0.1, 1.5, 0.1).translate(
                i % 2 === 0 ? -0.65 : 0.65,
                0.75,
                i < 2 ? -0.4 : 0.4,
              ),
            ),
            darkWood,
          ),
          merge([new THREE.BoxGeometry(1.7, 0.07, 1.3).rotateX(0.22).translate(0, 1.58, 0)], cloth),
          merge(
            [
              new THREE.CylinderGeometry(0.14, 0.14, 0.35, 8).translate(-0.3, 1.05, 0), // urn
              new THREE.CylinderGeometry(0.05, 0.04, 0.08, 6).translate(0.2, 0.94, 0.15),
              new THREE.CylinderGeometry(0.05, 0.04, 0.08, 6).translate(0.42, 0.94, -0.1),
            ],
            metal,
          ),
        );
        addGroupHulls(g, 0.7, () => true);
      },
      'kiosk',
    );
    // Cafe tables beside it.
    for (const [lon, lat] of [
      [0.3, ZONE_LAT - this.arc(5.9)],
      [0.385, ZONE_LAT - this.arc(6.2)],
    ]) {
      seatAmenity(lon, lat, 2.5, (g) => {
        g.add(
          merge(
            [
              new THREE.CylinderGeometry(0.09, 0.12, 0.75, 6).translate(0, 0.37, 0),
              new THREE.CylinderGeometry(0.45, 0.45, 0.05, 8).translate(0, 0.78, 0),
              new THREE.CylinderGeometry(0.16, 0.18, 0.42, 6).translate(0.7, 0.21, 0.2),
              new THREE.CylinderGeometry(0.16, 0.18, 0.42, 6).translate(-0.6, 0.21, -0.35),
            ],
            wood,
          ),
        );
      });
    }
    // Drinking fountains on the long walks.
    for (const [lon, lat] of [
      [6.18, ZONE_LAT - this.arc(3.8)],
      [1.61, ZONE_LAT + this.arc(4)],
    ]) {
      seatAmenity(lon, lat, 2, (g) => {
        g.add(
          merge(
            [
              new THREE.CylinderGeometry(0.4, 0.45, 0.5, 8).translate(0, 0.25, 0),
              new THREE.CylinderGeometry(0.12, 0.14, 0.9, 6).translate(0, 0.85, 0),
              new THREE.CylinderGeometry(0.05, 0.03, 0.12, 6)
                .rotateZ(Math.PI / 2)
                .translate(0.14, 1.22, 0),
            ],
            stone,
          ),
        );
      });
    }
    // Projects notice board (FUNCTIONAL — opens the Island Times).
    seatAmenity(
      1.72,
      ZONE_LAT - this.arc(6),
      3,
      (g) => {
        g.add(
          merge(
            [
              new THREE.BoxGeometry(0.12, 1.7, 0.12).translate(-0.75, 0.85, 0),
              new THREE.BoxGeometry(0.12, 1.7, 0.12).translate(0.75, 0.85, 0),
              new THREE.BoxGeometry(1.8, 0.08, 0.5).rotateX(0.35).translate(0, 1.78, -0.08),
            ],
            darkWood,
          ),
          merge([new THREE.BoxGeometry(1.6, 1.1, 0.08).translate(0, 1.1, 0)], wood),
          merge(
            [
              new THREE.BoxGeometry(0.42, 0.55, 0.02).rotateZ(0.06).translate(-0.45, 1.12, 0.06),
              new THREE.BoxGeometry(0.42, 0.4, 0.02).rotateZ(-0.09).translate(0.1, 1.2, 0.06),
              new THREE.BoxGeometry(0.35, 0.5, 0.02).rotateZ(0.04).translate(0.55, 1.0, 0.06),
            ],
            paper,
          ),
        );
        addGroupHulls(g, 0.7, () => true);
      },
      'board',
    );
    // Site canteen cart for the construction-yard corner of Projects.
    seatAmenity(
      1.81,
      0.55,
      3.5,
      (g) => {
        g.add(
          merge(
            [
              new THREE.BoxGeometry(1.2, 0.5, 0.75).translate(0, 0.62, 0), // tray
              new THREE.BoxGeometry(0.08, 0.08, 1.0).translate(-0.45, 0.42, 0.75), // shaft
              new THREE.BoxGeometry(0.08, 0.08, 1.0).translate(0.45, 0.42, 0.75),
              new THREE.BoxGeometry(0.45, 0.3, 0.45).translate(-0.25, 1.02, 0), // crates
              new THREE.BoxGeometry(0.4, 0.26, 0.4).translate(0.28, 1.0, 0.1),
            ],
            wood,
          ),
          merge(
            [
              new THREE.CylinderGeometry(0.26, 0.26, 0.08, 10)
                .rotateZ(Math.PI / 2)
                .translate(-0.62, 0.26, 0),
              new THREE.CylinderGeometry(0.26, 0.26, 0.08, 10)
                .rotateZ(Math.PI / 2)
                .translate(0.62, 0.26, 0),
            ],
            darkWood,
          ),
          merge([new THREE.BoxGeometry(1.4, 0.06, 1.0).rotateX(0.18).translate(0, 1.62, 0)], cloth),
        );
        addGroupHulls(g, 0.7, () => true);
      },
      'canteen',
    );
    // Farm stand near the food farm.
    seatAmenity(2.72, 0.6, 3, (g) => {
      g.add(
        merge(
          [
            new THREE.BoxGeometry(1.4, 0.08, 0.7).translate(0, 0.7, 0),
            new THREE.BoxGeometry(0.1, 0.7, 0.1).translate(-0.6, 0.35, -0.25),
            new THREE.BoxGeometry(0.1, 0.7, 0.1).translate(0.6, 0.35, -0.25),
            new THREE.BoxGeometry(0.1, 0.7, 0.1).translate(-0.6, 0.35, 0.25),
            new THREE.BoxGeometry(0.1, 0.7, 0.1).translate(0.6, 0.35, 0.25),
            new THREE.BoxGeometry(0.5, 0.28, 0.45).translate(-0.35, 0.9, 0),
            new THREE.BoxGeometry(0.45, 0.24, 0.4).translate(0.3, 0.88, 0.05),
          ],
          wood,
        ),
        merge([new THREE.BoxGeometry(1.6, 0.06, 0.9).rotateX(0.2).translate(0, 1.5, 0)], cloth),
      );
      addGroupHulls(g, 0.7, () => true);
    });
    // Market tables with parasols for the Contact plaza approach. The canopy
    // rim breathes in the wind on the shared grass clock. `parasolSway` only
    // ASSIGNS onBeforeCompile and returns the same material, so the
    // createStandardMaterial call stays in its exact allocation slot — the RNG
    // census is byte-identical (no new draws, no reorder).
    const parasolSway = (mat: THREE.MeshStandardMaterial): THREE.MeshStandardMaterial => {
      mat.onBeforeCompile = (shader) => {
        shader.uniforms.uTime = this.grassTimeUniform;
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', '#include <common>\nuniform float uTime;')
          .replace(
            '#include <begin_vertex>',
            [
              '#include <begin_vertex>',
              // Cone: apex at y≈2.45, rim at y≈2.05. Lift the rim, hold the apex.
              '  float umRim = clamp((2.45 - position.y) / 0.4, 0.0, 1.0);',
              '  float umW = sin(uTime * 1.6 + position.x * 3.0 + position.z * 3.0);',
              '  transformed.y += umW * 0.03 * umRim * umRim;',
            ].join('\n'),
          );
      };
      return mat;
    };
    for (const [lon, lat] of [
      [4.6, ZONE_LAT + this.arc(6.5)],
      [4.82, ZONE_LAT + this.arc(7)],
    ]) {
      seatAmenity(lon, lat, 2.5, (g) => {
        g.add(
          merge(
            [
              new THREE.CylinderGeometry(0.1, 0.13, 0.75, 6).translate(0, 0.37, 0),
              new THREE.CylinderGeometry(0.5, 0.5, 0.05, 8).translate(0, 0.78, 0),
              new THREE.CylinderGeometry(0.16, 0.18, 0.42, 6).translate(0.72, 0.21, 0.15),
              new THREE.CylinderGeometry(0.16, 0.18, 0.42, 6).translate(-0.55, 0.21, -0.4),
              new THREE.CylinderGeometry(0.035, 0.035, 1.5, 6).translate(0, 1.5, 0),
            ],
            wood,
          ),
          merge(
            [new THREE.ConeGeometry(0.9, 0.4, 8).translate(0, 2.25, 0)],
            parasolSway(Materials.createStandardMaterial({ color: 0xb46bd8 })),
          ),
        );
      });
    }
  }

  // ── Building planters (expansion slice 3 — flowers near buildings) ───
  // 30+ planter boxes derived from the BUILT transforms of houses, towers,
  // stalls and the three civic sites — 5 instanced draws total (box, soil,
  // stems, centres, petals with per-instance district hue; instanceColor
  // MULTIPLIES vertexColor, so petals are authored white).
  private buildBuildingPlanters(
    parent: THREE.Group,
    houses: THREE.Group,
    buildings: THREE.Group,
    stalls: THREE.Group,
  ): void {
    const stashedRandom = Math.random;
    let seed = 0xb10c0e5a >>> 0;
    Math.random = () => {
      seed = (seed + 0x6d2b79f5) >>> 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    try {
      this.buildBuildingPlantersShielded(parent, houses, buildings, stalls);
    } finally {
      Math.random = stashedRandom;
    }
  }

  private buildBuildingPlantersShielded(
    parent: THREE.Group,
    houses: THREE.Group,
    buildings: THREE.Group,
    stalls: THREE.Group,
  ): void {
    // Candidate spots from BUILT transforms (claimOffStreet slid everything;
    // authored coords are stale by metres).
    const spots: THREE.Vector3[] = [];
    const fwd = new THREE.Vector3();
    const side = new THREE.Vector3();
    const addPair = (obj: THREE.Object3D, fwdDist: number, lateral: number): void => {
      fwd.set(0, 0, 1).applyQuaternion(obj.quaternion);
      side.crossVectors(obj.position.clone().normalize(), fwd).normalize();
      for (const s of [1, -1]) {
        spots.push(
          obj.position
            .clone()
            .addScaledVector(fwd, fwdDist)
            .addScaledVector(side, lateral * s),
        );
      }
    };
    for (const h of houses.children) if (h.name.startsWith('house_')) addPair(h, 2.0, 1.5);
    for (const b of buildings.children) addPair(b, 2.3, 1.4);
    // Stalls face the street with -Z (faceObjectToward prop convention) —
    // beds go BEHIND the counters, clear of the street-side shopper spots.
    for (const st of stalls.children) {
      fwd.set(0, 0, 1).applyQuaternion(st.quaternion); // +Z = behind
      spots.push(st.position.clone().addScaledVector(fwd, 1.6));
    }
    // Civic sites (school, bank, hospital): a pair each, east-west lateral.
    for (const [lon, lat] of [
      [2.3, 0.62],
      [5.95, 1.22],
      [0.15, 0.68],
    ]) {
      const dir = this.dirAt(lon, lat);
      const a = this.analyticSurface(dir);
      const pos = dir.clone().multiplyScalar(a.radius);
      const east = new THREE.Vector3(-dir.z, 0, dir.x).normalize();
      spots.push(pos.clone().addScaledVector(east, 1.5));
      spots.push(pos.clone().addScaledVector(east, -1.5));
    }

    // Instanced parts. Petals are WHITE geometry + per-instance hue.
    const boxGeo = new THREE.BoxGeometry(0.9, 0.3, 0.32);
    const soilGeo = new THREE.BoxGeometry(0.78, 0.06, 0.24);
    const stemGeo = new THREE.CylinderGeometry(0.018, 0.022, 0.28, 4);
    const centreGeo = new THREE.SphereGeometry(0.045, 5, 4);
    const petalGeo = new THREE.SphereGeometry(0.055, 5, 4);
    petalGeo.scale(1.25, 0.55, 1.25);
    const BLOOMS = 4;
    const PETALS = 5;
    const n = spots.length;
    const boxIM = new THREE.InstancedMesh(
      boxGeo,
      Materials.createStandardMaterial({ color: 0xc9a978 }),
      n,
    );
    boxIM.castShadow = true;
    const soilIM = new THREE.InstancedMesh(
      soilGeo,
      Materials.createStandardMaterial({ color: 0x5b4230 }),
      n,
    );
    const stemIM = new THREE.InstancedMesh(
      stemGeo,
      Materials.createStandardMaterial({ color: 0x3d7a3d }),
      n * BLOOMS,
    );
    const centreIM = new THREE.InstancedMesh(
      centreGeo,
      Materials.createStandardMaterial({ color: 0xf6d64a }),
      n * BLOOMS,
    );
    const petalIM = new THREE.InstancedMesh(
      petalGeo,
      Materials.createStandardMaterial({ color: 0xffffff }),
      n * BLOOMS * PETALS,
    );
    const dummy = new THREE.Object3D();
    const up = new THREE.Vector3(0, 1, 0);
    const dir = new THREE.Vector3();
    const hue = new THREE.Color();
    const fallbackHue = new THREE.Color(0xf4e04d);
    let placed = 0;
    let bloomI = 0;
    let petalI = 0;
    for (const raw of spots) {
      dir.copy(raw).normalize();
      if (this.isNearStreet(dir)) continue; // never block a pavement
      const a = this.analyticSurface(dir);
      const base = dir.clone().multiplyScalar(a.radius + 0.12);
      dummy.position.copy(base);
      dummy.quaternion.setFromUnitVectors(up, dir); // planters stand plumb
      dummy.rotateY(Math.random() * Math.PI * 2);
      dummy.scale.setScalar(1);
      dummy.updateMatrix();
      boxIM.setMatrixAt(placed, dummy.matrix);
      soilIM.setMatrixAt(
        placed,
        dummy.matrix.clone().multiply(new THREE.Matrix4().makeTranslation(0, 0.16, 0)),
      );
      // District hue for this planter's blooms (falls back to daisy yellow).
      const w = districtAccentAt(dir, hue);
      const bloomHue = w > 0 ? hue.clone() : fallbackHue;
      for (let b = 0; b < BLOOMS; b++) {
        const bx = (Math.random() - 0.5) * 0.6;
        const bz = (Math.random() - 0.5) * 0.14;
        const bloomBase = new THREE.Matrix4()
          .makeTranslation(bx, 0.19, bz)
          .premultiply(dummy.matrix);
        const stemM = bloomBase.clone().multiply(new THREE.Matrix4().makeTranslation(0, 0.14, 0));
        stemIM.setMatrixAt(bloomI, stemM);
        const headM = bloomBase.clone().multiply(new THREE.Matrix4().makeTranslation(0, 0.3, 0));
        centreIM.setMatrixAt(bloomI, headM);
        bloomI++;
        for (let p = 0; p < PETALS; p++) {
          const ang = (p / PETALS) * Math.PI * 2;
          const petalM = headM
            .clone()
            .multiply(
              new THREE.Matrix4().makeTranslation(Math.cos(ang) * 0.07, 0, Math.sin(ang) * 0.07),
            );
          petalIM.setMatrixAt(petalI, petalM);
          petalIM.setColorAt(petalI, bloomHue);
          petalI++;
        }
      }
      placed++;
    }
    boxIM.count = placed;
    soilIM.count = placed;
    stemIM.count = bloomI;
    centreIM.count = bloomI;
    petalIM.count = petalI;
    for (const im of [boxIM, soilIM, stemIM, centreIM, petalIM]) {
      im.instanceMatrix.needsUpdate = true;
      im.raycast = () => {};
      im.computeBoundingSphere();
      parent.add(im);
    }
    if (petalIM.instanceColor) petalIM.instanceColor.needsUpdate = true;
    console.log(`🪴 Building planters: ${placed} beds, ${bloomI} blooms`);
  }

  /**
   * Collapse the street network's ~401 per-segment ribbons into 8 longitude
   * sectors — the single largest draw-call population on the island, and
   * 29% of every frame's draw calls.
   *
   * The per-segment BUILD LOOP is left byte-for-byte alone, because its 401
   * PlaneGeometry + 401 Mesh allocations ARE seeded-RNG currency: removing
   * them would re-roll every later placement and move the index-addressed
   * parked cars. Only the tail is new, and it is wrapped in a local
   * mulberry32 so its own ~64 draws (8 geometries + 8 meshes) cannot leak
   * into the world stream either.
   *
   * EIGHT sectors, not one mesh: frustum culling and the camera's collision
   * list both key off bounding spheres, and a single planet-spanning road
   * mesh would never cull. Sectors keep roughly an octant each.
   *
   * SAFE ONLY BECAUSE the ribbons are already opted out of the camera
   * raycast (see createStreetPath) — merged geometry has no BVH, so
   * `firstHitOnly` would degrade to brute-force triangle tests without it.
   */
  private mergeStreetNetwork(pathGroup: THREE.Group): void {
    const stashedRandom = Math.random;
    let sseed = 0x51ed270b >>> 0;
    Math.random = (): number => {
      sseed = (sseed + 0x6d2b79f5) >>> 0;
      let t = Math.imul(sseed ^ (sseed >>> 15), 1 | sseed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    try {
      const SECTORS = 8;
      const bins: THREE.BufferGeometry[][] = Array.from({ length: SECTORS }, () => []);
      const segments: THREE.Mesh[] = [];
      pathGroup.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh && m.geometry) segments.push(m);
      });
      if (segments.length === 0) return;
      // One material for the whole network (all 10 paths built identical
      // ones), which also collapses EnvironmentCycle's pavement drive from
      // 10 entries to 1.
      const shared = segments[0].material as THREE.MeshStandardMaterial;
      const centre = new THREE.Vector3();
      for (const m of segments) {
        m.updateMatrixWorld(true);
        const g = m.geometry.clone();
        g.applyMatrix4(m.matrixWorld); // bake to world; the merged mesh sits at identity
        g.computeBoundingSphere();
        centre.copy(g.boundingSphere?.center ?? new THREE.Vector3(0, 1, 0));
        const lon = Math.atan2(centre.z, centre.x); // -PI..PI
        const bin = Math.min(
          SECTORS - 1,
          Math.max(0, Math.floor(((lon + Math.PI) / (Math.PI * 2)) * SECTORS)),
        );
        bins[bin].push(g);
      }
      // Drop the originals (their geometries are cloned above; the shared
      // material survives on the merged meshes).
      for (const m of segments) {
        m.geometry.dispose();
        m.removeFromParent();
      }
      for (const mat of new Set(segments.map((m) => m.material as THREE.Material))) {
        if (mat !== shared) mat.dispose();
      }
      let made = 0;
      for (let b = 0; b < SECTORS; b++) {
        if (bins[b].length === 0) continue;
        const merged = mergeGeometries(bins[b], false);
        for (const g of bins[b]) g.dispose();
        if (!merged) continue;
        const mesh = new THREE.Mesh(merged, shared);
        mesh.name = `street_sector_${b}`;
        mesh.receiveShadow = true;
        mesh.raycast = () => {}; // pavement never blocks the chase camera
        mesh.userData.isPavement = true; // keeps the night drive
        pathGroup.add(mesh);
        made++;
      }
      console.log(`🛣️ street network merged: ${segments.length} meshes → ${made} sectors`);
    } finally {
      Math.random = stashedRandom;
    }
  }

  /**
   * Lay a surface-conforming street along a chain of unit-direction
   * waypoints (great-circle-ish polyline). Shares one road material for
   * the whole path and registers each segment in the street keep-out list.
   */
  private createStreetPath(waypoints: THREE.Vector3[], width: number): THREE.Group {
    const group = new THREE.Group();
    group.name = 'street_path';
    // Plain pale paver — no albedo map. The generated road texture is dark
    // asphalt; after toonify (which keeps .map) it multiplied the tint to
    // near-black and the streets vanished at night ("black panels").
    // A faint warm emissive floor keeps pavement readable after dark
    // (moonlit-path look) since toonify carries emissive through.
    const mat = Materials.createTrimMaterial(0xcfc4ae);
    mat.emissive = new THREE.Color(0x2a241c);
    mat.emissiveIntensity = 1;
    // Cross-section detail rides in a vertex COLOUR attribute (kerb bands, and
    // a centre line on the wide roads), so the whole hierarchy costs one
    // material and zero extra draws. A BufferAttribute mints no uuid and
    // PlaneGeometry costs the same 4 Math.random draws at any resolution, so
    // none of this shifts the seeded stream — which is exactly why the road
    // could be detailed without the flag-day re-roll the width rewrite needs.
    mat.vertexColors = true;
    // Keep-out circles must OVERLAP along the road: at R=50 the segment
    // midpoints are 3.3-3.4u apart, so the old (width/2+0.8) radius left
    // ~1u-wide unprotected stretches of centerline where trees/rocks could
    // legally seed mid-pavement. Floor at 1.9u and also register endpoints.
    const keepOutArc = Math.max(width * 0.5 + 0.8, 1.9) / this.radius;
    for (let i = 0; i < waypoints.length - 1; i++) {
      const a = waypoints[i].clone().normalize();
      const b = waypoints[i + 1].clone().normalize();
      const midDir = a.clone().add(b).normalize();
      // sampleSurfaceByDirection (not sampleSurfacePosition): the latter
      // raycasts from the base radius, which starts INSIDE raised terrain
      // and falls back to r=base — burying street segments under hills
      const sampled = this.sampleSurfaceByDirection(midDir, 0.03);
      // Shoreline clamp: never lay pavement below the waterline — a street
      // running downhill into the sea with no terminus reads as a bug. Skip
      // segments whose sampled ground sits at/under calm sea level (+0.05
      // margin over the 0.03 sample offset). Build-time only; the street now
      // ends at the beach. Keep-out registration is skipped too, so shore
      // props can reclaim the strip.
      if (sampled.position.length() < this.seaLevel() + 0.08) continue;
      const posA = a.multiplyScalar(this.radius);
      const posB = b.multiplyScalar(this.radius);
      const segLength = posA.distanceTo(posB);
      // 1.3x overlap: consecutive planes tilt with the terrain, and at 1.12
      // the joins opened visible gaps on bumpy stretches ("panel" look).
      // Length-subdivided at ≤0.9u pitch (under the terrain's 1.083u vertex
      // pitch) so the per-vertex conform below can hug every bump — a rigid
      // 1×1 quad seated at its midpoint buried its ends up to -0.35u and
      // floated them to +0.54u (measured over 20k ribbon samples). Same
      // allocation count as before (one geometry/mesh per segment), so the
      // seeded ambient RNG stream — the vehicle wire protocol — is untouched.
      const planeLen = segLength * 1.3;
      const lenSegs = Math.max(4, Math.ceil(planeLen / 0.9));
      // 6 transverse rows instead of 1: the extra rows are what the kerb and
      // centre-line colour bands are painted onto. Same ONE geometry per
      // segment, so the allocation count — and therefore the seeded stream —
      // is untouched.
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(planeLen, width, lenSegs, 6), mat);
      mesh.position.copy(sampled.position);
      // Orient with an explicit basis so the ribbon lies FLAT. A
      // PlaneGeometry spans local X (length) × local Y (width) and faces
      // local +Z. For a road on the ground we want:
      //   +Z (face)  → surface normal   (so it lies flat, facing up)
      //   +X (length)→ path tangent      (so it runs along the street)
      //   +Y (width) → normal × tangent
      // The earlier setFromUnitVectors(+Y, normal) instead stood the plane
      // up on edge like a fence panel.
      const zAxis = sampled.normal.clone().normalize();
      const along = posB.clone().sub(posA);
      // project the tangent onto the surface tangent plane
      const xAxis = along.sub(zAxis.clone().multiplyScalar(along.dot(zAxis))).normalize();
      const yAxis = new THREE.Vector3().crossVectors(zAxis, xAxis).normalize();
      mesh.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(xAxis, yAxis, zAxis));
      // Conform the ribbon to the terrain: re-seat EVERY vertex radially on
      // the analytic surface. The lift alternates by segment parity so the
      // 1.3x overlap zones sit on two distinct shells instead of z-fighting
      // (once conformed, overlapping planes are exactly parallel).
      {
        const lift = i % 2 === 0 ? 0.04 : 0.055;
        mesh.updateMatrixWorld(true);
        const pos = mesh.geometry.attributes.position as THREE.BufferAttribute;
        const v = new THREE.Vector3();
        const n = new THREE.Vector3();
        for (let vi = 0; vi < pos.count; vi++) {
          v.fromBufferAttribute(pos, vi);
          mesh.localToWorld(v);
          const dirV = v.clone().normalize();
          const r = this.analyticSurfaceInto(dirV, n);
          v.copy(dirV).multiplyScalar(r + lift);
          mesh.worldToLocal(v);
          pos.setXYZ(vi, v.x, v.y, v.z);
        }
        pos.needsUpdate = true;
        mesh.geometry.computeVertexNormals();
        mesh.geometry.computeBoundingSphere();
      }
      // CROSS-SECTION. Paint the transverse rows so a road reads as a road
      // rather than a ribbon: darker kerb bands at the edges, and a pale
      // centre line down the wide roads only (a footpath with a centre line
      // looks like a runway). The band is chosen from the vertex's ORIGINAL
      // transverse coordinate, captured before the conform moved it.
      {
        const geo = mesh.geometry;
        const pos2 = geo.attributes.position as THREE.BufferAttribute;
        const n = pos2.count;
        const col = new Float32Array(n * 3);
        const marked = width >= 1.5; // boulevard-class only
        // PlaneGeometry lays out rows in order, so the transverse band of a
        // vertex is its index within the row grid — read it off the layout
        // rather than the (now conformed) position.
        const cols = lenSegs + 1;
        for (let vi = 0; vi < n; vi++) {
          const row = Math.floor(vi / cols); // 0..6 across the width
          const t = Math.abs(row / 6 - 0.5) * 2; // 0 centre → 1 kerb
          let shade = 0.88; // road body
          if (t > 0.82)
            shade = 0.6; // kerb band
          else if (marked && t < 0.12) shade = 1.0; // centre line
          col[vi * 3] = shade;
          col[vi * 3 + 1] = shade;
          col[vi * 3 + 2] = shade * 0.985; // a hair warm, matches the paver
        }
        geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
      }
      mesh.receiveShadow = true;
      // A ground-hugging ribbon can never block a camera ray, and the chase
      // camera raycasts its collision list EVERY frame. OrbitCamera treats an
      // own-property raycast as an explicit opt-out (grass and the sea use the
      // same trick) — this drops ~401 bounding-sphere tests per frame.
      mesh.raycast = () => {};
      // EnvironmentCycle lifts this material toward moonlit stone at night —
      // the road is what a visitor navigates by after dark.
      mesh.userData.isPavement = true;
      group.add(mesh);
      this.streetDirs.push({ dir: midDir, halfArc: keepOutArc });
      this.streetDirs.push({ dir: a, halfArc: keepOutArc });
      if (i === waypoints.length - 2) this.streetDirs.push({ dir: b, halfArc: keepOutArc });
    }
    this.streetBuckets = null; // new segments registered — rebuild the index lazily
    return group;
  }

  /**
   * The Gardener's walled garden: a picket-fenced plot of raised beds she
   * actually works, instead of ten bare coordinates scattered island-wide.
   *
   * Publishes THREE kneeling spots (one per bed) into `flowerBedSites`, all
   * within ~3u of each other, so `tend_flowers` becomes a short shuffle
   * between beds rather than a lap of the planet. Everything static is merged
   * per material (the tree recipe) to keep this to a handful of draw calls,
   * and the fence posts are one InstancedMesh.
   */
  private buildGarden(lon: number, lat: number, parent: THREE.Object3D): void {
    // claimOffStreet, not a raw dirAt: slides off any pavement AND away from
    // props already claimed (cottages, stalls, lamps), then registers the
    // footprint so nothing later lands on the garden either.
    const centre = this.claimOffStreet(this.dirAt(lon, lat), this.arc(5));
    let seat: { position: THREE.Vector3; normal: THREE.Vector3 };
    try {
      seat = this.sampleSurfaceByDirection(centre, 0);
    } catch {
      return; // unsamplable spot — skip the garden rather than float it
    }
    const g = new THREE.Group();
    g.name = 'garden';
    g.position.copy(seat.position);
    g.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), seat.normal);

    const woodMat = Materials.createStandardMaterial({ color: 0xc9a978 });
    const soilMat = Materials.createStandardMaterial({ color: 0x5b4230 });
    const HALF = 3.2; // garden half-width

    // Picket fence: one post geometry, instanced around the perimeter, with a
    // gap on the plaza side for the gate.
    const postGeo = new THREE.BoxGeometry(0.12, 0.7, 0.12);
    const perimeter: Array<[number, number]> = [];
    const STEP = 0.53;
    for (let x = -HALF; x <= HALF + 1e-6; x += STEP) {
      perimeter.push([x, -HALF]);
      if (x < -0.9 || x > 0.9) perimeter.push([x, HALF]); // gate gap
    }
    for (let z = -HALF + STEP; z <= HALF - STEP + 1e-6; z += STEP) {
      perimeter.push([-HALF, z]);
      perimeter.push([HALF, z]);
    }
    const posts = new THREE.InstancedMesh(postGeo, woodMat, perimeter.length);
    const m = new THREE.Matrix4();
    for (let i = 0; i < perimeter.length; i++) {
      m.makeTranslation(perimeter[i][0], 0.35, perimeter[i][1]);
      posts.setMatrixAt(i, m);
    }
    posts.instanceMatrix.needsUpdate = true;
    posts.castShadow = true;
    g.add(posts);

    // Three raised beds + their soil, merged into two meshes.
    const frames: THREE.BufferGeometry[] = [];
    const soils: THREE.BufferGeometry[] = [];
    const bedX = [-1.9, 0, 1.9];
    for (const bx of bedX) {
      for (const [dx, dz, w, d] of [
        [0, -1.5, 1.5, 0.12],
        [0, 1.5, 1.5, 0.12],
        [-0.75, 0, 0.12, 3.0],
        [0.75, 0, 0.12, 3.0],
      ] as Array<[number, number, number, number]>) {
        frames.push(new THREE.BoxGeometry(w, 0.28, d).translate(bx + dx, 0.14, dz));
      }
      soils.push(new THREE.BoxGeometry(1.4, 0.2, 2.9).translate(bx, 0.16, 0));
    }
    const frameMesh = new THREE.Mesh(mergeGeometries(frames, false), woodMat);
    frameMesh.castShadow = true;
    frameMesh.receiveShadow = true;
    g.add(frameMesh);
    frames.forEach((f) => f.dispose());
    const soilMesh = new THREE.Mesh(mergeGeometries(soils, false), soilMat);
    soilMesh.receiveShadow = true;
    g.add(soilMesh);
    soils.forEach((s) => s.dispose());

    // Proper flowers, not coloured dots: each bloom is a stem, a ring of five
    // petals and a yellow centre — the island's own bloom recipe, but one
    // colour PER BED so the plot reads as planted rather than sprinkled.
    const BED_COLOURS = [0xff69b4, 0xf4e04d, 0xb46bd8];
    const PER_BED = 14;
    const spots: Array<[number, number, number]> = []; // x, z, bed index
    for (let b = 0; b < bedX.length; b++) {
      for (let i = 0; i < PER_BED; i++) {
        spots.push([bedX[b] + (Math.random() - 0.5) * 1.0, (Math.random() - 0.5) * 2.5, b]);
      }
    }
    const stemGeo = new THREE.CylinderGeometry(0.018, 0.022, 0.28, 4);
    const stems = new THREE.InstancedMesh(
      stemGeo,
      Materials.createStandardMaterial({ color: 0x3d7a3d }),
      spots.length,
    );
    const centres = new THREE.InstancedMesh(
      new THREE.SphereGeometry(0.045, 5, 4),
      Materials.createStandardMaterial({ color: 0xf6d64a }),
      spots.length,
    );
    for (let i = 0; i < spots.length; i++) {
      const [x, z] = spots[i];
      m.makeTranslation(x, 0.4, z);
      stems.setMatrixAt(i, m);
      m.makeTranslation(x, 0.56, z);
      centres.setMatrixAt(i, m);
    }
    stems.instanceMatrix.needsUpdate = true;
    centres.instanceMatrix.needsUpdate = true;
    g.add(stems, centres);
    // Petals: one instanced batch per bed colour, five per bloom.
    const petalGeo = new THREE.SphereGeometry(0.055, 5, 4);
    const petalScale = new THREE.Vector3(1.25, 0.55, 1.25);
    for (let b = 0; b < BED_COLOURS.length; b++) {
      const mine = spots.filter((s) => s[2] === b);
      const petals = new THREE.InstancedMesh(
        petalGeo,
        Materials.createStandardMaterial({ color: BED_COLOURS[b] }),
        mine.length * 5,
      );
      let pi = 0;
      for (const [x, z] of mine) {
        for (let k = 0; k < 5; k++) {
          const a = (k / 5) * Math.PI * 2;
          m.compose(
            new THREE.Vector3(x + Math.cos(a) * 0.062, 0.56, z + Math.sin(a) * 0.062),
            new THREE.Quaternion(),
            petalScale,
          );
          petals.setMatrixAt(pi++, m);
        }
      }
      petals.instanceMatrix.needsUpdate = true;
      g.add(petals);
    }

    // A water butt by the gate so the plot reads as worked, not decorative.
    const butt = new THREE.Mesh(
      new THREE.CylinderGeometry(0.34, 0.34, 0.72, 8),
      Materials.createStandardMaterial({ color: 0x6a5238 }),
    );
    butt.position.set(HALF - 0.7, 0.36, HALF - 0.7);
    butt.castShadow = true;
    g.add(butt);

    // NOT this.mesh — the island root does not exist yet during the prop
    // build; the caller passes the same group the blooms go into.
    parent.add(g);
    this.gardenDir = centre.clone();

    // Kneeling spots: the aisle beside each bed, published as the ONLY
    // tend_flowers anchors.
    const up = seat.normal.clone();
    let east = new THREE.Vector3().crossVectors(up, new THREE.Vector3(0, 1, 0));
    if (east.lengthSq() < 1e-6) east = new THREE.Vector3(1, 0, 0);
    east.normalize();
    const north = new THREE.Vector3().crossVectors(east, up).normalize();
    for (const bx of bedX) {
      const spot = seat.position.clone().addScaledVector(east, bx).addScaledVector(north, -1.15);
      try {
        const d = spot.clone().normalize();
        this.flowerBedSites.push(this.sampleSurfaceByDirection(d, 0).position.clone());
      } catch {
        this.flowerBedSites.push(spot);
      }
    }
  }

  /**
   * The Farmer's croft: ploughed furrows of leafy crops, a scarecrow and a
   * hay bale. Publishes three working spots (the furrow ends) as
   * `cropRowSites` — his OWN anchors, so he stops shadowing the Gardener.
   */
  private buildFarm(lon: number, lat: number, parent: THREE.Object3D): void {
    // 0.2 rad of search arc (~10u): the field is 6.4u long, so it needs a
    // wider berth than a cottage-sized prop before it stops shouldering into
    // the neighbours.
    const centreDir = this.claimOffStreet(this.dirAt(lon, lat), this.arc(10));
    let cr: number;
    try {
      cr = this.analyticSurface(centreDir).radius;
    } catch {
      return;
    }

    // The hamlet is a hillside — the terrain rises ~1.1u across this 6.4u
    // footprint and the only flat ground nearby is the coastal shelf, which
    // would drag the farm to the beach. So the field CONFORMS to the slope
    // rather than sitting as a rigid tangent slab (which floated its corners
    // over a metre in the air). Every element is seated on the terrain it
    // stands over via `surfAt`, and the soil is built from short segments that
    // follow the ground with a skirt that reaches below it, so nothing floats.
    const centre = centreDir.clone().multiplyScalar(cr);
    let east = new THREE.Vector3().crossVectors(centreDir, new THREE.Vector3(0, 1, 0));
    if (east.lengthSq() < 1e-6) east = new THREE.Vector3(1, 0, 0);
    east.normalize();
    const north = new THREE.Vector3().crossVectors(east, centreDir).normalize();

    // Field-local (east `e`, north `n`) offset in world units -> the terrain
    // point and its up-normal directly below/above it.
    const surfAt = (e: number, n: number): { pos: THREE.Vector3; up: THREE.Vector3 } => {
      const dir = centre.clone().addScaledVector(east, e).addScaledVector(north, n).normalize();
      const s = this.analyticSurface(dir);
      return { pos: dir.clone().multiplyScalar(s.radius), up: s.normal.clone() };
    };
    // Orientation whose +Y is `up` and +Z runs along field-north (projected
    // onto the local tangent), for seating oriented boxes on the slope.
    const _x = new THREE.Vector3();
    const _z = new THREE.Vector3();
    const _mat = new THREE.Matrix4();
    const basisQuat = (up: THREE.Vector3, out: THREE.Quaternion): THREE.Quaternion => {
      _z.copy(north).addScaledVector(up, -north.dot(up)).normalize();
      _x.crossVectors(up, _z).normalize();
      _mat.makeBasis(_x, up, _z);
      return out.setFromRotationMatrix(_mat);
    };

    const g = new THREE.Group();
    g.name = 'farm';

    const soilMat = Materials.createStandardMaterial({ color: 0x6b4f34 });
    const cropMat = Materials.createStandardMaterial({ color: 0x6f9c3f });
    const woodMat = Materials.createStandardMaterial({ color: 0xb08a55 });

    const ROWS = [-2.4, -0.8, 0.8, 2.4];
    const N0 = -3.2;
    const N1 = 3.2;

    // Ploughed ridges as terrain-following segments. One tall box per step
    // (crown ~0.16 above the soil, skirt ~0.84 below it), overlapped along the
    // furrow so the seams close on a slope. All 4 rows share one InstancedMesh.
    const SEG = 8;
    const step = (N1 - N0) / SEG;
    const ridgeH = 1.0; // 0.16 proud + 0.84 skirt
    const soil = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1.0, ridgeH, step * 1.35),
      soilMat,
      ROWS.length * SEG,
    );
    soil.receiveShadow = true;
    const q = new THREE.Quaternion();
    const one = new THREE.Vector3(1, 1, 1);
    const m = new THREE.Matrix4();
    let si = 0;
    for (const rx of ROWS) {
      for (let k = 0; k < SEG; k++) {
        const n = N0 + (k + 0.5) * step;
        const { pos, up } = surfAt(rx, n);
        basisQuat(up, q);
        // Sink so the crown sits 0.16 above ground and the skirt buries below.
        pos.addScaledVector(up, 0.16 - ridgeH / 2);
        m.compose(pos, q, one);
        soil.setMatrixAt(si++, m);
      }
    }
    soil.instanceMatrix.needsUpdate = true;
    g.add(soil);

    // Crop rows. Each plant is seated on the terrain under its own spot and
    // lifted onto the ridge crown, so the rows drape over the slope with the
    // soil instead of floating off it.
    const PER_ROW = 9;
    const rowSpots = (rx: number) =>
      Array.from({ length: PER_ROW }, (_, k) => [
        rx + (Math.random() - 0.5) * 0.22,
        N0 + 0.5 + k * 0.68,
      ]) as Array<[number, number]>;
    // Seat one instance: place at the crop's terrain spot + `lift` up the local
    // normal, oriented so the plant stands up out of the slope.
    // Growth stages (expansion slice 4): every crop reads at a different
    // point of its life — seedling to full — via PURE index math (no RNG,
    // so the ambient stream stays byte-identical). Young crops sit lower in
    // the soil; the lift eases up with the scale.
    const stageOf = (i: number): number => 0.35 + 0.65 * (((i * 37) % 96) / 95);
    const _stagedScale = new THREE.Vector3();
    const seatCrop = (
      mesh: THREE.InstancedMesh,
      i: number,
      e: number,
      n: number,
      lift: number,
      scale: THREE.Vector3,
    ): void => {
      const { pos, up } = surfAt(e, n);
      q.setFromUnitVectors(new THREE.Vector3(0, 1, 0), up);
      const s = stageOf(i);
      m.compose(
        pos.addScaledVector(up, 0.16 + (lift - 0.16) * s),
        q,
        _stagedScale.copy(scale).multiplyScalar(s),
      );
      mesh.setMatrixAt(i, m);
    };

    // Rows 0 + 2 — cabbages: a squashed globe with a paler heart.
    const cabbageSpots = [...rowSpots(ROWS[0]), ...rowSpots(ROWS[2])];
    const cabbage = new THREE.InstancedMesh(
      new THREE.SphereGeometry(0.26, 6, 5),
      Materials.createStandardMaterial({ color: 0x7fae4b }),
      cabbageSpots.length,
    );
    const heart = new THREE.InstancedMesh(
      new THREE.SphereGeometry(0.15, 5, 4),
      Materials.createStandardMaterial({ color: 0xb9d68a }),
      cabbageSpots.length,
    );
    const sq = new THREE.Vector3(1, 0.72, 1);
    for (let i = 0; i < cabbageSpots.length; i++) {
      const [x, z] = cabbageSpots[i];
      seatCrop(cabbage, i, x, z, 0.28, sq);
      seatCrop(heart, i, x, z, 0.36, sq);
    }
    cabbage.instanceMatrix.needsUpdate = true;
    heart.instanceMatrix.needsUpdate = true;
    cabbage.castShadow = true;
    g.add(cabbage, heart);

    // Row 1 — carrots: orange shoulder just proud of the soil + a leafy tuft.
    const carrotSpots = rowSpots(ROWS[1]);
    const shoulder = new THREE.InstancedMesh(
      new THREE.SphereGeometry(0.1, 5, 4),
      Materials.createStandardMaterial({ color: 0xe2802f }),
      carrotSpots.length,
    );
    const tuft = new THREE.InstancedMesh(
      new THREE.ConeGeometry(0.13, 0.42, 5),
      cropMat,
      carrotSpots.length,
    );
    for (let i = 0; i < carrotSpots.length; i++) {
      const [x, z] = carrotSpots[i];
      seatCrop(shoulder, i, x, z, 0.2, one);
      seatCrop(tuft, i, x, z, 0.42, one);
    }
    shoulder.instanceMatrix.needsUpdate = true;
    tuft.instanceMatrix.needsUpdate = true;
    g.add(shoulder, tuft);

    // Row 3 — beans up canes: a stake with foliage climbing it.
    const beanSpots = rowSpots(ROWS[3]);
    const cane = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(0.025, 0.025, 1.1, 4),
      woodMat,
      beanSpots.length,
    );
    const foliage = new THREE.InstancedMesh(
      new THREE.SphereGeometry(0.19, 5, 4),
      Materials.createStandardMaterial({ color: 0x5f9438 }),
      beanSpots.length,
    );
    for (let i = 0; i < beanSpots.length; i++) {
      const [x, z] = beanSpots[i];
      seatCrop(cane, i, x, z, 0.58, one);
      seatCrop(foliage, i, x, z, 0.68, new THREE.Vector3(1, 1.6, 1));
    }
    cane.instanceMatrix.needsUpdate = true;
    foliage.instanceMatrix.needsUpdate = true;

    // Harvest capture (wave 3): read back BUILT matrices — pure capture,
    // no RNG draws, so the ambient stream stays byte-identical.
    const captureCrop = (
      kind: string,
      yieldKind: 'produce' | 'wheat',
      yieldN: number,
      meshes: THREE.InstancedMesh[],
      count: number,
    ): void => {
      for (let ci = 0; ci < count; ci++) {
        const layers = meshes.map((mm) => {
          const built = new THREE.Matrix4();
          mm.getMatrixAt(ci, built);
          return { mesh: mm, built };
        });
        this.farmHarvest.push({
          kind,
          yieldKind,
          yieldN,
          index: ci,
          layers,
          pos: new THREE.Vector3().setFromMatrixPosition(layers[0].built),
          state: 'ripe',
          regrowStart: 0,
          regrowEnd: 0,
        });
      }
    };
    captureCrop('cabbage', 'produce', 1, [cabbage, heart], cabbageSpots.length);
    captureCrop('carrot', 'produce', 1, [shoulder, tuft], carrotSpots.length);
    // Bean canes stand after picking — only the foliage is harvested.
    captureCrop('bean', 'produce', 1, [foliage], beanSpots.length);
    cane.castShadow = true;
    g.add(cane, foliage);

    // Scarecrow (post + crossbar + straw head) and a hay bale, each seated on
    // the terrain under it and stood up along the local normal.
    const scarecrow = surfAt(0, -3.4);
    basisQuat(scarecrow.up, q);
    const scRoot = new THREE.Group();
    scRoot.position.copy(scarecrow.pos);
    scRoot.quaternion.copy(q);
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.12, 1.7, 0.12), woodMat);
    post.position.y = 0.85;
    const bar = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.1, 0.1), woodMat);
    bar.position.y = 1.25;
    const head = new THREE.Mesh(
      new THREE.SphereGeometry(0.22, 6, 5),
      Materials.createStandardMaterial({ color: 0xd8bb6a }),
    );
    head.position.y = 1.85;
    head.castShadow = true;
    scRoot.add(post, bar, head);
    // ── Dress the scarecrow (SHIELDED): a straw hat, a burlap sack body that
    // flutters, straw-tuft hands, and a stitched face. Local rng so the uuid
    // mints never touch the ambient stream — the post/bar/head above stay on the
    // shared stream, so the golden census (draws/placement) is UNCHANGED. The
    // burlap sways via an onBeforeCompile height-keyed vertex displacement
    // (RNG-neutral, and it works while `flowers` is matrix-frozen — the shader
    // never touches the pinned transform).
    {
      const stashedRandom = Math.random;
      let sseed = 0x5caec204 >>> 0;
      Math.random = () => {
        sseed = (sseed + 0x6d2b79f5) >>> 0;
        let t = Math.imul(sseed ^ (sseed >>> 15), 1 | sseed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
      try {
        const ramp = Materials.toonRamp();
        const strawMat = new THREE.MeshToonMaterial({ color: 0xc9a24a, gradientMap: ramp });
        const threadMat = new THREE.MeshToonMaterial({ color: 0x2e2117, gradientMap: ramp });
        const TORSO_H = 0.86;
        const burlapMat = new THREE.MeshToonMaterial({
          color: 0xb59a5e,
          gradientMap: ramp,
          side: THREE.DoubleSide,
        });
        // Height-keyed flutter: pinned at the crossbar (local y=0), free at the
        // hem (local y=-TORSO_H). Non-instanced, so NO USE_INSTANCING gate.
        burlapMat.onBeforeCompile = (shader) => {
          shader.uniforms.uTime = this.grassTimeUniform;
          shader.vertexShader = shader.vertexShader
            .replace('#include <common>', '#include <common>\nuniform float uTime;')
            .replace(
              '#include <begin_vertex>',
              [
                '#include <begin_vertex>',
                '  float scSway = sin(uTime * 1.5 + 1.3) + 0.35 * sin(uTime * 2.9);',
                `  float scT = clamp(-position.y / ${TORSO_H.toFixed(2)}, 0.0, 1.0);`,
                '  transformed.x += scSway * 0.055 * scT * scT;',
                '  transformed.z += scSway * 0.022 * scT * scT;',
              ].join('\n'),
            );
        };
        // Burlap sack body hung from the crossbar (top at local 0 → hem at -H).
        const torso = new THREE.Mesh(
          new THREE.CylinderGeometry(0.25, 0.31, TORSO_H, 8, 1).translate(0, -TORSO_H / 2, 0),
          burlapMat,
        );
        torso.position.y = 1.24;
        torso.castShadow = true;
        // Straw: a conical hat (crown + brim) on the head + a spiky tuft "hand"
        // poking from each crossbar end — one merged mesh, one draw.
        const straw = new THREE.Mesh(
          mergeGeometries(
            [
              new THREE.ConeGeometry(0.26, 0.3, 8).translate(0, 2.16, 0),
              new THREE.CylinderGeometry(0.4, 0.42, 0.04, 10).translate(0, 2.0, 0),
              new THREE.ConeGeometry(0.1, 0.26, 5).rotateZ(0.5).translate(-0.62, 1.12, 0),
              new THREE.ConeGeometry(0.1, 0.26, 5).rotateZ(-0.5).translate(0.62, 1.12, 0),
            ].map((geo) => geo.toNonIndexed()),
            false,
          ) as THREE.BufferGeometry,
          strawMat,
        );
        straw.castShadow = true;
        // Stitched face on the head's field-facing (+Z) side — two button eyes
        // and a mouth stitch, merged into one dark mesh.
        const face = new THREE.Mesh(
          mergeGeometries(
            [
              new THREE.BoxGeometry(0.05, 0.05, 0.04).translate(-0.08, 1.9, 0.2),
              new THREE.BoxGeometry(0.05, 0.05, 0.04).translate(0.08, 1.9, 0.2),
              new THREE.BoxGeometry(0.16, 0.025, 0.03).translate(0, 1.8, 0.21),
            ].map((geo) => geo.toNonIndexed()),
            false,
          ) as THREE.BufferGeometry,
          threadMat,
        );
        scRoot.add(torso, straw, face);
      } finally {
        Math.random = stashedRandom;
      }
    }
    g.add(scRoot);

    const baleSeat = surfAt(3.6, 2.2);
    basisQuat(baleSeat.up, q);
    const bale = new THREE.Mesh(
      new THREE.CylinderGeometry(0.55, 0.55, 0.9, 8),
      Materials.createStandardMaterial({ color: 0xd9c176 }),
    );
    bale.position.copy(baleSeat.pos).addScaledVector(baleSeat.up, 0.55);
    bale.quaternion
      .copy(q)
      .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2));
    bale.castShadow = true;
    g.add(bale);

    // ── New crop variety (expansion slice 4): pumpkins, sunflowers, wheat ─
    // SHIELDED additions: local rng for the cosmetic jitter + uuid mints, so
    // the ambient stream (which still feeds the boat anchors downstream) is
    // untouched. Everything seats through surfAt like the rest of the farm.
    {
      const stashedRandom = Math.random;
      let seed = 0xfa43c09b >>> 0;
      Math.random = () => {
        seed = (seed + 0x6d2b79f5) >>> 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
      try {
        const noIdx = (geo: THREE.BufferGeometry): THREE.BufferGeometry =>
          geo.index ? geo.toNonIndexed() : geo;
        // Pumpkin patch (6): squashed orange globes + a stub stem, one IM.
        const pumpkinGeo = mergeGeometries(
          [
            noIdx(new THREE.SphereGeometry(0.22, 7, 5)).scale(1, 0.68, 1),
            noIdx(new THREE.CylinderGeometry(0.03, 0.045, 0.09, 5)).translate(0, 0.17, 0),
          ],
          false,
        ) as THREE.BufferGeometry;
        // Bake the two-tone: orange body, green stem (vertex colors).
        {
          const pos = pumpkinGeo.getAttribute('position');
          const cols = new Float32Array(pos.count * 3);
          const body = new THREE.Color(0xe07b2a);
          const stem = new THREE.Color(0x6a8a3a);
          for (let i = 0; i < pos.count; i++) {
            const c = pos.getY(i) > 0.14 ? stem : body;
            cols[i * 3] = c.r;
            cols[i * 3 + 1] = c.g;
            cols[i * 3 + 2] = c.b;
          }
          pumpkinGeo.setAttribute('color', new THREE.BufferAttribute(cols, 3));
        }
        const pumpkins = new THREE.InstancedMesh(
          pumpkinGeo,
          new THREE.MeshToonMaterial({ vertexColors: true, gradientMap: Materials.toonRamp() }),
          6,
        );
        pumpkins.castShadow = true;
        for (let i = 0; i < 6; i++) {
          const e = 3.2 + Math.random() * 1.2;
          const n = -2.6 + Math.random() * 2.0;
          const { pos, up } = surfAt(e, n);
          q.setFromUnitVectors(new THREE.Vector3(0, 1, 0), up);
          const sc = (0.8 + Math.random() * 0.35) * stageOf(i * 17);
          m.compose(pos.addScaledVector(up, 0.15 * sc), q, new THREE.Vector3(sc, sc, sc));
          pumpkins.setMatrixAt(i, m);
        }
        pumpkins.instanceMatrix.needsUpdate = true;
        g.add(pumpkins);
        captureCrop('pumpkin', 'produce', 2, [pumpkins], 6);
        // Sunflower row (7) along the west edge, heads facing field-south.
        const sunGeo = mergeGeometries(
          [
            noIdx(new THREE.CylinderGeometry(0.028, 0.034, 1.15, 5)).translate(0, 0.57, 0),
            noIdx(new THREE.CylinderGeometry(0.14, 0.14, 0.05, 8))
              .rotateX(0.5)
              .translate(0, 1.18, 0.04),
            ...Array.from({ length: 10 }, (_, p) => {
              const ang = (p / 10) * Math.PI * 2;
              return noIdx(new THREE.SphereGeometry(0.05, 5, 4))
                .scale(1.5, 0.4, 0.9)
                .translate(
                  Math.cos(ang) * 0.17,
                  1.18 + Math.sin(0.5) * 0.02,
                  0.05 + Math.sin(ang) * 0.15,
                );
            }),
          ],
          false,
        ) as THREE.BufferGeometry;
        {
          const pos = sunGeo.getAttribute('position');
          const cols = new Float32Array(pos.count * 3);
          const stem = new THREE.Color(0x4a7a34);
          const disc = new THREE.Color(0x5a4326);
          const petal = new THREE.Color(0xf2c435);
          for (let i = 0; i < pos.count; i++) {
            const y = pos.getY(i);
            const rr = Math.hypot(pos.getX(i), pos.getZ(i) - 0.05);
            const c = y < 1.05 ? stem : rr < 0.15 ? disc : petal;
            cols[i * 3] = c.r;
            cols[i * 3 + 1] = c.g;
            cols[i * 3 + 2] = c.b;
          }
          sunGeo.setAttribute('color', new THREE.BufferAttribute(cols, 3));
        }
        // Heavy-headed nod on the shared grass clock — same idiom as the wheat
        // below, but height-keyed to the sunflower's own ~1.2u stalk so the disc
        // head sways and the base stays planted. Zero new per-frame uniforms;
        // injecting into the (already-allocated, shielded) material is census-safe.
        const sunMat = new THREE.MeshToonMaterial({
          vertexColors: true,
          gradientMap: Materials.toonRamp(),
        });
        sunMat.onBeforeCompile = (shader) => {
          shader.uniforms.uTime = this.grassTimeUniform;
          shader.vertexShader = shader.vertexShader
            .replace('#include <common>', '#include <common>\nuniform float uTime;')
            .replace(
              '#include <begin_vertex>',
              [
                '#include <begin_vertex>',
                '#ifdef USE_INSTANCING',
                '  float sfPhase = instanceMatrix[3].x * 1.6 + instanceMatrix[3].z * 2.2;',
                '  float sfSway = sin(uTime * 1.25 + sfPhase) + 0.35 * sin(uTime * 2.3 + sfPhase * 1.4);',
                '  float sfT = clamp(position.y / 1.2, 0.0, 1.0);',
                '  transformed.x += sfSway * 0.055 * sfT * sfT;',
                '  transformed.z += sfSway * 0.022 * sfT * sfT;',
                '#endif',
              ].join('\n'),
            );
        };
        const sunflowers = new THREE.InstancedMesh(sunGeo, sunMat, 7);
        sunflowers.castShadow = true;
        for (let i = 0; i < 7; i++) {
          const { pos, up } = surfAt(-3.1, -2.8 + i * 0.93);
          basisQuat(up, q); // +Z field-north; heads authored leaning +Z-ish
          const sc = 0.85 + Math.random() * 0.25;
          m.compose(pos, q, new THREE.Vector3(sc, sc, sc));
          sunflowers.setMatrixAt(i, m);
        }
        sunflowers.instanceMatrix.needsUpdate = true;
        g.add(sunflowers);
        // Wheat (24 clumps in 2 rows) — golden tufts swaying on the shared
        // grass clock (zero new per-frame uniform writes).
        const wheatPos: number[] = [];
        const wheatCol: number[] = [];
        const wBase = new THREE.Color(0xb99a4e);
        const wTip = new THREE.Color(0xe8d38a);
        const wc = new THREE.Color();
        const WHEAT_H = 0.55;
        for (let b = 0; b < 7; b++) {
          const ang = (b / 7) * Math.PI * 2 + Math.random() * 0.8;
          const ring = b === 0 ? 0 : 0.04 + Math.random() * 0.1;
          const ox = Math.cos(ang) * ring;
          const oz = Math.sin(ang) * ring;
          const h = (b === 0 ? 1 : 0.6 + Math.random() * 0.35) * WHEAT_H;
          const w0 = 0.05;
          const yaw = Math.random() * Math.PI * 2;
          const c = Math.cos(yaw);
          const s2 = Math.sin(yaw);
          const v = (x: number, y: number): void => {
            wheatPos.push(x * c + ox, y, x * s2 + oz);
            wc.copy(wBase).lerp(wTip, y / WHEAT_H);
            wheatCol.push(wc.r, wc.g, wc.b);
          };
          v(-w0, 0);
          v(w0, 0);
          v(w0 * 0.5, h);
          v(-w0, 0);
          v(w0 * 0.5, h);
          v(-w0 * 0.5, h);
        }
        const wheatGeo = new THREE.BufferGeometry();
        wheatGeo.setAttribute('position', new THREE.Float32BufferAttribute(wheatPos, 3));
        wheatGeo.setAttribute('color', new THREE.Float32BufferAttribute(wheatCol, 3));
        wheatGeo.computeVertexNormals();
        const wheatMat = new THREE.MeshToonMaterial({
          vertexColors: true,
          side: THREE.DoubleSide,
          gradientMap: Materials.toonRamp(),
        });
        wheatMat.onBeforeCompile = (shader) => {
          shader.uniforms.uTime = this.grassTimeUniform;
          shader.vertexShader = shader.vertexShader
            .replace('#include <common>', '#include <common>\nuniform float uTime;')
            .replace(
              '#include <begin_vertex>',
              [
                '#include <begin_vertex>',
                '#ifdef USE_INSTANCING',
                '  float wPhase = instanceMatrix[3].x * 1.7 + instanceMatrix[3].z * 2.3;',
                '  float wSway = sin(uTime * 1.9 + wPhase) + 0.4 * sin(uTime * 3.1 + wPhase * 1.3);',
                `  float wT = position.y / ${WHEAT_H.toFixed(2)};`,
                '  transformed.x += wSway * 0.06 * wT * wT;',
                '#endif',
              ].join('\n'),
            );
        };
        const wheat = new THREE.InstancedMesh(wheatGeo, wheatMat, 24);
        for (let i = 0; i < 24; i++) {
          const e = i < 12 ? 3.3 : 3.9;
          const n = 0.2 + (i % 12) * 0.245;
          const { pos, up } = surfAt(e, n);
          q.setFromUnitVectors(new THREE.Vector3(0, 1, 0), up);
          const sc = 0.85 + Math.random() * 0.3;
          m.compose(pos, q, new THREE.Vector3(sc, sc, sc));
          wheat.setMatrixAt(i, m);
        }
        wheat.instanceMatrix.needsUpdate = true;
        wheat.raycast = () => {};
        g.add(wheat);
        captureCrop('wheat', 'wheat', 1, [wheat], 24);
      } finally {
        Math.random = stashedRandom;
      }
    }

    parent.add(g);
    this.farmDir = centreDir.clone();

    // Working spots: the near end of three furrows, ~1.6u apart, on the ground.
    for (const rx of [-1.6, 0, 1.6]) {
      this.cropRowSites.push(surfAt(rx, 1.9).pos);
    }
  }

  /**
   * The Musician's bandstand: an octagonal deck with posts and a conical
   * roof, on the welcome-plaza apron. Publishes two standing spots so
   * `play_music` has a stage of its own instead of rotating the district
   * plazas (which are the zone halls).
   */
  private buildBandstand(lon: number, lat: number, parent: THREE.Object3D): void {
    const centre = this.claimOffStreet(this.dirAt(lon, lat), this.arc(4.5));
    let seat: { position: THREE.Vector3; normal: THREE.Vector3 };
    try {
      seat = this.sampleSurfaceByDirection(centre, 0);
    } catch {
      return;
    }
    const g = new THREE.Group();
    g.name = 'bandstand';
    g.position.copy(seat.position);
    g.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), seat.normal);

    const deckMat = Materials.createStandardMaterial({ color: 0xd8c39a });
    const trimMat = Materials.createStandardMaterial({ color: 0x9c6b46 });
    const deck = new THREE.Mesh(new THREE.CylinderGeometry(2.5, 2.7, 0.35, 8), deckMat);
    deck.position.y = 0.18;
    deck.receiveShadow = true;
    g.add(deck);
    const postGeo = new THREE.CylinderGeometry(0.1, 0.1, 2.3, 6);
    const posts = new THREE.InstancedMesh(postGeo, trimMat, 6);
    const m = new THREE.Matrix4();
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      m.makeTranslation(Math.cos(a) * 2.15, 1.5, Math.sin(a) * 2.15);
      posts.setMatrixAt(i, m);
    }
    posts.instanceMatrix.needsUpdate = true;
    posts.castShadow = true;
    g.add(posts);
    const roof = new THREE.Mesh(new THREE.ConeGeometry(2.9, 1.1, 8), trimMat);
    roof.position.y = 3.2;
    roof.castShadow = true;
    g.add(roof);
    // A stool, so the stage reads as a working spot rather than a gazebo.
    const stool = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.24, 0.45, 6), trimMat);
    stool.position.set(0.9, 0.58, 0.5);
    g.add(stool);

    parent.add(g);
    this.bandstandSites.push(seat.position.clone());
    const up = seat.normal.clone();
    let east = new THREE.Vector3().crossVectors(up, new THREE.Vector3(0, 1, 0));
    if (east.lengthSq() < 1e-6) east = new THREE.Vector3(1, 0, 0);
    east.normalize();
    this.bandstandSites.push(seat.position.clone().addScaledVector(east, 1.2));
  }

  /**
   * The Artist's painting spot: an easel, canvas and stool on the headland.
   * Publishes one standing anchor so `paint_vista` parks her AT the easel.
   */
  private buildEasel(lon: number, lat: number, parent: THREE.Object3D): void {
    const centre = this.claimOffStreet(this.dirAt(lon, lat), this.arc(3));
    let seat: { position: THREE.Vector3; normal: THREE.Vector3 };
    try {
      seat = this.sampleSurfaceByDirection(centre, 0);
    } catch {
      return;
    }
    const g = new THREE.Group();
    g.name = 'easel';
    g.position.copy(seat.position);
    g.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), seat.normal);

    const woodMat = Materials.createStandardMaterial({ color: 0xb2854f });
    const legs: THREE.BufferGeometry[] = [];
    for (const [lx, lz] of [
      [-0.35, 0.2],
      [0.35, 0.2],
      [0, -0.35],
    ] as Array<[number, number]>) {
      legs.push(new THREE.BoxGeometry(0.07, 1.5, 0.07).translate(lx, 0.75, lz));
    }
    legs.push(new THREE.BoxGeometry(0.85, 0.07, 0.07).translate(0, 0.85, 0.2));
    const frame = new THREE.Mesh(mergeGeometries(legs, false), woodMat);
    frame.castShadow = true;
    g.add(frame);
    legs.forEach((l) => l.dispose());
    const canvas = new THREE.Mesh(
      new THREE.BoxGeometry(0.95, 0.75, 0.05),
      Materials.createStandardMaterial({ color: 0xf3ece0 }),
    );
    canvas.position.set(0, 1.32, 0.16);
    canvas.rotation.x = -0.12;
    canvas.castShadow = true;
    g.add(canvas);
    const stool = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.42, 6), woodMat);
    stool.position.set(0.75, 0.21, 0.8);
    g.add(stool);

    parent.add(g);
    const up = seat.normal.clone();
    let east = new THREE.Vector3().crossVectors(up, new THREE.Vector3(0, 1, 0));
    if (east.lengthSq() < 1e-6) east = new THREE.Vector3(1, 0, 0);
    east.normalize();
    const north = new THREE.Vector3().crossVectors(east, up).normalize();
    // Stand BEHIND the canvas, facing it (and the sea beyond).
    this.easelSites.push(seat.position.clone().addScaledVector(north, -1.0));
  }

  /**
   * Seat a small prop cluster on the surface near a persona's spawn.
   *
   * `claimOffStreet` slides it off pavement and away from anything already
   * claimed, so a station can never land on another asset. Deliberately does
   * NOT register a collider: these sit right where their owner works, and a
   * solid footprint there would be an anchor-inside-a-wall — the exact bug
   * that had five townsfolk grinding buildings.
   */
  private stationAt(
    lon: number,
    lat: number,
    arc: number,
    name: string,
    parent: THREE.Object3D,
    build: (g: THREE.Group) => void,
    maxDrift = -1,
  ): void {
    if (maxDrift < 0) maxDrift = this.arc(6);
    const dir = this.claimClearSpot(this.dirAt(lon, lat), arc, maxDrift);
    let seat: { position: THREE.Vector3; normal: THREE.Vector3 };
    try {
      seat = this.sampleSurfaceByDirection(dir, 0);
    } catch {
      return; // unsamplable — skip rather than float a prop
    }
    const g = new THREE.Group();
    g.name = name;
    g.position.copy(seat.position);
    // WORLD LAW 1: stations stand PLUMB (radial), never on the slope normal —
    // the watch post measured 12.3 deg of rake before this. BOTH calls take
    // the same axis: faceObjectToward premultiplies about the axis you hand
    // it, so passing the slope normal here would re-tilt the plumb seat.
    // (The amenity seater ~5930 already does exactly this.)
    const plumb = seat.position.clone().normalize();
    g.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), plumb);
    // Face the nearest street where there is one, so desks and carts address
    // the road like the houses do.
    const street = this.nearestStreetDir(dir, this.arc(25));
    if (street) this.faceObjectToward(g, plumb, street.multiplyScalar(this.radius));
    build(g);
    parent.add(g);
  }

  /** Workplaces for the townsfolk who had none, each at its owner's spawn. */
  private buildTownStations(sites: Array<[number, number]>, parent: THREE.Object3D): void {
    const wood = Materials.createStandardMaterial({ color: 0xb08a55 });
    const darkWood = Materials.createStandardMaterial({ color: 0x7a5738 });
    // Warm greys. A blue-grey stone reads as WATER against this sky.
    const stone = Materials.createStandardMaterial({ color: 0xa8a294 });
    const earth = Materials.createStandardMaterial({ color: 0xb09a72 });
    const paper = Materials.createStandardMaterial({ color: 0xf1e7d0 });
    const cloth = Materials.createStandardMaterial({ color: 0xc0553f });
    // No metalness: there is no environment map in this scene, so a metallic
    // specular lobe has nothing to reflect and just soaks up the hemisphere
    // light's blue sky term — steel ends up looking painted blue.
    const metal = Materials.createStandardMaterial({ color: 0x847f78 });
    const box = (
      g: THREE.Group,
      w: number,
      h: number,
      d: number,
      x: number,
      y: number,
      z: number,
      mat: THREE.Material,
      rot = 0,
    ) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
      m.position.set(x, y, z);
      m.rotation.x = rot;
      m.castShadow = true;
      g.add(m);
      return m;
    };
    // A four-legged table top — the shared base of every desk here.
    const table = (g: THREE.Group, w: number, d: number, mat: THREE.Material) => {
      box(g, w, 0.08, d, 0, 0.75, 0, mat);
      for (const [lx, lz] of [
        [-w / 2 + 0.1, -d / 2 + 0.1],
        [w / 2 - 0.1, -d / 2 + 0.1],
        [-w / 2 + 0.1, d / 2 - 0.1],
        [w / 2 - 0.1, d / 2 - 0.1],
      ] as Array<[number, number]>) {
        box(g, 0.08, 0.72, 0.08, lx, 0.36, lz, mat);
      }
    };
    // A glowing brazier — the guard's and the night watch's warmth.
    const brazier = (g: THREE.Group, x: number, z: number) => {
      const bowl = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.22, 0.3, 8), metal);
      bowl.position.set(x, 0.62, z);
      bowl.castShadow = true;
      g.add(bowl);
      for (const a of [0, 2.1, 4.2]) {
        box(g, 0.06, 0.55, 0.06, x + Math.cos(a) * 0.2, 0.28, z + Math.sin(a) * 0.2, metal);
      }
      const fire = new THREE.Mesh(
        new THREE.ConeGeometry(0.2, 0.36, 6),
        new THREE.MeshBasicMaterial({ color: 0xffa63a, transparent: true, opacity: 0.85 }),
      );
      fire.position.set(x, 0.86, z);
      fire.name = 'brazier_fire';
      g.add(fire);
    };

    // ---- SHELTER KIT ----------------------------------------------------
    // A desk standing in bare grass reads as dropped furniture, not a
    // workplace. Three pieces fix that, all built to the island's own
    // measured vernacular: a ground pad to say "this plot is claimed", posts
    // at the canonical 0.06 radius, and one of the two roof forms that
    // already exist here (raked cloth awning, or yawed 4-sided pyramid).
    const CANOPY_Y = 2.45; // underside clears the 1.8u player everywhere
    const RAKE = 0.22; // gentle: a steeper panel drops its front edge onto heads

    /**
     * Opt a shelter part out of the chase camera's collision ray.
     *
     * OrbitCamera raycasts the whole island group and pulls in to 0.9x the
     * first hit, so a 0.12u post crossing the view ray yanks the camera to
     * its 2.0u minimum for no visual benefit — the post occludes nothing.
     *
     * Deliberately NOT applied to the roof panels. Opting a large roof out
     * lets the camera settle ABOVE it, putting the awning between the lens
     * and the player: trading a jerk for losing sight of your character. Big
     * surfaces should keep pulling the camera in, exactly as every cottage
     * and market stall on this island already does.
     *
     * (There is an `ignoreOcclusion` userData flag set in seven places for
     * this intent — but nothing has ever read it, so it does nothing.)
     */
    const noCameraBlock = (m: THREE.Object3D) => {
      m.raycast = () => {};
    };

    /** Trodden ground under a workplace. Centred on the CLUSTER, not the origin. */
    const pad = (
      g: THREE.Group,
      cx: number,
      cz: number,
      w: number,
      d: number,
      mat: THREE.Material,
    ) => {
      // A pad is seated only at the group origin, but the terrain moves ~0.25u
      // across a 4u slab — a thin one either shows daylight under the low
      // corner or gets swallowed at the high one. 0.4 thick, top standing
      // 0.1 proud, reads as a laid plinth and survives both. Depth is free;
      // the top face is all anyone sees.
      const p = new THREE.Mesh(new THREE.BoxGeometry(w, 0.7, d), mat);
      p.position.set(cx, -0.25, cz);
      p.receiveShadow = true;
      g.add(p);
    };

    /**
     * A post whose foot is buried 0.4u.
     *
     * Props are seated ONLY at their group origin, but the terrain CURVES: a
     * post 2u out sits on ground that has already fallen away, so a post cut
     * off at y=0 hangs in the air. Burying the foot is cheaper and more robust
     * than raycasting each one. (Curvature-derived, so a BIGGER planet is
     * strictly safer — the drop over 2u falls from 0.027u at R=50 to 0.018u
     * at R=75.)
     */
    const post = (g: THREE.Group, x: number, z: number, top: number, mat: THREE.Material) => {
      const h = top + 0.4;
      const m = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, h, 6), mat);
      m.position.set(x, h / 2 - 0.4, z);
      m.castShadow = true;
      noCameraBlock(m);
      g.add(m);
    };

    /**
     * Striped cloth awning on four posts — the market-stall idiom.
     * Panels rake DOWN toward +Z because +Z is the street side on a station
     * (the shops rake toward -Z; the rule is "front edge low", not a sign).
     */
    const canopy = (
      g: THREE.Group,
      cx: number,
      cz: number,
      w: number,
      d: number,
      accent: THREE.Material,
    ) => {
      // RAKE THE STRUCTURE, NOT JUST THE CLOTH. The panels pivot about the
      // canopy centre, so a level beam floats ~0.37u under the raised back
      // edge and PUNCHES THROUGH the dropped front one. Beams and posts have
      // to follow the same plane the cloth lies in — which is also why the
      // back of a raked awning is legitimately taller, exactly as leanTo does.
      const T = Math.tan(RAKE);
      const clothY = (pz: number) => CANOPY_Y - (pz - cz) * T;
      const zBack = cz - d / 2 + 0.12;
      const zFront = cz + d / 2 - 0.12;
      for (const px of [cx - w / 2 + 0.12, cx + w / 2 - 0.12]) {
        for (const pz of [zBack, zFront]) {
          post(g, px, pz, clothY(pz) - 0.13, darkWood);
        }
      }
      for (const pz of [zBack, zFront]) {
        const beam = new THREE.Mesh(new THREE.BoxGeometry(w, 0.09, 0.09), darkWood);
        beam.position.set(cx, clothY(pz) - 0.085, pz);
        beam.castShadow = true;
        noCameraBlock(beam);
        g.add(beam);
      }
      // ODD panel count, always: `i % 2` only stripes symmetrically when the
      // first and last panel share a colour.
      let n = Math.max(3, Math.round(w / 0.52));
      if (n % 2 === 0) n += 1;
      const pw = w / n;
      for (let i = 0; i < n; i++) {
        const panel = new THREE.Mesh(
          new THREE.BoxGeometry(pw, 0.05, d + 0.3),
          i % 2 ? paper : accent,
        );
        panel.position.set(cx - w / 2 + pw * (i + 0.5), CANOPY_Y, cz);
        panel.rotation.x = RAKE;
        panel.castShadow = true;
        g.add(panel);
      }
    };

    /**
     * Lean-to: a single sloping roof off two posts, for the clusters that
     * only need their WORK SURFACE covered — a telescope under a roof is
     * useless, and a brazier under one is a fire.
     */
    const leanTo = (
      g: THREE.Group,
      cx: number,
      cz: number,
      w: number,
      d: number,
      accent: THREE.Material,
    ) => {
      const back = cz - d / 2;
      const front = cz + d / 2;
      for (const px of [cx - w / 2 + 0.1, cx + w / 2 - 0.1]) {
        post(g, px, back, 2.6, darkWood);
        post(g, px, front, 2.25, darkWood);
      }
      const slope = Math.atan2(2.6 - 2.25, d);
      const roof = new THREE.Mesh(
        new THREE.BoxGeometry(w + 0.3, 0.07, Math.hypot(d, 0.35) + 0.25),
        accent,
      );
      roof.position.set(cx, 2.43, cz);
      roof.rotation.x = slope;
      roof.castShadow = true;
      g.add(roof);
      // Rafters, so the roof plainly rests on the posts.
      for (const px of [cx - w / 2 + 0.1, cx + w / 2 - 0.1]) {
        const r = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.07, Math.hypot(d, 0.35)), darkWood);
        r.position.set(px, 2.38, cz);
        r.rotation.x = slope;
        noCameraBlock(r);
        g.add(r);
      }
    };

    const at = (
      i: number,
      name: string,
      arc: number,
      build: (g: THREE.Group) => void,
      drift?: number,
    ) => {
      const s = sites[i];
      if (!s) return;
      this.stationAt(s[0], s[1], arc, name, parent, build, drift);
    };

    // 0 ELDER SAGE — a story circle the Storyteller and Philosopher share.
    at(0, 'story_circle', this.arc(4.5), (g) => {
      // Packed-earth clearing, trodden flat by a generation of listeners.
      // r 2.55, not 1.5: the four seating logs sit out at r 1.35-2.45, so a
      // 1.5 ring left every seat standing off the clearing in the grass.
      const ring = new THREE.Mesh(new THREE.CylinderGeometry(2.55, 2.68, 0.5, 14), earth);
      ring.position.y = -0.2;
      ring.receiveShadow = true;
      g.add(ring);
      // A kerb of individual stones round the fire, each a little different.
      for (let k = 0; k < 9; k++) {
        const a = (k / 9) * Math.PI * 2;
        const s = 0.16 + (k % 3) * 0.04;
        const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(s, 0), stone);
        rock.position.set(Math.cos(a) * 0.62, 0.09, Math.sin(a) * 0.62);
        rock.rotation.set(a, a * 1.7, 0);
        rock.castShadow = true;
        g.add(rock);
      }
      brazier(g, 0, 0);
      for (const a of [0.4, 1.9, 3.4, 4.9]) {
        const log = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 1.1, 7), darkWood);
        log.position.set(Math.cos(a) * 1.9, 0.22, Math.sin(a) * 1.9);
        log.rotation.z = Math.PI / 2;
        log.rotation.y = -a;
        log.castShadow = true;
        g.add(log);
      }
    });

    // 3 YOUNG STUDENT — a study desk with a stack of books.
    at(3, 'study_desk', this.arc(3), (g) => {
      pad(g, 0, 0.3, 2.5, 2.7, stone);
      canopy(g, 0, 0.3, 2.3, 2.4, Materials.createStandardMaterial({ color: 0x4478a8 }));
      table(g, 1.3, 0.7, wood);
      // Stack of books, spines out and slightly askew as a real stack is.
      const covers = [cloth, paper, darkWood];
      for (let k = 0; k < 3; k++) {
        const bk = box(g, 0.34, 0.07, 0.26, -0.34, 0.83 + k * 0.075, 0, covers[k]);
        bk.rotation.y = (k - 1) * 0.12;
      }
      // An OPEN book: two leaves tented over a spine.
      const spine = box(g, 0.06, 0.04, 0.3, 0.26, 0.82, 0, darkWood);
      spine.rotation.y = -0.18;
      for (const s of [-1, 1]) {
        const leaf = box(g, 0.26, 0.02, 0.3, 0.26 + s * 0.15, 0.845, 0, paper);
        leaf.rotation.set(0, -0.18, s * 0.14);
      }
      // Inkpot and quill.
      const pot = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.065, 0.1, 7), metal);
      pot.position.set(0.56, 0.84, -0.2);
      g.add(pot);
      const quill = box(g, 0.02, 0.3, 0.02, 0.56, 1.0, -0.2, paper);
      quill.rotation.z = 0.3;
      const stool = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.45, 6), darkWood);
      stool.position.set(0, 0.22, 0.75);
      stool.castShadow = true;
      g.add(stool);
    });

    // 8 GUARD — a sentry box and a brazier at his post.
    at(
      8,
      'guard_post',
      this.arc(4),
      (g) => {
        // Already roofed; it just needs the ground under it to look claimed.
        pad(g, 0.13, 0, 3.8, 2.0, stone);
        // Built from PANELS with the front left open, so it reads as a shelter
        // you could stand in rather than a solid crate.
        box(g, 1.0, 0.1, 0.9, 0, 0.05, 0, darkWood); // floor
        box(g, 1.0, 1.9, 0.08, 0, 0.95, -0.41, wood); // back
        box(g, 0.08, 1.9, 0.82, -0.46, 0.95, 0, wood); // left side
        box(g, 0.08, 1.9, 0.82, 0.46, 0.95, 0, wood); // right side
        box(g, 1.0, 0.3, 0.08, 0, 1.8, 0.41, wood); // lintel over the doorway
        const roof = new THREE.Mesh(new THREE.ConeGeometry(0.95, 0.5, 4), cloth);
        roof.position.y = 2.15;
        roof.rotation.y = Math.PI / 4;
        roof.castShadow = true;
        g.add(roof);
        brazier(g, 1.5, 0.3);
        // Weapon rack: two uprights, a crossbar, and spears — wooden shafts
        // under steel heads, not solid metal poles.
        box(g, 0.07, 1.0, 0.07, -1.5, 0.5, -0.3, darkWood);
        box(g, 0.07, 1.0, 0.07, -1.5, 0.5, 0.5, darkWood);
        box(g, 0.07, 0.07, 0.9, -1.5, 0.95, 0.1, darkWood);
        for (const sz of [-0.15, 0.1, 0.35]) {
          box(g, 0.045, 1.4, 0.045, -1.42, 0.7, sz, darkWood, 0.12);
          const head = new THREE.Mesh(new THREE.ConeGeometry(0.055, 0.22, 5), metal);
          head.position.set(-1.42, 1.42, sz + 0.17);
          head.rotation.x = 0.12;
          g.add(head);
        }
      },
      // EXACT placement on the three hall-tucked stations. Any drift at all
      // walks them back off the wall their site was just moved to, because the
      // district pre-claims a 6.5u disc round its hall — so every ring near
      // the wall reads as "occupied" and the search shoves the station out.
      0,
    );

    // 12 ARCHITECT — a drafting table with rolled plans.
    at(
      12,
      'drafting_table',
      this.arc(3),
      (g) => {
        pad(g, -0.2, 0.3, 3.1, 2.7, stone);
        canopy(g, -0.2, 0.3, 2.9, 2.5, Materials.createStandardMaterial({ color: 0xc47a2e }));
        table(g, 1.5, 0.9, wood);
        // A drafting board must be visibly RAKED — laid near-flat it just reads
        // as a tablecloth. Front edge rests on the table, back edge propped up.
        // +0.5 raises the FAR edge, so the drawing surface faces the street and
        // the stool — raked the other way the architect would be reading the back
        // of his own board.
        const RAKE = 0.5;
        const board = box(g, 1.35, 0.05, 0.8, 0, 0.95, 0, darkWood);
        board.rotation.x = RAKE;
        const sheet = box(g, 1.15, 0.02, 0.65, 0, 0.985, 0, paper);
        sheet.rotation.x = RAKE;
        // Blue plan lines lying ON the raked plane. A point `d` along the board
        // from its centre lands at (z = d·cos, y = −d·sin) once rotated, so the
        // offsets have to be resolved in the rotated frame, not stacked flat.
        const ink = Materials.createStandardMaterial({ color: 0x5b8fb0 });
        for (const [sx, sw, d] of [
          [-0.3, 0.4, -0.12],
          [0.05, 0.55, 0.06],
          [0.3, 0.25, 0.2],
        ] as Array<[number, number, number]>) {
          const line = box(g, sw, 0.015, 0.03, sx, 0, 0, ink);
          line.rotation.x = RAKE;
          line.position.z = d * Math.cos(RAKE);
          line.position.y = 0.995 - d * Math.sin(RAKE);
        }
        box(g, 0.09, 0.28, 0.09, 0, 0.93, -0.36, darkWood); // prop under the raised edge
        // Rolled plans stood in a pail beside the table, where they read.
        const pail = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.14, 0.4, 8), metal);
        pail.position.set(-0.95, 0.2, 0.25);
        pail.castShadow = true;
        g.add(pail);
        for (const [rx, rz, tilt] of [
          [-0.99, 0.2, 0.12],
          [-0.9, 0.3, -0.14],
          [-0.97, 0.31, 0.05],
        ] as Array<[number, number, number]>) {
          const roll = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.75, 6), paper);
          roll.position.set(rx, 0.55, rz);
          roll.rotation.z = tilt;
          roll.castShadow = true;
          g.add(roll);
        }
        const stool = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.5, 6), darkWood);
        stool.position.set(0, 0.25, 0.85);
        stool.castShadow = true;
        g.add(stool);
      },
      0, // exact: tucked against the Professional/Welcome hall
    );

    // 14 LIGHTHOUSE KEEPER — the keeper's yard at the foot of his tower.
    // Short leash (0.05 rad ~ 2.5u): the tower he keeps stands at dirAt(5.4,
    // 0.34) and his spawn is just off its plinth, so a yard allowed to drift
    // the usual 6u stops reading as belonging to the lighthouse at all.
    // NOTE the lighthouse is built AFTER this (createLighthouse, ~line 3200),
    // so its footprint is NOT yet claimed — the leash is what keeps the yard
    // beside the tower, and the arc is what keeps it off the plinth.
    at(
      14,
      'keeper_yard',
      this.arc(3.5),
      (g) => {
        pad(g, 0.7, 0, 3.6, 1.9, stone);
        // Lean-to over the BENCH only — a telescope under a roof is useless.
        leanTo(g, 0, 0, 1.8, 1.3, Materials.createStandardMaterial({ color: 0xd44e3c }));
        table(g, 1.2, 0.7, darkWood);
        // Oil cans on the bench
        for (const cx of [-0.3, 0, 0.3]) {
          const can = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.26, 7), metal);
          can.position.set(cx, 0.92, 0);
          g.add(can);
        }
        // Brass telescope on a SPLAYED tripod, tipped seaward. Struts are placed
        // apex-to-foot via setFromUnitVectors rather than stacked Euler angles —
        // the length is the true distance, so nothing floats or overshoots.
        const up = new THREE.Vector3(0, 1, 0);
        const apex = new THREE.Vector3(1.5, 1.05, 0);
        for (const a of [0, 2.094, 4.189]) {
          const foot = new THREE.Vector3(1.5 + Math.cos(a) * 0.36, 0, Math.sin(a) * 0.36);
          const span = apex.distanceTo(foot);
          const leg = new THREE.Mesh(new THREE.BoxGeometry(0.05, span, 0.05), darkWood);
          leg.position.copy(apex).add(foot).multiplyScalar(0.5);
          leg.quaternion.setFromUnitVectors(up, apex.clone().sub(foot).normalize());
          leg.castShadow = true;
          g.add(leg);
        }
        box(g, 0.11, 0.16, 0.11, apex.x, apex.y + 0.06, apex.z, metal); // yoke
        const brass = Materials.createStandardMaterial({ color: 0xc9a227 });
        const aim = new THREE.Vector3(0.9, 0.36, 0.22).normalize();
        const scope = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.085, 0.95, 8), brass);
        scope.position.copy(apex).setY(apex.y + 0.16);
        scope.quaternion.setFromUnitVectors(up, aim);
        scope.castShadow = true;
        g.add(scope);
        const eyepiece = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.16, 7), metal);
        eyepiece.position.copy(scope.position).addScaledVector(aim, -0.53);
        eyepiece.quaternion.copy(scope.quaternion);
        g.add(eyepiece);
      },
      0.05,
    );

    // 16 CARTOGRAPHER — a map table with a globe.
    at(16, 'map_table', this.arc(3), (g) => {
      pad(g, 0.03, 0, 2.9, 2.3, stone);
      canopy(g, 0.03, 0, 2.7, 2.1, Materials.createStandardMaterial({ color: 0x3e8e6d }));
      table(g, 1.6, 1.0, wood);
      box(g, 1.45, 0.03, 0.9, 0, 0.81, 0, paper);
      const ocean = Materials.createStandardMaterial({ color: 0x5b8fb0 });
      const land = Materials.createStandardMaterial({ color: 0x86a86a });
      const ink = Materials.createStandardMaterial({ color: 0x3f5d78 });
      // A CHART, not a blank sheet: a drawn coastline with the island on it,
      // a compass rose, and two ruled lines of latitude.
      for (const [mx, mz, mw, md] of [
        [-0.28, -0.06, 0.34, 0.26],
        [-0.05, 0.08, 0.26, 0.2],
        [-0.36, 0.16, 0.18, 0.14],
      ] as Array<[number, number, number, number]>) {
        box(g, mw, 0.012, md, mx, 0.828, mz, land);
      }
      for (const lz of [-0.26, 0.24]) {
        box(g, 1.25, 0.008, 0.014, 0, 0.827, lz, ink);
      }
      box(g, 0.02, 0.008, 0.24, 0.52, 0.827, 0.22, ink); // compass rose
      box(g, 0.24, 0.008, 0.02, 0.52, 0.827, 0.22, ink);
      // Globe with continents and a brass meridian — a bare blue sphere is a ball.
      const globe = new THREE.Mesh(new THREE.SphereGeometry(0.2, 10, 7), ocean);
      globe.position.set(0.6, 1.05, -0.25);
      globe.castShadow = true;
      g.add(globe);
      for (const [gx, gy, gz] of [
        [0.13, 0.1, 0.08],
        [-0.09, 0.05, 0.15],
        [0.02, -0.12, -0.14],
        [-0.14, -0.06, -0.08],
      ] as Array<[number, number, number]>) {
        const patch = new THREE.Mesh(new THREE.SphereGeometry(0.075, 6, 4), land);
        patch.position.set(0.6 + gx, 1.05 + gy, -0.25 + gz);
        g.add(patch);
      }
      const meridian = new THREE.Mesh(new THREE.TorusGeometry(0.25, 0.017, 4, 14), metal);
      meridian.position.set(0.6, 1.05, -0.25);
      meridian.rotation.set(0.38, 0, 0.22);
      g.add(meridian);
      box(g, 0.12, 0.2, 0.12, 0.6, 0.88, -0.25, darkWood); // stand
    });

    // 18 COURIER — a handcart and a pigeonhole sorting rack.
    at(18, 'post_cart', this.arc(3.5), (g) => {
      pad(g, -0.9, 0, 3.0, 1.7, stone); // shorter span: this plot rises sharply
      // Roof the SORTING RACK, not the cart — the cart is meant to go out.
      leanTo(g, -1.7, 0, 1.5, 1.2, Materials.createStandardMaterial({ color: 0x2f7fae }));
      box(g, 1.1, 0.12, 0.7, 0, 0.55, 0, wood); // tray
      box(g, 1.1, 0.28, 0.06, 0, 0.7, -0.32, wood);
      box(g, 1.1, 0.28, 0.06, 0, 0.7, 0.32, wood);
      for (const wz of [-0.42, 0.42]) {
        // Rim + hub + spokes: a bare disc reads as a barrel lid at this size.
        const rim = new THREE.Mesh(new THREE.TorusGeometry(0.31, 0.05, 4, 10), darkWood);
        rim.position.set(-0.3, 0.34, wz);
        rim.castShadow = true;
        g.add(rim);
        const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.1, 6), metal);
        hub.position.set(-0.3, 0.34, wz);
        hub.rotation.x = Math.PI / 2;
        g.add(hub);
        for (const a of [0, Math.PI / 4, Math.PI / 2, (3 * Math.PI) / 4]) {
          const spoke = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.04, 0.03), wood);
          spoke.position.set(-0.3, 0.34, wz);
          spoke.rotation.z = a;
          g.add(spoke);
        }
      }
      // Two shafts running OUT from the tray along x — the original single
      // "handle" was 0.9 deep in z, i.e. a crossbar lying across the cart.
      for (const hz of [-0.25, 0.25]) {
        box(g, 0.9, 0.06, 0.06, 0.78, 0.6, hz, darkWood);
      }
      box(g, 0.06, 0.06, 0.5, 1.15, 0.6, 0, darkWood); // grab bar across the shafts
      // Sorting rack: a 3x3 grid of pigeonholes
      box(g, 1.0, 1.0, 0.35, -1.7, 0.6, 0, wood);
      for (let r = 0; r < 3; r++) {
        for (let c = 0; c < 3; c++) {
          box(g, 0.26, 0.26, 0.04, -1.7 + (c - 1) * 0.31, 0.3 + r * 0.3, 0.19, darkWood);
        }
      }
      box(g, 0.3, 0.3, 0.3, 0.15, 0.75, 0, cloth); // a sack on the tray
    });

    // 19 NIGHT WATCH — a watch post: brazier, key board, oil crate.
    at(19, 'watch_post', this.arc(3.5), (g) => {
      pad(g, -0.14, 0.08, 4.0, 1.8, stone);
      // Roof the key board; the brazier stays under open sky, being a fire.
      leanTo(g, -1.4, 0, 1.5, 1.2, Materials.createStandardMaterial({ color: 0xc0553f }));
      brazier(g, 0, 0);
      // Key board — on POSTS. Panel alone hung in mid-air.
      box(g, 0.9, 0.7, 0.06, -1.4, 0.9, 0, wood);
      box(g, 0.09, 1.25, 0.09, -1.82, 0.62, 0, darkWood);
      box(g, 0.09, 1.25, 0.09, -0.98, 0.62, 0, darkWood);
      box(g, 0.95, 0.08, 0.14, -1.4, 1.29, 0.02, darkWood); // capping rail
      for (const kx of [-0.25, 0, 0.25]) {
        box(g, 0.04, 0.06, 0.04, -1.4 + kx, 1.12, 0.06, metal); // hook
        box(g, 0.05, 0.18, 0.03, -1.4 + kx, 0.98, 0.06, metal); // key
      }
      box(g, 0.6, 0.5, 0.5, 1.3, 0.25, 0.2, darkWood); // oil crate
      box(g, 0.62, 0.06, 0.52, 1.3, 0.52, 0.2, wood);
      const lantern = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.26, 0.2), metal);
      lantern.position.set(1.3, 0.68, 0.2);
      lantern.castShadow = true;
      g.add(lantern);
      const glow = new THREE.Mesh(
        new THREE.BoxGeometry(0.14, 0.16, 0.14),
        new THREE.MeshBasicMaterial({ color: 0xffd98a, transparent: true, opacity: 0.9 }),
      );
      glow.position.copy(lantern.position);
      g.add(glow);
    });

    // 21 MAYOR — a lectern and the town notice board.
    at(
      21,
      'lectern',
      this.arc(3.5),
      (g) => {
        pad(g, -1.2, 0.1, 4.4, 2.2, stone);
        // A baldachin over the rostrum. It has to be WIDE relative to its
        // height or 2.35u posts on a 1.3u span read as scaffolding round a
        // 1.05u lectern; 2.0 x 1.8 gives it civic proportions.
        canopy(g, 0, 0.15, 2.0, 1.8, Materials.createStandardMaterial({ color: 0x8b5a2b }));
        box(g, 0.5, 0.9, 0.4, 0, 0.45, 0, wood);
        const top = box(g, 0.66, 0.06, 0.5, 0, 0.95, 0, darkWood);
        top.rotation.x = -0.28;
        const book = box(g, 0.3, 0.06, 0.22, 0, 1.0, 0.02, paper);
        book.rotation.x = -0.28;
        // Village notice board: framed, and roofed the way a real one is so the
        // notices survive the weather.
        box(g, 1.6, 1.1, 0.08, -2.0, 1.15, 0, wood);
        box(g, 1.7, 0.09, 0.12, -2.0, 1.72, 0.02, darkWood); // top rail
        box(g, 1.7, 0.09, 0.12, -2.0, 0.58, 0.02, darkWood); // bottom rail
        const boardCanopy = box(g, 1.8, 0.07, 0.42, -2.0, 1.82, 0.12, darkWood);
        boardCanopy.rotation.x = -0.34;
        box(g, 0.12, 1.2, 0.12, -2.7, 0.6, 0, darkWood);
        box(g, 0.12, 1.2, 0.12, -1.3, 0.6, 0, darkWood);
        for (const [px, py, tilt] of [
          [-0.4, 1.25, 0.06],
          [0.1, 1.35, -0.09],
          [0.35, 1.02, 0.03],
        ] as Array<[number, number, number]>) {
          const note = box(g, 0.3, 0.34, 0.02, -2.0 + px, py, 0.05, paper);
          note.rotation.z = tilt; // pinned by hand, never quite square
        }
      },
      0, // exact: tucked against the Professional/Welcome hall
    );
  }

  private createStall(): THREE.Group {
    const group = new THREE.Group();
    // ground skirt so slope gaps under the stall read as a wooden deck.
    // 0.9 deep (≈2.0u at the 2.2 stall scale): the old 0.5 skirt bottomed
    // out ~1.0u below the seat while the market slope falls up to ~1.2u
    // under a downhill corner — the audit caught its bottom face hanging
    // visibly in mid-air. Top stays at local +0.05 (under the table).
    const skirtGeom = new THREE.BoxGeometry(1.35, 0.9, 0.95);
    const skirtMat = Materials.createTrimMaterial(0x8a7355);
    const skirt = new THREE.Mesh(skirtGeom, skirtMat);
    skirt.position.set(0, -0.4, 0);
    group.add(skirt);
    // Base table
    const tableGeom = new THREE.BoxGeometry(1.2, 0.3, 0.8);
    const tableMat = Materials.createTrimMaterial(0x8b4513);
    const table = new THREE.Mesh(tableGeom, tableMat);
    table.position.set(0, 0.15, 0);
    table.castShadow = true;
    table.receiveShadow = true;
    group.add(table);
    // Four support posts
    const postMat = Materials.createTrimMaterial(0x6b4226);
    for (const sx of [-0.5, 0.5]) {
      for (const sz of [-0.3, 0.3]) {
        const p = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.6, 5), postMat);
        p.position.set(sx, 0.6, sz);
        group.add(p);
      }
    }
    // Roof
    const roofGeom = new THREE.ConeGeometry(0.8, 0.4, 4);
    const STALL_COLORS = [0xd44e3c, 0xc47a2e, 0x3e8e6d, 0x4478a8];
    const roofMat = Materials.createTrimMaterial(
      STALL_COLORS[Math.floor(Math.random() * STALL_COLORS.length)],
    );
    const roof = new THREE.Mesh(roofGeom, roofMat);
    roof.position.set(0, 1.05, 0);
    roof.rotation.y = Math.PI / 4;
    roof.castShadow = true;
    group.add(roof);
    // Small goods on the table
    const goodColors = [0xff8844, 0x44aa44, 0xddcc33, 0xaa4488];
    for (let g = 0; g < 3; g++) {
      const good = new THREE.Mesh(
        new THREE.BoxGeometry(0.12, 0.1, 0.12),
        new THREE.MeshStandardMaterial({
          color: goodColors[g % goodColors.length],
          roughness: 0.6,
        }),
      );
      good.position.set(-0.3 + g * 0.3, 0.35, 0);
      group.add(good);
    }
    return group;
  }

  private createConstructionBlock(label?: string, withCrane = false): THREE.Group {
    const group = new THREE.Group();
    // A half-built workshop, not a grey concrete cube. Finished timber lower
    // storey + a narrower "blueprint blue" upper storey still going up, so the
    // Projects district reads as an ACTIVE build site — matching the
    // "currently building" story the panel tells — instead of five anonymous
    // grey boxes.
    const timberMat = Materials.createPBRMaterial({ color: 0x9c774a, roughness: 0.85 });
    const blueprintMat = Materials.createPBRMaterial({ color: 0x2f5aa0, roughness: 0.55 });
    // Foundation slab (timber)
    const slab = new THREE.Mesh(new THREE.BoxGeometry(2.3, 0.3, 2.3), timberMat);
    slab.position.y = 0.15;
    slab.receiveShadow = true;
    group.add(slab);
    // Lower storey — finished timber frame
    const lower = new THREE.Mesh(new THREE.BoxGeometry(2, 1.6, 2), timberMat);
    lower.position.set(0, 1.1, 0);
    lower.castShadow = true;
    lower.receiveShadow = true;
    group.add(lower);
    // Upper storey — blueprint-blue, narrower + set up: the part still "under
    // construction"
    const upper = new THREE.Mesh(new THREE.BoxGeometry(1.7, 1.2, 1.7), blueprintMat);
    upper.position.set(0, 2.5, 0);
    upper.castShadow = true;
    upper.receiveShadow = true;
    group.add(upper);
    // Scaffolding — safety-orange poles + a couple of cross-rails
    const poleMat = Materials.createTrimMaterial(0xd98a2b);
    const poleGeom = new THREE.CylinderGeometry(0.05, 0.05, 4, 8);
    for (let i = 0; i < 4; i++) {
      const pole = new THREE.Mesh(poleGeom, poleMat);
      const x = (i % 2) * 1.8 - 0.9;
      const z = Math.floor(i / 2) * 1.8 - 0.9;
      pole.position.set(x, 2, z);
      pole.castShadow = true;
      pole.receiveShadow = true;
      group.add(pole);
    }
    const railGeom = new THREE.BoxGeometry(1.9, 0.06, 0.06);
    for (const rz of [-0.9, 0.9]) {
      const rail = new THREE.Mesh(railGeom, poleMat);
      rail.position.set(0, 2.7, rz);
      group.add(rail);
    }
    // Tower-crane silhouette — landmark for the hero (RankPilot) lot. Reads as
    // "being built" from across the district and gives Projects a skyline.
    if (withCrane) {
      const craneMat = Materials.createTrimMaterial(0xe0b030);
      const mast = new THREE.Mesh(new THREE.BoxGeometry(0.2, 6.5, 0.2), craneMat);
      mast.position.set(1.3, 3.25, 1.3);
      mast.castShadow = true;
      group.add(mast);
      const jib = new THREE.Mesh(new THREE.BoxGeometry(3.4, 0.18, 0.18), craneMat);
      jib.position.set(0.1, 6.2, 1.3);
      jib.castShadow = true;
      group.add(jib);
      const cable = new THREE.Mesh(
        new THREE.CylinderGeometry(0.02, 0.02, 2.2, 6),
        Materials.createTrimMaterial(0x333333),
      );
      cable.position.set(-0.9, 5.1, 1.3);
      group.add(cable);
      const load = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.45, 0.45), timberMat);
      load.position.set(-0.9, 3.85, 1.3);
      load.castShadow = true;
      group.add(load);
    }
    // Name plaque: connect the world to the content. Standing in the Projects
    // district you saw five anonymous grey boxes while the panel talked about
    // RankPilot/ChocoMate/… — now each block is labelled with its project. A
    // camera-facing sprite avoids the floating-plane look that got signboards
    // removed. (The timber/blueprint visual rescue lands in a later pass.)
    if (label) {
      const canvas = document.createElement('canvas');
      canvas.width = 320;
      canvas.height = 72;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.fillStyle = 'rgba(15,20,32,0.82)';
        ctx.fillRect(0, 0, 320, 72);
        ctx.strokeStyle = 'rgba(150,185,255,0.42)'; // was 0.65 — quieter rim
        ctx.lineWidth = 2;
        ctx.strokeRect(2, 2, 316, 68);
        let fs = 34;
        ctx.font = `bold ${fs}px system-ui, "Segoe UI", sans-serif`;
        while (ctx.measureText(label).width > 292 && fs > 14) {
          fs -= 2;
          ctx.font = `bold ${fs}px system-ui, "Segoe UI", sans-serif`;
        }
        ctx.fillStyle = '#eaf1ff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, 160, 38);
        const tex = new THREE.CanvasTexture(canvas);
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = 4;
        const sprite = new THREE.Sprite(
          new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }),
        );
        sprite.name = 'project-plaque';
        // 4.5: the scaffold poles (h=4 cylinders at y=2 → tops at 4.0, only
        // 1.27 from centre — inside the plaque's 1.4 half-width) poked
        // through the old 3.95 band (3.64–4.27). Bottom now 4.19, clearing
        // the pole tops by 0.19; the crane jib (y 6.2) stays well above.
        sprite.position.set(0, 4.5, 0);
        sprite.scale.set(2.8, 0.63, 1);
        // Decorative label — opt out of raycasting (skip the interaction/camera
        // rays + the "Raycaster.camera not set" console spam).
        sprite.raycast = () => {};
        group.add(sprite);
      }
    }
    return group;
  }

  private createRiver(): THREE.Group {
    const group = new THREE.Group();
    const riverGeom = new THREE.PlaneGeometry(8, 1.6, 32, 6);
    const pos = riverGeom.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      pos.setZ(i, Math.sin(x * 0.8) * 0.35);
      const edgeFade = 1 - Math.abs(pos.getY(i)) / 0.8;
      pos.setY(i, pos.getY(i) * (0.6 + edgeFade * 0.4));
    }
    riverGeom.computeVertexNormals();
    const riverMat = new THREE.MeshStandardMaterial({
      color: 0x3399dd,
      transparent: true,
      opacity: 0.7,
      roughness: 0.05,
      metalness: 0.3,
      emissive: 0x1155aa,
      emissiveIntensity: 0.15,
    });
    const river = new THREE.Mesh(riverGeom, riverMat);
    river.rotation.x = -Math.PI / 2;
    river.receiveShadow = true;
    group.add(river);
    return group;
  }

  private createMountain(): THREE.Group {
    // Redesigned: a single granite peak with a snow cap, half the old size.
    // The old 11u cone + wide base cylinder covered a third of the visible
    // hemisphere from orbit and read as a grey octagon landing pad with a
    // brown ring from above.
    const group = new THREE.Group();
    const peakGeom = new THREE.ConeGeometry(2.6, 5.2, 7);
    const peakMat = Materials.createPBRMaterial({ color: 0x9aa0a8, roughness: 0.95 });
    const peak = new THREE.Mesh(peakGeom, peakMat);
    peak.position.set(0, 2.6, 0);
    peak.castShadow = true;
    peak.receiveShadow = true;
    group.add(peak);
    const snowGeom = new THREE.ConeGeometry(0.95, 1.6, 7);
    const snowMat = Materials.createPBRMaterial({ color: 0xf4f6f8, roughness: 0.6 });
    const snow = new THREE.Mesh(snowGeom, snowMat);
    snow.position.set(0, 4.5, 0);
    group.add(snow);
    return group;
  }

  // Attempt to replace the segmented road planes with DecalGeometry projected decals for sharper results.
  private async tryLoadModels(
    _buildings: THREE.Group,
    _npcs: THREE.Group,
    _buildingPlaceholders: THREE.Mesh[],
    _npcPlaceholders: THREE.Mesh[],
  ) {
    try {
      const loaderModule = await import('three/addons/loaders/GLTFLoader.js');
      const { GLTFLoader: GLTFLoaderClass } = loaderModule as { GLTFLoader: GLTFLoaderConstructor };
      const loader = new GLTFLoaderClass();
      const basePath = '/assets/models/';

      // helper to find procedural placeholders by name prefix across island root
      const findPlaceholders = (prefix: string): THREE.Object3D[] => {
        const out: THREE.Object3D[] = [];
        this.mesh.traverse((obj) => {
          if (obj.name.startsWith(prefix)) {
            out.push(obj);
          }
        });
        return out;
      };

      // per-model override table (basename -> tweaks)
      let modelOverrides: Record<string, ModelOverride> = {
        // Intended toon set (Blender-authored, public/assets/models/*.glb)
        'bench.glb': { envMapIntensity: 0.8, randomYaw: true },
        'mailbox.glb': { envMapIntensity: 0.8 },
        // fitHeight rescales by bbox: native car.glb is ~4.4u long (wider
        // than a house) and lamp.glb ~4.1u tall (towers over the roofs)
        'car.glb': { envMapIntensity: 0.9, randomYaw: true, fitHeight: 1.45 },
        'npc.glb': { envMapIntensity: 0.7, scale: 1.0 },
        'tree.glb': { envMapIntensity: 0.5 },
        'lamp.glb': { envMapIntensity: 0.6, fitHeight: 2.9 },
        'house.glb': { envMapIntensity: 0.8, randomYaw: true },
        // Legacy kit fallbacks
        'bench.gltf': { envMapIntensity: 0.8 },
        'Bench.gltf': { envMapIntensity: 0.85, fitHeight: 1.15, randomYaw: true },
        'Chair_1.gltf': { envMapIntensity: 0.85, fitHeight: 1.4, randomYaw: true },
        'Lantern_Wall.gltf': { envMapIntensity: 0.9, fitHeight: 2.4 },
        'car.gltf': { envMapIntensity: 0.9 },
        'npc.gltf': { envMapIntensity: 0.7, roughnessScale: 1.0, scale: 0.6 },
        'tree.gltf': { envMapIntensity: 0.5 },
        'lamp.gltf': { envMapIntensity: 0.6 },
        'Stall_Empty.gltf': { envMapIntensity: 0.85, fitHeight: 3.8, randomYaw: true },
        'Stall_Cart_Empty.gltf': { envMapIntensity: 0.85, fitHeight: 3.2, randomYaw: true },
        'Workbench.gltf': { envMapIntensity: 0.75, fitHeight: 2.0, randomYaw: true },
        'Workbench_Drawers.gltf': { envMapIntensity: 0.75, fitHeight: 2.0, randomYaw: true },
        'Cabinet.gltf': { envMapIntensity: 0.8, fitHeight: 2.4, randomYaw: true },
        'Barrel.gltf': { envMapIntensity: 0.7, fitHeight: 1.2, randomYaw: true },
        'Crate_Wooden.gltf': { envMapIntensity: 0.7, fitHeight: 1.1, randomYaw: true },
      };

      // Attempt to read optional overrides manifest next to models (assets/models/overrides.json)
      try {
        const manifestResp = await fetch('assets/models/overrides.json');
        if (manifestResp.ok) {
          const userOverrides = await manifestResp.json();
          if (userOverrides && typeof userOverrides === 'object') {
            modelOverrides = Object.assign({}, modelOverrides, userOverrides);
            console.log('Island: applied model overrides manifest');
          }
        }
      } catch {
        /* ignore missing manifest */
      }

      // helper to split a packed ORM texture into separate textures
      // packingHint examples: 'rga' (R=AO,G=Rough,B=Metal), 'rgb' (R=red->ao, G=green->rough, B=blue->metal)
      const splitORMTexture = (
        texture: THREE.Texture,
        packingHint: string = 'rga',
      ): ORMSplitResult | null => {
        const textureKey: object = texture;
        const imageKey =
          typeof texture.image === 'object' && texture.image !== null
            ? (texture.image as object)
            : undefined;

        const cachedTexture = ormTextureCache.get(textureKey);
        if (cachedTexture !== undefined) {
          return cachedTexture;
        }
        if (imageKey) {
          const cachedImage = ormTextureCache.get(imageKey);
          if (cachedImage !== undefined) {
            ormTextureCache.set(textureKey, cachedImage);
            return cachedImage;
          }
        }

        if (
          ormTextureProcessing.has(textureKey) ||
          (imageKey && ormTextureProcessing.has(imageKey))
        ) {
          return null;
        }

        ormTextureProcessing.add(textureKey);
        if (imageKey) {
          ormTextureProcessing.add(imageKey);
        }

        const recordResult = (result: ORMSplitResult | null) => {
          ormTextureCache.set(textureKey, result);
          if (imageKey) {
            ormTextureCache.set(imageKey, result);
          }
        };

        const textureName = getTextureIdentifier(texture);

        try {
          const image = texture.image as
            | (HTMLImageElement & object)
            | (HTMLCanvasElement & object)
            | (ImageBitmap & object)
            | undefined;
          const width =
            image && typeof (image as { width?: number }).width === 'number'
              ? (image as { width: number }).width
              : ((image as HTMLImageElement | undefined)?.naturalWidth ?? 0);
          const height =
            image && typeof (image as { height?: number }).height === 'number'
              ? (image as { height: number }).height
              : ((image as HTMLImageElement | undefined)?.naturalHeight ?? 0);
          if (!width || !height || !image) {
            recordResult(null);
            return null;
          }

          const sourceCanvas = document.createElement('canvas');
          sourceCanvas.width = width;
          sourceCanvas.height = height;
          const sourceContext = sourceCanvas.getContext('2d');
          if (!sourceContext) {
            recordResult(null);
            return null;
          }

          try {
            sourceContext.drawImage(image as CanvasImageSource, 0, 0, width, height);
          } catch (error) {
            console.warn(
              'splitORMTexture: canvas drawImage failed (possible CORS taint), skipping split',
              error,
            );
            getDiagnostics().push({
              map: textureName,
              result: 'tainted',
              reason: 'drawImage failed (CORS/taint)',
            });
            recordResult(null);
            return null;
          }

          let imageData: ImageData;
          try {
            imageData = sourceContext.getImageData(0, 0, width, height);
          } catch (error) {
            console.warn(
              'splitORMTexture: getImageData failed (tainted canvas), skipping split',
              error,
            );
            getDiagnostics().push({
              map: textureName,
              result: 'tainted',
              reason: 'getImageData failed (CORS/taint)',
            });
            recordResult(null);
            return null;
          }

          const createCanvas = () => {
            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            return canvas;
          };

          const aoCanvas = createCanvas();
          const roughCanvas = createCanvas();
          const metalCanvas = createCanvas();

          const aoCtx = aoCanvas.getContext('2d');
          const roughCtx = roughCanvas.getContext('2d');
          const metalCtx = metalCanvas.getContext('2d');
          if (!aoCtx || !roughCtx || !metalCtx) {
            recordResult(null);
            return null;
          }

          const aoData = aoCtx.createImageData(width, height);
          const roughData = roughCtx.createImageData(width, height);
          const metalData = metalCtx.createImageData(width, height);

          const hint = (packingHint || 'rga').toLowerCase();
          const channelIndex = (token: string): number => {
            if (token === 'r' || token === 'red') return 0;
            if (token === 'g' || token === 'green') return 1;
            if (token === 'b' || token === 'blue') return 2;
            return 0;
          };
          const aoSource = channelIndex(hint[0] ?? 'r');
          const roughSource = channelIndex(hint[1] ?? 'g');
          const metalSource = channelIndex(hint[2] ?? 'b');

          const srcData = imageData.data;
          for (let i = 0; i < srcData.length; i += 4) {
            const channels: [number, number, number] = [srcData[i], srcData[i + 1], srcData[i + 2]];
            const ao = channels[aoSource] ?? 0;
            const rough = channels[roughSource] ?? 0;
            const metal = channels[metalSource] ?? 0;

            aoData.data[i] = aoData.data[i + 1] = aoData.data[i + 2] = ao;
            aoData.data[i + 3] = 255;

            roughData.data[i] = roughData.data[i + 1] = roughData.data[i + 2] = rough;
            roughData.data[i + 3] = 255;

            metalData.data[i] = metalData.data[i + 1] = metalData.data[i + 2] = metal;
            metalData.data[i + 3] = 255;
          }

          aoCtx.putImageData(aoData, 0, 0);
          roughCtx.putImageData(roughData, 0, 0);
          metalCtx.putImageData(metalData, 0, 0);

          const aoTexture = new THREE.CanvasTexture(aoCanvas);
          const roughTexture = new THREE.CanvasTexture(roughCanvas);
          const metalTexture = new THREE.CanvasTexture(metalCanvas);

          aoTexture.needsUpdate = true;
          roughTexture.needsUpdate = true;
          metalTexture.needsUpdate = true;

          const result: ORMSplitResult = {
            aoMap: aoTexture,
            roughnessMap: roughTexture,
            metalnessMap: metalTexture,
          };

          recordResult(result);
          getDiagnostics().push({ map: textureName, result: 'ok' });
          return result;
        } catch (error) {
          const reason = error instanceof Error ? error.message : 'unknown';
          console.warn('splitORMTexture generic failure', error);
          getDiagnostics().push({ map: textureName, result: 'error', reason });
          recordResult(null);
          return null;
        } finally {
          ormTextureProcessing.delete(textureKey);
          if (imageKey) {
            ormTextureProcessing.delete(imageKey);
          }
        }
      };

      // helper to prepare a model clone for fade-in while preserving GLTF materials and applying overrides (including ORM splitting)
      const prepareClone = (
        model: THREE.Object3D,
        /*position: THREE.Vector3, quaternion: THREE.Quaternion,*/
        scale = 1,
        overrides?: {
          envMapIntensity?: number;
          roughnessScale?: number;
          ormPacking?: string;
          fitHeight?: number;
          yOffset?: number;
          randomYaw?: boolean;
        },
      ) => {
        // clone model, apply local scale; caller should position the returned copy using placeObjectOnSurface
        const copy = model.clone(true) as THREE.Object3D;
        copy.position.set(0, 0, 0);
        copy.quaternion.identity();
        copy.scale.setScalar(scale);
        if (typeof overrides?.fitHeight === 'number') {
          try {
            const bbox = new THREE.Box3().setFromObject(copy);
            const size = new THREE.Vector3();
            bbox.getSize(size);
            if (size.y > 1e-4) {
              const desired = overrides.fitHeight;
              const adjust = desired / size.y;
              copy.scale.multiplyScalar(adjust);
            }
          } catch {
            /* ignore fit scaling issues */
          }
        }
        copy.traverse((node) => {
          if (!(node instanceof THREE.Mesh)) {
            return;
          }

          node.castShadow = true;
          node.receiveShadow = true;

          try {
            Materials.fixMaterialTextures(node.material as THREE.Material | THREE.Material[]);
          } catch {
            /* ignore texture fix issues */
          }

          const attemptSplit = (
            packedTexture: THREE.Texture | undefined,
            onSuccess: (result: ORMSplitResult) => void,
            contextLabel: string,
          ) => {
            if (!packedTexture) {
              return;
            }
            const overrideHint = overrides?.ormPacking;
            const textureLabel = getTextureIdentifier(packedTexture);
            const nameHint = packedTexture.name || '';
            const looksPacked =
              /orm|metalroughness|occlusion|mro|packed/i.test(nameHint) || Boolean(overrideHint);
            if (!looksPacked && !overrideHint) {
              return;
            }
            try {
              const split = splitORMTexture(packedTexture, overrideHint ?? 'rga');
              if (split) {
                onSuccess(split);
                console.info('[Island] splitORMTexture succeeded for', contextLabel, textureLabel);
              } else {
                console.info('[Island] splitORMTexture skipped for', contextLabel, textureLabel);
              }
            } catch (error) {
              console.warn(
                '[Island] splitORMTexture threw when processing',
                contextLabel,
                textureLabel,
                error,
              );
            }
          };

          const materials = Array.isArray(node.material) ? node.material : [node.material];

          materials.forEach((material, materialIndex) => {
            if (!material) {
              return;
            }

            const typedMaterial = material as MaterialWithTextureProps;

            if (
              typedMaterial instanceof THREE.MeshStandardMaterial ||
              typedMaterial instanceof THREE.MeshPhysicalMaterial
            ) {
              if (typeof overrides?.envMapIntensity === 'number') {
                typedMaterial.envMapIntensity = overrides.envMapIntensity;
              } else if (typeof typedMaterial.envMapIntensity === 'number') {
                typedMaterial.envMapIntensity = Math.max(typedMaterial.envMapIntensity || 0, 0.6);
              }
              if (
                typeof overrides?.roughnessScale === 'number' &&
                typeof typedMaterial.roughness === 'number'
              ) {
                typedMaterial.roughness = Math.min(
                  1,
                  typedMaterial.roughness * overrides.roughnessScale,
                );
              }

              const packedTexture = extractTexture(typedMaterial);
              attemptSplit(
                packedTexture,
                (split) => {
                  if (!typedMaterial.aoMap) {
                    typedMaterial.aoMap = split.aoMap;
                  }
                  if (!typedMaterial.roughnessMap) {
                    typedMaterial.roughnessMap = split.roughnessMap;
                  }
                  if ('metalnessMap' in typedMaterial) {
                    const metalMaterial = typedMaterial as THREE.MeshStandardMaterial;
                    if (!metalMaterial.metalnessMap) {
                      metalMaterial.metalnessMap = split.metalnessMap;
                    }
                  }
                },
                'material map',
              );

              if ('opacity' in typedMaterial) {
                typedMaterial.transparent = true;
                (typedMaterial as { opacity?: number }).opacity = 0;
              }
              return;
            }

            try {
              const sourceMaterial = typedMaterial;
              const standardMaterial = new THREE.MeshStandardMaterial();

              if ('color' in sourceMaterial && sourceMaterial.color instanceof THREE.Color) {
                standardMaterial.color = sourceMaterial.color.clone();
              }
              if (sourceMaterial.map instanceof THREE.Texture) {
                standardMaterial.map = sourceMaterial.map;
              }
              if (sourceMaterial.normalMap instanceof THREE.Texture) {
                standardMaterial.normalMap = sourceMaterial.normalMap;
              }

              if (typeof sourceMaterial.shininess === 'number') {
                standardMaterial.roughness = Math.min(1, 1 - sourceMaterial.shininess / 300);
              } else if (typeof sourceMaterial.roughness === 'number') {
                standardMaterial.roughness = Math.max(0, Math.min(1, sourceMaterial.roughness));
              } else {
                standardMaterial.roughness = 0.7;
              }

              if (typeof sourceMaterial.metalness === 'number') {
                standardMaterial.metalness = sourceMaterial.metalness;
              }
              if (sourceMaterial.emissive instanceof THREE.Color) {
                standardMaterial.emissive = sourceMaterial.emissive.clone();
              }
              if (sourceMaterial.roughnessMap instanceof THREE.Texture) {
                standardMaterial.roughnessMap = sourceMaterial.roughnessMap;
              }
              if (sourceMaterial.aoMap instanceof THREE.Texture) {
                standardMaterial.aoMap = sourceMaterial.aoMap;
              }

              const packedTexture = extractTexture(sourceMaterial);
              attemptSplit(
                packedTexture,
                (split) => {
                  standardMaterial.aoMap = split.aoMap;
                  standardMaterial.roughnessMap = split.roughnessMap;
                  standardMaterial.metalnessMap = split.metalnessMap;
                },
                'converted material map',
              );

              standardMaterial.envMapIntensity =
                typeof overrides?.envMapIntensity === 'number' ? overrides.envMapIntensity : 0.6;
              standardMaterial.transparent = true;
              standardMaterial.opacity = 0;

              if (Array.isArray(node.material)) {
                const updatedMaterials = node.material.slice();
                updatedMaterials[materialIndex] = standardMaterial;
                node.material = updatedMaterials;
              } else {
                node.material = standardMaterial;
              }
            } catch {
              /* swallow conversion issues */
            }
          });
        });
        return copy as THREE.Object3D;
      };

      type ReplaceOptions = {
        scale?: number;
        fitHeight?: number;
        heightOffset?: number;
        randomYaw?: boolean;
        scaleJitter?: number;
        candidates?: string[];
        /** Fired once the authored model has replaced every placeholder —
         *  lets a caller retire the procedural fallback it just superseded
         *  (street lamps hide their instanced fleet here). */
        onReplaced?: (count: number) => void;
        /** Re-pack the placed clones into InstancedMesh (one per distinct
         *  geometry+material). Only for STATIC props — anything animated,
         *  skinned, or individually moved/hidden later must stay a clone. */
        collapseToInstances?: boolean;
      };

      /**
       * The GLB fade-in's two halves, shared by every loader below.
       *
       * `prepareClone` forces `transparent=true; opacity=0` so a clone can
       * fade up — and clones SHARE the source model's materials, so by the
       * time any clone exists the authored values are already gone. Snapshot
       * from the MODEL, before the first prepareClone call; restore when the
       * fade lands. Nothing restored them before, so every GLB-replaced prop
       * on the island sat in the sorted transparent pass with no early-Z
       * forever, purely as a leftover of a 600ms animation.
       */
      type AuthoredMat = { transparent: boolean; opacity: number };
      const snapshotAuthoredMaterials = (model: THREE.Object3D): Map<string, AuthoredMat> => {
        const snap = new Map<string, AuthoredMat>();
        model.traverse((o) => {
          if (!(o instanceof THREE.Mesh)) return;
          const list = Array.isArray(o.material) ? o.material : [o.material];
          for (const mat of list) {
            if (mat && !snap.has(mat.uuid)) {
              snap.set(mat.uuid, { transparent: mat.transparent, opacity: mat.opacity });
            }
          }
        });
        return snap;
      };
      /** Collect a placed clone's materials so the fade can hand them back. */
      const collectFadeMaterials = (clone: THREE.Object3D): THREE.Material[] => {
        const out: THREE.Material[] = [];
        clone.traverse((o) => {
          if (!(o instanceof THREE.Mesh)) return;
          const list = Array.isArray(o.material) ? o.material : [o.material];
          for (const mat of list) if (mat) out.push(mat);
        });
        return out;
      };
      const restoreAuthoredMaterials = (
        mats: THREE.Material[],
        snap: Map<string, AuthoredMat>,
      ): void => {
        for (const mat of mats) {
          // prepareClone REPLACES some source materials with fresh
          // MeshStandardMaterials (non-standard/physical sources), whose
          // uuid the snapshot has never seen — those are authored opaque by
          // construction, so fall back to that rather than skipping them.
          const authored = snap.get(mat.uuid) ?? { transparent: false, opacity: 1 };
          if (mat.transparent !== authored.transparent) {
            mat.transparent = authored.transparent;
            mat.needsUpdate = true;
          }
          if (mat.opacity !== authored.opacity) mat.opacity = authored.opacity;
        }
      };

      /**
       * Re-pack a set of identical, STATIC GLB clones into InstancedMesh —
       * one per distinct geometry+material pair.
       *
       * Object3D.clone() SHARES geometry and materials, so N clones of the
       * same model are N draw calls of the same two buffers: exactly what
       * instancing exists for. The clones' own placement logic (surface
       * seating, inherited yaw, random spin, fitHeight, overrides) runs
       * untouched first and this only re-packs the RESULT, so the world
       * transform of every part is preserved bit for bit.
       *
       * The clones are detached but NOT disposed: the instances now hold
       * their geometry and materials, and the fade-in closure still animates
       * those same shared materials (so the fade still reads correctly).
       */
      const collapseClonesToInstances = (clones: THREE.Object3D[], label: string): number => {
        if (clones.length < 2) return 0;
        this.mesh.updateMatrixWorld(true);
        const toLocal = new THREE.Matrix4().copy(this.mesh.matrixWorld).invert();
        type Bucket = {
          geometry: THREE.BufferGeometry;
          material: THREE.Material | THREE.Material[];
          castShadow: boolean;
          receiveShadow: boolean;
          matrices: THREE.Matrix4[];
        };
        const buckets = new Map<string, Bucket>();
        let skipped = 0;
        for (const clone of clones) {
          clone.updateWorldMatrix(true, true);
          clone.traverse((node) => {
            const m = node as THREE.Mesh & {
              isPoints?: boolean;
              isLine?: boolean;
              isInstancedMesh?: boolean;
            };
            if (!m.geometry) return; // pure transform node
            // CONSERVATIVE: anything carrying geometry that is not a plain,
            // visible Mesh makes the whole collapse bail (skinned = per-clone
            // skeleton; instanced = would flatten to one; points/lines draw
            // differently; hidden = would become permanently visible).
            if (
              !m.isMesh ||
              m.isInstancedMesh ||
              m.isPoints ||
              m.isLine ||
              (m as THREE.SkinnedMesh).isSkinnedMesh ||
              !m.visible
            ) {
              skipped++;
              return;
            }
            const matKey = Array.isArray(m.material)
              ? m.material.map((x) => x.uuid).join(',')
              : m.material.uuid;
            const key = `${m.geometry.uuid}|${matKey}`;
            let b = buckets.get(key);
            if (!b) {
              b = {
                geometry: m.geometry,
                material: m.material,
                castShadow: m.castShadow,
                receiveShadow: m.receiveShadow,
                matrices: [],
              };
              buckets.set(key, b);
            }
            b.matrices.push(new THREE.Matrix4().multiplyMatrices(toLocal, m.matrixWorld));
          });
        }
        // Bail (leaving the clones untouched) on anything non-collapsible, and
        // on a DEGENERATE split: prepareClone mints a fresh material per clone
        // for non-standard sources, which would yield one single-instance mesh
        // per clone — the same draw count plus N instanceMatrix buffers.
        if (skipped > 0 || buckets.size === 0 || buckets.size >= clones.length) return 0;
        let idx = 0;
        for (const b of buckets.values()) {
          const inst = new THREE.InstancedMesh(b.geometry, b.material, b.matrices.length);
          // NEVER name these with a placeholder prefix — findPlaceholders
          // matches by prefix and would treat them as replaceable stand-ins.
          inst.name = `glbfleet_${label}${idx++}`;
          inst.castShadow = b.castShadow;
          inst.receiveShadow = b.receiveShadow;
          // The fleets ring the planet, so one bounding sphere spans the whole
          // world and culling could only ever be all-or-nothing.
          inst.frustumCulled = false;
          for (let i = 0; i < b.matrices.length; i++) inst.setMatrixAt(i, b.matrices[i]);
          inst.instanceMatrix.needsUpdate = true;
          this.mesh.add(inst);
        }
        for (const clone of clones) clone.parent?.remove(clone);
        return buckets.size;
      };

      // Generic loader & replacer: load url and replace placeholders (by name prefix)
      const loadAndReplace = (primaryUrl: string, prefix: string, options: ReplaceOptions = {}) => {
        try {
          const tryList = [primaryUrl].concat((options.candidates || []).filter(Boolean));
          const tryLoadAt = (idx: number) => {
            if (idx >= tryList.length) return; // nothing left
            const url = tryList[idx];
            loader.load(
              url,
              (gltf: GLTF) => {
                const model = gltf.scene || gltf.scenes?.[0];
                const animations = gltf.animations || [];
                if (!model) return;
                const placeholders = findPlaceholders(prefix);
                const placedClones: THREE.Object3D[] = [];
                // Authored transparency, read before prepareClone overwrites
                // it on the shared materials (see snapshotAuthoredMaterials).
                const authoredMats = snapshotAuthoredMaterials(model);
                const base = url.replace(/^.*[\\/]/, '');
                const overridesFromManifest = modelOverrides[base] || {};
                placeholders.forEach((ph) => {
                  const parent = ph.parent || this.mesh;
                  const baseScale = typeof options.scale === 'number' ? options.scale : 1;
                  const appliedOverrides = { ...overridesFromManifest } as {
                    envMapIntensity?: number;
                    roughnessScale?: number;
                    ormPacking?: string;
                    fitHeight?: number;
                    yOffset?: number;
                    randomYaw?: boolean;
                    scale?: number;
                  };
                  if (
                    typeof options.fitHeight === 'number' &&
                    typeof appliedOverrides.fitHeight !== 'number'
                  )
                    appliedOverrides.fitHeight = options.fitHeight;
                  if (
                    typeof options.randomYaw === 'boolean' &&
                    typeof appliedOverrides.randomYaw !== 'boolean'
                  )
                    appliedOverrides.randomYaw = options.randomYaw;
                  if (
                    typeof options.heightOffset === 'number' &&
                    typeof appliedOverrides.yOffset !== 'number'
                  )
                    appliedOverrides.yOffset = options.heightOffset;
                  const usedScale =
                    typeof appliedOverrides.scale === 'number' ? appliedOverrides.scale : baseScale;
                  const clone = prepareClone(model, usedScale, appliedOverrides);
                  // position clone on the displaced surface where the placeholder was
                  let placement: { position: THREE.Vector3; normal: THREE.Vector3 } | null = null;
                  try {
                    placement = this.placeObjectOnSurface(clone, ph.position.clone(), 0.0, true);
                  } catch {
                    placement = null;
                  }
                  if (placement) {
                    const normal = placement.normal.clone();
                    // Inherit the placeholder's yaw about the normal (layout
                    // facing, e.g. houses toward the road) unless randomYaw.
                    {
                      const proj = (v: THREE.Vector3) =>
                        v.clone().sub(normal.clone().multiplyScalar(v.dot(normal)));
                      const phF = proj(new THREE.Vector3(0, 0, 1).applyQuaternion(ph.quaternion));
                      const clF = proj(
                        new THREE.Vector3(0, 0, 1).applyQuaternion(clone.quaternion),
                      );
                      if (phF.lengthSq() > 1e-8 && clF.lengthSq() > 1e-8) {
                        phF.normalize();
                        clF.normalize();
                        const yawAng = Math.atan2(
                          new THREE.Vector3().crossVectors(clF, phF).dot(normal),
                          clF.dot(phF),
                        );
                        clone.quaternion.premultiply(
                          new THREE.Quaternion().setFromAxisAngle(normal, yawAng),
                        );
                      }
                    }
                    if (typeof appliedOverrides.yOffset === 'number') {
                      clone.position.add(normal.clone().multiplyScalar(appliedOverrides.yOffset));
                    }
                    if (
                      typeof options.heightOffset === 'number' &&
                      typeof appliedOverrides.yOffset !== 'number'
                    ) {
                      clone.position.add(normal.clone().multiplyScalar(options.heightOffset));
                    }
                    const allowRandomYaw =
                      (typeof appliedOverrides.randomYaw === 'boolean'
                        ? appliedOverrides.randomYaw
                        : false) || options.randomYaw === true;
                    if (allowRandomYaw) {
                      const yaw = Math.random() * Math.PI * 2;
                      const spin = new THREE.Quaternion().setFromAxisAngle(normal, yaw);
                      // premultiply: world-space spin about the normal
                      clone.quaternion.premultiply(spin);
                    }
                  }
                  if (typeof options.scaleJitter === 'number' && options.scaleJitter > 0) {
                    const jitter = 1 + (Math.random() * 2 - 1) * options.scaleJitter;
                    clone.scale.multiplyScalar(jitter);
                  }
                  parent.add(clone);
                  placedClones.push(clone);

                  // If the GLTF contains animations, create mixer for this clone and play a sensible default (Idle/first)
                  try {
                    if (animations && animations.length) {
                      const mixer = new THREE.AnimationMixer(clone);
                      // try to find Idle/Walk/Run by name, prefer Idle
                      let clip = animations.find((candidate) => /idle/i.test(candidate.name));
                      if (!clip)
                        clip = animations.find((candidate) => /walk/i.test(candidate.name));
                      if (!clip) clip = animations[0];
                      if (clip) {
                        const action = mixer.clipAction(clip);
                        action.reset();
                        action.play();
                      }
                      this.animationMixers.push(mixer);
                    }
                  } catch {
                    /* ignore animation setup errors */
                  }

                  // fade in/out
                  const duration = 600;
                  const start = performance.now();
                  const fadeMats = collectFadeMaterials(clone);
                  const step = () => {
                    const now = performance.now();
                    const t = Math.min(1, (now - start) / duration);
                    clone.traverse((object) => {
                      if (object instanceof THREE.Mesh) {
                        const materials = Array.isArray(object.material)
                          ? object.material
                          : [object.material];
                        materials.forEach((material) => {
                          if (!material) return;
                          material.opacity = t;
                          if (t < 1) {
                            material.transparent = true;
                          }
                          material.needsUpdate = true;
                        });
                      }
                    });
                    if (ph instanceof THREE.Mesh) {
                      const placeholderMaterials = Array.isArray(ph.material)
                        ? ph.material
                        : [ph.material];
                      placeholderMaterials.forEach((material) => {
                        material.opacity = 1 - t;
                        material.needsUpdate = true;
                      });
                    }
                    if (t < 1) requestAnimationFrame(step);
                    else {
                      restoreAuthoredMaterials(fadeMats, authoredMats);
                      try {
                        ph.visible = false;
                      } catch {
                        /* ignore */
                      }
                    }
                  };
                  requestAnimationFrame(step);
                });
                // Re-pack the freshly placed clones into instanced draws
                // (static props only — see collapseClonesToInstances).
                // NEVER collapse an animated model: the mixers created above
                // are bound to the individual clones, and collapsing would
                // detach them — freezing the pose while the mixer keeps
                // ticking and pinning every clone alive for the session.
                if (options.collapseToInstances && animations.length === 0) {
                  try {
                    const n = collapseClonesToInstances(
                      placedClones,
                      base.replace(/\.(glb|gltf)$/i, '_'),
                    );
                    if (n > 0) {
                      console.log(
                        `🔦 ${placedClones.length} ${base} clones collapsed into ${n} instanced draw(s)`,
                      );
                    }
                  } catch (e) {
                    console.warn('[Island] instance collapse skipped:', e);
                  }
                }
                // The authored model is in: let the caller retire whatever
                // procedural stand-in it just superseded.
                try {
                  options.onReplaced?.(placeholders.length);
                } catch {
                  /* a fallback that refuses to hide is not fatal */
                }
              },
              undefined,
              () => {
                // on error, try next candidate
                const next = idx + 1;
                if (next < tryList.length) tryLoadAt(next);
              },
            );
          };
          tryLoadAt(0);
        } catch {
          /* loader not available */
        }
      };

      // Replace benches, mailboxes, signs, cars, lamps
      // Provide fallback candidate paths under assetKits folders so models shipped inside assetKits are discoverable
      const ak = '/assetKits';
      loadAndReplace(basePath + 'bench.glb', 'bench_', {
        scale: 1,
        candidates: [
          ak + '/Fantasy Props MegaKit[Standard]/Exports/glTF/Bench.gltf',
          ak + '/Fantasy Props MegaKit[Standard]/Exports/glTF/Chair_1.gltf',
        ],
        randomYaw: true,
        heightOffset: -0.03,
        scaleJitter: 0.2,
        // MEASURED on prod: 11 clones / 22 meshes sharing just 2
        // geometry+material pairs. Per-clone yaw and scale jitter ride in the
        // instance matrix. The bench_<i> ANCHORS carry the sit interaction
        // (benchGroups is read-only — distance checks, never moved), so the
        // clones are pure visuals.
        collapseToInstances: true,
      });
      loadAndReplace(basePath + 'mailbox.glb', 'mailbox_', {
        scale: 1,
        randomYaw: true,
        heightOffset: -0.02,
        // Decorative roadside mailboxes only. The QUEST mailboxes are a
        // different population entirely — `new Mailbox()` groups added to
        // GameScene, unnamed, outside island.mesh — so wiggleMailbox (the one
        // thing that animates a mailbox) can never touch these clones.
        collapseToInstances: true,
      });
      // Cars stay PROCEDURAL now: they're drivable vehicles whose wheels the
      // driving code spins/steers, and GameScene moves the car_N group. The
      // GLB replacement hid the procedural car and dropped a STATIC mesh on
      // top — so a driven car appeared to stay parked while the rider drove
      // off. (car.glb replacement removed.)
      // 'lamp_' (with the underscore), NOT 'lamp': a bare prefix also matched
      // the instanced fallback fleet, which the loader then treated as two
      // more placeholders — hiding the fleet, zeroing its shared materials
      // and dropping two junk lamp.glb clones at the planet core.
      loadAndReplace(basePath + 'lamp.glb', 'lamp_', {
        scale: 1,
        candidates: [ak + '/Fantasy Props MegaKit[Standard]/Exports/glTF/Lantern_Wall.gltf'],
        heightOffset: -0.04,
        randomYaw: true,
        // 57 identical static clones = 114 draws of the same two buffers.
        // They never move, animate or hide individually (the anchors carry
        // the colliders and light pools), so they re-pack into 2 draws.
        collapseToInstances: true,
        // The authored lamps ARE the lamps now — retire the fallback fleet
        // (one flag each, materials untouched, so a failed load keeps it).
        onReplaced: () => {
          for (const m of this.lampFleet) m.visible = false;
        },
      });
      // Houses and towers stay PROCEDURAL. house.glb used to replace both
      // the village cottages and the office placeholders, but it renders
      // with an oversized detached roof, bare support posts, and floating
      // chimney segments — the procedural cottage (warm walls, person-sized
      // door, teal windows) is the approved look for every house.

      // For NPCs we want an NPC wrapper that handles mixer and simple AI. Use a specialized loader callback.
      try {
        const npcCandidates = [
          basePath + 'npc.glb',
          '/assetKits/Universal Base Characters[Standard]/glTF/npc.gltf',
          '/assetKits/Fantasy Props MegaKit[Standard]/Exports/glTF/npc.gltf',
        ];
        const tryNpc = (idx = 0) => {
          if (idx >= npcCandidates.length) return;
          loader.load(
            npcCandidates[idx],
            (gltf: GLTF) => {
              const model = gltf.scene || gltf.scenes?.[0];
              const animations = gltf.animations || [];
              if (!model) {
                // try next candidate
                tryNpc(idx + 1);
                return;
              }
              const placeholders = findPlaceholders('npc_placeholder_');
              placeholders.forEach((ph) => {
                try {
                  const pos = ph.position.clone();
                  const quat = ph.quaternion.clone();
                  const baseScale = 0.6;
                  // allow manifest override scale
                  const overrides = modelOverrides['npc.glb'] ?? modelOverrides['npc.gltf'];
                  const scale = typeof overrides?.scale === 'number' ? overrides.scale : baseScale;
                  // create an NPC instance which clones the provided model internally
                  const npc = new NPC(
                    model,
                    animations,
                    pos,
                    quat,
                    scale,
                    this.center,
                    this.radius,
                    (d: THREE.Vector3) => this.sampleSurfaceByDirection(d, 0).position.length(),
                  );
                  this.npcInstances.push(npc);
                  // add NPC group to the same parent as placeholder
                  const parent = ph.parent || this.mesh;
                  parent.add(npc.group);
                  // fade placeholder out and leave NPC visible
                  try {
                    ph.visible = false;
                  } catch {
                    /* ignore */
                  }
                  // (The old "35% of NPCs patrol between two points" setup is
                  // gone with NPC.update(): GameScene's activity schedule is
                  // the single source of where a villager goes.)
                  // update the npcTarget meshRef to point at the GLTF group
                  try {
                    const phIdx = parseInt(ph.name.replace('npc_placeholder_', ''), 10);
                    if (phIdx >= 0 && phIdx < this.npcTargets.length) {
                      this.npcTargets[phIdx].meshRef = npc.group;
                      this.npcTargets[phIdx].position = pos.clone();
                      // Variety + faces + persona flair (colors, eyes, hair, props)
                      this.dressNpc(npc.group, phIdx, this.npcTargets[phIdx].name);
                    }
                    npc.group.name = 'villager';
                  } catch {
                    /* ignore userData attachment issues */
                  }
                } catch {
                  /* ignore placeholder replacement issues */
                }
              });
            },
            undefined,
            () => {
              tryNpc(idx + 1);
            },
          );
        };
        tryNpc(0);
      } catch {
        /* NPC assets missing */
      }

      // Trees: replace instanced trunks/foliage with model clones if tree model exists
      try {
        const treeCandidates = [
          basePath + 'tree.glb',
          '/assetKits/Stylized Nature MegaKit[Standard]/glTF/CommonTree_1.gltf',
          '/assetKits/Stylized Nature MegaKit[Standard]/glTF/CommonTree_2.gltf',
          '/assetKits/Stylized Nature MegaKit[Standard]/glTF/CommonTree_3.gltf',
        ];
        const tryTree = (idx = 0) => {
          if (idx >= treeCandidates.length) return;
          loader.load(
            treeCandidates[idx],
            (gltf: GLTF) => {
              const model = gltf.scene || gltf.scenes?.[0];
              if (!model) {
                tryTree(idx + 1);
                return;
              }
              const overrides = modelOverrides['tree.glb'] ?? modelOverrides['tree.gltf'];
              // Same snapshot the other loader takes — the tree fade below
              // has the identical prepareClone start state.
              const authoredTreeMats = snapshotAuthoredMaterials(model);
              // remove instanced meshes (if present)
              const toRemove: THREE.Object3D[] = [];
              this.mesh.traverse((object) => {
                if (
                  object.name &&
                  /trees_trunk_instanced|trees_foliage_instanced/.test(object.name)
                ) {
                  toRemove.push(object);
                }
              });
              toRemove.forEach((object) => {
                // Detaching alone leaked the procedural trees' geometry,
                // materials AND instanceMatrix — nothing else references
                // them once they are out of the graph.
                const m = object as THREE.Mesh;
                m.geometry?.dispose?.();
                const mat = m.material;
                if (Array.isArray(mat)) mat.forEach((x) => this.disposeMaterial(x));
                else if (mat) this.disposeMaterial(mat);
                const inst = object as THREE.InstancedMesh;
                if (inst.isInstancedMesh) inst.dispose();
                if (object.parent) object.parent.remove(object);
              });
              // Trees: even golden-spiral spread through the shared spacing
              // registry, grounded with sunk roots. The old code put 48 trees
              // on a flat equatorial ring (y=0, unregistered -> giant merged
              // groves) floating 0.55-1.25u above the terrain.
              // ORCHARD [z1..z2] north grove, FOREST [z4..z0] both sides,
              // SOUTH WOOD off-belt, plus singles
              // Island-only world: every site sits above the shoreline
              // (lat >= 0.3) — the old south wood / forest south rows are
              // open ocean now, so they moved to the island's mid-slopes.
              const TREE_SITES: Array<[number, number]> = [
                // orchard rows (west slope)
                [1.45, 0.32],
                [1.62, 0.32],
                [1.79, 0.32],
                [1.96, 0.32],
                [1.53, 0.44],
                [1.7, 0.44],
                [1.87, 0.44],
                // forest segment (two bands up the eastern slope)
                [5.25, 0.34],
                [5.45, 0.3],
                [5.65, 0.36],
                [5.85, 0.3],
                [5.35, 0.55],
                [5.55, 0.62],
                [5.75, 0.52],
                [5.95, 0.6],
                [6.1, 0.38],
                // high wood (upland between Personal and Projects)
                [2.0, 0.78],
                [2.2, 0.88],
                [2.4, 0.76],
                [2.15, 0.65],
                // scattered singles
                [0.5, 0.55],
                [1.3, 0.85],
                [3.3, 0.42],
                [4.3, 0.72],
                [4.75, 0.35],
                [0.05, 0.92],
              ];
              const treeCount = TREE_SITES.length;
              for (let i = 0; i < treeCount; i++) {
                const [tLon, tLat] = TREE_SITES[i];
                const dir = this.claimDir(this.dirAt(tLon, tLat), this.arc(3.5));
                const p = dir.clone().multiplyScalar(this.radius);
                const usedScale = 0.6 + Math.random() * 0.22; // 3.4-4.6u tall — planet-scale trees
                const copy = prepareClone(model, usedScale, overrides);
                try {
                  this.placeObjectOnSurface(copy, p.clone(), -0.07, true);
                } catch {
                  /* ignore placement */
                }
                // Farm-rule seat on top of the centre placement: drop to the
                // LOWEST ground on a 0.5u ring minus 0.18 — centre-seated GLB
                // trees hung their downhill roots mid-air on slopes (and the
                // audit caught one floating +0.21 outright). The model's root
                // flare is authored to bury, so the extra sink is free.
                const treeDir = copy.position.clone().normalize();
                copy.position.setLength(
                  Math.min(copy.position.length(), this.ringMinRadius(treeDir, 0.5)) - 0.18,
                );
                // Trees grow RADIALLY, never tilted with the slope (same
                // playtest-locked rule as the procedural family): override
                // the placement's surface-normal alignment with straight-up,
                // plus a random yaw so the one model doesn't march in step.
                // (Safe random: this async loop already lands after
                // restoreRandom — usedScale above draws from the same clock.)
                copy.quaternion
                  .setFromUnitVectors(new THREE.Vector3(0, 1, 0), treeDir)
                  .multiply(
                    new THREE.Quaternion().setFromAxisAngle(
                      new THREE.Vector3(0, 1, 0),
                      Math.random() * Math.PI * 2,
                    ),
                  );
                this.mesh.add(copy);
                // These trees land after GameScene's collider registration —
                // queue a trunk collider for it to drain (canopy stays
                // walk-under, same as the procedural trees)
                this.pendingColliders.push({ position: copy.position.clone(), radius: 0.35 });
                // If tree model contains animations (rare), add mixer
                try {
                  const animations = gltf.animations || [];
                  if (animations && animations.length) {
                    const mixer = new THREE.AnimationMixer(copy);
                    const clip = animations[0];
                    const action = mixer.clipAction(clip);
                    action.reset();
                    action.play();
                    this.animationMixers.push(mixer);
                  }
                } catch {}
                // quick fade-in
                const duration = 800;
                const start = performance.now();
                const treeFadeMats = collectFadeMaterials(copy);
                const step = () => {
                  const now = performance.now();
                  const t = Math.min(1, (now - start) / duration);
                  for (const material of treeFadeMats) {
                    material.opacity = t;
                    if (t < 1) material.transparent = true;
                    material.needsUpdate = true;
                  }
                  if (t < 1) requestAnimationFrame(step);
                  // This branch did not exist: the tree fade never handed the
                  // materials back, so every GLB tree (4 DOUBLE-SIDED leaf/
                  // trunk materials) stayed in the sorted transparent pass
                  // for the whole session — the same leak the other loader
                  // had, on the worse geometry.
                  else restoreAuthoredMaterials(treeFadeMats, authoredTreeMats);
                };
                requestAnimationFrame(step);
              }
            },
            undefined,
            () => {
              tryTree(idx + 1);
            },
          );
        };
        tryTree(0);
      } catch {
        /* tree assets missing */
      }
    } catch {
      // GLTFLoader not available or model loading failed; leave placeholders
      return;
    }
  }

  public getCenter(): THREE.Vector3 {
    return this.center.clone();
  }

  public getSurfaceNormal(position: THREE.Vector3): THREE.Vector3 {
    return position.clone().sub(this.center).normalize();
  }

  public getSurfacePosition(direction: THREE.Vector3): THREE.Vector3 {
    return this.center.clone().add(direction.clone().normalize().multiplyScalar(this.radius));
  }

  public getRadius(): number {
    return this.radius;
  }

  /**
   * Highest possible terrain point — the createIsland() displacement clamp.
   * ANYTHING that asks "is this above/near the terrain?" (camera-proximity
   * gates, sampler ray starts, prop seating headroom) must derive from this,
   * not from a literal: two shipped bugs (camNear +6, sampler ray +5.5) were
   * exactly such literals going stale when relief scaled with the radius.
   */
  public maxTerrainRadius(): number {
    return this.radius + Island.MAX_DISPLACEMENT * this.reliefScale;
  }

  /**
   * The displaced terrain mesh (for external raycasts, e.g. camera collision).
   */
  public getSurfaceMesh(): THREE.Mesh | undefined {
    return this.surfaceMesh;
  }

  /**
   * Public wrapper to sample the displaced surface given a direction vector (world-space).
   * Returns an object with { position, normal } so callers can place markers accurately.
   */
  public sampleSurfaceByDirection(
    direction: THREE.Vector3,
    desiredOffset: number = 0,
  ): { position: THREE.Vector3; normal: THREE.Vector3 } {
    const dir = direction.clone().normalize();

    // If we have the mesh, use it - otherwise approximate
    if (this.surfaceMesh) {
      try {
        this.surfaceMesh.updateMatrixWorld(true);
        // Cast from OUTSIDE inward so we hit front faces (material.side = FrontSide).
        // Casting from center outward only sees backfaces and always misses.
        // Must exceed the tallest possible terrain (the maxRadius clamp in
        // createIsland), or the ray STARTS INSIDE a peak and misses it — the
        // sampler then silently returns a fallback, which broke placement,
        // NPC walking and grounding shadows on the highland summits.
        const maxDisp = Island.SAMPLE_RAY_DISP * this.reliefScale;
        const startPos = this.center
          .clone()
          .add(dir.clone().multiplyScalar(this.radius + maxDisp + 1));
        const inwardDir = this.center.clone().sub(startPos).normalize();
        const raycaster = new THREE.Raycaster(startPos, inwardDir, 0, maxDisp + 3 + this.radius);
        raycaster.firstHitOnly = true; // BVH fast-path: we only use hits[0]
        const hits = raycaster.intersectObject(this.surfaceMesh, false);

        if (hits && hits.length > 0) {
          const hit = hits[0];
          const hitPoint = hit.point.clone();

          // Use face normal from THREE.js Raycaster - this is already in world space
          let normal = hit.face ? hit.face.normal.clone() : dir.clone();

          // If we got a face, transform its normal to world space
          if (hit.face && hit.object && hit.object.matrixWorld) {
            const m = new THREE.Matrix3().getNormalMatrix(hit.object.matrixWorld);
            normal = hit.face.normal.clone().applyMatrix3(m).normalize();
          }

          // Ensure normal points outward from center
          const toHit = hitPoint.clone().sub(this.center);
          if (normal.dot(toHit) < 0) {
            normal.negate();
          }
          normal.normalize();

          // Clamp tilt away from radial "up" (see sampleSurfacePosition —
          // same 0.21→0.42 raise, both clamps must always match)
          {
            const radial = toHit.clone().normalize();
            const MAX_TILT = 0.42;
            const tilt = radial.angleTo(normal);
            if (tilt > MAX_TILT) {
              const axis = new THREE.Vector3().crossVectors(radial, normal);
              normal =
                axis.lengthSq() > 1e-10
                  ? radial.clone().applyAxisAngle(axis.normalize(), MAX_TILT).normalize()
                  : radial;
            }
          }

          // Apply offset along normal
          const finalPos = hitPoint.clone().add(normal.clone().multiplyScalar(desiredOffset));
          return { position: finalPos, normal };
        }
      } catch {
        // Silently fail and use fallback
      }
    }

    // Fallback: simple sphere approximation with offset
    const spherePoint = this.center.clone().add(dir.clone().multiplyScalar(this.radius));
    return {
      position: spherePoint.clone().add(dir.clone().multiplyScalar(desiredOffset)),
      normal: dir,
    };
  }

  /**
   * Place an object on the island surface near an approximate position.
   * This will sample the displaced terrain, set object.position and optionally
   * align object.up to the surface normal (by setting quaternion). Returns the sampled info.
   */
  private placeObjectOnSurface(
    obj: THREE.Object3D,
    approxPos: THREE.Vector3,
    desiredOffset: number = 0,
    alignToNormal: boolean = true,
  ): { position: THREE.Vector3; normal: THREE.Vector3 } {
    try {
      const sampled = this.sampleSurfacePosition(approxPos, desiredOffset);
      obj.position.copy(sampled.position);
      if (alignToNormal) {
        const q = new THREE.Quaternion().setFromUnitVectors(
          new THREE.Vector3(0, 1, 0),
          sampled.normal,
        );
        obj.quaternion.copy(q);
      }
      return sampled;
    } catch {
      // fallback radial math
      const normal = approxPos.clone().normalize();
      const pos = this.center.clone().add(normal.multiplyScalar(this.radius + desiredOffset));
      obj.position.copy(pos);
      if (alignToNormal)
        obj.quaternion.copy(
          new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), normal),
        );
      return { position: pos, normal };
    }
  }

  // Expose NPC instances so other systems (Engine, InteractionSystem) can register or query them.
  // Readonly VIEW, not a copy: the only call site (GameScene's per-frame NPC
  // shadow pass) re-fetched a fresh .slice() every frame. The readonly type
  // keeps the mutation guard at compile time; dispose()'s array reassignment
  // stays safe because callers re-fetch each frame.
  public getNPCInstances(): readonly NPC[] {
    return this.npcInstances;
  }

  public addToScene(scene: THREE.Scene): void {
    scene.add(this.mesh);
  }

  // NOTE: the old Island.update() per-frame animation method was DELETED
  // (2026-08-16). It was dead code — no call site existed; GameScene drives
  // grassTimeUniform / seaTimeUniform / updateTide directly — and it carried
  // a landmine: a hard lamp on/off blink (`visible = isNight && sin(t*3) >
  // -0.5`) keyed to `time % 24` where time was SECONDS SINCE PAGE LOAD, so
  // reviving it would set every lamp in town strobing on a ~2s cycle with no
  // reduced-motion gate. Two lessons it recorded live on:
  //   - NPC transforms have a SINGLE owner (GameScene's wander loop). The
  //     old second writer here is why townsfolk twitched and pushed into
  //     walls; NPC instances survive only as group/mixer holders
  //     (see getNPCInstances).
  //   - animationMixers are still collected for disposal (see dispose()).

  /**
   * Cleanup method to dispose all Three.js resources (geometries, materials, textures).
   * Call this when tearing down the island or on hot reload to prevent memory leaks.
   */
  public dispose(): void {
    // Dispose all geometries, materials, and textures in the mesh hierarchy
    this.mesh.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        if (obj.geometry) {
          obj.geometry.dispose();
        }

        const material = obj.material;
        if (Array.isArray(material)) {
          material.forEach((mat) => this.disposeMaterial(mat));
        } else if (material) {
          this.disposeMaterial(material);
        }
        // InstancedMesh also owns a GPU instanceMatrix buffer that the
        // geometry/material disposal above does NOT release (lamps, grass,
        // rocks, flowers all land here).
        const inst = obj as THREE.InstancedMesh;
        if (inst.isInstancedMesh) inst.dispose();
      }
    });

    // Stop all animation mixers
    this.animationMixers.forEach((mixer) => {
      try {
        mixer.stopAllAction();
      } catch {
        /* ignore mixer cleanup issues */
      }
    });
    this.animationMixers = [];

    // Dispose NPC instances
    this.npcInstances.forEach((npc) => {
      try {
        const maybeDisposable = npc as { dispose?: () => void };
        maybeDisposable.dispose?.();
      } catch {
        /* ignore NPC cleanup issues */
      }
    });
    this.npcInstances = [];

    // Remove mesh from parent if attached
    if (this.mesh.parent) {
      this.mesh.parent.remove(this.mesh);
    }

    // Clear surface mesh reference
    this.surfaceMesh = undefined;
  }

  /**
   * Helper method to dispose a material and its textures
   */
  private disposeMaterial(material: THREE.Material): void {
    // Dispose all textures in the material
    const materialWithMaps = material as MaterialWithTextureProps;
    materialWithMaps.map?.dispose();
    materialWithMaps.normalMap?.dispose();
    materialWithMaps.roughnessMap?.dispose();
    materialWithMaps.metalnessMap?.dispose();
    materialWithMaps.aoMap?.dispose();
    materialWithMaps.emissiveMap?.dispose();
    materialWithMaps.bumpMap?.dispose();
    materialWithMaps.displacementMap?.dispose();
    materialWithMaps.alphaMap?.dispose();
    materialWithMaps.envMap?.dispose();

    // Dispose the material itself
    material.dispose();
  }
}
