// @vitest-environment happy-dom
//
// GameScene.ts source locks that lived in other packages' suites (UX plan
// testOwnership, rule 1: a structural lock moves to the owner of the code it
// pins). Each test is a verbatim copy of its original's GameScene assertions;
// the original's owner deletes them in its own stage-1 PR, and until then the
// duplicates simply both pass.
//   - onboarding.test.ts › 'guide sparkles yield to the arrival coins by
//     TARGET, not visibility' (the GameScene half; main-simple's half is A's)
//   - reducedMotion.test.ts › 'the party "calm" path covers the whole room,
//     not just the strobe' (its fixed 6000-character window is now bodyOf)
//   - feelRegressions.test.ts › 'GameScene requests the freeze; it never
//     writes the raw field'
//   - celInk.test.ts › 'toonify RNG shield' (behavioural: it borrows
//     GameScene's toonify onto a stub; C deletes its copy in C0)
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as THREE from 'three';
import { describe, expect, test, vi } from 'vitest';

import { GameScene } from '../GameScene';

// EOL-agnostic, as onboarding.test.ts reads it; no assertion here spans a line.
const src = (f: string): string =>
  readFileSync(join(process.cwd(), f), 'utf8').replace(/\r\n/g, '\n');
const stripped = (f: string): string =>
  src(f)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');

/**
 * The brace-balanced block a marker belongs to (same rule as
 * visualPolish.test.ts): a declaration runs from the marker to the brace that
 * closes the block it opens; a statement takes its whole enclosing block.
 */
const bodyOf = (s: string, marker: string): string => {
  const at = s.indexOf(marker);
  expect(at, `${marker} not found`).toBeGreaterThan(-1);
  const brace = s.indexOf('{', at);
  const semi = s.indexOf(';', at);
  if (brace > -1 && (semi === -1 || brace < semi)) {
    let depth = 0;
    for (let i = brace; i < s.length; i++) {
      if (s[i] === '{') depth++;
      else if (s[i] === '}' && --depth === 0) return s.slice(at, i + 1);
    }
    return s.slice(at);
  }
  let open = 0;
  for (let i = at - 1, depth = 0; i >= 0; i--) {
    if (s[i] === '}') depth++;
    else if (s[i] === '{' && depth-- === 0) {
      open = i;
      break;
    }
  }
  for (let i = at, depth = 0; i < s.length; i++) {
    if (s[i] === '{') depth++;
    else if (s[i] === '}' && depth-- === 0) return s.slice(open, i + 1);
  }
  return s.slice(open);
};

describe('one golden breadcrumb system at a time', () => {
  test('guide sparkles yield to the arrival coins by TARGET, not visibility', () => {
    // Target-based (null) suppression keeps reduced-motion users their
    // breadcrumbs by design; a visibility hack would strip them.
    const g = stripped('GameScene.ts');
    expect(g).toContain('public hasTrailCoins()');
  });
});

describe('load-bearing gates exist at their call sites', () => {
  test('the party "calm" path covers the whole room, not just the strobe', () => {
    // The ball glow, confetti, tiles, floor sweep and the spinner guest all
    // read `calm` now; the original gate covered only the beat flash + lasers.
    const party = bodyOf(src('GameScene.ts'), 'private updateInteriorParty');
    expect((party.match(/\bcalm\b/g) ?? []).length).toBeGreaterThanOrEqual(10);
  });
});

describe('shadowMap.autoUpdate has exactly one owner', () => {
  test('GameScene requests the freeze; it never writes the raw field', () => {
    // Comments stripped: the prose explaining WHY GameScene must not touch the
    // field necessarily names the field.
    const g = src('GameScene.ts')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    expect(g).not.toContain('shadowMap.autoUpdate');
    expect(g).not.toContain('shadowAutoUpdateWas');
    expect(g).toContain('setShadowFreeze?.(true)');
    expect(g).toContain('setShadowFreeze?.(false)');
  });
});

describe('the seeded window keeps its own census', () => {
  test('GameScene installs no WorldSeed recorder, so the browser census keeps its own marks', () => {
    // window.__dsSeedDraws and test/golden/seedDraws.json hold GameScene's 8
    // checkpoints; Island's marks (WorldSeed.seedMark) belong to the
    // drawNeutral census, which installs globalThis.__dsSeedMark itself.
    expect(stripped('GameScene.ts')).not.toMatch(/__dsSeedMark\s*=/);
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

describe('the beach-house party keeps a cottage’s lights (P2-B2)', () => {
  test('the party rig adds no light, and is built hidden with the room', () => {
    // three bakes light counts into every lit program: the rig's four lights
    // re-keyed the whole room on entry and on each toggle (MEASURED: +17
    // programs and a 1.8-2.4 s frame on desktop). The beat now drives the
    // room's own lights, and the rig is part of the room the warm compiles.
    const g = stripped('GameScene.ts');
    const rig = bodyOf(g, 'private buildPartyProps()');
    expect(rig).not.toMatch(/new THREE\.\w*Light\(/);
    expect(rig).toContain('group.visible = false');
    expect(bodyOf(g, 'private buildInterior()')).toContain('this.buildPartyProps();');
    for (const body of [
      bodyOf(g, 'private setPartyMode('),
      bodyOf(g, 'private updateInteriorParty('),
    ]) {
      expect(body).not.toMatch(/new THREE\.\w*Light\(/);
    }
  });

  test('guests dance 2 u or more from the floor centre, and go home when it stops', () => {
    type Npc = { name: string; position: THREE.Vector3; meshRef: THREE.Object3D };
    const names = ['Gardener', 'Artist', 'Musician', 'Storyteller', 'Cartographer', 'Courier'];
    const npcTargets: Npc[] = names.map((name) => ({
      name,
      position: new THREE.Vector3(),
      meshRef: new THREE.Object3D(),
    }));
    npcTargets[5].meshRef.visible = false; // asleep behind a cottage door
    // The party's own state on a stub (the borrow pattern of the toonify
    // test): the rig is unbuilt, so only the guests are exercised.
    const stub = Object.assign(Object.create(GameScene.prototype), {
      island: { npcTargets },
      partyMode: false,
      partyProps: null,
      interiorGroup: null,
      partyGuests: [],
      partyGuestHome: new Map(),
      insideInterior: true,
    }) as Record<string, unknown>;
    const proto = GameScene.prototype as unknown as Record<string, (...a: unknown[]) => void>;
    const setPartyMode = (on: boolean): void => proto['setPartyMode'].call(stub, on);
    const statics = GameScene as unknown as {
      INTERIOR_ORIGIN: THREE.Vector3;
      PARTY_FLOOR: { x: number; z: number };
    };
    const o = statics.INTERIOR_ORIGIN;
    const F = statics.PARTY_FLOOR;

    setPartyMode(true);
    const guests = stub.partyGuests as Array<{
      seat: THREE.Vector3;
      side: THREE.Vector2;
      npc: Npc;
    }>;
    expect(guests).toHaveLength(6);
    for (const g of guests) {
      const x = g.seat.x - o.x - F.x;
      const z = g.seat.z - o.z - F.z;
      expect(Math.hypot(x, z)).toBeGreaterThanOrEqual(2.0);
      // A side-step at its widest (0.22 u) never comes in from the edge.
      expect(Math.hypot(x + g.side.x * 0.22, z + g.side.y * 0.22)).toBeGreaterThanOrEqual(2.0);
      expect(g.npc.meshRef.visible).toBe(true);
    }

    // Party over, indoors: the world is frozen, so nobody may be left
    // standing mid-dance. Back on, and off again, keeps the outdoor state.
    setPartyMode(false);
    expect(npcTargets.every((n) => !n.meshRef.visible)).toBe(true);
    setPartyMode(true);
    setPartyMode(false);
    expect(npcTargets.every((n) => !n.meshRef.visible)).toBe(true);

    // Leaving hands each one back exactly as it was found outdoors.
    proto['sendPartyGuestsHome'].call(stub);
    expect(npcTargets.map((n) => n.meshRef.visible)).toEqual([true, true, true, true, true, false]);
  });
});

describe('no runtime change to the light count: GameScene’s half (P2-B6)', () => {
  test('the roaming lamp lights and the campfire light are built, never added', () => {
    // Decision P2-1: no exterior point lights. Both builders run inside the
    // seeded window, and each PointLight mints two uuids (the light and its
    // shadow camera), so the constructors stay for the stream while nothing
    // reaches the scene, lampFollowLights or a per-frame gate.
    const g = stripped('GameScene.ts');
    const pools = bodyOf(g, 'private createLampLightPools()');
    expect(pools.match(/new THREE\.PointLight\(0xffeeaa, 0, 16, 2\)/g) ?? []).toHaveLength(1);
    expect(pools).toMatch(/for \(let i = 0; i < 3; i\+\+\) void new THREE\.PointLight\(/);
    expect(pools).not.toContain('this.lampFollowLights.push');
    const fire = bodyOf(g, 'private setupCampfire()');
    expect(fire).toContain('void new THREE.PointLight(0xff9a3c, 0, 14, 1.4)');
    expect(fire).not.toMatch(/(group|this)\.add\(light\)/);
    expect(bodyOf(g, 'private updateCampfire(')).not.toMatch(/\.light\b/);
  });

  test('the boot gate primes the exterior set and leaves the room’s lights alone', () => {
    const scene = new THREE.Scene();
    const room = new THREE.Group();
    const roomLamp = new THREE.PointLight();
    room.add(roomLamp);
    const porch = new THREE.PointLight();
    const beam = new THREE.SpotLight();
    const house = new THREE.Group();
    house.add(porch);
    scene.add(room, house, beam);
    let day = 1;
    const stub = Object.assign(scene, {
      envCycle: { getDayFactor: () => day },
      interiorGroup: room,
    });
    const prime = (GameScene.prototype as unknown as Record<string, () => void>)[
      'primeExteriorLightGate'
    ];
    prime.call(stub);
    expect([porch.visible, beam.visible]).toEqual([false, false]); // by day: off
    expect(roomLamp.visible).toBe(true); // the room's own, not on the gate
    day = 0;
    prime.call(stub);
    expect([porch.visible, beam.visible, roomLamp.visible]).toEqual([true, true, true]);
  });
});

describe('the arrival trail leads to a villager who talks (B10)', () => {
  test('a scripted villager nearer the spawn is passed over', () => {
    localStorage.clear(); // a first visit
    const spawn = new THREE.Vector3(0.1, 1, 0.1).normalize();
    const tilt = new THREE.Vector3().crossVectors(spawn, new THREE.Vector3(1, 0, 0)).normalize();
    const at = (deg: number): THREE.Vector3 =>
      spawn
        .clone()
        .applyAxisAngle(tilt, (deg * Math.PI) / 180)
        .multiplyScalar(75);
    const npcTargets = [
      { name: 'Market Vendor', position: at(4), meshRef: new THREE.Object3D() },
      { name: 'Mayor', position: at(8), meshRef: new THREE.Object3D() },
      { name: 'Deckhand', position: at(6), meshRef: new THREE.Object3D() },
    ];
    // Real createArrivalTrail on a stub world (the borrow pattern above).
    const scene = Object.setPrototypeOf(new THREE.Scene(), GameScene.prototype) as Record<
      string,
      unknown
    > & { getTrailVillager(): string | null };
    Object.assign(scene, {
      island: {
        npcTargets,
        sampleSurfaceByDirection: (d: THREE.Vector3) => ({
          position: d.clone().multiplyScalar(75),
          normal: d.clone(),
        }),
      },
      coins: [],
      trailCoinsLeft: 0,
    });
    const proto = GameScene.prototype as unknown as Record<string, (...a: unknown[]) => void>;
    proto['createArrivalTrail'].call(scene, new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
    expect(scene.getTrailVillager()).toBe('Mayor');
    const coins = scene.coins as Array<{ mesh: THREE.Object3D; trail?: boolean }>;
    expect(coins.filter((c) => c.trail)).toHaveLength(5);
    const last = coins[coins.length - 1].mesh.position;
    expect(last.distanceTo(npcTargets[1].position)).toBeLessThan(3);
  });

  test('the first trail coin marks the visit, so a reload builds no trail', () => {
    // A reload before the trail's end used to rebuild the trail, and its
    // coins could be collected again: a free coin per reload.
    const g = stripped('GameScene.ts');
    const pickup = bodyOf(g, 'if (c.trail) {');
    expect(pickup).toContain("localStorage.setItem('ds_arrived', '1')");
    expect(pickup).toContain('this.onArrivalTrail?.()');
    expect(bodyOf(g, 'private createArrivalTrail(')).toContain(
      "localStorage.getItem('ds_arrived') === '1'",
    );
  });
});
