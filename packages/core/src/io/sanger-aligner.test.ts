import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { reverseComplement } from '../seq/alphabet';
import { alignSangerRead } from './sanger-aligner';
import { parseSnapGene } from './snapgene';
import { alignSequenceToReference, parseTraceFile } from './snapgene-alignments';

const SAMPLE = resolve(__dirname, '../../../../test_file/TALED_Right-ND1_CseDa01_G384N-UGI.dna');

/** Deterministic pseudo-random DNA. */
function randomDna(n: number, seed = 1): string {
  let x = seed;
  let out = '';
  for (let i = 0; i < n; i++) {
    x = (x * 1664525 + 1013904223) >>> 0;
    out += 'ACGT'[x >>> 30];
  }
  return out;
}

/** Reference bases covered by M and D operations. */
function refSpan(cigar: string): number {
  let n = 0;
  for (const m of cigar.matchAll(/(\d+)([MIDS])/g)) if (m[2] === 'M' || m[2] === 'D') n += Number(m[1]);
  return n;
}

/** Overlap / union of two reference ranges. */
function jaccard(a: { start: number; end: number }, b: { start: number; end: number }): number {
  const o = Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
  return o / (Math.max(a.end, b.end) - Math.min(a.start, b.start));
}

describe('alignSequenceToReference', () => {
  const ref = randomDna(7000, 7);

  it('aligns a read with a mismatch, an insertion and a deletion in one piece', () => {
    let read = ref.slice(500, 1500);
    const flip = (b: string) => (b === 'A' ? 'C' : 'A');
    read = read.slice(0, 200) + flip(read[200]) + read.slice(201);
    read = read.slice(0, 400) + 'GG' + read.slice(400);
    read = read.slice(0, 703) + read.slice(706);
    const a = alignSequenceToReference(ref, 'linear', { name: 'r', sequence: read });
    expect(a.aligned).toBe(true);
    expect(a.strand).toBe(1);
    expect(a.refRange).toEqual({ start: 500, end: 1500 });
    expect(a.cigar).toMatch(/2I/);
    expect(a.cigar).toMatch(/3D/);
  });

  it('finds the reverse strand', () => {
    const a = alignSequenceToReference(ref, 'linear', { name: 'r', sequence: reverseComplement(ref.slice(1000, 1600)) });
    expect(a.aligned).toBe(true);
    expect(a.strand).toBe(-1);
    expect(a.refRange).toEqual({ start: 1000, end: 1600 });
  });

  it('aligns over the origin of a circular reference as one piece', () => {
    const read = ref.slice(6800) + ref.slice(0, 400);
    const a = alignSequenceToReference(ref, 'circular', { name: 'r', sequence: read });
    expect(a.aligned).toBe(true);
    expect(a.refRange).toEqual({ start: 6800, end: 7400 });
    expect(a.cigar).toBe('600M');
  });

  it('does not align an unrelated sequence', () => {
    const a = alignSequenceToReference(ref, 'circular', { name: 'r', sequence: randomDna(800, 99) });
    expect(a.aligned).toBe(false);
    expect(a.cigar).toBe('800S');
  });

  it('keeps a deleted insert of any size inside one alignment, also with a short flank', () => {
    for (const [del, flank] of [
      [150, 60],
      [900, 400],
      [3000, 45],
    ]) {
      const read = ref.slice(2000 - 500, 2000) + ref.slice(2000 + del, 2000 + del + flank);
      const a = alignSequenceToReference(ref, 'circular', { name: 'r', sequence: read });
      expect(a.aligned).toBe(true);
      // one base at the junction may match either side by chance
      expect(a.cigar).toMatch(new RegExp(`^\\d+M${del}D\\d+M$`));
      expect(a.refRange.start).toBeGreaterThanOrEqual(1500 - 1);
    }
  });

  it('writes a foreign insert between two vector parts as an insertion', () => {
    const read = ref.slice(3000, 3400) + randomDna(250, 5) + ref.slice(3400, 3800);
    const a = alignSequenceToReference(ref, 'circular', { name: 'r', sequence: read });
    expect(a.cigar).toBe('400M250I400M');
  });

  it('reports a short vector part of a read that is mostly foreign sequence', () => {
    const read = randomDna(600, 11) + ref.slice(4000, 4075) + randomDna(500, 12);
    const a = alignSequenceToReference(ref, 'circular', { name: 'r', sequence: read });
    expect(a.aligned).toBe(true);
    // the foreign bases next to the match may extend it by a base or two by chance
    expect(Math.abs(a.refRange.start - 4000)).toBeLessThanOrEqual(2);
    expect(Math.abs(a.refRange.end - 4075)).toBeLessThanOrEqual(2);
  });

  it('treats bases outside the trimmed range as unreliable ends', () => {
    const read = randomDna(40, 3) + ref.slice(5000, 5600);
    const a = alignSequenceToReference(ref, 'circular', {
      name: 'r',
      sequence: read,
      trimmedRange: { start: 40, end: 640 },
    });
    expect(a.refRange).toEqual({ start: 5000, end: 5600 });
    expect(a.trimmedRange).toEqual({ start: 40, end: 640 });
  });

  it('handles odd inputs without throwing', () => {
    for (const sequence of ['', 'ACGT', 'N'.repeat(500), ref + ref.slice(0, 300)]) {
      expect(() => alignSequenceToReference(ref, 'circular', { name: 'r', sequence })).not.toThrow();
    }
    expect(alignSequenceToReference('', 'linear', { name: 'r', sequence: 'ACGTACGTACGTACGT' }).aligned).toBe(false);
  });
});

describe('alignSangerRead', () => {
  it('lets low-quality bases mismatch more cheaply', () => {
    const ref = randomDna(5000, 21);
    // the read's last 60 bases are noise: with low Phred values there they are clipped, the rest is reported
    const read = ref.slice(1000, 1500) + randomDna(60, 22);
    const qual = [...read].map((_, i) => (i < 500 ? 40 : 4));
    const r = alignSangerRead(ref, true, { seq: read, qual });
    expect(r.aligned).toBe(true);
    expect(r.refStart).toBe(1000);
    expect(refSpan(r.cigar)).toBe(500);
  });
});

describe('parseTraceFile', () => {
  /** Minimal ABIF file with one PBAS and one PCON entry (tag number 2). */
  function abif(bases: string, qual: number[]): Uint8Array {
    const dataStart = 128;
    const dirStart = dataStart + bases.length + qual.length;
    const out = new Uint8Array(dirStart + 2 * 28);
    const dv = new DataView(out.buffer);
    out.set([0x41, 0x42, 0x49, 0x46]);
    dv.setUint32(18, 2);
    dv.setUint32(26, dirStart);
    for (let i = 0; i < bases.length; i++) out[dataStart + i] = bases.charCodeAt(i);
    out.set(qual, dataStart + bases.length);
    const entry = (k: number, tag: string, n: number, off: number) => {
      const e = dirStart + k * 28;
      for (let i = 0; i < 4; i++) out[e + i] = tag.charCodeAt(i);
      dv.setUint32(e + 4, 2);
      dv.setUint32(e + 12, n);
      dv.setUint32(e + 16, n);
      dv.setUint32(e + 20, off);
    };
    entry(0, 'PBAS', bases.length, dataStart);
    entry(1, 'PCON', qual.length, dataStart + bases.length);
    return out;
  }

  it('reads the base calls and their Phred values from an .ab1 file', () => {
    const t = parseTraceFile(abif('ACGTNACGT', [10, 20, 30, 40, 2, 41, 42, 43, 44]));
    expect(t?.bases).toBe('ACGTNACGT');
    expect(t?.quality).toEqual([10, 20, 30, 40, 2, 41, 42, 43, 44]);
  });

  it('returns null for something that is not a chromatogram', () => {
    expect(parseTraceFile(new TextEncoder().encode('>seq\nACGT\n'))).toBeNull();
  });
});

// SnapGene's own alignments of the sample file are a cross-check: same strand and nearly the same stretch (the ends
// differ by a few bases where the read is noisy, because noisy ends are trimmed here before they are aligned).
describe.skipIf(!existsSync(SAMPLE))('against the alignments SnapGene saved in the sample file', () => {
  // The suite is skipped without the sample, but its body still runs while tests are collected.
  const parsed: any = existsSync(SAMPLE) ? parseSnapGene(new Uint8Array(readFileSync(SAMPLE))) : {};
  const rec = parsed.records?.[0] ?? parsed.record ?? parsed;
  const reads: any[] = rec.alignedSequences ?? [];

  it('has the five reads', () => {
    expect(reads.length).toBe(5);
  });

  it('reads the embedded ZTR chromatograms: one peak and one quality per base, and the run date', () => {
    for (const r of reads) {
      expect(r.trace).toBeDefined();
      expect(r.trace.peaks.length).toBe(r.sequence.length);
      expect(r.quality.length).toBe(r.sequence.length);
      expect(r.trace.a.length).toBe(r.trace.t.length);
      expect(r.trace.peaks.every((p: number, i: number, a: number[]) => i === 0 || p >= a[i - 1])).toBe(true);
    }
    expect(reads[0].runDate).toBe('2026-07-21');
  });

  for (const id of ['0', '1', '2', '3']) {
    it(`read ${id}: same strand, at least 90 % of the same reference stretch`, () => {
      const sg = reads.find((r) => r.id === id);
      const mine = alignSequenceToReference(rec.seq, rec.topology, {
        id: sg.id,
        name: sg.name,
        sequence: sg.sequence,
        trimmedRange: sg.trimmedRange,
      });
      expect(mine.aligned).toBe(true);
      expect(mine.strand).toBe(sg.strand);
      expect(jaccard(mine.refRange, sg.refRange)).toBeGreaterThanOrEqual(0.9);
    });
  }
});
