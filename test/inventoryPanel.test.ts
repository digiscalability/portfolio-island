// Locks for the pack (held-inventory panel) and the Consumable-Law hole the
// audit surfaced while scoping it.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const src = (f: string): string => readFileSync(join(process.cwd(), f), 'utf8');

const fn = (file: string, marker: string, span = 3000): string => {
  const s = src(file);
  const i = s.indexOf(marker);
  expect(i, `${marker} not found in ${file}`).toBeGreaterThan(-1);
  return s.slice(i, i + span);
};

describe('CONSUMABLE LAW: a corrupt blob must not refund the inventory', () => {
  test('hasLocalInventory is set BEFORE the ds_meals parse can throw', () => {
    // Both live in one try. With the flag set after the parse, a corrupt
    // ds_meals threw, the catch swallowed it, the flag kept its `false`
    // default, and inventoryAdoptValue's guard then passed — overwriting the
    // fish/timber/wheat/produce/ore already loaded from localStorage with the
    // cloud basket. One bad blob refunded everything sold since the last push.
    const boot = src('main-simple.ts');
    const flag = boot.indexOf('this.hasLocalInventory = [');
    const parse = boot.indexOf("localStorage.getItem('ds_meals')");
    expect(flag).toBeGreaterThan(-1);
    expect(parse).toBeGreaterThan(-1);
    expect(flag).toBeLessThan(parse);
  });

  test('and the meals parse is individually guarded', () => {
    expect(fn('main-simple.ts', 'this.hasLocalInventory = [', 1400)).toContain(
      'JSON.parse(rawMeals)',
    );
    // Its own try/catch, so a throw costs only the meals.
    const region = fn('main-simple.ts', 'const rawMeals =', 600);
    expect(region).toMatch(/try\s*\{[\s\S]*JSON\.parse\(rawMeals\)/);
  });
});

describe('the pack re-renders instead of stacking', () => {
  test('showInventory drops the previous element first', () => {
    // PanelManager's same-id re-open replaces the SPEC without firing
    // close() — by design, so the shop can re-render per purchase. That
    // means the old DOM node survives: without this the change-hook
    // re-render appended a second modal over a stale one (measured: the
    // stale copy still read 4 fish after the value moved to 9).
    expect(fn('SimpleUI.ts', 'showInventory(): void')).toContain('this.packDiv?.remove()');
  });

  test('the app re-renders it from the funnels every mutation passes through', () => {
    const s = src('main-simple.ts');
    expect(s).toContain('refreshPackIfOpen');
    // Coins need NO keypress (proximity pickup), so the coin hook matters most.
    expect(fn('main-simple.ts', 'setOnCoinCollected')).toContain('refreshPackIfOpen');
    // Raw resources all persist through syncInventory; feed/meals through
    // refreshFeedHud.
    expect(fn('main-simple.ts', 'private syncInventory')).toContain('refreshPackIfOpen');
    expect(fn('main-simple.ts', 'private refreshFeedHud')).toContain('refreshPackIfOpen');
  });
});

describe('the pack shows what nothing else did', () => {
  test('all five raw resources are present', () => {
    // Fish/timber/wheat/produce/ore had NO on-screen home: the feed chip
    // shows only feed+meals, and timber appeared solely in the build chooser
    // while standing at a stake.
    const p = fn('main-simple.ts', 'setInventoryProvider', 4000);
    for (const label of ["'Fish'", "'Timber'", "'Wheat'", "'Produce'", "'Ore'"]) {
      expect(p).toContain(label);
    }
  });

  test('the carried quest item is shown (its only UI anywhere)', () => {
    expect(fn('main-simple.ts', 'setInventoryProvider', 4000)).toContain('isCarryingFetchItem');
  });

  test('bird feed does not reuse the wheat glyph', () => {
    // 🌾 is wheat in the world; two rows sharing one glyph in a panel whose
    // whole job is telling holdings apart is a mis-read waiting to happen.
    const p = fn('main-simple.ts', 'setInventoryProvider', 4000);
    const birdLine = p.split('\n').find((l) => l.includes("label: 'Bird feed'"));
    expect(birdLine).toBeDefined();
    const iconLine = p.split('\n')[p.split('\n').indexOf(birdLine!)];
    expect(iconLine).not.toContain('🌾');
  });

  test('values are escaped at the HTML sink', () => {
    expect(fn('SimpleUI.ts', 'showInventory(): void')).toContain('SimpleUI.esc');
  });
});
