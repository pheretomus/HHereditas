/**
 * Differential tests against Biopython 1.88 and pydna 5.5.16. The expected values were produced
 * by tools/oracle/ops_oracle.py (deterministic) and stored in test/oracle/ops/*.json; this file
 * does not need Python.
 *
 * Features are compared through what matters biologically: the canonical "path" (runs of
 * top-strand positions covered, in traversal order, contiguous runs merged — so a feature split
 * at the origin as join(s..L, 1..e) and one origin-crossing segment compare equal), between-base
 * sites, strand, partial flags ('<' / '>') and the extracted 5'->3' sequence.
 *
 * Deliberate deviations from the oracles (asserted below):
 *   - pydna's `shifted` (also used by its origin-crossing slicing) drops fuzzy ('<' / '>')
 *     positions; rotateOrigin and extractRange keep the partial flags of unclipped features, so
 *     partial flags are not compared with pydna (they are checked to be unchanged instead).
 *   - Biopython re-sorts features by start after reverse_complement; we keep the input order.
 *   - Biopython simulates an insertion as rec[:g] + insert + rec[g:], which keeps a zero-length
 *     feature at g twice (it fits both slices); insertBases keeps it once, before the insertion.
 *   - pydna's `looped` drops features longer than the circle; concatRecords clamps them to one
 *     full turn instead.
 */
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Feature, FragmentEnds, Range } from '../types';
import { deleteRange, insertBases, replaceRange } from './edit';
import { concatRecords, extractRange, reverseComplementRecord, rotateOrigin } from './transform';
import { featureView, fromOracleRecord, recordProblems } from './test-helpers';
import type { FeatureView, OracleRecord } from './test-helpers';

interface Expected {
  seq: string;
  features: FeatureView[];
}

interface OracleFile<C> {
  oracle: string;
  records: Record<string, OracleRecord>;
  cases: C[];
}

const ORACLE_DIR = new URL('../../test/oracle/ops/', import.meta.url);

function load<C>(name: string): OracleFile<C> {
  return JSON.parse(readFileSync(new URL(name, ORACLE_DIR), 'utf8')) as OracleFile<C>;
}

/** Compare one feature with its oracle view; `ignore` lists fields that are deliberately not compared. */
function expectSameFeature(ours: FeatureView, oracle: FeatureView, ignore: ReadonlyArray<keyof FeatureView> = []): void {
  const pick = (v: FeatureView) => {
    const out: Partial<FeatureView> = { ...v, id: oracle.id };
    if (oracle.seq === undefined) delete out.seq;
    for (const k of ignore) delete out[k];
    return out;
  };
  expect(pick(ours)).toEqual(pick(oracle));
}

/** Agreement statistics, printed once per suite for the report. */
const stats: Record<string, { cases: number; features: number }> = {};
function count(suite: string, features: number): void {
  stats[suite] ??= { cases: 0, features: 0 };
  stats[suite].cases++;
  stats[suite].features += features;
}

const present = existsSync(new URL('reverse_complement.json', ORACLE_DIR));

describe.skipIf(!present)('oracle: Biopython / pydna', () => {
  it('reverseComplementRecord matches Biopython SeqRecord.reverse_complement', () => {
    const data = load<{ record: string; expected: Expected }>('reverse_complement.json');
    for (const c of data.cases) {
      const rec = fromOracleRecord(data.records[c.record]);
      const out = reverseComplementRecord(rec);
      expect(out.seq, c.record).toBe(c.expected.seq);
      expect(recordProblems(out)).toEqual([]);
      expect(out.features.length).toBe(c.expected.features.length);
      // Biopython re-sorts features by start after flipping; we keep the input order
      const byId = new Map(out.features.map((f) => [f.id, f]));
      for (const e of c.expected.features) expectSameFeature(featureView(byId.get(e.id) as Feature, out), e);
      count('reverse_complement', c.expected.features.length);
    }
  });

  it('rotateOrigin matches pydna Dseqrecord.shifted', () => {
    const data = load<{ record: string; k: number; expected: Expected }>('rotate.json');
    for (const c of data.cases) {
      const rec = fromOracleRecord(data.records[c.record]);
      const out = rotateOrigin(rec, c.k);
      expect(out.seq, `${c.record} k=${c.k}`).toBe(c.expected.seq);
      expect(recordProblems(out)).toEqual([]);
      const byId = new Map(out.features.map((f) => [f.id, f]));
      expect(out.features.length).toBe(c.expected.features.length);
      for (const e of c.expected.features) {
        const f = byId.get(e.id);
        expect(f, `${c.record} k=${c.k} ${e.id}`).toBeDefined();
        expectSameFeature(featureView(f as Feature, out), e, ['partialStart', 'partialEnd']);
      }
      count('rotate', c.expected.features.length);
    }
  });

  it('extractRange keeps the features Biopython / pydna keep, unchanged', () => {
    const data = load<{ record: string; range: Range; expected: Expected }>('extract.json');
    for (const c of data.cases) {
      const rec = fromOracleRecord(data.records[c.record]);
      const out = extractRange(rec, c.range);
      const label = `${c.record} ${JSON.stringify(c.range)}`;
      expect(out.seq, label).toBe(c.expected.seq);
      expect(recordProblems(out)).toEqual([]);
      // origin-crossing slices come from pydna, which drops fuzzy positions while shifting
      const viaPydna = c.range.end > rec.seq.length;
      for (const e of c.expected.features) {
        const pieces = out.features.filter((f) => f.id === e.id);
        expect(pieces, `${label} ${e.id}`).toHaveLength(1);
        expectSameFeature(featureView(pieces[0], out), e, viaPydna ? ['partialStart', 'partialEnd'] : []);
        if (!viaPydna) continue;
        const original = rec.features.find((f) => f.id === e.id) as Feature;
        expect([pieces[0].partialStart ?? false, pieces[0].partialEnd ?? false]).toEqual([
          original.partialStart ?? false,
          original.partialEnd ?? false,
        ]);
      }
      count('extract', c.expected.features.length);
    }
  });

  it('concatRecords matches Biopython SeqRecord addition', () => {
    const data = load<{ parts: string[]; expected: Expected }>('concat.json');
    for (const c of data.cases) {
      const parts = c.parts.map((p) => fromOracleRecord(data.records[p]));
      const out = concatRecords(parts);
      expect(out.seq, c.parts.join(' + ')).toBe(c.expected.seq);
      expect(recordProblems(out)).toEqual([]);
      expect(out.features.length).toBe(c.expected.features.length);
      // same order as Biopython (left part first); ids may have been renamed on collision
      c.expected.features.forEach((e, i) => expectSameFeature(featureView(out.features[i], out, e.id), e));
      count('concat', c.expected.features.length);
    }
  });

  it('insertBases / deleteRange / replaceRange move untouched features like Biopython slicing', () => {
    const data = load<{ record: string; kind: 'insert' | 'delete' | 'replace'; range: Range; bases: string; expected: Expected }>(
      'edits.json',
    );
    for (const c of data.cases) {
      const rec = fromOracleRecord(data.records[c.record]);
      const out =
        c.kind === 'insert'
          ? insertBases(rec, c.range.start, c.bases)
          : c.kind === 'delete'
            ? deleteRange(rec, c.range)
            : replaceRange(rec, c.range, c.bases);
      const label = `${c.record} ${c.kind} ${JSON.stringify(c.range)} '${c.bases}'`;
      expect(out.seq, label).toBe(c.expected.seq);
      expect(recordProblems(out)).toEqual([]);
      const seen = new Map<string, number>();
      for (const e of c.expected.features) seen.set(e.id, (seen.get(e.id) ?? 0) + 1);
      let compared = 0;
      for (const e of c.expected.features) {
        if ((seen.get(e.id) ?? 0) > 1) {
          // Biopython duplicates a site at the insertion gap; we keep it once, on the left
          expect(e.path).toEqual([]);
          expect(out.features.find((f) => f.id === e.id)?.segments).toEqual([{ start: c.range.start, end: c.range.start }]);
          continue;
        }
        const f = out.features.find((g) => g.id === e.id);
        expect(f, `${label} ${e.id}`).toBeDefined();
        expectSameFeature(featureView(f as Feature, out), e);
        compared++;
      }
      count('edits', compared);
    }
  });

  it('concatRecords ligates sticky ends like pydna (+ and looped)', () => {
    const data = load<{
      parts: string[];
      expected: (Expected & { ends: FragmentEnds }) | { error: true };
      expectedCircular?: Expected | { error: true };
    }>('ligation.json');
    let errors = 0;
    for (const c of data.cases) {
      const parts = c.parts.map((p) => fromOracleRecord(data.records[p]));
      const label = c.parts.join(' + ');
      if ('error' in c.expected) {
        expect(() => concatRecords(parts), label).toThrow(/incompatible ends/);
        errors++;
        count('ligation', 0);
        continue;
      }
      const out = concatRecords(parts);
      expect(out.seq, label).toBe(c.expected.seq);
      const ends = out.ends ?? { left: { kind: 'blunt', length: 0 }, right: { kind: 'blunt', length: 0 } };
      expect(ends, label).toEqual(c.expected.ends);
      expect(out.features.length).toBe(c.expected.features.length);
      c.expected.features.forEach((e, i) => expectSameFeature(featureView(out.features[i], out), e));
      let compared = c.expected.features.length;
      const circ = c.expectedCircular;
      if (circ !== undefined && 'error' in circ) {
        expect(() => concatRecords(parts, { topology: 'circular' }), label).toThrow(/closing the circle/);
        errors++;
      } else if (circ !== undefined) {
        const ring = concatRecords(parts, { topology: 'circular' });
        expect(ring.seq, label).toBe(circ.seq);
        expect(recordProblems(ring)).toEqual([]);
        const kept = new Set(circ.features.map((e) => e.id));
        for (const f of ring.features) {
          if (!kept.has(f.id)) {
            // pydna drops a feature longer than the circle; we clamp it to one full turn
            const total = f.segments.reduce((n, s) => n + s.end - s.start, 0);
            expect(total, `${label} ${f.id}`).toBe(ring.seq.length);
          }
        }
        for (const e of circ.features) {
          const f = ring.features.find((g) => g.id === e.id);
          expect(f, `${label} ${e.id}`).toBeDefined();
          expectSameFeature(featureView(f as Feature, ring), e);
          compared++;
        }
      }
      count('ligation', compared);
    }
    expect(errors).toBeGreaterThan(0);
  });

  it('agreement summary', () => {
    const lines = Object.entries(stats).map(([k, v]) => `${k}: ${v.cases} cases, ${v.features} features compared`);
    console.log(`ops oracle agreement (100% required):\n  ${lines.join('\n  ')}`);
    expect(Object.keys(stats).length).toBe(6);
  });
});
