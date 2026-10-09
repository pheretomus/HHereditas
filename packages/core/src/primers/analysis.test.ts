import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { reverseComplement } from '../seq/alphabet';
import { analyzePrimer, endStability, hairpin, heterodimer, homodimer, type SecondaryStructure, type StructureOptions } from './analysis';
import { tm } from './tm';

const PYTHON = new URL('../../../../tools/oracle/.venv/bin/python', import.meta.url).pathname;
const LIVE = new URL('../../../../tools/oracle/primers_live.py', import.meta.url).pathname;
const hasPython = existsSync(PYTHON);

/** [..seqs, mv, dv, dntp, dna, tempC, maxLoop, found, tm, dg, dh, ds, ascii] */
type Row = (string | number | boolean)[];
interface ThalOracle {
  hairpin: Row[];
  homodimer: Row[];
  heterodimer: Row[];
  endStability: Row[];
}
const oracle = JSON.parse(
  readFileSync(new URL('../../test/oracle/primers/thal.json', import.meta.url), 'utf8'),
) as ThalOracle;

interface Case {
  seqs: string[];
  options: StructureOptions;
  found: boolean;
  tm: number;
  dg: number;
  dh: number;
  ds: number;
  ascii: string;
}

function parseRow(row: Row, nSeqs: number): Case {
  const [mv, dv, dntp, dna, temp, maxLoop, found, t, dg, dh, ds, ascii] = row.slice(nSeqs) as [
    number, number, number, number, number, number, boolean, number, number, number, number, string,
  ];
  return {
    seqs: row.slice(0, nSeqs) as string[],
    options: {
      conditions: { monovalentMilliMolar: mv, divalentMilliMolar: dv, dntpMilliMolar: dntp, oligoNanoMolar: dna },
      temperatureCelsius: temp,
      maxLoop,
    },
    found,
    tm: t,
    dg,
    dh,
    ds,
    ascii,
  };
}

/** Paired positions encoded in primer3's hairpin row ('/' 5' side, '\' 3' side, '-' unpaired). */
function hairpinPairedPositions(ascii: string): number[] {
  const row = ascii.split('\n')[0] ?? '';
  const out: number[] = [];
  for (let i = 0; i < row.length; i++) if (row[i] === '/' || row[i] === '\\') out.push(i);
  return out;
}

/** Pairs [i in seq1, j in seq2] read from primer3's 4-row dimer drawing (row 2/3 hold seq2 reversed). */
function dimerPairs(ascii: string, len2: number): [number, number][] {
  const rows = ascii.split('\n');
  const width = Math.max(...rows.map((r) => r.length));
  const at = (r: number, c: number) => rows[r]?.[c] ?? ' ';
  const isBase = (ch: string) => /[A-Z]/.test(ch);
  const pairs: [number, number][] = [];
  let i1 = 0;
  let i2 = 0;
  for (let c = 0; c < width; c++) {
    if (isBase(at(0, c))) i1++;
    if (isBase(at(3, c))) i2++;
    if (isBase(at(1, c)) && isBase(at(2, c))) {
      pairs.push([i1, len2 - 1 - i2]);
      i1++;
      i2++;
    }
  }
  return pairs;
}

interface Deviation {
  tm: number;
  dg: number;
  dh: number;
  ds: number;
}

const NO_STRUCTURE: SecondaryStructure = { found: false, tm: 0, dG: 0, dH: 0, dS: 0, pairs: [] };
const WATSON_CRICK: Record<string, string> = { A: 'T', C: 'G', G: 'C', T: 'A' };

/** True when seq1's 3'-terminal base has no Watson–Crick partner in seq2: primer3's END1 then uses its (1, 1) fallback. */
function end1Fallback(seq1: string, seq2: string): boolean {
  const partner = WATSON_CRICK[seq1[seq1.length - 1]];
  return partner === undefined || !seq2.includes(partner);
}

/**
 * Compare every oracle row of `kind`. Rows for which `fallback` holds are the documented deviation
 * of endStability: HHereditas reports no structure, while primer3 reports seq1's 5'-terminal base
 * paired with seq2's 3'-terminal base (found exactly when those two pair). Returns the worst
 * deviations of the other rows, and how many fallback rows primer3 reported as found.
 */
function compare(
  kind: keyof ThalOracle,
  nSeqs: number,
  run: (c: Case) => SecondaryStructure,
  fallback: (c: Case) => boolean = () => false,
): Deviation & { fallbackFound: number } {
  const worst = { tm: 0, dg: 0, dh: 0, ds: 0, fallbackFound: 0 };
  for (const row of oracle[kind]) {
    const c = parseRow(row, nSeqs);
    const ours = run(c);
    const label = `${kind} ${c.seqs.join(' / ')} ${JSON.stringify(c.options)}`;
    if (fallback(c)) {
      expect(ours, label).toEqual(NO_STRUCTURE);
      const [seq1, seq2] = c.seqs;
      expect(c.found, label).toBe(WATSON_CRICK[seq1[0]] === seq2[seq2.length - 1]);
      if (c.found) worst.fallbackFound++;
      continue;
    }
    expect(ours.found, label).toBe(c.found);
    worst.tm = Math.max(worst.tm, Math.abs(ours.tm - c.tm));
    worst.dg = Math.max(worst.dg, Math.abs(ours.dG * 1000 - c.dg));
    worst.dh = Math.max(worst.dh, Math.abs(ours.dH * 1000 - c.dh));
    worst.ds = Math.max(worst.ds, Math.abs(ours.dS - c.ds));
    expect(Math.abs(ours.tm - c.tm), label).toBeLessThan(1e-6);
    expect(Math.abs(ours.dG * 1000 - c.dg), label).toBeLessThan(1e-6);
    expect(Math.abs(ours.dH * 1000 - c.dh), label).toBeLessThan(1e-6);
    expect(Math.abs(ours.dS - c.ds), label).toBeLessThan(1e-6);
    if (c.found && c.ascii !== '') {
      if (kind === 'hairpin') {
        const positions = ours.pairs.flat().sort((a, b) => a - b);
        expect(positions, label).toEqual(hairpinPairedPositions(c.ascii));
      } else {
        expect(ours.pairs, label).toEqual(dimerPairs(c.ascii, c.seqs[nSeqs - 1].length));
      }
    }
  }
  return worst;
}

describe('thermodynamic alignment vs primer3-py (oracle)', () => {
  it(`hairpins (${oracle.hairpin.length} cases)`, () => {
    const worst = compare('hairpin', 1, (c) => hairpin(c.seqs[0], c.options));
    expect(worst.tm).toBeLessThan(1e-6);
  });

  it(`homodimers (${oracle.homodimer.length} cases)`, () => {
    const worst = compare('homodimer', 1, (c) => homodimer(c.seqs[0], c.options));
    expect(worst.tm).toBeLessThan(1e-6);
  });

  it(`heterodimers (${oracle.heterodimer.length} cases, incl. one sequence > 60 nt)`, () => {
    const worst = compare('heterodimer', 2, (c) => heterodimer(c.seqs[0], c.seqs[1], c.options));
    expect(worst.tm).toBeLessThan(1e-6);
  });

  it(`3'-end stability (${oracle.endStability.length} cases)`, () => {
    const worst = compare(
      'endStability',
      2,
      (c) => endStability(c.seqs[0], c.seqs[1], c.options),
      (c) => end1Fallback(c.seqs[0], c.seqs[1]),
    );
    expect(worst.tm).toBeLessThan(1e-6);
    expect(worst.fallbackFound).toBeGreaterThan(0); // the deviation is exercised by the stored cases
  });
});

describe('structure checks', () => {
  it('finds the stem of a designed hairpin', () => {
    const stem = 'GCGCAGCC';
    const seq = 'TT' + stem + 'GAAA' + reverseComplement(stem) + 'TT';
    const h = hairpin(seq);
    expect(h.found).toBe(true);
    expect(h.dG).toBeLessThan(-3);
    expect(h.tm).toBeGreaterThan(60);
    // every stem base pairs with its mirror
    for (let k = 0; k < stem.length; k++) expect(h.pairs).toContainEqual([2 + k, seq.length - 3 - k]);
    for (const [i, j] of h.pairs) expect(i).toBeLessThan(j);
  });

  it('reports no structure for sequences that cannot fold or pair', () => {
    expect(hairpin('AAAAAAAAAAAAAAAAAAAA')).toEqual({ found: false, tm: 0, dG: 0, dH: 0, dS: 0, pairs: [] });
    expect(heterodimer('AAAAAAAAAA', 'CCCCCCCCCC').found).toBe(false);
    expect(hairpin('').found).toBe(false);
    expect(homodimer('').found).toBe(false);
    expect(hairpin('ACGT').found).toBe(false); // too short for a 3-nt loop and a stacked pair
  });

  it('a primer and its reverse complement form a full-length duplex', () => {
    const p = 'AGCGGATAACAATTTCACACAGGA';
    const d = heterodimer(p, reverseComplement(p));
    expect(d.pairs).toHaveLength(p.length);
    for (const [i, j] of d.pairs) expect(j).toBe(p.length - 1 - i);
    // close to the Tm of the primer itself (different parameter sets: within a few degrees)
    expect(Math.abs(d.tm - tm(p))).toBeLessThan(5);
    expect(d.dG).toBeLessThan(-20);
  });

  it('end stability requires the 3' + "'-terminal base of seq1 to pair", () => {
    const p = 'TTTTTTTTTTTTGCGCATGC';
    const partner = 'AAAAA' + reverseComplement('GCATGC') + 'AAAAA';
    const e = endStability(p, partner);
    expect(e.found).toBe(true);
    expect(e.pairs.some(([i]) => i === p.length - 1)).toBe(true);
  });

  it("end stability reports no structure when the 3'-terminal base of seq1 cannot pair (review regression)", () => {
    // The 3' A has no T to pair with in seq2. primer3 then falls back to the cell (1, 1) and reports
    // seq1's 5'-terminal G on seq2's 3'-terminal C as a "3'-end" structure:
    // calc_end_stability('GGGGGCCCCCA','GGGGGCCCCC') -> structure_found=True, tm=-277.93, dg=1967.85.
    const seq1 = 'GGGGGCCCCCA';
    const e = endStability(seq1, 'GGGGGCCCCC');
    if (e.found) expect(e.pairs.some(([i]) => i === seq1.length - 1)).toBe(true);
    expect(e).toEqual({ found: false, tm: 0, dG: 0, dH: 0, dS: 0, pairs: [] });
    // an ambiguity code at the 3' end never pairs either
    expect(endStability('GGGGGCCCCCN', 'GGGGGCCCCC').found).toBe(false);
    // analyzePrimer's self-end dimer uses the same mode (for a self-dimer primer3's fallback can never
    // pair anything: if seq[0] paired seq[last], seq[last] would have a partner)
    expect(analyzePrimer('GTTTTTTTTTTTTTTTTTTA').selfEndDimer?.found).toBe(true);
    expect(analyzePrimer('GCCCCCCCCCCCCCCCCCCA').selfEndDimer).toEqual({ found: false, tm: 0, dG: 0, dH: 0, dS: 0, pairs: [] });
  });

  it("every end-stability structure pairs the 3'-terminal base of seq1 (property)", () => {
    const random = mulberry32(1203);
    const rnd = (n: number, alphabet = 'ACGT') => Array.from({ length: n }, () => alphabet[Math.floor(random() * alphabet.length)]).join('');
    let found = 0;
    for (let k = 0; k < 300; k++) {
      const seq1 = rnd(4 + Math.floor(random() * 30));
      // half of the partners lack the complement of seq1's 3' base
      const partnerAlphabet = k % 2 ? 'ACGT' : 'ACGT'.replace(reverseComplement(seq1[seq1.length - 1]), '');
      const e = endStability(seq1, rnd(4 + Math.floor(random() * 30), partnerAlphabet));
      if (!e.found) continue;
      found++;
      expect(e.pairs.some(([i]) => i === seq1.length - 1), seq1).toBe(true);
    }
    expect(found).toBeGreaterThan(100);
  });

  it('rejects characters that only become IUPAC letters when upper-cased (review regression)', () => {
    expect(() => hairpin('GCGCAGCCGAAAGGCTGCGCſ')).toThrow(RangeError);
    expect(() => homodimer('GCGCAGCCGAAAGGCTGCGCß')).toThrow(RangeError);
    expect(() => heterodimer('ACGTﬆ', 'ACGT')).toThrow(RangeError);
    expect(() => endStability('ACGT', 'ﬅACGT')).toThrow(RangeError);
    expect(() => analyzePrimer('ACGGATCCﬆ')).toThrow(RangeError);
  });

  it('treats IUPAC codes as non-pairing and validates input', () => {
    const stem = 'GCGCAGCC';
    const withN = 'TT' + stem + 'GAAA' + reverseComplement(stem).replace('G', 'N') + 'TT';
    const clean = hairpin('TT' + stem + 'GAAA' + reverseComplement(stem) + 'TT');
    expect(hairpin(withN).dG).toBeGreaterThan(clean.dG);
    expect(hairpin(withN.toLowerCase())).toEqual(hairpin(withN));
    expect(() => hairpin('ACGT-ACGT')).toThrow(RangeError);
    expect(() => hairpin('A'.repeat(61))).toThrow(/60/);
    expect(() => heterodimer('A'.repeat(61), 'T'.repeat(61))).toThrow(RangeError);
    expect(heterodimer('A'.repeat(61), 'T'.repeat(20)).found).toBe(true);
    expect(() => hairpin('ACGT', { maxLoop: 31 })).toThrow(RangeError);
    expect(() => hairpin('ACGT', { temperatureCelsius: Number.NaN })).toThrow(RangeError);
  });

  it('analyzePrimer validates the structure options whatever the primer length (review regression)', () => {
    const short = 'ACGTGGCATTGCAAGGCTAA'; // 20 nt
    const long = short.repeat(4); // 80 nt: no structure checks above 60 nt, but the same options are rejected
    for (const seq of [short, long]) {
      expect(() => analyzePrimer(seq, { maxLoop: 99 }), `${seq.length} nt`).toThrow(RangeError);
      expect(() => analyzePrimer(seq, { maxLoop: 2.5 }), `${seq.length} nt`).toThrow(RangeError);
      expect(() => analyzePrimer(seq, { temperatureCelsius: Number.NaN }), `${seq.length} nt`).toThrow(RangeError);
    }
    const ok = analyzePrimer(long, { maxLoop: 10, temperatureCelsius: 55 });
    expect(ok.hairpin).toBeUndefined();
    expect(ok.tm).toBeCloseTo(tm(long), 12);
  });

  it("needs free cations in primer3's Na+ equivalent, whatever the Tm salt correction (review regression)", () => {
    // 'owczarzy2008' accepts these conditions for the Tm (its free-Mg2+ model leaves some Mg2+ free),
    // but the structure model uses monovalent + 120·√(Mg2+ − dNTP) = 0: an error instead of a garbage Tm
    const conditions = { saltCorrection: 'owczarzy2008', monovalentMilliMolar: 0, divalentMilliMolar: 1.5, dntpMilliMolar: 1.5 } as const;
    const p = 'GCGCAGCCGAAAGGCTGCGC';
    expect(Number.isFinite(tm(p, conditions))).toBe(true);
    expect(() => hairpin(p, { conditions })).toThrow(/free cations/);
    expect(() => homodimer(p, { conditions })).toThrow(/free cations/);
    expect(() => heterodimer(p, reverseComplement(p), { conditions })).toThrow(/free cations/);
    expect(() => endStability(p, reverseComplement(p), { conditions })).toThrow(/free cations/);
    for (const seq of [p, p.repeat(4)]) expect(() => analyzePrimer(seq, { conditions })).toThrow(/free cations/);
    // with free Mg2+ in primer3's model the same call works
    expect(hairpin(p, { conditions: { ...conditions, divalentMilliMolar: 3 } }).found).toBe(true);
  });

  it('reports ΔG at the requested temperature', () => {
    const p = 'AGCGGATAACAATTTCACACAGGA';
    const partner = reverseComplement(p.slice(0, 18));
    const at37 = heterodimer(p, partner);
    const at60 = heterodimer(p, partner, { temperatureCelsius: 60 });
    expect(at60.dH).toBeCloseTo(at37.dH, 9);
    expect(at60.dS).toBeCloseTo(at37.dS, 9);
    expect(at60.dG).toBeCloseTo(at37.dH - (333.15 * at37.dS) / 1000, 9);
  });

  it('gives the same hetero-dimer energetics whatever the argument order (property, as primer3)', () => {
    const random = mulberry32(77);
    const rnd = (n: number) => Array.from({ length: n }, () => 'ACGT'[Math.floor(random() * 4)]).join('');
    for (let k = 0; k < 150; k++) {
      const a = rnd(8 + Math.floor(random() * 33));
      const b = k % 3 === 0 ? reverseComplement(a.slice(Math.floor(random() * 4))) + rnd(3) : rnd(8 + Math.floor(random() * 33));
      const ab = heterodimer(a, b);
      const ba = heterodimer(b, a);
      expect(ba.found).toBe(ab.found);
      expect(Math.abs(ba.tm - ab.tm)).toBeLessThan(1e-9);
      expect(Math.abs(ba.dG - ab.dG)).toBeLessThan(1e-9);
      // (the pairs themselves may differ when several structures are equally stable)
      expect(ba.pairs).toHaveLength(ab.pairs.length);
    }
  });

  it('checks a 60-mer against a 10 kb partner in interactive time, also the low-complexity worst case (review regression)', { timeout: 60_000 }, () => {
    heterodimer('ACGTACGTAC', 'GTACGTACGT'); // warm-up
    const random = mulberry32(60);
    const rnd = (n: number) => Array.from({ length: n }, () => 'ACGT'[Math.floor(random() * 4)]).join('');
    const timed = (f: () => SecondaryStructure) => {
      const t0 = performance.now();
      const result = f();
      return { result, ms: performance.now() - t0 };
    };
    // primer3-py 2.3.1: calc_heterodimer('G' * 60, 'C' * 10000).tm = 102.30992754625305 (3.1 s); the
    // same for calc_end_stability. The loop pruning of thal.ts fillDimer keeps primer3's exact result.
    for (const f of [heterodimer, endStability]) {
      const worst = timed(() => f('G'.repeat(60), 'C'.repeat(10_000)));
      expect(worst.result.tm).toBeCloseTo(102.30992754625305, 9);
      expect(worst.result.pairs).toHaveLength(60);
      expect(worst.ms).toBeLessThan(3000); // was 9–16 s before the review fix
    }
    const typical = timed(() => heterodimer(rnd(60), rnd(10_000)));
    expect(typical.result.found).toBe(true);
    expect(typical.ms).toBeLessThan(1000);
  });

  it('summarises a primer', () => {
    const s = analyzePrimer('GTAAAACGACGGCCAGT');
    expect(s.length).toBe(17);
    expect(s.tm).toBeCloseTo(tm('GTAAAACGACGGCCAGT'), 12);
    expect(s.hairpin).toBeDefined();
    expect(s.selfDimer?.found).toBe(true);
    expect(s.selfEndDimer).toBeDefined();
    const long = analyzePrimer('A'.repeat(70));
    expect(long.hairpin).toBeUndefined();
    expect(long.selfDimer).toBeUndefined();
  });
});

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

describe.skipIf(!hasPython)('thermodynamic alignment vs primer3-py (live oracle, fresh random cases)', () => {
  it('agrees on newly generated sequences and conditions', () => {
    const random = mulberry32(20261009); // fixed seed: reproducible, and independent of the stored oracle cases
    const rnd = (n: number) => {
      let s = '';
      for (let i = 0; i < n; i++) s += 'ACGT'[Math.floor(random() * 4)];
      return s;
    };
    const cond = () => [10 + random() * 190, random() * 5, random(), 25 + random() * 475, 20 + random() * 50, Math.floor(random() * 31)];
    const hairpins = Array.from({ length: 60 }, () => {
      const stem = rnd(4 + Math.floor(random() * 8));
      return [rnd(Math.floor(random() * 6)) + stem + rnd(3 + Math.floor(random() * 6)) + reverseComplement(stem), ...cond()];
    });
    const homodimers = Array.from({ length: 60 }, () => [rnd(5 + Math.floor(random() * 50)), ...cond()]);
    const heterodimers = Array.from({ length: 60 }, () => {
      const a = rnd(10 + Math.floor(random() * 40));
      return [a, rnd(Math.floor(random() * 5)) + reverseComplement(a.slice(Math.floor(random() * 5))), ...cond()];
    });
    const ends = Array.from({ length: 80 }, (_, k) => {
      const a = rnd(6 + Math.floor(random() * 30));
      const partner = WATSON_CRICK[a[a.length - 1]];
      const b =
        k % 2
          ? rnd(Math.floor(random() * 6)) + reverseComplement(a.slice(-4 - Math.floor(random() * 8))) + rnd(3)
          : // the partner of a's 3' base is replaced: primer3's END1 fallback case
            rnd(6 + Math.floor(random() * 30)).replaceAll(partner, partner === 'C' ? 'A' : 'C');
      return [a, b, ...cond()];
    });
    const request = { hairpin: hairpins, homodimer: homodimers, heterodimer: heterodimers, endStability: ends };
    const run = spawnSync(PYTHON, [LIVE], { input: JSON.stringify(request), encoding: 'utf8' });
    expect(run.status, run.stderr).toBe(0);
    const reply = JSON.parse(run.stdout) as Record<string, { found: boolean; tm: number; dg: number }[]>;
    const opts = (r: (string | number)[]): StructureOptions => ({
      conditions: { monovalentMilliMolar: r[0] as number, divalentMilliMolar: r[1] as number, dntpMilliMolar: r[2] as number, oligoNanoMolar: r[3] as number },
      temperatureCelsius: r[4] as number,
      maxLoop: r[5] as number,
    });
    hairpins.forEach((r, k) => {
      const ours = hairpin(r[0] as string, opts(r.slice(1)));
      expect(ours.found).toBe(reply.hairpin[k].found);
      expect(Math.abs(ours.tm - reply.hairpin[k].tm), String(r)).toBeLessThan(1e-6);
      expect(Math.abs(ours.dG * 1000 - reply.hairpin[k].dg), String(r)).toBeLessThan(1e-6);
    });
    homodimers.forEach((r, k) => {
      const ours = homodimer(r[0] as string, opts(r.slice(1)));
      expect(Math.abs(ours.tm - reply.homodimer[k].tm), String(r)).toBeLessThan(1e-6);
    });
    heterodimers.forEach((r, k) => {
      const ours = heterodimer(r[0] as string, r[1] as string, opts(r.slice(2)));
      expect(Math.abs(ours.tm - reply.heterodimer[k].tm), String(r)).toBeLessThan(1e-6);
      expect(Math.abs(ours.dG * 1000 - reply.heterodimer[k].dg), String(r)).toBeLessThan(1e-6);
    });
    let fallbacks = 0;
    ends.forEach((r, k) => {
      const [a, b] = [r[0] as string, r[1] as string];
      const ours = endStability(a, b, opts(r.slice(2)));
      if (end1Fallback(a, b)) {
        fallbacks++;
        expect(ours, String(r)).toEqual(NO_STRUCTURE);
        expect(reply.endStability[k].found, String(r)).toBe(WATSON_CRICK[a[0]] === b[b.length - 1]);
        return;
      }
      expect(ours.found, String(r)).toBe(reply.endStability[k].found);
      expect(Math.abs(ours.tm - reply.endStability[k].tm), String(r)).toBeLessThan(1e-6);
      expect(Math.abs(ours.dG * 1000 - reply.endStability[k].dg), String(r)).toBeLessThan(1e-6);
    });
    expect(fallbacks).toBeGreaterThanOrEqual(40);
  });
});
