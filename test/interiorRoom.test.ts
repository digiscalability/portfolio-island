// @vitest-environment happy-dom
//
// Rooms (P2-B1): a visit starts clear of the door, the door arms after a step
// or a moment, and every hotspot in every theme can be reached.
//
// MEASURED before (the interiors audit, every theme): the spawn at (-1.8,
// 2.6) stood 0.7 u from the door spot, inside its 1.0 u reach, so the first
// prompt was 'head outside' and the first E or USE walked the visitor
// straight back out. The Personal room also put the avatar inside its floor
// lamp's collider, and its curtains were unreachable behind the sofa.
//
// Behavioural: a real GameScene with its world build switched off builds the
// real room (every theme's furniture and the colliders derived from it), and
// enterInterior and updateInteriorMode run for real on a stand-in player.
import * as THREE from 'three';
import { beforeAll, describe, expect, test, vi } from 'vitest';

import { GameScene } from '../GameScene';
import { installHeadlessCanvas } from './helpers/headlessDom';

interface Hotspot {
  x: number;
  z: number;
  r: number;
  label: string;
  action: string;
  text?: string;
}

/** The private room surface this suite drives. */
interface Room {
  player: unknown;
  camera: THREE.PerspectiveCamera;
  island: unknown;
  insideInterior: boolean;
  interiorColliders: Record<
    string,
    Array<{ minX: number; maxX: number; minZ: number; maxZ: number }>
  >;
  buildInterior(): void;
  enterInterior(
    title: string,
    wall: number,
    left: string,
    right: string,
    theme: string,
    houseId?: string,
  ): void;
  exitInterior(): void;
  setInteriorMove(forward: number, strafe: number): void;
  updateInteriorMode(dt: number): void;
  getInteriorHotspot(): { label: string; action: string } | null;
  interiorHotspotsFor(theme: string): Hotspot[];
  interiorWallBlocked(x: number, z: number): boolean;
  interiorFurnitureBlocked(x: number, z: number): boolean;
}

const statics = GameScene as unknown as {
  INTERIOR_ORIGIN: THREE.Vector3;
  INTERIOR_SPAWN: { x: number; z: number };
  INTERIOR_PLAYER_R: number;
};
const THEMES = ['office', 'workshop', 'home', 'post', 'hall', 'cottage', 'beach'];
const DOOR = 'leave';

let scene: Room;
const room = (): { x: number; z: number } => {
  const o = statics.INTERIOR_ORIGIN;
  const p = (scene.player as { position: THREE.Vector3 }).position;
  return { x: p.x - o.x, z: p.z - o.z };
};

/** A visitor's E: whatever the prompt offers where they stand. */
const enter = (theme: string): void => {
  scene.enterInterior(
    'A room',
    0xe0c9a8,
    '',
    '',
    theme,
    theme === 'beach' ? 'islet_beach_house' : undefined,
  );
};

beforeAll(() => {
  installHeadlessCanvas();
  // A real GameScene, minus the world: initialize builds the whole island.
  const init = vi
    .spyOn(GameScene.prototype as unknown as { initialize: () => Promise<void> }, 'initialize')
    .mockResolvedValue(undefined);
  scene = new GameScene() as unknown as Room;
  init.mockRestore();
  const position = new THREE.Vector3();
  scene.player = {
    position,
    quaternion: new THREE.Quaternion(),
    getWorldPosition: () => new THREE.Vector3(0, 76, 0),
    setPositionHold: () => {},
    updateWorldMatrix: () => {},
    tickInteriorAnimation: () => {},
    getWalkCyclePhase: () => 0,
    applyPartyDance: () => {},
  };
  scene.camera = new THREE.PerspectiveCamera(50, 1.6, 0.1, 2000);
  scene.island = { houseDoors: [], npcTargets: [] };
  scene.buildInterior();
}, 60000);

describe('a visit starts clear of the door', () => {
  test.each(THEMES)('%s: no prompt and no furniture at the spawn', (theme) => {
    enter(theme);
    const s = statics.INTERIOR_SPAWN;
    expect(room()).toEqual({ x: s.x, z: s.z });
    // Not even the door, armed: the spawn is outside every hotspot's reach.
    const atSpawn = scene
      .interiorHotspotsFor(theme)
      .filter((h) => Math.hypot(s.x - h.x, s.z - h.z) < h.r)
      .map((h) => h.label);
    expect(atSpawn).toEqual([]);
    expect(scene.interiorFurnitureBlocked(s.x, s.z)).toBe(false);
    scene.updateInteriorMode(1 / 60);
    expect(scene.getInteriorHotspot()).toBeNull();
    scene.exitInterior();
  });

  test('the spawn is 1.4 u from the door spot', () => {
    const s = statics.INTERIOR_SPAWN;
    const door = scene.interiorHotspotsFor('cottage').find((h) => h.action === DOOR)!;
    expect(Math.hypot(s.x - door.x, s.z - door.z)).toBeCloseTo(1.43, 2);
  });
});

describe('the door arms after a step or a moment', () => {
  test('excluded before arming, included after 0.6 u walked', () => {
    // Placed INSIDE the door's reach the moment the room opens: the door is
    // not offered yet.
    enter('cottage');
    const o = statics.INTERIOR_ORIGIN;
    const p = (scene.player as { position: THREE.Vector3 }).position;
    p.set(o.x - 1.8, p.y, o.z + 2.7);
    scene.updateInteriorMode(1 / 60);
    expect(scene.getInteriorHotspot()?.action).not.toBe(DOOR);
    scene.exitInterior();

    // Walking from the spawn straight back to the door: inside its reach
    // after about 0.45 u, offered once 0.6 u are walked, well before 1.5 s.
    enter('cottage');
    const door = scene.interiorHotspotsFor('cottage').find((h) => h.action === DOOR)!;
    let walked = 0;
    let t = 0;
    let inReachUnarmed = 0;
    let offeredUnarmed = 0;
    while (walked < 0.6 && t < 1.2) {
      // Steer at the door spot: room movement is relative to the camera yaw.
      const at = room();
      (scene as unknown as { interiorCamYaw: number }).interiorCamYaw = Math.atan2(
        door.x - at.x,
        door.z - at.z,
      );
      scene.setInteriorMove(1, 0);
      scene.updateInteriorMode(1 / 60);
      t += 1 / 60;
      walked += Math.hypot(room().x - at.x, room().z - at.z);
      if (walked < 0.6 && Math.hypot(room().x - door.x, room().z - door.z) < door.r) {
        inReachUnarmed++;
        if (scene.getInteriorHotspot()?.action === DOOR) offeredUnarmed++;
      }
    }
    scene.setInteriorMove(0, 0);
    expect(t).toBeLessThan(1.5); // armed by the walk, not the clock
    expect(inReachUnarmed).toBeGreaterThan(0);
    expect(offeredUnarmed).toBe(0);
    expect(walked).toBeGreaterThanOrEqual(0.6);
    expect(scene.getInteriorHotspot()?.action).toBe(DOOR);
    scene.exitInterior();
  });

  test('a visitor who stands still is offered the door after 1.5 s', () => {
    enter('cottage');
    const o = statics.INTERIOR_ORIGIN;
    const p = (scene.player as { position: THREE.Vector3 }).position;
    p.set(o.x - 1.8, p.y, o.z + 2.7); // within the door's reach, never walking
    for (let t = 0; t < 1.4; t += 1 / 60) scene.updateInteriorMode(1 / 60);
    expect(scene.getInteriorHotspot()?.action).not.toBe(DOOR);
    for (let t = 0; t < 0.2; t += 1 / 60) scene.updateInteriorMode(1 / 60);
    expect(scene.getInteriorHotspot()?.action).toBe(DOOR);
    scene.exitInterior();
  });
});

/** Hotspots in reach but never the nearest, KNOWN and older than this suite.
 *  The beach house's sea spot (-3.0, -2.2) sits behind the daybed, inside
 *  the wall screen's 1.5 u spot: MEASURED on a 0.05 u grid it wins only a
 *  5 cm sliver past the daybed's foot, which the 0.1 u walk grid misses.
 *  Reported to the plan; a new entry here is a regression. */
const SHADOWED: Record<string, string[]> = {
  beach: ['🌊 Press E to listen to the sea'],
};

describe('every hotspot can be reached', () => {
  // The survey's flood fill (phase-2 interiors audit, IA.reach): 0.1 u cells
  // from the spawn, walls always solid, furniture solid unless the current
  // cell already overlaps it (updateInteriorMode's stuck-visitor escape).
  test.each(THEMES)('%s', (theme) => {
    enter(theme);
    const step = 0.1;
    const N = Math.round(6.8 / step) + 1;
    const xz = (i: number, j: number): [number, number] => [-3.4 + i * step, -3.4 + j * step];
    const wall = (i: number, j: number): boolean =>
      i < 0 || j < 0 || i >= N || j >= N || scene.interiorWallBlocked(...xz(i, j));
    const prop = (i: number, j: number): boolean => scene.interiorFurnitureBlocked(...xz(i, j));
    const s = statics.INTERIOR_SPAWN;
    const start: [number, number] = [
      Math.round((s.x + 3.4) / step),
      Math.round((s.z + 3.4) / step),
    ];
    const seen = new Set<number>([start[0] * 1000 + start[1]]);
    const queue: Array<[number, number]> = [start];
    while (queue.length) {
      const [i, j] = queue.shift()!;
      const escaping = prop(i, j);
      for (const [di, dj] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        const ni = i + di;
        const nj = j + dj;
        if (wall(ni, nj) || seen.has(ni * 1000 + nj) || (!escaping && prop(ni, nj))) continue;
        seen.add(ni * 1000 + nj);
        queue.push([ni, nj]);
      }
    }
    const cells = [...seen].map((k) => xz(Math.floor(k / 1000), k % 1000));
    const spots = scene.interiorHotspotsFor(theme);
    const unreachable = spots
      .filter((h) => !cells.some(([x, z]) => Math.hypot(x - h.x, z - h.z) < h.r))
      .map((h) => h.label.replace(/<[^>]+>/g, ''));
    expect(unreachable).toEqual([]);
    // Stricter than the survey: each one is THE prompt somewhere reachable.
    // In reach is not enough: at the shell's (1.8, 2.95) the home curtains
    // were in reach in front of the sofa, but the sofa's own spot was always
    // nearer, so they never showed.
    (scene as unknown as { interiorDoorArmed: boolean }).interiorDoorArmed = true;
    const nearest = (x: number, z: number): Hotspot | null =>
      (
        scene as unknown as { nearestInteriorHotspot(x: number, z: number): Hotspot | null }
      ).nearestInteriorHotspot(x, z);
    const shown = new Set(cells.map(([x, z]) => nearest(x, z)?.label));
    const neverShown = spots
      .filter((h) => !shown.has(h.label))
      .map((h) => h.label.replace(/<[^>]+>/g, ''));
    expect(neverShown).toEqual(SHADOWED[theme] ?? []);
    scene.exitInterior();
  });

  test('the Personal floor lamp stands in its corner, out of the doorway', () => {
    enter('home');
    // Its pole's collider moved with it: none blocks the walk from the
    // spawn to the door any more.
    const pole = scene.interiorColliders.home.find(
      (b) => b.maxX - b.minX < 0.2 && b.maxZ - b.minZ < 0.2 && b.minX < -3,
    );
    expect(pole).toBeDefined();
    expect((pole!.minX + pole!.maxX) / 2).toBeCloseTo(-3.3, 2);
    expect((pole!.minZ + pole!.maxZ) / 2).toBeCloseTo(3.3, 2);
    scene.exitInterior();
  });
});
