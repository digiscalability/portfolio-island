'use strict';
// lock-census (static, no browser): every literal source-file read in
// test/*.test.ts, with the test's owner and the code's owner from the plan's
// testOwnership tables, and every cross-package read classified by its rule:
//   rule 1  MOVE   a structural lock on another stage-1 package's code (A, B, D, E)
//   rule 2  LOOSEN a lock on C's code (C has no stage-1 PR)
//   rule 3  SCAN   a content scan that stays with its owner and binds everyone
//   rule 5  STAYS  a lock on code no package edits this round
// It then compares the rule-1 moves with the plan's relocation table.
//
//   npm run probe -- lock-census [--ref <git ref>] [--table-ref <git ref>] [--out <dir>]
//
// A read is a call of readFileSync, or of a helper whose first parameter flows
// into readFileSync (src, stripped, read, method, fn, scan, ...), whose path
// argument resolves to a repo file: a string literal, join(..., 'literal'), a
// const bound to one, or an element of an array iterated by for...of, .map,
// .flatMap, .forEach or test.each (a "list" read). Literals that never reach a
// reader (a bundle file name handed to a plugin, say) are not reads.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const lib = require('./lib.cjs');

// ------------------------------------------------------------- ownership
const TEST_OWNERS = {
  A: 'simpleInputManager keyGuards inventoryPanel framing profileSync mainLocks compassArrow inputLook orbitCamera guide',
  B: 'visualPolish avatarPose swimStroke oceanDive npcActivities livingNpcs buildPlots economy sceneLocks gameSceneSeed limbLayers juice npcMotion coins',
  C: 'tierParity staticFreeze oreNodes celInk amenities grassClump grassMarshal islandRadius oceanScale surfBands terrainNoise waveMirror radiusUnits cloudFormations deliverySystem worldLook signPainter drawNeutral',
  D: 'onboarding frontDoorPolish mobileHud hireCard panelManager claimsPanels claimsSurfaces reducedMotion npcFallback audioControl audioManager chat speech moderation clientModeration htmlEscape uiLocks tokens motionRules a11yPanels',
  E: 'feelRegressions serviceWorker functionsPure promptBuilders serverModeration rendererLocks fxBudget perfLevers lockOwnership',
};
// PR #20 (main 58c8849) added two tests no package owns; nobody edits them.
const UNOWNED_TESTS = ['databaseRules', 'securityHeaders'];
const testOwner = (file) => {
  const base = path.basename(file).replace(/\.test\.ts$/, '');
  for (const [p, list] of Object.entries(TEST_OWNERS)) if (list.split(' ').includes(base)) return p;
  return UNOWNED_TESTS.includes(base) ? 'unowned' : '?';
};

const CODE_OWNERS = {
  E: ['SimpleRenderer.ts', 'FxBudget.ts', 'tools/perf-gate.cjs', 'tools/ux-probes/', 'package.json', 'package-lock.json', 'test/helpers/headlessDom.ts', 'test/helpers/networkStubs.ts'],
  A: ['main-simple.ts', 'SimpleInputManager.ts', 'OrbitCamera.ts', 'keyGuards.ts', 'Compass.ts', 'Guide.ts', 'GuideCard.ts'],
  B: ['GameScene.ts', 'SimplePlayer.ts', 'Juice.ts', 'NpcActivities.ts', 'worldBenches.ts', 'HudLabels.ts', 'Multiplayer.ts', 'test/golden/seedDraws.json'],
  D: ['SimpleUI.ts', 'style.css', 'PanelManager.ts', 'index.html', 'Share.ts', 'Passport.ts', 'Districts.ts', 'Boards.ts', 'NpcChat.ts', 'ReceptionDesk.ts', 'Analytics.ts', 'CREDITS.md', 'README.md', 'ui/', 'public/hire.html', 'public/404.html', 'public/fonts/'],
  C: ['Island.ts', 'EnvironmentCycle.ts', 'CelLook.ts', 'Materials.ts', 'Zones.ts', 'TextureGenerator.ts', 'Mailbox.ts', 'Traffic.ts', 'SignPainter.ts', 'public/assets/models/overrides.json', 'public/assets/panels/chocomate.webp'],
};
const codeOwner = (rel) => {
  for (const [p, list] of Object.entries(CODE_OWNERS)) if (list.some((x) => (x.endsWith('/') ? rel.startsWith(x) : rel === x))) return p;
  return 'unowned';
};
const STAGE1 = ['A', 'B', 'D', 'E'];

// Rule 3: content scans stay with their owners (testOwnership rule 3, plus
// serverModeration's AI_NPC_DEFS order read, named by critique-r2).
const CONTENT_SCANS = [
  { test: 'claimsPanels.test.ts', kind: 'list', why: "the banned-word scan over SimpleUI, main-simple, ReceptionDesk and NpcChat (FILES)" },
  { test: 'claimsSurfaces.test.ts', why: 'the public-surface claims, including NPC_SITES in Island.ts' },
  { test: 'radiusUnits.test.ts', why: "the bare-radian ban over Island, GameScene and NpcActivities" },
  { test: 'livingNpcs.test.ts', why: "client/server list equality (SimpleUI NOTICE_TEMPLATES, NpcChat, WorldState)" },
  { test: 'serverModeration.test.ts', files: ['NpcChat.ts'], why: 'the persona roster order (AI_NPC_DEFS), critique-r2 minor' },
];
const contentScan = (testFile, rel, kind) =>
  CONTENT_SCANS.find((c) => c.test === testFile && (!c.files || c.files.includes(rel)) && (!c.kind || c.kind === kind)) || null;

// The plan's relocation table: origin test() line on main -> destination.
const PLAN_TABLE = {
  'onboarding.test.ts': { A: [66, 73, 79, 91, 102, 113, 122, 142, 169, 210, 285, 295, 312], B: [102] },
  'frontDoorPolish.test.ts': { A: [95, 111, 258, 297, 307, 367, 376, 387, 482, 504, 538] },
  'mobileHud.test.ts': { A: [70, 107] },
  'reducedMotion.test.ts': { A: [69, 100, 104], B: [82] },
  'claimsPanels.test.ts': { A: [80] },
  'audioControl.test.ts': { A: [147, 361, 375] },
  'inventoryPanel.test.ts': { D: [42, 88] },
  'feelRegressions.test.ts': { A: [378, 396, 430, 472, 497, 528], B: [191], D: [517] },
  'oceanDive.test.ts': { A: [282] },
  'visualPolish.test.ts': { A: [109, 286, 317, 493, 551, 572, 735, 774, 880, 1075], D: [446, 463, 478, 535, 721, 986, 999, 1013], E: [572, 774, 846, 903] },
};

// ----------------------------------------------------------------- lexer
const KEYWORDS_BEFORE_REGEX = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);

function lex(src) {
  const toks = [];
  let i = 0;
  let line = 1;
  const n = src.length;
  const push = (t) => toks.push(t);
  const prevSig = () => toks[toks.length - 1];
  const regexAllowed = () => {
    const p = prevSig();
    if (!p) return true;
    if (p.type === 'num' || p.type === 'str' || p.type === 'tpl') return false;
    if (p.type === 'id') return KEYWORDS_BEFORE_REGEX.has(p.value);
    if (p.type === 'p') return !(p.value === ')' || p.value === ']' || p.value === '}');
    return true;
  };
  while (i < n) {
    const c = src[i];
    if (c === '\n') {
      line++;
      i++;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] === '\n') line++;
        i++;
      }
      i += 2;
      continue;
    }
    if (c === "'" || c === '"') {
      const q = c;
      const l0 = line;
      let j = i + 1;
      let v = '';
      while (j < n && src[j] !== q) {
        if (src[j] === '\\') {
          v += src[j + 1];
          j += 2;
          continue;
        }
        if (src[j] === '\n') line++;
        v += src[j++];
      }
      push({ type: 'str', value: v, line: l0, pos: i });
      i = j + 1;
      continue;
    }
    if (c === '`') {
      // Template literal: a plain one is a string; one with ${} is opaque,
      // but its expressions are lexed so braces stay balanced.
      const l0 = line;
      let j = i + 1;
      let v = '';
      let dynamic = false;
      while (j < n && src[j] !== '`') {
        if (src[j] === '\\') {
          v += src[j + 1];
          j += 2;
          continue;
        }
        if (src[j] === '$' && src[j + 1] === '{') {
          dynamic = true;
          let depth = 1;
          j += 2;
          while (j < n && depth > 0) {
            if (src[j] === '{') depth++;
            else if (src[j] === '}') depth--;
            else if (src[j] === '\n') line++;
            else if (src[j] === "'" || src[j] === '"' || src[j] === '`') {
              const q = src[j];
              j++;
              while (j < n && src[j] !== q) {
                if (src[j] === '\\') j++;
                j++;
              }
            }
            j++;
          }
          continue;
        }
        if (src[j] === '\n') line++;
        v += src[j++];
      }
      push({ type: dynamic ? 'tpl' : 'str', value: dynamic ? null : v, line: l0, pos: i });
      i = j + 1;
      continue;
    }
    if (c === '/' && regexAllowed()) {
      let j = i + 1;
      let inClass = false;
      while (j < n) {
        if (src[j] === '\\') {
          j += 2;
          continue;
        }
        if (src[j] === '[') inClass = true;
        else if (src[j] === ']') inClass = false;
        else if (src[j] === '/' && !inClass) break;
        else if (src[j] === '\n') break;
        j++;
      }
      j++;
      while (j < n && /[a-z]/i.test(src[j])) j++;
      push({ type: 're', line, pos: i });
      i = j;
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i + 1;
      while (j < n && /[\w$]/.test(src[j])) j++;
      push({ type: 'id', value: src.slice(i, j), line, pos: i });
      i = j;
      continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i + 1;
      while (j < n && /[\w.]/.test(src[j])) j++;
      push({ type: 'num', line, pos: i });
      i = j;
      continue;
    }
    if (c === '=' && src[i + 1] === '>') {
      push({ type: 'p', value: '=>', line, pos: i });
      i += 2;
      continue;
    }
    if (c === '.' && src[i + 1] === '.' && src[i + 2] === '.') {
      push({ type: 'p', value: '...', line, pos: i });
      i += 3;
      continue;
    }
    push({ type: 'p', value: c, line, pos: i });
    i++;
  }
  return toks;
}

/** Index of the token closing the bracket opened at toks[i]. */
function matchClose(toks, i) {
  const open = toks[i].value;
  const close = open === '(' ? ')' : open === '[' ? ']' : '}';
  let d = 0;
  for (let k = i; k < toks.length; k++) {
    const t = toks[k];
    if (t.type !== 'p') continue;
    if (t.value === '(' || t.value === '[' || t.value === '{') d++;
    else if (t.value === ')' || t.value === ']' || t.value === '}') {
      d--;
      if (d === 0) return t.value === close ? k : k;
    }
  }
  return toks.length - 1;
}

/** Split call arguments (between parens at i..j) at top-level commas. */
function args(toks, i, j) {
  const out = [];
  let cur = [];
  let d = 0;
  for (let k = i + 1; k < j; k++) {
    const t = toks[k];
    if (t.type === 'p' && '([{'.includes(t.value)) d++;
    if (t.type === 'p' && ')]}'.includes(t.value)) d--;
    if (t.type === 'p' && t.value === ',' && d === 0) {
      out.push(cur);
      cur = [];
      continue;
    }
    cur.push(k);
  }
  if (cur.length) out.push(cur);
  return out;
}

// ------------------------------------------------------------- analysis
function analyze(file, src, exists) {
  const toks = lex(src);
  const isP = (k, v) => toks[k] && toks[k].type === 'p' && toks[k].value === v;
  const isId = (k, v) => toks[k] && toks[k].type === 'id' && (v === undefined || toks[k].value === v);

  // Scopes: test()/it() blocks (incl. test.each(...)(...)), and describe().
  const blocks = [];
  for (let k = 0; k < toks.length; k++) {
    if (!isId(k) || !['test', 'it', 'describe'].includes(toks[k].value)) continue;
    if (k > 0 && isP(k - 1, '.')) continue;
    let c = k + 1;
    let each = false;
    while (isP(c, '.') && isId(c + 1)) {
      if (toks[c + 1].value === 'each') each = true;
      c += 2;
    }
    if (!isP(c, '(')) continue;
    let open = c;
    let close = matchClose(toks, open);
    let eachArr = null;
    if (each) {
      eachArr = { open, close };
      if (!isP(close + 1, '(')) continue;
      open = close + 1;
      close = matchClose(toks, open);
    }
    const a = args(toks, open, close);
    const first = a[0] && a[0].length === 1 ? toks[a[0][0]] : null;
    const name = first && first.type === 'str' ? first.value : first && first.type === 'id' ? `(${first.value})` : '(dynamic)';
    blocks.push({ kind: toks[k].value === 'describe' ? 'describe' : 'test', line: toks[k].line, name, from: open, to: close, eachArr });
  }
  const tests = blocks.filter((b) => b.kind === 'test');
  const describes = blocks.filter((b) => b.kind === 'describe');
  const testAt = (k) => tests.filter((b) => b.from <= k && k <= b.to).sort((a, b) => b.from - a.from)[0] || null;
  const describeAt = (k) => describes.filter((b) => b.from <= k && k <= b.to).sort((a, b) => b.from - a.from)[0] || null;

  // Function definitions and which are readers (first param reaches readFileSync).
  const defs = [];
  for (let k = 0; k < toks.length; k++) {
    if (isId(k, 'function') && isId(k + 1) && isP(k + 2, '(')) {
      const pc = matchClose(toks, k + 2);
      const param = isId(k + 3) ? toks[k + 3].value : null;
      let b = pc + 1;
      while (b < toks.length && !isP(b, '{')) b++;
      defs.push({ name: toks[k + 1].value, param, from: b, to: matchClose(toks, b) });
    }
    if ((isId(k, 'const') || isId(k, 'let')) && isId(k + 1) && (isP(k + 2, '=') || isP(k + 2, ':'))) {
      let e = k + 2;
      if (isP(e, ':')) {
        while (e < toks.length && !isP(e, '=')) {
          if (isP(e, '(') || isP(e, '[') || isP(e, '{')) e = matchClose(toks, e);
          e++;
        }
      }
      let s = e + 1;
      if (isId(s, 'function')) s++;
      if (isId(s, 'async')) s++;
      let param = null;
      let arrow = -1;
      if (isP(s, '(')) {
        const pc = matchClose(toks, s);
        param = isId(s + 1) ? toks[s + 1].value : null;
        arrow = isP(pc + 1, '=>') || isP(pc + 1, ':') ? pc + 1 : isP(pc + 1, '{') ? pc : -1;
        if (isP(arrow, ':')) {
          let q = arrow;
          while (q < toks.length && !isP(q, '=>') && !isP(q, '{')) q++;
          arrow = q;
        }
      } else if (isId(s) && isP(s + 1, '=>')) {
        param = toks[s].value;
        arrow = s + 1;
      }
      if (arrow < 0) continue;
      let b = isP(arrow, '=>') ? arrow + 1 : arrow;
      let to;
      if (isP(b, '{')) to = matchClose(toks, b);
      else {
        to = b;
        let d = 0;
        for (; to < toks.length; to++) {
          const t = toks[to];
          if (t.type === 'p' && '([{'.includes(t.value)) d++;
          if (t.type === 'p' && ')]}'.includes(t.value)) {
            if (d === 0) break;
            d--;
          }
          if (d === 0 && t.type === 'p' && (t.value === ';' || t.value === ',')) break;
          if (d === 0 && toks[to + 1] && toks[to + 1].line > t.line && isId(to + 1) && ['const', 'let', 'function', 'describe', 'test', 'it'].includes(toks[to + 1].value)) break;
        }
      }
      defs.push({ name: toks[k + 1].value, param, from: b, to });
    }
  }
  const readers = new Set(['readFileSync']);
  const callArgsOf = (k) => (isP(k + 1, '(') ? args(toks, k + 1, matchClose(toks, k + 1)) : null);
  for (let pass = 0; pass < 4; pass++) {
    for (const d of defs) {
      if (!d.param || readers.has(d.name)) continue;
      for (let k = d.from; k <= d.to; k++) {
        if (!isId(k) || !readers.has(toks[k].value) || (k > 0 && isP(k - 1, '.') && toks[k].value !== 'readFileSync')) continue;
        const a = callArgsOf(k);
        if (a && a[0] && a[0].some((x) => isId(x, d.param))) {
          readers.add(d.name);
          break;
        }
      }
    }
  }

  // Bindings for resolution: const X = 'lit' | [lits] (as const).
  const constStr = new Map();
  const constArr = new Map();
  for (let k = 0; k < toks.length; k++) {
    if (!(isId(k, 'const') || isId(k, 'let')) || !isId(k + 1) || !isP(k + 2, '=')) continue;
    const v = k + 3;
    if (toks[v] && toks[v].type === 'str' && (isP(v + 1, ';') || isId(v + 1, 'as'))) constStr.set(toks[k + 1].value, toks[v].value);
    if (isP(v, '[')) {
      const e = matchClose(toks, v);
      const lits = [];
      let ok = true;
      for (const a of args(toks, v, e)) {
        if (a.length === 1 && toks[a[0]].type === 'str') lits.push(toks[a[0]].value);
        else ok = false;
      }
      if (ok && lits.length) constArr.set(toks[k + 1].value, lits);
    }
  }
  const arrLits = (k0, k1) => {
    const lits = [];
    for (const a of args(toks, k0, k1)) if (a.length === 1 && toks[a[0]].type === 'str') lits.push(toks[a[0]].value);
    return lits;
  };
  /** What an identifier at k iterates over, if it is a loop or callback variable. */
  const iterSource = (name, k) => {
    // for (const name of X) / for (const name of [..])
    for (let q = k; q >= 0; q--) {
      if (isId(q, 'for') && isP(q + 1, '(') && (isId(q + 2, 'const') || isId(q + 2, 'let')) && isId(q + 3, name) && isId(q + 4, 'of')) {
        const close = matchClose(toks, q + 1);
        if (close < k || true) {
          if (isId(q + 5) && constArr.has(toks[q + 5].value)) return constArr.get(toks[q + 5].value);
          if (isP(q + 5, '[')) return arrLits(q + 5, matchClose(toks, q + 5));
        }
      }
      // X.map((name) => ...) / X.flatMap(name => ...) / .forEach / .filter / .some / .every
      if (isP(q, '.') && isId(q + 1) && ['map', 'flatMap', 'forEach', 'filter', 'some', 'every'].includes(toks[q + 1].value) && isP(q + 2, '(')) {
        const pIdx = isP(q + 3, '(') ? q + 4 : q + 3;
        if (isId(pIdx, name)) {
          const recv = q - 1;
          if (isId(recv) && constArr.has(toks[recv].value)) return constArr.get(toks[recv].value);
          if (isP(recv, ']')) {
            let o = recv;
            let d = 0;
            for (; o >= 0; o--) {
              if (isP(o, ']')) d++;
              if (isP(o, '[')) {
                d--;
                if (d === 0) break;
              }
            }
            return arrLits(o, recv);
          }
        }
      }
    }
    // test.each(X)('...', (name) => ...)
    for (const b of tests) {
      if (!b.eachArr || k < b.from || k > b.to) continue;
      const a = args(toks, b.eachArr.open, b.eachArr.close);
      if (a[0] && a[0].length === 1 && isId(a[0][0]) && constArr.has(toks[a[0][0]].value)) return constArr.get(toks[a[0][0]].value);
      if (a[0] && isP(a[0][0], '[')) return arrLits(a[0][0], matchClose(toks, a[0][0]));
    }
    return null;
  };
  /** Resolve a reader's path argument to { files, kind }. */
  const resolveArg = (idxs, k) => {
    if (!idxs || !idxs.length) return null;
    const t0 = toks[idxs[0]];
    if (idxs.length === 1 && t0.type === 'str') return { files: [t0.value], kind: 'direct' };
    // join(..., 'lit') / resolve(...) / path.join(...)
    const strs = idxs.map((x) => toks[x]).filter((t) => t.type === 'str');
    if (strs.length && idxs.some((x) => isId(x, 'join') || isId(x, 'resolve'))) return { files: [strs[strs.length - 1].value], kind: 'direct' };
    const ids = idxs.filter((x) => isId(x) && !['join', 'resolve', 'process', 'cwd', 'path', 'ROOT', '__dirname', 'root', 'REPO'].includes(toks[x].value));
    const last = ids.length ? toks[ids[ids.length - 1]].value : null;
    if (last) {
      if (constStr.has(last)) return { files: [constStr.get(last)], kind: 'direct' };
      const it = iterSource(last, k);
      if (it) return { files: it, kind: 'list' };
    }
    return null;
  };

  // Read sites.
  const sites = [];
  const inOwnDef = (k) => defs.some((d) => readers.has(d.name) && d.from <= k && k <= d.to);
  for (let k = 0; k < toks.length; k++) {
    if (!isId(k) || !readers.has(toks[k].value)) continue;
    if (isP(k - 1, '.') && toks[k].value !== 'readFileSync') continue;
    // A reader passed by name to an array method: FILES.flatMap(scan)
    if (isP(k - 1, '(') && isId(k - 2) && ['map', 'flatMap', 'forEach'].includes(toks[k - 2].value) && isP(k + 1, ')')) {
      const recv = k - 4;
      const list = isId(recv) && constArr.has(toks[recv].value) ? constArr.get(toks[recv].value) : null;
      if (list) sites.push({ k, line: toks[k].line, files: list, kind: 'list', reader: toks[k].value });
      continue;
    }
    const a = callArgsOf(k);
    if (!a) continue;
    if (inOwnDef(k)) {
      // Inside a reader's own body: the parameter, not a literal, is read.
      const d = defs.find((x) => readers.has(x.name) && x.from <= k && k <= x.to);
      if (a[0] && a[0].some((x) => isId(x, d.param))) continue;
    }
    const r = resolveArg(a[0], k);
    if (!r) continue;
    sites.push({ k, line: toks[k].line, files: r.files, kind: r.kind, reader: toks[k].value });
  }

  // Attribution: in a test -> that test; else the binding it feeds, used by tests.
  const rows = [];
  const bindingAt = (k) => {
    // const NAME = <...reader(...)...> on the statement containing k
    for (let q = k; q >= 0 && q > k - 40; q--) {
      if ((isId(q, 'const') || isId(q, 'let')) && isId(q + 1) && isP(q + 2, '=')) return { name: toks[q + 1].value, at: q };
      if (isP(q, ';') || isP(q, '{') || isP(q, '}')) return null;
    }
    return null;
  };
  for (const s of sites) {
    const files = s.files.filter((f) => exists(f));
    if (!files.length) continue;
    const t = testAt(s.k);
    if (t) {
      for (const f of files) rows.push({ line: t.line, test: t.name, file: f, kind: s.kind, scope: 'test', at: s.line, reader: s.reader });
      continue;
    }
    const d = describeAt(s.k);
    const bind = bindingAt(s.k);
    let attributed = false;
    if (bind) {
      const scopeFrom = d ? d.from : 0;
      const scopeTo = d ? d.to : toks.length - 1;
      for (const tb of tests) {
        if (tb.from < bind.at || tb.from < scopeFrom || tb.to > scopeTo) continue;
        let uses = false;
        for (let q = tb.from; q <= tb.to; q++) if (isId(q, bind.name) && !isP(q - 1, '.')) uses = true;
        if (uses) {
          attributed = true;
          for (const f of files) rows.push({ line: tb.line, test: tb.name, file: f, kind: s.kind, scope: d ? 'describe' : 'file', at: s.line, via: bind.name, reader: s.reader });
        }
      }
    }
    if (!attributed) for (const f of files) rows.push({ line: d ? d.line : s.line, test: d ? `describe: ${d.name}` : '(file level)', file: f, kind: s.kind, scope: d ? 'describe' : 'file', at: s.line, reader: s.reader });
  }
  // One row per (test line, file, kind).
  const seen = new Set();
  return rows.filter((r) => {
    const key = `${r.line}|${r.file}|${r.kind}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ----------------------------------------------------------------- sources
function treeReader(ref) {
  if (!ref) {
    const root = lib.REPO;
    const testDir = path.join(root, 'test');
    return {
      label: 'working tree',
      tests: fs.readdirSync(testDir).filter((f) => f.endsWith('.test.ts')).sort(),
      read: (rel) => fs.readFileSync(path.join(root, rel), 'utf8'),
      exists: (rel) => fs.existsSync(path.join(root, rel)) && fs.statSync(path.join(root, rel)).isFile(),
    };
  }
  const git = (...a) => execFileSync('git', a, { cwd: lib.REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const all = new Set(git('ls-tree', '-r', '--name-only', ref).split('\n').filter(Boolean));
  return {
    label: `git ${ref} (${git('rev-parse', '--short', ref).trim()})`,
    tests: [...all].filter((f) => /^test\/[^/]+\.test\.ts$/.test(f)).map((f) => f.slice(5)).sort(),
    read: (rel) => git('show', `${ref}:${rel}`),
    exists: (rel) => all.has(rel),
  };
}

function census(tree) {
  const reads = [];
  for (const tf of tree.tests) {
    const rows = analyze(tf, tree.read(`test/${tf}`), (f) => tree.exists(f));
    const owner = testOwner(tf);
    for (const r of rows) {
      const co = codeOwner(r.file);
      let rule;
      if (r.file === `test/${tf}`) continue;
      if (owner === co) rule = 'own';
      else if (owner === 'unowned') rule = 'unowned test (PR #20)';
      else if (co === 'unowned') rule = 'rule 5: unowned code, stays';
      else if (contentScan(tf, r.file, r.kind)) rule = 'rule 3: content scan, stays';
      else if (co === 'C') rule = 'rule 2: C code, loosen in place';
      else if (STAGE1.includes(co)) rule = `rule 1: move to ${co}`;
      else rule = '?';
      reads.push({ testFile: tf, testOwner: owner, line: r.line, test: r.test, file: r.file, codeOwner: co, kind: r.kind, scope: r.scope, rule });
    }
  }
  return reads;
}

function testNamesAt(tree, tf, lines) {
  let src;
  try {
    src = tree.read(`test/${tf}`).split('\n');
  } catch (e) {
    return null;
  }
  const out = {};
  for (const l of lines) {
    const m = /(?:test|it)(?:\.each\(.*?\))?\(\s*(['"`])(.*?)\1/.exec(src[l - 1] || '');
    out[l] = m ? m[2] : null;
  }
  return out;
}

async function run({ args }) {
  const tree = treeReader(args.ref || null);
  const reads = census(tree);
  const moves = {};
  for (const r of reads.filter((x) => x.rule.startsWith('rule 1'))) {
    const dest = r.codeOwner;
    ((moves[r.testFile] = moves[r.testFile] || {})[dest] = moves[r.testFile][dest] || new Set()).add(`${r.line}|${r.test}`);
  }
  // Compare with the plan's table by test name (lines resolved on the table ref).
  let tableRef = args.tableRef || 'origin/main';
  let tableTree = null;
  try {
    tableTree = treeReader(tableRef);
  } catch (e) {
    tableRef = null;
  }
  const planRows = [];
  for (const [tf, dests] of Object.entries(PLAN_TABLE)) {
    for (const [dest, lines] of Object.entries(dests)) {
      const names = tableTree ? testNamesAt(tableTree, tf, lines) : null;
      for (const l of lines) planRows.push({ testFile: tf, dest, line: l, test: names ? names[l] : null });
    }
  }
  const have = new Set();
  for (const [tf, dests] of Object.entries(moves)) for (const [dest, set] of Object.entries(dests)) for (const e of set) have.add(`${tf}|${dest}|${e.split('|').slice(1).join('|')}`);
  const haveLines = new Set();
  for (const [tf, dests] of Object.entries(moves)) for (const [dest, set] of Object.entries(dests)) for (const e of set) haveLines.add(`${tf}|${dest}|${e.split('|')[0]}`);
  const byName = planRows.every((p) => p.test);
  const pending = [];
  const done = [];
  for (const p of planRows) {
    const hit = byName ? have.has(`${p.testFile}|${p.dest}|${p.test}`) : haveLines.has(`${p.testFile}|${p.dest}|${p.line}`);
    (hit ? pending : done).push(p);
  }
  const planKeys = new Set(planRows.map((p) => (byName ? `${p.testFile}|${p.dest}|${p.test}` : `${p.testFile}|${p.dest}|${p.line}`)));
  const extra = [];
  for (const [tf, dests] of Object.entries(moves))
    for (const [dest, set] of Object.entries(dests))
      for (const e of set) {
        const [line, ...nm] = e.split('|');
        const key = byName ? `${tf}|${dest}|${nm.join('|')}` : `${tf}|${dest}|${line}`;
        if (!planKeys.has(key)) extra.push({ testFile: tf, dest, line: Number(line), test: nm.join('|') });
      }
  const table = {};
  for (const [tf, dests] of Object.entries(moves)) {
    table[tf] = {};
    for (const [dest, set] of Object.entries(dests)) table[tf][dest] = [...set].map((e) => Number(e.split('|')[0])).sort((a, b) => a - b).filter((x, i, a) => a.indexOf(x) === i);
  }
  const byOwner = {};
  for (const r of reads.filter((x) => x.rule !== 'own')) {
    const o = (byOwner[r.testOwner] = byOwner[r.testOwner] || {});
    o[r.rule] = (o[r.rule] || 0) + 1;
  }
  const feel = reads.filter((r) => r.testFile === 'feelRegressions.test.ts' && ['main-simple.ts', 'OrbitCamera.ts', 'GameScene.ts', 'SimpleUI.ts'].includes(r.file));
  const checks = [
    { name: 'feelRegressions.test.ts reads no main-simple.ts, OrbitCamera.ts, GameScene.ts or SimpleUI.ts (EL)', pass: feel.length === 0, value: feel.map((r) => `${r.line} ${r.file}`), expect: 'none' },
    { name: 'every rule-1 cross-package read is in the plan relocation table', pass: extra.length === 0, value: extra.map((x) => `${x.testFile}:${x.line} -> ${x.dest} (${x.test})`), expect: 'none' },
  ];
  if (!args.ref && !extra.length) {
    // A table row whose read is gone has moved; list them so a relocation PR can show its moves.
  }
  const out = {
    tree: tree.label,
    tableRef: tableRef ? tableTree.label : 'unresolved (lines compared)',
    comparedBy: byName ? 'test name' : 'test line',
    relocationTable: table,
    planRowsPending: pending.length,
    planRowsDone: done.map((p) => `${p.testFile}:${p.line} -> ${p.dest}${p.test ? ` (${p.test})` : ''}`),
    reproducesPlanTable: done.length === 0 && extra.length === 0,
    extraMoves: extra,
    summaryByTestOwner: byOwner,
    contentScans: CONTENT_SCANS,
    unownedTests: reads.filter((r) => r.testOwner === 'unowned').map((r) => `${r.testFile}:${r.line} ${r.file} (${r.codeOwner})`),
    reads,
  };
  const text = [`lock-census on ${tree.label}; table ${out.tableRef}, compared by ${out.comparedBy}`];
  for (const [tf, dests] of Object.entries(table).sort()) text.push(`  ${tf} (${testOwner(tf)}) -> ${Object.entries(dests).map(([d, ls]) => `${d}: ${ls.join(', ')}`).join(' | ')}`);
  text.push(`  plan rows still pending: ${pending.length}; moved already: ${done.length}; reads not in the table: ${extra.length}`);
  for (const d of out.planRowsDone) text.push(`    moved: ${d}`);
  process.stdout.write(text.join('\n') + '\n');
  return { checks, data: out };
}

module.exports = {
  probe: { static: true, item: 'EL, AL, BL, DL (E7 later)', title: 'every literal source read in test/*.test.ts, owners and rules, vs the relocation table', run },
  analyze,
  census,
  treeReader,
  testOwner,
  codeOwner,
};
