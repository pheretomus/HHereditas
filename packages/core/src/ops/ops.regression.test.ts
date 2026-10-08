/**
 * Regression tests for defects reported by the adversarial reviews of the ops module. Each
 * `describe` reproduces one finding (the reviewer's reproduction, adapted to this folder) and
 * pins the corrected behaviour.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Feature, SeqRecord } from '../types';
import { isDna } from '../seq/alphabet';
import { featureSequence, getQualifier } from '../seq/features';
import { translateFeature } from '../seq/translate';
import { parseFasta } from '../io/fasta';
import { parseGenbank } from '../io/genbank';
import { digest } from '../enzymes/digest';
import { getEnzyme } from '../enzymes/enzyme';
import { deleteRange, insertBases, replaceRange } from './edit';
import { remapGap, remapRange } from './remap';
import { concatRecords, extractRange, reverseComplementRecord, rotateOrigin, setTopology } from './transform';
import { recordProblems } from './test-helpers';

const rec = (seq: string, extra: Partial<SeqRecord> = {}): SeqRecord => ({
  id: 'd',
  name: 'n',
  description: '',
  seq,
  topology: 'linear',
  molecule: 'DNA',
  features: [],
  primers: [],
  meta: {},
  ...extra,
});

const fixture = (name: string): string => readFileSync(new URL(`../../test/fixtures/genbank/${name}`, import.meta.url), 'utf8');

describe('finding: reverseComplementRecord writes T into RNA records', () => {
  it('RNA reverse complement keeps U and is an involution', () => {
    const rna = rec('AUGCAAUUGN', { molecule: 'RNA' });
    const rc = reverseComplementRecord(rna);
    expect(rc.seq).toBe('NCAAUUGCAU'); // Biopython 1.88 RNA SeqRecord.reverse_complement()
    expect(reverseComplementRecord(rc).seq).toBe(rna.seq);
  });
});

describe('finding: reverse complement of an RNA record read from FASTA', () => {
  it('stays RNA', () => {
    const rna = parseFasta('>sgRNA\nGUUUUAGAGCUA\n').records[0]; // molecule 'RNA', seq with U
    expect(rna.molecule).toBe('RNA');
    const rc = reverseComplementRecord(rna);
    expect(rc.seq).toBe('UAGCUCUAAAAC'); // Biopython 1.88
    expect(reverseComplementRecord(rc).seq).toBe(rna.seq);
  });
});

describe('finding: inserting or replacing with an RNA record leaves U in a DNA record', () => {
  it('RNA record inserted into DNA must not leave U', () => {
    const out = insertBases(rec('AAAACCCC'), 4, rec('GGUU', { molecule: 'RNA' }));
    expect(out.molecule).toBe('DNA');
    expect(isDna(out.seq)).toBe(true); // types.ts: U -> T for DNA records
    expect(out.seq).toBe('AAAAGGTTCCCC');
  });

  it('RNA record replacing bases of a DNA record must not leave U', () => {
    const out = replaceRange(rec('AAAACCCC'), { start: 2, end: 4 }, rec('GGUU', { molecule: 'RNA' }));
    expect(out.seq).toBe('AAGGTTCCCC');
    expect(recordProblems(out)).toEqual([]);
  });
});

describe('finding: origin-spanning feature in two-segment join form misses bases edited at the origin', () => {
  const cds: Feature = { id: 'cds', type: 'CDS', name: 'cds', strand: 1, qualifiers: [], segments: [{ start: 18, end: 23 }] };
  const plasmid = rec('AAAAACCCCCGGGGGTTTTT', { topology: 'circular', features: [cds] }); // TT|AAA across the origin
  const roundTrip = setTopology(setTopology(plasmid, 'linear'), 'circular'); // segments now [18,20)+[0,3)

  it('the topology round trip gives the join form with the same feature sequence', () => {
    expect(roundTrip.features[0].segments).toEqual([
      { start: 18, end: 20 },
      { start: 0, end: 3 },
    ]);
    expect(featureSequence(roundTrip.features[0], roundTrip.seq)).toBe('TTAAA');
  });

  it('insertion at the origin extends the feature in both representations', () => {
    const direct = insertBases(plasmid, 0, 'G');
    expect(featureSequence(direct.features[0], direct.seq)).toBe('TTGAAA');
    const viaRoundTrip = insertBases(roundTrip, 0, 'G');
    expect(featureSequence(viaRoundTrip.features[0], viaRoundTrip.seq)).toBe('TTGAAA');
  });

  it('a replacement strictly inside the feature, across the origin, stays covered', () => {
    const direct = replaceRange(plasmid, { start: 19, end: 21 }, 'CC');
    expect(featureSequence(direct.features[0], direct.seq)).toBe('TCCAA');
    const viaRoundTrip = replaceRange(roundTrip, { start: 19, end: 21 }, 'CC');
    expect(featureSequence(viaRoundTrip.features[0], viaRoundTrip.seq)).toBe('TCCAA');
  });

  it('re-closing a plasmid with concatRecords has the same effect', () => {
    const out = insertBases(concatRecords([plasmid], { topology: 'circular' }), 0, 'G');
    expect(featureSequence(out.features[0], out.seq)).toBe('TTGAAA');
  });
});

describe("finding: extractRange keeps /codon_start when it clips the 5' end of a CDS", () => {
  it("keeps a valid frame for a 5'-clipped CDS (pBR322 tet)", () => {
    const pbr = parseGenbank(fixture('pBR322_J01749.gb')).records[0];
    const tet = pbr.features.find((f) => f.type === 'CDS' && f.name === 'tet') as Feature; // [85,1276) strand 1, /codon_start=1
    const full = translateFeature(pbr, tet); // MKSNNALIVILGTVTLDAVG...
    const piece = extractRange(pbr, { start: tet.segments[0].start + 1, end: 1300 }); // clip 1 base off the 5' end
    const clipped = piece.features.find((f) => f.id === tet.id) as Feature;
    expect(clipped.partialStart).toBe(true);
    expect(translateFeature(piece, clipped)).toBe(full.slice(1));
    expect(getQualifier(clipped.qualifiers, 'codon_start')).toBe('3');
  });
});

describe('finding: /transl_except positions are never remapped', () => {
  const cds: Feature = {
    id: 'cds',
    type: 'CDS',
    name: 'selP',
    strand: 1,
    segments: [{ start: 3, end: 15 }],
    qualifiers: [{ key: 'transl_except', value: '(pos:7..9,aa:Sec)' }],
  }; // TGA at 7..9 = Sec
  const lin = rec('CCCATGTGAAAATAA', { features: [cds] });

  it('insertBases upstream keeps /transl_except on the Sec codon', () => {
    expect(translateFeature(lin, cds)).toBe('MUK*');
    const out = insertBases(lin, 0, 'GGG');
    expect(translateFeature(out, out.features[0])).toBe('MUK*');
  });

  it('extractRange of exactly the CDS keeps it translatable', () => {
    const out = extractRange(lin, { start: 3, end: 15 });
    expect(translateFeature(out, out.features[0])).toBe('MUK*');
  });

  it('rotateOrigin and concatRecords keep the Sec codon', () => {
    const circ = rec(lin.seq, { topology: 'circular', features: [cds] });
    const rotated = rotateOrigin(circ, 12);
    expect(translateFeature(rotated, rotated.features[0])).toBe('MUK*');
    const joined = concatRecords([rec('GGG'), lin]);
    expect(translateFeature(joined, joined.features[0])).toBe('MUK*');
  });
});

describe('finding: the empty range {L, L} on a circular record is rejected', () => {
  const circ: SeqRecord = rec('AAAAACCCCCGGGGGTTTTT', { topology: 'circular' });

  it('empty range at gap L behaves like gap L', () => {
    expect(remapGap(20, { kind: 'insert', gap: 3, length: 2 }, 20, 'circular')).toBe(0); // gap L accepted
    expect(replaceRange(circ, { start: 20, end: 20 }, 'GG')).toEqual(insertBases(circ, 20, 'GG'));
  });

  it('remapRange of the empty selection at gap L', () => {
    expect(remapRange({ start: 20, end: 20 }, { kind: 'insert', gap: 3, length: 2 }, 20, 'circular')).toEqual({ start: 0, end: 0 });
  });
});

describe('finding: extractRange cannot take the parentRange of a plasmid cut once', () => {
  // Rejected (see the extractRange TSDoc): a range longer than the circle is not a normalized
  // range (types.ts: end - start <= length) and repeats the overhang bases, so which copy should
  // carry the features crossing the cut would be a guess. The test pins the documented contract
  // (an explicit RangeError) and the documented way to build that fragment.
  it('fragment record of a singly cut plasmid', () => {
    const puc = parseGenbank(fixture('pUC19_M77789.gb')).records[0];
    const L = puc.seq.length;
    const [frag] = digest(puc.seq, puc.topology, [getEnzyme('EcoRI')!]);
    expect(frag.parentRange).toEqual({ start: 284, end: 2974 }); // 2690 = L + 4 overhang bases
    expect(() => extractRange(puc, frag.parentRange)).toThrow(RangeError);
    expect(() => extractRange(puc, frag.parentRange)).toThrow(/more than the whole circle/);
    // the whole circle opened at the cut, plus the repeated overhang bases
    const opened = extractRange(puc, { start: 284, end: 284 + L });
    const overhang = puc.seq.slice(284, 288);
    expect(insertBases(opened, L, overhang).seq).toBe(frag.seq);
  });
});

describe('finding: a gap of -0 produces -0 coordinates', () => {
  it('gap -0', () => {
    const lin = rec('ACGTACGT', {
      features: [{ id: 's', type: 'misc_feature', name: 's', strand: 0, segments: [{ start: 0, end: 0 }], qualifiers: [] }],
    });
    const out = insertBases(lin, Math.round(-0.3), 'GG');
    expect(recordProblems(out)).toEqual([]);
    expect(out.features[0].segments[0].start.toLocaleString('en-US')).toBe('0');
  });
});
