# LOCAL-STATE — last Code session (2026-08-02)

## Branch
`claude/overnight-20260719-0649` — **pushed + synced to GitHub** (HEAD `9360240`).

## What shipped this session (Living NPC Agents — COMPLETE + LIVE)
- Phase 1 `eb055e6` client activity engine (NpcActivities.ts + GameScene goal hook + badges)
- Phase 2 `191d1ae` daily LLM planner (6am Melb) + director `.set→.update` + npcPlan channel
- Phase 3 `ba4a736` nightly analyst (9pm Melb): email digest + GitHub issues + counts-only notice
- Phase 4 `b38b407` 📰 Island Times board (SimpleUI modal + WorldState parseNotice + parity vitest)
- `d5523bc` ANALYST_TO default fix · `f5e1fa9` issue-filing cooldown(3d)+cap(5) after dedupe bug
- `5fb5d9d` lint → 0 errors/0 warnings · `9360240` token accounting → transactions (3 races)

## Deployed state (all verified live)
- Client → Vercel prod, aliased island.digiscalability.com
- Functions on life-island: analyst / director / janitor / npcChat / onLeadCreated / planner (all v2, us-central1)
- Schedules ENABLED: planner 6am Melb · analyst 9pm Melb · director+janitor 6h UTC
- Secrets: ANTHROPIC_API_KEY v1 · SMTP_PASSWORD v2 · GITHUB_TOKEN **v2 = classic PAT from `.claude/settings.json` env.GITHUB_PERSONAL_ACCESS_TOKEN — over-scoped, recommend narrowing to fine-grained Issues-only** (v1 was a placeholder, superseded)
- Ops alerting NEW: notification channel `projects/life-island/notificationChannels/14245889434709047471` (email digiscalability@gmail.com) + log alert policy `projects/life-island/alertPolicies/17451885373972938075` matching `textPayload:"ALERT "` severity>=ERROR on cloud_run_revision
- Firebase CLI default account switched → digiscalability@gmail.com

## Verified in prod
- planner: `planner(llm) event=quiet_day assigned=18 tokens=450`
- analyst: emailed digest, filed issues #5 #6 (test set #1-4 closed), notice written; 2nd trigger filed 0 (cooldown works)
- Island Times board renders live plan on prod; XSS probe inert

## Open threads / next steps
1. **Abbas**: narrow GITHUB_TOKEN to a fine-grained PAT (Issues RW on portfolio-island only) → `firebase functions:secrets:set GITHUB_TOKEN --project life-island`
2. Multi-agent audit workflow of the feature FAILED on session usage limit (resets 2:50pm Syd) — inline verification was done instead (invariants + token races); re-run the audit workflow later if desired (script saved in session workflows dir)
3. Prettier `format:check` fails repo-wide (55 files, pre-existing) — decide whether to do a one-shot `npm run format` commit
4. Cost review in ~3 days via `aiUsage/2026-08` (expect ≈$0.03-0.06/day)
5. Review analyst issues #5 (Say Hi widget) + #6 (surface racing leaderboard) — its first real proposals

## Gotchas worth remembering
- `defineSecret` resolves for the WHOLE codebase on any functions deploy (that's why GITHUB_TOKEN needed a value before analyst existed in prod)
- firebase functions:log ingestion lags minutes — use ground truth (GitHub/RTDB state) to verify runs
- LLM-generated titles can't be a dedupe key — bound the effect (cooldown+cap), not the content
