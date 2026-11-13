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
| `--base <url>` | Attach to a preview that is already running instead, or to production (`https://island.digiscalability.com`; see App Check under Safety). |
| `--profile desktop\|phone\|lowtier` | Run one profile instead of the probe's defaults. |
| `--hour <n>\|live` | The world clock for every boot that does not name its own hour. The default is 12: the clock follows the machine's local time, and an unpinned probe is judged on whenever it ran (at night First steps skips the talk step and villagers sleep). `live` leaves the clock alone. A probe that sets hours itself (`contrast`, `lum`, `p2/npcs`, `guide`'s night session) is not affected. |
| `--out <dir>` | Output folder (default `<os tmpdir>/ux-probes/<name>`). |
| `--compare <dir> --compare-port <m>` | A second build, for `rig` and `strafe`. |
| `--no-khr` | `getExtension('KHR_parallel_shader_compile')` returns null (`hitch`: runs desktop, low tier and phone, adds the pause-near-door entry, and judges the black interval by pixels). |
| `--pause-near-door` | `hitch`: a second first door on a fresh page, entered after standing 3 s within 3 u of it. |
| `--warm-at <s>` | `hitch`: call `scene.warmInterior()` at ready + s, so the warm fires there (a no-op when the idle warm came first). |
| `--busy-cap <pct>` | `hitch`: the share of the machine other processes may take before a frame over 50 ms is inconclusive rather than a fail (default 10). |
| `--reduced-motion` | `follow`: a browser context that prefers reduced motion. |
| `--golden <path>` | The seed golden (`seed`, and the perf gate's `--seed`). Default: `test/golden/seedDraws.json` in the checkout that holds `--dist`, else in the current directory; never this tool's own checkout. `--bless` writes there. |
| `--selftest-leak` | The harness answers one blocked-host URL itself (a synthetic 200 from `route.fulfill`, so nothing leaves the machine) and the page fetches it after boot. That response is a leak by the rule, so the run must exit 2. |
| `--double` | `guide`: inject a stand-in for A6's card that follows the guide's contract (see Stage-2 probes). |
| `--url <url>`, `--device desk\|phone` | The phase-2 probes' spellings of `--base` and `--profile`; both work everywhere. |

### Running a phase-2 probe

Phase-2 probes live in `p2/` and run by their path, `npm run probe --
p2/walkin --dist dist --port <n>`. They write to
`tools/ux-probes/out/p2/<name>/` (git-ignored) unless `--out` is given.

The phase-2 audits wrote their scripts with their own flag spellings, and the
plan's items quote them. The runner takes both on every probe, stage-1 and
stage-2 ones included:

| The plan's spelling | The runner's | Notes |
|---|---|---|
| `--url <url>` | `--base <url>` | attach to a preview that is already up |
| `--device desk` | `--profile desktop` | 1440x900, DPR 1 |
| `--device phone` | `--profile phone` | 390x844, touch, DPR 2 |
| (none) | `--profile lowtier` | the perf gate's low tier: the phone context with `?touch=1`. `landscape`, `landscape667`, `tablet` and `desktop1024` have no `--device` spelling either |
| `p2/daycycle.cjs` | `p2/daycycle` | a probe's name is its export's name, not its file's: `p2/light.cjs` holds `p2/daycycle`, `p2/weather`, `p2/beacons`, `p2/shadowdraws` and `p2/edge-crawl`; `p2/rooms.cjs` holds `p2/room-a11y`, `p2/room-phone`, `p2/room-light`, `p2/room-rig`, `p2/avlum`, `p2/warmtest` and `p2/room-census`; `p2/guidance.cjs` holds `p2/recruiter`, `p2/npcs` and `p2/copy`; `p2/play.cjs` holds `p2/firstplay`, `p2/race` and `p2/quests`. `npm run probe -- list` prints them all |

`--dist <dir> --port <n>` serves a build for the run, as for every probe.
With neither `--profile` nor `--device` a probe runs its own default
profiles (its row says which). The hour is pinned: the lighting and room
probes set it through `EnvironmentCycle.debugHour`, the field `?hour=`
itself writes, so one load covers every hour (`--hours 12,21` picks them);
the others boot at `?hour=12` unless their row names an hour. `--compare
<main dist> --compare-port <m>` adds the same measurement on a second build
for `p2/daycycle` and `p2/edge-crawl`.

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
- reCAPTCHA is answered in the page by a stub that sends nothing (App
  Check, below);
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

**App Check (production).** On a build with App Check the anonymous sign-up
waits for App Check's token exchange, and the exchange waits for reCAPTCHA
Enterprise, whose script the harness blocks. firebase/app-check 0.12 loads
that script with no `onerror`, so nothing was ever sent and every
`--base https://island.digiscalability.com` run exited 3. `RECAPTCHA_STUB`,
an init script in every session (`baseInitScripts()`; `recaptchaStub: false`
leaves it out), answers in the page instead: `grecaptcha.enterprise`'s
`ready`, `render` and `execute` (and the v3 spelling on `grecaptcha`), the
widget's success callback, a dummy token. It sends nothing. The exchange and
the sign-up it unlocks are aborted by `classify()` like any backend call,
the leak rules are unchanged, and `net.sessionsWithRecaptchaStubUsed` in the
JSON counts the sessions where App Check asked the stub for a token. A build
without App Check (every local build here) never calls it.
`test/probeSafety.test.ts` replays App Check's calls against it. Production,
2026-11-04, `arrow --base https://island.digiscalability.com`: desktop and
phone both exit 0, the exchange (x3 desktop, x2 phone) and then the sign-up
(x3, x2) intercepted and aborted, 0 leaks. Before the stub the same run
exited 3, with only the insights script and `enterprise.js` intercepted.

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
| `__app.ui` surfaces: `compassDiv`, `compassArrow`, `compassLabel`, `toastEl`, `flashEl`, `interactionDiv`, `fadeDiv`, `leaveBtn`, `pinDiv`, `zonePanelDiv`, `npcChatDiv`, `mapCanvas` (the minimap), `isWelcomeVisible()`, `isDialogueActive()`, `showZonePanel`, `showCompletionModal()`, `showJournal()`, `showPassport()`, `getJoystick()` | D | fm, events, guide, p2 probes |
| the touch joystick (the 166 px hit square, 44 px thumb) and the 74 px USE / JUMP / WAVE discs; `[data-guide=joystick]` and `[data-guide=use-button]` win once D6 lands | D | p2/walkin, guide, phone |
| `__app.mapGuideTarget`, `mapGuideLabel`, `lastCompassTarget`, `exitBuilding(isZone)`, `insideIsZone`, `isletUnlocked`, `enterBuilding(id, isZone)`, `passport.count()`, `passport.has(id)` | A | compass, p2 probes, p2/journey |
| `__app.scene`: `getZonesManager().getZones()`/`getZoneById()`, `coins`, `hasTrailCoins()`, `getCoinsCollected()`, `getNpcPosition(name)`, `getNearbyInteractable()`, `getIsland()` (`npcTargets`, `houseDoors`, `surfaceMesh`, `sampleSurfaceByDirection`, `seaLevel`), `warmInterior()`, `interiorWarmed`, `interiorNearDoorWarmed`, `onHouseEnterCb(id)`, `interactWithZone(zone)`, `schoolPos()` (guide's `--double`) | B, C | p2 probes, guide, census |
| the warm: `__app.scene.warmInterior()`, `warmInteriorNearDoor()`, `interiorGroup` and `isInsideInterior()` (a live frame drawing the room), and the method names `warmInteriorPasses`, `compileInteriorPass` and `settleWarmPrograms` on the stack, by which hitch tags the warm's yields (a rename leaves its warm check inconclusive) | B | hitch |
| phase 2: `__app.scene.isInsideInterior()`, `getInteriorHotspot()`, `INTERIOR_ORIGIN`, `INTERIOR_HOTSPOTS`, `INTERIOR_DOOR_HOTSPOT`, `INTERIOR_PLAYER_R`, `interiorSets`, `interiorActiveTheme`, `interiorColliders`, `interiorWallBlocked(x,z)`, `interiorFurnitureBlocked(x,z)`, `interiorPosters`, `interiorYaw`, `setInteriorMove()`, `toggleInteriorFixture(id)`, `partyMode` | B | p2/room-lib, survey, party, passport-interior |
| phase 2 (P2-B1): `GameScene.INTERIOR_SPAWN` (room-local `{x, z}`, (-1.5, 1.9) on wave 1) and `__app.scene.interiorHotspotsFor(theme)` (the theme's hotspots, then the lamp switch and the curtains by `text`, then the door by `action: 'leave'`). room-lib's reach flood-fills from that spawn over that list; a build without them falls back to the audit's spawn (-1.8, 2.6) and its shell fixtures (curtains at (1.8, 2.95)), and the JSON says which (`spawnFrom`, `spotsFrom`) | B | p2/room-lib (reach), survey |
| stage 2 (B10): `__app.scene.getTrailVillager()`, the villager the first-visit coin trail leads to (null when the world has none) | B | p2/journey (the villager it talks to), guide (B10's trail check reports it beside the nearest villager) |
| phase 2: `__app.scene.getEnvironmentCycle()`: `getHour()`, `getDayFactor()`, `.debugHour` (written by duskflip) | C | p2/duskflip, p2/bootcost, p2/L.cjs |
| phase 2: `__app.scene.boardVehicle(i)`, `vehicleKind(i)`, `isRidingVehicle()`, `disembarkVehicle()`, `vehicles[i].forward` | B | strafe (the vehicle chases), perf gate (P2-E3) |
| phase 2: p2/L.cjs's mask material swap, keyed on `SkyDome`, `userData.isPavement`, `userData.isCelHull`, `island.surfaceMesh` and `island.npcTargets` | B, C | p2/L.cjs (and the lighting probes in later waves) |
| stage 2: `#ds-guide` (`data-active`, its Skip button and resume chip), window events `ds:intro`, `ds:modal`, `ds:guide`, `ds:guide-to`, `ds:goals`, `ds:npc-speaking`, `ds:npc-typing`, `ds:coin`, `ds:settings`; `[data-guide=*]` anchors and `[data-hud=prompt]` | A, D | guide, events, fm |
| wave 2, the renderer's levers: `__app.renderer.bloomPass` (`enabled`, `threshold`, `strength`), `setBloomEnabled(on)`, `setBloomNight(day)` (P2-E5), `shadowFrozen`; `getRenderer().shadowMap.render` (wrapped to count shadow draws), `.autoUpdate`, `.needsUpdate`; `window.__dsFx.halfShadow` and `.bloomNight` | E | perf gate (`--fx`, whole frames), p2/shadowdraws, p2/daycycle `--bloom`, p2/beacons, camera |
| wave 2, light: `getEnvironmentCycle().setWeather(kind)`, `getWeather()`; the key light (the `DirectionalLight` with `castShadow`: its `shadow.intensity`, `shadow.mapSize`, position and target); `userData.isNightEmissive` on windows, sconces, bulbs and beacons; a zone's `marker.getObjectByName('zone-beacon')`; `Island.MAX_DISPLACEMENT`, `island.reliefScale`, `isOverWater(dir)`, `analyticSurface(dir)` (the beach-band and highland-shoulder masks follow Island's own dark-zone rule) | C, B | p2/L.cjs, p2/daycycle, p2/weather, p2/beacons, p2/edge-crawl, lum |
| wave 2, rooms: `scene.toggleInteriorFixture('lamp' \| 'curtains')`, `interiorLamp`, `interiorRoomLamp`, `interiorRoomFill`, `interiorFire` (the room's own lights), `interiorWindowMat` (the pane), `partyProps.group`, `interiorSets`, `warmInterior()` (wrapped by p2/warmtest before it first runs), `player.waveTime`; the 74 px JUMP and WAVE discs and the 💬 and 🎤 buttons | B, D | p2/room-light, p2/room-rig, p2/room-census, p2/warmtest, p2/room-a11y, p2/room-phone |
| wave 2, vehicles and races: `scene.vehicles[i]` (`dir`, `forward`, `radius`, `normal`, `group`, `occupied`), `getRaceStartPosition(kind)`, `races.circuits[kind].dirs` and `.surfaceR`, `races.state`, `races.nextIdx`; `ui.raceDiv` | B, D | perf gate (the vehicle view), p2/race |
| wave 2, villagers and copy: `scene.getNpcActivity(name)`, `npcTargets[i].dialogue`, `__app.talkVillager(current)` (who First steps names; null skips the step), `__app.constructor.LESSONS`, `ui.touchifyPlain(text)`, `ui.npcChatBadge`, the chat's `[role=log]`, its `input` and any button a reply adds, `ui.completionBtn`, `ui.showJournal()`, `multiplayer.selfName` | A, B, D | p2/npcs, p2/copy, p2/firstplay, p2/quests, p2/race |
| wave 2, intro and camera: `ui.fadeThrough(cb)`, the app loader (the overlay child holding `#ld-bar`), `button[data-tour]`, `__app.endTour()`, `getOrbitCamera().collisionMeshes`, `.raycaster`, `.minDistance` (written first to force the distance under 2 u) | A, D | intro, camera |

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
| `hitch` | B2, CO-E3 | idle on the card and walking, from the welcome card to ready + 25 s: the interior warm wherever it fires, judged by its own work (`--warm-at <s>` puts it anywhere), frames over 50 ms after the card on a quiet host, LoAF, programs per render() and per compile; the first door's longest frame up to the first room frame; `--no-khr`: the black interval by pixels (see the note below) | exits 1: the warm's 2,181 ms frame at 11.1 s on a busy host (+93 programs in that frame, +38 in one render); on a quiet one, the warm at 2.45 s and a 1,680 ms frame holding a 1,545 ms render of the room (+38 programs), 300 ms walking, a frame over 50 ms after the card, a 1,692 ms long animation frame, the first door 179 ms. s1-int exits 0 in all 14 scenario runs (see the note below) |
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
2.4 s here) to ready + 25 s, and the interior warm wherever it fires.
main-simple defers the warm with `idleDefer(warmInterior, 9000)`: on a quiet
machine it runs 1.3-3.4 s after ready, often before the card, and on a busy
one at its 9 s ceiling (8.9 s); stage 1's window, which opened at ready +
5 s, missed the quiet case. `--warm-at <s>` calls `scene.warmInterior()` at
ready + s, so a run can put the warm anywhere (when the idle warm fired
first the call is a no-op; `warmInterior[].source` says which one ran).

The warm is judged by its own work, not by where it lands
(`warmAttribution()`, pinned by `test/probeHitch.test.ts`). The recorder
logs the synchronous spans the warm runs: the call itself, then each
continuation from one of the warm's own yields (a `setTimeout` made from
`warmInteriorPasses`, `compileInteriorPass` or `settleWarmPrograms`, found
by name on the stack) up to its next. A frame over 50 ms that overlaps a
warm (from its start to 100 ms past its end) is the warm's when
- a live render in it drew the room outside an entry: stage 1's warm showed
  the room while `compileAsync` finished, and the next frame drew the
  room-lit variants (main's 1,680 ms frame below);
- the warm's own work in it is over 50 ms; or
- that work is 10 ms or more (`WARM_MIN_MS`: a slice is 4 ms plus one object
  and setTimeout's 4 ms clamp spaces the slices, so an ordinary frame holds
  two at most) and the frame is 50 ms or less without it.

A render that created programs with the room hidden (the bloom's arrival, a
late model's first draw) is listed with its frame
(`warmFlightFramesOver50`), not charged. When the warm's work was not seen
whole (a warm that ran over 150 ms with fewer than 2 yields seen, a span
still open at a frame, or a compile call in a flight outside the spans:
`warmWork.why`), the check is inconclusive, not a pass. Stage 1's rule
charged every frame over 50 ms in a flight to the warm, and on a quiet host
s1-int's early warm took the blame for the boot tail's last frame, so
hitch exited 1 in two of the review's three runs.

Gates: the warm's frames; render() calls in the window that create programs
and take over 50 ms; frames over 50 ms from the card to ready + 25 s
(plan-r3's runtime budget sets 0 on desktop with the extension; like stage
1, hitch judges it on every profile it runs); long animation frames of
100 ms or more; the warm resolving within 10 s; the first door. A frame
over 50 ms fails only on a quiet host: `hostLoad` (`lib.hostLoadMeter`: the
machine's busy share from `os.cpus()`, this browser's own from CDP
`SystemInfo.getProcessInfo`, sampled every second and summed per process)
must show other processes at 10% of the machine or less (`--busy-cap
<pct>`), or the check is inconclusive. Here a probe's own browser takes
8-25% of the machine and the rest of a quiet host 3-6%; one other
session's probe adds about as much again. Reported, not
judged: `bootTailOver50`, ready to the card, where both builds draw their
late GLB models for the first time behind the loader and build the card
(60-370 ms frames).

Baselines, 2026-11-04, other processes 3.7-7.3% of the host:
- s1-int: 18 scenario runs in 7 runs (five on desktop, among them
  `--warm-at 1.0` and `--warm-at 2.3`, and two on both tiers), all exit 0.
  The idle warm started at 2.17-3.36 s, often before the card at
  2.38-2.63 s; its own work was 123-137 ms in 29-34 spans, the longest
  10-13 ms (the room's build), the rest 4-9 ms slices. Six frames over
  50 ms fell inside a warm: the boot tail's last frame before the card (60,
  70, 90 and 100 ms on desktop, 50 ms on the low tier) and, with
  `--warm-at 1.0`, the bloom's arrival (120 ms, +6 programs, the room
  hidden). The warm's own work in each was 4.0-4.2 ms, one slice, so none is
  the warm's, and nothing goes to B: these are the frames stage 1's rule
  blamed. No frame over 50 ms after the card in any run, on either tier;
  the first door 17-24 ms.
- 58c8849 (desktop): exits 1. The warm at 2.45 s ran 1,834 ms; its first
  span was 141 ms (the room's build and `compileAsync`'s compile), and the
  frame at 4.13 s (1,680 ms) held a 1,545 ms render of the room
  (+38 programs). Walking: the warm at 2.54 s, a 300 ms frame with a 184 ms
  render of the room. Its yields go through three's `compileAsync`, which
  the tags do not name, so `warmWork.seenWhole` is false there; the charged
  frames fail it all the same.

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
opacity interval is reported beside it. s1-int, `--no-khr --profile desktop`,
two runs: walk-straight-in 1,369-1,566 ms black by pixels (1,374-1,576 ms by
opacity), with an 862-1,074 ms first room frame; pause-near-door 586-590 ms
(541-557 ms). The integration measured 1.37-1.49 s and about 0.66 s.

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
| `guide` | A6, B10 | First steps at 1440x900, 390x844, 844x390 and 667x375: each step done within 1 s of its action (walk W or the stick; look by drag or swipe; talk to the named villager, E or USE; the Portfolio menu; the map by M or a compass tap), Explore to the finale (<= 60 s), the reload at 3/5, the 20 s chip, Skip, getAnimations() inside `#ds-guide` under reduced motion, the card (every step, the chip, the finale) against the joystick / action column / prompt / minimap / edges, the finale's 'Show me' label (Projects at 1440 and 844, School at 390 and 667), legacy storage, hint toasts while active; B10's trail end | 'guide card present' fails at all four sizes; legacy fails; the trail's last coin is 1.53 u from the Mayor, whose prompt says "ask anything" (B10 passes) | the same |
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

The geometry check also names the minimap (`__app.ui.mapCanvas`, or a
`[data-hud=minimap]` / `[data-guide=minimap]` anchor once D adds one), and
reads the card's rect at every step, while the 20 s chip is up and at the
finale. The double sits in A6's short-landscape lane (top +56, left +16,
300 px), so on s1-int, 2026-11-04, `--double --profile landscape` and
`--profile landscape667` both fail it: the card and the chip cover
98x56 px of the minimap at every step (10 of 12 checks pass at each size,
the other failure being the hint toasts). At 1440x900 and 390x844 it reads
clear.

### Stage-2 probes, wave 2: intro, camera and luminance (E6b)

The audit's own scripts (`motion/intro_ui`, `veil2`, `analyze_intro`,
`camprobe`, `camprobe2` and `design-assets/lum.cjs`) were session temp
files, gone by wave 2. These three are rebuilt from the audit's reports
(`docs/history/2026-11-03-ux-audit/motion.json` and `design.json`, in the
main checkout) and checked against the numbers recorded there. Baselines:
2026-11-11 and 12, 58c8849's dist and wave-1 main 8662b27 (as built in
`w1-int`), four other builders on the machine: degrees, counts and L\* hold,
milliseconds are provisional. Every run: 0 leaks, a boot proof in every
session, the port free afterwards. All three exit 1 on both builds.

| Probe | Item | What it measures | 58c8849 | wave-1 main |
|---|---|---|---|---|
| `intro` | MOT-09, MOT-10; A10 | desktop, a cold load with a per-frame recorder from the first script: the camera's turn per frame through the fly-in (or the calm entry) once the loader has faded, with the distance it happens at; frames over 50 ms after the loader fades; when the welcome card shows (`welcome_visible`); the first-frame opacity and ramp of the welcome card, the hire card, the Portfolio menu and a zone panel; the door veil's first and second use (first-frame opacity, the ramp to black, how long it holds) | the largest turn 3.48° in a frame, 6.2 u from the player (the bar is 1.5°); 2 frames over 50 ms after the fade (60 and 120 ms); the card at 6.6 s; all four surfaces at opacity 1 on their first frame, a 0 ms ramp; the veil's first use starts opaque (a hard cut, the audit's finding) and holds 2.7 s, its second ramps over 360 ms | 2.89° at 8 u; 1 frame over 50 ms (150 ms); the card at 6.6 s, 31 ms after `ds:intro` settled; the four surfaces as on 58c8849; the veil's first use a hard cut held 0.5 s (wave 1's warm), its second a 392 ms ramp |
| `camera` | MOT-05, MOT-06, MOT-18; B11 | desktop, the camera's turn per frame from a per-frame recorder with key marks: a conversation's push-in (its first frame), its release and the frames after; the guided tour (`--mode tour`): the first frame, the largest turn, frames with the camera inside a building's box; parked 1.2 u from a wall (`parked`): frames with the wall between the player and the camera, and the camera's distance; leaving a room by its door (`door`); `force`: OrbitCamera's distance set to 0.8 u, the avatar's opacity within 150 ms and after the camera is let back, programs before, close and restored | the push-in's first frame 1.6° in this run (it rides on where the villager stands: 10-12.5° in the other three runs on the two builds); the release 15.7° in a frame; the tour's first frame 9.43° (the audit: a cut on the first frame), its largest 11.9° (530°/s), 0 frames inside a building; parked: the wall between in 39 of 39 frames, the camera 2.22 u out with the wall at 1.22 u; the door 0 of 47; at 0.8 u the avatar stays at opacity 1 (no fade); programs 212 throughout | the push-in 12.5°, the release 20.3°; the tour 9.42° and 11.0° (549°/s), 0 inside; parked 45 of 45 at 2.22 u; the door 0 of 38; no fade; programs 130 throughout |
| `lum` | DA-02, DA-03; C1, C2, P2-B4 | `?hour=6/12/18/21` at 1440x900 and 390x844, hub-wide, by mask: ground, sky, player and open-sea L\*, the sea's hue and saturation, sky to ground as a luminance ratio, and the L\* step across the horizon row (sky above against sea below, the median over the columns where they meet) | desktop ground 22.0 / 57.4 / 22.8 / 16.7, sky 70.5 / 75.8 / 70.4 / 13.9: sky to ground 11.8:1 at 6 h and 11.0:1 at 18 h; the sea's hue 14.5° at 6 h and 14.7° at 18 h against 205° at noon (a brown sea under a low sun), L\* 45.6 at noon; the horizon step 20.3 / 32.3 / 33.6 / 2.3; the phone's sky 18.9 L\* under desktop's at 6 h (18.5, 17.7 and 11.1 at 12, 18 and 21 h), its ratio 5.8:1 | ground 21.4 at 6 h and 21.6 at 18 h, 12.4:1 and 12.1:1; the sea's hue 15.7° and 16.2°, L\* 41.2 at noon; the horizon step 21.8 / 30.1 / 31.2 / 2.3; the phone's sky 19.0 under desktop's at 6 h, 6.4:1 |

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
| `p2/walkin` | INT-01, CO-A5 | phone, joystick straight at the door: Professional (the first door), Projects, a cottage after standing 2 s; programs added, the longest frame, the black veil. `--cpu 4` (CPU throttled through CDP): the Welcome Hub 2.5 s after the card, as the integration measured it (Explore tapped at the card, the visitor put 2 u out on the hall's door axis 1 s after it, USE when the prompt shows and not before 2.5 s), median of 3 fresh browsers (`--runs`); a median press outside 2.5-4 s is inconclusive | first door +31 programs, a 1,362 ms frame, 1,915 ms black (audit +31, 1,224 ms, 1,761 ms); Projects +3 (172 ms, 369 ms black), the cottage +2 (140 ms, 327 ms). `--cpu 4`, E 2.7 s after the card: +46 programs, a 2,370 ms frame, 3,024 ms black (median of 3; the integration's 4x low tier read +43-44, 730-1,370 ms, 1.22-1.79 s) | first door +0 programs, a 55 ms frame, 553 ms black; Projects +0 (29 ms, 220 ms), the cottage +0 (10 ms, 190 ms); exits 0. `--cpu 4`, E 2.75 s after the card: +11 programs in all three runs, a 1,246 ms frame, 1,831 ms black (the integration: +13-15, 370-1,110 ms, 0.83-1.50 s) Wave-3 fix (E): each visit also reports the governor across its frames (`gov`: renderScale and rung at the first frame inside, their range, the share read CPU-bound, the share behind E4's modal divisor) and `over50After`. On E's fixed dist, phone at 4x: longest frame 106.9 / 114.4 / 115.9 ms, median 114.4 (E's first wave-3 dist 211; the divisor engaged under the hall panel 64% of the entry; now 34-36%, after its 1 s grace). |
| `p2/survey` | INT-03, INT-04, P2-B1, D6 | every building by the door: the entry, reach from the build's spawn over its hotspots (`INTERIOR_SPAWN`, `interiorHotspotsFor`; the audit's spawn and fixtures on main) (promptAtSpawn, spawnInsideProp, every hotspot reachable), the camera sweep, avatarFrame, capPx, four poses, the per-room cost, the window pass, Leave and the exit; D6's toast or flash over the Welcome panel | promptAtSpawn `['door (leave)']` in all 7 themes; the home's spawn inside a prop and its curtains out of reach; D6: 'Secret found' flashes over the Welcome panel; every building entered by E; the beach house +17 programs, a 1,682 ms frame, 1,851 ms black, the Welcome hall a 246 ms frame, the others 15-56 ms; Leave is a DIV (tabIndex −1) | the same reach, spawn, D6 and Leave findings; the beach house +17 programs, a 1,751 ms frame, 1,923 ms black; the Welcome hall 56 ms, the others 15-52 ms |
| `p2/passport-interior` | INT-02, P2-D1, P2-A2 | three stamps set, E at Get In Touch: the TypeError fadeThrough swallows, the panel stack, the Leave control, Escape | the TypeError ("Cannot read properties of null (reading 'addEventListener')"), stack `['passport-complete']`, no Leave, nothing open after Escape | the same: the TypeError, stack `['passport-complete']`, no Leave, nothing open after Escape |
| `p2/party` | INT-08, P2-B2 | desktop (or `--device phone`): a cottage, then the beach house by its door and code; the party off and on; out and back in. Programs, the longest frame, the veil, visible lights (`--first`: the beach house as the session's first door) | the beach entry +18 programs, a 2,346 ms frame; party off +2 programs, 136 ms; 13 lights against a cottage's 9 | the beach entry +20 programs, a 1,661 ms frame (1,847 ms black); party off and on +0 programs, 25 and 12 ms; 13 lights against a cottage's 9 |
| `p2/partyoff` | INT-08, P2-B2 | 3 s after 'Party over': borrowed dancers still in the room, visible and frozen | 6 frozen | 6 frozen |
| `p2/bootcost` | LT-03, P2-B6, P2-C4 | a fresh browser per boot, ?hour=12 against ?hour=21, 3 each: the card, long tasks before it, programs, lights | the 21 h card +4,817 ms on desktop (6,769 vs 11,586) and +4,168 ms on the phone (5,051 vs 9,219) | +4,783 ms on desktop (6,859 vs 11,642), +4,556 ms on the phone (4,800 vs 9,356) |
| `p2/duskflip` | LT-03, P2-B6, P2-C4 | ?hour=17, the warm, then `debugHour = 17.5`: the longest long task, long animation frame or rAF gap of the next 6 s | desktop 3,848 ms; phone 3,581-3,717 ms (one run read 0 with the long-task observer alone, so the frame gaps are read too); lights 5 to 17, programs +35-37 | desktop 2,385 ms, phone 3,393 ms; lights 5 to 17; programs +33 on desktop, +37 on the phone |
| `p2/journey` | GD-01, A7 | the curious visitor (`--scenario follow`): trail, the trail's villager, then the compass wherever it points, entering each hall it leads to, a map pick after two deliveries; the pill over time, each stamp and when, each map pick's end (its door prompt, the pill). `--scenario mappick`: a map pick of each district. A pick, and a leg the pill names a district for, is followed until that district's own prompt (its zone name after 'to enter', or `getNearbyInteractable()` on its door), past any other door (a cottage's unnamed 'Press E to enter'); its end is read over 1.2 s, so a prompt still fading in counts; a villager chat that opens on the way is closed and the walk goes on; E is pressed only with the prompt it is meant for up (the door's, the mailbox's, the trail villager's). Villager replies take the written fallback (the backend stays blocked) | 1 of 4 stamps by 6 min and by 9 min (Projects, at 42 s); the pill reads 'Delivery' after it; after two deliveries, 11 map picks of Professional each fell back to the delivery's final gift before the door. `--scenario mappick`: Projects and Professional end at their doors, Personal and Contact at the Welcome Hub's door prompt | 1 of 4 by 6 and by 9 min (Projects, at 58 s); 'Delivery' after it; 7 map picks of Professional fell back the same way. mappick: Projects, Professional and Personal end at their doors; Contact ends on a door prompt with no name ('Press E to enter'). Those are the first follower's, which stopped at any door prompt. With the district-door follower (2026-11-04), mappick ends all four at their own door prompts on desktop and phone, the pill on the district's compass label ('🚀 Projects'), 8 of 8; on wave 1's integration build the same 8 of 8 with the pill on A7's hold ('🚪 Press E to enter Project Portfolio'), and follow 4 of 4 by 6 min on both. follow on s1-int is not re-measured with it Wave-3 fix: the crown's call is `button[data-crown-next]` (P2-D10's 'Next: …'), with 'Wear it with pride' as the older builds' fallback. |

`p2/room-lib.cjs` (the interiors kit, ported from `ia.cjs` and rebased onto
`lib.cjs`), `p2/L.cjs` (the lighting kit: masks, L*, the loop pause; its
PNG reader is playwright-core's), `p2/play-lib.cjs` (the gameplay kit) and
`p2/guide-lib.cjs` (the guidance kit: readout, the compass follower, the
villager walk, the timeline) are libraries, not probes.

### Phase-2 probes, wave 2: rooms and light (P2-E1b)

The audits' own scripts were session temp files, and they were gone by wave
2. These probes are rebuilt from the audit reports
(`docs/history/2026-11-03-ux-audit/phase2/building.json` and
`lighting,.json`): the same views, hours, poses and masks, checked against
the numbers the audits recorded on 58c8849 (in brackets below where the
report gives one). Baselines: 2026-11-11 and 12, the same rig and the same
two dists as wave 1 (58c8849, and wave-1 main 8662b27 as built in `w1-int`),
with four other builders on the machine, so counts and L\* hold and
milliseconds are provisional. Every run: 0 leaks, a boot proof in every
session, the port free afterwards. Each row exits 1 on both builds unless
it says otherwise: they have none of wave 2's fixes.

| Probe | Item | What it measures | 58c8849 | wave-1 main |
|---|---|---|---|---|
| `p2/daycycle` | LT-01, LT-02, LT-05, LT-06; P2-C1, C1, C5, P2-B4, P2-B5 | exact per-pixel masks (`p2/L.cjs`): ground, path, player, villager, sky and sea L\* at 8 views (hub-wide, spawn, the four districts, the beach band, the highland shoulder) x 8 hours (0, 6, 9, 10.5, 12, 15, 18, 21; `--hours`, `--views`) on desktop and the phone, with the key light's elevation over the player's own horizon and its shadow strength. The terrain is split by Island's dark-zone rule into beach band (`dir.y < sin 0.32`), highland shoulder and the rest; "ground" in a check is the whole terrain. `--compare <main dist>`: noon hub ground within ±1.2 of main, beach band and highland at 21 h within +3, the 21 h sky within ±2. The frames for 6, 12, 18 and 21 h at the hub, the beach and the highland are kept (`--keep` keeps all) | hub ground by hour on desktop 15.9 / 22.6 / 57.3 / 57.2 / 57.3 / 56.9 / 22.8 / 16.7 (the audit: 16.9 / 25.8 / 57.4 / 58.8 / 57.5 / 58.3 / 23.2 / 16.9; 06 h rides the moon's phase); at 10.5 h Professional 40.9 under a 5.7° sun at shadow strength 0.337, Projects 49.1, Personal 53.4, Contact 41.2 (40.8, 49.1, 53.2, 41.0): Professional is 16.3 L\* below the hub, Contact 21.8 below on the phone; the lowest sun −8.1° (Contact, 9 h); 21 h player median 4.4, p90 9.6; sky to ground 11.3:1 at 6 h; the phone's sky 57.5 at noon and 2.4 at 21 h against desktop's 75.6 and 13.5 (18.8 apart at 6 h); beach band 12.2 and highland 14.3 at 21 h | the same light: hub 14.9 / 21.4 / 57.2 / 57.3 / 57.3 / 56.9 / 21.7 / 14.8; Professional 40.8 (16.5 below the hub; the phone's Contact 21.9 below); 21 h player median 4.7, p90 8.2; sky to ground 12.4:1 at 6 h; the phone's sky 19.2 below desktop's at 6 h; beach band 10.8, highland 14.3 at 21 h |
| `p2/daycycle --bloom` | P2-E5 | one frozen frame (the loop stopped) at 12 and 21 h, under today's bloom, the decided night threshold (the build's own `setBloomNight` where it has one; else the probe writes the curve's value, and the check names which) and the bloom pass off, at three views: the hub-wide view, and the paused camera on a street lamp's head (`LAMP_AIM`: the lamp site nearest the spawn, and the one nearest the Professional centre, 4.5 u out at eye height, looking at base + 2.9 u). Two bulb masks: every `isNightEmissive` mesh, and lamp.glb's `Glow` parts alone. Judged, desktop at 21 h: the halo (within 6 px of a bulb) on the Glow-only mask +5 L\* or more over bloom-off at both lamps (the all-bulbs mask on a build with no Glow parts, and the check says so); the hub's ground within ±1 and player within ±2. Noon: each view's frame within ±1 of today's bloom. The low tier (no bloom pass) with `--compare <main dist>`: the hub-wide frame, ground and all-bulbs halo no more than +2 over main at 21 h. The bulb pixels are report-only (`data.bulbReport`): they are already about 93-97 L\*, so bloom cannot lift them (the call of 2026-11-13). `--sweep` adds thresholds 0.90 and 0.95 | (the old district views) 21 h, Professional: today's bloom against bloom-off lifts the ground +3.8 L\*, the player +17.6, the halo +32.3 and the bulbs +2.6; at 1.0 (written by the probe) all four are +0.0; at the hub ground +0.2, halo +11.5, bulbs +1.1, and 0.0 at 1.0. Noon: 0.0 | (the old views) Professional ground +3.3, player +17.3, halo +21.7, bulbs +3.6 under today's bloom, all +0.0 at 1.0; the hub halo +11.7. Wave 3, the lamp views, on w3-int (C's lamp.glb and emissive drive, threshold 1.0 by the build at 21 h): Glow-only halo +27.0 at the hub lamp (851 bulb px) and +36.6 at Professional's (413 px), +32.7 and +45.6 on a second run; bulb pixels +0.3 (93 and 97 L\* with bloom off); hub ground 0.0, player +0.1; noon 0.0 at all three views; low tier against wave-2 main: frame −0.1, ground 0.0, halo 0.0. PASS |
| `p2/weather` | LT-08, P2-B5 | noon, hub-wide, in clear, cloudy, rain and snow (`EnvironmentCycle.setWeather`): ground L\*, the sun's intensity and shadow strength, and the shadow's contrast on the ground (1 − Y as rendered / Y with the key's shadows off, the median over the pixels the shadow darkens) | ground 57.4 / 48.3 / 44.1 / 49.8 (57.5 / 48.3 / 44.2 / 50.4), the sun 1.6 / 0.88 / 0.56 / 0.8, shadow strength 1 in all four; contrast 0.32 clear, 0.33 in rain: 1.02x | the same ground and sun; contrast 0.30 clear, 0.32 in rain: 1.05x |
| `p2/beacons` | LT-09, P2-C5 | each district beacon at 12 and 21 h: the material's emissive and intensity, the rendered beacon's hue (its own pixels, by a one-mesh mask) against the district colour, and on desktop the 8 px around it with the bloom pass on and off | intensity 0.15 at 12 h and 1.3 at 21 h; at 21 h the emissive reads #a0aa4d, #9798d2, #ff9925, #f05d5b, #c15f9a (the audit's five) and the rendered hue is off by 55° (Welcome), 33° (Professional), 20° (Personal), 30° (Contact), 6.5° (Projects); at noon all five are within 5.2° | the same: 54°, 31°, 20°, 29°, 6.3° at 21 h; within 3° at noon |
| `p2/shadowdraws` | LT-08, E2 | desktop and the low tier: shadow draws per pass (counted where `WebGLShadowMap.render` adds them) and passes per 60 frames at the spawn, hub-wide and Projects at 12 h and the spawn at 21 h; then W held 2 s on the frozen 1/60 s sim: the contact shadow's offset from the feet, which is how far the player walked since the last pass | 95 at the spawn and hub-wide, 122.5-124 at Projects, 134-135 at 21 h (the audit: 94-95, 145-148 at its Projects view); a pass every frame on both tiers; offset 0 | 96, 96, 118-124, 138; a pass every frame on both tiers; offset 0. This branch (E2): the low tier 30 passes in 60 frames, 48 draws a frame, offset 0.093 u at 5.6 u/s; desktop unchanged; exits 0 |
| `p2/edge-crawl` | LT-01, P2-C1 (new: the phase-2 critique asked for it) | desktop, a fixed camera 16 u over the path, the sim frozen at 1/60 s, hour 10: the L\* of shadow-edge pixels frame to frame (edges: where the key's shadow darkens the frame by 15-85% of the full step), on the edges that held still while the player stood 1.5 s (a swaying tree's shadow is not crawl), over the lower 90% of those pixels (a villager's shadow crossing moves a few of them a lot); standing 1 s, then W for 3 s. `--compare <main dist>`: within 10% of main, or 0.01 L\* | walking 0.0027 L\* a frame against 0.0013 standing: crawl 0.0014, on 1,592 static edge pixels of 3,189 (all edge pixels, untrimmed: 0.086 walking, 0.013 standing: the villagers' shadows). Exits 0: it has no bar without `--compare` | 0.0000 walking and standing on 6,346 static edge pixels of 6,897 (untrimmed 0.0020 and 0.0018). Exits 0 |
| `p2/room-a11y` | INT-03, INT-07, INT-11; P2-A1, P2-D2 | desktop keyboard: E 0.7 s after entering a cottage; out by the door; in the Professional hall W for 1 s and E behind its panel, a 16-stop Tab walk, Escape once; Leave as a control (tag, name, tabIndex), Tab to it within 3 presses, its box against every visible HUD element, a live region naming the room, axe; a 60 s listener (`--listen`) for outdoor hints and the compass pill; Escape again; Q inside against a wave after the exit | E puts the visitor back outside; W behind the panel walks 1.94 u; Leave is a DIV, tabIndex −1, never reached by Tab, over the Day chip (60x22) and the minimap (86x9); no live region; the compass pill on screen in 113 of 113 samples; a second Escape does nothing; Q waves after the exit; axe 0 | E keeps the visitor inside and W behind the panel moves 0 u (wave 1); Leave, Tab, the overlaps, the compass pill (112 of 112) and the second Escape as on 58c8849; no live region names the room; Q does not carry over |
| `p2/room-phone` | INT-12, INT-03; P2-A1, P2-D2 | phone, a cottage by the joystick and USE: a USE tap 0.6 s after entry; which touch controls stay (USE, the joystick, 💬, 🎤, JUMP, WAVE, the drawer toggle, Leave); Leave as a 44 px target and against the HUD; the joystick indoors; out by a tap on Leave | the USE tap puts the visitor outside; JUMP and WAVE stay on screen; Leave is 86x39, over the Day chip and the minimap; the joystick walks 2.5 u in 1.2 s | the USE tap keeps the visitor inside; the rest as on 58c8849 (2.4 u) |
| `p2/room-light` | INT-09, LT-04; P2-B9 | a cottage and the Professional hall at 12, 21 and 22 h (`--hours`), both tiers, the back-wall pose: room L\* with the lamp on and off, the back wall's R/B, visible lights indoors against outdoors; the front pose: the window pane's L\* (its own screen box) and the curtains | the lamp off against on changes the room by −0.7 L\* at 12 h and −1.0 at 21 h in the cottage, −0.7 and −0.9 in the hall (the audit: about −1); phone −1.2 to −1.6; lamp on, 21 h against 12 h: −13.3 (43.7 → 30.4) in the cottage and −14.7 (42.5 → 27.8) in the hall; lights indoors against outdoors 9 against 5 at 12 h and 21 against 17 at 21 and 22 h; the window pane 51.2 at 12 h and 15.5 at 22 h; the back wall's R/B 1.43 at 22 h | the same room: lamp −0.7 and −0.9 in both (phone −1.1 to −1.4); −13.0 and −14.7 from 12 to 21 h; lights 9 against 5 at every hour (wave 1 took the porch and lighthouse lights out); the pane 51.3 and 14.3; R/B 1.42 |
| `p2/room-rig` | LT-04; P2-B9 | the five halls at 12 and 21 h, both tiers: room L\*, the same frame with the outdoor rig dark (what the frozen sun, hemisphere, fill and rim add through the walls), visible lights and programs inside. `--borrow`: the frame with the room's own lights dark instead (the room on the outdoor rig alone) | desktop halls 42.3-45.4 at 12 h and 27.6-31.1 at 21 h, 13.8-14.7 apart (the audit: 42.3-50.4 and 29.2-31.8); the outdoor rig adds 16.0-17.9 L\* at noon (16.2) and 2.4-3.2 at 21 h; lights 9 indoors against 5 by day, 21 against 17 at night; programs inside 215-218 by day and 269-275 at 21 h (phone 148-156 and 231-245) | the same L\* (13.7-14.7 apart); lights 9 against 5 at both hours; programs 135-141 (phone 77-84) |
| `p2/avlum` | INT-09; P2-B9 | a cottage at 12 and 22 h, both tiers, the back-wall pose, by mask: the avatar's L\* against the band of room right beside it (a fifth of its height wide) | the avatar 32.8 against 44.6 at noon and 16.0 against 30.4 at 22 h (−14.4); phone 14.2 against 29.8 (the audit: the core at 14-15, against a darker surround of 19-23 by its own box) | 32.5 against 44.7, and 15.0 against 30.9 at 22 h (−15.9); phone 13.5 against 29.8 |
| `p2/warmtest` | LT-04; P2-B9 | cold, a fresh browser per hour (12 and 21) and tier: `scene.warmInterior` is wrapped before it first runs, the app's own idle warm is waited for (the probe calls it after 12 s if it has not come): programs added, and the longest long task, long animation frame or frame gap in its window | desktop +96 programs (119 → 215, the audit's numbers) and a 2,420 ms task at 12 h, +155 and 4,831 ms at 21 h (the audit: 1.66-1.80 s and 3.55 s on a quiet host); phone +59 and 580 ms, +73 and 945 ms | +23 programs on desktop at both hours, the longest task 70 and 0 ms; phone +21, 50 and 140 ms (the warm starts with the card there) |
| `p2/room-census` | INT-06; P2-B10 | the room sets by material: lit materials off the toon model outside the window pane, the posters and the party props; ink hulls per set (wanted on desktop, none on the low tier); shadow casters | 7 sets; every lit material is MeshStandard: the shell 78 of 80 meshes, office 18, workshop 19, home 19 of 20, post 16, hall 17, beach 18 of 29, cottage 29 of 30 (the audit's set sizes); 0 ink hulls, 0 casters on both tiers | the same |

**What the bloom rows show.** At 21 h, Professional, wave-2 main's bloom
lifts the ground, the player and the halo by 3-4, 17-18 and 22-32 L\* over
bloom-off, and at the decided threshold of 1.0 all of it is gone. The plan's
bar on the bulb pixels themselves (+5 L\*) cannot be met by any threshold:
the bulbs already render at about 93-97 L\*. P2-E5 is closed on the call of
2026-11-13: the measure is the halo around lamp.glb's Glow parts, framed on a
lamp head, and C's emissive drive puts it at +27 to +46 L\* over bloom-off at
1.0 on the merged build, with noon and the low tier unchanged. The bulb row
stays in the data as a report.

### Phase-2 probes, wave 2: guidance and play (P2-E2b)

On `p2/guide-lib.cjs` and `p2/play-lib.cjs`, rebuilt from the audit reports
(`phase2/a.json` and `phase2/gameplay.json`) for the same reason. The
backend stays blocked, so every villager reply is the written fallback, and
a probe never reads a secret from the source to pass a check (the Sailor's
code comes from his words or not at all). Sounds are logged by wrapping
OscillatorNode and AudioBufferSourceNode starts (`play-lib`'s `AUDIO`).
Baselines as above: 2026-11-11 and 12, 0 leaks, a boot proof in every
session, the port free afterwards. Every row exits 1 on both builds.

| Probe | Item | What it measures | 58c8849 | wave-1 main |
|---|---|---|---|---|
| `p2/recruiter` | GD-02; P2-A4 | desktop and the phone, three visits: Work with me from the welcome card, then the hire card closed: seconds to the first guide surface (a First steps card, a route card, a hint toast or the compass pill gaining a target) in 60 s, and whether its 'Show me' sets the compass to Projects; `?zone=hire`: the same after the deep link's card closes, and `ds_welcomed` left unset; the recruiter tour from the hire card's `button[data-hire-tour]`: a guide surface within 2 s of the card closing | no guide surface in 60 s after the hire card closes, on either device (the audit: none in 50 s), and none after the `?zone=hire` card; `ds_welcomed` stays unset; the tour check reads 'hook missing' | a guide surface 0.8 s after the hire card closes on both devices (First steps, wave 1), with no 'Show me' on it; after the `?zone=hire` card none in 60 s; `ds_welcomed` stays unset; the tour check reads 'hook missing' (no `data-hire-tour` yet) |
| `p2/firstplay` | GP-02, GP-08; P2-D4 | desktop and the phone at `?hour=12`: Explore, the arrival trail's coins, the villager it ends at, a chat with them, and five questions typed with the backend blocked ('What does Abbas build, and how do I contact him?', 'What does Abbas build?', 'How do I contact him?', 'Where is the shop?', 'Nice weather?'): the reply, any button on it, where the button leads; the badge; a talk hint after the chat; sounds started | the trail's 4 coins, then the Mayor (the nearest villager); 'What does Abbas build, and how do I contact him?' gets 'The town hall is always open — that is a campaign promise.' and no button (the audit's finding); the other four get one of his three written lines, no button; the badge reads '✨ live AI' until the first reply, then 'offline replies'; no talk hint returns | the trail ends at the Mayor (`getTrailVillager`); all five get one of his written lines and no button ('Deliveries up, complaints down. A fine term so far.' to the Projects question); the badge reads 'offline replies'; no talk hint returns |
| `p2/npcs` | GD-12, GD-05; P2-C6 | desktop, a fresh load at 10.5, 18, 21, 23, 2 and 6 h (`--hours`): the villagers awake within 30 u of the spawn, how many are asleep, when the talk hint shows in 12 s, and who First steps' talk step names; then (`--no-sailor` skips it) the Sailor, by keeping pace 1.6 u off his boat until his prompt shows: everything he says, a 4-digit code in it, and that code typed at the beach house's door | awake within 30 u: 3, 3 and 2 at 10.5, 18 and 21 h, none at 23, 2 and 6 h (16, 16 and 9 of 28 asleep), and the talk hint still shows at 4.1-4.3 s at those three hours; the Sailor: no talk prompt beside his boat in 5 s (the swim prompt shows), so no code is heard | the same villagers; no talk hint in 12 s at any hour (First steps is up); its talk step names the Mayor, the Mayor and the Elder Sage at 10.5, 18 and 21 h and is skipped at 23, 2 and 6 h; the Sailor as on 58c8849 |
| `p2/copy` | GD-08 | the phone and desktop: the six lessons, every villager's written lines (85), the Journal and the checklist, read for keyboard keys in copy a phone shows and for wrong facts, banned words ('agents', 'live AI') and typed counts | on the phone 4 key names (WASD and Space in lesson 1, 'E to cast' in lesson 2, the Nurse's 'hold Space'); facts: 'Two dozen of them will really talk' (a typed count), 'five zones' (Island Explorer, Cartographer), 'your next delivery', 'the Project Portfolio zone'; the chat badge reads '✨ live AI' before the first reply | the same lists |
| `p2/race` | GP-03, GP-05; P2-A7, D10 | desktop and the phone: the land circuit driven ring to ring (`--driver gates`, steering at each ring's position) or by the compass pill's bearing alone (`--driver compass`, A1's sign: positive is to the right): the lap, stalls, at each of the 5 checkpoints whether the next ring is below the horizon and what the pill names; the share of the pill the race HUD covers; district toasts between 'Go!' and the finish; the finish card's words with the backend blocked; a name prompt for a fresh visitor | the next ring below the horizon at 10 of 10 checkpoints; the HUD covers 73% of the pill on desktop and 100% on the phone; the pill names districts (Projects, Personal, Contact, Contact, Professional), never a ring; laps 59.7 and 54.2 s; the finish says 'No times yet — you're on the board!' with the board unreachable, no Retry; no name prompt (a random 'Brave Scout') | 10 of 10; the HUD covers 83% and 88%; the pill names the Mayor (First steps' target) at all five; laps 55.7 and 58.7 s; the finish and the name as on 58c8849. `--driver compass` does not finish a lap on either build (0 checkpoints in 150 s: the pill never points at a ring), which is what A's ring bearing changes |
| `p2/quests` | GP-04, GP-07, GP-10; P2-A7 | desktop: six E presses at the School (coins paid); the Elder Sage's prompt; E after her quest lines | six presses pay +60 (the audit's number); her prompt reads 'Press E to talk to Elder Sage — ask anything' with no word of a request; after her lines E opens the scripted dialogue again, not the chat | the same |

### Stage-2 probes, wave 3 (E6c)

Top-level probes, registered in `run.cjs`'s `GROUPS`. The motion, controls
and design audits' scripts (locomotion, analyze_loco, mixerprobe, npcprobe,
analyze_npc, npcshots, bubble-ab, p4-mobile, p5-hybrid-extra, p7-touchparam,
p8-layout) were session temp files and are gone, so these are rebuilt from
their reports (`ux-audit/results/motion.json`, `controls.json`,
`design.json`) and checked against the numbers recorded there. Every row
reads a wave-3 feature optionally: `html[data-run-key]` (A11), D7's keycap
markup and input mode, B8's pin scale through `GameScene.isCoarsePointer`.
Baselines 2026-11-13 at `?hour=12` (`bubble` also at 21 h): 58c8849
(`ux-audit/dist`) and wave-2 main (`w2-int/dist`, tree-identical to 29edc9b
but for comments), 0 leaks and a boot proof in every session, the port free
afterwards, four other builders on the machine (counts hold, milliseconds
are provisional).

| Probe | Item | What it measures | 58c8849 | wave-2 main |
|---|---|---|---|---|
| `loco` | MOT-01, MOT-04, MOT-07, MOT-14, MOT-15, RUN-01; A11, A13, B | desktop: `--run shift` (default) or `--run space` (adds `?legacyrun=1` only on a build that sets `html[data-run-key]`): W held 1.5 s, then the run key: airborne frames, speed at 0.6 s, time to 95% of 7.9 u/s; with Shift as the run key, Space held while walking must only jump. A standing jump: the soles' lowest skinned vertex over the terrain on the 12 grounded frames after touchdown, the squash minimum's frame, how far the camera rises against the player. The wave: the hand anchor's height over the feet each frame, and three 320 px crops from the chase camera. Footfalls: the walk phase each time the footstep's dust puff fires. Hints (A13): every `{hint:true}` toast, how often, and whether a panel, the guide or a room was up | Space: 23 airborne frames, 95% at 0.89 s (the audit: 34, 0.78 s); Shift walks (5.5 u/s, null: no run key); soles 0.087 u on landing; the squash minimum 4 frames after touchdown; the camera rises 1.1 u for a 1.21 u jump; hand peak +0.42 u (the anchor; the audit's 0.91 u was another point); footfalls at 0.25/0.75; the talk hint once, uncovered | Space: 32 airborne frames, 0.80 s; Shift as on 58c8849; soles 0.09 u; squash minimum 5 frames; the camera 1.1 u for 1.21 u; footfalls 0.25/0.75; no hint fired (First steps holds them) Wave-3 fix: the hints rows run in a fresh profile of their own: First steps skipped (no hint shows while it teaches), W held 4.5 s (the run hint waits for 3 s of walking), the player 3 u from a tree (the chop hint), then a reload and the same again; the guide counts as open by its card's `data-active`. w3-int: run, chop, earn and talk on the first load, the Hub's district hint on the second, no repeats, none covered. PASS. |
| `npc` | MOT-11, MOT-12, MOT-13; B8 | desktop, 9 s of every visible villager (from `meshRef.userData`): bob and roll cycles per leg cycle while walking, the leg's one-frame jump on a walk start, the soles' lowest skinned vertex walking, sitting and kneeling; the Elder Sage held in dialogue (the chat opened by E) for 4 s: arm range and the first 10° gesture; her tilt from plumb while the visitor types (B8's lean); then, desktop and phone, a bubble on her: the bubble's and the pin's projected rects inside the viewport, and the pin's bottom against the head's projected top | bob 1 and roll 0.5 per leg cycle; the walk-start pop up to 19.4° (the audit: 8-11° typical); soles 0.023-0.114 u walking, 0.043 u sitting, 0.023 u kneeling (the audit: -0.121 and -0.089 u: the poses moved since); arm range 12°, first gesture 1.2 s; no lean; at 1440 the bubble runs off the top (y -257) and the pin's bottom sits below the head's top, the same at 390 | the same gait and talk numbers (kneeling -0.117 u, no 10° gesture in 4 s); the same framing Wave-3 fix: B8 fades the held villager's pin and bubble in a chat, so the chat rows judge the other villagers in the middle 80% of the view (pins in view and above their heads, with a 2 px tolerance for the head's box corner) and a bubble shown on the nearest of them; the held villager's pin is read with the hold released 300 ms (chat camera kept), judged only when it is half opaque or more. w3-int: desktop Architect and Teller, phone Storyteller's bubble, PASS; the held pin is in its near fade (0.14-0.17), reported null for B. |
| `bubble` | DA-08; B8 | desktop: a villager stood still (her wander idle; not held, since B8 fades a held villager's pin and bubble), a bubble on her, the camera about 18 u away (`--dists`), bloom on and off on the same pose at 12 h and 21 h: text (2nd percentile luminance in the bubble's rect) against fill (90th) | 3.38:1 bloom on, 15.76:1 off at 12 h; 3.29:1 and 14.47:1 at 21 h (the audit: 2.93 and 15.38 at noon) | 3.04:1 and 15.76:1 at 12 h; 13.29:1 and 12.23:1 at 21 h (P2-E5's night threshold) Wave 3 merged (w3-int), stood still: 14.77:1 on and off at 12 h, 14.34:1 at 21 h. PASS |
| `mobile` | JOY-01, HAPTIC-01, RUN-01, PROMPT-01; A11, D7 | the phone, trusted CDP touches: \|v\| at touchdown on 5 rim points of the stick's hit square; speed after 1.8 s at dy -10, -20, -40 px; the thumb's transition-duration on release; the stick pushed 70 px out for 2.2 s (A11's touch run); the villager prompt's wording; every `navigator.vibrate` pulse | \|v\| 1.00 at all 5; 5.53-5.6 u/s at all three; 0s; walking at 5.6, not running; 'Tap 👆 USE to talk to Elder Sage'; 5 ms pulses only | the same |
| `hybrid` | DEVICE-01; D7 | a 1440x900 desktop context with no `hasTouch` and `navigator.maxTouchPoints = 5`, touches by CDP `Input.dispatchTouchEvent`: whether they arrive trusted (critique-r3); the scheme (chips or drawer); the villager prompt after a key and after a tap (D7's keycap markup, null without it) | **CDP touches arrive trusted without touch emulation** (pointerdown and touchstart `isTrusted: true`); the phone scheme (drawer, `isTouch` true); 'Tap 👆 USE' after the key (no keycap: null) and after the tap | the same |
| `touchparam` | DEVICE-01; D7, B8 | a plain 1440x900 desktop at `?utm_content=get-in-touch`: `isTouchDevice()`, the joystick, chips or drawer, 'Drag the joystick' copy, `GameScene.isCoarsePointer` | the phone scheme: `isTouch` true, the joystick shown, the drawer, pins coarse | the same |
| `layout` | BIND-01; A13 | AZERTY through CDP `Input.dispatchKeyEvent` (the W position is code KeyW with key 'z', the A position KeyA with 'q'), 0.8 s each: distance walked, the move against the starting facing, a wave | QWERTY W 4.42 u; AZERTY W 0 u; the A position waves and moves 0 u | QWERTY W 4.53 u; the rest the same |

### Phase-2 probes, wave 3: rooms (P2-E1c)

In `p2/building.cjs` on `p2/room-lib.cjs`, rebuilt from the interiors audit's
report (`phase2-audit/results/building.json`; `phase2-audit/interiors/` is
empty). `sweep` and `clip` drive the player (a room pose) and then run the
build's own interior camera (`updateInteriorMode`, one simulated second)
before they read the live camera, so B's P2-B11 is measured as built; they
never write the camera. "Inside a prop" is judged against each prop mesh's
own world bounds (geometry bounds x matrixWorld), not B's colliders or
camBlockers. The near-plane share counts every pose within 0.1 u of a prop
box, the strictly-inside ones included, as the audit counted it. Baselines
as above.

| Probe | Item | What it measures | 58c8849 | wave-2 main |
|---|---|---|---|---|
| `p2/sweep` | INT-04; P2-B11 | desktop, one building per theme (`--ids`): every walkable 0.3 u grid point x 16 headings | strictly inside: Personal 4.6% (chimney breast 136 poses, bookshelf 156, lamp shade 18), cottage 0.9%, beach 0.4%, others 0; near plane: Contact 3.3%, cottage 2.5%, Professional 0.3%, Personal 5.7%, beach 1.0%: the audit's numbers exactly | Personal 6.8% (near 7.7%), cottage 0.9 (2.5), beach 0.4 (1.0), Contact near 3.3, Professional 0 |
| `p2/clip` | INT-04; P2-B11 | desktop and phone: Personal's chimney breast and bookshelf (found by their boxes), the player 1.9 u in front facing away: the camera inside the prop, a prop between the camera and the torso, the avatar's share of the frame; screenshots | both poses put the camera inside the prop (the avatar 12.6% desktop, 29.4% phone); the bookshelf also occludes the torso | both inside the prop; no occlusion |
| `p2/rtkeys` | INT-01 (diagnostic) | phone and desktop, after the interior warm: the first door's new programs by shader name and output colour space | phone +31: 13 toon, 4 standard, 6 basic and the rest, all srgb-linear (the audit: 28-31); desktop +3 | +0 and +0 (P2-B9's borrowed rig) |

### Phase-2 probes, wave 3: play (P2-E2c)

In `p2/loops.cjs` on `p2/play-lib.cjs`, rebuilt from the gameplay audit's
report (`phase2-audit/results/gameplay.json`; `phase2-audit/gameplay/` is
empty). `play-lib`'s `walkTo({run})` holds Shift when `html[data-run-key]` is
'shift' and Space otherwise. Rows read wave-3 features optionally (the '!'
sprite, the Hats-tab dock, 'Next:', 'Your visit', the wait prompt) and use
`isFishingActive`, `getTrailVillager` and the `ds:goals` detail. Baselines
as above.

| Probe | Item | What it measures | 58c8849 | wave-2 main |
|---|---|---|---|---|
| `p2/fishing` | GP-06; P2-A6 | desktop and phone with a rod, at a shore spot by the fisherman whose prompt reads 'cast' (a wandering villager takes the prompt, so spots are re-found): E 1.4 s after the cast, the wait prompt, a 0.6 s E hold in the wait, the bite's time and its catch | E at 1.4 s loses the cast (`isFishingActive` false); the wait prompt 'Press E to reel in' ('Tap 👆 USE to reel in'); the hold reels at once; bites 4.7 and 4.2 s, caught | the same, with '…nothing yet. Wait for the float to dip.'; bites 7.9 and 7.8 s |
| `p2/gather` | GP-12, GP-01, GP-07; P2-A6 | desktop and phone with a sickle: 4 E presses at spots within 16 u of the farm where a stake under 3.5 u and a ripe crop are both in reach (the crop scan's 5 Hz cache is cleared per spot); E at a bare stake; the active delivery's mailbox prompt, and the toasts after collecting; the chain's hop lengths in delivery order | 0 of 4 harvest (all open the build chooser; the audit's 1 of 4 was presses across the farm); the bare stake opens the chooser; the mailbox prompt is its bubble text, '📬 Welcome package for new resident!', no key; the collect toast names no district; the chain 1,547 u | the same Wave-3 fix: the next-district toast is read for up to 8 s (it queues behind the arrival toast or a quest card) and matches 'next parcel waits near'. w3-int: '📬 Delivered. The next parcel waits near 💼 Professional.' on both devices, chain 901 u. PASS. |
| `p2/bobber` | GP-06; P2-B7 | desktop and phone: 8 casts from shore spots, the avatar faced to the water by one short step and the camera settled behind it: the float against the avatar's projected box (posed vertices, the rod and line left out), off-screen floats counted apart; at 12, 18 and 21 h the bite, and a sprite over the float at the bite that was not there in the wait (a lamp's glow is in both), screenshots | the float inside the avatar's box in 8 of 8 casts on both devices (the cast's interest focus eases the camera onto the float, which centres it behind the avatar; the audit, with its own camera, 3 of 8); no new sprite at the bite at 12, 18 and 21 h (null); a bite missed in 15 s or no free shore spot (a villager held the prompt) at some hours | inside in 7 of 8 on desktop (1 off screen) and 8 of 8 on the phone; no new sprite; bites missed as on 58c8849 |
| `p2/shop` | GP-04, GP-09; P2-D7 | desktop and phone: the kiosk with the trail's 5 coins (what is enabled per tab); with 0 coins, a 'Show me' line; the Hats tab: the avatar's centre against the shop's rect (desktop); buy and equip a hat: a toast | 2 of 20 enabled (2 supplies); no 'Show me'; the avatar's centre inside the shop; no toast | the same Wave-3 fix: since P2-D3 the equip outcome is a status line in the shop ([data-panel-note]), not a toast: the row accepts either, the note within 1 s of its click. w3-int: 'Explorer Cap on — other visitors see it too', 4-5 ms after the click, inside the shop, both devices. PASS. |
| `p2/tour` | GP-01, GP-04; P2-D10, P2-A10 | desktop and phone: the four districts walked (play-lib's steerer, run held) and entered by the door: stamps, coins, minutes, the last `ds:goals` visit; after the fourth stamp the celebration's text: 'Next:' and 'Your visit' | 4 stamps, 6 and 5 coins, about 2 min; the card reads 'Portfolio complete! … Wear it with pride', no 'Next:' and no visit block (null); no `ds:goals` | 4 stamps, 5 and 8 coins; the same card; `ds:goals` visit {stamps 4, villagers 0, coins 5/8, secrets 1/2, minutes 2} |
| `p2/quests` (canteen row) | P2-A6 | desktop: empty-handed at the canteen, two E presses 150 ms apart: soups and coins | 2 soups, -6 coins | the same |

### Stage-2 probes, wave 4 (E6d)

Top-level probes, registered in `run.cjs`'s `GROUPS`. The audit's scripts
(`motion/slide2`, `swim`, `env_juice`; `design-assets/fonts-cdp`, `loader`,
`texgen-time`, `webp-edge`; `perf-headroom/bundles.cjs`) were session temp
files and are gone, so these are rebuilt from the reports
(`ux-audit/results/motion.json`, `design.json`, `performance.json`) and
checked against the numbers recorded there. Every row reads a wave-4 feature
optionally and reports null, not fail, on a build without it. Baselines
2026-11-14 at `?hour=12`: 58c8849 (`ux-audit/dist`) and wave-3 main
(`deploy-w3/dist`, a local build of fcaa649), 0 leaks and a boot proof in
every session, the port free afterwards, four other builders on the machine
(counts hold, milliseconds are provisional).

| Probe | Item | What it measures | 58c8849 | wave-3 main (fcaa649) |
|---|---|---|---|---|
| `slide` | MOT-04, MOT-20; B3 | desktop, the frozen sim at 1/60 s: W held, then the build's run key (`html[data-run-key]`, else Space). Per leg the sole is the centroid of the 8 lowest bind-pose vertices skinned to `legL`/`legR`; each frame the lower sole's tangential world speed over `getTangentialSpeed()`, its minimum per walk cycle, `bestPlantRatio` the median of those. The bob's lowest frame per half-cycle against the nearest heel strike (`getGaitState?.().bob`, else the model's radial height; null when nothing bobs). Peak hip flexion at the run: the quaternion angle of `legL`/`legR` from the bind rest. turn180: W then S, the model's heading rate, peak °/s and t90 | walk 0.359 at 5.59 u/s (the audit 0.33 at 5.32 u/s: the same 2.0 u/s sole over a faster body), run 0.364 at 8.12 u/s (audit 0.36); no bob; flexion 0.65 rad; turn180 1603°/s, t90 200 ms (audit 1603°/s, 217 ms). Exits 1 | the same: walk 0.359, run 0.365 (Shift), no bob, flexion 0.65 rad, 1603°/s, t90 200 ms. Exits 1 |
| `swim` | MOT-08; B5 | desktop, the frozen sim at 1/60 s: from 5 u inland on the camera's heading, W, then the swim button (Space) once over water; stroke, two tread/stroke rounds across the 0.4 u/s gate, a dive (Shift), S back to shore and out. A pop is the quaternion angle of `armL`, `armR`, `legL`, `legR` or the model (body pitch) between consecutive frames over 25°, never an Euler delta. B5 diffs its pose with `rig --compare` | 15 pops: entry armR 159°, gate armL 168°/159°, stroke armR 100°/93°, dive armL 150°, exit armR 161°, body 78° (the audit: 126°, 136°/126°, 48°, 151°, 77°: the same five moments). Exits 1 | the same 15 pops within 6°. Exits 1 |
| `env` | MOT-16, MOT-22; B9, C9 | desktop, the frozen sim, judged by pixels (`--part coin\|canopy`). coin: 3.5 u short of the nearest meadow coin (`scene.coins`, never the trail's), the chase camera turned to it, W held; from the frame the count steps, 8 frames over 450 ms: a frame counts when gold pixels (the hue of #ffd34a ±12°, saturated, bright) above the head's projected top (the posed mesh's highest vertex) beat the frame before the pickup by 8; `ds:coin`'s detail recorded when dispatched. canopy: 26 u from a tree near the spawn, the camera 14° beside it; every sway tree 20-40 u from the camera with sky above its projected top: the topmost silhouette pixel each 100 ms for 6 s, travel = its peak-to-peak excursion; the CPU projection of the group's top beside it (the group sway alone), and shaderOnly = pixels − CPU | coin 0 of 8 (inside the silhouette, as the audit found); no `ds:coin`. canopy 3.4 px median, 1.5-7.5 px over 4 trees at 30-33 u; the CPU group sway 1.0-10.1 px (the audit 0.9-4.3 px). Exits 1 | coin 0 of 8; canopy 3.4 px median (1.5-6.5), CPU 1.0-9.1 px. Exits 1 |
| `texgen` | DA-12; C7 | desktop at 4x CPU (CDP; `--cpu <n>`), the median of 3 fresh loads (`--loads <n>`): an init script counts the 512x512 canvases made between `boot:worldgen-start` and `boot:scene-ready` (the four facade maps); the generator's canvas work timed in the page from a fixture copied from `TextureGenerator.createBuildingTextures` at fcaa649 (its `Math.random` replaced by a local LCG); saving = fixture x (facades present ? 1 : 0), so a build without the function reads 0, not "missing"; `world_gen` from the page's own measure, for perf-gate's `--ab`. No hook (the C7 contract) | 4 facade canvases (61 canvases in world gen); fixture 51.5 ms at 4x (the audit 41.9 ms; a busy host); world_gen 8.8 s at 4x. Exits 1 | 4 (57 in world gen); fixture 52.3 ms; world_gen 9.1 s at 4x (provisional: four builders on the machine). Exits 1 |
| `webp-edge` | DA-17; C11 | desktop, the Projects panel open (`showZonePanel({id:'projects'})`): every image it shows, drawn to a canvas in the page, its last 10 columns relative to `naturalWidth` (C11 re-exports chocomate.webp at 808 px); a column is light when the median over its rows of min(R, G, B) is over 150. Only shown images are judged; rankpilot.webp is sampled and reported. rankpilot.webp, og-cover.jpg and og-cover-v2.jpg fetched: each must be 200 | chocomate.webp shown at 428x150 (cover), 820 px wide, columns 810-819 light (the audit's columns exactly); rankpilot.webp 810-819; all three files 200. Exits 1 | the same. Exits 1 |
| `fonts` | DA-06; D12 | desktop and phone, after `document.fonts.ready`: CDP `CSS.getPlatformFontsForNode` on every element with its own text in the welcome card, the Hiring pill and the Portfolio menu's items (no Arial; a node whose computed family names 'Bebas Neue Fallback' is exempt). 'Bebas Neue' and 'Patrick Hand' count as loaded only when `document.fonts.check()` is true and a FontFace of exactly that family is 'loaded' (`check()` is vacuously true with no face). Patrick Hand is read after the first bubble (`showNpcSpeechBubble`); since the canvas's own use loads the face on every build, a second row judges the paint: the bubble's last `fillText` in Patrick Hand ran with the face loaded. The host of each woff2, and layout shifts in the 2 s after each face loads | every welcome-card button and every menu item in Arial (the title and body in Segoe UI, as the audit found); both faces load from fonts.gstatic.com; the bubble painted before Patrick Hand loaded and never again; CLS 0. Exits 1 | the same Arial rows (the Hiring pill in Segoe UI Semibold); both faces from fonts.gstatic.com; the bubble paints with the face loaded (B8); CLS 0. Exits 1 |
| `loader` | DA-10; D12 | desktop and phone. Every `*.woff2` and the fonts.googleapis.com CSS held back, and separately `/assets/main-*.js`, through `openSession`'s `onRoute`, then released in turn. Static run: the static loader's title in the FOUT frame, the faces released, the same title loaded, the bundle released, the JS loader with the faces in. JS run: the bundle first, the JS loader's title in the FOUT frame (its loaded frame is the static run's: once world gen starts the page answers nothing until the loader has gone). Title width is the text's own box (a Range). The phase diff: the share of viewport pixels (sum \|dRGB\| > 48) differing between the static and JS loaders with the faces in, outside `#ld-bar`'s track, `#ld-pct`, `#ld-msg` and `#load-phase`. Screenshots through CDP `Page.captureScreenshot` (`page.screenshot()` waits for web fonts, so it never sees the FOUT frame) | static title 778 px in Arial bold against 471 px in Bebas (1.65; the audit's 775/470 exactly), phone 368/289 (1.27); JS title 384/262 (1.47), phone 375/256; phase diff 2.67% desktop, 9.1% phone. Exits 1 | the same widths; phase diff 2.7% and 9.17%. Exits 1 |
| `bundles` | PERF-12 | static, Node only (no browser; the leak and port rows do not apply): every chunk under `<dist>/assets`, raw, gzip-9 and brotli-11 (`zlib.brotliCompressSync`, quality 11); the main chunk's gzip also through perf-gate's exported `bundleSize` (level 6, within 1%); the Projects panel's '~280 KB app + 175 KB three.js (brotli)' read from the built main chunk against the measured brotli, within 5%, report only. `--compare <dist>` sizes a second build | main-FxtHGAB1.js 907.73 / 279.54 / 224.75 kB, three 657.05 / 168.78 / 138.41 kB (this local build of 58c8849; the audit's main-BT05EkBU.js read 886 / 273 / 219): the quote matches gzip, not brotli. Exits 0 | main-Dh-edStu.js 1,123.45 / 350.32 / 280.20 kB (perf-gate: 351.48 gzip), three 657.12 / 168.81 / 138.48 kB; '~280 KB app' now matches brotli by growth, '175 KB three.js' does not (138.5). 10 chunks, 757.48 kB gzip in all. Exits 0 |
| `mobile` (plateau rows) | B3 | the phone, trusted CDP touches: the stick held at 0.15 and 0.7 of its own radius (the ring's half-width, found from the 166 px hit square as today; 55 px on both builds) for 1.8 s: the speed. B3 wants 2.0 ±0.2 and 5.6 ±0.3 u/s | 5.6 and 5.6 u/s. 0.15 fails | 5.6 and 8.12 u/s (0.7 of the radius already runs, A11's touch run). Both fail |

### Phase-2 probes, wave 4 (P2-E2d)

In `p2/`, rebuilt from the gameplay and guidance audits' reports
(`phase2-audit/results/gameplay.json` GP-03, GP-04, GP-08, GP-13 and
`a.json` GD-09; `phase2-audit/gameplay/` and `guidance/work/` are empty).
Race legs and the boat are flags on `p2/race`, not probes of their own.
Every row reads a wave-4 feature optionally. Baselines as above; these are
also P2-A9's in-repo before-numbers (the Vercel Web Analytics baseline does
not exist).

| Probe | Item | What it measures | 58c8849 | wave-3 main (fcaa649) |
|---|---|---|---|---|
| `p2/feed` | GP-13; P2-A10 | desktop at the spawn on the hub lawn (no cat in aim), the card dismissed, First steps skipped, every `ui.flashMessage` recorded; the persisted counts (`ds_bird_feed`, `ds_cat_feed`) seeded per session. 21 h, bird feed only: the flash (P2-A10: /roost/i) and the count (unchanged). 21 h with cat feed held: a cat throw (the cat count drops by 1). 12 h control: one spent and the ground birds within 2 u of where the pile landed, 6 s later | dayFactor 0 at 21 h: '🌾 Not here — try over open ground', 3 -> 3; with cat feed the same flash and no cat throw (2 -> 2); noon: 3 -> 2, 8 birds. Exits 1 | the same. Exits 1 |
| `p2/landmarks` | GD-09; P2-A13 | desktop, the card dismissed, First steps skipped: for each `construction_${i}` (WORK_SITES order) the player stood 2.2 u out (the first of 8 headings that holds 1.8-2.6 u after a settle) and `[data-hud=prompt]` (else the interaction div) read every 100 ms for 1.2 s. P2-A13: the prompt names board i's name and status, from a fixture of `SignPainter.PROJECT_BOARDS` (`test/probeSafety` pins it to the table; owners.json lists the read); when it does, E opens Projects at `[data-project=<anchor>]` (rankpilot, chocomate, island, banos, insta) with the card's top inside the panel's scroll viewport, and `passport.count()` is unchanged (null when no prompt names a project) | 1 of 5 sites prompts: RankPilot's '🪑 A bench could go here — needs 4 🪵 + 10 🪙', the other four nothing (the audit exactly). Exits 1 | the same. Exits 1. The card locator checked on fcaa649's own anchor path (`showZonePanel({id:'projects'}, {source:'landmark', anchor})`): all five cards in view |
| `p2/build` (export `build`; apart from `p2/building.cjs`) | GP-08; D6 | desktop, the card dismissed, First steps skipped, `ds_timber` 10 and `ds_coins` 30 seeded; the cheapest free structure plot (the build system: the scaffold and its 1.6 s minimum), stood 1.5 u from its seat, E, then the chooser's first `button[data-build-kind]`. The write is blocked, so the build refunds. From that click: the coins' return (every frame), every `ui.toast` call, when the refund text is on screen (the SAMPLER over `#ui-overlay`), and what showed between. D6's deferred row: the refund on screen within 0.5 s of the coins | signpost: coins back at 1.63 s, the refund on screen at 8.47 s (6.8 s late), behind the compass hint and the 'Coins!' hint (the audit's run: 2.7 s and 5.9 s behind the talk hint; the same bug). Exits 1 | coins back at 1.64 s, the refund at 1.77 s (131 ms): D6's row already holds on fcaa649. Exits 0 |
| `p2/coinhunt` | GP-04; P2-A9 | desktop, a fresh visitor on the default world (`__dsSeedDraws` 80842), the card dismissed, First steps skipped, the frozen sim at 1/60 s: the arrival trail walked nearest-first, the total after it; then 3 simulated minutes (`--minutes`) aiming the chase camera at the nearest standing meadow coin with W held (a walk; `--run` adds the run key), re-aimed every 0.25 s, a coin not reached in 12 s skipped: coins per minute. Also the meadow coins within 30 u of the spawn. P2-A9's in-repo before-number | 17.7/min at a walk (the audit's live hunter: 13/min; this steering is perfect and frame-exact), 2 of 80 meadow coins within 30 u (the audit exactly), 5 coins after the trail. Exits 0 | 17.0/min at a walk (20.0 with `--run`, Shift), 2 of 80, 5 after the trail. Exits 0 |
| `p2/race --legs` | GP-03; P2-A8 | desktop: every consecutive ring spacing on both circuits (ring i to i+1, the last back to the finish), great-circle u, against the chase camera's horizon on foot, sqrt(2 R h) with h the camera's height over the player's feet. Reported | land 5 legs of 115.5 u, water 6 of 103.9 u, horizon 16.5 u (h 1.37 u): every leg over it (the audit exactly). Exits 0 | the same. Exits 0 |
| `p2/race --circuit water --craft boat` | GP-03; P2-A8 | desktop: the boat parked nearest the water start, boarded where it lies, then the gates driver (steering by the rings' own positions) for 49 s, backing out after 4 s aground. A beaching: the throttle held, the bow (1.5 u ahead) over land and the hull stopped, counted again only after 0.5 s afloat. Checkpoints passed after the start ring | 0 of 5 checkpoints (the audit exactly), 1 beaching: this driver grinds along the cove's shore instead of re-beaching (the audit's driver: 9). Exits 1 | 2 of 5 checkpoints, 3 beachings in this run (the count follows the steer; provisional). Exits 1 |

The in-repo economy baseline at fcaa649 (`deploy-w3/dist`, 2026-11-14,
`?hour=12`, desktop), P2-A9's before-numbers in place of the Vercel export:
`p2/tour` 6 coins after the four districts (the trail's 5 and one meadow
coin; 2 min, 4 stamps, 1 secret); `p2/quests` six School presses pay +60;
`p2/coinhunt` 5 coins after the trail, then 17.0 coins a minute at a walk
(20.0 running), 2 of 80 meadow coins within 30 u of the spawn. The
delivery-hop delta (main 0) is `p2/gather`'s row, a carry-over for the next
pass.

### Probe fixes from the wave-2 integration

The wave-2 integration read probe defects as product faults. Each was checked
by hand there; these are the probe sides of those hand-offs. Run 2026-11-12
on the merged build (`w2-int`, 95202a6) at `?hour=12`, port 5240, with other
fixers on the machine: counts hold, milliseconds are provisional.

| Probe | Hand-off | What changed | Merged build |
|---|---|---|---|
| `guide` | A (P2-A12) | Skip passes when the card is hidden or folded into the Next chip (`#ds-guide[data-next]`, 'Next: ...'); STATE reports `next` | Skip: 'Next: Projects' folded, `skipped:true`, desktop and phone. Wave-1 main: the card hidden, as before |
| `p2/recruiter` | A (P2-A4) | the 'card' and 'tour' visits press the welcome card's Hiring button (`button[data-recruit]`, the hire card); `data-cta=contact` is Get In Touch | 10 of 10: a guide surface 0.6-0.8 s after the hire card closes, 'Show me' sets the pill to Projects, the tour's `data-hire-tour` found |
| `p2/firstplay` | D (P2-D4) | a reply's buttons are the chat's buttons after it less those before, as multisets (a slice by count returned the chat's 🎤); a villager who walked off between the prompt and E is stood beside and asked again | 16 of 16: 'Open Projects' opens Projects, the contact reply leads to the hire card, 'Show me' on the shop |
| `p2/npcs` | C (P2-C6) | Space is held (swimming) while keeping station beside the Sailor: on the water an idle visitor's 'Hold Space to swim' outranks his talk prompt | the code heard by chat; it opens the beach house |
| `p2/room-a11y` | D | focus already on Leave when the panel closes counts as 0 presses; the probe blurs only when it is elsewhere (a blur leaves Chromium's focus-navigation start on Leave, so Tab stepped past it) | Tab reaches Leave: 0 presses (focus handed back to it), a named BUTTON |
| `p2/copy` | D | the Journal and the checklist are read from `panels.topModal().el`, then the top `role=dialog`, then the old overlay z-index scan (wave 2's modals are not overlay children at z-index 1500) | both read on both devices; their lines now reach the key and fact rules |
| `p2/race` | D (D10) | the name prompt is skipped ('Skip — just browsing') and the finish modal read behind it; FINISH also reads the panel manager's open modal | phone: "Couldn't reach the leaderboard ... saved on this device" + Retry |
| `p2/quests` | A | the Elder Sage is approached by standing 1.4 u beside her, re-placed each poll (`besideNpc`), with the walk as the fallback | her prompt: 'Elder Sage has a request'; after her lines E opens the chat |
| `p2/journey` | A (P2-A1, P2-A12) | after stamps 1-3 the pill is read from the moment the visitor is outside again, for 1 s (P2-A1 hides it in the hall); new Next-chip rows in follow: the chip within 1 s of Skip, and it names a district at each leg until four stamps; a new `chip` scenario (fresh session; after four stamps the chip's rows are the hire card, a race, fishing): its first 'Show me' row sets the pill to that district, and a quest accepted with the chip open (`npcQuests.onTalk('Elder Sage')`) shows in it within 1 s | follow: 4 of 4 halls by 6 min on both devices; after stamps 1-3 the pill names the next district 1-90 ms after the exit; the chip 80 and 54 ms after Skip, a district at all 4 legs. chip: 'Projects' sets the pill to '🚀 Projects'; the quest in the chip after 188 and 245 ms |
| `camera` | B (B11) | `force` times the fade from the frame the camera crosses 1.1 u to the torso (0.35 u above the player's origin, the distance B11's fade reads), not from the force: the orbit glides in for about 300 ms; `opacityAt150msFromForce` keeps the old reading | crossed 1.1 u at 290 ms, 0.35 at 112 ms after it; the camera stops 1.16 u from the feet, 0.94 u from the torso |
| `strafe` | A (A5) | 'as boarded' sets `sinceManualLook = Infinity` after posing (setYaw counts as a manual look and holds the follow); the compare row is one-sided (no more than 10% slower than the compare build), and a new row holds the swing to the pre-A5 37.2°/s (-10%) | 39 °/s as boarded against main's 17 (`followReleased: true`) |
| `lum` | C | each view is the median of `--frames` captures (default 5, 300 ms apart): one frame let a wave crest move the horizon step by 20 L\* | per-frame horizon steps at noon on desktop: 15.6-37.7 L\*, median 33.4 |

### Probe fixes from wave 2 (wave-3 amendments)

The carry-over lines of `wave3-amendments.md` (E). Baselines 2026-11-13:
this branch's dist and wave-2 main (`w2-int`, the same chunk as f79c38c),
other builders on the machine: counts hold, milliseconds are provisional.

| Probe | Line | What changed | This branch | wave-2 main |
|---|---|---|---|---|
| `guide` | guide night | the night talk read and the legacy step read wait out First steps' advance pause (STATE's `justDone` from `__app.guide.view()`; with no readable view, only a step past 2/5 counts), so the card's 2/5 during the 450 ms check no longer ends the read; `--night-hour` takes a list and runs 21,23,2,6 by default, the night-diag proof's hours | 8 of 8 at 21, 23, 2 and 6 h: the Night Watch awake, 6.6-19.3 u at Explore, the card on 3/5 naming him at 11.5-17.9 u and still 10 s on (screenshot `guide-night-h2-talk.png`: 'First steps 3/5', Night Watch under the lamp). Legacy 3 of 3 (3/5, 8.6 s after Explore) | 8 of 8: the Night Watch at 2.9-25.8 u |
| `seed` | seed low tier | `--profile lowtier` is judged, not only reported: three fresh boots and `ds_arrived='1'` identical, and equal to the golden when `lib.goldenFor` has an entry for the tier (the differing marks are listed); with no entry the row is report-only | 6 of 6: 80842 on every boot on both tiers, equal to the golden; a golden with the low tier's `coins` mark moved by one fails the row (`coins: 51594 vs 51595`) | 6 of 6, the same numbers |
| `census` | rows other items need (D13) | `--dom` judges the DOM census: 0 emoji in the chrome of the HUD, the menu (the Portfolio menu on desktop, opened by its pill; the drawer on the phone) and the hire card (`ui.showHireCard`). Chrome is a control and what is inside it, a HUD anchor (`[data-guide]`) and, in the menu and hire card, a heading; toasts and live regions, the guide card, chat and body copy are narrative and may keep emoji. '📖 Portfolio' and '💼 Work with me' are exempt as whole labels. A menu or card that did not open reads null. Without `--dom` the DOM census stays report-only | fails, as expected before D13: desktop HUD 10, menu 13, hire card 6; phone HUD 7 (the 👆 USE disc among them), drawer 8 (⌨ Controls & settings among them), hire card 6. The frozen labels were not counted | the same UI (E changes none) |
| `contrast` (a11y.cjs) | rows other items need (D7) | at the first `--hours` hour, the probe renders one glyph pill per ring tint (`span.kg` with `--kg-ring`: use, jump, wave, feed, eat) and one keycap (`kbd.kc`) with the build's own classes, then reads each pill's text against its fill (7:1 or better, target 9:1) and the keycap's computed background (alpha above 0). A build whose stylesheets have no rule for them reads null (the run is then inconclusive, by the null-not-fail convention) | null: no `.kg` or `kbd.kc` rule. On D's wave-3 dist (`w3-D`, 0be5568, read only) at 12 h: the pills 10.85 (use), 9.84 (jump), 13.97 (wave), 9.96 (feed), 8.47 (eat) on desktop and the phone; the keycap rgba(255, 255, 255, 0.14) | null, as on this branch |

### Probe fixes from wave 1 (wave-2 amendments)

The wave-1 fix pass and re-verify found probes that misread the product.
Every boot is now pinned to `?hour=12` (`lib.bootQuery`, `--hour <n|live>`
above), so no probe is judged on the machine's local clock. Baselines
2026-11-12, this branch's dist and wave-1 main (`w1-int`), four other
builders on the machine: counts hold, milliseconds are provisional.

| Probe | Line | What changed | This branch | wave-1 main |
|---|---|---|---|---|
| `guide` | w1-fix, re-verify | the card's overlap check also covers the compass pill, and a 300 ms sampler covers any toast or flash for the whole flow; legacy storage reads the step after the 8 s controls card (20 s window) and again after a reload; B10 measures the last coin to the seat of `scene.getTrailVillager()` (the nearest villager on a build without it) and reports the live distance beside it; each part closes its page; `--part flow\|skip\|reduced\|legacy\|night` runs one part. New night session (`?hour=23`, `--night-hour`, 12 s on the card first): the coins lead to an awake villager, and the talk step names an awake villager within 30 u and still does 10 s on | 60 of 62: every flow, geometry (84-92 samples clear at each size), Skip, reduced-motion and legacy check passes (the step at 3/5, 8.9 s after Explore); B10 1.53 u to the Mayor's seat, "ask anything". The two night checks fail: the Mayor is asleep 20.7 u off at Explore and the card skips to 4/5 with nobody awake within 30 u (screenshot: 'First steps 4/5, See the work') | the same 60; the night checks passed in one run (the Mayor up 6.9-10.4 u away at 23 h) and failed in the next (asleep 18 u off): the sleep goal lands a few seconds after boot. Both are B's to fix (a night watch by the spawn) |
| `fm` | re-verify | m-active compares a prompt beside a toast with the same prompt's width alone (the toast is taken out of layout in the same task), not with a fixed 300 px | 10 samples with both up, 291/291 and 289/289 px: passes (the old bar failed the 289 px door prompt) | not re-run |
| `census` | w1-fix | "props" is what Island builds under `island.mesh` (C3's targets); what GameScene and RaceSystem add to the scene (race gates, the cruise ship, the islet house, road markings, rocks, coins) is "scene props", reported apart until B15; `--scene-props` judges them, and `SCENE_PROPS_JUDGED` folds them in once B15 is on main | C3's scope passes on desktop and the phone; `--scene-props`: 15 lit opaque non-toon (the race gates' MeshStandard #223344 first) and 28 toon without the ramp | not re-run |
| `p2/party` | w1-fix, re-verify | the entry's programs are counted from `enterRoom`'s p0 at the door; the walk across the islet (one shadow-depth program) is reported beside it as `programsBeforeDoor` | +1 from the door, +1 on the walk (bar: 1 or fewer from the door); the frame bars read 193, 60 and 91 ms on a busy host in one run and 49, 17, 22 ms in the previous one | not re-run |
| `p2/nokhr-door` | w1-fix (new) | the first door without `KHR_parallel_shader_compile` through the visitor's own path: Explore, straight to the Professional hall's door, E, in a fresh browser per row; `--pauses 0,3` seconds stood at the door first, `--settle <s>` on the island first; reports whether the near-door warm ran before E, programs, the longest frame and the veil (bar: opaque 1.0 s or less, and the warm ran with the longest pause) | after 3 s at the door: the warm ran, +0 programs, 706-782 ms veil on all three devices. Straight in: it depends on whether the walk outlasted the warm's 1 s: desktop and the low tier caught it (813 and 736 ms), the phone did not (+11 programs, a 1,127 ms frame, 1,709 ms veil); an earlier run missed it on all three (1,665-1,841 ms) | after 3 s: 660-693 ms; straight in, desktop missed the warm (+11, 973 ms frame, 1,536 ms veil), the low tier and the phone caught it (688-689 ms) |
| `axe` | re-verify | from 5 surfaces to the 20 of the wave-1 verify on each device (40): the HUD, the Portfolio menu (the drawer on the phone), the hire card, the four zone panels, 11 modals (passport, island times, pack, journal, leaderboard, guestbook, roster, island map, receipt, say hi, completion), the NPC chat and the name prompt, each opened through the UI's own entry point | 20 of 20 scanned on each device, 0 serious or critical, 0 colour-contrast on the welcome card, the hire card and the NPC chat | the same: 40 scanned, 0 serious or critical |

## Perf gate

`npm run perf:gate` (`tools/perf-gate.cjs`, items E1 and CO-E2) runs on the
same harness. The world clock is pinned to `?hour=12` (night lights change
the light count, the programs and the draws); `--hour live` turns that off.

```sh
npm run perf:gate -- --dist dist --port <n>              # baseline report + counter and µs budget checks
npm run perf:gate -- --dist dist --port <n> --fx <name>  # one __dsFx effect: draws and programs per view, then 6 x 1.5 s per side
npm run perf:gate -- --ab <mainDist> <branchDist> --ports <a>,<b> --cycles 6
npm run perf:gate -- --ab <dist> <dist> --ports <a>,<b> --record-floor   # 24 A/A cycles: writes tools/perf-gate.floor.json
npm run perf:gate -- --rejudge <perf-gate-ab.json>        # the verdict maths again on a saved A/B's loads (no browser)
npm run perf:gate -- --dist dist --port <n> --dusk        # the dusk check alone (add --dusk to --ab to run it on each side)
npm run perf:gate -- --dist dist --port <n> --hour 21     # the night run: the card, the longest task before it, programs at +30 s
```

**Run it alone, on a quiet host (wave-2 amendments).** A verdict taken
while other builders, probes or builds hold the CPU reads inconclusive: the
timing rows' sigma goes over T/2 and nothing resolves. Every load records
the share of the machine other processes took; when a profile's median is
over 10% (`QUIET_OTHER_PCT`) the summary prints `note: host not quiet ...
Run the gate alone` under it (`hostNote`). Counters (draws, programs, nodes,
bytes, the bundle) hold on a busy host; timings do not. The integration runs
`--ab` by itself after the builders have stopped, and a floor recorded on a
busy host is marked and re-recorded.

- Profiles: desktop 1440x900, the 1x low tier, and startup-only at 4x CPU
  (GPU timer queries off).
- Each load: the startup marks, then 30 s after the card (past the interior
  warm and the late compiles) programs, nodes and textures, then the views
  in `VIEW_DEFS`: idle spawn, hub-wide and the Projects district, posed with
  the design audit's framing (follow direction, pitch, distance, teleport).
  Counters are one whole frame with the loop paused (draws, triangles,
  programs, textures); timings are 1.5 s windows (CPU per app frame, GPU
  timer queries, fps). `programs after the views` is judged too. Then the
  two driven views of P2-E3, the vehicle view and the room view (below).
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
| desktop | CPU p95 +1.0 ms; GPU p50 +2.0 ms; draws spawn +50, hub-wide +80, Projects +60, vehicle +60, room main + 25; programs +5; welcome_visible +150 ms; world_gen +50 ms; before the card: long tasks over 50 ms main + 1, the longest task +50 ms, +50 KB transferred. The first door (absolute, side B): its longest frame 100 ms or less, 3 programs or fewer |
| low tier (1x) | CPU p95 +0.75 ms; draws spawn +20, hub-wide +30, Projects +25, vehicle +25, room no more than main; programs +3; scene nodes +150; textures +6 MB; +50 KB before the card. The first door: its longest frame 200 ms or less, 3 programs or fewer |
| startup (4x) | welcome_visible +400 ms; world_gen +200 ms; long tasks main + 2, the longest task +50 ms; +50 KB before the card |
| FxBudget (`FX_US`) | per effect 150 µs a frame on desktop and 80 on the low tier; all effects 600 and 300. An effect in plan-r3's ledger (`FX_LEDGER`) is held to its ledger value where that is lower, in `--fx` and in the CPU proxy |
| Per-effect bars (`FX_BARS`, wave 4) | `--fx <name>` holds an effect with its own plan-r3 bars to them instead of the tier's: `canopySway` (C9) GPU p50 +0.3 ms or less and 0 programs added, ledger 0 µs. A build that never registers the effect reads `n/a` (exit 3), not a verdict: fcaa649 reads n/a |

CPU p50 and triangles have no budget and are reported.

Verdicts, per metric:
- Timings (CPU p95, GPU p50, welcome_visible, world_gen, the longest task):
  delta is the median of the paired (B − A) cycle differences, and sigma
  the 95% band of delta, t(0.975, n−1) × 1.2533 × SD(B − A) / √n, so it
  pools both sides' noise and the ABAB pairing cancels drift. Valid when
  sigma <= T/2; pass when valid and delta <= T; fail when valid and
  delta > T + sigma; anything else is inconclusive, escalating to 12, then
  24 cycles.
- The paired sign test (`sign` in the JSON: pairs over T, n, and the count
  it fails at) fails a timing, valid or not, when so many of its n pairs
  are over T that a true median shift of T or less would give that many
  with probability 0.005 or less (`SIGN_ALPHA`): 8 of 8, 11 of 12, 19 of
  24, never at 6 cycles. Otherwise an invalid result never fails. Wave 1's
  integration A/B is why: welcome_visible moved +341 ms with all 24 pairs
  positive, but main's loads sat in three boot-race modes (154, 158 and
  165 programs, the first two ~650 ms faster) and the build's in one (160),
  so the pairs could not be matched mode to mode and sigma read 141 ms
  against T 150: inconclusive. Re-judged, it fails at 12 cycles (12 of 12
  over T). An A/A timing whose noise is as large as T (each side's SD = T)
  fails on it in about 1 run in 700,000 (11 of 12 pairs over T; 19 of 24
  is rarer still). Re-judged against the same floor, none of the nine
  saved runs (four of them A/As) changes verdict except that A/B.
- The same test has a pass path (wave-1 re-verify): a timing the sigma
  rule leaves inconclusive passes when it has 24 pairs or more and none is
  over T (`sign.pass`, `passedBy: 'sign'`, and the row's rule says so). A
  true median shift of T or more gives 0 of 24 with probability 6e-8 or
  less. It never turns a fail into a pass, and the fail path is unchanged.
  welcome_visible, which is paired by boot-race mode, counts its
  cycle-order pairs for this (`signInCycleOrder`), since the mode-matched
  pairing can leave as few as 7. Why: on the re-verify's 24-cycle A/B the
  desktop card was 578 ms earlier (22 of 24 pairs earlier, the other two
  +17 and +48 ms, 0 over T 150) and the row read inconclusive on sigma 369
  against T/2 75. Re-judged (`--rejudge`), that row passes and desktop
  reads pass after 24 cycles; the low tier is unchanged (pass). 4x
  world_gen stays inconclusive: delta -20 ms, but 2 of its 24 pairs are
  over T 200 (+217 and +424 ms).
- CPU p95 whose sigma is still over T/2 at 24 cycles is judged by the
  FxBudget proxy, as a CPU p95 under 2 x its floor is, and the row says so
  (`unresolvable: sigma … > T/2 … at 24 cycles`, `rule: proxy …`). When
  side B has no FxBudget timings (main registers no effect) the proxy
  cannot stand in and the row stays inconclusive. Re-judged, wave 1's
  integration A/B reaches PASS on the low tier this way (spawn σ 0.47 and
  Projects σ 0.56 against T/2 0.375, the proxy passing at 7.9 µs), and its
  desktop hub and Projects CPU rows pass by it at 24 cycles. Its desktop
  world_gen and longest task stay inconclusive at 24 (σ 26.2 and 25.3
  against T/2 25, other processes at 7.4% against the floor's 4.8%): no
  proxy covers them, so a quieter host settles them.
- Counters (draws, programs, nodes, long tasks, bytes; critique-r3): delta
  is median(B) − median(A). Pass when delta <= max(T, floor), an
  improvement of any size included; fail when delta > max(T, floor) +
  sigma, or > max(T, floor) at 24 cycles; otherwise inconclusive.
- Programs ride the boot race (below), so a per-side median jumps by the
  whole gap between its modes (11 programs on s1-int's desktop) whenever
  the two sides' medians land in different modes. Resampling stage 2's
  first 48 A/A loads, that rule failed 'programs (30 s after the card)' in
  about 1 of 6 24-cycle A/As and put |delta| over max(T, floor) in about
  1 of 3. Both programs rows are judged on the race's mix instead
  (`judgeMixCounter`): each side is split at the midpoint of its own
  programs range, as welcome_visible is, and its value is its modes'
  medians weighted by how often each came up, so delta moves by the gap
  times the shift in the mix, and a shift of the whole mode (a real
  regression) moves it fully. sigma is a seeded bootstrap band; the JSON
  keeps each side's modes (`modesA`, `modesB`: loads and median).
- Texture MB is the one exact counter: equal on every A/A load, or the run
  fails.
- The floor, per profile, is in `tools/perf-gate.floor.json` (`--floor
  <file>` reads or writes another), from a 24-cycle A/A on this rig. A
  timing's floor is its 24-cycle sigma; a timing whose T is below twice
  its floor cannot resolve here: CPU p95 is then judged by its proxy (every
  FxBudget effect within its µs budget, and their sum), and the others are
  reported `unresolvable`, not judged. A counter's floor is its A/A spread
  (`aaSpread`, critique-r3's "each counter's 24-cycle A/A spread"): the
  99th percentile of |delta| over 2,000 seeded resampled 24-cycle A/As
  drawn from the run's loads, by the statistic the counter is judged with.
  A counter over max(T, floor) at 24 cycles fails outright, so that
  percentile keeps a false fail near 1 A/A in 100 per counter at the edge.
  (The first floor file held each counter's paired sigma, which
  understates how far median(B) − median(A) moves.) Each row names its
  `rule`.
- welcome_visible rides the boot race (below), so it is stratified: each
  side's loads are split at the midpoint of that side's own program range,
  and the timing is paired within each mode (`strata` in the JSON). When
  one side has a single mode the pairs stay in cycle order (`strata.one`,
  with each side's modes in `modesA` and `modesB`), and the sign test is
  what judges a shift.
- `--record-floor` (A/A only) runs 24 cycles, keeps the verdicts at 6, 12
  and 24 (`checkpoints`), writes the floor file through prettier, and
  judges the same cycles again against it (`withRecordedFloor`). It marks
  each profile `quiet` when other processes took 10% of the machine or
  less (`QUIET_OTHER_PCT`, the median of `otherBusyPct` over its loads);
  a run that reads a floor marked busy, or one that does not say, prints a
  note. `--max-cycles <n>` caps the escalation for a smoke run.
- Exits 0 pass, 1 budget fail, 2 fail-closed, 3 inconclusive.
- `--rejudge <perf-gate-ab.json>` runs the verdict maths again on a saved
  A/B's loads against the current floor (or `--floor`), replaying the
  checkpoints (the first that is not inconclusive ends a profile, as in
  `--ab`), and writes `perf-gate-rejudge.json` with each profile's old
  verdict beside the new one.
- A/A (`--ab dist dist`): the JSON's `aa` block lists the exact counters,
  every |delta| over max(T, floor), and whether any profile failed.
- `hostBusyPct` and `otherBusyPct`: the whole machine's CPU busy share
  during each load, and the share other processes took
  (`lib.hostLoadMeter`; this browser's own share comes from CDP
  `SystemInfo.getProcessInfo`). Other sessions' builds and probes widen
  sigma; a quiet machine gives the tightest verdicts.
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

**Vehicle and room views (P2-E3).** After the posed views every load drives
two more, so `programs after the views` and the three posed views' rows keep
the meaning the floor recorded.

- *Vehicle.* The car nearest the land circuit's start is boarded through
  `scene.boardVehicle`, put on ring 0 heading down the leg to ring 1, and the
  chase camera is turned behind it (the follow direction, or `setYaw` where
  yaw drives it; over 5° off the leg is a missing hook). Then W is held for
  3 s with no pointer input: 38-40 u of the 115.5 u leg, 0.1-1.0 u off its
  great circle. The view's draws and triangles are the drive's mean whole
  frame; its timings pool both 1.5 s windows (each is kept in `windows`).
  Rows: `vehicle: CPU p95 ms`, `vehicle: GPU p50 ms`, `vehicle: draws`
  (+60 desktop, +25 low tier).
- *Room.* The Professional hall by its door, the session's first, the way a
  visitor enters (`p2/room-lib.cjs`'s `enterRoom`: W or the joystick to the
  prompt, then E or a USE tap). The entry records the longest frame, the
  black interval by pixels (hitch's CDP screencast: the veil hides 95% or
  more of the world) and by the veil's opacity, and the programs it adds;
  then, the hall's panel closed, one whole frame's draws and a 1.5 s window
  (`render p50`) from the door end. Rows: `room: first-door longest frame ms`
  and `room: programs added on entry` are absolute bars on side B
  (`judgeAbsolute`: pass when B's median is within the bar; fail when it is
  over and the sign test's count of loads is, 11 of 12 or 19 of 24, or at 24
  cycles; side A is shown beside it); `room: draws` is a counter against
  main; the black interval and `render p50` are reported.
- A whole-frame count always holds a shadow pass: at half rate (E2, the low
  tier's default) every other frame has none, and a single frame would read
  476 or 572 draws by its phase.
- The report mode (`--dist`) holds the first door to the same bars and lists
  the rest.

One report load per tier, 2026-11-11, with four other builders on the
machine (54-79% busy, so the milliseconds are provisional; the counts are
not):

| Build | Tier | Vehicle draws (idle spawn) | First door: longest frame | Programs added | Black, pixels (opacity) | Room draws | Room render p50 |
|---|---|---|---|---|---|---|---|
| 58c8849 | desktop | 1,474 (655) | 247 ms | +2 | 888 ms (793) | 107 | 8.0 ms |
| 58c8849 | low tier | 924 (645) | 1,414 ms | +33 | 2,007 ms (1,941) | 74 | 5.0 ms |
| wave-1 main | desktop | 1,466 (664) | 96 ms | +0 | 682 ms (590) | 105 | 8.9 ms |
| wave-1 main | low tier | 921 (572) | 61 ms | +0 | 681 ms (570) | 74 | 4.5 ms |

This branch (E2's half-rate shadows on the low tier), same rig: desktop
vehicle 1,466 (672), first door 82 ms, +0, 720 ms (604), 105 draws; low
tier vehicle 852 (573), first door 96 ms, +0, 670 ms (560), 74 draws. The
low tier's vehicle draws are the drive's mean frame, so half rate takes
about half the shadow pass off them (921 → 852); its posed views count a
whole frame with the pass, so they stay where main's are (573 against 572).

The floor file carries the new rows since 2026-11-12: a 24-cycle A/A of
wave-1 main (`main-CwSY888O.js`) at `?hour=12`, quiet on all three profiles
(other processes 7.5%, 7.2% and 7.5% of the machine at the median; one
low-tier load at 37.5%). Its desktop world_gen and longest-task floors are
14.6 and 13.9 ms (the busy-host floor the integration recorded first: 20.0
and 18.9). The desktop A/B of the merged build against it, run alone the
same evening (`--profiles desktop --cycles 24`, others about 5% from cycle
5), passes: world_gen Δ 1.5 σ 14.7, the longest task Δ 2.5 σ 13.9 (the
integration's busy run: σ 26.2 and 25.7, inconclusive). The room view on
58c8849 (report mode, low tier, `?hour=12`): the first door's longest frame
1,211 ms, +33 programs, a 1.8 s black interval, 74 draws.

**Dusk check (P2-E3; LT-03, P2-B6, P2-C4).** `--dusk` boots at `?hour=17` in
a browser of its own (a cold GPU program cache), waits 13 s for the interior
warm, moves the clock to 17.5 h through `EnvironmentCycle.debugHour`, and
takes the longest long task, long animation frame or frame gap of the next
6 s. The bar is under 100 ms. A longer frame fails only when the light set
changed or programs were added across it (the flip is a re-link); with
neither, it was the host, and the check is inconclusive. With `--ab` it
runs once per side after the cycles, and side B is held to it. 58c8849:
3,846 ms on desktop and 4,183 ms on the low tier, the lights going from 5
to 17 (10 point and 2 spot lights join) and 34 and 37 programs re-linking.
Wave-1 main: 0 ms on both, the same 5 lights before and after, 0 programs.
This branch, with the host 86-94% busy: 94 ms on desktop and a 200 ms frame
on the low tier, 0 programs and the same lights on both, so the low tier
reads inconclusive there.

**P2-B6's GPU line, restated (wave-2 amendments).** The plan's "scene GPU
at 21 h improves by 0.5 ms or more" cannot be read on this rig: the wave-1
integration's 21 h desktop A/B (6 cycles) gave GPU p50 +0.13 ms at the
spawn, -0.14 ms hub-wide (sigma 1.08) and -0.09 ms at Projects, on absolute
values of 4.8, 9.4 and 5.9 ms, so the 0.5 ms target sits inside the band.
The line is now "no GPU regression at 21 h": `perf:gate -- --ab <main>
<build> --ports <a>,<b> --hour 21`, and no `GPU p50 ms` row fails (each is
held to the desktop budget, +2.0 ms, by the sigma rule and the sign test).
P2-B6's other lines are counts and are unchanged: programs at +30 s (-48 at
21 h), the 21 h card within +300 ms of the 12 h one (`p2/bootcost`), and
the dusk flip under 100 ms (`--dusk`, `p2/duskflip`).

**Bundle check (wave-2 amendments).** Wave 1 took the main chunk over
Vite's 1,000 kB chunk warning. The limit in `vite.config.ts` stays at 1,000.
Every report (`perf:gate -- --dist dist --port <n>`) measures the dist's
`assets/main-*.js` the way Vite prints it (bytes / 1000, gzip at the default
level) against the merged wave-1 main (`BUNDLE.main`):

| Build | raw kB | gzip kB |
|---|---|---|
| main before wave 1 (d5e0e96) | 930.89 | 288.04 |
| wave-1 main (8662b27), the baseline | 1,004.45 | 311.85 |
| ux/w2-perf-gate | 1,005.55 | 312.11 |
| wave-2 main (f79c38c), the baseline from wave 3 | 1,073.23 | 333.82 |

Wave 3 (amendments, bundle) rebases `BUNDLE.main` to wave-2 main f79c38c
(measured on `w2-int`'s dist, the same chunk as 29edc9b). Deltas are
reported against it; `BUNDLE.wave1` and `BUNDLE.beforeWave1` stay for the
record. The +50 kB gzip budget stays anchored at wave-1 main
(`BUNDLE.budgetBase`), so the rebase does not hand it back: wave 2 used
+21.97 kB of it (`budgetUsedKB`), leaving 28.03 kB. The report names
`Multiplayer.ts` as this wave's move (A) and `Chat.ts` as the next
candidate for wave 4 (`BUNDLE.nextCandidate`).

One line gates: gzip no more than main + 50 kB (the plan's "+50 KB
transferred before the card"; the chunk is fetched before the card). Raw
size and "over the warning by N kB" are reported. `--ab` prints side B
against side A and stores both (`bundle` in the JSON). A `--base` run has no
dist on disk and says so.

The lazy-load candidate the report names is `Multiplayer.ts`: 14.07 kB
minified, 5.17 kB gzip, measured on this branch by minifying each module of
the chunk on its own (esbuild) and gzipping it. It is the largest whole
module in the chunk that nothing needs before the welcome card:
`main-simple.ts` builds it after the world and is its only static importer,
so a dynamic `import()` there (A; the file is B's) moves it out and leaves
the chunk about 8 kB under the warning. `Chat.ts` (7.0 kB, 2.77 gzip) can
follow once `SimpleUI.ts` no longer imports its `VOICE_MAX_MS`. That is all
the headroom whole modules give: `GameScene.ts` (257 kB minified),
`SimpleUI.ts` (202), `Island.ts` (145) and `main-simple.ts` (115) are 69% of
the chunk, and the next whole modules that could wait are `Sfx.ts` (11.3),
`RaceSystem.ts` (6.9), `Speech.ts` (6.6) and `DeliverySystem.ts` (5.8), each
imported statically by `GameScene.ts` or `main-simple.ts`. `three-mesh-bvh`
(58.7 kB minified, 42 modules) also sits in the main chunk; it is needed
before the card, so it is not a lazy-load candidate, but
`manualChunks` could move it beside `three`.

**Nights.** `--hour 21` is the night run: every mode takes it, and the card
time, the longest task before the card and the programs 30 s after it are
the rows it already has. (The phase-2 plan asked for an "`--hour 21`
profile"; the flag is that profile.)

**Credits (`--fx`).** `FX_CREDIT` lists what an effect is meant to save, and
`--fx <name>` holds it to that beside the budgets (`judgeCredit`: pass when
the paired delta is at or below the credit, or, for mean CPU, when the 95%
band's upper bound is; fail when even the lower bound misses it). A window
reports the mean frame beside p50 and p95, and `--fx` pairs count shadow
draws. E2's credit, on the low tier: GPU p50 −0.6 ms, mean CPU −0.4 ms, and
47.5 ±3 shadow draws a frame at the spawn; on desktop the switch must change
nothing. `--fx halfShadow --cycles 20` on this branch, 24 cycles, the host
busy: low tier GPU p50 −0.88 ms (σ 0.21), mean CPU −1.46 ms (σ 0.53), CPU
p50 −1.5 ms, shadow draws 96 → 48, draws −48 at the spawn and hub-wide and
−58.5 at Projects, 0 programs; desktop 96 → 96, draws ±0. The run reads
inconclusive on `spawn: CPU p95` alone (σ 1.19 against T/2 0.375 on the
busy host); a quiet host settles it.

**The governor on a CPU-bound phone (E3).** `--governor` loads the
`lowtier4x` profile (390x844, DPR 2, touch, 4x CPU, timer queries off) with
the governor live, never pinned, idles at the spawn after the card, and
reads `getGovernorState()` each second for 30 s (the private fields on a
build without it), then the app frames of the last 5 s. Bars: renderScale
0.9 or more and 16 fps or more. `--gpuheavy` loads the 1x low tier with
`?gpuheavy=1` (the renderer's GPU-bound test case: 40 full-screen draws of
a uniform-bounded loop that write nothing) and records when renderScale
first drops under 0.9 (bar: 20 s). Single runs on 2026-11-13, other
builders on the machine (other processes 43-66% of the host), so the fps
are provisional: wave-2 main 0.48 at 30 s, 13.4 and 20.2 fps in two runs;
this branch 1.0 and 20 fps (CPU-bound from the first second, rung 3).
`?gpuheavy=1` on this branch: under 0.9 at 17 s (0.81 at 18 s, fps 33 to
49). The GPU-heavy pass has to be about 60 ms of GPU on this rig: the low
tier here estimates 75 Hz and delivers 37.5 fps under its 60 cap, so its
shed bar is 28 fps, and headless rAF ignores GPU work until the queue
backs up. A frame stalled by GPU back-pressure also reads as CPU time, so
`cpuBound` flickers under `?gpuheavy=1`; the resolution still sheds.

**Behind a modal (E4).** `--fx modalDivisor` runs the modal scenario on
`lowtier4x` instead of the off/on frame pairs (`--pairs` keeps those): the
Projects panel opened through the drawer and the Portfolio menu, then the
switch alternated off and on behind it, 4 s a side for `--cycles` (default
4): main-thread busy ms per second (long tasks and long animation frames
merged), Event Timing durations (`durationThreshold` 16) of taps on the
panel's own buttons (`--no-taps` leaves the panel alone), the panel region's
pixels on against off (`modal-panel-on.png` and `-off.png` beside the JSON)
and the governor rung before and after. Bar: busy under 400 ms/s with the
switch on. Wave-2 main (no divisor, both sides the same): 964 ms/s on
median, taps 272-280 ms. This branch: 334 ms/s on against 743 off on a
calmer host, 518 against 956 with two probe lanes running beside it; taps
80-96 ms on against 160-320 off; the panel region identical; the rung 3
before and after. The divisor counts rAF frames AND holds at least 3x the
last frame's CPU time of wall per rendered frame: the count alone left
890 ms/s busy, because a CPU-bound phone's skipped ticks cost nothing and
its costly frames still ran back to back.

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
~0.6 s later on the median, so welcome_visible is bimodal too. On s1-int,
desktop reads 154 or 165-166 and the low tier 101 on every load, and the
mix follows the host: 154 on 19 of 48 desktop loads with the host busy
(the first floor's run), on 3 of 48 on a quiet one (below).

**A/A on s1-int (CO-E2).** `--ab <s1-int> <s1-int> --ports 5196,5197
--record-floor`, 2026-11-04, after the review: 144 loads, 24 cycles a side
on desktop, the low tier and startup, on a quiet host (other processes at
a median of 4.8% of the machine on desktop, 5.1% on the low tier and 5.9%
at startup, the whole machine 13.7-15.5% with this browser), so the floor
file is marked quiet on every profile:
- No FAIL at 6, 12 or 24 cycles on any profile. Each stays inconclusive on
  one timing whose sigma is over T/2 at 24 cycles (spawn CPU p95 on
  desktop, hub CPU p95 on the low tier, the longest task at 4x), and every
  counter passes; programs on the mix read Δ −0.46 (σ 1.60) and −0.88
  after the views on desktop, 0 on the low tier.
- The pose check is equal on both tiers: camera pitch 0.62 rad hub-wide and
  0.38 rad at Projects on every load of both sides (orbit pitch −0.62 and
  −0.38).
- Texture MB is 18.52 on all 96 desktop and low-tier loads.
- Desktop programs: 165 on 44 loads, 154 on 3, 166 on 1.
- Judged against the floor it recorded, the same 24 cycles pass on all
  three profiles, and every |Δ| is within max(T, floor).
- 0 leaks, and a boot proof on every load.

Resampled 300 times as 24-cycle A/As: on the first floor's 48 busy-host
desktop loads, the stage-1 counter rule (per-side medians, the paired-sigma
floor) failed 'programs (30 s after the card)' in 64 and 'programs after
the views' in 53, and put their |Δ| over max(T, floor) in 109 and 93; the
mix with its recorded spread fails each in 2 and puts each outside in 2.
The 4x long-task counter, at the edge of its budget there, went from 24
fails and 56 outside to 0 and 1. On this quiet run's loads no counter
fails; the 4x long tasks fall outside max(T, floor) in 2 of 300 under
either rule.

The floors, against each budget (a timing is judged directly only when
T >= 2 × floor; a timing's floor is its sigma, a counter's its resampled
spread):

| Profile | Metric | floor | T | judged by |
|---|---|---|---|---|
| desktop | spawn: CPU p95 ms | 0.64 (sigma) | 1.00 | proxy: FxBudget µs (T < 2 × floor) |
| desktop | spawn: GPU p50 ms | 0.08 (sigma) | 2.00 | sigma rule |
| desktop | spawn: draws | 9.50 (spread) | 50.0 | counter, max(T, floor) = 50.0 |
| desktop | hub: CPU p95 ms | 0.47 (sigma) | 1.00 | sigma rule |
| desktop | hub: GPU p50 ms | 0.42 (sigma) | 2.00 | sigma rule |
| desktop | hub: draws | 31.0 (spread) | 80.0 | counter, max(T, floor) = 80.0 |
| desktop | projects: CPU p95 ms | 0.34 (sigma) | 1.00 | sigma rule |
| desktop | projects: GPU p50 ms | 0.10 (sigma) | 2.00 | sigma rule |
| desktop | projects: draws | 9.50 (spread) | 60.0 | counter, max(T, floor) = 60.0 |
| desktop | programs (30 s after the card) | 1.83 (spread) | 5.00 | counter on the boot-race mix, max(T, floor) = 5.00 |
| desktop | programs after the views | 2.38 (spread) | 5.00 | counter on the boot-race mix, max(T, floor) = 5.00 |
| desktop | welcome_visible ms | 20.9 (sigma) | 150 | sigma rule |
| desktop | world_gen ms | 14.7 (sigma) | 50.0 | sigma rule |
| desktop | longest task before the card ms | 14.2 (sigma) | 50.0 | sigma rule |
| desktop | long tasks > 50 ms before the card | 1.00 (spread) | 1.00 | counter, max(T, floor) = 1.00 |
| desktop | bytes before the card (KB, transfer) | 0.00 (spread) | 50.0 | counter, max(T, floor) = 50.0 |
| low tier | spawn: CPU p95 ms | 0.27 (sigma) | 0.75 | sigma rule |
| low tier | spawn: draws | 6.50 (spread) | 20.0 | counter, max(T, floor) = 20.0 |
| low tier | hub: CPU p95 ms | 0.39 (sigma) | 0.75 | proxy: FxBudget µs (T < 2 × floor) |
| low tier | hub: draws | 5.50 (spread) | 30.0 | counter, max(T, floor) = 30.0 |
| low tier | projects: CPU p95 ms | 0.20 (sigma) | 0.75 | sigma rule |
| low tier | projects: draws | 9.00 (spread) | 25.0 | counter, max(T, floor) = 25.0 |
| low tier | programs (30 s after the card) | 0.00 (spread) | 3.00 | counter on the boot-race mix, max(T, floor) = 3.00 |
| low tier | programs after the views | 0.00 (spread) | 3.00 | counter on the boot-race mix, max(T, floor) = 3.00 |
| low tier | scene nodes | 2.50 (spread) | 150 | counter, max(T, floor) = 150 |
| low tier | texture MB | – | 6.00 | exact |
| low tier | bytes before the card (KB, transfer) | 0.00 (spread) | 50.0 | counter, max(T, floor) = 50.0 |
| startup | welcome_visible ms (4x) | 55.4 (sigma) | 400 | sigma rule |
| startup | world_gen ms (4x) | 40.4 (sigma) | 200 | sigma rule |
| startup | longest task before the card ms (4x) | 40.8 (sigma) | 50.0 | reported, not judged (T < 2 × floor) |
| startup | long tasks > 50 ms before the card (4x) | 2.50 (spread) | 2.00 | counter, max(T, floor) = 2.50 |
| startup | bytes before the card (KB, transfer) (4x) | 0.00 (spread) | 50.0 | counter, max(T, floor) = 50.0 |

On the quiet host the timing floors are 2.5 to 16 times smaller than the
first file's, so more of them are judged directly: on desktop
welcome_visible, world_gen, the longest task and the hub-wide and Projects
CPU p95; on the low tier the spawn and Projects CPU p95; at 4x
welcome_visible (world_gen at 4x already was).
Desktop's spawn CPU p95 and the low tier's hub-wide CPU p95 still have a
floor over half their budget, so they go to the FxBudget proxy; s1-int
registers no effect yet, so the proxy reads n/a there until stage 2's
effects register (each is then held to its µs budget). The longest task at
4x is reported. A counter whose spread is over its budget (the 4x long
tasks, 2.5 against 2) is judged at the spread: that is as fine as this rig
resolves.

**A/B, s1-main against s1-int.** `--ab <58c8849> <s1-int> --ports 5192,5193
--cycles 6 --max-cycles 6`, 2026-11-04, the host 12-14% busy:
- The savings are gone: desktop hub-wide draws Δ +8 and Projects −9.5
  (stage 1: −949 and −404), the low tier +6 and +7. The pose check is
  equal on both tiers (camera pitch 0.62 and 0.38 rad on both builds).
- Programs 30 s after the card: desktop −50.5 on the mix, the low tier −12.
- Against the first floor, desktop and the low tier passed after 6 cycles
  and startup stayed inconclusive (world_gen at 4x: sigma 123 ms against
  T/2 = 100). Re-judged against the quiet floor (the same loads, offline,
  `metricTable`), desktop and the low tier read inconclusive at 6 cycles:
  the timings the old floor left unjudged (hub-wide and Projects CPU p95
  and welcome_visible on desktop, spawn CPU p95 on the low tier) are judged
  now, and 6 cycles of two builds leave their sigma over T/2, so a run
  without `--max-cycles` escalates. Every counter still passes. 0 leaks.

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
- Phase 2, wave 1, in `p2/`: `walkin.cjs` (walkin, nokhr-door), `survey.cjs`,
  `passport-interior.cjs`, `party.cjs` (party, partyoff), `bootcost.cjs`,
  `duskflip.cjs`, `journey.cjs`, and the `room-lib.cjs`, `L.cjs`,
  `play-lib.cjs` and `guide-lib.cjs` libraries.
- Stage 2, wave 2: `intro.cjs`, `camera.cjs`, `lum.cjs`.
- Stage 2, wave 4 (E6d): `slide.cjs`, `swim.cjs`, `env.cjs`, `texgen.cjs`,
  `webp-edge.cjs`, `fonts.cjs`, `loader.cjs`, `bundles.cjs` (static, Node
  only), and `mobile.cjs`'s plateau rows.
- Phase 2, wave 4 (P2-E2d), in `p2/`: `feed.cjs`, `landmarks.cjs` (its
  `PROJECT_BOARDS` fixture pinned by `test/probeSafety`), `build.cjs`,
  `coinhunt.cjs`, and `play.cjs`'s `p2/race --legs` and `--craft boat`.
- Phase 2, wave 2, in `p2/`: `light.cjs` (daycycle, weather, beacons,
  shadowdraws, edge-crawl), `rooms.cjs` (room-a11y, room-phone, room-light,
  room-rig, avlum, warmtest, room-census), `guidance.cjs` (recruiter, npcs,
  copy) and `play.cjs` (firstplay, race, quests). `L.cjs` adds the terrain
  zones, the bulb mask and the hue helpers; `room-lib.cjs` adds `IA.lum`,
  `IA.lights` and `IA.windowRegion`.
- `lock-census.cjs` the static census over `tools/owners.json`.
- `../owners.json` the ownership table and the contract-check allow-list.
- `test/probeSafety.test.ts` pins `classify()`, `leakReason()`, the boot
  proof, the reCAPTCHA stub and the exit codes; `test/helpers/astSlice.ts` (with
  `test/astSlice.test.ts`) is the shared read-only AST slicer for stage-2
  locks: `methodBody(file, 'Class.method')`, `functionBody(file, name)`,
  `statementAt(file, marker, { within, kind: 'if', nth })`.
