# Wave 4: the first-visit economy (P2-A9)

Decision 16 asked for a two-week Vercel Web Analytics baseline of
`lesson_done` before the economy changed. That baseline cannot be exported:
the Web Analytics query API answers "not found" for the project (checked
2026-11-14), which reads as Web Analytics never being enabled. P2-A9 measures
its own baseline in the repo instead, and renames the event so no series
changes meaning.

## Analytics: lesson_done is retired

- `lesson_done {id, total}` fired on every School press: six presses, six
  events, +60 coins in about 2 s.
- From P2-A9 it no longer fires. `lesson_learned {id, n}` fires at the moment
  a lesson pays: at School enrolment for every lesson whose action has already
  happened (moving always counts), then at each lesson's first action (first
  cast, first felled tree, first feed throw, first villager chat message,
  first build).
- The two series never mix, so neither needs a before-number.
- Merge date: the day `ux/w4-controls` (wave 4, package A) merges to main.

## In-repo baseline (main fcaa649, local build, desktop 1440x900, ?hour=12)

| Measure | fcaa649 | Probe |
| --- | --- | --- |
| Coins after the four-district tour | 6 | p2/tour |
| Shop items enabled on the first kiosk visit (trail coins) | 2 of 20; hats 0 of 10 | p2/shop |
| School: coins paid for six presses on a fresh visitor | +60 | p2/quests |
| Coin delta at a delivery hop | 0 (setOnDeliveryComplete pays nothing) | code read; E's p2/gather row |
| Meadow coins per minute (greedy walk) | not measured here: E's p2/coinhunt | p2/coinhunt |

## The change

- Passport stamps pay +5 each (ds_stamp_paid; no back-pay for returning
  visitors), deliveries +3, lessons +10 once each when their action happens.
- The Explorer Cap costs 5, not 8, so the trail's 5 coins buy a first hat.
- economy.ts and its satiation caps are unchanged.
- First-visit sum: trail 5 + four stamps x 5 = 25 (questTracker pins it).

## After (branch ux/w4-controls, local build, desktop 1440x900 unless named, ?hour=12)

| Measure | fcaa649 | After | Probe |
| --- | --- | --- | --- |
| Coins after the four-district tour | 6 | 26 (desktop and 390x844 phone) | p2/tour |
| Hats enabled on the first kiosk visit (5 coins) | 0 of 10 | 1 of 10 (Explorer Cap) | p2/shop |
| School: six presses on a fresh visitor | +60 | +10 (lesson 1 at enrolment) | p2/quests |
| A first cast after enrolment | n/a | +10 (lesson 2) | scratch probe |
| Coin delta at a delivery hop | 0 | +3 | scratch probe |
