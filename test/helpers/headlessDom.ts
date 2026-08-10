// Lets `new Island(r)` run under vitest.
//
// Island.createIsland() builds real CanvasTextures (TextureGenerator facades,
// the construction-block signage), so it needs document.createElement('canvas')
// AND a 2D context. happy-dom supplies the element but returns null from
// getContext — it has no raster backend. Nothing here renders anything: the
// textures are never sampled in a test, we only need the calls to succeed so
// the geometry/placement work either side of them can run.
//
// This is what makes radius invariants testable against a REAL island instead
// of against a restatement of the formula. See test/islandRadius.test.ts.

interface StubImageData {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

function imageData(w: number, h: number): StubImageData {
  const width = Math.max(1, Math.floor(w) || 1);
  const height = Math.max(1, Math.floor(h) || 1);
  return { data: new Uint8ClampedArray(width * height * 4), width, height };
}

/**
 * Install a no-op 2D canvas context on HTMLCanvasElement.
 *
 * Named methods return the shape their callers destructure; everything else
 * resolves to a no-op through the Proxy, so this does not need updating when
 * new drawing calls are added — only when a caller reads a RESULT we don't
 * model (as `measureText().width` did).
 */
export function installHeadlessCanvas(): void {
  const g = globalThis as unknown as {
    HTMLCanvasElement?: { prototype: Record<string, unknown> };
  };
  if (!g.HTMLCanvasElement) {
    throw new Error(
      'installHeadlessCanvas() needs a DOM. Add `// @vitest-environment happy-dom` to the test file.',
    );
  }
  g.HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement): unknown {
    const known: Record<string, unknown> = {
      canvas: this,
      createImageData: (w: number, h: number) => imageData(w, h),
      getImageData: (_x: number, _y: number, w: number, h: number) => imageData(w, h),
      putImageData: () => {},
      createRadialGradient: () => ({ addColorStop: () => {} }),
      createLinearGradient: () => ({ addColorStop: () => {} }),
      // Callers size text against this; a real-ish width keeps shrink loops finite.
      measureText: (s: string) => ({ width: String(s ?? '').length * 8 }),
    };
    return new Proxy(known, {
      get: (t, p) => (p in t ? t[p as string] : () => {}),
      set: (t, p, v) => {
        t[p as string] = v;
        return true;
      },
    });
  };
}
