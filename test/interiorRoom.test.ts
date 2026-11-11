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
// The first door (CO-A5): the warm prepares the Welcome Hub's programs first,
// in slices sized to the thread, and the first room frame carries no window
// pass.
//
// Behavioural: a real GameScene with its world build switched off builds the
// real room (every theme's furniture and the colliders derived from it), and
// enterInterior and updateInteriorMode run for real on a stand-in player. The
// warm's passes run for real against a stand-in renderer.
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
/** The camera-to-torso distance the last room frame gave the avatar's fade. */
let fadeDistance = Infinity;
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
    // The close-camera fade (B11): the distance each room frame hands it.
    updateCloseFade: (camDistance: number) => {
      fadeDistance = camDistance;
    },
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

describe('a room borrows the island’s light rig (P2-B9)', () => {
  // MEASURED on main (desktop, the Welcome Hub from its entry pose): lamp on,
  // the room read 46.6 L* at 12 h and 34.9 at 21 h; the lamp switch moved it
  // 0.8-1.2 L*; the avatar's median stood 16-26 L* BELOW its surroundings; and
  // the room's four PointLights re-keyed every lit program at each door.
  interface Rig {
    lights: { sun?: THREE.DirectionalLight; ambient?: THREE.AmbientLight };
    hemiLight: THREE.HemisphereLight | null;
    fillLight?: THREE.DirectionalLight;
    rimLight?: THREE.DirectionalLight;
    envCycle: unknown;
    interiorGroup: THREE.Group;
    interiorSets: Record<string, THREE.Group>;
    interiorHearths: Record<string, { glow: THREE.MeshBasicMaterial; pool: THREE.Material }>;
    interiorShades: Array<{ mat: THREE.MeshStandardMaterial; glow: number }>;
    interiorWindowMat: THREE.MeshBasicMaterial;
    rendererRef: unknown;
    toggleInteriorFixture(which: string): string;
    refreshInteriorView(): void;
    setPartyMode(on: boolean): void;
    partyFlash: number;
  }
  const rig = (): Rig => scene as unknown as Rig;
  const env = { day: 1 };
  /** The island's five lights, as an afternoon leaves them. */
  const island = (): {
    sun: THREE.DirectionalLight;
    hemi: THREE.HemisphereLight;
    ambient: THREE.AmbientLight;
    fill: THREE.DirectionalLight;
    rim: THREE.DirectionalLight;
  } => {
    const sun = new THREE.DirectionalLight(0xffe9c0, 1.37);
    sun.position.set(31, 120, 12);
    sun.target.position.set(4, 76, 3);
    sun.shadow.intensity = 0.83;
    const hemi = new THREE.HemisphereLight(0xaacdf7, 0x4a6b32, 0.57);
    const ambient = new THREE.AmbientLight(0xfff6e8, 0.21);
    const fill = new THREE.DirectionalLight(0xd4e8ff, 0.18);
    fill.position.set(7, 11, -38);
    const rim = new THREE.DirectionalLight(0xcfe6ff, 0.51);
    rim.position.set(-40, 26, 20);
    const r = rig();
    r.lights = { sun, ambient };
    r.hemiLight = hemi;
    r.fillLight = fill;
    r.rimLight = rim;
    r.envCycle = { getDayFactor: () => env.day, getHour: () => 12, getWeather: () => 'clear' };
    return { sun, hemi, ambient, fill, rim };
  };
  const unrig = (): void => {
    const r = rig();
    r.lights = {};
    r.hemiLight = null;
    r.fillLight = undefined;
    r.rimLight = undefined;
    r.envCycle = null;
    env.day = 1;
  };
  /** What a renderer reads: every light's direction, colour and level. */
  const read = (l: ReturnType<typeof island>): Record<string, unknown> => ({
    sunPos: l.sun.position.toArray(),
    sunTarget: l.sun.target.position.toArray(),
    sun: [l.sun.color.getHex(), l.sun.intensity, l.sun.shadow.intensity],
    hemiPos: l.hemi.position.toArray(),
    hemi: [l.hemi.color.getHex(), l.hemi.groundColor.getHex(), l.hemi.intensity],
    ambient: [l.ambient.color.getHex(), l.ambient.intensity],
    fillPos: l.fill.position.toArray(),
    fill: [l.fill.color.getHex(), l.fill.intensity],
    rimPos: l.rim.position.toArray(),
    rim: [l.rim.color.getHex(), l.rim.intensity],
  });
  const dirOf = (l: THREE.DirectionalLight): THREE.Vector3 =>
    l.position.clone().sub(l.target.position).normalize();
  const settle = (seconds = 2): void => {
    for (let i = 0; i < seconds * 60; i++) scene.updateInteriorMode(1 / 60);
  };
  const hex = (n: number): number => new THREE.Color(n).getHex();

  test('the room is built without a light', () => {
    let lights = 0;
    rig().interiorGroup.traverse((o) => {
      if ((o as THREE.Light).isLight) lights++;
    });
    expect(lights).toBe(0);
  });

  test('lamp on, by day: a warm key over the shoulder, cream hemisphere, cool window rim', () => {
    const l = island();
    try {
      enter('hall');
      scene.updateInteriorMode(1 / 60);
      const o = statics.INTERIOR_ORIGIN;
      // In room space: aimed at the room's origin, 300 u under the island.
      expect(l.sun.target.position.equals(o)).toBe(true);
      const key = new THREE.Vector3(0.35, 0.9, 0.45).normalize();
      expect(dirOf(l.sun).angleTo(key)).toBeLessThan(1e-6);
      expect([l.sun.color.getHex(), l.sun.intensity]).toEqual([hex(0xffe2bc), 1.25]);
      // Nothing in a room receives the island's shadow map.
      expect(l.sun.shadow.intensity).toBe(0);
      expect(l.hemi.position.toArray()).toEqual([0, 1, 0]);
      expect([l.hemi.color.getHex(), l.hemi.groundColor.getHex(), l.hemi.intensity]).toEqual([
        hex(0xfff0dc),
        hex(0x6b5640),
        0.95,
      ]);
      expect(l.ambient.intensity).toBe(0.22);
      expect(dirOf(l.rim).angleTo(new THREE.Vector3(-0.2, 0.3, 1).normalize())).toBeLessThan(1e-6);
      expect([l.rim.color.getHex(), l.rim.intensity]).toEqual([hex(0xcfe6ff), 0.25]);
      // The fill comes from the room camera, onto the avatar.
      const p = (scene.player as { position: THREE.Vector3 }).position;
      const along = scene.camera.position.clone().sub(p).normalize();
      expect(dirOf(l.fill).angleTo(along)).toBeLessThan(1e-6);
      expect(l.fill.intensity).toBeCloseTo(0.2, 9);
    } finally {
      scene.exitInterior();
      unrig();
    }
  });

  test('the island gets its rig back exactly, on the way out', () => {
    const l = island();
    try {
      const before = read(l);
      enter('cottage');
      settle(1);
      expect(read(l)).not.toEqual(before);
      scene.exitInterior();
      expect(read(l)).toEqual(before);
      // A second entry with no exit between keeps the island's values, not the room's.
      enter('hall');
      enter('office');
      settle(0.5);
      scene.exitInterior();
      expect(read(l)).toEqual(before);
    } finally {
      scene.exitInterior();
      unrig();
    }
  });

  test('at night the key turns amber and the window’s rim falls away', () => {
    const l = island();
    try {
      env.day = 0;
      enter('hall');
      scene.updateInteriorMode(1 / 60);
      expect([l.sun.color.getHex(), l.sun.intensity]).toEqual([hex(0xffd59a), 1.25]);
      expect(l.rim.intensity).toBeCloseTo(0.1, 9);
      // Golden hour is still day (EnvironmentCycle's day factor at 06 h and 18 h).
      scene.exitInterior();
      env.day = 0.198;
      enter('hall');
      scene.updateInteriorMode(1 / 60);
      expect(l.sun.color.getHex()).toBe(hex(0xffe2bc));
      expect(l.rim.intensity).toBeCloseTo(0.25, 9);
    } finally {
      scene.exitInterior();
      unrig();
    }
  });

  test('the lamp switch eases the room to window light, and back', () => {
    const l = island();
    try {
      enter('hall');
      scene.updateInteriorMode(1 / 60);
      expect(rig().toggleInteriorFixture('lamp')).toContain('off');
      // One frame in, it has moved 15% of the way (9 per second), not jumped.
      scene.updateInteriorMode(1 / 60);
      expect(l.sun.intensity).toBeCloseTo(1.25 + (0.45 - 1.25) * 0.15, 6);
      settle();
      const window = new THREE.Vector3(0.1, 0.35, 1).normalize();
      expect(dirOf(l.sun).angleTo(window)).toBeLessThan(1e-4);
      expect(l.sun.color.getHex()).toBe(hex(0xcfe0ff));
      expect(l.sun.intensity).toBeCloseTo(0.45, 6);
      expect(l.hemi.intensity).toBeCloseTo(0.5, 6);
      expect([l.hemi.color.getHex(), l.hemi.groundColor.getHex()]).toEqual([
        hex(0xd8e4f2),
        hex(0x4a4038),
      ]);
      expect(l.ambient.intensity).toBeCloseTo(0.12, 6);
      expect(l.rim.intensity).toBeCloseTo(0.35, 6);
      // The shades stop glowing with the lamp.
      for (const s of rig().interiorShades) expect(s.mat.emissiveIntensity).toBeLessThan(0.001);
      // By moonlight the window gives a fraction of it.
      env.day = 0;
      settle();
      expect(l.sun.color.getHex()).toBe(hex(0x9db3e6));
      expect(l.sun.intensity).toBeCloseTo(0.2, 6);
      // Draw the curtains and most of what the window gave is gone.
      env.day = 1;
      settle();
      expect(rig().toggleInteriorFixture('curtains')).toContain('draw');
      settle();
      expect(l.sun.intensity).toBeCloseTo(0.45 * 0.2, 3);
      expect(l.rim.intensity).toBeCloseTo(0.35 * 0.2, 3);
      rig().toggleInteriorFixture('curtains');
      // Back on.
      expect(rig().toggleInteriorFixture('lamp')).toContain('on');
      settle();
      expect(l.sun.intensity).toBeCloseTo(1.25, 6);
      expect(l.hemi.intensity).toBeCloseTo(0.95, 6);
      for (const s of rig().interiorShades) expect(s.mat.emissiveIntensity).toBeCloseTo(s.glow, 3);
    } finally {
      scene.exitInterior();
      unrig();
    }
  });

  test('the window pass sees the island’s light, the room frame the room’s', () => {
    const l = island();
    const r = rig();
    const seen: Array<Record<string, unknown>> = [];
    r.rendererRef = {
      getRenderer: () => ({
        getRenderTarget: () => null,
        setRenderTarget: () => {},
        render: () => seen.push(read(l)),
      }),
    };
    try {
      const before = read(l);
      enter('hall');
      settle(0.2); // the second room frame paints the window
      expect(seen.length).toBeGreaterThan(0);
      for (const during of seen) expect(during).toEqual(before);
      // And the room's rig is back on for the frame that follows.
      expect(l.sun.intensity).toBe(1.25);
      expect(l.sun.shadow.intensity).toBe(0);
      expect(l.sun.target.position.equals(statics.INTERIOR_ORIGIN)).toBe(true);
    } finally {
      scene.exitInterior();
      r.rendererRef = null;
      unrig();
    }
  });

  test('a party dims the house lights and rides the beat on the same five', () => {
    const l = island();
    const r = rig();
    try {
      enter('beach'); // the beach house is already a party
      scene.updateInteriorMode(1 / 60);
      // Club levels from the first frame: no ease down from the lamp-lit room.
      expect(l.sun.intensity - r.partyFlash * 0.3).toBeCloseTo(0.14, 6);
      expect(l.ambient.intensity).toBeCloseTo(0.08, 6);
      // The beat's flash is on the key; nothing was added to the scene for it.
      r.partyFlash = 3.4;
      scene.updateInteriorMode(0);
      expect(l.sun.intensity).toBeCloseTo(0.14 + 3.4 * 0.3, 6);
      let lights = 0;
      r.interiorGroup.traverse((o) => {
        if ((o as THREE.Light).isLight) lights++;
      });
      expect(lights).toBe(0);
      // Party over: the lamp-lit room comes back up, and the rim is the window's again.
      r.setPartyMode(false);
      settle();
      expect(l.sun.intensity).toBeCloseTo(1.25, 4);
      expect(l.rim.color.getHex()).toBe(hex(0xcfe6ff));
    } finally {
      scene.exitInterior();
      unrig();
    }
  });

  test('the hearth’s firelight flickers on the embers and a pool, and blocks nobody', () => {
    const r = rig();
    expect(Object.keys(r.interiorHearths).sort()).toEqual(['cottage', 'home']);
    enter('home');
    try {
      const { glow, pool } = r.interiorHearths.home;
      const reds = new Set<number>();
      const pools = new Set<number>();
      for (let i = 0; i < 30; i++) {
        scene.updateInteriorMode(1 / 60);
        reds.add(+glow.color.r.toFixed(4));
        pools.add(+pool.opacity.toFixed(4));
      }
      expect(reds.size).toBeGreaterThan(10);
      expect(pools.size).toBeGreaterThan(10);
      // The pool lies on the floor in front of the grate: no collider for it.
      expect(scene.interiorFurnitureBlocked(-2.2, -0.9)).toBe(false);
    } finally {
      scene.exitInterior();
    }
  });
});

describe('rooms wear the island’s cel look (P2-B10)', () => {
  // MEASURED on main: 92 lit, opaque MeshStandard materials in the room, shaded
  // smooth beside a banded island, on programs of their own.
  interface Look {
    interiorGroup: THREE.Group;
    interiorSets: Record<string, THREE.Group>;
    interiorWallMat: THREE.MeshToonMaterial;
    interiorTrim: Array<{ mat: THREE.MeshToonMaterial; base: THREE.Color }>;
    partyProps: { tiles: THREE.Mesh[]; ball: THREE.Mesh };
  }
  const look = (): Look => scene as unknown as Look;
  type Mat = THREE.Material & {
    isMeshStandardMaterial?: boolean;
    isMeshToonMaterial?: boolean;
    gradientMap?: THREE.Texture | null;
    map?: THREE.Texture | null;
  };
  /** Every material in the room with the meshes that carry it. */
  const census = (): Map<Mat, THREE.Mesh[]> => {
    const out = new Map<Mat, THREE.Mesh[]>();
    look().interiorGroup.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || m.userData.isCelHull) return;
      for (const mat of (Array.isArray(m.material) ? m.material : [m.material]) as Mat[]) {
        out.set(mat, [...(out.get(mat) ?? []), m]);
      }
    });
    return out;
  };
  const hullsUnder = (root: THREE.Object3D): number => {
    let n = 0;
    root.traverse((o) => {
      if (o.userData.isCelHull) n++;
    });
    return n;
  };

  test('standard shading is left on the posters and the party tiles only', () => {
    const tiles = new Set(look().partyProps.tiles);
    let ramp: THREE.Texture | null = null;
    let toon = 0;
    for (const [mat, meshes] of census()) {
      if (mat.isMeshStandardMaterial) {
        // A poster (its text is a map on a transparent sheet) or a floor tile.
        const poster = mat.transparent && !!mat.map;
        expect(poster || meshes.every((m) => tiles.has(m)), mat.type).toBe(true);
        continue;
      }
      if (!mat.isMeshToonMaterial) continue; // the unlit ones: pane, bulb, embers, discs
      toon++;
      expect(mat.gradientMap).toBeTruthy();
      ramp = ramp ?? mat.gradientMap ?? null;
      expect(mat.gradientMap).toBe(ramp); // the one ramp, shared
    }
    expect(toon).toBeGreaterThan(60);
    // The disco ball is faceted in its geometry, so it needs no program of its own.
    const ball = look().partyProps.ball;
    expect((ball.material as Mat).isMeshToonMaterial).toBe(true);
    expect(ball.geometry.index).toBeNull();
    expect((ball.material as THREE.Material & { flatShading?: boolean }).flatShading).not.toBe(
      true,
    );
  });

  test('ink on every set’s big pieces, or on none (the low tier)', () => {
    const counts = Object.entries(look().interiorSets).map(([name, s]) => [name, hullsUnder(s)]);
    const inked = counts.filter(([, n]) => (n as number) > 0);
    // addGroupHulls decides by tier: all seven sets on desktop, none on a phone.
    expect([0, THEMES.length]).toContain(inked.length);
    // Never on the shell, and never on a flat piece (a banner, the firelight pool).
    let shell = 0;
    let flat = 0;
    look().interiorGroup.traverse((o) => {
      if (!o.userData.isCelHull) return;
      const host = o.parent as THREE.Mesh;
      if (!Object.values(look().interiorSets).some((s) => under(host, s))) shell++;
      if (host.geometry.type === 'PlaneGeometry') flat++;
    });
    expect([shell, flat]).toEqual([0, 0]);
  });

  test('the wainscot is panelling: a darker field, slim stiles 1.6 u apart', () => {
    const g = look().interiorGroup;
    const stiles: THREE.Mesh[] = [];
    const fields: THREE.Mesh[] = [];
    g.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || m.geometry.type !== 'BoxGeometry') return;
      const p = (m.geometry as THREE.BoxGeometry).parameters;
      if (p.height === 0.74 && p.depth === 0.05) stiles.push(m);
      if (p.height === 0.74 && p.depth === 0.03) fields.push(m);
    });
    expect(stiles.length).toBeGreaterThan(12);
    for (const s of stiles) {
      expect((s.geometry as THREE.BoxGeometry).parameters.width).toBe(0.05);
    }
    // The back wall's run (7.76 u): 5 bays, so 6 stiles 1.55 u apart.
    const back = stiles
      .filter((s) => Math.abs(s.parent!.rotation.y - Math.PI) < 1e-6)
      .map((s) => s.position.x)
      .sort((a, b) => a - b);
    expect(back).toHaveLength(6);
    expect(back[1] - back[0]).toBeCloseTo(1.552, 3);
    // Two steps under the wall, and the wall's limewash is a small soft map.
    const field = fields[0].material as THREE.MeshToonMaterial;
    expect(field.color.getHex()).toBe(new THREE.Color(0xb9a98f).getHex());
    const wash = look().interiorWallMat.map as THREE.Texture;
    expect([wash.image.width, wash.image.height]).toEqual([64, 64]);
  });

  test('the trim takes the district’s accent, and goes back to wood without one', () => {
    const trim = look().interiorTrim;
    expect(trim).toHaveLength(2); // the rails and stiles, and the skirting
    const want = (accent: number, t: { base: THREE.Color }): number =>
      t.base.clone().lerp(new THREE.Color(accent).multiplyScalar(0.62), 0.55).getHex();
    // A hall is handed its district's accent as the wall colour.
    scene.enterInterior('Work', 0x7fa8c9, '', '', 'office');
    for (const t of trim) expect(t.mat.color.getHex()).toBe(want(0x7fa8c9, t));
    scene.exitInterior();
    scene.enterInterior('Projects', 0xc9a06a, '', '', 'workshop');
    for (const t of trim) expect(t.mat.color.getHex()).toBe(want(0xc9a06a, t));
    scene.exitInterior();
    // A house takes the accent of the district it stands in, by its doorstep.
    // Far from every plaza (the far side of the planet) there is none: wood.
    const player = scene.player as { getWorldPosition: () => THREE.Vector3 };
    const doorstep = player.getWorldPosition;
    player.getWorldPosition = () => new THREE.Vector3(0, -76, 0);
    try {
      scene.enterInterior('A cosy home', 0xe0c9a8, '', '', 'cottage', 'house_0');
      for (const t of trim) expect(t.mat.color.getHex()).toBe(t.base.getHex());
      scene.exitInterior();
    } finally {
      player.getWorldPosition = doorstep;
    }
  });

  test('desks, benches and counters stand at 0.8 of their old height', () => {
    /** The top of a set's box of this size (width, height, depth), room-local. */
    const topOf = (theme: string, w: number, h: number, d: number): number => {
      let top = -Infinity;
      look().interiorSets[theme].traverse((n) => {
        const m = n as THREE.Mesh;
        if (!m.isMesh || m.geometry.type !== 'BoxGeometry' || m.userData.isCelHull) return;
        const p = (m.geometry as THREE.BoxGeometry).parameters;
        if (p.width !== w || p.height !== h || p.depth !== d) return;
        top = Math.max(top, m.position.y + p.height / 2);
      });
      return top;
    };
    // Was 1.01 (desk), 1.02 (workbench), 1.18 (counter), 0.56 (visitor bench).
    expect(topOf('office', 2.4, 0.12, 1.0)).toBeCloseTo(0.82, 6);
    expect(topOf('workshop', 2.6, 0.14, 1.0)).toBeCloseTo(0.83, 6);
    expect(topOf('post', 3.1, 0.1, 0.95)).toBeCloseTo(0.98, 6);
    expect(topOf('hall', 2.1, 0.12, 0.5)).toBeCloseTo(0.46, 6);
    // Their legs reach them and stop: none stands proud of its top.
    expect(topOf('office', 0.12, 0.7, 0.12)).toBeCloseTo(0.7, 6);
    expect(topOf('workshop', 0.14, 0.7, 0.14)).toBeCloseTo(0.7, 6);
    expect(topOf('hall', 0.12, 0.4, 0.45)).toBeCloseTo(0.4, 6);
    // What stood on the desk came down with it: the monitor's stand sits on it.
    expect(topOf('office', 0.12, 0.3, 0.12) - 0.3).toBeCloseTo(0.82, 6);
  });
});

describe('a wall behind the camera fades the avatar (B11)', () => {
  // The room camera trails 2.4 u behind the avatar and is clamped inside the
  // walls, so a visitor with their back to a wall has it at their shoulder.
  test('measured from the room-space avatar: far at the spawn, near against the door wall', () => {
    enter('hall');
    scene.updateInteriorMode(1 / 60);
    // SimplePlayer fades in under 1.1 u and back out over 1.3 u.
    expect(fadeDistance).toBeGreaterThan(1.3);
    // Back against the front wall, still facing into the room.
    const o = statics.INTERIOR_ORIGIN;
    const p = (scene.player as { position: THREE.Vector3 }).position;
    p.set(o.x - 0.5, p.y, o.z + 3.3);
    for (let i = 0; i < 90; i++) scene.updateInteriorMode(1 / 60);
    expect(fadeDistance).toBeLessThan(1.1);
    // The stand-in's getWorldPosition() is the doorstep, 376 u away: the
    // distance came from player.position, the group that is in the room.
    expect(fadeDistance).toBeGreaterThan(0.5);
    scene.exitInterior();
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

/** The private warm surface the CO-A5 tests drive. */
interface Warm {
  interiorGroup: THREE.Group;
  interiorSets: Record<string, THREE.Group>;
  partyProps: { group: THREE.Group } | null;
  insideInterior: boolean;
  interiorWarmed: boolean;
  interiorViewBucket: number;
  warmYieldMs: number;
  warmSliceMs(): number;
  warmYield(): Promise<void>;
  interiorWarmItems(
    room: THREE.Object3D,
    roomItems: boolean,
  ): { first: THREE.Object3D[]; rest: THREE.Object3D[] };
  compileInteriorPass(
    gl: unknown,
    g: THREE.Group,
    items: THREE.Object3D[],
    roomVisible: boolean,
    target: null,
  ): Promise<unknown[]>;
  warmInteriorPasses(gl: unknown, khr: boolean): Promise<void>;
  warmInteriorPosters(): void;
  drawPoster(i: number, text: string, big: boolean): void;
  refreshInteriorView(): void;
  add(...o: THREE.Object3D[]): void;
  remove(...o: THREE.Object3D[]): void;
  traverseVisible(cb: (o: THREE.Object3D) => void): void;
}

const under = (o: THREE.Object3D, root: THREE.Object3D): boolean => {
  for (let x: THREE.Object3D | null = o; x; x = x.parent) if (x === root) return true;
  return false;
};

const box = (m: THREE.Material): THREE.Mesh => new THREE.Mesh(new THREE.BoxGeometry(), m);

/** A renderer stand-in. compile() reports the lights and the objects it was
 *  fed, then burns `burnMs` of the slice. */
const fakeGl = (
  onCompile: (lights: THREE.Object3D[], objects: THREE.Object3D[]) => void,
  burnMs: number,
): {
  getRenderTarget: () => null;
  setRenderTarget: () => void;
  properties: { get: () => object };
  compile: (chunk: THREE.Object3D) => Set<THREE.Material>;
} => ({
  getRenderTarget: () => null,
  setRenderTarget: () => {},
  properties: { get: () => ({}) },
  compile: (chunk: THREE.Object3D) => {
    const lights: THREE.Object3D[] = [];
    chunk.traverseVisible((o) => {
      if ((o as THREE.Light).isLight) lights.push(o);
    });
    const objects: THREE.Object3D[] = [];
    chunk.traverse((o) => objects.push(o));
    onCompile(lights, objects);
    const until = performance.now() + burnMs;
    while (performance.now() < until) {
      /* the compile's main-thread time */
    }
    return new Set<THREE.Material>();
  },
});

describe('the warm prepares the first door first (CO-A5)', () => {
  // MEASURED at 4x CPU on a phone, the warm started at the welcome card and
  // E came 3.1 s later: +11 programs, a 1,141 ms frame, 1,917 ms of black.
  // The room-lit pass took 19 s, one ~4 ms slice a ~60 ms frame, and the
  // Welcome Hub's programs came last in scene order.
  test('first: the shell, the hall, the unculled world and the player; rest: the other rooms and the villagers', () => {
    const w = scene as unknown as Warm;
    const g = w.interiorGroup;
    const sets = w.interiorSets;
    const party = w.partyProps!.group;
    const culled = box(new THREE.MeshStandardMaterial());
    const unculled = box(new THREE.MeshToonMaterial());
    unculled.frustumCulled = false; // the instanced fleets, traffic, skinned avatars
    const unlit = box(new THREE.MeshBasicMaterial());
    unlit.frustumCulled = false;
    // Culled, yet drawn indoors: what the player wears stands in every room,
    // and a villager is borrowed into the cottages and the beach house.
    const avatar = new THREE.Group();
    const hat = box(new THREE.MeshToonMaterial());
    avatar.add(hat);
    const villager = new THREE.Group();
    const tunic = box(new THREE.MeshToonMaterial());
    villager.add(tunic);
    w.add(culled, unculled, unlit, avatar, villager);
    const player = scene.player as { traverse?: (cb: (o: THREE.Object3D) => void) => void };
    const island = scene.island as { npcTargets: unknown[] };
    player.traverse = (cb) => avatar.traverse(cb);
    island.npcTargets = [{ name: 'Gardener', position: new THREE.Vector3(), meshRef: villager }];
    try {
      const { first, rest } = w.interiorWarmItems(g, true);
      // first: what the Welcome Hub's first frame draws, and nothing else.
      const inSet = (o: THREE.Object3D): boolean => Object.values(sets).some((s) => under(o, s));
      expect(first).toContain(unculled);
      expect(first).toContain(hat);
      expect(first.some((o) => under(o, sets.hall))).toBe(true);
      expect(first.some((o) => under(o, g) && !inSet(o))).toBe(true); // the shell
      for (const o of first.filter((x) => under(x, g))) {
        expect(under(o, party)).toBe(false);
        expect(!inSet(o) || under(o, sets.hall)).toBe(true);
      }
      // rest: the other rooms, the party rig and the villagers.
      expect(rest.some((o) => under(o, sets.office))).toBe(true);
      expect(rest.some((o) => under(o, party))).toBe(true);
      expect(rest).toContain(tunic);
      expect(rest.every((o) => under(o, g) || o === tunic)).toBe(true);
      // No other culled world object is drawn from the room, which sits
      // 300 u below the planet's centre; nor is an unlit one re-keyed.
      expect([...first, ...rest]).not.toContain(culled);
      expect([...first, ...rest]).not.toContain(unlit);

      // The outdoor pass: every lit world object, none of the room, no first.
      const out = w.interiorWarmItems(g, false);
      expect(out.first).toEqual([]);
      expect(out.rest).toEqual(expect.arrayContaining([culled, unculled, hat, tunic]));
      expect(out.rest).not.toContain(unlit);
      expect(out.rest.some((o) => under(o, g))).toBe(false);
    } finally {
      delete player.traverse;
      island.npcTargets = [];
      w.remove(culled, unculled, unlit, avatar, villager);
    }
  });

  test('a material shared with the hall is warmed with the hall', () => {
    const w = scene as unknown as Warm;
    const sets = w.interiorSets;
    const shared = new THREE.MeshStandardMaterial();
    const inOffice = box(shared);
    const inHall = box(shared);
    sets.office.add(inOffice);
    sets.hall.add(inHall);
    try {
      const { first, rest } = w.interiorWarmItems(w.interiorGroup, true);
      expect(first).toContain(inHall);
      expect(rest).not.toContain(inOffice); // the same program, warmed once
    } finally {
      sets.office.remove(inOffice);
      sets.hall.remove(inHall);
    }
  });

  test('the passes draw the posters, then compile the first door, then the rest', async () => {
    const w = scene as unknown as Warm;
    const g = w.interiorGroup;
    const posters = vi.spyOn(w, 'drawPoster');
    const order: THREE.Object3D[] = [];
    let postersAtFirstCompile = -1;
    const shownAtCompile = new Set<boolean>();
    const gl = fakeGl((_lights, objects) => {
      if (postersAtFirstCompile < 0) postersAtFirstCompile = posters.mock.calls.length;
      shownAtCompile.add(g.visible);
      order.push(...objects);
    }, 0);
    const { first, rest } = w.interiorWarmItems(g, true);
    const warmed = w.interiorWarmed;
    try {
      await w.warmInteriorPasses(gl, false);
      // Every poster canvas and both font sizes are used before a door is.
      expect(postersAtFirstCompile).toBe(3);
      expect(posters.mock.calls.map((c) => [c[0], c[2]])).toEqual([
        [0, true],
        [1, false],
        [2, false],
      ]);
      const at = (o: THREE.Object3D): number => order.indexOf(o);
      expect(first.length).toBeGreaterThan(0);
      expect(rest.length).toBeGreaterThan(0);
      expect([...first, ...rest].every((o) => at(o) >= 0)).toBe(true);
      expect(Math.max(...first.map(at))).toBeLessThan(Math.min(...rest.map(at)));
      // The room was shown only inside a slice.
      expect(shownAtCompile.has(true)).toBe(true);
      expect(g.visible).toBe(false);
    } finally {
      posters.mockRestore();
      w.interiorWarmed = warmed;
    }
  });

  test('a slice is 4 ms on a free thread and up to 12 ms on a busy one', async () => {
    // MEASURED at 4x CPU: a frame takes 55-110 ms, a zero-delay timer comes
    // back after 80-240 ms and a new program costs 4-5 ms. 4 ms slices
    // compiled one program a frame.
    const w = scene as unknown as Warm;
    const g = w.interiorGroup;
    // 15% of the gap the thread last took to come back, within 4-12 ms.
    for (const [gap, ms] of [
      [0, 4],
      [16.7, 4],
      [40, 6],
      [80, 12],
      [500, 12],
    ]) {
      w.warmYieldMs = gap;
      expect(w.warmSliceMs()).toBeCloseTo(ms, 5);
    }
    // warmYield measures that gap itself.
    w.warmYieldMs = 9999;
    await w.warmYield();
    expect(w.warmYieldMs).toBeLessThan(1000);

    // And a pass spends it: 12 objects of 3 ms each take fewer slices on a
    // thread that comes back after 80 ms than on one that comes straight back.
    const items = Array.from({ length: 12 }, () => box(new THREE.MeshBasicMaterial()));
    const gl = fakeGl(() => {}, 3);
    const slices = async (gap: number): Promise<number> => {
      w.warmYieldMs = gap;
      const yielded = vi.spyOn(w, 'warmYield').mockImplementation(async () => {
        w.warmYieldMs = gap;
      });
      try {
        await w.compileInteriorPass(gl, g, items, true, null);
        return yielded.mock.calls.length;
      } finally {
        yielded.mockRestore();
      }
    };
    try {
      const free = await slices(0);
      const busy = await slices(80);
      expect(free).toBeGreaterThanOrEqual(6); // 2 objects a 4 ms slice
      expect(busy).toBeLessThanOrEqual(free - 2); // 4 objects a 12 ms slice
    } finally {
      w.warmYieldMs = 0;
    }
  });

  test('each slice feeds the lights a frame would draw with, with no scene walk', async () => {
    // MEASURED at 4x CPU, a traverseVisible of the whole scene per slice cost
    // 2.9 ms of its 4 ms budget.
    const w = scene as unknown as Warm;
    const g = w.interiorGroup;
    const lamp = new THREE.PointLight();
    const parkedHome = new THREE.Group();
    parkedHome.visible = false;
    const parked = new THREE.PointLight();
    parkedHome.add(parked);
    w.add(lamp, parkedHome);
    const walk = vi.spyOn(w, 'traverseVisible');
    const fed: THREE.Object3D[][] = [];
    // 13 ms a compile: over any slice's budget, so every slice takes one item.
    const gl = fakeGl((lights) => {
      fed.push(lights);
      if (fed.length === 1) lamp.visible = false; // hidden mid-pass
    }, 13);
    const items = [0, 1].map(() => box(new THREE.MeshBasicMaterial()));
    try {
      await w.compileInteriorPass(gl, g, items, true, null);
      expect(walk).not.toHaveBeenCalled();
      expect(fed).toHaveLength(2);
      expect(fed[0]).toContain(lamp);
      expect(fed[1]).not.toContain(lamp); // the next slice counts it as a frame would
      for (const lights of fed) expect(lights).not.toContain(parked);
      // The room brings no light of its own (P2-B9): shown or hidden, a slice
      // is fed the same lights, so the two passes compile one set of programs.
      expect(fed.flat().some((l) => under(l, g))).toBe(false);
      lamp.visible = true;
      const shown: THREE.Object3D[][] = [];
      const hidden: THREE.Object3D[][] = [];
      await w.compileInteriorPass(
        fakeGl((l) => shown.push(l), 13),
        g,
        items.slice(0, 1),
        true,
        null,
      );
      await w.compileInteriorPass(
        fakeGl((l) => hidden.push(l), 13),
        g,
        items.slice(0, 1),
        false,
        null,
      );
      expect(shown[0]).toEqual(hidden[0]);
      expect(shown[0]).toContain(lamp);
      expect(g.visible).toBe(false); // and hidden again after it
    } finally {
      walk.mockRestore();
      w.remove(lamp, parkedHome);
    }
  });
});

describe('the first room frame carries no window pass (CO-A5)', () => {
  // MEASURED on a phone at 4x CPU: the window's render of the island took
  // 36 ms of the first room frame, which is drawn under the door veil at full
  // black. The veil starts to lift only once that frame is out.
  test('an entry paints the window on its second frame, a change of light at once', () => {
    const w = scene as unknown as Warm;
    const paint = vi.spyOn(w, 'refreshInteriorView').mockImplementation(() => {});
    try {
      enter('hall');
      scene.updateInteriorMode(1 / 60);
      expect(paint).not.toHaveBeenCalled();
      scene.updateInteriorMode(1 / 60);
      expect(paint).toHaveBeenCalledTimes(1);
      scene.updateInteriorMode(1 / 60);
      expect(paint).toHaveBeenCalledTimes(1); // and no more while the view holds
      // Mid-visit the outside changes (a new five-minute bucket, the weather):
      // nothing covers the room now, so the pane repaints in that frame.
      w.interiorViewBucket = 99;
      scene.updateInteriorMode(1 / 60);
      expect(paint).toHaveBeenCalledTimes(2);
      scene.exitInterior();
      // The next building waits its one frame again.
      enter('office');
      scene.updateInteriorMode(1 / 60);
      expect(paint).toHaveBeenCalledTimes(2);
      scene.updateInteriorMode(1 / 60);
      expect(paint).toHaveBeenCalledTimes(3);
    } finally {
      paint.mockRestore();
      scene.exitInterior();
    }
  });
});
