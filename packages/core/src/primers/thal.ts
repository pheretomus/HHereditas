/**
 * Thermodynamic alignment ("thal"): the most stable hairpin of one DNA oligo, or the most stable
 * duplex (dimer) between two oligos, under the nearest-neighbour model with Watson–Crick stacks,
 * single mismatches, bulges, internal and hairpin loops, terminal mismatches and dangling ends.
 *
 * This is a TypeScript implementation of the model used by primer3's thermodynamic alignment
 * (Untergasser et al. (2012) "Primer3 — new capabilities and interfaces", Nucleic Acids Res
 * 40:e115; libprimer3 2.6.1 `thal.c`), written so that results agree with primer3
 * (`calc_hairpin`, `calc_homodimer`, `calc_heterodimer`, `calc_end_stability` of primer3-py):
 *
 *  - Dynamic programming over base pairs (i, j) that keeps, for every pair, the enthalpy/entropy
 *    of the structure with the highest melting temperature ending in that pair (not the lowest
 *    ΔG): T = (ΔH + ΔH_init) / (ΔS + ΔS_init + R·ln(C/x)).
 *  - Dimers: duplex initiation ΔH 0.2 kcal/mol, ΔS −5.7 e.u.; x = 1 when both oligos are
 *    self-complementary, else 4. The best structure is the one with the lowest ΔG at 37 °C.
 *  - Hairpins: no initiation or concentration term; an exterior-loop recursion over the 5' end
 *    picks closing helices whose ΔG at the analysis temperature is negative.
 *  - Salt: ΔS of the final structure gets 0.368·(N − 1)·ln([Na+eq]/1 M) where N is the number of
 *    paired bases per strand ([Na+eq] = [Mon+] + 120·√([Mg2+] − [dNTP]), mM).
 *
 * Parameters: `thal-tables.ts` (SantaLucia & Hicks 2004 as compiled in primer3's primer3_config).
 * Bases other than A, C, G and T (IUPAC ambiguity codes) never pair, as in primer3.
 * Energies here are in cal/mol and cal/(K·mol); `analysis.ts` converts them for the public API.
 *
 * Speed: the dimer table is filled like primer3's, but the helix-end term of a cell is computed once
 * per cell instead of once per loop tried, and loops that provably cannot beat the cell's current
 * structure are skipped (see `Alignment.fillDimer`); results are bit-identical to the unpruned
 * recurrences, about 5× faster than primer3 on long low-complexity partners.
 *
 * Provenance: to reproduce primer3 exactly, the recurrences, tie-breaking rules, constants and
 * evaluation order follow libprimer3 2.6.1 `thal.c` (GPL-2.0-or-later); the code is restructured
 * but should be treated as derived from it when choosing HHereditas' license.
 */
import { KELVIN_OFFSET, R_CAL_PRIMER3_THAL } from './thermo-tables';
import {
  DANGLE_DH,
  DANGLE_DS,
  LOOPS_DH,
  LOOPS_DS,
  STACKMM_DH,
  STACKMM_DS,
  STACK_DH,
  STACK_DS,
  TETRALOOP_DH,
  TETRALOOP_DS,
  TRILOOP_DH,
  TRILOOP_DS,
  TSTACK2_DH,
  TSTACK2_DS,
  TSTACK_DH,
  TSTACK_TM_INF_DS,
} from './thal-tables';

const INF = Infinity;
/** Gas constant in cal/(K·mol) (primer3 thal). */
const R = R_CAL_PRIMER3_THAL;
/** 0 °C in kelvin. */
const KELVIN = KELVIN_OFFSET;
/** Temperature (K) at which the dynamic programming compares free energies: 37 °C. */
const T37 = 310.15;
/** Duplex initiation, SantaLucia & Hicks (2004): ΔH 200 cal/mol, ΔS −5.7 cal/(K·mol). */
const DUPLEX_INIT_H = 200;
const DUPLEX_INIT_S = -5.7;
/** Terminal A·T penalty, SantaLucia & Hicks (2004): ΔH 2200 cal/mol, ΔS 6.9 cal/(K·mol). */
const AT_PENALTY_H = 2200;
const AT_PENALTY_S = 6.9;
/** Internal-loop asymmetry penalty, ΔG37 +0.3 kcal/mol per unpaired-base difference, as entropy (SantaLucia & Hicks 2004; no ΔH term). */
const ASYMMETRY_S = -300 / 310.15;
/** Entropies below this mean "no structure" (primer3 thal). */
const MIN_ENTROPY_CUTOFF = -2500;
/** Entropy assigned to the unstructured state (primer3 thal). */
const MIN_ENTROPY = -3224;
/** Smallest hairpin loop. */
const MIN_HAIRPIN_LOOP = 3;
/** Stand-in for a zero entropy that keeps T = H / S defined (primer3 thal). */
const TINY = 1e-11;
/** Free-energy threshold (cal/mol) a hairpin closing helix must beat at the analysis temperature. */
const HAIRPIN_G_THRESHOLD = 0;
/**
 * At least one of the two sequences of a thermodynamic alignment must be at most this long (nt):
 * primer3's limit for the two-state (all-or-none) melting model. Hairpins therefore need <= 60 nt.
 */
export const THAL_MAX_ALIGN = 60;
/** Longest sequence (nt) accepted by the thermodynamic alignment (primer3's limit). */
export const THAL_MAX_SEQ = 10000;

// ---------------------------------------------------------------------------
// Parameter tables over base codes A=0 C=1 G=2 T=3 and 4 = anything else
// ---------------------------------------------------------------------------

const B = 5;
const at4 = (a: number, b: number, c: number, d: number): number => ((a * B + b) * B + c) * B + d;
const at3 = (a: number, b: number, c: number): number => (a * B + b) * B + c;
const fileIndex4 = (a: number, b: number, c: number, d: number): number => ((a * 4 + b) * 4 + c) * 4 + d;

interface Table {
  S: Float64Array;
  H: Float64Array;
}

function emptyTable(size: number, s: number, h: number): Table {
  return { S: new Float64Array(size).fill(s), H: new Float64Array(size).fill(h) };
}

/** Watson–Crick or mismatch stacks: any non-ACGT index, or a non-finite value, forbids the stack. */
function stackTable(ds: readonly number[], dh: readonly number[]): Table {
  const t = emptyTable(B ** 4, -1, INF);
  for (let a = 0; a < 4; a++) {
    for (let b = 0; b < 4; b++) {
      for (let c = 0; c < 4; c++) {
        for (let d = 0; d < 4; d++) {
          const s = ds[fileIndex4(a, b, c, d)];
          const h = dh[fileIndex4(a, b, c, d)];
          if (Number.isFinite(s) && Number.isFinite(h)) {
            t.S[at4(a, b, c, d)] = s;
            t.H[at4(a, b, c, d)] = h;
          }
        }
      }
    }
  }
  return t;
}

/** Terminal mismatches [a][b][c][d] (a·c the closing pair): a non-ACGT neighbour b or d costs nothing. */
function terminalMismatchTable(ds: readonly number[], dh: readonly number[]): Table {
  const t = emptyTable(B ** 4, -1, INF);
  for (let a = 0; a < B; a++) {
    for (let b = 0; b < B; b++) {
      for (let c = 0; c < B; c++) {
        for (let d = 0; d < B; d++) {
          if (a === 4 || c === 4) continue;
          if (b === 4 || d === 4) {
            t.S[at4(a, b, c, d)] = TINY;
            t.H[at4(a, b, c, d)] = 0;
            continue;
          }
          const s = ds[fileIndex4(a, b, c, d)];
          const h = dh[fileIndex4(a, b, c, d)];
          if (Number.isFinite(s) && Number.isFinite(h)) {
            t.S[at4(a, b, c, d)] = s;
            t.H[at4(a, b, c, d)] = h;
          }
        }
      }
    }
  }
  return t;
}

/** Dangling ends; the file lists 64 3'-dangles then 64 5'-dangles, each in (x, y, z) order. */
function dangleTables(ds: readonly number[], dh: readonly number[]): { d3: Table; d5: Table } {
  const d3 = emptyTable(B ** 3, -1, INF);
  const d5 = emptyTable(B ** 3, -1, INF);
  for (let x = 0; x < 4; x++) {
    for (let y = 0; y < 4; y++) {
      for (let z = 0; z < 4; z++) {
        const k = (x * 4 + y) * 4 + z;
        // 3' dangle [pair base][dangling base][partner]: the file's (x, y, z) is stored at [x][z][y]
        if (Number.isFinite(ds[k]) && Number.isFinite(dh[k])) {
          d3.S[at3(x, z, y)] = ds[k];
          d3.H[at3(x, z, y)] = dh[k];
        }
        if (Number.isFinite(ds[64 + k]) && Number.isFinite(dh[64 + k])) {
          d5.S[at3(x, y, z)] = ds[64 + k];
          d5.H[at3(x, y, z)] = dh[64 + k];
        }
      }
    }
  }
  return { d3, d5 };
}

function loopColumn(rows: readonly (readonly [number, number, number])[], column: 0 | 1 | 2): Float64Array {
  return Float64Array.from(rows, (r) => r[column]);
}

const TABLES = (() => {
  const { d3, d5 } = dangleTables(DANGLE_DS, DANGLE_DH);
  const atS = new Float64Array(B * B).fill(TINY);
  const atH = new Float64Array(B * B);
  atS[0 * B + 3] = atS[3 * B + 0] = AT_PENALTY_S;
  atH[0 * B + 3] = atH[3 * B + 0] = AT_PENALTY_H;
  return {
    stack: stackTable(STACK_DS, STACK_DH),
    mismatch: stackTable(STACKMM_DS, STACKMM_DH),
    loopMismatch: terminalMismatchTable(TSTACK_TM_INF_DS, TSTACK_DH),
    endMismatch: terminalMismatchTable(TSTACK2_DS, TSTACK2_DH),
    d3,
    d5,
    interior: { S: loopColumn(LOOPS_DS, 0), H: loopColumn(LOOPS_DH, 0) },
    bulge: { S: loopColumn(LOOPS_DS, 1), H: loopColumn(LOOPS_DH, 1) },
    hairpin: { S: loopColumn(LOOPS_DS, 2), H: loopColumn(LOOPS_DH, 2) },
    atS,
    atH,
  };
})();

/** Side of the {@link LOOP_G37_MIN} table: unpaired bases per strand 0..31 (loops are at most 30). */
const LOOP_BOUND_SIZE = 32;

/**
 * Safety margin (cal/mol) of the loop pruning in `Alignment.fillDimer`: far above the rounding error
 * of the ΔG sums (< 1e-8 cal/mol for |ΔG| < 1e6), so pruning never skips a loop primer3 would accept.
 */
const PRUNE_TOLERANCE = 1e-3;

/**
 * Least ΔG37 (cal/mol) that a dimer bulge or internal loop with l1 unpaired bases in sequence 1 and
 * l2 in sequence 2 can contribute, over every base combination, at index l1·LOOP_BOUND_SIZE + l2:
 * the loop energies of `Alignment.dimerLoop` (bulge with the stack it keeps, or A·T penalties;
 * 1×1 mismatch stacks; interior loop with terminal mismatches and asymmetry) evaluated at 37 °C.
 * +∞ where the model forbids every combination (and beyond the 30-nt loop tables).
 */
const LOOP_G37_MIN: Float64Array = (() => {
  const T = TABLES;
  /** ΔG37 of an (H, S) pair; +∞ for a forbidden one, −∞ (never prunes) if only S were non-finite. */
  const g = (h: number, s: number): number => (!Number.isFinite(h) ? INF : Number.isFinite(s) ? h - T37 * s : -INF);
  const least = (hs: Float64Array, ss: Float64Array): number => {
    let m = INF;
    for (let k = 0; k < hs.length; k++) m = Math.min(m, g(hs[k], ss[k]));
    return m;
  };
  const atLeast = least(T.atH, T.atS);
  const mismatchLeast = least(T.mismatch.H, T.mismatch.S);
  const loopMismatchLeast = least(T.loopMismatch.H, T.loopMismatch.S);
  const out = new Float64Array(LOOP_BOUND_SIZE * LOOP_BOUND_SIZE).fill(INF);
  for (let l1 = 0; l1 < LOOP_BOUND_SIZE; l1++) {
    for (let l2 = 0; l2 < LOOP_BOUND_SIZE; l2++) {
      const size = l1 + l2 - 1;
      if (size < 0 || size >= T.bulge.H.length) continue;
      let bound: number;
      if (l1 === 0 || l2 === 0) {
        if (size === 0) {
          bound = INF; // single-base bulge: bulge term plus the stack across it
          for (let k = 0; k < T.stack.H.length; k++) bound = Math.min(bound, g(T.bulge.H[0] + T.stack.H[k], T.bulge.S[0] + T.stack.S[k]));
        } else {
          bound = g(T.bulge.H[size], T.bulge.S[size]) + 2 * atLeast;
        }
      } else if (l1 === 1 && l2 === 1) {
        bound = 2 * mismatchLeast;
      } else {
        bound = g(T.interior.H[size], T.interior.S[size]) + 2 * loopMismatchLeast - T37 * ASYMMETRY_S * Math.abs(l1 - l2);
      }
      out[l1 * LOOP_BOUND_SIZE + l2] = bound;
    }
  }
  return out;
})();

const BASE_LETTERS = 'ACGTN';

function encode(seq: string): Uint8Array {
  // Codes padded with a non-pairing base (4) at index 0 and at index length + 1.
  const out = new Uint8Array(seq.length + 2).fill(4);
  for (let i = 0; i < seq.length; i++) {
    const k = 'ACGT'.indexOf(seq[i]);
    out[i + 1] = k < 0 ? 4 : k;
  }
  return out;
}

/** True for a Watson–Crick pair (A·T, C·G); code 4 never pairs. */
const pairs = (a: number, b: number): boolean => a + b === 3;

/** primer3's symmetry test: even length and each base complementary to its mirror (non-ACGT only mirrors itself). */
function isSymmetric(seq: string): boolean {
  const n = seq.length;
  if (n % 2 === 1) return false;
  const comp: Record<string, string> = { A: 'T', T: 'A', C: 'G', G: 'C' };
  for (let i = 0; i < n / 2; i++) {
    const s = seq[i];
    const e = seq[n - 1 - i];
    if (comp[s] !== undefined || comp[e] !== undefined) {
      if (comp[s] !== e) return false;
    }
  }
  return true;
}

const isFiniteNumber = Number.isFinite;

/** primer3 thal `equal()`: both finite and within 1e-5. */
const same = (a: number, b: number): boolean => isFiniteNumber(a) && isFiniteNumber(b) && Math.abs(a - b) < 1e-5;

/** [entropy, enthalpy] pair. */
type SH = [number, number];
const NONE = (): SH => [-1, INF];

/** Exterior-loop term kinds of the hairpin recursion (see `Alignment.exteriorHelix`). */
type ExteriorKind = 1 | 2 | 3 | 4;
const EXTERIOR_KINDS: readonly ExteriorKind[] = [1, 2, 3, 4];

interface ExteriorHelix {
  /** DP cell of the closing pair (first, last). */
  cell: number;
  first: number;
  last: number;
  atS: number;
  atH: number;
  /** Dangling-end or terminal-mismatch term (0 for a bare pair). */
  extraS: number;
  extraH: number;
}

/** Dangling-end option of a helix end whose neighbours do not pair: both dangles if defined, else the 3' one, else the 5' one. */
function dangleOption(atS: number, atH: number, d3S: number, d3H: number, d5S: number, d5H: number): SH | undefined {
  if (isFiniteNumber(d3H) && isFiniteNumber(d5H)) return [atS + d3S + d5S, atH + d3H + d5H];
  if (isFiniteNumber(d3H)) return [atS + d3S, atH + d3H];
  if (isFiniteNumber(d5H)) return [atS + d5S, atH + d5H];
  return undefined;
}

/** Conditions of one thermodynamic alignment. Concentrations in mM (cations, dNTP) and nM (oligo). */
export interface ThalConditions {
  /** [Na+] + [K+], mM. */
  monovalentMilliMolar: number;
  /** [Mg2+], mM. */
  divalentMilliMolar: number;
  /** dNTP, mM. */
  dntpMilliMolar: number;
  /** Oligo strand concentration, nM (concentration term of dimers). */
  oligoNanoMolar: number;
  /** Analysis temperature in kelvin: ΔG is reported here; hairpin helices must be stable here. */
  temperatureKelvin: number;
  /** Largest loop considered, nucleotides (primer3 default 30, at most 30). */
  maxLoop: number;
}

/** Raw result of one alignment (primer3 ThermoResult units). */
export interface ThalResult {
  /** False when no structure with a finite enthalpy exists (every number is then 0). */
  found: boolean;
  /** °C; 0 when nothing was found. */
  tm: number;
  /** cal/mol at the analysis temperature. */
  dg: number;
  /** cal/mol. */
  dh: number;
  /** cal/(K·mol), salt corrected. */
  ds: number;
  /** Paired positions, 0-based: [index in sequence 1, index in sequence 2] (hairpins: both in the one sequence, first < second). */
  pairs: [number, number][];
}

/** Entropy salt correction per paired nucleotide pair, primer3 thal `saltCorrectS`. */
function saltCorrection(c: ThalConditions): number {
  const dntp = c.divalentMilliMolar <= 0 ? c.divalentMilliMolar : c.dntpMilliMolar;
  return 0.368 * Math.log((c.monovalentMilliMolar + 120 * Math.sqrt(Math.max(0.0, c.divalentMilliMolar - dntp))) / 1000);
}

/**
 * One dynamic-programming problem. For dimers, `s2` is the second oligo reversed (read 3'→5'), so
 * pair (i, j) aligns base i of oligo 1 with base j of reversed oligo 2; for hairpins `s2` = `s1`.
 * Indices are 1-based like the recurrences (codes at 0 and length + 1 are padding).
 */
class Alignment {
  readonly len1: number;
  readonly len2: number;
  /** Row stride of the DP tables (len2 for dimers, len2 − 1 for hairpins, as in primer3). */
  private readonly stride: number;
  readonly H: Float64Array;
  readonly S: Float64Array;
  private readonly hEnd: Float64Array;
  private readonly sEnd: Float64Array;
  /** Result of the last accepted {@link dimerLoop} call (avoids allocating a pair per call in the hot loop). */
  private loopS = -1;
  private loopH = INF;

  constructor(
    readonly s1: Uint8Array,
    readonly s2: Uint8Array,
    readonly hairpin: boolean,
    readonly initH: number,
    readonly initS: number,
    readonly rc: number,
    readonly maxLoop: number,
  ) {
    this.len1 = s1.length - 2;
    this.len2 = s2.length - 2;
    this.stride = hairpin ? this.len2 - 1 : this.len2;
    this.H = new Float64Array(this.len1 * this.len2);
    this.S = new Float64Array(this.len1 * this.len2);
    this.hEnd = new Float64Array(hairpin ? this.len1 + 1 : 0);
    this.sEnd = new Float64Array(hairpin ? this.len1 + 1 : 0);
  }

  cell(i: number, j: number): number {
    return j + (i - 1) * this.stride - 1;
  }

  private melting(H: number, S: number): number {
    return (H + this.initH) / (S + this.initS + this.rc);
  }

  // ----- helix ends -------------------------------------------------------------------------

  /**
   * Best treatment of a helix end with closing pair p (A·T penalty `atS/atH`): terminal mismatch,
   * dangling end(s) when the neighbours do not pair, or the bare pair; picks the highest Tm among
   * the stable (ΔG37 < 0) options.
   */
  private helixEnd(
    atS: number,
    atH: number,
    mmS: number,
    mmH: number,
    neighboursPair: boolean,
    d3S: number,
    d3H: number,
    d5S: number,
    d5H: number,
  ): SH {
    let S1 = atS + mmS;
    let H1 = atH + mmH;
    let G1 = H1 - T37 * S1;
    if (!isFiniteNumber(H1) || G1 > 0) {
      H1 = INF;
      S1 = -1;
      G1 = 1;
    }
    let T1 = -INF;
    const dangle = neighboursPair ? undefined : dangleOption(atS, atH, d3S, d3H, d5S, d5H);
    if (dangle) {
      let [S2, H2] = dangle;
      let G2 = H2 - T37 * S2;
      if (!isFiniteNumber(H2) || G2 > 0) {
        H2 = INF;
        S2 = -1;
        G2 = 1;
      }
      const T2 = this.melting(H2, S2);
      if (isFiniteNumber(H1) && G1 < 0) {
        T1 = this.melting(H1, S1);
        if (T1 < T2 && G2 < 0) {
          S1 = S2;
          H1 = H2;
          T1 = T2;
        }
      } else if (G2 < 0) {
        S1 = S2;
        H1 = H2;
        T1 = T2;
      }
    }
    if (isFiniteNumber(H1) && !(T1 < this.melting(atH, atS))) return [S1, H1];
    return [atS, atH];
  }

  /** Left (5' of oligo 1) end of a helix starting with pair (i, j). Clears the cell when (i, j) cannot pair. */
  leftEnd(i: number, j: number): SH {
    const { s1, s2 } = this;
    const a = s1[i];
    const b = s2[j];
    if (!pairs(a, b)) {
      this.S[this.cell(i, j)] = -1;
      this.H[this.cell(i, j)] = INF;
      return NONE();
    }
    const T = TABLES;
    const k = a * B + b;
    const mm = at4(b, s2[j - 1], a, s1[i - 1]);
    const d3 = at3(b, s2[j - 1], a);
    const d5 = at3(b, a, s1[i - 1]);
    return this.helixEnd(
      T.atS[k],
      T.atH[k],
      T.endMismatch.S[mm],
      T.endMismatch.H[mm],
      pairs(s1[i - 1], s2[j - 1]),
      T.d3.S[d3],
      T.d3.H[d3],
      T.d5.S[d5],
      T.d5.H[d5],
    );
  }

  /** Right (3' of oligo 1) end of a helix ending with pair (i, j). */
  rightEnd(i: number, j: number): SH {
    const { s1, s2 } = this;
    const a = s1[i];
    const b = s2[j];
    if (!pairs(a, b)) return NONE();
    const T = TABLES;
    const k = a * B + b;
    const mm = at4(a, s1[i + 1], b, s2[j + 1]);
    const d3 = at3(a, s1[i + 1], b);
    const d5 = at3(a, b, s2[j + 1]);
    return this.helixEnd(
      T.atS[k],
      T.atH[k],
      T.endMismatch.S[mm],
      T.endMismatch.H[mm],
      pairs(s1[i + 1], s2[j + 1]),
      T.d3.S[d3],
      T.d3.H[d3],
      T.d5.S[d5],
      T.d5.H[d5],
    );
  }

  // ----- stacks -------------------------------------------------------------------------------

  /** Stack of pair (i, j) on (i+1, j+1) for dimers (`hairpin` false) or on (i+1, j−1) for hairpins. */
  private stack(i: number, j: number, hairpin: boolean): SH {
    const { s1, s2 } = this;
    if (!hairpin) {
      const k = at4(s1[i], s1[i + 1], s2[j], s2[j + 1]);
      return [TABLES.stack.S[k], TABLES.stack.H[k]];
    }
    if (i >= j || i === this.len1 || j === this.len2 + 1) return NONE();
    if (i > this.len1) i -= this.len1;
    if (j > this.len2) j -= this.len2;
    const k = at4(s1[i], s1[i + 1], s2[j], s2[j - 1]);
    const h = TABLES.stack.H[k];
    return [TABLES.stack.S[k], isFiniteNumber(h) ? h : INF];
  }

  // ----- dimers -------------------------------------------------------------------------------

  initDimer(): void {
    for (let i = 1; i <= this.len1; i++) {
      for (let j = 1; j <= this.len2; j++) {
        const c = this.cell(i, j);
        if (pairs(this.s1[i], this.s2[j])) {
          this.H[c] = 0;
          this.S[c] = MIN_ENTROPY;
        } else {
          this.H[c] = INF;
          this.S[c] = -1;
        }
      }
    }
  }

  /**
   * Stacking step: keep pair (i, j) as a helix start, or extend the helix ending at (i−1, j−1).
   * `endS`/`endH`: {@link rightEnd} of (i, j).
   */
  private dimerStack(i: number, j: number, endS: number, endH: number): void {
    const c = this.cell(i, j);
    let S0 = this.S[c];
    let H0 = this.H[c];
    const T0 = (H0 + this.initH + endH) / (S0 + this.initS + endS + this.rc);
    const p = this.cell(i - 1, j - 1);
    const [stS, stH] = this.stack(i - 1, j - 1, false);
    let S1: number;
    let H1: number;
    let T1: number;
    if (isFiniteNumber(this.H[p]) && isFiniteNumber(stH)) {
      S1 = this.S[p] + stS;
      H1 = this.H[p] + stH;
      T1 = (H1 + this.initH + endH) / (S1 + this.initS + endS + this.rc);
    } else {
      S1 = -1;
      H1 = INF;
      T1 = this.melting(H1, S1);
    }
    if (S1 < MIN_ENTROPY_CUTOFF) {
      S1 = MIN_ENTROPY;
      H1 = 0;
    }
    if (S0 < MIN_ENTROPY_CUTOFF) {
      S0 = MIN_ENTROPY;
      H0 = 0;
    }
    if (T1 > T0) {
      this.S[c] = S1;
      this.H[c] = H1;
    } else if (T0 >= T1) {
      this.S[c] = S0;
      this.H[c] = H0;
    }
  }

  /**
   * Bulge or internal loop between inner pair (i, j) and outer pair (ii, jj) of a dimer
   * (ii > i, jj > j); `endS`/`endH` are {@link rightEnd} of (ii, jj), which the caller computes once
   * for all the inner pairs it tries. Returns true, with the energies of the structure ending in
   * (ii, jj) through that loop in `loopS`/`loopH`, when it beats the current value of (ii, jj) at
   * 37 °C (always during traceback).
   */
  private dimerLoop(i: number, j: number, ii: number, jj: number, traceback: boolean, endS: number, endH: number): boolean {
    const s1 = this.s1;
    const s2 = this.s2;
    const T = TABLES;
    const l1 = ii - i - 1;
    const l2 = jj - j - 1;
    const size = l1 + l2 - 1;
    const inner = this.cell(i, j);
    let S: number;
    let H: number;
    if ((l1 === 0 && l2 > 0) || (l2 === 0 && l1 > 0)) {
      if (l1 === 1 || l2 === 1) {
        // a single-base bulge keeps the stacking of the pairs around it
        const k = at4(s1[i], s1[ii], s2[j], s2[jj]);
        H = T.bulge.H[size] + T.stack.H[k];
        S = T.bulge.S[size] + T.stack.S[k];
        if (H > 0 || S > 0) {
          H = INF;
          S = -1;
        }
        H += this.H[inner];
        S += this.S[inner];
        if (!isFiniteNumber(H)) {
          H = INF;
          S = -1;
        }
      } else {
        H = T.bulge.H[size] + T.atH[s1[i] * B + s2[j]] + T.atH[s1[ii] * B + s2[jj]];
        H += this.H[inner];
        S = T.bulge.S[size] + T.atS[s1[i] * B + s2[j]] + T.atS[s1[ii] * B + s2[jj]];
        S += this.S[inner];
        if (!isFiniteNumber(H)) {
          H = INF;
          S = -1;
        }
        if (H > 0 && S > 0) {
          H = INF;
          S = -1;
        }
      }
    } else if (l1 === 1 && l2 === 1) {
      const k1 = at4(s1[i], s1[i + 1], s2[j], s2[j + 1]);
      const k2 = at4(s2[jj], s2[jj - 1], s1[ii], s1[ii - 1]);
      S = T.mismatch.S[k1] + T.mismatch.S[k2];
      S += this.S[inner];
      H = T.mismatch.H[k1] + T.mismatch.H[k2];
      H += this.H[inner];
      if (!isFiniteNumber(H)) {
        H = INF;
        S = -1;
      }
      if (H > 0 && S > 0) {
        H = INF;
        S = -1;
      }
    } else {
      const k1 = at4(s1[i], s1[i + 1], s2[j], s2[j + 1]);
      const k2 = at4(s2[jj], s2[jj - 1], s1[ii], s1[ii - 1]);
      H = T.interior.H[size] + T.loopMismatch.H[k1] + T.loopMismatch.H[k2];
      H += this.H[inner];
      S = T.interior.S[size] + T.loopMismatch.S[k1] + T.loopMismatch.S[k2] + ASYMMETRY_S * Math.abs(l1 - l2);
      S += this.S[inner];
      if (!isFiniteNumber(H)) {
        H = INF;
        S = -1;
      }
      if (H > 0 && S > 0) {
        H = INF;
        S = -1;
      }
    }
    const outer = this.cell(ii, jj);
    const G1 = H + endH - T37 * (S + endS);
    const G2 = this.H[outer] + endH - T37 * (this.S[outer] + endS);
    if (!(G1 < G2 || traceback)) return false;
    this.loopS = S;
    this.loopH = H;
    return true;
  }

  /**
   * Fill the dimer table (primer3 `fillMatrix`). Cells are final once their row is done, which the
   * loop search exploits: a bulge or internal loop through inner pair p is only accepted for cell c
   * when its ΔG at 37 °C beats c's current structure (see {@link dimerLoop}), and since the helix-end
   * term is common to both sides that requires ΔG37(p) + ΔG37(loop) < ΔG37(c). Inner pairs for which
   * even the least ΔG37 of their loop shape ({@link LOOP_G37_MIN}) fails this by more than
   * {@link PRUNE_TOLERANCE} are skipped without evaluating the loop. The skipped loops could never be
   * accepted, so the table, and every result, is exactly primer3's; only the work shrinks (several-fold
   * for long, low-complexity partners).
   */
  fillDimer(): void {
    const { H, S, stride } = this;
    /** ΔG37 (cal/mol) of every finished cell; +∞ when the cell holds no structure. */
    const g37 = new Float64Array(H.length).fill(INF);
    for (let i = 1; i <= this.len1; i++) {
      for (let j = 1; j <= this.len2; j++) {
        const c = this.cell(i, j);
        if (!isFiniteNumber(H[c])) continue;
        const [lS, lH] = this.leftEnd(i, j);
        if (isFiniteNumber(lH)) {
          S[c] = lS;
          H[c] = lH;
        }
        if (i > 1 && j > 1) {
          // the right end of (i, j) depends on the sequences only: once per cell, not per loop tried
          const [endS, endH] = this.rightEnd(i, j);
          this.dimerStack(i, j, endS, endH);
          let limit = H[c] - T37 * S[c] + PRUNE_TOLERANCE;
          // Loops of more than 30 unpaired bases have no parameters (NaN energies, never accepted).
          const lastD = Math.min(this.maxLoop, LOOP_BOUND_SIZE - 2) + 2;
          for (let d = 3; d <= lastD; d++) {
            // inner pairs (ii, jj) with (i − ii) + (j − jj) = d, walked from ii = i − 1 downwards
            let ii = i - 1;
            let jj = j - d + 1;
            if (jj < 1) {
              ii -= Math.abs(jj - 1);
              jj = 1;
            }
            for (; ii > 0 && jj < j; ii--, jj++) {
              const p = (ii - 1) * stride + jj - 1;
              if (!(g37[p] + LOOP_G37_MIN[(i - ii - 1) * LOOP_BOUND_SIZE + (j - jj - 1)] < limit)) continue;
              if (!isFiniteNumber(H[p])) continue;
              if (!this.dimerLoop(ii, jj, i, j, false, endS, endH)) continue;
              let loopS = this.loopS;
              let loopH = this.loopH;
              if (loopS < MIN_ENTROPY_CUTOFF) {
                loopS = MIN_ENTROPY;
                loopH = 0;
              }
              if (isFiniteNumber(loopH)) {
                S[c] = loopS;
                H[c] = loopH;
                limit = H[c] - T37 * S[c] + PRUNE_TOLERANCE;
              }
            }
          }
        }
        if (isFiniteNumber(H[c])) g37[c] = H[c] - T37 * S[c];
      }
    }
  }

  /** Walk back from the best pair, marking pairs (1-based partners) in ps1/ps2. */
  tracebackDimer(i: number, j: number, ps1: Int32Array, ps2: Int32Array): void {
    ps1[i - 1] = j;
    ps2[j - 1] = i;
    for (;;) {
      const [lS, lH] = this.leftEnd(i, j);
      const c = this.cell(i, j);
      if (same(this.S[c], lS) && same(this.H[c], lH)) return; // helix start
      let done = false;
      if (i > 1 && j > 1) {
        const [stS, stH] = this.stack(i - 1, j - 1, false);
        const p = this.cell(i - 1, j - 1);
        if (same(this.S[c], stS + this.S[p]) && same(this.H[c], stH + this.H[p])) {
          i--;
          j--;
          ps1[i - 1] = j;
          ps2[j - 1] = i;
          done = true;
        }
      }
      const [endS, endH] = done ? NONE() : this.rightEnd(i, j);
      for (let d = 3; !done && d <= this.maxLoop + 2; d++) {
        let ii = i - 1;
        let jj = j - d + 1;
        if (jj < 1) {
          ii -= Math.abs(jj - 1);
          jj = 1;
        }
        for (; !done && ii > 0 && jj < j; ii--, jj++) {
          this.dimerLoop(ii, jj, i, j, true, endS, endH); // always accepted during traceback
          if (same(this.S[c], this.loopS) && same(this.H[c], this.loopH)) {
            i = ii;
            j = jj;
            ps1[i - 1] = j;
            ps2[j - 1] = i;
            done = true;
          }
        }
      }
      // primer3 would loop forever here; such a state is not reachable for valid tables
      if (!done) return;
    }
  }

  // ----- hairpins ------------------------------------------------------------------------------

  initHairpin(): void {
    for (let i = 1; i <= this.len1; i++) {
      for (let j = i; j <= this.len2; j++) {
        const c = this.cell(i, j);
        if (j - i < MIN_HAIRPIN_LOOP + 1 || !pairs(this.s1[i], this.s1[j])) {
          this.H[c] = INF;
          this.S[c] = -1;
        } else {
          this.H[c] = 0;
          this.S[c] = MIN_ENTROPY;
        }
      }
    }
  }

  /** Stacking step of a hairpin stem: pair (i, j) stacked on (i+1, j−1), or kept as is. */
  private hairpinStack(i: number, j: number): void {
    const c = this.cell(i, j);
    let S0 = this.S[c];
    let H0 = this.H[c];
    const T0 = this.melting(H0, S0);
    let S1: number;
    let H1: number;
    if (isFiniteNumber(this.H[c])) {
      const q = this.cell(i + 1, j - 1);
      const [stS, stH] = this.stack(i, j, true);
      S1 = this.S[q] + stS;
      H1 = this.H[q] + stH;
    } else {
      S1 = -1;
      H1 = INF;
    }
    const T1 = this.melting(H1, S1);
    if (S1 < MIN_ENTROPY_CUTOFF) {
      S1 = MIN_ENTROPY;
      H1 = 0;
    }
    if (S0 < MIN_ENTROPY_CUTOFF) {
      S0 = MIN_ENTROPY;
      H0 = 0;
    }
    if (T1 > T0) {
      this.S[c] = S1;
      this.H[c] = H1;
    } else {
      this.S[c] = S0;
      this.H[c] = H0;
    }
  }

  /**
   * Bulge or internal loop inside a hairpin stem between outer pair (i, j) and inner pair (ii, jj)
   * (i < ii < jj < j). `mode` 0 = fill, 1 = traceback (loop energies only), 2 = traceback scan.
   */
  hairpinLoop(i: number, j: number, ii: number, jj: number, mode: 0 | 1 | 2): SH | undefined {
    const { s1, s2 } = this;
    const T = TABLES;
    const l1 = ii - i - 1;
    const l2 = j - jj - 1;
    if (l1 + l2 > this.maxLoop) return NONE();
    const size = l1 + l2 - 1;
    const addInner = mode !== 1;
    const innerC = this.cell(ii, jj);
    let S: number;
    let H: number;
    let mismatch11 = false;
    if ((l1 === 0 && l2 > 0) || (l2 === 0 && l1 > 0)) {
      if (l1 === 1 || l2 === 1) {
        const k = at4(s1[i], s1[ii], s2[j], s2[jj]);
        H = T.bulge.H[size] + T.stack.H[k];
        S = T.bulge.S[size] + T.stack.S[k];
        if (addInner) {
          H += this.H[innerC];
          S += this.S[innerC];
        }
      } else {
        H = T.bulge.H[size] + T.atH[s1[i] * B + s2[j]] + T.atH[s1[ii] * B + s2[jj]];
        if (addInner) H += this.H[innerC];
        S = T.bulge.S[size] + T.atS[s1[i] * B + s2[j]] + T.atS[s1[ii] * B + s2[jj]];
        if (addInner) S += this.S[innerC];
      }
    } else if (l1 === 1 && l2 === 1) {
      mismatch11 = true;
      const k1 = at4(s1[i], s1[i + 1], s2[j], s2[j - 1]);
      const k2 = at4(s2[jj], s2[jj + 1], s1[ii], s1[ii - 1]);
      S = T.mismatch.S[k1] + T.mismatch.S[k2];
      if (addInner) S += this.S[innerC];
      H = T.mismatch.H[k1] + T.mismatch.H[k2];
      if (addInner) H += this.H[innerC];
    } else {
      const k1 = at4(s1[i], s1[i + 1], s2[j], s2[j - 1]);
      const k2 = at4(s2[jj], s2[jj + 1], s1[ii], s1[ii - 1]);
      H = T.interior.H[size] + T.loopMismatch.H[k1] + T.loopMismatch.H[k2];
      if (addInner) H += this.H[innerC];
      S = T.interior.S[size] + T.loopMismatch.S[k1] + T.loopMismatch.S[k2] + ASYMMETRY_S * Math.abs(l1 - l2);
      if (addInner) S += this.S[innerC];
    }
    if (!isFiniteNumber(H)) {
      H = INF;
      S = -1;
    }
    const outerC = this.cell(i, j);
    const T1 = (H + this.initH) / (S + this.initS + this.rc);
    const T2 = (this.H[outerC] + this.initH) / (this.S[outerC] + this.initS + this.rc);
    // primer3 only lets a 1x1 mismatch replace the current value when it is higher by >= 1e-6 K
    if (mismatch11 && T1 - T2 < 1e-6 && mode === 0) return undefined;
    return T1 > T2 || (mode !== 0 && T1 >= T2) || mode === 1 ? [S, H] : undefined;
  }

  /** All bulges/internal loops closed by (i, j). Mode 0 updates the cell; mode 2 returns the last accepted loop. */
  private hairpinLoops(i: number, j: number, mode: 0 | 2): SH {
    let result: SH = NONE();
    const c = this.cell(i, j);
    for (let d = j - i - 3; d >= MIN_HAIRPIN_LOOP + 1 && d >= j - i - 2 - this.maxLoop; d--) {
      for (let ii = i + 1; ii < j - d && ii <= this.len1; ii++) {
        const jj = d + ii;
        if (mode === 0) result = NONE();
        if (!isFiniteNumber(this.H[this.cell(ii, jj)]) || !isFiniteNumber(this.H[c])) continue;
        const loop = this.hairpinLoop(i, j, ii, jj, mode);
        if (loop) result = loop;
        if (isFiniteNumber(result[1])) {
          if (result[0] < MIN_ENTROPY_CUTOFF) result = [MIN_ENTROPY, 0];
          if (mode === 0) {
            this.S[c] = result[0];
            this.H[c] = result[1];
          }
        }
      }
    }
    return result;
  }

  private loopKey(i: number, length: number): string {
    let key = '';
    for (let k = 0; k < length; k++) key += BASE_LETTERS[this.s1[i + k]];
    return key;
  }

  /** Hairpin loop closed by pair (i, j); during fill, keeps the current cell when that is more stable at 37 °C. */
  private hairpinClose(i: number, j: number, traceback: boolean): SH {
    const loopSize = j - i - 1;
    if (loopSize < MIN_HAIRPIN_LOOP) return NONE();
    if (i <= this.len1 && this.len2 < j) return NONE();
    if (i > this.len2) {
      i -= this.len1;
      j -= this.len2;
    }
    const { s1 } = this;
    const T = TABLES;
    const sizeIndex = Math.min(loopSize, 30) - 1;
    let H = T.hairpin.H[sizeIndex];
    let S = T.hairpin.S[sizeIndex];
    if (loopSize > 3) {
      // terminal mismatch inside loops of 4 or more
      const k = at4(s1[i], s1[i + 1], s1[j], s1[j - 1]);
      H += T.endMismatch.H[k];
      S += T.endMismatch.S[k];
    } else if (loopSize === 3) {
      H += T.atH[s1[i] * B + s1[j]];
      S += T.atS[s1[i] * B + s1[j]];
    }
    if (loopSize === 3) {
      const key = this.loopKey(i, 5);
      H += TRILOOP_DH[key] ?? 0;
      S += TRILOOP_DS[key] ?? 0;
    } else if (loopSize === 4) {
      const key = this.loopKey(i, 6);
      H += TETRALOOP_DH[key] ?? 0;
      S += TETRALOOP_DS[key] ?? 0;
    }
    if (!isFiniteNumber(H)) {
      H = INF;
      S = -1;
    }
    const c = this.cell(i, j);
    if (H > 0 && S > 0 && (!(this.H[c] > 0) || !(this.S[c] > 0))) {
      H = INF;
      S = -1;
    }
    const [endS, endH] = this.rightEnd(i, j);
    const G1 = H + endH - T37 * (S + endS);
    const G2 = this.H[c] + endH - T37 * (this.S[c] + endS);
    if (G2 < G1 && !traceback) return [this.S[c], this.H[c]];
    return [S, H];
  }

  fillHairpin(): void {
    for (let j = 2; j <= this.len2; j++) {
      for (let i = j - MIN_HAIRPIN_LOOP - 1; i >= 1; i--) {
        const c = this.cell(i, j);
        if (!isFiniteNumber(this.H[c])) continue;
        this.hairpinStack(i, j);
        this.hairpinLoops(i, j, 0);
        let close = this.hairpinClose(i, j, false);
        if (isFiniteNumber(close[1])) {
          if (close[0] < MIN_ENTROPY_CUTOFF) close = [MIN_ENTROPY, 0];
          this.S[c] = close[0];
          this.H[c] = close[1];
        }
      }
    }
  }

  /**
   * Helix that closes an exterior-loop term for the 5' prefix ending at base i, after k free bases:
   * kind 1: pair (k+1, i); 2: pair (k+2, i) with a 5' dangling base; 3: pair (k+1, i−1) with a 3'
   * dangling base; 4: pair (k+2, i−1) with a terminal mismatch. Returns the pair, its A·T penalty
   * and the dangle/mismatch term (kept apart so sums follow primer3's evaluation order).
   */
  private exteriorHelix(kind: ExteriorKind, i: number, k: number): ExteriorHelix {
    const { s1 } = this;
    const T = TABLES;
    const first = kind === 1 || kind === 3 ? k + 1 : k + 2;
    const last = kind === 1 || kind === 2 ? i : i - 1;
    let extraS = 0;
    let extraH = 0;
    if (kind === 2) {
      const d = at3(s1[i], s1[k + 2], s1[k + 1]);
      extraS = T.d5.S[d];
      extraH = T.d5.H[d];
    } else if (kind === 3) {
      const d = at3(s1[i - 1], s1[i], s1[k + 1]);
      extraS = T.d3.S[d];
      extraH = T.d3.H[d];
    } else if (kind === 4) {
      const m = at4(s1[i - 1], s1[i], s1[k + 2], s1[k + 1]);
      extraS = T.endMismatch.S[m];
      extraH = T.endMismatch.H[m];
    }
    const pair = s1[first] * B + s1[last];
    return { cell: this.cell(first, last), first, last, atS: T.atS[pair], atH: T.atH[pair], extraS, extraH };
  }

  /** Last number of free 5' bases k for which an exterior term of `kind` fits before base i. */
  private static exteriorLastK(kind: ExteriorKind, i: number): number {
    return i - MIN_HAIRPIN_LOOP - (kind === 1 ? 2 : kind === 4 ? 4 : 3);
  }

  /** Highest-Tm exterior term of `kind` for the prefix ending at base i (primer3 `END5_1`..`END5_4`). */
  private exteriorBest(kind: ExteriorKind, i: number): SH {
    let best: SH = NONE();
    let bestT = -INF;
    const unstructuredT = this.melting(0, 0);
    for (let k = 0; k <= Alignment.exteriorLastK(kind, i); k++) {
      const e = this.exteriorHelix(kind, i, k);
      const withPrefix = this.melting(this.hEnd[k], this.sEnd[k]) >= unstructuredT;
      let H = (withPrefix ? this.hEnd[k] : 0) + e.atH;
      let S = (withPrefix ? this.sEnd[k] : 0) + e.atS;
      H += e.extraH;
      S += e.extraS;
      H += this.H[e.cell];
      S += this.S[e.cell];
      if (!isFiniteNumber(H) || H > 0 || S > 0) {
        H = INF;
        S = -1;
      }
      const t = this.melting(H, S);
      if (bestT < t && S > MIN_ENTROPY_CUTOFF) {
        best = [S, H];
        bestT = t;
      }
    }
    return best;
  }

  /** Exterior loop over 5' prefixes (primer3 `calc_terminal_bp`); `temperature` in K. */
  fillExterior(temperature: number): void {
    const { hEnd, sEnd } = this;
    sEnd[0] = sEnd[1] = -1;
    hEnd[0] = hEnd[1] = INF;
    for (let i = 2; i <= this.len1; i++) {
      sEnd[i] = MIN_ENTROPY;
      hEnd[i] = 0;
    }
    for (let i = 2; i <= this.len1; i++) {
      const options: SH[] = [[sEnd[i - 1], hEnd[i - 1]]];
      for (const kind of EXTERIOR_KINDS) options.push(this.exteriorBest(kind, i));
      const t = options.map(([s, h]) => this.melting(h, s));
      const choice = largestOf5(t[0], t[1], t[2], t[3], t[4]);
      let [s, h] = options[choice];
      if (choice > 0 && !(h - temperature * s < HAIRPIN_G_THRESHOLD)) [s, h] = options[0];
      sEnd[i] = s;
      hEnd[i] = h;
    }
  }

  get exteriorEnthalpy(): number {
    return this.hEnd[this.len1];
  }

  get exteriorEntropy(): number {
    return this.sEnd[this.len1];
  }

  /** Recover the hairpin pairs (1-based partners in bp). */
  tracebackHairpin(bp: Int32Array): void {
    const { hEnd, sEnd } = this;
    const stack: [number, number, boolean][] = [[this.len1, 0, true]];
    while (stack.length > 0) {
      const [top, topJ, exterior] = stack.pop()!;
      let i = top;
      const j = topJ;
      if (exterior) {
        while (same(sEnd[i], sEnd[i - 1]) && same(hEnd[i], hEnd[i - 1])) i--;
        if (i === 0) continue;
        for (const kind of EXTERIOR_KINDS) {
          const [bs, bh] = this.exteriorBest(kind, i);
          if (!(same(sEnd[i], bs) && same(hEnd[i], bh))) continue;
          for (let k = 0; k <= Alignment.exteriorLastK(kind, i); k++) {
            const e = this.exteriorHelix(kind, i, k);
            const ts = e.atS + e.extraS + this.S[e.cell];
            const th = e.atH + e.extraH + this.H[e.cell];
            if (same(sEnd[i], ts) && same(hEnd[i], th)) {
              stack.push([e.first, e.last, false]);
              break;
            }
            if (same(sEnd[i], sEnd[k] + ts) && same(hEnd[i], hEnd[k] + th)) {
              stack.push([e.first, e.last, false]);
              stack.push([k, 0, true]);
              break;
            }
          }
          break;
        }
        continue;
      }
      bp[i - 1] = j;
      bp[j - 1] = i;
      const closed = this.hairpinClose(i, j, true);
      const loops = this.hairpinLoops(i, j, 2);
      const c = this.cell(i, j);
      const [stS, stH] = this.stack(i, j, true);
      const q = this.cell(i + 1, j - 1);
      if (same(this.S[c], stS + this.S[q]) && same(this.H[c], stH + this.H[q])) {
        stack.push([i + 1, j - 1, false]);
      } else if (same(this.S[c], closed[0]) && same(this.H[c], closed[1])) {
        // the hairpin loop closes here
      } else if (same(this.S[c], loops[0]) && same(this.H[c], loops[1])) {
        let done = false;
        for (let d = j - i - 3; !done && d >= MIN_HAIRPIN_LOOP + 1 && d >= j - i - 2 - this.maxLoop; d--) {
          for (let ii = i + 1; ii < j - d; ii++) {
            const jj = d + ii;
            const loop = this.hairpinLoop(i, j, ii, jj, 1) ?? NONE();
            const inner = this.cell(ii, jj);
            if (same(this.S[c], loop[0] + this.S[inner]) && same(this.H[c], loop[1] + this.H[inner])) {
              stack.push([ii, jj, false]);
              done = true;
              break;
            }
          }
        }
      }
    }
  }
}

/** primer3 `max5`: index (0-based) of the largest value; ties go to the later argument. */
function largestOf5(a: number, b: number, c: number, d: number, e: number): number {
  if (a > b && a > c && a > d && a > e) return 0;
  if (b > c && b > d && b > e) return 1;
  if (c > d && c > e) return 2;
  if (d > e) return 3;
  return 4;
}

function checkLengths(a: string, b: string): void {
  if (a.length > THAL_MAX_ALIGN && b.length > THAL_MAX_ALIGN) {
    throw new RangeError(`At least one sequence must be at most ${THAL_MAX_ALIGN} nt for thermodynamic alignment`);
  }
  if (a.length > THAL_MAX_SEQ || b.length > THAL_MAX_SEQ) {
    throw new RangeError(`Sequences longer than ${THAL_MAX_SEQ} nt are not supported by thermodynamic alignment`);
  }
}

const NO_STRUCTURE = (): ThalResult => ({ found: false, tm: 0, dg: 0, dh: 0, ds: 0, pairs: [] });

/**
 * Most stable dimer between `seq1` and `seq2` (both 5'→3', uppercase). `mode` 'any' considers
 * every alignment; 'end1' only structures in which the 3'-terminal base of `seq1` is paired
 * (primer3 THAL_END1, used for 3'-end stability). When no such structure exists (the 3' base has
 * no partner in `seq2`), 'end1' reports no structure, where primer3 reports an unrelated fallback
 * structure (see the comment in the body); otherwise results equal primer3's.
 */
export function thalDimer(seq1: string, seq2: string, conditions: ThalConditions, mode: 'any' | 'end1'): ThalResult {
  checkLengths(seq1, seq2);
  if (seq1.length === 0 || seq2.length === 0) return NO_STRUCTURE();
  const rc =
    R * Math.log(conditions.oligoNanoMolar / (isSymmetric(seq1) && isSymmetric(seq2) ? 1000000000.0 : 4000000000.0));
  const reversed2 = Array.from(seq2).reverse().join('');
  const a = new Alignment(encode(seq1), encode(reversed2), false, DUPLEX_INIT_H, DUPLEX_INIT_S, rc, conditions.maxLoop);
  a.initDimer();
  a.fillDimer();

  let bestI = 0;
  let bestJ = 0;
  let bestG = INF;
  const consider = (i: number, j: number) => {
    const [endS, endH] = a.rightEnd(i, j);
    const c = a.cell(i, j);
    // primer3 adds 1e-6 to both terms here (an optimizer workaround), which can matter for ties
    const g = a.H[c] + (endH + 1e-6) + DUPLEX_INIT_H - T37 * (a.S[c] + (endS + 1e-6) + DUPLEX_INIT_S);
    if (g < bestG) {
      bestG = g;
      bestI = i;
      bestJ = j;
    }
  };
  if (mode === 'any') {
    for (let i = 1; i <= a.len1; i++) for (let j = 1; j <= a.len2; j++) consider(i, j);
  } else {
    bestI = a.len1;
    for (let j = 1; j <= a.len2; j++) consider(a.len1, j);
  }
  // No alignment ends in a pair here: in 'end1' mode, seq1's 3'-terminal base has no Watson–Crick
  // partner in seq2 (or is not A/C/G/T). primer3 then falls back to the cell (1, 1) and reports
  // seq1's 5'-terminal base paired with seq2's 3'-terminal base as the "3'-end" structure (found
  // whenever those two pair; e.g. calc_end_stability('GGGGGCCCCCA', 'GGGGGCCCCC') gives
  // tm = -277.9 °C, dg = +1968 cal/mol), which does not satisfy the mode's definition.
  // HHereditas reports no structure instead. In 'any' mode no cell is finite at all, so primer3
  // reports no structure too and the results agree.
  if (!isFiniteNumber(bestG)) return NO_STRUCTURE();
  const best = a.cell(bestI, bestJ);
  if (!isFiniteNumber(a.H[best])) return NO_STRUCTURE();
  const [endS, endH] = a.rightEnd(bestI, bestJ);
  const dH = a.H[best] + endH + DUPLEX_INIT_H;
  const dS = a.S[best] + endS + DUPLEX_INIT_S;

  const ps1 = new Int32Array(a.len1);
  const ps2 = new Int32Array(a.len2);
  a.tracebackDimer(bestI, bestJ, ps1, ps2);
  let paired = 0;
  for (const p of ps1) if (p > 0) paired++;
  for (const p of ps2) if (p > 0) paired++;
  const n = Math.trunc(paired / 2) - 1;
  const salt = saltCorrection(conditions);
  const tm = dH / (dS + n * salt + rc) - KELVIN;
  const pairList: [number, number][] = [];
  ps1.forEach((j, i) => {
    if (j > 0) pairList.push([i, a.len2 - j]); // j indexes reversed seq2 (1-based)
  });
  return {
    found: true,
    tm,
    dg: dH - conditions.temperatureKelvin * (dS + n * salt),
    dh: dH,
    ds: dS + n * salt,
    pairs: pairList,
  };
}

/** Most stable hairpin of `seq` (5'→3', uppercase). */
export function thalHairpin(seq: string, conditions: ThalConditions): ThalResult {
  checkLengths(seq, seq);
  if (seq.length === 0) return NO_STRUCTURE();
  const codes = encode(seq);
  const a = new Alignment(codes, codes, true, 0, -TINY, 0, conditions.maxLoop);
  a.initHairpin();
  a.fillHairpin();
  a.fillExterior(conditions.temperatureKelvin);
  const mh = a.exteriorEnthalpy;
  const ms = a.exteriorEntropy;
  if (!isFiniteNumber(mh) || !isFiniteNumber(ms)) return NO_STRUCTURE();
  const bp = new Int32Array(a.len1);
  a.tracebackHairpin(bp);
  let paired = 0;
  for (let i = 1; i < a.len1; i++) if (bp[i - 1] > 0) paired++; // primer3 skips the last base here
  const salt = (Math.trunc(paired / 2) - 1) * saltCorrection(conditions);
  const pairList: [number, number][] = [];
  bp.forEach((j, i) => {
    if (j > 0 && i < j - 1) pairList.push([i, j - 1]);
  });
  return {
    found: true,
    tm: mh / (ms + salt) - KELVIN,
    dg: mh - conditions.temperatureKelvin * (ms + salt),
    dh: mh,
    ds: ms + salt,
    pairs: pairList,
  };
}
