// @vitest-environment happy-dom
//
// Claim locks for the public surfaces: everything a link scraper, a recruiter
// or a visitor without WebGL reads before the 3D app runs (the HTML head and
// boot fallback, the JS-free hire page, llms.txt, the privacy page and the
// /z/<zone> share route). Copy on these surfaces comes from the 2026-11-02
// fact sheet. These tests fail the build if a false or private claim comes
// back, if a share card outgrows its preview, or if a share link loses its
// route, image or attribution.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';

import zoneRoute from '../api/z.js';
import { buildShareUrl, share, tagShareUrl } from '../Share';

// process.cwd(), not import.meta.url: happy-dom rewrites the latter to the
// page URL (same resolution as radiusUnits.test.ts and reducedMotion.test.ts).
const src = (f: string): string => readFileSync(join(process.cwd(), f), 'utf8');

const SURFACES = [
  'index.html',
  'public/llms.txt',
  'public/hire.html',
  'public/privacy.html',
  'public/404.html',
  'public/manifest.webmanifest',
  'api/z.js',
];

// Each was on a public surface and is false or retired, or is a link the fact
// sheet rules out (the old personal GitHub account and the RankPilot mirror).
const BANNED = [
  'in daily use',
  'nearly done',
  'Day job in tech',
  'grandmother',
  'in/digiscalability',
  'venture studio',
  '18 conversational',
  'Rizz-Vii',
  'github.com/digiscalability/rankpilot',
];

// Private details are guarded by SHAPE, never by value: this repo is public,
// so a guard that spelled out the address or number it keeps out would publish
// it. In order: a street address (a number, one or two capitalised words and a
// street type), an Australian mobile number in local or international form, and
// any other +61 number. No /g flag, so test() keeps no state between calls.
const PRIVATE_SHAPES: RegExp[] = [
  /\b\d{1,5}[A-Za-z]?\s+(?:[A-Z][A-Za-z'-]+\s+){1,2}(?:Street|St|Road|Rd|Avenue|Ave|Parade|Pde|Drive|Dr|Court|Ct|Lane|Ln|Highway|Hwy|Boulevard|Blvd|Crescent|Cres|Place|Terrace|Tce)\b/,
  /(?:\+61\s?|\b0)4\d{2}[\s-]?\d{3}[\s-]?\d{3}\b/,
  /\+61[\s-]?\(?\d/,
];

/** The shapes a text matches. Reports the pattern, never the matched value. */
const privateShapesIn = (text: string): string[] =>
  PRIVATE_SHAPES.filter((re) => re.test(text)).map(String);

const decode = (s: string): string =>
  s
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

/** <title> plus every title/description meta, entity-decoded. */
function headCopy(html: string): { title: string; metas: Array<[string, string]> } {
  const title = decode((html.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? '').trim());
  const metas = [...html.matchAll(/<meta\s+(?:name|property)="([^"]+)"\s+content="([^"]*)"/g)]
    .filter((m) => /(^|:)(title|description)$/.test(m[1]))
    .map((m): [string, string] => [m[1], decode(m[2])]);
  return { title, metas };
}

type RouteResult = { status: number; headers: Record<string, string>; body: string };

/** Call the Vercel handler with a fake req/res, the way the /z rewrite does. */
function route(query: Record<string, string | string[]>): RouteResult {
  const out: RouteResult = { status: 0, headers: {}, body: '' };
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
  };
  zoneRoute({ query }, res);
  return out;
}

const ZONES = ['welcome', 'hire', 'professional', 'projects', 'personal', 'contact'];

/** The three places a human gets bounced from: meta refresh, script, link. */
function destinations(body: string): string[] {
  return [
    decode(body.match(/http-equiv="refresh" content="0;url=([^"]*)"/)?.[1] ?? ''),
    JSON.parse(body.match(/location\.replace\(("[^"]*")\)/)?.[1] ?? '""') as string,
    decode(body.match(/<a href="([^"]*)">/)?.[1] ?? ''),
  ];
}

describe('no false claim or ruled-out link reaches a public surface', () => {
  test.each(SURFACES)('%s carries none of the banned phrases', (file) => {
    const text = src(file).toLowerCase();
    for (const phrase of BANNED) {
      expect(text, `"${phrase}" in ${file}`).not.toContain(phrase.toLowerCase());
    }
  });

  test('the share route never renders one either, for any zone', () => {
    for (const zone of [...ZONES, 'nope']) {
      const body = route({ zone }).body.toLowerCase();
      for (const phrase of BANNED) expect(body).not.toContain(phrase.toLowerCase());
    }
  });

  test('"open source" waits for a licence', () => {
    // Without a LICENSE file the code would be all rights reserved by default,
    // so "open source" would be false. The LICENSE is MIT, which is what lets
    // these surfaces, the app's panels and the villagers' fact sheet say "open
    // source (MIT)": remove or change it and this fails until they change too.
    if (existsSync(join(process.cwd(), 'LICENSE'))) {
      expect(src('LICENSE')).toMatch(/^MIT License\r?\n/);
      return;
    }
    for (const file of SURFACES) expect(src(file), file).not.toMatch(/open[- ]source/i);
    for (const zone of [...ZONES, 'nope']) {
      expect(route({ zone }).body, `/z/${zone}`).not.toMatch(/open[- ]source/i);
    }
  });
});

describe('the availability line stays on the hire surfaces', () => {
  // Abbas allows "Open to AI and software engineering roles in Melbourne
  // (full-time or contract)." only on digiscalability.com/about, the in-app
  // hire card and recruiter panel, and hire.html. index.html's boot-fallback
  // card is crawled as home-page text, so the line stays off it, and off the
  // other public files and share cards here. Whitespace-tolerant, so a
  // re-wrapped line is still caught.
  const LINE = 'Open to AI and software engineering roles in Melbourne (full-time or contract).';
  const OPENER = /Open\s+to\s+AI\s+and\s+software\s+engineering\s+roles/i;
  const flat = (s: string): string => s.replace(/\s+/g, ' ');

  test('hire.html carries it', () => {
    expect(flat(src('public/hire.html'))).toContain(LINE);
  });

  test.each(SURFACES.filter((f) => f !== 'public/hire.html'))('%s does not', (file) => {
    expect(src(file), file).not.toMatch(OPENER);
  });

  test('no share card carries it either', () => {
    for (const zone of [...ZONES, 'nope']) {
      expect(route({ zone }).body, `/z/${zone}`).not.toMatch(OPENER);
    }
  });
});

describe('the boot guard stands down once the app has put the card up', () => {
  // main-simple's showErrorScreen sets window.__lifeIslandBootFailed, shows
  // #boot-fallback itself and reports init_failed. The inline guard must then
  // leave the card alone: its 60 s watchdog used to rewrite the reason the
  // visitor was reading and send a second boot_fallback event.
  type BootWindow = Window & { __lifeIslandBootFailed?: boolean; va?: unknown; vaq?: unknown[] };
  const html = src('index.html');
  const guard = /<script>\s*([\s\S]*?)<\/script>/.exec(html)?.[1] ?? '';
  const body = html
    .slice(html.indexOf('<body>') + '<body>'.length, html.indexOf('</body>'))
    .replace(/<script[\s\S]*?<\/script>/g, '');

  /** Run the page's inline guard. happy-dom has no WebGL 2, so it calls showFallback() at once. */
  const runGuard = (afterShowErrorScreen: boolean) => {
    document.body.innerHTML = body;
    const w = window as BootWindow;
    delete w.va;
    delete w.vaq;
    delete w.__lifeIslandBootFailed;
    if (afterShowErrorScreen) {
      w.__lifeIslandBootFailed = true;
      document.getElementById('bf-reason')!.textContent = 'but something went wrong loading it.';
      document.getElementById('boot-fallback')!.hidden = false;
    }
    // The page's own inline script from this repo's index.html, run against
    // the test DOM the way the browser runs it before the module loads.
    new Function(guard)();
    return {
      reason: document.getElementById('bf-reason')?.textContent,
      shown: document.getElementById('boot-fallback')?.hidden === false,
      events: (w.vaq ?? []).length,
    };
  };

  afterEach(() => {
    const w = window as BootWindow;
    delete w.__lifeIslandBootFailed;
    delete w.va;
    delete w.vaq;
    document.body.innerHTML = '';
  });

  test('the first plain script on the page is the guard', () => {
    expect(guard).toContain('function showFallback(reason)');
    expect(guard).toContain('if (shown || booted() || window.__lifeIslandBootFailed) return;');
  });

  test('on its own, it shows the card with its reason and reports it once', () => {
    expect(runGuard(false)).toEqual({
      reason: "but this browser can't run WebGL 2, which the island needs.",
      shown: true,
      events: 1,
    });
  });

  test('after showErrorScreen, it neither rewrites the reason nor reports again', () => {
    expect(runGuard(true)).toEqual({
      reason: 'but something went wrong loading it.',
      shown: true,
      events: 0,
    });
  });
});

describe('no street address or phone number reaches a public surface', () => {
  // This file is scanned too, so no one can write a guard by pasting the value.
  test.each([...SURFACES, 'test/claimsSurfaces.test.ts'])('%s carries none', (file) => {
    expect(privateShapesIn(src(file)), file).toEqual([]);
  });

  test('the share route renders none, for any zone', () => {
    for (const zone of [...ZONES, 'nope']) {
      expect(privateShapesIn(route({ zone }).body), `/z/${zone}`).toEqual([]);
    }
  });

  test('each shape catches what it guards', () => {
    // Fictional controls, built at run time so this file never matches its own
    // guard: ACMA reserves this mobile number for drama and fiction, and the
    // street is a placeholder.
    const mobile = ['0491', '570', '006'];
    const controls = [
      ['1', 'Example', 'Street'].join(' '),
      mobile.join(' '),
      mobile.join(''),
      ['+61', mobile.join(' ').slice(1)].join(' '),
    ];
    for (const c of controls) expect(privateShapesIn(c).length, `control ${c}`).toBeGreaterThan(0);
    for (const re of PRIVATE_SHAPES) {
      const caught = controls.filter((c) => re.test(c));
      expect(caught.length, String(re)).toBeGreaterThan(0);
    }
  });
});

describe('share cards fit their previews', () => {
  test.each(['index.html', 'public/hire.html', 'public/privacy.html', 'public/404.html'])(
    '%s: title at most 60 characters, descriptions at most 155',
    (file) => {
      const { title, metas } = headCopy(src(file));
      expect(title.length).toBeGreaterThan(0);
      expect(title.length, title).toBeLessThanOrEqual(60);
      for (const [key, value] of metas) {
        const max = key.endsWith('title') ? 60 : 155;
        expect(value.length, `${key}: ${value}`).toBeLessThanOrEqual(max);
      }
    },
  );

  test('index.html names Abbas and his role, and uses the v3 card', () => {
    const html = src('index.html');
    const { title, metas } = headCopy(html);
    expect(title).toContain('Abbas Ali');
    expect(title).toContain('AI & software engineer');
    expect(metas.map(([k]) => k)).toEqual(
      expect.arrayContaining(['description', 'og:title', 'og:description', 'twitter:title']),
    );
    expect(html).toContain('https://island.digiscalability.com/og-cover-v3.jpg');
    expect(html).not.toContain('og-cover-v2.jpg');
  });

  test('index.html still covers the boot window for reduced motion', () => {
    expect(src('index.html')).toContain('prefers-reduced-motion');
  });

  test('the manifest screenshot is the v3 card', () => {
    const manifest = JSON.parse(src('public/manifest.webmanifest')) as {
      screenshots: Array<{ src: string; sizes: string }>;
    };
    expect(manifest.screenshots).toContainEqual(
      expect.objectContaining({ src: '/og-cover-v3.jpg', sizes: '1200x630' }),
    );
  });
});

describe('structured data names one Person, shared with the website', () => {
  // digiscalability.com/about publishes the same Person under this @id
  // (PERSON_ID in the website's src/lib/data.ts and src/lib/seo.ts), so search
  // engines read both sites as describing one entity, not two.
  const PERSON_ID = 'https://digiscalability.com/about#abbas';

  test.each(['index.html', 'public/hire.html'])('%s', (file) => {
    const html = src(file);
    const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
    expect(blocks).toHaveLength(1);
    const graph = (JSON.parse(blocks[0][1]) as { '@graph': Array<Record<string, unknown>> })[
      '@graph'
    ];
    const people = graph.filter((node) => node['@type'] === 'Person');
    expect(people.map((p) => p['@id'])).toEqual([PERSON_ID]);
    // Every reference into the website points at that one node.
    const refs = [...html.matchAll(/"@id":\s*"(https:\/\/digiscalability\.com\/[^"]*)"/g)];
    expect(new Set(refs.map((m) => m[1]))).toEqual(new Set([PERSON_ID]));
    expect(html).toContain(`"@id": "${PERSON_ID}"`);
  });
});

describe('public counts match the code', () => {
  // Hard-coded counts drift: the island once said 18 conversational villagers
  // while 24 talked. og-cover-v3.jpg bakes the talking count into the image,
  // so re-render it whenever that number changes.
  const chat = src('NpcChat.ts');
  const defsAt = chat.indexOf('const AI_NPC_DEFS');
  const talking = (chat.slice(defsAt, chat.indexOf('];', defsAt)).match(/\{ name: '/g) ?? [])
    .length;
  // Every villager stands on one NPC_SITES entry (Island.ts spawns one per site).
  const island = src('Island.ts');
  const sitesAt = island.indexOf('const NPC_SITES');
  const villagers = (
    island.slice(sitesAt, island.indexOf('];', sitesAt)).match(/^\s*\[[^\]\n]*\],/gm) ?? []
  ).length;
  // Every export of the functions entry point is a deployed function.
  const entry = src('functions/src/index.ts');
  const functions =
    [...entry.matchAll(/^export \{([^}]*)\}/gm)].reduce(
      (n, m) => n + m[1].split(',').filter((s) => s.trim()).length,
      0,
    ) + (entry.match(/^export const \w+ =/gm) ?? []).length;

  test('the code counts parse', () => {
    expect(defsAt).toBeGreaterThan(-1);
    expect(sitesAt).toBeGreaterThan(-1);
    expect(talking).toBeGreaterThan(0);
    expect(villagers).toBeGreaterThanOrEqual(talking);
    expect(functions).toBeGreaterThan(0);
  });

  test.each(SURFACES)('%s states them as the code has them', (file) => {
    const text = src(file);
    for (const m of text.matchAll(/(\d+)\s+villagers\s+talk/g)) {
      expect(Number(m[1]), `${file}: ${m[0]}`).toBe(talking);
    }
    for (const m of text.matchAll(/(\d+)\s+of\s+the\s+island's\s+(\d+)\s+villagers/g)) {
      expect([Number(m[1]), Number(m[2])], `${file}: ${m[0]}`).toEqual([talking, villagers]);
    }
    for (const m of text.matchAll(/(\d+)\s+(?:Firebase\s+)?Cloud\s+Functions/gi)) {
      expect(Number(m[1]), `${file}: ${m[0]}`).toBe(functions);
    }
  });

  test('llms.txt states all three', () => {
    const llms = src('public/llms.txt');
    expect(llms).toMatch(
      new RegExp(`\\b${talking}\\s+of\\s+the\\s+island's\\s+${villagers}\\s+villagers\\b`),
    );
    expect(llms).toMatch(new RegExp(`\\b${functions}\\s+Firebase\\s+Cloud\\s+Functions\\b`));
  });
});

describe('the /z/<zone> share route (api/z.js)', () => {
  test.each(ZONES)('/z/%s serves its own card and bounces to /?zone=', (zone) => {
    const r = route({ zone });
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('text/html; charset=utf-8');
    const { title, metas } = headCopy(r.body);
    expect(title.length, title).toBeLessThanOrEqual(60);
    for (const [key, value] of metas) {
      expect(value.length, `${zone} ${key}`).toBeLessThanOrEqual(key.endsWith('title') ? 60 : 155);
    }
    expect(r.body).toContain(
      '<meta property="og:image" content="https://island.digiscalability.com/og-cover-v3.jpg" />',
    );
    expect(r.body).toContain(
      '<meta name="twitter:image" content="https://island.digiscalability.com/og-cover-v3.jpg" />',
    );
    expect(r.body).not.toContain('og-cover-v2');
    expect(r.body).toContain(
      `<link rel="canonical" href="https://island.digiscalability.com/z/${zone}" />`,
    );
    expect(destinations(r.body)).toEqual(Array(3).fill(`/?zone=${zone}`));
  });

  test('/z/hire is the recruiter card: name, role, Melbourne', () => {
    const { title, metas } = headCopy(route({ zone: 'hire' }).body);
    expect(title).toBe('Abbas Ali — AI & software engineer, Melbourne');
    const desc = metas.find(([k]) => k === 'og:description')?.[1] ?? '';
    expect(desc).toMatch(/CV, experience and contact/);
  });

  test('an unknown or missing zone falls back to the welcome card', () => {
    expect(destinations(route({ zone: 'nope' }).body)[0]).toBe('/?zone=welcome');
    expect(destinations(route({}).body)[0]).toBe('/?zone=welcome');
  });

  test('zone names are case-insensitive, and a repeated key keeps its first value', () => {
    expect(destinations(route({ zone: 'HIRE' }).body)[0]).toBe('/?zone=hire');
    expect(destinations(route({ zone: ['hire', 'contact'] }).body)[0]).toBe('/?zone=hire');
  });

  test('utm_* tags and the view params ride through the bounce; nothing else does', () => {
    const r = route({
      zone: 'hire',
      utm_source: 'linkedin',
      utm_medium: 'social',
      utm_campaign: 'profile',
      hour: '17',
      fbclid: 'abc',
      pc: 'xyz',
    });
    for (const dest of destinations(r.body)) {
      const sp = new URLSearchParams(dest.slice(dest.indexOf('?')));
      expect(sp.get('zone')).toBe('hire');
      expect(sp.get('utm_source')).toBe('linkedin');
      expect(sp.get('utm_medium')).toBe('social');
      expect(sp.get('utm_campaign')).toBe('profile');
      expect(sp.get('hour')).toBe('17');
      expect(sp.has('fbclid')).toBe(false);
      expect(sp.has('pc')).toBe(false);
    }
  });

  test('a hostile utm value cannot break out of the page', () => {
    const body = route({ zone: 'hire', utm_source: '"></script><script>alert(1)</script>' }).body;
    expect(body).not.toContain('<script>alert(1)');
    expect(body.match(/<script>/g)).toHaveLength(1);
    expect(body).toContain('utm_source=%22%3E%3C%2Fscript%3E');
  });
});

describe('outgoing share links are tagged', () => {
  afterEach(() => {
    delete (navigator as { share?: unknown }).share;
  });

  test('tagShareUrl adds utm_source and utm_medium to island links', () => {
    const url = new URL(tagShareUrl(buildShareUrl({ zone: 'hire', hour: 17 })));
    expect(url.pathname).toBe('/z/hire');
    expect(url.searchParams.get('utm_source')).toBe('island');
    expect(url.searchParams.get('utm_medium')).toBe('share');
    expect(url.searchParams.get('hour')).toBe('17');
  });

  test('tags already on a link win, and other sites are left alone', () => {
    const own = `${location.origin}/?utm_source=linkedin`;
    expect(new URL(tagShareUrl(own)).searchParams.get('utm_source')).toBe('linkedin');
    expect(tagShareUrl('https://example.com/x')).toBe('https://example.com/x');
  });

  test('buildShareUrl itself stays untagged (it is also the canonical form)', () => {
    expect(buildShareUrl({ zone: 'hire' })).not.toContain('utm_');
  });

  test('share() hands the tagged link to the share sheet', async () => {
    const sheet = vi.fn(async (_data: ShareData) => undefined);
    Object.defineProperty(navigator, 'share', { value: sheet, configurable: true });
    const outcome = await share({ surface: 'zone_hire', url: buildShareUrl({ zone: 'hire' }) });
    expect(outcome).toBe('shared');
    const sent = new URL(String(sheet.mock.calls[0][0].url));
    expect(sent.pathname).toBe('/z/hire');
    expect(sent.searchParams.get('utm_source')).toBe('island');
    expect(sent.searchParams.get('utm_medium')).toBe('share');
  });
});

describe('vercel.json keeps the public routes', () => {
  const cfg = JSON.parse(src('vercel.json')) as {
    rewrites: Array<{ source: string; destination: string }>;
    redirects: Array<{ source: string; destination: string; permanent: boolean }>;
    headers: Array<{ source: string; headers: Array<{ key: string; value: string }> }>;
  };

  test('/z/:zone still rewrites to the share route', () => {
    expect(cfg.rewrites).toContainEqual({ source: '/z/:zone', destination: '/api/z?zone=:zone' });
  });

  test('/cv and /resume go to the web CV', () => {
    for (const source of ['/cv', '/resume']) {
      expect(cfg.redirects).toContainEqual({
        source,
        destination: 'https://digiscalability.com/about',
        permanent: false,
      });
    }
  });

  test('the launch clip keeps its CORS header', () => {
    expect(cfg.headers).toContainEqual({
      source: '/launch-clip.mp4',
      headers: [{ key: 'Access-Control-Allow-Origin', value: '*' }],
    });
  });
});
