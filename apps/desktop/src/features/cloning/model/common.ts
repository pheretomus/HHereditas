/**
 * Shared pieces of the cloning wizards: molecules taken from open documents (whole or a
 * selection), the provenance comment of products, product gel lanes. Pure (no React).
 */
import type { Ladder, Range, SeqRecord } from '@hhereditas/core';
import { extractRange, ladderLane, makeFeature, normalizeRange, simulateLane } from '@hhereditas/core';
import type { GelLane } from '@hhereditas/viewer';
import type { DocumentState } from '../../../state/documents';

export const HELP_SUFFIX = 'Made with HHereditas';

/** A molecule picked in a wizard: an open document, whole or a range of it. */
export interface MoleculeSource {
  docId: string;
  /** Range of the document (normalized, may cross the origin); null = the whole molecule. */
  range: Range | null;
}

export function formatBp(n: number): string {
  return `${n.toLocaleString('en-US')} bp`;
}

/** 1-based inclusive "first..last" of a normalized range. */
export function formatRange(range: Range, length: number): string {
  const first = (range.start % length) + 1;
  const last = ((range.end - 1) % length) + 1;
  return `${first.toLocaleString('en-US')}..${last.toLocaleString('en-US')}`;
}

/** Display name of a source: "pUC19" or "pUC19 120..840". */
export function sourceLabel(doc: DocumentState, range: Range | null): string {
  return range ? `${doc.record.name} ${formatRange(range, doc.record.seq.length)}` : doc.record.name;
}

/** The record a source stands for (a selection becomes a linear record), or null when its document is gone. */
export function resolveSource(documents: readonly DocumentState[], source: MoleculeSource): SeqRecord | null {
  const doc = documents.find((d) => d.id === source.docId);
  if (!doc) return null;
  if (!source.range) return doc.record;
  const L = doc.record.seq.length;
  const r = normalizeRange(source.range, L, doc.record.topology);
  if (r.end - r.start >= L && doc.record.topology === 'linear') return doc.record;
  return extractRange(doc.record, r, { name: sourceLabel(doc, r) });
}

/** The active selection of a document as a range, or null without selected bases. */
export function selectionRange(doc: DocumentState | null): Range | null {
  const sel = doc?.selection;
  if (!doc || !sel || sel.range.end <= sel.range.start) return null;
  return normalizeRange(sel.range, doc.record.seq.length, doc.record.topology);
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Stamp a product with how it was made: a COMMENT line (kept in GenBank files) and a
 * description when the engine left it empty.
 */
export function withProvenance(product: SeqRecord, how: string, description?: string): SeqRecord {
  const line = `${how} (${HELP_SUFFIX}, ${today()}).`;
  return {
    ...product,
    description: product.description || description || how,
    meta: { ...product.meta, comments: [line, ...(product.meta.comments ?? [])], sourceFormat: undefined },
  };
}

/** Ladder lane + one lane per product (linear products as linear bands, circular ones supercoiled). */
export function productGelLanes(products: readonly { seq: string; topology: SeqRecord['topology'] }[], ladder: Ladder, label = 'Product'): GelLane[] {
  const conditions = { agarosePercent: 1 };
  const ladderName = ladder.name.replace(/\s*(DNA\s*)?(Ladder|Marker)s?\b.*$/i, '') || ladder.name;
  const lanes: GelLane[] = [{ id: 'ladder', label: ladderName, kind: 'ladder', bands: ladderLane(ladder, conditions) }];
  if (products.length > 0) {
    lanes.push({
      id: 'product',
      label,
      kind: 'sample',
      bands: simulateLane(
        products.map((p) => ({ size: p.seq.length, form: p.topology === 'circular' ? ('supercoiled' as const) : ('linear' as const) })),
        conditions,
      ),
    });
  }
  return lanes;
}

/** Message of an unexpected exception (engine programming errors are shown, not thrown). */
export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Drop primer_bind features that stand for primers kept in `record.primers`: the views draw the
 * primers themselves, and saving writes them back as primer_bind features (no duplicates).
 */
export function withoutPrimerFeatures(record: SeqRecord): SeqRecord {
  if (record.primers.length === 0) return record;
  const names = new Set(record.primers.map((p) => p.name));
  const features = record.features.filter((f) => !(f.type === 'primer_bind' && names.has(f.name)));
  return features.length === record.features.length ? record : { ...record, features };
}

/**
 * Annotate the pieces of an assembly product that brought no features of their own (e.g. bare
 * PCR products), so the map shows what went where. `pieces` are in product order;
 * `junctions[i]` is the overlap joining piece i to piece i+1 (the last one closes a circle).
 */
export function annotatePieces(product: SeqRecord, pieces: readonly { name: string; bare: boolean; strand?: 1 | -1 }[], junctions: readonly { range: Range }[]): SeqRecord {
  const n = pieces.length;
  const L = product.seq.length;
  if (n === 0 || L === 0 || !pieces.some((p) => p.bare)) return product;
  const circular = product.topology === 'circular';
  const features = [...product.features];
  pieces.forEach((piece, i) => {
    if (!piece.bare) return;
    const before = i > 0 ? junctions[i - 1] : circular ? junctions[n - 1] : undefined;
    const after = i < n - 1 || circular ? junctions[i] : undefined;
    let start = before ? before.range.start % L : 0;
    let end = after ? after.range.end : L;
    if (end <= start) end += L;
    if (end - start > L) end = start + L;
    if (!circular && end > L) return;
    if (start >= L) start -= L;
    features.push(
      makeFeature({
        type: 'misc_feature',
        name: piece.name,
        strand: piece.strand ?? 1,
        segments: [{ start, end }],
        qualifiers: [{ key: 'label', value: piece.name }, { key: 'note', value: 'assembly piece' }],
      }),
    );
  });
  return { ...product, features };
}

/** Has the record no features that would show on a map (sources do not count)? */
export function isBare(record: SeqRecord): boolean {
  return !record.features.some((f) => f.type !== 'source');
}

/** The outcome with its first product replaced (keeps `product === products[0]`). */
export function withFirstProduct<T extends { product?: SeqRecord; products: SeqRecord[] }>(outcome: T, product: SeqRecord): T {
  return { ...outcome, product, products: [product, ...outcome.products.slice(1)] };
}
