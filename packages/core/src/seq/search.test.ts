import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ECOLI_GENBANK,
  HAS_ECOLI,
  loadOracle,
  randomString,
  readGenbankSequence,
  seededRandom,
} from '../../test/oracle/seqtools/oracle';
import type { SearchHit, Topology } from '../types';
import { IUPAC_DNA, iupacMatches, reverseComplement } from './alphabet';
import { GENETIC_CODES, getGeneticCode } from './codon-tables';
import { makeFeature, makeRecord } from './features';
import { findOrfs } from './orf';
import { sliceRange } from './range';
import { searchProtein, searchSequence } from './search';
import type { ProteinSearchHit, SearchOptions } from './search';
import { TranslationError, translate, translateFeature } from './translate';

interface OracleHit {
  start: number;
  end: number;
  strand: 1 | -1;
  mismatches: number;
  frame?: 0 | 1 | 2;
}
interface ProteinCase {
  seq: string;
  topology: Topology;
  peptide: string;
  table: number;
  expected: OracleHit[];
}
interface SearchOracle {
  cases: { seq: string; topology: Topology; query: string; options: Required<SearchOptions>; expected: OracleHit[] }[];
  proteinCases: ProteinCase[];
  /** Peptides with U (matches TGA) and O (matches TAG). */
  recodedProteinCases: ProteinCase[];
}

const oracle = loadOracle<SearchOracle>('search.json');

function hit(o: OracleHit): SearchHit {
  return { range: { start: o.start, end: o.end }, strand: o.strand, mismatches: o.mismatches };
}
function proteinHit(o: OracleHit): ProteinSearchHit {
  return { ...hit(o), frame: o.frame as 0 | 1 | 2 };
}
function hitAt(start: number, end: number, strand: 1 | -1, frame: 0 | 1 | 2): ProteinSearchHit {
  return { range: { start, end }, strand, mismatches: 0, frame };
}
/** Compact hit list: 'start-end' + strand sign + mismatches, e.g. '2-8+0'. */
const short = (hits: SearchHit[]) =>
  hits.map((h) => `${h.range.start}-${h.range.end}${h.strand === 1 ? '+' : '-'}${h.mismatches}`);

describe('searchSequence vs brute-force reference (search.json)', () => {
  it(`${oracle.cases.length} random cases (IUPAC, mismatches, strands, wrap, palindromes)`, () => {
    let hits = 0;
    for (const c of oracle.cases) {
      const got = searchSequence(c.seq, c.topology, c.query, c.options);
      expect(got, JSON.stringify({ ...c, expected: undefined })).toEqual(c.expected.map(hit));
      hits += got.length;
    }
    expect(hits).toBeGreaterThan(1000);
  });
});

describe('searchProtein vs brute-force reference with Biopython translation (search.json)', () => {
  it(`${oracle.proteinCases.length} random cases (6 frames, wildcards, tables, wrap)`, () => {
    let hits = 0;
    for (const c of oracle.proteinCases) {
      const got = searchProtein(c.seq, c.topology, c.peptide, { table: c.table });
      expect(got, JSON.stringify({ ...c, expected: undefined })).toEqual(c.expected.map(proteinHit));
      hits += got.length;
    }
    expect(hits).toBeGreaterThan(100);
  });

  it(`${oracle.recodedProteinCases.length} cases with U (TGA), O (TAG) and '*' at context-dependent stops`, () => {
    let recodedHits = 0;
    let contextStopHits = 0;
    for (const c of oracle.recodedProteinCases) {
      const got = searchProtein(c.seq, c.topology, c.peptide, { table: c.table });
      expect(got, JSON.stringify({ ...c, expected: undefined })).toEqual(c.expected.map(proteinHit));
      if (/[UO]/.test(c.peptide)) recodedHits += got.length;
      if ([27, 28, 31].includes(c.table) && c.peptide.includes('*')) contextStopHits += got.length;
    }
    expect(recodedHits).toBeGreaterThan(100);
    expect(contextStopHits).toBeGreaterThan(50);
  });
});

describe('searchSequence', () => {
  it('finds exact, overlapping hits on the top strand', () => {
    expect(short(searchSequence('AAAA', 'linear', 'AA'))).toEqual(['0-2+0', '1-3+0', '2-4+0']);
    expect(short(searchSequence('CCGAGTCC', 'linear', 'GAG', { strands: 'top' }))).toEqual(['2-5+0']);
  });

  it('finds the reverse complement as a strand -1 hit', () => {
    // CTC is the reverse complement of GAG
    expect(short(searchSequence('CCCTCCC', 'linear', 'GAG'))).toEqual(['2-5-0']);
    expect(short(searchSequence('CCCTCCC', 'linear', 'GAG', { strands: 'top' }))).toEqual([]);
    expect(short(searchSequence('CCCTCCC', 'linear', 'GAG', { strands: 'bottom' }))).toEqual(['2-5-0']);
  });

  it('reports palindromic queries once', () => {
    expect(short(searchSequence('TTGAATTCTT', 'linear', 'GAATTC'))).toEqual(['2-8+0']);
    expect(short(searchSequence('TTGAATTCTT', 'linear', 'GAATTC', { strands: 'bottom' }))).toEqual(['2-8-0']);
    expect(short(searchSequence('TTGAATCTT', 'linear', 'GANTC'))).toEqual(['2-7+0']); // IUPAC palindrome (HinfI)
    expect(short(searchSequence('TTGAATTCTT', 'linear', 'GANTTC'))).toEqual(['2-8+0', '2-8-0']); // revcomp GAANTC
    // with mismatches the palindrome is still reported once per window
    const fuzzy = searchSequence('TTGAATTCTT', 'linear', 'GAATTC', { maxMismatches: 1 });
    expect(fuzzy.every((h) => h.strand === 1)).toBe(true);
  });

  it('finds hits across the origin of circular molecules only', () => {
    expect(short(searchSequence('TCCCCCCGAA', 'linear', 'GAAT'))).toEqual([]);
    expect(short(searchSequence('TCCCCCCGAA', 'circular', 'GAAT'))).toEqual(['7-11+0']);
    expect(short(searchSequence('TCCCCCCGAA', 'circular', 'ATTC'))).toEqual(['7-11-0']);
    expect(short(searchSequence('ACGT', 'circular', 'GTAC'))).toEqual(['2-6+0']); // GTAC is its own revcomp
  });

  it('positions 0 and L: hits at the very start and end', () => {
    expect(short(searchSequence('GGCCCCCCAA', 'linear', 'GG', { strands: 'top' }))).toEqual(['0-2+0']);
    expect(short(searchSequence('GGCCCCCCAA', 'linear', 'AA', { strands: 'top' }))).toEqual(['8-10+0']);
    expect(short(searchSequence('GGCCCCCCAA', 'circular', 'AAG', { strands: 'top' }))).toEqual(['8-11+0']);
  });

  it('matches IUPAC codes in the query; ambiguous sequence bases need a covering query code', () => {
    expect(short(searchSequence('GGACCGGTCC', 'linear', 'GGNCC', { strands: 'top' }))).toEqual(['0-5+0', '5-10+0']);
    expect(short(searchSequence('GGACC', 'linear', 'GGRCC', { strands: 'top' }))).toEqual(['0-5+0']);
    expect(short(searchSequence('GGCCC', 'linear', 'GGRCC', { strands: 'top' }))).toEqual([]);
    expect(short(searchSequence('GGNCC', 'linear', 'GGACC', { strands: 'top' }))).toEqual([]);
    expect(short(searchSequence('GGNCC', 'linear', 'GGNCC', { strands: 'top' }))).toEqual(['0-5+0']);
    expect(short(searchSequence('GGRCC', 'linear', 'GGDCC', { strands: 'top' }))).toEqual(['0-5+0']); // R ⊆ D
    expect(short(searchSequence('GGNCC', 'linear', 'GGACC', { strands: 'top', maxMismatches: 1 }))).toEqual(['0-5+1']);
  });

  it('iupac: false compares letters literally', () => {
    expect(short(searchSequence('GGACC', 'linear', 'GGNCC', { strands: 'top', iupac: false }))).toEqual([]);
    expect(short(searchSequence('GGNCC', 'linear', 'GGNCC', { strands: 'top', iupac: false }))).toEqual(['0-5+0']);
    expect(short(searchSequence('GGRCC', 'linear', 'GGDCC', { strands: 'top', iupac: false }))).toEqual([]);
  });

  it('counts mismatches up to maxMismatches', () => {
    const s = 'AAAAACGTACGTAAAAA';
    expect(short(searchSequence(s, 'linear', 'ACGTACGT', { strands: 'top' }))).toEqual(['4-12+0']);
    expect(short(searchSequence(s, 'linear', 'ACGTTCGT', { strands: 'top' }))).toEqual([]);
    expect(short(searchSequence(s, 'linear', 'ACGTTCGT', { strands: 'top', maxMismatches: 1 }))).toEqual(['4-12+1']);
    expect(short(searchSequence(s, 'linear', 'TCGTTCGA', { strands: 'top', maxMismatches: 3 }))).toEqual(['4-12+3']);
    expect(short(searchSequence(s, 'linear', 'TCGTTCGA', { strands: 'top', maxMismatches: 2 }))).toEqual([]);
  });

  it('is case-insensitive and reads U as T', () => {
    expect(short(searchSequence('ccgagtcc', 'linear', 'gag', { strands: 'top' }))).toEqual(['2-5+0']);
    expect(short(searchSequence('CCGAGUCC', 'linear', 'AGT', { strands: 'top' }))).toEqual(['3-6+0']);
    expect(short(searchSequence('CCGAGTCC', 'linear', 'AGU', { strands: 'top' }))).toEqual(['3-6+0']);
  });

  it('never matches non-IUPAC characters of the sequence', () => {
    expect(short(searchSequence('AC-GT', 'linear', 'ACNGT', { strands: 'top' }))).toEqual([]);
    expect(short(searchSequence('AC-GT', 'linear', 'ACNGT', { strands: 'top', maxMismatches: 1 }))).toEqual(['0-5+1']);
  });

  it('handles empty, too long and invalid queries', () => {
    expect(searchSequence('ACGT', 'linear', '')).toEqual([]);
    expect(searchSequence('', 'circular', 'A')).toEqual([]);
    expect(searchSequence('ACG', 'linear', 'ACGT')).toEqual([]);
    expect(searchSequence('ACG', 'circular', 'ACGA')).toEqual([]);
    expect(short(searchSequence('ACG', 'circular', 'ACG', { strands: 'top' }))).toEqual(['0-3+0']);
    expect(short(searchSequence('A', 'circular', 'A'))).toEqual(['0-1+0']);
    expect(() => searchSequence('ACGT', 'linear', 'ACX')).toThrow(RangeError);
    expect(() => searchSequence('ACGT', 'linear', 'A😀')).toThrow(/'😀' at index 1/);
    expect(() => searchSequence('ACGT', 'linear', 'Aı')).toThrow(/'ı' at index 1/);
    expect(() => searchSequence('ACGT', 'linear', 'AC GT')).toThrow(RangeError);
    expect(() => searchSequence('ACGT', 'linear', 'AC', { maxMismatches: 4 })).toThrow(RangeError);
    expect(() => searchSequence('ACGT', 'linear', 'AC', { maxMismatches: 1.5 })).toThrow(RangeError);
    expect(() => searchSequence('ACGT', 'linear', 'AC', { strands: 'x' as 'top' })).toThrow(RangeError);
  });
});

describe('searchSequence invariants (seeded random)', () => {
  const rand = seededRandom(2718);
  const cases = Array.from({ length: 120 }, () => {
    const L = 1 + Math.floor(rand() * 300);
    const seq = randomString(rand, rand() < 0.2 ? 'ACGTN' : 'ACGT', L);
    const m = 1 + Math.floor(rand() * 10);
    const query = randomString(rand, rand() < 0.3 ? 'ACGTRYN' : 'ACGT', m);
    const k = Math.floor(rand() * 4);
    return { seq, query, k };
  });

  it('every hit has the reported number of mismatches (naive recount with iupacMatches)', () => {
    for (const { seq, query, k } of cases) {
      for (const topology of ['linear', 'circular'] as const) {
        for (const h of searchSequence(seq, topology, query, { maxMismatches: k })) {
          const window = sliceRange(seq, h.range);
          const pattern = h.strand === 1 ? query : reverseComplement(query);
          let mm = 0;
          for (let i = 0; i < pattern.length; i++) if (!iupacMatches(pattern[i], window[i])) mm++;
          expect(mm).toBe(h.mismatches);
          expect(mm).toBeLessThanOrEqual(k);
        }
      }
    }
  });

  it('hits with k mismatches are a subset of hits with k + 1', () => {
    for (const { seq, query, k } of cases.slice(0, 60)) {
      if (k === 3) continue;
      const windows = (mm: number) =>
        new Set(short(searchSequence(seq, 'circular', query, { maxMismatches: mm })).map((s) => s.slice(0, -1)));
      const a = windows(k);
      const b = windows(k + 1);
      for (const h of a) expect(b.has(h)).toBe(true);
    }
  });

  it('rotating a circular sequence rotates the hits', () => {
    for (const { seq, query, k } of cases.slice(0, 60)) {
      const L = seq.length;
      const r = Math.floor(rand() * L);
      const rotated = seq.slice(r) + seq.slice(0, r);
      const key = (h: SearchHit, shift: number) =>
        `${(((h.range.start + shift) % L) + L) % L}:${h.strand}:${h.mismatches}`;
      const a = searchSequence(seq, 'circular', query, { maxMismatches: k }).map((h) => key(h, -r)).sort();
      const b = searchSequence(rotated, 'circular', query, { maxMismatches: k }).map((h) => key(h, 0)).sort();
      expect(b).toEqual(a);
    }
  });

  it('searching the reverse complement of the query swaps strands (non-palindromic queries)', () => {
    for (const { seq, query, k } of cases) {
      if (reverseComplement(query) === query) continue;
      const a = searchSequence(seq, 'linear', query, { maxMismatches: k }).map(
        (h) => `${h.range.start}:${h.strand}:${h.mismatches}`,
      );
      const b = searchSequence(seq, 'linear', reverseComplement(query), { maxMismatches: k })
        .map((h) => `${h.range.start}:${-h.strand}:${h.mismatches}`)
        .sort();
      expect(b).toEqual([...a].sort());
    }
  });

  it('results are sorted by start then strand', () => {
    for (const { seq, query, k } of cases) {
      const hits = searchSequence(seq, 'circular', query, { maxMismatches: k });
      for (let i = 1; i < hits.length; i++) {
        const order = hits[i - 1].range.start - hits[i].range.start || hits[i].strand - hits[i - 1].strand;
        expect(order).toBeLessThan(0);
      }
    }
  });
});

describe('searchProtein', () => {
  it('finds a peptide on the top strand in any frame', () => {
    const s = 'CCATGGCTTGGTAACC'; // frame 2: ATG GCT TGG TAA -> M A W *
    expect(searchProtein(s, 'linear', 'MAW')).toEqual([hitAt(2, 11, 1, 2)]);
    expect(searchProtein(s, 'linear', 'MAW*')).toEqual([hitAt(2, 14, 1, 2)]);
    expect(searchProtein(s, 'linear', 'maw')).toHaveLength(1);
  });

  it('finds a peptide on the bottom strand; frame counts from the end', () => {
    const fwd = 'CCATGGCTTGGTAACC';
    const rc = reverseComplement(fwd); // L = 16; peptide encoded at rc-local 2..11 -> top [5, 14)
    expect(searchProtein(rc, 'linear', 'MAW')).toEqual([hitAt(5, 14, -1, 2)]);
    expect(translate(reverseComplement(sliceRange(rc, { start: 5, end: 14 })))).toBe('MAW');
  });

  it('finds peptides encoded across the origin', () => {
    const s = 'GCTTGGCCCCATG'; // ...ATG | GCT TGG
    expect(searchProtein(s, 'linear', 'MAW')).toEqual([]);
    expect(searchProtein(s, 'circular', 'MAW')).toEqual([hitAt(10, 19, 1, 1)]);
  });

  it('supports X, B, Z and J in the peptide', () => {
    const s = 'ATGGATGAAATT'; // M D E I
    expect(searchProtein(s, 'linear', 'MXEI')).toHaveLength(1);
    expect(searchProtein(s, 'linear', 'MBZJ')).toHaveLength(1);
    expect(searchProtein(s, 'linear', 'MBZX')).toHaveLength(1);
    expect(searchProtein(s, 'linear', 'MZ')).toHaveLength(0);
    expect(searchProtein('ATGTAA', 'linear', 'MX')).toHaveLength(0); // X does not match a stop
    expect(searchProtein('ATGTAA', 'linear', 'M*')).toHaveLength(1);
  });

  it('uses the selected genetic code', () => {
    expect(searchProtein('ATGTGA', 'linear', 'MW')).toEqual([]);
    expect(searchProtein('ATGTGA', 'linear', 'MW', { table: 2 })).toHaveLength(1);
    expect(searchProtein('ATGTGA', 'linear', 'MW', { table: 27 })).toHaveLength(1); // context stop read as W
  });

  it('matches translated ambiguity letters literally', () => {
    expect(searchProtein('ATGGCN', 'linear', 'MA')).toHaveLength(1); // GCN -> A
    expect(searchProtein('ATGRAY', 'linear', 'MB')).toHaveLength(1); // RAY -> B
    expect(searchProtein('ATGRAY', 'linear', 'MD')).toHaveLength(0);
    expect(searchProtein('ATGRAY', 'linear', 'MX')).toHaveLength(1);
  });

  it('handles empty/too long peptides and rejects invalid input', () => {
    expect(searchProtein('ATG', 'linear', '')).toEqual([]);
    expect(searchProtein('A', 'circular', 'M')).toEqual([]);
    expect(searchProtein('', 'linear', 'M')).toEqual([]);
    expect(searchProtein('ATG', 'circular', 'M')).toEqual([hitAt(0, 3, 1, 0)]);
    expect(searchProtein('ATG', 'linear', 'MM')).toEqual([]);
    expect(searchProtein('ATGATG', 'circular', 'MMM')).toEqual([]);
    expect(() => searchProtein('ATG', 'linear', 'M1')).toThrow(RangeError);
    expect(() => searchProtein('ATG', 'linear', 'M', { table: 7 })).toThrow(RangeError);
    expect(() => searchProtein('ATGX', 'linear', 'M')).toThrow(TranslationError);
  });

  // Review regression: U and O were accepted but could never match (no table translates a codon to
  // U or O), so selenoprotein peptides silently gave no hits.
  it('peptide U (selenocysteine) matches a TGA codon, O (pyrrolysine) a TAG codon', () => {
    expect(searchProtein('ATGTGAAAA', 'linear', 'MUK')).toEqual([hitAt(0, 9, 1, 0)]);
    const mrna = 'ATGTGAAAATAA'; // Met-Sec(TGA)-Lys-stop, as in a selenoprotein mRNA
    expect(searchProtein(mrna, 'linear', 'M*K')).toEqual([hitAt(0, 9, 1, 0)]);
    expect(searchProtein(mrna, 'linear', 'MUK')).toEqual([hitAt(0, 9, 1, 0)]);
    expect(searchProtein(mrna, 'linear', 'muk')).toEqual([hitAt(0, 9, 1, 0)]);
    expect(searchProtein(mrna, 'linear', 'MUK*')).toEqual([hitAt(0, 12, 1, 0)]);
    expect(searchProtein('CCATGTAGAAA', 'linear', 'MOK')).toEqual([hitAt(2, 11, 1, 2)]);
    // only the recoded stop codon: U is not TAA/TAG, O is not TGA/TAA, and ambiguous codons do not match
    expect(searchProtein('ATGTAAAAA', 'linear', 'MUK')).toEqual([]);
    expect(searchProtein('ATGTAGAAA', 'linear', 'MUK')).toEqual([]);
    expect(searchProtein('ATGTGAAAA', 'linear', 'MOK')).toEqual([]);
    expect(searchProtein('ATGTGRAAA', 'linear', 'MUK')).toEqual([]);
    expect(searchProtein('ATGTGAAAA', 'linear', 'MXK')).toEqual([]); // X is any residue, not a stop
    // whatever the table makes of TGA (W in table 2, C in table 10), U still matches it
    for (const table of [2, 10, 25]) expect(searchProtein('ATGTGAAAA', 'linear', 'MUK', { table })).toHaveLength(1);
    expect(searchProtein('ATGTGAAAA', 'linear', 'MWK', { table: 2 })).toHaveLength(1);
    // RNA, the bottom strand and the origin
    expect(searchProtein('AUGUGAAAA', 'linear', 'MUK')).toEqual([hitAt(0, 9, 1, 0)]);
    expect(searchProtein(reverseComplement('GGATGTGAAAA'), 'linear', 'MUK')).toEqual([hitAt(0, 9, -1, 2)]);
    expect(searchProtein('GAAAACCATGT', 'circular', 'MUK')).toEqual([hitAt(7, 16, 1, 1)]);
  });

  // Same root cause as U / O: matching translated residues only, '*' could never match in tables 27,
  // 28 and 31, whose stop codons are context-dependent and translate to an amino acid.
  it("'*' matches every stop codon of the table, context-dependent ones included", () => {
    expect(searchProtein('ATGTGA', 'linear', 'M*', { table: 27 })).toEqual([hitAt(0, 6, 1, 0)]); // TGA: W or stop
    expect(searchProtein('ATGTGA', 'linear', 'MW', { table: 27 })).toEqual([hitAt(0, 6, 1, 0)]);
    expect(searchProtein('ATGTGA', 'linear', 'MX', { table: 27 })).toEqual([hitAt(0, 6, 1, 0)]); // X: W
    expect(searchProtein('ATGTAA', 'linear', 'M*', { table: 27 })).toEqual([]); // TAA is only Q in table 27
    expect(searchProtein('ATGTAA', 'linear', 'M*', { table: 31 })).toEqual([hitAt(0, 6, 1, 0)]); // E or stop
    expect(searchProtein('ATGTAA', 'linear', 'ME', { table: 31 })).toEqual([hitAt(0, 6, 1, 0)]);
    expect(searchProtein('ATGTAR', 'linear', 'M*', { table: 28 })).toEqual([hitAt(0, 6, 1, 0)]); // TAA, TAG: Q or stop
    expect(searchProtein('ATGTAR', 'linear', 'MQ', { table: 28 })).toEqual([hitAt(0, 6, 1, 0)]);
    expect(searchProtein('ATGTRA', 'linear', 'M*', { table: 27 })).toEqual([]); // TAA (Q) or TGA (W or stop)
    // tables without context-dependent stops are unchanged
    expect(searchProtein('ATGTAA', 'linear', 'M*')).toEqual([hitAt(0, 6, 1, 0)]);
    expect(searchProtein('ATGTAR', 'linear', 'M*')).toEqual([hitAt(0, 6, 1, 0)]);
    expect(searchProtein('ATGTAN', 'linear', 'M*')).toEqual([]); // TAN may be Tyr
    expect(searchProtein('ATGTAA', 'linear', 'MX')).toEqual([]);
  });

  // Review regression: String.prototype.toUpperCase maps some non-ASCII letters to ASCII ones
  // ('ı' -> 'I', 'ſ' -> 'S'), so they were accepted as amino acids.
  it('rejects non-ASCII letters that upper-case to amino-acid letters', () => {
    expect(() => searchProtein('ATGATT', 'linear', 'Mı')).toThrow(RangeError); // dotless i
    expect(() => searchProtein('ATGTCT', 'linear', 'Mſ')).toThrow(RangeError); // long s
    expect(() => searchProtein('ATGTCTTCT', 'linear', 'Mß')).toThrow(/'ß' at index 1/);
    expect(() => searchProtein('ATGTTTATT', 'linear', 'Mﬁ')).toThrow(RangeError);
    expect(() => searchProtein('ATGTTT', 'linear', 'M😀')).toThrow(/'😀' at index 1/);
  });

  // Review regression: every peptide letter, the first included, was matched against the codon's
  // internal translation only, so the N-terminal Met of a protein whose gene starts with an
  // alternative start codon (GTG, TTG, ATT, ...) never matched: 10.7% of E. coli genes could not be
  // found by their own N-terminal peptide, and translateFeature -> searchProtein did not round-trip.
  describe('review: nTerminal, the initiator Met of an alternative start codon', () => {
    // E. coli lacI (U00096.3 complement(366428..367510), UniProt P03023): the first 42 nt
    const lacI5 = 'GTGAAACCAGTAACGTTATACGATGTCGCAGAGTATGCCGGT';
    const t11 = [{ key: 'transl_table', value: '11' }];

    it('finds E. coli lacI (GTG start) by the N-terminal peptide translateFeature gives', () => {
      const cds = makeFeature({ type: 'CDS', strand: 1, segments: [{ start: 0, end: 42 }], qualifiers: t11 });
      const protein = translateFeature(makeRecord({ seq: lacI5 }), cds);
      expect(protein).toBe('MKPVTLYDVAEYAG'); // NCBI /translation and UniProt P03023 start like this
      expect(searchProtein(lacI5, 'linear', protein, { table: 11, nTerminal: true })).toEqual([hitAt(0, 42, 1, 0)]);
      // the bottom strand, and a gene that crosses the origin of a circular molecule
      expect(searchProtein(reverseComplement(`C${lacI5}`), 'linear', protein, { table: 11, nTerminal: true })).toEqual([
        hitAt(0, 42, -1, 1),
      ]);
      const wrapped = lacI5.slice(20) + lacI5.slice(0, 20); // the gene starts at 22 and wraps
      expect(searchProtein(wrapped, 'circular', protein, { table: 11, nTerminal: true })).toEqual([
        hitAt(22, 64, 1, 1),
      ]);
    });

    it('default (nTerminal false): every letter matches the internal translation, as documented', () => {
      expect(searchProtein(lacI5, 'linear', 'MKPVTLYDVAEYAG', { table: 11 })).toEqual([]);
      expect(searchProtein(lacI5, 'linear', 'VKPVTLYDVAEYAG', { table: 11 })).toEqual([hitAt(0, 42, 1, 0)]);
      // with nTerminal the internal reading of the first codon still matches
      expect(searchProtein(lacI5, 'linear', 'VKPVTLYDVAEYAG', { table: 11, nTerminal: true })).toEqual([
        hitAt(0, 42, 1, 0),
      ]);
    });

    it('applies to the first letter only, and only for start codons of the selected table', () => {
      expect(searchProtein('GTGAAA', 'linear', 'MK', { table: 11, nTerminal: true })).toHaveLength(1);
      expect(searchProtein('GTGAAA', 'linear', 'MK', { table: 1, nTerminal: true })).toEqual([]); // GTG: no start in table 1
      expect(searchProtein('TTGAAA', 'linear', 'MK', { table: 1, nTerminal: true })).toHaveLength(1);
      expect(searchProtein('ATTAAA', 'linear', 'MK', { table: 2, nTerminal: true })).toHaveLength(1);
      expect(searchProtein('AAAGTG', 'linear', 'KM', { table: 11, nTerminal: true })).toEqual([]); // internal M
      expect(searchProtein('AAAGTG', 'linear', 'KV', { table: 11, nTerminal: true })).toHaveLength(1);
      // ambiguous initiators, read like translate(..., { cds: true }): NTG = ATG/CTG/GTG/TTG are all
      // table-11 starts (M); GTN mixes GTG with non-starts (X), so M does not match it
      expect(searchProtein('NTGAAA', 'linear', 'MK', { table: 11, nTerminal: true })).toHaveLength(1);
      expect(searchProtein('GTNAAA', 'linear', 'MK', { table: 11, nTerminal: true })).toEqual([]);
      expect(searchProtein('GTNAAA', 'linear', 'XK', { table: 11, nTerminal: true })).toHaveLength(1);
      // U, O and '*' are unaffected
      expect(searchProtein('TGAAAA', 'linear', 'UK', { table: 11, nTerminal: true })).toHaveLength(1);
      expect(searchProtein('TAAAAA', 'linear', 'MK', { table: 11, nTerminal: true })).toEqual([]);
      expect(searchProtein('TAAAAA', 'linear', '*K', { table: 11, nTerminal: true })).toHaveLength(1);
    });

    it('every hit translates back to the peptide with the first codon read as an initiator (seeded random)', () => {
      const rand = seededRandom(31337);
      let altStartHits = 0;
      for (let n = 0; n < 80; n++) {
        const seq = randomString(rand, rand() < 0.2 ? 'ACGTNRY' : 'ACGT', 30 + Math.floor(rand() * 300));
        const topology = rand() < 0.5 ? 'circular' : 'linear';
        const table = [1, 2, 4, 11, 13][n % 5];
        const peptide = `M${randomString(rand, 'ACDEFGHIKLMNPQRSTVWY', Math.floor(rand() * 2))}`;
        const plain = searchProtein(seq, topology, peptide, { table });
        const hits = searchProtein(seq, topology, peptide, { table, nTerminal: true });
        for (const h of plain) expect(hits).toContainEqual(h); // nTerminal only adds hits
        for (const h of hits) {
          const nt = sliceRange(seq, h.range);
          const own = h.strand === 1 ? nt : reverseComplement(nt);
          expect(translate(own, { table, cds: true }).replace(/\*$/, '')).toBe(peptide);
          if (!own.startsWith('ATG')) altStartHits++;
        }
      }
      expect(altStartHits).toBeGreaterThan(20);
    });

    it('finds exactly the windows a brute-force scan finds (seeded random, both strands, circular wrap)', () => {
      const rand = seededRandom(2718);
      let extra = 0;
      for (let n = 0; n < 60; n++) {
        const seq = randomString(rand, rand() < 0.2 ? 'ACGTNRY' : 'ACGT', 20 + Math.floor(rand() * 200));
        const topology: Topology = rand() < 0.5 ? 'circular' : 'linear';
        const table = [1, 2, 4, 11, 13][n % 5];
        const peptide = randomString(rand, 'MMMVLI', 1) + randomString(rand, 'ACDEFGHIKLMNPQRSTVWY', Math.floor(rand() * 2));
        const L = seq.length;
        const w = 3 * peptide.length;
        const expected: string[] = [];
        for (let p = 0; p < (topology === 'circular' ? L : L - w + 1); p++) {
          for (const strand of [1, -1] as const) {
            const window = sliceRange(seq, { start: p, end: p + w });
            const own = strand === 1 ? window : reverseComplement(window);
            const internal = translate(own, { table });
            const asInitiator = translate(own.slice(0, 3), { table, cds: true }) + internal.slice(1);
            if (internal === peptide || asInitiator === peptide) expected.push(`${p}${strand === 1 ? '+' : '-'}`);
          }
        }
        const hits = searchProtein(seq, topology, peptide, { table, nTerminal: true });
        expect(hits.map((h) => `${h.range.start}${h.strand === 1 ? '+' : '-'}`).sort(), `${table} ${peptide} ${seq}`).toEqual(
          expected.sort(),
        );
        extra += hits.length - searchProtein(seq, topology, peptide, { table }).length;
      }
      expect(extra).toBeGreaterThan(10); // windows found only through an alternative start codon
    });

    it('validates the option', () => {
      expect(() => searchProtein('ATG', 'linear', 'M', { nTerminal: 'yes' as unknown as boolean })).toThrow(RangeError);
    });
  });

  it('every hit translates back to the peptide (seeded random)', () => {
    const rand = seededRandom(424242);
    for (let n = 0; n < 60; n++) {
      const seq = randomString(rand, 'ACGT', 30 + Math.floor(rand() * 300));
      const topology = rand() < 0.5 ? 'circular' : 'linear';
      const peptide = randomString(rand, 'ACDEFGHIKLMNPQRSTVWY', 1 + Math.floor(rand() * 2));
      for (const h of searchProtein(seq, topology, peptide)) {
        const nt = sliceRange(seq, h.range);
        expect(translate(h.strand === 1 ? nt : reverseComplement(nt))).toBe(peptide);
        const L = seq.length;
        expect(h.frame).toBe(h.strand === 1 ? h.range.start % 3 : (((L - h.range.end) % L) + L) % L % 3);
      }
    }
  });
});

// Verification: TypeScript brute forces written from the TSDoc definitions, using only IUPAC_DNA and
// getGeneticCode (not the mask tables of search.ts / translate.ts), on short molecules where the
// edge cases are dense: windows across the origin, queries as long as the molecule, IUPAC codes on
// both sides, palindromes, every genetic code, U / O / '*' and ambiguity letters, nTerminal.
describe('search vs TypeScript brute forces on short molecules', () => {
  const expansions = (codon: string): string[] => {
    const out: string[] = [];
    for (const a of IUPAC_DNA[codon[0]]) for (const b of IUPAC_DNA[codon[1]]) for (const c of IUPAC_DNA[codon[2]]) out.push(a + b + c);
    return out;
  };

  it('searchSequence: 2000 seeded cases (IUPAC, lower case and U, palindromes, query length up to L)', () => {
    const rand = seededRandom(99002);
    let hits = 0;
    for (let n = 0; n < 2000; n++) {
      const L = Math.floor(rand() * 30);
      const seq = randomString(rand, rand() < 0.3 ? 'ACGTRYSWKMBDHVNacgtu' : 'ACGT', L);
      const m = 1 + Math.floor(rand() * Math.max(1, L + 1));
      let query = randomString(rand, rand() < 0.4 ? 'ACGTRYSWKMBDHVN' : 'ACGT', m);
      if (rand() < 0.2) {
        const half = randomString(rand, 'ACGTRYSWKMBDHVN', Math.max(1, m >> 1));
        query = half + reverseComplement(half);
      }
      if (rand() < 0.3 && L > 0) {
        const p = Math.floor(rand() * L);
        query = '';
        for (let i = 0; i < Math.min(m, L); i++) query += seq[(p + i) % L];
        query = query.toUpperCase().replace(/U/g, 'T');
        if (rand() < 0.5) query = reverseComplement(query);
      }
      const topology: Topology = rand() < 0.5 ? 'circular' : 'linear';
      const strands = (['both', 'both', 'top', 'bottom'] as const)[Math.floor(rand() * 4)];
      const k = Math.floor(rand() * 4);
      const iupac = rand() < 0.75;
      // brute force: every window, both requested strands, a palindrome only once (as strand 1)
      const s = seq.toUpperCase().replace(/U/g, 'T');
      const q = query.toUpperCase().replace(/U/g, 'T');
      const rc = reverseComplement(q);
      const searched: (1 | -1)[] = strands === 'top' ? [1] : strands === 'bottom' ? [-1] : rc === q ? [1] : [1, -1];
      const matches = (code: string, base: string) =>
        iupac ? [...(IUPAC_DNA[base] ?? '?')].every((b) => (IUPAC_DNA[code] ?? '').includes(b)) : code === base;
      const expected: SearchHit[] = [];
      if (q.length <= L) {
        for (let p = 0; p < (topology === 'circular' ? L : L - q.length + 1); p++) {
          for (const strand of searched) {
            const pattern = strand === 1 ? q : rc;
            let mm = 0;
            for (let i = 0; i < pattern.length; i++) if (!matches(pattern[i], s[(p + i) % L])) mm++;
            if (mm <= k) expected.push({ range: { start: p, end: p + q.length }, strand, mismatches: mm });
          }
        }
      }
      const label = `${seq} ${topology} ${query} ${strands} k=${k} iupac=${iupac}`;
      expect(searchSequence(seq, topology, query, { strands, maxMismatches: k, iupac }), label).toEqual(expected);
      hits += expected.length;
    }
    expect(hits).toBeGreaterThan(3000);
  });

  it('searchProtein: 1000 seeded cases (every table, B/Z/J/X, U/O/*, nTerminal, circular wrap)', () => {
    const tables = GENETIC_CODES.map((c) => c.id);
    /** Biopython-style reading of a possibly ambiguous codon; `initiator`: start codons read as M. */
    const read = (codon: string, table: number, initiator: boolean): string => {
      const code = getGeneticCode(table);
      const residues = new Set<string>();
      let stops = 0;
      const all = expansions(codon);
      for (const e of all) {
        const r = initiator && code.startCodons.includes(e) ? 'M' : code.forwardTable[e];
        if (r === undefined) stops++;
        else residues.add(r);
      }
      if (stops === all.length) return '*';
      if (stops > 0) return 'X';
      if (residues.size === 1) return [...residues][0];
      for (const [letter, members] of [['B', 'DN'], ['J', 'IL'], ['Z', 'EQ']]) {
        if ([...residues].every((r) => members.includes(r))) return letter;
      }
      return 'X';
    };
    const accepts: Record<string, string> = { B: 'BDN', Z: 'ZEQ', J: 'JIL', X: 'ACDEFGHIKLMNPQRSTVWYBZJX' };
    const letterMatches = (letter: string, codon: string, table: number, nTerminalFirst: boolean): boolean => {
      if (letter === 'U') return codon === 'TGA';
      if (letter === 'O') return codon === 'TAG';
      if (letter === '*') return expansions(codon).every((e) => getGeneticCode(table).stopCodons.includes(e));
      const ok = (r: string) => (accepts[letter] ?? letter).includes(r);
      return ok(read(codon, table, false)) || (nTerminalFirst && ok(read(codon, table, true)));
    };
    const soup = ['ATG', 'TGA', 'TAG', 'TAA', 'GTG', 'TTG', 'CTG', 'ATT', 'GAY', 'CAR', 'MTT', 'NNN', 'TGR', 'RAY', 'GCN', 'AGA'];
    const rand = seededRandom(99003);
    let hits = 0;
    for (let n = 0; n < 1000; n++) {
      const L = Math.floor(rand() * 45);
      let seq = '';
      while (seq.length < L) seq += rand() < 0.5 ? soup[Math.floor(rand() * soup.length)] : randomString(rand, 'ACGT', 1);
      seq = seq.slice(0, L);
      const topology: Topology = rand() < 0.5 ? 'circular' : 'linear';
      const table = tables[Math.floor(rand() * tables.length)];
      const nTerminal = rand() < 0.5;
      const n3 = 1 + Math.floor(rand() * 3);
      let peptide = '';
      if (L >= 3 * n3 && rand() < 0.7) {
        // derived from a window, so most cases have hits
        const own = rand() < 0.5 ? seq : reverseComplement(seq);
        const p = Math.floor(rand() * (topology === 'circular' ? L : L - 3 * n3 + 1));
        for (let i = 0; i < n3; i++) {
          const codon = own[(p + 3 * i) % L] + own[(p + 3 * i + 1) % L] + own[(p + 3 * i + 2) % L];
          const r = rand();
          if (r < 0.15) peptide += 'X';
          else if (r < 0.25 && codon === 'TGA') peptide += 'U';
          else if (r < 0.25 && codon === 'TAG') peptide += 'O';
          else peptide += read(codon, table, i === 0 && nTerminal && r < 0.6);
        }
      } else {
        peptide = randomString(rand, 'ACDEFGHIKLMNPQRSTVWYBZJXUO*m', n3);
      }
      const upper = peptide.toUpperCase();
      const width = 3 * upper.length;
      const expected: ProteinSearchHit[] = [];
      if (width <= L) {
        for (const strand of [1, -1] as const) {
          const own = strand === 1 ? seq : reverseComplement(seq);
          for (let p = 0; p < (topology === 'circular' ? L : L - width + 1); p++) {
            let ok = true;
            for (let i = 0; i < upper.length && ok; i++) {
              const codon = own[(p + 3 * i) % L] + own[(p + 3 * i + 1) % L] + own[(p + 3 * i + 2) % L];
              ok = letterMatches(upper[i], codon, table, i === 0 && nTerminal);
            }
            if (!ok) continue;
            const start = strand === 1 ? p : (L - p - width + L) % L;
            expected.push(hitAt(start, start + width, strand, (p % 3) as 0 | 1 | 2));
          }
        }
      }
      expected.sort((a, b) => a.range.start - b.range.start || b.strand - a.strand || a.range.end - b.range.end);
      const label = `${seq} ${topology} ${peptide} table ${table} nTerminal=${nTerminal}`;
      expect(searchProtein(seq, topology, peptide, { table, nTerminal }), label).toEqual(expected);
      hits += expected.length;
    }
    expect(hits).toBeGreaterThan(3000);
  });
});

describe.skipIf(!HAS_ECOLI)('review: nTerminal on every complete single-segment CDS of E. coli U00096.3', () => {
  it('finds each gene by the N-terminal peptide translateFeature gives (GTG, TTG, ATT, CTG starts included)', () => {
    const genome = readGenbankSequence(ECOLI_GENBANK);
    const rec = makeRecord({ seq: genome, topology: 'circular' });
    const L = genome.length;
    // CDS key lines with a plain 5'- and 3'-complete location a..b or complement(a..b)
    const cdsLine = /^ {5}CDS {13}(complement\()?(\d+)\.\.(\d+)\)?$/gm;
    const table11 = [{ key: 'transl_table', value: '11' }];
    let genes = 0;
    let nonAtg = 0;
    const missedWithOption: string[] = [];
    const missedByDefault = new Set<string>();
    const nonAtgGenes = new Set<string>();
    for (const m of readFileSync(ECOLI_GENBANK, 'latin1').matchAll(cdsLine)) {
      const strand = m[1] ? -1 : 1;
      const start = Number(m[2]) - 1;
      const end = Number(m[3]);
      const cds = makeFeature({ type: 'CDS', strand, segments: [{ start, end }], qualifiers: table11 });
      const peptide = translateFeature(rec, cds).replace(/\*$/, '').slice(0, 12);
      if (peptide.length < 4) continue;
      const w = 3 * peptide.length;
      const at = strand === 1 ? start : end - w; // top-strand start of the coding bases of the peptide
      const lo = Math.max(0, at - 30);
      const hi = Math.min(L, at + w + 30);
      const region = genome.slice(lo, hi);
      const isHere = (hits: ProteinSearchHit[]) => hits.some((h) => h.range.start === at - lo && h.strand === strand);
      const label = `${m[0].trim()}`;
      genes++;
      const firstCodon = strand === 1 ? genome.slice(start, start + 3) : reverseComplement(genome.slice(end - 3, end));
      if (firstCodon !== 'ATG') {
        nonAtg++;
        nonAtgGenes.add(label);
      }
      if (!isHere(searchProtein(region, 'linear', peptide, { table: 11, nTerminal: true }))) missedWithOption.push(label);
      if (!isHere(searchProtein(region, 'linear', peptide, { table: 11 }))) missedByDefault.add(label);
    }
    expect(genes).toBeGreaterThan(4000);
    expect(nonAtg).toBeGreaterThan(300); // ~10% of E. coli genes start with GTG, TTG, ATT or CTG
    expect(missedWithOption).toEqual([]);
    // by default exactly the genes with an alternative start codon are missed
    expect(missedByDefault).toEqual(nonAtgGenes);
  });
});

describe.skipIf(!HAS_ECOLI)('search performance on the E. coli genome (4.6 Mb)', () => {
  const genome = HAS_ECOLI ? readGenbankSequence(ECOLI_GENBANK) : '';

  it('exact search of a 20-mer on both strands in < 300 ms', () => {
    const query = genome.slice(1_000_000, 1_000_020);
    const t0 = performance.now();
    const hits = searchSequence(genome, 'circular', query);
    const ms = performance.now() - t0;
    expect(ms).toBeLessThan(300);
    expect(hits.some((h) => h.range.start === 1_000_000 && h.strand === 1 && h.mismatches === 0)).toBe(true);
  });

  it('exact IUPAC search (EcoRI-like GAATTC / degenerate GGNCC) in < 300 ms', () => {
    const t0 = performance.now();
    const ecoRI = searchSequence(genome, 'circular', 'GAATTC');
    const t1 = performance.now();
    const degenerate = searchSequence(genome, 'circular', 'GGNCC');
    const t2 = performance.now();
    expect(t1 - t0).toBeLessThan(300);
    expect(t2 - t1).toBeLessThan(300);
    expect(ecoRI.every((h) => h.strand === 1)).toBe(true); // palindrome reported once
    expect(ecoRI.length).toBeGreaterThan(100);
    expect(degenerate.length).toBeGreaterThan(1000);
  });

  it('2-mismatch search of a 20-mer on both strands in < 3 s', () => {
    const query = genome.slice(2_000_000, 2_000_020);
    const t0 = performance.now();
    const hits = searchSequence(genome, 'circular', query, { maxMismatches: 2 });
    const ms = performance.now() - t0;
    expect(ms).toBeLessThan(3000);
    expect(hits.find((h) => h.range.start === 2_000_000 && h.strand === 1)?.mismatches).toBe(0);
  });

  it('finds the start of LacZ by translated search', () => {
    const lacZ = findOrfs(genome, 'circular', { minAaLength: 1000 }).find(
      (o) => o.strand === -1 && o.range.end === 366305,
    );
    expect(lacZ).toBeDefined();
    if (!lacZ) return;
    const protein = translate(reverseComplement(sliceRange(genome, lacZ.range)));
    const t0 = performance.now();
    const hits = searchProtein(genome, 'circular', protein.slice(0, 20));
    expect(performance.now() - t0).toBeLessThan(3000);
    expect(hits).toEqual([hitAt(366305 - 60, 366305, -1, lacZ.frame)]);
  });
});
