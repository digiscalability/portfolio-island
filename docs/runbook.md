# Runbook: the island's Cloud Functions

What each `ALERT` line in the function logs means and what to do about it.
Every marker below is quoted from `functions/src` as of 2026-11-02; if you add
one, add it here.

## How you find out

- Every failure that needs a person is logged with `console.error('ALERT <key>', …)`.
  A Cloud Monitoring alert policy on the `life-island` project, "Island
  functions — ALERT markers (planner/analyst/email/github)", matches
  `resource.type="cloud_run_revision" severity>=ERROR textPayload:"ALERT "` and
  emails the owner: at most one notification an hour, and each incident closes
  itself after 24 hours. (Its name and description list only the planner,
  analyst, email and GitHub markers, but the filter matches every key on this
  page.)
- Configuration problems that are not outages (a 4xx from ElevenLabs, say) are
  logged without the `ALERT` prefix on purpose, so they never page.
- Read the logs in the
  [Logs Explorer](https://console.cloud.google.com/logs/query;query=resource.type%3D%22cloud_run_revision%22%20textPayload%3A%22ALERT%20%22?project=life-island)
  or with `firebase functions:log --only <function> --project life-island`.
- Every fallback `npcChat` serves is counted by reason (input, rate, cap,
  refusal, error, output) under `aiUsage/{month}/fallbacks` in the Realtime
  Database, and the analyst's nightly email reports the month's counts.

## Common fixes

- **A secret was revoked or rotated.**
  `firebase functions:secrets:set <NAME> --project life-island`, then redeploy
  every function that declares it:
  `firebase deploy --only functions:<name> --project life-island`.
  `ANTHROPIC_API_KEY`: npcChat, planner, analyst. `ELEVENLABS_API_KEY`:
  npcVoice, agentSession. `SMTP_PASSWORD`: onLeadCreated, analyst.
  `GITHUB_TOKEN`: analyst. Every one of these secrets must exist before any
  functions deploy succeeds.
- **Re-run a scheduled job** after fixing it: Cloud Scheduler, find the job
  named after the function, Force run.
- **Stop the spending fast.** Lower the Anthropic workspace spend limit or
  revoke the key: chat falls back to scripted lines, the planner to its seeded
  plan, the analyst to the plain digest. Revoking the ElevenLabs key sends
  villager voices to the browser's speech and closes the reception desk.
  Lowering a cap in `functions/src/constants.ts` needs a redeploy.

## Model calls

| Key | What happened | What the visitor sees | What to do |
| --- | --- | --- | --- |
| `npcChat-llm-failed` | The Anthropic call threw. `status` says why. | That villager answers with a scripted line. | 401/403: the key is wrong or revoked; rotate `ANTHROPIC_API_KEY`. 429: rate or spend limit; check usage and limits in the Anthropic console. 400: check `NPC_MODEL` in `constants.ts` is still a served model. 5xx/529: the provider is struggling; nothing to do if it stops. |
| `planner-llm-failed` with `status` | The planner's call threw. | The deterministic plan is written: the day's event, and every villager keeps their default schedule. | As `npcChat-llm-failed`. |
| `planner-llm-failed` with `reason: 'parse'` | The call succeeded and was billed, but the reply held no usable plan. | Same as above. | Once is noise. If it repeats, compare the pools in `npcPlanner.ts` with the prompt in `plannerPrompt.ts`, and run `npx vitest run test/promptBuilders.test.ts test/livingNpcs.test.ts`. |
| `planner-run-failed` | Something outside the model call threw (a database read, the plan write). | No new plan today; villagers run yesterday's plan or their defaults. | Read `msg`, fix, then Force run the planner job. |
| `analyst-llm-failed` | The analyst's Claude Sonnet call threw. | Nothing. The owner email still goes out, with the plain metrics digest and no proposals. | As `npcChat-llm-failed`; the model id is `ANALYST_MODEL`. |
| `analyst-run-failed` | Something outside the guarded steps threw. | The Island Times may keep yesterday's edition, and the owner email may not go out. | Read `msg`, fix, then Force run the analyst job. |

## Spend accounting

| Key | What happened | What to do |
| --- | --- | --- |
| `aiusage-accounting-failed` | A write to `aiUsage/{month}` failed (npcChat's token or call counters, a fallback counter when `at` starts with `fallback-`, or the analyst's tokens). The monthly token cap reads from these counters, so persistent failures mean the cap undercounts. | Check the Realtime Database is healthy (Firebase console, Realtime Database, Usage). If it keeps failing, lower the Anthropic workspace spend limit until it is fixed: that limit holds even when the counters don't. |
| `npcVoice-accounting-failed` | The character counter or the audio cache write under `ttsUsage`/`ttsCache` failed, so the voice caps undercount. | Same check. Revoke or limit the ElevenLabs key if it persists. |
| `agentSession-accounting-failed` | The reception session counter under `agentUsage` failed, so the session caps undercount. | Same check. |

## Caps reached

These usually mean the limits are doing their job. Look at who is spending
before raising anything.

| Key | Cap | What the visitor sees | What to do |
| --- | --- | --- | --- |
| `npcVoice-cap-hit` | `TTS_DAILY_CHAR_CAP` (4,000 characters) or `TTS_MONTHLY_CHAR_CAP` (75,000) | Villagers speak with the browser's voice until the next day or month (Melbourne calendar). | If one IP is behind it, the per-IP windows in `ttsRate`/`ttsFetch` show it. To raise a cap, recompute it against the ElevenLabs plan (`eleven_v3` bills one credit per character), change `constants.ts`, redeploy `npcVoice`. |
| `agentSession-cap-hit` | `AGENT_DAILY_SESSION_CAP` (25) or `AGENT_MONTHLY_SESSION_CAP` (300) | The reception desk says it is unavailable. | Same approach with `agentRate`/`agentFetch`. Check the plan's agent minutes before raising the caps. |

The chat's monthly token cap (`MONTHLY_TOKEN_CAP`, shared by npcChat, the
planner and the analyst) has no `ALERT`: it shows up as `cap` fallbacks under
`aiUsage/{month}/fallbacks` and in the nightly email.

## Voice vendor (ElevenLabs)

| Key | What happened | What to do |
| --- | --- | --- |
| `npcVoice-tts-failed` | ElevenLabs answered 429 or 5xx, or the request threw. Villagers fall back to the browser's voice. | Whatever the status, compare the remaining credits in the ElevenLabs dashboard with `ttsUsage/{month}`. If the vendor shows far more spend than the island's counters, someone else is using the key (as in August 2026): revoke it first. Otherwise 5xx is a vendor outage and 429 is the vendor limiting the account. |
| `agentSession-mint-failed` | ElevenLabs answered 429 or 5xx while minting the signed URL, or the request threw. | As above. |

A 4xx from ElevenLabs is logged as `npcVoice synth rejected` or
`agentSession mint rejected`, without the `ALERT` prefix, because it usually
means configuration (a missing voice id, the agent's authentication setting).
A run of them is still worth a look in the logs.

## Email and GitHub

| Key | What happened | What to do |
| --- | --- | --- |
| `lead-email-failed` | Sending a contact-form email failed. The lead is still stored under `leads/island/<entryId>`. | `code` says why. EAUTH: the SMTP password was revoked or changed; set a new `SMTP_PASSWORD` and redeploy onLeadCreated and analyst. Connection errors: the mail provider. Then read the missed leads in the Firebase console. |
| `lead-email-throttled` | More than 10 lead emails in one hour, so the rest were not sent. Leads are still stored. | Most likely a script filling in the form: look at `leads/island`, delete the junk. The counter resets every hour. |
| `analyst-email-failed` | The nightly digest was not sent. | Same SMTP checks as `lead-email-failed`. The day's numbers are still in `stats/daily/{day}`. |
| `analyst-github-failed` | The issue-filing arm failed. `at` says where: `list-closed` (reading the recently closed proposals, which skips that night's filing), `cooldown-read`, `list`, `close`, `create`, `label-missing`, `cooldown-write` or `outer`. | The email still goes out and reports the GitHub arm's status. A 401 means `GITHUB_TOKEN` expired or was revoked; 403 or 404 means it lacks access to the repo. It needs issues read and write on `digiscalability/portfolio-island`. `label-missing` means the issue was filed without the `island-analyst` label, which blinds the cap and the de-duplication; give the token rights to label issues. `cooldown-write` means the next night may file again. |
| `analyst-stats-failed` | The daily snapshot under `stats/daily` was not written. | Tomorrow's digest has no day-over-day changes. Nothing else to do unless it repeats. |
| `analyst-notice-failed` | The Island Times edition under `world/island/notice` was not written. | The board shows the previous edition. Check the database, then Force run the analyst. |

## Housekeeping

| Key | What happened | What to do |
| --- | --- | --- |
| `janitor-prune-failed` | One of the janitor's prunes failed; the others still ran. `index` says which: 0 presence, 1 chat, 2 voice, 3 aiRate, 4 stats/daily, 5 ttsQueue, 6 ttsRate, 7 ttsFetch, 8 agentRate, 9 agentFetch, 10 the ttsCache sweep. | It runs every 6 hours, so one failure is harmless. If it repeats, that node has probably grown past what the job can read in its 120 seconds; prune it by hand in the console. |

## Checks no alert covers

- **The vendor balances.** The island's counters only see the island's own
  calls. A leaked key spends outside them, and nothing above fires until the
  balance runs out. Once a week, compare the Anthropic and ElevenLabs usage
  pages with `aiUsage/{month}` and `ttsUsage/{month}`.
- **The reception agent is private.** `agentSession` only gates the desk if
  the ElevenLabs agent requires authentication. After any change to the
  agent's settings, check that it still does.
- **The Anthropic workspace spend limit is set.** It is the stop that holds
  when everything in this repo fails.
