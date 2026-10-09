/**
 * Single-stranded ends of LINEAR molecules: validation, and the rule that decides whether a
 * cleavage event can cut a linear molecule. The site search (`search.ts`) and the digest
 * (`digest.ts`) both use this file, so the enzyme map of a sticky-ended record always agrees with
 * its digest. Internal to the enzymes module (not re-exported by `index.ts`).
 *
 * Conventions (see `types.ts`): FragmentEnds describe a duplex whose `seq` spans its full extent
 * in top-strand orientation (left '5prime' n: the first n bases exist only on the top strand;
 * left '3prime' n: only on the bottom strand; right '5prime' n: the last n bases exist only on
 * the bottom strand; right '3prime' n: only on the top strand). Positions are 0-based GAP
 * positions in top-strand coordinates. An overhang of length 0 is a blunt end.
 */
import type { DnaEnd, EndKind, FragmentEnds } from '../types';

/** The end kinds of `types.ts`, in a fixed order (the digest's strand comparison relies on it). */
export const END_KINDS: readonly EndKind[] = ['blunt', '5prime', '3prime'];

/**
 * Both ends blunt: the default ends of a linear molecule. Frozen and shared, so it must never be
 * returned to callers (results always get fresh objects).
 */
export const BLUNT_ENDS: FragmentEnds = Object.freeze({
  left: Object.freeze({ kind: 'blunt', length: 0 }),
  right: Object.freeze({ kind: 'blunt', length: 0 }),
});

/** Gap positions where the top and the bottom strand begin (left end) or stop (right end). */
export interface StrandBoundary {
  top: number;
  bottom: number;
}

/**
 * The bases of a linear molecule that are base-paired: gap positions [from, to), i.e. `from` =
 * length of the left overhang and `to` = L - length of the right overhang (from < to).
 */
export interface PairedRegion {
  from: number;
  to: number;
}

/** Why a cleavage event cannot cut a linear molecule (see {@link linearEndProblem}). */
export type LinearEndProblem = 'cut' | 'site';

/**
 * Throws an Error unless `ends` are valid single-stranded ends of a linear duplex of length L:
 * known kinds, non-negative integer lengths, length 0 for blunt ends, and overhangs that leave at
 * least one base pair (left + right lengths < L).
 */
export function checkEnds(ends: FragmentEnds, L: number): void {
  for (const end of [ends.left, ends.right]) {
    if (!END_KINDS.includes(end.kind)) throw new Error(`Invalid end kind '${String(end.kind)}'`);
    if (!Number.isInteger(end.length) || end.length < 0) throw new Error(`Invalid end length ${end.length}`);
    if (end.kind === 'blunt' && end.length !== 0) throw new Error('A blunt end must have length 0');
  }
  const single = ends.left.length + ends.right.length;
  if (single > L) {
    throw new Error(`Single-stranded ends (${ends.left.length} + ${ends.right.length}) are longer than the molecule (${L})`);
  }
  if (single === L) {
    throw new Error(`Single-stranded ends (${ends.left.length} + ${ends.right.length}) leave no base pair in a molecule of ${L} bases`);
  }
}

/**
 * Where the strands of a linear molecule of length L begin ('left') or stop ('right') at one of
 * its original ends. Left 5' n: top strand from 0, bottom strand from n; left 3' n: top from n,
 * bottom from 0. Right 5' n: top strand up to L - n, bottom up to L; right 3' n: top up to L,
 * bottom up to L - n. A blunt end (or length 0) gives the same position for both strands.
 */
export function endBoundary(end: DnaEnd, side: 'left' | 'right', L: number): StrandBoundary {
  const n = end.kind === 'blunt' ? 0 : end.length;
  if (side === 'left') {
    return end.kind === '3prime' ? { top: n, bottom: 0 } : { top: 0, bottom: n };
  }
  return end.kind === '3prime' ? { top: L, bottom: L - n } : { top: L - n, bottom: L };
}

/**
 * The base-paired part of a linear molecule of length L >= 1 with these `ends`.
 * Throws (see {@link checkEnds}) if the ends are invalid or leave no base pair.
 */
export function pairedRegion(ends: FragmentEnds, L: number): PairedRegion {
  checkEnds(ends, L);
  const left = endBoundary(ends.left, 'left', L);
  const right = endBoundary(ends.right, 'right', L);
  return { from: Math.max(left.top, left.bottom), to: Math.min(right.top, right.bottom) };
}

/**
 * Whether a cleavage event can cut a linear molecule whose base pairs are `paired`: undefined if
 * it can, otherwise the reason it cannot.
 *  - 'cut': its cut zone [min(top, bottom), max(top, bottom)] does not lie inside the paired
 *    region with at least one base pair to spare on each side (each product must keep a base
 *    pair). With blunt ends this is Biopython's rule (Bio.Restriction AbstractCut._drop): both
 *    cuts in [1, L - 1]; a cut exactly at an end (gap 0 or L) cleaves nothing.
 *  - 'site': its recognition site [siteStart, siteEnd) is not fully double-stranded (it lies
 *    partly or wholly in a single-stranded overhang, where the enzyme cannot bind it).
 * `top` and `bottom` are gap positions; the site is a half-open range of bases.
 */
export function linearEndProblem(
  top: number,
  bottom: number,
  siteStart: number,
  siteEnd: number,
  paired: PairedRegion,
): LinearEndProblem | undefined {
  if (Math.min(top, bottom) <= paired.from || Math.max(top, bottom) >= paired.to) return 'cut';
  if (siteStart < paired.from || siteEnd > paired.to) return 'site';
  return undefined;
}
