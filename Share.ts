import { track } from './Analytics';

/**
 * Share — every "put this island in front of someone else" affordance in one
 * tiny module: canonical share URLs (?zone= / ?hour=), the native share sheet
 * with clipboard + prompt fallbacks, and the photo-card compositor used by
 * photo mode. Fires `share_clicked` tagged with the calling surface — which
 * surface converts (crown modal vs race PB vs roster) is the interesting datum.
 */

export interface ShareParams {
  zone?: string | null;
  hour?: number | null;
}

/** Params worth carrying into a shared link — they change what the visitor sees. */
const CARRY = ['hour', 'theme'] as const;

/**
 * Canonical share URL: origin + path + only the params that matter. Explicit
 * values win; `hour`/`theme` are carried over from the current URL so sharing
 * from a night session shares the night.
 */
export function buildShareUrl(params: ShareParams = {}): string {
  const out = new URLSearchParams();
  try {
    const cur = new URLSearchParams(location.search);
    for (const k of CARRY) {
      const v = cur.get(k);
      if (v !== null) out.set(k, v);
    }
  } catch {
    /* ignore */
  }
  if (params.hour != null) out.set('hour', String(Math.round(params.hour * 10) / 10));
  if (params.zone != null) {
    // Zone shares use the /z/<zone> path: a serverless route serves
    // zone-specific OG tags to link scrapers, then bounces humans to /?zone=.
    // Carried params (hour/theme) ride along and survive the bounce.
    const q2 = out.toString();
    return `${location.origin}/z/${encodeURIComponent(params.zone)}${q2 ? `?${q2}` : ''}`;
  }
  const q = out.toString();
  return `${location.origin}${location.pathname}${q ? `?${q}` : ''}`;
}

/**
 * Set or remove ONE query param in the address bar without touching the rest.
 * The old ?zone= writer rebuilt the whole query string, silently nuking
 * ?hour=/?theme= — every URL write must go through here instead.
 */
export function setUrlParam(name: string, value: string | null): void {
  try {
    const sp = new URLSearchParams(location.search);
    if (value === null) sp.delete(name);
    else sp.set(name, value);
    const q = sp.toString();
    history.replaceState(null, '', `${location.pathname}${q ? `?${q}` : ''}`);
  } catch {
    /* ignore */
  }
}

export type ShareOutcome = 'shared' | 'dismissed' | 'copied' | 'prompted' | 'failed';

/**
 * Native share sheet → clipboard → copyable prompt. A user closing the sheet
 * (AbortError) is respected as "no thanks", NOT funnelled into the clipboard.
 * Never throws.
 */
export async function share(opts: {
  surface: string;
  url: string;
  title?: string;
  text?: string;
  file?: File;
}): Promise<ShareOutcome> {
  track('share_clicked', { surface: opts.surface });
  const outcome = await shareInner(opts);
  // The OUTCOME is the metric that matters — share_clicked alone can't tell a
  // completed share from a dismissed sheet, so completion rate was unknowable.
  track('share_result', { surface: opts.surface, outcome });
  return outcome;
}

async function shareInner(opts: {
  surface: string;
  url: string;
  title?: string;
  text?: string;
  file?: File;
}): Promise<ShareOutcome> {
  const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
  const files = opts.file ? [opts.file] : undefined;
  if (typeof nav.share === 'function' && (!files || nav.canShare?.({ files }) === true)) {
    try {
      await nav.share({ title: opts.title, text: opts.text, url: opts.url, files });
      return 'shared';
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') return 'dismissed';
      /* NotAllowedError / platform quirk — fall through to clipboard */
    }
  }
  try {
    await navigator.clipboard.writeText(opts.url);
    return 'copied';
  } catch {
    /* clipboard blocked (permissions / insecure context) */
  }
  try {
    window.prompt('Copy this link:', opts.url);
    return 'prompted';
  } catch {
    return 'failed';
  }
}

/**
 * Composite a raw canvas capture into a share card: the shot full-bleed with a
 * slim branded strip along the bottom (wordmark left, domain right). Returns a
 * JPEG blob ready for navigator.share files / download.
 */
export async function composePhotoCard(shot: Blob): Promise<Blob> {
  const bmp = await createImageBitmap(shot);
  const w = bmp.width;
  const h = bmp.height;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return shot;
  ctx.drawImage(bmp, 0, 0);
  bmp.close();

  // Bottom scrim — keeps the branding readable over any scene without a hard bar.
  const strip = Math.max(44, Math.round(h * 0.085));
  const grad = ctx.createLinearGradient(0, h - strip * 1.8, 0, h);
  grad.addColorStop(0, 'rgba(8, 12, 22, 0)');
  grad.addColorStop(1, 'rgba(8, 12, 22, 0.78)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, h - strip * 1.8, w, strip * 1.8);

  const pad = Math.round(strip * 0.42);
  const fontPx = Math.max(15, Math.round(strip * 0.38));
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = 'rgba(255,255,255,0.95)';
  ctx.font = `700 ${fontPx}px system-ui, 'Segoe UI', sans-serif`;
  ctx.fillText('🏝️ DigiScalability Life Island', pad, h - pad);
  ctx.fillStyle = 'rgba(190,215,255,0.92)';
  ctx.font = `600 ${Math.round(fontPx * 0.88)}px system-ui, 'Segoe UI', sans-serif`;
  const domain = 'island.digiscalability.com';
  const dw = ctx.measureText(domain).width;
  ctx.fillText(domain, w - dw - pad, h - pad);

  return await new Promise<Blob>((resolve) =>
    canvas.toBlob((b) => resolve(b ?? shot), 'image/jpeg', 0.92),
  );
}
