/**
 * Internal helpers of the ops module (not re-exported from `ops/index.ts`): feature qualifiers
 * whose meaning depends on where the feature's bases are.
 *
 * POSITION-BEARING QUALIFIERS hold absolute 1-based base numbers of the record, so they must move
 * with the bases (INSDC Feature Table Definition v11.4, April 2026, section 7.3, Appendix III):
 *   /transl_except=(pos:<location>,aa:<amino_acid>)         e.g. (pos:213..215,aa:Trp), (pos:1017,aa:TERM)
 *   /anticodon=(pos:<location>,aa:<amino_acid>,seq:<text>)   e.g. (pos:34..36,aa:Phe,seq:aaa)
 *   /rpt_unit_range=<base_range>                             e.g. 202..245
 *   /tag_peptide=<base_range>                                e.g. 90..122
 * An operation describes how it moves bases with a {@link BaseMap}; every base of the location
 * is moved and the location is rewritten in the same syntax (runs of consecutive bases,
 * `join(...)` / `order(...)` and an outer `complement(...)`; parts that reach the origin of a
 * circular molecule are written as separate parts, as INSDC requires). The qualifier is DROPPED
 * when it no longer describes bases of the feature: one of its bases was deleted, replaced or
 * left out of an extracted region, or (base edits) bases were inserted between two of its
 * adjacent bases. A <base_range> must stay one range. Values that are not understood (remote
 * locations such as `X58595.1:189..191`, other syntax, positions outside the record) are kept
 * unchanged: they are not positions of this record, or were already invalid.
 *
 * /codon_start ("1 or 2 or 3": the offset of the first complete codon of a coding feature,
 * relative to its first base; same source) changes when bases are removed from the feature's 5'
 * end, see {@link shiftCodonStart}.
 */
import type { Qualifier } from '../types';
import { mod } from '../seq/range';

/** Qualifiers whose value is `(pos:<location>,...)`; the location has a strand. */
const POS_KEYS: ReadonlySet<string> = new Set(['transl_except', 'anticodon']);
/** Qualifiers whose value is a `<base_range>` (one range `a..b`, no strand). */
const RANGE_KEYS: ReadonlySet<string> = new Set(['rpt_unit_range', 'tag_peptide']);

/**
 * How an operation moves the bases of a record: old 0-based base index -> new 0-based base index.
 * Lengths are in bases.
 */
export interface BaseMap {
  /** New index of old base `x` (0 <= x < oldLength), or null when the base no longer exists. */
  readonly base: (x: number) => number | null;
  readonly oldLength: number;
  readonly oldCircular: boolean;
  readonly newLength: number;
  readonly newCircular: boolean;
  /** Reverse complement: the order of bases is reversed and strands swap (complement() toggles). */
  readonly flip: boolean;
  /**
   * Base edits can put new bases between two adjacent old bases: a location two of whose
   * adjacent bases are no longer adjacent was cut by the insertion and is dropped.
   */
  readonly dropIfSplit: boolean;
}

/** A run of consecutive bases [first, last] (0-based, inclusive) with its fuzzy markers. */
interface Run {
  first: number;
  last: number;
  /** '<' before the first base. */
  open: boolean;
  /** '>' before the last base number. */
  close: boolean;
}

/** A parsed location: runs in written (top-strand) order. */
interface Location {
  complement: boolean;
  /** 'join' or 'order' when the location was written with one; null for a single part. */
  operator: string | null;
  runs: Run[];
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
  const runs: Run[] = [];
  for (const part of s.split(',')) {
    const m = RUN_RE.exec(part);
    if (m === null) return null;
    const first = Number(m[2]) - 1;
    const last = m[4] === undefined ? first : Number(m[4]) - 1;
    if (first < 0 || last < first || last >= L) return null;
    runs.push({ first, last, open: m[1] !== undefined, close: m[3] !== undefined });
  }
  return { complement, operator, runs };
}

function formatLocation(loc: Location): string {
  const parts = loc.runs.map((r) => {
    const a = `${r.open ? '<' : ''}${r.first + 1}`;
    return r.first === r.last && !r.close ? a : `${a}..${r.close ? '>' : ''}${r.last + 1}`;
  });
  const inner = parts.length > 1 ? `${loc.operator ?? 'join'}(${parts.join(',')})` : parts[0];
  return loc.complement ? `complement(${inner})` : inner;
}

/** True if base `y` follows base `x` on a molecule of `length` bases (across the origin of a circle). */
function follows(x: number, y: number, length: number, circular: boolean): boolean {
  return y === x + 1 || (circular && x === length - 1 && y === 0);
}

/** One base of a location while it is remapped. */
interface MappedBase {
  pos: number;
  /** Index of the original run (bases of different written parts never merge). */
  run: number;
  open: boolean;
  close: boolean;
}

/**
 * The location after the map, or null when it no longer exists (see the module notes). The new
 * bases are also returned, for {@link remapPositionalQualifiers}' `keep` filter.
 */
function remapLocation(loc: Location, map: BaseMap, strand: boolean): { loc: Location; bases: number[] } | null {
  const mapped: MappedBase[] = [];
  let previous: { old: number; pos: number } | null = null;
  for (const [i, run] of loc.runs.entries()) {
    for (let x = run.first; x <= run.last; x++) {
      const pos = map.base(x);
      if (pos === null) return null;
      if (
        map.dropIfSplit &&
        previous !== null &&
        follows(previous.old, x, map.oldLength, map.oldCircular) &&
        !follows(previous.pos, pos, map.newLength, map.newCircular)
      ) {
        return null;
      }
      previous = { old: x, pos };
      mapped.push({ pos, run: i, open: x === run.first && run.open, close: x === run.last && run.close });
    }
  }
  if (map.flip) {
    // The new top strand reads the old one backwards: '<' (left end) becomes '>' (right end).
    mapped.reverse();
    for (const b of mapped) [b.open, b.close] = [b.close, b.open];
  }
  const runs: Run[] = [];
  for (const [k, b] of mapped.entries()) {
    const prev = k > 0 ? mapped[k - 1] : undefined;
    const current = runs[runs.length - 1];
    if (prev !== undefined && current !== undefined && prev.run === b.run && b.pos === prev.pos + 1) {
      current.last = b.pos;
      current.close = b.close;
    } else {
      runs.push({ first: b.pos, last: b.pos, open: b.open, close: b.close });
    }
  }
  return {
    loc: { complement: strand && map.flip ? !loc.complement : loc.complement, operator: loc.operator, runs },
    bases: mapped.map((b) => b.pos),
  };
}

/**
 * New value of a position-bearing qualifier: a string, null to drop the qualifier, or undefined
 * when the value is not understood (kept unchanged).
 */
function remapValue(key: string, value: string, map: BaseMap, keep?: (bases: readonly number[]) => boolean): string | null | undefined {
  if (RANGE_KEYS.has(key)) {
    const loc = parseLocation(value, map.oldLength);
    if (loc === null || loc.complement || loc.operator !== null) return undefined;
    const out = remapLocation(loc, map, false);
    if (out === null || out.loc.runs.length !== 1 || (keep !== undefined && !keep(out.bases))) return null;
    return formatLocation(out.loc);
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
  if (out === null || (keep !== undefined && !keep(out.bases))) return null;
  return `(${head[0]}${formatLocation(out.loc)}${inner.slice(end)})`;
}

/**
 * Copies of `qualifiers` (new objects, same order) with the position-bearing qualifiers moved by
 * `map` or dropped (see the module notes). `keep`, when given, receives the new 0-based bases of
 * each moved location and drops the qualifier when it returns false (e.g. the location lies
 * outside the piece of a split feature). Qualifiers without positions are copied unchanged.
 */
export function remapPositionalQualifiers(
  qualifiers: readonly Qualifier[],
  map: BaseMap,
  keep?: (bases: readonly number[]) => boolean,
): Qualifier[] {
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
