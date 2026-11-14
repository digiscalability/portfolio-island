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

  test('narrow screens keep the destination icon AND a short name, never a bare distance (D16)', () => {
    const s = stripped('SimpleUI.ts');
    expect(s).toContain('compassShortLabel(state.label, w < 340)');
    expect(s).toMatch(/w < 480\s*\?/);
    expect(s).not.toMatch(/\?\s*`\$\{Math\.round\(state\.distance\)\}m`/);
  });

  test('the short name: icon plus first word up to 9 characters; icon-only under 340 px', async () => {
    const { compassShortLabel: short } = await import('../SimpleUI');
    expect(short('🏛️ Professional district')).toBe('🏛️ Professio');
    expect(short('🤖 The Storyteller')).toBe('🤖 Storytell'); // article skipped, cut at 9
    expect(short('📦 Parcel')).toBe('📦 Parcel');
    expect(short('🏁 Ring 3/7')).toBe('🏁 Ring 3/7'); // P2-A8's counter stays whole
    expect(short('Ring 3/7')).toBe('Ring 3/7');
    expect(short('🏁 Finish line')).toBe('🏁 Finish');
    expect(short('🏛️ Professional district', true)).toBe('🏛️');
    expect(short('Finish line', true)).toBe('Finish'); // no icon: the name stays
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
});

// The main-simple.ts locks of this suite (the fish-price special, the trail
// hand-off, the AI-villager hint, the breadcrumb yield, the map POIs, the
// district intros, the lost-visitor recovery, the tour's end and Enter's
// guards) moved to package A's test/mainLocks.test.ts, and the GameScene.ts
// half of the breadcrumb yield to package B's test/sceneLocks.test.ts
// (testOwnership rule 1). What stays here pins SimpleUI.ts.

describe('phase 2: the map teaches the island’s shape', () => {
  test('the island map shows you-are-here, heading, and the pill’s target', () => {
    const s = stripped('SimpleUI.ts');
    const i = s.indexOf('public showIslandMap');
    const body = s.slice(i, i + 9000);
    expect(body).toContain('opts?.playerPos');
    expect(body).toContain('opts?.targetPos');
    expect(body).toContain('opts.playerFwd'); // heading via ε-projection
  });

  test('edge-clamped districts get rim labels on the radar', () => {
    // RADAR_RANGE (1.35 rad) < district spacing (1.57 rad) means neighbours
    // are ALWAYS edge-clamped — they were anonymous coloured dots.
    const s = stripped('SimpleUI.ts');
    expect(s).toContain('labelBoxes');
    // overlap-skip (D16): a label whose box hits one already drawn is dropped
    expect(s).toMatch(/labelBoxes\.some\(/);
    expect(s).toMatch(/if \(!collides\(nx, ny, w, h\)\)/);
  });

  test('every word on the radar, the ONLINE caption included, is 10.5 px or more on screen (D16)', () => {
    // phone.cjs measures each fillText of two or more letters: at 9 px the
    // '1 ONLINE' caption read 6.7 px cap height on the 104 px landscape disc.
    // Only the single-letter N/E/S/W ticks may stay smaller.
    const s = stripped('SimpleUI.ts');
    const i = s.indexOf('updateMinimap(data: {');
    const body = s.slice(i, s.indexOf('\n  showShop(', i));
    expect(body).toContain('ONLINE');
    const sizes = [...body.matchAll(/\$\{\(([\d.]+) \* ts\)\.toFixed\(1\)\}px/g)].map((m) => +m[1]);
    const small = sizes.filter((n) => n < 10.5);
    // N at 10 px, E, S and W at 8 px; nothing else.
    expect(small).toEqual([10, 8, 8, 8]);
    const pill = body.slice(body.indexOf('ONLINE'), body.indexOf('ONLINE') + 400);
    expect(pill).toMatch(/ctx\.font = `700 \$\{\(10\.5 \* ts\)\.toFixed\(1\)\}px/);
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
});

describe('the welcome card hierarchy matches the audience', () => {
  const welcome = (): string => {
    const s = src('SimpleUI.ts');
    const i = s.indexOf('showWelcome(awayDelta');
    expect(i).toBeGreaterThan(-1);
    // The whole method, up to the next one: a fixed-length slice bit this
    // suite four times as showWelcome grew.
    const end = s.indexOf('showRecordingIndicator(): void', i);
    expect(end).toBeGreaterThan(i);
    return s.slice(i, end);
  };
  /** The two card templates: the returning branch of the ternary, then the
   *  first-run one. */
  const branches = (w: string): { returningBranch: string; firstRun: string } => {
    const html = w.slice(w.indexOf('this.welcomeDiv.innerHTML = returning'));
    const split = html.indexOf('\n      : `');
    expect(split).toBeGreaterThan(-1);
    return {
      returningBranch: html.slice(0, split),
      firstRun: html.slice(split, html.indexOf('\n    `;', split)),
    };
  };

  test('the Hiring pill sits above the CTAs on BOTH cards, footnote gone', () => {
    const w = welcome();
    const pill = w.indexOf('Hiring? CV, experience and contact');
    const ctas = w.indexOf('data-cta="projects"');
    expect(pill).toBeGreaterThan(-1);
    expect(ctas).toBeGreaterThan(-1);
    // The old 12px footnote was an underlined link: the Hiring control is a
    // button. (D8's Controls strip is the card's one text link.)
    const hiring = w.slice(w.indexOf('const recruiterPill'), w.indexOf('const outline'));
    expect(hiring).toContain('<button data-recruit');
    expect(hiring).not.toContain('text-decoration');
    expect(w.split('text-decoration:underline')).toHaveLength(2); // the strip, once
    // template order: recruiterPill is rendered above ctaRow in the first-run
    // branch AND (since the returning card carries it too) the returning one
    const { returningBranch, firstRun } = branches(w);
    for (const [name, branch] of [
      ['returning', returningBranch],
      ['first-run', firstRun],
    ]) {
      expect(branch, name).toContain('${recruiterPill}');
      expect(branch.indexOf('${recruiterPill}'), name).toBeLessThan(branch.indexOf('${ctaRow}'));
    }
  });

  test('the pill opens the hire card at once; the tour is secondary, inside the card', () => {
    // It used to start a 37 s camera tour that ended on a client pitch. (That
    // the tour now ends on the hire card, and ?zone=hire deep-links to it, is
    // main-simple.ts code: package A's mainLocks pins it.)
    const w = welcome();
    const click = w.slice(w.indexOf("querySelector('button[data-recruit]')"));
    expect(click.slice(0, 600)).toContain('this.showHireCard(');
    expect(click.slice(0, 600)).not.toContain('onRecruitTour');
    // the tour button lives INSIDE the hire card
    const ui = src('SimpleUI.ts');
    const card = ui.slice(ui.indexOf('hire: `'), ui.indexOf('hire: `') + 6000);
    expect(card).toContain('data-hire-tour');
    expect(ui).toContain("querySelector('button[data-hire-tour]')");
  });

  test('the recruiter path adds its events and keeps the frozen ones (D5)', () => {
    // Changed deliberately in D5: one new key event and two new values. The
    // welcome card's own contracts below, and cta_pill_click, are unchanged.
    const ui = stripped('SimpleUI.ts');
    expect(ui).toContain("track('hire_chip_click');");
    expect(ui).toContain("track('hire_cta', { cta: 'message' });");
    expect(ui).toContain("track('hire_cta', { cta: 'tour' });");
    expect(ui).toContain("track('cta_pill_click');");
    // P2-D5: the Selected work rows say which project, in hire_cta's one prop
    // (it keeps its src), and 'landmark' joins zone_explored's sources for A.
    expect(ui).toContain("track('hire_cta', { cta: `project_${project}` });");
    // P2-D4: 'npc' joins them, for a villager's route button, with npc_route.
    expect(ui).toMatch(
      /source\?: 'proximity' \| 'menu' \| 'deeplink' \| 'cta' \| 'strip' \| 'landmark' \| 'npc';/,
    );
    expect(ui).toContain("track('npc_route', { to: 'hire' });");
    const keyEvents = stripped('Analytics.ts');
    const set = keyEvents.slice(keyEvents.indexOf('const KEY_EVENTS'), keyEvents.indexOf(']);'));
    expect(set).toContain("'hire_chip_click'");
    expect(set).not.toContain("'cta_pill_click'"); // a frozen series: no attribution added
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
    // The dialog itself takes focus (D4, FM-02): a focused 'See the work'
    // made Space or Enter open Projects. The behaviour runs in a11yPanels.
    expect(w).toContain('this.welcomeDiv.tabIndex = -1;');
    expect(w).toContain('this.welcomeDiv.focus();');
    expect(w).not.toContain(
      `querySelector('button[data-cta="projects"]') as HTMLElement | null)?.focus()`,
    );
    // It closed itself after 2.6 s / 7 s; with the Hiring pill on it, that
    // took a returning recruiter's one-click path away. Choice only now.
    expect(w).not.toContain('setTimeout(closeWelcome');
    expect(w).not.toContain('autoClose');
  });

  // Changed deliberately in D9: this was 'the card names the compass pill'.
  test('the guide owns the compass step: the card carries no compass footnote or controls line', () => {
    const w = welcome();
    expect(w).not.toContain('points to your next stop');
    expect(w).not.toContain('controlsLine');
    expect(w).not.toMatch(/WASD to move|Drag the joystick to move/);
    // The one-time compass hint after the card is hideWelcome's, and it
    // stands down the moment First steps arms (frontDoorPolish runs it).
    const s = src('SimpleUI.ts');
    const hide = s.slice(
      s.indexOf('hideWelcome(persist = true)'),
      s.indexOf('isWelcomeVisible(): boolean'),
    );
    expect(hide).toContain('until: () => this.guideArmed() ||');
  });

  test('D9: one filled primary (the Hiring pill), outline CTAs, a neutral Explore', () => {
    const w = welcome();
    const pill = w.slice(w.indexOf('const recruiterPill'), w.indexOf('const outline'));
    expect(pill).toContain('background:${DS.primary}');
    expect(pill).toContain('min-height:46px');
    expect(pill).toContain('font-size:15px; font-weight:700');
    expect(pill).toContain('width:100%');
    const explore = w.slice(w.indexOf('const exploreBtn'), w.indexOf('const chipPad'));
    expect(explore).toContain('data-dismiss="1"');
    expect(explore).not.toContain('DS.primary');
    expect(explore).not.toMatch(/#12b76a|#0e9f6e|#4caf50|ctaWork/i);
  });

  test('D9: Ask the townsfolk, Full tour and Try a race wait behind one disclosure', () => {
    const w = welcome();
    const row = w.slice(w.indexOf('const secondaryRow'), w.indexOf('const WGLYPH'));
    expect(row).toContain('More ways to explore ▾');
    expect(row).toContain('aria-expanded="false"');
    expect(row).toContain('aria-controls="wlc-more"');
    const hidden = row.slice(row.indexOf('id="wlc-more" hidden'));
    for (const attr of ['data-meet-ai', 'data-tour', 'data-race']) {
      expect(hidden, attr).toContain(attr);
    }
  });

  test('D9: the villager line counts from the roster and says nothing of agents', () => {
    const w = welcome();
    expect(w).toContain('${Object.keys(AI_NPCS).length} villagers talk through');
    expect(w).toContain('walk up and ask them anything.');
    expect(w).not.toMatch(/planner agent|analyst agent/);
  });

  test('D9: the card is opaque', () => {
    expect(welcome()).toContain("background: 'rgb(8, 10, 16)'");
  });

  test('the returning card is a hello, not a menu', () => {
    // Trimmed to delta + the Hiring pill + primary CTAs + an explicit Explore
    // (the card closes by choice only). The guided-experience chips stay on
    // the FIRST-RUN card only — a returning visitor already knows they exist.
    const { returningBranch, firstRun } = branches(welcome());
    expect(returningBranch).toContain('${progressHtml}'); // D9: the passport line
    expect(returningBranch).toContain('${awayHtml}');
    expect(returningBranch).toContain('${recruiterPill}');
    expect(returningBranch).toContain('${ctaRow}');
    expect(returningBranch).toContain('${exploreBtn}');
    expect(returningBranch).not.toContain('${secondaryRow}');
    // ...while the first-run branch keeps all three chips (behind its disclosure)
    expect(firstRun).toContain('${secondaryRow}');
  });
});

// REGRESSION (island-share-enter-opens-name-modal): pressing Enter on ANY
// focused button also reached the window-level chat hotkey, so "See the work"
// opened Projects AND the multiplayer name prompt over it, and a second Enter
// published "Visitor". Three independent fixes. The parts that can run do run
// for real: the enterOpensChat predicate in keyGuards.test.ts, a HUD chip's
// Enter (and its pointer-click blur) in hireCard.test.ts. What only exists
// behind the WebGL boot is source-locked: the main-simple.ts half (chatKeydown's
// guard, the keyGuards import, ensureNamed's remembered skip) in package A's
// mainLocks, the SimpleUI.ts half here.
describe('Enter belongs to the focused control, not the chat hotkey', () => {
  test('isPanelOpen covers every PanelManager panel, the portfolio menu included', () => {
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
});
