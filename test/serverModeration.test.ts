// Server-side gates on public text (functions/src): the moderation npcChat
// runs on every visitor message and every model reply, the counts filter,
// stale-issue sweep and closed-proposal de-duplication behind the analyst's
// public GitHub issues, and the concierge fact sheet the NPCs repeat. No listed
// term is written in this file or printed by it: cases iterate the exported
// list and are named by index.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import { RUMORS } from '../functions/src/constants';
import { containsSlur, redactCounts, scrubReply, SLURS } from '../functions/src/moderation';
import { ABOUT_ABBAS, buildPersonas, ISLAND_CONTEXT, NPC_ROLES } from '../functions/src/personas';
import { closedProposalTitles, proposalKey, staleAnalystIssues } from '../functions/src/pure';

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

/** Single-quoted strings of the `NAME ... = [ ... ];` array literal, in order
 *  (the same helper shape as test/livingNpcs.test.ts). */
function arrayStringsAfter(src: string, name: string): string[] {
  const m = src.match(new RegExp(`${name}[^\\n]*=\\s*\\[([\\s\\S]*?)\\](?:\\s*as const)?;`));
  if (!m) throw new Error(`array literal not found: ${name}`);
  return [...m[1].matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((s) => s[1]);
}

/** Blocked on the way in AND rejected on the way out. */
const blocked = (s: string) => containsSlur(s) && scrubReply(s) === '';
/** Passes the input gate AND is published unchanged by the output gate. */
const passes = (s: string) =>
  !containsSlur(s) && scrubReply(s) === s.replace(/\s+/g, ' ').trim().slice(0, 400);

describe('term list', () => {
  test('the server list equals the client list (Moderation.ts), in order', () => {
    const client = arrayStringsAfter(read('Moderation.ts'), 'SLURS');
    expect(client.length).toBeGreaterThan(10);
    // Compared as counts and one boolean so a drift never prints the terms.
    expect(SLURS.length, 'server and client list lengths differ').toBe(client.length);
    const same = client.every((term, i) => term === SLURS[i]);
    expect(same, 'functions/src/moderation.ts SLURS must equal the client list, in order').toBe(
      true,
    );
  });
});

describe('severe terms are still blocked', () => {
  const swap: Record<string, string> = { a: '4', e: '3', i: '1', o: '0', s: '5' };
  const zeroWidthSpace = String.fromCharCode(0x200b);
  const combiningAcute = String.fromCharCode(0x301);
  // A spacing acute accent: NFKD writes it as a space plus a combining mark.
  const spacingAcute = String.fromCharCode(0xb4);
  const forms: Array<[string, (t: string) => string]> = [
    ['as a word in a sentence', (t) => `you are a ${t}`],
    ['in capitals', (t) => t.toUpperCase()],
    ['as a plural', (t) => `${t}s`],
    ['as a possessive', (t) => `the ${t}'s bag`],
    ['inside punctuation', (t) => `(${t})!`],
    ['hyphenated', (t) => `a ${t}-style joke`],
    ['in leetspeak', (t) => t.replace(/[aeios]/, (c) => swap[c])],
    ['with a letter stretched', (t) => t.slice(0, 2) + t[1] + t.slice(2)],
    ['spaced out letter by letter', (t) => t.split('').join(' ')],
    ['dotted letter by letter', (t) => t.split('').join('.')],
    ['spaced out after a one-letter word', (t) => `you are a ${t.split('').join(' ')}`],
    // One separator typed inside the word: each piece alone is too short or
    // too ordinary to match, so the word is re-joined within its own chunk.
    ['with a dot inside', (t) => t.slice(0, 2) + '.' + t.slice(2)],
    ['with a hyphen inside', (t) => t.slice(0, 2) + '-' + t.slice(2)],
    ['with an underscore inside', (t) => t.slice(0, 2) + '_' + t.slice(2)],
    ['with an apostrophe inside', (t) => t.slice(0, 2) + "'" + t.slice(2)],
    ['with an asterisk inside', (t) => t.slice(0, 2) + '*' + t.slice(2)],
    ['with the first letter split off', (t) => t[0] + '.' + t.slice(1)],
    [
      'with a separator inside, in a sentence',
      (t) => `he called me a ${t.slice(0, 2)}-${t.slice(2)} today`,
    ],
    ['as an @-mention', (t) => `hey @${t} come here`],
    ['with an accent', (t) => t.replace(/[aeiou]/, (c) => c + combiningAcute)],
    ['with a spacing accent inside', (t) => t.slice(0, 2) + spacingAcute + t.slice(2)],
    // The mark is dropped, the real space before it is not: no two words join.
    ['after a space and a combining mark', (t) => `you are a ${combiningAcute}${t}`],
    ['with a zero-width space inside', (t) => t.slice(0, 2) + zeroWidthSpace + t.slice(2)],
    [
      'in full-width letters',
      (t) => [...t].map((c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0)).join(''),
    ],
  ];

  test.each(SLURS.map((_, i) => i))('term #%i is blocked in every common form', (i) => {
    const term = SLURS[i];
    // Reports only the NAMES of forms that slipped through, never the term.
    const missed = forms.filter(([, make]) => !blocked(make(term))).map(([name]) => name);
    expect(missed).toEqual([]);
  });
});

describe('ordinary words and good replies pass', () => {
  // The audit's probe lines (origin's strip-spaces matcher blocked most of
  // them), plus the classic traps for each short term: a word that contains
  // it, a word its letters collapse to, and a number that reads as leetspeak.
  const visitorLines = [
    "I'm from Pakistan, where did Abbas study?",
    'Is Abbas Pakistani?',
    'He studied in Islamabad, Pakistan, right?',
    'I am from Pakistan!!',
    'Any spicy food at the bakery?',
    'Do you sell spices?',
    'That bug was despicable.',
    'Are you suspicious of strangers?',
    'I saw a raccoon by the shore.',
    'The mayor is a real tycoon.',
    'Is there a cocoon in the garden?',
    'A glass of Coonawarra red, please.',
    'Pros and cons of living here?',
    'Is this a con?',
    'Is Niger near Nigeria?',
    'Do the gulls snigger at you?',
    'Flame retardant paint on the lighthouse?',
    'My therapist says long walks help.',
    'Is that a torpedo or a fish?',
    'Tell me about Scunthorpe.',
    'Do you like Kikis Delivery Service?',
    'Is the cap 900k tokens a month?',
    'What is the best route to the Contact district?',
    'This picnic spot is lovely.',
    'Show me a picture of the town.',
    'He picks the best timber.',
    'Is there a coffee beanery on the island?',
    // Punctuation inside a chunk is re-joined (the separator rule), so these
    // check that re-joined ordinary words stay ordinary.
    "Is Abbas from Pakistan's north?",
    'Is the co-op open on Sundays?',
    'Grab a taco-on-a-stick at the market!',
    'Email admin@digiscalability.com or see island.digiscalability.com/z/hire.',
    'I met @spicygarden and @pakistan_cricket fans at the race.',
  ];
  const npcReplies = [
    'Welcome, traveller! This picnic spot is my favourite.',
    'Grab a taco on your way to the market!',
    'Ask the Mayor, his picks are always good.',
    'Look at this picture of the harbour at dawn.',
    'Try a spiced bun fresh from my oven.',
    'The Carpenter knows his picks of timber well.',
    'Abbas studied computer science at SZABIST in Islamabad, Pakistan, before Melbourne.',
    'Head to the Get In Touch district to reach Abbas.',
    'The Guard says: no bugs today, just a quiet patrol.',
  ];

  test.each([...visitorLines, ...npcReplies])('passes both gates: %s', (line) => {
    expect(passes(line)).toBe(true);
  });

  test('every authored line an NPC may repeat passes the output gate', () => {
    // Rumors are shared word for word; the island context, role lines and the
    // concierge facts are the material replies are built from.
    const authored = [
      ...RUMORS,
      ...ISLAND_CONTEXT.split(/(?<=\.)\s+/),
      ...NPC_ROLES.map((r) => `I am ${r.name}, ${r.role}.`),
      ...ABOUT_ABBAS.split('\n').filter((l) => l.trim()),
    ];
    const rejected = authored.filter((line) => !passes(line));
    expect(rejected).toEqual([]);
  });

  test('every full persona prompt passes the input gate', () => {
    for (const [id, persona] of buildPersonas(true)) {
      expect(containsSlur(persona.system), id).toBe(false);
    }
  });

  test('empty and whitespace-only replies are rejected', () => {
    expect(scrubReply('')).toBe('');
    expect(scrubReply('   \n  ')).toBe('');
  });
});

describe('analyst public issue text: counts filter', () => {
  test.each([
    ['Visitors (24h): 12 (+3)', 'Visitors (24h): [n]'],
    ['Only 3 new leads this week', 'Only [n] new leads this week'],
    ['Investigate zero leads', 'Investigate [n] leads'],
    ['AI chat used 1,234 tokens across 45 calls', 'AI chat used [n] tokens across [n] calls'],
    ['activeDevices=5 and devicesTotal: 140', 'activeDevices=[n] and devicesTotal: [n]'],
    ['Token use is at 15.2% of the monthly cap', 'Token use is at [n]% of the monthly cap'],
    ['Visitors went from 3 to 7', 'Visitors went from [n]'],
    ['live now: 2', 'live now: [n]'],
    ['a dozen visitors came by', '[n] visitors came by'],
    ['4.5k tokens this month', '[n] tokens this month'],
    ['2 unique IPs, 12 visitors (+3)', '[n] unique IPs, [n] visitors'],
    ['Only 2 of 12 visitors', 'Only [n] of [n] visitors'],
    ['Only 2 out of the 12 visitors stayed', 'Only [n] out of the [n] visitors stayed'],
    ['The guestbook has 31 notes', 'The guestbook has [n] notes'],
    ['The guestbook got 4 new notes', 'The guestbook got [n] new notes'],
    ['No leads have come in yet', '[n] leads have come in yet'],
    ['There were no new visitors on Tuesday', 'There were [n] new visitors on Tuesday'],
    ['Only one person raced today', 'Only [n] person raced today'],
    ['Devices dropped by 3', 'Devices dropped by [n]'],
    ['Leads rose by 2', 'Leads rose by [n]'],
    ['Traffic fell by 40%', 'Traffic fell by [n]%'],
  ])('rewrites the figures in %j', (input, expected) => {
    const out = redactCounts(input);
    expect(out.text).toBe(expected);
    expect(out.redactions).toBeGreaterThan(0);
  });

  test.each([
    'Upgrade three.js to r180 and test on port 5173',
    'Keep replies to 1-2 short sentences',
    'See SimpleUI.ts:6374 and WORLD_RADIUS 100',
    'Fix the HTTP 404 on /z/hire',
    'Add a call to action for 2 districts',
    'Node 22 runs all 24 villagers',
    'There is no view toggle on phones',
    'Show no call to action on the welcome card',
    'Show a prompt after 2 or 3 districts',
    'Release v1.2.3 on 2026-11-03',
  ])('leaves other numbers alone: %j', (input) => {
    expect(redactCounts(input)).toEqual({ text: input, redactions: 0 });
  });

  test('never drops a proposal: only the figures change', () => {
    for (const input of ['12 visitors', 'Leads: 0', 'zero leads', '15% of cap']) {
      const out = redactCounts(input).text;
      expect(out.length).toBeGreaterThan(0);
      expect(out.replace(/\[n\]/g, '').trim().length).toBeGreaterThan(0);
    }
    expect(redactCounts('').text).toBe('');
  });
});

describe('analyst stale-issue sweep', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const NOW = Date.parse('2026-11-02T10:00:00Z');
  const LABEL = 'island-analyst';
  const issue = (n: number, idleDays: number, extra: Record<string, unknown> = {}) => ({
    number: n,
    state: 'open',
    updated_at: new Date(NOW - idleDays * DAY).toISOString(),
    labels: [{ name: LABEL }],
    assignees: [],
    ...extra,
  });
  const list = [
    issue(7, 81),
    issue(8, 80),
    issue(9, 13), // active inside the window
    issue(10, 90, { labels: [{ name: LABEL }, { name: 'accepted' }] }), // a human label
    issue(11, 90, { assignees: [{ login: 'someone' }] }), // assigned
    issue(12, 90, { pull_request: {} }), // a pull request
    issue(13, 90, { updated_at: undefined }), // no readable date
    issue(14, 90, { labels: [] }), // not an analyst issue
    issue(15, 90, { state: 'closed' }),
    issue(16, 14, { labels: [LABEL] }), // exactly at the threshold, string label form
  ];

  test('closes only idle, unassigned issues that carry the analyst label alone', () => {
    expect(staleAnalystIssues(list, LABEL, NOW, 14 * DAY, 5)).toEqual([7, 8, 16]);
  });

  test('closes the least recently active first, at most max', () => {
    expect(staleAnalystIssues(list, LABEL, NOW, 14 * DAY, 2)).toEqual([7, 8]);
    expect(staleAnalystIssues(list, LABEL, NOW, 14 * DAY, 0)).toEqual([]);
  });

  test('a fresh backlog is left alone', () => {
    expect(staleAnalystIssues([issue(1, 1), issue(2, 13)], LABEL, NOW, 14 * DAY, 5)).toEqual([]);
  });
});

describe('analyst de-duplication against closed proposals', () => {
  const LABEL = 'island-analyst';
  const closed = (title: string, extra: Record<string, unknown> = {}) => ({
    title,
    state: 'closed',
    labels: [{ name: LABEL }],
    ...extra,
  });

  test('a filed title and the same proposal re-worded only in case and spacing share a key', () => {
    expect(proposalKey('[island] Add a  Guestbook prompt')).toBe('add a guestbook prompt');
    expect(proposalKey('add a guestbook prompt ')).toBe(
      proposalKey('[ISLAND]   Add a guestbook prompt'),
    );
    expect(proposalKey(undefined)).toBe('');
  });

  test('closed analyst issues become prompt titles, prefix dropped, newest first', () => {
    const list = [
      closed('[island] Add a guestbook prompt'),
      closed('[island] Start-tour badge for first-time visitors', {
        labels: [{ name: LABEL }, { name: 'declined' }], // a human label still counts
      }),
      closed('[island] add a guestbook prompt'), // a repeat
      closed('[island] A pull request', { pull_request: {} }),
      closed('[island] Not an analyst issue', { labels: [{ name: 'bug' }] }),
      closed('[island] Still open', { state: 'open' }),
      closed('[island]   '), // nothing left once the prefix goes
      closed('[island] Check the\nlead form', { labels: [LABEL] }), // string label form
    ];
    expect(closedProposalTitles(list, LABEL, 40)).toEqual([
      'Add a guestbook prompt',
      'Start-tour badge for first-time visitors',
      'Check the lead form',
    ]);
  });

  test('at most max titles, each cut to maxChars', () => {
    const list = Array.from({ length: 50 }, (_, i) =>
      closed(`[island] Proposal ${i} ${'x'.repeat(200)}`),
    );
    const titles = closedProposalTitles(list, LABEL, 40);
    expect(titles).toHaveLength(40);
    expect(Math.max(...titles.map((t) => t.length))).toBe(120);
    expect(closedProposalTitles(list, LABEL, 0)).toEqual([]);
  });
});

describe('concierge facts and the persona map (functions/src/personas.ts)', () => {
  const cast = buildPersonas(false);

  test('persona ids keep the client roster order (append-only)', () => {
    const chat = read('NpcChat.ts');
    const clientIds = [...chat.slice(chat.indexOf('AI_NPC_DEFS')).matchAll(/id: '([a-z_]+)'/g)].map(
      (m) => m[1],
    );
    expect(NPC_ROLES.map((r) => r.id)).toEqual(clientIds);
    expect([...cast.keys()]).toEqual(clientIds);
  });

  test('only the concierge personas carry the fact sheet', () => {
    const withFacts = [...cast].filter(([, p]) => p.system.includes(ABOUT_ABBAS)).map(([id]) => id);
    expect(withFacts).toEqual(NPC_ROLES.filter((r) => r.concierge).map((r) => r.id));
  });

  test('an Object.prototype key never resolves to a persona', () => {
    for (const key of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
      expect(cast.get(key)).toBeUndefined();
    }
  });

  test('the voice-delivery tag rule is added only when asked for', () => {
    expect(cast.get('storyteller')?.system).not.toContain('bracketed delivery tag');
    expect(buildPersonas(true).get('storyteller')?.system).toContain('bracketed delivery tag');
  });

  test('no phone number or street address, ever', () => {
    expect(ABOUT_ABBAS).not.toMatch(/(\+61|\b0)[\s-]?4\d{2}[\s-]?\d{3}[\s-]?\d{3}/);
    expect(ABOUT_ABBAS).not.toMatch(/\b\d{3}[\s-]\d{3}[\s-]\d{3}\b/);
    expect(ABOUT_ABBAS).not.toMatch(
      /\b\d+\s+[A-Z][a-z]+\s+(Street|St|Road|Rd|Avenue|Ave|Parade|Pde|Drive|Dr)\b/,
    );
    expect(ABOUT_ABBAS).not.toMatch(/Mordialloc/i);
  });

  test('the corrected claims hold', () => {
    for (const fact of [
      'AI & software engineer',
      'DigiScalability is one person',
      'open source (MIT) on GitHub',
      'SZABIST',
      '11 of 16 credit points completed',
      'RankPilot (live, pre-launch: no users beyond test accounts)',
      "his mother's (Ammi's) handwritten recipes from 1981",
      'ChocoMate is paused',
      '24 villagers',
      'linkedin.com/in/-abbas-ali',
      'admin@digiscalability.com',
    ]) {
      expect(ABOUT_ABBAS).toContain(fact);
    }
    // The Master's line may only appear inside the "never say" instruction.
    const asserted = ABOUT_ABBAS.replace(/Never say[^.]*\./g, '');
    for (const retired of [
      /nearly (done|finished|complete)/i,
      /graduated/i,
      /daily use/i,
      /day job/i,
      /grandmother/i,
      /\bstudio\b/i,
      /\bteam\b/i,
      /\bagency\b/i,
      /\bsenior\b/i,
      /every townsperson/i,
      /linkedin\.com\/in\/digiscalability/i,
    ]) {
      expect(asserted).not.toMatch(retired);
    }
  });

  test('"open source" waits for a licence', () => {
    // Without a LICENSE file the code would be all rights reserved by default,
    // so "open source" would be false. The LICENSE is MIT, which is what lets
    // the villagers and the analyst say "open source (MIT)": remove or change
    // it and this fails until they change too.
    if (existsSync(join(ROOT, 'LICENSE'))) {
      expect(read('LICENSE')).toMatch(/^MIT License\r?\n/);
      return;
    }
    expect(ABOUT_ABBAS).not.toMatch(/open[- ]source/i);
    expect(read('functions/src/analyst.ts')).not.toMatch(/open[- ]source/i);
  });
});
