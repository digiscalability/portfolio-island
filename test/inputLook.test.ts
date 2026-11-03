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

// ---- A3: press and drag to look, pointer lock only when asked for -------

/** The world canvas, with the capture API happy-dom lacks recorded. */
const worldCanvas = (): HTMLCanvasElement & { captured: number[]; released: number[] } => {
  const c = mount<HTMLCanvasElement>('<canvas id="game-canvas"></canvas>') as HTMLCanvasElement & {
    captured: number[];
    released: number[];
  };
  c.captured = [];
  c.released = [];
  c.setPointerCapture = (id: number) => void c.captured.push(id);
  c.releasePointerCapture = (id: number) => void c.released.push(id);
  c.hasPointerCapture = (id: number) => c.captured.includes(id) && !c.released.includes(id);
  im.attachToCanvas(c);
  return c;
};
const pointer = (el: EventTarget, type: string, init: PointerEventInit = {}): PointerEvent => {
  const e = new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    pointerId: 1,
    pointerType: 'mouse',
    button: 0,
    ...init,
  });
  el.dispatchEvent(e);
  return e;
};
/** A drag from (x0, y) through the given x positions, left button unless stated. */
const dragAcross = (c: HTMLCanvasElement, xs: number[], init: PointerEventInit = {}) => {
  pointer(c, 'pointerdown', { clientX: 100, clientY: 300, ...init });
  for (const x of xs) pointer(c, 'pointermove', { clientX: x, clientY: 300, ...init });
  pointer(c, 'pointerup', { clientX: xs[xs.length - 1] ?? 100, clientY: 300, ...init });
};
const setLock = (on: boolean) => {
  if (on) localStorage.setItem('ds_mouse_lock', '1');
  else localStorage.removeItem('ds_mouse_lock');
  window.dispatchEvent(new CustomEvent('ds:settings', { detail: { key: 'ds_mouse_lock' } }));
};

describe('press and drag to look (A3)', () => {
  afterEach(() => {
    localStorage.clear();
  });

  test('a drag captures the pointer and looks with every pixel it moved', () => {
    const c = worldCanvas();
    expect(c.style.cursor).toBe('grab');
    pointer(c, 'pointerdown', { clientX: 100, clientY: 300 });
    expect(c.captured).toEqual([1]);
    expect(c.style.cursor).toBe('grabbing');
    pointer(c, 'pointermove', { clientX: 103, clientY: 300 }); // still could be a click
    expect(im.getCameraInput().deltaX).toBe(0);
    pointer(c, 'pointermove', { clientX: 110, clientY: 302 }); // now a drag
    pointer(c, 'pointermove', { clientX: 400, clientY: 302 });
    const look = im.getCameraInput();
    // the first 10 px are not lost to the click threshold
    expect(look.deltaX).toBe(300);
    expect(look.deltaY).toBe(2);
    pointer(c, 'pointerup', { clientX: 400, clientY: 302 });
    expect(c.style.cursor).toBe('grab');
    expect(c.released).toEqual([1]);
  });

  test('the right button drags too', () => {
    const c = worldCanvas();
    dragAcross(c, [120, 250], { button: 2 });
    expect(im.getCameraInput().deltaX).toBe(150);
  });

  test('a press under 6 px and 300 ms stays a click: no look at all', () => {
    const now = vi.spyOn(performance, 'now').mockReturnValue(1000);
    const c = worldCanvas();
    pointer(c, 'pointerdown', { clientX: 100, clientY: 300 });
    now.mockReturnValue(1120);
    pointer(c, 'pointermove', { clientX: 104, clientY: 302 });
    pointer(c, 'pointerup', { clientX: 104, clientY: 302 });
    expect(im.getCameraInput()).toMatchObject({ deltaX: 0, deltaY: 0 });
  });

  test('a press held past 300 ms is a drag even before 6 px', () => {
    const now = vi.spyOn(performance, 'now').mockReturnValue(1000);
    const c = worldCanvas();
    pointer(c, 'pointerdown', { clientX: 100, clientY: 300 });
    now.mockReturnValue(1350);
    pointer(c, 'pointermove', { clientX: 103, clientY: 300 });
    expect(im.getCameraInput().deltaX).toBe(3);
  });

  test('moving with no button pressed never looks', () => {
    worldCanvas();
    for (let x = 0; x <= 600; x += 20) {
      document.dispatchEvent(
        new MouseEvent('mousemove', { clientX: x, clientY: 300, movementX: 20 }),
      );
    }
    expect(im.getCameraInput()).toMatchObject({ deltaX: 0, deltaY: 0 });
  });

  test('the drag ends on pointerup, on lost capture and on blur', () => {
    const c = worldCanvas();
    for (const end of ['pointerup', 'lostpointercapture', 'blur'] as const) {
      pointer(c, 'pointerdown', { clientX: 100, clientY: 300 });
      pointer(c, 'pointermove', { clientX: 140, clientY: 300 });
      if (end === 'blur') window.dispatchEvent(new Event('blur'));
      else pointer(c, end, { clientX: 140, clientY: 300 });
      im.getCameraInput();
      pointer(c, 'pointermove', { clientX: 300, clientY: 300 });
      expect(im.getCameraInput().deltaX, end).toBe(0);
    }
  });

  test('touch pointers are left to the touch path', () => {
    const c = worldCanvas();
    dragAcross(c, [200, 300], { pointerType: 'touch' });
    expect(c.captured).toEqual([]);
    expect(im.getCameraInput().deltaX).toBe(0);
  });

  test('a right-drag swallows the context menu; a right-click keeps it', () => {
    const c = worldCanvas();
    dragAcross(c, [130], { button: 2 });
    const afterDrag = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    c.dispatchEvent(afterDrag);
    expect(afterDrag.defaultPrevented).toBe(true);
    dragAcross(c, [102], { button: 2 });
    const afterClick = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    c.dispatchEvent(afterClick);
    expect(afterClick.defaultPrevented).toBe(false);
  });
});

describe('the pointer lock is opt-in (A3)', () => {
  let lockedTo: Element | null = null;
  beforeEach(() => {
    lockedTo = null;
    Object.defineProperty(document, 'pointerLockElement', {
      configurable: true,
      get: () => lockedTo,
    });
  });
  afterEach(() => {
    localStorage.clear();
    delete (document as { pointerLockElement?: unknown }).pointerLockElement;
  });
  const lockable = () => {
    const c = worldCanvas();
    const requests: number[] = [];
    c.requestPointerLock = (() => {
      requests.push(1);
      return Promise.resolve();
    }) as unknown as HTMLCanvasElement['requestPointerLock'];
    return { c, requests };
  };

  test('by default a click never captures the cursor, and the page says drag', () => {
    const { c, requests } = lockable();
    expect(document.documentElement.getAttribute('data-look-mode')).toBe('drag');
    dragAcross(c, [101]);
    c.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(requests).toHaveLength(0);
  });

  test('with ds_mouse_lock = 1 a click locks, re-read on ds:settings', () => {
    const { c, requests } = lockable();
    setLock(true);
    expect(document.documentElement.getAttribute('data-look-mode')).toBe('lock');
    dragAcross(c, [101]);
    c.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(requests).toHaveLength(1);
    setLock(false);
    expect(document.documentElement.getAttribute('data-look-mode')).toBe('drag');
  });

  test('never while a panel is open, and never as the tail of a drag', () => {
    const { c, requests } = lockable();
    setLock(true);
    let panelOpen = true;
    im.setPointerLockGuard(() => !panelOpen);
    dragAcross(c, [101]);
    c.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(requests).toHaveLength(0);
    panelOpen = false;
    dragAcross(c, [180]); // a real drag: its click is not a request
    c.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(requests).toHaveLength(0);
  });

  test('when it engages, a 12 px pill says how to leave, for 3 s', () => {
    vi.useFakeTimers();
    try {
      const { c } = lockable();
      setLock(true);
      lockedTo = c;
      document.dispatchEvent(new Event('pointerlockchange'));
      const pill = document.getElementById('ds-lock-pill')!;
      expect(pill.textContent).toBe('Mouse locked — Esc to release');
      expect(pill.style.fontSize).toBe('12px');
      expect(pill.style.display).toBe('block');
      vi.advanceTimersByTime(2900);
      expect(pill.style.display).toBe('block');
      vi.advanceTimersByTime(200);
      expect(pill.style.display).toBe('none');
      // while locked, plain movement looks
      document.dispatchEvent(new MouseEvent('mousemove', { movementX: 40, movementY: -10 }));
      expect(im.getCameraInput()).toMatchObject({ deltaX: 40, deltaY: -10 });
    } finally {
      vi.useRealTimers();
    }
  });
});
