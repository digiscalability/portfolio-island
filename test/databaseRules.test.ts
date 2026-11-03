// database.rules.json against the client code that writes to it.
//
// The behavioural check (tools/rules-check.mjs) needs the RTDB emulator, so
// CI pins the structure instead:
// - no client-writable node accepts keys nobody validates, or a bare value
//   where it expects children, so no visitor can attach unbounded data that
//   every other visitor or the analyst downloads;
// - every field the client writes has a rule. Profiles and presence close with
//   $other false, so a field added in code but not here would make the whole
//   save fail silently.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import { LEADERBOARD_ERA } from '../functions/src/constants';
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
/** Top-level keys of an object literal or interface body: `key:`, `key?:` and
 *  shorthand `key,` lines. Nested `{ ... }` bodies are skipped, and a spread
 *  fails the test, because its keys cannot be checked against the rules. */
function topKeys(code: string): string[] {
  const body = code.slice(code.indexOf('{') + 1);
  expect(body, 'a spread hides which keys are written').not.toMatch(/^\s*\.\.\./m);
  let flat = '';
  let depth = 0;
  for (const ch of body) {
    if (ch === '{') depth++;
    if (ch === '}') depth--;
    if (depth === 0 && ch !== '}') flat += ch;
  }
  return [...flat.matchAll(/^\s+(\w+)(?:\??:|,$)/gm)].map((m) => m[1]);
}

describe('no client-writable node accepts unvalidated data', () => {
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
    expect(writable.map(([path]) => path).sort()).toEqual(
      [
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
      ].sort(),
    );
  });

  test.each(writable.map(([path, node]) => [path, node] as const))('%s', (path, node) => {
    const loose: string[] = [];
    (function walk(n: Rule, p: string): void {
      const keys = Object.keys(n).filter((k) => !k.startsWith('.') && k !== '$other');
      if (!keys.length) return;
      // Child rules never run on a bare value, so a node that has them must
      // validate its own shape, or a 9 MB string written there would pass.
      if (typeof n['.validate'] !== 'string') loose.push(`${p} has no .validate of its own`);
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

  test('presence and meta accept only the island room', () => {
    for (const root of ['presence', 'meta']) {
      expect(at(root, '$room', '$uid')['.write'], root).toContain("$room === 'island'");
    }
    expect(src('Multiplayer.ts')).toContain("const roomPath = 'presence/island';");
    expect(src('Multiplayer.ts')).toContain("const metaRoomPath = 'meta/island';");
  });
});

describe('profiles match profileSync.Profile', () => {
  const profile = (): string => block('profileSync.ts', 'export interface Profile {', '\n}\n');

  test('every Profile field, plus the save stamp t, has a rule', () => {
    const node = at('profiles', '$uid');
    expect(children(node).sort()).toEqual([...topKeys(profile()), 't'].sort());
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
    const keys = topKeys(block('Multiplayer.ts', 'set(myNode, {', '});'));
    expect(keys).toContain('p');
    for (const key of keys) expect(children(at('presence', '$room', '$uid')), key).toContain(key);
  });

  test('the cold meta write', () => {
    const keys = topKeys(block('Multiplayer.ts', 'set(myMetaNode, {', '});'));
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

  test('a lap faster than any vehicle can drive is refused', () => {
    // Land gates sit on a 5-gon at latitude 0.38 and water gates on a 6-gon at
    // 0.12 (RaceSystem.buildCircuit), about 545 u and 596 u a lap at R=100.
    // At top speed (car 13 u/s, jetski 16 u/s) that is ~42 s and ~37 s, so a
    // 15 s floor blocks a forged '1 ms' record without touching a real lap.
    const rule = at('leaderboard', 'island', '$era', '$circuit', '$uid', 'timeMs')['.validate'];
    expect(rule).toBe('newData.isNumber() && newData.val() >= 15000');
    expect(src('GameScene.ts')).toContain(
      "const speed = v.kind === 'jetski' ? 16 : isCar ? 13 : 11;",
    );
  });

  test('the nightly functions read the same era the client writes', () => {
    expect(LEADERBOARD_ERA).toBe(WORLD_ERA);
    for (const file of ['functions/src/analyst.ts', 'functions/src/npcPlanner.ts']) {
      expect(src(file), file).toContain('db.ref(`leaderboard/island/${LEADERBOARD_ERA}`)');
    }
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
