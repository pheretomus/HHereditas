import { describe, expect, it } from 'vitest';
import {
  complement,
  coveringRange,
  featureLabel,
  featureSequence,
  formatRange,
  intersectRanges,
  isDna,
  iupacMatches,
  iupacToRegexSource,
  makeFeature,
  normalizeDna,
  normalizeGap,
  normalizeRange,
  rangeContainsIndex,
  rangeFromInclusive,
  rangesOverlap,
  reverseComplement,
  sliceRange,
  splitAtOrigin,
} from './index';

describe('alphabet', () => {
  it('reverse-complements including IUPAC codes', () => {
    expect(reverseComplement('GAATTC')).toBe('GAATTC');
    expect(reverseComplement('AACG')).toBe('CGTT');
    expect(reverseComplement('RYSWKMBDHVN')).toBe('NBDHVKMWSRY');
    expect(reverseComplement('acgT')).toBe('Acgt');
    expect(complement('ACGT')).toBe('TGCA');
  });

  it('reverse complement is an involution on IUPAC strings', () => {
    const s = 'ACGTRYSWKMBDHVNNACGTTGCA';
    expect(reverseComplement(reverseComplement(s))).toBe(s);
  });

  it('normalizes pasted input and reports invalid characters', () => {
    expect(normalizeDna('  1 acgu nn\n 61 GGT-TA  ')).toEqual({ seq: 'ACGTNNGGTTA', invalid: [] });
    expect(normalizeDna('ACGXZ').invalid.sort()).toEqual(['X', 'Z']);
  });

  it('matches IUPAC codes', () => {
    expect(iupacMatches('R', 'A')).toBe(true);
    expect(iupacMatches('R', 'C')).toBe(false);
    expect(iupacMatches('N', 'R')).toBe(true);
    expect(iupacMatches('R', 'N')).toBe(false);
    expect(iupacToRegexSource('GGTNACC')).toBe('GGT[ACGT]ACC');
    expect(isDna('ACGTN')).toBe(true);
    expect(isDna('ACGU')).toBe(false);
  });
});

describe('range', () => {
  const L = 100;
  it('normalizes circular and linear ranges', () => {
    expect(normalizeRange({ start: 95, end: 105 }, L, 'circular')).toEqual({ start: 95, end: 105 });
    expect(normalizeRange({ start: 195, end: 205 }, L, 'circular')).toEqual({ start: 95, end: 105 });
    expect(normalizeRange({ start: 95, end: 5 }, L, 'circular')).toEqual({ start: 95, end: 105 });
    expect(normalizeRange({ start: 10, end: 500 }, L, 'circular')).toEqual({ start: 10, end: 110 });
    expect(normalizeRange({ start: -5, end: 120 }, L, 'linear')).toEqual({ start: 0, end: 100 });
    expect(normalizeGap(100, L, 'circular')).toBe(0);
    expect(normalizeGap(100, L, 'linear')).toBe(100);
  });

  it('converts inclusive coordinates', () => {
    expect(rangeFromInclusive(89, 9, L, 'circular')).toEqual({ start: 89, end: 110 });
    expect(rangeFromInclusive(9, 89, L, 'linear')).toEqual({ start: 9, end: 90 });
  });

  it('slices wrapping ranges', () => {
    const seq = 'ACGTACGTAC';
    expect(sliceRange(seq, { start: 8, end: 12 })).toBe('ACAC');
    expect(sliceRange(seq, { start: 0, end: 10 })).toBe(seq);
    expect(splitAtOrigin({ start: 8, end: 12 }, 10)).toEqual([
      { start: 8, end: 10 },
      { start: 0, end: 2 },
    ]);
  });

  it('tests containment and overlap across the origin', () => {
    const r = { start: 90, end: 110 };
    expect(rangeContainsIndex(r, 95, L, 'circular')).toBe(true);
    expect(rangeContainsIndex(r, 5, L, 'circular')).toBe(true);
    expect(rangeContainsIndex(r, 10, L, 'circular')).toBe(false);
    expect(rangesOverlap(r, { start: 5, end: 8 }, L, 'circular')).toBe(true);
    expect(rangesOverlap(r, { start: 10, end: 20 }, L, 'circular')).toBe(false);
    expect(rangesOverlap({ start: 0, end: 10 }, { start: 10, end: 20 }, L, 'linear')).toBe(false);
  });

  it('intersects arcs, including two-piece intersections', () => {
    expect(intersectRanges({ start: 90, end: 110 }, { start: 0, end: 50 }, L, 'circular')).toEqual([{ start: 0, end: 10 }]);
    // arc 80..120 (wraps) and arc 0..90 intersect in 0..20 and 80..90
    expect(intersectRanges({ start: 80, end: 120 }, { start: 0, end: 90 }, L, 'circular')).toEqual([
      { start: 0, end: 20 },
      { start: 80, end: 90 },
    ]);
    // pieces meeting at the origin merge back into one wrapping range
    expect(intersectRanges({ start: 90, end: 110 }, { start: 0, end: 100 }, L, 'circular')).toEqual([{ start: 90, end: 110 }]);
  });

  it('computes covering ranges of multi-segment features', () => {
    expect(coveringRange([{ start: 10, end: 20 }, { start: 30, end: 40 }], L, 'linear')).toEqual({ start: 10, end: 40 });
    expect(coveringRange([{ start: 90, end: 95 }, { start: 5, end: 10 }], L, 'circular')).toEqual({ start: 90, end: 110 });
  });

  it('formats ranges 1-based', () => {
    expect(formatRange({ start: 0, end: 10 }, L)).toBe('1..10');
    expect(formatRange({ start: 89, end: 110 }, L)).toBe('90..10');
  });
});

describe('features', () => {
  it('derives labels by qualifier priority', () => {
    expect(featureLabel('CDS', [{ key: 'note', value: 'x' }, { key: 'gene', value: 'bla' }])).toBe('bla');
    expect(featureLabel('CDS', [{ key: 'label', value: 'AmpR' }, { key: 'gene', value: 'bla' }])).toBe('AmpR');
    expect(featureLabel('misc_feature', [])).toBe('misc_feature');
  });

  it('extracts joined, reverse-strand feature sequences', () => {
    const seq = 'AAAACCCCGGGGTTTT';
    const f = makeFeature({ type: 'CDS', strand: -1, segments: [{ start: 0, end: 2 }, { start: 4, end: 6 }] });
    // top-strand pieces: 'AA' + 'CC' = 'AACC' -> revcomp 'GGTT'
    expect(featureSequence(f, seq)).toBe('GGTT');
    const wrap = makeFeature({ type: 'misc_feature', strand: 1, segments: [{ start: 14, end: 18 }] });
    expect(featureSequence(wrap, seq)).toBe('TTAA');
  });
});
