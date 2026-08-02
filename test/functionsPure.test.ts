// Unit tests for the Cloud Functions' money logic — the pure half extracted
// into functions/src/pure.ts precisely so it can be tested without a Firebase
// emulator: the per-IP rate window, the janitor's prune selection, and the
// deterministic seeded pick that keeps the world alive when the LLM fails.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import { IP_MAX_PER_WINDOW } from '../functions/src/constants';
import { ipKey, nextIpWindow, pruneSelect, seededPick } from '../functions/src/pure';

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

describe('seededPick', () => {
  const arr = ['a', 'b', 'c', 'd', 'e'] as const;

  test('deterministic: same seed → same element', () => {
    for (const seed of [0, 1, 7, 20260802, -3, 2 ** 31]) {
      expect(seededPick(arr, seed)).toBe(seededPick(arr, seed));
    }
  });

  test('always in bounds, for any array length', () => {
    for (const a of [['x'], arr, Array.from({ length: 18 }, (_, i) => i)]) {
      for (let seed = 0; seed < 500; seed++) {
        expect(a).toContain(seededPick(a, seed));
      }
    }
  });

  test('actually varies across seeds (not a constant function)', () => {
    const picks = new Set<string>();
    for (let seed = 0; seed < 100; seed++) picks.add(seededPick(arr, seed));
    expect(picks.size).toBeGreaterThan(1);
  });
});

describe('ipKey', () => {
  test('replaces every RTDB-illegal character', () => {
    expect(ipKey('1.2.3.4')).toBe('1_2_3_4');
    expect(ipKey('2001:db8::1')).toBe('2001_db8__1');
    expect(ipKey('a#b$c[d]e/f')).toBe('a_b_c_d_e_f');
  });

  test('empty/missing input falls back to a usable key', () => {
    expect(ipKey('')).toBe('noip');
    expect(ipKey(null)).toBe('noip');
    expect(ipKey(undefined)).toBe('noip');
  });

  test('caps length at 60', () => {
    expect(ipKey('x'.repeat(200))).toHaveLength(60);
  });
});

describe('nextIpWindow — fixed window, anchored at first hit', () => {
  const WINDOW = 60_000;

  test('first call starts a window at now with count 1', () => {
    expect(nextIpWindow(null, 1000, WINDOW)).toEqual({ c: 1, t: 1000 });
  });

  test('calls inside the window increment and KEEP the window start', () => {
    let node = nextIpWindow(null, 1000, WINDOW);
    for (let i = 2; i <= 5; i++) {
      node = nextIpWindow(node, 1000 + i * 5000, WINDOW);
      expect(node.c).toBe(i);
      expect(node.t).toBe(1000); // anchored — a burst can't slide the window
    }
  });

  test('a call at exactly windowMs resets (strict <)', () => {
    const node = nextIpWindow({ c: 5, t: 1000 }, 1000 + WINDOW, WINDOW);
    expect(node).toEqual({ c: 1, t: 1000 + WINDOW });
  });

  test('an expired window resets to a fresh count', () => {
    const node = nextIpWindow({ c: 99, t: 1000 }, 1000 + WINDOW * 3, WINDOW);
    expect(node).toEqual({ c: 1, t: 1000 + WINDOW * 3 });
  });

  test('malformed prev nodes are treated as expired, never crash', () => {
    expect(nextIpWindow({}, 5_000_000, WINDOW).c).toBe(1);
    expect(nextIpWindow({ c: undefined, t: undefined }, 5_000_000, WINDOW).c).toBe(1);
  });

  test(`the shared cap blocks call ${IP_MAX_PER_WINDOW + 1} within one window`, () => {
    let node: { c: number; t: number } | null = null;
    let blockedAt = 0;
    for (let call = 1; call <= IP_MAX_PER_WINDOW + 1; call++) {
      node = nextIpWindow(node, 1000 + call, WINDOW);
      if (node.c > IP_MAX_PER_WINDOW) {
        blockedAt = call;
        break;
      }
    }
    expect(blockedAt).toBe(IP_MAX_PER_WINDOW + 1);
  });
});

describe('pruneSelect', () => {
  const NOW = 1_000_000;
  const AGE = 10_000;

  test('drops old entries, keeps fresh ones', () => {
    const out = pruneSelect(
      { fresh: { t: NOW - 1 }, edge: { t: NOW - AGE }, old: { t: NOW - AGE - 1 } },
      NOW,
      AGE,
    );
    expect(out).toEqual({ old: null }); // exactly-at-age survives (strict >)
  });

  test('missing or malformed t counts as ancient', () => {
    const out = pruneSelect(
      { noT: {}, badT: { t: 'soon' as unknown as number }, ok: { t: NOW } },
      NOW,
      AGE,
    );
    expect(out).toEqual({ noT: null, badT: null });
  });

  test('null node → nothing to delete', () => {
    expect(pruneSelect(null, NOW, AGE)).toEqual({});
  });
});

describe('pure.ts is the single source (no drifted local copies)', () => {
  test('index.ts and npcPlanner.ts import seededPick instead of redefining it', () => {
    for (const rel of ['functions/src/index.ts', 'functions/src/npcPlanner.ts']) {
      const src = read(rel);
      expect(src).toMatch(/from '\.\/pure'/);
      expect(src).not.toMatch(/function seededPick/);
    }
  });
});
