# Security

## Reporting a vulnerability

Email **[admin@digiscalability.com](mailto:admin@digiscalability.com)** with what
you found and how to reproduce it.
Please don't open a public issue for anything exploitable, and don't test
against other visitors' data or run up the AI and voice budgets: the spend caps
are part of what is being protected.

In scope: island.digiscalability.com, the Cloud Functions in `functions/`, and
the Realtime Database rules in `database.rules.json`.

## How secrets are handled

- Client: the bundle carries only public identifiers: the Firebase
  **Web API key** and the reCAPTCHA Enterprise site key that App Check uses,
  both public by design (access control lives in the database rules and App
  Check).
- Server: every real secret (the Anthropic and ElevenLabs keys, the SMTP
  password, the GitHub token) lives in Google Secret Manager, set with
  `firebase functions:secrets:set` and declared with `defineSecret` in
  `functions/src`. None is in git.
- `.env*` files are git-ignored; the `.env.example` files hold placeholders only.
- Every function that spends money (`npcChat`, `npcVoice`, `agentSession`, the
  planner and the analyst) enforces its own caps on the server. The failure
  markers they log, and what to do about each, are in
  [docs/runbook.md](docs/runbook.md).

## History

Early in this project's life (before any history that exists in this
repository), real API keys were briefly committed to a local `.env.local`.
That working tree's history was discarded; the history published here was
verified clean before the repository was made public — a full scan of every
revision on every branch found no `.env.local` blob and no credential-shaped
strings (OpenAI/Anthropic/Notion/GitHub/AWS key formats, private keys).

The keys involved in the original incident were treated as compromised and
rotated at the time.
