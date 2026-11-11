// @vitest-environment happy-dom
//
// UI locks: structural locks on SimpleUI.ts that other packages' suites used
// to hold, now owned by package D, the owner of the code (testOwnership rule 1,
// stage-1 item DL), plus pins for Abbas's rulings on the frozen pills.
//
// MOVED IN, by origin test name and its test() line on main 58c8849. The
// origin owners delete their copies in their own stage-1 PRs; until then both
// copies run. The expect arguments are byte-identical; each copy reads the
// source the way its origin did (visualPolish strips comments, the other two
// read the raw file), and the one fixed-width window (inventoryPanel's 3000
// characters) became a bodyOf() slice.
// - visualPolish.test.ts (B), the SimpleUI.ts assertions of:
//   446 'CHIP/CHIP_ICON exist and every column chip spreads them'
//   463 '38px row pitch anchored to the frozen Portfolio/Work-with-me pills'
//   478 'demotions and accent discipline'
//   535 'per-frame HUD writers skip unchanged values (sweep round 2)'
//   721 'chip-recipe regressions from the follow-up review stay fixed'
//   986 'blocked localStorage cannot brick the welcome card'
//   999 'page teardown does not burn the first-run welcome unread'
//   1013 'the contact form cannot strand itself or blame a good email' (its
//        SimpleUI.ts half; the firebaseClient.ts half stays with B, rule 5)
// - feelRegressions.test.ts (E): 517 'the loader blanks its planet graphic
//   before fading (no double planet)'
// - inventoryPanel.test.ts (A): 42 'showInventory drops the previous element
//   first', 88 'values are escaped at the HTML sink'
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';

import { SimpleUI } from '../SimpleUI';

/** visualPolish.test.ts's reader: CRLF folded, comments stripped before
 *  matching, so a lock can never be satisfied by its own explanatory prose. */
const src = (f: string): string =>
  readFileSync(join(process.cwd(), f), 'utf8')
    .replace(/\r\n/g, '\n') // a Windows stash pop once flipped these to CRLF
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');

/** feelRegressions' and inventoryPanel's reader: the file as it is. */
const raw = (f: string): string => readFileSync(join(process.cwd(), f), 'utf8');

const COMMENT = 1;
const LITERAL = 2;
/**
 * Classify every character of TypeScript source as code (0), comment or
 * literal text (string, template text, regex). Just enough of a lexer for
 * source locks: unlike the /\/\/.*$/ strip, it keeps the '//' inside a
 * 'https://…' string, and it never counts a brace inside a string. The '{'
 * and '}' of a template's ${…} are code, so they balance.
 */
const lexMask = (s: string): Uint8Array => {
  const mask = new Uint8Array(s.length);
  const owed: string[] = []; // closers still owed; '`' = inside template text
  let prev = ''; // last code character, to tell a regex from a division
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (owed[owed.length - 1] === '`') {
      mask[i] = LITERAL;
      if (c === '\\') mask[++i] = LITERAL;
      else if (c === '`') owed.pop();
      else if (c === '$' && s[i + 1] === '{') {
        owed.push('}');
        i++; // the '{' stays code
        prev = '{';
      }
      continue;
    }
    if (c === '/' && (s[i + 1] === '/' || s[i + 1] === '*')) {
      const close = s[i + 1] === '/' ? s.indexOf('\n', i) : s.indexOf('*/', i + 2);
      const end = close < 0 ? s.length : s[i + 1] === '/' ? close : close + 2;
      mask.fill(COMMENT, i, end);
      i = end - 1;
      continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < s.length && s[j] !== c && s[j] !== '\n') j += s[j] === '\\' ? 2 : 1;
      mask.fill(LITERAL, i, j + 1);
      i = j;
      prev = c;
      continue;
    }
    if (c === '`') {
      mask[i] = LITERAL;
      owed.push('`');
      continue;
    }
    if (c === '/' && (prev === '' || '(,=:[!&|?{};+-*%<>~^'.includes(prev))) {
      let j = i + 1;
      let inClass = false;
      for (; j < s.length && s[j] !== '\n'; j++) {
        if (s[j] === '\\') j++;
        else if (s[j] === '[') inClass = true;
        else if (s[j] === ']') inClass = false;
        else if (s[j] === '/' && !inClass) break;
      }
      mask.fill(LITERAL, i, j + 1);
      i = j;
      prev = '/';
      continue;
    }
    if (c === '(') owed.push(')');
    else if (c === '[') owed.push(']');
    else if (c === '{') owed.push('}');
    else if (c === ')' || c === ']' || c === '}') owed.pop();
    if (!/\s/.test(c)) prev = c;
  }
  return mask;
};

/** The file's code with every comment blanked out (strings intact). */
const code = (f: string): string => {
  const s = raw(f).replace(/\r\n/g, '\n');
  const mask = lexMask(s);
  let out = '';
  for (let i = 0; i < s.length; i++) out += mask[i] === COMMENT && s[i] !== '\n' ? ' ' : s[i];
  return out;
};

/**
 * One declaration's source, from `marker` to the brace that closes its body:
 * brace-balanced, so the slice follows the code as it grows, where a fixed
 * window cut a method short or ran on into the next one. Braces in strings,
 * comments and parenthesised parameter lists (an object type) do not count. A
 * marker that opens no block of its own (a statement, a call) ends at the brace
 * that closes the block it sits in.
 */
const bodyOf = (source: string, marker: string): string => {
  const start = source.indexOf(marker);
  expect(start, `${marker} not found`).toBeGreaterThan(-1);
  const mask = lexMask(source);
  let depth = 0;
  let statement = false; // a ';' at depth 0 before any block opened
  for (let i = start; i < source.length; i++) {
    if (mask[i] !== 0) continue;
    const c = source[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      depth--;
      if (depth < 0 || (depth === 0 && c === '}' && !statement)) return source.slice(start, i + 1);
    } else if (c === ';' && depth === 0) statement = true;
  }
  return source.slice(start);
};

describe('bodyOf slices what it says', () => {
  const sample = [
    'class A {',
    '  private f(opts: { a: number } = { a: 1 }): void {',
    "    const s = '}'; // a } in a comment",
    '    const t = `${opts.a}}`;',
    '    if (/}/.test(s)) t.trim();',
    '  }',
    '  private g(): void {}',
    '}',
  ].join('\n');

  test('a declaration ends at its own closing brace', () => {
    const f = bodyOf(sample, 'private f(');
    expect(f.endsWith('t.trim();\n  }')).toBe(true);
    expect(f).not.toContain('private g');
  });

  test('a statement ends at the brace that closes its block', () => {
    expect(bodyOf(sample, "const s = '}'").endsWith('t.trim();\n  }')).toBe(true);
  });

  test('code() blanks comments, keeps strings', () => {
    expect(code('Share.ts')).not.toContain('Share — every');
    expect(code('Share.ts')).toContain("'island.digiscalability.com'");
  });
});

describe('moved from visualPolish.test.ts (B): HUD — one chip recipe for the top-right column', () => {
  test('CHIP/CHIP_ICON exist and every column chip spreads them', () => {
    const ui = src('SimpleUI.ts');
    expect(ui).toContain('const CHIP: Partial<CSSStyleDeclaration>');
    expect(ui).toContain('const CHIP_ICON: Partial<CSSStyleDeclaration>');
    // Text chips: online, coin, feed, Say hi, completion.
    expect((ui.match(/\.\.\.CHIP,/g) ?? []).length).toBeGreaterThanOrEqual(5);
    // Icon chips: mute, reduced-motion, customize, emote, photo, inventory.
    expect((ui.match(/\.\.\.CHIP_ICON,/g) ?? []).length).toBeGreaterThanOrEqual(6);
    // The recipe pins the geometry the column drifted on.
    const chipBlock = ui.slice(ui.indexOf('const CHIP:'), ui.indexOf('export class SimpleUI'));
    expect(chipBlock).toContain("height: '30px'");
    expect(chipBlock).toContain("borderRadius: '999px'");
    expect(chipBlock).toContain("borderRadius: '50%'");
    // No fontFamily in the recipes — the overlay's Inter must cascade.
    expect(chipBlock).not.toContain('fontFamily');
  });

  test('38px row pitch anchored to the frozen Portfolio/Work-with-me pills', () => {
    const ui = src('SimpleUI.ts');
    // Frozen anchors (analytics ruling — do not move):
    expect(ui).toContain('+ 126px');
    expect(ui).toContain('+ 164px');
    // The derived rows: online 12, coin/feed 50, icon row 88, Say hi 202,
    // completion 240; icon slots 10/48/86/124/162/200.
    for (const off of ['+ 12px', '+ 50px', '+ 202px', '+ 240px']) {
      expect(ui).toContain(off);
    }
    for (const slot of ['+ 48px', '+ 86px', '+ 124px', '+ 162px', '+ 200px']) {
      expect(ui).toContain(slot);
    }
  });

  test('demotions and accent discipline', () => {
    const ui = src('SimpleUI.ts');
    // Photo is icon-only everywhere now (the P shortcut lives in the title).
    expect(ui).not.toContain("'📸 P'");
    // Reduced-motion active = the indigo accent — green stays reserved for
    // the Work-with-me conversion pill.
    expect(ui).toContain('rgba(91, 108, 255, 0.35)');
    expect(ui).not.toContain('rgba(80, 180, 120, 0.75)');
    // The FPS debug readout anchors bottom-right, off the visitor column.
    const start = ui.indexOf('private createFPSDisplay');
    const fps = ui.slice(start, ui.indexOf('this.playerCountDiv = document.createElement', start));
    expect(fps).toContain('bottom:');
    expect(fps).not.toMatch(/top: 'calc/);
  });

  test('per-frame HUD writers skip unchanged values (sweep round 2)', () => {
    const ui = src('SimpleUI.ts');
    // Interaction prompt: innerHTML parse only when the TEXT changes.
    expect(ui).toContain('if (text === this.lastPromptText && this.interactionDiv) return');
    // Race panel: null-first so on-foot visitors never get the DOM built,
    // and show/hide writes only on the transition.
    const race = ui.slice(ui.indexOf('updateRaceHud(status'));
    expect(race.indexOf('if (!status)')).toBeLessThan(race.indexOf('if (!this.raceDiv)'));
    expect(ui).toContain('this.raceVisible');
    // Breath: dry sessions never build the meter+vignette DOM, and the two
    // vignette gradients are prebuilt constants, not per-frame templates.
    expect(ui).toContain('VIGNETTE_DEEP');
    expect(ui).toContain('VIGNETTE_SHALLOW');
    expect(ui).not.toMatch(/radial-gradient\(circle at 50% 45%[^`]*\$\{edge\}/);
  });

  test('chip-recipe regressions from the follow-up review stay fixed', () => {
    const ui = src('SimpleUI.ts');
    // The feed chip re-shows as FLEX — a block re-show drops the CHIP
    // recipe's centering the first time charges go 0 -> nonzero.
    expect(ui).toContain("this.feedDiv.style.display = 'flex'");
    expect(ui).not.toContain("this.feedDiv.style.display = 'block'");
    // The emote responsive restore is gated by SURFACE first: the short-
    // landscape media query also matches a short DESKTOP window, which
    // parked the desktop emote on the customize slot.
    expect(ui).toContain('this.emoteBtnEl.style.right = this.isTouch');
  });
});

describe('moved from visualPolish.test.ts (B): the welcome card and the contact form', () => {
  test('blocked localStorage cannot brick the welcome card', () => {
    const ui = src('SimpleUI.ts');
    // This was the ONE bare localStorage read left in the file (16 of 17
    // siblings already catch). On iOS Safari with "Block All Cookies" it threw
    // AFTER the card was appended and panels.open() had raised the scrim and
    // hidden the touch controls, but BEFORE innerHTML filled it and before the
    // Escape listener was attached — and welcomeDiv stayed non-null, so
    // isWelcomeVisible() gated out movement, camera, jump and interaction for
    // the entire session. Empty black box, no controls, no Escape.
    expect(ui).toMatch(/let returning = false;\s*try \{\s*returning = localStorage\.getItem/);
    expect(ui).not.toMatch(/const returning = localStorage\.getItem/);
  });

  test('page teardown does not burn the first-run welcome unread', () => {
    const ui = src('SimpleUI.ts');
    // beforeunload -> dispose() -> hideWelcome() persisted ds_welcomed for a
    // visitor who closed the tab with the card still on screen. They returned
    // to the trimmed "Welcome back!" branch and permanently lost the pitch,
    // the recruiter highlights pill, the secondary CTAs and the compass hint.
    // On a portfolio, first-visit bounce is most of the traffic.
    expect(ui).toContain('hideWelcome(persist = true)');
    expect(ui).toContain('if (!persist) return;');
    expect(ui).toContain('this.hideWelcome(false)');
    // The PanelManager sweep IS a dismissal and must still persist; a stray
    // tap on the scrim is not, and must not (D4, FM-06: an outside tap on a
    // phone burned the pitch unread). Changed deliberately in D4 from
    // `close: () => this.hideWelcome(),`.
    expect(ui).toContain("close: (reason) => this.hideWelcome(reason !== 'scrim'),");
  });

  test('the contact form cannot strand itself or blame a good email', () => {
    const ui = src('SimpleUI.ts');
    // submitLead returns false for BOTH a malformed address and any backend
    // failure, and the caller mapped both to "Please check your email
    // address." — sending a recruiter with a valid address into a retype loop.
    expect(ui).toContain("track('lead_failed')");
    expect(ui).toContain('Could not send — try again, or email admin@digiscalability.com.');
    // Boards is lazy-loaded and statically imported nowhere, so a failed chunk
    // fetch used to escape the async handler and leave the site's primary
    // conversion control disabled on "Sending…" forever. Import inside try.
    expect(ui).toMatch(/try \{\s*const \{ submitLead \} = await import\('\.\/Boards'\);/);
    expect(ui).toMatch(/try \{\s*const boards = await import\('\.\/Boards'\);/);
  });
});

describe('moved from feelRegressions.test.ts (E)', () => {
  test('the loader blanks its planet graphic before fading (no double planet)', () => {
    const s = raw('SimpleUI.ts');
    expect(s).toContain("querySelector('#ld-planet')?.remove()");
    expect(s).toContain("querySelector('#ld-orbit')?.remove()");
  });
});

describe('moved from inventoryPanel.test.ts (A): the pack', () => {
  test('showInventory drops the previous element first', () => {
    // PanelManager's same-id re-open replaces the SPEC without firing
    // close() — by design, so the shop can re-render per purchase. That
    // means the old DOM node survives: without this the change-hook
    // re-render appended a second modal over a stale one (measured: the
    // stale copy still read 4 fish after the value moved to 9).
    expect(bodyOf(raw('SimpleUI.ts'), 'showInventory(): void')).toContain('this.packDiv?.remove()');
  });

  test('values are escaped at the HTML sink', () => {
    expect(bodyOf(raw('SimpleUI.ts'), 'showInventory(): void')).toContain('SimpleUI.esc');
  });
});

// D6 (with P2-D3): the message rules frontDoorPolish runs, pinned at the
// source so a refactor cannot route a surface around them.
describe('D6: one message at a time', () => {
  const ui = code('SimpleUI.ts');

  test('a flash is a queued message, not a DOM write of its own', () => {
    const flash = bodyOf(ui, 'flashMessage(text: string): void');
    expect(flash).toContain("this.queued(this.touchifyPlain(text), 'flash', false)");
    expect(flash).toContain('this.enqueue(');
    expect(flash).not.toContain('createElement');
  });

  // Changed deliberately (wave-1 integration): until() drops an outcome too,
  // and so does a message that showed, stepped aside and changed place.
  test('nothing paints over a modal; outcomes go first; stale messages drop', () => {
    const may = bodyOf(ui, 'private mayShow(m: QueuedMessage, shown = false): boolean');
    expect(may.indexOf('this.panels.isModalOpen()')).toBeLessThan(may.indexOf('if (!m.hint)'));
    const take = bodyOf(ui, 'private takeToast(): QueuedMessage | null');
    expect(take).toContain('!q.until?.() && !(q.shows > 0 && q.inside !== inside)');
    expect(take.indexOf('!q.hint && this.mayShow(q)')).toBeLessThan(
      take.indexOf('q.hint && this.mayShow(q)'),
    );
  });

  test('the prompt is announced after the per-frame guard, debounced, never per frame', () => {
    const prompt = bodyOf(ui, 'showInteractionPrompt(text: string): void');
    const guard = prompt.indexOf('if (text === this.lastPromptText && this.interactionDiv) return');
    expect(guard).toBeGreaterThan(-1);
    expect(prompt.indexOf('this.announce(')).toBeGreaterThan(guard);
    expect(prompt).toContain('}, 600);');
  });
});

/** Hue in degrees of '#rrggbb' or 'rgb(r, g, b)'. */
const hue = (colour: string): number => {
  const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(colour);
  const rgb = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(colour);
  const [r, g, b] = (
    hex ? hex.slice(1).map((h) => parseInt(h, 16)) : rgb!.slice(1).map(Number)
  ).map((v) => v / 255);
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  if (d === 0) return 0;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
};
const colours = (css: string): string[] =>
  [...css.matchAll(/#[0-9a-f]{6}\b|rgba?\(\d+,\s*\d+,\s*\d+(?:,\s*[\d.]+)?\)/gi)].map((m) => m[0]);

// Abbas's rulings (2026-11-03), pinned so only a deliberate commit can move them:
// - the Work-with-me pill keeps its slot, label, colour family, destination
//   and analytics; only D20 (needs decision 2) may relabel or retarget it;
// - green is reserved for it; primary actions stay indigo/violet;
// - the Portfolio pill keeps +126px; the reduced-motion 'on' accent stays indigo.
describe("Abbas's rulings: the frozen pills", () => {
  const ui = code('SimpleUI.ts');
  const cta = bodyOf(ui, 'private createContactCTA(): void');
  const click = cta.slice(
    cta.indexOf("btn.addEventListener('click'"),
    cta.indexOf('this.makeHudButtonAccessible'),
  );

  afterEach(() => {
    history.replaceState(null, '', '/');
  });

  test('Work with me keeps its label, its +164px slot, and drawer slot #1', () => {
    expect(cta).toContain("btn.textContent = '💼 Work with me';");
    expect(cta).toContain("top: 'calc(var(--sat, 0px) + 164px)'");
    expect(cta).toContain("right: 'calc(var(--sar, 0px) + 10px)'");
    expect(cta).toContain("this.makeHudButtonAccessible(btn, 'Work with me — open contact');");
    expect(cta).toContain('this.chipHost(btn, { drawer: true, order: 1 });');
  });

  test('Work with me opens Contact and fires cta_pill_click', () => {
    expect(click).toContain("track('cta_pill_click');");
    expect(click).toContain(
      "this.showZonePanel({ id: 'contact', name: 'contact' }, { source: 'cta' });",
    );
  });

  test('the Portfolio pill keeps +126px and toggles the menu', () => {
    const pill = bodyOf(ui, 'private createPortfolioButton(): void');
    expect(pill).toContain("top: 'calc(var(--sat, 0px) + 126px)'");
    expect(pill).toContain('this.togglePortfolioMenu();');
  });

  test('the reduced-motion "on" accent stays indigo', () => {
    const rm = bodyOf(ui, 'private createReducedMotionButton(): void');
    expect(rm).toContain("? 'rgba(91, 108, 255, 0.35)'");
  });

  test('on screen: one data-cta="work-with-me" pill, green at both stops, wired to Contact', () => {
    document.body.innerHTML = '<div id="ui-overlay"></div>';
    window.__analyticsLog = [];
    const app = new SimpleUI('ui-overlay');
    const pills = document.querySelectorAll<HTMLElement>('[data-cta="work-with-me"]');
    expect(pills).toHaveLength(1);
    const pill = pills[0];
    expect(pill.textContent).toBe('💼 Work with me');
    expect(pill.getAttribute('aria-label')).toBe('Work with me — open contact');
    // Its colour family: both gradient stops green, hue 140°-170°. Darkening
    // for contrast (D3) keeps the hue; anything else is a decision-2 change.
    const stops = colours(pill.style.background);
    expect(stops).toHaveLength(2);
    for (const s of stops) {
      expect(hue(s), s).toBeGreaterThanOrEqual(140);
      expect(hue(s), s).toBeLessThanOrEqual(170);
    }
    pill.click();
    expect((window.__analyticsLog ?? []).map((e) => e.name)).toContain('cta_pill_click');
    expect(app.panels.current()).toBe('zone');
    app.hideZonePanel();
  });

  test('on a phone the same element is re-hosted in the drawer, at row 1', () => {
    history.replaceState(null, '', '/?touch=1'); // ?touch selects the phone scheme
    document.body.innerHTML = '<div id="ui-overlay"></div>';
    const app = new SimpleUI('ui-overlay');
    expect(app.isTouchDevice()).toBe(true);
    const pills = document.querySelectorAll<HTMLElement>('[data-cta="work-with-me"]');
    expect(pills).toHaveLength(1);
    const rows = [...pills[0].parentElement!.children] as HTMLElement[];
    expect(rows.length).toBeGreaterThan(1); // the drawer list, not the overlay
    const order = (el: HTMLElement): number => Number(el.style.order || '0');
    expect(rows.filter((r) => r !== pills[0]).every((r) => order(r) > order(pills[0]))).toBe(true);
  });
});
