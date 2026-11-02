#!/usr/bin/env node
// moderate.mjs — the server moderation that gates npcChat
// (functions/lib/moderation.js) as a JSON-lines filter for the Python evals.
//
//   stdin : {"id": "...", "text": "..."}   one case per line
//   stdout: {"id": "...", "input_blocked": bool, "output_rejected": bool,
//            "published_unchanged": bool}   one verdict per line, same order
//
// input_blocked   containsSlur(text): npcChat refuses the visitor's message.
// output_rejected scrubReply(text) === '': npcChat drops the model's reply.
// published_unchanged  the reply would be published exactly as written
//                 (scrubReply only collapses whitespace and caps 400 chars).
//
// `node moderate.mjs --terms` prints {"count": n, "terms": [...]} instead, so
// the eval can build its obfuscated positives from the live list in memory:
// no listed term is written to the repo or printed by the suite. Verdicts
// never echo the text back.

import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const { containsSlur, scrubReply, SLURS } = require(join(ROOT, 'functions', 'lib', 'moderation.js'));

if (process.argv.includes('--terms')) {
  process.stdout.write(`${JSON.stringify({ count: SLURS.length, terms: SLURS })}\n`);
} else {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let n = 0;
  for await (const line of rl) {
    if (!line.trim()) continue;
    n += 1;
    let item;
    try {
      item = JSON.parse(line);
    } catch {
      console.error(`moderate.mjs: line ${n} is not JSON`);
      process.exit(2);
    }
    const text = String(item.text ?? '');
    const published = scrubReply(text);
    process.stdout.write(
      `${JSON.stringify({
        id: item.id,
        input_blocked: containsSlur(text),
        output_rejected: published === '',
        published_unchanged: published === text.replace(/\s+/g, ' ').trim().slice(0, 400),
      })}\n`,
    );
  }
}
