// Content-Security-Policy for the island (vercel.json), the share route's
// own policy (api/z.js) and the report collector (api/csp-report.js).
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';

import cspReport, { parseReports } from '../api/csp-report.js';
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
    // Editing the inline boot guard or the font loader's onload changes its
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

  test('POST logs one line per violation and answers 204', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const out: RouteResult = { status: 0, headers: {}, body: '' };
    await cspReport({ method: 'POST', body: legacy }, fakeRes(out));
    expect(out.status).toBe(204);
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0][0])).toMatch(/^csp-report \{"page":"https:\/\/island/);
  });

  test('reads a raw stream when the platform leaves the body unparsed', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const out: RouteResult = { status: 0, headers: {}, body: '' };
    const req = {
      method: 'POST',
      body: undefined,
      async *[Symbol.asyncIterator]() {
        yield Buffer.from(JSON.stringify(legacy));
      },
    };
    await cspReport(req, fakeRes(out));
    expect(out.status).toBe(204);
    expect(log).toHaveBeenCalledTimes(1);
  });

  test('anything but POST is refused', async () => {
    const out: RouteResult = { status: 0, headers: {}, body: '' };
    await cspReport({ method: 'GET' }, fakeRes(out));
    expect(out.status).toBe(405);
    expect(out.headers.allow).toBe('POST');
  });
});
