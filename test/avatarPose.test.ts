// Locks for WORLD LAW 2 — the avatar rigs have NON-IDENTITY rest poses.
//
// On player.glb the limb bones hang at ~±PI (the limb axis is local +Y, so
// rotation.x = 0 points a limb straight UP). Any constant written ABSOLUTELY
// to bone.rotation.x wipes that rest and flips the limb 180 degrees. The swim
// stroke, the swim legs and the wave were each shipped broken this way and
// fixed; the ride and sit poses were written before that pass and kept the
// bug until 2026-08-16.
//
// The tell is always the same: the PROCEDURAL fallback rig has an IDENTITY
// rest, so a constant that is correct there is 180 degrees wrong on the GLB.
// The two branches must therefore NOT share a raw value — the GLB branch
// anchors it as REST + procedural (PI for legs, -PI for arms).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const src = (f: string): string => readFileSync(join(process.cwd(), f), 'utf8');

const fn = (file: string, marker: string, span: number): string => {
  const s = src(file);
  const i = s.indexOf(marker);
  expect(i, `${marker} not found in ${file}`).toBeGreaterThan(-1);
  return s.slice(i, i + span);
};

describe('the ride pose respects the rig rest', () => {
  const ride = (): string => fn('SimplePlayer.ts', 'private applyRidePose', 2600);

  test('GLB limb writes are anchored, never raw', () => {
    // MEASURED before the fix: legL.rotation.x = 0 gave a limb axis of
    // (0, 1, 0) — both legs pointing straight up the torso, every second of
    // every ride. After: PI + legX, i.e. (0, -1, 0), straight down.
    const r = ride();
    expect(r).toMatch(/legLBone\.rotation\.x = Math\.PI \+ legX/);
    expect(r).toMatch(/legRBone\.rotation\.x = Math\.PI \+ legX/);
    expect(r).toMatch(/armLBone\.rotation\.x = -Math\.PI \+ armX/);
    expect(r).toMatch(/armRBone\.rotation\.x = -Math\.PI \+ armX/);
  });

  test('the procedural fallback keeps the RAW value', () => {
    // Its pivots rest at identity, so anchoring it would break it the other
    // way. The two rigs genuinely differ here — same reasoning the swim pose
    // records a few hundred lines below.
    const r = ride();
    expect(r).toMatch(/legPivots\[0\]\.rotation\.x = legX/);
    expect(r).toMatch(/armPivots\[0\]\.rotation\.x = armX/);
  });
});

describe('the REMOTE peer ride pose respects the rig rest', () => {
  // World law 2 has a second clause: "Never lerp from the live rotation.x near
  // +/-PI — three.js reports +3.13 one frame and -3.13 the next." The peer ride
  // pose broke BOTH clauses at once, and outlived the local fix above because
  // remote peers keep their own copy of every pose.
  //
  // MEASURED on the shipped build, settled: arms (0.12, 0.81, -0.57), legs
  // (0, 0.89, -0.46) — all four limbs UP over the head and BACKWARD, against
  // the local rider's arms (0, -0.88, 0.48) and legs (0, -1, 0). And over a 4s
  // walk cycle the mixer swings armL.rotation.x across -3.115..+3.133, CROSSING
  // +/-PI six times, so the mount arc depended on the frame you mounted: the
  // legs measured (0,-0.82,0.57) -> (0,-0.03,1.00) -> (0,0.76,0.65) ->
  // (0,1.00,0.07) in four frames, sweeping through the torso and over the head.
  const ride = (): string => fn('SimplePlayer.ts', '} else if (activePose === 2) {', 2400);

  test('peer limbs are anchored to the rest, never to a raw constant', () => {
    const r = ride();
    expect(r).toMatch(/armLBone\.rotation\.x = -Math\.PI \+ RIDE_PEER_ARM_X \* poseW/);
    expect(r).toMatch(/armRBone\.rotation\.x = -Math\.PI \+ RIDE_PEER_ARM_X \* poseW/);
    expect(r).toMatch(/legLBone\.rotation\.x = Math\.PI \+ RIDE_PEER_LEG_X \* poseW/);
    expect(r).toMatch(/legRBone\.rotation\.x = Math\.PI \+ RIDE_PEER_LEG_X \* poseW/);
  });

  test('nothing in the peer pose blends FROM a live limb rotation', () => {
    // The whole remote update(), not just the ride branch: swim and airborne
    // are already clean (airborne uses += , a pure delta, which survives the
    // sign flip because the two readings differ by exactly 2*PI).
    const all = fn('SimplePlayer.ts', 'const update = (dt: number, speed: number)', 3400);
    expect(all).not.toMatch(/lerp\(\s*(arm|leg)[LR]Bone\.rotation/);
  });

  test('the peer deltas sit between the local boat and jetski variants', () => {
    // One byte, no vehicle kind — so a single blended attitude serves both.
    const s = src('SimplePlayer.ts');
    expect(s).toMatch(/export const RIDE_PEER_ARM_X = -0\.7;/);
    expect(s).toMatch(/export const RIDE_PEER_LEG_X = -0\.6;/);
    const local = fn('SimplePlayer.ts', 'private applyRidePose', 900);
    expect(local).toMatch(/const legX = jetski \? -1\.15 : 0\.0;/);
    expect(local).toMatch(/const armX = jetski \? -0\.95 : -0\.5;/);
    // -0.7 is inside [-0.95, -0.5] and -0.6 inside [-1.15, 0.0].
    expect(-0.7).toBeGreaterThan(-0.95);
    expect(-0.7).toBeLessThan(-0.5);
    expect(-0.6).toBeGreaterThan(-1.15);
    expect(-0.6).toBeLessThan(0.0);
  });
});

describe('the sit pose respects the rig rest', () => {
  test('seated GLB legs are anchored to PI', () => {
    // Raw -1.35 gave (0, 0.22, -0.98) — thighs up and BACK through the bench.
    // PI - 1.35 gives (0, -0.22, 0.98), forward over the seat edge.
    const s = fn('SimplePlayer.ts', 'private applySitPose', 1600);
    expect(s).toMatch(/legLBone\.rotation\.x = Math\.PI - 1\.35/);
    expect(s).toMatch(/legRBone\.rotation\.x = Math\.PI - 1\.35/);
    // ...and the identity-rest fallback still uses its own raw value.
    expect(s).toMatch(/legPivots\[0\]\.rotation\.x = -1\.45/);
  });

  test('the seat FACING goes through yaw, the one owner of the transform', () => {
    // sitDown used to build a seat basis and write this.quaternion — dead
    // code, because updateWorldMatrix rebuilds the quaternion from the scalar
    // yaw on that same call and on every seated frame, and sitDown never set
    // yaw. You sat facing whichever way you walked up.
    const d = fn('SimplePlayer.ts', 'public sitDown', 1800);
    expect(d).toMatch(/this\.yaw = Math\.atan2/);
    expect(d).not.toMatch(/this\.quaternion\.setFromRotationMatrix/);
  });
});
