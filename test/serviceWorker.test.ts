// Service worker and cache-header locks.
//
// public/sw.js used to be byte-identical on every deploy, so a returning
// visitor's browser never installed a new worker and the activate-time flush
// ran once, ever, while old builds' chunks piled up in the cache. Now the
// sw-build-stamp plugin (vite.config.ts) stamps a BUILD_ID and this build's
// hashed file list into dist/sw.js. These tests run the REAL plugin against a
// temp copy of sw.js, then run the stamped worker in a sandbox with a fake
// Cache Storage and network, to pin what a returning visitor gets: old caches
// deleted, this build's files and the models kept, hashed files cache-first,
// models network-first, and only the app shell cached for navigations.
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import type { Plugin } from 'vite';
import { afterAll, describe, expect, test } from 'vitest';

import viteConfig from '../vite.config';

const src = (f: string): string => readFileSync(join(process.cwd(), f), 'utf8');
const ORIGIN = 'https://island.digiscalability.com';
const tmp = mkdtempSync(join(tmpdir(), 'sw-stamp-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

type WriteBundle = (
  this: { error: (msg: string) => never },
  options: { dir: string },
  bundle: Record<string, unknown>,
) => void;

const stampPlugin = (viteConfig.plugins ?? [])
  .flat()
  .find(
    (p): p is Plugin => !!p && typeof p === 'object' && 'name' in p && p.name === 'sw-build-stamp',
  );

let runs = 0;
/** Run the real plugin's writeBundle on a fresh copy of public/sw.js. */
function stamp(bundleFiles: string[], swSource?: string): string {
  const dir = join(tmp, `build-${runs++}`);
  mkdirSync(dir, { recursive: true });
  if (swSource === undefined) copyFileSync(join(process.cwd(), 'public/sw.js'), join(dir, 'sw.js'));
  else writeFileSync(join(dir, 'sw.js'), swSource);
  const writeBundle = stampPlugin?.writeBundle as unknown as WriteBundle;
  const ctx = {
    error: (msg: string): never => {
      throw new Error(msg);
    },
  };
  writeBundle.call(ctx, { dir }, Object.fromEntries(bundleFiles.map((f) => [f, {}])));
  return readFileSync(join(dir, 'sw.js'), 'utf8');
}

const buildIdOf = (sw: string): string => sw.match(/const BUILD_ID = '([^']*)';/)?.[1] ?? '';

describe('sw-build-stamp (vite.config.ts)', () => {
  test('is registered, build-only', () => {
    expect(stampPlugin).toBeDefined();
    expect(stampPlugin?.apply).toBe('build');
  });

  test('two builds get different build ids, and the hashed files are listed', () => {
    const files = ['index.html', 'assets/main-AbCd1234.js', 'assets/main-EfGh5678.css'];
    const a = stamp(files);
    const b = stamp(files);
    expect(buildIdOf(a)).toMatch(/^\d{14}-[0-9a-f]{8}$/);
    expect(buildIdOf(b)).toMatch(/^\d{14}-[0-9a-f]{8}$/);
    expect(buildIdOf(a)).not.toBe(buildIdOf(b));
    expect(a).toContain(
      'const BUILD_ASSETS = ["/assets/main-AbCd1234.js","/assets/main-EfGh5678.css"];',
    );
    expect(a).not.toContain("'dev'");
  });

  test('fails the build instead of shipping an unstamped worker', () => {
    expect(() =>
      stamp(['assets/a-12345678.js'], 'self.addEventListener("fetch", () => {});'),
    ).toThrow(/placeholders not found/);
  });

  test('the unstamped source keeps the dev placeholders the plugin looks for', () => {
    const sw = src('public/sw.js');
    expect(sw).toContain("const BUILD_ID = 'dev';");
    expect(sw).toContain('const BUILD_ASSETS = [];');
    expect(sw).toContain('const CACHE = `island-${BUILD_ID}`;');
  });
});

// ---------------------------------------------------------------------------
// A sandboxed run of the stamped worker.

type Req = { url: string; method: string; mode: string };
const req = (path: string, mode = 'cors', method = 'GET'): Req => ({
  url: new URL(path, ORIGIN).href,
  method,
  mode,
});
const keyOf = (r: string | Req): string =>
  typeof r === 'string' ? new URL(r, ORIGIN).href : r.url;

class FakeCache {
  readonly store = new Map<string, Response>();
  async match(r: string | Req): Promise<Response | undefined> {
    return this.store.get(keyOf(r))?.clone();
  }
  async put(r: string | Req, res: Response): Promise<void> {
    this.store.set(keyOf(r), res);
  }
  async keys(): Promise<Req[]> {
    return [...this.store.keys()].map((url) => ({ url, method: 'GET', mode: 'cors' }));
  }
  async addAll(paths: string[]): Promise<void> {
    for (const p of paths) this.store.set(keyOf(p), await net.fetch(req(p)));
  }
  paths(): string[] {
    return [...this.store.keys()].map((u) => new URL(u).pathname).sort();
  }
}

class FakeCacheStorage {
  readonly map = new Map<string, FakeCache>();
  async open(name: string): Promise<FakeCache> {
    if (!this.map.has(name)) this.map.set(name, new FakeCache());
    return this.map.get(name)!;
  }
  async keys(): Promise<string[]> {
    return [...this.map.keys()];
  }
  async delete(name: string): Promise<boolean> {
    return this.map.delete(name);
  }
  async match(r: string | Req): Promise<Response | undefined> {
    for (const c of this.map.values()) {
      const hit = await c.match(r);
      if (hit) return hit;
    }
    return undefined;
  }
}

const net = {
  offline: false,
  status: 200,
  calls: [] as string[],
  async fetch(r: Req): Promise<Response> {
    const path = new URL(r.url).pathname;
    net.calls.push(path);
    if (net.offline) throw new TypeError('Failed to fetch');
    return new Response(`net:${path}`, { status: net.status });
  },
};

const cached = (path: string): Response => new Response(`cache:${path}`);

function boot(sw: string) {
  const listeners: Record<string, (e: unknown) => void> = {};
  const storage = new FakeCacheStorage();
  const state = { claimed: false };
  runInNewContext(sw, {
    self: {
      location: { origin: ORIGIN },
      addEventListener: (type: string, fn: (e: unknown) => void) => (listeners[type] = fn),
      skipWaiting: async () => undefined,
      clients: {
        claim: async () => {
          state.claimed = true;
        },
      },
    },
    caches: storage,
    fetch: (r: Req) => net.fetch(r),
    URL,
    Response,
  });
  async function fire(type: string, init: Record<string, unknown> = {}) {
    const pending: unknown[] = [];
    let response: Promise<Response> | undefined;
    listeners[type]({
      ...init,
      waitUntil: (p: unknown) => pending.push(p),
      respondWith: (p: Response | Promise<Response>) => (response = Promise.resolve(p)),
    });
    await Promise.all(pending);
    return response === undefined ? undefined : await response;
  }
  return { storage, state, fire };
}

const NEW = ['/assets/main-New00001.js', '/assets/three-New00002.js'];
const swNew = (): string => stamp(NEW.map((p) => p.slice(1)));

describe('the stamped worker', () => {
  test('activate deletes old caches but keeps this build’s files and the models', async () => {
    const sw = swNew();
    const cacheName = `island-${buildIdOf(sw)}`;
    const { storage, state, fire } = boot(sw);
    // The live (old) worker's cache, as a returning visitor has it: an old
    // build's chunk, the NEW build's chunk it fetched during this very visit,
    // a model and the shell. A second stray cache holds another new chunk.
    const old = await storage.open('island-v1');
    for (const p of [
      '/assets/main-Old00001.js',
      NEW[0],
      '/assets/models/player.glb',
      '/index.html',
    ]) {
      await old.put(p, cached(p));
    }
    await (await storage.open('island-20260101000000-deadbeef')).put(NEW[1], cached(NEW[1]));

    net.calls = [];
    await fire('install');
    await fire('activate');

    expect(await storage.keys()).toEqual([cacheName]);
    const cache = storage.map.get(cacheName)!;
    expect(cache.paths()).toEqual(
      [
        '/',
        '/index.html',
        '/manifest.webmanifest',
        '/favicon.svg',
        ...NEW,
        '/assets/models/player.glb',
      ].sort(),
    );
    expect(cache.paths()).not.toContain('/assets/main-Old00001.js');
    // Carried over, not refetched: the bodies are the cached ones.
    expect(await (await cache.match(NEW[0]))?.text()).toBe(`cache:${NEW[0]}`);
    expect(net.calls.filter((p) => p.startsWith('/assets/'))).toEqual([]);
    expect(state.claimed).toBe(true);
  });

  test('this build’s hashed files are cache-first', async () => {
    const { storage, fire } = boot(swNew());
    await fire('install');
    await fire('activate');
    const [cacheName] = await storage.keys();
    await storage.map.get(cacheName)!.put(NEW[0], cached(NEW[0]));

    net.offline = false;
    net.calls = [];
    expect(await (await fire('fetch', { request: req(NEW[0]) }))?.text()).toBe(`cache:${NEW[0]}`);
    expect(net.calls).toEqual([]);
    // A miss goes to the network once and is kept.
    expect(await (await fire('fetch', { request: req(NEW[1]) }))?.text()).toBe(`net:${NEW[1]}`);
    expect(storage.map.get(cacheName)!.paths()).toContain(NEW[1]);
  });

  test('models are network-first, with the cache as the offline fallback', async () => {
    const { storage, fire } = boot(swNew());
    await fire('install');
    await fire('activate');
    const [cacheName] = await storage.keys();
    const model = '/assets/models/npc.glb';
    await storage.map.get(cacheName)!.put(model, cached(model));

    net.offline = false;
    net.calls = [];
    expect(await (await fire('fetch', { request: req(model) }))?.text()).toBe(`net:${model}`);
    expect(net.calls).toEqual([model]);

    net.offline = true;
    try {
      // Offline: the copy the last online fetch refreshed in the cache.
      expect(await (await fire('fetch', { request: req(model) }))?.text()).toBe(`net:${model}`);
      const missing = await fire('fetch', { request: req('/assets/models/never-cached.glb') });
      expect(missing?.type).toBe('error');
    } finally {
      net.offline = false;
    }
  });

  test('only the app shell is cached for navigations', async () => {
    const { storage, fire } = boot(swNew());
    await fire('install');
    await fire('activate');
    const [cacheName] = await storage.keys();
    const shell = storage.map.get(cacheName)!;

    // Other pages are not intercepted at all.
    for (const p of ['/hire.html', '/privacy.html', '/z/hire', '/nope']) {
      expect(await fire('fetch', { request: req(p, 'navigate') })).toBeUndefined();
    }
    // A failed shell response never becomes the offline fallback.
    net.status = 404;
    try {
      await fire('fetch', { request: req('/', 'navigate') });
      await new Promise((r) => setTimeout(r, 0));
      expect(await (await shell.match('/index.html'))?.text()).toBe('net:/index.html');
    } finally {
      net.status = 200;
    }
    // A good one does, and serves the shell (with any ?zone=) when offline.
    await fire('fetch', { request: req('/?zone=hire', 'navigate') });
    await new Promise((r) => setTimeout(r, 0));
    expect(await (await shell.match('/index.html'))?.text()).toBe('net:/');
    net.offline = true;
    try {
      const res = await fire('fetch', { request: req('/?zone=hire', 'navigate') });
      expect(await res?.text()).toBe('net:/');
    } finally {
      net.offline = false;
    }
  });

  test('cross-origin, non-GET and non-asset requests pass straight through', async () => {
    const { fire } = boot(swNew());
    await fire('install');
    await fire('activate');
    const passthrough = [
      { url: 'https://example.firebaseio.com/x.json', method: 'GET', mode: 'cors' },
      req('/assets/main-New00001.js', 'cors', 'POST'),
      req('/api/z?zone=hire'),
      req('/og-cover-v3.jpg'),
    ];
    for (const request of passthrough) expect(await fire('fetch', { request })).toBeUndefined();
  });
});

describe('vercel.json cache headers', () => {
  const cfg = JSON.parse(src('vercel.json')) as {
    headers: Array<{ source: string; headers: Array<{ key: string; value: string }> }>;
  };

  test('only hashed /assets js and css are immutable', () => {
    const immutable = cfg.headers.filter((h) =>
      h.headers.some((x) => x.key === 'Cache-Control' && x.value.includes('immutable')),
    );
    expect(immutable).toHaveLength(1);
    expect(immutable[0].headers).toEqual([
      { key: 'Cache-Control', value: 'public, max-age=31536000, immutable' },
    ]);
    // Vercel compiles `source` with path-to-regexp; a pattern with no named
    // params compiles to itself, anchored.
    const re = new RegExp(`^${immutable[0].source}$`);
    for (const p of [
      '/assets/main-CarStdz8.js',
      '/assets/three-PPx_lrH1.js',
      '/assets/postprocessing-BAh-IGsY.js',
      '/assets/main-gHfasgVr.css',
    ]) {
      expect(re.test(p), p).toBe(true);
    }
    // Public files keep their names across deploys, so they must revalidate.
    for (const p of [
      '/assets/models/player.glb',
      '/assets/models/overrides.json',
      '/assets/panels/rankpilot.webp',
      '/assets/textures/Grass.png',
      '/assets/unhashed.js',
      '/sw.js',
      '/index.html',
    ]) {
      expect(re.test(p), p).toBe(false);
    }
  });
});
