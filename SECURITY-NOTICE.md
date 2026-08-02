# Security note

Early in this project's life (before any history that exists in this
repository), real API keys were briefly committed to a local `.env.local`.
That working tree's history was discarded; the history published here was
verified clean before the repository was made public — a full scan of every
revision on every branch found no `.env.local` blob and no credential-shaped
strings (OpenAI/Anthropic/Notion/GitHub/AWS key formats, private keys).

The keys involved in the original incident were treated as compromised and
rotated at the time.

Current secret handling:

- Client: the only key in the bundle is the Firebase **Web API key**, which is
  public by design (access control lives in database rules + App Check).
- Server: all real secrets (Anthropic key, SMTP password, GitHub token) live in
  Google Secret Manager via `firebase functions:secrets:set` — never in git.
- `.env*` files are gitignored; `.env.example` files carry placeholders only.
