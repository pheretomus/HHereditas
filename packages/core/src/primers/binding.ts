/**
 * Primer binding sites: where a primer's 3' end anneals to a template and could prime DNA synthesis.
 *
 * Semantics (coordinates follow `types.ts`: 0-based half-open top-strand ranges; on circular
 * templates a site that crosses the origin has `range.end > L`):
 *
 *  - Forward site (strand 1): the primer has the top-strand sequence, anneals to the bottom strand
 *    and extends rightwards. Reverse site (strand -1): the primer's reverse complement is on the top
 *    strand; it anneals to the top strand and extends leftwards.
 *  - Bases are compared from the primer's 3' end towards its 5' end. A primer base matches a
 *    template base when `iupacMatches(primerBase, templateBase)` holds (for reverse sites:
 *    `iupacMatches(complement(primerBase), templateBase)`): an ambiguous primer base accepts every
 *    base it stands for, while an ambiguous template base (e.g. N) only matches a primer base that
 *    accepts all of its possibilities.
 *  - The `anchor3` 3'-terminal primer bases must all match. Towards the 5' end the annealed region
 *    grows while bases match; a mismatch is accepted (at most `maxMismatches` times) only when the
 *    next two primer bases match again, i.e. it is followed by at least one Watson–Crick
 *    nearest-neighbour stack. Mismatches are therefore isolated, the region always ends with a match,
 *    and the remaining 5' bases are the non-annealing tail.
 *  - A site is reported when its annealed length is at least `minAnneal`. The annealed region never
 *    exceeds the template: linear templates stop at their ends, circular ones after L bases.
 *  - Characters: the template is read as stored in a SeqRecord (upper-case IUPAC), with U read as T
 *    (RNA records keep U) and ASCII lower case read as upper case; any other template character never
 *    matches. The primer may use either case and U; any other character is an error. Only ASCII
 *    letters are case-folded (see `normalize.ts`), so lengths and positions never shift.
 */
import type { Primer, PrimerBindingSite, Topology } from '../types';
import { IUPAC_DNA, complementBase, iupacMatches, reverseComplement } from '../seq/alphabet';
import { mod } from '../seq/range';
import { canonicalOligo, canonicalTemplate } from './normalize';
import { resolveTmConditions, tmResolved, type TmConditions } from './tm';

/** Options for {@link findBindingSites}. All lengths are in nucleotides. */
export interface BindingOptions {
  /** Minimum number of 3'-terminal primer bases that must anneal (annealedLength >= minAnneal). Default 15. */
  minAnneal?: number;
  /** Number of 3'-terminal primer bases that must match perfectly, even when mismatches are allowed. Default 5. */
  anchor3?: number;
  /**
   * Maximum number of mismatches inside the annealed region. Default 0 (perfect match).
   * A mismatch only counts as annealed when the next two primer bases towards the 5' end match.
   */
  maxMismatches?: number;
  /** Compute the Tm of the annealed part of the primer (see {@link PrimerBindingSite.tm}). Default true. */
  computeTm?: boolean;
  /** Reaction conditions for the Tm; defaults to `DEFAULT_TM_CONDITIONS` (primer3's). */
  conditions?: Partial<TmConditions>;
  /**
   * Safety limit on the number of sites of ONE primer. A RangeError is thrown when a primer has more
   * sites (e.g. a highly degenerate primer on a genome) instead of silently truncating. Default 100 000.
   */
  maxSites?: number;
}

/** Defaults applied by {@link findBindingSites}. */
export const DEFAULT_BINDING_OPTIONS: Readonly<Required<Omit<BindingOptions, 'conditions'>>> = Object.freeze({
  minAnneal: 15,
  anchor3: 5,
  maxMismatches: 0,
  computeTm: true,
  maxSites: 100_000,
});

/** Matching primer bases that must follow an accepted mismatch (one nearest-neighbour stack). */
const RESUME_MATCHES = 2;

const IUPAC_CODES = Object.keys(IUPAC_DNA);

/** MATCH[pattern * 128 + base] = 1 when IUPAC code `pattern` accepts template code `base`. */
const MATCH: Uint8Array = (() => {
  const table = new Uint8Array(128 * 128);
  for (const p of IUPAC_CODES) {
    for (const b of IUPAC_CODES) {
      if (iupacMatches(p, b)) table[p.charCodeAt(0) * 128 + b.charCodeAt(0)] = 1;
    }
  }
  return table;
})();

function nonNegativeInteger(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 0) throw new RangeError(`Binding option ${name} must be an integer >= 0 (got ${value})`);
  return value;
}

interface ResolvedBindingOptions {
  minAnneal: number;
  anchor3: number;
  maxMismatches: number;
  maxSites: number;
  conditions: TmConditions | undefined;
}

function resolveBindingOptions(options: BindingOptions | undefined): ResolvedBindingOptions {
  const o = { ...DEFAULT_BINDING_OPTIONS, ...stripUndefined(options ?? {}) };
  return {
    minAnneal: Math.max(1, nonNegativeInteger('minAnneal', o.minAnneal)),
    anchor3: nonNegativeInteger('anchor3', o.anchor3),
    maxMismatches: nonNegativeInteger('maxMismatches', o.maxMismatches),
    maxSites: o.maxSites === Infinity ? Infinity : nonNegativeInteger('maxSites', o.maxSites),
    conditions: o.computeTm ? resolveTmConditions(options?.conditions) : undefined,
  };
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  const out: Partial<T> = {};
  for (const key of Object.keys(o) as (keyof T)[]) if (o[key] !== undefined) out[key] = o[key];
  return out;
}

/** RegExp source matching every template code accepted by each pattern character, or null if a character accepts nothing. */
function seedRegexSource(pattern: string): string | null {
  let source = '';
  for (const ch of pattern) {
    let cls = '';
    for (const code of IUPAC_CODES) if (iupacMatches(ch, code)) cls += code;
    if (cls === '') return null;
    source += cls.length === 1 ? cls : `[${cls}]`;
  }
  return source;
}

/** Start indices of every (overlapping) occurrence of an IUPAC seed pattern in the template, lazily. */
function* seedOccurrences(template: string, pattern: string): Generator<number> {
  if (/^[ACGT]+$/.test(pattern)) {
    // An unambiguous primer base only accepts the identical template base: plain substring search.
    for (let x = template.indexOf(pattern); x !== -1; x = template.indexOf(pattern, x + 1)) yield x;
    return;
  }
  const source = seedRegexSource(pattern);
  if (source === null) return;
  const re = new RegExp(source, 'g');
  for (let m = re.exec(template); m !== null; m = re.exec(template)) {
    yield m.index;
    re.lastIndex = m.index + 1;
  }
}

/**
 * Find where `primer` binds `template` on both strands. See the module documentation for the exact
 * semantics.
 *
 * `template` is the top-strand sequence as stored in a SeqRecord (upper-case IUPAC); RNA records
 * may contain U, which is read as T (a DNA primer anneals to an RNA template as to its DNA form),
 * ASCII lower case is read as upper case, and any other character never matches.
 *
 * Returns sites sorted by `range.start` (then forward before reverse, then `range.end`), without
 * duplicates. `range` covers the annealed bases in top-strand coordinates (normalized; may wrap the
 * origin on circular templates), `annealedLength` = range length, `tailLength` =
 * primer length − annealedLength. When `computeTm` (default), `tm` is the Tm (°C) of the annealed
 * part of the primer under `conditions`, with degenerate primer bases resolved to the template
 * bases they pair with; mismatches are not penalised, so for mismatched sites it is an upper
 * bound. `tm` is omitted when fewer than 2 bases anneal. An empty primer or template has no sites.
 * The primer may be lowercase (U is read as T); any other character (checked before any case
 * conversion) throws a RangeError, as do invalid options and more than `maxSites` sites.
 */
export function findBindingSites(
  template: string,
  topology: Topology,
  primer: Primer,
  options?: BindingOptions,
): PrimerBindingSite[] {
  return sitesOnCanonicalTemplate(canonicalTemplate(template), topology, primer, resolveBindingOptions(options));
}

/** {@link findBindingSites} on a template already read by `canonicalTemplate`. */
function sitesOnCanonicalTemplate(
  template: string,
  topology: Topology,
  primer: Primer,
  opts: ResolvedBindingOptions,
): PrimerBindingSite[] {
  const seq = canonicalOligo(primer.sequence, `Primer '${primer.name || primer.id}'`);
  const n = seq.length;
  const L = template.length;
  const circular = topology === 'circular';
  const sites: PrimerBindingSite[] = [];
  if (n === 0 || L === 0 || opts.minAnneal > Math.min(n, L)) return sites;
  const anchor = Math.min(opts.anchor3, n);
  // Every annealed base matches when no mismatch is allowed, so the whole minimal region is an exact seed.
  const seedLength = opts.maxMismatches === 0 ? Math.max(anchor, opts.minAnneal) : anchor;
  if (seedLength > L) return sites;

  for (const strand of [1, -1] as const) {
    // pattern[k]: code the template base must be accepted by, for the k-th primer base from the 3' end.
    const pattern = new Uint16Array(n);
    for (let k = 0; k < n; k++) {
      const pb = seq[n - 1 - k];
      pattern[k] = (strand === 1 ? pb : complementBase(pb)).charCodeAt(0);
    }
    /** Top-strand index paired with the k-th primer base from the 3' end, for a site whose 3' base pairs with q. */
    const indexAt = (q: number, k: number): number => {
      const i = strand === 1 ? q - k : q + k;
      return circular ? mod(i, L) : i;
    };
    const matches = (q: number, k: number): boolean => {
      const p = pattern[k];
      const t = template.charCodeAt(indexAt(q, k));
      return p < 128 && t < 128 && MATCH[p * 128 + t] === 1;
    };

    for (const q of candidatePositions(template, seq, strand, seedLength, circular)) {
      const limit = Math.min(n, circular ? L : strand === 1 ? q + 1 : L - q);
      if (limit < anchor) continue;
      let k = 0;
      while (k < anchor && matches(q, k)) k++;
      if (k < anchor) continue;
      let mismatches = 0;
      while (k < limit) {
        if (matches(q, k)) {
          k++;
        } else if (
          mismatches < opts.maxMismatches &&
          k + RESUME_MATCHES < limit &&
          matches(q, k + 1) &&
          matches(q, k + 2)
        ) {
          mismatches++;
          k += 1 + RESUME_MATCHES;
        } else {
          break;
        }
      }
      if (k < opts.minAnneal) continue;
      const start = strand === 1 ? (circular ? mod(q - k + 1, L) : q - k + 1) : q;
      const site: PrimerBindingSite = {
        primerId: primer.id,
        strand,
        range: { start, end: start + k },
        annealedLength: k,
        mismatches,
        tailLength: n - k,
      };
      if (opts.conditions && k >= 2) {
        // 5'→3' annealed part of the primer; ambiguous primer bases take the template base they pair with.
        let annealed = '';
        for (let j = k - 1; j >= 0; j--) {
          const pb = seq[n - 1 - j];
          if (IUPAC_DNA[pb]?.length === 1 || !matches(q, j)) {
            annealed += pb;
          } else {
            const tb = template[indexAt(q, j)];
            annealed += strand === 1 ? tb : complementBase(tb);
          }
        }
        site.tm = tmResolved(annealed, opts.conditions);
      }
      sites.push(site);
      if (sites.length > opts.maxSites) {
        throw new RangeError(
          `Primer '${primer.name || primer.id}' has more than ${opts.maxSites} binding sites; ` +
            'it is too degenerate or too short for this template (raise maxSites to list them all).',
        );
      }
    }
  }
  return sites.sort(compareSites);
}

/**
 * Template indices that may pair with the primer's 3'-terminal base on `strand`: exact
 * occurrences of the `seedLength` 3'-terminal bases, plus (circular templates) every position
 * whose seed would span the origin. Each candidate is fully verified by the caller.
 */
function* candidatePositions(
  template: string,
  seq: string,
  strand: 1 | -1,
  seedLength: number,
  circular: boolean,
): Generator<number> {
  const L = template.length;
  if (seedLength === 0) {
    for (let q = 0; q < L; q++) yield q;
    return;
  }
  const seed3 = seq.slice(seq.length - seedLength);
  // Top-strand text the seed occupies: forward = the primer bases; reverse = their reverse complement.
  const topPattern = strand === 1 ? seed3 : reverseComplement(seed3);
  for (const x of seedOccurrences(template, topPattern)) yield strand === 1 ? x + seedLength - 1 : x;
  if (circular) {
    for (let w = 0; w < seedLength - 1; w++) yield strand === 1 ? w : L - seedLength + 1 + w;
  }
}

function compareSites(a: PrimerBindingSite, b: PrimerBindingSite): number {
  return a.range.start - b.range.start || b.strand - a.strand || a.range.end - b.range.end;
}

/**
 * {@link findBindingSites} for several primers. Sites are sorted by `range.start` (then forward
 * before reverse, `range.end`, and the order of `primers`); a site reported twice for the same
 * primer id (duplicate entries in `primers`) is listed once.
 */
export function findAllBindingSites(
  template: string,
  topology: Topology,
  primers: readonly Primer[],
  options?: BindingOptions,
): PrimerBindingSite[] {
  const opts = resolveBindingOptions(options);
  const top = canonicalTemplate(template);
  const all: { site: PrimerBindingSite; order: number }[] = [];
  const seen = new Set<string>();
  primers.forEach((primer, order) => {
    for (const site of sitesOnCanonicalTemplate(top, topology, primer, opts)) {
      const key = `${site.primerId}\u0000${site.strand}\u0000${site.range.start}\u0000${site.range.end}`;
      if (seen.has(key)) continue;
      seen.add(key);
      all.push({ site, order });
    }
  });
  all.sort((a, b) => compareSites(a.site, b.site) || a.order - b.order);
  return all.map((x) => x.site);
}
