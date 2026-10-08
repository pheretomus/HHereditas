/**
 * Keyboard and clipboard handling of the sequence view, as pure functions: a key press (or
 * typed / pasted text) plus the current selection gives an intent: a new selection, an edit
 * (with the selection to show after it) or nothing. The component only dispatches intents.
 *
 * Carets live on gap positions (types.ts). On circular records gap 0 and gap L are the same
 * place; `affinity` says where such a caret is drawn: 'upstream' at the end of the previous
 * row (the end of the last row for the origin), 'downstream' at the start of the next row.
 */
import type { Range, Topology } from '@hhereditas/core';
import { mod, normalizeDna, normalizeRange, sliceRange } from '@hhereditas/core';
import type { SequenceSelection } from '../selection';
import { caretAt, hasSelectedBases, selectBetween, selectionAnchor } from '../selection';
import type { SequenceEdit } from './types';

export type CaretAffinity = 'upstream' | 'downstream';

export interface EditingContext {
  /** Sequence length L. */
  length: number;
  topology: Topology;
  basesPerRow: number;
  editable: boolean;
}

export interface KeyInput {
  key: string;
  shiftKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
}

export type KeyIntent =
  /** Move the caret / change the selection (then scroll it into view). */
  | { type: 'select'; selection: SequenceSelection; affinity: CaretAffinity }
  /** Ask the app to edit; `selection` is where the caret goes in the edited sequence. */
  | { type: 'edit'; edit: SequenceEdit; selection: SequenceSelection; affinity: CaretAffinity }
  /** Scroll one page. */
  | { type: 'page'; direction: -1 | 1 }
  /** Handled, nothing to do (e.g. Backspace at the start of a linear sequence). */
  | { type: 'handled' }
  /** Not ours: let the browser / app handle the key. */
  | { type: 'unhandled' };

export type TextIntent =
  | { type: 'edit'; edit: SequenceEdit; selection: SequenceSelection; affinity: CaretAffinity }
  | { type: 'invalid'; text: string }
  | { type: 'none' };

const isCircular = (ctx: EditingContext) => ctx.topology === 'circular' && ctx.length > 0;

/** Caret as a gap in [0, L], resolving the circular origin with the affinity. */
export function caretGap(sel: SequenceSelection | null | undefined, ctx: EditingContext, affinity: CaretAffinity): number {
  const L = ctx.length;
  if (!sel) return 0;
  if (isCircular(ctx)) {
    const c = mod(sel.caret, L);
    return c === 0 && affinity === 'upstream' ? L : c;
  }
  return Math.max(0, Math.min(L, sel.caret));
}

/** Bases [start, end) of the row in which a caret at gap `gap` is drawn. */
export function caretRow(gap: number, affinity: CaretAffinity, ctx: EditingContext): { start: number; end: number } {
  const N = Math.max(1, ctx.basesPerRow);
  const L = ctx.length;
  let r: number;
  if (L === 0) r = 0;
  else if (gap >= L) r = Math.ceil(L / N) - 1;
  else if (gap > 0 && gap % N === 0 && affinity === 'upstream') r = gap / N - 1;
  else r = Math.floor(gap / N);
  return { start: r * N, end: Math.min(L, r * N + N) };
}

/** Caret selection at absolute gap `g` (may lie outside [0, L] on circular records: it wraps). */
function placeCaret(g: number, ctx: EditingContext, affinity: CaretAffinity): { selection: SequenceSelection; affinity: CaretAffinity } {
  const L = ctx.length;
  if (isCircular(ctx)) {
    const c = mod(g, L);
    // landing exactly on the origin while moving forward keeps the caret at the end of the last row
    const aff: CaretAffinity = c === 0 && g !== 0 && g >= L ? 'upstream' : c === 0 ? 'downstream' : affinity;
    return { selection: caretAt(c), affinity: aff };
  }
  const c = Math.max(0, Math.min(L, g));
  return { selection: caretAt(c), affinity };
}

/** Signed number of bases from the anchor to the caret (negative when the caret is the start). */
function signedLength(sel: SequenceSelection, ctx: EditingContext): number {
  const len = sel.range.end - sel.range.start;
  if (len <= 0) return 0;
  if (isCircular(ctx)) {
    const L = ctx.length;
    const endGap = mod(sel.range.end, L);
    if (mod(sel.caret, L) === endGap) return len; // includes the full circle (start == end mod L)
    return -len;
  }
  return sel.caret === sel.range.start ? -len : len;
}

/**
 * Selection from the fixed anchor of `sel` stretched by `delta` bases at its moving end.
 * On circular records the selection may wrap the origin (shift+left at gap 0 selects the last base).
 */
export function extendBy(sel: SequenceSelection, delta: number, ctx: EditingContext): SequenceSelection {
  const L = ctx.length;
  if (!isCircular(ctx)) {
    const anchor = selectionAnchor(sel, L, ctx.topology);
    return selectBetween(anchor, sel.caret + delta, L, 'linear');
  }
  const anchor = mod(selectionAnchor(sel, L, 'circular'), L);
  const d = Math.max(-L, Math.min(L, signedLength(sel, ctx) + delta));
  if (d === 0) return caretAt(anchor);
  if (d === L) return { range: { start: anchor, end: anchor + L }, caret: anchor };
  if (d === -L) return { range: { start: anchor, end: anchor + L }, caret: anchor };
  return selectBetween(anchor, anchor + d, L, 'circular', d > 0);
}

/**
 * Shift+click / drag extension to gap `head`. Keeps the direction of a selection that already
 * wraps the origin; otherwise selects the bases between the anchor and the head.
 */
export function extendSelectionTo(
  sel: SequenceSelection | null | undefined,
  head: number,
  ctx: EditingContext,
): SequenceSelection {
  const L = ctx.length;
  if (!sel) return caretAt(head);
  const anchor = selectionAnchor(sel, L, ctx.topology);
  if (isCircular(ctx) && sel.range.end > L) {
    const forward = signedLength(sel, ctx) > 0;
    return selectBetween(anchor, head, L, 'circular', forward);
  }
  return selectBetween(anchor, head, L, ctx.topology);
}

/** Smallest selection covering `sel` and `range` (shift+click on a feature). */
export function coverSelection(sel: SequenceSelection | null | undefined, range: Range, ctx: EditingContext): SequenceSelection {
  const L = ctx.length;
  const r = normalizeRange(range, L, ctx.topology);
  if (!sel) return { range: r, caret: isCircular(ctx) ? mod(r.end, L) : r.end };
  const a = normalizeRange(sel.range, L, ctx.topology);
  if (!isCircular(ctx)) {
    const start = Math.min(a.start, r.start);
    const end = Math.max(a.end, r.end);
    return { range: { start, end }, caret: r.start < a.start ? start : end };
  }
  // circular: the minimal covering arc starts at the start of one of the two ranges
  const cover = (start: number): Range => {
    let end = start;
    for (const x of [a, r]) {
      const xs = start + mod(x.start - start, L);
      end = Math.max(end, xs + (x.end - x.start));
    }
    return { start, end: Math.min(start + L, end) };
  };
  const fromSelection = cover(a.start);
  const fromRange = cover(r.start);
  const best = fromSelection.end - fromSelection.start <= fromRange.end - fromRange.start ? fromSelection : fromRange;
  const range2 = normalizeRange(best, L, 'circular');
  return { range: range2, caret: best === fromSelection ? mod(range2.end, L) : range2.start };
}

/** Text placed on the clipboard for a selection: its top-strand bases ('' when nothing is selected). */
export function copyText(seq: string, sel: SequenceSelection | null | undefined): string {
  if (!hasSelectedBases(sel)) return '';
  return sliceRange(seq, sel.range);
}

/**
 * Clean typed or pasted text into bases with normalizeDna (whitespace, digits and separators
 * are dropped, U -> T, upper case). FASTA header / comment lines are ignored. Any other
 * character makes the whole input invalid.
 */
export function cleanSequenceInput(text: string): { bases: string; invalid: string[] } {
  const body = /^\s*[>;]/.test(text)
    ? text
        .split(/\r?\n/)
        .filter((line) => !/^\s*[>;]/.test(line))
        .join('\n')
    : text;
  const { seq, invalid } = normalizeDna(body);
  return { bases: seq, invalid };
}

/** Where the caret goes after an edit (core semantics of insertBases / deleteRange / replaceRange). */
export function selectionAfterEdit(
  edit: SequenceEdit,
  ctx: EditingContext,
): { selection: SequenceSelection; affinity: CaretAffinity } {
  const L = ctx.length;
  const circular = isCircular(ctx);
  switch (edit.kind) {
    case 'insert': {
      const n = edit.bases.length;
      if (ctx.topology === 'circular') {
        const newL = L + n;
        // gap 0 == gap L: the core appends at L; the caret stays at the origin on the side it was drawn
        if (L === 0 || edit.gap === L) return { selection: caretAt(0), affinity: 'upstream' };
        if (edit.gap === 0) return { selection: caretAt(0), affinity: 'downstream' };
        return { selection: caretAt(mod(edit.gap + n, newL)), affinity: 'downstream' };
      }
      return { selection: caretAt(edit.gap + n), affinity: 'downstream' };
    }
    case 'delete': {
      if (circular && edit.range.end > L) return { selection: caretAt(0), affinity: 'downstream' };
      return { selection: caretAt(edit.range.start), affinity: 'downstream' };
    }
    case 'replace': {
      const n = edit.bases.length;
      if (circular) {
        const newL = L - (edit.range.end - edit.range.start) + n;
        // a replaced region that contains the original first base starts the new sequence
        const g = edit.range.end > L ? n : edit.range.start + n;
        if (newL > 0 && g >= newL) return { selection: caretAt(0), affinity: 'upstream' };
        return { selection: caretAt(g), affinity: 'downstream' };
      }
      return { selection: caretAt(edit.range.start + n), affinity: 'downstream' };
    }
  }
}

function editIntent(edit: SequenceEdit, ctx: EditingContext): Extract<KeyIntent, { type: 'edit' }> {
  const after = selectionAfterEdit(edit, ctx);
  return { type: 'edit', edit, selection: after.selection, affinity: after.affinity };
}

/** Insert (caret) or replace (selection) with already clean bases. */
export function insertIntent(
  bases: string,
  sel: SequenceSelection | null | undefined,
  ctx: EditingContext,
  affinity: CaretAffinity = 'downstream',
): Extract<KeyIntent, { type: 'edit' }> {
  if (hasSelectedBases(sel)) {
    const range = normalizeRange(sel.range, ctx.length, ctx.topology);
    return editIntent({ kind: 'replace', range, bases }, ctx);
  }
  return editIntent({ kind: 'insert', gap: caretGap(sel, ctx, affinity), bases }, ctx);
}

/** Typed text (keyboard / IME) or pasted text. */
export function textIntent(
  text: string,
  sel: SequenceSelection | null | undefined,
  ctx: EditingContext,
  affinity: CaretAffinity = 'downstream',
): TextIntent {
  if (!ctx.editable) return { type: 'none' };
  const { bases, invalid } = cleanSequenceInput(text);
  if (invalid.length > 0) return { type: 'invalid', text };
  if (bases === '') return { type: 'none' };
  return insertIntent(bases, sel, ctx, affinity);
}

/** Backspace (backward) / Delete (forward): the selection, or one base next to the caret. */
export function deleteIntent(
  direction: 'backward' | 'forward',
  sel: SequenceSelection | null | undefined,
  ctx: EditingContext,
  affinity: CaretAffinity = 'downstream',
): Extract<KeyIntent, { type: 'edit' }> | null {
  if (!ctx.editable) return null;
  const L = ctx.length;
  if (hasSelectedBases(sel)) return editIntent({ kind: 'delete', range: normalizeRange(sel.range, L, ctx.topology) }, ctx);
  if (L === 0) return null;
  const g = caretGap(sel, ctx, affinity);
  if (isCircular(ctx)) {
    const c = mod(g, L);
    const range = direction === 'backward' ? (c === 0 ? { start: L - 1, end: L } : { start: c - 1, end: c }) : { start: c, end: c + 1 };
    return editIntent({ kind: 'delete', range }, ctx);
  }
  if (direction === 'backward') return g > 0 ? editIntent({ kind: 'delete', range: { start: g - 1, end: g } }, ctx) : null;
  return g < L ? editIntent({ kind: 'delete', range: { start: g, end: g + 1 } }, ctx) : null;
}

/** Cut: the text to copy plus the deletion (null when nothing is selected or the view is read-only). */
export function cutIntent(
  seq: string,
  sel: SequenceSelection | null | undefined,
  ctx: EditingContext,
): { text: string; intent: Extract<KeyIntent, { type: 'edit' }> } | null {
  if (!ctx.editable || !hasSelectedBases(sel)) return null;
  const intent = deleteIntent('backward', sel, ctx);
  return intent ? { text: copyText(seq, sel), intent } : null;
}

/**
 * Target of a caret movement key as an absolute gap (outside [0, L] when it wraps the origin of
 * a circular record) and the affinity to draw it with; null if the key does not move the caret.
 */
function movement(
  input: KeyInput,
  from: number,
  affinity: CaretAffinity,
  ctx: EditingContext,
  mac: boolean,
): { target: number; affinity: CaretAffinity } | null {
  const L = ctx.length;
  const N = Math.max(1, ctx.basesPerRow);
  const G = 10;
  const row = caretRow(from, affinity, ctx);
  const lineMod = mac ? !!input.metaKey : false; // cmd+arrows on macOS
  const docMod = mac ? !!input.metaKey : !!input.ctrlKey;
  const wordMod = mac ? !!input.altKey : !!input.ctrlKey;
  switch (input.key) {
    case 'ArrowLeft':
      if (lineMod) return { target: row.start, affinity: 'downstream' };
      if (wordMod) return { target: from % G === 0 ? from - G : from - (from % G), affinity: 'downstream' };
      return { target: from - 1, affinity: 'downstream' };
    case 'ArrowRight':
      if (lineMod) return { target: row.end, affinity: 'upstream' };
      if (wordMod) return { target: from + (G - (from % G)), affinity: 'downstream' };
      return { target: from + 1, affinity: 'downstream' };
    case 'ArrowUp': {
      if (mac && input.metaKey) return { target: 0, affinity: 'downstream' };
      if (row.start === 0) return { target: 0, affinity: 'downstream' };
      const col = from - row.start;
      const prevStart = row.start - N;
      return { target: prevStart + Math.min(col, N), affinity: col >= N ? 'upstream' : 'downstream' };
    }
    case 'ArrowDown': {
      if (mac && input.metaKey) return { target: L, affinity: 'upstream' };
      const col = from - row.start;
      const nextStart = row.start + N;
      if (nextStart >= L) return { target: L, affinity: 'upstream' };
      const nextEnd = Math.min(L, nextStart + N);
      return { target: Math.min(nextEnd, nextStart + col), affinity: col >= N || nextStart + col >= nextEnd ? 'upstream' : 'downstream' };
    }
    case 'Home':
      return docMod ? { target: 0, affinity: 'downstream' } : { target: row.start, affinity: 'downstream' };
    case 'End':
      return docMod ? { target: L, affinity: 'upstream' } : { target: row.end, affinity: 'upstream' };
    default:
      return null;
  }
}

/**
 * Intent of a key press. `mac` selects the platform shortcuts (cmd vs ctrl); cmd/ctrl+A selects
 * everything on both. Printable keys are not handled here: text arrives via textIntent().
 */
export function keyIntent(
  input: KeyInput,
  sel: SequenceSelection | null | undefined,
  ctx: EditingContext,
  affinity: CaretAffinity = 'downstream',
  mac = false,
): KeyIntent {
  const L = ctx.length;
  const key = input.key;

  if ((key === 'a' || key === 'A') && (input.metaKey || input.ctrlKey) && !input.altKey) {
    if (L === 0) return { type: 'select', selection: caretAt(0), affinity: 'downstream' };
    return isCircular(ctx)
      ? { type: 'select', selection: { range: { start: 0, end: L }, caret: 0 }, affinity: 'upstream' }
      : { type: 'select', selection: { range: { start: 0, end: L }, caret: L }, affinity: 'upstream' };
  }
  if (key === 'Escape') {
    if (!hasSelectedBases(sel)) return { type: 'unhandled' };
    return { type: 'select', selection: caretAt(sel.caret), affinity };
  }
  if (key === 'PageUp' || key === 'PageDown') return { type: 'page', direction: key === 'PageUp' ? -1 : 1 };
  if (key === 'Backspace' || key === 'Delete') {
    if (!ctx.editable) return { type: 'handled' };
    return deleteIntent(key === 'Backspace' ? 'backward' : 'forward', sel, ctx, affinity) ?? { type: 'handled' };
  }
  if (key === 'Enter' || key === 'Tab') return key === 'Enter' ? { type: 'handled' } : { type: 'unhandled' };

  const current = sel ?? caretAt(0);
  const from = caretGap(current, ctx, affinity);
  const hasBases = hasSelectedBases(current);

  // plain left/right with a selection collapse it to its start / end
  if (!input.shiftKey && hasBases && (key === 'ArrowLeft' || key === 'ArrowRight') && !input.altKey && !input.metaKey && !input.ctrlKey) {
    const r = normalizeRange(current.range, L, ctx.topology);
    if (key === 'ArrowLeft') return { type: 'select', selection: caretAt(r.start), affinity: 'downstream' };
    if (isCircular(ctx)) {
      const end = mod(r.end, L);
      return { type: 'select', selection: caretAt(end), affinity: end === 0 ? 'upstream' : 'downstream' };
    }
    return { type: 'select', selection: caretAt(r.end), affinity: r.end % ctx.basesPerRow === 0 ? 'upstream' : 'downstream' };
  }

  let origin = from;
  if (!input.shiftKey && hasBases && (key === 'ArrowUp' || key === 'ArrowDown')) {
    const r = normalizeRange(current.range, L, ctx.topology);
    origin = key === 'ArrowUp' ? r.start : isCircular(ctx) && r.end > L ? r.end - L : r.end;
  }
  const move = movement(input, origin, affinity, ctx, mac);
  if (!move) return { type: 'unhandled' };

  if (input.shiftKey) {
    const delta = move.target - from;
    const next = extendBy(current, delta, ctx);
    return { type: 'select', selection: next, affinity: move.affinity };
  }
  const placed = placeCaret(move.target, ctx, move.affinity);
  return { type: 'select', selection: placed.selection, affinity: placed.affinity };
}
