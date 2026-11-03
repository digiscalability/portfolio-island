// @vitest-environment happy-dom
//
// PanelManager invariants (mobile-HUD Round 3, Phase 1). The two rules that
// exist because of shipped bugs:
//   - SAME-ID RE-OPEN must NOT fire close() — the shop re-renders itself
//     after every purchase; firing onClose mid-refresh unpauses the game
//     under the open shop.
//   - notifyClosed must NO-OP during the exclusivity sweep — every panel's
//     close() path calls notifyClosed, and the sweep owns the stack.
//   - a panel whose element has left the document pops by itself, and the
//     leaderboard's "Guide me" closes the id it was opened under (UX-01: it
//     named 'race-leaderboard', leaving the scrim up and the phone controls
//     hidden under "Follow the compass to the start gate").
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { PanelManager, type PanelSpec } from '../PanelManager';
import { SimpleUI } from '../SimpleUI';

// The boards are Firebase reads; here they answer at once, empty.
vi.mock('../Boards', () => ({
  getLeaderboard: vi.fn(async () => []),
}));

function spec(over: Partial<PanelSpec> = {}): PanelSpec {
  return { kind: 'modal', hides: [], close: () => {}, ...over };
}

let overlay: HTMLElement;

beforeEach(() => {
  document.body.innerHTML = '';
  overlay = document.createElement('div');
  document.body.appendChild(overlay);
});

describe('exclusivity', () => {
  test('opening a second panel closes the first (the modal-stacking bug)', () => {
    const pm = new PanelManager(overlay, false);
    const closeA = vi.fn();
    pm.open('a', spec({ close: closeA }));
    pm.open('b', spec());
    expect(closeA).toHaveBeenCalledTimes(1);
    expect(pm.isOpen('a')).toBe(false);
    expect(pm.current()).toBe('b');
  });

  test('allow keeps the named panel open underneath (watch-frame over picker)', () => {
    const pm = new PanelManager(overlay, false);
    const closePicker = vi.fn();
    pm.open('watch-picker', spec({ close: closePicker }));
    pm.open('watch-frame', spec({ allow: ['watch-picker'] }));
    expect(closePicker).not.toHaveBeenCalled();
    expect(pm.isOpen('watch-picker')).toBe(true);
    // Escape pops ONE level: frame first, picker stays.
    pm.closeTop();
    expect(pm.current()).toBe('watch-picker');
  });
});

describe('same-id re-open rule', () => {
  test('re-opening the top panel replaces the spec without close()', () => {
    const pm = new PanelManager(overlay, false);
    const closeFirst = vi.fn();
    pm.open('shop', spec({ close: closeFirst }));
    const closeSecond = vi.fn();
    pm.open('shop', spec({ close: closeSecond })); // purchase re-render
    expect(closeFirst).not.toHaveBeenCalled();
    expect(pm.current()).toBe('shop');
    // The REPLACED spec is the live one now.
    pm.closeTop();
    expect(closeSecond).toHaveBeenCalledTimes(1);
  });
});

describe('sweep guard', () => {
  test('notifyClosed during the sweep is a no-op (close paths call it)', () => {
    const pm = new PanelManager(overlay, false);
    pm.open(
      'a',
      spec({
        close: () => pm.notifyClosed('a'), // the realistic teardown shape
      }),
    );
    pm.open('b', spec());
    expect(pm.current()).toBe('b');
    expect(pm.isOpen()).toBe(true);
  });

  test('a throwing close() cannot strand the sweep', () => {
    const pm = new PanelManager(overlay, false);
    pm.open(
      'bad',
      spec({
        close: () => {
          throw new Error('teardown bug');
        },
      }),
    );
    pm.open('good', spec());
    expect(pm.current()).toBe('good');
    // The guard flag must have been reset — notifyClosed works again.
    pm.notifyClosed('good');
    expect(pm.isOpen()).toBe(false);
  });
});

describe('closeTop idempotence', () => {
  test('close() that calls notifyClosed does not double-pop', () => {
    const pm = new PanelManager(overlay, false);
    pm.open('a', spec({ close: () => pm.notifyClosed('a') }));
    pm.open('b', spec({ allow: ['a'], close: () => pm.notifyClosed('b') }));
    expect(pm.closeTop()).toBe(true); // closes b
    expect(pm.current()).toBe('a');
    expect(pm.closeTop()).toBe(true); // closes a
    expect(pm.closeTop()).toBe(false); // empty
  });
});

describe('layer policy by isTouch', () => {
  test('touch hides suppressed layers with display:none', () => {
    const pm = new PanelManager(overlay, true);
    const chip = document.createElement('button');
    pm.registerLayer('nav-chips', chip);
    pm.open('m', spec({ hides: ['nav-chips'] }));
    expect(chip.style.display).toBe('none');
    pm.closeTop();
    expect(chip.style.display).toBe('');
  });

  test('desktop dims to 0.35 and disables pointer events instead', () => {
    const pm = new PanelManager(overlay, false);
    const chip = document.createElement('button');
    pm.registerLayer('nav-chips', chip);
    pm.open('m', spec({ hides: ['nav-chips'] }));
    expect(chip.style.display).not.toBe('none');
    expect(chip.style.opacity).toBe('0.35');
    expect(chip.style.pointerEvents).toBe('none');
    pm.closeTop();
    expect(chip.style.opacity).toBe('');
  });

  test('hides are the UNION across the open stack, not just the top', () => {
    const pm = new PanelManager(overlay, true);
    const chip = document.createElement('button');
    const btn = document.createElement('button');
    pm.registerLayer('nav-chips', chip);
    pm.registerLayer('touch-controls', btn);
    pm.open('lower', spec({ hides: ['touch-controls'] }));
    pm.open('upper', spec({ allow: ['lower'], hides: ['nav-chips'] }));
    expect(chip.style.display).toBe('none');
    expect(btn.style.display).toBe('none'); // lower panel's policy still holds
    pm.closeTop();
    expect(chip.style.display).toBe('');
    expect(btn.style.display).toBe('none');
  });

  test('restore puts back the INLINE display, not empty string', () => {
    // The tier-1 chip row is display:flex — restoring '' collapsed it to
    // block and its chips stacked vertically (caught in browser verify).
    const pm = new PanelManager(overlay, true);
    const row = document.createElement('div');
    row.style.display = 'flex';
    pm.registerLayer('nav-chips', row);
    pm.open('m', spec({ hides: ['nav-chips'] }));
    expect(row.style.display).toBe('none');
    pm.closeTop();
    expect(row.style.display).toBe('flex');
  });

  test('an element registered late gets the current policy applied', () => {
    const pm = new PanelManager(overlay, true);
    pm.open('m', spec({ hides: ['nav-chips'] }));
    const lateChip = document.createElement('button');
    pm.registerLayer('nav-chips', lateChip); // coin counter created on first update
    expect(lateChip.style.display).toBe('none');
  });
});

describe('scrim + Escape', () => {
  test('scrim shows only while the top panel is a modal', () => {
    const pm = new PanelManager(overlay, false);
    const scrim = overlay.firstElementChild as HTMLElement;
    expect(scrim.style.display).toBe('none');
    pm.open('m', spec({ kind: 'modal' }));
    expect(scrim.style.display).toBe('block');
    pm.open('s', spec({ kind: 'sheet' }));
    expect(scrim.style.display).toBe('none');
  });

  test('document Escape closes the top panel unless it owns the key', () => {
    const pm = new PanelManager(overlay, false);
    const closeA = vi.fn();
    pm.open('a', spec({ close: closeA }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(closeA).toHaveBeenCalledTimes(1);

    const closeOwn = vi.fn();
    pm.open('own', spec({ ownEscape: true, close: closeOwn }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(closeOwn).not.toHaveBeenCalled();
    expect(pm.current()).toBe('own');
  });
});

const scrimOf = (pm: PanelManager): HTMLElement => (pm as unknown as { scrim: HTMLElement }).scrim;

describe('a detached panel pops (the second UX-01 safeguard)', () => {
  test('its element leaving the document takes the entry and the scrim down', () => {
    const pm = new PanelManager(overlay, true);
    const chip = document.createElement('button');
    pm.registerLayer('touch-controls', chip);
    const modal = document.createElement('div');
    pm.open('leaderboard', spec({ hides: ['touch-controls'], el: modal }));
    overlay.appendChild(modal);
    expect(pm.current()).toBe('leaderboard'); // seen in the document
    modal.remove(); // a close path that removed the DOM and told nobody
    expect(pm.isOpen()).toBe(false);
    expect(scrimOf(pm).style.display).toBe('none');
    expect(chip.style.display).toBe('');
  });

  test('notifying the wrong id still re-derives (the exact UX-01 sequence)', () => {
    const pm = new PanelManager(overlay, false);
    const modal = document.createElement('div');
    pm.open('leaderboard', spec({ el: modal }));
    overlay.appendChild(modal);
    pm.current();
    modal.remove();
    pm.notifyClosed('race-leaderboard');
    expect(scrimOf(pm).style.display).toBe('none');
  });

  test('a modal is not popped before its caller appends it', async () => {
    const pm = new PanelManager(overlay, false);
    const modal = document.createElement('div');
    pm.open('m', spec({ el: modal })); // buildCenteredModal opens, then appends
    expect(pm.current()).toBe('m');
    overlay.appendChild(modal);
    await Promise.resolve(); // the post-open check
    expect(pm.current()).toBe('m');
  });

  test('one removed in the same task as its open still pops', async () => {
    const pm = new PanelManager(overlay, false);
    const modal = document.createElement('div');
    pm.open('m', spec({ el: modal }));
    overlay.appendChild(modal);
    await Promise.resolve(); // seen by the post-open check
    modal.remove();
    expect(pm.isOpen()).toBe(false);
  });

  test('a same-id re-open with a new element waits for that element', () => {
    const pm = new PanelManager(overlay, false);
    const first = document.createElement('div');
    pm.open('inventory', spec({ el: first }));
    overlay.appendChild(first);
    pm.current();
    first.remove(); // showInventory drops the previous element first...
    const second = document.createElement('div');
    pm.open('inventory', spec({ el: second })); // ...then re-opens the same id
    overlay.appendChild(second);
    expect(pm.current()).toBe('inventory');
  });
});

describe("the leaderboards' Guide me leaves no scrim (UX-01)", () => {
  let ui: SimpleUI;
  const guideMe = (): HTMLButtonElement =>
    [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      (b.textContent ?? '').includes('Guide me to the start line'),
    )!;
  const controls = (): HTMLElement[] =>
    [...document.querySelectorAll<HTMLElement>('#ui-overlay > div')].filter(
      (d) =>
        d.children.length === 2 && /^(USE|JUMP|WAVE)$/.test(d.lastElementChild?.textContent ?? ''),
    );

  beforeEach(() => {
    document.body.innerHTML = '<div id="ui-overlay"></div>';
  });
  afterEach(() => {
    history.replaceState(null, '', '/');
  });

  test('desktop: the Leaderboard closes for real and the compass guide runs', async () => {
    ui = new SimpleUI('ui-overlay');
    const guided = vi.fn();
    ui.setOnRaceGuide(guided);
    await ui.showLeaderboard();
    expect(ui.panels.current()).toBe('leaderboard');
    guideMe().click();
    expect(ui.panels.isOpen()).toBe(false);
    expect(scrimOf(ui.panels).style.display).toBe('none');
    expect(ui.isPanelOpen()).toBe(false); // Enter-to-chat works again
    expect(guided).toHaveBeenCalledTimes(1);
  });

  test('phone: the joystick buttons come straight back', async () => {
    history.replaceState(null, '', '/?touch=1'); // ?touch selects the phone scheme
    ui = new SimpleUI('ui-overlay');
    expect(controls()).toHaveLength(3);
    await ui.showLeaderboard();
    expect(controls().every((c) => c.style.display === 'none')).toBe(true);
    guideMe().click();
    expect(ui.panels.isOpen()).toBe(false);
    expect(scrimOf(ui.panels).style.display).toBe('none');
    expect(controls().every((c) => c.style.display !== 'none')).toBe(true);
  });

  test('the race-finish board closes its own id too', async () => {
    ui = new SimpleUI('ui-overlay');
    await ui.showRaceLeaderboard('land', 61_234, 'Tester');
    expect(ui.panels.current()).toBe('race-leaderboard');
    guideMe().click();
    expect(ui.panels.isOpen()).toBe(false);
    expect(scrimOf(ui.panels).style.display).toBe('none');
  });
});
