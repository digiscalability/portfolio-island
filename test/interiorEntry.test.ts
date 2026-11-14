// @vitest-environment happy-dom
//
// Entering a hall can never leave a visitor without Leave (P2-A2, INT-02).
//
// The fourth passport stamp lands inside SimpleUI.showZonePanel. Its
// celebration opened as a modal, swept the half-built hall panel, and the
// panel threw on the null it left behind. fadeThrough's try/catch swallowed
// the error, and enterBuilding's mid-fade callback never reached
// showLeaveButton: the visitor stood in the room with no panel and no Leave.
//
// The method runs here for real, on a stub app: SimpleApp is exported, and the
// boot latch is set before the import so the module builds no app.
//
// P2-A1 adds the way out by key: indoors, Escape leaves, but never on the
// press that closed a panel; and no key pressed on one side of the door fires
// on the other.
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest';

// main-simple calls inject() at module load. Under happy-dom that appends the
// analytics script tag and happy-dom FETCHES it: a unit test on the network.
vi.mock('@vercel/analytics', () => ({ inject: vi.fn(), track: vi.fn() }));

type Fn = (...a: unknown[]) => unknown;
let enterBuilding: Fn;
let exitBuilding: Fn;
let onInteriorEscape: Fn;
let openHallPanel: Fn;

beforeAll(async () => {
  (window as unknown as { __lifeIslandBooted?: boolean }).__lifeIslandBooted = true;
  const mod = await import('../main-simple');
  const proto = mod.SimpleApp.prototype as unknown as Record<string, Fn>;
  enterBuilding = proto.enterBuilding;
  exitBuilding = proto.exitBuilding;
  onInteriorEscape = proto.onInteriorEscape;
  openHallPanel = proto.openHallPanel;
}, 120000);

/** The app's fields enterBuilding reads, with SimpleUI.fadeThrough's own guard. */
function stubApp(showZonePanel: Fn) {
  const calls: string[] = [];
  const ui = {
    fadeThrough: (mid: () => void) => {
      // SimpleUI.fadeThrough: the swap runs inside a try/catch of its own.
      try {
        mid();
      } catch {
        calls.push('fadeThrough swallowed an error');
      }
    },
    showZonePanel: vi.fn((...a: unknown[]) => {
      calls.push('showZonePanel');
      return showZonePanel(...a);
    }),
    showLeaveButton: vi.fn(() => calls.push('showLeaveButton')),
  };
  const scene = {
    isInsideInterior: () => false,
    enterInterior: vi.fn(() => calls.push('enterInterior')),
  };
  const inputManager = { clearLatched: vi.fn() };
  const app = {
    ui,
    scene,
    inputManager,
    markDone: vi.fn(),
    touchCopy: () => false,
    insideZone: null,
    insideIsZone: false,
    // P2-A9: the hall's panel opens through openHallPanel, which pays the
    // stamp it lands at once (payStamps is the economy test's to drive).
    payStamps: vi.fn(() => calls.push('payStamps')),
    openHallPanel: (...a: unknown[]) => openHallPanel.call(app, ...a),
  };
  return { app, ui, calls, inputManager };
}

describe('enterBuilding (P2-A2)', () => {
  test('a hall panel that throws still leaves the Leave button', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { app, ui, calls } = stubApp(() => {
      throw new TypeError("Cannot read properties of null (reading 'addEventListener')");
    });
    enterBuilding.call(app, 'contact', true, { id: 'contact', name: 'Get In Touch' });
    expect(ui.showLeaveButton).toHaveBeenCalledTimes(1);
    expect(ui.showZonePanel).toHaveBeenCalledTimes(1);
    // A stamp that landed before the panel threw is still paid (P2-A9).
    expect(app.payStamps).toHaveBeenCalledTimes(1);
    // The panel's error is logged where it happens, not swallowed by the fade.
    expect(calls).not.toContain('fadeThrough swallowed an error');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  test('Leave comes before the panel, and the panel still opens', () => {
    const { app, calls } = stubApp(() => undefined);
    enterBuilding.call(app, 'projects', true, { id: 'projects', name: 'Project Portfolio' });
    expect(calls).toEqual(['enterInterior', 'showLeaveButton', 'showZonePanel', 'payStamps']);
  });

  test('a cottage gets Leave and no panel', () => {
    const { app, ui } = stubApp(() => undefined);
    enterBuilding.call(app, 'house_0', false);
    expect(ui.showLeaveButton).toHaveBeenCalledTimes(1);
    expect(ui.showZonePanel).not.toHaveBeenCalled();
  });

  test('nothing happens while the visitor is already inside', () => {
    const { app, ui } = stubApp(() => undefined);
    app.scene.isInsideInterior = () => true;
    enterBuilding.call(app, 'projects', true, { id: 'projects', name: 'Project Portfolio' });
    expect(ui.showLeaveButton).not.toHaveBeenCalled();
  });

  test('a key pressed on the doorstep is dropped as the room opens (INT-12)', () => {
    const { app, inputManager } = stubApp(() => undefined);
    enterBuilding.call(app, 'house_0', false);
    expect(inputManager.clearLatched).toHaveBeenCalledTimes(1);
  });
});

// ---- P2-A1: the way out ----------------------------------------------------

/** A room the visitor stands in, with whatever may be open over it. */
function room(opts: { panel?: boolean; welcome?: boolean; watch?: boolean; zone?: boolean } = {}) {
  const state = {
    inside: true,
    panel: opts.panel ?? false,
    welcome: opts.welcome ?? false,
    watch: opts.watch ?? false,
  };
  const order: string[] = [];
  const mids: Array<() => void> = [];
  const ui = {
    panels: { isOpen: () => state.panel },
    isWelcomeVisible: () => state.welcome,
    isWatchOpen: () => state.watch,
    closeWatchFrame: vi.fn(() => {
      state.watch = false;
    }),
    // The veil: the swap runs later, at its peak.
    fadeThrough: vi.fn((mid: () => void) => {
      mids.push(mid);
    }),
    hideLeaveButton: vi.fn(() => order.push('hideLeaveButton')),
    hideZonePanel: vi.fn(() => order.push('hideZonePanel')),
  };
  const scene = {
    isInsideInterior: () => state.inside,
    exitInterior: vi.fn(() => {
      state.inside = false;
      order.push('exitInterior');
    }),
  };
  const inputManager = { clearLatched: vi.fn(() => order.push('clearLatched')) };
  const app = {
    ui,
    scene,
    inputManager,
    insideIsZone: opts.zone ?? true,
    leavingBuilding: false,
    exitBuilding(isZone: boolean): void {
      exitBuilding.call(app, isZone);
    },
  };
  /** The veil reaches its peak: every queued swap runs. */
  const peak = (): void => {
    for (const mid of mids.splice(0)) mid();
  };
  return { app, ui, scene, state, order, inputManager, peak };
}

const escape = (init: KeyboardEventInit = {}): KeyboardEvent =>
  new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, ...init });

describe('Escape indoors (P2-A1)', () => {
  test('nothing open: Escape leaves, through the door veil', () => {
    const r = room();
    onInteriorEscape.call(r.app, escape());
    expect(r.ui.fadeThrough).toHaveBeenCalledTimes(1);
    expect(r.state.inside).toBe(true); // still inside until the veil peaks
    r.peak();
    expect(r.state.inside).toBe(false);
    expect(r.ui.hideLeaveButton).toHaveBeenCalledTimes(1);
    expect(r.ui.hideZonePanel).toHaveBeenCalledTimes(1);
  });

  test('a panel open, or the name prompt up: the press is theirs, the visitor stays', () => {
    for (const opts of [{ panel: true }, { welcome: true }]) {
      const r = room(opts);
      onInteriorEscape.call(r.app, escape());
      expect(r.ui.fadeThrough, JSON.stringify(opts)).not.toHaveBeenCalled();
    }
  });

  test('the wall screen on: Escape steps away from it; the next one leaves', () => {
    const r = room({ watch: true, zone: false });
    onInteriorEscape.call(r.app, escape());
    expect(r.ui.closeWatchFrame).toHaveBeenCalledTimes(1);
    expect(r.ui.fadeThrough).not.toHaveBeenCalled();
    onInteriorEscape.call(r.app, escape());
    expect(r.ui.fadeThrough).toHaveBeenCalledTimes(1);
    r.peak();
    expect(r.ui.hideZonePanel).not.toHaveBeenCalled(); // a cottage has no hall panel
  });

  test('outdoors, another key, a held key or a handled key does nothing', () => {
    const out = room();
    out.state.inside = false;
    onInteriorEscape.call(out.app, escape());
    expect(out.ui.fadeThrough).not.toHaveBeenCalled();
    const r = room();
    onInteriorEscape.call(r.app, new KeyboardEvent('keydown', { key: 'e' }));
    onInteriorEscape.call(r.app, escape({ repeat: true }));
    const handled = escape();
    handled.preventDefault();
    onInteriorEscape.call(r.app, handled);
    expect(r.ui.fadeThrough).not.toHaveBeenCalled();
  });

  test('a second Escape (or Leave) while the veil closes starts no second veil', () => {
    const r = room();
    onInteriorEscape.call(r.app, escape());
    onInteriorEscape.call(r.app, escape());
    r.app.exitBuilding(true); // the Leave button, mid-fade
    expect(r.ui.fadeThrough).toHaveBeenCalledTimes(1);
    r.peak();
    expect(r.scene.exitInterior).toHaveBeenCalledTimes(1);
    // and the next room can be left again
    r.state.inside = true;
    onInteriorEscape.call(r.app, escape());
    expect(r.ui.fadeThrough).toHaveBeenCalledTimes(2);
  });

  test('no carry-over: latched presses are dropped as the door swaps (INT-12)', () => {
    const r = room();
    r.app.exitBuilding(true);
    expect(r.inputManager.clearLatched).not.toHaveBeenCalled();
    r.peak();
    // outside first, then the latches: Q pressed in the room never waves outside
    expect(r.order).toEqual(['exitInterior', 'clearLatched', 'hideLeaveButton', 'hideZonePanel']);
  });
});

// The rule the brief names: the press that closes the hall panel never also
// leaves, whatever order the document listeners run in. PanelManager and
// SimpleInputManager listen on the document; the app listens on window in the
// capture phase, which the browser runs before either.
describe('the capture-phase Escape rule (P2-A1)', () => {
  const added: Array<[EventTarget, EventListener, boolean]> = [];
  const on = (t: EventTarget, fn: EventListener, capture: boolean): void => {
    t.addEventListener('keydown', fn, capture);
    added.push([t, fn, capture]);
  };
  const off = (): void => {
    for (const [t, fn, capture] of added.splice(0)) t.removeEventListener('keydown', fn, capture);
  };
  afterEach(off);

  /** A room under an open hall panel: the panel's own Escape on the document
   *  (PanelManager's stand-in), the app's on window, in either order. */
  const wire = (panelFirst: boolean) => {
    const r = room({ panel: true });
    const panelEscape = (e: Event): void => {
      if ((e as KeyboardEvent).key === 'Escape' && r.state.panel) r.state.panel = false;
    };
    const appEscape = (e: Event): void => {
      onInteriorEscape.call(r.app, e as KeyboardEvent);
    };
    if (panelFirst) on(document, panelEscape, false);
    on(window, appEscape, true);
    if (!panelFirst) on(document, panelEscape, false);
    return r;
  };

  test('one Escape from the open hall panel: the panel closes, the visitor stays', () => {
    for (const panelFirst of [true, false]) {
      const r = wire(panelFirst);
      document.body.dispatchEvent(escape());
      expect(r.state.panel, `panelFirst=${panelFirst}`).toBe(false);
      expect(r.ui.fadeThrough, `panelFirst=${panelFirst}`).not.toHaveBeenCalled();
      off();
    }
  });

  test('Escape twice: the panel, then the door', () => {
    const r = wire(true);
    document.body.dispatchEvent(escape());
    document.body.dispatchEvent(escape());
    expect(r.ui.fadeThrough).toHaveBeenCalledTimes(1);
    r.peak();
    expect(r.state.inside).toBe(false);
  });

  test('the same handler on the document, after the panel closed, leaves on the first press', () => {
    // The bug the capture phase rules out: a bubble-phase listener registered
    // after PanelManager's sees no panel and leaves at once.
    const r = room({ panel: true });
    on(
      document,
      (e) => {
        if ((e as KeyboardEvent).key === 'Escape') r.state.panel = false;
      },
      false,
    );
    on(document, (e) => void onInteriorEscape.call(r.app, e as KeyboardEvent), false);
    document.body.dispatchEvent(escape());
    expect(r.ui.fadeThrough).toHaveBeenCalledTimes(1);
  });
});

// ---- P2-A11: hall exhibits say something and act on E ----------------------
describe('P2-A11: exhibits, their hotspot actions and the Leave label', () => {
  type M = (this: unknown, ...a: unknown[]) => unknown;
  let p: Record<string, M>;
  let EX: Record<string, { left?: { lines: string[] }; right?: unknown; screen?: unknown }>;
  let exFor: (id: string, touch: boolean) => unknown;
  beforeAll(async () => {
    const mod = await import('../main-simple');
    p = mod.SimpleApp.prototype as unknown as Record<string, M>;
    EX = (mod.SimpleApp as unknown as { INTERIOR_EXHIBITS: typeof EX }).INTERIOR_EXHIBITS;
    exFor = mod.SimpleApp.interiorExhibits;
  }, 120000);

  const app = () => {
    const ui = {
      showHireCard: vi.fn(),
      showZonePanel: vi.fn(),
      flashMessage: vi.fn(),
      showIslandTimes: vi.fn(async () => undefined),
    };
    const zones = [
      { id: 'professional', pos: { d: 0 } },
      { id: 'projects', pos: { d: 100 } },
      { id: 'contact', pos: { d: 4 } },
      { id: 'personal', pos: { d: 9 } },
    ];
    const stamped = new Set(['professional']);
    const a: Record<string, unknown> = {
      ui,
      insideZone: { id: 'welcome', name: 'Welcome' },
      zoneList: zones,
      zonePos: () => ({ distanceToSquared: (q: { d: number }) => q.d }),
      passport: { isStampZone: () => true, has: (id: string) => stamped.has(id) },
    };
    a.runExhibitArg = p.runExhibitArg.bind(a);
    return { a, ui };
  };

  test("'hire' opens the hire card; 'project:<id>' opens Projects at that card, never stamping", () => {
    const { a, ui } = app();
    expect(p.runInteriorAction.call(a, { action: 'panel', arg: 'hire' })).toBeUndefined();
    expect(ui.showHireCard).toHaveBeenCalledWith('cta');
    p.runInteriorAction.call(a, { action: 'panel', arg: 'project:banos' });
    expect(ui.showZonePanel).toHaveBeenLastCalledWith(
      { id: 'projects', name: 'projects' },
      { source: 'landmark', anchor: 'banos' },
    );
    p.runInteriorAction.call(a, { action: 'panel', arg: 'project' });
    expect(ui.showZonePanel).toHaveBeenLastCalledWith(
      { id: 'projects', name: 'projects' },
      { source: 'landmark' },
    );
  });

  test("'compass' sets the nearest unstamped district through 'ds:guide-to'", () => {
    const { a } = app();
    const seen: unknown[] = [];
    const on = (e: Event) => seen.push((e as CustomEvent).detail);
    window.addEventListener('ds:guide-to', on);
    p.runInteriorAction.call(a, { action: 'panel', arg: 'compass' });
    window.removeEventListener('ds:guide-to', on);
    expect(seen).toEqual([{ key: 'district:contact', source: 'interior' }]);
  });

  test("'copy:email' with no clipboard opens Contact at its form", () => {
    const { a, ui } = app();
    const nav = navigator as unknown as { clipboard?: unknown };
    const had = Object.getOwnPropertyDescriptor(nav, 'clipboard');
    Object.defineProperty(nav, 'clipboard', { value: undefined, configurable: true });
    try {
      p.runInteriorAction.call(a, { action: 'panel', arg: 'copy:email' });
    } finally {
      if (had) Object.defineProperty(nav, 'clipboard', had);
    }
    expect(ui.showZonePanel).toHaveBeenCalledWith(
      { id: 'contact', name: 'contact' },
      { source: 'landmark', anchor: 'lead-form-block' },
    );
  });

  test('the copy: five halls, no agents, no grandmother, no studio; four pegboard ids', () => {
    expect(Object.keys(EX).sort()).toEqual([
      'contact',
      'personal',
      'professional',
      'projects',
      'welcome',
    ]);
    const text = JSON.stringify(EX);
    expect(text).not.toMatch(/\bagents?\b|grandmother|studio|live AI/i);
    expect(text).toContain('founder & lead developer, DigiScalability');
    expect(text).toContain('Ammi');
    expect(text).toContain('open source (MIT)');
    expect(text).toContain('admin@digiscalability.com');
    const ids = [...text.matchAll(/"id":"([a-z]+)"/g)].map((m) => m[1]);
    expect(ids).toEqual(['rankpilot', 'chocomate', 'banos', 'insta']);
  });

  test('the posters name the key the visitor has: E on a keyboard, USE on touch', () => {
    for (const id of Object.keys(EX)) {
      const touch = JSON.stringify(exFor(id, true));
      const keys = JSON.stringify(exFor(id, false));
      expect(touch).not.toMatch(/\bE\b|\{use\}/i);
      expect(keys).not.toMatch(/\bUSE\b|\{use\}/);
      // the pegboard chips (and their ids) survive the rewrite
      expect(JSON.stringify(exFor(id, true)).match(/"id"/g)?.length ?? 0).toBe(
        JSON.stringify(EX[id]).match(/"id"/g)?.length ?? 0,
      );
    }
    expect(JSON.stringify(exFor('projects', true))).toContain('Tap USE at a card');
    expect(JSON.stringify(exFor('projects', false))).toContain('Press E at a card');
    expect(JSON.stringify(exFor('welcome', true))).toContain('tap USE to set the compass');
    expect(exFor('nowhere', true)).toBeUndefined();
  });
});
