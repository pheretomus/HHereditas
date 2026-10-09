import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SeqRecord } from '@hhereditas/core';
import { makeRecord, parseAny } from '@hhereditas/core';
import { createDocument, type DocumentState } from '../../../state/documents';

export function sample(name: 'pUC19' | 'pBR322' | 'pBAD30'): SeqRecord {
  const text = readFileSync(join(__dirname, '../../../samples', `${name}.gb`), 'utf8');
  return { ...parseAny(text, `${name}.gb`).records[0], name };
}

export function doc(record: SeqRecord): DocumentState {
  return createDocument(record);
}

/** Deterministic pseudo-random DNA without BsaI / BsmBI sites. */
export function body(seed: number, length: number): string {
  let x = seed;
  let s = '';
  while (s.length < length) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    s += 'ACGT'[(x >> 16) & 3];
    if (/GGTCTC|GAGACC|CGTCTC|GAGACG/.test(s)) s = s.slice(0, -1);
  }
  return s;
}

/** A BsaI Golden Gate part releasing `left` + body + `right` (4-nt 5' overhangs). */
export function bsaPart(name: string, left: string, right: string, seed: number): SeqRecord {
  const seq = `TTGACA${'GGTCTC'}A${left}${body(seed, 120)}${right}T${'GAGACC'}TGTCAA`;
  return makeRecord({ name, seq, topology: 'linear' });
}
