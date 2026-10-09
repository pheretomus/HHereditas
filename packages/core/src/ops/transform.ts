/**
 * Whole-record transformations: sub-sequence extraction, origin rotation, reverse complement,
 * topology change and concatenation (ligation) of fragments.
 *
 * All functions are pure: inputs are never modified and results share no mutable object with
 * them. Coordinates follow types.ts (0-based half-open; origin-crossing ranges have end > L on
 * circular molecules). Circular results never carry `ends`.
 */
import type { DnaEnd, Feature, FragmentEnds, Primer, Range, SeqRecord, Strand, Topology } from '../types';
import { reverseComplement } from '../seq/alphabet';
import { newId } from '../seq/id';
import { formatRange, mod, sliceRange } from '../seq/range';
import {
  assertInteger,
  checkRange,
  copyEnd,
  copyEnds,
  copyFeature,
  copyPrimer,
  copyQualifiers,
  copyRange,
  derivedMeta,
  markPartial,
  openFeaturesAtOrigin,
  overhangLength,
  plusZero,
  rebuildRecord,
  resizeEnd,
  withUniqueIds,
  withUracil,
  writesUracil,
} from './internal';
import { dropTranslation, hasPositionalQualifiers, remapPositionalQualifiers, shiftCodonStart } from './qualifiers';
import type { BaseMap, LocationRun } from './qualifiers';

// ---------------------------------------------------------------------------
// extractRange
// ---------------------------------------------------------------------------

/** Options for {@link extractRange}. */
export interface ExtractOptions {
  /** Name of the new record. Default: `<parent name> (<1-based range>)`, e.g. "pUC19 (101..250)". */
  name?: string;
  /** Description of the new record. Default: "Bases <1-based range> of <parent name>". */
  description?: string;
}

/** A part of a segment relative to an extracted region: inside it (region coordinates) or outside it. */
type Part = { readonly range: Range } | { readonly lost: number };

/**
 * The parts of segment `seg` in traversal (top-strand) order, relative to the region
 * [a, a + len) of a molecule of length L: a part inside the region is returned as a range in
 * region coordinates (offset from a); a part outside it as the number of bases it holds.
 * Zero-length segments yield one range when their gap lies in [a, a + len] and nothing otherwise.
 */
function segmentParts(seg: Range, a: number, len: number, L: number, ring: boolean): Part[] {
  const segLen = seg.end - seg.start;
  // Segment start in the frame where the region is [0, len); on a ring it lies in [0, L).
  const s = ring ? mod(seg.start - a, L) : seg.start - a;
  const e = s + segLen;
  if (segLen === 0) return s >= 0 && s <= len ? [{ range: { start: s, end: s } }] : [];
  // Zones of the (unrolled) line, in increasing order; `shift` is null outside the region.
  const zones: ReadonlyArray<{ from: number; to: number; shift: number | null }> = ring
    ? [
        { from: 0, to: len, shift: 0 },
        { from: len, to: L, shift: null },
        { from: L, to: L + len, shift: L }, // the region again, one lap later
        { from: L + len, to: 2 * L, shift: null },
      ]
    : [
        { from: -Infinity, to: 0, shift: null },
        { from: 0, to: len, shift: 0 },
        { from: len, to: Infinity, shift: null },
      ];
  const parts: Part[] = [];
  for (const z of zones) {
    const x0 = Math.max(s, z.from);
    const x1 = Math.min(e, z.to);
    if (x1 <= x0) continue;
    parts.push(z.shift === null ? { lost: x1 - x0 } : { range: { start: x0 - z.shift, end: x1 - z.shift } });
  }
  return parts;
}

/** True if every base of the run lies in one of `segments` (linear coordinates). */
function coversRun(segments: readonly Range[], run: LocationRun): boolean {
  let x = run.first;
  while (x <= run.last) {
    const seg = segments.find((s) => s.start <= x && x < s.end);
    if (seg === undefined) return false;
    x = seg.end;
  }
  return true;
}

/**
 * Clip a feature to the region [a, a + len). Returns 0, 1 or more features: the feature is
 * split where bases between two kept parts were lost (this happens when a region of a circular
 * molecule contains both ends of a feature but not its middle). The first piece keeps the id.
 * Each piece's /codon_start accounts for the bases it lost at its 5' end; position-bearing
 * qualifiers move into region coordinates and stay only on the piece holding all their bases;
 * a feature that loses bases loses its /translation.
 */
function clipFeature(f: Feature, a: number, len: number, L: number, ring: boolean): Feature[] {
  // `from` / `to`: feature bases walked (in traversal order) before the piece's first base /
  // up to its last base.
  const pieces: Array<{ segments: Range[]; from: number; to: number }> = [];
  let walked = 0;
  let lostSinceLastPart = false;
  let leadingLoss = false;
  for (const seg of f.segments) {
    for (const part of segmentParts(seg, a, len, L, ring)) {
      if ('lost' in part) {
        walked += part.lost;
        lostSinceLastPart = true;
        continue;
      }
      if (pieces.length === 0) leadingLoss = lostSinceLastPart;
      if (pieces.length === 0 || lostSinceLastPart) pieces.push({ segments: [], from: walked, to: walked });
      const piece = pieces[pieces.length - 1];
      piece.segments.push(part.range);
      walked += part.range.end - part.range.start;
      piece.to = walked;
      lostSinceLastPart = false;
    }
  }
  if (pieces.length === 0) return [];
  const trailingLoss = lostSinceLastPart;
  const last = pieces.length - 1;
  const clipped = pieces.length > 1 || leadingLoss || trailingLoss;
  const positional = hasPositionalQualifiers(f.qualifiers);
  const map: BaseMap = {
    base: (x) => {
      const o = ring ? mod(x - a, L) : x - a;
      return o >= 0 && o < len ? o : null;
    },
    // ring: x - a wraps at a, the region ends at (a + len) mod L; linear: the region is [a, a + len)
    breaks: ring ? [a, mod(a + len, L)] : [a, a + len],
    oldLength: L,
    oldCircular: ring,
    newLength: len,
    newCircular: false,
    flip: false,
    dropIfSplit: false,
  };
  return pieces.map((p, i) => {
    let qualifiers = positional
      ? remapPositionalQualifiers(f.qualifiers, map, pieces.length > 1 ? (runs) => runs.every((r) => coversRun(p.segments, r)) : undefined)
      : copyQualifiers(f.qualifiers);
    if (clipped) qualifiers = dropTranslation(qualifiers);
    // 5' end: the left end for strand 1 / 0, the right end for strand -1
    qualifiers = shiftCodonStart(f.type, qualifiers, f.strand === -1 ? walked - p.to : p.from);
    const piece: Feature = { ...f, segments: p.segments, qualifiers };
    if (i > 0) piece.id = newId('f');
    return markPartial(piece, i > 0 || leadingLoss, i < last || trailingLoss);
  });
}

/**
 * New linear record holding the bases of `range` (a normalized range of `rec`; on a circular
 * parent it may cross the origin, end > L, and `{start: s, end: s + L}` takes the whole circle
 * opened at s).
 *
 * Features overlapping the range are clipped to it; non-overlapping ones are dropped. A clipped
 * left / right end (in top-strand coordinates, whatever the strand, like GenBank '<' / '>')
 * sets partialStart / partialEnd = true; dropped leading / trailing segments of a multi-segment
 * feature count as clipping. When the range holds both ends of a feature but not its middle
 * (possible on circular parents), the feature is split into one partial feature per piece (the
 * first keeps the id, the others get new ids). A feature crossing the range's start / end
 * without losing bases (whole-circle extraction) becomes a multi-segment join, as in
 * `setTopology(..., 'linear')`. Zero-length segments are kept when their gap lies in the range
 * (boundaries included). Fully contained features keep their exact feature sequence.
 *
 * Qualifiers: a feature that loses bases at its 5' end (the left end for strand 1 / 0, the right
 * end for strand -1) gets its /codon_start updated so that its codons are read in the original
 * frame (a 'CDS' without /codon_start gets one when the new value is not 1); a clipped or split
 * feature loses its /translation (it described the whole protein); position-bearing qualifiers
 * (/transl_except, /anticodon, /rpt_unit_range, /tag_peptide) are rewritten in the new record's
 * coordinates, or dropped when some of their bases are not extracted (see qualifiers.ts).
 *
 * The new record gets a new id, all primers (copied), blunt ends (no `ends`), the parent's meta
 * minus accession / version, topology 'linear'. Throws a RangeError for an invalid range,
 * including a range longer than a circular parent: such a range would repeat bases, as the
 * `parentRange` of a digest fragment of a circle cut once does (its overhang bases are at both
 * ends). Which copy of the repeated bases should carry the features crossing the cut is a
 * cloning decision that this function does not guess; build such a fragment from the whole
 * circle opened at the cut (`{start: s, end: s + L}`) instead.
 */
export function extractRange(rec: SeqRecord, range: Range, options: ExtractOptions = {}): SeqRecord {
  const L = rec.seq.length;
  const r = checkRange(range, L, rec.topology, 'extractRange');
  const len = r.end - r.start;
  const ring = rec.topology === 'circular' && L > 0;
  const features: Feature[] = [];
  for (const f of rec.features) features.push(...clipFeature(f, r.start, len, L, ring));
  const label = formatRange(r, L);
  return {
    id: newId('doc'),
    name: options.name ?? `${rec.name} (${label})`,
    description: options.description ?? `Bases ${label} of ${rec.name}`,
    seq: sliceRange(rec.seq, r),
    topology: 'linear',
    molecule: rec.molecule,
    features,
    primers: rec.primers.map(copyPrimer),
    meta: derivedMeta(rec.meta),
  };
}

// ---------------------------------------------------------------------------
// rotateOrigin
// ---------------------------------------------------------------------------

/**
 * Move the origin of a circular record: the base at index `newOrigin` (taken modulo the length)
 * becomes base 0. Every segment [s, e) becomes [s - newOrigin, e - newOrigin) re-normalized,
 * crossing the new origin (end > L) where needed; segments are never merged or split, so
 * feature sequences are preserved exactly. Position-bearing qualifiers (/transl_except, ...)
 * move with their bases. Throws an Error for linear records and a RangeError for a non-integer
 * `newOrigin`.
 */
export function rotateOrigin(rec: SeqRecord, newOrigin: number): SeqRecord {
  if (rec.topology !== 'circular') {
    throw new Error('rotateOrigin: the record is linear; only a circular sequence has an origin to move');
  }
  assertInteger(newOrigin, 'rotateOrigin: newOrigin');
  const L = rec.seq.length;
  const k = L > 0 ? plusZero(mod(newOrigin, L)) : 0;
  const shift = (r: Range): Range => {
    const start = mod(r.start - k, L);
    return { start, end: start + (r.end - r.start) };
  };
  const map: BaseMap = {
    base: (x) => mod(x - k, L),
    breaks: [k],
    oldLength: L,
    oldCircular: true,
    newLength: L,
    newCircular: true,
    flip: false,
    dropIfSplit: false,
  };
  const features = rec.features.map((f) => {
    if (L === 0) return copyFeature(f);
    const g = copyFeature(f, f.segments.map(shift));
    if (hasPositionalQualifiers(f.qualifiers)) g.qualifiers = remapPositionalQualifiers(f.qualifiers, map);
    return g;
  });
  return rebuildRecord(rec, rec.seq.slice(k) + rec.seq.slice(0, k), 'circular', features, undefined);
}

// ---------------------------------------------------------------------------
// reverseComplementRecord
// ---------------------------------------------------------------------------

function flipStrand(strand: Strand): Strand {
  if (strand === 1) return -1;
  return strand === -1 ? 1 : 0;
}

/** The feature after the molecule is reverse-complemented (`map`: base i -> base L-1-i). */
function flipFeature(f: Feature, L: number, ring: boolean, map: BaseMap): Feature {
  const flip = (r: Range): Range => {
    const start = ring ? mod(L - r.end, L) : L - r.end;
    return { start, end: start + (r.end - r.start) };
  };
  // Reversing the list keeps the segments in top-strand order on the new top strand.
  const out = copyFeature(f, f.segments.map(flip).reverse());
  if (L > 0 && hasPositionalQualifiers(f.qualifiers)) out.qualifiers = remapPositionalQualifiers(f.qualifiers, map);
  out.strand = flipStrand(f.strand);
  // '<' / '>' are attached to the left / right end in top-strand coordinates, which swap.
  delete out.partialStart;
  delete out.partialEnd;
  if (f.partialEnd !== undefined) out.partialStart = f.partialEnd;
  if (f.partialStart !== undefined) out.partialEnd = f.partialStart;
  return out;
}

/**
 * Reverse complement of a nucleotide record: the sequence is reverse-complemented (IUPAC
 * aware); base i becomes base L-1-i and range [s, e) becomes [L-e, L-s) (re-normalized on
 * circular records, where the origin stays at the same gap of the molecule).
 * Features: strand 1 <-> -1 (0 stays 0); the segment list is reversed so that it stays in
 * top-strand order, which preserves every stranded feature's 5'->3' sequence exactly (for
 * strand-0 features the top-strand reading becomes its reverse complement); partialStart and
 * partialEnd are swapped; position-bearing qualifiers (/transl_except, /anticodon, ...) move
 * with their bases and their complement() toggles. Sticky ends swap sides with unchanged kinds
 * (a left 5' overhang becomes a right 5' overhang). Colours, other qualifiers, primers, id and
 * meta are kept.
 *
 * RNA records pair A with U: a record written with U (or with neither T nor U) gets U, like
 * Biopython's `reverse_complement_rna` (so applying this twice gives the record back). A record
 * written with T and no U (as GenBank RNA records usually are) keeps T: Biopython would rewrite
 * it with U, which would change the record's alphabet. A sequence that mixes T and U comes back
 * written with U only (T is read as U, as Biopython does).
 * Throws an Error for protein records.
 */
export function reverseComplementRecord(rec: SeqRecord): SeqRecord {
  if (rec.molecule === 'protein') throw new Error('reverseComplementRecord: protein records cannot be reverse-complemented');
  const L = rec.seq.length;
  const ring = rec.topology === 'circular' && L > 0;
  const map: BaseMap = {
    base: (x) => L - 1 - x,
    breaks: [],
    oldLength: L,
    oldCircular: ring,
    newLength: L,
    newCircular: ring,
    flip: true,
    dropIfSplit: false,
  };
  const features = rec.features.map((f) => flipFeature(f, L, ring, map));
  const ends: FragmentEnds | undefined =
    rec.topology === 'linear' && rec.ends !== undefined
      ? { left: copyEnd(rec.ends.right), right: copyEnd(rec.ends.left) }
      : undefined;
  // The complement table pairs A with T; an RNA record written with U pairs it with U.
  const uracil = writesUracil(rec.molecule, rec.seq);
  const seq = uracil ? withUracil(reverseComplement(rec.seq), true) : reverseComplement(rec.seq);
  return rebuildRecord(rec, seq, rec.topology, features, ends);
}

// ---------------------------------------------------------------------------
// setTopology
// ---------------------------------------------------------------------------

/**
 * Change the topology flag of a record without moving any base.
 *   linear -> circular: features unchanged (a zero-length segment at gap L becomes gap 0, the
 *     same place on a circle; features of an empty record are dropped since an empty circle has
 *     no valid range); sticky ends are dropped and every base is kept, so this is a relabelling
 *     (e.g. fixing a file's topology), not a ligation: to close a fragment whose compatible
 *     overhangs should pair up, use `concatRecords([rec], { topology: 'circular' })`.
 *   circular -> linear (opened at the origin): every origin-crossing segment [s, e) becomes the
 *     two segments [s, L) and [0, e - L), in top-strand order (a 2-segment join), so feature
 *     sequences are preserved; ends are blunt.
 * Same topology: an unchanged copy.
 */
export function setTopology(rec: SeqRecord, topology: Topology): SeqRecord {
  const L = rec.seq.length;
  if (topology === rec.topology) {
    const ends = topology === 'linear' && rec.ends !== undefined ? copyEnds(rec.ends) : undefined;
    return rebuildRecord(rec, rec.seq, topology, rec.features.map((f) => copyFeature(f)), ends);
  }
  if (topology === 'circular') {
    const features =
      L === 0
        ? []
        : rec.features.map((f) =>
            copyFeature(
              f,
              f.segments.map((r) => (r.start === L ? { start: 0, end: 0 } : copyRange(r))),
            ),
          );
    return rebuildRecord(rec, rec.seq, 'circular', features, undefined);
  }
  return rebuildRecord(rec, rec.seq, 'linear', openFeaturesAtOrigin(rec.features, L), undefined);
}

// ---------------------------------------------------------------------------
// concatRecords
// ---------------------------------------------------------------------------

/** Options for {@link concatRecords}. */
export interface ConcatOptions {
  /** Topology of the product. Default 'linear'. 'circular' also joins the last part to the first. */
  topology?: Topology;
  /** Name of the product. Default: the part names joined with ' + ' (a single part keeps its name). */
  name?: string;
}

const BLUNT: DnaEnd = { kind: 'blunt', length: 0 };

/** A copy of an end in canonical form (blunt exactly when it has no single-stranded base). */
function normalizedEnd(e: DnaEnd | undefined): DnaEnd {
  return e === undefined ? BLUNT : resizeEnd(e, overhangLength(e));
}

function describeEnd(e: DnaEnd): string {
  return overhangLength(e) === 0 ? 'blunt' : `${e.kind === '5prime' ? "5'" : "3'"} overhang of ${e.length}`;
}

/**
 * Number of bases shared by two ends joined by ligation: 0 for blunt + blunt, n for two
 * compatible n-base overhangs (same kind, same length, identical top-strand text: the last n
 * bases of `leftSeq` equal the first n of `rightSeq`; see FragmentEnds in types.ts).
 * Throws an Error for incompatible ends.
 */
function ligationOverlap(leftSeq: string, rightEnd: DnaEnd, rightSeq: string, leftEnd: DnaEnd, where: string): number {
  const n = overhangLength(rightEnd);
  const m = overhangLength(leftEnd);
  if (n === 0 && m === 0) return 0;
  if (n !== m || rightEnd.kind !== leftEnd.kind) {
    throw new Error(`concatRecords: incompatible ends ${where}: ${describeEnd(rightEnd)} cannot be joined to ${describeEnd(leftEnd)}`);
  }
  const a = leftSeq.slice(Math.max(0, leftSeq.length - n));
  const b = rightSeq.slice(0, n);
  if (a.length !== n || b.length !== n || a !== b) {
    throw new Error(`concatRecords: incompatible ends ${where}: overhang '${a}' does not match '${b}'`);
  }
  return n;
}

/** Primers of all parts, dropping exact duplicates (same name and sequence) and renaming colliding ids. */
function mergePrimers(parts: readonly SeqRecord[]): Primer[] {
  const out: Primer[] = [];
  const ids = new Set<string>();
  const seen = new Set<string>();
  for (const part of parts) {
    for (const p of part.primers) {
      const key = `${p.name}\u0000${p.sequence}`;
      if (seen.has(key)) continue;
      seen.add(key);
      let id = p.id;
      while (ids.has(id)) id = newId('p');
      ids.add(id);
      out.push({ ...p, id });
    }
  }
  return out;
}

/** A segment of a linear product put onto a circle of length T (clamped to one full turn). */
function wrapOntoCircle(r: Range, T: number): Range {
  const start = mod(r.start, T);
  return { start, end: start + Math.min(r.end - r.start, T) };
}

/**
 * A feature of a part (in the part's own linear coordinates, `partLength` bases) placed at
 * `offset` in the product of {@link concatRecords}: `T` bases, circular or linear.
 */
function placePart(f: Feature, offset: number, partLength: number, circular: boolean, T: number): Feature {
  const shifted = f.segments.map((r) => ({ start: r.start + offset, end: r.end + offset }));
  const g = copyFeature(f, circular ? shifted.map((r) => wrapOntoCircle(r, T)) : shifted);
  if (hasPositionalQualifiers(f.qualifiers)) {
    // on a circle, part base x wraps to the start where x + offset reaches a multiple of T
    const breaks: number[] = [];
    if (circular) for (let x = T - mod(offset, T); x < partLength; x += T) breaks.push(x);
    g.qualifiers = remapPositionalQualifiers(f.qualifiers, {
      base: (x) => (circular ? mod(x + offset, T) : x + offset),
      breaks,
      oldLength: partLength,
      oldCircular: false,
      newLength: T,
      newCircular: circular,
      flip: false,
      dropIfSplit: false,
    });
  }
  // A segment longer than the circle is clamped to one turn: the feature loses bases.
  if (circular && shifted.some((r) => r.end - r.start > T)) g.qualifiers = dropTranslation(g.qualifiers);
  if (circular && f.strand === -1) {
    // Clamping keeps the left part of a segment longer than the circle: for strand -1 the right
    // end of the last segment is the feature's 5' end.
    const last = [...shifted].reverse().find((r) => r.end > r.start);
    if (last !== undefined) g.qualifiers = shiftCodonStart(f.type, g.qualifiers, Math.max(0, last.end - last.start - T));
  }
  return g;
}

/**
 * Join fragments end to end (5'->3' in the given order), as a ligation.
 *
 * At each junction the right end of one part meets the left end of the next: blunt + blunt
 * simply concatenates; two compatible sticky ends (same kind and length, identical overhang
 * text — see FragmentEnds in types.ts) share their overhang bases, which appear once in the
 * product; anything else throws an Error naming the junction. Circular parts are first opened
 * at their origin (as by `setTopology(part, 'linear')`) and count as blunt.
 * Features of each part are shifted to the part's position (ids regenerated on collision);
 * primers of all parts are merged (exact name+sequence duplicates dropped).
 * The product's ends are the first part's left end and the last part's right end.
 * With `topology: 'circular'` the last part is also joined to the first by the same rule (the
 * shared overhang bases are kept once, at the start); features running past the new end wrap
 * around the origin, and a feature longer than the circle is clamped to one full turn (a
 * feature that loses bases that way loses its /translation, and one that loses its 5' bases gets
 * its /codon_start updated, as in extractRange).
 * Position-bearing qualifiers (/transl_except, /anticodon, ...) move with their bases.
 * RNA parts written with different letters for uracil (T in some, U in others) are joined
 * written with U, so that the product does not mix T and U.
 * The product gets a new id and the first part's meta minus accession / version.
 * Throws an Error when `parts` is empty, when parts have different molecule types, or when a
 * circular product would be empty after merging its closing overhangs.
 */
export function concatRecords(parts: readonly SeqRecord[], options: ConcatOptions = {}): SeqRecord {
  if (parts.length === 0) throw new Error('concatRecords: at least one part is required');
  const first = parts[0];
  for (const p of parts) {
    if (p.molecule !== first.molecule) {
      throw new Error(`concatRecords: cannot join a ${p.molecule} record to a ${first.molecule} record`);
    }
  }
  const uracil = first.molecule === 'RNA' && parts.some((p) => p.seq.includes('U'));
  const text = (p: SeqRecord): string => (uracil ? withUracil(p.seq, true) : p.seq);
  // Circular parts are opened at their origin and have no sticky ends.
  const pieces = parts.map((p) =>
    p.topology === 'circular'
      ? { seq: text(p), features: openFeaturesAtOrigin(p.features, p.seq.length), left: BLUNT, right: BLUNT }
      : { seq: text(p), features: p.features, left: normalizedEnd(p.ends?.left), right: normalizedEnd(p.ends?.right) },
  );
  let seq = '';
  // Features of each part with the part's position in the (linear) product.
  const placed: Array<{ f: Feature; offset: number; partLength: number }> = [];
  for (let i = 0; i < pieces.length; i++) {
    const cur = pieces[i];
    let overlap = 0;
    if (i > 0) {
      const prev = pieces[i - 1];
      const where = `between part ${i} ('${parts[i - 1].name}') and part ${i + 1} ('${parts[i].name}')`;
      overlap = ligationOverlap(prev.seq, prev.right, cur.seq, cur.left, where);
    }
    const offset = seq.length - overlap;
    for (const f of cur.features) placed.push({ f, offset, partLength: cur.seq.length });
    seq += cur.seq.slice(overlap);
  }
  const lastPiece = pieces[pieces.length - 1];
  const names = parts.map((p) => p.name);
  const name = options.name ?? (parts.length === 1 ? first.name : names.join(' + '));
  const description = parts.length === 1 ? first.description : `Joined from ${names.join(', ')}`;
  const topology = options.topology ?? 'linear';
  let ends: FragmentEnds | undefined;
  // Length of the product: the circle closes over the shared closing overhang bases.
  let T = seq.length;
  if (topology === 'circular') {
    const overlap = ligationOverlap(seq, lastPiece.right, seq, pieces[0].left, 'when closing the circle (last part to first part)');
    T = seq.length - overlap;
    if (T <= 0 && seq.length > 0) throw new Error('concatRecords: nothing would remain of the circle after merging its closing overhangs');
    seq = seq.slice(0, T);
  } else if (overhangLength(pieces[0].left) > 0 || overhangLength(lastPiece.right) > 0) {
    ends = { left: copyEnd(pieces[0].left), right: copyEnd(lastPiece.right) };
  }
  const circular = topology === 'circular';
  const features =
    circular && T === 0 ? [] : placed.map(({ f, offset, partLength }) => placePart(f, offset, partLength, circular, T));
  const finalFeatures = withUniqueIds(features, new Set<string>());
  const out: SeqRecord = {
    id: newId('doc'),
    name,
    description,
    seq,
    topology,
    molecule: first.molecule,
    features: finalFeatures,
    primers: mergePrimers(parts),
    meta: derivedMeta(first.meta),
  };
  if (ends !== undefined) out.ends = ends;
  return out;
}
