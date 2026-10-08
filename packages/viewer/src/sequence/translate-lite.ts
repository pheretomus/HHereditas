/**
 * A tiny translator used as the sequence view's default until the app injects the core one
 * (`translate` prop). Standard genetic code; an ambiguous IUPAC codon gives its amino acid
 * when every codon it may stand for agrees (GCN -> A), otherwise X. Only the start codons
 * differ between tables 1 and 11 (the codes used by most records); other tables are read with
 * the standard code.
 */
import type { Feature } from '@hhereditas/core';
import { IUPAC_DNA, getQualifier } from '@hhereditas/core';

/** Amino acid of codon b1 b2 b3 (T=0, C=1, A=2, G=3): index 16*b1 + 4*b2 + b3. */
const STANDARD_CODE = 'FFLLSSSSYY**CC*WLLLLPPPPHHQQRRRRIIIMTTTTNNKKSSRRVVVVAAAADDEEGGGG';
const BASE_INDEX: Readonly<Record<string, number>> = { T: 0, C: 1, A: 2, G: 3, U: 0 };

const START_CODONS: Readonly<Record<number, ReadonlySet<string>>> = {
  1: new Set(['ATG', 'TTG', 'CTG']),
  11: new Set(['ATG', 'GTG', 'TTG', 'CTG', 'ATT', 'ATC', 'ATA']),
};
const DEFAULT_STARTS: ReadonlySet<string> = new Set(['ATG']);

const ambiguousCache = new Map<string, string>();

function expand(ch: string): string | undefined {
  return ch === 'U' ? 'T' : IUPAC_DNA[ch];
}

/** One-letter amino acid of an upper-case codon ('X' when undetermined). */
export function codonToAminoAcid(codon: string): string {
  const i1 = BASE_INDEX[codon[0]];
  const i2 = BASE_INDEX[codon[1]];
  const i3 = BASE_INDEX[codon[2]];
  if (i1 !== undefined && i2 !== undefined && i3 !== undefined) return STANDARD_CODE[i1 * 16 + i2 * 4 + i3];
  const cached = ambiguousCache.get(codon);
  if (cached !== undefined) return cached;
  const e1 = expand(codon[0]);
  const e2 = expand(codon[1]);
  const e3 = expand(codon[2]);
  let aa = 'X';
  if (e1 && e2 && e3) {
    let found = '';
    let agree = true;
    for (const a of e1) {
      for (const b of e2) {
        for (const c of e3) {
          const r = STANDARD_CODE[BASE_INDEX[a] * 16 + BASE_INDEX[b] * 4 + BASE_INDEX[c]];
          if (found === '') found = r;
          else if (found !== r) agree = false;
        }
      }
    }
    if (agree && found) aa = found;
  }
  ambiguousCache.set(codon, aa);
  return aa;
}

export interface TranslateLiteOptions {
  /** NCBI table id; only changes which first codons count as starts (1 and 11). Default 1. */
  table?: number;
  /** Translate the first codon as M when it is a start codon of the table. Default false. */
  initiator?: boolean;
}

/** Translate the complete codons of `dna` (read from index 0; a trailing partial codon is ignored). */
export function translateLite(dna: string, options: TranslateLiteOptions = {}): string {
  const s = dna.toUpperCase();
  const n = Math.floor(s.length / 3);
  const out = new Array<string>(n);
  const starts = START_CODONS[options.table ?? 1] ?? DEFAULT_STARTS;
  for (let k = 0; k < n; k++) {
    const codon = s.slice(3 * k, 3 * k + 3);
    out[k] = k === 0 && options.initiator && starts.has(codon) ? 'M' : codonToAminoAcid(codon);
  }
  return out.join('');
}

/**
 * Default `translate` of the sequence view: `codingDna` is the feature's coding sequence from
 * its first complete codon (/codon_start applied), a whole number of codons. The first codon is
 * read as an initiator when the feature starts at codon_start 1 and is not 5'-partial.
 */
export function translateFeatureLite(codingDna: string, feature: Feature): string {
  const tableText = getQualifier(feature.qualifiers, 'transl_table');
  const table = tableText !== undefined && /^\s*\d+\s*$/.test(tableText) ? Number(tableText) : 1;
  const codonStart = getQualifier(feature.qualifiers, 'codon_start')?.trim() ?? '1';
  return translateLite(codingDna, { table, initiator: codonStart === '1' && !feature.partialStart });
}
