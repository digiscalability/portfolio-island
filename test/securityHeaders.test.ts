// Content-Security-Policy for the island (vercel.json), the share route's
// own policy (api/z.js) and the report collector (api/csp-report.js).
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { parseReports, POST as cspReport } from '../api/csp-report.js';
import zoneRoute from '../api/z.js';

const src = (f: string): string =>
  readFileSync(join(process.cwd(), f), 'utf8').replace(/\r\n/g, '\n');
const sha = (s: string): string => `'sha256-${createHash('sha256').update(s).digest('base64')}'`;
const directives = (policy: string): Map<string, string[]> =>
  new Map(
    policy
      .split(';')
      .map((d) => d.trim().split(/\s+/))
      .filter((parts) => parts[0])
      .map(([name, ...values]) => [name, values]),
  );

type HeaderRule = { source: string; headers: Array<{ key: string; value: string }> };
const cfg = JSON.parse(src('vercel.json')) as { headers: HeaderRule[] };
const site = cfg.headers.find((h) =>
  h.headers.some((x) => x.key === 'Content-Security-Policy-Report-Only'),
);
const header = (key: string): string => site?.headers.find((h) => h.key === key)?.value ?? '';
const reportOnly = directives(header('Content-Security-Policy-Report-Only'));

afterEach(() => {
  vi.restoreAllMocks();
});

describe('site policy (vercel.json)', () => {
  test('covers every page but the share route and the API', () => {
    expect(site, 'vercel.json sets no Content-Security-Policy-Report-Only').toBeDefined();
    const re = new RegExp(`^${site!.source}$`);
    for (const path of [
      '/',
      '/hire.html',
      '/privacy.html',
      '/404.html',
      '/assets/main-abcd1234.js',
    ]) {
      expect(re.test(path), path).toBe(true);
    }
    for (const path of ['/z/hire', '/api/z', '/api/csp-report']) {
      expect(re.test(path), path).toBe(false);
    }
  });

  test('enforces only the directives that cannot break the page', () => {
    const enforced = directives(header('Content-Security-Policy'));
    expect([...enforced.keys()].sort()).toEqual(['base-uri', 'frame-ancestors', 'object-src']);
    expect(enforced.get('frame-ancestors')).toEqual(["'self'"]);
    expect(enforced.get('object-src')).toEqual(["'none'"]);
    expect(enforced.get('base-uri')).toEqual(["'none'"]);
    expect(src('index.html')).not.toMatch(/<base[\s>]/);
  });

  test("allows index.html's inline script and inline handlers by hash", () => {
    // Editing the inline boot guard changes its
    // hash: put the new value from this failure into vercel.json.
    const html = src('index.html');
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    const handlers = [...html.matchAll(/\son[a-z]+="([^"]*)"/g)].map((m) => m[1]);
    expect(scripts).toHaveLength(1);
    const allowed = reportOnly.get('script-src') ?? [];
    for (const code of [...scripts, ...handlers])
      expect(allowed, code.slice(0, 60)).toContain(sha(code));
    if (handlers.length) expect(allowed).toContain("'unsafe-hashes'");
  });

  test('self-hosted fonts (D12): no inline handler, no Google Fonts host, no unsafe-hashes', () => {
    const html = src('index.html');
    expect([...html.matchAll(/\son[a-z]+="([^"]*)"/g)]).toEqual([]);
    expect(html).not.toMatch(/fonts\.(googleapis|gstatic)\.com/);
    expect(reportOnly.get('script-src')).not.toContain("'unsafe-hashes'");
    // One hash left: the inline boot script's.
    expect(
      (reportOnly.get('script-src') ?? []).filter((v) => v.startsWith("'sha256-")),
    ).toHaveLength(1);
    expect(reportOnly.get('style-src')).toEqual(["'self'", "'unsafe-inline'"]);
    expect(reportOnly.get('font-src')).toEqual(["'self'", 'data:']);
    // Both faces are files in public/fonts, preloaded (Bebas) or fetched on
    // first use (Patrick Hand), and declared by their exact family names.
    for (const f of ['bebas-neue-latin.woff2', 'patrick-hand-latin.woff2']) {
      expect(existsSync(join(process.cwd(), 'public/fonts', f)), f).toBe(true);
    }
    expect(html).toMatch(
      /rel="preload"\s+as="font"\s+type="font\/woff2"\s+href="\/fonts\/bebas-neue-latin\.woff2"\s+crossorigin/,
    );
    expect(html).not.toContain('href="/fonts/patrick-hand-latin.woff2"');
    expect(html).toContain("font-family: 'Bebas Neue';");
    expect(html).toContain("font-family: 'Patrick Hand';");
    expect(html).toContain("font-family: 'Bebas Neue Fallback';");
  });

  test('connect-src reaches the hosts the client calls', () => {
    const allowed = reportOnly.get('connect-src') ?? [];
    const weather = [
      ...src('EnvironmentCycle.ts').matchAll(/fetch\(\s*[`']?(https:\/\/[a-z0-9.-]+)/g),
    ];
    expect(weather.length).toBeGreaterThan(0);
    for (const [, origin] of weather) expect(allowed, origin).toContain(origin);
    expect(src('firebaseClient.ts')).toContain(
      "databaseURL: 'https://life-island-default-rtdb.firebaseio.com'",
    );
    expect(allowed).toContain('https://*.firebaseio.com');
    expect(allowed).toContain('wss://*.firebaseio.com');
    for (const file of ['NpcChat.ts', 'ReceptionDesk.ts', 'profileSync.ts']) {
      expect(src(file), file).toContain("getFunctions(app, 'us-central1')");
    }
    expect(allowed).toContain('https://us-central1-life-island.cloudfunctions.net');
  });

  test("App Check's reCAPTCHA Enterprise can load, frame and call home", () => {
    // Measured headless: recaptcha__en.js fetches www.google.com/recaptcha/enterprise/clr.
    expect(src('firebaseClient.ts')).toContain('ReCaptchaEnterpriseProvider');
    expect(reportOnly.get('script-src')).toEqual(
      expect.arrayContaining([
        'https://www.google.com/recaptcha/',
        'https://www.gstatic.com/recaptcha/',
      ]),
    );
    expect(reportOnly.get('connect-src')).toContain('https://www.google.com/recaptcha/');
    expect(reportOnly.get('frame-src')).toEqual(['https:']);
  });

  test('the voice desk and model loading are covered', () => {
    // @elevenlabs/client loads its worklets from blob: URLs, and in Firefox
    // (no sampleRate constraint) resamples with a WebAssembly worklet from
    // jsdelivr. three's GLTFLoader fetches embedded textures from blob: URLs.
    const script = reportOnly.get('script-src') ?? [];
    expect(script).toEqual(expect.arrayContaining(["'wasm-unsafe-eval'", 'blob:']));
    expect(script.some((s) => s.startsWith('https://cdn.jsdelivr.net/npm/@alexanderolsen/'))).toBe(
      true,
    );
    expect(script).not.toContain("'unsafe-eval'");
    expect(script).not.toContain("'unsafe-inline'");
    expect(reportOnly.get('connect-src')).toContain('blob:');
  });

  test('reports go to the collector', () => {
    expect(reportOnly.get('report-uri')).toEqual(['/api/csp-report']);
    expect(reportOnly.get('report-to')).toEqual(['csp']);
    expect(header('Reporting-Endpoints')).toBe('csp="/api/csp-report"');
  });
});

type RouteResult = { status: number; headers: Record<string, string>; body: string };
function fakeRes(out: RouteResult) {
  const res = {
    setHeader(k: string, v: string) {
      out.headers[k.toLowerCase()] = v;
      return res;
    },
    status(code: number) {
      out.status = code;
      return res;
    },
    send(body: string) {
      out.body = body;
      return res;
    },
    end() {
      return res;
    },
  };
  return res;
}

describe('share route policy (api/z.js)', () => {
  test.each([{ zone: 'hire' }, { zone: 'projects', hour: '18', utm_source: 'linkedin' }])(
    'allows exactly its redirect script (%o)',
    (query) => {
      const out: RouteResult = { status: 0, headers: {}, body: '' };
      zoneRoute({ query }, fakeRes(out));
      expect(out.headers['content-security-policy'], 'api/z.js sets no policy').toBeDefined();
      const policy = directives(out.headers['content-security-policy']);
      const scripts = [...out.body.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
      expect(scripts).toHaveLength(1);
      expect(policy.get('script-src')).toEqual([sha(scripts[0])]);
      expect(policy.get('default-src')).toEqual(["'none'"]);
      expect(policy.get('frame-ancestors')).toEqual(["'none'"]);
    },
  );
});

describe('report collector (api/csp-report.js)', () => {
  const legacy = {
    'csp-report': {
      'document-uri': 'https://island.digiscalability.com/',
      'effective-directive': 'connect-src',
      'blocked-uri': 'https://example.org/x',
      'line-number': 12,
    },
  };

  test('reads report-uri and Reporting API payloads', () => {
    expect(parseReports(JSON.stringify(legacy))).toEqual([
      {
        page: 'https://island.digiscalability.com/',
        directive: 'connect-src',
        blocked: 'https://example.org/x',
        source: undefined,
        line: 12,
        sample: undefined,
        mode: undefined,
      },
    ]);
    const api = [
      {
        type: 'csp-violation',
        body: {
          documentURL: '/',
          effectiveDirective: 'script-src-elem',
          blockedURL: 'inline',
          disposition: 'report',
        },
      },
      { type: 'deprecation', body: {} },
    ];
    expect(parseReports(api)).toEqual([
      expect.objectContaining({
        page: '/',
        directive: 'script-src-elem',
        blocked: 'inline',
        mode: 'report',
      }),
    ]);
  });

  test('ignores garbage and caps what it keeps', () => {
    expect(parseReports('not json')).toEqual([]);
    expect(parseReports({ nope: 1 })).toEqual([]);
    const many = Array.from({ length: 50 }, () => ({
      type: 'csp-violation',
      body: { blockedURL: 'x'.repeat(5000) },
    }));
    const rows = parseReports(many);
    expect(rows).toHaveLength(10);
    expect(rows[0].blocked).toHaveLength(200);
  });

  // Browsers send these two content types, which the Node (req, res) helpers
  // leave unparsed; the Web handler reads the raw body either way.
  test.each([
    ['application/csp-report', legacy],
    [
      'application/reports+json',
      [{ type: 'csp-violation', body: { documentURL: 'https://island.digiscalability.com/' } }],
    ],
  ])('a %s POST logs one line and answers 204', async (type, payload) => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const res = await cspReport(
      new Request('https://island.digiscalability.com/api/csp-report', {
        method: 'POST',
        headers: { 'content-type': type },
        body: JSON.stringify(payload),
      }),
    );
    expect(res.status).toBe(204);
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0][0])).toMatch(/^csp-report \{"page":"https:\/\/island/);
  });

  test('logs origin and path only, never a query string', () => {
    const [row] = parseReports({
      'csp-report': {
        'document-uri': 'https://island.digiscalability.com/?pc=1#x',
        'blocked-uri': 'https://s-usc1a-nss-2000.firebaseio.com/.lp?id=7&pw=secret',
      },
    });
    expect(row.page).toBe('https://island.digiscalability.com/');
    expect(row.blocked).toBe('https://s-usc1a-nss-2000.firebaseio.com/.lp');
  });

  test('a body over 16 KB is refused unread', async () => {
    const text = vi.fn(async () => '');
    const res = await cspReport({
      headers: new Headers({ 'content-length': String(17 * 1024) }),
      text,
    } as unknown as Request);
    expect(res.status).toBe(413);
    expect(text).not.toHaveBeenCalled();
  });
});
