import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SeqRecord } from '../types';
import { reverseComplement } from '../seq/alphabet';
import { makeFeature, makeRecord } from '../seq/features';
import { parseGenbank } from '../io/genbank';
import { designGibsonPrimers, gibsonAssembly, terminalOverlap } from './gibson';
import { goldenGate } from './golden-gate';
import { pcr } from './pcr';
import { canonicalCircular, randomDna, rng } from './test-helpers';

const FIX = join(__dirname, '../../test/fixtures/genbank');
const PUC19 = parseGenbank(readFileSync(join(FIX, 'pUC19_M77789.gb'), 'utf8')).records[0];
const L = PUC19.seq.length;
const rec = (seq: string, name = 'f'): SeqRecord => makeRecord({ seq, name });

describe('terminalOverlap', () => {
  it('finds the longest suffix/prefix match, capped', () => {
    expect(terminalOverlap('AAACGTACGT', 'ACGTACGTTT')).toBe(8);
    expect(terminalOverlap('AAACGTACGT', 'ACGTACGTTT', 5)).toBe(4);
    expect(terminalOverlap('AAAA', 'CCCC')).toBe(0);
    expect(terminalOverlap('', 'CCCC')).toBe(0);
  });
});

describe('gibsonAssembly', () => {
  const rand = rng(21);
  const total = randomDna(rand, 1500);
  const ring = total + total;
  const frags = [ring.slice(0, 520), ring.slice(500, 1025), ring.slice(1000, 1530)].map((s, i) => rec(s, `f${i + 1}`));

  it('assembles 3 fragments with 20/25/30 bp overlaps into the circle', () => {
    const res = gibsonAssembly(frags);
    expect(res.error).toBeUndefined();
    expect(res.product!.seq).toBe(total); // starts with fragment 1
    expect(res.product!.topology).toBe('circular');
    expect(res.junctions.map((j) => [j.leftFragment, j.rightFragment, j.overlapLength])).toEqual([
      [0, 1, 20],
      [1, 2, 25],
      [2, 0, 30],
    ]);
    for (const j of res.junctions) {
      expect(res.product!.seq.slice(j.range.start, j.range.end)).toBe(j.overlapSeq);
      expect(j.tm).toBeGreaterThan(30);
      expect(j.gc).toBeGreaterThan(0);
    }
  });

  it('linear assembly keeps both outer ends', () => {
    const res = gibsonAssembly(frags.slice(0, 2), { circular: false });
    expect(res.product!.seq).toBe(ring.slice(0, 1025));
    expect(res.product!.topology).toBe('linear');
    expect(res.product!.ends).toBeUndefined();
    expect(res.junctions).toHaveLength(1);
  });

  it('names the junction without overlap, and the too-short one', () => {
    const res = gibsonAssembly([frags[0], frags[2], frags[1]]);
    expect(res.product).toBeUndefined();
    expect(res.error).toMatch(/fragment 1 \('f1'\) and fragment 2 \('f3'\)/);
    const short = gibsonAssembly([rec(ring.slice(0, 510)), rec(ring.slice(500, 1000))], { circular: false });
    expect(short.error).toMatch(/too short.*10 bp/);
    expect(gibsonAssembly([rec(ring.slice(0, 510)), rec(ring.slice(500, 1000))], { circular: false, minOverlap: 10 }).product).toBeDefined();
    expect(gibsonAssembly([]).error).toBeDefined();
    expect(gibsonAssembly([{ ...frags[0], topology: 'circular' }]).error).toMatch(/circular/);
  });

  it('respects maxOverlap and warns about low-Tm, repeated and alternative overlaps', () => {
    const atRich = 'ATATTATAATTATATTAATA';
    const a = rec(randomDna(rand, 200) + atRich);
    const b = rec(atRich + randomDna(rand, 200));
    const res = gibsonAssembly([a, b], { circular: false });
    expect(res.warnings.join(' ')).toMatch(/Tm/);
    // overlap repeated inside a fragment
    const ov = randomDna(rand, 20);
    const c = rec(randomDna(rand, 100) + ov + randomDna(rand, 100) + ov);
    const d = rec(ov + randomDna(rand, 200));
    expect(gibsonAssembly([c, d], { circular: false }).warnings.join(' ')).toMatch(/occurs 1 more time/);
    // the 3' end of fragment 3 also fits the 5' end of fragment 2
    const ov2 = randomDna(rand, 20);
    const e = rec(randomDna(rand, 200) + ov);
    const f = rec(ov + randomDna(rand, 200) + ov2);
    const g = rec(ov2 + randomDna(rand, 200) + ov);
    const alt = gibsonAssembly([e, f, g], { circular: false });
    expect(alt.product).toBeDefined();
    expect(alt.warnings.join(' ')).toMatch(/3' end of fragment 3 also overlaps the 5' end of fragment 2/);
    // maxOverlap caps the overlap used
    expect(gibsonAssembly([rec(ring.slice(0, 530)), rec(ring.slice(500, 900))], { circular: false, maxOverlap: 25 }).error).toMatch(/too short|No terminal/);
  });

  it('ignores sticky ends (with a warning) and carries features', () => {
    const f0 = { ...frags[0], ends: { left: { kind: '5prime' as const, length: 4 }, right: { kind: 'blunt' as const, length: 0 } } };
    const f1 = { ...frags[1], features: [makeFeature({ type: 'gene', name: 'g', strand: 1, segments: [{ start: 100, end: 200 }] })] };
    const res = gibsonAssembly([f0, f1, frags[2]]);
    expect(res.product!.seq).toBe(total);
    expect(res.warnings.join(' ')).toMatch(/ignored/);
    expect(res.product!.features.find((x) => x.name === 'g')!.segments).toEqual([{ start: 600, end: 700 }]);
  });
});

describe('designGibsonPrimers → pcr → gibsonAssembly (self-consistency)', () => {
  const rand = rng(31);
  const inserts = [350, 500, 420].map((n, i) => makeRecord({ name: `ins${i + 1}`, seq: randomDna(rand, n) }));
  const insertSeq = inserts.map((r) => r.seq).join('');

  const check = (insertion: { start: number; end: number }, amplifyVector: boolean, overlapLength = 20) => {
    const design = designGibsonPrimers({ vector: PUC19, insertion, inserts, amplifyVector, overlapLength });
    expect(design.error).toBeUndefined();
    const expected =
      insertion.end > L
        ? PUC19.seq.slice(insertion.end - L, insertion.start) + insertSeq
        : PUC19.seq.slice(0, insertion.start) + insertSeq + PUC19.seq.slice(insertion.end);
    expect(design.product!.seq).toBe(expected);
    // Independently: PCR every fragment with the designed primers and assemble the products.
    const templates = amplifyVector ? [PUC19, ...inserts] : inserts;
    const products: SeqRecord[] = amplifyVector ? [] : [design.fragments[0]];
    templates.forEach((t, i) => {
      const res = pcr(t, design.primers[2 * i], design.primers[2 * i + 1]);
      expect(res.products).toHaveLength(1);
      products.push(res.product!);
    });
    const asm = gibsonAssembly(products);
    expect(asm.error).toBeUndefined();
    expect(canonicalCircular(asm.product!.seq)).toBe(canonicalCircular(expected));
    for (const j of asm.junctions) expect(j.overlapLength).toBe(overlapLength);
    expect(design.primers).toHaveLength(2 * templates.length);
    return design;
  };

  it('replaces the pUC19 MCS by 3 inserts (vector amplified)', () => {
    const start = PUC19.seq.indexOf('GGATCC');
    const d = check({ start, end: start + 30 }, true);
    for (const p of d.primers) expect(p.sequence.length).toBeLessThanOrEqual(20 + 60);
  });

  it('inserts at a gap, across the origin, without vector amplification, and with 30 bp overlaps', () => {
    check({ start: 500, end: 500 }, true);
    check({ start: L - 40, end: L + 60 }, true);
    check({ start: 1200, end: 1250 }, false);
    check({ start: 900, end: 900 }, true, 30);
  });

  it('is self-consistent for 25 seeded random designs (positions, insert counts, overlaps)', () => {
    const r = rng(77);
    for (let t = 0; t < 25; t++) {
      const n = 1 + Math.floor(r() * 3);
      const ins = Array.from({ length: n }, (_, i) => makeRecord({ name: `r${t}_${i}`, seq: randomDna(r, 150 + Math.floor(r() * 400)) }));
      const start = Math.floor(r() * L);
      const span = Math.floor(r() * 80);
      const ov = 15 + Math.floor(r() * 26);
      const amplifyVector = r() < 0.8;
      const d = designGibsonPrimers({ vector: PUC19, insertion: { start, end: start + span }, inserts: ins, overlapLength: ov, amplifyVector });
      expect(d.error, `case ${t}`).toBeUndefined();
      const asm = gibsonAssembly(d.fragments);
      expect(canonicalCircular(asm.product!.seq)).toBe(canonicalCircular(d.product!.seq));
      expect(d.product!.seq.length).toBe(L - span + ins.reduce((s, x) => s + x.seq.length, 0));
    }
  });

  it('reports invalid inputs', () => {
    expect(designGibsonPrimers({ vector: { ...PUC19, topology: 'linear' }, insertion: { start: 1, end: 1 }, inserts }).error).toMatch(/circular/);
    expect(designGibsonPrimers({ vector: PUC19, insertion: { start: 1, end: 1 }, inserts: [] }).error).toBeDefined();
    expect(designGibsonPrimers({ vector: PUC19, insertion: { start: 10, end: 5 }, inserts }).error).toMatch(/Invalid insertion/);
    expect(designGibsonPrimers({ vector: PUC19, insertion: { start: 1, end: 1 }, inserts: [makeRecord({ seq: 'ACGT' })] }).error).toMatch(/too short/);
  });
});

describe('goldenGate', () => {
  const rand = rng(41);
  const SITE = 'GGTCTC';
  const avoid = [SITE, 'GAATTC'];
  const OH = ['GGAG', 'TACT', 'AATG', 'GCTT'];
  const backbone = randomDna(rand, 800, avoid);
  const dest = makeRecord({
    name: 'dest',
    topology: 'circular',
    seq: backbone + OH[0] + 'A' + reverseComplement(SITE) + randomDna(rand, 100, avoid) + SITE + 'A' + OH[3],
  });
  const bodies = [200, 300, 250].map((n) => randomDna(rand, n, avoid));
  const insertUnit = (k: number) => SITE + 'A' + OH[k] + bodies[k] + OH[k + 1] + 'T' + reverseComplement(SITE);
  const p1 = makeRecord({ name: 'p1', seq: 'TTTTT' + insertUnit(0) + 'AAAAA' });
  const p2 = makeRecord({ name: 'p2', topology: 'circular', seq: randomDna(rand, 300, avoid) + insertUnit(1) });
  const p3 = makeRecord({ name: 'p3', seq: 'CCCCC' + insertUnit(2) + 'GGGGG' });
  const expected = OH[0] + bodies[0] + OH[1] + bodies[1] + OH[2] + bodies[2] + OH[3] + backbone;

  it('assembles 3 parts into a destination vector with BsaI', () => {
    const res = goldenGate([dest, p1, p2, p3]);
    expect(res.error).toBeUndefined();
    expect(canonicalCircular(res.product!.seq)).toBe(canonicalCircular(expected));
    expect(res.order.map((o) => o.part)).toEqual([0, 1, 2, 3]);
    expect(res.junctions.map((j) => j.overlapSeq)).toEqual([OH[0], OH[1], OH[2], OH[3]]);
    expect(res.warnings).toEqual([]);
  });

  it('finds the order from the overhangs, not the array order, and flips reversed parts', () => {
    const p3rc = { ...p3, seq: reverseComplement(p3.seq) };
    const res = goldenGate([dest, p3rc, p1, p2]);
    expect(res.error).toBeUndefined();
    expect(canonicalCircular(res.product!.seq)).toBe(canonicalCircular(expected));
    expect(res.order).toEqual([
      { part: 0, orientation: 'forward' },
      { part: 2, orientation: 'forward' },
      { part: 3, orientation: 'forward' },
      { part: 1, orientation: 'reverse' },
    ]);
  });

  it('reports palindromic and duplicate overhangs, missing parts and site-free parts', () => {
    const pal = makeRecord({ seq: SITE + 'A' + 'GATC' + bodies[0] + OH[1] + 'T' + reverseComplement(SITE) });
    expect(goldenGate([dest, pal, p2, p3]).error).toMatch(/palindromic overhang GATC/);
    const dup = makeRecord({ seq: SITE + 'A' + OH[1] + bodies[0] + OH[2] + 'T' + reverseComplement(SITE) });
    expect(goldenGate([dest, p1, p2, dup, p3]).error).toMatch(/Duplicate overhang/);
    expect(goldenGate([dest, p1, p3]).error).toMatch(/No assembly order.*unmatched overhang/);
    expect(goldenGate([dest, makeRecord({ name: 'plain', seq: bodies[0] })]).error).toMatch(/not cut by BsaI/);
    expect(goldenGate([dest], { enzyme: 'Nope' }).error).toMatch(/Unknown enzyme/);
  });

  it('linear assembly without the destination vector', () => {
    const res = goldenGate([p2, p3, p1], { circular: false });
    expect(res.error).toBeUndefined();
    expect(res.product!.topology).toBe('linear');
    expect(res.product!.seq).toBe(OH[0] + bodies[0] + OH[1] + bodies[1] + OH[2] + bodies[2] + OH[3]);
    expect(res.product!.ends).toEqual({ left: { kind: '5prime', length: 4 }, right: { kind: '5prime', length: 4 } });
  });
});
