'use strict';
// lock-census (static, no browser): every literal source-file read and every
// repo-module import in test/*.test.ts, with the test's owner and the code's
// owner from tools/owners.json, and every cross-package read classified:
//   own       the test's package owns the code it reads
//   rule 5    STAYS    code no package edits (owners.json unownedCode, or unlisted)
//   rule 3    CONTRACT a cross-file check on owners.json's allow-list; it stays
//                      with its owner and binds every package
//   rule 1/2  PENDING  a lock on another package's code: a pending move to the
//                      code's owner (rule 2 is a B or D test reading C's code)
//
//   npm run probe -- lock-census [--owner A|B|C|D|E] [--ref <git ref>] [--stage 1|2] [--owners <file>] [--out <dir>]
//
// --owner <pkg> exits 1 while that package's tests hold a pending move; with
// no --owner every package is checked, and every test file needs an owner.
// This replaces plan-r3's tools/lockmap.mjs. --stage 1 labels rule 2 the way
// stage 1 did ('C code, loosen in place'); from stage 2 on it is a pending
// move to C.
//
// A read is a call of readFileSync, or of a helper whose first parameter flows
// into readFileSync (src, stripped, read, method, fn, scan, ...), whose path
// argument resolves to a repo file: a string literal, join(..., 'literal'), a
// const bound to one, or an element of an array iterated by for...of, .map,
// .flatMap, .forEach or test.each (a "list" read). Literals that never reach a
// reader (a bundle file name handed to a plugin, say) are not reads.
//
// An import is a static, dynamic, require() or vi.mock() import of a repo
// module. `import type` (and an import whose every name is a type) carries no
// code, and test/helpers/* are shared helpers, so both are skipped. A static
// import is attributed to every test that uses one of its bindings.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const lib = require('./lib.cjs');

// ------------------------------------------------------------- ownership
const OWNERS_FILE = path.join(lib.REPO, 'tools', 'owners.json');
let OWNERS = null;

function loadOwners(file) {
  let o;
  try {
    o = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new lib.HarnessError(`cannot read the ownership table ${file}: ${String(e).slice(0, 160)}`);
  }
  if (!o || !o.packages) throw new lib.HarnessError(`${file} has no packages table`);
  return o;
}
const owners = () => (OWNERS = OWNERS || loadOwners(OWNERS_FILE));

const testBase = (file) => path.basename(file).replace(/\.test\.ts$/, '');
/** The package that owns test/<file> (a base name or a path), or '?'. */
const testOwner = (file) => {
  const base = testBase(file);
  for (const [p, d] of Object.entries(owners().packages)) if ((d.tests || []).includes(base)) return p;
  return '?';
};
/** The package that owns a repo path, or 'unowned'. Exact entries beat folders; the longest folder wins. */
const codeOwner = (rel) => {
  const o = owners();
  if (/^test\/[^/]+\.test\.ts$/.test(rel)) {
    const t = testOwner(rel);
    return t === '?' ? 'unowned' : t;
  }
  for (const [p, d] of Object.entries(o.packages)) if ((d.code || []).includes(rel) || (d.testFiles || []).includes(rel)) return p;
  if ((o.unownedCode || []).includes(rel)) return 'unowned';
  let best = null;
  const consider = (owner, entry) => {
    if (entry.endsWith('/') && rel.startsWith(entry) && (!best || entry.length > best.entry.length)) best = { owner, entry };
  };
  for (const [p, d] of Object.entries(o.packages)) for (const e of [...(d.code || []), ...(d.testFiles || [])]) consider(p, e);
  for (const e of o.unownedCode || []) consider('unowned', e);
  return best ? best.owner : 'unowned';
};
/** The owners.json contract check that allows this read or import, if any. */
const contractCheck = (testFile, rel, how) =>
  (owners().contractChecks || []).find((c) => c.test === testBase(testFile) && (c.via || 'read') === (how === 'import' ? 'import' : 'read') && (c.files || []).includes(rel)) || null;
const PACKAGES = () => Object.keys(owners().packages);

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
  for (const r of rows) r.how = 'read';

  // Imports: an import of another package's module is a read of that module.
  const resolveModule = (spec) => {
    if (!/^\.\.?\//.test(spec)) return null; // a package from node_modules, not repo code
    const rel = path.posix.normalize(path.posix.join('test', spec));
    if (rel.startsWith('..')) return null;
    for (const ext of ['', '.ts', '.js', '.cjs', '.mjs', '.json', '/index.ts']) if (exists(rel + ext)) return rel + ext;
    return null;
  };
  const imports = [];
  for (let k = 0; k < toks.length; k++) {
    // vi.mock('x') / vi.doMock('x')
    if (isId(k, 'vi') && isP(k + 1, '.') && isId(k + 2) && ['mock', 'doMock'].includes(toks[k + 2].value) && isP(k + 3, '(') && toks[k + 4] && toks[k + 4].type === 'str') {
      imports.push({ k, line: toks[k].line, spec: toks[k + 4].value, bindings: [], kind: 'mock' });
      continue;
    }
    // createRequire(...)('x')
    if (isId(k, 'createRequire') && isP(k + 1, '(')) {
      const c = matchClose(toks, k + 1);
      if (isP(c + 1, '(') && toks[c + 2] && toks[c + 2].type === 'str') {
        const b = isP(k - 1, '=') && isId(k - 2) ? [toks[k - 2].value] : [];
        imports.push({ k, line: toks[k].line, spec: toks[c + 2].value, bindings: b, kind: 'require' });
      }
      continue;
    }
    // require('x')
    if (isId(k, 'require') && !isP(k - 1, '.') && isP(k + 1, '(') && toks[k + 2] && toks[k + 2].type === 'str') {
      const b = isP(k - 1, '=') && isId(k - 2) ? [toks[k - 2].value] : [];
      imports.push({ k, line: toks[k].line, spec: toks[k + 2].value, bindings: b, kind: 'require' });
      continue;
    }
    if (!(isId(k, 'import') || isId(k, 'export')) || isP(k - 1, '.')) continue;
    const isImport = toks[k].value === 'import';
    // import('x'), possibly inside a test
    if (isImport && isP(k + 1, '(')) {
      if (toks[k + 2] && toks[k + 2].type === 'str') imports.push({ k, line: toks[k].line, spec: toks[k + 2].value, bindings: [], kind: 'dynamic' });
      continue;
    }
    // import 'x'
    if (isImport && toks[k + 1] && toks[k + 1].type === 'str') {
      imports.push({ k, line: toks[k].line, spec: toks[k + 1].value, bindings: [], kind: 'side-effect' });
      continue;
    }
    // Only the import and re-export statement forms from here on.
    if (!isImport && !(isP(k + 1, '{') || isP(k + 1, '*'))) continue;
    if (isImport && !(isId(k + 1) || isP(k + 1, '{') || isP(k + 1, '*'))) continue;
    let q = k + 1;
    let typeOnly = false;
    if (isId(q, 'type') && !isP(q + 1, ',') && !isId(q + 1, 'from') && !isP(q + 1, '=')) {
      typeOnly = true;
      q++;
    }
    const bindings = [];
    let named = 0;
    let namedTypes = 0;
    let other = 0;
    let ok = false;
    for (; q < toks.length; q++) {
      if (isId(q, 'from')) {
        ok = true;
        break;
      }
      if (isP(q, ';') || (toks[q].line > toks[k].line + 40)) break;
      if (isP(q, '{')) {
        const e = matchClose(toks, q);
        for (const a of args(toks, q, e)) {
          const ids = a.filter((x) => isId(x)).map((x) => toks[x].value);
          if (!ids.length) continue;
          named++;
          const isType = ids[0] === 'type' && ids.length > 1;
          if (isType) namedTypes++;
          bindings.push(ids[ids.length - 1]);
        }
        q = e;
        continue;
      }
      if (isP(q, '*') && isId(q + 1, 'as') && isId(q + 2)) {
        bindings.push(toks[q + 2].value);
        other++;
        q += 2;
        continue;
      }
      if (isImport && isId(q) && toks[q].value !== 'type') {
        bindings.push(toks[q].value);
        other++;
      }
    }
    if (!ok || !toks[q + 1] || toks[q + 1].type !== 'str') continue;
    if (typeOnly || (named > 0 && namedTypes === named && other === 0)) continue;
    imports.push({ k, line: toks[k].line, spec: toks[q + 1].value, bindings, kind: isImport ? 'import' : 'export-from' });
  }
  for (const im of imports) {
    const file = resolveModule(im.spec);
    if (!file || file.startsWith('test/helpers/')) continue;
    const kind = im.kind === 'mock' ? 'mock' : 'import';
    const t = testAt(im.k);
    if (t) {
      rows.push({ line: t.line, test: t.name, file, kind, scope: 'test', at: im.line, how: 'import' });
      continue;
    }
    const users = im.bindings.length
      ? tests.filter((tb) => {
          for (let q = tb.from; q <= tb.to; q++) if (isId(q) && im.bindings.includes(toks[q].value) && !isP(q - 1, '.')) return true;
          return false;
        })
      : [];
    if (users.length) for (const tb of users) rows.push({ line: tb.line, test: tb.name, file, kind, scope: 'file', at: im.line, how: 'import' });
    else rows.push({ line: im.line, test: '(file level)', file, kind, scope: 'file', at: im.line, how: 'import' });
  }

  // One row per (test line, file, kind, how).
  const seen = new Set();
  return rows.filter((r) => {
    const key = `${r.line}|${r.file}|${r.kind}|${r.how}`;
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

/** The rule for one read or import in test/<tf>. */
function ruleFor(tf, r, stage) {
  const owner = testOwner(tf);
  const co = codeOwner(r.file);
  if (owner === co) return { rule: 'own' };
  if (owner === '?') return { rule: 'test without an owner in tools/owners.json', unownedTest: true };
  if (co === 'unowned') return { rule: 'rule 5: unowned code, stays' };
  const cc = contractCheck(tf, r.file, r.how);
  if (cc) return { rule: 'rule 3: contract check, stays', contract: cc.where || cc.why };
  const ruleNo = co === 'C' && (owner === 'B' || owner === 'D') ? 2 : 1;
  if (stage === 1) return { rule: ruleNo === 2 ? 'rule 2: C code, loosen in place' : `rule 1: move to ${co}`, pending: co };
  return { rule: `rule ${ruleNo}: pending move to ${co}`, pending: co };
}

function census(tree, stage = 2) {
  const reads = [];
  for (const tf of tree.tests) {
    const rows = analyze(tf, tree.read(`test/${tf}`), (f) => tree.exists(f));
    const owner = testOwner(tf);
    for (const r of rows) {
      if (r.file === `test/${tf}`) continue;
      const rule = ruleFor(tf, r, stage);
      reads.push({ testFile: tf, testOwner: owner, line: r.line, test: r.test, file: r.file, codeOwner: codeOwner(r.file), how: r.how, kind: r.kind, scope: r.scope, ...(r.via ? { binding: r.via } : {}), ...rule });
    }
  }
  return reads;
}

const fmtRow = (r) => `${r.testFile}:${r.line} '${r.test}' ${r.how === 'import' ? (r.kind === 'mock' ? 'mocks' : 'imports') : 'reads'} ${r.file} -> pending move to ${r.pending}`;

async function run({ args }) {
  if (args.owners && args.owners !== true) OWNERS = loadOwners(path.resolve(String(args.owners)));
  const stage = args.stage === undefined ? 2 : Number(args.stage);
  if (stage !== 1 && stage !== 2) throw new lib.HarnessError(`--stage takes 1 or 2, got ${args.stage}`);
  if (args.owner === true) throw new lib.HarnessError(`--owner takes a package: ${PACKAGES().join(', ')}`);
  const only = args.owner ? String(args.owner).toUpperCase() : null;
  if (only && !PACKAGES().includes(only)) throw new lib.HarnessError(`--owner takes one of ${PACKAGES().join(', ')}, got ${args.owner}`);
  const tree = treeReader(args.ref || null);
  const reads = census(tree, stage);
  const pkgs = only ? [only] : PACKAGES();
  const pending = reads.filter((r) => r.pending && pkgs.includes(r.testOwner));
  const unownedTests = [...new Set(tree.tests.filter((tf) => testOwner(tf) === '?'))];
  const byOwner = {};
  for (const r of reads.filter((x) => x.rule !== 'own')) {
    const o = (byOwner[r.testOwner] = byOwner[r.testOwner] || {});
    o[r.rule] = (o[r.rule] || 0) + 1;
  }
  const pendingBy = {};
  for (const r of pending) {
    const k = `${r.testOwner} -> ${r.pending}`;
    (pendingBy[k] = pendingBy[k] || []).push(fmtRow(r));
  }
  const checks = pkgs.map((p) => {
    const mine = pending.filter((r) => r.testOwner === p);
    return {
      name: `${p}: reads and imports of another package's code outside the owners.json allow-list`,
      pass: mine.length === 0,
      value: mine.length ? mine.map(fmtRow) : 'none',
      expect: 'none',
    };
  });
  if (!only) checks.push({ name: 'every test file has an owner in tools/owners.json', pass: unownedTests.length === 0, value: unownedTests.length ? unownedTests : 'all owned', expect: 'all owned' });
  const out = {
    tree: tree.label,
    stage,
    owner: only || 'all',
    ownersFile: (args.owners && args.owners !== true ? path.resolve(String(args.owners)) : OWNERS_FILE).replace(/\\/g, '/'),
    pendingMoves: pending.length,
    pendingBy,
    summaryByTestOwner: byOwner,
    contractChecks: owners().contractChecks || [],
    unownedTests,
    reads,
  };
  const text = [`lock-census on ${tree.label} (stage ${stage}${only ? `, --owner ${only}` : ''})`];
  for (const p of pkgs) {
    const mine = pending.filter((r) => r.testOwner === p);
    text.push(`  ${p}: ${mine.length ? `${mine.length} pending move${mine.length === 1 ? '' : 's'}` : 'clean'}`);
    for (const r of mine) text.push(`    ${fmtRow(r)}`);
  }
  if (!only && unownedTests.length) text.push(`  tests without an owner: ${unownedTests.join(', ')}`);
  process.stdout.write(text.join('\n') + '\n');
  return { checks, data: out };
}

module.exports = {
  probe: { static: true, item: 'CO-E1 (EL, AL, BL, DL in stage 1)', title: 'every source read and import in test/*.test.ts, its owners and rule; --owner <pkg> lists pending moves', run },
  analyze,
  census,
  treeReader,
  testOwner,
  codeOwner,
  contractCheck,
  loadOwners,
};
