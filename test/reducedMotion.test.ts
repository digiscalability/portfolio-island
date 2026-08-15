// @vitest-environment happy-dom
//
// Reduced-motion coverage locks.
//
// The gate here is enforced at ~20 bespoke call sites rather than through a
// central tween engine — there is no tween engine; motion in this codebase is
// hand-rolled per-frame math, and "reduced" means a bespoke REPLACEMENT per
// site (a cut instead of a flight, a steady glow instead of a pulse), not a
// scalar an engine could apply. That shape is right for this codebase but it
// regresses silently: the wave-8 audit found the gate present at only 3 of
// GameScene's ceremony sites. These source locks pin the load-bearing gates
// so deleting one fails the build — same mechanism as radiusUnits.test.ts.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import { a11y } from '../Accessibility';

// process.cwd(), not import.meta.url — happy-dom rewrites the latter to the
// page URL (radiusUnits.test.ts uses the same resolution for the same reason).
const src = (f: string): string => readFileSync(join(process.cwd(), f), 'utf8');

/** Slice a function body out of a source file by its declaration marker. */
const fn = (file: string, marker: string, span = 3000): string => {
  const s = src(file);
  const i = s.indexOf(marker);
  expect(i, `${marker} not found in ${file}`).toBeGreaterThan(-1);
  return s.slice(i, i + span);
};

describe('the in-app toggle reaches CSS (root-class contract)', () => {
  test('setReducedMotion mirrors onto <html>, notifies listeners, persists', () => {
    let heard: boolean | null = null;
    a11y.onChange((v) => (heard = v));

    a11y.setReducedMotion(true);
    expect(document.documentElement.classList.contains('reduced-motion')).toBe(true);
    expect(heard).toBe(true);
    expect(localStorage.getItem('ds_reduced_motion')).toBe('1');

    a11y.setReducedMotion(false);
    expect(document.documentElement.classList.contains('reduced-motion')).toBe(false);
    expect(heard).toBe(false);
    expect(localStorage.getItem('ds_reduced_motion')).toBe('0');
  });

  test('style.css carries the html.reduced-motion twin of the media block', () => {
    const css = src('style.css');
    // The @media block can only see the OS preference; the class twin is how
    // the in-app ♿ toggle reaches the same rules. Keep both or neither.
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
    expect(css).toContain('html.reduced-motion *');
  });

  test('the liveness carve-out survives: loaders slow, never freeze', () => {
    const css = src('style.css');
    // During the ~15s synchronous world-gen block ALL JS freezes, including
    // the progress bar's interval — the compositor-driven spinner is the only
    // proof the app is alive. Freezing it recreated a reads-as-a-hang bug.
    expect(css).toContain('#ld-orbit');
    expect(css).toContain('.loading-spinner');
    // And the boot window before the bundle (and style.css) arrives is only
    // coverable from index.html's own inline style block.
    expect(src('index.html')).toContain('prefers-reduced-motion');
  });
});

describe('load-bearing gates exist at their call sites', () => {
  test('the tour is a slideshow under reduced motion (fly cut, dwell hold, exit snap)', () => {
    const tour = fn('main-simple.ts', 'private updateTour');
    // Both the fly branch (hard cut) and the dwell branch (no drift) gate.
    expect(tour.split('a11y.reducedMotion').length).toBeGreaterThanOrEqual(3);
    expect(fn('main-simple.ts', 'private endTour')).toContain('snapCameraToPlayer');
  });

  test('rain calms, and rebuilds live when the toggle flips mid-storm', () => {
    const env = src('EnvironmentCycle.ts');
    expect(env).toContain('a11y.reducedMotion');
    expect(env).toContain('a11y.onChange');
  });

  test('the party "calm" path covers the whole room, not just the strobe', () => {
    // ballLight, confetti, tiles, spot sweep and the spinner guest all read
    // `calm` now; the original gate covered only the beat flash + lasers.
    const party = fn('GameScene.ts', 'private updateInteriorParty', 6000);
    expect((party.match(/\bcalm\b/g) ?? []).length).toBeGreaterThanOrEqual(10);
  });

  test('pending-delivery attention loops hold still (mailbox glow, minimap pulses)', () => {
    expect(src('Mailbox.ts')).toContain('a11y.reducedMotion');
    // Canvas drawing is unreachable by any CSS rule — the gate must live in
    // the draw code itself.
    expect(fn('SimpleUI.ts', 'updateMinimap(', 20000)).toContain('a11y.reducedMotion');
  });

  test('the scripted-dialogue typewriter matches the chat-panel rule', () => {
    expect(fn('SimpleUI.ts', 'private startTypewriter')).toContain('a11y.reducedMotion');
  });

  test('the fly-in primitive early-outs on its own (defence in depth)', () => {
    expect(fn('OrbitCamera.ts', 'flyInFromDistant')).toContain('a11y.reducedMotion');
  });

  test('the dead Island.update() lamp-blink landmine stays deleted', () => {
    // The old method was dead code whose lamp blink (`sin(t*3) > -0.5`
    // visibility toggle) would strobe every lamp in town if revived.
    expect(src('Island.ts')).not.toContain('public update(deltaTime: number)');
  });
});
