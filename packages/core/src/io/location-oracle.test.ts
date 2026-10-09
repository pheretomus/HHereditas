/**
 * Live oracle: `parseLocation` against Biopython 1.88 `Location.fromstring` (the call its
 * GenBank reader makes for every feature location) on seeded random INSDC locations: spans,
 * single bases, between-bases sites (also `L^1`), origin-spanning shorthand `s..e` (s > e) and
 * explicit `join(s..L,1..e)` on circular molecules, `join` / `order`, `complement(join(...))`
 * and `join(complement(b),complement(a))`, outward and inward fuzzy markers. Every part lies on
 * the molecule and all parts share one strand (out-of-range positions, mixed strands, remote
 * parts and `one-of` are deliberate deviations covered by location.test.ts and deviations.ts).
 *
 * Compared through the canonical view of test/oracle/genbank/compare.ts: top-strand segments
 * with origin crossings merged, strand, and whether the outer boundaries are fuzzy. Skipped when
 * the Python venv (tools/oracle/.venv) is absent.
 *
 * Deliberate difference, excluded from the random cases and pinned below: Biopython gives a
 * single fuzzy base `<n` / `>n` the marker on BOTH boundaries (BeforePosition(n-1),
 * BeforePosition(n)); we mark only the side the marker points to (`<n` = partialStart, written
 * back as `<n..n`, which Biopython reads with the start fuzzy only).
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Topology } from '../types';
import { formatLocation, parseLocation } from './location';
import { canonicalFromOracleLocation, type OracleLocation } from '../../test/oracle/genbank/compare';

const ROOT = join(__dirname, '../../../..');
const PYTHON = join(ROOT, 'tools/oracle/.venv/bin/python');
const SCRIPT = join(ROOT, 'tools/oracle/genbank_location_oracle.py');

/** Deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Case {
  text: string;
  length: number;
  circular: boolean;
}

interface OracleResult {
  location: OracleLocation | null;
  error: string | null;
  warnings: string[];
}

/** A random location whose parts all lie on a molecule of a random length, on one strand. */
function randomCase(r: () => number): Case {
  const int = (lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
  const circular = r() < 0.5;
  const L = r() < 0.2 ? int(1, 12) : int(13, 3000);
  const n = r() < 0.5 ? 1 : int(2, 5);
  const parts: string[] = []; // in top-strand order
  for (let k = 0; k < n; k++) {
    const kind = r();
    if (kind < 0.6 || L < 3) {
      let a = int(1, L);
      let b = int(1, L);
      if (a > b) [a, b] = [b, a];
      const lower = r() < 0.2 ? '<' : r() < 0.05 ? '>' : '';
      const upper = r() < 0.2 ? '>' : r() < 0.05 ? '<' : '';
      parts.push(a === b && !lower && !upper && r() < 0.5 ? `${a}` : `${lower}${a}..${upper}${b}`);
    } else if (kind < 0.75) {
      if (circular && r() < 0.3) parts.push(`${L}^1`);
      else {
        const a = int(1, L - 1);
        parts.push(`${a}^${a + 1}`);
      }
    } else if (circular) {
      const a = int(2, L);
      const b = int(1, a - 1);
      if (kind < 0.88) parts.push(`${r() < 0.2 ? '<' : ''}${a}..${r() < 0.2 ? '>' : ''}${b}`);
      else parts.push(`${r() < 0.2 ? '<' : ''}${a}..${L}`, `1..${r() < 0.2 ? '>' : ''}${b}`);
    } else {
      const a = int(1, L);
      parts.push(`${a}`);
    }
  }
  const op = r() < 0.15 ? 'order' : 'join';
  const mode = r();
  let text: string;
  if (parts.length === 1) text = mode < 0.5 ? parts[0] : `complement(${parts[0]})`;
  else if (mode < 0.4) text = `${op}(${parts.join(',')})`;
  else if (mode < 0.75) text = `complement(${op}(${parts.join(',')}))`;
  else text = `${op}(${[...parts].reverse().map((p) => `complement(${p})`).join(',')})`;
  return { text, length: L, circular };
}

function runOracle(cases: readonly Case[]): OracleResult[] {
  const dir = mkdtempSync(join(tmpdir(), 'hhereditas-location-oracle-'));
  try {
    const path = join(dir, 'cases.json');
    writeFileSync(path, JSON.stringify(cases));
    return JSON.parse(execFileSync(PYTHON, [SCRIPT, path], { encoding: 'utf8', maxBuffer: 256 << 20 })) as OracleResult[];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe.skipIf(!existsSync(PYTHON))('live oracle: parseLocation agrees with Biopython 1.88 Location.fromstring', () => {
  it('on 3000 seeded random locations', () => {
    const next = rng(20261008);
    const cases = Array.from({ length: 3000 }, () => randomCase(next));
    const oracle = runOracle(cases);
    expect(oracle).toHaveLength(cases.length);
    cases.forEach((c, k) => {
      const topology: Topology = c.circular ? 'circular' : 'linear';
      const where = `${c.text} (L=${c.length}, ${topology})`;
      const bio = oracle[k];
      expect(bio.error, where).toBeNull();
      const ours = parseLocation(c.text, c.length, topology);
      if (!ours.ok) throw new Error(`${where}: ${ours.error}`);
      const expected = canonicalFromOracleLocation(bio.location, c.length, c.circular, false);
      expect({ strand: ours.strand, segments: ours.segments, partialStart: ours.partialStart, partialEnd: ours.partialEnd }, where).toEqual(expected);
      // and what we write back reads the same in Biopython
      const written = formatLocation(ours, c.length, topology);
      expect(parseLocation(written, c.length, topology), where).toMatchObject({ ok: true, segments: ours.segments, strand: ours.strand });
    });
    // formatLocation output, read by Biopython, gives the same canonical locations
    const rewritten = cases.map((c) => {
      const topology: Topology = c.circular ? 'circular' : 'linear';
      const ours = parseLocation(c.text, c.length, topology);
      return { ...c, text: ours.ok ? formatLocation(ours, c.length, topology) : c.text };
    });
    const oracle2 = runOracle(rewritten);
    rewritten.forEach((c, k) => {
      const where = `${cases[k].text} -> ${c.text} (L=${c.length})`;
      expect(oracle2[k].error, where).toBeNull();
      expect(oracle2[k].warnings, where).toEqual([]);
      expect(canonicalFromOracleLocation(oracle2[k].location, c.length, c.circular, false), where).toEqual(
        canonicalFromOracleLocation(oracle[k].location, c.length, c.circular, false),
      );
    });
  }, 120_000);

  it('differs only in the documented way on a single fuzzy base', () => {
    const cases: Case[] = ['<5', '>5', 'complement(<5)', '<5..5', '5..>5'].map((text) => ({ text, length: 10, circular: false }));
    const oracle = runOracle(cases);
    const kinds = oracle.map((o) => o.location?.parts.map((p) => [p.startKind, p.endKind]));
    expect(kinds).toEqual([[['before', 'before']], [['after', 'after']], [['before', 'before']], [['before', 'exact']], [['exact', 'after']]]);
    const ours = cases.map((c) => parseLocation(c.text, 10, 'linear')).map((r) => (r.ok ? [r.partialStart, r.partialEnd] : null));
    expect(ours).toEqual([
      [true, false],
      [false, true],
      [true, false],
      [true, false],
      [false, true],
    ]);
  });
});
