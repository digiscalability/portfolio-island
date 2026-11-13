/**
 * SignPainter — one canvas generator for every board in the world (C6).
 *
 * The gate boards and the project plaques were UI plates pasted onto the
 * world: bold system type on navy glass. Every board now reads as painted
 * timber: a plank field with a cream frame, a band in the district's colour,
 * and Bebas Neue lettering in cream with a dark ink stroke.
 *
 * DETERMINISTIC. Boards are built inside GameScene.initialize's seeded
 * window, so the painter never calls Math.random: a board's canvas
 * operations are a pure function of its spec and the face it paints with
 * (signPainter.test.ts records them).
 *
 * FONTS NEVER BLOCK THE WINDOW. A board paints at once with whatever face is
 * ready (Bebas Neue when the page already has it, the fallback stack
 * otherwise) and repaints the SAME CanvasTexture when
 * document.fonts.load resolves. The repaint creates no three object and
 * draws nothing; it is never awaited.
 *
 * The family name is exactly 'Bebas Neue' (the D12 contract): today it comes
 * from the Google CSS in index.html, and after D12 from the self-hosted face
 * under the same name.
 */
import * as THREE from 'three';

/** The lettering family (the D12 contract name). */
export const SIGN_FONT_FAMILY = 'Bebas Neue';
/** What paints before the face arrives: condensed faces first, so the
 *  fallback's width is close to Bebas Neue's. */
export const SIGN_FALLBACK_STACK = "'Arial Narrow', 'Roboto Condensed', Impact, sans-serif";

/**
 * The palette. The brief's timber is #8a6238 with #6d4a2f plank lines, but
 * cream lettering (#fff3d6) on #8a6238 is 4.95:1, under the 7:1 bar. The
 * plank colour becomes the field (7.2:1) and the planks are drawn a shade
 * darker, so the board still reads as timber.
 */
export const SIGN_COLORS = {
  timber: '#6d4a2f',
  plank: '#573a24',
  frame: '#f2e6c8',
  letter: '#fff3d6',
  stroke: '#1c2430',
} as const;

/** Canvas sizes (px). The plaque keeps today's 320x72, so texture memory is
 *  no higher than before (amendment C6). */
export const SIGN_SIZES = {
  gate: { w: 512, h: 128 },
  plaque: { w: 320, h: 72 },
} as const;

export type SignKind = keyof typeof SIGN_SIZES;

export interface SignSpec {
  kind: SignKind;
  /** The main line (painted in capitals). */
  text: string;
  /** An optional second, smaller line (the plaques' status). */
  sub?: string;
  /** The district colour of the band, as a hex number. */
  band: number;
}

/** Layout per kind: frame width, band height, and the lettering's sizes. The
 *  main line's font size gives a cap height of about 0.7 em in Bebas Neue. */
const LAYOUT: Record<
  SignKind,
  { frame: number; band: number; main: number; sub: number; pad: number }
> = {
  // 92 px: cap height ~64 px of 128 on a 0.45 u board = 0.225 u (C6's bar:
  // 10 px at 20 u and 24 px at 8 u at 1440x900 and a 50 deg field need 0.21 u).
  gate: { frame: 6, band: 10, main: 92, sub: 0, pad: 14 },
  // 40 px: cap ~28 px of 72 on a 0.585 u board = 0.228 u.
  plaque: { frame: 4, band: 10, main: 40, sub: 17, pad: 10 },
};

/** The main line's font size for a kind (the cap height is ~0.7 of it). */
export function signFontPx(kind: SignKind): number {
  return LAYOUT[kind].main;
}

function fontString(px: number, family: string): string {
  return `${px}px ${family}`;
}

/** The family string for a face: Bebas Neue first when it is ready. */
export function signFamily(bebasReady: boolean): string {
  return bebasReady ? `'${SIGN_FONT_FAMILY}', ${SIGN_FALLBACK_STACK}` : SIGN_FALLBACK_STACK;
}

/** Shrink `px` until `text` fits `maxW` (a fallback face may run wide). */
function fitFont(
  ctx: CanvasRenderingContext2D,
  text: string,
  px: number,
  family: string,
  maxW: number,
  minPx: number,
): number {
  let size = px;
  ctx.font = fontString(size, family);
  while (size > minPx && ctx.measureText(text).width > maxW) {
    size -= 2;
    ctx.font = fontString(size, family);
  }
  return size;
}

function hex(n: number): string {
  return `#${(n & 0xffffff).toString(16).padStart(6, '0')}`;
}

/**
 * Paint one board into `ctx`, in the rectangle at (ox, oy) of the kind's
 * size. Deterministic: the operations depend only on the spec, the offset and
 * `family` (and on measureText, for the fit).
 */
export function paintSign(
  ctx: CanvasRenderingContext2D,
  spec: SignSpec,
  family: string,
  ox = 0,
  oy = 0,
): void {
  const { w, h } = SIGN_SIZES[spec.kind];
  const L = LAYOUT[spec.kind];
  ctx.save();
  ctx.translate(ox, oy);
  // Timber field and three plank seams.
  ctx.fillStyle = SIGN_COLORS.timber;
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = SIGN_COLORS.plank;
  const inner = h - 2 * L.frame - L.band;
  for (let i = 1; i <= 2; i++) {
    const y = Math.round(L.frame + (inner * i) / 3);
    ctx.fillRect(L.frame, y - 1, w - 2 * L.frame, 2);
  }
  // The district band along the bottom, inside the frame.
  ctx.fillStyle = hex(spec.band);
  ctx.fillRect(L.frame, h - L.frame - L.band, w - 2 * L.frame, L.band);
  // Cream frame.
  ctx.strokeStyle = SIGN_COLORS.frame;
  ctx.lineWidth = L.frame;
  ctx.strokeRect(L.frame / 2, L.frame / 2, w - L.frame, h - L.frame);
  // Lettering: the ink stroke under the cream fill.
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  const maxW = w - 2 * (L.frame + L.pad);
  const main = spec.text.toUpperCase();
  const top = L.frame;
  const bottom = h - L.frame - L.band;
  const hasSub = !!spec.sub && L.sub > 0;
  const mainPx = fitFont(ctx, main, L.main, family, maxW, Math.round(L.main * 0.6));
  // Bebas Neue's caps sit a little high of the em box's middle.
  const mainY = hasSub
    ? top + (bottom - top) * 0.4
    : top + (bottom - top) / 2 + Math.round(mainPx * 0.04);
  ctx.strokeStyle = SIGN_COLORS.stroke;
  ctx.lineWidth = 4;
  ctx.strokeText(main, w / 2, mainY);
  ctx.fillStyle = SIGN_COLORS.letter;
  ctx.fillText(main, w / 2, mainY);
  if (hasSub) {
    const sub = spec.sub!.toUpperCase();
    fitFont(ctx, sub, L.sub, family, maxW, Math.round(L.sub * 0.6));
    const subY = top + (bottom - top) * 0.82;
    ctx.lineWidth = 3;
    ctx.strokeText(sub, w / 2, subY);
    ctx.fillText(sub, w / 2, subY);
  }
  ctx.restore();
}

/**
 * Is Bebas Neue loaded? Not FontFaceSet.check: it answers true when no face
 * of that family is registered at all (the Google stylesheet not parsed
 * yet), which would paint the fallback and never repaint. This looks for a
 * registered face of the family whose status is 'loaded'.
 */
export function bebasLoaded(): boolean {
  try {
    if (typeof document === 'undefined' || !document.fonts) return false;
    for (const f of document.fonts as unknown as Iterable<FontFace>) {
      if (f.family.replace(/["']/g, '') === SIGN_FONT_FAMILY && f.status === 'loaded') return true;
    }
  } catch {
    /* no iterable FontFaceSet */
  }
  return false;
}

/** Boards still on the fallback face, repainted once Bebas Neue loads. */
const pendingRepaints: Array<() => void> = [];
let fontWatch = false;

function flushRepaints(): void {
  if (!pendingRepaints.length || !bebasLoaded()) return;
  for (const r of pendingRepaints.splice(0)) r();
}

/**
 * Repaint a board with Bebas Neue once the face loads. Fire and forget:
 * never awaited, and a failure leaves the fallback paint in place. Asks for
 * the face now, and watches every font load the page does after (the
 * stylesheet may arrive later than this board), so whichever comes first
 * repaints.
 */
function repaintWhenFontLoads(repaint: () => void): void {
  try {
    if (typeof document === 'undefined' || !document.fonts?.load) return;
    pendingRepaints.push(repaint);
    const fonts = document.fonts;
    const ask = (): void => {
      void fonts
        .load(`64px '${SIGN_FONT_FAMILY}'`)
        .then(flushRepaints)
        .catch(() => {});
    };
    ask();
    if (!fontWatch) {
      fontWatch = true;
      fonts.addEventListener?.('loadingdone', flushRepaints);
      void fonts.ready?.then(flushRepaints).catch(() => {});
      // The stylesheet may land after the first ask: ask again once the page
      // has loaded it.
      if (typeof window !== 'undefined' && document.readyState !== 'complete') {
        window.addEventListener('load', ask, { once: true });
      }
    }
  } catch {
    /* no FontFaceSet: the fallback stays */
  }
}

/**
 * A CanvasTexture holding one or more boards stacked vertically (an atlas
 * when there are several, all of one kind). Paints now with the face that is
 * ready and repaints in place when Bebas Neue arrives. Build it under
 * WorldSeed.withLocalRng inside the seeded window: the texture's uuids are
 * three's, the painting draws nothing.
 */
export function createSignTexture(specs: SignSpec[]): THREE.CanvasTexture | null {
  if (!specs.length || typeof document === 'undefined') return null;
  const { w, h } = SIGN_SIZES[specs[0].kind];
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h * specs.length;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const paintAll = (family: string): void => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    specs.forEach((s, i) => paintSign(ctx, s, family, 0, i * h));
  };
  const ready = bebasLoaded();
  paintAll(signFamily(ready));
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  // Boards are read obliquely while walking past.
  tex.anisotropy = 4;
  if (!ready) {
    repaintWhenFontLoads(() => {
      paintAll(signFamily(true));
      tex.needsUpdate = true;
    });
  }
  return tex;
}

/**
 * The Projects district's five boards (C8, decision 14): today's five sites
 * in WORK_SITES order, by the Public Fact Sheet's names and statuses. Ammi's
 * recipes, never "grandmother"; no board calls DigiScalability a studio.
 * Abbas checked them on 2026-11-13; the island board reads Life Island, its
 * product name, not the business name.
 */
export const PROJECT_BOARDS: ReadonlyArray<{ name: string; status: string }> = [
  { name: 'RankPilot', status: 'Pre-launch' },
  { name: 'ChocoMate', status: 'Paused' },
  { name: 'Life Island', status: 'This island' },
  { name: "Bano's Cookbook", status: "Ammi's recipes" },
  { name: 'Insta Services API', status: 'Modernising' },
];
