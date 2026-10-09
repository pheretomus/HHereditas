import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Primer } from '../types';
import { reverseComplement } from '../seq/alphabet';
import { featureSequence, makeFeature, makeRecord } from '../seq/features';
import { parseGenbank } from '../io/genbank';
import { pcr } from './pcr';
import { randomDna, rng } from './test-helpers';

const FIX = join(__dirname, '../../test/fixtures/genbank');
const PUC19 = parseGenbank(readFileSync(join(FIX, 'pUC19_M77789.gb'), 'utf8')).records[0];
const L_PUC = PUC19.seq.length;
const primer = (name: string, sequence: string): Primer => ({ id: name, name, sequence });

describe('pcr', () => {
  const rand = rng(7);
  const tpl = randomDna(rand, 1000);
  const template = makeRecord({
    name: 'tpl',
    seq: tpl,
    features: [
      makeFeature({ type: 'CDS', name: 'inside', strand: 1, segments: [{ start: 300, end: 450 }] }),
      makeFeature({ type: 'gene', name: 'clipped', strand: -1, segments: [{ start: 150, end: 250 }] }),
      makeFeature({ type: 'gene', name: 'outside', strand: 1, segments: [{ start: 900, end: 950 }] }),
    ],
  });

  it('builds tail + template + rc(reverse tail) on a linear template', () => {
    const f = primer('F', 'GGGAATTC' + tpl.slice(200, 222));
    const r = primer('R', 'CCGGATCC' + reverseComplement(tpl.slice(580, 600)));
    const res = pcr(template, f, r);
    expect(res.error).toBeUndefined();
    expect(res.products).toHaveLength(1);
    const p = res.product!;
    expect(p.seq).toBe('GGGAATTC' + tpl.slice(200, 600) + reverseComplement('CCGGATCC'));
    expect(p.seq.length).toBe(8 + 400 + 8);
    expect(p.topology).toBe('linear');
    expect(p.ends).toBeUndefined();
    expect(p.name).toBe('tpl PCR');
    expect(res.amplicons[0].templateRange).toEqual({ start: 200, end: 600 });
    // features: inside kept whole, clipped is partial, outside dropped, two primer_bind
    const inside = p.features.find((x) => x.name === 'inside')!;
    expect(featureSequence(inside, p.seq)).toBe(tpl.slice(300, 450));
    expect(inside.segments).toEqual([{ start: 108, end: 258 }]);
    const clipped = p.features.find((x) => x.name === 'clipped')!;
    expect(clipped.segments).toEqual([{ start: 8, end: 58 }]);
    expect(clipped.partialStart).toBe(true);
    expect(p.features.find((x) => x.name === 'outside')).toBeUndefined();
    const binds = p.features.filter((x) => x.type === 'primer_bind');
    expect(binds.map((b) => [b.name, b.strand, b.segments[0]])).toEqual([
      ['F', 1, { start: 0, end: 30 }],
      ['R', -1, { start: 416 - 28, end: 416 }],
    ]);
    expect(p.primers.map((x) => x.name)).toEqual(['F', 'R']);
  });

  it('amplifies across the origin of a circular template', () => {
    const L = PUC19.seq.length;
    const f = primer('F', 'AAAA' + PUC19.seq.slice(L - 100, L - 80));
    const r = primer('R', reverseComplement(PUC19.seq.slice(50, 70)));
    const res = pcr(PUC19, f, r);
    expect(res.error).toBeUndefined();
    expect(res.product!.seq).toBe('AAAA' + PUC19.seq.slice(L - 100) + PUC19.seq.slice(0, 70));
    expect(res.amplicons[0].templateRange).toEqual({ start: L - 100, end: L + 70 });
  });

  it('handles a forward primer whose annealing part itself spans the origin (regression found by the pydna oracle)', () => {
    const f = primer('F', 'TTT' + PUC19.seq.slice(L_PUC - 10) + PUC19.seq.slice(0, 12));
    const r = primer('R', reverseComplement(PUC19.seq.slice(300, 320)));
    const res = pcr(PUC19, f, r);
    expect(res.product!.seq).toBe('TTT' + PUC19.seq.slice(L_PUC - 10) + PUC19.seq.slice(0, 320));
    const inner = res.product!.features.filter((x) => x.type !== 'primer_bind');
    for (const x of inner) for (const s of x.segments) expect(s.end).toBeLessThanOrEqual(res.product!.seq.length);
  });

  it('a linear template cannot be amplified across its ends: wrong orientation error', () => {
    const f = primer('F', tpl.slice(800, 820));
    const r = primer('R', reverseComplement(tpl.slice(100, 120)));
    const res = pcr(template, f, r);
    expect(res.product).toBeUndefined();
    expect(res.error).toMatch(/no forward site faces a reverse site/);
    // the same pair on the circular molecule works
    const circ = pcr({ ...template, topology: 'circular' }, f, r);
    expect(circ.product!.seq).toBe(tpl.slice(800) + tpl.slice(0, 120));
  });

  it('reports a primer that does not bind', () => {
    const res = pcr(template, primer('F', tpl.slice(10, 30)), primer('R', 'ACGTACGTACGTACGTACGTAC'));
    expect(res.error).toMatch(/Reverse primer 'R' does not bind/);
    expect(pcr(template, primer('F', 'ACGTACGTACGTACGTACGTAC'), primer('R', 'ACGTACGTACGTACGTACGTAC')).error).toMatch(/Neither/);
  });

  it('swapped primers still amplify, with a warning', () => {
    const f = primer('F', tpl.slice(100, 122));
    const r = primer('R', reverseComplement(tpl.slice(500, 522)));
    const res = pcr(template, r, f);
    expect(res.product!.seq).toBe(tpl.slice(100, 522));
    expect(res.warnings.join(' ')).toMatch(/swapped/);
  });

  it('returns every product sorted by size when a primer binds twice', () => {
    const site = 'ACGATCGGATCGTTAGCGCA';
    const seq = randomDna(rand, 100) + site + randomDna(rand, 200) + site + randomDna(rand, 300) + 'TTGCAGCCATGGACCAGTCA' + randomDna(rand, 50);
    const rec = makeRecord({ seq });
    const res = pcr(rec, primer('F', site), primer('R', reverseComplement('TTGCAGCCATGGACCAGTCA')));
    expect(res.products.map((p) => p.seq.length)).toEqual([340, 560]);
    expect(res.products[0].name).toMatch(/\(340 bp\)/);
    expect(res.warnings.join(' ')).toMatch(/2 possible products/);
  });

  it('copies the primer base at a mismatch when mismatches are allowed', () => {
    const anneal = tpl.slice(200, 225);
    const mutated = anneal.slice(0, 5) + (anneal[5] === 'A' ? 'C' : 'A') + anneal.slice(6);
    const r = primer('R', reverseComplement(tpl.slice(400, 420)));
    const strict = pcr(template, primer('F', mutated), r);
    expect(strict.amplicons[0].forwardSite.tailLength).toBe(6); // the 5' part beyond the mismatch counts as tail
    expect(strict.product!.seq).toBe(mutated + tpl.slice(225, 420));
    const res = pcr(template, primer('F', mutated), r, { maxMismatches: 1 });
    expect(res.product!.seq).toBe(mutated + tpl.slice(225, 420));
    expect(res.warnings.join(' ')).toMatch(/mismatch/);
  });

  it('handles overlapping annealing regions (product shorter than the two primers)', () => {
    const f = primer('F', 'GG' + tpl.slice(300, 325));
    const r = primer('R', 'CC' + reverseComplement(tpl.slice(310, 335)));
    const res = pcr(template, f, r);
    expect(res.product!.seq).toBe('GG' + tpl.slice(300, 335) + 'GG');
  });

  it('reports invalid primers and empty templates instead of throwing', () => {
    expect(pcr(template, primer('F', 'ACGT!ACGT'), primer('R', 'ACGT')).error).toMatch(/Cannot search/);
    expect(pcr(makeRecord({ seq: '' }), primer('F', 'ACGT'), primer('R', 'ACGT')).error).toMatch(/empty/);
  });

  it('honours options.name and does not mutate inputs', () => {
    const snap = JSON.stringify(template);
    const res = pcr(template, primer('F', tpl.slice(200, 222)), primer('R', reverseComplement(tpl.slice(580, 600))), { name: 'amp' });
    expect(res.product!.name).toBe('amp');
    expect(JSON.stringify(template)).toBe(snap);
  });
});
