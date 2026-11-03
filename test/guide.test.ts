// The 'Show me' seam (P2-A5): window 'ds:guide-to' {key, label?, source}
// names a place by key, and Guide.resolveGuideKey turns the key into the
// position the compass should point at. Pure, so it runs on a stub world.
import { describe, expect, test } from 'vitest';

import { GUIDE_KEYS, readGuideTo, resolveGuideKey, type GuideWorld, type Vec3Like } from '../Guide';

const at = (x: number): Vec3Like => ({ x, y: 100, z: 0 });

/** The audited world: every getter answers. */
const world = (over: Partial<GuideWorld> = {}): GuideWorld => ({
  zone: (id) =>
    ({ welcome: at(1), professional: at(2), projects: at(3), personal: at(4), contact: at(5) })[
      id
    ] ?? null,
  school: () => at(10),
  kiosk: () => at(11),
  bank: () => at(12),
  shore: () => at(13),
  carpenter: () => at(14),
  farm: () => at(15),
  raceStart: (kind) => (kind === 'land' ? at(16) : at(17)),
  nextMailbox: () => at(18),
  nearestStake: () => at(19),
  nearestAiVillager: () => ({ name: 'Mayor', pos: at(20) }),
  beachHouse: () => at(21),
  ...over,
});

describe('resolveGuideKey', () => {
  test('every key resolves on the audited world', () => {
    const w = world();
    for (const key of GUIDE_KEYS) {
      const hit = resolveGuideKey(key, w);
      expect(hit, key).not.toBeNull();
      expect(hit!.label.length, key).toBeGreaterThan(0);
      expect(hit!.icon.length, key).toBeGreaterThan(0);
    }
    expect(GUIDE_KEYS).toEqual(
      expect.arrayContaining([
        'district:projects',
        'school',
        'kiosk',
        'bank',
        'shore',
        'carpenter',
        'farm',
        'race:land',
        'race:water',
        'mailbox:next',
        'stake:nearest',
        'villager:ai-nearest',
        'beach-house',
      ]),
    );
  });

  test('a district resolves to its door and carries its id; the pill uses the passport name', () => {
    const hit = resolveGuideKey('district:projects', world());
    expect(hit).toEqual({ pos: at(3), icon: '🚀', label: 'Projects', zone: 'projects' });
    expect(resolveGuideKey('district:welcome', world())?.label).toBe('Welcome Hub');
    expect(resolveGuideKey('district:contact', world())?.icon).toBe('📬');
  });

  test('places resolve to their getters, with no district id', () => {
    const w = world();
    expect(resolveGuideKey('school', w)).toEqual({
      pos: at(10),
      icon: '🏫',
      label: 'School',
      zone: null,
    });
    expect(resolveGuideKey('race:water', w)?.pos).toEqual(at(17));
    expect(resolveGuideKey('mailbox:next', w)?.label).toBe('Parcel');
    expect(resolveGuideKey('villager:ai-nearest', w)).toEqual({
      pos: at(20),
      icon: '💬',
      label: 'Mayor',
      zone: null,
    });
  });

  test('unknown keys return null', () => {
    const w = world();
    for (const key of [
      '',
      'nope',
      'district:',
      'district:nope',
      'district:hire',
      'race:air',
      'School',
      'toString',
      '__proto__',
      'constructor',
    ]) {
      expect(resolveGuideKey(key, w), key).toBeNull();
    }
    expect(resolveGuideKey(42 as unknown as string, w)).toBeNull();
  });

  test('a key whose place is missing in this world returns null (the map opens instead)', () => {
    const w = world({
      school: () => null,
      zone: () => null,
      nearestAiVillager: () => null,
      nextMailbox: () => null,
    });
    expect(resolveGuideKey('school', w)).toBeNull();
    expect(resolveGuideKey('district:projects', w)).toBeNull();
    expect(resolveGuideKey('villager:ai-nearest', w)).toBeNull();
    expect(resolveGuideKey('mailbox:next', w)).toBeNull();
  });
});

describe('readGuideTo', () => {
  test('a key, an optional label and a source', () => {
    expect(readGuideTo({ key: 'school', source: 'things-to-do' })).toEqual({
      key: 'school',
      label: null,
      source: 'things-to-do',
    });
    expect(readGuideTo({ key: 'district:projects', label: ' 🚀 Projects ', source: 'd8' })).toEqual(
      { key: 'district:projects', label: '🚀 Projects', source: 'd8' },
    );
    expect(readGuideTo({ key: 'bank' })?.source).toBe('event');
  });

  test('malformed details are dropped', () => {
    for (const d of [
      null,
      undefined,
      'school',
      7,
      {},
      { key: '' },
      { key: 3 },
      { key: 'x'.repeat(65) },
    ]) {
      expect(readGuideTo(d), JSON.stringify(d) ?? String(d)).toBeNull();
    }
  });
});
