import type { EnzymeSite, Feature, SeqRecord } from '@hhereditas/core';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatInt } from '../common/format';
import type { SequenceSelection } from '../selection';
import { caretAt } from '../selection';
import { DEFAULT_METRICS, autoBasesPerRow, buildRowModel, colCenter, colLeft, gapX, rowAtY } from './layout';
import type { RowModel } from './layout';
import { measureLabel } from './measure';
import { SequenceView, type SequenceViewProps } from './SequenceView';
import styles from './SequenceView.module.css';

const W = 900;
const H = 600;

function makeSeq(length: number): string {
  const unit = 'ATGGCTAAAGAAACCGTTCAGGCTCTGAGCATTCGTGACCTGAAAGC';
  let s = '';
  while (s.length < length) s += unit;
  return s.slice(0, length);
}

function record(length: number, extra: Partial<SeqRecord> = {}): SeqRecord {
  return {
    id: 'r',
    name: 'test',
    description: '',
    seq: makeSeq(length),
    topology: 'linear',
    molecule: 'DNA',
    features: [],
    primers: [],
    meta: {},
    ...extra,
  };
}

const KAN: Feature = { id: 'kan', type: 'misc_feature', name: 'kan', strand: 1, segments: [{ start: 120, end: 180 }], qualifiers: [] };
const CDS: Feature = { id: 'cds', type: 'CDS', name: 'orf1', strand: 1, segments: [{ start: 0, end: 45 }], qualifiers: [] };
const ECO: EnzymeSite = { enzyme: 'EcoRI', range: { start: 60, end: 66 }, strand: 1, cuts: [{ top: 61, bottom: 65 }] };

/** The model the component builds in jsdom (same width, same label measurement). */
function expectedModel(
  rec: SeqRecord,
  opts: { features?: boolean; translations?: boolean; enzymes?: EnzymeSite[]; basesPerRow?: number } = {},
): RowModel {
  const L = rec.seq.length;
  const numberColumnWidth = L === 0 ? 0 : Math.ceil(measureLabel(formatInt(L).replace(/\d/g, '0'), 'number')) + 2;
  const N = opts.basesPerRow ?? autoBasesPerRow(W, DEFAULT_METRICS, numberColumnWidth);
  return buildRowModel({
    length: L,
    topology: rec.topology,
    basesPerRow: N,
    numberColumnWidth,
    features:
      opts.features === false
        ? []
        : rec.features.map((f) => ({ feature: f, translated: (opts.translations ?? true) && f.type === 'CDS' })),
    enzymes: opts.enzymes ?? [],
    measure: measureLabel,
  });
}

/** Client coordinates of gap `gap` on the top strand (the view sits at the page origin, unscrolled). */
function pointAtGap(mdl: RowModel, gap: number): { clientX: number; clientY: number } {
  const r = Math.min(mdl.rowCount - 1, Math.floor(gap / mdl.basesPerRow));
  const row = mdl.rows[r];
  return {
    clientX: gapX(mdl.geometry, gap - row.start, row.end - row.start),
    clientY: mdl.offsets[r] + row.y.strand + DEFAULT_METRICS.strandHeight / 2,
  };
}

function pointAtBase(mdl: RowModel, index: number): { clientX: number; clientY: number } {
  const r = Math.floor(index / mdl.basesPerRow);
  const row = mdl.rows[r];
  return { clientX: colCenter(mdl.geometry, index - row.start), clientY: mdl.offsets[r] + row.y.strand + 8 };
}

function setup(props: Partial<SequenceViewProps> & { record: SeqRecord }) {
  const onSelectionChange = vi.fn<(s: SequenceSelection | null) => void>();
  const utils = render(<SequenceView onSelectionChange={onSelectionChange} {...props} />);
  const input = screen.getByRole('textbox') as HTMLTextAreaElement;
  const scroller = input.parentElement!.parentElement as HTMLDivElement;
  const last = () => onSelectionChange.mock.calls.at(-1)?.[0];
  return { ...utils, input, scroller, onSelectionChange, last };
}

function typeText(input: HTMLTextAreaElement, data: string) {
  act(() => {
    input.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data, cancelable: true, bubbles: true }));
  });
}

let restore: Array<() => void> = [];

beforeEach(() => {
  // jsdom has no layout: give every element the view's size at the page origin
  const define = (name: 'clientWidth' | 'clientHeight', value: number) => {
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, name);
    Object.defineProperty(HTMLElement.prototype, name, { configurable: true, get: () => value });
    restore.push(() => {
      if (original) Object.defineProperty(HTMLElement.prototype, name, original);
    });
  };
  define('clientWidth', W);
  define('clientHeight', H);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: W,
    bottom: H,
    width: W,
    height: H,
    toJSON: () => ({}),
  } as DOMRect);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  for (const r of restore) r();
  restore = [];
});

describe('SequenceView rendering', () => {
  it('renders only the rows near the viewport of a long sequence', () => {
    const rec = record(60_000);
    const { container } = setup({ record: rec });
    const mdl = expectedModel(rec);
    const rows = container.querySelectorAll('[data-row]');
    expect(mdl.rowCount).toBeGreaterThan(500);
    expect(rows.length).toBeGreaterThan(5);
    expect(rows.length).toBeLessThan(40);
    // the bases of the first row are drawn as one text run, the complement below
    expect(container.textContent).toContain(rec.seq.slice(0, mdl.basesPerRow));
  });

  it('shows row numbers, enzyme labels and feature names', () => {
    const rec = record(300, { features: [KAN] });
    const { container } = setup({ record: rec, enzymeSites: [ECO] });
    expect(container.textContent).toContain('EcoRI (61)');
    expect(container.querySelector('[data-kind="feature"]')).not.toBeNull();
    expect(container.textContent).toContain('kan');
    const mdl = expectedModel(rec, { enzymes: [ECO] });
    // Row numbers stand to the right of the bases and give the position of the row's last base.
    expect(container.textContent).toContain(formatInt(mdl.rows[1].end));
    const numbers = Array.from(container.querySelectorAll('text[class*="rowNumber"]'));
    expect(numbers.length).toBeGreaterThan(1);
    const geo = mdl.geometry;
    expect(numbers.every((t) => Number(t.getAttribute('x')) === geo.numberLeft)).toBe(true);
    expect(geo.numberLeft).toBeGreaterThan(geo.textRight);
    expect(geo.textLeft).toBeLessThan(geo.numberLeft);
  });

  it('translates CDS features unless translations are hidden', () => {
    const rec = record(300, { features: [CDS] });
    const shown = setup({ record: rec });
    expect(shown.container.textContent).toContain('MAKETVQALSIRD'.slice(0, 10));
    cleanup();
    const hidden = setup({ record: rec, show: { translations: false } });
    expect(hidden.container.textContent).not.toContain('MAKETVQ');
  });
});

describe('SequenceView translations and enzymes (review fixes)', () => {
  // M K * then filler: a CDS with a stop codon
  const stopRec = record(120, {
    seq: `ATGAAGTAA${'C'.repeat(111)}`,
    features: [{ id: 'cds', type: 'CDS', name: 'tiny', strand: 1, segments: [{ start: 0, end: 9 }], qualifiers: [] }],
  });

  it('draws a stop codon as a solid cell with a centred asterisk', () => {
    const { container } = setup({ record: stopRec });
    const cells = container.querySelectorAll(`rect.${styles.stopCell}`);
    expect(cells).toHaveLength(1);
    const glyph = container.querySelector(`path.${styles.stopGlyph}`);
    expect(glyph).not.toBeNull();
    // no '*' text glyph left in the strip
    expect([...container.querySelectorAll('text')].some((t) => t.textContent?.includes('*'))).toBe(false);
  });

  it('names each residue with its number and codon on hover', () => {
    const { container } = setup({ record: stopRec });
    const titles = [...container.querySelectorAll('rect[data-kind="translation"] > title')].map((t) => t.textContent);
    expect(titles).toEqual(['Met 1 (ATG) · tiny', 'Lys 2 (AAG) · tiny', 'Stop 3 (TAA) · tiny']);
  });

  it('lights up the residue of a selected codon (focused: selection colour; unfocused: neutral)', () => {
    const { container, input } = setup({ record: stopRec, selection: { range: { start: 3, end: 6 }, caret: 6 } });
    const inactive = container.querySelectorAll(`rect.${styles.translationSelectionInactive}`);
    expect(inactive).toHaveLength(1);
    // the strand selection is neutral too while the view is not focused
    expect(container.querySelector(`rect.${styles.selectionInactive}`)).not.toBeNull();
    act(() => input.focus());
    expect(container.querySelectorAll(`rect.${styles.translationSelection}`)).toHaveLength(1);
    expect(container.querySelector(`rect.${styles.selectionInactive}`)).toBeNull();
    // the highlight covers the codon cell exactly
    const cell = [...container.querySelectorAll('rect[data-kind="translation"]')].find((r) => r.textContent?.startsWith('Lys'))!;
    const sel = container.querySelector(`rect.${styles.translationSelection}`)!;
    expect(Number(sel.getAttribute('x'))).toBeCloseTo(Math.round(Number(cell.getAttribute('x'))) + 0.5, 1);
  });

  it("draws a primer's 5' tail bases (lower case, not annealed) beside its 5' end", () => {
    const rec = record(300);
    const annealed = rec.seq.slice(40, 60);
    const primed: SeqRecord = { ...rec, primers: [{ id: 'p', name: 'KanMX-F', sequence: `GATCGGATCC${annealed}` }] };
    const site = { primerId: 'p', strand: 1 as const, range: { start: 40, end: 60 }, annealedLength: 20, mismatches: 0, tailLength: 10 };
    const { container } = setup({ record: primed, primerSites: [site] });
    const tail = container.querySelector(`text.${styles.primerTailBases}`);
    expect(tail?.textContent).toBe('gatcggatcc');
    expect(container.querySelector(`rect.${styles.primerTailBox}`)?.getAttribute('data-kind')).toBe('primer');
  });

  it('emphasises the cut line of a hovered or selected enzyme site', () => {
    const rec = record(300);
    const { container, scroller, rerender, onSelectionChange } = setup({ record: rec, enzymeSites: [ECO] });
    expect(container.querySelector(`path.${styles.cutActive}`)).toBeNull();
    fireEvent.mouseMove(container.querySelector('text[data-kind="enzyme"]')!);
    expect(container.querySelector(`path.${styles.cutActive}`)).not.toBeNull();
    expect(container.querySelector(`path.${styles.cut}`)).toBeNull(); // its only cut line moved on top
    expect(scroller.parentElement!.getAttribute('data-enzyme-hover')).toBe('true');
    fireEvent.mouseLeave(scroller);
    expect(container.querySelector(`path.${styles.cutActive}`)).toBeNull();
    // selected (the selection is exactly the recognition site): emphasised without hover
    rerender(<SequenceView record={rec} enzymeSites={[ECO]} onSelectionChange={onSelectionChange} selection={{ range: { start: 60, end: 66 }, caret: 66 }} />);
    expect(container.querySelector(`path.${styles.cutActive}`)).not.toBeNull();
    expect(scroller.parentElement!.getAttribute('data-enzyme-hover')).toBeNull();
  });
});

describe('SequenceView pointer', () => {
  const rec = record(300, { features: [KAN] });

  it('places the caret at the nearest gap on mousedown', () => {
    const { scroller, last } = setup({ record: rec });
    const mdl = expectedModel(rec);
    const p = pointAtGap(mdl, mdl.basesPerRow + 7);
    fireEvent.mouseDown(scroller, { ...p, button: 0 });
    expect(last()).toEqual(caretAt(mdl.basesPerRow + 7));
    fireEvent.mouseUp(window);
  });

  it('selects by dragging, across rows', () => {
    const { scroller, last } = setup({ record: rec });
    const mdl = expectedModel(rec);
    fireEvent.mouseDown(scroller, { ...pointAtGap(mdl, 5), button: 0 });
    fireEvent.mouseMove(window, { ...pointAtGap(mdl, mdl.basesPerRow + 12), buttons: 1 });
    expect(last()).toEqual({ range: { start: 5, end: mdl.basesPerRow + 12 }, caret: mdl.basesPerRow + 12 });
    // dragging back above the anchor selects backwards
    fireEvent.mouseMove(window, { ...pointAtGap(mdl, 2), buttons: 1 });
    expect(last()).toEqual({ range: { start: 2, end: 5 }, caret: 2 });
    fireEvent.mouseUp(window);
  });

  it('extends the selection from its anchor with shift+click', () => {
    const { scroller, last, rerender, onSelectionChange } = setup({ record: rec, selection: { range: { start: 10, end: 20 }, caret: 20 } });
    const mdl = expectedModel(rec);
    fireEvent.mouseDown(scroller, { ...pointAtGap(mdl, 40), button: 0, shiftKey: true });
    expect(last()).toEqual({ range: { start: 10, end: 40 }, caret: 40 });
    fireEvent.mouseUp(window);
    rerender(<SequenceView record={rec} onSelectionChange={onSelectionChange} selection={{ range: { start: 10, end: 40 }, caret: 40 }} />);
    fireEvent.mouseDown(scroller, { ...pointAtGap(mdl, 4), button: 0, shiftKey: true });
    expect(last()).toEqual({ range: { start: 4, end: 10 }, caret: 4 });
    fireEvent.mouseUp(window);
  });

  it('selects a feature on click and reports the click (double click too)', () => {
    const onFeatureClick = vi.fn();
    const { container, last } = setup({ record: rec, onFeatureClick });
    const bar = container.querySelector('[data-kind="feature"]')!;
    fireEvent.mouseDown(bar, { button: 0, detail: 1 });
    expect(onFeatureClick).toHaveBeenLastCalledWith('kan', { clickCount: 1, shiftKey: false, metaKey: false, ctrlKey: false });
    expect(last()).toEqual({ range: { start: 120, end: 180 }, caret: 180 });
    fireEvent.mouseDown(bar, { button: 0, detail: 2 });
    expect(onFeatureClick).toHaveBeenLastCalledWith('kan', { clickCount: 2, shiftKey: false, metaKey: false, ctrlKey: false });
    expect(last()).toEqual({ range: { start: 120, end: 180 }, caret: 180 });
  });

  it('selects a codon when its amino acid is clicked', () => {
    const cdsRec = record(300, { features: [CDS] });
    const { container, last } = setup({ record: cdsRec });
    const mdl = expectedModel(cdsRec);
    const strip = container.querySelector('[data-kind="translation"]')!;
    // the middle base of codon 2 (bases 6..8)
    const p = pointAtBase(mdl, 7);
    fireEvent.mouseDown(strip, { clientX: p.clientX, clientY: p.clientY, button: 0 });
    expect(last()).toEqual({ range: { start: 6, end: 9 }, caret: 9 });
  });

  it('selects an enzyme site and reports the click', () => {
    const onEnzymeClick = vi.fn();
    const { container, last } = setup({ record: rec, enzymeSites: [ECO], onEnzymeClick });
    fireEvent.mouseDown(container.querySelector('[data-kind="enzyme"]')!, { button: 0 });
    expect(onEnzymeClick).toHaveBeenCalledWith(ECO);
    expect(last()).toEqual({ range: { start: 60, end: 66 }, caret: 66 });
  });

  it('reports the hovered feature', () => {
    const onFeatureHover = vi.fn();
    const { container, scroller } = setup({ record: rec, onFeatureHover });
    fireEvent.mouseMove(container.querySelector('[data-kind="feature"]')!);
    expect(onFeatureHover).toHaveBeenLastCalledWith('kan');
    fireEvent.mouseLeave(scroller);
    expect(onFeatureHover).toHaveBeenLastCalledWith(null);
  });

  it('reports what is under the pointer on a context menu', () => {
    const onContextMenu = vi.fn();
    const { container, scroller } = setup({ record: rec, onContextMenu });
    const mdl = expectedModel(rec);
    fireEvent.contextMenu(container.querySelector('[data-kind="feature"]')!);
    expect(onContextMenu.mock.calls[0][0]).toEqual({ kind: 'feature', id: 'kan' });
    fireEvent.contextMenu(scroller, pointAtBase(mdl, 42));
    expect(onContextMenu.mock.calls[1][0]).toEqual({ kind: 'sequence', position: 42 });
    // the row-number margin is background; its position is the nearest gap
    fireEvent.contextMenu(scroller, { clientX: 2, clientY: pointAtBase(mdl, mdl.basesPerRow).clientY });
    expect(onContextMenu.mock.calls[2][0]).toEqual({ kind: 'background', position: mdl.basesPerRow });
  });
});

describe('SequenceView keyboard and editing', () => {
  it('moves the caret with arrows and extends with shift (wrapping on circular records)', () => {
    const circ = record(300, { topology: 'circular' });
    const { input, last, rerender, onSelectionChange } = setup({ record: circ, selection: caretAt(5) });
    fireEvent.keyDown(input, { key: 'ArrowRight' });
    expect(last()).toEqual(caretAt(6));
    rerender(<SequenceView record={circ} onSelectionChange={onSelectionChange} selection={caretAt(0)} />);
    fireEvent.keyDown(input, { key: 'ArrowLeft', shiftKey: true });
    expect(last()).toEqual({ range: { start: 299, end: 300 }, caret: 299 });
    fireEvent.keyDown(input, { key: 'a', ctrlKey: true });
    expect(last()).toEqual({ range: { start: 0, end: 300 }, caret: 0 });
  });

  it('inserts typed bases at the caret and moves the caret after them', () => {
    const onEdit = vi.fn();
    const rec = record(100);
    const { input, last } = setup({ record: rec, editable: true, onEdit, selection: caretAt(10) });
    typeText(input, 'g');
    expect(onEdit).toHaveBeenCalledWith({ kind: 'insert', gap: 10, bases: 'G' });
    expect(last()).toEqual(caretAt(11));
  });

  it('replaces the selection with typed bases and deletes with Backspace', () => {
    const onEdit = vi.fn();
    const rec = record(100);
    const { input } = setup({ record: rec, editable: true, onEdit, selection: { range: { start: 4, end: 9 }, caret: 9 } });
    typeText(input, 'c');
    expect(onEdit).toHaveBeenLastCalledWith({ kind: 'replace', range: { start: 4, end: 9 }, bases: 'C' });
    fireEvent.keyDown(input, { key: 'Backspace' });
    expect(onEdit).toHaveBeenLastCalledWith({ kind: 'delete', range: { start: 4, end: 9 } });
  });

  it('reports text that is not DNA instead of editing', () => {
    const onEdit = vi.fn();
    const onInvalidInput = vi.fn();
    const { input } = setup({ record: record(100), editable: true, onEdit, onInvalidInput, selection: caretAt(3) });
    typeText(input, 'x');
    expect(onInvalidInput).toHaveBeenCalledWith('x');
    fireEvent.paste(input, { clipboardData: { getData: () => 'MKVLAAGG' } });
    expect(onInvalidInput).toHaveBeenLastCalledWith('MKVLAAGG');
    expect(onEdit).not.toHaveBeenCalled();
  });

  it('pastes cleaned bases', () => {
    const onEdit = vi.fn();
    const { input } = setup({ record: record(100), editable: true, onEdit, selection: caretAt(3) });
    fireEvent.paste(input, { clipboardData: { getData: () => '>primer\nacg tu\n12' } });
    expect(onEdit).toHaveBeenCalledWith({ kind: 'insert', gap: 3, bases: 'ACGTT' });
  });

  it('does not edit when read-only', () => {
    const onEdit = vi.fn();
    const { input } = setup({ record: record(100), onEdit, selection: caretAt(3) });
    typeText(input, 'g');
    fireEvent.keyDown(input, { key: 'Backspace' });
    fireEvent.paste(input, { clipboardData: { getData: () => 'ACGT' } });
    expect(onEdit).not.toHaveBeenCalled();
    expect(input.readOnly).toBe(true);
  });

  it('copies the selected bases as plain text, also across the origin', () => {
    const circ = record(300, { topology: 'circular' });
    const { input } = setup({ record: circ, selection: { range: { start: 296, end: 304 }, caret: 4 } });
    const setData = vi.fn();
    fireEvent.copy(input, { clipboardData: { setData } });
    expect(setData).toHaveBeenCalledWith('text/plain', circ.seq.slice(296) + circ.seq.slice(0, 4));
  });

  it('cuts: copies and deletes the selection', () => {
    const onEdit = vi.fn();
    const rec = record(100);
    const { input } = setup({ record: rec, editable: true, onEdit, selection: { range: { start: 10, end: 14 }, caret: 14 } });
    const setData = vi.fn();
    fireEvent.cut(input, { clipboardData: { setData } });
    expect(setData).toHaveBeenCalledWith('text/plain', rec.seq.slice(10, 14));
    expect(onEdit).toHaveBeenCalledWith({ kind: 'delete', range: { start: 10, end: 14 } });
  });
});

describe('SequenceView scrolling', () => {
  it('scrolls a requested base into the middle of the view', () => {
    const rec = record(60_000);
    const { scroller } = setup({ record: rec, scrollTo: { position: 30_000, requestId: 1 } });
    const mdl = expectedModel(rec);
    const r = Math.floor(30_000 / mdl.basesPerRow);
    const rowMiddle = mdl.offsets[r] + mdl.rows[r].height / 2;
    expect(Math.abs(scroller.scrollTop + H / 2 - rowMiddle)).toBeLessThan(2);
    // the requested row is rendered
    expect(scroller.querySelector(`[data-row="${r}"]`)).not.toBeNull();
  });

  it('keeps the first visible base in place when the layout changes', () => {
    const rec = record(60_000);
    const { scroller, rerender } = setup({ record: rec, scrollTo: { position: 30_000, requestId: 1 } });
    const before = expectedModel(rec);
    const topRow = Math.floor(30_000 / before.basesPerRow) - 2;
    act(() => {
      scroller.scrollTop = before.offsets[topRow];
      fireEvent.scroll(scroller);
    });
    rerender(<SequenceView record={rec} basesPerRow={50} scrollTo={{ position: 30_000, requestId: 1 }} />);
    const after = expectedModel(rec, { basesPerRow: 50 });
    const base = before.rows[topRow].start;
    expect(scroller.scrollTop).toBeCloseTo(after.offsets[Math.floor(base / 50)], 0);
  });

  it('keeps the reading position through repeated changes of the bases per row (review: drift)', () => {
    const rec = record(60_000);
    const { scroller, rerender } = setup({ record: rec, basesPerRow: 60 });
    const m60 = expectedModel(rec, { basesPerRow: 60 });
    const r0 = 400; // the row of bases 24,000..24,059 at the top, 5 px into it
    act(() => {
      scroller.scrollTop = m60.offsets[r0] + 5;
      fireEvent.scroll(scroller);
    });
    for (const n of [50, 70, 40, 90, 30, 60, 50, 70, 60]) {
      rerender(<SequenceView record={rec} basesPerRow={n} />);
      // the browser reports the restoring scrollTop write with a scroll event of its own
      act(() => {
        fireEvent.scroll(scroller);
      });
      const mdl = expectedModel(rec, { basesPerRow: n });
      const top = mdl.rows[rowAtY(mdl, scroller.scrollTop)];
      expect(top.start).toBeLessThanOrEqual(24_000);
      expect(top.end).toBeGreaterThan(24_000);
      expect(scroller.scrollTop - mdl.offsets[top.index]).toBeCloseTo(5, 0);
    }
    expect(scroller.scrollTop).toBeCloseTo(m60.offsets[r0] + 5, 0);
  });

  it('restores the exact pixel offset after a layout in which the anchor row was shorter', () => {
    // a feature in the anchor row at 60 bases per row, in the next row at 50: the row is shorter there
    const rec = record(60_000, {
      features: [{ id: 'f', type: 'misc_feature', name: 'f', strand: 1, segments: [{ start: 24_050, end: 24_055 }], qualifiers: [] }],
    });
    const { scroller, rerender } = setup({ record: rec, basesPerRow: 60 });
    const m60 = expectedModel(rec, { basesPerRow: 60 });
    const m50 = expectedModel(rec, { basesPerRow: 50 });
    const r0 = 400;
    const offset = m60.rows[r0].height - 4; // near the bottom of the tall row
    expect(m50.rows[480].height).toBeLessThan(offset); // will be clamped at 50 bases per row
    act(() => {
      scroller.scrollTop = m60.offsets[r0] + offset;
      fireEvent.scroll(scroller);
    });
    rerender(<SequenceView record={rec} basesPerRow={50} />);
    act(() => {
      fireEvent.scroll(scroller);
    });
    expect(rowAtY(m50, scroller.scrollTop)).toBe(480); // still the row holding base 24,000
    rerender(<SequenceView record={rec} basesPerRow={60} />);
    act(() => {
      fireEvent.scroll(scroller);
    });
    expect(scroller.scrollTop).toBeCloseTo(m60.offsets[r0] + offset, 0);
  });

  it('scrolls sideways to keep the caret visible when rows are wider than the view (review: horizontal reveal)', () => {
    const rec = record(2_000);
    const mdl = expectedModel(rec, { basesPerRow: 200 });
    expect(mdl.geometry.width).toBeGreaterThan(W + 400);
    function Stateful() {
      const [sel, setSel] = useState<SequenceSelection | null>(caretAt(205));
      return <SequenceView record={rec} basesPerRow={200} selection={sel} onSelectionChange={setSel} />;
    }
    render(<Stateful />);
    const input = screen.getByRole('textbox') as HTMLTextAreaElement;
    const scroller = input.parentElement!.parentElement as HTMLDivElement;
    fireEvent.keyDown(input, { key: 'End' });
    const x = gapX(mdl.geometry, 200, 200);
    expect(scroller.scrollLeft).toBeGreaterThan(0);
    expect(x).toBeGreaterThan(scroller.scrollLeft);
    expect(x).toBeLessThan(scroller.scrollLeft + W);
    fireEvent.keyDown(input, { key: 'Home' });
    expect(scroller.scrollLeft).toBe(0); // back at the start of the row, row numbers included
  });

  it('reveals the caret once a controlled parent applies the new selection, even in a later render', () => {
    const rec = record(2_000);
    const { input, scroller, rerender, onSelectionChange } = setup({ record: rec, basesPerRow: 200, selection: caretAt(205) });
    fireEvent.keyDown(input, { key: 'End' });
    expect(scroller.scrollLeft).toBe(0); // not applied yet
    rerender(<SequenceView record={rec} basesPerRow={200} onSelectionChange={onSelectionChange} selection={onSelectionChange.mock.calls.at(-1)![0]} />);
    expect(scroller.scrollLeft).toBeGreaterThan(0);
  });

  it('starts at the top when another document is shown', () => {
    const { scroller, rerender } = setup({ record: record(60_000), scrollTo: { position: 30_000, requestId: 1 } });
    expect(scroller.scrollTop).toBeGreaterThan(1000);
    rerender(<SequenceView record={{ ...record(60_000), id: 'another' }} />);
    expect(scroller.scrollTop).toBe(0);
  });

  it('puts a caret at the first row on screen when focused with the keyboard', () => {
    const rec = record(60_000);
    const { input, last } = setup({ record: rec, scrollTo: { position: 30_000, requestId: 1 } });
    act(() => input.focus());
    const mdl = expectedModel(rec);
    const caret = last()!;
    expect(caret.range.start).toBe(caret.range.end);
    expect(caret.caret % mdl.basesPerRow).toBe(0);
    expect(Math.abs(caret.caret - 30_000)).toBeLessThan(mdl.basesPerRow * 8);
  });

  it('draws the caret on the row where it was placed', () => {
    const rec = record(300);
    const mdl = expectedModel(rec);
    const { container } = setup({ record: rec, selection: caretAt(mdl.basesPerRow + 3) });
    const row = container.querySelector('[data-row="1"]')!;
    const caret = [...row.querySelectorAll('div')].find((d) => d.getAttribute('style')?.includes('left'));
    expect(caret).toBeDefined();
    expect(parseFloat((caret as HTMLElement).style.left)).toBeCloseTo(colLeft(mdl.geometry, 3) - 1, 1);
  });
});
