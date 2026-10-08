/**
 * Degenerate inputs for every operation: empty records, 1 bp records, edits covering everything.
 */
import { describe, expect, it } from 'vitest';
import type { Feature, Range, SeqRecord, Strand, Topology } from '../types';
import { featureSequence } from '../seq/features';
import { deleteRange, insertBases, replaceRange } from './edit';
import { remapFeatures, remapGap } from './remap';
import { concatRecords, extractRange, reverseComplementRecord, rotateOrigin, setTopology } from './transform';
import { deepFreeze, recordProblems } from './test-helpers';

function r(start: number, end: number): Range {
  return { start, end };
}

function feature(id: string, segments: Range[], strand: Strand = 1): Feature {
  return { id, type: 'misc_feature', name: id, strand, segments, qualifiers: [] };
}

function record(seq: string, topology: Topology, features: Feature[] = []): SeqRecord {
  return deepFreeze({ id: 'd', name: 'n', description: '', seq, topology, molecule: 'DNA', features, primers: [], meta: {} });
}

describe('empty records', () => {
  it('accept insertions at gap 0', () => {
    const lin = insertBases(record('', 'linear', [feature('s', [r(0, 0)])]), 0, 'ACG');
    expect(lin.seq).toBe('ACG');
    expect(lin.features[0].segments).toEqual([r(0, 0)]);
    const circ = insertBases(record('', 'circular'), 0, 'ACG');
    expect(circ.seq).toBe('ACG');
    expect(recordProblems(circ)).toEqual([]);
    expect(insertBases(record('', 'linear'), 0, record('GG', 'circular', [feature('w', [r(1, 3)])])).features[0].segments).toEqual([
      r(1, 2),
      r(0, 1),
    ]);
  });

  it('accept only the empty range', () => {
    const empty = record('', 'linear');
    expect(deleteRange(empty, r(0, 0)).seq).toBe('');
    expect(replaceRange(empty, r(0, 0), 'T').seq).toBe('T');
    expect(extractRange(empty, r(0, 0)).seq).toBe('');
    expect(extractRange(record('', 'circular'), r(0, 0)).seq).toBe('');
    expect(() => deleteRange(empty, r(0, 1))).toThrow(RangeError);
    expect(() => deleteRange(record('', 'circular'), r(0, 1))).toThrow(RangeError);
  });

  it('pass through the transforms', () => {
    expect(rotateOrigin(record('', 'circular'), 3).seq).toBe('');
    expect(reverseComplementRecord(record('', 'linear')).seq).toBe('');
    expect(setTopology(record('', 'circular'), 'linear').topology).toBe('linear');
    expect(concatRecords([record('', 'linear'), record('', 'linear')]).seq).toBe('');
    expect(concatRecords([record('', 'linear')], { topology: 'circular' }).seq).toBe('');
    expect(remapFeatures([], { kind: 'insert', gap: 0, length: 0 }, 0, 'circular')).toEqual([]);
    expect(remapGap(0, { kind: 'insert', gap: 0, length: 4 }, 0, 'circular', 'right')).toBe(0);
  });
});

describe('1 bp records', () => {
  const lin = record('G', 'linear', [feature('g', [r(0, 1)], -1), feature('s0', [r(0, 0)]), feature('s1', [r(1, 1)])]);
  const circ = record('G', 'circular', [feature('g', [r(0, 1)], -1), feature('s0', [r(0, 0)])]);

  it('insert before and after the base', () => {
    expect(insertBases(lin, 0, 'A').seq).toBe('AG');
    expect(insertBases(lin, 1, 'A').seq).toBe('GA');
    expect(insertBases(lin, 1, 'A').features.map((f) => f.segments)).toEqual([[r(0, 1)], [r(0, 0)], [r(1, 1)]]);
    // circular: gaps 0 and 1 are the same place; the base stays the origin
    expect(insertBases(circ, 0, 'A')).toEqual(insertBases(circ, 1, 'A'));
    expect(insertBases(circ, 0, 'A').seq).toBe('GA');
    expect(insertBases(circ, 0, 'A').features.map((f) => f.segments)).toEqual([[r(0, 1)], [r(1, 1)]]);
  });

  it('delete the only base', () => {
    expect(deleteRange(lin, r(0, 1)).features.map((f) => [f.id, f.segments])).toEqual([
      ['s0', [r(0, 0)]],
      ['s1', [r(0, 0)]],
    ]);
    const gone = deleteRange(circ, r(0, 1));
    expect(gone.seq).toBe('');
    expect(gone.features).toEqual([]);
  });

  it('replace the only base', () => {
    const out = replaceRange(circ, r(0, 1), 'TT');
    expect(out.seq).toBe('TT');
    expect(out.features.map((f) => f.segments)).toEqual([[r(0, 0)]]);
  });

  it('rotate, reverse-complement, re-topologize and extract', () => {
    expect(rotateOrigin(circ, 1)).toEqual(circ);
    const rc = reverseComplementRecord(lin);
    expect(rc.seq).toBe('C');
    expect(rc.features.map((f) => [f.strand, f.segments])).toEqual([
      [1, [r(0, 1)]], // was -1
      [-1, [r(1, 1)]], // site before the base is now after it
      [-1, [r(0, 0)]],
    ]);
    expect(featureSequence(rc.features[0], rc.seq)).toBe('C');
    expect(setTopology(lin, 'circular').features.map((f) => f.segments)).toEqual([[r(0, 1)], [r(0, 0)], [r(0, 0)]]);
    expect(extractRange(circ, r(0, 1)).features.map((f) => f.segments)).toEqual([[r(0, 1)], [r(0, 0)]]);
    expect(concatRecords([circ], { topology: 'circular' }).seq).toBe('G');
  });

  it('a whole-circle feature on a 1 bp circle stays whole', () => {
    const one = record('A', 'circular', [feature('all', [r(0, 1)])]);
    expect(insertBases(one, 0, 'C').features[0].segments).toEqual([r(0, 1)]); // boundary: not extended
    expect(rotateOrigin(one, 0).features[0].segments).toEqual([r(0, 1)]);
    expect(reverseComplementRecord(one).features[0].segments).toEqual([r(0, 1)]);
  });
});
