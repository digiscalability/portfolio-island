// @vitest-environment happy-dom
//
// P2-D4: villager chat answers "what does he build?" and "where is it?",
// even offline, and offers the next action. routeQuestion (NpcChat.ts) is a
// pure keyword router onto the portfolio panels, the hire card and the
// compass's 'ds:guide-to' keys; showNpcChat shows the routed line when the
// model could not answer, and one 44 px button under the reply whenever a
// route matches. Before this a visitor who asked the Mayor what Abbas builds
// with the backend down got the Mayor's next written line about the town
// hall, and no way on.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { AI_NPCS, routeQuestion } from '../NpcChat';
import { SimpleUI } from '../SimpleUI';

const src = (f: string): string =>
  readFileSync(join(process.cwd(), f), 'utf8').replace(/\r\n/g, '\n');
const text = (el: Element | null | undefined): string =>
  (el?.textContent ?? '').replace(/\s+/g, ' ').trim();

describe('routeQuestion: the route table', () => {
  const to = (q: string): string | null => {
    const r = routeQuestion(q);
    if (!r) return null;
    const a = r.action;
    return `${r.kind}:${a?.hire ? 'hire' : (a?.zone ?? a?.guideKey ?? '-')}`;
  };

  test.each([
    ['What does Abbas build?', 'projects:projects'],
    ['what has he built', 'projects:projects'],
    ['Tell me about his work', 'projects:projects'],
    ['show me the portfolio', 'projects:projects'],
    ['What is RankPilot?', 'projects:projects'],
    ['has he shipped anything', 'projects:projects'],
    ['What projects are here?', 'projects:projects'],
  ])('work, project, built, ship, portfolio or a venture name: %s', (q, want) => {
    expect(to(q)).toBe(want);
  });

  test.each([
    ['Is he available for hire?', 'hire:hire'],
    ['Can I see his CV?', 'hire:hire'],
    ['where is his résumé', 'hire:hire'],
    ['We have a role open', 'hire:hire'],
    ['is he looking for a job', 'hire:hire'],
  ])('hire, CV, resume, role, job or available: %s', (q, want) => {
    expect(to(q)).toBe(want);
  });

  test.each([
    ['How do I contact him?', 'contact:hire'],
    ["What's his email?", 'contact:hire'],
    ['how can I reach Abbas', 'contact:hire'],
  ])('contact, email or reach open the card that holds them: %s', (q, want) => {
    expect(to(q)).toBe(want);
  });

  test.each([
    ['Who is Abbas?', 'professional:professional'],
    ['who built this island', 'professional:professional'],
    ['tell me about him', 'professional:professional'],
    ['What is his experience?', 'professional:professional'],
    ['what is his background', 'professional:professional'],
  ])('who, about, experience or background: %s', (q, want) => {
    expect(to(q)).toBe(want);
  });

  test.each([
    ['What does he do outside of work?', 'personal:personal'],
    ['any hobbies?', 'personal:personal'],
  ])('the personal side: %s', (q, want) => {
    expect(to(q)).toBe(want);
  });

  test.each([
    ['Where is the shop?', 'place:kiosk'],
    ['How do I get to the School?', 'place:school'],
    ['where is the bank', 'place:bank'],
    ["where's the harbour?", 'place:shore'],
    ['Where can I find a race?', 'place:race:land'],
    ['Where is Projects?', 'place:district:projects'],
    ['how do i get to contact', 'place:district:contact'],
    ['Where is the beach house?', 'place:beach-house'],
    ['take me to the town square', 'place:district:welcome'],
  ])("'where is' and 'how do I get to' route to a place the compass knows: %s", (q, want) => {
    expect(to(q)).toBe(want);
  });

  test.each([
    'Nice weather?',
    'Hello there',
    'Who are you?',
    'What are you doing today?',
    'How do I build a house?',
    'do you like the sea',
    '',
    '   ',
    // Integration (wave 2): these got a hiring pitch where main answered in
    // character. 'Building', 'ship', 'role' and 'position' only route when
    // the question is about Abbas, and a 'where' naming no place is the
    // villager's to answer.
    "What's that building?",
    'What role do you play here?',
    "What's your position on the weather?",
    'Where is the lighthouse?',
    'where are you going',
  ])('small talk and island chores keep the villager’s own line: %s', (q) => {
    expect(routeQuestion(q)).toBeNull();
  });

  test.each([
    ['What is he building?', 'projects:projects'],
    ['has he shipped anything', 'projects:projects'],
    ['Is there a role for Abbas?', 'hire:hire'],
    ['What position is he after?', 'hire:hire'],
    ['We have a position open', 'hire:hire'],
  ])('ship, building, role and position still route when about Abbas: %s', (q, want) => {
    expect(to(q)).toBe(want);
  });

  test.each(["Where's the cruise ship?", 'where is the liner', 'Where does that ship go?'])(
    'the cruise liner is a place with no compass key (it moves), so no button: %s',
    (q) => {
      expect(to(q)).toBe('place:-');
      const r = routeQuestion(q)!;
      expect(r.action).toBeUndefined();
      expect(r.line).toContain('cruise liner');
      expect(r.line).not.toMatch(/Abbas|Projects/);
    },
  );

  test.each([
    'How do I get into the beach house?',
    'What is the door code?',
    "what's the code for the door",
    'how do I open the beach house',
    'is there a pin for the lock?',
  ])('the beach house and its door code route to the beach house: %s', (q) => {
    expect(to(q)).toBe('place:beach-house');
    expect(routeQuestion(q)?.line).toContain('ask the Sailor');
    expect(routeQuestion(q)?.line).not.toContain('5673');
    expect(routeQuestion(q, 'Mayor')?.line).toContain('ask the Sailor');
  });

  test('the Sailor answers the door-code question with the code itself', () => {
    for (const q of ['How do I get into the beach house?', 'What is the door code?']) {
      const r = routeQuestion(q, 'Sailor')!;
      expect(r.line, q).toContain('5673');
      expect(r.line, q).toContain('islet out south');
      expect(r.action?.guideKey, q).toBe('beach-house');
      expect(r.line.length, q).toBeLessThanOrEqual(180);
    }
  });

  test('every place key is one the compass seam answers (P2-A5: Guide.ts GUIDE_KEYS)', () => {
    // The seam's keys, as package A publishes them; an unknown key would open
    // the island map instead of setting the compass.
    const known = new Set([
      'district:welcome',
      'district:professional',
      'district:projects',
      'district:personal',
      'district:contact',
      'school',
      'kiosk',
      'bank',
      'shore',
      'race:land',
      'race:water',
      'beach-house',
    ]);
    const places = [
      'beach house',
      'school',
      'shop',
      'bank',
      'harbour',
      'race',
      'projects',
      'contact',
      'professional',
      'personal',
      'hub',
    ];
    const keys = places.map((p) => routeQuestion(`where is the ${p}`)?.action?.guideKey);
    expect(new Set(keys).size).toBe(places.length); // each place has its own key
    for (const k of keys) expect(known.has(k ?? ''), String(k)).toBe(true);
  });

  test('a place route offers Show me; a panel route names its panel; every line is a sentence', () => {
    expect(routeQuestion('Where is the shop?')?.action?.label).toBe('Show me');
    expect(routeQuestion('What does Abbas build?')?.action?.label).toBe('Open Projects');
    expect(routeQuestion('Can I see his CV?')?.action?.label).toBe('Hiring? CV & contact');
    expect(routeQuestion('What does Abbas build?')?.line).toContain('Projects');
    for (const q of [
      'Where is the bank?',
      'who is abbas',
      'hire',
      'email',
      'hobbies',
      'projects',
    ]) {
      const r = routeQuestion(q)!;
      expect(r.line.length, q).toBeGreaterThan(20);
      expect(r.line.length, q).toBeLessThanOrEqual(180);
    }
  });
});

describe('the route copy follows the Fact Sheet', () => {
  const routes = src('NpcChat.ts').slice(src('NpcChat.ts').indexOf('Question routes (P2-D4)'));
  const copy = routes.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

  test("never 'agent' or 'live AI', and no typed counts", () => {
    expect(copy).not.toMatch(/agent|live ai/i);
    expect(copy).not.toMatch(/\b\d+ (villagers|townsfolk|projects|ventures|districts)/i);
  });

  test('the availability line stays on the hire card alone', () => {
    expect(copy).not.toMatch(/open to (ai|roles|work)|available (now|for)|full-time|contract/i);
  });

  test('no quoted id sits after the roster but the roster’s own (serverModeration, livingNpcs)', () => {
    // Both suites read NpcChat.ts from AI_NPC_DEFS to its end for id: '…'
    // literals and compare them with the server's persona order.
    const chat = src('NpcChat.ts');
    const ids = [...chat.slice(chat.indexOf('AI_NPC_DEFS')).matchAll(/id: '([a-z_]+)'/g)].map(
      (m) => m[1],
    );
    expect(ids).toEqual(Object.values(AI_NPCS));
  });
});

describe('showNpcChat: the routed line offline, and one button under the reply', () => {
  let ui: SimpleUI;
  const log = (): HTMLElement => document.querySelector<HTMLElement>('[role="log"]')!;
  const button = (): HTMLButtonElement | null =>
    document.querySelector<HTMLButtonElement>('button[data-npc-route]');
  const routesLogged = (): unknown[] =>
    (window.__analyticsLog ?? []).filter((e) => e.name === 'npc_route').map((e) => e.props);
  const WRITTEN = 'The town hall is always open.';

  /** Open a chat whose model call falls back (offline) or answers (live). */
  const open = (offline: boolean): void => {
    ui.showNpcChat('Mayor', 'Good afternoon.', async () => {
      if (offline) {
        ui.markNpcChatOffline('Mayor'); // what main-simple does on a fallback
        return WRITTEN;
      }
      return 'A reply from the model.';
    });
  };
  const ask = async (q: string): Promise<void> => {
    const input = document.querySelector<HTMLInputElement>(
      'input[placeholder^="Say something to"]',
    )!;
    input.value = q;
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await vi.advanceTimersByTimeAsync(6000); // the reply types out
  };

  beforeEach(() => {
    document.body.innerHTML = '<div id="ui-overlay"></div>';
    localStorage.clear();
    sessionStorage.clear();
    window.__analyticsLog = [];
    vi.useFakeTimers();
    ui = new SimpleUI('ui-overlay');
  });

  afterEach(() => {
    ui.closeNpcChat();
    ui.hideZonePanel();
    ui.panels.closeAll();
    ui.dispose();
    vi.useRealTimers();
  });

  test("offline, 'What does Abbas build?': a line naming Projects, and a button that opens it", async () => {
    open(true);
    await ask('What does Abbas build?');
    expect(text(log())).toContain('the rest of his work is in Projects');
    expect(text(log())).not.toContain(WRITTEN);
    const b = button()!;
    expect(text(b)).toBe('Open Projects');
    expect(b.style.minHeight).toBe('44px');
    expect(b.style.border).toContain('143, 155, 255'); // the indigo outline, never green
    expect(text(document.querySelector('[data-npc-model]'))).toBe('offline replies');
    b.click();
    await vi.advanceTimersByTimeAsync(50);
    expect(ui.panels.current()).toBe('zone');
    expect(text(document.querySelector('#ds-zone-title'))).toContain('Projects');
    expect(ui.isNpcChatOpen()).toBe(false);
    expect(routesLogged()).toEqual([{ to: 'projects' }]);
  });

  test("offline, 'How do I contact him?': the button opens the hire card", async () => {
    open(true);
    await ask('How do I contact him?');
    const b = button()!;
    expect(text(b)).toBe('Hiring? CV & contact');
    b.click();
    await vi.advanceTimersByTimeAsync(50);
    expect(ui.panels.current()).toBe('zone');
    expect(text(document.querySelector('#ds-zone-title'))).toBe('Abbas Ali');
    expect(routesLogged()).toEqual([{ to: 'hire' }]);
    const explored = (window.__analyticsLog ?? []).find(
      (e) => e.name === 'zone_explored' && e.props?.zone === 'hire',
    );
    expect(explored?.props?.source).toBe('npc');
  });

  test("offline, 'Where is the shop?': Show me dispatches 'ds:guide-to' {key, source:'npc'} and closes the chat", async () => {
    const seen: unknown[] = [];
    const on = (e: Event): void => void seen.push((e as CustomEvent).detail);
    window.addEventListener('ds:guide-to', on);
    try {
      open(true);
      await ask('Where is the shop?');
      expect(text(log())).toContain('The shop kiosk sells');
      const b = button()!;
      expect(text(b)).toBe('Show me');
      b.click();
      expect(seen).toEqual([{ key: 'kiosk', source: 'npc' }]);
      expect(ui.isNpcChatOpen()).toBe(false);
      expect(routesLogged()).toEqual([{ to: 'kiosk' }]);
    } finally {
      window.removeEventListener('ds:guide-to', on);
    }
  });

  test("offline, the Sailor asked 'How do I get into the beach house?' gives the code; the Mayor points to him", async () => {
    ui.showNpcChat('Sailor', 'Ahoy!', async () => {
      ui.markNpcChatOffline('Sailor');
      return 'The waves here follow real maths, you know.';
    });
    await ask('How do I get into the beach house?');
    expect(text(log())).toContain('5673');
    expect(text(log())).not.toContain('real maths');
    expect(text(button())).toBe('Show me');
    ui.closeNpcChat();
    open(true);
    await ask('What is the door code?');
    expect(text(log())).toContain('ask the Sailor');
    expect(text(log())).not.toContain('5673');
  });

  test("offline, 'Where's the cruise ship?': the liner line, and no button", async () => {
    open(true);
    await ask("Where's the cruise ship?");
    expect(text(log())).toContain('cruise liner');
    expect(button()).toBeNull();
  });

  test("offline, 'Nice weather?': the written line stands, and no button", async () => {
    open(true);
    await ask('Nice weather?');
    expect(text(log())).toContain(WRITTEN);
    expect(button()).toBeNull();
    expect(text(document.querySelector('[data-npc-model]'))).toBe('offline replies');
  });

  test('live: the model’s reply stands, and the button still follows it', async () => {
    open(false);
    await ask('What does Abbas build?');
    expect(text(log())).toContain('A reply from the model.');
    expect(text(log())).not.toContain('the rest of his work is in Projects');
    expect(text(button())).toBe('Open Projects');
    expect(text(document.querySelector('[data-npc-model]'))).toBe('Claude Haiku 4.5');
  });

  test('a fallback on one send does not rewrite the next live reply', async () => {
    let offline = true;
    ui.showNpcChat('Mayor', 'Good afternoon.', async () => {
      if (offline) {
        ui.markNpcChatOffline('Mayor');
        return WRITTEN;
      }
      return 'A reply from the model.';
    });
    await ask('What does Abbas build?');
    offline = false;
    await ask('Who is Abbas?');
    expect(text(log())).toContain('A reply from the model.');
    expect(document.querySelectorAll('button[data-npc-route]')).toHaveLength(2);
  });
});
