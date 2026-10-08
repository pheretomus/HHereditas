/**
 * Helpers the UI uses to choose which enzymes to display: cutter counts and catalogue filters.
 * Counts are taken from `findSites` output (see `search.ts`); "cuts" are distinct cleavage
 * events (`countCuts`), so a BaeI site cut on both sides counts 2, and a site near the end of a
 * linear molecule that cannot be cleaved counts 0.
 */
import type { EndKind, EnzymeSite } from '../types';
import type { RestrictionEnzyme } from './enzyme';
import { effectiveSiteLength, isPalindromic, overhang } from './enzyme';
import { countCuts } from './search';

function byName(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Names of the enzymes that make exactly `n` distinct cleavage events in the molecule the
 * `sites` were found in, sorted by name (code-unit order), each name once.
 * Without `enzymes`, the candidates are the enzymes present in `sites` (an enzyme without any
 * site is unknown, so `n === 0` then only finds enzymes whose sites cannot be cleaved).
 * With `enzymes`, the candidates are exactly the enzymes of that list (matched by name): enzymes
 * of the list without any site count as 0, and enzymes that occur in `sites` but not in the
 * list are never returned.
 */
export function cuttersWithCount(
  sites: readonly EnzymeSite[],
  n: number,
  enzymes?: readonly RestrictionEnzyme[],
): string[] {
  const counts = countCuts(sites);
  const candidates = enzymes === undefined ? counts.keys() : new Set(enzymes.map((e) => e.name));
  const names: string[] = [];
  for (const name of candidates) if ((counts.get(name) ?? 0) === n) names.push(name);
  return names.sort(byName);
}

/** Names of the enzymes that cut exactly once (single cleavage event), sorted by name. */
export function uniqueCutters(sites: readonly EnzymeSite[]): string[] {
  return cuttersWithCount(sites, 1);
}

/**
 * Names of the enzymes of `enzymes` that do not cleave the molecule at all (no site, or only sites
 * that cannot be cleaved, e.g. at the end of a linear molecule), sorted by name. Enzymes that occur
 * in `sites` but are not in `enzymes` are ignored.
 */
export function nonCutters(sites: readonly EnzymeSite[], enzymes: readonly RestrictionEnzyme[]): string[] {
  return cuttersWithCount(sites, 0, enzymes);
}

/** Criteria of {@link filterEnzymes}; every given criterion must hold. */
export interface EnzymeFilter {
  /** Minimum recognition sequence length in bases, N positions included (BglI GCCNNNNNGGC = 11). */
  minSiteLength?: number;
  /**
   * Minimum effective recognition length (`effectiveSiteLength`: N counts 0, R/Y/... 0.5), e.g. 6
   * for "6+ cutters" that cut a random sequence about once per 4 kb or less often.
   */
  minEffectiveLength?: number;
  /** Only enzymes with at least one supplier. */
  commercialOnly?: boolean;
  /** Only enzymes sold by at least one of these REBASE supplier codes (e.g. 'N' or ['B', 'N']). */
  suppliers?: string | readonly string[];
  /** Only enzymes whose first cleavage event leaves one of these end kinds. */
  overhang?: readonly EndKind[];
  /** Only enzymes with palindromic recognition sequences. */
  palindromicOnly?: boolean;
  /** Leave out methyl-directed enzymes (DpnI, ...), which only cut methylated sites. */
  excludeMethylDirected?: boolean;
}

/** Enzymes of `list` matching every criterion of `filter`, in `list` order. */
export function filterEnzymes(list: readonly RestrictionEnzyme[], filter: EnzymeFilter): RestrictionEnzyme[] {
  const supplierCodes =
    filter.suppliers === undefined ? undefined : typeof filter.suppliers === 'string' ? [...filter.suppliers] : filter.suppliers;
  return list.filter((e) => {
    if (filter.minSiteLength !== undefined && e.site.length < filter.minSiteLength) return false;
    // small tolerance: effective lengths are sums of logarithms
    if (filter.minEffectiveLength !== undefined && effectiveSiteLength(e.site) < filter.minEffectiveLength - 1e-9) return false;
    if (filter.commercialOnly && !e.commercial) return false;
    if (supplierCodes !== undefined && !supplierCodes.some((code) => e.suppliers.includes(code))) return false;
    if (filter.overhang !== undefined && !filter.overhang.includes(overhang(e).kind)) return false;
    if (filter.palindromicOnly && !isPalindromic(e.site)) return false;
    if (filter.excludeMethylDirected && e.methylDirected === true) return false;
    return true;
  });
}
