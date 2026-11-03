// api/csp-report.js — collects Content-Security-Policy violation reports while
// the site policy runs report-only (vercel.json). Each violation becomes one
// `csp-report {...}` line in the Vercel runtime logs; nothing is stored. Read
// the logs before switching the policy to enforcing. ESM, zero deps.
const MAX_BODY = 16 * 1024;
const MAX_REPORTS = 10;

const clip = (v) =>
  typeof v === 'string' ? v.slice(0, 200) : typeof v === 'number' ? v : undefined;

/**
 * Both wire formats: report-uri's `{"csp-report": {...}}` and the Reporting
 * API's `[{type: "csp-violation", body: {...}}]`. Anything else yields no rows.
 */
export function parseReports(raw) {
  let data;
  try {
    data = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return [];
  }
  const items = Array.isArray(data) ? data : [data];
  const rows = [];
  for (const item of items.slice(0, MAX_REPORTS)) {
    if (!item || typeof item !== 'object') continue;
    const legacy = item['csp-report'];
    const b =
      legacy && typeof legacy === 'object'
        ? legacy
        : item.type === 'csp-violation' && item.body && typeof item.body === 'object'
          ? item.body
          : null;
    if (!b) continue;
    rows.push({
      page: clip(b.documentURL ?? b['document-uri']),
      directive: clip(b.effectiveDirective ?? b['effective-directive'] ?? b['violated-directive']),
      blocked: clip(b.blockedURL ?? b['blocked-uri']),
      source: clip(b.sourceFile ?? b['source-file']),
      line: clip(b.lineNumber ?? b['line-number']),
      sample: clip(b.sample ?? b['script-sample']),
      mode: clip(b.disposition),
    });
  }
  return rows;
}

async function readBody(req) {
  if (req.body !== undefined && req.body !== null) {
    return Buffer.isBuffer(req.body) ? req.body.toString('utf8', 0, MAX_BODY) : req.body;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) break;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).end();
    return;
  }
  try {
    for (const row of parseReports(await readBody(req))) {
      console.log(`csp-report ${JSON.stringify(row)}`);
    }
  } catch {
    /* a malformed report must never turn into an error for the browser */
  }
  res.status(204).end();
}
