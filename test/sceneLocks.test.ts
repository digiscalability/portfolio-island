// @vitest-environment happy-dom
//
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
//   - celInk.test.ts › 'toonify RNG shield' (behavioural: it borrows
//     GameScene's toonify onto a stub; C deletes its copy in C0)
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as THREE from 'three';
import { describe, expect, test, vi } from 'vitest';

import { GameScene } from '../GameScene';

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

describe('the seeded window keeps its own census', () => {
  test('GameScene installs no WorldSeed recorder, so the browser census keeps its own marks', () => {
    // window.__dsSeedDraws and test/golden/seedDraws.json hold GameScene's 8
    // checkpoints; Island's marks (WorldSeed.seedMark) belong to the
    // drawNeutral census, which installs globalThis.__dsSeedMark itself.
    expect(stripped('GameScene.ts')).not.toMatch(/__dsSeedMark\s*=/);
  });
});

describe('toonify RNG shield', () => {
  test('converts materials but consumes ZERO ambient draws', () => {
    // Borrow the real method onto a stub carrying only what it reads
    // (this.island.mesh), the same pattern test/buildPlots.test.ts uses.
    const mesh = new THREE.Group();
    const mats: THREE.MeshStandardMaterial[] = [];
    for (let i = 0; i < 5; i++) {
      const mat = new THREE.MeshStandardMaterial({ color: 0x334455 + i });
      mats.push(mat);
      mesh.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat));
    }
    // A transparent one must be left alone (the shipped rule), and an
    // array-material mesh exercises the map() branch.
    const glass = new THREE.MeshStandardMaterial({ transparent: true });
    mesh.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), glass));
    const multi = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), [mats[0], glass]);
    mesh.add(multi);

    const proto = GameScene.prototype as unknown as Record<string, () => void>;
    // The shield delegates to the inner method, so the stub carries it too
    // (same borrowing pattern as test/buildPlots.test.ts).
    const stub = {
      island: { mesh },
      toonifyIslandMaterialsShielded: proto['toonifyIslandMaterialsShielded'],
    } as unknown as GameScene;
    const toonify = proto['toonifyIslandMaterials'].bind(stub);

    const spy = vi.spyOn(Math, 'random');
    spy.mockClear();
    toonify();
    const ambient = spy.mock.calls.length;
    spy.mockRestore();

    let toonCount = 0;
    let stillTransparent = 0;
    mesh.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      const list = Array.isArray(m.material) ? m.material : [m.material];
      for (const mat of list) {
        if ((mat as THREE.MeshToonMaterial).isMeshToonMaterial) toonCount++;
        if ((mat as THREE.Material).transparent) stillTransparent++;
      }
    });
    expect(toonCount).toBeGreaterThan(0); // it really converted…
    expect(stillTransparent).toBeGreaterThan(0); // …and spared the glass
    expect(ambient).toBe(0); // …and the shared stream paid nothing
  });
});
