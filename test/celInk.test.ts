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

import { addGroupHulls } from '../CelLook';
import { GameScene } from '../GameScene';

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

describe('toonify RNG shield', () => {
  test('converts materials but consumes ZERO ambient draws', () => {
    // Borrow the real method onto a stub carrying only what it reads
    // (this.island.mesh), the same pattern test/buildPlots.test.ts uses.
    const mesh = new THREE.Group();
    const mats: THREE.MeshStandardMaterial[] = [];
    for (let i = 0; i < 5; i++) {
      const mat = new THREE.MeshStandardMaterial({ color: 0x334455 + i });
      mats.push(mat);
      mesh.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat));
    }
    // A transparent one must be left alone (the shipped rule), and an
    // array-material mesh exercises the map() branch.
    const glass = new THREE.MeshStandardMaterial({ transparent: true });
    mesh.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), glass));
    const multi = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), [mats[0], glass]);
    mesh.add(multi);

    const proto = GameScene.prototype as unknown as Record<string, () => void>;
    // The shield delegates to the inner method, so the stub carries it too
    // (same borrowing pattern as test/buildPlots.test.ts).
    const stub = {
      island: { mesh },
      toonifyIslandMaterialsShielded: proto['toonifyIslandMaterialsShielded'],
    } as unknown as GameScene;
    const toonify = proto['toonifyIslandMaterials'].bind(stub);

    const spy = vi.spyOn(Math, 'random');
    spy.mockClear();
    toonify();
    const ambient = spy.mock.calls.length;
    spy.mockRestore();

    let toonCount = 0;
    let stillTransparent = 0;
    mesh.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      const list = Array.isArray(m.material) ? m.material : [m.material];
      for (const mat of list) {
        if ((mat as THREE.MeshToonMaterial).isMeshToonMaterial) toonCount++;
        if ((mat as THREE.Material).transparent) stillTransparent++;
      }
    });
    expect(toonCount).toBeGreaterThan(0); // it really converted…
    expect(stillTransparent).toBeGreaterThan(0); // …and spared the glass
    expect(ambient).toBe(0); // …and the shared stream paid nothing
  });
});
