/**
 * Restriction digest of a whole SeqRecord: fragments as records with sticky ends and features.
 *
 * Built on `enzymes/digest` (cleavage model, conflicts, size convention) and `ops/extractRange`
 * (feature clipping). Coordinates follow `types.ts`.
 */
import type { Feature, Range, SeqRecord } from '../types';
import { newId } from '../seq/id';
import { mod } from '../seq/range';
import { digest } from '../enzymes/digest';
import type { DigestCut, DigestFragment } from '../enzymes/digest';
import type { RestrictionEnzyme } from '../enzymes/enzyme';
import { extractRange } from '../ops/transform';

/**
 * One fragment of {@link digestRecord}: a linear record (or the intact circle when nothing cut)
 * plus where it came from.
 *
 *  - `seq` is the FULL duplex extent, overhang bases included (the size convention of
 *    `enzymes/digest`: EcoRI-linearized pUC19 is 2690 bases long, 2686 bp cut-to-cut).
 *  - `ends` always holds the fragment's single-stranded ends (FragmentEnds convention of
 *    `types.ts`); an uncut circle has no `ends`.
 *  - `parentRange` is the extent of `seq` in the parent's top-strand coordinates (circular
 *    parents: start in [0, L), end may exceed L; a circle cut once gives a range of
 *    L + overhang bases, longer than the circle).
 *  - `leftCut` / `rightCut`: the cleavage event (enzyme name and parent gap positions) at each end;
 *    absent at an original end of a linear parent.
 */
export type DigestedRecord = SeqRecord & {
  parentRange: Range;
  leftCut?: DigestCut;
  rightCut?: DigestCut;
};

/**
 * Digest a record with one or more enzymes (complete digest; see `enzymes/digest` for the model,
 * including how overlapping cut zones are resolved).
 *
 * Fragments come in parent order (on a circle the fragment spanning the origin comes last).
 * For a linear parent the input's own sticky ends (`rec.ends`) are honoured: the outermost
 * fragments keep them and sites inside single-stranded overhangs are not cut.
 *
 * Features: every parent feature overlapping a fragment is clipped to it (`ops/extractRange`
 * rules: clipped ends set partialStart / partialEnd, /codon_start is updated, /translation dropped).
 * The fragment's extent includes its overhang bases, so a feature covering an overhang keeps those
 * bases. On a circle cut once the overhang bases occur at both ends of the fragment; a feature
 * crossing the cut is split into a piece at each end, and a feature lying in the overhang appears
 * at both ends.
 *
 * Names: `<parent> <left enzyme>–<right enzyme>` (`start` / `end` at an original end of a linear
 * parent); an uncut molecule keeps its name. Primers of the parent are copied to every fragment.
 *
 * An empty enzyme list or no cleavage gives one fragment: a copy of the record (`parentRange` =
 * the whole molecule). Throws only for an invalid enzyme definition or invalid `rec.ends`.
 */
export function digestRecord(rec: SeqRecord, enzymes: readonly RestrictionEnzyme[]): DigestedRecord[] {
  const L = rec.seq.length;
  if (L === 0) return [];
  const ends = rec.topology === 'linear' && rec.ends !== undefined ? { ends: rec.ends } : {};
  const fragments = digest(rec.seq, rec.topology, enzymes, ends);
  return fragments.map((frag) => fragmentRecord(rec, frag));
}

function fragmentRecord(rec: SeqRecord, frag: DigestFragment): DigestedRecord {
  const L = rec.seq.length;
  if (frag.topology === 'circular' || (frag.leftCut === undefined && frag.rightCut === undefined)) {
    // Nothing cut: the molecule itself.
    const copy: DigestedRecord = {
      ...rec,
      id: newId('doc'),
      features: rec.features.map(copyFeature),
      primers: rec.primers.map((p) => ({ ...p })),
      meta: { ...rec.meta },
      parentRange: { start: 0, end: L },
    };
    if (rec.ends !== undefined) copy.ends = { left: { ...rec.ends.left }, right: { ...rec.ends.right } };
    return copy;
  }
  const name = `${rec.name} ${frag.leftCut?.enzyme ?? 'start'}–${frag.rightCut?.enzyme ?? 'end'}`;
  const description = `${rec.name} digested: fragment ${formatOneBased(frag.parentRange, L)} (${frag.length} bases incl. overhangs)`;
  const range = frag.parentRange;
  const base =
    range.end - range.start <= L
      ? extractRange(rec, range, { name, description })
      : extractLongerThanCircle(rec, range, name, description);
  const out: DigestedRecord = {
    ...base,
    seq: frag.seq,
    ends: { left: { ...frag.ends.left }, right: { ...frag.ends.right } },
    parentRange: { ...range },
  };
  if (frag.leftCut !== undefined) out.leftCut = { ...frag.leftCut };
  if (frag.rightCut !== undefined) out.rightCut = { ...frag.rightCut };
  return out;
}

/** "101..250" (1-based inclusive, origin-spanning ranges written past L as "4900..5100"). */
function formatOneBased(r: Range, L: number): string {
  const last = r.end - 1;
  return `${r.start + 1}..${last >= L ? mod(last, L) + 1 : last + 1}`;
}

function copyFeature(f: Feature): Feature {
  return {
    ...f,
    segments: f.segments.map((s) => ({ ...s })),
    qualifiers: f.qualifiers.map((q) => ({ ...q })),
  };
}

/**
 * Extract a range of a circular record that is longer than the circle (a circle cut once: its
 * overhang bases occur at both ends). The circle is unrolled into a linear record holding several
 * consecutive copies of the sequence, each with a copy of every feature, and the window is
 * extracted from it with `extractRange`, so the usual clipping rules apply to each copy.
 */
function extractLongerThanCircle(rec: SeqRecord, range: Range, name: string, description: string): SeqRecord {
  const L = rec.seq.length;
  const COPIES = 6;
  const lifts = [1, 2, 3, 4];
  const winStart = range.start + 2 * L; // window in unrolled coordinates
  const winEnd = range.end + 2 * L;
  const features: Feature[] = [];
  const usedIds = new Set<string>();
  for (const f of rec.features) {
    const unrolled = unrollSegments(f.segments, L);
    if (unrolled === null) continue;
    for (const k of lifts) {
      const segments = unrolled.map((s) => ({ start: s.start + k * L, end: s.end + k * L }));
      if (segments.some((s) => s.end > COPIES * L)) continue;
      const touches = segments.some((s) =>
        s.end > s.start ? s.start < winEnd && s.end > winStart : s.start >= winStart && s.start <= winEnd,
      );
      if (!touches) continue;
      const id = usedIds.has(f.id) ? newId('f') : f.id;
      usedIds.add(id);
      features.push({ ...copyFeature(f), id, segments });
    }
  }
  const unrolledRec: SeqRecord = {
    ...rec,
    seq: rec.seq.repeat(COPIES),
    topology: 'linear',
    features,
  };
  delete unrolledRec.ends;
  const out = extractRange(unrolledRec, { start: winStart, end: winEnd }, { name, description });
  // extractRange may give a split feature's later pieces new ids; make all ids unique.
  const seen = new Set<string>();
  out.features = out.features.map((f) => {
    if (!seen.has(f.id)) {
      seen.add(f.id);
      return f;
    }
    const id = newId('f');
    seen.add(id);
    return { ...f, id };
  });
  return out;
}

/**
 * Segments of a circular feature as increasing positions on the unrolled circle: each segment is
 * normalized into [0, L) (+ length), and a segment that starts before the previous one is moved one
 * turn further. Returns null for a feature without segments.
 */
function unrollSegments(segments: readonly Range[], L: number): Range[] | null {
  if (segments.length === 0) return null;
  const out: Range[] = [];
  let offset = 0;
  for (const s of segments) {
    const len = Math.min(L, Math.max(0, s.end - s.start));
    const start = mod(s.start, L);
    if (out.length > 0 && start + offset < out[out.length - 1].start) offset += L;
    out.push({ start: start + offset, end: start + offset + len });
  }
  return out;
}
