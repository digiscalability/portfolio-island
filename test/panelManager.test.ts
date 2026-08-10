// @vitest-environment happy-dom
//
// PanelManager invariants (mobile-HUD Round 3, Phase 1). The two rules that
// exist because of shipped bugs:
//   - SAME-ID RE-OPEN must NOT fire close() — the shop re-renders itself
//     after every purchase; firing onClose mid-refresh unpauses the game
//     under the open shop.
//   - notifyClosed must NO-OP during the exclusivity sweep — every panel's
//     close() path calls notifyClosed, and the sweep owns the stack.
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { PanelManager, type PanelSpec } from '../PanelManager';

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
