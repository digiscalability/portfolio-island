/**
 * Visual theme flag — the theme A/B switch.
 *
 * DEFAULT is the graded-PBR "real" look (owner A/B verdict 2026-07-31):
 * every material is already authored as MeshStandardMaterial (see
 * GameScene.toonifyIslandMaterials — the toon look is a one-shot costume), so
 * "real" means NOT applying that pass, plus a sky PMREM environment and a
 * saturation grade. `?theme=toon` restores the original stepped-toon look.
 * URL-only on purpose: both looks stay live simultaneously and a shared link
 * fully determines what a visitor sees.
 */
let cached: boolean | null = null;

export function isRealTheme(): boolean {
  if (cached === null) {
    try {
      cached = new URLSearchParams(window.location.search).get('theme') !== 'toon';
    } catch {
      cached = true;
    }
  }
  return cached;
}
