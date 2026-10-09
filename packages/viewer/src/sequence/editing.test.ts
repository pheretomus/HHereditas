import { describe, expect, it } from 'vitest';
import { caretAt } from '../selection';
import type { EditingContext, KeyInput } from './editing';
import {
  caretGap,
  cleanSequenceInput,
  copyText,
  coverSelection,
  cutIntent,
  deleteIntent,
  extendBy,
  extendSelectionTo,
  keyIntent,
  selectionAfterEdit,
  textIntent,
} from './editing';

const lin = (length: number, editable = true, basesPerRow = 10): EditingContext => ({ length, topology: 'linear', basesPerRow, editable });
const circ = (length: number, editable = true, basesPerRow = 10): EditingContext => ({
  length,
  topology: 'circular',
  basesPerRow,
  editable,
});
const key = (k: string, mods: Omit<KeyInput, 'key'> = {}): KeyInput => ({ key: k, ...mods });
const sel = (start: number, end: number, caret: number) => ({ range: { start, end }, caret });

describe('caret movement', () => {
  it('moves one base left / right and stops at the ends of a linear sequence', () => {
    expect(keyIntent(key('ArrowRight'), caretAt(5), lin(30))).toMatchObject({ type: 'select', selection: caretAt(6) });
    expect(keyIntent(key('ArrowLeft'), caretAt(5), lin(30))).toMatchObject({ type: 'select', selection: caretAt(4) });
    expect(keyIntent(key('ArrowLeft'), caretAt(0), lin(30))).toMatchObject({ selection: caretAt(0) });
    expect(keyIntent(key('ArrowRight'), caretAt(30), lin(30))).toMatchObject({ selection: caretAt(30) });
  });

  it('wraps around the origin of a circular sequence', () => {
    expect(keyIntent(key('ArrowLeft'), caretAt(0), circ(30))).toMatchObject({ selection: caretAt(29), affinity: 'downstream' });
    // moving past the last base reaches the origin, drawn at the end of the last row
    expect(keyIntent(key('ArrowRight'), caretAt(29), circ(30))).toMatchObject({ selection: caretAt(0), affinity: 'upstream' });
    // ... and one more step moves past the first base
    expect(keyIntent(key('ArrowRight'), caretAt(0), circ(30), 'upstream')).toMatchObject({ selection: caretAt(1) });
  });

  it('moves by a row with up / down, keeping the column', () => {
    expect(keyIntent(key('ArrowDown'), caretAt(13), lin(45))).toMatchObject({ selection: caretAt(23) });
    expect(keyIntent(key('ArrowUp'), caretAt(23), lin(45))).toMatchObject({ selection: caretAt(13) });
    // first row: to the start; last row: to the end
    expect(keyIntent(key('ArrowUp'), caretAt(4), lin(45))).toMatchObject({ selection: caretAt(0) });
    expect(keyIntent(key('ArrowDown'), caretAt(43), lin(45))).toMatchObject({ selection: caretAt(45) });
    // into a shorter last row: clamped to its end
    expect(keyIntent(key('ArrowDown'), caretAt(38), lin(45))).toMatchObject({ selection: caretAt(45), affinity: 'upstream' });
    // a caret drawn at the end of a row stays at the end of rows
    expect(keyIntent(key('ArrowUp'), caretAt(30), lin(45), 'upstream')).toMatchObject({ selection: caretAt(20), affinity: 'upstream' });
  });

  it('goes to the row start / end with Home / End and to the sequence ends with ctrl (cmd on macOS)', () => {
    expect(keyIntent(key('Home'), caretAt(27), lin(45))).toMatchObject({ selection: caretAt(20) });
    expect(keyIntent(key('End'), caretAt(27), lin(45))).toMatchObject({ selection: caretAt(30), affinity: 'upstream' });
    expect(keyIntent(key('Home', { ctrlKey: true }), caretAt(27), lin(45))).toMatchObject({ selection: caretAt(0) });
    expect(keyIntent(key('End', { ctrlKey: true }), caretAt(27), lin(45))).toMatchObject({ selection: caretAt(45) });
    const mac = true;
    expect(keyIntent(key('ArrowLeft', { metaKey: true }), caretAt(27), lin(45), 'downstream', mac)).toMatchObject({ selection: caretAt(20) });
    expect(keyIntent(key('ArrowRight', { metaKey: true }), caretAt(27), lin(45), 'downstream', mac)).toMatchObject({ selection: caretAt(30) });
    expect(keyIntent(key('ArrowUp', { metaKey: true }), caretAt(27), lin(45), 'downstream', mac)).toMatchObject({ selection: caretAt(0) });
    expect(keyIntent(key('ArrowDown', { metaKey: true }), caretAt(27), lin(45), 'downstream', mac)).toMatchObject({ selection: caretAt(45) });
  });

  it('jumps by groups of 10 bases with option (macOS) / ctrl (elsewhere)', () => {
    expect(keyIntent(key('ArrowRight', { altKey: true }), caretAt(13), lin(45, true, 30), 'downstream', true)).toMatchObject({ selection: caretAt(20) });
    expect(keyIntent(key('ArrowLeft', { ctrlKey: true }), caretAt(13), lin(45, true, 30))).toMatchObject({ selection: caretAt(10) });
    expect(keyIntent(key('ArrowLeft', { ctrlKey: true }), caretAt(10), lin(45, true, 30))).toMatchObject({ selection: caretAt(0) });
  });

  it('collapses a selection to its start / end with plain left / right', () => {
    expect(keyIntent(key('ArrowLeft'), sel(5, 12, 12), lin(30))).toMatchObject({ selection: caretAt(5) });
    expect(keyIntent(key('ArrowRight'), sel(5, 12, 5), lin(30))).toMatchObject({ selection: caretAt(12) });
    // a wrapping selection collapses to its end after the origin
    expect(keyIntent(key('ArrowRight'), sel(25, 33, 3), circ(30))).toMatchObject({ selection: caretAt(3) });
  });

  it('selects everything with cmd/ctrl+A and collapses with Escape', () => {
    expect(keyIntent(key('a', { ctrlKey: true }), caretAt(4), lin(30))).toMatchObject({ selection: sel(0, 30, 30) });
    expect(keyIntent(key('a', { metaKey: true }), caretAt(4), circ(30))).toMatchObject({ selection: sel(0, 30, 0) });
    expect(keyIntent(key('Escape'), sel(5, 12, 12), lin(30))).toMatchObject({ selection: caretAt(12) });
    expect(keyIntent(key('Escape'), caretAt(12), lin(30))).toEqual({ type: 'unhandled' });
  });

  it('leaves printable keys, Tab and clipboard shortcuts to the browser', () => {
    expect(keyIntent(key('g'), caretAt(3), lin(30))).toEqual({ type: 'unhandled' });
    expect(keyIntent(key('Tab'), caretAt(3), lin(30))).toEqual({ type: 'unhandled' });
    expect(keyIntent(key('c', { metaKey: true }), sel(1, 5, 5), lin(30))).toEqual({ type: 'unhandled' });
    expect(keyIntent(key('v', { ctrlKey: true }), caretAt(3), lin(30))).toEqual({ type: 'unhandled' });
    expect(keyIntent(key('PageDown'), caretAt(3), lin(30))).toEqual({ type: 'page', direction: 1 });
  });
});

describe('selection extension', () => {
  it('extends and shrinks with shift+arrows', () => {
    const a = keyIntent(key('ArrowRight', { shiftKey: true }), caretAt(5), lin(30));
    expect(a).toMatchObject({ selection: sel(5, 6, 6) });
    const b = keyIntent(key('ArrowDown', { shiftKey: true }), sel(5, 6, 6), lin(30));
    expect(b).toMatchObject({ selection: sel(5, 16, 16) });
    const c = keyIntent(key('ArrowLeft', { shiftKey: true }), sel(5, 6, 6), lin(30));
    expect(c).toMatchObject({ selection: caretAt(5) });
    const d = keyIntent(key('ArrowLeft', { shiftKey: true }), caretAt(5), lin(30));
    expect(d).toMatchObject({ selection: sel(4, 5, 4) });
  });

  it('extends across the origin of a circular sequence', () => {
    // shift+left from the caret at 0 selects the last base
    expect(keyIntent(key('ArrowLeft', { shiftKey: true }), caretAt(0), circ(30))).toMatchObject({ selection: sel(29, 30, 29) });
    // and keeps going backwards
    expect(extendBy(sel(29, 30, 29), -2, circ(30))).toEqual(sel(27, 30, 27));
    // a forward selection ending at the origin grows past it (end > L)
    expect(extendBy(sel(27, 30, 0), 2, circ(30))).toEqual(sel(27, 32, 2));
    // shrinking back over the origin
    expect(extendBy(sel(27, 32, 2), -4, circ(30))).toEqual(sel(27, 28, 28));
    // never more than the whole circle
    expect(extendBy(sel(0, 29, 29), 5, circ(30))).toEqual(sel(0, 30, 0));
  });

  it('does not wrap linear sequences', () => {
    expect(keyIntent(key('ArrowLeft', { shiftKey: true }), caretAt(0), lin(30))).toMatchObject({ selection: caretAt(0) });
    expect(extendBy(sel(25, 30, 30), 3, lin(30))).toEqual(sel(25, 30, 30));
  });

  it('extends to a clicked gap from the fixed end (shift+click)', () => {
    expect(extendSelectionTo(sel(5, 10, 10), 20, lin(30))).toEqual(sel(5, 20, 20));
    expect(extendSelectionTo(sel(5, 10, 10), 2, lin(30))).toEqual(sel(2, 5, 2));
    expect(extendSelectionTo(sel(5, 10, 5), 2, lin(30))).toEqual(sel(2, 10, 2));
    expect(extendSelectionTo(null, 7, lin(30))).toEqual(caretAt(7));
    // a selection that wraps the origin keeps wrapping
    expect(extendSelectionTo(sel(25, 33, 3), 6, circ(30))).toEqual(sel(25, 36, 6));
    expect(extendSelectionTo(sel(25, 33, 25), 20, circ(30))).toEqual(sel(20, 33, 20));
  });

  it('moves the head of a wrapping selection the short way, flipping through the anchor (review: shift+click after wrap)', () => {
    const L = 3938;
    // caret at gap 3, shift+left x6: 3935..3941 with the anchor at gap 3
    const wrapped = sel(3935, 3941, 3935);
    // shift+click at gap 10: the 7 bases after the anchor, as the keyboard and a drag give, not 3,931 bp
    expect(extendSelectionTo(wrapped, 10, circ(L))).toEqual(sel(3, 10, 10));
    // a head that stays on the wrapping side keeps wrapping
    expect(extendSelectionTo(wrapped, L - 10, circ(L))).toEqual(sel(L - 10, L + 3, L - 10));
    // back onto the anchor: a caret
    expect(extendSelectionTo(wrapped, 3, circ(L))).toEqual(caretAt(3));
    // forward wrapping selection: extending further keeps it, crossing back over the anchor flips it
    expect(extendSelectionTo(sel(25, 33, 3), 12, circ(30))).toEqual(sel(25, 42, 12));
    expect(extendSelectionTo(sel(25, 33, 3), 22, circ(30))).toEqual(sel(22, 25, 22));
    // consistent with the keyboard path from the same selection
    let k = wrapped;
    for (let i = 0; i < 13; i++) k = extendBy(k, 1, circ(L));
    expect(k).toEqual(extendSelectionTo(wrapped, 10, circ(L)));
  });

  it('covers the selection and an annotation (shift+click on a feature)', () => {
    expect(coverSelection(sel(5, 10, 10), { start: 20, end: 25 }, lin(30))).toEqual(sel(5, 25, 25));
    expect(coverSelection(sel(20, 25, 25), { start: 2, end: 6 }, lin(30))).toEqual(sel(2, 25, 2));
    // circular: the shorter covering arc, across the origin
    expect(coverSelection(sel(26, 28, 28), { start: 1, end: 3 }, circ(30))).toEqual(sel(26, 33, 3));
  });
});

describe('edit intents', () => {
  it('inserts typed IUPAC letters at the caret, upper-cased', () => {
    expect(textIntent('g', caretAt(4), lin(30))).toMatchObject({
      type: 'edit',
      edit: { kind: 'insert', gap: 4, bases: 'G' },
      selection: caretAt(5),
    });
    expect(textIntent('n', caretAt(0), lin(30))).toMatchObject({ edit: { kind: 'insert', gap: 0, bases: 'N' } });
    expect(textIntent('u', caretAt(0), lin(30))).toMatchObject({ edit: { kind: 'insert', gap: 0, bases: 'T' } });
  });

  it('replaces the selection with typed or pasted bases', () => {
    expect(textIntent('acgt', sel(3, 9, 9), lin(30))).toMatchObject({
      edit: { kind: 'replace', range: { start: 3, end: 9 }, bases: 'ACGT' },
      selection: caretAt(7),
    });
    // a wrapping selection is replaced as one range (end > L)
    expect(textIntent('TT', sel(27, 33, 3), circ(30))).toMatchObject({
      edit: { kind: 'replace', range: { start: 27, end: 33 }, bases: 'TT' },
      selection: caretAt(2),
    });
  });

  it('cleans pasted text: whitespace, digits, FASTA headers', () => {
    expect(cleanSequenceInput('>seq1 test\nacgt acgt\n10 ggcc\r\n')).toEqual({ bases: 'ACGTACGTGGCC', invalid: [] });
    expect(textIntent('  1 atg 61 \n', caretAt(2), lin(30))).toMatchObject({ edit: { kind: 'insert', gap: 2, bases: 'ATG' } });
    expect(textIntent(' 12 \n', caretAt(2), lin(30))).toEqual({ type: 'none' });
  });

  it('cleans RNA and protein input with their own alphabets', () => {
    expect(cleanSequenceInput('acgt u', 'RNA')).toEqual({ bases: 'ACGUU', invalid: [] });
    expect(cleanSequenceInput('mkv le*\n12 w', 'protein')).toEqual({ bases: 'MKVLE*W', invalid: [] });
    expect(cleanSequenceInput('MK-V', 'protein').invalid).toEqual(['-']);
    expect(textIntent('e', caretAt(2), { ...lin(30), molecule: 'protein' })).toMatchObject({ edit: { kind: 'insert', bases: 'E' } });
    expect(textIntent('t', caretAt(2), { ...lin(30), molecule: 'RNA' })).toMatchObject({ edit: { kind: 'insert', bases: 'U' } });
  });

  it('rejects text that is not DNA', () => {
    expect(textIntent('x', caretAt(2), lin(30))).toEqual({ type: 'invalid', text: 'x' });
    expect(textIntent('MKVLE*', caretAt(2), lin(30))).toEqual({ type: 'invalid', text: 'MKVLE*' });
    expect(textIntent('ACGTZ', sel(1, 4, 4), lin(30))).toEqual({ type: 'invalid', text: 'ACGTZ' });
  });

  it('does not edit a read-only view', () => {
    expect(textIntent('a', caretAt(2), lin(30, false))).toEqual({ type: 'none' });
    expect(keyIntent(key('Backspace'), caretAt(2), lin(30, false))).toEqual({ type: 'handled' });
    expect(cutIntent('ACGT', sel(0, 2, 2), lin(4, false))).toBeNull();
  });

  it('deletes the base before (Backspace) or after (Delete) the caret', () => {
    expect(keyIntent(key('Backspace'), caretAt(5), lin(30))).toMatchObject({
      type: 'edit',
      edit: { kind: 'delete', range: { start: 4, end: 5 } },
      selection: caretAt(4),
    });
    expect(keyIntent(key('Delete'), caretAt(5), lin(30))).toMatchObject({
      edit: { kind: 'delete', range: { start: 5, end: 6 } },
      selection: caretAt(5),
    });
    // nothing to delete at the ends of a linear sequence
    expect(keyIntent(key('Backspace'), caretAt(0), lin(30))).toEqual({ type: 'handled' });
    expect(keyIntent(key('Delete'), caretAt(30), lin(30))).toEqual({ type: 'handled' });
  });

  it('deletes across the origin of a circular sequence', () => {
    // Backspace at the origin removes the last base; the caret stays at the origin (end of the last row)
    expect(keyIntent(key('Backspace'), caretAt(0), circ(30))).toMatchObject({
      edit: { kind: 'delete', range: { start: 29, end: 30 } },
      selection: caretAt(0),
      affinity: 'upstream',
    });
    // Delete at the origin removes the first base
    expect(keyIntent(key('Delete'), caretAt(0), circ(30), 'upstream')).toMatchObject({
      edit: { kind: 'delete', range: { start: 0, end: 1 } },
      selection: caretAt(0),
      affinity: 'downstream',
    });
    // a wrapping selection is deleted as one range; the base after it becomes the origin
    expect(keyIntent(key('Backspace'), sel(27, 33, 3), circ(30))).toMatchObject({
      edit: { kind: 'delete', range: { start: 27, end: 33 } },
      selection: caretAt(0),
      affinity: 'downstream',
    });
  });

  it('places the caret after inserted bases, also at the circular origin', () => {
    expect(selectionAfterEdit({ kind: 'insert', gap: 30, bases: 'AC' }, lin(30))).toEqual({ selection: caretAt(32), affinity: 'downstream' });
    expect(selectionAfterEdit({ kind: 'insert', gap: 7, bases: 'AC' }, circ(30))).toEqual({ selection: caretAt(9), affinity: 'downstream' });
    // gap 0 is gap L on a circle: the bases are appended and the caret follows them
    expect(selectionAfterEdit({ kind: 'insert', gap: 0, bases: 'AC' }, circ(30))).toEqual({ selection: caretAt(0), affinity: 'upstream' });
    expect(selectionAfterEdit({ kind: 'insert', gap: 30, bases: 'AC' }, circ(30))).toEqual({ selection: caretAt(0), affinity: 'upstream' });
    expect(textIntent('g', caretAt(0), circ(30), 'downstream')).toMatchObject({ edit: { kind: 'insert', gap: 0 }, affinity: 'upstream' });
    expect(textIntent('g', caretAt(0), circ(30), 'upstream')).toMatchObject({ edit: { kind: 'insert', gap: 30 }, affinity: 'upstream' });
    // replacing the end of a circular sequence leaves the caret at the origin, end of the last row
    expect(selectionAfterEdit({ kind: 'replace', range: { start: 25, end: 30 }, bases: 'A' }, circ(30))).toEqual({
      selection: caretAt(0),
      affinity: 'upstream',
    });
  });

  it('cuts: copies the selected bases and deletes them', () => {
    const cut = cutIntent('AAAACCCCGGGGTTTT', sel(4, 8, 8), lin(16));
    expect(cut?.text).toBe('CCCC');
    expect(cut?.intent.edit).toEqual({ kind: 'delete', range: { start: 4, end: 8 } });
    expect(cutIntent('AAAACCCCGGGGTTTT', caretAt(4), lin(16))).toBeNull();
  });
});

describe('clipboard text', () => {
  const seq = 'AAAACCCCGGGGTTTT';
  it('is the selected top-strand bases', () => {
    expect(copyText(seq, sel(2, 6, 6))).toBe('AACC');
    expect(copyText(seq, sel(0, 16, 16))).toBe(seq);
  });

  it('joins the two parts of a selection wrapping the origin', () => {
    expect(copyText(seq, sel(14, 19, 3))).toBe('TTAAA');
  });

  it('is empty for a bare caret', () => {
    expect(copyText(seq, caretAt(3))).toBe('');
    expect(copyText(seq, null)).toBe('');
  });
});

describe('caret gaps', () => {
  it('resolves the circular origin with the affinity', () => {
    expect(caretGap(caretAt(0), circ(30), 'upstream')).toBe(30);
    expect(caretGap(caretAt(0), circ(30), 'downstream')).toBe(0);
    expect(caretGap(caretAt(45), lin(30), 'downstream')).toBe(30);
    expect(caretGap(null, lin(30), 'downstream')).toBe(0);
  });

  it('deleteIntent refuses to edit a read-only sequence', () => {
    expect(deleteIntent('backward', caretAt(3), lin(30, false))).toBeNull();
  });
});
