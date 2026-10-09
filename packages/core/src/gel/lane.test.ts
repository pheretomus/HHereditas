import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_RESOLUTION, ladderLane, simulateLane } from './lane';
import type { GelBand, GelFragment } from './lane';
import { LADDERS, getLadder } from './ladders';
import type { Ladder } from './ladders';
import { migrate, sizeAtPosition } from './migration';
import type { GelBuffer } from './migration';

interface Digests {
  puc19: { length: number; topology: string; digests: Record<string, number[]> };
  lambda: { fragments: number[] };
}
const digests = JSON.parse(
  readFileSync(resolve(import.meta.dirname, '../../test/oracle/gel/digests.json'), 'utf8'),
) as Digests;

function ladder(id: string): Ladder {
  const l = getLadder(id);
  if (l === undefined) throw new Error(`missing ladder ${id}`);
  return l;
}

/** Common checks for any lane. */
function expectWellFormed(bands: GelBand[]): void {
  let maxIntensity = 0;
  for (let i = 0; i < bands.length; i++) {
    const b = bands[i];
    expect(b.position).toBeGreaterThan(0);
    expect(b.position).toBeLessThan(1);
    expect(b.intensity).toBeGreaterThan(0);
    expect(b.intensity).toBeLessThanOrEqual(1);
    expect(b.count).toBe(b.sizes.length);
    expect(b.size).toBeLessThanOrEqual(b.sizes[0] + 1e-9);
    expect(b.size).toBeGreaterThanOrEqual(b.sizes[b.sizes.length - 1] - 1e-9);
    if (i > 0) expect(b.position).toBeGreaterThan(bands[i - 1].position);
    maxIntensity = Math.max(maxIntensity, b.intensity);
  }
  if (bands.length > 0) expect(maxIntensity).toBe(1);
}

/** Distance between the top-most and the bottom-most fragment of a band (fraction of the gel). */
function bandSpread(b: GelBand): number {
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  for (const f of b.fragments) {
    lo = Math.min(lo, f.position);
    hi = Math.max(hi, f.position);
  }
  return hi - lo;
}

/** Spread of the union of two bands (fraction of the gel). */
function mergedSpread(a: GelBand, b: GelBand): number {
  const positions = [...a.fragments, ...b.fragments].map((f) => f.position);
  return Math.max(...positions) - Math.min(...positions);
}

describe('simulateLane: positions, ordering and intensity', () => {
  it('returns an empty lane for no fragments', () => {
    expect(simulateLane([])).toEqual([]);
  });

  it('draws a single fragment at its migrate() position with intensity 1', () => {
    const [band, ...rest] = simulateLane([{ size: 2686, label: 'pUC19/EcoRI' }]);
    expect(rest).toEqual([]);
    expect(band).toEqual({
      size: 2686,
      position: migrate(2686),
      intensity: 1,
      count: 1,
      labels: ['pUC19/EcoRI'],
      sizes: [2686],
      fragments: [{ index: 0, size: 2686, form: 'linear', position: migrate(2686), label: 'pUC19/EcoRI' }],
    });
  });

  it('orders bands top to bottom whatever the input order', () => {
    const bands = simulateLane([{ size: 300 }, { size: 5000 }, { size: 1200 }]);
    expect(bands.map((b) => b.size)).toEqual([5000, 1200, 300]);
    expectWellFormed(bands);
  });

  it('makes intensity proportional to size x molar amount, brightest band = 1', () => {
    const equimolar = simulateLane([{ size: 1000 }, { size: 3000 }]);
    expect(equimolar.map((b) => b.intensity)).toEqual([1, 1000 / 3000]);
    const adjusted = simulateLane([{ size: 1000, molarAmount: 3 }, { size: 3000 }]);
    expect(adjusted[0].intensity).toBeCloseTo(1, 15);
    expect(adjusted[1].intensity).toBeCloseTo(1, 15);
    const scaled = simulateLane([{ size: 1000, molarAmount: 0.002 }, { size: 3000, molarAmount: 0.001 }]);
    expect(scaled[0].intensity).toBe(1);
    expect(scaled[1].intensity).toBeCloseTo(2000 / 3000, 15);
  });

  it('reports an unmerged fragment at exactly its own size and position', () => {
    const bands = simulateLane([{ size: 2686, molarAmount: 0.15 }, { size: 997, molarAmount: 1 / 3 }], { agarosePercent: 0.8 });
    expect(bands.map((b) => b.size)).toEqual([2686, 997]);
    expect(bands.map((b) => b.position)).toEqual([migrate(2686, { agarosePercent: 0.8 }), migrate(997, { agarosePercent: 0.8 })]);
  });

  it('omits fragments with zero molar amount', () => {
    expect(simulateLane([{ size: 500, molarAmount: 0 }])).toEqual([]);
    const bands = simulateLane([{ size: 500, molarAmount: 0, label: 'x' }, { size: 900, label: 'y' }]);
    expect(bands.map((b) => b.labels)).toEqual([['y']]);
  });

  it('uses the gel conditions and DNA forms of the options', () => {
    const opts = { agarosePercent: 2, buffer: 'TBE' as GelBuffer };
    const [band] = simulateLane([{ size: 400 }], opts);
    expect(band.position).toBe(migrate(400, opts));
    const forms = simulateLane([
      { size: 3000, form: 'supercoiled', label: 'SC' },
      { size: 3000, form: 'linear', label: 'L' },
      { size: 3000, form: 'nicked', label: 'OC' },
    ]);
    expect(forms.map((b) => b.labels[0])).toEqual(['OC', 'L', 'SC']);
    expect(forms[2].position).toBe(migrate(3000, { form: 'supercoiled' }));
  });

  it('does not modify its input', () => {
    const input: GelFragment[] = [{ size: 900, molarAmount: 2, label: 'a' }, { size: 910, label: 'b' }, { size: 3000 }];
    const copy = structuredClone(input);
    Object.freeze(input);
    input.forEach((f) => Object.freeze(f));
    simulateLane(input, { resolution: 0.05 });
    expect(input).toEqual(copy);
  });

  it('rejects invalid fragments and options', () => {
    expect(() => simulateLane([{ size: 0 }])).toThrow(RangeError);
    expect(() => simulateLane([{ size: -10 }])).toThrow(RangeError);
    expect(() => simulateLane([{ size: Number.NaN }])).toThrow(RangeError);
    expect(() => simulateLane([{ size: 100, molarAmount: -1 }])).toThrow(RangeError);
    expect(() => simulateLane([{ size: 100, molarAmount: Number.POSITIVE_INFINITY }])).toThrow(RangeError);
    expect(() => simulateLane([{ size: 100, form: 'relaxed' as GelFragment['form'] }])).toThrow(RangeError);
    expect(() => simulateLane([{ size: 100, form: 'toString' as GelFragment['form'] }])).toThrow(RangeError);
    expect(() => simulateLane([{ size: 100 }], { resolution: -0.01 })).toThrow(RangeError);
    expect(() => simulateLane([{ size: 100 }], { resolution: Number.NaN })).toThrow(RangeError);
    expect(() => simulateLane([{ size: 100 }], { agarosePercent: 4 })).toThrow(RangeError);
  });
});

describe('simulateLane: merging of co-migrating fragments', () => {
  it('merges fragments closer than the resolution into one band with summed mass', () => {
    // 1000 and 1010 bp are ~0.002 apart at 1 % TAE
    const bands = simulateLane([{ size: 1000, label: 'a' }, { size: 1010, molarAmount: 2, label: 'b' }, { size: 3000, label: 'c' }]);
    expect(bands).toHaveLength(2);
    const doublet = bands[1];
    expect(doublet.count).toBe(2);
    expect(doublet.labels).toEqual(['b', 'a']); // top to bottom
    expect(doublet.sizes).toEqual([1010, 1000]);
    const m1 = 1000;
    const m2 = 1010 * 2;
    expect(doublet.size).toBeCloseTo((1000 * m1 + 1010 * m2) / (m1 + m2), 9);
    expect(doublet.position).toBeCloseTo((migrate(1000) * m1 + migrate(1010) * m2) / (m1 + m2), 12);
    expect(doublet.intensity).toBe(1); // 3020 > 3000
    expect(bands[0].intensity).toBeCloseTo(3000 / (m1 + m2), 12);
  });

  it('always merges identical sizes, even at resolution 0', () => {
    const bands = simulateLane([{ size: 34 }, { size: 34 }, { size: 26 }], { resolution: 0 });
    expect(bands.map((b) => b.count)).toEqual([2, 1]);
    expect(bands[0].sizes).toEqual([34, 34]);
  });

  it('separates bands exactly at the resolution and merges them just below it', () => {
    const pa = migrate(2000);
    const pb = migrate(1500);
    const gap = pb - pa;
    expect(simulateLane([{ size: 2000 }, { size: 1500 }], { resolution: gap })).toHaveLength(2);
    expect(simulateLane([{ size: 2000 }, { size: 1500 }], { resolution: gap * (1 + 1e-9) })).toHaveLength(1);
  });

  // Replaces 'chains neighbours (single linkage): a dense series becomes one smear-like band', which encoded
  // the defect of review findings F1/F7/F9 (this series spans 0.026 of the gel, 2.6x the resolution, yet
  // was reported as one band at its mean position).
  it('splits a dense series into adjacent bands, each narrower than the resolution (complete linkage)', () => {
    const series: GelFragment[] = Array.from({ length: 30 }, (_, i) => ({ size: 1000 + 5 * i }));
    expect(migrate(1000) - migrate(1145)).toBeGreaterThan(2 * DEFAULT_RESOLUTION);
    const bands = simulateLane(series);
    expectWellFormed(bands);
    expect(bands.length).toBeGreaterThanOrEqual(3);
    expect(bands.reduce((n, b) => n + b.count, 0)).toBe(30);
    for (const b of bands) expect(bandSpread(b)).toBeLessThan(DEFAULT_RESOLUTION);
    expect(bands[0].sizes[0]).toBe(1145);
    expect(bands[bands.length - 1].sizes.at(-1)).toBe(1000);
    // maximal: no two neighbouring bands could be merged without spanning the resolution
    for (let k = 1; k < bands.length; k++) expect(mergedSpread(bands[k - 1], bands[k])).toBeGreaterThanOrEqual(DEFAULT_RESOLUTION);
    expect(simulateLane(series, { resolution: 0 })).toHaveLength(30);
    expect(simulateLane(series, { resolution: 0.03 })).toHaveLength(1);
  });

  it('merges the closest fragments first (natural clusters, not a top-down sweep)', () => {
    // A at p, B 0.0089 below, C 0.0108 below: B and C (0.0019 apart) co-migrate; A stays alone, although
    // A and B are also closer than the resolution (a top-down sweep would give [A, B] + [C])
    const p = migrate(1000);
    const b = sizeAtPosition(p + 0.0089) as number;
    const c = sizeAtPosition(p + 0.0108) as number;
    const bands = simulateLane([{ size: 1000, label: 'A' }, { size: b, label: 'B' }, { size: c, label: 'C' }]);
    expect(bands.map((x) => x.labels)).toEqual([['A'], ['B', 'C']]);
    // with the close pair at the top, the pair merges and the lower fragment stays alone
    const d = sizeAtPosition(p + 0.0019) as number;
    const e = sizeAtPosition(p + 0.0108) as number;
    expect(simulateLane([{ size: 1000, label: 'A' }, { size: d, label: 'D' }, { size: e, label: 'E' }]).map((x) => x.labels)).toEqual([
      ['A', 'D'],
      ['E'],
    ]);
  });

  it('keeps the documented default resolution', () => {
    expect(DEFAULT_RESOLUTION).toBe(0.01);
    // the claim made in the DEFAULT_RESOLUTION doc comment
    expect(migrate(500) - migrate(517)).toBeLessThan(DEFAULT_RESOLUTION);
    expect(migrate(400) - migrate(500)).toBeGreaterThan(DEFAULT_RESOLUTION);
  });
});

describe('pUC19 digest lanes (fragment sizes from Biopython, fixture M77789)', () => {
  const puc = digests.puc19;
  const lane = (name: string, agarosePercent = 1): GelBand[] =>
    simulateLane(puc.digests[name].map((size) => ({ size, label: `${size}` })), { agarosePercent });

  it('uses the expected oracle digests', () => {
    expect(puc.length).toBe(2686);
    expect(puc.topology).toBe('circular');
    for (const frags of Object.values(puc.digests)) expect(frags.reduce((a, b) => a + b, 0)).toBe(2686);
  });

  it('EcoRI linearises the plasmid: one 2,686 bp band', () => {
    const bands = lane('EcoRI');
    expect(bands).toHaveLength(1);
    expect(bands[0].size).toBe(2686);
  });

  it('PvuII gives 2,364 + 322 bp with intensities proportional to length', () => {
    const bands = lane('PvuII');
    expectWellFormed(bands);
    expect(bands.map((b) => b.size)).toEqual([2364, 322]);
    expect(bands[1].intensity).toBeCloseTo(322 / 2364, 12);
  });

  it('EcoRI + HindIII drops out a faint 51 bp polylinker fragment near the bottom', () => {
    const bands = lane('EcoRI+HindIII');
    expect(bands.map((b) => b.size)).toEqual([2635, 51]);
    expect(bands[1].intensity).toBeCloseTo(51 / 2635, 12);
    expect(bands[1].position).toBeGreaterThan(0.85);
  });

  it('MspI (13 fragments) shows the classic unresolved doublets', () => {
    const two = lane('MspI', 2);
    expectWellFormed(two);
    expect(two.map((b) => b.sizes)).toEqual([[501, 489], [404], [331], [242], [190], [147], [111, 110], [67], [34, 34, 26]]);
    const one = lane('MspI', 1);
    expectWellFormed(one);
    expect(one.map((b) => b.sizes)).toEqual([[501, 489], [404], [331], [242], [190], [147], [111, 110], [67], [34, 34, 26]]);
    // the 111/110 doublet carries twice the mass of a single ~110 bp fragment
    const doublet = two[6];
    expect(doublet.count).toBe(2);
    expect(doublet.intensity).toBeCloseTo((111 + 110) / (501 + 489), 12);
    // better separation of the small fragments on 2 % than on 1 %
    expect(two[7].position - two[6].position).toBeGreaterThan(one[7].position - one[6].position);
  });

  it('HaeIII: every fragment accounted for, all bands well formed at every agarose %', () => {
    for (const agarosePercent of [0.7, 1, 1.5, 2, 3]) {
      const bands = lane('HaeIII', agarosePercent);
      expectWellFormed(bands);
      expect(bands.reduce((n, b) => n + b.count, 0)).toBe(puc.digests.HaeIII.length);
    }
  });

  it('an uncut miniprep: supercoiled below, nicked above, linear in between', () => {
    const bands = simulateLane([
      { size: 2686, form: 'supercoiled', molarAmount: 0.8, label: 'supercoiled' },
      { size: 2686, form: 'nicked', molarAmount: 0.15, label: 'nicked' },
      { size: 2686, form: 'linear', molarAmount: 0.05, label: 'linear' },
    ]);
    expect(bands.map((b) => b.labels[0])).toEqual(['nicked', 'linear', 'supercoiled']);
    expect(bands[2].intensity).toBe(1);
    expect(bands[0].intensity).toBeCloseTo(0.15 / 0.8, 12);
  });
});

describe('ladderLane', () => {
  it('draws every built-in ladder correctly at every gel condition', () => {
    for (const l of LADDERS) {
      const fragments = l.bands.reduce((n, b) => n + (b.components?.length ?? 1), 0);
      for (const buffer of ['TAE', 'TBE'] as GelBuffer[]) {
        for (const agarosePercent of [0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3]) {
          const bands = ladderLane(l, { agarosePercent, buffer });
          expectWellFormed(bands);
          expect(bands.reduce((n, b) => n + b.count, 0), `${l.id} ${agarosePercent}% ${buffer}`).toBe(fragments);
          if (l.bands.every((b) => b.massNg !== undefined)) {
            const total = bands.reduce((s, b) => s + (b.massNg as number), 0);
            const vendorTotal = l.bands.reduce((s, b) => s + (b.massNg as number), 0);
            expect(total).toBeCloseTo(vendorTotal, 9);
          }
        }
      }
    }
  });

  it('takes intensities from the vendor masses (NEB 1 kb: 3.0 kb reference band brightest)', () => {
    const bands = ladderLane(ladder('neb-1kb'));
    expect(bands).toHaveLength(10); // 517 + 500 bp co-migrate
    const ref = bands.find((b) => b.sizes[0] === 3001) as GelBand;
    expect(ref.intensity).toBe(1);
    expect(ref.emphasized).toBe(true);
    expect(ref.massNg).toBe(125);
    expect(ref.labels).toEqual(['3001']);
    const top = bands[0];
    expect(top.sizes).toEqual([10002]);
    expect(top.intensity).toBeCloseTo(42 / 125, 12);
    expect(top.emphasized).toBe(false);
    const doublet = bands[bands.length - 1];
    expect(doublet.sizes).toEqual([517, 500]);
    expect(doublet.count).toBe(2);
    expect(doublet.massNg).toBe(42);
    expect(doublet.labels).toEqual(['517', '500']);
  });

  it('keeps a vendor doublet row as one band labelled as the vendor does', () => {
    const bands = ladderLane(ladder('neb-1kb-plus'));
    expect(bands).toHaveLength(19);
    const d = bands.find((b) => b.labels[0] === '500/517') as GelBand;
    expect(d.count).toBe(2);
    expect(d.sizes).toEqual([517, 500]);
    expect(d.massNg).toBe(124);
    expect(d.emphasized).toBe(true);
    expect(d.intensity).toBe(1); // 124 ng is the largest mass of the ladder
    // review F17: the row's two fragments are placed like any co-migrating pair (mass-weighted mean, equal
    // shares), not at migrate(500); the old assertion `toBe(migrate(500))` encoded that inconsistency
    expect(d.position).toBeCloseTo((migrate(517) + migrate(500)) / 2, 12);
    expect(d.size).toBeCloseTo(508.5, 9);
    expect(d.fragments.map((f) => [f.index, f.size, f.label])).toEqual([[14, 517, '500/517'], [14, 500, '500/517']]);
  });

  it('draws ladders without published masses with equal band masses', () => {
    const bands = ladderLane(ladder('invitrogen-1kb-plus'));
    expect(bands).toHaveLength(18);
    for (const b of bands) {
      expect(b.intensity).toBe(1);
      expect(b.massNg).toBeUndefined();
    }
    expect(bands.filter((b) => b.emphasized).map((b) => b.size)).toEqual([1500]);
    const promega = ladderLane(ladder('promega-1kb'));
    expect(promega).toHaveLength(13);
    expect(promega[promega.length - 1].sizes).toEqual([253, 250]);
  });

  it('treats a ladder with partly missing masses as equal-mass', () => {
    const custom: Ladder = {
      id: 'custom',
      name: 'Custom',
      vendor: 'Lab',
      source: 'https://example.org',
      bands: [{ size: 3000, massNg: 100 }, { size: 1000 }, { size: 300, massNg: 10 }],
    };
    const bands = ladderLane(custom);
    expect(bands.map((b) => b.intensity)).toEqual([1, 1, 1]);
    expect(bands.every((b) => b.massNg === undefined)).toBe(true);
  });

  it('resolves the GeneRuler 1 kb Plus 20 kb and 10 kb bands on 0.7 % but they crowd on 2 %', () => {
    const l = ladder('thermo-generuler-1kb-plus');
    const g07 = ladderLane(l, { agarosePercent: 0.7 });
    const g2 = ladderLane(l, { agarosePercent: 2 });
    expect(g07[0].sizes).toEqual([20000]);
    expect(g07[1].sizes).toEqual([10000]);
    expect(g07[1].position - g07[0].position).toBeGreaterThan(g2[1].position - g2[0].position);
    expect(g2.reduce((n, b) => n + b.count, 0)).toBe(15);
  });

  it('lambda/HindIII lane: intensities follow the equimolar masses', () => {
    const bands = ladderLane(ladder('neb-lambda-hindiii'), { agarosePercent: 0.8 });
    expect(bands.map((b) => b.sizes[0])).toEqual(digests.lambda.fragments);
    for (const b of bands) expect(b.intensity).toBeCloseTo((b.massNg as number) / 477, 12);
  });

  it('does not modify the (frozen) ladder and validates custom ladders', () => {
    const l = ladder('thermo-generuler-mix');
    expect(() => ladderLane(l, { agarosePercent: 1.5, buffer: 'TBE' })).not.toThrow();
    const bad = (bands: Ladder['bands']): Ladder => ({ id: 'x', name: 'x', vendor: 'x', source: 'https://x.org', bands });
    expect(() => ladderLane(bad([{ size: 0 }]))).toThrow(RangeError);
    expect(() => ladderLane(bad([{ size: 100, massNg: -1 }]))).toThrow(RangeError);
    expect(() => ladderLane(l, { resolution: -1 })).toThrow(RangeError);
    expect(ladderLane(bad([]))).toEqual([]);
    expect(ladderLane(bad([{ size: 100, massNg: 0 }, { size: 50, massNg: 5 }])).map((b) => b.size)).toEqual([50]);
  });
});

// ------------------------------------------------------------------------------------------------
// Regression tests for review findings (reproductions kept as permanent tests)
// ------------------------------------------------------------------------------------------------

/** Spread (fraction of the gel) between the highest and the lowest fragment of a band of linear DNA. */
const spread = (sizes: number[], agarosePercent = 1): number =>
  migrate(sizes[sizes.length - 1], { agarosePercent }) - migrate(sizes[0], { agarosePercent });

describe('review: a band never joins fragments farther apart than the resolution (no single-linkage chaining)', () => {
  it('A: three fragments 0.9x resolution apart (outer pair 1.8x apart) are not one band', () => {
    const p0 = migrate(1000);
    const s1 = sizeAtPosition(p0 + 0.009) as number;
    const s2 = sizeAtPosition(p0 + 0.018) as number;
    const bands = simulateLane([{ size: 1000 }, { size: s1 }, { size: s2 }]);
    expect(bands.length).toBeGreaterThan(1);
  });

  it('B: pBR322/MspI (NEB N3032 fragments) at the default 1 % TAE: no band spans more than the resolution', () => {
    const mspI = [622, 527, 404, 307, 242, 238, 217, 201, 190, 180, 160, 160, 147, 147, 123, 110, 90, 76, 67, 34, 34, 26,
      26, 15, 9, 9];
    const widest = Math.max(...simulateLane(mspI.map((size) => ({ size }))).map((b) => spread(b.sizes)));
    expect(widest).toBeLessThanOrEqual(DEFAULT_RESOLUTION);
  });

  it('C: a genomic-digest-like smear (300 fragments, 1-40 kb) is not reported as one band', () => {
    const smear = Array.from({ length: 300 }, (_, i) => ({ size: Math.round(1000 * 40 ** (i / 299)) }));
    const bands = simulateLane(smear);
    expect(bands.length).toBeGreaterThan(10);
  });

  it('BAC-sized EcoRI digest (E. coli U00096.3 1,000,000-1,150,000) on 0.8 % TAE', () => {
    const cluster = [14083, 13222, 12268, 11559, 10627, 9971]; // consecutive gaps < 0.01, ends 0.029 apart
    expect(spread(cluster, 0.8)).toBeGreaterThan(2 * DEFAULT_RESOLUTION);
    const bands = simulateLane(cluster.map((size) => ({ size })), { agarosePercent: 0.8 });
    for (const b of bands) expect(spread(b.sizes, 0.8), `${b.sizes.join('/')}`).toBeLessThan(DEFAULT_RESOLUTION);
  });

  it('dense series 1000..2020 bp (30 bp steps): 1 kb and 2 kb do not end up in the same band', () => {
    const bands = simulateLane(Array.from({ length: 35 }, (_, i) => ({ size: 1000 + 30 * i })));
    for (const b of bands) expect(spread(b.sizes), `${b.count} fragments at ${b.position}`).toBeLessThan(DEFAULT_RESOLUTION);
  });

  it('ladder lanes too: NEB 100 bp on 3 % TBE (inside its recommended 1.2-3 %) keeps 1000, 900 and 800 bp apart', () => {
    const opts = { agarosePercent: 3, buffer: 'TBE' as GelBuffer };
    const l = ladder('neb-100bp');
    const rowPosition = new Map(l.bands.map((b) => [b.label ?? String(b.size), migrate(b.size, opts)]));
    const bands = ladderLane(l, opts);
    for (const b of bands) {
      const rows = b.labels.map((label) => rowPosition.get(label) as number);
      expect(Math.max(...rows) - Math.min(...rows), b.labels.join('+')).toBeLessThan(DEFAULT_RESOLUTION);
    }
    expect(bands.find((b) => b.labels.includes('1000'))?.labels).not.toContain('800');
  });

  const ECOLI = resolve(import.meta.dirname, '../../test/fixtures/large/ecoli_U00096.3.gb');
  it.skipIf(!existsSync(ECOLI))('E. coli genome / EcoRI (646 fragments, as Biopython 1.88) is not a 5-band lane', () => {
    const text = readFileSync(ECOLI, 'utf8');
    const body = text.indexOf('\n', text.search(/^ORIGIN/m)) + 1;
    const seq = text.slice(body, text.indexOf('\n//', body)).replace(/[^A-Za-z]/g, '').toUpperCase();
    const n = seq.length;
    const wrapped = seq + seq.slice(0, 5);
    const cuts: number[] = [];
    for (let i = wrapped.indexOf('GAATTC'); i >= 0 && i < n; i = wrapped.indexOf('GAATTC', i + 1)) cuts.push((i + 1) % n);
    cuts.sort((a, b) => a - b);
    const fragments = cuts.map((c, k) => (cuts[(k + 1) % cuts.length] - c + n) % n || n);
    expect(fragments).toHaveLength(646);
    expect(Math.max(...fragments)).toBe(42844);
    expect(Math.min(...fragments)).toBe(14);
    const bands = simulateLane(fragments.map((size) => ({ size })));
    for (const b of bands) expect(spread(b.sizes), `${b.count} fragments at ${b.position}`).toBeLessThan(DEFAULT_RESOLUTION);
    // the smear spreads over many bands instead of one band of intensity 1 hiding everything else
    expect(bands.length).toBeGreaterThan(30);
  });
});

describe('review: a merged band can be traced back to its fragments', () => {
  it('different inputs give different bands (which fragment is "b"?)', () => {
    const first = simulateLane([{ size: 1010, label: 'b' }, { size: 1000 }]);
    const second = simulateLane([{ size: 1010 }, { size: 1000, label: 'b' }]);
    expect(first).not.toEqual(second);
  });

  it('labels and sizes are listed in the same order, also for circular forms', () => {
    const [band] = simulateLane([
      { size: 3000, form: 'supercoiled', label: 'uncut plasmid (SC)' },
      { size: 2150, label: 'insert' },
    ]);
    expect(band.count).toBe(2);
    expect(band.labels.map((l, i) => `${l}=${band.sizes[i]}`)).toEqual(['uncut plasmid (SC)=3000', 'insert=2150']);
  });
});

describe('review: inputs that pass validation never produce NaN', () => {
  it('simulateLane: size x molarAmount overflow does not give intensity NaN', () => {
    const [band] = simulateLane([{ size: 2000, molarAmount: 1e306 }]);
    expect(Number.isNaN(band.intensity)).toBe(false);
  });

  it('ladderLane: custom-ladder components are not copied unvalidated into GelBand.sizes', () => {
    const custom: Ladder = { id: 'c', name: 'c', vendor: 'lab', source: 'https://example.org', bands: [{ size: 500, components: [Number.NaN, -3] }] };
    let sizes: number[] = [];
    try {
      sizes = ladderLane(custom)[0].sizes;
    } catch (e) {
      expect(e).toBeInstanceOf(RangeError);
      return;
    }
    expect(sizes.every((s) => Number.isFinite(s) && s > 0)).toBe(true);
  });
});

function message(f: () => unknown): string {
  try {
    f();
  } catch (e) {
    return (e as Error).message;
  }
  return '';
}

describe('review: validation errors name the bad fragment or ladder band', () => {
  it('simulateLane', () => {
    const fragments = [{ size: 2364, label: 'PvuII-1' }, { size: 322, label: 'PvuII-2' }, { size: Number.NaN, label: 'custom-3' }];
    expect(message(() => simulateLane(fragments))).toMatch(/custom-3|index 2|#2|\[2\]/);
  });

  it('ladderLane', () => {
    const custom = { id: 'my-ladder', name: 'Mine', vendor: 'lab', source: 'https://example.org', bands: [{ size: 3000 }, { size: 0 }] };
    expect(message(() => ladderLane(custom))).toMatch(/my-ladder|index 1|#1|\[1\]/);
  });
});

/** Seeded PRNG (mulberry32) for the property tests below. */
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

const ECOLI_FIXTURE = resolve(import.meta.dirname, '../../test/fixtures/large/ecoli_U00096.3.gb');
let ecoliCache: string | undefined;
/** Upper-case sequence of the E. coli U00096.3 fixture (read once). */
function ecoliSequence(): string {
  if (ecoliCache === undefined) {
    const text = readFileSync(ECOLI_FIXTURE, 'utf8');
    const body = text.indexOf('\n', text.search(/^ORIGIN/m)) + 1;
    ecoliCache = text.slice(body, text.indexOf('\n//', body)).replace(/[^A-Za-z]/g, '').toUpperCase();
  }
  return ecoliCache;
}

/** Fragment lengths of a circular sequence cut at every occurrence of a palindromic site. */
function circularDigest(seq: string, site: string): number[] {
  const n = seq.length;
  const wrapped = seq + seq.slice(0, site.length - 1);
  const cuts: number[] = [];
  for (let i = wrapped.indexOf(site); i >= 0 && i < n; i = wrapped.indexOf(site, i + 1)) cuts.push(i);
  return cuts.map((c, k) => (cuts[(k + 1) % cuts.length] - c + n) % n || n);
}

describe('review: more chaining cases (F9)', () => {
  // Fragment lengths: Biopython 1.88 on fixture pBR322_J01749.gb (4,361 bp, circular), MspI and HaeIII.
  const PBR322_MSPI = [622, 527, 404, 307, 242, 238, 217, 201, 190, 180, 160, 160, 147, 147, 123, 110, 90, 76, 67, 34,
    34, 26, 26, 15, 9, 9];
  const PBR322_HAEIII = [587, 540, 502, 458, 434, 267, 234, 213, 192, 184, 124, 123, 104, 89, 80, 64, 57, 51, 21, 18,
    11, 8];

  it('pBR322/MspI on 2 % TAE (201/190/180 bp) and pBR322/HaeIII on 3 % TBE (587/540/502 bp)', () => {
    const cases: Array<[number[], { agarosePercent: number; buffer?: GelBuffer }]> = [
      [PBR322_MSPI, { agarosePercent: 2 }],
      [PBR322_HAEIII, { agarosePercent: 3, buffer: 'TBE' }],
    ];
    for (const [fragments, opts] of cases) {
      const bands = simulateLane(fragments.map((size) => ({ size })), opts);
      expectWellFormed(bands);
      expect(bands.reduce((n, b) => n + b.count, 0)).toBe(fragments.length);
      for (const b of bands) expect(bandSpread(b), b.sizes.join('/')).toBeLessThan(DEFAULT_RESOLUTION);
    }
  });

  it.skipIf(!existsSync(ECOLI_FIXTURE))('E. coli U00096.3 / MspI (24,311 fragments) is a smear, not a 4-band lane', () => {
    const fragments = circularDigest(ecoliSequence(), 'CCGG');
    expect(fragments).toHaveLength(24311); // Biopython 1.88: MspI.search(U00096.3, linear=False)
    const bands = simulateLane(fragments.map((size) => ({ size })));
    expectWellFormed(bands);
    expect(bands.reduce((n, b) => n + b.count, 0)).toBe(24311);
    let widest = 0;
    for (const b of bands) widest = Math.max(widest, bandSpread(b));
    expect(widest).toBeLessThan(DEFAULT_RESOLUTION);
    expect(bands.length).toBeGreaterThan(30);
  });
});

describe('review: bands partition the fragments into groups narrower than the resolution (property)', () => {
  it('holds for random lanes, gels and resolutions (seeded)', () => {
    const rand = rng(20261008);
    const forms: Array<GelFragment['form']> = [undefined, 'linear', 'supercoiled', 'nicked'];
    for (let trial = 0; trial < 300; trial++) {
      const n = 1 + Math.floor(rand() * 60);
      const fragments: GelFragment[] = Array.from({ length: n }, (_, i) => ({
        size: Math.round(10 ** (1.3 + 3.5 * rand())),
        molarAmount: rand() < 0.1 ? 0 : 3 * rand() + 1e-3,
        form: forms[Math.floor(rand() * forms.length)],
        ...(rand() < 0.5 ? { label: `f${i}` } : {}),
      }));
      const resolution = rand() < 0.1 ? 0 : 0.03 * rand();
      const opts = { agarosePercent: 0.5 + 2.5 * rand(), buffer: (rand() < 0.5 ? 'TAE' : 'TBE') as GelBuffer, resolution };
      const bands = simulateLane(fragments, opts);
      const label = `trial ${trial}`;
      // every drawn fragment is in exactly one band, with its own data
      const seen = bands.flatMap((b) => b.fragments.map((f) => f.index)).sort((a, b) => a - b);
      const drawn = fragments.flatMap((f, i) => (f.molarAmount === 0 ? [] : [i]));
      expect(seen, label).toEqual(drawn);
      let maxIntensity = 0;
      bands.forEach((b, k) => {
        const spread = bandSpread(b);
        expect(spread < resolution || spread === 0, label).toBe(true);
        expect(b.count).toBe(b.fragments.length);
        expect(b.sizes).toEqual(b.fragments.map((f) => f.size));
        expect(b.labels).toEqual(b.fragments.flatMap((f) => (f.label === undefined ? [] : [f.label])));
        for (let i = 1; i < b.sizes.length; i++) expect(b.sizes[i]).toBeLessThanOrEqual(b.sizes[i - 1]);
        for (const f of b.fragments) {
          const input = fragments[f.index];
          expect(f.size).toBe(input.size);
          expect(f.form).toBe(input.form ?? 'linear');
          expect(f.label).toBe(input.label);
          expect(f.position).toBe(migrate(input.size, { ...opts, form: input.form }));
        }
        const positions = b.fragments.map((f) => f.position);
        expect(b.position).toBeGreaterThanOrEqual(Math.min(...positions));
        expect(b.position).toBeLessThanOrEqual(Math.max(...positions));
        expect(b.size).toBeGreaterThanOrEqual(b.sizes[b.sizes.length - 1]);
        expect(b.size).toBeLessThanOrEqual(b.sizes[0]);
        expect(b.intensity).toBeGreaterThan(0);
        expect(b.intensity).toBeLessThanOrEqual(1);
        maxIntensity = Math.max(maxIntensity, b.intensity);
        if (k > 0) {
          expect(b.position, label).toBeGreaterThan(bands[k - 1].position);
          // bands do not overlap, and neighbouring bands could not be merged within the resolution
          expect(Math.min(...positions), label).toBeGreaterThan(Math.max(...bands[k - 1].fragments.map((f) => f.position)));
          expect(mergedSpread(bands[k - 1], b), label).toBeGreaterThanOrEqual(resolution);
        }
      });
      if (bands.length > 0) expect(maxIntensity).toBe(1);
    }
  });
});

describe('review: a band lists its fragments (F3/F10)', () => {
  it('fragments pair every size with its label, form, position and input index, largest first', () => {
    const input: GelFragment[] = [{ size: 2150, label: 'insert' }, { size: 3000, form: 'supercoiled', label: 'uncut (SC)' }, { size: 2140 }];
    const bands = simulateLane(input);
    expect(bands).toHaveLength(1);
    const [band] = bands;
    expect(band.count).toBe(3);
    expect(band.sizes).toEqual([3000, 2150, 2140]);
    expect(band.labels).toEqual(['uncut (SC)', 'insert']);
    expect(band.fragments).toEqual([
      { index: 1, size: 3000, form: 'supercoiled', position: migrate(3000, { form: 'supercoiled' }), label: 'uncut (SC)' },
      { index: 0, size: 2150, form: 'linear', position: migrate(2150), label: 'insert' },
      { index: 2, size: 2140, form: 'linear', position: migrate(2140) },
    ]);
  });

  it('the input index counts omitted (zero-amount) fragments too', () => {
    const [band] = simulateLane([{ size: 500, molarAmount: 0 }, { size: 900, label: 'y' }]);
    expect(band.fragments).toEqual([{ index: 1, size: 900, form: 'linear', position: migrate(900), label: 'y' }]);
  });

  it('ladder fragments carry their row index and vendor label', () => {
    const bands = ladderLane(ladder('promega-1kb'));
    const last = bands[bands.length - 1];
    expect(last.fragments.map((f) => [f.index, f.size, f.label])).toEqual([[12, 253, '250/253'], [12, 250, '250/253']]);
    expect(bands[0].fragments).toEqual([{ index: 0, size: 10000, form: 'linear', position: migrate(10000), label: '10000' }]);
  });
});

describe('review: extreme but valid inputs never produce NaN (F4/F11)', () => {
  it('size x molarAmount overflowing to Infinity or underflowing to 0', () => {
    expect(simulateLane([{ size: 2000, molarAmount: 1e306 }])[0].intensity).toBe(1);
    expect(simulateLane([{ size: 0.5, molarAmount: 5e-324 }])[0].intensity).toBe(1);
    // the log-space fallback for such inputs is accurate to ~1e-13 (the direct path is exact)
    const twoHeavy = simulateLane([{ size: 2000, molarAmount: 1e306 }, { size: 1000, molarAmount: 1e306 }]);
    expect(twoHeavy[0].intensity).toBe(1);
    expect(twoHeavy[1].intensity).toBeCloseTo(0.5, 12);
    const mixed = simulateLane([{ size: 1e300, molarAmount: 1e10 }, { size: 1e-300, molarAmount: 1e-10 }]);
    expect(mixed.map((b) => b.intensity)).toEqual([1, 0]); // 1e-620 relative: below double precision
    const balanced = simulateLane([{ size: 1e300, molarAmount: 1e-300 }, { size: 1e-300, molarAmount: 1e300 }]);
    for (const b of balanced) expect(b.intensity).toBeCloseTo(1, 12);
  });

  it('sizes near the largest double merge into a finite band', () => {
    const [big, ...rest] = simulateLane([{ size: 1.5e308 }, { size: 1.7e308 }]);
    expect(rest).toEqual([]);
    expect(big.count).toBe(2);
    expect(big.size).toBeGreaterThanOrEqual(1.5e308);
    expect(big.size).toBeLessThanOrEqual(1.7e308);
    expect(big.intensity).toBe(1);
  });

  it('random extreme lanes: every number is finite (seeded)', () => {
    const rand = rng(7);
    for (let trial = 0; trial < 200; trial++) {
      const fragments = Array.from({ length: 1 + Math.floor(rand() * 8) }, () => ({
        size: 10 ** (600 * rand() - 300),
        molarAmount: 10 ** (600 * rand() - 300),
      }));
      for (const b of simulateLane(fragments, { resolution: 0.02 * rand() })) {
        for (const x of [b.size, b.position, b.intensity]) expect(Number.isFinite(x), JSON.stringify(fragments)).toBe(true);
        expect(b.intensity).toBeGreaterThanOrEqual(0);
        expect(b.intensity).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('review: ladder components are validated (F12)', () => {
  const custom = (row: Ladder['bands'][number]): Ladder => ({ id: 'c', name: 'c', vendor: 'lab', source: 'https://example.org', bands: [row] });

  it('rejects invalid component sizes, naming the ladder, row and component', () => {
    for (const bad of [Number.NaN, -3, 0, Number.POSITIVE_INFINITY]) {
      expect(() => ladderLane(custom({ size: 500, components: [517, bad] })), String(bad)).toThrow(RangeError);
      expect(message(() => ladderLane(custom({ size: 500, components: [517, bad] })))).toMatch(/^ladder 'c' bands\[0\]\.components\[1\]: /);
    }
  });

  it('a long components list does not overflow the call stack', () => {
    const components = Array.from({ length: 200_000 }, (_, i) => 1000 - i * 1e-4);
    const bands = ladderLane(custom({ size: 1000, components }));
    expect(bands.reduce((n, b) => n + b.count, 0)).toBe(200_000);
    expect(bands.every((b) => b.sizes.every((s) => Number.isFinite(s) && s > 0))).toBe(true);
  });
});

describe('review: validation errors name the fragment or ladder row (F6/F13)', () => {
  const pvuII = [{ size: 2364, label: 'PvuII-1' }, { size: 322, label: 'PvuII-2' }];

  it('simulateLane: size, molar amount and form', () => {
    expect(message(() => simulateLane([...pvuII, { size: 100, molarAmount: -1, label: 'custom-3' }]))).toBe(
      "fragments[2] ('custom-3'): molar amount must be a finite number >= 0, got -1",
    );
    expect(message(() => simulateLane([...pvuII, { size: Number.NaN, label: 'custom-3' }]))).toBe(
      "fragments[2] ('custom-3'): size must be a finite number > 0 bp, got NaN",
    );
    expect(message(() => simulateLane([{ size: 100 }, { size: 100, form: 'relaxed' as GelFragment['form'] }]))).toBe(
      "fragments[1]: unknown DNA form 'relaxed'",
    );
    expect(() => simulateLane([{ size: 100 }, { size: 100, form: 'relaxed' as GelFragment['form'] }])).toThrow(RangeError);
  });

  it('ladderLane: size and mass', () => {
    const base = { id: 'my-ladder', name: 'Mine', vendor: 'lab', source: 'https://example.org' };
    expect(message(() => ladderLane({ ...base, bands: [{ size: 3000 }, { size: 0 }] }))).toBe(
      "ladder 'my-ladder' bands[1]: size must be a finite number > 0 bp, got 0",
    );
    expect(message(() => ladderLane({ ...base, bands: [{ size: 3000, massNg: 5 }, { size: 1000, massNg: -1 }] }))).toBe(
      "ladder 'my-ladder' bands[1]: mass must be a finite number >= 0 ng, got -1",
    );
    expect(() => ladderLane({ ...base, bands: [{ size: 3000, massNg: 1e308 }, { size: 1000, massNg: 1e308 }] })).toThrow(
      /total mass must be finite/,
    );
  });
});

describe('review: one convention for multi-fragment ladder rows (F17)', () => {
  it('NEB 517 + 500 bp: the same 508.5 bp band in the 1 kb (two rows) and 1 kb Plus (one row) ladders', () => {
    for (const opts of [{}, { agarosePercent: 0.8 }, { agarosePercent: 1.2, buffer: 'TBE' as GelBuffer }]) {
      const a = ladderLane(ladder('neb-1kb'), opts).find((b) => b.sizes.includes(517)) as GelBand;
      const b = ladderLane(ladder('neb-1kb-plus'), opts).find((x) => x.sizes.includes(517)) as GelBand;
      expect(a.sizes).toEqual([517, 500]);
      expect(b.sizes).toEqual([517, 500]);
      expect(a.size).toBeCloseTo(508.5, 9);
      expect(b.size).toBeCloseTo(508.5, 9);
      expect(b.position).toBeCloseTo(a.position, 12);
    }
  });

  it('at resolution 0 the doublet separates in both ladders', () => {
    for (const id of ['neb-1kb', 'neb-1kb-plus', 'neb-100bp']) {
      const bands = ladderLane(ladder(id), { resolution: 0 });
      expect(bands.filter((b) => b.sizes.includes(517) || b.sizes.includes(500)).map((b) => b.sizes), id).toEqual([[517], [500]]);
    }
  });

  it('every built-in ladder band has the mass-weighted mean size and position of its fragments', () => {
    let doublets = 0;
    for (const l of LADDERS) {
      const withMass = l.bands.every((b) => b.massNg !== undefined);
      const weight = (row: number): number => (withMass ? (l.bands[row].massNg as number) : 1) / (l.bands[row].components?.length ?? 1);
      for (const band of ladderLane(l)) {
        const w = band.fragments.map((f) => weight(f.index));
        const total = w.reduce((a, b) => a + b, 0);
        expect(band.size, `${l.id} ${band.labels.join('+')}`).toBeCloseTo(band.fragments.reduce((s, f, i) => s + w[i] * f.size, 0) / total, 9);
        expect(band.position).toBeCloseTo(band.fragments.reduce((s, f, i) => s + w[i] * f.position, 0) / total, 12);
        if (band.count > 1) doublets++;
      }
    }
    expect(doublets).toBeGreaterThanOrEqual(4); // NEB 500/517 in three ladders, Promega 250/253
    const promega = ladderLane(ladder('promega-1kb'));
    expect(promega[promega.length - 1].size).toBeCloseTo(251.5, 9);
  });
});
