// Locks for the first-session orientation pass (2026-08-17, 4-lens design
// review + synthesis). The through-line: a fresh visitor should always have
// exactly ONE next thing — coins → villager → ➤ arrow → Projects — and every
// control should say what it is.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

// EOL-agnostic: several locks below anchor on '\n'-joined source, and a
// Windows checkout (core.autocrlf=true) hands them CRLF — they failed there
// while passing in CI. Normalising here changes no assertion.
const src = (f: string): string =>
  readFileSync(join(process.cwd(), f), 'utf8').replace(/\r\n/g, '\n');
const stripped = (f: string): string =>
  src(f)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');

describe('HUD chips explain themselves', () => {
  test('every aria-label doubles as a hover tooltip', () => {
    const s = stripped('SimpleUI.ts');
    const i = s.indexOf('private makeHudButtonAccessible');
    const body = s.slice(i, i + 700);
    expect(body).toContain("el.setAttribute('aria-label', label)");
    expect(body).toContain('if (!el.title) el.title = label;');
  });

  test('the photo chip explains its bare P', () => {
    expect(src('SimpleUI.ts')).toContain('Take a photo of the island (P)');
  });
});

describe('the compass pill is the map’s front door', () => {
  test('tappable, labelled, wired to the EXISTING map seam', () => {
    const s = stripped('SimpleUI.ts');
    const i = s.indexOf('updateQuestCompass(state');
    const body = s.slice(i, i + 3500);
    expect(body).toContain("pointerEvents: 'auto'");
    expect(body).toContain("'Open the island map'");
    expect(body).toContain("track('compass_pill_tap')");
    expect(body).toContain('this.onOpenMap?.()'); // one seam, many callers
    // children stay inert so the pill is ONE hit target
    expect((body.match(/pointerEvents: 'none'/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  test('narrow screens keep the destination ICON, never a bare distance', () => {
    const s = stripped('SimpleUI.ts');
    expect(s).toContain("state.label.split(' ')[0]");
    expect(s).not.toMatch(/compact\s*\?\s*`\$\{Math\.round\(state\.distance\)\}m`/);
  });
});

describe('the first post-welcome moment belongs to orientation', () => {
  test('one first-ever compass toast fires on welcome close', () => {
    const s = stripped('SimpleUI.ts');
    // hideWelcome took a `persist` flag so page teardown stops burning
    // ds_welcomed on an unread card; the anchor follows the signature.
    const i = s.indexOf('hideWelcome(persist');
    expect(i).toBeGreaterThan(-1); // indexOf(-1) would slice the WHOLE file
    const body = s.slice(i, i + 1600);
    expect(body).toContain("!localStorage.getItem('ds_welcomed')"); // first-ever capture
    expect(body).toContain('ds_hint_compass');
    expect(body).toContain('tap it for the island map');
  });

  test('the fish-price special never opens a first visit', () => {
    const s = stripped('main-simple.ts');
    const i = s.indexOf('private refreshFeatured');
    const body = s.slice(i, i + 1200);
    expect(body).toContain("localStorage.getItem('ds_welcomed')");
  });

  test('the arrival trail hands off instead of congratulating into silence', () => {
    expect(src('main-simple.ts')).toContain('follow the ➤ arrow to 🚀 Projects');
  });
});

describe('the AI-villager discovery hint', () => {
  test('fires while APPROACHING an AI villager, at a radius DERIVED from the prompt range', () => {
    const s = stripped('main-simple.ts');
    expect(s).toContain('this.aiVillagerWithin(4 * this.scene.getInteractionRange())');
    // the line says the villager talks through Claude: never a scripted one
    const gate = s.slice(s.indexOf('private aiVillagerWithin('));
    expect(gate.slice(0, 400)).toContain('isAiNpc(n.name)');
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
    expect(s.slice(i, i + 400)).toContain("localStorage.setItem('ds_hint_talk', '1')");
  });
});

describe('one golden breadcrumb system at a time', () => {
  test('guide sparkles yield to the arrival coins by TARGET, not visibility', () => {
    // Target-based (null) suppression keeps reduced-motion users their
    // breadcrumbs by design; a visibility hack would strip them.
    const s = stripped('main-simple.ts');
    expect(s).toContain('this.scene.hasTrailCoins() ? null : targetPos');
    const g = stripped('GameScene.ts');
    expect(g).toContain('public hasTrailCoins()');
  });
});

describe('phase 2: the map teaches the island’s shape', () => {
  test('zone POIs carry real passport icons + district accents, not five 🏛️', () => {
    const m = stripped('main-simple.ts');
    const i = m.indexOf('private openIslandMap');
    const body = m.slice(i, i + 1200);
    expect(body).toContain('PASSPORT_META');
    expect(body).toContain('DISTRICTS.find');
    expect(body).not.toMatch(/add\('🏛️', z\.name/);
  });

  test('the island map shows you-are-here, heading, and the pill’s target', () => {
    const s = stripped('SimpleUI.ts');
    const i = s.indexOf('public showIslandMap');
    const body = s.slice(i, i + 9000);
    expect(body).toContain('opts?.playerPos');
    expect(body).toContain('opts?.targetPos');
    expect(body).toContain('opts.playerFwd'); // heading via ε-projection
    // ...and the caller passes all three
    const m = stripped('main-simple.ts');
    expect(m).toContain('targetPos: this.lastCompassTarget');
  });

  test('edge-clamped districts get rim labels on the radar', () => {
    // RADAR_RANGE (1.35 rad) < district spacing (1.57 rad) means neighbours
    // are ALWAYS edge-clamped — they were anonymous coloured dots.
    const s = stripped('SimpleUI.ts');
    expect(s).toContain('rimLabels');
    expect(s).toMatch(/rimLabels\.some\(/); // overlap-skip
  });

  test('district entries introduce themselves once, after minute one', () => {
    const m = stripped('main-simple.ts');
    expect(m).toContain('ds_hint_district_');
    expect(m).toContain('DISTRICT_INTRO');
    // the minute-one toast budget guard
    expect(m).toMatch(/!this\.scene\.hasTrailCoins\(\)/);
    expect(m).toContain('bestDot > 0.9');
  });
});

describe('phase 2: progression surfaces know about each other', () => {
  test('the completion pill says "explored" on desktop and introduces itself at the first tick', () => {
    const s = stripped('SimpleUI.ts');
    expect(s).toContain('% explored');
    expect(s).toContain('ds_hint_checklist');
    // seeded-baseline guard: a returning visitor's boot value is NOT an increment
    expect(s).toContain('completionSeeded');
    expect(s).toMatch(/seeded && pct > prev/);
  });

  test('the completion modal bridges to the Journal, and the Journal is finally measured', () => {
    const s = stripped('SimpleUI.ts');
    expect(s).toContain('completion-journal');
    const i = s.indexOf('showJournal(): void');
    expect(s.slice(i, i + 300)).toContain("trackOnce('journal_opened')");
  });

  test('the lost-visitor recovery fires only for the truly lost', () => {
    const m = stripped('main-simple.ts');
    expect(m).toContain('ds_hint_map');
    expect(m).toContain('this.lostAccum > 60');
    expect(m).toContain('!this.ui.hasSeenInteractionPrompt()');
    expect(m).toContain('(this.passport?.count() ?? 0) === 0');
  });
});

describe('the welcome card hierarchy matches the audience', () => {
  const welcome = (): string => {
    const s = src('SimpleUI.ts');
    const i = s.indexOf('showWelcome(awayDelta');
    expect(i).toBeGreaterThan(-1);
    // 14000, not 12000: this slice is taken from the RAW source (comments
    // included), so documenting a fix inside showWelcome pushes the tail of
    // the method out of the window and silently drops assertions. Third time
    // this suite has been bitten by a fixed-length slice.
    return s.slice(i, i + 14000);
  };

  test('the Hiring pill sits above the CTAs on BOTH cards, footnote gone', () => {
    const w = welcome();
    const pill = w.indexOf('Hiring? CV, experience and contact');
    const ctas = w.indexOf('data-cta="projects"');
    expect(pill).toBeGreaterThan(-1);
    expect(ctas).toBeGreaterThan(-1);
    expect(w).not.toContain('text-decoration:underline'); // the old 12px footnote
    // template order: recruiterPill is rendered above ctaRow in the first-run
    // branch AND (since the returning card carries it too) the returning one
    const returningBranch = w.slice(w.indexOf('returning\n      ?'), w.indexOf(': `'));
    const firstRun = w.slice(w.indexOf(': `'));
    for (const [name, branch] of [
      ['returning', returningBranch],
      ['first-run', firstRun],
    ]) {
      expect(branch, name).toContain('${recruiterPill}');
      expect(branch.indexOf('${recruiterPill}'), name).toBeLessThan(branch.indexOf('${ctaRow}'));
    }
  });

  test('the pill opens the hire card at once; the tour is secondary and ends on it', () => {
    // It used to start a 37 s camera tour that ended on a client pitch.
    const w = welcome();
    const click = w.slice(w.indexOf("querySelector('button[data-recruit]')"));
    expect(click.slice(0, 600)).toContain('this.showHireCard(');
    expect(click.slice(0, 600)).not.toContain('onRecruitTour');
    // the tour button lives INSIDE the hire card...
    const ui = src('SimpleUI.ts');
    const card = ui.slice(ui.indexOf('hire: `'), ui.indexOf('hire: `') + 6000);
    expect(card).toContain('data-hire-tour');
    expect(ui).toContain("querySelector('button[data-hire-tour]')");
    // ...and the recruiter tour now ends on the hire card, not the contact pitch
    const end = stripped('main-simple.ts');
    const i = end.indexOf('private endTour');
    expect(i).toBeGreaterThan(-1);
    const body = end.slice(i, i + 1600);
    expect(body).toContain('this.ui.showHireCard(');
    expect(body).not.toContain("showZonePanel({ id: 'contact'");
    // ?zone=hire deep-links to it (and /z/hire bounces there)
    expect(end).toMatch(/\[[^\]]*'contact', 'hire'\]\.includes\(z\)/);
  });

  test('all seven analytics contracts survive the restructure', () => {
    const w = welcome();
    for (const attr of [
      'data-cta="projects"',
      'data-cta="contact"',
      'data-meet-ai',
      'data-dismiss',
      'data-tour',
      'data-recruit',
      'data-race',
    ]) {
      expect(w, attr).toContain(attr);
    }
  });

  test('focus moves into the dialog, and the returning card never auto-closes', () => {
    const w = welcome();
    expect(w).toContain('?.focus()');
    // It closed itself after 2.6 s / 7 s; with the Hiring pill on it, that
    // took a returning recruiter's one-click path away. Choice only now.
    expect(w).not.toContain('setTimeout(closeWelcome');
    expect(w).not.toContain('autoClose');
  });

  test('the card names the compass pill', () => {
    expect(welcome()).toContain('points to your next stop');
  });

  test('the returning card is a hello, not a menu', () => {
    // Trimmed to delta + the Hiring pill + primary CTAs + an explicit Explore
    // (the card closes by choice only). The guided-experience chips stay on
    // the FIRST-RUN card only — a returning visitor already knows they exist.
    const w = welcome();
    const returningBranch = w.slice(w.indexOf('returning\n      ?'), w.indexOf(': `'));
    expect(returningBranch).toContain('${awayHtml}');
    expect(returningBranch).toContain('${recruiterPill}');
    expect(returningBranch).toContain('${ctaRow}');
    expect(returningBranch).toContain('${exploreBtn}');
    expect(returningBranch).not.toContain('${secondaryRow}');
    // ...while the first-run branch keeps all three chips
    const firstRun = w.slice(w.indexOf(': `'));
    expect(firstRun).toContain('${secondaryRow}');
  });
});

// REGRESSION (island-share-enter-opens-name-modal): pressing Enter on ANY
// focused button also reached the window-level chat hotkey, so "See the work"
// opened Projects AND the multiplayer name prompt over it, and a second Enter
// published "Visitor". Three independent fixes, each locked here. The parts
// that can run do run for real: the enterOpensChat predicate in
// keyGuards.test.ts, a HUD chip's Enter (and its pointer-click blur) in
// hireCard.test.ts. What only exists behind the WebGL boot is locked here.
describe('Enter belongs to the focused control, not the chat hotkey', () => {
  test('chatKeydown asks enterOpensChat before it can open the name prompt', () => {
    const m = stripped('main-simple.ts');
    const i = m.indexOf('this.boundHandlers.chatKeydown = (e: KeyboardEvent) => {');
    expect(i).toBeGreaterThan(-1);
    const body = m.slice(i, i + 600);
    const guard = body.indexOf('if (!enterOpensChat(e, this.ui)) return;');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(body.indexOf('this.ensureNamed('));
  });

  test('main-simple uses the tested keyGuards predicate, not a private copy', () => {
    const m = stripped('main-simple.ts');
    expect(m).toContain("import { enterOpensChat } from './keyGuards';");
    expect(m).not.toContain('private enterOpensChat');
    // isPanelOpen covers every PanelManager panel, the portfolio menu included
    expect(src('SimpleUI.ts')).toContain('return this.panels.isOpen();');
  });

  test('a HUD chip stops its Enter/Space from propagating', () => {
    const s = stripped('SimpleUI.ts');
    const i = s.indexOf('private makeHudButtonAccessible');
    expect(i).toBeGreaterThan(-1);
    const body = s.slice(i, i + 1400);
    const keyBranch = body.slice(body.indexOf("if (e.key === 'Enter' || e.key === ' ')"));
    expect(keyBranch.slice(0, 200)).toContain('e.stopPropagation();');
  });

  test('ensureNamed remembers "Skip — just browsing" for the session', () => {
    const m = stripped('main-simple.ts');
    const i = m.indexOf('private ensureNamed(then: () => void): void');
    expect(i).toBeGreaterThan(-1);
    const body = m.slice(i, i + 1400);
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
