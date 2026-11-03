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

Ports are always arguments. Suggested ranges, so parallel builders do not
collide: E 5190-5199, A 5200-5209, B 5210-5219, D 5220-5229, C 5230-5239.

Exit codes: `0` pass, `1` criterion fail (including a hook the plan's
contracts promise going missing), `2` fail-closed (a request got past the
harness), `3` inconclusive (setup error, probe crash, no boot signUp
intercept, or a check that could not be made, such as an overlay whose
opener is missing). On main every stage-1 probe exits 1 (main has the bugs
the stage-1 items fix) except three: `axe` passes, `rig` is a regression
guard that exits 0 unless `--compare` finds a difference, and `lock-census`
passes on this branch (it exits 1 with `--ref origin/main`, before the
relocations land).

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

A run fails closed (exit 2) only when something gets past: a response from
a blocked host, a `route.continue()` to one, or a non-GET reaching the
network. Every intercepted attempt is logged with method and host (`net` in
the JSON), and a run counts only if that log shows the boot
`POST identitytoolkit.googleapis.com …signUp` as intercepted.

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

## Probes and the items they serve

| Probe | Item | What it measures | Main baseline (this rig) |
|---|---|---|---|
| `arrow` | A1 | 24 off-axis bearings (the audit's set): arrow side vs target side, mean \|error\| | 0/24 same side; unwrapped mean error 148.8° (audit 148.1°) |
| `follow` | A1 | keyboard follower steering by the arrow toward the Projects zone; distance at 25 s, label flips | walks away, 103 → 121 m; `--mirror` (self-test) arrives in 18.7 s |
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
| `lock-census` | EL, AL, BL, DL | every literal source read in `test/*.test.ts`, owners, rules, vs the relocation table (static, no browser; `--ref <git ref>`) | reproduces the relocation table on `origin/main` |

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

## Perf gate

`npm run perf:gate` (`tools/perf-gate.cjs`, item E1) runs on the same
harness. The world clock is pinned to `?hour=12` (night lights change the
light count, the programs and the draws); `--hour live` turns that off.

```sh
npm run perf:gate -- --dist dist --port <n>            # baseline report + counter and µs budget checks
npm run perf:gate -- --dist dist --port <n> --fx <name>  # one __dsFx effect, interleaved 6 x 1.5 s per side
npm run perf:gate -- --ab <mainDist> <branchDist> --ports <a>,<b> --cycles 6
```

- Profiles: desktop 1440x900, the 1x low tier, and startup-only at 4x CPU
  (GPU timer queries off).
- Views: idle spawn, hub-wide and the Projects district, posed with the
  design audit's framing (follow direction, pitch, distance, teleport).
  Counters are one whole frame with the loop paused (draws, triangles,
  programs, textures); timings are 1.5 s windows (CPU per app frame,
  GPU timer queries, fps).
- Programs are logged per render() and per compile call; µs per effect come
  from `FxBudget.ts` (`__dsFx.stats`), divided by the frames the gate saw.
- Validity: sigma = |median(A_odd) - median(A_even)|; valid when
  sigma <= threshold/2; pass when delta <= threshold; fail when
  delta > threshold + sigma; else inconclusive, escalating to 12, then 24
  cycles. Exits 0 pass, 1 budget fail, 2 fail-closed, 3 inconclusive.
- Output: `perf-gate-<mode>.json` and `ledger.md` (one row per registered
  effect) in `--out`.

## Files

- `lib.cjs` the shared harness: serving, launch, safety, profiles, boot,
  in-page helpers, the virtual clock, numbers and contrast maths.
- `run.cjs` the CLI.
- `compass.cjs` (arrow, follow), `keys.cjs` (clash, cardkeys, sheet-lock),
  `look.cjs` (look, strafe), `rig.cjs` (legspin, rig), `frames.cjs`
  (hitch, seed), `panels.cjs` (guide-me, back), `a11y.cjs` (contrast, axe).
- `lock-census.cjs` the static census, reused by E7's lockOwnership test.
