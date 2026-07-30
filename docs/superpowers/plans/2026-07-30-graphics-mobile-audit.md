# Portfolio Island — Graphics + Mobile Improvement Plan
*(synthesized from 6 subsystem audits; every claim cites its source audit and file anchor)*

---

## 1. The honest read

The foundation is genuinely strong — tiered DPR with a 2.5MP pixel budget, adaptive resolution, player-following shadows, instanced grass, pooled FX, a full day/night/weather cycle, fog, and shoreline surf all already exist (every audit had a "do not re-propose" list). But three real defects undercut it: the adaptive-resolution controller is silently a no-op in the default bloom-on path because the composer never receives the new pixel ratio (render-pipeline #1); the shipped image has **zero antialiasing** because bloom routes every frame around the MSAA canvas (render-pipeline #2 / mobile-perf #2); and touch camera input is broken three ways — you cannot look while moving, deltas drift, and a downward drag can trigger pull-to-refresh and reload the game (mobile-gameplay #1-2). The biggest untapped graphics upside is night (static window/lamp emissives, no sun disc, flat unreflective water), and phone play is roughly one afternoon of small fixes away from "genuinely good" rather than "technically functional."

---

## 2. Do-first batch (highest payoff-per-effort, ordered)

1. **Fix the composer pixel-ratio staleness** — `composer.setSize` uses a cached `_pixelRatio`, so adaptive resolution never reaches the scene render or bloom chain; replace with `composer.setPixelRatio(dprCap * renderScale)` in both call sites. This restores the perf headroom every other item spends. **S** — `SimpleRenderer.ts:244-248, 346-350` (render-pipeline #1). Do this before the quality governor (mobile track) which builds on the same controller.

2. **Tier-gate bloom: skip it entirely on phones, add MSAA to the desktop composer** *(merges render-pipeline #2 + mobile-perf #2)* — on coarse/low-core, never call `initPostProcessing` (saves ~13 tile passes, 40-70MB of render targets, the 40KB chunk, AND restores native MSAA — faster and sharper); on desktop, construct the composer with an explicit `samples: 4` HalfFloat target so the default path finally gets AA. **S** — `main-simple.ts:374`, `SimpleRenderer.ts:125-143` (mobile-perf #2, render-pipeline #2).

3. **Rewrite touch camera input with identifier tracking** — dedicated camera-touch id, accumulate-and-zero deltas (mirroring the mouse path), drop the ×0.01 sensitivity kill; fixes look-while-moving, drift, and snap in one ~40-line change. The single biggest feel fix on phones. **M** — `SimpleInputManager.ts:103-117, 207-212` (mobile-gameplay #1).

4. **`touch-action: none` on the canvas + `overscroll-behavior: none`** — stops pull-to-refresh reloading the game mid-drag. A reload in minute one is fatal. **S** — `style.css:39-47`, `index.html` (mobile-gameplay #2).

5. **Keep hold-to-swim alive: re-dispatch synthetic keydown every ~700ms while a touch button is held** — the phantom-key purge (STALE_KEY_MS = 2000) silently drops the synthetic Space, so swimming cuts out after 2s and players sink. **S** — `SimpleUI.ts:1017-1035`, `SimpleInputManager.ts:136-146` (mobile-gameplay #3).

6. **Make the interaction prompt tappable** — it says "Tap 👆 USE", has `pointerEvents: auto`, but no click handler; copy the 4-line synthetic-KeyE pattern the dialogue panel already uses. **S** — `SimpleUI.ts:1509-1539` vs `2855-2859` (mobile-gameplay #5).

7. **Windows + lamp bulbs light up at night** — emissives are frozen at 0.6/0.8 day and night; tag the meshes and lerp emissiveIntensity 0.15→1.3 with (1-dayFactor). The classic cozy-village night shot for ~0ms. (Bloom halos above 1.2 are a desktop-only bonus once item 2 lands.) **S** — `Island.ts:1082-1086, 1390`, `EnvironmentCycle.ts` update (atmosphere #1).

8. **Yaw turn smoothing + turn lean on the player** — heading currently snaps instantly (180° teleport-flips); shortest-arc lerp at ~12 rad/s plus a small roll into turns, gated to on-foot. Highest-frequency quality signal in the game. **S** — `GameScene.ts:4017-4024`, `SimplePlayer.ts:1387-1389, 1436-1458` (characters #1).

---

## 3. Graphics track (remaining, priority order)

- **Fresnel sky reflection + view-dependent opacity on the sea** — the one missing water feature; mix toward `uSkyHorizon` by a fresnel term, sharing EnvironmentCycle's Color instances by reference. S-M — `Island.ts:857-893`, `EnvironmentCycle.ts:476-486` (world-visuals #1).
- **Sun disc + golden-hour glow** — mirror the moon-disc code; additive billboard at the sun arc, dusk-tinted. The cheap "god rays." S — `EnvironmentCycle.ts:161-173, 511-526` (atmosphere #2).
- **Bloom + exposure follow the day/night cycle** *(merges render-pipeline #3 + atmosphere #8)* — one `setMood(day)` driving bloom strength/threshold (desktop only, given item 2) and `toneMappingExposure` (everywhere) from `getDayFactor()`. S — `SimpleRenderer.ts:131-136`, `EnvironmentCycle.ts:91-92` (render-pipeline #3, atmosphere #8).
- **Fake lamp light pools + PointLight consolidation** — instanced additive discs under the 14 lamps (grounding-shadow pattern); delete or tag the 4 untagged TownPlanner range-20 lights that burn 24/7. Prettier night, NEGATIVE ms. M — `TownPlanner.ts:170`, `GameScene.ts:557-616` (atmosphere #3).
- **Night ambient retint** — lerp ambient 0.22→0.10 and toward 0x2c3a5e at night so lamps/fireflies pop. S — `GameScene.ts:625-627` (atmosphere #4).
- **Break the surf rings + crest sparkle** — hash noise in the foam threshold, roughness dip on crests. S — `Island.ts:884-887` (world-visuals #2).
- **Neutral toon gradientMap** — the shared ramp is green-tinted, shifting every prop's shadow bands green; one function. S — `Materials.ts:66-79` (world-visuals bonus).
- **Character juice set** (characters #2, #4, #5): procedural air/jump pose (S — `SimplePlayer.ts:738-769` pattern); real arm-wave behind the existing Q event (S — `Multiplayer.ts:494-503`); walk-clip timeScale synced to ground speed + clip-phase footsteps (S — `main-simple.ts:763-770`).
- **Pose byte + body-color sync over the wire** *(one protocol change; characters #3 + #7)* — swimmers/riders/jumpers currently look upright-and-walking to peers, and customization is invisible to others. M — `Multiplayer.ts:24-40, 272-284` (characters #3, #7).
- **Wet-sand tide band on terrain** — analytic `vAbove` fade sharing `seaTideUniform`; must clone the terrain material (shared toon cache risk). M — `GameScene.ts:2846`, `Island.ts:2319-2322` (world-visuals #3).
- **Lateral biome/moisture noise** in the one-time terrain color pass + matching grass tint. S — `Island.ts:706-755, 384-387` (world-visuals #4).
- **Grass player-push + traveling gusts** — ~6 ALU per vertex, trivial. S — `Island.ts:292-312` (world-visuals #5).
- **Star field upgrade** (round sprites, twinkle, Milky Way band). S — `EnvironmentCycle.ts:142-150` (atmosphere #5).
- **Moon-aligned night shadows** — blend the directional light toward the moon's computed direction when dayFactor < 0.5. S — `EnvironmentCycle.ts:457-460, 511-519` (atmosphere #7).
- **NPC waddle** so villagers stop gliding (npc.glb has no bones — the NPC.ts mixer path is dead code). S — `GameScene.ts:3232-3275` (characters #6). Hero-NPC skinned clones are optional; verify draw cost on mobile first.
- **Tone-mapping A/B: Neutral vs ACESFilmic** — taste call, one line, land before final mood tuning. S — `SimpleRenderer.ts:67` (render-pipeline #5).
- **Vignette + saturation + IGN dither ShaderPass** — desktop only (see Don't bother). S-M — after OutputPass, `SimpleRenderer.ts:142-143` (render-pipeline #4).
- Tail: water-exit drips + car exhaust puffs (characters #8), head-look (characters #9), crescent moon mask (atmosphere #9).

---

## 4. Mobile track (remaining, priority order)

- **Frame limiter: cap coarse tier at 60fps + derive controller thresholds from observed refresh** — 90/120Hz phones currently render at full refresh for zero benefit, and a struggling 120Hz phone at 70fps reads as "healthy" to the 45/57 thresholds. S — `SimpleRenderer.ts:188-217, 236-239` (mobile-perf #3).
- **Quality governor: extend the fpsEma controller into a rung ladder** *(the one canonical "adaptive quality" item — subsumes all per-audit adaptive proposals)* — R0 renderScale (exists, fixed by do-first #1) → R1 bloom off via existing toggle → R2 shadow half-rate → R3 grass `count` prefix (golden-spiral scatter makes any prefix uniform). Centralize the thrice-duplicated coarse/lowCore check into a DeviceTier util. M — `SimpleRenderer.ts:225-250, 285`, `Island.ts:328-345` (mobile-perf #1).
- **Joystick robustness** — `targetTouches` instead of `touches[0]`, add `touchcancel` reset (notifications currently leave the player walking forever), ~12% dead zone, invisible ~170px hit region. S each — `SimpleUI.ts:953-977` (mobile-gameplay #4).
- **Pinch-to-zoom** — drive the already-existing, collision-aware `setDistance` (2-12) from two-finger distance in the identifier tracker built for do-first #3. M — `OrbitCamera.ts:260-262` (mobile-gameplay #6).
- **Shadow trims on coarse tier** — `PCFShadowMap` instead of PCFSoft, `grass.receiveShadow = false` (12k DoubleSide blades sampling the shadow map for invisible shadows). S — `SimpleRenderer.ts:70`, `Island.ts:396` (mobile-perf #5). Half-rate updates land as governor R2, not separately.
- **Cloud consolidation + weather awareness** *(merges mobile-perf #4 clouds + atmosphere #6 — one touch of the cloud code)* — merge each cloud's 3-5 blobs (or one InstancedMesh), `castShadow = false` on blobs (both audits flag it), and lerp the shared cloudMat color/coverage with weather. M — `GameScene.ts:1746-1801` (mobile-perf #4, atmosphere #6).
- **GLB prop instancing** — 26 cloned tree.glb + cloned benches/lamps/mailboxes → InstancedMesh per source; also delete the dead de-instancing regex that matches names that no longer exist, leaving two tree populations coexisting. M — `Island.ts:3608, 3625-3650, 3079` (mobile-perf #4).
- **44px hit targets for the chip row** (emote/mute/customize/chat/mic are ~30px; the 44px CSS rule only covers dead legacy classes). S — `SimpleUI.ts:444-455, 1050-1085`, `style.css:236-241` (mobile-gameplay #7).
- **Haptics helper** (navigator.vibrate, reduced-motion gated) on button-down, landings, race checkpoints, coins. S — (mobile-gameplay #8).
- **Landscape HUD layout** — minimap covers ~46% of a 375px-tall screen and collides with mic/chat; shrink or hide in short-landscape. M — `SimpleUI.ts:1793-1808` (mobile-gameplay #9).
- **Per-frame allocation cleanup** — `getWorldPositionInto(out)`, hoist the audio-listener vector, pool fisherman/compass clones; kills mobile GC hitches. Do with vitest green. S-M — `SimplePlayer.ts:1395`, `main-simple.ts:908, 940-956` (mobile-perf #6).
- **Sea sphere 64 segments on coarse tier** — pure tessellation; wave math and the CPU `waveHeightAt` mirror untouched. S — `Island.ts:897` (mobile-perf #7).
- **Copy/stacking polish** — "press any key" → "tap anywhere", bottom-center slot collisions, appearance panel covering the joystick, chat draft loss on blur. S each — `SimpleUI.ts:1273, 2394-2406, 558` (mobile-gameplay #10).

---

## 5. Don't bother

- **SSAO / AO pass** — 1.5-3ms+ plus a prepass on mobile to darken contacts the baked grounding-shadow quads (one draw call, `GameScene.ts:587-615`) already provide; toon-ramped flat surfaces gain almost nothing (render-pipeline, explicit rejection).
- **Screen-space god rays** — 2-4ms on mid mobile GPUs, and the adaptive controller would respond by blurring the whole frame; the sun-disc impostor (graphics track) gets ~80% of the read for free (atmosphere, explicit rejection).
- **Any fog proposal** — FogExp2 already exists, weather- and time-of-day-driven (`GameScene.ts:329`, `EnvironmentCycle.ts:488-494`) (render-pipeline).
- **PMREM / environment-map water reflections** — cost and dead weight: `scene.environment` is never set, toonified props can't consume it, and every `envMapIntensity` in the codebase is currently a no-op; the fresnel-to-sky mix delivers the effect analytically (world-visuals). Delete the dead overrides at `Island.ts:2831-2855` or leave as documentation.
- **MSAA on the composer target for mobile** (render-pipeline #2's `samples: 2` coarse branch) — superseded by mobile-perf #2's facts: on tile GPUs, skipping the composer entirely is both faster and sharper (native canvas MSAA), so there is no reason to pay MSAA×HalfFloat bandwidth there. Keep the MSAA target desktop-only.
- **Vignette/dither ShaderPass on the coarse tier** — mobile-perf establishes pass count as the tile-GPU cost driver, and on phones there is no composer after the bloom gate anyway; render-pipeline itself says gate it off coarse. Desktop only.
- **Device-pixel bloom sizing** (render-pipeline #6) — ~4× blur-chain growth on dpr-2 desktops for a defect (night halo shimmer) that may not even be visible; hold unless the day/night bloom item makes it objectionable, and never on mobile.
- **Shadow-system rework** — PCFSoft + player-following ±17u box + normalBias 0.035 is already the right recipe for a curved planet (render-pipeline); the only shadow changes worth making are the coarse-tier trims above.
- **Anything violating repo constraints** — no audit proposed an engine swap or scene-graph rebuild (mobile-perf's draw-call work is explicitly "refinement, not restructuring"), and the two items touching sea/terrain hot paths (sea segments, wet-sand band) are analytic and leave `waveHeightAt` mirroring intact — verified compliant.
- **Dead-code cleanups to fold in while passing** — `Island.update()` legacy lamp-blink with no call site (atmosphere), the stale `antialias: true` and shadow-limiting comments in `SimpleRenderer.ts:56, 71` (render-pipeline), the dead tree de-instancing regex at `Island.ts:3608` (mobile-perf), and the dead NPC mixer machinery in `NPC.ts:34-47` (characters). None warrant standalone work.

---

**Suggested sequencing for a solo operator:** Do-first items 1-2 (renderer, one sitting, measurable) → 3-6 (mobile input, one sitting, test on a real phone) → 7-8 (visible wins). Then alternate one graphics-track and one mobile-track item per session; land the wire-protocol change (pose byte + colors) as its own isolated commit.
