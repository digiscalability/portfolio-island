// waveHeightAt ↔ sea-shader parity guard.
//
// The sea's wave displacement lives in TWO places that MUST stay identical:
// the GLSL injected via onBeforeCompile (what you SEE) and the CPU
// Island.waveHeightAt (what boats/swimmers RIDE). Both are sums of sine terms
// `sin(coord * freq ± t * speed) * amp`; if one side gains a term or a tuned
// constant the other misses, boats visibly float above/below the crests — a
// bug a build can't catch. This test extracts the constant tuples from both
// representations in Island.ts source text and pins them equal.
//
// (The overall amplitude is already drift-proof: both sides read the single
// Island.WAVE_AMP — the shader via the uAmp uniform.)

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const src = readFileSync(join(process.cwd(), 'Island.ts'), 'utf8');

interface WaveTerm {
  coord: string; // normalized coordinate expression, e.g. "x", "x+z", "x-z", "y"
  freq: string;
  timeSign: string; // '+' or '-'
  speed: string;
  amp: string;
}

/** Extract sine terms of shape sin(<coordExpr> * F ± T * S) * A for a given
 *  coordinate prefix ('nrm.' in GLSL, 'n.' on the CPU) and time symbol. */
function extractTerms(prefix: string, timeSym: string): WaveTerm[] {
  const P = prefix.replace('.', '\\.');
  const re = new RegExp(
    // sin( (?:\() p.x (?: [+-] p.z )? \)? * FREQ [+-] time * SPEED ) * AMP
    String.raw`sin\(\s*\(?\s*${P}([xyz])(?:\s*([+-])\s*${P}([xyz]))?\s*\)?\s*\*\s*([\d.]+)\s*([+-])\s*${timeSym}\s*\*\s*([\d.]+)\s*\)\s*\*\s*([\d.]+)`,
    'g',
  );
  const terms: WaveTerm[] = [];
  for (const m of src.matchAll(re)) {
    terms.push({
      coord: m[3] ? `${m[1]}${m[2]}${m[3]}` : m[1],
      freq: m[4],
      timeSign: m[5],
      speed: m[6],
      amp: m[7],
    });
  }
  return terms;
}

describe('sea wave math: CPU mirror matches the shader', () => {
  const shader = extractTerms('nrm.', 'uTime'); // GLSL string in onBeforeCompile
  const cpu = extractTerms('n.', 't'); // Island.waveHeightAt

  test('both representations were found (extraction not silently broken)', () => {
    // 5 terms today (3 swell + 2 chop). If a term is deliberately added,
    // update BOTH sides and this count together.
    expect(shader).toHaveLength(5);
    expect(cpu).toHaveLength(5);
  });

  test('term-by-term constants are identical, in order', () => {
    expect(cpu).toEqual(shader);
  });
});
