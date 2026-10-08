/** Display formatting used across the shell (en-US style numbers: 3,938 bp). */
import type { MoleculeType, Topology } from '@hhereditas/core';
import { formatCompactBp, formatInt } from '@hhereditas/viewer';

/** Unit of a sequence length: "aa" for proteins, "bp" otherwise. */
export function lengthUnit(molecule?: MoleculeType): string {
  return molecule === 'protein' ? 'aa' : 'bp';
}

/** 3938 → "3,938 bp" (or "aa" for proteins). */
export function formatLength(length: number, molecule?: MoleculeType): string {
  return `${formatInt(length)} ${lengthUnit(molecule)}`;
}

/** Compact length for lists: 3938 → "3.94 kb", 4641652 → "4.64 Mb", 860 → "860 bp". */
export function formatCompactLength(length: number, molecule?: MoleculeType): string {
  if (molecule === 'protein') return `${formatInt(length)} aa`;
  const compact = formatCompactBp(length);
  return length < 1000 ? `${compact} bp` : compact;
}

/** Toolbar subtitle: "3,938 bp · circular". */
export function formatDocumentSubtitle(length: number, topology: Topology, molecule?: MoleculeType): string {
  if (molecule === 'protein') return formatLength(length, molecule);
  return `${formatLength(length, molecule)} · ${topology}`;
}

/** 52.25 → "52.3 %". */
export function formatPercent(value: number, digits = 1): string {
  return `${value.toFixed(digits)} %`;
}
