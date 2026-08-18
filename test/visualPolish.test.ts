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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const src = (f: string): string =>
  readFileSync(join(process.cwd(), f), 'utf8')
    .replace(/\r\n/g, '\n') // a Windows stash pop once flipped these to CRLF
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');

describe('asset grounding — World Law 1 (plumb radial up-axis)', () => {
  test('zone halls derive their basis from the marker plumb, not the slope', () => {
    const zones = src('Zones.ts');
    expect(zones).toContain('this.marker.position.clone().normalize()');
    // The old basis: `const normal = sampled.normal` — the hall then leaned
    // with the hillside (10.2 deg at the welcome hub).
    expect(zones).not.toMatch(/const normal = sampled\.normal/);
  });

  test('stationAt seats AND faces about the same plumb axis', () => {
    const island = src('Island.ts');
    const start = island.indexOf('stationAt');
    const body = island.slice(start, start + 1600);
    expect(body).toContain('seat.position.clone().normalize()');
    // Both writers must take the SAME axis — faceObjectToward premultiplies
    // about whatever it is handed, so a slope normal here re-tilts the seat.
    expect(body).toMatch(/setFromUnitVectors\(new THREE\.Vector3\(0, 1, 0\), plumb\)/);
    expect(body).toMatch(/faceObjectToward\(g, plumb,/);
    expect(body).not.toMatch(/faceObjectToward\(g, seat\.normal/);
  });

  test('benches: one plumb axis for both the seat and the facing', () => {
    const island = src('Island.ts');
    expect(island).toContain('const bPlumb = bSampled.position.clone().normalize()');
    expect(island).not.toMatch(/faceObjectToward\(\s*bench,\s*bSampled\.normal/);
  });

  test('construction blocks stand plumb', () => {
    const island = src('Island.ts');
    const start = island.indexOf('block.quaternion.copy');
    const body = island.slice(start, start + 300);
    expect(body).toContain('sampled.position.clone().normalize()');
  });

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
    const player = src('SimplePlayer.ts');
    expect(player).toContain('COYOTE_MS = 120');
    expect(player).toContain('public canJump()');
    const main = src('main-simple.ts');
    // Sound and physics must agree: the old gate read isOnGround() on the
    // keypress frame and went silent on exactly the crest-jumps coyote saves.
    expect(main).toContain('player.canJump() && !this.prevJumpHeld');
    expect(main).not.toContain('player.isOnGround() && !this.prevJumpHeld');
    // ...and playerJump() must live INSIDE that edge block: outside it, a
    // held Space re-jumped silently on every snap-down landing while the
    // edge-gated sound stayed quiet — physics and audio disagreed per frame.
    const edge = main.slice(main.indexOf('player.canJump() && !this.prevJumpHeld'));
    const block = edge.slice(0, edge.indexOf('}'));
    expect(block).toContain('this.scene.playerJump()');
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
    // opacity and punches holes behind itself at partial opacity.
    const mailbox = src('Mailbox.ts');
    const glow = mailbox.slice(mailbox.indexOf('glowMaterial = new'), mailbox.length);
    expect(glow.slice(0, 400)).toContain('depthWrite: false');
    const race = src('RaceSystem.ts');
    const ring = race.slice(race.indexOf('emissive: 0x2266aa'));
    expect(ring.slice(0, 400)).toContain('depthWrite: false');
  });
});

describe('night legibility — lit roads, dark shore and highlands', () => {
  test('pavement LIFTS at night instead of dimming to asphalt', () => {
    const env = src('EnvironmentCycle.ts');
    // The ribbon used to be lerped 85% toward 0x3c3f48 while its authored
    // emissive was ~0.019 linear — visually nil. Measured night read was
    // ~2.4:1 against grass, i.e. you could not tell where the path went.
    expect(env).toContain('this._c2.set(0x6a7183)');
    expect(env).toContain('p.mat.color.copy(p.base).lerp(this._c2, nightF * 0.6)');
    expect(env).toContain('p.mat.emissiveIntensity = 0.15 + 0.75 * nightF');
    expect(env).not.toContain('lerp(this._c2, nightF * 0.85)');
    // The emissive drive must lerp from the AUTHORED value, not overwrite it.
    expect(env).toContain('emBase');
  });

  test('the dark patches are authored by scope, not by omission', () => {
    const island = src('Island.ts');
    // Beach band and highland shoulder are explicit rejections in the artery
    // lamp pass — Abbas asked to KEEP the dark beaches and mountains.
    expect(island).toContain('if (dir.y < Math.sin(0.32)) continue');
    expect(island).toContain('Island.MAX_DISPLACEMENT * 0.42 * this.reliefScale');
    // The coastal ring is never collected for lighting at all.
    expect(island).toContain('arteryLines.push(');
  });

  test('the artery lamp pass is RNG-SHIELDED (multiplayer world must not re-roll)', () => {
    const island = src('Island.ts');
    // CODE anchor, not a comment — src() strips comments, so a comment anchor
    // silently yields an empty slice (this suite has been bitten before).
    const at = island.indexOf('let lseed = 0x9e3779b1');
    expect(at).toBeGreaterThan(-1);
    const body = island.slice(Math.max(0, at - 300), at + 3000);
    // three's generateUUID burns 4 Math.random draws per Object3D/Material/
    // Geometry, and buildLamp mints a Group per lamp — upstream of the parked
    // cars, which multiplayer addresses BY INDEX. Verified live: car_0 and
    // house_0 are bit-identical to prod with 28 extra lamps built.
    expect(body).toContain('const stashedRandom = Math.random');
    expect(body).toContain('Math.random = stashedRandom');
    expect(body).toMatch(/finally\s*\{/);
  });
});

describe('roads read as roads — kerbs, centre line, and off the camera ray', () => {
  test('cross-section rides in vertex colour, at no allocation cost', () => {
    const island = src('Island.ts');
    // A BufferAttribute mints no uuid and PlaneGeometry costs the same 4
    // Math.random draws at any resolution — which is why the road could be
    // detailed WITHOUT the flag-day world re-roll a width rewrite needs.
    expect(island).toContain('mat.vertexColors = true');
    expect(island).toMatch(/new THREE\.PlaneGeometry\(planeLen, width, lenSegs, 6\)/);
    expect(island).toContain("geo.setAttribute('color'");
    // Kerb band + body + a centre line on wide roads only (a footpath with a
    // centre line looks like a runway).
    expect(island).toContain('const marked = width >= 1.5');
    expect(island).toContain('shade = 0.6');
  });

  test('widened only as far as the MEASURED clear width allows', () => {
    const island = src('Island.ts');
    expect(island).toContain('createStreetPath(boulevardPts, 1.7)');
    expect(island).toContain('createStreetPath(avenue, 1.5)');
    // The keep-out floor must stay 1.9: max(1.7*0.5+0.8, 1.9) = 1.9, so no
    // prop placement shifts and the seeded world is untouched. Anything
    // wider than 1.80u needs the streetDirs endpoint fix first.
    expect(island).toContain('Math.max(width * 0.5 + 0.8, 1.9)');
  });

  test('the street network merges into sectors, RNG-shielded', () => {
    const island = src('Island.ts');
    expect(island).toContain('private mergeStreetNetwork(');
    expect(island).toContain('this.mergeStreetNetwork(pathGroup)');
    // 8 sectors, not 1 mesh: frustum culling keys off bounding spheres and a
    // single planet-spanning road would never cull. MEASURED at one fixed
    // camera pose: 1390 -> 1243 draw calls (-147) with triangles unchanged.
    expect(island).toContain('const SECTORS = 8');
    expect(island).toContain('street_sector_');
    // The build loop's 401 allocations are seeded-RNG currency and must stay;
    // only the merge tail is new, and it is shielded so its own ~64 draws
    // cannot leak into the world stream.
    const at = island.indexOf('let sseed = 0x51ed270b');
    expect(at).toBeGreaterThan(-1);
    expect(island.slice(at - 200, at + 2600)).toContain('Math.random = stashedRandom');
    // Contracts the merged mesh must carry forward.
    expect(island).toContain('mesh.name = `street_sector_${b}`');
    expect(island).toMatch(/mesh\.userData\.isPavement = true;[\s\S]{0,80}pathGroup\.add/);
  });

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

  test('pavement is opted out of the per-frame camera raycast', () => {
    const island = src('Island.ts');
    // OrbitCamera treats an own-property raycast as an explicit opt-out and
    // ray-tests its whole collision list every frame; a ground-hugging
    // ribbon can never block the camera. ~401 sphere tests/frame removed.
    const at = island.indexOf('mesh.userData.isPavement = true');
    expect(at).toBeGreaterThan(-1);
    expect(island.slice(Math.max(0, at - 600), at)).toContain('mesh.raycast = () => {}');
  });
});

describe('engine smoothness — no mid-flight recompile, no wasted frames', () => {
  test('the boot precompile bakes the permutation frame 1 will use', () => {
    const main = src('main-simple.ts');
    const scene = src('GameScene.ts');
    // three bakes NUM_POINT_LIGHTS/NUM_SPOT_LIGHTS into every lit material's
    // program key. Lights are born visible and are only gated once update()
    // runs — after this compile — so the precompile used to bake the NIGHT
    // permutation and the first daylight frame invalidated EVERY lit program
    // at once, mid fly-in. Measured after priming: 174 -> 103 programs and
    // ZERO programs added by the first render.
    expect(scene).toContain('public primeExteriorLightGate()');
    const prime = main.indexOf('primeExteriorLightGate()');
    const compile = main.indexOf('compileAsync(this.scene');
    expect(prime).toBeGreaterThan(-1);
    expect(prime).toBeLessThan(compile);
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

  test('the camera size filter applies to every root', () => {
    const cam = src('OrbitCamera.ts');
    // `&& rootIndex !== 0` exempted every DESCENDANT of the island group, not
    // just the terrain — ~1,600 bounding-sphere tests per frame. Measured
    // after: 555.
    expect(cam).toContain('if (r * Math.max(s.x, s.y, s.z) < MIN_BLOCKING_RADIUS) return;');
    expect(cam).not.toContain('MIN_BLOCKING_RADIUS && rootIndex !== 0');
  });

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

  test('cars stand PLUMB and the headlights are fake', () => {
    const t = src('Traffic.ts');
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

describe('HUD — one chip recipe for the top-right column', () => {
  test('CHIP/CHIP_ICON exist and every column chip spreads them', () => {
    const ui = src('SimpleUI.ts');
    expect(ui).toContain('const CHIP: Partial<CSSStyleDeclaration>');
    expect(ui).toContain('const CHIP_ICON: Partial<CSSStyleDeclaration>');
    // Text chips: online, coin, feed, Say hi, completion.
    expect((ui.match(/\.\.\.CHIP,/g) ?? []).length).toBeGreaterThanOrEqual(5);
    // Icon chips: mute, reduced-motion, customize, emote, photo, inventory.
    expect((ui.match(/\.\.\.CHIP_ICON,/g) ?? []).length).toBeGreaterThanOrEqual(6);
    // The recipe pins the geometry the column drifted on.
    const chipBlock = ui.slice(ui.indexOf('const CHIP:'), ui.indexOf('export class SimpleUI'));
    expect(chipBlock).toContain("height: '30px'");
    expect(chipBlock).toContain("borderRadius: '999px'");
    expect(chipBlock).toContain("borderRadius: '50%'");
    // No fontFamily in the recipes — the overlay's Inter must cascade.
    expect(chipBlock).not.toContain('fontFamily');
  });

  test('38px row pitch anchored to the frozen Portfolio/Work-with-me pills', () => {
    const ui = src('SimpleUI.ts');
    // Frozen anchors (analytics ruling — do not move):
    expect(ui).toContain('+ 126px');
    expect(ui).toContain('+ 164px');
    // The derived rows: online 12, coin/feed 50, icon row 88, Say hi 202,
    // completion 240; icon slots 10/48/86/124/162/200.
    for (const off of ['+ 12px', '+ 50px', '+ 202px', '+ 240px']) {
      expect(ui).toContain(off);
    }
    for (const slot of ['+ 48px', '+ 86px', '+ 124px', '+ 162px', '+ 200px']) {
      expect(ui).toContain(slot);
    }
  });

  test('demotions and accent discipline', () => {
    const ui = src('SimpleUI.ts');
    // Photo is icon-only everywhere now (the P shortcut lives in the title).
    expect(ui).not.toContain("'📸 P'");
    // Reduced-motion active = the indigo accent — green stays reserved for
    // the Work-with-me conversion pill.
    expect(ui).toContain('rgba(91, 108, 255, 0.35)');
    expect(ui).not.toContain('rgba(80, 180, 120, 0.75)');
    // The FPS debug readout anchors bottom-right, off the visitor column.
    const start = ui.indexOf('private createFPSDisplay');
    const fps = ui.slice(start, ui.indexOf('this.playerCountDiv = document.createElement', start));
    expect(fps).toContain('bottom:');
    expect(fps).not.toMatch(/top: 'calc/);
  });

  test('per-frame hot paths stay allocation-free (sweep round 2)', () => {
    // The sweep measured the camera + player physics as the two densest
    // per-frame allocation clusters (~20 heap objects/frame combined, the
    // player's doubled by the substep split exactly on slow frames). These
    // pin the scratch-field conversions; `.clone()` reappearing in either
    // body is the regression.
    const cam = src('OrbitCamera.ts');
    // End anchor must be CODE — src() strips comments before slicing, so a
    // comment anchor silently extends the slice to the end of the file.
    const camBody = cam.slice(
      cam.indexOf('private updateCameraPosition'),
      cam.indexOf('private readonly focusTarget'),
    );
    expect(camBody).not.toContain('.clone()');
    // Only the two cold-path seeds may allocate (first frame / degenerate).
    expect((camBody.match(/new THREE\./g) ?? []).length).toBeLessThanOrEqual(2);
    expect(cam).toContain('getWorldPositionInto(this._camPlayerPos)');
    expect(cam).toContain('getSurfaceNormalInto(this._camNormal)');

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

    // The per-frame NPC-shadow pass reads a VIEW, not a fresh copy.
    const island = src('Island.ts');
    expect(island).toContain('public getNPCInstances(): readonly NPC[]');
    expect(island).not.toContain('return this.npcInstances.slice()');
  });

  test('per-frame HUD writers skip unchanged values (sweep round 2)', () => {
    const ui = src('SimpleUI.ts');
    // Interaction prompt: innerHTML parse only when the TEXT changes.
    expect(ui).toContain('if (text === this.lastPromptText && this.interactionDiv) return');
    // Race panel: null-first so on-foot visitors never get the DOM built,
    // and show/hide writes only on the transition.
    const race = ui.slice(ui.indexOf('updateRaceHud(status'));
    expect(race.indexOf('if (!status)')).toBeLessThan(race.indexOf('if (!this.raceDiv)'));
    expect(ui).toContain('this.raceVisible');
    // Breath: dry sessions never build the meter+vignette DOM, and the two
    // vignette gradients are prebuilt constants, not per-frame templates.
    expect(ui).toContain('VIGNETTE_DEEP');
    expect(ui).toContain('VIGNETTE_SHALLOW');
    expect(ui).not.toMatch(/radial-gradient\(circle at 50% 45%[^`]*\$\{edge\}/);
  });

  test('per-frame position reads use the Into variant (sweep round 3)', () => {
    const scene = src('GameScene.ts');
    // Each per-frame consumer owns its scratch; collisions keep a DEDICATED
    // buffer because they mutate it in place as the write-back.
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
    const main = src('main-simple.ts');
    // The audio/compass scratches must be FED by Into, not by copy(clone()).
    expect(main).toContain('getWorldPositionInto(this._listenerPos)');
    expect(main).toContain('getWorldPositionInto(this._qcPlayerPos)');
    expect(main).not.toContain('.copy(player.getWorldPosition())');
  });

  test('startup: Firebase deferred, postprocessing preloaded, honest measures (round 4)', () => {
    const main = src('main-simple.ts');
    // The three boot-window Firebase touches run from idle slots (1.5s max
    // keeps the world beat arriving during the fly-in for buildAwayDelta).
    expect(main).toMatch(/idleDefer\(\s*\(\)\s*=>\s*connectWorldState/);
    expect(main).toMatch(/idleDefer\(\(\)\s*=>\s*\{\s*void subscribeBenches/);
    // The postprocessing fetch starts BEFORE world gen so the RTT overlaps it.
    expect(main).toContain('SimpleRenderer.preloadPostProcessing()');
    expect(main.indexOf('SimpleRenderer.preloadPostProcessing()')).toBeLessThan(
      main.indexOf("performance.mark('boot:worldgen-start')"),
    );
    // Paint yields are visibility-guarded — rAF never fires in a hidden tab.
    expect(main).toContain("document.visibilityState !== 'visible'");
    // world_gen measures through scene-ready (the builder passes after the
    // constructor's first await used to be mis-attributed to scene_ready).
    expect(main).toContain(
      "performance.measure('world_gen', 'boot:worldgen-start', 'boot:scene-ready')",
    );
    expect(main).not.toContain("'boot:worldgen-end'");

    const r = src('SimpleRenderer.ts');
    expect(r).toContain('public static preloadPostProcessing');
    // Idempotent cache + swallowed preload rejection (real errors re-surface
    // at initPostProcessing's await); null on the low tier — never fetched.
    expect(r).toContain('if (SimpleRenderer.isLowTierDevice()) return null');
    expect(r).toMatch(/await \(SimpleRenderer\.preloadPostProcessing\(\) \?\?/);
  });

  test('exterior lights + zero-alpha overlays leave the pipeline by day (round 4)', () => {
    const env = src('EnvironmentCycle.ts');
    expect(env).toContain('EXTERIOR_LIGHTS_DAY_CUTOFF = 0.85');
    // ONE shared cutoff: the light count flips once per dusk/dawn instead of
    // stepping through permutations as per-light curves cross zero.
    expect(env).toContain('g.light.visible = exteriorLightsOn && !off');
    const scene = src('GameScene.ts');
    expect(scene).toContain('slot.light.visible = on');
    expect(scene).toContain('this.lampPoolMat.visible = this.lampPoolMat.opacity > 0.01');
    expect(scene).toContain('ud.beamMat.visible = ud.beamMat.opacity > 0.01');
    // The intensity formulas are deliberately untouched (night look pinned).
    expect(env).toContain('const glow = 0.25 + (1 - dayFactor) * 1.05');
  });

  test('the lamp fleet is two instanced draws, discovery contract intact', () => {
    const island = src('Island.ts');
    // Anchors keep the whole discovery contract: name lamp_<i> (colliders,
    // pool anchors, both parity tests), poolScale, and the byte-identical
    // transform math (plumb + faceObjectToward + arm swing on the GROUP,
    // whose matrix becomes the instance matrix).
    expect(island).toContain('lampGroup.name = `lamp_${i}`');
    expect(island).toContain('lampGroup.userData.poolScale = poolScale');
    expect(island).toContain('lampMatrices.push(lampGroup.matrix.clone())');
    // The fleet renders as exactly two InstancedMesh (~228 meshes + ~171
    // materials before — all built and toonified at EVERY boot even though
    // lamp.glb hides them, which is where the always-paid win actually is).
    expect(island).toContain("bodyMesh.name = 'streetlamp_bodies_instanced'");
    expect(island).toContain("bulbMesh.name = 'streetlamp_bulbs_instanced'");
    // The names must NOT start with 'lamp': findPlaceholders matches by
    // PREFIX, so 'lamp_*_instanced' made the fleet its own placeholder —
    // hidden, materials zeroed, two junk GLB clones at the planet core.
    expect(island).not.toContain("'lamp_posts_instanced'");
    expect(island).not.toContain("'lamp_bulbs_instanced'");
    expect(island).toContain("loadAndReplace(basePath + 'lamp.glb', 'lamp_'");
    // The fleet is the FALLBACK: retired by flag when the authored model
    // lands, so a failed GLB load still lights the boulevard.
    expect(island).toContain('for (const m of this.lampFleet) m.visible = false');
    // Empty anchors are invisible to seatGroupsOnTerrain's bbox pass, so the
    // anchors are seated by hand and the matrices REWRITTEN from them —
    // without this the whole fleet floats at buildLamp's +0.62 sample.
    expect(island).toContain('fleet.setMatrixAt(i, anchors[i].matrix)');
    expect(island).toContain('sampled.position.dot(dir) - SINK - anchor.position.dot(dir)');
    // ...and the lampSites re-anchor guard counts ANCHORS, not children.
    expect(island).toMatch(/anchors\.length === this\.lampSites\.length/);
    // ONE night-drive entry for all bulbs (EnvironmentCycle dedupes by mat).
    expect(island).toContain('bulbMesh.userData.isNightEmissive = true');
    // No per-lamp mesh/material mints inside buildLamp any more.
    const start = island.indexOf('const buildLamp');
    const body = island.slice(start, island.indexOf('};', start));
    expect(body).not.toContain('new THREE.Mesh(');
    expect(body).not.toContain('createTrimMaterial');
    // GameScene fetches the single shared bulb material by name (the anchor
    // traversal finds nothing on the island lamps now).
    expect(src('GameScene.ts')).toContain("getObjectByName('streetlamp_bulbs_instanced')");
    // InstancedMesh owns a GPU instanceMatrix the geometry/material disposal
    // does not release.
    expect(island).toContain('if (inst.isInstancedMesh) inst.dispose()');
  });

  test('GLB clones collapse to instanced draws, and the fade stops leaking transparency', () => {
    const island = src('Island.ts');
    // Object3D.clone() SHARES geometry+materials, so N identical static
    // clones are N draws of the same buffers. The collapse re-packs the
    // RESULT of the existing placement logic, so transforms are preserved.
    expect(island).toContain('const collapseClonesToInstances =');
    // Opted in: lamps, benches, decorative mailboxes — all static, cloned
    // per placeholder, with anchors (not clones) carrying every interaction.
    expect((island.match(/collapseToInstances: true/g) ?? []).length).toBe(3);
    // Cars and TREES must NOT opt in: cars are driven (GameScene moves the
    // group) and trees sway per frame + can be felled.
    const treeCall = island.slice(island.indexOf('tryTree'));
    expect(treeCall).not.toContain('collapseToInstances');
    // CONSERVATIVE bail: skinned (per-clone skeleton), nested instanced,
    // points/lines, hidden sub-meshes, or a DEGENERATE split (prepareClone
    // mints per-clone materials for non-standard sources → one single-
    // instance mesh per clone, strictly worse) all leave the clones alone.
    expect(island).toContain('(m as THREE.SkinnedMesh).isSkinnedMesh ||');
    expect(island).toContain('!m.visible');
    expect(island).toContain('buckets.size >= clones.length');
    // An animated model must never collapse — mixers are bound per clone.
    expect(island).toContain('options.collapseToInstances && animations.length === 0');
    // Instances must not be named with a placeholder prefix, or the loader
    // would treat them as replaceable stand-ins (the bug that hid the
    // procedural fleet and dropped junk clones at the planet core).
    expect(island).toContain('inst.name = `glbfleet_${label}${idx++}`');
    // The clones are DETACHED, never disposed: the instances now own their
    // geometry and materials, and the fade still animates those materials.
    expect(island).toContain('for (const clone of clones) clone.parent?.remove(clone)');

    // The fade forced transparent=true (via prepareClone's opacity-0 start)
    // and never put it back, leaving every GLB-replaced prop in the
    // transparent pass forever. The authored value must be snapshotted from
    // the SOURCE model — clones share its materials, so by the time a clone
    // exists the flag has already been overwritten.
    expect(island).toContain('const snapshotAuthoredMaterials =');
    expect(island).toContain('const restoreAuthoredMaterials =');
    expect(island).toContain('mat.transparent = authored.transparent');
    // A material prepareClone REPLACED has a uuid the snapshot never saw —
    // it is authored opaque by construction, so default rather than skip.
    expect(island).toContain('snap.get(mat.uuid) ?? { transparent: false, opacity: 1 }');
    // BOTH GLB loaders must restore — the tree fade had no terminal branch
    // at all, leaving 4 DOUBLE-SIDED materials per tree in the sorted
    // transparent pass for the whole session.
    expect(island).toContain('restoreAuthoredMaterials(fadeMats, authoredMats)');
    expect(island).toContain('restoreAuthoredMaterials(treeFadeMats, authoredTreeMats)');
    // GameScene owns the island teardown (Island.dispose has no callers), so
    // the instanceMatrix release has to live there too.
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

  test('chip-recipe regressions from the follow-up review stay fixed', () => {
    const ui = src('SimpleUI.ts');
    // The feed chip re-shows as FLEX — a block re-show drops the CHIP
    // recipe's centering the first time charges go 0 -> nonzero.
    expect(ui).toContain("this.feedDiv.style.display = 'flex'");
    expect(ui).not.toContain("this.feedDiv.style.display = 'block'");
    // The emote responsive restore is gated by SURFACE first: the short-
    // landscape media query also matches a short DESKTOP window, which
    // parked the desktop emote on the customize slot.
    expect(ui).toContain('this.emoteBtnEl.style.right = this.isTouch');
  });
});

describe('smoothness round 2 — the two measured hitches', () => {
  test('music slices keep a time budget when the page never goes idle', () => {
    const main = src('main-simple.ts');
    // THE BUG: `deadline.timeRemaining() > 3 || deadline.didTimeout` treated a
    // TIMED-OUT idle callback as unlimited time. requestIdleCallback sets
    // didTimeout precisely when the page has been too busy to go idle for
    // 500ms — i.e. the fly-in — so the budget switched itself off on exactly
    // the frames it existed to protect, and ran the whole 40k-sample slice.
    expect(main).not.toMatch(/timeRemaining\(\) > 3 \|\| deadline\.didTimeout/);
    // The timed-out path falls back to a wall clock instead of surrendering.
    expect(main).toContain('performance.now() - started >= 6');
    expect(main).toContain('deadline.timeRemaining() <= 3');
    // And the clock is read per BLOCK, not per sample: at 5.3M samples the
    // guard cost more than the synthesis it guarded. The counter also
    // guarantees forward progress, which a pure time test does not.
    expect(main).toContain('if (++sinceCheck >= 4096)');
    // The wall clock is the DEFAULT branch. The first pass at this fix
    // guarded didTimeout but left `deadline === undefined` returning false,
    // so the setTimeout fallback — every browser without
    // requestIdleCallback — still ran the original unbounded 40k slice.
    expect(main).toContain('deadline && !deadline.didTimeout');
  });

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

  test('bloom FADES in at the reveal instead of snapping (no arrival pop)', () => {
    const r = src('SimpleRenderer.ts');
    // Enabling bloom at arrival avoids rim-ghosting during the swoop, but a hard
    // enable is a visible pop right as the reveal settles — "a flicker during
    // the fly-in". Ramp its strength up from 0 instead.
    expect(r).toContain('public fadeBloomIn(');
    expect(r).toContain('bloom.strength = 0;');
    expect(r).toContain('this.bloomTargetStrength = bloomPass.strength;'); // authored value snapshot
    const m = src('main-simple.ts');
    // the intro's arrival callback fades, it no longer hard-enables.
    expect(m).toContain('this.renderer.fadeBloomIn(');
    expect(m).not.toMatch(/\.then\(\(\) => \{[\s\S]{0,200}setBloomEnabled\(true\)/);
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
  });

  test('villager ink hulls cull with their body, not from anywhere on the planet', () => {
    const cel = src('CelLook.ts');
    // The body got the pose-proof 2.5x-sphere cull (NPC.ts) but the hull kept
    // frustumCulled=false, so all 140 villager hull SkinnedMeshes were
    // GPU-skinned + drawn every frame regardless of camera. Same sphere now.
    expect(cel).not.toContain('hull.frustumCulled = false');
    expect(cel).toContain('hull.computeBoundingSphere()');
    expect(cel).toContain('hull.boundingSphere.radius *= 2.5');
    // ORDER MATTERS: computeBoundingSphere skins through the skeleton, so it
    // MUST run AFTER hull.bind() or it returns a null sphere and the hull falls
    // back to bind-pose bounds (which pop as the villager walks).
    expect(cel.indexOf('hull.bind(')).toBeGreaterThan(-1);
    expect(cel.indexOf('hull.computeBoundingSphere()')).toBeGreaterThan(cel.indexOf('hull.bind('));
  });

  test('desktop drops the unused canvas MSAA buffer (composer does the AA)', () => {
    // On desktop the steady state is composer.render(), whose samples:4 target
    // does the scene AA — so antialias:true only allocated a ~60MB full-canvas
    // MSAA buffer used as the OutputPass blit destination (where MSAA is inert).
    expect(src('SimpleRenderer.ts')).toContain('antialias: SimpleRenderer.isLowTierDevice()');
  });

  test('villager face decals do not cast shadow (invisible, but re-skinned every frame)', () => {
    const island = src('Island.ts');
    // eye/eyeshine/blush sit inside the head's own silhouette — sub-texel in the
    // 2048 shadow map — yet NPC.ts blanket-set castShadow, so they were
    // re-skinned + drawn into the depth pass every frame. The else-branch of the
    // hull regex drops them from the shadow pass.
    expect(island).toMatch(
      /if \(!\/eye\|blush\/\.test\(matName\)\) \{\s*addSkinnedHull[\s\S]{0,120}\} else \{[\s\S]{0,260}castShadow = false/,
    );
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

  test('bloom turns on at arrival, not mid-swoop (no first-load rim ghosting)', () => {
    const m = src('main-simple.ts');
    // Bloom is half-res, so enabling it mid-fly-in makes the bright planet rim
    // ghost at intro-lite fps — the "world first-loading bloom flicker". Grass
    // restores under motion (1500ms, pop hidden); bloom waits for the still
    // camera at arrival (the flyIn .then()).
    // The mid-swoop 1500ms timer restores the intro-lite quality levers (grass,
    // resolution, shadows) under camera motion. Bloom is deliberately NOT among
    // them — it waits for the still arrival camera (fadeBloomIn) to avoid the
    // half-res rim ghosting.
    expect(m).toContain('window.setTimeout(restoreIntroQuality, 1500)');
    const restoreStart = m.indexOf('const restoreIntroQuality');
    const restoreBody = m.slice(restoreStart, restoreStart + 400);
    expect(restoreBody).not.toContain('setBloomEnabled(true)');
    expect(restoreBody).not.toContain('fadeBloomIn');
    // Bloom comes on in the arrival callback (now via fadeBloomIn), AFTER the
    // fly-in — never in the 1500ms mid-swoop timer.
    const fly = m.indexOf('flyInFromDistant');
    expect(fly).toBeGreaterThan(-1);
    expect(m.indexOf('fadeBloomIn(')).toBeGreaterThan(fly);
    expect(m).not.toMatch(/setGrassBudget\(1\);\s*this\.renderer\.setBloomEnabled\(true\)/);
  });

  test('warmUp compiles the bloom pass, not just the output pass', () => {
    const r = src('SimpleRenderer.ts');
    // warmUp renders a throwaway frame behind the loader to compile the
    // post-processing programs. But main-simple disables bloom for the
    // intro-lite swoop BEFORE warmUp runs, and EffectComposer skips a disabled
    // pass entirely — so bloom's ~8 fullscreen-quad programs never compiled
    // here and cold-compiled ~1.5s into the visible reveal when bloom came
    // back on. warmUp now forces bloom on for the throwaway render and
    // restores the caller's setting. `bloomWas` is unique to this fix (the
    // governor snapshots into bloomSuspendedByGovernor instead).
    expect(r).toContain('const bloomWas = this.bloomPass?.enabled');
    expect(r).toContain('this.bloomPass.enabled = bloomWas');
  });

  test('remote peers swim a windmill, matching the local crawl (world law 2)', () => {
    const player = src('SimplePlayer.ts');
    // Commit 9ba63d5 turned the LOCAL swim stroke from a bounded oscillation
    // into a continuous windmill (a real front crawl), but left the REMOTE
    // peer copy on the old oscillation. MEASURED: the old remote arm kept
    // z=sin(rot.x) in [-0.985, -0.100] — negative all cycle, both hands behind
    // the shoulder = a permanent BACKSTROKE. So a swimming peer looked correct
    // to themselves and swam backwards to everyone else. This is the exact
    // "fix one side, leave the other broken" that World Law 2 exists to stop.
    const remote = player.slice(
      player.indexOf('activePose === 1'),
      player.indexOf('activePose === 2'),
    );
    expect(remote.length).toBeGreaterThan(100); // both anchors resolved
    expect(remote).toContain('armLBone.rotation.x = -Math.PI - swimClock');
    expect(remote).toContain('armRBone.rotation.x = -Math.PI - swimClock + Math.PI');
    // The old oscillation is gone (this exact form was the backstroke).
    expect(remote).not.toContain('(1.4 + s * 1.3)');
    // And the LOCAL player is the windmill it must match — pin both so they
    // cannot drift a third time.
    expect(player).toContain('this.armLBone.rotation.x = REST_X - this.swimPhase');
    expect(player).toContain('this.armRBone.rotation.x = REST_X - this.swimPhase + Math.PI');
  });

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

  test('the headlight wash is rolled ALONG the road, on an exact radius', () => {
    const traffic = src('Traffic.ts');
    // The wash is 3u x 7u — a NON-UNIFORM scale, so its long axis has a
    // designated direction. setFromUnitVectors alone pinned only the NORMAL to
    // the radial and left the in-plane roll as the shortest-arc residue, a
    // pure function of world POSITION: measured 2.0 / 12.1 / 62.3 / 64.6 /
    // 73.2 / 73.3 / 74.6 / 82.1 / 83.4 / 89.7 deg off the road across the ten
    // cars, so most laid a 7u bar ACROSS a 1.7u boulevard.
    expect(traffic).not.toContain('this._q.setFromUnitVectors(this._flat, this._ahead)');
    // Y = road tangent, Z = radial => X MUST be tan x ahead for a proper
    // right-handed basis. Argument order here is the improper-matrix bug this
    // repo has hit three times, so the order is pinned explicitly.
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

  test('blocked localStorage cannot brick the welcome card', () => {
    const ui = src('SimpleUI.ts');
    // This was the ONE bare localStorage read left in the file (16 of 17
    // siblings already catch). On iOS Safari with "Block All Cookies" it threw
    // AFTER the card was appended and panels.open() had raised the scrim and
    // hidden the touch controls, but BEFORE innerHTML filled it and before the
    // Escape listener was attached — and welcomeDiv stayed non-null, so
    // isWelcomeVisible() gated out movement, camera, jump and interaction for
    // the entire session. Empty black box, no controls, no Escape.
    expect(ui).toMatch(/let returning = false;\s*try \{\s*returning = localStorage\.getItem/);
    expect(ui).not.toMatch(/const returning = localStorage\.getItem/);
  });

  test('page teardown does not burn the first-run welcome unread', () => {
    const ui = src('SimpleUI.ts');
    // beforeunload -> dispose() -> hideWelcome() persisted ds_welcomed for a
    // visitor who closed the tab with the card still on screen. They returned
    // to the trimmed "Welcome back!" branch and permanently lost the pitch,
    // the recruiter highlights pill, the secondary CTAs and the compass hint.
    // On a portfolio, first-visit bounce is most of the traffic.
    expect(ui).toContain('hideWelcome(persist = true)');
    expect(ui).toContain('if (!persist) return;');
    expect(ui).toContain('this.hideWelcome(false)');
    // The PanelManager sweep IS a dismissal and must still persist.
    expect(ui).toContain('close: () => this.hideWelcome(),');
  });

  test('the contact form cannot strand itself or blame a good email', () => {
    const ui = src('SimpleUI.ts');
    // submitLead returns false for BOTH a malformed address and any backend
    // failure, and the caller mapped both to "Please check your email
    // address." — sending a recruiter with a valid address into a retype loop.
    expect(ui).toContain("track('lead_failed')");
    expect(ui).toContain('Could not send — try again, or email admin@digiscalability.com.');
    // Boards is lazy-loaded and statically imported nowhere, so a failed chunk
    // fetch used to escape the async handler and leave the site's primary
    // conversion control disabled on "Sending…" forever. Import inside try.
    expect(ui).toMatch(/try \{\s*const \{ submitLead \} = await import\('\.\/Boards'\);/);
    expect(ui).toMatch(/try \{\s*const boards = await import\('\.\/Boards'\);/);

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
    // compileAsync yields for 100-500ms; a player pressing E inside that
    // window sets visible=true, then the resumed warm set it back to false and
    // NOTHING re-arms visibility mid-visit (interiorGroup.visible = true
    // appears exactly once, in enterInterior). They stood in a building with
    // no walls, floor or furniture for the whole visit. So every visibility
    // write re-checks the flag on the far side of every await.
    expect(scene).toMatch(
      /const warm = async \(visible: boolean\): Promise<void> => \{\s*if \(this\.insideInterior\) return;/,
    );
    expect(scene).toContain('if (!this.insideInterior) g.visible = wasVisible;');
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
    // Off the boot window AND off the interaction: scheduled through the same
    // idle deferral that already carries music and profile sync.
    const main = src('main-simple.ts');
    expect(main).toContain('this.idleDefer(() => void this.scene.warmInterior()');
  });
});
