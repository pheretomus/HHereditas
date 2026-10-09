/**
 * Hand-written cases for the qualifier rules of qualifiers.ts: position-bearing qualifiers moved by
 * the record operations (written form kept, origin splits, fuzzy markers, drops), /codon_start and
 * /translation. Positions in qualifier values are 1-based (INSDC); ranges in code are 0-based.
 */
import { describe, expect, it } from 'vitest';
import type { Feature, Qualifier, SeqRecord } from '../types';
import { getQualifier } from '../seq/features';
import { translateFeature } from '../seq/translate';
import { deleteRange, insertBases, replaceRange } from './edit';
import { concatRecords, extractRange, reverseComplementRecord, rotateOrigin } from './transform';
import { dropTranslation, hasPositionalQualifiers, remapPositionalQualifiers, shiftCodonStart } from './qualifiers';
import type { BaseMap } from './qualifiers';

// 20 bp: 0-4 A, 5-9 C, 10-14 G, 15-19 T
const SEQ = 'AAAAACCCCCGGGGGTTTTT';

function feature(qualifiers: Qualifier[], segments = [{ start: 0, end: 20 }], strand: Feature['strand'] = 1): Feature {
  return { id: 'f', type: 'misc_feature', name: 'f', strand, segments, qualifiers };
}

function record(features: Feature[], topology: SeqRecord['topology'] = 'linear', seq = SEQ): SeqRecord {
  return { id: 'd', name: 'n', description: '', seq, topology, molecule: 'DNA', features, primers: [], meta: {} };
}

/** Value of qualifier `key` of the first feature of `rec` (undefined when dropped). */
function value(rec: SeqRecord, key: string): string | undefined {
  return getQualifier(rec.features[0].qualifiers, key);
}

describe('position-bearing qualifiers under base edits', () => {
  const te = (pos: string) => feature([{ key: 'transl_except', value: `(pos:${pos},aa:Sec)` }]);

  it('move with an insertion or deletion before them and stay put after one behind them', () => {
    expect(value(insertBases(record([te('7..9')]), 2, 'GG'), 'transl_except')).toBe('(pos:9..11,aa:Sec)');
    expect(value(deleteRange(record([te('7..9')]), { start: 0, end: 3 }), 'transl_except')).toBe('(pos:4..6,aa:Sec)');
    expect(value(insertBases(record([te('7..9')]), 9, 'GG'), 'transl_except')).toBe('(pos:7..9,aa:Sec)'); // right after it
    expect(value(insertBases(record([te('7..9')]), 6, 'GG'), 'transl_except')).toBe('(pos:9..11,aa:Sec)'); // right before it
  });

  it('are dropped when one of their bases is deleted or replaced, or bases are inserted between two of them', () => {
    expect(value(deleteRange(record([te('7..9')]), { start: 8, end: 10 }), 'transl_except')).toBeUndefined();
    expect(value(replaceRange(record([te('7..9')]), { start: 6, end: 7 }, 'T'), 'transl_except')).toBeUndefined();
    expect(value(insertBases(record([te('7..9')]), 7, 'G'), 'transl_except')).toBeUndefined();
    // an insertion between two written parts that are not adjacent bases does not cut the location
    expect(value(insertBases(record([te('join(6..7,10)')]), 8, 'G'), 'transl_except')).toBe('(pos:join(6..7,11),aa:Sec)');
  });

  it('keep their written parts when an intron between them is deleted', () => {
    // codon split by the intron [7, 9): bases 5, 6 | 9
    const out = deleteRange(record([te('join(6..7,10)')]), { start: 7, end: 9 });
    expect(value(out, 'transl_except')).toBe('(pos:join(6..7,8),aa:Sec)'); // the same bases, consecutive now
  });

  it('crossing the origin of a circle: dropped by an insertion at the origin, moved by other edits', () => {
    // the feature 16..20,1..5 crosses the origin: an insertion there joins it, between bases 20 and 1
    const circ = record([feature([{ key: 'transl_except', value: '(pos:join(20,1..2),aa:Sec)' }], [{ start: 15, end: 25 }])], 'circular');
    const grown = insertBases(circ, 0, 'G');
    expect(grown.features[0].segments).toEqual([{ start: 15, end: 26 }]);
    expect(value(grown, 'transl_except')).toBeUndefined();
    expect(value(deleteRange(circ, { start: 5, end: 8 }), 'transl_except')).toBe('(pos:join(17,1..2),aa:Sec)');
  });

  it('are cut only by bases inserted into the feature, not by bases inserted at its ends', () => {
    // a 3 bp circle read from base 2 by a feature covering it all: T G A, a selenocysteine codon
    const sec = feature([{ key: 'transl_except', value: '(pos:1..3,aa:Sec)' }], [{ start: 1, end: 4 }]);
    const circ = record([sec], 'circular', 'ATG');
    expect(translateFeature(circ, circ.features[0])).toBe('U');
    // inserted between bases 1 and 2: the feature's two ends, outside it
    const out = insertBases(circ, 1, 'CCCCC');
    expect(out.seq).toBe('ACCCCCTG');
    expect(out.features[0].segments).toEqual([{ start: 6, end: 9 }]);
    expect(value(out, 'transl_except')).toBe('(pos:join(1,7..8),aa:Sec)'); // the same three bases
    expect(translateFeature(out, out.features[0])).toBe('U');
    // inserted inside the feature, between two bases of the codon: cut
    expect(value(insertBases(circ, 2, 'C'), 'transl_except')).toBeUndefined();
  });

  it('are kept unchanged when they are not understood', () => {
    const odd: Qualifier[] = [
      { key: 'transl_except', value: '(pos:X58595.1:189..191,aa:Sec)' }, // remote location
      { key: 'transl_except', value: '(pos:30..32,aa:Sec)' }, // outside the record
      { key: 'rpt_unit_range', value: 'complement(5..8)' }, // a <base_range> has no strand
      { key: 'anticodon', value: 'pos:3..5' }, // not (pos:...)
    ];
    const out = insertBases(record([feature(odd)]), 0, 'GG');
    expect(out.features[0].qualifiers).toEqual(odd);
  });

  it('keep operators and the rest of the value (whitespace inside the location is dropped)', () => {
    const qualifiers: Qualifier[] = [
      { key: 'anticodon', value: '(pos: 7..9 ,aa:Phe,seq:aaa)' },
      { key: 'transl_except', value: '(pos:order(2,5..6),aa:TERM)' },
    ];
    const out = insertBases(record([feature(qualifiers)]), 0, 'G');
    expect(out.features[0].qualifiers).toEqual([
      { key: 'anticodon', value: '(pos:8..10,aa:Phe,seq:aaa)' },
      { key: 'transl_except', value: '(pos:order(3,6..7),aa:TERM)' },
    ]);
  });
});

describe('position-bearing qualifiers under rotation and reverse complement', () => {
  it('a run split at the new origin is written as two parts and merged again when it no longer crosses it', () => {
    const circ = record([feature([{ key: 'tag_peptide', value: '3..8' }])], 'circular');
    const mid = rotateOrigin(circ, 5);
    expect(value(mid, 'tag_peptide')).toBe('join(18..20,1..3)');
    expect(value(rotateOrigin(mid, 15), 'tag_peptide')).toBe('3..8');
    expect(value(rotateOrigin(mid, 1), 'tag_peptide')).toBe('join(17..20,1..2)'); // re-merged at the old origin, split at the new one
    expect(value(rotateOrigin(circ, 7), 'tag_peptide')).toBe('join(16..20,1)'); // a one-base piece is written n
  });

  it('written parts that do not meet at the origin are never merged', () => {
    const circ = record([feature([{ key: 'transl_except', value: '(pos:join(7,8..9),aa:Sec)' }])], 'circular');
    expect(value(rotateOrigin(circ, 3), 'transl_except')).toBe('(pos:join(4,5..6),aa:Sec)');
    expect(value(rotateOrigin(circ, 0), 'transl_except')).toBe('(pos:join(7,8..9),aa:Sec)');
  });

  it('fuzzy markers stay at their ends: no merge across a marker, swapped by reverse complement', () => {
    // two parts meeting at the origin, with markers between them
    const circ = record([feature([{ key: 'rpt_unit_range', value: 'join(19..>20,<1..2)' }])], 'circular');
    const mid = rotateOrigin(circ, 10);
    expect(value(mid, 'rpt_unit_range')).toBe('join(9..>10,<11..12)');
    expect(rotateOrigin(mid, 10)).toEqual(circ);
    // '<' at the left end becomes '>' at the right end
    const lin = record([feature([{ key: 'rpt_unit_range', value: '<5..8' }])]);
    expect(value(reverseComplementRecord(lin), 'rpt_unit_range')).toBe('13..>16');
  });

  it('reverse complement toggles complement() of /transl_except and /anticodon only', () => {
    const lin = record([
      feature(
        [
          { key: 'transl_except', value: '(pos:complement(7..9),aa:Sec)' },
          { key: 'anticodon', value: '(pos:12..14,aa:Phe,seq:aaa)' },
          { key: 'rpt_unit_range', value: '12..12' },
          { key: 'tag_peptide', value: '12' },
        ],
        [{ start: 0, end: 20 }],
        -1,
      ),
    ]);
    const rc = reverseComplementRecord(lin);
    expect(rc.features[0].qualifiers).toEqual([
      { key: 'transl_except', value: '(pos:12..14,aa:Sec)' },
      { key: 'anticodon', value: '(pos:complement(7..9),aa:Phe,seq:aaa)' },
      { key: 'rpt_unit_range', value: '9..9' }, // one-base form kept
      { key: 'tag_peptide', value: '9' },
    ]);
    expect(reverseComplementRecord(rc)).toEqual(lin);
  });

  it('a selenocysteine codon still translates as Sec after rotations that split it', () => {
    // ATG TGA AAA TAA: Met-Sec-Lys-stop with /transl_except on the TGA
    const cds: Feature = { id: 'c', type: 'CDS', name: 'c', strand: 1, segments: [{ start: 2, end: 14 }], qualifiers: [{ key: 'transl_except', value: '(pos:6..8,aa:Sec)' }] };
    const circ = record([cds], 'circular', 'CCATGTGAAAATAACCCCCC');
    for (let k = 0; k < 20; k++) {
      const out = rotateOrigin(circ, k);
      expect(translateFeature(out, out.features[0])).toBe('MUK*');
    }
  });
});

describe('position-bearing qualifiers under extraction and ligation', () => {
  it('extractRange moves them into fragment coordinates or drops them when bases are left out', () => {
    const rec = record([feature([{ key: 'transl_except', value: '(pos:7..9,aa:Sec)' }, { key: 'rpt_unit_range', value: '15..18' }])]);
    const out = extractRange(rec, { start: 4, end: 16 });
    expect(out.features[0].qualifiers).toEqual([{ key: 'transl_except', value: '(pos:3..5,aa:Sec)' }]);
  });

  it('a whole circle opened inside them writes them as a join of the fragment ends', () => {
    const circ = record([feature([{ key: 'transl_except', value: '(pos:9..11,aa:Sec)' }], [{ start: 5, end: 15 }])], 'circular');
    const out = extractRange(circ, { start: 9, end: 29 }); // opened between bases 9 and 10
    expect(out.features[0].segments).toEqual([
      { start: 16, end: 20 },
      { start: 0, end: 6 },
    ]);
    expect(value(out, 'transl_except')).toBe('(pos:join(20,1..2),aa:Sec)');
  });

  it('a split feature keeps them only on the piece holding all of their bases', () => {
    // feature 15..19,0..9 on a circle; region [5, 20) holds its end 5..9 and its start 15..19
    const f = feature(
      [
        { key: 'transl_except', value: '(pos:7..9,aa:Sec)' },
        { key: 'rpt_unit_range', value: '17..19' },
      ],
      [{ start: 15, end: 30 }],
    );
    const out = extractRange(record([f], 'circular'), { start: 5, end: 20 });
    expect(out.features.map((g) => g.segments)).toEqual([[{ start: 10, end: 15 }], [{ start: 0, end: 5 }]]);
    expect(out.features[0].qualifiers).toEqual([{ key: 'rpt_unit_range', value: '12..14' }]);
    expect(out.features[1].qualifiers).toEqual([{ key: 'transl_except', value: '(pos:2..4,aa:Sec)' }]);
  });

  it('concatRecords shifts them, and a circular product wraps them around the origin', () => {
    const a = record([], 'linear', 'GGGGG');
    const b = record([feature([{ key: 'transl_except', value: '(pos:18..20,aa:Sec)' }])]);
    expect(value(concatRecords([a, b]), 'transl_except')).toBe('(pos:23..25,aa:Sec)');
    const circ = concatRecords([b, a], { topology: 'circular' });
    expect(value(circ, 'transl_except')).toBe('(pos:18..20,aa:Sec)');
    // closing the circle merges the 2-base overhang: the last two bases are the first two
    const sticky: SeqRecord = {
      ...record([feature([{ key: 'transl_except', value: '(pos:18..20,aa:Sec)' }])], 'linear', 'AACCCCCCCCCCCCCCCCAA'),
      ends: { left: { kind: '5prime', length: 2 }, right: { kind: '5prime', length: 2 } },
    };
    const closed = concatRecords([sticky], { topology: 'circular' });
    expect(closed.seq.length).toBe(18);
    expect(value(closed, 'transl_except')).toBe('(pos:join(18,1..2),aa:Sec)');
  });
});

describe('remapPositionalQualifiers (internal)', () => {
  it('works on runs: a base map is consulted at the run ends and breaks only', () => {
    let calls = 0;
    const map: BaseMap = {
      base: (x) => {
        calls++;
        return x + 1;
      },
      breaks: [],
      oldLength: 1_000_000,
      oldCircular: false,
      newLength: 1_000_001,
      newCircular: false,
      flip: false,
      dropIfSplit: false,
    };
    const out = remapPositionalQualifiers([{ key: 'rpt_unit_range', value: '1..1000000' }], map);
    expect(out).toEqual([{ key: 'rpt_unit_range', value: '2..1000001' }]);
    expect(calls).toBeLessThanOrEqual(2);
  });

  it('throws an internal error for a base map whose breaks are missing (instead of a silently wrong value)', () => {
    const rotateBy5WithoutBreaks: BaseMap = {
      base: (x) => (x - 5 + 20) % 20,
      breaks: [],
      oldLength: 20,
      oldCircular: true,
      newLength: 20,
      newCircular: true,
      flip: false,
      dropIfSplit: false,
    };
    expect(() => remapPositionalQualifiers([{ key: 'tag_peptide', value: '3..8' }], rotateBy5WithoutBreaks)).toThrow(/internal error/);
  });

  it('hasPositionalQualifiers ignores value-less qualifiers and other keys', () => {
    expect(hasPositionalQualifiers([{ key: 'transl_except', value: null }, { key: 'note', value: '(pos:1..3,aa:Sec)' }])).toBe(false);
    expect(hasPositionalQualifiers([{ key: 'tag_peptide', value: '1..3' }])).toBe(true);
  });
});

describe('/codon_start and /translation', () => {
  it('shiftCodonStart keeps the reading frame when bases are lost at the 5\' end', () => {
    const q = (c: string): Qualifier[] => [{ key: 'codon_start', value: c }];
    // first complete codon at offset c - 1; after losing n bases it is at (c - 1 - n) mod 3
    expect(shiftCodonStart('CDS', q('1'), 1)).toEqual(q('3'));
    expect(shiftCodonStart('CDS', q('1'), 2)).toEqual(q('2'));
    expect(shiftCodonStart('CDS', q('2'), 1)).toEqual(q('1'));
    expect(shiftCodonStart('CDS', q('3'), 5)).toEqual(q('1')); // codons at 2, 5, 8, ...: the one at 5 is now first
    expect(shiftCodonStart('misc_feature', q('2'), 3)).toEqual(q('2'));
    expect(shiftCodonStart('CDS', q('7'), 1)).toEqual(q('7')); // invalid values are left alone
    // a CDS without /codon_start (implicitly 1) gets one, before its /translation
    const translation: Qualifier = { key: 'translation', value: 'MK' };
    expect(shiftCodonStart('CDS', [translation], 2)).toEqual([{ key: 'codon_start', value: '2' }, translation]);
    expect(shiftCodonStart('gene', [translation], 2)).toEqual([translation]);
    expect(shiftCodonStart('CDS', [translation], 3)).toEqual([translation]);
  });

  it('dropTranslation removes every /translation and nothing else', () => {
    const qs: Qualifier[] = [
      { key: 'translation', value: 'MK' },
      { key: 'product', value: 'p' },
      { key: 'translation', value: 'MKV' },
    ];
    expect(dropTranslation(qs)).toEqual([{ key: 'product', value: 'p' }]);
    const none: Qualifier[] = [{ key: 'product', value: 'p' }];
    expect(dropTranslation(none)).toBe(none);
  });

  it('an edit of a CDS updates /codon_start and drops /translation only when its bases change', () => {
    const cds: Feature = { id: 'c', type: 'CDS', name: 'c', strand: 1, segments: [{ start: 2, end: 14 }], qualifiers: [{ key: 'translation', value: 'MUK' }] };
    const rec = record([cds]);
    expect(deleteRange(rec, { start: 0, end: 3 }).features[0].qualifiers).toEqual([{ key: 'codon_start', value: '3' }]); // lost 1 base at the 5' end
    expect(deleteRange(rec, { start: 5, end: 6 }).features[0].qualifiers).toEqual([]); // inside: frame of what follows changes, codon_start does not
    expect(deleteRange(rec, { start: 15, end: 18 }).features[0].qualifiers).toEqual(cds.qualifiers); // elsewhere
    expect(insertBases(rec, 14, 'GGG').features[0].qualifiers).toEqual(cds.qualifiers); // at its end: not inside
    expect(replaceRange(rec, { start: 6, end: 7 }, 'C').features[0].qualifiers).toEqual([]); // replaced base: even by itself
  });
});
