/**
 * Test support for the enzymes module: oracle JSON loading, fixture sequences, seeded randomness.
 * Test-only code (uses node:fs); never imported from src/ production files.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { FragmentEnds } from '../../../src/types';
import { reverseComplement } from '../../../src/seq/alphabet';

/** Directory holding the oracle JSON written by tools/oracle/enzymes_oracle.py. */
export const ORACLE_DIR = resolve(import.meta.dirname);
/** packages/core/test/fixtures */
export const FIXTURES_DIR = resolve(import.meta.dirname, '../../fixtures');
/** 4.6 Mb E. coli K-12 MG1655 genome (gitignored; tests using it must skip when absent). */
export const ECOLI_PATH = resolve(FIXTURES_DIR, 'large/ecoli_U00096.3.gb');
const ORACLE_TOOLS = resolve(import.meta.dirname, '../../../../../tools/oracle');
/** Live oracle script. */
export const LIVE_ORACLE_SCRIPT = resolve(ORACLE_TOOLS, 'enzymes_live.py');

/**
 * Python interpreter of the oracle virtual environment, or undefined when it is absent (live
 * tests then skip). The environment variable HH_ORACLE_PYTHON overrides the location.
 */
export function oraclePython(): string | undefined {
  const override = process.env.HH_ORACLE_PYTHON;
  const candidates = override
    ? [override]
    : [resolve(ORACLE_TOOLS, '.venv/bin/python'), resolve(ORACLE_TOOLS, '.venv/Scripts/python.exe')];
  return candidates.find((p) => existsSync(p));
}

export function readOracle<T>(name: string): T {
  return JSON.parse(readFileSync(resolve(ORACLE_DIR, name), 'utf8')) as T;
}

export function fileExists(path: string): boolean {
  return existsSync(path);
}

/** Sequence of a single-record GenBank file (ORIGIN block), upper-cased. Minimal reader for tests. */
export function genbankSequence(path: string): string {
  const text = readFileSync(path, 'utf8');
  const origin = text.search(/^ORIGIN/m);
  if (origin < 0) throw new Error(`no ORIGIN in ${path}`);
  const bodyStart = text.indexOf('\n', origin) + 1;
  const end = text.indexOf('\n//', bodyStart);
  return text.slice(bodyStart, end < 0 ? undefined : end).replace(/[^A-Za-z]/g, '').toUpperCase();
}

/** Small, fast, seedable PRNG (mulberry32); returns floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Random integer in [lo, hi] (inclusive). */
export function randInt(rand: () => number, lo: number, hi: number): number {
  return lo + Math.floor(rand() * (hi - lo + 1));
}

export function randomDna(n: number, rand: () => number, alphabet = 'ACGT'): string {
  let s = '';
  for (let i = 0; i < n; i++) s += alphabet[Math.floor(rand() * alphabet.length)];
  return s;
}

const IUPAC_SETS: Readonly<Record<string, string>> = {
  A: 'A', C: 'C', G: 'G', T: 'T', R: 'AG', Y: 'CT', S: 'CG', W: 'AT',
  K: 'GT', M: 'AC', B: 'CGT', D: 'AGT', H: 'ACT', V: 'ACG', N: 'ACGT',
};

/** A random concrete instance of an IUPAC recognition sequence. */
export function instantiate(site: string, rand: () => number): string {
  let s = '';
  for (const ch of site) {
    const set = IUPAC_SETS[ch];
    s += set[Math.floor(rand() * set.length)];
  }
  return s;
}

/** Overwrite `seq` with `text` starting at `pos` (wrapping around the end, as on a circle). */
export function plant(seq: string, pos: number, text: string): string {
  const out = seq.split('');
  for (let i = 0; i < text.length; i++) out[(pos + i) % out.length] = text[i];
  return out.join('');
}

/** Rotate a circular sequence so that base `k` becomes base 0. */
export function rotate(seq: string, k: number): string {
  const n = seq.length;
  const r = ((k % n) + n) % n;
  return seq.slice(r) + seq.slice(0, r);
}

/**
 * A fragment (full duplex `seq` + FragmentEnds) in pydna's representation: watson = top strand
 * 5'->3', crick = bottom strand 5'->3', ovhg = left overhang (negative: 5', positive: 3').
 */
export function pydnaStrands(seq: string, ends: FragmentEnds): { watson: string; crick: string; ovhg: number } {
  const n = seq.length;
  const { left, right } = ends;
  const topStart = left.kind === '3prime' ? left.length : 0; // left 3' overhang: bottom-only bases
  const topEnd = right.kind === '5prime' ? n - right.length : n; // right 5' overhang: bottom-only bases
  const bottomStart = left.kind === '5prime' ? left.length : 0;
  const bottomEnd = right.kind === '3prime' ? n - right.length : n;
  return {
    watson: seq.slice(topStart, topEnd),
    crick: reverseComplement(seq.slice(bottomStart, bottomEnd)),
    ovhg: left.kind === '5prime' ? -left.length : left.kind === '3prime' ? left.length : 0,
  };
}

/** Comparison key of a fragment: sequence, ends and pydna strands. */
export function fragmentKey(seq: string, ends: FragmentEnds): string {
  const p = pydnaStrands(seq, ends);
  return `${seq}|${ends.left.kind}:${ends.left.length}|${ends.right.kind}:${ends.right.length}|${p.watson}|${p.crick}|${p.ovhg}`;
}

/**
 * What makes a returned value unsafe for callers that modify results in place, one message per
 * problem with its path (empty list = fine): an object reachable twice (shared by two places of
 * the result), a frozen object, an object that is one of `inputs`, or a negative zero.
 */
export function resultObjectProblems(value: unknown, inputs: readonly object[] = []): string[] {
  const seen = new Map<object, string>();
  const problems: string[] = [];
  const visit = (v: unknown, path: string): void => {
    if (typeof v === 'number') {
      if (Object.is(v, -0)) problems.push(`${path} is -0`);
      return;
    }
    if (v === null || typeof v !== 'object') return;
    const first = seen.get(v);
    if (first !== undefined) {
      problems.push(`${path} is the same object as ${first}`);
      return;
    }
    seen.set(v, path);
    if (Object.isFrozen(v)) problems.push(`${path} is frozen`);
    if (inputs.includes(v)) problems.push(`${path} is an input object`);
    for (const [key, child] of Object.entries(v)) visit(child, `${path}.${key}`);
  };
  visit(value, 'result');
  return problems;
}
