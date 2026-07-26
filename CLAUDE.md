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

## Recurring concerns (read before touching)

- **Terrain is a raycast/analytic hybrid.** `terrainRadiusFor` / `analyticSurface` are raycast-free and cheap (~0.003ms); `sampleSurfaceByDirection` raycasts the mesh (~1.24ms — expensive). Prefer analytic on hot/startup paths. Mesh is a 128×128 sphere (~1.08-unit vertex spacing): features narrower than that can't be resolved (the summit-trail width constraint).
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

Life Island + Planet Messenger share architecture (`Integrated Project Requirements_ DigiScalability Life Island & Planet Messenger.md`). If a change affects Planet Messenger's contract, note it in the Sessions DB handoff; don't edit cross-repo.

## Checkpoint protocol

When I say "checkpoint", when you hit an error/limit, or when we wrap:

1. Summarize session in ≤6 bullets
2. Write to `.claude/LOCAL-STATE.md` (replace entire file — branch, files in flight, visual state captured, next step)
3. Update the Notion State page "Last session summary" via MCP
4. Create a row in the Notion Sessions DB (Venture=PortfolioIsland, Surface="code", Status=Checkpointed, What I was doing, Next step, Blockers)
5. Confirm in chat: "Checkpointed. See Notion [URL]."

Do ALL FIVE steps — Notion writes must complete. If MCP fails, save locally and flag loudly.
