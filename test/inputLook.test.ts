// @vitest-environment happy-dom
//
// Who gets a key, and how the camera reads the pointer (A2-A4). These run the
// real SimpleInputManager against happy-dom events.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { SimpleInputManager } from '../SimpleInputManager';

let im: SimpleInputManager;

const press = (key: string, target: EventTarget = document.body, init: KeyboardEventInit = {}) => {
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...init }));
};
const release = (key: string, target: EventTarget = document.body) => {
  target.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true }));
};
const mount = <T extends HTMLElement>(html: string): T => {
  const host = document.createElement('div');
  host.innerHTML = html;
  const el = host.firstElementChild as T;
  document.body.appendChild(el);
  return el;
};
/** Held AND latched — what the world would see from this keydown. */
const reached = (key: string): { held: boolean; latched: boolean } => {
  const held = im.isKeyPressed(key);
  const latched = im.consumeKeyPress(key);
  return { held, latched };
};

beforeEach(() => {
  document.body.innerHTML = '';
  im = new SimpleInputManager();
});

afterEach(() => {
  im.dispose();
  vi.restoreAllMocks();
});

describe('clearLatched (A2)', () => {
  test('drops every latched press, keeps what is still held', () => {
    press('e');
    press('m');
    press('w');
    im.clearLatched();
    expect(im.consumeKeyPress('e')).toBe(false);
    expect(im.consumeKeyPress('m')).toBe(false);
    expect(im.consumeKeyPress('w')).toBe(false);
    // W is still physically down: walking resumes the moment the world has focus
    expect(im.isKeyPressed('w')).toBe(true);
  });

  test('a press after the clear latches as usual', () => {
    press('e');
    im.clearLatched();
    release('e');
    press('e');
    expect(im.consumeKeyPress('e')).toBe(true);
  });
});

describe('browser chords are never game input (A2)', () => {
  test('Ctrl+C and Meta+C neither latch nor hold C', () => {
    press('c', document.body, { ctrlKey: true });
    expect(reached('c')).toEqual({ held: false, latched: false });
    press('c', document.body, { metaKey: true });
    expect(reached('c')).toEqual({ held: false, latched: false });
  });

  test('Alt+key and Ctrl+W do nothing either', () => {
    press('m', document.body, { altKey: true });
    expect(reached('m')).toEqual({ held: false, latched: false });
    press('w', document.body, { ctrlKey: true });
    expect(reached('w')).toEqual({ held: false, latched: false });
  });

  test('Shift still counts: Shift+W walks and Shift is the dive key', () => {
    press('Shift', document.body, { shiftKey: true });
    press('W', document.body, { shiftKey: true });
    expect(im.isKeyPressed('w')).toBe(true);
    expect(im.getDiveInput()).toBe(true);
  });
});

describe('a focused control keeps the keys it uses (A2)', () => {
  test('text entry takes every key: nothing is held or latched', () => {
    const fields = [
      mount<HTMLInputElement>('<input type="text">'),
      mount<HTMLInputElement>('<input type="email">'),
      mount<HTMLInputElement>('<input>'), // no type = text
      mount<HTMLTextAreaElement>('<textarea></textarea>'),
    ];
    const editable = mount<HTMLDivElement>('<div contenteditable="true"></div>');
    // happy-dom does not derive isContentEditable from the attribute; a
    // browser does (as in keyGuards.test.ts).
    Object.defineProperty(editable, 'isContentEditable', { value: true });
    for (const el of [...fields, editable]) {
      for (const k of ['w', 'e', ' ', 'm', 'c', 'p', 'ArrowDown']) {
        press(k, el);
        expect(reached(k), `${el.tagName} ${k}`).toEqual({ held: false, latched: false });
        release(k, el);
      }
    }
  });

  test('a slider and a select keep their value keys, nothing else', () => {
    const range = mount<HTMLInputElement>('<input type="range" min="0" max="1" step="0.1">');
    const select = mount<HTMLSelectElement>('<select><option>a</option></select>');
    for (const el of [range, select]) {
      for (const k of [
        'ArrowLeft',
        'ArrowRight',
        'ArrowUp',
        'ArrowDown',
        'Home',
        'End',
        'PageUp',
        'PageDown',
      ]) {
        press(k, el);
        expect(reached(k), `${el.tagName} ${k}`).toEqual({ held: false, latched: false });
        release(k, el);
      }
      // W is not the slider's: the world still walks
      press('w', el);
      expect(reached('w'), `${el.tagName} w`).toEqual({ held: true, latched: true });
      release('w', el);
    }
  });

  test('a button or link keeps only Space and Enter', () => {
    const send = mount<HTMLButtonElement>('<button>Send</button>');
    const link = mount<HTMLAnchorElement>(
      '<a href="https://www.linkedin.com/in/-abbas-ali">LinkedIn</a>',
    );
    const chip = mount<HTMLDivElement>('<div role="button" tabindex="0">📖</div>');
    for (const el of [send, link, chip]) {
      for (const k of [' ', 'Enter']) {
        press(k, el);
        expect(reached(k), `${el.tagName} ${JSON.stringify(k)}`).toEqual({
          held: false,
          latched: false,
        });
        release(k, el);
      }
    }
    // sendThenWalk: W after clicking an NPC chat's Send still walks away
    press('w', send);
    expect(reached('w')).toEqual({ held: true, latched: true });
    release('w', send);
    // and E on a focused swatch still reaches the walkable appearance editor's world
    press('e', chip);
    expect(reached('e')).toEqual({ held: true, latched: true });
  });

  test('the bare page and the canvas are the world', () => {
    const canvas = mount<HTMLCanvasElement>('<canvas id="game-canvas" tabindex="0"></canvas>');
    for (const target of [document.body, canvas]) {
      press(' ', target);
      expect(reached(' ')).toEqual({ held: true, latched: true });
      release(' ', target);
    }
  });

  test('a key held before focus moved is still released by its keyup', () => {
    press('w');
    const field = mount<HTMLInputElement>('<input type="text">');
    press('w', field, { repeat: true }); // auto-repeat now lands in the field
    expect(im.isKeyPressed('w')).toBe(true);
    release('w', field);
    expect(im.isKeyPressed('w')).toBe(false);
  });
});
