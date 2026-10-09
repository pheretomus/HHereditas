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
import { parseGenbank, writeGenbank } from '../io/genbank';
import { digest } from '../enzymes/digest';
import { getEnzyme } from '../enzymes/enzyme';
import { deleteRange, insertBases, replaceRange } from './edit';
import { remapFeatures, remapGap, remapRange } from './remap';
import { concatRecords, extractRange, reverseComplementRecord, rotateOrigin, setTopology } from './transform';
import { addFeature, updateFeature } from './crud';
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

describe('finding: the property suite was red (its models predated the contiguous-run and /codon_start rules)', () => {
  // The property tests now use a run-aware token model and a qualifier model (test-helpers.ts) and
  // run all of their cases; these are the reviewers' failing cases, pinned with worked-out values.
  it('an insertion at the origin grows the segment ending at L of a join crossing the origin (seed 1001 #1953)', () => {
    const L = 234;
    const seq = 'ACGT'.repeat(59).slice(0, L);
    const f: Feature = { id: 'f0', type: 'misc_feature', name: 'f0', strand: 1, qualifiers: [], segments: [{ start: 107, end: 111 }, { start: 233, end: 234 }, { start: 0, end: 192 }] };
    const out = insertBases(rec(seq, { topology: 'circular', features: [f] }), 0, 'GGGGGGGGGGGG');
    // [233, 234) + [0, 192) is one contiguous stretch: the 12 bases appended at L are strictly inside it
    expect(out.features[0].segments).toEqual([
      { start: 107, end: 111 },
      { start: 233, end: 246 },
      { start: 0, end: 192 },
    ]);
    expect(featureSequence(out.features[0], out.seq)).toBe(seq.slice(107, 111) + seq[233] + 'GGGGGGGGGGGG' + seq.slice(0, 192));
  });

  it('a deletion removing 32 bases from the 5\' end of a strand -1 CDS sets /codon_start=2 (seed 2001 #2)', () => {
    const seq = 'ACGT'.repeat(36); // 144 bp
    const cds: Feature = { id: 'c', type: 'CDS', name: 'c', strand: -1, qualifiers: [], segments: [{ start: 83, end: 177 }] }; // 83..143, 0..32
    const out = deleteRange(rec(seq, { topology: 'circular', features: [cds] }), { start: 1, end: 123 });
    // survivors 123..143 -> 1..21 and 0 -> 0; the 5' end (right end) lost bases 32..1: 32 = 2 (mod 3)
    expect(out.features[0].segments).toEqual([{ start: 1, end: 23 }]);
    expect(out.features[0].qualifiers).toEqual([{ key: 'codon_start', value: '2' }]);
  });

  it('adjacent segments absorb an insertion at their junction; remapRange keeps the single-segment rule', () => {
    const f: Feature = { id: 'f', type: 'misc_feature', name: 'f', strand: 1, qualifiers: [], segments: [{ start: 0, end: 2 }, { start: 1, end: 2 }, { start: 2, end: 3 }] };
    const out = insertBases(rec('ACG', { features: [f] }), 2, 'T');
    expect(out.features[0].segments).toEqual([
      { start: 0, end: 2 },
      { start: 1, end: 3 },
      { start: 3, end: 4 },
    ]);
    expect(remapRange({ start: 1, end: 2 }, { kind: 'insert', gap: 2, length: 1 }, 3, 'linear')).toEqual({ start: 1, end: 2 });
    expect(remapFeatures([f], { kind: 'insert', gap: 2, length: 1 }, 3, 'linear')).toEqual(out.features);
  });
});

describe('finding: edits and extractRange leave a stale /translation on a changed CDS', () => {
  // pBR322 and its tet CDS (86..1276), parsed on first use
  let parsed: { pbr: SeqRecord; tet: Feature; s: number; protein: string } | undefined;
  const fixturePbr = () => {
    if (parsed === undefined) {
      const pbr = parseGenbank(fixture('pBR322_J01749.gb')).records[0];
      const tet = pbr.features.find((f) => f.type === 'CDS' && f.name === 'tet') as Feature;
      parsed = { pbr, tet, s: tet.segments[0].start, protein: getQualifier(tet.qualifiers, 'translation') as string };
    }
    return parsed;
  };
  const tetOf = (r: SeqRecord) => r.features.find((f) => f.id === fixturePbr().tet.id) as Feature;
  const stored = (r: SeqRecord) => getQualifier(tetOf(r).qualifiers, 'translation');
  const exported = (r: SeqRecord) => writeGenbank(r).replace(/\s+/g, '');

  it('the fixture stores the translation of tet', () => {
    const { pbr, tet, protein } = fixturePbr();
    expect(protein.startsWith('MKSNNALIVILGTVTLDAVG')).toBe(true);
    expect(translateFeature(pbr, tet).replace(/\*$/, '')).toBe(protein);
  });

  it('a point mutation, a codon deletion or an insertion inside the CDS drops /translation', () => {
    const { pbr, s, protein } = fixturePbr();
    const mutated = replaceRange(pbr, { start: s + 30, end: s + 33 }, 'TGG'); // L11W
    expect(translateFeature(mutated, tetOf(mutated)).slice(0, 12)).toBe('MKSNNALIVIWG');
    const deleted = deleteRange(pbr, { start: s + 30, end: s + 33 });
    const inserted = insertBases(pbr, s + 30, 'TGG');
    for (const out of [mutated, deleted, inserted]) {
      expect(stored(out)).toBeUndefined();
      expect(exported(out)).not.toContain(`/translation="${protein.slice(0, 40)}`);
      expect(getQualifier(tetOf(out).qualifiers, 'product')).toBe('tetracycline resistance protein');
    }
  });

  it("extractRange clipping the 5' end drops it; extracting the whole CDS keeps it", () => {
    const { pbr, tet, s, protein } = fixturePbr();
    const piece = extractRange(pbr, { start: s + 300, end: 1300 });
    expect(stored(piece)).toBeUndefined();
    const whole = extractRange(pbr, { start: s - 10, end: tet.segments[0].end + 10 });
    expect(stored(whole)).toBe(protein);
    expect(translateFeature(whole, tetOf(whole)).replace(/\*$/, '')).toBe(protein);
  });

  it('operations that only move the bases keep it', () => {
    const { pbr, s, protein } = fixturePbr();
    const moved = [
      insertBases(pbr, s - 5, 'GGATCC'), // upstream of the CDS
      deleteRange(pbr, { start: 3000, end: 3100 }), // elsewhere
      rotateOrigin(pbr, 2000),
      reverseComplementRecord(pbr),
      setTopology(pbr, 'linear'),
      concatRecords([extractRange(pbr, { start: 0, end: 2000 }), extractRange(pbr, { start: 2000, end: pbr.seq.length })], { topology: 'circular' }),
    ];
    for (const out of moved) {
      const f = out.features.find((g) => g.type === 'CDS' && g.name === 'tet') as Feature;
      expect(getQualifier(f.qualifiers, 'translation')).toBe(protein);
      expect(translateFeature(out, f).replace(/\*$/, '')).toBe(protein);
    }
  });

  it('a feature clamped when a circle closes over a too-long part drops it', () => {
    const cds: Feature = { id: 'c', type: 'CDS', name: 'c', strand: 1, segments: [{ start: 0, end: 10 }], qualifiers: [{ key: 'translation', value: 'MXX' }] };
    const part = rec('AATTCGGGGG', { features: [cds], ends: { left: { kind: '5prime', length: 4 }, right: { kind: '5prime', length: 4 } } });
    const closable = { ...part, seq: 'AATTCGAATT' };
    const circ = concatRecords([closable], { topology: 'circular' }); // 6 bp circle, the 10 bp CDS is clamped
    expect(circ.seq.length).toBe(6);
    expect(getQualifier(circ.features[0].qualifiers, 'translation')).toBeUndefined();
  });
});

describe('finding: the contiguous-run rule contradicts the documented insertion rule and the remapRange preview', () => {
  // Rule chosen: adjacent segments of one feature form one contiguous stretch (documented in the
  // TSDoc of insertBases / replaceRange / remapRange and in remap.ts). remapFeatures is the preview
  // that gives exactly the committed edit; remapRange remaps a single range (a selection).
  it('remapFeatures previews an origin-crossing join exactly like insertBases moves it', () => {
    const f: Feature = { id: 'f', type: 'CDS', name: 'f', strand: 1, qualifiers: [], segments: [{ start: 18, end: 20 }, { start: 0, end: 3 }] };
    const circ = rec('AAAAACCCCCGGGGGTTTTT', { topology: 'circular', features: [f] });
    const out = insertBases(circ, 0, 'G');
    expect(out.features[0].segments).toEqual([
      { start: 18, end: 21 },
      { start: 0, end: 3 },
    ]);
    expect(featureSequence(out.features[0], out.seq)).toBe('TTGAAA');
    expect(remapFeatures(circ.features, { kind: 'insert', gap: 0, length: 1 }, 20, 'circular')).toEqual(out.features);
    // a selection equal to one half is a single range: it touches the gap and is not extended
    expect(remapRange({ start: 18, end: 20 }, { kind: 'insert', gap: 0, length: 1 }, 20, 'circular')).toEqual({ start: 18, end: 20 });
  });

  it('a linear 2-segment join touching the gap absorbs the insertion into the segment before it', () => {
    const f: Feature = { id: 'j', type: 'misc_feature', name: 'j', strand: 1, qualifiers: [], segments: [{ start: 0, end: 5 }, { start: 5, end: 10 }] };
    const lin = rec('AAAAACCCCCGGGGG', { features: [f] });
    const out = insertBases(lin, 5, 'TT');
    expect(out.features[0].segments).toEqual([
      { start: 0, end: 7 },
      { start: 7, end: 12 },
    ]);
    expect(featureSequence(out.features[0], out.seq)).toBe('AAAAATTCCCCC'); // same as the single segment [0, 10)
    const single = insertBases(rec('AAAAACCCCCGGGGG', { features: [{ ...f, segments: [{ start: 0, end: 10 }] }] }), 5, 'TT');
    expect(featureSequence(single.features[0], single.seq)).toBe('AAAAATTCCCCC');
    // segments that are not adjacent keep the per-segment rule
    const intron = insertBases(rec('AAAAACCCCCGGGGG', { features: [{ ...f, segments: [{ start: 0, end: 5 }, { start: 6, end: 10 }] }] }), 5, 'TT');
    expect(intron.features[0].segments).toEqual([
      { start: 0, end: 5 },
      { start: 8, end: 12 },
    ]);
  });
});

describe('finding: rotateOrigin(k) then rotateOrigin(L-k) is not the identity with position-bearing qualifiers', () => {
  const circ = (seq: string, features: Feature[]): SeqRecord => rec(seq, { topology: 'circular', features });
  const r = circ('ATGAAATGAGGGCCCTTTAAACCCGGGTTTAAA', [
    { id: 'cds', type: 'CDS', name: 'cds', strand: 1, segments: [{ start: 0, end: 12 }], qualifiers: [{ key: 'transl_except', value: '(pos:7..9,aa:Sec)' }] },
    { id: 'rep', type: 'repeat_region', name: 'rep', strand: 0, segments: [{ start: 12, end: 30 }], qualifiers: [{ key: 'rpt_unit_range', value: '13..18' }] },
  ]);
  const L = r.seq.length;

  it('k = 7 then L - 7 keeps /transl_except (split at the origin, then merged back)', () => {
    const mid = rotateOrigin(r, 7);
    expect(mid.features[0].qualifiers).toEqual([{ key: 'transl_except', value: '(pos:join(33,1..2),aa:Sec)' }]);
    expect(translateFeature(mid, mid.features[0])).toBe(translateFeature(r, r.features[0]));
    expect(rotateOrigin(mid, L - 7)).toEqual(r);
  });

  it('k = 14 then L - 14 keeps /rpt_unit_range (written as a join while it crosses the origin)', () => {
    const mid = rotateOrigin(r, 14);
    expect(mid.features[1].qualifiers).toEqual([{ key: 'rpt_unit_range', value: 'join(32..33,1..4)' }]);
    expect(rotateOrigin(mid, L - 14)).toEqual(r);
    for (let k = 0; k <= L; k++) expect(rotateOrigin(rotateOrigin(r, k), L - k)).toEqual(r);
  });

  it('reverse complement twice keeps a one-base /rpt_unit_range written as a range', () => {
    const one = circ(r.seq, [{ id: 'r', type: 'repeat_region', name: 'r', strand: 0, segments: [{ start: 10, end: 20 }], qualifiers: [{ key: 'rpt_unit_range', value: '12..12' }] }]);
    expect(reverseComplementRecord(one).features[0].qualifiers).toEqual([{ key: 'rpt_unit_range', value: '22..22' }]);
    expect(reverseComplementRecord(reverseComplementRecord(one))).toEqual(one);
  });
});

describe('finding: position-bearing qualifier locations are expanded base by base', () => {
  it('rotates a 10 kb plasmid whose CDS has a 36 KB /transl_except value quickly (was 10.8 s and 3 GB)', () => {
    const L = 10_000;
    const value = `(pos:join(${Array.from({ length: 4000 }, () => `1..${L}`).join(',')}),aa:Sec)`;
    const cds: Feature = { id: 'cds', type: 'CDS', name: 'cds', strand: 1, segments: [{ start: 0, end: 30 }], qualifiers: [{ key: 'transl_except', value }] };
    const plasmid = rec('ACGT'.repeat(L / 4), { topology: 'circular', features: [cds] });
    const t0 = performance.now();
    const out = rotateOrigin(plasmid, 17);
    const back = rotateOrigin(out, L - 17);
    reverseComplementRecord(plasmid);
    extractRange(plasmid, { start: 5, end: 9000 });
    insertBases(plasmid, 5000, 'ACGT');
    expect(performance.now() - t0).toBeLessThan(500);
    // every run is split at the new origin; the halves that meet at the old origin (the end of one
    // whole-circle run and the start of the next) are written as one run again: the same bases
    const middle = Array.from({ length: 3999 }, () => `1..${L}`).join(',');
    expect(out.features[0].qualifiers[0].value).toBe(`(pos:join(${L - 16}..${L},${middle},1..${L - 17}),aa:Sec)`);
    expect(back).toEqual(plasmid);
  });

  it('moves a genome-length /rpt_unit_range in constant time', () => {
    const G = 4_641_652; // E. coli K-12 MG1655 (U00096.3)
    const features: Feature[] = Array.from({ length: 10 }, (_, i) => ({
      id: `r${i}`,
      type: 'repeat_region',
      name: `r${i}`,
      strand: 0,
      segments: [{ start: 0, end: G }],
      qualifiers: [{ key: 'rpt_unit_range', value: `1..${G}` }],
    }));
    const genome = rec('ACGT'.repeat(G / 4), { topology: 'circular', features });
    const t0 = performance.now();
    const rotated = rotateOrigin(genome, 1_000_000);
    const opened = extractRange(genome, { start: 1_000_000, end: 1_000_000 + G });
    const back = rotateOrigin(rotated, G - 1_000_000);
    expect(performance.now() - t0).toBeLessThan(1000); // was about 0.9 s per qualifier and operation
    expect(rotated.features[0].qualifiers[0].value).toBe(`join(${G - 1_000_000 + 1}..${G},1..${G - 1_000_000})`);
    expect(opened.features[0].qualifiers[0].value).toBe(`join(${G - 1_000_000 + 1}..${G},1..${G - 1_000_000})`);
    expect(back.features[0].qualifiers[0].value).toBe(`1..${G}`);
  });
});

describe('finding: negative zero still leaks (remapGap, circular checkRange, CRUD strand)', () => {
  const circ = rec('ACGTACGTAC', { topology: 'circular' });
  const lin = rec('ACGTACGTAC');

  it('remapGap(-0) returns +0 on linear and circular molecules', () => {
    expect(Object.is(remapGap(Math.round(-0.3), { kind: 'delete', range: { start: 2, end: 4 } }, 10, 'linear'), -0)).toBe(false);
    expect(Object.is(remapGap(Math.round(-0.3), { kind: 'delete', range: { start: 2, end: 4 } }, 10, 'circular'), -0)).toBe(false);
  });

  it('addFeature on a circular record stores +0', () => {
    const out = addFeature(circ, { id: 's', type: 'misc_feature', name: 's', strand: 0, segments: [{ start: 0, end: -0 }], qualifiers: [] });
    expect(Object.is(out.features[0].segments[0].end, -0)).toBe(false);
    expect(Object.is(remapRange({ start: -0, end: -0 }, { kind: 'insert', gap: 5, length: 1 }, 10, 'circular')?.end, -0)).toBe(false);
  });

  it('CRUD stores strand -0 as 0', () => {
    const a = addFeature(lin, { id: 'f', type: 'misc_feature', name: 'f', strand: -0 as 0, segments: [{ start: 1, end: 4 }], qualifiers: [] });
    const b = updateFeature(a, 'f', { strand: -0 as 0 });
    expect(recordProblems(a)).toEqual([]);
    expect(recordProblems(b)).toEqual([]);
    expect(Object.is(b.features[0].strand, 0)).toBe(true);
  });
});

describe('finding: remapGap ignores bias right at the left boundary of a replaced region', () => {
  it('a caret at either end of a replaced selection, bias right, lands after the typed bases', () => {
    const edit = { kind: 'replace', range: { start: 2, end: 5 }, length: 3 } as const;
    expect(remapGap(3, edit, 10, 'linear', 'right')).toBe(5); // inside
    expect(remapGap(2, edit, 10, 'linear', 'right')).toBe(5); // left boundary
    expect(remapGap(5, edit, 10, 'linear', 'right')).toBe(5); // right boundary
    // bias left (zero-length features): left boundary before, right boundary after the new bases
    expect(remapGap(2, edit, 10, 'linear', 'left')).toBe(2);
    expect(remapGap(5, edit, 10, 'linear', 'left')).toBe(5);
    // circular, replaced region crossing the origin: the new bases start the sequence
    expect(remapGap(8, { kind: 'replace', range: { start: 8, end: 12 }, length: 3 }, 10, 'circular', 'right')).toBe(3);
  });

  it('typing "ABC" over a backward selection keeps the letters in order', () => {
    let r = rec('AAAAACCCCC');
    let caret = 2; // selection [2, 5) made right to left
    let selection = { start: 2, end: 5 };
    for (const ch of ['G', 'T', 'A']) {
      const edit = { kind: 'replace', range: selection, length: 1 } as const;
      caret = remapGap(caret, edit, r.seq.length, r.topology, 'right');
      r = replaceRange(r, selection, ch);
      selection = { start: caret, end: caret };
    }
    expect(r.seq).toBe('AAGTACCCCC');
  });
});
