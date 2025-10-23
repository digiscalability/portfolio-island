// Minimal helper to list data sources for a database
// Usage:
//   npm i @notionhq/client
//   NOTION_TOKEN=ntn_xxx NOTION_VERSION=2025-09-03 DATABASE_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx node tools/notion/get-data-source-id.mjs

import { Client } from "@notionhq/client";

const token = process.env.NOTION_TOKEN || process.env.NOTION_API_KEY;
if (!token) {
  console.error("Missing NOTION_TOKEN (or NOTION_API_KEY)");
  process.exit(1);
}

const version = process.env.NOTION_VERSION || "2025-09-03";
const databaseId = process.argv[2] || process.env.DATABASE_ID;
if (!databaseId) {
  console.error("Usage: node get-data-source-id.mjs <database-id>");
  console.error("Or set DATABASE_ID environment variable");
  process.exit(1);
}

const notion = new Client({ auth: token, notionVersion: version });

try {
  const db = await notion.databases.retrieve({ database_id: databaseId });
  const dataSources = db.data_sources ?? [];
  console.log(JSON.stringify({ databaseId, dataSources }, null, 2));
} catch (err) {
  console.error("Error retrieving database/data_sources:", err?.message || err);
  process.exit(2);
}
