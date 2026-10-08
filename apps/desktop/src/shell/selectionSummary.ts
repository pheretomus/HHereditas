/**
 * Selection statistics for the inspector and the status bar: range, length, base
 * composition and GC %.
 *
 * Counting bases of a large selection on a large genome must stay cheap while the user drags
 * (60 fps on a 4.6 Mb record), so a record gets a small block index once: cumulative base
 * counts every BLOCK bases. Any range is then counted from two index lookups plus at most
 * two partial blocks, whatever its length.
 */
import { useMemo } from 'react';
import type { MoleculeType, Range, SeqRecord, Topology } from '@hhereditas/core';
import { mod, normalizeRange, splitAtOrigin } from '@hhereditas/core';
import { formatInt, type SequenceSelection } from '@hhereditas/viewer';
import { formatLength, formatPercent } from './format';

/** Base counts of a stretch of sequence. */
export interface BaseComposition {
  a: number;
  c: number;
  g: number;
  /** T (and U). */
  t: number;
  /** IUPAC S (G or C): counted as GC. */
  s: number;
  /** IUPAC W (A or T): counted as AT. */
  w: number;
  /** Anything else (N, other ambiguity codes, gaps). */
  other: number;
  /** All characters counted. */
  total: number;
}

const A = 0;
const C = 1;
const G = 2;
const T = 3;
const S = 4;
const W = 5;
const OTHER = 6;
const CHANNELS = 7;

/** Character code → channel (upper and lower case). */
const CHANNEL_OF = (() => {
  const table = new Uint8Array(128).fill(OTHER);
  const set = (ch: string, channel: number) => {
    table[ch.charCodeAt(0)] = channel;
    table[ch.toLowerCase().charCodeAt(0)] = channel;
  };
  set('A', A);
  set('C', C);
  set('G', G);
  set('T', T);
  set('U', T);
  set('S', S);
  set('W', W);
  return table;
})();

export interface SequenceIndex {
  readonly seq: string;
  readonly blockSize: number;
  /** cumulative[k * CHANNELS + ch] = count of channel ch in seq[0, k * blockSize). */
  readonly cumulative: Uint32Array;
}

/** Builds the block index of a sequence (one linear pass). */
export function buildSequenceIndex(seq: string, blockSize = 1024): SequenceIndex {
  const blocks = Math.floor(seq.length / blockSize);
  const cumulative = new Uint32Array((blocks + 1) * CHANNELS);
  const running = new Uint32Array(CHANNELS);
  for (let b = 0; b < blocks; b++) {
    const end = (b + 1) * blockSize;
    for (let i = b * blockSize; i < end; i++) {
      const code = seq.charCodeAt(i);
      running[code < 128 ? CHANNEL_OF[code] : OTHER]++;
    }
    cumulative.set(running, (b + 1) * CHANNELS);
  }
  return { seq, blockSize, cumulative };
}

function scan(seq: string, from: number, to: number, into: Float64Array): void {
  for (let i = from; i < to; i++) {
    const code = seq.charCodeAt(i);
    into[code < 128 ? CHANNEL_OF[code] : OTHER]++;
  }
}

/** Adds the counts of seq[start, end) (a linear range) to `into`. */
function countLinear(index: SequenceIndex, start: number, end: number, into: Float64Array): void {
  const { seq, blockSize, cumulative } = index;
  const firstFull = Math.ceil(start / blockSize);
  const lastFull = Math.floor(end / blockSize);
  if (firstFull >= lastFull) {
    scan(seq, start, end, into);
    return;
  }
  for (let ch = 0; ch < CHANNELS; ch++) {
    into[ch] += cumulative[lastFull * CHANNELS + ch] - cumulative[firstFull * CHANNELS + ch];
  }
  scan(seq, start, firstFull * blockSize, into);
  scan(seq, lastFull * blockSize, end, into);
}

/**
 * Base composition of `range` (types.ts conventions; may wrap the origin on circular
 * sequences). Uses the index when given, otherwise scans.
 */
export function countBases(seq: string, range: Range, index?: SequenceIndex): BaseComposition {
  const counts = new Float64Array(CHANNELS);
  const pieces = range.end > seq.length ? splitAtOrigin(range, seq.length) : [range];
  for (const piece of pieces) {
    const start = Math.max(0, Math.min(seq.length, piece.start));
    const end = Math.max(start, Math.min(seq.length, piece.end));
    if (index && index.seq === seq) countLinear(index, start, end, counts);
    else scan(seq, start, end, counts);
  }
  let total = 0;
  for (let ch = 0; ch < CHANNELS; ch++) total += counts[ch];
  return { a: counts[A], c: counts[C], g: counts[G], t: counts[T], s: counts[S], w: counts[W], other: counts[OTHER], total };
}

/** GC % among unambiguous-strength bases (G, C, S vs A, T, W); null when there are none. */
export function gcPercent(comp: BaseComposition): number | null {
  const gc = comp.g + comp.c + comp.s;
  const denominator = gc + comp.a + comp.t + comp.w;
  return denominator > 0 ? (100 * gc) / denominator : null;
}

export interface SelectionSummary {
  /** True when at least one base is selected (otherwise only a caret is placed). */
  hasBases: boolean;
  /** Normalized selected range (end may exceed the length on circular sequences). */
  range: Range;
  /** Caret gap position. */
  caret: number;
  /** Number of selected bases. */
  length: number;
  /** 1-based first and last selected base (last < first when the range wraps the origin). */
  first: number;
  last: number;
  wrapsOrigin: boolean;
  /** Composition of the selected bases; null without a selection. */
  composition: BaseComposition | null;
  gcPercent: number | null;
  sequenceLength: number;
  topology: Topology;
}

type SummaryRecord = Pick<SeqRecord, 'seq' | 'topology'>;

/** Summarizes `selection` on `record`; null when there is no selection at all. */
export function summarizeSelection(
  record: SummaryRecord,
  selection: SequenceSelection | null | undefined,
  index?: SequenceIndex,
): SelectionSummary | null {
  if (!selection) return null;
  const n = record.seq.length;
  const range = normalizeRange(selection.range, n, record.topology);
  const length = Math.max(0, range.end - range.start);
  const hasBases = length > 0;
  const composition = hasBases ? countBases(record.seq, range, index) : null;
  const caret = record.topology === 'circular' && n > 0 ? mod(selection.caret, n) : Math.max(0, Math.min(n, selection.caret));
  const lastIndex = range.end - 1;
  return {
    hasBases,
    range,
    caret,
    length,
    first: range.start + 1,
    last: hasBases ? (record.topology === 'circular' && n > 0 ? mod(lastIndex, n) : lastIndex) + 1 : range.start,
    wrapsOrigin: record.topology === 'circular' && range.end > n,
    composition,
    gcPercent: composition ? gcPercent(composition) : null,
    sequenceLength: n,
    topology: record.topology,
  };
}

/** Composition of the whole sequence (for the inspector when nothing is selected). */
export function summarizeSequence(record: SummaryRecord, index?: SequenceIndex): BaseComposition {
  return countBases(record.seq, { start: 0, end: record.seq.length }, index);
}

/** "396..1,256" (1-based, inclusive); a single base is "1,256". */
export function formatSelectionRange(summary: Pick<SelectionSummary, 'first' | 'last' | 'length'>): string {
  if (summary.length === 1) return formatInt(summary.first);
  return `${formatInt(summary.first)}..${formatInt(summary.last)}`;
}

/** Where the caret is, in words: "after base 1,256", "at the origin". */
export function describeCaret(caret: number, sequenceLength: number, topology: Topology): string {
  if (sequenceLength === 0) return 'in an empty sequence';
  if (caret === 0 || (topology === 'circular' && caret === sequenceLength)) {
    return topology === 'circular' ? 'at the origin' : 'at the start';
  }
  if (caret === sequenceLength) return 'at the end';
  return `after base ${formatInt(caret)}`;
}

/** Status-bar text: "Selection 396..1,256 · 861 bp · GC 52.3 %" or "Cursor after base 1,256". */
export function formatSelectionStatus(summary: SelectionSummary, molecule?: MoleculeType): string {
  if (!summary.hasBases) return `Cursor ${describeCaret(summary.caret, summary.sequenceLength, summary.topology)}`;
  const parts = [`Selection ${formatSelectionRange(summary)}`, formatLength(summary.length, molecule)];
  if (summary.gcPercent !== null && molecule !== 'protein') parts.push(`GC ${formatPercent(summary.gcPercent)}`);
  return parts.join(' · ');
}

/** Index of a record's sequence, rebuilt only when the sequence changes. */
export function useSequenceIndex(seq: string | undefined): SequenceIndex | null {
  return useMemo(() => (seq === undefined ? null : buildSequenceIndex(seq)), [seq]);
}

/**
 * Memoized summary of the current selection. Compute it once in the app and pass it to
 * both the Inspector and the StatusBar.
 */
export function useSelectionSummary(
  record: SummaryRecord | null | undefined,
  selection: SequenceSelection | null | undefined,
): SelectionSummary | null {
  const index = useSequenceIndex(record?.seq);
  const topology = record?.topology;
  const seq = record?.seq;
  return useMemo(
    () => (seq === undefined || topology === undefined ? null : summarizeSelection({ seq, topology }, selection, index ?? undefined)),
    [seq, topology, selection, index],
  );
}
