// @vitest-environment happy-dom
import { afterEach, describe, expect, test, vi } from 'vitest';

import { SimpleInputManager } from '../SimpleInputManager';

const key = (type: 'keydown' | 'keyup', k: string, repeat = false) => {
  document.dispatchEvent(new KeyboardEvent(type, { key: k, repeat, bubbles: true }));
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('SimpleInputManager', () => {
  test('isKeyPressed tracks keydown/keyup', () => {
    const im = new SimpleInputManager();
    expect(im.isKeyPressed('w')).toBe(false);
    key('keydown', 'w');
    expect(im.isKeyPressed('w')).toBe(true);
    key('keyup', 'w');
    expect(im.isKeyPressed('w')).toBe(false);
    im.dispose();
  });

  test('consumeKeyPress fires exactly once per physical press', () => {
    const im = new SimpleInputManager();
    key('keydown', 'e');
    expect(im.consumeKeyPress('e')).toBe(true);
    expect(im.consumeKeyPress('e')).toBe(false); // already consumed
    key('keyup', 'e');
    key('keydown', 'e'); // second physical press
    expect(im.consumeKeyPress('e')).toBe(true);
    im.dispose();
  });

  test('OS auto-repeat does not re-latch a consumed press', () => {
    const im = new SimpleInputManager();
    key('keydown', 'e');
    expect(im.consumeKeyPress('e')).toBe(true);
    key('keydown', 'e', true); // auto-repeat while held
    key('keydown', 'e', true);
    expect(im.consumeKeyPress('e')).toBe(false);
    im.dispose();
  });

  test('a tap shorter than one frame is still consumable (the latch)', () => {
    const im = new SimpleInputManager();
    key('keydown', 'e');
    key('keyup', 'e'); // released before the game loop ever polls
    expect(im.isKeyPressed('e')).toBe(false);
    expect(im.consumeKeyPress('e')).toBe(true); // latch preserved the press
    im.dispose();
  });

  test('a held key survives silence while the window has focus', () => {
    // The watchdog used to purge on a timer, assuming auto-repeat keeps held
    // keys alive. It does not: the OS only repeats the MOST RECENTLY pressed
    // key, so holding W and then pressing anything else stopped W's repeats
    // and the timer cut movement mid-stride.
    const now = vi.spyOn(performance, 'now');
    now.mockReturnValue(1000);
    const hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const im = new SimpleInputManager();
    key('keydown', 'w');
    expect(im.isKeyPressed('w')).toBe(true);

    now.mockReturnValue(3500); // 2.5s of silence — still held
    expect(im.isKeyPressed('w')).toBe(true);
    hasFocus.mockRestore();
    im.dispose();
  });

  test('the watchdog still clears stale keys once the window loses focus', () => {
    const now = vi.spyOn(performance, 'now');
    now.mockReturnValue(1000);
    const hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const im = new SimpleInputManager();
    key('keydown', 'w');
    expect(im.isKeyPressed('w')).toBe(true);

    hasFocus.mockReturnValue(false); // alt-tabbed: the keyup will never come
    now.mockReturnValue(3500);
    expect(im.isKeyPressed('w')).toBe(false);
    hasFocus.mockRestore();
    im.dispose();
  });

  test('auto-repeat keeps a genuinely held key alive past the watchdog window', () => {
    const now = vi.spyOn(performance, 'now');
    now.mockReturnValue(1000);
    const im = new SimpleInputManager();
    key('keydown', 'w');

    now.mockReturnValue(2600);
    key('keydown', 'w', true); // repeat refreshes the timestamp

    now.mockReturnValue(4000); // only 1.4s since the last event
    expect(im.isKeyPressed('w')).toBe(true);
    im.dispose();
  });

  test('window blur clears all input state', () => {
    const im = new SimpleInputManager();
    key('keydown', 'w');
    key('keydown', 'e');
    expect(im.isKeyPressed('w')).toBe(true);
    window.dispatchEvent(new Event('blur'));
    expect(im.isKeyPressed('w')).toBe(false);
    expect(im.consumeKeyPress('e')).toBe(false); // latch cleared too
    im.dispose();
  });

  test('getMovementInput composes WASD into forward/strafe', () => {
    const im = new SimpleInputManager();
    key('keydown', 'w');
    key('keydown', 'a');
    expect(im.getMovementInput()).toEqual({ forward: 1, strafe: -1 });
    key('keyup', 'a');
    key('keydown', 'd');
    expect(im.getMovementInput()).toEqual({ forward: 1, strafe: 1 });
    im.dispose();
  });
});
