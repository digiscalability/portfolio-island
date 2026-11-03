// The probe harness's safety net (tools/ux-probes/lib.cjs), item CO-E1. Every
// probe and the perf gate run the production build through this one rule, so
// the table below is what keeps a probe off the real backend: a non-GET never
// leaves, a backend host is blocked even for a GET, every WebSocket closes, and
// a response that gets past anyway fails the run closed (exit 2).
import { createRequire } from 'node:module';
import { describe, expect, test } from 'vitest';

type Verdict = { code: number; verdict: string; why: string[] };
type NetSum = {
  leaks: string[];
  signUpIntercepted: boolean;
  appCheckIntercepted: boolean;
  bootProofIntercepted: boolean;
  intercepted: string[];
};
type Session = {
  net: {
    leaks: string[];
    intercepted: string[];
    signUpSeen: boolean;
    appCheckSeen: boolean;
    bootProofSeen: boolean;
    offHost: Set<string>;
  };
};

const lib = createRequire(import.meta.url)('../tools/ux-probes/lib.cjs') as {
  EXIT: Record<string, number>;
  classify: (r: {
    url: string;
    method?: string;
    resourceType?: string;
    isWebSocket?: boolean;
  }) => string;
  leakReason: (e: {
    event: string;
    method: string;
    url: string;
    aborted?: boolean;
    errorText?: string;
  }) => string | null;
  bootProof: (line: string) => string | null;
  isBlockedUrl: (u: string) => boolean;
  netSummary: (sessions: Session[]) => NetSum;
  verdict: (
    checks: Array<{ name: string; pass: boolean | null }>,
    net: NetSum | null,
    o?: { requireSignUp?: boolean },
  ) => Verdict;
  SELFTEST_URL: string;
};

const LOCAL = 'http://127.0.0.1:5191';
const SIGNUP = 'https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=AIza-not-a-key';
const EXCHANGE =
  'https://content-firebaseappcheck.googleapis.com/v1/projects/life-island/apps/1:2:web:3:exchangeRecaptchaEnterpriseToken';

describe('classify(): the one interception rule', () => {
  // [method, url, expected] — resourceType and isWebSocket are covered below.
  const TABLE: Array<[string, string, string]> = [
    // The build's own files and the fonts load.
    ['GET', `${LOCAL}/?owner=1`, 'allow'],
    ['GET', `${LOCAL}/assets/main-abc123.js`, 'allow'],
    ['GET', `${LOCAL}/assets/models/player.glb`, 'allow'],
    ['GET', 'https://fonts.googleapis.com/css2?family=Bebas+Neue', 'allow'],
    ['GET', 'https://fonts.gstatic.com/s/bebasneue/v16/x.woff2', 'allow'],
    // Every non-GET is aborted, wherever it goes (HEAD included).
    ['POST', `${LOCAL}/api/csp-report`, 'abort-nonget'],
    ['PUT', `${LOCAL}/api/z`, 'abort-nonget'],
    ['PATCH', `${LOCAL}/x`, 'abort-nonget'],
    ['DELETE', `${LOCAL}/x`, 'abort-nonget'],
    ['HEAD', `${LOCAL}/`, 'abort-nonget'],
    ['OPTIONS', 'https://example.com/', 'abort-nonget'],
    ['post', `${LOCAL}/x`, 'abort-nonget'],
    // Backend hosts are blocked for any method, GET included.
    ['GET', 'https://life-island-default-rtdb.firebaseio.com/.json', 'block-host'],
    [
      'GET',
      'https://life-island-default-rtdb.asia-southeast1.firebasedatabase.app/x.json',
      'block-host',
    ],
    ['GET', 'https://life-island.firebaseapp.com/__/auth/iframe', 'block-host'],
    ['POST', SIGNUP, 'block-host'],
    ['GET', 'https://securetoken.googleapis.com/v1/token', 'block-host'],
    ['POST', EXCHANGE, 'block-host'],
    ['GET', 'https://content-firebaseappcheck.googleapis.com/v1/x', 'block-host'],
    ['GET', 'https://firebaseappcheck.googleapis.com/v1/x', 'block-host'],
    ['GET', 'https://firestore.googleapis.com/v1/projects/p/databases', 'block-host'],
    ['GET', 'https://firebaseinstallations.googleapis.com/v1/x', 'block-host'],
    ['GET', 'https://us-central1-life-island.cloudfunctions.net/npcChat', 'block-host'],
    ['GET', 'https://npcchat-abc123-uc.a.run.app/', 'block-host'],
    ['GET', 'https://api.elevenlabs.io/v1/convai/conversation', 'block-host'],
    ['GET', 'https://www.google.com/recaptcha/enterprise.js?render=k', 'block-host'],
    ['GET', 'https://www.gstatic.com/recaptcha/releases/x/recaptcha__en.js', 'block-host'],
    ['GET', `${LOCAL}/_vercel/insights/script.js`, 'block-host'],
    ['GET', `${LOCAL}/_vercel/speed-insights/script.js`, 'block-host'],
    ['GET', 'https://vitals.vercel-insights.com/v1/vitals', 'block-host'],
    ['GET', 'https://www.google-analytics.com/g/collect', 'block-host'],
    ['GET', 'https://www.googletagmanager.com/gtag/js', 'block-host'],
    ['GET', 'https://accounts.google.com/o/oauth2', 'block-host'],
    ['GET', 'https://api.open-meteo.com/v1/forecast?latitude=1', 'block-host'],
    ['GET', 'https://ipapi.co/json/', 'block-host'],
    ['GET', 'https://api.bigdatacloud.net/data/reverse-geocode-client', 'block-host'],
  ];

  test.each(TABLE)('%s %s -> %s', (method, url, want) => {
    expect(lib.classify({ url, method })).toBe(want);
  });

  test('every WebSocket closes, by scheme, by resource type or by flag', () => {
    expect(lib.classify({ url: 'ws://127.0.0.1:5191/mp' })).toBe('close-ws');
    expect(lib.classify({ url: 'wss://s-usc1.firebaseio.com/.ws?v=5' })).toBe('close-ws');
    expect(lib.classify({ url: 'wss://api.elevenlabs.io/v1/convai' })).toBe('close-ws');
    expect(lib.classify({ url: `${LOCAL}/mp`, resourceType: 'websocket' })).toBe('close-ws');
    expect(lib.classify({ url: `${LOCAL}/mp`, isWebSocket: true })).toBe('close-ws');
  });

  test('the method defaults to GET and is case-insensitive', () => {
    expect(lib.classify({ url: `${LOCAL}/` })).toBe('allow');
    expect(lib.classify({ url: `${LOCAL}/`, method: 'get' })).toBe('allow');
  });

  test('the selftest URL is a blocked host, so its faked response is a leak', () => {
    expect(lib.isBlockedUrl(lib.SELFTEST_URL)).toBe(true);
    expect(lib.leakReason({ event: 'response', method: 'GET', url: lib.SELFTEST_URL })).toBe(
      'response from a blocked host',
    );
  });
});

describe('leakReason(): what fails a run closed', () => {
  test('a response from a blocked host leaks, whatever the method', () => {
    expect(lib.leakReason({ event: 'response', method: 'GET', url: SIGNUP })).toMatch(
      /blocked host/,
    );
    expect(
      lib.leakReason({ event: 'response', method: 'POST', url: EXCHANGE, aborted: true }),
    ).toMatch(/blocked host/);
  });

  test('a non-GET the harness did not abort leaks; an aborted one does not', () => {
    expect(lib.leakReason({ event: 'response', method: 'POST', url: `${LOCAL}/api/x` })).toMatch(
      /non-GET/,
    );
    expect(
      lib.leakReason({ event: 'response', method: 'POST', url: `${LOCAL}/api/x`, aborted: true }),
    ).toBeNull();
  });

  test('a failed non-GET leaks unless the client blocked it', () => {
    const base = { event: 'requestfailed', method: 'POST', url: `${LOCAL}/api/x` };
    expect(lib.leakReason({ ...base, errorText: 'net::ERR_CONNECTION_RESET' })).toMatch(/non-GET/);
    expect(lib.leakReason({ ...base, errorText: 'net::ERR_BLOCKED_BY_CLIENT' })).toBeNull();
    expect(lib.leakReason({ ...base, errorText: 'net::ERR_ABORTED' })).toBeNull();
    expect(
      lib.leakReason({ ...base, aborted: true, errorText: 'net::ERR_CONNECTION_RESET' }),
    ).toBeNull();
  });

  test("the build's own GETs never leak", () => {
    expect(
      lib.leakReason({ event: 'response', method: 'GET', url: `${LOCAL}/assets/x.js` }),
    ).toBeNull();
    expect(lib.leakReason({ event: 'requestfailed', method: 'GET', url: `${LOCAL}/x` })).toBeNull();
  });
});

describe('the boot proof: a run counts only when the net was live', () => {
  test('the anonymous sign-up and the App Check exchange each prove it', () => {
    expect(lib.bootProof('POST identitytoolkit.googleapis.com/v1/accounts:signUp')).toBe('signUp');
    expect(
      lib.bootProof(
        'POST content-firebaseappcheck.googleapis.com/v1/projects/p/apps/a:exchangeRecaptchaEnterpriseToken',
      ),
    ).toBe('appCheck');
    expect(lib.bootProof('GET identitytoolkit.googleapis.com/v1/accounts:signUp')).toBeNull();
    expect(lib.bootProof('GET 127.0.0.1/_vercel/insights/script.js')).toBeNull();
  });

  const session = (o: Partial<Session['net']>): Session => ({
    net: {
      leaks: [],
      intercepted: [],
      signUpSeen: false,
      appCheckSeen: false,
      bootProofSeen: false,
      offHost: new Set(),
      ...o,
    },
  });

  test('either proof makes the run count (production gates the sign-up behind App Check)', () => {
    const signUp = lib.netSummary([session({ signUpSeen: true, bootProofSeen: true })]);
    const appCheck = lib.netSummary([session({ appCheckSeen: true, bootProofSeen: true })]);
    const neither = lib.netSummary([session({})]);
    expect(signUp.bootProofIntercepted).toBe(true);
    expect(appCheck.bootProofIntercepted).toBe(true);
    expect(appCheck.signUpIntercepted).toBe(false);
    expect(neither.bootProofIntercepted).toBe(false);
    const pass = [{ name: 'x', pass: true }];
    expect(lib.verdict(pass, signUp).code).toBe(0);
    expect(lib.verdict(pass, appCheck).code).toBe(0);
    expect(lib.verdict(pass, neither).code).toBe(3);
  });
});

describe('exit codes: 0 pass, 1 fail, 2 leak, 3 inconclusive', () => {
  const ok = {
    leaks: [],
    signUpIntercepted: true,
    appCheckIntercepted: false,
    bootProofIntercepted: true,
    intercepted: [],
  };

  test('the codes themselves', () => {
    expect(lib.EXIT).toEqual({ pass: 0, fail: 1, failClosed: 2, inconclusive: 3 });
  });

  test('pass, fail and inconclusive come from the checks', () => {
    expect(lib.verdict([{ name: 'a', pass: true }], ok)).toMatchObject({
      code: 0,
      verdict: 'pass',
    });
    expect(
      lib.verdict(
        [
          { name: 'a', pass: false },
          { name: 'b', pass: null },
        ],
        ok,
      ),
    ).toMatchObject({
      code: 1,
      verdict: 'fail',
    });
    expect(
      lib.verdict(
        [
          { name: 'a', pass: true },
          { name: 'b', pass: null },
        ],
        ok,
      ),
    ).toMatchObject({
      code: 3,
      verdict: 'inconclusive',
    });
  });

  test('a leak beats everything, a failed check included', () => {
    const leaked = {
      ...ok,
      leaks: ['response from a blocked host: GET https://x.firebaseio.com/'],
    };
    expect(lib.verdict([{ name: 'a', pass: false }], leaked)).toMatchObject({
      code: 2,
      verdict: 'fail-closed',
    });
  });

  test('a run without a boot proof is inconclusive, not a pass; static probes need none', () => {
    const blind = { ...ok, signUpIntercepted: false, bootProofIntercepted: false };
    expect(lib.verdict([{ name: 'a', pass: true }], blind).code).toBe(3);
    expect(lib.verdict([{ name: 'a', pass: true }], null, { requireSignUp: false }).code).toBe(0);
  });
});
