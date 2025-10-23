# Security notice: rotate leaked secrets

We found real API keys committed in `.env.local` and replaced them with placeholders. If this repository has ever been pushed to a remote, assume those credentials are compromised and rotate them immediately:

- Firebase keys (API key, app ID, measurement ID)
- OpenAI and Google AI keys
- Notion token/API key

Recommended actions:

1) Revoke/rotate each key in its provider dashboard.
2) Confirm `.env.local` and `.env.*.local` are git‑ignored (they are in `.gitignore`).
3) Store secrets in a secure vault (e.g., GitHub Actions secrets, 1Password, Doppler) and load at runtime.
4) Avoid committing real secrets in any file. Use `.env.example` with placeholders.

This repo now:

- Sanitized `.env.local` with placeholders.
- Configured the Notion MCP server to use secure input for the token.
