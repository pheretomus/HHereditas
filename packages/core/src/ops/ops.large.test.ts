/**
 * Large inputs: a synthetic 5 Mbp circular record with 10,000 features, and the real E. coli
 * K-12 MG1655 genome (U00096.3, 4.6 Mbp) when the gitignored fixture is present.
 * Checks that every operation stays fast (generous limits, to catch accidental quadratic
 * behaviour rather than to benchmark) and exact on genome-scale data.
 */
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Feature, SeqRecord, Strand } from '../types';
import { reverseComplement } from '../seq/alphabet';
import { featureSequence } from '../seq/features';
import { deleteRange, insertBases, replaceRange } from './edit';
import { concatRecords, extractRange, reverseComplementRecord, rotateOrigin, setTopology } from './transform';
import { Rng, randomBases, recordProblems } from './test-helpers';

/** Run `fn`, assert it took less than `limitMs`, return its result. */
function timed<T>(label: string, limitMs: number, fn: () => T): T {
  const t0 = performance.now();
  const out = fn();
  const ms = performance.now() - t0;
  expect(ms, `${label} took ${ms.toFixed(0)} ms`).toBeLessThan(limitMs);
  return out;
}

function syntheticGenome(): SeqRecord {
  const rng = new Rng(77);
  const L = 5_000_000;
  const seq = randomBases(rng, L);
  const features: Feature[] = [];
  for (let i = 0; i < 10_000; i++) {
    const start = rng.int(0, L - 1);
    const len = rng.int(1, 5000);
    const segments = rng.bool(0.9) ? [{ start, end: start + len }] : [{ start, end: start + 200 }, { start: start + 400, end: start + 900 }];
    features.push({
      id: `g${i}`,
      type: 'CDS',
      name: `g${i}`,
      strand: rng.pick<Strand>([1, -1]),
      segments: segments.map((s) => (s.start >= L ? { start: s.start - L, end: s.end - L } : s)),
      qualifiers: [{ key: 'locus_tag', value: `b${i}` }],
    });
  }
  return { id: 'big', name: 'big', description: '', seq, topology: 'circular', molecule: 'DNA', features, primers: [], meta: {} };
}

/** featureSequence of every feature, as a list. */
function sequences(rec: SeqRecord): string[] {
  return rec.features.map((f) => featureSequence(f, rec.seq));
}

describe('large records', () => {
  it('handles a 5 Mbp record with 10,000 features quickly and exactly', () => {
    const rec = syntheticGenome();
    const before = sequences(rec);
    const L = rec.seq.length;
    const rot = timed('rotateOrigin', 3000, () => rotateOrigin(rec, 2_345_678));
    expect(sequences(rot)).toEqual(before);
    const rc = timed('reverseComplementRecord', 3000, () => reverseComplementRecord(rec));
    expect(sequences(rc)).toEqual(before);
    const ins = timed('insertBases', 3000, () => insertBases(rec, 1_000_000, 'ACGT'.repeat(250)));
    expect(ins.seq.length).toBe(L + 1000);
    const del = timed('deleteRange (origin-crossing)', 3000, () => deleteRange(rec, { start: L - 1000, end: L + 1000 }));
    expect(del.seq.length).toBe(L - 2000);
    const rep = timed('replaceRange', 3000, () => replaceRange(rec, { start: 10, end: 20_010 }, 'GGATCC'));
    expect(rep.seq.length).toBe(L - 20_000 + 6);
    const ext = timed('extractRange', 3000, () => extractRange(rec, { start: L - 500_000, end: L + 500_000 }));
    expect(ext.seq.length).toBe(1_000_000);
    const lin = timed('setTopology', 3000, () => setTopology(rec, 'linear'));
    const cat = timed('concatRecords', 3000, () => concatRecords([lin, lin]));
    expect(cat.seq.length).toBe(2 * L);
    for (const out of [rot, rc, ins, del, rep, ext, lin]) expect(recordProblems(out)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// E. coli genome (fixtures/large is gitignored: skipped when absent)
// ---------------------------------------------------------------------------

const ECOLI = new URL('../../test/fixtures/large/ecoli_U00096.3.gb', import.meta.url);

/**
 * Minimal reader for this test only (the real GenBank reader lives in io/): the ORIGIN sequence
 * and the features whose location is a single span on one line, `a..b` or `complement(a..b)`.
 */
function readEcoli(): SeqRecord {
  const text = readFileSync(ECOLI, 'utf8');
  const origin = text.indexOf('\nORIGIN');
  const seq = text
    .slice(origin + 7)
    .replace(/[^acgtnACGTN]/g, '')
    .toUpperCase();
  const features: Feature[] = [];
  const re = /^ {5}(\S+) +(complement\()?(\d+)\.\.(\d+)\)?\s*$/gm;
  for (const m of text.slice(0, origin).matchAll(re)) {
    const start = Number(m[3]) - 1;
    const end = Number(m[4]);
    if (m[1] === 'source' || end <= start) continue;
    features.push({
      id: `e${features.length}`,
      type: m[1],
      name: m[1],
      strand: m[2] ? -1 : 1,
      segments: [{ start, end }],
      qualifiers: [],
    });
  }
  return { id: 'ecoli', name: 'U00096', description: '', seq, topology: 'circular', molecule: 'DNA', features, primers: [], meta: {} };
}

describe.skipIf(!existsSync(ECOLI))('E. coli K-12 MG1655 (U00096.3)', () => {
  it('rotates, reverse-complements and edits the genome exactly', () => {
    const rec = readEcoli();
    expect(rec.seq.length).toBe(4_641_652);
    expect(rec.features.length).toBeGreaterThan(8000);
    const before = sequences(rec);
    // thrL CDS (190..255) starts with the ATG of the thr operon leader peptide
    const thrL = rec.features.find((f) => f.type === 'CDS' && f.segments[0].start === 189);
    expect(thrL && featureSequence(thrL, rec.seq).slice(0, 3)).toBe('ATG');

    const L = rec.seq.length;
    for (const k of [1, 2_000_000, L - 1]) {
      const rot = timed(`rotateOrigin(${k})`, 3000, () => rotateOrigin(rec, k));
      expect(sequences(rot)).toEqual(before);
      expect(rotateOrigin(rot, L - k).features).toEqual(rec.features);
    }
    const rc = timed('reverseComplementRecord', 3000, () => reverseComplementRecord(rec));
    expect(rc.seq).toBe(reverseComplement(rec.seq));
    expect(sequences(rc)).toEqual(before);
    // linearize across the origin and re-close: same features, same sequences
    const opened = extractRange(rec, { start: L - 100_000, end: L + 100_000 });
    expect(opened.seq).toBe(rec.seq.slice(L - 100_000) + rec.seq.slice(0, 100_000));
    // features entirely inside the region keep their sequences
    for (const f of opened.features) {
      if (f.partialStart || f.partialEnd) continue;
      const original = rec.features.find((g) => g.id === f.id) as Feature;
      expect(featureSequence(f, opened.seq)).toBe(featureSequence(original, rec.seq));
    }
    const del = timed('deleteRange', 3000, () => deleteRange(rec, { start: 1_000_000, end: 1_100_000 }));
    expect(recordProblems(del)).toEqual([]);
    expect(del.seq.length).toBe(L - 100_000);
  });
});
