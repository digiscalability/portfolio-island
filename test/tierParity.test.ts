// @vitest-environment happy-dom
//
// TIER PARITY — a phone and a desktop must build the SAME world.
//
// Island is constructed inside GameScene.initialize's SEEDED window
// (installSeededRandom -> new Island -> createVehicles -> restoreRandom), and
// RNG-scattered parked cars become drivable vehicles that multiplayer
// addresses BY INDEX. So any tier-gated code that consumes a different number
// of ambient Math.random draws makes clients disagree about where the world is.
//
// Two such gates shipped and were fixed: the cel ink (now shielded in
// CelLook) and the grass COUNT (`lowTier ? 32000 : ~124k`, now shielded in
// Island.createGrass). Before the grass shield the delta was ~607,000 draws
// and phones built an entirely different boulder field — and rocks push
// COLLIDERS, so a phone player was blocked where a desktop player walked free.
//
// HARNESS NOTES (both learned the hard way):
//  1. Island's constructor seeds NOTHING — the probe must install the same
//     mulberry32 GameScene uses, or it measures unseeded noise.
//  2. The FIRST Island built in a process warms module-level caches (shared
//     geometries/materials, the ink material), which mints a few extra uuids.
//     Compare WARM runs only, or the first run looks falsely divergent.
import * as THREE from 'three';
import { beforeAll, describe, expect, test, vi } from 'vitest';

import { Island } from '../Island';
import { SimpleRenderer } from '../SimpleRenderer';
import { WORLD_RADIUS } from '../WorldScale';
import { installHeadlessCanvas } from './helpers/headlessDom';

// Byte-identical to GameScene.installSeededRandom.
const seeded = (): (() => number) => {
  let s = 0x1a2b3c4d >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

interface Census {
  draws: number;
  props: string[];
  instanced: string[];
  colliders: string;
  tufts: number;
}

const build = (lowTier: boolean): Census => {
  const spy = vi.spyOn(SimpleRenderer, 'isLowTierDevice').mockReturnValue(lowTier);
  const gen = seeded();
  let draws = 0;
  const real = Math.random;
  Math.random = () => {
    draws++;
    return gen();
  };
  let isl: Island;
  try {
    isl = new Island(WORLD_RADIUS);
  } finally {
    Math.random = real;
    spy.mockRestore();
  }
  isl.mesh.updateMatrixWorld(true);
  const props: string[] = [];
  const instanced: string[] = [];
  let tufts = 0;
  isl.mesh.traverse((o) => {
    const im = o as THREE.InstancedMesh;
    if (im.isInstancedMesh) {
      if (/grass_sector/.test(o.name || '')) tufts += im.count;
      else instanced.push(`${o.name || '?'}:${im.count}`);
    }
    if (/^(tree_|car|mailbox_|lamp_|house|stall)/i.test(o.name || '')) {
      const p = o.getWorldPosition(new THREE.Vector3()).normalize();
      props.push(`${o.name}:${p.x.toFixed(6)},${p.y.toFixed(6)},${p.z.toFixed(6)}`);
    }
  });
  const colliders = isl.pendingColliders
    .map((c) => `${c.position.length().toFixed(4)}@${c.radius.toFixed(3)}`)
    .sort()
    .join(',');
  return { draws, props, instanced, colliders, tufts };
};

let desktop: Census;
let phone: Census;

beforeAll(() => {
  installHeadlessCanvas();
  build(false); // WARM the module-level caches — see harness note 2
  desktop = build(false);
  phone = build(true);
}, 300000);

describe('a phone and a desktop build the same world', () => {
  test('scattered props land in identical directions', () => {
    expect(phone.props.length).toBe(desktop.props.length);
    expect(phone.props).toEqual(desktop.props);
  });

  test('instanced populations match (rocks carry COLLIDERS — parity is not cosmetic)', () => {
    expect(phone.instanced).toEqual(desktop.instanced);
  });

  test('collider sets are identical — nobody is blocked where another walks free', () => {
    expect(phone.colliders).toBe(desktop.colliders);
  });

  test('ambient draw consumption matches', () => {
    expect(phone.draws).toBe(desktop.draws);
  });

  test('grass DOES still thin on low tier — the perf lever is intact', () => {
    expect(phone.tufts).toBeGreaterThan(0);
    expect(desktop.tufts).toBeGreaterThan(phone.tufts * 2);
  });
});

// FNV-1a over a census string — a stable, machine-independent digest.
const fnv1a = (s: string): string => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
};

// GOLDEN WORLD — the absolute pin the five tier-parity tests above CANNOT
// provide. Those compare phone-vs-desktop, so a change that re-rolls the
// seeded RNG stream UNIFORMLY (any new THREE allocation in Island
// construction — generateUUID spends 4 Math.random draws each) moves both
// tiers together and every relative test stays green while the whole world
// silently slides. And `draws` is the RNG state handed to createVehicles, so
// a shift here relocates the 8 parked cars multiplayer addresses BY INDEX.
//
// This pins the desktop census to fixed values. It fails on ANY world-moving
// change — which is the point: the failure is the review gate. When you MEANT
// to move the world (a radius migration, a deliberate placement change), read
// the printed actuals below and re-bless these four constants in the same
// commit. Never "fix" this by loosening it.
//
// Captured 2026-08-18 at WORLD_RADIUS=100, HEAD 2c98d6c.
const GOLDEN = {
  draws: 49771,
  propCount: 527,
  propHash: 'd3b590b9',
  colliderHash: 'd3c2796c',
  instancedHash: '8cf7f2bd',
  tufts: 10117,
};

describe('the world has not silently moved (golden RNG census)', () => {
  test('desktop census matches the blessed golden', () => {
    const actual = {
      draws: desktop.draws,
      propCount: desktop.props.length,
      propHash: fnv1a(desktop.props.join('|')),
      colliderHash: fnv1a(desktop.colliders),
      instancedHash: fnv1a(desktop.instanced.slice().sort().join(',')),
      tufts: desktop.tufts,
    };
    // One assertion on the whole object so a mismatch prints every actual at
    // once — copy them into GOLDEN above, intentionally, to re-bless.
    expect(actual).toEqual(GOLDEN);
  });
});
