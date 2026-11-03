// SimpleRenderer.ts source locks that used to live in visualPolish.test.ts.
//
// The lock-relocation rule (testOwnership rule 1) moves every structural lock
// to the package that owns the code it pins, so a package's stage-2 edits never
// have to touch another package's test. These four are the SimpleRenderer.ts
// halves of visualPolish tests 572, 774, 846 and 903 on main 58c8849. Their
// test names and expect() arguments are byte-identical to the originals; the
// main-simple.ts halves of 572 and 774 stay with main-simple.ts's owner.
//
// Same reader as visualPolish: CRLF normalised and comments stripped before
// matching, so a lock can never be satisfied by its own explanatory prose.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const src = (f: string): string =>
  readFileSync(join(process.cwd(), f), 'utf8')
    .replace(/\r\n/g, '\n') // a Windows stash pop once flipped these to CRLF
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');

describe('startup and the bloom pass (from visualPolish.test.ts)', () => {
  test('startup: Firebase deferred, postprocessing preloaded, honest measures (round 4)', () => {
    const r = src('SimpleRenderer.ts');
    expect(r).toContain('public static preloadPostProcessing');
    // Idempotent cache + swallowed preload rejection (real errors re-surface
    // at initPostProcessing's await); null on the low tier — never fetched.
    expect(r).toContain('if (SimpleRenderer.isLowTierDevice()) return null');
    expect(r).toMatch(/await \(SimpleRenderer\.preloadPostProcessing\(\) \?\?/);
  });

  test('bloom FADES in at the reveal instead of snapping (no arrival pop)', () => {
    const r = src('SimpleRenderer.ts');
    // Enabling bloom at arrival avoids rim-ghosting during the swoop, but a hard
    // enable is a visible pop right as the reveal settles — "a flicker during
    // the fly-in". Ramp its strength up from 0 instead.
    expect(r).toContain('public fadeBloomIn(');
    expect(r).toContain('bloom.strength = 0;');
    expect(r).toContain('this.bloomTargetStrength = bloomPass.strength;'); // authored value snapshot
  });

  test('desktop drops the unused canvas MSAA buffer (composer does the AA)', () => {
    // On desktop the steady state is composer.render(), whose samples:4 target
    // does the scene AA — so antialias:true only allocated a ~60MB full-canvas
    // MSAA buffer used as the OutputPass blit destination (where MSAA is inert).
    expect(src('SimpleRenderer.ts')).toContain('antialias: SimpleRenderer.isLowTierDevice()');
  });

  test('warmUp compiles the bloom pass, not just the output pass', () => {
    const r = src('SimpleRenderer.ts');
    // warmUp renders a throwaway frame behind the loader to compile the
    // post-processing programs. But main-simple disables bloom for the
    // intro-lite swoop BEFORE warmUp runs, and EffectComposer skips a disabled
    // pass entirely — so bloom's ~8 fullscreen-quad programs never compiled
    // here and cold-compiled ~1.5s into the visible reveal when bloom came
    // back on. warmUp now forces bloom on for the throwaway render and
    // restores the caller's setting. `bloomWas` is unique to this fix (the
    // governor snapshots into bloomSuspendedByGovernor instead).
    expect(r).toContain('const bloomWas = this.bloomPass?.enabled');
    expect(r).toContain('this.bloomPass.enabled = bloomWas');
  });
});
