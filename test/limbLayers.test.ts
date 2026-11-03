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
