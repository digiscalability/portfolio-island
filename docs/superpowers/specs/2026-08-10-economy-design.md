> **Status: APPROVED 2026-08-10 — all 3 decisions RULED by Abbas.**
> 1. Bank = **TRANSACTIONAL VAULT** (against recommendation, his call): real deposits/withdrawals
>    restore cross-device money post-Phase-0. BINDS US TO: a Cloud Function endpoint for
>    balance mutation (RTDB rules alone cannot validate arithmetic), client credit only on ack,
>    and an adversarial dupe-test pass (double-submit, offline replay, reload-mid-transaction)
>    BEFORE the vault ships. The vault is the only component allowed to hold shared money.
> 2. Benches = **SHARED WORLD NODE** (against recommendation, his call): visitors see each
>    other's benches. BINDS US TO: rules-validated `world/benches/{id}` with uid stamp,
>    per-uid cap (4) + cooldown enforced server-side, name-moderated label reuse, and a
>    kill-switch (hide-by-uid) since public content on a portfolio can be vandalized via
>    forged coins. Bench placement limited to the 8 pre-authored plot anchors — no free
>    placement, which caps the vandalism surface to "a bench exists".
> 3. Fishing icebox satiation = **SHIP** with the diegetic line.
>
> Net effect: Phase 2 grows a small Cloud Functions surface (vault endpoint + bench writes);
> this is also the honest backend-chops demo Abbas wanted. Phase order unchanged; Phase 0
> (coin local-truth) remains the mandatory first commit.

# Island Economy — Design Brief (2026-08-10)

Synthesis of three lens designs + adversarial audit. All BLOCKs and FIXes applied; one number sheet nominated. Repo: `githubCLONES\portfolio-island`, branch per `.claude/LOCAL-STATE.md`.

## 1. Principles

- **Loops, not features.** Every addition must close an earn→spend→see-the-result loop. The fishing template (buy tool → use tool at a place → sell output to a person) is the proven grammar; timber is that grammar a second time, plus one moment of permanence (a built thing that survives reload).
- **Soft-trust, stated plainly:** private cheating is acceptable — editing `ds_coins` in localStorage only affects your own island, and we spend zero effort "securing" private state (timber counts, lesson flags, felled trees). The line is peer visibility: anything another visitor can see must be rules-capped or stay per-player. No client-authoritative shared money, ever.
- **Zero-state law:** the world must never advertise what a player hasn't done. No unbuilt ghost frames on the recruiter path — the playground ships built; player-built content is small benches whose absence is invisible.
- **One number sheet** (below) is canon; the three lens docs are superseded where they conflict.

## 2. Coin flow map (after this design)

| Flow | Amount | Cadence / cap |
|---|---|---|
| **SOURCES** | | |
| Scattered coins | 1c × 45 | 120s respawn (anti-farm value — do NOT lower); ~10–15c per 15-min session |
| Race wins | 15–25c | existing |
| Quest deliveries | ~10c | existing |
| Fish → Fisherman | 3c each, ≤9c/min | **icebox satiation: 10/day, then 1c** (new nerf, surfaced diegetically) |
| Timber → Carpenter | 5c/timber (2/tree ≈ 10c/45s) | rack satiation 10/day; Ranger's Rule: max 5 trees felled concurrently |
| School lessons | 10c × 5 | **one-time ever** (union-merged) |
| **SINKS** | | |
| Rod 40 · **Axe 60** · Hats 20–50 · Feeds 6–12 | coins | owned-flags / consumables |
| Bench commission | 4 timber + 10c | repeatable, ~8 plot anchors |
| Hospital checkup (60s sprint buff) | 10c | repeatable |
| Drown fee | 5c, floor at 0 | per drowning |

15-min visitor: ~12 pickup + 20 race + 20 quests + 50 lessons ≈ 102c earned; rod 40 + feeds ~15 ≈ 55c spent → **~47c surplus**, axe next visit. Return hook, not paywall. **No bank interest** — it's a clock-forgeable faucet and a merge hazard (audit 15).

## 3. Phase 1 — Timber loop

**Prerequisite (Phase 0): coin local-truth refactor.** `main-simple.ts:3002-3004` max-merges cloud coins — a live refund exploit today (buy rod, reload before the 800ms-debounced save, keep rod + old balance). Retrofit coins to the `ds_bird_feed` adopt-once pattern (:362-369) and pass a spend→reload→spend test **before any T1 code**. Documented side effect: cross-device coin sync dies; the bank question (Section 9, Decision 1) is the answer to that. ~80 LOC.

**Mechanics.** Axe 60c, shop owned-flag like `ds_rod` (`ds_axe`, boolean-OR merge). Chop = plain **E×3** in the E-prompt chain (~`main-simple.ts:1886`, after the fisherman branch): each hit sfx + sway-pulse via `_swayQuat`; third hit fells. Swing-meter timing is a T1.5 juice pass, not T1. Fell: rotate `group.quaternion` from `baseQuat` about a tangent axis over 0.9s, hide mesh, show stump (one shared 8-tri cylinder on the existing vertex-coloured `treeMat` — draw calls go down). Yield 2 timber (`ds_timber`, local-truth). Regrow: `regrowAt = now + 300s`, restore quaternion + scale-in 2s.

**State.** Extend the existing `swayTrees` entries to `{group, baseQuat, phase, felled, regrowAt}` — no new scan; seeded RNG means `tree_N` is deterministic per client. **A single `felled` flag must gate ALL consumers** (audit 10): sway restore (`GameScene.ts:7470` — the double-writer), bump-shudder (:8358), structure-placement clearance (:3760), collider queries + grounding shadow (name-keyed at `Island.ts:1901` — flag `userData`, never rename). Regrow reverses all of it.

**Persistence + merge rules:** `ds_axe` boolean-OR; `ds_timber` local-truth (consumable law — never max-merge); `ds_trees_cut` max() (pure stat); per-tree hp/regrow session-only. **Per-player tree state — yes** (Section 6).

**Diff:** ~650 LOC (top of range, per audit) across GameScene/Island/main-simple, plus the icebox satiation retrofit with the diegetic line ("Icebox is full — 1 coin each now") so the nerf isn't reported as a bug.

## 4. Phase 2 — Bank + School

- **School — single function: onboarding-as-wages.** Teacher runs 5 guided 30s lessons (move, fish, chop, feed, chat), 10c each, once ever. Replaces tutorial UI; the first 50 coins *are* the tutorial. `ds_lessons` merges as **union** (per-account, not per-device — audit 12). Actor: **Teacher recast from the existing ~25 personas** via a new `teach_class` anchor — zero new actors; school-out hours anchor her at the playground.
- **Bank — single function: the passbook** (recommended; see Decision 1). Teller counter, panel-on-interact showing lifetime earned/spent/built from max()-merged stat counters. No stored balance, no interest → the dupe class (audit 2), clock forgery (15), and half-dead-state risk all vanish. Actor: **Teller appended** to NPC_SITES/PERSONALITIES (append-only, index-zip law), `teller_shift` activity.
- **Siting:** Bank in Welcome Hub near the shop; School in Personal Life; both via `claimOffStreet(dir, arc(m))` station pattern (garden/bandstand/easel precedent), NPC sited within arc(4) of their building.

## 5. Phase 3 — Hospital + Playground + kids

- **Hospital** (Professional Experience district): sells the **10c checkup → 60s sprint** (best pure sink of the three lenses). Drowning **keeps nearest-shore respawn** (`GameScene.ts:6777` is good UX — audit 13); the hospital-bed wake-up plays only if the drown point is within ~30m, else 5c fee via toast, floor 0 — never gate a broke player. Actor: **Nurse appended**; the daily LLM planner routes existing NPCs in for checkups — free ambient life.
- **Playground** (Personal Life, beside school): **ships built by default** (audit 11). It implies children without rigs: self-animating merry-go-round, phase-offset swings, seesaw (~3 rotating meshes, ~6 draw calls), hopscotch decals, kite.
- **Kids decision: props, not rigs.** No scaled adult clones — World Law 2 territory (±π rest poses, duplicated local/remote conventions). If kids ever ship, it's one purpose-built small rig through the full six-script Blender chain, consuming the reserved fourth actor slot. Fictional "kid schedule entries" in Island Times are NOT free — they'd need server persona-list edits (audit 9).

## 6. Multiplayer + persistence decisions

- **Per-player tree state: yes.** Trees aren't synced; 216 HPs on free-tier RTDB is cost without payoff. Ghost divergence matches the feed-pile precedent. Optional one-shot chop particle over the ephemeral wire; never state.
- **Benches: per-player** (recommended; Decision 2). `ds_built` array-union like ownedHats. No `world/` node exists in `database.rules.json`, and a shared node inherits the grief/forged-coin-vandalism problems soft-trust forbids. Demo line becomes "reload the page — it's still here," which is still strong.
- **Server reality check** (audit 5): new NPCs require `functions/src/npcPlanner.ts` (ACTIVITY_IDS, PERSONA_IDS), `index.ts:336` PERSONAS, and `tts.ts` VOICES edits + a functions deploy + an ElevenLabs voice cast per new persona — budget it in Phase 2/3, "zero server changes" was false.
- **E-prompt chain** is order-sensitive: add explicit nearest-interactable arbitration when inserting chop/sell/deposit prompts (audit 16).

## 7. Perf + actor budget ledger

| Item | Cost |
|---|---|
| NPCs: Carpenter, Teller, Nurse (+3 of 4; 4th reserved for kid rig) | ~15–40 draw calls each, 3 activity anchors, 3 voices |
| Teacher | 0 (recast existing persona) |
| Stumps | shared geometry; felled tree hides mesh → net draw calls **down** |
| Playground props | ~6 draw calls, self-animating |
| Regrow timers | piggyback existing swayTrees iteration, no new per-frame scan |

## 8. Explicitly NOT building

- **Bank interest** — clock-forgeable faucet, imperceptible at 10c/day, merge hazard.
- **NPC wages** — invisible simulation; narrate it in Island Times instead, the fiction is free.
- **Player housing** — content black hole; the bench IS the housing prototype.
- **Markets / dynamic prices** — client-authoritative RTDB makes them publicly cheatable, damaging the portfolio story.
- **P2P trading** — the exact dupe class the Consumable Law exists to prevent; unseeable in a solo session.
- **Second resources / crafting** — timber completes the arc; stone/ore adds UI, not a verb.
- **Kid NPCs via scaled adults** — World Law 2 trap; props or a purpose-built rig only.

## 9. OPEN DECISIONS FOR ABBAS

1. **Bank: passbook mirror vs transactional vault.** *Recommend: passbook now.* Vault (RTDB `runTransaction` withdraw, local-credit-on-ack) restores cross-device money after coin local-truth kills it, and demos real backend chops — but it's the only path that can dupe, and needs an endpoint + adversarial testing. Passbook has zero exploit surface and ships in a day; coins stay per-device.
2. **Benches: per-player vs shared world node.** *Recommend: per-player.* Shared gets the "my friend sees it" demo line but requires a rules-validated `world/` node, per-uid caps + cooldowns, and accepts that a forged-coin bench is public vandalism on your portfolio. Per-player keeps "reload — still there" and zero grief surface.
3. **Fishing icebox satiation: ship or defer.** *Recommend: ship with the diegetic line.* It caps each loop at ~50c/day and protects every new sink — but it's a visible nerf to shipped behavior and returning players may file it as a bug. Deferring keeps fishing infinite and quietly undermines the axe/bench economy.

## 10. Build order + verification per phase

1. **P0 — coin local-truth** (~80 LOC). Verify: buy rod → reload before debounce → rod owned AND coins stay spent; repeat offline.
2. **P1 — timber loop** (~650 LOC). Verify (measured, per repo law): fell → walk through stump (collider off) → bump felled trunk (no shudder) → reload (tree back) → regrow → collide again; sway loop never fights the fall; draw-call count before/after chop.
3. **P2 — school + bank + Teacher/Teller** (~450–650 LOC + functions edits/deploy). Verify: lessons pay once across two devices (union merge); passbook totals match a hand-tallied session; new personas answer chat with ElevenLabs voices, not SpeechSynthesis fallback.
4. **P3 — hospital + playground + Nurse** (~500–700 LOC). Verify: drown far from hospital → nearest-shore respawn + toast fee; drown at 0 coins → no negative; playground props animate at target FPS on mobile; Island Times reports checkups/lessons within two in-game days.
5. **T1.5 polish** (swing meter, chop particles) only after P1–P3 measure clean.

Every phase ends with a `vercel --prod` gate-green check against live, per LOCAL-STATE.md handoff discipline.