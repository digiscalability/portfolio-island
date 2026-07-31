import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { GLTF, GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';

// Accelerate terrain raycasts with a bounds tree (BVH). The island surface is a
// ~32k-triangle sphere that gets raycast thousands of times at boot (prop / path
// / shadow placement) and every frame (player grounding, camera collision).
// Plain intersectObject is O(triangles) per ray; a BVH makes it O(log n) with
// IDENTICAL hit results. Patched onto THREE's prototypes once — meshes without a
// boundsTree are unaffected (acceleratedRaycast falls back to the stock raycast).
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

import { Materials } from './Materials';
import { SimpleRenderer } from './SimpleRenderer';
import { isRealTheme } from './Theme';
import { RING_DISTRICT_LONS, ZONE_LAT, DISTRICT_SHIFT } from './Districts';
import { NPC } from './NPC';
import TextureGenerator from './TextureGenerator';

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
  public npcTargets: Array<{ position: THREE.Vector3; name: string; dialogue: string[]; meshRef: THREE.Object3D }> = [];
  // Sampled sites exposed for GameScene's ambient life (butterflies, smoke)
  public flowerSites: THREE.Vector3[] = [];
  public chimneySites: Array<{ position: THREE.Vector3; normal: THREE.Vector3 }> = [];
  // Colliders for props placed ASYNCHRONOUSLY (GLB loads finish after
  // GameScene's registration pass) — GameScene drains this each frame
  public pendingColliders: Array<{ position: THREE.Vector3; radius: number }> = [];
  // Shared time uniform driving the grass wind vertex shader
  public grassTimeUniform: { value: number } = { value: 0 };
  // Player position (island-local == world, the root sits at origin) for the
  // grass push-aside shader. Default at planet centre → every blade is ~radius
  // away → zero push until someone wires setGrassPlayerPosition.
  public grassPlayerUniform: { value: THREE.Vector3 } = { value: new THREE.Vector3() };
  // Sky-horizon colour for the sea's fresnel reflection. Defaults to the day
  // horizon blue; bindSeaSkyColor swaps in EnvironmentCycle's live Color so
  // the water tracks dusk/night with zero per-frame plumbing.
  public seaSkyHorizonUniform: { value: THREE.Color } = { value: new THREE.Color(0x79b7e6) };
  // Shared time uniform driving the sea wave vertex shader
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
  private grassMesh?: THREE.InstancedMesh;
  private grassFullCount = 0;
  // Radial water-surface offset above the base radius (matches the sea mesh).
  // Land sits >= base+0.3 (continent mask floor); the calm surface at +0.1
  // with wave crests to +0.25 stays just under the beach so waves lap the
  // shore without flooding the districts.
  public static readonly SEA_OFFSET = 0.1;
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
    if (!this.grassMesh || !this.grassFullCount) return;
    const f = THREE.MathUtils.clamp(fraction, 0.25, 1);
    this.grassMesh.count = Math.max(1, Math.round(this.grassFullCount * f));
  }

  /** Per-frame: copy the player's world position into the grass push uniform
   *  (island-local == world — the root group sits at origin). No allocation. */
  public setGrassPlayerPosition(pos: THREE.Vector3): void {
    this.grassPlayerUniform.value.copy(pos);
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
   * Surface sample WITHOUT a raycast — ~200x cheaper than
   * sampleSurfaceByDirection (measured 1.24ms per raycast against the 32k-tri
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
    const n = dir.clone().normalize();
    if (!this.terrainRadiusFor) {
      const s = this.sampleSurfaceByDirection(n, 0);
      return { radius: s.position.length(), normal: s.normal };
    }
    const at = (d: THREE.Vector3): number =>
      this.terrainRadiusFor(d, d.clone().multiplyScalar(this.radius));
    const r = at(n);
    const t1 = new THREE.Vector3(0, 1, 0).cross(n);
    if (t1.lengthSq() < 1e-8) t1.set(1, 0, 0);
    t1.normalize();
    const t2 = new THREE.Vector3().crossVectors(n, t1).normalize();
    const EPS = 0.02;
    const pA = n.clone().addScaledVector(t1, EPS).normalize();
    const pB = n.clone().addScaledVector(t2, EPS).normalize();
    const p0 = n.clone().multiplyScalar(r);
    const vA = pA.multiplyScalar(at(pA)).sub(p0);
    const vB = pB.multiplyScalar(at(pB)).sub(p0);
    const normal = new THREE.Vector3().crossVectors(vA, vB).normalize();
    if (normal.dot(n) < 0) normal.negate();
    if (!Number.isFinite(normal.x)) normal.copy(n);
    return { radius: r, normal };
  }

  private createGrass(): THREE.InstancedMesh {
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
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geo.computeVertexNormals();

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
          gradientMap: Materials.createGradientMap(),
        });
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = this.grassTimeUniform;
      shader.uniforms.uPlayerPos = this.grassPlayerUniform;
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          '#include <common>\nuniform float uTime;\nuniform vec3 uPlayerPos;',
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
            `  transformed.x += gBend * gGust * 0.026 * (position.y / ${BLADE_H});`,
            // Player push: bend away within ~1.2u. `transformed` is blade-local
            // (instanceMatrix applies later), so rotate the world-space "away"
            // into the blade frame — transpose ≈ inverse for the rotation part;
            // the instance scale only jitters the radius by ±20%, fine.
            '  vec3 gAway = transpose(mat3(instanceMatrix)) * (instanceMatrix[3].xyz - uPlayerPos);',
            '  float gPush = max(0.0, 1.0 - length(gAway) / 1.2);',
            `  transformed.xz += normalize(gAway.xz + vec2(1e-4)) * (gPush * gPush * 0.18) * (position.y / ${BLADE_H});`,
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
    const COUNT = lowTier ? 16000 : 44000; // scaled up for the larger R=30 surface so the meadow doesn't thin out
    const grass = new THREE.InstancedMesh(geo, mat, COUNT);
    const dummy = new THREE.Object3D();
    const up = new THREE.Vector3(0, 1, 0);
    const golden = Math.PI * (3 - Math.sqrt(5));
    const dir = new THREE.Vector3();
    // Sit close to the terrain's own meadow green (0x8cc06e) so the blades
    // blend into the ground instead of stippling dark dots across it.
    const GRASS_DRY = new THREE.Color(0xc6cc80);
    const GRASS_LUSH = new THREE.Color(0x74b25c);
    const bladeColor = new THREE.Color();
    // Slot order matters: setGrassBudget trims to a PREFIX of instance slots,
    // and the spiral index sweeps latitude pole→pole (then mirrors), so a raw
    // prefix would strip everything below a latitude line. Visiting spiral
    // indices with a stride coprime to COUNT equidistributes them, so any
    // prefix of slots is a uniform sample of the island.
    const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
    let stride = Math.max(1, Math.round(COUNT * 0.618));
    while (gcd(stride, COUNT) !== 1) stride++;
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
      // Analytic, not raycast: at 1.24ms per raycast these 6000 blades alone
      // cost ~7.5s of startup — the single biggest item in a ~24s boot, which
      // was tripping the 25s watchdog and showing the fallback on phones.
      const sampled = this.analyticSurface(dir);
      dummy.position.copy(dir).multiplyScalar(sampled.radius);
      dummy.quaternion.setFromUnitVectors(up, sampled.normal);
      dummy.rotateOnAxis(up, Math.random() * Math.PI * 2);
      // Blades landing on pavement collapse to nothing (instance count
      // stays fixed — no index bookkeeping); below the shoreline they
      // collapse too so the beach stays sandy-clean
      const belowShore = dir.y < Math.sin(0.26);
      // Slope gate. Measured: the analytic normal tracks the mesh to ~2.7°
      // on ordinary ground but diverges up to ~50° on the mountain crags,
      // where ~2.9-unit rock detail is finer than the 1.08-unit terrain mesh
      // can represent — so blades there were orienting to a surface that
      // isn't the one you see, and leaning wildly. Lawn doesn't grow on
      // cliffs regardless, so collapse the blade past a slope threshold:
      // correct orientation everywhere it does appear, and none where the
      // normal can't be trusted.
      const slopeCos = sampled.normal.dot(dir);
      const tooSteep = slopeCos < 0.86; // ~31 degrees
      // Keep the blades off the summit dirt track so it reads as bare earth.
      const onTrail = this.trailAt ? this.trailAt(dir).w > 0.4 : false;
      const sc =
        this.isNearStreet(dir) || belowShore || tooSteep || onTrail
          ? 0.0001
          : 0.85 + Math.random() * 0.4;
      dummy.scale.set(sc, sc, sc);
      dummy.updateMatrix();
      grass.setMatrixAt(k, dummy.matrix);
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
      // subtle per-blade brightness so neighbours never match exactly
      const shade = 0.86 + Math.random() * 0.28;
      grass.setColorAt(k, bladeColor.multiplyScalar(shade));
    }
    if (grass.instanceColor) grass.instanceColor.needsUpdate = true;
    grass.instanceMatrix.needsUpdate = true;
    grass.name = 'grass';
    grass.castShadow = false;
    // Coarse tier: 12k DoubleSide blades sampling the shadow map for shadows
    // nobody can see at phone DPR — skip the receive entirely there.
    grass.receiveShadow = !lowTier;
    const grassData = grass.userData as Record<string, unknown>;
    grassData.ignoreOcclusion = true;
    this.grassMesh = grass;
    this.grassFullCount = COUNT;
    return grass;
  }

  private createIsland(): THREE.Group {
    // Use a sphere geometry for the island surface so objects placed on the sphere align correctly.
    const seg = 176; // was 128; scaled with radius (30) to hold ~1.07u vertex spacing so crag/terrain detail still resolves
    const geometry = new THREE.SphereGeometry(this.radius, seg, seg);
    // Displace vertices along their normals to create varied hills and valleys on the sphere surface.
    const vertices = geometry.attributes.position.array as Float32Array;
    const v = new THREE.Vector3();

    // Simple Perlin-like noise function for more organic terrain
    const noise3D = (x: number, y: number, z: number, scale: number) => {
      const sx = Math.sin(x * scale) * Math.cos(z * scale);
      const sy = Math.sin(y * scale) * Math.cos(x * scale);
      const sz = Math.sin(z * scale) * Math.cos(y * scale);
      return (sx + sy + sz) / 3;
    };

    // Enhanced multi-octave noise for more natural terrain
    const multiOctaveNoise = (x: number, y: number, z: number) => {
      let total = 0;
      let frequency = 1.0;
      let amplitude = 1.0;
      let maxValue = 0;

      // 4 octaves for rich detail
      for (let i = 0; i < 4; i++) {
        total += noise3D(x, y, z, 0.08 * frequency) * amplitude;
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
      const ang = Math.acos(THREE.MathUtils.clamp(normal.dot(trailUp), -1, 1));
      trailInfo.w = 0;
      trailInfo.t = 1;
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
      for (const p of PEAKS) {
        // Angular distance on the sphere, so the falloff is geodesic
        const ang = Math.acos(THREE.MathUtils.clamp(normal.dot(p.dir), -1, 1));
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
    const terrainRadiusFor = (normal: THREE.Vector3, v: THREE.Vector3): number => {
      // Enhanced terrain generation with better geographic features
      // Large-scale continents/mountains using multi-octave noise
      const largeTerrain = multiOctaveNoise(v.x, v.y, v.z) * 3.2;

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
      const coastWarp =
        noise3D(v.x, v.y, v.z, 0.16) * 0.105 + noise3D(v.x, v.y, v.z, 0.42) * 0.05;
      const shoreLo = 0.05 + coastWarp;
      const shoreHi = 0.28 + coastWarp;
      const shoreT = THREE.MathUtils.clamp((sinLat - shoreLo) / (shoreHi - shoreLo), 0, 1);
      const mask = shoreT * shoreT * (3 - 2 * shoreT); // smoothstep
      // Ridged noise on the flanks breaks the smooth dome into crags. Two
      // octaves, and the fine one is pitched near the mesh limit: at 128
      // segments on r=22 the vertex spacing is ~1.08 units, so features below
      // ~2.5 units can't be resolved. The old scale of 0.5 was a ~12.6-unit
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
      const rock = Math.max(noiseDisp, 0.75) + highland + crag;
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
      const displacement = oceanDisp + (landDisp - oceanDisp) * mask;

      // Clamp radius to prevent terrain from going inside the sphere
      const rawRadius = this.radius + displacement;
      const minRadius = this.radius * 0.86; // deep enough for the seafloor
      // Headroom for the highland range (base floor 0.75 + peak 3.3 + crag
      // ~1.65). At +4.2 the peaks clipped flat into a pale mesa. Keep this
      // BELOW the sampler's maxDisp or raycasts start inside the summits.
      // Headroom for the taller range: main peak 7.3 + floor 0.75 + crag ~0.8
      // ≈ 8.85. Kept below the sampler's ray start (radius + maxDisp 11), or
      // raycasts begin inside the summit and miss it.
      const maxRadius = this.radius + 9.2;
      return THREE.MathUtils.clamp(rawRadius, minRadius, maxRadius);
    };
    this.terrainRadiusFor = terrainRadiusFor;

    for (let i = 0; i < vertices.length; i += 3) {
      v.set(vertices[i], vertices[i + 1], vertices[i + 2]);
      const normal = v.clone().normalize();
      const newPos = normal.multiplyScalar(terrainRadiusFor(normal, v));
      vertices[i] = newPos.x;
      vertices[i + 1] = newPos.y;
      vertices[i + 2] = newPos.z;
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
          tmp.copy(seabed).lerp(sand, THREE.MathUtils.clamp((above + 2.4) / 2.1, 0, 1));
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
          const alt = THREE.MathUtils.clamp((above - snowLine) / Math.max(0.4, snowLine * 0.45), 0, 1);
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
      color: 0x1f6a9c,
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
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nuniform float uTime;\nuniform float uAmp;\nuniform float uTide;\nvarying float vWave;\nvarying vec2 vFoamUv;')
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
        .replace('#include <common>', '#include <common>\nvarying float vWave;\nvarying float vDepth;\nvarying vec2 vFoamUv;\nuniform float uTime;\nuniform float uTide;\nuniform vec3 uSkyHorizon;')
        .replace(
          '#include <color_fragment>',
          [
            '#include <color_fragment>',
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
            'float d = vDepth - uTide;',
            'float shallow = 1.0 - smoothstep(0.0, 5.0, d);',
            'diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.22,0.68,0.72), shallow*shallow*0.65);',
            'float edge = 1.0 - smoothstep(0.0, 3.2, d);',
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
            // A permanent wet band right at the waterline under the moving foam
            'foam = max(foam, (1.0 - smoothstep(0.0, 0.9, d)) * 0.8);',
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
              : 'outgoingLight = mix(outgoingLight, uSkyHorizon, fres * 0.55);',
            // Horizon haze: dissolve the distant sea into the LIVE sky-horizon
            // colour so the water no longer meets the sky as a hard line — the
            // single biggest "sells a world, not an object on a table" cue.
            // Distance-keyed so near water stays saturated. Applies to both themes.
            'float horizonHaze = smoothstep(18.0, 46.0, length(vViewPosition));',
            'outgoingLight = mix(outgoingLight, uSkyHorizon, horizonHaze * 0.75);',
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
    const seaSegs = SimpleRenderer.isLowTierDevice() ? 64 : 96;
    const seaGeo = new THREE.SphereGeometry(this.radius + Island.SEA_OFFSET, seaSegs, seaSegs);
    {
      const sp = seaGeo.attributes.position;
      const depth = new Float32Array(sp.count);
      const sn = new THREE.Vector3();
      const sv = new THREE.Vector3();
      const seaR = this.radius + Island.SEA_OFFSET;
      for (let i = 0; i < sp.count; i++) {
        sn.set(sp.getX(i), sp.getY(i), sp.getZ(i)).normalize();
        sv.copy(sn).multiplyScalar(this.radius); // noise domain = base radius
        depth[i] = seaR - this.terrainRadiusFor(sn, sv);
      }
      seaGeo.setAttribute('aDepth', new THREE.BufferAttribute(depth, 1));
    }
    const sea = new THREE.Mesh(seaGeo, seaMat);
    sea.name = 'sea';
    sea.receiveShadow = true;
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
    // Districts are evenly spaced on the cardinal points now (Districts.ts is the
    // single source of truth, shared with the zone markers + minimap). Each
    // district's hand-authored site arrays below add SHIFT_* so the buildings and
    // crowds move WITH their plaza + avenue under the respacing.
    const DISTRICT_LONS = RING_DISTRICT_LONS;
    const SHIFT_PROJECTS = DISTRICT_SHIFT[1];
    const SHIFT_PERSONAL = DISTRICT_SHIFT[2];
    const SHIFT_CONTACT = DISTRICT_SHIFT[3];
    const boulevardPts: THREE.Vector3[] = [];
    const BOULEVARD_SEGS = 84;
    for (let i = 0; i <= BOULEVARD_SEGS; i++) {
      boulevardPts.push(this.dirAt((i / BOULEVARD_SEGS) * Math.PI * 2, 0.4636));
    }
    pathGroup.add(this.createStreetPath(boulevardPts, 1.0));
    const coastalPts: THREE.Vector3[] = [];
    for (let i = 0; i <= BOULEVARD_SEGS; i++) {
      coastalPts.push(this.dirAt((i / BOULEVARD_SEGS) * Math.PI * 2, 0.28));
    }
    pathGroup.add(this.createStreetPath(coastalPts, 0.8));
    for (const dLon of DISTRICT_LONS) {
      // Avenue: pole plaza → district plaza
      const avenue: THREE.Vector3[] = [];
      for (let s = 0; s <= 12; s++) avenue.push(this.dirAt(dLon, 1.32 - (s / 12) * 0.82));
      pathGroup.add(this.createStreetPath(avenue, 0.8));
      // Connector: district plaza → coastal road
      const connector: THREE.Vector3[] = [];
      for (let s = 0; s <= 5; s++) connector.push(this.dirAt(dLon, 0.43 - (s / 5) * 0.15));
      pathGroup.add(this.createStreetPath(connector, 0.8));
    }

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
    for (const dLon of DISTRICT_LONS) this.claimDir(this.dirAt(dLon, ZONE_LAT), 0.13);
    this.claimDir(new THREE.Vector3(0, 1, 0), 0.13);
    // Reserve the coastal lighthouse footprint so trees/props keep clear of it.
    this.claimDir(this.dirAt(5.4, 0.34), 0.3);

    // Add a few low-poly buildings aligned to the surface (placeholders). We'll attempt to replace them with GLTF models if present.
    const buildings = new THREE.Group();
    // generate procedural building textures and use them for PBR-like facades
    const buildingTex = TextureGenerator.createBuildingTextures(512, 512);
    const buildingMat = Materials.createPBRMaterial({
      color: 0xd9c6b3,
      map: buildingTex.albedo,
      normalMap: buildingTex.normal,
      roughnessMap: buildingTex.roughness,
      aoMap: buildingTex.ao,
      roughness: 0.65,
      metalness: 0.02,
    });
    const buildingPlaceholders: THREE.Mesh[] = [];
    const buildingSamples: { position: THREE.Vector3; normal: THREE.Vector3 }[] = [];
    // PROFESSIONAL district: two office rows forming a street wall along
    // the boulevard (planned CBD blocks, not a ring). North row lat 0.64,
    // south row lat 0.29 — ±0.175 rad from the boulevard centerline leaves
    // pavement + sidewalk. Small claim arcs keep the rows exact.
    // Thinned from 8 → 4 towers (one per corner) and spread wider so the CBD
    // reads as a couple of blocks, not a wall — the island felt congested.
    const BUILDING_SITES: Array<[number, number]> = [
      [5.8, 0.64], [0.48, 0.64],
      [5.8, 0.29], [0.48, 0.29],
    ];
    for (let i = 0; i < BUILDING_SITES.length; i++) {
      const [lon, lat] = BUILDING_SITES[i];
      const dir = this.claimOffStreet(this.dirAt(lon, lat), 0.09);

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

      const q = new THREE.Quaternion().setFromUnitVectors(
        new THREE.Vector3(0, 1, 0),
        sampled.normal,
      );
      b.quaternion.copy(q);
      // Face the boulevard — each tower addresses the street, so the two
      // rows front each other across the pavement like a real CBD block
      this.faceObjectToward(b, sampled.normal, this.dirAt(lon, ZONE_LAT).multiplyScalar(this.radius));
      b.castShadow = true;
      b.receiveShadow = true;
      b.name = `building_placeholder_${i}`;
      buildings.add(b);
      buildingPlaceholders.push(b);
    }

    // Procedural houses: add a few more detailed block houses with roofs/windows to make the island feel inhabited
    const houses = new THREE.Group();
    const houseSamples: { position: THREE.Vector3; normal: THREE.Vector3 }[] = [];
    // PERSONAL district: a village street — two staggered cottage rows
    // flanking the boulevard (lat 0.66 / 0.27), garden gaps between lots,
    // rows offset in lon so no cottage stares straight into another.
    // Near-plaza columns keep ≥0.2 rad from the plaza claim.
    // Thinned from 8 → 6 cottages and spread wider (roomier village street).
    const HOUSE_SITES: Array<[number, number]> = [
      [2.08 + SHIFT_PERSONAL, 0.66], [2.52 + SHIFT_PERSONAL, 0.66], [2.96 + SHIFT_PERSONAL, 0.66],
      [2.06 + SHIFT_PERSONAL, 0.27], [2.54 + SHIFT_PERSONAL, 0.27], [3.0 + SHIFT_PERSONAL, 0.27],
    ];
    const houseCount = HOUSE_SITES.length;
    for (let i = 0; i < houseCount; i++) {
      const [lon, lat] = HOUSE_SITES[i];
      const dir = this.claimOffStreet(this.dirAt(lon, lat), 0.1);

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

      // align to surface
      const q = new THREE.Quaternion().setFromUnitVectors(
        new THREE.Vector3(0, 1, 0),
        sampled.normal,
      );
      house.quaternion.copy(q);
      // Front door faces the village street (nearest boulevard point)
      this.faceObjectToward(house, sampled.normal, this.dirAt(lon, ZONE_LAT).multiplyScalar(this.radius));
      house.position.copy(sampled.position);
      // Record the chimney tip (post-alignment) for GameScene's smoke puffs
      if (i % 2 === 0) {
        const chimneyTip = new THREE.Vector3(w * 0.25, h + 1.4, -d * 0.15)
          .applyQuaternion(house.quaternion)
          .add(house.position);
        this.chimneySites.push({ position: chimneyTip, normal: sampled.normal.clone() });
      }
      // Houses are already positioned by sampleSurfacePosition - no additional offset needed
      house.name = `house_${i}`;
      houses.add(house);
      // Add a small warm point light near the house to simulate local ambient warmth / light-probe
      const warmColor = 0xffd6a5;
      const light = new THREE.PointLight(warmColor, 0.55, 2.0, 2);
      // place the light slightly above the door/windows so it softly lights nearby surfaces
      light.position.set(0, h * 0.6, d * 0.35);
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
    const TREE_CANDIDATES = 232;
    const TREE_CAP = 78;
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
      const groveP = 0.36 + moist * 0.70 - Math.max(0, candidate.y - Math.sin(0.92)) * 1.7;
      if (Math.random() > groveP) continue; // a clearing
      const dir = this.claimDir(candidate, 0.07);
      if (dir.y < Math.sin(0.29)) continue;
      // No trees through the pavement — skip candidates on a street
      if (this.isNearStreet(dir)) continue;
      const sampled = this.sampleSurfaceByDirection(dir, 0.0);
      // Slope gate: no trees on cliff faces (mirrors the grass gate 60 lines
      // down) so trees stop growing on crags and accent the peaks instead.
      if (sampled.normal.dot(dir) < 0.84) continue;
      const q = new THREE.Quaternion().setFromUnitVectors(
        new THREE.Vector3(0, 1, 0),
        sampled.normal,
      );

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
      const fColor =
        treeType === 2
          ? PINE_COLOR
          : FOLIAGE_COLORS[Math.min(FOLIAGE_COLORS.length - 1, Math.floor(moist * FOLIAGE_COLORS.length))];
      const parts: THREE.BufferGeometry[] = [];
      const treeGroup = new THREE.Group();

      if (treeType <= 1) {
        // Round canopy tree — tapered trunk + clustered dodecahedrons
        bakePart(parts, new THREE.CylinderGeometry(0.04 * scale, 0.08 * scale, 0.6 * scale, 6),
          TRUNK_COLOR, [0, 0.3 * scale, 0]);
        bakePart(parts, new THREE.DodecahedronGeometry(0.35 * scale, 0),
          fColor, [0, 0.75 * scale, 0], [i * 0.7, i * 1.3, 0]);
        // 2-3 smaller satellite blobs for organic volume
        const blobCount = 2 + (i % 2);
        for (let b = 0; b < blobCount; b++) {
          const angle = (b / blobCount) * Math.PI * 2 + i;
          bakePart(parts, new THREE.DodecahedronGeometry(0.18 * scale, 0), fColor, [
            Math.cos(angle) * 0.2 * scale,
            0.7 * scale + (b === 0 ? 0.15 : -0.05) * scale,
            Math.sin(angle) * 0.2 * scale,
          ], [b * 1.1, b * 2.3, 0]);
        }
      } else if (treeType === 2) {
        // Pine/conifer — tall trunk + layered cone tiers (sharper, taller)
        bakePart(parts, new THREE.CylinderGeometry(0.03 * scale, 0.06 * scale, 0.8 * scale, 6),
          DARK_TRUNK_COLOR, [0, 0.4 * scale, 0]);
        for (let t = 0; t < 3; t++) {
          const tierScale = 1 - t * 0.22;
          bakePart(parts, new THREE.ConeGeometry(0.22 * scale * tierScale, 0.3 * scale, 6),
            PINE_COLOR, [0, (0.65 + t * 0.22) * scale, 0]);
        }
      } else {
        // Bushy shrub tree — short trunk, wide icosahedron canopy
        bakePart(parts, new THREE.CylinderGeometry(0.05 * scale, 0.07 * scale, 0.3 * scale, 5),
          TRUNK_COLOR, [0, 0.15 * scale, 0]);
        bakePart(parts, new THREE.IcosahedronGeometry(0.4 * scale, 0),
          fColor, [0, 0.5 * scale, 0], [0, i * 0.9, 0], [1.3, 0.8, 1.3]);
        // Small accent blob
        bakePart(parts, new THREE.DodecahedronGeometry(0.15 * scale, 0),
          fColor, [0.2 * scale, 0.55 * scale, 0.1 * scale]);
      }

      // Merge the tree's parts into one vertex-coloured mesh → one draw call
      const treeMesh = new THREE.Mesh(mergeGeometries(parts, false), treeMat);
      treeMesh.castShadow = true;
      treeGroup.add(treeMesh);

      treeGroup.position.copy(sampled.position);
      treeGroup.quaternion.copy(q);
      treeGroup.name = `tree_${placed}`;
      const treeData = treeGroup.userData as Record<string, unknown>;
      treeData.ignoreOcclusion = true;
      trees.add(treeGroup);
      placed++;
    }

    // Mailboxes: seed around homes/structures instead of a perfect orbit
    const mailboxes = new THREE.Group();
    const mailboxSources = houseSamples.length ? houseSamples : buildingSamples;
    const mailboxIndices = mailboxSources.map((_, idx) => idx);
    for (let i = mailboxIndices.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [mailboxIndices[i], mailboxIndices[j]] = [mailboxIndices[j], mailboxIndices[i]];
    }
    const mailboxCount = Math.min(6, mailboxIndices.length);
    for (let i = 0; i < mailboxCount; i++) {
      const sampled = mailboxSources[mailboxIndices[i]];
      if (!sampled) continue;
      // Put the mailbox at the ROADSIDE by the house: step ~2.6u toward the
      // nearest street (clears the ~2u-half-width house footprint so it never
      // sits inside the walls — the old 0.8-1.2u offset buried it in the house),
      // then slide off the pavement and claim the spot so it can't collide.
      const houseDir = sampled.position.clone().normalize();
      const street = this.nearestStreetDir(houseDir, 0.7);
      const tangent = new THREE.Vector3();
      if (street) tangent.copy(street).addScaledVector(houseDir, -street.dot(houseDir));
      if (tangent.lengthSq() < 1e-6) {
        tangent.crossVectors(sampled.normal, new THREE.Vector3(0, 1, 0));
        if (tangent.lengthSq() < 1e-6) tangent.set(1, 0, 0);
        tangent.applyAxisAngle(sampled.normal, Math.random() * Math.PI * 2);
      }
      tangent.normalize();
      let mbDir = houseDir.clone().addScaledVector(tangent, 2.6 / this.radius).normalize();
      mbDir = this.pushOffStreet(mbDir);
      mbDir = this.claimDir(mbDir, 0.05);
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
      const top = new THREE.Mesh(new THREE.SphereGeometry(0.09, 8, 4, 0, Math.PI * 2, 0, Math.PI / 2), boxMat);
      top.scale.set(1, 0.5, 0.67);
      top.position.y = 0.64;
      mb.add(top);
      // Flag
      const flag = new THREE.Mesh(
        new THREE.BoxGeometry(0.02, 0.08, 0.06),
        new THREE.MeshStandardMaterial({ color: 0xcc3333 }),
      );
      flag.position.set(0.1, 0.6, 0);
      mb.add(flag);
      mb.position.copy(placement.position);
      const q = new THREE.Quaternion().setFromUnitVectors(
        new THREE.Vector3(0, 1, 0),
        placement.normal,
      );
      mb.quaternion.copy(q);
      // Face the mailbox toward the road (a roadside mailbox addresses the street).
      if (street) {
        this.faceObjectToward(mb, placement.normal, street.clone().multiplyScalar(this.radius));
      } else {
        mb.quaternion.premultiply(
          new THREE.Quaternion().setFromAxisAngle(placement.normal, Math.random() * Math.PI * 2),
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
    const LAMP_SITES: Array<[number, number]> = [
      [0.28, 0.412], [0.91, 0.515], [1.54, 0.412], [2.17, 0.515], [2.80, 0.412],
      [3.43, 0.515], [4.06, 0.412], [4.71, 0.515], [5.34, 0.412], [5.97, 0.515],
    ];
    for (let i = 0; i < LAMP_SITES.length; i++) {
      // claimOffStreet, not claimDir: a couple of boulevard lamps landed on the
      // ribbon where an avenue meets the boulevard; this keeps them at the kerb.
      const pos = this.claimOffStreet(this.dirAt(LAMP_SITES[i][0], LAMP_SITES[i][1]), 0.05).multiplyScalar(this.radius);
      const sampled = this.sampleSurfacePosition(pos, 0.6);
      const lampGroup = new THREE.Group();
      lampGroup.name = `lamp_${i}`;
      const poleMat = Materials.createTrimMaterial(0x3a3a3a);
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.08, 1.6, 8), poleMat);
      pole.position.y = 0.8;
      pole.castShadow = true;
      lampGroup.add(pole);
      // Curved arm
      const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.5, 6), poleMat);
      arm.position.set(0.2, 1.55, 0);
      arm.rotation.z = -Math.PI / 4;
      lampGroup.add(arm);
      // Lamp shade (cone)
      const shade = new THREE.Mesh(
        new THREE.ConeGeometry(0.2, 0.15, 8),
        Materials.createTrimMaterial(0x2a2a2a),
      );
      shade.position.set(0.35, 1.55, 0);
      shade.rotation.z = Math.PI;
      shade.castShadow = true;
      lampGroup.add(shade);
      // Glowing bulb
      const bulb = new THREE.Mesh(
        new THREE.SphereGeometry(0.1, 8, 8),
        new THREE.MeshStandardMaterial({ color: 0xfff4cc, emissive: 0xffe8a0, emissiveIntensity: 0.8 }),
      );
      bulb.position.set(0.35, 1.48, 0);
      bulb.userData.isNightEmissive = true;
      lampGroup.add(bulb);
      // Real street-lamp height ~3.9u — was ~1.7u, the same height as the player.
      lampGroup.scale.setScalar(2.2);

      const q = new THREE.Quaternion().setFromUnitVectors(
        new THREE.Vector3(0, 1, 0),
        sampled.normal,
      );
      lampGroup.position.copy(sampled.position);
      lampGroup.quaternion.copy(q);
      // Swing the arm (local +X) out over the roadway: yaw +Z toward the
      // boulevard centerline, then back off 90° so +X takes its place
      this.faceObjectToward(
        lampGroup,
        sampled.normal,
        this.dirAt(LAMP_SITES[i][0], 0.4636).multiplyScalar(this.radius),
      );
      lampGroup.rotateOnAxis(new THREE.Vector3(0, 1, 0), -Math.PI / 2);
      const lampLight = new THREE.PointLight(0xffeeaa, 0.8, 3, 2);
      lampLight.position.set(0.35, 1.48, 0);
      lampLight.userData = { isLampLight: true };
      lampGroup.add(lampLight);
      lamps.add(lampGroup);
      lampPositions.push(sampled.position.clone().add(new THREE.Vector3(0, 1.48, 0)));
    }
    // (Electric wires removed: straight chord lines between lamps cut through
    // the planet and pierced props — they were designed for a flat town.)

    // Tiny NPC placeholders (spheres) near buildings to imply life
    const npcs = new THREE.Group();
    const npcPlaceholders: THREE.Mesh[] = [];
    const NPC_SITES: Array<[number, number]> = [
      // welcome greeters near the spawn plaza
      [0.5, 1.30], [2.2, 1.32], [4.0, 1.30], [5.5, 1.33],
      // villagers around the Personal hamlet
      [2.36 + SHIFT_PERSONAL, 0.45], [2.66 + SHIFT_PERSONAL, 0.45], [2.51 + SHIFT_PERSONAL, 0.32], [2.51 + SHIFT_PERSONAL, 0.60], [2.43 + SHIFT_PERSONAL, 0.53],
      // office crowd at the Professional plaza
      [6.11, 0.45], [0.17, 0.45], [0.0, 0.30], [6.21, 0.58],
      // builders at the Projects work sites
      [1.15 + SHIFT_PROJECTS, 0.45], [1.36 + SHIFT_PROJECTS, 0.50], [1.26 + SHIFT_PROJECTS, 0.32],
      // market-goers at the Contact stalls
      [3.69 + SHIFT_CONTACT, 0.51], [3.86 + SHIFT_CONTACT, 0.51], [3.77 + SHIFT_CONTACT, 0.36],
      // one wanderer out on the coastal road (the equator is ocean now)
      [5.0, 0.28],
    ];
    const NPC_SHIRT_COLORS = [0x4488bb, 0xcc5544, 0x55aa55, 0xddaa33, 0x8866aa, 0xbb6644];
    const NPC_PERSONALITIES = [
      { name: 'Elder Sage', dialogue: [
        'Welcome to Life Island, traveller.',
        'Each zone tells a chapter of the story.',
        'Seek the glowing mailboxes — they hold deliveries for you.',
      ]},
      { name: 'Village Baker', dialogue: [
        'Nothing beats fresh bread on a tiny planet!',
        'The secret ingredient? Always butter.',
        'Come back anytime — the oven is always warm.',
      ]},
      { name: 'Island Explorer', dialogue: [
        'Have you found all five zones yet?',
        'The compass at the top points to your next delivery.',
        'Press E near a glowing mailbox to collect!',
      ]},
      { name: 'Young Student', dialogue: [
        'I\'m learning TypeScript! It\'s amazing.',
        'Did you know this whole island runs on Three.js?',
        'One day I\'ll build my own world like this.',
      ]},
      { name: 'Market Vendor', dialogue: [
        'Fresh ideas, get your fresh ideas here!',
        'Special today: one-of-a-kind digital experiences.',
        'Browse the Project Portfolio zone for the full catalogue.',
      ]},
      { name: 'Market Vendor', dialogue: [
        'You look like someone who appreciates quality.',
        'Everything here is handcrafted, pixel by pixel.',
        'Tell your friends about Life Island!',
      ]},
      { name: 'Fisherman', dialogue: [
        'The waters here are unlike any other...',
        'Sometimes I wonder what\'s beyond the fog.',
        'Patience is the best algorithm.',
      ]},
      { name: 'Artist', dialogue: [
        'Look at how the light catches the terrain!',
        'Every pixel on this planet was placed with care.',
        'The zone markers... they pulse like a heartbeat.',
      ]},
      { name: 'Guard', dialogue: [
        'All clear! No bugs spotted today.',
        'Move along, citizen. Nothing to debug here.',
        'I keep watch over the render pipeline.',
      ]},
      { name: 'Storyteller', dialogue: [
        'Once upon a time, there was an empty sphere...',
        'Then the creator filled it with houses, trees, and dreams.',
        'And the people came, one visitor at a time.',
      ]},
      { name: 'Wanderer', dialogue: [
        '...',
        'I\'ve walked every arc of this sphere.',
        'There are secrets in the spaces between zones.',
      ]},
      { name: 'Gardener', dialogue: [
        'These flowers bloom in every colour of the palette.',
        'A little water, a little sunlight, and voila!',
        'The trees sway even without wind. Magic, I say.',
      ]},
      { name: 'Architect', dialogue: [
        'I designed half the buildings on this island.',
        'The trick is making them sit on a curved surface.',
        'Every house is grounded to the terrain. No floating allowed!',
      ]},
      { name: 'Musician', dialogue: [
        'Can you hear the music? It\'s procedurally generated.',
        'Each note is chosen from a pentatonic scale.',
        'The birds? Also procedural. Nature imitates code.',
      ]},
      { name: 'Lighthouse Keeper', dialogue: [
        'The beacons guide delivery runners to their targets.',
        'Gold light means a package awaits.',
        'I\'ve been keeping these lights running since version 1.0.',
      ]},
      { name: 'Tourist', dialogue: [
        'What a charming little planet!',
        'I came for the portfolio, stayed for the vibes.',
        'Have you tried walking all the way around?',
      ]},
      { name: 'Cartographer', dialogue: [
        'Five zones, twenty buildings, one sphere.',
        'The Welcome Hub is at the north pole.',
        'Everything else sits along the equator belt.',
      ]},
      { name: 'Philosopher', dialogue: [
        'Is the player walking on the planet...',
        '...or is the planet turning under the player?',
        'Either way, we are all spheres in the end.',
      ]},
      { name: 'Courier', dialogue: [
        'Another day, another delivery!',
        'The quest chain starts with the Welcome packages.',
        'Finish them all and you unlock something special.',
      ]},
      { name: 'Night Watch', dialogue: [
        'The lamps flicker at dusk. Have you noticed?',
        'Press E near a lamp to toggle it.',
        'I prefer the island at night. Quieter.',
      ]},
    ];
    const npcSkinMat = new THREE.MeshStandardMaterial({ color: 0xf5c6a0, roughness: 0.7 });
    const npcShoeMat = Materials.createStandardMaterial({ color: 0x3d2b1a, roughness: 0.8 });
    const HAIR_COLORS = [0x3a2a1a, 0x8b6b3a, 0x222222, 0xcc8844, 0x5a3a2a, 0x1a1a2a];
    for (let i = 0; i < NPC_SITES.length; i++) {
      const dir = this.claimDir(this.dirAt(NPC_SITES[i][0], NPC_SITES[i][1]), 0.05);
      const npcGroup = new THREE.Group();
      const shirtMat = new THREE.MeshStandardMaterial({ color: NPC_SHIRT_COLORS[i % NPC_SHIRT_COLORS.length], roughness: 0.6 });
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
      const hairMat = new THREE.MeshStandardMaterial({ color: HAIR_COLORS[i % HAIR_COLORS.length], roughness: 0.8 });
      const hair = new THREE.Mesh(new THREE.SphereGeometry(0.085, 8, 6, 0, Math.PI * 2, 0, Math.PI * 0.55), hairMat);
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

    // Floating sparkles around the planet surface
    const particles = new THREE.Group();
    particles.name = 'ambient_sparkles';
    const sparkleMat = new THREE.MeshBasicMaterial({
      color: 0xffffee,
      transparent: true,
      opacity: 0.55,
    });
    for (let i = 0; i < 30; i++) {
      const sparkle = new THREE.Mesh(new THREE.SphereGeometry(0.04, 4, 4), sparkleMat);
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(Math.random() * 2 - 1);
      const r = this.radius + 0.3 + Math.random() * 2;
      sparkle.position.set(
        r * Math.sin(phi) * Math.cos(theta),
        r * Math.sin(phi) * Math.sin(theta),
        r * Math.cos(phi),
      );
      sparkle.userData = { baseY: sparkle.position.y, phase: Math.random() * Math.PI * 2 };
      particles.add(sparkle);
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
      color: 0x3399dd, transparent: true, opacity: 0.7,
      roughness: 0.05, metalness: 0.3, emissive: 0x1155aa, emissiveIntensity: 0.1,
    });
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
      this.claimDir(this.dirAt(2.32 + SHIFT_PERSONAL, 0.50), 0.12).multiplyScalar(this.radius),
      0.02,
      true,
    );

    // Stylized human statue
    const statue = new THREE.Group();
    const bronzeMat = Materials.createPBRMaterial({ color: 0x8b6914, roughness: 0.5, metalness: 0.6 });
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
      this.claimDir(this.dirAt(0.18, 0.52), 0.08).multiplyScalar(this.radius),
      0.02,
      true,
    );
    statue.castShadow = true;
    statue.receiveShadow = true;
    statue.name = 'central_statue';

    // Add parked cars along the road — proper body + cabin + wheels
    const cars = new THREE.Group();
    const CAR_COLORS = [0xc44040, 0x4488bb, 0x55aa55, 0xddcc44, 0xbb6633, 0x8866aa, 0xdd7744, 0x557788];
    const wheelMat = Materials.createStandardMaterial({ color: 0x222222, roughness: 0.9 });
    const hubMat = Materials.createStandardMaterial({ color: 0x999999, metalness: 0.6 });
    const glassMat = new THREE.MeshStandardMaterial({
      color: 0x88bbdd, roughness: 0.1, metalness: 0.3, transparent: true, opacity: 0.6,
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
        color: 0xffffee, emissive: 0xffffcc, emissiveIntensity: 0.4,
      });
      for (const hx of [-0.45, 0.45]) {
        const hl = new THREE.Mesh(new THREE.SphereGeometry(0.08, 6, 6), headlightMat);
        hl.position.set(hx, 0.35, 1.31);
        hl.scale.set(1, 1, 0.5);
        carGroup.add(hl);
      }
      // Taillights
      const taillightMat = new THREE.MeshStandardMaterial({
        color: 0xff2222, emissive: 0xff0000, emissiveIntensity: 0.3,
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
        [-0.6, 0.15, 0.75], [0.6, 0.15, 0.75],   // front L, R
        [-0.6, 0.15, -0.75], [0.6, 0.15, -0.75], // rear L, R
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
      // between districts, alternating sides of the street (odd index =
      // north kerb lat 0.512, even = south kerb lat 0.415).
      const CAR_SITES: Array<[number, number]> = [
        [0.72, 0.415], [1.02, 0.512], [1.62, 0.415], [2.21, 0.512],
        [3.10, 0.415], [3.35, 0.512], [4.30, 0.415], [5.55, 0.512],
      ];
      const [carLon, carLat] = CAR_SITES[i % CAR_SITES.length];
      // claimOffStreet, not claimDir: claimDir's jitter was nudging parked cars
      // off their kerb site onto the middle of the boulevard ribbon. This keeps
      // them at the roadside, clear of the walkable path.
      const pos = this.claimOffStreet(this.dirAt(carLon, carLat), 0.08).multiplyScalar(this.radius);
      const sampled = this.sampleSurfacePosition(pos, 0.33);
      carGroup.position.copy(sampled.position);
      // Scaled to the ~1.6u player: roof ~1.06u, length ~2.9u — a car the
      // person can plausibly get into (1.55 read oversized next to the
      // shrunk player).
      carGroup.scale.setScalar(1.45); // ~1.3u tall vs the 1.7u player (was 0.99u, toy-sized)
      carGroup.quaternion.copy(
        new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), sampled.normal),
      );
      // Nose ALONG the street (tangent of the boulevard), direction matching
      // the side of the road it's parked on — reads as kerbside parking
      this.faceObjectToward(
        carGroup,
        sampled.normal,
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
    const STALL_SITES: Array<[number, number]> = [
      [3.51 + SHIFT_CONTACT, 0.65], [3.73 + SHIFT_CONTACT, 0.65], [3.95 + SHIFT_CONTACT, 0.65],
      // south row at 0.31 — 0.28 was the shoreline band, and claimDir
      // jitter kept nudging the end stall into the surf
      [3.59 + SHIFT_CONTACT, 0.31], [3.81 + SHIFT_CONTACT, 0.31], [4.03 + SHIFT_CONTACT, 0.31],
    ];
    for (let i = 0; i < STALL_SITES.length; i++) {
      const stall = this.createStall();
      const [sLon, sLat] = STALL_SITES[i];
      const pos = this.claimOffStreet(this.dirAt(sLon, sLat), 0.06).multiplyScalar(this.radius);
      const sampled = this.sampleSurfacePosition(pos, -0.08); // sunk slightly: bury-not-float
      stall.position.copy(sampled.position);
      // Counter at ~0.66u working height for the 1.56u vendors
      stall.scale.setScalar(2.2); // ~3.7u incl. awning (~2.2x the 1.7u player) — already well-proportioned
      stall.quaternion.copy(
        new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), sampled.normal),
      );
      // Counters face the market street (nearest boulevard point)
      this.faceObjectToward(
        stall,
        sampled.normal,
        this.dirAt(sLon, ZONE_LAT).multiplyScalar(this.radius),
      );
      stall.castShadow = true;
      stall.receiveShadow = true;
      stall.name = `stall_${i}`;
      stalls.add(stall);
    }

    // Signboards removed: unsupported flat planes floating at 0.8u read as
    // glitches (assets hovering in the air), not decor.
    const signboards = new THREE.Group();

    // Add rivers
    const rivers = new THREE.Group();
    // Both on the island (the second used to sit at lat -0.38 — seafloor now)
    const RIVER_SITES: Array<[number, number]> = [[4.62, 0.4], [0.72, 0.62]];
    for (let i = 0; i < RIVER_SITES.length; i++) {
      const river = this.createRiver();
      const pos = this.claimDir(this.dirAt(RIVER_SITES[i][0], RIVER_SITES[i][1]), 0.2).multiplyScalar(this.radius);
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
      const pos = this.claimDir(this.dirAt(mLon, mLat), 0.3).multiplyScalar(this.radius);
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
      [1.05 + SHIFT_PROJECTS, 0.65], [1.46 + SHIFT_PROJECTS, 0.34],
      // levelled up to match the other districts' density (was only 2 lots)
      [0.95 + SHIFT_PROJECTS, 0.34], [1.55 + SHIFT_PROJECTS, 0.66], [1.25 + SHIFT_PROJECTS, 0.72],
    ];
    for (let i = 0; i < WORK_SITES.length; i++) {
      const block = this.createConstructionBlock();
      const pos = this.claimOffStreet(this.dirAt(WORK_SITES[i][0], WORK_SITES[i][1]), 0.12).multiplyScalar(this.radius);
      const sampled = this.sampleSurfacePosition(pos, -0.1); // block base sunk slightly
      block.position.copy(sampled.position);
      block.quaternion.copy(
        new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), sampled.normal),
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
    const flowers = new THREE.Group();
    flowers.name = 'flowers';
    const FLOWER_COLORS = [0xff69b4, 0xf4a940, 0xffffff, 0xb46bd8, 0xff8866];
    const stemMat = Materials.createStandardMaterial({ color: 0x3d7a3d });
    const FLOWER_ANCHORS: Array<[number, number]> = [
      ...DISTRICT_LONS.map((l) => [l, ZONE_LAT] as [number, number]),
      [0, 1.42],
    ];
    // Pass 1: scatter valid placements (respecting street skips) + colour index
    const bloomUp = new THREE.Vector3(0, 1, 0);
    const bloomOne = new THREE.Vector3(1, 1, 1);
    const blooms: Array<{ mat: THREE.Matrix4; c: number }> = [];
    for (let i = 0; i < 50; i++) {
      const [fLon, fLat] = FLOWER_ANCHORS[Math.floor(i / 10)];
      const ringA = ((i % 10) / 10) * Math.PI * 2;
      const fDir = this.dirAt(fLon + Math.cos(ringA) * 0.2, fLat + Math.sin(ringA) * 0.15);
      // Plaza flower rings cross the boulevard — keep blooms off the pavement
      if (this.isNearStreet(fDir)) continue;
      const pos = this.claimDir(fDir, 0.015).multiplyScalar(this.radius);
      const sampled = this.sampleSurfacePosition(pos, 0.1);
      const quat = new THREE.Quaternion().setFromUnitVectors(bloomUp, sampled.normal);
      blooms.push({
        mat: new THREE.Matrix4().compose(sampled.position.clone(), quat, bloomOne),
        c: i % FLOWER_COLORS.length,
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
      addBatch(
        new THREE.SphereGeometry(0.04, 6, 6),
        new THREE.MeshStandardMaterial({ color: 0xffdd44, emissive: 0xffdd44, emissiveIntensity: 0.3 }),
        'flower_centers',
        all,
        [new THREE.Matrix4().makeTranslation(0, 0.27, 0)],
      );
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
        addBatch(
          petalGeo,
          new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.15 }),
          `flower_petals_${c}`,
          picks,
          petalLocals,
        );
      }
    }

    // Add signs for shops/buildings
    const signs = new THREE.Group();
    // (small floating sign planes removed for the same reason)

    // Add dust/pollen particles for ambiance
    const dustParticles = new THREE.Group();
    dustParticles.name = 'ambient_dust';
    const dustMat = new THREE.MeshBasicMaterial({
      color: 0xeeddaa,
      transparent: true,
      opacity: 0.35,
    });
    for (let i = 0; i < 80; i++) {
      const dust = new THREE.Mesh(new THREE.SphereGeometry(0.03, 4, 4), dustMat);
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(Math.random() * 2 - 1);
      const r = this.radius + 0.5 + Math.random() * 4;
      dust.position.set(
        r * Math.sin(phi) * Math.cos(theta),
        r * Math.sin(phi) * Math.sin(theta),
        r * Math.cos(phi),
      );
      dust.userData = { baseY: dust.position.y, phase: Math.random() * Math.PI * 2 };
      dust.name = 'dust';
      dustParticles.add(dust);
    }

    // Park benches near zone plazas
    const benches = new THREE.Group();
    // Benches at the plazas: [lon, lat, latOfPlazaTheyFace]
    const BENCH_SITES: Array<[number, number, number]> = [
      [0.8, 1.36, 1.5708], [3.9, 1.36, 1.5708],       // welcome / spawn
      [2.44 + SHIFT_PERSONAL, 0.40, 0.4636], [2.60 + SHIFT_PERSONAL, 0.40, 0.4636], [2.51 + SHIFT_PERSONAL, 0.56, 0.4636], // village
      [6.16, 0.40, 0.4636], [0.13, 0.42, 0.4636],     // professional
      [3.70 + SHIFT_CONTACT, 0.42, 0.4636], [3.85 + SHIFT_CONTACT, 0.42, 0.4636],     // market
    ];
    const benchWoodMat = new THREE.MeshStandardMaterial({ color: 0x8b6b42, roughness: 0.7 });
    const benchLegMat = Materials.createTrimMaterial(0x444444);
    for (let i = 0; i < BENCH_SITES.length; i++) {
      // Benches belong BESIDE the plaza paths, not on them. Claim clearance
      // FIRST, then slide off any pavement — doing it the other way round let
      // claimDir's jitter shove the bench back onto the street.
      const bDir = this.pushOffStreet(
        this.claimDir(this.dirAt(BENCH_SITES[i][0], BENCH_SITES[i][1]), 0.1),
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
      const bq = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), bSampled.normal);
      bench.quaternion.copy(bq);
      // Face the plaza this bench belongs to (seat toward it, backrest away)
      this.faceObjectToward(
        bench,
        bSampled.normal,
        this.dirAt(BENCH_SITES[i][0], BENCH_SITES[i][2]).multiplyScalar(this.radius),
      );
      bench.name = `bench_${i}`;
      bench.castShadow = true;
      benches.add(bench);
    }

    // Instanced wind-blown grass across the whole planet
    const grass = this.createGrass();

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
    const plazaFloor = new THREE.Mesh(new THREE.CylinderGeometry(3.4, 3.5, 0.1, 40), plazaStone);
    plazaFloor.receiveShadow = true;
    plazaBase.add(plazaFloor);
    const plazaRing = new THREE.Mesh(new THREE.TorusGeometry(3.05, 0.1, 8, 40), plazaTrim);
    plazaRing.rotation.x = Math.PI / 2;
    plazaRing.position.y = 0.06;
    plazaBase.add(plazaRing);
    this.placeObjectOnSurface(
      plazaBase,
      new THREE.Vector3(0, 1, 0).multiplyScalar(this.radius),
      0.03,
      true,
    );
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
        this.dirAt(dLon, Math.PI / 2 - 3.3 / this.radius).multiplyScalar(this.radius), // ~3.3u from the pole at any radius, so pillars stay on the plaza floor
        0.0,
        true,
      );
      welcomePlaza.add(pillar);
    }

    // Group everything and attach to the main mesh as children so the island remains dominant
    const root = new THREE.Group();
    root.add(mesh);
    root.add(welcomePlaza);
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
      buildings, houses, trees, lamps, npcs, cars, mailboxes, stalls, constructions, benches,
    ]);

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

    // (The old equator ring road + its decal conversion are gone — the
    // street network is built entirely from createStreetPath segments.)

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
    pole.position.set(-0.6, 1.9, -0.3);
    pole.castShadow = true;
    g.add(pole);
    const flagMat = new THREE.MeshStandardMaterial({
      color: 0x4caf50,
      emissive: 0x1c5a22,
      emissiveIntensity: 0.35,
      side: THREE.DoubleSide,
      roughness: 0.6,
    });
    const flagGeo = new THREE.BufferGeometry();
    // Triangular pennant off the top of the pole (+X), in the local XY plane
    flagGeo.setAttribute(
      'position',
      new THREE.Float32BufferAttribute([0, 3.4, 0, 1.25, 3.15, 0, 0, 2.75, 0], 3),
    );
    flagGeo.computeVertexNormals();
    const flag = new THREE.Mesh(flagGeo, flagMat);
    flag.position.set(-0.6, 0, -0.3);
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

    console.log(`⛰️ Summit monument placed at ${(surf.position.length() - this.seaLevel()).toFixed(1)}u above sea`);
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
    const darkMat = new THREE.MeshStandardMaterial({ color: 0x33383f, roughness: 0.55, metalness: 0.25 });

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
      new THREE.MeshStandardMaterial({ color: 0xffe680, emissive: 0xffd24a, emissiveIntensity: 1.6 }),
    );
    halo.rotation.x = Math.PI / 2;
    lamp.add(halo);
    // Conical roof
    const roof = new THREE.Mesh(new THREE.ConeGeometry(0.98, 0.95, 12), redMat);
    roof.position.y = galleryY + 1.85;
    roof.castShadow = true;
    g.add(roof);

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
    const mat = new THREE.MeshStandardMaterial({ color: 0x8b857a, roughness: 0.96, flatShading: true }); // warm neutral rock grey
    const MAX = 128;
    const inst = new THREE.InstancedMesh(geo, mat, MAX);
    inst.name = 'rocks';
    inst.castShadow = true;
    inst.receiveShadow = true;
    const up = new THREE.Vector3(0, 1, 0);
    const dummy = new THREE.Object3D();
    const golden = Math.PI * (3 - Math.sqrt(5));
    const CANDIDATES = 400;
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
      const dir = this.claimDir(candidate, 0.03); // tight — scree clusters
      const a2 = this.analyticSurface(dir);
      dummy.position
        .copy(dir)
        .multiplyScalar(a2.radius)
        .addScaledVector(a2.normal, -0.14); // sink slightly: bury-not-float
      dummy.quaternion.setFromUnitVectors(up, a2.normal);
      dummy.rotateY(Math.random() * Math.PI * 2);
      dummy.scale.setScalar(0.45 + Math.random() * (steep ? 1.5 : 0.85));
      dummy.updateMatrix();
      inst.setMatrixAt(placed, dummy.matrix);
      placed++;
    }
    inst.count = placed;
    inst.instanceMatrix.needsUpdate = true;
    console.log(`🪨 Rock layer: ${placed} boulders (scree + shoreline)`);
    return placed > 0 ? inst : null;
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
  public seaLevel(): number {
    return this.radius + Island.SEA_OFFSET;
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
    this.seaTideUniform.value =
      Math.sin((t / Island.TIDE_PERIOD) * Math.PI * 2) * Island.TIDE_AMP;
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
   * toward the road/plaza instead of random spins.
   */
  private faceObjectToward(obj: THREE.Object3D, normal: THREE.Vector3, target: THREE.Vector3): void {
    const proj = (v: THREE.Vector3) =>
      v.clone().sub(normal.clone().multiplyScalar(v.dot(normal)));
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
   * Claim a surface direction with a minimum angular clearance. If the
   * candidate is too close to something already placed, jitter around it
   * (up to 10 tries) before accepting the least-bad candidate.
   */
  public claimDir(candidate: THREE.Vector3, minArc: number, maxSlopeRad?: number): THREE.Vector3 {
    let best = candidate.clone().normalize();
    let bestClearance = -1;
    for (let attempt = 0; attempt < 10; attempt++) {
      const dir =
        attempt === 0
          ? candidate.clone().normalize()
          : candidate
              .clone()
              .normalize()
              .add(
                new THREE.Vector3(
                  (Math.random() - 0.5) * 0.5,
                  (Math.random() - 0.5) * 0.35,
                  (Math.random() - 0.5) * 0.5,
                ),
              )
              .normalize();
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
      // guess the maximum displacement we might find on the terrain (mountains/hills)
      const maxExpectedDisplacement = 4.5; // Increased from 3.0 to account for higher peaks

      // Try multiple raycast strategies to robustly hit displaced geometry
      const strategies = [] as { start: THREE.Vector3; dir: THREE.Vector3; far: number }[];

      // primary: cast from slightly outside the max displacement inward along center
      const primaryStart = this.center
        .clone()
        .add(dir.clone().multiplyScalar(this.radius + maxExpectedDisplacement + 1.0));
      strategies.push({
        start: primaryStart,
        dir: this.center.clone().sub(primaryStart).normalize(),
        far: maxExpectedDisplacement + 3.0 + this.radius + 15,
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
          far: maxExpectedDisplacement + 3.0 + this.radius + 15,
        });
      }

      // make sure the mesh matrices are up-to-date
      this.surfaceMesh.updateMatrixWorld(true);

      let hit: THREE.Intersection | null = null;
      let usedStrategyStart: THREE.Vector3 | null = null;
      for (const strat of strategies) {
        try {
          const raycaster = new THREE.Raycaster(strat.start, strat.dir, 0, strat.far);
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
          const MAX_TILT = 0.21; // ~12 degrees
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
        // debug: draw helper sphere + ray
        const meshData = this.mesh.userData as IslandMeshUserData;
        if (meshData._debug) {
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
          if (!helpers.parent) this.mesh.add(helpers);
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

  /** True when a unit direction lands on (or within margin of) a street. */
  public isNearStreet(dir: THREE.Vector3): boolean {
    for (const s of this.streetDirs) {
      if (dir.angleTo(s.dir) < s.halfArc) return true;
    }
    return false;
  }

  /** If `dir` sits on a street, slide it sideways off the pavement (benches,
   * props that belong BESIDE a path, not on it). Returns the nudged direction. */
  public pushOffStreet(dir: THREE.Vector3, step = 0.03, tries = 10): THREE.Vector3 {
    const d = dir.clone().normalize();
    for (let i = 0; i < tries && this.isNearStreet(d); i++) {
      const s = this.nearestStreetDir(d, 0.6);
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
  public nearestStreetDir(dir: THREE.Vector3, maxArc = 0.35): THREE.Vector3 | null {
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
    for (let attempt = 0; attempt < 14; attempt++) {
      let dir =
        attempt === 0
          ? base.clone()
          : base
              .clone()
              .add(
                new THREE.Vector3(
                  (Math.random() - 0.5) * 0.5,
                  (Math.random() - 0.5) * 0.35,
                  (Math.random() - 0.5) * 0.5,
                ),
              )
              .normalize();
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
    const keepOutArc = (width * 0.5 + 0.8) / this.radius;
    for (let i = 0; i < waypoints.length - 1; i++) {
      const a = waypoints[i].clone().normalize();
      const b = waypoints[i + 1].clone().normalize();
      const midDir = a.clone().add(b).normalize();
      // sampleSurfaceByDirection (not sampleSurfacePosition): the latter
      // raycasts from the base radius, which starts INSIDE raised terrain
      // and falls back to r=base — burying street segments under hills
      const sampled = this.sampleSurfaceByDirection(midDir, 0.03);
      const posA = a.multiplyScalar(this.radius);
      const posB = b.multiplyScalar(this.radius);
      const segLength = posA.distanceTo(posB);
      // 1.3x overlap: consecutive planes tilt with the terrain, and at 1.12
      // the joins opened visible gaps on bumpy stretches ("panel" look)
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(segLength * 1.3, width, 1, 1), mat);
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
      mesh.quaternion.setFromRotationMatrix(
        new THREE.Matrix4().makeBasis(xAxis, yAxis, zAxis),
      );
      mesh.receiveShadow = true;
      group.add(mesh);
      this.streetDirs.push({ dir: midDir, halfArc: keepOutArc });
    }
    return group;
  }

  private createStall(): THREE.Group {
    const group = new THREE.Group();
    // ground skirt so slope gaps under the stall read as a wooden deck
    const skirtGeom = new THREE.BoxGeometry(1.35, 0.5, 0.95);
    const skirtMat = Materials.createTrimMaterial(0x8a7355);
    const skirt = new THREE.Mesh(skirtGeom, skirtMat);
    skirt.position.set(0, -0.2, 0);
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
    const roofMat = Materials.createTrimMaterial(STALL_COLORS[Math.floor(Math.random() * STALL_COLORS.length)]);
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
        new THREE.MeshStandardMaterial({ color: goodColors[g % goodColors.length], roughness: 0.6 }),
      );
      good.position.set(-0.3 + g * 0.3, 0.35, 0);
      group.add(good);
    }
    return group;
  }

  private createConstructionBlock(): THREE.Group {
    const group = new THREE.Group();
    // Main building block
    const buildingGeom = new THREE.BoxGeometry(2, 3, 2);
    const buildingMat = Materials.createPBRMaterial({ color: 0xcccccc, roughness: 0.9 });
    const building = new THREE.Mesh(buildingGeom, buildingMat);
    building.position.set(0, 1.5, 0);
    building.castShadow = true;
    building.receiveShadow = true;
    group.add(building);
    // Scaffolding poles
    const poleMat = Materials.createTrimMaterial(0x666666);
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
                      const clF = proj(new THREE.Vector3(0, 0, 1).applyQuaternion(clone.quaternion));
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
                      try {
                        ph.visible = false;
                      } catch {
                        /* ignore */
                      }
                    }
                  };
                  requestAnimationFrame(step);
                });
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
      });
      loadAndReplace(basePath + 'mailbox.glb', 'mailbox_', {
        scale: 1,
        randomYaw: true,
        heightOffset: -0.02,
      });
      // Cars stay PROCEDURAL now: they're drivable vehicles whose wheels the
      // driving code spins/steers, and GameScene moves the car_N group. The
      // GLB replacement hid the procedural car and dropped a STATIC mesh on
      // top — so a driven car appeared to stay parked while the rider drove
      // off. (car.glb replacement removed.)
      loadAndReplace(basePath + 'lamp.glb', 'lamp', {
        scale: 1,
        candidates: [ak + '/Fantasy Props MegaKit[Standard]/Exports/glTF/Lantern_Wall.gltf'],
        heightOffset: -0.04,
        randomYaw: true,
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
                  // 30% of NPCs patrol between two nearby points
                  try {
                    if (Math.random() < 0.35) {
                      const dir = ph.position.clone().sub(this.center).normalize();
                      const right = new THREE.Vector3()
                        .crossVectors(new THREE.Vector3(0, 1, 0), dir)
                        .normalize();
                      const p1 = ph.position.clone().add(right.clone().multiplyScalar(0.8));
                      const p2 = ph.position.clone().add(right.clone().multiplyScalar(-0.8));
                      // ensure projected to surface
                      try {
                        // sample patrol points to account for displacement
                        const s1 = this.sampleSurfacePosition(p1, 0.58);
                        const s2 = this.sampleSurfacePosition(p2, 0.58);
                        npc.startPatrol([s1.position, s2.position]);
                      } catch {
                        /* ignore patrol placement issues */
                      }
                    }
                  } catch {
                    /* ignore patrol setup issues */
                  }
                  // update the npcTarget meshRef to point at the GLTF group
                  try {
                    const phIdx = parseInt(ph.name.replace('npc_placeholder_', ''), 10);
                    if (phIdx >= 0 && phIdx < this.npcTargets.length) {
                      this.npcTargets[phIdx].meshRef = npc.group;
                      this.npcTargets[phIdx].position = pos.clone();
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
                [1.45, 0.32], [1.62, 0.32], [1.79, 0.32], [1.96, 0.32],
                [1.53, 0.44], [1.7, 0.44], [1.87, 0.44],
                // forest segment (two bands up the eastern slope)
                [5.25, 0.34], [5.45, 0.3], [5.65, 0.36], [5.85, 0.3],
                [5.35, 0.55], [5.55, 0.62], [5.75, 0.52], [5.95, 0.6],
                [6.1, 0.38],
                // high wood (upland between Personal and Projects)
                [2.0, 0.78], [2.2, 0.88], [2.4, 0.76], [2.15, 0.65],
                // scattered singles
                [0.5, 0.55], [1.3, 0.85], [3.3, 0.42], [4.3, 0.72], [4.75, 0.35], [0.05, 0.92],
              ];
              const treeCount = TREE_SITES.length;
              for (let i = 0; i < treeCount; i++) {
                const [tLon, tLat] = TREE_SITES[i];
                const dir = this.claimDir(this.dirAt(tLon, tLat), 0.07);
                const p = dir.clone().multiplyScalar(this.radius);
                const usedScale = 0.6 + Math.random() * 0.22; // 3.4-4.6u tall — planet-scale trees
                const copy = prepareClone(model, usedScale, overrides);
                try {
                  this.placeObjectOnSurface(copy, p.clone(), -0.07, true);
                } catch {
                  /* ignore placement */
                }
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
                const step = () => {
                  const now = performance.now();
                  const t = Math.min(1, (now - start) / duration);
                  copy.traverse((object) => {
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
                  if (t < 1) requestAnimationFrame(step);
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
        const maxDisp = 11;
        const startPos = this.center.clone().add(dir.clone().multiplyScalar(this.radius + maxDisp + 1));
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

          // Clamp tilt away from radial "up" (see sampleSurfacePosition)
          {
            const radial = toHit.clone().normalize();
            const MAX_TILT = 0.21; // ~12 degrees
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

  // Expose NPC instances so other systems (Engine, InteractionSystem) can register or query them
  public getNPCInstances(): NPC[] {
    return this.npcInstances.slice();
  }

  public addToScene(scene: THREE.Scene): void {
    scene.add(this.mesh);
  }

  // Update animations for whimsical feel
  public update(deltaTime: number): void {
    const time = performance.now() * 0.001; // seconds

    // Sway tree foliage gently
    this.mesh.traverse((object) => {
      if (typeof object.name === 'string' && object.name.startsWith('tree_')) {
        const idx = parseInt(object.name.split('_')[1] || '0', 10);
        const sway = Math.sin(time * 1.5 + idx * 0.7) * 0.015;
        object.rotation.z = sway;
      }
    });

    // Animate water surfaces (fountain + river shimmer)
    this.mesh.traverse((object) => {
      if (object instanceof THREE.Mesh && object.material instanceof THREE.MeshStandardMaterial) {
        const mat = object.material;
        if (mat.opacity > 0 && mat.opacity < 1 && mat.transparent && mat.color.b > 0.5) {
          mat.emissiveIntensity = 0.1 + Math.sin(time * 3) * 0.05;
        }
      }
    });

    // Blink lamp lights at night (simulate time-based)
    const timeOfDay = time % 24;
    const isNight = timeOfDay > 18 || timeOfDay < 6;
    this.mesh.traverse((object) => {
      const data = object.userData as { isLampLight?: boolean };
      if (data?.isLampLight) {
        object.visible = isNight && Math.sin(time * 3) > -0.5;
      }
    });

    // Idle NPC animations (subtle bobbing)
    this.mesh.traverse((object) => {
      if (typeof object.name === 'string' && object.name.startsWith('npc_placeholder_')) {
        const parts = object.name.split('_');
        const idx = Number.parseInt(parts[2] ?? '0', 10);
        const placeholderOccupied = this.npcInstances.some(
          (npcInstance) => npcInstance.group.position.distanceTo(object.position) < 0.01,
        );
        if (!placeholderOccupied) {
          object.position.y += Math.sin(time * 2 + idx) * 0.005;
        }
      }
    });

    // Animate ambient particles (floating sparkles)
    this.mesh.traverse((object) => {
      const data = object.userData as { baseY?: number; phase?: number };
      if (typeof data?.baseY === 'number' && typeof data.phase === 'number') {
        object.position.y = data.baseY + Math.sin(time * 1.5 + data.phase) * 0.1;
        object.rotation.y += deltaTime * 0.5;
      }
    });

    // Animate dust particles
    this.mesh.traverse((object) => {
      const data = object.userData as { baseY?: number; phase?: number };
      if (
        object.name === 'dust' &&
        typeof data?.baseY === 'number' &&
        typeof data.phase === 'number'
      ) {
        object.position.y = data.baseY + Math.sin(time * 0.5 + data.phase) * 0.5;
        object.position.x += Math.sin(time * 0.3 + data.phase) * 0.01;
        object.position.z += Math.cos(time * 0.3 + data.phase) * 0.01;
      }
    });

    // Advance any animation mixers created for loaded GLTF clones (NPCs, props, trees)
    this.animationMixers.forEach((mixer) => {
      try {
        mixer.update(deltaTime);
      } catch {
        /* ignore animation update issues */
      }
    });

    // Update NPC instances (state machines)
    this.npcInstances.forEach((npcInstance) => {
      try {
        npcInstance.update(deltaTime);
      } catch {
        /* ignore NPC update issues */
      }
    });
  }

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
