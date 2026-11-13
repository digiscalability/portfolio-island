// @vitest-environment happy-dom
//
// The ink outline is theme- AND tier-gated: it does not run under
// ?theme=real or on low-tier devices. Island construction happens inside
// GameScene.initialize's SEEDED window, and RNG-scattered props (parked cars,
// which become index-networked drivable vehicles) are placed from that same
// stream. So if the ink consumed ambient Math.random draws, a phone and a
// desktop would build DIFFERENT worlds — which is exactly what shipped until
// the shield landed (measured: all 8 parked cars displaced, car_0 by 6.35u of
// arc at R=75). This suite pins the shield.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { describe, expect, test, vi } from 'vitest';

import { a11y } from '../Accessibility';
import { fx } from '../FxBudget';
import {
  addFleetHull,
  addGroupHulls,
  applyCanopySway,
  bakeCanopyWeights,
  canopyPhase,
  CANOPY_SWAY,
  canopySwayOffset,
  flushPhoneInk,
  PHONE_INK_MAX_TRIANGLES,
  resetPhoneInkForTest,
  STATIC_INK,
} from '../CelLook';

const boxGroup = (n: number): THREE.Group => {
  const g = new THREE.Group();
  for (let i = 0; i < n; i++) {
    const m = new THREE.Mesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshStandardMaterial({ color: 0x808080 }),
    );
    m.position.set(i * 2, 0, 0);
    g.add(m);
  }
  return g;
};

const countHulls = (root: THREE.Object3D): number => {
  let n = 0;
  root.traverse((o) => {
    if (o.userData && o.userData.isCelHull) n++;
  });
  return n;
};

describe('cel ink RNG shield', () => {
  test('addGroupHulls inks the group but consumes ZERO ambient draws', () => {
    const g = boxGroup(6);
    const spy = vi.spyOn(Math, 'random');
    spy.mockClear();
    addGroupHulls(g);
    const ambient = spy.mock.calls.length;
    spy.mockRestore();
    expect(countHulls(g)).toBe(6); // the ink really ran…
    expect(ambient).toBe(0); // …and the shared stream paid nothing
  });

  test('the guarded (filter) path is shielded too', () => {
    const g = boxGroup(4);
    const spy = vi.spyOn(Math, 'random');
    spy.mockClear();
    addGroupHulls(g, 0.12, () => true);
    const ambient = spy.mock.calls.length;
    spy.mockRestore();
    expect(countHulls(g)).toBe(4);
    expect(ambient).toBe(0);
  });

  test('re-inking is idempotent — hulls never hull themselves', () => {
    const g = boxGroup(3);
    addGroupHulls(g);
    const after1 = countHulls(g);
    addGroupHulls(g);
    expect(countHulls(g)).toBe(after1);
  });
});

// 'toonify RNG shield' (GameScene.toonifyIslandMaterials, B's code) moved to
// B's test/sceneLocks.test.ts in stage 2 wave 1 (CO-B2; testOwnership rule 1).

// C4: ink on everything that stands. The GLB fleets (benches, mailboxes,
// lamps) are re-packed into InstancedMesh after load, and the phone keeps its
// ink-free default with ?phoneink=1 as the one opt-in.
// The low tier as the device reports it (SimpleRenderer.isLowTierDevice reads
// the core count), so this suite stubs the device rather than E's renderer.
const lowTier = (): { mockRestore: () => void } =>
  vi.spyOn(navigator, 'hardwareConcurrency', 'get').mockReturnValue(2);

const triCount = (g: THREE.BufferGeometry): number =>
  (g.getIndex()?.count ?? g.getAttribute('position').count) / 3;

describe('fleet ink (GLB fleets re-packed into InstancedMesh)', () => {
  test('one hull mesh for the whole fleet, every instance, no ambient draws', () => {
    const parent = new THREE.Group();
    const big = new THREE.BoxGeometry(1, 1, 1);
    const tiny = new THREE.BoxGeometry(0.05, 0.05, 0.05);
    const at = (x: number): THREE.Matrix4 => new THREE.Matrix4().makeTranslation(x, 0, 0);
    const spy = vi.spyOn(Math, 'random');
    spy.mockClear();
    const hull = addFleetHull(
      parent,
      [
        { geometry: big, matrices: [at(0), at(3), at(6)] },
        { geometry: tiny, matrices: [at(0), at(3), at(6)] }, // under the floor
      ],
      0.2,
      'glbfleet_test_ink',
    );
    const ambient = spy.mock.calls.length;
    spy.mockRestore();
    expect(ambient).toBe(0);
    expect(hull).not.toBeNull();
    expect(parent.children).toEqual([hull]);
    expect(hull!.userData.isCelHull).toBe(true);
    // Three boxes of 12 triangles: the tiny part is skipped.
    expect(triCount(hull!.geometry)).toBe(36);
    // The same ink material every other hull uses: no new program.
    const g = boxGroup(1);
    addGroupHulls(g, 0.12, () => true);
    let groupInk: THREE.Material | null = null;
    g.traverse((o) => {
      if (o.userData.isCelHull) groupInk = (o as THREE.Mesh).material as THREE.Material;
    });
    expect(hull!.material).toBe(groupInk);
    // Inflated: the hull's extent passes the source's (0.5 + thickness).
    hull!.geometry.computeBoundingBox();
    expect(hull!.geometry.boundingBox!.min.x).toBeLessThan(-0.5);
  });

  test('the low tier builds no fleet hull', () => {
    const spy = lowTier();
    try {
      const parent = new THREE.Group();
      const hull = addFleetHull(
        parent,
        [{ geometry: new THREE.BoxGeometry(1, 1, 1), matrices: [new THREE.Matrix4()] }],
        0.2,
        'x',
      );
      expect(hull).toBeNull();
      expect(parent.children.length).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('phone ink (?phoneink=1 on the low tier, decision 15)', () => {
  const withUrl = (search: string, fn: () => void): void => {
    const prev = window.location.href;
    window.history.replaceState(null, '', search);
    resetPhoneInkForTest();
    const spy = lowTier();
    try {
      fn();
    } finally {
      spy.mockRestore();
      window.history.replaceState(null, '', prev);
      resetPhoneInkForTest();
    }
  };

  test('by default the phone stays ink-free: nothing hulled, nothing to flush', () => {
    withUrl('/?hour=12', () => {
      const scene = new THREE.Scene();
      const g = boxGroup(3);
      scene.add(g);
      addGroupHulls(g, 0.12, () => true, STATIC_INK);
      expect(countHulls(scene)).toBe(0);
      expect(flushPhoneInk(scene, [new THREE.Vector3()])).toBe(0);
      expect(countHulls(scene)).toBe(0);
    });
  });

  test('?phoneink=1: one merged static hull per district, shielded, under the cap', () => {
    withUrl('/?phoneink=1', () => {
      const scene = new THREE.Scene();
      const west = boxGroup(3);
      const east = boxGroup(2);
      east.position.set(100, 0, 0);
      scene.add(west, east);
      const spy = vi.spyOn(Math, 'random');
      spy.mockClear();
      addGroupHulls(west, 0.12, () => true, STATIC_INK);
      addGroupHulls(east, 0.12, () => true, STATIC_INK);
      // Recording only: no per-part hull exists on a phone.
      expect(countHulls(scene)).toBe(0);
      const tris = flushPhoneInk(scene, [new THREE.Vector3(0, 0, 0), new THREE.Vector3(100, 0, 0)]);
      const ambient = spy.mock.calls.length;
      spy.mockRestore();
      expect(ambient).toBe(0);
      const hulls = scene.children.filter((o) => o.userData.isCelHull) as THREE.Mesh[];
      expect(hulls.map((h) => h.name).sort()).toEqual(['phoneink_0', 'phoneink_1']);
      expect(hulls.map((h) => triCount(h.geometry)).sort((a, b) => a - b)).toEqual([24, 36]);
      expect(tris).toBe(60);
      // C9: the merged hulls carry explicit zero canopy weights (never the
      // context's generic attribute value), so they never sway.
      for (const h of hulls) {
        const a = h.geometry.getAttribute('aCanopy');
        expect(a.count).toBe(h.geometry.getAttribute('position').count);
        expect(Array.from(a.array as Float32Array).every((v) => v === 0)).toBe(true);
      }
      expect(tris).toBeLessThanOrEqual(PHONE_INK_MAX_TRIANGLES);
      // A second flush has nothing left to bake.
      expect(flushPhoneInk(scene, [new THREE.Vector3()])).toBe(0);
    });
  });

  test('a filtered call without STATIC_INK (cars, playground, gazebos) queues nothing', () => {
    withUrl('/?phoneink=1', () => {
      const scene = new THREE.Scene();
      const g = boxGroup(3);
      scene.add(g);
      addGroupHulls(g, 0.12, () => true);
      expect(flushPhoneInk(scene, [new THREE.Vector3()])).toBe(0);
      expect(countHulls(scene)).toBe(0);
    });
  });

  test('a hidden mesh (a placeholder a GLB replaced) bakes no ink', () => {
    withUrl('/?phoneink=1', () => {
      const scene = new THREE.Scene();
      const shown = boxGroup(2);
      const hidden = boxGroup(3);
      const parentHidden = new THREE.Group();
      const child = boxGroup(1);
      parentHidden.add(child);
      parentHidden.visible = false;
      hidden.children.forEach((c) => (c.visible = false));
      scene.add(shown, hidden, parentHidden);
      addGroupHulls(shown, 0.12, () => true, STATIC_INK);
      addGroupHulls(hidden, 0.12, () => true, STATIC_INK);
      addGroupHulls(child, 0.12, () => true, STATIC_INK);
      const tris = flushPhoneInk(scene, [new THREE.Vector3()]);
      expect(tris).toBe(24);
      const hulls = scene.children.filter((o) => o.userData.isCelHull) as THREE.Mesh[];
      expect(hulls.map((h) => triCount(h.geometry))).toEqual([24]);
    });
  });

  test('after the flush a late STATIC_INK call queues and builds nothing', () => {
    withUrl('/?phoneink=1', () => {
      const scene = new THREE.Scene();
      const early = boxGroup(1);
      scene.add(early);
      addGroupHulls(early, 0.12, () => true, STATIC_INK);
      expect(flushPhoneInk(scene, [new THREE.Vector3()])).toBe(12);
      const late = boxGroup(2);
      scene.add(late);
      addGroupHulls(late, 0.12, () => true, STATIC_INK);
      expect(countHulls(scene)).toBe(1);
      expect(flushPhoneInk(scene, [new THREE.Vector3()])).toBe(0);
      expect(countHulls(scene)).toBe(1);
    });
  });

  test('the legacy two-argument path (fauna) is never inked on a phone', () => {
    withUrl('/?phoneink=1', () => {
      const scene = new THREE.Scene();
      const g = boxGroup(2);
      scene.add(g);
      addGroupHulls(g);
      expect(flushPhoneInk(scene, [new THREE.Vector3()])).toBe(0);
    });
  });
});

// ── C9: tree canopies breathe, outlines attached ─────────────────────────────

/** A tree as Island builds one: a trunk part (flag 0) and crown parts (flag 1),
 *  non-indexed, merged, then weighted (h/H)^2. */
const swayTree = (): THREE.Mesh => {
  const part = (geo: THREE.BufferGeometry, y: number, canopy: boolean): THREE.BufferGeometry => {
    geo.translate(0, y, 0);
    const g = geo.index ? geo.toNonIndexed() : geo;
    g.deleteAttribute('uv');
    const n = g.getAttribute('position').count;
    g.setAttribute(
      'aCanopy',
      new THREE.BufferAttribute(new Float32Array(n).fill(canopy ? 1 : 0), 1),
    );
    return g;
  };
  const parts = [
    part(new THREE.CylinderGeometry(0.16, 0.32, 2.4, 6), 1.2, false),
    part(new THREE.DodecahedronGeometry(1.4, 0), 3.0, true),
    part(new THREE.DodecahedronGeometry(0.7, 0), 3.5, true),
  ];
  const geo = mergeGeometries(parts, false) as THREE.BufferGeometry;
  bakeCanopyWeights(geo, geo.getAttribute('aCanopy').array as Float32Array);
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true }));
  mesh.name = 'tree_body';
  return mesh;
};

/** Each vertex's local position after the chunk's offset at time t. */
const swayed = (geo: THREE.BufferGeometry, t: number, phase: number, amp = 1): THREE.Vector3[] => {
  const pos = geo.getAttribute('position');
  const w = geo.getAttribute('aCanopy');
  const out: THREE.Vector3[] = [];
  for (let i = 0; i < pos.count; i++) {
    const [dx, dz] = canopySwayOffset(w.getX(i), t, phase, amp);
    out.push(new THREE.Vector3(pos.getX(i) + dx, pos.getY(i), pos.getZ(i) + dz));
  }
  return out;
};

const hullOf = (m: THREE.Object3D): THREE.Mesh =>
  m.children.find((c) => c.userData.isCelHull) as THREE.Mesh;

describe('C9: canopy sway, outlines attached', () => {
  test("a tree's hull keeps its body's weights, so the ink rides the crown within 0.01 u", () => {
    const g = new THREE.Group();
    g.position.set(31, 62, -12);
    const body = swayTree();
    g.add(body);
    g.updateMatrixWorld(true);
    addGroupHulls(g); // the trees' legacy two-argument call
    const hull = hullOf(body);
    expect(hull).toBeDefined();
    const bw = body.geometry.getAttribute('aCanopy');
    const hw = hull.geometry.getAttribute('aCanopy');
    expect(hw.count).toBe(bw.count);
    // Body and hull share the mesh's world translation, so one phase.
    const wp = body.getWorldPosition(new THREE.Vector3());
    const phase = canopyPhase(wp.x, wp.y, wp.z);
    const bp = body.geometry.getAttribute('position');
    const hp = hull.geometry.getAttribute('position');
    let maxGap = 0;
    let maxTravel = 0;
    let trunkTravel = 0;
    for (const t of [0, 0.7, 2.1, 5.3, 6.28, 11.9, 24.6]) {
      const b = swayed(body.geometry, t, phase);
      const h = swayed(hull.geometry, t, phase);
      for (let i = 0; i < b.length; i++) {
        const restGap = new THREE.Vector3()
          .fromBufferAttribute(hp, i)
          .distanceTo(new THREE.Vector3().fromBufferAttribute(bp, i));
        maxGap = Math.max(maxGap, Math.abs(h[i].distanceTo(b[i]) - restGap));
        const travel = b[i].distanceTo(new THREE.Vector3().fromBufferAttribute(bp, i));
        maxTravel = Math.max(maxTravel, travel);
        if (bw.getX(i) === 0) trunkTravel = Math.max(trunkTravel, travel);
      }
    }
    expect(maxGap).toBeLessThanOrEqual(0.01);
    expect(trunkTravel).toBe(0); // trunks stay plumb
    expect(maxTravel).toBeGreaterThan(0.03); // the crown really moves
    expect(maxTravel).toBeLessThanOrEqual(Math.hypot(0.3 + 0.06, 0.18) * 1.7 + 1e-9);
  });

  test('the crown traces an ellipse, so it moves on screen from any side (env.cjs bar)', () => {
    // The brief's single-axis 0.06/0.02 u moved a crown top about 3 px at 30 u
    // in E's env.cjs (pixels); the bar is 15-30 px. The amplitudes are 5x/3x
    // and the cross term (cos of the slow term) keeps the minor axis open.
    expect(CANOPY_SWAY.amp).toBe(0.3);
    expect(CANOPY_SWAY.ampFast).toBe(0.06);
    expect(CANOPY_SWAY.ampCross).toBe(0.18);
    const main = [CANOPY_SWAY.dirX, CANOPY_SWAY.dirZ];
    let minMain = Infinity;
    let maxMain = -Infinity;
    let minCross = Infinity;
    let maxCross = -Infinity;
    const T = (2 * Math.PI) / CANOPY_SWAY.w;
    for (let k = 0; k < 400; k++) {
      const [dx, dz] = canopySwayOffset(1, (k / 400) * T, 0.7);
      const a = dx * main[0] + dz * main[1];
      const c = -dx * main[1] + dz * main[0];
      minMain = Math.min(minMain, a);
      maxMain = Math.max(maxMain, a);
      minCross = Math.min(minCross, c);
      maxCross = Math.max(maxCross, c);
    }
    expect(maxMain - minMain).toBeGreaterThan(0.5); // about 0.6 u peak to peak at gust 1
    expect(maxCross - minCross).toBeGreaterThan(0.3); // the minor axis, not a line
  });

  test('a house hull carries zero-filled aCanopy and gets 0 displacement', () => {
    const g = boxGroup(1);
    addGroupHulls(g, 0.12, () => true, STATIC_INK);
    const hull = hullOf(g.children[0]);
    const a = hull.geometry.getAttribute('aCanopy');
    expect(a).toBeDefined();
    expect(a.count).toBe(hull.geometry.getAttribute('position').count);
    expect(Array.from(a.array as Float32Array).every((v) => v === 0)).toBe(true);
    const rest = hull.geometry.getAttribute('position');
    for (const t of [0, 3.3, 9.1]) {
      const s = swayed(hull.geometry, t, 1.234);
      for (let i = 0; i < s.length; i++) {
        expect(s[i].distanceTo(new THREE.Vector3().fromBufferAttribute(rest, i))).toBe(0);
      }
    }
  });

  test('the shared ink material and the tree material take one chunk, keyed once', () => {
    const g = boxGroup(1);
    addGroupHulls(g);
    const ink = hullOf(g.children[0]).material as THREE.Material;
    const shader = {
      uniforms: {} as Record<string, { value: unknown }>,
      vertexShader: 'void main() {\n#include <begin_vertex>\n}',
      fragmentShader: '',
    };
    ink.onBeforeCompile(
      shader as unknown as THREE.WebGLProgramParametersWithUniforms,
      {} as THREE.WebGLRenderer,
    );
    expect(shader.vertexShader).toContain('attribute float aCanopy;');
    expect(shader.vertexShader.match(/C9 canopy sway/g)).toHaveLength(1);
    expect(shader.vertexShader).toContain('modelMatrix[ 3 ].xyz');
    // Gust is GameScene.update's own formula, from the grass clock.
    expect(shader.vertexShader).toContain('1.0 + 0.700 * max( 0.0, sin( cT * 0.250 ) )');
    // The cross term mirrors canopySwayOffset's.
    expect(shader.vertexShader).toContain('0.180 * cos( cT * 0.800 + cPh )');
    expect(Object.keys(shader.uniforms).sort()).toEqual(['uCanopyAmp', 'uCanopyTime']);
    // Idempotent: a second application does not stack a second chunk.
    applyCanopySway(ink);
    const again = { ...shader, vertexShader: 'void main() {\n#include <begin_vertex>\n}' };
    ink.onBeforeCompile(
      again as unknown as THREE.WebGLProgramParametersWithUniforms,
      {} as THREE.WebGLRenderer,
    );
    expect(again.vertexShader.match(/C9 canopy sway/g)).toHaveLength(1);
    expect(ink.customProgramCacheKey()).toMatch(/\|canopy-v1$/);
  });

  test("reduced motion halves the amplitude, and the 'canopySway' switch zeroes it", () => {
    const g = boxGroup(1);
    addGroupHulls(g);
    const ink = hullOf(g.children[0]).material as THREE.Material;
    const shader = {
      uniforms: {} as Record<string, { value: number }>,
      vertexShader: 'void main() {}',
      fragmentShader: '',
    };
    ink.onBeforeCompile(
      shader as unknown as THREE.WebGLProgramParametersWithUniforms,
      {} as THREE.WebGLRenderer,
    );
    const amp = (): number => shader.uniforms.uCanopyAmp.value;
    const g2 = globalThis as unknown as { __dsFx?: Record<string, unknown> };
    const prevFx = g2.__dsFx;
    const prevRm = a11y.reducedMotion;
    try {
      a11y.reducedMotion = false;
      g2.__dsFx = { ...(prevFx ?? {}), canopySway: true };
      expect(amp()).toBe(1);
      a11y.reducedMotion = true;
      expect(amp()).toBe(0.5);
      g2.__dsFx = { ...(prevFx ?? {}), canopySway: false };
      expect(amp()).toBe(0);
    } finally {
      a11y.reducedMotion = prevRm;
      g2.__dsFx = prevFx;
    }
    // Half amplitude really halves the offset.
    const [full] = canopySwayOffset(1, 1.1, 0.4, 1);
    const [half] = canopySwayOffset(1, 1.1, 0.4, 0.5);
    expect(half).toBeCloseTo(full / 2, 12);
  });

  test('the amplitude read costs 0 FxBudget µs: no fx.time, even with ?perf=1', () => {
    // perf-gate's ledger holds canopySway at 0 µs (shader-only). The uniform
    // getter runs at every upload, so a stopwatch around it measured its own
    // clock reads (4.4 µs/frame desktop) and failed that line.
    const g = boxGroup(1);
    addGroupHulls(g);
    const ink = hullOf(g.children[0]).material as THREE.Material;
    const shader = {
      uniforms: {} as Record<string, { value: number }>,
      vertexShader: 'void main() {}',
      fragmentShader: '',
    };
    ink.onBeforeCompile(
      shader as unknown as THREE.WebGLProgramParametersWithUniforms,
      {} as THREE.WebGLRenderer,
    );
    const g2 = globalThis as unknown as { __dsFx?: { stats?: Record<string, unknown> } };
    const timeSpy = vi.spyOn(fx, 'time');
    fx.setPerf(true);
    try {
      for (let i = 0; i < 50; i++) void shader.uniforms.uCanopyAmp.value;
      expect(timeSpy).not.toHaveBeenCalled();
      expect(g2.__dsFx?.stats?.canopySway).toBeUndefined();
    } finally {
      fx.setPerf(null);
      timeSpy.mockRestore();
    }
  });
});
