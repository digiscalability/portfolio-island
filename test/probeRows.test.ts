/**
 * Wave-4 probe rows judged by pure helpers (the integration's probe findings):
 * D11's "opacity only" ramp, P2-A11's prompted project card, B3's stick
 * radius, D16's minimap labels and C7's facade canvases.
 */
import { createRequire } from 'node:module';
import { describe, expect, test } from 'vitest';

const req = createRequire(import.meta.url);

type Row = { t: number; o: number | null; tf?: string };
const intro = req('../tools/ux-probes/intro.cjs') as {
  ramp: (rows: Row[]) => {
    shown: boolean;
    rampMs?: number | null;
    transformed?: boolean;
    transforms?: string[];
  };
};
const survey = req('../tools/ux-probes/p2/survey.cjs') as {
  cardAnchor: (prompt: { arg: string | null } | null, posedArg: string) => string | null;
};
const mobile = req('../tools/ux-probes/mobile.cjs') as {
  fullDeflectionPx: (sweep: Array<[number, number]>) => number | null;
};
type MapRow = { font: string; capPx: number; sample: string; pill: boolean };
const phone = req('../tools/ux-probes/phone.cjs') as {
  judgeMapLabels: (
    read: { rows: MapRow[] } | null,
  ) => { minCapPx: number | null; pillCapPx: number | null } | null;
};
type Tex = { canvas: number; canvas512: number; canvasMiB: number; canvas512MiB?: number };
const census = req('../tools/ux-probes/census.cjs') as {
  c7Verdict: (ts: Tex, tc: Tex) => { pass: boolean | null; delta: Record<string, number> };
};

describe('intro ramp (D11 reduced motion, opacity only)', () => {
  const fade = (tf: (i: number) => string): Row[] =>
    [0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({ t: i * 16.7, o: Math.min(1, i / 7), tf: tf(i) }));

  test('a constant positioning transform is not motion', () => {
    const r = intro.ramp(fade(() => 'matrix(1, 0, 0, 1, -180, 0)'));
    expect(r.transformed).toBe(false);
    expect(r.rampMs).toBe(117);
  });

  test('no transform at all is not motion', () => {
    expect(intro.ramp(fade(() => 'none')).transformed).toBe(false);
  });

  test('a transform that changes across frames (a slide) is motion', () => {
    expect(intro.ramp(fade((i) => `matrix(1, 0, 0, 1, 0, ${12 - i})`)).transformed).toBe(true);
  });

  test('a transform going from none to a scale is motion', () => {
    expect(
      intro.ramp(fade((i) => (i < 3 ? 'none' : 'matrix(1.02, 0, 0, 1.02, 0, 0)'))).transformed,
    ).toBe(true);
  });
});

describe('survey card anchor (P2-A11)', () => {
  test('the active prompt names the card, not the pose', () => {
    expect(survey.cardAnchor({ arg: 'project:chocomate' }, 'project:rankpilot')).toBe('chocomate');
  });
  test('falls back to the posed hotspot when no prompt is read', () => {
    expect(survey.cardAnchor(null, 'project:rankpilot')).toBe('rankpilot');
    expect(survey.cardAnchor({ arg: null }, 'project:rankpilot')).toBe('rankpilot');
  });
  test('a non-project hotspot anchors nothing', () => {
    expect(survey.cardAnchor({ arg: 'hire' }, 'project:rankpilot')).toBeNull();
  });
});

describe('stick radius (B3 plateaus)', () => {
  // D15's output: engage at 0.12, renormalised from 0.08, full at MAX = 40 px.
  const d15 = (px: number) => {
    const mag = Math.min(1, px / 40);
    return mag < 0.12 ? 0 : +((mag - 0.08) / 0.92).toFixed(2);
  };
  // main's: a 0.12 dead zone renormalised, full at 40 px.
  const main = (px: number) => {
    const mag = Math.min(1, px / 40);
    return mag < 0.12 ? 0 : +((mag - 0.12) / 0.88).toFixed(2);
  };
  const sweep = (f: (px: number) => number): Array<[number, number]> => {
    const out: Array<[number, number]> = [];
    for (let px = 6; px <= 70; px += 2) out.push([px, f(px)]);
    return out;
  };

  test('the radius is the pull at full deflection, 40 px on both builds, not the 55 px ring', () => {
    expect(mobile.fullDeflectionPx(sweep(d15))).toBe(40);
    expect(mobile.fullDeflectionPx(sweep(main))).toBe(40);
  });

  test('0.7 of that radius stays under the 0.95 rim run; 0.7 of the ring did not', () => {
    expect(d15(0.7 * 40)).toBeLessThan(0.95);
    expect(d15(0.7 * 55)).toBeGreaterThanOrEqual(0.95);
  });

  test('no full deflection reads null (the probe falls back to the ring)', () => {
    expect(mobile.fullDeflectionPx(sweep(() => 0.5))).toBeNull();
  });
});

describe('minimap labels (D16)', () => {
  test('the online-count pill is reported apart from the place labels', () => {
    const j = phone.judgeMapLabels({
      rows: [
        { font: '600 21px sans-serif', capPx: 7.3, sample: 'Hub', pill: false },
        { font: '600 21px sans-serif', capPx: 7.0, sample: 'Projects', pill: false },
        { font: 'bold 14.9px sans-serif', capPx: 6.7, sample: '1 ONLINE', pill: true },
      ],
    });
    expect(j?.minCapPx).toBe(7.0);
    expect(j?.pillCapPx).toBe(6.7);
  });
  test('a small place label still fails the row', () => {
    const j = phone.judgeMapLabels({
      rows: [{ font: '600 16px sans-serif', capPx: 5.4, sample: 'Welcome', pill: false }],
    });
    expect(j?.minCapPx).toBe(5.4);
  });
  test('no minimap reads null', () => {
    expect(phone.judgeMapLabels(null)).toBeNull();
  });
});

describe('C7 census verdict (512x512 facade canvases)', () => {
  test("another package's new canvas does not offset C7's removal", () => {
    // Desktop at integration: 65 vs 65 canvases, 512x512 1 -> 0.
    const v = census.c7Verdict(
      { canvas: 65, canvas512: 0, canvasMiB: 10.0, canvas512MiB: 0 },
      { canvas: 65, canvas512: 1, canvasMiB: 11.32, canvas512MiB: 1.33 },
    );
    expect(v.pass).toBe(true);
    expect(v.delta.canvas512).toBe(-1);
    expect(v.delta.canvas).toBe(0);
  });
  test('unchanged reads null and a rise fails', () => {
    expect(
      census.c7Verdict(
        { canvas: 5, canvas512: 1, canvasMiB: 2, canvas512MiB: 1.33 },
        { canvas: 4, canvas512: 1, canvasMiB: 1.9, canvas512MiB: 1.33 },
      ).pass,
    ).toBeNull();
    expect(
      census.c7Verdict(
        { canvas: 5, canvas512: 2, canvasMiB: 3, canvas512MiB: 2.67 },
        { canvas: 4, canvas512: 1, canvasMiB: 1.9, canvas512MiB: 1.33 },
      ).pass,
    ).toBe(false);
  });
});
