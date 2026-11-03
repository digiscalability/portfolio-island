// Locks on main-simple.ts, OrbitCamera.ts and SimpleInputManager.ts, gathered
// from the suites that used to hold them (stage-1 lock relocation, AL). Each
// describe names the file the tests came from; the test names and every
// assertion are copied unchanged, with one mechanical change: the fixed
// character windows those suites sliced with (s.slice(i, i + N), and their
// fn(file, marker, span) helpers) are now brace-balanced slices. A window
// silently dropped assertions whenever a commented method grew past N; a
// body slice cannot.
//
// The owners of the original suites delete their copies in their own stage-1
// PRs, so for a while both copies run. Both pass.
//
// The last two describes are not relocated: they hold A's own new locks on
// how main-simple wires the stage-1 fixes, and on the seams the integration
// review found where the stage-1 branches meet.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

// EOL-agnostic: a Windows checkout (core.autocrlf=true) hands these files over
// as CRLF. No assertion below contains a line break.
const src = (f: string): string =>
  readFileSync(join(process.cwd(), f), 'utf8').replace(/\r\n/g, '\n');
const stripped = (f: string): string =>
  src(f)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
/** frontDoorPolish's helper, unchanged: one class member, declaration to the next `\n  }\n`. */
const method = (file: string, marker: string): string => {
  const s = stripped(file);
  const i = s.indexOf(marker);
  expect(i, `${marker} not found in ${file}`).toBeGreaterThan(-1);
  return s.slice(i, s.indexOf('\n  }\n', i));
};

// ---- brace-balanced slicing ---------------------------------------------
// The scanner steps over string, template and regex literals and comments,
// so a brace inside copy text never counts. On comment-stripped source a
// `//` inside a string has already been cut away; quoted strings therefore
// end at a newline as well, which is where such a string now ends.
const REGEX_PREV = new Set([...'(,=:[!&|?{};+-*%<>~^']);
const endOfQuoted = (s: string, j: number): number => {
  for (let k = j + 1; k < s.length; k++) {
    if (s[k] === '\\') k++;
    else if (s[k] === s[j] || s[k] === '\n') return k;
  }
  return s.length;
};
const endOfRegex = (s: string, j: number): number => {
  let inClass = false;
  for (let k = j + 1; k < s.length; k++) {
    const c = s[k];
    if (c === '\\') k++;
    else if (c === '\n') return k;
    else if (inClass) inClass = c !== ']';
    else if (c === '[') inClass = true;
    else if (c === '/') return k;
  }
  return s.length;
};
const regexStartsAt = (s: string, j: number): boolean => {
  let p = j - 1;
  while (p >= 0 && /\s/.test(s[p])) p--;
  if (p < 0 || REGEX_PREV.has(s[p])) return true;
  return /\b(return|typeof|case|in|of|void|delete)$/.test(s.slice(Math.max(0, p - 7), p + 1));
};
/** Where a literal or comment starting at j ends; j itself when s[j] is code. */
const skipNonCode = (s: string, j: number): number => {
  const c = s[j];
  if (c === "'" || c === '"') return endOfQuoted(s, j);
  if (c === '`') return endOfTemplate(s, j);
  if (c !== '/') return j;
  if (s[j + 1] === '/') {
    const n = s.indexOf('\n', j);
    return n === -1 ? s.length : n;
  }
  if (s[j + 1] === '*') {
    const e = s.indexOf('*/', j + 2);
    return e === -1 ? s.length : e + 1;
  }
  return regexStartsAt(s, j) ? endOfRegex(s, j) : j;
};
function endOfTemplate(s: string, j: number): number {
  for (let k = j + 1; k < s.length; k++) {
    if (s[k] === '\\') k++;
    else if (s[k] === '`') return k;
    else if (s[k] === '$' && s[k + 1] === '{') k = matching(s, k + 1, '{', '}');
  }
  return s.length;
}
/** Index of the bracket that closes the one opened at s[open]. */
function matching(s: string, open: number, o: string, c: string): number {
  let depth = 0;
  for (let k = open; k < s.length; k++) {
    if (s[k] === o) depth++;
    else if (s[k] === c) {
      depth--;
      if (depth === 0) return k;
    } else k = skipNonCode(s, k);
  }
  return s.length;
}
const find = (s: string, marker: string, from: number): number => {
  expect(from, 'anchor not found').toBeGreaterThan(-1);
  const i = s.indexOf(marker, from);
  expect(i, `${marker} not found`).toBeGreaterThan(-1);
  return i;
};
/** A declaration (method, function, arrow assignment), marker through the
 *  brace that closes its body: the first `{` outside the parameter list. */
const bodyOf = (s: string, marker: string, from = 0): string => {
  const i = find(s, marker, from);
  let paren = 0;
  for (let k = i; k < s.length; k++) {
    const ch = s[k];
    if (ch === '(' || ch === '[') paren++;
    else if (ch === ')' || ch === ']') paren--;
    else if (ch === '{' && paren === 0) return s.slice(i, matching(s, k, '{', '}') + 1);
    else k = skipNonCode(s, k);
  }
  return s.slice(i);
};
/** A statement or expression that is not a declaration: marker through the
 *  brace that closes the ENCLOSING block. */
const blockOf = (s: string, marker: string, from = 0): string => {
  const i = find(s, marker, from);
  let depth = 0;
  for (let k = i; k < s.length; k++) {
    const ch = s[k];
    if (ch === '{') depth++;
    else if (ch === '}') {
      if (depth === 0) return s.slice(i, k + 1);
      depth--;
    } else k = skipNonCode(s, k);
  }
  return s.slice(i);
};
/** A call that registers a callback: marker through the parenthesis that
 *  closes its argument list (the callback included, nothing after it). */
const argsOf = (s: string, marker: string): string => {
  const i = find(s, marker, 0);
  const open = s.indexOf('(', i);
  return s.slice(i, matching(s, open, '(', ')') + 1);
};

describe('the slicers themselves', () => {
  test('a body ends at its own closing brace, braces in literals ignored', () => {
    const s = [
      'class A {',
      '  private one(x: { a: number }): void {',
      "    const t = `${'{'}{`;",
      "    if (x.a) { log('}'); }",
      '    const r = /[{}]/g;',
      '  }',
      '  private two(): void {}',
      '}',
    ].join('\n');
    expect(bodyOf(s, 'private one').endsWith("log('}'); }\n    const r = /[{}]/g;\n  }")).toBe(
      true,
    );
    expect(blockOf(s, 'if (x.a)')).toContain('const r = /[{}]/g;');
    expect(blockOf(s, 'if (x.a)')).not.toContain('private two');
    expect(argsOf("on(() => { a(')'); });\nnext();", 'on')).toBe("on(() => { a(')'); })");
  });
});

describe('from onboarding.test.ts', () => {
  test('the fish-price special never opens a first visit', () => {
    const s = stripped('main-simple.ts');
    const body = bodyOf(s, 'private refreshFeatured');
    expect(body).toContain("localStorage.getItem('ds_welcomed')");
  });

  test('the arrival trail hands off instead of congratulating into silence', () => {
    expect(src('main-simple.ts')).toContain('follow the ➤ arrow to 🚀 Projects');
  });

  test('fires while APPROACHING an AI villager, at a radius DERIVED from the prompt range', () => {
    const s = stripped('main-simple.ts');
    expect(s).toContain('this.aiVillagerWithin(4 * this.scene.getInteractionRange())');
    // the line says the villager talks through Claude: never a scripted one
    const gate = bodyOf(s, 'private aiVillagerWithin(');
    expect(gate).toContain('isAiNpc(n.name)');
    expect(s).toContain('ds_hint_talk');
    // touch and desktop each get their own verb
    expect(s).toContain('tap USE to ask anything');
    expect(s).toContain('press E to ask anything');
  });

  test('self-discovery burns the hint (chat open sets the key)', () => {
    // Anchor on the AI-chat branch's unique voiceProfileFor call — the plain
    // beginNpcDialogue marker also matches the canned-dialogue branch.
    const s = stripped('main-simple.ts');
    const i = s.indexOf('voiceProfileFor(npcData.name)');
    expect(i).toBeGreaterThan(-1);
    expect(blockOf(s, 'voiceProfileFor(npcData.name)')).toContain(
      "localStorage.setItem('ds_hint_talk', '1')",
    );
  });

  test('guide sparkles yield to the arrival coins by TARGET, not visibility (main-simple half)', () => {
    const s = stripped('main-simple.ts');
    expect(s).toContain('this.scene.hasTrailCoins() ? null : targetPos');
  });

  test('zone POIs carry real passport icons + district accents, not five 🏛️', () => {
    const m = stripped('main-simple.ts');
    const body = bodyOf(m, 'private openIslandMap');
    expect(body).toContain('PASSPORT_META');
    expect(body).toContain('DISTRICTS.find');
    expect(body).not.toMatch(/add\('🏛️', z\.name/);
  });

  test('the island map shows you-are-here, heading, and the pill’s target (main-simple half)', () => {
    const m = stripped('main-simple.ts');
    expect(m).toContain('targetPos: this.lastCompassTarget');
  });

  test('district entries introduce themselves once, after minute one', () => {
    const m = stripped('main-simple.ts');
    expect(m).toContain('ds_hint_district_');
    expect(m).toContain('DISTRICT_INTRO');
    // the minute-one toast budget guard
    expect(m).toMatch(/!this\.scene\.hasTrailCoins\(\)/);
    expect(m).toContain('bestDot > 0.9');
  });

  test('the lost-visitor recovery fires only for the truly lost', () => {
    const m = stripped('main-simple.ts');
    expect(m).toContain('ds_hint_map');
    expect(m).toContain('this.lostAccum > 60');
    expect(m).toContain('!this.ui.hasSeenInteractionPrompt()');
    expect(m).toContain('(this.passport?.count() ?? 0) === 0');
  });

  test('the pill opens the hire card at once; the tour is secondary and ends on it (main-simple half)', () => {
    // ...and the recruiter tour now ends on the hire card, not the contact pitch
    const end = stripped('main-simple.ts');
    const i = end.indexOf('private endTour');
    expect(i).toBeGreaterThan(-1);
    const body = bodyOf(end, 'private endTour');
    expect(body).toContain('this.ui.showHireCard(');
    expect(body).not.toContain("showZonePanel({ id: 'contact'");
    // ?zone=hire deep-links to it (and /z/hire bounces there)
    expect(end).toMatch(/\[[^\]]*'contact', 'hire'\]\.includes\(z\)/);
  });

  test('chatKeydown asks enterOpensChat before it can open the name prompt', () => {
    const m = stripped('main-simple.ts');
    const i = m.indexOf('this.boundHandlers.chatKeydown = (e: KeyboardEvent) => {');
    expect(i).toBeGreaterThan(-1);
    const body = bodyOf(m, 'this.boundHandlers.chatKeydown = (e: KeyboardEvent) => {');
    const guard = body.indexOf('if (!enterOpensChat(e, this.ui)) return;');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(body.indexOf('this.ensureNamed('));
  });

  test('main-simple uses the tested keyGuards predicate, not a private copy (main-simple half)', () => {
    const m = stripped('main-simple.ts');
    expect(m).toContain("import { enterOpensChat } from './keyGuards';");
    expect(m).not.toContain('private enterOpensChat');
  });

  test('ensureNamed remembers "Skip — just browsing" for the session', () => {
    const m = stripped('main-simple.ts');
    const i = m.indexOf('private ensureNamed(then: () => void): void');
    expect(i).toBeGreaterThan(-1);
    const body = bodyOf(m, 'private ensureNamed(then: () => void): void');
    // the remembered skip short-circuits BEFORE the prompt can open...
    const skipped = body.indexOf('if (skipped)');
    expect(skipped).toBeGreaterThan(-1);
    expect(skipped).toBeLessThan(body.indexOf('this.ui.promptName('));
    expect(body).toContain('sessionStorage.getItem(SimpleApp.NAME_SKIP_KEY)');
    // ...and an empty name from the prompt (the Skip button) records it
    expect(body).toMatch(/\} else \{\s*this\.nameSkipped = true;/);
    expect(body).toContain("sessionStorage.setItem(SimpleApp.NAME_SKIP_KEY, '1')");
  });
});

describe('from frontDoorPolish.test.ts', () => {
  test('init failure while the quick version is open leaves no dead Back button (main-simple half)', () => {
    // ...and showErrorScreen does call it before it rewrites the card
    const err = method('main-simple.ts', 'private showErrorScreen');
    expect(err.indexOf('this.ui?.closeQuickVersion()')).toBeGreaterThan(-1);
    expect(err.indexOf('this.ui?.closeQuickVersion()')).toBeLessThan(
      err.indexOf('fallback.hidden'),
    );
  });

  test('init failure flags itself for the boot guard before it shows the card', () => {
    // index.html's guard stands down on this flag, so its 60 s watchdog can't
    // rewrite the reason later or send a second boot_fallback.
    const err = method('main-simple.ts', 'private showErrorScreen');
    const flag = err.indexOf('.__lifeIslandBootFailed = true;');
    expect(flag).toBeGreaterThan(-1);
    expect(flag).toBeLessThan(err.indexOf('fallback.hidden = false'));
  });

  test('the coin tip waits for a coin collected after the welcome card', () => {
    const coin = method('main-simple.ts', 'this.scene.setOnCoinCollected(');
    expect(coin).toContain(
      'const welcomePending = !this.introSettled || this.ui.isWelcomeVisible();',
    );
    expect(coin).toMatch(/if \(!welcomePending && !localStorage\.getItem\('ds_hint_earn'\)\)/);
    expect(stripped('main-simple.ts')).toContain('this.introSettled = true;');
  });

  test('captions swap on landing, not at take-off', () => {
    expect(method('main-simple.ts', 'private advanceTourStop')).not.toContain('setTourCaption');
    const land = method('main-simple.ts', 'private landTourStop');
    expect(land).toContain("tour.phase = 'dwell'");
    expect(land).toContain('this.ui.setTourCaption(tour.stops[tour.idx].caption)');
    // both fly branches (reduced motion and the flight) land through it
    const upd = method('main-simple.ts', 'private updateTour');
    expect(upd.split('this.landTourStop()').length - 1).toBe(2);
  });

  test('a villager stop is re-read and held when its leg starts, released after', () => {
    const hold = method('main-simple.ts', 'private holdTourVillager');
    expect(hold).toContain('this.tourVillager(stop.villagers)');
    expect(hold).toContain('this.scene.getNpcPosition(who)');
    expect(hold).toContain('this.frameTourStop(stop, p, this.clearTourBearing(stop, p))');
    expect(hold).toContain('this.scene.setNpcDialogueHold(who)');
    // the camera bearing is chosen for a clear line of sight to the villager
    const bearing = method('main-simple.ts', 'private clearTourBearing');
    expect(bearing).toContain('collisionMeshes');
    expect(bearing).toContain('intersectObjects(blockers, false)');
    const adv = method('main-simple.ts', 'private advanceTourStop');
    expect(adv.indexOf('this.releaseTourVillager()')).toBeGreaterThan(-1);
    expect(adv.indexOf('this.releaseTourVillager()')).toBeLessThan(adv.indexOf('tour.idx += 1'));
    expect(adv).toContain('this.holdTourVillager(tour.stops[tour.idx])');
    expect(method('main-simple.ts', 'private endTour')).toContain('this.releaseTourVillager()');
    // asleep villagers are hidden indoors: only frame one who is up
    expect(method('main-simple.ts', 'private tourVillager')).toContain(
      "this.scene.getNpcActivity(n) !== 'sleep'",
    );
  });

  test('main-simple hides it in the intro-lite block and restores it mid-swoop', () => {
    const m = stripped('main-simple.ts');
    const hide = m.indexOf('setInkVisible(false)');
    const restore = m.indexOf('const restoreIntroQuality');
    expect(hide).toBeGreaterThan(m.indexOf('this.renderer.setShadowFreeze(true)'));
    expect(hide).toBeLessThan(restore);
    expect(bodyOf(m, 'const restoreIntroQuality')).toContain('setInkVisible(true)');
  });

  test('the 1.5 s restore clock starts at the first frame, not before warmUp', () => {
    // warmUp compiles every program synchronously (measured 2.3 s), so a clock
    // started in the intro block ran out before the swoop's first frame and
    // the intro-lite levers (ink included) never engaged.
    const m = stripped('main-simple.ts');
    expect(m).toContain(
      'requestAnimationFrame(() => window.setTimeout(restoreIntroQuality, 1500))',
    );
    expect(m.split('window.setTimeout(restoreIntroQuality, 1500)').length - 1).toBe(1);
  });

  test('the dead cel shadow patch and its load warning are gone (main-simple half)', () => {
    expect(stripped('main-simple.ts')).not.toContain('applyCelShadowPatch');
  });

  test('pageviews obey it too (inject beforeSend)', () => {
    expect(stripped('main-simple.ts')).toContain(
      'beforeSend: (event) => (isOwnerVisit() ? null : event)',
    );
  });

  test('main-simple marks it on the canned branch of the AI chat', () => {
    const m = stripped('main-simple.ts');
    const i = m.indexOf('const res = await askNpc(npcData.name, text);');
    expect(i).toBeGreaterThan(-1);
    const branch = blockOf(m, 'const res = await askNpc(npcData.name, text);');
    expect(branch.indexOf('this.ui.markNpcChatOffline(npcData.name)')).toBeLessThan(
      branch.indexOf('canned[ci++'),
    );
  });

  test('the canvas is named, and HUD chips skip the double-tap delay (main-simple half)', () => {
    const m = stripped('main-simple.ts');
    expect(m).toContain("canvas.setAttribute('role', 'img')");
    expect(m).toMatch(/canvas\.setAttribute\(\s*'aria-label',/);
  });
});

describe('from mobileHud.test.ts', () => {
  test('FEED/EAT are contextual aux controls, not permanent buttons (main-simple half)', () => {
    expect(src('main-simple.ts')).toContain('setAuxActionAvailable');
  });

  test('tour end, postcard release and drown respawn all use the door veil', () => {
    expect(bodyOf(src('main-simple.ts'), 'private endTour')).toContain('fadeThrough');
    const m = src('main-simple.ts');
    // postcard pill release
    expect(argsOf(m, "showTimeOverridePill('📸 Postcard view'")).toContain('fadeThrough');
    // drown respawn: one message, veiled cut
    const drown = argsOf(m, 'setOnDrownRespawn');
    expect(drown).toContain('fadeThrough');
    expect(drown).toContain('pendingDrownFee');
    expect(m).not.toContain('Fished out by the shore patrol');
  });
});

describe('from reducedMotion.test.ts', () => {
  test('the tour is a slideshow under reduced motion (fly cut, dwell hold, exit snap)', () => {
    const tour = bodyOf(src('main-simple.ts'), 'private updateTour');
    // Both the fly branch (hard cut) and the dwell branch (no drift) gate.
    expect(tour.split('a11y.reducedMotion').length).toBeGreaterThanOrEqual(3);
    expect(bodyOf(src('main-simple.ts'), 'private endTour')).toContain('snapCameraToPlayer');
  });

  test('the fly-in primitive early-outs on its own (defence in depth)', () => {
    expect(bodyOf(src('OrbitCamera.ts'), 'public async flyInFromDistant')).toContain(
      'a11y.reducedMotion',
    );
  });

  test('reduced motion still SEATS the camera in the follow view', () => {
    // The swoop is skipped, but flyInFromDistant is ALSO what initialises the
    // camera pose (its own reduced-motion guard snapToPlayer()s). Skipping the
    // whole else-branch left the camera at the distant pre-placement position —
    // MEASURED 243u from the player — so a reduced-motion visitor got a
    // washed-out distant planet that never came in. The branch must snap.
    // Anchored INSIDE the intro block, after `const afterIntro`, so a new
    // earlier `if (a11y.reducedMotion) {` elsewhere cannot capture the lock.
    const s = src('main-simple.ts');
    const branch = blockOf(s, 'if (a11y.reducedMotion) {', s.indexOf('const afterIntro'));
    expect(branch).toContain('this.scene.getOrbitCamera().snapToPlayer()');
    // snap must precede afterIntro so the first governed frame is the follow view.
    expect(branch.indexOf('snapToPlayer()')).toBeLessThan(branch.indexOf('afterIntro()'));
  });
});

describe('from claimsPanels.test.ts', () => {
  test('the AI-agent count is derived from the roster, never typed (main-simple half)', () => {
    expect(src('main-simple.ts')).toContain('Object.keys(AI_NPCS).length');
  });
});

describe('from audioControl.test.ts', () => {
  test('AudioManager.dispose() is actually called on app teardown', () => {
    // It was documented, correct, and DEAD — zero callers. Since the
    // lifecycle hooks landed that also meant leaked visibilitychange/
    // pageshow/pointerdown listeners that could poke a closed context.
    const m = src('main-simple.ts')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    expect(m).toContain('w.audioManager?.dispose?.()');
    expect(m).toContain('w.audioManager = undefined'); // HMR re-boot gets a fresh manager
  });

  test('resumeAudio checks for the manager BEFORE detaching its listeners', () => {
    // The old order — removeEventListener first, look for window.audioManager
    // second — is the whole bug: the manager arrives ~5s after first paint.
    const m = src('main-simple.ts');
    const i = m.indexOf('const resumeAudio = ()');
    expect(i, 'resumeAudio not found').toBeGreaterThan(-1);
    const body = bodyOf(m, 'const resumeAudio = ()');
    const guard = body.indexOf('if (!am) return;');
    const detach = body.indexOf("window.removeEventListener('keydown', resumeAudio)");
    expect(guard, 'the not-booted guard must exist').toBeGreaterThan(-1);
    expect(detach).toBeGreaterThan(-1);
    expect(guard, 'the guard must come BEFORE the detach').toBeLessThan(detach);
  });

  test('creating the manager attempts one sticky-activation resume', () => {
    // Chrome grants sticky activation after any prior gesture, so a resume
    // right after the late boot recovers those sessions without waiting for
    // another tap; WebKit no-ops it and the still-armed listener covers it.
    const m = src('main-simple.ts')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    const i = m.indexOf("new (await import('./AudioManager')).AudioManager()");
    expect(i).toBeGreaterThan(-1);
    expect(blockOf(m, "new (await import('./AudioManager')).AudioManager()")).toContain(
      '.ensureCtx().resume()',
    );
  });
});

describe('from feelRegressions.test.ts', () => {
  test('the intro fly-in does not switch it either', () => {
    // The governor was the RARE path; intro-lite ran on every non-reduced-motion
    // load. Measured back-to-back at fixed camera poses, the old lever stepped
    // +8.0% at the 1500ms restore point (+26.9% settled, +16.6% at the distant
    // start); the bloom pass measures 0.039% worst-case across the same poses.
    const m = src('main-simple.ts');
    expect(m).toContain('this.renderer.setBloomEnabled(false)');
    // Bloom is turned back on at arrival via fadeBloomIn (a strength ramp, not a
    // path switch) — the intro must still re-enable bloom, just without the pop.
    expect(m).toContain('this.renderer.fadeBloomIn(');
    // Exactly one setPostProcessingEnabled call survives in the app, and it
    // turns the composer ON at boot. Nothing may ever turn it off again —
    // that is what makes warmUp compile the bloom/output programs behind the
    // loader instead of mid-swoop.
    const calls = m.match(/this\.renderer\.setPostProcessingEnabled\((true|false)\)/g) ?? [];
    expect(calls).toEqual(['this.renderer.setPostProcessingEnabled(true)']);
  });

  test('the governor is DISARMED until the intro resolves (main-simple half)', () => {
    // ...and main-simple actually arms it where both intro branches converge.
    const m = src('main-simple.ts')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    expect(m).toContain('this.renderer.armGovernor()');
  });

  test('Ctrl+B toggles the bloom PASS and tells the truth about it (main-simple half)', () => {
    const m = src('main-simple.ts')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    expect(m).toContain('this.renderer.toggleBloom()');
    expect(m).not.toContain('togglePostProcessing');
  });

  test('update() no-ops while flyingIn, and flyInFromDistant sets+clears the flag', () => {
    const s = src('OrbitCamera.ts');
    // The guard sits in update() so the follow-camera cannot fight the swoop.
    expect(s).toContain('if (this.flyingIn) return;');
    // The flag is raised for the swoop and lowered when it resolves — a swoop
    // that never lowered it would kill the follow camera for the whole session.
    expect(s).toContain('this.flyingIn = true;');
    expect(s).toContain('this.flyingIn = false;');
    // The guard must be INSIDE update(): between its signature and the body that
    // writes the camera. (A guard anywhere else would not stop the fight.)
    const u = s.indexOf('public update(');
    expect(u).toBeGreaterThan(-1);
    const guardAt = s.indexOf('if (this.flyingIn) return;', u);
    const bodyAt = s.indexOf('this.yawVelocity', u);
    expect(guardAt).toBeGreaterThan(u);
    expect(guardAt).toBeLessThan(bodyAt);
  });

  test('main-simple lowers resolution + freezes shadows for the swoop and restores both', () => {
    const s = src('main-simple.ts');
    expect(s).toContain('this.renderer.setIntroResolution(0.7)');
    expect(s).toContain('this.renderer.setShadowFreeze(true)');
    expect(s).toContain('this.renderer.setIntroResolution(null)');
    expect(s).toContain('this.renderer.setShadowFreeze(false)');
    // Restore is scheduled mid-swoop (under motion) AND repeated on arrival.
    expect(s).toContain('window.setTimeout(restoreIntroQuality, 1500)');
  });

  test('dailySold builds its day key from local Date parts, not toISOString', () => {
    const s = src('main-simple.ts');
    const i = s.indexOf('private dailySold(');
    expect(i).toBeGreaterThan(-1);
    // Strip comments — the method's OWN comment names the UTC trap it avoids.
    const body = bodyOf(s, 'private dailySold(')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    expect(body).toContain('d.getFullYear()');
    expect(body).toContain('d.getDate()');
    // The UTC trap must not come back inside this method's CODE.
    expect(body).not.toContain('toISOString');
  });
});

describe('from oceanDive.test.ts', () => {
  test('Shift only — never Control', () => {
    // The keydown handler never calls preventDefault, so teaching the player
    // to hold Ctrl while pressing WASD means Ctrl+W closes the tab.
    const d = bodyOf(src('SimpleInputManager.ts'), 'getDiveInput');
    expect(d).toContain("isKeyPressed('shift')");
    expect(d).not.toContain("isKeyPressed('control')");
  });
});

// visualPolish reads every file comment-stripped (its src() strips), so these
// read through stripped() too.
describe('from visualPolish.test.ts', () => {
  test('coyote jump: 120ms grace, and SOUND AND PHYSICS share one edge (main-simple half)', () => {
    const main = stripped('main-simple.ts');
    // Sound and physics must agree: the old gate read isOnGround() on the
    // keypress frame and went silent on exactly the crest-jumps coyote saves.
    expect(main).toContain('player.canJump() && !this.prevJumpHeld');
    expect(main).not.toContain('player.isOnGround() && !this.prevJumpHeld');
    // ...and playerJump() must live INSIDE that edge block: outside it, a
    // held Space re-jumped silently on every snap-down landing while the
    // edge-gated sound stayed quiet — physics and audio disagreed per frame.
    const edge = main.slice(main.indexOf('player.canJump() && !this.prevJumpHeld'));
    const block = edge.slice(0, edge.indexOf('}'));
    expect(block).toContain('this.scene.playerJump()');
  });

  test('the boot precompile bakes the permutation frame 1 will use (main-simple half)', () => {
    const main = stripped('main-simple.ts');
    const prime = main.indexOf('primeExteriorLightGate()');
    const compile = main.indexOf('compileAsync(this.scene');
    expect(prime).toBeGreaterThan(-1);
    expect(prime).toBeLessThan(compile);
  });

  test('the camera size filter applies to every root', () => {
    const cam = stripped('OrbitCamera.ts');
    // `&& rootIndex !== 0` exempted every DESCENDANT of the island group, not
    // just the terrain — ~1,600 bounding-sphere tests per frame. Measured
    // after: 555.
    expect(cam).toContain('if (r * Math.max(s.x, s.y, s.z) < MIN_BLOCKING_RADIUS) return;');
    expect(cam).not.toContain('MIN_BLOCKING_RADIUS && rootIndex !== 0');
  });

  test('per-frame hot paths stay allocation-free (sweep round 2) (OrbitCamera half)', () => {
    const cam = stripped('OrbitCamera.ts');
    // End anchor must be CODE — src() strips comments before slicing, so a
    // comment anchor silently extends the slice to the end of the file.
    const camBody = cam.slice(
      cam.indexOf('private updateCameraPosition'),
      cam.indexOf('private readonly focusTarget'),
    );
    expect(camBody).not.toContain('.clone()');
    // Only the two cold-path seeds may allocate (first frame / degenerate).
    expect((camBody.match(/new THREE\./g) ?? []).length).toBeLessThanOrEqual(2);
    expect(cam).toContain('getWorldPositionInto(this._camPlayerPos)');
    expect(cam).toContain('getSurfaceNormalInto(this._camNormal)');
  });

  test('per-frame position reads use the Into variant (sweep round 3) (main-simple half)', () => {
    const main = stripped('main-simple.ts');
    // The audio/compass scratches must be FED by Into, not by copy(clone()).
    expect(main).toContain('getWorldPositionInto(this._listenerPos)');
    expect(main).toContain('getWorldPositionInto(this._qcPlayerPos)');
    expect(main).not.toContain('.copy(player.getWorldPosition())');
  });

  test('startup: Firebase deferred, postprocessing preloaded, honest measures (round 4) (main-simple half)', () => {
    const main = stripped('main-simple.ts');
    // The three boot-window Firebase touches run from idle slots (1.5s max
    // keeps the world beat arriving during the fly-in for buildAwayDelta).
    expect(main).toMatch(/idleDefer\(\s*\(\)\s*=>\s*connectWorldState/);
    expect(main).toMatch(/idleDefer\(\(\)\s*=>\s*\{\s*void subscribeBenches/);
    // The postprocessing fetch starts BEFORE world gen so the RTT overlaps it.
    expect(main).toContain('SimpleRenderer.preloadPostProcessing()');
    expect(main.indexOf('SimpleRenderer.preloadPostProcessing()')).toBeLessThan(
      main.indexOf("performance.mark('boot:worldgen-start')"),
    );
    // Paint yields are visibility-guarded — rAF never fires in a hidden tab.
    expect(main).toContain("document.visibilityState !== 'visible'");
    // world_gen measures through scene-ready (the builder passes after the
    // constructor's first await used to be mis-attributed to scene_ready).
    expect(main).toContain(
      "performance.measure('world_gen', 'boot:worldgen-start', 'boot:scene-ready')",
    );
    expect(main).not.toContain("'boot:worldgen-end'");
  });

  test('music slices keep a time budget when the page never goes idle', () => {
    const main = stripped('main-simple.ts');
    // THE BUG: `deadline.timeRemaining() > 3 || deadline.didTimeout` treated a
    // TIMED-OUT idle callback as unlimited time.
    expect(main).not.toMatch(/timeRemaining\(\) > 3 \|\| deadline\.didTimeout/);
    // The timed-out path falls back to a wall clock instead of surrendering.
    expect(main).toContain('performance.now() - started >= 6');
    expect(main).toContain('deadline.timeRemaining() <= 3');
    // And the clock is read per BLOCK, not per sample.
    expect(main).toContain('if (++sinceCheck >= 4096)');
    // The wall clock is the DEFAULT branch (deadline === undefined included).
    expect(main).toContain('deadline && !deadline.didTimeout');
  });

  test('bloom FADES in at the reveal instead of snapping (no arrival pop) (main-simple half)', () => {
    const m = stripped('main-simple.ts');
    // the intro's arrival callback fades, it no longer hard-enables.
    expect(m).toContain('this.renderer.fadeBloomIn(');
    expect(m).not.toMatch(/\.then\(\(\) => \{[\s\S]{0,200}setBloomEnabled\(true\)/);
  });

  test('bloom turns on at arrival, not mid-swoop (no first-load rim ghosting)', () => {
    const m = stripped('main-simple.ts');
    // The mid-swoop 1500ms timer restores the intro-lite quality levers (grass,
    // resolution, shadows) under camera motion. Bloom is deliberately NOT among
    // them — it waits for the still arrival camera (fadeBloomIn).
    expect(m).toContain('window.setTimeout(restoreIntroQuality, 1500)');
    const restoreBody = bodyOf(m, 'const restoreIntroQuality');
    expect(restoreBody).not.toContain('setBloomEnabled(true)');
    expect(restoreBody).not.toContain('fadeBloomIn');
    // Bloom comes on in the arrival callback (now via fadeBloomIn), AFTER the
    // fly-in — never in the 1500ms mid-swoop timer.
    const fly = m.indexOf('flyInFromDistant');
    expect(fly).toBeGreaterThan(-1);
    expect(m.indexOf('fadeBloomIn(')).toBeGreaterThan(fly);
    expect(m).not.toMatch(/setGrassBudget\(1\);\s*this\.renderer\.setBloomEnabled\(true\)/);
  });

  test('the interior is built and compiled in idle time, not on the first E (main-simple half)', () => {
    // Off the boot window AND off the interaction: scheduled through the same
    // idle deferral that already carries music and profile sync.
    const main = stripped('main-simple.ts');
    expect(main).toContain('this.idleDefer(() => void this.scene.warmInterior()');
    // CO-A5: on a coarse pointer it may start EARLIER, never on the frame of
    // the first E and never during the fly-in: one task after afterIntro
    // (the card is up), or at the first walk input once the fly-in landed.
    // The 9 s idle deferral above stays the ceiling on every device.
    const early = bodyOf(main, 'private readonly warmRoomsEarly = (): void =>');
    expect(early).toContain('if (this.roomsWarmStarted || !this.coarsePointer) return;');
    expect(early).toContain('void this.scene.warmInterior();');
    expect(main).toContain("matchMedia('(pointer: coarse)').matches");
    expect(bodyOf(main, 'const afterIntro = () =>')).toContain(
      'window.setTimeout(this.warmRoomsEarly, 0);',
    );
    const walk = blockOf(main, '(walkForward !== 0 || walkStrafe !== 0) &&');
    const call = walk.indexOf('this.warmRoomsEarly();');
    expect(walk.indexOf('!this.scene.getOrbitCamera().isFlyingIn()')).toBeGreaterThan(-1);
    expect(walk.indexOf('!this.scene.getOrbitCamera().isFlyingIn()')).toBeLessThan(call);
    expect(call).toBeLessThan(
      walk.indexOf('this.scene.setPlayerMovement(walkForward, walkStrafe);'),
    );
  });
});

// ---- A's own stage-1 wiring ------------------------------------------------
// New locks, not relocated ones. Compass.ts, keyGuards.ts, SimpleInputManager
// and OrbitCamera have unit tests of their own, and the probes do not run in
// CI, so nothing else notices if main-simple stops calling them.
describe('stage-1 wiring in main-simple (A1, A2, A4, A5)', () => {
  const update = (): string => bodyOf(stripped('main-simple.ts'), 'private update(');
  /** One branch of update()'s input chain, by its condition. */
  const branch = (cond: string): string => bodyOf(update(), `} else if (${cond}) {`);
  /** Where the last press a branch acts on is read: applyLook consumes R. */
  const lastPressRead = (body: string): number =>
    Math.max(body.lastIndexOf('consumeKeyPress('), body.lastIndexOf('this.applyLook('));

  test('the update() slice is the whole method', () => {
    // A literal the slicer misread would end it early or run it on; every
    // lock below reads through this slice.
    expect(update()).toMatch(/this\.scene\.update\(deltaTime\);\s*\}$/);
    expect(update()).toContain('if (!this.ui.isWelcomeVisible() && !this.ui.isLoadingVisible()) {');
  });

  test('A1: the compass pill gets compassBearing, not the mirrored atan2', () => {
    const body = bodyOf(stripped('main-simple.ts'), 'private updateQuestCompass');
    expect(body).toContain('const angleRad = compassBearing(camForward, toTarget, normal);');
    expect(body).not.toContain('Math.atan2(cross.dot(normal)');
    // handed over as computed: SimpleUI's rotate(angle − 90°) expects this sign
    expect(body).toMatch(/this\.ui\.updateQuestCompass\(\{\s*angleRad,/);
  });

  test('A2: a non-walkable panel, the welcome card and the loader hold the world', () => {
    expect(branch('worldInputBlocked(this.ui.panels.current())')).toContain(
      'this.holdWorldInput();',
    );
    // the else of `if (!welcome && !loading)`
    expect(update()).toMatch(/\}\s*else\s*\{\s*this\.holdWorldInput\(\);\s*\}/);
    const hold = bodyOf(stripped('main-simple.ts'), 'private holdWorldInput(');
    for (const call of [
      'this.scene.setPlayerMovement(0, 0)',
      'this.scene.setVehicleMove(0, 0)',
      'this.scene.setInteriorMove(0, 0)',
      'this.inputManager.clearLatched()',
      'this.inputManager.getCameraInput()',
      'consumePinchZoomFactor()',
    ]) {
      expect(hold, call).toContain(call);
    }
    // presses during the tour are for the tour
    expect(bodyOf(update(), 'if (this.tour) {')).toContain('this.inputManager.clearLatched();');
  });

  test('A2: indoors, in a conversation, on a bench and at the wheel, an unused press is dropped', () => {
    // P in the car used to take a photo on hop-off, C on a bench opened the
    // editor on standing up, R indoors recentred the camera outside.
    expect(bodyOf(stripped('main-simple.ts'), 'private dropUnusedPresses(')).toContain(
      'this.inputManager.clearLatched();',
    );
    for (const cond of [
      'this.scene.isInsideInterior()',
      'this.ui.isDialogueActive() || this.ui.isNpcChatOpen()',
      'this.scene.isPlayerSeated()',
      'this.scene.isRidingVehicle()',
    ]) {
      const body = branch(cond);
      const drop = body.lastIndexOf('this.dropUnusedPresses();');
      expect(drop, cond).toBeGreaterThan(-1);
      expect(drop, `${cond}: after the last press it acts on`).toBeGreaterThan(lastPressRead(body));
    }
  });

  test('A2: C and P are free-walk verbs, no longer a raw keydown listener', () => {
    const verbs = blockOf(
      update(),
      "if (this.inputManager.consumeKeyPress('m')) this.openIslandMap();",
    );
    expect(verbs).toContain("if (this.inputManager.consumeKeyPress('c')) {");
    expect(verbs).toContain(
      "if (this.inputManager.consumeKeyPress('p')) void this.capturePhoto();",
    );
    const debug = bodyOf(stripped('main-simple.ts'), 'private setupDebugShortcuts(');
    expect(debug).toContain("event.ctrlKey && event.key.toLowerCase() === 'b'");
    expect(debug).not.toContain("=== 'c'");
    expect(debug).not.toContain("=== 'p'");
  });

  test('A4: every follow branch looks through applyLook', () => {
    const look = bodyOf(stripped('main-simple.ts'), 'private applyLook(');
    expect(look).toContain('cam.setInput(look.deltaX, look.deltaY, look.source);');
    expect(look).toContain('if (look.fling !== 0) cam.fling(look.fling);');
    expect(look).toContain("cam.keyLook(held('l') - held('j'), held('i') - held('k'), deltaTime);");
    expect(look).toContain("if (this.inputManager.consumeKeyPress('r')) cam.recentre();");
    for (const cond of [
      'this.ui.isDialogueActive() || this.ui.isNpcChatOpen()',
      'this.scene.isPlayerSeated()',
      'this.scene.isRidingVehicle()',
    ]) {
      expect(branch(cond), cond).toContain('this.applyLook(deltaTime);');
    }
    expect(blockOf(update(), 'this.scene.setPlayerMovement(walkForward, walkStrafe);')).toContain(
      'this.applyLook(deltaTime);',
    );
  });

  test('A5: the chase camera hears the walk and the drive input', () => {
    expect(blockOf(update(), 'this.scene.setPlayerMovement(walkForward, walkStrafe);')).toContain(
      'this.scene.getOrbitCamera().setMoveInput(walkForward, walkStrafe);',
    );
    expect(branch('this.scene.isRidingVehicle()')).toContain(
      'this.scene.getOrbitCamera().setMoveInput(vFwd, vStrafe);',
    );
  });
});

// ---- where the stage-1 branches meet ---------------------------------------
// Seams the integration play review found between A's wiring and the other
// packages. Locks only: the browser runs that found them are not CI.
describe('stage-1 integration seams in main-simple', () => {
  test("the time and postcard pills keep the history entry's state (D2's Back)", () => {
    const main = stripped('main-simple.ts');
    // A null state wiped PanelManager's {dsPanel, dsTok}: the open panel could
    // not step back off its entry, so the first Back stayed on the island and
    // put ?hour= back. Every history write here hands the state on.
    const firstArgs = [...main.matchAll(/history\.(?:replaceState|pushState)\(\s*([^,]*),/g)].map(
      (m) => m[1].trim(),
    );
    expect(firstArgs.length).toBeGreaterThan(0);
    for (const a of firstArgs) expect(a).toBe('history.state');
    expect(bodyOf(main, 'private stripDroppedUrlParams(')).toContain(
      "history.replaceState(history.state, '', ",
    );
    // Both pills hand their param back through the one dropper...
    expect(bodyOf(main, 'private applyHourParam(')).toContain("this.dropUrlParam('hour');");
    expect(bodyOf(main, 'private applyPostcardParam(')).toContain("this.dropUrlParam('pc');");
    // ...which drops it again on every popstate: the step back a closing
    // panel takes lands on the entry under it, and that one still has it.
    const drop = bodyOf(main, 'private dropUrlParam(');
    expect(drop).toContain('this.boundHandlers.popState = () => this.stripDroppedUrlParams();');
    expect(drop).toContain("window.addEventListener('popstate', this.boundHandlers.popState);");
    expect(bodyOf(main, 'private dispose(')).toContain(
      "window.removeEventListener('popstate', this.boundHandlers.popState);",
    );
  });

  test('a held frame is not a stop: holdWorldInput tells the chase camera (A2 × A5)', () => {
    // Behind a panel that is not walkable the world hears no input, and the
    // camera read the silence as a stop: under reduced motion it turned
    // behind the open panel 0.5 s later (orbitCamera.test.ts has the rest).
    expect(bodyOf(stripped('main-simple.ts'), 'private holdWorldInput(')).toContain(
      'this.scene.getOrbitCamera().holdMoveInput();',
    );
  });
});

// ---- stage-2 wiring (wave 1) ---------------------------------------------
// compassArrow.test.ts holds compassTarget's order table; these pin that
// main-simple actually routes the pill through it.
describe('A7: one compass target at a time (the zone branch, replaced)', () => {
  const qc = (): string => bodyOf(stripped('main-simple.ts'), 'private updateQuestCompass(');

  test('the pill picks its source through compassTarget, not a branch chain', () => {
    const body = qc();
    expect(body).toContain('switch (compassTarget(st)) {');
    // The 'after the first stamp, active deliveries take priority' rule is gone.
    expect(body).not.toContain('portfolioFirst');
    expect(body).not.toContain("'📬 Delivery'");
    // Parcels have their own glyph; 📬 means Contact only.
    expect(body).toContain("label = '📦 Parcel';");
    expect(body).toContain('st.deliveryOptIn = this.deliveryOptIn;');
    // The trail villager is named, and only while the coins are down and the
    // trail has not done its job (reached, a stamp, or a pick elsewhere).
    expect(body).toContain('this.trailVillager && !this.trailDone && this.scene.hasTrailCoins()');
    expect(body).toContain("label = this.trailVillager ?? '';");
    expect(body).toContain('if ((passport?.count() ?? 0) > 0) this.trailDone = true;');
    // where the coins lead: the seat, so the pill and the coins never fork;
    // reaching the seat, any conversation or a pick elsewhere ends the trail
    expect(body).toContain('? this.trailSeat(this.trailVillager)');
    expect(body).toContain(
      'if (trailPos && playerPos.distanceTo(trailPos) < SimpleApp.TRAIL_REACHED_U) {',
    );
    for (const m of ['private setMapPick(', 'private beginNpcDialogue(']) {
      expect(bodyOf(stripped('main-simple.ts'), m), m).toContain('this.trailDone = true;');
    }
  });

  test('a district pick ends at its door; anything else at 6 u; then an 8 s hold', () => {
    const body = qc();
    expect(body).toContain(
      'if (zone !== null ? this.doorPromptZone === zone || d < 3.2 : d < 6) {',
    );
    expect(body).toContain('until: now + 8000,');
    expect(body).toContain("label: zone !== null ? enter : '✓ Here',");
    // the door prompt sets the flag where it is shown, and every frame clears it
    expect(stripped('main-simple.ts')).toContain('this.doorPromptZone = String(nearby.zone.id);');
    expect(bodyOf(stripped('main-simple.ts'), 'private update(')).toContain(
      'this.doorPromptZone = null;',
    );
  });

  test('parcels opt in on a collected delivery; stamps 1-3 flash the next district once', () => {
    const m = stripped('main-simple.ts');
    expect(argsOf(m, 'this.deliverySystem.setOnDeliveryComplete(')).toContain(
      'this.deliveryOptIn = true;',
    );
    const body = qc();
    expect(body).toContain('if (stamps <= 3) this.pendingNextFlash = true;');
    expect(body).toContain('`Next: ${next} — the gold arrow points the way.`');
  });

  test('phones end the intro facing the trail villager through setYaw', () => {
    const m = stripped('main-simple.ts');
    const intro = bodyOf(m, 'const afterIntro = () =>');
    // chosen once, at the end of the intro, then faced
    const pick = intro.indexOf('this.trailVillager = this.pickTrailVillager();');
    expect(pick).toBeGreaterThan(-1);
    expect(pick).toBeLessThan(intro.indexOf('this.faceTrailVillager();'));
    expect(m.split('this.trailVillager = ').length - 1).toBe(1);
    const face = bodyOf(m, 'private faceTrailVillager(');
    expect(face).toContain('if (!this.coarsePointer) return;');
    expect(face).toContain('const bearing = compassBearing(fwd.normalize(), to.normalize(), n);');
    expect(face).toContain('cam.setYaw(cam.getYaw() - bearing);');
    // the pick reads positions only: never Math.random (the seeded window)
    expect(bodyOf(m, 'private pickTrailVillager(')).not.toContain('Math.random');
    expect(bodyOf(m, 'private trailSeatVillager(')).toContain('if (d > 0.04 && d < best) {');
  });
});

describe("P2-A5: one 'Show me' seam, window 'ds:guide-to'", () => {
  test('the listener resolves the key and sets the pill exactly as a map pick does', () => {
    const m = stripped('main-simple.ts');
    expect(m).toContain("window.addEventListener('ds:guide-to', this.boundHandlers.guideTo);");
    expect(bodyOf(m, 'private dispose(')).toContain(
      "window.removeEventListener('ds:guide-to', this.boundHandlers.guideTo);",
    );
    const go = bodyOf(m, 'private guideTo(');
    expect(go).toContain('resolveGuideKey(key, this.guideWorld)');
    // an unknown key opens the island map instead
    expect(go).toMatch(/if \(!hit\) \{\s*this\.openIslandMap\(\);\s*return;\s*\}/);
    expect(go).toContain('this.setMapPick(');
    expect(go).toContain('hit.zone');
    expect(go).toContain('this.ui.toast(`🧭 Compass set: ${shown}`);');
    expect(go).toContain("track('map_guide_set', { label: label ?? hit.label, source });");
    // and the map's own picks now say where they came from
    expect(bodyOf(m, 'private openIslandMap(')).toContain(
      "track('map_guide_set', { label: poi.label, source: 'map' });",
    );
  });
});

describe('A6: First steps, wired into main-simple', () => {
  test('one bound tick per frame, behind FxBudget\'s "guide" switch', () => {
    const m = stripped('main-simple.ts');
    expect(m).toContain('private readonly boundGuideTick = (): void => this.guideTick();');
    const update = bodyOf(m, 'private update(');
    expect(update).toContain("if (this.guide && fx.on('guide')) {");
    expect(update).toContain("fx.time('guide', this.boundGuideTick);");
    // never a per-frame closure
    expect(update).not.toMatch(/fx\.time\('guide', \(\)/);
    expect(stripped('Guide.ts')).toContain("fx.register('guide', { desktop: true, low: true });");
  });

  test('Explore arms it in the capture phase, before hideWelcome reads ds_hint_compass', () => {
    const m = stripped('main-simple.ts');
    const setup = bodyOf(m, 'private setupGuide(');
    expect(setup).toContain(
      "this.ui.getOverlay().addEventListener('click', this.boundHandlers.guideWelcomeClick, true);",
    );
    expect(setup).toContain(
      "window.addEventListener('keydown', this.boundHandlers.guideWelcomeKey, true);",
    );
    const exit = bodyOf(m, 'private onWelcomeExit(');
    expect(exit).toContain("if (b.hasAttribute('data-dismiss')) exit = 'explore';");
    expect(exit).toContain("b.dataset.cta === 'projects' || b.dataset.cta === 'contact'");
    expect(bodyOf(m, 'private armGuide(')).toContain(
      "localStorage.setItem('ds_hint_compass', '1');",
    );
    // the legacy check reads ds_welcomed at boot, before Explore writes it
    expect(setup).toContain("welcomed: flag('ds_welcomed'),");
    expect(setup).toContain('talkTarget: () => this.trailVillager,');
  });

  test('the full tour hands over to the guide; a CTA panel arms it when it closes', () => {
    const m = stripped('main-simple.ts');
    const end = bodyOf(m, 'private endTour');
    const arm = end.indexOf("if (!recruiter && this.armGuide('tour')) return;");
    expect(arm).toBeGreaterThan(end.indexOf("this.ui.showHireCard('cta');"));
    expect(arm).toBeLessThan(end.indexOf('The island is yours'));
    const tick = bodyOf(m, 'private guideTick(');
    expect(tick).toContain("this.armGuide('cta');");
    expect(tick).toContain('this.scene.isInsideInterior()');
    expect(tick).toContain('this.tour !== null');
  });

  test('talk, the map and coins reach the guide', () => {
    const m = stripped('main-simple.ts');
    expect(m.split("this.guide?.complete('talk');").length - 1).toBe(2); // quest + AI chat
    expect(bodyOf(m, 'private openIslandMap(')).toContain("this.guide?.complete('compass');");
    expect(argsOf(m, 'this.scene.setOnCoinCollected(')).toContain('this.guide?.coin();');
  });

  test('while it runs, main-simple fires no unprompted hints: talk, coin, lost, district, specials', () => {
    const m = stripped('main-simple.ts');
    const update = bodyOf(m, 'private update(');
    expect(update).toContain('const hintsHeld = this.guideHoldsHints();');
    expect(update).toMatch(
      /!hintsHeld &&\s*!this\.ui\.isWelcomeVisible\(\) &&\s*!this\.tour &&\s*!this\.scene\.hasTrailCoins\(\)/,
    );
    expect(blockOf(update, 'this.lostAccum > 60 &&')).toContain('!hintsHeld &&');
    expect(blockOf(update, "!localStorage.getItem('ds_hint_talk') &&")).toContain('!hintsHeld &&');
    expect(argsOf(m, 'this.scene.setOnCoinCollected(')).toContain(
      'if (this.guideHoldsHints()) return;',
    );
    expect(bodyOf(m, 'private refreshFeatured')).toContain('this.hintLater(');
    expect(bodyOf(m, 'private refreshFeatured')).not.toContain('this.ui.toast(');
    // held hints go out once it lets go
    expect(update).toContain(
      'for (const m of this.heldHints.splice(0)) this.ui.toast(m, { hint: true });',
    );
  });
});
