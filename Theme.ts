/**
 * Visual theme flag — the ?theme=real A/B switch.
 *
 * Default (no param) is the shipped toon look. `?theme=real` renders the SAME
 * scene without the toon conversion: every material is already authored as
 * MeshStandardMaterial (see GameScene.toonifyIslandMaterials — the toon look is
 * a one-shot costume), so "real" mostly means NOT applying that pass, plus a
 * sky-based PMREM environment so PBR roughness/metalness have something to
 * reflect. URL-only on purpose: both looks stay live simultaneously and a
 * shared link fully determines what a visitor sees.
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
