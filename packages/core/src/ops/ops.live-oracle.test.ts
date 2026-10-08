/**
 * LIVE oracle test: random cases are generated here (seeded, with the edge-seeking TypeScript
 * generators of test-helpers.ts, which differ from the Python generator behind the stored
 * oracle JSON), evaluated at test time by Biopython 1.88 / pydna 5.5.16 through
 * tools/oracle/ops_live.py, and compared with our results.
 *
 * Skipped cleanly when the Python environment (tools/oracle/.venv) is absent.
 * Deviations from the oracles are the same as in ops.oracle.test.ts (pydna drops fuzzy
 * positions when shifting; Biopython duplicates a site at an insertion gap and moves a feature
 * as a block, while our per-segment rule keeps a zero-length segment at the gap before the
 * inserted bases; pydna drops features longer than a circularized molecule while we clamp them).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Feature, FragmentEnds, Range, SeqRecord } from '../types';
import { deleteRange, insertBases, replaceRange } from './edit';
import { concatRecords, extractRange, reverseComplementRecord, rotateOrigin } from './transform';
import {
  Rng,
  edgePosition,
  edgeRange,
  featureView,
  ligatableParts,
  randomBases,
  randomRecord,
  recordProblems,
  toOracleRecord,
} from './test-helpers';
import type { FeatureView, OracleRecord } from './test-helpers';

const ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const PYTHON = [
  join(ROOT, 'tools', 'oracle', '.venv', 'bin', 'python'),
  join(ROOT, 'tools', 'oracle', '.venv', 'Scripts', 'python.exe'), // Windows layout
].find((p) => existsSync(p));
const SCRIPT = join(ROOT, 'tools', 'oracle', 'ops_live.py');
const available = PYTHON !== undefined && existsSync(SCRIPT);

type LiveCase =
  | { op: 'rc'; record: OracleRecord }
  | { op: 'rotate'; record: OracleRecord; k: number }
  | { op: 'extract'; record: OracleRecord; range: Range }
  | { op: 'concat'; parts: OracleRecord[] }
  | { op: 'edit'; kind: 'insert' | 'delete' | 'replace'; record: OracleRecord; range: Range; bases: string }
  | { op: 'ligate'; parts: OracleRecord[]; circular: boolean };

interface LiveResult {
  seq: string;
  features: FeatureView[];
  kept?: string[];
  ends?: FragmentEnds;
  circular?: LiveResult | { error: true };
  error?: true;
  skip?: string;
}

/** A record whose multi-segment features have no zero-length segment (pydna merges those away). */
function withoutJoinedSites(rec: SeqRecord): SeqRecord {
  return { ...rec, features: rec.features.filter((f) => f.segments.length === 1 || f.segments.every((s) => s.end > s.start)) };
}

function generateCases(): Array<{ c: LiveCase; input: SeqRecord[] }> {
  const rng = new Rng(424242);
  const out: Array<{ c: LiveCase; input: SeqRecord[] }> = [];
  for (let i = 0; i < 500; i++) {
    const rec = randomRecord(rng, { iupac: true, endsProbability: 0 });
    out.push({ c: { op: 'rc', record: toOracleRecord(rec) }, input: [rec] });
  }
  for (let i = 0; i < 500; i++) {
    const rec = withoutJoinedSites(randomRecord(rng, { topology: 'circular', iupac: false }));
    out.push({ c: { op: 'rotate', record: toOracleRecord(rec), k: edgePosition(rng, rec, true) }, input: [rec] });
  }
  for (let i = 0; i < 500; i++) {
    const rec = randomRecord(rng, { iupac: false, endsProbability: 0 });
    const range = edgeRange(rng, rec);
    const len = range.end - range.start;
    // pydna's [a:a] means "linearize at a", not an empty slice: only proper arcs of circles
    if (rec.topology === 'circular' && (len === 0 || len === rec.seq.length)) continue;
    out.push({ c: { op: 'extract', record: toOracleRecord(rec), range }, input: [rec] });
  }
  for (let i = 0; i < 400; i++) {
    const parts = Array.from({ length: rng.int(1, 3) }, (_, j) =>
      randomRecord(rng, { topology: 'linear', iupac: true, endsProbability: 0, idPrefix: rng.bool() ? 'f' : `p${j}_` }),
    );
    out.push({ c: { op: 'concat', parts: parts.map(toOracleRecord) }, input: parts });
  }
  for (let i = 0; i < 600; i++) {
    const rec = randomRecord(rng, { topology: 'linear', iupac: true, endsProbability: 0 });
    const kind = rng.pick(['insert', 'delete', 'replace'] as const);
    const range = kind === 'insert' ? { start: edgePosition(rng, rec), end: 0 } : edgeRange(rng, rec);
    if (kind === 'insert') range.end = range.start;
    const bases = kind === 'delete' ? '' : randomBases(rng, rng.int(kind === 'insert' ? 1 : 0, 10));
    out.push({ c: { op: 'edit', kind, record: toOracleRecord(rec), range, bases }, input: [rec] });
  }
  for (let i = 0; i < 500; i++) {
    const closable = rng.bool(0.5);
    const { parts } = ligatableParts(rng, closable);
    let use = parts.map(withoutJoinedSites);
    if (parts.length > 1 && rng.bool(0.25)) {
      // break one junction by changing the first base of a left overhang
      const j = rng.int(1, parts.length - 1);
      const p = use[j];
      use = use.map((q, k) => (k === j ? { ...p, seq: (p.seq[0] === 'A' ? 'C' : 'A') + p.seq.slice(1) } : q));
    }
    out.push({ c: { op: 'ligate', parts: use.map(toOracleRecord), circular: closable }, input: use });
  }
  return out;
}

function runOracle(cases: LiveCase[]): LiveResult[] {
  const dir = mkdtempSync(join(tmpdir(), 'hh-ops-live-'));
  try {
    const input = join(dir, 'cases.json');
    const output = join(dir, 'results.json');
    writeFileSync(input, JSON.stringify(cases));
    execFileSync(PYTHON as string, [SCRIPT, input, output], { stdio: 'pipe', timeout: 120_000 });
    return JSON.parse(readFileSync(output, 'utf8')) as LiveResult[];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function expectSameFeature(ours: FeatureView, oracle: FeatureView, ignore: ReadonlyArray<keyof FeatureView> = []): void {
  const pick = (v: FeatureView) => {
    const out: Partial<FeatureView> = { ...v, id: oracle.id };
    if (oracle.seq === undefined) delete out.seq;
    for (const k of ignore) delete out[k];
    return out;
  };
  expect(pick(ours)).toEqual(pick(oracle));
}

function totalLength(f: Feature): number {
  return f.segments.reduce((n, s) => n + s.end - s.start, 0);
}

function byId(rec: SeqRecord, id: string): Feature {
  const f = rec.features.find((g) => g.id === id);
  expect(f, `feature ${id}`).toBeDefined();
  return f as Feature;
}

/** Compare our record with an oracle result, matching features by position in the list. */
function expectSameInOrder(out: SeqRecord, res: LiveResult): number {
  expect(out.seq).toBe(res.seq);
  expect(out.features.length).toBe(res.features.length);
  res.features.forEach((e, i) => expectSameFeature(featureView(out.features[i], out, e.id), e));
  return res.features.length;
}

describe.skipIf(!available)('live oracle: Biopython / pydna at test time', () => {
  it('agrees on freshly generated random cases', { timeout: 180_000 }, () => {
    const generated = generateCases();
    const results = runOracle(generated.map((g) => g.c));
    expect(results.length).toBe(generated.length);
    const stats: Record<string, { cases: number; features: number; skipped: number }> = {};
    generated.forEach(({ c, input }, i) => {
      const res = results[i];
      const s = (stats[c.op] ??= { cases: 0, features: 0, skipped: 0 });
      if (res.skip !== undefined) {
        s.skipped++;
        return;
      }
      s.cases++;
      try {
        s.features += check(c, input, res);
      } catch (err) {
        throw new Error(`live case #${i} (${c.op}): ${err instanceof Error ? err.message : String(err)}\n${JSON.stringify(c)}`, {
          cause: err,
        });
      }
    });
    const lines = Object.entries(stats).map(([k, v]) => `${k}: ${v.cases} cases, ${v.features} features compared, ${v.skipped} skipped`);
    console.log(`ops live oracle agreement (100% required):\n  ${lines.join('\n  ')}`);
    for (const v of Object.values(stats)) expect(v.skipped).toBeLessThanOrEqual(v.cases / 20);
  });
});

/** Check one case; returns the number of features compared. */
function check(c: LiveCase, input: SeqRecord[], res: LiveResult): number {
  switch (c.op) {
    case 'rc': {
      const out = reverseComplementRecord(input[0]);
      expect(out.seq).toBe(res.seq);
      for (const e of res.features) expectSameFeature(featureView(byId(out, e.id), out), e);
      return res.features.length;
    }
    case 'rotate': {
      const out = rotateOrigin(input[0], c.k);
      expect(out.seq).toBe(res.seq);
      // pydna sorts the shifted features by start; compare the sets of ids
      expect(res.features.map((e) => e.id).sort()).toEqual([...(res.kept ?? [])].sort());
      for (const e of res.features) expectSameFeature(featureView(byId(out, e.id), out), e, ['partialStart', 'partialEnd']);
      return res.features.length;
    }
    case 'extract': {
      const out = extractRange(input[0], c.range);
      expect(out.seq).toBe(res.seq);
      expect(recordProblems(out)).toEqual([]);
      const viaPydna = c.range.end > input[0].seq.length;
      for (const e of res.features) {
        const pieces = out.features.filter((f) => f.id === e.id);
        expect(pieces).toHaveLength(1);
        expectSameFeature(featureView(pieces[0], out), e, viaPydna ? ['partialStart', 'partialEnd'] : []);
      }
      return res.features.length;
    }
    case 'concat':
      return expectSameInOrder(concatRecords(input), res);
    case 'edit': {
      const rec = input[0];
      const out =
        c.kind === 'insert'
          ? insertBases(rec, c.range.start, c.bases)
          : c.kind === 'delete'
            ? deleteRange(rec, c.range)
            : replaceRange(rec, c.range, c.bases);
      expect(out.seq).toBe(res.seq);
      const counts = new Map<string, number>();
      for (const e of res.features) counts.set(e.id, (counts.get(e.id) ?? 0) + 1);
      let n = 0;
      const gap = c.range.start;
      const pureInsertion = c.range.end === c.range.start;
      for (const e of res.features) {
        if ((counts.get(e.id) ?? 0) > 1) continue; // a site at the insertion gap, duplicated by Biopython
        const original = byId(rec, e.id);
        if (pureInsertion && original.segments.some((s) => s.start === gap && s.end === gap)) {
          // Biopython moves a feature as a block; our per-segment rule keeps a zero-length
          // segment at the insertion gap before the inserted bases.
          const ours = byId(out, e.id);
          original.segments.forEach((s, j) => {
            if (s.start === gap && s.end === gap) expect(ours.segments[j]).toEqual({ start: gap, end: gap });
          });
          continue;
        }
        expectSameFeature(featureView(byId(out, e.id), out), e);
        n++;
      }
      return n;
    }
    case 'ligate': {
      if (res.error) {
        expect(() => concatRecords(input)).toThrow(/incompatible ends/);
        return 0;
      }
      const out = concatRecords(input);
      let n = expectSameInOrder(out, res);
      expect(out.ends ?? { left: { kind: 'blunt', length: 0 }, right: { kind: 'blunt', length: 0 } }).toEqual(res.ends);
      const circ = res.circular;
      if (!c.circular || circ === undefined) return n;
      if ('error' in circ) {
        expect(() => concatRecords(input, { topology: 'circular' })).toThrow(/closing the circle/);
        return n;
      }
      const ring = concatRecords(input, { topology: 'circular' });
      expect(ring.seq).toBe(circ.seq);
      // Features are matched in order. When closing the circle merges overhangs, pydna's looped()
      // drops a feature whose total length exceeds the circle; we keep it, each segment clamped
      // to one turn (covered by the property tests).
      const merged = ring.seq.length < out.seq.length;
      let k = 0;
      ring.features.forEach((f, idx) => {
        if (merged && totalLength(out.features[idx]) > ring.seq.length) return;
        const e = circ.features[k++];
        expect(e, `circular feature ${f.id}`).toBeDefined();
        // looped() re-creates merged features with shift_location, which drops fuzzy ends
        expectSameFeature(featureView(f, ring, e.id), e, merged ? ['partialStart', 'partialEnd'] : []);
        expect(f.partialStart).toBe(out.features[idx].partialStart);
        expect(f.partialEnd).toBe(out.features[idx].partialEnd);
        n++;
      });
      expect(k).toBe(circ.features.length);
      return n;
    }
  }
}
