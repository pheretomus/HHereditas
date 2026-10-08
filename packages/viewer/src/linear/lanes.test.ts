import { describe, expect, it } from 'vitest';
import type { LaneInterval } from './lanes';
import { buildLanes, packLanes, visibleSpan } from './lanes';

/** Seeded PRNG (mulberry32) so property tests are reproducible. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Pieces of an interval within [0, L] (two for one that wraps the origin). */
function pieces(iv: LaneInterval, L: number): LaneInterval[] {
  return iv.end > L ? [{ start: iv.start, end: L }, { start: 0, end: iv.end - L }] : [iv];
}

function overlaps(a: LaneInterval, b: LaneInterval, L: number): boolean {
  for (const p of pieces(a, L)) for (const q of pieces(b, L)) if (p.start < q.end && q.start < p.end) return true;
  return false;
}

describe('packLanes', () => {
  it('puts non-overlapping intervals in one lane and touching ones together', () => {
    const r = packLanes(
      [
        { start: 0, end: 10 },
        { start: 10, end: 20 },
        { start: 30, end: 40 },
      ],
      100,
    );
    expect([...r.lanes]).toEqual([0, 0, 0]);
    expect(r.laneCount).toBe(1);
  });

  it('stacks overlapping intervals, using as many lanes as the deepest overlap', () => {
    const r = packLanes(
      [
        { start: 0, end: 50 },
        { start: 10, end: 20 },
        { start: 15, end: 30 },
        { start: 40, end: 60 },
        { start: 60, end: 70 },
      ],
      100,
    );
    expect(r.laneCount).toBe(3);
    expect(r.lanes[0]).toBe(0);
    expect(r.lanes[1]).toBe(1);
    expect(r.lanes[2]).toBe(2);
    expect(r.lanes[3]).toBe(1); // first lane free at 40
    expect(r.lanes[4]).toBe(0); // the long one ended at 50
  });

  it('gives the inner lane to the longer of two intervals starting together', () => {
    const r = packLanes(
      [
        { start: 5, end: 10 },
        { start: 5, end: 90 },
      ],
      100,
    );
    expect([...r.lanes]).toEqual([1, 0]);
  });

  it('keeps both pieces of an origin-spanning interval in one lane, sharing it with what fits between them', () => {
    // on a 100 bp circle: 90..110 wraps (pieces 90..100 and 0..10); 20..80 fits between them
    const r = packLanes(
      [
        { start: 20, end: 80 },
        { start: 90, end: 110 },
        { start: 5, end: 15 },
      ],
      100,
    );
    expect(r.lanes[1]).toBe(0);
    expect(r.lanes[0]).toBe(0);
    expect(r.lanes[2]).toBe(1); // overlaps the wrapping interval's head piece 0..10
  });

  it('sends intervals beyond maxLanes to the last lane', () => {
    const r = packLanes(
      [
        { start: 0, end: 10 },
        { start: 0, end: 10 },
        { start: 0, end: 10 },
      ],
      100,
      2,
    );
    expect(r.laneCount).toBe(2);
    expect([...r.lanes].sort()).toEqual([0, 1, 1]);
  });

  it('never puts overlapping intervals in the same lane (random linear and circular sets)', () => {
    const random = rng(42);
    for (let trial = 0; trial < 200; trial++) {
      const L = 1000;
      const circular = trial % 2 === 1;
      const n = 1 + Math.floor(random() * 40);
      const intervals: LaneInterval[] = [];
      for (let i = 0; i < n; i++) {
        const start = Math.floor(random() * L);
        const len = 1 + Math.floor(random() * (circular ? 400 : Math.min(300, L - start)));
        intervals.push({ start, end: circular ? start + len : Math.min(L, start + len) });
      }
      const { lanes } = packLanes(intervals, circular ? L : 0);
      for (let a = 0; a < n; a++) {
        for (let b = a + 1; b < n; b++) {
          if (lanes[a] === lanes[b]) expect(overlaps(intervals[a], intervals[b], circular ? L : Infinity)).toBe(false);
        }
      }
    }
  });
});

describe('buildLanes', () => {
  it('splits an origin-spanning interval into two pieces of one lane', () => {
    const intervals = [
      { start: 20, end: 80 },
      { start: 90, end: 110 },
    ];
    const lanes = buildLanes(intervals, packLanes(intervals, 100), 100);
    expect(lanes).toHaveLength(1);
    expect(lanes[0].items).toEqual([
      { start: 0, end: 10, ref: 1, piece: 2 },
      { start: 20, end: 80, ref: 0, piece: 0 },
      { start: 90, end: 100, ref: 1, piece: 1 },
    ]);
    expect([...lanes[0].maxEnd]).toEqual([10, 80, 100]);
  });
});

describe('visibleSpan', () => {
  it('returns every item that intersects the window (brute-force check)', () => {
    const random = rng(7);
    for (let trial = 0; trial < 100; trial++) {
      const L = 10_000;
      const intervals: LaneInterval[] = [];
      for (let i = 0; i < 60; i++) {
        const start = Math.floor(random() * L);
        intervals.push({ start, end: Math.min(L, start + 1 + Math.floor(random() * 3000)) });
      }
      // one lane holding everything (overlaps allowed: an overflowing lane)
      const lanes = buildLanes(intervals, { lanes: new Int32Array(intervals.length), laneCount: 1 }, L);
      const lane = lanes[0];
      const from = random() * L;
      const to = from + random() * 2000;
      const [i0, i1] = visibleSpan(lane, from, to);
      lane.items.forEach((it, i) => {
        if (it.end > from && it.start < to) {
          expect(i).toBeGreaterThanOrEqual(i0);
          expect(i).toBeLessThan(i1);
        }
      });
    }
  });
});
