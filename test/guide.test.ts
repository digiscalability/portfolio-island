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
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  CONTROLS_KEY,
  GUIDE_KEY,
  GUIDE_KEYS,
  GUIDE_STEPS,
  Guide,
  guideCopy,
  parseGuideSave,
  readGuideTo,
  resolveGuideKey,
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

  test('the legacy controls card says Space until A11 makes Shift run; no "?" key yet', () => {
    const c = guideCopy(view({ phase: 'controls', step: null }), ctx());
    expect(c.body).toBe('Drag to look · Space to run');
    expect(guideCopy(view({ phase: 'controls', step: null }), ctx({ runKey: 'shift' })).body).toBe(
      'Drag to look · Shift to run',
    );
    // '? for all controls' waits for D8's controls sheet (wave 2).
    expect(c.body).not.toContain('?');
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
