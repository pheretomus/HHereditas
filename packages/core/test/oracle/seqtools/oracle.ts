/**
 * Test helpers for the seqtools oracle data (JSON written by tools/oracle/seqtools_oracle.py).
 * Test-only code: may use Node APIs.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/** Directory holding the seqtools oracle JSON files. */
export const ORACLE_DIR = import.meta.dirname;

/** Repository root (…/HHereditas). */
export const REPO_ROOT = path.resolve(ORACLE_DIR, '../../../../..');

/** Python interpreter of the oracle virtualenv (absent on machines without it). */
export const VENV_PYTHON = path.join(
  REPO_ROOT,
  'tools/oracle/.venv',
  process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
);

/** True when the oracle virtualenv exists, i.e. "live oracle" tests can run. */
export const HAS_VENV = existsSync(VENV_PYTHON);

/** The 4.6 Mb E. coli K-12 MG1655 genome (gitignored; tests using it skip when absent). */
export const ECOLI_GENBANK = path.join(REPO_ROOT, 'packages/core/test/fixtures/large/ecoli_U00096.3.gb');

/** True when the large E. coli fixture is present. */
export const HAS_ECOLI = existsSync(ECOLI_GENBANK);

/** Parse one oracle JSON file. */
export function loadOracle<T>(name: string): T {
  return JSON.parse(readFileSync(path.join(ORACLE_DIR, name), 'utf8')) as T;
}

/**
 * Minimal reader for the ORIGIN block of a single-record GenBank file (test helper only; the real
 * parser lives in src/io). Returns the uppercase sequence.
 */
export function readGenbankSequence(file: string): string {
  const text = readFileSync(file, 'latin1');
  const origin = text.indexOf('\nORIGIN');
  if (origin < 0) throw new Error(`${file}: no ORIGIN line`);
  const start = text.indexOf('\n', origin + 1);
  const end = text.indexOf('\n//', start);
  return text
    .slice(start, end < 0 ? undefined : end)
    .replace(/[^A-Za-z]/g, '')
    .toUpperCase();
}

/** One table of NCBI's gc.prt: names, amino acids and start/stop flags of the 64 codons in TCAG order. */
export interface GcPrtTable {
  names: string[];
  /** Amino acid of each codon ('*' = stop). */
  ncbieaa: string;
  /** 'M' for a start codon, '*' for a stop codon, '-' otherwise. */
  sncbieaa: string;
}

/** Parse NCBI's gc.prt (ASN.1 text, e.g. test/oracle/seqtools/ncbi_gc.prt) into table id -> table. */
export function parseGcPrt(text: string): Map<number, GcPrtTable> {
  const body = text
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
  const out = new Map<number, GcPrtTable>();
  for (const block of body.match(/\{[^{}]*\}/g) ?? []) {
    const id = /\bid\s+(\d+)/.exec(block);
    const aa = /\bncbieaa\s+"([^"]+)"/.exec(block);
    const starts = /\bsncbieaa\s+"([^"]+)"/.exec(block);
    if (!id || !aa || !starts) continue;
    const names = [...block.matchAll(/name\s+"([^"]*)"/g)].map((m) => m[1].replace(/\s+/g, ' '));
    out.set(Number(id[1]), { names, ncbieaa: aa[1], sncbieaa: starts[1] });
  }
  return out;
}

/** Deterministic pseudo-random generator (mulberry32) for property tests. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Random string over `alphabet` of length `n`. */
export function randomString(rand: () => number, alphabet: string, n: number): string {
  let s = '';
  for (let i = 0; i < n; i++) s += alphabet[Math.floor(rand() * alphabet.length)];
  return s;
}
