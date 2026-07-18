# `_legacy/` — archived, not shipped

These modules are **not reachable from the shipped entry** (`index.html` → `main-simple.ts`).
They were moved here on 2026-07-19 during a "prune to reality" pass so the active root
only contains code that actually ships. Everything here is recoverable from git history
and is **excluded from the TypeScript build** (see `tsconfig.json` → `exclude`).

Determined by static import-closure analysis from `main-simple.ts` (19 live files).

## Category A — Obsolete (superseded by the "Simple" stack; safe to delete eventually)

The original heavier engine/render/UI stack that `main-simple.ts` replaced:

- `main.ts`, `src/main.ts` — old entry points (index.html no longer references them)
- `Engine.ts` → replaced by `SimpleApp` (`main-simple.ts`) + `GameScene.ts`
- `UIManager.ts` (113 KB) → replaced by `SimpleUI.ts`
- `Player.ts` → replaced by `SimplePlayer.ts`
- `Camera.ts` → replaced by `OrbitCamera.ts`
- `Renderer.ts` → replaced by `SimpleRenderer.ts`
- `SceneManager.ts` → replaced by `GameScene.ts`
- `InputManager.ts` → replaced by `SimpleInputManager.ts`
- `SimplePlanet.ts` → the planet is built by `Island.ts` (used by GameScene)
- `Environment.ts`, `Lighting.ts` → lighting is set up inline in `GameScene.ts`
- `ObjectPlacement.ts` → replaced by `TownPlanner.ts` + Island placement
- `GraphicsDebug.ts`, `VirtualJoystick.ts`, `PlanetThumbnail.ts` → unused dev/util
- `src/utils/GLTFModelLoader.ts` — **duplicate** of the live `utils/GLTFModelLoader.ts`
- `src/utils/DebugOverlay.ts`, `src/utils/Logger.ts` — only used by the old stack
- `src/style.css` — CSS for the old entry (shipped app uses root `style.css`)
- `index.ts` — a **misplaced duplicate** of `functions/src/index.ts` (Firebase Functions)

## Category B — Revive candidates (implement required features, just unwired)

These map to features in `Integrated Project Requirements_ ....md` that the Simple stack
dropped. Rewire into `GameScene`/`SimpleUI` rather than deleting:

- `ChatSystem.ts`, `ChatUI.ts`, `DialogueUI.ts` — AI Q&A / chat overlay (Gemini via Firebase)
- `FeedbackSystem.ts` — visitor feedback → Firestore
- `AppointmentSystem.ts` — appointment booking (Google Calendar)
- `Emoji.ts` — 3D emoji surface decorations
- `FirebaseConfig.ts` — Firebase client config stub
- `InteractionSystem.ts` — raycast-based interaction (GameScene currently does proximity)
- `MathUtils.ts` (+ `MathUtils.test.ts`) — sphere math utilities (the repo's only unit test)
