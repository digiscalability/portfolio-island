// GameScene.ts source locks that lived in other packages' suites (UX plan
// testOwnership, rule 1: a structural lock moves to the owner of the code it
// pins). Each test is a verbatim copy of its original's GameScene assertions;
// the original's owner deletes them in its own stage-1 PR, and until then the
// duplicates simply both pass.
//   - onboarding.test.ts › 'guide sparkles yield to the arrival coins by
//     TARGET, not visibility' (the GameScene half; main-simple's half is A's)
//   - reducedMotion.test.ts › 'the party "calm" path covers the whole room,
//     not just the strobe' (its fixed 6000-character window is now bodyOf)
//   - feelRegressions.test.ts › 'GameScene requests the freeze; it never
//     writes the raw field'
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

// EOL-agnostic, as onboarding.test.ts reads it; no assertion here spans a line.
const src = (f: string): string =>
  readFileSync(join(process.cwd(), f), 'utf8').replace(/\r\n/g, '\n');
const stripped = (f: string): string =>
  src(f)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');

/**
 * The brace-balanced block a marker belongs to (same rule as
 * visualPolish.test.ts): a declaration runs from the marker to the brace that
 * closes the block it opens; a statement takes its whole enclosing block.
 */
const bodyOf = (s: string, marker: string): string => {
  const at = s.indexOf(marker);
  expect(at, `${marker} not found`).toBeGreaterThan(-1);
  const brace = s.indexOf('{', at);
  const semi = s.indexOf(';', at);
  if (brace > -1 && (semi === -1 || brace < semi)) {
    let depth = 0;
    for (let i = brace; i < s.length; i++) {
      if (s[i] === '{') depth++;
      else if (s[i] === '}' && --depth === 0) return s.slice(at, i + 1);
    }
    return s.slice(at);
  }
  let open = 0;
  for (let i = at - 1, depth = 0; i >= 0; i--) {
    if (s[i] === '}') depth++;
    else if (s[i] === '{' && depth-- === 0) {
      open = i;
      break;
    }
  }
  for (let i = at, depth = 0; i < s.length; i++) {
    if (s[i] === '{') depth++;
    else if (s[i] === '}' && depth-- === 0) return s.slice(open, i + 1);
  }
  return s.slice(open);
};

describe('one golden breadcrumb system at a time', () => {
  test('guide sparkles yield to the arrival coins by TARGET, not visibility', () => {
    // Target-based (null) suppression keeps reduced-motion users their
    // breadcrumbs by design; a visibility hack would strip them.
    const g = stripped('GameScene.ts');
    expect(g).toContain('public hasTrailCoins()');
  });
});

describe('load-bearing gates exist at their call sites', () => {
  test('the party "calm" path covers the whole room, not just the strobe', () => {
    // ballLight, confetti, tiles, spot sweep and the spinner guest all read
    // `calm` now; the original gate covered only the beat flash + lasers.
    const party = bodyOf(src('GameScene.ts'), 'private updateInteriorParty');
    expect((party.match(/\bcalm\b/g) ?? []).length).toBeGreaterThanOrEqual(10);
  });
});

describe('shadowMap.autoUpdate has exactly one owner', () => {
  test('GameScene requests the freeze; it never writes the raw field', () => {
    // Comments stripped: the prose explaining WHY GameScene must not touch the
    // field necessarily names the field.
    const g = src('GameScene.ts')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    expect(g).not.toContain('shadowMap.autoUpdate');
    expect(g).not.toContain('shadowAutoUpdateWas');
    expect(g).toContain('setShadowFreeze?.(true)');
    expect(g).toContain('setShadowFreeze?.(false)');
  });
});
