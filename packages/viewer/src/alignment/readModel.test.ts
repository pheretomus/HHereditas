import type { AlignedSequence } from '@hhereditas/core';
import { describe, expect, it } from 'vitest';
import { alignedReadSpan, buildReadModel } from './readModel';

function read(over: Partial<AlignedSequence>): AlignedSequence {
  return {
    id: 'r',
    name: 'r',
    sequence: '',
    sortOrder: 0,
    visible: true,
    aligned: true,
    strand: 1,
    refRange: { start: 0, end: 0 },
    leftTail: 0,
    rightTail: 0,
    cigar: '',
    mismatches: [],
    alignedBases: '',
    identity: 100,
    ...over,
  };
}

describe('buildReadModel', () => {
  const ref = 'AAAACCCCGGGGTTTT';

  it('places bases, mismatches, deletions, insertions and tails on the reference columns', () => {
    // read: 2 tail bases, CCAC (one mismatch), deletion of 2, inserted A, G, then 2 tail bases
    const m = buildReadModel(read({ sequence: 'TTCCACAGGG', refRange: { start: 4, end: 11 }, cigar: '2S4M2D1I1M2S' }), ref);
    expect(m.alignedFrom).toBe(2);
    expect(m.alignedTo).toBe(8);
    expect(m.x[0]).toBe(2.5); // tail continues to the left
    expect(m.x[2]).toBe(4.5);
    expect(m.columns.map((c) => c.kind)).toEqual(['match', 'match', 'mismatch', 'match', 'deletion', 'deletion', 'match']);
    expect(m.insertions).toEqual([{ ref: 10, qi: 6, length: 1 }]);
    expect(m.x[6]).toBe(10); // the inserted base sits between columns 9 and 10
    expect(m.mismatches).toBe(1);
    expect(m.gapBases).toBe(3);
    expect(m.x[9]).toBe(12.5); // right tail
  });

  it('turns a reverse read and its trace to the reference orientation', () => {
    const trace = { a: [1, 2, 3], c: [4, 5, 6], g: [7, 8, 9], t: [10, 11, 12], peaks: [0, 1, 2] };
    // GGG reverse-complemented is CCC at 4..7
    const m = buildReadModel(read({ sequence: 'GGG', strand: -1, refRange: { start: 4, end: 7 }, cigar: '3M', trace }), ref);
    expect(m.oriented).toBe('CCC');
    expect(m.trace?.c).toEqual([9, 8, 7]); // G channel, reversed
    expect(m.trace?.peaks).toEqual([0, 1, 2]);
    expect(m.readPosition(0)).toBe(3);
    expect(alignedReadSpan(m)).toEqual({ from: 1, to: 3 });
  });

  it('continues past the end of a circular reference', () => {
    const m = buildReadModel(read({ sequence: 'TTAA', refRange: { start: 14, end: 18 }, cigar: '4M' }), ref);
    expect(m.mismatches).toBe(0);
    expect(m.columns.map((c) => c.ref)).toEqual([14, 15, 16, 17]);
  });
});
