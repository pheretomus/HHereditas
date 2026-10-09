/**
 * Result shape shared by every cloning simulation, plus small internal helpers.
 *
 * Every simulation returns a {@link CloningOutcome}: it never throws for user-level problems
 * (no binding site, incompatible ends, missing overlap, ...); it reports them in `error` and
 * `warnings` instead. Programming errors (an invalid enzyme definition, a malformed record)
 * may still throw.
 */
import type { DnaEnd, FragmentEnds, SeqRecord } from '../types';

/**
 * Common result of a cloning simulation.
 *
 *  - `products`: every product, best / most likely first (each operation documents its order).
 *    Empty when the simulation failed.
 *  - `product`: `products[0]`, for the common single-product case; absent when there is none.
 *  - `warnings`: human-readable notes that do not prevent a product (ambiguities, risks).
 *  - `error`: set exactly when no product could be made; a human-readable reason.
 */
export interface CloningOutcome {
  product?: SeqRecord;
  products: SeqRecord[];
  warnings: string[];
  error?: string;
}

/** Build an outcome from products and warnings (product = products[0]). */
export function outcome<T extends object>(products: SeqRecord[], warnings: string[], extra: T): CloningOutcome & T {
  const out = { ...extra, products, warnings } as CloningOutcome & T;
  if (products.length > 0) out.product = products[0];
  return out;
}

/** A failed outcome. */
export function failure<T extends object>(error: string, warnings: string[], extra: T): CloningOutcome & T {
  return { ...extra, products: [], warnings, error } as CloningOutcome & T;
}

/** Number of single-stranded bases of an end (0 for blunt). */
export function overhangBases(e: DnaEnd | undefined): number {
  return e === undefined || e.kind === 'blunt' ? 0 : Math.max(0, e.length);
}

/** Ends of a record in canonical form (absent ends = blunt/blunt). Circular records count as blunt. */
export function recordEnds(rec: SeqRecord): FragmentEnds {
  const blunt: DnaEnd = { kind: 'blunt', length: 0 };
  if (rec.topology === 'circular' || rec.ends === undefined) return { left: { ...blunt }, right: { ...blunt } };
  const norm = (e: DnaEnd): DnaEnd => (overhangBases(e) === 0 ? { ...blunt } : { kind: e.kind, length: e.length });
  return { left: norm(rec.ends.left), right: norm(rec.ends.right) };
}

/** Text of the single-stranded bases at the left end (top-strand letters; '' for blunt). */
export function leftOverhang(rec: SeqRecord): string {
  return rec.seq.slice(0, overhangBases(recordEnds(rec).left));
}

/** Text of the single-stranded bases at the right end (top-strand letters; '' for blunt). */
export function rightOverhang(rec: SeqRecord): string {
  const n = overhangBases(recordEnds(rec).right);
  return rec.seq.slice(rec.seq.length - n);
}

/** Display text of an end, e.g. "5' overhang AATT" or "blunt". */
export function describeEnd(e: DnaEnd, text: string): string {
  if (overhangBases(e) === 0) return 'blunt';
  return `${e.kind === '5prime' ? "5'" : "3'"} overhang ${text}`;
}

/** Message of an unknown thrown value. */
export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
