All research done — the doc below is grounded in the actual code. One load-bearing discovery up front: **this is already a PBR-authored scene wearing a toon costume.** Every prop factory in `Materials.ts` emits `MeshStandardMaterial`, and the toon look is applied by a single one-shot conversion pass. That makes Stage 1 mostly a *deletion*, not a rewrite.

---

# Portfolio Island — Toon → "Graphical" Realistic Theme: Staged Migration Proposal

*Read-only research doc, 2026-07-31. Every claim about current code cites file:line. Companion to `docs/superpowers/plans/2026-07-30-graphics-mobile-audit.md`.*

## 0. Ground truth — how the current look is actually made

- **Authoring is PBR, presentation is toon.** All prop/material factories produce `MeshStandardMaterial` with per-prop roughness/metalness/envMapIntensity (`Materials.ts:32-61`, `100-198`). Then one pass, `toonifyIslandMaterials()` (`GameScene.ts:2844-2873`, called once at `GameScene.ts:385`), traverses `island.mesh` and swaps **every opaque** `MeshStandardMaterial` for a `MeshToonMaterial` sharing one gradient ramp. The conversion keeps only `color / emissive / emissiveIntensity / map / vertexColors` (`GameScene.ts:2852-2859`) — **normalMap, roughnessMap, aoMap, metalness are silently dropped.**
- **The ramp** is a 12-step green-tinted pastel `DataTexture` (`Materials.ts:66-79`) — the audit's "neutral ramp" item targets exactly this.
- **Toonify exemptions:** transparent materials are skipped (`GameScene.ts:2849`), which is how the sea keeps PBR shading (`Island.ts:781-786` comment says so explicitly). The **player is never toonified at all** — `player.glb` loads in `SimplePlayer.ts:407, 852`, outside `island.mesh`, so the player already renders as `MeshStandardMaterial` against a toon world today.
- **Sea:** `MeshStandardMaterial`, `transparent`, opacity 0.92, roughness 0.3, metalness 0.12 (`Island.ts:787-799`); waves + analytic normal perturbation injected via `onBeforeCompile` (`Island.ts:803-852`), depth-keyed surf/foam in fragment (`Island.ts:857-893`), 96×96 sphere (`Island.ts:897`).
- **Terrain:** vertex-colored `MeshStandardMaterial`, roughness 0.85 (`Island.ts:760-769`) → toonified. **Grass** is the one thing authored *directly* as `MeshToonMaterial` (`Island.ts:287-291`), instanced 12k/32k (`Island.ts:324`), per-instance color (`Island.ts:380-390`).
- **Lighting rig:** ambient 0.22 warm (`GameScene.ts:625`), sun key 1.6 (`GameScene.ts:630`), hemi 0.62 (`GameScene.ts:668`), fill 0.18 (`GameScene.ts:673`), rim 0.55 (`GameScene.ts:680`); deliberate ~2:1 key:fill (comment `GameScene.ts:618-624`). Shadows: PCFSoft (`SimpleRenderer.ts:71`), 1024²/2048² by tier (`GameScene.ts:637-642`), player-following box, normalBias 0.035 (`GameScene.ts:657`).
- **Sky/fog/cycle:** custom gradient sky dome shader (`GameScene.ts:2875-2929`); `FogExp2(0xa8d8f0, 0.012)` (`GameScene.ts:329`); `EnvironmentCycle` drives sun arc, sky palette, fog color/density, stars, moon (`EnvironmentCycle.ts:455-549`, palettes `25-47`).
- **Renderer:** three **r0.180.0** (`package.json:34`), ACESFilmic exposure 1.08, sRGB out (`SimpleRenderer.ts:67-69`); DPR tiering with pixel budget and 1.25 cap on phones (`SimpleRenderer.ts:118-135`); composer desktop-only with MSAA-4 HalfFloat target + half-res UnrealBloom 0.4/0.6/0.85 (`SimpleRenderer.ts:148, 161-189`).
- **TextureGenerator.ts is 95% dead.** `createRoadTextures` (`TextureGenerator.ts:7-54`) has **zero call sites**. `createBuildingTextures` is called once (`Island.ts:973`) and fed into a PBR material (`Island.ts:974-982`) — but toonify then throws away its normal/roughness/AO maps, keeping only the albedo. The Sobel normal-map generator (`TextureGenerator.ts:105-146`) currently produces nothing visible.
- **No environment map exists anywhere.** Grep for `scene.environment` / `PMREM`: zero matches in the repo. Every `envMapIntensity` — the factories (`Materials.ts:58-59`) and the whole per-GLB override table (`Island.ts:2834-2861`) — is a dead knob today, exactly as the audit says.
- **Assets:** `public/assets/models/` is ~213KB total, 10 GLBs; binary inspection shows `baseColorFactor` + `pbrMetallicRoughness` only — **no `"images"`/`"textures"` entries in any GLB.** Pure flat-color low-poly, as expected.
- **Query-flag precedent** for A/B: `?zone` (`main-simple.ts:588`), `?founder` (`Multiplayer.ts:91`), `?debug` (`SimpleUI.ts:1593`).

## 0b. Re-examining the audit's PMREM rejection — it inverts

The "Don't bother" entry (plan line 78) rejects PMREM/env-maps on three grounds: (a) `scene.environment` is never set, (b) toonified props can't consume it (`MeshToonMaterial` ignores env maps — true), (c) every `envMapIntensity` is a no-op. **All three premises are artifacts of the toonify pass.** Under a `?theme=real` branch that skips toonify, every material in the scene is `MeshStandardMaterial` again, `scene.environment` lights *everything* automatically, and the override table at `Island.ts:2836-2855` plus the factory intensities become live, pre-tuned data. The rejection was correct *for the toon look* and is void for this one. (The Stage-0 fresnel-water item overlaps with a real env map on the sea — see Stage 1 risks.)

---

## Stage 0 — Graded stylized (already planned; assume landed)

Neutral ramp (`Materials.ts:66-79`), fresnel sky-mix water (`Island.ts:857-893`), sun disc, day/night bloom+exposure (`SimpleRenderer.ts:131-136` per plan). These improve the toon look and are theme-independent groundwork: the neutral ramp fixes color grading, and day/night exposure plumbing is reused by every later stage.

## Stage 1 — "Stylized-PBR lite" (flat colors + PMREM IBL + roughness variation)

**What it is:** skip toonify, add a sky-derived environment map, and inject micro roughness variation so flat colors don't go plastic.

**Exact touchpoints:**

1. **Theme flag:** one read, e.g. `const THEME_REAL = new URLSearchParams(location.search).get('theme') === 'real'` (pattern: `main-simple.ts:588`). Gate `GameScene.ts:385` — `if (!THEME_REAL) this.toonifyIslandMaterials();` That single line un-toonifies terrain, all props, all GLBs, and revives the building textures' normal/rough/AO maps (`Island.ts:973-982`) for free.
2. **PMREM from the sky:** in `setupLighting()` after `createSkyDome()` (`GameScene.ts:686`): render a sky-only throwaway scene with the same gradient shader through `new THREE.PMREMGenerator(renderer).fromScene(skyScene, 0.04)`; set `scene.environment = pmrem.texture`. Needs the renderer, so plumb it through (renderer is already reachable at `warmUp` time, `SimpleRenderer.ts:202-220`; generating during warm-up keeps it off the reveal frame).
3. **Day/night coupling — do NOT regenerate PMREM per frame.** Drive `scene.environmentIntensity` (r163+, fine on r180) from `getDayFactor()` (`EnvironmentCycle.ts:97-99`) inside `EnvironmentCycle.update()` — e.g. lerp 1.0 → 0.15 into night, tinted via a second pre-baked night PMREM only if the single-map version looks wrong. Regenerating PMREM is a multi-pass GPU job; at most rebuild on day-phase bucket changes (4-6 per day), never per frame.
4. **Grass parallel path:** `Island.ts:287-291` picks `MeshStandardMaterial({vertexColors, side: DoubleSide, roughness: 0.95})` when real; the wind `onBeforeCompile` (`Island.ts:292-312`) targets `#include <begin_vertex>`, which exists identically in the standard shader — it ports unchanged. (Option: keep grass toon/Lambert even in real theme — 12-32k double-sided blades are the biggest fragment-overdraw surface, and grass reads fine flat.)
5. **Roughness variation ("anti-plastic"):** one shared 128² tiling grayscale noise `CanvasTexture` (reuse the `TextureGenerator.ts:33-48` pattern), assigned as `roughnessMap` in `Materials.createPBRMaterial` (`Materials.ts:45-60`) with per-prop `roughness` acting as the multiplier it already is in three. ~65KB GPU, one texture shared by everything.
6. **Emissive-tag compatibility:** `EnvironmentCycle.nightEmissives` already types both material classes (`EnvironmentCycle.ts:82-85`) — no change needed.

**Expected visual delta:** props gain real specular response and sky-colored ambient; the dead override table (`Island.ts:2836-2855`) starts differentiating wood benches from painted mailboxes; the sea (metalness 0.12, roughness 0.3 — `Island.ts:797-798`) picks up genuine sky reflection; the player finally matches the world instead of being the only PBR object in a toon scene. The rig's 2:1 key:fill and rim (`GameScene.ts:618-683`) carry over — that comment's warning about the toon ramp crushing undersides no longer applies, so ambient/hemi may even come *down* slightly.

**GPU cost (honest estimates):** shader class goes Lambert-plus-ramp → GGX + IBL: roughly **2-3× fragment ALU** on lit opaque pixels, plus 2 texture fetches (cubeUV env, shared roughness noise). On desktop at the existing 2.5MP budget: noise. On phones (DPR already capped 1.25, `SimpleRenderer.ts:127`): expect **~1-2ms added fragment time on a mid-tier tile GPU** — comfortably repaid by the audit's bloom-skip-on-phones item (~13 passes saved), which should land first. Texture memory: PMREM at 256 cube → one cubeUV HalfFloat 2D texture, **~3-5MB**; roughness noise ~65KB. No new draw calls; program count roughly returns to what the un-toonified scene would have had (the toonify cache dedup at `GameScene.ts:2846-2860` goes away, but material *instances* were already deduped upstream by the factories).

**Risk list:**
- **Gray-plastic trap** — flat albedo + uniform roughness + neutral IBL is the classic failure. Mitigations, in order of leverage: (1) keep **metalness 0** everywhere non-metal; (2) shared roughness noise (step 5); (3) raise albedo saturation ~10-15% to counter IBL + ACES desaturation (same reasoning already documented for the sky at `EnvironmentCycle.ts:22-24`); (4) keep `envMapIntensity` in the 0.5-0.9 band the override table already encodes; (5) keep the warm-key/cool-rim rig — realism here should mean *graded stylized* (Fortnite-class), not neutral render-farm lighting.
- **Fresnel-water redundancy:** Stage 0's analytic fresnel and the real env map both put sky on the sea — stacking them over-brightens. In real theme, prefer the env map and gate the analytic mix out (both live in `Island.ts:857-893` uniforms — easy to flag).
- **Shadow surfaces read differently:** the ramp's stepped bands hid soft-shadow gradients; PCFSoft penumbras and any residual acne become visible. `normalBias 0.035` (`GameScene.ts:657`) is already the right recipe; budget one tuning pass.
- **Faceted normals:** if the GLBs export flat-shaded facets, GGX gives one hard glint per facet — can read CG-cheap. One Blender pass (shade-smooth + hard edges by angle, re-export) fixes it; check this *first* on `house.glb`/`tree.glb`.

## Stage 2 — Textured PBR (per-material albedo/normal/roughness)

**Procedural (extend TextureGenerator) vs Blender-baked:**

| | Procedural | Blender-baked |
|---|---|---|
| Fit | Tiling surfaces: roads, facades, terrain detail | Per-asset identity: house wood/plaster, car paint, tree bark |
| Cost | Code time; already half-built (`TextureGenerator.ts:7-102`, Sobel normals `105-146`) | Owner's hours (below) |
| Quality ceiling | "Noise-textured", fine at distance | Real AO, edge wear, curvature — what actually sells "hand-made premium" |
| Runtime | Canvas gen at boot (~ms), zero download | Download + decode; needs compression discipline |

**Recommended split:** procedural for terrain detail + streets (revive `createRoadTextures`, currently dead — `TextureGenerator.ts:7-54`), Blender-baked for the 9-asset prop kit. Terrain gets one tiling detail-normal + roughness noise injected via `onBeforeCompile` on the terrain material only (`Island.ts:760-769`; note the audit's wet-sand item already plans to clone this material — plan line 43 — coordinate so both edits share the clone).

**Blender hours (owner can bake):** bake-template setup 1-2h; per asset — unwrap (flat-color GLBs almost certainly lack useful UVs), AO + curvature-wear bake into albedo + roughness, 30-60 min × 9 assets ≈ 5-9h; import/QA/iteration 2-3h. **Total ~8-14h**, batchable one asset per evening.

**Texture memory budget (mobile):** 9 assets × 512² × 3 maps uncompressed RGBA ≈ **28MB GPU — too much raw**. Two acceptable shapes: (a) one 1024² **atlas** × 3 maps ≈ 12MB uncompressed, or (b) per-asset **KTX2/BasisU** (three r180 ships `KTX2Loader`) ≈ **4-6MB GPU, ~1MB network**. Hard ceiling for phones: ~32MB total texture memory including the PMREM. 256² per prop is genuinely enough at this camera distance — halve everything above.

**Draw calls:** texturing itself adds none (same material count). But per-asset unique textures *block* future material merging, while the atlas *enables* it — and the audit's GLB-instancing item (plan line 63, `Island.ts:3608, 3625-3650`) composes cleanly only with the atlas. **Choose the atlas.**

## Stage 3 — Optional ceiling (honest verdicts)

- **Baked AO → vertex colors: YES.** Terrain already runs `vertexColors` (`Island.ts:769`) and props are static; multiplying a Blender AO bake into vertex color is zero runtime cost and the single biggest "production value" signal after Stage 1. **Full lightmaps: NO** — the day/night cycle (`EnvironmentCycle.ts:455-549`) invalidates baked directional lighting, and UV2 + lightmap memory on a 128×128 sphere buys nothing fog + IBL don't.
- **SSR-lite water: NO on mobile, MARGINAL on desktop.** 1.5-3ms even quarter-res, worse on tile GPUs, and the adaptive-resolution controller would answer by blurring the whole frame (same failure mode the audit cites for god rays, plan line 76). PMREM reflection + wave normals (`Island.ts:814-830`) reach ~85% of the read.
- **Contact shadows / SSAO: NO.** The audit's rejection (plan line 75) survives the PBR shift on cost grounds; the instanced grounding discs (`GameScene.ts:587-616`) plus Stage-3 vertex-AO cover contacts. Desktop-only SSAO is the first thing to cut when the A/B shows it doesn't move the screenshot.

## Where "realistic" fights the hand-made geometry — honestly

The assets are 7-30KB flat-color GLBs; the terrain resolves nothing under 1.08 units (`CLAUDE.md` constraint). Realistic *lighting* flatters low-poly (Monument Valley, superliminal-style); realistic *texturing* fights it — a photoreal brick map on a 30KB house reads as asset-flip uncanny, silhouettes stay boxy no matter what the shader does, and normal maps must fake every detail the mesh can't hold. The winning target is **"graded stylized-PBR": real light transport, hand-picked color** — not photorealism. That is also why the stopping point below is early.

## RECOMMENDATION

**Stop at Stage 1 + selective Stage 2** for a portfolio site: full Stage 1, vertex-baked AO (Stage 3's cheap half), terrain detail normal, and baked textures for at most 2-3 hero assets (house, tree, car). Full per-asset texturing is 8-14 owner-hours that photographs barely better at this camera distance, and Stage 3's remaining items fail the perf-per-look test.

**First 5 concrete steps:**
1. Add the `?theme=real` flag read + gate `toonifyIslandMaterials()` at `GameScene.ts:385` (also gate the grass material pick at `Island.ts:287`). Ship it — the toon site is untouched at the default URL, and both looks are live for A/B at `island.digiscalability.com/?theme=real`.
2. PMREM from the sky-dome gradient during `warmUp` (`SimpleRenderer.ts:202-220`), `scene.environment` set, `environmentIntensity` driven by `getDayFactor()` in `EnvironmentCycle.update()`.
3. Shared 128² roughness-noise map wired into `Materials.createPBRMaterial` (`Materials.ts:45-60`) + albedo saturation pass; disable the analytic fresnel water mix under the flag.
4. Blender pass on the GLB kit: shade-smooth with hard-edge angles, re-export (fixes faceted glints); while in Blender, bake AO to vertex colors.
5. A/B screenshot matrix per the repo's visual-regression protocol (CLAUDE.md): day + dusk + night, desktop + phone tier, toon vs real — then decide the default theme from screenshots, not taste memory.

**Sequencing dependency:** land the audit's do-first renderer fixes (composer pixel-ratio, phone bloom-skip — plan lines 14-16) *before* Stage 1, since they fund its ~1-2ms phone cost.

---

Key file paths: `C:/claudeSessions/githubCLONES/portfolio-island/Materials.ts`, `C:/claudeSessions/githubCLONES/portfolio-island/GameScene.ts`, `C:/claudeSessions/githubCLONES/portfolio-island/Island.ts`, `C:/claudeSessions/githubCLONES/portfolio-island/TextureGenerator.ts`, `C:/claudeSessions/githubCLONES/portfolio-island/EnvironmentCycle.ts`, `C:/claudeSessions/githubCLONES/portfolio-island/SimpleRenderer.ts`, `C:/claudeSessions/githubCLONES/portfolio-island/docs/superpowers/plans/2026-07-30-graphics-mobile-audit.md`.
