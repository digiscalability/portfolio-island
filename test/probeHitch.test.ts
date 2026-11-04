// hitch's verdict maths (tools/ux-probes/frames.cjs), item CO-E3. A frame over
// 50 ms is the interior warm's only by the warm's own work in it, or by a live
// render that drew the room outside an entry. Every stage-2 PR reruns hitch,
// so a boot-tail frame the warm merely overlaps must not fail it, and stage
// 1's warm (the room shown while compileAsync finished) must.
import { createRequire } from 'node:module';
import { describe, expect, test } from 'vitest';

type Frame = [number, number];
type Flight = { t: number; endMs: number | null };
type Render = { t: number; label: string; added: number; ms: number; inCompile?: boolean };
type Row = { t: number; ms: number; warmMs: number; why: string | null; renders: unknown[] };
type Attribution = { inFlight: Row[]; charged: Row[] };

const hitch = createRequire(import.meta.url)('../tools/ux-probes/frames.cjs') as {
  WARM_MIN_MS: number;
  warmAttribution: (o: {
    frames: Frame[];
    flights: Flight[];
    segs?: Array<[number, number]>;
    roomRenders?: Render[];
    renders?: Render[];
  }) => Attribution;
  warmTagging: (o: {
    flights: Flight[];
    segs: Array<[number, number]>;
    compiles: Array<{ t: number; syncMs: number }>;
    yields: number;
    closedAtFrame: number;
  }) => { ok: boolean; why: string[]; compileMsOutsideSpans: number };
};

// The warm in flight from 2,000 to 2,800 ms (watched to 2,900).
const flight: Flight[] = [{ t: 2000, endMs: 800 }];
const tick = (t: number, dt: number): Frame => [t, dt];

describe('warmAttribution(): the warm is charged by its own work', () => {
  test("a boot-tail frame the warm overlaps with one slice in it is not the warm's", () => {
    // s1-int, 2026-11-04: the warm at ready + 2.17 s, the card at 2.40 s, a
    // 90 ms frame at 2.31 s holding 4 ms of the warm's slices.
    const r = hitch.warmAttribution({
      frames: [tick(2200, 10), tick(2310, 90.1), tick(2320, 10)],
      flights: flight,
      segs: [
        [2195, 2199],
        [2262, 2266],
      ],
    });
    expect(r.inFlight).toHaveLength(1);
    expect(r.inFlight[0]).toMatchObject({ ms: 90.1, warmMs: 4, why: null });
    expect(r.charged).toEqual([]);
  });

  test('a frame the warm pushed over the line is charged', () => {
    // A slice blown up to 30 ms next to 30 ms of other work.
    const r = hitch.warmAttribution({
      frames: [tick(2400, 60)],
      flights: flight,
      segs: [[2350, 2380]],
    });
    expect(r.charged).toHaveLength(1);
    expect(r.charged[0].warmMs).toBe(30);
    expect(r.charged[0].why).toMatch(/30 ms without it/);
  });

  test("the warm's own work over 50 ms in one frame is charged, whatever else ran", () => {
    const r = hitch.warmAttribution({
      frames: [tick(2500, 300)],
      flights: flight,
      segs: [[2210, 2270]],
    });
    expect(r.charged[0].why).toMatch(/own work in it is 60 ms/);
  });

  test('a slice or two in a frame over the line on other work is not (WARM_MIN_MS)', () => {
    expect(hitch.WARM_MIN_MS).toBe(10);
    const r = hitch.warmAttribution({
      frames: [tick(2400, 52)],
      flights: flight,
      segs: [
        [2350, 2354],
        [2360, 2364],
      ],
    });
    expect(r.inFlight[0].warmMs).toBe(8);
    expect(r.charged).toEqual([]);
  });

  test('a live render that drew the room outside an entry is charged (58c8849)', () => {
    // Stage 1's warm: the room shown while compileAsync finished, then a
    // 1,544.8 ms composer render of its variants (+38 programs), at 4.13 s.
    const render: Render = { t: 2600, label: 'composer.render', added: 38, ms: 1544.8 };
    const r = hitch.warmAttribution({
      frames: [tick(4280, 1680.3)],
      flights: flight,
      roomRenders: [render],
      renders: [{ ...render, inCompile: false }],
    });
    expect(r.charged).toHaveLength(1);
    expect(r.charged[0].why).toMatch(/drew the room outside an entry/);
  });

  test('a render that created programs with the room hidden is listed, not charged', () => {
    // The bloom's arrival (+6 programs, 91 ms) or a late model's first draw.
    const r = hitch.warmAttribution({
      frames: [tick(2600, 100)],
      flights: flight,
      renders: [{ t: 2520, label: 'composer.render', added: 6, ms: 91, inCompile: false }],
    });
    expect(r.inFlight[0].renders).toEqual([{ label: 'composer.render', added: 6, ms: 91 }]);
    expect(r.charged).toEqual([]);
  });

  test('frames outside every flight, and frames of 50 ms or less, are not considered', () => {
    const r = hitch.warmAttribution({
      frames: [tick(1900, 120), tick(3100, 150), tick(2400, 50)],
      flights: flight,
      segs: [[2360, 2400]],
    });
    expect(r.inFlight).toEqual([]);
    expect(r.charged).toEqual([]);
  });
});

describe("warmTagging(): the warm's work seen whole, or the check is inconclusive", () => {
  const segs: Array<[number, number]> = [
    [2000, 2010],
    [2020, 2024],
  ];

  test('s1-int: yields seen and every compile inside a span', () => {
    const r = hitch.warmTagging({
      flights: [{ t: 2000, endMs: 883 }],
      segs,
      compiles: [
        { t: 2021, syncMs: 0.8 },
        { t: 2022, syncMs: 1.1 },
      ],
      yields: 31,
      closedAtFrame: 0,
    });
    expect(r).toMatchObject({ ok: true, why: [], compileMsOutsideSpans: 0 });
  });

  test('58c8849: a warm that ran for 1,834 ms with no yield seen', () => {
    const r = hitch.warmTagging({
      flights: [{ t: 2000, endMs: 1834 }],
      segs: [[2000, 2141]],
      compiles: [{ t: 3000, syncMs: 56.4 }],
      yields: 0,
      closedAtFrame: 0,
    });
    expect(r.ok).toBe(false);
    expect(r.why.join(' ')).toMatch(/0 of its yields were seen/);
    expect(r.compileMsOutsideSpans).toBe(56.4);
  });

  test('a span left open at a frame means a yield the tags missed', () => {
    const r = hitch.warmTagging({
      flights: [{ t: 2000, endMs: 600 }],
      segs,
      compiles: [],
      yields: 12,
      closedAtFrame: 1,
    });
    expect(r.ok).toBe(false);
  });

  test('a warm call that finds the room warm (endMs 0) needs no yield', () => {
    const r = hitch.warmTagging({
      flights: [{ t: 2000, endMs: 0 }],
      segs: [[2000, 2000.1]],
      compiles: [],
      yields: 0,
      closedAtFrame: 0,
    });
    expect(r.ok).toBe(true);
  });
});
