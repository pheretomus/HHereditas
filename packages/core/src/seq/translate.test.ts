import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ECOLI_GENBANK,
  HAS_ECOLI,
  HAS_VENV,
  REPO_ROOT,
  VENV_PYTHON,
  loadOracle,
  randomString,
  readGenbankSequence,
  seededRandom,
} from '../../test/oracle/seqtools/oracle';
import type { Feature, Qualifier, Range, SeqRecord, Strand, Topology } from '../types';
import { reverseComplement } from './alphabet';
import { GENETIC_CODES } from './codon-tables';
import { makeFeature, makeRecord } from './features';
import {
  NUCLEOTIDE_MASK,
  TranslationError,
  codonKey,
  compileGeneticCode,
  complementMask,
  encodeNucleotides,
  reverseComplementMasks,
  translate,
  translateFeature,
} from './translate';

// ---------------------------------------------------------------------------
// Oracle data
// ---------------------------------------------------------------------------

interface CodonsOracle {
  alphabet: string;
  tables: { id: number; aa: string; start: string; stop: string }[];
}
interface TranslateCase {
  seq: string;
  table: number;
  frame: 0 | 1 | 2;
  expected: string;
  expectedToStop?: string;
  toStopError?: boolean;
}
interface TranslateOracle {
  cases: TranslateCase[];
  cdsCases: { seq: string; table: number; expected: string }[];
}
interface FeatureOracle {
  records: {
    file: string;
    id: string;
    topology: Topology;
    seq: string;
    features: {
      type: string;
      strand: Strand;
      segments: Range[];
      partialStart: boolean;
      partialEnd: boolean;
      qualifiers: Qualifier[];
      translation: string | null;
      bioPlain: string | { error: string };
    }[];
  }[];
}

const codonsOracle = loadOracle<CodonsOracle>('codons.json');
const translateOracle = loadOracle<TranslateOracle>('translate.json');
const featureOracle = loadOracle<FeatureOracle>('features.json');
type OracleFeature = FeatureOracle['records'][number]['features'][number];

function allIupacCodons(alphabet: string): string[] {
  const out: string[] = [];
  for (const a of alphabet) for (const b of alphabet) for (const c of alphabet) out.push(a + b + c);
  return out;
}

// ---------------------------------------------------------------------------
// Masks
// ---------------------------------------------------------------------------

describe('nucleotide masks', () => {
  it('encodes IUPAC codes as base sets, case-insensitively, U as T', () => {
    const m = (ch: string) => NUCLEOTIDE_MASK[ch.charCodeAt(0)];
    expect([m('A'), m('C'), m('G'), m('T')]).toEqual([1, 2, 4, 8]);
    expect(m('R')).toBe(m('A') | m('G'));
    expect(m('N')).toBe(15);
    expect(m('b')).toBe(m('B'));
    expect(m('U')).toBe(m('T'));
    expect(m('u')).toBe(m('T'));
    for (const ch of 'XZJOE-.* 0') expect(m(ch)).toBe(0);
  });

  it('complements masks like reverseComplement complements letters', () => {
    for (const ch of 'ACGTRYSWKMBDHVN') {
      const mask = NUCLEOTIDE_MASK[ch.charCodeAt(0)];
      expect(complementMask(mask)).toBe(NUCLEOTIDE_MASK[reverseComplement(ch).charCodeAt(0)]);
    }
    const enc = encodeNucleotides('ACGTRYN', true);
    expect([...reverseComplementMasks(enc)]).toEqual([...encodeNucleotides(reverseComplement('ACGTRYN'), true)]);
  });

  it('strict encoding rejects non-IUPAC characters, lenient encoding stores 0', () => {
    expect(() => encodeNucleotides('ACGX', true)).toThrow(TranslationError);
    expect([...encodeNucleotides('AX', false)]).toEqual([1, 0]);
    expect(encodeNucleotides('', true)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// translate vs Biopython
// ---------------------------------------------------------------------------

describe('translate vs Biopython: every IUPAC codon in every table (codons.json)', () => {
  const codons = allIupacCodons(codonsOracle.alphabet);
  for (const t of codonsOracle.tables) {
    it(`table ${t.id}: ${codons.length} codons`, () => {
      const cc = compileGeneticCode(t.id);
      let aaMismatch = 0;
      let flagMismatch = 0;
      codons.forEach((codon, i) => {
        if (translate(codon, { table: t.id }) !== t.aa[i]) aaMismatch++;
        const key = codonKey(
          NUCLEOTIDE_MASK[codon.charCodeAt(0)],
          NUCLEOTIDE_MASK[codon.charCodeAt(1)],
          NUCLEOTIDE_MASK[codon.charCodeAt(2)],
        );
        if (cc.start[key] !== Number(t.start[i]) || cc.stop[key] !== Number(t.stop[i])) flagMismatch++;
      });
      expect(aaMismatch).toBe(0);
      expect(flagMismatch).toBe(0);
    });
  }
});

describe('translate vs Biopython: random sequences (translate.json)', () => {
  it(`${translateOracle.cases.length} cases, all tables and frames, with and without toStop`, () => {
    let checked = 0;
    for (const c of translateOracle.cases) {
      expect(translate(c.seq, { table: c.table, frame: c.frame }), JSON.stringify(c)).toBe(c.expected);
      if (c.toStopError) {
        expect(() => translate(c.seq, { table: c.table, frame: c.frame, toStop: true })).toThrow(TranslationError);
      } else {
        expect(translate(c.seq, { table: c.table, frame: c.frame, toStop: true })).toBe(c.expectedToStop);
      }
      checked++;
    }
    expect(checked).toBe(translateOracle.cases.length);
  });

  it(`${translateOracle.cdsCases.length} valid CDSs with cds=true (Biopython drops the final stop, we keep it)`, () => {
    for (const c of translateOracle.cdsCases) {
      expect(translate(c.seq, { table: c.table, cds: true }), c.seq).toBe(`${c.expected}*`);
      expect(translate(c.seq, { table: c.table, cds: true, toStop: true })).toBe(c.expected);
    }
  });
});

// ---------------------------------------------------------------------------
// translate unit tests
// ---------------------------------------------------------------------------

describe('translate', () => {
  it('handles empty input, partial codons and frames', () => {
    expect(translate('')).toBe('');
    expect(translate('A')).toBe('');
    expect(translate('AT')).toBe('');
    expect(translate('ATG')).toBe('M');
    expect(translate('ATGC')).toBe('M');
    expect(translate('ATGCC')).toBe('M');
    expect(translate('ATGCCC')).toBe('MP');
    expect(translate('GATGCCC', { frame: 1 })).toBe('MP');
    expect(translate('GGATGCCC', { frame: 2 })).toBe('MP');
    expect(translate('AT', { frame: 2 })).toBe('');
    expect(translate('ATGAAATAGTGAGGG')).toBe('MK**G');
  });

  it('is case-insensitive and reads RNA', () => {
    expect(translate('atggcc')).toBe('MA');
    expect(translate('AUGGCCUAA')).toBe('MA*');
    expect(translate('auGgcuUAa')).toBe('MA*');
    expect(translate('TUA')).toBe('L'); // mixed T/U
  });

  it('translates ambiguous codons like Biopython', () => {
    expect(translate('GCN')).toBe('A');
    expect(translate('RAY')).toBe('B'); // AAC/AAT/GAC/GAT -> N or D
    expect(translate('SAR')).toBe('Z'); // CAA/CAG/GAA/GAG -> Q or E
    expect(translate('MTH')).toBe('J'); // I or L
    expect(translate('MTN')).toBe('X'); // I, L or M
    expect(translate('TAN')).toBe('X'); // Y or stop
    expect(translate('NNN')).toBe('X');
    expect(translate('TAR')).toBe('*');
    expect(translate('TRA')).toBe('*');
    expect(translate('TAR', { table: 6 })).toBe('Q'); // ciliate: TAA/TAG = Q
    expect(translate('YTG')).toBe('L');
  });

  it('honours toStop', () => {
    expect(translate('ATGAAATAAGGG', { toStop: true })).toBe('MK');
    expect(translate('TAAATG', { toStop: true })).toBe('');
    expect(translate('ATGAAA', { toStop: true })).toBe('MK');
    expect(translate('ATGTARGGG', { toStop: true })).toBe('M'); // TAR is always a stop
    expect(translate('ATGTANGGG', { toStop: true })).toBe('MXG'); // TAN may not be
  });

  it('cds: initiator codon becomes M only when it is a start codon of the table', () => {
    expect(translate('TTGAAATAA', { cds: true })).toBe('MK*');
    expect(translate('TTGAAATAA')).toBe('LK*');
    expect(translate('GTGAAATAA', { cds: true })).toBe('VK*'); // GTG is not a start in table 1
    expect(translate('GTGAAATAA', { table: 11, cds: true })).toBe('MK*');
    expect(translate('HTGAAA', { cds: true })).toBe('MK'); // ATG, CTG, TTG are all starts
    expect(translate('NTGAAA', { cds: true })).toBe('XK'); // GTG is not
    expect(translate('ATHAAA', { table: 11, cds: true })).toBe('MK');
    expect(translate('CATGAAA', { frame: 1, cds: true })).toBe('MK');
    expect(translate('', { cds: true })).toBe('');
    expect(translate('AAAATG', { cds: true })).toBe('KM'); // only the first codon is an initiator
  });

  it('context-dependent stop codons (tables 27, 28, 31)', () => {
    // table 27: TGA = W or stop
    expect(translate('ATGTGAAAATGA', { table: 27 })).toBe('MWKW');
    expect(translate('ATGTGAAAATGA', { table: 27, cds: true })).toBe('MWK*');
    expect(translate('ATGTGAAAATGA', { table: 27, cds: true, toStop: true })).toBe('MWK');
    expect(translate('ATGTGAAAATGAC', { table: 27, cds: true })).toBe('MWKW'); // not a whole number of codons
    expect(() => translate('ATGTGA', { table: 27, toStop: true })).toThrow(TranslationError);
    // table 28: TAA/TAG = Q or stop, TGA = W or stop
    expect(translate('ATGTAATAGTGA', { table: 28 })).toBe('MQQW');
    expect(translate('ATGTAATAGTAA', { table: 28, cds: true })).toBe('MQQ*');
    // table 31: TAA/TAG = E or stop
    expect(translate('ATGTAGTAA', { table: 31, cds: true })).toBe('ME*');
    expect(translate('ATGTARTAR', { table: 31, cds: true })).toBe('ME*');
  });

  it('rejects non-IUPAC characters in translated codons', () => {
    expect(() => translate('ATGXAA')).toThrow(TranslationError);
    expect(() => translate('AT-')).toThrow(/index 2/);
    expect(() => translate('A T')).toThrow(TranslationError);
    expect(() => translate('ATGNNX')).toThrow(TranslationError);
    expect(() => translate('ATGéAA')).toThrow(TranslationError);
    // characters outside translated codons are not inspected (as in Biopython)
    expect(translate('ATG-')).toBe('M');
    expect(translate('XATG', { frame: 1 })).toBe('M');
    expect(translate('ATGTAAX-?', { toStop: true })).toBe('M');
  });

  it('names a non-BMP invalid character whole in error messages (not a lone surrogate)', () => {
    expect(() => translate('AT😀')).toThrow(/'😀' at index 2/);
    expect(() => translate('ATGAAAß')).not.toThrow(); // trailing partial codon: not read
    expect(() => translate('ATGAßA')).toThrow(/'ß' at index 4/);
  });

  it('validates table and frame', () => {
    expect(() => translate('ATG', { table: 7 })).toThrow(RangeError);
    expect(() => translate('ATG', { table: 1.5 })).toThrow(RangeError);
    expect(() => translate('ATG', { frame: 3 as 0 })).toThrow(RangeError);
    expect(() => translate('ATG', { frame: -1 as 0 })).toThrow(RangeError);
  });

  it('translates long sequences (string building in chunks)', () => {
    const seq = 'ATGGCC'.repeat(20000);
    const prot = translate(seq);
    expect(prot).toHaveLength(40000);
    expect(prot).toBe('MA'.repeat(20000));
  });
});

describe('translate properties (seeded random)', () => {
  const rand = seededRandom(9001);
  const samples = Array.from({ length: 300 }, () =>
    randomString(rand, rand() < 0.3 ? 'ACGTRYSWKMBDHVN' : 'ACGT', Math.floor(rand() * 120)),
  );
  const tables = GENETIC_CODES.map((c) => c.id).filter((id) => ![27, 28, 31].includes(id));

  it('frame f equals translating the sequence without its first f bases', () => {
    for (const s of samples) {
      for (const f of [0, 1, 2] as const) expect(translate(s, { frame: f })).toBe(translate(s.slice(f)));
    }
  });

  it('length is the number of complete codons; output alphabet is protein', () => {
    for (const s of samples) {
      for (const f of [0, 1, 2] as const) {
        const p = translate(s, { frame: f });
        expect(p).toHaveLength(Math.max(0, Math.floor((s.length - f) / 3)));
        expect(p).toMatch(/^[ACDEFGHIKLMNPQRSTVWYBZJX*]*$/);
      }
    }
  });

  it('is a homomorphism over whole codons, case-insensitive, and RNA-equivalent', () => {
    for (let i = 0; i + 1 < samples.length; i += 2) {
      const a = samples[i].slice(0, samples[i].length - (samples[i].length % 3));
      const b = samples[i + 1];
      const table = tables[i % tables.length];
      expect(translate(a + b, { table })).toBe(translate(a, { table }) + translate(b, { table }));
      expect(translate(b.toLowerCase(), { table })).toBe(translate(b, { table }));
      expect(translate(b.replace(/T/g, 'U'), { table })).toBe(translate(b, { table }));
    }
  });

  it('toStop is the prefix before the first stop', () => {
    for (const s of samples) {
      const full = translate(s);
      const stop = full.indexOf('*');
      expect(translate(s, { toStop: true })).toBe(stop < 0 ? full : full.slice(0, stop));
    }
  });
});

// ---------------------------------------------------------------------------
// translateFeature
// ---------------------------------------------------------------------------

function record(seq: string, topology: Topology = 'linear', molecule: SeqRecord['molecule'] = 'DNA'): SeqRecord {
  return makeRecord({ seq, topology, molecule });
}

function cds(
  segments: Range[],
  strand: Strand,
  qualifiers: Qualifier[] = [],
  extra: Partial<Feature> = {},
): Feature {
  return { ...makeFeature({ type: 'CDS', name: 'test', strand, segments, qualifiers }), ...extra };
}

describe('translateFeature vs GenBank /translation and Biopython (features.json)', () => {
  for (const r of featureOracle.records) {
    it(`${r.file} ${r.id}: ${r.features.length} CDS`, () => {
      const rec = makeRecord({ seq: r.seq, topology: r.topology });
      for (const f of r.features) {
        const feature: Feature = {
          ...makeFeature({ type: f.type, strand: f.strand, segments: f.segments, qualifiers: f.qualifiers }),
          partialStart: f.partialStart,
          partialEnd: f.partialEnd,
        };
        const label = `${r.file} ${JSON.stringify(f.segments)} ${f.strand}`;
        if (f.translation !== null) {
          const ours = translateFeature(rec, feature);
          expect(ours.endsWith('*') ? ours.slice(0, -1) : ours, label).toBe(f.translation);
        }
        if (typeof f.bioPlain === 'string') {
          expect(translateFeature(rec, feature, { cds: false, translExcept: false }), label).toBe(f.bioPlain);
        }
      }
    });
  }
});

describe('translateFeature', () => {
  //           0         1
  //           0123456789012345678
  const seq = 'CCATGAAACCCGGGTAACC'; // CDS ATG AAA CCC GGG TAA at [2, 17)

  it('translates a simple forward CDS, with M for the start codon', () => {
    const rec = record(seq);
    expect(translateFeature(rec, cds([{ start: 2, end: 17 }], 1))).toBe('MKPG*');
    expect(translateFeature(rec, cds([{ start: 2, end: 17 }], 1), { toStop: true })).toBe('MKPG');
    expect(translateFeature(rec, cds([{ start: 2, end: 17 }], 0))).toBe('MKPG*'); // strand 0 read as +1
  });

  it('translates a reverse-strand CDS', () => {
    const rc = reverseComplement(seq); // GGTTACCCGGGTTTCATGG
    const rec = record(rc);
    const L = rc.length;
    expect(translateFeature(rec, cds([{ start: L - 17, end: L - 2 }], -1))).toBe('MKPG*');
  });

  it('joins segments in order and reverse-complements the joined sequence', () => {
    // ATG AAA | intron | CCC GGG TAA
    const s = 'ATGAAAGTAAGTTTTTAGCCCGGGTAA';
    const rec = record(s);
    const segs = [
      { start: 0, end: 6 },
      { start: 18, end: 27 },
    ];
    expect(translateFeature(rec, cds(segs, 1))).toBe('MKPG*');
    const rc = reverseComplement(s);
    const L = rc.length;
    const rcSegs = [
      { start: L - 27, end: L - 18 },
      { start: L - 6, end: L },
    ];
    expect(translateFeature(record(rc), cds(rcSegs, -1))).toBe('MKPG*');
  });

  it('handles a segment that wraps the origin of a circular record', () => {
    // CDS ATGAAACCCTAA split as ...ATGAAA | CCCTAA... across the origin
    const s = 'CCCTAAGGGGGGGGATGAAA';
    const rec = record(s, 'circular');
    expect(translateFeature(rec, cds([{ start: 14, end: 26 }], 1))).toBe('MKP*');
    // the same as two segments
    expect(translateFeature(rec, cds([{ start: 14, end: 20 }, { start: 0, end: 6 }], 1))).toBe('MKP*');
    // and on the reverse strand
    const rc = reverseComplement(s); // TTTCATCCCCCCCCTTAGGG
    const rrec = record(rc, 'circular');
    // the reverse-strand CDS occupies rc bases 14..19 + 0..5, i.e. [14, 26) in top coordinates
    expect(translateFeature(rrec, cds([{ start: 14, end: 26 }], -1))).toBe('MKP*');
  });

  it('honours /codon_start and does not make a 5\'-partial CDS start with M', () => {
    const rec = record('GATGAAATAA');
    const f = cds([{ start: 0, end: 10 }], 1, [{ key: 'codon_start', value: '2' }]);
    expect(translateFeature(rec, f)).toBe('MK*'); // first complete codon ATG is M anyway
    const rec2 = record('GTTGAAATAA');
    const f2 = cds([{ start: 0, end: 10 }], 1, [{ key: 'codon_start', value: '2' }]);
    expect(translateFeature(rec2, f2)).toBe('LK*'); // TTG not converted: 5'-incomplete
    const f3 = cds([{ start: 1, end: 10 }], 1, [], { partialStart: true });
    expect(translateFeature(rec2, f3)).toBe('LK*');
    const f4 = cds([{ start: 1, end: 10 }], 1);
    expect(translateFeature(rec2, f4)).toBe('MK*');
    // reverse strand: the 5' end is the high coordinate -> partialEnd
    const rc = record(reverseComplement('TTGAAATAA'));
    expect(translateFeature(rc, cds([{ start: 0, end: 9 }], -1, [], { partialEnd: true }))).toBe('LK*');
    expect(translateFeature(rc, cds([{ start: 0, end: 9 }], -1, [], { partialStart: true }))).toBe('MK*');
    const f5 = cds([{ start: 0, end: 10 }], 1, [{ key: 'codon_start', value: '3' }]);
    expect(translateFeature(rec2, f5)).toBe('*N'); // TGA AAT + partial AA
  });

  it('uses /transl_table over options.table and options.table otherwise', () => {
    const rec = record('GTGTGAAAATAA');
    expect(translateFeature(rec, cds([{ start: 0, end: 12 }], 1))).toBe('V*K*');
    expect(translateFeature(rec, cds([{ start: 0, end: 12 }], 1), { table: 11 })).toBe('M*K*');
    expect(translateFeature(rec, cds([{ start: 0, end: 12 }], 1, [{ key: 'transl_table', value: '2' }]))).toBe('MWK*');
    expect(
      translateFeature(rec, cds([{ start: 0, end: 12 }], 1, [{ key: 'transl_table', value: '2' }]), { table: 11 }),
    ).toBe('MWK*');
  });

  it('cds option: non-CDS features are translated literally unless cds is set', () => {
    const rec = record('TTGAAATAA');
    const gene: Feature = makeFeature({ type: 'gene', strand: 1, segments: [{ start: 0, end: 9 }] });
    expect(translateFeature(rec, gene)).toBe('LK*');
    expect(translateFeature(rec, gene, { cds: true })).toBe('MK*');
    expect(translateFeature(rec, cds([{ start: 0, end: 9 }], 1), { cds: false })).toBe('LK*');
  });

  it('context-dependent stop at the end of a CDS (table 27)', () => {
    const rec = record('ATGTGAAAATGA');
    const f = cds([{ start: 0, end: 12 }], 1, [{ key: 'transl_table', value: '27' }]);
    expect(translateFeature(rec, f)).toBe('MWK*');
    expect(translateFeature(rec, f, { toStop: true })).toBe('MWK');
    expect(translateFeature(rec, { ...f, partialEnd: true })).toBe('MWKW'); // 3'-partial: no terminator
    expect(() => translateFeature(rec, f, { cds: false, toStop: true })).toThrow(TranslationError);
  });

  it('applies /transl_except (selenocysteine, completed stop codons) unless disabled', () => {
    // ATG TGA AAA TAA with TGA at 4..6 (1-based) read as Sec
    const rec = record('ATGTGAAAATAA');
    const f = cds([{ start: 0, end: 12 }], 1, [{ key: 'transl_except', value: '(pos:4..6,aa:Sec)' }]);
    expect(translateFeature(rec, f)).toBe('MUK*');
    expect(translateFeature(rec, f, { toStop: true })).toBe('MUK');
    expect(translateFeature(rec, f, { translExcept: false })).toBe('M*K*');
    // reverse strand, complement() location
    const rc = record(reverseComplement('ATGTGAAAATAA')); // TTATTTTCACAT
    const fr = cds([{ start: 0, end: 12 }], -1, [{ key: 'transl_except', value: '(pos:complement(7..9),aa:Sec)' }]);
    expect(translateFeature(rc, fr)).toBe('MUK*');
    // stop codon completed by polyadenylation: ...AAA T + A tail
    const rec2 = record('ATGAAAT');
    const f2 = cds([{ start: 0, end: 7 }], 1, [{ key: 'transl_except', value: '(pos:7,aa:TERM)' }]);
    expect(translateFeature(rec2, f2)).toBe('MK*');
    expect(translateFeature(rec2, f2, { toStop: true })).toBe('MK');
    // other amino acids, case-insensitive
    const f3 = cds([{ start: 0, end: 12 }], 1, [{ key: 'transl_except', value: '(pos:4..6,aa:trp)' }]);
    expect(translateFeature(rec, f3)).toBe('MWK*');
    // several /transl_except qualifiers on one feature
    const f4 = cds([{ start: 0, end: 12 }], 1, [
      { key: 'transl_except', value: '(pos:1..3,aa:Ala)' },
      { key: 'transl_except', value: '(pos: 4..6, aa: Sec)' },
    ]);
    expect(translateFeature(rec, f4)).toBe('AUK*');
  });

  it('applies /transl_except across the origin and in joined features', () => {
    // circular: ATG | TGA AAA TAA wraps; TGA is at parent 0..2 (1-based 1..3)
    const s = 'TGAAAATAAGGGATG';
    const rec = record(s, 'circular');
    const f = cds([{ start: 12, end: 24 }], 1, [{ key: 'transl_except', value: '(pos:1..3,aa:Sec)' }]);
    expect(translateFeature(rec, f)).toBe('MUK*');
    // a codon split by an intron
    const s2 = 'ATGTGGTAAGTCCCCCAGAAAAATAA';
    const segs = [
      { start: 0, end: 5 },
      { start: 16, end: 26 },
    ]; // ATGTG + AGAAAAATAA -> ATG TG|A GAA AAA TAA: the TGA codon is split by the intron
    const fj = cds(segs, 1, [{ key: 'transl_except', value: '(pos:join(4..5,17),aa:Sec)' }]);
    expect(translateFeature(record(s2), fj)).toBe('MUEK*');
    expect(translateFeature(record(s2), fj, { translExcept: false })).toBe('M*EK*');
    // the same codon on the reverse strand, written either way INSDC allows
    const rc2 = reverseComplement(s2);
    const L2 = s2.length;
    const rcSegs = [
      { start: L2 - 26, end: L2 - 16 },
      { start: L2 - 5, end: L2 },
    ];
    const p = (i: number) => L2 - i + 1; // 1-based top-strand position of base i (1-based) of s2
    for (const where of [
      `complement(join(${p(17)},${p(5)}..${p(4)}))`,
      `join(complement(${p(5)}..${p(4)}),complement(${p(17)}))`,
    ]) {
      const fr = cds(rcSegs, -1, [{ key: 'transl_except', value: `(pos:${where},aa:Sec)` }]);
      expect(translateFeature(record(rc2), fr)).toBe('MUEK*');
    }
  });

  it('rejects /transl_except values it cannot apply', () => {
    const rec = record('ATGTGAAAATAA');
    const bad = (value: string) => cds([{ start: 0, end: 12 }], 1, [{ key: 'transl_except', value }]);
    expect(() => translateFeature(rec, bad('(pos:5..7,aa:Sec)'))).toThrow(TranslationError); // not in frame
    expect(() => translateFeature(rec, bad('(pos:4..6,aa:Foo)'))).toThrow(TranslationError);
    expect(() => translateFeature(rec, bad('(pos:X58595.1:4..6,aa:Sec)'))).toThrow(TranslationError);
    expect(() => translateFeature(rec, bad('pos:4..6,aa:Sec'))).toThrow(TranslationError);
    expect(() => translateFeature(rec, bad('(pos:40..42,aa:Sec)'))).toThrow(TranslationError);
    expect(() => translateFeature(rec, bad('(pos:complement(4..6,aa:Sec)'))).toThrow(TranslationError); // unbalanced
    expect(() => translateFeature(rec, bad('(pos:span(4..6),aa:Sec)'))).toThrow(TranslationError);
    // a partial codon that is not the trailing one
    expect(() => translateFeature(rec, bad('(pos:4..5,aa:Sec)'))).toThrow(TranslationError);
    expect(translateFeature(rec, bad('(pos:X58595.1:4..6,aa:Sec)'), { translExcept: false })).toBe('M*K*');
  });

  it('validates the record, segments and qualifiers', () => {
    const rec = record('ATGAAATAA');
    expect(() => translateFeature(record('MKV', 'linear', 'protein'), cds([{ start: 0, end: 3 }], 1))).toThrow(
      TranslationError,
    );
    expect(() => translateFeature(rec, cds([{ start: 0, end: 12 }], 1))).toThrow(TranslationError);
    expect(() => translateFeature(rec, cds([{ start: -1, end: 3 }], 1))).toThrow(TranslationError);
    expect(() => translateFeature(rec, cds([{ start: 5, end: 3 }], 1))).toThrow(TranslationError);
    expect(() => translateFeature(record('ATGAAATAA', 'circular'), cds([{ start: 9, end: 12 }], 1))).toThrow(
      TranslationError,
    );
    expect(() => translateFeature(record('ATGAAATAA', 'circular'), cds([{ start: 0, end: 10 }], 1))).toThrow(
      TranslationError,
    );
    expect(() => translateFeature(rec, cds([{ start: 0, end: 9 }], 1, [{ key: 'codon_start', value: '4' }]))).toThrow(
      TranslationError,
    );
    expect(() => translateFeature(rec, cds([{ start: 0, end: 9 }], 1, [{ key: 'transl_table', value: 'x' }]))).toThrow(
      TranslationError,
    );
    expect(() => translateFeature(rec, cds([{ start: 0, end: 9 }], 1, [{ key: 'transl_table', value: '7' }]))).toThrow(
      RangeError,
    );
  });

  it('handles empty and tiny features, and RNA records', () => {
    const rec = record('ATGAAATAA');
    expect(translateFeature(rec, cds([], 1))).toBe('');
    expect(translateFeature(rec, cds([{ start: 3, end: 3 }], 1))).toBe('');
    expect(translateFeature(rec, cds([{ start: 0, end: 2 }], 1))).toBe('');
    expect(translateFeature(record('AUGAAAUAA', 'linear', 'RNA'), cds([{ start: 0, end: 9 }], 1))).toBe('MK*');
    expect(translateFeature(record('UUAUUUCAU', 'linear', 'RNA'), cds([{ start: 0, end: 9 }], -1))).toBe('MK*');
  });

  // Review regression: an empty segment with start > L passed validation on circular records, and
  // sliceRange then read it as a wrapping range (made-up bases, or an endless loop when L = 0).
  it('rejects zero-length segments beyond the end of a circular record, and always terminates', () => {
    const rec = record('ATGAAACCCGGGTTTTAA', 'circular'); // L = 18
    for (const start of [19, 30, 36, 1000]) {
      expect(() => translateFeature(rec, cds([{ start, end: start }], 1)), `{${start},${start}}`).toThrow(
        TranslationError,
      );
    }
    // the empty segment at the end gap (start = end = L) and empty segments inside stay valid
    expect(translateFeature(rec, cds([{ start: 18, end: 18 }], 1))).toBe('');
    expect(translateFeature(rec, cds([{ start: 5, end: 5 }], 1))).toBe('');
    expect(translateFeature(rec, cds([{ start: 0, end: 18 }, { start: 18, end: 18 }], 1))).toBe('MKPGF*');
    // empty circular record: only {0, 0} is a valid range. (Asserted after the cases above, which
    // fail fast if the validation regresses, so a regression cannot hang the suite here first.)
    const empty = record('', 'circular');
    expect(translateFeature(empty, cds([{ start: 0, end: 0 }], 1))).toBe('');
    expect(() => translateFeature(empty, cds([{ start: 1, end: 1 }], 1))).toThrow(TranslationError);
    expect(() => translateFeature(empty, cds([{ start: 0, end: 1 }], 1))).toThrow(TranslationError);
  });

  it('does not mutate its inputs', () => {
    const rec = record('CCATGAAATAACC', 'circular');
    const f = cds([{ start: 2, end: 11 }], 1, [{ key: 'transl_except', value: '(pos:6..8,aa:Sec)' }]);
    const before = JSON.stringify({ rec, f });
    translateFeature(rec, f);
    expect(JSON.stringify({ rec, f })).toBe(before);
  });
});

// Review regression: NCBI pads a trailing 1-2 base codon of a coding feature with N and keeps the
// residue unless it is X (C++ Toolkit CSeqTranslator::TranslateToProtein, "if padding was needed,
// trim ambiguous last residue"), and GenBank /translation is made that way. The features.json oracle
// holds real NCBI records with such tails (see the count check below).
describe('translateFeature: trailing partial codon of a coding feature (NCBI rule)', () => {
  it("3'-partial CDS: incomplete last codon GC (= GCN, Ala) is translated like NCBI /translation", () => {
    // GenBank PZ988113.1: CDS 1..>1175 = 391 codons + 'GC'; NCBI /translation has 392 aa ending in 'A'
    const rec = makeRecord({ seq: 'ATGAAAGC' });
    const f = cds([{ start: 0, end: 8 }], 1, [], { partialEnd: true });
    expect(translateFeature(rec, f)).toBe('MKA');
  });

  it('reverse strand, codon_start=3, both ends partial: trailing CT (= CTN, Leu)', () => {
    const own = 'GGATGAAACT'; // feature 5'->3'
    const f = cds([{ start: 0, end: 10 }], -1, [{ key: 'codon_start', value: '3' }], {
      partialStart: true,
      partialEnd: true,
    });
    expect(translateFeature(record(reverseComplement(own)), f)).toBe('MKL');
  });

  it("keeps the residue of every two-base prefix that fixes the amino acid in the feature's table", () => {
    // standard code: the eight four-fold degenerate codon boxes
    for (const [tail, aa] of [
      ['CT', 'L'], ['GT', 'V'], ['TC', 'S'], ['CC', 'P'], ['AC', 'T'], ['GC', 'A'], ['CG', 'R'], ['GG', 'G'],
    ] as const) {
      expect(translateFeature(record(`ATGAAA${tail}`), cds([{ start: 0, end: 8 }], 1)), tail).toBe(`MK${aa}`);
    }
    // the table matters: CTN is Thr in the yeast mitochondrial code (table 3)
    const yeast = cds([{ start: 0, end: 8 }], 1, [{ key: 'transl_table', value: '3' }]);
    expect(translateFeature(record('ATGAAACT'), yeast)).toBe('MKT');
    expect(translateFeature(record('ATGAAACT'), cds([{ start: 0, end: 8 }], 1), { table: 3 })).toBe('MKT');
  });

  it('drops a padded codon that is ambiguous (X) and one-base tails', () => {
    expect(translateFeature(record('ATGAAAGA'), cds([{ start: 0, end: 8 }], 1))).toBe('MK'); // GAN = D or E
    expect(translateFeature(record('ATGAAAAA'), cds([{ start: 0, end: 8 }], 1))).toBe('MK'); // AAN = K or N
    expect(translateFeature(record('ATGAAATA'), cds([{ start: 0, end: 8 }], 1))).toBe('MK'); // TAN = Y or stop
    expect(translateFeature(record('ATGAAAG'), cds([{ start: 0, end: 7 }], 1))).toBe('MK'); // GNN
    expect(translateFeature(record('ATGAAAGS'), cds([{ start: 0, end: 8 }], 1))).toBe('MK'); // GSN = A or G
    expect(translateFeature(record('ATGAAAGY'), cds([{ start: 0, end: 8 }], 1))).toBe('MK'); // GYN = A or V
    // lower case and U are read as usual: 'cu' + N = CTN = Leu
    expect(translateFeature(record('ATGAAAcu', 'linear', 'RNA'), cds([{ start: 0, end: 8 }], 1))).toBe('MKL');
  });

  it('applies only to coding features; translate() keeps ignoring partial codons', () => {
    const rec = record('ATGAAAGC');
    const f = cds([{ start: 0, end: 8 }], 1);
    expect(translateFeature(rec, f, { cds: false })).toBe('MK');
    const gene: Feature = makeFeature({ type: 'gene', strand: 1, segments: [{ start: 0, end: 8 }] });
    expect(translateFeature(rec, gene)).toBe('MK');
    expect(translateFeature(rec, gene, { cds: true })).toBe('MKA');
    expect(translate('ATGAAAGC')).toBe('MK');
    expect(translate('ATGAAAGC', { cds: true })).toBe('MK');
  });

  it('validates the tail bases it translates and lets /transl_except override the padded codon', () => {
    expect(() => translateFeature(record('ATGAAAG-'), cds([{ start: 0, end: 8 }], 1))).toThrow(TranslationError);
    // non-coding translation does not read the tail, as translate() does not
    expect(translateFeature(record('ATGAAAG-'), cds([{ start: 0, end: 8 }], 1), { cds: false })).toBe('MK');
    const sec = cds([{ start: 0, end: 8 }], 1, [{ key: 'transl_except', value: '(pos:7..8,aa:Sec)' }]);
    expect(translateFeature(record('ATGAAAGC'), sec)).toBe('MKU'); // NCBI replaces the padded residue
    expect(translateFeature(record('ATGAAAGC'), sec, { translExcept: false })).toBe('MKA');
    // a stop codon completed by polyadenylation (TA + A tail) is still added by its TERM exception
    const term = cds([{ start: 0, end: 8 }], 1, [{ key: 'transl_except', value: '(pos:7..8,aa:TERM)' }]);
    expect(translateFeature(record('ATGAAATA'), term)).toBe('MK*');
    expect(translateFeature(record('ATGAAATA'), term, { toStop: true })).toBe('MK');
  });

  it('a CDS shorter than one codon translates its padded codon by the same rules', () => {
    expect(translateFeature(record('GC'), cds([{ start: 0, end: 2 }], 1))).toBe('A');
    expect(translateFeature(record('AT'), cds([{ start: 0, end: 2 }], 1))).toBe(''); // ATN = I or M
    expect(translateFeature(record('A'), cds([{ start: 0, end: 1 }], 1))).toBe('');
    // ATN is a start codon in every expansion of the vertebrate mitochondrial code, but its amino
    // acid is ambiguous (I or M), so NCBI drops it before considering the start codon
    expect(translateFeature(record('AT'), cds([{ start: 0, end: 2 }], 1, [{ key: 'transl_table', value: '2' }]))).toBe(
      '',
    );
  });

  it('features.json holds real NCBI CDSs with kept and dropped tails (checked against /translation above)', () => {
    // test/oracle/seqtools/ncbi/*.gb, see tools/oracle/seqtools_oracle.py
    const count = { kept: 0, keptMinusStrand: 0, droppedTwoBases: 0, droppedOneBase: 0 };
    for (const r of featureOracle.records) {
      for (const f of r.features) {
        if (f.translation === null) continue;
        const length = f.segments.reduce((n, s) => n + s.end - s.start, 0);
        const offset = Number(f.qualifiers.find((q) => q.key === 'codon_start')?.value ?? '1') - 1;
        const tail = (length - offset) % 3;
        if (tail === 0) continue;
        if (f.translation.length === Math.floor((length - offset) / 3) + 1) {
          count.kept++;
          if (f.strand === -1) count.keptMinusStrand++;
        } else if (tail === 2) count.droppedTwoBases++;
        else count.droppedOneBase++;
      }
    }
    expect(count).toEqual({ kept: 12, keptMinusStrand: 1, droppedTwoBases: 4, droppedOneBase: 3 });
  });
});

describe.skipIf(!HAS_VENV || !HAS_ECOLI)('translateFeature on every CDS of E. coli U00096.3 (live oracle)', () => {
  it('equals NCBI /translation for all 4300 translated CDS (joins, frameshifts, selenocysteine)', () => {
    const script = path.join(REPO_ROOT, 'tools/oracle/seqtools_live_cds.py');
    const exported = JSON.parse(
      execFileSync(VENV_PYTHON, ['-I', script, ECOLI_GENBANK], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }),
    ) as {
      length: number;
      topology: Topology;
      features: (Omit<OracleFeature, 'type' | 'bioPlain'> & { locusTag: string })[];
    };
    const rec = makeRecord({ seq: readGenbankSequence(ECOLI_GENBANK), topology: exported.topology });
    expect(rec.seq.length).toBe(exported.length);
    const mismatches: string[] = [];
    let compared = 0;
    let withExceptions = 0;
    const t0 = performance.now();
    for (const f of exported.features) {
      if (f.translation === null) continue;
      const feature: Feature = {
        ...makeFeature({ type: 'CDS', strand: f.strand, segments: f.segments, qualifiers: f.qualifiers }),
        partialStart: f.partialStart,
        partialEnd: f.partialEnd,
      };
      if (f.qualifiers.some((q) => q.key === 'transl_except')) withExceptions++;
      const ours = translateFeature(rec, feature);
      const protein = ours.endsWith('*') ? ours.slice(0, -1) : ours;
      if (protein !== f.translation) mismatches.push(f.locusTag);
      compared++;
    }
    const ms = performance.now() - t0;
    expect(compared).toBe(4300);
    expect(withExceptions).toBe(3); // fdhF, fdoG, fdnG: TGA read as selenocysteine
    expect(mismatches).toEqual([]);
    expect(ms).toBeLessThan(5000);
  });
});

describe('seq barrel (index.ts)', () => {
  it('exports the seqtools public API but not the internal mask/codon helpers', async () => {
    const api = await import('./index');
    for (const name of [
      'GENETIC_CODES',
      'NCBI_CODON_ORDER',
      'getGeneticCode',
      'TranslationError',
      'translate',
      'translateFeature',
      'findOrfs',
      'searchSequence',
      'searchProtein',
      'gcContent',
      'baseCounts',
      'dnaMolecularWeight',
      'proteinMolecularWeight',
      'proteinIsoelectricPoint',
      'proteinExtinctionCoefficient',
      'proteinChargeAtPh',
    ]) {
      expect(api).toHaveProperty(name);
    }
    const internal = [
      'NUCLEOTIDE_MASK',
      'compileGeneticCode',
      'encodeNucleotides',
      'codonKey',
      'charCodesToString',
      'characterAt',
    ];
    for (const name of internal) {
      expect(api).not.toHaveProperty(name);
    }
  });
});
