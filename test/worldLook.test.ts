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
import { describe, expect, test, vi } from 'vitest';

import { a11y } from '../Accessibility';
import { addGroupHulls, applyCelRim, setCelNight, setInkVisible } from '../CelLook';
import {
  DAY_FACTOR_UNIFORM,
  duskFactorAt,
  EnvironmentCycle,
  hemiLevelAt,
  KEY_ELEVATION_CAP,
  keyFloorAt,
  keyLevelAt,
  moonWeightAt,
  NIGHT_KEY_FLOOR,
  nightFactorAt,
  sunUpAt,
} from '../EnvironmentCycle';
import type { Island } from '../Island';
import { Mailbox } from '../Mailbox';
import { Materials } from '../Materials';
import { Zone } from '../Zones';
import { installHeadlessCanvas } from './helpers/headlessDom';

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
    expect(traffic).not.toMatch(/const LUT = /);
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

describe('one cel look for landmarks and props (C3)', () => {
  // Materials.toonify is the one converter (wave 2's B15 points GameScene's
  // island pass at it too). These pin what it carries, that it never draws from
  // the shared stream, and where C applies it. The in-browser census and the
  // seed probe check the running world.

  /** Ambient Math.random calls while fn runs. */
  const ambientDraws = (fn: () => void): number => {
    const spy = vi.spyOn(Math, 'random');
    spy.mockClear();
    try {
      fn();
      return spy.mock.calls.length;
    } finally {
      spy.mockRestore();
    }
  };

  /** Every material slot under root, ink hulls skipped, as type[tr]. */
  const kinds = (root: THREE.Object3D): string[] => {
    const out: string[] = [];
    root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || m.userData.isCelHull) return;
      for (const mat of Array.isArray(m.material) ? m.material : [m.material]) {
        const toon = mat as THREE.MeshToonMaterial;
        const ramp = toon.isMeshToonMaterial
          ? toon.gradientMap === Materials.toonRamp()
            ? '[ramp]'
            : '[NO RAMP]'
          : '';
        out.push(`${mat.type}${ramp}${mat.transparent ? '[tr]' : ''}`);
      }
    });
    return out;
  };

  test('toonify carries colour, map, emissive, vertex colours, the flags and the shader hooks', () => {
    const map = new THREE.Texture();
    const src = new THREE.MeshStandardMaterial({
      color: 0x336699,
      map,
      emissive: 0x112233,
      emissiveIntensity: 0.7,
      vertexColors: true,
      side: THREE.DoubleSide,
      name: 'Seat',
    });
    src.alphaTest = 0.25;
    src.depthWrite = false;
    src.userData.celRim = true;
    const hook = (): void => {};
    src.onBeforeCompile = hook;
    src.customProgramCacheKey = () => 'cel-rim-v1';
    let disposed = false;
    src.addEventListener('dispose', () => (disposed = true));

    const toon = Materials.toonify(src);
    expect(toon.isMeshToonMaterial).toBe(true);
    expect(toon.gradientMap).toBe(Materials.toonRamp()); // the ONE shared ramp
    expect(toon.color.getHex()).toBe(0x336699);
    expect(toon.map).toBe(map);
    expect(toon.emissive.getHex()).toBe(0x112233);
    expect(toon.emissiveIntensity).toBe(0.7);
    expect(toon.vertexColors).toBe(true);
    expect(toon.side).toBe(THREE.DoubleSide);
    expect(toon.name).toBe('Seat'); // dressNpc swaps villager parts by name
    expect(toon.alphaTest).toBe(0.25);
    expect(toon.depthWrite).toBe(false);
    expect(toon.userData.celRim).toBe(true);
    expect(toon.onBeforeCompile).toBe(hook);
    expect(toon.customProgramCacheKey()).toBe('cel-rim-v1');
    expect(disposed).toBe(true); // the replaced material is released
    // Memoised: a material shared by many meshes converts once, stays shared.
    expect(Materials.toonify(src)).toBe(toon);

    const glass = new THREE.MeshStandardMaterial({ transparent: true, opacity: 0.4 });
    const clear = Materials.toonify(glass);
    expect(clear.transparent).toBe(true);
    expect(clear.opacity).toBe(0.4);
  });

  test('toonifyTree: opaque standard goes toon, glass stays PBR, ink is left alone, ZERO ambient draws', () => {
    const g = new THREE.Group();
    const shared = new THREE.MeshStandardMaterial({ color: 0x808080 });
    for (let i = 0; i < 3; i++) g.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), shared));
    const glass = new THREE.MeshStandardMaterial({ transparent: true, opacity: 0.4 });
    const pane = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), glass);
    g.add(pane);
    const multi = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), [
      new THREE.MeshStandardMaterial(),
      glass,
    ]);
    g.add(multi);
    const inkMat = new THREE.MeshStandardMaterial();
    const hull = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), inkMat);
    hull.userData.isCelHull = true;
    g.add(hull);
    const flat = new THREE.MeshBasicMaterial();
    const decal = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), flat);
    g.add(decal);

    let swapped = 0;
    const ambient = ambientDraws(() => {
      swapped = Materials.toonifyTree(g);
    });
    expect(ambient).toBe(0); // the seeded stream pays nothing, inside the window too
    expect(swapped).toBe(4); // three shared slots and the multi's opaque slot
    const [a, b] = g.children as THREE.Mesh[];
    expect(a.material).toBe(b.material); // shared stays shared
    expect((a.material as THREE.Material).type).toBe('MeshToonMaterial');
    expect(pane.material).toBe(glass);
    expect((multi.material as THREE.Material[])[1]).toBe(glass);
    expect(((multi.material as THREE.Material[])[0] as THREE.Material).type).toBe(
      'MeshToonMaterial',
    );
    expect(hull.material).toBe(inkMat);
    expect(decal.material).toBe(flat);
  });

  test('the zone halls are toon at creation, and the seeded stream sees the same draws', () => {
    const island = {
      sampleSurfaceByDirection: () => {
        throw new Error('stub: Zone falls back to an ideal-sphere seat');
      },
      getRadius: () => 100,
    } as unknown as Island;
    const data = {
      id: 'projects',
      name: 'Projects',
      description: '',
      position: new THREE.Vector3(0, 100, 0),
      color: 0xff9800,
      icon: 'P',
    };
    new Zone(data, island); // warm every first-of-kind cache before counting
    const off = vi.spyOn(Materials, 'toonifyTree').mockReturnValue(0);
    let plain = 0;
    try {
      plain = ambientDraws(() => new Zone(data, island));
    } finally {
      off.mockRestore();
    }
    let zone: Zone | null = null;
    const toon = ambientDraws(() => {
      zone = new Zone(data, island);
    });
    // ZonesManager builds inside GameScene's seeded window: converting the
    // halls must leave its draw count exactly as it was.
    expect(toon).toBe(plain);
    const hall = kinds((zone as unknown as Zone).marker);
    expect(hall.length).toBeGreaterThan(20);
    expect(hall.filter((k) => !k.endsWith('[tr]'))).toEqual(
      hall.filter((k) => !k.endsWith('[tr]')).map(() => 'MeshToonMaterial[ramp]'),
    );
    // Converted before the ink, so the hulls are built on the toon masses.
    const zc = ctor('Zones.ts', 'Zone');
    expect(zc).toContain('if (isCelTheme()) Materials.toonifyTree(this.marker)');
    expect(zc.indexOf('Materials.toonifyTree(this.marker)')).toBeLessThan(
      zc.indexOf('addGroupHulls(this.marker'),
    );
  });

  test('quest mailboxes are toon, the delivery glow stays PBR, the stream is untouched', () => {
    new Mailbox(); // warm
    const off = vi.spyOn(Materials, 'toonifyTree').mockReturnValue(0);
    let plain = 0;
    try {
      plain = ambientDraws(() => new Mailbox());
    } finally {
      off.mockRestore();
    }
    let box: Mailbox | null = null;
    const toon = ambientDraws(() => {
      box = new Mailbox();
    });
    // Quest mailboxes are built inside the seeded window (placeAssets).
    expect(toon).toBe(plain);
    const parts = kinds((box as unknown as Mailbox).mesh);
    expect(parts.filter((k) => k === 'MeshToonMaterial[ramp]')).toHaveLength(4); // post, box, plate, flag
    expect(parts).toContain('MeshStandardMaterial[tr]'); // the glow keeps its PBR fade
    expect(parts).not.toContain('MeshStandardMaterial');
  });

  test('the GLB loaders toonify the MODEL before the snapshot, the clones and the collapse', () => {
    const at = (s: string, marker: string): number => {
      const i = s.indexOf(marker);
      expect(i, `${marker} not found`).toBeGreaterThan(-1);
      return i;
    };
    // One helper does it: theme-gated, the shared converter, then FrontSide
    // (every authored mesh is closed and wound outward; measured).
    const helper = decl('Island.ts', 'toonifyModel');
    expect(at(helper, 'if (isRealTheme()) return;')).toBeLessThan(
      at(helper, 'Materials.toonifyTree(model)'),
    );
    expect(at(helper, 'Materials.toonifyTree(model)')).toBeLessThan(
      at(helper, 'mat.side = THREE.FrontSide'),
    );
    const convert = 'toonifyModel(model)';
    // Props (bench, mailbox, lamp): converted on the model, so the collapse
    // still buckets every clone into one instanced draw per part.
    const props = decl('Island.ts', 'loadAndReplace');
    expect(at(props, convert)).toBeLessThan(at(props, 'snapshotAuthoredMaterials(model)'));
    expect(at(props, convert)).toBeLessThan(at(props, 'prepareClone(model'));
    expect(at(props, convert)).toBeLessThan(at(props, 'collapseClonesToInstances('));
    // tree.glb: before its snapshot and its clones.
    const trees = decl('Island.ts', 'tryTree');
    expect(at(trees, convert)).toBeLessThan(at(trees, 'snapshotAuthoredMaterials(model)'));
    expect(at(trees, convert)).toBeLessThan(at(trees, 'prepareClone(model'));
    // npc.glb: before the skeleton clones share the materials; then the flair.
    const villagers = decl('Island.ts', 'tryNpc');
    expect(at(villagers, convert)).toBeLessThan(at(villagers, 'new NPC('));
    expect(decl('Island.ts', 'dressNpc')).toContain(
      'if (!isRealTheme()) Materials.toonifyTree(group)',
    );
  });

  test('prepareClone keeps a toonified material toon, so clones keep sharing it', () => {
    const prep = decl('Island.ts', 'prepareClone');
    const p = parse('Island.ts');
    const from = declNode('Island.ts', 'prepareClone').getStart(p.sf);
    const gate = statementNode('Island.ts', '.isMeshToonMaterial', from);
    expect(ts.isIfStatement(gate)).toBe(true);
    const then = code('Island.ts', (gate as ts.IfStatement).thenStatement);
    expect(then).toContain('typedMaterial.transparent = true');
    expect(then).toContain('typedMaterial.opacity = 0');
    expect(then).toMatch(/return;\s*\}$/);
    // ...ahead of the per-clone rebuild into a fresh MeshStandardMaterial.
    expect(prep.indexOf('.isMeshToonMaterial')).toBeLessThan(
      prep.indexOf('const standardMaterial = new THREE.MeshStandardMaterial()'),
    );
  });

  test('the traffic fleet converts after the window; the real theme keeps PBR everywhere', () => {
    expect(ctor('Traffic.ts', 'TrafficSystem')).toContain(
      'if (!isRealTheme()) Materials.toonifyTree(this.bodies)',
    );
    // Every C call site is theme-gated: each one is listed here, so a new,
    // ungated call fails the count.
    const gates: Record<string, string[]> = {
      'Island.ts': [
        'if (isRealTheme()) return;',
        'if (!isRealTheme()) Materials.toonifyTree(group)',
      ],
      'Zones.ts': ['if (isCelTheme()) Materials.toonifyTree(this.marker)'],
      'Mailbox.ts': ['if (!isRealTheme()) Materials.toonifyTree(group)'],
      'Traffic.ts': ['if (!isRealTheme()) Materials.toonifyTree(this.bodies)'],
    };
    for (const [file, lines] of Object.entries(gates)) {
      const s = stripped(file);
      for (const line of lines) expect(s, file).toContain(line);
      const calls = (s.match(/Materials\.toonifyTree\(/g) ?? []).length;
      expect(calls, file).toBe(file === 'Island.ts' ? 2 : 1);
    }
  });

  test('envMapIntensity in overrides.json is real-theme only', () => {
    const manifest = JSON.parse(
      readFileSync(join(process.cwd(), 'public', 'assets', 'models', 'overrides.json'), 'utf8'),
    ) as Record<string, Record<string, unknown>>;
    let scoped = 0;
    for (const [model, entry] of Object.entries(manifest)) {
      expect(entry, model).not.toHaveProperty('envMapIntensity');
      const real = entry.realTheme as Record<string, unknown> | undefined;
      if (real && typeof real.envMapIntensity === 'number') scoped++;
    }
    expect(scoped).toBeGreaterThan(0);
    // The loader merges a `realTheme` block only under ?theme=real.
    expect(decl('Island.ts', 'tryLoadModels')).toContain(
      'isRealTheme() && realTheme ? { ...shared, ...realTheme } : shared',
    );
  });
});

describe('a compile pass is sent to the GPU, not left queued (wave 1, welcome_visible)', () => {
  // three's compileAsync polls and never flushes, and Chrome sends queued GL
  // commands only on a flush: a drawn frame, or its own check every 100
  // commands. C3 took the zone halls' standard materials out of the boot
  // pass's last links, the polls fell from 144 a round to one, and the last
  // program's link sat in the queue for ~1 s behind the loader (the welcome
  // card +341 ms). The sea's shader hook now asks for one flush when the pass
  // ends. The in-browser proof is the perf gate's A/B on welcome_visible.

  const fakeRenderer = (): { renderer: THREE.WebGLRenderer; flush: ReturnType<typeof vi.fn> } => {
    const flush = vi.fn();
    return { renderer: { getContext: () => ({ flush }) } as unknown as THREE.WebGLRenderer, flush };
  };

  test('one flush per pass, after every link in it and before the next poll', async () => {
    const order: string[] = [];
    const { renderer, flush } = fakeRenderer();
    flush.mockImplementation(() => order.push('flush'));
    // A pass, as three runs it: each hook fires BEFORE its own program links,
    // more programs link after it, and the first poll is a 10 ms timer away.
    Materials.flushAfterCompile(renderer);
    order.push('link: sea');
    Materials.flushAfterCompile(renderer); // a second hooked material asks too
    order.push('link: the last program');
    setTimeout(() => order.push('poll'), 0);
    expect(flush).not.toHaveBeenCalled(); // nothing is sent mid-pass
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(order).toEqual(['link: sea', 'link: the last program', 'flush', 'poll']);

    // The next pass (a later task) gets a flush of its own.
    Materials.flushAfterCompile(renderer);
    await Promise.resolve();
    expect(flush).toHaveBeenCalledTimes(2);
  });

  test('each renderer is flushed; no renderer, or a context that throws, is a no-op', async () => {
    const a = fakeRenderer();
    const b = fakeRenderer();
    Materials.flushAfterCompile(a.renderer);
    Materials.flushAfterCompile(b.renderer);
    Materials.flushAfterCompile(undefined); // a hook called without one (tests, tools)
    const lost = {
      getContext: () => {
        throw new Error('context lost');
      },
    } as unknown as THREE.WebGLRenderer;
    Materials.flushAfterCompile(lost);
    await Promise.resolve();
    expect(a.flush).toHaveBeenCalledTimes(1);
    expect(b.flush).toHaveBeenCalledTimes(1);
    // The failed one is not left marked as queued: it may ask again.
    const again = vi.fn();
    (lost as unknown as { getContext: () => unknown }).getContext = () => ({ flush: again });
    Materials.flushAfterCompile(lost);
    await Promise.resolve();
    expect(again).toHaveBeenCalledTimes(1);
  });

  test('the sea asks, first thing in its shader hook, and it is the only one that does', () => {
    const hook = statementNode('Island.ts', 'seaMat.onBeforeCompile =');
    expect(ts.isExpressionStatement(hook)).toBe(true);
    const assign = (hook as ts.ExpressionStatement).expression as ts.BinaryExpression;
    expect(ts.isArrowFunction(assign.right)).toBe(true);
    const fn = assign.right as ts.ArrowFunction;
    // three hands the hook (parameters, renderer).
    expect(fn.parameters.map((p) => p.name.getText())).toEqual(['shader', 'renderer']);
    const first = (fn.body as ts.Block).statements[0];
    expect(code('Island.ts', first)).toBe('Materials.flushAfterCompile(renderer);');
    // The sea stays PBR in both themes (toonifyTree and GameScene's island
    // pass skip transparent materials), so no swap can drop the hook.
    expect(statement('Island.ts', 'const seaMat = new THREE.MeshStandardMaterial(')).toMatch(
      /transparent: true/,
    );
    const calls = ['Island.ts', 'Zones.ts', 'Mailbox.ts', 'Traffic.ts', 'CelLook.ts']
      .map((f) => (stripped(f).match(/Materials\.flushAfterCompile\(/g) ?? []).length)
      .reduce((a, b) => a + b, 0);
    expect(calls).toBe(1);
    // A microtask: a direct flush from the hook would miss the hook's own
    // program and every link after it.
    const helper = decl('Materials.ts', 'flushAfterCompile');
    expect(helper).toMatch(/queueMicrotask\(\(\) => \{[\s\S]*renderer\.getContext\(\)\.flush\(\)/);
  });
});

// ---- wave 2: the light rig ---------------------------------------------------

/** A day/night cycle on a bare scene, with the lights GameScene hands it. */
const makeCycle = (): {
  env: EnvironmentCycle;
  scene: THREE.Scene;
  sun: THREE.DirectionalLight;
  hemi: THREE.HemisphereLight;
  sunDir: THREE.Vector3;
} => {
  installHeadlessCanvas();
  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x79b7e6, 0.0045);
  const sun = new THREE.DirectionalLight(0xffe9c0, 1.6);
  const hemi = new THREE.HemisphereLight(0xaacdf7, 0x4a6b32, 0.62);
  const sunDir = new THREE.Vector3(0, 1, 0);
  const env = new EnvironmentCycle(scene, sun, hemi, {
    topColor: { value: new THREE.Color() },
    bottomColor: { value: new THREE.Color() },
    horizonColor: { value: new THREE.Color() },
    zenithColor: { value: new THREE.Color() },
    sunDir: { value: sunDir },
    sunWarmth: { value: 0 },
  });
  return { env, scene, sun, hemi, sunDir };
};

/** Unit direction at (lon, lat), as Island.dirAt and Districts.dirFor build it. */
const dirAt = (lon: number, lat: number): THREE.Vector3 =>
  new THREE.Vector3(
    Math.cos(lon) * Math.cos(lat),
    Math.sin(lat),
    Math.sin(lon) * Math.cos(lat),
  ).normalize();

const R = 100;
/** A standing spot at the hub, and the four district centres (Districts.ts). */
const HUB = dirAt(0.6, 1.4);
const DISTRICT_DIRS = [0, 0.5, 1, 1.5].map((k) => dirAt(Math.PI * k, 0.4636));

/** The key light's height above the visitor's own horizon, in degrees. */
const localElevation = (sun: THREE.DirectionalLight, up: THREE.Vector3): number =>
  THREE.MathUtils.radToDeg(Math.asin(sun.position.clone().normalize().dot(up)));

/** The key light's ceiling (KEY_ELEVATION_CAP): 1.13 rad is 64.7 degrees. */
const CAP_DEG = THREE.MathUtils.radToDeg(1.13);

/** Run fn with an FxBudget switch forced, then put the switch back. */
const withFx = (name: string, on: boolean, fn: () => void): void => {
  const g = (globalThis.__dsFx ??= {});
  const before = g[name];
  g[name] = on;
  try {
    fn();
  } finally {
    if (before === undefined) delete g[name];
    else g[name] = before;
  }
};

describe("the sun shines in each visitor's own sky (P2-C1)", () => {
  // The sun arc is built around world +Y. The districts stand 63 degrees from
  // the pole, so at 10:30 (the hour every first visit gets) the world sun sat
  // 5.7 degrees over Professional Experience under a midday sky, and below
  // the horizon of two districts at 09:00 and 15:00.

  test('from 09 to 15 h the key stands 40 to 65 degrees up, the same over the hub and every district', () => {
    for (const hour of [9, 10.5, 12, 15]) {
      const elevations = [HUB, ...DISTRICT_DIRS].map((up) => {
        const { env, sun } = makeCycle();
        env.debugHour = hour;
        env.update(1 / 60, up.clone().multiplyScalar(R), 0);
        return localElevation(sun, up);
      });
      for (const e of elevations) {
        expect(e).toBeGreaterThanOrEqual(40);
        expect(e).toBeLessThanOrEqual(CAP_DEG + 1e-6);
        expect(e).toBeCloseTo(elevations[0], 6);
      }
    }
  });

  test("with the switch off the sun is the world's again (what main shipped)", () => {
    withFx('localSun', false, () => {
      const elevations = DISTRICT_DIRS.map((up) => {
        const { env, sun } = makeCycle();
        env.debugHour = 10.5;
        env.update(1 / 60, up.clone().multiplyScalar(R), 0);
        return localElevation(sun, up);
      });
      // Measured on main at 10:30: 5.7, 16.0, 33.4 and 46.6 degrees.
      expect(Math.min(...elevations)).toBeLessThan(10);
      expect(Math.max(...elevations) - Math.min(...elevations)).toBeGreaterThan(30);
      const { env } = makeCycle();
      env.update(1 / 60, DISTRICT_DIRS[0].clone().multiplyScalar(R), 0);
      expect(env.getLocalFrame().equals(new THREE.Quaternion())).toBe(true);
    });
  });

  test('noon: 65 degrees, not the zenith, so walls keep a lit side', () => {
    expect(KEY_ELEVATION_CAP).toBeCloseTo(Math.sin(1.13), 12);
    const { env, sun } = makeCycle();
    env.debugHour = 12;
    env.update(1 / 60, HUB.clone().multiplyScalar(R), 0);
    expect(localElevation(sun, HUB)).toBeCloseTo(CAP_DEG, 4);
  });

  test('the light holds still while the visitor walks, and turns once they stand', () => {
    const { env, sun, sunDir } = makeCycle();
    env.debugHour = 10.5;
    const up = DISTRICT_DIRS[1].clone();
    const axis = new THREE.Vector3(0, 1, 0).cross(up).normalize();
    const dt = 1 / 60;
    env.update(dt, up.clone().multiplyScalar(R), 0);
    const held = sun.position.clone();
    const discElevation = sunDir.dot(up);
    // 3 s at walking pace (5.6 u/s): 9.6 degrees round the planet.
    for (let f = 1; f <= 180; f++) {
      up.applyAxisAngle(axis, (5.6 * dt) / R).normalize();
      env.update(dt, up.clone().multiplyScalar(R), f * dt);
      // Not one bit of turn: the shadow map's texel grid follows this vector.
      expect(sun.position.equals(held)).toBe(true);
      // The sky's warm lobe (and the discs, on the same frame) stay put in the
      // visitor's sky instead.
      expect(sunDir.dot(up)).toBeCloseTo(discElevation, 9);
    }
    // The light's frame is now 9.6 degrees behind the visitor.
    const want = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), up);
    let last = env.getLocalFrame().angleTo(want);
    expect(THREE.MathUtils.radToDeg(last)).toBeCloseTo(9.63, 1);
    // Standing: it eases round, never overshooting, and is right within 3 s.
    for (let f = 0; f < 180; f++) {
      env.update(dt, up.clone().multiplyScalar(R), 3 + f * dt);
      const off = env.getLocalFrame().angleTo(want);
      expect(off).toBeLessThanOrEqual(last + 1e-9);
      last = off;
    }
    expect(last).toBeLessThan(1e-4);
    expect(localElevation(sun, up)).toBeCloseTo(CAP_DEG, 2);
  });

  test('a teleport re-bases at once; reduced motion never swings the light', () => {
    const { env, sun } = makeCycle();
    env.debugHour = 10.5;
    env.update(1 / 60, DISTRICT_DIRS[0].clone().multiplyScalar(R), 0);
    // Fast travel to the far district: right on the next frame.
    env.update(1 / 60, DISTRICT_DIRS[2].clone().multiplyScalar(R), 1 / 60);
    expect(localElevation(sun, DISTRICT_DIRS[2])).toBeCloseTo(CAP_DEG, 4);

    const was = a11y.reducedMotion;
    a11y.reducedMotion = true;
    try {
      const up = DISTRICT_DIRS[2].clone();
      const axis = new THREE.Vector3(0, 1, 0).cross(up).normalize();
      for (let f = 0; f < 120; f++) {
        up.applyAxisAngle(axis, 5.6 / 60 / R).normalize();
        env.update(1 / 60, up.clone().multiplyScalar(R), 1 + f / 60);
      }
      const want = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), up);
      expect(env.getLocalFrame().angleTo(want)).toBeGreaterThan(0.1);
      // Stand for a quarter of a second: one step, no animation.
      const seen = new Set<string>();
      for (let f = 0; f < 15; f++) {
        env.update(1 / 60, up.clone().multiplyScalar(R), 3 + f / 60);
        seen.add(env.getLocalFrame().angleTo(want).toFixed(6));
      }
      expect(seen.size).toBe(2);
      expect(localElevation(sun, up)).toBeCloseTo(CAP_DEG, 4);
    } finally {
      a11y.reducedMotion = was;
    }
  });

  test('one switch, timed through FxBudget on a method bound once', () => {
    const env = stripped('EnvironmentCycle.ts');
    expect(env).toContain("fx.register('localSun', { desktop: true, low: true })");
    expect(decl('EnvironmentCycle.ts', 'update')).toContain(
      "fx.time('localSun', this.stepLocalFrame)",
    );
    // An arrow property: the same function object every frame.
    expect(env).toMatch(/private readonly stepLocalFrame = \(\): void => \{/);
    // The discs and the sky's lobe ride the visitor's frame, the light its own.
    const update = decl('EnvironmentCycle.ts', 'update');
    expect(update.match(/\.applyQuaternion\(this\.qSky\)/g)).toHaveLength(3);
    expect(update.match(/\.applyQuaternion\(this\.qLight\)/g)).toHaveLength(1);
  });
});

describe('a golden hour that holds (C1)', () => {
  // Dawn and dusk were a silhouette world: ground L* 20-26 under a sky at
  // 60-70. Three causes, each pinned below: the key stood 3.4 degrees up (the
  // cel ramp's top band needs 19.5), it came from the moon at sunset itself,
  // and it ran at 0.29 of its base tinted 80% toward night.

  /** update()'s day ramp, for the helpers that take it. */
  const dayAt = (elev: number): number => THREE.MathUtils.smoothstep(elev, -0.12, 0.3);
  const hex = (c: THREE.Color): string => c.getHexString();

  test('the night factor is 0 through golden hour and engages under the horizon', () => {
    // The plan's first formula, smoothstep(elev, 0.0, -0.15), is 0 here.
    expect(nightFactorAt(-0.2)).toBeGreaterThan(0.5);
    expect(nightFactorAt(-0.3)).toBe(1);
    expect(nightFactorAt(-1)).toBe(1);
    for (const elev of [1, 0.35, 0.1, 0, -0.02, -0.05]) expect(nightFactorAt(elev)).toBe(0);
    // 1 - dayFactor, which the old tint used, is already 0.8 at sunset.
    expect(1 - dayAt(0)).toBeCloseTo(0.802, 3);
  });

  test('the sun stays the key through golden hour; the moon takes over below it', () => {
    expect(moonWeightAt(-0.02, 0.9)).toBe(0);
    expect(moonWeightAt(0, 0.9)).toBe(0);
    expect(moonWeightAt(0.2, 0.9)).toBe(0);
    expect(moonWeightAt(-0.25, 0.9)).toBe(1);
    // A moon under the horizon never takes the key.
    expect(moonWeightAt(-1, 0.02)).toBe(0);
  });

  test('the key stands 23.6 degrees up at the horizon, where the ramp lights flat ground', () => {
    expect(keyFloorAt(0)).toBeCloseTo(0.4, 12);
    expect(keyFloorAt(0)).toBeGreaterThan(1 / 3);
    // Away from the horizon by day it is the old 0.06 (night has its own, C5).
    expect(keyFloorAt(0.35)).toBeCloseTo(0.06, 12);
    expect(keyFloorAt(1)).toBeCloseTo(0.06, 12);
  });

  test('golden hour holds the key and the hemisphere up; noon and night keep their levels', () => {
    expect(duskFactorAt(0)).toBe(1);
    expect(keyLevelAt(dayAt(0), 0)).toBeCloseTo(0.92, 12);
    expect(hemiLevelAt(dayAt(0), 0)).toBeCloseTo(0.8, 12);
    // Main at the horizon: 0.29 and 0.45.
    expect(0.12 + 0.88 * dayAt(0)).toBeCloseTo(0.294, 3);
    expect(0.32 + 0.68 * dayAt(0)).toBeCloseTo(0.455, 3);
    expect(keyLevelAt(1, 1)).toBe(1);
    expect(hemiLevelAt(1, 1)).toBe(1);
    expect(keyLevelAt(0, -1)).toBeCloseTo(0.12, 12);
    expect(hemiLevelAt(0, -1)).toBeCloseTo(0.32, 12);
  });

  test('the warm key ends with the sun, on a ramp: no frame pops', () => {
    expect(sunUpAt(0)).toBe(1);
    expect(sunUpAt(-0.02)).toBe(1);
    expect(sunUpAt(-0.08)).toBe(0);
    // Sunset to night in steps of 0.001 of height (about 14 s of clock).
    let last = keyLevelAt(dayAt(0.4), 0.4);
    let lastHemi = hemiLevelAt(dayAt(0.4), 0.4);
    for (let elev = 0.4; elev >= -0.4; elev -= 0.001) {
      const key = keyLevelAt(dayAt(elev), elev);
      const hemi = hemiLevelAt(dayAt(elev), elev);
      expect(Math.abs(key - last)).toBeLessThan(0.025);
      expect(Math.abs(hemi - lastHemi)).toBeLessThan(0.01);
      last = key;
      lastHemi = hemi;
    }
  });

  test('18:00 on the island: a warm key at 0.92, 23.6 degrees up, and a tinted hemisphere', () => {
    const { env, sun, hemi } = makeCycle();
    env.debugHour = 18;
    env.update(1 / 60, HUB.clone().multiplyScalar(R), 0);
    expect(env.getDuskFactor()).toBeCloseTo(1, 9);
    expect(env.getNightFactor()).toBe(0);
    expect(sun.intensity).toBeCloseTo(1.6 * 0.92, 6);
    expect(localElevation(sun, HUB)).toBeCloseTo(23.58, 1);
    // #fff2dd, 85% of the way to #ffc58a, and not a step toward night.
    expect(hex(sun.color)).toBe(
      hex(new THREE.Color(0xfff2dd).lerp(new THREE.Color(0xffc58a), 0.85)),
    );
    expect(hemi.intensity).toBeCloseTo(0.62 * 0.8, 6);
    // The tint is handed out for GameScene's underwater grade to start from,
    // and written to the light for anything that has no such grade.
    const tint = env.getHemiTint();
    expect(env.getHemiTint()).toBe(tint);
    expect(hex(hemi.color)).toBe(hex(tint.sky));
    expect(hex(hemi.groundColor)).toBe(hex(tint.ground));
    expect(hex(tint.ground)).toBe(
      hex(new THREE.Color(0x4a6b32).lerp(new THREE.Color(0x6b5a3a), 0.25)),
    );
    // Warmer than the day sky side (#aacdf7): pulled toward the dusk horizon.
    expect(tint.sky.r).toBeGreaterThan(new THREE.Color(0xaacdf7).r);
    expect(tint.sky.b).toBeLessThan(new THREE.Color(0xaacdf7).b);
  });

  test('noon is untouched, and midnight is moonlit blue at the old levels', () => {
    const { env, sun, hemi } = makeCycle();
    env.debugHour = 12;
    env.update(1 / 60, HUB.clone().multiplyScalar(R), 0);
    expect(sun.intensity).toBeCloseTo(1.6, 9);
    expect(hex(sun.color)).toBe('fff2dd');
    expect(hemi.intensity).toBeCloseTo(0.62, 9);
    expect(hex(hemi.color)).toBe('aacdf7');
    expect(hex(hemi.groundColor)).toBe('4a6b32');
    expect(env.getDuskFactor()).toBe(0);
    expect(env.getNightFactor()).toBe(0);
    expect(DAY_FACTOR_UNIFORM.value).toBe(1);

    env.debugHour = 0;
    env.update(1 / 60, HUB.clone().multiplyScalar(R), 1);
    expect(env.getNightFactor()).toBe(1);
    expect(env.getDuskFactor()).toBe(0);
    expect(DAY_FACTOR_UNIFORM.value).toBe(0);
    expect(sun.intensity).toBeCloseTo(1.6 * 0.12, 9);
    expect(hex(sun.color)).toBe('9db3e6');
    expect(hemi.intensity).toBeCloseTo(0.62 * 0.32, 9);
  });

  test('the pinned night code is still there: one cutoff, the glow formula', () => {
    const update = decl('EnvironmentCycle.ts', 'update');
    expect(update).toContain('const glow = 0.25 + (1 - dayFactor) * 1.05');
    expect(update).toContain('const exteriorLightsOn = dayFactor < EXTERIOR_LIGHTS_DAY_CUTOFF');
    // The day factor reaches shaders as one shared uniform object.
    expect(update).toContain('DAY_FACTOR_UNIFORM.value = dayFactor');
  });
});

describe('faces readable at night, the dark patches kept (C5)', () => {
  // The avatar at night was a black cut-out (L* 5-7). Abbas asked to keep the
  // beaches and the mountains dark, and every light in the rig is global, so
  // the WORLD keeps its night levels and PEOPLE get a light of their own in
  // the cast's shader. Measured at 21 h and 00 h in the wave-2 report.

  /** What three hands a material's onBeforeCompile. */
  const fakeShader = (): {
    uniforms: Record<string, { value: unknown }>;
    fragmentShader: string;
  } => ({
    uniforms: {},
    fragmentShader: 'void main() {\n#include <opaque_fragment>\n}',
  });
  const compile = (mat: THREE.Material): ReturnType<typeof fakeShader> => {
    const shader = fakeShader();
    (mat.onBeforeCompile as unknown as (s: unknown, r: unknown) => void)(shader, null);
    return shader;
  };

  test('the world keeps its night levels: the key only stands higher', () => {
    expect(NIGHT_KEY_FLOOR).toBeCloseTo(Math.sin(0.62), 12);
    expect(keyFloorAt(-1)).toBe(NIGHT_KEY_FLOOR);
    // No step between the dusk floor and the night floor.
    let last = keyFloorAt(0.4);
    for (let elev = 0.4; elev >= -0.5; elev -= 0.001) {
      expect(Math.abs(keyFloorAt(elev) - last)).toBeLessThan(0.006);
      last = keyFloorAt(elev);
    }
    // The plan's 0.20 and 0.60 night levels are NOT taken: they lifted beach
    // ground +13.7 L* and highland +7.5 at 21 h. The day ramp's floors stand.
    expect(keyLevelAt(0, -1)).toBeCloseTo(0.12, 12);
    expect(hemiLevelAt(0, -1)).toBeCloseTo(0.32, 12);

    const { env, sun, hemi } = makeCycle();
    for (const hour of [21, 0, 3]) {
      env.debugHour = hour;
      env.update(1 / 60, HUB.clone().multiplyScalar(R), hour);
      expect(sun.intensity).toBeCloseTo(1.6 * 0.12, 9);
      expect(hemi.intensity).toBeCloseTo(0.62 * 0.32, 9);
      // 35.5 degrees or more, whatever the moon is doing tonight.
      const up = localElevation(sun, HUB);
      expect(up).toBeGreaterThanOrEqual(THREE.MathUtils.radToDeg(0.62) - 1e-6);
      expect(up).toBeLessThanOrEqual(CAP_DEG + 1e-6);
    }
  });

  test('the night hemisphere is moonlit blue at the old brightness: the tint carries the level', () => {
    const { env } = makeCycle();
    env.debugHour = 0;
    env.update(1 / 60, HUB.clone().multiplyScalar(R), 0);
    const tint = env.getHemiTint();
    const sky = new THREE.Color(0x7c93c8).multiplyScalar(0.6 / 0.32);
    const ground = new THREE.Color(0x26331f).multiplyScalar(0.6 / 0.32);
    for (const k of ['r', 'g', 'b'] as const) {
      expect(tint.sky[k]).toBeCloseTo(sky[k], 9);
      expect(tint.ground[k]).toBeCloseTo(ground[k], 9);
    }
    // In luminance, about what shipped: 0.32 x #aacdf7 then, 0.60 x #7c93c8 now.
    const lum = (c: THREE.Color): number => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
    const was = 0.32 * lum(new THREE.Color(0xaacdf7));
    const now = 0.32 * lum(tint.sky);
    expect(now / was).toBeGreaterThan(0.85);
    expect(now / was).toBeLessThan(1);
    // Where nothing applies the tint, the level alone decides, and it is the
    // old one: the constant is a gain on the colours, not on the intensity.
    expect(stripped('EnvironmentCycle.ts')).toContain('const NIGHT_HEMI_GAIN = 0.6 / 0.32');
  });

  test("the camera fill is turned down at night, through GameScene's getter", () => {
    const { env } = makeCycle();
    // 0.18 is its day level (GameScene); aimed from the camera it lights the
    // ground in view, so at night it goes down, not up.
    expect(env.getNightFill()).toBe(0.08);
    expect(env.getNightFill()).toBeLessThan(0.18);
  });

  test('people get their own night light: one shared uniform, in the cast shader only', () => {
    const a = new THREE.MeshToonMaterial();
    const b = new THREE.MeshToonMaterial();
    applyCelRim(a);
    applyCelRim(b);
    // v2 replaces v1: every rim material shares the one program.
    expect(a.customProgramCacheKey()).toBe('cel-rim-v2');
    expect(b.customProgramCacheKey()).toBe('cel-rim-v2');
    expect(stripped('CelLook.ts')).not.toContain('cel-rim-v1');
    const sa = compile(a);
    const sb = compile(b);
    // The same uniform OBJECT in both: a frame's update is one write.
    expect(sa.uniforms.uCelNight).toBe(sb.uniforms.uCelNight);
    expect(sa.uniforms.uCelSunDir).not.toBe(sb.uniforms.uCelSunDir);
    expect(sa.fragmentShader).toContain('uniform float uCelNight;');
    expect(sa.fragmentShader).toContain(
      'outgoingLight += diffuseColor.rgb * ( 0.6 + 0.4 * ( 1.0 - celFres ) ) * 0.075 * uCelNight;',
    );
    expect(sa.fragmentShader).toContain(
      'outgoingLight += vec3( 0.55, 0.65, 0.90 ) * smoothstep( 0.62, 0.70, celFres ) * 0.150 * uCelNight;',
    );
    // The day rim is as it was.
    expect(sa.fragmentShader).toContain(
      'outgoingLight += vec3( 1.05, 1.0, 0.92 ) * celRim * 0.28 * uCelRim;',
    );

    setCelNight(1);
    expect(sa.uniforms.uCelNight.value).toBe(1);
    withFx('celNightRim', false, () => {
      setCelNight(1);
      expect(sa.uniforms.uCelNight.value).toBe(0);
    });
    setCelNight(0);
    expect(stripped('CelLook.ts')).toContain(
      "fx.register('celNightRim', { desktop: true, low: true })",
    );
    // The cast only: Island dresses the villagers (the player's is in
    // SimplePlayer); nothing else in C's world asks for the rim.
    for (const file of ['Zones.ts', 'Mailbox.ts', 'Traffic.ts', 'Materials.ts']) {
      expect(stripped(file)).not.toContain('applyCelRim(');
    }
    expect(stripped('Island.ts').match(/applyCelRim\(/g)).toHaveLength(2);
  });

  test('the cycle drives it with the night factor: off through golden hour', () => {
    const mat = new THREE.MeshToonMaterial();
    applyCelRim(mat);
    const night = compile(mat).uniforms.uCelNight;
    const { env } = makeCycle();
    for (const [hour, want] of [
      [12, 0],
      [18, 0],
      [6, 0],
      [0, 1],
      [21, 1],
    ]) {
      env.debugHour = hour;
      env.update(1 / 60, HUB.clone().multiplyScalar(R), hour);
      expect(night.value).toBe(want);
    }
    expect(decl('EnvironmentCycle.ts', 'update')).toContain('setCelNight(night)');
  });
});

describe('a sea that stays blue (C2)', () => {
  // The sea's fresnel and haze mixed the live sky horizon in, so at dawn and
  // dusk the orange horizon WAS the sea (mean hue 356 at 06:00 and 18 at
  // 18:00, rust, against 205 at noon), the shallows showed the seabed as murk
  // and no white edge read at the waterline. Colour only: the wave sum, the
  // normals and waveHeightAt are untouched (waveMirror pins them).
  const hook = (): string => statement('Island.ts', 'seaMat.onBeforeCompile =');

  test('the horizon in the water is hue-locked, per fragment, from the live colour', () => {
    const sea = hook();
    // #1d5f8f, the deep-sea blue: its luminance, and itself at luminance 1
    // mixed 60% with white. The shader's literals are those numbers.
    const deep = new THREE.Color(0x1d5f8f);
    const luma = 0.2126 * deep.r + 0.7152 * deep.g + 0.0722 * deep.b;
    expect(luma).toBeCloseTo(0.1043, 3);
    const tint = [deep.r, deep.g, deep.b].map((c) => 0.4 + (0.6 * c) / luma);
    expect(tint[0]).toBeCloseTo(0.471, 2);
    expect(tint[1]).toBeCloseTo(1.058, 2);
    expect(tint[2]).toBeCloseTo(1.98, 2);
    expect(sea).toContain("'float skyLuma = dot(uSkyHorizon, vec3(0.2126, 0.7152, 0.0722));'");
    expect(sea).toContain(
      "'float seaLuma = 0.4 * skyLuma + 0.6 * 0.1043 * clamp(skyLuma * 2.3, 0.12, 1.0);'",
    );
    expect(sea).toContain("'vec3 seaHorizon = seaLuma * vec3(0.471, 1.058, 1.980);'");
    // Derived in the shader: bindSeaSkyColor still shares the live Color by
    // reference, and nothing derives a colour from it when it is bound.
    expect(decl('Island.ts', 'bindSeaSkyColor')).toContain(
      'this.seaSkyHorizonUniform.value = horizon',
    );
    expect(sea).toContain('shader.uniforms.uSkyHorizon = this.seaSkyHorizonUniform');
  });

  test('the fresnel and the haze use it; only the far band keeps the true horizon', () => {
    const sea = hook();
    expect(sea).toContain("'float farBand = smoothstep(0.88, 0.995, fres);'");
    expect(sea).toContain(
      "'outgoingLight = mix(outgoingLight, mix(seaHorizon, uSkyHorizon, farBand), fres * mix(0.4, 0.8, farBand));'",
    );
    expect(sea).toContain(
      "'outgoingLight = mix(outgoingLight, mix(seaHorizon, uSkyHorizon, farBand), horizonHaze * 0.45);'",
    );
    // The raw horizon never goes straight into the water any more.
    expect(sea).not.toContain('mix(outgoingLight, uSkyHorizon,');
  });

  test('the trough tint follows the day factor, shared by reference', () => {
    const sea = hook();
    expect(sea).toContain('shader.uniforms.uDayFactor = DAY_FACTOR_UNIFORM');
    expect(sea).toContain('uniform float uDayFactor;');
    expect(sea).toContain('smoothstep(0.0,-1.4,vWave)*0.45*(0.5 + 0.5*uDayFactor)');
    // EnvironmentCycle writes that same object once a frame.
    const { env } = makeCycle();
    env.debugHour = 0;
    env.update(1 / 60, HUB.clone().multiplyScalar(R), 0);
    expect(DAY_FACTOR_UNIFORM.value).toBe(0);
    env.debugHour = 12;
    env.update(1 / 60, HUB.clone().multiplyScalar(R), 1);
    expect(DAY_FACTOR_UNIFORM.value).toBe(1);
  });

  test('shallows: turquoise and opaque, the surf held back over them, a white edge at the rim', () => {
    const sea = hook();
    // #3cc6c0 in linear, mixed in at 0.85.
    const turquoise = new THREE.Color(0x3cc6c0);
    expect(turquoise.r).toBeCloseTo(0.045, 2);
    expect(turquoise.g).toBeCloseTo(0.565, 2);
    expect(turquoise.b).toBeCloseTo(0.527, 2);
    expect(sea).toContain(
      "'diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.045,0.565,0.527), shallow*shallow*0.85);'",
    );
    expect(sea).toContain(
      "'diffuseColor.a = mix(diffuseColor.a, 0.97, 1.0 - smoothstep(1.0, 1.4, d));'",
    );
    expect(sea).toContain("'foam *= 1.0 - 0.65 * shallow * shallow;'");
    // The collar is an edge: a short depth range or three pixels, whichever is wider.
    expect(sea).toContain("'float collarFade = max(uBands.x * 0.1, fwidth(d) * 3.0);'");
    expect(sea).toContain(
      "'foam = max(foam, (1.0 - smoothstep(collarIn, collarIn + collarFade, d)) * 0.9);'",
    );
    expect(sea).not.toContain('smoothstep(0.05, uBands.x, d)');
    // The collar band is authored at 2.2 of depth (5.15 m of water at R = 75).
    expect(decl('Island.ts', 'SURF_BAND_METRES')).toContain('[5.15, 6.0, 8.0]');
  });

  test('the waves are not touched: one sea program, the same displacement', () => {
    const sea = hook();
    // The sum the CPU mirrors (waveMirror.test.ts proves the parity).
    expect(sea).toContain("'float w = sin(nrm.x * 9.0 + uTime * 1.3) * 0.6'");
    expect(sea).toContain("'transformed += nrm * (w * uAmp + uTide);'");
    // No define, no second material: the program count cannot move.
    expect(sea).not.toContain('defines');
    expect(
      stripped('Island.ts').match(/const seaMat = new THREE\.MeshStandardMaterial\(/g),
    ).toHaveLength(1);
  });
});

describe('the Sailor tells visitors the beach-house code (P2-C6, decision P2-2)', () => {
  // The islet's beach house has a coded door, and nothing in the world said
  // what the code was. The Sailor gives it now; D's pin pad sends people to
  // him after a wrong try (P2-D9).

  /** A villager's authored lines, read from Island's NPC table. */
  const linesOf = (name: string): string[] => {
    const p = parse('Island.ts');
    let found: string[] | null = null;
    const visit = (n: ts.Node): void => {
      if (found) return;
      if (ts.isObjectLiteralExpression(n)) {
        const prop = (key: string): ts.Expression | undefined =>
          n.properties
            .filter(ts.isPropertyAssignment)
            .find((q) => ts.isIdentifier(q.name) && q.name.text === key)?.initializer;
        const who = prop('name');
        const lines = prop('dialogue');
        if (
          who &&
          ts.isStringLiteral(who) &&
          who.text === name &&
          lines &&
          ts.isArrayLiteralExpression(lines)
        ) {
          found = lines.elements.map((e) => (ts.isStringLiteralLike(e) ? e.text : ''));
          return;
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(p.sf);
    expect(found, `${name} has no dialogue in Island.ts`).not.toBeNull();
    return found as unknown as string[];
  };

  test('his lines give the code, and still say where the house is', () => {
    const lines = linesOf('Sailor');
    const withCode = lines.filter((l) => l.includes('5673'));
    expect(withCode).toHaveLength(1);
    expect(withCode[0]).toContain('beach house on the islet out south');
    expect(withCode[0]).toContain('door code');
    // Four digits, as the pin pad takes.
    expect(withCode[0]).toMatch(/\b\d{4}\b/);
  });

  test('it is his first written reply: one question is enough when replies are offline', () => {
    // main-simple opens with line 0 (or a live greeting) and cycles the
    // written fallbacks from index 1.
    const lines = linesOf('Sailor');
    expect(lines[1]).toContain('5673');
    expect(lines[0]).not.toContain('5673');
    expect(lines).toHaveLength(4);
  });

  test('nobody else gives it away, and the copy keeps to the Fact Sheet', () => {
    const p = parse('Island.ts');
    const hits: string[] = [];
    const visit = (n: ts.Node): void => {
      if (ts.isStringLiteralLike(n) && n.text.includes('5673')) hits.push(n.text);
      ts.forEachChild(n, visit);
    };
    visit(p.sf);
    expect(hits).toHaveLength(1);
    // Villagers are villagers: never 'agents', never 'live AI'.
    for (const l of linesOf('Sailor')) expect(l).not.toMatch(/\bagents?\b|live AI/i);
  });
});

describe('district beacons keep their colours by day and by night (P2-C5)', () => {
  // The beacon on each hall's roof is the far-read cue for its district. It
  // was tagged isNightEmissive, the drive for windows and bulbs: 0.15 by day
  // (the cue was out), and at night 30% toward amber, which turned
  // Professional's blue (#2196f3) into a grey lavender (#9798d2) while the
  // HUD and the minimap kept the district colours.
  const DISTRICT_COLOURS: Array<[string, number]> = [
    ['welcome', 0x4caf50],
    ['professional', 0x2196f3],
    ['personal', 0xe91e63],
    ['contact', 0x9c27b0],
    ['projects', 0xff9800],
  ];
  const stubIsland = {
    sampleSurfaceByDirection: () => {
      throw new Error('stub: Zone falls back to an ideal-sphere seat');
    },
    getRadius: () => 100,
  } as unknown as Island;

  type Emissive = THREE.MeshStandardMaterial | THREE.MeshToonMaterial;
  const matOf = (o: THREE.Object3D | undefined): Emissive => (o as THREE.Mesh).material as Emissive;

  /** The five halls on a scene, and a cycle built over them. */
  const town = (): {
    env: EnvironmentCycle;
    halls: Array<{ id: string; colour: number; marker: THREE.Object3D }>;
  } => {
    installHeadlessCanvas();
    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x79b7e6, 0.0045);
    const halls = DISTRICT_COLOURS.map(([id, colour], i) => {
      const zone = new Zone(
        {
          id,
          name: id,
          description: '',
          position: dirAt(i * 1.2, 0.46).multiplyScalar(R),
          color: colour,
          icon: 'x',
        },
        stubIsland,
      );
      scene.add(zone.marker);
      return { id, colour, marker: zone.marker };
    });
    const env = new EnvironmentCycle(
      scene,
      new THREE.DirectionalLight(0xffe9c0, 1.6),
      new THREE.HemisphereLight(0xaacdf7, 0x4a6b32, 0.62),
      {
        topColor: { value: new THREE.Color() },
        bottomColor: { value: new THREE.Color() },
        horizonColor: { value: new THREE.Color() },
      },
    );
    return { env, halls };
  };

  test('1.0 by day and 1.3 at night, in the authored colour at every hour', () => {
    const { env, halls } = town();
    for (const [hour, want] of [
      [12, 1.0],
      [18, 1.0],
      [21, 1.3],
      [0, 1.3],
      [9, 1.0],
    ]) {
      env.debugHour = hour;
      env.update(1 / 60, HUB.clone().multiplyScalar(R), hour);
      for (const h of halls) {
        const mat = matOf(h.marker.getObjectByName('zone-beacon'));
        expect(mat.emissiveIntensity).toBeCloseTo(want, 9);
        expect(mat.emissive.getHex()).toBe(h.colour);
      }
    }
  });

  test('windows and the door lamp keep the old drive: dim by day, amber at night', () => {
    const { env, halls } = town();
    const hall = halls[1].marker;
    const tagged: Emissive[] = [];
    hall.traverse((o) => {
      if (o.userData.isNightEmissive) tagged.push(matOf(o));
    });
    expect(tagged.length).toBeGreaterThan(4);
    env.debugHour = 12;
    env.update(1 / 60, HUB.clone().multiplyScalar(R), 0);
    for (const m of tagged) expect(m.emissiveIntensity).toBeCloseTo(0.15, 9);
    env.debugHour = 0;
    env.update(1 / 60, HUB.clone().multiplyScalar(R), 1);
    const amber = new THREE.Color(0xffe6a8).lerp(new THREE.Color(0xff9c46), 0.3).getHex();
    for (const m of tagged) {
      expect(m.emissiveIntensity).toBeCloseTo(1.3, 9);
      expect(m.emissive.getHex()).toBe(amber);
    }
  });

  test('the beacon carries no night tag, and is found by name whatever it is tagged', () => {
    const { halls } = town();
    for (const h of halls) {
      const beacon = h.marker.getObjectByName('zone-beacon');
      expect(beacon).toBeDefined();
      expect(beacon?.userData.isNightEmissive).toBeUndefined();
    }
    // A stale tag (an old save of the scene, a future edit) cannot put a
    // beacon back on the window drive: the name wins.
    const scene = new THREE.Scene();
    const stale = new THREE.Mesh(
      new THREE.OctahedronGeometry(0.26, 0),
      new THREE.MeshStandardMaterial({ color: 0x2196f3, emissive: 0x2196f3 }),
    );
    stale.name = 'zone-beacon';
    stale.userData.isNightEmissive = true;
    scene.add(stale);
    installHeadlessCanvas();
    const env = new EnvironmentCycle(
      scene,
      new THREE.DirectionalLight(0xffe9c0, 1.6),
      new THREE.HemisphereLight(0xaacdf7, 0x4a6b32, 0.62),
      {
        topColor: { value: new THREE.Color() },
        bottomColor: { value: new THREE.Color() },
        horizonColor: { value: new THREE.Color() },
      },
    );
    env.debugHour = 0;
    env.update(1 / 60, HUB.clone().multiplyScalar(R), 0);
    expect(matOf(stale).emissive.getHex()).toBe(0x2196f3);
    expect(matOf(stale).emissiveIntensity).toBeCloseTo(1.3, 9);
    // The tag is gone from the source too; the other four tags in Zones stay.
    const building = decl('Zones.ts', 'createBuilding');
    expect(building).not.toContain('beacon.userData.isNightEmissive');
    expect(stripped('Zones.ts').match(/userData\.isNightEmissive = true/g)).toHaveLength(4);
  });
});
