import * as THREE from 'three';
import { describe, expect, test } from 'vitest';

import { withinProximity, voiceClipFits, distanceGain, PROXIMITY_RADIUS, VOICE_MAX_BYTES } from '../Chat';

const v = (x: number, y = 0, z = 0) => new THREE.Vector3(x, y, z);

describe('withinProximity', () => {
  test('true when peer is inside the radius', () => {
    expect(withinProximity(v(0), v(PROXIMITY_RADIUS - 1), PROXIMITY_RADIUS)).toBe(true);
  });
  test('false when peer is outside the radius', () => {
    expect(withinProximity(v(0), v(PROXIMITY_RADIUS + 1), PROXIMITY_RADIUS)).toBe(false);
  });
  test('true exactly at the radius boundary', () => {
    expect(withinProximity(v(0), v(PROXIMITY_RADIUS), PROXIMITY_RADIUS)).toBe(true);
  });
});

describe('voiceClipFits', () => {
  test('accepts a clip under the byte cap', () => {
    expect(voiceClipFits(VOICE_MAX_BYTES - 1, VOICE_MAX_BYTES)).toBe(true);
  });
  test('rejects a clip over the byte cap', () => {
    expect(voiceClipFits(VOICE_MAX_BYTES + 1, VOICE_MAX_BYTES)).toBe(false);
  });
});

describe('distanceGain (smoothstep, 1 at 0 → 0 at radius)', () => {
  test('full gain at distance 0', () => {
    expect(distanceGain(0, PROXIMITY_RADIUS)).toBeCloseTo(1, 5);
  });
  test('silent at/after the radius', () => {
    expect(distanceGain(PROXIMITY_RADIUS, PROXIMITY_RADIUS)).toBeCloseTo(0, 5);
    expect(distanceGain(PROXIMITY_RADIUS + 5, PROXIMITY_RADIUS)).toBe(0);
  });
  test('mid-range gain is between 0 and 1', () => {
    const g = distanceGain(PROXIMITY_RADIUS / 2, PROXIMITY_RADIUS);
    expect(g).toBeGreaterThan(0);
    expect(g).toBeLessThan(1);
  });
});
