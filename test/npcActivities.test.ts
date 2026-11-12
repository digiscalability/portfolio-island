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

describe('the night watch (wave-2 decision: one villager who talks is up all night)', () => {
  const SPAWN = new THREE.Vector3(0.1, 1, 0.1).normalize();
  const R = 100;
  // A lamp `u` units from the spawn, along the spawn's local east.
  const east = new THREE.Vector3().crossVectors(SPAWN, new THREE.Vector3(1, 0, 0)).normalize();
  const lampAt = (u: number) =>
    SPAWN.clone()
      .applyAxisAngle(east, u / R)
      .multiplyScalar(R);

  test('he is on his round from 20:00 to 08:00, and in bed by day', () => {
    for (const h of [20, 21, 23, 0, 2, 6, 7.9])
      expect(goalFor('night_watch', h)?.activity, `${h} h`).toBe('lamp_round');
    for (const h of [8, 9, 12, 19.9]) expect(goalFor('night_watch', h)?.activity).toBe('sleep');
    for (const h of [21, 23, 2, 6]) expect(NA.isNightWatchHour(h)).toBe(true);
    for (const h of [8, 12, 19.5]) expect(NA.isNightWatchHour(h)).toBe(false);
  });

  test('the morning plan does not take him off watch before 08:00', () => {
    NA.setPlan({ assignments: { night_watch: 'stroll' }, updatedAt: Date.now() });
    expect(goalFor('night_watch', 7)?.activity).toBe('lamp_round');
  });

  test('his posts are the lamps within 22 u of the spawn, nearest first, stood off toward it', () => {
    const posts = NA.watchPosts([lampAt(40), lampAt(20), lampAt(7.6), lampAt(0.5)], SPAWN);
    expect(posts).toHaveLength(2); // 40 u is out of range; 0.5 u is the spawn itself
    expect(posts[0].angleTo(SPAWN) * R).toBeCloseTo(6.7, 1);
    expect(posts[1].angleTo(SPAWN) * R).toBeCloseTo(19.1, 1);
    // every post is beyond the arrival trail's 0.04 rad and within the guide's 30 u
    for (const p of posts) {
      expect(p.angleTo(SPAWN)).toBeGreaterThan(0.04);
      expect(p.angleTo(SPAWN) * R).toBeLessThan(30);
    }
  });

  test('the round walks those posts, and the island lamps when none is near', () => {
    const base = {
      flowers: [],
      crops: [],
      bandstand: [],
      easel: [],
      mailboxes: [],
      stalls: [],
      benches: [],
      lighthouseDir: null,
      vistas: [],
    };
    const goal = new THREE.Vector3();
    NA.setAnchors({ ...base, lamps: [lampAt(7.6), lampAt(60)], spawnDir: SPAWN });
    for (let rot = 0; rot < 4; rot++) {
      NA.getGoal('night_watch', 23, 0, undefined, { home: SPAWN.clone(), rot }, goal);
      expect(goal.angleTo(SPAWN) * R).toBeLessThan(22);
    }
    NA.setAnchors({ ...base, lamps: [lampAt(60)], spawnDir: SPAWN });
    NA.getGoal('night_watch', 23, 0, undefined, { home: SPAWN.clone(), rot: 0 }, goal);
    expect(goal.angleTo(SPAWN) * R).toBeCloseTo(60, 0);
  });
});
