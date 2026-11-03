#!/usr/bin/env node
// dump_personas.mjs — write the evals fixtures from the BUILT Cloud Functions,
// so the Python suites test the code that ships, not a copy of it.
//
// Order (the CI offline-evals job runs exactly this):
//   1. cd functions && npm ci && npm run build     -> functions/lib/*.js
//   2. node evals/tools/dump_personas.mjs          -> evals/fixtures/generated/*.json
//   3. cd evals && uv run pytest -m offline
//
// Reads functions/lib (personas, constants, plannerPrompt, npcPlanner, tts) and,
// for the public-surface claims scan, the string literals of the client files
// that carry public copy (parsed with the TypeScript compiler, not a regex).
// Writes only evals/fixtures/generated/ (git-ignored) and prints no prompt text.

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const TOOLS = dirname(fileURLToPath(import.meta.url));
const EVALS = dirname(TOOLS);
const ROOT = dirname(EVALS);
const SRC = join(ROOT, 'functions', 'src');
const LIB = join(ROOT, 'functions', 'lib');
const OUT = join(EVALS, 'fixtures', 'generated');

/** Client files whose string literals are public copy (claims scan). */
const UI_SOURCES = ['SimpleUI.ts', 'Share.ts', 'api/z.js'];

/** The functions modules the fixtures come from. */
const MODULES = ['personas', 'constants', 'plannerPrompt', 'npcPlanner', 'tts', 'moderation'];

/** A fixed Melbourne day, so the rumor of the day (and every prompt) is
 *  reproducible from run to run. */
const DAY_KEY = '2026-11-02';

function fail(message) {
  console.error(`dump_personas: ${message}`);
  process.exit(1);
}

/** sha256 of a text file with line endings folded to LF, so a Windows
 *  checkout (core.autocrlf) and a Linux one hash the same. */
function textSha(path) {
  const text = readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

// 1. The build must be newer than the source it came from.
for (const m of MODULES) {
  const src = join(SRC, `${m}.ts`);
  const lib = join(LIB, `${m}.js`);
  let libTime;
  try {
    libTime = statSync(lib).mtimeMs;
  } catch {
    fail(`functions/lib/${m}.js is missing: run "cd functions && npm ci && npm run build" first.`);
  }
  if (statSync(src).mtimeMs > libTime) {
    fail(`functions/src/${m}.ts is newer than its build: run "cd functions && npm run build" first.`);
  }
}

const lib = (m) => require(join(LIB, `${m}.js`));
const personas = lib('personas');
const constants = lib('constants');
const planner = lib('plannerPrompt');
const { PLANNER_POOLS } = lib('npcPlanner');
const { MODEL_SUPPORTS_AUDIO_TAGS } = lib('tts');

// 2. The cast, both prompt variants, and the context npcChat appends.
const castFor = (audioTags) =>
  Object.fromEntries([...personas.buildPersonas(audioTags)].map(([id, p]) => [id, p]));

const rumorIndex = constants.rumorIndexForDay(DAY_KEY);
const rumor = constants.RUMORS[rumorIndex];
// A representative world/island: the director's mood, the planner's event, and
// planner tasks for the villagers the live suites talk to.
const sampleWorld = {
  mood: 'calm',
  npcPlan: {
    event: 'market_day',
    assignments: {
      storyteller: 'plaza_gather',
      elder_sage: 'muse',
      cartographer: 'study',
      guard: 'patrol',
      village_baker: 'market_visit',
    },
  },
};
// Over-long values, to check dayContext's clamps.
const longWorld = {
  mood: 'm'.repeat(64),
  npcPlan: { event: 'e'.repeat(64), assignments: { guard: 'a'.repeat(64) } },
};

const personasFixture = {
  npc_roles: personas.NPC_ROLES,
  audio_tags_in_production: MODEL_SUPPORTS_AUDIO_TAGS,
  personas: { audio_tags_off: castFor(false), audio_tags_on: castFor(true) },
  island_context: personas.ISLAND_CONTEXT,
  about_abbas: personas.ABOUT_ABBAS,
  rumors: constants.RUMORS,
  chat: {
    model: constants.NPC_MODEL,
    max_tokens: constants.NPC_MAX_TOKENS,
    msg_max_chars: constants.NPC_MSG_MAX_CHARS,
  },
  analyst_model: constants.ANALYST_MODEL,
  day_context: {
    day_key: DAY_KEY,
    rumor_index: rumorIndex,
    sample_world: sampleWorld,
    by_persona: Object.fromEntries(
      personas.NPC_ROLES.map((r) => [r.id, personas.dayContext(sampleWorld, r.id, rumor)]),
    ),
    no_world: personas.dayContext(null, 'storyteller', rumor),
    clamp_probe: personas.dayContext(longWorld, 'guard', rumor),
  },
};

// 3. The planner: the exact prompt for a fixed state, and its pools.
const sampleState = {
  online: 2,
  guestbookCount: 31,
  racersTotal: 12,
  recentMoods: ['calm', 'proud', 'calm'],
  prev: { activeDevices: 9, racePBsNew: 1 },
};
const plannerFixture = {
  model: constants.NPC_MODEL,
  max_tokens: constants.PLANNER_MAX_TOKENS,
  system: planner.PLANNER_SYSTEM,
  pools: PLANNER_POOLS,
  sample_state: sampleState,
  user: planner.plannerUserTurn(PLANNER_POOLS, sampleState),
};

// 4. String literals of the client files that carry public copy.
let ts;
for (const base of [join(ROOT, 'functions', 'node_modules'), join(ROOT, 'node_modules')]) {
  try {
    ts = require(join(base, 'typescript'));
    break;
  } catch {
    /* try the next install */
  }
}
if (!ts) fail('the TypeScript compiler is missing: run "cd functions && npm ci" first.');

function stringsOf(rel) {
  const path = join(ROOT, rel);
  const text = readFileSync(path, 'utf8');
  const kind = rel.endsWith('.js') ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, kind);
  const strings = [];
  const push = (node, value) => {
    if (!value.trim()) return;
    const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
    strings.push({ line, text: value });
  };
  const visit = (node) => {
    // Module specifiers are paths, not copy.
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      push(node, node.text);
      return;
    }
    if (ts.isTemplateExpression(node)) {
      // The literal parts of a template, joined where the ${...} holes were.
      const parts = [node.head.text, ...node.templateSpans.map((s) => s.literal.text)];
      push(node, parts.join(' … '));
      for (const span of node.templateSpans) visit(span.expression);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { sha256: textSha(path), strings };
}

const surfacesFixture = {
  typescript: ts.version,
  files: Object.fromEntries(UI_SOURCES.map((rel) => [rel, stringsOf(rel)])),
};

// 5. Provenance, for the suite's freshness check.
const metaFixture = {
  day_key: DAY_KEY,
  node: process.version,
  src_sha256: Object.fromEntries(
    MODULES.map((m) => [`functions/src/${m}.ts`, textSha(join(SRC, `${m}.ts`))]),
  ),
  ui_sha256: Object.fromEntries(UI_SOURCES.map((rel) => [rel, surfacesFixture.files[rel].sha256])),
};

mkdirSync(OUT, { recursive: true });
const write = (name, data) => writeFileSync(join(OUT, name), `${JSON.stringify(data, null, 2)}\n`);
write('personas.json', personasFixture);
write('planner.json', plannerFixture);
write('surfaces.json', surfacesFixture);
write('meta.json', metaFixture);

const nStrings = Object.values(surfacesFixture.files).reduce((n, f) => n + f.strings.length, 0);
console.log(
  `dump_personas: ${personas.NPC_ROLES.length} personas, ${PLANNER_POOLS.personas.length} planner personas, ` +
    `${nStrings} UI strings from ${UI_SOURCES.length} files -> ${relative(ROOT, OUT).replace(/\\/g, '/')}/`,
);
