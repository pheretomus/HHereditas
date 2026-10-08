import { describe, expect, it } from 'vitest';
import {
  ECOLI_GENBANK,
  HAS_ECOLI,
  loadOracle,
  randomString,
  readGenbankSequence,
  seededRandom,
} from '../../test/oracle/seqtools/oracle';
import type { Orf, Topology } from '../types';
import { reverseComplement } from './alphabet';
import { findOrfs } from './orf';
import type { FindOrfsOptions } from './orf';
import { sliceRange } from './range';
import { TranslationError, translate } from './translate';

interface OracleOrf {
  start: number;
  end: number;
  strand: 1 | -1;
  frame: 0 | 1 | 2;
  aaLength: number;
  hasStop: boolean;
}
interface OrfCase {
  seq: string;
  topology: Topology;
  options: Required<FindOrfsOptions>;
  expected: OracleOrf[];
}

const oracle = loadOracle<{ cases: OrfCase[] }>('orfs.json');

function fromOracle(o: OracleOrf): Orf {
  return {
    range: { start: o.start, end: o.end },
    strand: o.strand,
    frame: o.frame,
    aaLength: o.aaLength,
    hasStop: o.hasStop,
  };
}

/** The ORF's own 5'->3' sequence. */
function orfSequence(seq: string, orf: Orf): string {
  const top = sliceRange(seq, orf.range);
  return orf.strand === 1 ? top : reverseComplement(top);
}

/** Compact key of an ORF ignoring `frame` (which depends on where the sequence starts). */
function orfKey(o: Orf, L: number, shift = 0): string {
  const start = (((o.range.start + shift) % L) + L) % L;
  return `${start}:${o.range.end - o.range.start}:${o.strand}:${o.aaLength}:${o.hasStop}`;
}

describe('findOrfs vs brute-force reference (orfs.json)', () => {
  it(`${oracle.cases.length} random cases (random/stop-poor/IUPAC/codon-soup sequences, all options)`, () => {
    let orfs = 0;
    for (const c of oracle.cases) {
      const got = findOrfs(c.seq, c.topology, c.options);
      expect(got, JSON.stringify({ seq: c.seq, topology: c.topology, options: c.options })).toEqual(
        c.expected.map(fromOracle),
      );
      orfs += got.length;
    }
    expect(orfs).toBeGreaterThan(500);
  });
});

describe('findOrfs', () => {
  const all: FindOrfsOptions = { minAaLength: 0 };

  it('returns nothing for empty and very short sequences', () => {
    for (const topology of ['linear', 'circular'] as const) {
      expect(findOrfs('', topology, all)).toEqual([]);
      expect(findOrfs('A', topology, all)).toEqual([]);
      expect(findOrfs('AT', topology, { ...all, allowNoStop: true })).toEqual([]);
    }
    expect(findOrfs('ATG', 'linear', all)).toEqual([]);
    expect(findOrfs('ATG', 'linear', { ...all, allowNoStop: true })).toEqual([
      { range: { start: 0, end: 3 }, strand: 1, frame: 0, aaLength: 1, hasStop: false },
    ]);
  });

  it('finds a forward ORF from start codon to stop codon inclusive', () => {
    expect(findOrfs('CCATGAAATAACC', 'linear', { ...all, strands: 'top' })).toEqual([
      { range: { start: 2, end: 11 }, strand: 1, frame: 2, aaLength: 2, hasStop: true },
    ]);
    expect(findOrfs('ATGTAA', 'linear', { ...all, strands: 'top' })).toEqual([
      { range: { start: 0, end: 6 }, strand: 1, frame: 0, aaLength: 1, hasStop: true },
    ]);
  });

  it('finds reverse-strand ORFs; frame counts from the end of the sequence', () => {
    const fwd = 'CCATGAAATAACCC'; // L = 14, ORF at [2, 11)
    const rc = reverseComplement(fwd); // ORF on the bottom strand at [3, 12)
    expect(findOrfs(rc, 'linear', { ...all, strands: 'bottom' })).toEqual([
      { range: { start: 3, end: 12 }, strand: -1, frame: 2, aaLength: 2, hasStop: true },
    ]);
    expect((14 - 12) % 3).toBe(2);
    expect(findOrfs(rc, 'linear', { ...all, strands: 'top' })).toEqual([]);
  });

  it('reports only the longest ORF per stop codon unless includeNested', () => {
    const s = 'ATGATGAAAATGTAA';
    expect(findOrfs(s, 'linear', { ...all, strands: 'top' })).toEqual([
      { range: { start: 0, end: 15 }, strand: 1, frame: 0, aaLength: 4, hasStop: true },
    ]);
    expect(findOrfs(s, 'linear', { ...all, strands: 'top', includeNested: true }).map((o) => o.range)).toEqual([
      { start: 0, end: 15 },
      { start: 3, end: 15 },
      { start: 9, end: 15 },
    ]);
  });

  it('applies minAaLength (default 100) to aaLength, stop excluded', () => {
    const orf = `ATG${'GCT'.repeat(99)}TAA`; // 100 aa
    expect(findOrfs(orf, 'linear', { strands: 'top' })).toHaveLength(1);
    expect(findOrfs(orf.slice(3), 'linear', { strands: 'top' })).toHaveLength(0); // no ATG
    expect(findOrfs(`ATG${'GCT'.repeat(98)}TAA`, 'linear', { strands: 'top' })).toHaveLength(0); // 99 aa
    expect(findOrfs(orf, 'linear', { strands: 'top', minAaLength: 100 })[0].aaLength).toBe(100);
  });

  it('finds ORFs that cross the origin of circular molecules', () => {
    // ATG at 8..10, AAA 11..13 | origin | TAA at 0..2  (L = 14)
    const s = 'TAAGGGGGATGAAA';
    expect(findOrfs(s, 'linear', { ...all, strands: 'top' })).toEqual([]);
    expect(findOrfs(s, 'circular', { ...all, strands: 'top' })).toEqual([
      { range: { start: 8, end: 17 }, strand: 1, frame: 2, aaLength: 2, hasStop: true },
    ]);
    // start codon itself split by the origin: TG...A
    const t = 'TGAAATAAGGGA'; // A(11) TG(0,1) AAA TAA
    expect(findOrfs(t, 'circular', { ...all, strands: 'top' })).toEqual([
      { range: { start: 11, end: 20 }, strand: 1, frame: 2, aaLength: 2, hasStop: true },
    ]);
  });

  it('handles ORFs touching positions 0 and L of circular molecules', () => {
    // ORF exactly [0, L): ends at the last base, does not wrap
    expect(findOrfs('ATGAAATAA', 'circular', { ...all, strands: 'top' })).toEqual([
      { range: { start: 0, end: 9 }, strand: 1, frame: 0, aaLength: 2, hasStop: true },
    ]);
    // ORF ending exactly at L, starting mid-sequence
    expect(findOrfs('CCCCATGTAA', 'circular', { ...all, strands: 'top' })).toEqual([
      { range: { start: 4, end: 10 }, strand: 1, frame: 1, aaLength: 1, hasStop: true },
    ]);
    // the stop codon itself wraps: ...TA | A...
    expect(findOrfs('AGGGATGAAATA', 'circular', { ...all, strands: 'top' })).toEqual([
      { range: { start: 4, end: 13 }, strand: 1, frame: 1, aaLength: 2, hasStop: true },
    ]);
  });

  it('maps wrapping bottom-strand ORFs to normalized top-strand ranges', () => {
    // top-strand view of a bottom-strand ORF TTA TTT CAT split across the origin
    const top = 'TTTCATGGGGGGTTA'; // reverse complement reads ...TAA GAA ATG -> ATG AAA TAA across the origin
    const orfs = findOrfs(top, 'circular', { ...all, strands: 'bottom' });
    expect(orfs).toEqual([{ range: { start: 12, end: 21 }, strand: -1, frame: 0, aaLength: 2, hasStop: true }]);
    expect(translate(reverseComplement(sliceRange(top, orfs[0].range)))).toBe('MK*');
  });

  it('reads across the origin into the shifted frame when L is not a multiple of 3', () => {
    // L = 10: ATG at 7..9, AAA at 0..2, TAA at 3..5 (frame 1 before the origin, frame 0 after it)
    const s = 'AAATAACATG';
    expect(findOrfs(s, 'linear', { ...all, strands: 'top' })).toEqual([]);
    expect(findOrfs(s, 'circular', { ...all, strands: 'top' })).toEqual([
      { range: { start: 7, end: 16 }, strand: 1, frame: 1, aaLength: 2, hasStop: true },
    ]);
  });

  it('caps circular ORFs at one full turn and reports stop-less frames only with allowNoStop', () => {
    const s = 'ATGAAAGGGCCC'; // L = 12, no stop codon in frame 0 on the top strand
    expect(findOrfs(s, 'circular', { ...all, strands: 'top' })).toEqual([]);
    expect(findOrfs(s, 'circular', { ...all, strands: 'top', allowNoStop: true })).toEqual([
      { range: { start: 0, end: 12 }, strand: 1, frame: 0, aaLength: 4, hasStop: false },
    ]);
    // every ATG of a repeat gives a full-turn ORF when nested ORFs are requested
    const repeat = 'ATG'.repeat(5);
    expect(findOrfs(repeat, 'circular', { ...all, strands: 'top', allowNoStop: true })).toHaveLength(1);
    const nested = findOrfs(repeat, 'circular', { ...all, strands: 'top', allowNoStop: true, includeNested: true });
    expect(nested).toHaveLength(5);
  });

  it('reports linear ORFs running off the 3\' end with allowNoStop', () => {
    const s = 'CATGAAAGGGCC';
    expect(findOrfs(s, 'linear', { ...all, strands: 'top' })).toEqual([]);
    expect(findOrfs(s, 'linear', { ...all, strands: 'top', allowNoStop: true })).toEqual([
      { range: { start: 1, end: 10 }, strand: 1, frame: 1, aaLength: 3, hasStop: false },
    ]);
  });

  it('uses the start and stop codons of the selected table', () => {
    const s = 'GTGAAATGAAAATAG';
    expect(findOrfs(s, 'linear', { ...all, strands: 'top' })).toEqual([]);
    expect(findOrfs(s, 'linear', { ...all, strands: 'top', startCodons: 'table', table: 11 })).toEqual([
      { range: { start: 0, end: 9 }, strand: 1, frame: 0, aaLength: 2, hasStop: true },
    ]);
    // vertebrate mitochondrial code: TGA = W, so the ORF runs to TAG; GTG and ATG start
    expect(findOrfs(s, 'linear', { ...all, strands: 'top', startCodons: 'table', table: 2 })).toEqual([
      { range: { start: 0, end: 15 }, strand: 1, frame: 0, aaLength: 4, hasStop: true },
    ]);
    expect(findOrfs('ATGAAAAGA', 'linear', { ...all, strands: 'top', table: 2 })).toEqual([
      { range: { start: 0, end: 9 }, strand: 1, frame: 0, aaLength: 2, hasStop: true },
    ]);
  });

  it('treats an ambiguous codon as a stop only when every expansion is a stop', () => {
    expect(findOrfs('ATGAAATAR', 'linear', { ...all, strands: 'top' })[0].range).toEqual({ start: 0, end: 9 });
    expect(findOrfs('ATGTANAAATAA', 'linear', { ...all, strands: 'top' })[0].range).toEqual({ start: 0, end: 12 });
    expect(findOrfs('ATGNNNTAA', 'linear', { ...all, strands: 'top' })[0].aaLength).toBe(2);
    // only ATG itself opens an ORF in 'ATG' mode; ambiguous codons that may be ATG do not
    expect(findOrfs('ATNAAATAA', 'linear', { ...all, strands: 'top' })).toEqual([]);
  });

  it('reads lower case and RNA', () => {
    expect(findOrfs('auggcuuaa', 'linear', { ...all, strands: 'top' })).toEqual(
      findOrfs('ATGGCTTAA', 'linear', { ...all, strands: 'top' }),
    );
  });

  it('sorts by start, then end, then strand', () => {
    const rand = seededRandom(5);
    const s = randomString(rand, 'ACGT', 3000);
    const orfs = findOrfs(s, 'circular', { minAaLength: 5, includeNested: true });
    for (let i = 1; i < orfs.length; i++) {
      const a = orfs[i - 1];
      const b = orfs[i];
      const order = a.range.start - b.range.start || a.range.end - b.range.end || b.strand - a.strand;
      expect(order).toBeLessThanOrEqual(0);
    }
  });

  it('rejects invalid input', () => {
    expect(() => findOrfs('ATGXTAA', 'linear')).toThrow(TranslationError);
    expect(() => findOrfs('ATG', 'linear', { table: 7 })).toThrow(RangeError);
    expect(() => findOrfs('ATG', 'linear', { minAaLength: -1 })).toThrow(RangeError);
    expect(() => findOrfs('ATG', 'linear', { minAaLength: Number.NaN })).toThrow(RangeError);
    expect(() => findOrfs('ATG', 'linear', { strands: 'up' as 'top' })).toThrow(RangeError);
    expect(() => findOrfs('ATG', 'linear', { startCodons: 'GTG' as 'ATG' })).toThrow(RangeError);
  });
});

describe('findOrfs invariants (seeded random)', () => {
  const rand = seededRandom(31337);
  const samples = Array.from({ length: 80 }, (_, i) => {
    const L = 3 + Math.floor(rand() * 400);
    // AT-rich sequences have fewer ATG... mix compositions; some stop-poor sequences
    const alphabet = i % 3 === 0 ? 'ACGT' : i % 3 === 1 ? 'AACCGGGT' : 'ACGTN';
    return randomString(rand, alphabet, L);
  });

  it('every ORF translates to M..* (or M... without stop) with no internal stop', () => {
    for (const s of samples) {
      for (const topology of ['linear', 'circular'] as const) {
        for (const o of findOrfs(s, topology, { minAaLength: 0, includeNested: true, allowNoStop: true })) {
          const nt = orfSequence(s, o);
          expect(nt.length % 3).toBe(0);
          expect(nt.length).toBeLessThanOrEqual(s.length);
          expect(nt.slice(0, 3)).toBe('ATG');
          const prot = translate(nt, { cds: true });
          expect(prot.length).toBe(o.aaLength + (o.hasStop ? 1 : 0));
          expect(prot.slice(0, -1).includes('*')).toBe(false);
          expect(prot.endsWith('*')).toBe(o.hasStop);
          expect(o.range.start).toBeGreaterThanOrEqual(0);
          expect(o.range.start).toBeLessThan(s.length);
          const L = s.length;
          const expectedFrame = o.strand === 1 ? o.range.start % 3 : (((L - o.range.end) % L) + L) % L % 3;
          expect(o.frame).toBe(expectedFrame);
        }
      }
    }
  });

  it('rotating a circular sequence rotates its ORFs', () => {
    for (const s of samples.slice(0, 40)) {
      const L = s.length;
      const r = Math.floor(rand() * L);
      const rotated = s.slice(r) + s.slice(0, r);
      for (const opts of [
        { minAaLength: 0 },
        { minAaLength: 0, includeNested: true, allowNoStop: true },
        { minAaLength: 3, startCodons: 'table' as const, table: 11 },
      ]) {
        const a = findOrfs(s, 'circular', opts)
          .filter((o) => o.hasStop || opts.includeNested === true)
          .map((o) => orfKey(o, L, -r))
          .sort();
        const b = findOrfs(rotated, 'circular', opts)
          .filter((o) => o.hasStop || opts.includeNested === true)
          .map((o) => orfKey(o, L))
          .sort();
        expect(b).toEqual(a);
      }
    }
  });

  it('the reverse complement swaps strands', () => {
    for (const s of samples.slice(0, 40)) {
      const L = s.length;
      for (const topology of ['linear', 'circular'] as const) {
        const mirror = (o: Orf): string => {
          let start = L - o.range.end;
          const len = o.range.end - o.range.start;
          if (start < 0) start += L;
          return `${start}:${len}:${-o.strand}:${o.aaLength}:${o.hasStop}`;
        };
        const a = findOrfs(s, topology, { minAaLength: 0 }).map(mirror).sort();
        const b = findOrfs(reverseComplement(s), topology, { minAaLength: 0 })
          .map((o) => orfKey(o, L))
          .sort();
        expect(b).toEqual(a);
      }
    }
  });

  it('with nested ORFs, every linear ORF with a stop is also found on the circular molecule', () => {
    for (const s of samples) {
      const circular = findOrfs(s, 'circular', { minAaLength: 0, includeNested: true });
      const circ = new Set(circular.map((o) => orfKey(o, s.length)));
      for (const o of findOrfs(s, 'linear', { minAaLength: 0, includeNested: true })) {
        expect(circ.has(orfKey(o, s.length))).toBe(true);
      }
    }
  });

  it('non-nested ORFs are the longest members of the nested families', () => {
    for (const s of samples) {
      for (const topology of ['linear', 'circular'] as const) {
        const nested = findOrfs(s, topology, { minAaLength: 0, includeNested: true });
        const longest = new Map<string, Orf>();
        for (const o of nested) {
          // family: strand + stop codon position
          const stopEnd = o.strand === 1 ? o.range.end % s.length : o.range.start % s.length;
          const key = `${o.strand}:${stopEnd}`;
          const prev = longest.get(key);
          if (!prev || o.aaLength > prev.aaLength) longest.set(key, o);
        }
        const expected = [...longest.values()].map((o) => orfKey(o, s.length)).sort();
        const got = findOrfs(s, topology, { minAaLength: 0 }).map((o) => orfKey(o, s.length)).sort();
        expect(got).toEqual(expected);
      }
    }
  });
});

describe.skipIf(!HAS_ECOLI)('findOrfs on the E. coli genome (4.6 Mb)', () => {
  const genome = HAS_ECOLI ? readGenbankSequence(ECOLI_GENBANK) : '';

  it('runs in < 2 s with default options on both strands of the circular genome', () => {
    expect(genome.length).toBe(4641652);
    const t0 = performance.now();
    const orfs = findOrfs(genome, 'circular');
    const ms = performance.now() - t0;
    expect(ms).toBeLessThan(2000);
    // sanity: thousands of ORFs >= 100 aa on both strands, all well-formed
    expect(orfs.length).toBeGreaterThan(3000);
    expect(orfs.some((o) => o.strand === -1)).toBe(true);
    for (const o of orfs.slice(0, 200)) {
      const prot = translate(orfSequence(genome, o));
      expect(prot[0]).toBe('M');
      expect(prot.indexOf('*')).toBe(prot.length - 1);
    }
  });

  it('finds the lacZ ORF (b0344, complement(363231..366305)) as a 1024 aa ORF', () => {
    const lacZ = findOrfs(genome, 'circular', { minAaLength: 1000 }).find(
      (o) => o.strand === -1 && o.range.start === 363230 && o.range.end === 366305,
    );
    // frame of a strand -1 ORF counts from the end: (4641652 - 366305) % 3 = 2
    expect(lacZ).toEqual({
      range: { start: 363230, end: 366305 },
      strand: -1,
      frame: 2,
      aaLength: 1024,
      hasStop: true,
    });
  });

  it('runs with every option combination in reasonable time', () => {
    const t0 = performance.now();
    const opts = { minAaLength: 30, includeNested: true, startCodons: 'table', table: 11 } as const;
    const nested = findOrfs(genome, 'circular', opts);
    expect(nested.length).toBeGreaterThan(10000);
    expect(performance.now() - t0).toBeLessThan(4000);
  });
});
