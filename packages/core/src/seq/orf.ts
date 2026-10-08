/**
 * Open reading frame (ORF) finder for linear and circular nucleotide sequences.
 *
 * Definition (the brute-force reference in tools/oracle/seqtools_oracle.py implements exactly this):
 * on each strand, read 5'->3' (the bottom strand is the reverse complement). Every start codon
 * opens a reading frame that is closed by the first in-frame stop codon; the ORF runs from the first
 * base of the start codon to the last base of the stop codon. A codon is a stop codon when every
 * codon its IUPAC letters may stand for is a stop codon of the genetic code (so TAR is a stop, TAN
 * or NNN is not; context-dependent stops of tables 27, 28 and 31 count as stops). On a circular
 * molecule reading continues across the origin, but an ORF never covers more than one full turn.
 */
import type { Orf, Topology } from '../types';
import { codonKey, compileGeneticCode, encodeNucleotides, reverseComplementMasks } from './translate';

/** Options of {@link findOrfs}. */
export interface FindOrfsOptions {
  /** Minimum length in amino acids, stop codon excluded: ORFs with aaLength >= minAaLength are kept. Default 100. */
  minAaLength?: number;
  /** NCBI genetic code id whose start and stop codons are used; default 1. */
  table?: number;
  /**
   * 'ATG' (default): only ATG opens an ORF. 'table': every start codon of the genetic code
   * (e.g. TTG, CTG and ATG in table 1; GTG, TTG, ATT, ... in table 11); an ambiguous codon counts
   * when every codon it may stand for is a start codon.
   */
  startCodons?: 'ATG' | 'table';
  /** Strands to search; default 'both'. */
  strands?: 'both' | 'top' | 'bottom';
  /**
   * false (default): only the longest ORF per stop codon is reported (the most upstream start codon);
   * true: every start codon gives its own ORF, so nested ORFs sharing a stop codon are all reported.
   */
  includeNested?: boolean;
  /**
   * Also report reading frames that have no stop codon (`hasStop: false`), default false.
   * Linear molecules: ORFs that run off the 3' end; they end at the last complete codon, and only
   * the longest per strand and frame is kept unless `includeNested`.
   * Circular molecules: reading frames with no stop codon within one full turn; they are capped at
   * one turn (floor(L/3) codons). Unless `includeNested`, one is kept per strand and reading-frame
   * cycle (per frame when L is a multiple of 3; a single cycle per strand otherwise): the one whose
   * start codon comes first in that strand's 5'->3' coordinates.
   */
  allowNoStop?: boolean;
}

const START = 1;
const STOP = 2;
const ATG_KEY = codonKey(1, 8, 4); // masks of A, T, G

/** An ORF in strand-local coordinates (5'->3' on its own strand; `end` may exceed L on circular molecules). */
interface LocalOrf {
  start: number;
  end: number;
  aaLength: number;
  hasStop: boolean;
}

/** START / STOP flags for every codon key. */
function codonKinds(tableId: number, startCodons: 'ATG' | 'table'): Uint8Array {
  const cc = compileGeneticCode(tableId);
  const kind = new Uint8Array(4096);
  for (let key = 0; key < 4096; key++) {
    kind[key] = (cc.stop[key] === 1 ? STOP : 0) | (startCodons === 'table' && cc.start[key] === 1 ? START : 0);
  }
  if (startCodons === 'ATG') kind[ATG_KEY] |= START;
  return kind;
}

interface ScanSettings {
  circular: boolean;
  kind: Uint8Array;
  nested: boolean;
  allowNoStop: boolean;
}

/**
 * ORFs of one strand given as nucleotide masks, before the minimum-length filter.
 *
 * Each of the three frames is scanned codon by codon, remembering the start codons seen since the
 * last stop codon (`pending`). On a circular molecule the scan runs over a virtual doubled sequence
 * (positions x >= L read base x mod L) but only start codons with x < L are taken, and it stops in the
 * second turn as soon as no start codon is pending. A stop codon at position p mod L can then be seen
 * from two virtual positions (p and p + L), so the longest ORF per stop is kept in a map.
 */
function scanStrand(m: Uint8Array, s: ScanSettings): LocalOrf[] {
  const L = m.length;
  const out: LocalOrf[] = [];
  if (L < 3) return out;
  const { circular, kind, nested, allowNoStop } = s;
  const turnCodons = Math.floor(L / 3);
  const longestPerStop = new Map<number, LocalOrf>(); // circular, not nested
  const firstOpenPerCycle = new Map<number, LocalOrf>(); // circular, not nested, allowNoStop
  const pending: number[] = [];

  /** A circular reading frame without a stop codon within one turn of `x`. */
  const openCircular = (x: number) => {
    const orf: LocalOrf = { start: x, end: x + 3 * turnCodons, aaLength: turnCodons, hasStop: false };
    if (nested) {
      out.push(orf);
      return;
    }
    const cycle = L % 3 === 0 ? x % 3 : 0;
    const best = firstOpenPerCycle.get(cycle);
    if (best === undefined || x < best.start) firstOpenPerCycle.set(cycle, orf);
  };

  /** Close the pending start codons at a stop codon starting at (virtual) position `y`. */
  const closeAtStop = (y: number) => {
    const end = y + 3;
    let first = 0;
    if (circular) {
      while (first < pending.length && end - pending[first] > L) first++;
      if (allowNoStop) for (let j = 0; j < first; j++) openCircular(pending[j]);
    }
    if (first === pending.length) return;
    if (nested) {
      for (let j = first; j < pending.length; j++) {
        out.push({ start: pending[j], end, aaLength: (y - pending[j]) / 3, hasStop: true });
      }
      return;
    }
    const orf: LocalOrf = { start: pending[first], end, aaLength: (y - pending[first]) / 3, hasStop: true };
    if (!circular) {
      out.push(orf);
      return;
    }
    const stop = y % L;
    const best = longestPerStop.get(stop);
    if (best === undefined || orf.aaLength > best.aaLength) longestPerStop.set(stop, orf);
  };

  /** Start codons still pending when a frame's scan ends: there is no stop codon downstream. */
  const closeOpen = () => {
    if (!allowNoStop) return;
    if (circular) {
      for (const x of pending) openCircular(x);
      return;
    }
    for (const x of nested ? pending : pending.slice(0, 1)) {
      const codons = Math.floor((L - x) / 3);
      out.push({ start: x, end: x + 3 * codons, aaLength: codons, hasStop: false });
    }
  };

  const limit = circular ? 2 * L : L;
  for (let frame = 0; frame < 3; frame++) {
    pending.length = 0;
    for (let x = frame; x + 3 <= limit; x += 3) {
      if (x >= L && pending.length === 0) break; // second turn: only needed to close pending start codons
      const key =
        x + 3 <= L
          ? (m[x] << 8) | (m[x + 1] << 4) | m[x + 2]
          : (m[x % L] << 8) | (m[(x + 1) % L] << 4) | m[(x + 2) % L];
      const k = kind[key];
      if (k & STOP) {
        if (pending.length > 0) {
          closeAtStop(x);
          pending.length = 0;
        }
      } else if (k & START && x < L) {
        pending.push(x);
      }
    }
    if (pending.length > 0) closeOpen();
  }
  for (const orf of longestPerStop.values()) out.push(orf);
  for (const orf of firstOpenPerCycle.values()) out.push(orf);
  return out;
}

/** Convert a strand-local ORF to an {@link Orf} in top-strand coordinates. */
function toTopStrand(o: LocalOrf, strand: 1 | -1, L: number): Orf {
  let start = o.start;
  let end = o.end;
  if (strand === -1) {
    start = L - o.end;
    end = L - o.start;
    if (start < 0) {
      start += L;
      end += L;
    }
  }
  return { range: { start, end }, strand, frame: (o.start % 3) as 0 | 1 | 2, aaLength: o.aaLength, hasStop: o.hasStop };
}

/**
 * Find open reading frames (see the module comment for the exact definition).
 *
 * Ranges are 0-based half-open top-strand coordinates from the first base of the start codon to the
 * last base of the stop codon; on circular molecules an ORF crossing the origin has `range.end > L`
 * (normalized: 0 <= start < L, length <= L). `frame` is the start codon's position modulo 3 counted
 * from the start of the sequence for strand 1 and from its end for strand -1 (for a non-wrapping
 * strand -1 ORF, (L - range.end) % 3). `aaLength` excludes the stop codon. Sequences are read
 * case-insensitively, U as T. Result sorted by range.start, then range.end, then strand (1 first).
 *
 * @throws TranslationError when the sequence contains a character that is not an IUPAC nucleotide code.
 * @throws RangeError for an unknown table or invalid options.
 */
export function findOrfs(seq: string, topology: Topology, options: FindOrfsOptions = {}): Orf[] {
  const minAaLength = options.minAaLength ?? 100;
  if (!(minAaLength >= 0)) throw new RangeError(`minAaLength must be >= 0, got ${minAaLength}`);
  const startCodons = options.startCodons ?? 'ATG';
  if (startCodons !== 'ATG' && startCodons !== 'table') throw new RangeError(`startCodons must be 'ATG' or 'table'`);
  const strands = options.strands ?? 'both';
  if (strands !== 'both' && strands !== 'top' && strands !== 'bottom') {
    throw new RangeError(`strands must be 'both', 'top' or 'bottom'`);
  }
  const table = options.table ?? 1;
  if (!Number.isInteger(table)) throw new RangeError(`table must be an integer NCBI id, got ${table}`);
  const settings: ScanSettings = {
    circular: topology === 'circular',
    kind: codonKinds(table, startCodons),
    nested: options.includeNested ?? false,
    allowNoStop: options.allowNoStop ?? false,
  };

  const L = seq.length;
  const top = encodeNucleotides(seq, true);
  const orfs: Orf[] = [];
  if (strands !== 'bottom') {
    for (const o of scanStrand(top, settings)) if (o.aaLength >= minAaLength) orfs.push(toTopStrand(o, 1, L));
  }
  if (strands !== 'top') {
    const bottom = reverseComplementMasks(top);
    for (const o of scanStrand(bottom, settings)) if (o.aaLength >= minAaLength) orfs.push(toTopStrand(o, -1, L));
  }
  orfs.sort((a, b) => a.range.start - b.range.start || a.range.end - b.range.end || b.strand - a.strand);
  return orfs;
}
