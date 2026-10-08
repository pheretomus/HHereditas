/**
 * Mapping between a CDS feature's own coordinates and the top strand, for drawing amino acids
 * under their codons and for selecting a codon. Handles strand, /codon_start, multi-segment
 * (joined) features and features wrapping the origin.
 */
import type { Feature, Range, Topology } from '@hhereditas/core';
import { featureSequence, getQualifier, mod, normalizeRange } from '@hhereditas/core';

/** 0-based offset of the first complete codon (/codon_start minus one; 0 when absent or invalid). */
export function codonStartOffset(feature: Feature): number {
  const v = getQualifier(feature.qualifiers, 'codon_start')?.trim();
  return v === '2' ? 1 : v === '3' ? 2 : 0;
}

export interface CodingInfo {
  readonly feature: Feature;
  /** One letter per codon ('*' for stops); may be shorter than codonCount if the translator returned less. */
  readonly protein: string;
  /** Feature-local index of the first base of codon 0. */
  readonly offset: number;
  /** Number of complete codons. */
  readonly codonCount: number;
  /** Total number of bases of the feature. */
  readonly length: number;
  /** Feature-local index (5'->3' on the feature's strand) of top-strand base `index`, or -1. */
  localIndex(index: number): number;
  /** Top-strand base index of feature-local index `local` (0 <= local < length). */
  baseAt(local: number): number;
}

export type Translator = (codingDna: string, feature: Feature) => string;

interface Seg {
  start: number;
  end: number;
  cum: number;
}

export function buildCodingInfo(
  feature: Feature,
  seq: string,
  topology: Topology,
  translate: Translator,
  fallback?: Translator,
): CodingInfo {
  const L = seq.length;
  const circular = topology === 'circular' && L > 0;
  const segs: Seg[] = [];
  let total = 0;
  for (const s of feature.segments) {
    const r: Range = circular
      ? normalizeRange(s, L, 'circular')
      : { start: Math.max(0, Math.min(L, s.start)), end: Math.max(0, Math.min(L, s.end)) };
    if (r.end <= r.start) continue;
    segs.push({ start: r.start, end: r.end, cum: total });
    total += r.end - r.start;
  }
  const reverse = feature.strand === -1;
  const offset = Math.min(codonStartOffset(feature), total);
  const codonCount = Math.max(0, Math.floor((total - offset) / 3));

  let protein = '';
  if (codonCount > 0) {
    const nt = featureSequence({ ...feature, segments: segs.map((s) => ({ start: s.start, end: s.end })) }, seq);
    const coding = nt.slice(offset, offset + 3 * codonCount);
    try {
      protein = translate(coding, feature);
    } catch {
      try {
        protein = fallback ? fallback(coding, feature) : '';
      } catch {
        protein = '';
      }
    }
  }

  const localIndex = (index: number): number => {
    for (const s of segs) {
      let q = index;
      if (circular && q < s.start) q += L;
      if (q >= s.start && q < s.end) {
        const t = s.cum + (q - s.start);
        return reverse ? total - 1 - t : t;
      }
    }
    return -1;
  };

  const baseAt = (local: number): number => {
    const t = reverse ? total - 1 - local : local;
    for (const s of segs) {
      if (t >= s.cum && t < s.cum + (s.end - s.start)) {
        const p = s.start + (t - s.cum);
        return circular ? mod(p, L) : p;
      }
    }
    return -1;
  };

  return { feature, protein, offset, codonCount, length: total, localIndex, baseAt };
}

/** Codon index (0-based) of top-strand base `index`, or -1 when the base is not in a complete codon. */
export function codonAtBase(info: CodingInfo, index: number): number {
  const l = info.localIndex(index);
  if (l < info.offset) return -1;
  const k = Math.floor((l - info.offset) / 3);
  return k < info.codonCount ? k : -1;
}

/**
 * Top-strand range covered by codon `k` (from its leftmost to its rightmost base; wraps the
 * origin like any range when the codon does).
 */
export function codonRange(info: CodingInfo, k: number, length: number, topology: Topology): Range {
  const a = info.baseAt(info.offset + 3 * k);
  const c = info.baseAt(info.offset + 3 * k + 2);
  let start = info.feature.strand === -1 ? c : a;
  let end = (info.feature.strand === -1 ? a : c) + 1;
  if (topology === 'circular' && length > 0) {
    start = mod(start, length);
    end = mod(end - 1, length) + 1;
    if (end <= start) end += length;
  }
  return { start, end };
}

export interface CodonShade {
  /** Columns [c0, c1) of the row covered by codon `codon`. */
  c0: number;
  c1: number;
  codon: number;
}

export interface CodonLetter {
  /** Column of the codon's middle base. */
  col: number;
  aa: string;
  codon: number;
}

/**
 * Codon shading runs and amino-acid letters of a CDS inside one row, for the columns of the
 * given bars ([startCol, endCol) pairs, row bases starting at `rowStart`).
 */
export function rowCodons(
  info: CodingInfo,
  rowStart: number,
  bars: ReadonlyArray<{ startCol: number; endCol: number }>,
): { shades: CodonShade[]; letters: CodonLetter[] } {
  const shades: CodonShade[] = [];
  const letters: CodonLetter[] = [];
  const limit = info.offset + 3 * info.codonCount;
  for (const bar of bars) {
    let current: CodonShade | null = null;
    for (let col = bar.startCol; col < bar.endCol; col++) {
      const l = info.localIndex(rowStart + col);
      if (l < info.offset || l >= limit) {
        current = null;
        continue;
      }
      const k = Math.floor((l - info.offset) / 3);
      if (current && current.codon === k && current.c1 === col) current.c1 = col + 1;
      else {
        current = { c0: col, c1: col + 1, codon: k };
        shades.push(current);
      }
      if ((l - info.offset) % 3 === 1) letters.push({ col, aa: info.protein[k] ?? '', codon: k });
    }
  }
  return { shades, letters };
}
