# Architecture

How Life Island fits together, and an order to read it in. Line counts and
names were checked against the code on 2026-11-03.

Most of the client lives in four files at the repo root, 38,958 lines between
them: `GameScene.ts` (15,133), `Island.ts` (10,163), `SimpleUI.ts` (7,917) and
`main-simple.ts` (5,745). They grew with the world. The world is generated
from a seeded random stream, so the order in which things are built is part of
the contract: a change that adds or moves a draw moves the whole world, and the
golden census in `test/tierParity.test.ts` fails. That is why changes here land
as careful refinements inside these files rather than rewrites. The search
anchors below (method names and the `// ──` section headers) will get you
around them faster than scrolling.

## The map

```text
Browser (Vite build, hosted on Vercel)
  main-simple.ts        SimpleApp: boot sequence, the per-frame update, keys → actions
  ├── SimpleRenderer.ts   WebGL renderer, device tiers, the desktop-only bloom chunk
  ├── GameScene.ts        the THREE.Scene: lights, villagers, animals, vehicles, interiors
  │   └── Island.ts       the planet: terrain, sea, grass, districts, placement, props
  ├── SimpleUI.ts         every DOM panel and the HUD (PanelManager.ts decides who owns the screen)
  ├── SimplePlayer.ts, OrbitCamera.ts, SimpleInputManager.ts
  ├── NpcActivities.ts, NpcChat.ts, Speech.ts          the villagers' day, chat and voice
  └── Multiplayer.ts, Chat.ts, Boards.ts, WorldState.ts  the shared world (Firebase, loaded lazily)

Firebase (project life-island)
  Realtime Database     presence, profiles, guestbook, leaderboards, leads, bank, world/island
  Cloud Functions       npcChat, npcVoice, agentSession, vaultOp,
  (functions/src)       planner, analyst, director, janitor, onLeadCreated
```

## Reading path

1. **The small files that define the world's shape.** `WorldScale.ts` holds
   `WORLD_RADIUS` (100) and the rule for its two unit systems: angles scale
   with the planet, absolute sizes don't, and spacing is written as
   `island.arc(metres)`. `Districts.ts` is the layout: the Welcome hub at the
   north pole and four districts on a ring at 26.6°N, 90° apart.
2. **`main-simple.ts`, the app.** `SimpleApp.init()` is the boot sequence in
   order: the UI first (it shows the loading screen), the renderer, then
   `new GameScene()` and `scene.ready()` (the long synchronous world build),
   then the systems (deliveries, quests, multiplayer, chat). Firebase, the music
   and the profile sync wait for idle time. `SimpleApp.update(deltaTime)` runs
   once a frame and covers the input, the player or the vehicle being ridden,
   the interaction keys (E, and Q/F/G/M) and the HUD.
3. **`Island.ts`, the planet.** The constructor calls `createIsland()`:
   terrain displacement, the BVH that makes raycasts cheap
   (`computeBoundsTree` from three-mesh-bvh), the sea, the grass, the
   districts and the props. Every other module uses its surface queries:
   `analyticSurface` (no raycast), `sampleSurfaceByDirection` (a BVH raycast),
   `waveHeightAt` (the CPU mirror of the sea shader's waves), and `arc` and
   `claimDir` (spacing and placement). `tryLoadModels()` swaps the authored
   `.glb` models in over procedural stand-ins once the world is up.
4. **`GameScene.ts`, everything that lives on the planet.** `initialize()`
   builds the Island inside a seeded window
   (`installSeededRandom` … `restoreRandom`). After that the file is organised
   by `// ──` section headers: bird feed, the campfire, fishing, timber,
   construction, the island-map data, water effects, NPC speech bubbles.
   `update(deltaTime)` is the world's frame. `orientAvatar` is where World
   Law 1 lives (people and things that stand take a radial up-axis, never the
   slope). `buildInterior` is the one room, hidden under the map, that every
   enterable building reuses.
5. **`SimpleUI.ts`, the DOM.** One method per surface: `showWelcome`,
   `showZonePanel`, `showNpcChat`, `showIslandTimes`, `showGuestbook`,
   `showShop`, `showJournal`, `showInventory`, `showTourOverlay`.
6. **`functions/src`, the server.** Read `index.ts` (`npcChat`), then
   `npcPlanner.ts` with `plannerPrompt.ts`, then `analyst.ts`, `tts.ts` and
   `agentSession.ts`. Each starts with a header that explains its limits.

## Subsystems

### World generation and determinism

Phones and desktops must build the same world: multiplayer addresses the
parked cars by index, and rocks carry colliders. GameScene builds the Island
inside a seeded mulberry32 window, and any tier-gated work (fewer grass blades
on a phone, the cel ink) runs on its own local stream so it can't shift the
shared draws. `test/tierParity.test.ts` builds the island as both tiers,
compares them, and pins a golden census of the desktop world.
`staticFreeze`, `terrainNoise` and `grassMarshal` guard the same ground.

### Villagers

`Island.ts` places 28 villagers (`NPC_SITES` paired with `NPC_PERSONALITIES`
by index). `NpcActivities.ts` runs their schedules on the client, reading the
day's plan from `world/island/npcPlan` and validating each activity id again
against its own list. `NpcChat.ts` sends a message to `npcChat` for the 24
villagers with a server persona; the other four use scripted lines. `Speech.ts`
plays the reply with the ElevenLabs voice from `npcVoice` or the browser's
voice, and listens to the visitor's microphone. The avatars are rigged `.glb`
models whose limbs rest near ±π, so poses are written against the rest pose
(World Law 2 in `CLAUDE.md`).

### Player, camera and input

`SimplePlayer.ts` walks a sphere (the velocity is split into tangent and
normal parts) and handles swimming, diving, running and stamina.
`OrbitCamera.ts` follows behind. `SimpleInputManager.ts` latches key presses
so a tap shorter than a frame still counts.

### Multiplayer and the shared world

`Multiplayer.ts` uses Realtime Database presence (`presence/island`), falling
back to the Vite dev server's WebSocket relay and then to same-device tabs.
`Chat.ts` carries proximity text and voice, which reach a fixed fraction of
the world (0.35 × the radius). `Boards.ts` reads and writes the guestbook,
leaderboards and leads. `WorldState.ts` subscribes to `world/island`, which only
the functions can write: the director's mood and headline, the planner's plan
and the analyst's notice.

### Rendering and look

`SimpleRenderer.ts` picks a device tier; phones skip the bloom chunk entirely.
`CelLook.ts` adds the cel shading and the ink outlines, `Materials.ts` the
shared materials, and `EnvironmentCycle.ts` the day, night and weather.

### Backend

| Function | Trigger | File |
| --- | --- | --- |
| `npcChat` | callable | `index.ts` |
| `npcVoice` | callable | `tts.ts` |
| `agentSession` | callable | `agentSession.ts` |
| `vaultOp` | callable | `vault.ts` |
| `planner` | daily, 6am Melbourne | `npcPlanner.ts`, `plannerPrompt.ts` |
| `analyst` | daily, 9pm Melbourne | `analyst.ts` |
| `director` | every 6 hours | `index.ts` |
| `janitor` | every 6 hours | `index.ts` |
| `onLeadCreated` | new child under `leads/island` | `index.ts` |

`constants.ts` holds the caps and model ids in one place. `pure.ts` holds the
logic that needs no Firebase (rate windows, prune selection, the seeded pick,
the stale-issue sweep, the de-duplication against closed proposals) so plain
Vitest can test it. `moderation.ts` holds the input and output gates, and
`personas.ts` the villager prompts.

The invariant behind all of it: **no model text is written to a node every
visitor can read.** The planner writes ids, the analyst writes indices into
pre-written notice lines, and the director picks pre-written headlines.
Model prose goes to one visitor at a time (a moderated chat reply), to the
owner's email, and to GitHub issues with traffic figures redacted.

Nodes the clients never touch (`aiUsage`, `aiRate`, the `tts*` and `agent*`
nodes, `stats`) are simply absent from `database.rules.json`, so the default
denies them and only the Admin SDK can read or write them. The janitor prunes
them. What each `ALERT` line in the function logs means, and what to do about
it, is in [docs/runbook.md](docs/runbook.md).

### Assets

The `.glb` models in `public/assets/models` were authored in Blender for this
project. Six headless Blender scripts in `scripts/` reshape the avatars, in the
order their headers give: `fix-avatar-gaps`, `reshape-avatar-face`,
`fix-player-toes`, `rig-npc`, `soften-avatar-silhouette`,
`smooth-avatar-shading`. Each keeps the input it starts from in
`scripts/backup/` and restores it before running, so a re-run never applies
itself twice; that is why those snapshots are committed. Sources and licences:
[CREDITS.md](CREDITS.md).

### Tests

Vitest, 48 files. `test/helpers/headlessDom.ts` gives happy-dom a no-op 2D
canvas so a real Island can be built in a test, and
`test/helpers/networkStubs.ts` keeps every test off the network. Some tests run
the code (the world builds, the pure functions, the moderation lists); some
read source text where the code can't run in Node (shader strings, DOM
wiring, lists that live in two build roots). CI runs them with the typecheck,
lint, Prettier, both builds and the offline evals
([.github/workflows/ci.yml](.github/workflows/ci.yml)).
