// @vitest-environment happy-dom
//
// Mobile-finish coverage locks (iPhone SE pass, 375x667).
//
// The SE audit found the two most crowded moments of the product — the
// first-run welcome and the guided tour — were the ONLY two major surfaces
// bypassing PanelManager, so the HUD-clearing policy built for exactly this
// crowding never ran during onboarding. These locks pin the routing and the
// message-primitive fixes the same way reducedMotion.test.ts pins its gates.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { SimpleUI } from '../SimpleUI';
import { keyTextPlain, promptKeysHtml, renderKeyText } from '../ui/keycaps';
import { DS } from '../ui/tokens';

const src = (f: string): string => readFileSync(join(process.cwd(), f), 'utf8');

const fn = (file: string, marker: string, span = 3500): string => {
  const s = src(file);
  const i = s.indexOf(marker);
  expect(i, `${marker} not found in ${file}`).toBeGreaterThan(-1);
  return s.slice(i, i + span);
};

describe('onboarding surfaces route through PanelManager', () => {
  test('the welcome modal opens as a managed modal that clears the HUD', () => {
    const w = fn('SimpleUI.ts', 'showWelcome(awayDelta');
    expect(w).toContain("this.panels.open('welcome'");
    expect(w).toContain("'touch-controls'");
    expect(w).toContain("'aux-controls'");
  });

  test('the tour overlay opens as a managed sheet that clears the HUD', () => {
    const t = fn('SimpleUI.ts', 'showTourOverlay(');
    expect(t).toContain("this.panels.open('tour'");
    expect(t).toContain("'touch-controls'");
  });

  test('the drawer suppresses the touch controls that painted over it', () => {
    const d = fn('SimpleUI.ts', "this.panels.open('drawer'");
    expect(d).toContain("'touch-controls'");
  });
});

describe('message primitives are SE-safe', () => {
  test('toast wraps, queues, and defers under the loader/welcome', () => {
    const t = fn('SimpleUI.ts', 'public toast(message');
    expect(t).toContain('toastQueue');
    const p = fn('SimpleUI.ts', 'private pumpToasts');
    expect(p).toContain('isWelcomeVisible');
    expect(p).toContain('maxWidth');
    expect(p).not.toContain("whiteSpace: 'nowrap'");
  });

  test('flashMessage is single-slot (no superimposed stacking)', () => {
    expect(fn('SimpleUI.ts', 'flashMessage(text')).toContain('this.flashEl?.remove()');
  });

  test('the world bulletin waits out the welcome modal', () => {
    expect(fn('SimpleUI.ts', 'public showWorldBulletin')).toContain('isWelcomeVisible');
  });
});

describe('touch layout recomposition', () => {
  test('chips stay their own tap-pad containing block (relative, never static)', () => {
    // position:'static' re-anchored every .hud-btn::after 44px pad to the
    // whole drawer list and scrambled hit-testing across it.
    expect(fn('SimpleUI.ts', 'private tierChip')).toContain("position: 'relative'");
    expect(fn('SimpleUI.ts', 'private chipHost', 2000)).not.toContain("position: 'static'");
  });

  test('FEED/EAT are contextual aux controls, not permanent buttons', () => {
    // (that main-simple calls setAuxActionAvailable is package A's mainLocks)
    const s = src('SimpleUI.ts');
    expect(s).toContain("'aux-controls'");
    expect(s).toContain('setAuxActionAvailable');
  });

  test('narrow-portrait recompose exists (SE-class radar + chip row)', () => {
    const r = fn('SimpleUI.ts', 'private applyResponsiveHud', 3800);
    expect(r).toContain('narrow');
    expect(r).toContain("'120px'");
  });

  test('landscape SE re-lanes the surfaces that collide there', () => {
    // 667x375 was the audit's biggest miss: nothing but the minimap ever
    // reflowed for it. Each of these was MEASURED as a real overlap.
    const r = fn('SimpleUI.ts', 'private applyResponsiveHud', 3800);
    expect(r).toContain('emoteBtnEl'); // was 27x33 into the WAVE button (tap conflict)
    expect(r).toContain('envBadgeDiv'); // was 64x26 into the raised radar
    // The bulletin/toast lanes must be breakpoint-aware: bottom+250 on a
    // 375-tall screen is y88-125, inside the bulletin's own y66-126 band.
    const t = fn('SimpleUI.ts', 'private applyToastAnchor');
    expect(t).toContain('shortLandscape');
    expect(fn('SimpleUI.ts', 'private bulletinTop')).toContain('shortLandscape');
  });

  test('the chat/mic stack clears the joystick hit square', () => {
    // The joystick's INVISIBLE hit region is 166px tall from the bottom
    // edge; the chat button at bottom+152 put its lower 14px inside it, so
    // a drag starting there opened chat instead of moving. Both orientations.
    const s = src('SimpleUI.ts');
    expect(s).toContain("bottom: 'calc(var(--sab, 0px) + 174px)'");
    expect(s).not.toContain("bottom: 'calc(var(--sab, 0px) + 152px)'");
  });
});

// The scene-transition grammar lock (tour end, postcard release and drown
// respawn all veil through fadeThrough) is main-simple.ts code: it moved to
// package A's test/mainLocks.test.ts (testOwnership rule 1).

// D7: keycaps and touch glyphs that follow the input in use.
describe('D7: one key renderer, and the input mode it follows', () => {
  let ui: SimpleUI | null = null;
  afterEach(() => {
    ui?.dispose();
    ui = null;
    history.replaceState(null, '', '/');
  });
  const boot = (url = '/'): SimpleUI => {
    history.replaceState(null, '', url);
    document.body.innerHTML = '<div id="ui-overlay"></div>';
    ui = new SimpleUI('ui-overlay');
    return ui;
  };
  type Inner = {
    setInput(i: 'keyboard' | 'mouse' | 'touch'): void;
    interactionDiv: HTMLElement | null;
    onInputKey(e: KeyboardEvent): void;
  };
  const inner = (u: SimpleUI): Inner => u as unknown as Inner;

  test('the prompt: a keycap on the keyboard, the glyph pill on touch, no keyboard emoji', () => {
    const p = '⌨️ Press <strong>E</strong> to interact';
    expect(promptKeysHtml(p, 'keyboard')).toBe('Press <kbd class="kc">E</kbd> to interact');
    const t = promptKeysHtml(p, 'touch');
    expect(t).toMatch(/^Tap <span class="kg" data-ring="use"[^>]*>USE<\/span> to interact$/);
    expect(t).not.toMatch(/press E|⌨/i);
    expect(promptKeysHtml('Hold <strong>Space</strong> to swim up', 'touch')).toContain(
      'Hold <span class="kg" data-ring="jump"',
    );
    expect(promptKeysHtml('press <strong>q</strong>, or [E]', 'touch')).toBe(
      'tap <span class="kg" data-ring="wave" style="--kg-ring: var(--ds-ring-wave)">WAVE</span>, or <span class="kg" data-ring="use" style="--kg-ring: var(--ds-ring-use)">USE</span>',
    );
    // A key with no touch button keeps its keycap.
    expect(promptKeysHtml('Press <strong>M</strong> for the map', 'touch')).toContain(
      '<kbd class="kc">M</kbd>',
    );
  });

  test('toasts build nodes from text, so a visitor-authored name never becomes markup', () => {
    const el = document.createElement('div');
    renderKeyText(el, '<img src=x onerror=alert(1)> says hi. Press E to wave back [Q]', 'keyboard');
    expect(el.querySelector('img')).toBeNull();
    expect(el.textContent).toBe('<img src=x onerror=alert(1)> says hi. Press E to wave back Q');
    expect([...el.querySelectorAll('kbd.kc')].map((x) => x.textContent)).toEqual(['E', 'Q']);
    renderKeyText(el, 'press F to feed', 'touch');
    expect(el.querySelector('.kg')!.textContent).toBe('FEED');
    expect(keyTextPlain('press G to eat', 'touch')).toBe('tap EAT to eat');
    // Prose is not a key: the key must be written as one.
    expect(keyTextPlain('press a button', 'touch')).toBe('press a button');
  });

  test('the glyph pill text is 7:1 or better on every ring tint (target 9:1)', () => {
    type RGB = [number, number, number];
    const hex = (h: string): RGB => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as RGB;
    const lin = (c: number): number => {
      const v = c / 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    const lum = ([r, g, b]: RGB): number => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    const over = (fg: RGB, a: number, bg: RGB): RGB =>
      fg.map((v, i) => v * a + bg[i] * (1 - a)) as RGB;
    const text = hex('#0b1220');
    // The pill is opaque: the ring colour tinted 85/15 with white.
    for (const ring of [DS.ringUse, DS.ringJump, DS.ringWave, DS.ringEat, DS.ringFeed]) {
      const bg = over(hex(ring), 0.85, [255, 255, 255]);
      const r = (Math.max(lum(bg), lum(text)) + 0.05) / (Math.min(lum(bg), lum(text)) + 0.05);
      // 7:1 everywhere; 9:1 on the three standing buttons (USE, JUMP, WAVE).
      expect(r, ring).toBeGreaterThanOrEqual(
        [DS.ringUse, DS.ringJump, DS.ringWave].includes(ring) ? 9 : 7,
      );
    }
    const css = src('style.css');
    expect(css).toMatch(/kbd\.kc \{[^}]*background: rgba\(255, 255, 255, 0\.14\)/);
    expect(css).toMatch(/\.kg \{[^}]*height: 22px[^}]*color: #0b1220/);
  });

  test('the boot scheme: ?touch=1 exactly, not any URL that says touch', () => {
    expect(boot('/?utm_content=get-in-touch').isTouchDevice()).toBe(false);
    ui!.dispose();
    expect(boot('/?touch=1').isTouchDevice()).toBe(true);
    ui!.dispose();
    expect(boot('/?touch=0').isTouchDevice()).toBe(false);
  });

  test('getInputMode follows trusted input; untrusted keys (the touch buttons) never flip it', () => {
    const u = boot('/?touch=1');
    expect(u.getInputMode()).toBe('touch');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'e', bubbles: true }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'e', bubbles: true }));
    expect(u.getInputMode()).toBe('touch');
    inner(u).setInput('keyboard');
    expect(u.getInputMode()).toBe('keyboard');
    inner(u).setInput('mouse');
    expect(u.getInputMode()).toBe('keyboard'); // a mouse is the desktop scheme
    inner(u).setInput('touch');
    expect(u.getInputMode()).toBe('touch');
  });

  test("typing into the chat field on a touch boot leaves the mode at 'touch'", () => {
    const u = boot('/?touch=1');
    const key = inner(u).onInputKey;
    const press = (target: EventTarget, k: string, isComposing = false): void =>
      key({ isTrusted: true, key: k, isComposing, target } as unknown as KeyboardEvent);
    const input = document.createElement('input');
    const area = document.createElement('textarea');
    const editable = document.createElement('div');
    editable.setAttribute('contenteditable', 'true');
    document.body.append(input, area, editable);
    for (const t of [input, area, editable]) press(t, 'h');
    press(document.body, 'Unidentified'); // Android's soft keyboard
    press(document.body, 'Process'); // an IME
    press(document.body, 'a', true); // mid-composition
    expect(u.getInputMode()).toBe('touch');
    // A hardware keyboard outside a field still switches the scheme.
    press(document.body, 'e');
    expect(u.getInputMode()).toBe('keyboard');
  });

  test('a switch of input mode re-renders the same prompt', () => {
    const u = boot('/');
    u.showInteractionPrompt('Press <strong>E</strong> to talk');
    const div = inner(u).interactionDiv!;
    expect(div.querySelector('kbd.kc')!.textContent).toBe('E');
    inner(u).setInput('touch');
    expect(div.querySelector('.kg')!.textContent).toBe('USE');
    expect(div.textContent).toBe('Tap USE to talk');
    inner(u).setInput('keyboard');
    expect(div.querySelector('kbd.kc')).not.toBeNull();
  });

  test('ten seconds of keyboard-only play fade the touch controls; a touch brings them back', () => {
    vi.useFakeTimers();
    try {
      const u = boot('/?touch=1');
      const overlay = document.getElementById('ui-overlay')!;
      expect(overlay.querySelectorAll('.ds-touch-ctl').length).toBeGreaterThan(2);
      inner(u).setInput('keyboard');
      vi.advanceTimersByTime(9_000);
      expect(overlay.hasAttribute('data-touch-idle')).toBe(false);
      vi.advanceTimersByTime(1_500);
      expect(overlay.getAttribute('data-touch-idle')).toBe('1');
      inner(u).setInput('touch');
      expect(overlay.hasAttribute('data-touch-idle')).toBe(false);
    } finally {
      ui?.dispose();
      ui = null;
      vi.useRealTimers();
    }
    expect(src('style.css')).toMatch(
      /#ui-overlay\[data-touch-idle\] \.ds-touch-ctl \{\s*opacity: 0\.35/,
    );
  });

  test('a desktop-scheme device: the first trusted canvas touch reveals the controls', () => {
    const u = boot('/');
    const overlay = document.getElementById('ui-overlay')!;
    expect(overlay.querySelector('.ds-touch-ctl')).toBeNull();
    (u as unknown as { revealTouchControls(): void }).revealTouchControls();
    expect(overlay.querySelectorAll('.ds-touch-ctl').length).toBeGreaterThan(2);
    expect(u.isTouchDevice()).toBe(false); // the desktop chips stay
    const handler = fn('SimpleUI.ts', 'private readonly onInputPointer');
    expect(handler).toContain('if (!e.isTrusted) return;');
    expect(handler).toContain('e.target instanceof HTMLCanvasElement');
  });
});

// D15: a joystick that lands under the thumb. happy-dom lays nothing out, so
// every rect is at 0,0 and the hit square's 55..111 px clamp is easy to read.
describe('D15: the joystick lands under the thumb', () => {
  let ui: SimpleUI | null = null;
  let vib: Array<number | number[]> = [];
  afterEach(() => {
    ui?.dispose();
    ui = null;
    history.replaceState(null, '', '/');
    vi.useRealTimers();
    try {
      localStorage.clear();
    } catch {
      /* none */
    }
  });
  const boot = (): SimpleUI => {
    history.replaceState(null, '', '/?touch=1');
    document.body.innerHTML = '<div id="ui-overlay"></div>';
    localStorage.setItem('ds_haptics', '1');
    vib = [];
    Object.defineProperty(navigator, 'vibrate', {
      configurable: true,
      value: (p: number | number[]) => {
        vib.push(p);
        return true;
      },
    });
    ui = new SimpleUI('ui-overlay');
    return ui;
  };
  const touch = (el: Element, type: string, x: number, y: number, id = 1): void => {
    const ev = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'changedTouches', {
      value: [{ identifier: id, clientX: x, clientY: y }],
    });
    el.dispatchEvent(ev);
  };
  const parts = () => {
    const ring = document.querySelector<HTMLElement>('[data-guide="joystick"]')!;
    return { ring, hit: ring.parentElement!, thumb: ring.firstElementChild as HTMLElement };
  };
  const shift = (el: HTMLElement): number[] => {
    const m = /translate\(([-\d.]+)px, ([-\d.]+)px\)/.exec(el.style.transform);
    return m ? [Number(m[1]), Number(m[2])] : [0, 0];
  };
  const mag = (u: SimpleUI): number => Math.hypot(u.getJoystick().forward, u.getJoystick().strafe);
  const RUN = /#ffb547|rgb\(255,181,71\)/;

  test('the hit square, the ring and its rest spot keep the anchors A6 and mobile.cjs use', () => {
    boot();
    const { ring, hit } = parts();
    expect(hit.style.width).toBe('166px');
    expect(ring.style.left).toBe('26px');
    expect(ring.style.bottom).toBe('26px');
  });

  test('a touchdown anywhere in the square reads |v| = 0; the ring follows the thumb, clamped', () => {
    const u = boot();
    const { ring, hit } = parts();
    const points: Array<[number, number]> = [
      [4, 4],
      [162, 4],
      [4, 162],
      [162, 162],
      [83, 4],
      [90, 90],
    ];
    for (const [x, y] of points) {
      touch(hit, 'touchstart', x, y);
      expect(mag(u), `${x},${y}`).toBe(0);
      // The ring moves by transform from its rest spot (left 26, top 30 in
      // the square); it stays inside: left in [0, 56], top in [0, 56].
      const [ox, oy] = shift(ring);
      expect(26 + ox).toBeGreaterThanOrEqual(0);
      expect(26 + ox).toBeLessThanOrEqual(56);
      expect(30 + oy).toBeGreaterThanOrEqual(0);
      expect(30 + oy).toBeLessThanOrEqual(56);
      expect(ring.style.left).toBe('26px'); // the rest spot never moves
      touch(hit, 'touchend', x, y);
    }
    touch(hit, 'touchstart', 90, 90);
    expect(shift(ring)).toEqual([9, 5]); // centre at 90,90: rest centre is 81,85
  });

  test('hysteresis: engage at 12%, release below 8%, continuous from 8%', () => {
    const u = boot();
    const { hit } = parts();
    touch(hit, 'touchstart', 80, 80);
    touch(hit, 'touchmove', 80, 80 - 4.4); // 11%: not yet
    expect(mag(u)).toBe(0);
    touch(hit, 'touchmove', 80, 80 - 5); // 12.5%: engaged
    expect(mag(u)).toBeCloseTo((0.125 - 0.08) / 0.92, 6);
    expect(u.getJoystick().forward).toBeGreaterThan(0); // up the screen walks forward
    touch(hit, 'touchmove', 80, 80 - 3.6); // 9%: still engaged, small
    expect(mag(u)).toBeCloseTo((0.09 - 0.08) / 0.92, 6);
    touch(hit, 'touchmove', 80, 80 - 3); // 7.5%: released
    expect(mag(u)).toBe(0);
    touch(hit, 'touchmove', 80, 80 - 40);
    expect(mag(u)).toBeCloseTo(1, 6);
  });

  test('on release (only) the thumb eases home over 120 ms and the ring drifts back', () => {
    const u = boot();
    const { ring, hit, thumb } = parts();
    touch(hit, 'touchstart', 90, 90);
    expect(thumb.style.transition).toBe('none');
    touch(hit, 'touchmove', 90, 60);
    touch(hit, 'touchend', 90, 60);
    expect(mag(u)).toBe(0);
    expect(thumb.style.transition).toContain('120ms');
    expect(shift(thumb)).toEqual([0, 0]);
    expect(ring.style.transition).toContain('200ms');
    expect(shift(ring)).toEqual([0, 0]);
    expect(ring.style.left).toBe('26px');
    expect(ring.style.bottom).toBe('26px');
  });

  test("the ring turns #ffb547 after 250 ms at the run threshold (A's 0.95 / 250 ms)", () => {
    vi.useFakeTimers();
    const u = boot();
    const { ring, hit } = parts();
    touch(hit, 'touchstart', 80, 80);
    touch(hit, 'touchmove', 80, 20);
    expect(mag(u)).toBeGreaterThanOrEqual(0.95);
    vi.advanceTimersByTime(200);
    expect(ring.style.border.replace(/\s/g, '')).not.toMatch(RUN);
    vi.advanceTimersByTime(80);
    expect(ring.style.border.replace(/\s/g, '')).toMatch(RUN);
    touch(hit, 'touchmove', 80, 70);
    expect(ring.style.border.replace(/\s/g, '')).not.toMatch(RUN);
    const consts = fn('SimpleUI.ts', 'const STICK_RUN_MAG', 200);
    expect(consts).toContain('STICK_RUN_MAG = 0.95');
    expect(consts).toContain('STICK_RUN_MS = 250');
  });

  test('haptics: engage 10 ms, the run colour 10 ms, a button 12 ms, a door or talk 18 ms', () => {
    vi.useFakeTimers();
    const u = boot();
    const { hit } = parts();
    touch(hit, 'touchstart', 80, 80);
    expect(vib).toEqual([10]);
    touch(hit, 'touchmove', 80, 20);
    vi.advanceTimersByTime(300);
    expect(vib).toEqual([10, 10]);
    touch(hit, 'touchend', 80, 20);
    const use = document.querySelector('[data-guide="use-button"]')!;
    touch(use, 'touchstart', 0, 0, 2);
    touch(use, 'touchend', 0, 0, 2);
    expect(vib).toEqual([10, 10, 12]);
    u.showDialogue('Elder Sage', ['Hello']);
    expect(vib.at(-1)).toBe(18);
    u.fadeThrough(() => {});
    expect(vib.at(-1)).toBe(18);
    // A refused buy: the shop's rows buzz the pattern on a disabled button.
    expect(src('SimpleUI.ts')).toContain('hapticPulse([12, 40, 12])');
  });

  test("the MOVE caption shows until the stick's first use, then never again", () => {
    boot();
    const { ring, hit } = parts();
    expect(ring.querySelector('.ds-caption')?.textContent).toBe('Move');
    touch(hit, 'touchstart', 80, 80);
    expect(ring.querySelector('.ds-caption')).toBeNull();
    expect(localStorage.getItem('ds_move_seen')).toBe('1');
    ui?.dispose();
    document.body.innerHTML = '<div id="ui-overlay"></div>';
    ui = new SimpleUI('ui-overlay');
    expect(document.querySelector('[data-guide="joystick"] .ds-caption')).toBeNull();
  });

  test('the action buttons are named buttons: Use (E), Jump (Space), Wave (Q)...', () => {
    boot();
    const labels = [...document.querySelectorAll('.ds-touch-ctl[role="button"]')].map((b) =>
      b.getAttribute('aria-label'),
    );
    for (const l of [
      'Use (E)',
      'Jump (Space)',
      'Wave (Q)',
      'Dive (Shift)',
      'Feed (F)',
      'Eat (G)',
    ]) {
      expect(labels).toContain(l);
    }
  });
});
