/**
 * Coordinate remapping for sequence edits: where features, selections and carets end up
 * after bases are inserted, deleted or replaced. Pure functions on positions only, so the
 * UI can preview an edit (and keep its caret / selection) without building the new record.
 *
 * Conventions (types.ts): 0-based half-open ranges; gap positions in [0, L]; on circular
 * molecules origin-crossing ranges have end > L and gaps 0 and L are the same place.
 *
 * EVERY EDIT IS "delete D, then insert n bases where D was":
 *   insert  : D is empty, at the insertion gap g;
 *   delete  : n = 0;
 *   replace : general case.
 *
 * NEW LAYOUT AND ORIGIN RULES (L = old length, D = [a, a + d), n inserted bases):
 *   - Linear, or circular when D does not cross the origin (a + d <= L):
 *       new = old[0, a) + INSERTED + old[a + d, L).
 *     The origin stays at the original first base whenever that base survives (a > 0);
 *     when a = 0 the inserted bases (or, if none, the first base after D) become base 0.
 *   - Circular when D crosses the origin (a + d > L): the original first base is deleted;
 *       new = INSERTED + old[a + d - L, a),
 *     i.e. the inserted bases start the new sequence (if there are none, the first base after D
 *     becomes base 0). Bases that survive keep their order and are shifted by a constant.
 *   - Circular insertion at gap 0 is treated as an insertion at gap L (appending), so the
 *     origin stays at the original first base and segments crossing the origin grow.
 *
 * SEGMENT RULES (feature segment [s, e)):
 *   - Bases of the segment that are deleted disappear; the surviving bases stay contiguous.
 *   - A segment that loses all of its bases is removed; a feature that loses all of its
 *     segments is removed. Partial flags (partialStart / partialEnd) are not changed.
 *   - The inserted bases become part of a segment only when the segment STRICTLY contains the
 *     edit, i.e. s < a and a + d < e (circular-aware). Hence for an insertion at gap g:
 *     e <= g -> unchanged; s >= g -> shifted by n; s < g < e -> grows by n. A segment that merely
 *     touches the edited region (or is trimmed by it) does not absorb the inserted bases.
 *     Exception (see CONTIGUOUS RUNS below): when the segment is ADJACENT to another segment of the
 *     same feature, the rule applies to the contiguous stretch they form together, so bases
 *     inserted exactly at the junction of two adjacent segments (e.g. at the origin, for an
 *     origin-crossing feature written as the join [s, L) + [0, e)) join the feature. This
 *     generalizes the rule "an insertion inside a feature extends it" to every way of writing the
 *     same bases; for a feature without adjacent segments it is exactly the rule above.
 *   - Zero-length segments (between-base sites, s = e) at gap p: removed when p lies strictly
 *     inside D; at the left boundary of D (or exactly at an insertion gap) they stay on the left
 *     (5') side of the inserted bases; at the right boundary of D they go to the right side.
 *   - On a circular molecule whose new length is 0, no range is valid: every feature is removed.
 *
 * CONTIGUOUS RUNS (multi-segment features): consecutive non-empty segments of a feature that are
 * ADJACENT (the next one starts where the previous one ends; on a circular molecule modulo L, at
 * most L bases in all) cover one contiguous stretch of bases, with no intron between them. The
 * commonest case is a feature crossing the origin of a circular molecule written as the join
 * [s, L) + [0, e) (GenBank's join(s+1..L,1..e)), which is the same stretch as the single segment
 * [s, L + e). For such a run the strict-containment rule above applies to the WHOLE run, so an
 * edit affects a feature the same way whichever way it is written: inserted bases strictly inside
 * the run become part of the feature even at the junction of two of its segments. They join, in
 * this order of preference: the segment strictly containing the edit; the segment that holds all
 * the deleted bases (and keeps some); on a circular molecule, when the inserted bases become the
 * first bases of the new sequence, the segment after them (so that a join split at the origin
 * stays split at the origin); otherwise the segment before them. Segments are never merged, split
 * or reordered by these edits (a segment whose bases are all deleted disappears). Segments that
 * are not adjacent (a real intron between them) are remapped independently.
 *
 * QUALIFIERS (see qualifiers.ts): position-bearing qualifiers (/transl_except, /anticodon,
 * /rpt_unit_range, /tag_peptide) move with their bases and are dropped when one of their bases
 * is deleted or replaced, or when bases inserted INTO THE FEATURE land between two adjacent bases
 * of theirs (bases inserted outside the feature, e.g. at the junction of the two ends of a feature
 * covering a whole circle, cannot change a codon of it and only move them). When the edit removes
 * bases from a feature's 5' end (its first bases in 5'->3' order: the left end for strand 1 / 0,
 * the right end for strand -1), /codon_start is updated so that the remaining codons are read in
 * the same frame (an edit inside the feature, which shifts the frame of what follows, changes
 * nothing).
 * When the edit changes the feature's bases (some of them deleted or replaced, or inserted bases
 * joining it), its /translation no longer matches them and is dropped; a feature that is only
 * moved keeps it.
 */
import type { Feature, Qualifier, Range, Topology } from '../types';
import { mod } from '../seq/range';
import { assertCount, checkGap, checkRange, copyQualifiers, overlapLength } from './internal';
import { dropTranslation, hasPositionalQualifiers, remapPositionalQualifiers, shiftCodonStart } from './qualifiers';
import type { BaseMap } from './qualifiers';

/**
 * A sequence edit described by positions only (no bases).
 *   insert  : `length` bases inserted at gap `gap` (0..L).
 *   delete  : the bases of `range` are removed (normalized range, may cross the origin of a
 *             circular molecule with end > L).
 *   replace : the bases of `range` are replaced by `length` new bases; an empty `range` makes
 *             it an insertion at `range.start`.
 */
export type SequenceEdit =
  | { readonly kind: 'insert'; readonly gap: number; readonly length: number }
  | { readonly kind: 'delete'; readonly range: Range }
  | { readonly kind: 'replace'; readonly range: Range; readonly length: number };

/**
 * A validated edit, reduced to "delete [start, start + deleted), then insert `inserted` bases",
 * plus the resulting layout. All positions in OLD coordinates unless stated otherwise.
 */
export interface EditPlan {
  /** Length of the molecule before the edit. */
  readonly oldLength: number;
  readonly topology: Topology;
  /**
   * First deleted base; for a pure insertion, the insertion gap. In [0, oldLength]. A circular
   * insertion at gap 0 is stored as `oldLength` (append; see module notes).
   */
  readonly start: number;
  /** Number of deleted bases (0 for an insertion). */
  readonly deleted: number;
  /** Number of inserted bases (0 for a deletion). */
  readonly inserted: number;
  /** True when the deleted region crosses the origin of a circular molecule (start + deleted > oldLength). */
  readonly wrapsOrigin: boolean;
  /** NEW coordinates: the inserted bases occupy [insertAt, insertAt + inserted). */
  readonly insertAt: number;
  /** Length of the molecule after the edit. */
  readonly newLength: number;
}

/**
 * Which side of the inserted bases a gap goes to when the edit collapses it onto the insertion
 * point: a gap exactly at an insertion gap, strictly inside a deleted region, or at the LEFT
 * boundary of a deleted region.
 *   'left'  (default, used for zero-length features): before the inserted bases, next to the base
 *           on its left;
 *   'right': after the inserted bases (e.g. the caret after typing or pasting over a selection,
 *           whichever end of the selection the caret was at).
 * A gap at the RIGHT boundary of a deleted region always goes after the inserted bases, next to the
 * base on its right (the only one of its neighbours that survives).
 */
export type GapBias = 'left' | 'right';

/**
 * Validate `edit` against a molecule of length `oldLength` and compute its layout.
 * Throws a RangeError for gaps / ranges outside the molecule, non-integers or negative lengths.
 * Ranges must be normalized (types.ts); origin-crossing deletions are only valid on circular molecules.
 */
export function planEdit(edit: SequenceEdit, oldLength: number, topology: Topology): EditPlan {
  assertCount(oldLength, 'oldLength');
  const L = oldLength;
  let start: number;
  let deleted: number;
  let inserted: number;
  if (edit.kind === 'insert') {
    start = checkGap(edit.gap, L, 'insert');
    deleted = 0;
    assertCount(edit.length, 'insert: length');
    inserted = edit.length;
  } else {
    const r = checkRange(edit.range, L, topology, edit.kind);
    start = r.start;
    deleted = r.end - r.start;
    if (edit.kind === 'replace') {
      assertCount(edit.length, 'replace: length');
      inserted = edit.length;
    } else {
      inserted = 0;
    }
  }
  // Circular: gap 0 and gap L are the same place; insert there by appending (origin kept).
  if (topology === 'circular' && deleted === 0 && start === 0) start = L;
  const wrapsOrigin = topology === 'circular' && start + deleted > L;
  return {
    oldLength: L,
    topology,
    start,
    deleted,
    inserted,
    wrapsOrigin,
    insertAt: wrapsOrigin ? 0 : start,
    newLength: L - deleted + inserted,
  };
}

/** True when positions must be handled modulo the length (circular molecule with at least one base). */
function isRing(plan: EditPlan): boolean {
  return plan.topology === 'circular' && plan.oldLength > 0;
}

/** New index of an OLD base `x` (0 <= x < L) that survives the edit. */
function newBaseIndex(plan: EditPlan, x: number): number {
  const { start: a, deleted: d, inserted: n, oldLength: L } = plan;
  if (plan.wrapsOrigin) return n + x - (a + d - L);
  return x < a ? x : x - d + n;
}

/** Normalize a NEW gap position: modulo the new length on circular molecules. */
function normalizeNewGap(plan: EditPlan, gap: number): number {
  if (plan.topology !== 'circular') return gap;
  return plan.newLength > 0 ? mod(gap, plan.newLength) : 0;
}

/**
 * Remap an old gap position. Returns the new gap and whether the old gap was strictly inside
 * the deleted region (in which case the new gap is the insertion point, on the `bias` side).
 */
function remapGapWithPlan(plan: EditPlan, gap: number, bias: GapBias): { gap: number; inside: boolean } {
  const { start: a, deleted: d, inserted: n, insertAt, oldLength: L } = plan;
  const ring = isRing(plan);
  const p = ring ? mod(gap, L) : gap;
  const off = ring ? mod(p - a, L) : p - a; // offset of the gap from the start of the edit
  let out: number;
  let inside = false;
  if (off === 0) {
    // exactly at an insertion gap, or at the left boundary of the deleted region
    out = bias === 'left' ? insertAt : insertAt + n;
  } else if (off > 0 && off < d) {
    inside = true; // strictly inside the deleted region: collapses onto the insertion point
    out = bias === 'left' ? insertAt : insertAt + n;
  } else if (off === d) {
    out = insertAt + n; // right boundary of the deleted region: after the inserted bases
  } else if (ring) {
    out = newBaseIndex(plan, p); // base p survives; the gap stays just before it
  } else {
    out = off < 0 ? p : p - d + n; // linear: before or after the edited region
  }
  return { gap: normalizeNewGap(plan, out), inside };
}

/** What an edit removes from a non-empty segment [s, e) (lengths in bases). */
interface SegmentLoss {
  /** Bases that survive the edit. */
  kept: number;
  /** Deleted bases before the first surviving base (all of them when none survives). */
  lostStart: number;
  /** Deleted bases after the last surviving base (all of them when none survives). */
  lostEnd: number;
  /** The segment strictly contains the edit: s < a and a + d < e (circular-aware). */
  strict: boolean;
  /** First surviving base, unwrapped (s <= first < e when kept > 0). */
  first: number;
}

/** Which bases of the non-empty segment [s, e) the edit deletes (see {@link SegmentLoss}). */
function segmentLoss(plan: EditPlan, s: number, e: number): SegmentLoss {
  const { start: a, deleted: d, oldLength: L } = plan;
  const len = e - s;
  let lost: number;
  let strict: boolean;
  let first: number;
  let lostEnd = 0;
  if (isRing(plan)) {
    // Copies of the edit start on the unrolled circle: `aU` at or after s, `aP` before s.
    const aU = s + mod(a - s, L);
    const aP = aU - L;
    lost = overlapLength(s, e, aU, aU + d) + overlapLength(s, e, aP, aP + d);
    strict = aU > s && aU + d < e;
    if (d > 0 && aU === s) first = s + d;
    else if (aP + d > s) first = aP + d;
    else first = s;
    if (d > 0 && aU <= e - 1 && e - 1 < aU + d) lostEnd = e - Math.max(s, aU);
  } else {
    lost = overlapLength(s, e, a, a + d);
    strict = a > s && a + d < e;
    first = s >= a && s < a + d ? a + d : s;
    if (d > 0 && a <= e - 1 && e - 1 < a + d) lostEnd = e - Math.max(s, a);
  }
  const kept = len - lost;
  if (kept <= 0) return { kept: 0, lostStart: len, lostEnd: len, strict: false, first: s };
  return { kept, lostStart: first - s, lostEnd, strict, first };
}

/**
 * Remap one range (feature segment) with the rules in the module notes. Returns null when the
 * range loses all of its bases (or, for a zero-length range, when it was strictly inside the
 * deleted region). The result is normalized for the new molecule.
 */
function remapRangeWithPlan(plan: EditPlan, seg: Range): Range | null {
  if (plan.topology === 'circular' && plan.newLength === 0) return null;
  const s = seg.start;
  const e = seg.end;
  if (e === s) {
    const g = remapGapWithPlan(plan, s, 'left');
    return g.inside ? null : { start: g.gap, end: g.gap };
  }
  const loss = segmentLoss(plan, s, e);
  if (loss.kept === 0) return null;
  const start = newBaseIndex(plan, isRing(plan) ? mod(loss.first, plan.oldLength) : loss.first);
  return { start, end: start + loss.kept + (loss.strict ? plan.inserted : 0) };
}

/**
 * Number of segments, from `from` on, that form one contiguous run: non-empty, each starting
 * where the previous one ends (modulo L on a ring), at most L bases in all on a ring.
 */
function runLength(segments: readonly Range[], from: number, plan: EditPlan): number {
  const ring = isRing(plan);
  const L = plan.oldLength;
  const first = segments[from];
  if (first.end === first.start) return 1;
  let total = first.end - first.start;
  let k = from + 1;
  for (; k < segments.length; k++) {
    const prev = segments[k - 1];
    const next = segments[k];
    const len = next.end - next.start;
    const adjacent = ring ? mod(next.start - prev.end, L) === 0 : next.start === prev.end;
    if (len === 0 || !adjacent || (ring && total + len > L)) break;
    total += len;
  }
  return k - from;
}

/**
 * Index (in `run`) of the segment that takes the bases inserted strictly inside a contiguous run
 * whose union starts at `runStart` (see "contiguous runs" in the module notes).
 */
function absorbingSegment(plan: EditPlan, run: readonly Range[], losses: readonly SegmentLoss[], runStart: number): number {
  const { start: a, deleted: d, oldLength: L } = plan;
  const strictly = losses.findIndex((x) => x.strict);
  if (strictly >= 0) return strictly;
  // Unrolled coordinates from the start of the run: segment k covers [from[k], from[k] + length).
  const aU = isRing(plan) ? runStart + mod(a - runStart, L) : a;
  const from: number[] = [];
  let u = runStart;
  for (const seg of run) {
    from.push(u);
    u += seg.end - seg.start;
  }
  const holding = (x: number) => from.findIndex((f, k) => f <= x && x < f + run[k].end - run[k].start);
  if (d > 0) {
    const k = holding(aU);
    if (k >= 0 && aU + d <= from[k] + run[k].end - run[k].start && losses[k].kept > 0) return k;
  }
  return isRing(plan) && plan.insertAt === 0 ? holding(aU + d) : holding(aU - 1);
}

/** The segments of a feature after an edit (removed ones omitted, same order). */
interface RemappedSegments {
  segments: Range[];
  /**
   * True when the feature's bases change: some of its bases are deleted (or replaced), or inserted
   * bases join it. False when its bases are only moved (zero-length segments do not count).
   */
  changed: boolean;
  /** True when inserted bases join the feature (some segment absorbs them). */
  grew: boolean;
}

/**
 * Remap the segments of one feature (see "segment rules" and "contiguous runs" in the module
 * notes). Removed segments are omitted; the result is in the same order.
 */
function remapSegments(plan: EditPlan, segments: readonly Range[]): RemappedSegments {
  const out: Range[] = [];
  const ring = isRing(plan);
  let changed = false;
  let grew = false;
  for (let i = 0; i < segments.length; ) {
    const count = runLength(segments, i, plan);
    if (count === 1) {
      const seg = segments[i];
      const r = remapRangeWithPlan(plan, seg);
      if (r !== null) out.push(r);
      if (seg.end > seg.start) {
        // a non-empty segment changes when it loses bases (or all of them) or absorbs inserted ones
        const kept = r === null ? 0 : segmentLoss(plan, seg.start, seg.end).kept;
        if (kept !== seg.end - seg.start) changed = true;
        if (r !== null && r.end - r.start > kept) {
          changed = true;
          grew = true;
        }
      }
      i++;
      continue;
    }
    const run = segments.slice(i, i + count);
    i += count;
    let total = 0;
    for (const seg of run) total += seg.end - seg.start;
    const image = remapRangeWithPlan(plan, { start: run[0].start, end: run[0].start + total });
    const losses = run.map((seg) => segmentLoss(plan, seg.start, seg.end));
    const kept = losses.reduce((acc, x) => acc + x.kept, 0);
    if (image === null) {
      changed = true;
      continue;
    }
    // The run's surviving bases stay contiguous in run order (with the inserted bases between
    // them when the edit is strictly inside the run): cut its image into the segments' shares.
    const absorbed = image.end - image.start - kept;
    if (kept !== total || absorbed > 0) changed = true;
    if (absorbed > 0) grew = true;
    const absorber = absorbed > 0 ? absorbingSegment(plan, run, losses, run[0].start) : -1;
    let offset = 0;
    losses.forEach((loss, k) => {
      if (loss.kept === 0) return;
      const length = loss.kept + (k === absorber ? absorbed : 0);
      let start = image.start + offset;
      if (ring && start >= plan.newLength) start -= plan.newLength;
      out.push({ start, end: start + length });
      offset += length;
    });
  }
  return { segments: out, changed, grew };
}

/**
 * Bases removed from the 5' end of a feature: the deleted bases before its first surviving base
 * in 5'->3' order (strand -1 features are read from the right end of their last segment).
 */
function fivePrimeLoss(plan: EditPlan, f: Feature): number {
  const reverse = f.strand === -1;
  let lost = 0;
  for (let k = 0; k < f.segments.length; k++) {
    const seg = f.segments[reverse ? f.segments.length - 1 - k : k];
    if (seg.end === seg.start) continue;
    const loss = segmentLoss(plan, seg.start, seg.end);
    if (loss.kept === 0) {
      lost += seg.end - seg.start;
      continue;
    }
    return lost + (reverse ? loss.lostEnd : loss.lostStart);
  }
  return lost;
}

/**
 * How the edit moves bases, for position-bearing qualifiers: deleted bases have no new index.
 * The map is a translation on each stretch between its breaks: before / inside / after the
 * deleted region, or (deletion crossing the origin) the surviving arc. `cuts`: the inserted bases
 * joined the feature, so a location two of whose adjacent bases they separate is cut (dropped).
 * Bases inserted outside the feature (e.g. at the junction of the two ends of a feature covering
 * the whole circle) cannot change a codon of it: its locations just move with their bases.
 */
function editBaseMap(plan: EditPlan, cuts: boolean): BaseMap {
  const { start: a, deleted: d, oldLength: L } = plan;
  const ring = isRing(plan);
  const circular = plan.topology === 'circular';
  return {
    base: (x) => {
      const off = ring ? mod(x - a, L) : x - a;
      return off >= 0 && off < d ? null : newBaseIndex(plan, x);
    },
    breaks: plan.wrapsOrigin ? [a + d - L, a] : [a, a + d],
    oldLength: L,
    oldCircular: circular,
    newLength: plan.newLength,
    newCircular: circular,
    flip: false,
    dropIfSplit: cuts,
  };
}

/** Remap a list of features with a validated plan; dropped features are omitted. Returns deep copies. */
export function remapFeaturesWithPlan(features: readonly Feature[], plan: EditPlan): Feature[] {
  const out: Feature[] = [];
  // built on first use: most features carry no position-bearing qualifier
  let cutting: BaseMap | undefined;
  let moving: BaseMap | undefined;
  for (const f of features) {
    const { segments, changed, grew } = remapSegments(plan, f.segments);
    if (segments.length === 0) continue;
    let qualifiers: Qualifier[];
    if (hasPositionalQualifiers(f.qualifiers)) {
      const map = grew ? (cutting ??= editBaseMap(plan, true)) : (moving ??= editBaseMap(plan, false));
      qualifiers = remapPositionalQualifiers(f.qualifiers, map);
    } else {
      qualifiers = copyQualifiers(f.qualifiers);
    }
    if (changed) qualifiers = dropTranslation(qualifiers);
    qualifiers = shiftCodonStart(f.type, qualifiers, fivePrimeLoss(plan, f));
    out.push({ ...f, segments, qualifiers });
  }
  return out;
}

/**
 * Remap features through an edit of a molecule of length `oldLength` (see the module notes for
 * the exact rules). Returns new feature objects in the input order; features that lose all of
 * their segments are omitted. Inputs are not modified. Throws a RangeError for an invalid edit.
 * Feature segments must be normalized ranges for the OLD molecule.
 * This is the preview of an edit: insertBases / deleteRange / replaceRange produce exactly these
 * features (plus, for a record payload, the payload's own features).
 */
export function remapFeatures(
  features: readonly Feature[],
  edit: SequenceEdit,
  oldLength: number,
  topology: Topology,
): Feature[] {
  return remapFeaturesWithPlan(features, planEdit(edit, oldLength, topology));
}

/**
 * Remap one normalized range (e.g. a selection) through an edit, with the rules of a feature made
 * of this single segment ("segment rules" in the module notes). Returns null when nothing of it
 * survives. A segment of a multi-segment feature that is adjacent to another segment of the same
 * feature (e.g. one half of an origin-crossing join [s, L) + [0, e)) follows the contiguous-run
 * rule instead, which can differ for an edit at the junction: preview features with
 * {@link remapFeatures}, which gives exactly the features of the edited record. Throws a RangeError
 * when `range` is not a valid normalized range of the old molecule (e.g. a stale selection); the
 * empty range {L, L} of a circular molecule is the same as {0, 0}.
 */
export function remapRange(range: Range, edit: SequenceEdit, oldLength: number, topology: Topology): Range | null {
  const plan = planEdit(edit, oldLength, topology);
  return remapRangeWithPlan(plan, checkRange(range, oldLength, topology, 'remapRange'));
}

/**
 * Remap a gap position (caret, cut site) through an edit. A gap exactly at an insertion gap,
 * strictly inside the deleted region or at its left boundary goes to the `bias` side of the
 * inserted bases ('left' = before them, the default; 'right' = after them, e.g. a caret after
 * typing over a selection); a gap at the right boundary of a deleted region goes after them (see
 * {@link GapBias}). Circular results are normalized into [0, newLength). Throws a RangeError for an
 * invalid edit or a gap outside [0, oldLength].
 */
export function remapGap(
  gap: number,
  edit: SequenceEdit,
  oldLength: number,
  topology: Topology,
  bias: GapBias = 'left',
): number {
  const plan = planEdit(edit, oldLength, topology);
  return remapGapWithPlan(plan, checkGap(gap, oldLength, 'remapGap'), bias).gap;
}
