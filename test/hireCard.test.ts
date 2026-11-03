// @vitest-environment happy-dom
//
// The recruiter front door, exercised on a REAL SimpleUI in happy-dom (not
// source text): the welcome card's Hiring pill opens the hire card at once,
// the card and the contact panel show the email as selectable text with a
// working Copy button, every identity link is the personal / repo / CV one,
// a HUD chip's Enter never leaks to the window-level chat hotkey, a mouse
// click never leaves a chip holding the next Enter, the portfolio menu (one
// row taller with the hire entry) scrolls inside a short phone screen, and on
// a phone the menu and the panels clear the touch controls while they are up.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { SimpleUI } from '../SimpleUI';

const AVAILABILITY =
  'Open to AI and software engineering roles in Melbourne (full-time or contract).';

let ui: SimpleUI;

beforeEach(() => {
  document.body.innerHTML = '<div id="ui-overlay"></div>';
  try {
    localStorage.clear();
    sessionStorage.clear();
  } catch {
    /* storage unavailable in this environment */
  }
  ui = new SimpleUI('ui-overlay');
});

afterEach(() => {
  ui.hideZonePanel();
  ui.hideWelcome(false);
  vi.restoreAllMocks();
});

const panel = (): HTMLElement => {
  const h = [...document.querySelectorAll<HTMLElement>('#ui-overlay > div')].find((d) =>
    d.querySelector('[data-email], h2'),
  );
  expect(h, 'no zone panel open').toBeTruthy();
  return h as HTMLElement;
};

const text = (el: Element): string => (el.textContent ?? '').replace(/\s+/g, ' ').trim();

describe('the Hiring pill opens the hire card at once', () => {
  test('first-run card: pill click → hire card, synchronously, welcome gone', () => {
    ui.showWelcome(null);
    const pill = document.querySelector<HTMLButtonElement>('button[data-recruit]');
    expect(pill).toBeTruthy();
    expect(text(pill!)).toContain('Hiring? CV, experience and contact');
    pill!.click();
    expect(ui.isWelcomeVisible()).toBe(false);
    const card = panel();
    expect(text(card)).toContain('Abbas Ali');
    expect(text(card)).toContain('AI & software engineer · Melbourne');
    expect(text(card)).toContain(AVAILABILITY);
  });

  test('the returning card carries the pill too, and does not auto-close', () => {
    vi.useFakeTimers();
    try {
      localStorage.setItem('ds_welcomed', '1');
      ui.showWelcome(null);
      expect(document.querySelector('button[data-recruit]')).toBeTruthy();
      vi.advanceTimersByTime(30_000); // the old auto-close fired at 2.6 s / 7 s
      expect(ui.isWelcomeVisible()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the hire card content', () => {
  test('experience, guardrails, CV / LinkedIn / code, email; no phone, no address', () => {
    ui.showHireCard('cta');
    const card = panel();
    const t = text(card);
    for (const line of [
      'Founder & lead developer, DigiScalability, Melbourne',
      'Jan 2025 – present',
      'Software engineer (remote contract), TechNova Solutions',
      'Dec 2023 – Nov 2024',
      'Chef, Mr. Miyagi and Baxter Tavern, Melbourne',
      'Software developer, Event Technologies, Islamabad',
      'Oct 2016 – Sep 2017',
      'Freelance full-stack developer',
      'Aug 2015 – Oct 2017',
    ]) {
      expect(t, line).toContain(line);
    }
    const guardrails = [...card.querySelectorAll('ul')].at(-1)!.querySelectorAll('li');
    expect(guardrails.length).toBeGreaterThanOrEqual(4);
    expect(guardrails.length).toBeLessThanOrEqual(5);
    const hrefs = [...card.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(hrefs).toContain('https://digiscalability.com/about');
    expect(hrefs).toContain('https://www.linkedin.com/in/-abbas-ali');
    expect(hrefs).toContain('https://github.com/digiscalability/portfolio-island');
    expect(t).not.toMatch(
      /(?:\+61\s?|\b0)4\d{2}[\s-]?\d{3}[\s-]?\d{3}\b|\+61[\s-]?\(?\d|Mordialloc|street/i,
    );
    expect(card.querySelector('button[data-hire-tour]')).toBeTruthy();
  });

  test('LinkedIn leads as the one filled button, then CV, then Code', () => {
    // The fact sheet's primary hiring link; hire.html and /about lead with it.
    ui.showHireCard('cta');
    const row = [...panel().querySelectorAll('a')].slice(0, 3);
    expect(row.map((a) => a.getAttribute('href'))).toEqual([
      'https://www.linkedin.com/in/-abbas-ali',
      'https://digiscalability.com/about',
      'https://github.com/digiscalability/portfolio-island',
    ]);
    expect(row.map((a) => text(a))).toEqual(['🔗 LinkedIn', '📄 CV', '💻 Code']);
    const filled = row.map((a) => (a.getAttribute('style') ?? '').includes('linear-gradient'));
    expect(filled).toEqual([true, false, false]);
  });

  test('the email is selectable text with a Copy button that copies it', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    ui.showHireCard('cta');
    const card = panel();
    const email = card.querySelector<HTMLElement>('[data-email]');
    expect(email).toBeTruthy();
    expect(text(email!)).toBe('admin@digiscalability.com');
    expect(email!.closest('a')).toBeNull(); // text, not a link: it can be selected
    expect(email!.getAttribute('style')).toContain('user-select:all');
    const copy = card.querySelector<HTMLButtonElement>('button[data-copy]');
    expect(copy).toBeTruthy();
    copy!.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(writeText).toHaveBeenCalledWith('admin@digiscalability.com');
    expect(text(copy!)).toBe('Copied ✓');
  });

  test('a blocked clipboard selects the address instead of failing silently', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('NotAllowedError'));
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    ui.showHireCard('cta');
    const copy = panel().querySelector<HTMLButtonElement>('button[data-copy]')!;
    copy.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(text(copy)).toBe('Selected — copy it');
    expect(String(window.getSelection())).toContain('admin@digiscalability.com');
  });

  test('every portfolio panel shows the email with a working Copy', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const ids = ['professional', 'projects', 'personal', 'contact', 'hire'];
    for (const id of ids) {
      ui.showZonePanel({ id, name: id }, { source: 'menu' });
      const card = panel();
      expect(text(card.querySelector('[data-email]')!), id).toBe('admin@digiscalability.com');
      card.querySelector<HTMLButtonElement>('button[data-copy]')!.click();
      await Promise.resolve();
      await Promise.resolve();
    }
    expect(writeText).toHaveBeenCalledTimes(ids.length);
  });
});

describe('the contact panel reaches Abbas directly', () => {
  test('header, email + Copy, LinkedIn/GitHub/CV first, socials second, no phone', () => {
    ui.showZonePanel({ id: 'contact', name: 'contact' }, { source: 'menu' });
    const card = panel();
    expect(text(card)).toContain('Hiring, or have a project? This reaches me directly.');
    expect(text(card.querySelector('[data-email]')!)).toBe('admin@digiscalability.com');
    expect(card.querySelector('button[data-copy]')).toBeTruthy();
    // Link ROWS = divs whose direct children include anchors (happy-dom has no
    // :scope, so walk .children). The first row is the hiring row.
    const rowLinks = (d: Element): string[] =>
      [...d.children].filter((c) => c.tagName === 'A').map((a) => a.getAttribute('href') ?? '');
    const rows = [...card.querySelectorAll('div')].map(rowLinks).filter((r) => r.length >= 3);
    expect(rows[0]).toEqual([
      'https://www.linkedin.com/in/-abbas-ali',
      'https://github.com/digiscalability/portfolio-island',
      'https://digiscalability.com/about',
    ]);
    // ...and the socials sit in a second, smaller row after it.
    expect(rows[1]).toEqual([
      'https://x.com/digiscalability',
      'https://instagram.com/digiscalability',
      'https://youtube.com/@DigiScalability',
    ]);
    expect(text(card)).not.toMatch(/(?:\+61\s?|\b0)4\d{2}[\s-]?\d{3}[\s-]?\d{3}\b|\+61[\s-]?\(?\d/);
    expect(text(card)).not.toContain('All channels @digiscalability');
    const placeholder = card.querySelector('#lead-msg')?.getAttribute('placeholder');
    expect(placeholder).toBe('A role, a project, or a question');
  });

  test('the availability line lives on the hire card only', () => {
    for (const id of ['welcome', 'professional', 'projects', 'personal', 'contact']) {
      ui.showZonePanel({ id, name: id }, { source: 'menu' });
      expect(text(panel()), id).not.toContain(AVAILABILITY);
    }
    ui.hideZonePanel();
    ui.showWelcome(null);
    expect(
      text(document.querySelector('[aria-label="Welcome to DigiScalability Life Island"]')!),
    ).not.toContain(AVAILABILITY);
  });
});

const portfolioChip = (): HTMLElement => {
  const chip = [...document.querySelectorAll<HTMLElement>('.hud-btn')].find(
    (el) => el.getAttribute('aria-label') === 'Open portfolio menu',
  );
  expect(chip).toBeTruthy();
  return chip!;
};

describe('a HUD chip owns its Enter', () => {
  test('Enter on the focused Portfolio chip activates it and never reaches window', async () => {
    const chip = portfolioChip();
    const seen: string[] = [];
    const onWindow = (e: KeyboardEvent) => seen.push(e.key);
    window.addEventListener('keydown', onWindow);
    try {
      chip.focus();
      chip.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      expect(seen).toEqual([]);
      expect(ui.isPanelOpen()).toBe(true); // the chip did its own job (menu open)
      // D4: focus moves to the menu's first row (it used to stay on the chip,
      // 9 Tabs from the rows), and Escape brings it back to the chip.
      await Promise.resolve();
      expect(document.activeElement).toBe(document.querySelector('button[data-section]'));
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      expect(ui.isPanelOpen()).toBe(false);
      expect(document.activeElement).toBe(chip); // keyboard users keep their place
    } finally {
      window.removeEventListener('keydown', onWindow);
    }
  });

  test('a pointer click hands focus back, so the next Enter reaches window', () => {
    const chip = portfolioChip();
    const seen: string[] = [];
    const onWindow = (e: KeyboardEvent) => seen.push(e.key);
    window.addEventListener('keydown', onWindow);
    try {
      chip.focus(); // what a mousedown does to a tabindex=0 chip
      chip.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
      expect(ui.isPanelOpen()).toBe(true); // the click still opened the menu
      expect(document.activeElement).not.toBe(chip);
      chip.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 })); // close it
      expect(ui.isPanelOpen()).toBe(false);
      const target = document.activeElement ?? document.body;
      target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      expect(seen).toEqual(['Enter']); // the chat hotkey hears it, not the chip
    } finally {
      window.removeEventListener('keydown', onWindow);
    }
  });
});

describe('the portfolio menu fits a short phone', () => {
  test('it clamps to the viewport and scrolls inside', () => {
    portfolioChip().click();
    const menu = [...document.querySelectorAll<HTMLElement>('#ui-overlay > div')].find(
      (d) => d.style.zIndex === '1600' && d.querySelector('button[data-section="hire"]'),
    );
    expect(menu, 'portfolio menu not open').toBeTruthy();
    expect(menu!.style.maxHeight).toBe('calc(100dvh - 32px)');
    expect(menu!.style.overflowY).toBe('auto');
  });
});

describe('on a phone, the menu and the panels clear the touch controls', () => {
  // WAVE/JUMP/USE and the 💬/🎤 buttons sit at z 1650, over the Portfolio menu
  // (z 1600): a tap on Guestbook, Island Times, Your Pack or Island Journal
  // could land on WAVE, JUMP or USE instead. PanelManager hides them (the
  // nav-chips mechanism) while the menu, the hire card or a panel is up.
  const controls = (): Record<string, HTMLElement> => {
    const out: Record<string, HTMLElement> = {};
    for (const d of document.querySelectorAll<HTMLElement>('#ui-overlay > div')) {
      const caption = d.children.length === 2 ? text(d.lastElementChild!) : '';
      if (['USE', 'JUMP', 'WAVE'].includes(caption)) out[caption] = d;
    }
    const chat = document.querySelector<HTMLElement>('[aria-label="Open chat"]');
    const mic = document.querySelector<HTMLElement>('[aria-label^="Hold to talk"]');
    if (chat) out.chat = chat;
    if (mic) out.mic = mic;
    return out;
  };
  const ALL = ['JUMP', 'USE', 'WAVE', 'chat', 'mic'];
  const hidden = (): string[] =>
    Object.entries(controls())
      .filter(([, el]) => el.style.display === 'none')
      .map(([k]) => k)
      .sort();
  const displays = (): Record<string, string> =>
    Object.fromEntries(Object.entries(controls()).map(([k, el]) => [k, el.style.display]));

  beforeEach(() => {
    // ?touch selects the phone control scheme (SimpleUI.isTouch).
    history.replaceState(null, '', '/?touch=1');
    document.body.innerHTML = '<div id="ui-overlay"></div>';
    ui = new SimpleUI('ui-overlay');
  });
  afterEach(() => {
    history.replaceState(null, '', '/');
  });

  test('all five are on screen while nothing is open', () => {
    expect(ui.isTouchDevice()).toBe(true);
    expect(Object.keys(controls()).sort()).toEqual(ALL);
    expect(hidden()).toEqual([]);
  });

  test('the Portfolio menu hides them, and closing it restores them as they were', () => {
    const before = displays();
    portfolioChip().click(); // opens the menu
    expect(ui.isPanelOpen()).toBe(true);
    expect(hidden()).toEqual(ALL);
    portfolioChip().click(); // closes it
    expect(ui.isPanelOpen()).toBe(false);
    expect(displays()).toEqual(before);
  });

  test('the hire card and every Portfolio panel hide them until they close', () => {
    const before = displays();
    for (const id of ['hire', 'welcome', 'professional', 'projects', 'personal', 'contact']) {
      ui.showZonePanel({ id, name: id }, { source: 'menu' });
      expect(hidden(), id).toEqual(ALL);
      ui.hideZonePanel();
      expect(displays(), `${id} closed`).toEqual(before);
    }
  });

  test('a Portfolio-menu row hands over to its panel with the controls still hidden', () => {
    portfolioChip().click();
    document.querySelector<HTMLButtonElement>('button[data-section="hire"]')!.click();
    expect(text(panel())).toContain('Abbas Ali');
    expect(hidden()).toEqual(ALL);
  });

  test('every modal, and the Portfolio menu, lists both touch layers in its hides', () => {
    // Source lock for panels a DOM test cannot reach (the wall-screen picker
    // runs inside a building). Sheets that keep the controls on purpose (NPC
    // dialogue advances on USE; customise previews while moving) are exempt.
    const s = readFileSync(join(process.cwd(), 'SimpleUI.ts'), 'utf8');
    const specs = s
      .split('this.panels.open(')
      .slice(1)
      .map((chunk) => ({
        id: chunk.slice(0, chunk.indexOf(',')).trim(),
        kind: /kind: '(\w+)'/.exec(chunk)?.[1],
        hides: /hides: \[([^\]]*)\]/.exec(chunk)?.[1] ?? '',
      }));
    const mustClear = specs.filter((p) => p.kind === 'modal' || p.id === "'portfolio-menu'");
    expect(mustClear.map((p) => p.id)).toEqual(
      expect.arrayContaining(["'portfolio-menu'", "'zone'", "'watch-picker'"]),
    );
    for (const p of mustClear) {
      expect(p.hides, p.id).toContain("'touch-controls'");
      expect(p.hides, p.id).toContain("'aux-controls'");
    }
  });
});
