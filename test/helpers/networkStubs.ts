// Network stubs for every test file (vitest.config.ts › setupFiles).
//
// Building an Island reaches for the network twice: Island.tryLoadModels
// fetches assets/models/overrides.json, then asks GLTFLoader for each authored
// model and its asset-kit fallbacks. Under happy-dom those requests went to
// http://localhost:3000, nothing listens there, and every test that built an
// island printed connection-refused and abort traces into the run.
//
// - fetch serves the real public/assets/models/overrides.json from disk and
//   rejects every other URL the way an offline browser would, so no test can
//   reach the real network.
// - GLTFLoader.prototype.load always FAILS: onError, never onLoad, a microtask
//   later, with the same loading-manager bookkeeping as the real loader. That
//   is the path the suite always took (the loads were refused), so the
//   procedural stand-ins stay and the seeded world is exactly what
//   tierParity's golden census pins. A stub that "succeeded" would add model
//   clones and could move the world. loadAsync goes through load, so
//   utils/GLTFModelLoader.ts is covered too.
//
// A test that needs different behaviour can still vi.stubGlobal('fetch', ...)
// or spy on GLTFLoader.prototype.load; both override these defaults.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

const OVERRIDES_PATH = 'assets/models/overrides.json';
// The repo root, as the other tests resolve it. (Resolving the file from
// import.meta.url fails under happy-dom: "The URL must be of scheme file".)
const OVERRIDES_FILE = join(process.cwd(), 'public', OVERRIDES_PATH);

/** The request's path with no origin, query or hash, and no leading './' or '/'. */
function requestPath(input: string | URL | Request): string {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  let path = raw;
  try {
    path = new URL(raw, 'http://localhost/').pathname;
  } catch {
    /* not a URL at all: match it as written */
  }
  return decodeURIComponent(path).replace(/^\.?\/+/, '');
}

globalThis.fetch = async (input: string | URL | Request): Promise<Response> => {
  const path = requestPath(input);
  if (path === OVERRIDES_PATH) {
    return new Response(readFileSync(OVERRIDES_FILE, 'utf8'), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  throw new TypeError(`network is off in tests (test/helpers/networkStubs.ts): ${path}`);
};

const failLoad: GLTFLoader['load'] = function (
  this: GLTFLoader,
  url,
  _onLoad,
  _onProgress,
  onError,
) {
  this.manager.itemStart(url);
  queueMicrotask(() => {
    const err = new Error(`model loading is off in tests (test/helpers/networkStubs.ts): ${url}`);
    // Same as the real loader: with no onError it logs instead.
    if (onError) onError(err);
    else console.error(err);
    this.manager.itemError(url);
    this.manager.itemEnd(url);
  });
};
GLTFLoader.prototype.load = failLoad;
