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
