/**
 * INSDC feature-location strings (GenBank / EMBL / DDBJ feature tables):
 * parsing into the HHereditas segment model and formatting back.
 *
 * Source of the syntax: "The DDBJ/ENA/GenBank Feature Table Definition", section 3.4
 * (https://www.insdc.org/submitting-standards/feature-table/), cross-checked against
 * Biopython 1.88 `Bio.SeqFeature.Location.fromstring` (the differential-test oracle).
 *
 * Location text uses 1-based, inclusive base numbers; the returned segments use the
 * 0-based, half-open {@link Range} convention of `types.ts`:
 *
 *   text          meaning                                   segment (0-based, half-open)
 *   "467"         single base 467                           {466, 467}
 *   "340..565"    bases 340 to 565 inclusive                {339, 565}
 *   "<345..500"   lower boundary lies before base 345       {344, 500}, partialStart
 *   "1..>888"     upper boundary lies after base 888        {0, 888},   partialEnd
 *   "123^124"     site between bases 123 and 124            {123, 123}  (zero length, gap 123)
 *   "L^1"         circular only: site at the origin         {0, 0}
 *   "102.110"     one base somewhere in 102..110            {101, 110}  (+ warning: range used)
 *
 * Segments are always listed in TOP-strand order (see `Feature.segments` in `types.ts`):
 * `complement(join(a,b))` and `join(complement(b),complement(a))` both give segments [a, b]
 * with strand -1. On circular molecules a part that runs over the origin is a single
 * segment with `end > seqLength`, whether it was written `join(s..L,1..e)` or as the
 * shorthand `s..e` with s > e.
 */
import type { Range, Strand, Topology } from '../types';
import { normalizeRange, splitAtOrigin } from '../seq/range';

/** Successful parse of a location string. */
export interface LocationParseSuccess {
  ok: true;
  /** 1 (forward) or -1 (complement). Never 0: callers decide when a strand is meaningless (proteins). */
  strand: Strand;
  /** Non-empty list of 0-based half-open ranges in top-strand join order (see the module doc). */
  segments: Range[];
  /** The location's leftmost written boundary (start of `segments[0]`) is fuzzy ('<', or clamped). */
  partialStart: boolean;
  /** The location's rightmost written boundary (end of the last segment) is fuzzy ('>', or clamped). */
  partialEnd: boolean;
  /** Human-readable notes about everything that was approximated, clamped, dropped or ignored. */
  warnings: string[];
}

/** Failed parse: the text is not a location or no part of it lies on this sequence. */
export interface LocationParseFailure {
  ok: false;
  error: string;
}

/** Result of {@link parseLocation}. */
export type LocationParseResult = LocationParseSuccess | LocationParseFailure;

/** Input of {@link formatLocation}: the location-related fields of a `Feature`. */
export interface LocationLike {
  strand: Strand;
  segments: readonly Range[];
  partialStart?: boolean;
  partialEnd?: boolean;
}

// ---------------------------------------------------------------------------
// Syntax tree
// ---------------------------------------------------------------------------

/**
 * Fuzzy marker of a boundary (INSDC Feature Table 3.4.3: "'<' and '>' may be used with the
 * starting and ending base numbers to indicate that an end point is beyond the specified base
 * number"): '<' = the boundary lies before that base, '>' = after it; null = exact.
 */
type Marker = '<' | '>' | null;

/** One boundary as written: 1-based base number(s). */
interface Position {
  /** Value used when the position starts a span (lowest / first alternative). */
  asStart: number;
  /** Value used when the position ends a span (highest / first alternative). */
  asEnd: number;
  /** Fuzzy marker written in front of the number, if any. */
  marker: Marker;
}

type LocationNode =
  /**
   * Bases `first..last` (1-based, inclusive, as written). `lower` / `upper`: markers of the lower
   * and upper boundary as written ('>' on `lower` and '<' on `upper` point INTO the span); a
   * single fuzzy base (`<5`, `>5`) gets its marker on the side it points to.
   */
  | { kind: 'span'; first: number; last: number; lower: Marker; upper: Marker; remote: string | null; text: string }
  | { kind: 'between'; left: number; right: number; remote: string | null; text: string }
  | { kind: 'complement'; child: LocationNode }
  | { kind: 'join'; children: LocationNode[] };

class LocationSyntaxError extends Error {}

/** Deepest operator nesting accepted (real locations nest at most 2-3 levels). */
const MAX_NESTING = 64;

// Sticky (y) patterns, matched at the parser position without copying the rest of the text.
const OPERATOR = /([A-Za-z][A-Za-z_-]*)\(/y;
const ONE_OF_POSITION_AHEAD = /one-of\(-?\d+(?:,-?\d+)*\)/iy;
const REMOTE_PREFIX = /([A-Za-z][A-Za-z0-9_.|-]*):/y;
const INTEGER = /-?\d+/y;
const WITHIN_POSITION = /\((-?\d+)\.(-?\d+)\)/y;
const ONE_OF_POSITION = /one-of\((-?\d+(?:,-?\d+)*)\)/iy;
const SINGLE_BASE_DOT = /\.-?\d/y;

/**
 * Recursive-descent parser for the location grammar. Whitespace has already been removed
 * (locations never contain blanks; wrapped lines are concatenated).
 */
class LocationParser {
  private i = 0;
  private depth = 0;
  private readonly s: string;
  private readonly warnings: string[];

  constructor(s: string, warnings: string[]) {
    this.s = s;
    this.warnings = warnings;
  }

  parse(): LocationNode {
    const node = this.expression();
    if (this.i !== this.s.length) this.fail(`unexpected text '${this.s.slice(this.i, this.i + 40)}'`);
    return node;
  }

  private fail(message: string): never {
    throw new LocationSyntaxError(message);
  }

  /** Match a sticky pattern at the current position (does not advance). */
  private match(pattern: RegExp): RegExpExecArray | null {
    pattern.lastIndex = this.i;
    return pattern.exec(this.s);
  }

  private expect(ch: string): void {
    if (this.s[this.i] !== ch) {
      const found = this.i < this.s.length ? `'${this.s[this.i]}'` : 'end of text';
      this.fail(`expected '${ch}' but found ${found}`);
    }
    this.i++;
  }

  private expression(): LocationNode {
    if (++this.depth > MAX_NESTING) this.fail('location nested too deeply');
    try {
      return this.expressionBody();
    } finally {
      this.depth--;
    }
  }

  private expressionBody(): LocationNode {
    const op = this.match(OPERATOR);
    if (op) {
      const name = op[1].toLowerCase();
      if (name === 'one-of' && this.match(ONE_OF_POSITION_AHEAD)) return this.range(null);
      this.i += op[0].length;
      switch (name) {
        case 'complement': {
          const child = this.expression();
          this.expect(')');
          return { kind: 'complement', child };
        }
        case 'join':
        case 'order':
        case 'bond':
        case 'group': {
          const children = this.list();
          if (name !== 'join') this.warnings.push(`${name}() treated as join()`);
          return { kind: 'join', children };
        }
        case 'one-of': {
          const children = this.list();
          this.warnings.push(`one-of() location: using the first alternative of ${children.length}`);
          return children[0];
        }
        case 'replace': {
          const child = this.expression();
          this.expect(',');
          this.skipQuotedArgument();
          this.expect(')');
          this.warnings.push('replace() location: the replacement sequence is ignored');
          return child;
        }
        default:
          this.fail(`unknown location operator '${op[1]}'`);
      }
    }
    const ref = this.match(REMOTE_PREFIX);
    if (ref) {
      this.i += ref[0].length;
      return this.range(ref[1]);
    }
    return this.range(null);
  }

  /** Comma-separated expressions up to and including the closing ')'. */
  private list(): LocationNode[] {
    const items = [this.expression()];
    while (this.s[this.i] === ',') {
      this.i++;
      if (this.s[this.i] === ')') {
        this.warnings.push('trailing comma in location list ignored');
        break;
      }
      items.push(this.expression());
    }
    this.expect(')');
    return items;
  }

  /** Skips the `"acgt"` argument of the obsolete replace() operator. */
  private skipQuotedArgument(): void {
    if (this.s[this.i] !== '"') {
      while (this.i < this.s.length && this.s[this.i] !== ')') this.i++;
      return;
    }
    const close = this.s.indexOf('"', this.i + 1);
    if (close < 0) this.fail('unterminated string in replace()');
    this.i = close + 1;
  }

  private range(remote: string | null): LocationNode {
    const startAt = this.i;
    const start = this.position();
    let end = start;
    let between: { left: number; right: number } | null = null;
    if (this.s.startsWith('..', this.i)) {
      this.i += 2;
      end = this.position();
    } else if (this.s[this.i] === '^') {
      this.i++;
      const right = this.position();
      if (start.marker || right.marker) this.warnings.push('fuzzy marker on a between-bases site ignored');
      between = { left: start.asEnd, right: right.asStart };
    } else if (this.match(SINGLE_BASE_DOT)) {
      // "102.110": a single base somewhere in 102..110 (no longer allowed in new INSDC entries).
      this.i++;
      end = this.position();
      this.warnings.push(
        `uncertain single-base location '${this.s.slice(startAt, this.i)}' treated as the range ` +
          `${start.asStart}..${end.asEnd}`,
      );
    }
    const text = this.s.slice(startAt, this.i);
    if (between) return { kind: 'between', left: between.left, right: between.right, remote, text };
    if (end === start) {
      // A single base: '<' extends it to the left, '>' to the right.
      const v = start.asStart;
      const lower = start.marker === '<' ? '<' : null;
      const upper = start.marker === '>' ? '>' : null;
      return { kind: 'span', first: v, last: v, lower, upper, remote, text };
    }
    return { kind: 'span', first: start.asStart, last: end.asEnd, lower: start.marker, upper: end.marker, remote, text };
  }

  private position(): Position {
    let marker: Position['marker'] = null;
    const c = this.s[this.i];
    if (c === '<' || c === '>') {
      marker = c;
      this.i++;
    }
    let m = this.match(INTEGER);
    if (m) {
      this.i += m[0].length;
      const v = Number(m[0]);
      return { asStart: v, asEnd: v, marker };
    }
    m = this.match(WITHIN_POSITION);
    if (m) {
      // INSDC "within" position (a.b): the boundary lies somewhere in a..b; use the outer bound.
      this.i += m[0].length;
      const lo = Number(m[1]);
      const hi = Number(m[2]);
      this.warnings.push(`uncertain position '${m[0]}' replaced by its outer bound`);
      return { asStart: Math.min(lo, hi), asEnd: Math.max(lo, hi), marker };
    }
    m = this.match(ONE_OF_POSITION);
    if (m) {
      this.i += m[0].length;
      const first = Number(m[1].split(',')[0]);
      this.warnings.push(`'${m[0]}' position: using the first alternative ${first}`);
      return { asStart: first, asEnd: first, marker };
    }
    if (this.s[this.i] === '?') this.fail("unknown position '?'");
    this.fail(this.i < this.s.length ? `expected a base number at '${this.s.slice(this.i, this.i + 40)}'` : 'expected a base number at end of text');
  }
}

// ---------------------------------------------------------------------------
// From syntax tree to segments
// ---------------------------------------------------------------------------

/** One written part (span or site) in biological 5'->3' order, with its strand. */
interface Part {
  node: Extract<LocationNode, { kind: 'span' } | { kind: 'between' }>;
  strand: 1 | -1;
}

/** Flattens the tree into parts in the feature's 5'->3' order (INSDC semantics of complement/join). */
function collectParts(node: LocationNode, complemented: boolean, out: Part[]): void {
  switch (node.kind) {
    case 'span':
    case 'between':
      out.push({ node, strand: complemented ? -1 : 1 });
      return;
    case 'complement': {
      const inner: Part[] = [];
      collectParts(node.child, !complemented, inner);
      for (let k = inner.length - 1; k >= 0; k--) out.push(inner[k]);
      return;
    }
    case 'join':
      for (const child of node.children) collectParts(child, complemented, out);
      return;
  }
}

/** A resolved 0-based piece of the molecule, in top-strand order within its part. */
interface Piece {
  start: number;
  end: number;
  leftPartial: boolean;
  rightPartial: boolean;
  /**
   * Warning about a '>' marker on the left (lower) boundary, which points into the span: it is
   * stored as "fuzzy" and written back as '<'. Reported only if this boundary ends up as the
   * location's outer boundary; on an inner boundary the marker is dropped anyway (and reported
   * as such).
   */
  leftNote?: string;
  /** Same for a '<' marker on the right (upper) boundary, written back as '>'. */
  rightNote?: string;
}

/**
 * A piece with its partial flags and the notes about inward markers. `a` / `b` are the 1-based
 * base numbers as written; the numbers written back are derived from `start` / `end` (after
 * clamping and origin wrapping), like `formatLocation` does.
 */
function makePiece(start: number, end: number, lower: Marker, upper: Marker, a: number, b: number, L: number): Piece {
  const piece: Piece = { start, end, leftPartial: lower !== null, rightPartial: upper !== null };
  if (lower === '>') {
    piece.leftNote =
      `'>${a}' (lower boundary after base ${a}): the direction cannot be stored; ` +
      `kept as a fuzzy lower boundary, written back as '<${start + 1}'`;
  }
  if (upper === '<') {
    piece.rightNote =
      `'<${b}' (upper boundary before base ${b}): the direction cannot be stored; ` +
      `kept as a fuzzy upper boundary, written back as '>${end > L ? end - L : end}'`;
  }
  return piece;
}

/**
 * Converts one written span (1-based, inclusive `a..b`, boundary markers `lower` / `upper`)
 * into pieces on a molecule of length L, clamping or dropping whatever lies outside it (with
 * warnings).
 */
function resolveSpan(
  a: number,
  b: number,
  lower: Marker,
  upper: Marker,
  text: string,
  L: number,
  topology: Topology,
  warnings: string[],
): Piece[] {
  if (a > b) {
    if (topology === 'circular') {
      if (a > L || b < 1) {
        warnings.push(`'${text}' lies outside the sequence (1..${L}) and was dropped`);
        return [];
      }
      // Origin-spanning shorthand "s..e" with s > e (accepted, but INSDC prefers join(s..L,1..e)).
      return [makePiece(a - 1, L + b, lower, upper, a, b, L)];
    }
    warnings.push(`'${text}': start after end on a linear molecule, interpreted as join(${a}..${L},1..${b})`);
    return [
      ...resolveSpan(a, Math.max(a, L), lower, null, `${a}..${L}`, L, topology, warnings),
      ...resolveSpan(Math.min(1, b), b, null, upper, `1..${b}`, L, topology, warnings),
    ];
  }
  let start = a - 1;
  let end = b;
  let lowerMarker = lower;
  let upperMarker = upper;
  if (end <= 0 || start >= L) {
    warnings.push(`'${text}' lies outside the sequence (1..${L}) and was dropped`);
    return [];
  }
  if (start < 0) {
    // The feature really extends before base 1: '<1' (whatever marker was written).
    warnings.push(`'${text}' starts before base 1: clamped to 1 and marked partial`);
    start = 0;
    lowerMarker = '<';
  }
  if (end > L) {
    if (topology === 'circular') {
      if (end - start > L) {
        warnings.push(`'${text}' is longer than the circular molecule: clamped to one full turn`);
        end = start + L;
      } else {
        warnings.push(`'${text}' ends after base ${L}: read as running over the origin of the circular molecule`);
      }
    } else {
      warnings.push(`'${text}' ends after the last base (${L}): clamped to ${L} and marked partial`);
      end = L;
      upperMarker = '>';
    }
  }
  return [makePiece(start, end, lowerMarker, upperMarker, a, b, L)];
}

/** Converts a between-bases site `left^right` into a zero-length piece (gap position). */
function resolveBetween(
  left: number,
  right: number,
  text: string,
  L: number,
  topology: Topology,
  warnings: string[],
): Piece[] {
  let gap: number;
  if (right === left + 1) {
    gap = left;
  } else if (right === 1 && left === L) {
    // "n^1" with n = length: the origin of a circular molecule (INSDC 3.4.2.1).
    if (topology !== 'circular') warnings.push(`'${text}' (site at the origin) used on a linear molecule`);
    gap = L;
  } else if (right > left + 1) {
    warnings.push(`'${text}' is not between adjacent bases: read as the bases ${left + 1}..${right - 1}`);
    return resolveSpan(left + 1, right - 1, null, null, text, L, topology, warnings);
  } else {
    warnings.push(`'${text}' is not a valid between-bases site and was dropped`);
    return [];
  }
  if (gap < 0 || gap > L) {
    warnings.push(`'${text}' lies outside the sequence (1..${L}) and was dropped`);
    return [];
  }
  if (topology === 'circular' && L > 0) gap %= L;
  return [{ start: gap, end: gap, leftPartial: false, rightPartial: false }];
}

/**
 * Merges consecutive top-strand pieces that continue across the origin of a circular molecule
 * (`...L` followed by `1...`) into one wrapping piece with end > L. The junction boundaries
 * (right of the first piece, left of the second) disappear: callers must have reported fuzzy
 * markers on them (see {@link hasInnerFuzzyBoundary}).
 */
function mergeOriginCrossings(pieces: Piece[], L: number): Piece[] {
  const out: Piece[] = [];
  for (const p of pieces) {
    const prev = out[out.length - 1];
    if (
      prev !== undefined &&
      prev.end === L &&
      p.start === 0 &&
      prev.end > prev.start &&
      p.end > p.start &&
      prev.end - prev.start + p.end <= L
    ) {
      const merged: Piece = { start: prev.start, end: L + p.end, leftPartial: prev.leftPartial, rightPartial: p.rightPartial };
      if (prev.leftNote !== undefined) merged.leftNote = prev.leftNote;
      if (p.rightNote !== undefined) merged.rightNote = p.rightNote;
      out[out.length - 1] = merged;
    } else {
      out.push(p);
    }
  }
  return out;
}

/**
 * True when a boundary between two pieces is fuzzy: only the outer boundaries of a location
 * can carry '<' / '>' in the model (`partialStart` / `partialEnd`). Must be checked BEFORE
 * {@link mergeOriginCrossings}, whose merged junctions are inner boundaries too.
 */
function hasInnerFuzzyBoundary(pieces: readonly Piece[]): boolean {
  const last = pieces.length - 1;
  for (let k = 0; k <= last; k++) {
    if ((pieces[k].leftPartial && k !== 0) || (pieces[k].rightPartial && k !== last)) return true;
  }
  return false;
}

/**
 * Parse an INSDC location string into top-strand segments.
 *
 * Accepted forms: `n`, `a..b`, `<a..b`, `a..>b`, `<a..>b`, `a^b` (zero-length segment at gap a),
 * `a.b` (read as the range a..b, warning), within positions `(a.b)` (outer bound, warning),
 * `one-of(...)` positions or locations (first alternative, warning), `complement()`, `join()`,
 * `order()` / `bond()` (treated as join, warning), nested forms such as `complement(join(...))`
 * and `join(complement(b),complement(a))`, remote parts `AB123.1:10..20` (skipped, warning).
 * Whitespace anywhere in the text is ignored (wrapped lines may be passed as one string).
 *
 * Circular molecules: `s..e` with s > e, and contiguous parts `...L` + `1...`, become one
 * origin-wrapping segment with end > seqLength. Linear molecules: `s..e` with s > e is invalid;
 * it is read as `join(s..L,1..e)` with a warning. Positions before base 1 or after base L are
 * clamped (the feature is then marked partial on that side) or, when a part lies entirely
 * outside the sequence, that part is dropped. Mixed-strand joins take the majority strand
 * (ties: the strand of the first written part) with a warning. Fuzzy markers on inner
 * boundaries of a multi-part location, including the junction of parts merged at the origin,
 * cannot be represented and are dropped with a warning. The model stores only THAT an outer
 * boundary is fuzzy, not its direction, and `formatLocation` writes '<' on the lower and '>'
 * on the upper boundary: a marker pointing into the span ('>a..b', 'a..<b') is kept as fuzzy
 * and its direction change is reported with a warning.
 *
 * Never throws. Returns `{ ok: false }` when the text is not a location, or when no part of
 * it lies on this sequence.
 *
 * @param text location text, 1-based inclusive coordinates
 * @param seqLength length L of the molecule the location refers to (bases or residues)
 * @param topology topology of that molecule
 */
export function parseLocation(text: string, seqLength: number, topology: Topology): LocationParseResult {
  const cleaned = text.replace(/\s+/g, '');
  if (cleaned === '') return { ok: false, error: 'empty location' };
  const warnings: string[] = [];
  let tree: LocationNode;
  try {
    tree = new LocationParser(cleaned, warnings).parse();
  } catch (e) {
    if (e instanceof LocationSyntaxError) return { ok: false, error: `invalid location '${cleaned}': ${e.message}` };
    throw e;
  }

  const parts: Part[] = [];
  collectParts(tree, false, parts);

  // Resolve every local part into pieces (each part keeps its written top-strand order).
  const L = Math.max(0, Math.floor(seqLength));
  const resolved: { pieces: Piece[]; strand: 1 | -1 }[] = [];
  for (const { node, strand } of parts) {
    if (node.remote !== null) {
      warnings.push(`part '${node.remote}:${node.text}' refers to another entry and was skipped`);
      continue;
    }
    const pieces =
      node.kind === 'between'
        ? resolveBetween(node.left, node.right, node.text, L, topology, warnings)
        : resolveSpan(node.first, node.last, node.lower, node.upper, node.text, L, topology, warnings);
    if (pieces.length > 0) resolved.push({ pieces, strand });
  }
  if (resolved.length === 0) {
    const reason = parts.every((p) => p.node.remote !== null)
      ? 'it only refers to other entries'
      : `no part of it lies on this sequence (1..${L})`;
    return { ok: false, error: `location '${cleaned}' cannot be used: ${reason}` };
  }

  // Overall strand: unanimous, or majority with a warning.
  let plus = 0;
  let minus = 0;
  for (const r of resolved) {
    if (r.strand === 1) plus++;
    else minus++;
  }
  let strand: 1 | -1 = plus >= minus ? 1 : -1;
  if (plus > 0 && minus > 0) {
    if (plus === minus) strand = resolved[0].strand;
    warnings.push(
      `mixed-strand location (${plus} forward, ${minus} reverse part(s)): ` +
        `stored on the ${strand === 1 ? 'forward' : 'reverse'} strand`,
    );
  }

  // Parts are in 5'->3' order of the feature; on the reverse strand that is reversed top-strand order.
  const topOrder = strand === -1 ? [...resolved].reverse() : resolved;
  let pieces: Piece[] = [];
  for (const r of topOrder) for (const p of r.pieces) pieces.push(p);
  // Before the origin merge, which turns the junction of '...L' and '1...' into an inner
  // boundary that no longer exists: markers there are lost too and must be reported.
  if (hasInnerFuzzyBoundary(pieces)) warnings.push('fuzzy boundary inside a multi-part location cannot be stored and was ignored');
  if (topology === 'circular' && L > 0) pieces = mergeOriginCrossings(pieces, L);

  const first = pieces[0];
  const last = pieces[pieces.length - 1];
  if (first.leftNote !== undefined) warnings.push(first.leftNote);
  if (last.rightNote !== undefined) warnings.push(last.rightNote);
  return {
    ok: true,
    strand,
    segments: pieces.map((p) => ({ start: p.start, end: p.end })),
    partialStart: first.leftPartial,
    partialEnd: last.rightPartial,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** `a..b` (1-based inclusive) with optional fuzzy markers; a single unmarked base is written `a`. */
function formatSpan(first: number, last: number, leftPartial: boolean, rightPartial: boolean): string {
  if (first === last && !leftPartial && !rightPartial) return String(first);
  return `${leftPartial ? '<' : ''}${first}..${rightPartial ? '>' : ''}${last}`;
}

/** Between-bases site at gap position `gap` (0-based gap = 1-based number of the base on its left). */
function formatBetween(gap: number, L: number, topology: Topology): string {
  if (topology === 'circular' && L > 0 && gap % L === 0) return `${L}^1`;
  return `${gap}^${gap + 1}`;
}

/**
 * Format segments as an INSDC location string (the inverse of {@link parseLocation}).
 *
 * Segments are 0-based half-open ranges in top-strand order; they are normalized first
 * (`normalizeRange`). A segment that wraps the origin of a circular molecule is written
 * `s..L,1..e` inside the join; several pieces are wrapped in `join(...)`; strand -1 puts
 * `complement(...)` around the whole location (the GenBank `complement(join(...))` form);
 * strand 0 is written like strand 1. Zero-length segments become between-bases sites
 * `a^a+1` (`L^1` at the origin of a circular molecule). `partialStart` adds '<' to the first
 * base of the first segment and `partialEnd` adds '>' to the last base of the last segment
 * (ignored on zero-length segments). Returns '' when there are no segments.
 *
 * @param loc strand, segments and partial flags (e.g. a `Feature`)
 * @param seqLength molecule length L
 * @param topology molecule topology
 */
export function formatLocation(loc: LocationLike, seqLength: number, topology: Topology): string {
  const L = Math.max(0, Math.floor(seqLength));
  const n = loc.segments.length;
  if (n === 0) return '';
  const texts: string[] = [];
  loc.segments.forEach((segment, k) => {
    const r = normalizeRange(segment, L, topology);
    const leftPartial = k === 0 && loc.partialStart === true;
    const rightPartial = k === n - 1 && loc.partialEnd === true;
    if (r.end === r.start) {
      texts.push(formatBetween(r.start, L, topology));
      return;
    }
    const pieces = topology === 'circular' && L > 0 ? splitAtOrigin(r, L) : [r];
    pieces.forEach((p, j) => {
      texts.push(formatSpan(p.start + 1, p.end, leftPartial && j === 0, rightPartial && j === pieces.length - 1));
    });
  });
  const body = texts.length === 1 ? texts[0] : `join(${texts.join(',')})`;
  return loc.strand === -1 ? `complement(${body})` : body;
}
