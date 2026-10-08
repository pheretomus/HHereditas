/**
 * Primer secondary-structure checks: hairpins, self-dimers (homodimers), hetero-dimers and 3'-end
 * stability, computed with the thermodynamic alignment of `thal.ts` (the model of primer3's
 * `ntthal` / primer3-py `calc_hairpin`, `calc_homodimer`, `calc_heterodimer`,
 * `calc_end_stability`; validated against primer3-py).
 *
 * Units: Tm in °C, ΔG and ΔH in kcal/mol, ΔS in cal/(K·mol). Sequences are 5'→3' DNA; lowercase is
 * accepted and U is read as T; any other non-IUPAC character throws a RangeError (checked before any
 * case conversion, see `normalize.ts`). IUPAC ambiguity codes are accepted but never pair (as in
 * primer3), so structures involving them are not detected. At least one of the two sequences of an
 * alignment must be at most 60 nt (primer3's limit for the two-state model; hairpins therefore
 * need <= 60 nt) and none may exceed 10 000 nt, otherwise a RangeError is thrown.
 */
import { canonicalOligo } from './normalize';
import { oligoGcContent, resolveTmConditions, tmResolved, type TmConditions } from './tm';
import { THAL_MAX_ALIGN, thalDimer, thalHairpin, type ThalConditions, type ThalResult } from './thal';

/** Options of the structure checks. */
export interface StructureOptions {
  /**
   * Monovalent, Mg2+, dNTP and oligo concentrations (defaults: `DEFAULT_TM_CONDITIONS`, primer3's).
   * The structure model always uses the SantaLucia entropy salt correction with the Na+
   * equivalent 120·√([Mg2+] − [dNTP]); `saltCorrection`, DMSO and formamide are ignored here.
   */
  conditions?: Partial<TmConditions>;
  /** Temperature in °C at which ΔG is reported; hairpin stems must also be stable (ΔG < 0) here. Default 37. */
  temperatureCelsius?: number;
  /** Largest bulge/internal loop considered, in nucleotides, 0..30 (default 30). Hairpin loops are not limited. */
  maxLoop?: number;
}

/** The most stable structure found. When `found` is false every number is 0 and `pairs` is empty. */
export interface SecondaryStructure {
  /** True when a structure was found (primer3 `structure_found`). */
  found: boolean;
  /** Melting temperature of the structure in °C; may be far below 0 for marginal structures. */
  tm: number;
  /** ΔG at `temperatureCelsius` in kcal/mol (negative = forms spontaneously). */
  dG: number;
  /** ΔH in kcal/mol. */
  dH: number;
  /** ΔS in cal/(K·mol), salt corrected. */
  dS: number;
  /**
   * Base pairs as [i, j] with 0-based positions in each sequence's own 5'→3' coordinates:
   * hairpins and homodimers index the one sequence (hairpins: i < j); hetero-dimers and end
   * stability give [position in seq1, position in seq2]. Sorted by i.
   */
  pairs: [number, number][];
}

const DEFAULT_TEMPERATURE_C = 37;
const MAX_LOOP_LIMIT = 30;

function thalConditions(options: StructureOptions | undefined): ThalConditions {
  const c = resolveTmConditions(options?.conditions);
  const temperature = options?.temperatureCelsius ?? DEFAULT_TEMPERATURE_C;
  if (!Number.isFinite(temperature)) throw new RangeError(`temperatureCelsius must be finite (got ${temperature})`);
  const maxLoop = options?.maxLoop ?? MAX_LOOP_LIMIT;
  if (!Number.isInteger(maxLoop) || maxLoop < 0 || maxLoop > MAX_LOOP_LIMIT) {
    throw new RangeError(`maxLoop must be an integer in 0..${MAX_LOOP_LIMIT} (got ${maxLoop})`);
  }
  return {
    monovalentMilliMolar: c.monovalentMilliMolar,
    divalentMilliMolar: c.divalentMilliMolar,
    dntpMilliMolar: c.dntpMilliMolar,
    oligoNanoMolar: c.oligoNanoMolar,
    temperatureKelvin: temperature + 273.15,
    maxLoop,
  };
}

function prepare(seq: string): string {
  return canonicalOligo(seq);
}

function toStructure(r: ThalResult): SecondaryStructure {
  if (!r.found) return { found: false, tm: 0, dG: 0, dH: 0, dS: 0, pairs: [] };
  return {
    found: true,
    tm: r.tm,
    dG: r.dg / 1000,
    dH: r.dh / 1000,
    dS: r.ds,
    pairs: [...r.pairs].sort((a, b) => a[0] - b[0]),
  };
}

/**
 * Most stable hairpin (stem-loop) of `seq` (primer3-py `calc_hairpin`). Hairpin loops have at
 * least 3 nucleotides. An empty sequence has no structure (primer3 reports an error instead).
 */
export function hairpin(seq: string, options?: StructureOptions): SecondaryStructure {
  return toStructure(thalHairpin(prepare(seq), thalConditions(options)));
}

/** Most stable duplex of `seq` with a second copy of itself, i.e. a self-dimer (primer3-py `calc_homodimer`). */
export function homodimer(seq: string, options?: StructureOptions): SecondaryStructure {
  const s = prepare(seq);
  return toStructure(thalDimer(s, s, thalConditions(options), 'any'));
}

/** Most stable duplex between `seq1` and `seq2`, e.g. a primer-dimer of a pair (primer3-py `calc_heterodimer`). */
export function heterodimer(seq1: string, seq2: string, options?: StructureOptions): SecondaryStructure {
  return toStructure(thalDimer(prepare(seq1), prepare(seq2), thalConditions(options), 'any'));
}

/**
 * Most stable duplex between `seq1` and `seq2` in which the 3'-terminal base of `seq1` is paired
 * (primer3-py `calc_end_stability`, thal END1): how strongly the 3' end of a primer (`seq1`) can
 * anneal to another oligo or to itself, the structures that let a polymerase extend a dimer.
 * Every reported structure pairs the last base of `seq1` (`pairs` contains [seq1.length − 1, j]).
 * When that base cannot pair at all (no Watson–Crick partner in `seq2`, or an ambiguity code) no
 * structure is reported; primer3 then reports a fallback structure that pairs seq1's 5'-terminal
 * base instead (Tm far below 0 °C, ΔG > 0), so `found` differs from primer3 in that case only.
 */
export function endStability(seq1: string, seq2: string, options?: StructureOptions): SecondaryStructure {
  return toStructure(thalDimer(prepare(seq1), prepare(seq2), thalConditions(options), 'end1'));
}

/** Summary of one primer: length, GC, Tm and the structures primer3 checks. */
export interface PrimerAnalysis {
  /** Length in nucleotides. */
  length: number;
  /** GC fraction 0..1 (see `oligoGcContent`). */
  gc: number;
  /** Tm in °C under `conditions` (see `tm`); NaN below 2 nt. */
  tm: number;
  /** Most stable hairpin; undefined above 60 nt (outside the two-state model). */
  hairpin?: SecondaryStructure;
  /** Most stable self-dimer; undefined above 60 nt. */
  selfDimer?: SecondaryStructure;
  /**
   * Most stable self-dimer in which the primer's 3'-terminal base pairs (extendable), as
   * {@link endStability}; undefined above 60 nt.
   */
  selfEndDimer?: SecondaryStructure;
}

/** Length, GC content, Tm, hairpin and self-dimers of one primer under the same conditions. */
export function analyzePrimer(seq: string, options?: StructureOptions): PrimerAnalysis {
  const s = prepare(seq);
  const tmConditions = resolveTmConditions(options?.conditions);
  const result: PrimerAnalysis = { length: s.length, gc: oligoGcContent(s), tm: tmResolved(s, tmConditions) };
  if (s.length <= THAL_MAX_ALIGN) {
    const c = thalConditions(options);
    result.hairpin = toStructure(thalHairpin(s, c));
    result.selfDimer = toStructure(thalDimer(s, s, c, 'any'));
    result.selfEndDimer = toStructure(thalDimer(s, s, c, 'end1'));
  }
  return result;
}
