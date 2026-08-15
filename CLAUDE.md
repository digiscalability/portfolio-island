# Portfolio Island (Life Island) — Claude Code context

This repo is part of a multi-venture operator setup. **Portfolio Island / "DigiScalability Life Island" is a product under DigiScalability** (parent holding co). Live state and decisions are tracked in Notion, not in this file. **Read Notion FIRST.**

## Live state (read this before anything else)

Fetch via Notion MCP: _State page URL was never set up._ Until it is, skip step 1 and use `.claude/LOCAL-STATE.md` plus Claude's memory (`project_portfolio_island_revival.md`) for last-session context.

Before answering my first prompt in any session:

1. Fetch the State page above
2. Read "Last session summary", "Open threads", "Decisions locked in"
3. Also read `.claude/LOCAL-STATE.md` for local-only context from the last Code session
4. Acknowledge where we left off in ≤20 words, then wait for my prompt.

## Operator context

I'm Abbas — Melbourne-based, solo founder of DigiScalability (parent). Portfolio Island is the 3D interactive portfolio / "Life Island" product. Related product: Planet Messenger (integrated architecture — see `Integrated Architecture Design_ DigiScalability Life Island & Planet Messenger.md`).

When I arrive, assume I'm resuming. Never ask "what would you like to work on today?" first.

## Output discipline

- No preamble, no self-narration
- Concise prose. Code blocks for code.
- Plans when asked, not docs.

## Decision autonomy

- Reversible + context → act, tell me after
- Irreversible (prod deploy, money, public asset changes) → ask first

## Stack (don't ask)

- **Runtime:** Three.js spherical-world scene — island planet, interactive props, orbit camera, player movement, real-time multiplayer.
- **Language:** TypeScript. Live entry is `main-simple.ts`. The active stack is the `Simple*` + scene files at repo root — the two big ones are `GameScene.ts` (light rig, shadows, update loop, input glue) and `Island.ts` (terrain, sea shader, grass, trail); plus `SimpleUI.ts`, `SimplePlayer.ts`, `SimpleRenderer.ts`, `SimpleInputManager.ts`, `Multiplayer.ts`, `EnvironmentCycle.ts`, `RaceSystem.ts`, `DeliverySystem.ts`, `NpcQuests.ts`, `Accessibility.ts`, `Analytics.ts`, `Moderation.ts`. (The old scattered Camera/Environment/InputManager/etc. files are gone — they lived in `_legacy/`, now removed.)
- **Backend:** Firebase — anonymous Auth + Realtime Database (RTDB) for multiplayer presence and cloud player profiles (`firebaseClient.ts`, `profileSync.ts`, `Multiplayer.ts`). Loaded **lazily**, off the startup critical path — keep it that way (import `firebaseClient` dynamically, never statically from an eager module). `functions/` holds Cloud Functions.
- **Deploy:** Vercel — LIVE at island.digiscalability.com via `vercel --prod --yes`. Branch pushed to GitHub (`digiscalability/portfolio-island`). (Firebase Hosting / Google Cloud VM are no longer used.)
- **Dev env:** `npm run dev` (Vite, pinned to port 5173). Windows: stop leaked servers by PID, never `pkill` (a no-op here).

## World laws (non-negotiable — check EVERY new asset against these)

These are not style preferences. Each one was learned by shipping the
opposite and having it reported as broken.

1. **THINGS THAT STAND, STAND PLUMB.** Trees, palms, buildings, market
   stalls, lamp posts, towers, houses, parked cars and *people* all take a
   RADIAL up-axis (`position.clone().normalize()`), never the terrain's
   slope normal. Only the POSITION follows the ground. A rigid object raked
   over to match a hillside reads as collapsed, not planted — and a villager
   raked over reads as a corpse propped against the scenery.
   - Seat with `setFromUnitVectors(AXIS_Y, plumbUp)`.
   - `GameScene.orientAvatar()` enforces this for every villager; use it for
     people and `orientObj` only for props whose forward is −Z.
   - **`faceObjectToward` PREMULTIPLIES about the axis you hand it** — pass
     the plumb axis, or it quietly re-tilts what you just made vertical.
   - The exception is genuinely soft/organic ground clutter (grass, rocks,
     feed piles), which may follow the normal.

2. **THE AVATAR RIGS HAVE NON-IDENTITY REST POSES.** On `player.glb` and
   `npc.glb` the limb bones hang at ~±π (the limb axis is local +Y, so
   `rotation.x = 0` points a limb straight UP). Any constant written
   ABSOLUTELY to `bone.rotation.x` wipes that rest and flips the limb 180°.
   - Anchor absolute writes to `-Math.PI` (the wave, the swim stroke, the
     swim legs were all shipped broken this way), or compose onto a cached
     rest quaternion (`l.b.quaternion.copy(l.rest).multiply(...)`) — which
     is MANDATORY on `npc.glb`.
   - Never lerp from the live `rotation.x` near ±π: three.js reports +3.13
     one frame and −3.13 the next, so the limb picks a new direction each
     frame.
   - Remote peers keep their OWN copies of these poses in `SimplePlayer` —
     fix both or other players stay broken.

3. **MEASURE THE RIG, DON'T REASON ABOUT IT.** Every "floating" or
   "backwards" bug this project has had was a clearance applied twice or an
   offset taken from the wrong anchor. Probe the actual world position of
   the bone/vertex and work backwards from the number before touching a
   constant. The avatar's ROOT is at its FEET; joint heights are not
   guessable.

## Recurring concerns (read before touching)

- **Terrain is a raycast/analytic hybrid — and the raycast is NOT expensive any more.** `terrainRadiusFor` / `analyticSurface` are raycast-free (~0.003ms). `sampleSurfaceByDirection` raycasts the mesh, and this file long claimed ~1.24ms — that number predates `computeBoundsTree()` (the three-mesh-bvh accel structure built right after displacement) and was stale by ~200x. RE-MEASURED 2026-08-16 over 400 golden-spiral directions, warm: **0.008ms at R=75, 0.005ms at R=100** (analytic 0.003ms both) — i.e. only ~2-3x the analytic path, and radius-FLAT because the BVH is O(log n). Prefer analytic on genuinely hot per-frame paths, but do NOT contort a design to avoid one raycast: the old figure was actively pushing decisions the wrong way. Mesh is `round(radius x 5.8)^2` (435^2 = 190k verts at R=75; 580^2 = 338k at R=100), so **EQUATORIAL vertex spacing is pinned at 2pi/5.8 = 1.083u at ANY radius** — only the vertex COUNT scales with R^2. CAVEAT (measured 2026-08-16): SphereGeometry puts `widthSegments+1` verts on EVERY latitude row, so longitudinal spacing is `1.083 x cos(lat)` — ~0.76u at the summit band and collapsing toward zero at the poles. The island is most over-tessellated exactly where the hub town is densest, which is why the seg factor is the biggest untapped vertex lever (and why it needs a summit-trail walkability probe before anyone touches it — 5.8 was chosen to fix a shipped bug). The old "128×128" claim here was false and made a radius grow look far more dangerous than it is.
- **The world radius lives in `WorldScale.ts`, not at a call site.** `WORLD_RADIUS` plus `reliefScale` / `areaScale` / `beltScale` / `WORLD_ERA`. Two unit systems exist and radius is the exchange rate between them: ANGULAR quantities (lon/lat, claim arcs, wander steps) scale for free; ABSOLUTE ones (buildings, colliders, speeds, relief heights) do not — with one deliberate exception: REACH radii (chat proximity, feed call radii) are fractions of the world (`0.35 × R` etc.), because the things they reach spread out with the planet. Write spacing as `island.arc(metres)`, never as a radian you worked out by hand — `test/radiusUnits.test.ts` fails the build on a bare literal.
- **Sea shader.** Wave displacement is injected via `onBeforeCompile`; the CPU `waveHeightAt` MUST mirror the shader math exactly, and normals are perturbed analytically. `seaLevel()` / `isOverWater()` stay pinned to MEAN sea level — tide is visual-only.
- **Three.js disposal.** Dispose geometries / materials / textures on teardown to avoid GPU leaks (there's a known LIVE-only dispose warning still being chased).
- **`instanceColor` multiplies `vertexColor`** in three.js — the cause of the earlier near-black grass.

## What I hate (don't suggest)

- Swapping Three.js for another 3D engine
- Moving off Firebase
- "Let me restructure the scene graph" — only refinement, not rebuilds
- Long explanations when visual testing (Playwright screenshots) would answer faster

## Visual regression protocol

Before claiming a visual fix worked, capture a fresh screenshot of the affected state with the in-app Browser preview tools (dev server on port 5173), verify against what the change intended, and describe what actually rendered. Don't trust "looks good in my head." (The old `.playwright-mcp/` baselines were archived to `_legacy/` and removed.)

## Cross-venture awareness

Life Island + Planet Messenger share architecture (`Integrated Project Requirements_ DigiScalability Life Island & Planet Messenger.md`). If a change affects Planet Messenger's contract, note it in `.claude/LOCAL-STATE.md`; don't edit cross-repo.

## Checkpoint protocol

When I say "checkpoint", when you hit an error/limit, or when we wrap:

1. Summarize session in ≤6 bullets
2. Write to `.claude/LOCAL-STATE.md` (replace entire file — branch, files in flight, visual state captured, next step)
3. Confirm in chat: "Checkpointed."

`.claude/LOCAL-STATE.md` is the ONLY handoff surface — it must stand alone for a
session that has no other context. The Notion State page and Sessions DB were
dropped from this protocol (2026-08-09): the State page URL was never set up, so
the steps only ever produced a failure to flag.
