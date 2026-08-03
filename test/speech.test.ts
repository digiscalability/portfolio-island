// Silence-compression guard: cloud NPC voices occasionally arrive with
// 0.8-1.2s of dead air mid-line (measured in real prod renders). The client
// caps those before playback via silenceCutRanges — pure sample-domain logic,
// pinned here on synthetic signals.

import { describe, expect, test } from 'vitest';

import { silenceCutRanges } from '../Speech';

const SR = 44100;

function tone(seconds: number, amp = 0.5): number[] {
  const n = Math.floor(seconds * SR);
  return Array.from({ length: n }, (_, i) => amp * Math.sin((i / SR) * 2 * Math.PI * 220));
}
function silence(seconds: number): number[] {
  return new Array(Math.floor(seconds * SR)).fill(0);
}
function signal(...parts: number[][]): Float32Array {
  return Float32Array.from(parts.flat());
}
function removed(cuts: Array<[number, number]>): number {
  return cuts.reduce((n, [a, b]) => n + (b - a), 0);
}

describe('silenceCutRanges', () => {
  test('a 1s internal gap is cut down to ~0.3s', () => {
    const sig = signal(tone(1), silence(1), tone(1));
    const cuts = silenceCutRanges(sig, SR);
    expect(cuts.length).toBe(1);
    // ~0.7s removed of the 1s run (0.3s kept), within windowing tolerance
    expect(removed(cuts) / SR).toBeGreaterThan(0.6);
    expect(removed(cuts) / SR).toBeLessThan(0.8);
    // the cut lies inside the silent region (after the first second of tone)
    expect(cuts[0][0] / SR).toBeGreaterThan(0.95);
    expect(cuts[0][1] / SR).toBeLessThan(2.05);
  });

  test('natural short pauses are left alone', () => {
    const sig = signal(tone(0.8), silence(0.35), tone(0.8));
    expect(silenceCutRanges(sig, SR)).toEqual([]);
  });

  test('long leading and trailing silence are trimmed to a short edge', () => {
    const sig = signal(silence(0.8), tone(1), silence(0.9));
    const cuts = silenceCutRanges(sig, SR);
    expect(cuts.length).toBe(2);
    // leading: keep ~0.15s, cut ~0.65s; trailing similar
    expect(removed(cuts) / SR).toBeGreaterThan(1.1);
    expect(cuts[0][0]).toBe(0); // leading cut anchors at the start
  });

  test('speech with no long gaps returns no cuts', () => {
    const sig = signal(tone(2.5));
    expect(silenceCutRanges(sig, SR)).toEqual([]);
  });

  test('multiple long gaps are each capped', () => {
    const sig = signal(tone(0.5), silence(0.9), tone(0.5), silence(1.2), tone(0.5));
    const cuts = silenceCutRanges(sig, SR);
    expect(cuts.length).toBe(2);
    // ~(0.9-0.3) + (1.2-0.3) = 1.5s removed, within tolerance
    expect(removed(cuts) / SR).toBeGreaterThan(1.3);
    expect(removed(cuts) / SR).toBeLessThan(1.7);
  });
});
