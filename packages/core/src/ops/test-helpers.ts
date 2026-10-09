/**
 * TEST-ONLY helpers for the ops module: a seeded PRNG, random record generators, deep freezing,
 * structural-sharing and invariant checks, and a brute-force "token" model of edits used as an
 * oracle that is independent of the arithmetic in `remap.ts`.
 *
 * Not exported from `ops/index.ts`. Uses no DOM or Node APIs, so it is safe under src/.
 *
 * Token model: base i of the original molecule is token i; the j-th inserted base is token
 * INSERTED_TOKEN + j. A layout is the token array of a molecule; the "path" of a segment is the
 * list of tokens it covers in traversal (top-strand) order.
 */
import type { Feature, FragmentEnds, Primer, Qualifier, Range, SeqRecord, Strand, Topology } from '../types';
import { isDna } from '../seq/alphabet';
import { featureSequence } from '../seq/features';
import { mod } from '../seq/range';

// ---------------------------------------------------------------------------
// PRNG
// ---------------------------------------------------------------------------

/** Deterministic PRNG (mulberry32 by Tommy Ettinger, public domain). */
export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** Uniform float in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform integer in [lo, hi] (both inclusive). */
  int(lo: number, hi: number): number {
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }

  bool(p = 0.5): boolean {
    return this.next() < p;
  }

  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)];
  }

  /** Integer in [0, max], biased towards the boundaries 0, 1, max - 1 and max (edge cases). */
  position(max: number): number {
    const r = this.next();
    if (r < 0.08) return 0;
    if (r < 0.16) return max;
    if (r < 0.2) return Math.min(1, max);
    if (r < 0.24) return Math.max(0, max - 1);
    return this.int(0, max);
  }
}

// ---------------------------------------------------------------------------
// Random records
// ---------------------------------------------------------------------------

const IUPAC = 'ACGTRYSWKMBDHVN';

/** Random uppercase bases; with `iupac`, about 1 in 10 is an ambiguity code. */
export function randomBases(rng: Rng, n: number, iupac = false): string {
  let s = '';
  for (let i = 0; i < n; i++) s += iupac && rng.bool(0.1) ? rng.pick([...IUPAC]) : rng.pick(['A', 'C', 'G', 'T']);
  return s;
}

/**
 * A random NORMALIZED range of a molecule of length L. Linear: 0 <= start <= end <= L.
 * Circular (L > 0): 0 <= start < L, length 0..L (may cross the origin, end > L).
 * `minLength` forces non-empty ranges when 1.
 */
export function randomRange(rng: Rng, L: number, topology: Topology, minLength = 0): Range {
  if (L === 0) return { start: 0, end: 0 };
  if (topology === 'linear') {
    for (;;) {
      const a = rng.position(L);
      const b = rng.bool(0.1) ? a : rng.position(L);
      const r = { start: Math.min(a, b), end: Math.max(a, b) };
      if (r.end - r.start >= minLength) return r;
    }
  }
  const start = rng.position(L - 1);
  const roll = rng.next();
  let len: number;
  if (roll < 0.06) len = 0;
  else if (roll < 0.12) len = L;
  else if (roll < 0.4) len = rng.int(1, Math.min(L, 4));
  else len = rng.int(1, L);
  len = Math.max(len, minLength);
  return { start, end: start + len };
}

/** A random segment: mostly non-empty ranges, sometimes zero-length (a between-base site). */
export function randomSegment(rng: Rng, L: number, topology: Topology): Range {
  if (rng.bool(0.1) || L === 0) {
    const p = topology === 'circular' ? rng.position(Math.max(0, L - 1)) : rng.position(L);
    return { start: p, end: p };
  }
  return randomRange(rng, L, topology, 1);
}

/**
 * A random contiguous join: one stretch of at least 2 bases cut into adjacent segments (on a
 * circular molecule often exactly at the origin, the GenBank way of writing a feature that crosses
 * it), sometimes followed by an unrelated segment (an intron between them).
 */
function randomJoin(rng: Rng, L: number, topology: Topology): Range[] {
  const ring = topology === 'circular';
  const stretch =
    ring && rng.bool(0.5)
      ? (() => {
          const s = rng.int(1, L - 1);
          return { start: s, end: L + rng.int(1, s) }; // crosses the origin, at most L bases
        })()
      : randomRange(rng, L, topology, 2);
  const cuts = new Set<number>();
  if (ring && stretch.end > L && rng.bool(0.7)) cuts.add(L);
  const extra = rng.int(cuts.size === 0 ? 1 : 0, 2);
  for (let i = 0; i < extra; i++) cuts.add(rng.int(stretch.start + 1, stretch.end - 1));
  const segments: Range[] = [];
  let from = stretch.start;
  for (const c of [...[...cuts].sort((x, y) => x - y), stretch.end]) {
    segments.push(from >= L && ring ? { start: from - L, end: c - L } : { start: from, end: c });
    from = c;
  }
  if (rng.bool(0.2)) segments.push(randomSegment(rng, L, topology));
  return segments;
}

/** Bases of a feature in its own 5'->3' order (strand -1: right to left), as positions mod L. */
export function featurePositions(f: Feature, L: number): number[] {
  const top = f.segments.flatMap((s) => segmentPositions(s, L));
  return f.strand === -1 ? top.reverse() : top;
}

/**
 * INSDC location text of `positions` (0-based, in top-strand order, runs of consecutive positions;
 * a run never continues across the origin), wrapped in complement(...) when asked.
 */
export function formatPositions(positions: readonly number[], complement: boolean): string {
  const runs: Array<[number, number]> = [];
  for (const p of positions) {
    const last = runs[runs.length - 1];
    if (last !== undefined && p === last[1] + 1) last[1] = p;
    else runs.push([p, p]);
  }
  const parts = runs.map(([a, b]) => (a === b ? `${a + 1}` : `${a + 1}..${b + 1}`));
  const inner = parts.length > 1 ? `join(${parts.join(',')})` : parts[0];
  return complement ? `complement(${inner})` : inner;
}

/** Keys of the position-bearing qualifiers (INSDC Feature Table v11.4, section 7.3). */
export const POSITIONAL_KEYS: readonly string[] = ['transl_except', 'anticodon', 'rpt_unit_range', 'tag_peptide'];

/**
 * Add position-dependent qualifiers to `f`: /codon_start (always for a CDS, sometimes for other
 * types), an in-frame /transl_except codon, an /anticodon (any 3 consecutive bases of the
 * feature), a one-base /transl_except, a /rpt_unit_range and a /tag_peptide inside one segment,
 * and a /translation. Codons are only added when no base of the feature is covered twice.
 */
function addPositionalQualifiers(rng: Rng, f: Feature, L: number): void {
  const positions = featurePositions(f, L);
  const offset = f.type === 'CDS' || rng.bool(0.3) ? rng.int(0, 2) : -1;
  if (offset >= 0 && (f.type !== 'CDS' || offset > 0 || rng.bool(0.5))) {
    f.qualifiers.push({ key: 'codon_start', value: String(offset + 1) });
  }
  const frame = Math.max(0, offset);
  const distinct = new Set(positions).size === positions.length;
  const codons = Math.floor((positions.length - frame) / 3);
  const codon = (first: number) => positions.slice(first, first + 3).sort((x, y) => x - y);
  // a strand -1 codon reads right to left: in top-strand order the run may still cross the origin
  const topOrder = (bases: number[]) => {
    const wrapAt = bases.findIndex((p, k) => k > 0 && p !== bases[k - 1] + 1);
    return wrapAt > 0 && bases[wrapAt - 1] === L - 1 && bases[wrapAt] === 0 ? bases : orderAcrossOrigin(bases, L);
  };
  // usually the canonical text (maximal runs), sometimes one written part per base (join(7,8,9)),
  // which is as valid and must keep its written form
  const write = (bases: number[]) =>
    rng.bool(0.2) ? formatPositionsPerBase(bases, f.strand === -1) : formatPositions(bases, f.strand === -1);
  if (distinct && codons > 0 && rng.bool(0.7)) {
    const bases = topOrder(codon(frame + 3 * rng.int(0, codons - 1)));
    f.qualifiers.push({ key: 'transl_except', value: `(pos:${write(bases)},aa:Sec)` });
  }
  if (distinct && positions.length >= 3 && rng.bool(0.3)) {
    const bases = topOrder(codon(rng.int(0, positions.length - 3)));
    f.qualifiers.push({ key: 'anticodon', value: `(pos:${write(bases)},aa:Phe,seq:aaa)` });
  }
  if (positions.length > 0 && rng.bool(0.15)) {
    // a single base, e.g. a stop codon completed by polyadenylation: (pos:1017,aa:TERM)
    f.qualifiers.push({ key: 'transl_except', value: `(pos:${rng.pick(positions) + 1},aa:TERM)` });
  }
  const plain = f.segments.filter((s) => s.end > s.start && s.end <= L);
  for (const key of ['rpt_unit_range', 'tag_peptide']) {
    if (plain.length > 0 && rng.bool(0.3)) {
      const s = rng.pick(plain);
      const a = rng.int(s.start, s.end - 1);
      const b = rng.int(a, s.end - 1);
      // a = b gives the one-base form "12..12"; fuzzy markers (rare in practice) exercise '<' / '>'
      const open = rng.bool(0.1) ? '<' : '';
      const close = rng.bool(0.1) ? '>' : '';
      f.qualifiers.push({ key, value: `${open}${a + 1}..${close}${b + 1}` });
    }
  }
  // a stored conceptual translation (its text does not matter: it must only be kept or dropped)
  if (rng.bool(0.5)) f.qualifiers.push({ key: 'translation', value: 'MSTOREDPROTEIN' });
}

/** INSDC location text with one written part per base (`join(7,8,9)`), wrapped in complement(...) when asked. */
function formatPositionsPerBase(positions: readonly number[], complement: boolean): string {
  const inner = positions.length > 1 ? `join(${positions.map((p) => p + 1).join(',')})` : `${positions[0] + 1}`;
  return complement ? `complement(${inner})` : inner;
}

/**
 * Sorted positions of one stretch of a circular molecule put in top-strand order: when the
 * stretch crosses the origin (e.g. sorted [0, 1, L - 1]) the part before the origin comes first.
 */
function orderAcrossOrigin(sorted: number[], L: number): number[] {
  for (let k = 1; k < sorted.length; k++) {
    if (sorted[k] !== sorted[k - 1] + 1 && sorted[sorted.length - 1] === L - 1 && sorted[0] === 0) {
      return [...sorted.slice(k), ...sorted.slice(0, k)];
    }
  }
  return sorted;
}

/** Options of {@link randomFeature} (probabilities; both 0 by default). */
export interface RandomFeatureOptions {
  /** Probability that the feature is a contiguous join (adjacent segments, see randomJoin). */
  joins?: number;
  /** Probability that the feature gets position-dependent qualifiers (/codon_start, /transl_except, /translation, ...). */
  positional?: number;
}

/** A random feature with 1-3 segments (any order), random strand and partial flags. */
export function randomFeature(rng: Rng, L: number, topology: Topology, id: string, opts: RandomFeatureOptions = {}): Feature {
  let segments: Range[];
  if (opts.joins !== undefined && L >= 2 && rng.bool(opts.joins)) {
    segments = randomJoin(rng, L, topology);
  } else {
    const count = rng.bool(0.7) ? 1 : rng.int(2, 3);
    segments = [];
    for (let i = 0; i < count; i++) segments.push(randomSegment(rng, L, topology));
  }
  const strand = rng.pick<Strand>([1, -1, 0]);
  const f: Feature = {
    id,
    type: rng.pick(['CDS', 'misc_feature', 'promoter', 'primer_bind', 'gene']),
    name: id,
    strand,
    segments,
    qualifiers: [
      { key: 'label', value: id },
      { key: 'note', value: `note of ${id}` },
      ...(rng.bool(0.2) ? [{ key: 'pseudo', value: null }] : []),
    ],
  };
  if (rng.bool(0.15)) f.partialStart = true;
  if (rng.bool(0.15)) f.partialEnd = true;
  if (rng.bool(0.2)) f.color = '#31a354';
  if (rng.bool(0.1)) f.reverseColor = '#e6550d';
  if (opts.positional !== undefined && rng.bool(opts.positional)) addPositionalQualifiers(rng, f, L);
  return f;
}

/** Options of {@link randomRecord}; lengths in bases (bp). */
export interface RandomRecordOptions extends RandomFeatureOptions {
  topology?: Topology;
  minLength?: number;
  maxLength?: number;
  maxFeatures?: number;
  /** Probability that a linear record gets random sticky ends. */
  endsProbability?: number;
  iupac?: boolean;
  /** Prefix of feature ids (to build parts with colliding or distinct ids). */
  idPrefix?: string;
  /** Molecule type (default DNA); RNA records are written with U unless `rnaWithT`. */
  molecule?: 'DNA' | 'RNA';
  /** RNA records written with T (as GenBank RNA records usually are) instead of U. */
  rnaWithT?: boolean;
}

/** A random valid record (lengths 1-300 by default) with random features, primers and meta. */
export function randomRecord(rng: Rng, opts: RandomRecordOptions = {}): SeqRecord {
  const topology = opts.topology ?? (rng.bool() ? 'linear' : 'circular');
  const L = rng.int(opts.minLength ?? 1, opts.maxLength ?? 300);
  const bases = randomBases(rng, L, opts.iupac ?? rng.bool(0.2));
  const seq = opts.molecule === 'RNA' && opts.rnaWithT !== true ? bases.replace(/T/g, 'U') : bases;
  const prefix = opts.idPrefix ?? 'f';
  const features: Feature[] = [];
  const nf = rng.int(0, opts.maxFeatures ?? 8);
  for (let i = 0; i < nf; i++) features.push(randomFeature(rng, L, topology, `${prefix}${i}`, opts));
  const primers: Primer[] = [];
  const np = rng.int(0, 2);
  for (let i = 0; i < np; i++) primers.push({ id: `p${i}`, name: `primer ${i}`, sequence: randomBases(rng, rng.int(10, 25)) });
  if (primers.length > 0 && rng.bool()) primers[0].description = 'forward';
  const rec: SeqRecord = {
    id: 'doc_test',
    name: 'random',
    description: 'random record',
    seq,
    topology,
    molecule: opts.molecule ?? 'DNA',
    features,
    primers,
    meta: {
      accession: 'X00001',
      version: 'X00001.1',
      organism: 'synthetic construct',
      comments: ['first comment'],
      extras: { k: 'v' },
    },
  };
  if (topology === 'linear' && rng.bool(opts.endsProbability ?? 0.3)) {
    const maxOverhang = Math.min(4, Math.floor(L / 2));
    const end = () => {
      const n = rng.int(0, maxOverhang);
      return n === 0 ? { kind: 'blunt' as const, length: 0 } : { kind: rng.pick(['5prime', '3prime'] as const), length: n };
    };
    rec.ends = { left: end(), right: end() };
  }
  return rec;
}

// ---------------------------------------------------------------------------
// Edge-seeking positions
// ---------------------------------------------------------------------------

/**
 * A gap position of `rec` that is often next to something interesting: a feature segment
 * boundary or an overhang junction (offset by -1, 0 or +1), the origin, or else uniform.
 * Always in [0, L]; on circular records also reduced into [0, L) when `circularStart` is set.
 */
export function edgePosition(rng: Rng, rec: SeqRecord, circularStart = false): number {
  const L = rec.seq.length;
  const marks: number[] = [0, L];
  for (const f of rec.features) for (const s of f.segments) marks.push(s.start, s.end);
  if (rec.ends !== undefined) marks.push(rec.ends.left.length, L - rec.ends.right.length);
  let p = rng.bool(0.6) ? rng.pick(marks) + rng.int(-1, 1) : rng.position(L);
  if (rec.topology === 'circular' && L > 0) {
    p = mod(p, L);
    if (!circularStart && p === 0 && rng.bool()) p = L;
  } else {
    p = Math.max(0, Math.min(L, p));
  }
  return p;
}

/** A normalized range of `rec` whose ends are often next to feature boundaries or junctions. */
export function edgeRange(rng: Rng, rec: SeqRecord): Range {
  const L = rec.seq.length;
  if (L === 0) return { start: 0, end: 0 };
  if (rng.bool(0.3)) return randomRange(rng, L, rec.topology);
  if (rec.topology === 'linear') {
    const a = edgePosition(rng, rec);
    const b = rng.bool(0.1) ? a : edgePosition(rng, rec);
    return { start: Math.min(a, b), end: Math.max(a, b) };
  }
  const start = edgePosition(rng, rec, true);
  const end = edgePosition(rng, rec, true);
  let len = mod(end - start, L);
  if (len === 0 && rng.bool(0.3)) len = L;
  return { start, end: start + len };
}

// ---------------------------------------------------------------------------
// Immutability checks
// ---------------------------------------------------------------------------

/** Recursively freeze an object graph (so that any write to it throws in strict mode). */
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

function collectObjects(value: unknown, into: Set<object>): void {
  if (value === null || typeof value !== 'object' || into.has(value)) return;
  into.add(value);
  for (const v of Object.values(value)) collectObjects(v, into);
}

/** Number of objects reachable from `output` that are also reachable from `input` (should be 0). */
export function sharedObjectCount(input: unknown, output: unknown): number {
  const seen = new Set<object>();
  collectObjects(input, seen);
  const out = new Set<object>();
  collectObjects(output, out);
  let n = 0;
  for (const o of out) if (seen.has(o)) n++;
  return n;
}

// ---------------------------------------------------------------------------
// Invariants (types.ts)
// ---------------------------------------------------------------------------

/** Problems with a range for a molecule of length L, per the normalized form of types.ts. */
export function rangeProblem(r: Range, L: number, topology: Topology): string | null {
  if (!Number.isInteger(r.start) || !Number.isInteger(r.end)) return `non-integer range ${JSON.stringify(r)}`;
  if (Object.is(r.start, -0) || Object.is(r.end, -0)) return `negative zero in ${JSON.stringify(r)}`;
  if (topology === 'linear') {
    return r.start >= 0 && r.start <= r.end && r.end <= L ? null : `linear range ${JSON.stringify(r)} invalid for L=${L}`;
  }
  return L > 0 && r.start >= 0 && r.start < L && r.start <= r.end && r.end <= r.start + L
    ? null
    : `circular range ${JSON.stringify(r)} invalid for L=${L}`;
}

/** Every violation of the record invariants (ranges, ids, ends, alphabet). Empty when valid. */
export function recordProblems(rec: SeqRecord): string[] {
  const problems: string[] = [];
  const L = rec.seq.length;
  if (rec.molecule === 'DNA' && !isDna(rec.seq)) problems.push('sequence is not uppercase IUPAC DNA');
  if (rec.molecule === 'RNA' && (!isDna(rec.seq.replace(/U/g, 'T')) || (rec.seq.includes('U') && rec.seq.includes('T')))) {
    problems.push('sequence is not uppercase IUPAC RNA written with one letter for uracil');
  }
  const ids = new Set<string>();
  for (const f of rec.features) {
    if (ids.has(f.id)) problems.push(`duplicate feature id ${f.id}`);
    ids.add(f.id);
    if (f.segments.length === 0) problems.push(`feature ${f.id} has no segments`);
    if (f.strand !== 1 && f.strand !== -1 && f.strand !== 0) problems.push(`feature ${f.id} has strand ${String(f.strand)}`);
    if (Object.is(f.strand, -0)) problems.push(`feature ${f.id} has strand -0`);
    for (const s of f.segments) {
      const p = rangeProblem(s, L, rec.topology);
      if (p !== null) problems.push(`feature ${f.id}: ${p}`);
    }
  }
  const pids = new Set<string>();
  for (const p of rec.primers) {
    if (pids.has(p.id)) problems.push(`duplicate primer id ${p.id}`);
    pids.add(p.id);
  }
  if (rec.ends !== undefined) {
    if (rec.topology === 'circular') problems.push('circular record carries ends');
    for (const side of ['left', 'right'] as const) {
      const e = rec.ends[side];
      if ((e.kind === 'blunt') !== (e.length === 0)) problems.push(`${side} end ${JSON.stringify(e)} inconsistent`);
      if (e.length < 0 || e.length > L) problems.push(`${side} end ${JSON.stringify(e)} longer than the sequence`);
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Token model
// ---------------------------------------------------------------------------

/** Token of the j-th inserted base. Original bases are tokens 0..L-1. */
export const INSERTED_TOKEN = 1_000_000;

/** Positions (mod L) covered by a segment, in traversal order. */
export function segmentPositions(seg: Range, L: number): number[] {
  const out: number[] = [];
  for (let x = seg.start; x < seg.end; x++) out.push(L > 0 ? x % L : x);
  return out;
}

/** Tokens covered by a segment of a molecule whose layout is `tokens`. */
export function segmentTokens(tokens: readonly number[], seg: Range): number[] {
  return segmentPositions(seg, tokens.length).map((p) => tokens[p]);
}

/** Description of an edit for the model: delete [start, start + deleted), insert `inserted` bases. */
export interface ModelEdit {
  start: number;
  deleted: number;
  inserted: number;
}

/**
 * Token layout after an edit, restating the layout / origin rules with plain array operations:
 * circular insertion at gap 0 appends; a deletion crossing the origin puts the inserted bases
 * first, followed by the survivors in circular order.
 */
export function modelLayout(L: number, topology: Topology, edit: ModelEdit): number[] {
  const old = Array.from({ length: L }, (_, i) => i);
  const ins = Array.from({ length: edit.inserted }, (_, j) => INSERTED_TOKEN + j);
  let a = edit.start;
  if (topology === 'circular' && edit.deleted === 0 && a === 0) a = L;
  if (topology === 'circular' && a + edit.deleted > L) return [...ins, ...old.slice(a + edit.deleted - L, a)];
  return [...old.slice(0, a), ...ins, ...old.slice(a + edit.deleted)];
}

/**
 * Consecutive segment indices that form one contiguous stretch ("contiguous runs" in remap.ts,
 * restated): non-empty segments each starting where the previous one ends (modulo L on a circular
 * molecule), at most L bases in all on a circular molecule. Every other segment, zero-length ones
 * included, is a group of its own.
 */
export function contiguousRuns(segments: readonly Range[], L: number, topology: Topology): number[][] {
  const ring = topology === 'circular' && L > 0;
  const groups: number[][] = [];
  let total = 0;
  segments.forEach((seg, i) => {
    const len = seg.end - seg.start;
    const group = groups[groups.length - 1];
    const prev = group === undefined ? undefined : segments[group[group.length - 1]];
    const joins =
      prev !== undefined &&
      len > 0 &&
      prev.end > prev.start &&
      (ring ? mod(seg.start - prev.end, L) === 0 : seg.start === prev.end) &&
      (!ring || total + len <= L);
    if (joins) {
      (group as number[]).push(i);
      total += len;
    } else {
      groups.push([i]);
      total = len;
    }
  });
  return groups;
}

/** What the token model expects an edit to do to one feature. */
export interface ModelFeatureEdit {
  /** Surviving segments in order: the tokens of a non-empty segment, or the new gap of a site. */
  segments: Array<{ tokens: number[] } | { gap: number }>;
  /** True when the feature's bases change: some deleted, or inserted tokens added to it. */
  changed: boolean;
  /** Deleted bases before the first surviving base, walking the feature 5'->3'. */
  lost5: number;
  /** True when inserted tokens join the feature. */
  grew: boolean;
}

/**
 * Expected effect of an edit on a feature, base by base (independent of the arithmetic in
 * remap.ts): deleted bases are dropped from every segment and a segment without surviving bases
 * disappears; the inserted tokens are added only to a contiguous stretch (see
 * {@link contiguousRuns}) that holds the base just before the edited region, every deleted base
 * and the base just after it, consecutively; inside the stretch they go right after the base
 * before the region and belong to (i) the segment holding that whole window, else (ii) the segment
 * holding every deleted base and some other base, else (iii) on a circular molecule whose new
 * sequence starts with the inserted bases, the segment holding the base after the region, else
 * (iv) the segment holding the base before it. Sites follow {@link modelGap}.
 */
export function modelFeatureEdit(f: Feature, L: number, topology: Topology, edit: ModelEdit, layout: readonly number[]): ModelFeatureEdit {
  const ring = topology === 'circular';
  let a = edit.start;
  const d = edit.deleted;
  if (ring && d === 0 && a === 0) a = L;
  const deleted = new Set<number>();
  const deletedInOrder: number[] = [];
  for (let x = a; x < a + d; x++) {
    const p = ring ? mod(x, L) : x;
    deleted.add(p);
    deletedInOrder.push(p);
  }
  const hasBefore = ring ? L > 0 : a >= 1;
  const hasAfter = ring ? L > 0 : a + d < L;
  const window = hasBefore && hasAfter ? [ring ? mod(a - 1, L) : a - 1, ...deletedInOrder, ring ? mod(a + d, L) : a + d] : null;
  const insertedFirst = ring && L > 0 && (a === 0 || a + d > L); // see modelLayout
  const inserted = Array.from({ length: edit.inserted }, (_, j) => INSERTED_TOKEN + j);
  const segments: ModelFeatureEdit['segments'] = [];
  let changed = false;
  let grew = false;
  for (const group of contiguousRuns(f.segments, L, topology)) {
    const head = f.segments[group[0]];
    if (head.end === head.start) {
      const g = modelGap(head.start, L, topology, edit, layout);
      if (g !== null) segments.push({ gap: g });
      continue;
    }
    // the stretch's bases in traversal order, with the index (in `group`) of the segment holding each
    const flat: number[] = [];
    const owner: number[] = [];
    group.forEach((segIndex, k) => {
      for (const p of segmentPositions(f.segments[segIndex], L)) {
        flat.push(p);
        owner.push(k);
      }
    });
    let at = -1;
    if (window !== null) {
      for (let i = 0; i + window.length <= flat.length && at < 0; i++) {
        if (window.every((p, j) => flat[i + j] === p)) at = i;
      }
    }
    let absorber = -1;
    if (at >= 0) {
      const after = at + d + 1;
      const keepsSome = (k: number) => flat.some((p, i) => owner[i] === k && !deleted.has(p));
      if (owner[at] === owner[after]) absorber = owner[at];
      else if (d > 0 && owner[at + 1] === owner[at + d] && keepsSome(owner[at + 1])) absorber = owner[at + 1];
      else absorber = insertedFirst ? owner[after] : owner[at];
    }
    const tokens: number[][] = group.map(() => []);
    flat.forEach((p, i) => {
      if (!deleted.has(p)) tokens[owner[i]].push(p);
      if (i === at) tokens[absorber].push(...inserted);
    });
    if (at >= 0 && inserted.length > 0) grew = true;
    group.forEach((segIndex, k) => {
      const original = segmentPositions(f.segments[segIndex], L);
      if (!tokens[k].some((t) => t < INSERTED_TOKEN)) {
        changed = true; // every base deleted: the segment disappears
        return;
      }
      if (tokens[k].length !== original.length || tokens[k].some((t, j) => t !== original[j])) changed = true;
      segments.push({ tokens: tokens[k] });
    });
  }
  let lost5 = 0;
  for (const p of featurePositions(f, L)) {
    if (!deleted.has(p)) break;
    lost5++;
  }
  return { segments, changed, lost5, grew };
}

/**
 * Expected NEW gap of a zero-length segment at old gap `p` (null when it should disappear),
 * found by locating its neighbouring tokens in the new layout: a site at the start of the edited
 * region (or at an insertion gap) stays just after the base before it; a site at the end of the
 * deleted region goes just before the base after it; a site strictly inside the deleted region
 * disappears.
 */
export function modelGap(p: number, L: number, topology: Topology, edit: ModelEdit, layout: readonly number[]): number | null {
  const ring = topology === 'circular';
  const N = layout.length;
  if (ring && N === 0) return null;
  let a = edit.start;
  const d = edit.deleted;
  if (ring && d === 0 && a === 0) a = L;
  const q = ring ? mod(p, L) : p;
  const off = ring ? mod(q - a, L) : q - a;
  if (off > 0 && off < d) return null;
  const norm = (g: number) => (ring ? mod(g, N) : g);
  const indexOf = (token: number) => layout.indexOf(token);
  if (off === 0) {
    // just after the base before the gap
    if (ring && d === L) return 0;
    if (!ring && q === 0) return 0;
    return norm(indexOf(ring ? mod(q - 1, L) : q - 1) + 1);
  }
  // right boundary or outside: just before the base after the gap
  if (!ring && q === L) return N;
  return norm(indexOf(ring ? mod(q, L) : q));
}

// ---------------------------------------------------------------------------
// Qualifier model (independent of qualifiers.ts: moves every base one by one)
// ---------------------------------------------------------------------------

/** How an operation moves bases, base by base: the model's counterpart of BaseMap in qualifiers.ts. */
export interface ModelBaseMap {
  /** New index of old base `x`, or null when it no longer exists. */
  base: (x: number) => number | null;
  oldLength: number;
  oldCircular: boolean;
  newLength: number;
  newCircular: boolean;
  /** Reverse complement: base order reversed, '<' / '>' swapped, complement() toggled. */
  flip: boolean;
  /** Drop a location two of whose adjacent bases are no longer adjacent (base edits whose inserted bases join the feature). */
  dropIfSplit: boolean;
}

interface ModelPart {
  positions: number[];
  open: boolean;
  close: boolean;
  ranged: boolean;
}

/** An INSDC location of the forms the ops module rewrites, as written parts; null otherwise. */
function parseModelLocation(text: string, L: number): { complement: boolean; operator: string | null; parts: ModelPart[] } | null {
  let s = text.replace(/\s+/g, '');
  let complement = false;
  if (s.startsWith('complement(') && s.endsWith(')')) {
    complement = true;
    s = s.slice('complement('.length, -1);
  }
  let operator: string | null = null;
  const op = /^(join|order)\((.*)\)$/.exec(s);
  if (op !== null) {
    operator = op[1];
    s = op[2];
  }
  const parts: ModelPart[] = [];
  for (const piece of s.split(',')) {
    const m = /^(<)?(\d+)(\.\.(>)?(\d+))?$/.exec(piece);
    if (m === null) return null;
    const a = Number(m[2]) - 1;
    const b = m[5] === undefined ? a : Number(m[5]) - 1;
    if (a < 0 || b < a || b >= L) return null;
    const positions: number[] = [];
    for (let x = a; x <= b; x++) positions.push(x);
    parts.push({ positions, open: m[1] !== undefined, close: m[4] !== undefined, ranged: m[3] !== undefined });
  }
  return { complement, operator, parts };
}

/** True if base `y` follows base `x` on a molecule of `length` bases (across the origin of a circle). */
function adjacent(x: number, y: number, length: number, circular: boolean): boolean {
  return y === x + 1 || (circular && x === length - 1 && y === 0);
}

/**
 * Expected location text after `map` (the written-form rules of qualifiers.ts restated base by
 * base), null when the location is dropped, undefined when the text is not understood.
 */
function modelMoveLocation(text: string, map: ModelBaseMap, stranded: boolean, keep?: (positions: number[]) => boolean): string | null | undefined {
  const loc = parseModelLocation(text, map.oldLength);
  if (loc === null) return undefined;
  const bases: Array<{ pos: number; old: number; part: number; open: boolean; close: boolean; ranged: boolean }> = [];
  let prev: { old: number; pos: number } | null = null;
  for (const [k, part] of loc.parts.entries()) {
    for (let i = 0; i < part.positions.length; i++) {
      const x = part.positions[i];
      const y = map.base(x);
      if (y === null) return null; // a base of the location is gone
      if (map.dropIfSplit && prev !== null && adjacent(prev.old, x, map.oldLength, map.oldCircular)) {
        const still = map.flip ? adjacent(y, prev.pos, map.newLength, map.newCircular) : adjacent(prev.pos, y, map.newLength, map.newCircular);
        if (!still) return null; // bases were inserted between two adjacent bases
      }
      prev = { old: x, pos: y };
      const last = part.positions.length - 1;
      bases.push({ pos: y, old: x, part: k, open: i === 0 && part.open, close: i === last && part.close, ranged: part.ranged && last === 0 });
    }
  }
  if (map.flip) {
    bases.reverse();
    for (const b of bases) [b.open, b.close] = [b.close, b.open];
  }
  if (keep !== undefined && !keep(bases.map((b) => b.pos))) return null;
  const L = map.oldLength;
  const runs: Array<{ first: number; last: number; open: boolean; close: boolean; ranged: boolean }> = [];
  bases.forEach((b, i) => {
    const p = bases[i - 1];
    const run = runs[runs.length - 1];
    const halves = map.oldCircular && p !== undefined && ((p.old === L - 1 && b.old === 0) || (p.old === 0 && b.old === L - 1));
    if (run !== undefined && p !== undefined && b.pos === run.last + 1 && !run.close && !b.open && (b.part === p.part || halves)) {
      run.last = b.pos;
      run.close = b.close;
      run.ranged = false;
    } else {
      runs.push({ first: b.pos, last: b.pos, open: b.open, close: b.close, ranged: b.ranged });
    }
  });
  const parts = runs.map((r) => {
    const a = `${r.open ? '<' : ''}${r.first + 1}`;
    return r.first === r.last && !r.close && !r.ranged ? a : `${a}..${r.close ? '>' : ''}${r.last + 1}`;
  });
  const inner = parts.length > 1 ? `${loc.operator ?? 'join'}(${parts.join(',')})` : parts[0];
  return (stranded && map.flip ? !loc.complement : loc.complement) ? `complement(${inner})` : inner;
}

/**
 * Written parts [first, last] (0-based, in written order) of the location of a position-bearing
 * qualifier value, or null when it is not one the ops module rewrites.
 */
export function writtenParts(key: string, value: string, L: number): Array<{ first: number; last: number }> | null {
  let text = value;
  if (key === 'transl_except' || key === 'anticodon') {
    const m = /^\(pos:(.*?),aa:/.exec(value);
    if (m === null) return null;
    text = m[1];
  } else if (key !== 'rpt_unit_range' && key !== 'tag_peptide') {
    return null;
  }
  const loc = parseModelLocation(text, L);
  return loc === null ? null : loc.parts.map((p) => ({ first: p.positions[0], last: p.positions[p.positions.length - 1] }));
}

/** Expected value of one position-bearing qualifier (null: dropped); other values unchanged. */
export function modelPositionalValue(key: string, value: string, map: ModelBaseMap, keep?: (positions: number[]) => boolean): string | null {
  if (key === 'rpt_unit_range' || key === 'tag_peptide') {
    const loc = parseModelLocation(value, map.oldLength);
    if (loc === null || loc.complement) return value;
    const moved = modelMoveLocation(value, map, false, keep);
    return moved === undefined ? value : moved;
  }
  if (key !== 'transl_except' && key !== 'anticodon') return value;
  if (!value.startsWith('(pos:') || !value.endsWith(')')) return value;
  // the location ends at the first comma outside parentheses
  let depth = 0;
  let end = -1;
  for (let i = '(pos:'.length; i < value.length - 1 && end < 0; i++) {
    if (value[i] === '(') depth++;
    else if (value[i] === ')') depth--;
    else if (value[i] === ',' && depth === 0) end = i;
  }
  if (end < 0) return value;
  const moved = modelMoveLocation(value.slice('(pos:'.length, end), map, true, keep);
  if (moved === undefined) return value;
  return moved === null ? null : `(pos:${moved}${value.slice(end)}`;
}

/** Expected qualifiers after moving the position-bearing ones (dropped ones omitted). */
export function modelQualifiers(qualifiers: readonly Qualifier[], map: ModelBaseMap, keep?: (positions: number[]) => boolean): Qualifier[] {
  const out: Qualifier[] = [];
  for (const q of qualifiers) {
    const value = q.value !== null && POSITIONAL_KEYS.includes(q.key) ? modelPositionalValue(q.key, q.value, map, keep) : q.value;
    if (value !== null || q.value === null) out.push({ key: q.key, value });
  }
  return out;
}

/** `qualifiers` without /translation (expected when the feature's bases change). */
export function withoutTranslation(qualifiers: readonly Qualifier[]): Qualifier[] {
  return qualifiers.filter((q) => q.key !== 'translation');
}

/**
 * Expected /codon_start after `lost5` bases were removed from the feature's 5' end: the first
 * complete codon started c - 1 bases into the feature (c = /codon_start, 1 when a CDS has none),
 * so it now starts (c - 1 - lost5) mod 3 bases in. A missing one is appended to a CDS when the new
 * value is not 1; values other than 1, 2, 3 and other feature types are left alone.
 */
export function modelCodonStart(type: string, qualifiers: readonly Qualifier[], lost5: number): Qualifier[] {
  const out = qualifiers.map((q) => ({ key: q.key, value: q.value }));
  if (lost5 % 3 === 0) return out;
  const i = out.findIndex((q) => q.key === 'codon_start' && q.value !== null);
  const shifted = (c: number) => String(mod(c - 1 - lost5, 3) + 1);
  if (i < 0) return type === 'CDS' ? [...out, { key: 'codon_start', value: shifted(1) }] : out;
  const c = Number((out[i].value as string).trim());
  if (c !== 1 && c !== 2 && c !== 3) return out;
  return out.map((q) => (q.key === 'codon_start' && q.value !== null ? { key: q.key, value: shifted(c) } : q));
}

// ---------------------------------------------------------------------------
// Ligatable fragments
// ---------------------------------------------------------------------------

/**
 * Random fragments that ligate in order: consecutive parts share compatible overhangs (or are
 * blunt). With `closable`, the last part's right overhang is compatible with the first part's
 * left overhang. `featureOptions` are passed to {@link randomFeature}. Returns the parts and the
 * expected product sequence.
 */
export function ligatableParts(
  rng: Rng,
  closable: boolean,
  featureOptions: RandomFeatureOptions = {},
): { parts: SeqRecord[]; product: string; offsets: number[] } {
  const count = rng.int(1, 4);
  const overhang = () => (rng.bool(0.4) ? 0 : rng.int(1, 4));
  const kind = () => rng.pick(['5prime', '3prime'] as const);
  const junctions = Array.from({ length: count - 1 }, () => ({ n: overhang(), kind: kind() }));
  const closing = { n: closable ? overhang() : 0, kind: kind() };
  const parts: SeqRecord[] = [];
  let product = '';
  const offsets: number[] = [];
  for (let i = 0; i < count; i++) {
    const leftN = i === 0 ? closing.n : junctions[i - 1].n;
    const rightN = i === count - 1 ? closing.n : junctions[i].n;
    // the left overhang repeats the end of the product so far (the first part's is random)
    const shared = i === 0 ? randomBases(rng, leftN) : product.slice(product.length - leftN);
    let seq = shared + randomBases(rng, rng.int(rightN + 1, 60));
    // when closable, the last part ends with the first part's left overhang text
    if (i === count - 1 && closing.n > 0) seq += i === 0 ? shared : parts[0].seq.slice(0, closing.n);
    const L = seq.length;
    // feature ids collide between parts half of the time
    const prefix = rng.bool() ? 'f' : `p${i}_`;
    const features = Array.from({ length: rng.int(0, 4) }, (_, k) => randomFeature(rng, L, 'linear', `${prefix}${k}`, featureOptions));
    const part: SeqRecord = {
      id: `doc${i}`,
      name: `part${i}`,
      description: '',
      seq,
      topology: 'linear',
      molecule: 'DNA',
      features,
      primers: rng.bool() ? [{ id: 'p0', name: `primer of ${i % 2}`, sequence: 'ACGTACGTAC' }] : [],
      meta: { accession: `A${i}`, organism: 'synthetic construct' },
      ends: {
        left: leftN > 0 ? { kind: i === 0 ? closing.kind : junctions[i - 1].kind, length: leftN } : { kind: 'blunt', length: 0 },
        right: rightN > 0 ? { kind: i === count - 1 ? closing.kind : junctions[i].kind, length: rightN } : { kind: 'blunt', length: 0 },
      },
    };
    offsets.push(i === 0 ? 0 : product.length - leftN);
    product = i === 0 ? seq : product + seq.slice(leftN);
    parts.push(part);
  }
  return { parts, product, offsets };
}

// ---------------------------------------------------------------------------
// Oracle exchange format (tools/oracle/ops_oracle.py, ops_live.py)
// ---------------------------------------------------------------------------

/** A feature as written by the Python oracles: segments as [start, end] pairs. */
export interface OracleFeature {
  id: string;
  type: string;
  name: string;
  strand: Strand;
  segments: Array<[number, number]>;
  partialStart?: boolean;
  partialEnd?: boolean;
}

/** A record as written by the Python oracles. */
export interface OracleRecord {
  name: string;
  seq: string;
  topology: Topology;
  features: OracleFeature[];
  ends?: FragmentEnds;
}

/** What is compared for one feature (computed by an oracle or from our output). */
export interface FeatureView {
  id: string;
  strand: Strand;
  /** Runs [start, length] of covered positions in traversal order, contiguous runs merged. */
  path: number[][];
  /** Gaps of the zero-length segments. */
  sites: number[];
  partialStart: boolean;
  partialEnd: boolean;
  /** Extracted 5'->3' sequence (the oracles omit it for long features). */
  seq?: string;
}

/** Our SeqRecord for a record in the oracle exchange format (feature labels become /label qualifiers). */
export function fromOracleRecord(o: OracleRecord): SeqRecord {
  const rec: SeqRecord = {
    id: `doc_${o.name}`,
    name: o.name,
    description: '',
    seq: o.seq,
    topology: o.topology,
    molecule: 'DNA',
    features: o.features.map(
      (f): Feature => ({
        id: f.id,
        type: f.type,
        name: f.name,
        strand: f.strand,
        segments: f.segments.map(([start, end]) => ({ start, end })),
        qualifiers: [{ key: 'label', value: f.name }],
        ...(f.partialStart ? { partialStart: true } : {}),
        ...(f.partialEnd ? { partialEnd: true } : {}),
      }),
    ),
    primers: [],
    meta: {},
  };
  if (o.ends !== undefined) rec.ends = o.ends;
  return rec;
}

/** A record in the oracle exchange format (segments as [start, end] pairs, same coordinates). */
export function toOracleRecord(rec: SeqRecord): OracleRecord {
  const out: OracleRecord = {
    name: rec.name,
    seq: rec.seq,
    topology: rec.topology,
    features: rec.features.map((f) => ({
      id: f.id,
      type: f.type,
      name: f.name,
      strand: f.strand,
      segments: f.segments.map((s): [number, number] => [s.start, s.end]),
      partialStart: f.partialStart ?? false,
      partialEnd: f.partialEnd ?? false,
    })),
  };
  if (rec.ends !== undefined) out.ends = rec.ends;
  return out;
}

/** Runs [start, length] of the positions covered by `segments`, in order, contiguous runs merged. */
export function canonicalPath(segments: readonly Range[], L: number, circular: boolean): number[][] {
  const runs: number[][] = [];
  for (const s of segments) {
    if (s.end === s.start) continue;
    const start = circular && L > 0 ? s.start % L : s.start;
    const last = runs[runs.length - 1];
    if (last !== undefined) {
      const next = circular && L > 0 ? (last[0] + last[1]) % L : last[0] + last[1];
      if (next === start) {
        last[1] += s.end - s.start;
        continue;
      }
    }
    runs.push([start, s.end - s.start]);
  }
  return runs;
}

/** The comparable view of one of our features (`id` overrides the reported id). */
export function featureView(f: Feature, rec: SeqRecord, id = f.id): FeatureView {
  const L = rec.seq.length;
  const circular = rec.topology === 'circular';
  return {
    id,
    strand: f.strand,
    path: canonicalPath(f.segments, L, circular),
    sites: f.segments.filter((s) => s.end === s.start).map((s) => (circular && L > 0 ? s.start % L : s.start)),
    partialStart: f.partialStart ?? false,
    partialEnd: f.partialEnd ?? false,
    seq: featureSequence(f, rec.seq),
  };
}
