// api/csp-report.js — collects Content-Security-Policy violation reports while
// the site policy runs report-only (vercel.json). Each violation becomes one
// `csp-report {...}` line in the Vercel runtime logs; nothing is stored. Read
// the logs before switching the policy to enforcing. ESM, zero deps.
//
// A Web handler on purpose: the Node (req, res) helpers parse only json, text,
// form and octet-stream bodies, so browsers' application/csp-report and
// application/reports+json payloads would arrive empty.
const MAX_BODY = 16 * 1024;
const MAX_REPORTS = 10;

const clip = (v) =>
  typeof v === 'string' ? v.slice(0, 200) : typeof v === 'number' ? v : undefined;

/** Origin and path only: report URLs can carry tokens in their query string. */
const bare = (v) => {
  if (typeof v !== 'string') return undefined;
  try {
    const u = new URL(v);
    return clip(`${u.origin}${u.pathname}`);
  } catch {
    return clip(v.split(/[?#]/)[0]); // 'inline', 'eval', 'blob', 'data'
  }
};

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
      page: bare(b.documentURL ?? b['document-uri']),
      directive: clip(b.effectiveDirective ?? b['effective-directive'] ?? b['violated-directive']),
      blocked: bare(b.blockedURL ?? b['blocked-uri']),
      source: bare(b.sourceFile ?? b['source-file']),
      line: clip(b.lineNumber ?? b['line-number']),
      sample: clip(b.sample ?? b['script-sample']),
      mode: clip(b.disposition),
    });
  }
  return rows;
}

export async function POST(request) {
  if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY) {
    return new Response(null, { status: 413 });
  }
  try {
    const text = (await request.text()).slice(0, MAX_BODY);
    for (const row of parseReports(text)) console.log(`csp-report ${JSON.stringify(row)}`);
  } catch {
    /* a malformed report must never turn into an error for the browser */
  }
  return new Response(null, { status: 204 });
}
