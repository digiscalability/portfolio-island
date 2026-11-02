// @vitest-environment happy-dom
//
// enterOpensChat decides whether a window-level Enter may open the chat input
// (main-simple's chatKeydown). It used to be a private SimpleApp method that
// only ran behind the WebGL boot, so its tests could only read source text.
// It runs for real here: Enter belongs to whatever already used it.
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { enterOpensChat, type EnterGuardUi } from '../keyGuards';

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
