// @vitest-environment happy-dom
//
// Mobile-finish coverage locks (iPhone SE pass, 375x667).
//
// The SE audit found the two most crowded moments of the product — the
// first-run welcome and the guided tour — were the ONLY two major surfaces
// bypassing PanelManager, so the HUD-clearing policy built for exactly this
// crowding never ran during onboarding. These locks pin the routing and the
// message-primitive fixes the same way reducedMotion.test.ts pins its gates.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const src = (f: string): string => readFileSync(join(process.cwd(), f), 'utf8');

const fn = (file: string, marker: string, span = 3500): string => {
  const s = src(file);
  const i = s.indexOf(marker);
  expect(i, `${marker} not found in ${file}`).toBeGreaterThan(-1);
  return s.slice(i, i + span);
};

describe('onboarding surfaces route through PanelManager', () => {
  test('the welcome modal opens as a managed modal that clears the HUD', () => {
    const w = fn('SimpleUI.ts', 'showWelcome(awayDelta');
    expect(w).toContain("this.panels.open('welcome'");
    expect(w).toContain("'touch-controls'");
    expect(w).toContain("'aux-controls'");
  });

  test('the tour overlay opens as a managed sheet that clears the HUD', () => {
    const t = fn('SimpleUI.ts', 'showTourOverlay(');
    expect(t).toContain("this.panels.open('tour'");
    expect(t).toContain("'touch-controls'");
  });

  test('the drawer suppresses the touch controls that painted over it', () => {
    const d = fn('SimpleUI.ts', "this.panels.open('drawer'");
    expect(d).toContain("'touch-controls'");
  });
});

describe('message primitives are SE-safe', () => {
  test('toast wraps, queues, and defers under the loader/welcome', () => {
    const t = fn('SimpleUI.ts', 'public toast(message');
    expect(t).toContain('toastQueue');
    const p = fn('SimpleUI.ts', 'private pumpToasts');
    expect(p).toContain('isWelcomeVisible');
    expect(p).toContain('maxWidth');
    expect(p).not.toContain("whiteSpace: 'nowrap'");
  });

  test('flashMessage is single-slot (no superimposed stacking)', () => {
    expect(fn('SimpleUI.ts', 'flashMessage(text')).toContain('this.flashEl?.remove()');
  });

  test('the world bulletin waits out the welcome modal', () => {
    expect(fn('SimpleUI.ts', 'public showWorldBulletin')).toContain('isWelcomeVisible');
  });
});

describe('touch layout recomposition', () => {
  test('chips stay their own tap-pad containing block (relative, never static)', () => {
    // position:'static' re-anchored every .hud-btn::after 44px pad to the
    // whole drawer list and scrambled hit-testing across it.
    expect(fn('SimpleUI.ts', 'private tierChip')).toContain("position: 'relative'");
    expect(fn('SimpleUI.ts', 'private chipHost', 2000)).not.toContain("position: 'static'");
  });

  test('FEED/EAT are contextual aux controls, not permanent buttons', () => {
    const s = src('SimpleUI.ts');
    expect(s).toContain("'aux-controls'");
    expect(s).toContain('setAuxActionAvailable');
    expect(src('main-simple.ts')).toContain('setAuxActionAvailable');
  });

  test('narrow-portrait recompose exists (SE-class radar + chip row)', () => {
    const r = fn('SimpleUI.ts', 'private applyResponsiveHud', 3800);
    expect(r).toContain('narrow');
    expect(r).toContain("'120px'");
  });

  test('landscape SE re-lanes the surfaces that collide there', () => {
    // 667x375 was the audit's biggest miss: nothing but the minimap ever
    // reflowed for it. Each of these was MEASURED as a real overlap.
    const r = fn('SimpleUI.ts', 'private applyResponsiveHud', 3800);
    expect(r).toContain('emoteBtnEl'); // was 27x33 into the WAVE button (tap conflict)
    expect(r).toContain('envBadgeDiv'); // was 64x26 into the raised radar
    // The bulletin/toast lanes must be breakpoint-aware: bottom+250 on a
    // 375-tall screen is y88-125, inside the bulletin's own y66-126 band.
    const t = fn('SimpleUI.ts', 'private applyToastAnchor');
    expect(t).toContain('shortLandscape');
    expect(fn('SimpleUI.ts', 'private bulletinTop')).toContain('shortLandscape');
  });

  test('the chat/mic stack clears the joystick hit square', () => {
    // The joystick's INVISIBLE hit region is 166px tall from the bottom
    // edge; the chat button at bottom+152 put its lower 14px inside it, so
    // a drag starting there opened chat instead of moving. Both orientations.
    const s = src('SimpleUI.ts');
    expect(s).toContain("bottom: 'calc(var(--sab, 0px) + 174px)'");
    expect(s).not.toContain("bottom: 'calc(var(--sab, 0px) + 152px)'");
  });
});

describe('scene-transition grammar is unified (veil + cut)', () => {
  test('tour end, postcard release and drown respawn all use the door veil', () => {
    expect(fn('main-simple.ts', 'private endTour')).toContain('fadeThrough');
    const m = src('main-simple.ts');
    // postcard pill release
    expect(fn('main-simple.ts', "showTimeOverridePill('📸 Postcard view'")).toContain(
      'fadeThrough',
    );
    // drown respawn: one message, veiled cut
    const drown = fn('main-simple.ts', 'setOnDrownRespawn');
    expect(drown).toContain('fadeThrough');
    expect(drown).toContain('pendingDrownFee');
    expect(m).not.toContain('Fished out by the shore patrol');
  });
});
