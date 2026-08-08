/**
 * Visual theme flag — the theme A/B switch.
 *
 * DEFAULT is the UNIFIED CEL look (owner bake-off verdict 2026-08-09,
 * superseding the 2026-07-31 real-vs-toon pick — that A/B predated both
 * sides' polish kits): the toonify pass runs with the shared 3-step cel
 * ramp, Neutral tone mapping, warm-key/cool-fill lighting, cel shadow
 * edges, rim light on the cast, and ink outlines. `?theme=real` restores
 * the graded-PBR look (sky PMREM + saturation grade, no toonify).
 * URL-only on purpose: both looks stay live simultaneously and a shared
 * link fully determines what a visitor sees. (The ?look=soft atmosphere
 * experiment composes with ?theme=real only.)
 */
let cached: boolean | null = null;

export function isRealTheme(): boolean {
  if (cached === null) {
    try {
      cached = new URLSearchParams(window.location.search).get('theme') === 'real';
    } catch {
      cached = false;
    }
  }
  return cached;
}
