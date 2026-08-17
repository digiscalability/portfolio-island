// Locks for the first-session orientation pass (2026-08-17, 4-lens design
// review + synthesis). The through-line: a fresh visitor should always have
// exactly ONE next thing — coins → villager → ➤ arrow → Projects — and every
// control should say what it is.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const src = (f: string): string => readFileSync(join(process.cwd(), f), 'utf8');
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
    const i = s.indexOf('hideWelcome(): void');
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
  test('fires while APPROACHING, at a radius DERIVED from the prompt range', () => {
    const s = stripped('main-simple.ts');
    expect(s).toContain('4 * this.scene.getInteractionRange()');
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
    return s.slice(i, i + 12000);
  };

  test('the recruiter pill is promoted above the CTAs, footnote gone', () => {
    const w = welcome();
    const pill = w.indexOf('Hiring? Watch the 60-second highlights');
    const ctas = w.indexOf('data-cta="projects"');
    expect(pill).toBeGreaterThan(-1);
    expect(w).not.toContain('text-decoration:underline'); // the old 12px footnote
    // template order: recruiterPill is defined before ctaRow AND rendered
    // above it (first-run branch interpolates recruiterPill then ctaRow)
    expect(w.indexOf('${recruiterPill}')).toBeLessThan(w.indexOf('${ctaRow}\n      ${exploreBtn}'));
    expect(pill).toBeGreaterThan(-1);
    expect(ctas).toBeGreaterThan(-1);
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

  test('focus moves into the dialog, and intent cancels the returning auto-close', () => {
    const w = welcome();
    expect(w).toContain('?.focus()');
    expect(w).toContain('clearTimeout(autoClose)');
    expect(w).toContain("addEventListener('pointerenter', cancelAuto");
  });

  test('the card names the compass pill', () => {
    expect(welcome()).toContain('points to your next stop');
  });
});
