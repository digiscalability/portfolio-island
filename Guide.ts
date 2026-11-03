/**
 * Guide.ts: the "Show me" seam (P2-A5).
 *
 * One window event, 'ds:guide-to' {key, label?, source}, sets the compass
 * the way an island-map pick does. Producers (D's Things to do and route
 * cards, the guide's own buttons) name a place by key; this resolver turns
 * the key into a position, from the same scene getters openIslandMap reads.
 * Pure: the world is an interface, so test/guide.test.ts runs it on a stub.
 */
import { PASSPORT_META } from './Passport';

/** Any {x, y, z} (THREE.Vector3 included). */
export interface Vec3Like {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** What the resolver may ask the world. main-simple implements it on the
 *  getters openIslandMap uses (zones, kiosk, bank, school, farm, …). */
export interface GuideWorld {
  /** A district's door (ZonesManager zone position). */
  zone(id: string): Vec3Like | null;
  school(): Vec3Like | null;
  kiosk(): Vec3Like | null;
  bank(): Vec3Like | null;
  /** Where a line can be cast: the fisherman's jetty. */
  shore(): Vec3Like | null;
  carpenter(): Vec3Like | null;
  farm(): Vec3Like | null;
  raceStart(kind: 'land' | 'water'): Vec3Like | null;
  /** The mailbox holding the active parcel. */
  nextMailbox(): Vec3Like | null;
  /** The nearest free build stake. */
  nearestStake(): Vec3Like | null;
  /** The nearest awake villager who talks through Claude Haiku 4.5. */
  nearestAiVillager(): { name: string; pos: Vec3Like } | null;
  /** The beach house on the islet (decision P2-2). */
  beachHouse(): Vec3Like | null;
}

/** A resolved key: where, and how the pill names it. */
export interface GuideHit {
  pos: Vec3Like;
  icon: string;
  label: string;
  /** The district id for a district key: its pick ends at the door. */
  zone: string | null;
}

export const GUIDE_DISTRICTS = [
  'welcome',
  'professional',
  'projects',
  'personal',
  'contact',
] as const;

/** Every key the seam answers. */
export const GUIDE_KEYS: readonly string[] = [
  ...GUIDE_DISTRICTS.map((d) => `district:${d}`),
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
];

const PLACES: Record<string, [string, string, (w: GuideWorld) => Vec3Like | null]> = {
  school: ['🏫', 'School', (w) => w.school()],
  kiosk: ['🛒', 'Shop kiosk', (w) => w.kiosk()],
  bank: ['🏦', 'Bank', (w) => w.bank()],
  shore: ['🎣', 'Fishing shore', (w) => w.shore()],
  carpenter: ['🪚', 'Carpenter', (w) => w.carpenter()],
  farm: ['🌾', 'Farm', (w) => w.farm()],
  'race:land': ['🏞️', 'Land race start', (w) => w.raceStart('land')],
  'race:water': ['🌊', 'Water race start', (w) => w.raceStart('water')],
  'mailbox:next': ['📦', 'Parcel', (w) => w.nextMailbox()],
  'stake:nearest': ['🔨', 'Build stake', (w) => w.nearestStake()],
  'beach-house': ['🏖️', 'Beach house', (w) => w.beachHouse()],
};

/** The pill's name for a district: the passport's, so the compass reads the
 *  same whether a pick or the guide set it. */
function districtName(id: string): [string, string] {
  if (id === 'welcome') return ['🏝️', 'Welcome Hub'];
  const meta = (PASSPORT_META as Record<string, { icon: string; label: string }>)[id];
  return meta ? [meta.icon, meta.label] : ['🏝️', id];
}

/** The place a key names, or null for an unknown key or one with no place. */
export function resolveGuideKey(key: string, w: GuideWorld): GuideHit | null {
  if (typeof key !== 'string') return null;
  if (key.startsWith('district:')) {
    const id = key.slice('district:'.length);
    if (!(GUIDE_DISTRICTS as readonly string[]).includes(id)) return null;
    const pos = w.zone(id);
    if (!pos) return null;
    const [icon, label] = districtName(id);
    return { pos, icon, label, zone: id };
  }
  if (key === 'villager:ai-nearest') {
    const v = w.nearestAiVillager();
    return v ? { pos: v.pos, icon: '💬', label: v.name, zone: null } : null;
  }
  const place = Object.prototype.hasOwnProperty.call(PLACES, key) ? PLACES[key] : null;
  if (!place) return null;
  const pos = place[2](w);
  return pos ? { pos, icon: place[0], label: place[1], zone: null } : null;
}

/** The detail of a 'ds:guide-to' event, validated; null when malformed. */
export function readGuideTo(
  detail: unknown,
): { key: string; label: string | null; source: string } | null {
  if (!detail || typeof detail !== 'object') return null;
  const d = detail as { key?: unknown; label?: unknown; source?: unknown };
  if (typeof d.key !== 'string' || d.key.length === 0 || d.key.length > 64) return null;
  const label = typeof d.label === 'string' && d.label.trim() ? d.label.trim().slice(0, 60) : null;
  const source = typeof d.source === 'string' && d.source ? d.source.slice(0, 24) : 'event';
  return { key: d.key, label, source };
}
