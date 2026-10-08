import type { SeqRecord } from '@hhereditas/core';
import { describe, expect, it } from 'vitest';
import { SAMPLES } from '../fixtures';
import { buildCutMarkers } from './enzymeLabels';
import { demoOrfs, demoPrimers, syntheticGenome } from './galleryData';
import { featureEntryIndex, featureOutline, hitTest, positionsAt } from './hitTest';
import type { FeatureEntry, TextBox, TrackSet, ViewInput, ViewModel } from './layout';
import {
  CUT_OVERSHOOT,
  MAX_LABELLED_CUTS,
  METRICS,
  MIN_BAR_PX,
  buildFeatureTrack,
  buildOrfTrack,
  buildPrimerTrack,
  computeVerticalLayout,
  computeView,
  contentOffsetY,
  enzymeRowsToReserve,
  featureBarTop,
  strandExtents,
  strandGapFor,
} from './layout';
import { estimateTextWidth } from './textMeasure';
import { LETTER_PX_PER_BASE, clampViewport, fullViewport, makeScale } from './viewport';

const WIDTH = 1320;
const plotLeft = METRICS.padX;
const plotWidth = WIDTH - 2 * METRICS.padX;

interface Setup {
  input: ViewInput;
  view: ViewModel;
  features: TrackSet<FeatureEntry> | null;
}

/** The view model the component would compute for a record and window. */
function setup(
  record: SeqRecord,
  opts: {
    viewport?: { start: number; end: number };
    width?: number;
    enzymes?: boolean;
    primers?: Parameters<typeof buildPrimerTrack>[0];
    orfs?: Parameters<typeof buildOrfTrack>[0];
    enzymeSites?: Parameters<typeof buildCutMarkers>[0];
  } = {},
): Setup {
  const width = opts.width ?? WIDTH;
  const pw = width - 2 * METRICS.padX;
  const L = record.seq.length;
  const vp = clampViewport(opts.viewport ?? fullViewport(L), L, pw);
  const scale = makeScale(vp, METRICS.padX, pw);
  const features = record.features.length ? buildFeatureTrack(record.features, L, record.topology) : null;
  const markers = opts.enzymeSites?.length ? buildCutMarkers(opts.enzymeSites, L, record.topology) : null;
  const input: ViewInput = {
    record,
    width,
    scale,
    features,
    orfs: opts.orfs?.length ? buildOrfTrack(opts.orfs, L, record.topology) : null,
    primers: opts.primers?.length ? buildPrimerTrack(opts.primers, record.primers, L, record.topology) : null,
    markers,
    enzymeRows: markers ? enzymeRowsToReserve(markers, L, METRICS.padX, pw, width, estimateTextWidth) : 0,
    measure: estimateTextWidth,
  };
  return { input, view: computeView(input), features };
}

/** Bars as drawn (tiny ones widened), with their vertical extent. */
function barBoxes(view: ViewModel, set: TrackSet<FeatureEntry>): TextBox[] {
  const boxes: TextBox[] = [];
  for (const side of ['above', 'below'] as const) {
    set[side].forEach((lane, k) => {
      const top = featureBarTop(view.v, side, k);
      for (const it of lane.items) {
        if (it.end <= view.bpFrom || it.start >= view.bpTo) continue;
        let x0 = view.scale.x(it.start);
        let x1 = view.scale.x(it.end);
        if (x1 - x0 < MIN_BAR_PX) [x0, x1] = [(x0 + x1) / 2 - MIN_BAR_PX / 2, (x0 + x1) / 2 + MIN_BAR_PX / 2];
        boxes.push({ key: `${it.ref}`, text: '', x: x0, y: top, anchor: 'start', left: x0, right: x1, top, bottom: top + METRICS.featureBarHeight });
      }
    });
  }
  return boxes;
}

const overlap = (a: TextBox, b: TextBox, eps = 0.25) =>
  a.left < b.right - eps && b.left < a.right - eps && a.top < b.bottom - eps && b.top < a.bottom - eps;

function allLabels(view: ViewModel): TextBox[] {
  return [...view.features.labels, ...view.primers.labels, ...view.enzymes.labels, ...view.ticks.labels];
}

function expectNoLabelOverlaps(s: Setup): void {
  const labels = allLabels(s.view);
  for (let i = 0; i < labels.length; i++) {
    for (let j = i + 1; j < labels.length; j++) {
      if (overlap(labels[i], labels[j])) throw new Error(`labels overlap: "${labels[i].text}" and "${labels[j].text}"`);
    }
  }
  if (!s.features) return;
  const bars = barBoxes(s.view, s.features);
  for (const l of s.view.features.labels) {
    if (l.placement === 'inside') continue;
    for (const b of bars) {
      if (overlap(l, b)) throw new Error(`label "${l.text}" covers a bar`);
    }
  }
  for (const l of labels) {
    expect(l.left).toBeGreaterThanOrEqual(0);
    expect(l.right).toBeLessThanOrEqual(s.view.width);
  }
}

describe('computeVerticalLayout', () => {
  it('stacks enzymes, overlays, features, backbone and ruler from the top', () => {
    const v = computeVerticalLayout({
      enzymeRows: 3,
      features: { above: 2, below: 1 },
      orfs: { above: 1, below: 1 },
      primers: { above: 1, below: 2 },
      strandGap: 4,
    });
    expect(v.enzymeBottom - v.enzymeTop).toBe(3 * METRICS.enzymeRowHeight);
    expect(v.primers.above[0]).toBeGreaterThan(v.enzymeBottom);
    expect(v.orfs.above[0]).toBeGreaterThan(v.primers.above[0]);
    // the free label band sits between the overlays and the outermost feature lane
    expect(v.features.above[1] - (v.orfs.above[0] + METRICS.orfLaneHeight)).toBeGreaterThanOrEqual(METRICS.featureLabelBand);
    // lane 0 is nearest the backbone on both sides
    expect(v.features.above[0]).toBeGreaterThan(v.features.above[1]);
    expect(v.topStrandY).toBeGreaterThan(v.features.above[0] + METRICS.featureLaneHeight);
    expect(v.bottomStrandY - v.topStrandY).toBe(4);
    expect(v.features.below[0]).toBeGreaterThanOrEqual(v.rulerBottom);
    expect(v.orfs.below[0]).toBeGreaterThanOrEqual(v.features.below[0] + METRICS.featureLaneHeight + METRICS.featureLabelBand);
    expect(v.primers.below[1]).toBeGreaterThan(v.primers.below[0]);
    expect(v.height).toBeGreaterThan(v.primers.below[1] + METRICS.primerLaneHeight);
    // the selection band covers everything except the enzyme labels
    expect(v.bodyTop).toBeLessThan(v.primers.above[0]);
    expect(v.bodyTop).toBeGreaterThan(v.enzymeBottom - 4);
    expect(v.bodyBottom).toBeGreaterThan(v.primers.below[1]);
  });

  it('opens the strands smoothly to make room for letters', () => {
    expect(strandGapFor(1)).toBe(METRICS.strandGap);
    expect(strandGapFor(LETTER_PX_PER_BASE)).toBe(METRICS.letterBand);
    expect(strandGapFor(6.5)).toBeGreaterThan(METRICS.strandGap);
    expect(strandGapFor(6.5)).toBeLessThan(METRICS.letterBand);
  });
});

describe('contentOffsetY', () => {
  it('centres the map a little above the middle, never above the top', () => {
    expect(contentOffsetY(600, 200)).toBe(184);
    expect(contentOffsetY(200, 600)).toBe(0);
  });
});

describe('strandExtents', () => {
  it('shortens the strand that a single-stranded end leaves out', () => {
    const rec = { ...SAMPLES.linear.record, seq: 'A'.repeat(100), ends: { left: { kind: '5prime', length: 4 }, right: { kind: '3prime', length: 2 } } } as SeqRecord;
    expect(strandExtents(rec)).toEqual({ top: [0, 100], bottom: [4, 98] });
  });
});

describe('computeView: plasmids and fragments', () => {
  it('places labels without overlaps at every sample and zoom', () => {
    for (const name of ['pFA6a', 'pBAD30', 'pBR322', 'linear'] as const) {
      const { record, enzymeSites } = SAMPLES[name];
      const L = record.seq.length;
      for (const [width, vp] of [
        [WIDTH, fullViewport(L)],
        [900, fullViewport(L)],
        [WIDTH, { start: L * 0.2, end: L * 0.45 }],
        [WIDTH, { start: L * 0.5, end: L * 0.5 + 60 }],
      ] as const) {
        const s = setup(record, { width, viewport: vp, enzymeSites });
        expectNoLabelOverlaps(s);
      }
    }
  });

  it('places primer labels without overlaps', () => {
    const { record, primerSites } = demoPrimers(SAMPLES.linear.record, [
      { name: 'CMV-F', start: 300, end: 320, strand: 1 },
      { name: 'DsRed-fwd', start: 330, end: 352, strand: 1, tail: 'GCGGAATTC' },
      { name: 'DsRed-rev', start: 1180, end: 1201, strand: -1, tail: 'CCGCTCGAG' },
      { name: 'WPRE-R', start: 2812, end: 2833, strand: -1 },
    ]);
    const s = setup(record, { primers: primerSites, orfs: demoOrfs(record.seq, 100), enzymeSites: SAMPLES.linear.enzymeSites });
    expect(s.view.primers.glyphs.length).toBe(4);
    expect(s.view.primers.labels.length).toBeGreaterThan(0);
    expectNoLabelOverlaps(s);
    expect(s.view.orfs.glyphs.length + (s.view.orfs.small ? 1 : 0)).toBeGreaterThan(0);
  });

  it('puts a label inside a bar when it fits, else beside or outside it', () => {
    const { view, features } = setup(SAMPLES.pFA6a.record);
    const byName = (n: string) => view.features.labels.find((l) => features!.entries[l.entry].feature.name === n);
    expect(byName('KanR')?.placement).toBe('inside');
    expect(byName('TEF terminator')?.placement).not.toBe('inside');
  });

  it('keeps tiny features visible as slim solid bars in their own colour', () => {
    const { view } = setup(SAMPLES.pBR322.record);
    // pBR322 has 4-6 bp binding sites: far below a pixel at this zoom, yet drawn solid
    expect(view.features.small.some((p) => p.fill.includes('protein-bind') && p.opacity === 1)).toBe(true);
  });

  it('draws a feature that wraps the origin at both ends but labels it once', () => {
    const rec = SAMPLES.pFA6a.record;
    const { view, features } = setup(rec, { viewport: { start: 0, end: 3938 } });
    const idx = featureEntryIndex(features, rec.features.find((f) => f.name === 'SP6 promoter')!.id);
    const entry = features!.entries[idx];
    expect(entry.extent.end).toBeGreaterThan(rec.seq.length);
    expect(view.features.labels.filter((l) => l.entry === idx).length).toBeLessThanOrEqual(1);
    // the outline (hover ring) has a piece at each end of the map
    const d = featureOutline(view, features!, idx);
    expect(d.match(/M/g)?.length).toBe(2);
  });

  it('draws base letters (both strands) only from LETTER_PX_PER_BASE', () => {
    const rec = SAMPLES.pFA6a.record;
    const at = (span: number) => setup(rec, { viewport: { start: 100, end: 100 + span } }).view;
    const zoomed = at(plotWidth / 12);
    expect(zoomed.letters).not.toBeNull();
    const first = Math.floor(zoomed.scale.bp(0)) - 1;
    expect(zoomed.letters!.top!.text).toBe(rec.seq.slice(Math.max(0, first), Math.max(0, first) + zoomed.letters!.top!.text.length));
    expect(zoomed.letters!.bottom!.text.length).toBe(zoomed.letters!.top!.text.length);
    // only the visible bases (plus one either side) are drawn
    expect(zoomed.letters!.top!.text.length).toBeLessThanOrEqual(Math.ceil(WIDTH / 12) + 3);
    expect(at(plotWidth / 5).letters).toBeNull();
  });

  it('draws staggered cuts between the strands at letter zoom', () => {
    const { record, enzymeSites } = SAMPLES.pFA6a;
    const s = setup(record, { viewport: { start: 22, end: 86 }, enzymeSites });
    expect(s.view.enzymes.staggered).not.toBe('');
    expect(s.view.enzymes.labels.some((l) => l.text.startsWith('BamHI'))).toBe(true);
  });

  it('labels unique cutters in bold rows above the map with leaders down to the backbone', () => {
    const { record, enzymeSites } = SAMPLES.pFA6a;
    const s = setup(record, { enzymeSites });
    const labels = s.view.enzymes.labels;
    expect(labels.length).toBeGreaterThan(10);
    for (const l of labels) {
      expect(l.bottom).toBeLessThanOrEqual(s.view.v.enzymeBottom);
      expect(l.leader).toMatch(new RegExp(`V${Math.round((s.view.v.topStrandY - CUT_OVERSHOOT) * 100) / 100}$`));
    }
    const ecoRV = labels.find((l) => l.text.startsWith('EcoRV'));
    expect(ecoRV?.unique).toBe(true);
  });
});

describe('computeView: a 4.6 Mb genome with ~4,500 features', () => {
  const genome = syntheticGenome();
  const L = genome.record.seq.length;

  it('has the expected size', () => {
    expect(L).toBe(4_641_652);
    expect(genome.record.features.length).toBeGreaterThan(4000);
  });

  it('draws density instead of thousands of glyphs at whole-genome zoom', () => {
    const s = setup(genome.record, { enzymeSites: genome.enzymeSites });
    expect(s.view.features.glyphs.length).toBe(0);
    expect(s.view.features.density.length).toBeGreaterThan(0);
    // density takes the colour of the dominant feature type (CDS here)
    expect(s.view.features.density.some((p) => p.fill.includes('feature-cds'))).toBe(true);
    // no labels for a random sample of thousands of tiny genes
    expect(s.view.features.labels.length).toBe(0);
    const paths = s.view.features.density.length + s.view.features.small.length;
    expect(paths).toBeLessThan(80);
    expectNoLabelOverlaps(s);
  });

  it('culls to the viewport when zoomed in', () => {
    const vp = { start: 1_200_000, end: 1_260_000 };
    const s = setup(genome.record, { viewport: vp, enzymeSites: genome.enzymeSites });
    const visible = genome.record.features.filter((f) => f.segments.some((g) => g.end > vp.start - 3000 && g.start < vp.end + 3000));
    expect(s.view.features.glyphs.length).toBeGreaterThan(20);
    expect(s.view.features.glyphs.length).toBeLessThanOrEqual(visible.length * 2);
    expect(s.view.features.labels.length).toBeGreaterThan(10);
    expectNoLabelOverlaps(s);
  });

  it('labels only unique cutters when thousands of cuts are in view, and stays fast', () => {
    const sites = [...genome.enzymeSites];
    for (let i = 0; i < 10_000; i++) {
      const s = Math.floor(((i * 7919) % 10_007) * (L / 10_007));
      sites.push({ enzyme: ['AluI', 'HaeIII', 'MspI', 'TaqI'][i % 4], range: { start: s, end: s + 4 }, strand: 1, cuts: [{ top: s + 2, bottom: s + 2 }] });
    }
    const s = setup(genome.record, { enzymeSites: sites });
    expect(s.view.enzymes.visible.length).toBeGreaterThan(MAX_LABELLED_CUTS);
    expect(s.view.enzymes.labels.length).toBeGreaterThan(0);
    expect(s.view.enzymes.labels.every((l) => l.unique)).toBe(true);
    // the cut marks are merged per pixel: the path stays small
    expect(s.view.enzymes.ticksUnlabelled.split('M').length).toBeLessThan(2 * WIDTH + 2);
    const t0 = performance.now();
    for (let i = 0; i < 5; i++) computeView(s.input);
    expect((performance.now() - t0) / 5).toBeLessThan(40);
    // zoomed in, the common cutters are labelled again
    const z = setup(genome.record, { enzymeSites: sites, viewport: { start: 2_000_000, end: 2_060_000 } });
    expect(z.view.enzymes.labels.some((l) => !l.unique)).toBe(true);
    expectNoLabelOverlaps(z);
  });

  it('stays within a frame budget', () => {
    const viewports = [fullViewport(L), { start: 1_000_000, end: 2_000_000 }, { start: 1_200_000, end: 1_260_000 }, { start: 2_000_000, end: 2_000_100 }];
    const base = setup(genome.record, { enzymeSites: genome.enzymeSites }).input;
    for (const vp of viewports) {
      const scale = makeScale(clampViewport(vp, L, plotWidth), plotLeft, plotWidth);
      computeView({ ...base, scale }); // warm-up
      const t0 = performance.now();
      const runs = 5;
      for (let i = 0; i < runs; i++) computeView({ ...base, scale });
      const ms = (performance.now() - t0) / runs;
      // a 60 fps frame is 16 ms; leave room for slow CI machines
      expect(ms).toBeLessThan(40);
    }
  });
});

describe('hitTest', () => {
  const { record, enzymeSites } = SAMPLES.pFA6a;
  const s = setup(record, { enzymeSites });
  const input = { view: s.view, features: s.features, orfs: null, primers: null, markers: s.input.markers };

  it('finds the feature under a bar', () => {
    const idx = featureEntryIndex(s.features, record.features.find((f) => f.name === 'KanR')!.id);
    const e = s.features!.entries[idx];
    const x = s.view.scale.x((e.extent.start + e.extent.end) / 2);
    const y = featureBarTop(s.view.v, e.side, e.lane) + METRICS.featureBarHeight / 2;
    expect(hitTest(input, x, y)).toEqual({ kind: 'feature', id: e.feature.id });
  });

  it('finds an enzyme by its label', () => {
    const l = s.view.enzymes.labels[0];
    const t = hitTest(input, (l.left + l.right) / 2, (l.top + l.bottom) / 2);
    expect(t.kind).toBe('enzyme');
    if (t.kind === 'enzyme') expect(t.site).toBe(s.input.markers![l.marker].site);
  });

  it('reports the base under the backbone and the gap in empty space', () => {
    const x = s.view.scale.x(1000.5);
    expect(hitTest(input, x + 0.01, s.view.v.bottomStrandY + 12)).toEqual({ kind: 'sequence', position: 1000 });
    const t = hitTest(input, s.view.scale.x(2000), s.view.height - 2);
    expect(t).toEqual({ kind: 'background', position: 2000 });
  });

  it('maps x to bases and gaps', () => {
    const scale = makeScale({ start: 0, end: 100 }, 0, 1000);
    expect(positionsAt(scale, 55, 100)).toEqual({ base: 5, gap: 6 });
    expect(positionsAt(scale, -50, 100)).toEqual({ base: 0, gap: 0 });
    expect(positionsAt(scale, 5000, 100)).toEqual({ base: 99, gap: 100 });
  });
});
