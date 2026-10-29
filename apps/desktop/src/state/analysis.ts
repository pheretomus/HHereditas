/**
 * Derived data of a record: displayed restriction sites, primer binding sites and search hits.
 * Pure functions plus memoizing hooks (keyed by record identity and settings).
 */
import type { EnzymeSite, Orf, PrimerBindingSite, RestrictionEnzyme, SearchHit, SeqRecord } from '@hhereditas/core';
import {
  COMMERCIAL_ENZYMES,
  COMMON_ENZYMES,
  COMMON_ENZYME_NAMES,
  countCuts,
  filterEnzymes,
  findOrfs,
  findSites,
  getEnzyme,
  normalizeDna,
  scanBindingSites,
  searchSequence,
} from '@hhereditas/core';
import { useMemo } from 'react';
import type { EnzymeDisplay } from '../shell';

/** Commercial enzymes with ≥ 6 specified bases, not methylation-dependent: the default pool. */
export const SIX_CUTTER_POOL: readonly RestrictionEnzyme[] = representatives(
  filterEnzymes(COMMERCIAL_ENZYMES, { minEffectiveLength: 6, excludeMethylDirected: true }),
);

/**
 * One enzyme per recognition site and cut (equischizomers such as ClaI / BspDI / Bsu15I would
 * otherwise label the same site many times): the best-known name wins (the common set, then
 * enzymes sold by NEB or Thermo Fisher, then the alphabetical first).
 */
export function representatives(list: readonly RestrictionEnzyme[]): RestrictionEnzyme[] {
  const rank = (e: RestrictionEnzyme) => {
    const common = COMMON_ENZYME_NAMES.indexOf(e.name);
    if (common >= 0) return common;
    if (e.suppliers.includes('N')) return 1000;
    if (e.suppliers.includes('B')) return 2000;
    return 3000;
  };
  const best = new Map<string, RestrictionEnzyme>();
  for (const e of list) {
    const key = `${e.site}|${e.cuts.map((c) => `${c.top},${c.bottom}`).join(';')}`;
    const cur = best.get(key);
    if (!cur || rank(e) < rank(cur) || (rank(e) === rank(cur) && e.name.localeCompare(cur.name) < 0)) best.set(key, e);
  }
  const keep = new Set(best.values());
  return list.filter((e) => keep.has(e));
}

let aliasCache: Map<string, string[]> | null = null;

/**
 * For every NEB enzyme, the names of the NEB enzymes with the same recognition site and cut (itself included,
 * alphabetical): `representatives` shows one of them, the map label lists the group ("BspQI - SapI"). Listing every
 * commercial isoschizomer would make labels such as "BspQI - LguI - PciSI - SapI"; SnapGene's maps list the NEB ones.
 */
export function enzymeAliases(): ReadonlyMap<string, readonly string[]> {
  if (aliasCache) return aliasCache;
  const groups = new Map<string, string[]>();
  for (const e of COMMERCIAL_ENZYMES) {
    if (!e.suppliers.includes('N')) continue;
    const key = `${e.site}|${e.cuts.map((c) => `${c.top},${c.bottom}`).join(';')}`;
    const names = groups.get(key);
    if (names) names.push(e.name);
    else groups.set(key, [e.name]);
  }
  aliasCache = new Map();
  for (const names of groups.values()) {
    const sorted = [...names].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
    for (const name of names) aliasCache.set(name, sorted);
  }
  return aliasCache;
}

/** Names in the enzyme menu (overriding the shell's generic labels). */
export const ENZYME_DISPLAY_NAMES: Partial<Record<EnzymeDisplay, string>> = {
  unique: 'Unique 6+ cutters',
  'unique-dual': 'Unique & dual 6+ cutters',
  common: 'Common set',
  none: 'None',
  custom: 'Chosen enzymes',
};

export const ENZYME_DISPLAY_CHOICES: readonly EnzymeDisplay[] = ['unique', 'unique-dual', 'common', 'none'];

/** Above this length the 6-cutter search is limited to the common set (keeps big genomes responsive). */
export const LARGE_RECORD = 1_000_000;

function siteOptions(record: SeqRecord) {
  return record.topology === 'linear' && record.ends ? { ends: record.ends } : {};
}

export function enzymesByName(names: readonly string[]): RestrictionEnzyme[] {
  return names.map((n) => getEnzyme(n)).filter((e): e is RestrictionEnzyme => !!e);
}

/** The restriction sites to draw for a display choice. */
export function displayedSites(record: SeqRecord, display: EnzymeDisplay, custom: readonly string[] = []): EnzymeSite[] {
  if (display === 'none' || record.molecule === 'protein' || record.seq.length === 0) return [];
  if (display === 'custom') return findSites(record.seq, record.topology, enzymesByName(custom), siteOptions(record));
  if (display === 'common') {
    const pool = COMMON_ENZYMES.filter((e) => !e.methylDirected);
    return findSites(record.seq, record.topology, pool, siteOptions(record));
  }
  const pool = record.seq.length > LARGE_RECORD ? COMMON_ENZYMES.filter((e) => !e.methylDirected) : SIX_CUTTER_POOL;
  const sites = findSites(record.seq, record.topology, pool, siteOptions(record));
  if (display === 'commercial') return sites;
  const max = display === 'unique' ? 1 : 2;
  const counts = countCuts(sites);
  return sites.filter((s) => {
    const c = counts.get(s.enzyme) ?? 0;
    return c >= 1 && c <= max;
  });
}

export function useDisplayedSites(record: SeqRecord | null, display: EnzymeDisplay, custom: readonly string[]): EnzymeSite[] {
  const seq = record?.seq;
  const topology = record?.topology;
  const ends = record?.ends;
  const molecule = record?.molecule;
  const customKey = custom.join(',');
  return useMemo(() => {
    if (seq === undefined || !topology || !molecule) return [];
    try {
      return displayedSites({ seq, topology, ends, molecule } as SeqRecord, display, customKey ? customKey.split(',') : []);
    } catch {
      return [];
    }
  }, [seq, topology, ends, molecule, display, customKey]);
}

export interface PrimerScan {
  sites: PrimerBindingSite[];
  failures: { primerId: string; message: string }[];
}

export function primerSites(record: SeqRecord): PrimerScan {
  if (record.primers.length === 0 || record.seq.length === 0 || record.molecule === 'protein') return { sites: [], failures: [] };
  try {
    return scanBindingSites(record.seq, record.topology, record.primers);
  } catch (e) {
    return { sites: [], failures: record.primers.map((p) => ({ primerId: p.id, message: e instanceof Error ? e.message : String(e) })) };
  }
}

export function usePrimerSites(record: SeqRecord | null): PrimerScan {
  const seq = record?.seq;
  const topology = record?.topology;
  const primers = record?.primers;
  const molecule = record?.molecule;
  return useMemo(
    () => (seq === undefined || !topology || !primers || !molecule ? { sites: [], failures: [] } : primerSites({ seq, topology, primers, molecule } as SeqRecord)),
    [seq, topology, primers, molecule],
  );
}

/** Search query cleaned to IUPAC letters; null when it cannot be searched (too short / not DNA). */
export function cleanQuery(query: string): string | null {
  const q = query.replace(/[\s\d]/g, '').toUpperCase();
  if (q.length < 3) return null;
  const { seq, invalid } = normalizeDna(q);
  return invalid.length === 0 && seq.length >= 3 ? seq : null;
}

export const SEARCH_HIT_LIMIT = 5000;

export function searchHits(record: SeqRecord, query: string): SearchHit[] | null {
  const q = cleanQuery(query);
  if (!q || record.molecule === 'protein') return null;
  try {
    return searchSequence(record.seq, record.topology, q).slice(0, SEARCH_HIT_LIMIT);
  } catch {
    return null;
  }
}

export function useSearchHits(record: SeqRecord | null, query: string): SearchHit[] | null {
  const seq = record?.seq;
  const topology = record?.topology;
  const molecule = record?.molecule;
  return useMemo(
    () => (seq === undefined || !topology || !molecule ? null : searchHits({ seq, topology, molecule } as SeqRecord, query)),
    [seq, topology, molecule, query],
  );
}

export const ORF_MIN_AA = 100;

export function useOrfs(record: SeqRecord | null, enabled: boolean): Orf[] {
  const seq = record?.seq;
  const topology = record?.topology;
  const molecule = record?.molecule;
  return useMemo(() => {
    if (!enabled || seq === undefined || !topology || molecule === 'protein' || seq.length > LARGE_RECORD) return [];
    try {
      return findOrfs(seq, topology, { minAaLength: ORF_MIN_AA });
    } catch {
      return [];
    }
  }, [enabled, seq, topology, molecule]);
}
