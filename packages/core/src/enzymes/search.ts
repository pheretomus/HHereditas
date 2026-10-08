/**
 * Restriction site search on both strands of linear and circular molecules.
 *
 * Conventions (see `types.ts`):
 *  - Site footprints are half-open 0-based ranges on the top strand. On circular molecules a site
 *    crossing the origin has `range.end > L` (e.g. { start: L - 2, end: L + 4 }).
 *  - Cut positions are GAP positions in top-strand coordinates: circular -> normalized into [0, L);
 *    linear -> a cleavage event is reported only when BOTH its top and bottom cut lie in [1, L - 1].
 *    That is Biopython's rule (Bio.Restriction AbstractCut._drop): a cut exactly at an end (gap 0
 *    or L) or beyond it does not cleave anything, so the event is omitted from `site.cuts` while
 *    the site itself is still listed.
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
import type { CutPair, EnzymeSite, Topology } from '../types';
import { IUPAC_DNA, reverseComplement } from '../seq/alphabet';
import { mod } from '../seq/range';
import type { EnzymeCut, RestrictionEnzyme } from './enzyme';
import { isPalindromic, validateEnzyme } from './enzyme';

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
 * Cleavage events of one occurrence, in molecule coordinates: normalized into [0, L) on circular
 * molecules (events that coincide modulo L on a very small circle are listed once); on linear
 * molecules only events whose top and bottom cuts both lie in [1, L - 1].
 */
function siteCuts(pattern: SitePattern, start: number, L: number, circular: boolean): CutPair[] {
  const cuts: CutPair[] = [];
  for (const c of pattern.cuts) {
    const top = start + c.top;
    const bottom = start + c.bottom;
    if (circular) {
      const cut = { top: mod(top, L), bottom: mod(bottom, L) };
      if (!cuts.some((x) => x.top === cut.top && x.bottom === cut.bottom)) cuts.push(cut);
    } else if (top >= 1 && top <= L - 1 && bottom >= 1 && bottom <= L - 1) {
      cuts.push({ top, bottom });
    }
  }
  return cuts;
}

/**
 * Every occurrence of every enzyme's recognition sequence on both strands of `seq` (any case).
 * See the file comment for the conventions (footprints, strands, cut normalization, linear ends,
 * ambiguity codes). Sorted by range.start, then enzyme name, then strand (1 first).
 * Enzymes are identified by name: if two entries share a name only the first is searched.
 * Throws if an enzyme definition is invalid (see `validateEnzyme`).
 */
export function findSites(seq: string, topology: Topology, enzymes: readonly RestrictionEnzyme[]): EnzymeSite[] {
  const sites: EnzymeSite[] = [];
  const circular = topology === 'circular';
  const L = seq.length;
  scanEnzymeSites(seq, topology, enzymes, (enzyme, pattern, start) => {
    sites.push({
      enzyme: enzyme.name,
      range: { start, end: start + enzyme.size },
      strand: pattern.strand,
      cuts: siteCuts(pattern, start, L, circular),
    });
  });
  return sites.sort(compareSites);
}

/** {@link findSites} for a single enzyme. */
export function findSitesForEnzyme(seq: string, topology: Topology, enzyme: RestrictionEnzyme): EnzymeSite[] {
  return findSites(seq, topology, [enzyme]);
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
