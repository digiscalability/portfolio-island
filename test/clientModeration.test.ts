// Client-side gates (Moderation.ts): display names (checkName, safePeerName)
// and chat and guestbook text (cleanChatText). The client runs the server's
// matcher (functions/src/moderation.ts), so ordinary words and names pass while
// obfuscated forms of every listed term are still caught. No listed term is
// written in this file or printed by it: forms are built from the exported
// list at run time and cases are named by index.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import { containsSlur as serverContainsSlur, SLURS } from '../functions/src/moderation';
import {
  checkName,
  cleanChatText,
  containsSlur as clientContainsSlur,
  isOffensiveName,
  safePeerName,
} from '../Moderation';

const ch = (code: number) => String.fromCharCode(code);
const zeroWidthSpace = ch(0x200b);
const softHyphen = ch(0xad);
const combiningAcute = ch(0x301);
const spacingAcute = ch(0xb4); // NFKD writes it as a space plus a combining mark
const swap: Record<string, string> = { a: '4', e: '3', i: '1', o: '0', s: '5' };
const firstVowel = (t: string) =>
  Math.max(
    0,
    [...t].findIndex((c) => 'aeiou'.includes(c)),
  );

/** Obfuscated forms of one term, each short enough to be a name (20 chars). */
const forms: Array<[string, (t: string) => string]> = [
  ['as typed', (t) => t],
  ['capitalised', (t) => t[0].toUpperCase() + t.slice(1)],
  ['in capitals', (t) => t.toUpperCase()],
  ['as a plural', (t) => (t.endsWith('y') ? `${t.slice(0, -1)}ies` : `${t}s`)],
  ['in leetspeak', (t) => t.replace(/[aeios]/, (c) => swap[c])],
  ['in symbol leetspeak', (t) => t.replace(/a/g, '@').replace(/s/g, '$').replace(/i/g, '!')],
  ['with a letter stretched', (t) => t.slice(0, 2) + t[1] + t.slice(2)],
  ['with a letter stretched three times', (t) => t.slice(0, 2) + t[1].repeat(3) + t.slice(2)],
  ['spaced out letter by letter', (t) => t.split('').join(' ')],
  ['dotted letter by letter', (t) => t.split('').join('.')],
  ['with a dot inside', (t) => t.slice(0, 2) + '.' + t.slice(2)],
  ['with a hyphen inside', (t) => t.slice(0, 2) + '-' + t.slice(2)],
  ['with an underscore inside', (t) => t.slice(0, 2) + '_' + t.slice(2)],
  ['with an apostrophe inside', (t) => t.slice(0, 2) + "'" + t.slice(2)],
  ['with an asterisk inside', (t) => t.slice(0, 2) + '*' + t.slice(2)],
  ['with the first letter split off', (t) => t[0] + '.' + t.slice(1)],
  ['as an @-mention', (t) => `@${t}`],
  ['inside punctuation', (t) => `(${t})!`],
  [
    'with a combining accent',
    (t) => t.slice(0, firstVowel(t) + 1) + combiningAcute + t.slice(firstVowel(t) + 1),
  ],
  [
    'with a precomposed accent',
    (t) =>
      t.slice(0, firstVowel(t)) +
      (t[firstVowel(t)] + combiningAcute).normalize('NFC') +
      t.slice(firstVowel(t) + 1),
  ],
  ['with a spacing accent inside', (t) => t.slice(0, 2) + spacingAcute + t.slice(2)],
  ['with a zero-width space inside', (t) => t.slice(0, 2) + zeroWidthSpace + t.slice(2)],
  ['with a soft hyphen inside', (t) => t.slice(0, 2) + softHyphen + t.slice(2)],
  [
    'in full-width letters',
    (t) => [...t].map((c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0)).join(''),
  ],
];

/** A name the visitor typed is refused, and the same name from the wire is
 *  shown as "Visitor". */
const nameBlocked = (name: string) =>
  !checkName(name).ok && safePeerName(name) === 'Visitor' && isOffensiveName(name);
/** The form never reaches the screen: its word is masked or the message dropped. */
const chatBlocked = (form: string) => !cleanChatText(`you are a ${form} ok`).includes(form);

describe('ordinary names and words pass', () => {
  // The doubled-letter traps: the old filter collapsed doubled letters, so a
  // four-letter term with one became "con" and blocked these.
  const names = [
    'Connor',
    'Conrad',
    'Bacon',
    'Second',
    'Niger',
    'Jo Ann',
    'Matt Cocks',
    'Scunthorpe',
  ];
  const words = [
    'contact',
    'second',
    'economy',
    'icon',
    'Let us contact Abbas',
    'Pros and cons of living here?',
    'Is this a con?',
    'Is Niger near Nigeria?',
    'I live in Scunthorpe',
    'to well head',
  ];

  test.each(names)('the name %j is accepted unchanged', (name) => {
    expect(checkName(name)).toEqual({ ok: true, name });
    expect(safePeerName(name)).toBe(name);
  });

  test.each([...names, ...words])('the chat line %j is published unchanged', (line) => {
    expect(cleanChatText(line)).toBe(line);
  });

  test('every benign line the server must pass also passes the client unchanged', () => {
    // The evals corpus of hand-labelled benign text (words that contain a short
    // term, numbers that read as leetspeak, initials spelled out, other scripts).
    const rows = readFileSync(join(process.cwd(), 'evals/data/moderation_benign.jsonl'), 'utf8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as { id: string; text: string; expected?: string; gated?: boolean })
      .filter((r) => (r.expected ?? 'allow') === 'allow' && r.gated !== false);
    expect(rows.length).toBeGreaterThan(50);
    const changed = rows
      .filter((r) => {
        const expected = Array.from(r.text.replace(/\s+/g, ' ').trim()).slice(0, 120).join('');
        return cleanChatText(r.text) !== expected;
      })
      .map((r) => r.id);
    expect(changed).toEqual([]);
  });
});

describe('severe terms are still blocked', () => {
  test.each(SLURS.map((_, i) => i))('term #%i is refused as a name in every form', (i) => {
    // Reports only the NAMES of forms that slipped through, never the term.
    const missed = forms
      .filter(([, make]) => {
        const name = make(SLURS[i]);
        expect(name.length).toBeLessThanOrEqual(20);
        return !nameBlocked(name);
      })
      .map(([form]) => form);
    expect(missed).toEqual([]);
  });

  test.each(SLURS.map((_, i) => i))('term #%i never reaches the chat in any form', (i) => {
    const missed = forms.filter(([, make]) => !chatBlocked(make(SLURS[i]))).map(([form]) => form);
    expect(missed).toEqual([]);
  });

  test.each(SLURS.map((_, i) => i))(
    'term #%i split in two by a space is refused as a name',
    (i) => {
      // A name is one label: its spaces are dropped and it is read as one word.
      const t = SLURS[i];
      const half = Math.floor(t.length / 2);
      expect(nameBlocked(`${t.slice(0, half)} ${t.slice(half)}`)).toBe(true);
    },
  );

  test('a term spelled out across words drops the whole message', () => {
    for (const t of SLURS) {
      expect(cleanChatText(`hey ${t.split('').join(' ')} ok`)).toBe('');
    }
  });
});

describe('the client and the server agree', () => {
  test('containsSlur gives the same verdict on both sides', () => {
    const corpus: string[] = [];
    for (const t of SLURS) {
      for (const [, make] of forms) {
        const f = make(t);
        corpus.push(f, `you are a ${f}`, `hey ${f}!`);
      }
      corpus.push(
        `${t}lover`,
        `${t}ed`,
        `${t}os`,
        t.replace(/(.)\1+/g, '$1'),
        `${t[0]}*${t.slice(2)}`,
      );
    }
    // Deterministic noise: the terms with separators, leetspeak and case mixed in.
    let seed = 7;
    const rnd = (n: number) => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n;
    const bits = ['.', '-', '_', "'", '*', ' ', '@', '$', '!', '0', '1', '3', '4', zeroWidthSpace];
    for (let k = 0; k < 3000; k++) {
      let s = '';
      for (const c of SLURS[rnd(SLURS.length)]) {
        s += rnd(3) === 0 ? c.toUpperCase() : c;
        if (rnd(5) === 0) s += bits[rnd(bits.length)];
        if (rnd(9) === 0) s += c;
      }
      corpus.push(rnd(4) === 0 ? `word ${s} word` : s);
    }
    const disagree = corpus.filter((s) => clientContainsSlur(s) !== serverContainsSlur(s)).length;
    expect(disagree).toBe(0);
  });
});

describe('the moderation sources are plain text', () => {
  // A literal NUL makes git and GitHub treat a file as binary, so a change to the
  // filter cannot be reviewed in a diff, and an invisible character is easy to
  // miss in review. Both belong in the source as escapes.
  test.each(['Moderation.ts', 'functions/src/moderation.ts', 'test/moderation.test.ts'])(
    '%s has no control or invisible characters',
    (rel) => {
      const text = readFileSync(join(process.cwd(), rel), 'utf8');
      const hidden = new RegExp('[^\\P{Cc}\\t\\n\\r]|\\p{Cf}', 'u');
      expect(hidden.test(text)).toBe(false);
    },
  );
});
