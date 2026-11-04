# UX probes

In-repo acceptance probes for the Life Island UX plan. Each probe boots the
production build in headless Chromium, measures one behaviour, checks it
against the item's acceptance, and writes JSON (and PNGs) to `--out`. The
perf gate (`tools/perf-gate.cjs`) uses the same harness.

These are local tools. CI does not run them, and they import no repo code.

## Run

```sh
npm run build
npm run probe -- <name> --dist dist --port <n> [options]
npm run probe -- list
```

| Option | Meaning |
|---|---|
| `--dist <dir> --port <n>` | Serve `<dir>` with `vite preview --strictPort`. The child is killed by PID on exit and on Ctrl+C. A busy port is an error, never reused. |
| `--base <url>` | Attach to a preview that is already running instead. |
| `--profile desktop\|phone\|lowtier` | Run one profile instead of the probe's defaults. |
| `--out <dir>` | Output folder (default `<os tmpdir>/ux-probes/<name>`). |
| `--compare <dir> --compare-port <m>` | A second build, for `rig` and `strafe`. |
| `--no-khr` | `getExtension('KHR_parallel_shader_compile')` returns null (`hitch`). |
| `--golden <path>` | The seed golden (`seed`, and the perf gate's `--seed`). Default: `test/golden/seedDraws.json` in the checkout that holds `--dist`, else in the current directory; never this tool's own checkout. `--bless` writes there. |
| `--selftest-leak` | The harness answers one blocked-host URL itself (a synthetic 200 from `route.fulfill`, so nothing leaves the machine) and the page fetches it after boot. That response is a leak by the rule, so the run must exit 2. |
| `--double` | `guide`: inject a stand-in for A6's card that follows the guide's contract (see Stage-2 probes). |
| `--url <url>`, `--device desk\|phone` | The phase-2 probes' spellings of `--base` and `--profile`; both work everywhere. |

Phase-2 probes live in `p2/` and run by their path, `npm run probe -- p2/walkin --dist dist --port <n>`.
They write to `tools/ux-probes/out/p2/<name>/` (git-ignored) unless `--out` is given.

Ports are always arguments. Suggested ranges, so parallel builders do not
collide: E 5190-5199, A 5200-5209, B 5210-5219, D 5220-5229, C 5230-5239.

Exit codes: `0` pass, `1` criterion fail (including a hook the plan's
contracts promise going missing), `2` fail-closed (a request got past the
harness), `3` inconclusive (setup error, probe crash, no boot signUp
intercept, or a check that could not be made, such as an overlay whose
opener is missing). On 58c8849 every stage-1 probe exits 1 (it has the bugs
the stage-1 items fix) except `axe`, which passes, and `rig`, a regression
guard that exits 0 unless `--compare` finds a difference.

## Lock census and `tools/owners.json`

`tools/owners.json` is the one ownership table: every package's code and
tests (plan-r3's ownsFiles and testOwnership plus the stage-2
reassignments), the unowned code nobody edits, and the contract-check
allow-list (the claims scans, securityHeaders 62-91, databaseRules 163-174,
livingNpcs 36-43, radiusUnits, serverModeration 322-329, islandRadius
189-212, the Island and Districts imports of amenities, tierParity,
buildPlots and gameSceneSeed, and the isLowTierDevice mocks). It is written
through prettier.

```sh
npm run probe -- lock-census --owner B     # B's pending moves; exit 1 while any remain
npm run probe -- lock-census               # every package, plus "every test has an owner"
```

A read is a literal `readFileSync` path (or one through a reader helper); an
import is a static, dynamic, `require()` or `vi.mock()` import of a repo
module, attributed to the tests that use its bindings. `import type` and
`test/helpers/*` are skipped. From stage 2 on, a B or D test that reads C's
code is a pending move to C (`--stage 1` keeps stage 1's "loosen in place"
label), and any other cross-package read outside the allow-list is a
pending move to the code's owner. This replaces plan-r3's
`tools/lockmap.mjs`, which is not built.

### Running before E's stage-1 PR merges

Check E's branch out in a separate worktree, run `npm ci` there, then point
its runner at your own build:

```sh
node <e-worktree>/tools/ux-probes/run.cjs <name> --dist <your dist> --port <n>
```

`playwright-core` 1.58.2 and `axe-core` 4.10.3 are exact devDependencies.
playwright-core 1.58.2 pins Chromium revision 1208, so the cached
`%LOCALAPPDATA%\ms-playwright\chromium-1208` is reused with no
`executablePath` (`PLAYWRIGHT_BROWSERS_PATH` overrides the cache; if it is
missing, `npx playwright-core install chromium` fetches the same build).
GL is hardware ANGLE D3D11 on Windows; `PERF_GL=swiftshader` or raw flags
override it.

## Safety

The harness (`lib.cjs`) is the audit's read-only net:

- every non-GET request is aborted, wherever it is going;
- Firebase (RTDB, Auth, App Check, Firestore, installations), Cloud
  Functions and `*.run.app`, ElevenLabs, reCAPTCHA, Google analytics and
  auth hosts and Vercel insights are blocked, GET included;
- WebSockets are stubbed before any page script, and `routeWebSocket`
  closes anything that still tries;
- service workers are blocked, every context starts with fresh storage,
  and every boot carries `?owner=1`.

Every interception goes through one pure rule, `classify({url, method,
resourceType, isWebSocket})`, which returns `allow`, `abort-nonget`,
`block-host` or `close-ws`; `test/probeSafety.test.ts` pins its table and
the exit codes. The blocked hosts are Firebase (RTDB, Auth, App Check
including `content-firebaseappcheck`, Firestore, installations), Functions
and `*.run.app`, identitytoolkit, securetoken, ElevenLabs, reCAPTCHA, Vercel
insights, the Google analytics and auth hosts, and the weather lookups
(`open-meteo`, `ipapi`, `bigdatacloud`) EnvironmentCycle makes with consent.

A run fails closed (exit 2) only when something gets past (`leakReason()`):
a response from a blocked host, a `route.continue()` to one, or a non-GET
reaching the network. Every intercepted attempt is logged with method and
host (`net` in the JSON), and a run counts only if that log shows a boot
proof intercepted: the `POST identitytoolkit.googleapis.com …signUp`, or,
on a build with App Check (production, `--base https://…`), the
`POST content-firebaseappcheck.googleapis.com …:exchange…` that gates the
sign-up. Without either the run is inconclusive (exit 3).

## Independence from the behaviour the plan changes

- Camera turns use `__app.scene.getOrbitCamera().setYaw()` when that moves
  the view. On main `setYaw` writes a field nothing reads, so the probes
  rotate the orbit's follow direction instead (`compass.cjs` detects which).
- Look reads `html[data-look-mode]`: `drag` gets trusted press-and-drag
  through CDP; absent gets main's click-to-lock, driven as the controls
  audit did (the input manager's lock flag plus one `movementX` per frame),
  so per-frame pacing is exact. Yaw comes from `getYawTarget()` when A4
  adds it, else from the follow direction.
- Touch swipes are TouchEvents dispatched once per animation frame from
  inside rAF (exact pacing) in a `hasTouch` phone context; the fling-off
  runs set `__dsFx.lookFling = false` before any page script.
- Panels come from `__app.ui.panels.current()`; the welcome card is found by
  `[role=dialog][aria-label="Welcome to DigiScalability Life Island"]`.
- Compass targets are set explicitly through `__app.mapGuideTarget`. The
  follow probe counts label flips only while that explicit target is
  active (main-simple clears it within 6 u by design).
- An item that changes an input updates its probe through these DOM hooks
  in the same PR.

## Probe-hook contract

The probes read and drive the app only through these hooks. An item that
renames or removes one updates every probe that uses it in the same PR, or
the probe exits 1 with `hook missing`. Owners are the packages whose code
holds the hook.

| Hook | Owner | Used by |
|---|---|---|
| `window.__app` (the SimpleApp instance) | A | every probe |
| `__app.ui.panels.current()`, `.isOpen(id)`, `.stack`, `.closeTop()`, `.closeAll()` | D | every probe that reads panel state |
| `__app.scene.getOrbitCamera()`: `getYaw()`, `getYawTarget()`, `setYaw(rad)`, `getDistance()`, `setDistance(u)`, `followDir`, `pitch`, `pitchTarget`, `distance`, `distanceTarget`, `minPitch`, `snapToPlayer()`, `getForwardDirection()`. `lookInDirection` no longer exists. `setDistance` clamps at `minDistance` (2 u), so a probe that forces a closer camera (camera.cjs's 0.8 u) writes `minDistance` directly first | A | compass, look, perf gate, guide, p2/journey |
| `__app.scene.getPlayer()` / `.player`: `setWorldPosition(v)`, `getWorldPosition()` | B | most probes |
| `__app.renderer` (SimpleRenderer): `getRenderer().info`, `renderCallback`, `stopRenderLoop()`, `startRenderLoop(scene, camera, cb)`, `render()`, `composer`, `governorArmed` | E | hitch, perf gate, p2/L.cjs, census |
| `window.__lifeIslandReady`, `window.__dsSeedDraws` | A, B | every boot; seed |
| `#loading-screen`, `#ld-bar`, `#ld-msg`, `#ld-pct`, `#boot-fallback` | D | fm, loader marks |
| the welcome dialog `[role=dialog][aria-label="Welcome to DigiScalability Life Island"]` and its buttons `data-dismiss`, `data-cta="projects"\|"contact"`, `data-tour`, `data-meet-ai`, `data-race` | D | every probe; fm, keyboard, guide |
| `.hud-btn[aria-label="Open portfolio menu"]`, `[aria-label="Open island menu"]`, `button[data-section]`, `button[data-board]`, `button[data-hire-tour]` | D | keyboard, phone, breakpoints, fm |
| `__app.ui` surfaces: `compassDiv`, `compassArrow`, `compassLabel`, `toastEl`, `flashEl`, `interactionDiv`, `fadeDiv`, `leaveBtn`, `pinDiv`, `zonePanelDiv`, `npcChatDiv`, `isWelcomeVisible()`, `isDialogueActive()`, `showZonePanel`, `showCompletionModal()`, `showJournal()`, `showPassport()`, `getJoystick()` | D | fm, events, guide, p2 probes |
| the touch joystick (the 166 px hit square, 44 px thumb) and the 74 px USE / JUMP / WAVE discs; `[data-guide=joystick]` and `[data-guide=use-button]` win once D6 lands | D | p2/walkin, guide, phone |
| `__app.mapGuideTarget`, `mapGuideLabel`, `lastCompassTarget`, `exitBuilding(isZone)`, `insideIsZone`, `isletUnlocked`, `enterBuilding(id, isZone)`, `passport.count()`, `passport.has(id)` | A | compass, p2 probes, p2/journey |
| `__app.scene`: `getZonesManager().getZones()`/`getZoneById()`, `coins`, `hasTrailCoins()`, `getCoinsCollected()`, `getNpcPosition(name)`, `getNearbyInteractable()`, `getIsland()` (`npcTargets`, `houseDoors`, `surfaceMesh`, `sampleSurfaceByDirection`, `seaLevel`), `warmInterior()`, `interiorWarmed`, `interiorNearDoorWarmed`, `onHouseEnterCb(id)`, `interactWithZone(zone)` | B, C | p2 probes, guide, census |
| phase 2: `__app.scene.isInsideInterior()`, `getInteriorHotspot()`, `INTERIOR_ORIGIN`, `INTERIOR_HOTSPOTS`, `INTERIOR_DOOR_HOTSPOT`, `INTERIOR_PLAYER_R`, `interiorSets`, `interiorActiveTheme`, `interiorColliders`, `interiorWallBlocked(x,z)`, `interiorFurnitureBlocked(x,z)`, `interiorPosters`, `interiorYaw`, `setInteriorMove()`, `toggleInteriorFixture(id)`, `partyMode` | B | p2/room-lib, survey, party, passport-interior |
| phase 2: `__app.scene.getEnvironmentCycle()`: `getHour()`, `getDayFactor()`, `.debugHour` (written by duskflip) | C | p2/duskflip, p2/bootcost, p2/L.cjs |
| phase 2: `__app.scene.boardVehicle(i)`, `vehicleKind(i)`, `isRidingVehicle()` | B | strafe, perf gate (P2-E3) |
| phase 2: p2/L.cjs's mask material swap, keyed on `SkyDome`, `userData.isPavement`, `userData.isCelHull`, `island.surfaceMesh` and `island.npcTargets` | B, C | p2/L.cjs (and the lighting probes in later waves) |
| stage 2: `#ds-guide` (`data-active`, its Skip button and resume chip), window events `ds:intro`, `ds:modal`, `ds:guide`, `ds:guide-to`, `ds:goals`, `ds:npc-speaking`, `ds:npc-typing`, `ds:coin`, `ds:settings`; `[data-guide=*]` anchors and `[data-hud=prompt]` | A, D | guide, events, fm |

The probes write only through the same hooks (a teleport, a camera pose, a
clock hour, a panel close), and only inside their own browser context.

## Probes and the items they serve

| Probe | Item | What it measures | Main baseline (this rig) |
|---|---|---|---|
| `arrow` | A1 | 24 off-axis bearings (the audit's set): arrow side vs target side, mean \|error\| | 0/24 same side; unwrapped mean error 148.8° (audit 148.1°) |
| `follow` | A1 | keyboard follower steering by the arrow toward the Projects zone: W ahead, W + the side key to a side and behind, or J/L behind with `--turn jl` (see the note below); distance at 25 s, label flips | walks away, 103 → 208 m; `--mirror` (self-test) arrives in 19.3 s; `--turn jl` stands at 103 m (main has no J/L) |
| `clash` | A2 | Ctrl/Meta+C with the email selected; ↓ and W behind Projects; M, C, P in a panel; E at a bench behind a panel; Space on a panel button; ← on the volume slider; sendThenWalk | Ctrl+C → `customize`; ↓ walks 8.4 u; P takes a photo; E seats; slider walks 4.5 u |
| `cardkeys` | A2 | C, P, M and E on a fresh card, then Explore; panel 0.9 s later and `ds_welcomed` | C replaces the card; `ds_welcomed=1`; the island map is open |
| `sheet-lock` | A3 | a world click beside the open Portfolio menu, then its Projects row | the click locks the pointer; the row does nothing |
| `look` | A3, A4 | drag and locked look at 1/5/30/60/120 frames; hover; peer tap; right-drag; `ds_mouse_lock`; touch swipes (fling off/on); J L I K R; ~30 fps | 300 px over 30 frames 3.5-3.6° at 13 ms frames (audit 3.8° at 14.6 ms); swipe 150 px: 21.2/5.4/2.7/1.8° |
| `strafe` | A5 | D held after a walk: heading and camera °/s; reduced motion; walk-away settle; fixed-pose camera frames (`--compare`) | heading 143°/s, camera 143°/s, reduced motion 143°/s |
| `legspin` | B1 | first-visit standing jump on the frozen sim (1/60 s); legs vs π; mixer rewrites; landing hand jumps | legL −11.7 rad after landing and after 10 s idle; legs rewritten 0/300; the landing-hand check already passes on main (≈0.12 u), see the note below |
| `rig` | B1 | sit, ride and swim bone positions in the player's frame; `--compare` gives max \|Δ\| | exits 0 on main; main vs main: 0 |
| `hitch` | B2 | 5-25 s after ready, idle on the card and walking: frames, LoAF, programs per render() and per compile, the warm, the first door entry | a 1.9-2.2 s frame gaining 93 programs; see the note below |
| `seed` | B0 | `window.__dsSeedDraws` fresh, `ds_arrived='1'`, three reloads, low tier, vs the subject's `test/golden/seedDraws.json` (see `--golden`); `--bless` writes B0's flat shape, `{ "marks", "total" }` (only when every desktop run agrees; a low-tier difference is noted, not written). A `{ "desktop", "lowtier" }` file is also read | counter absent |
| `guide-me` | D1 | Leaderboard → Guide me: panels, scrim, chip opacity, touch controls | stack `['leaderboard']`, scrim up, controls hidden |
| `back` | D2 | the eight history cases; case 7 runs on desktop (welcome card, emote wheel, chat input, tour) and on the phone, where the touch-only ☰ drawer exists; each overlay must really open, or the check is inconclusive | Back from Projects lands on `about:blank` |
| `contrast` | D3 | filled-button labels at `?hour=6/12/18/21` on 1440 and 390, touch captions over grass/sand/sky, the focus ring | Work with me 2.97:1, Explore 2.97:1, Send 3.17:1, USE 3.16:1 over grass |
| `axe` | D3, D4, D8 | axe-core 4.10.3 on the welcome card, HUD, hire card, Projects and NPC chat | 0 color-contrast violations (gradients land in `incomplete`, which is why `contrast` samples pixels) |
| `lock-census` | CO-E1 (stage 1: EL, AL, BL, DL) | every literal source read and repo-module import in `test/*.test.ts`, its owners from `tools/owners.json`, and its rule; `--owner <pkg>` lists that package's pending moves and exits 1 while any remain (static, no browser; `--ref <git ref>`, `--stage 1`) | on s1-int (= main d5e0e96): `--owner B` 21 reads of C's code, `--owner D` 4 reads plus frontDoorPolish's CelLook import, `--owner C` celInk's GameScene import, A and E clean. After wave 1 merges every `--owner` run is clean |

**Follower.** The follower holds W while the arrow is within 25° of
screen-up, and W plus the side key out to 120°. Behind that it holds the
same diagonal by default (`--turn wasd`): the camera swings behind the
motion, so the walk curves round. `--turn jl` turns the view with J or L
alone instead (A4's keyboard look). The audit's follower pressed A or D
alone there, which arrived only because main's camera spun with a strafe,
the bug A5 removes: on A's branch it sidesteps with the target pinned at
±180° (closest 102.8 m in 25 s). On A's a2f882a the default arrives in
20.1 s (two runs) and `--turn jl` in 19.8 and 20.4 s. `heldSeconds` in the
JSON is the time spent on each key set.

**Hitch note.** On main the warm's frame-to-frame program jump is the
audit's 93, but it is split: `warmInterior`'s `compileAsync` adds 55
programs inside the compile call and the next render adds 38 (44 when
walking). The probe reports both (`maxProgramsAddedInOneFrame` and
`renderCallsWithNewPrograms`), because B2's criterion is per render().

**Frame-rate dependence.** Main's look and leg-spin numbers scale with frame
time (that is the bug). `look` reports `meanFrameMs` with every reading, and
`legspin` runs on the frozen sim so its airborne frame count is fixed.

**Landing hand.** `legspin`'s per-landing-frame hand displacement is
already ≈0.12 u on main's frozen 1/60 s sim, inside its bound, so it does
not reproduce MOT-01's hand pop and cannot show B1's fix. The leg checks
(legL ≈ −11.7 rad, the 0/300 rewrites) are the ones that fail on main.

### Stage-2 probes, wave 1 (E6a)

Baselines on this rig (RTX 5070, Ryzen 7 7700), 2026-11-04: s1-main is
58c8849's dist (`main-FxtHGAB1.js`), s1-int is main d5e0e96 (tree-identical
to ux/s1-integration 16a7af9). Every row exits 1 on both builds: they have
none of wave 1's fixes yet.

| Probe | Item | What it measures | 58c8849 | s1-int |
|---|---|---|---|---|
| `guide` | A6, B10 | First steps at 1440x900, 390x844, 844x390 and 667x375: each step done within 1 s of its action (walk W or the stick; look by drag or swipe; talk to the named villager, E or USE; the Portfolio menu; the map by M or a compass tap), Explore to the finale (<= 60 s), the reload at 3/5, the 20 s chip, Skip, getAnimations() inside `#ds-guide` under reduced motion, the card against the joystick / action column / prompt / edges, the finale's 'Show me' label (Projects at 1440 and 844, School at 390 and 667), legacy storage, hint toasts while active; B10's trail end | 'guide card present' fails at all four sizes; legacy fails; the trail's last coin is 1.53 u from the Mayor, whose prompt says "ask anything" (B10 passes) | the same |
| `fm` | A8, D6, D9 | `d-idle`, `m-idle` (the 'Lost?' hint by +35 s with the guide skipped; cardGeo: visible words, buttons, the world showing through the card), `d-active`, `m-active` (a flash and a toast together; the toast against the prompt at 390), `d-tour` (the full and recruiter tours) | 'Lost?' at +58.5 s on the phone and not at all in one desktop run (a villager's prompt came first; the audit saw +54-59 s); 124/128 words, 7 buttons, world through the card max channel 14; d-active one flash+toast overlap; m-active the 195 px prompt under a toast; full tour 54.8 s; the hire card's tour button below the fold | 'Lost?' at +58.3 s desktop, none in 106 s on the phone (a villager first); 126/128 words, 7 buttons, max channel 14; d-active clean in 857 samples, m-active a flash with a toast; full tour 53.4 s |
| `events` | A8, P2-A5, D4 | `ds:*` window events (EVENTS_INIT, for any probe): one `ds:intro` start then settled per load (desktop, phone, reduced motion, `?zone=projects`), `ds:guide-to` {key:'school'} sets the label to School within 1 frame, closing the hire card dispatches `ds:modal` {open:false, id:'zone', zone:'hire'}; a recorder self-check | no ds:intro, no guide-to handling, no ds:modal (recorder self-check passes) | the same |
| `keyboard` | D4 | Tab x10 on the welcome card, Space and Enter on a fresh card, Enter on the Portfolio pill (focus on the first row, no aria-modal), a zone panel taking focus, ArrowDown x5 and PageDown scrolling it, Escape back to the pill, the phone drawer open for 20 s under keyboard focus | focus escapes the card; Space and Enter close it into Projects; focus stays on the pill; the panel leaves focus on BODY and does not scroll; the drawer closes after ~6 s | the same |
| `phone` | D4 | tap targets under 44 px on the welcome card, HUD, drawer, menu, hire card, the four districts, the emote wheel and the NPC chat | welcome 2, HUD 1, drawer 0, menu 6, hire 4, Professional 6, Projects 2, Personal 5, Contact 12, emote 8, NPC chat 4 | the same counts |
| `breakpoints` | D5, P2-D5 | 768x1024, 1024x768, 844x390, 667x375 and 1440x900: the hire card's LinkedIn, CV and Code in view without scrolling, the tour button at 1440, overflow, overlaps, small targets | 844x390: LinkedIn, CV and Code all below the fold; 1440: links in view, the tour button not | the same |
| `census` | C3 | lit opaque materials that are not MeshToon in the zone halls, trees, villagers and props; MeshToon without the shared ramp; programs 12 s after the card (`--compare` against main, one load, ±4); the DOM style census | not toon: zone halls 109, props 43, villagers 6, trees 4 (player 9 and interiors 66 reported only); 28 toon materials without a ramp; programs 215 desktop / 117 phone | the same materials; programs 160 / 101 |

`--double` (guide only) injects a stand-in for A6's card that follows the
contract, to test the probe before A6 exists. Its checks say '(double)' and
prove nothing about the product. On s1-int: every step, the reload at 3/5, the chip, the finale (24-33 s from
Explore), 'Show me' (Projects at 1440 and 844, School at 390 and 667), the
card against the joystick, the action column, the prompt and the edges,
Skip, reduced motion, legacy storage and B10 read as designed at all four
sizes (51 of 55 checks). The four that fail are the product's: hint toasts
show while the card is up at every size (the gold arrow, the villager who
talks through Claude Haiku 4.5, 'Coins!'), because s1-int has no D6, and
the double does not stand in for D6.

## Perf gate

`npm run perf:gate` (`tools/perf-gate.cjs`, item E1) runs on the same
harness. The world clock is pinned to `?hour=12` (night lights change the
light count, the programs and the draws); `--hour live` turns that off.

```sh
npm run perf:gate -- --dist dist --port <n>            # baseline report + counter and µs budget checks
npm run perf:gate -- --dist dist --port <n> --fx <name>  # one __dsFx effect: draws and programs per view, then 6 x 1.5 s per side
npm run perf:gate -- --ab <mainDist> <branchDist> --ports <a>,<b> --cycles 6
```

- Profiles: desktop 1440x900, the 1x low tier, and startup-only at 4x CPU
  (GPU timer queries off).
- Each load: the startup marks, then 30 s after the card (past the interior
  warm and the late compiles) programs, nodes and textures, then the views:
  idle spawn, hub-wide and the Projects district, posed with the design
  audit's framing (follow direction, pitch, distance, teleport). Counters
  are one whole frame with the loop paused (draws, triangles, programs,
  textures); timings are 1.5 s windows (CPU per app frame, GPU timer
  queries, fps). `programs after the views` is judged too.
- Programs are logged per render() and per outermost compile call (a
  compileAsync's inner compile() is not counted twice); µs per effect come
  from `FxBudget.ts` (`__dsFx.stats`), divided by the frames the gate saw.
- Verdict per metric: delta is the median of the paired (B − A) cycle
  differences, and sigma is the 95% band of delta,
  t(0.975, n−1) × 1.2533 × SD(B − A) / √n, so it pools both sides' noise
  and the ABAB pairing cancels drift. Valid when sigma <= threshold/2; pass
  when valid and delta <= threshold; fail when valid and
  delta > threshold + sigma; anything else is inconclusive, escalating to
  12, then 24 cycles. An invalid result never fails. The plan's single
  split, |median(A_odd) − median(A_even)|, is reported as `sigmaSplitA`
  and decides nothing: one 3-vs-3 split routinely understates the spread.
  Exits 0 pass, 1 budget fail, 2 fail-closed, 3 inconclusive.
- A/A (`--ab dist dist`): the JSON's `aa` block lists the exact counters
  (texture MB; equal on every load, or the run fails), every |delta| over
  its threshold, and whether any profile failed.
- `hostBusyPct`: the whole machine's CPU busy share during each load. Other
  sessions' builds and probes widen sigma; an idle machine gives the
  tightest verdicts.
- `--fx <name>`: the effect starts off before any page script. 30 s after
  the card each view is posed and measured with four off/on pairs, the live
  loop stopped inside each pair so nothing moves between its sides (per
  side: the switch, then two app frames of 1/240 s; draws and triangles
  are their mean, programs the on sides add are the effect's). Then
  6 × 1.5 s per side of timing at the spawn. On main, `--fx __unused`
  reads 0/0/0 draws and 0 programs on both tiers.
- `--seed`: `__dsSeedDraws` against the subject's golden (see `--golden`).
- Output: `perf-gate-<mode>.json` and `ledger.md` in `--out`: one row per
  registered effect (tier default, switch, µs/frame); `--fx <name>` fills
  its row's draws per view and programs.

**What is not exact on main.** Per-view draws vary from load to load:
villagers, cats, ground birds, herons, birds, clouds and cars move through
every view. Two sets of static props also land somewhere different on every
load, though the camera and player poses are identical:
- the 8 `rock.glb` rocks: `GameScene.placeAssets` places them with
  `Math.random()` after an `await`, so whatever drew from it first moves them;
- the `tree.glb` clones, placed by Island's async loader.

Programs ride a boot race: whether the GLB materials
(Seat, Post, Pole, Trunk, Stone, Leg, LeafL, LeafD) compile in the screen
pass, the composer's linear pass, or both depends on when each model
finishes loading (desktop 211-216 programs; in a 96-load A/A the
215-program loads showed the card ~0.6 s later on the median, so
welcome_visible is bimodal too). These counters are judged by the sigma
rule; only the texture MB is exact.

**A/A on main.** `--ab dist dist --cycles 6`, run 2026-11-04 on the audit
rig with the host about 16% busy:
- Startup passes after 6 cycles.
- Desktop and the low tier stay inconclusive after 24 cycles. Nothing fails.
- Texture MB is 18.1 on all 96 loads.

What keeps the two profiles inconclusive (sigma against threshold/2):

| Profile | Metric | sigma | threshold/2 |
|---|---|---|---|
| desktop | CPU p50 | 0.50–0.90 ms | 0.5 |
| desktop | CPU p95 | 1.00–1.06 ms | 0.75 |
| desktop | welcome_visible (bimodal) | 198 ms | 50 |
| desktop | world_gen | 25.8 ms | 25 |
| desktop | long tasks | 1.08 | 0.5 |
| desktop | Projects draws | 8.7 | 0 |
| low tier | CPU p50 (spawn, hub; Projects passes) | 0.26–0.33 ms | 0.25 |
| low tier | CPU p95 | 0.42–0.56 ms | 0.4 |

Desktop Projects draws have a threshold of 0, so they are valid only when
exact. On main they are not, and their |Δ| = 1 is the one A/A delta over
its threshold. Desktop `--ab` therefore tops out at inconclusive:
- Projects draws need a tolerance from the plan owner, or seeded GLB
  placements;
- welcome_visible needs the boot race gone;
- the CPU p95 and long-task budgets sit below this rig's noise.

## Files

- `lib.cjs` the shared harness: serving, launch, safety, profiles, boot,
  in-page helpers, the virtual clock, numbers and contrast maths.
- `run.cjs` the CLI.
- `compass.cjs` (arrow, follow), `keys.cjs` (clash, cardkeys, sheet-lock),
  `look.cjs` (look, strafe), `rig.cjs` (legspin, rig), `frames.cjs`
  (hitch, seed), `panels.cjs` (guide-me, back), `a11y.cjs` (contrast, axe).
- Stage 2, wave 1: `events.cjs` (events, and `EVENTS_INIT` / `eventsOf`
  for any probe), `guide.cjs`, `fm.cjs`, `keyboard.cjs`, `phone.cjs`
  (and the shared `UX_HELPERS`), `breakpoints.cjs`, `census.cjs`.
  `lib.cjs` adds the `landscape` (844x390), `landscape667`, `tablet` and
  `desktop1024` profiles, `touch(session)` (trusted CDP touches: tap, drag,
  the joystick, the USE disc) and `__h.compassFull()` (the pill's full
  label; under 480 px the pill shows only its icon).
- `lock-census.cjs` the static census over `tools/owners.json`.
- `../owners.json` the ownership table and the contract-check allow-list.
- `test/probeSafety.test.ts` pins `classify()`, `leakReason()`, the boot
  proof and the exit codes; `test/helpers/astSlice.ts` (with
  `test/astSlice.test.ts`) is the shared read-only AST slicer for stage-2
  locks: `methodBody(file, 'Class.method')`, `functionBody(file, name)`,
  `statementAt(file, marker, { within, kind: 'if', nth })`.
