# LOCAL-STATE — Portfolio Island handoff

## ⭐ LATEST (scarecrow + economy juice + animations) — on `main`, deployed, prod-verified
Branch merged to `main` last session; now working on `main` directly. Prod = `436ec9b`.
- **`436ec9b` MOBILE UX DEEP-DIVE — 21 verified fixes** (31-agent audit: 6 surface readers +
  adversarial verify per finding; plus hands-on 375×812/667×375 passes; ALL fixes prod-verified by
  DOM/behavior probes on island.digiscalability.com). Highlights: pointer-lock no longer requested on
  touch taps; camera swipe/pinch BANKING during rails (tour/interiors/postcard) drained — was one
  violent whip on exit; DIVE moved off the tier-1 chip row collision to column-2 212px (emote →194 in
  short landscape); centered modals clamp to 100dvh−32 + scroll; zone panels got explicit width (CSS
  shrink-to-fit had them at HALF width on phones); every dismiss control now a 44px thumb box; emote
  wheel got an outside-tap catcher (was undismissable on touch); volume pill self-manages (nav-chips
  layer snapshot was re-hiding it instantly); drawer idle timer re-arms on interaction; touch 💬 now
  runs the ensureNamed gate (phones chatted anonymous forever); NPC-chat input stays enabled during
  replies (disabling a focused field collapses the phone keyboard); 16px-on-touch on all remaining
  inputs; toast dwell scales 50ms/char (2–6s); radar text scales up at shrunk display sizes; compass
  DOM writes change-guarded; touchify covers "eat with G" + plain-text toasts + completion hints.
  ✅ FLAKE FIXED + ROOT-CAUSED (supersedes the earlier "worker-scheduling/warm-cache" theory, which
  was WRONG): the intermittent golden-test failures were **vitest's default 5s test timeout**, never a
  hash drift. terrainNoise/grassMarshal build a FULL island in the TEST BODY (~1.7–2.5s warm) and
  islandRadius's lazy islandAt() charged a build to whichever test touched a radius first — machine
  load (dev server + workers all building islands) pushed them past 5s, and the timeout FAIL read
  like a bit-stability break. PROVEN by controlled experiment: `--testTimeout=1500` reproduced the
  exact failing set (grassMarshal×2, terrainNoise, islandRadius×2, all "Test timed out"; tierParity
  immune via its explicit 300s). FIX: explicit 120s timeouts on the island-building test bodies,
  pre-build islandRadius's radii in a 300s beforeAll, 120s hook on staticFreeze. Post-fix the same
  1500ms experiment runs 441/441 (explicit timeouts override the default). NOT pool isolation — the
  data was always deterministic; only the deadline was wrong.
⚠️ NOTE: `.claude/LOCAL-STATE.md` is NOW GIT-TRACKED (un-ignored 2026-08-19, commit 2cdb53e) — it
shows in `git status` and must be committed deliberately; `git add`-ing it is correct, not forbidden.
⚠️ RESUME GOTCHA: the session-resume re-checked-out the tree with CRLF (74 .ts + json/css) — breaks
prettier + char-slice source-locks (onboarding.test.ts). Fixed by normalizing to LF (`prettier
--write "**/*.ts"` + `sed -i 's/\r$//'` on json/css). core.autocrlf=true, no .gitattributes, so a
future resume may re-CRLF — just re-normalize. git content-diff is unaffected (autocrlf normalizes).
- **`507a10e` scarecrow + fountain + pennant**: scarecrow was a bare T+ball; dressed it (straw hat,
  burlap sack body, straw-tuft hands, stitched face) inside a LOCAL mulberry32 SHIELD (uuid mints
  never hit the shared stream → golden census UNCHANGED, existing post/bar/head stay on it). Burlap
  FLUTTERS via non-instanced onBeforeCompile height-keyed sway (reuses grassTimeUniform, works while
  flowers is matrix-frozen — shader never touches the pinned transform). Fountain water discs +
  summit pennant also animated via the same shared-clock shader idiom on their EXISTING materials
  (no new material → census-safe, zero CPU).
- **`1899cbc` economy juice + coin-pop leak fix**: floating "+N 🪙"(gold)/"-N 🪙"(coral spend) rises
  at every transaction — sells (via sellHandoff), quest/race/finale/lesson rewards, vault
  deposit/withdraw. New public GameScene.floatCoins(pos,n,spend?) + floatCoinsAtPlayer(n,spend?),
  reduced-motion gated. Pooled (canvas+texture reused). FIXED the spawnCoinPop GPU LEAK (was minting
  geo+material per pop, only remove()d) → shared static geo + reused mesh pool.
- PROD-VERIFIED (`?v=15`): floatTexts 0→2 on trigger (earn+spend fire, reduced-motion off in test
  Chrome), glError=0 + 164 programs (all shader injections linked clean), boot clean.
- 441/441 tests green both commits; census + static-freeze unchanged.
- **`6b3562d` flower sway + economy polish** (prod-verified `?v=16`: glError=0, programs 164→167,
  economy JS no-throw): (1) the decorative FLOWERS (rings round every plaza) now sway — grass-style
  instanced shader injected into their EXISTING stem/center/petal materials (stem height-keyed base-
  planted, head bobs), census UNCHANGED, works while flowers-frozen. (2) HUD coin counter is now
  amount-aware: counts up/down to the value, pop scaled to the change, GREEN flash on gain / CORAL on
  spend, reduced-motion gated. (3) new Sfx.spend() descending "clink out" (vs coin()'s rise), wired
  to vault deposit. (4) vault "Deposit all"/"Withdraw all" buttons — deposit/withdraw now amount-
  parametrized (same charge-first-refund / credit-on-ack discipline), capped at the 500 per-op limit.
- **`1703342` coin receipt panel + hanging shop signs** (prod-verified `?v=17`: glError=0, programs
  164→167, receipt log round-trips, hangSigns placed): (1) RECEIPT — GameScene ring-buffer txLog
  (last 24) + `logTransaction(label,amount)` wired at every money event (6 sells, quest/race/finale/
  lesson rewards, vault ±); the coin HUD chip is now a button (`onCoinChipClick` → `ui.showReceipt`)
  that opens a centered-modal history (source · signed amount green/coral · relative time). (2) HANGING
  SIGNS — the empty `signs` group now has plumb signposts (post + side arm + board on link rods,
  canvas-texture labels 🛖/☕/🍞/🎨/✉) at the plaza approaches; each board swings on a gentle GameScene
  pendulum tick (reduced-motion gated; signs live on `root` so no freeze opt-out). Geometry SHIELDED
  in local mulberry32 → census UNCHANGED. Placed 4/5 (one plaza fell on isNearStreet, correctly
  skipped — best-effort, shortfall by design). ⚠️ Sign PLACEMENT is anchor-offset best-effort, not
  visually verified headless — easy to nudge if any reads off.
- **`194928e` sunflower + parasol sway + spend sound/receipt on ALL buys** (prod-verified `?v=18`:
  glError=0 both injections, sunflower IM found, spend logs negative): (1) SUNFLOWER — the 7 farm
  sunflowers now nod on the shared grass clock (shielded material, height-keyed to the 1.2u stalk),
  matching the wheat beside them; census UNCHANGED. (2) PARASOL — the 2 market parasols' cone rims
  breathe in the wind; `parasolSway()` only ASSIGNS onBeforeCompile in the material's exact alloc slot
  → golden census byte-identical (the fiddly bit — an unshielded createIsland change). (3) SPEND SOUND
  — all 11 spendCoins-gated buys (axe/sickle/pickaxe/rod, bird/cat/fish feed, shop meals, soup,
  checkup, hats) now play the descending sfx.spend() (was the rising coin chime) AND log a negative
  receipt entry; world buys (soup/checkup) also float the coral "-N". The build system (4461) keeps its
  own blip — it's construction, not a vendor buy — left alone by design.
- **SWAY VERIFIED by deterministic pixel-diff** (dev build = same committed code, in-app Browser pane
  live-rendering; a backgrounded tab freezes the loop, and the chase cam BOBS so a naked screenshot
  can't isolate a few-cm sway). Method: hold the camera, sweep ONLY `island.grassTimeUniform.value`
  across back-to-back SYNCHRONOUS `renderer.render()` calls (the RAF loop can't sneak a frame in
  between), then `gl.readPixels` a projected ROI. SUNFLOWER: same-view A/B a half sway-period apart
  (+2.513s) → 4.6% of a 70px head box changed, maxDiff 324 at the head's leading edge (sky-vs-gold),
  rest static = a gentle nod. PARASOL: rim-ring vertices projected to place a 149×38 band ON the rim,
  8-phase envelope over one full rim cycle → 11.96% moved, maxRange 408; **CONTROL (clock FROZEN, 8
  identical renders) = 0.00% moved** → zero framebuffer/TAA/dither noise, so 100% of the change is the
  sway. glError=0 throughout; grass clock confirmed advancing in real time. Sunflower heads sit in a
  clean even row; both parasols render as tidy purple cones (no deformation). The parasol reads a
  HIGHER pct than the sunflower despite a smaller (3cm) amplitude — tight rim-band ROI + envelope +
  spatial-phase term (`position.x*3+position.z*3`) ripples the rim so more of the band changes/cycle.
  (Handles for re-checking: `__app.scene.getPlayer().setWorldPosition(dir*surfaceR)` +
  `getOrbitCamera().{distance,distanceTarget,height,yaw}` + `snapToPlayer()`; find the sway meshes by
  `material.onBeforeCompile.toString().includes('sfSway'|'umRim')`; farm is `island.farmDir`, parasols
  at world z≈-85 Contact plaza; grass/sway clock is `island.grassTimeUniform`, NOT on the scene.)
- **`882c0ac` sunflower/scarecrow orientation + alpine mountains + reshaped sea vehicles**
  (dev-verified on the same committed code; 441/441 green, census + freeze UNCHANGED): (1) SUNFLOWER
  ORIENTATION — the petal ring was HORIZONTAL (flat daisy facing straight up); rebuilt the head to
  face OUT (disc+petal ring in a +Z-normal plane, tilted ~20° up onto the stem), colours BAKED
  per-part (old position heuristic assumed the flat daisy). (2) SCARECROW HANDS — tufts sat at y=1.12
  BELOW the crossbar (top y≈1.3) so they dangled detached; now a splayed straw spray from each sleeve
  END at the bar line, laid past horizontal (rotateZ ±1.78) to droop out+down. (3) MOUNTAINS —
  colour-only (positions/colliders/props untouched): grey-brown `cliff` (0x776d5f) rock band just
  below the self-tuned snowLine + snow now holds on moderate summit pitches (settles gate raised to
  slope 0.55–0.95) so the steep crag earns a white cap. Sampled summit snow 0→29% above 14u; foothills
  stay green (only top ~3.6u caps). TUNING TRAP: first pass over-darkened (cliff expose 0.4–0.9 →
  near-black raw colours + 0 snow); softened to 0.25–0.6 and boosted snow. (4) SEA VEHICLES (GameScene,
  post-seed → zero census risk): buildBoat = runabout (waterline stripe, bow, gunwale rim, raked
  windshield, stern bench + outboard; cockpit clear for the rider); buildJetski sleeker (dark belly,
  lifted nose, deck stripe, saddle + bars); buildRowboat + two thwarts + a pair of oars; cruise +
  mast/pennant + deck railings. All via GameScene.birdMat cache.
  VERIFY HANDLES USED: teleport via setWorldPosition + orbit-cam {distance,height,pitch}+snapToPlayer;
  find sway/vehicle meshes by onBeforeCompile.toString().includes('sfSway'|'scSway'|'umRim') or
  material.color.getHexString(); vehicles are named `vehicle_N`; summit at island.dirAt(5.35,0.79)
  (top ~18u above sea); sample terrain colours off the largest color-bearing mesh under island.mesh.
BOX MARKET-STALL AWNINGS stay rigid ON PURPOSE: the canopy() cloth panels share the GLOBAL
`paper`/`accent` materials with book covers + lean-to roofs, so a material-level sway would ripple
those too; per-panel materials would shift the census for near-zero gain. Loose meadow coins still
SKIP the floating-number (would spam — chime is their feedback). Economy/animation arc is COMPLETE.


**Updated:** 2026-08-18 (town ask + perf rounds 1-2 + sky parallax + multi-lens defect hunt)
**Branch:** `claude/overnight-20260719-0649` · **Prod:** `797ea2e` at island.digiscalability.com
**Tests:** 424/424 green · **Working tree:** clean, pushed

⚠️ **DRAW COUNTS ARE ONLY COMPARABLE AT AN IDENTICAL CAMERA POSE** — the frustum decides
most of the number. The session's fixed probe pose is `[87.6, 45.4, 31.6]`, reached by
seating the player at `island.dirAt(0.30, 0.4636)` then `orbitCamera.snapToPlayer()`. At
that pose: **1390 at session start → 1200 now.** (I once read 1337 vs 1376 across two
different poses and briefly believed I had shipped a regression.) Likewise `programs` now
INCLUDES the pre-warmed interior by design — a higher number there is the fix working, not
a regression.

---

Earlier sessions (to 2026-08-19): `docs/history/2026-08-19-local-state.md`.

