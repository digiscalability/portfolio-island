// @vitest-environment happy-dom
//
// Guide.ts and GuideCard.ts.
// - The 'Show me' seam (P2-A5): window 'ds:guide-to' {key, label?, source}
//   names a place by key, and resolveGuideKey turns the key into the position
//   the compass should point at. Pure, so it runs on a stub world.
// - First steps (A6): the state machine on dt-driven frames, persistence,
//   resume, the pause rules, the 20 s chip, the talk skip, legacy visitors,
//   the arming sources, the words, and the card on happy-dom.
// - main-simple makes the card only when the guide first arms (the last
//   describe runs its methods for real on a stub app).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  CONTROLS_KEY,
  GUIDE_KEY,
  GUIDE_KEYS,
  GUIDE_STEPS,
  GOAL_LADDER,
  Guide,
  guideCopy,
  NEXT_ROWS,
  NextChip,
  parseGuideSave,
  readGuideTo,
  RecruiterRoute,
  resolveGuideKey,
  ROUTE_PITCH,
  ROUTE_STOPS,
  ROUTE_WALK_U,
  type GuideCopyContext,
  type GuideFrame,
  type GuideOptions,
  type GuideStep,
  type GuideStore,
  type GuideView,
  type GuideWorld,
  type Vec3Like,
} from '../Guide';
import { GuideCard, type GuideCardOptions } from '../GuideCard';

// The last describe imports main-simple, which calls inject() at module
// load; under happy-dom the analytics script tag would be FETCHED.
vi.mock('@vercel/analytics', () => ({ inject: vi.fn(), track: vi.fn() }));

const at = (x: number): Vec3Like => ({ x, y: 100, z: 0 });

/** The audited world: every getter answers. */
const world = (over: Partial<GuideWorld> = {}): GuideWorld => ({
  zone: (id) =>
    ({ welcome: at(1), professional: at(2), projects: at(3), personal: at(4), contact: at(5) })[
      id
    ] ?? null,
  school: () => at(10),
  kiosk: () => at(11),
  bank: () => at(12),
  shore: () => at(13),
  carpenter: () => at(14),
  farm: () => at(15),
  raceStart: (kind) => (kind === 'land' ? at(16) : at(17)),
  nextMailbox: () => at(18),
  nearestStake: () => at(19),
  nearestAiVillager: () => ({ name: 'Mayor', pos: at(20) }),
  beachHouse: () => at(21),
  ...over,
});

describe('resolveGuideKey', () => {
  test('every key resolves on the audited world', () => {
    const w = world();
    for (const key of GUIDE_KEYS) {
      const hit = resolveGuideKey(key, w);
      expect(hit, key).not.toBeNull();
      expect(hit!.label.length, key).toBeGreaterThan(0);
      expect(hit!.icon.length, key).toBeGreaterThan(0);
    }
    expect(GUIDE_KEYS).toEqual(
      expect.arrayContaining([
        'district:projects',
        'school',
        'kiosk',
        'bank',
        'shore',
        'carpenter',
        'farm',
        'race:land',
        'race:water',
        'mailbox:next',
        'stake:nearest',
        'villager:ai-nearest',
        'beach-house',
      ]),
    );
  });

  test('a district resolves to its door and carries its id; the pill uses the passport name', () => {
    const hit = resolveGuideKey('district:projects', world());
    expect(hit).toEqual({ pos: at(3), icon: '🚀', label: 'Projects', zone: 'projects' });
    expect(resolveGuideKey('district:welcome', world())?.label).toBe('Welcome Hub');
    expect(resolveGuideKey('district:contact', world())?.icon).toBe('📬');
  });

  test('places resolve to their getters, with no district id', () => {
    const w = world();
    expect(resolveGuideKey('school', w)).toEqual({
      pos: at(10),
      icon: '🏫',
      label: 'School',
      zone: null,
    });
    expect(resolveGuideKey('race:water', w)?.pos).toEqual(at(17));
    expect(resolveGuideKey('mailbox:next', w)?.label).toBe('Parcel');
    expect(resolveGuideKey('villager:ai-nearest', w)).toEqual({
      pos: at(20),
      icon: '💬',
      label: 'Mayor',
      zone: null,
    });
  });

  test('unknown keys return null', () => {
    const w = world();
    for (const key of [
      '',
      'nope',
      'district:',
      'district:nope',
      'district:hire',
      'race:air',
      'School',
      'toString',
      '__proto__',
      'constructor',
    ]) {
      expect(resolveGuideKey(key, w), key).toBeNull();
    }
    expect(resolveGuideKey(42 as unknown as string, w)).toBeNull();
  });

  test('a key whose place is missing in this world returns null (the map opens instead)', () => {
    const w = world({
      school: () => null,
      zone: () => null,
      nearestAiVillager: () => null,
      nextMailbox: () => null,
    });
    expect(resolveGuideKey('school', w)).toBeNull();
    expect(resolveGuideKey('district:projects', w)).toBeNull();
    expect(resolveGuideKey('villager:ai-nearest', w)).toBeNull();
    expect(resolveGuideKey('mailbox:next', w)).toBeNull();
  });
});

describe('readGuideTo', () => {
  test('a key, an optional label and a source', () => {
    expect(readGuideTo({ key: 'school', source: 'things-to-do' })).toEqual({
      key: 'school',
      label: null,
      source: 'things-to-do',
    });
    expect(readGuideTo({ key: 'district:projects', label: ' 🚀 Projects ', source: 'd8' })).toEqual(
      { key: 'district:projects', label: '🚀 Projects', source: 'd8' },
    );
    expect(readGuideTo({ key: 'bank' })?.source).toBe('event');
  });

  test('malformed details are dropped', () => {
    for (const d of [
      null,
      undefined,
      'school',
      7,
      {},
      { key: '' },
      { key: 3 },
      { key: 'x'.repeat(65) },
    ]) {
      expect(readGuideTo(d), JSON.stringify(d) ?? String(d)).toBeNull();
    }
  });
});

// ---- First steps (A6): the state machine -----------------------------------

type Tracked = { name: string; step: string; outcome: string };

/** An in-memory store; `broken` makes every call throw (blocked storage). */
function memStore(init: Record<string, string> = {}, broken = false) {
  const data: Record<string, string> = { ...init };
  const store: GuideStore = {
    get: (k) => {
      if (broken) throw new Error('SecurityError');
      return Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null;
    },
    set: (k, v) => {
      if (broken) throw new Error('SecurityError');
      data[k] = v;
    },
  };
  return { store, data };
}

function makeGuide(
  opts: Partial<GuideOptions> = {},
  init: Record<string, string> = {},
  broken = false,
) {
  const { store, data } = memStore(init, broken);
  const tracked: Tracked[] = [];
  const completed: GuideStep[] = [];
  let skipped = 0;
  const guide = new Guide(
    store,
    {
      track: (name, p) => tracked.push({ name, ...p }),
      completed: (s) => completed.push(s),
      skipped: () => skipped++,
    },
    {
      welcomed: false,
      facts: () => ({ npcChatted: false, passportCount: 0, mapHint: false }),
      talkTarget: () => 'Mayor',
      controlsCard: true,
      ...opts,
    },
  );
  return { guide, data, tracked, completed, skipped: () => skipped };
}

const idle = (over: Partial<GuideFrame> = {}): GuideFrame => ({
  dt: 1 / 60,
  blocked: false,
  top: null,
  moveMag: 0,
  walked: 0,
  yaw: 0,
  targetDist: null,
  ...over,
});

/** Run frames for `seconds` of game time. */
function run(g: Guide, seconds: number, over: Partial<GuideFrame> = {}, dt = 1 / 60): void {
  for (let t = 0; t < seconds - 1e-9; t += dt) g.frame(idle({ dt, ...over }));
}

/** Armed and past the 600 ms resume. */
function armed(opts: Partial<GuideOptions> = {}, init: Record<string, string> = {}) {
  const h = makeGuide(opts, init);
  expect(h.guide.arm('explore')).toBe(true);
  run(h.guide, 0.7);
  return h;
}

const saveOf = (data: Record<string, string>) => JSON.parse(data[GUIDE_KEY] ?? 'null');

/** A keyboard visitor's words, for the tests that read the card's text. */
const wordsCtx: GuideCopyContext = {
  touch: false,
  lookMode: 'drag',
  runKey: null,
  compassLabel: 'Mayor',
  finaleLabel: 'Projects',
};

describe('First steps: the five steps, in order', () => {
  test('arming writes ds_guide_v1 and starts at walk, after the 600 ms resume', () => {
    const { guide, data } = makeGuide();
    expect(guide.view().visible).toBe(false);
    guide.arm('explore');
    expect(saveOf(data)).toMatchObject({ v: 1, done: [], finished: false, skipped: false });
    expect(saveOf(data).t).toBeGreaterThan(0);
    run(guide, 0.55);
    expect(guide.view().visible).toBe(false);
    run(guide, 0.1);
    expect(guide.view()).toMatchObject({ visible: true, active: true, step: 'move' });
  });

  test('walk: 1.0 s of input above 0.3, or 4 u walked; slower input does not count', () => {
    let h = armed();
    run(h.guide, 2, { moveMag: 0.25 });
    expect(h.guide.currentStep()).toBe('move');
    run(h.guide, 1.02, { moveMag: 1 });
    expect(h.completed).toEqual(['move']);
    h = armed();
    run(h.guide, 0.5, { walked: 0.14 }); // 30 frames x 0.14 u = 4.2 u
    expect(h.completed).toEqual(['move']);
    h = armed();
    run(h.guide, 0.2, { walked: 9 }); // a teleport is not a walk
    expect(h.completed).toEqual([]);
  });

  test('the next step follows 450 ms after a completion, with the check on the done step', () => {
    const { guide } = armed();
    run(guide, 1.02, { moveMag: 1 });
    expect(guide.view()).toMatchObject({ step: 'move', justDone: 'move' });
    run(guide, 0.4);
    expect(guide.currentStep()).toBe('move');
    run(guide, 0.1);
    expect(guide.view()).toMatchObject({ step: 'look', justDone: null });
  });

  test('look: 35° of manual yaw, either way; under that it waits', () => {
    const { guide, completed } = armed({}, {});
    run(guide, 1.02, { moveMag: 1 });
    run(guide, 0.5);
    let yaw = 0;
    const turn = (deg: number, frames: number) => {
      for (let i = 0; i < frames; i++) {
        yaw += ((deg / frames) * Math.PI) / 180;
        guide.frame(idle({ yaw }));
      }
    };
    turn(-20, 10);
    turn(14, 10); // 34° of look in all
    expect(completed).toEqual(['move']);
    turn(2, 2);
    expect(completed).toEqual(['move', 'look']);
  });

  test('talk names the villager; NPC chat or a quest dialogue opening completes it', () => {
    const { guide, completed } = armed();
    guide.complete('move');
    guide.complete('look');
    run(guide, 0.5);
    expect(guide.view()).toMatchObject({ step: 'talk', talkTarget: 'Mayor' });
    guide.complete('talk');
    expect(completed).toContain('talk');
  });

  test('no villager to talk to: the talk step is recorded as skipped and passed over', () => {
    const { guide, tracked, data } = armed({ talkTarget: () => null });
    guide.complete('move');
    guide.complete('look');
    run(guide, 0.5);
    expect(guide.currentStep()).toBe('portfolio');
    expect(tracked).toContainEqual({ name: 'guide_step', step: 'talk', outcome: 'skipped' });
    expect(saveOf(data).done).toContain('talk');
  });

  test('the villager goes to bed on the talk step: the card names a stand-in, kept while up', () => {
    // main-simple's talkVillager: the trail villager while up, then the
    // stand-in the guide already names, then the nearest awake one, or null.
    let up = ['Mayor', 'Elder Sage', 'Teller'];
    const asked: Array<string | null> = [];
    const talkTarget = (current: string | null): string | null => {
      asked.push(current);
      if (up.includes('Mayor')) return 'Mayor';
      if (current && up.includes(current)) return current;
      return up[0] ?? null;
    };
    const { guide, tracked, data } = armed({ talkTarget });
    guide.complete('move');
    guide.complete('look');
    run(guide, 0.5);
    expect(guide.view()).toMatchObject({ step: 'talk', talkTarget: 'Mayor' });
    const v0 = guide.version();
    run(guide, 2); // nothing changes while he is up: no redraw
    expect(guide.version()).toBe(v0);
    up = ['Elder Sage', 'Teller']; // 21:00, the Mayor heads home
    run(guide, 0.6);
    expect(guide.view()).toMatchObject({ step: 'talk', talkTarget: 'Elder Sage' });
    expect(guide.version()).toBeGreaterThan(v0); // the card is redrawn
    expect(guideCopy(guide.view(), wordsCtx).body).toContain('Walk up to Elder Sage and press [E]');
    up = ['Teller', 'Elder Sage']; // another is nearer now: the stand-in is kept
    run(guide, 1.2);
    expect(guide.view().talkTarget).toBe('Elder Sage');
    expect(asked).toContain('Elder Sage');
    // asked twice a second, not every frame
    const before = asked.length;
    run(guide, 2);
    expect(asked.length - before).toBeGreaterThanOrEqual(3);
    expect(asked.length - before).toBeLessThanOrEqual(5);
    up = []; // everyone is in bed: the step is passed over, recorded as skipped
    run(guide, 0.6);
    expect(guide.currentStep()).toBe('portfolio');
    expect(tracked).toContainEqual({ name: 'guide_step', step: 'talk', outcome: 'skipped' });
    expect(saveOf(data).done).toEqual(['move', 'look', 'talk']);
    const asks = asked.length;
    run(guide, 2); // and never asked again
    expect(asked.length).toBe(asks);
  });

  test('portfolio: the Portfolio menu or any zone panel on top, even while it pauses the card', () => {
    const { guide, completed } = armed({ talkTarget: () => null });
    for (const s of ['move', 'look'] as const) guide.complete(s);
    run(guide, 0.5);
    guide.frame(idle({ blocked: true, top: 'portfolio-menu' }));
    expect(completed).toContain('portfolio');
    expect(guide.view().visible).toBe(false); // paused behind the panel
    run(guide, 0.65);
    expect(guide.view().visible).toBe(true);
    run(guide, 0.5);
    expect(guide.currentStep()).toBe('compass');
  });

  test('compass: the island map opening, or 15 u from the pill target', () => {
    let h = armed({ talkTarget: () => null });
    for (const s of ['move', 'look', 'portfolio'] as const) h.guide.complete(s);
    run(h.guide, 0.5);
    expect(h.guide.currentStep()).toBe('compass');
    run(h.guide, 1, { targetDist: 15.5 });
    expect(h.completed).not.toContain('compass');
    h.guide.frame(idle({ targetDist: 14.9 }));
    expect(h.completed).toContain('compass');
    h = armed({ talkTarget: () => null });
    for (const s of ['move', 'look', 'portfolio'] as const) h.guide.complete(s);
    h.guide.frame(idle({ blocked: true, top: 'island-map' }));
    expect(h.completed).toContain('compass');
  });

  test('the target distance only counts on the compass step', () => {
    const { guide, completed } = armed();
    run(guide, 1, { targetDist: 5 });
    expect(completed).not.toContain('compass');
  });

  test('all five done: the finale, saved as finished; a button or 20 s ends it', () => {
    const { guide, data } = armed({ talkTarget: () => null });
    for (const s of ['move', 'look', 'portfolio', 'compass'] as const) guide.complete(s);
    run(guide, 0.5);
    expect(guide.view()).toMatchObject({ phase: 'finale', visible: true, active: true });
    expect(saveOf(data).finished).toBe(true);
    run(guide, 19.5);
    expect(guide.running()).toBe(true);
    run(guide, 0.6);
    expect(guide.running()).toBe(false);
    expect(guide.view().visible).toBe(false);
  });

  test('every step is tracked with two properties, {step, outcome}', () => {
    const { guide, tracked } = armed();
    guide.complete('move');
    for (const t of tracked) {
      expect(Object.keys(t).filter((k) => k !== 'name')).toEqual(['step', 'outcome']);
    }
    expect(tracked).toContainEqual({ name: 'guide_step', step: 'move', outcome: 'done' });
  });
});

describe('First steps: pause, timeout and skip', () => {
  test('a panel, the welcome card, a tour or a room pauses it; it resumes 600 ms after', () => {
    const { guide } = armed();
    run(guide, 3, { blocked: true });
    expect(guide.view().visible).toBe(false);
    expect(guide.isActive()).toBe(true); // still holds the hints behind the panel
    run(guide, 0.55);
    expect(guide.view().visible).toBe(false);
    run(guide, 0.1);
    expect(guide.view().visible).toBe(true);
  });

  test('time paused does not count toward the 20 s timeout', () => {
    const { guide } = armed();
    run(guide, 15);
    run(guide, 30, { blocked: true });
    run(guide, 0.65);
    run(guide, 4);
    expect(guide.view().chip).toBe(false);
  });

  test('20 s on a step: the chip, the hint gate released; tapping it re-expands', () => {
    const { guide, tracked } = armed(); // 0.1 s on the step already
    run(guide, 19.8);
    expect(guide.view().chip).toBe(false);
    run(guide, 0.2);
    expect(guide.view()).toMatchObject({ chip: true, visible: true, active: false });
    expect(guide.isActive()).toBe(false);
    expect(tracked).toContainEqual({ name: 'guide_step', step: 'move', outcome: 'timeout' });
    guide.expand();
    expect(guide.view()).toMatchObject({ chip: false, active: true });
    run(guide, 19);
    expect(guide.view().chip).toBe(false);
  });

  test('Skip writes skipped, hides the card and asks for the compass hint', () => {
    const h = armed();
    h.guide.skip();
    expect(saveOf(h.data).skipped).toBe(true);
    expect(h.guide.view()).toMatchObject({ visible: false, active: false });
    expect(h.skipped()).toBe(1);
    expect(h.tracked).toContainEqual({ name: 'guide_step', step: 'move', outcome: 'skipped' });
    expect(h.guide.arm('explore')).toBe(false);
  });

  test('a coin during the guide shows the coin line for 3 s', () => {
    const { guide } = armed();
    guide.coin();
    expect(guide.view().coinLine).toBe(true);
    run(guide, 2.9);
    expect(guide.view().coinLine).toBe(true);
    run(guide, 0.2);
    expect(guide.view().coinLine).toBe(false);
  });
});

describe('First steps: persistence, resume and arming', () => {
  test('a reload with two steps done resumes at step 3', () => {
    const first = armed();
    first.guide.complete('move');
    first.guide.complete('look');
    const again = makeGuide({ welcomed: true }, { ...first.data });
    again.guide.arm('explore');
    run(again.guide, 0.7);
    expect(again.guide.view()).toMatchObject({ step: 'talk', done: ['move', 'look'] });
  });

  test('talkTargetNow: the villager First steps sends the visitor to, until they have talked', () => {
    const idleGuide = makeGuide().guide;
    expect(idleGuide.talkTargetNow()).toBeNull(); // not armed: the welcome card is up
    const h = makeGuide();
    h.guide.arm('explore');
    // From the arming on, walk and look included: the pill never leaves the
    // villager for Projects between the trail's end and the talk step.
    expect(h.guide.talkTargetNow()).toBe('Mayor');
    run(h.guide, 0.7);
    expect(h.guide.currentStep()).toBe('move');
    expect(h.guide.talkTargetNow()).toBe('Mayor');
    const { guide } = h;
    guide.complete('move');
    guide.complete('look');
    run(guide, 0.5);
    expect(guide.currentStep()).toBe('talk');
    expect(guide.talkTargetNow()).toBe('Mayor');
    run(guide, 20); // the chip: the card no longer says it
    expect(guide.view().chip).toBe(true);
    expect(guide.talkTargetNow()).toBeNull();
    guide.expand();
    expect(guide.talkTargetNow()).toBe('Mayor');
    guide.complete('talk'); // its check plays for 450 ms: the pill moves on now
    expect(guide.currentStep()).toBe('talk');
    expect(guide.talkTargetNow()).toBeNull();
    const skipped = armed();
    skipped.guide.complete('move');
    skipped.guide.complete('look');
    run(skipped.guide, 0.5);
    skipped.guide.skip();
    expect(skipped.guide.talkTargetNow()).toBeNull();
    // talked before the guide reached the step (out of order): not sent again
    const early = armed();
    early.guide.complete('talk');
    expect(early.guide.currentStep()).toBe('move');
    expect(early.guide.talkTargetNow()).toBeNull();
    // nobody to talk to: nothing for the pill either
    expect(armed({ talkTarget: () => null }).guide.talkTargetNow()).toBeNull();
  });

  test('the villager goes to bed before the talk step: the pill moves at once, the card later', () => {
    let who: string | null = 'Mayor';
    const { guide } = armed({ talkTarget: () => who });
    expect(guide.talkTargetNow()).toBe('Mayor');
    const v0 = guide.version();
    who = 'Elder Sage';
    run(guide, 0.6);
    expect(guide.currentStep()).toBe('move');
    expect(guide.talkTargetNow()).toBe('Elder Sage');
    expect(guide.version()).toBe(v0); // walk's card does not name them: no redraw
    who = null; // nobody up: the pill lets go, and the step will be skipped
    run(guide, 0.6);
    expect(guide.talkTargetNow()).toBeNull();
    guide.complete('move');
    guide.complete('look');
    run(guide, 0.5);
    expect(guide.currentStep()).toBe('portfolio');
    // a panel or a room pauses the question with the card
    const paused = armed({ talkTarget: () => who });
    who = 'Mayor';
    run(paused.guide, 3, { blocked: true });
    expect(paused.guide.talkTargetNow()).toBeNull();
    run(paused.guide, 1.2);
    expect(paused.guide.talkTargetNow()).toBe('Mayor');
  });

  test('a reload resumes at talk naming this load’s villager, trail coins or none', () => {
    const first = armed();
    first.guide.complete('move');
    first.guide.complete('look');
    // The reload picks its villager afresh at the intro (A7); the guide asks
    // for it when the talk step starts, after arming.
    let villager: string | null = null;
    const again = makeGuide({ welcomed: true, talkTarget: () => villager }, { ...first.data });
    villager = 'Mayor';
    again.guide.arm('explore');
    run(again.guide, 0.7);
    expect(again.guide.talkTargetNow()).toBe('Mayor');
    expect(
      guideCopy(again.guide.view(), {
        touch: false,
        lookMode: 'drag',
        runKey: null,
        compassLabel: 'Mayor',
        finaleLabel: 'Projects',
      }).body,
    ).toContain('Walk up to Mayor and press [E]');
  });

  test('finished or skipped never arms again', () => {
    for (const end of [{ finished: true }, { skipped: true }]) {
      const save = JSON.stringify({
        v: 1,
        done: [],
        finished: false,
        skipped: false,
        t: 5,
        ...end,
      });
      expect(makeGuide({}, { [GUIDE_KEY]: save }).guide.arm('explore')).toBe(false);
    }
  });

  test('an unreadable save is treated as none', () => {
    expect(parseGuideSave('{oops')).toBeNull();
    expect(parseGuideSave(JSON.stringify({ v: 2, done: [] }))).toBeNull();
    expect(parseGuideSave(JSON.stringify({ v: 1, done: ['look', 'nope', 'move'] }))?.done).toEqual([
      'move',
      'look',
    ]);
  });

  test('blocked storage: the guide still runs for the session', () => {
    const { guide } = makeGuide({}, {}, true);
    expect(guide.arm('explore')).toBe(true);
    run(guide, 0.7);
    expect(guide.view().visible).toBe(true);
    guide.complete('move');
    expect(guide.view().done).toEqual(['move']);
  });

  test('the full tour arms it headed "The island is yours"; Explore and a CTA "First steps"', () => {
    const tour = makeGuide();
    tour.guide.arm('tour');
    expect(tour.guide.view().heading).toBe('The island is yours');
    for (const src of ['explore', 'cta'] as const) {
      const h = makeGuide();
      h.guide.arm(src);
      expect(h.guide.view().heading).toBe('First steps');
    }
  });

  test('arming twice is a no-op; steps done before arming count from the arming on', () => {
    const { guide, tracked, data } = makeGuide();
    guide.frame(idle({ top: 'zone' })); // See the work, before the guide armed
    expect(data[GUIDE_KEY]).toBeUndefined();
    expect(tracked).toEqual([]);
    expect(guide.arm('cta')).toBe(true);
    expect(guide.arm('cta')).toBe(false);
    expect(saveOf(data).done).toEqual(['portfolio']);
  });
});

describe('First steps: visitors from before the guide', () => {
  const legacy = (facts: { npcChatted?: boolean; passportCount?: number; mapHint?: boolean }) =>
    makeGuide({
      welcomed: true,
      facts: () => ({ npcChatted: false, passportCount: 0, mapHint: false, ...facts }),
    });

  test('move and look pre-completed; talk, portfolio and compass from what they did', () => {
    const h = legacy({ npcChatted: true, passportCount: 2 });
    h.guide.arm('explore');
    expect(saveOf(h.data).done).toEqual(['move', 'look', 'talk', 'portfolio']);
    const m = legacy({ mapHint: true });
    m.guide.arm('explore');
    expect(saveOf(m.data).done).toEqual(['move', 'look', 'compass']);
  });

  test('the controls card once (ds_controls_v2), then the first undone step', () => {
    const h = legacy({ npcChatted: true });
    h.guide.arm('explore');
    run(h.guide, 0.7);
    expect(h.guide.view()).toMatchObject({ phase: 'controls', visible: true, active: true });
    expect(h.data[CONTROLS_KEY]).toBe('1');
    h.guide.controlsDone();
    expect(h.guide.currentStep()).toBe('portfolio');
    const again = makeGuide(
      { welcomed: true, facts: () => ({ npcChatted: false, passportCount: 0, mapHint: false }) },
      { [CONTROLS_KEY]: '1' },
    );
    again.guide.arm('explore');
    expect(again.guide.view().phase).toBe('steps');
  });

  test('the controls card goes by itself after 8 s; touch screens never get it', () => {
    const h = legacy({});
    h.guide.arm('explore');
    run(h.guide, 0.7 + 8.1);
    expect(h.guide.currentStep()).toBe('talk');
    const touch = makeGuide({
      welcomed: true,
      controlsCard: false,
      facts: () => ({ npcChatted: false, passportCount: 0, mapHint: false }),
    });
    touch.guide.arm('explore');
    expect(touch.guide.view().phase).toBe('steps');
    expect(touch.data[CONTROLS_KEY]).toBeUndefined();
  });

  test('a first-time visitor is never treated as legacy, even once Explore set ds_welcomed', () => {
    // main-simple reads ds_welcomed at boot, before Explore writes it.
    const { guide, data } = makeGuide({ welcomed: false });
    guide.arm('explore');
    expect(saveOf(data).done).toEqual([]);
    expect(data[CONTROLS_KEY]).toBeUndefined();
  });
});

describe('First steps: the words', () => {
  const ctx = (over: Partial<GuideCopyContext> = {}): GuideCopyContext => ({
    touch: false,
    lookMode: 'drag',
    runKey: null,
    compassLabel: '🚀 Projects',
    finaleLabel: 'Projects',
    ...over,
  });
  const view = (over: Partial<GuideView>): GuideView => ({
    version: 1,
    phase: 'steps',
    visible: true,
    active: true,
    step: 'move',
    justDone: null,
    done: [],
    chip: false,
    coinLine: false,
    heading: 'First steps',
    talkTarget: 'Mayor',
    ...over,
  });

  test('every surface the card can show: no "agent", no "live AI", no typed villager count', () => {
    const all: string[] = [];
    for (const touch of [false, true]) {
      for (const lookMode of ['drag', 'lock', null]) {
        for (const step of GUIDE_STEPS) {
          const c = guideCopy(view({ step, coinLine: true }), ctx({ touch, lookMode }));
          all.push(c.title, c.body, c.line ?? '', c.chip, c.headButton.label);
        }
      }
    }
    for (const phase of ['controls', 'finale'] as const) {
      const c = guideCopy(view({ phase, step: null }), ctx());
      all.push(c.title, c.body, ...c.buttons.map((b) => b.label));
    }
    for (const s of all) {
      expect(s, s).not.toMatch(/agent/i);
      expect(s, s).not.toMatch(/live AI/i);
      expect(s, s).not.toMatch(/\b\d+\s+(villagers|townsfolk|AI)\b/i);
    }
  });

  test('the talk step names its villager, not every villager', () => {
    const d = guideCopy(view({ step: 'talk' }), ctx());
    // The critique's named subject, then the brief's 'Walk up to <name> and
    // press [E]' clause, which says who to walk to.
    expect(d.body).toBe(
      'Mayor talks through Claude Haiku 4.5. Walk up to Mayor and press [E] to ask anything.',
    );
    expect(guideCopy(view({ step: 'talk' }), ctx({ touch: true })).body).toBe(
      'Mayor talks through Claude Haiku 4.5. Walk up to Mayor and tap USE to ask anything.',
    );
    // E's guide probe (guide.cjs) reads the villager from that clause.
    const named = /walk up to (?:the )?(.+?) and (?:press|tap)/i;
    for (const touch of [false, true]) {
      const body = guideCopy(view({ step: 'talk' }), ctx({ touch })).body;
      expect(named.exec(body.replace(/\[|\]/g, ''))?.[1]).toBe('Mayor');
    }
    // No target: never shown (the step is skipped), and still one villager.
    const none = guideCopy(view({ step: 'talk', talkTarget: null }), ctx()).body;
    expect(none).toMatch(/^A villager nearby talks through Claude Haiku 4\.5\./);
    expect(none).not.toMatch(/^Villagers/);
  });

  test('a villager with quest lines to say first: "press E to talk", not "ask anything" (P2-A7)', () => {
    // E on a quest giver opens her request, not the chat: the card promises
    // only what that press does. She still talks through Claude Haiku 4.5.
    const quest = guideCopy(
      view({ step: 'talk', talkTarget: 'Elder Sage' }),
      ctx({ talkQuest: true }),
    );
    expect(quest.body).toBe(
      'Elder Sage talks through Claude Haiku 4.5. Walk up to Elder Sage and press [E] to talk.',
    );
    expect(
      guideCopy(
        view({ step: 'talk', talkTarget: 'Elder Sage' }),
        ctx({ touch: true, talkQuest: true }),
      ).body,
    ).toBe('Elder Sage talks through Claude Haiku 4.5. Walk up to Elder Sage and tap USE to talk.');
    // E's guide probe still reads the villager from the same clause
    expect(/walk up to (?:the )?(.+?) and (?:press|tap)/i.exec(quest.body)?.[1]).toBe('Elder Sage');
    // unset (or false) keeps 'ask anything'
    expect(guideCopy(view({ step: 'talk' }), ctx({ talkQuest: false })).body).toContain(
      'to ask anything.',
    );
  });

  test('look follows html[data-look-mode] and names J/L on keyboards', () => {
    expect(guideCopy(view({ step: 'look' }), ctx()).body).toBe(
      'Drag to look — or [J] / [L] to turn.',
    );
    expect(guideCopy(view({ step: 'look' }), ctx({ lookMode: 'lock' })).body).toContain(
      'Move the mouse',
    );
    expect(guideCopy(view({ step: 'look' }), ctx({ touch: true })).body).not.toContain('[J]');
  });

  test('the header counts 2/5; the chip says "First steps 3/5 · Resume"', () => {
    expect(guideCopy(view({ step: 'look', done: ['move'] }), ctx()).title).toBe(
      'First steps · 2/5',
    );
    expect(guideCopy(view({ step: 'talk', done: ['move', 'look'], chip: true }), ctx()).chip).toBe(
      'First steps 3/5 · Resume',
    );
  });

  test('the number is the step on the card, not how many are done', () => {
    // The work opened from the welcome card first (Hiring, See the work, Get
    // in touch): the card read 'First steps · 2/5' over step 1's words
    // (wave-1 integration).
    const early = guideCopy(view({ step: 'move', done: ['portfolio'] }), ctx());
    expect(early.title).toBe('First steps · 1/5');
    expect(early.body).toContain('Walk with');
    expect(guideCopy(view({ step: 'move', done: ['portfolio'], chip: true }), ctx()).chip).toBe(
      'First steps 1/5 · Resume',
    );
    // ...and when its turn comes it is passed over: 3/5, then 5/5.
    expect(
      guideCopy(view({ step: 'talk', done: ['portfolio', 'move', 'look'] }), ctx()).title,
    ).toBe('First steps · 3/5');
    expect(
      guideCopy(view({ step: 'compass', done: ['portfolio', 'move', 'look', 'talk'] }), ctx())
        .title,
    ).toBe('First steps · 5/5');
    // While a step's check plays, the card still shows that step's number.
    const check = guideCopy(view({ step: 'move', justDone: 'move', done: ['move'] }), ctx());
    expect(check.title).toBe('First steps · 1/5');
    expect(check.body).toContain('Walk with');
    // Each step's number, in order, with nothing done out of order.
    GUIDE_STEPS.forEach((step, i) => {
      expect(guideCopy(view({ step, done: GUIDE_STEPS.slice(0, i) }), ctx()).title).toBe(
        `First steps · ${i + 1}/5`,
      );
    });
  });

  test('the state machine numbers a guide whose work step was done first 1/5, not 2/5', () => {
    const { guide } = makeGuide();
    // See the work, from the welcome card: a zone panel on top before arming.
    guide.frame(idle({ blocked: true, top: 'zone' }));
    guide.arm('cta');
    run(guide, 0.7);
    expect(guide.view()).toMatchObject({ step: 'move', done: ['portfolio'] });
    expect(guideCopy(guide.view(), ctx()).title).toBe('First steps · 1/5');
  });

  test('the finale leads to the work: Projects first, then the School', () => {
    const f = guideCopy(view({ phase: 'finale', step: null }), ctx({ finaleLabel: 'Contact' }));
    expect(f.title).toBe("You're set. Next: the work.");
    expect(f.buttons).toEqual([
      { id: 'primary', label: 'Show me Contact' },
      { id: 'school', label: 'Show me the School' },
    ]);
  });

  test('the legacy controls card says Space until A11 makes Shift run', () => {
    const c = guideCopy(view({ phase: 'controls', step: null }), ctx());
    expect(c.body).toBe('Drag to look · Space to run');
    expect(guideCopy(view({ phase: 'controls', step: null }), ctx({ runKey: 'shift' })).body).toBe(
      'Drag to look · Shift to run',
    );
  });

  test("it names '?' only in a build that has D8's Controls & settings sheet", () => {
    // Without the sheet nothing answers the key: the clause stays off.
    const c = guideCopy(view({ phase: 'controls', step: null }), ctx());
    expect(c.body).not.toContain('?');
    expect(
      guideCopy(view({ phase: 'controls', step: null }), ctx({ controlsSheet: false })).body,
    ).not.toContain('?');
    expect(
      guideCopy(view({ phase: 'controls', step: null }), ctx({ controlsSheet: true })).body,
    ).toBe('Drag to look · Space to run · ? for all controls');
    expect(
      guideCopy(
        view({ phase: 'controls', step: null }),
        ctx({ controlsSheet: true, runKey: 'shift' }),
      ).body,
    ).toBe('Drag to look · Shift to run · ? for all controls');
  });
});

// ---- First steps (A6): the card ---------------------------------------------

describe('GuideCard: one live, focus-free card on the HUD', () => {
  const view = (over: Partial<GuideView> = {}): GuideView => ({
    version: 1,
    phase: 'steps',
    visible: true,
    active: true,
    step: 'move',
    justDone: null,
    done: [],
    chip: false,
    coinLine: false,
    heading: 'First steps',
    talkTarget: 'Mayor',
    ...over,
  });
  const words = (v: GuideView) =>
    guideCopy(v, {
      touch: false,
      lookMode: 'drag',
      runKey: null,
      compassLabel: '🚀 Projects',
      finaleLabel: 'Projects',
    });
  let overlay: HTMLElement;
  let card: GuideCard | null = null;
  const pressed: string[] = [];
  const make = (over: Partial<GuideCardOptions> = {}) => {
    card = new GuideCard(overlay, {
      touch: false,
      reducedMotion: () => true,
      onButton: (id) => pressed.push(id),
      prompt: () => null,
      ...over,
    });
    return card;
  };
  beforeEach(() => {
    document.body.innerHTML = '<div id="ui-overlay"></div>';
    overlay = document.getElementById('ui-overlay')!;
    pressed.length = 0;
  });
  afterEach(() => {
    card?.dispose();
    card = null;
  });

  test('#ds-guide is a polite, atomic status region, hidden until the guide runs', () => {
    const c = make();
    const el = document.getElementById('ds-guide')!;
    expect(el).toBe(c.el);
    expect(el.parentElement).toBe(overlay);
    expect(el.getAttribute('role')).toBe('status');
    expect(el.getAttribute('aria-live')).toBe('polite');
    expect(el.getAttribute('aria-atomic')).toBe('true');
    expect(el.style.display).toBe('none');
    expect(el.dataset.active).toBe('0');
  });

  test("data-active and 'ds:guide' {active, step} follow the guide, once per change", () => {
    const c = make();
    const seen: Array<{ active: boolean; step: string | null }> = [];
    const on = (e: Event) => seen.push((e as CustomEvent).detail);
    window.addEventListener('ds:guide', on);
    const v1 = view();
    c.render(v1, words(v1));
    const v2 = view({ version: 2, coinLine: true }); // a redraw, same {active, step}
    c.render(v2, words(v2));
    const v3 = view({ version: 3, step: 'look' });
    c.render(v3, words(v3));
    const v4 = view({ version: 4, step: 'look', chip: true, active: false });
    c.render(v4, words(v4));
    window.removeEventListener('ds:guide', on);
    expect(seen).toEqual([
      { active: true, step: 'move' },
      { active: true, step: 'look' },
      { active: false, step: 'look' },
    ]);
    expect(c.el.dataset.active).toBe('0');
  });

  test('a paused guide hides the card but keeps the hint gate', () => {
    const c = make();
    const v = view({ visible: false });
    c.render(v, words(v));
    expect(c.el.style.display).toBe('none');
    expect(c.el.dataset.active).toBe('1');
  });

  test('key caps render as kbd; Skip and the finale buttons report their ids', () => {
    const c = make();
    const v = view();
    c.render(v, words(v));
    expect([...c.el.querySelectorAll('kbd')].map((k) => k.textContent)).toEqual([
      'W',
      'A',
      'S',
      'D',
    ]);
    c.el.querySelector<HTMLElement>('[data-g="skip"]')!.click();
    const f = view({ version: 2, phase: 'finale', step: null });
    c.render(f, words(f));
    c.el.querySelector<HTMLElement>('[data-g="primary"]')!.click();
    c.el.querySelector<HTMLElement>('[data-g="school"]')!.click();
    c.el.querySelector<HTMLElement>('[data-g="close"]')!.click();
    expect(pressed).toEqual(['skip', 'primary', 'school', 'close']);
    // nothing in the card takes focus by itself
    expect(document.activeElement === document.body || document.activeElement === null).toBe(true);
  });

  test('the chip is one Resume button with a 44 px hit area', () => {
    const c = make();
    const v = view({ step: 'talk', chip: true, active: false, done: ['move', 'look'] });
    c.render(v, words(v));
    const b = c.el.querySelectorAll('button');
    expect(b.length).toBe(1);
    expect(b[0].textContent).toBe('First steps 3/5 · Resume');
    expect(b[0].style.minHeight).toContain('44px');
    b[0].click();
    expect(pressed).toEqual(['resume']);
  });

  test('reduced motion: nothing animates; otherwise the card, its check and a ring do', () => {
    const calls: string[] = [];
    const orig = (Element.prototype as { animate?: unknown }).animate;
    (
      Element.prototype as unknown as {
        animate: (k: unknown, o: { iterations?: number }) => unknown;
      }
    ).animate = function (this: Element, _k: unknown, o: { iterations?: number }) {
      calls.push(
        `${(this as HTMLElement).id || (this as HTMLElement).dataset.guideRing || this.tagName}:${o?.iterations ?? 1}`,
      );
      return { cancel() {} };
    };
    try {
      document.body.insertAdjacentHTML(
        'beforeend',
        '<div data-guide="compass" style="position:fixed;left:10px;top:10px;width:80px;height:30px"></div>',
      );
      const still = make({ reducedMotion: () => true });
      const v = view({ step: 'compass', justDone: null });
      still.render(v, words(v));
      expect(calls).toEqual([]);
      still.dispose();
      const moving = make({ reducedMotion: () => false });
      moving.render(v, words(v));
      const done = view({ version: 2, step: 'compass', justDone: 'compass' });
      moving.render(done, words(done));
      // every animation is finite: no Infinity iterations
      expect(calls.every((c) => !c.endsWith(':Infinity'))).toBe(true);
      expect(calls.some((c) => c.startsWith('ds-guide:'))).toBe(true);
      expect(calls.some((c) => c.startsWith('SPAN:'))).toBe(true); // the check
    } finally {
      (Element.prototype as { animate?: unknown }).animate = orig;
    }
  });

  test('lanes: desktop under the radar; phone above the prompt lane; short landscape right of the radar', () => {
    // happy-dom keeps no calc() in inline styles: the card names its lane.
    const set = (w: number, h: number) => {
      Object.defineProperty(window, 'innerWidth', { value: w, configurable: true });
      Object.defineProperty(window, 'innerHeight', { value: h, configurable: true });
    };
    set(1440, 900);
    const desk = make();
    expect(desk.el.dataset.lane).toBe('desktop');
    desk.dispose();
    set(390, 844);
    const phone = make({ touch: true });
    expect(phone.el.dataset.lane).toBe('phone');
    phone.dispose();
    for (const [w, h] of [
      [844, 390],
      [667, 375],
    ]) {
      set(w, h);
      const land = make({ touch: true });
      expect(land.el.dataset.lane, `${w}x${h}`).toBe('landscape');
      land.dispose();
    }
    set(1024, 768);
  });

  test('a portrait phone shows the move step as one line in the prompt lane, then the card', () => {
    // At 390x844 the 350 lane sat on the arrival trail at Explore: 3 of its
    // 4 coins projected under the card (wave-1 integration).
    const set = (w: number, h: number) => {
      Object.defineProperty(window, 'innerWidth', { value: w, configurable: true });
      Object.defineProperty(window, 'innerHeight', { value: h, configurable: true });
    };
    const touchWords = (v: GuideView) =>
      guideCopy(v, {
        touch: true,
        lookMode: 'drag',
        runKey: null,
        compassLabel: 'Mayor',
        finaleLabel: 'Projects',
      });
    set(390, 844);
    const c = make({ touch: true });
    const move = view();
    c.render(move, touchWords(move));
    expect(c.el.dataset.lane).toBe('phone');
    expect(c.el.dataset.compact).toBe('1');
    // one line: the step and Skip, still read out as 'First steps · 1/5'
    const buttons = [...c.el.querySelectorAll('button')];
    expect(buttons.map((b) => b.dataset.g)).toEqual(['skip']);
    expect(buttons[0].style.minHeight).toContain('44px');
    expect(c.el.textContent).toContain('First steps · 1/5');
    expect(c.el.textContent).toContain('Walk: drag the joystick, bottom left.');
    buttons[0].click();
    expect(pressed).toEqual(['skip']);
    // walked: the check plays on the full card, back in the 350 lane
    const done = view({ version: 2, justDone: 'move', done: ['move'] });
    c.render(done, touchWords(done));
    expect(c.el.dataset.compact).toBe('0');
    expect(c.el.querySelector('[data-check]')).not.toBeNull();
    const look = view({ version: 3, step: 'look', done: ['move'] });
    c.render(look, touchWords(look));
    expect(c.el.dataset.compact).toBe('0');
    // a rotation to landscape mid-step redraws the full card in its lane
    const again = view({ version: 4 });
    c.render(again, touchWords(again));
    expect(c.el.dataset.compact).toBe('1');
    set(844, 390);
    window.dispatchEvent(new Event('resize'));
    expect(c.el.dataset.lane).toBe('landscape');
    expect(c.el.dataset.compact).toBe('0');
    expect(c.el.textContent).toContain('Skip');
    c.dispose();
    // the desktop's move step keeps the full card
    set(1440, 900);
    const desk = make();
    const dm = view();
    desk.render(dm, words(dm));
    expect(desk.el.dataset.compact).toBe('0');
    set(1024, 768);
  });

  test('on a phone the card rises to stay 8 px above a tall prompt, and never bobs back', () => {
    Object.defineProperty(window, 'innerWidth', { value: 390, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 844, configurable: true });
    let promptTop = 486;
    const prompt = document.createElement('div');
    prompt.getBoundingClientRect = () =>
      ({
        top: promptTop,
        left: 97,
        width: 195,
        height: 58,
        right: 292,
        bottom: promptTop + 58,
      }) as DOMRect;
    overlay.appendChild(prompt);
    const c = make({ touch: true, prompt: () => prompt });
    const v = view();
    c.render(v, words(v));
    c.checkPrompt();
    expect(c.el.dataset.lift).toBe('366'); // 844 - 486 + 8
    promptTop = 504; // a one-line prompt: the card stays where it is
    c.checkPrompt();
    expect(c.el.dataset.lift).toBe('366');
    Object.defineProperty(window, 'innerHeight', { value: 1024, configurable: true });
  });
});

// ---- First steps (A6): main-simple makes the card when the guide arms ------

// D6 reads #ds-guide, or any 'ds:guide' event, as "the guide has armed" and
// then stands the welcome's one-time compass hint down. So neither may exist
// on a visit the guide never arms (Ask the townsfolk, Hiring, a race): the
// card used to be built at boot, and its first redraw sent {active: false}.
// main-simple's own methods run here on a stub app, as in interiorEntry.
describe("main-simple: no #ds-guide and no 'ds:guide' until the guide arms (A6, D6)", () => {
  type Method = (this: unknown, ...a: unknown[]) => unknown;
  const NAMES = ['renderGuide', 'armGuide', 'createGuideCard', 'guideFinaleDistrict'] as const;
  let proto: Record<(typeof NAMES)[number], Method>;
  beforeAll(async () => {
    // The boot latch: importing the module then builds no app.
    (window as unknown as { __lifeIslandBooted?: boolean }).__lifeIslandBooted = true;
    const mod = await import('../main-simple');
    // GuideCard.ts comes in with import() (wave 4, bundle): in, as after
    // the welcome card's idle prefetch, so arming draws the card at once.
    await mod.loadGuideCard();
    proto = mod.SimpleApp.prototype as unknown as typeof proto;
  }, 120000);

  /** The fields renderGuide and armGuide read, and the four methods, for real. */
  const stubApp = (guide: Guide) => {
    const app: Record<string, unknown> = {
      guide,
      guideCard: null,
      ui: {
        getOverlay: () => document.getElementById('ui-overlay')!,
        isTouchDevice: () => false,
      },
      compassLabel: '',
      passport: null,
      compassDistrict: null,
      guidePrevValid: true,
      onGuideButton: () => undefined,
    };
    for (const k of NAMES) app[k] = proto[k].bind(app);
    return app as typeof app & Record<(typeof NAMES)[number], (...a: unknown[]) => unknown>;
  };

  const seen: Array<{ active: boolean; step: string | null }> = [];
  const on = (e: Event) => seen.push((e as CustomEvent).detail);
  let app: ReturnType<typeof stubApp> | null = null;
  // happy-dom has no Web Animations; the card animates in when motion is on.
  const proto0 = Element.prototype as { animate?: unknown };
  let animate0: unknown;
  beforeEach(() => {
    document.body.innerHTML = '<div id="ui-overlay"></div>';
    localStorage.clear();
    seen.length = 0;
    window.addEventListener('ds:guide', on);
    animate0 = proto0.animate;
    proto0.animate = () => ({ cancel() {} });
  });
  afterEach(() => {
    window.removeEventListener('ds:guide', on);
    (app?.guideCard as GuideCard | null)?.dispose();
    app = null;
    proto0.animate = animate0;
  });

  test('before it arms, frames and redraws put nothing on the page', () => {
    const { guide } = makeGuide();
    app = stubApp(guide);
    for (let i = 0; i < 30; i++) {
      // a panel-driven completion before arming is saved, not drawn
      guide.frame(idle({ top: i === 10 ? 'portfolio-menu' : null }));
      app.renderGuide();
    }
    expect(document.getElementById('ds-guide')).toBeNull();
    expect(seen).toEqual([]);
    expect(app.guideCard).toBeNull();
  });

  test('arming makes the one card and sends its first ds:guide at once', () => {
    const { guide } = makeGuide();
    app = stubApp(guide);
    expect(app.armGuide('explore')).toBe(true);
    const el = document.getElementById('ds-guide');
    expect(el).not.toBeNull();
    expect(el!.dataset.active).toBe('1');
    expect(seen).toEqual([{ active: true, step: 'move' }]);
    expect(localStorage.getItem('ds_hint_compass')).toBe('1');
    // later redraws reuse it
    run(guide, 0.7);
    app.renderGuide();
    expect(document.querySelectorAll('#ds-guide')).toHaveLength(1);
    // a Skip still reaches the page through the same card
    guide.skip();
    app.renderGuide();
    expect(seen[seen.length - 1]).toEqual({ active: false, step: null });
    expect(el!.style.display).toBe('none');
  });

  test('a guide that cannot arm (skipped before) never makes a card', () => {
    const skipped = JSON.stringify({ v: 1, done: [], finished: false, skipped: true, t: 1 });
    const { guide } = makeGuide({}, { [GUIDE_KEY]: skipped });
    app = stubApp(guide);
    expect(app.armGuide('explore')).toBe(false);
    app.renderGuide();
    expect(document.getElementById('ds-guide')).toBeNull();
    expect(seen).toEqual([]);
  });
});

// ---- wave-1 integration: the talk step and the pill agree -----------------

// After a reload the arrival trail is gone (first visit only), yet First
// steps resumes at talk and names the villager A7 picked for this load. The
// pill fell through to Projects, 103 m away, while the card said 'Walk up to
// Mayor'. On a first visit the trail ends at its seat before a word is said,
// with the same result. And at night the trail villager goes to bed seconds
// after the intro: the card and the pill named a villager tagged "asleep".
// updateQuestCompass, talkVillager and villagerUp run for real here, on a
// stub app and world, with the guide asking the app for its talk villager.
describe('main-simple: the pill names the villager First steps sends the visitor to', () => {
  type Method = (this: unknown, ...a: unknown[]) => unknown;
  const NAMES = [
    'updateQuestCompass',
    'zonePos',
    'nearestDistrict',
    'districtLabel',
    'projectTangent',
    'trailSeat',
    'villagerUp',
    'talkVillager',
  ] as const;
  let proto: Record<(typeof NAMES)[number], Method>;
  let V3: typeof import('three').Vector3;
  beforeAll(async () => {
    (window as unknown as { __lifeIslandBooted?: boolean }).__lifeIslandBooted = true;
    const mod = await import('../main-simple');
    // GuideCard.ts comes in with import() (wave 4, bundle): in, as after
    // the welcome card's idle prefetch, so arming draws the card at once.
    await mod.loadGuideCard();
    proto = mod.SimpleApp.prototype as unknown as typeof proto;
    V3 = (await import('three')).Vector3;
  }, 120000);

  /**
   * An app on a world of three villagers who talk: the Mayor 4 u away (his
   * seat, where the trail was laid, 8 u away), the Elder Sage 12 u away and
   * the Teller 40 u away. `done` is the reloaded guide's progress.
   */
  const setup = (over: { coins?: boolean; stamps?: number; done?: GuideStep[] } = {}) => {
    const stamps = over.stamps ?? 0;
    const player = new V3(0, 100, 0);
    const villagers = [
      { name: 'Mayor', meshRef: { visible: true, position: new V3(4, 99.9, 0) } },
      { name: 'Elder Sage', meshRef: { visible: true, position: new V3(0, 99.3, 12) } },
      { name: 'Teller', meshRef: { visible: true, position: new V3(0, 91.7, -40) } },
    ];
    const activity: Record<string, string | undefined> = {};
    const up = (n: string): boolean =>
      villagers.some((v) => v.name === n && v.meshRef.visible) && activity[n] !== 'sleep';
    const pills: Array<{ label: string } | null> = [];
    const app: Record<string, unknown> = {
      scene: {
        getPlayer: () => ({
          getWorldPosition: () => player.clone(),
          getWorldPositionInto: (o: InstanceType<typeof V3>) => o.copy(player),
          getSurfaceNormalInto: (o: InstanceType<typeof V3>) => o.set(0, 1, 0),
        }),
        isInsideInterior: () => false,
        hasTrailCoins: () => over.coins === true,
        getIsland: () => ({ npcTargets: villagers }),
        getNpcActivity: (n: string) => activity[n],
        getNpcPosition: (n: string) =>
          villagers.find((v) => v.name === n)?.meshRef.position ?? null,
        getZonesManager: () => ({
          getZones: () => [
            { id: 'projects', getPosition: () => new V3(0, 0, 100) },
            { id: 'professional', getPosition: () => new V3(0, 0, -100) },
          ],
        }),
        setGuideTarget: () => undefined,
        getOrbitCamera: () => ({ getForwardDirection: () => new V3(1, 0, 0) }),
      },
      // guideWorld's nearestAiVillager, as main-simple builds it: the nearest
      // villager who talks, in the world and not headed for bed.
      guideWorld: {
        nearestAiVillager: () =>
          villagers
            .filter((v) => up(v.name))
            .map((v) => ({ name: v.name, pos: v.meshRef.position }))
            .sort((a, b) => a.pos.distanceTo(player) - b.pos.distanceTo(player))[0] ?? null,
      },
      ui: {
        updateQuestCompass: (p: { label: string } | null) => pills.push(p),
        isTouchDevice: () => false,
        panels: { isOpen: () => false },
        flashMessage: () => undefined,
        toast: () => undefined,
      },
      passport: {
        count: () => stamps,
        has: (id: string) => stamps > 0 && id === 'projects',
        isComplete: () => false,
        isStampZone: (id: string) => id === 'projects' || id === 'professional',
      },
      mapGuideTarget: null,
      mapGuideZone: null,
      mapGuideLabel: '',
      arrivalHold: null,
      doorPromptZone: null,
      raceGuideTarget: null,
      aiGuideTarget: null,
      deliverySystem: null,
      deliveryOptIn: false,
      // A7 picks the Mayor at every intro, trail or not.
      trailVillager: 'Mayor',
      trailDone: false,
      npcSeats: new Map([['Mayor', new V3(8, 99.6, 0)]]),
      stampsSeen: -1,
      pendingNextFlash: false,
      compassDistrict: null,
      districtDists: [],
      zoneList: null,
      lastCompassTarget: null,
      compassLabel: '',
      _compassState: {},
      _qcPlayerPos: new V3(),
      _qcNormal: new V3(),
      _qcToTarget: new V3(),
      _qcCamFwd: new V3(),
      _qcCross: new V3(),
      _qcTmp: new V3(),
    };
    for (const k of NAMES) app[k] = proto[k].bind(app);
    // The guide asks the app, as setupGuide wires it.
    const talkTarget = (current: string | null): string | null =>
      (app.talkVillager as (c: string | null) => string | null)(current);
    const first = armed({ talkTarget });
    for (const s of over.done ?? ['move', 'look']) first.guide.complete(s);
    const { guide, tracked } = makeGuide({ welcomed: true, talkTarget }, { ...first.data });
    app.guide = guide;
    guide.arm('explore');
    run(guide, 0.7);
    const frame = () => {
      (app.updateQuestCompass as () => void)();
      return {
        label: app.compassLabel as string,
        target: app.lastCompassTarget as InstanceType<typeof V3> | null,
      };
    };
    const pos = (n: string) => villagers.find((v) => v.name === n)!.meshRef.position;
    const hide = (n: string) => (villagers.find((v) => v.name === n)!.meshRef.visible = false);
    return { guide, tracked, app, frame, player, pos, hide, activity, pills };
  };

  test('the card says "Walk up to Mayor" and the pill says Mayor, where he stands', () => {
    const { guide, frame, pos } = setup();
    expect(guide.talkTargetNow()).toBe('Mayor');
    expect(guideCopy(guide.view(), wordsCtx).body).toContain('Walk up to Mayor and press [E]');
    const f = frame();
    expect(f.label).toBe('Mayor');
    expect(f.target).toBe(pos('Mayor'));
    // He wanders off: the pill follows him, not the seat the trail was laid to.
    pos('Mayor').set(16, 98.7, 0);
    expect(frame().target).toBe(pos('Mayor'));
  });

  test('a reload at step 1: the pill names him through walk and look, never Projects', () => {
    const { guide, frame } = setup({ done: [] });
    expect(guide.currentStep()).toBe('move');
    expect(frame().label).toBe('Mayor');
    guide.complete('move');
    run(guide, 0.5);
    expect(guide.currentStep()).toBe('look');
    expect(frame().label).toBe('Mayor');
    guide.complete('look');
    run(guide, 0.5);
    expect(guide.currentStep()).toBe('talk');
    expect(frame().label).toBe('Mayor');
  });

  test('the chip, a talk, or a stamp hand the pill back to the districts', () => {
    const chip = setup();
    run(chip.guide, 20);
    expect(chip.guide.view().chip).toBe(true);
    expect(chip.frame().label).toBe('🚀 Projects');
    const talked = setup();
    talked.guide.complete('talk');
    expect(talked.frame().label).toBe('🚀 Projects');
    // a stamp ends it, as it ends the trail: the 'Next:' flash names the pill
    const stamped = setup({ stamps: 1 });
    expect(stamped.frame().label).not.toBe('Mayor');
  });

  test('a first visit: the coins’ seat, then the villager himself, with no Projects between', () => {
    const { guide, frame, player, pos, app } = setup({ coins: true, done: [] });
    const f = frame();
    expect(f.label).toBe('Mayor');
    expect(f.target!.toArray()).toEqual([8, 99.6, 0]);
    // Within 4 u of the seat the trail has done its job; the guide is still
    // on look, and the pill stays on the Mayor, now where he stands.
    guide.complete('move');
    run(guide, 0.5);
    player.set(5, 99.8, 0);
    const near = frame();
    expect(app.trailDone).toBe(true);
    expect(guide.currentStep()).toBe('look');
    expect(near.label).toBe('Mayor');
    expect(near.target).toBe(pos('Mayor'));
  });

  test('at night the trail villager goes to bed: the pill and the card name a stand-in', () => {
    const { guide, frame, pos, activity, app } = setup({ coins: true });
    expect(frame().label).toBe('Mayor'); // the trail, to his seat
    activity.Mayor = 'sleep'; // the walk home, under an "asleep" tag
    // The trail's pill lets go of the empty seat at once: it follows him for
    // the half second until the guide asks again, never the seat.
    const leaving = frame();
    expect(app.trailDone).toBe(true);
    expect(leaving.target).toBe(pos('Mayor'));
    run(guide, 0.6);
    expect(guide.view()).toMatchObject({ step: 'talk', talkTarget: 'Elder Sage' });
    expect(guideCopy(guide.view(), wordsCtx).body).toBe(
      'Elder Sage talks through Claude Haiku 4.5. Walk up to Elder Sage and press [E] to ask anything.',
    );
    const g = frame();
    expect(g.label).toBe('Elder Sage');
    expect(g.target).toBe(pos('Elder Sage'));
  });

  test('a stand-in is kept while up; with nobody within 30 u the talk step is skipped', () => {
    const { guide, tracked, frame, pos, hide, activity } = setup();
    activity.Mayor = 'sleep';
    run(guide, 0.6);
    expect(guide.view().talkTarget).toBe('Elder Sage');
    // The Teller walks up closer than the Elder Sage: the card does not flip.
    pos('Teller').set(0, 99.9, -3);
    run(guide, 1.2);
    expect(guide.view().talkTarget).toBe('Elder Sage');
    // The Elder Sage steps inside: the nearest one up, within 30 u.
    hide('Elder Sage');
    run(guide, 0.6);
    expect(guide.view().talkTarget).toBe('Teller');
    expect(frame().label).toBe('Teller');
    // The Teller walks 40 u off and stays the stand-in (as the trail
    // villager would); in bed, nobody is left: skipped, and Projects.
    pos('Teller').set(0, 91.7, -40);
    run(guide, 0.6);
    expect(guide.view().talkTarget).toBe('Teller');
    activity.Teller = 'sleep';
    run(guide, 0.6);
    expect(guide.currentStep()).toBe('portfolio');
    expect(tracked).toContainEqual({ name: 'guide_step', step: 'talk', outcome: 'skipped' });
    expect(frame().label).toBe('🚀 Projects');
  });

  test('the nearest awake villager is a stand-in only within 30 u', () => {
    const far = setup();
    far.hide('Elder Sage');
    far.activity.Mayor = 'sleep'; // the Teller, 40 u away, is the only one up
    run(far.guide, 0.6);
    expect(far.guide.currentStep()).toBe('portfolio');
    expect(far.frame().label).toBe('🚀 Projects');
  });
});

// ---- P2-A4: the recruiter route -------------------------------------------

describe('RecruiterRoute: three stops after the hire card (P2-A4)', () => {
  type Tracked = { name: string; stop: string; outcome: string };
  const make = () => {
    const tracked: Tracked[] = [];
    const route = new RecruiterRoute({ track: (name, p) => tracked.push({ name, ...p }) });
    return { route, tracked };
  };
  /** Frames for `seconds`, with nothing (or something) in the way. */
  const frames = (route: RecruiterRoute, seconds: number, blocked = false): void => {
    for (let t = 0; t < seconds - 1e-9; t += 1 / 60) route.frame(1 / 60, blocked);
  };

  test('the stops are Projects, Professional, Get in touch, in that order', () => {
    expect(ROUTE_STOPS.map((x) => x.id)).toEqual(['projects', 'professional', 'contact']);
    expect(ROUTE_STOPS.map((x) => x.label)).toEqual(['Projects', 'Professional', 'Get in touch']);
  });

  test('it arms when a hire card closes on a visitor who has walked under 4 u', () => {
    expect(ROUTE_WALK_U).toBe(4);
    const { route, tracked } = make();
    expect(route.showing()).toBe(false);
    expect(route.arm('hire', 3.9)).toBe(true);
    expect(route.showing()).toBe(true);
    expect(tracked).toEqual([{ name: 'recruiter_route', stop: 'hire', outcome: 'shown' }]);
    // a visitor already exploring is left alone
    const walked = make();
    expect(walked.route.arm('hire', 4)).toBe(false);
    expect(walked.route.arm('hire', Number.NaN)).toBe(false);
    expect(walked.route.showing()).toBe(false);
    expect(walked.tracked).toEqual([]);
  });

  test('visible 600 ms after the card closes, inside the 1 s the brief allows', () => {
    const { route } = make();
    route.arm('hire', 0);
    expect(route.view()).toMatchObject({ phase: 'route', visible: false, active: true });
    frames(route, 0.55);
    expect(route.view().visible).toBe(false);
    frames(route, 0.1);
    expect(route.view().visible).toBe(true);
  });

  test('a panel, a tour or a room hides it; it comes back 600 ms after, still holding hints', () => {
    const { route } = make();
    route.arm('tour', 0);
    frames(route, 0.7);
    const v0 = route.version();
    frames(route, 2); // nothing changes: no redraw
    expect(route.version()).toBe(v0);
    frames(route, 3, true);
    expect(route.view()).toMatchObject({ visible: false, active: true });
    expect(route.showing()).toBe(true);
    frames(route, 0.55);
    expect(route.view().visible).toBe(false);
    frames(route, 0.1);
    expect(route.view().visible).toBe(true);
  });

  test("a stop's 'Show me' closes it and is tracked with two properties", () => {
    const { route, tracked } = make();
    route.arm('hire', 0);
    frames(route, 0.7);
    expect(route.pick('nowhere')).toBe(false); // not a stop: nothing happens
    expect(route.showing()).toBe(true);
    expect(route.pick('professional')).toBe(true);
    expect(route.showing()).toBe(false);
    expect(route.view()).toMatchObject({ visible: false, active: false });
    expect(tracked[tracked.length - 1]).toEqual({
      name: 'recruiter_route',
      stop: 'professional',
      outcome: 'show',
    });
    for (const t of tracked) {
      expect(Object.keys(t).filter((k) => k !== 'name')).toEqual(['stop', 'outcome']);
    }
    expect(route.pick('projects')).toBe(false); // gone: a second press does nothing
  });

  test("'Stay in the menu' closes it, and it has had its turn for this visit", () => {
    const { route, tracked } = make();
    route.arm('hire', 0);
    route.stay();
    expect(route.showing()).toBe(false);
    expect(tracked[tracked.length - 1]).toEqual({
      name: 'recruiter_route',
      stop: 'none',
      outcome: 'stay',
    });
    expect(route.arm('hire', 0)).toBe(false);
    expect(route.arm('deeplink', 0)).toBe(false);
  });

  test('its version never collides with a First steps version, and changes only when the card does', () => {
    const { route } = make();
    const { guide } = armed();
    expect(route.version()).toBeGreaterThanOrEqual(1_000_000);
    expect(guide.version()).toBeLessThan(1_000_000);
    const v0 = route.version();
    route.arm('hire', 0);
    expect(route.version()).toBeGreaterThan(v0);
  });

  test('the words: the title, three Show me rows, Stay in the menu; nothing overclaimed', () => {
    const { route } = make();
    route.arm('hire', 0);
    const c = route.copy();
    expect(c.title).toBe('Recruiter route · 3 stops');
    expect(c.body).toBe('');
    expect(c.headButton).toEqual({ id: 'stay', label: 'Stay in the menu' });
    expect(c.rows).toEqual([
      { label: 'Projects', button: { id: 'route:projects', label: 'Show me' } },
      { label: 'Professional', button: { id: 'route:professional', label: 'Show me' } },
      { label: 'Get in touch', button: { id: 'route:contact', label: 'Show me' } },
    ]);
    expect(c.buttons).toEqual([]);
    for (const s of [c.title, c.body, c.headButton.label, ...c.rows!.map((r) => r.label)]) {
      expect(s).not.toMatch(/agent/i);
      expect(s).not.toMatch(/live AI/i);
    }
  });

  test('a /z/hire visitor is told where they are, once: the pitch line', () => {
    const { route } = make();
    route.arm('deeplink', 0);
    expect(route.copy().body).toBe(
      "You're on Abbas's 3D portfolio island — walk in to see the work.",
    );
    expect(route.copy().body).toBe(ROUTE_PITCH);
    // the pill and the tour's card have a welcome card behind them: no pitch
    for (const source of ['hire', 'tour'] as const) {
      const r = make().route;
      r.arm(source, 0);
      expect(r.copy().body).toBe('');
    }
  });
});

describe('GuideCard: the recruiter route on the same card (P2-A4)', () => {
  const pressed: string[] = [];
  const seen: Array<{ active: boolean; step: string | null }> = [];
  const on = (e: Event) => seen.push((e as CustomEvent).detail);
  let card: GuideCard | null = null;
  const proto0 = Element.prototype as { animate?: unknown };
  let animate0: unknown;
  const mount = (over: Partial<GuideCardOptions> = {}): GuideCard => {
    card = new GuideCard(document.getElementById('ui-overlay')!, {
      touch: false,
      reducedMotion: () => true,
      onButton: (id) => pressed.push(id),
      prompt: () => null,
      ...over,
    });
    return card;
  };
  const shown = (source: 'hire' | 'deeplink' = 'hire') => {
    const route = new RecruiterRoute();
    route.arm(source, 0);
    for (let i = 0; i < 45; i++) route.frame(1 / 60, false);
    return route;
  };
  beforeEach(() => {
    document.body.innerHTML = '<div id="ui-overlay"></div>';
    pressed.length = 0;
    seen.length = 0;
    window.addEventListener('ds:guide', on);
    animate0 = proto0.animate;
    proto0.animate = () => ({ cancel() {} });
  });
  afterEach(() => {
    window.removeEventListener('ds:guide', on);
    card?.dispose();
    card = null;
    proto0.animate = animate0;
    Object.defineProperty(window, 'innerHeight', { value: 768, configurable: true });
  });

  test("it holds hints like First steps: data-active '1' and 'ds:guide' {active, step: 'route'}", () => {
    const c = mount();
    const route = shown();
    c.render(route.view(), route.copy());
    expect(c.el.style.display).toBe('block');
    expect(c.el.dataset.active).toBe('1');
    expect(c.el.dataset.step).toBe('route');
    expect(seen).toEqual([{ active: true, step: 'route' }]);
    expect(c.el.textContent).toContain('Recruiter route · 3 stops');
    // it goes: the gate opens
    route.stay();
    c.render(route.view(), route.copy());
    expect(c.el.style.display).toBe('none');
    expect(seen[seen.length - 1]).toEqual({ active: false, step: null });
  });

  test("three 'Show me' buttons, read as 'Show me Projects', and Stay in the menu", () => {
    const c = mount();
    const route = shown();
    c.render(route.view(), route.copy());
    const stops = [...c.el.querySelectorAll<HTMLButtonElement>('button[data-g^="route:"]')];
    expect(stops.map((b) => b.dataset.g)).toEqual([
      'route:projects',
      'route:professional',
      'route:contact',
    ]);
    for (const b of stops) expect(b.textContent).toMatch(/Show me/);
    expect(stops.map((b) => b.getAttribute('aria-label'))).toEqual([
      'Show me Projects',
      'Show me Professional',
      'Show me Get in touch',
    ]);
    // each a 44 px target
    for (const b of stops) expect(b.style.minHeight).toBe('var(--ds-hit-target, 44px)');
    stops[0].click();
    c.el.querySelector<HTMLButtonElement>('button[data-g="stay"]')!.click();
    expect(pressed).toEqual(['route:projects', 'stay']);
    expect(c.el.querySelector('button[data-g="stay"]')!.textContent).toBe('Stay in the menu');
  });

  test('one filled primary, the indigo; the rest are outlines; nothing is green', () => {
    const c = mount();
    const route = shown();
    c.render(route.view(), route.copy());
    const stops = [...c.el.querySelectorAll<HTMLButtonElement>('button[data-g^="route:"]')];
    // (happy-dom drops a var() background, so the card marks its primary)
    expect(stops.map((b) => b.dataset.primary ?? '')).toEqual(['1', '', '']);
    for (const b of stops.slice(1)) expect(b.style.background).toBe('rgba(255, 255, 255, 0.06)');
    expect(stops[0].style.background).toBe('');
    // the fill is D3's indigo token with the literal as its fallback, and
    // neither file carries the green reserved for Work with me
    const card = readFileSync(join(process.cwd(), 'GuideCard.ts'), 'utf8');
    expect(card).toContain("'var(--ds-primary, linear-gradient(135deg,#4c5be0,#7a45d6))'");
    for (const f of ['GuideCard.ts', 'Guide.ts']) {
      const src = readFileSync(join(process.cwd(), f), 'utf8').toLowerCase();
      for (const green of ['#087a4c', '#067046', '--ds-green', '--ds-success']) {
        expect(src, `${f}: ${green}`).not.toContain(green);
      }
    }
  });

  test('stacked on a desktop window; side by side on a phone and in a short window', () => {
    const route = shown();
    const desk = mount();
    desk.render(route.view(), route.copy());
    expect(desk.el.querySelector<HTMLElement>('[data-rows]')!.dataset.rows).toBe('stacked');
    desk.dispose();
    const phone = mount({ touch: true });
    phone.render(route.view(), route.copy());
    const across = phone.el.querySelector<HTMLElement>('[data-rows]')!;
    expect(across.dataset.rows).toBe('across');
    expect(across.style.flexDirection).toBe('row');
    phone.dispose();
    Object.defineProperty(window, 'innerHeight', { value: 480, configurable: true });
    const short = mount();
    short.render(route.view(), route.copy());
    expect(short.el.querySelector<HTMLElement>('[data-rows]')!.dataset.rows).toBe('across');
    expect(short.el.dataset.lane).toBe('landscape');
  });

  test('the pitch line shows for a /z/hire visitor only', () => {
    const c = mount();
    const link = shown('deeplink');
    c.render(link.view(), link.copy());
    expect(c.el.textContent).toContain(ROUTE_PITCH);
    c.dispose();
    const plain = mount();
    const route = shown('hire');
    plain.render(route.view(), route.copy());
    expect(plain.el.textContent).not.toContain('portfolio island');
  });

  test('reduced motion: nothing animates', () => {
    const calls: unknown[] = [];
    proto0.animate = (...a: unknown[]) => {
      calls.push(a);
      return { cancel() {} };
    };
    const c = mount({ reducedMotion: () => true });
    const route = shown();
    c.render(route.view(), route.copy());
    expect(calls).toEqual([]);
  });
});

// main-simple's own handlers, for real, on a stub app (as in interiorEntry).
describe('main-simple: a hire card closing arms the recruiter route (P2-A4)', () => {
  type Method = (this: unknown, ...a: unknown[]) => unknown;
  const NAMES = [
    'renderGuide',
    'armGuide',
    'armRoute',
    'onModalEvent',
    'onGuideButton',
    'createGuideCard',
    'guideFinaleDistrict',
    'guideHoldsHints',
  ] as const;
  let proto: Record<(typeof NAMES)[number], Method>;
  beforeAll(async () => {
    (window as unknown as { __lifeIslandBooted?: boolean }).__lifeIslandBooted = true;
    const mod = await import('../main-simple');
    // GuideCard.ts comes in with import() (wave 4, bundle): in, as after
    // the welcome card's idle prefetch, so arming draws the card at once.
    await mod.loadGuideCard();
    proto = mod.SimpleApp.prototype as unknown as typeof proto;
  }, 120000);

  const stubApp = (guide: Guide, walked = 0) => {
    const app: Record<string, unknown> = {
      guide,
      guideCard: null,
      route: new RecruiterRoute(),
      walkedSinceLoad: walked,
      hireCardSource: null,
      ui: {
        getOverlay: () => document.getElementById('ui-overlay')!,
        isTouchDevice: () => false,
        isWelcomeVisible: () => false,
      },
      introSettled: true,
      compassLabel: '',
      passport: null,
      compassDistrict: null,
      guidePrevValid: true,
    };
    for (const k of NAMES) app[k] = proto[k].bind(app);
    return app as typeof app & Record<(typeof NAMES)[number], (...a: unknown[]) => unknown>;
  };
  const closed = { open: false, id: 'zone', zone: 'hire' };
  /** The frames main-simple's guideTick would run: the route, then a redraw. */
  const tick = (app: ReturnType<typeof stubApp>, seconds: number): void => {
    for (let t = 0; t < seconds - 1e-9; t += 1 / 60) {
      (app.route as RecruiterRoute).frame(1 / 60, false);
      app.renderGuide();
    }
  };
  const sent: Array<{ key: string; source: string }> = [];
  const onTo = (e: Event) => sent.push((e as CustomEvent).detail);
  let app: ReturnType<typeof stubApp> | null = null;
  const proto0 = Element.prototype as { animate?: unknown };
  let animate0: unknown;
  beforeEach(() => {
    document.body.innerHTML = '<div id="ui-overlay"></div>';
    localStorage.clear();
    sent.length = 0;
    window.addEventListener('ds:guide-to', onTo);
    animate0 = proto0.animate;
    proto0.animate = () => ({ cancel() {} });
  });
  afterEach(() => {
    window.removeEventListener('ds:guide-to', onTo);
    (app?.guideCard as GuideCard | null)?.dispose();
    app = null;
    proto0.animate = animate0;
  });
  const cardText = (): string => document.getElementById('ds-guide')?.textContent ?? '';
  const visible = (): boolean => document.getElementById('ds-guide')?.style.display === 'block';

  test('within 1 s of the hire card closing the route card is up; arming sets ds_hint_compass', () => {
    app = stubApp(makeGuide().guide);
    app.onModalEvent(closed);
    expect(localStorage.getItem('ds_hint_compass')).toBe('1');
    expect(document.getElementById('ds-guide')).not.toBeNull(); // made at the arming
    expect(visible()).toBe(false); // the 600 ms beat
    tick(app, 0.7);
    expect(visible()).toBe(true);
    expect(cardText()).toContain('Recruiter route · 3 stops');
    expect(app.guideHoldsHints()).toBe(true);
  });

  test('other panels, an opening hire card and a visitor who walked off arm nothing', () => {
    app = stubApp(makeGuide().guide);
    for (const d of [
      { open: true, id: 'zone', zone: 'hire' },
      { open: false, id: 'zone', zone: 'projects' },
      { open: false, id: 'island-map' },
      null,
      'hire',
    ]) {
      app.onModalEvent(d);
    }
    expect((app.route as RecruiterRoute).showing()).toBe(false);
    expect(document.getElementById('ds-guide')).toBeNull();
    const walked = stubApp(makeGuide().guide, 9);
    walked.onModalEvent(closed);
    expect((walked.route as RecruiterRoute).showing()).toBe(false);
    expect(localStorage.getItem('ds_hint_compass')).toBeNull();
  });

  test("'Show me' on Projects sends 'ds:guide-to' district:projects, and First steps arms", () => {
    const { guide } = makeGuide();
    app = stubApp(guide);
    app.onModalEvent(closed);
    tick(app, 0.7);
    document.querySelector<HTMLButtonElement>('#ds-guide button[data-g="route:projects"]')!.click();
    // the card's own onButton is the stub's; main-simple's handler runs here
    app.onGuideButton('route:projects');
    expect(sent).toEqual([{ key: 'district:projects', source: 'route' }]);
    expect((app.route as RecruiterRoute).showing()).toBe(false);
    expect(guide.running()).toBe(true);
    // the card now shows First steps
    run(guide, 0.7);
    app.renderGuide();
    expect(cardText()).toContain('First steps · 1/5');
    expect(cardText()).not.toContain('Recruiter route');
  });

  test("'Stay in the menu' takes the card down and arms nothing", () => {
    const { guide } = makeGuide();
    app = stubApp(guide);
    app.onModalEvent(closed);
    tick(app, 0.7);
    app.onGuideButton('stay');
    expect(visible()).toBe(false);
    expect(guide.running()).toBe(false);
    expect(sent).toEqual([]);
    expect(app.guideHoldsHints()).toBe(false);
    // and a second hire card this visit does not bring it back
    app.onModalEvent(closed);
    tick(app, 0.7);
    expect(visible()).toBe(false);
  });

  test('a /z/hire link: the pitch line, once; the tour and the pill: none', () => {
    app = stubApp(makeGuide().guide);
    app.hireCardSource = 'deeplink';
    app.onModalEvent(closed);
    expect(app.hireCardSource).toBeNull(); // spent on this card
    tick(app, 0.7);
    expect(cardText()).toContain(ROUTE_PITCH);
    (app.guideCard as GuideCard).dispose();
    document.body.innerHTML = '<div id="ui-overlay"></div>';
    const tour = stubApp(makeGuide().guide);
    tour.hireCardSource = 'tour';
    tour.onModalEvent(closed);
    tick(tour, 0.7);
    expect(cardText()).toContain('Recruiter route · 3 stops');
    expect(cardText()).not.toContain('portfolio island');
    (tour.guideCard as GuideCard).dispose();
  });

  test('First steps running when the hire card closes: the route has the card, then hands it back', () => {
    const { guide } = makeGuide();
    app = stubApp(guide);
    app.armGuide('explore');
    run(guide, 0.7);
    app.renderGuide();
    expect(cardText()).toContain('First steps · 1/5');
    app.onModalEvent(closed);
    tick(app, 0.7);
    expect(cardText()).toContain('Recruiter route · 3 stops');
    app.onGuideButton('stay');
    app.renderGuide();
    expect(cardText()).toContain('First steps · 1/5');
  });
});

// ---- P2-A12: the Next chip and the goal ladder ------------------------------
/** A guide whose first steps are over (skipped), and its store. */
function overGuide(init: Record<string, string> = {}) {
  const h = makeGuide({}, init);
  if (!h.guide.over()) {
    h.guide.arm('explore');
    run(h.guide, 0.7);
    h.guide.skip();
    run(h.guide, 1);
  }
  return h;
}
const noFacts: Record<string, boolean> = {};
/** A chip that is on and past its 600 ms. */
function chipOn(facts: Record<string, boolean> = noFacts, init: Record<string, string> = {}) {
  const h = overGuide(init);
  const tracked: Array<{ goal: string; outcome: string }> = [];
  const chip = new NextChip(h.guide, { track: (_n, p) => tracked.push(p) });
  chip.sync(true, facts, null, []);
  for (let i = 0; i < 45; i++) chip.frame(1 / 60, false);
  return { ...h, chip, tracked };
}

describe('GOAL_LADDER and NextChip (P2-A12)', () => {
  test('the ladder: four stamps and the hire card, then five things to try, then four long ones', () => {
    expect(GOAL_LADDER.map((g) => g.id)).toEqual([
      'stamp:projects',
      'stamp:professional',
      'stamp:personal',
      'stamp:contact',
      'hire',
      'talk',
      'race',
      'catch',
      'lesson',
      'shop',
      'build',
      'guestbook',
      'deliveries',
      'crown',
    ]);
    expect(GOAL_LADDER.map((g) => g.rung).join('')).toBe('11111222223333');
    // every goal leads somewhere the 'Show me' seam can take: a key
    // resolveGuideKey answers on the audited world, or one of the two panels
    for (const g of GOAL_LADDER) {
      if (g.guideKey.startsWith('panel:')) continue;
      expect(resolveGuideKey(g.guideKey, world()), g.id).not.toBeNull();
    }
    expect(GOAL_LADDER.filter((g) => g.guideKey.startsWith('panel:')).map((g) => g.id)).toEqual([
      'hire',
      'guestbook',
    ]);
    // the fact sheet: no count is typed, and villagers are villagers
    for (const g of GOAL_LADDER) {
      expect(`${g.label} ${g.short}`).not.toMatch(/\d|agent|live AI/i);
    }
  });

  test('off until the first steps are over; on, it shows 600 ms later, folded, naming Projects', () => {
    const h = makeGuide();
    const chip = new NextChip(h.guide);
    expect(h.guide.over()).toBe(false);
    chip.sync(false, noFacts, null, []);
    expect(chip.showing()).toBe(false);
    expect(chip.view().phase).toBe('done');
    const on = chipOn();
    expect(on.chip.showing()).toBe(true);
    const v = on.chip.view();
    expect(v).toMatchObject({ phase: 'next', visible: true, chip: true, active: false });
    expect(on.chip.copy(false).chip).toBe('Next: Projects');
    expect(on.chip.next()?.guideKey).toBe('district:projects');
  });

  test('it never shares a version with First steps or the route', () => {
    const { chip, guide } = chipOn();
    expect(chip.version()).toBeGreaterThanOrEqual(2_000_000);
    expect(guide.version()).toBeLessThan(1_000_000);
    expect(new RecruiterRoute().version()).toBeLessThan(2_000_000);
  });

  test('the next goal is the first undone one; the compass district is preferred while undone', () => {
    const { chip } = chipOn({ 'stamp:projects': true });
    expect(chip.next()?.id).toBe('stamp:professional');
    chip.sync(true, { 'stamp:projects': true }, 'stamp:contact', []);
    expect(chip.next()?.id).toBe('stamp:contact');
    expect(chip.rows(3).map((g) => g.id)).toEqual([
      'stamp:contact',
      'stamp:professional',
      'stamp:personal',
    ]);
    // a preferred goal that is done, or unknown, is ignored
    chip.sync(true, { 'stamp:projects': true, 'stamp:contact': true }, 'stamp:contact', []);
    expect(chip.next()?.id).toBe('stamp:professional');
    chip.sync(true, {}, 'stamp:nowhere', []);
    expect(chip.next()?.id).toBe('stamp:professional');
  });

  test('it names a district until all four are stamped, then the hire card, then rung 2', () => {
    const facts: Record<string, boolean> = {};
    const { chip } = chipOn(facts);
    for (const z of ['projects', 'professional', 'personal', 'contact']) {
      expect(chip.next()?.id).toBe(`stamp:${z}`);
      facts[`stamp:${z}`] = true;
      chip.sync(true, facts, null, []);
    }
    expect(chip.next()?.id).toBe('hire');
    facts.hire = true;
    chip.sync(true, facts, null, []);
    expect(chip.next()?.id).toBe('talk');
    expect(chip.copy(false).chip).toBe('Next: Talk to a villager');
  });

  test('a goal seen done stays done, is kept in ds_guide_v1.goals, and a reload resumes the ladder', () => {
    const { chip, data, guide } = chipOn({ 'stamp:projects': true, race: true });
    expect(saveOf(data).goals).toEqual(['stamp:projects', 'race']);
    // the fact going false again (a cleared flag) does not undo it
    chip.sync(true, {}, null, []);
    expect(chip.isDone('race')).toBe(true);
    expect(guide.goals()).toEqual(['stamp:projects', 'race']);
    // a new page: the save alone
    const again = makeGuide({}, { [GUIDE_KEY]: data[GUIDE_KEY] });
    expect(again.guide.over()).toBe(true);
    const chip2 = new NextChip(again.guide);
    chip2.sync(true, {}, null, []);
    expect(chip2.isDone('stamp:projects')).toBe(true);
    expect(chip2.next()?.id).toBe('stamp:professional');
    expect(chip2.summary().done).toBe(2);
  });

  test('nothing is written before the first steps are over: a pre-guide visitor still reads as never written', () => {
    const h = makeGuide();
    const chip = new NextChip(h.guide);
    chip.sync(false, { 'stamp:projects': true }, null, []);
    expect(h.data[GUIDE_KEY]).toBeUndefined();
    h.guide.addGoals(['race']);
    expect(h.data[GUIDE_KEY]).toBeUndefined();
    // seen all the same, and kept the moment the chip comes on
    expect(chip.isDone('stamp:projects')).toBe(true);
  });

  test('a save from before the ladder (no goals) and a damaged goals field both parse to an empty list', () => {
    expect(parseGuideSave(JSON.stringify({ v: 1, done: [], skipped: true, t: 5 }))?.goals).toEqual(
      [],
    );
    const bad = parseGuideSave(
      JSON.stringify({ v: 1, done: [], skipped: true, t: 5, goals: ['race', 7, null, 'race'] }),
    );
    expect(bad?.goals.every((x) => typeof x === 'string')).toBe(true);
  });

  test('guide_goal is tracked for a goal done while the chip is on, not for what it found done', () => {
    const { chip, tracked } = chipOn({ 'stamp:projects': true });
    expect(tracked).toEqual([]);
    expect(chip.sync(true, { 'stamp:projects': true, talk: true }, null, [])).toBe(true);
    expect(tracked).toEqual([{ goal: 'talk', outcome: 'done' }]);
    // unchanged facts: nothing grew, nothing redrawn
    const ver = chip.version();
    expect(chip.sync(true, { 'stamp:projects': true, talk: true }, null, [])).toBe(false);
    expect(chip.version()).toBe(ver);
  });

  test('a tap unfolds rows and quests; a second tap, walking off or a pick folds it', () => {
    const { chip, tracked } = chipOn();
    chip.sync(true, {}, null, ['Fisher: Bring 3 fish 1/3']);
    chip.toggle();
    expect(chip.view().chip).toBe(false);
    const open = chip.copy(false);
    expect(open.rows?.map((r) => r.label)).toEqual([
      'Projects',
      'Professional',
      'Personal',
      'Contact',
      'The hire card',
    ]);
    expect(open.rows?.[0].button).toEqual({ id: 'goal:stamp:projects', label: 'Show me' });
    expect(open.lines).toEqual(['Fisher: Bring 3 fish 1/3']);
    chip.toggle();
    expect(chip.view().chip).toBe(true);
    chip.toggle();
    chip.fold();
    expect(chip.view().chip).toBe(true);
    const ver = chip.version();
    chip.fold(); // already folded: no redraw
    expect(chip.version()).toBe(ver);
    chip.toggle();
    expect(chip.pick('stamp:personal')?.guideKey).toBe('district:personal');
    expect(chip.view().chip).toBe(true);
    expect(tracked).toEqual([{ goal: 'stamp:personal', outcome: 'show' }]);
    expect(chip.pick('nope')).toBeNull();
  });

  test('side by side it offers three short rows and two quests; stacked, five and three', () => {
    const { chip } = chipOn();
    chip.sync(true, {}, null, ['a', 'b', 'c', 'd']);
    expect(chip.copy(true).rows).toHaveLength(NEXT_ROWS.across);
    expect(chip.copy(true).lines).toEqual(['a', 'b']);
    expect(chip.copy(false).rows).toHaveLength(NEXT_ROWS.stacked);
    expect(chip.copy(false).lines).toEqual(['a', 'b', 'c']);
    chip.sync(true, { 'stamp:projects': true, 'stamp:professional': true }, null, []);
    expect(chip.copy(true).rows?.map((r) => r.label)).toEqual(['Personal', 'Contact', 'Hire card']);
  });

  test('an accepted quest appears on the next sync, and redraws the chip', () => {
    const { chip } = chipOn();
    const ver = chip.version();
    chip.sync(true, {}, null, ['Baker: Deliver the bread 0/1']);
    expect(chip.version()).toBeGreaterThan(ver);
    chip.toggle();
    expect(chip.copy(false).lines).toEqual(['Baker: Deliver the bread 0/1']);
  });

  test('it hides under a panel, a tour or a room, and comes back folded 600 ms after', () => {
    const { chip } = chipOn();
    chip.toggle();
    chip.frame(1 / 60, true);
    expect(chip.view().visible).toBe(false);
    expect(chip.view().chip).toBe(true);
    for (let i = 0; i < 30; i++) chip.frame(1 / 60, false); // 500 ms
    expect(chip.view().visible).toBe(false);
    for (let i = 0; i < 8; i++) chip.frame(1 / 60, false);
    expect(chip.view().visible).toBe(true);
    // toggling while off does nothing
    chip.sync(false, {}, null, []);
    chip.toggle();
    expect(chip.showing()).toBe(false);
  });

  test('with every goal done and no quest it goes; with a quest left it says so', () => {
    const all: Record<string, boolean> = {};
    for (const g of GOAL_LADDER) all[g.id] = true;
    const { chip } = chipOn(all);
    expect(chip.showing()).toBe(false);
    expect(chip.summary()).toMatchObject({ done: 14, total: 14, next: null });
    chip.sync(true, all, null, ['Fisher: Bring 3 fish 1/3']);
    expect(chip.showing()).toBe(true);
    expect(chip.copy(false).chip).toBe('Your requests');
  });

  test("summary: what 'ds:goals' carries", () => {
    const { chip } = chipOn({ 'stamp:projects': true });
    const s = chip.summary();
    expect(s.done).toBe(1);
    expect(s.total).toBe(GOAL_LADDER.length);
    expect(s.next).toEqual({
      id: 'stamp:professional',
      label: 'Professional',
      guideKey: 'district:professional',
    });
    expect(s.goals[0]).toEqual({
      id: 'stamp:projects',
      rung: 1,
      label: 'Projects',
      guideKey: 'district:projects',
      done: true,
    });
  });
});

describe('GuideCard: the Next chip on the same card (P2-A12)', () => {
  const pressed: string[] = [];
  const seen: Array<{ active: boolean; step: string | null }> = [];
  const on = (e: Event) => seen.push((e as CustomEvent).detail);
  let card: GuideCard | null = null;
  const proto0 = Element.prototype as { animate?: unknown };
  let animate0: unknown;
  let animated = 0;
  const mount = (over: Partial<GuideCardOptions> = {}): GuideCard => {
    card = new GuideCard(document.getElementById('ui-overlay')!, {
      touch: false,
      reducedMotion: () => true,
      onButton: (id) => pressed.push(id),
      prompt: () => null,
      ...over,
    });
    return card;
  };
  beforeEach(() => {
    document.body.innerHTML = '<div id="ui-overlay"></div>';
    pressed.length = 0;
    seen.length = 0;
    animated = 0;
    window.addEventListener('ds:guide', on);
    animate0 = proto0.animate;
    proto0.animate = () => {
      animated++;
      return { cancel() {} };
    };
  });
  afterEach(() => {
    window.removeEventListener('ds:guide', on);
    card?.dispose();
    card = null;
    proto0.animate = animate0;
    Object.defineProperty(window, 'innerHeight', { value: 768, configurable: true });
  });
  const head = (): HTMLButtonElement =>
    document.querySelector<HTMLButtonElement>('#ds-guide button[data-g="next"]')!;

  test("folded: one 44 px button, as wide as its words, that holds no hints (data-active '0')", () => {
    const c = mount();
    const { chip } = chipOn();
    c.render(chip.view(), chip.copy(false));
    expect(c.el.style.display).toBe('block');
    expect(c.el.dataset.active).toBe('0');
    expect(c.el.dataset.next).toBe('folded');
    expect(c.el.style.width).toBe('max-content');
    expect(c.el.style.maxWidth).toBe('300px');
    expect(c.el.querySelectorAll('button')).toHaveLength(1);
    expect(head().textContent).toContain('Next: Projects');
    expect(head().getAttribute('aria-expanded')).toBe('false');
    expect(head().style.minHeight).toContain('44px');
    // the standing chip is not "the guide is active" to D6
    expect(seen.every((d) => d.active === false)).toBe(true);
  });

  test('open: Show me rows read with their goal, quests under them, and the button says expanded', () => {
    const c = mount();
    const { chip } = chipOn();
    chip.sync(true, {}, null, ['Fisher: Bring 3 fish 1/3']);
    chip.toggle();
    c.render(chip.view(), chip.copy(false));
    expect(c.el.dataset.next).toBe('open');
    expect(c.el.style.width).toBe('300px');
    expect(head().getAttribute('aria-expanded')).toBe('true');
    const rows = [...c.el.querySelectorAll<HTMLButtonElement>('button[data-g^="goal:"]')];
    expect(rows.map((b) => b.dataset.g)).toEqual([
      'goal:stamp:projects',
      'goal:stamp:professional',
      'goal:stamp:personal',
      'goal:stamp:contact',
      'goal:hire',
    ]);
    expect(rows[0].textContent).toContain('Projects');
    expect(rows[0].textContent).toContain('Show me');
    // one filled primary, as on the route
    expect(rows.filter((b) => b.dataset.primary === '1')).toHaveLength(1);
    expect([...c.el.querySelectorAll('[data-quest]')].map((n) => n.textContent)).toEqual([
      'Fisher: Bring 3 fish 1/3',
    ]);
    rows[2].click();
    head().click();
    expect(pressed).toEqual(['goal:stamp:personal', 'next']);
  });

  test('on a portrait phone it stands bottom left and unfolds upward', () => {
    Object.defineProperty(window, 'innerHeight', { value: 844, configurable: true });
    const c = mount({ touch: true });
    const { chip } = chipOn();
    chip.toggle();
    c.render(chip.view(), chip.copy(true));
    expect(c.el.dataset.lane).toBe('phone');
    // (happy-dom drops a calc(var()) value: the browser check measures the
    // 16 px; here, only that it is not the centred card's lane)
    expect(c.el.style.left).not.toContain('50%');
    expect((c.el.firstElementChild as HTMLElement).style.flexDirection).toBe('column-reverse');
    expect(c.el.querySelectorAll('button[data-g^="goal:"]')).toHaveLength(NEXT_ROWS.across);
  });

  test('reduced motion: folding and unfolding animate nothing', () => {
    const c = mount({ reducedMotion: () => true });
    const { chip } = chipOn();
    c.render(chip.view(), chip.copy(false));
    chip.toggle();
    c.render(chip.view(), chip.copy(false));
    chip.toggle();
    c.render(chip.view(), chip.copy(false));
    expect(animated).toBe(0);
    expect(c.el.style.transition === '' || c.el.style.transition === 'none').toBe(true);
  });

  test('hidden under a panel: the element is not displayed', () => {
    const c = mount();
    const { chip } = chipOn();
    c.render(chip.view(), chip.copy(false));
    chip.frame(1 / 60, true);
    c.render(chip.view(), chip.copy(false));
    expect(c.el.style.display).toBe('none');
  });
});

describe('main-simple: the Next chip takes the card when the first steps end (P2-A12)', () => {
  type Method = (this: unknown, ...a: unknown[]) => unknown;
  const NAMES = [
    'renderGuide',
    'armGuide',
    'onGuideButton',
    'onModalEvent',
    'armRoute',
    'createGuideCard',
    'guideFinaleDistrict',
    'guideHoldsHints',
    'guideTo',
    'storedFlag',
    'goalFacts',
    'syncGoals',
    'publishGoals',
  ] as const;
  let proto: Record<(typeof NAMES)[number], Method>;
  beforeAll(async () => {
    (window as unknown as { __lifeIslandBooted?: boolean }).__lifeIslandBooted = true;
    const mod = await import('../main-simple');
    // GuideCard.ts comes in with import() (wave 4, bundle): in, as after
    // the welcome card's idle prefetch, so arming draws the card at once.
    await mod.loadGuideCard();
    proto = mod.SimpleApp.prototype as unknown as typeof proto;
  }, 120000);

  const stamps = new Set<string>();
  const opened: string[] = [];
  let quests: Array<{ id: string; giver: string; label: string; progress: string }> = [];
  const stubApp = (guide: Guide) => {
    const app: Record<string, unknown> = {
      guide,
      guideCard: null,
      guideSurface: null,
      route: new RecruiterRoute(),
      nextChip: new NextChip(guide),
      walkedSinceLoad: 0,
      hireCardSource: null,
      hireSeen: false,
      fishEver: false,
      fishCaught: 0,
      shopOpened: false,
      ownedRod: false,
      ownedAxe: false,
      ownedSickle: false,
      ownedPickaxe: false,
      lessons: [],
      ownBuilds: new Map(),
      ownedHats: new Set<string>(),
      villagersTalked: new Set<string>(),
      deliverySystem: null,
      coinsEarned: 0,
      coinsSeen: -1,
      visitStartedAt: 0,
      goalsWereOn: false,
      goalsPublishT: 0,
      goalTarget: null,
      _goalFacts: {},
      _goalPos: {
        x: 0,
        y: 0,
        z: 0,
        set(x: number, y: number, z: number) {
          this.x = x;
          this.y = y;
          this.z = z;
          return this;
        },
      },
      guideWorld: world(),
      secrets: { count: () => 2 },
      npcQuests: { getActiveQuests: () => quests },
      scene: { getCoinsCollected: () => 40 },
      ui: {
        getOverlay: () => document.getElementById('ui-overlay')!,
        isTouchDevice: () => false,
        isWelcomeVisible: () => false,
        showHireCard: (src: string) => opened.push(`hire:${src}`),
        showGuestbook: () => {
          opened.push('guestbook');
          return Promise.resolve();
        },
      },
      introSettled: true,
      compassLabel: '',
      passport: {
        has: (z: string) => stamps.has(z),
        count: () => stamps.size,
        isComplete: () => stamps.size >= 4,
        isStampZone: () => true,
      },
      compassDistrict: null,
      guidePrevValid: true,
    };
    for (const k of NAMES) app[k] = proto[k].bind(app);
    return app as typeof app & Record<(typeof NAMES)[number], (...a: unknown[]) => unknown>;
  };
  /** What guideTick does for the chip, without the scene. */
  const tick = (app: ReturnType<typeof stubApp>, seconds: number): void => {
    const chip = app.nextChip as NextChip;
    const g = app.guide as Guide;
    for (let t = 0; t < seconds - 1e-9; t += 1 / 60) {
      g.frame(idle());
      const on = g.over() && !(app.route as RecruiterRoute).showing();
      if (on !== app.goalsWereOn) app.syncGoals(on);
      chip.frame(1 / 60, false);
      app.renderGuide();
    }
  };
  const sent: Array<{ key: string; source: string }> = [];
  const goals: Array<Record<string, unknown>> = [];
  const guideEvents: Array<{ active: boolean; step: string | null }> = [];
  const onTo = (e: Event) => sent.push((e as CustomEvent).detail);
  const onGoals = (e: Event) => goals.push((e as CustomEvent).detail);
  const onGuide = (e: Event) => guideEvents.push((e as CustomEvent).detail);
  let app: ReturnType<typeof stubApp> | null = null;
  const proto0 = Element.prototype as { animate?: unknown };
  let animate0: unknown;
  beforeEach(() => {
    document.body.innerHTML = '<div id="ui-overlay"></div>';
    localStorage.clear();
    stamps.clear();
    opened.length = 0;
    quests = [];
    sent.length = 0;
    goals.length = 0;
    guideEvents.length = 0;
    window.addEventListener('ds:guide-to', onTo);
    window.addEventListener('ds:goals', onGoals);
    window.addEventListener('ds:guide', onGuide);
    animate0 = proto0.animate;
    proto0.animate = () => ({ cancel() {} });
  });
  afterEach(() => {
    window.removeEventListener('ds:guide-to', onTo);
    window.removeEventListener('ds:goals', onGoals);
    window.removeEventListener('ds:guide', onGuide);
    (app?.guideCard as GuideCard | null)?.dispose();
    app = null;
    proto0.animate = animate0;
  });
  const el = (): HTMLElement | null => document.getElementById('ds-guide');
  const visible = (): boolean => el()?.style.display === 'block';

  test('Skip: the card folds into the chip within a second, on the same #ds-guide', () => {
    const { guide } = makeGuide();
    app = stubApp(guide);
    app.armGuide('explore');
    tick(app, 0.7);
    expect(el()?.textContent).toContain('First steps · 1/5');
    app.onGuideButton('skip');
    tick(app, 1);
    expect(document.querySelectorAll('#ds-guide')).toHaveLength(1);
    expect(visible()).toBe(true);
    expect(el()?.dataset.next).toBe('folded');
    expect(el()?.textContent).toContain('Next: Projects');
    expect(el()?.dataset.active).toBe('0');
    expect(app.guideHoldsHints()).toBe(false);
    // the steps' end was announced before the chip drew: hints are released
    expect(guideEvents.at(-1)?.active).toBe(false);
  });

  test('a returning visitor whose first steps are over gets the chip with no card before it', () => {
    const first = overGuide();
    const { guide } = makeGuide({}, { [GUIDE_KEY]: first.data[GUIDE_KEY] });
    app = stubApp(guide);
    expect(el()).toBeNull();
    tick(app, 0.7);
    expect(visible()).toBe(true);
    expect(el()?.textContent).toContain('Next: Projects');
  });

  test('the chip names the district the compass would: stamps, then the hire card', () => {
    app = stubApp(overGuide().guide);
    tick(app, 0.7);
    stamps.add('projects');
    app.syncGoals(true);
    app.renderGuide();
    expect(el()?.textContent).toContain('Next: Professional');
    expect((app.goalTarget as { label: string }).label).toContain('Professional');
    for (const z of ['professional', 'personal', 'contact']) stamps.add(z);
    app.syncGoals(true);
    app.renderGuide();
    expect(el()?.textContent).toContain('Next: The hire card');
    // a panel is not a place: the compass is left alone
    expect(app.goalTarget).toBeNull();
    app.onModalEvent({ open: true, id: 'zone', zone: 'hire' });
    app.syncGoals(true);
    app.renderGuide();
    expect(el()?.textContent).toContain('Next: Talk to a villager');
  });

  test("a tap unfolds it; a row's Show me goes through 'ds:guide-to' with source next and folds it", () => {
    app = stubApp(overGuide().guide);
    tick(app, 0.7);
    app.onGuideButton('next');
    expect(el()?.dataset.next).toBe('open');
    expect(el()?.querySelectorAll('button[data-g^="goal:"]')).toHaveLength(NEXT_ROWS.stacked);
    app.onGuideButton('goal:stamp:personal');
    expect(sent).toEqual([{ key: 'district:personal', source: 'next' }]);
    expect(el()?.dataset.next).toBe('folded');
    // First steps is not re-armed by it
    expect((app.guide as Guide).running()).toBe(false);
  });

  test('an accepted quest is listed in the unfolded chip on the next sync', () => {
    app = stubApp(overGuide().guide);
    tick(app, 0.7);
    quests = [{ id: 'q1', giver: 'Fisher', label: 'Bring 3 fish', progress: '1/3' }];
    app.syncGoals(true);
    app.onGuideButton('next');
    expect([...el()!.querySelectorAll('[data-quest]')].map((n) => n.textContent)).toEqual([
      'Fisher: Bring 3 fish 1/3',
    ]);
  });

  test("the two panel goals open their panel through guideTo: 'panel:hire', 'panel:guestbook'", () => {
    app = stubApp(overGuide().guide);
    app.guideTo('panel:hire', null, 'next');
    app.guideTo('panel:guestbook', null, 'things');
    expect(opened).toEqual(['hire:menu', 'guestbook']);
  });

  test("'ds:goals' carries the ladder and the visit's numbers, when the chip comes on and when a goal is done", () => {
    app = stubApp(overGuide().guide);
    (app.villagersTalked as Set<string>).add('Mayor');
    stamps.add('projects');
    tick(app, 0.7);
    expect(goals).toHaveLength(1);
    expect(goals[0]).toMatchObject({
      done: 2,
      total: GOAL_LADDER.length,
      next: { id: 'stamp:professional', guideKey: 'district:professional' },
      visit: { stamps: 1, villagers: 1, coins: 0, secrets: 2, minutes: 0 },
    });
    app.syncGoals(true); // nothing new: nothing sent
    expect(goals).toHaveLength(1);
    localStorage.setItem('ds_raced', '1');
    app.syncGoals(true);
    expect(goals).toHaveLength(2);
    expect(goals[1].done).toBe(3);
  });

  test('coins earned this visit are counted from the first reading on', () => {
    app = stubApp(overGuide().guide);
    let coins = 40;
    (app.scene as { getCoinsCollected: () => number }).getCoinsCollected = () => coins;
    app.syncGoals(true);
    coins = 47;
    app.syncGoals(true);
    coins = 30; // spent: not negative earnings
    app.syncGoals(true);
    app.publishGoals();
    expect((goals.at(-1)!.visit as { coins: number }).coins).toBe(7);
  });

  test('what counts as done: the flags and the session facts', () => {
    app = stubApp(overGuide().guide);
    expect(Object.values(app.goalFacts() as Record<string, boolean>).some(Boolean)).toBe(false);
    localStorage.setItem('ds_npc_chatted', '1');
    localStorage.setItem('ds_said_hi', '1');
    localStorage.setItem('ds_courier_reward', '1');
    app.fishCaught = 1;
    app.shopOpened = true;
    (app.lessons as unknown[]).push({});
    (app.ownBuilds as Map<string, unknown>).set('a', {});
    (app.ownedHats as Set<string>).add('crown');
    expect(app.goalFacts()).toMatchObject({
      talk: true,
      guestbook: true,
      deliveries: true,
      catch: true,
      shop: true,
      lesson: true,
      build: true,
      crown: true,
      race: false,
      hire: false,
    });
  });

  test('the route has the card while it shows; the chip returns after Stay', () => {
    app = stubApp(overGuide().guide);
    tick(app, 0.7);
    expect(el()?.textContent).toContain('Next: Projects');
    app.onModalEvent({ open: false, id: 'zone', zone: 'hire' });
    const route = app.route as RecruiterRoute;
    for (let i = 0; i < 45; i++) {
      route.frame(1 / 60, false);
      tick(app, 1 / 60);
    }
    expect(el()?.textContent).toContain('Recruiter route · 3 stops');
    app.onGuideButton('stay');
    tick(app, 0.8);
    expect(el()?.textContent).toContain('Next: Projects');
    expect(visible()).toBe(true);
  });
});
