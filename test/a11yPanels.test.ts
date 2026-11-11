// @vitest-environment happy-dom
//
// D4: focus that moves in, stays in and comes back; a first-run card a stray
// tap can't burn; a drawer that waits for the keyboard (FOCUS-01, UX-03,
// FM-02, FM-06, UX-15, PANEL-01). Run on a REAL SimpleUI and on PanelManager
// directly. What needs layout (ArrowDown scrolling a focused panel, small
// targets measured in pixels) is keyboard.cjs's and phone.cjs's job; these
// hold the contract that makes it work.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { a11y } from '../Accessibility';
import { type CloseReason, PanelManager, type PanelSpec } from '../PanelManager';
import { Passport } from '../Passport';
import { hapticPulse, hapticsEnabled, SimpleUI } from '../SimpleUI';

// The boards are Firebase reads; here they answer at once, empty.
vi.mock('../Boards', () => ({
  getLeaderboard: vi.fn(async () => []),
  readLeaderboard: vi.fn(async () => ({ ok: true, entries: [] })),
  getGuestbook: vi.fn(async () => []),
  readGuestbook: vi.fn(async () => ({ ok: true, entries: [] })),
  signGuestbook: vi.fn(async () => true),
  submitLead: vi.fn(async () => true),
}));

const tick = (): Promise<void> => Promise.resolve();
const key = (
  k: string,
  target: EventTarget = document,
  init: KeyboardEventInit = {},
): KeyboardEvent => {
  const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(e);
  return e;
};
const chip = (label: string): HTMLElement =>
  document.querySelector<HTMLElement>(`[aria-label="${label}"]`)!;
const zonePanel = (): HTMLElement | undefined =>
  [...document.querySelectorAll<HTMLElement>('#ui-overlay > div')].find(
    (d) => d.style.zIndex === '1650' && !!d.querySelector('[data-email], h2'),
  );

let ui: SimpleUI;

beforeEach(() => {
  document.body.innerHTML = '<div id="ui-overlay"></div>';
  localStorage.clear();
  sessionStorage.clear();
  window.__analyticsLog = [];
  ui = new SimpleUI('ui-overlay');
});

afterEach(() => {
  ui.hideZonePanel();
  ui.hideWelcome(false);
  ui.panels.closeAll();
  ui.dispose(); // PanelManager's dispose, and no message timer outlives the test
  vi.useRealTimers();
  vi.restoreAllMocks();
  history.replaceState(null, '', '/');
});

describe('a zone panel takes focus, keeps it, and gives it back', () => {
  test('pill → menu row → panel heading, and Escape returns to the pill', async () => {
    const pill = chip('Open portfolio menu');
    pill.focus();
    key('Enter', pill); // a keyboard open
    await tick();
    const row = document.querySelector<HTMLElement>('button[data-section="projects"]')!;
    row.focus();
    key('Enter', row); // the browser turns this into a click on a <button>
    row.click();
    await tick();
    const panel = zonePanel()!;
    expect(ui.panels.current()).toBe('zone');
    expect(panel.getAttribute('role')).toBe('dialog');
    expect(panel.getAttribute('aria-modal')).toBe('true');
    const h2 = panel.querySelector('h2')!;
    expect(panel.getAttribute('aria-labelledby')).toBe(h2.id);
    // Focus is on the heading, INSIDE the scroller, so ↑/↓, PageUp/PageDown
    // and Space scroll it natively (the arrows walked the avatar before A2).
    expect(document.activeElement).toBe(h2);
    expect(h2.getAttribute('tabindex')).toBe('-1');
    expect(panel.style.overflowY).toBe('auto');
    key('Escape');
    expect(ui.panels.current()).toBeNull();
    expect(document.activeElement).toBe(pill);
  });

  test('a panel the world opened (E at a door) hands focus back to the world', async () => {
    ui.showZonePanel({ id: 'projects', name: 'projects' }, { source: 'proximity' });
    await tick();
    expect(document.activeElement).toBe(zonePanel()!.querySelector('h2'));
    key('Escape');
    // Not the Portfolio pill: a chip holding focus would take the next Enter
    // (chat) or Space (jump).
    expect(document.activeElement === document.body || document.activeElement === null).toBe(true);
  });

  test('a pointer-opened menu gives focus back to the world on close, not to the chip', async () => {
    const pill = chip('Open portfolio menu');
    pill.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    await tick();
    expect(document.activeElement).toBe(document.querySelector('button[data-section]'));
    pill.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    expect(ui.isPanelOpen()).toBe(false);
    expect(document.activeElement).not.toBe(pill);
  });
});

describe('a modal makes the rest of the overlay inert, and traps Tab', () => {
  test('every other overlay child is inert; the scrim, the Leave pill and #ds-guide are not', async () => {
    ui.showLeaveButton(() => {});
    const guide = document.createElement('div');
    guide.id = 'ds-guide';
    ui.getOverlay().appendChild(guide);
    ui.showHireCard('cta');
    await tick();
    const panel = zonePanel()!;
    const leave = document.querySelector<HTMLElement>('#ui-overlay > button[data-leave]')!;
    expect(leave.textContent).toBe('← Leave');
    const pill = chip('Open portfolio menu');
    expect(pill.closest('[inert]')).not.toBeNull();
    expect(panel.hasAttribute('inert')).toBe(false);
    expect(leave.hasAttribute('inert')).toBe(false);
    expect(guide.hasAttribute('inert')).toBe(false);
    ui.hideZonePanel();
    expect(document.querySelectorAll('#ui-overlay [inert]')).toHaveLength(0);
  });

  test('Tab wraps last → first and Shift+Tab first → last; Tab from the heading steps in', async () => {
    ui.showHireCard('cta');
    await tick();
    const panel = zonePanel()!;
    const controls = [
      ...panel.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input, textarea'),
    ];
    expect(controls.length).toBeGreaterThan(3);
    const [first, last] = [controls[0], controls[controls.length - 1]];
    expect(document.activeElement).toBe(panel.querySelector('h2'));
    let e = key('Tab');
    expect(e.defaultPrevented).toBe(true);
    const afterHeading = document.activeElement as HTMLElement;
    expect(panel.contains(afterHeading)).toBe(true);
    expect(
      panel.querySelector('h2')!.compareDocumentPosition(afterHeading) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    last.focus();
    e = key('Tab');
    expect(e.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(first);
    key('Tab', document, { shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  test('a Tab step lets the panel scroll its control into view; the first focus does not', async () => {
    // Trapped with preventScroll, Tab walked a long panel off its visible part
    // (2.4.11). The sticky section nav is cleared by scroll-padding-top.
    const calls: Array<{ el: HTMLElement; preventScroll?: boolean }> = [];
    const focus = HTMLElement.prototype.focus;
    vi.spyOn(HTMLElement.prototype, 'focus').mockImplementation(function (
      this: HTMLElement,
      opts?: FocusOptions,
    ) {
      calls.push({ el: this, preventScroll: opts?.preventScroll });
      focus.call(this, opts);
    });
    ui.showHireCard('cta');
    await tick();
    const panel = zonePanel()!;
    const nav = panel.querySelector('[data-panel-nav]')!;
    expect(calls.at(-1)).toEqual({ el: panel.querySelector('h2'), preventScroll: true });
    expect(panel.style.scrollPaddingTop).toMatch(/^\d+px$/);
    key('Tab');
    key('Tab');
    key('Tab', document, { shiftKey: true });
    const steps = calls.slice(-3);
    expect(steps.every((c) => panel.contains(c.el) && c.preventScroll === false)).toBe(true);
    expect(steps.some((c) => nav.contains(c.el))).toBe(false); // the nav sits before the h2
  });

  test('the Portfolio menu is a dialog, but a sheet: no aria-modal, no trap, no inert', async () => {
    chip('Open portfolio menu').click();
    await tick();
    const menu = document.querySelector<HTMLElement>(
      '[aria-labelledby="ds-portfolio-menu-title"]',
    )!;
    expect(menu.getAttribute('role')).toBe('dialog');
    expect(menu.hasAttribute('aria-modal')).toBe(false);
    expect(document.getElementById('ds-portfolio-menu-title')!.textContent).toContain('Portfolio');
    expect(key('Tab').defaultPrevented).toBe(false);
    expect(document.querySelectorAll('#ui-overlay [inert]')).toHaveLength(0);
    expect(menu.querySelector('[aria-label="Close portfolio menu"]')).not.toBeNull();
  });
});

describe('the first-run card', () => {
  test('focuses the dialog itself, so Space and Enter leave it open', async () => {
    ui.showWelcome(null);
    await tick();
    const card = document.querySelector<HTMLElement>(
      '[role=dialog][aria-label="Welcome to DigiScalability Life Island"]',
    )!;
    expect(document.activeElement).toBe(card);
    expect(card.tabIndex).toBe(-1);
    for (const k of [' ', 'Enter']) key(k, card);
    expect(ui.isWelcomeVisible()).toBe(true);
    expect(ui.panels.current()).toBe('welcome');
    // The first Tab reaches the Hiring pill, in DOM order, and Tab is trapped.
    key('Tab');
    expect(document.activeElement).toBe(card.querySelector('button[data-recruit]'));
    const buttons = [...card.querySelectorAll<HTMLElement>('button')];
    buttons[buttons.length - 1].focus();
    key('Tab');
    expect(card.contains(document.activeElement)).toBe(true);
  });

  test('a tap on the scrim closes it without burning ds_welcomed; the card comes back', async () => {
    ui.showWelcome(null);
    await tick();
    const scrim = ui.getOverlay().firstElementChild as HTMLElement;
    expect(scrim.style.display).toBe('block');
    scrim.click();
    expect(ui.isWelcomeVisible()).toBe(false);
    expect(localStorage.getItem('ds_welcomed')).toBeNull();
    ui.showWelcome(null); // the next load
    expect(document.querySelector('[role=dialog] h1')!.textContent).toBe(
      'DigiScalability Life Island',
    );
  });

  test('Explore still persists it', () => {
    ui.showWelcome(null);
    document.querySelector<HTMLButtonElement>('button[data-dismiss]')!.click();
    expect(localStorage.getItem('ds_welcomed')).toBe('1');
  });
});

describe("PanelManager's close reasons and 'ds:modal'", () => {
  let overlay: HTMLElement;
  let pm: PanelManager;
  const spec = (over: Partial<PanelSpec> = {}): PanelSpec => ({
    kind: 'modal',
    hides: [],
    close: () => {},
    ...over,
  });
  beforeEach(() => {
    overlay = document.createElement('div');
    document.body.appendChild(overlay);
    pm = new PanelManager(overlay, false);
  });
  afterEach(() => pm.dispose());

  test('close(reason) says escape, scrim or sweep', () => {
    const reasons: Array<CloseReason | undefined> = [];
    const close = (r?: CloseReason): void => {
      reasons.push(r);
    };
    pm.open('a', spec({ close }));
    key('Escape');
    pm.open('a', spec({ close }));
    (overlay.firstElementChild as HTMLElement).click();
    pm.open('a', spec({ close }));
    pm.open('b', spec());
    expect(reasons).toEqual(['escape', 'scrim', 'sweep']);
  });

  test('one event per change of modal state, with the zone; none for a same-task swap', async () => {
    const seen: unknown[] = [];
    const on = (e: Event): void => {
      seen.push((e as CustomEvent).detail);
    };
    window.addEventListener('ds:modal', on);
    try {
      pm.open('zone', spec({ zone: 'hire' }));
      await tick();
      pm.notifyClosed('zone'); // a section switch: close then open, one task
      pm.open('zone', spec({ zone: 'projects' }));
      await tick();
      pm.open('portfolio-menu', spec({ kind: 'sheet' })); // the top turns into a sheet
      await tick();
      expect(seen).toEqual([
        { open: true, id: 'zone', zone: 'hire' },
        { open: false, id: 'zone', zone: 'projects' },
      ]);
    } finally {
      window.removeEventListener('ds:modal', on);
    }
  });

  test('closing the hire card dispatches {open:false, id:"zone", zone:"hire"}', async () => {
    const seen: unknown[] = [];
    const on = (e: Event): void => {
      seen.push((e as CustomEvent).detail);
    };
    window.addEventListener('ds:modal', on);
    try {
      ui.showHireCard('cta');
      await tick();
      ui.hideZonePanel();
      await tick();
      expect(seen.at(-1)).toEqual({ open: false, id: 'zone', zone: 'hire' });
    } finally {
      window.removeEventListener('ds:modal', on);
    }
  });
});

describe('dialog names and keyboard scrolling', () => {
  test('a centred modal is named by its heading; a scroller with no control takes focus', async () => {
    await ui.showGuestbook();
    await tick();
    const modal = [...document.querySelectorAll<HTMLElement>('#ui-overlay > [role=dialog]')].at(
      -1,
    )!;
    const name = modal.getAttribute('aria-labelledby');
    expect(name).toBeTruthy();
    expect(document.getElementById(name!)!.textContent).toContain('Guestbook');
    expect(modal.querySelector<HTMLElement>('#gb-body')!.tabIndex).toBe(0);
  });

  test('a centred modal whose title is no heading is named by its label', async () => {
    const top = (): HTMLElement =>
      [...document.querySelectorAll<HTMLElement>('#ui-overlay > [role=dialog]')].at(-1)!;
    ui.showReceipt([]);
    await tick();
    expect(top().getAttribute('aria-label')).toBe('Coin history');
    ui.closeReceipt();
    ui.showVaultPanel(12, 3, 5, { deposit: () => {}, withdraw: () => {} });
    await tick();
    expect(top().getAttribute('aria-label')).toBe('Island Bank');
    ui.closeVaultPanel();
    ui.showBuildChooser([], { timber: 0, coins: 0, built: 0, cap: 3 }, () => {});
    await tick();
    expect(top().getAttribute('aria-label')).toBe('Raise a structure');
    ui.panels.closeAll();
    ui.showBuildOptions({ icon: '🛖', name: 'hut', timber: 4 }, () => {});
    await tick();
    expect(top().getAttribute('aria-label')).toBe('Your hut');
  });

  test('the volume slider keeps its arrow keys', () => {
    const slider = document.querySelector<HTMLInputElement>('input[type=range]')!;
    const seen: string[] = [];
    const onWindow = (e: KeyboardEvent): void => {
      seen.push(e.key);
    };
    window.addEventListener('keydown', onWindow);
    try {
      for (const k of ['ArrowLeft', 'ArrowRight', 'Home', 'End']) key(k, slider);
      key('Escape', slider);
      expect(seen).toEqual(['Escape']);
    } finally {
      window.removeEventListener('keydown', onWindow);
    }
  });
});

describe('the drawer waits for the keyboard', () => {
  beforeEach(() => {
    ui.dispose(); // the desktop one: its window listeners must not outlive it
    history.replaceState(null, '', '/?touch=1'); // ?touch selects the phone scheme
    document.body.innerHTML = '<div id="ui-overlay"></div>';
    ui = new SimpleUI('ui-overlay');
  });

  test('it stays open 20 s while focus moves through it, then idles shut', () => {
    vi.useFakeTimers();
    const toggle = chip('Open island menu');
    toggle.click();
    const list = document.getElementById('ds-drawer')!;
    expect(list.style.display).toBe('flex');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const rows = [...list.querySelectorAll<HTMLElement>('.hud-btn')];
    for (let s = 0; s < 20; s += 4) {
      rows[(s / 4) % rows.length].focus();
      vi.advanceTimersByTime(4000);
      expect(list.style.display, `${s + 4} s`).toBe('flex');
    }
    vi.advanceTimersByTime(30_000); // focus still inside: it waits
    expect(list.style.display).toBe('flex');
    (document.activeElement as HTMLElement).blur();
    vi.advanceTimersByTime(8100);
    expect(list.style.display).toBe('none');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
  });
});

describe('the NPC chat: named buttons, 44 px thumb targets on touch', () => {
  const chatParts = (): Record<string, HTMLElement> => {
    const panel = document.querySelector<HTMLElement>('[role="log"]')!.parentElement!;
    return {
      close: chip('Close chat'),
      voice: chip('NPC voice'),
      mic: panel.querySelector<HTMLElement>('[title="Talk to this character"]')!,
      input: panel.querySelector<HTMLElement>('input[type=text]')!,
      send: [...panel.querySelectorAll<HTMLElement>('button')].find(
        (b) => b.textContent === 'Send',
      )!,
    };
  };
  beforeEach(() => {
    // The voice toggle and the mic exist only where the browser can speak
    // and listen.
    vi.stubGlobal('speechSynthesis', { speak() {}, cancel() {}, getVoices: () => [] });
    vi.stubGlobal('SpeechSynthesisUtterance', class {});
    vi.stubGlobal('webkitSpeechRecognition', class {});
  });
  afterEach(() => {
    ui.closeNpcChat();
    vi.unstubAllGlobals();
  });

  test('on touch the ✕, the voice toggle, the mic, the field and Send are 44 px boxes', () => {
    ui.dispose(); // the desktop one: its window listeners must not outlive it
    history.replaceState(null, '', '/?touch=1'); // ?touch selects the phone scheme
    document.body.innerHTML = '<div id="ui-overlay"></div>';
    ui = new SimpleUI('ui-overlay');
    ui.showNpcChat('Gardener', 'Morning!', async () => 'Hello.');
    const { close, voice, mic, input, send } = chatParts();
    for (const b of [close, voice]) {
      expect(b.tagName).toBe('BUTTON'); // a name, a role and the keyboard come with it
      expect(b.style.minWidth).toBe('44px');
      expect(b.style.minHeight).toBe('44px');
      expect(b.style.boxSizing).toBe('border-box');
      // Inside the panel's clip: the old -13px top margin lost the box's top 5 px.
      expect(b.style.marginTop).toBe('-8px');
    }
    for (const el of [mic, input, send]) {
      expect(el.style.minHeight).toBe('44px');
      expect(el.style.boxSizing).toBe('border-box');
    }
    expect(mic.style.minWidth).toBe('44px');
  });

  test('on desktop the header keeps its look; the voice toggle says whether it is on', () => {
    ui.showNpcChat('Gardener', 'Morning!', async () => 'Hello.');
    const { close, voice, input } = chatParts();
    expect(close.tagName).toBe('BUTTON');
    expect([close.style.padding, close.style.margin]).toEqual(['13px', '-13px']);
    expect(close.style.minWidth).toBe('');
    expect(input.style.minHeight).toBe('');
    const was = voice.getAttribute('aria-pressed');
    expect(['true', 'false']).toContain(was);
    voice.click();
    expect(voice.getAttribute('aria-pressed')).toBe(was === 'true' ? 'false' : 'true');
    voice.click(); // back as it was (the choice persists)
    expect(voice.getAttribute('aria-pressed')).toBe(was);
  });
});

describe('UX-15: the name prompt, the swatches, the emote wheel and the map legend', () => {
  test('the name prompt is a named dialog with a labelled field and an alert', () => {
    ui.promptName('', () => {});
    const dialog = document.querySelector<HTMLElement>('[aria-labelledby="ds-name-title"]')!;
    expect(dialog.getAttribute('role')).toBe('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    const input = document.getElementById('ds-name-input') as HTMLInputElement;
    expect(document.querySelector(`label[for="${input.id}"]`)!.textContent).toContain(
      'What should other visitors call you?',
    );
    expect(dialog.querySelector('[role=alert]')).not.toBeNull();
    const skip = [...dialog.querySelectorAll('button')].find((b) =>
      b.textContent!.startsWith('Skip'),
    )!;
    expect(skip.style.minHeight).toBe('44px');
  });

  test('swatches are named, pressed in place, and keep focus', () => {
    const picked: Array<[string, number]> = [];
    ui.showCustomize({
      colors: {},
      ownedHats: [],
      equippedHat: null,
      hats: [],
      onColor: (part, hex) => picked.push([part, hex]),
      onHat: () => {},
    });
    const mustard = document.querySelector<HTMLElement>('[aria-label="Outfit: mustard"]')!;
    const blue = document.querySelector<HTMLElement>('[aria-label="Outfit: blue"]')!;
    expect(mustard.style.width).toBe('32px');
    blue.focus();
    blue.click();
    expect(picked).toEqual([['outfit', 0x4a90e2]]);
    expect(blue.getAttribute('aria-pressed')).toBe('true');
    expect(mustard.getAttribute('aria-pressed')).toBe('false');
    expect(blue.isConnected).toBe(true); // not re-rendered...
    expect(document.activeElement).toBe(blue); // ...so focus stayed
    ui.hideCustomize();
  });

  test('the emote wheel is a menu that takes focus and walks with the arrows', async () => {
    const face = chip('Send an emote');
    face.focus();
    key('Enter', face);
    await tick();
    const menu = document.querySelector<HTMLElement>('[role=menu]')!;
    const items = [...menu.querySelectorAll<HTMLElement>('[role=menuitem]')];
    expect(items).toHaveLength(8);
    expect(document.activeElement).toBe(items[0]);
    key('ArrowRight', items[0]);
    expect(document.activeElement).toBe(items[1]);
    key('ArrowDown', items[1]);
    expect(document.activeElement).toBe(items[5]);
    key('Escape');
    expect(ui.panels.isOpen('emote-wheel')).toBe(false);
    expect(document.activeElement).toBe(face);
  });

  test('the map canvas is hidden from screen readers; repeats share one legend chip', () => {
    // happy-dom has no 2D canvas: a context that accepts every call.
    const ctx2d = new Proxy({}, { get: () => () => {}, set: () => true });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
      ctx2d as unknown as CanvasRenderingContext2D,
    );
    const at = (x: number): { x: number; y: number; z: number } => ({ x, y: 90, z: 10 });
    const picks: string[] = [];
    ui.showIslandMap(
      [
        { icon: '⛏️', label: 'Ore vein', pos: at(30) },
        { icon: '⛏️', label: 'Ore vein', pos: at(2) },
        { icon: '⛏️', label: 'Ore vein', pos: at(40) },
        { icon: '🛒', label: 'Shop kiosk', pos: at(5) },
      ],
      (poi) => picks.push(`${poi.label}@${poi.pos.x}`),
      { playerPos: at(0) },
    );
    expect(document.querySelector('canvas')!.getAttribute('aria-hidden')).toBe('true');
    const chips = [...document.querySelectorAll<HTMLElement>('#ui-overlay button')].filter((b) =>
      /Ore|Shop/.test(b.textContent ?? ''),
    );
    expect(chips.map((c) => c.textContent)).toEqual(['⛏️ Ore veins (3)', '🛒 Shop kiosk']);
    expect(chips[0].style.minHeight).toBe('36px');
    chips[0].click();
    expect(picks).toEqual(['Ore vein@2']); // the nearest of the three
  });
});

// D8: one reference for every control, a "Things to do" list that points the
// compass, and the settings the input layer reads. Opened by ? or H, from the
// Portfolio menu, from the phone drawer and from a strip on both welcome
// cards. What needs layout (two columns at 520 px, axe at 1440 and 390) is
// the probes' job.
describe('the Controls & settings sheet (D8)', () => {
  const sheet = (): HTMLElement | null => document.querySelector<HTMLElement>('.ds-controls');
  const opened = (): unknown[] =>
    (window.__analyticsLog ?? []).filter((e) => e.name === 'controls_opened').map((e) => e.props);
  const txt = (el: Element | null | undefined): string =>
    (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
  const rowsOf = (scheme: 'keys' | 'touch'): Record<string, string> =>
    Object.fromEntries(
      [...sheet()!.querySelectorAll(`[data-scheme-rows="${scheme}"] dl > div`)].map((d) => [
        txt(d.querySelector('dt')),
        txt(d.querySelector('dd')),
      ]),
    );
  const touchUi = (): void => {
    ui.dispose();
    history.replaceState(null, '', '/?touch=1'); // ?touch selects the phone scheme
    document.body.innerHTML = '<div id="ui-overlay"></div>';
    ui = new SimpleUI('ui-overlay');
  };

  afterEach(() => {
    document.documentElement.removeAttribute('data-run-key');
  });

  test('Shift+/ and H open it; Escape closes it and focus returns to the opener', async () => {
    const pill = chip('Open portfolio menu');
    pill.focus();
    key('?', pill, { shiftKey: true });
    await tick();
    expect(ui.panels.current()).toBe('controls');
    const el = sheet()!;
    expect(el.getAttribute('role')).toBe('dialog');
    expect(el.getAttribute('aria-modal')).toBe('true');
    expect(txt(el.querySelector('h2'))).toBe('Controls & settings');
    expect(document.activeElement).toBe(el.querySelector('h2'));
    key('Escape');
    expect(ui.panels.current()).toBeNull();
    expect(sheet()).toBeNull();
    expect(document.activeElement).toBe(pill);
    key('h', pill);
    await tick();
    expect(ui.panels.current()).toBe('controls');
    key('H', document.body); // the same key closes it again
    expect(ui.panels.current()).toBeNull();
    expect(opened()).toEqual([{ source: 'key' }, { source: 'key' }]);
  });

  test('typing never opens it, and neither does a key held with Ctrl, Alt or Meta', async () => {
    ui.showZonePanel({ id: 'contact', name: 'contact' }, { source: 'menu' });
    await tick();
    const field = document.querySelector<HTMLInputElement>('#lead-name')!;
    field.focus();
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'h', bubbles: true }));
    field.dispatchEvent(new KeyboardEvent('keydown', { key: '?', bubbles: true }));
    expect(ui.panels.current()).toBe('zone');
    // ...and not over a panel either, from anywhere in it: the hall keeps its place.
    key('?', document.body);
    expect(ui.panels.current()).toBe('zone');
    ui.hideZonePanel();
    for (const mod of [{ ctrlKey: true }, { altKey: true }, { metaKey: true }]) {
      key('h', document.body, mod);
      expect(ui.panels.current(), JSON.stringify(mod)).toBeNull();
    }
    ui.openChatInput();
    const chat = document.querySelector<HTMLInputElement>('#ui-overlay input')!;
    chat.dispatchEvent(new KeyboardEvent('keydown', { key: 'h', bubbles: true }));
    expect(ui.panels.isOpen('controls')).toBe(false);
  });

  test('the Portfolio menu lists Controls, and the row opens the sheet', async () => {
    chip('Open portfolio menu').click();
    await tick();
    const row = document.querySelector<HTMLButtonElement>('button[data-controls]')!;
    expect(txt(row)).toBe('⌨️ Controls & settings');
    row.click();
    await tick();
    expect(ui.panels.current()).toBe('controls');
    expect(document.querySelector('#ds-portfolio-menu-title')).toBeNull(); // the menu gave way
    expect(opened()).toEqual([{ source: 'menu' }]);
  });

  test('the phone drawer lists Controls, last, after the ten rows that were there', async () => {
    touchUi();
    chip('Open island menu').click();
    const list = document.getElementById('ds-drawer')!;
    const row = list.querySelector<HTMLElement>('[data-controls-row]')!;
    expect(txt(row)).toBe('⌨️ Controls & settings');
    expect(row.style.order).toBe('11');
    // Work with me keeps slot #1 (Abbas's ruling), and no two rows share an order.
    const orders = [...list.children].map((c) => (c as HTMLElement).style.order);
    expect(new Set(orders).size).toBe(orders.length);
    const first = [...list.children].find((c) => (c as HTMLElement).style.order === '1');
    expect(txt(first)).toContain('Work with me');
    row.click();
    await tick();
    expect(ui.panels.current()).toBe('controls');
    expect(opened()).toEqual([{ source: 'drawer' }]);
    // A phone opens on the Touch rows, and names no keys in Things to do.
    expect(rowsOf('touch').Move).toContain('joystick');
    expect(sheet()!.querySelector<HTMLElement>('[data-scheme-rows="keys"]')!.hidden).toBe(true);
    const todo = txt(sheet()!.querySelector('.ds-controls-todo'));
    expect(todo).not.toMatch(/press [EFG]\b/i);
    expect(todo).toContain('tap 🌾 FEED');
    expect(todo).toContain('Tap 👆 USE to collect it');
  });

  test('desktop gets no chip of its own for it', () => {
    expect(document.querySelector('[data-controls-row]')).toBeNull();
  });

  describe('from the welcome card', () => {
    test('both cards carry a 13 px strip, a link and not a fifth button', () => {
      for (const returning of [false, true]) {
        if (returning) localStorage.setItem('ds_welcomed', '1');
        ui.showWelcome(null);
        const strip = document.querySelector<HTMLElement>('[data-controls-strip]')!;
        expect(parseFloat(strip.style.fontSize), `returning ${returning}`).toBeGreaterThanOrEqual(
          13,
        );
        const link = strip.querySelector<HTMLAnchorElement>('a[data-controls]')!;
        expect(txt(link)).toBe('Controls & settings');
        expect(strip.querySelector('button')).toBeNull();
        ui.hideWelcome(false);
      }
    });

    test('the card steps aside unread and comes back when the sheet closes', async () => {
      ui.showWelcome(null);
      await tick();
      document.querySelector<HTMLAnchorElement>('a[data-controls]')!.click();
      await tick();
      expect(ui.panels.current()).toBe('controls');
      expect(
        document.querySelector('[aria-label="Welcome to DigiScalability Life Island"]'),
      ).toBeNull();
      expect(ui.isWelcomeVisible()).toBe(true); // parked: the world still waits for it
      expect(localStorage.getItem('ds_welcomed')).toBeNull(); // and nothing was burned
      key('Escape');
      await tick();
      await tick();
      expect(ui.panels.current()).toBe('welcome');
      const card = document.querySelector<HTMLElement>(
        '[aria-label="Welcome to DigiScalability Life Island"]',
      )!;
      expect(card.querySelector('button[data-dismiss]')).not.toBeNull();
      expect(localStorage.getItem('ds_welcomed')).toBeNull();
      expect(opened()).toEqual([{ source: 'welcome' }]);
      // Explore still closes it for good.
      card.querySelector<HTMLButtonElement>('button[data-dismiss]')!.click();
      expect(ui.isWelcomeVisible()).toBe(false);
      expect(localStorage.getItem('ds_welcomed')).toBe('1');
    });

    test('? while the card is up does the same; the × brings the card back too', async () => {
      ui.showWelcome(null);
      await tick();
      key('?', document.body, { shiftKey: true });
      await tick();
      expect(ui.panels.current()).toBe('controls');
      sheet()!.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.click();
      await tick();
      await tick();
      expect(ui.panels.current()).toBe('welcome');
      expect(opened()).toEqual([{ source: 'welcome' }]);
    });
  });

  describe('the keyboard rows', () => {
    test('every binding the README lists, and this sheet', async () => {
      ui.showControls('key');
      await tick();
      const rows = rowsOf('keys');
      expect(Object.keys(rows)).toEqual([
        'Move',
        'Look',
        'Run',
        'Jump',
        'Dive',
        'Use',
        'Wave',
        'Map',
        'Feed',
        'Eat',
        'Chat',
        'Talk aloud',
        'Photo',
        'Appearance',
        'Close',
        'This sheet',
      ]);
      expect(rows.Look).toBe('drag with the mouse · J L turn · I K tilt · R recentre');
      expect(rows.Use).toMatch(/^E\b/);
      expect(rows['Talk aloud']).toBe('hold V');
      expect(rows['This sheet']).toBe('? or H');
      expect(rows.Look).not.toMatch(/mouse to look|click/i);
    });

    test('before A11 (no html[data-run-key]): run is Space, and there is no zoom row', async () => {
      ui.showControls('key');
      await tick();
      const rows = rowsOf('keys');
      expect(rows.Run).toBe('hold Space while moving');
      expect(rows.Zoom).toBeUndefined();
    });

    test("with html[data-run-key='shift']: run is Shift, and the zoom row shows", async () => {
      document.documentElement.setAttribute('data-run-key', 'shift');
      ui.showControls('key');
      await tick();
      const rows = rowsOf('keys');
      expect(rows.Run).toBe('hold Shift while moving');
      expect(rows.Zoom).toBe('mouse wheel, or = and −');
    });

    test('the segmented switch shows Keyboard & mouse or Touch', async () => {
      ui.showControls('key');
      await tick();
      const [keys, touch] = [
        ...sheet()!.querySelectorAll<HTMLButtonElement>('button[data-scheme]'),
      ];
      expect([txt(keys), txt(touch)]).toEqual(['Keyboard & mouse', 'Touch']);
      expect(keys.getAttribute('aria-pressed')).toBe('true');
      touch.click();
      expect(touch.getAttribute('aria-pressed')).toBe('true');
      expect(keys.getAttribute('aria-pressed')).toBe('false');
      expect(sheet()!.querySelector<HTMLElement>('[data-scheme-rows="touch"]')!.hidden).toBe(false);
      expect(sheet()!.querySelector<HTMLElement>('[data-scheme-rows="keys"]')!.hidden).toBe(true);
      expect(rowsOf('touch').Look).toBe('swipe anywhere on the world');
    });
  });

  describe('the tabs', () => {
    test('three tabs with a roving tabindex; ←/→, Home and End move between them', async () => {
      ui.showControls('key');
      await tick();
      const tabs = [...sheet()!.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
      expect(tabs.map((t) => txt(t))).toEqual(['Controls', 'Things to do', 'Settings']);
      const selected = (): string[] => tabs.map((t) => t.getAttribute('aria-selected')!);
      const panelOf = (t: HTMLElement): HTMLElement =>
        document.getElementById(t.getAttribute('aria-controls')!)!;
      expect(selected()).toEqual(['true', 'false', 'false']);
      for (const t of tabs) {
        expect(panelOf(t).getAttribute('role')).toBe('tabpanel');
        expect(panelOf(t).getAttribute('aria-labelledby')).toBe(t.id);
      }
      tabs[0].focus();
      key('ArrowRight', tabs[0]);
      expect(selected()).toEqual(['false', 'true', 'false']);
      expect(document.activeElement).toBe(tabs[1]);
      expect(tabs.map((t) => t.tabIndex)).toEqual([-1, 0, -1]);
      expect(panelOf(tabs[0]).hidden).toBe(true);
      expect(panelOf(tabs[1]).hidden).toBe(false);
      key('End', tabs[1]);
      expect(document.activeElement).toBe(tabs[2]);
      key('ArrowRight', tabs[2]); // wraps
      expect(document.activeElement).toBe(tabs[0]);
      key('ArrowLeft', tabs[0]);
      expect(document.activeElement).toBe(tabs[2]);
      key('Home', tabs[2]);
      expect(selected()).toEqual(['true', 'false', 'false']);
      tabs[2].click();
      expect(panelOf(tabs[2]).hidden).toBe(false);
    });

    test('showControls(source, tab) opens on that tab', async () => {
      ui.showControls('menu', 'todo');
      await tick();
      expect(
        sheet()!.querySelector('[role="tab"][aria-selected="true"]')!.getAttribute('data-tab'),
      ).toBe('todo');
      expect(document.getElementById('ds-ctl-panel-controls')!.hidden).toBe(true);
    });
  });

  describe('Things to do', () => {
    const items = (): HTMLElement[] => [
      ...sheet()!.querySelectorAll<HTMLElement>('.ds-controls-todo li'),
    ];

    test('one line per system: eight or more, each with what to do', async () => {
      ui.showControls('menu', 'todo');
      await tick();
      const titles = items().map((li) => txt(li.querySelector('strong')));
      expect(titles.length).toBeGreaterThanOrEqual(8);
      for (const want of [
        'Fishing',
        'Chopping',
        'Feeding birds',
        'Eating',
        'Building',
        'Races',
        'Deliveries',
        'The School’s lessons',
        'The shop',
        'Passport stamps',
      ]) {
        expect(
          titles.some((t) => t.endsWith(want)),
          want,
        ).toBe(true);
      }
      for (const li of items()) {
        expect(txt(li.querySelector('.ds-controls-todo-text > span')).length).toBeGreaterThan(20);
      }
      // No counts typed, and villagers are never agents (the Fact Sheet).
      expect(txt(sheet()!.querySelector('.ds-controls-todo'))).not.toMatch(
        /\b\d+\b|agent|live AI/i,
      );
    });

    test("each Show me dispatches 'ds:guide-to' {key, source:'controls'} and closes the sheet", async () => {
      const seen: Array<{ key: string; source: string }> = [];
      const on = (e: Event): void => void seen.push((e as CustomEvent).detail);
      window.addEventListener('ds:guide-to', on);
      try {
        ui.showControls('menu', 'todo');
        await tick();
        const keys = [...sheet()!.querySelectorAll<HTMLButtonElement>('button[data-show-me]')].map(
          (b) => b.dataset.showMe!,
        );
        expect(keys).toEqual([
          'shore',
          'carpenter',
          'stake:nearest',
          'race:land',
          'mailbox:next',
          'school',
          'kiosk',
          'district:professional', // the first stamp still missing
          'beach-house', // P2-D9
        ]);
        for (const k of keys) {
          if (!sheet()) {
            ui.showControls('menu', 'todo');
            await tick();
          }
          sheet()!.querySelector<HTMLButtonElement>(`button[data-show-me="${k}"]`)!.click();
          expect(ui.panels.current(), k).toBeNull();
          expect(sheet(), k).toBeNull();
        }
        expect(seen).toEqual(keys.map((k) => ({ key: k, source: 'controls' })));
      } finally {
        window.removeEventListener('ds:guide-to', on);
      }
    });

    test('the passport row points at the next stamp still missing, and drops Show me when complete', async () => {
      localStorage.setItem('ds_passport', JSON.stringify(['professional', 'projects']));
      ui.setPassport(new Passport());
      ui.showControls('menu', 'todo');
      await tick();
      const row = items().find((li) => txt(li).includes('Passport stamps'))!;
      expect(row.querySelector<HTMLButtonElement>('button')!.dataset.showMe).toBe(
        'district:personal',
      );
      ui.panels.closeAll();
      localStorage.setItem(
        'ds_passport',
        JSON.stringify(['professional', 'projects', 'personal', 'contact']),
      );
      ui.setPassport(new Passport());
      ui.showControls('menu', 'todo');
      await tick();
      const done = items().find((li) => txt(li).includes('Passport stamps'))!;
      expect(done.querySelector('button')).toBeNull();
    });

    test('Show me from a sheet opened over the welcome card brings the card back, compass set', async () => {
      const seen: unknown[] = [];
      const on = (e: Event): void => void seen.push((e as CustomEvent).detail);
      window.addEventListener('ds:guide-to', on);
      try {
        ui.showWelcome(null);
        await tick();
        ui.showControls('welcome', 'todo');
        await tick();
        sheet()!.querySelector<HTMLButtonElement>('button[data-show-me="kiosk"]')!.click();
        await tick();
        await tick();
        expect(seen).toEqual([{ key: 'kiosk', source: 'controls' }]);
        expect(ui.panels.current()).toBe('welcome');
        expect(localStorage.getItem('ds_welcomed')).toBeNull();
      } finally {
        window.removeEventListener('ds:guide-to', on);
      }
    });
  });

  describe('Settings', () => {
    let settings: string[] = [];
    const onSetting = (e: Event): void =>
      void settings.push((e as CustomEvent<{ key: string }>).detail.key);
    beforeEach(() => {
      settings = [];
      window.addEventListener('ds:settings', onSetting);
    });
    afterEach(() => window.removeEventListener('ds:settings', onSetting));

    test('look sensitivity writes ds_look_sens, clamped to 0.5–2, then says so', async () => {
      ui.showControls('menu', 'settings');
      await tick();
      const range = document.querySelector<HTMLInputElement>('#ds-set-sens')!;
      expect(range.getAttribute('min')).toBe('0.5');
      expect(range.getAttribute('max')).toBe('2');
      expect(range.value).toBe('1');
      expect(document.querySelector('label[for="ds-set-sens"]')).not.toBeNull();
      range.value = '2';
      range.dispatchEvent(new Event('input', { bubbles: true }));
      expect(localStorage.getItem('ds_look_sens')).toBe('2');
      expect(txt(document.querySelector('output[for="ds-set-sens"]'))).toBe('2.0×');
      expect(settings).toEqual(['ds_look_sens']);
      // The slider's arrow keys stay with the slider.
      const arrow = new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true });
      const leaked = vi.fn();
      document.addEventListener('keydown', leaked);
      range.dispatchEvent(arrow);
      document.removeEventListener('keydown', leaked);
      expect(leaked).not.toHaveBeenCalled();
      // ...but Escape on the slider still closes the sheet (a blanket stop
      // on its keydown left the key dead while the slider had focus).
      range.focus();
      key('Escape', range);
      expect(ui.panels.current()).toBeNull();
      // Reopened, it shows what was saved.
      ui.showControls('menu', 'settings');
      await tick();
      expect(document.querySelector<HTMLInputElement>('#ds-set-sens')!.value).toBe('2');
    });

    test('invert and mouse lock write their keys as 1 or 0, each with its event', async () => {
      ui.showControls('menu', 'settings');
      await tick();
      const invert = document.querySelector<HTMLInputElement>('#ds-set-invert')!;
      const lock = document.querySelector<HTMLInputElement>('#ds-set-lock')!;
      expect(invert.checked).toBe(false);
      expect(lock.checked).toBe(false);
      invert.click();
      lock.click();
      expect(localStorage.getItem('ds_look_invert')).toBe('1');
      expect(localStorage.getItem('ds_mouse_lock')).toBe('1');
      lock.click();
      expect(localStorage.getItem('ds_mouse_lock')).toBe('0');
      expect(settings).toEqual(['ds_look_invert', 'ds_mouse_lock', 'ds_mouse_lock']);
      // Desktop has no vibration to switch.
      expect(document.querySelector('#ds-set-haptics')).toBeNull();
    });

    test('touch: haptics is a switch, and mouse lock is not offered', async () => {
      touchUi();
      ui.showControls('drawer', 'settings');
      await tick();
      expect(document.querySelector('#ds-set-lock')).toBeNull();
      const haptics = document.querySelector<HTMLInputElement>('#ds-set-haptics')!;
      expect(haptics.checked).toBe(true); // the default with motion allowed
      haptics.click();
      expect(localStorage.getItem('ds_haptics')).toBe('0');
      expect(settings).toEqual(['ds_haptics']);
    });

    test('hapticPulse follows the setting, with the old reduced-motion gate as its default', () => {
      const vibrate = vi.fn();
      Object.defineProperty(navigator, 'vibrate', { value: vibrate, configurable: true });
      const was = a11y.reducedMotion;
      try {
        a11y.reducedMotion = false;
        expect(hapticsEnabled()).toBe(true);
        hapticPulse(8);
        expect(vibrate).toHaveBeenCalledTimes(1);
        localStorage.setItem('ds_haptics', '0');
        hapticPulse(8);
        expect(vibrate).toHaveBeenCalledTimes(1); // switched off
        a11y.reducedMotion = true;
        localStorage.removeItem('ds_haptics');
        expect(hapticsEnabled()).toBe(false); // unset: reduced motion keeps it off, as before
        hapticPulse(8);
        expect(vibrate).toHaveBeenCalledTimes(1);
        localStorage.setItem('ds_haptics', '1'); // ...and can now turn it on: a buzz is not motion
        hapticPulse(8);
        expect(vibrate).toHaveBeenCalledTimes(2);
      } finally {
        a11y.reducedMotion = was;
        Reflect.deleteProperty(navigator, 'vibrate');
      }
    });
  });

  test("index.html's dead #controls-guide CSS is gone; the sheet's keycaps live in style.css", () => {
    // (securityHeaders holds the inline-script count: this was style only.)
    expect(readFileSync(join(process.cwd(), 'index.html'), 'utf8')).not.toContain('controls-guide');
    expect(readFileSync(join(process.cwd(), 'style.css'), 'utf8')).toContain('.ds-controls kbd');
  });
});

// P2-D2 (INT-07, INT-12): inside a building, Leave is a real button, the HUD
// steps aside and the room is announced. It was a div only a mouse could
// use, it sat on top of the weather chip, and nothing told a screen-reader
// user they had gone indoors. Pixel overlap and the Tab count in a real
// browser are the probes' (p2/room-a11y, p2/room-phone).
describe('inside a building: the Leave button, the interior mode, the announcement (P2-D2)', () => {
  const leave = (): HTMLButtonElement | null =>
    document.querySelector<HTMLButtonElement>('#ui-overlay > button[data-leave]');
  const live = (): string =>
    (document.querySelector('#ui-overlay > .ds-sr-only[role="status"]')?.textContent ?? '').trim();
  /** The visitor's last real input, as the trusted listeners would record it
   *  (happy-dom's dispatched events are never trusted). */
  const lastInput = (kind: 'keyboard' | 'pointer'): void => {
    (ui as unknown as { lastInput: string }).lastInput = kind;
  };
  const touchUi = (): void => {
    ui.dispose();
    history.replaceState(null, '', '/?touch=1'); // ?touch selects the phone scheme
    document.body.innerHTML = '<div id="ui-overlay"></div>';
    ui = new SimpleUI('ui-overlay');
  };

  test('a <button type=button> reading "← Leave", named for the building, 44 px, first in the overlay', () => {
    const onLeave = vi.fn();
    ui.showLeaveButton(onLeave, 'Project Portfolio');
    const b = leave()!;
    expect(b.tagName).toBe('BUTTON');
    expect(b.getAttribute('type')).toBe('button');
    expect(b.textContent).toBe('← Leave');
    expect(b.getAttribute('aria-label')).toBe('Leave Project Portfolio');
    expect(b.style.minHeight).toBe('44px');
    expect(ui.getOverlay().firstElementChild).toBe(b); // the first Tab from the room
    expect(b.hasAttribute('data-never-inert')).toBe(true);
    b.click();
    expect(onLeave).toHaveBeenCalledTimes(1);
  });

  test("with no name it is 'Leave the building'; a hall's own panel names it", async () => {
    ui.showLeaveButton(() => {});
    expect(leave()!.getAttribute('aria-label')).toBe('Leave the building');
    // main-simple opens the hall's panel right after, in the same task.
    ui.showZonePanel({ id: 'projects', name: 'Project Portfolio' }, { source: 'proximity' });
    expect(leave()!.getAttribute('aria-label')).toBe('Leave Project Portfolio');
    await tick();
    expect(live()).toBe('Inside Project Portfolio. Press Escape or walk to the door to leave.');
    // A panel opened from the menu while indoors names nothing.
    ui.showZonePanel({ id: 'contact', name: 'contact' }, { source: 'menu' });
    expect(leave()!.getAttribute('aria-label')).toBe('Leave Project Portfolio');
  });

  test('a name given by the caller wins over the panel', () => {
    ui.showLeaveButton(() => {}, "Brother's Beach House");
    ui.showZonePanel({ id: 'projects', name: 'Project Portfolio' }, { source: 'proximity' });
    expect(leave()!.getAttribute('aria-label')).toBe("Leave Brother's Beach House");
  });

  test('the live region announces the room once per entry', async () => {
    ui.showLeaveButton(() => {}, 'A cosy home');
    await tick();
    expect(live()).toBe('Inside A cosy home. Press Escape or walk to the door to leave.');
    const region = document.querySelector('#ui-overlay > .ds-sr-only[role="status"]')!;
    const writes: string[] = [];
    const mo = new MutationObserver(() => writes.push(region.textContent ?? ''));
    mo.observe(region, { childList: true, characterData: true, subtree: true });
    // Panels opening and closing inside the room say nothing more about it.
    ui.showZonePanel({ id: 'projects', name: 'Project Portfolio' }, { source: 'proximity' });
    await tick();
    ui.hideZonePanel();
    await tick();
    mo.disconnect();
    expect(writes.filter((w) => w.startsWith('Inside'))).toEqual([]);
    // The next entry is announced again.
    ui.hideLeaveButton();
    ui.showLeaveButton(() => {}, 'Get In Touch');
    await tick();
    expect(live()).toBe('Inside Get In Touch. Press Escape or walk to the door to leave.');
  });

  test('the room line is heard out: a compass change right behind it waits its turn', async () => {
    // Entering a hall stamps the passport and the compass retargets: in the
    // browser 'Compass: Personal' replaced the room line 15 ms after it was
    // written.
    vi.useFakeTimers();
    ui.showLeaveButton(() => {}, 'Project Portfolio');
    await vi.advanceTimersByTimeAsync(0);
    const room = 'Inside Project Portfolio. Press Escape or walk to the door to leave.';
    expect(live()).toBe(room);
    const state = (label: string): { angleRad: number; distance: number; label: string } => ({
      label,
      distance: 40,
      angleRad: 0,
    });
    ui.updateQuestCompass(state('🎨 Personal'));
    await vi.advanceTimersByTimeAsync(15);
    expect(live()).toBe(room);
    ui.updateQuestCompass(state('📬 Contact')); // the latest target is the one said next
    await vi.advanceTimersByTimeAsync(2400);
    expect(live()).toBe(room);
    await vi.advanceTimersByTimeAsync(200);
    expect(live()).toBe('Compass: 📬 Contact');
    // Outdoors again, nothing is held back.
    ui.hideLeaveButton();
    ui.updateQuestCompass(state('🚀 Projects'));
    expect(live()).toBe('Compass: 🚀 Projects');
  });

  test('on touch it says Tap Leave', async () => {
    touchUi();
    ui.showLeaveButton(() => {});
    await tick();
    expect(live()).toBe('Inside the building. Tap Leave or walk to the door to leave.');
  });

  test('it takes focus on a keyboard entry, never on a pointer one; focus goes back to the body on exit', () => {
    lastInput('pointer');
    ui.showLeaveButton(() => {});
    expect(document.activeElement).not.toBe(leave());
    ui.hideLeaveButton();
    lastInput('keyboard');
    ui.showLeaveButton(() => {});
    expect(document.activeElement).toBe(leave());
    ui.hideLeaveButton();
    expect(leave()).toBeNull();
    expect(document.activeElement === document.body || document.activeElement === null).toBe(true);
  });

  test('a keyboard entry into a hall: the panel takes focus, and closing it puts focus on Leave', async () => {
    lastInput('keyboard');
    // The world opened the door on a key: PanelManager's modality says so.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'e', bubbles: true }));
    ui.showLeaveButton(() => {});
    ui.showZonePanel({ id: 'projects', name: 'Project Portfolio' }, { source: 'proximity' });
    await tick();
    expect(document.activeElement).toBe(document.querySelector('#ds-zone-title'));
    expect(leave()!.hasAttribute('inert')).toBe(false); // still a click away over the panel
    key('Escape');
    expect(ui.panels.current()).toBeNull();
    expect(document.activeElement).toBe(leave());
  });

  describe("the 'interior' mode", () => {
    test('touch: the ambient info and the outdoor actions go; USE, the joystick, chat, the mic and ☰ stay', async () => {
      touchUi();
      ui.setEnvironmentBadge('☀️ Day');
      const btn = (caption: string): HTMLElement =>
        [...document.querySelectorAll<HTMLElement>('#ui-overlay > div')].find(
          (d) => d.children.length === 2 && d.children[1].textContent === caption,
        )!;
      const shown = (el: HTMLElement): boolean => el.style.display !== 'none';
      const joystick =
        document.querySelector<HTMLElement>('[data-guide="joystick"]')!.parentElement!;
      const badge = [...document.querySelectorAll<HTMLElement>('#ui-overlay > div')].find((d) =>
        (d.textContent ?? '').includes('Day'),
      )!;
      const all = ['USE', 'JUMP', 'WAVE', 'DIVE', 'FEED', 'EAT'].map(btn);
      expect(all.every(shown)).toBe(true);
      ui.showLeaveButton(() => {});
      expect(ui.panels.inMode('interior')).toBe(true);
      expect(['USE', 'JUMP', 'WAVE', 'DIVE', 'FEED', 'EAT'].filter((c) => shown(btn(c)))).toEqual([
        'USE',
      ]);
      expect(shown(joystick)).toBe(true);
      expect(shown(chip('Open chat'))).toBe(true);
      expect(shown(chip('Hold to talk to nearby players (or hold the V key)'))).toBe(true);
      expect(shown(chip('Open island menu'))).toBe(true); // it holds Work with me
      expect(shown(badge)).toBe(false);
      expect(shown(leave()!)).toBe(true);
      // A panel over the room, then gone: the mode's hides are still on.
      ui.showHireCard('cta');
      await tick();
      expect(shown(btn('USE'))).toBe(false);
      ui.hideZonePanel();
      expect(shown(btn('USE'))).toBe(true);
      expect(shown(btn('JUMP'))).toBe(false);
      expect(ui.panels.current()).toBeNull(); // a mode is not a panel
      ui.hideLeaveButton();
      expect(ui.panels.inMode('interior')).toBe(false);
      expect(all.every(shown)).toBe(true);
      expect(shown(badge)).toBe(true);
    });

    test('desktop: the weather chip is taken out, not dimmed; the Portfolio and Work-with-me pills are untouched', () => {
      ui.setEnvironmentBadge('☀️ Day');
      const badge = [...document.querySelectorAll<HTMLElement>('#ui-overlay > div')].find((d) =>
        (d.textContent ?? '').includes('Day'),
      )!;
      const portfolio = chip('Open portfolio menu');
      const work = document.querySelector<HTMLElement>('[data-cta="work-with-me"]')!;
      const before = [portfolio, work].map((el) => el.getAttribute('style'));
      const display = badge.style.display;
      ui.showLeaveButton(() => {});
      expect(badge.style.display).toBe('none');
      expect([portfolio, work].map((el) => el.getAttribute('style'))).toEqual(before);
      ui.hideLeaveButton();
      expect(badge.style.display).toBe(display);
      expect(badge.style.opacity).toBe('');
    });
  });
});

// P2-D9 (INT-10, decision P2-2): the locked beach-house door points to the
// Sailor. The pad gave no way on: a visitor without the code could only
// guess. After the first wrong code of the session one line appears under
// the pad, once; the Sailor's own line is package C's (P2-C6).
describe('the locked beach-house door points to the Sailor (P2-D9)', () => {
  const pad = (): HTMLElement => document.querySelector<HTMLElement>('[aria-label="Door code"]')!;
  const hints = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('[data-pin-hint]')];
  const type = (code: string): void => {
    for (const d of code) {
      pad().dispatchEvent(new KeyboardEvent('keydown', { key: d, bubbles: true }));
    }
  };

  test('one wrong code shows the line, once; the correct code still opens the door', async () => {
    vi.useFakeTimers();
    const onSuccess = vi.fn();
    ui.showPinPad('5673', onSuccess);
    await vi.advanceTimersByTimeAsync(0);
    expect(hints()).toHaveLength(0); // nothing before a miss
    type('1111');
    expect(hints()).toHaveLength(1);
    expect(hints()[0].textContent).toBe('Ask the Sailor at the harbour.');
    expect(hints()[0].getAttribute('role')).toBe('status');
    expect(pad().contains(hints()[0])).toBe(true);
    expect(pad().lastElementChild).toBe(hints()[0]); // under the pad
    await vi.advanceTimersByTimeAsync(400); // the shake clears the digits
    type('2222');
    await vi.advanceTimersByTimeAsync(400);
    expect(hints()).toHaveLength(1); // once, however many misses
    expect(onSuccess).not.toHaveBeenCalled();
    type('5673');
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(ui.panels.isOpen('pin-pad')).toBe(false);
  });

  test('the on-screen digits count as well as the keyboard', async () => {
    const onSuccess = vi.fn();
    ui.showPinPad('5673', onSuccess);
    await tick();
    const tap = (d: string): void =>
      [...pad().querySelectorAll<HTMLButtonElement>('button')]
        .find((b) => b.textContent === d)!
        .click();
    for (const d of '9999') tap(d);
    expect(hints()).toHaveLength(1);
  });

  test('a pad reopened later in the session carries the line from the start; a new session does not', async () => {
    ui.showPinPad('5673', () => {});
    await tick();
    type('0000');
    ui.closePinPad();
    ui.showPinPad('5673', () => {});
    await tick();
    expect(hints()).toHaveLength(1);
    ui.closePinPad();
    // A new page life: no miss yet.
    ui.dispose();
    document.body.innerHTML = '<div id="ui-overlay"></div>';
    ui = new SimpleUI('ui-overlay');
    ui.showPinPad('5673', () => {});
    await tick();
    expect(hints()).toHaveLength(0);
  });

  test('the correct code first time shows no line', async () => {
    const onSuccess = vi.fn();
    ui.showPinPad('5673', onSuccess);
    await tick();
    type('5673');
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(hints()).toHaveLength(0);
  });

  test("Things to do lists the beach house, with a Show me for 'beach-house'", async () => {
    ui.showControls('menu', 'todo');
    await tick();
    const rows = [...document.querySelectorAll<HTMLElement>('.ds-controls-todo li')];
    const row = rows.find((li) => (li.textContent ?? '').includes('The beach house'))!;
    expect(row.textContent).toContain('Visit the beach house on the islet (ask the Sailor).');
    expect(row.querySelector<HTMLButtonElement>('button')!.dataset.showMe).toBe('beach-house');
    expect(rows[rows.length - 1]).toBe(row);
  });

  test('the code itself is nowhere in the pad or the sheet', async () => {
    ui.showPinPad('5673', () => {});
    await tick();
    type('1234');
    expect(pad().textContent).not.toContain('5673');
    ui.closePinPad();
    ui.showControls('menu', 'todo');
    await tick();
    expect(document.querySelector('.ds-controls')!.textContent).not.toMatch(/\d{4}/);
  });
});
