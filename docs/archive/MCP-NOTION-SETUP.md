# Notion MCP Server Setup (VS Code + GitHub Copilot)

This repo is pre-configured to use the official Notion MCP server in `mcp.json`. Follow these steps to get it working in Copilot Chat (Agent mode).

## 1) Create a Notion Integration

- Go to <https://www.notion.so/profile/integrations> and create an Internal integration
- Copy the Internal Integration token (starts with `ntn_...`)
- Optional hardening: limit capabilities to "Read content" for read-only access

## 2) Connect pages/databases to the integration

- In the Integration’s Access tab, grant access to the pages or databases you want to expose
- Or open each page, click ••• and choose "Connect to integration"

## 3) Provide the token to VS Code once

We’ve added a secure input prompt in `mcp.json`. The first time the Notion MCP server starts, VS Code will ask for:

- Notion Internal Integration token (saved securely)

You can rotate or clear inputs via the command: “MCP: Reset Inputs”.

## 4) What’s configured

- Stdio transport using npm:
  - `command: npx`
  - `args: ["-y", "@notionhq/notion-mcp-server"]`
  - Env var `NOTION_TOKEN` is referenced from a secure input prompt
  - Env var `OPENAPI_MCP_HEADERS` sets `{"Notion-Version":"2025-09-03"}` to ensure compatibility with multi‑source databases

This is defined under the `notion` server in `mcp.json`.

## 5) Use in Copilot Chat

- Open Chat and switch to Agent mode
- On first use, approve the trust prompt for the Notion server
- Select Tools (wrench icon) and enable Notion tools if they aren’t already
- You can reference tools in prompts (type `#` and start typing to search tools)

## 6) HTTP transport (optional)

If you prefer the HTTP transport instead of stdio:

- Run in a terminal:

```bash
npx -y @notionhq/notion-mcp-server --transport http --port 3000
```

- Then adjust `mcp.json` to:
  - `type: "http"`
  - `url: "http://127.0.0.1:3000/mcp"`
  - Provide auth (either `--auth-token` or `AUTH_TOKEN` env) per server README

## Security notes

- MCP tools can act on your Notion data. Use a read-only token where possible.
- Limit page access to the minimum set needed.
- Rotate tokens periodically.

See `NOTION-API-MIGRATION-2025-09-03.md` for details on the API changes and how to write compatible scripts.

References: <https://github.com/makenotion/notion-mcp-server>
