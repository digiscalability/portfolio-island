/**
 * The island map's projection (D18), pure and shared: the canvas markers
 * (SimpleUI.showIslandMap) and the vector map under them (ui/islandMap.ts)
 * place things with the same math, so a district's plaza and its marker
 * land on the same pixel.
 *
 * Polar, from the north pole: the pole is the centre, and the radius grows
 * with the angle from the pole until the shore latitude (0.2 rad) meets the
 * rim. u and v are in units of the disc's radius (+v is down the screen),
 * clamped to the rim.
 */
export const MAP_SHORE_LAT = 0.2;

export function mapUVLonLat(lon: number, lat: number): { u: number; v: number } {
  const r = Math.min(1, (Math.PI / 2 - lat) / (Math.PI / 2 - MAP_SHORE_LAT));
  return { u: Math.cos(lon) * r, v: Math.sin(lon) * r };
}

export function mapUV(pos: { x: number; y: number; z: number }): { u: number; v: number } {
  const len = Math.hypot(pos.x, pos.y, pos.z) || 1;
  const lat = Math.asin(Math.max(-1, Math.min(1, pos.y / len)));
  return mapUVLonLat(Math.atan2(pos.z, pos.x), lat);
}
