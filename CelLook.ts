/**
 * CelLook — the unified-cel display kit (default theme; owner verdict
 * 2026-08-09 from the art-direction bake-off).
 *
 * Four pieces, all verified against three ~0.180 in the deep-dive:
 *  1. CEL SHADOWS: a global shadowmap chunk patch that thresholds every
 *     shadow term — PCFSoft's penumbra becomes the anti-aliasing of a crisp
 *     cel edge. Apply ONCE before any material compiles.
 *  2. RIM LIGHT: per-material onBeforeCompile injection at
 *     <opaque_fragment> (r154+ name of output_fragment) — a fresnel gated by
 *     the lit side (the BotW recipe), on the CAST only (villagers + player);
 *     rimming everything would flatten the value hierarchy. Sun direction is
 *     a VIEW-SPACE uniform updated per frame through a registry.
 *  3. INK OUTLINES: inverted-hull meshes baked by displacing clone geometry
 *     along SMOOTHED normals (position-hash weld first — the chamfered
 *     avatars carry split normals at hard edges and raw displacement would
 *     tear the hull). Works identically on the composer-less mobile tier,
 *     inherits FogExp2 distance fade. The PLAYER is excluded — its GLB
 *     carries an authored hull (never re-author, per project memory).
 *  4. Warm-key/cool-fill light split (applied in GameScene.setupLighting).
 */
import * as THREE from 'three';

import { isRealTheme } from './Theme';

/** The cel kit runs whenever the real theme ISN'T forced. */
export function isCelTheme(): boolean {
  return !isRealTheme();
}

// ── 1. Cel shadow edges ─────────────────────────────────────────────────────

let shadowPatched = false;

/** Threshold every getShadow variant so soft penumbras read as crisp cel
 *  edges. Call before ANY material compiles (program cache never rebuilds). */
export function applyCelShadowPatch(): void {
  if (shadowPatched || !isCelTheme()) return;
  shadowPatched = true;
  // split/join = replaceAll without needing the es2021 lib target.
  THREE.ShaderChunk.shadowmap_pars_fragment = THREE.ShaderChunk.shadowmap_pars_fragment
    .split('return shadow;')
    .join('return smoothstep( 0.35, 0.65, shadow );');
  console.log('✒️ CelLook: cel shadow-edge patch applied');
}

// ── 2. Rim light on the cast ────────────────────────────────────────────────

type RimUniforms = { uCelSunDir: { value: THREE.Vector3 }; uCelRim: { value: number } };
const rimRegistry: RimUniforms[] = [];
const _sunView = new THREE.Vector3();

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
    };
    Object.assign(shader.uniforms, uniforms);
    rimRegistry.push(uniforms);
    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {', 'uniform vec3 uCelSunDir;\nuniform float uCelRim;\nvoid main() {')
      .replace(
        '#include <opaque_fragment>',
        `{
	// CelLook rim: fresnel gated to the lit side (BotW-style), hard edge.
	float celNdotL = max( dot( normal, uCelSunDir ), 0.0 );
	float celFres = 1.0 - saturate( dot( normalize( vViewPosition ), normal ) );
	float celRim = smoothstep( 0.70, 0.74, celFres * pow( celNdotL, 0.35 ) );
	outgoingLight += vec3( 1.05, 1.0, 0.92 ) * celRim * 0.28 * uCelRim;
}
#include <opaque_fragment>`,
      );
  };
  // Identical injection body across materials → identical cache key → one
  // shared program with per-material uniforms.
  mat.customProgramCacheKey = () => 'cel-rim-v1';
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
function getInkMat(): THREE.MeshBasicMaterial {
  if (!inkMat) {
    inkMat = new THREE.MeshBasicMaterial({
      color: INK_COLOR,
      side: THREE.BackSide,
      fog: true, // Sable-style: lines fade with the same fog as the world
    });
  }
  return inkMat;
}

const hullGeoCache = new Map<string, THREE.BufferGeometry>();

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
export function addGroupHulls(root: THREE.Object3D, minWorldRadius = 0.045): void {
  if (!isCelTheme()) return;
  const targets: THREE.Mesh[] = [];
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || (m as unknown as { isSkinnedMesh?: boolean }).isSkinnedMesh) return;
    if (m.userData.isCelHull) return;
    targets.push(m);
  });
  for (const m of targets) {
    if (!m.geometry.boundingSphere) m.geometry.computeBoundingSphere();
    const r = (m.geometry.boundingSphere?.radius ?? 0) * m.getWorldScale(_wScale).x;
    if (r < minWorldRadius) continue;
    const t = Math.min(0.016, Math.max(0.006, r * 0.045));
    const hull = new THREE.Mesh(bakeHullGeometry(m.geometry, t), getInkMat());
    hull.userData.isCelHull = true;
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
  // NEVER hull a hull: sibling-inserting during a caller's traverse means the
  // new hull itself gets visited by that same traverse.
  if (src.userData.isCelHull || src.userData.hasCelHull) return;
  src.userData.hasCelHull = true;
  const hull = new THREE.SkinnedMesh(bakeHullGeometry(src.geometry, thickness), getInkMat());
  hull.userData.isCelHull = true;
  hull.raycast = () => {};
  hull.castShadow = false;
  hull.frustumCulled = false; // skinned bounds don't follow bones
  hull.position.copy(src.position);
  hull.quaternion.copy(src.quaternion);
  hull.scale.copy(src.scale);
  src.parent.add(hull);
  hull.bind(src.skeleton, src.bindMatrix);
}
