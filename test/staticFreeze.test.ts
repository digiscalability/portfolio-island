// @vitest-environment happy-dom
//
// STATIC MATRIX FREEZE — proven-static island subtrees get matrixAutoUpdate off
// at the end of createIsland so three stops recomputing/propagating their world
// matrices every frame. This pins the invariant against the failure mode of the
// reverted first attempt: a name/window classifier that leaked DYNAMIC actors
// (swaying trees, walking NPCs, the moving sun) into the frozen set.
//
// The load-bearing detail is ORDER: bake (root.updateMatrixWorld(true)) BEFORE
// flipping the flags, or the frozen nodes render at the origin. The bake-order
// guard below reads matrixWorld DIRECTLY (not getWorldPosition, which would
// force a recompute and mask the bug).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as THREE from 'three';
import { beforeAll, describe, expect, test } from 'vitest';

import { Island } from '../Island';
import { WORLD_RADIUS } from '../WorldScale';
import { installHeadlessCanvas } from './helpers/headlessDom';

const src = (f: string): string => readFileSync(join(process.cwd(), f), 'utf8');

let island: Island;
const byName = (re: RegExp): THREE.Object3D[] => {
  const out: THREE.Object3D[] = [];
  island.mesh.traverse((o) => {
    if (re.test(o.name || '')) out.push(o);
  });
  return out;
};

beforeAll(() => {
  installHeadlessCanvas();
  island = new Island(WORLD_RADIUS);
});

describe('static matrix freeze — the proven-static subtrees are frozen', () => {
  test('the flowers subtree is fully frozen (both flags off on every node)', () => {
    const flowers = byName(/^flowers$/)[0];
    expect(flowers).toBeTruthy();
    let checked = 0;
    let leaked = 0;
    flowers!.traverse((o) => {
      if (o.userData && (o.userData.animated || o.userData.dynamic)) return;
      checked++;
      if (o.matrixAutoUpdate !== false || o.matrixWorldAutoUpdate !== false) leaked++;
    });
    expect(checked).toBeGreaterThan(10); // it really is a big cluster
    expect(leaked).toBe(0);
  });

  test('house cottages are frozen', () => {
    const houses = byName(/^house_/);
    expect(houses.length).toBeGreaterThan(0);
    for (const h of houses) expect(h.matrixAutoUpdate).toBe(false);
  });

  test('BAKE ORDER: a frozen node keeps its correct baked world position, not the origin', () => {
    // Read matrixWorld DIRECTLY — getWorldPosition would recompute and hide a
    // flip-first bug. A frozen node baked wrong sits at (0,0,0); a correct one
    // sits on the ~R planet surface.
    const p = new THREE.Vector3();
    const houses = byName(/^house_/);
    let maxLen = 0;
    for (const h of houses) {
      p.setFromMatrixPosition(h.matrixWorld);
      maxLen = Math.max(maxLen, p.length());
    }
    // Cottages sit on the surface (~R=100); anything above half-R proves the
    // bake ran before the flags flipped.
    expect(maxLen).toBeGreaterThan(WORLD_RADIUS * 0.5);
  });

  test('the terrain mesh is compose-frozen but keeps matrixWorldAutoUpdate (raycast/BVH)', () => {
    let terrain: THREE.Mesh | undefined;
    let maxV = 0;
    island.mesh.traverse((o) => {
      const m = o as THREE.Mesh;
      const pos = m.isMesh ? m.geometry?.attributes?.position : undefined;
      if (pos && pos.count > maxV) {
        maxV = pos.count;
        terrain = m;
      }
    });
    expect(terrain).toBeTruthy();
    expect(terrain!.matrixAutoUpdate).toBe(false);
    expect(terrain!.matrixWorldAutoUpdate).toBe(true);
  });
});

describe('static matrix freeze — the freeze must NOT leak into dynamic actors', () => {
  test('trees (they sway) still auto-update their matrix', () => {
    const trees = byName(/^tree_/);
    expect(trees.length).toBeGreaterThan(0);
    // At least one tree node must remain auto-updating; a sway write to a frozen
    // node would be silently dropped.
    expect(trees.some((t) => t.matrixAutoUpdate === true)).toBe(true);
  });

  test('the freeze list in source excludes the known-dynamic groups', () => {
    const s = src('Island.ts');
    // Anchor tolerates prettier wrapping the array across lines.
    const i = s.indexOf('for (const g of [');
    expect(i).toBeGreaterThan(-1);
    const line = s.slice(i, s.indexOf(']', i));
    for (const dyn of [
      'trees',
      'npcs',
      'cars',
      'grass',
      'mailboxes',
      'lamps',
      'signs',
      'particles',
    ]) {
      expect(line).not.toContain(dyn);
    }
  });
});
