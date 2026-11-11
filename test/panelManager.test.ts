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
//   - Back closes the open panel instead of leaving the island (UX-02), run
//     against a session-history double with a browser's traversal rules.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { type HistoryPort, PanelManager, type PanelSpec } from '../PanelManager';
import { SimpleUI } from '../SimpleUI';

// The boards are Firebase reads; here they answer at once, empty.
vi.mock('../Boards', () => ({
  getLeaderboard: vi.fn(async () => []),
  readLeaderboard: vi.fn(async () => ({ ok: true, entries: [] })),
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

// ── Back closes the panel, not the island (UX-02) ───────────────────────

const clone = (v: unknown): unknown => (v === undefined ? null : JSON.parse(JSON.stringify(v)));

/**
 * A session history with a browser's traversal rules: back() and forward()
 * are queued tasks that step from whatever entry is current when they run and
 * then fire popstate, and stepping back from the landing entry leaves the
 * site. (A push made while a back is queued therefore gets stepped off: the
 * race the sweep's replaceState avoids.)
 */
class FakeHistory implements HistoryPort {
  entries: Array<{ state: unknown; url: string }>;
  index = 0;
  left = false;
  constructor(url = '/') {
    this.entries = [{ state: null, url }];
  }
  get state(): unknown {
    return this.entries[this.index].state;
  }
  get length(): number {
    return this.entries.length;
  }
  get url(): string {
    return this.entries[this.index].url;
  }
  pushState(data: unknown, _unused: string, url?: string | URL | null): void {
    this.entries.splice(this.index + 1);
    this.entries.push({ state: clone(data), url: url ? String(url) : this.url });
    this.index++;
  }
  replaceState(data: unknown, _unused: string, url?: string | URL | null): void {
    this.entries[this.index] = { state: clone(data), url: url ? String(url) : this.url };
  }
  back(): void {
    this.go(-1);
  }
  forward(): void {
    this.go(1);
  }
  private go(delta: number): void {
    setTimeout(() => {
      if (this.left) return;
      const to = this.index + delta;
      if (to < 0) {
        this.left = true;
        return;
      }
      if (to >= this.entries.length) return;
      this.index = to;
      window.dispatchEvent(new Event('popstate'));
    }, 0);
  }
}

/** Let queued traversals, their popstate handlers and microtasks run. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
};

describe('Back closes the panel, not the island (PanelManager)', () => {
  let h: FakeHistory;
  let pm: PanelManager;
  beforeEach(() => {
    h = new FakeHistory();
    pm = new PanelManager(overlay, false, { history: h });
  });
  afterEach(() => pm.dispose());

  test('an open pushes one entry; Back closes the panel; a second Back leaves', async () => {
    const close = vi.fn(() => pm.notifyClosed('zone'));
    pm.open('zone', spec({ close }));
    expect(h.length).toBe(2);
    expect(h.state).toMatchObject({ dsPanel: 'zone' });
    h.back();
    await settle();
    expect(close).toHaveBeenCalledTimes(1);
    expect(pm.current()).toBeNull();
    expect(h.left).toBe(false);
    h.back();
    await settle();
    expect(h.left).toBe(true);
  });

  test('✕ steps back off the entry, so one Back then leaves (no phantom entry)', async () => {
    pm.open('zone', spec());
    pm.notifyClosed('zone'); // the panel's own ✕
    await settle();
    expect(h.index).toBe(0);
    expect(pm.current()).toBeNull();
    h.back();
    await settle();
    expect(h.left).toBe(true);
  });

  test('Escape, the scrim and closeAll release the entry too', async () => {
    for (const shut of [
      () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })),
      () => scrimOf(pm).click(),
      () => pm.closeAll(),
    ]) {
      pm.open('zone', spec());
      expect(h.index).toBe(1);
      shut();
      await settle();
      expect(h.index).toBe(0);
      expect(pm.current()).toBeNull();
    }
    expect(h.left).toBe(false);
  });

  test('a same-id re-open pushes nothing', async () => {
    pm.open('shop', spec());
    pm.open('shop', spec()); // the shop re-renders after a purchase
    await settle();
    expect(h.length).toBe(2);
  });

  test('the sweep replaces the entry: B over A, then one Back is the island', async () => {
    const closeA = vi.fn();
    pm.open('a', spec({ close: closeA }));
    pm.open('b', spec());
    await settle();
    expect(closeA).toHaveBeenCalledTimes(1);
    expect(h.length).toBe(2);
    expect(h.state).toMatchObject({ dsPanel: 'b' });
    h.back();
    await settle();
    expect(pm.current()).toBeNull();
    h.back();
    await settle();
    expect(h.left).toBe(true);
  });

  test('a close then an open in one task re-labels the entry (showZonePanel)', async () => {
    pm.open('portfolio-menu', spec());
    pm.notifyClosed('portfolio-menu'); // the menu row closes the menu...
    pm.open('zone', spec()); // ...and opens the zone panel
    await settle();
    expect(h.length).toBe(2);
    expect(h.index).toBe(1);
    expect(h.state).toMatchObject({ dsPanel: 'zone' });
    expect(pm.current()).toBe('zone');
  });

  test('history:false panels push nothing, and sweeping into one releases the entry', async () => {
    pm.open('welcome', spec({ history: false }));
    pm.notifyClosed('welcome');
    pm.open('drawer', spec({ kind: 'sheet', history: false }));
    await settle();
    expect(h.length).toBe(1);
    pm.open('zone', spec());
    expect(h.length).toBe(2);
    pm.open('drawer', spec({ kind: 'sheet', history: false })); // sweeps the zone panel
    await settle();
    expect(h.index).toBe(0);
    expect(pm.current()).toBe('drawer');
    h.back();
    await settle();
    expect(h.left).toBe(true); // the drawer never spent a Back
  });

  test('an open while our back is in flight pushes once it has landed', async () => {
    pm.open('zone', spec());
    pm.notifyClosed('zone');
    await Promise.resolve(); // the step back is queued, not yet run
    pm.open('journal', spec());
    await settle();
    expect(h.index).toBe(1);
    expect(h.state).toMatchObject({ dsPanel: 'journal' });
    expect(pm.current()).toBe('journal');
  });

  test('an entry whose state another writer replaced is never stepped back from', async () => {
    pm.open('zone', spec());
    h.replaceState(null, ''); // e.g. a URL writer that drops history.state
    pm.notifyClosed('zone');
    await settle();
    expect(h.index).toBe(1); // a stale entry costs one Back; a wrong back() could leave
    expect(h.left).toBe(false);
  });

  test('Forward onto an entry whose panel has closed makes it a plain entry', async () => {
    const stale = vi.fn();
    pm.dispose();
    pm = new PanelManager(overlay, false, { history: h, onStaleEntry: stale });
    pm.open('zone', spec());
    pm.notifyClosed('zone');
    await settle();
    h.forward();
    await settle();
    expect(h.index).toBe(1);
    expect(h.state).toBeNull();
    expect(stale).toHaveBeenCalledTimes(1);
    expect(pm.current()).toBeNull();
  });

  test('an entry left by an earlier life of the page is cleared at boot', () => {
    const old = new FakeHistory();
    old.replaceState({ dsPanel: 'zone', dsTok: 'earlier:1' }, '');
    const fresh = new PanelManager(overlay, false, { history: old });
    expect(old.state).toBeNull();
    fresh.dispose();
  });

  const restored = (): Event =>
    Object.defineProperty(new Event('pageshow'), 'persisted', { value: true });

  test('a bfcache restore re-syncs: a lost entry is pushed again', async () => {
    pm.open('zone', spec());
    h.replaceState({ other: 1 }, ''); // came back to an entry that is not ours
    window.dispatchEvent(new Event('pageshow')); // a plain load: nothing to do
    expect(h.length).toBe(2);
    window.dispatchEvent(restored());
    expect(h.length).toBe(3);
    expect(h.state).toMatchObject({ dsPanel: 'zone' });
    h.back();
    await settle();
    expect(pm.current()).toBeNull();
  });

  test('a history write the browser refuses never breaks a panel', async () => {
    // Safari throws SecurityError past 100 pushState calls in 30 s.
    const refuse = (): never => {
      throw new DOMException('too many history calls', 'SecurityError');
    };
    const refusing: HistoryPort = {
      state: null,
      pushState: refuse,
      replaceState: refuse,
      back: refuse,
    };
    const p2 = new PanelManager(overlay, false, { history: refusing });
    expect(() => p2.open('zone', spec())).not.toThrow();
    expect(p2.current()).toBe('zone');
    expect(scrimOf(p2).style.display).toBe('block');
    expect(() => p2.notifyClosed('zone')).not.toThrow();
    await settle();
    expect(p2.current()).toBeNull();
    p2.dispose();
  });

  test('a refused back() leaves no later open waiting on a popstate that never comes', async () => {
    const h2 = new FakeHistory();
    const p2 = new PanelManager(overlay, false, { history: h2 });
    p2.open('zone', spec());
    h2.back = () => {
      throw new Error('refused');
    };
    p2.notifyClosed('zone');
    await settle();
    p2.open('journal', spec());
    expect(h2.length).toBe(3); // pushed at once
    expect(h2.state).toMatchObject({ dsPanel: 'journal' });
    p2.dispose();
  });

  test('page teardown never steps back: after dispose(), or while the page hides', async () => {
    pm.open('zone', spec());
    window.dispatchEvent(new Event('pagehide')); // navigating away
    pm.notifyClosed('zone');
    await settle();
    expect(h.index).toBe(1);
    window.dispatchEvent(new Event('pageshow')); // stayed after all
    pm.open('zone', spec());
    pm.dispose(); // SimpleUI.dispose, on beforeunload, before it closes the panels
    pm.notifyClosed('zone');
    await settle();
    expect(h.index).toBe(1);
    expect(h.left).toBe(false);
  });

  test('a bfcache restore drops a panel whose element is gone', () => {
    const el = document.createElement('div');
    pm.open('zone', spec({ el }));
    overlay.appendChild(el);
    pm.current(); // seen
    el.remove();
    window.dispatchEvent(restored());
    expect(pm.current()).toBeNull();
  });
});

describe('Back closes the panel, not the island (the island UI)', () => {
  // The real window.history in a browser: under vitest PanelManager leaves it
  // off (happy-dom's back() navigates to about:blank), so these tests run in
  // production mode with the double standing in for window.history, which
  // Share.setUrlParam writes through as well.
  let h: FakeHistory;
  let ui: SimpleUI;
  const realHistory = Object.getOwnPropertyDescriptor(window, 'history')!;
  const boot = (url = '/'): void => {
    history.replaceState(null, '', url); // happy-dom's location, read by the UI
    h = new FakeHistory(url);
    Object.defineProperty(window, 'history', { configurable: true, get: () => h });
    vi.stubEnv('MODE', 'production');
    document.body.innerHTML = '<div id="ui-overlay"></div>';
    ui = new SimpleUI('ui-overlay');
  };
  const zoneParam = (): string | null =>
    new URL(h.url, 'https://island.test').searchParams.get('zone');
  const closeButton = (): HTMLButtonElement =>
    [...document.querySelectorAll<HTMLButtonElement>('button[aria-label="Close"]')].at(-1)!;
  const chip = (label: string): HTMLElement =>
    document.querySelector<HTMLElement>(`[aria-label="${label}"]`)!;

  afterEach(() => {
    ui.panels.closeAll();
    ui.panels.dispose();
    Object.defineProperty(window, 'history', realHistory);
    vi.unstubAllEnvs();
    history.replaceState(null, '', '/');
  });

  test('1-2. Projects, then Back: still on the island, no panel, no zone; Back again leaves', async () => {
    boot();
    ui.showZonePanel({ id: 'projects', name: 'projects' }, { source: 'menu' });
    expect(h.length).toBe(2);
    expect(zoneParam()).toBe('projects');
    expect(h.state).toMatchObject({ dsPanel: 'zone' }); // setUrlParam kept the state
    h.back();
    await settle();
    expect(ui.panels.current()).toBeNull();
    expect(zoneParam()).toBeNull();
    expect(h.left).toBe(false);
    h.back();
    await settle();
    expect(h.left).toBe(true);
  });

  test('3. ✕, then one Back leaves the site', async () => {
    boot();
    ui.showZonePanel({ id: 'projects', name: 'projects' }, { source: 'menu' });
    closeButton().click();
    await settle();
    expect(ui.panels.current()).toBeNull();
    expect(zoneParam()).toBeNull();
    h.back();
    await settle();
    expect(h.left).toBe(true);
  });

  test('4. ?zone=hire opens the hire card, and one Back leaves the site', async () => {
    boot('/?zone=hire');
    ui.showZonePanel({ id: 'hire', name: 'hire' }, { source: 'deeplink' }); // main-simple's deep link
    expect(ui.panels.current()).toBe('zone');
    expect(h.length).toBe(1);
    closeButton().click(); // and closing it never steps back off the landing entry
    await settle();
    expect(h.left).toBe(false);
    expect(zoneParam()).toBeNull();
    h.back();
    await settle();
    expect(h.left).toBe(true);
  });

  test('5. Phone: drawer, Portfolio, Projects, then one Back is the island; the next leaves', async () => {
    boot('/?touch=1');
    chip('Open island menu').click(); // the drawer
    chip('Open portfolio menu').click(); // its Portfolio row
    document.querySelector<HTMLButtonElement>('button[data-section="projects"]')!.click();
    await settle();
    expect(ui.panels.current()).toBe('zone');
    expect(h.length).toBe(2);
    h.back();
    await settle();
    expect(ui.panels.current()).toBeNull();
    expect(zoneParam()).toBeNull();
    h.back();
    await settle();
    expect(h.left).toBe(true);
  });

  test('6. Projects, then Hiring from the menu (a sweep), then one Back is the island', async () => {
    boot();
    ui.showZonePanel({ id: 'projects', name: 'projects' }, { source: 'menu' });
    chip('Open portfolio menu').click(); // sweeps Projects
    document.querySelector<HTMLButtonElement>('button[data-section="hire"]')!.click();
    await settle();
    expect(zoneParam()).toBe('hire');
    expect(h.length).toBe(2);
    h.back();
    await settle();
    expect(ui.panels.current()).toBeNull();
    expect(zoneParam()).toBeNull();
    h.back();
    await settle();
    expect(h.left).toBe(true);
  });

  test('7. the welcome card, drawer, emote wheel, chat input and tour leave history alone', async () => {
    boot('/?touch=1');
    ui.showWelcome(null);
    ui.hideWelcome(false);
    chip('Open island menu').click(); // drawer open...
    chip('Open island menu').click(); // ...and shut
    chip('Send an emote').click();
    chip('Send an emote').click();
    ui.openChatInput();
    ui.panels.closeAll();
    ui.showTourOverlay(() => ui.hideTourOverlay());
    ui.hideTourOverlay();
    await settle();
    expect(h.length).toBe(1);
    expect(h.left).toBe(false);
  });
});

describe('PanelManager.setMode: a mode is not a panel (P2-D2)', () => {
  const layer = (): HTMLElement => {
    const el = document.createElement('div');
    el.style.display = 'flex';
    document.body.appendChild(el);
    return el;
  };

  test('touch: a mode hides its layers; a panel and a mode add up; clearing restores the base display', () => {
    const pm = new PanelManager(overlay, true);
    const info = layer();
    const chips = layer();
    pm.registerLayer('ambient-info', info);
    pm.registerLayer('nav-chips', chips);
    pm.setMode('interior', { hides: ['ambient-info'], hard: true });
    expect(info.style.display).toBe('none');
    expect(chips.style.display).toBe('flex');
    expect(pm.current()).toBeNull();
    expect(pm.isOpen()).toBe(false);
    pm.open('p', spec({ hides: ['nav-chips'] }));
    expect(chips.style.display).toBe('none');
    pm.closeAll(); // the sweep closes panels, never a mode
    expect(chips.style.display).toBe('flex');
    expect(info.style.display).toBe('none');
    expect(pm.inMode('interior')).toBe(true);
    pm.setMode('interior', null);
    expect(info.style.display).toBe('flex');
    pm.dispose();
  });

  test('desktop: hard takes the layer out, a soft mode dims it like a panel', () => {
    const pm = new PanelManager(overlay, false);
    const info = layer();
    pm.registerLayer('ambient-info', info);
    pm.setMode('soft', { hides: ['ambient-info'] });
    expect(info.style.opacity).toBe('0.35');
    expect(info.style.display).toBe('flex');
    pm.setMode('soft', null);
    expect(info.style.opacity).toBe('');
    pm.setMode('hard', { hides: ['ambient-info'], hard: true });
    expect(info.style.display).toBe('none');
    expect(info.style.opacity).toBe('');
    pm.setMode('hard', null);
    expect(info.style.display).toBe('flex');
    pm.dispose();
  });

  test('an element in two layers keeps one base display, and hides when either layer does', () => {
    const pm = new PanelManager(overlay, true);
    const jump = layer();
    pm.registerLayer('touch-controls', jump);
    pm.open('p', spec({ hides: ['touch-controls'] }));
    pm.registerLayer('outdoor-actions', jump); // registered while hidden: the base is still flex
    pm.closeAll();
    expect(jump.style.display).toBe('flex');
    pm.setMode('interior', { hides: ['outdoor-actions'], hard: true });
    expect(jump.style.display).toBe('none');
    pm.setMode('interior', null);
    expect(jump.style.display).toBe('flex');
    pm.dispose();
  });

  test('Escape and the scrim never touch a mode', () => {
    const pm = new PanelManager(overlay, true);
    pm.setMode('interior', { hides: ['ambient-info'], hard: true });
    expect(pm.closeTop('escape')).toBe(false);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    overlay.querySelector<HTMLElement>('div')!.click(); // the scrim
    expect(pm.inMode('interior')).toBe(true);
    pm.dispose();
  });
});
