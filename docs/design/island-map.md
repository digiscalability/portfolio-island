# Island map: open bugs, the 31 Mar 2027 decision, later options

Written 2026-10-25. Terms come from `GLOSSARY.md`. The Island is formally deferred (Ventures register, October refresh). On **31 Mar 2027** Abbas either fixes the three open bugs in one weekend or applies the demo freeze. This file is what each branch costs.

## State on 2026-10-25

- Live at island.digiscalability.com (Vercel). `main` at `72f76f8`. LOCAL-STATE reports 441/441 tests.
- GCP `life-island`: billing **on**, all 9 functions deployed (`npcChat`, `npcVoice`, `agentSession`, `vaultOp`, `onLeadCreated`, and the scheduled `director`, `planner`, `analyst`, `janitor`). The Aug 2026 "blocked on billing" note is out of date.
- Leads: RTDB `leads/island` was empty, and `onLeadCreated` last ran on 10 Aug. No lead is waiting unread.
- The "raise the radius 50 → 75" request is done and superseded: `WORLD_RADIUS = 100` (`WorldScale.ts:33`).
- Working tree: the 66 "modified" files differ only in line endings (no content change). Leave them alone.

## Branch A: fix the three bugs (one weekend, cheapest first)

Each fix ends with a fresh screenshot of the affected state (CLAUDE.md, Visual regression protocol).

| # | Bug | Cause found in code | Fix | Est. |
|---|---|---|---|---|
| 1 | Swimming arms run backwards | The windmill turns the wrong way: `armL.rotation.x = REST_X - swimPhase` (`SimplePlayer.ts:1283-1284`), and the peer copy is `-Math.PI - swimClock` (`:844-845`). This is reasoned, not yet measured. | Measure the hand's world position over one stroke (World law 3). If it is a reverse crawl, flip the sign in **both** copies. Update the pins in `test/visualPolish.test.ts:931-936` and the oceanDive "windmill lock" test. | ~1 h |
| 2 | Campfire sit pose and position | Guests are oriented to the fire's slope normal `C.up` (`GameScene.ts:5158-5179`), not each seat's plumb up, which breaks World law 1. Legs use `-1.15` and arms `-0.12`, both written absolutely and never measured on `npc.glb`. The seat logs ignore their own up. | Orient each guest with `orientAvatar` on the seat's plumb up. Compose the sit pose onto the cached rest quaternion (World law 2). Probe the hip and foot height to set the root offset (World law 3). | ~3 h |
| 3 | Path patches float or sink on hills | `Island.createStreetPath` (`Island.ts:6906+`) seats each ribbon vertex on the analytic surface with a 0.04/0.055 lift (`:6981-6996`). The faceted mesh differs from the analytic surface on steep slopes. The plaza slab shares the same step (`:4288-4310`). | Seat the vertices with `sampleSurfaceByDirection` (mesh raycast, 0.005 ms at R=100; it runs at build time, not per frame) and keep a single small lift. | ~3 h |

## Branch B: the demo freeze

The Island stays playable but costs about nothing. **No code change.** Every live service already has a fallback:

| Turned off | What the visitor sees instead |
|---|---|
| `npcChat` | Villagers answer with canned lines, with no error (`NpcChat.ts:139-173`, `main-simple.ts:736-738`) |
| `npcVoice` | Browser speech voice |
| `agentSession` (reception voice call) | "Couldn't start the call. The message form below works fine." (`ReceptionDesk.ts:150-161`) |
| `director`, `planner`, `analyst`, `janitor` | `world/island` stops changing, and the world shows its last state (`WorldState.ts`) |

Kept on: play, multiplayer, profiles (`vaultOp`), the guestbook and **lead email (`onLeadCreated`)**.

To freeze, Abbas runs (it can be undone: redeploy with `firebase deploy --only functions:<name>`):

```bash
firebase functions:delete npcChat npcVoice agentSession director planner analyst janitor --project life-island
```

Before running it, check whether the reception voice agent still spends ElevenLabs credit. If it does, the freeze saves that credit too.

## Later options (not decided)

1. **Island leads onto the website's lead store.** Today an island lead lives only in RTDB `leads/island`, and the only notification is an email. It never reaches the website's admin › Leads. The option is to post it to the website's lead store as source `island`, keeping the email. That would need a public, rate-limited lead endpoint on the website, which does not exist yet.
2. **A lead-email alert.** `onLeadCreated` logs `ALERT lead-email-failed` but no log-based alert is set up, so a broken SMTP password drops every lead email silently. Fix this with a Cloud Logging alert on that marker, or with option 1.
3. **`.gitattributes`.** Pin line endings so the stat-only noise stops. This produces one 66-file commit, so do it only when nothing else is in flight.
4. **Older polish** from the revival log, all still open: party-dance arms, peers lerping from the live ±π angle on mount and dismount, shadow crawl, ride and sit poses wiping the rest pose, and ambient sparkles writing depth.
