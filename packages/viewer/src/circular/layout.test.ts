import type { EnzymeSite, Feature, Orf, PrimerBindingSite, Range, SeqRecord } from '@hhereditas/core';
import { mod, rangesOverlap } from '@hhereditas/core';
import { describe, expect, it } from 'vitest';
import { SAMPLES, type SampleName } from '../fixtures';
import { arcLength, cartesianToPolar, distanceToSegment, positionToAngle } from './geometry';
import {
  type LabelPlacement,
  type MapGeometry,
  assignLanes,
  assignSides,
  buildMapModel,
  computeGeometry,
  cutLabelPosition,
  featurePieces,
  labelsOverlap,
  placeLabels,
  spreadPositions,
} from './layout';
import { estimateTextWidth } from './measure';

const measure = estimateTextWidth;

function rec(seqLength: number, features: Feature[], extra: Partial<SeqRecord> = {}): SeqRecord {
  return {
    id: 'r',
    name: 'test',
    description: '',
    seq: 'A'.repeat(seqLength),
    topology: 'circular',
    molecule: 'DNA',
    features,
    primers: [],
    meta: {},
    ...extra,
  };
}

function feat(id: string, start: number, end: number, strand: 1 | -1 | 0 = 1, name = id, type = 'CDS'): Feature {
  return { id, type, name, strand, segments: [{ start, end }], qualifiers: [] };
}

function site(enzyme: string, cut: number, len = 6): EnzymeSite {
  return { enzyme, range: { start: cut - 1, end: cut - 1 + len }, strand: 1, cuts: [{ top: cut, bottom: cut + 4 }] };
}

/** Deterministic PRNG (mulberry32). */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Lanes
// ---------------------------------------------------------------------------

describe('assignLanes', () => {
  it('keeps disjoint ranges on lane 0 and stacks overlapping ones', () => {
    const lanes = assignLanes(
      [
        { start: 0, end: 100 },
        { start: 100, end: 200 }, // abuts: same lane
        { start: 50, end: 150 },
        { start: 60, end: 70 },
      ],
      1000,
      'circular',
    );
    expect(lanes).toEqual([0, 0, 1, 2]);
  });

  it('puts the longest range on the innermost-free lane (longest first)', () => {
    const lanes = assignLanes(
      [
        { start: 10, end: 20 },
        { start: 0, end: 500 },
      ],
      1000,
      'circular',
    );
    expect(lanes).toEqual([1, 0]);
  });

  it('handles ranges that wrap the origin (end > length) on circular molecules', () => {
    const L = 1000;
    const lanes = assignLanes(
      [
        { start: 900, end: 1100 }, // wraps: covers 900..999 and 0..99
        { start: 50, end: 80 }, // overlaps the wrapped tail
        { start: 950, end: 990 }, // overlaps the head
        { start: 300, end: 400 }, // free
      ],
      L,
      'circular',
    );
    expect(lanes[0]).toBe(0);
    expect(lanes[1]).toBe(1);
    expect(lanes[2]).toBe(1);
    expect(lanes[3]).toBe(0);
  });

  it('does not wrap on linear molecules', () => {
    const lanes = assignLanes(
      [
        { start: 0, end: 100 },
        { start: 900, end: 1000 },
      ],
      1000,
      'linear',
    );
    expect(lanes).toEqual([0, 0]);
  });

  it('never puts two overlapping ranges on the same lane (random circular records)', () => {
    const rand = rng(42);
    for (let trial = 0; trial < 40; trial++) {
      const L = 500 + Math.floor(rand() * 9000);
      const ranges: Range[] = Array.from({ length: 5 + Math.floor(rand() * 60) }, () => {
        const start = Math.floor(rand() * L);
        const len = rand() < 0.1 ? 0 : 1 + Math.floor(rand() * L * (rand() < 0.2 ? 0.8 : 0.1));
        return { start, end: start + len }; // may wrap (end > L)
      });
      const lanes = assignLanes(ranges, L, 'circular');
      const asBases = (r: Range) => (r.end > r.start ? r : { start: r.start, end: r.start + 1 });
      for (let i = 0; i < ranges.length; i++) {
        for (let j = i + 1; j < ranges.length; j++) {
          if (lanes[i] !== lanes[j]) continue;
          expect(rangesOverlap(asBases(ranges[i]), asBases(ranges[j]), L, 'circular')).toBe(false);
        }
      }
      // lanes are compact: every lane below the maximum is used
      const used = new Set(lanes);
      for (let k = 0; k < used.size; k++) expect(used.has(k)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

describe('buildMapModel', () => {
  it('labels enzymes with the 1-based position of the top-strand cut and finds unique cutters', () => {
    const L = 3000;
    const sites: EnzymeSite[] = [
      site('EcoRI', 396),
      site('BamHI', 1200),
      site('BamHI', 2400),
      { enzyme: 'NotI', range: { start: 2995, end: 3003 }, strand: 1, cuts: [{ top: 0, bottom: 4 }] }, // cut at the origin
      { enzyme: 'BaeI', range: { start: 100, end: 120 }, strand: 1, cuts: [{ top: 90, bottom: 95 }, { top: 130, bottom: 125 }] },
      { enzyme: 'Uncut', range: { start: 41, end: 47 }, strand: -1, cuts: [] },
    ];
    const m = buildMapModel({ record: rec(L, []), enzymeSites: sites });
    const byName = (n: string) => m.enzymes.filter((e) => e.site.enzyme === n);
    expect(byName('EcoRI')[0].label).toBe('EcoRI (396)');
    expect(byName('EcoRI')[0].unique).toBe(true);
    expect(byName('BamHI').map((e) => e.unique)).toEqual([false, false]);
    expect(byName('BamHI')[1].label).toBe('BamHI (2,400)');
    expect(byName('NotI')[0].label).toBe('NotI (3,000)');
    expect(byName('NotI')[0].unique).toBe(true);
    // two cleavage events in one site: not a unique cutter
    expect(byName('BaeI')[0].unique).toBe(false);
    expect(byName('BaeI')[0].cuts).toEqual([90, 130]);
    expect(byName('Uncut')[0].label).toBe('Uncut (42)');
    expect(byName('Uncut')[0].cutCount).toBe(0);
  });

  it('matches the cut label convention of the other views', () => {
    expect(cutLabelPosition(396, 3000, 'circular')).toBe(396);
    expect(cutLabelPosition(0, 3000, 'circular')).toBe(3000);
    expect(cutLabelPosition(0, 3000, 'linear')).toBe(0);
  });

  it('keeps origin-spanning extents normalized with end > length', () => {
    const m = buildMapModel({ record: SAMPLES.pFA6a.record });
    const sp6 = m.features.find((f) => f.feature.name === 'SP6 promoter');
    expect(sp6?.extent).toEqual({ start: 3921, end: 3940 });
    expect(m.length).toBe(3938);
  });

  it('names primers from record.primers and honours layer switches', () => {
    const record = rec(2000, [feat('a', 0, 100)], { primers: [{ id: 'p1', name: 'M13-F', sequence: 'GTAAAACGACGGCCAGT' }] });
    const primerSites: PrimerBindingSite[] = [
      { primerId: 'p1', strand: 1, range: { start: 10, end: 27 }, annealedLength: 17, mismatches: 0, tailLength: 0 },
      { primerId: 'missing', strand: -1, range: { start: 1990, end: 2010 }, annealedLength: 20, mismatches: 0, tailLength: 0 },
    ];
    const m = buildMapModel({ record, primerSites });
    expect(m.primers.map((p) => p.name)).toEqual(['M13-F', 'Primer']);
    const off = buildMapModel({
      record,
      primerSites,
      enzymeSites: [site('EcoRI', 50)],
      orfs: [{ range: { start: 0, end: 300 }, strand: 1, frame: 0, aaLength: 99, hasStop: true }],
      layers: { features: false, enzymes: false, primers: false, orfs: false },
    });
    expect([off.features.length, off.enzymes.length, off.primers.length, off.orfs.length]).toEqual([0, 0, 0, 0]);
  });
});

// ---------------------------------------------------------------------------
// Label layout
// ---------------------------------------------------------------------------

function geometryFor(
  record: SeqRecord,
  width: number,
  height: number,
  extra: { enzymeSites?: readonly EnzymeSite[]; primerSites?: readonly PrimerBindingSite[]; orfs?: readonly Orf[]; rotation?: number } = {},
): MapGeometry {
  const model = buildMapModel({ record, ...extra });
  const g = computeGeometry(model, { width, height, rotation: extra.rotation ?? 0, measure });
  if (!g) throw new Error('no geometry');
  return g;
}

/** Closest distance from the map centre to a label box. */
function boxDistance(g: MapGeometry, b: { x0: number; y0: number; x1: number; y1: number }): number {
  const x = Math.min(Math.max(g.cx, b.x0), b.x1);
  const y = Math.min(Math.max(g.cy, b.y0), b.y1);
  return Math.hypot(x - g.cx, y - g.cy);
}

/** Every invariant the outside label layout promises. */
function expectCleanLabels(g: MapGeometry, p: LabelPlacement) {
  expect(labelsOverlap(p.labels)).toBe(false);
  for (const l of p.labels) {
    const b = l.box;
    // inside the view
    expect(b.x0).toBeGreaterThanOrEqual(-0.01);
    expect(b.y0).toBeGreaterThanOrEqual(-0.01);
    expect(b.x1).toBeLessThanOrEqual(g.width + 0.01);
    expect(b.y1).toBeLessThanOrEqual(g.height + 0.01);
    // never on top of the ring
    expect(boxDistance(g, b)).toBeGreaterThanOrEqual(g.ringOuter);
    // the leader's last (straight) segment stays outside the ring
    const nums = l.leader.match(/-?\d+(\.\d+)?/g)!.map(Number);
    expect(nums).toHaveLength(6);
    const [, , ex, ey, lx, ly] = nums;
    expect(distanceToSegment(g.cx, g.cy, ex, ey, lx, ly)).toBeGreaterThanOrEqual(g.ringOuter - 0.05);
    // the leader starts at the anchor's angle
    expect(Math.abs(mod(cartesianToPolar(g.cx, g.cy, nums[0], nums[1]).angle - l.candidate.angle + 180, 360) - 180)).toBeLessThan(0.2);
    // and the label stays near it
    const attach = cartesianToPolar(g.cx, g.cy, lx, ly).angle;
    expect(Math.abs(mod(attach - l.candidate.angle + 180, 360) - 180)).toBeLessThanOrEqual(g.labelFrame.maxDisplacement + 1e-6);
    expect(l.text.length).toBeGreaterThan(0);
  }
  // every candidate is either shown or counted as hidden
  expect(p.labels.length + p.hidden).toBe(g.candidates.length);
  if (p.hidden > 0) {
    expect(p.notes).toHaveLength(1);
    expect(p.notes[0].text).toBe(`+${p.hidden.toLocaleString('en-US')} more`);
    // the note row is free
    for (const l of p.labels) expect(l.box.y1).toBeLessThanOrEqual(p.notes[0].y - 0.35 * g.labelFontSize - g.labelLineHeight / 2 + 0.01);
  } else {
    expect(p.notes).toHaveLength(0);
  }
}

const SIZES: Array<[number, number]> = [
  [600, 600],
  [1200, 900],
  [400, 400],
  [900, 600],
  [1600, 1000],
];

describe('outside labels', () => {
  for (const name of Object.keys(SAMPLES) as SampleName[]) {
    for (const [w, h] of SIZES) {
      it(`never overlap for ${name} at ${w}×${h}`, () => {
        const s = SAMPLES[name];
        const g = geometryFor(s.record, w, h, { enzymeSites: s.enzymeSites });
        expectCleanLabels(g, g.basePlacement);
        expect(placeLabels(g)).toBe(g.basePlacement);
      });
    }
  }

  it('stay clean with primers, ORFs and a rotated map', () => {
    const s = SAMPLES.pBAD30;
    const record: SeqRecord = {
      ...s.record,
      primers: [
        { id: 'p1', name: 'pBAD-F', sequence: 'ATGCCATAGCATTTTTATCC' },
        { id: 'p2', name: 'pBAD-R', sequence: 'GATTTAATCTGTATCAGG' },
      ],
    };
    const primerSites: PrimerBindingSite[] = [
      { primerId: 'p1', strand: 1, range: { start: 2200, end: 2220 }, annealedLength: 20, mismatches: 0, tailLength: 0 },
      { primerId: 'p2', strand: -1, range: { start: 2360, end: 2378 }, annealedLength: 18, mismatches: 0, tailLength: 0 },
      { primerId: 'p1', strand: 1, range: { start: 2210, end: 2230 }, annealedLength: 20, mismatches: 1, tailLength: 0 },
    ];
    const orfs: Orf[] = [
      { range: { start: 1081, end: 1960 }, strand: -1, frame: 0, aaLength: 292, hasStop: true },
      { range: { start: 4800, end: 5200 }, strand: 1, frame: 1, aaLength: 132, hasStop: true }, // wraps
    ];
    for (const rotation of [0, 90, 213]) {
      for (const [w, h] of SIZES) {
        const g = geometryFor(record, w, h, { enzymeSites: s.enzymeSites, primerSites, orfs, rotation });
        expectCleanLabels(g, g.basePlacement);
        expect(g.primers).toHaveLength(3);
        expect(g.orfs).toHaveLength(2);
      }
    }
  });

  it('give pinned (selected / highlighted) features a label even when space runs out', () => {
    const g = geometryFor(SAMPLES.pBR322.record, 400, 400, { enzymeSites: SAMPLES.pBR322.enzymeSites });
    const hiddenFeature = g.candidates.find((c) => c.featureId !== undefined && !g.basePlacement.byKey.has(c.key));
    expect(hiddenFeature).toBeDefined();
    const pinned = placeLabels(g, new Set([hiddenFeature!.featureId!]));
    expect(pinned.byKey.has(hiddenFeature!.key)).toBe(true);
    expectCleanLabels(g, pinned);
  });

  it('prefer features to unique cutters to other enzymes when dropping', () => {
    const g = geometryFor(SAMPLES.pBR322.record, 400, 400, { enzymeSites: SAMPLES.pBR322.enzymeSites });
    const p = g.basePlacement;
    expect(p.hidden).toBeGreaterThan(0);
    const shown = (cls: number) => g.candidates.filter((c) => c.priorityClass === cls).filter((c) => p.byKey.has(c.key)).length;
    const total = (cls: number) => g.candidates.filter((c) => c.priorityClass === cls).length;
    // named features keep (almost) all their labels; multi-cutters go first
    expect(shown(1) / total(1)).toBeGreaterThanOrEqual(shown(4) / Math.max(1, total(4)));
  });

  it('is deterministic', () => {
    const s = SAMPLES.pBR322;
    const a = geometryFor(s.record, 1200, 900, { enzymeSites: s.enzymeSites });
    const b = geometryFor(s.record, 1200, 900, { enzymeSites: s.enzymeSites });
    expect(a.basePlacement.labels.map((l) => [l.candidate.key, l.x, l.y])).toEqual(
      b.basePlacement.labels.map((l) => [l.candidate.key, l.x, l.y]),
    );
  });

  it('puts feature names inside their arc only when they fit, never upside down', () => {
    const s = SAMPLES.pFA6a;
    const g = geometryFor(s.record, 1200, 900, { enzymeSites: s.enzymeSites });
    const inside = g.features.filter((f) => f.inside);
    expect(inside.map((f) => f.item.feature.name)).toEqual(expect.arrayContaining(['kanMX', 'KanR', 'AmpR', 'ori']));
    for (const f of inside) {
      const rMid = (f.rIn + f.rOut) / 2;
      const span = Math.max(...f.segments.map((sg) => sg.a1 - sg.a0));
      expect(measure(f.inside!.text, f.inside!.fontSize, 500)).toBeLessThan(arcLength(rMid, span));
      // features with an inside label have no outside label
      expect(g.candidates.some((c) => c.featureId === f.id)).toBe(false);
      // near 12 and 6 o'clock the text path runs left to right on screen (never upside down)
      const nums = f.inside!.d.match(/-?\d+(\.\d+)?/g)!.map(Number);
      const startX = nums[0];
      const endX = nums[nums.length - 2];
      const seg = f.segments.reduce((m, sg) => (sg.a1 - sg.a0 > m.a1 - m.a0 ? sg : m));
      const mid = (seg.a0 + seg.a1) / 2;
      if (Math.abs(Math.sin((mid * Math.PI) / 180)) < 0.7) expect(endX).toBeGreaterThan(startX);
    }
  });

  it('shrinks the circle (a little) for crowded maps instead of losing labels', () => {
    const s = SAMPLES.pBR322;
    const g = geometryFor(s.record, 1600, 1000, { enzymeSites: s.enzymeSites });
    // a large map: the circle stays large and (almost) every label is shown
    expect(g.radius).toBeGreaterThan(300);
    expect(g.basePlacement.hidden).toBeLessThanOrEqual(2);
  });
});

describe('spreadPositions', () => {
  it('keeps order, spacing and bounds while staying close to the ideals', () => {
    const rand = rng(7);
    for (let t = 0; t < 50; t++) {
      const n = 1 + Math.floor(rand() * 40);
      const ideal = Array.from({ length: n }, () => rand() * 600).sort((a, b) => a - b);
      const ys = spreadPositions(ideal, 14, 10, 590);
      for (let i = 1; i < n; i++) expect(ys[i] - ys[i - 1]).toBeGreaterThanOrEqual(14 - 1e-9);
      if (n * 14 <= 580) {
        expect(ys[0]).toBeGreaterThanOrEqual(10 - 1e-9);
        expect(ys[n - 1]).toBeLessThanOrEqual(590 + 1e-9);
      }
    }
    expect(spreadPositions([100, 200], 14, 0, 1000)).toEqual([100, 200]);
    expect(spreadPositions([100, 100], 14, 0, 1000)).toEqual([93, 107]);
    expect(spreadPositions([0, 0, 0], 10, 5, 1000)).toEqual([5, 15, 25]);
  });
});

describe('assignSides', () => {
  const cand = (key: string, angle: number) => ({
    key,
    ref: { kind: 'enzyme' as const, index: 0 },
    text: key,
    width: 40,
    chip: null,
    fontWeight: 400,
    tone: 'enzyme' as const,
    angle,
    anchorRadius: 100,
    priorityClass: 4,
    weight: 0,
  });

  it('puts right-hand anchors right and left-hand anchors left', () => {
    const cs = [cand('a', 90), cand('b', 270), cand('c', 45), cand('d', 200)];
    const sides = assignSides(cs);
    expect(cs.map((c) => sides.get(c))).toEqual([1, -1, 1, -1]);
  });

  it('shares a cluster at 12 o’clock between both columns', () => {
    const cs = Array.from({ length: 10 }, (_, i) => cand(`m${i}`, 0.5 + i * 0.4));
    const sides = assignSides(cs);
    const left = cs.filter((c) => sides.get(c) === -1);
    expect(left.length).toBeGreaterThanOrEqual(4);
    expect(left.length).toBeLessThanOrEqual(6);
    // the most counter-clockwise ones go left
    expect(left.every((c) => c.angle <= Math.min(...cs.filter((x) => sides.get(x) === 1).map((x) => x.angle)))).toBe(true);
  });
});

describe('geometry', () => {
  it('fills the container and centres the map', () => {
    const g = geometryFor(SAMPLES.pFA6a.record, 1000, 700, { enzymeSites: SAMPLES.pFA6a.enzymeSites });
    expect(g.cx).toBe(500);
    expect(g.cy).toBe(350);
    expect(g.labelRadius).toBeGreaterThan(g.ringOuter);
    expect(g.ringOuter).toBeGreaterThan(g.radius);
    expect(g.radius).toBeGreaterThan(150);
    expect(computeGeometry(buildMapModel({ record: SAMPLES.pFA6a.record }), { width: 30, height: 30, measure })).toBeNull();
  });

  it('stacks overlapping features on separate lanes inside the backbone', () => {
    const g = geometryFor(SAMPLES.pFA6a.record, 1200, 900);
    const kanMX = g.features.find((f) => f.item.feature.name === 'kanMX')!;
    const kanR = g.features.find((f) => f.item.feature.name === 'KanR')!;
    expect(kanMX.rOut).toBeLessThan(g.radius);
    expect(kanR.rOut).toBeLessThanOrEqual(kanMX.rIn);
    // the wrapping SP6 promoter is drawn across the origin
    const sp6 = g.features.find((f) => f.item.feature.name === 'SP6 promoter')!;
    expect(sp6.a0).toBeLessThan(360);
    expect(sp6.a1).toBeGreaterThan(360);
  });

  it('draws multi-segment features per segment with connectors', () => {
    const f: Feature = {
      id: 'j',
      type: 'CDS',
      name: 'split',
      strand: -1,
      segments: [
        { start: 100, end: 300 },
        { start: 500, end: 700 },
        { start: 900, end: 950 },
      ],
      qualifiers: [],
    };
    const g = geometryFor(rec(2000, [f]), 800, 800);
    const shape = g.features[0];
    expect(shape.segments).toHaveLength(3);
    expect(shape.connectors.match(/M/g)).toHaveLength(2);
    expect(shape.d.match(/M/g)).toHaveLength(3);
  });

  it('draws short primers as visible arrows with the tip on the 3′ end, stacking neighbours that would touch', () => {
    const L = 5000;
    const primers = ['a', 'b', 'c'].map((id) => ({ id, name: id.toUpperCase(), sequence: 'ACGTACGTACGTACGTACGT' }));
    const site = (primerId: string, start: number, strand: 1 | -1): PrimerBindingSite => ({
      primerId,
      strand,
      range: { start, end: start + 20 },
      annealedLength: 20,
      mismatches: 0,
      tailLength: 0,
    });
    // b starts 30 bp after a ends: disjoint, but their lengthened arrows would touch
    const primerSites = [site('a', 1000, 1), site('b', 1050, 1), site('c', 3000, -1)];
    const g = geometryFor(rec(L, [], { primers }), 900, 700, { primerSites });
    const [a, b, c] = g.primers;
    expect(a.item.lane).not.toBe(b.item.lane);
    expect(c.item.lane).toBe(0);
    for (const p of g.primers) {
      expect(arcLength((p.rIn + p.rOut) / 2, p.a1 - p.a0)).toBeGreaterThanOrEqual(14 - 1e-6);
    }
    // the tip stays exactly on the 3' end: a1 for forward primers, a0 for reverse ones
    expect(a.a1).toBeCloseTo(positionToAngle(g.scale, 1020), 9);
    expect(c.a0).toBeCloseTo(positionToAngle(g.scale, 3000), 9);
    // outside the backbone, clear of the enzyme cut ticks
    expect(Math.min(...g.primers.map((p) => p.rIn))).toBeGreaterThan(g.radius + 5);
  });

  it('never lets primer arrows on the same lane overlap as drawn (random sites, all sizes)', () => {
    const rand = rng(11);
    const overlaps = (p: { a0: number; a1: number }, q: { a0: number; a1: number }) =>
      mod(q.a0 - p.a0, 360) < p.a1 - p.a0 - 1e-6 || mod(p.a0 - q.a0, 360) < q.a1 - q.a0 - 1e-6;
    for (let trial = 0; trial < 12; trial++) {
      const L = 2000 + Math.floor(rand() * 9000);
      const topology = trial % 3 === 2 ? 'linear' : 'circular';
      const primers = [{ id: 'p', name: 'P', sequence: 'ACGT' }];
      const primerSites: PrimerBindingSite[] = Array.from({ length: 6 + Math.floor(rand() * 8) }, () => {
        const len = 16 + Math.floor(rand() * 14);
        const start = Math.floor(rand() * (L - len));
        return { primerId: 'p', strand: rand() < 0.5 ? 1 : -1, range: { start, end: start + len }, annealedLength: len, mismatches: 0, tailLength: 0 };
      });
      for (const [w, h] of [[400, 400], [900, 600], [1600, 1000]]) {
        const g = geometryFor(rec(L, [], { primers, topology }), w, h, { primerSites });
        for (let i = 0; i < g.primers.length; i++) {
          for (let j = i + 1; j < g.primers.length; j++) {
            const [p, q] = [g.primers[i], g.primers[j]];
            // lanes beyond the third share the outermost one (MAX_PRIMER_LANES)
            if (p.item.lane !== q.item.lane || p.item.lane >= 3) continue;
            expect(overlaps(p, q)).toBe(false);
          }
        }
      }
    }
  });

  it('draws a join split at the origin as one continuous piece', () => {
    const L = 3000;
    const join: Feature = {
      id: 'j',
      type: 'CDS',
      name: 'across origin',
      strand: 1,
      segments: [
        { start: 2700, end: 3000 },
        { start: 0, end: 180 },
      ],
      qualifiers: [],
    };
    expect(featurePieces(join, L, 'circular')).toEqual([{ start: 2700, end: 3180 }]);
    // not contiguous, or contiguous only on a circular molecule: kept apart
    expect(featurePieces(join, L, 'linear')).toHaveLength(2);
    expect(featurePieces({ ...join, segments: [{ start: 0, end: 180 }, { start: 2700, end: 3000 }] }, L, 'circular')).toHaveLength(2);
    expect(featurePieces({ ...join, segments: [{ start: 100, end: 200 }, { start: 200, end: 300 }] }, L, 'linear')).toEqual([
      { start: 100, end: 300 },
    ]);
    const g = geometryFor(rec(L, [join]), 800, 800);
    const shape = g.features[0];
    expect(shape.segments).toHaveLength(1);
    expect(shape.connectors).toBe('');
    expect(shape.d.match(/M/g)).toHaveLength(1);
    expect(shape.a1 - shape.a0).toBeCloseTo((480 / L) * 360, 9);
  });

  it('rotates every annotation with the map', () => {
    const r = SAMPLES.pFA6a.record;
    const g0 = geometryFor(r, 900, 900);
    const g90 = geometryFor(r, 900, 900, { rotation: 90 });
    expect(g90.features[0].a0 - g0.features[0].a0).toBeCloseTo(90, 9);
  });

  it('renders linear records with a gap and end caps at the origin', () => {
    const g = geometryFor(SAMPLES.linear.record, 900, 700, { enzymeSites: SAMPLES.linear.enzymeSites });
    expect(g.scale.gap).toBeGreaterThan(0);
    expect(g.backboneEnds).not.toBe('');
    expect(g.centre.detail).toBe('8,596 bp · linear');
  });

  it('has sensible empty states', () => {
    const empty = geometryFor(rec(0, []), 600, 600);
    expect(empty.centre.note).toBe('Empty sequence');
    expect(empty.candidates).toHaveLength(0);
    expect(empty.ruler).toBeNull();
    const bare = geometryFor(rec(5000, []), 600, 600);
    expect(bare.centre.note).toBe('No features');
    expect(bare.ruler?.labels.length).toBeGreaterThanOrEqual(7);
    expect(bare.radius).toBeLessThan(300 * 0.9); // breathing room around a bare circle
  });

  it('keeps long names inside the centre', () => {
    const g = geometryFor({ ...SAMPLES.pFA6a.record, name: 'pFA6a-kanMX6-GFP(S65T)-tADH1-modified-for-C-terminal-tagging-v2' }, 900, 600);
    expect(g.centre.name.endsWith('…')).toBe(true);
    expect(measure(g.centre.name, g.centre.nameSize, 600)).toBeLessThanOrEqual(2 * g.centreRadius);
  });

  it('lays out a 4.6 Mb genome with ~4,500 features quickly', () => {
    const L = 4_641_652;
    const rand = rng(3);
    const features: Feature[] = [];
    for (let pos = 200, i = 0; pos < L - 3000 && features.length < 4500; i++) {
      const len = 300 + Math.floor(rand() * 2400);
      features.push(feat(`g${i}`, pos, pos + len, rand() < 0.5 ? 1 : -1, `gen${i}`));
      pos += len + Math.floor(rand() * 400) - 60;
    }
    const record = rec(L, features);
    const t0 = performance.now();
    const model = buildMapModel({ record });
    const g = computeGeometry(model, { width: 1400, height: 900, measure })!;
    const ms = performance.now() - t0;
    expect(g.features).toHaveLength(features.length);
    expectCleanLabels(g, g.basePlacement);
    expect(ms).toBeLessThan(3000);
  });
});
