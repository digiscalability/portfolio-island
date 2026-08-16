// Locks for the free dive and the mid-water life.
//
// The underwater world was unreachable: going under was ONLY the failure
// state (release swim -> sink -> drown), so kelp, coral, the schools and the
// caustics were all content you could only reach by dying. These pin the
// mechanics that make it reachable and the safety rules that keep it honest.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import { SWIM_DIVE_MAX, SWIM_PRONE, SWIM_TREAD, swimPitchTarget } from '../SimplePlayer';

const src = (f: string): string => readFileSync(join(process.cwd(), f), 'utf8');

const fn = (file: string, marker: string, span = 3500): string => {
  const s = src(file);
  const i = s.indexOf(marker);
  expect(i, `${marker} not found in ${file}`).toBeGreaterThan(-1);
  return s.slice(i, i + span);
};

describe('the dive is reachable and bounded', () => {
  test('the dive branch outranks the float branch', () => {
    // They are independent inputs, so a dive with the swim button also held
    // would otherwise be swallowed by the float arm.
    const w = fn('SimplePlayer.ts', 'private updateWaterState', 5000);
    expect(w.indexOf('if (this.diveIntent)')).toBeGreaterThan(-1);
    expect(w.indexOf('if (this.diveIntent)')).toBeLessThan(
      w.indexOf('} else if (this.swimIntent)'),
    );
  });

  test('the descent uses setLength so the shoreline leash survives', () => {
    // copy(centre).addScaledVector(dir, …) rebuilds the position from the
    // PRE-push direction and erases the current applied moments earlier —
    // the dive would become a barrier bypass out into open ocean.
    const w = fn('SimplePlayer.ts', 'if (this.diveIntent)', 1800);
    expect(w).toContain('setLength(newDist)');
    expect(w).toContain('applyShorelineCurrent');
  });

  test('surfacing is the ONLY way to refill breath', () => {
    // Alternating dive and float holds station at depth; without the surface
    // gate the float arm refills at 0.5/s against a 0.055/s drain, i.e.
    // infinite air, discoverable by mashing two keys.
    const w = fn('SimplePlayer.ts', '} else if (this.swimIntent)', 1600);
    expect(w).toContain('water.surface - 0.15');
    expect(w).toContain('RECOVER_RATE');
  });

  test('oxygen zero still routes to the ONE existing drown', () => {
    const w = fn('SimplePlayer.ts', 'private updateWaterState', 5000);
    // dive arm, float-at-depth arm, and the original sink arm
    expect((w.match(/this\.onDrown\(\)/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });
});

describe('the swimmer points where they are going', () => {
  // The complaint was that a descent "reads as falling". MEASURED on a real
  // dive, the body sat 104-123 degrees away from its direction of travel — it
  // descended broadside-on. These lock the shape of the fix, not its tuning.

  test('level swimming is EXACTLY as it was authored', () => {
    // The surface poses were tuned by eye and must not move: any drift here is
    // a regression in the common case, which is 99% of swimming.
    expect(swimPitchTarget(0, 4.4, true, false)).toBe(SWIM_PRONE);
    expect(swimPitchTarget(0, 0, false, false)).toBe(SWIM_TREAD);
  });

  test('a descent takes the body past horizontal, head-down', () => {
    // PI/2 is exactly horizontal; past it the head leads downward.
    const p = swimPitchTarget(-2.6, 4.4, true, true);
    expect(p).toBeGreaterThan(Math.PI / 2);
    expect(p).toBeLessThanOrEqual(SWIM_DIVE_MAX);
  });

  test('the steepest dive is capped, not a handstand', () => {
    // Straight down with no stroke aligns to PI. The cap is what keeps the
    // avatar inside DIVE_FLOOR_GAP as well as looking like a swimmer.
    expect(swimPitchTarget(-2.6, 0, false, true)).toBeCloseTo(SWIM_DIVE_MAX, 6);
    expect(SWIM_DIVE_MAX).toBeLessThan(Math.PI);
  });

  test('HOLDING at depth stays committed, never stands upright', () => {
    // THE BUG this pass introduced and caught: the pitch is derived from the
    // vertical RATE, and a diver parked on the floor has a rate of zero — so
    // the body eased all the way back to TREAD and stood bolt upright 4u down
    // while the player was still holding the dive key.
    expect(swimPitchTarget(0, 0, false, true)).toBe(SWIM_PRONE);
    expect(swimPitchTarget(0, 0, false, true)).toBeGreaterThan(SWIM_TREAD);
  });

  test('rising brings the head back up', () => {
    expect(swimPitchTarget(3.4, 0, false, false)).toBeLessThan(SWIM_TREAD);
  });

  test('the wave bob does not tilt a floating swimmer', () => {
    // The float easing and the swell both move the radius; without a deadband
    // a swimmer bobbing on the surface would pitch back and forth.
    expect(swimPitchTarget(0.2, 0, false, false)).toBe(SWIM_TREAD);
    expect(swimPitchTarget(-0.2, 4.4, true, false)).toBe(SWIM_PRONE);
  });
});

describe('remote peers see the dive too (world law 2)', () => {
  test('the remote pose shares the LOCAL function, not a copied constant', () => {
    // "Remote peers keep their OWN copies of these poses — fix both or other
    // players stay broken." The remote branch used to hardcode 1.35, which had
    // already drifted from the local pose.
    const s = src('SimplePlayer.ts');
    const remote = s.slice(s.indexOf('activePose === 1'), s.indexOf('activePose === 2'));
    expect(remote).toContain('swimPitchTarget(');
    // Match the ASSIGNMENT, not the number — the comment above the fix
    // legitimately names the old constant, and matching the word made this
    // test fail on its own documentation.
    expect(remote).not.toMatch(/rotation\.x = 1\.35/);
  });

  test('the peer dive is DERIVED from the position stream, not a wire change', () => {
    // A new wire field would need a rules deploy and would break against
    // clients that never update. The radius delta is already on the wire.
    const m = src('Multiplayer.ts');
    expect(m).toContain('setSwimMotion');
    expect(m).toMatch(/swimRadial = \(nextR - prevR\) \/ dt/);
  });
});

describe('the dive key does not fight the browser', () => {
  test('Shift only — never Control', () => {
    // The keydown handler never calls preventDefault, so teaching the player
    // to hold Ctrl while pressing WASD means Ctrl+W closes the tab.
    const d = fn('SimpleInputManager.ts', 'getDiveInput');
    expect(d).toContain("isKeyPressed('shift')");
    expect(d).not.toContain("isKeyPressed('control')");
  });
});

describe('mid-water life is cheap and RNG-safe', () => {
  test('the bait ball is ONE InstancedMesh, not 240 objects', () => {
    const c = fn('GameScene.ts', 'private createMidwaterShielded', 6000);
    expect(c).toContain('InstancedMesh');
    expect(c).toContain('DynamicDrawUsage');
  });

  test('it is built behind a local mulberry32 shield', () => {
    // createMidwater runs INSIDE initialize's seeded window (setupLighting ->
    // createBirds -> createGroundBirds -> here), and three.js mints 4
    // Math.random draws per geometry/material/object. Consuming them from the
    // world stream relocates index-networked vehicles and desyncs multiplayer.
    const c = fn('GameScene.ts', 'private createMidwater()', 900);
    expect(c).toContain('const stashedRandom = Math.random');
    expect(c).toContain('finally');
    expect(c).toContain('Math.random = stashedRandom');
  });

  test('the water ceiling is a separate shell, not a flipped sea material', () => {
    // The sea's alpha is overwritten inside its own shader and the whole
    // material was tuned single-sided; flipping it to DoubleSide is a coin
    // flip on the most regression-prone material in the codebase.
    const c = fn('GameScene.ts', 'private createMidwaterShielded', 6000);
    expect(c).toContain('BackSide');
    expect(c).toContain('depthWrite: false');
    expect(src('Island.ts')).not.toContain('side: THREE.DoubleSide, // sea');
  });

  test('fauna and ceiling show from the first moment of a descent', () => {
    // The chase camera trails ~1.5u ABOVE the swimmer, so submergedF alone
    // leaves the first ~0.8s of a dive in an empty, unfogged ocean.
    expect(fn('GameScene.ts', 'private updateDeepFauna', 1200)).toContain('isDiving()');
  });

  test('geometry merges fail LOUDLY, never as a null cast', () => {
    // mergeGeometries returns null when inputs disagree — most often a mixed
    // INDEX state (Octahedron is non-indexed; Cone/Sphere/Plane/Cylinder are
    // indexed). `as THREE.BufferGeometry` type-checks that null happily, then
    // three.js dies reading `.id` EVERY frame the object is visible. That is
    // a whole-scene freeze that passes a dry playthrough and a typecheck —
    // and it shipped once, in the sprat body+tail merge.
    const s = src('GameScene.ts');
    expect(s).toContain('mergeOrThrow');
    // No un-guarded cast of a merge result anywhere.
    expect(s).not.toMatch(/mergeGeometries\([^)]*\)\s+as\s+THREE\.BufferGeometry/);
  });

  test('the sprat merge has a uniform index state', () => {
    expect(fn('GameScene.ts', 'const sprBody', 900)).toContain('toNonIndexed()');
  });

  test('the manta is one merged mesh, shader-flapped, and un-hulled', () => {
    const m = fn('GameScene.ts', 'private buildManta', 6000);
    expect(m).toContain('mergeOrThrow');
    expect(m).toContain('uFlapT'); // GPU flap, no per-frame geometry work
    expect(m).toContain('DoubleSide'); // or it vanishes when seen from below
    // addGroupHulls DOUBLES geometry and the shell would need the same flap
    // injection, or the ink outline detaches from the wings mid-beat.
    // Match the CALL, not the word — the code comment explaining the choice
    // legitimately names the function.
    expect(m).not.toMatch(/addGroupHulls\s*\(/);
  });

  test('the manta heading comes from the PATH, not a second basis', () => {
    // Two parameterisations of one circle WILL drift apart. The heading used a
    // hand-built `east/north` basis where `north = centre x east` points SOUTH
    // at the equator — harmless only while the position used the same flipped
    // basis. The moment the position moved to true lon/lat the animal swam
    // sideways and backwards (measured nose-vs-velocity: 1.7 -> 92.8 -> 178.4
    // deg round the lap). The heading is now sampled from the circuit itself.
    // 4190 ≈ the whole of updateManta; updateMidwater begins at 4199, so this
    // stays inside the function and cannot match the next one's calls.
    const m = fn('GameScene.ts', 'private updateManta', 4190);
    expect((m.match(/mantaCircuitLonLat\(/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(m).not.toContain('_mantaNorth');
  });

  test('the seabed is sampled under the WINGTIPS, not just the origin', () => {
    // The lowest point of a banked ray is a tip 2.4u out to the side, and the
    // bank never reverses, so an origin-only sample tolerates just 2.1deg of
    // upslope before a wing goes through the reef.
    // 4190 ≈ the whole of updateManta; updateMidwater begins at 4199, so this
    // stays inside the function and cannot match the next one's calls.
    const m = fn('GameScene.ts', 'private updateManta', 4190);
    // THREE samples per frame, but only TWO call sites: the tips share one
    // inside a two-sided loop. Assert the shape, not a call count — counting
    // occurrences was this test's own first bug.
    expect(m).toContain('_mantaTip');
    expect(m).toMatch(/for \(const side of \[-1, 1\]\)/);
    expect(m).toMatch(/floorR = Math\.max\(floorR/);
  });

  test('a diver stops stamping foam on the surface overhead', () => {
    expect(
      fn('GameScene.ts', 'if (this.player.isSwimming() && !this.player.isDiving())', 400),
    ).toContain('spawnRipple');
  });
});
