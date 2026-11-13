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
import ts from 'typescript';
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

  test('a trail coin waits for the visitor to steer, so the first pickup is theirs', () => {
    // MEASURED on the integration: the first coin lies 1.3 u from the spawn,
    // inside the magnet's reach, and was taken during the fly-in. At the
    // first card ds_arrived was '1' with 1 coin held and 4 of 5 on the
    // ground, so a reload with the card still up built no trail for a
    // visitor who had not moved.
    const scene = Object.setPrototypeOf(new THREE.Scene(), GameScene.prototype) as unknown as {
      trailCoinWaits(c: { trail?: boolean }): boolean;
      setPlayerMovement(forward: number, strafe: number): void;
    };
    Object.assign(scene, { visitorSteered: false });
    expect(scene.trailCoinWaits({ trail: true })).toBe(true);
    expect(scene.trailCoinWaits({})).toBe(false); // a meadow coin never waits
    scene.setPlayerMovement(0, 0); // the fly-in and the card feed zeros every frame
    expect(scene.trailCoinWaits({ trail: true })).toBe(true);
    scene.setPlayerMovement(0, 0.4);
    expect(scene.trailCoinWaits({ trail: true })).toBe(false);
    scene.setPlayerMovement(0, 0); // released for the visit, standing or not
    expect(scene.trailCoinWaits({ trail: true })).toBe(false);
    // The coin loop asks before the magnet and before the pickup.
    const loop = bodyOf(stripped('GameScene.ts'), 'for (const c of this.coins) {');
    const waits = loop.indexOf('if (this.trailCoinWaits(c)) continue;');
    expect(waits).toBeGreaterThan(-1);
    expect(waits).toBeLessThan(loop.indexOf('c.mesh.position.lerp(playerPos'));
    // The pickup (P2-B7 moved it into collectMeadowCoin, with the trail's
    // bookkeeping) comes after the wait too.
    const pickup = loop.indexOf('this.collectMeadowCoin(c, time)');
    expect(pickup).toBeGreaterThan(-1);
    expect(waits).toBeLessThan(pickup);
    const g = stripped('GameScene.ts');
    const from = g.indexOf('private collectMeadowCoin(');
    const collect = g.slice(from, g.indexOf('private onMeadowCoin', from));
    expect(from).toBeGreaterThan(-1);
    expect(collect).toContain('if (c.trail) {');
    expect(collect).toContain('this.onMeadowCoin?.({ trail: c.trail === true });');
  });
});

describe('the light rig follows the camera and the sun (P2-B5)', () => {
  type Rig = {
    lights: { sun: THREE.DirectionalLight };
    fillLight: THREE.DirectionalLight;
    rimLight: THREE.DirectionalLight;
    camera: THREE.PerspectiveCamera;
    envCycle: {
      getDayFactor(): number;
      getWeather(): string;
      getNightFactor?(): number;
      getNightFill?(): number;
    };
    updateSunShadow(playerPos: THREE.Vector3, dt?: number): void;
  };
  const statics = GameScene as unknown as { FILL_HOME: THREE.Vector3; RIM_HOME: THREE.Vector3 };
  const env = { day: 1, weather: 'clear' };
  /** The real updateSunShadow, and the rig it runs, on a stand-in scene. */
  const rig = (): Rig => {
    env.day = 1;
    env.weather = 'clear';
    const scene = Object.setPrototypeOf(new THREE.Scene(), GameScene.prototype) as unknown as Rig;
    const fill = new THREE.DirectionalLight(0xd4e8ff, 0.18);
    fill.position.copy(statics.FILL_HOME);
    const rim = new THREE.DirectionalLight(0xcfe6ff, 0.55);
    rim.position.copy(statics.RIM_HOME);
    // The instance fields the constructor makes (the borrow pattern above).
    Object.assign(scene, {
      lights: { sun: new THREE.DirectionalLight(0xffffff, 1.6) },
      fillLight: fill,
      rimLight: rim,
      camera: new THREE.PerspectiveCamera(),
      envCycle: { getDayFactor: () => env.day, getWeather: () => env.weather },
      _sunDir: new THREE.Vector3(),
      _shadowRight: new THREE.Vector3(),
      _shadowUp: new THREE.Vector3(),
      _shadowCentre: new THREE.Vector3(),
      _shadowUpAxis: new THREE.Vector3(),
      _rigRimFlat: new THREE.Vector3(1, 0, 0),
      _rigDir: new THREE.Vector3(),
      _rigPlayerPos: new THREE.Vector3(),
      rigWeatherShadow: 1,
      rigDt: 0,
      rigParked: true,
      boundLightRig: () =>
        (GameScene.prototype as unknown as Record<string, () => void>)['updateLightRig'].call(
          scene,
        ),
    });
    return scene;
  };
  /** One frame with the sun shining from `sunDir` and the player at `at`. */
  const frame = (s: Rig, at: THREE.Vector3, sunDir: THREE.Vector3, dt = 1 / 60): void => {
    // As EnvironmentCycle leaves it: the direction from the origin, times 60.
    s.lights.sun.position.copy(sunDir).normalize().multiplyScalar(60);
    s.updateSunShadow(at, dt);
  };
  const dirOf = (l: THREE.DirectionalLight): THREE.Vector3 =>
    l.position.clone().sub(l.target.position).normalize();
  const deg = (rad: number): number => (rad * 180) / Math.PI;
  const HUB = new THREE.Vector3(0, 76, 0);
  const HIGH_SUN = new THREE.Vector3(0.3, 0.9, 0.3); // well above the hub's horizon

  test('the fill shines from the camera onto the player, 10 degrees up at most', () => {
    const s = rig();
    const at = new THREE.Vector3(10, 74, 5);
    const up = at.clone().normalize();
    const flat = (v: THREE.Vector3): THREE.Vector3 =>
      v.clone().addScaledVector(up, -v.dot(up)).normalize();
    // A chase camera above the player, one beside it, and one level with it.
    const level = at.clone().add(flat(new THREE.Vector3(1, 0, 1)).multiplyScalar(6));
    for (const cam of [new THREE.Vector3(14, 78, -3), new THREE.Vector3(2, 75, 12), level]) {
      s.camera.position.copy(cam);
      frame(s, at, HIGH_SUN);
      const want = cam.clone().sub(at).normalize();
      const fill = dirOf(s.fillLight);
      // From the camera's side of the player...
      expect(deg(flat(fill).angleTo(flat(want)))).toBeLessThan(0.01);
      // ...as high as the camera stands, up to 10 degrees, and never higher.
      const camUp = deg(Math.asin(Math.min(1, want.dot(up))));
      expect(deg(Math.asin(fill.dot(up)))).toBeCloseTo(Math.min(camUp, 10), 3);
    }
  });

  test('under a low sun the fill keeps the camera’s full height', () => {
    const s = rig();
    const at = new THREE.Vector3(10, 74, 5);
    const up = at.clone().normalize();
    const cam = new THREE.Vector3(14, 78, -3);
    s.camera.position.copy(cam);
    // 20 degrees above the player's horizon: golden hour.
    const flatSun = new THREE.Vector3(1, 0, 0).addScaledVector(up, -up.x).normalize();
    const low = flatSun
      .multiplyScalar(Math.cos(Math.PI / 9))
      .addScaledVector(up, Math.sin(Math.PI / 9));
    frame(s, at, low);
    const want = cam.clone().sub(at).normalize();
    expect(deg(dirOf(s.fillLight).angleTo(want))).toBeLessThan(0.01);
  });

  test('the rim stands opposite the sun at the player, 20-30 degrees up, wherever they are', () => {
    const s = rig();
    const sunDir = new THREE.Vector3(0.6, 0.5, -0.3).normalize();
    // The hub and four points round the ring, a quarter of the planet apart.
    for (const at of [
      HUB,
      new THREE.Vector3(60, 45, 0),
      new THREE.Vector3(0, 45, 60),
      new THREE.Vector3(-60, 45, 0),
      new THREE.Vector3(0, 45, -60),
    ]) {
      frame(s, at, sunDir);
      const up = at.clone().normalize();
      const flat = (v: THREE.Vector3): THREE.Vector3 =>
        v.clone().addScaledVector(up, -v.dot(up)).normalize();
      const rim = dirOf(s.rimLight);
      // Opposite the sun's horizontal direction (the acceptance allows 15).
      expect(deg(flat(rim).angleTo(flat(sunDir).negate()))).toBeLessThan(0.5);
      // 30 degrees up under a sun 45 degrees high or lower, 20 from 60.
      const high = THREE.MathUtils.smoothstep(sunDir.dot(up), Math.SQRT1_2, Math.sin(Math.PI / 3));
      expect(deg(Math.asin(rim.dot(up)))).toBeCloseTo(30 - 10 * high, 3);
    }
    // Its level is the day curve's, unchanged.
    expect(s.rimLight.intensity).toBeCloseTo(0.55, 6);
    env.day = 0;
    frame(s, HUB, sunDir);
    expect(s.rimLight.intensity).toBeCloseTo(0.12, 6);
  });

  test('a sun straight overhead keeps the rim where it was', () => {
    const s = rig();
    frame(s, HUB, new THREE.Vector3(1, 0.5, 0));
    const up = HUB.clone().normalize();
    const flat = (v: THREE.Vector3): THREE.Vector3 =>
      v.clone().addScaledVector(up, -v.dot(up)).normalize();
    const before = flat(dirOf(s.rimLight));
    frame(s, HUB, new THREE.Vector3(0, 1, 0));
    // Its bearing holds; only its height follows the sun's (20 degrees now).
    expect(deg(flat(dirOf(s.rimLight)).angleTo(before))).toBeLessThan(0.01);
    expect(deg(Math.asin(dirOf(s.rimLight).dot(up)))).toBeCloseTo(20, 3);
  });

  test('golden hour is not night: full shadows and the day fill at 06 h and 18 h', () => {
    const s = rig();
    env.day = 0.198; // EnvironmentCycle's day factor at 06 h and 18 h
    frame(s, HUB, HIGH_SUN);
    expect(s.lights.sun.shadow.intensity).toBeCloseTo(1, 6);
    expect(s.fillLight.intensity).toBeCloseTo(0.18, 6);
    // 1 - getDayFactor() would read 0.8 here, and put the shadow at 0.6.
    const proto = GameScene.prototype as unknown as Record<string, (day: number) => number>;
    expect(proto['nightFactor'].call(s, 0.198)).toBe(0);
    expect(proto['nightFactor'].call(s, 0)).toBe(1);
    expect(proto['nightFactor'].call(s, 1)).toBe(0);
  });

  test('moon shadows are half strength, and the night fill is the cycle’s to set', () => {
    const s = rig();
    env.day = 0;
    frame(s, HUB, HIGH_SUN);
    expect(s.lights.sun.shadow.intensity).toBeCloseTo(0.5, 6);
    // Until C's getNightFill exists, the fill keeps its day level at night.
    expect(s.fillLight.intensity).toBeCloseTo(0.18, 6);
    s.envCycle.getNightFill = () => 0.3;
    frame(s, HUB, HIGH_SUN);
    expect(s.fillLight.intensity).toBeCloseTo(0.3, 6);
    // C's night factor wins over the fallback ramp.
    s.envCycle.getNightFactor = () => 0.5;
    frame(s, HUB, HIGH_SUN);
    expect(s.fillLight.intensity).toBeCloseTo(0.24, 6);
    expect(s.lights.sun.shadow.intensity).toBeCloseTo(0.75, 6);
  });

  test('weather softens the shadow: cloud 0.45, snow 0.4, rain 0.2, eased', () => {
    const s = rig();
    for (const [weather, want] of [
      ['cloudy', 0.45],
      ['snow', 0.4],
      ['rain', 0.2],
      ['clear', 1],
    ] as const) {
      env.weather = weather;
      frame(s, HUB, HIGH_SUN);
      // One frame in it has barely moved (cloudWet's 0.5/s ease)...
      if (weather === 'cloudy') expect(s.lights.sun.shadow.intensity).toBeGreaterThan(0.95);
      for (let i = 0; i < 1500; i++) frame(s, HUB, HIGH_SUN); // ...25 s on it is there
      expect(s.lights.sun.shadow.intensity).toBeCloseTo(want, 3);
    }
  });

  test('with fx lightRig off, the rig is the authored one', () => {
    const s = rig();
    env.day = 0;
    s.camera.position.set(5, 80, 5);
    frame(s, HUB, HIGH_SUN);
    expect(s.lights.sun.shadow.intensity).toBeCloseTo(0.5, 6);
    const g = globalThis as { __dsFx?: Record<string, unknown> };
    g.__dsFx = { ...(g.__dsFx ?? {}), lightRig: false };
    try {
      frame(s, HUB, HIGH_SUN);
      expect(s.fillLight.position.equals(statics.FILL_HOME)).toBe(true);
      expect(s.rimLight.position.equals(statics.RIM_HOME)).toBe(true);
      expect(s.fillLight.intensity).toBe(0.18);
      expect(s.lights.sun.shadow.intensity).toBe(1);
    } finally {
      delete g.__dsFx.lightRig;
    }
  });

  test('the rig is one budgeted effect, bound once, and builds nothing', () => {
    const g = stripped('GameScene.ts');
    expect(g).toContain("fx.register('lightRig', { desktop: true, low: true });");
    const shadow = bodyOf(g, 'private updateSunShadow(');
    expect(shadow).toContain("if (fx.on('lightRig')) {");
    expect(shadow).toContain("fx.time('lightRig', this.boundLightRig);");
    expect(g).toContain('private readonly boundLightRig = (): void => this.updateLightRig();');
    // Directions and levels only: nothing is made, added, shown or hidden.
    for (const body of [
      bodyOf(g, 'private updateLightRig()'),
      bodyOf(g, 'private parkLightRig()'),
    ]) {
      expect(body).not.toMatch(/\bnew\b/);
      expect(body).not.toContain('.clone()');
      expect(body).not.toMatch(/\.(add|remove)\(/);
      expect(body).not.toContain('.visible');
    }
    // setupLighting runs inside the seeded window and still builds exactly
    // its five lights; the rig only keeps a reference to the fill.
    const setup = bodyOf(g, 'private setupLighting()');
    expect(setup.match(/new THREE\.\w*Light\(/g) ?? []).toHaveLength(5);
    expect(setup).toContain('this.fillLight = fillLight;');
  });

  test('the grade feeds the night bloom, and the hemisphere keeps a live tint', () => {
    const grade = bodyOf(stripped('GameScene.ts'), 'private updateAtmosphereGrade(');
    const at = grade.indexOf('this.rendererRef?.setGradeDayFactor?.(day);');
    expect(at).toBeGreaterThan(-1);
    expect(grade.slice(at, at + 140)).toContain('this.rendererRef?.setBloomNight?.(day);');
    // The underwater grade starts from EnvironmentCycle's live tint when it
    // has one (C1), and from the cached bases until then.
    expect(grade).toContain('getHemiTint?.()');
    expect(grade).toContain('?? this.hemiBaseSky');
    expect(grade).toContain('?? this.hemiBaseGround');
  });
});

describe('every prop of the scene shares the toon look (B15)', () => {
  /** Each `new THREE.<type>(...)` call in a file, to its closing bracket. */
  const calls = (file: string, type: string): string[] => {
    const s = stripped(file);
    const out: string[] = [];
    const head = `new THREE.${type}(`;
    for (let at = s.indexOf(head); at > -1; at = s.indexOf(head, at + 1)) {
      let depth = 0;
      for (let i = at + head.length - 1; i < s.length; i++) {
        if (s[i] === '(') depth++;
        else if (s[i] === ')' && --depth === 0) {
          out.push(s.slice(at, i + 1));
          break;
        }
      }
    }
    return out;
  };

  test('no toon material is built without the shared ramp', () => {
    // MEASURED on main: 28 ramp-less MeshToon materials (the fish shop, the
    // bakery, the play structures, butterflies, coins, the rod), on three's
    // built-in two-band shading beside the three-band ramp everywhere else.
    for (const file of ['GameScene.ts', 'SimplePlayer.ts', 'RaceSystem.ts']) {
      const bare = calls(file, 'MeshToonMaterial').filter((c) => !c.includes('gradientMap'));
      expect(bare, file).toEqual([]);
    }
  });

  test('a standard prop converts through the island’s converter, for free', () => {
    const celMat = (
      GameScene as unknown as { celMat(m: THREE.MeshStandardMaterial): THREE.Material }
    ).celMat;
    const std = new THREE.MeshStandardMaterial({
      color: 0xffe6a8,
      emissive: 0xffc966,
      emissiveIntensity: 0.35,
      polygonOffset: true,
      polygonOffsetFactor: -4,
    });
    // Inside the seeded window the stream must pay what it always paid: the
    // one standard material above. The toon's uuid comes from elsewhere.
    const spy = vi.spyOn(Math, 'random');
    spy.mockClear();
    const toon = celMat(std) as THREE.MeshToonMaterial;
    const drawn = spy.mock.calls.length;
    spy.mockRestore();
    expect(drawn).toBe(0);
    expect(toon.isMeshToonMaterial).toBe(true);
    expect(toon.gradientMap).toBeTruthy();
    expect([toon.color.getHex(), toon.emissive.getHex(), toon.emissiveIntensity]).toEqual([
      0xffe6a8, 0xffc966, 0.35,
    ]);
    expect([toon.polygonOffset, toon.polygonOffsetFactor]).toEqual([true, -4]);
  });

  test('the lit, opaque standard materials left in the scene are the rooms’ (P2-B10)', () => {
    const g = stripped('GameScene.ts');
    // The road paint, the cruise ship's and the beach house's window glow.
    expect(bodyOf(g, 'private createRoadMarkings()')).toContain('GameScene.celMat(');
    expect(bodyOf(g, 'private setupCruise()')).toContain('GameScene.celMat(');
    expect(bodyOf(g, 'private setupIsletBeachHouse()')).toContain('GameScene.celMat(');
    // The rock.glb clones, after their load.
    expect(g).toContain('if (!isRealTheme()) Materials.toonifyTree(inst);');
    // The race gates' posts; the rings stay transparent standard.
    const race = stripped('RaceSystem.ts');
    expect(race).toContain('isRealTheme() ? postStd : Materials.toonify(postStd)');
    // The player's dress and the hats (behaviour: limbLayers).
    const p = stripped('SimplePlayer.ts');
    expect(bodyOf(p, 'private async loadGLTFCharacter()')).toContain(
      'if (isCelTheme()) Materials.toonifyTree(this.gltfModel);',
    );
    expect(bodyOf(p, 'public static buildHat(')).toContain(
      'if (isCelTheme()) Materials.toonifyTree(g);',
    );
  });

  test('the island’s own pass delegates to the same converter', () => {
    const g = stripped('GameScene.ts');
    const shielded = bodyOf(g, 'private toonifyIslandMaterialsShielded()');
    expect(shielded).toContain('Materials.toonifyTree(this.island.mesh)');
    expect(shielded).not.toContain('new THREE.MeshToonMaterial');
    // (That it converts, spares glass and draws nothing: 'toonify RNG shield'.)
  });
});

describe('the close-camera fade is driven from the visual group (B11)', () => {
  test('the camera-to-torso distance comes from player.position, outdoors and in a room', () => {
    const fed: Array<[number, number]> = [];
    const player = {
      position: new THREE.Vector3(10, 60, 0),
      quaternion: new THREE.Quaternion(),
      // The physics position: indoors it stays at the doorstep.
      getWorldPosition: () => {
        throw new Error('the fade must not read the physics position');
      },
      updateCloseFade: (d: number, dt: number) => fed.push([d, dt]),
    };
    const camera = new THREE.PerspectiveCamera();
    const scene = Object.setPrototypeOf(new THREE.Scene(), GameScene.prototype) as unknown as {
      tickAvatarFade(dt: number): void;
    };
    Object.assign(scene, {
      player,
      camera,
      _fadeAnchor: new THREE.Vector3(),
      avatarFadeDt: 0,
      boundAvatarFade: () =>
        (GameScene.prototype as unknown as Record<string, () => void>)['updateAvatarFade'].call(
          scene,
        ),
    });
    // 0.8 u behind the torso (the origin plus 0.35 along the avatar's up).
    camera.position.set(10, 60.35, 0.8);
    scene.tickAvatarFade(1 / 60);
    expect(fed[0][0]).toBeCloseTo(0.8, 6);
    expect(fed[0][1]).toBeCloseTo(1 / 60, 9);
    // The avatar's own up, not world +Y: lying on its side the torso is beside it.
    player.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), -Math.PI / 2);
    camera.position.set(10.35, 60, 2);
    scene.tickAvatarFade(1 / 60);
    expect(fed[1][0]).toBeCloseTo(2, 6);
    // Off, the avatar is told the camera is far away, so a fade runs back out.
    const g = globalThis as { __dsFx?: Record<string, unknown> };
    g.__dsFx = { ...(g.__dsFx ?? {}), avatarFade: false };
    try {
      scene.tickAvatarFade(1 / 60);
      expect(fed[2][0]).toBe(Infinity);
    } finally {
      delete g.__dsFx.avatarFade;
    }
  });

  test('one budgeted effect, bound once, ticked on both update paths', () => {
    const g = stripped('GameScene.ts');
    expect(g).toContain("fx.register('avatarFade', { desktop: true, low: true });");
    const tick = bodyOf(g, 'private tickAvatarFade(');
    expect(tick).toContain("if (fx.on('avatarFade')) fx.time('avatarFade', this.boundAvatarFade);");
    expect(g).toContain('private readonly boundAvatarFade = (): void => this.updateAvatarFade();');
    const fade = bodyOf(g, 'private updateAvatarFade()');
    expect(fade).not.toMatch(/\bnew\b/);
    expect(fade).not.toContain('getWorldPosition');
    expect(fade).not.toContain('setFromObject');
    expect(bodyOf(g, 'public update(deltaTime: number)')).toContain(
      'this.tickAvatarFade(deltaTime);',
    );
    expect(bodyOf(g, 'private updateInteriorMode(')).toContain('this.tickAvatarFade(deltaTime);');
    // The shared ink material is never the fade's to write (CelLook owns it).
    const p = stripped('SimplePlayer.ts');
    expect(bodyOf(p, 'private applyCloseFade(')).toContain('h.visible = solid');
    expect(p).not.toContain('setInkVisible');
  });
});

describe('the sky ends like every built-in material (P2-B4)', () => {
  test('the dome applies the frame’s tone mapping, then its output encoding', () => {
    // MEASURED on the low tier, which draws straight to the canvas: the dome
    // wrote linear colours as display colours, 18-23 L* below desktop by day.
    const scene = Object.setPrototypeOf(new THREE.Scene(), GameScene.prototype) as THREE.Scene;
    (GameScene.prototype as unknown as Record<string, () => void>)['createSkyDome'].call(scene);
    const dome = scene.getObjectByName('SkyDome') as THREE.Mesh;
    const mat = dome.material as THREE.ShaderMaterial;
    const frag = mat.fragmentShader.replace(/\/\/.*$/gm, '');
    const out = frag.indexOf('gl_FragColor = vec4(sky, 1.0);');
    const tone = frag.indexOf('#include <tonemapping_fragment>');
    const encode = frag.indexOf('#include <colorspace_fragment>');
    expect(out).toBeGreaterThan(-1);
    expect(tone).toBeGreaterThan(out);
    expect(encode).toBeGreaterThan(tone);
    // Nothing writes the colour after them.
    expect(frag.slice(encode)).not.toContain('gl_FragColor');
    // three resolves both by name; a renamed chunk would make them no-ops.
    expect(THREE.ShaderChunk.tonemapping_fragment).toContain('toneMapping(');
    expect(THREE.ShaderChunk.colorspace_fragment).toContain('linearToOutputTexel(');
    // The renderer's tone mapping reaches it (WebGLPrograms reads toneMapped).
    expect(mat.toneMapped).toBe(true);
    // Still one unlit shader program: nothing here keys on the lights.
    expect(mat.lights).toBe(false);
  });
});

describe('the night watch is posted before the arrival trail is laid (wave-2 decision)', () => {
  test('postNightWatch runs before createCoins, and draws nothing', () => {
    const s = stripped('GameScene.ts');
    const call = s.indexOf('this.postNightWatch();');
    expect(call).toBeGreaterThan(-1);
    expect(call).toBeLessThan(s.indexOf('this.createCoins();'));
    const body = bodyOf(s, 'private postNightWatch(): void');
    expect(body).not.toMatch(/Math\.random|new THREE\.(Mesh|Material|Mesh\w+Material)\b/);
    expect(body).toMatch(/isNightWatchHour\(GameScene\.bootHour\(\)\)/);
  });

  test('the doors are shared out from his own seat, not the night post', () => {
    const body = bodyOf(stripped('GameScene.ts'), 'private setupNpcActivities(): void');
    expect(body).toMatch(/this\.nightWatchSeat/);
    expect(body).toMatch(/spawnDir: GameScene\.SPAWN_DIR/);
  });
});

describe('dead code stays gone (wave-2 amendment, older)', () => {
  test('GameScene.hasVillagerWithin is deleted, with its scratch vector', () => {
    expect(src('GameScene.ts')).not.toMatch(/\bhasVillagerWithin\b/);
    expect(src('GameScene.ts')).not.toContain('_nearNpcPos');
  });
});

describe('the race compass reads the next gate (P2-B7)', () => {
  // Behavioural, on a RaceSystem with a hand-made three-gate land circuit
  // (gate 0 is start and finish). test/raceGate.test.ts is not in
  // tools/owners.json, so this lives in B's sceneLocks.
  const R = 75;
  const dirs = [
    new THREE.Vector3(0, 1, 0),
    new THREE.Vector3(0.6, 0.8, 0).normalize(),
    new THREE.Vector3(0, 0.8, 0.6).normalize(),
  ];
  const surfaceR = [75.5, 76.25, 77];
  const make = async (): Promise<
    import('../RaceSystem').RaceSystem & {
      circuits: Record<string, unknown>;
    }
  > => {
    const { RaceSystem } = await import('../RaceSystem');
    const island = { getRadius: () => R } as unknown as ConstructorParameters<typeof RaceSystem>[1];
    const rs = new RaceSystem(new THREE.Scene(), island, []) as InstanceType<typeof RaceSystem> & {
      circuits: Record<string, unknown>;
    };
    rs.circuits.land = { kind: 'land', dirs, surfaceR, gates: [], rings: [] };
    return rs;
  };
  const at = (d: THREE.Vector3, nudge = 0): THREE.Vector3 =>
    d
      .clone()
      .applyAxisAngle(new THREE.Vector3(1, 0, 0), nudge)
      .multiplyScalar(R);

  test('null when idle; idx, n and the gate point while racing; null after', async () => {
    const rs = await make();
    const out = new THREE.Vector3(9, 9, 9);
    expect(rs.getNextGate(out)).toBeNull();
    expect(out.toArray()).toEqual([9, 9, 9]); // untouched
    // Driving through the start ring arms the run: the next gate is 1.
    rs.update(0.016, at(dirs[0], 0.001), 'car');
    rs.update(0.016, at(dirs[0]), 'car');
    expect(rs.getNextGate(out)).toEqual({ idx: 1, n: 3, kind: 'land' });
    expect(out.distanceTo(dirs[1].clone().multiplyScalar(surfaceR[1]))).toBeLessThan(1e-9);
    rs.update(0.016, at(dirs[1]), 'car');
    expect(rs.getNextGate(out)).toEqual({ idx: 2, n: 3, kind: 'land' });
    rs.update(0.016, at(dirs[2]), 'car');
    // Gate 0 again: the finish.
    expect(rs.getNextGate(out)).toEqual({ idx: 0, n: 3, kind: 'land' });
    expect(out.distanceTo(dirs[0].clone().multiplyScalar(surfaceR[0]))).toBeLessThan(1e-9);
    // On foot, the run is abandoned.
    rs.update(0.016, at(dirs[0]), null);
    expect(rs.getNextGate(out)).toBeNull();
  });

  test('GameScene.getRaceNextGate forwards it, null before the races exist', () => {
    const s = stripped('GameScene.ts');
    const at = s.indexOf('public getRaceNextGate(');
    expect(at).toBeGreaterThan(-1);
    expect(s.slice(at, at + 200)).toContain('return this.races?.getNextGate(out) ?? null;');
  });
});

describe('the bird feed says why it did not throw (P2-B7)', () => {
  test("throwBirdFeed stays a boolean over throwBirdFeedReason's 'ok'", () => {
    const s = stripped('GameScene.ts');
    expect(bodyOf(s, 'public throwBirdFeed(): boolean')).toContain(
      "return this.throwBirdFeedReason() === 'ok';",
    );
    const reason = bodyOf(s, 'public throwBirdFeedReason()');
    for (const r of ["return 'none'", "return 'night'", "return 'sea'", "return 'ok'"]) {
      expect(reason).toContain(r);
    }
    expect(reason).not.toMatch(/return (true|false)/);
  });

  test('night, no island: the reasons, behaviourally', () => {
    const init = vi
      .spyOn(GameScene.prototype as unknown as { initialize: () => Promise<void> }, 'initialize')
      .mockResolvedValue(undefined);
    const sc = new GameScene() as unknown as {
      island: unknown;
      player: unknown;
      envCycle: unknown;
      throwBirdFeedReason(): string;
      throwBirdFeed(): boolean;
    };
    init.mockRestore();
    sc.island = undefined;
    expect(sc.throwBirdFeedReason()).toBe('none');
    expect(sc.throwBirdFeed()).toBe(false);
    sc.island = {};
    sc.player = {};
    sc.envCycle = { getDayFactor: () => 0.1 };
    expect(sc.throwBirdFeedReason()).toBe('night');
  });
});

describe('Multiplayer.ts has no import-time side effects (wave-3 bundle carry-over)', () => {
  // A's wave-3 lazy load moves `import { Multiplayer }` behind a dynamic
  // import. That is only safe if evaluating the module does nothing: no
  // listeners, timers, network, DOM or Firebase until `new Multiplayer()` and
  // connect(). Its dependencies (Materials, Moderation, SimplePlayer) are
  // already loaded eagerly by main-simple, so only this module's own top
  // level matters.
  test('the top level holds only imports and declarations', () => {
    // Parsed, not brace-counted: strings and regexes in the class body hold
    // brackets and slashes that throw a character scan off.
    const sf = ts.createSourceFile('Multiplayer.ts', src('Multiplayer.ts'), ts.ScriptTarget.Latest);
    const loose = sf.statements
      .filter(
        (st) =>
          !ts.isImportDeclaration(st) &&
          !ts.isInterfaceDeclaration(st) &&
          !ts.isTypeAliasDeclaration(st) &&
          !ts.isClassDeclaration(st) &&
          !ts.isFunctionDeclaration(st) &&
          !(
            ts.isEnumDeclaration(st) &&
            st.modifiers?.some((m) => m.kind === ts.SyntaxKind.ConstKeyword)
          ),
      )
      .map((st) => st.getText(sf).slice(0, 80));
    expect(loose).toEqual([]);
    // No static field initialisers run code at class definition either.
    const cls = sf.statements.filter(ts.isClassDeclaration);
    const staticInits = cls.flatMap((c) =>
      c.members
        .filter(
          (m) =>
            (ts.isPropertyDeclaration(m) && m.initializer) || ts.isClassStaticBlockDeclaration(m),
        )
        .filter(
          (m) =>
            ts.isClassStaticBlockDeclaration(m) ||
            m.modifiers?.some((x) => x.kind === ts.SyntaxKind.StaticKeyword),
        )
        .map((m) => m.getText(sf).slice(0, 80)),
    );
    expect(
      staticInits.filter((t) => !/=\s*(-?[\d.]+|'[^']*'|true|false|null)\s*;?$/.test(t)),
    ).toEqual([]);
    const s = stripped('Multiplayer.ts');
    // Firebase stays behind connect()'s dynamic imports.
    expect(s).not.toMatch(/^import[^\n]*(firebase|firebaseClient)/m);
    expect(s).toContain("import('./firebaseClient')");
    expect(s).toContain("import('firebase/database')");
  });

  test('evaluating the module adds no listener, timer, frame or request', async () => {
    // Dependencies first, so only Multiplayer's own evaluation is measured.
    // Materials is already loaded through the static GameScene import above.
    await import('../Moderation');
    await import('../SimplePlayer');
    const spies = [
      vi.spyOn(window, 'addEventListener'),
      vi.spyOn(document, 'addEventListener'),
      vi.spyOn(globalThis, 'setTimeout'),
      vi.spyOn(globalThis, 'setInterval'),
      vi.spyOn(globalThis, 'requestAnimationFrame'),
      vi.spyOn(globalThis, 'fetch'),
      vi.spyOn(document, 'createElement'),
    ];
    const fb = vi.fn();
    vi.doMock('../firebaseClient', () => {
      fb();
      return {};
    });
    vi.doMock('firebase/database', () => {
      fb();
      return {};
    });
    try {
      const mod = await import('../Multiplayer?side-effects');
      expect(typeof mod.Multiplayer).toBe('function');
      for (const s of spies) expect(s, s.getMockName()).not.toHaveBeenCalled();
      expect(fb).not.toHaveBeenCalled();
    } finally {
      for (const s of spies) s.mockRestore();
      vi.doUnmock('../firebaseClient');
      vi.doUnmock('firebase/database');
    }
  });
});
