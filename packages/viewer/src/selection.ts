/**
 * Selection model shared by every sequence visualization (circular map, linear map,
 * sequence view) and the application state. Keeping one model lets a selection made
 * in one view appear in all others.
 */
import type { Range, Topology } from '@hhereditas/core';
import { mod, normalizeRange } from '@hhereditas/core';

export interface SequenceSelection {
  /**
   * The selected bases (types.ts conventions). Zero length (start === end) means nothing
   * is selected and only a caret is shown at `start`. May wrap the origin on circular
   * sequences (end > length).
   */
  range: Range;
  /**
   * Gap position of the caret: the moving end of the selection (where typing inserts and
   * where shift+arrow extends from). Equals range.start or range.end (taken modulo the
   * length on circular sequences).
   */
  caret: number;
}

/** A caret with nothing selected. */
export function caretAt(gap: number): SequenceSelection {
  return { range: { start: gap, end: gap }, caret: gap };
}

/** Selection covering `range`, caret at its end. */
export function selectRange(range: Range, seqLength: number, topology: Topology): SequenceSelection {
  const r = normalizeRange(range, seqLength, topology);
  return { range: r, caret: topology === 'circular' && seqLength > 0 ? mod(r.end, seqLength) : r.end };
}

/** True when the selection contains at least one base. */
export function hasSelectedBases(sel: SequenceSelection | null | undefined): sel is SequenceSelection {
  return !!sel && sel.range.end > sel.range.start;
}

/**
 * The fixed end of a selection (opposite to the caret), used when extending with shift.
 */
export function selectionAnchor(sel: SequenceSelection, seqLength: number, topology: Topology): number {
  const startGap = sel.range.start;
  const endGap = topology === 'circular' && seqLength > 0 ? mod(sel.range.end, seqLength) : sel.range.end;
  return sel.caret === startGap ? endGap : startGap;
}

/**
 * Selection between an anchor gap and a head gap (e.g. while dragging).
 * Linear: the bases between them. Circular: the arc travelled 5'->3' from anchor to head
 * when `forward` is true (the default when head >= anchor), otherwise from head to anchor;
 * callers that track drag direction pass `forward` explicitly so a drag across the origin
 * selects the short wrapping arc.
 */
export function selectBetween(
  anchor: number,
  head: number,
  seqLength: number,
  topology: Topology,
  forward: boolean = head >= anchor,
): SequenceSelection {
  if (topology === 'linear' || seqLength <= 0) {
    const a = Math.max(0, Math.min(seqLength, anchor));
    const h = Math.max(0, Math.min(seqLength, head));
    return { range: { start: Math.min(a, h), end: Math.max(a, h) }, caret: h };
  }
  const a = mod(anchor, seqLength);
  const h = mod(head, seqLength);
  if (a === h) return { range: { start: a, end: a }, caret: h };
  const range = forward
    ? { start: a, end: h > a ? h : h + seqLength }
    : { start: h, end: a > h ? a : a + seqLength };
  return { range, caret: h };
}
