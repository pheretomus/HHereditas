import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { reverseComplement } from '../seq/alphabet';
import {
  DEFAULT_TM_CONDITIONS,
  TM_EXACT_EXPANSION_LIMIT,
  divalentToMonovalentMilliMolar,
  oligoGcContent,
  resolveTmConditions,
  sodiumEquivalentMilliMolar,
  thermo,
  tm,
  tmExtremes,
  tmRange,
  tmResolved,
  type SaltCorrectionMethod,
  type TmConditions,
} from './tm';

type TmRow = [string, number, number, number, number, number, number, number];
type AdditiveRow = [string, number, number, number, number, number, number, number, number, number, number];
type BioRow = [string, number, number, number, number, number, number];
/** [seq, mv (always 0), dv, dntp, dna, Biopython Tm_NN saltcorr=7] */
type BioNoMonovalentRow = [string, number, number, number, number, number];
interface TmOracle {
  random: TmRow[];
  selfComplementary: TmRow[];
  short: TmRow[];
  long: TmRow[];
  additives: AdditiveRow[];
  biopython: BioRow[];
  biopythonNoMonovalent: BioNoMonovalentRow[];
}

const oracle = JSON.parse(
  readFileSync(new URL('../../test/oracle/primers/tm.json', import.meta.url), 'utf8'),
) as TmOracle;

const PRIMER3_METHODS: SaltCorrectionMethod[] = ['schildkraut', 'santalucia', 'owczarzy'];

function conditionsOf(row: TmRow | AdditiveRow | BioRow | BioNoMonovalentRow, method: SaltCorrectionMethod): Partial<TmConditions> {
  return {
    monovalentMilliMolar: row[1],
    divalentMilliMolar: row[2],
    dntpMilliMolar: row[3],
    oligoNanoMolar: row[4],
    saltCorrection: method,
  };
}

/** Largest |ours − oracle| over a set of rows for one method column. */
function maxDeviation(rows: TmRow[], method: SaltCorrectionMethod): { max: number; worst: string } {
  const col = 5 + PRIMER3_METHODS.indexOf(method);
  let max = 0;
  let worst = '';
  for (const row of rows) {
    const d = Math.abs(tm(row[0], conditionsOf(row, method)) - (row[col] as number));
    if (!(d <= max)) {
      max = d;
      worst = `${row[0]} ${JSON.stringify(row.slice(1, 5))}`;
    }
  }
  return { max, worst };
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomDna(random: () => number, length: number, gc = 0.5): string {
  let s = '';
  for (let i = 0; i < length; i++) {
    s += random() < gc ? (random() < 0.5 ? 'G' : 'C') : random() < 0.5 ? 'A' : 'T';
  }
  return s;
}

describe('tm vs primer3-py calc_tm (oracle)', () => {
  it('has the required number of 8–60 nt random cases', () => {
    const inRange = oracle.random.filter((r) => r[0].length >= 8 && r[0].length <= 60);
    expect(inRange.length).toBeGreaterThanOrEqual(2000);
  });

  for (const method of PRIMER3_METHODS) {
    it(`matches primer3 '${method}' on random 8–60 nt oligos across the condition grid`, () => {
      const { max, worst } = maxDeviation(oracle.random, method);
      expect(max, worst).toBeLessThan(1e-9);
    });
    it(`matches primer3 '${method}' on self-complementary oligos (symmetry correction)`, () => {
      const { max, worst } = maxDeviation(oracle.selfComplementary, method);
      expect(max, worst).toBeLessThan(1e-9);
    });
    it(`matches primer3 '${method}' on 2–7 nt oligos`, () => {
      const { max, worst } = maxDeviation(oracle.short, method);
      expect(max, worst).toBeLessThan(1e-9);
    });
    it(`matches primer3 '${method}' above 60 nt (GC% formula)`, () => {
      const { max, worst } = maxDeviation(oracle.long, method);
      expect(max, worst).toBeLessThan(1e-9);
    });
  }

  it('matches primer3 with DMSO and formamide', () => {
    // primer3-py stores dmso_conc, dmso_fact and formamide_conc as C `float` (32-bit) in
    // thermoanalysis.pxd, so the oracle saw those inputs rounded to single precision.
    let max = 0;
    for (const row of oracle.additives) {
      for (const method of PRIMER3_METHODS) {
        const ours = tm(row[0], {
          ...conditionsOf(row, method),
          dmsoPercent: Math.fround(row[5]),
          dmsoFactor: Math.fround(row[6]),
          formamideMolar: Math.fround(row[7]),
        });
        max = Math.max(max, Math.abs(ours - (row[8 + PRIMER3_METHODS.indexOf(method)] as number)));
      }
    }
    expect(max).toBeLessThan(1e-9);
  });
});

describe('tm vs Biopython MeltingTemp.Tm_NN (secondary oracle)', () => {
  it("agrees with Tm_NN(DNA_NN3, saltcorr=5) for 'santalucia' (independent implementation)", () => {
    let max = 0;
    for (const row of oracle.biopython) max = Math.max(max, Math.abs(tm(row[0], conditionsOf(row, 'santalucia')) - row[5]));
    expect(max).toBeLessThan(1e-6);
  });

  it("matches Tm_NN(DNA_NN3, saltcorr=7) for 'owczarzy2008' (published Owczarzy 2008 equation)", () => {
    let max = 0;
    for (const row of oracle.biopython) max = Math.max(max, Math.abs(tm(row[0], conditionsOf(row, 'owczarzy2008')) - row[6]));
    expect(max).toBeLessThan(1e-6);
  });

  it("'owczarzy2008' differs from primer3's 'owczarzy' only by the published length term and free-Mg2+ model", () => {
    // Mg2+-dominated regime, no dNTP: the only difference is the 1/(2(N-1)) term, which raises Tm.
    const c = { monovalentMilliMolar: 20, divalentMilliMolar: 3, dntpMilliMolar: 0 };
    const seq = 'ACGTTGCAAGGCTTAC';
    const delta = tm(seq, { ...c, saltCorrection: 'owczarzy2008' }) - tm(seq, { ...c, saltCorrection: 'owczarzy' });
    expect(delta).toBeGreaterThan(0.1);
    expect(delta).toBeLessThan(2);
    // Monovalent-dominated regime (Owczarzy 2004 eq. 22): both are identical up to R (1.987 vs 1.9872).
    const mono = { monovalentMilliMolar: 200, divalentMilliMolar: 0, dntpMilliMolar: 0 };
    expect(
      Math.abs(tm(seq, { ...mono, saltCorrection: 'owczarzy2008' }) - tm(seq, { ...mono, saltCorrection: 'owczarzy' })),
    ).toBeLessThan(0.01);
  });

  it("'owczarzy2008' needs no monovalent ions: its Ka model leaves Mg2+ free even when dNTP >= Mg2+ (review regression)", () => {
    // Biopython: Tm_NN(seq, nn_table=DNA_NN3, dnac1=12.5, dnac2=0, Na=0, Mg=1.5, dNTPs=1.5, saltcorr=7) (and Mg=1.0, dNTPs=1.2)
    const seq = 'AGCGGATAACAATTTCACACAGGA';
    const noMonovalent = { saltCorrection: 'owczarzy2008', monovalentMilliMolar: 0 } as const;
    expect(tm(seq, { ...noMonovalent, divalentMilliMolar: 1.5, dntpMilliMolar: 1.5 })).toBeCloseTo(57.276484033224676, 9);
    expect(tm(seq, { ...noMonovalent, divalentMilliMolar: 1.0, dntpMilliMolar: 1.2 })).toBeCloseTo(55.39459458395271, 9);
    const rows = oracle.biopythonNoMonovalent;
    expect(rows.length).toBeGreaterThanOrEqual(300);
    expect(rows.filter((r) => r[1] === 0 && r[3] >= r[2]).length).toBeGreaterThan(100);
    let max = 0;
    for (const row of rows) max = Math.max(max, Math.abs(tm(row[0], conditionsOf(row, 'owczarzy2008')) - row[5]));
    expect(max).toBeLessThan(1e-6);
  });
});

describe('tm defaults and conditions', () => {
  it("uses primer3's calc_tm defaults", () => {
    expect(DEFAULT_TM_CONDITIONS).toMatchObject({
      monovalentMilliMolar: 50,
      divalentMilliMolar: 1.5,
      dntpMilliMolar: 0.6,
      oligoNanoMolar: 50,
      saltCorrection: 'santalucia',
      nnMaxLength: 60,
    });
    // primer3-py: calc_tm('ACGTACGTACGTACGTACGT') with all defaults
    const row = oracle.random.find((r) => r[1] === 50 && r[2] === 1.5 && r[3] === 0.6 && r[4] === 50);
    expect(row).toBeDefined();
    expect(tm(row![0])).toBeCloseTo(row![6], 9);
  });

  it('converts Mg2+ to a Na+ equivalent like primer3 (von Ahsen 2001)', () => {
    expect(divalentToMonovalentMilliMolar(0, 0.6)).toBe(0);
    expect(divalentToMonovalentMilliMolar(0.5, 1)).toBe(0); // all Mg2+ chelated by dNTP
    expect(divalentToMonovalentMilliMolar(1.5, 0.6)).toBeCloseTo(120 * Math.sqrt(0.9), 12);
    expect(sodiumEquivalentMilliMolar()).toBeCloseTo(50 + 120 * Math.sqrt(0.9), 12);
  });

  it('validates conditions', () => {
    expect(() => resolveTmConditions({ monovalentMilliMolar: -1 })).toThrow(RangeError);
    expect(() => resolveTmConditions({ oligoNanoMolar: 0 })).toThrow(RangeError);
    expect(() => resolveTmConditions({ divalentMilliMolar: Number.NaN })).toThrow(RangeError);
    expect(() => resolveTmConditions({ saltCorrection: 'magic' as SaltCorrectionMethod })).toThrow(RangeError);
    expect(() => resolveTmConditions({ nnMaxLength: 1.5 })).toThrow(RangeError);
    expect(() => tm('ACGTACGTAC', { monovalentMilliMolar: 0, divalentMilliMolar: 0 })).toThrow(/no free cations/);
    // Mg2+ alone is enough
    expect(Number.isFinite(tm('ACGTACGTAC', { monovalentMilliMolar: 0, divalentMilliMolar: 2, dntpMilliMolar: 0 }))).toBe(true);
    // undefined entries keep the defaults
    expect(resolveTmConditions({ saltCorrection: undefined }).saltCorrection).toBe('santalucia');
  });

  it('requires free cations as each model defines them (review regression)', () => {
    // primer3's models (free Mg2+ = Mg2+ − dNTP) have no cations left without monovalent ions when dNTP >= Mg2+
    const chelated = { monovalentMilliMolar: 0, divalentMilliMolar: 1.5, dntpMilliMolar: 1.5 };
    for (const method of PRIMER3_METHODS) {
      expect(() => tm('ACGTACGTAC', { ...chelated, saltCorrection: method })).toThrow(/no free cations/);
    }
    // 'owczarzy2008' only needs some Mg2+ (Ka model), but not none at all (ln 0)
    expect(Number.isFinite(tm('ACGTACGTAC', { ...chelated, saltCorrection: 'owczarzy2008' }))).toBe(true);
    expect(() => tm('ACGTACGTAC', { monovalentMilliMolar: 0, divalentMilliMolar: 0, saltCorrection: 'owczarzy2008' })).toThrow(
      /no cations/,
    );
    // The GC% formula above nnMaxLength and thermo() use primer3's Na+ equivalent, which is 0 here:
    // an explicit error instead of -Infinity or NaN.
    const owc = { ...chelated, saltCorrection: 'owczarzy2008' } as const;
    const long = 'ACGTTGCA'.repeat(8); // 64 nt
    expect(() => tm(long, owc)).toThrow(/nnMaxLength/);
    expect(() => tmRange(long.slice(0, 63) + 'N', owc)).toThrow(/nnMaxLength/);
    expect(Number.isFinite(tm(long, { ...owc, nnMaxLength: 64 }))).toBe(true);
    expect(() => thermo('ACGTACGTAC', owc)).toThrow(/free cations/);
    expect(sodiumEquivalentMilliMolar(owc)).toBe(0);
  });

  it('switches to the GC% formula above nnMaxLength', () => {
    const seq = 'ACGT'.repeat(15) + 'A'; // 61 nt
    const gcFormula = 81.5 + 16.6 * Math.log10(sodiumEquivalentMilliMolar() / 1000) + (41 * 30) / 61 - 600 / 61;
    expect(tm(seq)).toBeCloseTo(gcFormula, 9);
    // raising nnMaxLength keeps the nearest-neighbour model
    expect(tm(seq, { nnMaxLength: 100 })).not.toBeCloseTo(gcFormula, 1);
    expect(tm(seq.slice(0, 60))).not.toBeCloseTo(81.5 + 16.6 * Math.log10(sodiumEquivalentMilliMolar() / 1000) + 41 * 0.5 - 10, 1);
  });

  it('applies DMSO linearly', () => {
    const seq = 'AGCGGATAACAATTTCACACAGGA';
    expect(tm(seq) - tm(seq, { dmsoPercent: 5 })).toBeCloseTo(3, 9);
    expect(tm(seq) - tm(seq, { dmsoPercent: 5, dmsoFactor: 0.75 })).toBeCloseTo(3.75, 9);
  });
});

describe('tm input handling', () => {
  it('returns NaN below 2 nt', () => {
    expect(tm('')).toBeNaN();
    expect(tm('A')).toBeNaN();
    expect(tm('N')).toBeNaN();
    expect(Number.isFinite(tm('AC'))).toBe(true);
  });

  it('accepts lowercase and U', () => {
    expect(tm('acgtgcatgcatgc')).toBe(tm('ACGTGCATGCATGC'));
    expect(tm('ACGUGCAUGCAUGC')).toBe(tm('ACGTGCATGCATGC'));
  });

  it('rejects non-IUPAC characters', () => {
    expect(() => tm('ACGT-ACGT')).toThrow(RangeError);
    expect(() => tm('ACGT ACGT')).toThrow(/position 4/);
    expect(() => oligoGcContent('ACGX')).toThrow(RangeError);
  });

  it('rejects characters that only become IUPAC letters when upper-cased (review regression)', () => {
    // String.prototype.toUpperCase: ß → 'SS', ſ → 'S', ﬅ/ﬆ → 'ST' (and the length changes)
    expect(() => tm('ACGGATCCTTAGCAATGGCAß')).toThrow(RangeError);
    expect(() => tm('ACGGATCCTTAGCAATGGCAſ')).toThrow(RangeError);
    expect(() => oligoGcContent('ﬆ')).toThrow(RangeError);
    expect(() => oligoGcContent('ﬅ')).toThrow(RangeError);
    expect(() => tmRange('ACGTNNNNſ')).toThrow(RangeError);
    expect(() => thermo('ACGGATCCß')).toThrow(RangeError);
  });

  it('names the offending characters at their positions in the input (review regression)', () => {
    expect(() => tm('ACXG')).toThrow(/position 2: 'X'/);
    // 'ß' is itself the first offending character (position 0); 'X' follows at position 1
    expect(() => tm('ßX')).toThrow(/0: 'ß'/);
    expect(() => tm('ßX')).toThrow(/1: 'X'/);
    expect(() => tm('ßX')).not.toThrow(/undefined/);
    expect(() => tm('ACGT\nACGT')).toThrow(/position 4: U\+000A/);
  });
});

describe('oligoGcContent', () => {
  it('counts G/C and handles ambiguity codes as expected fractions', () => {
    expect(oligoGcContent('GGNN')).toBe(0.75); // expected value, unlike seq/stats gcContent (1)
    expect(oligoGcContent('')).toBe(0);
    expect(oligoGcContent('G')).toBe(1);
    expect(oligoGcContent('A')).toBe(0);
    expect(oligoGcContent('GGCCAATT')).toBe(0.5);
    expect(oligoGcContent('SSSS')).toBe(1);
    expect(oligoGcContent('WWWW')).toBe(0);
    expect(oligoGcContent('NN')).toBe(0.5);
    expect(oligoGcContent('RYKM')).toBe(0.5);
    expect(oligoGcContent('BV')).toBeCloseTo(2 / 3, 12);
    expect(oligoGcContent('DH')).toBeCloseTo(1 / 3, 12);
    expect(oligoGcContent('gcua')).toBe(0.5);
  });

  it('equals the mean GC fraction over all expansions (property)', () => {
    const random = mulberry32(7);
    const codes = 'ACGTRYSWKMBDHVN';
    for (let k = 0; k < 50; k++) {
      let seq = '';
      for (let i = 0; i < 6; i++) seq += codes[Math.floor(random() * codes.length)];
      const expansions = expandAll(seq);
      const mean = expansions.reduce((a, s) => a + oligoGcContent(s), 0) / expansions.length;
      expect(oligoGcContent(seq)).toBeCloseTo(mean, 12);
    }
  });
});

function expandAll(seq: string): string[] {
  const sets: Record<string, string> = {
    A: 'A', C: 'C', G: 'G', T: 'T', R: 'AG', Y: 'CT', S: 'CG', W: 'AT', K: 'GT', M: 'AC',
    B: 'CGT', D: 'AGT', H: 'ACT', V: 'ACG', N: 'ACGT',
  };
  let out = [''];
  for (const ch of seq) {
    const next: string[] = [];
    for (const prefix of out) for (const b of sets[ch]) next.push(prefix + b);
    out = next;
  }
  return out;
}

describe('degenerate (IUPAC) oligos', () => {
  it('tmRange enumerates small expansions exactly', () => {
    const seq = 'ACGTRCGTACGYACGTAC';
    const all = expandAll(seq).map((s) => tm(s));
    const r = tmRange(seq);
    expect(r.exact).toBe(true);
    expect(r.expansions).toBe(4);
    expect(r.min).toBeCloseTo(Math.min(...all), 12);
    expect(r.max).toBeCloseTo(Math.max(...all), 12);
    expect(r.mean).toBeCloseTo(all.reduce((a, b) => a + b, 0) / all.length, 12);
    expect(tm(seq)).toBe(r.mean);
  });

  it('samples deterministically above the exhaustive limit and never returns NaN', () => {
    const seq = 'ACGTNNNNNNNNACGTACGT'; // 4^8 = 65536 expansions
    expect(4 ** 8).toBeGreaterThan(TM_EXACT_EXPANSION_LIMIT);
    const r = tmRange(seq);
    expect(r.exact).toBe(false);
    expect(r.expansions).toBe(65536);
    expect(r.min).toBeLessThanOrEqual(r.mean);
    expect(r.mean).toBeLessThanOrEqual(r.max);
    expect(tmRange(seq)).toEqual(r); // repeatable
    // min and max are exact, so every expansion lies inside [min, max]
    for (const expansion of ['ACGTGGGGGGGGACGTACGT', 'ACGTAAAAAAAAACGTACGT', 'ACGTCGCGCGCGACGTACGT', 'ACGTTATATATAACGTACGT']) {
      expect(tm(expansion)).toBeGreaterThanOrEqual(r.min);
      expect(tm(expansion)).toBeLessThanOrEqual(r.max);
    }
    expect(Number.isFinite(tm('NNNNNNNNNNNNNNNNNNNN'))).toBe(true);
    expect(Number.isFinite(tm('N'.repeat(60)))).toBe(true);
  });

  it('is exact above nnMaxLength (GC% formula is linear in G+C)', () => {
    const seq = 'K' + 'ACGT'.repeat(16) + 'M'; // each end is G/C in half of the expansions
    const r = tmRange(seq);
    expect(r.exact).toBe(true);
    expect(r.max - r.min).toBeCloseTo((2 * 41) / seq.length, 9);
    // S and W are not degenerate in G+C content
    const sw = tmRange('S' + 'ACGT'.repeat(16) + 'W');
    expect(sw.max - sw.min).toBeCloseTo(0, 12);
    expect(r.mean).toBeCloseTo((r.min + r.max) / 2, 9);
  });

  it('reports the exact min/max above the exhaustive limit (review regression: ACGTNNNNNNNNACGTACGT)', () => {
    const r = tmRange('ACGTNNNNNNNNACGTACGT');
    expect(r.exact).toBe(false); // the mean is sampled
    let min = Infinity;
    let max = -Infinity;
    for (let x = 0; x < 65536; x++) {
      let mid = '';
      for (let k = 0; k < 8; k++) mid += 'ACGT'[(x >> (2 * k)) & 3];
      const t = tm(`ACGT${mid}ACGTACGT`);
      min = Math.min(min, t);
      max = Math.max(max, t);
    }
    // true range 47.88–70.73 °C (the sampled range was 50.14–69.24 °C)
    expect(Math.abs(r.min - min)).toBeLessThan(1e-9);
    expect(Math.abs(r.max - max)).toBeLessThan(1e-9);
  });

  it('tmExtremes equals exhaustive enumeration for every salt correction, additives and palindromes (property)', () => {
    const random = mulberry32(31337);
    const codes = 'ACGTRYSWKMBDHVN';
    const complementCode: Record<string, string> = {
      A: 'T', C: 'G', G: 'C', T: 'A', R: 'Y', Y: 'R', S: 'S', W: 'W', K: 'M', M: 'K', B: 'V', V: 'B', D: 'H', H: 'D', N: 'N',
    };
    const methods: SaltCorrectionMethod[] = ['schildkraut', 'santalucia', 'owczarzy', 'owczarzy2008'];
    let checked = 0;
    let palindromicExtremes = 0;
    for (let k = 0; k < 700; k++) {
      const n = 2 + Math.floor(random() * 22);
      let seq = '';
      for (let i = 0; i < n; i++) seq += random() < 0.35 ? codes[4 + Math.floor(random() * 11)] : 'ACGT'[Math.floor(random() * 4)];
      if (k % 3 === 0 && n % 2 === 0) {
        // palindrome-compatible: the second half mirrors the first with complementary codes
        const half = seq.slice(0, n / 2);
        seq = half + [...half].reverse().map((ch) => complementCode[ch]).join('');
      }
      if (expandAll(seq).length > TM_EXACT_EXPANSION_LIMIT || /^[ACGT]*$/.test(seq)) continue;
      const mg = random() < 0.2 ? 10 + random() * 40 : random() * 5; // > ~12 mM free Mg2+ flips the sign of Owczarzy's G+C term
      const monovalent = random() < 0.1 ? 0 : 10 + random() * 190;
      const conditions: Partial<TmConditions> = {
        saltCorrection: methods[k % 4],
        monovalentMilliMolar: monovalent,
        divalentMilliMolar: monovalent === 0 ? 1 + mg : mg,
        dntpMilliMolar: random() < 0.3 || monovalent === 0 ? 0 : random(),
        oligoNanoMolar: 25 + random() * 475,
        dmsoPercent: random() < 0.3 ? random() * 10 : 0,
        formamideMolar: random() < 0.3 ? random() * 1.5 : 0,
      };
      const all = expandAll(seq).map((s) => ({ s, t: tm(s, conditions) }));
      const lo = all.reduce((a, b) => (b.t < a.t ? b : a));
      const hi = all.reduce((a, b) => (b.t > a.t ? b : a));
      const e = tmExtremes(seq, conditions);
      const label = `${seq} ${JSON.stringify(conditions)}`;
      expect(Math.abs(e.min.tm - lo.t), label).toBeLessThan(1e-9);
      expect(Math.abs(e.max.tm - hi.t), label).toBeLessThan(1e-9);
      for (const x of [e.min, e.max]) {
        expect(x.sequence).toHaveLength(n);
        expect(expandAll(seq)).toContain(x.sequence);
        expect(x.tm).toBe(tm(x.sequence, conditions));
      }
      if ([e.min.sequence, e.max.sequence].some((s) => s === reverseComplement(s))) palindromicExtremes++;
      checked++;
    }
    expect(checked).toBeGreaterThan(400);
    expect(palindromicExtremes).toBeGreaterThan(20); // self-complementary expansions are among the extremes
  });

  it('tmExtremes matches brute force well above the exhaustive limit, incl. Owczarzy with high Mg2+ and formamide', { timeout: 60_000 }, () => {
    const cases: [string, Partial<TmConditions>][] = [
      ['NNNNNNNNATGCATGCAT', {}],
      ['GGCCNNNNNNNNGGCCAATT', { saltCorrection: 'owczarzy', divalentMilliMolar: 30, dntpMilliMolar: 0 }],
      ['ACNNNNNNNNGT', { saltCorrection: 'owczarzy2008', divalentMilliMolar: 25, monovalentMilliMolar: 20 }],
      ['GNNNNNNNNC', { formamideMolar: 1.2, saltCorrection: 'schildkraut' }],
      ['TTSWNNNKMNNRYAA', { saltCorrection: 'owczarzy', formamideMolar: 0.8, divalentMilliMolar: 40 }],
      ['GNNNWWSSNNNC', { saltCorrection: 'owczarzy2008', formamideMolar: 0.5, dmsoPercent: 5 }],
    ];
    for (const [seq, conditions] of cases) {
      const expansions = expandAll(seq);
      expect(expansions.length).toBeGreaterThan(TM_EXACT_EXPANSION_LIMIT);
      expect(expansions.length).toBeLessThanOrEqual(65536);
      let min = Infinity;
      let max = -Infinity;
      const c = resolveTmConditions(conditions);
      for (const s of expansions) {
        const t = tmResolved(s, c);
        if (t < min) min = t;
        if (t > max) max = t;
      }
      const r = tmRange(seq, conditions);
      expect(Math.abs(r.min - min), seq).toBeLessThan(1e-9);
      expect(Math.abs(r.max - max), seq).toBeLessThan(1e-9);
      expect(r.min).toBeLessThanOrEqual(r.mean);
      expect(r.mean).toBeLessThanOrEqual(r.max);
    }
  });

  it('tmExtremes handles long, short and unambiguous input', () => {
    const long = 'K' + 'ACGT'.repeat(16) + 'M';
    const e = tmExtremes(long);
    const r = tmRange(long);
    expect(e.min.tm).toBeCloseTo(r.min, 12);
    expect(e.max.tm).toBeCloseTo(r.max, 12);
    expect(e.min.sequence).toBe('T' + 'ACGT'.repeat(16) + 'A');
    expect(tmExtremes('ACGTACGGTACCA')).toEqual({
      min: { sequence: 'ACGTACGGTACCA', tm: tm('ACGTACGGTACCA') },
      max: { sequence: 'ACGTACGGTACCA', tm: tm('ACGTACGGTACCA') },
    });
    expect(tmExtremes('N').min.tm).toBeNaN();
    expect(tmExtremes('acgun').max.sequence).toMatch(/^ACGT[ACGT]$/);
    // a 60-mer of N (1.3e36 expansions) is solved without enumeration
    const t0 = performance.now();
    const n60 = tmExtremes('N'.repeat(60), { saltCorrection: 'owczarzy', divalentMilliMolar: 30, dntpMilliMolar: 0 });
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(n60.min.tm).toBeLessThan(n60.max.tm);
    expect(n60.max.sequence).toMatch(/^[CG]+$/);
  });

  it('gives NaN values below 2 nt', () => {
    expect(tmRange('')).toEqual({ min: NaN, max: NaN, mean: NaN, expansions: 1, exact: true });
    expect(tmRange('N')).toMatchObject({ expansions: 4, exact: true });
    expect(tmRange('N').mean).toBeNaN();
  });

  it('unambiguous sequences have a zero-width range', () => {
    expect(tmRange('ACGTACGGTACCA')).toEqual({
      min: tm('ACGTACGGTACCA'),
      max: tm('ACGTACGGTACCA'),
      mean: tm('ACGTACGGTACCA'),
      expansions: 1,
      exact: true,
    });
  });
});

describe('thermo', () => {
  it('reproduces the SantaLucia (1998) worked example at 1 M NaCl', () => {
    // SantaLucia 1998, eq. 3: 5'-CGTTGA-3' : ΔG°37 = 1.96 − 2.17 − 1.45 − 1.29 − 0.58 ... ΔH/ΔS sums
    const t = thermo('CGTTGA', { monovalentMilliMolar: 1000, divalentMilliMolar: 0, dntpMilliMolar: 0 });
    // init GC (0.1, −2.8) + init AT (2.3, 4.1) + CG(−10.6, −27.2) + GT(−8.4, −22.4) + TT(−7.9, −22.2) + TG(−8.5, −22.7) + GA(−8.2, −22.2)
    expect(t.dH).toBeCloseTo(0.1 + 2.3 - 10.6 - 8.4 - 7.9 - 8.5 - 8.2, 9);
    expect(t.dS).toBeCloseTo(-2.8 + 4.1 - 27.2 - 22.4 - 22.2 - 22.7 - 22.2, 9);
    expect(t.dG37).toBeCloseTo(t.dH - (310.15 * t.dS) / 1000, 12);
  });

  it('applies the symmetry correction to self-complementary sequences', () => {
    const oneM = { monovalentMilliMolar: 1000, divalentMilliMolar: 0, dntpMilliMolar: 0 };
    const pal = thermo('GAATTC', oneM);
    // init GC ×2 + GA + AA + AT + TT + TC + symmetry
    expect(pal.dS).toBeCloseTo(-2.8 * 2 - 22.2 - 22.2 - 20.4 - 22.2 - 22.2 - 1.4, 9);
  });

  it('is consistent with tm() for the santalucia method', () => {
    const random = mulberry32(99);
    for (let k = 0; k < 200; k++) {
      const seq = randomDna(random, 10 + Math.floor(random() * 40), 0.2 + 0.6 * random());
      const t = thermo(seq);
      const symmetric = seq === reverseComplement(seq);
      const c = Math.log(50e-9 / (symmetric ? 1 : 4));
      expect((1000 * t.dH) / (t.dS + 1.987 * c) - 273.15).toBeCloseTo(tm(seq), 9);
    }
  });

  it('uses nearest-neighbour sums at every length (no GC% formula)', () => {
    const long = 'ACGT'.repeat(30); // 120 nt
    const oneM = { monovalentMilliMolar: 1000, divalentMilliMolar: 0, dntpMilliMolar: 0 };
    const t = thermo(long, oneM);
    // 119 stacks: 30 AC + 30 CG + 30 GT + 29 TA, plus A·T initiation at both ends
    const expectedH = 30 * -8.4 + 30 * -10.6 + 30 * -8.4 + 29 * -7.2 + 2.3 + 2.3;
    expect(t.dH).toBeCloseTo(expectedH, 9);
  });

  it('handles short and degenerate input', () => {
    expect(thermo('A').dH).toBeNaN();
    const d = thermo('ACGTNACGT');
    const all = expandAll('ACGTNACGT').map((s) => thermo(s).dH);
    expect(d.dH).toBeCloseTo(all.reduce((a, b) => a + b) / all.length, 12);
  });
});

describe('tm properties (seeded random)', () => {
  const random = mulberry32(20261008);
  const seqs = Array.from({ length: 300 }, () => randomDna(random, 15 + Math.floor(random() * 30), 0.2 + 0.6 * random()));

  it('increases with monovalent salt, Mg2+ and oligo concentration', () => {
    for (const method of ['schildkraut', 'santalucia', 'owczarzy', 'owczarzy2008'] as SaltCorrectionMethod[]) {
      for (const seq of seqs.slice(0, 60)) {
        const base = { saltCorrection: method, divalentMilliMolar: 0, dntpMilliMolar: 0 };
        expect(tm(seq, { ...base, monovalentMilliMolar: 100 })).toBeGreaterThan(tm(seq, { ...base, monovalentMilliMolar: 20 }));
        if (method !== 'owczarzy') {
          // primer3's 'owczarzy' is not monotonic in Mg2+ (see the dedicated test below)
          expect(tm(seq, { saltCorrection: method, divalentMilliMolar: 4 })).toBeGreaterThan(
            tm(seq, { saltCorrection: method, divalentMilliMolar: 1 }),
          );
        }
        expect(tm(seq, { saltCorrection: method, oligoNanoMolar: 500 })).toBeGreaterThan(
          tm(seq, { saltCorrection: method, oligoNanoMolar: 25 }),
        );
      }
    }
  });

  it("reproduces primer3's non-monotonic Mg2+ dependence for GC-rich oligos under 'owczarzy'", () => {
    // Without the 1/(2(N-1)) term (primer3 integer division), Tm falls as Mg2+ rises above ~1 mM
    // for GC-rich oligos; the published equation ('owczarzy2008') keeps rising.
    const seq = 'GGCGCCGCGGCCGCGGCGCCGGCGCGGGCC';
    const at = (method: SaltCorrectionMethod, mg: number) => tm(seq, { saltCorrection: method, divalentMilliMolar: mg });
    expect(at('owczarzy', 6)).toBeLessThan(at('owczarzy', 1));
    expect(at('owczarzy2008', 6)).toBeGreaterThan(at('owczarzy2008', 1));
  });

  it('is invariant under reverse complement (same duplex)', () => {
    for (const seq of seqs) expect(tm(reverseComplement(seq))).toBeCloseTo(tm(seq), 9);
  });

  it('dNTP above Mg2+ cancels the Mg2+ contribution', () => {
    for (const seq of seqs.slice(0, 50)) {
      expect(tm(seq, { divalentMilliMolar: 1, dntpMilliMolar: 2 })).toBeCloseTo(tm(seq, { divalentMilliMolar: 0, dntpMilliMolar: 0 }), 9);
    }
  });

  it('yields plausible PCR primer values', () => {
    // M13/pUC forward (-20) primer; primer3 calc_tm gives ~51.6 °C with default conditions
    const t = tm('GTAAAACGACGGCCAGT');
    expect(t).toBeGreaterThan(48);
    expect(t).toBeLessThan(56);
  });
});
