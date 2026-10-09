/**
 * Immutable sequence edits on a SeqRecord: insert, delete and replace bases.
 *
 * Feature coordinates are remapped with the rules documented in `remap.ts` (an insertion strictly
 * inside a segment extends it and one at its boundary does not, where adjacent segments of one
 * feature count as one contiguous stretch; deleted bases are trimmed away; origin handling on
 * circular molecules). Inputs are never modified; the result shares no mutable object with the
 * input and keeps the record's id, name, description, primers and meta.
 *
 * Sticky ends (linear records with `ends`): the single-stranded bases of an end are tracked
 * like a region anchored at its terminus.
 *   - Deleted single-stranded bases shorten the overhang (it becomes blunt at length 0).
 *   - Inserted bases become single-stranded (lengthening the overhang) when they are inserted
 *     inside the overhang or at the molecule's outer terminus next to it, or when they replace
 *     bases that were all single-stranded. Bases inserted at the junction between the
 *     single-stranded and the double-stranded part, or replacing bases that include
 *     double-stranded ones, are double-stranded.
 * Circular results never carry `ends`.
 *
 * Alphabet: the inserted bases are written in the alphabet of the edited record, as types.ts
 * stores it: U -> T for DNA records (so an RNA record or RNA text inserted into DNA becomes DNA);
 * for RNA records, T -> U when the record is written with U (or with neither T nor U), U -> T
 * when it is written with T. An edit therefore never mixes T and U in one sequence.
 *
 * Feature qualifiers follow the bases (see remap.ts and qualifiers.ts): position-bearing
 * qualifiers such as /transl_except move with their bases, /codon_start keeps the reading
 * frame of a feature whose 5' end is trimmed, and /translation is dropped from a feature whose
 * bases the edit changes (it would describe the old protein).
 */
import type { Feature, FragmentEnds, Range, SeqRecord } from '../types';
import type { EditPlan } from './remap';
import { planEdit, remapFeaturesWithPlan } from './remap';
import {
  cleanBases,
  copyFeature,
  inAlphabetOf,
  openFeaturesAtOrigin,
  overhangLength,
  overlapLength,
  rebuildRecord,
  resizeEnd,
  withUniqueIds,
} from './internal';
import { hasPositionalQualifiers, remapPositionalQualifiers } from './qualifiers';

/** Bases (and, for a record, its features in its own linear coordinates) to put into the molecule. */
interface Payload {
  seq: string;
  features: readonly Feature[];
}

/**
 * Validate the inserted material and write its bases in the alphabet of `rec` (see the module
 * notes). Strings are cleaned with normalizeDna first.
 */
function resolvePayload(rec: SeqRecord, insert: string | SeqRecord, op: string): Payload {
  if (typeof insert === 'string') {
    if (rec.molecule === 'protein') {
      throw new Error(`${op}: inserting nucleotide text is only supported for DNA/RNA records, not protein records`);
    }
    return { seq: inAlphabetOf(rec, cleanBases(insert, op)), features: [] };
  }
  if ((insert.molecule === 'protein') !== (rec.molecule === 'protein')) {
    throw new Error(`${op}: cannot insert a ${insert.molecule} record into a ${rec.molecule} record`);
  }
  // features are copied when placed into the new molecule
  const features = insert.topology === 'circular' ? openFeaturesAtOrigin(insert.features, insert.seq.length) : insert.features;
  return { seq: inAlphabetOf(rec, insert.seq), features };
}

/**
 * Place a feature of the inserted material (whose own coordinates are those of the payload,
 * `payloadLength` bases) at its position in the new molecule.
 */
function placeInserted(f: Feature, plan: EditPlan, payloadLength: number): Feature {
  const offset = plan.insertAt;
  const ring = plan.topology === 'circular' && plan.newLength > 0;
  const placed = copyFeature(
    f,
    f.segments.map((r) => {
      let start = r.start + offset;
      let end = r.end + offset;
      // only a zero-length segment at the very end of an appended insertion can reach newLength
      if (ring && start >= plan.newLength) {
        start -= plan.newLength;
        end -= plan.newLength;
      }
      return { start, end };
    }),
  );
  if (hasPositionalQualifiers(f.qualifiers)) {
    placed.qualifiers = remapPositionalQualifiers(f.qualifiers, {
      base: (x) => x + offset,
      breaks: [],
      oldLength: payloadLength,
      oldCircular: false, // a circular payload was opened at its origin
      newLength: plan.newLength,
      newCircular: plan.topology === 'circular',
      flip: false,
      dropIfSplit: false,
    });
  }
  return placed;
}

/**
 * Sticky ends of a linear molecule after the edit (see the module notes).
 * Left overhang: bases [0, mL); right overhang: bases [L - mR, L).
 */
function remapEnds(ends: FragmentEnds, plan: EditPlan): FragmentEnds {
  const { oldLength: L, start: a, deleted: d, inserted: n } = plan;
  const e = a + d;
  const mL = overhangLength(ends.left);
  const mR = overhangLength(ends.right);
  const leftAbsorbs = d > 0 ? e <= mL : a < mL;
  const rightAbsorbs = d > 0 ? a >= L - mR : a > L - mR;
  const left = mL - overlapLength(0, mL, a, e) + (leftAbsorbs ? n : 0);
  const right = mR - overlapLength(L - mR, L, a, e) + (rightAbsorbs ? n : 0);
  return { left: resizeEnd(ends.left, left), right: resizeEnd(ends.right, right) };
}

/** Build the edited record. */
function applyEdit(rec: SeqRecord, plan: EditPlan, payload: Payload): SeqRecord {
  const { start: a, deleted: d, oldLength: L } = plan;
  const seq = plan.wrapsOrigin
    ? payload.seq + rec.seq.slice(a + d - L, a)
    : rec.seq.slice(0, a) + payload.seq + rec.seq.slice(a + d);
  const kept = remapFeaturesWithPlan(rec.features, plan);
  // Carried features never reuse an id of the original record, even one whose feature the edit
  // removed, so that an id held by the UI (selection, undo) keeps naming the same feature.
  const carried = withUniqueIds(
    payload.features.map((f) => placeInserted(f, plan, payload.seq.length)),
    new Set(rec.features.map((f) => f.id)),
  );
  const ends = rec.topology === 'linear' && rec.ends !== undefined ? remapEnds(rec.ends, plan) : undefined;
  return rebuildRecord(rec, seq, rec.topology, [...kept, ...carried], ends);
}

/**
 * Insert bases at gap position `gap` (0..L; see types.ts).
 *
 * `insert` is either raw text, cleaned with `normalizeDna` (whitespace, digits and separators
 * are dropped, letters upper-cased, U -> T; any other character throws an Error naming it), or
 * another record whose bases are inserted and whose features are carried along, shifted into
 * place (a circular `insert` is opened at its origin; its primers and sticky ends are ignored;
 * feature ids already used in the target record, even by a feature the edit removes, are
 * regenerated).
 *
 * Feature rule for a segment [s, e) and n inserted bases: e <= gap -> unchanged; s >= gap ->
 * shifted by n; s < gap < e -> grows by n. Zero-length segments at the gap stay before the
 * insertion. On circular records gap 0 is the same place as gap L and the insertion is
 * appended at L: the origin stays at the original first base and origin-crossing segments grow.
 * Adjacent segments of one feature (the next starts where the previous ends, e.g. an
 * origin-crossing feature written as the join [s, L) + [0, e)) count as one contiguous stretch:
 * an insertion at their junction is strictly inside the stretch and joins the feature (it is
 * added to the segment before the gap; at the origin of a circular record, appended at L, that is
 * the segment ending at L), exactly as for the same bases written as one segment. See the
 * "contiguous runs" notes in remap.ts. /translation is dropped from a feature that grows.
 * Throws a RangeError when `gap` is not an integer in [0, L].
 */
export function insertBases(rec: SeqRecord, gap: number, insert: string | SeqRecord): SeqRecord {
  const payload = resolvePayload(rec, insert, 'insertBases');
  const plan = planEdit({ kind: 'insert', gap, length: payload.seq.length }, rec.seq.length, rec.topology);
  return applyEdit(rec, plan, payload);
}

/**
 * Remove the bases of `range` (a normalized range; on circular records it may cross the origin,
 * written with end > L).
 *
 * New origin: the original first base stays base 0 whenever it survives; when it is deleted,
 * the first base after the deleted region becomes base 0. (This keeps every coordinate before a
 * non-origin deletion unchanged and shifts everything else by a constant.)
 * Features: deleted bases are trimmed from each segment (partial flags unchanged); segments left
 * without bases disappear, and so do features left without segments; zero-length segments
 * strictly inside the deleted region disappear. A feature that loses bases also loses its
 * /translation, and its /codon_start is updated when it loses bases at its 5' end. Throws a
 * RangeError for an invalid range (the empty range {L, L} of a circular record is {0, 0}).
 */
export function deleteRange(rec: SeqRecord, range: Range): SeqRecord {
  const plan = planEdit({ kind: 'delete', range }, rec.seq.length, rec.topology);
  return applyEdit(rec, plan, { seq: '', features: [] });
}

/**
 * Replace the bases of `range` with `replacement` (text or record, as in `insertBases`).
 *
 * Equivalent to deleting `range` and inserting the replacement where it was, except that a
 * segment STRICTLY containing the replaced region (s < range.start and range.end < e,
 * circular-aware) keeps covering the replacement. Segments that only touch or partly overlap the
 * region are trimmed and do not cover the replacement; a segment exactly equal to the region is
 * removed. As for insertions, adjacent segments of one feature count as one contiguous stretch:
 * a region strictly inside the stretch is covered even when it touches or spans the junction of
 * two of its segments (see "contiguous runs" in remap.ts). Zero-length segments at the left /
 * right boundary of the region end up before / after the replacement. /translation is dropped
 * from every feature whose bases are replaced (or that covers the replacement).
 * Origin: if the replaced region contains the original first base, the replacement starts the new
 * sequence (if the replacement is empty, the first base after the region does). An empty
 * `range` makes this exactly `insertBases(rec, range.start, replacement)`; an empty replacement
 * makes it exactly `deleteRange(rec, range)`.
 */
export function replaceRange(rec: SeqRecord, range: Range, replacement: string | SeqRecord): SeqRecord {
  const payload = resolvePayload(rec, replacement, 'replaceRange');
  const plan = planEdit({ kind: 'replace', range, length: payload.seq.length }, rec.seq.length, rec.topology);
  return applyEdit(rec, plan, payload);
}
