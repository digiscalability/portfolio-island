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

  test('coyote jump: 120ms grace, and the SFX gate shares the predicate', () => {
    const player = src('SimplePlayer.ts');
    expect(player).toContain('COYOTE_MS = 120');
    expect(player).toContain('public canJump()');
    const main = src('main-simple.ts');
    // Sound and physics must agree: the old gate read isOnGround() on the
    // keypress frame and went silent on exactly the crest-jumps coyote saves.
    expect(main).toContain('player.canJump() && !this.prevJumpHeld');
    expect(main).not.toContain('player.isOnGround() && !this.prevJumpHeld');
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
    // that flipped per camera step.
    expect(scene).toMatch(/renderOrder = spec\.set === 'fair' \? 10 : 11/);
    // depthWrite only when fully opaque: a half-faded cloud writing depth
    // punched holes in everything sorted behind it.
    expect(scene).toContain('this.cloudMat.depthWrite = this.cloudMat.opacity >= 0.999');
    // The storm tower hides until it actually grows — 'cloudy' (wet 0.55)
    // left it a permanently visible squashed pancake before.
    expect(scene).toContain('this.towerMesh.visible = this.towerGrow > 0.05');
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
});
