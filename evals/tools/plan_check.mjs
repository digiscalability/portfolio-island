#!/usr/bin/env node
// plan_check.mjs — the planner's real reply validator (parsePlanReply in
// functions/lib/plannerPrompt.js, over PLANNER_POOLS in functions/lib/npcPlanner.js)
// as a JSON-lines filter for the Python evals. It mirrors what npcPlanner
// writes to world/island/npcPlan for a given model reply.
//
//   stdin : {"id": "...", "text": "<raw model reply>", "fallback_event": "quiet_day"}
//   stdout: {"id": "...", "status": "plan" | "no_json" | "invalid_json",
//            "source": "llm" | "fallback", "plan": {"event": ..., "assignments": {...}}}
//
// source "llm" means npcPlanner would publish the model's assignments; any
// other outcome keeps the deterministic fallback (event only, NPCs on their
// default schedules).

import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const LIB = join(dirname(dirname(dirname(fileURLToPath(import.meta.url)))), 'functions', 'lib');
const { parsePlanReply } = require(join(LIB, 'plannerPrompt.js'));
const { PLANNER_POOLS } = require(join(LIB, 'npcPlanner.js'));

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
let n = 0;
for await (const line of rl) {
  if (!line.trim()) continue;
  n += 1;
  let item;
  try {
    item = JSON.parse(line);
  } catch {
    console.error(`plan_check.mjs: line ${n} is not JSON`);
    process.exit(2);
  }
  const fallbackEvent = String(item.fallback_event ?? PLANNER_POOLS.events[0]);
  const fallback = { event: fallbackEvent, assignments: {} };
  let verdict;
  try {
    const parsed = parsePlanReply(String(item.text ?? ''), PLANNER_POOLS, fallbackEvent);
    if (!parsed) {
      verdict = { status: 'no_json', source: 'fallback', plan: fallback };
    } else if (Object.keys(parsed.assignments).length) {
      verdict = { status: 'plan', source: 'llm', plan: parsed };
    } else {
      verdict = { status: 'plan', source: 'fallback', plan: { event: parsed.event, assignments: {} } };
    }
  } catch {
    verdict = { status: 'invalid_json', source: 'fallback', plan: fallback };
  }
  process.stdout.write(`${JSON.stringify({ id: item.id, ...verdict })}\n`);
}
