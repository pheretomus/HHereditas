/**
 * Arithmetic on ranges and positions, aware of circular topology.
 * See the coordinate conventions in `types.ts`.
 */
import type { Range, Topology } from '../types';

/** Positive modulo. */
export function mod(n: number, m: number): number {
  const r = n % m;
  return r < 0 ? r + m : r;
}

/** Length of a range. */
export function rangeLength(r: Range): number {
  return r.end - r.start;
}

/** True if the range crosses the origin of a circular molecule of length `seqLength`. */
export function wrapsOrigin(r: Range, seqLength: number): boolean {
  return r.end > seqLength;
}

/**
 * Normalize a base index into [0, L) for circular molecules. For linear molecules the
 * index is returned unchanged.
 */
export function normalizeIndex(i: number, seqLength: number, topology: Topology): number {
  return topology === 'circular' && seqLength > 0 ? mod(i, seqLength) : i;
}

/**
 * Normalize a gap position (cut site / caret). Circular: into [0, L). Linear: clamped to [0, L].
 */
export function normalizeGap(p: number, seqLength: number, topology: Topology): number {
  if (topology === 'circular') return seqLength > 0 ? mod(p, seqLength) : 0;
  return Math.max(0, Math.min(seqLength, p));
}

/**
 * Bring a range into normalized form.
 * Circular: 0 <= start < L, start <= end <= start + L (lengths >= L become the full circle starting at start).
 * Linear: clamped to [0, L] with start <= end.
 */
export function normalizeRange(r: Range, seqLength: number, topology: Topology): Range {
  if (topology === 'circular') {
    if (seqLength <= 0) return { start: 0, end: 0 };
    let len = r.end - r.start;
    if (len < 0) len = mod(len, seqLength); // tolerate start > end (wrap written the "other" way)
    if (len > seqLength) len = seqLength;
    const start = mod(r.start, seqLength);
    return { start, end: start + len };
  }
  const start = Math.max(0, Math.min(seqLength, Math.min(r.start, r.end)));
  const end = Math.max(0, Math.min(seqLength, Math.max(r.start, r.end)));
  return { start, end };
}

/**
 * Range from a start base index and an end base index, both INCLUSIVE, going 5'->3' on the
 * top strand from `first` to `last`. On circular molecules `last < first` means the range wraps.
 * Useful for converting 1-based inclusive "a..b" notation (pass a-1, b-1).
 */
export function rangeFromInclusive(first: number, last: number, seqLength: number, topology: Topology): Range {
  if (topology === 'circular' && last < first) return { start: first, end: last + 1 + seqLength };
  return { start: first, end: last + 1 };
}

/**
 * Split a (normalized) range into at most two non-wrapping pieces, each within [0, L].
 * Non-wrapping ranges are returned as a single piece.
 */
export function splitAtOrigin(r: Range, seqLength: number): Range[] {
  if (r.end <= seqLength) return [{ start: r.start, end: r.end }];
  return [
    { start: r.start, end: seqLength },
    { start: 0, end: r.end - seqLength },
  ];
}

/** Extract the top-strand sequence covered by a range (handles origin-wrapping ranges). */
export function sliceRange(seq: string, r: Range): string {
  const L = seq.length;
  if (r.end <= L) return seq.slice(r.start, r.end);
  // wrapping: may in principle wrap more than once if the caller passed a non-normalized range
  let out = seq.slice(r.start, L);
  let remaining = r.end - L;
  while (remaining > L) {
    out += seq;
    remaining -= L;
  }
  return out + seq.slice(0, remaining);
}

/** True if base index `i` lies inside range `r` (circular aware: `i` is compared modulo L). */
export function rangeContainsIndex(r: Range, i: number, seqLength: number, topology: Topology): boolean {
  if (topology === 'linear' || seqLength <= 0) return i >= r.start && i < r.end;
  const x = mod(i, seqLength);
  if (r.end - r.start >= seqLength) return true;
  if (x >= r.start && x < r.end) return true;
  return x + seqLength >= r.start && x + seqLength < r.end;
}

/** True if two ranges share at least one base (circular aware). */
export function rangesOverlap(a: Range, b: Range, seqLength: number, topology: Topology): boolean {
  if (a.end <= a.start || b.end <= b.start) return false;
  if (topology === 'linear' || seqLength <= 0) return a.start < b.end && b.start < a.end;
  for (const pa of splitAtOrigin(a, seqLength)) {
    for (const pb of splitAtOrigin(b, seqLength)) {
      if (pa.start < pb.end && pb.start < pa.end) return true;
    }
  }
  return false;
}

/**
 * Intersection of two ranges. On circular molecules two arcs can intersect in two disjoint
 * pieces, so the result is a list (empty when they do not overlap). Results are normalized.
 */
export function intersectRanges(a: Range, b: Range, seqLength: number, topology: Topology): Range[] {
  if (topology === 'linear' || seqLength <= 0) {
    const start = Math.max(a.start, b.start);
    const end = Math.min(a.end, b.end);
    return end > start ? [{ start, end }] : [];
  }
  const pieces: Range[] = [];
  for (const pa of splitAtOrigin(a, seqLength)) {
    for (const pb of splitAtOrigin(b, seqLength)) {
      const start = Math.max(pa.start, pb.start);
      const end = Math.min(pa.end, pb.end);
      if (end > start) pieces.push({ start, end });
    }
  }
  pieces.sort((x, y) => x.start - y.start);
  // merge pieces that touch across the origin (…L) + (0…) into one wrapping range
  if (pieces.length >= 2) {
    const last = pieces[pieces.length - 1];
    const first = pieces[0];
    if (last.end === seqLength && first.start === 0) {
      pieces.pop();
      pieces[0] = { start: last.start, end: seqLength + first.end };
      pieces.sort((x, y) => x.start - y.start);
    }
  }
  return pieces;
}

/**
 * The smallest range covering every given range, walking 5'->3' from `ranges[0].start`.
 * For circular molecules it assumes the ranges are listed in top-strand order (as feature
 * segments are). Useful for the overall extent of a multi-segment feature.
 */
export function coveringRange(ranges: readonly Range[], seqLength: number, topology: Topology): Range {
  if (ranges.length === 0) return { start: 0, end: 0 };
  if (topology === 'linear' || seqLength <= 0) {
    let start = Infinity;
    let end = -Infinity;
    for (const r of ranges) {
      start = Math.min(start, r.start);
      end = Math.max(end, r.end);
    }
    return { start, end };
  }
  const start = ranges[0].start;
  let end = ranges[0].end;
  for (let k = 1; k < ranges.length; k++) {
    const r = ranges[k];
    // unwrap r so that it lies at or after `start`
    let s = r.start;
    let e = r.end;
    while (s < start) {
      s += seqLength;
      e += seqLength;
    }
    end = Math.max(end, e);
  }
  if (end - start > seqLength) end = start + seqLength;
  return { start, end };
}

/** Shift a range by `delta` bases and normalize. */
export function shiftRange(r: Range, delta: number, seqLength: number, topology: Topology): Range {
  return normalizeRange({ start: r.start + delta, end: r.end + delta }, seqLength, topology);
}

/** Convert a range to 1-based inclusive display text, e.g. "101..250" (wrapping: "4901..100"). */
export function formatRange(r: Range, seqLength: number): string {
  if (r.end <= r.start) return `${r.start}^${r.start + 1}`;
  const first = r.start + 1;
  const last = r.end > seqLength ? r.end - seqLength : r.end;
  return `${first}..${last}`;
}
