/**
 * Simple primer design: pick the primer length whose Tm is closest to a target.
 *
 * A primer starts (5' end) at a gap position of the template and extends either rightwards
 * (direction 1, forward primer = top strand) or leftwards (direction -1, reverse primer = reverse
 * complement of the top strand). Coordinates follow `types.ts`: gap positions in [0, L], 0-based
 * half-open top-strand ranges, ranges across the origin of a circular template have end > L.
 *
 * Templates are read as stored in a SeqRecord (upper-case IUPAC). U (RNA records keep it) is read as
 * T and ASCII lower case as upper case, so a designed primer is always DNA: A, C, G, T, plus any
 * ambiguity codes it had to take from the template.
 */
import type { Range, Topology } from '../types';
import { IUPAC_DNA, complementBase, reverseComplement } from '../seq/alphabet';
import { mod, normalizeRange, sliceRange } from '../seq/range';
import { canonicalTemplate, describeCharacter } from './normalize';
import { oligoGcContent, resolveTmConditions, tmResolved, type TmConditions } from './tm';

/** Length and Tm constraints shared by {@link designPrimer} and {@link designPrimerPair}. */
export interface PrimerDesignOptions {
  /** Desired Tm in °C (default 60). */
  targetTm?: number;
  /** Shortest primer considered, nt (default 18, at least 2). */
  minLength?: number;
  /** Longest primer considered, nt (default 30, at most {@link MAX_DESIGN_PRIMER_LENGTH}). */
  maxLength?: number;
  /** Reaction conditions for the Tm (default `DEFAULT_TM_CONDITIONS`, primer3's). */
  conditions?: Partial<TmConditions>;
}

/** Options of {@link designPrimer}. */
export interface SinglePrimerDesignOptions extends PrimerDesignOptions {
  /** Gap position (0..L) where the primer's 5' end sits. Circular templates take it modulo L. */
  position: number;
  /** 1: the primer covers the bases right of `position` (top strand); -1: the bases left of it (reverse complement). */
  direction: 1 | -1;
}

/** A designed primer. */
export interface DesignedPrimer {
  /** Primer sequence 5'→3'. */
  sequence: string;
  /** Template region the primer covers (top-strand coordinates, normalized; may wrap the origin of a circular template). */
  range: Range;
  /** 1 = forward (sequence equals the top strand of `range`), -1 = reverse (sequence is its reverse complement). */
  direction: 1 | -1;
  /** Tm in °C under the design conditions. */
  tm: number;
  /** GC fraction, 0..1. */
  gc: number;
  /** Primer length in nucleotides. */
  length: number;
  /** True when the 3'-terminal base is G or C. */
  gcClamp: boolean;
  /**
   * Non-fatal issues, for display: the Tm is more than 2.5 °C from the target (naming the lengths
   * that were considered and what limited them), or the primer contains template ambiguity codes.
   */
  warnings: string[];
}

/** A primer pair amplifying a target region. */
export interface DesignedPrimerPair {
  /** Forward primer (direction 1); its 5' end is at `target.start`. */
  forward: DesignedPrimer;
  /** Reverse primer (direction -1); its 5' end is at `target.end`. */
  reverse: DesignedPrimer;
  /** Length of the PCR product in bp (= length of the target). */
  productLength: number;
}

/** Defaults of the design options. */
export const DEFAULT_PRIMER_DESIGN = Object.freeze({ targetTm: 60, minLength: 18, maxLength: 30 });

/**
 * Largest accepted `maxLength`, in nucleotides. Every length up to `maxLength` is evaluated in full,
 * so the work grows with maxLength²; this bound keeps a design within milliseconds. It lies far above
 * any chemically synthesised primer (primer3 itself never picks primers longer than 36 nt:
 * MAX_PRIMER_LENGTH in libprimer3 2.6.1 libprimer3.c).
 */
export const MAX_DESIGN_PRIMER_LENGTH = 1000;

/** A G/C clamp is preferred when it moves the Tm at most this many °C further from the target. */
const GC_CLAMP_TOLERANCE = 1;
/** Acceptable distance (°C) from the target Tm: designs stay inside it when any length allows; outside it they carry a warning. */
const TM_WINDOW = 2.5;

interface Candidate {
  sequence: string;
  length: number;
  tm: number;
  gcClamp: boolean;
}

function checkLengths(minLength: number, maxLength: number, targetTm: number): void {
  if (!Number.isInteger(minLength) || minLength < 2) throw new RangeError(`minLength must be an integer >= 2 (got ${minLength})`);
  if (!Number.isInteger(maxLength) || maxLength < minLength) {
    throw new RangeError(`maxLength must be an integer >= minLength (got ${maxLength})`);
  }
  if (maxLength > MAX_DESIGN_PRIMER_LENGTH) {
    throw new RangeError(`maxLength must be at most ${MAX_DESIGN_PRIMER_LENGTH} nt (got ${maxLength})`);
  }
  if (!Number.isFinite(targetTm)) throw new RangeError(`targetTm must be finite (got ${targetTm})`);
}

/** Top-strand range covered by the primer of `length` nt whose 5' end is at gap `position` (normalized). */
function primerRange(position: number, direction: 1 | -1, length: number, L: number, topology: Topology): Range {
  const start = direction === 1 ? position : position - length;
  return topology === 'circular' ? normalizeRange({ start, end: start + length }, L, topology) : { start, end: start + length };
}

/** "18–20 nt", or "18 nt" for a single length. */
function lengthSpan(from: number, to: number): string {
  return from === to ? `${from} nt` : `${from}–${to} nt`;
}

/**
 * Design one primer whose 5' end sits at gap `position` (see {@link SinglePrimerDesignOptions}).
 *
 * Every length from `minLength` to `maxLength` that fits the template is evaluated; the length whose
 * Tm is closest to `targetTm` wins (shorter on ties). A primer ending in G or C (3' G/C clamp) is
 * preferred instead when its Tm is at most 1 °C further from the target, unless that would move
 * the design out of the ±2.5 °C window while the closest length is inside it: whenever some length
 * comes within 2.5 °C of the target, so does the design. Lengths that would include IUPAC
 * ambiguity codes of the template are avoided when an unambiguous primer is possible (a longer
 * primer contains every base of a shorter one, so those are the lengths beyond the first code).
 * Linear templates limit the length to the bases available beyond `position`; circular ones wrap
 * through the origin (at most L bases). U in the template is read as T (see the module docs).
 *
 * Throws a RangeError for invalid options (including `maxLength` above
 * {@link MAX_DESIGN_PRIMER_LENGTH}), a position outside [0, L] on a linear template, fewer than
 * `minLength` available bases, or a template character that is not an IUPAC code among the bases
 * the design examines (`maxLength` bases from `position`).
 */
export function designPrimer(template: string, topology: Topology, opts: SinglePrimerDesignOptions): DesignedPrimer {
  const targetTm = opts.targetTm ?? DEFAULT_PRIMER_DESIGN.targetTm;
  const minLength = opts.minLength ?? DEFAULT_PRIMER_DESIGN.minLength;
  const maxLength = opts.maxLength ?? DEFAULT_PRIMER_DESIGN.maxLength;
  checkLengths(minLength, maxLength, targetTm);
  const direction = opts.direction;
  if (direction !== 1 && direction !== -1) throw new RangeError(`direction must be 1 or -1 (got ${String(direction)})`);
  const conditions = resolveTmConditions(opts.conditions);
  const L = template.length;
  const circular = topology === 'circular';
  if (!Number.isInteger(opts.position)) throw new RangeError(`position must be an integer (got ${opts.position})`);
  if (!circular && (opts.position < 0 || opts.position > L)) {
    throw new RangeError(`position ${opts.position} is outside the linear template [0, ${L}]`);
  }
  const position = circular && L > 0 ? mod(opts.position, L) : opts.position;
  const available = circular ? L : direction === 1 ? L - position : position;
  const longest = Math.min(maxLength, available);
  if (longest < minLength) {
    throw new RangeError(
      `Only ${available} template bases are available ${direction === 1 ? 'right' : 'left'} of position ${opts.position}; ` +
        `a primer needs at least ${minLength}`,
    );
  }

  // The longest candidate, 5'→3'; every shorter candidate is a prefix of it (same 5' end).
  const top = canonicalTemplate(sliceRange(template, primerRange(position, direction, longest, L, topology)));
  const bases = direction === 1 ? top : reverseComplement(top);
  /** Template index of the k-th primer base (0 = 5' end). */
  const templateIndex = (k: number): number => {
    const i = direction === 1 ? position + k : position - 1 - k;
    return circular ? mod(i, L) : i;
  };
  let firstAmbiguous = -1;
  for (let k = 0; k < longest; k++) {
    const set = IUPAC_DNA[bases[k]];
    if (set === undefined) {
      const index = templateIndex(k);
      throw new RangeError(
        `Template character ${describeCharacter(template, index)} at index ${index} (base ${index + 1}) is not an IUPAC nucleotide code`,
      );
    }
    if (firstAmbiguous < 0 && set.length > 1) firstAmbiguous = k;
  }
  // Lengths up to firstAmbiguous are unambiguous; use only those when there are any.
  const unambiguousLongest = firstAmbiguous < 0 ? longest : Math.min(longest, firstAmbiguous);
  const ambiguous = unambiguousLongest < minLength;
  const poolLongest = ambiguous ? longest : unambiguousLongest;
  const candidates: Candidate[] = [];
  for (let length = minLength; length <= poolLongest; length++) {
    const sequence = bases.slice(0, length);
    const last = sequence[length - 1];
    candidates.push({ sequence, length, tm: tmResolved(sequence, conditions), gcClamp: last === 'G' || last === 'C' });
  }

  const distance = (c: Candidate) => Math.abs(c.tm - targetTm);
  const closest = (list: Candidate[]) => list.reduce((best, c) => (distance(c) < distance(best) ? c : best));
  const best = closest(candidates);
  let chosen = best;
  const clamped = candidates.filter((c) => c.gcClamp);
  if (!best.gcClamp && clamped.length > 0) {
    const bestClamped = closest(clamped);
    const affordable = distance(bestClamped) <= distance(best) + GC_CLAMP_TOLERANCE;
    const keepsWindow = distance(bestClamped) <= TM_WINDOW || distance(best) > TM_WINDOW;
    if (affordable && keepsWindow) chosen = bestClamped;
  }

  const warnings: string[] = [];
  /** The template's own code at the first ambiguous primer base, and where it is. */
  const ambiguityPlace = () => {
    const index = templateIndex(firstAmbiguous);
    const code = direction === 1 ? bases[firstAmbiguous] : complementBase(bases[firstAmbiguous]);
    return `'${code}' at template index ${index} (base ${index + 1})`;
  };
  if (ambiguous) {
    warnings.push(
      `The primer contains IUPAC ambiguity codes from the template, starting with ${ambiguityPlace()}; ` +
        'its Tm is the mean over their expansions.',
    );
  }
  if (distance(chosen) > TM_WINDOW) {
    let text =
      `Tm ${chosen.tm.toFixed(1)} °C is ${distance(chosen).toFixed(1)} °C from the target ${targetTm} °C: ` +
      `no primer of ${lengthSpan(minLength, poolLongest)} at this position comes within ${TM_WINDOW} °C`;
    if (chosen !== best) text += ` (the closest, ${best.length} nt at ${best.tm.toFixed(1)} °C, has no 3' G/C clamp)`;
    text += '.';
    if (poolLongest < longest) {
      text += ` Longer primers were not considered because they would include the IUPAC code ${ambiguityPlace()}.`;
    } else if (longest < maxLength) {
      text += circular
        ? ` Longer primers would wrap around the whole ${L} bp circle.`
        : ` Longer primers would run past the ${direction === 1 ? 'end' : 'start'} of the linear template.`;
    }
    warnings.push(text);
  }
  return {
    sequence: chosen.sequence,
    range: primerRange(position, direction, chosen.length, L, topology),
    direction,
    tm: chosen.tm,
    gc: oligoGcContent(chosen.sequence),
    length: chosen.length,
    gcClamp: chosen.gcClamp,
    warnings,
  };
}

/**
 * Design a forward and a reverse primer that amplify exactly `target` (top-strand range; may wrap
 * the origin of a circular template): the forward primer's 5' end sits at `target.start`, the
 * reverse primer's 5' end at `target.end`, and both lie inside the target, so the PCR product is
 * the target itself (`productLength` = target length). Each primer is chosen by
 * {@link designPrimer} with the same options (its length is also capped at the target length).
 * Throws a RangeError when the target is invalid for the template or shorter than `minLength`.
 */
export function designPrimerPair(
  template: string,
  topology: Topology,
  target: Range,
  opts: PrimerDesignOptions = {},
): DesignedPrimerPair {
  const L = template.length;
  const minLength = opts.minLength ?? DEFAULT_PRIMER_DESIGN.minLength;
  const maxLength = opts.maxLength ?? DEFAULT_PRIMER_DESIGN.maxLength;
  checkLengths(minLength, maxLength, opts.targetTm ?? DEFAULT_PRIMER_DESIGN.targetTm);
  if (!Number.isInteger(target.start) || !Number.isInteger(target.end)) throw new RangeError('target must have integer bounds');
  let range: Range;
  if (topology === 'circular') {
    if (L === 0) throw new RangeError('empty template');
    range = normalizeRange(target, L, topology);
  } else {
    if (target.start < 0 || target.end > L || target.end <= target.start) {
      throw new RangeError(`target ${target.start}..${target.end} is not a non-empty range of the linear template [0, ${L}]`);
    }
    range = { start: target.start, end: target.end };
  }
  const productLength = range.end - range.start;
  if (productLength < minLength) {
    throw new RangeError(`target is ${productLength} bp; each primer needs at least ${minLength} nt inside it`);
  }
  const inner = { ...opts, maxLength: Math.min(maxLength, productLength) };
  const forward = designPrimer(template, topology, { ...inner, position: range.start, direction: 1 });
  const reverse = designPrimer(template, topology, { ...inner, position: range.end, direction: -1 });
  return { forward, reverse, productLength };
}
