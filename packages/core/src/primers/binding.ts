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
 *    grows while bases match; a mismatch is passed (at most `maxMismatches` times) only when the
 *    next two primer bases match again, i.e. it is followed by at least one Watson–Crick
 *    nearest-neighbour stack. The region then ends where (matched bases − 3 × mismatches) is
 *    largest, the shorter region on ties: a mismatch only counts as annealed when the matching
 *    bases beyond it outweigh it, which for a single mismatch takes at least four of them (see
 *    `MISMATCH_COST`). So a non-annealing 5' tail is not absorbed into the site, with a spurious
 *    mismatch and an inflated Tm, merely because two or three of its bases match by chance.
 *    Mismatches are isolated, the region always ends with a match, and the remaining 5' bases are
 *    the non-annealing tail.
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
   * Mismatches are isolated (the next two primer bases towards the 5' end match) and only count as
   * annealed when enough matching bases beyond them support them (see the module documentation).
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

/** Matching primer bases that must follow a passed mismatch (one nearest-neighbour stack): mismatches stay isolated. */
const RESUME_MATCHES = 2;

/**
 * Cost of one mismatch, in matched bases, when choosing where the annealed region ends: the region
 * ends where (matched bases − MISMATCH_COST × mismatches) is largest, so a single mismatch needs at
 * least MISMATCH_COST + 1 = 4 matching bases beyond it. Rationale, from the SantaLucia & Hicks
 * (2004) nearest-neighbour parameters (primer3_config, as in `thal-tables.ts`): an internal single
 * mismatch costs ΔΔG°37 ≈ +3.7 kcal/mol over the matched duplex (median 3.5; 10th–90th percentile
 * 2.4–5.2 over the 188 tabulated contexts) and each further matched base adds one Watson–Crick stack,
 * −1.41 kcal/mol on average. Extending a site through a mismatch and r matching bases therefore gains
 * about 3.7 − 1.41·(r + 1) kcal/mol: −0.6 for r = 2, −2.0 for r = 3, −3.4 for r = 4. The site's Tm
 * treats mismatches as matches (an upper bound), so only clearly stabilising extensions are counted.
 * Chance matches in a random 5' tail then extend a site through a mismatch with probability 4^−4
 * (0.4 %) instead of 4^−2 (6 %).
 */
const MISMATCH_COST = 3;

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
  if (anchor > L) return sites; // even a circular template offers at most L bases to anneal
  const seeds = planSeeds(seq, anchor, Math.max(anchor, opts.minAnneal), opts.maxMismatches);

  for (const strand of [1, -1] as const) {
    // pattern[k]: code the template base must be accepted by, for the k-th primer base from the 3' end.
    const pattern = new Uint16Array(n);
    for (let k = 0; k < n; k++) {
      const pb = seq[n - 1 - k];
      pattern[k] = (strand === 1 ? pb : complementBase(pb)).charCodeAt(0);
    }
    /** Top-strand index paired with the k-th primer base from the 3' end, for a site whose 3' base pairs with q. */
    const indexAt = (q: number, k: number): number => {
      // 0 <= q < L and k < L, so one wrap at most (cheaper than a modulo in this hot path)
      const i = strand === 1 ? q - k : q + k;
      if (!circular) return i;
      return i < 0 ? i + L : i >= L ? i - L : i;
    };
    const matches = (q: number, k: number): boolean => {
      const t = template.charCodeAt(indexAt(q, k));
      return t < 128 && MATCH[pattern[k] * 128 + t] === 1;
    };

    forEachCandidate(template, seq, strand, seeds, circular, (q) => {
      const limit = Math.min(n, circular ? L : strand === 1 ? q + 1 : L - q);
      if (limit < anchor) return;
      let walked = 0;
      while (walked < anchor && matches(q, walked)) walked++;
      if (walked < anchor) return;
      // Walk towards the 5' end; the annealed region (k bases) ends at the first peak of
      // score = matched bases − MISMATCH_COST × mismatches along the walk.
      let score = walked;
      let walkedMismatches = 0;
      let best = score;
      let k = walked;
      let mismatches = 0;
      while (walked < limit) {
        if (matches(q, walked)) {
          walked++;
          score++;
        } else if (
          walkedMismatches < opts.maxMismatches &&
          walked + RESUME_MATCHES < limit &&
          matches(q, walked + 1) &&
          matches(q, walked + 2)
        ) {
          walkedMismatches++;
          walked += 1 + RESUME_MATCHES;
          score += RESUME_MATCHES - MISMATCH_COST;
        } else {
          break;
        }
        if (score > best) {
          best = score;
          k = walked;
          mismatches = walkedMismatches;
        }
      }
      if (k < opts.minAnneal) return;
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
    });
  }
  return sites.sort(compareSites);
}

// ---------------------------------------------------------------------------
// Candidate positions: exact seeds
// ---------------------------------------------------------------------------

/** Primer bases [from, to), counted from the 3' end (0 = 3'-terminal base), that a site must match exactly. */
interface Seed {
  from: number;
  to: number;
}

/**
 * Seeding is skipped (every position is tried) when the chosen seeds would still let through more
 * than this fraction of template positions: one direct pass is then cheaper than the seed searches
 * plus the de-duplication of their hits (each candidate costs far more to verify than to find).
 */
const MAX_SEED_RATE = 1 / 2;

/** Largest (parts × span²) for which the pigeonhole split is optimised (larger only with absurd options). */
const MAX_SPLIT_WORK = 4_000_000;

/**
 * Exact-match seeds for the search: primer-base ranges (from the 3' end) such that every binding
 * site matches at least one of them exactly, chosen to minimise the expected number of candidate
 * positions on a random template (a base accepting s of A/C/G/T lets through s/4 of the positions).
 * Returns null when no choice lets through fewer than {@link MAX_SEED_RATE} of the positions; every
 * position is then tried.
 *
 * Why the seeds cannot miss a site: a site anneals at least the `window` = max(anchor3, minAnneal)
 * 3'-terminal bases with at most m = `maxMismatches` mismatches, none in the anchor. With m = 0 the
 * whole window matches. Otherwise the anchor alone matches, and so does one of any m + 1 disjoint
 * parts of [anchor, window) (pigeonhole principle); the first part is joined to the anchor, and the
 * split is chosen by dynamic programming. A seed is a superset filter only: every candidate is
 * verified base by base.
 */
function planSeeds(seq: string, anchor: number, window: number, maxMismatches: number): Seed[] | null {
  const n = seq.length;
  // bits[k]: log2(4 / number of bases the k-th primer base from the 3' end accepts); prefix sums in `sum`.
  const sum = new Float64Array(window + 1);
  for (let k = 0; k < window; k++) sum[k + 1] = sum[k] + Math.log2(4 / IUPAC_DNA[seq[n - 1 - k]].length);
  /** Fraction of random positions where primer bases [from, to) match exactly. */
  const rate = (from: number, to: number): number => 2 ** (sum[from] - sum[to]);

  const plans: { seeds: Seed[]; rate: number }[] = [];
  if (maxMismatches === 0) {
    plans.push({ seeds: [{ from: 0, to: window }], rate: rate(0, window) });
  } else {
    if (anchor > 0) plans.push({ seeds: [{ from: 0, to: anchor }], rate: rate(0, anchor) });
    const parts = maxMismatches + 1;
    const span = window - anchor;
    if (span >= parts && parts * span * span <= MAX_SPLIT_WORK) {
      // cost[j][e]: least summed rate of j non-empty parts covering [anchor, e), the first one starting at 0.
      const width = window + 1;
      const cost = new Float64Array((parts + 1) * width).fill(Infinity);
      const split = new Int32Array((parts + 1) * width).fill(-1);
      for (let e = anchor + 1; e <= window; e++) cost[width + e] = rate(0, e);
      for (let j = 2; j <= parts; j++) {
        for (let e = anchor + j; e <= window; e++) {
          for (let s = anchor + j - 1; s < e; s++) {
            const c = cost[(j - 1) * width + s] + rate(s, e);
            if (c < cost[j * width + e]) {
              cost[j * width + e] = c;
              split[j * width + e] = s;
            }
          }
        }
      }
      const seeds: Seed[] = [];
      let e = window;
      for (let j = parts; j >= 2; j--) {
        const s = split[j * width + e];
        seeds.push({ from: s, to: e });
        e = s;
      }
      seeds.push({ from: 0, to: e });
      plans.push({ seeds: seeds.reverse(), rate: cost[parts * width + window] });
    }
  }
  let best = plans[0];
  for (const plan of plans) if (plan.rate < best.rate) best = plan;
  if (best === undefined || best.rate > MAX_SEED_RATE) return null;
  // Bases accepting all four (N) filter nothing: drop them from the ends of each seed, so that most
  // seeds become plain A/C/G/T text (substring search instead of a regular expression).
  return best.seeds.map(({ from, to }) => {
    while (sum[from + 1] === sum[from]) from++;
    while (sum[to] === sum[to - 1]) to--;
    return { from, to };
  });
}

/**
 * Call `visit` once for every template index q that may pair with the primer's 3'-terminal base on
 * `strand`: the positions where some seed matches exactly (see {@link planSeeds}), or every index
 * when `seeds` is null. Each candidate is fully verified by the caller.
 */
function forEachCandidate(
  template: string,
  seq: string,
  strand: 1 | -1,
  seeds: readonly Seed[] | null,
  circular: boolean,
  visit: (q: number) => void,
): void {
  const L = template.length;
  if (seeds === null) {
    for (let q = 0; q < L; q++) visit(q);
    return;
  }
  if (seeds.length === 1) {
    forEachSeedMatch(template, seq, strand, seeds[0], circular, visit);
    return;
  }
  // Several seeds may match at the same position: collect, then visit each position once.
  const candidate = new Uint8Array(L);
  for (const seed of seeds) {
    forEachSeedMatch(template, seq, strand, seed, circular, (q) => {
      candidate[q] = 1;
    });
  }
  for (let q = 0; q < L; q++) if (candidate[q] === 1) visit(q);
}

/**
 * Call `visit` with the template index q paired with the primer's 3'-terminal base for every exact
 * occurrence of `seed` on `strand` (each q once), plus, on circular templates, every q whose seed
 * would span the origin (not searched as text; verified by the caller like any candidate).
 */
function forEachSeedMatch(
  template: string,
  seq: string,
  strand: 1 | -1,
  seed: Seed,
  circular: boolean,
  visit: (q: number) => void,
): void {
  const n = seq.length;
  const L = template.length;
  const length = seed.to - seed.from;
  const bases = seq.slice(n - seed.to, n - seed.from);
  // Top-strand text the seed occupies (forward: the primer bases; reverse: their reverse complement),
  // and q relative to the index x of that text's first base.
  const topPattern = strand === 1 ? bases : reverseComplement(bases);
  const offset = strand === 1 ? seed.to - 1 : -seed.from;
  const emit = (x: number): void => {
    const q = x + offset;
    if (circular) visit(mod(q, L));
    else if (q >= 0 && q < L) visit(q);
  };
  for (const x of seedOccurrences(template, topPattern)) emit(x);
  if (circular) for (let x = Math.max(0, L - length + 1); x < L; x++) emit(x);
}

function compareSites(a: PrimerBindingSite, b: PrimerBindingSite): number {
  return a.range.start - b.range.start || b.strand - a.strand || a.range.end - b.range.end;
}

/**
 * {@link findBindingSites} for several primers. Sites are sorted by `range.start` (then forward
 * before reverse, `range.end`, and the order of `primers`); a site reported twice for the same
 * primer id (duplicate entries in `primers`) is listed once.
 *
 * All or nothing: when any primer fails (a non-IUPAC character in its sequence, more than
 * `maxSites` sites, conditions its Tm cannot use) this throws that primer's RangeError, which
 * names the primer, and returns no site of any primer. Use {@link scanBindingSites} to keep the
 * other primers' sites and get the failures per primer (e.g. for a document's primer list).
 * Invalid options throw a RangeError in both.
 */
export function findAllBindingSites(
  template: string,
  topology: Topology,
  primers: readonly Primer[],
  options?: BindingOptions,
): PrimerBindingSite[] {
  return collectSites(template, topology, primers, options, (_primer, error) => {
    throw error;
  });
}

/** A primer whose binding sites {@link scanBindingSites} could not list. */
export interface PrimerBindingFailure {
  /** `id` of the primer. */
  primerId: string;
  /**
   * Why, as a message naming the primer: a non-IUPAC character in its sequence (with its
   * position), more than `maxSites` sites, or Tm conditions that cannot be used for its sites.
   */
  message: string;
}

/** Result of {@link scanBindingSites}. */
export interface BindingScan {
  /** Sites of every primer that could be scanned, ordered and de-duplicated as by {@link findAllBindingSites}. */
  sites: PrimerBindingSite[];
  /** The primers that failed, in the order of `primers` (once per id and message); none of their sites are in `sites`. */
  failures: PrimerBindingFailure[];
}

/**
 * {@link findAllBindingSites} that isolates failures: a primer that fails (see there) is reported in
 * `failures` and the other primers' sites are still returned, so one over-degenerate or mistyped
 * primer cannot hide every other primer's sites. Invalid options (shared by every primer) still
 * throw a RangeError.
 */
export function scanBindingSites(
  template: string,
  topology: Topology,
  primers: readonly Primer[],
  options?: BindingOptions,
): BindingScan {
  const failures: PrimerBindingFailure[] = [];
  const reported = new Set<string>();
  const sites = collectSites(template, topology, primers, options, (primer, error) => {
    const key = `${primer.id}\u0000${error.message}`;
    if (reported.has(key)) return;
    reported.add(key);
    failures.push({ primerId: primer.id, message: error.message });
  });
  return { sites, failures };
}

/** Sites of `primers`, merged, sorted and de-duplicated; a primer's RangeError goes to `onFailure` (which may rethrow). */
function collectSites(
  template: string,
  topology: Topology,
  primers: readonly Primer[],
  options: BindingOptions | undefined,
  onFailure: (primer: Primer, error: RangeError) => void,
): PrimerBindingSite[] {
  const opts = resolveBindingOptions(options);
  const top = canonicalTemplate(template);
  const all: { site: PrimerBindingSite; order: number }[] = [];
  const seen = new Set<string>();
  primers.forEach((primer, order) => {
    let sites: PrimerBindingSite[];
    try {
      sites = sitesOnCanonicalTemplate(top, topology, primer, opts);
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      onFailure(primer, error);
      return;
    }
    for (const site of sites) {
      const key = `${site.primerId}\u0000${site.strand}\u0000${site.range.start}\u0000${site.range.end}`;
      if (seen.has(key)) continue;
      seen.add(key);
      all.push({ site, order });
    }
  });
  all.sort((a, b) => compareSites(a.site, b.site) || a.order - b.order);
  return all.map((x) => x.site);
}
