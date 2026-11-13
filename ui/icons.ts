/**
 * One icon set for the chrome (D13): an inline SVG sprite on a 24 px grid,
 * 1.75 px strokes in currentColor, round caps and joins. The HUD, the
 * Portfolio menu, the phone drawer and the hire card draw their controls
 * with it; narrative text may keep its emoji, and the two frozen pill labels
 * ('📖 Portfolio', '💼 Work with me') are exempt by Abbas's rulings.
 *
 * The sprite goes into the page once (ensureIconSprite) and each icon is a
 * <use> of one of its symbols, so a chip costs a few bytes of markup.
 *
 * DISTRICT_GLYPHS and PARCEL_GLYPH are plain path strings on the same grid:
 * `new Path2D(d)` draws them on a canvas (C10's minimap, P2-D8's map
 * legend), with the canvas stroked at the same width.
 */

const P = {
  menu: 'M4 6h16M4 12h16M4 18h16',
  close: 'M6 6l12 12M18 6L6 18',
  check: 'M5 12l5 5L20 7',
  'chevron-right': 'M9 6l6 6-6 6',
  'chevron-left': 'M15 6l-6 6 6 6',
  external: 'M14 4h6v6M20 4l-9 9M18 14v6H4V6h6',
  volume: 'M4 9h4l5-4v14l-5-4H4zM16 9a4 4 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11',
  'volume-x': 'M4 9h4l5-4v14l-5-4H4zM16 9l5 6M21 9l-5 6',
  'motion-off': 'M3 9c3-3 6 3 9 0s6-3 9 0M3 15c3-3 6 3 9 0s6-3 9 0M4 4l16 16',
  palette:
    'M12 3a9 9 0 1 0 0 18c1 0 1.5-1 1-2-.6-1 0-2 1-2h3a4 4 0 0 0 4-4c0-5.5-4-10-9-10zM7.5 11.5h.01M10 7.5h.01M15 7.5h.01',
  smile: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM8 14s1.5 2 4 2 4-2 4-2M9 9.5h.01M15 9.5h.01',
  camera: 'M4 8h3l2-3h6l2 3h3v11H4zM12 10a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7z',
  backpack: 'M6 9a6 6 0 0 1 12 0v11H6zM9 3.5h6M9 13h6v4H9z',
  map: 'M3 6l6-2 6 2 6-2v14l-6 2-6-2-6 2zM9 4v14M15 6v14',
  hand: 'M8 13V6a1.5 1.5 0 0 1 3 0v5M11 11V4.5a1.5 1.5 0 0 1 3 0V11M14 11V6a1.5 1.5 0 0 1 3 0v8a6 6 0 0 1-6 6h-1a5 5 0 0 1-4-2l-3-4a1.5 1.5 0 0 1 2.4-1.8L8 15',
  'file-text': 'M6 3h8l4 4v14H6zM14 3v4h4M9 12h6M9 16h6',
  'file-user':
    'M6 3h8l4 4v14H6zM14 3v4h4M12 10.5a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM8.5 19a3.5 3.5 0 0 1 7 0',
  code: 'M8 7l-5 5 5 5M16 7l5 5-5 5M14 4l-4 16',
  source:
    'M6 3v12M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 9a9 9 0 0 1-9 9',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  user: 'M12 4a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM4 21a8 8 0 0 1 16 0',
  users:
    'M9 5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7zM2 20a7 7 0 0 1 14 0M16 5.5a3.5 3.5 0 0 1 0 6.5M18 14a6 6 0 0 1 4 6',
  mail: 'M3 6h18v12H3zM3 7l9 6 9-6',
  send: 'M21 3L10 14M21 3l-7 18-4-7-7-4z',
  play: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM10 8.5v7l6-3.5z',
  share: 'M12 3v12M7 8l5-5 5 5M5 13v7h14v-7',
  coin: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10z',
  sun: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
  moon: 'M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z',
  sunset: 'M3 18h18M7 18a5 5 0 0 1 10 0M12 4v4M5 9l1.5 1.5M19 9l-1.5 1.5M8 22h8',
  cloud: 'M7 18a4 4 0 0 1-.5-8A6 6 0 0 1 18 9a4.5 4.5 0 0 1-1 9z',
  rain: 'M7 15a4 4 0 0 1-.5-8A6 6 0 0 1 18 6a4.5 4.5 0 0 1-1 9zM8 18l-1 3M12 18l-1 3M16 18l-1 3',
  keyboard: 'M3 6h18v12H3zM7 10h.01M11 10h.01M15 10h.01M7 14h10',
  book: 'M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3zM5 17a3 3 0 0 1 3-3h11',
  trophy: 'M8 4h8v5a4 4 0 0 1-8 0zM8 6H4a3 3 0 0 0 4 4M16 6h4a3 3 0 0 1-4 4M12 13v4M8 21h8M10 17h4',
  pen: 'M16 3l5 5L9 20H4v-5zM13 6l5 5',
  news: 'M4 5h13v14H6a2 2 0 0 1-2-2zM17 9h3v8a2 2 0 0 1-2 2M7 9h7M7 13h7M7 16h4',
  passport: 'M6 3h12v18H6zM12 8a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM9 17h6',
  compass: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM15.5 8.5l-2 5-5 2 2-5z',
  parcel: 'M12 3l8 4.5v9L12 21l-8-4.5v-9zM4 7.5l8 4.5 8-4.5M12 12v9M8 5.3l8 4.5',
  home: 'M3 11l9-7 9 7M5 9.5V20h5v-6h4v6h5V9.5',
  briefcase: 'M3 8h18v12H3zM8 8V5h8v3M3 13h18',
  rocket: 'M12 3c3 2 5 5.5 5 10l-2 3H9l-2-3c0-4.5 2-8 5-10zM12 9h.01M9 16l-3 4h3M15 16l3 4h-3',
  heart: 'M12 20s-8-4.6-8-10a4.5 4.5 0 0 1 8-2.8A4.5 4.5 0 0 1 20 10c0 5.4-8 10-8 10z',
  star: 'M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z',
  info: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 11v6M12 7.5h.01',
  sliders: 'M4 7h10M18 7h2M4 17h4M12 17h8M16 5v4M10 15v4',
  crown: 'M3 8l4.5 4L12 5l4.5 7L21 8l-2 11H5z',
  pin: 'M12 21s7-6.2 7-12a7 7 0 0 0-14 0c0 5.8 7 12 7 12zM12 7a2 2 0 1 0 0 4 2 2 0 0 0 0-4z',
  sparkle: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z',
  copy: 'M8 8h12v12H8zM16 8V4H4v12h4',
  chat: 'M4 5h16v11H10l-5 4v-4H4zM8 10.5h.01M12 10.5h.01M16 10.5h.01',
  mic: 'M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3zM5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M8.5 21h7',
} as const;

export type IconName = keyof typeof P;
export const ICON_NAMES = Object.keys(P) as IconName[];

/** The five districts' glyphs, for C10's minimap (Path2D strings). */
export const DISTRICT_GLYPHS: Readonly<Record<string, string>> = {
  welcome: P.home,
  professional: P.briefcase,
  projects: P.rocket,
  personal: P.heart,
  contact: P.mail,
};

/** A delivery's parcel, distinct from Contact's mail (P2-D8, A7's 'Parcel'). */
export const PARCEL_GLYPH: string = P.parcel;

/** The sprite's id prefix: '#ds-i-<name>'. */
const ID = 'ds-i-';
const SPRITE_ID = 'ds-icon-sprite';

/** The sprite's markup: one <symbol> per icon. */
export function spriteMarkup(): string {
  const symbols = ICON_NAMES.map(
    (n) => `<symbol id="${ID}${n}" viewBox="0 0 24 24"><path d="${P[n]}"/></symbol>`,
  ).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" id="${SPRITE_ID}" aria-hidden="true" style="position:absolute;width:0;height:0;overflow:hidden">${symbols}</svg>`;
}

/** Put the sprite in the page once. Idempotent. */
export function ensureIconSprite(doc: Document = document): void {
  if (doc.getElementById(SPRITE_ID)) return;
  const host = doc.createElement('div');
  host.innerHTML = spriteMarkup();
  const svg = host.firstElementChild;
  if (svg) doc.body.prepend(svg);
}

/** The stroke attributes every icon carries (CSS can restyle them). */
const STROKE =
  'fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"';

/** One icon as markup: decorative (aria-hidden), sized in px. */
export function icon(name: IconName, size = 18): string {
  return `<svg class="ds-ic" data-icon="${name}" width="${size}" height="${size}" viewBox="0 0 24 24" ${STROKE} aria-hidden="true" focusable="false"><use href="#${ID}${name}"/></svg>`;
}

/** One icon as a node. */
export function iconNode(name: IconName, size = 18): SVGSVGElement {
  const t = document.createElement('template');
  t.innerHTML = icon(name, size);
  return t.content.firstElementChild as SVGSVGElement;
}
