// @vitest-environment happy-dom
//
// D4: focus that moves in, stays in and comes back; a first-run card a stray
// tap can't burn; a drawer that waits for the keyboard (FOCUS-01, UX-03,
// FM-02, FM-06, UX-15, PANEL-01). Run on a REAL SimpleUI and on PanelManager
// directly. What needs layout (ArrowDown scrolling a focused panel, small
// targets measured in pixels) is keyboard.cjs's and phone.cjs's job; these
// hold the contract that makes it work.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { type CloseReason, PanelManager, type PanelSpec } from '../PanelManager';
import { SimpleUI } from '../SimpleUI';

// The boards are Firebase reads; here they answer at once, empty.
vi.mock('../Boards', () => ({
  getLeaderboard: vi.fn(async () => []),
  getGuestbook: vi.fn(async () => []),
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
  ui.panels.dispose();
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
    const leave = [...document.querySelectorAll<HTMLElement>('#ui-overlay > div')].find(
      (d) => d.textContent === '← Leave',
    )!;
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
