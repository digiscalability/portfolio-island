/**
 * Design tokens for the island's UI (stage-1 item D3): one source for the
 * colours, shapes and type that inline styles use. style.css mirrors each one
 * as a --ds-* custom property on :root, and test/tokens.test.ts keeps the two
 * in step and checks the contrast every pairing below promises.
 *
 * The --ds- prefix keeps them apart from the legacy --primary tokens
 * (style.css :root and index.html's inline style) until D17 retires those.
 *
 * Abbas's ruling (decision 1, the alternative): filled primary actions keep
 * the indigo/violet identity, darkened until white text passes AA; green is
 * reserved for the Work-with-me pill.
 */
export const DS = {
  // Surfaces, darkest first. ink-950 is the manifest's theme colour.
  ink950: '#0b1220',
  ink900: '#101826',
  ink800: '#172133',
  ink700: '#22304a',
  /** The touch discs and the aux buttons, over the world. */
  hudSurface: 'rgba(11, 18, 32, 0.78)',
  scrim: 'rgba(5, 9, 16, 0.55)',
  line: 'rgba(255, 255, 255, 0.1)',
  lineStrong: 'rgba(255, 255, 255, 0.2)',

  // Text on ink: 17.2, 11.6 and 6.3 to 1 on ink-900.
  text1: '#f3f6fb',
  text2: '#c5cfdd',
  text3: '#8d9bb0',

  /** Every filled primary action. White text: 5.41 and 5.75 to 1. */
  primary: 'linear-gradient(135deg, #4c5be0, #7a45d6)',
  /** The Work-with-me pill only. White text: 5.39 and 6.15 to 1. */
  ctaWork: 'linear-gradient(135deg, #087a4c, #067046)',
  /** Hover and press on a filled action: 8% and 15% darker. */
  hoverFilter: 'brightness(0.92)',
  pressFilter: 'brightness(0.85)',

  signal: '#ffd479',
  info: '#8fc1ff',
  danger: '#ff7a6b',
  success: '#6fcf97',

  /** Two-tone (2px dark inside 2px light) plus a 1px dark keyline outside:
   *  the light band shows against a dark panel or the night sky, and the
   *  keyline gives the ring's outer edge 3:1 against the noon and dusk sky,
   *  where the light band alone measured 1.8 and 2.3 to 1 in the HUD column. */
  focusRing: '0 0 0 2px #0b1220, 0 0 0 4px #8fc1ff, 0 0 0 5px #0b1220',

  // One district palette for the UI, each at least 6.9 to 1 on ink-900.
  districtHub: '#7cc47f',
  districtProfessional: '#6fa8e8',
  districtProjects: '#f0a24a',
  districtPersonal: '#ee7fa6',
  districtContact: '#b493e6',

  // Touch action rings: USE, JUMP, WAVE, then the contextual DIVE/FEED/EAT.
  ringUse: '#6fcf97',
  ringJump: '#7fb2ff',
  ringWave: '#ffd479',
  ringDive: '#8fc1ff',
  ringFeed: '#f0a24a',
  ringEat: '#ee7fa6',

  radiusXs: '6px',
  radiusSm: '10px',
  radiusMd: '14px',
  radiusLg: '20px',
  radiusPill: '999px',
  radiusRound: '50%',

  shadow1: '0 2px 8px rgba(3, 6, 12, 0.35)',
  shadow2: '0 8px 24px rgba(3, 6, 12, 0.45)',
  shadow3: '0 18px 48px rgba(3, 6, 12, 0.55)',

  space1: '4px',
  space2: '8px',
  space3: '12px',
  space4: '16px',
  space5: '20px',
  space6: '24px',
  space8: '32px',
  space10: '40px',

  hitTarget: '44px',
  /** The type floor. The one exception: 11px for uppercase captions with at
   *  least 0.5px tracking (the touch captions). */
  typeFloor: '12px',
  typeCaption: '11px',
} as const;

export type DsToken = keyof typeof DS;

/** The custom property that mirrors a token in style.css:
 *  'ink950' → '--ds-ink-950', 'districtHub' → '--ds-district-hub'. */
export const cssVarName = (token: DsToken): string =>
  `--ds-${token.replace(/([a-z])([A-Z0-9])/g, '$1-$2').toLowerCase()}`;
