/**
 * Internal helpers of the ops module: argument validation and defensive copying.
 * Not part of the public API (not re-exported from `ops/index.ts`).
 *
 * Copying policy: every record returned by an ops function shares NO mutable object
 * (feature, segment, qualifier, primer, end, meta array/map) with its inputs, so callers
 * may freely mutate results without corrupting the document they came from.
 */
import type { DnaEnd, Feature, FragmentEnds, MoleculeType, Primer, Qualifier, Range, RecordMeta, SeqRecord, Topology } from '../types';
import { normalizeDna } from '../seq/alphabet';
import { newId } from '../seq/id';

/** Throw a RangeError unless `value` is a finite integer. `what` names the argument in the message. */
export function assertInteger(value: number, what: string): void {
  if (!Number.isInteger(value)) throw new RangeError(`${what} must be an integer, got ${String(value)}`);
}

/** Throw a RangeError unless `value` is a non-negative integer (a length or count). */
export function assertCount(value: number, what: string): void {
  assertInteger(value, what);
  if (value < 0) throw new RangeError(`${what} must be >= 0, got ${value}`);
}

/**
 * `n` with negative zero replaced by +0. A caret computed as `Math.round(-0.3)` is -0, which
 * passes every integer check but would leak into output coordinates (and display as "-0").
 */
export function plusZero(n: number): number {
  return n === 0 ? 0 : n;
}

/**
 * Validate a gap position (see types.ts) for a molecule of length `seqLength`: an integer in
 * [0, seqLength] for both topologies (on circular molecules 0 and seqLength name the same gap;
 * callers decide how to treat that). Returns the gap, with -0 turned into 0.
 */
export function checkGap(gap: number, seqLength: number, op: string): number {
  assertInteger(gap, `${op}: gap`);
  if (gap < 0 || gap > seqLength) {
    throw new RangeError(`${op}: gap ${gap} is outside 0..${seqLength} (sequence length ${seqLength})`);
  }
  return plusZero(gap);
}

/**
 * Validate a range against a molecule and return it in normalized form (types.ts), with -0
 * turned into 0.
 *
 * Linear: requires 0 <= start <= end <= L.
 * Circular: requires 0 <= start < L and start <= end <= start + L; origin-crossing ranges must
 * be written with end > L. The empty range {L, L} (e.g. the empty selection at the caret after
 * the last base) is accepted and returned as {0, 0}: gaps 0 and L are the same place on a circle.
 * An empty molecule only has the empty range {0, 0}.
 * Ranges written "backwards" (end < start) and ranges longer than a circular molecule are
 * rejected rather than guessed at.
 */
export function checkRange(range: Range, seqLength: number, topology: Topology, op: string): Range {
  const { start, end } = range;
  assertInteger(start, `${op}: range.start`);
  assertInteger(end, `${op}: range.end`);
  const L = seqLength;
  const describe = () => `${op}: range {start: ${start}, end: ${end}} is invalid for a ${topology} sequence of length ${L}`;
  if (end < start) throw new RangeError(`${describe()} (end < start; origin-crossing ranges are written with end > length)`);
  if (topology === 'linear' || L === 0) {
    if (start < 0 || end > L) throw new RangeError(`${describe()} (must satisfy 0 <= start <= end <= length)`);
    return { start: plusZero(start), end: plusZero(end) };
  }
  if (start === L && end === L) return { start: 0, end: 0 };
  if (start < 0 || start >= L) {
    throw new RangeError(`${describe()} (must satisfy 0 <= start < length; origin-crossing ranges are written with end > length)`);
  }
  if (end - start > L) {
    throw new RangeError(
      `${describe()} (it is ${end - start} bases long, more than the whole circle: a range covers each base at most once, so end - start <= length)`,
    );
  }
  return { start: plusZero(start), end };
}

/**
 * True when nucleotides of a record of this molecule type and sequence are written with U
 * rather than T: RNA records whose sequence contains U or neither T nor U. RNA records written
 * with T and no U (as GenBank RNA records usually are) keep T; DNA records always use T
 * (types.ts: 'U' is converted to 'T' for DNA records). Protein records: false (not nucleotides).
 */
export function writesUracil(molecule: MoleculeType, seq: string): boolean {
  return molecule === 'RNA' && (seq.includes('U') || !seq.includes('T'));
}

/**
 * `seq` with uracil written as U (`uracil` true: T -> U) or as T (`uracil` false: U -> T); all
 * other codes unchanged. Returns `seq` itself when there is nothing to convert.
 */
export function withUracil(seq: string, uracil: boolean): string {
  if (uracil) return /[Tt]/.test(seq) ? seq.replace(/T/g, 'U').replace(/t/g, 'u') : seq;
  return /[Uu]/.test(seq) ? seq.replace(/U/g, 'T').replace(/u/g, 't') : seq;
}

/** Nucleotides `bases` written in the alphabet of the record `target` (see {@link writesUracil}); protein records unchanged. */
export function inAlphabetOf(target: SeqRecord, bases: string): string {
  return target.molecule === 'protein' ? bases : withUracil(bases, writesUracil(target.molecule, target.seq));
}

/**
 * Clean user-typed bases with `normalizeDna` (strips whitespace/digits/separators, upper-cases,
 * U -> T) and throw an Error naming every rejected character.
 */
export function cleanBases(input: string, op: string): string {
  const { seq, invalid } = normalizeDna(input);
  if (invalid.length > 0) {
    const list = invalid.map((c) => `'${c}'`).join(', ');
    throw new Error(`${op}: invalid nucleotide character(s) ${list}; allowed are the IUPAC codes ACGTURYSWKMBDHVN`);
  }
  return seq;
}

/** Overlap length of the half-open intervals [s1, e1) and [s2, e2) on the integer line. */
export function overlapLength(s1: number, e1: number, s2: number, e2: number): number {
  return Math.max(0, Math.min(e1, e2) - Math.max(s1, s2));
}

/** A new Range object with the same coordinates. */
export function copyRange(r: Range): Range {
  return { start: r.start, end: r.end };
}

/** New qualifier objects (same keys and values, same order). */
export function copyQualifiers(qualifiers: readonly Qualifier[]): Qualifier[] {
  return qualifiers.map((q) => ({ key: q.key, value: q.value }));
}

/**
 * Deep copy of a feature (new segment and qualifier objects). When `segments` is given it
 * replaces the feature's segments (the array is used as is: pass freshly built ranges).
 */
export function copyFeature(f: Feature, segments?: Range[]): Feature {
  return {
    ...f,
    segments: segments ?? f.segments.map(copyRange),
    qualifiers: copyQualifiers(f.qualifiers),
  };
}

/** Copy of `f` with partialStart / partialEnd forced to true where requested (never cleared). */
export function markPartial(f: Feature, start: boolean, end: boolean): Feature {
  const out: Feature = { ...f };
  if (start) out.partialStart = true;
  if (end) out.partialEnd = true;
  return out;
}

/** A new Primer object with the same fields. */
export function copyPrimer(p: Primer): Primer {
  return { ...p };
}

/** A new DnaEnd object with the same kind and length. */
export function copyEnd(e: DnaEnd): DnaEnd {
  return { kind: e.kind, length: e.length };
}

/** New FragmentEnds with copies of both ends. */
export function copyEnds(ends: FragmentEnds): FragmentEnds {
  return { left: copyEnd(ends.left), right: copyEnd(ends.right) };
}

/** Number of single-stranded bases of an end (0 for blunt, whatever `length` says). */
export function overhangLength(e: DnaEnd | undefined): number {
  return e === undefined || e.kind === 'blunt' ? 0 : Math.max(0, e.length);
}

/** An end of the same kind with a new single-stranded length (blunt when the length is 0). */
export function resizeEnd(e: DnaEnd, length: number): DnaEnd {
  return length > 0 && e.kind !== 'blunt' ? { kind: e.kind, length } : { kind: 'blunt', length: 0 };
}

/** Deep copy of record metadata (arrays and the extras map are copied too). */
export function copyMeta(meta: RecordMeta): RecordMeta {
  const out: RecordMeta = { ...meta };
  if (meta.comments !== undefined) out.comments = meta.comments.slice();
  if (meta.extraHeaderLines !== undefined) out.extraHeaderLines = meta.extraHeaderLines.slice();
  if (meta.extras !== undefined) out.extras = { ...meta.extras };
  return out;
}

/** Metadata for a NEW molecule derived from `meta`: a copy without accession and version. */
export function derivedMeta(meta: RecordMeta): RecordMeta {
  const out = copyMeta(meta);
  delete out.accession;
  delete out.version;
  return out;
}

/**
 * Give fresh ids (newId('f')) to features whose id is already in `taken`; adds every
 * resulting id to `taken`. Returns new feature objects (the inputs are not modified).
 */
export function withUniqueIds(features: readonly Feature[], taken: Set<string>): Feature[] {
  return features.map((f) => {
    let id = f.id;
    while (taken.has(id)) id = newId('f');
    taken.add(id);
    return id === f.id ? f : { ...f, id };
  });
}

/**
 * Features of a circular molecule of length `seqLength` re-expressed for the same bases read
 * as a linear molecule opened at the origin: an origin-crossing segment [s, e) (e > L) becomes
 * the two segments [s, L) and [0, e - L), in top-strand order. Returns deep copies.
 */
export function openFeaturesAtOrigin(features: readonly Feature[], seqLength: number): Feature[] {
  return features.map((f) =>
    copyFeature(
      f,
      f.segments.flatMap((r) =>
        r.end > seqLength
          ? [
              { start: r.start, end: seqLength },
              { start: 0, end: r.end - seqLength },
            ]
          : [copyRange(r)],
      ),
    ),
  );
}

/**
 * A new record keeping `rec`'s id, name, description and molecule type and a copy of its meta,
 * with the given sequence, topology, features, ends and primers (used as is; pass fresh
 * objects). `ends` undefined means no `ends` property (both blunt). `primers` defaults to
 * copies of `rec.primers`.
 */
export function rebuildRecord(
  rec: SeqRecord,
  seq: string,
  topology: Topology,
  features: Feature[],
  ends: FragmentEnds | undefined,
  primers: Primer[] = rec.primers.map(copyPrimer),
): SeqRecord {
  const out: SeqRecord = {
    id: rec.id,
    name: rec.name,
    description: rec.description,
    seq,
    topology,
    molecule: rec.molecule,
    features,
    primers,
    meta: copyMeta(rec.meta),
  };
  if (ends !== undefined) out.ends = ends;
  return out;
}
