import { describe, expect, test } from 'vitest';

import { featuredSell, saleSplit } from '../economy';

describe('saleSplit', () => {
  test('under the cap: everything at full price', () => {
    expect(saleSplit(5, 0, 10, 4, 1)).toEqual({ full: 5, earn: 20 });
  });
  test('over the cap: the tail drops to the satiated price', () => {
    // 12 items, cap 10 → 10×4 + 2×1 = 42
    expect(saleSplit(12, 0, 10, 4, 1)).toEqual({ full: 10, earn: 42 });
  });
  test('cap already spent → all satiated, never negative', () => {
    expect(saleSplit(3, 15, 10, 4, 1)).toEqual({ full: 0, earn: 3 });
  });
});

describe('featuredSell (daily special)', () => {
  test('deterministic: same day → same provider', () => {
    expect(featuredSell('2026-08-11')).toEqual(featuredSell('2026-08-11'));
  });
  test('rotates: consecutive days differ often (cycle of 5 providers)', () => {
    const days = ['2026-08-11', '2026-08-12', '2026-08-13', '2026-08-14', '2026-08-15'];
    const providers = new Set(days.map((d) => featuredSell(d).provider));
    expect(providers.size).toBeGreaterThan(1); // not stuck on one provider
  });
  test('market day lifts the multiplier 2 → 2.5', () => {
    expect(featuredSell('2026-08-11', false).mult).toBe(2);
    expect(featuredSell('2026-08-11', true).mult).toBe(2.5);
  });
  test('provider is always a valid cycle member', () => {
    const valid = ['fisherman', 'baker', 'canteen', 'bank', 'carpenter'];
    for (let i = 0; i < 40; i++) {
      expect(valid).toContain(featuredSell(`day-${i}`).provider);
    }
  });

  // The load-bearing economy pin: the premium multiplies ONLY the full price,
  // so the extra faucet is bounded by cap × fullPrice × (mult-1) and the
  // satiated tail is never inflated — it can never become an uncapped faucet.
  test('premium is bounded by the daily cap and never touches the satiated tail', () => {
    const cap = 10;
    const base = 5;
    const mult = 2;
    const n = 40; // far over the cap
    const plain = saleSplit(n, 0, cap, base, 1);
    const featured = saleSplit(n, 0, cap, Math.round(base * mult), 1); // boost fullPrice ONLY
    // The extra earnings are exactly the capped full-price tranche × (mult-1).
    expect(featured.earn - plain.earn).toBe(cap * base * (mult - 1));
    // The satiated tail (n - cap items) is identical in both — never multiplied.
    const tail = n - cap;
    expect(plain.earn - cap * base).toBe(tail * 1);
    expect(featured.earn - cap * base * mult).toBe(tail * 1);
  });
});
