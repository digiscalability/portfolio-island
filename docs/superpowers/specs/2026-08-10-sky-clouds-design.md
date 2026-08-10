> **Status: APPROVED 2026-08-10 — all 3 decisions RULED by Abbas (all per recommendation):**
> 1. Posterization: build BOTH behind `?sky=band`, judge dusk screenshots before default.
> 2. Cloud ramp: shared 12-step toonRamp first; bespoke 3-step is a later 5-line swap.
> 3. Cloud outlines: none now; revisit inside the stronger-outline art pass (#11).
> 2-lens + adversarial-audit design workflow, 2026-08-10. No code before approval.

# Sky & Cloud Formations — Design Plan (2026-08-10)

## 1. Intent

The sky should read as **painted, not simulated** — a Wind Waker / A Short Hike hybrid: a softly banded gradient dome that keys warm toward wherever the sun actually is, flat-bottomed toon cumulus that drift as coherent formations instead of today's 41-puff noise, and a crisp sun disc / legible moon crescent that anchor every screenshot. Every element must survive the no-bloom mobile tier, stay off the governor's rung ladder, and get *cheaper* than today's sky where possible.

## 2. Current state (compressed)

- **Dome**: `SphereGeometry(800,32,16)`, custom 3-stop shader, `createSkyDome()` `GameScene.ts:7252-7309`; `uUp` written per frame `:8441-8443`, save/restored for the interior-window pass `:10825-10832`. Sea binds `horizonColor` **by reference** `:839`; fog copies it `EnvironmentCycle.ts:754`.
- **Clouds**: 41 pivots (`round(18*areaScale())` `:5601`), one merged mesh each, `MeshStandardMaterial`, ~13k verts, **41 transparent draws**; altitude `planetR+6.5..7.7` `:5645`; drift `:7496-7499`; weather tint via eased `cloudWet` `:8580-8591` (**~2s time constant**, not 20s).
- **Sun/moon/stars**: additive sun disc + phase-brightness moon at radius 640 `EnvironmentCycle.ts:237-266,714-793`; 5 star layers at 700 `:170-234`. Disc rides **true** elevation; shadow light rides clamped+moon-blended elevation `:677-694` — never conflate.
- **Constraint that BLOCKS naive work**: terrain relief scales (`reliefScale = radius/50`, `Island.ts:227`); max displacement **R+13.8 at R=75** (`Island.ts:4597`), summit ~R+12 at lat 0.73–0.79 (`Island.ts:843-846`). The unscaled cloud band at R+6.5 **already passes through the mountain**.

## 3. Tier 1 — Cloud formations

**One reconciled architecture: two formation sets, crossfaded** (resolves the dual-brief conflict).

- **Fair set**: 9 cumulus clusters (1 hero of 5-7 blobs at 2-3× scale + 2-4 satellites, merged into ONE geometry per cluster via the `mergeGeometries` pattern at `:5642`) + 4 loner puffs + **1 cirrus mesh** (5 thin streaks, merged). Bottoms clamped to a flat base plane at build time; underside darkening + per-puff value variation baked as **vertex colors**.
- **Storm set**: 6 flat wide slabs + **1 cumulonimbus tower** (base R+9.75×-relative, top ~+7u above base, flat anvil), authored dark, `visible=false` when dry.
- **Altitude policy (BLOCK #1 resolved)**: band relief-scales — `(6.5..7.7) * reliefScale` = **R+9.75..11.55** at R=75. This clears all foothills but not the R+12 summit, so **orbit planes are constrained at build time to exclude the summit latitude band (0.73–0.79)**; the tower's plane is pinned away from it. The vitest asserts *this* policy (band > relief-scaled foothill height + summit-latitude exclusion), not the impossible "above all relief." No rain-time sinking — the storm set is simply authored at the band floor.
- **Material**: shared `MeshToonMaterial` with `gradientMap: Materials.toonRamp()` (the 12-step ramp every other toon surface uses — a bespoke 3-step ramp is Open Decision 2) + `vertexColors: true`; `material.color` multiplies, so the tuned `cloudWet` tint pipeline `:8587-8591` survives. **Cirrus fix**: cirrus joins the toon material (lit) — never MeshBasic, which glows 70% white at midnight through fog density ~0.006.
- **Crossfade**: fair opacity `0.92→0`, storm `0→0.95` on the eased wet value; `visible = opacity > 0.02` gating (star-layer pattern, `EnvironmentCycle.ts:774`). The tower gets its **own slower ease** (~0.08/s, full growth ~40s) — the 2s `cloudWet` constant would pop it in.
- **Ledger**: verts ~13k → **~20k worst case** (18-24k range, immaterial vs 190k terrain); draws **41 → ~14** steady (9+4+1 fair, or 7 storm), transient overlap peak ~21 — always under today's 41. No `frustumCulled=false`, no `ignoreOcclusion`, no castShadow. **LOC ~180-220** (`CloudFormations.ts` leaf module + builder rewrite + crossfade).

## 4. Tier 2 — Sky dome gradient + dawn/dusk keying

- Add zenith stop + optional soft-edged posterization (quantize `t`, `floor(t*N)/N` + smoothstep) inside the existing fragment `:7281-7297`; extend all four `PALETTE` keys and write in the existing loop `:738-750`.
- **Sun lobe**: new `uSunDir` vec3 built from the **true-elevation disc math** `:718-725` (never `sun.position` — that's the clamped, moon-blended light and would paint dusk warmth around the moon), multiplied by the sun disc's own visibility ramp so it dies below the horizon.
- **rain/snow palette keys are a small code change, not pure data**: EnvironmentCycle gets its own eased wet value (mirror the `dt*0.5` pattern) + a key-selection branch; this same value feeds `wDim`/fog/star gating so sky, rain, and clouds stop desynchronizing (audit #5/#11). GameScene consumes it for the crossfade — **one shared ease, two files**.
- **Hard acceptance criterion**: the band containing h=0 resolves to *exactly* `horizonColor` — sea binding `:839` and fog copy `:754` consume the uniform, and any drift reopens the dome/terrain seam. New uniforms get the interior-window save/restore treatment `:10825-10832`.
- Cost: ~8-10 ALU on sky pixels, 2 uniform writes/frame, **0 verts/draws. LOC ~60-90.**

## 5. Tier 3 — Sun/moon discs + stars polish

- **Sun = two elements sharing position writes** (a flat additive disc is physically impossible — sky adds through it): keep the existing additive falloff texture as the halo (it *is* the no-bloom tier's halo, `:543-560`), add a small normal-blended toon core disc, **luminance ≤0.8** so it never crosses bloom threshold 0.85 — worst case is golden hour under `?look=soft`.
- **Moon**: canvas-texture terminator redrawn once per session (two-arc crescent + 2-3 flat maria). The "offset dark overlay circle" variant is **deleted** — coplanar sort instability + dark bites over the starfield. Note in code: at new moon, shadows come from an invisible moon (pre-existing; a legible crescent makes it more noticeable — accepted).
- Stars: unchanged. Constellations + shooting star: cut (§8).
- Cost: 0 added draws (core disc replaces nothing but is 1 tiny transparent draw at renderOrder -1), canvas authoring only. **LOC ~70-90.**

## 6. Weather transition choreography

One eased wet scalar lives in EnvironmentCycle; everything reads it: sky palette branch, fog density, `wDim`, star visibility, fair/storm opacities, and the tower's slower secondary ease chained off it. Sequence on a rain flip: sky slates over ~2s → storm set fades in ~2s → tower grows ~40s → `rebuildPrecipitation` fires when wet > 0.6, so rain visibly has a source. Dusk-peach already auto-suppresses in storms (`×(1-cloudWet)` `:8589`).

## 7. Perf ledger + governor stance

| | Verts | Draws | Per-frame |
|---|---|---|---|
| Today | ~13k | 41 | 41 rotates, 3 color lerps |
| Tier 1 | ~20k peak | ~14 (peak 21) | ~15 rotates, 2 ease updates |
| Tier 2 | +0 | +0 | 2 uniform writes |
| Tier 3 | +~50 | +1 | existing position writes |

Net: **−26 draws steady-state**, +~7k verts (0.004% of scene), zero allocation (static scratch Colors `:565-567`). Sky stays **off the governor rungs** — hidden weather set already costs zero, nothing left to take. Formation meshes keep default frustum culling (their bounding spheres are valid; the culling-defeating stratus ring is cut).

## 8. Explicitly NOT doing

- **Volumetric/raymarched clouds** — wrong art language, mobile-hostile.
- **God-ray passes** — new full-screen pass; low tier has no composer at all (`SimpleRenderer.ts:193`).
- **Cloud shadows** — clouds deliberately skip the shadow pass; adding them doubles shadow cost.
- **Stratus horizon ring** — player-centered bounding sphere defeats culling and fails our own vitest by construction; most speculative element (audit #9).
- **Constellations + shooting star** — zero perf payback, pure QA surface, post-perf-crisis discipline (audit #10). Backlog, not scope.
- **Cloud position sync** — weather is client-local; nothing to sync.

## 9. OPEN DECISIONS FOR ABBAS

1. **Sky posterization**: visible soft bands (N=4-5) vs smooth gradient + sun lobe only. **Recommend: build both behind `?sky=band`, judge dusk screenshots.** Tradeoff: bands are the strongest toon amplifier but the biggest look change and can shimmer through bloom.
2. **Cloud ramp**: shared 12-step `Materials.toonRamp()` (world-consistent, subtle) vs bespoke 3-step cloud ramp (bolder Wind Waker chunking, but clouds band harder than everything else). **Recommend: shared ramp first**; a bespoke ramp is a 5-line swap later.
3. **Cloud outlines**: none vs inverted hulls on hero clouds only (+~2k verts, +9 draws; full-sky hulls double cloud verts and CelLook hulls fog out at distance anyway). **Recommend: none now**, revisit with the queued outline art pass.

## 10. Build order + verification

**Slice A — Tier 1 (formations).** Extract `CloudFormations.ts` (imports three + WorldScale only). Vitest pins: count scales with `areaScale()` across `RADII=[50,75]`; altitude band > relief-scaled foothill height + summit-latitude exclusion (the chosen policy); vert ceiling ≤ 24k; bounding spheres exclude origin; vertex colors in range; no NaN. `radiusUnits.test.ts` polices new radian literals automatically. Measure: draw calls ~14 via `renderer.info`.

**Slice B — Tier 2 (sky).** EnvironmentCycle tests under headlessDom: fog.color === effective horizonColor at hours 6/12/18/23 (`debugHour`); h=0 band === `horizonColor` exactly; eased wet monotonic on flip; weather-fog radius invariance. Playwright matrix: `?hour=` {6,12,18,23} × weather {clear,cloudy,rain} × {default, `?look=soft`, low-tier}.

**Slice C — Tier 3 (discs).** Tests: sun-disc opacity 0 at night; core luminance ≤0.8 asserted on the authored texture; crescent texture non-empty. Screenshot: golden hour with bloom on AND emulated off — the two must both read.

Ship A → measure governor → B → measure → C. Each slice independently deployable and revertible.