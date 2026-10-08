/**
 * Exact lowest and highest melting temperature over the expansions of a degenerate (IUPAC) oligo,
 * for the nearest-neighbour Tm model of `tm.ts`, without enumerating the expansions.
 *
 * Why this is exact:
 *  - For one symmetry class (self-complementary expansions, which use the symmetry correction and
 *    the C_T/1 concentration term, or the others) and one G+C count, every Tm formula of `tm.ts` is
 *    an increasing function of ρ = ΔH°/(ΔS° + K), where ΔH° and ΔS° are sums over the
 *    nearest-neighbour terms of the expansion and K is a constant (see `NnTmModel`).
 *  - The expansion with the largest (smallest) ratio of two additive costs is found exactly by
 *    Dinkelbach's method (W. Dinkelbach 1967, "On nonlinear fractional programming", Management
 *    Science 13:492–498): with ρ = A/B (A = −ΔH° > 0, B = −(ΔS° + K) > 0), solve
 *    max (min) Σ(A − λ·B) for λ = ρ of the current expansion, move to the solution, and stop when ρ no
 *    longer improves. ρ improves strictly at every step and there are finitely many expansions, so
 *    the search ends at the optimum, in practice after a few steps. Each linear problem is a dynamic
 *    programme over the positions (32 states per step, or 32·(n + 1) when G+C is tracked); even a
 *    60-mer of N (10^36 expansions) takes milliseconds.
 *  - The dynamic programme reads the oligo from both ends at once: step k chooses the bases at k and
 *    at n − 1 − k and remembers whether every pair seen so far is complementary. This keeps
 *    self-complementary expansions apart from the others, as `tm.ts` treats them differently.
 *  - When the Tm also depends on the G+C count g (Owczarzy salt corrections, formamide), one
 *    programme that also tracks g bounds ρ for every g at once: with λ the class optimum and f_g the
 *    best A − λB over the expansions with g G/C bases, each of them has ρ = λ + (A − λB)/B
 *    ≤ λ + f_g/B (for the minimum: ≥), where B lies between its class minimum and maximum. Only the
 *    G+C counts whose bound could beat the best expansion found get their own exact search.
 *
 * Coordinates: positions are 0-based indices of the oligo 5'→3'. Temperatures are in °C, ρ in kelvin.
 */

/** Base codes used throughout: A = 0, C = 1, G = 2, T = 3; the complement of b is 3 − b. */
const BASES = 'ACGT';
const GC_OF: readonly number[] = [0, 1, 1, 0];

/** Pruning tolerance in °C: a G+C count is skipped when its bound cannot beat the best Tm by more. */
const TM_TOLERANCE = 1e-9;
/** Safety limit; Dinkelbach's method converges in a handful of steps. */
const MAX_DINKELBACH_STEPS = 200;

/**
 * The nearest-neighbour Tm model of one set of conditions and one oligo length, as `tm.ts`
 * evaluates it. Energies in the tables are integer tenths (0.1 kcal/mol, 0.1 cal/(K·mol)).
 */
export interface NnTmModel {
  /** ΔH° of each Watson–Crick stack, index 4·first + second (top strand 5'→3', base codes A C G T = 0..3). */
  readonly stackH10: Int32Array;
  /** ΔS° of each stack, same index. */
  readonly stackS10: Int32Array;
  /** Initiation ΔH° per terminal base code (applied at both ends). */
  readonly initH10: Int32Array;
  /** Initiation ΔS° per terminal base code. */
  readonly initS10: Int32Array;
  /** Symmetry correction ΔS° of self-complementary duplexes. */
  readonly symmetryS10: number;
  /** ΔH° (cal/mol) and ΔS° (cal/(K·mol), symmetry included) of an unambiguous sequence, exactly as the Tm uses them. */
  sums(seq: string): { dHcal: number; dS: number; symmetric: boolean };
  /** ΔS° + K: the Tm denominator for ΔS° = `dS` (cal/(K·mol)); increasing in dS. */
  denominator(dS: number, symmetric: boolean): number;
  /** Tm (°C) from ρ = ΔH°/(ΔS° + K) in kelvin and the G+C count; increasing in ρ. */
  tmFromRatio(rho: number, gc: number): number;
  /** Tm (°C) of an unambiguous sequence. */
  tm(seq: string): number;
  /** Whether `tmFromRatio` depends on the G+C count. */
  readonly gcDependent: boolean;
}

/** An unambiguous expansion and its melting temperature. */
export interface TmExtreme {
  /** The expansion, 5'→3', A/C/G/T only. */
  sequence: string;
  /** Its Tm in °C. */
  tm: number;
}

interface Problem {
  /** Allowed base codes per position. */
  options: readonly Uint8Array[];
  model: NnTmModel;
}

/** Best values of one linear objective for each final G+C count, and the expansions reaching them. */
interface Solution {
  /** Best objective per final G+C count (a single entry when G+C is not tracked); NaN = no expansion. */
  values: Float64Array;
  /** Base codes of the expansion reaching `values[index]`. */
  codes(index: number): Uint8Array;
}

/**
 * Dynamic programme for max (or min) of wH·ΣΔH°₁₀ + wS·ΣΔS°₁₀ over the expansions of one class:
 * self-complementary ones (`palindromes`) or the others. With `trackGc`, the optimum is kept
 * separately for every final G+C count. State after step k: the bases at k and n − 1 − k, whether
 * all pairs so far are complementary, and (optionally) the G+C count so far.
 */
function solve(p: Problem, wH: number, wS: number, maximize: boolean, palindromes: boolean, trackGc: boolean): Solution {
  const { options, model } = p;
  const n = options.length;
  const m = n >> 1;
  const odd = (n & 1) === 1;
  const G = trackGc ? n + 1 : 1;
  const size = 32 * G;
  const SH = model.stackH10;
  const SS = model.stackS10;
  const better = (v: number, old: number) => Number.isNaN(old) || (maximize ? v > old : v < old);
  const index = (x: number, y: number, mismatch: number, g: number) => ((((x << 2) | y) << 1) | mismatch) * G + g;

  // Step 0: the two terminal bases, with their initiation terms.
  let current = new Float64Array(size).fill(NaN);
  for (const x of options[0]) {
    for (const y of options[n - 1]) {
      const v = wH * (model.initH10[x] + model.initH10[y]) + wS * (model.initS10[x] + model.initS10[y]);
      const i = index(x, y, y === 3 - x ? 0 : 1, trackGc ? GC_OF[x] + GC_OF[y] : 0);
      if (better(v, current[i])) current[i] = v;
    }
  }
  // Steps 1..m−1: bases k and n−1−k, with the stacks they form towards the ends already chosen.
  const back: Int32Array[] = [];
  for (let k = 1; k < m; k++) {
    const next = new Float64Array(size).fill(NaN);
    const from = new Int32Array(size).fill(-1);
    for (let i = 0; i < size; i++) {
      const v0 = current[i];
      if (Number.isNaN(v0)) continue;
      const g0 = i % G;
      const rest = (i - g0) / G;
      const mismatch0 = rest & 1;
      const x0 = rest >> 3;
      const y0 = (rest >> 1) & 3;
      for (const x of options[k]) {
        const left = x0 * 4 + x; // stack (k−1, k)
        for (const y of options[n - 1 - k]) {
          const right = y * 4 + y0; // stack (n−1−k, n−k)
          const v = v0 + wH * (SH[left] + SH[right]) + wS * (SS[left] + SS[right]);
          const j = index(x, y, mismatch0 | (y === 3 - x ? 0 : 1), trackGc ? g0 + GC_OF[x] + GC_OF[y] : 0);
          if (better(v, next[j])) {
            next[j] = v;
            from[j] = i;
          }
        }
      }
    }
    back.push(from);
    current = next;
  }
  // Close the chain: the centre stack (even n) or the centre base and its two stacks (odd n).
  const values = new Float64Array(G).fill(NaN);
  const finalState = new Int32Array(G).fill(-1);
  const finalCentre = new Int8Array(G).fill(-1);
  for (let i = 0; i < size; i++) {
    const v0 = current[i];
    if (Number.isNaN(v0)) continue;
    const g0 = i % G;
    const rest = (i - g0) / G;
    const mismatch = rest & 1;
    const x = rest >> 3;
    const y = (rest >> 1) & 3;
    if (!odd) {
      if (palindromes ? mismatch !== 0 : mismatch !== 1) continue;
      const centre = x * 4 + y;
      const v = v0 + wH * SH[centre] + wS * (SS[centre] + (palindromes ? model.symmetryS10 : 0));
      if (better(v, values[g0])) {
        values[g0] = v;
        finalState[g0] = i;
      }
    } else {
      if (palindromes) continue; // odd lengths are never self-complementary
      for (const z of options[m]) {
        const v = v0 + wH * (SH[x * 4 + z] + SH[z * 4 + y]) + wS * (SS[x * 4 + z] + SS[z * 4 + y]);
        const g = trackGc ? g0 + GC_OF[z] : 0;
        if (better(v, values[g])) {
          values[g] = v;
          finalState[g] = i;
          finalCentre[g] = z;
        }
      }
    }
  }
  return {
    values,
    codes(slot: number): Uint8Array {
      const out = new Uint8Array(n);
      if (odd) out[m] = finalCentre[slot];
      let i = finalState[slot];
      for (let k = m - 1; k >= 0; k--) {
        const rest = (i - (i % G)) / G;
        out[k] = rest >> 3;
        out[n - 1 - k] = (rest >> 1) & 3;
        if (k > 0) i = back[k - 1][i];
      }
      return out;
    },
  };
}

/** An expansion with its ratio ρ = A/B (A = −ΔH°, B = −(ΔS° + K)). */
interface Evaluated {
  sequence: string;
  gc: number;
  a: number;
  b: number;
  rho: number;
}

function evaluate(p: Problem, codes: Uint8Array): Evaluated {
  let sequence = '';
  let gc = 0;
  for (const c of codes) {
    sequence += BASES[c];
    gc += GC_OF[c];
  }
  const { dHcal, dS, symmetric } = p.model.sums(sequence);
  const denominator = p.model.denominator(dS, symmetric);
  return { sequence, gc, a: -dHcal, b: -denominator, rho: dHcal / denominator };
}

/**
 * Dinkelbach's method: the expansion of one class (and, when `gc` >= 0, one G+C count) with the
 * largest or smallest ρ, starting from `start` (an expansion of that class and count) if given.
 * Returns null when the class has no expansion with that count.
 */
function extremeRatio(p: Problem, maximize: boolean, palindromes: boolean, gc: number, start?: Evaluated): Evaluated | null {
  const trackGc = gc >= 0;
  const slot = trackGc ? gc : 0;
  let best = start;
  if (best === undefined) {
    const first = solve(p, -100, 0, maximize, palindromes, trackGc); // most (least) negative ΔH°
    if (Number.isNaN(first.values[slot])) return null;
    best = evaluate(p, first.codes(slot));
  }
  for (let step = 0; step < MAX_DINKELBACH_STEPS; step++) {
    const lambda = best.rho;
    // A − λB = −100·ΣΔH°₁₀ + 0.1·λ·ΣΔS°₁₀ + λ·(K + symmetry): the constant does not change the optimum.
    const candidate = evaluate(p, solve(p, -100, 0.1 * lambda, maximize, palindromes, trackGc).codes(slot));
    if (maximize ? !(candidate.rho > lambda) : !(candidate.rho < lambda)) return best;
    best = candidate;
  }
  throw new Error('tmExtremes: fractional programming did not converge');
}

/** The smallest and largest B = −(ΔS° + K) over a class, or null when the class is empty. */
function denominatorBounds(p: Problem, palindromes: boolean): { min: number; max: number } | null {
  const largestS = solve(p, 0, 1, true, palindromes, false);
  if (Number.isNaN(largestS.values[0])) return null;
  const smallestS = solve(p, 0, 1, false, palindromes, false);
  const bMin = evaluate(p, largestS.codes(0)).b;
  const bMax = evaluate(p, smallestS.codes(0)).b;
  if (!(bMin > 0)) {
    throw new RangeError(
      'Tm is undefined for some expansions under these conditions (ΔS° + R·ln(C/x) is not negative): check the concentrations',
    );
  }
  return { min: bMin, max: bMax };
}

/** The extreme-Tm expansion of one class. */
function extremeInClass(p: Problem, maximize: boolean, palindromes: boolean, b: { min: number; max: number }): TmExtreme {
  const { model } = p;
  const star = extremeRatio(p, maximize, palindromes, -1);
  if (star === null) throw new Error('tmExtremes: empty class'); // excluded by denominatorBounds
  let best: TmExtreme = { sequence: star.sequence, tm: model.tm(star.sequence) };
  if (!model.gcDependent) return best;

  const beats = (t: number, margin: number) => (maximize ? t > best.tm + margin : t < best.tm - margin);
  // One programme over (expansion, G+C count) at λ = ρ*: for each count g, its optimum f_g bounds ρ of
  // every expansion with that count, ρ = λ + (A − λB)/B ≤ λ + f_g/B (max; ≥ for min).
  const lambda = star.rho;
  const atStar = solve(p, -100, 0.1 * lambda, maximize, palindromes, true);
  const counts: { gc: number; start: Evaluated; bound: number }[] = [];
  for (let gc = 0; gc < atStar.values.length; gc++) {
    if (Number.isNaN(atStar.values[gc])) continue;
    const q = evaluate(p, atStar.codes(gc));
    const t = model.tm(q.sequence);
    if (beats(t, 0)) best = { sequence: q.sequence, tm: t };
    const f = q.a - lambda * q.b;
    const rhoBound = maximize ? lambda + f / (f > 0 ? b.min : b.max) : lambda + f / (f < 0 ? b.min : b.max);
    counts.push({ gc, start: q, bound: model.tmFromRatio(rhoBound, gc) });
  }
  counts.sort((x, y) => (maximize ? y.bound - x.bound : x.bound - y.bound));
  for (const c of counts) {
    if (!beats(c.bound, TM_TOLERANCE)) break; // sorted: no later count can beat the best either
    const e = extremeRatio(p, maximize, palindromes, c.gc, c.start);
    if (e === null) continue;
    const t = model.tm(e.sequence);
    if (beats(t, 0)) best = { sequence: e.sequence, tm: t };
  }
  return best;
}

/**
 * Expansions with the lowest and highest Tm among all expansions of a degenerate oligo of length
 * n >= 2, given as the allowed base codes of each position (A C G T = 0..3), under `model`.
 * Exact up to a tolerance of 1e-9 °C (see the module documentation); ties go to the first expansion
 * found. Throws a RangeError when the conditions make the Tm undefined for some expansion.
 */
export function nnTmExtremes(options: readonly Uint8Array[], model: NnTmModel): { min: TmExtreme; max: TmExtreme } {
  if (options.length < 2) throw new RangeError('nnTmExtremes needs at least 2 positions');
  const p: Problem = { options, model };
  let min: TmExtreme | undefined;
  let max: TmExtreme | undefined;
  for (const palindromes of options.length % 2 === 0 ? [false, true] : [false]) {
    const b = denominatorBounds(p, palindromes);
    if (b === null) continue;
    const high = extremeInClass(p, true, palindromes, b);
    const low = extremeInClass(p, false, palindromes, b);
    if (max === undefined || high.tm > max.tm) max = high;
    if (min === undefined || low.tm < min.tm) min = low;
  }
  if (min === undefined || max === undefined) throw new Error('nnTmExtremes: no expansion');
  return { min, max };
}
