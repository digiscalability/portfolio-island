// @vitest-environment happy-dom
//
// P2-D1 (INT-02): the fourth passport stamp lands inside a hall. It fired
// Passport.onComplete from the middle of showZonePanel, main-simple's reward
// opened showPassportComplete, whose open swept the half-built hall panel;
// showZonePanel then threw on the null panel, fadeThrough's try swallowed it,
// and enterBuilding never reached showLeaveButton: a visitor indoors with no
// content and no Leave. Now the stamp is the panel's last step and the crown
// stacks over the panel.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { type HistoryPort } from '../PanelManager';
import { Passport } from '../Passport';
import { SimpleUI } from '../SimpleUI';

const internals = (ui: SimpleUI): { zonePanelDiv: HTMLElement | null } =>
  ui as unknown as { zonePanelDiv: HTMLElement | null };
const stack = (ui: SimpleUI): string[] =>
  (ui.panels as unknown as { stack: Array<{ id: string }> }).stack.map((e) => e.id);
const crown = (): HTMLElement | undefined =>
  [...document.querySelectorAll<HTMLElement>('#ui-overlay > [role=dialog]')].find((d) =>
    (d.textContent ?? '').includes('Portfolio complete!'),
  );

/** main-simple's wiring: the reward celebrates through showPassportComplete. */
const boot = (): SimpleUI => {
  document.body.innerHTML = '<div id="ui-overlay"></div>';
  const ui = new SimpleUI('ui-overlay');
  const passport = new Passport();
  passport.setOnComplete(() => ui.showPassportComplete());
  ui.setPassport(passport);
  return ui;
};

let ui: SimpleUI;

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('ds_passport', JSON.stringify(['professional', 'projects', 'personal']));
});

afterEach(() => {
  ui.panels.closeAll();
  // The page's own teardown (PanelManager's dispose first): the stamp hint's
  // queue timers stop with it, so none fires after this file has gone.
  ui.dispose();
  vi.unstubAllEnvs();
  history.replaceState(null, '', '/');
});

describe('the fourth stamp inside a hall', () => {
  test('stacks the crown over the hall panel instead of crashing it', async () => {
    ui = boot();
    expect(() =>
      ui.showZonePanel({ id: 'contact', name: 'contact' }, { source: 'proximity' }),
    ).not.toThrow();
    const panel = internals(ui).zonePanelDiv;
    expect(panel).not.toBeNull();
    expect(panel!.isConnected).toBe(true);
    expect(stack(ui)).toEqual(['zone', 'passport-complete']);
    expect(ui.panels.current()).toBe('passport-complete');
    // The whole hall panel was built: its lead form, share footer and close.
    expect(panel!.querySelector('#lead-form-block')).not.toBeNull();
    expect(panel!.querySelector('button[aria-label="Close"]')).not.toBeNull();
    expect(crown()).toBeTruthy();
    await Promise.resolve();
    expect(crown()!.contains(document.activeElement)).toBe(true); // the crown has focus
    expect(localStorage.getItem('ds_passport_reward')).toBe('1');
  });

  test('Escape closes only the crown; the Get In Touch panel stays, focus on its heading', async () => {
    ui = boot();
    ui.showZonePanel({ id: 'contact', name: 'contact' }, { source: 'proximity' });
    await Promise.resolve();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(crown()).toBeUndefined();
    expect(stack(ui)).toEqual(['zone']);
    const panel = internals(ui).zonePanelDiv!;
    expect(panel.isConnected).toBe(true);
    expect(panel.querySelector('#lead-form-block')).not.toBeNull();
    expect(document.activeElement).toBe(panel.querySelector('h2'));
    // A second Escape is the hall panel's.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(ui.panels.current()).toBeNull();
  });

  test("the crown's CTA closes it the same way", async () => {
    ui = boot();
    ui.showZonePanel({ id: 'contact', name: 'contact' }, { source: 'proximity' });
    await Promise.resolve();
    [...crown()!.querySelectorAll('button')]
      .find((b) => (b.textContent ?? '').includes('Keep exploring'))!
      .click();
    expect(stack(ui)).toEqual(['zone']);
    expect(document.activeElement).toBe(internals(ui).zonePanelDiv!.querySelector('h2'));
  });

  test('stamps 1-3 still open the panel alone, with the stamp hint queued', () => {
    localStorage.setItem('ds_passport', JSON.stringify(['professional']));
    ui = boot();
    ui.showZonePanel({ id: 'projects', name: 'projects' }, { source: 'proximity' });
    expect(stack(ui)).toEqual(['zone']);
    expect(crown()).toBeUndefined();
  });

  test('Back with the crown up closes the crown, then the hall panel, then leaves', async () => {
    // A session history with a browser's traversal rules (as panelManager's).
    const entries: Array<{ state: unknown }> = [{ state: null }];
    let index = 0;
    let left = false;
    const h: HistoryPort & { back(): void } = {
      get state() {
        return entries[index].state;
      },
      pushState(data) {
        entries.splice(index + 1);
        entries.push({ state: JSON.parse(JSON.stringify(data ?? null)) });
        index++;
      },
      replaceState(data) {
        entries[index] = { state: JSON.parse(JSON.stringify(data ?? null)) };
      },
      back() {
        setTimeout(() => {
          if (index === 0) {
            left = true;
            return;
          }
          index--;
          window.dispatchEvent(new Event('popstate'));
        }, 0);
      },
    };
    const real = Object.getOwnPropertyDescriptor(window, 'history')!;
    Object.defineProperty(window, 'history', { configurable: true, get: () => h });
    vi.stubEnv('MODE', 'production');
    const settle = async (): Promise<void> => {
      for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
    };
    try {
      ui = boot();
      ui.showZonePanel({ id: 'contact', name: 'contact' }, { source: 'proximity' });
      await settle();
      expect(entries.length).toBe(2); // one entry for the panel the crown sits on
      h.back();
      await settle();
      expect(stack(ui)).toEqual(['zone']); // the crown went, the hall stayed
      expect(left).toBe(false);
      h.back();
      await settle();
      expect(ui.panels.current()).toBeNull();
      expect(left).toBe(false);
      h.back();
      await settle();
      expect(left).toBe(true);
    } finally {
      Object.defineProperty(window, 'history', real);
    }
  });
});

// P2-D10: the crown leads somewhere, and the visit gets a summary. main-simple
// publishes 'ds:goals' in the same task as it opens the card.
describe("the crown's next step and the visit summary", () => {
  const goals = (next: { id: string; label: string; guideKey: string } | null) => ({
    done: 5,
    total: 14,
    next,
    goals: [
      {
        id: 'stamp:projects',
        rung: 1,
        label: 'Projects',
        guideKey: 'district:projects',
        done: true,
      },
      { id: 'hire', rung: 1, label: 'The hire card', guideKey: 'panel:hire', done: true },
      {
        id: 'talk',
        rung: 2,
        label: 'Talk to a villager',
        guideKey: 'villager:ai-nearest',
        done: false,
      },
      { id: 'catch', rung: 2, label: 'Catch a fish', guideKey: 'shore', done: false },
    ],
    visit: { stamps: 4, villagers: 2, coins: 37, secrets: 1, minutes: 9 },
  });
  const publish = (d: unknown): void => {
    window.dispatchEvent(new CustomEvent('ds:goals', { detail: d }));
  };

  test("'Next:' names the ladder's goal, and its click closes the crown and guides there", async () => {
    ui = boot();
    const sent: unknown[] = [];
    const on = (e: Event): void => {
      sent.push((e as CustomEvent).detail);
    };
    window.addEventListener('ds:guide-to', on);
    publish(goals({ id: 'talk', label: 'Talk to a villager', guideKey: 'villager:ai-nearest' }));
    ui.showZonePanel({ id: 'contact', name: 'contact' }, { source: 'proximity' });
    await Promise.resolve();
    const card = crown()!;
    const cta = card.querySelector<HTMLButtonElement>('button[data-crown-next]')!;
    expect(cta.textContent).toBe('Next: Talk to a villager →');
    const stats = Object.fromEntries(
      [...card.querySelectorAll<HTMLElement>('[data-visit-stat]')].map((c) => [
        c.dataset.visitStat,
        c.querySelector('dd')!.textContent,
      ]),
    );
    expect(stats).toEqual({ stamps: '4', villagers: '2', coins: '37', secrets: '1', minutes: '9' });
    // The share button stays.
    expect(card.textContent).toContain('Share the island');
    cta.click();
    window.removeEventListener('ds:guide-to', on);
    expect(stack(ui)).toEqual(['zone']);
    expect(sent).toEqual([{ key: 'villager:ai-nearest', source: 'crown' }]);
  });

  test("with no 'ds:goals', 'Keep exploring' and no summary block", async () => {
    ui = boot();
    ui.showZonePanel({ id: 'contact', name: 'contact' }, { source: 'proximity' });
    await Promise.resolve();
    const card = crown()!;
    expect(card.querySelector('button[data-crown-next]')!.textContent).toBe('Keep exploring →');
    expect(card.querySelector('[data-visit]')).toBeNull();
  });

  test("the Portfolio menu's Island group lists 'Your visit', and it opens the summary", () => {
    ui = boot();
    publish(goals(null));
    (ui as unknown as { togglePortfolioMenu(): void }).togglePortfolioMenu();
    const group = document.getElementById('ds-menu-group-island')!.parentElement!;
    const row = group.querySelector<HTMLButtonElement>('button[data-visit]')!;
    expect(row.textContent).toContain('Your visit');
    row.click();
    expect(ui.panels.current()).toBe('visit');
    const stat = document.querySelector<HTMLElement>('[data-visit-stat="coins"] dd')!;
    expect(stat.textContent).toBe('37');
  });

  test("Things to do renders the ladder's rows once 'ds:goals' has fired", () => {
    ui = boot();
    ui.showControls('menu', 'todo');
    const before = document.querySelectorAll('.ds-controls-todo li').length;
    expect(before).toBeGreaterThanOrEqual(8); // the static rows, the fallback
    ui.panels.closeAll();
    publish(goals({ id: 'talk', label: 'Talk to a villager', guideKey: 'villager:ai-nearest' }));
    ui.showControls('menu', 'todo');
    const rows = [...document.querySelectorAll<HTMLElement>('.ds-controls-todo li')];
    expect(rows.map((r) => r.querySelector('strong')!.textContent)).toEqual([
      '🚀 Projects',
      expect.stringContaining('The hire card'),
      expect.stringContaining('Talk to a villager'),
      '🎣 Catch a fish',
    ]);
    expect(rows[0].dataset.done).toBe('1');
    expect(rows[0].querySelector('button')).toBeNull();
    expect(rows[3].querySelector<HTMLElement>('button[data-show-me]')!.dataset.showMe).toBe(
      'shore',
    );
  });
});
