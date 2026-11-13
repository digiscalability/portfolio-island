// @vitest-environment happy-dom
import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  SimpleInputManager,
  WHEEL_ZOOM_K,
  consumePinchZoomFactor,
  wheelZoomFactor,
} from '../SimpleInputManager';

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

describe('A11: Shift runs, the wheel and = / − zoom', () => {
  const wheel = (init: WheelEventInit) => {
    const ev = new WheelEvent('wheel', { bubbles: true, cancelable: true, ...init });
    // happy-dom's WheelEvent drops the modifier flags; a browser keeps them.
    Object.defineProperty(ev, 'ctrlKey', { value: !!init.ctrlKey });
    Object.defineProperty(ev, 'shiftKey', { value: !!init.shiftKey });
    return ev;
  };

  test('getRunInput is Shift held; Space is not a run', () => {
    const im = new SimpleInputManager();
    key('keydown', ' ');
    expect(im.getRunInput()).toBe(false);
    expect(im.getJumpInput()).toBe(true);
    key('keydown', 'Shift');
    expect(im.getRunInput()).toBe(true);
    expect(im.getDiveInput()).toBe(true); // the same key still dives in water
    key('keyup', 'Shift');
    expect(im.getRunInput()).toBe(false);
    im.dispose();
  });

  test('wheelZoomFactor: exp(deltaY × 0.0012), lines × 16, pages × 400', () => {
    const base = { deltaX: 0, shiftKey: false };
    expect(wheelZoomFactor({ ...base, deltaY: 240, deltaMode: 0 })).toBeCloseTo(Math.exp(0.288), 9);
    expect(wheelZoomFactor({ ...base, deltaY: 3, deltaMode: 1 })).toBeCloseTo(
      Math.exp(48 * WHEEL_ZOOM_K),
      9,
    );
    expect(wheelZoomFactor({ ...base, deltaY: 1, deltaMode: 2 })).toBeCloseTo(
      Math.exp(400 * WHEEL_ZOOM_K),
      9,
    );
    expect(wheelZoomFactor({ ...base, deltaY: 0, deltaMode: 0 })).toBe(1);
    // Shift+wheel arrives horizontal on Chromium/Windows: read deltaX then.
    expect(wheelZoomFactor({ deltaY: 0, deltaX: -240, deltaMode: 0, shiftKey: true })).toBeCloseTo(
      Math.exp(-0.288),
      9,
    );
    // A real horizontal scroll without Shift is not a zoom.
    expect(wheelZoomFactor({ deltaY: 0, deltaX: 120, deltaMode: 0, shiftKey: false })).toBe(1);
  });

  test('five +240 notches from the walk distance reach the 12 u clamp, five −240 reach 2', () => {
    const f = wheelZoomFactor({ deltaY: 240, deltaX: 0, deltaMode: 0, shiftKey: false });
    const clamp = (d: number) => Math.max(2, Math.min(12, d));
    let d = 4.4;
    for (let i = 0; i < 5; i++) d = clamp(d * f);
    expect(d).toBe(12);
    d = 4.4;
    for (let i = 0; i < 5; i++) d = clamp(d / f);
    expect(d).toBe(2);
  });

  test('a canvas wheel prevents the page scroll and feeds the pinch channel; Ctrl+wheel does not', () => {
    const im = new SimpleInputManager();
    const canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    im.attachToCanvas(canvas);
    consumePinchZoomFactor();
    const ev = wheel({ deltaY: 240 });
    canvas.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(consumePinchZoomFactor()).toBeCloseTo(Math.exp(0.288), 9);
    const ctrl = wheel({ deltaY: 240, ctrlKey: true });
    canvas.dispatchEvent(ctrl);
    expect(ctrl.defaultPrevented).toBe(false);
    expect(consumePinchZoomFactor()).toBe(1);
    im.dispose();
    canvas.remove();
  });

  test('= and − step the zoom by position (Shift makes them + and _)', () => {
    const im = new SimpleInputManager();
    consumePinchZoomFactor();
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: '+', code: 'Equal', bubbles: true }),
    );
    expect(consumePinchZoomFactor()).toBeCloseTo(0.85, 9);
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: '_', code: 'Minus', bubbles: true }),
    );
    expect(consumePinchZoomFactor()).toBeCloseTo(1.18, 9);
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: '+', code: 'NumpadAdd', bubbles: true }),
    );
    expect(consumePinchZoomFactor()).toBeCloseTo(0.85, 9);
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: '-', code: 'NumpadSubtract', bubbles: true }),
    );
    expect(consumePinchZoomFactor()).toBeCloseTo(1.18, 9);
    im.dispose();
  });
});
