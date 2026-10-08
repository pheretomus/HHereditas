/**
 * Composition and physico-chemical properties of nucleotide and protein sequences.
 *
 * Formulas and constants are those of Biopython 1.88 (Bio.SeqUtils.gc_fraction,
 * Bio.SeqUtils.molecular_weight, Bio.SeqUtils.ProtParam, Bio.SeqUtils.IsoelectricPoint), which the
 * tests use as the oracle; the sources of the constants are cited at each table. Deliberate
 * deviation: proteinIsoelectricPoint returns the root of Biopython's charge function even when it
 * lies outside the interval [4.05, 12] that Biopython's bisection is limited to (see there).
 */

import { characterAt } from './translate';

// ---------------------------------------------------------------------------
// Nucleotide composition
// ---------------------------------------------------------------------------

/**
 * GC content as a fraction in [0, 1], over the bases whose GC status is known.
 *
 * Numerator: G, C and S (S = G or C). Denominator: G, C, S, A, T, U and W (W = A or T). Bases that
 * may be either (N, R, Y, K, M, B, D, H, V) and any other character are left out of both, so
 * 'ACGTNNNN' gives 0.5. Returns 0 when no base has a known GC status (empty sequence, all N).
 * Case-insensitive. Equals Biopython's `gc_fraction(seq, ambiguous="remove")`.
 */
export function gcContent(seq: string): number {
  let gc = 0;
  let at = 0;
  for (let i = 0; i < seq.length; i++) {
    switch (seq.charCodeAt(i) | 0x20 /* ASCII lower case */) {
      case 0x63: // c
      case 0x67: // g
      case 0x73: // s
        gc++;
        break;
      case 0x61: // a
      case 0x74: // t
      case 0x75: // u
      case 0x77: // w
        at++;
        break;
      default:
        break;
    }
  }
  return gc + at === 0 ? 0 : gc / (gc + at);
}

/**
 * Number of occurrences of each character (UTF-16 code unit), ASCII lower case counted as upper case.
 * Keys A, C, G and T are always present (0 when absent); every other character (IUPAC codes, U,
 * digits, anything else) only when it occurs.
 *
 * Key order (Object.keys / Object.entries): digits '0'-'9' first, in ascending order, then A, C, G,
 * T, then the other characters by code unit. Digits come first because JavaScript enumerates
 * integer-like keys of every object before its other keys (ECMA-262, OrdinaryOwnPropertyKeys); sort
 * the entries yourself if digits should come last.
 */
export function baseCounts(seq: string): Record<string, number> {
  const ascii = new Float64Array(128);
  let other: Map<string, number> | undefined;
  for (let i = 0; i < seq.length; i++) {
    const c = seq.charCodeAt(i);
    if (c < 128) {
      ascii[c >= 0x61 && c <= 0x7a ? c - 0x20 : c]++;
    } else {
      other ??= new Map();
      other.set(seq[i], (other.get(seq[i]) ?? 0) + 1);
    }
  }
  const counts: Record<string, number> = { A: ascii[0x41], C: ascii[0x43], G: ascii[0x47], T: ascii[0x54] };
  for (let c = 0; c < 128; c++) {
    const ch = String.fromCharCode(c);
    if (ascii[c] > 0 && counts[ch] === undefined) counts[ch] = ascii[c];
  }
  if (other) for (const [ch, n] of [...other].sort((a, b) => (a[0] < b[0] ? -1 : 1))) counts[ch] = n;
  return counts;
}

// ---------------------------------------------------------------------------
// Molecular weights
// ---------------------------------------------------------------------------

/**
 * Masses (Da) of the nucleoside 5'-monophosphates, i.e. one nucleotide residue plus one water.
 * Average and monoisotopic values from Biopython 1.88 Bio.Data.IUPACData (taken from PubChem).
 * Order: A, C, G, T (DNA) / A, C, G, U (RNA).
 */
const NUCLEOTIDE_MASSES = {
  DNA: {
    average: [331.2218, 307.1971, 347.2212, 322.2085],
    monoisotopic: [331.06817, 307.056936, 347.063084, 322.056602],
  },
  RNA: {
    average: [347.2212, 323.1965, 363.2206, 324.1813],
    monoisotopic: [347.063084, 323.051851, 363.057999, 324.035867],
  },
} as const;

/** Water, H2O (Da): average 18.0153 and monoisotopic 18.010565, as in Biopython (IUPAC atomic weights). */
const WATER = { average: 18.0153, monoisotopic: 18.010565 } as const;

/**
 * HPO3 (Da), the difference between a 5'-phosphate and a 5'-OH end. Average mass from the IUPAC
 * 2005 standard atomic weights that also give Biopython's water mass (H 1.00794, O 15.9994,
 * P 30.973762): 79.979902. Monoisotopic from the isotope masses of the 2016 Atomic Mass Evaluation
 * (1H 1.00782503, 16O 15.99491462, 31P 30.97376199): 79.966331.
 */
const HPO3 = { average: 79.979902, monoisotopic: 79.966331 } as const;

/** Options of {@link dnaMolecularWeight}. */
export interface DnaMolecularWeightOptions {
  /** Add the complementary strand; default false. */
  doubleStranded?: boolean;
  /** Circular molecule (no ends: one more phosphodiester bond per strand); default false. */
  circular?: boolean;
  /** 'DNA' (default; A C G T) or 'RNA' (A C G U, T is read as U). */
  molecule?: 'DNA' | 'RNA';
  /** Monoisotopic instead of average masses; default false. */
  monoisotopic?: boolean;
  /**
   * Linear strands carry a 5'-monophosphate (default true, Biopython's convention, as for products
   * of restriction digests and most enzymatic syntheses). false: 5'-OH ends, as for synthetic
   * oligonucleotides; each linear strand is then lighter by HPO3 (79.98 Da). Ignored when circular.
   */
  fivePrimePhosphate?: boolean;
}

/** Index 0..3 of a nucleotide (A, C, G, T/U) for the mass tables, -1 when not allowed. */
function nucleotideIndex(code: number, molecule: 'DNA' | 'RNA'): number {
  switch (code | 0x20) {
    case 0x61: // a
      return 0;
    case 0x63: // c
      return 1;
    case 0x67: // g
      return 2;
    case 0x74: // t (read as U for RNA)
      return 3;
    case 0x75: // u
      return molecule === 'RNA' ? 3 : -1;
    default:
      return -1;
  }
}

/**
 * Molecular weight (Da) of a DNA or RNA molecule.
 *
 * Each strand weighs the sum of its nucleoside monophosphates minus one water per phosphodiester
 * bond (n - 1 for a linear strand, n for a circular one): a linear strand has a 5'-phosphate and a
 * 3'-OH, exactly as Biopython's `molecular_weight` (results agree within 1e-6 Da). With
 * `doubleStranded` the complementary strand is added the same way. `fivePrimePhosphate: false`
 * removes HPO3 per linear strand (5'-OH oligonucleotides; e.g. a 5'-OH "AA" weighs 564.45 Da; this
 * agrees within 0.01 Da per base with the oligo formula 313.21 A + 304.2 T + 289.18 C + 329.21 G
 * - 61.96 of Thermo Fisher/Ambion, "DNA and RNA Molecular Weights and Conversions").
 * The empty sequence weighs 0 (Biopython returns one water, 18.0153). Case-insensitive.
 *
 * @throws RangeError for any character other than A, C, G, T (DNA) or A, C, G, U, T (RNA), including
 *   IUPAC ambiguity codes, whose mass is not defined.
 */
export function dnaMolecularWeight(seq: string, options: DnaMolecularWeightOptions = {}): number {
  const molecule = options.molecule ?? 'DNA';
  if (molecule !== 'DNA' && molecule !== 'RNA') throw new RangeError(`molecule must be 'DNA' or 'RNA'`);
  const kind = options.monoisotopic ? 'monoisotopic' : 'average';
  const masses = NUCLEOTIDE_MASSES[molecule][kind];
  const water = WATER[kind];
  const circular = options.circular ?? false;
  const counts = [0, 0, 0, 0];
  for (let i = 0; i < seq.length; i++) {
    const k = nucleotideIndex(seq.charCodeAt(i), molecule);
    if (k < 0) {
      const allowed = molecule === 'DNA' ? 'A, C, G or T' : 'A, C, G or U';
      throw new RangeError(
        `Cannot compute the molecular weight: '${characterAt(seq, i)}' at index ${i} is not ${allowed}`,
      );
    }
    counts[k]++;
  }
  const n = seq.length;
  if (n === 0) return 0;
  const ends = circular || (options.fivePrimePhosphate ?? true) ? 0 : HPO3[kind];
  const strandMass = (a: number, c: number, g: number, t: number) =>
    a * masses[0] + c * masses[1] + g * masses[2] + t * masses[3] - (circular ? n : n - 1) * water - ends;
  let mass = strandMass(counts[0], counts[1], counts[2], counts[3]);
  if (options.doubleStranded) mass += strandMass(counts[3], counts[2], counts[1], counts[0]); // A<->T(U), C<->G
  return mass;
}

/**
 * Average masses (Da) of the free amino acids, from Biopython 1.88 Bio.Data.IUPACData.protein_weights
 * (IUPAC average masses), including U (selenocysteine) and O (pyrrolysine).
 */
const AMINO_ACID_MASSES: Readonly<Record<string, number>> = {
  A: 89.0932, C: 121.1582, D: 133.1027, E: 147.1293, F: 165.1891, G: 75.0666, H: 155.1546, I: 131.1729,
  K: 146.1876, L: 131.1729, M: 149.2113, N: 132.1179, O: 255.3134, P: 115.1305, Q: 146.1445, R: 174.201,
  S: 105.0926, T: 119.1192, U: 168.0532, V: 117.1463, W: 204.2252, Y: 181.1885,
};

/**
 * The protein with ASCII a-z upper-cased and without one trailing '*' (the stop codon of a
 * translation is not part of the protein). Only ASCII letters are folded: String#toUpperCase would
 * turn 'ß' into 'SS' and 'ı' (dotless i) into 'I', accepting them as residues and shifting the
 * indices that error messages refer to. Indices of the result are those of `protein`.
 */
function proteinResidues(protein: string): string {
  const p = protein.replace(/[a-z]+/g, (letters) => letters.toUpperCase());
  return p.endsWith('*') ? p.slice(0, -1) : p;
}

/**
 * Molecular weight (Da) of a protein from average masses: the sum of its free amino acids minus one
 * water per peptide bond, as Biopython's `ProteinAnalysis(p).molecular_weight()`.
 * A single trailing '*' (stop) is ignored; the empty protein weighs 0 (Biopython: 18.0153).
 * Case-insensitive for ASCII letters.
 *
 * @throws RangeError for characters other than the 20 standard amino acids, U and O (ambiguous
 *   residues B, Z, J, X and internal '*' have no defined mass; Biopython raises as well). The message
 *   names the first such character and its (0-based, UTF-16) index in `protein`.
 */
export function proteinMolecularWeight(protein: string): number {
  const p = proteinResidues(protein);
  let sum = 0;
  for (let i = 0; i < p.length; i++) {
    const m = AMINO_ACID_MASSES[p[i]];
    if (m === undefined) {
      throw new RangeError(
        `Cannot compute the molecular weight: '${characterAt(protein, i)}' at index ${i} ` +
          `is not an unambiguous amino acid`,
      );
    }
    sum += m;
  }
  return p.length === 0 ? 0 : sum - (p.length - 1) * WATER.average;
}

// ---------------------------------------------------------------------------
// Charge, isoelectric point, extinction coefficient
// ---------------------------------------------------------------------------

/**
 * pK values of Bjellqvist et al., Electrophoresis 14:1023-1031 (1993) and 15:529-539 (1994), as
 * tabulated in Biopython's Bio.SeqUtils.IsoelectricPoint. N- and C-terminal pKs depend on the
 * terminal residue. ExPASy Compute pI/Mw uses the same values except the C-terminal pKs of D and E
 * (see proteinIsoelectricPoint).
 */
const POSITIVE_PK: Readonly<Record<string, number>> = { Nterm: 7.5, K: 10.0, R: 12.0, H: 5.98 };
const NEGATIVE_PK: Readonly<Record<string, number>> = { Cterm: 3.55, D: 4.05, E: 4.45, C: 9.0, Y: 10.0 };
const N_TERMINAL_PK: Readonly<Record<string, number>> = { A: 7.59, M: 7.0, S: 6.93, P: 8.36, T: 6.82, V: 7.44, E: 7.7 };
const C_TERMINAL_PK: Readonly<Record<string, number>> = { D: 4.55, E: 4.75 };

/** Residues accepted by the charge / pI / extinction functions (B, Z, J, X, U, O: no charge, no absorbance). */
const PROTEIN_LETTERS = /^[ACDEFGHIKLMNPQRSTVWYBZJXUO]*$/;

/** {@link proteinResidues} after checking that every residue is an amino-acid letter. */
function checkedProtein(protein: string, what: string): string {
  const p = proteinResidues(protein);
  for (let i = 0; i < p.length; i++) {
    if (!PROTEIN_LETTERS.test(p[i])) {
      throw new RangeError(
        `Cannot compute the ${what}: '${characterAt(protein, i)}' at index ${i} is not an amino-acid letter`,
      );
    }
  }
  return p;
}

/** Charge model of one protein: counts of charged groups and the pKs of its termini. */
interface ChargeModel {
  positive: [number, number][]; // [count, pK]
  negative: [number, number][];
}

function chargeModel(p: string): ChargeModel {
  const count = (aa: string) => {
    let n = 0;
    for (let i = 0; i < p.length; i++) if (p[i] === aa) n++;
    return n;
  };
  const nterm = N_TERMINAL_PK[p[0]] ?? POSITIVE_PK.Nterm;
  const cterm = C_TERMINAL_PK[p[p.length - 1]] ?? NEGATIVE_PK.Cterm;
  // Same group order as Biopython (Nterm, K, R, H / Cterm, D, E, C, Y) so sums round identically.
  return {
    positive: [
      [1, nterm],
      [count('K'), POSITIVE_PK.K],
      [count('R'), POSITIVE_PK.R],
      [count('H'), POSITIVE_PK.H],
    ],
    negative: [
      [1, cterm],
      [count('D'), NEGATIVE_PK.D],
      [count('E'), NEGATIVE_PK.E],
      [count('C'), NEGATIVE_PK.C],
      [count('Y'), NEGATIVE_PK.Y],
    ],
  };
}

/** Henderson-Hasselbalch net charge of a charge model at `pH`. */
function chargeAt(model: ChargeModel, pH: number): number {
  let positive = 0;
  for (const [n, pK] of model.positive) positive += n * (1 / (10 ** (pH - pK) + 1));
  let negative = 0;
  for (const [n, pK] of model.negative) negative += n * (1 / (10 ** (pK - pH) + 1));
  return positive - negative;
}

/**
 * Net charge of a protein at the given pH (Henderson-Hasselbalch with the Bjellqvist pK set, one
 * free N- and C-terminus), as Biopython's `ProteinAnalysis(p).charge_at_pH(pH)`.
 * Only K, R, H, D, E, C, Y and the termini are charged; B, Z, J, X, U and O are accepted and treated
 * as uncharged (as Biopython does). A single trailing '*' is ignored. Returns NaN for an empty protein.
 *
 * @throws RangeError for characters that are not amino-acid letters (or an internal '*').
 */
export function proteinChargeAtPh(protein: string, pH: number): number {
  const p = checkedProtein(protein, 'charge');
  if (p.length === 0) return Number.NaN;
  return chargeAt(chargeModel(p), pH);
}

/**
 * Biopython's isoelectric-point bisection (Bio.SeqUtils.IsoelectricPoint.pi): start pH and interval.
 * Its docstring assumes every pI lies inside, which is false: e.g. the FLAG tag DYKDDDDK has pI 3.97
 * and protamine P1 12.08 (ExPASy Compute pI/Mw), and Biopython returns the bound for both.
 */
const BIOPYTHON_PI_START = 7.775;
const BIOPYTHON_PI_MIN = 4.05;
const BIOPYTHON_PI_MAX = 12;
/** The bisection stops once its interval is at most this wide (pH units), as in Biopython. */
const PI_INTERVAL = 0.0001;

/**
 * Bisection for the root of the net charge in [lo, hi] (charge > 0 below the root), starting at
 * `pH`, exactly as Biopython's recursion: the result is the midpoint of an interval of at most
 * {@link PI_INTERVAL} that contains the root, i.e. within PI_INTERVAL / 2 of it.
 */
function bisectIsoelectricPoint(model: ChargeModel, pH: number, lo: number, hi: number): number {
  while (hi - lo > PI_INTERVAL) {
    if (chargeAt(model, pH) > 0) lo = pH;
    else hi = pH;
    pH = (lo + hi) / 2;
  }
  return pH;
}

/**
 * Isoelectric point (pH units): the pH at which the net charge of {@link proteinChargeAtPh} (method
 * of Bjellqvist et al., see the pK table) is zero, by bisection to within 0.00005.
 *
 * The net charge decreases strictly with pH, from the number of basic groups (at least the
 * N-terminus) at low pH to minus the number of acidic groups (at least the C-terminus) at high pH,
 * so this root always exists and is unique. When it lies in [4.05, 12] the bisection
 * is exactly Biopython's (start at pH 7.775 in [4.05, 12], halve until at most 0.0001 wide), so the
 * result equals `ProteinAnalysis(p).isoelectric_point()`. Biopython never looks outside that
 * interval and returns its bound there; this function instead widens the interval until it contains
 * the root, so acidic peptides and very basic proteins get their true pI (FLAG tag DYKDDDDK 3.971,
 * Biopython 4.050; protamine P1 12.075, Biopython 12.000). There is no clamping at all: extreme
 * compositions such as 200 Arg (14.30) or 12000 Asp (-0.03) give values outside pH 0-14, where the
 * model is an extrapolation and ExPASy reports its search bounds 14.00 and 0.00.
 *
 * ExPASy Compute pI/Mw agrees within its 0.01 rounding except when the C-terminal residue is D or E:
 * there ExPASy uses the C-terminal pK 3.55 of other residues instead of 4.55 / 4.75 (e.g. E10: ExPASy
 * 3.29, here and in Biopython's model 3.47). Observed on 21 sequences, 2026-10-08.
 *
 * B, Z, J, X, U and O count as uncharged; a single trailing '*' is ignored (Biopython would use '*'
 * as the C-terminal residue). Returns NaN for an empty protein. Case-insensitive for ASCII letters.
 *
 * @throws RangeError for characters that are not amino-acid letters (or an internal '*').
 */
export function proteinIsoelectricPoint(protein: string): number {
  const p = checkedProtein(protein, 'isoelectric point');
  if (p.length === 0) return Number.NaN;
  const model = chargeModel(p);
  if (chargeAt(model, BIOPYTHON_PI_MIN) <= 0) {
    // root at or below 4.05: move the lower bound down until the charge there is positive
    let width = 1;
    while (chargeAt(model, BIOPYTHON_PI_MIN - width) <= 0) width *= 2;
    const lo = BIOPYTHON_PI_MIN - width;
    return bisectIsoelectricPoint(model, (lo + BIOPYTHON_PI_MIN) / 2, lo, BIOPYTHON_PI_MIN);
  }
  if (chargeAt(model, BIOPYTHON_PI_MAX) > 0) {
    // root above 12: move the upper bound up until the charge there is no longer positive
    let width = 1;
    while (chargeAt(model, BIOPYTHON_PI_MAX + width) > 0) width *= 2;
    const hi = BIOPYTHON_PI_MAX + width;
    return bisectIsoelectricPoint(model, (BIOPYTHON_PI_MAX + hi) / 2, BIOPYTHON_PI_MAX, hi);
  }
  return bisectIsoelectricPoint(model, BIOPYTHON_PI_START, BIOPYTHON_PI_MIN, BIOPYTHON_PI_MAX);
}

/**
 * Molar extinction coefficients at 280 nm in water (M^-1 cm^-1) per Pace et al., Protein Sci
 * 4:2411-2423 (1995): Trp 5500, Tyr 1490, cystine (disulfide-bonded Cys pair) 125.
 */
const EXTINCTION_280 = { W: 5500, Y: 1490, cystine: 125 } as const;

/**
 * Molar extinction coefficient at 280 nm (M^-1 cm^-1), as Biopython's
 * `ProteinAnalysis(p).molar_extinction_coefficient()` and ExPASy ProtParam:
 * reduced = 5500 W + 1490 Y (all cysteines reduced);
 * oxidized = reduced + 125 * floor(C / 2) (all cysteines paired in cystines).
 * Ambiguous residues (B, Z, J, X) are not counted; a single trailing '*' is ignored. Case-insensitive.
 *
 * @throws RangeError for characters that are not amino-acid letters (or an internal '*').
 */
export function proteinExtinctionCoefficient(protein: string): { reduced: number; oxidized: number } {
  const p = checkedProtein(protein, 'extinction coefficient');
  let w = 0;
  let y = 0;
  let c = 0;
  for (let i = 0; i < p.length; i++) {
    if (p[i] === 'W') w++;
    else if (p[i] === 'Y') y++;
    else if (p[i] === 'C') c++;
  }
  const reduced = w * EXTINCTION_280.W + y * EXTINCTION_280.Y;
  return { reduced, oxidized: reduced + Math.floor(c / 2) * EXTINCTION_280.cystine };
}
