/**
 * Restriction cloning wizard model: which enzymes cut the vector and the insert (and how
 * often), a suggested enzyme pair, the fragments to choose from and the simulated cloning.
 */
import type { CloningResult, DigestedRecord, FragmentEnds, RestrictionEnzyme, SeqRecord } from '@hhereditas/core';
import { COMMON_ENZYMES, countCuts, digestRecord, findSites, newId, restrictionClone } from '@hhereditas/core';
import { LARGE_RECORD, SIX_CUTTER_POOL, enzymesByName } from '../../../state/analysis';
import { errorText, formatBp, withProvenance } from './common';

export interface CloningEnzyme {
  name: string;
  /** Cleavage events in the vector / insert. */
  vectorCuts: number;
  insertCuts: number;
}

function pool(records: readonly SeqRecord[]): RestrictionEnzyme[] {
  const byName = new Map<string, RestrictionEnzyme>();
  for (const e of COMMON_ENZYMES) if (!e.methylDirected) byName.set(e.name, e);
  if (records.every((r) => r.seq.length <= LARGE_RECORD)) for (const e of SIX_CUTTER_POOL) byName.set(e.name, e);
  return [...byName.values()];
}

function cutCounts(record: SeqRecord, enzymes: readonly RestrictionEnzyme[]): Map<string, number> {
  if (record.seq.length === 0) return new Map();
  const opts = record.topology === 'linear' && record.ends ? { ends: record.ends } : {};
  return countCuts(findSites(record.seq, record.topology, enzymes, opts));
}

/**
 * Enzymes that cut the vector, best cloning candidates first: unique in the vector and
 * cutting the insert, then unique in the vector, then the rest (fewest cuts first).
 */
export function cloningEnzymes(vector: SeqRecord, insert: SeqRecord | null): CloningEnzyme[] {
  const enzymes = pool(insert ? [vector, insert] : [vector]);
  const v = cutCounts(vector, enzymes);
  const i = insert ? cutCounts(insert, enzymes) : new Map<string, number>();
  const rank = (e: CloningEnzyme) => (e.vectorCuts === 1 ? (e.insertCuts > 0 ? 0 : 1) : 2);
  return enzymes
    .map((e) => ({ name: e.name, vectorCuts: v.get(e.name) ?? 0, insertCuts: i.get(e.name) ?? 0 }))
    .filter((e) => e.vectorCuts > 0)
    .sort(
      (a, b) =>
        rank(a) - rank(b) ||
        // in the insert, two cuts (both ends) before one, then the rest
        (a.insertCuts === 2 ? 0 : a.insertCuts === 1 ? 1 : 2) - (b.insertCuts === 2 ? 0 : b.insertCuts === 1 ? 1 : 2) ||
        a.vectorCuts - b.vectorCuts ||
        a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }),
    );
}

/** At most this many candidates are tried when suggesting a pair. */
const SUGGEST_POOL = 14;

/**
 * Score of a working cloning, lower is better: fewer warnings, then 4-nt sticky ends at every
 * junction (what textbook pairs give), then the smallest piece of vector removed (pairs in the
 * multiple cloning site rather than ones that drop half the backbone).
 */
function cloneScore(res: CloningResult, vectorLength: number): number[] {
  const odd = (res.details[0]?.junctions ?? []).filter((j) => j.kind === 'blunt' || j.overhang.length !== 4).length;
  const dropped = vectorLength - (res.vectorFragment?.seq.length ?? 0);
  return [res.warnings.length, odd, dropped];
}

function better(a: number[], b: number[]): boolean {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i];
  return false;
}

/**
 * A sensible starting choice among enzymes unique in the vector that cut the insert: the
 * best-scoring pair (see cloneScore), else the best single enzyme, else nothing.
 */
export function suggestEnzymes(vector: SeqRecord, insert: SeqRecord, candidates: readonly CloningEnzyme[] = cloningEnzymes(vector, insert)): string[] {
  const top = candidates.filter((c) => c.vectorCuts === 1 && c.insertCuts > 0).slice(0, SUGGEST_POOL);
  let best: { names: string[]; score: number[] } | null = null;
  const consider = (names: string[]) => {
    const res = safeClone({ vector, insert, vectorEnzymes: names });
    if (!res.product) return;
    const score = cloneScore(res, vector.seq.length);
    if (!best || better(score, best.score)) best = { names, score };
  };
  for (let a = 0; a < top.length; a++) for (let b = a + 1; b < top.length; b++) consider([top[a].name, top[b].name]);
  if (!best) for (const c of top) consider([c.name]);
  return (best as { names: string[] } | null)?.names ?? [];
}

function safeClone(options: Parameters<typeof restrictionClone>[0]): CloningResult {
  try {
    return restrictionClone(options);
  } catch (e) {
    return { products: [], warnings: [], error: errorText(e), details: [] };
  }
}

/** Conventional (cut-to-cut, top strand) size of a fragment whose sequence includes its overhangs. */
export function cutToCutLength(length: number, ends: FragmentEnds | undefined): number {
  if (!ends) return length;
  return length - (ends.left.kind === '3prime' ? ends.left.length : 0) - (ends.right.kind === '5prime' ? ends.right.length : 0);
}

export interface FragmentChoice {
  index: number;
  label: string;
  size: number;
}

/** The fragments of a digest, in parent order (the engine's fragment indices). */
export function fragmentChoices(record: SeqRecord, enzymeNames: readonly string[]): FragmentChoice[] {
  const enzymes = enzymesByName(enzymeNames);
  if (enzymes.length === 0 || record.seq.length === 0) return [];
  let frags: DigestedRecord[];
  try {
    frags = digestRecord(record, enzymes);
  } catch {
    return [];
  }
  return frags.map((f, index) => {
    const size = cutToCutLength(f.seq.length, f.ends);
    const left = f.leftCut?.enzyme ?? (record.topology === 'linear' ? 'end' : '');
    const right = f.rightCut?.enzyme ?? (record.topology === 'linear' ? 'end' : '');
    return { index, size, label: left || right ? `${formatBp(size)} · ${left}–${right}` : formatBp(size) };
  });
}

export type Orientation = 'both' | 'forward' | 'reverse';

export interface RestrictionInputs {
  vector: SeqRecord;
  insert: SeqRecord;
  enzymes: readonly string[];
  vectorFragment: 'largest' | number;
  insertFragment: 'auto' | number;
  orientation: Orientation;
}

export function runRestriction(inputs: RestrictionInputs): CloningResult | null {
  if (inputs.enzymes.length === 0) return null;
  return safeClone({
    vector: inputs.vector,
    insert: inputs.insert,
    vectorEnzymes: inputs.enzymes,
    vectorFragment: inputs.vectorFragment,
    insertFragment: inputs.insertFragment,
    orientation: inputs.orientation,
  });
}

/** Junction summary of product `index`: "EcoRI (AATT, recut) · BamHI (GATC, recut)". */
export function junctionSummary(result: CloningResult, index: number): string {
  const d = result.details[index];
  if (!d) return '';
  return d.junctions
    .map((j) => {
      const enzymes = [...new Set(j.enzymes)].join('/');
      const end = j.kind === 'blunt' ? 'blunt' : j.overhang;
      return `${enzymes} (${end}${j.recutBy.length ? '' : ', not recut'})`;
    })
    .join(' · ');
}

export function restrictionProductRecord(inputs: RestrictionInputs, result: CloningResult, index: number): SeqRecord | null {
  const product = result.products[index];
  if (!product) return null;
  const orientation = result.details[index]?.orientation ?? 'forward';
  const enzymes = [...new Set(inputs.enzymes)].join(' + ');
  const vf = result.vectorFragment;
  const inf = result.insertFragment;
  const how =
    `Restriction cloning: ${inf ? `${formatBp(inf.seq.length)} fragment of ` : ''}${inputs.insert.name} ligated (${orientation} orientation) into ` +
    `${vf ? `the ${formatBp(vf.seq.length)} fragment of ` : ''}${inputs.vector.name}, both cut with ${enzymes}`;
  return withProvenance({ ...product, id: newId('rec') }, how);
}
