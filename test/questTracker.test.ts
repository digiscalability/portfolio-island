// @vitest-environment happy-dom
//
// Quest givers say they have a request, a quest giver can be chatted with
// again, and race times reach the board under a real name (P2-A7).
//
// NpcQuests gains pure reads (talkKind, hasPendingStep, getActiveQuests) that
// say what onTalk would do without doing it. main-simple's onNpcInteract and
// onRaceEvent run here for real, on a stub app: SimpleApp is exported, and
// the boot latch is set before the import so the module builds no app. The
// chat itself (openVillagerChat) and the board write (submitRaceTime) are the
// seams the stubs replace, so nothing here reaches a backend.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

import { NpcQuestSystem, type QuestTalk, type TalkResult } from '../NpcQuests';

// main-simple calls inject() at module load. Under happy-dom that appends the
// analytics script tag and happy-dom FETCHES it: a unit test on the network.
vi.mock('@vercel/analytics', () => ({ inject: vi.fn(), track: vi.fn() }));

const VILLAGERS = ['Elder Sage', 'Storyteller', 'Village Baker', 'Fisherman', 'Gardener', 'Mayor'];

/** What a TalkResult did, in talkKind's words. */
const kindOf = (r: TalkResult | null): QuestTalk =>
  r === null ? null : r.accepted ? 'offer' : r.pickedUp || r.completed ? 'errand' : 'status';

beforeEach(() => {
  localStorage.clear();
});

describe('NpcQuests.talkKind: what E on a villager would do, without doing it', () => {
  test('a fresh visit: every giver has a request, nobody else is involved', () => {
    const q = new NpcQuestSystem();
    for (const giver of ['Elder Sage', 'Village Baker', 'Gardener']) {
      expect(q.talkKind(giver), giver).toBe('offer');
      expect(q.hasPendingStep(giver), giver).toBe(true);
    }
    for (const other of ['Storyteller', 'Fisherman', 'Mayor', 'Market Vendor']) {
      expect(q.talkKind(other), other).toBeNull();
      expect(q.hasPendingStep(other), other).toBe(false);
    }
  });

  test('it agrees with onTalk for every villager through all three quests', () => {
    // A copy of the saved state answers onTalk; the live system answers
    // talkKind. The script below walks every state the catalogue has.
    const live = new NpcQuestSystem();
    const KEY = 'ds_npc_quests';
    const restore = (state: string | null): void => {
      if (state === null) localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, state);
    };
    /** For every villager: talkKind on the live system against onTalk on a
     *  fresh copy of its saved state (a copy's onTalk saves, so the live
     *  state is put back before each copy and after the last). */
    const step = (coins: number, where: string): void => {
      const state = localStorage.getItem(KEY);
      for (const name of VILLAGERS) {
        restore(state);
        const copy = new NpcQuestSystem();
        expect(live.talkKind(name, coins), `${where}: ${name}`).toBe(
          kindOf(copy.onTalk(name, coins)),
        );
      }
      restore(state);
    };
    const talk = (name: string, coins: number): TalkResult | null => live.onTalk(name, coins);

    step(0, 'fresh');
    // the relay: accept at the Sage, complete at the Storyteller
    expect(talk('Elder Sage', 0)?.accepted?.id).toBe('sage_greetings');
    step(0, 'sage accepted');
    expect(live.talkKind('Elder Sage')).toBe('status');
    expect(live.talkKind('Storyteller')).toBe('errand');
    expect(talk('Storyteller', 0)?.completed?.id).toBe('sage_greetings');
    step(0, 'sage done');
    expect(live.talkKind('Storyteller')).toBeNull();
    expect(live.talkKind('Elder Sage')).toBe('status'); // her thank-you
    // the fetch: accept at the Baker, pick up at the Fisherman, deliver
    expect(talk('Village Baker', 0)?.accepted?.id).toBe('baker_catch');
    step(0, 'baker accepted');
    expect(live.talkKind('Village Baker')).toBe('status');
    expect(live.talkKind('Fisherman')).toBe('errand');
    expect(talk('Fisherman', 0)?.pickedUp?.id).toBe('baker_catch');
    step(0, 'fish in hand');
    expect(live.talkKind('Fisherman')).toBeNull();
    expect(live.talkKind('Village Baker')).toBe('errand');
    expect(talk('Village Baker', 0)?.completed?.id).toBe('baker_catch');
    step(0, 'baker done');
    // the coins: accept with 3 held, short at 5, enough at 8
    expect(talk('Gardener', 3)?.accepted?.id).toBe('gardener_coins');
    step(5, 'gardener short');
    expect(live.talkKind('Gardener', 5)).toBe('status');
    expect(live.hasPendingStep('Gardener', 5)).toBe(false);
    step(8, 'gardener ready');
    expect(live.talkKind('Gardener', 8)).toBe('errand');
    expect(live.hasPendingStep('Gardener', 8)).toBe(true);
    expect(talk('Gardener', 8)?.completed?.id).toBe('gardener_coins');
    step(8, 'all done');
    for (const name of VILLAGERS) expect(live.hasPendingStep(name, 8), name).toBe(false);
  });

  test('the reads change nothing', () => {
    const q = new NpcQuestSystem();
    q.onTalk('Gardener', 2); // accept, so there is state to disturb
    const saved = localStorage.getItem('ds_npc_quests');
    for (let i = 0; i < 3; i++) {
      for (const name of VILLAGERS) {
        q.talkKind(name, 9);
        q.hasPendingStep(name, 9);
      }
      q.getActiveQuests(9);
    }
    expect(localStorage.getItem('ds_npc_quests')).toBe(saved);
    // still the same answer, and onTalk still completes once
    expect(q.talkKind('Gardener', 9)).toBe('errand');
    expect(q.onTalk('Gardener', 9)?.completed?.id).toBe('gardener_coins');
  });
});

describe('NpcQuests.getActiveQuests: accepted quests with where they stand', () => {
  test('none until one is accepted; done quests drop off', () => {
    const q = new NpcQuestSystem();
    expect(q.getActiveQuests()).toEqual([]);
    q.onTalk('Elder Sage', 0);
    expect(q.getActiveQuests()).toEqual([
      {
        id: 'sage_greetings',
        giver: 'Elder Sage',
        label: 'a message for the Storyteller',
        progress: 'to deliver',
      },
    ]);
    q.onTalk('Storyteller', 0);
    expect(q.getActiveQuests()).toEqual([]);
  });

  test("the Gardener's coins count from the accept, and stop at the target", () => {
    const q = new NpcQuestSystem();
    q.onTalk('Gardener', 3);
    const row = (coins: number) => q.getActiveQuests(coins)[0];
    expect(row(3)).toEqual({
      id: 'gardener_coins',
      giver: 'Gardener',
      label: 'dew-coins',
      progress: '0/5',
    });
    expect(row(5).progress).toBe('2/5');
    expect(row(2).progress).toBe('0/5'); // coins spent since: never negative
    expect(row(40).progress).toBe('5/5');
    // the chip's line, as the brief writes it
    const r = row(5);
    expect(`${r.giver}: ${r.label} ${r.progress}`).toBe('Gardener: dew-coins 2/5');
  });

  test('the fetch says whether the fish is in hand; order follows the catalogue', () => {
    const q = new NpcQuestSystem();
    q.onTalk('Gardener', 0);
    q.onTalk('Village Baker', 0);
    expect(q.getActiveQuests().map((x) => x.id)).toEqual(['baker_catch', 'gardener_coins']);
    expect(q.getActiveQuests()[0]).toMatchObject({
      giver: 'Village Baker',
      label: 'a fish from the Fisherman',
      progress: 'to collect',
    });
    q.onTalk('Fisherman', 0);
    expect(q.getActiveQuests()[0].progress).toBe('in hand, take it back');
  });

  test('a reload keeps the list (state is saved)', () => {
    new NpcQuestSystem().onTalk('Gardener', 1);
    expect(new NpcQuestSystem().getActiveQuests(3)).toEqual([
      { id: 'gardener_coins', giver: 'Gardener', label: 'dew-coins', progress: '2/5' },
    ]);
  });
});

describe('P2-A10: the Gardener counts meadow pickups, not held coins', () => {
  test('accept, spend 3, pick up 5 meadow coins: complete; a +10 lesson and trail coins add nothing', () => {
    const q = new NpcQuestSystem();
    q.useMeadowCounter();
    expect(q.onTalk('Gardener', 10)?.accepted?.id).toBe('gardener_coins');
    // spend 3 at the shop: held coins fall to 7, progress stays 0
    expect(q.getActiveQuests(7)[0].progress).toBe('0/5');
    // a +10 lesson: held coins jump, progress does not
    expect(q.getActiveQuests(17)[0].progress).toBe('0/5');
    expect(q.talkKind('Gardener', 17)).toBe('status');
    // trail coins never count
    for (let i = 0; i < 5; i++) q.onMeadowCoin({ trail: true });
    expect(q.getActiveQuests(22)[0].progress).toBe('0/5');
    for (let i = 0; i < 4; i++) q.onMeadowCoin({ trail: false });
    expect(q.getActiveQuests(0)[0].progress).toBe('4/5');
    expect(q.onTalk('Gardener', 0)?.completed).toBeUndefined();
    q.onMeadowCoin({ trail: false });
    expect(q.talkKind('Gardener', 0)).toBe('errand');
    expect(q.onTalk('Gardener', 0)?.completed?.id).toBe('gardener_coins');
  });

  test('pickups before the accept do not count, and the counter survives a reload', () => {
    const q = new NpcQuestSystem();
    q.onMeadowCoin({ trail: false });
    q.onTalk('Gardener', 1);
    q.onMeadowCoin({ trail: false });
    q.onMeadowCoin({ trail: false });
    const r = new NpcQuestSystem();
    r.useMeadowCounter();
    expect(r.getActiveQuests(99)[0].progress).toBe('2/5');
  });

  test('an active quest in an old save (no meadowCoins) restarts at 0', () => {
    localStorage.setItem(
      'ds_npc_quests',
      JSON.stringify({ gardener_coins: { state: 'active', coinBaseline: 0 } }),
    );
    const q = new NpcQuestSystem();
    q.useMeadowCounter();
    expect(q.getActiveQuests(40)[0].progress).toBe('0/5');
    q.onMeadowCoin({ trail: false });
    expect(q.getActiveQuests(40)[0].progress).toBe('1/5');
    // coinBaseline stays in the save shape for one release
    const saved = JSON.parse(localStorage.getItem('ds_npc_quests') ?? '{}');
    expect(saved.gardener_coins).toMatchObject({ coinBaseline: 0, meadowCoins: 1 });
  });

  test('without the scene feed, the held-coins arithmetic as before', () => {
    const q = new NpcQuestSystem();
    q.onTalk('Gardener', 3);
    expect(q.getActiveQuests(8)[0].progress).toBe('5/5');
  });
});

// ---- main-simple: the talk handler and the race finish ----------------------

type Fn = (this: unknown, ...a: unknown[]) => unknown;
let proto: Record<string, Fn>;

beforeAll(async () => {
  (window as unknown as { __lifeIslandBooted?: boolean }).__lifeIslandBooted = true;
  const mod = await import('../main-simple');
  proto = mod.SimpleApp.prototype as unknown as Record<string, Fn>;
}, 120000);

describe('main-simple: E on a quest giver (P2-A7)', () => {
  /** The app's fields onNpcInteract reads; the chat itself is a stub. */
  const stubApp = (coins = 0) => {
    const ui = {
      showDialogue: vi.fn(),
      showQuestComplete: vi.fn(),
    };
    const scene = {
      getCoinsCollected: () => coins,
      setQuestMarkers: vi.fn(),
      setPlayerCarryingFish: vi.fn(),
      deliverFishToBaker: vi.fn(),
      addCoins: vi.fn(),
      floatCoinsAtPlayer: vi.fn(),
      logTransaction: vi.fn(),
    };
    const app: Record<string, unknown> = {
      ui,
      scene,
      npcQuests: new NpcQuestSystem(),
      questLinesShown: new Set<string>(),
      guide: { complete: vi.fn() },
      openShop: vi.fn(),
      openVillagerChat: vi.fn(),
      beginNpcDialogue: vi.fn(),
    };
    app.questLinesFirst = proto.questLinesFirst.bind(app);
    const press = (name: string): void => {
      proto.onNpcInteract.call(app, { name, dialogue: [`${name}'s own line`] });
    };
    return { app, ui, scene, press, chat: app.openVillagerChat as ReturnType<typeof vi.fn> };
  };

  test('the first E takes her request; the next E opens the chat', () => {
    const { ui, press, chat } = stubApp();
    press('Elder Sage');
    expect(ui.showDialogue).toHaveBeenCalledTimes(1);
    expect(ui.showDialogue.mock.calls[0][0]).toBe('Elder Sage');
    expect((ui.showDialogue.mock.calls[0][1] as string[]).join(' ')).toContain('Quest accepted');
    expect(chat).not.toHaveBeenCalled();
    // Her reminder ('Have you found the Storyteller yet?') used to answer
    // every later press, for the rest of the visit.
    press('Elder Sage');
    expect(ui.showDialogue).toHaveBeenCalledTimes(1);
    expect(chat).toHaveBeenCalledTimes(1);
    expect(chat.mock.calls[0][0]).toMatchObject({ name: 'Elder Sage' });
  });

  test('a reminder not yet heard this session shows once, then the chat', () => {
    // A returning visitor: the quest was accepted on an earlier visit.
    new NpcQuestSystem().onTalk('Elder Sage', 0);
    const { ui, press, chat } = stubApp();
    press('Elder Sage');
    expect((ui.showDialogue.mock.calls[0][1] as string[])[0]).toBe(
      'Have you found the Storyteller yet?',
    );
    press('Elder Sage');
    press('Elder Sage');
    expect(ui.showDialogue).toHaveBeenCalledTimes(1);
    expect(chat).toHaveBeenCalledTimes(2);
  });

  test('a step always wins: a pickup, a delivery and a completion show their lines', () => {
    const { app, ui, scene, press, chat } = stubApp();
    press('Village Baker'); // accept
    press('Village Baker'); // her lines are heard: the chat
    expect(chat).toHaveBeenCalledTimes(1);
    press('Fisherman'); // the pickup is a step
    expect(scene.setPlayerCarryingFish).toHaveBeenCalledWith(true);
    press('Village Baker'); // the delivery is a step, though her lines were heard
    expect(ui.showDialogue).toHaveBeenCalledTimes(3);
    expect(ui.showQuestComplete).toHaveBeenCalledTimes(1);
    expect(scene.deliverFishToBaker).toHaveBeenCalledTimes(1);
    expect(scene.addCoins).toHaveBeenCalledWith(6);
    // every quest dialogue counts as the guide's talk step
    expect((app.guide as { complete: ReturnType<typeof vi.fn> }).complete).toHaveBeenCalledTimes(3);
    // and with the quest done she is a villager to chat with
    press('Village Baker');
    expect(chat).toHaveBeenCalledTimes(2);
  });

  test('a villager with no quest goes straight to the chat; the Market Vendor to the shop', () => {
    const { app, ui, press, chat } = stubApp();
    press('Mayor');
    expect(chat).toHaveBeenCalledTimes(1);
    expect(ui.showDialogue).not.toHaveBeenCalled();
    press('Market Vendor');
    expect(app.openShop).toHaveBeenCalledTimes(1);
  });

  test('questLinesFirst: what the prompt and the First steps card read', () => {
    const { app, press } = stubApp();
    const first = (name: string, coins = 0): boolean =>
      (app.questLinesFirst as (n: string, c: number) => boolean)(name, coins);
    expect(first('Elder Sage')).toBe(true); // a request: 'has a request'
    expect(first('Mayor')).toBe(false); // nothing: 'ask anything'
    press('Elder Sage');
    expect(first('Elder Sage')).toBe(false); // heard: the next E is the chat
    expect(first('Storyteller')).toBe(true); // the errand moves on here
  });
});

describe('main-simple: a race finish goes to the board under a real name (P2-A7)', () => {
  /** The app's fields onRaceEvent reads, with Boards behind a stub. */
  const stubApp = (name: (app: Record<string, unknown>) => void) => {
    const board: Array<[string, number, string]> = [];
    const ui = {
      updateCoinCounter: vi.fn(),
      flashMessage: vi.fn(),
      showRaceLeaderboard: vi.fn(),
    };
    const scene = {
      addCoins: vi.fn(),
      floatCoinsAtPlayer: vi.fn(),
      logTransaction: vi.fn(),
      getCoinsCollected: () => 0,
      setRaceChallenge: vi.fn(),
    };
    const prompts = { shown: 0 };
    const app: Record<string, unknown> = {
      ui,
      scene,
      raceChallenge: null,
      raceGuideTarget: null,
      nameTyped: false,
      multiplayer: { selfName: 'Sunny Courier' }, // the placeholder minted for the name tag
      markDone: vi.fn(),
      // Boards, stubbed: the lazy import and the write are behind this seam.
      submitRaceTime: (c: string, t: number, n: string) => board.push([c, t, n]),
      // ensureNamed's contract: the prompt once, then the callback.
      ensureNamed: (then: () => void) => {
        if (prompts.shown === 0) {
          prompts.shown++;
          name(app);
        }
        then();
      },
    };
    app.boardName = proto.boardName.bind(app);
    const finish = (timeSec: number, improved: boolean): void => {
      proto.onRaceEvent.call(app, {
        kind: 'finish',
        text: `Finished in ${timeSec}s`,
        timeSec,
        circuit: 'land',
        improved,
      });
    };
    return { app, ui, scene, board, finish, prompts };
  };
  /** The visitor types a name at the prompt (Multiplayer.setName saves it). */
  const types = (typed: string) => (app: Record<string, unknown>) => {
    (app.multiplayer as { selfName: string }).selfName = typed;
    localStorage.setItem('ds_player_name', typed);
    app.nameTyped = true;
  };
  const skips = (): void => undefined;

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test('a finish that is not a local best still reaches the board, with the typed name', () => {
    const { board, finish, ui, scene } = stubApp(types('Rania'));
    finish(71.25, false);
    expect(board).toEqual([['land', 71.25, 'Rania']]);
    expect(scene.addCoins).toHaveBeenCalledWith(5); // a finish pays, a best pays more
    // the leaderboard follows a beat later, under the same name
    expect(ui.showRaceLeaderboard).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1200);
    expect(ui.showRaceLeaderboard).toHaveBeenCalledWith('land', 71250, 'Rania');
  });

  test('every finish is sent, and the name is asked once', () => {
    const { board, finish, prompts } = stubApp(types('Rania'));
    finish(71.25, true);
    finish(73.5, false);
    finish(69.9, true);
    expect(board.map((b) => b[1])).toEqual([71.25, 73.5, 69.9]);
    expect(board.every((b) => b[2] === 'Rania')).toBe(true);
    expect(prompts.shown).toBe(1);
  });

  test("Skip goes up as 'Guest', never the name tag's placeholder", () => {
    const { board, finish, ui } = stubApp(skips);
    finish(80, true);
    expect(board).toEqual([['land', 80, 'Guest']]);
    vi.advanceTimersByTime(1200);
    expect(ui.showRaceLeaderboard).toHaveBeenCalledWith('land', 80000, 'Guest');
  });

  test('a name saved on an earlier visit is used without asking', () => {
    localStorage.setItem('ds_player_name', 'Imran');
    const { app, board, finish } = stubApp(skips);
    (app.multiplayer as { selfName: string }).selfName = 'Imran';
    finish(64, false);
    expect(board).toEqual([['land', 64, 'Imran']]);
  });

  test('start and checkpoint events send nothing to the board', () => {
    const { app, board, ui } = stubApp(skips);
    proto.onRaceEvent.call(app, { kind: 'start', text: 'GO!', circuit: 'land' });
    proto.onRaceEvent.call(app, { kind: 'checkpoint', text: 'Checkpoint 2/8' });
    expect(board).toEqual([]);
    expect(ui.flashMessage).toHaveBeenCalledTimes(2);
  });
});

describe('main-simple: the Compass set toast waits out the guide card (wave-3 carry-over)', () => {
  /** The fields compassSetToast reads: the guide, the route and the Next chip. */
  const stubApp = (s: { steps?: boolean; route?: boolean; chipOpen?: boolean }) => {
    const toast = vi.fn();
    const app: Record<string, unknown> = {
      ui: { toast },
      guide: { isActive: () => !!s.steps },
      route: { showing: () => !!s.route },
      nextChip: { isExpanded: () => !!s.chipOpen },
    };
    app.guideCardOut = proto.guideCardOut.bind(app);
    return { app, toast, say: (t: string) => proto.compassSetToast.call(app, t) };
  };

  test('with no card out, the toast shows', () => {
    const { toast, say } = stubApp({});
    say('🧭 Compass set: 🚀 Projects');
    expect(toast).toHaveBeenCalledWith('🧭 Compass set: 🚀 Projects');
  });

  test.each([
    ['First steps unfolded', { steps: true }],
    ['the recruiter route', { route: true }],
    ["the Next chip's open list", { chipOpen: true }],
  ])('under %s, it is dropped', (_, s) => {
    const { toast, say } = stubApp(s);
    say('🧭 Compass set: 🚀 Projects');
    expect(toast).not.toHaveBeenCalled();
  });

  test('before the guide exists (no guide, route or chip yet), the toast shows', () => {
    const toast = vi.fn();
    const app: Record<string, unknown> = {
      ui: { toast },
      guide: null,
      route: null,
      nextChip: null,
    };
    app.guideCardOut = proto.guideCardOut.bind(app);
    proto.compassSetToast.call(app, '🧭 Compass set: 🏦 Bank');
    expect(toast).toHaveBeenCalledTimes(1);
  });
});

describe('main-simple: School lessons read right on a phone (wave-3 p2/copy carry-over)', () => {
  type Lesson = [string, string];
  let lessons: Lesson[] = [];
  beforeAll(async () => {
    const mod = await import('../main-simple');
    lessons = (mod.SimpleApp as unknown as { LESSONS: Lesson[] }).LESSONS;
  }, 120000);

  /** What lessonCopy hands the toast on a touch device. The toast then maps
   *  'press E', 'press G' and 'press Q' to the USE, EAT and WAVE buttons
   *  (SimpleUI.touchifyPlain, D's), so those forms are the only key words a
   *  phone lesson may carry. */
  const onPhone = (l: Lesson): string =>
    proto.lessonCopy.call({ ui: { isTouchDevice: () => true } }, l) as string;
  const onDesktop = (l: Lesson): string =>
    proto.lessonCopy.call({ ui: { isTouchDevice: () => false } }, l) as string;

  test('no lesson names a keyboard key on a phone, beyond the press E/G/Q the toast maps', () => {
    expect(lessons.length).toBe(6);
    for (const l of lessons) {
      const said = onPhone(l).replace(/[Pp]ress [EGQ]\b/g, 'tap');
      expect(said, l[0]).not.toMatch(/\bWASD\b|\bSpace\b|\bShift\b|\b[A-Z]\b/);
    }
    expect(onPhone(lessons.find(([id]) => id === 'fish') as Lesson)).toContain('press E to cast');
  });

  test('the desktop copy keeps its keys, and no lesson types a villager count', () => {
    expect(onDesktop(lessons.find(([id]) => id === 'move') as Lesson)).toContain(
      'hold Shift to run',
    );
    for (const l of lessons) {
      expect(l[1]).not.toMatch(/\bdozen\b/i);
      expect(l[1]).not.toMatch(/\d+\s+(of them|villagers)/i);
    }
  });
});

describe('main-simple: run intent, first-use hint gates and heel-strike footfalls (A11, A13)', () => {
  beforeAll(async () => {
    await import('../main-simple');
  }, 120000);
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const still = { forward: 0, strafe: 0 };
  const rim = { forward: 1, strafe: 0 };
  const near = { forward: 0.9, strafe: 0 };
  const runApp = (shift: boolean): Record<string, unknown> => ({
    stickRimSince: -1,
    inputManager: { getRunInput: () => shift },
  });

  test('Shift runs on land only; Space alone never runs; the stick runs after 250 ms at the rim', () => {
    let now = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const ri = (
      app: Record<string, unknown>,
      jump: boolean,
      joy: typeof still,
      water: boolean,
    ): boolean => proto.runIntent.call(app, jump, joy, water) as boolean;
    expect(ri(runApp(true), false, still, false)).toBe(true);
    expect(ri(runApp(true), false, still, true)).toBe(false); // Shift in water dives, never runs
    expect(ri(runApp(false), true, still, false)).toBe(false); // Space only jumps
    const touch = runApp(false);
    expect(ri(touch, false, rim, false)).toBe(false);
    now += 249;
    expect(ri(touch, false, rim, false)).toBe(false);
    now += 2;
    expect(ri(touch, false, rim, false)).toBe(true);
    expect(ri(touch, false, rim, true)).toBe(false);
    expect(ri(touch, false, near, false)).toBe(false); // under 0.95 resets the timer
    now += 1000;
    expect(ri(touch, false, near, false)).toBe(false);
    expect(ri(touch, false, rim, false)).toBe(false);
  });

  test('legacyrun keeps the old hold-Space run, and footfalls sit on the heel strikes', () => {
    const src = readFileSync(join(process.cwd(), 'main-simple.ts'), 'utf8').replace(/\r\n/g, '\n');
    const body = src.slice(
      src.indexOf('  private runIntent('),
      src.indexOf('  private crossedPhase('),
    );
    expect(body).toMatch(/if \(SimpleApp\.LEGACY_RUN\) return jumpInput;/);
    expect(src).not.toMatch(/setRunIntent\(\s*jumpInput\s*&&/);
    expect(src).toMatch(/crossedPhase\(this\.prevWalkPhase, walkPhase, 0\.0\)/);
    expect(src).toMatch(/crossedPhase\(this\.prevWalkPhase, walkPhase, 0\.5\)/);
    expect(src).not.toMatch(/crossedPhase\(this\.prevWalkPhase, walkPhase, 0\.(25|75)\)/);
  });

  test('crossedPhase counts the wrap past 1.0 as crossing 0.0, and a fresh stride crosses nothing', () => {
    const cp = (p: number, c: number, t: number): boolean =>
      proto.crossedPhase.call({}, p, c, t) as boolean;
    expect(cp(0.97, 0.03, 0.0)).toBe(true);
    expect(cp(0.03, 0.2, 0.0)).toBe(false);
    expect(cp(0.45, 0.55, 0.5)).toBe(true);
    expect(cp(0.55, 0.6, 0.5)).toBe(false);
    expect(cp(-1, 0.6, 0.5)).toBe(false);
  });

  test('a first-use hint waits while any panel, card, interior, tour, talk, guide or Next list is up', () => {
    const quietWith = (o: Partial<Record<string, boolean>>): boolean =>
      proto.hintsQuiet.call({
        racing: !!o.racing,
        ui: { panels: { isOpen: () => !!o.panel }, isWelcomeVisible: () => !!o.welcome },
        scene: { isInsideInterior: () => !!o.interior },
        tour: o.tour ? {} : null,
        npcCine: o.talk ? {} : null,
        guide: { isActive: () => !!o.guide },
        nextChip: { isExpanded: () => !!o.next },
      }) as boolean;
    expect(quietWith({})).toBe(false);
    for (const gate of [
      'racing',
      'panel',
      'welcome',
      'interior',
      'tour',
      'talk',
      'guide',
      'next',
    ]) {
      expect(quietWith({ [gate]: true }), gate).toBe(true);
    }
  });
});

// ---- P2-A9: learning about Abbas pays, and the School teaches by doing ------
describe('main-simple: the first-visit economy (P2-A9)', () => {
  type M = (this: unknown, ...a: unknown[]) => unknown;
  let p: Record<string, M>;
  let LESSONS: Array<[string, string]> = [];
  let S: Record<string, number>;
  beforeAll(async () => {
    (window as unknown as { __lifeIslandBooted?: boolean }).__lifeIslandBooted = true;
    const mod = await import('../main-simple');
    p = mod.SimpleApp.prototype as unknown as Record<string, M>;
    S = mod.SimpleApp as unknown as Record<string, number>;
    LESSONS = (mod.SimpleApp as unknown as { LESSONS: Array<[string, string]> }).LESSONS;
  }, 120000);

  /** A stub app wired with the real pay methods; coins and tracks are recorded. */
  const stub = (o: { stamps?: number; touch?: boolean } = {}) => {
    const log: Array<[string, number]> = [];
    const events: Array<[string, unknown]> = [];
    let coins = 0;
    const app: Record<string, unknown> = {
      lessons: [] as string[],
      lessonActs: new Set<string>(),
      schoolEnrolled: false,
      stampsPaid: -1,
      ownedRod: false,
      ownedAxe: false,
      passport: { count: () => o.stamps ?? 0 },
      scene: {
        addCoins: (n: number) => (coins += n),
        floatCoinsAtPlayer: () => undefined,
        logTransaction: (why: string, n: number) => log.push([why, n]),
        getCoinsCollected: () => coins,
      },
      ui: {
        updateCoinCounter: () => undefined,
        toast: () => undefined,
        isTouchDevice: () => !!o.touch,
        showLessons: vi.fn(),
      },
      persistLessons: () => undefined,
    };
    for (const k of [
      'payCoins',
      'payStamps',
      'persistStampsPaid',
      'openSchool',
      'learnLesson',
      'noteLessonAct',
      'payLesson',
      'lessonTitle',
      'lessonGuideKey',
      'lessonCopy',
    ]) {
      app[k] = p[k].bind(app);
    }
    return { app, log, events, coins: () => coins };
  };

  test('the first-visit sum: trail 5 + four stamps x 5 = 25 (the tour bar)', () => {
    expect(S.STAMP_PAY).toBe(5);
    const trail = 5; // ARRIVAL_TRAIL coins: the five-coin breadcrumb trail
    const stamps = 4;
    expect(trail + stamps * S.STAMP_PAY).toBe(25);
    // and the Explorer Cap costs what the trail pays
    const src = readFileSync(join(process.cwd(), 'main-simple.ts'), 'utf8');
    expect(src).toContain("{ id: 'cap', icon: '🧢', name: 'Explorer Cap', price: 5 }");
  });

  test('stamps pay +5 each from the first record; a returning visitor gets no back-pay', () => {
    const s = stub({ stamps: 2 });
    s.app.payStamps();
    expect(s.coins()).toBe(0); // no record: it starts at today's count
    expect(localStorage.getItem('ds_stamp_paid')).toBe('2');
    (s.app.passport as { count: () => number }).count = () => 4;
    s.app.payStamps();
    expect(s.coins()).toBe(10);
    expect(s.log).toEqual([['Passport stamp', 10]]);
    s.app.payStamps();
    expect(s.coins()).toBe(10);
    // a fresh page reads the record
    const t = stub({ stamps: 5 });
    t.app.payStamps();
    expect(t.coins()).toBe(5);
  });

  test('a hall stamp pays at the stamp, and the fourth before the completion card', () => {
    // Integration probe (p2/tour, w4-int): coins 1, 7, 15, 21 at the four
    // stops; each +5 waited for refreshCompletion's 2.5 s cadence, so the
    // last landed after the 'Portfolio complete' card read 'Coins earned 21'.
    const s = stub();
    let stamps = 0;
    let onComplete: (() => void) | null = null;
    const cardCoins: number[] = [];
    s.app.passport = { count: () => stamps };
    s.app.payStamps(); // boot: the record starts at 0
    Object.assign(s.app, {
      ownedHats: new Set<string>(),
      equippedHat: null,
      goalsWereOn: false,
      multiplayer: null,
      syncGoals: () => undefined,
      publishGoals: () => undefined,
      openHallPanel: p.openHallPanel.bind(s.app),
      grantPassportReward: p.grantPassportReward.bind(s.app),
    });
    Object.assign(s.app.scene as object, { equipPlayerHat: () => undefined });
    onComplete = s.app.grantPassportReward as () => void;
    Object.assign(s.app.ui as object, {
      // SimpleUI.showZonePanel: a 'proximity' open stamps the passport, and the
      // last stamp fires onComplete inside the call.
      showZonePanel: (_z: unknown, o: { source: string }) => {
        if (o.source !== 'proximity') return;
        stamps += 1;
        if (stamps === 4) onComplete?.();
      },
      showPassportComplete: () => cardCoins.push(s.coins()),
    });
    const after: number[] = [];
    for (const id of ['professional', 'projects', 'personal', 'contact']) {
      (s.app.openHallPanel as (z: { id: string; name: string }) => void)({ id, name: id });
      after.push(s.coins());
    }
    expect(after).toEqual([5, 10, 15, 20]);
    expect(cardCoins).toEqual([20]);
    // the cadence that follows pays nothing twice
    s.app.payStamps();
    expect(s.coins()).toBe(20);
    // a panel that throws still pays the stamp it landed
    (s.app.ui as { showZonePanel: unknown }).showZonePanel = () => {
      stamps += 1;
      throw new Error('panel');
    };
    expect(() =>
      (s.app.openHallPanel as (z: { id: string; name: string }) => void)({ id: 'x', name: 'x' }),
    ).toThrow('panel');
    expect(s.coins()).toBe(25);
  });

  test('six School presses pay exactly +10 on a fresh visitor; a first cast then pays +10', () => {
    const s = stub();
    for (let i = 0; i < 6; i++) s.app.openSchool();
    expect(s.coins()).toBe(10);
    expect(s.app.lessons).toEqual(['move']);
    expect(localStorage.getItem('ds_school_enrolled')).toBe('1');
    s.app.learnLesson('fish');
    expect(s.coins()).toBe(20);
    s.app.learnLesson('fish');
    expect(s.coins()).toBe(20);
    expect(s.log.every(([why, n]) => why === 'School lesson' && n === 10)).toBe(true);
  });

  test('actions before enrolment are paid once at enrolment, not before', () => {
    const s = stub();
    s.app.learnLesson('feed');
    s.app.learnLesson('chop');
    expect(s.coins()).toBe(0);
    s.app.openSchool();
    expect(s.coins()).toBe(30); // move, chop, feed
    s.app.openSchool();
    expect(s.coins()).toBe(30);
  });

  test("an old save's lessons count as done and are not paid again", () => {
    const s = stub();
    s.app.lessons = ['move', 'fish'];
    s.app.openSchool();
    s.app.learnLesson('fish');
    expect(s.coins()).toBe(0);
  });

  test('the card: six rows, Show me keys as amended, touch titles with no keys', () => {
    const s = stub({ touch: true });
    s.app.openSchool();
    const rows = (s.app.ui as { showLessons: ReturnType<typeof vi.fn> }).showLessons.mock
      .calls[0][0] as Array<{ id: string; title: string; done: boolean; guideKey?: string }>;
    expect(rows.map((r) => r.id)).toEqual(LESSONS.map(([id]) => id));
    expect(rows.map((r) => r.guideKey)).toEqual([
      undefined,
      'kiosk',
      'kiosk',
      'kiosk',
      'villager:ai-nearest',
      'stake:nearest',
    ]);
    expect(rows[0].done).toBe(true);
    for (const r of rows) expect(r.title, r.id).not.toMatch(/\bWASD\b|\bSpace\b|\bShift\b/);
    s.app.ownedRod = true;
    s.app.ownedAxe = true;
    expect(s.app.lessonGuideKey('fish')).toBe('shore');
    expect(s.app.lessonGuideKey('chop')).toBe('carpenter');
  });

  test('lesson_learned replaces lesson_done, and deliveries pay +3', () => {
    const src = readFileSync(join(process.cwd(), 'main-simple.ts'), 'utf8');
    expect(src).not.toContain("track('lesson_done'");
    expect(src).toContain("track('lesson_learned', { id, n: this.lessons.length });");
    expect(S.DELIVERY_PAY).toBe(3);
    expect(src).toContain("this.payCoins(SimpleApp.DELIVERY_PAY, 'Delivery');");
  });
});
