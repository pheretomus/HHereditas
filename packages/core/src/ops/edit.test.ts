/**
 * Hand-written cases for insertBases / deleteRange / replaceRange on whole records.
 * Sequences are chosen so that every feature's expected sequence can be read off by eye.
 */
import { describe, expect, it } from 'vitest';
import type { Feature, FragmentEnds, Range, SeqRecord, Strand, Topology } from '../types';
import { featureSequence } from '../seq/features';
import { deleteRange, insertBases, replaceRange } from './edit';
import { deepFreeze, recordProblems, sharedObjectCount } from './test-helpers';

// 0-4 A, 5-9 C, 10-14 G, 15-19 T
const SEQ = 'AAAAACCCCCGGGGGTTTTT';

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
    primers: [{ id: 'p1', name: 'fwd', sequence: 'AAAAACCCCC' }],
    meta: { accession: 'X1', comments: ['c'] },
    ...extra,
  });
}

/** Map feature id -> [segments, feature sequence]. */
function summary(rec: SeqRecord): Record<string, [Range[], string]> {
  return Object.fromEntries(rec.features.map((f) => [f.id, [f.segments, featureSequence(f, rec.seq)]]));
}

function expectClean(input: unknown, out: SeqRecord): void {
  expect(recordProblems(out)).toEqual([]);
  expect(sharedObjectCount(input, out)).toBe(0);
}

describe('insertBases', () => {
  const linear = record(SEQ, 'linear', [
    feature('left', [r(2, 8)]), // AAACCC
    feature('touch', [r(5, 10)]), // ends at the gap
    feature('span', [r(8, 12)], -1), // CCGG, contains gap 10
    feature('right', [r(10, 15)], -1), // starts at the gap
    feature('site', [r(10, 10)], 0), // between-base site at the gap
  ]);

  it('inserts text and remaps features (linear)', () => {
    const out = insertBases(linear, 10, 'tt');
    expect(out.seq).toBe('AAAAACCCCCTTGGGGGTTTTT');
    expect(summary(out)).toEqual({
      left: [[r(2, 8)], 'AAACCC'],
      touch: [[r(5, 10)], 'CCCCC'], // not extended
      span: [[r(8, 14)], 'CCAAGG'], // top CCTTGG, minus strand
      right: [[r(12, 17)], 'CCCCC'], // shifted (top GGGGG)
      site: [[r(10, 10)], ''], // stays before the insertion
    });
    expectClean(linear, out);
    // identity fields kept
    expect(out.id).toBe(linear.id);
    expect(out.primers).toEqual(linear.primers);
    expect(out.meta).toEqual(linear.meta);
  });

  it('cleans pasted text with normalizeDna and rejects invalid characters', () => {
    expect(insertBases(linear, 0, ' a c\ng u 12 ').seq).toBe(`ACGT${SEQ}`);
    expect(insertBases(linear, 20, 'ryswkmbdhvn').seq).toBe(`${SEQ}RYSWKMBDHVN`);
    expect(() => insertBases(linear, 0, 'ACXGZ')).toThrow(/invalid nucleotide character\(s\) 'X', 'Z'/);
    expect(() => insertBases(linear, 0, 'ACE')).toThrow(Error);
  });

  it('inserts at gap 0 and at gap L of a linear record', () => {
    const rec = record(SEQ, 'linear', [feature('a', [r(0, 5)]), feature('z', [r(15, 20)]), feature('s0', [r(0, 0)]), feature('sL', [r(20, 20)])]);
    const at0 = insertBases(rec, 0, 'GG');
    expect(at0.seq).toBe(`GG${SEQ}`);
    expect(summary(at0)).toEqual({ a: [[r(2, 7)], 'AAAAA'], z: [[r(17, 22)], 'TTTTT'], s0: [[r(0, 0)], ''], sL: [[r(22, 22)], ''] });
    const atL = insertBases(rec, 20, 'GG');
    expect(atL.seq).toBe(`${SEQ}GG`);
    expect(summary(atL)).toEqual({ a: [[r(0, 5)], 'AAAAA'], z: [[r(15, 20)], 'TTTTT'], s0: [[r(0, 0)], ''], sL: [[r(20, 20)], ''] });
  });

  it('appends at gap 0 of a circular record, growing origin-crossing features', () => {
    const rec = record(SEQ, 'circular', [
      feature('wrap', [r(18, 23)]), // TT|AAA
      feature('first', [r(0, 5)]),
      feature('last', [r(15, 20)], -1),
      feature('origin', [r(0, 0)], 0),
    ]);
    const at0 = insertBases(rec, 0, 'GG');
    expect(at0.seq).toBe(`${SEQ}GG`);
    expect(summary(at0)).toEqual({
      wrap: [[r(18, 25)], 'TTGGAAA'],
      first: [[r(0, 5)], 'AAAAA'],
      last: [[r(15, 20)], 'AAAAA'], // touches the origin: not extended
      origin: [[r(20, 20)], ''], // before the inserted bases
    });
    expect(insertBases(rec, 20, 'GG')).toEqual(at0);
    expectClean(rec, at0);
  });

  it('extends an origin-crossing feature when inserting in its wrapped part', () => {
    const rec = record(SEQ, 'circular', [feature('wrap', [r(18, 23)], -1)]); // top TTAAA
    const out = insertBases(rec, 1, 'CC');
    expect(out.seq).toBe('ACCAAAACCCCCGGGGGTTTTT');
    // 18,19 -> 20,21; 0 -> 0; C,C -> 1,2; 1,2 -> 3,4: [20, 27) on length 22; top TTACCAA
    expect(summary(out)).toEqual({ wrap: [[r(20, 27)], 'TTGGTAA'] });
  });

  it('extends exons containing the gap and shifts the others (multi-segment)', () => {
    const rec = record(SEQ, 'linear', [feature('cds', [r(2, 5), r(10, 13)])]); // AAA + GGG
    expect(summary(insertBases(rec, 7, 'TTT'))).toEqual({ cds: [[r(2, 5), r(13, 16)], 'AAAGGG'] }); // intron
    expect(summary(insertBases(rec, 11, 'TT'))).toEqual({ cds: [[r(2, 5), r(10, 15)], 'AAAGTTGG'] });
    expect(summary(insertBases(rec, 5, 'TT'))).toEqual({ cds: [[r(2, 5), r(12, 15)], 'AAAGGG'] }); // exon end
  });

  it('inserts another record with its features', () => {
    const insert = record('GGATCCAT', 'linear', [feature('bamHI', [r(0, 6)]), feature('span', [r(4, 8)], -1)], {
      primers: [{ id: 'px', name: 'other', sequence: 'GGATCC' }],
      ends: { left: { kind: '5prime', length: 4 }, right: { kind: 'blunt', length: 0 } },
    });
    const target = record(SEQ, 'linear', [feature('span', [r(8, 12)]), feature('bamHI', [r(0, 2)])]);
    const out = insertBases(target, 10, insert);
    expect(out.seq).toBe('AAAAACCCCCGGATCCATGGGGGTTTTT');
    expect(out.features.map((f) => f.segments)).toEqual([[r(8, 20)], [r(0, 2)], [r(10, 16)], [r(14, 18)]]);
    // colliding ids are regenerated, the others kept; labels identify the carried features
    expect(out.features.slice(2).map((f) => f.name)).toEqual(['bamHI', 'span']);
    expect(new Set(out.features.map((f) => f.id)).size).toBe(4);
    expect(featureSequence(out.features[2], out.seq)).toBe('GGATCC');
    expect(featureSequence(out.features[3], out.seq)).toBe('ATGG'); // revcomp of CCAT
    // the inserted record's primers and ends are not merged
    expect(out.primers).toEqual(target.primers);
    expect(out.ends).toBeUndefined();
    expectClean([target, insert], out);
  });

  it('opens a circular inserted record at its origin', () => {
    const insert = record('GGATCC', 'circular', [feature('w', [r(4, 8)])]); // CC|GG
    const out = insertBases(record('AAAA', 'linear', []), 2, insert);
    expect(out.seq).toBe('AAGGATCCAA');
    expect(summary(out)).toEqual({ w: [[r(6, 8), r(2, 4)], 'CCGG'] });
  });

  it('does not reuse the id of a feature removed by the same edit', () => {
    const target = record(SEQ, 'linear', [feature('a', [r(5, 10)])]);
    const insert = record('GG', 'linear', [feature('a', [r(0, 2)])]);
    const out = replaceRange(target, r(5, 10), insert);
    expect(out.features).toHaveLength(1);
    expect(out.features[0].id).not.toBe('a');
    expect(out.features[0].name).toBe('a');
  });

  it('rejects text for protein records and molecule mismatches', () => {
    const protein = record('MKV', 'linear', [], { molecule: 'protein' });
    expect(() => insertBases(protein, 1, 'A')).toThrow(/protein/);
    expect(() => insertBases(linear, 1, protein)).toThrow(/protein/);
    expect(insertBases(protein, 1, record('W', 'linear', [], { molecule: 'protein' })).seq).toBe('MWKV');
  });

  it('validates the gap', () => {
    expect(() => insertBases(linear, -1, 'A')).toThrow(RangeError);
    expect(() => insertBases(linear, 21, 'A')).toThrow(RangeError);
    expect(() => insertBases(linear, 2.5, 'A')).toThrow(RangeError);
  });

  it('with nothing to insert returns an equal copy', () => {
    const out = insertBases(linear, 7, '');
    expect(out).toEqual(linear);
    expect(out).not.toBe(linear);
    expectClean(linear, out);
  });
});

describe('deleteRange', () => {
  it('trims, shifts and removes features (linear)', () => {
    const rec = record(SEQ, 'linear', [
      feature('trimRight', [r(3, 7)], 1, { partialEnd: false }), // AACC
      feature('inside', [r(5, 10)]),
      feature('trimLeft', [r(8, 12)], -1, { partialStart: true }), // CCGG
      feature('join', [r(0, 2), r(6, 8), r(12, 14)]), // AA + CC + GG
      feature('before', [r(0, 5)]),
      feature('after', [r(10, 15)]),
      feature('siteIn', [r(7, 7)]),
      feature('siteEdge', [r(10, 10)]),
    ]);
    const out = deleteRange(rec, r(5, 10));
    expect(out.seq).toBe('AAAAAGGGGGTTTTT');
    expect(summary(out)).toEqual({
      trimRight: [[r(3, 5)], 'AA'],
      trimLeft: [[r(5, 7)], 'CC'], // top GG
      join: [[r(0, 2), r(7, 9)], 'AAGG'],
      before: [[r(0, 5)], 'AAAAA'],
      after: [[r(5, 10)], 'GGGGG'],
      siteEdge: [[r(5, 5)], ''],
    });
    // partial flags are left as they were
    expect(out.features.find((f) => f.id === 'trimLeft')?.partialStart).toBe(true);
    expect(out.features.find((f) => f.id === 'trimRight')?.partialEnd).toBe(false);
    expectClean(rec, out);
  });

  it('across the origin: the first base after the deleted region becomes base 0', () => {
    const rec = record(SEQ, 'circular', [
      feature('tail', [r(16, 21)]), // TTTT A
      feature('head', [r(1, 6)], -1), // AAAAC
      feature('gone', [r(19, 22)]),
      feature('big', [r(10, 25)]), // GGGGGTTTTT AAAAA, contains the deleted region
    ]);
    const out = deleteRange(rec, r(18, 23)); // deletes T,T,A,A,A
    expect(out.seq).toBe('AACCCCCGGGGGTTT');
    expect(summary(out)).toEqual({
      tail: [[r(13, 15)], 'TT'],
      head: [[r(0, 3)], 'GTT'], // top AAC
      big: [[r(7, 17)], 'GGGGGTTTAA'],
    });
    expectClean(rec, out);
  });

  it('keeps the origin when it survives, or moves it to the first base after the region', () => {
    const rec = record(SEQ, 'circular', [feature('wrap', [r(18, 22)])]);
    expect(deleteRange(rec, r(5, 10)).seq).toBe('AAAAAGGGGGTTTTT');
    const first = deleteRange(rec, r(0, 3)); // origin deleted: old base 3 becomes base 0
    expect(first.seq).toBe('AACCCCCGGGGGTTTTT');
    expect(summary(first)).toEqual({ wrap: [[r(15, 17)], 'TT'] });
  });

  it('of everything leaves an empty record', () => {
    const lin = record(SEQ, 'linear', [feature('a', [r(2, 4)]), feature('s', [r(20, 20)])]);
    const out = deleteRange(lin, r(0, 20));
    expect(out.seq).toBe('');
    expect(summary(out)).toEqual({ s: [[r(0, 0)], ''] });
    const circ = record(SEQ, 'circular', [feature('a', [r(2, 4)]), feature('s', [r(3, 3)])]);
    const empty = deleteRange(circ, r(3, 23));
    expect(empty.seq).toBe('');
    expect(empty.features).toEqual([]);
    expect(recordProblems(empty)).toEqual([]);
  });

  it('of an empty range is an equal copy', () => {
    const rec = record(SEQ, 'circular', [feature('wrap', [r(18, 22)])]);
    expect(deleteRange(rec, r(4, 4))).toEqual(rec);
  });

  it('validates the range', () => {
    const lin = record(SEQ, 'linear', []);
    expect(() => deleteRange(lin, r(18, 22))).toThrow(RangeError); // wrapping on a linear record
    expect(() => deleteRange(lin, r(5, 4))).toThrow(/end < start/);
    expect(() => deleteRange(record(SEQ, 'circular', []), r(25, 26))).toThrow(RangeError);
  });
});

describe('replaceRange', () => {
  it('keeps a feature strictly containing the region over the replacement', () => {
    const rec = record(SEQ, 'linear', [
      feature('outer', [r(2, 15)], -1), // AAACCCCCGGGGG
      feature('exact', [r(5, 10)]),
      feature('leftEdge', [r(5, 12)]),
      feature('rightEdge', [r(2, 10)]),
      feature('siteL', [r(5, 5)]),
      feature('siteR', [r(10, 10)]),
    ]);
    const out = replaceRange(rec, r(5, 10), 'tat');
    expect(out.seq).toBe('AAAAATATGGGGGTTTTT');
    expect(summary(out)).toEqual({
      outer: [[r(2, 13)], 'CCCCCATAUTT'.replace('U', 'T')], // top AAATATGGGGG
      leftEdge: [[r(8, 10)], 'GG'],
      rightEdge: [[r(2, 5)], 'AAA'],
      siteL: [[r(5, 5)], ''],
      siteR: [[r(8, 8)], ''],
    });
    expectClean(rec, out);
  });

  it('across the origin: the replacement starts the new sequence', () => {
    const rec = record(SEQ, 'circular', [feature('big', [r(15, 25)]), feature('site', [r(3, 3)])]);
    const out = replaceRange(rec, r(18, 23), 'GC');
    expect(out.seq).toBe('GCAACCCCCGGGGGTTT');
    // big: TTT + GC + AA ; site after the replacement
    expect(summary(out)).toEqual({ big: [[r(14, 21)], 'TTTGCAA'], site: [[r(2, 2)], ''] });
  });

  it('replacing the first bases of a circular record keeps the replacement at the origin', () => {
    const rec = record(SEQ, 'circular', []);
    expect(replaceRange(rec, r(0, 3), 'GG').seq).toBe('GGAACCCCCGGGGGTTTTT');
  });

  it('with a record carries its features', () => {
    const rec = record(SEQ, 'linear', [feature('outer', [r(2, 15)])]);
    const part = record('GAATTC', 'linear', [feature('ecoRI', [r(0, 6)])]);
    const out = replaceRange(rec, r(5, 10), part);
    expect(out.seq).toBe('AAAAAGAATTCGGGGGTTTTT');
    expect(summary(out)).toEqual({ outer: [[r(2, 16)], 'AAAGAATTCGGGGG'], ecoRI: [[r(5, 11)], 'GAATTC'] });
  });

  it('equals insertBases for an empty range and deleteRange for an empty replacement', () => {
    const rec = record(SEQ, 'circular', [feature('w', [r(18, 23)]), feature('s', [r(0, 0)])]);
    expect(replaceRange(rec, r(0, 0), 'CC')).toEqual(insertBases(rec, 0, 'CC'));
    expect(replaceRange(rec, r(18, 23), '')).toEqual(deleteRange(rec, r(18, 23)));
  });

  it('validates the replacement text', () => {
    expect(() => replaceRange(record(SEQ, 'linear', []), r(1, 2), 'AQ')).toThrow(/'Q'/);
  });
});

describe('sticky ends under edits', () => {
  // EcoRI fragment: 5' AATT overhangs on both sides (see FragmentEnds in types.ts)
  const ECO = 'AATTCACGTACGTGAATT';
  const ends: FragmentEnds = { left: { kind: '5prime', length: 4 }, right: { kind: '5prime', length: 4 } };
  const frag = record(ECO, 'linear', [], { ends });
  const L = ECO.length; // 18

  const endsAfter = (out: SeqRecord) => out.ends;

  it('insertions inside an overhang or at the outer terminus lengthen it', () => {
    expect(endsAfter(insertBases(frag, 2, 'GG'))?.left).toEqual({ kind: '5prime', length: 6 });
    expect(endsAfter(insertBases(frag, 0, 'GG'))?.left).toEqual({ kind: '5prime', length: 6 });
    expect(endsAfter(insertBases(frag, L, 'GG'))?.right).toEqual({ kind: '5prime', length: 6 });
    expect(endsAfter(insertBases(frag, L - 1, 'GG'))?.right).toEqual({ kind: '5prime', length: 6 });
  });

  it('insertions at the single-/double-strand junction or elsewhere leave overhangs alone', () => {
    expect(endsAfter(insertBases(frag, 4, 'GG'))).toEqual(ends);
    expect(endsAfter(insertBases(frag, L - 4, 'GG'))).toEqual(ends);
    expect(endsAfter(insertBases(frag, 9, 'GG'))).toEqual(ends);
  });

  it('deleted single-stranded bases shorten the overhang', () => {
    expect(endsAfter(deleteRange(frag, r(0, 2)))?.left).toEqual({ kind: '5prime', length: 2 });
    expect(endsAfter(deleteRange(frag, r(2, 6)))?.left).toEqual({ kind: '5prime', length: 2 });
    expect(endsAfter(deleteRange(frag, r(0, 4)))?.left).toEqual({ kind: 'blunt', length: 0 });
    expect(endsAfter(deleteRange(frag, r(L - 6, L - 1)))?.right).toEqual({ kind: '5prime', length: 1 });
    expect(endsAfter(deleteRange(frag, r(0, L)))).toEqual({ left: { kind: 'blunt', length: 0 }, right: { kind: 'blunt', length: 0 } });
  });

  it('replacing only single-stranded bases keeps the replacement single-stranded', () => {
    expect(endsAfter(replaceRange(frag, r(1, 3), 'CCC'))?.left).toEqual({ kind: '5prime', length: 5 });
    expect(endsAfter(replaceRange(frag, r(0, 4), 'GATC'))?.left).toEqual({ kind: '5prime', length: 4 });
    expect(endsAfter(replaceRange(frag, r(L - 4, L), 'TCGA'))?.right).toEqual({ kind: '5prime', length: 4 });
    // replacing single- and double-stranded bases: the replacement is double-stranded
    expect(endsAfter(replaceRange(frag, r(2, 6), 'CC'))?.left).toEqual({ kind: '5prime', length: 2 });
  });

  it('keeps 3prime kinds and records without ends', () => {
    const pst = record('TGCACTGCAGACGTTGCA', 'linear', [], { ends: { left: { kind: '3prime', length: 4 }, right: { kind: 'blunt', length: 0 } } });
    expect(insertBases(pst, 1, 'A').ends).toEqual({ left: { kind: '3prime', length: 5 }, right: { kind: 'blunt', length: 0 } });
    expect(insertBases(record(ECO, 'linear', []), 0, 'A').ends).toBeUndefined();
  });

  it('circular results never carry ends', () => {
    const odd = record(ECO, 'circular', [], { ends });
    expect(insertBases(odd, 3, 'A').ends).toBeUndefined();
  });
});
