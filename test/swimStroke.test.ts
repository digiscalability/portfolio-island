// Swim-stroke KINEMATICS lock (world laws 2 and 3: measure the rig).
//
// A front crawl is a windmill with a direction: each hand travels FORWARD over
// the top of the stroke (the recovery) and BACK under the body (the pull).
// Both pose paths shipped turning the other way (`REST_X - swimPhase` on the
// local player, `-Math.PI - swimClock` on remote peers), and a source pin in
// visualPolish.test.ts locked that text in. Measured on the live rig, every
// hand moved backward over the top and forward underwater.
//
// So this suite pins behaviour, not text. It drives the production pose code
// on the shipped player.glb: the local player's applySwimPose, and update() on
// a dummy remote peer from createRemoteAvatar (never networked). It follows
// each hand (the distal tenth of the vertices skinned to the arm bone) round
// its shoulder. Forward is measured as well: the direction the standing rig's
// face points (eye vertices ahead of the head bone), which the swimmer must
// lead with, head first.
import * as THREE from 'three';
import { describe, expect, test, vi } from 'vitest';

import { SimplePlayer } from '../SimplePlayer';

// No server in a unit test: read player.glb from disk, with the real loader's
// contract (the scale option applied to the scene).
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

/** The private members of SimplePlayer this suite drives. */
interface LocalSwimmer {
  gltfModel: THREE.Group | null;
  applySwimPose(dt: number, moving: boolean, tangSpeed?: number): void;
}

type HandVert = { mesh: THREE.SkinnedMesh; i: number; y: number };

const _v = new THREE.Vector3();

function bone(root: THREE.Object3D, name: string): THREE.Object3D {
  const b = root.getObjectByName(name);
  if (!b) throw new Error(`no ${name} bone on the rig`);
  return b;
}

function skinnedParts(root: THREE.Object3D, material: (name: string) => boolean) {
  const out: THREE.SkinnedMesh[] = [];
  root.traverse((o) => {
    const mesh = o as THREE.SkinnedMesh;
    if (!mesh.isSkinnedMesh) return;
    const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
    if (material(mat.name)) out.push(mesh);
  });
  return out;
}

/** The hand: the distal tenth of the vertices fully skinned to the arm bone.
 *  The arms hang down in the bind pose, so distal = lowest. */
function handVerts(root: THREE.Object3D, boneName: string): HandVert[] {
  const out: HandVert[] = [];
  for (const mesh of skinnedParts(root, (m) => m !== 'Outline')) {
    const j = mesh.skeleton.bones.findIndex((b) => b.name === boneName);
    const { position, skinIndex, skinWeight } = mesh.geometry.attributes;
    for (let i = 0; i < position.count; i++) {
      for (let c = 0; c < 4; c++) {
        if (skinIndex.getComponent(i, c) === j && skinWeight.getComponent(i, c) > 0.95) {
          out.push({ mesh, i, y: position.getY(i) });
        }
      }
    }
  }
  out.sort((a, b) => a.y - b.y);
  return out.slice(0, Math.max(3, Math.floor(out.length * 0.1)));
}

function centroid(verts: HandVert[]): THREE.Vector3 {
  const c = new THREE.Vector3();
  for (const { mesh, i } of verts)
    c.add(mesh.getVertexPosition(i, _v).applyMatrix4(mesh.matrixWorld));
  return c.divideScalar(verts.length);
}

/** Forward, measured on the STANDING rig: where the face points (the eye
 *  vertices ahead of the head bone), flattened against `up`. */
function faceDirection(root: THREE.Object3D, up: THREE.Vector3): THREE.Vector3 {
  root.updateMatrixWorld(true);
  const eyes = new THREE.Vector3();
  let n = 0;
  for (const mesh of skinnedParts(root, (m) => m === 'Eye')) {
    for (let i = 0; i < mesh.geometry.attributes.position.count; i++) {
      eyes.add(mesh.getVertexPosition(i, _v).applyMatrix4(mesh.matrixWorld));
      n++;
    }
  }
  expect(n, 'Eye vertices on the rig').toBeGreaterThan(0);
  const face = eyes.divideScalar(n).sub(bone(root, 'head').getWorldPosition(new THREE.Vector3()));
  return face.addScaledVector(up, -face.dot(up)).normalize();
}

interface HandPath {
  up: number[];
  fwd: number[];
  /** Net angle swept round the shoulder, from up toward forward (radians). */
  turn: number;
}

/** Step the pose `steps` times, following each hand relative to its shoulder. */
function followHands(
  root: THREE.Object3D,
  up: THREE.Vector3,
  fwd: THREE.Vector3,
  step: () => void,
  steps: number,
): Record<'L' | 'R', HandPath> {
  const sides = ['L', 'R'] as const;
  const hands = { L: handVerts(root, 'armL'), R: handVerts(root, 'armR') };
  const shoulders = { L: bone(root, 'armL'), R: bone(root, 'armR') };
  const paths = { L: { up: [], fwd: [], turn: 0 }, R: { up: [], fwd: [], turn: 0 } } as Record<
    'L' | 'R',
    HandPath
  >;
  const last = { L: NaN, R: NaN };
  for (let k = 0; k < steps; k++) {
    step();
    root.updateMatrixWorld(true);
    for (const side of sides) {
      const rel = centroid(hands[side]).sub(shoulders[side].getWorldPosition(_v.clone()));
      const u = rel.dot(up);
      const f = rel.dot(fwd);
      paths[side].up.push(u);
      paths[side].fwd.push(f);
      const a = Math.atan2(f, u);
      if (!Number.isNaN(last[side])) {
        let d = a - last[side];
        if (d > Math.PI) d -= 2 * Math.PI;
        if (d < -Math.PI) d += 2 * Math.PI;
        paths[side].turn += d;
      }
      last[side] = a;
    }
  }
  return paths;
}

/** The crawl, read off one hand's path. */
function expectFrontCrawl(path: HandPath, label: string): void {
  const n = path.up.length;
  const vel = (i: number) => (path.fwd[Math.min(n - 1, i + 1)] - path.fwd[Math.max(0, i - 1)]) / 2;
  let top = 1;
  let bottom = 1;
  for (let i = 1; i < n - 1; i++) {
    if (path.up[i] > path.up[top]) top = i;
    if (path.up[i] < path.up[bottom]) bottom = i;
  }
  // The acceptance itself: forward at the top of the stroke, back at the bottom.
  expect(vel(top), `${label}: forward velocity at the top`).toBeGreaterThan(0);
  expect(vel(bottom), `${label}: forward velocity at the bottom`).toBeLessThan(0);
  // The same over the highest and lowest tenth of the path, so one noisy
  // sample cannot carry the verdict.
  const order = path.up.map((u, i) => ({ u, i })).filter(({ i }) => i > 0 && i < n - 1);
  order.sort((a, b) => b.u - a.u);
  const tenth = Math.max(3, Math.floor(order.length / 10));
  const mean = (xs: Array<{ i: number }>) => xs.reduce((s, x) => s + vel(x.i), 0) / xs.length;
  expect(mean(order.slice(0, tenth)), `${label}: mean forward velocity, top tenth`).toBeGreaterThan(
    0,
  );
  expect(mean(order.slice(-tenth)), `${label}: mean forward velocity, bottom tenth`).toBeLessThan(
    0,
  );
  // A WINDMILL, not a swing: the hand goes all the way round, forward over
  // the top. A bounded oscillation nets ~0 and the reversed crawl goes
  // negative; two seconds of a 6-7 rad/s stroke is about two revolutions.
  expect(path.turn, `${label}: net forward revolution`).toBeGreaterThan(1.8 * Math.PI);
}

describe('the swim stroke is a front crawl, measured on player.glb', () => {
  test('local player: applySwimPose', { timeout: 30000 }, async () => {
    const player = new SimplePlayer();
    const swimmer = player as unknown as LocalSwimmer;
    await vi.waitFor(
      () => {
        if (!swimmer.gltfModel) throw new Error('player.glb not loaded yet');
      },
      { timeout: 20000, interval: 20 },
    );
    const model = swimmer.gltfModel as THREE.Group;
    player.updateMatrixWorld(true);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(
      player.getWorldQuaternion(new THREE.Quaternion()),
    );
    const fwd = faceDirection(model, up);
    // Settle into the prone stroke (the pitch eases in), then follow 2 s.
    const stroke = () => swimmer.applySwimPose(1 / 240, true, 4.4);
    for (let k = 0; k < 480; k++) stroke();
    const paths = followHands(model, up, fwd, stroke, 480);
    // Head first along the measured forward, or "forward" means nothing.
    const lead = bone(model, 'head')
      .getWorldPosition(new THREE.Vector3())
      .sub(bone(model, 'hips').getWorldPosition(new THREE.Vector3()))
      .dot(fwd);
    expect(lead, 'the swimmer leads with the head').toBeGreaterThan(0.2);
    expectFrontCrawl(paths.L, 'local armL');
    expectFrontCrawl(paths.R, 'local armR');
  });

  test('remote peer: the broadcast swim pose', { timeout: 30000 }, async () => {
    const peer = await SimplePlayer.createRemoteAvatar();
    expect(peer, 'createRemoteAvatar').not.toBeNull();
    if (!peer) return;
    const up = new THREE.Vector3(0, 1, 0); // the peer body is the identity frame
    peer.update(1 / 60, 0);
    const fwd = faceDirection(peer.body, up);
    peer.setPose(1); // the swim byte
    peer.setSwimMotion(0, 4.4);
    const stroke = () => peer.update(1 / 240, 4.4);
    for (let k = 0; k < 480; k++) stroke(); // pose weight and pitch ease in
    const paths = followHands(peer.body, up, fwd, stroke, 480);
    const lead = bone(peer.body, 'head')
      .getWorldPosition(new THREE.Vector3())
      .sub(bone(peer.body, 'hips').getWorldPosition(new THREE.Vector3()))
      .dot(fwd);
    expect(lead, 'the peer leads with the head').toBeGreaterThan(0.2);
    expectFrontCrawl(paths.L, 'peer armL');
    expectFrontCrawl(paths.R, 'peer armR');
    peer.dispose();
  });
});
