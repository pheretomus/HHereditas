/**
 * Restriction enzyme model and catalogue helpers.
 *
 * CUT OFFSETS. Every cleavage event of an enzyme is a pair of GAP positions (see the coordinate
 * conventions in `types.ts`) counted from the first base of the recognition site, both expressed
 * in TOP-strand coordinates, for the site read 5'->3' on the top strand:
 *
 *   EcoRI  G^AATTC          -> { top: 1, bottom: 5 }   (5' overhang AATT)
 *   PstI   CTGCA^G          -> { top: 5, bottom: 1 }   (3' overhang TGCA)
 *   SmaI   CCC^GGG          -> { top: 3, bottom: 3 }   (blunt)
 *   BsaI   GGTCTC(1/5)      -> { top: 7, bottom: 11 }  (cuts outside the site)
 *   BaeI   (10/15)ACNNNNGTAYC(12/7) -> [{ top: -10, bottom: -15 }, { top: 23, bottom: 18 }]
 *
 * Offsets may be negative or larger than the site length. `top < bottom` gives a 5' overhang,
 * `top > bottom` a 3' overhang, `top === bottom` a blunt end.
 */
import type { EndKind } from '../types';
import { IUPAC_DNA, reverseComplement } from '../seq/alphabet';
import { ENZYME_ROWS, METHYL_DIRECTED_ENZYMES } from './data';
import type { EnzymeRow } from './data';

/**
 * One cleavage event, relative to the recognition site: gap positions counted from the first
 * base of the site (0 = just before it, `site.length` = just after it), top-strand coordinates.
 */
export interface EnzymeCut {
  /** Gap position of the cut in the top strand. */
  top: number;
  /** Gap position of the cut in the bottom strand, expressed in top-strand coordinates. */
  bottom: number;
}

/** A restriction endonuclease (catalogue entry or user-defined). See the file comment for cut offsets. */
export interface RestrictionEnzyme {
  /** Name as written by REBASE, e.g. 'EcoRI'. */
  name: string;
  /** Recognition sequence 5'->3' on the top strand, uppercase IUPAC (e.g. 'GAATTC', 'GCCNNNNNGGC'). */
  site: string;
  /**
   * One entry per cleavage event (two for enzymes such as BaeI/CspCI that cut on both sides of
   * their site). Gap offsets relative to the first base of the site, top-strand coordinates.
   */
  cuts: ReadonlyArray<EnzymeCut>;
  /** REBASE supplier codes (see `SUPPLIERS`), e.g. 'BN'; '' when not sold. */
  suppliers: string;
  /** True when at least one supplier sells the enzyme. */
  commercial: boolean;
  /**
   * True for enzymes REBASE classifies as methyl-directed: they only cleave a METHYLATED site
   * (e.g. DpnI needs Dam-methylated GATC), so they do not cut PCR products. Absent = false.
   */
  methylDirected?: boolean;
}

/** End produced by an enzyme's first cleavage event. */
export interface Overhang {
  /** '5prime' when top < bottom, '3prime' when top > bottom, 'blunt' when equal. */
  kind: EndKind;
  /** Number of unpaired bases (|top - bottom|), 0 for blunt ends. */
  length: number;
  /**
   * The single-stranded bases written 5'->3' on the TOP strand (e.g. EcoRI 'AATT', PstI 'TGCA',
   * '' for blunt ends). Only present when the overhang is fully inside the recognition site and
   * contains only A/C/G/T; absent when it depends on the target (Type IIS, degenerate sites).
   */
  sequence?: string;
}

const UNAMBIGUOUS = /^[ACGT]*$/;

/** True if the IUPAC `site` equals its own reverse complement (e.g. GAATTC, GCCNNNNNGGC). Case-insensitive. */
export function isPalindromic(site: string): boolean {
  const s = site.toUpperCase();
  return s === reverseComplement(s);
}

/**
 * The end left by the FIRST cleavage event of `enzyme` (for two-cut enzymes both events produce
 * the same kind of end in REBASE data). Throws if the enzyme has no cleavage event.
 */
export function overhang(enzyme: RestrictionEnzyme): Overhang {
  const cut = enzyme.cuts[0];
  if (cut === undefined) throw new Error(`Enzyme ${enzyme.name} has no cleavage positions`);
  const length = Math.abs(cut.top - cut.bottom);
  if (length === 0) return { kind: 'blunt', length: 0, sequence: '' };
  const kind: EndKind = cut.top < cut.bottom ? '5prime' : '3prime';
  const from = Math.min(cut.top, cut.bottom);
  const to = Math.max(cut.top, cut.bottom);
  const site = enzyme.site.toUpperCase();
  if (from >= 0 && to <= site.length) {
    const sequence = site.slice(from, to);
    if (UNAMBIGUOUS.test(sequence)) return { kind, length, sequence };
  }
  return { kind, length };
}

/**
 * True if any cut (top or bottom) of any cleavage event lies outside the recognition site,
 * i.e. at a gap position < 0 or > site length (Type IIS-like enzymes such as BsaI, BaeI, MlyI).
 * Cuts exactly at the site boundary (MboI ^GATC, NlaIII CATG^) count as inside.
 */
export function cutsOutsideSite(enzyme: RestrictionEnzyme): boolean {
  const n = enzyme.site.length;
  return enzyme.cuts.some((c) => c.top < 0 || c.top > n || c.bottom < 0 || c.bottom > n);
}

/**
 * Effective recognition length in "fully specified bases": the sum over site positions of
 * log4(4 / number of bases accepted), so A/C/G/T count 1, R/Y/S/W/K/M 0.5, B/D/H/V ~0.21, N 0.
 * A random sequence contains a site about once every 4^effectiveSiteLength bp per strand
 * orientation (EcoRI and BglI GCCNNNNNGGC: 6; AvaI CYCGRG: 5).
 */
export function effectiveSiteLength(site: string): number {
  let bits = 0;
  for (const ch of site.toUpperCase()) {
    const set = IUPAC_DNA[ch];
    if (set === undefined) return Number.NaN;
    bits += Math.log2(4 / set.length);
  }
  return bits / 2;
}

/**
 * REBASE-style cleavage notation for display: 'G^AATTC', 'CTGCA^G', '^GATC', 'GGTCTC(1/5)',
 * '(10/15)ACNNNNGTAYC(12/7)'. A caret is used when the enzyme cuts once inside its site with the
 * usual symmetric pair (bottom = site length - top); otherwise each event is written as
 * (top/bottom) distances in bases, before the site for events upstream of it and after the site
 * (counted from its last base, negative = inside) otherwise.
 */
export function cutNotation(enzyme: RestrictionEnzyme): string {
  const site = enzyme.site.toUpperCase();
  const n = site.length;
  const only = enzyme.cuts.length === 1 ? enzyme.cuts[0] : undefined;
  if (only !== undefined && only.top >= 0 && only.top <= n && only.top + only.bottom === n) {
    return `${site.slice(0, only.top)}^${site.slice(only.top)}`;
  }
  let before = '';
  let after = '';
  for (const c of enzyme.cuts) {
    if (c.top <= 0 && c.bottom <= 0) before += `(${-c.top}/${-c.bottom})`;
    else after += `(${c.top - n}/${c.bottom - n})`;
  }
  return `${before}${site}${after}`;
}

// ---------------------------------------------------------------------------
// Isoschizomers
// ---------------------------------------------------------------------------

/**
 * Orientation in which `b`'s site has to be read to equal `a`'s site: 'same', 'reverse'
 * (b.site is the reverse complement of a.site), or undefined when they recognise different sequences.
 */
function relativeOrientation(a: RestrictionEnzyme, b: RestrictionEnzyme): 'same' | 'reverse' | undefined {
  const sa = a.site.toUpperCase();
  const sb = b.site.toUpperCase();
  if (sa === sb) return 'same';
  if (sa === reverseComplement(sb)) return 'reverse';
  return undefined;
}

/**
 * Canonical text key of an enzyme's cleavage events: optionally mirrored onto the reverse
 * complement of its site (event (t, b) -> (n - b, n - t)); for palindromic sites both
 * orientations are recognised, so the mirrored events are included as well.
 */
function cleavageKey(enzyme: RestrictionEnzyme, mirror: boolean): string {
  const n = enzyme.site.length;
  const flip = (c: EnzymeCut): EnzymeCut => ({ top: n - c.bottom, bottom: n - c.top });
  const events = enzyme.cuts.map((c) => (mirror ? flip(c) : c));
  if (isPalindromic(enzyme.site)) events.push(...events.map(flip));
  const keys = new Set(events.map((c) => `${c.top}/${c.bottom}`));
  return [...keys].sort().join(',');
}

function sameName(a: RestrictionEnzyme, b: RestrictionEnzyme): boolean {
  return a.name.toLowerCase() === b.name.toLowerCase();
}

/**
 * Enzymes of `list` (default: the whole catalogue) that recognise the same sequences as `enzyme`
 * (identical site, or a site written as its reverse complement), whatever their cleavage.
 * `enzyme` itself (matched by name) is excluded. Order follows `list`.
 */
export function isoschizomers(
  enzyme: RestrictionEnzyme,
  list: readonly RestrictionEnzyme[] = ENZYMES,
): RestrictionEnzyme[] {
  return list.filter((e) => !sameName(e, enzyme) && relativeOrientation(enzyme, e) !== undefined);
}

/** Isoschizomers of `enzyme` that cleave at different positions (e.g. SmaI CCC^GGG vs XmaI C^CCGGG). */
export function neoschizomers(
  enzyme: RestrictionEnzyme,
  list: readonly RestrictionEnzyme[] = ENZYMES,
): RestrictionEnzyme[] {
  return isoschizomers(enzyme, list).filter(
    (e) => cleavageKey(e, relativeOrientation(enzyme, e) === 'reverse') !== cleavageKey(enzyme, false),
  );
}

/** Isoschizomers of `enzyme` that also cleave at the same positions (e.g. SacI and SstI, both GAGCT^C). */
export function equischizomers(
  enzyme: RestrictionEnzyme,
  list: readonly RestrictionEnzyme[] = ENZYMES,
): RestrictionEnzyme[] {
  return isoschizomers(enzyme, list).filter(
    (e) => cleavageKey(e, relativeOrientation(enzyme, e) === 'reverse') === cleavageKey(enzyme, false),
  );
}

// ---------------------------------------------------------------------------
// Validation and construction of user-defined enzymes
// ---------------------------------------------------------------------------

/** Largest |cut offset| accepted by {@link validateEnzyme} (REBASE maximum is 28; generous margin). */
const MAX_CUT_OFFSET = 1000;

/**
 * Problems that make `enzyme` unusable for searching/digestion (empty list = valid):
 * empty name, empty or non-IUPAC site, no cleavage event, non-integer or absurd cut offsets.
 * Lower-case sites are accepted (the search upper-cases them).
 */
export function validateEnzyme(enzyme: RestrictionEnzyme): string[] {
  const problems: string[] = [];
  if (enzyme.name.trim() === '') problems.push('name is empty');
  const site = enzyme.site.toUpperCase();
  if (site === '') problems.push('recognition site is empty');
  for (const ch of new Set(site)) {
    if (IUPAC_DNA[ch] === undefined) problems.push(`recognition site contains '${ch}', which is not an IUPAC nucleotide code`);
  }
  if (enzyme.cuts.length === 0) problems.push('no cleavage positions');
  for (const c of enzyme.cuts) {
    for (const v of [c.top, c.bottom]) {
      if (!Number.isInteger(v) || Math.abs(v) > MAX_CUT_OFFSET) problems.push(`invalid cut offset ${v}`);
    }
  }
  return problems;
}

/**
 * Build a user-defined enzyme: upper-cases the site, copies the cuts, derives `commercial` from
 * `suppliers`. Throws an Error listing every problem found by {@link validateEnzyme}.
 */
export function makeEnzyme(init: {
  name: string;
  site: string;
  cuts: ReadonlyArray<EnzymeCut>;
  suppliers?: string;
  methylDirected?: boolean;
}): RestrictionEnzyme {
  const suppliers = init.suppliers ?? '';
  const enzyme: RestrictionEnzyme = {
    name: init.name.trim(),
    site: init.site.toUpperCase(),
    cuts: init.cuts.map((c) => ({ top: c.top, bottom: c.bottom })),
    suppliers,
    commercial: suppliers !== '',
    ...(init.methylDirected ? { methylDirected: true } : {}),
  };
  const problems = validateEnzyme(enzyme);
  if (problems.length > 0) throw new Error(`Invalid enzyme '${init.name}': ${problems.join('; ')}`);
  return enzyme;
}

// ---------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------

const METHYL_DIRECTED = new Set(METHYL_DIRECTED_ENZYMES);

function enzymeFromRow([name, site, flatCuts, suppliers]: EnzymeRow): RestrictionEnzyme {
  const cuts: EnzymeCut[] = [];
  for (let i = 0; i + 1 < flatCuts.length; i += 2) cuts.push(Object.freeze({ top: flatCuts[i], bottom: flatCuts[i + 1] }));
  return Object.freeze({
    name,
    site,
    cuts: Object.freeze(cuts),
    suppliers,
    commercial: suppliers !== '',
    ...(METHYL_DIRECTED.has(name) ? { methylDirected: true } : {}),
  });
}

/**
 * Every enzyme of the REBASE-derived catalogue with defined cleavage (commercial or not),
 * sorted case-insensitively by name. Objects are frozen: copy before modifying.
 * Includes methyl-directed enzymes with 1-2 bp sites (AbaSI 'C', FspEI 'CC') that match almost
 * everywhere: pick display sets with `filterEnzymes` (e.g. excludeMethylDirected) or use
 * {@link COMMON_ENZYMES} / {@link COMMERCIAL_ENZYMES}.
 */
export const ENZYMES: readonly RestrictionEnzyme[] = Object.freeze(ENZYME_ROWS.map(enzymeFromRow));

/** The commercially available subset of {@link ENZYMES} (at least one supplier). */
export const COMMERCIAL_ENZYMES: readonly RestrictionEnzyme[] = Object.freeze(ENZYMES.filter((e) => e.commercial));

const BY_NAME: ReadonlyMap<string, RestrictionEnzyme> = new Map(ENZYMES.map((e) => [e.name.toLowerCase(), e]));

/**
 * Catalogue lookup by exact name, case-insensitive ('ecori' -> EcoRI). Biopython's spelling with
 * '_' for REBASE's '-' (CviKI_1) is accepted too. Returns undefined for unknown names.
 */
export function getEnzyme(name: string): RestrictionEnzyme | undefined {
  const key = name.trim().toLowerCase();
  return BY_NAME.get(key) ?? BY_NAME.get(key.replace(/_/g, '-'));
}

/**
 * Names of the enzymes most used in cloning labs (multiple-cloning-site cutters of pUC/pET/pcDNA
 * vectors, rare cutters, Golden Gate Type IIS enzymes, DpnI for site-directed mutagenesis),
 * roughly in order of popularity. Curated for the default enzyme picker.
 */
export const COMMON_ENZYME_NAMES: readonly string[] = Object.freeze([
  'EcoRI', 'BamHI', 'HindIII', 'XhoI', 'XbaI', 'NotI', 'NdeI', 'NcoI', 'KpnI', 'SacI',
  'SalI', 'PstI', 'SphI', 'SmaI', 'EcoRV', 'BglII', 'NheI', 'SpeI', 'AgeI', 'MluI',
  'ApaI', 'ClaI', 'AscI', 'PacI', 'SbfI', 'BsaI', 'BsmBI', 'BbsI', 'SapI', 'NsiI',
  'AvrII', 'MfeI', 'XmaI', 'HpaI', 'ScaI', 'StuI', 'PmeI', 'SwaI', 'FseI', 'DpnI',
  'PvuII', 'PvuI', 'AflII', 'BsrGI', 'SacII', 'NruI', 'BlpI', 'Esp3I',
]);

/** {@link COMMON_ENZYME_NAMES} resolved against the catalogue (same order). */
export const COMMON_ENZYMES: readonly RestrictionEnzyme[] = Object.freeze(
  COMMON_ENZYME_NAMES.map(getEnzyme).filter((e): e is RestrictionEnzyme => e !== undefined),
);
