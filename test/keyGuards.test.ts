// @vitest-environment happy-dom
//
// enterOpensChat decides whether a window-level Enter may open the chat input
// (main-simple's chatKeydown). It used to be a private SimpleApp method that
// only ran behind the WebGL boot, so its tests could only read source text.
// It runs for real here: Enter belongs to whatever already used it.
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  enterOpensChat,
  focusedControlOwnsKey,
  WALKABLE,
  worldInputBlocked,
  type EnterGuardUi,
} from '../keyGuards';

const enter = (init: KeyboardEventInit = {}): KeyboardEvent =>
  new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...init });

const ui = (state: { welcome?: boolean; panel?: boolean } = {}): EnterGuardUi => ({
  isWelcomeVisible: () => state.welcome ?? false,
  isPanelOpen: () => state.panel ?? false,
});

const mount = <T extends HTMLElement>(html: string): T => {
  const host = document.createElement('div');
  host.innerHTML = html;
  const el = host.firstElementChild as T;
  document.body.appendChild(el);
  return el;
};

beforeEach(() => {
  document.body.innerHTML = '';
});

afterEach(() => {
  (document.activeElement as HTMLElement | null)?.blur?.();
});

describe('Enter opens chat only from the bare world', () => {
  test('nothing focused, nothing open: chat opens', () => {
    expect(document.activeElement).toBe(document.body);
    expect(enterOpensChat(enter(), ui())).toBe(true);
  });

  test('the focused game canvas still counts as the bare world', () => {
    const canvas = mount<HTMLCanvasElement>('<canvas id="game-canvas" tabindex="0"></canvas>');
    canvas.focus();
    expect(document.activeElement).toBe(canvas);
    expect(enterOpensChat(enter(), ui())).toBe(true);
  });
});

describe('Enter stands down when something else owns it', () => {
  test('a key already handled (defaultPrevented)', () => {
    const e = enter();
    e.preventDefault();
    expect(e.defaultPrevented).toBe(true);
    expect(enterOpensChat(e, ui())).toBe(false);
  });

  test('the welcome card or name prompt is up', () => {
    expect(enterOpensChat(enter(), ui({ welcome: true }))).toBe(false);
  });

  test('a panel is open (zone panel, portfolio menu, …)', () => {
    expect(enterOpensChat(enter(), ui({ panel: true }))).toBe(false);
  });

  test('a focused button: "See the work" must open Projects only', () => {
    const btn = mount<HTMLButtonElement>('<button data-cta="projects">See the work</button>');
    btn.focus();
    expect(document.activeElement).toBe(btn);
    expect(enterOpensChat(enter(), ui())).toBe(false);
  });

  test('a focused HUD chip (role=button, tabindex=0)', () => {
    const chip = mount<HTMLDivElement>('<div role="button" tabindex="0">📖</div>');
    chip.focus();
    expect(enterOpensChat(enter(), ui())).toBe(false);
  });

  test('a focused link, field or textarea', () => {
    for (const html of [
      '<a href="https://www.linkedin.com/in/-abbas-ali">LinkedIn</a>',
      '<input id="lead-email" type="email">',
      '<textarea id="lead-msg"></textarea>',
      '<select><option>a</option></select>',
    ]) {
      const el = mount<HTMLElement>(html);
      expect(enterOpensChat(enter(), ui(), el), html).toBe(false);
    }
  });

  test('an editable region', () => {
    const div = mount<HTMLDivElement>('<div contenteditable="true"></div>');
    // happy-dom does not derive isContentEditable from the attribute; a
    // browser does. Set it the way a browser would report it.
    Object.defineProperty(div, 'isContentEditable', { value: true });
    expect(enterOpensChat(enter(), ui(), div)).toBe(false);
  });

  test('a plain, non-interactive element does not block it', () => {
    const p = mount<HTMLParagraphElement>('<p>Island Times</p>');
    expect(enterOpensChat(enter(), ui(), p)).toBe(true);
  });
});

// worldInputBlocked decides, per frame, whether the top PanelManager panel
// owns the keyboard: then main-simple zeroes movement, drops latched presses
// and drains camera input. Walkable sheets are an allow-list.
describe('the world takes input only beside a walkable panel', () => {
  test('no panel: the world has the keyboard', () => {
    expect(worldInputBlocked(null)).toBe(false);
  });

  test('the walkable sheets keep the world live', () => {
    for (const id of ['npc-chat', 'dialogue', 'chat-input', 'customize', 'tour', 'emote-wheel']) {
      expect(worldInputBlocked(id), id).toBe(false);
    }
    expect([...WALKABLE].sort()).toEqual(
      ['chat-input', 'customize', 'dialogue', 'emote-wheel', 'npc-chat', 'tour'].sort(),
    );
  });

  test('the emote wheel is walkable: W walks with it open, as it did before the allow-list (CO-A4)', () => {
    expect(WALKABLE.has('emote-wheel')).toBe(true);
    expect(worldInputBlocked('emote-wheel')).toBe(false);
  });

  test('every other panel owns the keyboard', () => {
    // The ids SimpleUI opens today: zone panels (Projects, Contact, the hire
    // card), the Portfolio menu, the phone drawer, the welcome card, the shop,
    // the interior pickers and every centred modal.
    for (const id of [
      'zone',
      'portfolio-menu',
      'drawer',
      'welcome',
      'shop',
      'watch-picker',
      'pin-pad',
      'receipt',
      'modal',
    ]) {
      expect(worldInputBlocked(id), id).toBe(true);
    }
  });

  test('a panel nobody has classified yet blocks by default', () => {
    expect(worldInputBlocked('controls')).toBe(true);
    expect(worldInputBlocked('some-new-sheet')).toBe(true);
  });
});

// The wheel takes focus on its first emote (PanelManager's initialFocus) and
// its arrows walk the 4x2 grid. Walkable, it would hand the same arrow to the
// avatar: the menu keeps its arrows, the world keeps W, A, S and D.
describe('a focused menu item keeps the keys its menu uses (CO-A4)', () => {
  const wheel = (): HTMLButtonElement => {
    const menu = mount<HTMLDivElement>(
      '<div role="menu" aria-label="Emotes"><button type="button" role="menuitem">👋</button></div>',
    );
    return menu.querySelector('button') as HTMLButtonElement;
  };

  test('the arrows, Space and Enter are the wheel’s', () => {
    const item = wheel();
    for (const k of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', ' ', 'Enter']) {
      expect(focusedControlOwnsKey(k, item), k).toBe(true);
    }
  });

  test('W, A, S, D, E and Q still reach the world', () => {
    const item = wheel();
    for (const k of ['w', 'a', 's', 'd', 'e', 'q', 'W']) {
      expect(focusedControlOwnsKey(k, item), k).toBe(false);
    }
  });

  test('a plain button still owns only Space and Enter', () => {
    const btn = mount<HTMLButtonElement>('<button type="button">Send</button>');
    expect(focusedControlOwnsKey('ArrowUp', btn)).toBe(false);
    expect(focusedControlOwnsKey('Enter', btn)).toBe(true);
    expect(focusedControlOwnsKey('w', btn)).toBe(false);
  });
});
