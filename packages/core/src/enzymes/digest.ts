/**
 * Restriction digests: cleave a linear or circular double-stranded molecule with one or more
 * enzymes and return the fragments with their single-stranded ends.
 *
 * MODEL (complete digest):
 *  - EVENTS. Every occurrence of a recognition site (see `search.ts`) gives one cleavage event per
 *    cut pair of the enzyme: the top strand is cut at gap position `top`, the bottom strand at
 *    `bottom` (top-strand coordinates). The bases between the two cuts,
 *    [min(top, bottom), max(top, bottom)), become single-stranded: the event's "cut zone".
 *  - 1. CAN THE EVENT CUT? Decided for every recognition site separately.
 *    Linear molecules: only if its cut zone lies inside the double-stranded part of the molecule
 *    with at least one base pair to spare on each side AND its recognition site is fully
 *    double-stranded; otherwise it is skipped with reason 'end'. With blunt ends this is
 *    Biopython's rule: both cuts in [1, L - 1].
 *    Circular molecules: an event whose overhang would be as long as the molecule is skipped
 *    (reason 'overhang-too-long').
 *  - 2. BREAKS. The remaining events that make the same double-strand break (same top and bottom:
 *    BamHI + MboI on GGATCC, BsaI + BsmAI, twin Type IIS sites) are one break, made once. Its
 *    `DigestCut.enzyme` is the name that sorts first (code-unit order) among those enzymes.
 *  - 3. CONFLICTS. A fragment runs from one applied break to the next and exists as a duplex only
 *    if at least one base pair lies between their cut zones. Breaks whose cut zones leave no base
 *    pair between them (overlapping or touching zones: nearby Type IIS sites, overlapping
 *    degenerate sites, a cut inside another enzyme's overhang) conflict: once one is made, the
 *    other would have to cleave single-stranded DNA. In a real digest the products depend on
 *    which cut happens first on each molecule (usually a mixture); the simulation resolves each
 *    group of breaks connected by conflicts with a fixed RULE:
 *      The group is walked 5'->3' along one strand. The first break in walking order (smallest
 *      zone start, then zone end, then enzyme name, then 5' before 3' overhang) is applied, and
 *      every later break that conflicts with the last applied one is skipped (reason 'conflict',
 *      `blockedBy` = that applied break). The strand is taken from the molecule, not from how it
 *      is written: it is the strand whose sequence, read 5'->3' from the centre of the group's
 *      span (top strand rightwards, bottom strand leftwards), comes first in code-unit order
 *      (upper case; the end of a linear molecule sorts before any base, and two ends compare by
 *      kind and length). When the conflicting zones cover a whole circle, the walk starts at the
 *      lexicographically smallest rotation of either strand, runs once around along that strand,
 *      and a break is also skipped when it conflicts with the first applied one (end of the lap);
 *      applied breaks are never withdrawn, so `blockedBy` always names an applied break.
 *    Consequently the result does not depend on the origin of a circle, on the strand the molecule
 *    is written on or on the order of `enzymes` (when the molecule is symmetric under such a
 *    change, both choices give the same fragments up to that symmetry), and there are never
 *    negative-length or unpaired fragments.
 *  - Recognition sites are taken from the intact molecule: a cut inside another enzyme's
 *    recognition sequence does not stop that enzyme unless their cut zones conflict.
 *  - Fragments keep the case of the input sequence. Methyl-directed enzymes (DpnI, ...) are
 *    simulated as if every site were methylated; methylation-blocked sites are not modelled.
 *
 * Fragment coordinates follow `types.ts`: `seq` is the full duplex extent in top-strand
 * orientation (overhang bases written as their top-strand equivalent), `ends` uses the
 * FragmentEnds convention, `parentRange` is that extent in parent coordinates (circular:
 * normalized start in [0, L), end may exceed L; for a circle cut only once the fragment is
 * L + overhang bases long, so the range is longer than the circle). For every fragment
 * `sliceRange(parent, parentRange) === seq`.
 */
import type { DnaEnd, EndKind, FragmentEnds, Range, Topology } from '../types';
import { complementBase } from '../seq/alphabet';
import { mod, sliceRange } from '../seq/range';
import type { RestrictionEnzyme } from './enzyme';
import { scanEnzymeSites } from './search';

/** A cleavage event at a fragment end, in parent coordinates (gap positions, top-strand coordinates). */
export interface DigestCut {
  /** Enzyme making the break (the name that sorts first when several enzymes make the same break). */
  enzyme: string;
  /** Top-strand cut: circular parents [0, L), linear parents [1, L - 1]. */
  top: number;
  /** Bottom-strand cut in top-strand coordinates, same normalization. */
  bottom: number;
}

/** One product of a digest. */
export interface DigestFragment {
  /** Full duplex extent, top-strand orientation, including single-stranded overhang bases. */
  seq: string;
  /** 'linear' for every product of a cut; 'circular' only for an uncut circular molecule. */
  topology: Topology;
  /** Single-stranded ends (FragmentEnds convention). Blunt/blunt for an uncut circle. */
  ends: FragmentEnds;
  /** Extent of `seq` in parent top-strand coordinates (may wrap the origin on circular parents). */
  parentRange: Range;
  /** seq.length, in bases (includes overhangs). */
  length: number;
  /** Cleavage event at the left end; absent when the left end is the original end of a linear parent. */
  leftCut?: DigestCut;
  /** Cleavage event at the right end; absent when the right end is the original end of a linear parent. */
  rightCut?: DigestCut;
}

/** Options of {@link digest}. */
export interface DigestOptions {
  /**
   * Single-stranded ends of a LINEAR input molecule, FragmentEnds convention (default: both
   * blunt; an overhang of length 0 is treated as blunt). They must leave at least one base pair.
   * Ignored for circular molecules.
   */
  ends?: FragmentEnds;
}

/**
 * Why a cleavage event found by the site search was not applied:
 *  - 'end' (linear molecules): its cut zone does not lie inside the double-stranded part of the
 *    molecule with at least one base pair to spare on each side, or its recognition site is not
 *    fully double-stranded. Decided for each recognition site: another site making the same
 *    break may still cut.
 *  - 'conflict': its cut zone leaves no base pair between it and an applied break (`blockedBy`).
 *    Which of two conflicting cuts a real digest makes depends on which happens first; the
 *    digest applies the one chosen by the conflict rule (see the file comment of digest.ts).
 *  - 'overhang-too-long' (circular molecules): its overhang would be as long as the molecule.
 */
export type SkipReason = 'end' | 'conflict' | 'overhang-too-long';

/** A cleavage event (one recognition site, one cut pair) that the digest did not apply. */
export interface SkippedCleavage {
  enzyme: string;
  /** Recognition footprint (may wrap the origin on circular parents). */
  site: Range;
  strand: 1 | -1;
  /** Cut positions in parent top-strand coordinates (circular: [0, L); linear: may lie outside [0, L]). */
  top: number;
  bottom: number;
  reason: SkipReason;
  /** Human-readable explanation (1-based positions for display). */
  message: string;
  /** For reason 'conflict': the applied break that prevents this one. */
  blockedBy?: DigestCut;
}

/** Result of {@link digestDetailed}. */
export interface DigestReport {
  /** Fragments in parent order (see {@link digest}). */
  fragments: DigestFragment[];
  /**
   * Cleavage events found by the site search but not applied, one entry per recognition site and
   * cut pair, sorted by top cut, bottom cut, enzyme name, site start and strand (1 first).
   * An event whose break is made is not listed, even when another site or enzyme is credited
   * with it, unless the event could not cut by itself (reason 'end'): e.g. a BsaI site that
   * straddles a single-stranded end is listed while the BsmAI site inside it makes the same break.
   */
  skipped: SkippedCleavage[];
}

const BLUNT: DnaEnd = Object.freeze({ kind: 'blunt', length: 0 });
const BLUNT_ENDS: FragmentEnds = Object.freeze({ left: BLUNT, right: BLUNT });

/** A cleavage event of one recognition site with unwrapped positions; [lo, hi] is its cut zone. */
interface Cleavage {
  enzyme: string;
  /** Footprint start as found by the site search, in [0, L). */
  siteStart: number;
  siteSize: number;
  strand: 1 | -1;
  /** Cut positions; on circular molecules shifted together so that lo is in [0, L). */
  top: number;
  bottom: number;
  lo: number;
  hi: number;
}

/**
 * A double-strand break made by one or more cleavage events with identical top and bottom cuts:
 * `events[from]` .. `events[to - 1]` of the shared, sorted event list (the first one is the
 * representative, whose enzyme name sorts first).
 */
interface Break {
  top: number;
  bottom: number;
  lo: number;
  hi: number;
  enzyme: string;
  from: number;
  to: number;
}

/** A break as seen by the conflict walk: coordinates possibly shifted by L or mirrored. */
interface WalkNode {
  lo: number;
  hi: number;
  top: number;
  enzyme: string;
  brk: Break;
}

/** Shared state of one digest's conflict resolution. */
interface Resolution {
  readonly seq: string;
  readonly L: number;
  readonly circular: boolean;
  /** Linear molecules: the input ends (they take part in the choice of the walking strand). */
  readonly ends: FragmentEnds;
  /** Events that can cut, sorted by {@link compareEvents}; breaks index into this list. */
  readonly events: readonly Cleavage[];
  readonly skipped: SkippedCleavage[];
}

/** Fragment boundary: a break or an original end of a linear molecule. */
interface Boundary {
  top: number;
  bottom: number;
  cut?: DigestCut;
}

function byName(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Groups identical breaks (same lo, hi, top) together, enzyme name first within a break. */
function compareEvents(a: Cleavage, b: Cleavage): number {
  return a.lo - b.lo || a.hi - b.hi || a.top - b.top || byName(a.enzyme, b.enzyme) || a.siteStart - b.siteStart || b.strand - a.strand;
}

/** Walking order of the conflict rule: zone start, zone end, enzyme name, then 5' overhang (top = lo) first. */
function compareNodes(a: WalkNode, b: WalkNode): number {
  return a.lo - b.lo || a.hi - b.hi || byName(a.enzyme, b.enzyme) || a.top - b.top;
}

function compareSkipped(a: SkippedCleavage, b: SkippedCleavage): number {
  return a.top - b.top || a.bottom - b.bottom || byName(a.enzyme, b.enzyme) || a.site.start - b.site.start || b.strand - a.strand;
}

/** The end left by a boundary (same rule on both sides: top < bottom means a 5' overhang). */
function endOf(boundary: Boundary): DnaEnd {
  const d = boundary.bottom - boundary.top;
  if (d === 0) return { kind: 'blunt', length: 0 };
  return { kind: d > 0 ? '5prime' : '3prime', length: Math.abs(d) };
}

/** Boundary equivalent to an original end of a linear molecule of length L. */
function endBoundary(end: DnaEnd, side: 'left' | 'right', L: number): Boundary {
  const n = end.kind === 'blunt' ? 0 : end.length;
  if (side === 'left') {
    return end.kind === '3prime' ? { top: n, bottom: 0 } : { top: 0, bottom: n };
  }
  return end.kind === '3prime' ? { top: L, bottom: L - n } : { top: L - n, bottom: L };
}

const END_KINDS: readonly EndKind[] = ['blunt', '5prime', '3prime'];

/** Throws unless `ends` are valid single-stranded ends of a linear duplex of length L >= 1. */
function checkEnds(ends: FragmentEnds, L: number): void {
  for (const end of [ends.left, ends.right]) {
    if (!END_KINDS.includes(end.kind)) throw new Error(`Invalid end kind '${String(end.kind)}'`);
    if (!Number.isInteger(end.length) || end.length < 0) throw new Error(`Invalid end length ${end.length}`);
    if (end.kind === 'blunt' && end.length !== 0) throw new Error('A blunt end must have length 0');
  }
  const single = ends.left.length + ends.right.length;
  if (single > L) {
    throw new Error(`Single-stranded ends (${ends.left.length} + ${ends.right.length}) are longer than the molecule (${L})`);
  }
  if (single === L) {
    throw new Error(`Single-stranded ends (${ends.left.length} + ${ends.right.length}) leave no base pair in a molecule of ${L} bases`);
  }
}

function toCut(c: { enzyme: string; top: number; bottom: number }, L: number, circular: boolean): DigestCut {
  return {
    enzyme: c.enzyme,
    top: circular ? mod(c.top, L) : c.top,
    bottom: circular ? mod(c.bottom, L) : c.bottom,
  };
}

/** 1-based display position of an event's recognition site. */
function sitePosition(c: Cleavage, L: number, circular: boolean): number {
  return (circular ? mod(c.siteStart, L) : c.siteStart) + 1;
}

function skip(c: Cleavage, L: number, circular: boolean, reason: SkipReason, message: string, blockedBy?: DigestCut): SkippedCleavage {
  const cut = toCut(c, L, circular);
  const start = circular ? mod(c.siteStart, L) : c.siteStart;
  return {
    enzyme: c.enzyme,
    site: { start, end: start + c.siteSize },
    strand: c.strand,
    top: cut.top,
    bottom: cut.bottom,
    reason,
    message,
    ...(blockedBy !== undefined ? { blockedBy } : {}),
  };
}

/** Every cleavage event of every site, unwrapped so that circular cut zones start in [0, L); sorted by {@link compareEvents}. */
function collectCleavages(seq: string, topology: Topology, enzymes: readonly RestrictionEnzyme[]): Cleavage[] {
  const L = seq.length;
  const circular = topology === 'circular';
  const events: Cleavage[] = [];
  scanEnzymeSites(seq, topology, enzymes, (enzyme, pattern, start) => {
    for (const c of pattern.cuts) {
      let top = start + c.top;
      let bottom = start + c.bottom;
      if (circular) {
        const lo = Math.min(top, bottom);
        const shift = mod(lo, L) - lo;
        top += shift;
        bottom += shift;
      }
      events.push({
        enzyme: enzyme.name,
        siteStart: start,
        siteSize: enzyme.size,
        strand: pattern.strand,
        top,
        bottom,
        lo: Math.min(top, bottom),
        hi: Math.max(top, bottom),
      });
    }
  });
  return events.sort(compareEvents);
}

/** One break per distinct (top, bottom) of `events` (sorted by {@link compareEvents}), in that order. */
function mergeBreaks(events: readonly Cleavage[]): Break[] {
  const breaks: Break[] = [];
  for (let i = 0; i < events.length; ) {
    const e = events[i];
    let j = i + 1;
    while (j < events.length && events[j].top === e.top && events[j].bottom === e.bottom) j++;
    breaks.push({ top: e.top, bottom: e.bottom, lo: e.lo, hi: e.hi, enzyme: e.enzyme, from: i, to: j });
    i = j;
  }
  return breaks;
}

// ---------------------------------------------------------------------------
// Conflict resolution (see RULE in the file comment)
// ---------------------------------------------------------------------------

/** Complement of each upper-case ASCII character code (IUPAC aware; others map to themselves). */
const COMPLEMENT_CODES: Uint16Array = (() => {
  const t = new Uint16Array(128);
  for (let c = 0; c < 128; c++) t[c] = complementBase(String.fromCharCode(c)).charCodeAt(0);
  return t;
})();

/** Upper-case code of `seq[i]`, positions taken modulo L (circular molecules). */
function circularCode(seq: string, i: number): number {
  const c = seq.charCodeAt(mod(i, seq.length));
  return c >= 97 && c <= 122 ? c - 32 : c;
}

/** Code of the bottom-strand base paired with `seq[i]` (upper case, positions modulo L). */
function circularComplementCode(seq: string, i: number): number {
  const c = circularCode(seq, i);
  return c < 128 ? COMPLEMENT_CODES[c] : c;
}

/**
 * Negative code standing for the end of a linear molecule in a strand reading: it sorts before
 * every base, and identical ends (kind and length, which a reverse complement preserves) give
 * identical codes.
 */
function endCode(end: DnaEnd): number {
  const length = end.kind === 'blunt' ? 0 : end.length;
  return -1 - (END_KINDS.indexOf(length === 0 ? 'blunt' : end.kind) + 3 * length);
}

/**
 * Strand along which a group of conflicting breaks spanning the gap positions [start, end] is
 * walked: 1 = top strand (left to right), -1 = bottom strand (right to left). Compares the top
 * strand read rightwards from the centre of the span with the bottom strand read 5'->3'
 * (leftwards) from the centre, up to the end of a linear molecule (which then counts as one
 * more symbol, see {@link endCode}) or once around a circle. The smaller reading wins; a tie
 * (the molecule, ends included, is symmetric about the centre) gives 1. Writing the molecule as
 * its reverse complement swaps the two readings, hence gives the opposite answer.
 */
function walkDirection(r: Resolution, start: number, end: number): 1 | -1 {
  const { seq, L, circular } = r;
  const twice = start + end;
  const right = Math.floor(twice / 2); // first top-strand base read (the middle base when twice is odd)
  const left = twice % 2 === 0 ? right - 1 : right; // first bottom-strand base read
  const steps = circular ? L : Math.max(L - right, left + 1) + 1;
  for (let k = 0; k < steps; k++) {
    let top: number;
    let bottom: number;
    if (circular) {
      top = circularCode(seq, right + k);
      bottom = circularComplementCode(seq, left - k);
    } else {
      const i = right + k;
      const j = left - k;
      top = i < L ? circularCode(seq, i) : i === L ? endCode(r.ends.right) : Number.NEGATIVE_INFINITY;
      bottom = j >= 0 ? circularComplementCode(seq, j) : j === -1 ? endCode(r.ends.left) : Number.NEGATIVE_INFINITY;
      if (top === Number.NEGATIVE_INFINITY && bottom === Number.NEGATIVE_INFINITY) break;
    }
    if (top !== bottom) return top < bottom ? 1 : -1;
  }
  return 1;
}

/** Records every event of `brk` as skipped because the applied break `blocker` conflicts with it. */
function reportConflict(r: Resolution, brk: Break, blocker: Break): void {
  const by = r.events[blocker.from];
  const blockedBy = toCut(blocker, r.L, r.circular);
  for (let i = brk.from; i < brk.to; i++) {
    const e = r.events[i];
    const message =
      `${e.enzyme} (site at ${sitePosition(e, r.L, r.circular)}) cannot cut: its cut zone leaves no base pair between it ` +
      `and the ${blocker.enzyme} cut (site at ${sitePosition(by, r.L, r.circular)}), which is applied instead ` +
      '(in a real digest either cut may happen first)';
    r.skipped.push(skip(e, r.L, r.circular, 'conflict', message, blockedBy));
  }
}

/**
 * Greedy walk over nodes in walking order (sorted by {@link compareNodes}): a node is applied
 * unless it conflicts with an applied one, i.e. the last applied node or, when the walk goes once
 * around a circle of length `lap`, the first applied node seen again one lap later. Applied nodes
 * are never withdrawn, so every skipped node is blocked by a node that stays applied.
 */
function greedyWalk(r: Resolution, nodes: readonly WalkNode[], lap?: number): WalkNode[] {
  const kept: WalkNode[] = [];
  for (const node of nodes) {
    const last = kept[kept.length - 1];
    if (last === undefined) kept.push(node);
    else if (node.lo <= last.hi) reportConflict(r, node.brk, last.brk);
    else if (lap !== undefined && node.hi >= kept[0].lo + lap) reportConflict(r, node.brk, kept[0].brk);
    else kept.push(node);
  }
  return kept;
}

function nodeOf(brk: Break): WalkNode {
  return { lo: brk.lo, hi: brk.hi, top: brk.top, enzyme: brk.enzyme, brk };
}

function shifted(node: WalkNode, by: number): WalkNode {
  return { ...node, lo: node.lo + by, hi: node.hi + by, top: node.top + by };
}

/**
 * Node in the coordinates of the reverse-complemented molecule (gap g -> L - g), so that walking
 * left to right there walks the original bottom strand 5'->3'.
 */
function mirrored(node: WalkNode, L: number): WalkNode {
  const bottom = node.lo + node.hi - node.top;
  return { lo: L - node.hi, hi: L - node.lo, top: L - bottom, enzyme: node.enzyme, brk: node.brk };
}

/** Resolves one group of breaks connected by conflicts (nodes sorted by position); returns the applied breaks. */
function resolveGroup(r: Resolution, group: readonly WalkNode[]): Break[] {
  if (group.length === 1) return [group[0].brk];
  const start = group[0].lo;
  const end = group.reduce((m, n) => Math.max(m, n.hi), -Infinity);
  const direction = walkDirection(r, start, end);
  const nodes = direction === 1 ? [...group] : group.map((n) => mirrored(n, r.L));
  return greedyWalk(r, nodes.sort(compareNodes)).map((n) => n.brk);
}

/** Splits nodes sorted by zone start into maximal groups of breaks connected by conflicts. */
function conflictGroups(nodes: readonly WalkNode[]): WalkNode[][] {
  const groups: WalkNode[][] = [];
  let reach = -Infinity; // largest zone end of the current group
  for (const node of nodes) {
    if (groups.length > 0 && node.lo <= reach) {
      groups[groups.length - 1].push(node);
      reach = Math.max(reach, node.hi);
    } else {
      groups.push([node]);
      reach = node.hi;
    }
  }
  return groups;
}

/**
 * Index of a break where a walk around the circle can start: one whose zone start is not covered
 * by any other break's (closed) cut zone. -1 when the zones cover the whole circle.
 * `breaks` are sorted by zone start in [0, L).
 */
function freeStartIndex(breaks: readonly Break[], L: number): number {
  const m = breaks.length;
  let reach = -Infinity;
  for (let k = 0; k < 2 * m; k++) {
    const b = breaks[k % m];
    const offset = k >= m ? L : 0;
    if (k >= m && b.lo + offset > reach) return k - m;
    reach = Math.max(reach, b.hi + offset);
  }
  return -1;
}

/** Start index of the lexicographically least rotation of `s` (smallest such index), O(n). */
function leastRotation(s: Uint16Array): number {
  const n = s.length;
  let i = 0;
  let j = 1;
  let k = 0;
  while (i < n && j < n && k < n) {
    const a = s[(i + k) % n];
    const b = s[(j + k) % n];
    if (a === b) {
      k++;
      continue;
    }
    if (a > b) i += k + 1;
    else j += k + 1;
    if (i === j) j++;
    k = 0;
  }
  return Math.min(i, j);
}

function compareRotations(a: Uint16Array, ia: number, b: Uint16Array, ib: number): number {
  const n = a.length;
  for (let k = 0; k < n; k++) {
    const d = a[(ia + k) % n] - b[(ib + k) % n];
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Conflict resolution when the cut zones cover the whole circle (no free starting point): walk
 * once around the circle along the strand with the lexicographically smallest rotation, starting
 * at that rotation's first base. Returns the applied breaks.
 */
function resolveWholeCircle(r: Resolution, breaks: readonly Break[]): Break[] {
  const { seq, L } = r;
  const top = new Uint16Array(L);
  const bottom = new Uint16Array(L);
  for (let i = 0; i < L; i++) {
    top[i] = circularCode(seq, i);
    bottom[L - 1 - i] = circularComplementCode(seq, i);
  }
  const i = leastRotation(top);
  const j = leastRotation(bottom);
  const alongTop = compareRotations(top, i, bottom, j) <= 0;
  const startGap = alongTop ? i : j;
  const nodes = breaks
    .map((b) => {
      if (alongTop) return nodeOf(b);
      const m = mirrored(nodeOf(b), L);
      return shifted(m, mod(m.lo, L) - m.lo);
    })
    .sort(compareNodes);
  let first = nodes.findIndex((n) => n.lo >= startGap);
  if (first < 0) first = 0;
  const walk = nodes.map((_, x) => (first + x < nodes.length ? nodes[first + x] : shifted(nodes[first + x - nodes.length], L)));
  // the walk goes once around: a break must also leave a base pair before the first applied one
  return greedyWalk(r, walk, L).map((n) => n.brk);
}

// ---------------------------------------------------------------------------
// Fragments
// ---------------------------------------------------------------------------

function makeFragment(parent: string, range: Range, left: Boundary, right: Boundary): DigestFragment {
  const seq = sliceRange(parent, range);
  return {
    seq,
    topology: 'linear',
    ends: { left: endOf(left), right: endOf(right) },
    parentRange: range,
    length: seq.length,
    ...(left.cut !== undefined ? { leftCut: left.cut } : {}),
    ...(right.cut !== undefined ? { rightCut: right.cut } : {}),
  };
}

function digestLinear(seq: string, events: readonly Cleavage[], ends: FragmentEnds): DigestReport {
  const L = seq.length;
  checkEnds(ends, L);
  const left = endBoundary(ends.left, 'left', L);
  const right = endBoundary(ends.right, 'right', L);
  const dsStart = Math.max(left.top, left.bottom);
  const dsEnd = Math.min(right.top, right.bottom);
  const skipped: SkippedCleavage[] = [];
  const applicable: Cleavage[] = [];
  for (const e of events) {
    if (e.lo <= dsStart || e.hi >= dsEnd) {
      skipped.push(
        skip(e, L, false, 'end', `${e.enzyme} (site at ${e.siteStart + 1}) cannot cut: its cut (top ${e.top}, bottom ${e.bottom}) is not inside the double-stranded part of the molecule`),
      );
    } else if (e.siteStart < dsStart || e.siteStart + e.siteSize > dsEnd) {
      skipped.push(skip(e, L, false, 'end', `${e.enzyme} (site at ${e.siteStart + 1}) cannot cut: its recognition site is not fully double-stranded`));
    } else {
      applicable.push(e);
    }
  }
  const r: Resolution = { seq, L, circular: false, ends, events: applicable, skipped };
  const kept = conflictGroups(mergeBreaks(applicable).map(nodeOf))
    .flatMap((group) => resolveGroup(r, group))
    .sort((a, b) => a.lo - b.lo);
  const boundaries: Boundary[] = [left, ...kept.map((b) => ({ top: b.top, bottom: b.bottom, cut: toCut(b, L, false) })), right];
  const fragments: DigestFragment[] = [];
  for (let i = 0; i + 1 < boundaries.length; i++) {
    const a = boundaries[i];
    const b = boundaries[i + 1];
    const range = { start: Math.min(a.top, a.bottom), end: Math.max(b.top, b.bottom) };
    fragments.push(makeFragment(seq, range, a, b));
  }
  return { fragments, skipped: skipped.sort(compareSkipped) };
}

function digestCircular(seq: string, events: readonly Cleavage[]): DigestReport {
  const L = seq.length;
  const skipped: SkippedCleavage[] = [];
  const applicable: Cleavage[] = [];
  for (const e of events) {
    if (e.hi - e.lo >= L) {
      skipped.push(skip(e, L, true, 'overhang-too-long', `${e.enzyme} (site at ${mod(e.siteStart, L) + 1}) cannot cut: its overhang would be as long as the molecule`));
    } else {
      applicable.push(e);
    }
  }
  const breaks = mergeBreaks(applicable);
  if (breaks.length === 0) {
    const whole: DigestFragment = {
      seq,
      topology: 'circular',
      ends: { left: BLUNT, right: BLUNT },
      parentRange: { start: 0, end: L },
      length: L,
    };
    return { fragments: [whole], skipped: skipped.sort(compareSkipped) };
  }
  const r: Resolution = { seq, L, circular: true, ends: BLUNT_ENDS, events: applicable, skipped };
  const first = freeStartIndex(breaks, L);
  let kept: Break[];
  if (first >= 0) {
    // walk once around the circle from a point that no cut zone covers: no group crosses it
    const walk = breaks.map((_, i) => (first + i < breaks.length ? nodeOf(breaks[first + i]) : shifted(nodeOf(breaks[first + i - breaks.length]), L)));
    kept = conflictGroups(walk).flatMap((group) => resolveGroup(r, group));
  } else {
    kept = resolveWholeCircle(r, breaks);
  }
  kept.sort((a, b) => a.lo - b.lo);
  const boundaries: Boundary[] = kept.map((b) => ({ top: b.top, bottom: b.bottom, cut: toCut(b, L, true) }));
  const fragments: DigestFragment[] = [];
  for (let i = 0; i < kept.length; i++) {
    const a = kept[i];
    const nextHi = i + 1 < kept.length ? kept[i + 1].hi : kept[0].hi + L;
    const start = mod(a.lo, L);
    const range = { start, end: start + (nextHi - a.lo) };
    fragments.push(makeFragment(seq, range, boundaries[i], boundaries[(i + 1) % kept.length]));
  }
  fragments.sort((x, y) => x.parentRange.start - y.parentRange.start);
  return { fragments, skipped: skipped.sort(compareSkipped) };
}

/**
 * Digest `seq` with `enzymes` and report the cleavage events that could not be applied.
 * See the file comment for the model, the conflict rule and the coordinate conventions. An empty
 * sequence yields no fragments. Throws if an enzyme definition or `options.ends` is invalid
 * (including ends that would leave no base pair).
 */
export function digestDetailed(
  seq: string,
  topology: Topology,
  enzymes: readonly RestrictionEnzyme[],
  options?: DigestOptions,
): DigestReport {
  if (seq.length === 0) {
    collectCleavages(seq, topology, enzymes); // still validates the enzymes
    return { fragments: [], skipped: [] };
  }
  const events = collectCleavages(seq, topology, enzymes);
  return topology === 'circular' ? digestCircular(seq, events) : digestLinear(seq, events, options?.ends ?? BLUNT_ENDS);
}

/**
 * Fragments produced by digesting `seq` with all `enzymes` at once, in parent order (ascending
 * parentRange.start; on a circle the fragment that spans the origin comes last).
 * Circular with n >= 1 applied breaks: n linear fragments. Circular without cuts: the intact
 * circular molecule. Linear with n applied breaks: n + 1 fragments, the outermost keeping the
 * input ends (`options.ends`, default blunt). Conflicting events are resolved as described in the
 * file comment; use {@link digestDetailed} to learn which events were skipped.
 */
export function digest(
  seq: string,
  topology: Topology,
  enzymes: readonly RestrictionEnzyme[],
  options?: DigestOptions,
): DigestFragment[] {
  return digestDetailed(seq, topology, enzymes, options).fragments;
}

/** Fragment lengths in bases (full duplex extents, i.e. {@link DigestFragment.length}), largest first, for gel lanes. */
export function digestSizes(
  seq: string,
  topology: Topology,
  enzymes: readonly RestrictionEnzyme[],
  options?: DigestOptions,
): number[] {
  return digest(seq, topology, enzymes, options)
    .map((f) => f.length)
    .sort((a, b) => b - a);
}
