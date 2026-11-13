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
import { describe, expect, test, vi } from 'vitest';

import {
  addFleetHull,
  addGroupHulls,
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
