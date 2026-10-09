import type { EnzymeSite, Feature, Orf, PrimerBindingSite } from '@hhereditas/core';
import { describe, expect, it } from 'vitest';
import type { LayoutFeature, RowModel, RowModelInput } from './layout';
import {
  DEFAULT_METRICS as M,
  autoBasesPerRow,
  bandAtY,
  baseAtPoint,
  bucketRangesByRow,
  buildRowModel,
  colCenter,
  colLeft,
  colRight,
  cutCounts,
  enzymeLabelText,
  gapAtPoint,
  gapX,
  makeGeometry,
  rangeColsInRow,
  rowAtY,
  rowOfBase,
  rowOfGap,
  xToCol,
  xToGap,
} from './layout';

function feature(id: string, start: number, end: number, strand: 1 | -1 | 0 = 1, extra: Partial<Feature> = {}): Feature {
  return { id, type: 'misc_feature', name: id, strand, segments: [{ start, end }], qualifiers: [], ...extra };
}

const lf = (f: Feature, translated = false): LayoutFeature => ({ feature: f, translated });

function site(enzyme: string, start: number, end: number, top: number, bottom: number): EnzymeSite {
  return { enzyme, range: { start, end }, strand: 1, cuts: [{ top, bottom }] };
}

function model(input: Partial<RowModelInput> & { length: number; basesPerRow: number }): RowModel {
  return buildRowModel({ topology: 'linear', numberColumnWidth: 40, ...input });
}

/** y (content coordinates) of the middle of the top strand of row r. */
function strandY(mdl: RowModel, r: number): number {
  return mdl.offsets[r] + mdl.rows[r].y.strand + M.strandHeight / 2;
}

describe('horizontal geometry', () => {
  it('auto bases per row is the largest multiple of 10 that fits the width', () => {
    for (const width of [180, 420, 600, 960, 1320, 1600, 2400]) {
      const n = autoBasesPerRow(width, M, 40);
      expect(n % 10).toBe(0);
      expect(n).toBeGreaterThanOrEqual(10);
      const fits = (k: number) => makeGeometry(M, 40, k).width <= width + 1;
      if (n > 10) expect(fits(n)).toBe(true);
      expect(fits(n + 10)).toBe(false);
    }
  });

  it('puts a gap after every group of 10 bases', () => {
    const geo = makeGeometry(M, 40, 30);
    expect(colLeft(geo, 1) - colLeft(geo, 0)).toBeCloseTo(M.charWidth);
    expect(colLeft(geo, 10) - colRight(geo, 9)).toBeCloseTo(M.groupGap);
    expect(colLeft(geo, 20) - colLeft(geo, 0)).toBeCloseTo(20 * M.charWidth + 2 * M.groupGap);
    // a group-boundary gap is drawn in the middle of the group gap
    expect(gapX(geo, 10, 30)).toBeCloseTo(colRight(geo, 9) + M.groupGap / 2);
    expect(gapX(geo, 0, 30)).toBe(colLeft(geo, 0));
    expect(gapX(geo, 30, 30)).toBe(colRight(geo, 29));
  });

  it('maps every gap position to x and back', () => {
    const geo = makeGeometry(M, 40, 60);
    for (let g = 0; g <= 60; g++) expect(xToGap(geo, gapX(geo, g, 60), 60)).toBe(g);
    for (let c = 0; c < 60; c++) expect(xToCol(geo, colCenter(geo, c), 60)).toBe(c);
  });

  it('picks the nearest gap inside a base and the group boundary inside a group gap', () => {
    const geo = makeGeometry(M, 40, 60);
    const cw = M.charWidth;
    expect(xToGap(geo, colLeft(geo, 3) + 0.45 * cw, 60)).toBe(3);
    expect(xToGap(geo, colLeft(geo, 3) + 0.55 * cw, 60)).toBe(4);
    expect(xToGap(geo, colRight(geo, 9) + 1, 60)).toBe(10);
    expect(xToGap(geo, colLeft(geo, 10) - 1, 60)).toBe(10);
    // base under the pointer: in a group gap, the nearer base
    expect(xToCol(geo, colRight(geo, 9) + 1, 60)).toBe(9);
    expect(xToCol(geo, colLeft(geo, 10) - 1, 60)).toBe(10);
  });

  it('clamps to the bases of a short last row and to the left margin', () => {
    const geo = makeGeometry(M, 40, 60);
    expect(xToGap(geo, 5000, 7)).toBe(7);
    expect(xToGap(geo, 0, 7)).toBe(0);
    expect(xToCol(geo, 5000, 7)).toBe(6);
    expect(xToCol(geo, -50, 7)).toBe(0);
    expect(xToGap(geo, 100, 0)).toBe(0);
    expect(xToCol(geo, 100, 0)).toBe(-1);
  });
});

describe('row model', () => {
  it('cuts the sequence into rows of N bases', () => {
    const mdl = model({ length: 95, basesPerRow: 20 });
    expect(mdl.rowCount).toBe(5);
    expect(mdl.rows.map((r) => [r.start, r.end])).toEqual([
      [0, 20],
      [20, 40],
      [40, 60],
      [60, 80],
      [80, 95],
    ]);
  });

  it('keeps one empty row for an empty sequence', () => {
    const mdl = model({ length: 0, basesPerRow: 20 });
    expect(mdl.rowCount).toBe(1);
    expect(mdl.rows[0].start).toBe(0);
    expect(mdl.rows[0].end).toBe(0);
    expect(mdl.totalHeight).toBeGreaterThan(0);
  });

  it('stores the row offsets as prefix sums of the exact row heights', () => {
    const mdl = model({
      length: 500,
      basesPerRow: 50,
      features: [lf(feature('a', 10, 120)), lf(feature('b', 60, 70)), lf(feature('c', 300, 420), true)],
      enzymes: [site('EcoRI', 200, 206, 201, 205)],
    });
    expect(mdl.offsets[0]).toBe(0);
    for (let r = 0; r < mdl.rowCount; r++) expect(mdl.offsets[r + 1] - mdl.offsets[r]).toBe(mdl.rows[r].height);
    expect(mdl.totalHeight).toBe(mdl.offsets[mdl.rowCount]);
    // rows with annotations are taller than bare rows
    const bare = mdl.rows[5].height; // 250..300: nothing
    expect(mdl.rows[1].height).toBeGreaterThan(bare); // a + b (two lanes)
    expect(mdl.rows[4].height).toBeGreaterThan(bare); // enzyme label
    expect(mdl.rows[6].height).toBeGreaterThan(mdl.rows[0].height); // c is translated
  });

  it('sizes rows from their content: strands, enzyme lanes, feature lanes, translations', () => {
    const base = model({ length: 100, basesPerRow: 100 }).rows[0].height;
    const single = model({ length: 100, basesPerRow: 100, showComplement: false }).rows[0].height;
    expect(base - single).toBe(M.strandHeight);
    const oneLane = model({ length: 100, basesPerRow: 100, features: [lf(feature('a', 10, 50))] }).rows[0].height;
    expect(oneLane - base).toBe(M.featureGap + M.featureBarHeight);
    const twoLanes = model({ length: 100, basesPerRow: 100, features: [lf(feature('a', 10, 50)), lf(feature('b', 20, 60))] }).rows[0];
    expect(twoLanes.featureLanes.length).toBe(2);
    expect(twoLanes.height - oneLane).toBe(M.featureLaneGap + M.featureBarHeight);
    const translated = model({ length: 100, basesPerRow: 100, features: [lf(feature('a', 10, 50), true)] }).rows[0];
    expect(translated.height - oneLane).toBe(M.translationHeight);
    expect(translated.featureLanes[0].translation).toBe(true);
    const enzymes = model({
      length: 100,
      basesPerRow: 100,
      enzymes: [site('E1', 40, 46, 41, 45), site('E2', 42, 48, 43, 47), site('E3', 44, 50, 45, 49)],
    }).rows[0];
    expect(enzymes.enzymeLanes).toBe(3);
    expect(enzymes.height - base).toBe(3 * M.enzymeLaneHeight + M.enzymeClearance);
  });

  it('gives overlapping features separate lanes and lets disjoint ones share a lane', () => {
    const mdl = model({
      length: 100,
      basesPerRow: 100,
      features: [lf(feature('A', 0, 30)), lf(feature('B', 10, 40)), lf(feature('C', 45, 60)), lf(feature('D', 35, 50))],
    });
    const lanes = Object.fromEntries(mdl.rows[0].features.map((p) => [p.feature, p.lane]));
    expect(lanes[0]).toBe(0); // A
    expect(lanes[1]).toBe(1); // B overlaps A
    expect(lanes[3]).toBe(0); // D starts after A ends
    expect(lanes[2]).toBe(1); // C overlaps D, B has ended
    expect(mdl.rows[0].featureLanes.length).toBe(2);
    // no two pieces in one lane overlap
    const byLane = new Map<number, Array<[number, number]>>();
    for (const p of mdl.rows[0].features) byLane.set(p.lane, [...(byLane.get(p.lane) ?? []), [p.startCol, p.endCol]]);
    for (const spans of byLane.values()) {
      spans.sort((a, b) => a[0] - b[0]);
      for (let i = 1; i < spans.length; i++) expect(spans[i][0]).toBeGreaterThanOrEqual(spans[i - 1][1]);
    }
  });

  it('repeats a feature (and its name) in every row it spans, with the arrow at its 3′ end only', () => {
    const fwd = model({ length: 120, basesPerRow: 30, features: [lf(feature('KanR', 5, 95))] });
    const pieces = fwd.rows.map((r) => r.features[0]);
    expect(pieces.map((p) => p && [p.startCol, p.endCol])).toEqual([[5, 30], [0, 30], [0, 30], [0, 5]]);
    for (const p of pieces.slice(0, 3)) expect(p.label?.text).toBe('KanR');
    expect(pieces[0].bars[0]).toMatchObject({ openStart: false, openEnd: true, arrowStart: false, arrowEnd: false });
    expect(pieces[1].bars[0]).toMatchObject({ openStart: true, openEnd: true, arrowEnd: false });
    expect(pieces[3].bars[0]).toMatchObject({ openStart: true, openEnd: false, arrowEnd: true });

    const rev = model({ length: 120, basesPerRow: 30, features: [lf(feature('AmpR', 5, 95, -1))] });
    expect(rev.rows[0].features[0].bars[0]).toMatchObject({ arrowStart: true, arrowEnd: false });
    expect(rev.rows[3].features[0].bars[0]).toMatchObject({ arrowStart: false, arrowEnd: false });
  });

  it('draws an origin-spanning feature at the end of the last row and the start of the first', () => {
    const mdl = model({
      length: 100,
      topology: 'circular',
      basesPerRow: 25,
      features: [lf(feature('ori', 90, 110))],
    });
    const last = mdl.rows[3].features[0];
    const first = mdl.rows[0].features[0];
    expect([last.startCol, last.endCol]).toEqual([15, 25]);
    expect(last.bars[0]).toMatchObject({ openStart: false, openEnd: true, arrowEnd: false });
    expect([first.startCol, first.endCol]).toEqual([0, 10]);
    expect(first.bars[0]).toMatchObject({ openStart: true, openEnd: false, arrowEnd: true });
    expect(mdl.rows[1].features).toHaveLength(0);
  });

  it('draws one bar per segment of a joined feature inside one piece', () => {
    const f = feature('exons', 10, 20, 1, { segments: [{ start: 10, end: 20 }, { start: 30, end: 45 }] });
    const piece = model({ length: 100, basesPerRow: 100, features: [lf(f)] }).rows[0].features[0];
    expect([piece.startCol, piece.endCol]).toEqual([10, 45]);
    expect(piece.bars.map((b) => [b.startCol, b.endCol, b.arrowEnd])).toEqual([
      [10, 20, false],
      [30, 45, true],
    ]);
  });

  it('puts a name that does not fit inside a short bar beside it', () => {
    const mdl = model({ length: 100, basesPerRow: 100, features: [lf(feature('a long feature name', 40, 43))] });
    const p = mdl.rows[0].features[0];
    expect(p.label?.inside).toBe(false);
    expect(p.label?.text).toBe('a long feature name');
    expect(p.label!.x).toBeGreaterThan(colRight(mdl.geometry, 42));
  });

  it('names every short piece of a feature beside it when its lane has room (review: anonymous stubs)', () => {
    // an origin-spanning promoter: its main piece at the end of the last row, a 2-base stub in row 1
    const circ = model({ length: 100, topology: 'circular', basesPerRow: 50, features: [lf(feature('SP6 promoter', 80, 102))] });
    const stub = circ.rows[0].features[0];
    expect([stub.startCol, stub.endCol]).toEqual([0, 2]);
    expect(stub.label).toMatchObject({ text: 'SP6 promoter', inside: false });
    expect(stub.label!.x).toBeGreaterThan(colRight(circ.geometry, 1));
    // the extra label never costs a lane
    expect(circ.rows[0].featureLanes).toHaveLength(1);
  });

  it('puts a piece name to the left when the right side is taken, and drops it when its lane is full', () => {
    // 'Long name here' starts 4 bases before the end of row 0; its main piece is in row 1
    const left = model({ length: 200, basesPerRow: 100, features: [lf(feature('Long name here', 96, 196))] });
    const start = left.rows[0].features[0];
    expect([start.startCol, start.endCol]).toEqual([96, 100]);
    expect(start.label).toMatchObject({ text: 'Long name here', inside: false });
    expect(start.label!.x + start.label!.width).toBeLessThan(colLeft(left.geometry, 96));

    // a bar of the same lane right before the stub: no room on either side, no extra lane
    const full = model({
      length: 200,
      basesPerRow: 100,
      features: [lf(feature('blocker', 60, 96)), lf(feature('Long name here', 97, 195))],
    });
    const pieces = full.rows[0].features;
    const blocker = pieces.find((p) => p.feature === 0)!;
    const stub = pieces.find((p) => p.feature === 1)!;
    expect(stub.lane).toBe(blocker.lane);
    expect(stub.label).toBeNull(); // 3 bases: too short even for a truncated name
    expect(full.rows[0].featureLanes).toHaveLength(1);
  });
});

describe('enzymes', () => {
  it('labels a site with the 1-based position of its top-strand cut', () => {
    const ecoRI = site('EcoRI', 395, 401, 396, 400);
    expect(enzymeLabelText(ecoRI, 2686, 'circular')).toBe('EcoRI (396)');
    // a cut at the origin of a circular molecule is after the last base
    expect(enzymeLabelText(site('X', 2684, 2690, 0, 4), 2686, 'circular')).toBe('X (2,686)');
    // recognised but not cut: the site's first base
    expect(enzymeLabelText({ ...ecoRI, cuts: [] }, 2686, 'linear')).toBe('EcoRI (396)');
  });

  it('flags unique cutters', () => {
    const sites = [site('EcoRI', 10, 16, 11, 15), site('BamHI', 30, 36, 31, 35), site('BamHI', 70, 76, 71, 75)];
    expect(cutCounts(sites)).toEqual(new Map([['EcoRI', 1], ['BamHI', 2]]));
    const mdl = model({ length: 100, basesPerRow: 100, enzymes: sites });
    const unique = Object.fromEntries(mdl.rows[0].enzymeLabels.map((l) => [l.text, l.unique]));
    expect(unique).toEqual({ 'EcoRI (11)': true, 'BamHI (31)': false, 'BamHI (71)': false });
  });

  it('draws the stepped cut line of a site inside one row', () => {
    const mdl = model({ length: 100, basesPerRow: 50, enzymes: [site('EcoRI', 60, 66, 61, 65)] });
    expect(mdl.rows[0].cutMarks).toHaveLength(0);
    expect(mdl.rows[1].cutMarks).toEqual([{ site: 0, top: 11, bottom: 15, from: 11, to: 15 }]);
    const label = mdl.rows[1].enzymeLabels[0];
    expect(label.anchorX).toBeCloseTo(gapX(mdl.geometry, 11, 50));
  });

  it('keeps a cut on a row boundary in the row of its other strand', () => {
    // 3′ overhang (KpnI-like): top cut at the row boundary 50, bottom cut 4 bases earlier
    const kpn = model({ length: 100, basesPerRow: 50, enzymes: [site('KpnI', 45, 51, 50, 46)] });
    expect(kpn.rows[0].cutMarks).toEqual([{ site: 0, top: 50, bottom: 46, from: 46, to: 50 }]);
    expect(kpn.rows[0].enzymeLabels).toHaveLength(1);
    expect(kpn.rows[1].cutMarks).toHaveLength(0);
    // 5′ overhang starting at the boundary: everything in the next row
    const eco = model({ length: 100, basesPerRow: 50, enzymes: [site('EcoRI', 49, 55, 50, 54)] });
    expect(eco.rows[1].cutMarks).toEqual([{ site: 0, top: 0, bottom: 4, from: 0, to: 4 }]);
  });

  it('splits a cut line that crosses the origin of a circular record', () => {
    const mdl = model({
      length: 100,
      topology: 'circular',
      basesPerRow: 50,
      enzymes: [site('XhoI', 97, 103, 98, 2)],
    });
    expect(mdl.rows[1].cutMarks).toEqual([{ site: 0, top: 48, bottom: null, from: 48, to: 50 }]);
    expect(mdl.rows[0].cutMarks).toEqual([{ site: 0, top: null, bottom: 2, from: 0, to: 2 }]);
    expect(mdl.rows[1].enzymeLabels[0].text).toBe('XhoI (98)');
  });

  it('stacks crowded labels upwards without overlaps', () => {
    const sites = Array.from({ length: 8 }, (_, i) => site(`Enzyme${i}`, 10 + 2 * i, 16 + 2 * i, 11 + 2 * i, 15 + 2 * i));
    const row = model({ length: 100, basesPerRow: 100, enzymes: sites }).rows[0];
    expect(row.enzymeLabels).toHaveLength(8);
    const byLane = new Map<number, Array<[number, number]>>();
    for (const l of row.enzymeLabels) byLane.set(l.lane, [...(byLane.get(l.lane) ?? []), [l.x, l.x + l.width]]);
    for (const spans of byLane.values()) {
      spans.sort((a, b) => a[0] - b[0]);
      for (let i = 1; i < spans.length; i++) expect(spans[i][0]).toBeGreaterThan(spans[i - 1][1]);
    }
    expect(row.enzymeLanes).toBeGreaterThan(1);
  });
});

describe('primers and ORFs', () => {
  const primerSite = (primerId: string, start: number, end: number, strand: 1 | -1): PrimerBindingSite => ({
    primerId,
    strand,
    range: { start, end },
    annealedLength: end - start,
    mismatches: 0,
    tailLength: 0,
  });

  it('draws forward primers above the top strand and reverse primers below the bottom strand', () => {
    const mdl = model({
      length: 200,
      basesPerRow: 100,
      primers: [
        { site: primerSite('f', 20, 40, 1), name: 'Fwd' },
        { site: primerSite('r', 60, 80, -1), name: 'Rev' },
      ],
    });
    const row = mdl.rows[0];
    expect(row.primerLanesFwd).toBe(1);
    expect(row.primerLanesRev).toBe(1);
    expect(row.y.primersFwd).toBeLessThan(row.y.strand);
    expect(row.y.primersRev).toBeGreaterThan(row.y.complement);
    const [f, r] = row.primers;
    expect(f).toMatchObject({ strand: 1, tip: true, fivePrime: true });
    expect(r).toMatchObject({ strand: -1, tip: true, fivePrime: true });
    // names at the 5′ end: left of a forward primer, right of a reverse one
    expect(f.label!.x + f.label!.width).toBeLessThan(colLeft(mdl.geometry, 20));
    expect(r.label!.x).toBeGreaterThan(colRight(mdl.geometry, 79));
  });

  it('draws a 5′ tail beside the annealed 5′ end, its length when the bases do not fit (review: tail)', () => {
    const tailed = (start: number, end: number, strand: 1 | -1, tailLength: number) => ({
      site: { ...primerSite('t', start, end, strand), tailLength },
      name: 'Tailed',
    });
    // forward: the tail's 10 bases left of the 5' end, the name left of the tail
    const fwd = model({ length: 200, basesPerRow: 100, primers: [tailed(40, 60, 1, 10)] });
    const f = fwd.rows[0].primers[0];
    const geo = fwd.geometry;
    expect(f.tail).toMatchObject({ text: '' });
    expect(f.tail!.width).toBeCloseTo(10 * geo.charWidth + 4);
    expect(f.tail!.x + f.tail!.width).toBeCloseTo(colLeft(geo, 40) - M.primerTailGap);
    expect(f.label!.x + f.label!.width).toBeLessThan(f.tail!.x);
    // reverse: the tail continues right of the 5' end
    const rev = model({ length: 200, basesPerRow: 100, primers: [tailed(40, 60, -1, 8)] });
    const r = rev.rows[0].primers[0];
    expect(r.tail!.x).toBeCloseTo(colRight(geo, 59) + M.primerTailGap);
    expect(r.label!.x).toBeGreaterThan(r.tail!.x + r.tail!.width);
    // a long tail near the start of the row: only its length; at the very start: nothing
    const near = model({ length: 200, basesPerRow: 100, primers: [tailed(6, 30, 1, 24)] }).rows[0].primers[0];
    expect(near.tail).toMatchObject({ text: '+24 nt' });
    expect(near.tail!.x).toBeGreaterThanOrEqual(geo.textLeft - 8);
    const atStart = model({ length: 200, basesPerRow: 100, primers: [tailed(0, 20, 1, 24)] }).rows[0].primers[0];
    expect(atStart.tail).toBeNull();
    // only the piece holding the annealed 5' end carries the tail
    const split = model({ length: 200, basesPerRow: 50, primers: [tailed(40, 60, 1, 10)] });
    expect(split.rows[1].primers[0].tail).toBeNull();
  });

  it('splits a primer across rows: the arrow tip only on its 3′ piece', () => {
    const mdl = model({ length: 200, basesPerRow: 50, primers: [{ site: primerSite('f', 40, 60, 1), name: 'F' }] });
    expect(mdl.rows[0].primers[0]).toMatchObject({ startCol: 40, endCol: 50, tip: false, openEnd: true, fivePrime: true });
    expect(mdl.rows[1].primers[0]).toMatchObject({ startCol: 0, endCol: 10, tip: true, openStart: true, fivePrime: false });
  });

  it('lays out ORFs in lanes below the features', () => {
    const orfs: Orf[] = [
      { range: { start: 0, end: 90 }, strand: 1, frame: 0, aaLength: 29, hasStop: true },
      { range: { start: 30, end: 120 }, strand: -1, frame: 1, aaLength: 29, hasStop: true },
    ];
    const row = model({ length: 150, basesPerRow: 150, orfs, features: [lf(feature('a', 0, 10))] }).rows[0];
    expect(row.orfLanes).toBe(2);
    expect(row.y.orfs).toBeGreaterThan(row.y.features);
    expect(row.orfs.map((o) => [o.orf, o.lane, o.tip])).toEqual([
      [0, 0, true],
      [1, 1, true],
    ]);
  });
});

describe('hit testing', () => {
  const mdl = model({ length: 250, basesPerRow: 60, features: [lf(feature('a', 70, 130))], enzymes: [site('E', 10, 16, 11, 15)] });
  const geo = mdl.geometry;

  it('maps a point on a base to the nearest gap', () => {
    const y = strandY(mdl, 1);
    expect(gapAtPoint(mdl, colLeft(geo, 3) + 0.2 * geo.charWidth, y)).toEqual({ row: 1, gap: 63, upstream: false });
    expect(gapAtPoint(mdl, colLeft(geo, 3) + 0.8 * geo.charWidth, y)).toEqual({ row: 1, gap: 64, upstream: false });
    // anywhere inside a row's vertical extent counts (feature lanes, enzyme labels)
    expect(gapAtPoint(mdl, colLeft(geo, 3) + 0.2 * geo.charWidth, mdl.offsets[1] + 2).gap).toBe(63);
    expect(gapAtPoint(mdl, colLeft(geo, 3) + 0.2 * geo.charWidth, mdl.offsets[2] - 1).gap).toBe(63);
  });

  it('reports the end of a row as upstream (drawn at the end of that row)', () => {
    expect(gapAtPoint(mdl, geo.width + 100, strandY(mdl, 0))).toEqual({ row: 0, gap: 60, upstream: true });
    expect(gapAtPoint(mdl, 0, strandY(mdl, 1))).toEqual({ row: 1, gap: 60, upstream: false });
    // the end of the sequence is not "upstream" of anything
    expect(gapAtPoint(mdl, geo.width + 100, strandY(mdl, 4))).toEqual({ row: 4, gap: 250, upstream: false });
  });

  it('clamps points above the first row and below the last row', () => {
    expect(gapAtPoint(mdl, 300, -20).gap).toBe(0);
    expect(gapAtPoint(mdl, 0, mdl.totalHeight + 50).gap).toBe(250);
  });

  it('finds the row at a y offset with a binary search', () => {
    for (let r = 0; r < mdl.rowCount; r++) {
      expect(rowAtY(mdl, mdl.offsets[r])).toBe(r);
      expect(rowAtY(mdl, mdl.offsets[r + 1] - 0.01)).toBe(r);
    }
    expect(rowAtY(mdl, -5)).toBe(0);
    expect(rowAtY(mdl, mdl.totalHeight + 5)).toBe(mdl.rowCount - 1);
  });

  it('finds the base under a point and the band of the row', () => {
    expect(baseAtPoint(mdl, colCenter(geo, 7), strandY(mdl, 2))).toBe(127);
    expect(bandAtY(mdl, strandY(mdl, 2))).toBe('strand');
    expect(bandAtY(mdl, strandY(mdl, 2) + M.strandHeight)).toBe('complement');
    expect(bandAtY(mdl, mdl.offsets[1] + mdl.rows[1].y.features + 2)).toBe('features');
    expect(bandAtY(mdl, mdl.offsets[0] + mdl.rows[0].y.enzymes + 2)).toBe('enzymes');
  });

  it('places carets on row boundaries with their affinity', () => {
    expect(rowOfGap(mdl, 60)).toBe(1);
    expect(rowOfGap(mdl, 60, true)).toBe(0);
    expect(rowOfGap(mdl, 0, true)).toBe(0);
    expect(rowOfGap(mdl, 250)).toBe(4);
    expect(rowOfBase(mdl, 59)).toBe(0);
    expect(rowOfBase(mdl, 60)).toBe(1);
  });
});

describe('ranges in rows', () => {
  it('cuts a range into the columns of each row, wrapping ranges in two pieces', () => {
    expect(rangeColsInRow({ start: 50, end: 130 }, 60, 120, 250, 'linear')).toEqual([[0, 60]]);
    expect(rangeColsInRow({ start: 50, end: 70 }, 60, 120, 250, 'linear')).toEqual([[0, 10]]);
    expect(rangeColsInRow({ start: 240, end: 260 }, 0, 60, 250, 'circular')).toEqual([[0, 10]]);
    expect(rangeColsInRow({ start: 240, end: 260 }, 180, 250, 250, 'circular')).toEqual([[60, 70]]);
    // a short circular sequence on a single row: both pieces of the wrap
    expect(rangeColsInRow({ start: 45, end: 55 }, 0, 50, 50, 'circular')).toEqual([
      [45, 50],
      [0, 5],
    ]);
  });

  it('buckets ranges by the rows they touch', () => {
    const hits = [{ range: { start: 5, end: 15 } }, { range: { start: 95, end: 105 } }, { range: { start: 195, end: 205 } }];
    const buckets = bucketRangesByRow(hits, 50, 200, 'circular');
    expect([...buckets.keys()].sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
    expect(buckets.get(0)).toEqual([hits[0], hits[2]]);
    expect(buckets.get(1)).toEqual([hits[1]]);
    expect(buckets.get(3)).toEqual([hits[2]]);
  });
});

describe('large records', () => {
  it('builds the model of a 2 Mb record with thousands of features', () => {
    const L = 2_000_000;
    const features: LayoutFeature[] = [];
    for (let i = 0; i < 2000; i++) {
      const start = i * 997;
      features.push(lf(feature(`f${i}`, start, start + 600 + (i % 7) * 50, i % 2 ? 1 : -1), i % 3 === 0));
    }
    const enzymes = Array.from({ length: 500 }, (_, i) => site(i % 2 ? 'EcoRI' : 'BamHI', i * 3989, i * 3989 + 6, i * 3989 + 1, i * 3989 + 5));
    const mdl = buildRowModel({ length: L, topology: 'circular', basesPerRow: 120, numberColumnWidth: 60, features, enzymes });
    expect(mdl.rowCount).toBe(Math.ceil(L / 120));
    expect(mdl.offsets).toHaveLength(mdl.rowCount + 1);
    let featureRows = 0;
    for (let r = 0; r < mdl.rowCount; r++) {
      const row = mdl.rows[r];
      expect(mdl.offsets[r + 1]).toBeGreaterThan(mdl.offsets[r]);
      for (const p of row.features) expect(p.lane).toBeLessThan(row.featureLanes.length);
      if (row.features.length) featureRows++;
    }
    expect(featureRows).toBeGreaterThan(5000);
  });
});
