/**
 * Immutable create / update / delete helpers for the features and primers of a record.
 *
 * Every function returns a new record (the input is never modified; the result shares no
 * mutable object with it) and validates what it stores:
 *   - feature segments must be valid normalized ranges for the record (types.ts: 0-based,
 *     half-open; on circular records 0 <= start < L, start <= end <= start + L, origin-crossing
 *     segments written with end > L), at least one segment, strand 1 / -1 / 0;
 *   - primer sequences are cleaned with `normalizeDna` (upper-cased, U -> T, whitespace and
 *     digits dropped) and must be non-empty IUPAC DNA.
 * Ids must be unique within the record; unknown ids throw. Violations throw an Error (or a
 * RangeError for coordinates) with a message naming the problem.
 */
import type { Feature, Primer, SeqRecord } from '../types';
import { checkRange, cleanBases, copyEnds, copyFeature, copyPrimer, rebuildRecord } from './internal';

/** Changes to apply to a feature: any field except `id`. An `undefined` optional field (color, reverseColor, partialStart, partialEnd) removes it; `undefined` required fields are ignored. */
export type FeaturePatch = Partial<Omit<Feature, 'id'>>;

/** Changes to apply to a primer: any field except `id`. `description: undefined` removes the description. */
export type PrimerPatch = Partial<Omit<Primer, 'id'>>;

const OPTIONAL_FEATURE_KEYS = ['color', 'reverseColor', 'partialStart', 'partialEnd'] as const;

/** Copy of `rec` with a new feature list (used as is) and copies of everything else. */
function withFeatures(rec: SeqRecord, features: Feature[]): SeqRecord {
  return rebuildRecord(rec, rec.seq, rec.topology, features, rec.ends && copyEnds(rec.ends));
}

/** Copy of `rec` with a new primer list (used as is) and copies of everything else. */
function withPrimers(rec: SeqRecord, primers: Primer[]): SeqRecord {
  const features = rec.features.map((f) => copyFeature(f));
  return rebuildRecord(rec, rec.seq, rec.topology, features, rec.ends && copyEnds(rec.ends), primers);
}

/** Validate a feature against `rec` (segments must already be normalized) and return a deep copy. */
function validFeature(rec: SeqRecord, f: Feature, op: string): Feature {
  if (typeof f.id !== 'string' || f.id === '') throw new Error(`${op}: the feature needs a non-empty id`);
  if (typeof f.type !== 'string' || f.type === '') throw new Error(`${op}: feature '${f.id}' needs a non-empty type`);
  if (f.strand !== 1 && f.strand !== -1 && f.strand !== 0) {
    throw new Error(`${op}: feature '${f.id}' has strand ${String(f.strand)}; expected 1, -1 or 0`);
  }
  if (!Array.isArray(f.segments) || f.segments.length === 0) {
    throw new Error(`${op}: feature '${f.id}' needs at least one segment`);
  }
  const L = rec.seq.length;
  const segments = f.segments.map((r) => checkRange(r, L, rec.topology, `${op} (feature '${f.id}')`));
  return copyFeature(f, segments);
}

/** Validate a primer and return a copy with its sequence cleaned. */
function validPrimer(p: Primer, op: string): Primer {
  if (typeof p.id !== 'string' || p.id === '') throw new Error(`${op}: the primer needs a non-empty id`);
  const sequence = cleanBases(p.sequence, `${op} (primer '${p.id}')`);
  if (sequence === '') throw new Error(`${op}: primer '${p.id}' has an empty sequence`);
  return { ...copyPrimer(p), sequence };
}

function featureIndex(rec: SeqRecord, id: string, op: string): number {
  const i = rec.features.findIndex((f) => f.id === id);
  if (i < 0) throw new Error(`${op}: no feature with id '${id}'`);
  return i;
}

function primerIndex(rec: SeqRecord, id: string, op: string): number {
  const i = rec.primers.findIndex((p) => p.id === id);
  if (i < 0) throw new Error(`${op}: no primer with id '${id}'`);
  return i;
}

/**
 * Append a feature. Its segments are validated against the record (see module notes); a
 * duplicate id throws. The stored feature is a copy.
 */
export function addFeature(rec: SeqRecord, feature: Feature): SeqRecord {
  const f = validFeature(rec, feature, 'addFeature');
  if (rec.features.some((g) => g.id === f.id)) throw new Error(`addFeature: a feature with id '${f.id}' already exists`);
  return withFeatures(rec, [...rec.features.map((g) => copyFeature(g)), f]);
}

/**
 * Replace fields of the feature with id `id` (which must exist), keeping its position in the
 * list. The resulting feature is validated like in `addFeature`. `patch` cannot change the id.
 */
export function updateFeature(rec: SeqRecord, id: string, patch: FeaturePatch): SeqRecord {
  const i = featureIndex(rec, id, 'updateFeature');
  const old = rec.features[i];
  const merged: Feature = { ...old };
  const target = merged as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'id') continue;
    if (value !== undefined) target[key] = value;
    else if ((OPTIONAL_FEATURE_KEYS as readonly string[]).includes(key)) delete target[key];
  }
  const f = validFeature(rec, merged, 'updateFeature');
  return withFeatures(
    rec,
    rec.features.map((g, j) => (j === i ? f : copyFeature(g))),
  );
}

/** Remove the feature with id `id` (which must exist). */
export function removeFeature(rec: SeqRecord, id: string): SeqRecord {
  const i = featureIndex(rec, id, 'removeFeature');
  return withFeatures(
    rec,
    rec.features.filter((_, j) => j !== i).map((g) => copyFeature(g)),
  );
}

/** Append a primer (sequence cleaned and validated; a duplicate id throws). */
export function addPrimer(rec: SeqRecord, primer: Primer): SeqRecord {
  const p = validPrimer(primer, 'addPrimer');
  if (rec.primers.some((q) => q.id === p.id)) throw new Error(`addPrimer: a primer with id '${p.id}' already exists`);
  return withPrimers(rec, [...rec.primers.map(copyPrimer), p]);
}

/** Replace fields of the primer with id `id` (which must exist); the result is validated like in `addPrimer`. */
export function updatePrimer(rec: SeqRecord, id: string, patch: PrimerPatch): SeqRecord {
  const i = primerIndex(rec, id, 'updatePrimer');
  const merged: Primer = { ...rec.primers[i] };
  const target = merged as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'id') continue;
    if (value !== undefined) target[key] = value;
    else if (key === 'description') delete target[key];
  }
  const p = validPrimer(merged, 'updatePrimer');
  return withPrimers(
    rec,
    rec.primers.map((q, j) => (j === i ? p : copyPrimer(q))),
  );
}

/** Remove the primer with id `id` (which must exist). */
export function removePrimer(rec: SeqRecord, id: string): SeqRecord {
  const i = primerIndex(rec, id, 'removePrimer');
  return withPrimers(
    rec,
    rec.primers.filter((_, j) => j !== i).map(copyPrimer),
  );
}
