/**
 * Tests for the immutable feature / primer CRUD helpers.
 */
import { describe, expect, it } from 'vitest';
import type { Feature, Range, SeqRecord, Strand, Topology } from '../types';
import { addFeature, addPrimer, removeFeature, removePrimer, updateFeature, updatePrimer } from './crud';
import { deepFreeze, recordProblems, sharedObjectCount } from './test-helpers';

function r(start: number, end: number): Range {
  return { start, end };
}

function feature(id: string, segments: Range[], strand: Strand = 1, extra: Partial<Feature> = {}): Feature {
  return { id, type: 'CDS', name: id, strand, segments, qualifiers: [{ key: 'label', value: id }], ...extra };
}

function record(topology: Topology = 'linear'): SeqRecord {
  return deepFreeze({
    id: 'doc1',
    name: 'test',
    description: '',
    seq: 'ACGTACGTACGTACGTACGT',
    topology,
    molecule: 'DNA',
    features: [feature('a', [r(0, 5)]), feature('b', [r(5, 10)], -1, { color: '#ff0000', partialEnd: true })],
    primers: [
      { id: 'p1', name: 'fwd', sequence: 'ACGTACGT', description: 'forward' },
      { id: 'p2', name: 'rev', sequence: 'TTTTGGGG' },
    ],
    meta: { comments: ['x'] },
    ...(topology === 'linear' ? { ends: { left: { kind: '5prime', length: 2 }, right: { kind: 'blunt', length: 0 } } } : {}),
  } satisfies SeqRecord);
}

function expectClean(input: SeqRecord, out: SeqRecord): void {
  expect(recordProblems(out)).toEqual([]);
  expect(sharedObjectCount(input, out)).toBe(0);
  expect(out.seq).toBe(input.seq);
  expect(out.ends).toEqual(input.ends);
}

describe('addFeature', () => {
  it('appends a validated copy', () => {
    const rec = record();
    const f = feature('c', [r(12, 15)]);
    const out = addFeature(rec, f);
    expect(out.features.map((x) => x.id)).toEqual(['a', 'b', 'c']);
    expect(out.features[2]).toEqual(f);
    expect(out.features[2]).not.toBe(f);
    expectClean(rec, out);
  });

  it('accepts origin-crossing segments on circular records only', () => {
    expect(addFeature(record('circular'), feature('w', [r(18, 23)])).features[2].segments).toEqual([r(18, 23)]);
    expect(() => addFeature(record('linear'), feature('w', [r(18, 23)]))).toThrow(RangeError);
  });

  it('rejects invalid features', () => {
    const rec = record();
    expect(() => addFeature(rec, feature('a', [r(1, 2)]))).toThrow(/already exists/);
    expect(() => addFeature(rec, feature('c', []))).toThrow(/at least one segment/);
    expect(() => addFeature(rec, feature('c', [r(3, 2)]))).toThrow(/end < start/);
    expect(() => addFeature(rec, feature('c', [r(-1, 2)]))).toThrow(RangeError);
    expect(() => addFeature(rec, feature('c', [r(0, 2.5)]))).toThrow(/integer/);
    expect(() => addFeature(rec, feature('c', [r(1, 2)], 2 as unknown as Strand))).toThrow(/strand/);
    expect(() => addFeature(rec, { ...feature('c', [r(1, 2)]), type: '' })).toThrow(/type/);
    expect(() => addFeature(rec, feature('', [r(1, 2)]))).toThrow(/id/);
    expect(() => addFeature(record('circular'), feature('c', [r(20, 21)]))).toThrow(RangeError);
  });
});

describe('updateFeature', () => {
  it('patches fields in place in the list', () => {
    const rec = record();
    const out = updateFeature(rec, 'b', { name: 'renamed', segments: [r(6, 9)], strand: 1 });
    expect(out.features[1]).toEqual(feature('b', [r(6, 9)], 1, { name: 'renamed', color: '#ff0000', partialEnd: true }));
    expect(out.features[0]).toEqual(rec.features[0]);
    expectClean(rec, out);
  });

  it('removes optional fields patched to undefined and ignores undefined required fields', () => {
    const out = updateFeature(record(), 'b', { color: undefined, partialEnd: undefined, name: undefined });
    expect(out.features[1]).toEqual(feature('b', [r(5, 10)], -1));
    expect('color' in out.features[1]).toBe(false);
  });

  it('never changes the id and validates the result', () => {
    const rec = record();
    const sneaky = { id: 'zzz', name: 'n' } as unknown as Partial<Omit<Feature, 'id'>>;
    expect(updateFeature(rec, 'a', sneaky).features[0].id).toBe('a');
    expect(() => updateFeature(rec, 'nope', { name: 'x' })).toThrow(/no feature with id 'nope'/);
    expect(() => updateFeature(rec, 'a', { segments: [r(15, 25)] })).toThrow(RangeError);
    expect(() => updateFeature(rec, 'a', { segments: [] })).toThrow(/segment/);
  });
});

describe('removeFeature', () => {
  it('removes by id', () => {
    const rec = record();
    const out = removeFeature(rec, 'a');
    expect(out.features.map((f) => f.id)).toEqual(['b']);
    expectClean(rec, out);
    expect(() => removeFeature(rec, 'zzz')).toThrow(/no feature/);
  });
});

describe('primers', () => {
  it('addPrimer cleans the sequence and appends a copy', () => {
    const rec = record();
    const out = addPrimer(rec, { id: 'p3', name: 'new', sequence: ' gat cca u ' });
    expect(out.primers[2]).toEqual({ id: 'p3', name: 'new', sequence: 'GATCCAT' });
    expectClean(rec, out);
  });

  it('addPrimer rejects invalid primers', () => {
    const rec = record();
    expect(() => addPrimer(rec, { id: 'p1', name: 'dup', sequence: 'ACGT' })).toThrow(/already exists/);
    expect(() => addPrimer(rec, { id: 'p3', name: 'bad', sequence: 'ACGJ' })).toThrow(/'J'/);
    expect(() => addPrimer(rec, { id: 'p3', name: 'empty', sequence: ' 12 ' })).toThrow(/empty/);
    expect(() => addPrimer(rec, { id: '', name: 'x', sequence: 'ACGT' })).toThrow(/id/);
  });

  it('updatePrimer patches and validates; description undefined removes it', () => {
    const rec = record();
    const out = updatePrimer(rec, 'p1', { sequence: 'nnacgt', description: undefined });
    expect(out.primers[0]).toEqual({ id: 'p1', name: 'fwd', sequence: 'NNACGT' });
    expect(out.primers[1]).toEqual(rec.primers[1]);
    expectClean(rec, out);
    expect(() => updatePrimer(rec, 'p1', { sequence: 'AXA' })).toThrow(/'X'/);
    expect(() => updatePrimer(rec, 'p9', { name: 'x' })).toThrow(/no primer with id 'p9'/);
  });

  it('removePrimer removes by id', () => {
    const rec = record();
    const out = removePrimer(rec, 'p1');
    expect(out.primers.map((p) => p.id)).toEqual(['p2']);
    expectClean(rec, out);
    expect(() => removePrimer(rec, 'p9')).toThrow(/no primer/);
  });
});
