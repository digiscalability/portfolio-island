// database.rules.json against the client code that writes to it.
//
// The behavioural check (tools/rules-check.mjs) needs the RTDB emulator, so
// CI pins the structure instead:
// - no client-writable node accepts keys nobody validates, so no visitor can
//   attach unbounded data that every other visitor or the analyst downloads;
// - every field the client writes has a rule. Profiles and presence close with
//   $other false, so a field added in code but not here would make the whole
//   save fail silently.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import { WORLD_ERA } from '../WorldScale';

const src = (f: string): string =>
  readFileSync(join(process.cwd(), f), 'utf8').replace(/\r\n/g, '\n');

type Rule = { [key: string]: Rule | string | boolean };
const rules = (JSON.parse(src('database.rules.json')) as { rules: Rule }).rules;
function at(...path: string[]): Rule {
  let node: Rule | undefined = rules;
  for (const key of path) node = node?.[key] as Rule | undefined;
  expect(node, `database.rules.json has no ${path.join('/')}`).toBeDefined();
  return node!;
}
/** Named and wildcard children, without .rules and the $other catch-all. */
const children = (node: Rule): string[] =>
  Object.keys(node).filter((k) => !k.startsWith('.') && k !== '$other');
const closed = (node: Rule): boolean => (node.$other as Rule | undefined)?.['.validate'] === false;
const quoted = (s: string): string[] => [...s.matchAll(/'([^']+)'/g)].map((m) => m[1]);

/** One block of source: from `marker` to the first line that closes it. */
function block(file: string, marker: string, close: string): string {
  const s = src(file);
  const i = s.indexOf(marker);
  expect(i, `${marker} not found in ${file}`).toBeGreaterThan(-1);
  return s.slice(i, s.indexOf(close, i));
}
/** Keys of an object literal written as `key:` at the start of a line. */
const literalKeys = (code: string): string[] =>
  [...code.matchAll(/^\s+(\w+)\??:/gm)].map((m) => m[1]);

describe('no client-writable node accepts unvalidated keys', () => {
  const writable: Array<[string, Rule]> = [];
  (function find(node: Rule, path: string): void {
    if (typeof node['.write'] === 'string') {
      writable.push([path, node]);
      return;
    }
    for (const key of Object.keys(node).filter((k) => !k.startsWith('.'))) {
      find(node[key] as Rule, `${path}/${key}`);
    }
  })(rules, '');

  test('the writable nodes are the ones the client uses', () => {
    expect(writable.map(([path]) => path)).toEqual([
      '/presence/$room/$uid',
      '/meta/$room/$uid',
      '/profiles/$uid',
      '/chat/island/$entry',
      '/voice/island/$entry',
      '/leaderboard/island/$era/$circuit/$uid',
      '/guestbook/island/$entry',
      '/leads/island/$entry',
      '/world/benches/$benchId',
      '/world/builds/$buildId',
    ]);
  });

  test.each(writable.map(([path, node]) => [path, node] as const))('%s', (path, node) => {
    const loose: string[] = [];
    (function walk(n: Rule, p: string): void {
      const keys = Object.keys(n).filter((k) => !k.startsWith('.') && k !== '$other');
      if (!keys.length) return;
      const named = keys.filter((k) => !k.startsWith('$'));
      for (const wild of keys.filter((k) => k.startsWith('$'))) {
        // A wildcard is bounded only if its own rule constrains the key.
        const v = (n[wild] as Rule)['.validate'];
        if (typeof v !== 'string' || !v.includes(wild)) loose.push(`${p}/${wild}`);
      }
      if (named.length && !closed(n)) loose.push(`${p} has no $other: false`);
      for (const key of keys) walk(n[key] as Rule, `${p}/${key}`);
    })(node, path);
    expect(loose).toEqual([]);
  });
});

describe('profiles match profileSync.Profile', () => {
  const profile = (): string => block('profileSync.ts', 'export interface Profile {', '\n}\n');

  test('every Profile field, plus the save stamp t, has a rule', () => {
    const node = at('profiles', '$uid');
    expect(children(node).sort()).toEqual([...literalKeys(profile()), 't'].sort());
  });

  test.each(['meals', 'inventory'])('%s keys match the interface', (field) => {
    const shape = new RegExp(`${field}\\?: \\{([^}]*)\\}`).exec(profile())?.[1] ?? '';
    const keys = [...shape.matchAll(/(\w+):/g)].map((m) => m[1]);
    expect(keys.length).toBeGreaterThan(0);
    expect(children(at('profiles', '$uid', field)).sort()).toEqual(keys.sort());
  });
});

describe('body parts match SimplePlayer.BodyPart', () => {
  test.each([
    ['presence cols', ['presence', '$room', '$uid', 'cols', '$part']],
    ['meta cols', ['meta', '$room', '$uid', 'cols', '$part']],
    ['profile colors', ['profiles', '$uid', 'colors', '$part']],
  ])('%s', (_label, path) => {
    const parts = quoted(block('SimplePlayer.ts', 'export type BodyPart =', ';'));
    const rule = at(...path)['.validate'] as string;
    const allowed = [...rule.matchAll(/\$part === '(\w+)'/g)].map((m) => m[1]);
    expect(allowed.sort()).toEqual([...parts].sort());
  });
});

describe('presence and meta writes match Multiplayer', () => {
  test('the 10 Hz state write', () => {
    const keys = literalKeys(block('Multiplayer.ts', 'set(myNode, {', '});'));
    expect(keys).toContain('p');
    for (const key of keys) expect(children(at('presence', '$room', '$uid')), key).toContain(key);
  });

  test('the cold meta write', () => {
    const keys = literalKeys(block('Multiplayer.ts', 'set(myMetaNode, {', '});'));
    expect(keys).toContain('name');
    for (const key of keys) expect(children(at('meta', '$room', '$uid')), key).toContain(key);
  });
});

describe('leaderboard matches Boards.submitRaceTime', () => {
  const write = (): string =>
    at('leaderboard', 'island', '$era', '$circuit', '$uid')['.write'] as string;

  test('the rules path has the era level Boards.ts writes', () => {
    expect(src('Boards.ts')).toContain('`leaderboard/island/${WORLD_ERA}/${circuit}/${uid}`');
    const era = /\$era\.matches\(\/(.+?)\/\)/.exec(write())?.[1];
    expect(era).toBeDefined();
    expect(new RegExp(era!).test(WORLD_ERA)).toBe(true);
  });

  test('the circuits are CircuitKind', () => {
    const kinds = quoted(block('Boards.ts', 'export type CircuitKind =', ';'));
    const allowed = [...write().matchAll(/\$circuit === '(\w+)'/g)].map((m) => m[1]);
    expect(allowed.sort()).toEqual(kinds.sort());
  });
});

describe('benches match worldBenches.placeBench', () => {
  test('a bench is a plot and a stamp, nothing else', () => {
    expect(src('worldBenches.ts')).toContain('await rtdb.set(ref, { plot, t: Date.now() });');
    const node = at('world', 'benches', '$benchId');
    expect(children(node).sort()).toEqual(['plot', 't']);
    expect(closed(node)).toBe(true);
  });
});
