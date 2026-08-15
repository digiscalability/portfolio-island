// Coin adopt-once — the Consumable Law applied to currency (economy Phase 0).
//
// The shipped bug this pins against regressing: coins were MAX-merged from the
// cloud profile, which resolves seconds after boot behind an 800ms-debounced
// save. Buy the rod, reload before the save lands, and the stale cloud balance
// "wins" — rod kept, coins refunded. Every economy sink widens that hole, so
// the merge is now adopt-once: cloud coins land only on a device that has
// never recorded any.
import { describe, expect, test } from 'vitest';

import {
  coinAdoptValue,
  inventoryAdoptValue,
  mealsAdoptValue,
  mergeLessons,
  mergeTools,
} from '../profileSync';

describe('coinAdoptValue', () => {
  test('THE EXPLOIT: a stale higher cloud balance must NOT override local truth', () => {
    // Local device spent 40c on the rod (55 -> 15, recorded). Cloud still says 55.
    expect(coinAdoptValue(true, 55)).toBeNull();
  });

  test('fresh device adopts the cloud balance once', () => {
    expect(coinAdoptValue(false, 55)).toBe(55);
  });

  test('local record wins even at zero — null vs "0" is the whole point', () => {
    // A device that spent down to 0 has a record; cloud must not "restore" it.
    expect(coinAdoptValue(true, 100)).toBeNull();
  });

  test('garbage cloud values never adopt', () => {
    expect(coinAdoptValue(false, undefined)).toBeNull();
    expect(coinAdoptValue(false, NaN)).toBeNull();
    expect(coinAdoptValue(false, Infinity)).toBeNull();
    expect(coinAdoptValue(false, '55' as unknown as number)).toBeNull();
  });

  test('adopted values are floored and clamped non-negative', () => {
    expect(coinAdoptValue(false, 12.9)).toBe(12);
    expect(coinAdoptValue(false, -5)).toBe(0);
  });
});

describe('mealsAdoptValue (cooked-food adopt-once — Consumable Law)', () => {
  test('local record present → never adopt (would refund eaten meals)', () => {
    expect(mealsAdoptValue(true, { pie: 3, fish: 2, soup: 1 })).toBeNull();
  });
  test('no local record → adopt the cloud struct', () => {
    expect(mealsAdoptValue(false, { pie: 3, fish: 2, soup: 1 })).toEqual({
      pie: 3,
      fish: 2,
      soup: 1,
    });
  });
  test('negatives and floats floored to non-negative ints; missing keys → 0', () => {
    expect(mealsAdoptValue(false, { pie: 2.9, fish: -4, soup: undefined })).toEqual({
      pie: 2,
      fish: 0,
      soup: 0,
    });
  });
  test('non-object garbage → null (keep local zeros)', () => {
    expect(mealsAdoptValue(false, undefined)).toBeNull();
    expect(mealsAdoptValue(false, 5 as unknown)).toBeNull();
    expect(mealsAdoptValue(false, null)).toBeNull();
  });
});

describe('mergeTools (owned tools — monotonic union, like lessons)', () => {
  test('unions across devices; a stale device cannot revoke a tool', () => {
    expect(mergeTools(['woodaxe'], ['fishingrod'])).toEqual(['fishingrod', 'woodaxe']);
    // Cloud missing the local axe must NOT drop it.
    expect(mergeTools(['woodaxe'], [])).toEqual(['woodaxe']);
  });
  test('garbage cloud values ignored', () => {
    expect(mergeTools(['woodaxe'], undefined)).toEqual(['woodaxe']);
    expect(mergeTools(['woodaxe'], 'fishingrod' as unknown)).toEqual(['woodaxe']);
    expect(mergeTools(['woodaxe'], [1, null, 'pickaxe'] as unknown)).toEqual([
      'pickaxe',
      'woodaxe',
    ]);
  });
});

describe('inventoryAdoptValue (raw inventory — adopt-once, Consumable Law)', () => {
  const full = { fish: 3, timber: 9, wheat: 2, produce: 5, ore: 1 };
  test('local record present → never adopt (would refund sold goods)', () => {
    expect(inventoryAdoptValue(true, full)).toBeNull();
  });
  test('fresh device adopts the cloud inventory', () => {
    expect(inventoryAdoptValue(false, full)).toEqual(full);
  });
  test('negatives/floats floored, missing keys → 0', () => {
    expect(inventoryAdoptValue(false, { fish: 2.9, timber: -4 })).toEqual({
      fish: 2,
      timber: 0,
      wheat: 0,
      produce: 0,
      ore: 0,
    });
  });
  test('non-object garbage → null', () => {
    expect(inventoryAdoptValue(false, undefined)).toBeNull();
    expect(inventoryAdoptValue(false, 7 as unknown)).toBeNull();
  });
});

describe('mergeLessons (union — per-account, additive)', () => {
  test('unions across devices and never regresses', () => {
    expect(mergeLessons(['move', 'fish'], ['chop', 'move'])).toEqual(['chop', 'fish', 'move']);
  });
  test('garbage cloud values are ignored', () => {
    expect(mergeLessons(['move'], undefined)).toEqual(['move']);
    expect(mergeLessons(['move'], 'chop' as unknown)).toEqual(['move']);
    expect(mergeLessons(['move'], [1, null, 'fish'] as unknown)).toEqual(['fish', 'move']);
  });
  test('empty local adopts cloud wholesale', () => {
    expect(mergeLessons([], ['a', 'b'])).toEqual(['a', 'b']);
  });
});
