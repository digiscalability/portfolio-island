// The probe harness's safety net (tools/ux-probes/lib.cjs), item CO-E1. Every
// probe and the perf gate run the production build through this one rule, so
// the table below is what keeps a probe off the real backend: a non-GET never
// leaves, a backend host is blocked even for a GET, every WebSocket closes, and
// a response that gets past anyway fails the run closed (exit 2).
import { createRequire } from 'node:module';
import vm from 'node:vm';
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
  RECAPTCHA_STUB: string;
  baseInitScripts: (o?: { noKhr?: boolean; clock?: boolean; recaptchaStub?: boolean }) => string[];
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

// Production builds carry App Check: Auth's signUp waits for its token, the
// token for the exchange, the exchange for reCAPTCHA, whose script the harness
// blocks (and firebase/app-check 0.12 loads it with no onerror). The stub
// answers in the page, so the exchange and then the signUp are sent, and both
// are intercepted and aborted (their rows in the table above).
describe('the reCAPTCHA stub: a production run reaches its boot proof', () => {
  type Grecaptcha = {
    ready: (cb: () => void) => void;
    render: (container: string, params: Record<string, unknown>) => number;
    execute: (widget?: number, o?: { action: string }) => Promise<string>;
  };
  type Win = { grecaptcha?: Grecaptcha & { enterprise: Grecaptcha }; __recaptchaStub?: unknown };

  /** Run the stub in a bare global; anything it reaches for on the network is logged. */
  const runStub = (topFrame = true) => {
    const reached: string[] = [];
    const g: Record<string, unknown> = { setTimeout, Promise };
    g.window = g;
    g.top = topFrame ? g : {};
    g.fetch = () => {
      reached.push('fetch');
      return Promise.reject(new Error('no network'));
    };
    g.XMLHttpRequest = function () {
      reached.push('XMLHttpRequest');
    };
    g.document = new Proxy(
      {},
      { get: (_, k) => reached.push(`document.${String(k)}`) && undefined },
    );
    vm.createContext(g);
    vm.runInContext(lib.RECAPTCHA_STUB, g);
    return { win: g as Win, reached };
  };

  test('every session gets it before any page script; recaptchaStub: false leaves it out', () => {
    expect(lib.baseInitScripts({})).toContain(lib.RECAPTCHA_STUB);
    expect(lib.baseInitScripts({ noKhr: true, clock: true })).toContain(lib.RECAPTCHA_STUB);
    expect(lib.baseInitScripts({ recaptchaStub: false })).not.toContain(lib.RECAPTCHA_STUB);
  });

  test("it answers firebase/app-check's ReCaptchaEnterpriseProvider the way reCAPTCHA does", async () => {
    const { win, reached } = runStub();
    const ent = win.grecaptcha?.enterprise;
    expect(ent).toBeDefined();
    if (!ent) return;
    // initializeEnterprise finds grecaptcha.enterprise, so no script is loaded;
    // queueWidgetRender: ready() -> renderInvisibleWidget -> render(div, params).
    const state: { succeeded?: boolean; widgetId?: number } = {};
    await new Promise<void>((done) =>
      ent.ready(() => {
        state.widgetId = ent.render('fire_app_check_[DEFAULT]', {
          sitekey: 'site-key',
          size: 'invisible',
          callback: () => (state.succeeded = true),
          'error-callback': () => (state.succeeded = false),
        });
        done();
      }),
    );
    // getToken$1: ready() -> execute(widgetId, {action}); the provider then
    // requires the success callback to have run before it sends the exchange.
    const token = await new Promise<string>((done) =>
      ent.ready(() => done(ent.execute(state.widgetId, { action: 'fire_app_check' }))),
    );
    expect(typeof token).toBe('string');
    expect(token.length).toBeGreaterThan(0);
    expect(state.succeeded).toBe(true);
    // (Compared as JSON: the stub's object comes from the vm's own realm.)
    expect(JSON.parse(JSON.stringify(win.__recaptchaStub))).toEqual({ rendered: 1, executed: 1 });
    // The v3 provider reads grecaptcha itself: the same API is there.
    expect(typeof win.grecaptcha?.execute).toBe('function');
    expect(reached).toEqual([]);
  });

  test('it stays out of frames', () => {
    const { win, reached } = runStub(false);
    expect(win.grecaptcha).toBeUndefined();
    expect(reached).toEqual([]);
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

// Wave-2 amendments: what every probe run takes from the harness whether or
// not its author remembers to ask. Speech ignores --mute-audio, and the world
// clock follows the machine's local time.
describe('probe conventions: silent speech and a pinned clock (wave-2 amendments)', () => {
  const req = createRequire(import.meta.url);
  const fs = req('node:fs') as typeof import('node:fs');
  const path = req('node:path') as typeof import('node:path');
  const conv = req('../tools/ux-probes/lib.cjs') as {
    SILENT_TTS: string;
    DEFAULT_HOUR: number;
    bootQuery: (profileQuery?: string, query?: string, hour?: unknown) => string;
    baseInitScripts: (o?: {
      noKhr?: boolean;
      clock?: boolean;
      recaptchaStub?: boolean;
    }) => string[];
  };

  test('every session gets SILENT_TTS, whatever its options', () => {
    for (const o of [{}, { noKhr: true }, { clock: true }, { recaptchaStub: false }])
      expect(conv.baseInitScripts(o)).toContain(conv.SILENT_TTS);
  });

  test('SILENT_TTS speaks at volume 0 and keeps the utterance', () => {
    const spoken: Array<{ volume: number; text: string }> = [];
    const proto = {
      speak(u: { volume: number; text: string }) {
        spoken.push({ volume: u.volume, text: u.text });
      },
    };
    const g: Record<string, unknown> = { speechSynthesis: Object.create(proto) };
    g.window = g;
    vm.createContext(g);
    vm.runInContext(conv.SILENT_TTS, g);
    (g.speechSynthesis as typeof proto).speak({ volume: 1, text: 'G’day' });
    expect(spoken).toEqual([{ volume: 0, text: 'G’day' }]);
    expect(g.__ttsSpoken).toBe(1);
    // A browser without speech is left alone.
    const bare: Record<string, unknown> = {};
    bare.window = bare;
    vm.createContext(bare);
    expect(() => vm.runInContext(conv.SILENT_TTS, bare)).not.toThrow();
  });

  test('only the harness launches a browser or opens a context', () => {
    // An ad hoc script that made its own context would skip the init scripts
    // (SILENT_TTS, the WebSocket stub) and the routes. Every script under
    // tools/ and evals/ goes through lib.launch() and lib.openSession().
    const root = path.resolve(__dirname, '..');
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name === '.venv' || e.name === 'generated') continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(cjs|mjs|js)$/.test(e.name)) files.push(p);
      }
    };
    walk(path.join(root, 'tools'));
    walk(path.join(root, 'evals'));
    expect(files.length).toBeGreaterThan(20);
    const own = path.join(root, 'tools', 'ux-probes', 'lib.cjs');
    const offenders = files
      .filter((f) => f !== own)
      .filter((f) =>
        /\.newContext\(|\.launch(PersistentContext)?\(\s*\{|require\(['"]playwright(-core)?['"]\)/.test(
          fs.readFileSync(f, 'utf8'),
        ),
      )
      .map((f) => path.relative(root, f));
    expect(offenders).toEqual([]);
    const lib = fs.readFileSync(own, 'utf8');
    expect(lib).toMatch(
      /for \(const s of baseInitScripts\([^)]*\)\) await ctx\.addInitScript\(s\)/,
    );
  });

  test('a boot is pinned to noon unless the probe, --hour or --hour live says otherwise', () => {
    expect(conv.DEFAULT_HOUR).toBe(12);
    expect(conv.bootQuery()).toBe('?owner=1&hour=12');
    expect(conv.bootQuery('&touch=1', 'zone=hire')).toBe('?owner=1&touch=1&zone=hire&hour=12');
    // The probe's own hour wins over --hour; --hour moves the rest.
    expect(conv.bootQuery('', 'hour=21', 6)).toBe('?owner=1&hour=21');
    expect(conv.bootQuery('', '?perf=1', '23')).toBe('?owner=1&perf=1&hour=23');
    expect(conv.bootQuery('', '', 10.5)).toBe('?owner=1&hour=10.5');
    // The live clock only when asked for.
    expect(conv.bootQuery('', '', 'live')).toBe('?owner=1');
    for (const bad of ['noon', 24, -1]) expect(() => conv.bootQuery('', '', bad)).toThrow(/--hour/);
  });

  test('the runner hands --hour to every boot', () => {
    const run = fs.readFileSync(path.resolve(__dirname, '../tools/ux-probes/run.cjs'), 'utf8');
    expect(run).toMatch(
      /lib\.boot\(s, opts\.base \|\| t\.base, \{ hour: args\.hour, \.\.\.opts \}\)/,
    );
  });
});

// The probe fixes the wave-1 fix pass and re-verify asked for.
describe('probe fixes from wave 1 (wave-2 amendments)', () => {
  const req = createRequire(import.meta.url);
  const fs = req('node:fs') as typeof import('node:fs');
  const path = req('node:path') as typeof import('node:path');
  const src = (rel: string) =>
    fs.readFileSync(path.resolve(__dirname, '../tools/ux-probes', rel), 'utf8');

  test("p2/party counts an entry's programs from the door, and reports the walk apart", () => {
    const { entryPrograms } = req('../tools/ux-probes/p2/party.cjs') as {
      entryPrograms: (
        row: Record<string, unknown>,
        p0: number,
        p1: number,
        ret?: { p0?: number } | null,
      ) => Record<string, unknown>;
    };
    // The walk across the islet links one shadow-depth program before E.
    expect(entryPrograms({ name: 'enter-beach' }, 160, 162, { p0: 161 })).toEqual({
      name: 'enter-beach',
      programsAdded: 1,
      programsBeforeDoor: 1,
      programsFromStepStart: 2,
      countedFrom: 'the door (E)',
    });
    // A step that is not an entry (the party toggle) counts as before.
    expect(entryPrograms({ name: 'party-off' }, 162, 162, 'Party over')).toEqual({
      name: 'party-off',
      programsAdded: 0,
    });
    expect(entryPrograms({ name: 'exit' }, 162, 163, undefined).programsAdded).toBe(1);
  });

  test('axe scans the 20 surfaces of the wave-1 verify on each device', () => {
    const { AXE_SURFACES } = req('../tools/ux-probes/a11y.cjs') as { AXE_SURFACES: string[] };
    expect(AXE_SURFACES).toHaveLength(20);
    expect(new Set(AXE_SURFACES).size).toBe(20);
    for (const s of [
      'hud',
      'menu',
      'hire',
      'zone-contact',
      'passport',
      'island-map',
      'say-hi',
      'npc-chat',
      'name-prompt',
    ])
      expect(AXE_SURFACES).toContain(s);
  });

  test("guide: the card's overlap check sees the toast, the flash, the compass pill and the minimap", () => {
    const g = src('guide.cjs');
    const geometry = g.slice(g.indexOf('const GEOMETRY = '), g.indexOf('const GUIDE_ANIMATIONS'));
    for (const name of [
      "inter('minimap'",
      "inter('compass pill'",
      "inter('toast'",
      "inter('flash'",
      "inter('joystick'",
      "inter('prompt'",
    ])
      expect(geometry).toContain(name);
    // The trail is measured to its villager's seat, the legacy step is read
    // after the controls card, and one session runs at night.
    expect(g).toMatch(/tg\.position\.distanceTo\(last\)/);
    expect(g).toMatch(/waitFor\(page, onStep, 20000\)/);
    expect(g).toMatch(/query: `hour=\$\{hour\}`/);
  });

  test("fm compares a prompt beside a toast with its own width; census reports B's scene props apart", () => {
    const fm = src('fm.cjs');
    expect(fm).toContain('promptAloneW');
    expect(fm).not.toMatch(/promptW < 300/);
    const census = src('census.cjs');
    expect(census).toMatch(/return 'scene props';/);
    expect(census).toMatch(/const SCENE_PROPS_JUDGED = false;/);
    expect(census).toMatch(
      /const IN_SCOPE = \['zone halls', 'trees', 'villagers', 'props', 'terrain'\];/,
    );
  });
});
