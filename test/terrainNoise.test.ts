// @vitest-environment happy-dom
//
// TERRAIN NOISE EQUIVALENCE — characterization hash of the displaced terrain
// mesh + the sea depth attribute.
//
// terrainRadiusFor drives BOTH the terrain vertex displacement and the sea-depth
// attribute, and every prop/collider position re-derives from it. The golden
// census (tierParity) only pins prop positions to 4 dp, so a sub-4dp ULP shift
// in the octave-noise sum could slip past it while still changing the terrain
// surface. This hashes the FULL terrain position buffer + sea aDepth so the
// "compute noise3D(...,0.16) once" dedupe must be bit-identical. Island build is
// RNG-shielded, so the output is deterministic run-to-run.
import * as THREE from 'three';
import { expect, test } from 'vitest';

import { Island } from '../Island';
import { WORLD_RADIUS } from '../WorldScale';
import { installHeadlessCanvas } from './helpers/headlessDom';

const hashFloats = (arrays: ArrayLike<number>[]): string => {
  let h = 0x811c9dc5;
  const dv = new DataView(new ArrayBuffer(4));
  for (const a of arrays) {
    for (let i = 0; i < a.length; i++) {
      dv.setFloat32(0, a[i]);
      for (let b = 0; b < 4; b++) {
        h ^= dv.getUint8(b);
        h = Math.imul(h, 0x01000193);
      }
    }
  }
  return (h >>> 0).toString(16).padStart(8, '0');
};

test('terrain + sea-depth are bit-stable (guards the noise3D dedupe)', () => {
  installHeadlessCanvas();
  const island = new Island(WORLD_RADIUS);
  let terrainPos: Float32Array | undefined;
  let maxV = 0;
  let seaDepth: Float32Array | undefined;
  island.mesh.traverse((o) => {
    const m = o as THREE.Mesh;
    const pos = m.isMesh ? m.geometry?.attributes?.position : undefined;
    if (pos && pos.count > maxV) {
      maxV = pos.count;
      terrainPos = pos.array as Float32Array;
    }
    if (o.name === 'sea') {
      const d = m.geometry?.attributes?.aDepth;
      if (d) seaDepth = d.array as Float32Array;
    }
  });
  expect(terrainPos).toBeTruthy();
  expect(seaDepth).toBeTruthy();
  const arrays = [terrainPos as Float32Array, seaDepth as Float32Array];
  // GOLDEN — captured before the noise3D(...,0.16) dedupe. Re-bless only on a
  // DELIBERATE terrain change, in the same commit, from the printed actuals.
  expect({
    terrainHash: hashFloats([terrainPos as Float32Array]),
    seaHash: hashFloats([seaDepth as Float32Array]),
    combined: hashFloats(arrays),
    verts: maxV,
  }).toEqual({
    terrainHash: 'd6fe6984',
    seaHash: 'cbf3cd04',
    combined: 'ef9b45c5',
    verts: 337561,
  });
});
