import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SeqRecord } from '../types';
import { getEnzyme } from '../enzymes/enzyme';
import type { RestrictionEnzyme } from '../enzymes/enzyme';
import { findSitesForEnzyme } from '../enzymes/search';
import { parseGenbank } from '../io/genbank';
import { makeFeature, makeRecord, featureSequence } from '../seq/features';
import { sliceRange } from '../seq/range';
import { digestRecord } from './digest-record';
import { endsCompatible, ligate } from './ligation';
import { canonicalCircular } from './test-helpers';

const FIX = join(__dirname, '../../test/fixtures/genbank');
const PUC19 = parseGenbank(readFileSync(join(FIX, 'pUC19_M77789.gb'), 'utf8')).records[0];
const enz = (n: string): RestrictionEnzyme => getEnzyme(n)!;
const cutTop = (rec: SeqRecord, e: string): number => findSitesForEnzyme(rec.seq, rec.topology, enz(e))[0].cuts[0].top;

describe('digestRecord', () => {
  it('linearizes pUC19 with EcoRI: full extent 2690, 5\' AATT ends, parentRange longer than the circle', () => {
    const [f] = digestRecord(PUC19, [enz('EcoRI')]);
    const top = cutTop(PUC19, 'EcoRI');
    expect(f.seq.length).toBe(2690);
    expect(f.ends).toEqual({ left: { kind: '5prime', length: 4 }, right: { kind: '5prime', length: 4 } });
    expect(f.seq.startsWith('AATTC')).toBe(true);
    expect(f.seq.endsWith('GAATT')).toBe(true);
    expect(f.parentRange).toEqual({ start: top, end: top + 2690 });
    expect(sliceRange(PUC19.seq, f.parentRange)).toBe(f.seq);
    expect(f.leftCut?.enzyme).toBe('EcoRI');
    expect(f.rightCut?.enzyme).toBe('EcoRI');
    expect(f.topology).toBe('linear');
    // feature ids are unique, segments valid
    expect(new Set(f.features.map((x) => x.id)).size).toBe(f.features.length);
    for (const x of f.features) for (const s of x.segments) expect(s.end).toBeLessThanOrEqual(2690);
  });

  it('splits a feature crossing the single cut into two partial pieces and keeps contained features whole', () => {
    const seq = 'A'.repeat(100) + 'GAATTC' + 'C'.repeat(94); // EcoRI top cut at 101
    const rec = makeRecord({
      seq,
      topology: 'circular',
      features: [
        makeFeature({ type: 'misc_feature', name: 'across', strand: 1, segments: [{ start: 90, end: 120 }] }),
        makeFeature({ type: 'misc_feature', name: 'inside', strand: -1, segments: [{ start: 130, end: 150 }] }),
        makeFeature({ type: 'misc_feature', name: 'wraps', strand: 1, segments: [{ start: 190, end: 210 }] }),
      ],
    });
    const [f] = digestRecord(rec, [enz('EcoRI')]);
    expect(f.seq.length).toBe(204);
    const across = f.features.filter((x) => x.name === 'across');
    expect(across).toHaveLength(2);
    const right = across.find((x) => x.segments[0].start > 100)!;
    const left = across.find((x) => x.segments[0].start === 0)!;
    // left piece: parent 101..120 at fragment 0..19 (partial start); right piece: parent 90..105 at the end (overhang included)
    expect(left.segments).toEqual([{ start: 0, end: 19 }]);
    expect(left.partialStart).toBe(true);
    expect(right.segments).toEqual([{ start: 189, end: 204 }]);
    expect(right.partialEnd).toBe(true);
    const inside = f.features.filter((x) => x.name === 'inside');
    expect(inside).toHaveLength(1);
    expect(featureSequence(inside[0], f.seq)).toBe(featureSequence(rec.features[1], rec.seq));
    expect(inside[0].partialStart ?? false).toBe(false);
    const wraps = f.features.filter((x) => x.name === 'wraps');
    expect(wraps).toHaveLength(1);
    expect(featureSequence(wraps[0], f.seq)).toBe(featureSequence(rec.features[2], rec.seq));
  });

  it('cuts pUC19 with EcoRI + HindIII into the MCS stub and the backbone', () => {
    const frags = digestRecord(PUC19, [enz('EcoRI'), enz('HindIII')]);
    expect(frags).toHaveLength(2);
    const sizes = frags.map((f) => f.seq.length).sort((a, b) => a - b);
    expect(sizes[0] + sizes[1]).toBe(2686 + 8);
    for (const f of frags) expect(sliceRange(PUC19.seq, f.parentRange)).toBe(f.seq);
    expect(frags[1].name).toContain('EcoRI');
  });

  it('honours sticky input ends of a linear record and keeps them on the outer fragments', () => {
    const ends = { left: { kind: '5prime' as const, length: 4 }, right: { kind: '3prime' as const, length: 4 } };
    const rec = makeRecord({ seq: 'AATTC' + 'G'.repeat(40) + 'GGATCC' + 'T'.repeat(40) + 'TGCA', ends });
    const frags = digestRecord(rec, [enz('BamHI')]);
    expect(frags).toHaveLength(2);
    expect(frags[0].ends!.left).toEqual(ends.left);
    expect(frags[1].ends!.right).toEqual(ends.right);
    expect(frags[0].leftCut).toBeUndefined();
    expect(frags[0].rightCut?.enzyme).toBe('BamHI');
    // a site inside the single-stranded overhang is not cut
    const ov = makeRecord({ seq: 'TCGA' + 'A'.repeat(30), ends: { left: { kind: '5prime', length: 4 }, right: { kind: 'blunt', length: 0 } } });
    expect(digestRecord(ov, [enz('TaqI')])).toHaveLength(1);
  });

  it('returns a copy of the molecule when nothing cuts, and [] for an empty record', () => {
    const frags = digestRecord(PUC19, [enz('NotI')]);
    expect(frags).toHaveLength(1);
    expect(frags[0].topology).toBe('circular');
    expect(frags[0].seq).toBe(PUC19.seq);
    expect(frags[0].parentRange).toEqual({ start: 0, end: 2686 });
    expect(frags[0].id).not.toBe(PUC19.id);
    expect(digestRecord(makeRecord({ seq: '' }), [enz('EcoRI')])).toEqual([]);
  });

  it('does not mutate its input', () => {
    const snapshot = JSON.stringify(PUC19);
    digestRecord(PUC19, [enz('EcoRI'), enz('BamHI')]);
    expect(JSON.stringify(PUC19)).toBe(snapshot);
  });
});

describe('endsCompatible', () => {
  const frag = (seq: string, left: [string, number], right: [string, number]): SeqRecord =>
    makeRecord({
      seq,
      ends: { left: { kind: left[0] as 'blunt', length: left[1] }, right: { kind: right[0] as 'blunt', length: right[1] } },
    });
  it('accepts identical overhang text of the same kind and length', () => {
    const a = frag('CCCCGAATT'.replace('GAATT', 'G') + 'AATT', ['blunt', 0], ['5prime', 4]);
    const b = frag('AATTCGGGG', ['5prime', 4], ['blunt', 0]);
    expect(endsCompatible(a, b)).toBe(true);
  });
  it('rejects different text, kind or length; accepts blunt+blunt; rejects blunt+sticky and circles', () => {
    const eco = frag('CCCGAATT', ['blunt', 0], ['5prime', 4]);
    const bam = frag('GATCCGGG', ['5prime', 4], ['blunt', 0]);
    expect(endsCompatible(eco, bam)).toBe(false);
    const pst3 = frag('TGCAGGG', ['3prime', 4], ['blunt', 0]);
    const pstLike5 = frag('CCCTGCA', ['blunt', 0], ['5prime', 4]);
    expect(endsCompatible(pstLike5, pst3)).toBe(false);
    expect(endsCompatible(makeRecord({ seq: 'AAA' }), makeRecord({ seq: 'CCC' }))).toBe(true);
    expect(endsCompatible(makeRecord({ seq: 'AAA' }), bam)).toBe(false);
    expect(endsCompatible(makeRecord({ seq: 'AAA', topology: 'circular' }), makeRecord({ seq: 'CCC' }))).toBe(false);
  });
  it('BamHI and BglII ends are compatible (both GATC)', () => {
    const bam = digestRecord(makeRecord({ seq: 'A'.repeat(20) + 'GGATCC' + 'A'.repeat(20) }), [enz('BamHI')]);
    const bgl = digestRecord(makeRecord({ seq: 'C'.repeat(20) + 'AGATCT' + 'C'.repeat(20) }), [enz('BglII')]);
    expect(endsCompatible(bam[0], bgl[1])).toBe(true);
    expect(endsCompatible(bgl[0], bam[1])).toBe(true);
  });
});

describe('ligate', () => {
  it('recircularizes EcoRI-linearized pUC19 into pUC19 (overhang counted once)', () => {
    const [f] = digestRecord(PUC19, [enz('EcoRI')]);
    const res = ligate([f], { circularize: true });
    expect(res.error).toBeUndefined();
    expect(res.product!.seq.length).toBe(2686);
    expect(res.product!.topology).toBe('circular');
    expect(canonicalCircular(res.product!.seq)).toBe(canonicalCircular(PUC19.seq));
    expect(res.junctions).toEqual([{ leftPart: 0, rightPart: 0, range: { start: 0, end: 4 }, kind: '5prime', overhang: 'AATT' }]);
  });

  it('joins the fragments of a double digest back in parent order', () => {
    const frags = digestRecord(PUC19, [enz('EcoRI'), enz('HindIII')]);
    const res = ligate(frags, { circularize: true });
    expect(canonicalCircular(res.product!.seq)).toBe(canonicalCircular(PUC19.seq));
    expect(res.junctions).toHaveLength(2);
    const p = res.product!.seq;
    for (const j of res.junctions) expect(p.slice(j.range.start, j.range.end)).toBe(j.overhang);
  });

  it('a linear ligation keeps the outer ends', () => {
    const frags = digestRecord(makeRecord({ seq: 'TTTTGAATTCAAAAGGATCCGGGG' }), [enz('EcoRI'), enz('BamHI')]);
    const res = ligate(frags);
    expect(res.product!.seq).toBe('TTTTGAATTCAAAAGGATCCGGGG');
    expect(res.product!.ends).toBeUndefined();
    const res2 = ligate(frags.slice(1));
    expect(res2.product!.ends).toEqual({ left: { kind: '5prime', length: 4 }, right: { kind: 'blunt', length: 0 } });
  });

  it('reports incompatible ends with the junction instead of throwing', () => {
    const eco = digestRecord(makeRecord({ seq: 'TTTTGAATTCAAAA' }), [enz('EcoRI')]);
    const bam = digestRecord(makeRecord({ seq: 'TTTTGGATCCAAAA' }), [enz('BamHI')]);
    const res = ligate([eco[0], bam[1]]);
    expect(res.product).toBeUndefined();
    expect(res.products).toEqual([]);
    expect(res.error).toMatch(/fragment 1 and fragment 2/);
    expect(res.error).toMatch(/AATT/);
    expect(res.error).toMatch(/GATC/);
    expect(ligate([eco[1]], { circularize: true }).error).toMatch(/circularize/);
    expect(ligate([eco[0], eco[1]], { circularize: true }).product!.seq).toBe('TTTTGAATTCAAAA');
    expect(ligate([]).error).toBeDefined();
    expect(ligate([PUC19]).error).toMatch(/circular/);
  });

  it('is case-insensitive for overhang text', () => {
    const eco = digestRecord(makeRecord({ seq: 'TTTTGAATTCAAAA' }), [enz('EcoRI')]);
    const lower = { ...eco[1], seq: eco[1].seq.toLowerCase() };
    expect(endsCompatible(eco[0], lower)).toBe(true);
    expect(ligate([eco[0], lower]).product!.seq).toBe('TTTTGAATTCAAAA');
  });
});
