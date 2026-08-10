// Structural guard: placement arcs must be authored in METRES, not radians.
//
// The whole R50->R75 migration existed because ~40 claim arcs were written as
// bare radians, hand-tuned to produce a specific metre distance at one radius.
// They are invisible to tsc, to eslint and to every behavioural test: the world
// still builds, it just lays itself out wrong. This is the only mechanism that
// catches the NEXT one.
//
// The rule: any arc argument must reference the radius (`/ this.radius`, `/ R`,
// `getRadius()`), so it means "N metres" at whatever size the world is.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

/** Placement helpers whose arc/angle argument is a geodesic angle. */
const ARC_CALLS = ['claimDir', 'claimOffStreet', 'jitterDir', 'ringAround'] as const;
const FILES = ['Island.ts', 'GameScene.ts', 'NpcActivities.ts'] as const;

interface Offender {
  file: string;
  where: string; // "File.ts:123" — for the failure message only, never for identity
  call: string;
  arg: string;
}

/** Split a call's argument list at top-level commas only. */
function topLevelArgs(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.map((a) => a.trim());
}

/** Grab the balanced argument text following `name(`. */
function callArgsAt(src: string, open: number): string | null {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')') {
      depth--;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  return null;
}

function scan(file: string): Offender[] {
  const src = readFileSync(join(process.cwd(), file), 'utf8');
  const offenders: Offender[] = [];
  for (const call of ARC_CALLS) {
    const re = new RegExp(`\\b${call}\\s*\\(`, 'g');
    for (const m of src.matchAll(re)) {
      const open = m.index! + m[0].length - 1;
      // Skip the declaration itself.
      const lineStart = src.lastIndexOf('\n', m.index!) + 1;
      const linePrefix = src.slice(lineStart, m.index!);
      if (/(private|public|protected|function|const)\s*$/.test(linePrefix)) continue;

      const argText = callArgsAt(src, open);
      if (argText == null) continue;
      const args = topLevelArgs(argText);
      // Every helper in ARC_CALLS takes the arc as its SECOND argument:
      //   claimDir(dir, minArc, maxSlope?)   claimOffStreet(dir, clearArc)
      //   claimClearSpot(dir, clearArc, ...) jitterDir(home, arc, out)
      //   ringAround(centre, arc, n)
      // Checking position rather than "any numeric argument" matters: the old
      // version flagged ringAround's waypoint COUNT as if it were an angle.
      const arc = args[1];
      if (!arc || !/^-?\d*\.?\d+$/.test(arc)) continue; // expression, not a bare literal — fine
      offenders.push({
        file,
        where: `${file}:${src.slice(0, m.index!).split('\n').length}`,
        call,
        arg: arc,
      });
    }
  }
  return offenders;
}

/**
 * Sites still authored in bare radians, as `file|call|arg` with one entry per
 * occurrence. This list may only ever SHRINK; emptying it is Step 2 of the
 * radius migration.
 *
 * Deliberately NOT keyed by line number. The first version was, and it went
 * stale the moment an import was added above the offenders — 29 false failures
 * from an edit that touched none of them. Debt identity has to survive the
 * edits you make while paying it down.
 *
 * KNOWN GAP: this scanner only understands the four helpers in ARC_CALLS.
 * GameScene's own placement entry points (`placeOnSphere` clearArc,
 * `scatterProps`) take arcs too and are NOT covered — extend ARC_CALLS once
 * their argument positions are pinned down, or they will rot the same way.
 */
const KNOWN_DEBT: readonly string[] = [
  // Emptied by Step 2 of the R50->R75 migration: all 29 sites now call
  // Island.arc(metres) / NpcActivities.arc(metres). Keep it empty.
];

function tally(keys: readonly string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const k of keys) m.set(k, (m.get(k) ?? 0) + 1);
  return m;
}

describe('placement arcs are authored in metres, not radians', () => {
  const offenders = FILES.flatMap(scan);

  test('scanner is not silently broken', () => {
    // If the helpers get renamed and this finds nothing, the guard is dead.
    const total = FILES.map((f) => readFileSync(join(process.cwd(), f), 'utf8'))
      .join('\n')
      .match(/\b(claimDir|claimOffStreet|jitterDir|ringAround)\s*\(/g);
    expect(total && total.length).toBeGreaterThan(20);
  });

  test('no NEW bare-radian arc has been introduced', () => {
    const allowed = tally(KNOWN_DEBT);
    const found = tally(offenders.map((o) => `${o.file}|${o.call}|${o.arg}`));
    const excess: string[] = [];
    for (const [key, n] of found) {
      const ok = allowed.get(key) ?? 0;
      if (n > ok) excess.push(`  ${key} x${n} (allowed ${ok})`);
    }
    expect(excess.length, `new bare-radian arcs:\n${excess.join('\n')}`).toBe(0);
  });

  test('the debt list does not outlive the debt', () => {
    // Forces KNOWN_DEBT to be pruned as Step 2 converts sites, so it can't
    // quietly grant permission for arcs that no longer exist.
    const found = tally(offenders.map((o) => `${o.file}|${o.call}|${o.arg}`));
    const stale: string[] = [];
    for (const [key, n] of tally(KNOWN_DEBT)) {
      const actual = found.get(key) ?? 0;
      if (actual < n) stale.push(`  ${key}: allowed ${n}, only ${actual} remain`);
    }
    expect(stale.length, `prune these from KNOWN_DEBT:\n${stale.join('\n')}`).toBe(0);
  });
});
