// @vitest-environment happy-dom
//
// GRASS MARSHAL EQUIVALENCE — characterization hash of the grass instance data.
//
// The golden RNG census (tierParity) only hashes grass COUNT, not the per-blade
// matrices/colours, and grass can't be eyeballed headless — so a refactor of the
// Phase-A marshaling (number[] push -> preallocated typed arrays) could reorder
// or corrupt blade transforms invisibly. This pins the EXACT float output of
// every grass_sector chunk (instanceMatrix + instanceColor) at both tiers, so
// the typed-array rewrite must reproduce it bit-for-bit. createGrass is
// RNG-shielded (mulberry32), so the output is deterministic run-to-run.
import * as THREE from 'three';
import { describe, expect, test, vi } from 'vitest';

import { Island } from '../Island';
import { SimpleRenderer } from '../SimpleRenderer';
import { WORLD_RADIUS } from '../WorldScale';
import { installHeadlessCanvas } from './helpers/headlessDom';

// FNV-1a over a Float32 stream (bit pattern, so -0 / NaN order is pinned too).
const hashFloats = (chunks: Float32Array[]): string => {
  let h = 0x811c9dc5;
  const dv = new DataView(new ArrayBuffer(4));
  for (const a of chunks) {
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

const grassCensus = (lowTier: boolean): { hash: string; blades: number; chunks: number } => {
  const spy = vi.spyOn(SimpleRenderer, 'isLowTierDevice').mockReturnValue(lowTier);
  installHeadlessCanvas();
  const island = new Island(WORLD_RADIUS);
  const mats: Float32Array[] = [];
  const cols: Float32Array[] = [];
  let blades = 0;
  let chunks = 0;
  island.mesh.traverse((o) => {
    const im = o as THREE.InstancedMesh;
    if (im.isInstancedMesh && /^grass_sector_/.test(o.name || '')) {
      chunks++;
      blades += im.count;
      mats.push(im.instanceMatrix.array as Float32Array);
      if (im.instanceColor) cols.push(im.instanceColor.array as Float32Array);
    }
  });
  spy.mockRestore();
  return { hash: hashFloats([...mats, ...cols]), blades, chunks };
};

describe('grass instance marshaling is byte-stable (guards the typed-array rewrite)', () => {
  // GOLDEN — captured from the number[]-push implementation before the rewrite.
  // If a legitimate grass-generation change lands, re-bless from the printed
  // actuals in the SAME commit; never loosen this to hide a marshaling drift.
  //
  // Explicit timeouts: each test builds a FULL island in its body against the
  // default 5s deadline — machine load made these the flakiest tests in the
  // suite (a timeout FAIL that read like a hash drift; see terrainNoise).
  test('desktop grass matches the blessed golden', () => {
    const c = grassCensus(false);
    expect({ hash: c.hash, blades: c.blades, chunks: c.chunks }).toEqual({
      hash: '20c0f87b',
      blades: 10117,
      chunks: 15,
    });
  }, 120000);

  test('low-tier grass matches the blessed golden', () => {
    const c = grassCensus(true);
    expect({ hash: c.hash, blades: c.blades, chunks: c.chunks }).toEqual({
      hash: 'c184c0df',
      blades: 2623,
      chunks: 15,
    });
  }, 120000);
});
