// LIMB LAYERS — post-mixer poses compose onto the clip, so they cannot stack
// (world laws 2 and 3, measured on the shipped player.glb).
//
// three r180's PropertyMixer writes a bone only when the mixed value changed,
// and Idle's leg tracks are constant: while idle, the mixer rewrote legL/legR
// on 0 of 300 frames. The air pose was `rotation.x += -0.45 * aw` on the live
// bone, so every airborne frame added to the last one. MEASURED live: a fresh
// visitor's first standing jump ran legL from 3.06 to -12.04 rad (about two
// turns, shoes at chest height) and left it there until they walked; a
// skipped arm frame moved the hand +0.50 u and then -1.02 u on landing. The
// feed toss's knee bend and the remote peers' air pose used the same writes.
//
// This suite drives the production code — SimplePlayer.update() on a planet
// and a remote peer's update() under the broadcast air byte — and checks the
// two numbers the bug broke: each leg's rotation.x against its hanging rest
// (PI), and how far a hand moves in one frame in the avatar's own frame.
import * as THREE from 'three';
import { describe, expect, test, vi } from 'vitest';

import { SimplePlayer } from '../SimplePlayer';

// No server in a unit test: read player.glb from disk, with the real loader's
// contract (the scale option applied to the scene), exactly as swimStroke does.
vi.mock('../utils/GLTFModelLoader', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/GLTFModelLoader')>();
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
  return {
    ...actual,
    loadGLTFWithFallbacks: async (url: string, options: { scale?: number } = {}) => {
      const buf = readFileSync(join(process.cwd(), 'public', url));
      const data = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
      const gltf = await new GLTFLoader().parseAsync(data, '');
      if (options.scale && options.scale !== 1) gltf.scene.scale.setScalar(options.scale);
      return { scene: gltf.scene, animations: gltf.animations, loadedUrl: url };
    },
  };
});

const DT = 1 / 60;
const _v = new THREE.Vector3();

function bone(root: THREE.Object3D, name: string): THREE.Object3D {
  const b = root.getObjectByName(name);
  if (!b) throw new Error(`no ${name} bone on the rig`);
  return b;
}

/** |wrap(rotation.x − PI)| in degrees: how far a leg sits from hanging. */
function offRestDeg(leg: THREE.Object3D): number {
  const d = leg.rotation.x - Math.PI;
  return Math.abs((Math.atan2(Math.sin(d), Math.cos(d)) * 180) / Math.PI);
}

type HandVert = { mesh: THREE.SkinnedMesh; i: number; y: number };

/** The hand: the distal tenth of the vertices fully skinned to the arm bone
 *  (swimStroke's definition; the arms hang down in the bind pose). */
function handVerts(root: THREE.Object3D, boneName: string): HandVert[] {
  const out: HandVert[] = [];
  root.traverse((o) => {
    const mesh = o as THREE.SkinnedMesh;
    if (!mesh.isSkinnedMesh) return;
    const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
    if (mat.name === 'Outline') return;
    const j = mesh.skeleton.bones.findIndex((b) => b.name === boneName);
    const { position, skinIndex, skinWeight } = mesh.geometry.attributes;
    for (let i = 0; i < position.count; i++) {
      for (let c = 0; c < 4; c++) {
        if (skinIndex.getComponent(i, c) === j && skinWeight.getComponent(i, c) > 0.95) {
          out.push({ mesh, i, y: position.getY(i) });
        }
      }
    }
  });
  out.sort((a, b) => a.y - b.y);
  return out.slice(0, Math.max(3, Math.floor(out.length * 0.1)));
}

/** Both hands' centroids in `frame`'s local space (so the body's own travel
 *  through a jump is not counted as hand motion). */
function handsIn(frame: THREE.Object3D, hands: Record<'L' | 'R', HandVert[]>) {
  frame.updateMatrixWorld(true);
  const at = (verts: HandVert[]) => {
    const c = new THREE.Vector3();
    for (const { mesh, i } of verts)
      c.add(mesh.getVertexPosition(i, _v).applyMatrix4(mesh.matrixWorld));
    return frame.worldToLocal(c.divideScalar(verts.length));
  };
  return { L: at(hands.L), R: at(hands.R) };
}

/** Step `n` frames, returning the largest single-frame hand move. */
function largestHandStep(
  frame: THREE.Object3D,
  hands: Record<'L' | 'R', HandVert[]>,
  step: () => void,
  n: number,
): number {
  let prev = handsIn(frame, hands);
  let worst = 0;
  for (let k = 0; k < n; k++) {
    step();
    const cur = handsIn(frame, hands);
    worst = Math.max(worst, cur.L.distanceTo(prev.L), cur.R.distanceTo(prev.R));
    prev = cur;
  }
  return worst;
}

interface LocalRig {
  gltfModel: THREE.Group | null;
}

async function standingPlayer(): Promise<{ player: SimplePlayer; model: THREE.Group }> {
  const player = new SimplePlayer();
  const rig = player as unknown as LocalRig;
  await vi.waitFor(
    () => {
      if (!rig.gltfModel) throw new Error('player.glb not loaded yet');
    },
    { timeout: 20000, interval: 20 },
  );
  // On the ideal sphere (no terrain sampler): grounded at radius R + 0.7.
  const R = 100;
  player.setPlanet(new THREE.Vector3(0, 0, 0), R);
  player.setWorldPosition(new THREE.Vector3(0, R + 0.7, 0));
  return { player, model: rig.gltfModel as THREE.Group };
}

describe('post-mixer limb poses compose onto the clip (MOT-01)', () => {
  test('local player: a standing jump after 10 s idle', { timeout: 30000 }, async () => {
    const { player, model } = await standingPlayer();
    const legL = bone(model, 'legL');
    const legR = bone(model, 'legR');
    const hands = { L: handVerts(model, 'armL'), R: handVerts(model, 'armR') };

    for (let k = 0; k < 600; k++) player.update(DT); // 10 s standing still
    expect(player.getIsGrounded()).toBe(true);
    expect(offRestDeg(legL)).toBeLessThan(1);

    player.jump();
    let airborne = 0;
    const handStep = largestHandStep(
      player,
      hands,
      () => {
        player.update(DT);
        if (!player.getIsGrounded()) airborne++;
      },
      70,
    );
    expect(airborne, 'the jump left the ground').toBeGreaterThan(20);
    expect(player.getIsGrounded(), 'and landed').toBe(true);
    expect(offRestDeg(legL), 'legL after landing').toBeLessThan(1);
    expect(offRestDeg(legR), 'legR after landing').toBeLessThan(1);
    expect(handStep, 'largest single-frame hand move (u)').toBeLessThan(0.15);

    for (let k = 0; k < 600; k++) player.update(DT); // and 10 s later
    expect(offRestDeg(legL), 'legL after 10 s idle').toBeLessThan(1);
    expect(offRestDeg(legR), 'legR after 10 s idle').toBeLessThan(1);
  });

  test(
    'local player: the feed toss bends the knees and lets them go',
    { timeout: 30000 },
    async () => {
      const { player, model } = await standingPlayer();
      const legL = bone(model, 'legL');
      for (let k = 0; k < 300; k++) player.update(DT);
      player.triggerFeedToss();
      let worst = 0;
      for (let k = 0; k < 60; k++) {
        player.update(DT);
        worst = Math.max(worst, offRestDeg(legL));
      }
      // The crouch is 0.5 * tossCrouch with tossCrouch <= 1: at most 28.6 deg.
      // Stacked on the live bone it spun the leg instead.
      expect(worst, 'deepest knee bend (deg)').toBeLessThanOrEqual(28.7);
      expect(worst, 'the knees did bend').toBeGreaterThan(5);
      expect(offRestDeg(legL), 'legL after the toss').toBeLessThan(1);
    },
  );

  test('remote peer: the broadcast air byte through a jump', { timeout: 30000 }, async () => {
    const peer = await SimplePlayer.createRemoteAvatar();
    expect(peer, 'createRemoteAvatar').not.toBeNull();
    if (!peer) return;
    const legL = bone(peer.body, 'legL');
    const legR = bone(peer.body, 'legR');
    const hands = { L: handVerts(peer.body, 'armL'), R: handVerts(peer.body, 'armR') };

    for (let k = 0; k < 600; k++) peer.update(DT, 0);
    expect(offRestDeg(legL)).toBeLessThan(1);

    // ~0.57 s airborne, as the local jump measures, then back on foot.
    peer.setPose(3);
    let handStep = largestHandStep(peer.body, hands, () => peer.update(DT, 0), 34);
    peer.setPose(0);
    handStep = Math.max(
      handStep,
      largestHandStep(peer.body, hands, () => peer.update(DT, 0), 36),
    );
    expect(offRestDeg(legL), 'peer legL after landing').toBeLessThan(1);
    expect(offRestDeg(legR), 'peer legR after landing').toBeLessThan(1);
    expect(handStep, 'largest single-frame peer hand move (u)').toBeLessThan(0.15);

    for (let k = 0; k < 600; k++) peer.update(DT, 0);
    expect(offRestDeg(legL), 'peer legL after 10 s idle').toBeLessThan(1);
    peer.dispose();
  });
});

// The close-camera fade (B11), on the shipped player.glb.
describe('the avatar fades when the camera comes close (B11)', () => {
  interface Fade {
    closeFadeMats: THREE.Material[];
    closeFadeHulls: THREE.Object3D[];
    getHandAnchor(): THREE.Object3D | null;
  }
  /** three's own rule for the OPAQUE program variant (WebGLPrograms, r180). */
  const opaqueVariant = (m: THREE.Material): boolean =>
    m.transparent === false && m.blending === THREE.NormalBlending && m.alphaToCoverage === false;
  const FRAME = 1 / 60;

  test('to 0.35 within 150 ms under 1.1 u, and back above 1.3 u', { timeout: 30000 }, async () => {
    const { player } = await standingPlayer();
    const f = player as unknown as Fade;
    const names = f.closeFadeMats.map((m) => m.name).sort();
    expect(names).toEqual(
      ['Blush', 'Eye', 'EyeShine', 'Hair', 'Jacket', 'Pants', 'Shoe', 'Skin'].sort(),
    );
    // The authored outline is a hull: hidden while faded, its material left alone.
    expect(f.closeFadeHulls.map((h) => h.name)).toEqual(['PlayerOutline']);
    const outline = (f.closeFadeHulls[0] as THREE.Mesh).material as THREE.Material;

    // Solid: opaque list, no blending in effect, full opacity.
    for (const m of f.closeFadeMats) {
      expect(m.transparent).toBe(false);
      expect(m.opacity).toBe(1);
      expect([m.blending, m.blendSrc, m.blendDst]).toEqual([
        THREE.CustomBlending,
        THREE.OneFactor,
        THREE.ZeroFactor,
      ]);
    }
    expect(player.getCloseFadeAlpha()).toBe(1);

    // The camera forced to 0.8 u: 0.35 within 150 ms (nine 60 fps frames).
    for (let k = 0; k < 9; k++) player.updateCloseFade(0.8, FRAME);
    expect(player.getCloseFadeAlpha()).toBeCloseTo(SimplePlayer.CLOSE_FADE_ALPHA, 6);
    for (const m of f.closeFadeMats) {
      expect(m.opacity).toBeCloseTo(0.35, 6);
      expect(m.transparent).toBe(true);
      expect(m.blending).toBe(THREE.NormalBlending);
      expect(m.forceSinglePass).toBe(true); // one draw each, double-sided or not
    }
    expect(f.closeFadeHulls[0].visible).toBe(false);
    expect([outline.opacity, outline.transparent]).toEqual([1, false]);

    // Between the two thresholds it holds: no flicker at the edge.
    for (let k = 0; k < 30; k++) player.updateCloseFade(1.2, FRAME);
    expect(player.getCloseFadeAlpha()).toBeCloseTo(0.35, 6);

    // Past 1.3 u everything comes back, in the same 120 ms.
    player.updateCloseFade(1.31, FRAME);
    expect(player.getCloseFadeAlpha()).toBeGreaterThan(0.35);
    for (let k = 0; k < 8; k++) player.updateCloseFade(1.31, FRAME);
    expect(player.getCloseFadeAlpha()).toBe(1);
    for (const m of f.closeFadeMats) {
      expect([m.opacity, m.transparent, m.blending]).toEqual([1, false, THREE.CustomBlending]);
    }
    expect(f.closeFadeHulls[0].visible).toBe(true);
  });

  test(
    'no program changes hands: solid and faded share one variant',
    { timeout: 30000 },
    async () => {
      // three keys a program on its material being opaque. Flipping
      // `transparent` alone at fade time compiles a second variant of every
      // dress program, in the frame the camera closes in.
      const { player } = await standingPlayer();
      const f = player as unknown as Fade;
      const versions = f.closeFadeMats.map((m) => m.version);
      const solid = f.closeFadeMats.map(opaqueVariant);
      for (let k = 0; k < 9; k++) player.updateCloseFade(0.8, FRAME);
      const faded = f.closeFadeMats.map(opaqueVariant);
      for (let k = 0; k < 9; k++) player.updateCloseFade(5, FRAME);
      expect(solid.every((o) => o === false)).toBe(true);
      expect(faded).toEqual(solid);
      // And nothing asked three for a new program (needsUpdate bumps version).
      expect(f.closeFadeMats.map((m) => m.version)).toEqual(versions);
    },
  );

  test(
    'the hat fades with the body; a shared material in the hand does not',
    { timeout: 30000 },
    async () => {
      const { player } = await standingPlayer();
      const f = player as unknown as Fade;
      const body = f.closeFadeMats.length;
      // Something hand-held, built from a material the world also uses.
      const shared = new THREE.MeshToonMaterial({ color: 0x8a6a42 });
      const rod = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.6, 0.02), shared);
      f.getHandAnchor()?.add(rod);
      player.equipHat('party');
      expect(f.closeFadeMats.length).toBeGreaterThan(body);
      expect(f.closeFadeMats).not.toContain(shared);
      const hatMats = f.closeFadeMats.slice(body);

      for (let k = 0; k < 9; k++) player.updateCloseFade(0.8, FRAME);
      for (const m of hatMats) expect(m.opacity).toBeCloseTo(0.35, 6);
      expect([shared.opacity, shared.transparent, shared.blending]).toEqual([
        1,
        false,
        THREE.NormalBlending,
      ]);

      // Taking the hat off takes its materials off the list.
      player.equipHat(null);
      expect(f.closeFadeMats).toHaveLength(body);
      for (let k = 0; k < 9; k++) player.updateCloseFade(5, FRAME);
      expect(player.getCloseFadeAlpha()).toBe(1);
    },
  );

  test('a settled avatar is left alone', { timeout: 30000 }, async () => {
    const { player } = await standingPlayer();
    const f = player as unknown as Fade;
    const first = f.closeFadeMats[0];
    first.opacity = 0.9; // a write the fade would overwrite if it ran
    for (let k = 0; k < 10; k++) player.updateCloseFade(4.4, FRAME);
    expect(first.opacity).toBe(0.9);
    first.opacity = 1;
  });
});
