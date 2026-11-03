// test/helpers/astSlice.ts, the shared read-only slicer stage-2 locks use
// (item CO-E1). It runs on a fixture written here, so this file reads no
// package's code and the lock census sees no cross-package read.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';

import { functionBody, methodBody, statementAt, stripComments } from './helpers/astSlice';

const dir = mkdtempSync(join(tmpdir(), 'astslice-'));
const FIXTURE = join(dir, 'Fixture.ts');
writeFileSync(
  FIXTURE,
  [
    '// warmInterior() in a comment is never a hit',
    'export class Scene {',
    '  private warmed = false;',
    '  public warm(n: number): number;',
    '  public warm(n: number, k?: number): number {',
    '    /* the warm runs once */',
    '    if (this.warmed) return 0;',
    '    this.warmed = true;',
    "    const label = 'cel-rim-v1';",
    '    return n + (k ?? 0) + label.length;',
    '  }',
    '  get ready(): boolean {',
    '    return this.warmed;',
    '  }',
    '  onTick = (dt: number) => {',
    '    this.warm(dt);',
    '  };',
    '  constructor() {',
    '    this.warm(1);',
    '  }',
    '}',
    'export function compassBearing(a: number, b: number): number {',
    '  // warmInterior() again, still a comment',
    '  if (a > b) {',
    '    return a - b;',
    '  }',
    '  return b - a;',
    '}',
    'export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;',
    '',
  ].join('\r\n'), // a Windows checkout: CRLF must not matter
);

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('methodBody', () => {
  test('returns the exact body of the overload that has one, braces included', () => {
    const body = methodBody(FIXTURE, 'Scene.warm');
    expect(body.startsWith('{')).toBe(true);
    expect(body.endsWith('}')).toBe(true);
    expect(body).toContain('if (this.warmed) return 0;');
    expect(body).toContain("'cel-rim-v1'");
    expect(body).not.toContain('get ready');
    expect(body).not.toContain('\r');
  });

  test('covers accessors, arrow properties and the constructor', () => {
    expect(methodBody(FIXTURE, 'Scene.ready')).toContain('return this.warmed;');
    expect(methodBody(FIXTURE, 'Scene.onTick')).toContain('this.warm(dt);');
    expect(methodBody(FIXTURE, 'Scene.constructor')).toContain('this.warm(1);');
  });

  test('fails loudly on a missing class or member, never a silent empty string', () => {
    expect(() => methodBody(FIXTURE, 'Nope.warm')).toThrow(/no class Nope/);
    expect(() => methodBody(FIXTURE, 'Scene.nope')).toThrow(/no member Scene.nope/);
  });
});

describe('functionBody', () => {
  test('a function declaration and a const arrow', () => {
    expect(functionBody(FIXTURE, 'compassBearing')).toContain('return b - a;');
    expect(functionBody(FIXTURE, 'lerp')).toBe('a + (b - a) * t');
  });
});

describe('statementAt', () => {
  test('the statement holding a marker in code; comment hits are skipped', () => {
    expect(statementAt(FIXTURE, "'cel-rim-v1'")).toBe("const label = 'cel-rim-v1';");
    expect(() => statementAt(FIXTURE, 'warmInterior()')).toThrow(/no 'warmInterior\(\)' in code/);
  });

  test("kind 'if' returns the enclosing if; within narrows to one member", () => {
    expect(statementAt(FIXTURE, 'return a - b;', { kind: 'if' })).toMatch(
      /^if \(a > b\) \{[\s\S]*\}$/,
    );
    expect(statementAt(FIXTURE, 'this.warm(', { within: 'Scene.constructor' })).toBe(
      'this.warm(1);',
    );
    expect(statementAt(FIXTURE, 'this.warm(', { within: 'Scene.onTick' })).toBe('this.warm(dt);');
    expect(statementAt(FIXTURE, 'return', { within: 'compassBearing', nth: 1 })).toBe(
      'return b - a;',
    );
  });
});

describe('stripComments', () => {
  test('drops comments and keeps strings', () => {
    const s = stripComments("const a = 1; // x\n/* y */ const b = '// not a comment';\n");
    expect(s).not.toContain('// x');
    expect(s).not.toContain('/* y */');
    expect(s).toContain("'// not a comment'");
  });
});
