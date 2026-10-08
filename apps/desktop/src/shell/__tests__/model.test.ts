import './setup';
import { describe, expect, it } from 'vitest';
import type { EnzymeSite, Feature, SeqRecord } from '@hhereditas/core';
import { formatCompactLength, formatDocumentSubtitle, formatLength, formatPercent } from '../format';
import { featureTypeLabel, featureTypeOptions, qualifierLabel } from '../featureTypes';
import { formatFeatureLocation } from '../Inspector';
import {
  buildSequenceIndex,
  countBases,
  describeCaret,
  formatSelectionRange,
  formatSelectionStatus,
  gcPercent,
  summarizeSelection,
  summarizeSequence,
} from '../selectionSummary';
import { enzymeRows, featureRows, matchesFilter, primerRows } from '../sidebarModel';
import { toolbarDensity } from '../ToolbarContent';

function naive(seq: string, start: number, end: number) {
  const c = { a: 0, c: 0, g: 0, t: 0, s: 0, w: 0, other: 0 };
  for (let i = start; i < end; i++) {
    const ch = seq[i].toUpperCase();
    if (ch === 'A') c.a++;
    else if (ch === 'C') c.c++;
    else if (ch === 'G') c.g++;
    else if (ch === 'T' || ch === 'U') c.t++;
    else if (ch === 'S') c.s++;
    else if (ch === 'W') c.w++;
    else c.other++;
  }
  return c;
}

function randomSeq(n: number, seed: number): string {
  const alphabet = 'ACGTACGTACGTNSWacgt';
  let x = seed;
  let out = '';
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    out += alphabet[x % alphabet.length];
  }
  return out;
}

describe('base counting with a block index', () => {
  it('matches a naive count for many random ranges and block sizes', () => {
    for (const blockSize of [1, 7, 16, 1024]) {
      const seq = randomSeq(1000, blockSize);
      const index = buildSequenceIndex(seq, blockSize);
      let x = 99;
      for (let k = 0; k < 200; k++) {
        x = (x * 69069 + 1) & 0x7fffffff;
        const a = x % 1001;
        x = (x * 69069 + 1) & 0x7fffffff;
        const b = x % 1001;
        const [start, end] = a <= b ? [a, b] : [b, a];
        const got = countBases(seq, { start, end }, index);
        const want = naive(seq, start, end);
        expect({ ...got, total: undefined }).toEqual({ ...want, total: undefined });
        expect(got.total).toBe(end - start);
      }
    }
  });

  it('counts origin-spanning ranges on circular sequences', () => {
    const seq = 'GGGGAAAACC';
    const comp = countBases(seq, { start: 8, end: 12 }, buildSequenceIndex(seq, 4)); // C C G G
    expect(comp).toMatchObject({ c: 2, g: 2, a: 0, total: 4 });
  });

  it('ignores an index built for another sequence', () => {
    const index = buildSequenceIndex('AAAA', 2);
    expect(countBases('GGGG', { start: 0, end: 4 }, index)).toMatchObject({ g: 4 });
  });

  it('computes GC % from G, C, S over the strength-known bases', () => {
    expect(gcPercent(countBases('GCAT', { start: 0, end: 4 }))).toBe(50);
    expect(gcPercent(countBases('SSWN', { start: 0, end: 4 }))).toBeCloseTo(66.667, 2);
    expect(gcPercent(countBases('NNNN', { start: 0, end: 4 }))).toBeNull();
  });
});

const circular = { seq: 'ATGC'.repeat(1000), topology: 'circular' as const }; // 4,000 bp, GC 50 %
const linear = { seq: 'GGCCAATT'.repeat(250), topology: 'linear' as const }; // 2,000 bp

describe('summarizeSelection', () => {
  it('returns null without a selection', () => {
    expect(summarizeSelection(circular, null)).toBeNull();
  });

  it('describes a caret', () => {
    const s = summarizeSelection(circular, { range: { start: 1256, end: 1256 }, caret: 1256 })!;
    expect(s.hasBases).toBe(false);
    expect(s.composition).toBeNull();
    expect(formatSelectionStatus(s)).toBe('Cursor after base 1,256');
  });

  it('summarizes a selection with 1-based inclusive bounds', () => {
    const s = summarizeSelection(circular, { range: { start: 395, end: 1256 }, caret: 1256 })!;
    expect(s).toMatchObject({ hasBases: true, length: 861, first: 396, last: 1256, wrapsOrigin: false });
    expect(formatSelectionRange(s)).toBe('396..1,256');
    expect(formatSelectionStatus(s)).toMatch(/^Selection 396\.\.1,256 · 861 bp · GC \d+\.\d %$/);
  });

  it('handles origin-spanning and whole-circle selections', () => {
    const wrap = summarizeSelection(circular, { range: { start: 3900, end: 4100 }, caret: 100 })!;
    expect(wrap).toMatchObject({ first: 3901, last: 100, length: 200, wrapsOrigin: true, caret: 100 });
    expect(formatSelectionRange(wrap)).toBe('3,901..100');
    expect(wrap.gcPercent).toBe(50);
    const whole = summarizeSelection(circular, { range: { start: 0, end: 4000 }, caret: 0 })!;
    expect(whole).toMatchObject({ first: 1, last: 4000, length: 4000, wrapsOrigin: false });
  });

  it('clamps linear selections and reports single bases plainly', () => {
    const one = summarizeSelection(linear, { range: { start: 9, end: 10 }, caret: 10 })!;
    expect(formatSelectionRange(one)).toBe('10');
    const clamped = summarizeSelection(linear, { range: { start: 1990, end: 2500 }, caret: 2500 })!;
    expect(clamped).toMatchObject({ length: 10, last: 2000, caret: 2000 });
  });

  it('uses the protein unit and omits GC for proteins', () => {
    const s = summarizeSelection({ seq: 'MKTAYIAKQR', topology: 'linear' }, { range: { start: 0, end: 4 }, caret: 4 })!;
    expect(formatSelectionStatus(s, 'protein')).toBe('Selection 1..4 · 4 aa');
  });

  it('summarizes a 4.6 Mb sequence quickly through the index', () => {
    const seq = 'ACGTTGCA'.repeat(580_207); // 4,641,656 bp
    const record = { seq, topology: 'circular' as const };
    const index = buildSequenceIndex(seq);
    const t0 = performance.now();
    for (let i = 0; i < 200; i++) {
      summarizeSelection(record, { range: { start: 1000 + i, end: 4_000_000 + i }, caret: 0 }, index);
    }
    const perCall = (performance.now() - t0) / 200;
    expect(perCall).toBeLessThan(1);
    expect(summarizeSequence(record, index).total).toBe(seq.length);
  });
});

describe('describeCaret', () => {
  it('names the ends of linear and circular sequences', () => {
    expect(describeCaret(0, 100, 'linear')).toBe('at the start');
    expect(describeCaret(100, 100, 'linear')).toBe('at the end');
    expect(describeCaret(0, 100, 'circular')).toBe('at the origin');
    expect(describeCaret(42, 100, 'circular')).toBe('after base 42');
    expect(describeCaret(0, 0, 'linear')).toBe('in an empty sequence');
  });
});

describe('formatting', () => {
  it('formats lengths and subtitles', () => {
    expect(formatLength(3938)).toBe('3,938 bp');
    expect(formatLength(301, 'protein')).toBe('301 aa');
    expect(formatCompactLength(860)).toBe('860 bp');
    expect(formatCompactLength(3938)).toBe('3.94 kb');
    expect(formatCompactLength(4_641_652)).toBe('4.64 Mb');
    expect(formatDocumentSubtitle(3938, 'circular')).toBe('3,938 bp · circular');
    expect(formatDocumentSubtitle(301, 'linear', 'protein')).toBe('301 aa');
    expect(formatPercent(52.25)).toBe('52.3 %');
  });

  it('formats feature locations, including joins and origin-spanning segments', () => {
    expect(formatFeatureLocation({ segments: [{ start: 395, end: 1256 }] }, 4000)).toBe('396..1,256');
    expect(formatFeatureLocation({ segments: [{ start: 0, end: 10 }, { start: 19, end: 20 }] }, 4000)).toBe('1..10, 20');
    expect(formatFeatureLocation({ segments: [{ start: 3990, end: 4010 }] }, 4000)).toBe('3,991..10');
  });

  it('labels feature types and qualifiers readably', () => {
    expect(featureTypeLabel('rep_origin')).toBe('Replication origin');
    expect(featureTypeLabel('mobile_element')).toBe('mobile element');
    expect(qualifierLabel('codon_start')).toBe('Codon start');
    expect(featureTypeOptions('oriT').at(-1)).toEqual({ value: 'oriT', label: 'oriT' });
    expect(featureTypeOptions('CDS').filter((o) => o.value === 'CDS')).toHaveLength(1);
  });
});

function feature(id: string, name: string, start: number, end: number, extra: Partial<Feature> = {}): Feature {
  return { id, type: 'CDS', name, strand: 1, segments: [{ start, end }], qualifiers: [], ...extra };
}

describe('sidebar model', () => {
  const record: Pick<SeqRecord, 'features' | 'seq' | 'topology'> = {
    seq: 'A'.repeat(5000),
    topology: 'circular',
    features: [
      feature('src', 'source', 0, 5000, { type: 'source' }),
      feature('b', 'ori', 2000, 2589, { type: 'rep_origin', strand: -1 }),
      feature('a', 'AmpR', 100, 961),
      feature('c', 'lac', 100, 200, { color: '#123456' }),
      feature('w', 'wrap', 4900, 5100),
    ],
  };

  it('lists features by position (longer first at the same start) and hides "source"', () => {
    const rows = featureRows(record);
    expect(rows.map((r) => r.id)).toEqual(['a', 'c', 'b', 'w']);
    expect(rows[0]).toMatchObject({ length: 861, start: 100, strand: 1, color: 'var(--hh-feature-cds)' });
    expect(rows[1].color).toBe('#123456');
    expect(rows[2]).toMatchObject({ type: 'rep_origin', strand: -1, color: 'var(--hh-feature-rep-origin)' });
    expect(rows[3]).toMatchObject({ start: 4900, length: 200 });
  });

  it('groups enzyme sites with counts and sorted cut positions', () => {
    const site = (enzyme: string, top: number): EnzymeSite => ({
      enzyme,
      range: { start: top - 1, end: top + 5 },
      strand: 1,
      cuts: [{ top, bottom: top + 4 }],
    });
    const rows = enzymeRows([site('PstI', 900), site('BsmBI', 10), site('PstI', 30), site('BsaI', 50), site('EcoRI', 396)]);
    expect(rows.map((r) => r.name)).toEqual(['BsaI', 'BsmBI', 'EcoRI', 'PstI']);
    expect(rows[3]).toEqual({ name: 'PstI', count: 2, cuts: [30, 900] });
  });

  it('lists primers with their lengths and filters names', () => {
    expect(primerRows([{ id: 'p', name: '', sequence: 'ACGTACGTAC' }])).toEqual([{ id: 'p', name: 'Unnamed primer', length: 10 }]);
    expect(matchesFilter('AmpR promoter', ' PROM ')).toBe(true);
    expect(matchesFilter('ori', 'amp')).toBe(false);
    expect(matchesFilter('anything', '')).toBe(true);
  });
});

describe('toolbarDensity', () => {
  it('gets denser as the toolbar narrows', () => {
    expect(toolbarDensity(0)).toBe('regular');
    expect(toolbarDensity(1200)).toBe('regular');
    expect(toolbarDensity(820)).toBe('regular');
    expect(toolbarDensity(700)).toBe('compact');
    expect(toolbarDensity(560)).toBe('tight');
  });
});
