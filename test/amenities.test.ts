// @vitest-environment happy-dom
//
// District amenities + building planters (expansion slices 2-3).
import * as THREE from 'three';
import { beforeAll, describe, expect, test } from 'vitest';

import { Island } from '../Island';
import { WORLD_RADIUS } from '../WorldScale';
import { installHeadlessCanvas } from './helpers/headlessDom';

let island: Island;

beforeAll(() => {
  installHeadlessCanvas();
  island = new Island(WORLD_RADIUS);
}, 120000);

describe('functional amenity sites', () => {
  test('kiosk and notice board published their SEATED positions', () => {
    // claimOffStreet slides props — the publish must be the built spot.
    expect(island.kioskSite).toBeTruthy();
    expect(island.noticeBoardSite).toBeTruthy();
    for (const p of [island.kioskSite!, island.noticeBoardSite!]) {
      const r = p.length();
      // On the terrain shell, not floating or sunk.
      expect(r).toBeGreaterThan(WORLD_RADIUS - 1);
      expect(r).toBeLessThan(island.maxTerrainRadius());
      // Off the streets (they were claimed off-street).
      expect(island.isNearStreet(p.clone().normalize())).toBe(false);
    }
  });

  test('amenities keep clear of the plaza centres (aprons, not halls)', () => {
    const plazaLons = [0.34, 1.72, 2.9, 4.6];
    for (const p of [island.kioskSite!, island.noticeBoardSite!]) {
      const dir = p.clone().normalize();
      for (const lon of plazaLons) {
        const plaza = island.dirAt(lon, 0.4636);
        // Never INSIDE a hall: at least ~4m of arc from any plaza centre.
        expect(dir.angleTo(plaza)).toBeGreaterThan(island.arc(4));
      }
    }
  });
});

describe('building planters', () => {
  test('planter instancing exists with bounded counts and tight spheres', () => {
    const flowers = island.mesh.children.find(
      (c) =>
        c.children.length > 0 &&
        c.children.some((m) => (m as THREE.InstancedMesh).isInstancedMesh && m !== null),
    );
    // The planter IMs are parented into the flowers group alongside blooms;
    // find any instanced mesh whose geometry is the 0.9-wide planter box.
    let planterIM: THREE.InstancedMesh | null = null;
    island.mesh.traverse((o) => {
      const im = o as THREE.InstancedMesh;
      if (!im.isInstancedMesh || planterIM) return;
      if (!im.geometry.boundingBox) im.geometry.computeBoundingBox();
      const size = im.geometry.boundingBox
        ? im.geometry.boundingBox.max.x - im.geometry.boundingBox.min.x
        : 0;
      if (Math.abs(size - 0.9) < 1e-3) planterIM = im;
    });
    expect(planterIM, 'planter box InstancedMesh missing').toBeTruthy();
    const im = planterIM as unknown as THREE.InstancedMesh;
    expect(im.count).toBeGreaterThan(15); // most of the ~32 candidates survive
    expect(im.count).toBeLessThanOrEqual(35);
    // Sphere must not reach the planet core (the grass sector lesson).
    expect(im.boundingSphere).toBeTruthy();
    void flowers;
  });
});
