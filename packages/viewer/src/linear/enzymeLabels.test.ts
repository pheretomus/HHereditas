import type { EnzymeSite } from '@hhereditas/core';
import { describe, expect, it } from 'vitest';
import type { LabelBox, LabelPlacementOptions, PlacedLabel } from './enzymeLabels';
import { buildCutMarkers, cutDisplayPosition, placeEnzymeLabels, rowsUsed } from './enzymeLabels';

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

const site = (enzyme: string, start: number, len: number, cuts: Array<[number, number]>): EnzymeSite => ({
  enzyme,
  range: { start, end: start + len },
  strand: 1,
  cuts: cuts.map(([top, bottom]) => ({ top, bottom })),
});

describe('cutDisplayPosition', () => {
  it('is the 1-based position of the base before the cut', () => {
    expect(cutDisplayPosition(396, 4000, 'linear')).toBe(396);
    expect(cutDisplayPosition(396, 4000, 'circular')).toBe(396);
    // a cut at the origin of a circular record follows the last base
    expect(cutDisplayPosition(0, 4000, 'circular')).toBe(4000);
    expect(cutDisplayPosition(0, 4000, 'linear')).toBe(1);
  });
});

describe('buildCutMarkers', () => {
  it('labels cuts "Enzyme (position)", marks unique cutters and sorts by position', () => {
    const markers = buildCutMarkers(
      [
        site('EcoRI', 395, 6, [[396, 400]]),
        site('PstI', 30, 6, [[35, 31]]),
        site('PstI', 900, 6, [[905, 901]]),
        site('BamHI', 1200, 6, [[1201, 1205]]),
      ],
      4000,
      'linear',
    );
    expect(markers.map((m) => m.label)).toEqual(['PstI (35)', 'EcoRI (396)', 'PstI (905)', 'BamHI (1,201)']);
    expect(markers.map((m) => m.unique)).toEqual([false, true, false, true]);
    expect(markers[1]).toMatchObject({ pos: 396, bottom: 400, cuts: true });
  });

  it('counts every cut of an enzyme (an enzyme that cuts twice in one site is not unique)', () => {
    const markers = buildCutMarkers([site('BaeI', 100, 20, [[90, 85], [135, 130]])], 1000, 'linear');
    expect(markers).toHaveLength(2);
    expect(markers.every((m) => !m.unique)).toBe(true);
  });

  it('keeps a staggered cut that straddles the origin next to its top cut', () => {
    // top cut at the very end of a 1000 bp circle, bottom cut 4 bp later (gap 3 after the origin)
    const [m] = buildCutMarkers([site('KpnI', 995, 6, [[999, 3]])], 1000, 'circular');
    expect(m.pos).toBe(999);
    expect(m.bottom).toBe(1003);
    expect(m.label).toBe('KpnI (999)');
  });

  it('marks sites that are recognised but not cut at their start', () => {
    const [m] = buildCutMarkers([site('BsaI', 10, 6, [])], 1000, 'linear');
    expect(m).toMatchObject({ pos: 10, cuts: false, unique: false, label: 'BsaI (11)' });
  });

  it('normalizes cut positions on circular records', () => {
    const [m] = buildCutMarkers([site('NotI', 3990, 8, [[4002, 4006]])], 4000, 'circular');
    expect(m.pos).toBe(2);
    expect(m.label).toBe('NotI (2)');
  });
});

/** Every guarantee of the placement, checked pairwise. */
function checkInvariants(boxes: readonly LabelBox[], placed: ReadonlyArray<PlacedLabel | null>, opts: LabelPlacementOptions): void {
  const gap = opts.gap ?? 6;
  const clear = opts.clearance ?? 3;
  placed.forEach((p, i) => {
    if (!p) return;
    expect(p.row).toBeGreaterThanOrEqual(0);
    expect(p.row).toBeLessThan(opts.maxRows);
    expect(p.left).toBeGreaterThanOrEqual((opts.minX ?? -Infinity) - 1e-9);
    expect(p.right).toBeLessThanOrEqual((opts.maxX ?? Infinity) + 1e-9);
    expect(p.right - p.left).toBeCloseTo(boxes[i].width, 9);
    expect(Math.abs(p.x - boxes[i].x)).toBeLessThanOrEqual((opts.mergeDistance ?? 1.5) + 1e-9);
    expect(p.align === 'start' ? p.left : p.right).toBeCloseTo(p.x, 9);
  });
  for (let i = 0; i < placed.length; i++) {
    const a = placed[i];
    if (!a) continue;
    for (let j = 0; j < placed.length; j++) {
      const b = placed[j];
      if (!b || i === j) continue;
      if (a.row === b.row && i < j) {
        // 1. no overlap within a row
        expect(a.right + gap <= b.left || b.right + gap <= a.left).toBe(true);
      }
      if (a.row > b.row && Math.abs(a.x - b.x) >= 0.5) {
        // 2./3. a's leader crosses b's row: it must stay clear of b's label
        expect(a.x < b.left - clear || a.x > b.right + clear).toBe(true);
      }
    }
  }
}

describe('placeEnzymeLabels', () => {
  const opts = { maxRows: 5, minX: 0, maxX: 1000 };

  it('puts well separated labels in the lowest row', () => {
    const boxes = [100, 300, 500].map((x) => ({ x, width: 60, priority: 0 }));
    const placed = placeEnzymeLabels(boxes, opts);
    expect(placed.map((p) => p?.row)).toEqual([0, 0, 0]);
    expect(placed.map((p) => p?.align)).toEqual(['start', 'start', 'start']);
  });

  it('labels a close pair in one row, one on each side of the cuts', () => {
    const placed = placeEnzymeLabels(
      [
        { x: 400, width: 70, priority: 0 },
        { x: 420, width: 70, priority: 0 },
      ],
      opts,
    );
    expect(placed[0]).toMatchObject({ row: 0, align: 'end', right: 400 });
    expect(placed[1]).toMatchObject({ row: 0, align: 'start', left: 420 });
  });

  it('turns a cluster into a staircase rising to the left', () => {
    const boxes = [400, 410, 420, 430].map((x) => ({ x, width: 80, priority: 0 }));
    const placed = placeEnzymeLabels(boxes, opts);
    checkInvariants(boxes, placed, opts);
    expect(placed.every(Boolean)).toBe(true);
    // the rightmost cut sits lowest; rows rise towards the left
    const rows = placed.map((p) => p!.row);
    expect(rows[3]).toBe(0);
    for (let i = 1; i < 3; i++) expect(rows[i]).toBeGreaterThan(rows[i + 1]);
    expect(rowsUsed(placed)).toBeLessThanOrEqual(4);
  });

  it('does not drop a label next to a label that ends at its neighbour (free rows are used)', () => {
    // 1,203 bp / 1,345 bp / 1,454 bp in the linear sample at whole-record zoom
    const boxes = [
      { x: 202, width: 80, priority: 0 },
      { x: 222, width: 80, priority: 1 },
      { x: 239, width: 90, priority: 1 },
    ];
    const placed = placeEnzymeLabels(boxes, opts);
    checkInvariants(boxes, placed, opts);
    expect(placed.every(Boolean)).toBe(true);
  });

  it('stacks cuts that share a pixel on one leader', () => {
    const boxes = [
      { x: 300, width: 60, priority: 0 },
      { x: 300.4, width: 60, priority: 0 },
      { x: 301, width: 60, priority: 0 },
    ];
    const placed = placeEnzymeLabels(boxes, opts);
    checkInvariants(boxes, placed, opts);
    expect(new Set(placed.map((p) => p?.x))).toEqual(new Set([300]));
    expect(placed.map((p) => p?.row).sort()).toEqual([0, 1, 2]);
    // the rightmost cut is lowest, as in a staircase
    expect(placed[2]?.row).toBe(0);
  });

  it('turns labels that would overflow the right edge to the left of their cut', () => {
    const [p] = placeEnzymeLabels([{ x: 980, width: 60, priority: 0 }], opts);
    expect(p).toMatchObject({ align: 'end', left: 920, right: 980 });
  });

  it('makes room for unique cutters when rows run out', () => {
    // five non-unique cuts fill two rows of a cluster; the unique one must still be labelled
    const boxes = [
      ...[500, 505, 510, 515, 520].map((x) => ({ x, width: 80, priority: 0 })),
      { x: 512, width: 80, priority: 1 },
    ];
    const o = { maxRows: 2, minX: 0, maxX: 1000 };
    const placed = placeEnzymeLabels(boxes, o);
    checkInvariants(boxes, placed, o);
    expect(placed[5]).not.toBeNull();
  });

  it('leaves out cuts outside the visible range and labels nothing without rows', () => {
    expect(placeEnzymeLabels([{ x: -10, width: 50, priority: 1 }], opts)).toEqual([null]);
    expect(placeEnzymeLabels([{ x: 100, width: 50, priority: 1 }], { ...opts, maxRows: 0 })).toEqual([null]);
  });

  it('keeps every guarantee on random dense inputs', () => {
    const random = rng(1234);
    for (let trial = 0; trial < 150; trial++) {
      const n = 1 + Math.floor(random() * 80);
      const span = 200 + random() * 1800;
      const boxes: LabelBox[] = [];
      for (let i = 0; i < n; i++) {
        boxes.push({ x: random() * span, width: 30 + random() * 90, priority: random() < 0.3 ? 1 : 0 });
      }
      const o = { maxRows: 1 + Math.floor(random() * 6), minX: 2, maxX: span - 2 };
      const placed = placeEnzymeLabels(boxes, o);
      checkInvariants(boxes, placed, o);
      // an isolated cut always gets a label
      for (let i = 0; i < n; i++) {
        const lonely = boxes.every((b, j) => j === i || Math.abs(b.x - boxes[i].x) > 260);
        if (lonely && boxes[i].x >= 2 && boxes[i].x <= span - 2 && span > 2 * boxes[i].width + 10) {
          expect(placed[i]).not.toBeNull();
        }
      }
    }
  });
});
