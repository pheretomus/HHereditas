/**
 * Column model of one aligned read for the trace panel: where each base of the (reference-oriented) read sits on the
 * reference axis, which columns differ from the reference, where bases were inserted, and the read's chromatogram
 * turned to the reference orientation.
 *
 * Positions are "unwrapped" reference columns: the read starts at `refRange.start` and continues past the end of a
 * circular reference (the panel draws it shifted by the reference length where needed).
 */
import type { AlignedSequence, ChromatogramTrace } from '@hhereditas/core';
import { reverseComplement } from '@hhereditas/core';

export type ColumnKind = 'match' | 'mismatch' | 'deletion';

export interface ReadColumn {
  /** Unwrapped reference column. */
  ref: number;
  /** Index into the oriented read, or -1 for a deletion. */
  qi: number;
  kind: ColumnKind;
  /** Deletions: length of the run of deleted columns this one belongs to. */
  run?: number;
}

export interface ReadInsertion {
  /** The bases sit between reference columns `ref - 1` and `ref`. */
  ref: number;
  /** First inserted base in the oriented read, and how many. */
  qi: number;
  length: number;
}

export interface ReadModel {
  /** Read as it runs along the reference (reverse complement for strand -1). */
  oriented: string;
  /** Unwrapped reference position of the centre of each oriented base (tails continue one base per column). */
  x: Float64Array;
  /** Index of the first and one past the last aligned base of the oriented read. */
  alignedFrom: number;
  alignedTo: number;
  columns: ReadColumn[];
  insertions: ReadInsertion[];
  mismatches: number;
  /** Deleted plus inserted bases. */
  gapBases: number;
  /** Chromatogram in the reference orientation (channels swapped and reversed for strand -1). */
  trace?: ChromatogramTrace;
  /** Largest signal of the trace (for scaling). */
  traceMax: number;
  /** 1-based position in the read as sequenced, for oriented index `qi`. */
  readPosition: (qi: number) => number;
}

function compatible(readBase: string, refBase: string): boolean {
  return readBase === refBase && readBase !== 'N';
}

/** Reverses a trace and swaps the complementary channels, so it reads along the reverse complement. */
function orientTrace(t: ChromatogramTrace): ChromatogramTrace {
  const last = t.a.length - 1;
  return {
    a: t.t.slice().reverse(),
    c: t.g.slice().reverse(),
    g: t.c.slice().reverse(),
    t: t.a.slice().reverse(),
    peaks: t.peaks.map((p) => last - p).reverse(),
  };
}

function maxOf(values: readonly number[], start: number, end: number): number {
  let m = 0;
  for (let i = start; i < end; i++) if (values[i] > m) m = values[i];
  return m;
}

/** Builds the model of `read` against the reference sequence `refSeq` (upper or lower case). */
export function buildReadModel(read: AlignedSequence, refSeq: string): ReadModel {
  const n = read.sequence.length;
  const L = refSeq.length;
  const oriented = (read.strand === 1 ? read.sequence : reverseComplement(read.sequence)).toUpperCase();
  const x = new Float64Array(n);
  const columns: ReadColumn[] = [];
  const insertions: ReadInsertion[] = [];
  let mismatches = 0;
  let gapBases = 0;
  let qi = 0;
  let rp = read.refRange.start;
  let alignedFrom = -1;
  let alignedTo = 0;
  for (const m of read.cigar.matchAll(/(\d+)([MIDNS=XH])/g)) {
    const len = Number(m[1]);
    const op = m[2];
    if (op === 'S') {
      qi += len;
    } else if (op === 'M' || op === '=' || op === 'X') {
      if (alignedFrom < 0) alignedFrom = qi;
      for (let k = 0; k < len; k++, qi++, rp++) {
        const refBase = L > 0 ? refSeq[((rp % L) + L) % L].toUpperCase() : 'N';
        const kind: ColumnKind = compatible(oriented[qi], refBase) ? 'match' : 'mismatch';
        if (kind === 'mismatch') mismatches++;
        columns.push({ ref: rp, qi, kind });
        x[qi] = rp + 0.5;
      }
      alignedTo = qi;
    } else if (op === 'I') {
      if (alignedFrom < 0) alignedFrom = qi;
      insertions.push({ ref: rp, qi, length: len });
      // spread the inserted bases between the two neighbouring column centres
      for (let k = 0; k < len; k++) x[qi + k] = rp - 0.5 + (k + 1) / (len + 1);
      qi += len;
      gapBases += len;
      alignedTo = qi;
    } else if (op === 'D' || op === 'N') {
      for (let k = 0; k < len; k++, rp++) columns.push({ ref: rp, qi: -1, kind: 'deletion', run: len });
      gapBases += len;
    }
  }
  if (alignedFrom < 0) alignedFrom = 0;
  // unaligned tails continue one base per column on either side
  const first = alignedFrom < n ? x[alignedFrom] : read.refRange.start + 0.5;
  for (let i = alignedFrom - 1; i >= 0; i--) x[i] = first - (alignedFrom - i);
  const last = alignedTo > 0 ? x[alignedTo - 1] : first;
  for (let i = alignedTo; i < n; i++) x[i] = last + (i - alignedTo + 1);

  let trace: ChromatogramTrace | undefined;
  let traceMax = 0;
  if (read.trace && read.trace.peaks.length === n && read.trace.a.length > 0) {
    trace = read.strand === 1 ? read.trace : orientTrace(read.trace);
    // scale to the aligned part: the noisy ends often carry huge dye blobs
    const s0 = trace.peaks[Math.min(n - 1, alignedFrom)] ?? 0;
    const s1 = (trace.peaks[Math.max(0, alignedTo - 1)] ?? trace.a.length - 1) + 1;
    traceMax = Math.max(1, ...[trace.a, trace.c, trace.g, trace.t].map((ch) => maxOf(ch, Math.min(s0, s1), Math.max(s0, s1))));
  }
  return {
    oriented,
    x,
    alignedFrom,
    alignedTo,
    columns,
    insertions,
    mismatches,
    gapBases,
    trace,
    traceMax,
    readPosition: (i) => (read.strand === 1 ? i + 1 : n - i),
  };
}

/** Read positions (1-based, as sequenced) of the first and last aligned base, smaller first. */
export function alignedReadSpan(model: ReadModel): { from: number; to: number } {
  if (model.alignedTo <= model.alignedFrom) return { from: 0, to: 0 };
  const a = model.readPosition(model.alignedFrom);
  const b = model.readPosition(model.alignedTo - 1);
  return { from: Math.min(a, b), to: Math.max(a, b) };
}
