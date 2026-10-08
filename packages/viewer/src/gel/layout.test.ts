import { describe, expect, it } from 'vitest';
import {
  GEL_MAX_LANE_WIDTH,
  GEL_SMEAR_THRESHOLD,
  computeGelLayout,
  gelBandAlpha,
  gelBandGlow,
  gelBandThickness,
  gelLaneAt,
  gelPositionToY,
  gelYToPosition,
  hitTestGel,
  placeGelLabels,
  type GelLayout,
} from './layout';
import type { GelLane, GelLaneBand } from './types';

// ---------------------------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------------------------

/** Semi-log position like a 1 % agarose gel (logistic in log10 size). */
function pos(size: number): number {
  return 0.178 + 0.722 / (1 + (size / 1494) ** 1.12);
}

function band(size: number, intensity = 1, extra: Partial<GelLaneBand> = {}): GelLaneBand {
  return { size, position: pos(size), intensity, ...extra };
}

const LADDER_MIX = [10000, 8000, 6000, 5000, 4000, 3500, 3000, 2500, 2000, 1500, 1200, 1000, 900, 800, 700, 600, 500, 400, 300, 200, 100];
const REFERENCE = new Set([6000, 3000, 1000, 500]);

const ladderLane = (id = 'ladder', sizes = LADDER_MIX, label = 'Ladder'): GelLane => ({
  id,
  label,
  kind: 'ladder',
  bands: sizes.map((s) => band(s, REFERENCE.has(s) ? 1 : 0.4, { emphasized: REFERENCE.has(s) })),
});

const sampleLane = (id: string, sizes: number[], label = id): GelLane => ({
  id,
  label,
  kind: 'sample',
  bands: sizes.map((s) => band(s, s / Math.max(...sizes))),
});

const DIGEST: GelLane[] = [
  ladderLane(),
  sampleLane('ecori', [4361], 'EcoRI'),
  sampleLane('ep', [2293, 2068], 'EcoRI + PvuII'),
  sampleLane('hinfi', [1631, 517, 396, 344, 298, 221, 154, 75], 'HinfI'),
];

function noOverlap(ys: number[], spacing: number): boolean {
  const sorted = [...ys].sort((a, b) => a - b);
  return sorted.every((y, i) => i === 0 || y - sorted[i - 1] >= spacing - 1e-6);
}

// ---------------------------------------------------------------------------------------------
// y mapping
// ---------------------------------------------------------------------------------------------

describe('gelPositionToY / gelYToPosition', () => {
  const scale = { top: 40, bottom: 540 };

  it('maps the well (0) to the top and the bottom of the run (1) to the bottom, linearly', () => {
    expect(gelPositionToY(0, scale)).toBe(40);
    expect(gelPositionToY(1, scale)).toBe(540);
    expect(gelPositionToY(0.5, scale)).toBe(290);
    expect(gelPositionToY(0.25, scale) - gelPositionToY(0, scale)).toBeCloseTo(gelPositionToY(1, scale) - gelPositionToY(0.75, scale));
  });

  it('draws negative or invalid positions in the well', () => {
    expect(gelPositionToY(-0.3, scale)).toBe(40);
    expect(gelPositionToY(Number.NaN, scale)).toBe(40);
  });

  it('is inverted by gelYToPosition', () => {
    for (const p of [0, 0.123, 0.5, 0.87, 1, 1.2]) expect(gelYToPosition(gelPositionToY(p, scale), scale)).toBeCloseTo(p, 10);
    expect(gelYToPosition(100, { top: 5, bottom: 5 })).toBe(0);
  });

  it('places every drawn band of a layout at gelPositionToY(position), wells at position 0', () => {
    const layout = computeGelLayout(DIGEST, { width: 900, height: 600 });
    for (const lane of layout.lanes) {
      expect(lane.well.y + lane.well.height / 2).toBeCloseTo(layout.scale.top, 6);
      for (const g of lane.bands) expect(g.y).toBeCloseTo(gelPositionToY(g.band.position, layout.scale), 6);
      // top to bottom, larger fragments higher
      for (let i = 1; i < lane.bands.length; i++) {
        expect(lane.bands[i].y).toBeGreaterThanOrEqual(lane.bands[i - 1].y);
        expect(lane.bands[i].band.size).toBeLessThanOrEqual(lane.bands[i - 1].band.size);
      }
    }
    // the run fills most of the slab: wells near the top, position 1 just above the bottom edge
    const { slab, scale } = layout;
    expect(scale.top - slab.y).toBeLessThan(slab.height * 0.08);
    expect(slab.y + slab.height - scale.bottom).toBeGreaterThan(0);
    expect(slab.y + slab.height - scale.bottom).toBeLessThan(slab.height * 0.06);
  });

  it('does not draw bands that ran off the gel, and ignores bands without DNA', () => {
    const lane: GelLane = {
      id: 'x',
      label: 'x',
      kind: 'sample',
      bands: [
        { size: 50, position: 1.4, intensity: 1 },
        { size: 500, position: 0.7, intensity: 0.5 },
        { size: 600, position: 0.65, intensity: 0 },
        { size: 700, position: Number.NaN, intensity: 1 },
      ],
    };
    const layout = computeGelLayout([lane], { width: 600, height: 500 });
    expect(layout.lanes[0].bands.map((b) => b.band.size)).toEqual([500]);
    expect(layout.lanes[0].ranOff).toBe(1);
    expect(layout.lanes[0].bands[0].sourceIndex).toBe(1);
  });

  it('keeps the vertical scale when the width changes (only the height matters)', () => {
    const a = computeGelLayout(DIGEST, { width: 900, height: 600 });
    const b = computeGelLayout(DIGEST, { width: 1400, height: 600 });
    expect(b.scale).toEqual(a.scale);
  });
});

describe('band appearance', () => {
  it('maps intensity to opacity with a visibility floor and saturation', () => {
    expect(gelBandAlpha(0)).toBe(0);
    expect(gelBandAlpha(-1)).toBe(0);
    expect(gelBandAlpha(0.005)).toBeGreaterThanOrEqual(0.16);
    expect(gelBandAlpha(1)).toBeCloseTo(1, 10);
    expect(gelBandAlpha(5)).toBeCloseTo(1, 10);
    expect(gelBandAlpha(0.5)).toBeGreaterThan(0.8);
    let prev = 0;
    for (let i = 0.05; i <= 1; i += 0.05) {
      expect(gelBandAlpha(i)).toBeGreaterThan(prev);
      prev = gelBandAlpha(i);
    }
    // saturation: the response flattens at the top
    expect(gelBandAlpha(1) - gelBandAlpha(0.8)).toBeLessThan(gelBandAlpha(0.3) - gelBandAlpha(0.1));
  });

  it('makes brighter and merged bands thicker, and only bright bands glow', () => {
    expect(gelBandThickness(6, 1)).toBeGreaterThan(gelBandThickness(6, 0.2));
    expect(gelBandThickness(6, 0.5, 2)).toBeGreaterThan(gelBandThickness(6, 0.5, 1));
    expect(gelBandThickness(6, 0.5, 50)).toBeCloseTo(gelBandThickness(6, 0.5, 4));
    expect(gelBandGlow(0.2)).toBe(0);
    expect(gelBandGlow(1)).toBeGreaterThan(gelBandGlow(0.6));
  });
});

// ---------------------------------------------------------------------------------------------
// label de-overlap
// ---------------------------------------------------------------------------------------------

describe('placeGelLabels', () => {
  const opts = { spacing: 14, minY: 0, maxY: 1000, maxShift: 14 };

  it('leaves well separated labels at their bands', () => {
    const placed = placeGelLabels([{ y: 100 }, { y: 300 }, { y: 200 }], opts);
    expect(placed).toEqual([
      { index: 0, y: 100 },
      { index: 2, y: 200 },
      { index: 1, y: 300 },
    ]);
  });

  it('pushes two colliding labels apart symmetrically (least squares)', () => {
    const placed = placeGelLabels([{ y: 100 }, { y: 104 }], opts);
    expect(placed.map((p) => p.y)).toEqual([95, 109]);
  });

  it('respects the bounds', () => {
    const placed = placeGelLabels([{ y: 2 }, { y: 10 }, { y: 998 }], { ...opts, minY: 7, maxY: 993 });
    expect(placed.map((p) => p.y)).toEqual([7, 21, 993]);
  });

  it('never overlaps labels of a dense 21-band ladder, keeps reference bands and the order', () => {
    // a 1 % gel drawn 300 px tall: the ladder is crowded at both ends
    const targets = LADDER_MIX.map((s) => ({ y: 40 + pos(s) * 300, protected: REFERENCE.has(s), weight: REFERENCE.has(s) ? 1 : 0.4 }));
    const maxShift = 10;
    const placed = placeGelLabels(targets, { spacing: 14, minY: 30, maxY: 340, maxShift });
    expect(placed.length).toBeGreaterThan(8);
    expect(placed.length).toBeLessThan(LADDER_MIX.length); // too dense: some labels are dropped
    expect(noOverlap(placed.map((p) => p.y), 14)).toBe(true);
    for (const p of placed) {
      expect(Math.abs(p.y - targets[p.index].y)).toBeLessThanOrEqual(maxShift + 1e-6);
      expect(p.y).toBeGreaterThanOrEqual(30);
      expect(p.y).toBeLessThanOrEqual(340);
    }
    const kept = new Set(placed.map((p) => p.index));
    LADDER_MIX.forEach((s, i) => {
      if (REFERENCE.has(s)) expect(kept.has(i)).toBe(true);
    });
    // order preserved: label order = band order
    const order = placed.map((p) => p.index);
    expect(order).toEqual([...order].sort((a, b) => targets[a].y - targets[b].y));
    // deterministic
    expect(placeGelLabels(targets, { spacing: 14, minY: 30, maxY: 340, maxShift })).toEqual(placed);
  });

  it('thins an evenly crowded run to about every other label', () => {
    const targets = Array.from({ length: 16 }, (_, i) => ({ y: 200 + i * 7 }));
    const placed = placeGelLabels(targets, { spacing: 14, minY: 0, maxY: 1000, maxShift: 3 });
    expect(placed.length).toBeGreaterThanOrEqual(7);
    expect(placed.length).toBeLessThanOrEqual(9);
    expect(noOverlap(placed.map((p) => p.y), 14)).toBe(true);
    // the ends of the run are kept
    expect(placed[0].index).toBe(0);
    expect(placed[placed.length - 1].index).toBe(15);
  });

  it('copes with far more labels than fit (pathological input)', () => {
    const targets = Array.from({ length: 2000 }, (_, i) => ({ y: 100 + (i % 50), weight: i % 7 }));
    const placed = placeGelLabels(targets, { spacing: 12, minY: 90, maxY: 160, maxShift: 12 });
    expect(placed.length).toBeLessThanOrEqual(Math.floor(70 / 12) + 1);
    expect(placed.length).toBeGreaterThan(0);
    expect(noOverlap(placed.map((p) => p.y), 12)).toBe(true);
  });

  it('keeps protected labels before others and ignores invalid targets', () => {
    const targets = [{ y: 100 }, { y: 101, protected: true }, { y: 102 }, { y: Number.NaN }];
    const placed = placeGelLabels(targets, { spacing: 14, minY: 0, maxY: 1000, maxShift: 2 });
    expect(placed.map((p) => p.index)).toEqual([1]);
    expect(placeGelLabels([], opts)).toEqual([]);
    expect(placeGelLabels([{ y: 5 }], { spacing: 0, minY: 0, maxY: 10 })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// layout
// ---------------------------------------------------------------------------------------------

describe('computeGelLayout', () => {
  it('gives lanes at most 64 px, centred in the slab, all inside it', () => {
    const lanes = [sampleLane('a', [1000]), sampleLane('b', [2000]), sampleLane('c', [3000])];
    const layout = computeGelLayout(lanes, { width: 1600, height: 1000 });
    expect(layout.laneWidth).toBe(GEL_MAX_LANE_WIDTH);
    const { slab } = layout;
    const first = layout.lanes[0];
    const last = layout.lanes[2];
    expect(first.x - slab.x).toBeCloseTo(slab.x + slab.width - (last.x + last.width), 6);
    for (const lane of layout.lanes) {
      expect(lane.bandWidth).toBeLessThanOrEqual(GEL_MAX_LANE_WIDTH);
      expect(lane.bandLeft).toBeGreaterThan(slab.x);
      expect(lane.bandLeft + lane.bandWidth).toBeLessThan(slab.x + slab.width);
      expect(lane.cx).toBeCloseTo(lane.bandLeft + lane.bandWidth / 2, 6);
    }
    // the drawing fills the container, nothing overflows
    expect(layout.width).toBe(1600);
    expect(layout.height).toBe(1000);
  });

  it('shares a small width between many lanes and scrolls only when they cannot fit', () => {
    const twelve = Array.from({ length: 12 }, (_, i) => sampleLane(`s${i}`, [1000 + i * 100], ''));
    const fit = computeGelLayout(twelve, { width: 600, height: 400 });
    expect(fit.laneWidth).toBeLessThan(GEL_MAX_LANE_WIDTH);
    expect(fit.width).toBe(600);
    expect(fit.slab.x + fit.slab.width).toBeLessThanOrEqual(600);
    const many = Array.from({ length: 80 }, (_, i) => sampleLane(`s${i}`, [1000], ''));
    const scroll = computeGelLayout(many, { width: 600, height: 400 });
    expect(scroll.width).toBeGreaterThan(600);
  });

  it('writes the first ladder at the left of the slab, a different last ladder at the right', () => {
    const lanes = [ladderLane('l1'), sampleLane('s', [1500]), ladderLane('l2', [1500, 1000, 500, 100])];
    const layout = computeGelLayout(lanes, { width: 900, height: 600 });
    expect(layout.ladderLeft).toBe(0);
    expect(layout.ladderRight).toBe(2);
    const left = layout.ladderLabels.filter((l) => l.side === 'left');
    const right = layout.ladderLabels.filter((l) => l.side === 'right');
    expect(left.length).toBeGreaterThan(5);
    expect(right.map((l) => l.text)).toEqual(['1.5 kb', '1 kb', '500 bp', '100 bp']);
    for (const l of left) expect(l.x).toBeLessThan(layout.slab.x);
    for (const l of right) expect(l.x).toBeGreaterThan(layout.slab.x + layout.slab.width);
    expect(left.find((l) => l.text === '3 kb')?.emphasized).toBe(true);
    // every band of the left ladder has a label or a tick
    expect(left.length + layout.ladderTicks.filter((t) => t.side === 'left').length).toBe(LADDER_MIX.length);
    // the same ladder twice: labels only once
    const twice = computeGelLayout([ladderLane('a'), sampleLane('s', [1500]), ladderLane('b')], { width: 900, height: 600 });
    expect(twice.ladderRight).toBe(-1);
  });

  it("omits size labels with showSizes 'none' and labels sample bands with 'all'", () => {
    const none = computeGelLayout(DIGEST, { width: 900, height: 600, showSizes: 'none' });
    expect(none.ladderLabels).toEqual([]);
    expect(none.lanes.every((l) => l.sizeLabels.length === 0)).toBe(true);
    const all = computeGelLayout(DIGEST, { width: 900, height: 600, showSizes: 'all' });
    expect(all.lanes[0].sizeLabels).toEqual([]); // the ladder is written in the gutter
    const ep = all.lanes[2];
    expect(ep.sizeLabels.map((l) => l.text)).toEqual(['2.29 kb', '2.07 kb']);
    for (const lane of all.lanes.slice(1)) {
      expect(noOverlap(lane.sizeLabels.map((l) => l.y), 12)).toBe(true);
      for (const l of lane.sizeLabels) {
        expect(l.x).toBeGreaterThan(lane.bandLeft + lane.bandWidth);
        expect(l.x + l.width).toBeLessThanOrEqual(lane.x + lane.width + 1);
      }
    }
  });

  it('writes short lane labels horizontally and rotates long ones', () => {
    const short = computeGelLayout(DIGEST, { width: 900, height: 600 });
    expect(short.header.mode).toBe('horizontal');
    expect(short.header.labels.map((l) => l.text)).toEqual(['Ladder', 'EcoRI', 'EcoRI + PvuII', 'HinfI']);
    const long = Array.from({ length: 12 }, (_, i) => sampleLane(`s${i}`, [1000], `pUC19 clone ${i + 1} · EcoRI + HindIII double digest`));
    const rotated = computeGelLayout(long, { width: 900, height: 600 });
    expect(rotated.header.mode).toBe('diagonal');
    expect(rotated.header.labels.every((l) => l.truncated)).toBe(true);
    expect(rotated.header.height).toBeGreaterThan(40);
    expect(rotated.slab.y).toBeGreaterThan(short.slab.y);
  });

  it('spreads the lanes a little rather than rotating labels that almost fit', () => {
    const lanes = [sampleLane('a', [1000], 'Genomic, uncut'), sampleLane('b', [1000], 'Uncut plasmid'), sampleLane('c', [1000], 'NotI')];
    const layout = computeGelLayout(lanes, { width: 900, height: 600 });
    expect(layout.header.mode).toBe('horizontal');
    expect(layout.pitch).toBeGreaterThan(layout.laneWidth);
    expect(layout.laneWidth).toBe(GEL_MAX_LANE_WIDTH);
    const [a, b] = layout.header.labels;
    expect(b.x - a.x).toBeGreaterThanOrEqual((a.maxWidth + b.maxWidth) / 2 + 8 - 1e-6);
  });

  it('hides lane labels when lanes are too narrow even for vertical text', () => {
    const many = Array.from({ length: 100 }, (_, i) => sampleLane(`s${i}`, [1000], `Sample ${i}`));
    const layout = computeGelLayout(many, { width: 900, height: 600 });
    expect(layout.header.mode).toBe('hidden');
    expect(layout.header.labels).toEqual([]);
  });

  it('draws lanes with very many bands as a smear inside the slab', () => {
    const sizes = Array.from({ length: GEL_SMEAR_THRESHOLD * 20 }, (_, i) => 100 + ((i * 7919) % 9000));
    const lanes = [ladderLane(), sampleLane('genome', sizes)];
    const t0 = performance.now();
    const layout = computeGelLayout(lanes, { width: 900, height: 600, showSizes: 'all' });
    expect(performance.now() - t0).toBeLessThan(250);
    const smear = layout.lanes[1].smear;
    expect(smear).not.toBeNull();
    expect(smear!.length).toBeGreaterThan(10);
    expect(smear!.length).toBeLessThan(400);
    for (const s of smear!) {
      expect(s.y).toBeGreaterThanOrEqual(layout.slab.y);
      expect(s.y + s.height).toBeLessThanOrEqual(layout.slab.y + layout.slab.height + 1e-6);
      expect(s.alpha).toBeGreaterThan(0);
      expect(s.alpha).toBeLessThanOrEqual(1);
    }
    expect(layout.lanes[1].sizeLabels).toEqual([]); // no labels on a smear
    expect(layout.lanes[0].smear).toBeNull();
  });

  it('handles empty lanes and an empty gel', () => {
    const layout = computeGelLayout([ladderLane(), { id: 'e', label: 'Empty', kind: 'sample', bands: [] }], { width: 800, height: 500 });
    expect(layout.lanes[1].bands).toEqual([]);
    expect(layout.lanes[1].well.width).toBeGreaterThan(0);
    const none = computeGelLayout([], { width: 800, height: 500 });
    expect(none.lanes).toEqual([]);
    expect(none.slab.width).toBeGreaterThan(100);
    expect(none.header.mode).toBe('hidden');
    const zero = computeGelLayout(DIGEST, { width: 0, height: 0 });
    expect(Number.isFinite(zero.slab.width)).toBe(true);
  });

  it('fills the whole size without labels in compact (thumbnail) mode', () => {
    const layout = computeGelLayout(DIGEST, { width: 160, height: 200, compact: true, showSizes: 'all' });
    expect(layout.slab).toEqual({ x: 0, y: 0, width: 160, height: 200 });
    expect(layout.ladderLabels).toEqual([]);
    expect(layout.header.labels).toEqual([]);
    expect(layout.caption).toBeNull();
    expect(layout.lanes.every((l) => l.sizeLabels.length === 0)).toBe(true);
    expect(layout.lanes[0].bands.length).toBe(LADDER_MIX.length);
  });

  it('writes the agarose percentage in a corner of the slab', () => {
    const layout = computeGelLayout(DIGEST, { width: 900, height: 600, agarosePercent: 0.8 });
    expect(layout.caption?.text).toBe('0.8% agarose');
    expect(layout.caption!.x).toBeLessThan(layout.slab.x + layout.slab.width);
    expect(layout.caption!.y).toBeLessThan(layout.slab.y + layout.slab.height);
  });
});

// ---------------------------------------------------------------------------------------------
// hit-testing
// ---------------------------------------------------------------------------------------------

describe('hitTestGel', () => {
  const layout: GelLayout = computeGelLayout(DIGEST, { width: 900, height: 600, showSizes: 'all' });
  const hinfi = layout.lanes[3];

  it('finds the band under the pointer', () => {
    hinfi.bands.forEach((g, i) => {
      expect(hitTestGel(layout, hinfi.cx, g.y)).toEqual({ laneIndex: 3, bandIndex: i });
    });
    const top = hinfi.bands[0];
    // within the band's thickness and a little horizontal slop
    expect(hitTestGel(layout, hinfi.bandLeft + 1, top.y + top.height / 2)?.bandIndex).toBe(0);
    expect(hitTestGel(layout, hinfi.bandLeft - 4, top.y)?.bandIndex).toBe(0);
  });

  it('reports the lane without a band between bands', () => {
    const [a, b] = hinfi.bands;
    expect(hitTestGel(layout, hinfi.cx, (a.y + b.y) / 2)).toEqual({ laneIndex: 3, bandIndex: -1 });
    expect(hitTestGel(layout, hinfi.cx, layout.scale.top + 4)).toEqual({ laneIndex: 3, bandIndex: -1 });
  });

  it('returns null outside the lanes or the slab', () => {
    const { slab } = layout;
    expect(hitTestGel(layout, slab.x + 2, slab.y + slab.height / 2)).toBeNull(); // side margin
    expect(hitTestGel(layout, hinfi.cx, slab.y - 5)).toBeNull(); // lane labels
    expect(hitTestGel(layout, hinfi.cx, slab.y + slab.height + 5)).toBeNull();
    expect(gelLaneAt(layout, slab.x - 30)).toBe(-1);
    expect(gelLaneAt(layout, hinfi.cx)).toBe(3);
  });

  it('picks the closest of overlapping bands', () => {
    const lane: GelLane = {
      id: 'o',
      label: 'o',
      kind: 'sample',
      bands: [
        { size: 2000, position: 0.5, intensity: 1 },
        { size: 1950, position: 0.508, intensity: 1 },
      ],
    };
    const l = computeGelLayout([lane], { width: 400, height: 600 });
    const [a, b] = l.lanes[0].bands;
    expect(b.y - a.y).toBeLessThan(a.height); // they overlap on screen
    expect(hitTestGel(l, l.lanes[0].cx, a.y + 0.5)?.bandIndex).toBe(0);
    expect(hitTestGel(l, l.lanes[0].cx, b.y - 0.5)?.bandIndex).toBe(1);
  });

  it('treats a size label as part of its band', () => {
    const label = hinfi.sizeLabels[0];
    expect(hitTestGel(layout, label.x + label.width / 2, label.y)).toEqual({ laneIndex: 3, bandIndex: label.bandIndex });
  });

  it('summarises several unresolved bands of a smear lane', () => {
    const sizes = Array.from({ length: 2000 }, (_, i) => 200 + (i % 400));
    const l = computeGelLayout([sampleLane('g', sizes)], { width: 400, height: 600 });
    const lane = l.lanes[0];
    const mid = lane.bands[1000];
    const hit = hitTestGel(l, lane.cx, mid.y);
    expect(hit?.range).toBeDefined();
    expect(hit!.range!.end - hit!.range!.start).toBeGreaterThan(1);
    expect(hit!.bandIndex).toBeGreaterThanOrEqual(hit!.range!.start);
    expect(hit!.bandIndex).toBeLessThan(hit!.range!.end);
    // empty part of a smear lane: lane only
    expect(hitTestGel(l, lane.cx, l.scale.top + 2)).toEqual({ laneIndex: 0, bandIndex: -1 });
  });
});
