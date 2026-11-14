/**
 * The vector island map (D18): a hand-tuned SVG of the north cap, drawn
 * under showIslandMap's canvas markers. Loaded with import() the first time
 * the map opens, so it ships as its own chunk and costs the main bundle
 * nothing. It is decoration (aria-hidden): the legend under the map stays
 * the accessible path, and the canvas stays the marker layer.
 *
 * Coordinates are ui/mapProjection.ts's (u, v) x 1000: the disc's radius is
 * 1000, the pole is (0, 0). The coastline was sampled from the built island
 * (Island.isOverWater at 180 longitudes, seed 80842, 2026-11-14) and lightly
 * smoothed; the School, the shop kiosk and the harbour (the fisherman's
 * jetty) sit at the positions the map's own POIs report. Districts sit on
 * the boulevard ring (Districts.ZONE_LAT) at their longitudes; a unit test
 * holds them within 4 px of the markers.
 */
import { DISTRICTS, ZONE_LAT } from '../Districts';
import { mapUVLonLat } from './mapProjection';
import { DS } from './tokens';

const COAST =
  'M1004 0l17 36l3 36l5 36l-6 36l-16 34l-19 32l-28 29l-28 28l-15 31l-7 33l-11 32l-11 32l-2 37l1 40l-8 35l-15 33l-22 28l-34 19l-30 21l-24 25l-28 20l-32 18l-26 20l-23 25l-20 29l-19 30l-32 15l-32 14l-16 38l-23 29l-32 14l-28 22l-30 22l-34 9l-36 3l-35 6l-34 9l-31 17l-32 18l-35 7l-36 1l-34 9l-35 9l-36 -7l-35 -15l-34 -13l-34 -5l-35 0l-34 -4l-34 -1l-38 12l-38 8l-35 -9l-32 -16l-34 -12l-33 -13l-30 -20l-30 -17l-36 -7l-38 -6l-35 -12l-26 -26l-16 -38l-16 -38l-18 -32l-20 -29l-28 -19l-34 -14l-30 -20l-25 -24l-24 -25l-24 -26l-24 -26l-25 -26l-19 -29l-17 -31l-23 -29l-15 -32l3 -40l1 -38l-1 -35l6 -38l4 -35l-20 -30l-45 -26l-33 -31l-11 -35l3 -36l13 -37l25 -35l26 -34l15 -32l5 -33l0 -33l2 -34l-6 -35l-18 -40l-17 -41l-4 -39l14 -33l29 -27l25 -28l25 -27l28 -24l22 -27l14 -31l8 -35l12 -35l17 -31l19 -29l18 -32l21 -28l27 -24l30 -20l34 -14l37 -10l25 -24l19 -33l30 -19l35 -8l34 -12l32 -11l32 -13l30 -16l32 -14l33 -8l35 -4l35 1l35 -1l32 -9l33 -10l33 -4l33 -5l34 -14l34 -16l35 -14l36 -4l34 10l34 17l32 18l30 23l30 18l33 6l34 5l33 8l34 5l36 4l31 13l29 20l25 25l22 30l25 22l34 10l39 5l40 5l36 12l26 24l16 34l15 35l18 30l23 26l26 23l21 28l8 36l8 35l17 30l18 29l14 31l14 31l19 29l26 28l27 29l19 31l-6 38l-27 41l-12 36l4 34l0 33l16 33z';

/** The five districts' plazas, in map units, with their accent. */
export const ISLAND_MAP_SPOTS: ReadonlyArray<{ id: string; x: number; y: number; color: string }> =
  DISTRICTS.map((d) => {
    const { u, v } = mapUVLonLat(d.lon, d.lat);
    const color =
      {
        welcome: DS.districtHub,
        professional: DS.districtProfessional,
        projects: DS.districtProjects,
        personal: DS.districtPersonal,
        contact: DS.districtContact,
      }[d.id] ?? DS.districtHub;
    return { id: d.id, x: Math.round(u * 1000), y: Math.round(v * 1000), color };
  });

/** The boulevard ring's radius in map units. */
const RING = Math.round(mapUVLonLat(0, ZONE_LAT).u * 1000);

/** The map's SVG markup, sized to fill its box (the disc's diameter). */
export function islandMapSvg(): string {
  const road = 'fill="none" stroke="#e8d9b8" stroke-linecap="round"';
  const spokes = ISLAND_MAP_SPOTS.filter((s) => s.id !== 'welcome')
    .map((s) => `<path d="M0 0L${s.x} ${s.y}" ${road} stroke-width="22" stroke-opacity=".55"/>`)
    .join('');
  const plazas = ISLAND_MAP_SPOTS.map(
    (s) =>
      `<circle cx="${s.x}" cy="${s.y}" r="${s.id === 'welcome' ? 120 : 92}" fill="${s.color}" fill-opacity=".38" stroke="${s.color}" stroke-width="10"/>`,
  ).join('');
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-1000 -1000 2000 2000" aria-hidden="true" focusable="false" style="position:absolute;inset:0;width:100%;height:100%;pointer-events:none">` +
    `<defs><clipPath id="ds-map-disc"><circle r="1000"/></clipPath>` +
    `<radialGradient id="ds-map-land"><stop offset=".55" stop-color="#5b9a50"/><stop offset="1" stop-color="#477f40"/></radialGradient></defs>` +
    `<g clip-path="url(#ds-map-disc)">` +
    `<circle r="1000" fill="#17435e"/>` +
    `<path d="${COAST}" fill="#d9c79c"/>` +
    `<path d="${COAST}" fill="url(#ds-map-land)" transform="scale(.965)"/>` +
    `<circle r="${RING}" ${road} stroke-width="30" stroke-opacity=".6"/>` +
    spokes +
    plazas +
    // The School: a schoolhouse block with a roof.
    `<g transform="translate(-462 517)" fill="#f3ead2" stroke="#3b3326" stroke-width="8"><path d="M-55 -10h110v60h-110z"/><path d="M-70 -10L0 -60L70 -10z" fill="#c4553f"/></g>` +
    // The shop kiosk: a striped awning stall.
    `<g transform="translate(816 239)" stroke="#3b3326" stroke-width="8"><path d="M-45 0h90v45h-90z" fill="#f3ead2"/><path d="M-55 0l10-30h90l10 30z" fill="#ffd34a"/></g>` +
    // The harbour: the jetty out from the fisherman's spot, toward the sea.
    `<g transform="translate(261 -922) rotate(-164)" fill="#8a6a44" stroke="#3b3326" stroke-width="6"><path d="M-14 -20h28v150h-28z"/><path d="M-50 110h100v26h-100z"/></g>` +
    `</g></svg>`
  );
}
