/**
 * Gibson assembly wizard model: an ordered list of fragments (open documents or their
 * selections), the assembly of fragments that already overlap, primer design for inserting
 * fragments into a vector, and NEBuilder-style DNA amounts.
 */
import type { AssemblyAmounts, AssemblyResult, GibsonDesign, Primer, Range, SeqRecord } from '@hhereditas/core';
import { assemblyAmounts, designGibsonPrimers, gibsonAssembly, newId, reverseComplementRecord } from '@hhereditas/core';
import type { DocumentState } from '../../../state/documents';
import { annotatePieces, errorText, formatBp, isBare, resolveSource, withFirstProduct, withoutPrimerFeatures, withProvenance, type MoleculeSource } from './common';

export interface FragmentEntry extends MoleculeSource {
  key: string;
  /** Use the reverse complement. */
  reversed: boolean;
}

let entryCounter = 0;
export function newEntry(source: MoleculeSource, reversed = false): FragmentEntry {
  entryCounter += 1;
  return { ...source, reversed, key: `f${entryCounter}` };
}

/** The records of the entries (null for entries whose document was closed). */
export function resolveEntries(documents: readonly DocumentState[], entries: readonly FragmentEntry[]): (SeqRecord | null)[] {
  return entries.map((e) => {
    const rec = resolveSource(documents, e);
    if (!rec) return null;
    return e.reversed ? { ...reverseComplementRecord(rec), name: `${rec.name} (rc)` } : rec;
  });
}

export const DEFAULT_OVERLAP = 20;
export const MIN_OVERLAP = 15;

export interface AssemblyInputs {
  fragments: readonly SeqRecord[];
  minOverlap: number;
  circular: boolean;
}

/** Assemble fragments that already share terminal overlaps. */
export function runAssembly({ fragments, minOverlap, circular }: AssemblyInputs): AssemblyResult | null {
  if (fragments.length === 0) return null;
  if (fragments.length === 1 && !circular) return null;
  try {
    // A whole circular document is a plasmid, not a fragment: tell the user what to do.
    const circ = fragments.findIndex((f) => f.topology === 'circular');
    if (circ >= 0) {
      return { products: [], warnings: [], junctions: [], error: `${fragments[circ].name} is circular: linearize it first, or use Design Primers to insert into it` };
    }
    const name = fragments.map((f) => f.name).join(' + ');
    const result = gibsonAssembly(fragments, { minOverlap, circular, name: `Gibson ${name}` });
    if (!result.product) return result;
    const pieces = fragments.map((f) => ({ name: f.name, bare: isBare(f) }));
    return withFirstProduct(result, annotatePieces(result.product, pieces, result.junctions));
  } catch (e) {
    return { products: [], warnings: [], junctions: [], error: errorText(e) };
  }
}

export interface DesignInputs {
  vector: SeqRecord;
  insertion: Range;
  inserts: readonly SeqRecord[];
  overlapLength: number;
}

export function runDesign({ vector, insertion, inserts, overlapLength }: DesignInputs): GibsonDesign | null {
  if (inserts.length === 0) return null;
  if (vector.topology !== 'circular') {
    return { products: [], warnings: [], primers: [], fragments: [], junctions: [], error: `Primer design needs a circular vector; ${vector.name} is linear` };
  }
  try {
    const design = designGibsonPrimers({ vector, insertion, inserts, overlapLength });
    if (!design.product) return design;
    // Pieces in product order: the vector backbone (when amplified), then the inserts.
    const names = design.fragments.length > inserts.length ? [vector.name, ...inserts.map((r) => r.name)] : inserts.map((r) => r.name);
    const pieces = design.fragments.map((f, i) => ({ name: names[i] ?? f.name, bare: isBare(f) }));
    return withFirstProduct(design, annotatePieces(design.product, pieces, design.junctions));
  } catch (e) {
    return { products: [], warnings: [], primers: [], fragments: [], junctions: [], error: errorText(e) };
  }
}

/** Tab-separated order list (name, sequence, length), one primer per line: pastes into vendor forms and spreadsheets. */
export function primerOrderList(primers: readonly Primer[]): string {
  return primers.map((p) => `${p.name}\t${p.sequence}\t${p.sequence.length}`).join('\n');
}

/** Index of the fragment that is most likely the vector: the longest one. */
export function likelyVector(fragments: readonly { lengthBp: number }[]): number {
  let best = 0;
  fragments.forEach((f, i) => {
    if (f.lengthBp > fragments[best].lengthBp) best = i;
  });
  return best;
}

export interface AmountsInputs {
  fragments: readonly { name: string; lengthBp: number }[];
  vectorIndex: number;
  /** null = the NEBuilder default. */
  vectorNg: number | null;
  /** null = the NEBuilder default. */
  ratio: number | null;
}

export interface AmountsTable {
  amounts: AssemblyAmounts | null;
  error?: string;
  /** Row index (in `amounts.rows`) → fragment index. */
  fragmentOfRow: number[];
}

/** DNA amounts for the assembly (vector row first, then the inserts in order). */
export function amountsFor({ fragments, vectorIndex, vectorNg, ratio }: AmountsInputs): AmountsTable {
  if (fragments.length < 2 || !fragments[vectorIndex]) return { amounts: null, fragmentOfRow: [] };
  const inserts = fragments.map((f, i) => ({ f, i })).filter((x) => x.i !== vectorIndex);
  try {
    const amounts = assemblyAmounts({
      vector: { name: fragments[vectorIndex].name, lengthBp: fragments[vectorIndex].lengthBp },
      inserts: inserts.map((x) => ({ name: x.f.name, lengthBp: x.f.lengthBp })),
      ...(vectorNg !== null && vectorNg > 0 ? { vectorNg } : {}),
      ...(ratio !== null && ratio > 0 ? { insertRatio: ratio } : {}),
    });
    return { amounts, fragmentOfRow: [vectorIndex, ...inserts.map((x) => x.i)] };
  } catch (e) {
    return { amounts: null, error: errorText(e), fragmentOfRow: [] };
  }
}

export function assemblyProductRecord(result: AssemblyResult, fragments: readonly SeqRecord[]): SeqRecord | null {
  const product = result.product;
  if (!product) return null;
  const overlaps = result.junctions.map((j) => `${j.overlapLength}`).join(', ');
  const how = `Gibson assembly (${formatBp(product.seq.length)}, ${product.topology}) of ${fragments.map((f) => f.name).join(', ')}; overlaps ${overlaps} bp`;
  return withProvenance({ ...product, id: newId('rec') }, how);
}

export function designProductRecord(design: GibsonDesign, vector: SeqRecord, inserts: readonly SeqRecord[]): SeqRecord | null {
  const product = design.product;
  if (!product) return null;
  const how =
    `Gibson assembly designed by HHereditas: ${inserts.map((r) => r.name).join(', ')} inserted into ${vector.name} ` +
    `with primers ${design.primers.map((p) => p.name).join(', ')}`;
  // The designed primers bind the product: keep them with it.
  const primers = [...product.primers, ...design.primers.filter((p) => !product.primers.some((q) => q.sequence === p.sequence))].map((p) => ({ ...p, id: newId('p') }));
  return withProvenance(withoutPrimerFeatures({ ...product, id: newId('rec'), primers }), how);
}

/**
 * Which designed primers go to which template document: the vector's pair to the vector
 * document, each insert's pair to the document it came from (primers already there, same
 * sequence, are skipped).
 */
export function primersForTemplates(
  design: GibsonDesign,
  vectorDocId: string,
  insertDocIds: readonly string[],
  documents: readonly DocumentState[],
): { docId: string; primers: Primer[] }[] {
  const pairs: string[] = design.fragments.length > insertDocIds.length ? [vectorDocId, ...insertDocIds] : [...insertDocIds];
  const plan = new Map<string, Primer[]>();
  pairs.forEach((docId, i) => {
    const pair = design.primers.slice(i * 2, i * 2 + 2);
    const doc = documents.find((d) => d.id === docId);
    if (!doc) return;
    const list = plan.get(docId) ?? [];
    for (const p of pair) {
      if (doc.record.primers.some((q) => q.sequence === p.sequence) || list.some((q) => q.sequence === p.sequence)) continue;
      list.push({ ...p, id: newId('p') });
    }
    plan.set(docId, list);
  });
  return [...plan.entries()].filter(([, primers]) => primers.length > 0).map(([docId, primers]) => ({ docId, primers }));
}
