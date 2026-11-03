// @vitest-environment happy-dom
//
// WORLD-LOOK LOCKS: package C's own suite for the code it owns (Island,
// Zones, Mailbox, EnvironmentCycle, Traffic, CelLook). UX plan testOwnership,
// rule 2: a lock lives with the code it pins.
//
// Until stage 2 these sat in B's and D's suites. B and D delete their copies
// in wave 1 (CO-B2, CO-D3) and C0 re-adds them here under their original test
// names, so lock-census can match each one:
//   - visualPolish.test.ts (B): 20 tests. Where one also read B's files
//     (GameScene, SimplePlayer, RaceSystem), only its C lines moved.
//   - oceanDive.test.ts (B): the water ceiling's Island line.
//   - reducedMotion.test.ts (D): rain, the mailbox glow (the Mailbox line;
//     the minimap half stays with D) and the dead Island.update().
//   - frontDoorPolish.test.ts (D): setInkVisible (behavioural) and the dead
//     cel shadow patch.
// Every original assertion is kept. What changed is the slicing: the fixed
// character windows, the `indexOf('};')` ends and the brace counters are now
// TypeScript-AST slices (a method or declaration, or the statement or block
// that holds a marker), so code added around a pinned line can never slide it
// out of view. A few tests gained an assertion the AST makes cheap; each one
// says so where it is added.
//
// C's own stage-2 locks follow the adopted ones, at the end of the file.
//
// Comments are stripped before matching (from the AST's comment ranges), so a
// lock can never be satisfied by its own explanatory prose.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as THREE from 'three';
import * as ts from 'typescript';
import { describe, expect, test } from 'vitest';

import { addGroupHulls, setInkVisible } from '../CelLook';

// ---- AST slicing ------------------------------------------------------------
// File-local until E's test/helpers/astSlice.ts lands (CO-E1), same contract:
// read-only, a method body or a statement by name.

interface Parsed {
  text: string;
  sf: ts.SourceFile;
  /** Every comment's [start, end), sorted. */
  comments: Array<[number, number]>;
}

const parsed = new Map<string, Parsed>();

/** A source file with LF line ends, its AST and its comment ranges. */
const parse = (file: string): Parsed => {
  const hit = parsed.get(file);
  if (hit) return hit;
  const text = readFileSync(join(process.cwd(), file), 'utf8').replace(/\r\n/g, '\n');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const seen = new Set<number>();
  const comments: Array<[number, number]> = [];
  const add = (ranges: ts.CommentRange[] | undefined): void => {
    for (const r of ranges ?? []) {
      if (seen.has(r.pos)) continue;
      seen.add(r.pos);
      comments.push([r.pos, r.end]);
    }
  };
  const visit = (n: ts.Node): void => {
    add(ts.getLeadingCommentRanges(text, n.pos));
    add(ts.getTrailingCommentRanges(text, n.pos));
    for (const c of n.getChildren(sf)) visit(c);
  };
  visit(sf);
  comments.sort((a, b) => a[0] - b[0]);
  const p = { text, sf, comments };
  parsed.set(file, p);
  return p;
};

/** Source text of [start, end) with every comment removed. */
const codeOf = (p: Parsed, start: number, end: number): string => {
  let out = '';
  let at = start;
  for (const [cs, ce] of p.comments) {
    if (ce <= at || cs >= end) continue;
    out += p.text.slice(at, Math.max(at, cs));
    at = Math.max(at, ce);
  }
  return out + p.text.slice(at, end);
};

/** The node's own text, comments removed. */
const code = (file: string, n: ts.Node): string => {
  const p = parse(file);
  return codeOf(p, n.getStart(p.sf), n.getEnd());
};

/** The whole file, comments removed (the old suites' src()/stripped()). */
const stripped = (file: string): string => {
  const p = parse(file);
  return codeOf(p, 0, p.text.length);
};

/** The whole file as written (comments kept), for checks on literal text. */
const raw = (file: string): string => parse(file).text;

const nameOf = (n: ts.Node): string | null => {
  if (
    (ts.isMethodDeclaration(n) ||
      ts.isFunctionDeclaration(n) ||
      ts.isVariableDeclaration(n) ||
      ts.isPropertyDeclaration(n) ||
      ts.isGetAccessorDeclaration(n)) &&
    n.name &&
    (ts.isIdentifier(n.name) || ts.isPrivateIdentifier(n.name))
  ) {
    return n.name.text;
  }
  return null;
};

/** The first method, function, property or `const` declaration called `name`. */
const declNode = (file: string, name: string): ts.Node => {
  const p = parse(file);
  let found: ts.Node | null = null;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (nameOf(n) === name) {
      found = n;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(p.sf);
  expect(found, `${name} is not declared in ${file}`).not.toBeNull();
  return found as unknown as ts.Node;
};

/** A declaration's code: a method from its modifiers to its closing brace, or
 *  a `const name = …` from the name to the end of its initializer. */
const decl = (file: string, name: string): string => code(file, declNode(file, name));

/** A class's constructor, comments removed. */
const ctor = (file: string, cls: string): string => {
  const p = parse(file);
  let found: ts.ConstructorDeclaration | null = null;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (ts.isClassDeclaration(n) && n.name?.text === cls) {
      found = (n.members.find(ts.isConstructorDeclaration) as ts.ConstructorDeclaration) ?? null;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(p.sf);
  expect(found, `class ${cls} has no constructor in ${file}`).not.toBeNull();
  return code(file, found as unknown as ts.Node);
};

/** Where `marker` first occurs as code (never inside a comment), from `from`. */
const codeIndex = (p: Parsed, marker: string, from = 0): number => {
  for (let i = p.text.indexOf(marker, from); i !== -1; i = p.text.indexOf(marker, i + 1)) {
    if (!p.comments.some(([s, e]) => i >= s && i < e)) return i;
  }
  return -1;
};

const inStatementList = (n: ts.Node): boolean =>
  ts.isBlock(n) ||
  ts.isSourceFile(n) ||
  ts.isModuleBlock(n) ||
  ts.isCaseClause(n) ||
  ts.isDefaultClause(n);

/** The statement (a member of a block) that holds the marker's first code
 *  occurrence at or after `from`. */
const statementNode = (file: string, marker: string, from = 0): ts.Statement => {
  const p = parse(file);
  const at = codeIndex(p, marker, from);
  expect(at, `${marker} not found in ${file}`).toBeGreaterThan(-1);
  let n: ts.Node = p.sf;
  for (;;) {
    const child = n.getChildren(p.sf).find((c) => c.getStart(p.sf) <= at && at < c.getEnd());
    if (!child) break;
    n = child;
  }
  while (
    n.parent &&
    !(inStatementList(n.parent) && n.getStart(p.sf) <= at && at + marker.length <= n.getEnd())
  ) {
    n = n.parent;
  }
  return n as ts.Statement;
};

/** That statement's code. */
const statement = (file: string, marker: string): string => code(file, statementNode(file, marker));

/** The block that encloses that statement (the old bodyOf on a statement). */
const blockOf = (file: string, marker: string): string =>
  code(file, statementNode(file, marker).parent);

// ---- visualPolish.test.ts (B) ------------------------------------------------

describe('asset grounding — World Law 1 (plumb radial up-axis)', () => {
  test('zone halls derive their basis from the marker plumb, not the slope', () => {
    // The basis is built in Zone's constructor (AST slice; the original read
    // the whole file).
    expect(ctor('Zones.ts', 'Zone')).toContain('this.marker.position.clone().normalize()');
    // The old basis: `const normal = sampled.normal` — the hall then leaned
    // with the hillside (10.2 deg at the welcome hub).
    expect(stripped('Zones.ts')).not.toMatch(/const normal = sampled\.normal/);
  });

  test('stationAt seats AND faces about the same plumb axis', () => {
    const body = decl('Island.ts', 'stationAt');
    expect(body).toContain('seat.position.clone().normalize()');
    // Both writers must take the SAME axis — faceObjectToward premultiplies
    // about whatever it is handed, so a slope normal here re-tilts the seat.
    expect(body).toMatch(/setFromUnitVectors\(new THREE\.Vector3\(0, 1, 0\), plumb\)/);
    expect(body).toMatch(/faceObjectToward\(g, plumb,/);
    expect(body).not.toMatch(/faceObjectToward\(g, seat\.normal/);
  });

  test('benches: one plumb axis for both the seat and the facing', () => {
    const island = stripped('Island.ts');
    expect(island).toContain('const bPlumb = bSampled.position.clone().normalize()');
    expect(island).not.toMatch(/faceObjectToward\(\s*bench,\s*bSampled\.normal/);
    // Added with the AST slice: the bench loop really faces about bPlumb.
    expect(blockOf('Island.ts', 'const bPlumb = bSampled.position')).toMatch(
      /faceObjectToward\(\s*bench,\s*bPlumb,/,
    );
  });

  test('construction blocks stand plumb', () => {
    // The statement itself (the old slice was its whole enclosing block).
    expect(statement('Island.ts', 'block.quaternion.copy')).toContain(
      'sampled.position.clone().normalize()',
    );
  });
});

describe('clouds — stable compositing + non-degenerate shapes', () => {
  test('the depthWrite class is closed at the other flagged sites', () => {
    // Same failure shape as the clouds, found by the follow-up sweep: a
    // transparent material that writes depth is an invisible mask at low
    // opacity and punches holes behind itself at partial opacity. (Mailbox.ts
    // only: the RaceSystem ring stays in B's visualPolish.)
    expect(statement('Mailbox.ts', 'this.glowMaterial = new')).toContain('depthWrite: false');
  });
});

describe('night legibility — lit roads, dark shore and highlands', () => {
  test('pavement LIFTS at night instead of dimming to asphalt', () => {
    const env = stripped('EnvironmentCycle.ts');
    const update = decl('EnvironmentCycle.ts', 'update');
    const drive = statement('EnvironmentCycle.ts', 'for (const p of this.pavementMats)');
    // The ribbon used to be lerped 85% toward 0x3c3f48 while its authored
    // emissive was ~0.019 linear — visually nil. Measured night read was
    // ~2.4:1 against grass, i.e. you could not tell where the path went.
    expect(update).toContain('this._c2.set(0x6a7183)');
    expect(drive).toContain('p.mat.color.copy(p.base).lerp(this._c2, nightF * 0.6)');
    expect(drive).toContain('p.mat.emissiveIntensity = 0.15 + 0.75 * nightF');
    expect(env).not.toContain('lerp(this._c2, nightF * 0.85)');
    // The emissive drive must lerp from the AUTHORED value, not overwrite it.
    expect(drive).toContain('emBase');
  });

  test('the dark patches are authored by scope, not by omission', () => {
    // Beach band and highland shoulder are explicit rejections in the artery
    // lamp pass — Abbas asked to KEEP the dark beaches and mountains.
    const pass = blockOf('Island.ts', 'let lseed = 0x9e3779b1');
    expect(pass).toContain('if (dir.y < Math.sin(0.32)) continue');
    expect(pass).toContain('Island.MAX_DISPLACEMENT * 0.42 * this.reliefScale');
    // The coastal ring is never collected for lighting at all.
    expect(stripped('Island.ts')).toContain('arteryLines.push(');
  });

  test('the artery lamp pass is RNG-SHIELDED (multiplayer world must not re-roll)', () => {
    // three's generateUUID burns 4 Math.random draws per Object3D/Material/
    // Geometry, and buildLamp mints a Group per lamp — upstream of the parked
    // cars, which multiplayer addresses BY INDEX. Verified live: car_0 and
    // house_0 are bit-identical to prod with 28 extra lamps built.
    const seed = statementNode('Island.ts', 'let lseed = 0x9e3779b1');
    const body = code('Island.ts', seed.parent);
    expect(body).toContain('const stashedRandom = Math.random');
    expect(body).toContain('Math.random = stashedRandom');
    expect(body).toMatch(/finally\s*\{/);
    // Added with the AST slice: the restore sits in THAT try's finally.
    const guard = (seed.parent as ts.Block).statements.find(ts.isTryStatement);
    expect(guard?.finallyBlock && code('Island.ts', guard.finallyBlock)).toContain(
      'Math.random = stashedRandom',
    );
  });
});

describe('roads read as roads — kerbs, centre line, and off the camera ray', () => {
  test('cross-section rides in vertex colour, at no allocation cost', () => {
    // A BufferAttribute mints no uuid and PlaneGeometry costs the same 4
    // Math.random draws at any resolution — which is why the road could be
    // detailed WITHOUT the flag-day world re-roll a width rewrite needs.
    const path = decl('Island.ts', 'createStreetPath');
    expect(path).toContain('mat.vertexColors = true');
    expect(path).toMatch(/new THREE\.PlaneGeometry\(planeLen, width, lenSegs, 6\)/);
    expect(path).toContain("geo.setAttribute('color'");
    // Kerb band + body + a centre line on wide roads only (a footpath with a
    // centre line looks like a runway).
    expect(path).toContain('const marked = width >= 1.5');
    expect(path).toContain('shade = 0.6');
  });

  test('widened only as far as the MEASURED clear width allows', () => {
    const island = stripped('Island.ts');
    expect(island).toContain('createStreetPath(boulevardPts, 1.7)');
    expect(island).toContain('createStreetPath(avenue, 1.5)');
    // The keep-out floor must stay 1.9: max(1.7*0.5+0.8, 1.9) = 1.9, so no
    // prop placement shifts and the seeded world is untouched. Anything
    // wider than 1.80u needs the streetDirs endpoint fix first.
    expect(decl('Island.ts', 'createStreetPath')).toContain('Math.max(width * 0.5 + 0.8, 1.9)');
  });

  test('the street network merges into sectors, RNG-shielded', () => {
    const island = stripped('Island.ts');
    expect(island).toContain('private mergeStreetNetwork(');
    expect(island).toContain('this.mergeStreetNetwork(pathGroup)');
    // 8 sectors, not 1 mesh: frustum culling keys off bounding spheres and a
    // single planet-spanning road would never cull. MEASURED at one fixed
    // camera pose: 1390 -> 1243 draw calls (-147) with triangles unchanged.
    const merge = decl('Island.ts', 'mergeStreetNetwork');
    expect(merge).toContain('const SECTORS = 8');
    expect(merge).toContain('street_sector_');
    // The build loop's 401 allocations are seeded-RNG currency and must stay;
    // only the merge tail is new, and it is shielded so its own ~64 draws
    // cannot leak into the world stream.
    expect(blockOf('Island.ts', 'let sseed = 0x51ed270b')).toContain('Math.random = stashedRandom');
    // Contracts the merged mesh must carry forward: its name, the pavement tag
    // and a place in pathGroup (the old regex allowed 80 characters between
    // the tag and the add; the AST asks for the add later in the same block).
    expect(merge).toContain('mesh.name = `street_sector_${b}`');
    const method = declNode('Island.ts', 'mergeStreetNetwork');
    const tag = statementNode(
      'Island.ts',
      'mesh.userData.isPavement = true',
      method.getStart(parse('Island.ts').sf),
    );
    expect(code('Island.ts', tag).startsWith('mesh.userData.isPavement = true')).toBe(true);
    const block = tag.parent as ts.Block;
    expect(block.getEnd()).toBeLessThanOrEqual(method.getEnd()); // still in mergeStreetNetwork
    const later = block.statements.slice(block.statements.indexOf(tag) + 1);
    expect(later.some((s) => code('Island.ts', s).startsWith('pathGroup.add('))).toBe(true);
  });

  test('pavement is opted out of the per-frame camera raycast', () => {
    // OrbitCamera treats an own-property raycast as an explicit opt-out and
    // ray-tests its whole collision list every frame; a ground-hugging
    // ribbon can never block the camera. ~401 sphere tests/frame removed.
    expect(blockOf('Island.ts', 'mesh.userData.isPavement = true')).toContain(
      'mesh.raycast = () => {}',
    );
    // Added with the AST slice: EVERY block that tags pavement (the merged
    // sectors and the per-segment ribbons) opts out, not just the first.
    const p = parse('Island.ts');
    let tagged = 0;
    for (
      let at = codeIndex(p, 'mesh.userData.isPavement = true');
      at !== -1;
      at = codeIndex(p, 'mesh.userData.isPavement = true', at + 1)
    ) {
      tagged++;
      expect(
        code('Island.ts', statementNode('Island.ts', 'mesh.userData.isPavement = true', at).parent),
      ).toContain('mesh.raycast = () => {}');
    }
    expect(tagged).toBeGreaterThanOrEqual(2);
  });
});

describe('ring traffic — alive, but structurally unable to break the world', () => {
  test('cars stand PLUMB and the headlights are fake', () => {
    const t = stripped('Traffic.ts');
    // WORLD LAW 1 — radial up, never the terrain normal (a slope-normal car
    // reads as crashed; the parked fleet already learned this).
    expect(t).toContain('this._up.copy(this._dir)');
    expect(t).toContain('makeBasis(this._right, this._up, this._tan)');
    // No real lights anywhere: MeshBasic never enters the fragment light loop.
    expect(t).toContain('MeshBasicMaterial');
    expect(t).not.toContain('PointLight');
    expect(t).not.toContain('SpotLight');
    // Night-only, on the SHARED cutoff so the day flip stays one relink.
    expect(t).toContain('dayFactor < EXTERIOR_LIGHTS_DAY_CUTOFF');
    expect(t).toContain('this.wash.visible = lit');
    // The yield exists and is directional (ahead only, not merely nearby).
    expect(t).toContain('brakeAt');
  });
});

describe('per-frame sweeps — allocation-free hot paths and instanced fleets', () => {
  test('per-frame hot paths stay allocation-free (sweep round 2)', () => {
    // The per-frame NPC-shadow pass reads a VIEW, not a fresh copy. (Island.ts
    // only: the SimplePlayer and GameScene halves stay in B's visualPolish.)
    expect(decl('Island.ts', 'getNPCInstances')).toContain(
      'public getNPCInstances(): readonly NPC[]',
    );
    expect(stripped('Island.ts')).not.toContain('return this.npcInstances.slice()');
  });

  test('exterior lights + zero-alpha overlays leave the pipeline by day (round 4)', () => {
    // ONE shared cutoff: the light count flips once per dusk/dawn instead of
    // stepping through permutations as per-light curves cross zero.
    // (EnvironmentCycle.ts only: the GameScene half stays in B's visualPolish.)
    expect(stripped('EnvironmentCycle.ts')).toContain('EXTERIOR_LIGHTS_DAY_CUTOFF = 0.85');
    expect(statement('EnvironmentCycle.ts', 'for (const g of this.glowLights)')).toContain(
      'g.light.visible = exteriorLightsOn && !off',
    );
    // The intensity formulas are deliberately untouched (night look pinned).
    expect(decl('EnvironmentCycle.ts', 'update')).toContain(
      'const glow = 0.25 + (1 - dayFactor) * 1.05',
    );
  });

  test('the lamp fleet is two instanced draws, discovery contract intact', () => {
    const island = stripped('Island.ts');
    // Anchors keep the whole discovery contract: name lamp_<i> (colliders,
    // pool anchors, both parity tests), poolScale, and the byte-identical
    // transform math (plumb + faceObjectToward + arm swing on the GROUP,
    // whose matrix becomes the instance matrix).
    const buildLamp = decl('Island.ts', 'buildLamp');
    expect(buildLamp).toContain('lampGroup.name = `lamp_${i}`');
    expect(buildLamp).toContain('lampGroup.userData.poolScale = poolScale');
    expect(buildLamp).toContain('lampMatrices.push(lampGroup.matrix.clone())');
    // The fleet renders as exactly two InstancedMesh.
    expect(island).toContain("bodyMesh.name = 'streetlamp_bodies_instanced'");
    expect(island).toContain("bulbMesh.name = 'streetlamp_bulbs_instanced'");
    // The names must NOT start with 'lamp': findPlaceholders matches by
    // PREFIX, so 'lamp_*_instanced' made the fleet its own placeholder.
    expect(island).not.toContain("'lamp_posts_instanced'");
    expect(island).not.toContain("'lamp_bulbs_instanced'");
    expect(island).toContain("loadAndReplace(basePath + 'lamp.glb', 'lamp_'");
    // The fleet is the FALLBACK: retired by flag when the authored model
    // lands, so a failed GLB load still lights the boulevard.
    expect(island).toContain('for (const m of this.lampFleet) m.visible = false');
    // Empty anchors are invisible to seatGroupsOnTerrain's bbox pass, so the
    // anchors are seated by hand and the matrices REWRITTEN from them.
    expect(island).toContain('fleet.setMatrixAt(i, anchors[i].matrix)');
    expect(island).toContain('sampled.position.dot(dir) - SINK - anchor.position.dot(dir)');
    // ...and the lampSites re-anchor guard counts ANCHORS, not children.
    expect(island).toMatch(/anchors\.length === this\.lampSites\.length/);
    // ONE night-drive entry for all bulbs (EnvironmentCycle dedupes by mat).
    expect(island).toContain('bulbMesh.userData.isNightEmissive = true');
    // No per-lamp mesh/material mints inside buildLamp any more (its whole
    // declaration; the old slice ended at the first `};`).
    expect(buildLamp).not.toContain('new THREE.Mesh(');
    expect(buildLamp).not.toContain('createTrimMaterial');
    // InstancedMesh owns a GPU instanceMatrix the geometry/material disposal
    // does not release. (GameScene's fetch of the bulb material by name stays
    // in B's visualPolish.)
    expect(island).toContain('if (inst.isInstancedMesh) inst.dispose()');
  });

  test('GLB clones collapse to instanced draws, and the fade stops leaking transparency', () => {
    const island = stripped('Island.ts');
    // Object3D.clone() SHARES geometry+materials, so N identical static
    // clones are N draws of the same buffers.
    expect(island).toContain('const collapseClonesToInstances =');
    // Opted in: lamps, benches, decorative mailboxes — all static.
    expect((island.match(/collapseToInstances: true/g) ?? []).length).toBe(3);
    // Cars and TREES must NOT opt in: cars are driven and trees sway per frame
    // and can be felled. (The tree loader's own block; the old slice ran from
    // the first 'tryTree' to the end of the file.)
    expect(blockOf('Island.ts', 'const tryTree')).not.toContain('collapseToInstances');
    // CONSERVATIVE bail: skinned, nested instanced, points/lines, hidden
    // sub-meshes, or a DEGENERATE split all leave the clones alone.
    const collapse = decl('Island.ts', 'collapseClonesToInstances');
    expect(collapse).toContain('(m as THREE.SkinnedMesh).isSkinnedMesh ||');
    expect(collapse).toContain('!m.visible');
    expect(collapse).toContain('buckets.size >= clones.length');
    // An animated model must never collapse — mixers are bound per clone.
    expect(island).toContain('options.collapseToInstances && animations.length === 0');
    // Added with the AST slice: that gate really calls the collapse.
    expect(
      statement('Island.ts', 'if (options.collapseToInstances && animations.length === 0)'),
    ).toContain('collapseClonesToInstances(');
    // Instances must not be named with a placeholder prefix.
    expect(collapse).toContain('inst.name = `glbfleet_${label}${idx++}`');
    // The clones are DETACHED, never disposed.
    expect(collapse).toContain('for (const clone of clones) clone.parent?.remove(clone)');
    // The fade's authored transparency is snapshotted from the SOURCE model
    // and restored when the fade lands.
    expect(island).toContain('const snapshotAuthoredMaterials =');
    expect(island).toContain('const restoreAuthoredMaterials =');
    const restore = decl('Island.ts', 'restoreAuthoredMaterials');
    expect(restore).toContain('mat.transparent = authored.transparent');
    // A material prepareClone REPLACED has a uuid the snapshot never saw — it
    // is authored opaque by construction, so default rather than skip.
    expect(restore).toContain('snap.get(mat.uuid) ?? { transparent: false, opacity: 1 }');
    // BOTH GLB loaders must restore. (GameScene's instanceMatrix release stays
    // in B's visualPolish.)
    expect(island).toContain('restoreAuthoredMaterials(fadeMats, authoredMats)');
    expect(island).toContain('restoreAuthoredMaterials(treeFadeMats, authoredTreeMats)');
  });
});

describe('smoothness round 2 — the two measured hitches', () => {
  test('villager ink hulls cull with their body, not from anywhere on the planet', () => {
    expect(stripped('CelLook.ts')).not.toContain('hull.frustumCulled = false');
    // The skinned-hull builder itself (the old checks read the whole file).
    const hull = decl('CelLook.ts', 'addSkinnedHull');
    expect(hull).toContain('hull.computeBoundingSphere()');
    expect(hull).toContain('hull.boundingSphere.radius *= 2.5');
    // ORDER MATTERS: computeBoundingSphere skins through the skeleton, so it
    // MUST run AFTER hull.bind() or it returns a null sphere.
    expect(hull.indexOf('hull.bind(')).toBeGreaterThan(-1);
    expect(hull.indexOf('hull.computeBoundingSphere()')).toBeGreaterThan(
      hull.indexOf('hull.bind('),
    );
  });

  test('villager face decals do not cast shadow (invisible, but re-skinned every frame)', () => {
    // eye/eyeshine/blush sit inside the head's own silhouette, so the hull
    // gate's else-branch drops them from the shadow pass. The old regex
    // allowed 120 and 260 characters; the AST reads the if/else itself.
    const gate = statementNode('Island.ts', 'if (!/eye|blush/.test(matName))');
    expect(ts.isIfStatement(gate)).toBe(true);
    const ifs = gate as ts.IfStatement;
    expect(code('Island.ts', ifs.expression)).toBe('!/eye|blush/.test(matName)');
    expect(code('Island.ts', ifs.thenStatement)).toMatch(/^\{\s*addSkinnedHull/);
    expect(ifs.elseStatement && code('Island.ts', ifs.elseStatement)).toContain(
      'castShadow = false',
    );
  });

  test('the headlight wash is rolled ALONG the road, on an exact radius', () => {
    const traffic = stripped('Traffic.ts');
    expect(traffic).not.toContain('this._q.setFromUnitVectors(this._flat, this._ahead)');
    // Y = road tangent, Z = radial => X MUST be tan x ahead for a proper
    // right-handed basis. The order is pinned explicitly.
    expect(traffic).toContain('this._right.crossVectors(this._washTan, this._ahead)');
    expect(traffic).toContain('makeBasis(this._right, this._washTan, this._ahead)');
    // Re-orthogonalise: the raw tangent carries ~0.04 of shear against the
    // 4u-lead direction, which tips the quad off the ground if skipped.
    expect(traffic).toMatch(
      /_washTan\s*\n?\s*\.addScaledVector\(this\._ahead, -this\._washTan\.dot/,
    );
    // Seat: wheels bottom out at local y = -0.02 and the ribbon sits at
    // +0.04/+0.055, so +0.35 hovered every wheel 0.29u above its own road.
    expect(traffic).toContain('multiplyScalar(r + 0.075)');
    expect(traffic).not.toContain('multiplyScalar(r + 0.35)');
    // The 128-entry LUT could not represent the coastal lane's 2.079u of
    // relief at 4.72u spacing (worst error 0.425u); analyticSurface is exact.
    expect(traffic).toContain('return this.island.analyticSurface(dir).radius;');
  });
});

// ---- oceanDive.test.ts (B) ---------------------------------------------------

describe('mid-water life is cheap and RNG-safe', () => {
  test('the water ceiling is a separate shell, not a flipped sea material', () => {
    // The sea's alpha is overwritten inside its own shader and the whole
    // material was tuned single-sided; flipping it to DoubleSide is a coin
    // flip on the most regression-prone material in the codebase. (Island.ts
    // only, read as written because the pinned text carries its comment; the
    // GameScene shell half stays in B's oceanDive.)
    expect(raw('Island.ts')).not.toContain('side: THREE.DoubleSide, // sea');
  });
});

// ---- reducedMotion.test.ts (D) -----------------------------------------------

describe('load-bearing gates exist at their call sites', () => {
  test('rain calms, and rebuilds live when the toggle flips mid-storm', () => {
    // The calm parameters are baked into the particle buffers at build, so the
    // gate is in the builder and the toggle rebuilds it (the original found
    // both strings anywhere in the file).
    expect(decl('EnvironmentCycle.ts', 'rebuildPrecipitation')).toContain('a11y.reducedMotion');
    expect(ctor('EnvironmentCycle.ts', 'EnvironmentCycle')).toContain(
      'a11y.onChange(() => this.rebuildPrecipitation())',
    );
  });

  test('pending-delivery attention loops hold still (mailbox glow, minimap pulses)', () => {
    // The glow pulse is the attention loop (Mailbox.ts only; the SimpleUI
    // minimap half stays in D's reducedMotion).
    expect(stripped('Mailbox.ts')).toContain('a11y.reducedMotion');
    expect(statement('Mailbox.ts', 'this.glowMaterial.opacity = a11y')).toContain(
      'a11y.reducedMotion ?',
    );
  });

  test('the dead Island.update() lamp-blink landmine stays deleted', () => {
    // The old method was dead code whose lamp blink (`sin(t*3) > -0.5`
    // visibility toggle) would strobe every lamp in town if revived.
    expect(raw('Island.ts')).not.toContain('public update(deltaTime: number)');
  });
});

// ---- frontDoorPolish.test.ts (D) ---------------------------------------------

describe('the fly-in hides the ink through the material', () => {
  const boxGroup = (n: number): THREE.Group => {
    const g = new THREE.Group();
    for (let i = 0; i < n; i++) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
      m.position.set(i * 2, 0, 0);
      g.add(m);
    }
    return g;
  };
  const hullsOf = (root: THREE.Object3D): THREE.Mesh[] => {
    const out: THREE.Mesh[] = [];
    root.traverse((o) => {
      if (o.userData.isCelHull) out.push(o as THREE.Mesh);
    });
    return out;
  };

  test('setInkVisible flips the shared material and never Object3D.visible', () => {
    const g = boxGroup(3);
    addGroupHulls(g);
    const hulls = hullsOf(g);
    expect(hulls.length).toBe(3);
    try {
      setInkVisible(false);
      for (const h of hulls) {
        expect((h.material as THREE.Material).visible).toBe(false);
        expect(h.visible).toBe(true); // game state is untouched
      }
      const late = boxGroup(1); // a hull baked mid-intro joins the hidden state
      addGroupHulls(late);
      expect((hullsOf(late)[0].material as THREE.Material).visible).toBe(false);
    } finally {
      setInkVisible(true);
    }
    for (const h of hulls) expect((h.material as THREE.Material).visible).toBe(true);
  });

  test('the dead cel shadow patch and its load warning are gone', () => {
    // (its name survives in a CelLook comment, for anyone searching history)
    expect(stripped('CelLook.ts')).not.toContain('applyCelShadowPatch');
    expect(stripped('CelLook.ts')).not.toContain('console.warn');
  });
});

// ---- C's own stage-2 locks ---------------------------------------------------

describe('the light count never changes at runtime (decision P2-1, P2-C4)', () => {
  // three bakes the light COUNT into every lit program, so a light joining the
  // scene at dusk re-links the world: the six porch lights and the two
  // lighthouse spots froze the island for 2.4-3.6 s at dusk and made a night
  // boot 3.4-4.4 s slower. Both are still CONSTRUCTED where they were, because
  // their uuids are seeded draws (drawNeutral pins the counts), but neither
  // enters the scene graph. test/drawNeutral.test.ts checks the built island.

  test('the porch light is constructed bare: nothing can add it to a house', () => {
    const porch = statementNode('Island.ts', 'new THREE.PointLight(0xffd6a5, 1.9, 8, 2)');
    // An expression statement whose whole expression is the constructor: no
    // binding exists to hand to house.add().
    expect(ts.isExpressionStatement(porch)).toBe(true);
    expect(ts.isNewExpression((porch as ts.ExpressionStatement).expression)).toBe(true);
    expect(stripped('Island.ts')).not.toContain('isHouseWarmLight');
  });

  test('the lighthouse spots stay out of the beam, and the sweep list is empty', () => {
    const lighthouse = decl('Island.ts', 'createLighthouse');
    expect(lighthouse).toContain('new THREE.SpotLight(0xffe4a0, 0, 44, 0.3, 0.55, 1.1)');
    // The target stays in the arm; the light itself is never added.
    expect(lighthouse).toContain('arm.add(sl.target)');
    expect(lighthouse).not.toMatch(/\.add\([^)]*\bsl\b(?!\.)/);
    // GameScene's sweep loop drives beam.userData.beamLights: empty, it idles.
    expect(lighthouse).toContain('beam.userData.beamLights = []');
  });

  test('Island constructs no other light (the perf budget: no new THREE lights)', () => {
    const island = stripped('Island.ts');
    expect(island.match(/new THREE\.\w*Light\(/g)).toEqual([
      'new THREE.PointLight(',
      'new THREE.SpotLight(',
    ]);
  });
});
