/**
 * CelLook — the unified-cel display kit (default theme; owner verdict
 * 2026-08-09 from the art-direction bake-off).
 *
 * Four pieces, all verified against three ~0.180 in the deep-dive:
 *  1. CEL SHADOWS: NOT ACTIVE (see section 1 below). Shadow edges are three's
 *     stock PCF.
 *  2. RIM LIGHT: per-material onBeforeCompile injection at
 *     <opaque_fragment> (r154+ name of output_fragment) — a fresnel gated by
 *     the lit side (the BotW recipe), on the CAST only (villagers + player);
 *     rimming everything would flatten the value hierarchy. Sun direction is
 *     a VIEW-SPACE uniform updated per frame through a registry. At night the
 *     same injection adds the cast's own fill and a moon rim (C5).
 *  3. INK OUTLINES: inverted-hull meshes baked by displacing clone geometry
 *     along SMOOTHED normals (position-hash weld first — the chamfered
 *     avatars carry split normals at hard edges and raw displacement would
 *     tear the hull). Works identically on the composer-less mobile tier,
 *     inherits FogExp2 distance fade. The PLAYER is excluded — its GLB
 *     carries an authored hull (never re-author, per project memory).
 *  4. Warm-key/cool-fill light split (applied in GameScene.setupLighting).
 */
import * as THREE from 'three';

import { fx } from './FxBudget';
import { SimpleRenderer } from './SimpleRenderer';
import { isRealTheme } from './Theme';
import { WORLD_RADIUS } from './WorldScale';

/** The cel kit runs whenever the real theme ISN'T forced. */
export function isCelTheme(): boolean {
  return !isRealTheme();
}

// ── 1. Cel shadow edges: removed (stock PCF) ────────────────────────────────
//
// The old applyCelShadowPatch() split shadowmap_pars_fragment on
// `return shadow;`, a line three moved to
// `return mix( 1.0, shadow, shadowIntensity );` in r165 (per-light shadow
// intensity). On the installed 0.180 it matched nothing, so for months it was
// a no-op that first logged "applied" and later warned on every page load.
// Deleted rather than ported: porting CHANGES THE LOOK (Abbas's call). Two
// older commit messages blame shadow artefacts on "CelLook turning the
// mid-grey PCF into a hard black step"; that was never true on this version.
//
// If the crisp cel edge is wanted back, threshold `shadow` INSIDE getShadow,
// before the shadowIntensity mix (patch the chunk body, not its return). Do
// NOT threshold shadowmask_pars_fragment, where `return shadow;` lives now:
// the intensity is already mixed in there, so every intermediate value of the
// horizon fade in GameScene.updateSunShadow would snap instead of easing.

// ── 2. Rim light on the cast ────────────────────────────────────────────────

type RimUniforms = {
  uCelSunDir: { value: THREE.Vector3 };
  uCelRim: { value: number };
  uCelNight: { value: number };
};
const rimRegistry: RimUniforms[] = [];
const _sunView = new THREE.Vector3();

// ── The cast's night light (C5) ─────────────────────────────────────────────
// At night the avatar was a black cut-out: L* 5-7 against ground at 14-18,
// face and clothes unreadable. Every light in the rig is global, so lifting
// the figure with one lifts the sand and the scree under it too, and the dark
// beaches and mountains are Abbas's to keep. These two terms live in the
// cast's shader instead, so they reach people and nothing else:
// - a fill on what faces the camera: the albedo x 0.075, eased to 60% of that
//   at the silhouette, so the face and the jacket keep their own colours;
// - a moon rim round the silhouette that needs no lit side.
// The plan's 0.16 and 0.35 were never measured against exact masks: with
// them the avatar's median L* at 21 h was 35-38, brighter than at noon (27).
// These give 20-25 (p90 25-30) on both tiers at 21 h and 00 h.
const CEL_NIGHT_FILL = 0.075;
const CEL_NIGHT_RIM = 0.15;

/** The night level, ONE uniform object shared by every rim material: a
 *  frame's update is a single write, however many villagers are dressed. */
const celNight = { value: 0 };
/** What the cycle last asked for. celNight carries it outdoors only. */
let celNightLevel = 0;

/**
 * Rooms are lit by their own rig, and the world's night must not follow the
 * visitor in. GameScene.update returns into the interior mode before the
 * cycle's update, so the last outdoor night level would otherwise hold for
 * the whole visit: the player and the room's villagers in a lit room with the
 * night fill and a blue moon rim. The gate is the camera, read per draw: every
 * room sits about 300 u from the planet's centre (200 u under the south pole),
 * and no outdoor camera gets past the terrain plus the orbit's 12 u, so twice
 * the world radius splits them with margin both ways. Per draw rather than per
 * frame because one interior frame draws both: the room, and the window's
 * view of the night outside, which keeps its night.
 */
export const CEL_INDOOR_RADIUS = WORLD_RADIUS * 2;
const CEL_INDOOR_RADIUS_SQ = CEL_INDOOR_RADIUS * CEL_INDOOR_RADIUS;

/** True for a camera inside a room (far outside the world's sphere). */
export function celCameraIndoors(camera: THREE.Camera): boolean {
  const e = camera.matrixWorld.elements;
  return e[12] * e[12] + e[13] * e[13] + e[14] * e[14] > CEL_INDOOR_RADIUS_SQ;
}

/** Material.onBeforeRender for the cast: three calls it per draw, before the
 *  program and its uniforms are bound, and resets its bound material at the
 *  start of every render, so a room pass and a window pass each upload their
 *  own value. One comparison per cast draw. */
function celNightForCamera(_r: THREE.WebGLRenderer, _s: THREE.Scene, camera: THREE.Camera): void {
  celNight.value = celCameraIndoors(camera) ? 0 : celNightLevel;
}

fx.register('celNightRim', { desktop: true, low: true });

/**
 * Per frame, from EnvironmentCycle: how far into night the world is (its
 * night factor: 0 by day and through golden hour, 1 at night). With the
 * 'celNightRim' switch off the cast's night terms stay at 0.
 */
export function setCelNight(night: number): void {
  celNightLevel = fx.on('celNightRim') ? night : 0;
  celNight.value = celNightLevel;
}

/**
 * Add the lit-side fresnel rim to a material (villager palette mats + the
 * player's GLB mats). Chains any existing onBeforeCompile. Never call on
 * hull/outline materials.
 */
export function applyCelRim(mat: THREE.Material): void {
  if (!isCelTheme()) return;
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, renderer) => {
    if (prev) prev.call(mat, shader, renderer);
    const uniforms: RimUniforms = {
      uCelSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uCelRim: { value: 1.0 },
      uCelNight: celNight,
    };
    Object.assign(shader.uniforms, uniforms);
    rimRegistry.push(uniforms);
    shader.fragmentShader = shader.fragmentShader
      .replace(
        'void main() {',
        'uniform vec3 uCelSunDir;\nuniform float uCelRim;\nuniform float uCelNight;\nvoid main() {',
      )
      .replace(
        '#include <opaque_fragment>',
        `{
	// CelLook rim: fresnel gated to the lit side (BotW-style), hard edge.
	float celNdotL = max( dot( normal, uCelSunDir ), 0.0 );
	float celFres = 1.0 - saturate( dot( normalize( vViewPosition ), normal ) );
	float celRim = smoothstep( 0.70, 0.74, celFres * pow( celNdotL, 0.35 ) );
	outgoingLight += vec3( 1.05, 1.0, 0.92 ) * celRim * 0.28 * uCelRim;
	// Night (C5), cast only: a fill on what faces the camera, and a moon rim
	// round the silhouette.
	outgoingLight += diffuseColor.rgb * ( 0.6 + 0.4 * ( 1.0 - celFres ) ) * ${CEL_NIGHT_FILL.toFixed(3)} * uCelNight;
	outgoingLight += vec3( 0.55, 0.65, 0.90 ) * smoothstep( 0.62, 0.70, celFres ) * ${CEL_NIGHT_RIM.toFixed(3)} * uCelNight;
}
#include <opaque_fragment>`,
      );
  };
  // Identical injection body across materials → identical cache key → one
  // shared program with per-material uniforms. v2 (the night terms) REPLACES
  // v1: every rim material takes this key, so the program count is unchanged.
  mat.customProgramCacheKey = () => 'cel-rim-v2';
  // Indoors the night terms are off (celNightForCamera). Chains any existing
  // hook, as onBeforeCompile does above.
  const prevRender = mat.onBeforeRender;
  mat.onBeforeRender =
    prevRender === THREE.Material.prototype.onBeforeRender || prevRender === celNightForCamera
      ? celNightForCamera
      : function (this: THREE.Material, ...args: Parameters<THREE.Material['onBeforeRender']>) {
          prevRender.apply(this, args);
          celNightForCamera(args[0], args[1], args[2]);
        };
  mat.needsUpdate = true;
}

/** Per-frame: convert the sun's WORLD direction into view space for every
 *  registered rim shader (fragment normals are view-space). */
export function updateCelRim(sunWorldDir: THREE.Vector3, camera: THREE.Camera): void {
  if (!rimRegistry.length) return;
  _sunView.copy(sunWorldDir).transformDirection(camera.matrixWorldInverse);
  for (const u of rimRegistry) u.uCelSunDir.value.copy(_sunView);
}

// ── 3. Inverted-hull ink outlines ───────────────────────────────────────────

const INK_COLOR = 0x1c2430;
let inkMat: THREE.MeshBasicMaterial | null = null;
let inkVisible = true;
function getInkMat(): THREE.MeshBasicMaterial {
  if (!inkMat) {
    inkMat = new THREE.MeshBasicMaterial({
      color: INK_COLOR,
      side: THREE.BackSide,
      fog: true, // Sable-style: lines fade with the same fog as the world
    });
    inkMat.visible = inkVisible; // a hull baked mid-intro joins the current state
  }
  return inkMat;
}

/**
 * Show or hide EVERY ink hull at once, through the one material they share.
 * The intro fly-in hides them: with the whole planet in frustum, ~1,550 of
 * its ~5,080 draws per frame were hulls (measured at a fixed fly-in pose), at
 * a distance where a 0.016u line is sub-pixel anyway.
 *
 * Material.visible ONLY. Object3D.visible on hulls, coins or birds is game
 * state (coin respawn, peck mode) and input is live during the fly-in.
 * WebGLRenderer.compile() prepares materials whatever their visibility, so the
 * warm-up still compiles the ink programs behind the loader.
 */
export function setInkVisible(visible: boolean): void {
  inkVisible = visible;
  if (inkMat) inkMat.visible = visible;
}

const hullGeoCache = new Map<string, THREE.BufferGeometry>();

// ── SHIELD ──────────────────────────────────────────────────────────────────
// three.js mints a uuid from Math.random for every BufferGeometry / Material /
// Object3D. The ink is theme- AND tier-GATED (see the early returns in
// addGroupHulls), so every ambient draw it consumed built a DIFFERENT world on
// a phone or a ?theme=real client than on desktop-cel — and Island
// construction runs inside GameScene.initialize's seeded window. MEASURED
// before this shield: all 8 parked cars displaced (car_0 by 4.85deg = 6.35u of
// arc at R=75), and parked cars become drivable vehicles that are networked BY
// INDEX (Multiplayer.ts vehIdx "same on every client"), so boarding one
// teleported it for the other player. Shielding converges desktop-cel onto the
// layout phones and ?theme=real clients already build.
// Same law as buildGrassClumpGeometry / createOreNodes / buildDistrictAmenities.
let _inkSeed = 0x5ec7104f >>> 0;
function inkRandom(): number {
  _inkSeed = (_inkSeed + 0x6d2b79f5) >>> 0;
  let t = Math.imul(_inkSeed ^ (_inkSeed >>> 15), 1 | _inkSeed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
/** Run `fn` with Math.random routed into the ink generator. Stash/restore (not
 *  a saved global) so nesting inside another shield is safe. */
function withInkRng<T>(fn: () => T): T {
  const stashed = Math.random;
  Math.random = inkRandom;
  try {
    return fn();
  } finally {
    Math.random = stashed;
  }
}

/** Smoothed normals via position-hash weld: average the normals of every
 *  vertex sharing a position, so displacement can't tear at split (hard)
 *  edges. Returns a Float32Array parallel to the position attribute. */
function smoothedNormals(geo: THREE.BufferGeometry): Float32Array {
  const pos = geo.getAttribute('position');
  const nrm = geo.getAttribute('normal');
  const out = new Float32Array(pos.count * 3);
  const acc = new Map<string, [number, number, number, number[]]>();
  for (let i = 0; i < pos.count; i++) {
    const key = `${pos.getX(i).toFixed(4)},${pos.getY(i).toFixed(4)},${pos.getZ(i).toFixed(4)}`;
    let e = acc.get(key);
    if (!e) {
      e = [0, 0, 0, []];
      acc.set(key, e);
    }
    e[0] += nrm.getX(i);
    e[1] += nrm.getY(i);
    e[2] += nrm.getZ(i);
    e[3].push(i);
  }
  const v = new THREE.Vector3();
  for (const [, e] of acc) {
    v.set(e[0], e[1], e[2]);
    if (v.lengthSq() < 1e-10) v.set(0, 1, 0);
    v.normalize();
    for (const i of e[3]) {
      out[i * 3] = v.x;
      out[i * 3 + 1] = v.y;
      out[i * 3 + 2] = v.z;
    }
  }
  return out;
}

/** Bake an inflated hull geometry (positions displaced along smoothed
 *  normals). Skin attributes survive the clone, so the same bake serves
 *  SkinnedMesh hulls — at these thicknesses, displacing the BIND pose and
 *  skinning the displaced verts is indistinguishable from in-shader
 *  inflation. Cached per source geometry + thickness. */
function bakeHullGeometry(geo: THREE.BufferGeometry, thickness: number): THREE.BufferGeometry {
  const key = `${geo.uuid}:${thickness.toFixed(4)}`;
  let hull = hullGeoCache.get(key);
  if (hull) return hull;
  hull = geo.clone();
  const pos = hull.getAttribute('position') as THREE.BufferAttribute;
  const sm = smoothedNormals(geo);
  for (let i = 0; i < pos.count; i++) {
    pos.setXYZ(
      i,
      pos.getX(i) + sm[i * 3] * thickness,
      pos.getY(i) + sm[i * 3 + 1] * thickness,
      pos.getZ(i) + sm[i * 3 + 2] * thickness,
    );
  }
  pos.needsUpdate = true;
  hullGeoCache.set(key, hull);
  return hull;
}

const _wScale = new THREE.Vector3();

/**
 * Add ink hulls to every substantial mesh in a group (the cats/herons/props
 * path — NON-skinned). Hulls are added as CHILDREN of each part so they
 * inherit the part's animated transform (tail joints, head pivots) for free.
 * Small detail parts (eyes, socks, noses) are skipped by world size.
 */
export function addGroupHulls(
  root: THREE.Object3D,
  minWorldRadius = 0.045,
  filter?: (m: THREE.Mesh) => boolean,
  opts?: { staticInk?: boolean },
): void {
  if (!isCelTheme()) return;
  // Ink is a draw-call DOUBLER on every hulled part (~300+ extra draws with
  // the full cast). Phones are draw-call-bound, not fill-bound — low-tier
  // devices get the clean cel look without outlines. Desktop unchanged.
  if (SimpleRenderer.isLowTierDevice()) {
    // ?phoneink=1 (decision 15, for Abbas to compare on his phone): a call
    // that opts in with staticInk (architecture that never moves, hides or
    // is swapped for a GLB) only remembers what it would have inked;
    // flushPhoneInk merges it into one static hull per district. Cars, the
    // GLB-replaced placeholders, the playground and the build-plot gazebos
    // never opt in. Recording allocates no three object, so it draws nothing
    // either; once the flush has run nothing more is queued.
    if (opts?.staticInk && !phoneInkFlushed && isPhoneInk()) {
      collectHullTargets(root, minWorldRadius, filter, phoneInkQueue);
    }
    return;
  }
  // Both gates sit OUTSIDE the shield so the early-return path stays free.
  withInkRng(() => addGroupHullsInner(root, minWorldRadius, filter));
}

/** The meshes addGroupHullsInner would hull in `root`, with the hull
 *  thickness it would give each (the same guards, the same floor). */
function collectHullTargets(
  root: THREE.Object3D,
  minWorldRadius: number,
  filter: ((m: THREE.Mesh) => boolean) | undefined,
  out: Array<{ mesh: THREE.Mesh; thickness: number }>,
): void {
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || (m as unknown as { isSkinnedMesh?: boolean }).isSkinnedMesh) return;
    if (m.userData.isCelHull || m.userData.hasCelHull) return;
    if (filter) {
      if ((m as unknown as { isInstancedMesh?: boolean }).isInstancedMesh) return;
      const mat = m.material as THREE.Material | THREE.Material[];
      if (!Array.isArray(mat) && mat?.transparent === true) return;
      if (m.geometry.type === 'PlaneGeometry') return;
      if (!filter(m)) return;
    }
    if (!m.geometry.boundingSphere) m.geometry.computeBoundingSphere();
    const r = (m.geometry.boundingSphere?.radius ?? 0) * m.getWorldScale(_wScale).x;
    if (r < minWorldRadius) return;
    out.push({ mesh: m, thickness: Math.min(0.05, Math.max(0.008, r * 0.03)) });
  });
}

// ── ?phoneink=1: one merged static hull per district (C4, decision 15) ─────
//
// The low tier stays ink-free by default (the gate above). With ?phoneink=1
// the architecture calls are recorded instead, and flushPhoneInk bakes them,
// once every hall and prop is seated, into ONE world-space hull per district:
// a draw each, the one ink program, and no per-part hull objects.

/** addGroupHulls' opt-in for ?phoneink=1: pass it only from architecture
 *  that never moves, hides or is swapped (halls, houses, stalls, gates,
 *  zone markers, fountain, bandstand, kiosks, quest mailboxes, project boards). */
export const STATIC_INK = { staticInk: true } as const;

let phoneInkParam: boolean | null = null;
/** Set once flushPhoneInk has run: later staticInk calls queue nothing. */
let phoneInkFlushed = false;
/** ?phoneink=1, read once (as SimpleRenderer reads ?halfshadow). */
export function isPhoneInk(): boolean {
  if (phoneInkParam === null) {
    try {
      phoneInkParam =
        typeof window !== 'undefined' &&
        new URLSearchParams(window.location.search).get('phoneink') === '1';
    } catch {
      phoneInkParam = false;
    }
  }
  return phoneInkParam;
}

/** Test seam: forget the cached ?phoneink read (and anything queued). */
export function resetPhoneInkForTest(): void {
  phoneInkParam = null;
  phoneInkFlushed = false;
  phoneInkQueue.length = 0;
}

const phoneInkQueue: Array<{ mesh: THREE.Mesh; thickness: number }> = [];

/** The phone-ink district hulls stay under this many triangles in all. */
export const PHONE_INK_MAX_TRIANGLES = 40000;

const _hv = new THREE.Vector3();
const _hm = new THREE.Matrix4();

/** Append `geo`'s indexed triangles (positions only) through `matrix` into
 *  the growing arrays. Returns the triangles appended. */
function appendHullTriangles(
  geo: THREE.BufferGeometry,
  matrix: THREE.Matrix4,
  pos: number[],
  idx: number[],
): number {
  const p = geo.getAttribute('position');
  const base = pos.length / 3;
  for (let i = 0; i < p.count; i++) {
    _hv.fromBufferAttribute(p, i).applyMatrix4(matrix);
    pos.push(_hv.x, _hv.y, _hv.z);
  }
  const index = geo.getIndex();
  if (index) {
    for (let i = 0; i < index.count; i++) idx.push(base + index.getX(i));
    return index.count / 3;
  }
  for (let i = 0; i < p.count; i++) idx.push(base + i);
  return p.count / 3;
}

/** True when `o` and every ancestor up to `root` are visible and `root`
 *  is one of its ancestors (a hidden placeholder bakes no ink). */
function isShownInScene(o: THREE.Object3D, root: THREE.Object3D): boolean {
  for (let p: THREE.Object3D | null = o; p; p = p.parent) {
    if (!p.visible) return false;
    if (p === root) return true;
  }
  return false;
}

/** One position-only hull mesh from merged triangles, on the shared ink. */
function mergedHullMesh(pos: number[], idx: number[], name: string): THREE.Mesh {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeBoundingSphere();
  const hull = new THREE.Mesh(geo, getInkMat());
  hull.name = name;
  hull.userData.isCelHull = true;
  hull.raycast = () => {};
  hull.castShadow = false;
  hull.receiveShadow = false;
  hull.matrixAutoUpdate = false; // static: baked in its parent's space
  return hull;
}

/**
 * ?phoneink=1 on the low tier: merge every recorded architecture hull into
 * one static world-space mesh per district (the nearest anchor; the halls'
 * beacons are the district centres) and add them to `scene`. Runs once, after
 * placement; a no-op without the flag, on desktop, or with nothing recorded.
 * Returns the triangles built (0 when it did nothing).
 */
export function flushPhoneInk(scene: THREE.Object3D, anchors: THREE.Vector3[]): number {
  phoneInkFlushed = true;
  if (!phoneInkQueue.length || !anchors.length) {
    phoneInkQueue.length = 0;
    return 0;
  }
  const queue = phoneInkQueue.splice(0);
  return withInkRng(() => {
    scene.updateMatrixWorld(true);
    const buckets = anchors.map(() => ({ pos: [] as number[], idx: [] as number[] }));
    let tris = 0;
    // Biggest parts first, so the triangle cap drops the smallest detail.
    const ranked = queue
      .filter((e) => e.mesh.parent && isShownInScene(e.mesh, scene))
      .map((e) => ({ ...e, size: e.thickness }))
      .sort((a, b) => b.size - a.size);
    for (const e of ranked) {
      const geo = bakeHullGeometry(e.mesh.geometry, e.thickness / e.mesh.getWorldScale(_wScale).x);
      const n = (geo.getIndex()?.count ?? geo.getAttribute('position').count) / 3;
      if (tris + n > PHONE_INK_MAX_TRIANGLES) continue;
      e.mesh.getWorldPosition(_hv);
      let best = 0;
      let bestD = Infinity;
      for (let a = 0; a < anchors.length; a++) {
        const d = _hv.distanceToSquared(anchors[a]);
        if (d < bestD) {
          bestD = d;
          best = a;
        }
      }
      tris += appendHullTriangles(geo, e.mesh.matrixWorld, buckets[best].pos, buckets[best].idx);
      e.mesh.userData.hasCelHull = true;
    }
    // World space: undo the scene root's own transform (identity in the game).
    _hm.copy(scene.matrixWorld).invert();
    buckets.forEach((b, i) => {
      if (!b.idx.length) return;
      const hull = mergedHullMesh(b.pos, b.idx, `phoneink_${i}`);
      hull.matrix.copy(_hm);
      scene.add(hull);
    });
    return tris;
  });
}

/**
 * Ink for a GLB fleet that collapseClonesToInstances re-packed into
 * InstancedMesh (benches, mailboxes, lamps). Each part that clears the size
 * floor is baked once and repeated at every instance's matrix into ONE static
 * hull mesh under `parent` (the instances' own space): one draw for the whole
 * fleet, on the ink material every other hull already compiled, so no new
 * program. Desktop cel only, inside the ink shield. Returns the hull, or null.
 */
export function addFleetHull(
  parent: THREE.Object3D,
  parts: Array<{ geometry: THREE.BufferGeometry; matrices: THREE.Matrix4[] }>,
  minWorldRadius: number,
  name: string,
): THREE.Mesh | null {
  if (!isCelTheme()) return null;
  if (SimpleRenderer.isLowTierDevice()) return null;
  return withInkRng(() => {
    const pos: number[] = [];
    const idx: number[] = [];
    const s = new THREE.Vector3();
    for (const part of parts) {
      if (!part.matrices.length) continue;
      if (!part.geometry.boundingSphere) part.geometry.computeBoundingSphere();
      s.setFromMatrixScale(part.matrices[0]);
      const r = (part.geometry.boundingSphere?.radius ?? 0) * s.x;
      if (r < minWorldRadius) continue;
      const t = Math.min(0.05, Math.max(0.008, r * 0.03));
      const geo = bakeHullGeometry(part.geometry, t / Math.max(1e-6, s.x));
      for (const m of part.matrices) appendHullTriangles(geo, m, pos, idx);
    }
    if (!idx.length) return null;
    const hull = mergedHullMesh(pos, idx, name);
    // The fleets ring the planet, so the merged bounding sphere spans the
    // world and the hull culls all-or-nothing, as the instances do.
    hull.updateMatrix();
    parent.add(hull);
    return hull;
  });
}

function addGroupHullsInner(
  root: THREE.Object3D,
  minWorldRadius: number,
  filter?: (m: THREE.Mesh) => boolean,
): void {
  const targets: THREE.Mesh[] = [];
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || (m as unknown as { isSkinnedMesh?: boolean }).isSkinnedMesh) return;
    if (m.userData.isCelHull) return;
    if (filter) {
      // Guarded path — ACTIVE ONLY when a filter arg is passed. Legacy 2-arg
      // call sites (cats/herons/palms/birds/campfire) take the untouched code
      // path above, keeping their shipped output byte-identical (the
      // never-re-author-the-outline law). New architecture call sites pass
      // `() => true` to opt in to these guards without a name filter.
      if ((m as unknown as { isInstancedMesh?: boolean }).isInstancedMesh) return;
      const mat = m.material as THREE.Material | THREE.Material[];
      if (!Array.isArray(mat) && mat?.transparent === true) return; // glass, glow cones
      if (m.geometry.type === 'PlaneGeometry') return; // windows, decals — a hull z-fights
      if (!filter(m)) return;
    }
    targets.push(m);
  });
  for (const m of targets) {
    // Idempotence, mirroring addSkinnedHull's existing hasCelHull guard: a
    // second call on the same group would otherwise stack a SECOND hull on
    // every source mesh (measured 3 -> 6). Byte-identical for the single-call
    // sites that ship today; it just makes a re-render safe.
    if (m.userData.hasCelHull) continue;
    if (!m.geometry.boundingSphere) m.geometry.computeBoundingSphere();
    const r = (m.geometry.boundingSphere?.radius ?? 0) * m.getWorldScale(_wScale).x;
    if (r < minWorldRadius) continue;
    // Guarded (architecture) path: the fauna cap of 0.016u is SUB-PIXEL on a
    // 3u building past ~15u — 111 draws for invisible lines. Buildings carry
    // thicker ink (capped 0.05u), gated on `filter` so every legacy call site
    // keeps its shipped thickness byte-identical.
    const t = filter
      ? Math.min(0.05, Math.max(0.008, r * 0.03))
      : Math.min(0.016, Math.max(0.006, r * 0.045));
    const hull = new THREE.Mesh(bakeHullGeometry(m.geometry, t), getInkMat());
    hull.userData.isCelHull = true;
    m.userData.hasCelHull = true;
    hull.raycast = () => {}; // camera collision + feed aim must never hit ink
    hull.castShadow = false;
    m.add(hull); // identity transform: rides the part's animation
  }
}

/**
 * Add an ink hull to a SkinnedMesh (the villager path): a sibling SkinnedMesh
 * on the same skeleton/bind, geometry pre-inflated in bind pose. Call AFTER
 * SkeletonUtils.clone + dressNpc so each hull binds ITS villager's skeleton.
 */
export function addSkinnedHull(src: THREE.SkinnedMesh, thickness = 0.014): void {
  if (!isCelTheme() || !src.parent) return;
  if (SimpleRenderer.isLowTierDevice()) return; // same phone gate as group hulls
  // NEVER hull a hull: sibling-inserting during a caller's traverse means the
  // new hull itself gets visited by that same traverse.
  if (src.userData.isCelHull || src.userData.hasCelHull) return;
  src.userData.hasCelHull = true;
  withInkRng(() => {
    const hull = new THREE.SkinnedMesh(bakeHullGeometry(src.geometry, thickness), getInkMat());
    hull.userData.isCelHull = true;
    hull.raycast = () => {};
    hull.castShadow = false;
    hull.position.copy(src.position);
    hull.quaternion.copy(src.quaternion);
    hull.scale.copy(src.scale);
    src.parent!.add(hull);
    hull.bind(src.skeleton, src.bindMatrix);
    // Cull the hull WITH its villager, not from anywhere on the planet. The
    // body already got the pose-proof cull (NPC.ts inflates the object-level
    // boundingSphere 2.5x — Frustum.intersectsObject prefers it and it rides
    // matrixWorld), but the hull kept a blunt frustumCulled=false, so all
    // villager hull SkinnedMeshes (5/villager x 28) were GPU-skinned AND drawn
    // in the main pass EVERY frame regardless of camera while their bodies
    // culled. Same 2.5x sphere here makes hull and body cull together. MUST run
    // AFTER bind(): SkinnedMesh.computeBoundingSphere skins the vertices
    // through the skeleton, so with no skeleton bound it yields a null sphere
    // (measured: hulls then fell back to bind-pose geometry bounds — the exact
    // pop the old frustumCulled=false was avoiding).
    hull.computeBoundingSphere();
    if (hull.boundingSphere) hull.boundingSphere.radius *= 2.5;
  });
}
