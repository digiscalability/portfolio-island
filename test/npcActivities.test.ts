// Unit tests for the NpcActivities goal resolver — the schedule-band math,
// mood substitution, plan-override rules, and staleness gate that drive every
// NPC's day. Pure module (three works fine in node); anchors stay unset, which
// also exercises the graceful home-jitter fallback path.

import * as THREE from 'three';
import { afterEach, describe, expect, test } from 'vitest';

import * as NA from '../NpcActivities';

const HOME = new THREE.Vector3(0.3, 0.8, 0.5).normalize();
const out = new THREE.Vector3();

function goalFor(persona: string, hour: number, mood?: Parameters<typeof NA.getGoal>[3]) {
  return NA.getGoal(persona, hour, 1, mood, { home: HOME.clone(), rot: 0 }, out);
}

afterEach(() => NA.setPlan(null));

describe('schedule bands', () => {
  test('wrap past midnight: night_watch is on lamps at 2am', () => {
    expect(goalFor('night_watch', 2)?.activity).toBe('lamp_round');
  });

  test('guard sleeps at 23:00 (20→30 band)', () => {
    expect(goalFor('guard', 23)?.activity).toBe('sleep');
  });

  test('unknown persona falls to the GENERIC schedule', () => {
    expect(goalFor('tourist', 11)?.activity).toBe('market_visit');
  });

  test('null persona (Market Vendor) keeps the plain wander', () => {
    expect(NA.getGoal(null, 11, 1, undefined, { home: HOME.clone(), rot: 0 }, out)).toBeNull();
  });
});

describe('mood substitution', () => {
  test('festive swaps the GENERIC midday slot to plaza_gather', () => {
    expect(goalFor('tourist', 11, 'festive')?.activity).toBe('plaza_gather');
  });
});

describe('server plan overrides', () => {
  test('a fresh plan re-assigns the daytime activity', () => {
    NA.setPlan({ assignments: { gardener: 'play_music' }, updatedAt: Date.now() });
    expect(goalFor('gardener', 10)?.activity).toBe('play_music');
  });

  test('prototype-chain ids are rejected, not wedged', () => {
    NA.setPlan({ assignments: { gardener: 'constructor' } });
    const g = goalFor('gardener', 10);
    expect(g?.activity).toBe('tend_flowers'); // default schedule kept
    expect(Number.isFinite(g?.dwellMin)).toBe(true);
  });

  test("a planned 'sleep' cannot flatten the town at midday", () => {
    NA.setPlan({ assignments: { gardener: 'sleep' }, updatedAt: Date.now() });
    expect(goalFor('gardener', 10)?.activity).toBe('tend_flowers');
  });

  test('the sleep window is never overridden by a plan', () => {
    NA.setPlan({ assignments: { guard: 'play_music' }, updatedAt: Date.now() });
    expect(goalFor('guard', 23)?.activity).toBe('sleep');
  });

  test('a stale plan (>48h) is dropped — defaults on planner failure', () => {
    NA.setPlan({
      assignments: { gardener: 'play_music' },
      updatedAt: Date.now() - 72 * 60 * 60 * 1000,
    });
    expect(goalFor('gardener', 10)?.activity).toBe('tend_flowers');
  });
});

describe('computeFaceDir', () => {
  test("'sea' points away from the pole (southward tangent)", () => {
    const p = new THREE.Vector3(0.5, 0.7, 0.5).normalize();
    const f = new THREE.Vector3();
    expect(NA.computeFaceDir('sea', p, f)).toBe(true);
    expect(f.dot(new THREE.Vector3(0, 1, 0))).toBeLessThan(0);
    expect(Math.abs(f.dot(p))).toBeLessThan(1e-6); // tangent to the sphere
  });

  test("'sea' is degenerate exactly at the pole", () => {
    expect(NA.computeFaceDir('sea', new THREE.Vector3(0, 1, 0), new THREE.Vector3())).toBe(false);
  });
});
