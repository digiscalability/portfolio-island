// Locks for the wave-8 visual/gameplay polish pass (asset grounding, slope
// feel, cloud flicker/shapes, HUD chip unification).
//
// Each block pins a fix that was MEASURED broken live:
//  - grounding: five independent World-Law-1 violations (halls 10.2 deg,
//    watch post 12.3 deg, cars re-tilted by a wheel-plane normal, blocks,
//    benches) — all the same class: a slope normal fed where the plumb
//    radial belongs, or `faceObjectToward` handed a different axis than the
//    seat (its premultiply then re-tilts what was just made vertical).
//  - slopes: binary ground check scalloped downhill runs (+0.67u hops at
//    speed 15.4) and dropped jump presses on crests; uphill was a free
//    escalator (full speed regardless of grade).
//  - clouds: transparent blobs sorted by ORIGIN distance with depthWrite on
//    at partial alpha (popping), coplanar per-blob bases z-fighting, a 70:1
//    cirrus razor, and the storm tower pancake-visible all 'cloudy' long.
//  - HUD: five hand-rolled chip recipes (four backgrounds, three radii, two
//    font sizes) drifted into the screenshotted right-edge mess.
//
// These are SOURCE locks: comments are stripped before matching so a lock
// can never be satisfied by its own explanatory prose (a trap this suite
// has hit three times).
//
// OWNERSHIP (UX plan testOwnership): this suite pins package B's files. The
// assertions it held on main-simple.ts and OrbitCamera.ts moved to A's
// test/mainLocks.test.ts, on SimpleUI.ts to D's test/uiLocks.test.ts and on
// SimpleRenderer.ts to E's test/rendererLocks.test.ts, and those on the
// world-look files (Island, Zones, Mailbox, EnvironmentCycle, Traffic, CelLook)
// to C's test/worldLook.test.ts. A split test keeps its name in both files.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { ShaderChunk } from 'three';
import { describe, expect, test } from 'vitest';

const src = (f: string): string =>
  readFileSync(join(process.cwd(), f), 'utf8')
    .replace(/\r\n/g, '\n') // a Windows stash pop once flipped these to CRLF
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');

/**
 * The brace-balanced block a marker belongs to.
 * - A declaration or block opener (a `{` comes before any `;`): from the marker
 *   to the brace that closes the block it opens.
 * - A statement (a `;` comes first): the whole block that encloses it, from
 *   the brace that opens that block to the brace that closes it.
 */
const bodyOf = (s: string, marker: string): string => {
  const at = s.indexOf(marker);
  expect(at, `${marker} not found`).toBeGreaterThan(-1);
  const brace = s.indexOf('{', at);
  const semi = s.indexOf(';', at);
  if (brace > -1 && (semi === -1 || brace < semi)) {
    let depth = 0;
    for (let i = brace; i < s.length; i++) {
      if (s[i] === '{') depth++;
      else if (s[i] === '}' && --depth === 0) return s.slice(at, i + 1);
    }
    return s.slice(at);
  }
  let open = 0;
  for (let i = at - 1, depth = 0; i >= 0; i--) {
    if (s[i] === '}') depth++;
    else if (s[i] === '{' && depth-- === 0) {
      open = i;
      break;
    }
  }
  for (let i = at, depth = 0; i < s.length; i++) {
    if (s[i] === '{') depth++;
    else if (s[i] === '}' && depth-- === 0) return s.slice(open, i + 1);
  }
  return s.slice(open);
};

describe('asset grounding — World Law 1 (plumb radial up-axis)', () => {
  test('parked cars: plumb placement, wheel probe only adjusts RADIUS', () => {
    const scene = src('GameScene.ts');
    // Both the initial parking and the disembark re-park hand placeVehicle
    // the radial dir, not a fitted plane normal.
    const parks = scene.match(/this\.placeVehicle\(v, v\.radius, v\.dir\)/g) ?? [];
    expect(parks.length).toBeGreaterThanOrEqual(2);
    // fitParkedCarSeat: seat at the LOWEST wheel contact (bury-not-float) —
    // and no quaternion write at all (the old plane-fit overwrote Island's
    // plumb seat with a wheel-plane normal).
    const start = scene.indexOf('private fitParkedCarSeat');
    const body = scene.slice(start, scene.indexOf('private ', start + 20));
    expect(body).toContain('let minH = Infinity');
    expect(body).toContain('if (Number.isFinite(minH)) v.radius = minH + 0.06');
    expect(body).not.toContain('setFromUnitVectors');
  });

  test('islet beach house stands plumb', () => {
    const scene = src('GameScene.ts');
    const start = scene.indexOf('private setupIsletBeachHouse');
    const body = scene.slice(start, start + 1600);
    expect(body).toContain('s.position.clone().normalize()');
  });
});

describe('slope feel — snap-down, uphill cost, coyote jump', () => {
  test('grounded snap-down window keeps downhill runs glued (no scallops)', () => {
    const player = src('SimplePlayer.ts');
    expect(player).toMatch(/gap <= 0 \|\| \(this\.isGrounded && vRad <= 0\.5 && gap < 0\.35\)/);
    // Landing/snapping cancels the into-surface velocity component, else the
    // next substep re-launches the hop it just absorbed.
    expect(player).toContain('this.velocity.addScaledVector(surfaceNormal, -vRad)');
  });

  test('uphill slope cost is gated to grounded, non-swimming movement', () => {
    const player = src('SimplePlayer.ts');
    // Ungated, the cost also cut swim speed below the 4.0 u/s shoreline
    // current (trapping swimmers) and nerfed air control.
    expect(player).toMatch(
      /this\.isGrounded && !this\.swimming && this\.groundSampler && moveDir\.lengthSq\(\) > 1e-6/,
    );
    expect(player).toMatch(/clamp\(1 \/ \(1 \+ Math\.max\(0, grade\) \* 0\.9\), 0\.55, 1\)/);
  });

  test('coyote jump: 120ms grace, and SOUND AND PHYSICS share one edge', () => {
    // The shared sound/physics edge itself lives in main-simple.ts: that half
    // of this test is in A's mainLocks.
    const player = src('SimplePlayer.ts');
    expect(player).toContain('COYOTE_MS = 120');
    expect(player).toContain('public canJump()');
  });
});

describe('clouds — stable compositing + non-degenerate shapes', () => {
  test('geometry retune stays constants-only (rng draw order intact)', () => {
    const clouds = src('CloudFormations.ts');
    // Per-blob floors kill the coplanar-base z-fight (0.05u beats 24-bit
    // depth precision at cloud altitude).
    expect(clouds).toContain('idx * 0.05');
    // Cirrus: 0.26 thickness on shorter extents (was 0.1 on up-to-3.5u — a
    // 70:1 razor that vanished edge-on and strobed at any sort flip).
    expect(clouds).toMatch(/s\.scale\(3\.5 \+ rng\(\) \* 2\.0, 0\.26, 0\.7 \+ rng\(\) \* 0\.4\)/);
    // Slabs fattened, cluster satellites pulled in + lifted off the plane.
    expect(clouds).toMatch(/s\.scale\(2\.4 \+ rng\(\) \* 0\.8, 0\.48, 1\.5 \+ rng\(\) \* 0\.5\)/);
    expect(clouds).toMatch(/const d = 2\.2 \+ rng\(\) \* 1\.4/);
  });

  test('cross-set compositing is pinned and depthWrite tracks opacity', () => {
    const scene = src('GameScene.ts');
    // Fair under storm always — renderOrder beats the origin-distance sort
    // that flipped per camera step. FRACTIONAL (0.1/0.2, not 10/11): the pin
    // must stay BELOW the ground transparents (shadow blobs 1, name pills 2,
    // chat bubbles 3) or clouds paint over pills silhouetted against the sky.
    expect(scene).toMatch(/renderOrder = spec\.set === 'fair' \? 0\.1 : 0\.2/);
    // depthWrite only when fully opaque: a half-faded cloud writing depth
    // punched holes in everything sorted behind it.
    expect(scene).toContain('this.cloudMat.depthWrite = this.cloudMat.opacity >= 0.999');
    // The storm tower hides until it actually grows — 'cloudy' (wet 0.55)
    // left it a permanently visible squashed pancake before.
    expect(scene).toContain('this.towerMesh.visible = this.towerGrow > 0.05');
    // The storm set must be ABLE to reach the depthWrite gate: a flat 0.95
    // ceiling meant full-rain skies never regained self-occlusion.
    expect(scene).toContain('this.stormCloudMat.opacity = Math.min(1, 1.06 * this.cloudWet)');
  });

  test('the depthWrite class is closed at the other flagged sites', () => {
    // Same failure shape as the clouds, found by the follow-up sweep: a
    // transparent material that writes depth is an invisible mask at low
    // opacity and punches holes behind itself at partial opacity. (The
    // Mailbox.ts glow half is C's, in test/worldLook.test.ts.)
    const race = src('RaceSystem.ts');
    const ring = race.slice(race.indexOf('emissive: 0x2266aa'));
    expect(ring.slice(0, 400)).toContain('depthWrite: false');
  });
});

describe('roads read as roads — kerbs, centre line, and off the camera ray', () => {
  test('pedestrian crossings lie FLAT and clear the ribbon lift', () => {
    const scene = src('GameScene.ts');
    expect(scene).toContain("mesh.name = 'road_markings_instanced'");
    // Built after restoreRandom() alongside the traffic fleet, so it cannot
    // consume from the seeded stream.
    const restore = scene.indexOf('restoreRandom();');
    expect(scene.indexOf('this.createRoadMarkings()')).toBeGreaterThan(restore);
    // RIGHT-HANDED basis (X x Y = Z). crossVectors(nrm, tan) gives an
    // improper matrix and stands every bar on edge like a fence panel —
    // measured face-dot-up 0.14 instead of 1.0 before this was fixed.
    expect(scene).toContain('crossVectors(tan, nrm)');
    // Paint must clear the road's own alternating parity lift (0.04/0.055).
    expect(scene).toContain('s.position.length() + 0.09');
    expect(scene).toContain('polygonOffsetFactor: -4');
  });
});

describe('engine smoothness — no mid-flight recompile, no wasted frames', () => {
  test('the boot precompile bakes the permutation frame 1 will use', () => {
    const scene = src('GameScene.ts');
    // three bakes NUM_POINT_LIGHTS/NUM_SPOT_LIGHTS into every lit material's
    // program key. Lights are born visible and are only gated once update()
    // runs — after this compile — so the precompile used to bake the NIGHT
    // permutation and the first daylight frame invalidated EVERY lit program
    // at once, mid fly-in. Measured after priming: 174 -> 103 programs and
    // ZERO programs added by the first render. (That main-simple primes BEFORE
    // its compileAsync is pinned in A's mainLocks.)
    expect(scene).toContain('public primeExteriorLightGate()');
    // Booleans only — safe before restoreRandom, no uuid, no Math.random.
    const start = scene.indexOf('public primeExteriorLightGate()');
    const body = scene.slice(start, scene.indexOf('\n  }', start));
    expect(body).toContain('l.visible = on');
    expect(body).not.toContain('new THREE.');
  });

  test('the interior window stops re-rendering a frozen world', () => {
    const scene = src('GameScene.ts');
    // update() early-returns into updateInteriorMode while inside, which
    // freezes the island — so the 2s heartbeat was re-rendering the whole
    // ~1300-draw scene into a byte-identical texture for the whole visit.
    expect(scene).not.toContain('this.interiorViewAccum += deltaTime');
    // Re-entry must still repaint: aimInteriorOutlook seeds the accumulator.
    expect(scene).toContain('this.interiorViewAccum = GameScene.INTERIOR_VIEW_INTERVAL');
  });

  // 'the camera size filter applies to every root' (OrbitCamera.ts) moved to
  // A's mainLocks.

  test('tree sway writes the quaternion once, not twice', () => {
    const scene = src('GameScene.ts');
    // Every Object3D.quaternion write fires three's onChange -> Euler
    // back-conversion (asin + 2 atan2). copy().multiply() on the LIVE
    // quaternion paid it twice per tree per frame, 768 times across 384 trees.
    expect(scene).toContain('this._swayQuat.premultiply(tr.baseQuat)');
    // Exactly ONE double-write may remain, and it is the FELLING branch (a
    // chopped tree tipping over — at most one tree at a time, not per-frame
    // work across the whole population).
    const doubles = scene.match(/tr\.group\.quaternion\.copy\(tr\.baseQuat\)\.multiply\(/g) ?? [];
    expect(doubles.length).toBe(1);
  });
});

describe('ring traffic — alive, but structurally unable to break the world', () => {
  test('constructed OUTSIDE the seeded window, and never networked', () => {
    const scene = src('GameScene.ts');
    // three spends 4 Math.random draws per object on uuids, so a fleet built
    // during generation would re-roll every later placement — and the parked
    // cars are addressed BY INDEX over the multiplayer wire. Building after
    // restoreRandom() makes that structurally impossible.
    const restore = scene.indexOf('restoreRandom();');
    const build = scene.indexOf('new TrafficSystem(');
    expect(restore).toBeGreaterThan(-1);
    expect(build).toBeGreaterThan(restore);
    // Decorative only: never pushed into the networked vehicle array.
    expect(scene).not.toMatch(/vehicles\.push\([^)]*traffic/i);
    // Fed the villagers + player so it brakes instead of driving through.
    expect(scene).toContain('this.traffic?.update(');
    expect(scene).toContain('this.island ? this.island.npcTargets : null');
  });
});

describe('sky — soft posterization with a hard horizon contract', () => {
  // The shipped transfer, mirrored here so the CONTRACT is pinned as maths,
  // not just as source text. Any edit to the GLSL must keep these properties.
  const SOFT = 0.25;
  const smoothstep = (a: number, b: number, x: number): number => {
    const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  };
  const transfer = (t: number, bands = 5): number => {
    if (bands <= 0.5) return t;
    const s = t * bands;
    const band = Math.floor(s);
    const f = s - band;
    return (band + smoothstep(0.5 - SOFT, 0.5 + SOFT, f)) / bands;
  };

  test('the h=0 horizon contract holds EXACTLY (fog + sea consume horizonColor)', () => {
    // The old form returned 0.065 here, so pow(0.065, 0.35) = 0.384 put the
    // dome 38% toward topColor at the waterline while fog and the sea fresnel
    // sat on pure horizonColor — a MEASURED 43/255 desync in red at dusk.
    expect(transfer(0)).toBe(0);
    // ...and every band boundary is pinned, which is WHY the horizon is: the
    // half-band phase puts plateaus on the multiples of 1/bands.
    for (let k = 0; k <= 5; k++) expect(transfer(k / 5)).toBeCloseTo(k / 5, 10);
  });

  test('the zenith does not overshoot topColor', () => {
    // The old form returned 1.065 at t=1 — pow(1.065, 0.35) = 1.022, i.e. the
    // mix EXTRAPOLATED past topColor.
    expect(transfer(1)).toBe(1);
  });

  test('no discontinuity anywhere — the seam is gone', () => {
    let worst = 0;
    let prev = transfer(0);
    for (let i = 1; i <= 20000; i++) {
      const v = transfer(i / 20000);
      worst = Math.max(worst, Math.abs(v - prev));
      prev = v;
    }
    // Old form: a 0.13 JUMP at every multiple of 1/bands (measured 22/255 on
    // the framebuffer at noon). Peak slope here is 0.75/SOFT = 3x identity,
    // so across a 5e-5 sample step the largest legal delta is ~1.5e-4.
    expect(worst).toBeLessThan(1e-3);
  });

  test('the painted BAND look survives — half of every band stays flat', () => {
    // Abbas A/B-chose the banded sky; this must not quietly become smooth.
    let flat = 0;
    for (let i = 1; i <= 20000; i++) {
      if (Math.abs(transfer(i / 20000) - transfer((i - 1) / 20000)) < 1e-9) flat++;
    }
    expect(flat / 20000).toBeGreaterThan(0.45);
    // ?sky=smooth still bypasses banding entirely.
    expect(transfer(0.37, 0)).toBe(0.37);
  });

  test('the shader ships that transfer, and the broken one cannot come back', () => {
    const scene = src('GameScene.ts');
    expect(scene).toContain('const float SOFT = 0.25');
    expect(scene).toContain('t = (band + smoothstep(0.5 - SOFT, 0.5 + SOFT, f)) / uBands');
    // The old block, in any form.
    expect(scene).not.toContain('(f / steps) * 0.35');
    expect(scene).not.toContain('(0.325 / steps)');
    // uBands stays the taste lever and ?sky=smooth the escape hatch.
    expect(scene).toContain("get('sky') === 'smooth' ? 0.0 : 5.0");
  });
});

describe('per-frame sweeps — allocation-free hot paths and instanced fleets', () => {
  // The HUD chip-recipe tests that opened this block ('CHIP/CHIP_ICON exist…',
  // '38px row pitch…', 'demotions and accent discipline', 'per-frame HUD
  // writers…') read only SimpleUI.ts and moved to D's uiLocks. 'startup:
  // Firebase deferred, postprocessing preloaded…' moved to A's mainLocks
  // (main-simple.ts) and E's rendererLocks (SimpleRenderer.ts).

  test('per-frame hot paths stay allocation-free (sweep round 2)', () => {
    // The sweep measured the camera + player physics as the two densest
    // per-frame allocation clusters (~20 heap objects/frame combined, the
    // player's doubled by the substep split exactly on slow frames). These
    // pin the scratch-field conversions; `.clone()` reappearing in either
    // body is the regression. (The OrbitCamera half is in A's mainLocks.)
    const player = src('SimplePlayer.ts');
    const applyBody = player.slice(
      player.indexOf('private applyMovement'),
      player.indexOf('private settleMovement'),
    );
    expect(applyBody).not.toContain('.clone()');
    expect(applyBody).not.toContain('this.getSurfaceNormal()');
    expect(player).toContain('public getSurfaceNormalInto');
    expect(player).toContain('public getVelocityInto');

    // The NPC wander loop: one Set lookup, not three per-NPC closures.
    const scene = src('GameScene.ts');
    expect(scene).toContain('this.pinnedNpcs.has(npc)');
    expect(scene).not.toContain('this.sailors.some((s) => s.npc === npc)');
    expect(scene).not.toContain('this.vendors.some((v) => v.npc === npc)');
    expect(scene).not.toContain('this.campfireGuests.some((g) => g.npc === npc)');
    // (The Island.ts half, the NPC-shadow pass reading a view, is C's, in
    // test/worldLook.test.ts.)
  });

  test('per-frame position reads use the Into variant (sweep round 3)', () => {
    const scene = src('GameScene.ts');
    // Each per-frame consumer owns its scratch; collisions keep a DEDICATED
    // buffer because they mutate it in place as the write-back. (The
    // main-simple.ts audio/compass scratches are pinned in A's mainLocks.)
    for (const s of [
      'getWorldPositionInto(this._collidePos)',
      'getWorldPositionInto(this._npcPlayerPos)',
      'getWorldPositionInto(this._puffPlayerPos)',
      'getWorldPositionInto(this._radarPos)',
      'getWorldPositionInto(this._gbPlayerPos)',
      'getWorldPositionInto(this._nearPos)',
    ]) {
      expect(scene).toContain(s);
    }
  });

  test('exterior lights + zero-alpha overlays leave the pipeline by day (round 4)', () => {
    // (The EnvironmentCycle.ts half, the one shared 0.85 cutoff and the
    // pinned night intensities, is C's, in test/worldLook.test.ts.)
    const scene = src('GameScene.ts');
    expect(scene).toContain('slot.light.visible = on');
    expect(scene).toContain('this.lampPoolMat.visible = this.lampPoolMat.opacity > 0.01');
    expect(scene).toContain('ud.beamMat.visible = ud.beamMat.opacity > 0.01');
  });

  test('the lamp fleet is two instanced draws, discovery contract intact', () => {
    // (The Island.ts half, the fleet itself, is C's, in test/worldLook.test.ts.)
    // GameScene fetches the single shared bulb material by name (the anchor
    // traversal finds nothing on the island lamps now).
    expect(src('GameScene.ts')).toContain("getObjectByName('streetlamp_bulbs_instanced')");
  });

  test('GLB clones collapse to instanced draws, and the fade stops leaking transparency', () => {
    // (The Island.ts half, the collapse and the fade restore, is C's, in
    // test/worldLook.test.ts.) GameScene owns the island teardown
    // (Island.dispose has no callers), so the instanceMatrix release has to
    // live there too.
    const scene = src('GameScene.ts');
    expect(scene).toContain('if (inst.isInstancedMesh) inst.dispose()');
  });

  test('villagers cull with an inflated pose-proof sphere (round 4)', () => {
    const npc = src('NPC.ts');
    // frustumCulled=false kept ~28 skinned draws in BOTH passes from
    // anywhere on the planet. The OBJECT-level sphere (the one Frustum
    // prefers on SkinnedMesh) inflated 2.5x keeps the pop-out fix.
    expect(npc).toContain('sm.computeBoundingSphere()');
    expect(npc).toContain('sm.boundingSphere.radius *= 2.5');
    expect(npc).not.toContain('object.frustumCulled = false');
  });

  // 'chip-recipe regressions from the follow-up review stay fixed'
  // (SimpleUI.ts) moved to D's uiLocks.
});

describe('smoothness round 2 — the two measured hitches', () => {
  // Moved with their files: 'music slices keep a time budget…' and 'bloom
  // turns on at arrival…' to A's mainLocks; 'bloom FADES in at the reveal…'
  // to A's mainLocks and E's rendererLocks; 'desktop drops the unused canvas
  // MSAA buffer…' and 'warmUp compiles the bloom pass…' to E's
  // rendererLocks; 'blocked localStorage cannot brick the welcome card' and
  // 'page teardown does not burn the first-run welcome unread' to D's uiLocks.

  test('the market vendor faces its shopper spot, not the nearest street', () => {
    const scene = src('GameScene.ts');
    const start = scene.indexOf('private setupVendors');
    expect(start).toBeGreaterThan(-1);
    const body = scene.slice(start, scene.indexOf('private ', start + 20));
    // MEASURED: for stall 2 the nearest street is 76deg off the counter-front,
    // so the vendor stood sideways to shoppers at its own stall. Face the
    // shopper spot (the counter-front it stepped back from) instead.
    expect(body).toContain('const shopperSpot = this.island.stallSites[si]');
    expect(body).toContain(
      'this.orientAvatar(npc.meshRef, surf.normal, this._sailTmp.normalize())',
    );
    expect(body).not.toMatch(
      /const street = this\.island\.nearestStreetDir\(dir[\s\S]{0,200}orientAvatar/,
    );
  });

  test('remote peers cull like NPCs, and idle presence writes are suppressed (scale)', () => {
    const sp = src('SimplePlayer.ts');
    // Peers used a blunt frustumCulled=false, so each peer's ~13 skinned parts
    // rendered + skinned from anywhere on the planet — O(total peers). Same
    // 2.5x-sphere cull as NPC.ts → O(peers on-screen). Verified: 9/9 peer
    // skinned parts get a valid boundingSphere (clone is bound at traverse).
    expect(sp).not.toContain(
      'if ((o as THREE.SkinnedMesh).isSkinnedMesh) o.frustumCulled = false;',
    );
    expect(sp).toMatch(
      /isSkinnedMesh\) \{\s*const sm = o as THREE\.SkinnedMesh;\s*sm\.computeBoundingSphere\(\);\s*if \(sm\.boundingSphere\) sm\.boundingSphere\.radius \*= 2\.5;/,
    );

    const mp = src('Multiplayer.ts');
    // Presence delivery is O(N²); a stationary/AFK visitor otherwise floods the
    // whole-room node 10x/s with byte-identical packets — the first thing to
    // blow the RTDB egress budget at scale. Suppress identical packets, keep a
    // <=1Hz keepalive so peers (3.5s prune) never drop us. Verified: 97% idle
    // write reduction, moving sends every packet.
    expect(mp).toContain(
      'if (packet === this._lastPacket && now - this._lastPacketAt < 1) return;',
    );
    expect(mp).toContain('const packet = JSON.stringify(msg);');
    // Peer-count-adaptive broadcast: a MOVING solo visitor (dirty-check can't
    // help — the packet changes every step) drops from 10Hz to 1Hz uplink;
    // crowds ramp toward 5Hz to bend the O(N²) curve. The send gate must be the
    // computed interval, NOT a hardcoded 0.1.
    expect(mp).toContain('if (this.sendAccum > sendInterval) {');
    expect(mp).toContain('n === 0 ? 1.0 : n <= 12 ? 0.1 : n >= 24 ? 0.2');
    expect(mp).not.toContain('if (this.sendAccum > 0.1) {');
    // Cold meta (name/hat/founder/cols) is split onto meta/island so it stops
    // riding every 10Hz delivery. The HOT write must carry NO cold fields; the
    // meta node is written on change; the reader merges meta with an old-client
    // fallback to the hot node's own fields.
    const hotWrite = mp.slice(mp.indexOf('set(myNode, {'), mp.indexOf('}).catch(() => {});'));
    expect(hotWrite).not.toContain('name:');
    expect(hotWrite).not.toContain('founder:');
    expect(hotWrite).not.toContain('cols:');
    expect(mp).toContain("const metaRoomPath = 'meta/island';");
    expect(mp).toContain('set(myMetaNode, {');
    expect(mp).toContain('name: m?.name ?? v.name,'); // reader merge + fallback
  });

  test('the player avatar does not self-shadow (no acne flicker)', () => {
    const p = src('SimplePlayer.ts');
    // A skinned avatar under the single whole-planet directional shadow map
    // self-shadows into coarse acne that DANCES as the mesh deforms — measured
    // as the "user flickering" (walking A/B: 19.3% of player pixels oscillating
    // with receiveShadow on vs 5.2% off). The avatar still CASTS its grounding
    // shadow. All three avatar paths (local GLB, remote peer, fallback body)
    // must agree — World Law 2, or a peer flickers on everyone else's screen.
    expect(p).not.toMatch(/receiveShadow = true/); // no avatar mesh receives shadow
    expect(p).toContain('obj.receiveShadow = false'); // local player GLB
    expect(p).toContain('o.receiveShadow = false'); // remote peer GLB
    // Casting is preserved (grounding shadow stays).
    expect(p).toContain('obj.castShadow = true');
    expect(p).toContain('o.castShadow = true');
  });

  // The swim-stroke lock (local AND remote-peer copies) lives in
  // test/swimStroke.test.ts. It used to be a source pin here, and the pinned
  // text was itself the bug: `REST_X - swimPhase` / `-Math.PI - swimClock`
  // measured as a REVERSED crawl. Text cannot tell a crawl from its mirror
  // image, so that suite drives both pose paths on player.glb and checks
  // where the hand actually goes.

  test('a felled stump is drivable, not merely walkable', () => {
    const scene = src('GameScene.ts');
    // The felled-tree lifecycle switches a collider OFF through the `owner`
    // back-reference instead of removing it from the list, so EVERY consumer
    // has to honour that flag. checkPlayerCollisions did; resolveCarCollision
    // did not. REPRODUCED in-game before the fix: after chopping a tree, the
    // stump shoved the car 0.97u — bit-identical to the standing tree's push —
    // so the player could walk through a spot their own car bounced off.
    const start = scene.indexOf('private resolveCarCollision');
    expect(start).toBeGreaterThan(-1); // indexOf(-1) would slice the whole file
    const body = scene.slice(start, scene.indexOf('\n  }', start));
    expect(body).toContain('if (c.owner?.userData.felled) continue;');
    // ...and the player path keeps its own guard, so the two agree.
    expect(scene).toContain('if (collider.owner?.userData.felled) continue;');
  });

  test('peer teardown and the interior rain handle do not leak or go stale', () => {
    const mp = src('Multiplayer.ts');
    // Detaching an Object3D frees nothing on the GPU. Each peer owns two
    // canvas-backed sprite textures plus a procedural fallback body and hat;
    // a flaky peer re-minted them on every rejoin.
    expect(mp).toContain('m.map?.dispose()');
    expect(mp).toContain('peer.fallbackParts = []');
    expect(mp).toContain('peer.hatMesh?.traverse');

    const scene = src('GameScene.ts');
    // EnvironmentCycle REBUILDS the precipitation volume on a weather change
    // (removes and disposes the old Points), so a handle cached once at first
    // use points at a disposed orphan and the interior window silently shows a
    // dry night in a storm — the exact bug the borrow exists to fix.
    expect(scene).toContain('if (!this.interiorRainNode || !this.interiorRainNode.parent)');
  });

  test('the contact form cannot strand itself or blame a good email', () => {
    // The SimpleUI.ts half (lead_failed copy, Boards imported inside try) is
    // in D's uiLocks. firebaseClient.ts has no owner this round, so its half
    // stays here.
    const fb = src('firebaseClient.ts');
    // `if (!ready)` is false for a REJECTED promise, so one transient auth or
    // network failure disabled the backend for the whole session with no retry.
    expect(fb).toMatch(/ready = ready\.catch\(/);
    expect(fb).toMatch(/ready = null;\s*throw e;/);
  });

  test('the sky measures elevation from the eye, not the world origin', () => {
    const scene = src('GameScene.ts');
    // The dome is STATIC at the origin with R=800 while the camera orbits at
    // r=100-120, so an origin-relative direction is wrong by asin(r/800).
    // MEASURED on prod: 6.35-8.58 deg across the frame, and ALTITUDE
    // DEPENDENT (7.34 deg in town vs 8.52 deg on the summit) — the band
    // ladder crept as you climbed. Confirmed a second way by pixel diff:
    // the fixed gradient is the old one shifted down 91px of 910, i.e. the
    // same ~7.4 deg, and 52.8% of the frame changed.
    expect(scene).toContain('normalize(vWorldPosition - cameraPosition)');
    expect(scene).not.toContain('normalize(vWorldPosition + offset)');
    // `offset` was a float added to a VEC3, which broadcasts — it translated
    // the dome diagonally rather than lifting it. Nothing ever wrote it, so
    // the uniform is deleted rather than left looking like a tuning knob.
    expect(scene).not.toMatch(/uniform float offset;/);
    expect(scene).not.toMatch(/offset: \{ value: 0 \}/);
  });

  test('the idle warm can never blink a room the player is standing in', () => {
    const scene = src('GameScene.ts');
    // idleDefer(cb, 9000) is a CEILING, not a delay: the callback can fire
    // early and a player can reach a door inside that window. warm(false)
    // would then hide the room they are in across an awaited frame.
    expect(scene).toMatch(
      /if \(this\.insideInterior\) \{\s*this\.interiorWarmed = true;\s*return;/,
    );
    // And a real entry retires the pending warm — it has already done all of
    // the same work for real, so the idle pass has nothing left to warm.
    expect(scene).toMatch(/this\.buildInterior\(\);\s*this\.interiorWarmed = true;/);
    // THE ENTRY GUARD ALONE IS NOT ENOUGH, and shipping it that way was a bug.
    // The warm yields between slices and while it polls; a player pressing E
    // inside that window sets visible=true, then a resumed warm set it back
    // to false and NOTHING re-arms visibility mid-visit (interiorGroup.visible
    // = true appears exactly once, in enterInterior). They stood in a building
    // with no walls, floor or furniture for the whole visit. So every
    // visibility write re-checks the flag on the far side of every await.
    expect(scene).toMatch(
      /const warm = async \(visible: boolean\): Promise<void> => \{\s*if \(this\.insideInterior\) return;/,
    );
    expect(scene).toContain('if (!this.insideInterior) g.visible = wasVisible;');
    // And no frame ever draws the room-lit variants while they compile (B2):
    // each slice shows the room, compiles and hides it again in ONE task.
    // MEASURED on main, awaiting compileAsync with the room shown let the next
    // frame block 2,043 ms finishing them.
    const pass = bodyOf(scene, 'private async compileInteriorPass(');
    const slice = pass.slice(
      pass.indexOf('g.visible = roomVisible;'),
      pass.indexOf('if (!this.insideInterior) g.visible = wasVisible;'),
    );
    expect(slice).toContain('gl.compile(chunk, camera, proxy)');
    expect(slice).not.toContain('await');
    expect(bodyOf(scene, 'private async warmInteriorPasses(')).not.toContain('compileAsync');
  });

  test('the interior is built and compiled in idle time, not on the first E', () => {
    const scene = src('GameScene.ts');
    // MEASURED on prod: 219 meshes / 74 materials in 16.3ms, plus 39 shader
    // programs (103 -> 142) on the first frame that shows the room — the room
    // carries 4 PointLights and three.js bakes light COUNTS into every lit
    // program's cache key, so opening a door re-keys the entire scene.
    expect(scene).toContain('public async warmInterior()');
    expect(scene).toContain('if (this.interiorWarmed) return;');
    // BOTH permutations: leaving costs compiles too, because the light count
    // drops back when the group is hidden again.
    expect(scene).toContain('await warm(true)');
    expect(scene).toContain('await warm(false)');
    // Restores whatever visibility it found — warming must never leave the
    // room showing, nor hide a room the player is standing in.
    expect(scene).toContain('g.visible = wasVisible');
    // (Off the boot window AND off the interaction: main-simple's idleDefer
    // trigger is pinned in A's mainLocks.)
  });

  test('the warm compiles what the frame will draw, off the render path (B2)', () => {
    const scene = src('GameScene.ts');
    const pass = bodyOf(scene, 'private async compileInteriorPass(');
    // Against the frame's OWN render target: three keys programs on it, and
    // compiling against the canvas while desktop frames draw into the
    // composer's buffer left 38 programs for a frame to create (measured).
    expect(scene).toContain(
      'this.compileInteriorPass(gl, g, items, visible, this.lastSceneTarget)',
    );
    expect(pass).toContain('gl.setRenderTarget(target)');
    // Through a proxy scene (its own render state in three), so the live
    // frame's lights version never moves and no frame re-keys.
    expect(pass).toContain('const proxy = new THREE.Scene();');
    // One object per compile call until the slice's budget is spent: a batch
    // sized from the last slice overran it (measured 9.3 ms and 23 ms).
    expect(pass).toContain('batch = [items[i++]];');
    expect(pass).toContain('performance.now() - t0 < GameScene.WARM_SLICE_MS');
    // Polled ready, then first-used, in idle time: the first getUniforms() is
    // a synchronous shader check that took 121 ms of the first room frame.
    const settle = bodyOf(scene, 'private async settleWarmPrograms(');
    expect(settle).toContain('p.isReady()');
    expect(settle).toContain('performance.now() + 10000');
    expect(settle).toContain('p.getUniforms();');
    // Without KHR_parallel_shader_compile the idle warm stands down…
    expect(bodyOf(scene, 'public async warmInterior()')).toContain(
      "!gl.extensions.has('KHR_parallel_shader_compile')",
    );
    // …and the measured fallback runs instead: still for 1 s within 12 u of
    // a door (the no-extension veil held black 1.60 s without it).
    expect(scene).toContain('private static readonly NEAR_DOOR_RANGE = 12;');
    expect(scene).toContain('private static readonly NEAR_DOOR_STILL_S = 1.0;');
    expect(bodyOf(scene, 'public update(deltaTime: number)')).toContain(
      'this.updateNearDoorWarm(deltaTime);',
    );
    // No new lights, ever: the room's own four are the whole problem.
    for (const body of [pass, settle, bodyOf(scene, 'private async warmInteriorNearDoor(')]) {
      expect(body).not.toMatch(/new THREE\.\w*Light\(/);
    }
  });

  test('the window view draws with the frame’s own programs (B2)', () => {
    const scene = src('GameScene.ts');
    // three keys every program on the bound target. On the canvas path (the
    // low tier) a plain window target needed a second variant of everything
    // it saw, and alternating the two kinds re-keyed the unlit world too.
    // MEASURED at the 1x low tier's first door: 31 + 5 programs, a 1.4 s
    // first room frame. So the window target takes the frame's own kind.
    const sync = bodyOf(scene, 'private syncInteriorViewOutput()');
    expect(sync).toContain('const canvas = this.lastSceneTarget === null;');
    expect(sync).toMatch(/\.isXRRenderTarget = canvas;/);
    expect(sync).toContain(
      'view.texture.colorSpace = canvas ? THREE.SRGBColorSpace : THREE.LinearSRGBColorSpace;',
    );
    // The pane shows the stored display colours unchanged: decoded inline,
    // and not tone-mapped a second time.
    expect(sync).toContain('pane.toneMapped = !canvas;');
    expect(sync).toContain("{ DECODE_VIDEO_TEXTURE: '' }");
    const ensure = bodyOf(scene, 'private ensureInteriorView()');
    // RGBA8 in both kinds: an SRGB8_ALPHA8 store would encode the bytes twice.
    expect(ensure).toContain("texture.internalFormat = 'RGBA8';");
    // Synced on every refresh, and before the warm compiles the pane.
    expect(ensure).toContain('this.syncInteriorViewOutput();');
    expect(bodyOf(scene, 'private refreshInteriorView()')).toContain('this.ensureInteriorView();');
    // So no warm compiles a window pass of its own.
    expect(bodyOf(scene, 'private async warmInteriorNearDoor(')).not.toContain(
      'interiorViewTarget',
    );
  });

  test('three still treats an XR-flagged target as a canvas (B2)', () => {
    // syncInteriorViewOutput leans on three r180: an isXRRenderTarget target
    // gets the renderer's tone mapping and its texture's colour space as the
    // output, exactly like the canvas, and map_fragment's video-texture
    // define decodes a map inline. An upgrade that moves either fails here,
    // not as a quietly washed-out window.
    const three = readFileSync(
      join(dirname(createRequire(import.meta.url).resolve('three')), 'three.module.js'),
      'utf8',
    );
    expect(three).toContain(
      'if ( currentRenderTarget === null || currentRenderTarget.isXRRenderTarget === true ) {',
    );
    expect(three).toContain(
      '( currentRenderTarget.isXRRenderTarget === true ? currentRenderTarget.texture.colorSpace : LinearSRGBColorSpace )',
    );
    expect(ShaderChunk.map_fragment).toMatch(
      /#ifdef DECODE_VIDEO_TEXTURE\s+(\/\/[^\n]*\s+)?sampledDiffuseColor = sRGBTransferEOTF\( sampledDiffuseColor \);/,
    );
  });
});
