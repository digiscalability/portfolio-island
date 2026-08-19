# LOCAL-STATE — Portfolio Island handoff

## ⭐ LATEST (scarecrow + economy juice + animations) — on `main`, deployed, prod-verified
Branch merged to `main` last session; now working on `main` directly. Prod = `194928e`.
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

## 🚪 SMOOTHNESS ROUND 2 (`4809a61`, prod-verified)
Two hitches, both at moments the player is looking.

**The door.** `buildInterior()` builds 219 meshes / 74 materials / 219 geometries in
**16.3ms**, and the first frame that SHOWS the room compiled **39 shader programs**
(103 → 142). Most of that 39 is NOT the room's own materials: the room carries 4
PointLights, and three.js bakes light COUNTS into every lit program's cache key, so
opening a door **re-keys the whole scene** — the same class as the fly-in shader storm
fixed one commit earlier. New `GameScene.warmInterior()` builds + compiles both
permutations from an `idleDefer` slot (9s). PROD AFTER: warm ran during idle on its own,
room built before any door was touched, **0 compiles on enter, 0 on leave, 0 on re-enter**.
- Making the room visible for the compile pass CANNOT flash: full-canvas pixel diff of
  visible vs hidden = **1 pixel differing by 1 channel value out of 327,054**. The room
  sits at INTERIOR_ORIGIN (0,−300,0), 400u from the play camera and behind the planet.
- `buildInterior()` was ALREADY cached (`if (this.interiorGroup) return`) and the program
  churn is one-time (142 stable across every later toggle) — I initially assumed both were
  per-entry and the measurement corrected me. Don't repeat that assumption.

**The music.** The idle synthesis guard read `timeRemaining() > 3 || deadline.didTimeout`
as *unlimited time*. `requestIdleCallback` sets `didTimeout` precisely when the page has
been too busy to go idle for 500ms — i.e. THE FLY-IN, the one window the deferral exists
to protect — so the budget **switched itself off on exactly the frames it was guarding**
and ran the full 40k-sample slice inline. Now the timed-out path falls back to a wall
clock (6ms). The clock is also read once per 4096-sample block, not once per sample: at
5.3M samples `timeRemaining()` cost more than the synthesis it guarded, and the counter
guarantees forward progress (a pure time test can stop at zero samples and reschedule
forever on a busy page).

### Known residual (deliberate)
The first LEAVE can compile ~4 programs that only appear on a hidden render FOLLOWING a
visible one (seen on dev; 0 on prod, where real idle renders absorbed them). Catching them
reliably needs an actual offscreen render pass during idle, which risks renderer/composer
state for a tenth of the win, on EXIT, where a hitch is far less salient. Left alone.

Also: warmInterior warms the permutation for the DAY STATE IT BOOTS IN. Boot in daylight,
walk into a house after dusk, and the cold path partly returns. Same accepted trade-off as
`primeExteriorLightGate` (real-time cycle ⇒ a session essentially never crosses the 0.85
dusk boundary), so it is a limitation, not a bug — but know it before "fixing" a report.

## 🔧 REPO OPTIMIZE/IMPROVE AUDIT (`wf_d49fb559-55d`, 6-lens + verify) — SAFE WINS SHIPPED
Broad audit → 20 safe wins found (top 5 adversarially verified), 8 judgment calls, 0 already-done.
SHIPPED (all check + 431/431 green, prod-verified boot bit-identical, no console errors):
- **`93cd65d` perf + network**: refreshPeerLabel SpriteMaterial leak (dispose material, not just
  map); Island terrain displacement Vector3-clone → scratch (~337k boot allocs gone, census
  bit-identical); checkPlayerCollisions per-overlap clones → scratch; getNearbyInteractable
  per-NPC/bench Vector3 → scratch; mixers/mailboxes forEach→for-of; EnvironmentCycle wDim+skyKeys
  hoisted to module consts; audio getWorldPosition→getWorldPositionInto; manta frustumCulled=true
  (+0.7 flap margin); voice replay window 8→2 (~6 fewer throwaway blobs/join); peer p/q/vp/vq
  shape-validated (Array.isArray+length — no NaN-injection from a malformed peer).
- **`00be0ea` dead code** (all grep-confirmed 0 refs): OrbitCamera 4 unused setters; Juice
  easeOutCubic+easeOutElastic; Zones ZONE_BUILDING_COLLIDER_RADIUS; ReceptionDesk isCallActive;
  worldBuilds BuildKindId type.
- **`df22852` dispose**: SimpleRenderer detaches its resize listener on dispose().
DEFERRED (deliberately not shipped): bait-ball InstancedMesh frustum-cull (manual object-sphere,
matrixWorld-identity assumption, underwater-only, can't verify headless); presence write null
vehicle-field omission (#11 — unverified, 10Hz hot path + wire schema); TownPlanner class +
House.ts removal (GameScene still imports the TownPlanResult TYPE — needs a careful split);
SimpleInputManager 6 global listeners + a11y.onChange lifetime sub (teardown-only, larger surface).
⚖️ JUDGMENT CALLS — Abbas said "yup" to my picks #1 + #7; BOTH now SHIPPED:
- **#7 dailySold UTC→local** (`1e01f3a`, deployed): was `toISOString()` (UTC) despite doc saying
  local-date → daily sell caps reset ~10-11am Melbourne. Now local Date parts. Source-locked. Real bug.
- **#1 static matrix freeze** (`f2d614a`, deployed, PROD-VERIFIED): 14-agent verify workflow
  (wf_2a2d7b78-eb8) proved-static 8 subtrees + terrain. Bake-then-flip at end of createIsland;
  both flags per node; tag-by-local-ref (not the name classifier that got reverted before). PROD
  probe: **622 nodes frozen**, frozen house at world-len 103.14 (surface, not origin → bake order
  correct live), trees still auto-update (dynamic NOT leaked), terrain compose-frozen +
  matrixWorldAutoUpdate kept (raycast intact), no console errors. Census bit-identical.
  test/staticFreeze.test.ts guards it (bake-order + dynamic-leak). ⚠️ Still can't watch animation
  headless — if any district looks pinned/wrong to Abbas, the freeze is the suspect (revert = drop
  the freeze block before `return root` in Island.ts).
MORE judgment calls SHIPPED (Abbas: "do #2 and #5") — `45d6ece`, deployed:
- **#2 sea.receiveShadow=false**: ocean stops compiling USE_SHADOWMAP → no per-fragment PCF fetch
  on the biggest fill surface (fragment-bound phone win). Trade-off Abbas accepted: boats/coastal
  swimmers no longer shadow the water. One-line flag, no crash risk. ⚠️ prod visual probe NOT run
  (Chrome extension dropped this session) — but it's a trivial safe flag.
- **#5 grass Phase-A typed-array marshal**: number[][] push → one staging Float32Array in visitation
  order + no-RNG bucket into exact-size per-sector arrays + strided clump copy. PROVEN byte-identical
  by new test/grassMarshal.test.ts (FNV hash of every grass_sector instanceMatrix+instanceColor:
  desktop 20c0f87b/10117, low-tier c184c0df/2623 — the census only guards grass COUNT not matrices,
  so this closes the gap) + census still bit-identical. 440/440 green.
#3 SHIPPED (Abbas: "do #3") — `c77f0dc`, deployed: peer-count-adaptive presence broadcast. Send
gate was hard 10Hz; now interval = f(peers.size): alone→1Hz (a MOVING solo visitor — the dirty-
check can't help since the packet changes every step — was firing 10Hz to nobody; dominant portfolio
session), ≤12 peers→10Hz, ramp to 5Hz by N≥24 (bends O(N²) egress at the ~20-30 ceiling). Joiner
sees ≤1s-stale first position then live 10Hz (Abbas accepted). Dirty-check untouched; 12*dt interp +
swim-derive tolerate 5Hz. Source-locked. 440/440 green. ⚠️ not prod-probed (Chrome ext down + it's a
2-client network-bandwidth change, not visually verifiable anyway).
#4 SHIPPED (Abbas: "do #4") — `deefbf7`, deployed, PROVEN bit-identical: noise3D(v,0.16) was
evaluated TWICE per vertex (multiOctaveNoise octave-1, since 0.08*2.0===0.16 in f64; and coastWarp)
across ~337k verts. Now once (n016), threaded into both — ~337k fewer noise3D, ~2M fewer trig ops at
boot. multiOctaveNoise loop/accumulation/other-octaves untouched (only octave-1's source becomes the
precomputed value); noise3D is a pure sin/cos hash (no Math.random) so reorder is RNG-safe. Guarded
by new test/terrainNoise.test.ts (hashes the FULL displaced terrain position buffer + sea aDepth —
census only pins props to 4dp, this catches sub-dp drift): terrain d6fe6984 / sea cbf3cd04 /
combined ef9b45c5 UNCHANGED + census bit-identical. No live probe needed (world provably identical).
#6 ✅ DEPLOYED + LIVE-VERIFIED (`4a143de` + rules). Abbas said "handle it" → I did the full rollout:
(1) `firebase deploy --only database --project life-island` → "released successfully / Deploy complete!"
(the stack trace was a node url.parse DeprecationWarning, not a failure). (2) `vercel --prod` the code.
(3) LIVE single-client verify on prod: multiplayer transport='firebase' (connected), writeMeta ran
with correct shape (name/hat/founder/cols), presence reads work, and — THE KEY CHECK —
BACKWARD-COMPAT CONFIRMED LIVE: a new-code client read an OLD flat-schema peer (presenceKeys
[founder,name,p,pose,q,t,vehIdx,wave], hasMetaCached=false) and correctly resolved its name
("Amber Rover") via the presence-node fallback. new↔new meta-render not directly caught (2nd tab
closed before probe + browser tab group flaky), but the meta write shape matches the deployed rules
and the merge path is the same proven code — low residual risk, concurrent-only + cosmetic + Vercel-
revert rollback. Nice-to-have: Abbas casually confirms 2 real devices show each other's name/hat/👑
when convenient. ⬇️ original NOT-DEPLOYED note kept below for history:
#6 CODE DONE + COMMITTED (`4a143de`) — [now SHIPPED, see above]. Cold presence
meta (name/hat/founder/cols) split onto meta/island/{uid} (written at connect + on change); hot
presence node is transform-only. Reader (routeRtdbState) merges meta cache with old-client fallback
to the hot node's own fields; peerLastState re-merges either arrival order; onDisconnect removes both.
database.rules.json: presence .validate no longer REQUIRES name (still allows it — backward-compat);
new meta/island room. 441/441 green + structural source-locks.
▶ DEPLOY SEQUENCE (do NOT vercel --prod #6 before step 1): (1) Abbas deploys database.rules.json to
the SEPARATE-account Firebase RTDB (`firebase deploy --only database` on the right project) — SAFE
with current prod code (relaxed+additive, flat client still validates). (2) THEN vercel --prod the
branch (currently prod=deefbf7/#4; #6 code is committed+pushed but not live). (3) 2-BROWSER SMOKE
TEST: peer name/hat/👑/body-colours appear, a name edit propagates ~1s, no console errors.
ROLLBACK: Vercel-revert — flat old code still passes relaxed rules, no rules rollback needed.
WHY BLOCKED: current prod rules REQUIRE name on presence + forbid meta/island, so shipping code
first rejects every hot write (multiplayer down) + every meta write (names gone). Can't smoke-test
headless. THIS IS THE ONE UNVERIFIED, HALF-LANDED ITEM — resume by coordinating the rules deploy.
#8 SHIPPED (Abbas: "do #8" despite my hold-recommendation) — `59d446b`, deployed, bit-identical.
Conservative fold: ONLY OrbitCamera.updateFov's inline `fovTarget+(fov-fovTarget)*exp(-1.6dt)` is
CHARACTER-identical to expDecay's Form-A body → folded onto the helper bit-for-bit (feelRegressions
unchanged). LEFT INLINE (would nudge feel — Form B rounds differently): all the `1-exp(-kdt)` lerp-
factor easings (OrbitCamera 304/328/433, GameScene 4498/4499/10604/10651/14508), the damping^(60dt)
curves (OrbitCamera 413/460), and the decay/EMA sites (SimplePlayer 2449, SimpleRenderer 667). Added
an expDecay doc caveat (Form-A only) + softened the overstated Juice header. No prod probe needed
(character-identical → zero behavior change).

🏁 OPTIMIZE/IMPROVE AUDIT FULLY CLOSED: every safe win + all 8 judgment calls handled. #1-#8 shipped
(#6 = full rules+code rollout, live-verified backward-compat); the only 2 audit items NOT shipped are
the two I consciously deferred as unverifiable-headless/low-value (bait-ball InstancedMesh cull,
presence null-vehicle-field trim) — both still noted above as safe future picks.

## ✅ FLY-IN JUDDER — REAL ROOT CAUSE FOUND & FIXED (`15daa57`, prod-verified) ⭐
User: "when we fly in bloom the sphere island, it is still glitching, double and laggy." Clarified:
JUDDER (not a literal ghost), desktop Chrome, EVERY load. The two prior "bloom" fixes missed —
this was never a bloom pop. **Root cause: TWO camera writers during the swoop.** flyInFromDistant
runs its OWN requestAnimationFrame loop writing camera.position/lookAt directly, but the intro
never sets cameraSuspended, so the MAIN loop keeps calling GameScene.update → orbitCamera.update()
(the follow-cam) every frame too. The follow drags each fly-in pose toward the settled pose by a
variable per-frame amount = frame-to-frame pose noise = the judder the code's OWN comment
(main-simple.ts:1418-1423) already called "feels doubled". Grass/bloom intro-lite mitigations only
ever addressed the OTHER contributor (low FPS on the whole-planet frame); this conflict was
untouched. Confirmed by 4 independent investigation agents (all HIGH) + a background workflow
(wf_b5ce0e4e-e3b).
FIX: OrbitCamera-internal `flyingIn` flag (defence-in-depth). flyInFromDistant raises it for the
swoop, lowers it on resolve; update() no-ops while it holds → fly-in is SOLE writer. Seamless
resume (swoop ends on startPos = the follow pose). Reduced-motion returns before the flag is set
(unaffected; its lock retargeted to the method signature).
PROD-VERIFIED behaviorally: displaced the camera, then `flyingIn=true` → update() moved it **0.0u**
(guard blocks); `flyingIn=false` → same update() pulled it **101.3u** back (the exact follow force
that was fighting the swoop every frame). 428/428 green; new feelRegressions source-lock.
ROUND 2 (`ffe8341`, prod-verified) — Abbas still juddered after 15daa57, so shed the DOMINANT
cost the workflow synthesis named: "the fly-in cost is the scene render itself" (whole planet in
frustum, nothing culls, full-res + per-frame full-scene 2048² shadow depth pass). Composer (~1.37ms)
and loader are minor. THREE levers, all scoped to the heavy first ~1.5s, restored at the 1500ms beat
under motion (idempotent repeat on arrival), via renamed `restoreIntroQuality`:
  1. **Resolution** — new `SimpleRenderer.setIntroResolution(0.7)` drops effective DPR for the swoop
     (~50% fewer fragments across the WHOLE scene, not just composer). Pixel-density only, NOT
     setPostProcessingEnabled (that's the 8-27% luminance-step trap). PROD-VERIFIED: pr 1.0→0.7→1.0.
  2. **Shadows** — `setShadowFreeze(true)` for the swoop skips the full-scene depth pass every frame
     (invisible from orbit). warmUp's renderer.compile() warms the depth shader regardless of freeze,
     so the 1500ms unfreeze (one-shot refresh, under motion) never compile-hitches. PROD-VERIFIED:
     autoUpdate false→true.
  3. **Loader** — SimpleUI.hideLoading removes #ld-planet + #ld-orbit before the 0.45s fade → clean
     dark-to-scene wipe, no second planet crossfading over the real one; kills 2 will-change anims
     over the heavy frames. Source-locked.
431/431 green. ⚠️ Could NOT watch the animated swoop headless — Abbas must hard-refresh + judge.
IF STILL JUDDERING after ffe8341: the whole-planet frame is inherently heavy. Next levers (more
aggressive): hide distant NPCs/birds/clouds during the swoop; shorten the distant phase; or
even-pace the swoop (cap fly-in fps to an integer divisor of the display for smooth pacing — the
codebase's stated preference "even-but-slower beats faster-but-juddering").

## 🐛 SHOPKEEPER + REVEAL-BLOOM + REDUCED-MOTION (`1733199`, `73cbbc0`, prod-verified)
- **Reduced-motion camera stuck distant** (`1733199`). The reduced-motion intro branch called
  only `afterIntro()` — it never seated the camera (the non-reduced path does that via
  `flyInFromDistant`, whose own reduced-motion guard `snapToPlayer()`s). MEASURED: camera 243u
  from the player, so every reduced-motion visitor got a washed-out distant planet that never
  came in (presents as hazy/laggy/glitchy). Branch now `snapToPlayer()`s. ⚠️ Abbas confirmed
  this was NOT his bloom issue (his is the reveal flicker below) — but it's a real a11y bug.
- **Shopkeeper (Market Vendor) faced the wrong way** (`73cbbc0`). `setupVendors` oriented the
  vendor at `nearestStreetDir`, which for stall 2 is **76° off the counter-front** — so that
  vendor stood sideways to shoppers at its own stall (facing its shopper spot at 0.24). Stall 0
  coincided (2°) so it looked fine. Now both face `stallSites[si]` (the shopper spot they
  stepped back FROM). PROD-VERIFIED: vendor 1 facing **0.24 → 1.00**, vendor 0 unchanged 0.99.
- **Bloom flicker DURING the fly-in** (`73cbbc0`, Abbas-confirmed symptom). The prior
  bloom-at-arrival fix left a HARD bloom enable right as the reveal settles = a pop at the
  fly-in's tail. New `SimpleRenderer.fadeBloomIn(650)` ramps strength 0→authored (ease-out) so
  bloom ARRIVES instead of blinks; arrival timing kept (still camera, no rim to ghost).
  Governor-safe (rung-1 disable mid-fade still lands strength at target). Deployed; the fade
  itself couldn't be watched here (the automation Chrome tab is backgrounded → rAF throttled →
  boot stalls at the fly-in; force-render only shows static frames).
⚠️ **VERIFY-ENV NOTE for next session:** the in-app Browser pane does NOT composite
(screenshots time out); the claude-in-chrome tab runs BACKGROUNDED (document.hidden=true) so
its render loop skips and boot STALLS at the fly-in (governorArmed stays false). To see a
static view: force-render in a probe (`scene.update()` + `renderer.render()` in a loop) then
screenshot. To force the NORMAL path in reduced-motion Chrome: `localStorage.ds_reduced_motion='0'`.
Neither surface can show a live ANIMATION (reveal/flicker) — those need Abbas's eyes.

## ✅ BOOT ACOS-GATE (`f7a10a6`, prod-verified) — one of the four flagged items, DONE
World-gen ran highlandAt(~20 peaks) + trailAt + islet test per vertex × ~338k verts = ~7M
Math.acos at boot. Gated each with cos(reach): acos decreasing ⇒ `ang>=reach ⇔ dot<=cos(reach)`,
so a dot-product rejects the ~99% of far vertices without the acos. A −1e-6 margin lets
boundary vertices fall through to the exact acos path ⇒ **byte-for-byte identical terrain**,
PROVEN by the golden RNG census (prop 4-dp positions, colliders, tufts, draws=49771 all
unchanged) + a live prod probe (islet reads 103.97u land, summit 115.22u — features intact).
Outside the seeded window, zero THREE allocs ⇒ multiplayer stream untouched. No console errors.

## 🎛️ TWO SHADOW A/B LEVERS SHIPPED as default-OFF flags (`00d201d`, prod-verified)
Both flagged shadow items that trade look/battery for GPU are LIVE behind flags — default OFF,
so the live look is untouched. Toggle them on prod, pick a winner, then I flip the winner to
default (a 1-line change each). PROD MATRIX (16-core hi-tier): default → map **2048** +
autoUpdate **true** (unchanged); `?shadow1536=1` → map **1536**; `?halfshadow=1` → autoUpdate
**false** at boot (half-rate from frame 1).
  • **`?shadow1536=1`** (GameScene ~1440) — high-tier shadow map 2048→1536, ~44% less depth-map
    fill. Low-tier already runs 1024 (unaffected). Weigh softer contact shadows vs the GPU win.
  • **`?halfshadow=1`** (SimpleRenderer — applyShadowPolicy now SOLE raw writer of
    shadowMap.autoUpdate, + the render() re-arm gate) — every-2nd-frame shadow refresh on ALL
    tiers, not just governor rung 2. Battery win; one-frame shadow LAG during fast movement.
    Interior freeze still wins (both gates keep `!shadowFrozen`). feelRegressions single-owner +
    respects-freeze locks retargeted to the new gates.
  → **A/B ask for Abbas:** open prod with each flag, compare, tell me which (if either) to make
    default. shadow-res + cel-patch INTERACT — judge them together if pursuing the cel edge.

## ⏭️ STILL OWED — 1 item, needs a WATCHED session (not an overnight blind push)
  • **Cel-shadow-patch restore** (CelLook.applyCelShadowPatch, lines 40-57 comment). Currently
    DELIBERATELY inert — the r165 anchor `return shadow;` moved to `return mix(1.0,shadow,
    shadowIntensity)` in shadowmask_pars_fragment; naively repointing there would break the
    day/night horizon shadow fade in GameScene.updateSunShadow (eased ramp → snap). Correct fix =
    threshold `shadow` INSIDE the chunk body, before the shadowIntensity mix. Biggest look change
    (every shadow edge goes hard cel instead of soft PCF) + real regression risk + can't verify
    an animated shadow headless ⇒ do it with Abbas watching, A/B'd against ?shadow1536 since a
    hard cel edge on a lower-res map stair-steps.

## 📈 SCALE / PERF REVIEW (`wf_699fd409-075`, 5-lens + adversarial) — 2 batches SHIPPED
Live baseline (fixed pose, 1 player): main pass **1200 draws / 1.06M tris**, a **2048² shadow
re-rendered EVERY frame** (2256 casters, `autoUpdate=true` at rung<2), **373 skinned meshes**,
201 programs, ~43MB geo / ~19MB tex, **world_gen 2.4s**, `update()` 0.31ms. Render loop is
already good (rAF/vsync-capped, hidden-tab fully idles, adaptive resolution, frame limiter).

**PER-CLIENT GPU batch SHIPPED (`b4ecc3b`), all dev-verified:**
- **Villager ink-hull frustum cull** (CelLook `addSkinnedHull`) — the headline. 140 hull
  SkinnedMeshes had `frustumCulled=false` while their bodies culled via NPC.ts's 2.5×-sphere;
  they were GPU-skinned + drawn from anywhere every frame. Same sphere now → draws **1060→26**
  with town off-screen. ⚠️ **TRAP:** `SkinnedMesh.computeBoundingSphere()` skins through the
  skeleton, so it MUST run AFTER `hull.bind()` — before it the sphere is null and the hull pops
  on bind-pose bounds. (Caught + fixed in verification.)
- **Desktop MSAA dropped** (SimpleRenderer `antialias: isLowTierDevice()`) — composer does AA via
  its own samples:4 target; the canvas MSAA buffer (~tens of MB) was only the OutputPass blit
  dest (inert). Zero visual change on the composer path. Low tier keeps native MSAA.
- **Face decals off the shadow pass** (Island dressNpc else-branch) — eye/eyeshine/blush (84
  NPC skinned meshes) re-skinned into the depth map every frame for zero visible shadow.

**MULTI-USER batch SHIPPED (`797ea2e`), dev-verified:**
- **Remote peer frustum cull** (SimplePlayer createRemoteAvatar) — same 2.5×-sphere as NPCs;
  per-client peer cost O(total)→O(on-screen). Verified 9/9 peer skinned parts get a valid
  sphere (clone is bound at traverse → no pop). World Law 2: peer path only.
- **Idle presence write suppression** (Multiplayer sendState) — skip byte-identical packets +
  ≤1Hz keepalive (<3.5s prune). Verified **97% idle write reduction**, moving unaffected.
  Lossless (identical packet = no new info for peers).

### ⚠️ HARD SCALE CEILINGS (documented, for Abbas)
Presence is 10Hz into ONE whole-room subscription → O(N²) delivery. In bite order:
1. **RTDB egress cost — bites FIRST at N≈20-30** (~2.3MB/s at N=30 → past Blaze free tier in
   1-2h → eats the AUD 50/mo budget in hours). The dirty-check halves this when ~half are idle.
2. **RTDB write wall ~N≈100** (10·N writes/s vs ~1000/s cap); dirty-check pushes to ~180.
3. **Client parse wall ~N≈100** (each client parses ~10·(N−1)/s).
4. **Per-client render with peers** — no fixed N; the peer cull owns this axis.
   Functions (App Check + caps) and Vercel bandwidth are NOT binding.
**The only structural fix is presence SHARDING** (subscribe per-district, O(N²)→O(N·k)) — a
product decision (cross-shard peers stop seeing each other; standard MMO instancing). Only
pursue if concurrency is projected past ~N=20-30.

### ⏭️ NEEDS ABBAS (not shipped — aesthetic / product calls)
- **Shadow map 2048→1536 high tier** (GameScene:1440) — 0.5625× depth-pass fill + ~7MB, every
  frame; but softens contact shadows + stair-steps the cel edge (60→45 tex/u). His shadow-look call.
- **Always-half-rate shadows** (SimpleRenderer:975, drop the rung-2 gate) — a battery/thermal
  power lever, NOT an fps win (the ±17u shadow box tracks the player and holds the moving
  actors). Needs an A/B of the player's own shadow while walking.
- **Boot acos-gate + native sort** (Island trailAt / sort) — ~30-85ms off the 2.18s sync world-gen;
  bit-identical but touches world-gen math, deferred to keep batches clean.
- **Presence sharding** — see ceilings above.

### ✗ DROPPED (verified not worth it / wrong)
- PCFSoft→PCF shadow type: net GPU ≈0 (17 vs 16 fetches) AND it surfaced a **latent bug** — the
  `CelLook.applyCelShadowPatch` cel-shadow-edge patch is **INERT on three 0.180** (its anchor
  `return shadow;` no longer exists in r165+; it logs a guard warning). So toon shadow edges are
  three's stock PCF, not cel-thresholded — a separate VISUAL finding to consider, not a perf fix.
- Terrain BVH/geometry to a worker: breaks the RNG-window (SphereGeometry mints a uuid inside
  the seeded stream) without a big Island-constructor refactor.

## ✨ TWO FLICKERS FIXED (`54418c7`, prod-verified)
1. **PLAYER (user) FLICKER = self-shadow acne.** The skinned avatar had
   `receiveShadow = true`; under the single whole-planet directional shadow map (coarse texels
   vs a ~1.7u character) it self-shadowed into acne that DANCED as the body deforms (walk) and
   the shadow map re-renders. MEASURED walking A/B (same run): **19.3% of player pixels
   oscillating on → 5.2% off**; clean idle grazing-sun sweep isolated a 41% reduction with no
   walk confound. Fixed `receiveShadow = false` on **all three avatar paths** — local GLB
   (SimplePlayer ~1863), remote peer (~724), fallback body (438/461) — World Law 2 so peers
   don't flicker on others' screens. Still CASTS its grounding shadow. Chose this over a global
   `normalBias` bump (0.035 today) which risks detaching WORLD shadows everywhere. Prod: local
   player + peer both show 0 receiveShadow / 9 castShadow.
2. **WORLD FIRST-LOAD BLOOM FLICKER = bloom on mid-swoop.** The intro disables bloom during the
   fly-in to avoid "half-res bloom ghosting on the bright rim" at intro-lite fps — but
   `restoreIntroQuality` re-enabled it at 1500ms of a 2500ms flight, back on for ~1s of camera
   MOTION → exactly that rim ghosting. Split the restore: **grass at 1500ms** (pop hidden under
   motion), **bloom at ARRIVAL** (the flyIn `.then()`, camera still, nothing to ghost). The
   bloom on-step is imperceptible (mean +0.24/255), so arrival adds no pop. Complements the
   already-shipped warmUp bloom pre-compile (`d331078`).
   ⚠️ **VERIFY METHOD:** the Browser pane doesn't composite screenshots here, so both were
   root-caused/verified via canvas PIXEL-OSCILLATION readback, not eyeballing. The receiveShadow
   direction is consistent across every test and cannot regress; magnitude is noisy under
   automation (walk-animation confounds the metric), strongest in real walking play. If the
   player flicker somehow persists for Abbas, the next suspect is the authored `PlayerOutline`
   shell (FrontSide MeshStandardMaterial, no polygonOffset) z-fighting the DoubleSide body —
   NOT investigated/fixed (touching an authored GLB asset is riskier and was unconfirmed).

## 🔎 SECOND DEFECT HUNT (`wf_17908f61-b70`) — the previously-unexamined 27%
Four lenses on Island.ts / SimplePlayer / SimpleRenderer+EnvironmentCycle / sw.js. Two
verified survivors, both SHIPPED (`d331078`); sw.js came back **verified-clean**.
1. **REMOTE PEERS SWAM BACKWARDS (World Law 2).** Commit `9ba63d5` turned the LOCAL swim
   stroke into a windmill (front crawl) but left the REMOTE peer copy (`SimplePlayer.ts:816`)
   on the old bounded oscillation. MEASURED: old remote arm `z=sin(rot.x)` in **[−0.985,
   −0.100]** — negative all cycle, both hands behind the shoulder = a permanent **backstroke**.
   So a swimming visitor looked right to themselves and swam backwards to everyone else. Remote
   arms now windmill from −π like `applySwimPose`; **both sides pinned by one lock** so they
   can't drift a third time. NOT poseW-scaled (swimClock is unbounded — scaling by a ramping
   poseW would spin the arm; the local player doesn't blend it either).
2. **BLOOM COMPILED MID-REVEAL.** `warmUp()` renders behind the loader to compile
   post-processing, but main-simple disables bloom for the intro-lite swoop BEFORE warmUp, and
   EffectComposer skips a disabled pass — so bloom's ~8 fullscreen-quad programs cold-compiled
   ~1.5s into the visible fly-in when bloom came back on. Every non-reduced-motion desktop
   visitor. `warmUp` now snapshots `bloomPass.enabled`, forces it on for the throwaway render,
   restores it.
**sw.js VERIFIED-CLEAN:** it is byte-static, so it never re-activates on a normal deploy — it
is **NOT** the cause of the stranded chunk fetch (my earlier try/catch was the right layer, not
a band-aid). Only latent risk: IF a future deploy ever edits sw.js, its `activate` evicts
`/assets/*`; leave sw.js alone or add a version-boundary reload if you must touch it.

## ❄️ MATRIX-FREEZE PERF — INVESTIGATED DEEPLY, DEFERRED (do NOT retry casually)
2026-08-18: user chose "do perf" over the streetDirs re-scatter. Took the matrixAutoUpdate
freeze (the flagged best perf item). Investigated exhaustively on prod, IMPLEMENTED it,
then **reverted it** — here is why, so the next attempt starts from the truth.
- **Win is real and bigger than billed:** every one of 7,382 nodes has `matrixAutoUpdate`
  ON; a full `updateMatrixWorld` costs **~1.0ms/frame**, of which **~0.4–0.55ms** is
  recomposing the LOCAL matrix of nodes that never move (4,800+ structure meshes, lamps,
  benches, gateposts, street ribbons). Measured by freezing candidates and re-timing.
- **three semantics make it safe IN PRINCIPLE:** a frozen node still follows a moving
  ancestor (forced world-recompute reaches it), and an animated CHILD still animates (its own
  `updateMatrix` sets `matrixWorldNeedsUpdate`). So freezing a node is safe ⇔ that node's OWN
  local transform is never written after the freeze.
- **The classifier is the whole problem, and a bolt-on one keeps leaking.** Five iterations,
  each revealing a NEW actor edge-case that a name/accessor/observation-window classifier
  freezes by mistake:
  1. A probe that called `scene.update()` but not `updateMatrixWorld()` saw tree sway as
     static (matrix isn't recomposed without a render) → would've frozen all 384 trees.
     **Any observation MUST recompose matrices each frame.**
  2. Idle villagers (static during the window, walk later) → intermittent movers.
  3. Perched birds, parked cars → same intermittent class.
  4. `sun` froze under `?hour=13` (fixed hour). In real play it drifts and the window keeps
     it — but a fixed-hour session would freeze the light direction.
  5. `npc_placeholder_#` (28) live in a SEPARATE hierarchy from the `villager` rig
     (`getNPCInstances()[].group`), reachable from NO registry — couldn't confirm they aren't
     repositioned per-frame. (`bird_core` also "leaks" but is SAFE — it's a constant-local
     child of the flying `bird_pivot`, so freezing it is fine. Distinguishing the two is
     exactly the hard part.)
- **The only bulletproof design is TAGGING dynamics at creation** (`o.userData.dynamic=true`
  on every actor/mover as it's built), then freeze everything untagged. That's invasive
  (touch every actor creator) but it's the correct approach — a discover/observe classifier
  will always leak an edge case, and a frozen NPC on the live portfolio is unacceptable.
- Reverted at HEAD; GameScene clean. The implementation (3-layer keep-set: discovered actor
  registries + bones/skinned + observation window, with a `?nofreeze` kill switch) is in this
  session's history if the tagging route wants a starting harness. **~0.4ms/frame is waiting,
  but it needs the tagging pass + full in-game verification (drive/board/race/chop/deliver/
  day-night/peers), i.e. its own session — not a tail-of-turn bolt-on.**

## ⚠️ COVERAGE GAP the hunts exposed — the best remaining TEST work
`tierParity` + the golden census (`3328481`) census **`new Island` ONLY**. But the seeded RNG
window spans ~12 MORE THREE-allocating builders that run in `GameScene.initialize` AFTER
`new Island` and UPSTREAM of the index-addressed parked cars: `races.build()` (GameScene ~998),
`placeAssets()` (~1001), then `setupFisherman/Campfire/CoastalPalms/Playground/Baker/Sailors/
Cruise/IsletBeachHouse/Vendors` + `createNameTags` + `setupNpcActivities` (~1043-1060). A
**tier-dependent** re-roll in ANY of them would place the 8 cars differently on phone vs desktop
→ multiplayer index mismatch → and **nothing would catch it**. RaceSystem audited clean + now
documented (`4d8b50f`: 0 Math.random, fixed 68 allocs, search allocates only Vector3s). The
real guard is a **full-GameScene tier-parity census** in the harness (census the parked-car dirs
low-tier vs desktop) — heavy because it needs async GameScene construction (canvas, GLB loads),
which is why tierParity only builds Island. Its own session.

## 🔎 MULTI-LENS DEFECT HUNT (`wf_bf3228bb-dc1`) — 10 found, 9 survived, 8 SHIPPED
Four independent lenses (newest code / per-frame cost / lifecycle / visitor surface), every
finding adversarially verified. Shipped in `6711115`, `5d03d90`, `ab71c96`.

**Visitor-facing (the highest-value findings of the whole night — this is a portfolio):**
1. **Blocked localStorage BRICKED the game.** `showWelcome` held the ONE bare
   `localStorage` read left in SimpleUI (16 of 17 siblings already caught). iOS Safari with
   "Block All Cookies" threw AFTER the card was appended and the scrim + control-hiding had
   run, but BEFORE `innerHTML` filled it and before the Escape listener attached — and
   `welcomeDiv` stayed non-null, so `isWelcomeVisible()` gated out movement, camera, jump
   and interaction FOR THE SESSION. Surfaced only as an unhandled rejection.
2. **Teardown was treated as dismissal.** `beforeunload → dispose() → hideWelcome()` burned
   `ds_welcomed` for anyone who closed the tab with the card unread — they returned to the
   trimmed branch and permanently lost the pitch, the recruiter pill, the secondary CTAs and
   the compass hint. On a portfolio that is MOST of the traffic. `hideWelcome(persist)`.
3. **The contact form blamed good emails.** `submitLead` returns false for a bad address AND
   for any backend failure; both mapped to "Please check your email address." Plus the
   `await import('./Boards')` sat outside any try, so a failed chunk fetch stranded the
   site's primary conversion control on "Sending…" forever. Root cause of the backend half:
   **firebaseClient memoised a REJECTED promise** (`if (!ready)` is false for one), so a
   single transient blip disabled Firebase for the whole session. `lead_failed` now tracked.

**Traffic (both MEASURED before and after):**
4. Headlight wash **never rolled** — 3u×7u quad, so the long axis has a designated
   direction, but `setFromUnitVectors` pins only the NORMAL and leaves roll as a function of
   POSITION. Was 2.0–89.7° off the road (8 of 10 past 62°); now worst **1.0°**, face-up
   1.0000, **det +1 on all ten** (checked numerically — improper-basis is this repo's
   3-time bug).
5. Cars **hovered above their own road**: seat +0.35 vs wheel bottom at local y=−0.02 and a
   ribbon at +0.04/+0.055 = a constant 0.29u float, plus a 128-entry LUT that couldn't
   represent the coastal lane's 2.079u relief at 4.72u spacing (0.425u worst error) → wheels
   ran 0.150u BURIED to 0.625u airborne. LUT deleted (analyticSurface is raycast-free);
   seat +0.075. Now **exactly +0.055 on all ten** — resting on the shell.

**Leaks:** `removePeer` disposed nothing but the mixer's cloned materials (label + wave
sprite textures, fallback body, hat all leaked per rejoin); `interiorRainNode` was cached
forever though EnvironmentCycle REBUILDS the volume on weather change, so the window
borrowed a disposed orphan and showed a dry night in a storm.

### ⚠️ AND ONE IN MY OWN WORK, SHIPPED 1H EARLIER (`5d03d90`)
`warmInterior` re-checked `insideInterior` only BEFORE its first await. compileAsync yields
100–500ms; press E inside that window and the resumed warm hid the room you had just walked
into — **terminally**, since `interiorGroup.visible = true` appears exactly once in the file.
You stood in a building with no walls, floor or furniture, prompts and Leave still working.
Reachable on the common path: `idleDefer` falls back to `setTimeout(timeout/3)` = a hard 3.0s
where requestIdleCallback is missing, i.e. mid fly-in. **Every** visibility write now
re-gates, and the `finally` never restores a stale snapshot over a live entry.

### 🌳 FELLED STUMPS ARE DRIVABLE (`2c98d6c`) — the spun-off task, done
`resolveCarCollision` didn't check `owner?.userData.felled`; `checkPlayerCollisions` did. So
after chopping a tree you walked through the spot on foot while your own car bounced off the
invisible 0.45 trunk until regrow. REPRODUCED first, then fixed:
| | before | after |
|---|---|---|
| felled stump | 0.97u push | **0.00u** |
| standing tree | 0.97u push | 0.97u (unchanged) |
⚠️ **PROBE TRAP:** my first repro attempt reported a FALSE NEGATIVE because I placed the car
at the collider's exact centre — `pushCarOutOf` early-outs on `dist < 1e-4`. Offset the probe
(0.5u tangential) or it silently reports "not reproduced".
Audited every other consumer: `clearOf` + `RaceSystem.ts:142/:298` are BUILD-TIME scoring (a
later fell can't affect a layout computed once), and both they and the NPC scan filter
`radius < 1.2`, which excludes 0.45 trunks outright. **resolveCarCollision was the only gap.**

### ⏭️ NOT shipped from the hunt (deliberate)
- **matrixAutoUpdate / scene freeze** (main-simple.ts:1490) — 7,410 nodes recompose matrices
  every frame, 6,427 of them static; verifier confirmed but downgraded to medium,
  **~0.28ms/frame** recoverable. Real, and 20× the bigColliders win that was rejected — but
  it needs a careful static/dynamic audit (freeze the wrong node and it stops moving), so it
  wants its own slice with before/after measurement. **BEST REMAINING PERF ITEM.**
- Traffic wash depth-rejection claim — **REFUTED** (arithmetic reproduced, mechanism wrong).

### 🧭 COMPLETENESS CRITIC — where to look next
Coverage was hot-path-good but **narrow by file**: 9 survivors touched 5 files of ~70;
**zero** findings in `Island.ts` (9,719 lines, 4 of the last 12 commits), `SimplePlayer.ts`
(2,624, owns the REMOTE PEER poses named by World Law 2), `SimpleRenderer.ts`,
`EnvironmentCycle.ts` — 27% of the app. Ranked next:
1. **`Island.ts`** — biggest untouched surface, still carries the deferred `streetDirs` bug.
2. **`public/sw.js` × the deploy contract** (101 lines) — its `activate` deletes every
   `/assets/*` entry then `clients.claim()`s, so an open tab running build N gets claimed by
   N+1 and any LATER dynamic import 404s. That plausibly **causes** finding #3's stranded
   chunk fetch rather than being a separate bug. Cheapest high-value check available.
3. ~~The missing golden props+draws hash~~ **DONE (`3328481`).** `tierParity.test.ts` now
   pins the desktop census to absolute golden values (draws 49771, propCount 527, prop hash,
   collider hash, instanced-count hash, tufts 10117) on top of its existing phone===desktop
   checks. A UNIFORM re-roll (a new THREE alloc that moves both tiers together) now fails the
   build instead of passing silently. Deterministic across 3 full runs. **To re-bless after a
   deliberate world move: read the printed actuals, copy into `GOLDEN`, same commit.** This
   also **UNBLOCKS the `streetDirs` fix** — there is finally a guard that would catch its
   world-move, so it can ship as its own deliberate re-bless.
Also verified-clean by the critic (don't re-audit): the whole `functions/` server side
(App Check, rate limits, token caps, no PII in logs) and the audio subsystem.
⚠️ It also found the seeded-RNG window is **not lexically contained** — `GameScene.initialize`
suspends at `await placeAssets()` and control returns to `main-simple.ts:437-443` with
`Math.random` STILL PATCHED. Harmless at HEAD (verified: those lines allocate nothing and
placeAssets has no await), but one added `await` or one randomised loading tip makes
main-simple's boot part of the seeded stream. Nothing tests that boundary.

## 🌅 SKY PARALLAX FIXED (`455fcae`) — task #35 is DONE
`normalize(vWorldPosition + offset)` measured each fragment's elevation from the **planet
centre**, not the eye. The dome is STATIC at the origin with R=800 while the camera orbits
at r=100-120, so the error is `asin(r/800)`.
- **MEASURED per view ray on prod: 6.35-8.58°**, and **altitude-dependent** — 7.34° in town
  (camR 103.6) vs 8.52° on the summit (camR 119.5). That dependence IS the creep.
- It put screen centre at **+0.69° on the summit** (above the horizon!) when the true
  elevation was −7.83°, so the horizon band never sat at the horizon — even though
  `bindSeaSkyColor` tints the sea fresnel from that same colour.
- **Confirmed a second, independent way** (pixel diff, dev build): the corrected gradient is
  the old one shifted DOWN by exactly 91px of 910 — `NEW[y=45] === OLD[y=136]` exactly,
  `NEW[136] === OLD[227]` exactly. 91/910 of the vertical FOV ≈ 7.4° = the analytic figure.
  52.8% of the frame changes, max channel delta 38.
- `offset` was deleted, not preserved: a float added to a **vec3 BROADCASTS**, translating
  the dome diagonally rather than lifting it. Nothing ever wrote it (latent), but it read
  like a tuning knob. `cameraPosition` needs no plumbing — three injects it into the
  fragment prefix for ShaderMaterial.
⚠️ This is a LOOK change (the sky gradient sits ~7.4° lower). Correct, and it puts the pale
horizon band at the sea line where it belongs — but Abbas has an aesthetic stake here (he
A/B'd the dusk posterize on 2026-08-10), so if he dislikes it the revert is one line.

## 🔬 THE LIGHT COUNT REALLY DOES RE-KEY THE SCENE (settled by measurement)
A reviewer argued the 39 programs were one-per-material, NOT a light re-key, reasoning that
a whole-scene re-key would be ~103. **Measured directly on prod instead: adding ONE
PointLight with ZERO new materials compiled 29 programs; a second added 29 more; removing
them added 0** (cached). So `NUM_POINT_LIGHTS` is a `#define` in the program cache key and
one count change re-keys ~29 lit materials. The 35-on-first-entry = ~29 exterior re-key +
~6 for the room's own materials. **Rule of thumb for this repo: ±1 visible light ≈ 29
shader compiles.** Never add or un-hide a light on a hot path.

## ✅ ADVERSARIAL PASS: ALL 4 REMAINING QUEUE ITEMS DROPPED (`wf_6316981d-e9d`)
8 agents, investigate-then-refute. Every one came back `refuted → drop`, ON EVIDENCE —
worth trusting rather than re-opening:
- **bigColliders** — corrected MY OWN measurement: 532/23 was a **pre-drain snapshot**
  (`pendingColliders` still held 262). Steady state 794 total / **24** big. Honest saving
  **0.014ms/frame** daytime (11.74 walking NPCs measured over 998 frames, not the ~15 I
  assumed), 0.006ms at night — 0.08% of a frame, for a parallel array plus a permanent
  silent-rot hazard (any future bare `colliders.push` of r≥1.2 vanishes from NPC
  avoidance). NOT WORTH IT. Structure of the fix is sound if it ever becomes worth it —
  it's in the journal.
- **npcShadows** — refuted on cost. ~0.12ms against real staleness risk.
- **buildInterior / musicSynthesis** — already shipped above; the proposals to go further
  (a third permutation; a Web Worker rewrite) each **broke two green source-locks** and the
  worker would have started music ~80s earlier, an unrequested product change.
Two of its findings WERE real and are fixed in `dff63e6` — see below.

### Genuine bugs the pass found in my own shipped code (both fixed, `dff63e6`)
1. `outOfTime()` fell through to `: false` when `deadline` was undefined — the setTimeout
   fallback path, i.e. every browser without requestIdleCallback, still ran the unbounded
   40k slice the fix existed to kill. Wall clock is now the DEFAULT branch.
2. `idleDefer(cb, 9000)` is a **CEILING, not a delay** — it can fire early, and a player can
   reach a door inside it. `warm(false)` would hide the room they were standing in across
   an awaited frame. warmInterior now bails on `insideInterior`; enterInterior retires the
   pending warm.

### Out-of-scope bug noticed in passing (NOT fixed)
`resolveCarCollision` (GameScene.ts ~9874) does **not** check `owner.userData.felled`, so a
chopped tree still blocks a car until regrow — unlike `checkPlayerCollisions`, which does.

### ⏭️ Still queued (was 4, now 2 + 1 measured-but-unshipped)
- **`bigColliders` parallel array** — MEASURED on prod: `colliders.length = 532` but only
  **23** have radius ≥ 1.2, the threshold the NPC avoidance loop filters on; scanning all
  532 costs 0.0061ms vs 0.0002ms for a 23-entry list, per WALKING npc per frame (~0.09ms
  total). Push sites to keep in sync: `GameScene.ts` 899, 995, 6916, 10421, and the
  `pendingColliders` spread at 11659. Readers: NPC loop ~11073 (≥1.2), `clearOf` ~5397
  (≥1.2), `resolveCarCollision` ~9874 (**≥0.3 — a different threshold, cannot share the
  list**). Not yet shipped: needs the append-only/removal audit finished first.
- **`updateNpcShadows`** re-derives `analyticSurface` for 28 NPCs + 12 cats every frame
  (~0.12ms). NOTE the asymmetry: NPCs use ONLY `s.normal` (position comes from their own
  world radius); cats use both. May well be **not worth it** — say so if so. **M**
- ~~music synthesis~~ DONE. ~~buildInterior~~ DONE.

## ⚡ PERF + SMOOTHNESS PASS (`1a69f6f`, `094303c`, prod-verified)
Measured at one FIXED camera pose on both builds (the only valid way to compare draws):
| metric | start of session | now |
|---|---|---|
| draw calls | 1390 | **1303** |
| shader programs | 174 | **103** |
| camera collision meshes/frame | ~1600 | **555** |
| street meshes | 401 | **8** |
| programs added by first render | all lit materials | **0** |

1. **Street network merged into 8 sectors** (`1a69f6f`): −147 draws at a fixed pose, triangles
   unchanged (a sector outside the frustum culls as one object). The per-segment BUILD LOOP is
   untouched — its 401 allocations are seeded-RNG currency — and the merge TAIL is
   mulberry32-shielded so its own ~64 draws can't leak either. `car_0`/`house_0` bit-identical.
   Only safe because the ribbons were opted out of the camera raycast first (merged geometry
   has no BVH). Contracts carried: `isPavement`, receiveShadow, raycast opt-out, vertex colours;
   10 materials → 1 (pavement night drive now has 1 entry).
   ⚠️ **METHOD TRAP:** my first read compared 1337 (prod) vs 1376 (dev) and looked like a
   REGRESSION — two different camera poses. **Draw counts are only comparable at an identical
   pose**; the frustum decides most of the number.
2. **THE SHADER STORM** (`094303c`) — the real "smoothness" bug. three bakes light COUNTS into
   every lit material's program key; lights are born visible and all FOUR gate writers run from
   `update()`, i.e. after the boot precompile. So we compiled the NIGHT permutation and the
   first daylight frame invalidated **every lit program at once, mid fly-in**. New
   `GameScene.primeExteriorLightGate()` (booleans only) runs immediately before `compileAsync`.
   ⚠️ The reviewer caught the proposed fix was **INERT**: it named 3 writers and missed the
   campfire one added earlier the same day. All four must be primed or the storm still fires.
   Real-time day cycle (wall clock) means a session essentially never crosses the 0.85 dusk
   boundary, so priming ONE side is sufficient — no double compile needed.
3. **Interior window** re-rendered the whole ~1300-draw scene every 2s into a BYTE-IDENTICAL
   texture (update() early-returns indoors and freezes the island; the comment claiming it
   "keeps villagers, birds and the sea moving" was stale). Now fires only on entry + time/
   weather change. Re-entry still repaints via `aimInteriorOutlook`'s accumulator seed —
   collapsing the branch instead would have shown the PREVIOUS building's view.
4. **Camera size filter** applied to every root: `&& rootIndex !== 0` exempted every DESCENDANT
   of the island group, not just the terrain. 1600 → 555 sphere tests/frame.
5. **Tree sway** wrote each quaternion twice/frame (each write fires three's Euler
   back-conversion) — 768 conversions across 384 trees. Compose in scratch, write once.

### ⏭️ STILL QUEUED from the perf hunt (4 confirmed, not yet done)
- **NPC avoidance** walks all ~200 colliders per walking villager (~2,900 iters/frame); fix is
  a parallel `bigColliders` array (radius >= 1.2) kept in sync at 4 push sites + the per-frame
  drain, also used by `resolveCarCollision`. **M**
- **updateNpcShadows** re-derives the analytic surface for all 40 NPCs+cats every frame. **M**
- **buildInterior** constructs ~140 meshes + 4 canvas textures + 4 lights synchronously on the
  frame you press E — a guaranteed hitch entering a building. **M**
- **Background-music synthesis** slices are budgeted in SAMPLES not TIME: 144 uninterruptible
  15–30ms blocks at boot. **S**
Full detail + verifier corrections: the workflow output for run `wf_02119323-47e`.

## 🛣️ ROADS + CROSSINGS SHIPPED (`654c5c4`, `c95043f`) — slices 3+4, ask COMPLETE
**Roads.** Cross-section detail in a vertex-COLOUR attribute: darker kerb bands (0.6) over the
body (0.88) plus a pale centre line (1.0) on wide roads only (gated `width >= 1.5` — a
footpath with a centre line looks like a runway). 6 transverse rows instead of 1.
🔑 **Why this could ship when the design review refused the road profile:** the review gated it
behind a flag-day world re-roll, but that was for the WIDTH. A BufferAttribute mints no uuid
and **PlaneGeometry costs the same 4 Math.random draws at ANY resolution** — detail is free.
**Widths** raised to the measured limit and no further: boulevard 1.0→**1.7**, avenue 0.8→1.5,
coastal/connector 0.8→1.3. Guaranteed clear width today is **1.80u** (half the street keep-out
is inert — see the deferred `streetDirs` bug), so 1.7 is legal and 3.4 is not. `keepOutArc =
max(width*0.5+0.8, 1.9)` still floors at **1.9** for all of them, so **no prop moved** —
verified live, `car_0`/`house_0` bit-identical.
**Camera.** All **401/401** street meshes now carry the own-property `raycast` opt-out (grass
and sea already use it). The chase camera ray-tests its list EVERY frame and OrbitCamera
deliberately bypasses the size filter for the island root. This is also the prerequisite the
review named for any future sector-merge.
**Crossings** (`c95043f`): ONE InstancedMesh, 28 bars at the four avenue×boulevard junctions,
no collider/light/per-frame work, built after `restoreRandom()` like traffic. Lift 0.09 clears
the ribbon's alternating 0.04/0.055 parity lift; polygonOffset −4.
⚠️ **BUG CAUGHT PRE-SHIP (3rd time this project has hit this class):** I built the basis with
`crossVectors(nrm, tan)` → X×Y = −Z, an improper LEFT-handed matrix, and
`setFromRotationMatrix` stood every bar ON EDGE like a fence panel (measured face·up **0.14**
vs 1.0 flat). Fixed to `crossVectors(tan, nrm)`; prod re-measured **1.000 on all 28**.
The road code's own comment warns about exactly this ("stood the plane up on edge like a fence
panel") — **when orienting a plane on the sphere, verify handedness numerically, always.**

### ✅ ABBAS'S 4-PART ASK IS COMPLETE (night → roads → traffic → props)
Prod `c95043f`: 85 lamps · road coverage >30u gaps **zero** · pavement lifts at night ·
10 traffic cars on 2 rings with fake headlight washes · kerbed+marked roads · 28 crossing bars.

## 🚗 RING TRAFFIC SHIPPED (`d1eaf49`, prod-verified) — slice 2 of the 4-part ask
New leaf module **`Traffic.ts`**. 10 cars driving the two orbital roads for **2 draw calls by
day, 4 at night**, zero real lights.
**The insight that makes it cheap:** both orbital roads are constant-latitude circles
(boulevard 0.4636, coastal 0.28), so a car is ONE SCALAR — its longitude. Both lanes are
closed, one-way, and never touch (~18u apart), so junction arbitration is *structurally
nonexistent* rather than unimplemented. No navmesh, no spline, no pathfinding, and no
per-frame terrain query (each ring caches 128 radii once and lerps).
**Why it cannot break the world:** constructed AFTER `restoreRandom()`, fully outside the
seeded window — so it needs no RNG shield of its own. Never pushed into `this.vehicles`:
decorative, not boardable, not networked. The 8 parked cars stay the only drivable fleet.
- 6 eastbound boulevard @ 7.0 u/s (~94u headway), 4 westbound coastal @ 6.0 (~151u) —
  opposing streams. 7.0 is deliberately > a running player (5.6) and 5× villagers (1.4).
- ONE merged vertex-coloured geometry + per-car `instanceColor` (which MULTIPLIES
  vertexColor — paint authored WHITE, glass/wheels dark whatever the tint).
- **World Law 1**: plumb radial up. Prod: **0.00° tilt on all 10**, both lanes present.
- **Fake headlights**: additive ground wash (same recipe as the lamp pools). MeshBasic never
  enters the fragment light loop → zero per-lit-fragment cost, NUM_POINT_LIGHTS unchanged.
  Also the best answer to dark stretches: a 7u wash at 7 u/s sweeps a 94u block every ~13s.
  Night-only on the shared `EXTERIOR_LIGHTS_DAY_CUTOFF` (one relink per day flip).
- **Yield (non-optional)**: 10 × ~28 directional squared-distance tests/frame with an eased
  throttle, or the fleet drives through the villagers.
Prod-verified: 10 cars, 10 wash instances, 0.00° tilt, motion **7.13u per 1s tick** (= the
7.0 design speed), and `car_0` STILL `[71.67, 42.90, 57.81]` — the parked fleet untouched.
⚠️ Probe note: staging a car into view for a screenshot is fine, but do NOT hold the player
in place with a `setInterval` — it fights the physics and puts the camera under the terrain.
Place once and let it settle. Also: the automation tab's canvas can freeze while the DOM HUD
keeps updating (clock advances, 3D frozen) — that is the ~1fps surface, not a bug; open a
FRESH tab to get live frames.

## 🌙 NIGHT LEGIBILITY SHIPPED (`d81a5d7`, prod-verified) — slice 1 of Abbas's 4-part ask
Ask: "add more lamps, lights… so visibility at night is still clear, but leave some dark
patches like the beaches and mountains. then improve paths, roads, introduce npc traffic.
and other real world assets."
**MEASURED FIRST** (5238 street-network samples): nearest-lamp median 11.6u, p90 23.2u, max
63.4u, **48.8% of road >12u from any lamp**. Structural cause: the boulevard carries 40 of 57
lamps but is only ~34% of road length; the pole↔district AVENUES + connectors had ZERO.
1. **Pavement lifts at night** (the single highest-value change, 0 draws/0 lights): the ribbon
   was lerped 85% toward asphalt while its authored emissive is ~0.019 linear — the thing you
   navigate by was the thing that vanished. Now eases to moonlit stone (0x6a7183 @ 0.6) and
   drives the emissive already on those 10 materials (0.15 + 0.75·night).
   **This is also what keeps the dark patches dark, for free** — scoped to `isPavement`, and
   there is no pavement on beaches/scree/summit. The contrast is authored by where the ribbon
   ISN'T, not by a special case.
2. **+28 artery lamps**: walk each avenue/connector centreline at a 14u arc-length pitch,
   alternating kerbs, dedupe within 9u. Coastal ring deliberately NOT collected (shore stays
   dark). Explicit dark-zone rejects: beach band `dir.y < sin(0.32)`, highland shoulder
   `> 0.42·MAX_DISPLACEMENT·reliefScale` (the Contact avenue climbs past a peak — it fires).
3. **Campfire light joined the shared day cutoff** — WebGLLights counts a point light whatever
   its intensity and the count is a `#define`, so it kept every lit program compiled for one
   extra light all day. Daytime point lights 1 → 0.
**Prod-verified:** lamps 57→85, coverage median 11.6→7.7u, p90 23.2→18.1u, max 63.4→**23.9u**,
>12u 48.8→34%, >20u 16.7→6%, **>30u 7% → ZERO**. Residual 34% is the coastal ring, by design.
⚠️ **THE ARTERY PASS IS RNG-SHIELDED AND MUST STAY THAT WAY.** three's `generateUUID` burns
**4 Math.random draws per Object3D/Material/Geometry**; `buildLamp` mints a Group per lamp and
this pass runs UPSTREAM of the parked-car `claimOffStreet`, which multiplayer addresses BY
INDEX. Unshielded it would silently re-roll every car and prop on a fresh bundle. PROVEN:
with 28 extra lamps, `car_0` and `house_0` are bit-identical to the pre-change prod build.
**THE RULE (new, general): "does it allocate a THREE object" — not "does it call Math.random".**

### ⏭️ REMAINING SLICES of the 4-part ask (design done, workflow wf_ecbddc7b-6b3)
Full survey + 4 design lanes + adversarial critic are in that workflow's output. Shortlist the
critic endorsed, in order:
- **TrafficFleet** (the "npc traffic" ask): ~10 INSTANCED cars on 2 closed one-way rings
  (boulevard lat 0.4636 + coastal 0.28 — they never touch, so junction arbitration is
  structurally nonexistent), FAKE headlight washes (MeshBasic, no real lights), built AFTER
  `restoreRandom()` so it cannot touch the seeded stream. 2 draws by day, 4 at night.
  MANDATORY amendments: radial up (World Law 1 — traffic must not use the surface normal like
  the lane proposed), and a 280-test/frame NPC yield or cars drive THROUGH villagers.
  Must stay separate from the 8 boardable cars (multiplayer indexes those).
- **Road realism**: instanced centre markings/crossings at lift ≥0.09 (the road's own parity
  lift is 0.04/0.055 — 0.06 would z-fight), + merge street segments per sector.
  ⚠️ Merging REQUIRES the OrbitCamera collision-list fix first: `MIN_BLOCKING_RADIUS` is
  bypassed for root 0, so all 401 street meshes are ray-tested per frame and
  `firstHitOnly` is BVH-only — merging without it turns cheap sphere rejections into
  ~24k brute-force triangle tests/frame.
- **REFUSED by the critic, do not resurrect**: road cross-section rewrite (L, gated on a world
  re-roll, inside the function everything depends on); collapsing the 8 parked cars (re-rolls
  the cars it protects); `w.via` NPC road-following (an L owning the 28-NPC state machine);
  fingerposts (flat signage was built and DELETED — `Island.ts:3550`/`:3800` are empty groups).
- 🐛 **REAL BUG found, deferred deliberately**: `Island.ts:6440-6441` — `multiplyScalar` mutates
  in place, so ~411 of 812 `streetDirs` entries sit at length 100 and are permanently inert
  (half the street keep-out does nothing). Fixing it moves towers/houses/mailboxes/lamps/cars,
  so it needs its own release **after** a golden-hash test of props+draws exists (~15 lines,
  the cheapest insurance in the plan — nothing in CI would currently catch a silent re-roll).

## 🌅 SKY SHADING FIXED (`c56a5c3`, prod-verified) — three defects in six lines
Abbas: "fix the sky shading". Diagnosed by MEASURING before touching: framebuffer pixel
columns + a numeric model of the shader's transfer function.
The band block claimed to "smooth the band edges" and did the OPPOSITE — it smoothstepped
`fract(t*steps)` (which resets at every boundary) then scaled by 0.35, spending the S-curve
in the band INTERIOR and discharging the leftover 0.13 instantly at each edge:
1. **The seam** — a hard 0.13 step per band edge = an isolated **22/255** jump at noon
   (y=132 of 910; everything else ≤6 = JPEG noise) and a visible hard line across dusk.
2. **The h=0 horizon contract was BROKEN** (the bigger one): t(0) = 0.065 → pow = 0.384, so
   the dome sat **38% toward topColor** at the waterline while fog (`fog.color` ← horizonColor)
   and the sea fresnel (`bindSeaSkyColor`, same Color by reference) held pure horizonColor.
   Measured desync at dusk: **43/255 in red**. Only `?sky=smooth` ever honoured it.
3. **The zenith overshot** — t(1) = 1.065, extrapolating past topColor.
FIX: textbook soft-posterize — flat plateau per band, transition centred ON the boundary.
The half-band PHASE is load-bearing: it pins T(k/steps)=k/steps for every k, so T(0)=0 and
T(1)=1 hold **by construction**. `SOFT = 0.25` is where two bounds meet (largest value
leaving half of each band flat; ramp never approaches a pixel, ~5.7° ≈ 100px).
Verified on prod uniforms: desync 43/13/3 → **0/0/0**, zenith 1.065 → **1.000**, worst step
0.13 → **0.00015**, flat fraction **0.50** (the painted bands Abbas A/B-chose survive).
⚠️ **TWO DELIBERATE LOOK CHANGES — tell Abbas, they are consequences of the contract fix:**
the low sky now reaches the TRUE horizonColor (warmer/brighter at dusk), and the plateaus now
sit centred on the OLD edge positions. If placement reads wrong the lever is `uBands` (one
literal at ~GameScene.ts:10148) — **never the phase**, which is what pins the horizon.
5 new locks pin the MATHS (T(0)=0, T(1)=1, continuity, plateau fraction), not just source text.

### ⏭️ NEXT SKY TICKET (found by all 3 proposals independently, deliberately NOT bundled)
**Dome parallax.** `GameScene.ts:~10172` computes `dir = normalize(vWorldPosition + offset)` —
elevation from the WORLD ORIGIN, not the eye. With the camera at r≈108 inside an R=800 dome,
the shader's h=0 ring sits several degrees below the visible sea horizon and the whole
gradient slides as the player climbs the relief. Harmless wash on a smooth sky; on a BANDED
sky the whole ladder creeps up and down with terrain height. Fix is one line
(`normalize(vWorldPosition - cameraPosition)` — three injects cameraPosition into
ShaderMaterial fragment shaders) but it re-registers every band → needs its own screenshot A/B.
Also: `offset` is a **float added to a vec3** (GLSL broadcasts it), so it translates the
sample point diagonally rather than shifting elevation — inert at 0, but a live footgun.

## 🪞 GLB CLONE COLLAPSE + THE FADE'S TRANSPARENCY LEAK (`262f41f`, prod-verified)
The follow-up the lamp work exposed, plus a bigger bug found on the way.
- **114 lamp draws → 2.** `Object3D.clone()` SHARES geometry+materials, so 57 identical
  static clones were 114 draws of the same two buffers. New opt-in `collapseToInstances`
  re-packs the clones AFTER their existing placement logic runs (seating, inherited yaw,
  random spin, overrides untouched), bucketing by geometry+material and writing each mesh's
  final world matrix into an InstancedMesh. Clones detached, NEVER disposed (the instances
  own those buffers; the fade keeps animating them). Prod: 2 fleets × 57, 0 leftover clones,
  every instance within 0.032u of its anchor, day+night screenshots unchanged.
  Guards (all from review — the helper is general, today's caller is not): skinned, nested
  instanced, points/lines, hidden sub-meshes, and a DEGENERATE split (`buckets.size >=
  clones.length`, which happens when prepareClone mints per-clone materials) each leave the
  clones alone; animated models never collapse (mixers bind per clone).
- ⚠️ **THE LEAK — every GLB prop was in the transparent pass, forever.** `prepareClone` sets
  `transparent=true; opacity=0` as the fade's start state and NOTHING restored it, so all
  GLB-replaced props rendered sorted with no early-Z for the whole session. Authored values
  are now snapshotted from the source MODEL (clones share its materials — once a clone
  exists the truth is gone) and restored when the fade lands, via ONE shared
  snapshot/restore pair. **The review caught that my first pass fixed only one of the TWO
  fade loops**: the tree loader had no terminal branch at all, leaving 4 DOUBLE-SIDED
  materials per tree transparent — the worse case on more geometry. Prod: tree materials 4 /
  still-transparent **0**; island-wide only **17 of 484** materials remain transparent
  (water, glass, clouds, pools — the legitimate ones).
- **Two dispose leaks closed:** `GameScene.dispose` hand-rolls the island teardown and never
  calls `Island.dispose()`, so the InstancedMesh release added earlier was DEAD CODE — it
  now lives on the real path (grass, rocks, flowers, both lamp fleets). And the procedural
  tree InstancedMeshes were detached without disposing when GLB trees replaced them.

## 🔦 LAMP FLEET INSTANCED (`46a5bf4`, prod-verified) — AND A BIG DISCOVERY
~57 lamps went from 4 meshes + 3 minted materials each (~228 meshes / ~171 materials /
~114 shadow casters, all toonified into ~171 MORE clones) to **two InstancedMesh**
(pole+arm+shade merged vertex-coloured via the trees' `bakePart`; bulbs share one emissive
material). Anchors keep the contract: `lamp_<i>` name (colliders), poolScale/boulevardRing
(light pools + 2 parity tests), and their matrices ARE the instance matrices.
⚠️ **THE FINDING'S PREMISE WAS WRONG — MEASURE BEFORE BELIEVING A DRAW-COUNT CLAIM.**
`lamp.glb` replaces every lamp at runtime (`loadAndReplace(..., 'lamp')`), so the procedural
geometry was **never drawn in prod**. The real win here is BOOT cost + memory (228 meshes +
171 materials + their toon clones built every load) plus a correct fallback if the model
fails. **The actual draw win is still on the table: the 57 GLB clones are 114 visible
meshes** — collapsing those to instances is worth ~112 draws (queued, own review cycle).
A 4-agent adversarial review of my own diff caught FOUR defects before ship — all fixed:
1. **Instance matrices snapshotted pre-seat** (2 agents, independently): `seatGroupsOnTerrain`
   measures a bbox, and the anchors are EMPTY now → `box.isEmpty()` skipped all 57, so the
   fleet floated at buildLamp's deliberate +0.62 offset. Anchors are seated BY HAND (pole
   base is local y=0 → minY is a known constant) and matrices rewritten from them.
   Verified prod: instances at terrain **−0.051** (= the SINK), matrices match anchors 0.0000.
2. **The fleet was its own placeholder**: `findPlaceholders` matches by name PREFIX and
   `lamp_posts_instanced` starts with `lamp` — the loader hid the fleet, zeroed its shared
   materials and dropped 2 junk GLB clones at the planet core. Renamed `streetlamp_*`,
   prefix tightened to `'lamp_'`, new `onReplaced` hook retires the fallback by flag.
   Verified prod: **57 clones, 0 at core** (was 59/2).
3. **Parenting them into `lamps`** made children 59 vs 57 lampSites, silently killing the
   re-anchor guard that keeps the 3 roaming night lights off the bulbs. On root now; guard
   and loop filter to anchors.
4. **`InstancedMesh.dispose()` never called** — instanceMatrix GPU buffer leaked (also
   covers grass/rocks/flowers).
Accepted deltas: the merged body makes the 0.04u arm a shadow caster it wasn't; `?theme=real`
saturation grade skips vertexColors materials (same as trees).

## ⚡ OPTIMIZATION WAVE (`b55f8ce`→`73f7d5a`, prod-verified 2026-08-17)
Open mandate ("keep optimizing"). A 32-agent, 6-lens, adversarially-verified sweep produced
24 confirmed findings (2 refuted); three tiers shipped, two queued:
- **Governor (`b55f8ce`):** `rungStep()` steps OVER the inert rung 1 on the low tier (no
  composer → no bloomPass) in both directions — a drowning low-tier machine reaches its
  first real lever 4s sooner; a recovering one starts the resolution claw-back 12s sooner.
  Verified live by nulling the pass on the real instance.
- **Round 1 — correctness (`bbe3d94`):** five review defects in the wave-8 quad (cloud
  renderOrder 10/11 → **0.1/0.2** so pills/bubbles paint over clouds; storm opacity
  `min(1, 1.06*wet)` so full rain can actually reach the ≥0.999 depthWrite gate; feed chip
  re-shows as FLEX; emote responsive restore gated on isTouch first; **playerJump() moved
  inside the SFX edge** — held Space no longer bunny-hops silently) + two depthWrite
  leftovers (mailbox glow, race gate rings).
- **Round 2 — per-frame cost (`73f7d5a`):** OrbitCamera ~10 allocs/frame → scratch fields;
  SimplePlayer physics ~12/substep → `_radialScratch`/`_moveScratch`/`_vNormScratch`,
  normal computed ONCE in applyMovement (physics probe re-run: byte-identical); NPC wander
  3 closures/NPC/frame → `pinnedNpcs` Set (maintained at sailor/vendor/campfire sites);
  `getNPCInstances()` returns a readonly view; SimpleUI per-frame writers all skip
  unchanged values (prompt text cache, race null-first + transition-only writes, breath
  dry-session guard, prebuilt vignette gradients, equality-skipped opacities).
- **Rounds 3+4 SHIPPED (`92c002f`, prod-verified):** every per-frame `getWorldPosition()`
  consumer converted to Into with its own scratch (collisions keep a dedicated write-back
  buffer); the three boot-window Firebase touches moved to `idleDefer` slots (1.5s max —
  world beat still lands during the fly-in); `SimpleRenderer.preloadPostProcessing()`
  overlaps the chunk RTT with world-gen (null on low tier — never fetched); visibility-
  guarded paint yields at the 50/60% loading steps; `world_gen` now honestly measures
  through scene-ready (prod: 2374ms total vs 2265ms sync — the delta was silently
  mis-attributed before); `EXTERIOR_LIGHTS_DAY_CUTOFF=0.85` flips all exterior lights out
  of the fragment loop by day (prod at ?hour=12: **1/12 visible**, campfire's own routine
  only; intensity curves untouched so the night look is pinned); lampPool/beam materials
  visible-gated at zero alpha; villagers cull again via object-level spheres inflated 2.5×
  (84 = 28 villagers × 3 parts verified live; pose pop-out fix preserved).
- **QUEUED — `.claude/optimization-queue-2026-08-17.json`:**
  (a) ~~lamp-fleet instancing~~ **SHIPPED `46a5bf4`** — see the section above, and note the
  follow-up it exposed: **collapse the 57 lamp.glb CLONES (114 visible meshes) to instances,
  ~112 draws** — that is the real draw win, needs its own review cycle;
  (b) Materials.create* builder-local caches — a deliberate **WORLD-ROLL**: fewer uuids in
  the seeded window reshuffle placements, so a stale and a fresh bundle build different
  vehicle layouts mid-session while multiplayer addresses vehicles by index. Ask Abbas.
- ⚠️ **NEW STANDING RULE from the lamp work:** before optimizing any prop's draw count,
  check whether `tryLoadModels` replaces it with a GLB — several procedural props are
  BUILT and then hidden at load, so source-level draw counts lie. The GLB replacement
  matches by NAME PREFIX, so any new mesh named like a placeholder becomes one.
- ✅ **Benches + mailboxes collapsed too (`7fc5e3b`, prod-verified):** benches 11 clones /
  22 meshes → **2** draws, mailboxes 6 / 18 → **3**. Worst bench instance 0.04u from its
  anchor (= the -0.03 heightOffset + jitter); benchGroups, colliders and anchor counts
  unchanged. Prod now carries 7 fleets (2 lamp + 2 bench + 3 mailbox).
  Safety checks that made it OK: `benchGroups` is READ-ONLY (distance tests for the sit
  prompt), and `wiggleMailbox` animates `new Mailbox()` groups that live in GameScene,
  unnamed and OUTSIDE `island.mesh` — a different population from the decorative
  `mailbox_<i>` props the GLB replaces.
- ⛔ **TREES ARE DELIBERATELY NOT COLLAPSED** even though they are the biggest number left
  (23 clones / 92 meshes / 4 pairs = **88 draws**): they sway every frame and can be felled,
  so they must stay individual clones. The tree loader does not expose the option and a lock
  pins that. Anything else considered for the collapse must pass the same test: does
  ANYTHING move, animate or hide this prop individually after load?
- **Running total for the GLB collapse work: ~147 draws.** Remaining draw-heavy populations
  measured live (not yet touched, none are cloned GLBs so the helper does not apply):
  `street_network` 401 visible meshes, `flowers` 311, `villager` 164, cars 26 each × 8.
⚠️ Lock-test trap (hit this wave): a comment string CANNOT anchor a slice in a
comment-stripped source lock — indexOf returns -1 and the slice silently covers the whole
file. Anchor on CODE.
**Full session-by-session history:** `.claude/LOCAL-STATE-archive-2026-08-17.md` (this file's
predecessor, 1493 lines) + git log — every entry there maps to a commit with a detailed message.

## Where things stand
The world is **R=100** (`WORLD_ERA r100` — the seeded RNG stream reshuffled, so any specific
placement claim measured before the flip is UNVERIFIED until re-measured). All big audits are
**fully paid down**: quality governor (9 commits, `71bc029`→`881fcf4`), audio control (10/10
findings, `f644426`→`b37f700`), ocean review (deferred list empty), world-law-2 avatar class
(closed by an 8-agent sweep — zero further violations). Onboarding/orientation phases 1+2 +
returning-card trim shipped (`752ac6f`, `17cd5ba`, `b6082b3`). Vercel Web Analytics ENABLED
by Abbas 2026-08-17 — events verified landing wire-level; **history starts 2026-08-17**.

## Last session shipped (2026-08-17): the visual-polish quad (`cff3dbc`→`a904575`)
From Abbas's screenshot report, four commits, one per stream, 14 locks in
`test/visualPolish.test.ts` (comment-stripped, all failed against HEAD), all prod-verified:
1. **Grounding (`cff3dbc`)** — five World-Law-1 violations, one class (slope normal where the
   plumb radial belongs, or `faceObjectToward` handed a different axis than the seat): zone
   halls 10.2°, stationAt 12.3°, parked cars (fitParkedCarSeat's plane-fit quaternion DELETED —
   it only sets seat radius to the lowest wheel contact + 0.06 now), construction blocks,
   benches, islet beach house. Live sweep after: all 0.00°. Remaining >3° kinds are exempt
   (fauna/coins/rivers) or nested glb children with intentional local pitch.
2. **Clouds (`ae48c78`)** — renderOrder 10/11 pins fair-under-storm; depthWrite reconciled to
   `opacity >= 0.999` per frame (both materials); per-blob floor stagger `idx*0.05`; cirrus
   0.26 thick / slabs 0.48 / cluster satellites `2.2+rng()*1.4`. Constants-only — rng draw
   order untouched. Storm tower hidden until `towerGrow > 0.05`.
3. **Slopes (`8b2a165`)** — snap-down window (grounded, vRad≤0.5, gap<0.35u) + landing cancels
   into-surface velocity; uphill cost `1/(1+grade*0.9)` clamp 0.55 gated
   `isGrounded && !swimming` (ungated would cut swim under the 4.0 u/s shoreline current);
   `canJump()` = grounded OR 120ms coyote (cancels fall velocity, burns window); the jump SFX
   gate in main-simple reads the SAME predicate. Live: 0 air frames over 240 downhill at
   grade 0.51 (was +0.67u scalloping), canJump never drops.
4. **HUD (`a904575`)** — ONE chip recipe: module consts `CHIP` (30px, 999px, Inter cascades
   from the overlay) + `CHIP_ICON` (30px circle) in SimpleUI.ts, 38px row pitch. Rows:
   online +12, coin/feed +50, icon row +88 (🔊♿🎨😀📸🎒 at right 10/48/86/124/162/200),
   **Portfolio +126 / Work-with-me +164 (FROZEN — analytics ruling, do not move)**, Say hi
   +202, completion +240. 📸/🎒 demoted to icons; reduced-motion active = INDIGO (green is
   reserved for Work-with-me); FPS debug → bottom-right. ⚠️ `applyResponsiveHud` restores the
   emote chip per-surface (desktop +124, touch +10) — a naive restore stacks 😀 on 🔊.

## OPEN ITEMS (everything still live from all prior waves)
- **Peers (gaps, not bugs):** no SEATED byte (a peer on a bench reads standing), no ride sway,
  no boat/jetski pose split. Adding a byte value is a WIRE CHANGE old clients read as
  "airborne" — needs design, not a constant.
- ~~Land-side depth-writing transparents (ambient_sparkles/dust)~~ **ALREADY FIXED in a prior
  session** — both materials carry `depthWrite: false` with measured-impact comments
  (Island.ts ~3125/~3772). This entry was stale; verified 2026-08-17.
- ~~Governor: low tier burns cooldowns on inert rung 1~~ **FIXED 2026-08-17** — `rungStep()`
  skips rung 1 in both directions when bloomPass is absent (engage 0→2, release 2→0).
- **Clouds, optional:** occupancy-snap opacity — only if the weather crossfade still reads
  muddy live after this pass.
- **Analytics watch (dashboard only — the query API is plan-gated and 404s):** welcome_cta mix
  will shift BY DESIGN (recruit ↑, meet_ai/tour/race ↓ — annotate when reading); watch
  contact/portfolio taps ~a week to decide promoting Work-with-me back to touch tier 1
  (3-line revert in createContactCTA). Names: welcome_cta (by cta), compass_pill_tap,
  journal_opened, island_map_opened, npc_chat_sent, lead_submitted.
- **Deferred-unless-needed (perf):** animal instancing (next lever if needed), terrain LOD,
  governor vertex-rung. Grass "fatter tuft" trade (~10% vertex win, changes an A/B-picked
  look) is ABBAS'S CALL.
- **Deliberate non-fixes:** shadow.bias stays put (raising it trades crawl for peter-panning);
  CelLook's cel shadow patch is disarmed on r165+ and now WARNS — restoring the crisp cel
  edge means patching `shadow` before the shadowIntensity mix, a look decision.
- **Dead-but-harmless:** TownPlanner.ts / House.ts (never instantiated),
  ZONE_BUILDING_COLLIDER_RADIUS.

## PROBE TRAPS (each cost a wrong reading at least once — read before measuring)
- **`git stash pop` on this Windows checkout rewrites working files LF→CRLF**, breaking every
  literal-`\n` anchor in the source-lock suites. After any stash cycle: `sed -i 's/\r$//'`
  the touched files. visualPolish's `src()` strips `\r` itself; older suites do NOT.
- **Fail-against-HEAD proofs: stash the FIX FILES ONLY** — sweeping the test file too proves
  nothing.
- **Source locks must strip comments** (`/\*…\*/` + `//…`) or they match their own prose.
- **The automation browser tab is ~1fps and non-compositing**: screenshots fail, rAF is
  sparse, the governor sheds legitimately. Drive physics SYNCHRONOUSLY instead:
  `window.__app` is the debug handle; `player.setMovementVector(dir); player.update(1/60)`
  in a loop. Standing height above terrain is 0.7 (playerHeight); the player walks the
  RAYCAST mesh, not `analyticSurface` — measure "airborne" via `player.isOnGround()`.
- **My prod-verification tabs are LIVE PLAYERS on the island** — don't idle on prod.
- **Check `isMuted()` BEFORE interpreting any audio-lifecycle probe** (a persisted mute makes
  every refusal correct behaviour).
- **Never remove a modal's DOM manually** — it WEDGES PanelManager (next open swept). Close
  through the panel's own paths or reload.
- **Toasts complete show+fade fast** — inspect `ui.toastEl.textContent`, don't regex body
  text on a timer. **Chat typewriter runs ~60ms/char** — measure it before timing assertions.
- **`updateSunShadow` self-feeds if probed repeatedly** — restore
  `sun.position = trueSunDir * 60` before EACH call.
- **Boot timings: compare prod-to-prod** (dev+HMR reads ~2× slower); **first-seconds FPS is
  shader compilation** — measure twice, discard the first.
- **Headless tests: always pass `this.radius` inside Island** — module-default `areaScale()`
  builds the WRONG world.
- **Grass Phase-A `Math.random()` order is a WIRE PROTOCOL** (multiplayer vehicle placement) —
  write-site changes only.
- **Presence `t` is sender-clock** — freshness windows must be generous (30s).
- **Bash cwd sometimes resets to `C:\`** — `cd /c/claudeSessions/githubCLONES/portfolio-island`
  first or vitest/npm fail confusingly.

## STANDING LAWS (short form — full text in CLAUDE.md, history in the archive)
- **World law 1:** things that stand take the RADIAL up (`position.clone().normalize()`);
  `faceObjectToward` premultiplies about the axis you hand it — pass the SAME plumb axis.
- **World law 2:** GLB limb bones rest at ~±π; anchor HELD poses to the rest, never lerp from
  a live rotation.x near ±π; `rotation.set(0,0,0)` is fine (mixer rewrites same frame).
- **RNG stream law:** CloudFormations' (and all seeded builders') rng draw order/count is
  load-bearing — retunes must be constants-only.
- **`instanceColor` MULTIPLIES `vertexColor`** — if merged-vertex-colour assets are ever
  instanced, leave instanceColor null/white.
- **Reach radii scale with the world** (fractions of R); absolute sizes don't. Write spacing
  as `island.arc(metres)` — `test/radiusUnits.test.ts` fails bare literals.

## Pipeline (per fix)
measure → (workflow review for anything substantive — ultracode is ON) → implement →
lock tests with fail-against-HEAD proof → `npm run check` + `npx vitest run` →
live-verify on dev (synchronous probes) → commit per stream → `npx vercel --prod --yes` →
`git push` → prod verify → update THIS file.

## Next step
No task in flight. Wave 8's remaining backlog is whatever Abbas queues next; the open items
above are the standing menu. On arrival: read this file, acknowledge in ≤20 words, wait.
