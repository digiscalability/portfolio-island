# Notion API upgrade: 2025-09-03 (multi‑source databases)

This repo doesn’t currently ship application code that calls the Notion API directly. We run the official Notion MCP server for Copilot Chat, and we sometimes run one‑off scripts. This guide explains what changed in the 2025‑09‑03 Notion API and how to write compatible scripts moving forward.

We’ve also configured the MCP server to explicitly use this API version.

## What changed (high‑level)

- Databases can have multiple data sources. Many endpoints that previously used `database_id` now require a `data_source_id`.
- Creating pages in a database and relation properties must identify a specific data source.
- Some endpoints moved from `/v1/databases/*` to `/v1/data_sources/*` for the 2025‑09‑03 version.
- Search returns data sources for databases that have multiple sources.

## Repo configuration (already done)

- MCP (`mcp.json`) is set to pass the version header:
  - `OPENAPI_MCP_HEADERS: { "Notion-Version": "2025-09-03" }`
- `.env.local` now includes a placeholder `NOTION_VERSION=2025-09-03`. Do not commit real tokens.

## How to adapt your scripts

If you add Node/TypeScript utilities that use the Notion API, follow this contract:

- Inputs: `NOTION_TOKEN` (or `NOTION_API_KEY`) set in your environment; optional `NOTION_VERSION`.
- Outputs: JSON data from Notion endpoints; handle multiple `data_sources` per database.
- Error modes: missing/invalid token, using a `database_id` where a `data_source_id` is required, permission errors.
- Success criteria: scripts retrieve `data_source_id` and use it for page creation, relations, and queries.

### 1) Discover data source IDs for a database

Use the new Retrieve Database to list `data_sources`, or use the SDK to fetch and store them.

JavaScript (ESM):

```js
import { Client } from "@notionhq/client";

const notion = new Client({ auth: process.env.NOTION_TOKEN, notionVersion: process.env.NOTION_VERSION || "2025-09-03" });

// For discovery: get database, then pick a data_source_id
const databaseId = process.env.DATABASE_ID; // 32-char or dashed UUID
const db = await notion.databases.retrieve({ database_id: databaseId });
// db.data_sources: [{ id, name }, ...]
const dataSourceId = db.data_sources?.[0]?.id;
console.log({ dataSourceId, dataSources: db.data_sources });
```

If you’re on an SDK version that doesn’t expose the new helpers yet, you can call the raw endpoint:

```js
const resp = await notion.request({ path: `/v1/databases/${databaseId}`, method: "get" });
const dataSourceId = resp.data_sources?.[0]?.id;
```

### 2) Create a page in a data source

Old body used `{ parent: { type: 'database_id', database_id } }`. New way specifies a `data_source_id` parent (works on any API version; required after upgrading endpoint versions):

```js
await notion.pages.create({
  parent: { type: "data_source_id", data_source_id: dataSourceId },
  properties: {
    Name: { title: [{ text: { content: "Hello multi‑source" } }] }
  }
});
```

### 3) Query a data source

When using API version 2025‑09‑03, the path for queries is `/v1/data_sources/:data_source_id/query`.

Until your SDK provides `notion.dataSources.query`, call the endpoint via `notion.request`:

```js
const results = await notion.request({
  path: `/v1/data_sources/${dataSourceId}/query`,
  method: "patch",
  body: { /* filter, sorts, page_size */ },
});
```

Later, with the v5 SDK, switch to the official helper:

```js
// Example signature (subject to SDK v5 naming):
// await notion.dataSources.query({ data_source_id: dataSourceId, filter, sorts });
```

### 4) Relations now reference data sources

When defining a relation property, only provide `data_source_id` in the write path. Both `database_id` and `data_source_id` will appear in reads for convenience.

```js
await notion.databases.update({
  database_id: databaseId,
  // For data-source-specific schema changes, use the Update Data Source endpoint
  // For relation properties, provide only data_source_id in write objects
});
```

### 5) Search returns data sources

When using 2025‑09‑03, filter values change to `page | data_source`:

```js
await notion.search({
  query: "Tasks",
  filter: { property: "object", value: "data_source" },
});
```

## Optional local script pattern

You can create a minimal ESM script that runs with Node 20+:

```js
// save as tools/notion/get-data-source-id.mjs
import { Client } from "@notionhq/client";

const notion = new Client({ auth: process.env.NOTION_TOKEN, notionVersion: process.env.NOTION_VERSION || "2025-09-03" });
const databaseId = process.env.DATABASE_ID;
if (!databaseId) throw new Error("Set DATABASE_ID env var");
const db = await notion.databases.retrieve({ database_id: databaseId });
console.log(JSON.stringify(db.data_sources ?? [], null, 2));
```

Run (example):

```bash
# one-time
npm i @notionhq/client

# run
NOTION_TOKEN=ntn_xxx DATABASE_ID=xxxx node tools/notion/get-data-source-id.mjs
```

## Webhooks and SDK

- If you use webhooks, bump your subscription version and handle new data shapes (see Notion docs).
- Upgrade to `@notionhq/client` v5+ when feasible. Set `notionVersion: "2025-09-03"` at initialization.

## Security

- Never commit real tokens. We sanitized `.env.local` and added placeholders. Rotate any previously committed keys.
- For MCP, we use VS Code’s secure input for `NOTION_TOKEN`.

## References

- Notion guide: Upgrading to Version 2025‑09‑03
- Notion SDK: <https://github.com/makenotion/notion-sdk-js>
- Notion MCP server: <https://github.com/makenotion/notion-mcp-server>
