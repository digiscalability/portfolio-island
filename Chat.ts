import * as THREE from 'three';

export const PROXIMITY_RADIUS = 14;
export const BUBBLE_TTL = 6;
export const TEXT_MAX = 120;
export const VOICE_MAX_MS = 8000;
export const VOICE_MAX_BYTES = 40_000;

/** Is `peer` within `radius` world-units of `local`? (inclusive boundary) */
export function withinProximity(
  local: THREE.Vector3,
  peer: THREE.Vector3,
  radius: number,
): boolean {
  return local.distanceTo(peer) <= radius;
}

/** Guard: reject an over-budget voice clip before it hits the wire. */
export function voiceClipFits(byteLength: number, max: number): boolean {
  return byteLength <= max;
}

/** Smoothstep gain: 1 at distance 0, easing to 0 at `radius`, 0 beyond. */
export function distanceGain(dist: number, radius: number): number {
  if (dist <= 0) return 1;
  if (dist >= radius) return 0;
  const t = 1 - dist / radius; // 1 near → 0 far
  return t * t * (3 - 2 * t);  // smoothstep
}
