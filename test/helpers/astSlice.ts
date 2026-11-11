// Read-only AST slices for lock tests (testOwnership rule 2): a lock pins the
// exact body of a method or the exact statement that holds a marker, found
// through the TypeScript parser, never a fixed character window such as
// slice(i, i + 300). Stage-2 tests of any package may import this helper; the
// stage-1 file-local bodyOf helpers stay where they are.
//
//   methodBody('GameScene.ts', 'GameScene.warmInterior')   the method's { ... }
//   functionBody('Compass.ts', 'compassBearing')           a function's body
//   statementAt('main-simple.ts', 'warmInterior()', { within: 'SimpleApp.afterIntro' })
//   statementAt(file, marker, { kind: 'if' })               the enclosing if
//
// Paths resolve against the repo root (process.cwd() under vitest); CRLF is
// normalised. Nothing here writes.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';

/** The file's text, CRLF normalised (a Windows checkout may hold CRLF). */
export function source(file: string): string {
  return readFileSync(resolve(process.cwd(), file), 'utf8').replace(/\r\n/g, '\n');
}

function kindOf(file: string): ts.ScriptKind {
  if (/\.tsx$/.test(file)) return ts.ScriptKind.TSX;
  if (/\.(c|m)?js$/.test(file)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

/** The parsed file (setParentNodes on, so a node can walk up). */
export function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(file, source(file), ts.ScriptTarget.Latest, true, kindOf(file));
}

/** Text with line and block comments removed (string contents kept). */
export function stripComments(text: string): string {
  const sf = ts.createSourceFile('x.ts', text, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  const cuts: Array<[number, number]> = [];
  const seen = new Set<number>();
  const take = (pos: number) => {
    for (const r of [
      ...(ts.getLeadingCommentRanges(text, pos) || []),
      ...(ts.getTrailingCommentRanges(text, pos) || []),
    ]) {
      if (seen.has(r.pos)) continue;
      seen.add(r.pos);
      cuts.push([r.pos, r.end]);
    }
  };
  const walk = (n: ts.Node) => {
    take(n.getFullStart());
    take(n.getEnd());
    n.forEachChild(walk);
  };
  walk(sf);
  take(sf.endOfFileToken.getFullStart());
  cuts.sort((a, b) => a[0] - b[0]);
  let out = '';
  let at = 0;
  for (const [a, b] of cuts) {
    if (a < at) continue;
    out += text.slice(at, a);
    at = b;
  }
  return out + text.slice(at);
}

const nameOf = (n: ts.Node & { name?: ts.Node }): string | null => {
  const nm = n.name;
  if (!nm) return null;
  if (ts.isIdentifier(nm) || ts.isPrivateIdentifier(nm) || ts.isStringLiteral(nm)) return nm.text;
  return null;
};

function findClass(sf: ts.SourceFile, cls: string): ts.ClassLikeDeclaration | null {
  let hit: ts.ClassLikeDeclaration | null = null;
  const walk = (n: ts.Node) => {
    if (hit) return;
    if ((ts.isClassDeclaration(n) || ts.isClassExpression(n)) && nameOf(n) === cls) hit = n;
    else if (
      ts.isVariableDeclaration(n) &&
      nameOf(n) === cls &&
      n.initializer &&
      ts.isClassExpression(n.initializer)
    )
      hit = n.initializer;
    else n.forEachChild(walk);
  };
  walk(sf);
  return hit;
}

const bodyOfFunctionLike = (n: ts.Node | undefined): ts.Node | null => {
  if (!n) return null;
  if (
    ts.isArrowFunction(n) ||
    ts.isFunctionExpression(n) ||
    ts.isFunctionDeclaration(n) ||
    ts.isMethodDeclaration(n)
  )
    return n.body || null;
  return null;
};

/** The member node 'Class.member' (a method, accessor, constructor or arrow property). */
export function member(file: string, path: string, sf: ts.SourceFile = parse(file)): ts.Node {
  const [cls, name] = path.split('.');
  if (!cls || !name) throw new Error(`astSlice: '${path}' is not 'Class.member'`);
  const c = findClass(sf, cls);
  if (!c) throw new Error(`astSlice: no class ${cls} in ${file}`);
  const hits = c.members.filter((m) =>
    name === 'constructor'
      ? ts.isConstructorDeclaration(m)
      : nameOf(m as ts.Node & { name?: ts.Node }) === name,
  );
  // Overloads: the declaration that has a body.
  const withBody = hits.find(
    (m) => (m as ts.FunctionLikeDeclaration).body || ts.isPropertyDeclaration(m),
  );
  const m = withBody || hits[0];
  if (!m) throw new Error(`astSlice: no member ${path} in ${file}`);
  return m;
}

/** The exact body of a method, accessor, constructor or arrow-function property, braces included. */
export function methodBody(file: string, path: string): string {
  const m = member(file, path);
  const sf = m.getSourceFile();
  let body: ts.Node | null = null;
  if (ts.isPropertyDeclaration(m)) body = bodyOfFunctionLike(m.initializer);
  else body = (m as ts.FunctionLikeDeclaration).body || null;
  if (!body) throw new Error(`astSlice: ${path} in ${file} has no body`);
  return body.getText(sf);
}

/** The body of a function declaration, or of a const bound to an arrow or function expression. */
export function functionBody(file: string, name: string): string {
  const sf = parse(file);
  let body: ts.Node | null = null;
  const walk = (n: ts.Node) => {
    if (body) return;
    if (ts.isFunctionDeclaration(n) && nameOf(n) === name && n.body) body = n.body;
    else if (ts.isVariableDeclaration(n) && nameOf(n) === name)
      body = bodyOfFunctionLike(n.initializer);
    if (!body) n.forEachChild(walk);
  };
  walk(sf);
  if (!body) throw new Error(`astSlice: no function ${name} in ${file}`);
  return (body as ts.Node).getText(sf);
}

const STATEMENTS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.VariableStatement,
  ts.SyntaxKind.ExpressionStatement,
  ts.SyntaxKind.IfStatement,
  ts.SyntaxKind.ReturnStatement,
  ts.SyntaxKind.ThrowStatement,
  ts.SyntaxKind.ForStatement,
  ts.SyntaxKind.ForOfStatement,
  ts.SyntaxKind.ForInStatement,
  ts.SyntaxKind.WhileStatement,
  ts.SyntaxKind.DoStatement,
  ts.SyntaxKind.SwitchStatement,
  ts.SyntaxKind.TryStatement,
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.ClassDeclaration,
  ts.SyntaxKind.MethodDeclaration,
  ts.SyntaxKind.PropertyDeclaration,
]);

/** The deepest node whose own text (not leading trivia) holds pos, or null when pos is in a comment. */
function leafAt(root: ts.Node, sf: ts.SourceFile, pos: number): ts.Node | null {
  let n: ts.Node = root;
  for (;;) {
    const next = n.getChildren(sf).find((c) => c.getStart(sf) <= pos && pos < c.getEnd());
    if (!next)
      return n.getChildCount(sf) === 0 && n.getStart(sf) <= pos && pos < n.getEnd() ? n : null;
    n = next;
  }
}

/**
 * The statement that holds `marker` in code (occurrences inside comments are
 * skipped). within: 'Class.member' or a function name narrows the search;
 * kind 'if' returns the enclosing IfStatement instead; nth picks a later hit.
 */
export function statementAt(
  file: string,
  marker: string,
  opts: { within?: string; kind?: 'statement' | 'if'; nth?: number } = {},
): string {
  const sf = parse(file);
  const text = sf.getFullText();
  let root: ts.Node = sf;
  if (opts.within) {
    if (opts.within.includes('.')) root = member(file, opts.within, sf);
    else {
      let fn: ts.Node | null = null;
      const walk = (n: ts.Node) => {
        if (fn) return;
        if (
          (ts.isFunctionDeclaration(n) || ts.isVariableDeclaration(n)) &&
          nameOf(n) === opts.within
        )
          fn = n;
        else n.forEachChild(walk);
      };
      walk(sf);
      if (!fn) throw new Error(`astSlice: no function ${opts.within} in ${file}`);
      root = fn;
    }
  }
  const lo = root.getStart(sf);
  const hi = root.getEnd();
  let seen = 0;
  for (let at = text.indexOf(marker, lo); at >= 0 && at < hi; at = text.indexOf(marker, at + 1)) {
    const leaf = leafAt(root, sf, at);
    if (!leaf) continue; // inside a comment
    if (seen++ < (opts.nth || 0)) continue;
    for (let n: ts.Node | undefined = leaf; n; n = n.parent) {
      const covers = n.getStart(sf) <= at && at + marker.length <= n.getEnd();
      if (!covers) continue;
      if (opts.kind === 'if' ? ts.isIfStatement(n) : STATEMENTS.has(n.kind)) return n.getText(sf);
      if (n === root) break;
    }
    throw new Error(
      `astSlice: '${marker}' in ${file} is not inside ${opts.kind === 'if' ? 'an if' : 'a statement'}`,
    );
  }
  throw new Error(
    `astSlice: no '${marker}' in code of ${file}${opts.within ? ` (within ${opts.within})` : ''}`,
  );
}
