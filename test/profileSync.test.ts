// Coin adopt-once — the Consumable Law applied to currency (economy Phase 0).
//
// The shipped bug this pins against regressing: coins were MAX-merged from the
// cloud profile, which resolves seconds after boot behind an 800ms-debounced
// save. Buy the rod, reload before the save lands, and the stale cloud balance
// "wins" — rod kept, coins refunded. Every economy sink widens that hole, so
// the merge is now adopt-once: cloud coins land only on a device that has
// never recorded any.
import { describe, expect, test } from 'vitest';

import { coinAdoptValue, mergeLessons } from '../profileSync';

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
