// @vitest-environment happy-dom
//
// D10 with P2-D6: honest failure states on the boards. A board read that
// failed used to look like an empty board: the Leaderboard printed 'No times
// yet — be the first!', the Guestbook 'No notes yet', and the race finish
// claimed a place on the board whenever the read came back empty, which is
// also what a blocked backend returned. The panels now read through
// Boards.readLeaderboard / readGuestbook ({ok:true, entries} or {ok:false}),
// show the failure with a 44 px Retry, and the finish says "You're #N" only
// when the read-back holds this run. Run on a REAL SimpleUI with Boards
// stubbed; Boards' own readers run against a stubbed Firebase.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { BoardRead, GuestEntry, LeaderEntry } from '../Boards';
import { SimpleUI } from '../SimpleUI';
import { WORLD_ERA } from '../WorldScale';

const { readLeaderboard, readGuestbook, signGuestbook } = vi.hoisted(() => ({
  readLeaderboard: vi.fn(),
  readGuestbook: vi.fn(),
  signGuestbook: vi.fn(),
}));

const fb = vi.hoisted(() => ({ get: vi.fn(), realtime: vi.fn() }));
vi.mock('../firebaseClient', () => ({ getFirebaseRealtime: fb.realtime }));
vi.mock('firebase/database', () => ({
  ref: (_db: unknown, path: string) => ({ path }),
  query: (r: unknown) => r,
  limitToLast: (n: number) => n,
  get: fb.get,
}));

vi.mock('../Boards', () => ({
  readLeaderboard,
  readGuestbook,
  signGuestbook,
  getLeaderboard: vi.fn(async () => []),
  getGuestbook: vi.fn(async () => []),
  submitLead: vi.fn(async () => true),
}));

const ok = <T>(entries: T[]): BoardRead<T> => ({ ok: true, entries });
const FAIL: BoardRead<never> = { ok: false };
const flush = async (): Promise<void> => {
  // A macrotask or two: the panels reach Boards through a dynamic import.
  for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0));
};
const modalText = (): string => document.querySelector('[role="dialog"]')?.textContent ?? '';
const retry = (): HTMLButtonElement | null =>
  document.querySelector<HTMLButtonElement>('button[data-board-retry]');

let ui: SimpleUI;

beforeEach(() => {
  document.body.innerHTML = '<div id="ui-overlay"></div>';
  localStorage.clear();
  sessionStorage.clear();
  window.__analyticsLog = [];
  readLeaderboard.mockReset();
  readGuestbook.mockReset();
  signGuestbook.mockReset();
  ui = new SimpleUI('ui-overlay');
});

afterEach(() => {
  ui.panels.closeAll();
  ui.dispose();
  vi.useRealTimers();
});

describe('the race finish (showRaceLeaderboard)', () => {
  const board: LeaderEntry[] = [
    { name: 'Ada', timeMs: 41000 },
    { name: 'Abbas', timeMs: 43210 },
    { name: 'Grace', timeMs: 47000 },
  ];

  test("'Saving your time…' shows until the read returns", async () => {
    let answer!: (r: BoardRead<LeaderEntry>) => void;
    readLeaderboard.mockReturnValue(new Promise((r) => (answer = r)));
    void ui.showRaceLeaderboard('land', 43210, 'Abbas');
    await flush();
    expect(modalText()).toContain('Saving your time…');
    expect(modalText()).not.toMatch(/You're #|on the board/);
    answer(ok(board));
    await flush();
    expect(modalText()).not.toContain('Saving your time…');
  });

  test("ok, and the read-back holds this run: You're #N, the row marked (you)", async () => {
    readLeaderboard.mockResolvedValue(ok(board));
    await ui.showRaceLeaderboard('land', 43210, 'Abbas');
    expect(document.querySelector('#rlb-status')?.textContent).toBe(
      "You're #2 on the leaderboard.",
    );
    expect(modalText()).toContain('2. Abbas (you)');
    expect(retry()).toBeNull();
    expect(readLeaderboard).toHaveBeenCalledTimes(1);
  });

  test('ok, but this run is not in the read-back: the board, and no place claimed', async () => {
    readLeaderboard.mockResolvedValue(ok(board));
    await ui.showRaceLeaderboard('land', 52000, 'Abbas'); // slower than their best on the board
    expect(modalText()).toContain('1. Ada');
    expect(modalText()).not.toMatch(/You're #|\(you\)|on the board/);
  });

  test('a new best the first read missed gets one more read before anything is claimed', async () => {
    vi.useFakeTimers();
    localStorage.setItem(`ds_race_best_${WORLD_ERA}_land`, '43.21'); // RaceSystem saved it
    readLeaderboard
      .mockResolvedValueOnce(ok(board.filter((e) => e.name !== 'Abbas')))
      .mockResolvedValueOnce(ok(board));
    const shown = ui.showRaceLeaderboard('land', 43210, 'Abbas');
    await vi.advanceTimersByTimeAsync(100);
    expect(modalText()).toContain('Saving your time…');
    await vi.advanceTimersByTimeAsync(1500);
    await shown;
    expect(readLeaderboard).toHaveBeenCalledTimes(2);
    expect(document.querySelector('#rlb-status')?.textContent).toBe(
      "You're #2 on the leaderboard.",
    );
  });

  test('empty: no claim; the time is on this device', async () => {
    readLeaderboard.mockResolvedValue(ok([]));
    await ui.showRaceLeaderboard('water', 39500, 'Abbas');
    expect(modalText()).toContain('No times on the leaderboard yet.');
    expect(modalText()).toContain('Your best 39.50s is saved on this device.');
    expect(modalText()).not.toMatch(/on the board|You're #/);
    expect(retry()).toBeNull();
  });

  test("failure: Couldn't reach, the device's best, a 44 px Retry that reads again", async () => {
    localStorage.setItem(`ds_race_best_${WORLD_ERA}_land`, '41.5'); // an earlier, faster lap
    readLeaderboard.mockResolvedValueOnce(FAIL).mockResolvedValueOnce(ok(board));
    await ui.showRaceLeaderboard('land', 43210, 'Abbas');
    const alert = document.querySelector('[data-board-error]')!;
    expect(alert.getAttribute('role')).toBe('alert');
    expect(alert.textContent).toBe(
      "Couldn't reach the leaderboard — your best 41.50s is saved on this device.",
    );
    expect(modalText()).not.toMatch(/on the board|You're #|No times/);
    const btn = retry()!;
    expect(btn.textContent).toBe('Retry');
    expect(btn.style.minHeight).toBe('44px');
    btn.click();
    await flush();
    expect(readLeaderboard).toHaveBeenCalledTimes(2);
    expect(retry()).toBeNull();
    expect(document.querySelector('#rlb-status')?.textContent).toBe(
      "You're #2 on the leaderboard.",
    );
  });

  test('a Boards chunk that fails to load is a failed read, not a crash', async () => {
    readLeaderboard.mockRejectedValue(new Error('chunk load failed'));
    await ui.showRaceLeaderboard('land', null, 'Abbas');
    expect(modalText()).toContain("Couldn't reach the leaderboard.");
    expect(retry()).not.toBeNull();
  });

  test('the retired claim is gone from the source: never "you\'re on the board"', () => {
    const uiSrc = readFileSync(join(process.cwd(), 'SimpleUI.ts'), 'utf8');
    expect(uiSrc).not.toMatch(/you're on the board/i);
    // The panels read through the result-typed readers only.
    expect(uiSrc).not.toContain('getLeaderboard');
    expect(uiSrc).not.toContain('getGuestbook');
  });
});

describe('the Leaderboard and the Guestbook say when they could not be read', () => {
  test('Leaderboard: one failed circuit shows the error and Retry, never "No times yet"', async () => {
    readLeaderboard.mockImplementation(async (circuit: string) =>
      circuit === 'land' ? ok([{ name: 'Ada', timeMs: 41000 }]) : FAIL,
    );
    await ui.showLeaderboard();
    expect(modalText()).toContain("Couldn't reach the leaderboard.");
    expect(modalText()).not.toContain('No times yet');
    readLeaderboard.mockResolvedValue(ok([]));
    retry()!.click();
    await flush();
    expect(retry()).toBeNull();
    expect(modalText()).toContain('No times yet — be the first!'); // a real empty board
    expect(ui.panels.current()).toBe('leaderboard');
  });

  test('Guestbook: the error and Retry; a retry that works lists the notes', async () => {
    const notes: GuestEntry[] = [{ name: 'Ada', msg: 'Lovely island <b>', t: 2 }];
    readGuestbook.mockResolvedValueOnce(FAIL).mockResolvedValueOnce(ok(notes));
    await ui.showGuestbook();
    expect(modalText()).toContain("Couldn't reach the guestbook.");
    expect(modalText()).not.toContain('No notes yet');
    expect(retry()!.style.minHeight).toBe('44px');
    retry()!.click();
    await flush();
    expect(retry()).toBeNull();
    expect(document.querySelector('#gb-body')!.innerHTML).toContain('Lovely island &lt;b&gt;');
  });
});

describe('Boards: result-typed readers beside the array getters', () => {
  // The real module, over a stubbed Firebase (the file-level mock above is
  // what SimpleUI imports).
  const real = (): Promise<typeof import('../Boards')> => vi.importActual('../Boards');

  beforeEach(() => {
    fb.get.mockReset();
    fb.realtime.mockReset();
    fb.realtime.mockResolvedValue({ db: {}, uid: 'u1' });
  });

  test('ok: entries sorted and capped; the array getter returns the same array', async () => {
    fb.get.mockResolvedValue({
      val: () => ({
        a: { name: 'Grace', timeMs: 47000 },
        b: { name: 'Ada', timeMs: 41000 },
        c: { name: 'no time' },
      }),
    });
    const boards = await real();
    const want = [
      { name: 'Ada', timeMs: 41000 },
      { name: 'Grace', timeMs: 47000 },
    ];
    expect(await boards.readLeaderboard('land')).toEqual({ ok: true, entries: want });
    expect(await boards.getLeaderboard('land')).toEqual(want);
  });

  test('an empty board is ok with no entries, not a failure', async () => {
    fb.get.mockResolvedValue({ val: () => null });
    const boards = await real();
    expect(await boards.readLeaderboard('water')).toEqual({ ok: true, entries: [] });
    expect(await boards.readGuestbook()).toEqual({ ok: true, entries: [] });
  });

  test('a read that throws is {ok:false}; the array getters still answer []', async () => {
    fb.get.mockRejectedValue(new Error('permission_denied'));
    const boards = await real();
    expect(await boards.readLeaderboard('land')).toEqual({ ok: false });
    expect(await boards.readGuestbook()).toEqual({ ok: false });
    expect(await boards.getLeaderboard('land')).toEqual([]);
    expect(await boards.getGuestbook(25)).toEqual([]);
  });

  test('a read that never answers fails at 8 s', async () => {
    vi.useFakeTimers();
    fb.realtime.mockReturnValue(new Promise(() => {})); // sign-in stalls
    const boards = await real();
    expect(boards.BOARD_READ_TIMEOUT_MS).toBe(8000);
    let res: BoardRead<LeaderEntry> | null = null;
    void boards.readLeaderboard('land').then((r) => (res = r));
    await vi.advanceTimersByTimeAsync(7900);
    expect(res).toBeNull();
    await vi.advanceTimersByTimeAsync(200);
    expect(res).toEqual({ ok: false });
  });
});
