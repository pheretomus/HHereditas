/**
 * Digest & gel model: candidate enzymes for a record, the digest of the chosen ones, gel lanes
 * and fragments opened as new documents. Pure (testable without React).
 */
import type { DigestFragment, Ladder, RestrictionEnzyme, SeqRecord } from '@hhereditas/core';
import {
  COMMON_ENZYMES,
  countCuts,
  digestDetailed,
  digestSizesWithTopology,
  extractRange,
  findSites,
  insertBases,
  ladderLane,
  makeRecord,
  simulateLane,
} from '@hhereditas/core';
import type { GelLane } from '@hhereditas/viewer';
import { LARGE_RECORD, SIX_CUTTER_POOL, enzymesByName } from '../../state/analysis';

export interface EnzymeCandidate {
  name: string;
  /** Number of cleavage events in the record. */
  cuts: number;
}

/** Enzymes that cut the record (6+ cutter pool plus the common set), fewest cuts first. */
export function digestCandidates(record: SeqRecord): EnzymeCandidate[] {
  if (record.seq.length === 0 || record.molecule === 'protein') return [];
  const pool = new Map<string, RestrictionEnzyme>();
  for (const e of COMMON_ENZYMES) if (!e.methylDirected) pool.set(e.name, e);
  if (record.seq.length <= LARGE_RECORD) for (const e of SIX_CUTTER_POOL) pool.set(e.name, e);
  const opts = record.topology === 'linear' && record.ends ? { ends: record.ends } : {};
  const counts = countCuts(findSites(record.seq, record.topology, [...pool.values()], opts));
  return [...counts.entries()]
    .filter(([, c]) => c > 0)
    .map(([name, cuts]) => ({ name, cuts }))
    .sort((a, b) => a.cuts - b.cuts || a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));
}

/** Conventional (top-strand, cut-to-cut) size of a fragment: what marker sheets and NEBcutter print. */
export function cutToCut(f: DigestFragment): number {
  return f.length - (f.ends.left.kind === '3prime' ? f.ends.left.length : 0) - (f.ends.right.kind === '5prime' ? f.ends.right.length : 0);
}

export interface FragmentRow {
  key: string;
  index: number;
  size: number;
  left: string;
  right: string;
  /** 1-based first and last base in the parent (top strand). */
  first: number;
  last: number;
  fragment: DigestFragment;
}

export interface DigestResult {
  rows: FragmentRow[];
  warnings: string[];
}

export function runDigest(record: SeqRecord, enzymeNames: readonly string[]): DigestResult {
  const enzymes = enzymesByName(enzymeNames);
  if (enzymes.length === 0 || record.seq.length === 0) return { rows: [], warnings: [] };
  const L = record.seq.length;
  const opts = record.topology === 'linear' && record.ends ? { ends: record.ends } : undefined;
  const report = digestDetailed(record.seq, record.topology, enzymes, opts);
  const rows = report.fragments.map((f, i) => {
    // Cut-to-cut extent on the top strand (1-based, inclusive; last < first across the origin).
    const first = f.leftCut ? (f.leftCut.top % L) + 1 : (f.parentRange.start % L) + 1;
    const lastGap = f.rightCut ? f.rightCut.top : f.parentRange.end;
    const last = ((lastGap - 1 + L) % L) + 1;
    return {
      key: `${i}`,
      index: i + 1,
      size: cutToCut(f),
      left: f.leftCut?.enzyme ?? (f.topology === 'circular' ? '(uncut)' : 'end'),
      right: f.rightCut?.enzyme ?? (f.topology === 'circular' ? '(uncut)' : 'end'),
      first,
      last,
      fragment: f,
    };
  });
  return { rows, warnings: [...new Set(report.skipped.map((s) => s.message))] };
}

export function gelLanes(record: SeqRecord, enzymeNames: readonly string[], ladder: Ladder, agarosePercent: number): GelLane[] {
  const conditions = { agarosePercent };
  const label = ladder.name.replace(/\s*(DNA\s*)?(Ladder|Marker)s?\b.*$/i, '') || ladder.name;
  const lanes: GelLane[] = [{ id: 'ladder', label, kind: 'ladder', bands: ladderLane(ladder, conditions) }];
  const L = record.seq.length;
  if (L === 0) return lanes;
  if (record.topology === 'circular') {
    lanes.push({
      id: 'uncut',
      label: 'Uncut',
      kind: 'sample',
      bands: simulateLane(
        [
          { size: L, form: 'supercoiled', molarAmount: 0.7, label: 'supercoiled' },
          { size: L, form: 'nicked', molarAmount: 0.3, label: 'open circular' },
        ],
        conditions,
      ),
    });
  }
  const enzymes = enzymesByName(enzymeNames);
  if (enzymes.length > 0) {
    const opts = record.topology === 'linear' && record.ends ? { ends: record.ends } : undefined;
    const sizes = digestSizesWithTopology(record.seq, record.topology, enzymes, opts);
    lanes.push({
      id: 'digest',
      label: enzymes.map((e) => e.name).join(' + '),
      kind: 'sample',
      bands: simulateLane(
        sizes.map((d) => ({ size: d.size, form: d.topology === 'circular' ? ('supercoiled' as const) : ('linear' as const) })),
        conditions,
      ),
    });
  }
  return lanes;
}

/** A digest fragment as a new linear record, with the parent's features and its sticky ends. */
export function fragmentRecord(parent: SeqRecord, row: FragmentRow): SeqRecord {
  const f = row.fragment;
  const L = parent.seq.length;
  const name = `${parent.name} ${row.left}–${row.right} (${row.size.toLocaleString('en-US')} bp)`;
  const description = `Fragment ${row.index} of ${parent.name} digested with ${[...new Set([row.left, row.right])].filter((x) => x !== 'end').join(' + ')}`;
  try {
    if (f.topology === 'circular') return { ...extractRange(parent, { start: 0, end: L }, { name, description }) };
    const len = f.parentRange.end - f.parentRange.start;
    let rec: SeqRecord;
    if (len <= L) {
      rec = extractRange(parent, f.parentRange, { name, description });
    } else {
      // A circle cut once: the overhang bases occur at both ends; features go on the first copy.
      rec = extractRange(parent, { start: f.parentRange.start, end: f.parentRange.start + L }, { name, description });
      rec = insertBases(rec, L, f.seq.slice(L));
    }
    return { ...rec, ends: f.ends };
  } catch {
    return makeRecord({ seq: f.seq, name, description, topology: 'linear', ends: f.ends });
  }
}
