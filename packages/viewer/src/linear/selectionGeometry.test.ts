import { describe, expect, it } from 'vitest';
import { caretAt, selectRange } from '../selection';
import { caretPositions, coverRange, extendSelection, extendSelectionToRange, selectionPieces } from './selectionGeometry';

describe('selectionPieces', () => {
  it('is one piece for a plain selection', () => {
    expect(selectionPieces({ start: 10, end: 50 }, 1000, 'linear')).toEqual([{ start: 10, end: 50, startEdge: true, endEdge: true }]);
    expect(selectionPieces({ start: 10, end: 50 }, 1000, 'circular')).toEqual([{ start: 10, end: 50, startEdge: true, endEdge: true }]);
  });

  it('splits a selection that wraps the origin into two pieces, open where the origin cuts them', () => {
    expect(selectionPieces({ start: 3700, end: 4198 }, 3938, 'circular')).toEqual([
      { start: 3700, end: 3938, startEdge: true, endEdge: false },
      { start: 0, end: 260, startEdge: false, endEdge: true },
    ]);
  });

  it('shows the whole circle as one piece', () => {
    expect(selectionPieces({ start: 100, end: 1100 }, 1000, 'circular')).toEqual([{ start: 0, end: 1000, startEdge: true, endEdge: true }]);
  });

  it('is empty for a caret or an empty record', () => {
    expect(selectionPieces({ start: 5, end: 5 }, 1000, 'linear')).toEqual([]);
    expect(selectionPieces({ start: 0, end: 5 }, 0, 'linear')).toEqual([]);
  });
});

describe('caretPositions', () => {
  it('draws the origin of a circular record at both ends of the map', () => {
    expect(caretPositions(0, 1000, 'circular')).toEqual([0, 1000]);
    expect(caretPositions(1000, 1000, 'circular')).toEqual([0, 1000]);
    expect(caretPositions(250, 1000, 'circular')).toEqual([250]);
  });

  it('clamps on linear records', () => {
    expect(caretPositions(0, 1000, 'linear')).toEqual([0]);
    expect(caretPositions(1200, 1000, 'linear')).toEqual([1000]);
  });
});

describe('coverRange', () => {
  it('spans from the leftmost start to the rightmost end', () => {
    expect(coverRange({ start: 100, end: 200 }, { start: 3800, end: 3900 }, 4000, 'linear')).toEqual({ start: 100, end: 3900 });
    // on the map a circular record also reads left to right
    expect(coverRange({ start: 100, end: 200 }, { start: 3800, end: 3900 }, 4000, 'circular')).toEqual({ start: 100, end: 3900 });
  });

  it('keeps a wrap: the shortest arc covering both', () => {
    expect(coverRange({ start: 3900, end: 4100 }, { start: 200, end: 300 }, 4000, 'circular')).toEqual({ start: 3900, end: 4300 });
    expect(coverRange({ start: 3900, end: 4100 }, { start: 3500, end: 3600 }, 4000, 'circular')).toEqual({ start: 3500, end: 4100 });
  });

  it('covers a caret too', () => {
    expect(coverRange({ start: 50, end: 50 }, { start: 100, end: 200 }, 4000, 'linear')).toEqual({ start: 50, end: 200 });
  });
});

describe('extendSelection', () => {
  it('moves the caret end and keeps the anchor', () => {
    const sel = { range: { start: 100, end: 200 }, caret: 200 };
    expect(extendSelection(sel, 300, 1000, 'linear')).toEqual({ range: { start: 100, end: 300 }, caret: 300 });
    expect(extendSelection(sel, 50, 1000, 'linear')).toEqual({ range: { start: 50, end: 100 }, caret: 50 });
    expect(extendSelection(caretAt(400), 450, 1000, 'linear')).toEqual({ range: { start: 400, end: 450 }, caret: 450 });
  });

  it('runs straight along the map on circular records', () => {
    const sel = { range: { start: 10, end: 50 }, caret: 50 };
    // the far right end of the map: no wrap, the selection grows rightwards
    expect(extendSelection(sel, 3900, 4000, 'circular')).toEqual({ range: { start: 10, end: 3900 }, caret: 3900 });
  });

  it('keeps a selection that wraps the origin wrapping', () => {
    // 3,900..4,000 + 0..62 (anchor 3900, caret 62); shift-click at 200 grows the left piece
    const sel = { range: { start: 3900, end: 4062 }, caret: 62 };
    expect(extendSelection(sel, 200, 4000, 'circular')).toEqual({ range: { start: 3900, end: 4200 }, caret: 200 });
  });
});

describe('extendSelectionToRange', () => {
  it('selects the item when nothing is selected', () => {
    expect(extendSelectionToRange(null, { start: 10, end: 20 }, 100, 'linear')).toEqual(selectRange({ start: 10, end: 20 }, 100, 'linear'));
  });

  it('grows the selection to cover the item', () => {
    const sel = selectRange({ start: 10, end: 20 }, 100, 'linear');
    expect(extendSelectionToRange(sel, { start: 50, end: 60 }, 100, 'linear').range).toEqual({ start: 10, end: 60 });
  });
});
