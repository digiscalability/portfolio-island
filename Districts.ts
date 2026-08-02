import * as THREE from 'three';

/**
 * Districts — the SINGLE source of truth for the town layout.
 *
 * The district longitudes/latitude used to be hardcoded in four places that
 * only aligned by coincidence of duplicated constants:
 *   - Island.ts       (DISTRICT_LONS, pre-claims, flower anchors, building sites)
 *   - ZonesManager.ts (the glowing plaza markers, as Math.PI*2k/5 trig)
 *   - GameScene.ts     (the minimap zone dots, twice)
 * Re-laying-out the town meant editing all of them in lockstep or the markers
 * and radar silently drifted off the actual streets. Everything now reads from
 * here, so a re-layout is a one-file edit.
 *
 * Coordinate convention matches Island.dirAt(lon, lat):
 *   x = cos(lon)cos(lat), y = sin(lat), z = sin(lon)cos(lat)   (y = north pole)
 */

// The boulevard + plaza latitude band (atan(0.5) ≈ 26.57°N).
export const ZONE_LAT = 0.4636;

export interface District {
  id: string;
  name: string;
  /** Longitude in radians (the pole hub ignores lon; its lat is PI/2). */
  lon: number;
  lat: number;
  /** Bright marker/theme color (zone marker, minimap dot, panel border). */
  color: number;
  /** Desaturated PASTORAL accent used to tint the WORLD near this district —
   *  terrain, grass, props, atmosphere. Deliberately muted (never the raw
   *  `color`) so districts read as distinct-but-cohesive, not theme-park. */
  accent: number;
  /** Short radar label for the minimap. */
  radar: string;
}

// Four ring districts on the CARDINAL points (0/90/180/270°) — evenly spaced,
// replacing the old 0/72/144/216° cluster that left a 144° empty arc — plus the
// Welcome hub at the north pole. Order is Professional → Projects → Personal →
// Contact so the ring-lon deltas below map onto the hand-authored site arrays.
export const DISTRICTS: District[] = [
  {
    id: 'welcome',
    name: 'Welcome Hub',
    lon: 0,
    lat: Math.PI / 2,
    color: 0x4caf50,
    accent: 0x8fbf7f,
    radar: 'Hub',
  },
  {
    id: 'professional',
    name: 'Professional Experience',
    lon: 0,
    lat: ZONE_LAT,
    color: 0x2196f3,
    accent: 0x7fa8c9,
    radar: 'Work',
  },
  {
    id: 'projects',
    name: 'Project Portfolio',
    lon: Math.PI * 0.5,
    lat: ZONE_LAT,
    color: 0xff9800,
    accent: 0xc9a06a,
    radar: 'Projects',
  },
  {
    id: 'personal',
    name: 'Personal Life',
    lon: Math.PI,
    lat: ZONE_LAT,
    color: 0xe91e63,
    accent: 0xd9a8b8,
    radar: 'Life',
  },
  {
    id: 'contact',
    name: 'Get In Touch',
    lon: Math.PI * 1.5,
    lat: ZONE_LAT,
    color: 0x9c27b0,
    accent: 0xa98fc0,
    radar: 'Contact',
  },
];

/**
 * Precomputed district centre directions + accent colours, for cheap
 * per-vertex / per-prop "nearest district" tinting. Building it once here keeps
 * Island/GameScene from re-deriving the trig.
 */
export const DISTRICT_ACCENTS: Array<{ dir: THREE.Vector3; color: THREE.Color }> = DISTRICTS.map(
  (d) => ({ dir: dirFor(d.lon, d.lat), color: new THREE.Color(d.accent) }),
);

/**
 * Nearest-district accent for a surface direction, as a 0..1 weight that peaks
 * at a plaza centre and falls to 0 by the mid-point between districts. Writes
 * the accent into `outColor` and returns the weight (0 = leave the base colour
 * alone). Allocation-free apart from `outColor`.
 */
export function districtAccentAt(dir: THREE.Vector3, outColor: THREE.Color): number {
  let bestDot = -Infinity;
  let best: THREE.Color | null = null;
  for (const a of DISTRICT_ACCENTS) {
    const dot = dir.x * a.dir.x + dir.y * a.dir.y + dir.z * a.dir.z;
    if (dot > bestDot) {
      bestDot = dot;
      best = a.color;
    }
  }
  if (!best) return 0;
  outColor.copy(best);
  // dot 0.985 (~10°) → full tint, 0.90 (~26°) → none. Districts are 90° apart,
  // so boundaries land at dot≈0.71 and stay untinted.
  const t = (bestDot - 0.9) / (0.985 - 0.9);
  return t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t);
}

/** The four ring-district longitudes (avenues/plazas), pole hub excluded. */
export const RING_DISTRICT_LONS: number[] = DISTRICTS.filter((d) => d.id !== 'welcome').map(
  (d) => d.lon,
);

/**
 * The OLD 72°-spaced ring longitudes the hand-authored building-site arrays in
 * Island.ts were laid out around. Each district's sites are shifted by
 * (new - old) at placement so buildings move WITH their plaza/avenue.
 */
export const OLD_RING_DISTRICT_LONS: number[] = [0, 1.2566, 2.5133, 3.7699];

/** Per-district longitude shift from the old cluster to the new cardinal layout. */
export const DISTRICT_SHIFT: number[] = RING_DISTRICT_LONS.map(
  (l, i) => l - OLD_RING_DISTRICT_LONS[i],
);

/** Unit surface direction for a district (or any lon/lat), matching Island.dirAt. */
export function dirFor(lon: number, lat: number): THREE.Vector3 {
  const cl = Math.cos(lat);
  return new THREE.Vector3(Math.cos(lon) * cl, Math.sin(lat), Math.sin(lon) * cl).normalize();
}
