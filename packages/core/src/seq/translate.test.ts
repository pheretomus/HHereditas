import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ECOLI_GENBANK,
  HAS_ECOLI,
  HAS_VENV,
  ORACLE_DIR,
  REPO_ROOT,
  VENV_PYTHON,
  loadOracle,
  parseGcPrt,
  randomString,
  readGenbankSequence,
  seededRandom,
} from '../../test/oracle/seqtools/oracle';
import type { Feature, Qualifier, Range, SeqRecord, Strand, Topology } from '../types';
import { IUPAC_DNA, reverseComplement } from './alphabet';
import { GENETIC_CODES } from './codon-tables';
import { featureSequence, makeFeature, makeRecord } from './features';
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

  // Review regression: the initiator codon became M only when every expansion was a start codon,
  // and otherwise fell back to the consensus of the internal readings. When the expansions mix
  // start and non-start codons that share one internal residue (GTN in table 11: GTG = M as
  // initiator, GTA/GTC/GTT = V), that asserted V although the initiator residue is M or V. NCBI's
  // start-residue consensus (CTrans_table::x_InitFsaTransl) gives X there.
  it('cds: an ambiguous initiator codon mixing start and non-start codons is X, not their internal residue', () => {
    expect(translate('GTNAAATAA', { table: 11, cds: true })).toBe('XK*'); // GTG start, GTA/GTC/GTT not
    expect(translate('CTNAAATAA', { table: 1, cds: true })).toBe('XK*'); // CTG is a table-1 start
    expect(translate('TTRAAATAA', { table: 1, cds: true })).toBe('XK*'); // TTG start, TTA not
    expect(translate('MTCAAATAA', { table: 2, cds: true })).toBe('XK*'); // ATC start (I), CTC not (L)
    expect(translate('ATYAAATAA', { table: 23, cds: true })).toBe('XK*'); // ATT start (I), ATC not
    // the internal reading is unchanged
    expect(translate('GTNAAATAA', { table: 11 })).toBe('VK*');
    expect(translate('MTCAAATAA', { table: 2 })).toBe('JK*');
    // every reading agrees: ATR in table 21 is ATA (Met, not a start) or ATG (start). (AAA is Asn in
    // table 21, the trematode mitochondrial code: Biopython translate('ATRAAATAA', table=21) = 'MN*'.)
    expect(translate('ATRAAATAA', { table: 21, cds: true })).toBe('MN*');
    // all starts / no starts are unaffected
    expect(translate('NTGAAATAA', { table: 11, cds: true })).toBe('MK*'); // ATG CTG GTG TTG: all starts
    expect(translate('GCNAAATAA', { table: 11, cds: true })).toBe('AK*');
  });

  // The initiator rule against an independent implementation: a literal port of NCBI's start-residue
  // consensus (C++ Toolkit src/objects/seqfeat/Genetic_code_table.cpp, CTrans_table::x_InitFsaTransl,
  // which x_Translate / TranslateToProtein emit for the first codon of a 5'-complete coding region),
  // run on the verbatim gc.prt 4.6, for every IUPAC codon of every table.
  it("cds initiator equals NCBI's start-residue consensus except where it is documented to say more", () => {
    const TCAG = 'TCAG';
    /** NCBI: combine the sncbieaa flags of the expansions; disagreement -> X; all-stop -> default '-'. */
    const ncbiStartResidue = (sncbieaa: string, codon: string): string => {
      let orf = '';
      for (const b1 of IUPAC_DNA[codon[0]]) {
        for (const b2 of IUPAC_DNA[codon[1]]) {
          for (const b3 of IUPAC_DNA[codon[2]]) {
            const flag = sncbieaa[16 * TCAG.indexOf(b1) + 4 * TCAG.indexOf(b2) + TCAG.indexOf(b3)];
            orf = orf === '' || orf === flag ? flag : 'X';
          }
        }
      }
      return orf === '*' ? '-' : orf; // m_OrfStart keeps its initial '-' when the consensus is '*'
    };
    const ncbi = parseGcPrt(readFileSync(path.join(ORACLE_DIR, 'ncbi_gc.prt'), 'ascii'));
    const codons = allIupacCodons(codonsOracle.alphabet);
    let agreeing = 0;
    let mixedStarts = 0;
    const allMet: string[] = []; // NCBI X, here M: start and non-start codons, all of them Met
    const contextStops: string[] = []; // NCBI X, here the amino acid: no start, context stop + non-stop
    for (const code of GENETIC_CODES) {
      const ref = ncbi.get(code.id);
      expect(ref, `table ${code.id}`).toBeDefined();
      if (!ref) continue;
      for (const codon of codons) {
        const ours = translate(codon, { table: code.id, cds: true });
        const internal = translate(codon, { table: code.id });
        const theirs = ncbiStartResidue(ref.sncbieaa, codon);
        if (theirs === '-') {
          expect(ours, `${code.id} ${codon}`).toBe(internal); // not a start codon: its amino acid
          continue;
        }
        if (theirs === 'X' && /[^X*]/.test(internal) && ours === 'X') mixedStarts++;
        if (ours === theirs) {
          agreeing++;
        } else if (theirs === 'X' && ours === 'M' && internal === 'M') {
          allMet.push(`${code.id}:${codon}`);
        } else if (theirs === 'X' && ours === internal && [27, 28, 31].includes(code.id)) {
          contextStops.push(`${code.id}:${codon}`);
        } else {
          expect.fail(`table ${code.id} ${codon}: NCBI start residue ${theirs}, here ${ours}`);
        }
      }
    }
    expect(agreeing).toBe(38047);
    // the review's count: 193 (table, codon) pairs had been given their internal L, V, I or J
    expect(mixedStarts).toBe(193);
    expect(allMet).toEqual(['21:ATR']);
    expect(contextStops).toHaveLength(20);
    expect(contextStops).toContain('27:TGR');
    for (const c of contextStops) {
      const [table, codon] = c.split(':');
      expect(translate(codon, { table: Number(table) }), c).not.toBe('X');
    }
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
    // an unknown table id in the feature is feature data (TranslationError naming it, see the review
    // tests below); an unknown options.table is the caller's error
    expect(() => translateFeature(rec, cds([{ start: 0, end: 9 }], 1, [{ key: 'transl_table', value: '7' }]))).toThrow(
      TranslationError,
    );
    expect(() => translateFeature(rec, cds([{ start: 0, end: 9 }], 1), { table: 7 })).toThrow(RangeError);
  });

  // Review regression: Number('') and Number('  ') are 0, so an empty /transl_table (GenBank
  // "/transl_table=", read as '') passed the integer check and failed later with "Unknown NCBI
  // genetic code (translation table) 0", a RangeError that does not name the feature; unknown ids
  // (/transl_table=8) also escaped as RangeErrors that do not say which feature is malformed.
  describe('review: malformed /transl_table and /codon_start values name the feature', () => {
    const rec = record('ATGAAACCCTAA');
    const withQualifiers = (qualifiers: Qualifier[]) =>
      makeFeature({ type: 'CDS', name: 'geneX', strand: 1, segments: [{ start: 0, end: 12 }], qualifiers });
    const table = (value: string | null) => withQualifiers([{ key: 'transl_table', value }]);
    const codonStart = (value: string | null) => withQualifiers([{ key: 'codon_start', value }]);

    it('an empty or blank /transl_table is a TranslationError naming the feature', () => {
      for (const value of ['', ' ', '\t ']) {
        expect(() => translateFeature(rec, table(value)), JSON.stringify(value)).toThrow(TranslationError);
        expect(() => translateFeature(rec, table(value)), JSON.stringify(value)).toThrow(/geneX/);
      }
    });

    it('an unknown /transl_table id is a TranslationError naming the feature and the value', () => {
      for (const value of ['8', '17', '0', '34', '7']) {
        expect(() => translateFeature(rec, table(value)), value).toThrow(TranslationError);
        expect(() => translateFeature(rec, table(value)), value).toThrow(
          new RegExp(`geneX.*/transl_table="${value}".*unknown NCBI genetic code`),
        );
      }
      // options.table is the caller's setting, not feature data: still a RangeError
      expect(() => translateFeature(rec, withQualifiers([]), { table: 8 })).toThrow(RangeError);
    });

    it('only plain decimal integers are table ids or codon starts (no hex, exponent, sign or fraction)', () => {
      for (const value of ['0x0B', '1e1', '+11', '11.0', '11.5', '-1', '1 1', 'Infinity', '11a']) {
        expect(() => translateFeature(rec, table(value)), value).toThrow(TranslationError);
        expect(() => translateFeature(rec, table(value)), value).toThrow(/geneX/);
      }
      for (const value of ['', ' ', '0x1', '1e0', '+1', '1.0', 'Infinity']) {
        expect(() => translateFeature(rec, codonStart(value)), JSON.stringify(value)).toThrow(TranslationError);
        expect(() => translateFeature(rec, codonStart(value)), JSON.stringify(value)).toThrow(/geneX/);
      }
      // surrounding white space and leading zeros are fine
      expect(translateFeature(rec, table(' 11 '))).toBe('MKP*');
      expect(translateFeature(rec, table('011'))).toBe('MKP*');
      expect(translateFeature(rec, codonStart(' 1 '))).toBe('MKP*');
    });

    it('a value-less /transl_table or /codon_start (GenBank "/transl_table" without "=") is not silently ignored', () => {
      expect(() => translateFeature(rec, table(null))).toThrow(TranslationError);
      expect(() => translateFeature(rec, table(null))).toThrow(/geneX.*\/transl_table/);
      expect(() => translateFeature(rec, codonStart(null))).toThrow(TranslationError);
      expect(() => translateFeature(rec, codonStart(null))).toThrow(/geneX.*\/codon_start/);
      // same for /transl_except (getQualifiers skips value-less qualifiers), unless it is not applied
      const except = withQualifiers([{ key: 'transl_except', value: null }]);
      expect(() => translateFeature(rec, except)).toThrow(TranslationError);
      expect(() => translateFeature(rec, except)).toThrow(/geneX.*\/transl_except/);
      expect(translateFeature(rec, except, { translExcept: false })).toBe('MKP*');
    });

    it('conflicting repeated values are rejected, repeated equal values accepted', () => {
      const twoTables = withQualifiers([
        { key: 'transl_table', value: '11' },
        { key: 'transl_table', value: '4' },
      ]);
      expect(() => translateFeature(rec, twoTables)).toThrow(TranslationError);
      expect(() => translateFeature(rec, twoTables)).toThrow(/geneX.*conflicting/);
      const sameTables = withQualifiers([
        { key: 'transl_table', value: '11' },
        { key: 'transl_table', value: ' 11' },
      ]);
      expect(translateFeature(rec, sameTables)).toBe('MKP*');
      const twoStarts = withQualifiers([
        { key: 'codon_start', value: '1' },
        { key: 'codon_start', value: '2' },
      ]);
      expect(() => translateFeature(rec, twoStarts)).toThrow(/geneX.*conflicting/);
    });
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

  // Review regression (see the translate test of the same name): translateFeature reads the first
  // codon of a 5'-complete CDS with the same initiator rule.
  it('an ambiguous initiator codon mixing start and non-start codons is X (5\'-complete CDS)', () => {
    const t11 = [{ key: 'transl_table', value: '11' }];
    expect(translateFeature(record('GTNAAATAA'), cds([{ start: 0, end: 9 }], 1, t11))).toBe('XK*');
    expect(translateFeature(record('CTNAAATAA'), cds([{ start: 0, end: 9 }], 1))).toBe('XK*');
    expect(translateFeature(record(reverseComplement('GTNAAATAA')), cds([{ start: 0, end: 9 }], -1, t11))).toBe('XK*');
    // a 5'-partial CDS keeps the internal reading of its first codon
    expect(translateFeature(record('GTNAAATAA'), cds([{ start: 0, end: 9 }], 1, t11, { partialStart: true }))).toBe(
      'VK*',
    );
    // a CDS shorter than one codon: GT + N = GTN, internal V (kept), initiator X (NCBI TranslateToProtein)
    expect(translateFeature(record('GT'), cds([{ start: 0, end: 2 }], 1, t11))).toBe('X');
    expect(translateFeature(record('GT'), cds([{ start: 0, end: 2 }], 1, t11, { partialStart: true }))).toBe('V');
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
    // droppedOneBase: 3 partial-cds records, plus (final verification) the 3'-truncated last CDS of
    // AF153454.1 and the four Drosophila mitochondrial CDSs of NC_024511.2 whose T stop codon is
    // completed by polyadenylation (aa:TERM, two on each strand; /translation has no residue for it)
    expect(count).toEqual({ kept: 12, keptMinusStrand: 1, droppedTwoBases: 4, droppedOneBase: 8 });
  });

  it('features.json holds real NCBI CDSs with Sec, Pyl and minus-strand TERM exceptions and tables 5 and 33', () => {
    // records added by the final verification, see tools/oracle/seqtools_oracle.py; each CDS is
    // compared with its /translation by the per-record tests above
    const exceptions: string[] = [];
    const tables = new Set<string>();
    for (const r of featureOracle.records) {
      for (const f of r.features) {
        for (const q of f.qualifiers) {
          if (q.key === 'transl_table' && q.value !== null) tables.add(q.value);
          if (q.key === 'transl_except' && f.translation !== null) exceptions.push(`${r.id} ${f.strand} ${q.value}`);
        }
      }
    }
    expect(exceptions).toEqual(
      expect.arrayContaining([
        'AF153454.1 1 (pos:922..924,aa:Pyl)',
        'NM_000581.4 1 (pos:220..222,aa:Sec)',
        'NC_024511.2 1 (pos:1263,aa:TERM)',
        'NC_024511.2 -1 (pos:complement(6409),aa:TERM)',
        'NC_024511.2 -1 (pos:complement(8207),aa:TERM)',
      ]),
    );
    expect([...tables].sort((a, b) => Number(a) - Number(b))).toEqual(['2', '4', '5', '11', '13', '33']);
    // the Pyl and Sec residues really are in NCBI's /translation, where our exception puts them
    const gpx1 = featureOracle.records.find((r) => r.id === 'NM_000581.4')?.features[0];
    expect(gpx1?.translation?.[(219 - 75) / 3]).toBe('U');
    const mtmb = featureOracle.records.find((r) => r.id === 'AF153454.1')?.features[0];
    expect(mtmb?.translation?.[(921 - 0) / 3]).toBe('O');
  });
});

// Verification: /transl_except positions are mapped into the feature's reading frame by
// featureLocalIndex (segments in join order, origin wraps, strand flip, /codon_start). Here an
// independent map (the parent index of every base of the feature's own sequence) picks a codon,
// writes its positions in one of the INSDC forms, and the override must land exactly there.
describe('translateFeature: /transl_except lands on the intended codon (seeded random)', () => {
  it('for random strands, joins, origin-wrapping segments, codon_start and partial last codons', () => {
    const rand = seededRandom(77007);
    const seen = { checked: 0, wrapping: 0, splitCodons: 0, tails: 0 };
    for (let n = 0; n < 2500; n++) {
      const L = 20 + Math.floor(rand() * 60);
      const topology: Topology = rand() < 0.6 ? 'circular' : 'linear';
      const seq = randomString(rand, 'ACGT', L);
      // lay down 1-3 non-overlapping segments walking 5'->3' along the top strand
      const segments: Range[] = [];
      let cursor = Math.floor(rand() * (topology === 'circular' ? L : L / 2));
      const first = cursor;
      for (let i = 1 + Math.floor(rand() * 3); i > 0; i--) {
        const len = 4 + Math.floor(rand() * 12);
        if (topology === 'linear' ? cursor + len > L : cursor + len - first > L) break;
        const start = topology === 'circular' ? cursor % L : cursor;
        segments.push({ start, end: start + len });
        cursor += len + Math.floor(rand() * 4);
      }
      if (segments.length === 0) continue;
      const strand = rand() < 0.5 ? 1 : -1;
      const codonStart = 1 + Math.floor(rand() * 3);
      const positions: number[] = [];
      for (const s of segments) for (let p = s.start; p < s.end; p++) positions.push(p % L);
      if (strand === -1) positions.reverse();
      const offset = codonStart - 1;
      const complete = Math.floor((positions.length - offset) / 3);
      const tail = (positions.length - offset) % 3;
      const onTail = tail > 0 && rand() < 0.3; // a stop codon completed by polyadenylation: aa:TERM
      if (complete === 0 && !onTail) continue;
      const k = onTail ? complete : Math.floor(rand() * complete);
      const codon = positions.slice(offset + 3 * k, offset + 3 * k + (onTail ? tail : 3));
      const sorted = [...codon].sort((a, b) => a - b);
      const contiguous = sorted.every((p, i) => i === 0 || p === sorted[i - 1] + 1);
      let location =
        contiguous && rand() < 0.6
          ? sorted.length === 1
            ? `${sorted[0] + 1}`
            : `${sorted[0] + 1}..${sorted[sorted.length - 1] + 1}`
          : `join(${codon.map((p) => p + 1).join(',')})`;
      if (strand === -1 && rand() < 0.7) location = `complement(${location})`;
      const feature = makeFeature({
        type: 'CDS',
        name: 'probe',
        strand,
        segments,
        qualifiers: [
          { key: 'codon_start', value: String(codonStart) },
          { key: 'transl_except', value: `(pos:${location},aa:${onTail ? 'TERM' : 'Sec'})` },
        ],
      });
      const plain = translate(featureSequence(feature, seq).slice(offset));
      const expected = onTail ? `${plain}*` : `${plain.slice(0, k)}U${plain.slice(k + 1)}`;
      const label = `${seq} ${topology} ${JSON.stringify(segments)} strand ${strand} codon_start ${codonStart} ${location}`;
      expect(translateFeature(makeRecord({ seq, topology }), feature, { cds: false }), label).toBe(expected);
      seen.checked++;
      if (segments.some((s) => s.end > L)) seen.wrapping++;
      if (!contiguous) seen.splitCodons++;
      if (onTail) seen.tails++;
    }
    expect(seen.checked).toBeGreaterThan(2000);
    expect(seen.wrapping).toBeGreaterThan(300);
    expect(seen.splitCodons).toBeGreaterThan(100);
    expect(seen.tails).toBeGreaterThan(300);
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
