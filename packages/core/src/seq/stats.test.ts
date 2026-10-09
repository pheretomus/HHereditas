import { describe, expect, it } from 'vitest';
import { loadOracle, randomString, seededRandom } from '../../test/oracle/seqtools/oracle';
import { reverseComplement } from './alphabet';
import {
  baseCounts,
  dnaMolecularWeight,
  gcContent,
  proteinChargeAtPh,
  proteinExtinctionCoefficient,
  proteinIsoelectricPoint,
  proteinMolecularWeight,
} from './stats';

interface StatsOracle {
  gc: { seq: string; expected: number }[];
  mw: {
    seq: string;
    molecule: 'DNA' | 'RNA';
    doubleStranded: boolean;
    circular: boolean;
    monoisotopic: boolean;
    expected: number;
  }[];
  /** pI: Biopython's isoelectric_point(); pIRoot: the root of the same charge function to ~1e-12. */
  proteins: {
    protein: string;
    mw: number;
    pI: number;
    pIRoot: number;
    extinction: [number, number];
    charge: [number, number][];
  }[];
  ambiguousProteins: { protein: string; pI: number; pIRoot: number; extinction: [number, number] }[];
}

const oracle = loadOracle<StatsOracle>('stats.json');

/**
 * Biopython's isoelectric_point() bisects within [4.05, 12], so its result is the isoelectric point
 * only when the root of the charge function lies inside (margin: its 1e-4 resolution).
 */
const insideBiopythonBracket = (root: number) => root > 4.05 + 1e-4 && root < 12 - 1e-4;

/** Bisection to an interval of at most 1e-4, midpoint returned: at most 5e-5 from the root. */
const PI_RESOLUTION = 5e-5 + 1e-12;

/** The isoelectric point wherever it lies (the default reproduces Biopython's [4.05, 12] bisection). */
const UNBOUNDED = { interval: 'unbounded' } as const;

/** Biopython 1.88 ProteinAnalysis(p).isoelectric_point() when the root lies below 4.05 / above 12. */
const BIOPYTHON_LOW_BOUND = 4.0500284194946286;
const BIOPYTHON_HIGH_BOUND = 11.999967765808105;

/** True when pI is within PI_RESOLUTION of a sign change of the net charge (the isoelectric point). */
function isChargeRoot(protein: string, pI: number): boolean {
  return proteinChargeAtPh(protein, pI - PI_RESOLUTION) > 0 && proteinChargeAtPh(protein, pI + PI_RESOLUTION) <= 0;
}

/** Expect the unbounded pI of `protein` to be `root` (the charge function's root to 1e-9) within the bisection resolution. */
function expectPi(protein: string, root: number): void {
  expect(Math.abs(proteinIsoelectricPoint(protein, UNBOUNDED) - root), protein.slice(0, 30)).toBeLessThan(
    PI_RESOLUTION + 1e-9,
  );
}

describe('stats vs Biopython (stats.json)', () => {
  it(`gcContent equals gc_fraction(ambiguous="remove") on ${oracle.gc.length} sequences`, () => {
    for (const c of oracle.gc) expect(gcContent(c.seq), c.seq).toBeCloseTo(c.expected, 12);
  });

  it(`dnaMolecularWeight equals molecular_weight within 1e-6 Da on ${oracle.mw.length} cases`, () => {
    let maxDiff = 0;
    for (const c of oracle.mw) {
      const got = dnaMolecularWeight(c.seq, {
        molecule: c.molecule,
        doubleStranded: c.doubleStranded,
        circular: c.circular,
        monoisotopic: c.monoisotopic,
      });
      maxDiff = Math.max(maxDiff, Math.abs(got - c.expected));
    }
    expect(maxDiff).toBeLessThan(1e-6);
  });

  it(`protein molecular weight, pI, charge and extinction on ${oracle.proteins.length} proteins`, () => {
    let maxMw = 0;
    let maxPi = 0;
    let maxPiInBracket = 0;
    let maxPiRoot = 0;
    let maxCharge = 0;
    let outsideBracket = 0;
    for (const c of oracle.proteins) {
      maxMw = Math.max(maxMw, Math.abs(proteinMolecularWeight(c.protein) - c.mw));
      // default: Biopython's isoelectric_point(), bound included where the root lies outside [4.05, 12]
      maxPi = Math.max(maxPi, Math.abs(proteinIsoelectricPoint(c.protein) - c.pI));
      const root = proteinIsoelectricPoint(c.protein, UNBOUNDED);
      maxPiRoot = Math.max(maxPiRoot, Math.abs(root - c.pIRoot));
      if (insideBiopythonBracket(c.pIRoot)) {
        maxPiInBracket = Math.max(maxPiInBracket, Math.abs(root - c.pI));
      } else if (Math.abs(c.pIRoot - 4.05) > 1e-4 && Math.abs(c.pIRoot - 12) > 1e-4) {
        // Biopython returns its bracket bound, which is not an isoelectric point
        outsideBracket++;
        expect(Math.min(Math.abs(c.pI - 4.05), Math.abs(c.pI - 12))).toBeLessThan(1e-4);
      }
      for (const [pH, charge] of c.charge) {
        maxCharge = Math.max(maxCharge, Math.abs(proteinChargeAtPh(c.protein, pH) - charge));
      }
      expect(proteinExtinctionCoefficient(c.protein)).toEqual({ reduced: c.extinction[0], oxidized: c.extinction[1] });
    }
    expect(maxMw).toBeLessThan(1e-6);
    expect(maxPi).toBeLessThan(1e-9); // same bisection as Biopython: identical up to rounding, for every protein
    expect(maxPiInBracket).toBeLessThan(1e-9); // 'unbounded' is the same bisection inside [4.05, 12]
    expect(maxPiRoot).toBeLessThan(PI_RESOLUTION); // and with 'unbounded' every pI is the isoelectric point
    expect(outsideBracket).toBeGreaterThan(40); // the acidic / basic cases of the oracle are exercised
    expect(maxCharge).toBeLessThan(1e-9);
  });

  it(`pI and extinction ignore ambiguous residues like Biopython (${oracle.ambiguousProteins.length} proteins)`, () => {
    for (const c of oracle.ambiguousProteins) {
      expect(proteinIsoelectricPoint(c.protein)).toBeCloseTo(c.pI, 9);
      const root = proteinIsoelectricPoint(c.protein, UNBOUNDED);
      expect(Math.abs(root - c.pIRoot)).toBeLessThan(PI_RESOLUTION);
      if (insideBiopythonBracket(c.pIRoot)) expect(root).toBeCloseTo(c.pI, 9);
      expect(proteinExtinctionCoefficient(c.protein)).toEqual({ reduced: c.extinction[0], oxidized: c.extinction[1] });
    }
  });
});

describe('gcContent', () => {
  it('counts S as GC and W as AT and ignores other ambiguity codes', () => {
    expect(gcContent('')).toBe(0);
    expect(gcContent('NNNN')).toBe(0);
    expect(gcContent('G')).toBe(1);
    expect(gcContent('A')).toBe(0);
    expect(gcContent('ACGT')).toBe(0.5);
    expect(gcContent('ACGTNNNN')).toBe(0.5);
    expect(gcContent('SW')).toBe(0.5);
    expect(gcContent('GDVV')).toBe(1); // Biopython doctest
    expect(gcContent('ACTGSSSS')).toBe(0.75); // Biopython doctest
    expect(gcContent('acgt')).toBe(0.5);
    expect(gcContent('GGAUCUUCGGAUCU')).toBe(0.5); // RNA, Biopython doctest
    expect(gcContent('GC--AT')).toBe(0.5);
  });
});

describe('baseCounts', () => {
  it('always has A, C, G, T and adds other characters when present', () => {
    expect(baseCounts('')).toEqual({ A: 0, C: 0, G: 0, T: 0 });
    expect(baseCounts('AACGTTT')).toEqual({ A: 2, C: 1, G: 1, T: 3 });
    const counts = baseCounts('aAcN-u');
    expect(counts).toEqual({ A: 2, C: 1, G: 0, T: 0, '-': 1, N: 1, U: 1 });
    expect(Object.keys(counts)).toEqual(['A', 'C', 'G', 'T', '-', 'N', 'U']);
    expect(baseCounts('Aé')).toEqual({ A: 1, C: 0, G: 0, T: 0, é: 1 });
  });

  // Review regression: the documented key order (A, C, G, T first) cannot hold for digits in a plain
  // object: JavaScript always enumerates integer-like keys first, in ascending order (ECMA-262
  // OrdinaryOwnPropertyKeys). The documentation now states the order the Record really has.
  it('enumerates keys in the documented order: digits, then A, C, G, T, then by code unit', () => {
    expect(Object.keys(baseCounts('ACGT1'))).toEqual(['1', 'A', 'C', 'G', 'T']);
    expect(Object.keys(baseCounts('n9aZ0-é'))).toEqual(['0', '9', 'A', 'C', 'G', 'T', '-', 'N', 'Z', 'é']);
    const rand = seededRandom(5);
    for (let i = 0; i < 50; i++) {
      const s = randomString(rand, 'ACGTacgtN-019 *xéß', Math.floor(rand() * 60));
      const keys = Object.keys(baseCounts(s));
      const isDigit = (k: string) => k >= '0' && k <= '9';
      const digits = keys.filter(isDigit);
      const others = keys.filter((k) => !isDigit(k) && !'ACGT'.includes(k));
      expect(keys).toEqual([...[...digits].sort(), 'A', 'C', 'G', 'T', ...[...others].sort()]);
    }
  });

  it('counts sum to the sequence length (seeded random)', () => {
    const rand = seededRandom(1);
    for (let i = 0; i < 50; i++) {
      const s = randomString(rand, 'ACGTacgtRYSWKMBDHVN-', Math.floor(rand() * 500));
      const total = Object.values(baseCounts(s)).reduce((a, b) => a + b, 0);
      expect(total).toBe(s.length);
    }
  });
});

describe('dnaMolecularWeight', () => {
  it('matches the Biopython doctest values', () => {
    expect(dnaMolecularWeight('AGC')).toBeCloseTo(949.61, 2);
    expect(dnaMolecularWeight('AGC', { molecule: 'RNA' })).toBeCloseTo(997.61, 2);
    expect(dnaMolecularWeight('AGC', { doubleStranded: true })).toBeCloseTo(1890.2057, 4);
    expect(dnaMolecularWeight('AGC', { doubleStranded: true, circular: true })).toBeCloseTo(1854.1751, 4);
    expect(dnaMolecularWeight('A')).toBeCloseTo(331.2218, 4); // dAMP
    expect(dnaMolecularWeight('A', { circular: true })).toBeCloseTo(313.2065, 4);
  });

  it('5\'-OH oligonucleotides agree with the classic oligo formula within 0.01 Da per base', () => {
    // MW = 313.21 A + 304.2 T + 289.18 C + 329.21 G - 61.96 (5'-OH, 3'-OH single strand; Thermo Fisher/Ambion,
    // "DNA and RNA Molecular Weights and Conversions")
    expect(dnaMolecularWeight('A', { fivePrimePhosphate: false })).toBeCloseTo(251.242, 2); // deoxyadenosine
    const rand = seededRandom(77);
    for (let i = 0; i < 50; i++) {
      const s = randomString(rand, 'ACGT', 1 + Math.floor(rand() * 60));
      const n = (b: string) => [...s].filter((c) => c === b).length;
      const classic = 313.21 * n('A') + 304.2 * n('T') + 289.18 * n('C') + 329.21 * n('G') - 61.96;
      const ours = dnaMolecularWeight(s, { fivePrimePhosphate: false });
      expect(Math.abs(ours - classic)).toBeLessThan(0.01 * s.length + 0.01);
    }
    // circular molecules have no 5' end: the option is ignored
    const circular = dnaMolecularWeight('ACGT', { circular: true });
    expect(dnaMolecularWeight('ACGT', { circular: true, fivePrimePhosphate: false })).toBe(circular);
  });

  it('double-stranded weight is the sum of both strands', () => {
    const rand = seededRandom(3);
    for (let i = 0; i < 30; i++) {
      const s = randomString(rand, 'ACGT', 1 + Math.floor(rand() * 200));
      for (const circular of [false, true]) {
        const ds = dnaMolecularWeight(s, { doubleStranded: true, circular });
        const sum = dnaMolecularWeight(s, { circular }) + dnaMolecularWeight(reverseComplement(s), { circular });
        expect(ds).toBeCloseTo(sum, 6);
      }
    }
  });

  it('is case-insensitive and reads T as U for RNA', () => {
    expect(dnaMolecularWeight('acgt')).toBe(dnaMolecularWeight('ACGT'));
    expect(dnaMolecularWeight('ACGT', { molecule: 'RNA' })).toBe(dnaMolecularWeight('ACGU', { molecule: 'RNA' }));
  });

  it('weighs the empty sequence 0 and rejects ambiguous or invalid characters', () => {
    expect(dnaMolecularWeight('')).toBe(0);
    expect(dnaMolecularWeight('', { doubleStranded: true, circular: true })).toBe(0);
    expect(() => dnaMolecularWeight('ACGN')).toThrow(RangeError);
    expect(() => dnaMolecularWeight('ACGU')).toThrow(RangeError); // U is not a DNA base
    expect(() => dnaMolecularWeight('AC GT')).toThrow(RangeError);
    expect(() => dnaMolecularWeight('ACGT', { molecule: 'protein' as 'DNA' })).toThrow(RangeError);
    expect(() => dnaMolecularWeight('A😀')).toThrow(/'😀' at index 1/);
    expect(() => dnaMolecularWeight('Aſ')).toThrow(/'ſ' at index 1/);
  });
});

describe('protein statistics', () => {
  // the ProtParam module docstring example of Biopython 1.88
  const DOC =
    'MAEGEITTFTALTEKFNLPPGNYKKPKLLYCSNGGHFLRILPDGTVDGT' +
    'RDRSDQHIQLQLSAESVGEVYIKSTETGQYLAMDTSGLLYGSQTPSEEC' +
    'LFLERLEENHYNTYTSKKHAEKNWFVGLKKNGSCKRGPRTHYGQKAILF' +
    'LPLPV';

  it('matches the Biopython ProtParam doctest values', () => {
    expect(proteinMolecularWeight(DOC)).toBeCloseTo(17103.16, 2);
    expect(proteinIsoelectricPoint(DOC)).toBeCloseTo(7.72, 2);
    expect(proteinExtinctionCoefficient(DOC)).toEqual({ reduced: 17420, oxidized: 17545 });
    expect(proteinMolecularWeight('AGC')).toBeCloseTo(249.29, 2);
    expect(proteinIsoelectricPoint('INGAR')).toBeCloseTo(9.75, 2);
    expect(proteinChargeAtPh('INGAR', 7.0)).toBeCloseTo(0.76, 2);
    expect(proteinIsoelectricPoint('PETER')).toBeCloseTo(4.53, 2);
    expect(proteinChargeAtPh('PETER', 4.53)).toBeCloseTo(0, 2);
  });

  it('ignores one trailing stop and is case-insensitive', () => {
    expect(proteinMolecularWeight('MKW*')).toBe(proteinMolecularWeight('MKW'));
    expect(proteinMolecularWeight('mkw')).toBe(proteinMolecularWeight('MKW'));
    expect(proteinIsoelectricPoint('MKED*')).toBe(proteinIsoelectricPoint('MKED')); // C-terminal D pK, not '*'
    expect(proteinExtinctionCoefficient('mwyc*')).toEqual({ reduced: 6990, oxidized: 6990 });
  });

  it('handles single residues', () => {
    expect(proteinMolecularWeight('G')).toBeCloseTo(75.0666, 4); // free glycine, no peptide bond
    expect(proteinIsoelectricPoint('M')).toBeCloseTo(5.275022315979004, 9); // Biopython 1.88
    expect(proteinExtinctionCoefficient('W')).toEqual({ reduced: 5500, oxidized: 5500 });
    expect(proteinExtinctionCoefficient('C')).toEqual({ reduced: 0, oxidized: 0 }); // a lone Cys forms no cystine
  });

  it('handles empty proteins', () => {
    expect(proteinMolecularWeight('')).toBe(0);
    expect(proteinMolecularWeight('*')).toBe(0);
    expect(proteinIsoelectricPoint('')).toBeNaN();
    expect(proteinChargeAtPh('', 7)).toBeNaN();
    expect(proteinExtinctionCoefficient('')).toEqual({ reduced: 0, oxidized: 0 });
  });

  it('rejects residues without a defined mass, internal stops and non-letters', () => {
    expect(() => proteinMolecularWeight('MKX')).toThrow(RangeError);
    expect(() => proteinMolecularWeight('MB')).toThrow(RangeError);
    expect(() => proteinMolecularWeight('M*K')).toThrow(RangeError);
    expect(() => proteinIsoelectricPoint('M*K')).toThrow(RangeError);
    expect(() => proteinIsoelectricPoint('MK1')).toThrow(RangeError);
    expect(() => proteinExtinctionCoefficient('MK-')).toThrow(RangeError);
    expect(proteinMolecularWeight('MUO')).toBeCloseTo(536.5473, 4); // Sec and Pyl have masses
  });

  // Review regression: the spec requires proteinIsoelectricPoint to equal Biopython's
  // ProteinAnalysis(p).isoelectric_point() within 0.01, but the search interval had been widened past
  // Biopython's [4.05, 12], so short acidic peptides (DL, EA, the FLAG tag) and very basic ones
  // differed by up to 0.45. The default now is Biopython's computation; `interval: 'unbounded'` gives
  // the root of the charge function wherever it lies (tests below).
  it('equals Biopython isoelectric_point() by default, also when the root lies outside [4.05, 12]', () => {
    // tools/oracle/.venv/bin/python -I -c "from Bio.SeqUtils.ProtParam import ProteinAnalysis as PA;
    //   print(PA('DL').isoelectric_point())"   (Biopython 1.88)
    const biopython: Record<string, number> = {
      DL: 4.0500284194946286,
      EA: 4.0500284194946286,
      DYKDDDDK: 4.0500284194946286,
      EWGVFWYTWWDTFEWIFYED: 4.0500284194946286,
      RKKHR: 11.999967765808105,
      DD: 4.0500284194946286,
      RR: 11.999967765808105,
      D: 4.299381065368652,
      R: 9.750021171569824,
      MDYKDHDGDYKDHDIDYKDDDDK: 4.155976295471191,
    };
    for (const [p, pi] of Object.entries(biopython)) {
      expect(Math.abs(proteinIsoelectricPoint(p) - pi), p).toBeLessThan(0.01);
      expect(proteinIsoelectricPoint(p), p).toBeCloseTo(pi, 9); // the same bisection, step by step
      expect(proteinIsoelectricPoint(p, { interval: 'biopython' }), p).toBe(proteinIsoelectricPoint(p));
    }
  });

  it('validates the interval option', () => {
    expect(() => proteinIsoelectricPoint('MK', { interval: 'wide' as 'unbounded' })).toThrow(RangeError);
    expect(proteinIsoelectricPoint('', UNBOUNDED)).toBeNaN();
    expect(proteinIsoelectricPoint('MKED*', UNBOUNDED)).toBe(proteinIsoelectricPoint('MKED'));
  });

  // Review regression (opt-in since the spec makes Biopython's result the default): Biopython's
  // bisection only searches [4.05, 12] and returns its bound for proteins whose isoelectric point lies
  // outside (FLAG tag, poly-Asp, prothymosin alpha, protamine). interval 'unbounded' finds the root.
  it("interval 'unbounded' does not clamp pI to Biopython's bisection interval [4.05, 12]", () => {
    // roots of Biopython's charge_at_pH, bisected in Python to 1e-12
    expectPi('DDDDDDDDDD', 3.079698908);
    expectPi('KKKKKKKKKKRRRRRRRR', 12.852109764);
    // the default is Biopython's isoelectric_point(), the bound of its interval here
    expect(proteinIsoelectricPoint('DDDDDDDDDD')).toBeCloseTo(BIOPYTHON_LOW_BOUND, 9);
    expect(proteinIsoelectricPoint('KKKKKKKKKKRRRRRRRR')).toBeCloseTo(BIOPYTHON_HIGH_BOUND, 9);
    for (const p of ['DDDDDDDDDD', 'KKKKKKKKKKRRRRRRRR', 'D', 'DD', 'R', 'RR', 'E'.repeat(10)]) {
      expect(isChargeRoot(p, proteinIsoelectricPoint(p, UNBOUNDED)), p).toBe(true);
    }
  });

  it("interval 'unbounded': pI is a root of the charge model, not clamped at 4.05 (FLAG tag, prothymosin alpha)", () => {
    const FLAG = 'DYKDDDDK'; // ExPASy Compute pI/Mw: 3.97
    // prothymosin alpha, UniProt P06454
    const PTMA =
      'MSDAAVDTSSEITTKDLKEKKEVVEEAENGRDAPANGNAENEENGEQEADNEVDEEEEEGGEEEEEEEEGDGEEEDGDEDEEAESATGKRAAEDDEDDDVDTKKQKTDEDD';
    for (const p of [FLAG, PTMA]) {
      const pI = proteinIsoelectricPoint(p, UNBOUNDED);
      expect(Math.abs(proteinChargeAtPh(p, pI))).toBeLessThan(0.01);
      // Biopython's (default) result is its bound, where the net charge is clearly negative
      expect(proteinIsoelectricPoint(p)).toBeCloseTo(BIOPYTHON_LOW_BOUND, 9);
      expect(proteinChargeAtPh(p, proteinIsoelectricPoint(p))).toBeLessThan(-0.2);
    }
    expect(proteinIsoelectricPoint(FLAG, UNBOUNDED)).toBeCloseTo(3.97, 2);
    expect(proteinIsoelectricPoint(PTMA, UNBOUNDED)).toBeCloseTo(3.69, 1);
  });

  it("interval 'unbounded' agrees with ExPASy Compute pI/Mw where the two charge models coincide", () => {
    // ExPASy Compute pI/Mw (https://web.expasy.org/compute_pi/, average resolution), queried 2026-10-08;
    // UniProt sequences P06454 (prothymosin alpha), P04553 (protamine P1), P07305 (histone H1.0).
    // ExPASy uses the same Bjellqvist pKs except a C-terminal pK of 3.55 for every residue (Biopython:
    // 4.55 after D, 4.75 after E) and limits pI to [0, 14]; both reproduce all values below to 0.005.
    const PRM1 = 'MARYRCCRSQSRSRYYRQRQRSRRRRRRSCQTRRRAMRCCRPRYRPRCRRH';
    const H1_0 =
      'MTENSTSAPAAKPKRAKASKKSTDHPKYSDMIVAAIQAEKNRAGSSRQSIQKYIKSHYKVGENADSQIKLSIKRLVTTGVLKQTKGVGASGSFRLAKSDEPKKSVAFKK' +
      'TKKEIKKVATPKKASKPKKAASKAPTKKPKATPVKKAKKKLAATPKKAKKPKTVKAKPVKASKPKKAKPVKPKAKSSAKRAGKKK';
    const PTMA =
      'MSDAAVDTSSEITTKDLKEKKEVVEEAENGRDAPANGNAENEENGEQEADNEVDEEEEEGGEEEEEEEEGDGEEEDGDEDEEAESATGKRAAEDDEDDDVDTKKQKTDEDD';
    const sameModel: [string, number][] = [
      ['DYKDDDDK', 3.97], // FLAG tag: below Biopython's 4.05
      ['MDYKDHDGDYKDHDIDYKDDDDK', 4.16], // 3xFLAG
      [PRM1, 12.08], // above Biopython's 12
      ['R'.repeat(10), 12.95],
      ['KKKKKKKKKKRRRRRRRR', 12.85],
      ['D'.repeat(2000), 0.75], // C-terminal D, but its pK is irrelevant this far below it
      [H1_0, 10.84],
      ['INGAR', 9.75],
      ['PETER', 4.53],
      ['AVAS', 5.57], // N-terminal pKs: A 7.59, M 7.0, S 6.93, P 8.36, T 6.82, V 7.44
      ['MLNGQ', 5.28],
      ['STSFFFT', 5.24],
      ['PGAVFT', 5.96],
      ['TWNT', 5.19],
      ['VAVWLAT', 5.49],
    ];
    for (const [p, expasy] of sameModel) {
      const pI = proteinIsoelectricPoint(p, UNBOUNDED);
      expect(Math.abs(pI - expasy), p.slice(0, 20)).toBeLessThanOrEqual(0.005 + PI_RESOLUTION);
      expect(isChargeRoot(p, pI)).toBe(true);
    }
    // C-terminal D or E: ExPASy's lower C-terminal pK gives lower values (E10 3.29, D10 2.98, DD 3.56,
    // PTMA 3.66); ours stay the roots of Biopython's charge function
    expectPi('E'.repeat(10), 3.471055742);
    expectPi('D'.repeat(10), 3.079698908);
    expectPi('DD', 3.891651766);
    expectPi(PTMA, 3.686067066);
    // outside [0, 14] ExPASy reports its bounds (R200 14.00, D12000 0.00); this module reports the root
    expectPi('R'.repeat(200), 14.298853146);
    expectPi('D'.repeat(12000), -0.029156512);
  });

  it("interval 'unbounded': pI is the root of the charge, which decreases with pH (seeded random)", () => {
    const rand = seededRandom(11);
    let inside = 0;
    for (let i = 0; i < 100; i++) {
      const p = randomString(rand, 'ACDEFGHIKLMNPQRSTVWY', 1 + Math.floor(rand() * 300));
      const pI = proteinIsoelectricPoint(p, UNBOUNDED);
      expect(isChargeRoot(p, pI), p).toBe(true);
      expect(Math.abs(proteinChargeAtPh(p, pI))).toBeLessThan(0.01);
      expect(proteinChargeAtPh(p, 3)).toBeGreaterThan(proteinChargeAtPh(p, 7));
      expect(proteinChargeAtPh(p, 7)).toBeGreaterThan(proteinChargeAtPh(p, 11));
      // inside Biopython's interval the default is the very same number
      if (insideBiopythonBracket(pI)) {
        inside++;
        expect(proteinIsoelectricPoint(p), p).toBe(pI);
      }
    }
    expect(inside).toBeGreaterThan(80);
    // very acidic and very basic compositions, including ones far outside [4.05, 12]
    for (let i = 0; i < 100; i++) {
      const p = randomString(rand, i % 2 === 0 ? 'DEDEDEK' : 'KRKRKRD', 1 + Math.floor(rand() * 2000));
      expect(isChargeRoot(p, proteinIsoelectricPoint(p, UNBOUNDED)), p.slice(0, 30)).toBe(true);
    }
  });

  // Review regression: protein letters were upper-cased with String.prototype.toUpperCase before
  // validation, so 'ß' was read as 'SS' and 'ı' as 'I', and error messages named the wrong character.
  it('accepts ASCII amino-acid letters only and names the offending character and index', () => {
    for (const bad of ['ß', 'ı', 'ſ', 'ﬁ', 'ﬀ', 'Ｍ']) {
      expect(() => proteinMolecularWeight(bad), bad).toThrow(RangeError);
      expect(() => proteinIsoelectricPoint(bad), bad).toThrow(RangeError);
      expect(() => proteinChargeAtPh(bad, 7), bad).toThrow(RangeError);
      expect(() => proteinExtinctionCoefficient(bad), bad).toThrow(RangeError);
    }
    expect(() => proteinMolecularWeight('MKßX')).toThrow(/'ß' at index 2/);
    expect(() => proteinIsoelectricPoint('MKıX')).toThrow(/'ı' at index 2/);
    expect(() => proteinExtinctionCoefficient('MKſ')).toThrow(/'ſ' at index 2/);
    expect(() => proteinMolecularWeight('MK😀')).toThrow(/'😀' at index 2/);
    expect(() => proteinMolecularWeight('MKX')).toThrow(/'X' at index 2/);
    expect(() => proteinMolecularWeight('M*K*')).toThrow(/'\*' at index 1/);
    expect(proteinMolecularWeight('mkw*')).toBe(proteinMolecularWeight('MKW'));
  });

  it('molecular weight is additive minus one water per joined peptide bond', () => {
    const rand = seededRandom(12);
    for (let i = 0; i < 50; i++) {
      const a = randomString(rand, 'ACDEFGHIKLMNPQRSTVWY', 1 + Math.floor(rand() * 50));
      const b = randomString(rand, 'ACDEFGHIKLMNPQRSTVWY', 1 + Math.floor(rand() * 50));
      const joined = proteinMolecularWeight(a) + proteinMolecularWeight(b) - 18.0153; // one more peptide bond
      expect(proteinMolecularWeight(a + b)).toBeCloseTo(joined, 6);
    }
  });
});
