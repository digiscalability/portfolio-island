// Parity guards for the "living NPCs" client↔server contract.
//
// The server (functions/) never writes world-visible PROSE — it index-selects:
// the analyst writes a notice-line INDEX, the planner writes an activity ID.
// The client turns those back into text from its own copies of the same lists.
// If the two copies drift, index 3 silently renders a different (but still safe,
// pre-authored) sentence, and an unknown activity id silently falls back to a
// default schedule. Both are invisible in a build — so we pin them here.
//
// These read source text rather than importing the modules: SimpleUI/NpcActivities
// pull in three.js + the DOM (no place in a node test), and the functions live in a
// separate build root. Text parity is exact and dependency-free.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

/** Pull the `NAME ... = [ ... ];` (or `] as const;`) array literal and return
 *  the single-quoted strings inside it, in order. Anchors on the `= [`
 *  assignment on the same line as NAME, so a mere mention of NAME in a comment
 *  is not matched — and stops at the array's own closer, so an `as const`
 *  ending can't make the lazy match run into the NEXT array. */
function arrayStringsAfter(src: string, name: string): string[] {
  const m = src.match(new RegExp(`${name}[^\\n]*=\\s*\\[([\\s\\S]*?)\\](?:\\s*as const)?;`));
  if (!m) throw new Error(`array literal not found: ${name}`);
  return [...m[1].matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((s) => s[1]);
}

describe('Island Times notice templates stay in lockstep', () => {
  const client = arrayStringsAfter(read('SimpleUI.ts'), 'NOTICE_TEMPLATES');
  const server = arrayStringsAfter(read('functions/src/analyst.ts'), 'NOTICE_TEMPLATES');

  test('client has a non-trivial list', () => {
    expect(client.length).toBeGreaterThan(1);
  });

  test('client and server template lists are byte-identical, in order', () => {
    // Exact + ordered: the server writes the INDEX, so order is the contract.
    expect(client).toEqual(server);
  });
});

describe('day-event ids stay in lockstep', () => {
  // Server pool: EVENT_IDS in the planner. Client whitelist+labels: EVENT_META
  // keys in WorldState (also the Island Times masthead strings).
  const serverEvents = arrayStringsAfter(read('functions/src/npcPlanner.ts'), 'EVENT_IDS');
  const clientEvents = [...read('WorldState.ts').matchAll(/^ {2}([a-z_]+): \{ label:/gm)].map(
    (m) => m[1],
  );

  test('both sides list the same events', () => {
    expect(serverEvents.length).toBeGreaterThan(1);
    expect(new Set(clientEvents)).toEqual(new Set(serverEvents));
  });
});

describe('persona ids stay in lockstep', () => {
  // Planner pool vs the client's AI_NPC_DEFS ids (drift is fail-safe but silent:
  // a renamed persona would just stop receiving daily plans, with no signal).
  const plannerIds = arrayStringsAfter(read('functions/src/npcPlanner.ts'), 'PERSONA_IDS');
  const chatSrc = read('NpcChat.ts');
  const defsStart = chatSrc.indexOf('AI_NPC_DEFS');
  const clientIds = [...chatSrc.slice(defsStart).matchAll(/id: '([a-z_]+)'/g)].map((m) => m[1]);

  test('planner personas match the client cast', () => {
    expect(plannerIds.length).toBeGreaterThan(10);
    expect(new Set(clientIds)).toEqual(new Set(plannerIds));
  });
});

describe('NPC activity ids stay in lockstep', () => {
  // Client canonical set: the keys of ACTIVITY_DEFS (each entry is `  key: { label:`).
  const defsSrc = read('NpcActivities.ts');
  const defsBlockStart = defsSrc.indexOf('ACTIVITY_DEFS');
  const clientIds = [
    ...defsSrc.slice(defsBlockStart).matchAll(/^\s{2}([a-z_]+):\s*\{\s*label:/gm),
  ].map((m) => m[1]);
  // Server pool: the ACTIVITY_IDS string array in the planner.
  const serverIds = arrayStringsAfter(read('functions/src/npcPlanner.ts'), 'ACTIVITY_IDS');

  test('both sides list the same activities', () => {
    expect(clientIds.length).toBeGreaterThan(1);
    expect(new Set(clientIds)).toEqual(new Set(serverIds));
  });
});
