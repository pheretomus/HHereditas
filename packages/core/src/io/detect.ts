/**
 * Format detection and a single entry point for reading any supported sequence file.
 */
import { normalizeDna } from '../seq/alphabet';
import { makeRecord } from '../seq/features';
import { parseFasta } from './fasta';
import { parseGenbank } from './genbank';
import { isSnapGeneFile, parseSnapGene } from './snapgene';
import type { ParseResult } from './types';

export type DetectedFormat = 'genbank' | 'fasta' | 'snapgene' | 'raw' | 'unknown';

/** File-name extensions the app can open, for file dialogs. */
export const SEQUENCE_FILE_EXTENSIONS = {
  genbank: ['gb', 'gbk', 'genbank', 'gbff', 'ape'],
  snapgene: ['dna'],
  fasta: ['fa', 'fasta', 'fas', 'fna', 'ffn', 'faa'],
  raw: ['txt', 'seq'],
} as const;

function decodeText(data: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(data);
  } catch {
    return new TextDecoder('latin1').decode(data);
  }
}

function baseName(fileName?: string): string {
  if (!fileName) return 'Untitled';
  const file = fileName.split(/[\\/]/).pop() ?? fileName;
  return file.replace(/\.[^.]+$/, '') || 'Untitled';
}

/** Detect the format from the content (the file name is only a tie-breaker). */
export function detectFormat(data: Uint8Array | string, fileName?: string): DetectedFormat {
  if (typeof data !== 'string' && isSnapGeneFile(data)) return 'snapgene';
  const text = (typeof data === 'string' ? data : decodeText(data)).replace(/^﻿/, '');
  const head = text.trimStart();
  if (/^LOCUS\s/m.test(head.slice(0, 4096))) return 'genbank';
  if (head.startsWith('>') || head.startsWith(';')) return 'fasta';
  if (head.length > 0 && normalizeDna(head).invalid.length === 0) return 'raw';
  const ext = fileName?.split('.').pop()?.toLowerCase() ?? '';
  if ((SEQUENCE_FILE_EXTENSIONS.genbank as readonly string[]).includes(ext)) return 'genbank';
  if ((SEQUENCE_FILE_EXTENSIONS.fasta as readonly string[]).includes(ext)) return 'fasta';
  return 'unknown';
}

/** Read any supported file. Never throws; problems come back as warnings. */
export function parseAny(data: Uint8Array | string, fileName?: string): ParseResult {
  const format = detectFormat(data, fileName);
  if (format === 'snapgene' && typeof data !== 'string') return parseSnapGene(data, { fileName });
  const text = (typeof data === 'string' ? data : decodeText(data)).replace(/^﻿/, '');
  if (format === 'genbank') return parseGenbank(text);
  if (format === 'fasta') return parseFasta(text);
  if (format === 'raw') {
    const { seq } = normalizeDna(text);
    return { records: [makeRecord({ seq, name: baseName(fileName), meta: { sourceFormat: 'raw' } })], warnings: [] };
  }
  return { records: [], warnings: [{ message: `Unrecognised file format${fileName ? `: ${fileName}` : ''}` }] };
}
