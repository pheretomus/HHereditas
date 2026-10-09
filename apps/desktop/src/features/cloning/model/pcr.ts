/**
 * PCR wizard model: primers chosen from the template's primers or typed, the simulated
 * reaction, and the product as a new document.
 */
import type { PcrResult, Primer, SeqRecord } from '@hhereditas/core';
import { newId, normalizeDna, pcr, reverseComplement } from '@hhereditas/core';
import { primerSites } from '../../../state/analysis';
import { errorText, formatBp, withoutPrimerFeatures, withProvenance } from './common';

/** A primer of the wizard: one stored with the template, or a typed sequence. */
export type PrimerChoice = { kind: 'saved'; primerId: string } | { kind: 'custom'; sequence: string };

/** Primers made from a selection use this many bases at each end. */
export const SELECTION_PRIMER_LENGTH = 20;

export interface ResolvedPrimer {
  primer: Primer | null;
  /** Why the choice is not usable (empty, invalid letters...). */
  problem?: string;
}

export function resolvePrimer(record: SeqRecord, choice: PrimerChoice, fallbackName: string): ResolvedPrimer {
  if (choice.kind === 'saved') {
    const p = record.primers.find((x) => x.id === choice.primerId);
    return p ? { primer: p } : { primer: null, problem: 'The primer no longer exists' };
  }
  const clean = normalizeDna(choice.sequence);
  if (clean.invalid.length) return { primer: null, problem: `Not IUPAC DNA: ${clean.invalid.join(' ')}` };
  if (clean.seq.length === 0) return { primer: null, problem: 'Enter a primer sequence' };
  if (clean.seq.length < 10) return { primer: null, problem: 'A primer needs at least 10 nt' };
  return { primer: { id: `custom-${fallbackName}`, name: fallbackName, sequence: clean.seq } };
}

/** Primers amplifying a selected range: its first bases (forward) and the reverse complement of its last bases. */
export function primersForRange(seq: string): { forward: string; reverse: string } {
  const n = Math.min(SELECTION_PRIMER_LENGTH, seq.length);
  return { forward: seq.slice(0, n), reverse: reverseComplement(seq.slice(seq.length - n)) };
}

/**
 * Starting primers: from a selection (amplify it), else the template's first primer binding
 * the top strand and first binding the bottom strand, else empty.
 */
export function defaultPrimers(record: SeqRecord, selectedSeq: string | null): { forward: PrimerChoice; reverse: PrimerChoice } {
  if (selectedSeq && selectedSeq.length >= 30) {
    const p = primersForRange(selectedSeq);
    return { forward: { kind: 'custom', sequence: p.forward }, reverse: { kind: 'custom', sequence: p.reverse } };
  }
  const { sites } = primerSites(record);
  const fwd = sites.find((s) => s.strand === 1);
  const rev = sites.find((s) => s.strand === -1 && s.primerId !== fwd?.primerId);
  return {
    forward: fwd ? { kind: 'saved', primerId: fwd.primerId } : { kind: 'custom', sequence: '' },
    reverse: rev ? { kind: 'saved', primerId: rev.primerId } : { kind: 'custom', sequence: '' },
  };
}

export interface PcrPreview {
  result: PcrResult | null;
  /** Problem with the inputs (shown instead of running the reaction). */
  inputError?: string;
  forward: Primer | null;
  reverse: Primer | null;
}

export function runPcr(record: SeqRecord, forward: PrimerChoice, reverse: PrimerChoice): PcrPreview {
  const f = resolvePrimer(record, forward, `${record.name}-F`);
  const r = resolvePrimer(record, reverse, `${record.name}-R`);
  if (!f.primer || !r.primer) {
    return { result: null, forward: f.primer, reverse: r.primer, inputError: f.problem ? `Forward primer: ${f.problem}` : `Reverse primer: ${r.problem}` };
  }
  if (record.seq.length === 0) return { result: null, forward: f.primer, reverse: r.primer, inputError: 'The template is empty' };
  try {
    return { result: pcr(record, f.primer, r.primer, { name: `${record.name} PCR` }), forward: f.primer, reverse: r.primer };
  } catch (e) {
    return { result: null, forward: f.primer, reverse: r.primer, inputError: errorText(e) };
  }
}

/** The chosen amplicon as a document record, with its primers (fresh ids) and a provenance comment. */
export function pcrProductRecord(template: SeqRecord, preview: PcrPreview, index: number): SeqRecord | null {
  const product = preview.result?.products[index];
  const { forward, reverse } = preview;
  if (!product || !forward || !reverse) return null;
  const primers = product.primers.map((p) => ({ ...p, id: newId('p') }));
  const how = `PCR product (${formatBp(product.seq.length)}) of ${template.name} with primers ${forward.name} (${forward.sequence}) and ${reverse.name} (${reverse.sequence})`;
  return withProvenance(withoutPrimerFeatures({ ...product, id: newId('rec'), primers }), how);
}
