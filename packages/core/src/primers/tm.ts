/**
 * Melting temperature (Tm) and nearest-neighbour thermodynamics of DNA oligonucleotides.
 *
 * The model reproduces primer3 (libprimer3 2.6.1 `oligotm.c` / `seqtm`, the engine behind
 * Primer3, Primer3Plus and Primer-BLAST; validated against primer3-py `calc_tm`), so HHereditas
 * reports the same numbers as those tools:
 *
 *  - Two-state duplex melting with the SantaLucia (1998) unified nearest-neighbour parameters,
 *    helix initiation per terminal base pair and the symmetry correction for self-complementary
 *    oligos (see `thermo-tables.ts`).
 *  - Tm = ΔH° / (ΔS° + R·ln(C_T/x)) with x = 4 for non-self-complementary duplexes (primer and
 *    target at equal concentration, primer3's convention) and x = 1 for self-complementary ones.
 *  - Cation corrections: see {@link SaltCorrectionMethod}. Mg2+ is converted to a Na+ equivalent
 *    with 120·√([Mg2+] − [dNTP]) (mM; von Ahsen et al. 2001, Clin Chem 47:1956) for the
 *    'schildkraut' and 'santalucia' methods, exactly as primer3 does.
 *  - Sequences longer than {@link TmConditions.nnMaxLength} (default 60 nt) use primer3's
 *    GC% formula instead (Bolton & McCarthy 1962 / Sambrook et al. 1989):
 *    Tm = 81.5 + 16.6·log10([Na+eq]/1 M) + 41·(G+C)/N − 600/N.
 *  - DMSO and formamide: Tm −= %DMSO·factor; Tm += (0.453·f(GC) − 2.88)·[formamide] (primer3).
 *
 * Input sequences are 5'→3' DNA. Lowercase is accepted, U is read as T, and IUPAC ambiguity codes
 * are handled by expansion: {@link tm} gives the mean Tm over the expansions, {@link tmRange} and
 * {@link tmExtremes} the exact lowest and highest. Any other character throws a RangeError (checked
 * before any case conversion, see `normalize.ts`). A Tm is undefined for fewer than 2 nucleotides:
 * such inputs give NaN.
 */
import { IUPAC_DNA } from '../seq/alphabet';
import { canonicalOligo } from './normalize';
import {
  KELVIN_OFFSET,
  R_CAL,
  R_CAL_PRIMER3_THAL,
  SANTALUCIA_1998_INIT_TERMINAL_AT,
  SANTALUCIA_1998_INIT_TERMINAL_GC,
  SANTALUCIA_1998_STACKS,
  SANTALUCIA_1998_SYMMETRY,
} from './thermo-tables';
import { nnTmExtremes, type NnTmModel, type TmExtreme } from './tm-extremes';

export type { TmExtreme } from './tm-extremes';

/**
 * How the cation concentrations enter the Tm.
 *
 *  - 'santalucia' (primer3 default, recommended): entropy correction
 *    ΔS = ΔS(1 M) + 0.368·(N − 1)·ln([Na+eq]/1 M) (SantaLucia 1998).
 *  - 'schildkraut': Tm += 16.6·log10([Na+eq]/1 M) (Schildkraut & Lifson 1965, Biopolymers 3:195;
 *    primer3 ≤ 1.0.1 behaviour).
 *  - 'owczarzy': Owczarzy et al. 2004 (Biochemistry 43:3537) eq. 22 for monovalent ions or
 *    Owczarzy et al. 2008 (Biochemistry 47:5336) eq. 16 when Mg2+ dominates, EXACTLY as primer3
 *    2.6.1 computes it: free Mg2+ = [Mg2+] − [dNTP], and the length-dependent term
 *    1/(2(N−1))·(e + f·ln[Mg2+] + g·ln²[Mg2+]) of eq. 16 is omitted because primer3 evaluates
 *    `1/(2*(len-1))` in integer arithmetic (= 0). Use this to match Primer3/Primer-BLAST. Caveat
 *    inherited from primer3: without that term, Tm of GC-rich oligos DEcreases as [Mg2+] rises
 *    above ~1 mM, which the published model does not predict.
 *  - 'owczarzy2008': the published Owczarzy 2008 model (eq. 16 including the length term, eq. 22
 *    below the [Mg2+]^0.5/[Mon+] = 0.22 crossover, free Mg2+ from the Mg2+:dNTP association
 *    constant Ka = 3×10^4 M^-1, R = 1.987), matching Biopython `Tm_NN(saltcorr=7)`. It can differ
 *    from 'owczarzy' by several °C: over 8–60-mers with 10–200 mM Mon+, 0–5 mM Mg2+ and 0–1 mM dNTP
 *    the median difference is +0.8 °C where Mg2+ dominates (5th–95th percentile −2.2 to +3.7 °C),
 *    with extremes of about −8 °C (short oligos at low free Mg2+, where the length term is large)
 *    and +20 °C ([Mg2+] ≈ [dNTP]: primer3 then treats all Mg2+ as chelated).
 */
export type SaltCorrectionMethod = 'schildkraut' | 'santalucia' | 'owczarzy' | 'owczarzy2008';

/** Reaction conditions for Tm calculations. Concentrations are total (analytical) concentrations. */
export interface TmConditions {
  /** Monovalent cations, [Na+] + [K+], in millimolar (primer3 `mv_conc`). */
  monovalentMilliMolar: number;
  /** Divalent cations, [Mg2+], in millimolar (primer3 `dv_conc`). */
  divalentMilliMolar: number;
  /** Total dNTP in millimolar; dNTPs chelate Mg2+ (primer3 `dntp_conc`). */
  dntpMilliMolar: number;
  /** Concentration of the annealing oligo in nanomolar (primer3 `dna_conc`). */
  oligoNanoMolar: number;
  /** Cation correction model, see {@link SaltCorrectionMethod}. */
  saltCorrection: SaltCorrectionMethod;
  /** DMSO in % (v/v); lowers Tm by `dmsoPercent × dmsoFactor` °C (primer3 `dmso_conc`). */
  dmsoPercent: number;
  /** Tm decrease in °C per % DMSO (primer3 `dmso_fact`, default 0.6). */
  dmsoFactor: number;
  /** Formamide in mol/L; Tm += (0.453·f(GC) − 2.88)·[formamide] (primer3 `formamide_conc`). */
  formamideMolar: number;
  /** Longest sequence, in nucleotides, evaluated with the nearest-neighbour model; longer sequences use the GC% formula (primer3 `max_nn_length`). */
  nnMaxLength: number;
}

/**
 * primer3's defaults (primer3-py `calc_tm` / Primer3Plus): 50 mM monovalent, 1.5 mM Mg2+,
 * 0.6 mM dNTP, 50 nM oligo, SantaLucia salt correction, no DMSO/formamide, NN model up to 60 nt.
 */
export const DEFAULT_TM_CONDITIONS: Readonly<TmConditions> = Object.freeze({
  monovalentMilliMolar: 50,
  divalentMilliMolar: 1.5,
  dntpMilliMolar: 0.6,
  oligoNanoMolar: 50,
  saltCorrection: 'santalucia',
  dmsoPercent: 0,
  dmsoFactor: 0.6,
  formamideMolar: 0,
  nnMaxLength: 60,
});

const SALT_METHODS: readonly SaltCorrectionMethod[] = ['schildkraut', 'santalucia', 'owczarzy', 'owczarzy2008'];

/**
 * Merge `conditions` over {@link DEFAULT_TM_CONDITIONS} and validate them.
 * Throws a RangeError for negative or non-finite concentrations, a non-positive oligo
 * concentration, an unknown salt correction, or conditions without any cation.
 */
export function resolveTmConditions(conditions?: Partial<TmConditions>): TmConditions {
  const c: TmConditions = { ...DEFAULT_TM_CONDITIONS };
  if (conditions) {
    // only known keys, so a typo cannot smuggle extra properties into the resolved object
    for (const key of Object.keys(DEFAULT_TM_CONDITIONS) as (keyof TmConditions)[]) {
      const value = conditions[key];
      if (value !== undefined) (c as unknown as Record<string, unknown>)[key] = value;
    }
  }
  const nonNegative: (keyof TmConditions)[] = [
    'monovalentMilliMolar',
    'divalentMilliMolar',
    'dntpMilliMolar',
    'dmsoPercent',
    'formamideMolar',
  ];
  for (const key of nonNegative) {
    const v = c[key] as number;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
      throw new RangeError(`Tm condition ${key} must be a finite number >= 0 (got ${String(v)})`);
    }
  }
  if (!Number.isFinite(c.oligoNanoMolar) || c.oligoNanoMolar <= 0) {
    throw new RangeError(`Tm condition oligoNanoMolar must be > 0 (got ${String(c.oligoNanoMolar)})`);
  }
  if (!Number.isFinite(c.dmsoFactor)) throw new RangeError('Tm condition dmsoFactor must be finite');
  if (!Number.isInteger(c.nnMaxLength) || c.nnMaxLength < 0) {
    throw new RangeError(`Tm condition nnMaxLength must be an integer >= 0 (got ${String(c.nnMaxLength)})`);
  }
  if (!SALT_METHODS.includes(c.saltCorrection)) {
    throw new RangeError(`Unknown salt correction '${String(c.saltCorrection)}'`);
  }
  if (c.monovalentMilliMolar === 0 && c.divalentMilliMolar <= c.dntpMilliMolar) {
    throw new RangeError('Tm conditions contain no free cations (monovalent = 0 and Mg2+ <= dNTP)');
  }
  return c;
}

/**
 * Na+-equivalent of free Mg2+ in millimolar, 120·√([Mg2+] − [dNTP]) (von Ahsen et al. 2001),
 * with primer3's rules: 0 when there is no Mg2+ or when dNTP >= Mg2+ (all Mg2+ chelated).
 */
export function divalentToMonovalentMilliMolar(divalentMilliMolar: number, dntpMilliMolar: number): number {
  let divalent = divalentMilliMolar;
  let dntp = dntpMilliMolar;
  if (divalent === 0) dntp = 0;
  if (divalent < dntp) divalent = dntp;
  return 120 * Math.sqrt(divalent - dntp);
}

/** [Na+] equivalent of a set of conditions in millimolar: monovalent + 120·√([Mg2+] − [dNTP]). */
export function sodiumEquivalentMilliMolar(conditions?: Partial<TmConditions>): number {
  const c = resolveTmConditions(conditions);
  return c.monovalentMilliMolar + divalentToMonovalentMilliMolar(c.divalentMilliMolar, c.dntpMilliMolar);
}

// ---------------------------------------------------------------------------
// Sequence handling
// ---------------------------------------------------------------------------

/** 0..3 for A, C, G, T; -1 otherwise. */
const BASE_CODE: Int8Array = (() => {
  const t = new Int8Array(128).fill(-1);
  t['A'.charCodeAt(0)] = 0;
  t['C'.charCodeAt(0)] = 1;
  t['G'.charCodeAt(0)] = 2;
  t['T'.charCodeAt(0)] = 3;
  return t;
})();

/** Check that every character is an IUPAC nucleotide code (either case, U read as T) and upper-case it. */
function prepareSequence(seq: string): string {
  return canonicalOligo(seq);
}

function isUnambiguous(seq: string): boolean {
  for (let i = 0; i < seq.length; i++) if (BASE_CODE[seq.charCodeAt(i)] < 0) return false;
  return true;
}

/** Expected number of G/C bases: S counts 1, W 0, other ambiguity codes the fraction of G/C they stand for. */
function expectedGcCount(seq: string): number {
  let gc = 0;
  for (const ch of seq) {
    const bases = IUPAC_DNA[ch];
    let n = 0;
    for (const b of bases) if (b === 'G' || b === 'C') n++;
    gc += n / bases.length;
  }
  return gc;
}

/**
 * GC fraction of an oligo, 0..1 (0 for an empty sequence).
 * IUPAC codes count by the fraction of G/C they stand for, i.e. the expected GC content of the
 * degenerate oligo pool (consistent with the mean Tm of {@link tm}): S = 1, W = 0,
 * R/Y/K/M/N = 1/2, B/V = 2/3, D/H = 1/3. Lowercase is accepted and U counts as T; other
 * characters throw a RangeError. (`seq/stats.ts` `gcContent` instead leaves ambiguous codes out,
 * Biopython-style, which suits whole sequences with N runs: 'GGNN' is 0.75 here and 1 there.)
 */
export function oligoGcContent(seq: string): number {
  const s = prepareSequence(seq);
  return s.length === 0 ? 0 : expectedGcCount(s) / s.length;
}

/** True when an unambiguous sequence equals its reverse complement (primer3 `symmetry()`). */
function isSelfComplementary(seq: string): boolean {
  const n = seq.length;
  if (n % 2 === 1) return false;
  for (let i = 0; i < n / 2; i++) {
    if (BASE_CODE[seq.charCodeAt(i)] + BASE_CODE[seq.charCodeAt(n - 1 - i)] !== 3) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Nearest-neighbour sums
// ---------------------------------------------------------------------------

/** Parameters in integer tenths (0.1 kcal/mol, 0.1 e.u.), so sums are exact like primer3's `int` tables. */
const tenths = (v: number): number => Math.round(v * 10);
const STACK_H10 = new Int32Array(16);
const STACK_S10 = new Int32Array(16);
for (const [pair, [dH, dS]] of Object.entries(SANTALUCIA_1998_STACKS)) {
  const k = BASE_CODE[pair.charCodeAt(0)] * 4 + BASE_CODE[pair.charCodeAt(1)];
  STACK_H10[k] = tenths(dH);
  STACK_S10[k] = tenths(dS);
}
const INIT_AT_H10 = tenths(SANTALUCIA_1998_INIT_TERMINAL_AT[0]);
const INIT_AT_S10 = tenths(SANTALUCIA_1998_INIT_TERMINAL_AT[1]);
const INIT_GC_H10 = tenths(SANTALUCIA_1998_INIT_TERMINAL_GC[0]);
const INIT_GC_S10 = tenths(SANTALUCIA_1998_INIT_TERMINAL_GC[1]);
const SYMMETRY_S10 = tenths(SANTALUCIA_1998_SYMMETRY[1]);
/** Initiation per terminal base code (A, T: terminal A·T; C, G: terminal G·C), tenths. */
const INIT_H10_BY_BASE = Int32Array.from([INIT_AT_H10, INIT_GC_H10, INIT_GC_H10, INIT_AT_H10]);
const INIT_S10_BY_BASE = Int32Array.from([INIT_AT_S10, INIT_GC_S10, INIT_GC_S10, INIT_AT_S10]);

interface NnSums {
  /** ΔH° in cal/mol. */
  dHcal: number;
  /** ΔS° at 1 M Na+ in cal/(K·mol). */
  dS: number;
  symmetric: boolean;
}

/** SantaLucia (1998) ΔH°/ΔS° of the perfect duplex formed by an unambiguous sequence of length >= 2. */
function nnSums(seq: string): NnSums {
  const n = seq.length;
  const symmetric = isSelfComplementary(seq);
  let h10 = 0;
  let s10 = symmetric ? SYMMETRY_S10 : 0;
  for (const end of [BASE_CODE[seq.charCodeAt(0)], BASE_CODE[seq.charCodeAt(n - 1)]]) {
    const at = end === 0 || end === 3;
    h10 += at ? INIT_AT_H10 : INIT_GC_H10;
    s10 += at ? INIT_AT_S10 : INIT_GC_S10;
  }
  let prev = BASE_CODE[seq.charCodeAt(0)];
  for (let i = 1; i < n; i++) {
    const cur = BASE_CODE[seq.charCodeAt(i)];
    h10 += STACK_H10[prev * 4 + cur];
    s10 += STACK_S10[prev * 4 + cur];
    prev = cur;
  }
  return { dHcal: h10 * 100, dS: s10 * 0.1, symmetric };
}

function countGc(seq: string): number {
  let gc = 0;
  for (let i = 0; i < seq.length; i++) {
    const c = BASE_CODE[seq.charCodeAt(i)];
    if (c === 1 || c === 2) gc++;
  }
  return gc;
}

// ---------------------------------------------------------------------------
// Tm of one unambiguous sequence
// ---------------------------------------------------------------------------

/** primer3 `long_seq_tm` (GC% formula); `gc` may be fractional (expected count of a degenerate oligo). */
function longSequenceTm(gc: number, n: number, c: TmConditions): number {
  const salt = c.monovalentMilliMolar + divalentToMonovalentMilliMolar(c.divalentMilliMolar, c.dntpMilliMolar);
  return (
    81.5 -
    c.dmsoPercent * c.dmsoFactor +
    ((0.453 * gc) / n - 2.88) * c.formamideMolar +
    16.6 * Math.log10(salt / 1000.0) +
    41.0 * (gc / n) -
    600.0 / n
  );
}

/** Owczarzy 2008 eq. 16 / Owczarzy 2004 eq. 22 correction to 1/Tm, as primer3 2.6.1 evaluates it. */
function owczarzyPrimer3Correction(gcFraction: number, c: TmConditions): number {
  const k = c.monovalentMilliMolar;
  const div = c.divalentMilliMolar;
  const dntp = c.dntpMilliMolar;
  const freeDivalent = dntp >= div ? 0.00000000001 : (div - dntp) / 1000.0;
  const ratio = k === 0 ? 6.0 : Math.sqrt(freeDivalent) / (k / 1000);
  if (ratio < 0.22) {
    const lnK = Math.log(k / 1000.0);
    return (4.29 * gcFraction - 3.95) * 1e-5 * lnK + 9.4 * 1e-6 * (lnK * lnK);
  }
  let a = 3.92 * 1e-5;
  const b = -(9.11 * 1e-6);
  const cc = 6.26 * 1e-5;
  let d = 1.42 * 1e-5;
  if (ratio < 6.0) {
    const lnK = Math.log(k / 1000.0);
    a = 3.92 * 1e-5 * (0.843 - 0.352 * Math.sqrt(k / 1000.0) * lnK);
    d = 1.42 * 1e-5 * (1.279 - 4.03 * 1e-3 * lnK - 8.03 * 1e-3 * (lnK * lnK));
    // g would be corrected here too, but it only multiplies the length term primer3 drops (see SaltCorrectionMethod).
  }
  const lnMg = Math.log(freeDivalent);
  return a + b * lnMg + gcFraction * (cc + d * lnMg);
}

/** Published Owczarzy 2008 correction to 1/Tm (eq. 16 incl. the length term; Biopython `salt_correction(method=7)`). */
function owczarzy2008Correction(gcFraction: number, n: number, c: TmConditions): number {
  const mon = c.monovalentMilliMolar * 1e-3;
  let mg = c.divalentMilliMolar * 1e-3;
  if (c.dntpMilliMolar > 0 && mg > 0) {
    // Free Mg2+ from the Mg2+:dNTP association constant (Owczarzy 2008).
    const ka = 3e4;
    const dntps = c.dntpMilliMolar * 1e-3;
    const p = ka * dntps - ka * mg + 1.0;
    mg = Math.max(0, (-p + Math.sqrt(p * p + 4.0 * ka * mg)) / (2.0 * ka));
  }
  let a = 3.92;
  const b = -0.911;
  const cc = 6.26;
  let d = 1.42;
  const e = -48.2;
  const f = 52.5;
  let g = 8.31;
  if (c.monovalentMilliMolar > 0) {
    const ratio = Math.sqrt(mg) / mon;
    const lnMon = Math.log(mon);
    if (ratio < 0.22) return (4.29 * gcFraction - 3.95) * 1e-5 * lnMon + 9.4e-6 * lnMon ** 2;
    if (ratio < 6.0) {
      a = 3.92 * (0.843 - 0.352 * Math.sqrt(mon) * lnMon);
      d = 1.42 * (1.279 - 4.03e-3 * lnMon - 8.03e-3 * lnMon ** 2);
      g = 8.31 * (0.486 - 0.258 * lnMon + 5.25e-3 * lnMon ** 3);
    }
  }
  const lnMg = Math.log(mg);
  return (a + b * lnMg + gcFraction * (cc + d * lnMg) + (1 / (2.0 * (n - 1))) * (e + f * lnMg + g * lnMg ** 2)) * 1e-5;
}

/**
 * The method's Tm denominator ΔS° + K in cal/(K·mol) for a duplex with ΔS° = `dS` (1 M Na+,
 * symmetry correction included): every method computes Tm from ρ = ΔH°/(ΔS° + K), see
 * {@link tmFromRatio}. K holds the concentration term R·ln(C_T/x) and, for 'santalucia', the salt
 * correction of ΔS°. Evaluated in exactly primer3's order of operations.
 */
function tmDenominator(dS: number, n: number, symmetric: boolean, c: TmConditions): number {
  const oligo = c.oligoNanoMolar;
  switch (c.saltCorrection) {
    case 'schildkraut':
      return dS + R_CAL * Math.log(oligo / 4000000000.0);
    case 'santalucia': {
      const k = c.monovalentMilliMolar + divalentToMonovalentMilliMolar(c.divalentMilliMolar, c.dntpMilliMolar);
      return dS + 0.368 * (n - 1) * Math.log(k / 1000.0) + R_CAL * Math.log(oligo / (symmetric ? 1000000000.0 : 4000000000.0));
    }
    case 'owczarzy':
      return dS + R_CAL_PRIMER3_THAL * Math.log(oligo / (symmetric ? 1000000000.0 : 4000000000.0));
    case 'owczarzy2008':
      return dS + R_CAL * Math.log((symmetric ? oligo : oligo / 4) * 1e-9);
  }
}

/**
 * Tm in °C from ρ = ΔH°/(ΔS° + K) in kelvin (see {@link tmDenominator}) and the G+C count `gc` of an
 * oligo of length `n`: the salt correction applied after the ratio, then DMSO and formamide.
 * Increasing in ρ for every method, which `tm-extremes.ts` relies on.
 */
function tmFromRatio(rho: number, gc: number, n: number, c: TmConditions): number {
  let t: number;
  switch (c.saltCorrection) {
    case 'schildkraut': {
      const k = c.monovalentMilliMolar + divalentToMonovalentMilliMolar(c.divalentMilliMolar, c.dntpMilliMolar);
      const correction = 16.6 * Math.log10(k / 1000.0);
      t = rho + correction - KELVIN_OFFSET;
      break;
    }
    case 'santalucia':
      t = rho - KELVIN_OFFSET;
      break;
    case 'owczarzy':
      t = 1 / (1 / rho + owczarzyPrimer3Correction(gc / n, c)) - KELVIN_OFFSET;
      break;
    case 'owczarzy2008': {
      const tm1M = rho - KELVIN_OFFSET;
      t = 1 / (1 / (tm1M + KELVIN_OFFSET) + owczarzy2008Correction(gc / n, n, c)) - KELVIN_OFFSET;
      break;
    }
  }
  t -= c.dmsoPercent * c.dmsoFactor;
  t += ((0.453 * gc) / n - 2.88) * c.formamideMolar;
  return t;
}

/** Whether {@link tmFromRatio} depends on the G+C count under `c` (Owczarzy corrections, formamide). */
function tmDependsOnGc(c: TmConditions): boolean {
  return c.saltCorrection === 'owczarzy' || c.saltCorrection === 'owczarzy2008' || c.formamideMolar !== 0;
}

/** Tm (°C) of an unambiguous ACGT sequence of length >= 2 (primer3 `seqtm`). */
function tmUnambiguous(seq: string, c: TmConditions): number {
  const n = seq.length;
  const gc = countGc(seq);
  if (n > c.nnMaxLength) return longSequenceTm(gc, n, c);
  const { dHcal, dS, symmetric } = nnSums(seq);
  return tmFromRatio(dHcal / tmDenominator(dS, n, symmetric, c), gc, n, c);
}

/** The nearest-neighbour model of `tm-extremes.ts` for oligos of length `n` (<= nnMaxLength) under `c`. */
function nnTmModel(n: number, c: TmConditions): NnTmModel {
  return {
    stackH10: STACK_H10,
    stackS10: STACK_S10,
    initH10: INIT_H10_BY_BASE,
    initS10: INIT_S10_BY_BASE,
    symmetryS10: SYMMETRY_S10,
    sums: nnSums,
    denominator: (dS, symmetric) => tmDenominator(dS, n, symmetric, c),
    tmFromRatio: (rho, gc) => tmFromRatio(rho, gc, n, c),
    tm: (seq) => tmUnambiguous(seq, c),
    gcDependent: tmDependsOnGc(c),
  };
}

// ---------------------------------------------------------------------------
// Degenerate (IUPAC) sequences
// ---------------------------------------------------------------------------

/** Degenerate oligos with at most this many expansions are evaluated exhaustively. */
export const TM_EXACT_EXPANSION_LIMIT = 4096;
/** Number of expansions drawn (deterministically, seeded by the sequence) above the exhaustive limit. */
export const TM_SAMPLE_SIZE = 2048;

/** Number of unambiguous sequences an IUPAC sequence stands for (may exceed 2^53 and lose precision). */
function expansionCount(seq: string): number {
  let count = 1;
  for (const ch of seq) count *= IUPAC_DNA[ch].length;
  return count;
}

/** Deterministic 32-bit PRNG (mulberry32) seeded with the FNV-1a hash of `text`. */
function seededRandom(text: string): () => number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  let state = h >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Call `visit` for every expansion of `seq` (when there are at most TM_EXACT_EXPANSION_LIMIT),
 * otherwise for TM_SAMPLE_SIZE expansions drawn uniformly with a sequence-seeded PRNG.
 * Returns whether the enumeration was exhaustive.
 */
function forEachExpansion(seq: string, visit: (expanded: string) => void): boolean {
  const options = Array.from(seq, (ch) => IUPAC_DNA[ch]);
  const count = expansionCount(seq);
  const chars = Array.from(seq, (ch) => IUPAC_DNA[ch][0]);
  if (count <= TM_EXACT_EXPANSION_LIMIT) {
    const digits = new Array<number>(seq.length).fill(0);
    for (let done = 0; done < count; done++) {
      visit(chars.join(''));
      // odometer increment over the degenerate positions
      for (let i = seq.length - 1; i >= 0; i--) {
        if (options[i].length === 1) continue;
        digits[i]++;
        if (digits[i] < options[i].length) {
          chars[i] = options[i][digits[i]];
          break;
        }
        digits[i] = 0;
        chars[i] = options[i][0];
      }
    }
    return true;
  }
  const random = seededRandom(seq);
  for (let k = 0; k < TM_SAMPLE_SIZE; k++) {
    for (let i = 0; i < seq.length; i++) {
      const o = options[i];
      chars[i] = o.length === 1 ? o : o[Math.floor(random() * o.length)];
    }
    visit(chars.join(''));
  }
  return false;
}

/** The expansion choosing a G/C base wherever possible (`preferGc`) or an A/T base wherever possible. */
function extremeExpansion(seq: string, preferGc: boolean): string {
  let out = '';
  for (const ch of seq) {
    const bases = IUPAC_DNA[ch];
    let pick = bases[0];
    for (const b of bases) {
      const isGc = b === 'G' || b === 'C';
      if (isGc === preferGc) {
        pick = b;
        break;
      }
    }
    out += pick;
  }
  return out;
}

/** Spread of Tm over the unambiguous sequences a degenerate (IUPAC) oligo stands for. All temperatures in °C. */
export interface TmRange {
  /** Lowest Tm over all expansions. Always exact (above the exhaustive limit: {@link tmExtremes}). */
  min: number;
  /** Highest Tm over all expansions. Always exact (above the exhaustive limit: {@link tmExtremes}). */
  max: number;
  /**
   * Mean Tm over the expansions; this is what {@link tm} returns. Exact up to
   * {@link TM_EXACT_EXPANSION_LIMIT} expansions and for sequences longer than `nnMaxLength`;
   * otherwise the mean of {@link TM_SAMPLE_SIZE} random expansions (seeded by the sequence, so
   * repeatable), whose standard error is the standard deviation of the expansions' Tm divided by
   * √2048 (about 2 % of it).
   */
  mean: number;
  /** Number of unambiguous sequences the input stands for (product of the IUPAC code sizes). */
  expansions: number;
  /**
   * True when `mean` is exact (every expansion evaluated, or the GC% formula above `nnMaxLength`).
   * False when the mean was sampled; `min` and `max` are exact either way.
   */
  exact: boolean;
}

/**
 * Tm range of a possibly degenerate oligo under the given conditions (see module docs).
 * Unambiguous sequences give min = max = mean. Up to {@link TM_EXACT_EXPANSION_LIMIT} expansions
 * every expansion is evaluated; above that min and max come from the exact search of
 * {@link tmExtremes} and the mean from a sample (see {@link TmRange}). Sequences longer than
 * `nnMaxLength` are exact (the GC% formula is linear in the G+C count). Fewer than 2 nt give NaN
 * values. Throws a RangeError when the conditions leave the model's domain for some expansion
 * (ΔS° + R·ln(C_T/x) >= 0, which needs oligo concentrations of the order of 1000 M).
 */
export function tmRange(seq: string, conditions?: Partial<TmConditions>): TmRange {
  const c = resolveTmConditions(conditions);
  const s = prepareSequence(seq);
  const expansions = expansionCount(s);
  if (s.length < 2) return { min: NaN, max: NaN, mean: NaN, expansions, exact: true };
  if (isUnambiguous(s)) {
    const t = tmUnambiguous(s, c);
    return { min: t, max: t, mean: t, expansions: 1, exact: true };
  }
  if (s.length > c.nnMaxLength) {
    const n = s.length;
    return {
      min: longSequenceTm(countGc(extremeExpansion(s, false)), n, c),
      max: longSequenceTm(countGc(extremeExpansion(s, true)), n, c),
      mean: longSequenceTm(expectedGcCount(s), n, c),
      expansions,
      exact: true,
    };
  }
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let visited = 0;
  const exact = forEachExpansion(s, (expanded) => {
    const t = tmUnambiguous(expanded, c);
    if (t < min) min = t;
    if (t > max) max = t;
    sum += t;
    visited++;
  });
  if (!exact) {
    // The sample's own extremes are real expansions too, so they can only confirm the exact search.
    const extremes = nnTmExtremes(baseOptions(s), nnTmModel(s.length, c));
    min = Math.min(min, extremes.min.tm);
    max = Math.max(max, extremes.max.tm);
  }
  return { min, max, mean: sum / visited, expansions, exact };
}

/** Allowed base codes (A C G T = 0..3) of each position of an upper-case IUPAC sequence. */
function baseOptions(s: string): Uint8Array[] {
  return Array.from(s, (ch) => Uint8Array.from(IUPAC_DNA[ch], (b) => BASE_CODE[b.charCodeAt(0)]));
}

/**
 * The expansions of a possibly degenerate (IUPAC) oligo with the lowest and the highest Tm (°C)
 * under `conditions`, found without enumerating the expansions: a nearest-neighbour dynamic
 * programme with Dinkelbach's fractional programming (see `tm-extremes.ts`), exact to 1e-9 °C and
 * fast even for oligos with billions of expansions. Each result is an A/C/G/T sequence of the input's
 * length and its {@link tm}; ties go to the first expansion found. An unambiguous oligo is both its
 * own minimum and maximum. Above `nnMaxLength` (GC% formula, increasing in G+C) the results are the
 * expansions with the fewest and the most G/C bases. Fewer than 2 nt give NaN temperatures. Throws
 * a RangeError for invalid characters or conditions (see {@link tmRange}).
 */
export function tmExtremes(seq: string, conditions?: Partial<TmConditions>): { min: TmExtreme; max: TmExtreme } {
  const c = resolveTmConditions(conditions);
  const s = prepareSequence(seq);
  const fewestGc = extremeExpansion(s, false);
  const mostGc = extremeExpansion(s, true);
  if (s.length < 2) return { min: { sequence: fewestGc, tm: NaN }, max: { sequence: mostGc, tm: NaN } };
  if (isUnambiguous(s)) {
    const t = tmUnambiguous(s, c);
    return { min: { sequence: s, tm: t }, max: { sequence: s, tm: t } };
  }
  if (s.length > c.nnMaxLength) {
    return {
      min: { sequence: fewestGc, tm: tmUnambiguous(fewestGc, c) },
      max: { sequence: mostGc, tm: tmUnambiguous(mostGc, c) },
    };
  }
  return nnTmExtremes(baseOptions(s), nnTmModel(s.length, c));
}

/**
 * Melting temperature in °C of a DNA oligo (5'→3') hybridised to its perfect complement, under
 * `conditions` (defaults: {@link DEFAULT_TM_CONDITIONS}, primer3's). Agrees with primer3-py
 * `calc_tm` for unambiguous sequences. Degenerate (IUPAC) oligos return the mean Tm over their
 * expansions (`mean` of {@link tmRange}), never NaN; sequences shorter than 2 nt return NaN.
 */
export function tm(seq: string, conditions?: Partial<TmConditions>): number {
  return tmResolved(seq, resolveTmConditions(conditions));
}

/**
 * {@link tm} with conditions that were already merged and validated by
 * {@link resolveTmConditions}; skips that work in hot loops (binding sites, primer design).
 */
export function tmResolved(seq: string, conditions: TmConditions): number {
  const s = prepareSequence(seq);
  if (s.length < 2) return NaN;
  if (isUnambiguous(s)) return tmUnambiguous(s, conditions);
  return degenerateMeanTm(s, conditions);
}

/** Mean Tm over the expansions of a degenerate sequence of length >= 2: the `mean` of {@link tmRange}. */
function degenerateMeanTm(s: string, c: TmConditions): number {
  if (s.length > c.nnMaxLength) return longSequenceTm(expectedGcCount(s), s.length, c);
  let sum = 0;
  let visited = 0;
  forEachExpansion(s, (expanded) => {
    sum += tmUnambiguous(expanded, c);
    visited++;
  });
  return sum / visited;
}

/** Nearest-neighbour duplex thermodynamics. */
export interface DuplexThermo {
  /** ΔH° of duplex formation in kcal/mol (salt independent). */
  dH: number;
  /** ΔS° in cal/(K·mol), corrected to the conditions' [Na+] equivalent (SantaLucia 1998). */
  dS: number;
  /** ΔG° at 37 °C in kcal/mol: dH − 310.15 K × dS / 1000. */
  dG37: number;
}

/**
 * SantaLucia (1998) nearest-neighbour ΔH°, ΔS° and ΔG°37 for the formation of the perfect duplex
 * between `seq` and its complement (initiation, terminal A·T and symmetry terms included).
 * ΔS° (and therefore ΔG°37) include the SantaLucia salt correction
 * 0.368·(N − 1)·ln([Na+eq]/1 M) for the given conditions whatever `saltCorrection` is selected
 * (the other models correct Tm rather than ΔS°); pass 1000 mM monovalent and no Mg2+ for the
 * 1 M NaCl standard state. Degenerate oligos give the mean over their expansions (exact up to
 * {@link TM_EXACT_EXPANSION_LIMIT} expansions, sampled above). Fewer than 2 nt give NaN values.
 * The nearest-neighbour sums are used at every length (no long-sequence formula here).
 */
export function thermo(seq: string, conditions?: Partial<TmConditions>): DuplexThermo {
  const c = resolveTmConditions(conditions);
  const s = prepareSequence(seq);
  if (s.length < 2) return { dH: NaN, dS: NaN, dG37: NaN };
  const saltTerm =
    0.368 *
    (s.length - 1) *
    Math.log((c.monovalentMilliMolar + divalentToMonovalentMilliMolar(c.divalentMilliMolar, c.dntpMilliMolar)) / 1000);
  const one = (expanded: string): DuplexThermo => {
    const sums = nnSums(expanded);
    const dH = sums.dHcal / 1000;
    const dS = sums.dS + saltTerm;
    return { dH, dS, dG37: dH - ((37 + KELVIN_OFFSET) * dS) / 1000 };
  };
  if (isUnambiguous(s)) return one(s);
  let dH = 0;
  let dS = 0;
  let dG37 = 0;
  let visited = 0;
  forEachExpansion(s, (expanded) => {
    const r = one(expanded);
    dH += r.dH;
    dS += r.dS;
    dG37 += r.dG37;
    visited++;
  });
  return { dH: dH / visited, dS: dS / visited, dG37: dG37 / visited };
}
