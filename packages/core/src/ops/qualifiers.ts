/**
 * Internal helpers of the ops module (not re-exported from `ops/index.ts`): feature qualifiers
 * whose meaning depends on where, or which, the feature's bases are.
 *
 * POSITION-BEARING QUALIFIERS hold absolute 1-based base numbers of the record, so they must move
 * with the bases (INSDC Feature Table Definition v11.4, April 2026, section 7.3, Appendix III):
 *   /transl_except=(pos:<location>,aa:<amino_acid>)         e.g. (pos:213..215,aa:Trp), (pos:1017,aa:TERM)
 *   /anticodon=(pos:<location>,aa:<amino_acid>,seq:<text>)   e.g. (pos:34..36,aa:Phe,seq:aaa)
 *   /rpt_unit_range=<base_range>                             e.g. 202..245
 *   /tag_peptide=<base_range>                                e.g. 90..122
 * An operation describes how it moves bases with a {@link BaseMap}; the location is rewritten in
 * the same syntax (runs `a..b` / `a`, `join(...)` / `order(...)`, an outer `complement(...)`,
 * fuzzy `<` / `>` markers). The work is proportional to the number of written runs, never to the
 * number of bases they name (a run is moved with a few additions, whatever its length).
 *
 * Written form: each written run keeps its form, so applying an operation and then its inverse
 * (rotating by k and then by L - k, reverse-complementing twice) gives the value back exactly:
 *   - a run whose bases are no longer consecutive because an origin now lies inside it (the origin
 *     of a circular molecule, or the two ends of a circle opened inside it) is written as two parts,
 *     as GenBank / INSDC records write origin-crossing locations: join(4999..5000,1..2); this also
 *     applies to a <base_range>, which is otherwise a single a..b (the alternative, dropping it,
 *     would lose the annotation);
 *   - two written parts are written as one run again only when their bases are consecutive in the
 *     new coordinates AND the boundary between them was the origin of the old circular molecule
 *     (i.e. they are the two halves of one run that an earlier operation split at the origin), and
 *     no '<' / '>' marker sits between them; other written parts are never merged;
 *   - a one-base run keeps the form it was written in (`12` or `12..12`); a one-base piece of a
 *     longer run is written `n`, as INSDC writes single bases.
 *   Limitation (inherent to the text): a value that writes two consecutive bases as separate parts
 *   (e.g. join(1,2,3), which INSDC files do not use apart from the origin case) is still moved
 *   exactly, but if a rotation puts the origin exactly between two such parts, rotating back cannot
 *   tell that boundary from a run split at the origin and writes the two parts as one run
 *   (join(1..2,3)): the same bases, written differently.
 * The qualifier is DROPPED when it no longer describes bases of the feature: one of its bases was
 * deleted, replaced or left out of an extracted region, or (base edits) bases inserted into the
 * feature landed between two of its adjacent bases. Values that are not understood (remote
 * locations such as `X58595.1:189..191`, other syntax, positions outside the record, a
 * complement() around a <base_range>) are kept unchanged: they are not positions of this record,
 * or were already invalid.
 *
 * /codon_start ("1 or 2 or 3": the offset of the first complete codon of a coding feature,
 * relative to its first base; same source) changes when bases are removed from the feature's 5'
 * end, see {@link shiftCodonStart}.
 *
 * /translation (the conceptual translation of a CDS; same source) is derived from the feature's
 * exact bases, so it is dropped when an operation changes them, see {@link dropTranslation}.
 */
import type { Qualifier } from '../types';
import { mod } from '../seq/range';

/** Qualifiers whose value is `(pos:<location>,...)`; the location has a strand. */
const POS_KEYS: ReadonlySet<string> = new Set(['transl_except', 'anticodon']);
/** Qualifiers whose value is a `<base_range>` (a range `a..b`, no strand). */
const RANGE_KEYS: ReadonlySet<string> = new Set(['rpt_unit_range', 'tag_peptide']);

/**
 * How an operation moves the bases of a record: old 0-based base index -> new 0-based base index,
 * as a piecewise translation. Lengths are in bases.
 */
export interface BaseMap {
  /** New index of old base `x` (0 <= x < oldLength), or null when the base no longer exists. */
  readonly base: (x: number) => number | null;
  /**
   * Old base indices where the map may change (any order; values outside (0, oldLength) are
   * ignored). Between two consecutive breaks (and the ends 0 and oldLength) every base is gone, or
   * none is and the map is a translation: base(x + 1) = base(x) + 1, or base(x) - 1 when `flip`.
   */
  readonly breaks: readonly number[];
  readonly oldLength: number;
  readonly oldCircular: boolean;
  readonly newLength: number;
  readonly newCircular: boolean;
  /** Reverse complement: the order of bases is reversed and strands swap (complement() toggles). */
  readonly flip: boolean;
  /**
   * Base edits can put new bases between two adjacent old bases: when set (the inserted bases joined
   * the feature), a location two of whose adjacent bases are no longer adjacent was cut by the
   * insertion and is dropped.
   */
  readonly dropIfSplit: boolean;
}

/** A run of consecutive bases [first, last] (0-based, inclusive) as written in a location. */
export interface LocationRun {
  first: number;
  last: number;
  /** '<' before the first base number. */
  open: boolean;
  /** '>' before the last base number. */
  close: boolean;
  /** Written as a range (`a..b`); only matters for a one-base run (`12..12` rather than `12`). */
  ranged: boolean;
}

/** A parsed location: runs in written (top-strand) order. */
interface Location {
  complement: boolean;
  /** 'join' or 'order' when the location was written with one; null for a single part. */
  operator: string | null;
  runs: LocationRun[];
}

/** One part of a location, INSDC syntax: `n`, `a..b`, with '<' before a and '>' before b. */
const RUN_RE = /^(<)?(\d+)(?:\.\.(>)?(\d+))?$/;

/**
 * Parse `[complement(](a..b | join(a..b,...) | order(...))[)]` for a molecule of `L` bases;
 * null for anything else (remote parts, nested operators, positions outside 1..L, b < a).
 */
function parseLocation(text: string, L: number): Location | null {
  let s = text.replace(/\s+/g, '');
  let complement = false;
  const comp = /^complement\((.*)\)$/.exec(s);
  if (comp !== null) {
    complement = true;
    s = comp[1];
  }
  let operator: string | null = null;
  const op = /^(join|order)\((.*)\)$/.exec(s);
  if (op !== null) {
    operator = op[1];
    s = op[2];
  }
  const runs: LocationRun[] = [];
  for (const part of s.split(',')) {
    const m = RUN_RE.exec(part);
    if (m === null) return null;
    const first = Number(m[2]) - 1;
    const last = m[4] === undefined ? first : Number(m[4]) - 1;
    if (first < 0 || last < first || last >= L) return null;
    runs.push({ first, last, open: m[1] !== undefined, close: m[3] !== undefined, ranged: m[4] !== undefined });
  }
  return { complement, operator, runs };
}

function formatRun(r: LocationRun): string {
  const a = `${r.open ? '<' : ''}${r.first + 1}`;
  return r.first === r.last && !r.close && !r.ranged ? a : `${a}..${r.close ? '>' : ''}${r.last + 1}`;
}

function formatLocation(loc: Location): string {
  const parts = loc.runs.map(formatRun);
  const inner = parts.length > 1 ? `${loc.operator ?? 'join'}(${parts.join(',')})` : parts[0];
  return loc.complement ? `complement(${inner})` : inner;
}

/** True if base `y` follows base `x` on a molecule of `length` bases (across the origin of a circle). */
function follows(x: number, y: number, length: number, circular: boolean): boolean {
  return y === x + 1 || (circular && x === length - 1 && y === 0);
}

/** A stretch of a written run moved by the map, in NEW top-strand order (first <= last). */
interface Piece {
  first: number;
  last: number;
  /** Old indices of the bases now at `first` and at `last`. */
  oldAtFirst: number;
  oldAtLast: number;
  /** Index of the written run it comes from. */
  part: number;
  open: boolean;
  close: boolean;
  ranged: boolean;
}

/** The breaks of `map` inside (0, oldLength), sorted and without duplicates. */
function sortedBreaks(map: BaseMap): number[] {
  const inside = map.breaks.filter((b) => Number.isInteger(b) && b > 0 && b < map.oldLength);
  return [...new Set(inside)].sort((x, y) => x - y);
}

/** Index of the first element of the sorted `values` that is greater than `x`. */
function firstAbove(values: readonly number[], x: number): number {
  let lo = 0;
  let hi = values.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (values[mid] <= x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * The location after the map, or null when it no longer exists (see the module notes). Works on
 * stretches between the map's breaks: O(runs + breaks) arithmetic, whatever the number of bases.
 */
function remapLocation(loc: Location, map: BaseMap, stranded: boolean): Location | null {
  const breaks = sortedBreaks(map);
  const pieces: Piece[] = [];
  // Last base moved so far, in old written order (for the dropIfSplit test).
  let previous: { old: number; pos: number } | null = null;
  for (const [part, run] of loc.runs.entries()) {
    let from = run.first;
    let k = firstAbove(breaks, run.first);
    while (from <= run.last) {
      const to = k < breaks.length && breaks[k] <= run.last ? breaks[k] - 1 : run.last;
      k++;
      const y = map.base(from);
      if (y === null) return null;
      const yTo = map.flip ? y - (to - from) : y + (to - from);
      if (map.base(to) !== yTo) {
        throw new Error(`ops internal error: the base map is not a translation on ${from}..${to} (missing break)`);
      }
      if (map.dropIfSplit && previous !== null && follows(previous.old, from, map.oldLength, map.oldCircular)) {
        const adjacent = map.flip
          ? follows(y, previous.pos, map.newLength, map.newCircular)
          : follows(previous.pos, y, map.newLength, map.newCircular);
        if (!adjacent) return null;
      }
      previous = { old: to, pos: yTo };
      const markFirst = from === run.first && run.open; // '<' attached to old base `from`
      const markLast = to === run.last && run.close; // '>' attached to old base `to`
      const ranged = run.ranged && run.first === run.last;
      pieces.push(
        map.flip
          ? // the new top strand reads the old one backwards: '<' (left end) becomes '>' (right end)
            { first: yTo, last: y, oldAtFirst: to, oldAtLast: from, part, open: markLast, close: markFirst, ranged }
          : { first: y, last: yTo, oldAtFirst: from, oldAtLast: to, part, open: markFirst, close: markLast, ranged },
      );
      from = to + 1;
    }
  }
  if (map.flip) pieces.reverse();
  const L = map.oldLength;
  const atOldOrigin = (x: number, y: number) => map.oldCircular && ((x === L - 1 && y === 0) || (x === 0 && y === L - 1));
  const runs: LocationRun[] = [];
  let last: Piece | undefined;
  for (const p of pieces) {
    const current = runs[runs.length - 1];
    if (
      last !== undefined &&
      current !== undefined &&
      p.first === current.last + 1 &&
      !current.close &&
      !p.open &&
      (p.part === last.part || atOldOrigin(last.oldAtLast, p.oldAtFirst))
    ) {
      current.last = p.last;
      current.close = p.close;
      current.ranged = false;
    } else {
      runs.push({ first: p.first, last: p.last, open: p.open, close: p.close, ranged: p.ranged });
    }
    last = p;
  }
  return { complement: stranded && map.flip ? !loc.complement : loc.complement, operator: loc.operator, runs };
}

/**
 * Filter for {@link remapPositionalQualifiers}: receives the moved runs (new 0-based bases, inclusive)
 * of a location and returns false to drop the qualifier.
 */
export type KeepLocation = (runs: readonly LocationRun[]) => boolean;

/**
 * New value of a position-bearing qualifier: a string, null to drop the qualifier, or undefined
 * when the value is not understood (kept unchanged).
 */
function remapValue(key: string, value: string, map: BaseMap, keep?: KeepLocation): string | null | undefined {
  if (RANGE_KEYS.has(key)) {
    const loc = parseLocation(value, map.oldLength);
    if (loc === null || loc.complement) return undefined;
    const out = remapLocation(loc, map, false);
    if (out === null || (keep !== undefined && !keep(out.runs))) return null;
    return formatLocation(out);
  }
  // (pos:<location>,aa:...): the location ends at the first comma outside parentheses
  const v = value.trim();
  if (!v.startsWith('(') || !v.endsWith(')')) return undefined;
  const inner = v.slice(1, -1);
  const head = /^\s*pos\s*:/i.exec(inner);
  if (head === null) return undefined;
  let end = -1;
  let depth = 0;
  for (let i = head[0].length; i < inner.length && end < 0; i++) {
    if (inner[i] === '(') depth++;
    else if (inner[i] === ')') depth--;
    else if (inner[i] === ',' && depth === 0) end = i;
  }
  if (end < 0) return undefined;
  const loc = parseLocation(inner.slice(head[0].length, end), map.oldLength);
  if (loc === null) return undefined;
  const out = remapLocation(loc, map, true);
  if (out === null || (keep !== undefined && !keep(out.runs))) return null;
  return `(${head[0]}${formatLocation(out)}${inner.slice(end)})`;
}

/**
 * Copies of `qualifiers` (new objects, same order) with the position-bearing qualifiers moved by
 * `map` or dropped (see the module notes). `keep`, when given, receives the moved runs of each
 * location and drops the qualifier when it returns false (e.g. the location lies outside the
 * piece of a split feature). Qualifiers without positions are copied unchanged.
 */
export function remapPositionalQualifiers(qualifiers: readonly Qualifier[], map: BaseMap, keep?: KeepLocation): Qualifier[] {
  const out: Qualifier[] = [];
  for (const q of qualifiers) {
    if (q.value === null || !(POS_KEYS.has(q.key) || RANGE_KEYS.has(q.key))) {
      out.push({ key: q.key, value: q.value });
      continue;
    }
    const value = remapValue(q.key, q.value, map, keep);
    if (value === undefined) out.push({ key: q.key, value: q.value });
    else if (value !== null) out.push({ key: q.key, value });
  }
  return out;
}

/** True if any qualifier holds positions (lets callers skip building maps for the common case). */
export function hasPositionalQualifiers(qualifiers: readonly Qualifier[]): boolean {
  return qualifiers.some((q) => q.value !== null && (POS_KEYS.has(q.key) || RANGE_KEYS.has(q.key)));
}

/**
 * Qualifiers of a feature whose first `lost5` bases (5' end: the left end in top-strand
 * coordinates for strand 1 / 0, the right end for strand -1) were removed, with /codon_start
 * updated so that the remaining bases are read in the same frame: the first complete codon was at
 * offset c - 1 and is now at offset (c - 1 - lost5) mod 3. Applies to features that have a
 * /codon_start or are of type 'CDS' (implicit /codon_start=1; the qualifier is added, before any
 * /translation, only when the new value is not 1). A value other than 1, 2 or 3 is left alone.
 * Returns `qualifiers` itself when nothing changes, otherwise a new array.
 */
export function shiftCodonStart(type: string, qualifiers: Qualifier[], lost5: number): Qualifier[] {
  if (mod(lost5, 3) === 0) return qualifiers;
  const i = qualifiers.findIndex((q) => q.key === 'codon_start' && q.value !== null);
  if (i < 0) {
    if (type !== 'CDS') return qualifiers;
    const added: Qualifier = { key: 'codon_start', value: String(mod(-lost5, 3) + 1) };
    const at = qualifiers.findIndex((q) => q.key === 'translation');
    return at < 0 ? [...qualifiers, added] : [...qualifiers.slice(0, at), added, ...qualifiers.slice(at)];
  }
  const old = Number((qualifiers[i].value as string).trim());
  if (old !== 1 && old !== 2 && old !== 3) return qualifiers;
  const value = String(mod(old - 1 - lost5, 3) + 1);
  return qualifiers.map((q) => (q.key === 'codon_start' && q.value !== null ? { key: q.key, value } : q));
}

/**
 * `qualifiers` without /translation, for a feature whose bases an operation changed (bases deleted,
 * inserted or replaced inside it, or an end clipped): INSDC defines /translation as the conceptual
 * translation of the feature's bases, so the stored protein would no longer match them. (A
 * replacement by identical bases also counts as a change.) Recompute it from the sequence, e.g.
 * with `translateFeature` (seq/translate.ts), when needed. Returns `qualifiers` itself when there
 * is no /translation.
 */
export function dropTranslation(qualifiers: Qualifier[]): Qualifier[] {
  return qualifiers.some((q) => q.key === 'translation') ? qualifiers.filter((q) => q.key !== 'translation') : qualifiers;
}
