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
import { beforeAll, describe, expect, test, vi } from 'vitest';

// main-simple calls inject() at module load. Under happy-dom that appends the
// analytics script tag and happy-dom FETCHES it: a unit test on the network.
vi.mock('@vercel/analytics', () => ({ inject: vi.fn(), track: vi.fn() }));

type Fn = (...a: unknown[]) => unknown;
let enterBuilding: Fn;

beforeAll(async () => {
  (window as unknown as { __lifeIslandBooted?: boolean }).__lifeIslandBooted = true;
  const mod = await import('../main-simple');
  enterBuilding = (mod.SimpleApp.prototype as unknown as { enterBuilding: Fn }).enterBuilding;
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
  const app = { ui, scene, markDone: vi.fn(), insideZone: null, insideIsZone: false };
  return { app, ui, calls };
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
    // The panel's error is logged where it happens, not swallowed by the fade.
    expect(calls).not.toContain('fadeThrough swallowed an error');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  test('Leave comes before the panel, and the panel still opens', () => {
    const { app, calls } = stubApp(() => undefined);
    enterBuilding.call(app, 'projects', true, { id: 'projects', name: 'Project Portfolio' });
    expect(calls).toEqual(['enterInterior', 'showLeaveButton', 'showZonePanel']);
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
});
