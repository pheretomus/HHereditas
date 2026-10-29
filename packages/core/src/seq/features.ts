/**
 * Helpers for reading features: labels, qualifiers, extents and sequences.
 */
import type { Feature, Qualifier, Range, SeqRecord, Strand, Topology } from '../types';
import { reverseComplement } from './alphabet';
import { newId } from './id';
import { coveringRange, rangeLength, sliceRange } from './range';

/** Qualifier keys tried, in order, when choosing a display label for a feature. */
export const LABEL_QUALIFIER_PRIORITY: readonly string[] = [
  'label',
  'gene',
  'product',
  'locus_tag',
  'standard_name',
  'protein_id',
  'name',
  'allele',
  'bound_moiety',
  'mobile_element_type',
  'rpt_family',
  'regulatory_class',
  'ncRNA_class',
  'operon',
  'note',
];

/** First value of a qualifier, or undefined. */
export function getQualifier(qualifiers: readonly Qualifier[], key: string): string | undefined {
  for (const q of qualifiers) if (q.key === key && q.value !== null) return q.value;
  return undefined;
}

/** All values of a qualifier (value-less qualifiers are skipped). */
export function getQualifiers(qualifiers: readonly Qualifier[], key: string): string[] {
  const out: string[] = [];
  for (const q of qualifiers) if (q.key === key && q.value !== null) out.push(q.value);
  return out;
}

/** Display label derived from qualifiers; falls back to the feature type. Long notes are truncated. */
export function featureLabel(type: string, qualifiers: readonly Qualifier[]): string {
  for (const key of LABEL_QUALIFIER_PRIORITY) {
    const v = getQualifier(qualifiers, key);
    if (v !== undefined && v.trim() !== '') {
      const clean = v.replace(/\s+/g, ' ').trim();
      return key === 'note' && clean.length > 40 ? `${clean.slice(0, 39)}…` : clean;
    }
  }
  return type;
}

/** Total number of bases covered by the feature (sum of segment lengths). */
export function featureLength(f: Feature): number {
  let n = 0;
  for (const s of f.segments) n += rangeLength(s);
  return n;
}

/** Overall extent of the feature on the molecule (covers all segments). */
export function featureExtent(f: Feature, seqLength: number, topology: Topology): Range {
  return coveringRange(f.segments, seqLength, topology);
}

/** The feature's own 5'->3' sequence (segments joined, reverse-complemented on the bottom strand). */
export function featureSequence(f: Feature, seq: string): string {
  let top = '';
  for (const s of f.segments) top += sliceRange(seq, s);
  return f.strand === -1 ? reverseComplement(top) : top;
}

/** Convenience constructor that fills in id/qualifiers defaults. */
export function makeFeature(init: {
  type: string;
  name?: string;
  strand?: Strand;
  segments: Range[];
  qualifiers?: Qualifier[];
  color?: string;
  /** Drawn with an arrow head at both ends; see Feature.bidirectional. */
  bidirectional?: boolean;
  id?: string;
}): Feature {
  const qualifiers = init.qualifiers ?? (init.name ? [{ key: 'label', value: init.name }] : []);
  return {
    id: init.id ?? newId('f'),
    type: init.type,
    name: init.name ?? featureLabel(init.type, qualifiers),
    strand: init.strand ?? 0,
    segments: init.segments.map((s) => ({ start: s.start, end: s.end })),
    qualifiers,
    ...(init.color !== undefined ? { color: init.color } : {}),
    ...(init.bidirectional ? { bidirectional: true } : {}),
  };
}

/** Convenience constructor for an empty DNA record. */
export function makeRecord(init: Partial<SeqRecord> & { seq: string }): SeqRecord {
  return {
    id: init.id ?? newId('doc'),
    name: init.name ?? 'Untitled',
    description: init.description ?? '',
    seq: init.seq,
    topology: init.topology ?? 'linear',
    molecule: init.molecule ?? 'DNA',
    features: init.features ?? [],
    primers: init.primers ?? [],
    ...(init.alignedSequences && init.alignedSequences.length > 0 ? { alignedSequences: init.alignedSequences } : {}),
    ...(init.ends ? { ends: init.ends } : {}),
    meta: init.meta ?? {},
  };
}
