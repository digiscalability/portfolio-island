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
