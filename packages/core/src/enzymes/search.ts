/**
 * Restriction site search on both strands of linear and circular molecules.
 *
 * Conventions (see `types.ts`):
 *  - Site footprints are half-open 0-based ranges on the top strand. On circular molecules a site
 *    crossing the origin has `range.end > L` (e.g. { start: L - 2, end: L + 4 }).
 *  - Cut positions are GAP positions in top-strand coordinates: circular -> normalized into [0, L)
 *    (never -0); linear -> a cleavage event is reported only when it can cut the molecule, by the
 *    rule `digest` applies (see `ends.ts`). With blunt ends (the default) that is Biopython's rule
 *    (Bio.Restriction AbstractCut._drop): BOTH its top and bottom cut lie in [1, L - 1]; a cut
 *    exactly at an end (gap 0 or L) or beyond it does not cleave anything. With sticky ends
 *    (`options.ends`, e.g. a record's `ends`) the cut zone must also leave a base pair inside the
 *    double-stranded part on each side, and the recognition site must be fully double-stranded.
 *    An event that cannot cut is omitted from `site.cuts` while the site itself is still listed.
 *  - Palindromic sites are reported once, with strand 1. A non-palindromic site found as the
 *    reverse complement of the recognition sequence gets strand -1 and mirrored cut offsets: for
 *    a footprint starting at p with site length n, top = p + n - cut.bottom, bottom = p + n - cut.top.
 *    If a target position matches the site in both orientations (possible for degenerate
 *    non-palindromic sites such as MspJI CNNR), both occurrences are reported.
 *  - Palindromic sites whose catalogue cleavage is asymmetric (SgeI, HauII) are recognised in
 *    both orientations, so their sites carry the cuts of both readings (Biopython only applies
 *    the forward reading).
 *  - Degenerate IUPAC recognition sequences are supported. In the TARGET, only A/C/G/T (any case)
 *    can match: a site is found only where every target base is unambiguous and accepted by the
 *    site, so N or other ambiguity codes (and gaps, digits, ...) never match, even under an N of
 *    the site. (Biopython's regular expressions accept any target letter under a site N.)
 *  - Overlapping occurrences are all reported. Circular molecules shorter than a recognition
 *    sequence are not searched for that enzyme.
 */
import type { CutPair, EnzymeSite, FragmentEnds, Topology } from '../types';
import { IUPAC_DNA, reverseComplement } from '../seq/alphabet';
import { mod } from '../seq/range';
import type { EnzymeCut, RestrictionEnzyme } from './enzyme';
import { isPalindromic, validateEnzyme } from './enzyme';
import type { PairedRegion } from './ends';
import { BLUNT_ENDS, linearEndProblem, pairedRegion } from './ends';

/** Bit of each unambiguous base (A=1, C=2, G=4, T=8, either case); 0 for every other character. */
const BASE_BITS: Uint8Array = (() => {
  const t = new Uint8Array(128);
  const set = (base: string, bit: number) => {
    t[base.charCodeAt(0)] = bit;
    t[base.toLowerCase().charCodeAt(0)] = bit;
  };
  set('A', 1);
  set('C', 2);
  set('G', 4);
  set('T', 8);
  return t;
})();

/** Union of the bits of the bases an IUPAC code accepts (N -> 15). */
function iupacBits(code: string): number {
  let bits = 0;
  for (const base of IUPAC_DNA[code]) bits |= BASE_BITS[base.charCodeAt(0)];
  return bits;
}

/** One orientation of a recognition sequence, ready for matching. @internal (used by digest.ts) */
export interface SitePattern {
  /** 1 = the site as written, -1 = its reverse complement. */
  readonly strand: 1 | -1;
  /** Accepted-base bits for each position of the pattern (top-strand order). */
  readonly masks: Uint8Array;
  /** Longest run of A/C/G/T in the pattern, used to locate candidates with indexOf ('' if none). */
  readonly anchor: string;
  /** Offset of {@link anchor} inside the pattern. */
  readonly anchorOffset: number;
  /** Cleavage events relative to the footprint start, top-strand gap offsets, sorted left to right. */
  readonly cuts: readonly EnzymeCut[];
}

/** An enzyme prepared for searching: one pattern for palindromic sites, two otherwise. @internal */
export interface CompiledEnzyme {
  readonly name: string;
  /** Recognition sequence length. */
  readonly size: number;
  readonly patterns: readonly SitePattern[];
}

function byPosition(a: EnzymeCut, b: EnzymeCut): number {
  return Math.min(a.top, a.bottom) - Math.min(b.top, b.bottom) || Math.max(a.top, a.bottom) - Math.max(b.top, b.bottom) || a.top - b.top;
}

function uniqueSortedCuts(cuts: readonly EnzymeCut[]): EnzymeCut[] {
  const seen = new Set<string>();
  const out: EnzymeCut[] = [];
  for (const c of cuts) {
    const key = `${c.top},${c.bottom}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ top: c.top, bottom: c.bottom });
  }
  return out.sort(byPosition);
}

function compilePattern(pattern: string, strand: 1 | -1, cuts: readonly EnzymeCut[]): SitePattern {
  const masks = new Uint8Array(pattern.length);
  for (let i = 0; i < pattern.length; i++) masks[i] = iupacBits(pattern[i]);
  let anchor = '';
  let anchorOffset = 0;
  for (const m of pattern.matchAll(/[ACGT]+/g)) {
    if (m[0].length > anchor.length) {
      anchor = m[0];
      anchorOffset = m.index;
    }
  }
  return { strand, masks, anchor, anchorOffset, cuts: uniqueSortedCuts(cuts) };
}

/**
 * Prepare an enzyme for searching. Throws an Error naming the problems if the enzyme is invalid
 * (see `validateEnzyme`). @internal
 */
export function compileEnzyme(enzyme: RestrictionEnzyme): CompiledEnzyme {
  const problems = validateEnzyme(enzyme);
  if (problems.length > 0) throw new Error(`Invalid enzyme '${enzyme.name}': ${problems.join('; ')}`);
  const site = enzyme.site.toUpperCase();
  const n = site.length;
  const mirrored = enzyme.cuts.map((c) => ({ top: n - c.bottom, bottom: n - c.top }));
  const patterns = isPalindromic(site)
    ? [compilePattern(site, 1, [...enzyme.cuts, ...mirrored])]
    : [compilePattern(site, 1, enzyme.cuts), compilePattern(reverseComplement(site), -1, mirrored)];
  return { name: enzyme.name, size: n, patterns };
}

/** Upper-cased molecule plus base bits; circular molecules are extended by `extension` wrapped bases. */
interface Target {
  readonly text: string;
  readonly bits: Uint8Array;
  /** Length L of the molecule (without the extension). */
  readonly length: number;
  readonly circular: boolean;
}

function prepareTarget(seq: string, topology: Topology, longestSite: number): Target {
  // ASCII-only upper-casing: String#toUpperCase may change the length of non-ASCII text
  // (e.g. 'ß' -> 'SS'), which would shift every coordinate after it.
  const upper = seq.replace(/[a-z]+/g, (run) => run.toUpperCase());
  const length = upper.length;
  const circular = topology === 'circular';
  const extension = circular ? Math.max(0, Math.min(longestSite, length) - 1) : 0;
  const text = extension > 0 ? upper + upper.slice(0, extension) : upper;
  const bits = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    bits[i] = c < 128 ? BASE_BITS[c] : 0;
  }
  return { text, bits, length, circular };
}

function matchesAt(bits: Uint8Array, masks: Uint8Array, start: number, from: number, to: number): boolean {
  for (let j = from; j < to; j++) if ((bits[start + j] & masks[j]) === 0) return false;
  return true;
}

/** Call `visit(start)` for every footprint start where `pattern` matches (ascending order). */
function forEachMatch(target: Target, pattern: SitePattern, visit: (start: number) => void): void {
  const n = pattern.masks.length;
  const L = target.length;
  // number of admissible start positions: every base of a circle, or L - n + 1 on a line
  const limit = target.circular ? (n <= L ? L : 0) : L - n + 1;
  if (limit <= 0) return;
  const { text, bits } = target;
  const { masks, anchor, anchorOffset } = pattern;
  if (anchor.length === 0) {
    for (let s = 0; s < limit; s++) if (matchesAt(bits, masks, s, 0, n)) visit(s);
    return;
  }
  const anchorEnd = anchorOffset + anchor.length;
  for (let k = text.indexOf(anchor, anchorOffset); k !== -1; k = text.indexOf(anchor, k + 1)) {
    const s = k - anchorOffset;
    if (s >= limit) break;
    if (matchesAt(bits, masks, s, 0, anchorOffset) && matchesAt(bits, masks, s, anchorEnd, n)) visit(s);
  }
}

/** Keep the first enzyme of each name (site lists are keyed by name). */
function uniqueByName(enzymes: readonly RestrictionEnzyme[]): RestrictionEnzyme[] {
  const seen = new Set<string>();
  const out: RestrictionEnzyme[] = [];
  for (const e of enzymes) {
    if (seen.has(e.name)) continue;
    seen.add(e.name);
    out.push(e);
  }
  return out;
}

/**
 * Low-level scan shared by the search and digest code: calls `visit` for every occurrence of
 * every enzyme (duplicates by name are ignored), enzyme by enzyme, ascending positions within a
 * pattern. `start` is the footprint start in [0, L) where L = seq.length; the footprint is
 * [start, start + enzyme.size) and may exceed L on circular molecules. Cut offsets of
 * `pattern.cuts` are relative to `start` (top-strand gap positions, already mirrored for
 * strand -1). @internal
 */
export function scanEnzymeSites(
  seq: string,
  topology: Topology,
  enzymes: readonly RestrictionEnzyme[],
  visit: (enzyme: CompiledEnzyme, pattern: SitePattern, start: number) => void,
): void {
  const compiled = uniqueByName(enzymes).map(compileEnzyme);
  if (seq.length === 0) return;
  const longest = compiled.reduce((m, e) => Math.max(m, e.size), 0);
  const target = prepareTarget(seq, topology, longest);
  for (const enzyme of compiled) {
    for (const pattern of enzyme.patterns) forEachMatch(target, pattern, (start) => visit(enzyme, pattern, start));
  }
}

/** Order of {@link findSites}: range.start, then enzyme name (code-unit order), then strand 1 before -1. */
export function compareSites(a: EnzymeSite, b: EnzymeSite): number {
  if (a.range.start !== b.range.start) return a.range.start - b.range.start;
  if (a.enzyme !== b.enzyme) return a.enzyme < b.enzyme ? -1 : 1;
  return b.strand - a.strand;
}

/**
 * `mod(x, L)`: a position on a circle of length L, in [0, L), never negative zero. (`mod` returns
 * -0 for negative multiples of L, since -15 % 15 is -0; Object.is, deep equality and number
 * formatting tell -0 apart from 0.) @internal (also used by digest.ts)
 */
export function circularGap(x: number, L: number): number {
  const r = mod(x, L);
  return r === 0 ? 0 : r;
}

/**
 * Cleavage events of one occurrence on a circular molecule of length L, normalized into [0, L)
 * (events that coincide modulo L on a very small circle are listed once).
 */
function circularSiteCuts(pattern: SitePattern, start: number, L: number): CutPair[] {
  const cuts: CutPair[] = [];
  for (const c of pattern.cuts) {
    const cut = { top: circularGap(start + c.top, L), bottom: circularGap(start + c.bottom, L) };
    if (!cuts.some((x) => x.top === cut.top && x.bottom === cut.bottom)) cuts.push(cut);
  }
  return cuts;
}

/**
 * Cleavage events of the occurrence [start, start + size) on a linear molecule whose base pairs
 * are `paired`: the events that can cut it (see `linearEndProblem` in ends.ts).
 */
function linearSiteCuts(pattern: SitePattern, start: number, size: number, paired: PairedRegion): CutPair[] {
  const cuts: CutPair[] = [];
  for (const c of pattern.cuts) {
    const top = start + c.top;
    const bottom = start + c.bottom;
    if (linearEndProblem(top, bottom, start, start + size, paired) === undefined) cuts.push({ top, bottom });
  }
  return cuts;
}

/** Options of {@link findSites}. */
export interface SiteSearchOptions {
  /**
   * Single-stranded ends of a LINEAR molecule (FragmentEnds convention of `types.ts`, e.g. a
   * record's `ends`; default: both blunt; an overhang of length 0 counts as blunt). Cleavage
   * events are then reported exactly when `digest` with the same ends could make them: a site in
   * or straddling a single-stranded overhang is listed without cleavage events. Validated like
   * the ends of `digest` (throws if invalid or if they leave no base pair). Ignored for circular
   * molecules and for an empty sequence.
   */
  ends?: FragmentEnds;
}

/**
 * Every occurrence of every enzyme's recognition sequence on both strands of `seq` (any case).
 * See the file comment for the conventions (footprints, strands, cut normalization, linear ends,
 * ambiguity codes). Sorted by range.start, then enzyme name, then strand (1 first).
 * Enzymes are identified by name: if two entries share a name only the first is searched.
 * For a linear molecule with single-stranded ends pass them as `options.ends`, so that the
 * reported cleavage events (and the counts derived from them) agree with `digest`.
 * Throws if an enzyme definition is invalid (see `validateEnzyme`) or `options.ends` is invalid.
 */
export function findSites(
  seq: string,
  topology: Topology,
  enzymes: readonly RestrictionEnzyme[],
  options: SiteSearchOptions = {},
): EnzymeSite[] {
  const L = seq.length;
  // Linear molecules: the base-paired part given the ends, which are validated here as digest
  // does. An empty sequence has no sites and, as in digest, its ends are not checked; so once a
  // site is found, `paired` is undefined only for circular molecules.
  const paired = topology === 'circular' || L === 0 ? undefined : pairedRegion(options.ends ?? BLUNT_ENDS, L);
  const sites: EnzymeSite[] = [];
  scanEnzymeSites(seq, topology, enzymes, (enzyme, pattern, start) => {
    sites.push({
      enzyme: enzyme.name,
      range: { start, end: start + enzyme.size },
      strand: pattern.strand,
      cuts: paired === undefined ? circularSiteCuts(pattern, start, L) : linearSiteCuts(pattern, start, enzyme.size, paired),
    });
  });
  return sites.sort(compareSites);
}

/** {@link findSites} for a single enzyme. */
export function findSitesForEnzyme(
  seq: string,
  topology: Topology,
  enzyme: RestrictionEnzyme,
  options: SiteSearchOptions = {},
): EnzymeSite[] {
  return findSites(seq, topology, [enzyme], options);
}

/**
 * Number of distinct cleavage events per enzyme: distinct (top, bottom) cut pairs over all of
 * the enzyme's sites (two sites producing the same double-strand cut count once). Enzymes whose
 * sites are not cleaved (linear ends) map to 0. Keys appear in order of first occurrence.
 */
export function countCuts(sites: readonly EnzymeSite[]): Map<string, number> {
  const events = new Map<string, Set<string>>();
  for (const site of sites) {
    let set = events.get(site.enzyme);
    if (set === undefined) {
      set = new Set();
      events.set(site.enzyme, set);
    }
    for (const c of site.cuts) set.add(`${c.top},${c.bottom}`);
  }
  const counts = new Map<string, number>();
  for (const [enzyme, set] of events) counts.set(enzyme, set.size);
  return counts;
}

/** Number of recognition sites (occurrences, both strands) per enzyme, in order of first occurrence. */
export function countSites(sites: readonly EnzymeSite[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const site of sites) counts.set(site.enzyme, (counts.get(site.enzyme) ?? 0) + 1);
  return counts;
}
