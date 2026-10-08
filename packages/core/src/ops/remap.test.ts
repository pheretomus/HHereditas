/**
 * Hand-written cases for the remapping rules (remap.ts). Expected values are worked out by hand
 * in the comments; positions are 0-based, ranges half-open.
 */
import { describe, expect, it } from 'vitest';
import type { Feature, Range, Strand, Topology } from '../types';
import { planEdit, remapFeatures, remapGap, remapRange } from './remap';
import type { SequenceEdit } from './remap';
import { deepFreeze } from './test-helpers';

const ins = (gap: number, length: number): SequenceEdit => ({ kind: 'insert', gap, length });
const del = (start: number, end: number): SequenceEdit => ({ kind: 'delete', range: { start, end } });
const rep = (start: number, end: number, length: number): SequenceEdit => ({ kind: 'replace', range: { start, end }, length });

function r(start: number, end: number): Range {
  return { start, end };
}

/** remapRange on a molecule of length 20 by default. */
function map(seg: Range, edit: SequenceEdit, topology: Topology = 'linear', L = 20): Range | null {
  return remapRange(seg, edit, L, topology);
}

function feature(id: string, segments: Range[], strand: Strand = 1, extra: Partial<Feature> = {}): Feature {
  return { id, type: 'misc_feature', name: id, strand, segments, qualifiers: [{ key: 'label', value: id }], ...extra };
}

describe('planEdit', () => {
  it('describes insertions, deletions and replacements', () => {
    expect(planEdit(ins(10, 5), 20, 'linear')).toEqual({
      oldLength: 20,
      topology: 'linear',
      start: 10,
      deleted: 0,
      inserted: 5,
      wrapsOrigin: false,
      insertAt: 10,
      newLength: 25,
    });
    expect(planEdit(del(5, 10), 20, 'linear')).toMatchObject({ start: 5, deleted: 5, inserted: 0, insertAt: 5, newLength: 15 });
    expect(planEdit(rep(5, 10, 3), 20, 'linear')).toMatchObject({ start: 5, deleted: 5, inserted: 3, newLength: 18 });
  });

  it('treats a circular insertion at gap 0 as appending at L', () => {
    expect(planEdit(ins(0, 3), 20, 'circular')).toMatchObject({ start: 20, insertAt: 20, wrapsOrigin: false, newLength: 23 });
    expect(planEdit(ins(20, 3), 20, 'circular')).toEqual(planEdit(ins(0, 3), 20, 'circular'));
    // linear gap 0 really is the start
    expect(planEdit(ins(0, 3), 20, 'linear')).toMatchObject({ start: 0, insertAt: 0 });
    // an empty replacement range is an insertion, with the same origin rule
    expect(planEdit(rep(0, 0, 3), 20, 'circular')).toMatchObject({ start: 20, insertAt: 20 });
  });

  it('puts the inserted bases first when the deleted region crosses the origin', () => {
    expect(planEdit(rep(18, 23, 2), 20, 'circular')).toMatchObject({ wrapsOrigin: true, insertAt: 0, newLength: 17 });
    // deleting the start of a circle does not wrap: the inserted bases also come first
    expect(planEdit(rep(0, 5, 2), 20, 'circular')).toMatchObject({ wrapsOrigin: false, insertAt: 0, newLength: 17 });
  });

  it('rejects invalid edits with RangeErrors', () => {
    expect(() => planEdit(ins(-1, 2), 20, 'linear')).toThrow(RangeError);
    expect(() => planEdit(ins(21, 2), 20, 'linear')).toThrow(/outside 0\.\.20/);
    expect(() => planEdit(ins(1.5, 2), 20, 'linear')).toThrow(/integer/);
    expect(() => planEdit(ins(3, -2), 20, 'linear')).toThrow(/>= 0/);
    expect(() => planEdit(del(5, 4), 20, 'linear')).toThrow(/end < start/);
    expect(() => planEdit(del(15, 25), 20, 'linear')).toThrow(RangeError);
    expect(() => planEdit(del(20, 22), 20, 'circular')).toThrow(/start < length/);
    expect(() => planEdit(del(5, 26), 20, 'circular')).toThrow(RangeError);
    expect(() => planEdit(del(0, 1), 0, 'circular')).toThrow(RangeError);
    expect(() => planEdit(ins(0, 2), -1, 'linear')).toThrow(/oldLength/);
    expect(() => planEdit(rep(1, 2, Number.NaN), 20, 'linear')).toThrow(/integer/);
  });
});

describe('insertion rules (linear, L = 20, 5 bases at gap 10)', () => {
  const e = ins(10, 5);
  it('leaves segments ending at or before the gap unchanged', () => {
    expect(map(r(2, 8), e)).toEqual(r(2, 8));
    expect(map(r(2, 10), e)).toEqual(r(2, 10)); // touches the gap: not extended
  });
  it('shifts segments starting at or after the gap', () => {
    expect(map(r(10, 15), e)).toEqual(r(15, 20)); // starts at the gap
    expect(map(r(12, 20), e)).toEqual(r(17, 25));
  });
  it('extends segments strictly containing the gap', () => {
    expect(map(r(5, 15), e)).toEqual(r(5, 20));
    expect(map(r(9, 11), e)).toEqual(r(9, 16));
    expect(map(r(0, 20), e)).toEqual(r(0, 25));
  });
  it('keeps zero-length segments at the gap on its left side', () => {
    expect(map(r(10, 10), e)).toEqual(r(10, 10));
    expect(map(r(9, 9), e)).toEqual(r(9, 9));
    expect(map(r(11, 11), e)).toEqual(r(16, 16));
    expect(map(r(20, 20), e)).toEqual(r(25, 25));
  });
  it('at gap 0 shifts everything, at gap L changes nothing', () => {
    expect(map(r(0, 5), ins(0, 3))).toEqual(r(3, 8));
    expect(map(r(0, 0), ins(0, 3))).toEqual(r(0, 0));
    expect(map(r(15, 20), ins(20, 3))).toEqual(r(15, 20));
    expect(map(r(0, 20), ins(20, 3))).toEqual(r(0, 20));
    expect(map(r(20, 20), ins(20, 3))).toEqual(r(20, 20));
  });
  it('with zero bases is the identity', () => {
    expect(map(r(5, 15), ins(10, 0))).toEqual(r(5, 15));
    expect(map(r(10, 10), ins(10, 0))).toEqual(r(10, 10));
  });
});

describe('insertion rules (circular, L = 20)', () => {
  it('appends at gap 0 / L: the origin stays, origin-crossing segments grow', () => {
    for (const gap of [0, 20]) {
      const e = ins(gap, 3); // new length 23, inserted bases at 20..22
      expect(map(r(18, 22), e, 'circular')).toEqual(r(18, 25)); // 18,19 | 20,21,22 | 0,1
      expect(map(r(0, 5), e, 'circular')).toEqual(r(0, 5));
      expect(map(r(15, 20), e, 'circular')).toEqual(r(15, 20)); // ends at the origin: not extended
      expect(map(r(0, 20), e, 'circular')).toEqual(r(0, 20)); // whole circle starting at the origin: boundary
      expect(map(r(5, 25), e, 'circular')).toEqual(r(5, 28)); // whole circle from 5 contains the origin gap
      expect(map(r(0, 0), e, 'circular')).toEqual(r(20, 20)); // site at the origin: before the insertion
      expect(map(r(7, 7), e, 'circular')).toEqual(r(7, 7));
    }
  });

  it('extends an origin-crossing segment when the gap is in its wrapped part', () => {
    // [18, 25) = 18,19,0,1,2,3,4; 2 bases at gap 3. New: 0,1,2 | I,I | 3..19 -> 5..21 (length 22).
    // 18,19 -> 20,21; 0,1,2 -> 0,1,2; I,I -> 3,4; 3,4 -> 5,6: [20, 29).
    expect(map(r(18, 25), ins(3, 2), 'circular')).toEqual(r(20, 29));
    // gap at the end of the wrapped part (gap 5): not extended, only shifted: [20, 27)
    expect(map(r(18, 25), ins(5, 2), 'circular')).toEqual(r(20, 27));
    // gap at its start (gap 18): shifted, not extended
    expect(map(r(18, 25), ins(18, 2), 'circular')).toEqual(r(20, 27));
    // gap at 19 (inside the first lap): extended
    expect(map(r(18, 25), ins(19, 2), 'circular')).toEqual(r(18, 27));
  });
});

describe('deletion rules (linear, L = 20, delete [5, 10))', () => {
  const e = del(5, 10);
  it('keeps segments touching the deleted region', () => {
    expect(map(r(0, 5), e)).toEqual(r(0, 5));
    expect(map(r(10, 15), e)).toEqual(r(5, 10));
  });
  it('trims partly deleted segments', () => {
    expect(map(r(3, 7), e)).toEqual(r(3, 5));
    expect(map(r(7, 12), e)).toEqual(r(5, 7));
    expect(map(r(2, 15), e)).toEqual(r(2, 10)); // contains the region: shrinks by 5
    expect(map(r(0, 20), e)).toEqual(r(0, 15));
  });
  it('removes segments inside the deleted region', () => {
    expect(map(r(5, 10), e)).toBeNull();
    expect(map(r(6, 8), e)).toBeNull();
  });
  it('keeps zero-length segments on the boundaries and removes those inside', () => {
    expect(map(r(5, 5), e)).toEqual(r(5, 5));
    expect(map(r(10, 10), e)).toEqual(r(5, 5));
    expect(map(r(7, 7), e)).toBeNull();
    expect(map(r(12, 12), e)).toEqual(r(7, 7));
    expect(map(r(20, 20), e)).toEqual(r(15, 15));
  });
  it('of everything leaves only boundary sites', () => {
    expect(map(r(3, 9), del(0, 20))).toBeNull();
    expect(map(r(0, 0), del(0, 20))).toEqual(r(0, 0));
    expect(map(r(20, 20), del(0, 20))).toEqual(r(0, 0));
    expect(map(r(4, 4), del(0, 20))).toBeNull();
  });
});

describe('deletion rules (circular, L = 20)', () => {
  it('across the origin: the first base after the deleted region becomes base 0', () => {
    // delete [18, 23) = 18,19,0,1,2; survivors 3..17 become 0..14 (new base = old - 3)
    const e = del(18, 23);
    expect(map(r(5, 10), e, 'circular')).toEqual(r(2, 7));
    expect(map(r(16, 21), e, 'circular')).toEqual(r(13, 15)); // 16,17 survive
    expect(map(r(1, 6), e, 'circular')).toEqual(r(0, 3)); // 3,4,5 survive
    expect(map(r(19, 21), e, 'circular')).toBeNull(); // 19,0: all deleted
    // [10, 25) = 10..19,0..4 strictly contains the deleted region: 10..17 -> 7..14 and 3,4 -> 0,1
    expect(map(r(10, 25), e, 'circular')).toEqual(r(7, 17));
    // the whole circle (from 0, a deleted base) becomes the whole new circle from new base 0
    expect(map(r(0, 20), e, 'circular')).toEqual(r(0, 15));
    expect(map(r(18, 18), e, 'circular')).toEqual(r(0, 0)); // left boundary
    expect(map(r(3, 3), e, 'circular')).toEqual(r(0, 0)); // right boundary
    expect(map(r(0, 0), e, 'circular')).toBeNull(); // strictly inside
    expect(map(r(10, 10), e, 'circular')).toEqual(r(7, 7));
  });

  it('of the first bases: the first base after them becomes base 0', () => {
    // delete [0, 5): survivors 5..19 become 0..14
    const e = del(0, 5);
    expect(map(r(18, 22), e, 'circular')).toEqual(r(13, 15)); // 18,19 survive
    expect(map(r(3, 8), e, 'circular')).toEqual(r(0, 3));
    expect(map(r(15, 25), e, 'circular')).toEqual(r(10, 15)); // touches the region's end only
    expect(map(r(15, 26), e, 'circular')).toEqual(r(10, 16)); // contains it: 15..19,5 -> 10..14,0
  });

  it('elsewhere keeps the origin and every coordinate before the region', () => {
    const e = del(5, 10);
    expect(map(r(18, 23), e, 'circular')).toEqual(r(13, 18)); // 18,19,0,1,2 -> 13,14,0,1,2
    expect(map(r(3, 23), e, 'circular')).toEqual(r(3, 18)); // whole circle from 3: 20 - 5 bases
  });

  it('of the whole circle removes everything', () => {
    expect(map(r(3, 9), del(7, 27), 'circular')).toBeNull();
    expect(map(r(7, 7), del(7, 27), 'circular')).toBeNull();
    expect(remapFeatures([feature('a', [r(0, 0)]), feature('b', [r(2, 5)])], del(0, 20), 20, 'circular')).toEqual([]);
  });
});

describe('replacement rules', () => {
  it('a segment strictly containing the replaced region covers the replacement (linear)', () => {
    // replace [5, 10) by 3 bases: new length 18; old 10.. -> 8..
    const e = rep(5, 10, 3);
    expect(map(r(2, 15), e)).toEqual(r(2, 13)); // 13 - 5 + 3 = 11 bases
    expect(map(r(4, 11), e)).toEqual(r(4, 9)); // old 4 + I,I,I + old 10
  });

  it('segments touching or partly overlapping the region do not cover it', () => {
    const e = rep(5, 10, 3);
    expect(map(r(5, 10), e)).toBeNull(); // exactly replaced: removed
    expect(map(r(5, 12), e)).toEqual(r(8, 10)); // trimmed, starts after the replacement
    expect(map(r(2, 10), e)).toEqual(r(2, 5)); // trimmed, ends before the replacement
    expect(map(r(0, 5), e)).toEqual(r(0, 5));
    expect(map(r(10, 20), e)).toEqual(r(8, 18));
  });

  it('sites on the left / right boundary go before / after the replacement', () => {
    const e = rep(5, 10, 3);
    expect(map(r(5, 5), e)).toEqual(r(5, 5));
    expect(map(r(10, 10), e)).toEqual(r(8, 8));
    expect(map(r(7, 7), e)).toBeNull();
  });

  it('across the origin: the replacement starts the new sequence (circular)', () => {
    // replace [18, 23) = 18,19,0,1,2 by 2 bases: new = I,I + old 3..17 (length 17); old x -> x - 1
    const e = rep(18, 23, 2);
    // [15, 25) = 15..19,0..4 strictly contains the region: 15,16,17 -> 14,15,16; I,I -> 0,1; 3,4 -> 2,3
    expect(map(r(15, 25), e, 'circular')).toEqual(r(14, 21));
    expect(map(r(5, 8), e, 'circular')).toEqual(r(4, 7));
    expect(map(r(18, 18), e, 'circular')).toEqual(r(0, 0)); // before the replacement
    expect(map(r(3, 3), e, 'circular')).toEqual(r(2, 2)); // after the replacement
  });

  it('with an empty range is an insertion and with no bases a deletion', () => {
    for (const seg of [r(2, 15), r(5, 10), r(10, 10), r(0, 0), r(18, 20)]) {
      expect(map(seg, rep(10, 10, 4))).toEqual(map(seg, ins(10, 4)));
      expect(map(seg, rep(5, 10, 0))).toEqual(map(seg, del(5, 10)));
    }
    for (const seg of [r(2, 15), r(0, 0), r(18, 22), r(0, 20), r(5, 25)]) {
      expect(map(seg, rep(0, 0, 4), 'circular')).toEqual(map(seg, ins(0, 4), 'circular'));
      expect(map(seg, rep(18, 23, 0), 'circular')).toEqual(map(seg, del(18, 23), 'circular'));
    }
  });
});

describe('remapGap', () => {
  it('places carets before or after inserted bases by bias', () => {
    expect(remapGap(10, ins(10, 5), 20, 'linear')).toBe(10);
    expect(remapGap(10, ins(10, 5), 20, 'linear', 'right')).toBe(15);
    expect(remapGap(12, ins(10, 5), 20, 'linear', 'right')).toBe(17);
    expect(remapGap(0, ins(0, 5), 20, 'circular', 'right')).toBe(0); // 25 mod 25
    expect(remapGap(0, ins(0, 5), 20, 'circular', 'left')).toBe(20);
  });

  it('collapses gaps inside a deleted region onto the edit point', () => {
    expect(remapGap(7, del(5, 10), 20, 'linear')).toBe(5);
    expect(remapGap(7, rep(5, 10, 3), 20, 'linear', 'left')).toBe(5);
    expect(remapGap(7, rep(5, 10, 3), 20, 'linear', 'right')).toBe(8);
    expect(remapGap(10, rep(5, 10, 3), 20, 'linear', 'left')).toBe(8); // right boundary: after
    expect(remapGap(0, del(18, 23), 20, 'circular')).toBe(0);
    expect(remapGap(15, del(5, 10), 20, 'linear')).toBe(10);
  });

  it('validates the range given to remapRange', () => {
    expect(() => remapRange(r(15, 25), del(1, 2), 20, 'linear')).toThrow(RangeError);
    expect(() => remapRange(r(5, 3), del(1, 2), 20, 'circular')).toThrow(RangeError);
  });

  it('normalizes circular results and validates the gap', () => {
    expect(remapGap(20, del(5, 10), 20, 'circular')).toBe(0);
    expect(() => remapGap(21, del(5, 10), 20, 'linear')).toThrow(RangeError);
  });
});

describe('remapFeatures', () => {
  it('remaps every segment, drops emptied segments and features, keeps other fields', () => {
    const features = deepFreeze([
      feature('cds', [r(2, 6), r(8, 12), r(14, 18)], -1, { partialStart: true, color: '#123456' }),
      feature('gone', [r(8, 12)]),
      feature('site', [r(10, 10)], 0),
      feature('mixed', [r(9, 11), r(16, 16)]),
    ]);
    const out = remapFeatures(features, del(7, 13), 20, 'linear');
    // cds: [2,6) unchanged; [8,12) deleted; [14,18) -> [8,12). Partial flags untouched.
    expect(out).toEqual([
      feature('cds', [r(2, 6), r(8, 12)], -1, { partialStart: true, color: '#123456' }),
      feature('mixed', [r(10, 10)]),
    ]);
    // returns deep copies
    expect(out[0].qualifiers).not.toBe(features[0].qualifiers);
    expect(Object.isFrozen(out[0].segments)).toBe(false);
  });

  it('keeps segment lists in order and never merges touching segments', () => {
    const f = feature('j', [r(0, 5), r(10, 15)]);
    expect(remapFeatures([f], del(5, 10), 20, 'linear')[0].segments).toEqual([r(0, 5), r(5, 10)]);
  });
});
