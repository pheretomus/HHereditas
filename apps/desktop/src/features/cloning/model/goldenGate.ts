/**
 * Golden Gate wizard model: parts (open documents or selections), the Type IIS enzyme, the
 * assembly order and overhangs found by the engine.
 */
import type { GoldenGateResult, SeqRecord } from '@hhereditas/core';
import { getEnzyme, goldenGate, newId } from '@hhereditas/core';
import { annotatePieces, errorText, formatBp, isBare, withFirstProduct, withProvenance } from './common';

/** Type IIS enzymes offered (BsaI first: the default of MoClo / Golden Gate kits). */
export const GOLDEN_GATE_ENZYMES: readonly { name: string; note: string }[] = [
  { name: 'BsaI', note: 'GGTCTC · 4-nt overhangs' },
  { name: 'BsmBI', note: 'CGTCTC · 4-nt overhangs' },
  { name: 'Esp3I', note: 'CGTCTC · 4-nt overhangs' },
  { name: 'BbsI', note: 'GAAGAC · 4-nt overhangs' },
  { name: 'PaqCI', note: 'CACCTGC · 4-nt overhangs' },
  { name: 'SapI', note: 'GCTCTTC · 3-nt overhangs' },
].filter((e) => !!getEnzyme(e.name));

export interface GoldenGateInputs {
  parts: readonly SeqRecord[];
  enzyme: string;
  circular: boolean;
}

export function runGoldenGate({ parts, enzyme, circular }: GoldenGateInputs): GoldenGateResult | null {
  if (parts.length === 0) return null;
  try {
    const result = goldenGate(parts, { enzyme, circular });
    if (!result.product) return result;
    const pieces = result.order.map((o) => ({ name: parts[o.part].name, bare: isBare(parts[o.part]), strand: o.orientation === 'reverse' ? (-1 as const) : (1 as const) }));
    return withFirstProduct(result, annotatePieces(result.product, pieces, result.junctions));
  } catch (e) {
    return { products: [], warnings: [], junctions: [], fragments: [], order: [], error: errorText(e) };
  }
}

export interface OrderRow {
  key: string;
  position: number;
  name: string;
  orientation: 'forward' | 'reverse';
  /** Overhang at the part's left / right end in assembly order. */
  left: string;
  right: string;
  size: number;
}

/**
 * The assembly order as table rows: each part's position, orientation and the overhangs that
 * join it to its neighbours (junction i joins part i to part i+1; the last closes the circle).
 */
export function orderRows(result: GoldenGateResult, parts: readonly SeqRecord[]): OrderRow[] {
  const n = result.order.length;
  if (n === 0) return [];
  const junctions = result.junctions;
  return result.order.map((o, i) => {
    const before = junctions[(i - 1 + n) % n];
    const after = junctions[i];
    const fragment = result.fragments[o.part];
    return {
      key: `${i}`,
      position: i + 1,
      name: parts[o.part]?.name ?? `Part ${o.part + 1}`,
      orientation: o.orientation,
      left: i === 0 && junctions.length < n ? '—' : (before?.overlapSeq ?? '—'),
      right: after?.overlapSeq ?? '—',
      size: fragment?.seq.length ?? 0,
    };
  });
}

export function goldenGateProductRecord(result: GoldenGateResult, parts: readonly SeqRecord[], enzyme: string): SeqRecord | null {
  const product = result.product;
  if (!product) return null;
  const order = result.order.map((o) => `${parts[o.part]?.name ?? o.part + 1}${o.orientation === 'reverse' ? ' (reverse)' : ''}`).join(' → ');
  const overhangs = result.junctions.map((j) => j.overlapSeq).join(', ');
  const how = `Golden Gate assembly with ${enzyme} (${formatBp(product.seq.length)}): ${order}; overhangs ${overhangs}`;
  return withProvenance({ ...product, id: newId('rec') }, how);
}
