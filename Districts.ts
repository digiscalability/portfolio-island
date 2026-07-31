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
  /** Marker/theme color. */
  color: number;
  /** Short radar label for the minimap. */
  radar: string;
}

// Four ring districts on the CARDINAL points (0/90/180/270°) — evenly spaced,
// replacing the old 0/72/144/216° cluster that left a 144° empty arc — plus the
// Welcome hub at the north pole. Order is Professional → Projects → Personal →
// Contact so the ring-lon deltas below map onto the hand-authored site arrays.
export const DISTRICTS: District[] = [
  { id: 'welcome', name: 'Welcome Hub', lon: 0, lat: Math.PI / 2, color: 0x4caf50, radar: 'Hub' },
  { id: 'professional', name: 'Professional Experience', lon: 0, lat: ZONE_LAT, color: 0x2196f3, radar: 'Work' },
  { id: 'projects', name: 'Project Portfolio', lon: Math.PI * 0.5, lat: ZONE_LAT, color: 0xff9800, radar: 'Projects' },
  { id: 'personal', name: 'Personal Life', lon: Math.PI, lat: ZONE_LAT, color: 0xe91e63, radar: 'Life' },
  { id: 'contact', name: 'Get In Touch', lon: Math.PI * 1.5, lat: ZONE_LAT, color: 0x9c27b0, radar: 'Contact' },
];

/** The four ring-district longitudes (avenues/plazas), pole hub excluded. */
export const RING_DISTRICT_LONS: number[] = DISTRICTS.filter((d) => d.id !== 'welcome').map((d) => d.lon);

/**
 * The OLD 72°-spaced ring longitudes the hand-authored building-site arrays in
 * Island.ts were laid out around. Each district's sites are shifted by
 * (new - old) at placement so buildings move WITH their plaza/avenue.
 */
export const OLD_RING_DISTRICT_LONS: number[] = [0, 1.2566, 2.5133, 3.7699];

/** Per-district longitude shift from the old cluster to the new cardinal layout. */
export const DISTRICT_SHIFT: number[] = RING_DISTRICT_LONS.map((l, i) => l - OLD_RING_DISTRICT_LONS[i]);

/** Unit surface direction for a district (or any lon/lat), matching Island.dirAt. */
export function dirFor(lon: number, lat: number): THREE.Vector3 {
  const cl = Math.cos(lat);
  return new THREE.Vector3(Math.cos(lon) * cl, Math.sin(lat), Math.sin(lon) * cl).normalize();
}
