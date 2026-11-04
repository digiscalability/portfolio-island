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
| `--no-khr` | `getExtension('KHR_parallel_shader_compile')` returns null (`hitch`: runs desktop, low tier and phone, adds the pause-near-door entry, and judges the black interval by pixels). |
| `--pause-near-door` | `hitch`: a second first door on a fresh page, entered after standing 3 s within 3 u of it. |
| `--reduced-motion` | `follow`: a browser context that prefers reduced motion. |
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
| `__app.scene`: `getZonesManager().getZones()`/`getZoneById()`, `coins`, `hasTrailCoins()`, `getCoinsCollected()`, `getNpcPosition(name)`, `getNearbyInteractable()`, `getIsland()` (`npcTargets`, `houseDoors`, `surfaceMesh`, `sampleSurfaceByDirection`, `seaLevel`), `warmInterior()`, `interiorWarmed`, `interiorNearDoorWarmed`, `onHouseEnterCb(id)`, `interactWithZone(zone)`, `schoolPos()` (guide's `--double`) | B, C | p2 probes, guide, census |
| phase 2: `__app.scene.isInsideInterior()`, `getInteriorHotspot()`, `INTERIOR_ORIGIN`, `INTERIOR_HOTSPOTS`, `INTERIOR_DOOR_HOTSPOT`, `INTERIOR_PLAYER_R`, `interiorSets`, `interiorActiveTheme`, `interiorColliders`, `interiorWallBlocked(x,z)`, `interiorFurnitureBlocked(x,z)`, `interiorPosters`, `interiorYaw`, `setInteriorMove()`, `toggleInteriorFixture(id)`, `partyMode` | B | p2/room-lib, survey, party, passport-interior |
| phase 2: `__app.scene.getEnvironmentCycle()`: `getHour()`, `getDayFactor()`, `.debugHour` (written by duskflip) | C | p2/duskflip, p2/bootcost, p2/L.cjs |
| phase 2: `__app.scene.boardVehicle(i)`, `vehicleKind(i)`, `isRidingVehicle()`, `disembarkVehicle()`, `vehicles[i].forward` | B | strafe (the vehicle chases), perf gate (P2-E3) |
| phase 2: p2/L.cjs's mask material swap, keyed on `SkyDome`, `userData.isPavement`, `userData.isCelHull`, `island.surfaceMesh` and `island.npcTargets` | B, C | p2/L.cjs (and the lighting probes in later waves) |
| stage 2: `#ds-guide` (`data-active`, its Skip button and resume chip), window events `ds:intro`, `ds:modal`, `ds:guide`, `ds:guide-to`, `ds:goals`, `ds:npc-speaking`, `ds:npc-typing`, `ds:coin`, `ds:settings`; `[data-guide=*]` anchors and `[data-hud=prompt]` | A, D | guide, events, fm |

The probes write only through the same hooks (a teleport, a camera pose, a
clock hour, a panel close), and only inside their own browser context.

## Probes and the items they serve

| Probe | Item | What it measures | Main baseline (this rig) |
|---|---|---|---|
| `arrow` | A1 | 24 off-axis bearings (the audit's set): arrow side vs target side, mean \|error\| | 0/24 same side; unwrapped mean error 148.8° (audit 148.1°) |
| `follow` | A1, CO-E3 | keyboard follower steering by the arrow toward the Projects zone: W ahead, W + the side key to a side and behind, or J/L behind with `--turn jl` (see the note below); distance at 25 s, label flips. `--reduced-motion`: the same in a context that prefers reduced motion | walks away, 103 → 208 m; `--mirror` (self-test) arrives in 19.3 s; `--turn jl` stands at 103 m (main has no J/L). `--reduced-motion`: walks away, 103 → 208 m; s1-int 103 → 199 m (the integration read 103 → 211) |
| `clash` | A2 | Ctrl/Meta+C with the email selected; ↓ and W behind Projects; M, C, P in a panel; E at a bench behind a panel; Space on a panel button; ← on the volume slider; sendThenWalk | Ctrl+C → `customize`; ↓ walks 8.4 u; P takes a photo; E seats; slider walks 4.5 u |
| `cardkeys` | A2 | C, P, M and E on a fresh card, then Explore; panel 0.9 s later and `ds_welcomed` | C replaces the card; `ds_welcomed=1`; the island map is open |
| `sheet-lock` | A3 | a world click beside the open Portfolio menu, then its Projects row | the click locks the pointer; the row does nothing |
| `look` | A3, A4 | drag and locked look at 1/5/30/60/120 frames; hover; peer tap; right-drag; `ds_mouse_lock`; touch swipes (fling off/on); J L I K R; ~30 fps | 300 px over 30 frames 3.5-3.6° at 13 ms frames (audit 3.8° at 14.6 ms); swipe 150 px: 21.2/5.4/2.7/1.8° |
| `strafe` | A5, CO-E3 | D held after a walk: heading and camera °/s; reduced motion; walk-away settle; fixed-pose camera frames (`--compare`), with two vehicle chases: 'aligned' and 'as boarded' (see the note below) | heading 143°/s, camera 143°/s, reduced motion 143°/s. Vehicle chase as boarded: the camera turns 39.9°/s; s1-int 13.3°/s, so `--compare` against main exits 1 on s1-int; 'aligned' matches main (pitch 0.03%, distance 0.27%) |
| `legspin` | B1 | first-visit standing jump on the frozen sim (1/60 s); legs vs π; mixer rewrites; landing hand jumps | legL −11.7 rad (130.7° off π) after landing and after 10 s idle; legs rewritten 0/300; the landing hand 0.071-0.075 u at every landing here, 0.492 u once in the integration's run (see the note below); s1-int: the legs at π, exits 0 |
| `rig` | B1 | sit, ride and swim bone positions in the player's frame; `--compare` gives max \|Δ\| | exits 0 on main; main vs main: 0; s1-int exits 0 |
| `hitch` | B2, CO-E3 | idle on the card and walking, from the welcome card to ready + 25 s: the interior warm's frames wherever it fires, LoAF, programs per render() and per compile; the first door's longest frame up to the first room frame; `--no-khr`: the black interval by pixels (see the note below) | exits 1: the warm's 2,181 ms frame at 11.1 s (+93 programs in that frame, +38 in one render), 520 ms walking, the first door 228 ms; s1-int exits 0 (no warm frame over 50 ms, the first door 25-33 ms) |
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

**Hitch note.** The recorder is an init script, in place before any page
script, so the probe sees ready. It judges from the welcome card (ready +
2.4 s here) to ready + 25 s, and the interior warm's own frames wherever the
warm fires (from its start to 100 ms past its end). main-simple defers the
warm with `idleDefer(warmInterior, 9000)`: on a quiet machine it runs 1.3-2.9 s
after ready, on this rig at its 9 s ceiling (8.9 s), and stage 1's window,
which opened at ready + 5 s, missed the quiet case. Gates: the warm's frames
over 50 ms, render() calls that create programs and take over 50 ms, long
animation frames of 100 ms or more, the warm resolving within 10 s, and the
first door. Reported, not judged:
- `bootTailOver50`: ready to the card, where both builds draw their late GLB
  models for the first time behind the loader (70-370 ms frames);
- `framesOver50`: every frame over 50 ms in the window. Both builds make one
  of 60-80 ms near ready + 5 s, the ambient music's synthesis
  (`idleDefer(startMusic, 5000)`, a minute of samples on the main thread),
  and now and then a 70-90 ms one later.

On main the warm's frame-to-frame program jump is the audit's 93, but it is
split: `warmInterior`'s `compileAsync` adds 55 programs inside the compile
call and the next render adds 38 (44 when walking). The probe reports both
(`maxProgramsAddedInOneFrame` and `renderCallsWithNewPrograms`), because
B2's criterion is per render().

**First door.** `firstInsideFrameMs` is the frame that first shows the room
(`rows[firstInside].dt`) and `maxFrameToFirstInsideMs` the longest frame from
`enterBuilding` through firstInside + 1. Stage 1 read
`rows[firstInside + 1].dt`, the frame after, which hid a slow first room
frame.

**Black interval (`--no-khr`).** Without the extension no idle warm runs, and
the near-door warm waits for 3 s of standing still. `--no-khr` runs desktop,
the low tier and the phone and adds `pauseNearDoor` (a fresh page; stand 3 s
within 3 u of the first house's door, then enter) beside `walkStraightIn`.
Black is judged by pixels: a CDP screencast frame (JPEG, decoded with
playwright-core's jpeg-js) is black when its mean luminance is at most 5% of
the pre-entry median, which is the veil at 0.95 or more; the fade div's
opacity interval is reported beside it. s1-int, `--no-khr --profile desktop`:
walk-straight-in 1,566 ms black by pixels (1,576 ms by opacity), with a
1,074 ms first room frame; pause-near-door 586 ms (541 ms). The
integration measured 1.37-1.49 s and about 0.66 s.

**Vehicle chase.** `strafe` boards the first car twice. 'aligned' turns the
camera behind the car first; 'as boarded' turns it until the car's forward
sits 150° from the camera's, the integration's boarding-facing-away case.
The camera turns through `setYaw` where that moves the view (A4 drives the
follow direction from yaw) and through the follow direction where it does
not (riding on main ignores yaw). Each way is measured, the first within 3°
is kept, and the JSON names it (`vehicle.via`). After 30 still frames W is
held 2 s on the frozen 1/60 s sim; `cameraYawAbsDegS` is the camera's
absolute yaw change per second. `--compare`: 'aligned' within 5% of the other
build's distance and pitch, 'as boarded' within 10% of its camera turn. Main
turns 39.9°/s as boarded (the integration's diagnostic: 37.2), s1-int
13.3°/s (15.1); the CO-A1 row in the stage-2 plan is the fix.

**Frame-rate dependence.** Main's look and leg-spin numbers scale with frame
time (that is the bug). `look` reports `meanFrameMs` with every reading, and
`legspin` runs on the frozen sim so its airborne frame count is fixed.

**Landing hand.** On 58c8849 three runs here read 0.071-0.075 u per frame at
every one of the seven landings, inside the 0.15 u bound. The integration's
run on the same rig read 0.492 u at the sixth: a one-frame spike four frames
before touchdown (+0.492 u, then −0.488 u), which no other landing or run
shows. So the landing-hand check fails on main only now and then, and it
cannot show B1's fix on its own; the leg checks (legL −11.7 rad, 130.7° off
π, and 0/300 leg rewrites) fail on main every time. s1-int: the legs at π
after landing and after 10 s idle, the hand 0.071-0.075 u; exits 0.

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
prove nothing about the product.
On s1-int: every step, the reload at 3/5, the chip, the finale (24-33 s from
Explore), 'Show me' (Projects at 1440 and 844, School at 390 and 667), the
card against the joystick, the action column, the prompt and the edges,
Skip, reduced motion, legacy storage and B10 read as designed at all four
sizes (51 of 55 checks). The four that fail are the product's: hint toasts
show while the card is up at every size (the gold arrow, the villager who
talks through Claude Haiku 4.5, 'Coins!'), because s1-int has no D6, and
the double does not stand in for D6.

### Phase-2 probes, wave 1 (P2-E1a, P2-E2a)

In `p2/`, CommonJS on `lib.cjs`, run by path (`npm run probe -- p2/<name>`),
output in `tools/ux-probes/out/p2/<name>/`. They take `--dist` or `--url`,
`--port`, `--device desk|phone` and `--hour`. Rooms are entered the way a
visitor enters them (`p2/room-lib.cjs`'s `enterRoom`): stand on the door
axis, walk at the door (W, or the joystick through trusted CDP touches) until
its prompt shows, press E or tap USE, and type the islet code (5673) on its
pad. When a villager holds the prompt the scene's own door callback is used
and the JSON says `fallback-callback`. The veil is the fade div's opacity
(>= 0.95), as the audits measured it. Baselines as for stage 2 (same rig,
same two dists, 2026-11-04).

| Probe | Item | What it measures | 58c8849 | s1-int |
|---|---|---|---|---|
| `p2/walkin` | INT-01, CO-A5 | phone, joystick straight at the door: Professional (the first door), Projects, a cottage after standing 2 s; programs added, the longest frame, the black veil. `--cpu 4` (CPU throttled through CDP): the Welcome Hub 2.5 s after the card, as the integration measured it (Explore tapped at the card, the visitor put 2 u out on the hall's door axis 1 s after it, USE when the prompt shows and not before 2.5 s), median of 3 fresh browsers (`--runs`); a median press outside 2.5-4 s is inconclusive | first door +31 programs, a 1,362 ms frame, 1,915 ms black (audit +31, 1,224 ms, 1,761 ms); Projects +3 (172 ms, 369 ms black), the cottage +2 (140 ms, 327 ms). `--cpu 4`, E 2.7 s after the card: +46 programs, a 2,370 ms frame, 3,024 ms black (median of 3; the integration's 4x low tier read +43-44, 730-1,370 ms, 1.22-1.79 s) | first door +0 programs, a 55 ms frame, 553 ms black; Projects +0 (29 ms, 220 ms), the cottage +0 (10 ms, 190 ms); exits 0. `--cpu 4`, E 2.75 s after the card: +11 programs in all three runs, a 1,246 ms frame, 1,831 ms black (the integration: +13-15, 370-1,110 ms, 0.83-1.50 s) |
| `p2/survey` | INT-03, INT-04, P2-B1, D6 | every building by the door: the entry, reach (promptAtSpawn, spawnInsideProp, every hotspot reachable), the camera sweep, avatarFrame, capPx, four poses, the per-room cost, the window pass, Leave and the exit; D6's toast or flash over the Welcome panel | promptAtSpawn `['door (leave)']` in all 7 themes; the home's spawn inside a prop and its curtains out of reach; D6: 'Secret found' flashes over the Welcome panel; every building entered by E; the beach house +17 programs, a 1,682 ms frame, 1,851 ms black, the Welcome hall a 246 ms frame, the others 15-56 ms; Leave is a DIV (tabIndex −1) | the same reach, spawn, D6 and Leave findings; the beach house +17 programs, a 1,751 ms frame, 1,923 ms black; the Welcome hall 56 ms, the others 15-52 ms |
| `p2/passport-interior` | INT-02, P2-D1, P2-A2 | three stamps set, E at Get In Touch: the TypeError fadeThrough swallows, the panel stack, the Leave control, Escape | the TypeError ("Cannot read properties of null (reading 'addEventListener')"), stack `['passport-complete']`, no Leave, nothing open after Escape | the same: the TypeError, stack `['passport-complete']`, no Leave, nothing open after Escape |
| `p2/party` | INT-08, P2-B2 | desktop (or `--device phone`): a cottage, then the beach house by its door and code; the party off and on; out and back in. Programs, the longest frame, the veil, visible lights (`--first`: the beach house as the session's first door) | the beach entry +18 programs, a 2,346 ms frame; party off +2 programs, 136 ms; 13 lights against a cottage's 9 | the beach entry +20 programs, a 1,661 ms frame (1,847 ms black); party off and on +0 programs, 25 and 12 ms; 13 lights against a cottage's 9 |
| `p2/partyoff` | INT-08, P2-B2 | 3 s after 'Party over': borrowed dancers still in the room, visible and frozen | 6 frozen | 6 frozen |
| `p2/bootcost` | LT-03, P2-B6, P2-C4 | a fresh browser per boot, ?hour=12 against ?hour=21, 3 each: the card, long tasks before it, programs, lights | the 21 h card +4,817 ms on desktop (6,769 vs 11,586) and +4,168 ms on the phone (5,051 vs 9,219) | +4,783 ms on desktop (6,859 vs 11,642), +4,556 ms on the phone (4,800 vs 9,356) |
| `p2/duskflip` | LT-03, P2-B6, P2-C4 | ?hour=17, the warm, then `debugHour = 17.5`: the longest long task, long animation frame or rAF gap of the next 6 s | desktop 3,848 ms; phone 3,581-3,717 ms (one run read 0 with the long-task observer alone, so the frame gaps are read too); lights 5 to 17, programs +35-37 | desktop 2,385 ms, phone 3,393 ms; lights 5 to 17; programs +33 on desktop, +37 on the phone |
| `p2/journey` | GD-01, A7 | the curious visitor (`--scenario follow`): trail, the trail's villager, then the compass wherever it points, entering each hall it leads to, a map pick after two deliveries; the pill over time, each stamp and when, each map pick's end (its door prompt, the pill). `--scenario mappick`: a map pick of each district. Villager replies take the written fallback (the backend stays blocked) | 1 of 4 stamps by 6 min and by 9 min (Projects, at 42 s); the pill reads 'Delivery' after it; after two deliveries, 11 map picks of Professional each fell back to the delivery's final gift before the door. `--scenario mappick`: Projects and Professional end at their doors, Personal and Contact at the Welcome Hub's door prompt | 1 of 4 by 6 and by 9 min (Projects, at 58 s); 'Delivery' after it; 7 map picks of Professional fell back the same way. mappick: Projects, Professional and Personal end at their doors; Contact ends on a door prompt with no name ('Press E to enter') |

`p2/room-lib.cjs` (the interiors kit, ported from `ia.cjs` and rebased onto
`lib.cjs`), `p2/L.cjs` (the lighting kit: masks, L*, the loop pause; its
PNG reader is playwright-core's), `p2/play-lib.cjs` (the gameplay kit) and
`p2/guide-lib.cjs` (the guidance kit: readout, the compass follower, the
villager walk, the timeline) are libraries, not probes.

## Perf gate

`npm run perf:gate` (`tools/perf-gate.cjs`, items E1 and CO-E2) runs on the
same harness. The world clock is pinned to `?hour=12` (night lights change
the light count, the programs and the draws); `--hour live` turns that off.

```sh
npm run perf:gate -- --dist dist --port <n>              # baseline report + counter and µs budget checks
npm run perf:gate -- --dist dist --port <n> --fx <name>  # one __dsFx effect: draws and programs per view, then 6 x 1.5 s per side
npm run perf:gate -- --ab <mainDist> <branchDist> --ports <a>,<b> --cycles 6
npm run perf:gate -- --ab <dist> <dist> --ports <a>,<b> --record-floor   # 24 A/A cycles: writes tools/perf-gate.floor.json
```

- Profiles: desktop 1440x900, the 1x low tier, and startup-only at 4x CPU
  (GPU timer queries off).
- Each load: the startup marks, then 30 s after the card (past the interior
  warm and the late compiles) programs, nodes and textures, then the views
  in `VIEW_DEFS`: idle spawn, hub-wide and the Projects district, posed with
  the design audit's framing (follow direction, pitch, distance, teleport).
  P2-E3 adds a vehicle view and a room view there. Counters are one whole
  frame with the loop paused (draws, triangles, programs, textures); timings
  are 1.5 s windows (CPU per app frame, GPU timer queries, fps).
  `programs after the views` is judged too.
- The pose sets the OrbitCamera's `pitchTarget` with its pitch. A4 eases
  pitch toward pitchTarget within a view's 1.2-1.5 s settle, so stage 1,
  which set only the pitch, measured s1-int's hub-wide and Projects views at
  −0.12 rad against main's −0.62 and −0.38 rad, and reported −949 and −404
  draws that the camera saved, not the build. Every load now reads the
  camera's and the orbit's pitch at both views (`pose` per view); when the
  two sides' medians differ by more than 0.01 rad the profile is
  inconclusive, whatever its metrics say.
- Programs are logged per render() and per outermost compile call (a
  compileAsync's inner compile() is not counted twice); µs per effect come
  from `FxBudget.ts` (`__dsFx.stats`), divided by the frames the gate saw.

Budgets (`THRESHOLDS`, from plan-r3 › perfBudget), as B − A:

| Profile | Budget |
|---|---|
| desktop | CPU p95 +1.0 ms; GPU p50 +2.0 ms; draws spawn +50, hub-wide +80, Projects +60; programs +5; welcome_visible +150 ms; world_gen +50 ms; before the card: long tasks over 50 ms main + 1, the longest task +50 ms, +50 KB transferred |
| low tier (1x) | CPU p95 +0.75 ms; draws spawn +20, hub-wide +30, Projects +25; programs +3; scene nodes +150; textures +6 MB; +50 KB before the card |
| startup (4x) | welcome_visible +400 ms; world_gen +200 ms; long tasks main + 2, the longest task +50 ms; +50 KB before the card |
| FxBudget (`FX_US`) | per effect 150 µs a frame on desktop and 80 on the low tier; all effects 600 and 300. An effect in plan-r3's ledger (`FX_LEDGER`) is held to its ledger value where that is lower, in `--fx` and in the CPU proxy |

CPU p50 and triangles have no budget and are reported.

Verdicts, per metric:
- Timings (CPU p95, GPU p50, welcome_visible, world_gen, the longest task):
  delta is the median of the paired (B − A) cycle differences, and sigma
  the 95% band of delta, t(0.975, n−1) × 1.2533 × SD(B − A) / √n, so it
  pools both sides' noise and the ABAB pairing cancels drift. Valid when
  sigma <= T/2; pass when valid and delta <= T; fail when valid and
  delta > T + sigma; anything else is inconclusive, escalating to 12, then
  24 cycles. An invalid result never fails.
- Counters (draws, programs, nodes, long tasks, bytes; critique-r3): delta
  is median(B) − median(A). Pass when delta <= max(T, floor), an
  improvement of any size included; fail when delta > max(T, floor) +
  sigma, or > max(T, floor) at 24 cycles; otherwise inconclusive.
- Texture MB is the one exact counter: equal on every A/A load, or the run
  fails.
- The floor is each metric's 24-cycle A/A sigma on this rig, per profile, in
  `tools/perf-gate.floor.json` (`--floor <file>` reads or writes another).
  A timing whose T is below twice its floor cannot resolve here: CPU p95 is
  then judged by its proxy (every FxBudget effect within its µs budget, and
  their sum), and the others are reported `unresolvable`, not judged. Each
  row names its `rule`.
- welcome_visible rides the boot race (below), so it is stratified: each
  side's loads are split at the midpoint of that side's own program range,
  and the timing is paired within each mode (`strata` in the JSON).
- `--record-floor` (A/A only) runs 24 cycles, keeps the verdicts at 6, 12
  and 24 (`checkpoints`), writes the floor file through prettier, and
  judges the same cycles again against it (`withRecordedFloor`).
  `--max-cycles <n>` caps the escalation for a smoke run.
- Exits 0 pass, 1 budget fail, 2 fail-closed, 3 inconclusive.
- A/A (`--ab dist dist`): the JSON's `aa` block lists the exact counters,
  every |delta| over max(T, floor), and whether any profile failed.
- `hostBusyPct`: the whole machine's CPU busy share during each load. Other
  sessions' builds and probes widen sigma; an idle machine gives the
  tightest verdicts.
- `--fx <name>`: the effect starts off before any page script. 30 s after
  the card each view is posed and measured with four off/on pairs, the live
  loop stopped inside each pair so nothing moves between its sides (per
  side: the switch, then two app frames of 1/240 s; draws and triangles
  are their mean, programs the on sides add are the effect's). Then
  6 × 1.5 s per side of timing at the spawn, its µs against the budget
  above, and at most 3 animated elements at once with the effect on
  (plan-r3). On main, `--fx __unused` reads 0/0/0 draws and 0 programs on
  both tiers.
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
finishes loading. On main, desktop shows 212 or 215 programs and the low
tier 113 or 117; in stage 1's 96-load A/A the late mode showed the card
~0.6 s later on the median, so welcome_visible is bimodal too. In s1-int's
48-load A/A, desktop read
154 (19 loads), 165 (25) or 166 (4) programs, and the low tier
101 on every load.

**A/A on s1-int (CO-E2).** `--ab <s1-int> <s1-int> --ports 5192,5193
--record-floor`, 2026-11-04: 144 loads, 24
cycles a side on desktop, the low tier and startup, the host busy at a
median of 18% on desktop, 49% on the low tier and 14% at startup:
- No FAIL at 6, 12 or 24 cycles on any profile: each stays inconclusive
  (timings whose sigma is over T/2) and every counter passes.
- The pose check is equal on both tiers: camera pitch 0.62 rad hub-wide and
  0.38 rad at Projects on every load of both sides (orbit pitch −0.62 and
  −0.38).
- Texture MB is 18.52 on all 96 desktop and low-tier loads.
- Judged against the floor it recorded, the same 24 cycles pass on all
  three profiles, and every |Δ| is within max(T, floor).
- 0 leaks, and a boot proof on every load.

The floors, against each budget (a timing is judged directly only when
T >= 2 × floor):

| Profile | Metric | floor (24-cycle sigma) | T | judged by |
|---|---|---|---|---|
| desktop | spawn: CPU p95 ms | 1.61 | 1.00 | proxy: FxBudget µs (T < 2 × floor) |
| desktop | spawn: GPU p50 ms | 0.23 | 2.00 | sigma rule |
| desktop | spawn: draws | 7.10 | 50.0 | counter, max(T, floor) = 50.0 |
| desktop | hub: CPU p95 ms | 2.16 | 1.00 | proxy: FxBudget µs (T < 2 × floor) |
| desktop | hub: GPU p50 ms | 0.69 | 2.00 | sigma rule |
| desktop | hub: draws | 16.8 | 80.0 | counter, max(T, floor) = 80.0 |
| desktop | projects: CPU p95 ms | 2.45 | 1.00 | proxy: FxBudget µs (T < 2 × floor) |
| desktop | projects: GPU p50 ms | 0.49 | 2.00 | sigma rule |
| desktop | projects: draws | 7.59 | 60.0 | counter, max(T, floor) = 60.0 |
| desktop | programs (30 s after the card) | 3.60 | 5.00 | counter, max(T, floor) = 5.00 |
| desktop | programs after the views | 3.69 | 5.00 | counter, max(T, floor) = 5.00 |
| desktop | welcome_visible ms | 337 | 150 | reported, not judged (T < 2 × floor) |
| desktop | world_gen ms | 181 | 50.0 | reported, not judged (T < 2 × floor) |
| desktop | longest task before the card ms | 175 | 50.0 | reported, not judged (T < 2 × floor) |
| desktop | long tasks > 50 ms before the card | 1.18 | 1.00 | counter, max(T, floor) = 1.18 |
| desktop | bytes before the card (KB, transfer) | 0.76 | 50.0 | counter, max(T, floor) = 50.0 |
| low tier | spawn: CPU p95 ms | 1.90 | 0.75 | proxy: FxBudget µs (T < 2 × floor) |
| low tier | spawn: draws | 5.86 | 20.0 | counter, max(T, floor) = 20.0 |
| low tier | hub: CPU p95 ms | 1.69 | 0.75 | proxy: FxBudget µs (T < 2 × floor) |
| low tier | hub: draws | 6.29 | 30.0 | counter, max(T, floor) = 30.0 |
| low tier | projects: CPU p95 ms | 1.27 | 0.75 | proxy: FxBudget µs (T < 2 × floor) |
| low tier | projects: draws | 9.50 | 25.0 | counter, max(T, floor) = 25.0 |
| low tier | programs (30 s after the card) | 0.00 | 3.00 | counter, max(T, floor) = 3.00 |
| low tier | programs after the views | 0.40 | 3.00 | counter, max(T, floor) = 3.00 |
| low tier | scene nodes | 2.04 | 150 | counter, max(T, floor) = 150 |
| low tier | texture MB | – | 6.00 | exact |
| low tier | bytes before the card (KB, transfer) | 0.56 | 50.0 | counter, max(T, floor) = 50.0 |
| startup | welcome_visible ms (4x) | 379 | 400 | reported, not judged (T < 2 × floor) |
| startup | world_gen ms (4x) | 76.6 | 200 | sigma rule |
| startup | longest task before the card ms (4x) | 73.7 | 50.0 | reported, not judged (T < 2 × floor) |
| startup | long tasks > 50 ms before the card (4x) | 1.64 | 2.00 | counter, max(T, floor) = 2.00 |
| startup | bytes before the card (KB, transfer) (4x) | 0.25 | 50.0 | counter, max(T, floor) = 50.0 |

CPU p95's floor is over half its budget on both tiers, so CPU goes to the
FxBudget proxy; s1-int registers no effect yet, so the proxy reads n/a and
the CPU budget is reported, not judged, until stage 2's effects register
(each is then held to its µs budget). welcome_visible, world_gen and the
longest task before the card are reported too. Other sessions' builds and
probes kept the host busy through the run (medians 14-49%, peaks to 95% on
the low tier); an idle machine gives tighter floors, and `--record-floor`
rewrites the file.

**A/B, s1-main against s1-int.** `--ab <58c8849> <s1-int> --ports 5192,5193
--cycles 6 --max-cycles 6`, judged against that floor,
2026-11-04, the host 12-14% busy:
- The savings are gone: desktop hub-wide draws Δ +8 and Projects −9.5
  (stage 1: −949 and −404), the low tier +6 and +7. The pose check is
  equal on both tiers (camera pitch 0.62 and 0.38 rad on both builds).
- Programs 30 s after the card: desktop −51, the low tier −12.
- Desktop and the low tier pass after 6 cycles, CPU p95, welcome_visible,
  world_gen and the longest task reported, not judged; startup stays
  inconclusive (world_gen at 4x: sigma 123 ms against T/2 = 100). 0 leaks.

## Files

- `lib.cjs` the shared harness: serving, launch, safety, profiles, boot,
  in-page helpers, the virtual clock, numbers and contrast maths.
- `run.cjs` the CLI.
- `../perf-gate.cjs` the perf gate, and `../perf-gate.floor.json` its
  24-cycle A/A floor (written by `--record-floor`).
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
- Phase 2, wave 1, in `p2/`: `walkin.cjs`, `survey.cjs`,
  `passport-interior.cjs`, `party.cjs` (party, partyoff), `bootcost.cjs`,
  `duskflip.cjs`, `journey.cjs`, and the `room-lib.cjs`, `L.cjs`,
  `play-lib.cjs` and `guide-lib.cjs` libraries.
- `lock-census.cjs` the static census over `tools/owners.json`.
- `../owners.json` the ownership table and the contract-check allow-list.
- `test/probeSafety.test.ts` pins `classify()`, `leakReason()`, the boot
  proof and the exit codes; `test/helpers/astSlice.ts` (with
  `test/astSlice.test.ts`) is the shared read-only AST slicer for stage-2
  locks: `methodBody(file, 'Class.method')`, `functionBody(file, name)`,
  `statementAt(file, marker, { within, kind: 'if', nth })`.
