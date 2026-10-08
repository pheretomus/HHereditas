/**
 * Pure data shaping for the Sidebar (unit-tested): which annotations are listed, in which
 * order, and how enzyme sites are grouped.
 */
import type { EnzymeSite, Feature, Primer, SeqRecord, Strand } from '@hhereditas/core';
import { featureExtent, featureLength } from '@hhereditas/core';
import { featureFill } from '@hhereditas/viewer';

export interface FeatureRow {
  id: string;
  name: string;
  type: string;
  strand: Strand;
  /** CSS colour (custom colour or the type's token). */
  color: string;
  /** Bases covered (sum of segments). */
  length: number;
  /** 0-based start of the feature's extent. */
  start: number;
}

/** Feature types that describe the whole record rather than a region worth listing. */
const HIDDEN_TYPES = new Set(['source']);

/** Features listed in the sidebar: in position order, longer first at the same start. */
export function featureRows(record: Pick<SeqRecord, 'features' | 'seq' | 'topology'>): FeatureRow[] {
  const n = record.seq.length;
  const rows: FeatureRow[] = [];
  for (const f of record.features) {
    if (HIDDEN_TYPES.has(f.type)) continue;
    rows.push(toFeatureRow(f, n, record.topology));
  }
  rows.sort((x, y) => x.start - y.start || y.length - x.length || x.name.localeCompare(y.name));
  return rows;
}

function toFeatureRow(f: Feature, n: number, topology: SeqRecord['topology']): FeatureRow {
  const start = f.segments.length > 0 ? featureExtent(f, n, topology).start : 0;
  return {
    id: f.id,
    name: f.name || f.type,
    type: f.type,
    strand: f.strand,
    color: featureFill(f),
    length: featureLength(f),
    start,
  };
}

export interface PrimerRow {
  id: string;
  name: string;
  /** Oligo length in nucleotides. */
  length: number;
}

export function primerRows(primers: readonly Primer[]): PrimerRow[] {
  return primers.map((p) => ({ id: p.id, name: p.name || 'Unnamed primer', length: p.sequence.length }));
}

export interface EnzymeRow {
  name: string;
  /** Number of recognition sites. */
  count: number;
  /** Top-strand cut positions (gap positions), ascending. */
  cuts: number[];
}

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

/** Groups sites by enzyme; sorted by name (natural order: "BsaI" before "BsmBI"). */
export function enzymeRows(sites: readonly EnzymeSite[]): EnzymeRow[] {
  const byName = new Map<string, EnzymeRow>();
  for (const site of sites) {
    let row = byName.get(site.enzyme);
    if (!row) {
      row = { name: site.enzyme, count: 0, cuts: [] };
      byName.set(site.enzyme, row);
    }
    row.count++;
    for (const cut of site.cuts) row.cuts.push(cut.top);
  }
  const rows = [...byName.values()];
  for (const r of rows) r.cuts.sort((a, b) => a - b);
  rows.sort((a, b) => collator.compare(a.name, b.name));
  return rows;
}

/** Case-insensitive substring match; an empty query matches everything. */
export function matchesFilter(name: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  return q === '' || name.toLowerCase().includes(q);
}
