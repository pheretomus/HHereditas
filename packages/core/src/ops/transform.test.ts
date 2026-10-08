/**
 * Hand-written cases for extractRange, rotateOrigin, reverseComplementRecord, setTopology and
 * concatRecords. Expected coordinates are worked out by hand in the comments.
 */
import { describe, expect, it } from 'vitest';
import type { Feature, FragmentEnds, Range, SeqRecord, Strand, Topology } from '../types';
import { reverseComplement } from '../seq/alphabet';
import { featureSequence } from '../seq/features';
import { concatRecords, extractRange, reverseComplementRecord, rotateOrigin, setTopology } from './transform';
import { deepFreeze, recordProblems, sharedObjectCount } from './test-helpers';

// 0-4 A, 5-9 C, 10-14 G, 15-19 T
const SEQ = 'AAAAACCCCCGGGGGTTTTT';
const BLUNT = { kind: 'blunt', length: 0 } as const;

function r(start: number, end: number): Range {
  return { start, end };
}

function feature(id: string, segments: Range[], strand: Strand = 1, extra: Partial<Feature> = {}): Feature {
  return { id, type: 'misc_feature', name: id, strand, segments, qualifiers: [{ key: 'label', value: id }], ...extra };
}

function record(seq: string, topology: Topology, features: Feature[], extra: Partial<SeqRecord> = {}): SeqRecord {
  return deepFreeze({
    id: 'doc1',
    name: 'test',
    description: 'a test record',
    seq,
    topology,
    molecule: 'DNA',
    features,
    primers: [{ id: 'p1', name: 'fwd', sequence: 'AAAAACCCCC', description: 'forward primer' }],
    meta: { accession: 'X1', version: 'X1.2', organism: 'synthetic construct', comments: ['c'], extras: { k: 'v' } },
    ...extra,
  });
}

function byId(rec: SeqRecord, id: string): Feature {
  const f = rec.features.find((x) => x.id === id);
  if (f === undefined) throw new Error(`no feature ${id}`);
  return f;
}

function expectClean(input: unknown, out: SeqRecord): void {
  expect(recordProblems(out)).toEqual([]);
  expect(sharedObjectCount(input, out)).toBe(0);
}

describe('extractRange', () => {
  const linear = record(SEQ, 'linear', [
    feature('inside', [r(6, 9)], 1, { partialEnd: true }),
    feature('clipLeft', [r(2, 8)], -1),
    feature('clipRight', [r(12, 18)]),
    feature('both', [r(0, 20)]),
    feature('outside', [r(16, 19)]),
    feature('touching', [r(0, 5)]),
    feature('join', [r(2, 4), r(6, 8), r(12, 14)]),
    feature('siteStart', [r(5, 5)]),
    feature('siteEnd', [r(15, 15)]),
    feature('siteOut', [r(3, 3)]),
  ]);

  it('clips overlapping features and flags clipped ends (linear)', () => {
    const out = extractRange(linear, r(5, 15));
    expect(out.seq).toBe('CCCCCGGGGG');
    const seg = (id: string) => byId(out, id).segments;
    expect(seg('inside')).toEqual([r(1, 4)]);
    expect(seg('clipLeft')).toEqual([r(0, 3)]);
    expect(seg('clipRight')).toEqual([r(7, 10)]);
    expect(seg('both')).toEqual([r(0, 10)]);
    expect(seg('join')).toEqual([r(1, 3), r(7, 9)]);
    expect(seg('siteStart')).toEqual([r(0, 0)]);
    expect(seg('siteEnd')).toEqual([r(10, 10)]);
    expect(out.features.map((f) => f.id)).toEqual(['inside', 'clipLeft', 'clipRight', 'both', 'join', 'siteStart', 'siteEnd']);
    const flags = (id: string) => [byId(out, id).partialStart ?? false, byId(out, id).partialEnd ?? false];
    expect(flags('inside')).toEqual([false, true]); // existing flag kept
    expect(flags('clipLeft')).toEqual([true, false]); // left in top-strand terms, whatever the strand
    expect(flags('clipRight')).toEqual([false, true]);
    expect(flags('both')).toEqual([true, true]);
    expect(flags('join')).toEqual([true, false]); // its first exon was dropped
    expect(featureSequence(byId(out, 'inside'), out.seq)).toBe('CCC');
    expect(featureSequence(byId(out, 'clipLeft'), out.seq)).toBe('GGG');
    expectClean(linear, out);
  });

  it('builds a new linear blunt record with copied primers and derived meta', () => {
    const sticky = record(SEQ, 'linear', [], { ends: { left: { kind: '5prime', length: 4 }, right: BLUNT } });
    const out = extractRange(sticky, r(0, 10));
    expect(out.id).not.toBe(sticky.id);
    expect(out.topology).toBe('linear');
    expect(out.ends).toBeUndefined();
    expect(out.name).toBe('test (1..10)');
    expect(out.description).toBe('Bases 1..10 of test');
    expect(out.primers).toEqual(sticky.primers);
    expect(out.meta).toEqual({ organism: 'synthetic construct', comments: ['c'], extras: { k: 'v' } });
    expect(extractRange(sticky, r(0, 10), { name: 'frag', description: 'd' })).toMatchObject({ name: 'frag', description: 'd' });
    expectClean(sticky, out);
  });

  it('extracts across the origin of a circular record', () => {
    const circ = record(SEQ, 'circular', [
      feature('wrap', [r(18, 23)]), // TT|AAA
      feature('head', [r(0, 3)], -1),
      feature('tailClip', [r(10, 17)]),
      feature('split', [r(2, 17)]), // contains both ends of the region but not its middle
      feature('far', [r(7, 9)]),
    ]);
    const out = extractRange(circ, r(15, 25));
    expect(out.seq).toBe('TTTTTAAAAA');
    expect(out.name).toBe('test (16..5)');
    expect(byId(out, 'wrap').segments).toEqual([r(3, 8)]);
    expect(featureSequence(byId(out, 'wrap'), out.seq)).toBe('TTAAA');
    expect(byId(out, 'head').segments).toEqual([r(5, 8)]);
    expect(byId(out, 'tailClip')).toMatchObject({ segments: [r(0, 2)], partialStart: true });
    // split: bases 2,3,4 (fragment 7..9, the feature's start) and 15,16 (fragment 0..1, its end)
    const pieces = out.features.filter((f) => f.name === 'split');
    expect(pieces).toHaveLength(2);
    expect(pieces[0]).toMatchObject({ id: 'split', segments: [r(7, 10)], partialEnd: true });
    expect(pieces[0].partialStart).toBeUndefined();
    expect(pieces[1]).toMatchObject({ segments: [r(0, 2)], partialStart: true });
    expect(pieces[1].partialEnd).toBeUndefined();
    expect(pieces[1].id).not.toBe('split');
    expect(out.features.some((f) => f.id === 'far')).toBe(false);
    expectClean(circ, out);
  });

  it('extracts the whole circle opened anywhere, keeping features that cross the opening as joins', () => {
    const circ = record(SEQ, 'circular', [feature('wrap', [r(18, 23)]), feature('cross', [r(2, 8)], -1)]);
    const out = extractRange(circ, r(5, 25));
    expect(out.seq).toBe('CCCCCGGGGGTTTTTAAAAA');
    expect(byId(out, 'wrap').segments).toEqual([r(13, 18)]);
    expect(byId(out, 'cross').segments).toEqual([r(17, 20), r(0, 3)]); // AAA|CCC, no bases lost
    expect(byId(out, 'cross').partialStart).toBeUndefined();
    expect(featureSequence(byId(out, 'cross'), out.seq)).toBe(featureSequence(circ.features[1], circ.seq));
  });

  it('handles empty ranges and validates the range', () => {
    const out = extractRange(linear, r(3, 3));
    expect(out.seq).toBe('');
    expect(out.features.map((f) => [f.id, f.segments])).toEqual([['siteOut', [r(0, 0)]]]);
    expect(() => extractRange(linear, r(15, 25))).toThrow(RangeError);
    expect(() => extractRange(linear, r(3, 2))).toThrow(RangeError);
  });
});

describe('rotateOrigin', () => {
  const circ = record(SEQ, 'circular', [
    feature('wrap', [r(18, 23)], 1, { partialStart: true }),
    feature('early', [r(2, 4)], -1),
    feature('crossNew', [r(3, 7)]),
    feature('all', [r(0, 20)]),
    feature('site5', [r(5, 5)]),
    feature('site0', [r(0, 0)]),
    feature('join', [r(17, 20), r(0, 2)]),
  ]);

  it('makes base k the first base and re-bases every segment', () => {
    const out = rotateOrigin(circ, 5);
    expect(out.seq).toBe('CCCCCGGGGGTTTTTAAAAA');
    expect(out.features.map((f) => f.segments)).toEqual([
      [r(13, 18)],
      [r(17, 19)],
      [r(18, 22)], // now crosses the new origin
      [r(15, 35)], // the whole circle starting at old base 0
      [r(0, 0)],
      [r(15, 15)],
      [r(12, 15), r(15, 17)], // touching segments are not merged
    ]);
    for (const [i, f] of circ.features.entries()) {
      expect(featureSequence(out.features[i], out.seq)).toBe(featureSequence(f, circ.seq));
    }
    expect(out.features[0].partialStart).toBe(true);
    expect(out.id).toBe(circ.id);
    expectClean(circ, out);
  });

  it('takes the new origin modulo the length', () => {
    expect(rotateOrigin(circ, -1)).toEqual(rotateOrigin(circ, 19));
    expect(rotateOrigin(circ, 25)).toEqual(rotateOrigin(circ, 5));
    expect(rotateOrigin(circ, 20)).toEqual(circ);
    expect(rotateOrigin(rotateOrigin(circ, 7), 13)).toEqual(circ);
  });

  it('rejects linear records and non-integer origins', () => {
    expect(() => rotateOrigin(record(SEQ, 'linear', []), 3)).toThrow(/linear/);
    expect(() => rotateOrigin(circ, 1.5)).toThrow(RangeError);
  });
});

describe('reverseComplementRecord', () => {
  it('flips coordinates, strands, segment order and partial flags (linear)', () => {
    const rec = record('AACCGGTTAC', 'linear', [
      feature('fwd', [r(2, 5)]), // CCG
      feature('join', [r(0, 2), r(4, 6)], 1, { partialStart: true }), // AA + GG
      feature('none', [r(1, 3)], 0),
      feature('rev', [r(7, 10)], -1, { partialEnd: false }), // top TAC -> GTA
      feature('site0', [r(0, 0)]),
    ]);
    const out = reverseComplementRecord(rec);
    expect(out.seq).toBe('GTAACCGGTT');
    expect(out.features).toEqual([
      feature('fwd', [r(5, 8)], -1),
      feature('join', [r(4, 6), r(8, 10)], -1, { partialEnd: true }),
      feature('none', [r(7, 9)], 0),
      feature('rev', [r(0, 3)], 1, { partialStart: false }),
      feature('site0', [r(10, 10)], -1),
    ]);
    expect(featureSequence(out.features[0], out.seq)).toBe('CCG');
    expect(featureSequence(out.features[1], out.seq)).toBe('AAGG');
    expect(featureSequence(out.features[3], out.seq)).toBe('GTA');
    expectClean(rec, out);
  });

  it('keeps the origin at the same gap of a circular molecule', () => {
    const rec = record(SEQ, 'circular', [feature('wrap', [r(18, 23)]), feature('s', [r(0, 0)]), feature('all', [r(3, 23)])]);
    const out = reverseComplementRecord(rec);
    expect(out.seq).toBe(reverseComplement(SEQ));
    // [18, 23) -> [20 - 23, 20 - 18) = [-3, 2) -> [17, 22)
    expect(out.features.map((f) => f.segments)).toEqual([[r(17, 22)], [r(0, 0)], [r(17, 37)]]);
    expect(featureSequence(out.features[0], out.seq)).toBe('TTAAA');
  });

  it('swaps sticky ends: a left 5prime overhang becomes a right 5prime overhang', () => {
    const ends: FragmentEnds = { left: { kind: '5prime', length: 4 }, right: { kind: '3prime', length: 2 } };
    const rec = record('AATTCGGGCA', 'linear', [], { ends });
    const out = reverseComplementRecord(rec);
    expect(out.ends).toEqual({ left: { kind: '3prime', length: 2 }, right: { kind: '5prime', length: 4 } });
    // the overhang bases are the last 4 bases now, still single-stranded on the same physical strand
    expect(out.seq.slice(-4)).toBe('AATT');
  });

  it('handles IUPAC codes, is an involution and rejects proteins', () => {
    const rec = record('ACGTRYKMSWBDHVN', 'linear', [feature('x', [r(4, 9)])]);
    const out = reverseComplementRecord(rec);
    expect(out.seq).toBe('NBDHVWSKMRYACGT');
    expect(featureSequence(out.features[0], out.seq)).toBe('RYKMS');
    expect(reverseComplementRecord(out)).toEqual(rec);
    expect(() => reverseComplementRecord(record('MKV', 'linear', [], { molecule: 'protein' }))).toThrow(/protein/);
  });
});

describe('setTopology', () => {
  it('circular -> linear opens at the origin, splitting origin-crossing segments', () => {
    const circ = record(SEQ, 'circular', [feature('wrap', [r(18, 23)], -1), feature('all', [r(5, 25)]), feature('plain', [r(2, 6)])]);
    const out = setTopology(circ, 'linear');
    expect(out.topology).toBe('linear');
    expect(out.features.map((f) => f.segments)).toEqual([[r(18, 20), r(0, 3)], [r(5, 20), r(0, 5)], [r(2, 6)]]);
    expect(featureSequence(out.features[0], out.seq)).toBe(featureSequence(circ.features[0], circ.seq));
    expect(out.ends).toBeUndefined();
    expectClean(circ, out);
  });

  it('linear -> circular keeps features, moves a site at gap L to gap 0 and drops sticky ends', () => {
    const lin = record(SEQ, 'linear', [feature('a', [r(15, 20)]), feature('end', [r(20, 20)]), feature('j', [r(18, 20), r(0, 2)])], {
      ends: { left: { kind: '5prime', length: 4 }, right: BLUNT },
    });
    const out = setTopology(lin, 'circular');
    expect(out.features.map((f) => f.segments)).toEqual([[r(15, 20)], [r(0, 0)], [r(18, 20), r(0, 2)]]);
    expect(out.ends).toBeUndefined();
    expect(setTopology(record('', 'linear', [feature('s', [r(0, 0)])]), 'circular').features).toEqual([]);
  });

  it('with the same topology returns an equal copy', () => {
    const lin = record(SEQ, 'linear', [feature('a', [r(1, 2)])], { ends: { left: BLUNT, right: { kind: '3prime', length: 1 } } });
    const out = setTopology(lin, 'linear');
    expect(out).toEqual(lin);
    expectClean(lin, out);
  });
});

describe('concatRecords', () => {
  it('joins blunt fragments and shifts features', () => {
    const a = record('AAAA', 'linear', [feature('a1', [r(1, 3)])], { name: 'a' });
    const b = record('CCCC', 'linear', [feature('b1', [r(0, 2)], -1), feature('s', [r(4, 4)])], { name: 'b' });
    const out = concatRecords([a, b]);
    expect(out.seq).toBe('AAAACCCC');
    expect(out.features.map((f) => [f.id, f.segments])).toEqual([
      ['a1', [r(1, 3)]],
      ['b1', [r(4, 6)]],
      ['s', [r(8, 8)]],
    ]);
    expect(out.name).toBe('a + b');
    expect(out.description).toBe('Joined from a, b');
    expect(out.id).not.toBe(a.id);
    expect(out.meta).toEqual({ organism: 'synthetic construct', comments: ['c'], extras: { k: 'v' } });
    expect(out.ends).toBeUndefined();
    expectClean([a, b], out);
  });

  it('ligates compatible 5prime overhangs once (EcoRI example of types.ts)', () => {
    const left = record('CCGAATT', 'linear', [feature('L', [r(2, 7)])], {
      name: 'left',
      ends: { left: { kind: '3prime', length: 1 }, right: { kind: '5prime', length: 4 } },
    });
    const right = record('AATTCGG', 'linear', [feature('R', [r(0, 5)], -1)], {
      name: 'right',
      ends: { left: { kind: '5prime', length: 4 }, right: BLUNT },
    });
    const out = concatRecords([left, right]);
    expect(out.seq).toBe('CCGAATTCGG');
    expect(byId(out, 'L').segments).toEqual([r(2, 7)]);
    expect(byId(out, 'R').segments).toEqual([r(3, 8)]);
    expect(featureSequence(byId(out, 'R'), out.seq)).toBe('GAATT');
    expect(out.ends).toEqual({ left: { kind: '3prime', length: 1 }, right: BLUNT });
  });

  it('ligates compatible 3prime overhangs (PstI CTGCA^G)', () => {
    const left = record('GGCTGCA', 'linear', [], { ends: { left: BLUNT, right: { kind: '3prime', length: 4 } } });
    const right = record('TGCAGTT', 'linear', [], { ends: { left: { kind: '3prime', length: 4 }, right: BLUNT } });
    expect(concatRecords([left, right]).seq).toBe('GGCTGCAGTT');
  });

  it('rejects incompatible junctions with a message naming them', () => {
    const eco = (seq: string, kind: '5prime' | '3prime', n: number, side: 'left' | 'right', name: string) =>
      record(seq, 'linear', [], { name, ends: side === 'left' ? { left: { kind, length: n }, right: BLUNT } : { left: BLUNT, right: { kind, length: n } } });
    const a = eco('CCGAATT', '5prime', 4, 'right', 'a');
    expect(() => concatRecords([a, eco('AATTCGG', '3prime', 4, 'left', 'b')])).toThrow(/between part 1 \('a'\) and part 2 \('b'\)/);
    expect(() => concatRecords([a, eco('AATTCGG', '5prime', 2, 'left', 'b')])).toThrow(/incompatible ends/);
    expect(() => concatRecords([a, eco('TCGACGG', '5prime', 4, 'left', 'b')])).toThrow(/overhang 'AATT' does not match 'TCGA'/);
    expect(() => concatRecords([a, record('CGG', 'linear', [])])).toThrow(/5' overhang of 4 cannot be joined to blunt/);
  });

  it('closes a circle when the outer ends are compatible (self-ligation)', () => {
    const ends: FragmentEnds = { left: { kind: '5prime', length: 4 }, right: { kind: '5prime', length: 4 } };
    const frag = record('AATTCACGTACGTGAATT', 'linear', [
      feature('rightOverhang', [r(14, 18)]),
      feature('crossing', [r(10, 18)], -1),
      feature('everything', [r(0, 18)]),
      feature('endSite', [r(18, 18)]),
    ], { ends });
    const out = concatRecords([frag], { topology: 'circular' });
    expect(out.seq).toBe('AATTCACGTACGTG');
    expect(out.topology).toBe('circular');
    expect(out.ends).toBeUndefined();
    expect(out.name).toBe('test');
    expect(out.features.map((f) => f.segments)).toEqual([
      [r(0, 4)], // the right overhang is the same bases as the left one
      [r(10, 18)], // crosses the new origin
      [r(0, 14)], // longer than the circle: clamped to one turn
      [r(4, 4)], // after the right overhang's last base, which is base 3 of the circle
    ]);
    expect(featureSequence(out.features[1], out.seq)).toBe(featureSequence(frag.features[1], frag.seq));
    expect(recordProblems(out)).toEqual([]);
    expect(() => concatRecords([record('AATTCGG', 'linear', [], { ends: { left: ends.left, right: BLUNT } })], { topology: 'circular' })).toThrow(
      /closing the circle/,
    );
    const tiny = record('AATT', 'linear', [], { ends });
    expect(() => concatRecords([tiny], { topology: 'circular' })).toThrow(/nothing would remain/);
  });

  it('opens circular parts at their origin and joins them blunt', () => {
    const circ = record('GGGGCC', 'circular', [feature('w', [r(4, 8)])], { name: 'c' });
    const out = concatRecords([record('AA', 'linear', [], { name: 'a' }), circ]);
    expect(out.seq).toBe('AAGGGGCC');
    expect(byId(out, 'w').segments).toEqual([r(6, 8), r(2, 4)]);
    expect(featureSequence(byId(out, 'w'), out.seq)).toBe('CCGG');
  });

  it('renames colliding feature ids and merges primers without duplicates', () => {
    const a = record('AAAA', 'linear', [feature('f', [r(0, 2)])], { primers: [{ id: 'p1', name: 'fwd', sequence: 'AAAA' }] });
    const b = record('CCCC', 'linear', [feature('f', [r(0, 2)])], {
      primers: [
        { id: 'p1', name: 'fwd', sequence: 'AAAA' }, // exact duplicate: dropped
        { id: 'p1', name: 'rev', sequence: 'GGGG' }, // same id, different primer: renamed
      ],
    });
    const out = concatRecords([a, b], { name: 'joined' });
    expect(out.name).toBe('joined');
    expect(out.features[0].id).toBe('f');
    expect(out.features[1].id).not.toBe('f');
    expect(out.features[1].name).toBe('f');
    expect(out.primers.map((p) => p.name)).toEqual(['fwd', 'rev']);
    expect(new Set(out.primers.map((p) => p.id)).size).toBe(2);
  });

  it('validates its arguments', () => {
    expect(() => concatRecords([])).toThrow(/at least one part/);
    expect(() => concatRecords([record('AC', 'linear', []), record('MK', 'linear', [], { molecule: 'protein' })])).toThrow(/protein/);
  });
});
