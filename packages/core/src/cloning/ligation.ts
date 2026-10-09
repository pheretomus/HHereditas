/**
 * Ligation of linear double-stranded fragments with blunt or sticky ends.
 *
 * Sticky ends follow the FragmentEnds convention of `types.ts`: the overhang bases are part of
 * `seq` (written as top-strand letters), and two compatible ends share them, so they appear once
 * in the product. The join itself is `ops/concatRecords`.
 */
import type { SeqRecord, Topology } from '../types';
import { concatRecords } from '../ops/transform';
import type { CloningOutcome } from './result';
import { describeEnd, errorMessage, failure, leftOverhang, outcome, overhangBases, recordEnds, rightOverhang } from './result';

/**
 * True if the RIGHT end of `left` can be ligated to the LEFT end of `right`:
 * both blunt, or both sticky with the same kind (5'/3'), the same length and the same overhang
 * text (the last n bases of `left.seq` equal the first n bases of `right.seq`, which is how two
 * complementary single strands are written in top-strand letters).
 * Circular records have no free end and are never compatible. Absent `ends` means blunt.
 * Comparison is case-insensitive; an ambiguity code in an overhang matches only the same letter.
 */
export function endsCompatible(left: SeqRecord, right: SeqRecord): boolean {
  if (left.topology === 'circular' || right.topology === 'circular') return false;
  const a = recordEnds(left).right;
  const b = recordEnds(right).left;
  const n = overhangBases(a);
  const m = overhangBases(b);
  if (n === 0 && m === 0) return true;
  if (n !== m || a.kind !== b.kind) return false;
  if (left.seq.length < n || right.seq.length < n) return false;
  return rightOverhang(left).toUpperCase() === leftOverhang(right).toUpperCase();
}

/** Options of {@link ligate}. */
export interface LigateOptions {
  /** Also join the last fragment's right end to the first fragment's left end. Default false. */
  circularize?: boolean;
  /** Name of the product. Default: the fragment names joined with ' + '. */
  name?: string;
}

/** One junction of a ligation product. */
export interface LigationJunction {
  /** 0-based indices of the joined fragments (left, right) in the input array. */
  leftPart: number;
  rightPart: number;
  /**
   * Shared overhang bases in product coordinates: a zero-length range at the junction gap for a
   * blunt junction. For the closing junction of a circle this is at the start of the product.
   */
  range: { start: number; end: number };
  /** 'blunt', or the overhang kind of the two sticky ends. */
  kind: 'blunt' | '5prime' | '3prime';
  /** Shared overhang text (top-strand letters), '' for blunt. */
  overhang: string;
}

/** Result of {@link ligate}: the common {@link CloningOutcome} plus the junctions of the product. */
export interface LigationResult extends CloningOutcome {
  junctions: LigationJunction[];
}

/**
 * Ligate linear fragments in the given order and orientation (top strand 5'->3', left to right).
 *
 * Each junction joins the right end of fragment i to the left end of fragment i + 1 and must pass
 * {@link endsCompatible}; shared overhang bases are counted once. With `circularize` the last
 * fragment is also joined to the first (the closing overhang is written once, at the start of the
 * product, so the circle starts with the first fragment). Features of all fragments are carried over
 * (shifted), primers merged. The linear product keeps the first fragment's left end and the last
 * fragment's right end.
 *
 * Errors (no product): an empty list, a circular input, incompatible ends (the message names the
 * junction and both ends), a circle with nothing left after merging its closing overhang.
 * Warnings: a fragment shorter than its two overhangs together. Self-ligation risks are reported by
 * `restrictionClone`, not here.
 */
export function ligate(parts: readonly SeqRecord[], options: LigateOptions = {}): LigationResult {
  const warnings: string[] = [];
  if (parts.length === 0) return failure('Nothing to ligate: no fragments given', warnings, { junctions: [] });
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].topology === 'circular') {
      return failure(`Fragment ${i + 1} ('${parts[i].name}') is circular: it has no free ends to ligate`, warnings, { junctions: [] });
    }
  }
  for (let i = 0; i + 1 < parts.length; i++) {
    if (!endsCompatible(parts[i], parts[i + 1])) {
      return failure(`Incompatible ends between fragment ${i + 1} and fragment ${i + 2}: ${junctionText(parts[i], parts[i + 1])}`, warnings, {
        junctions: [],
      });
    }
  }
  const circular = options.circularize === true;
  if (circular && !endsCompatible(parts[parts.length - 1], parts[0])) {
    return failure(
      `Cannot circularize: the right end of the last fragment does not fit the left end of the first: ${junctionText(parts[parts.length - 1], parts[0])}`,
      warnings,
      { junctions: [] },
    );
  }
  for (const p of parts) {
    const e = recordEnds(p);
    if (overhangBases(e.left) + overhangBases(e.right) > p.seq.length) {
      warnings.push(`Fragment '${p.name}' is shorter than its two overhangs together; it cannot exist as a duplex`);
    }
  }
  const topology: Topology = circular ? 'circular' : 'linear';
  let product: SeqRecord;
  try {
    // Join upper-cased copies, so that overhang text comparisons in concatRecords are case-insensitive.
    const upper = parts.map((p) => (p.seq === p.seq.toUpperCase() ? p : { ...p, seq: p.seq.toUpperCase() }));
    product = concatRecords(upper, { topology, ...(options.name !== undefined ? { name: options.name } : {}) });
  } catch (e) {
    return failure(errorMessage(e), warnings, { junctions: [] });
  }
  if (circular) product.description = `Circular ligation product of ${parts.map((p) => p.name).join(', ')}`;
  return outcome([product], warnings, { junctions: ligationJunctions(parts, circular) });
}

/** "5' overhang AATT (fragment 'a', right end) vs 5' overhang GATC (fragment 'b', left end)" */
function junctionText(left: SeqRecord, right: SeqRecord): string {
  const a = describeEnd(recordEnds(left).right, rightOverhang(left));
  const b = describeEnd(recordEnds(right).left, leftOverhang(right));
  return `${a} ('${left.name}', right end) cannot pair with ${b} ('${right.name}', left end)`;
}

/** Junction positions in the product of concatRecords (see its overlap rule). */
export function ligationJunctions(parts: readonly SeqRecord[], circular: boolean): LigationJunction[] {
  const junctions: LigationJunction[] = [];
  let pos = 0; // length of the product so far
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (i > 0) {
      const end = recordEnds(parts[i - 1]).right;
      const n = overhangBases(end);
      junctions.push({
        leftPart: i - 1,
        rightPart: i,
        range: { start: pos - n, end: pos },
        kind: n === 0 ? 'blunt' : end.kind,
        overhang: p.seq.slice(0, n).toUpperCase(),
      });
      pos += p.seq.length - n;
    } else {
      pos = p.seq.length;
    }
  }
  if (circular) {
    const end = recordEnds(parts[parts.length - 1]).right;
    const n = overhangBases(end);
    junctions.push({
      leftPart: parts.length - 1,
      rightPart: 0,
      range: { start: 0, end: n },
      kind: n === 0 ? 'blunt' : end.kind,
      overhang: parts[0].seq.slice(0, n).toUpperCase(),
    });
  }
  return junctions;
}
