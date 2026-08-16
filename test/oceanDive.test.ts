// Locks for the free dive and the mid-water life.
//
// The underwater world was unreachable: going under was ONLY the failure
// state (release swim -> sink -> drown), so kelp, coral, the schools and the
// caustics were all content you could only reach by dying. These pin the
// mechanics that make it reachable and the safety rules that keep it honest.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

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

  test('a diver stops stamping foam on the surface overhead', () => {
    expect(
      fn('GameScene.ts', 'if (this.player.isSwimming() && !this.player.isDiving())', 400),
    ).toContain('spawnRipple');
  });
});
