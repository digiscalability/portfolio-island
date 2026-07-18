# DigiScalability Life Island

A 3D interactive portfolio: a miniature planet you walk around as a
third-person character, exploring five content "zones" (the DigiScalability
story — RankPilot, ChocoMate, Bano's Cookbook, and more) and completing a
mailbox delivery quest chain that leads you around the world.

Built with **Three.js + TypeScript + Vite**. All 3D assets are authored
programmatically in **Blender** (headless Python) and shipped as ~200KB of
`.glb` files — the production build is under 1MB.

## Quick start

```bash
npm install
npm run dev        # Vite dev server on :5173
npm test           # vitest (unit tests for quest chain + input)
npm run build      # production build into dist/
npm run lint       # eslint, zero-warning policy
npm run typecheck  # tsc --noEmit (strict)
```

**Controls:** WASD move · mouse look · Space jump · **E** interact
(mailboxes, lamps, zone plazas) · Esc closes panels · Ctrl+B toggles bloom.

## How the world is put together

The planet is a displaced sphere (radius 18) with elevation-tinted vertex
colors. The five zone plazas sit evenly on the equator, so the equator road
is "Main Street" and the districts hang off it:

```
Welcome ─VILLAGE─ Professional ─ORCHARD─ Projects ─MARKET─ Personal ─COUNTRY─ Contact ─FOREST─ (loop)
```

Mountains, woods, and rivers fill the higher latitudes. Placement goes
through a shared spacing registry (`Island.claimDir`) with per-category
clearance and slope limits; everything samples the *displaced* terrain and
sinks slightly (bury-not-float) so nothing hovers.

## Architecture (live modules)

| Module | Role |
|---|---|
| `main-simple.ts` | App entry: boot, render loop, input→scene wiring, quest compass |
| `GameScene.ts` | Scene composition: island, player, camera, lighting, colliders |
| `Island.ts` | Planet generation: terrain, district layout tables, prop placement, model replacement |
| `SimplePlayer.ts` | Sphere-walking physics (tangent/normal velocity split), rigged glb + idle/walk blend |
| `OrbitCamera.ts` | Follow-behind camera (parallel-transported), terrain+prop collision |
| `SimpleInputManager.ts` | Keyboard/mouse/touch; edge-latched presses, stale-key watchdog |
| `DeliverySystem.ts` | Quest chain: gated deliveries across mailboxes |
| `Mailbox.ts` | Interactive mailbox + delivery beacon beam |
| `Zones.ts` / `ZonesManager.ts` | Zone landmark plazas + portfolio content panels |
| `SimpleUI.ts` | DOM HUD: prompts, zone panels, quest compass, FPS |
| `NPC.ts` | Villagers: terrain-aware idle/patrol |

`_legacy/` holds archived, unshipped code (excluded from build, lint, and
tests). `docs/` holds the original design/requirements documents.

## Asset pipeline

Models live in `public/assets/models/*.glb`, authored by Blender headless
scripts (see `README-asset-workflow.md`). Conventions learned the hard way:

- Join each asset to a **single mesh** and apply transforms before export —
  multi-object exports with rotated+scaled primitives produce ambiguous
  transforms downstream.
- The player is skinned (Idle/Walk clips); the game blends them by speed
  with direct per-frame weights (not fadeIn/fadeOut, which can strand both
  actions at zero).
- Real-world scale ratios with the player at 1.8u — but architecture is
  deliberately compressed relative to the planet (miniature-world style).

## Backend (scaffolded, not yet wired)

`functions/` contains Firebase Functions stubs (AI Q&A, appointments,
feedback) and Firestore/Storage rules. The web app currently runs fully
client-side; Firebase deploy config is in `firebase.json`.
