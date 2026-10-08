/**
 * Selection geometry for the linear map. The map draws the record from base 1 to the end, so a
 * selection that wraps the origin of a circular record appears as two pieces, one at each end.
 */
import type { Range, Topology } from '@hhereditas/core';
import { mod, normalizeRange } from '@hhereditas/core';
import type { SequenceSelection } from '../selection';
import { selectBetween, selectRange, selectionAnchor } from '../selection';

export interface SelectionPiece {
  start: number;
  end: number;
  /** False where the piece is cut by the origin (the selection continues at the other end). */
  startEdge: boolean;
  endEdge: boolean;
}

/** Pieces (within [0, L]) of a selected range: two when it wraps the origin of a circular record. */
export function selectionPieces(range: Range, seqLength: number, topology: Topology): SelectionPiece[] {
  if (seqLength <= 0) return [];
  const r = normalizeRange(range, seqLength, topology);
  if (r.end <= r.start) return [];
  if (topology === 'circular' && r.end > seqLength) {
    if (r.end - r.start >= seqLength) return [{ start: 0, end: seqLength, startEdge: true, endEdge: true }];
    return [
      { start: r.start, end: seqLength, startEdge: true, endEdge: false },
      { start: 0, end: r.end - seqLength, startEdge: false, endEdge: true },
    ];
  }
  return [{ start: r.start, end: r.end, startEdge: true, endEdge: true }];
}

/** Gap positions at which to draw the caret: both ends of the map for the origin of a circular record. */
export function caretPositions(gap: number, seqLength: number, topology: Topology): number[] {
  if (topology === 'circular' && seqLength > 0) {
    const g = mod(gap, seqLength);
    return g === 0 ? [0, seqLength] : [g];
  }
  return [Math.max(0, Math.min(seqLength, gap))];
}

/**
 * Smallest range covering both `a` and `b`, as seen on the map: their span from the leftmost
 * start to the rightmost end. On a circular record, if either range already wraps the origin,
 * the shortest arc covering both is used instead (so the wrap is kept).
 */
export function coverRange(a: Range, b: Range, seqLength: number, topology: Topology): Range {
  const L = seqLength;
  const ra = normalizeRange(a, L, topology);
  const rb = normalizeRange(b, L, topology);
  if (topology === 'linear' || L <= 0 || (ra.end <= L && rb.end <= L)) {
    return { start: Math.min(ra.start, rb.start), end: Math.max(ra.end, rb.end) };
  }
  // Circular and something wraps: the complement of the largest gap not covered by either arc.
  const covered = (p: number) =>
    [ra, rb].some((r) => r.end - r.start >= L || mod(p - r.start, L) < r.end - r.start);
  const points = [...new Set([ra.start, mod(ra.end, L), rb.start, mod(rb.end, L)])].sort((x, y) => x - y);
  let best: { start: number; len: number } | null = null;
  for (let i = 0; i < points.length; i++) {
    const s = points[i];
    const e = i + 1 < points.length ? points[i + 1] : points[0] + L;
    const len = e - s;
    if (len > 0 && !covered(s + len / 2) && (!best || len > best.len)) best = { start: s, len };
  }
  if (!best) return { start: ra.start, end: ra.start + L };
  const start = mod(best.start + best.len, L);
  return { start, end: start + (L - best.len) };
}

/**
 * The selection extended from its anchor (the end opposite the caret) to gap `gap`, as with
 * shift+click. It runs straight along the map; only a selection that already wraps the origin
 * of a circular record keeps wrapping (it takes the shorter way round from its anchor).
 */
export function extendSelection(sel: SequenceSelection, gap: number, seqLength: number, topology: Topology): SequenceSelection {
  const L = seqLength;
  const anchor = selectionAnchor(sel, L, topology);
  if (topology === 'circular' && L > 0 && sel.range.end > L) {
    const head = mod(gap, L);
    let offset = mod(head - anchor, L);
    if (offset > L / 2) offset -= L;
    return selectBetween(anchor, head, L, topology, offset >= 0);
  }
  const head = topology === 'circular' ? Math.max(0, Math.min(L, gap)) : gap;
  return selectBetween(anchor, head, L, topology, head >= anchor);
}

/**
 * Selection after shift+clicking an item covering `range`: the current selection (or the span
 * from the caret) grown to cover it.
 */
export function extendSelectionToRange(
  sel: SequenceSelection | null,
  range: Range,
  seqLength: number,
  topology: Topology,
): SequenceSelection {
  if (!sel) return selectRange(range, seqLength, topology);
  return selectRange(coverRange(sel.range, range, seqLength, topology), seqLength, topology);
}
