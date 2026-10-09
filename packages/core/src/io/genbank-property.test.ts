/**
 * Property tests: random records (seeded, see test/oracle/genbank/random-records.ts) survive
 * writeGenbank -> parseGenbank unchanged, the output respects the INSDC line layout, the writer
 * is a fixed point, and (live oracle, skipped without the Python venv) Biopython 1.88 reads the
 * written files exactly like our reader.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SeqRecord } from '../types';
import { makeFeature, makeRecord } from '../seq/features';
import { parseGenbank, writeGenbank } from './genbank';
import { canonicalFromOracle, canonicalFromOurs, diffRecords, type OracleFile } from '../../test/oracle/genbank/compare';
import { Gen, randomRecord, rng } from '../../test/oracle/genbank/random-records';

const DATE = '15-MAR-2024';
const ROOT = join(__dirname, '../../../..');
const PYTHON = join(ROOT, 'tools/oracle/.venv/bin/python');
const ORACLE_SCRIPT = join(ROOT, 'tools/oracle/genbank_oracle.py');

/** True if a qualifier line could have been broken within 58 columns at a single, safe space. */
function canBreakWithinWidth(text: string): boolean {
  const first = text.startsWith('/') ? text.indexOf('=') + 2 : 1;
  for (let j = Math.max(first, 1); j <= Math.min(58, text.length - 2); j++) {
    if (text[j] === ' ' && /\S/.test(text[j - 1]) && /\S/.test(text[j + 1]) && text[j + 1] !== '/') return true;
  }
  return false;
}

const strip = (r: SeqRecord) => ({ ...r, id: '', features: r.features.map((f) => ({ ...f, id: '' })) });

describe('property: parseGenbank(writeGenbank(record)) == record', () => {
  it('for 400 seeded random records', () => {
    const g = new Gen(rng(1234));
    for (let iter = 0; iter < 400; iter++) {
      const record = randomRecord(g, DATE);
      const text = writeGenbank(record, { date: DATE });
      const back = parseGenbank(text);
      expect(back.warnings, text).toEqual([]);
      expect(back.records).toHaveLength(1);
      expect(strip(back.records[0])).toEqual(strip(record));
      expect(writeGenbank(back.records[0], { date: DATE })).toBe(text);

      // layout: header lines <= 80 columns, feature lines <= 79 columns except unbreakable text
      const lines = text.split('\n');
      const features = lines.indexOf('FEATURES             Location/Qualifiers');
      const origin = lines.indexOf('ORIGIN');
      lines.slice(0, features).forEach((l) => {
        if (!record.meta.extraHeaderLines?.includes(l) && !/\S{60,}/.test(l)) expect(l.length, l).toBeLessThanOrEqual(80);
      });
      lines.slice(features, origin).forEach((l) => {
        if (l.length > 79) expect(canBreakWithinWidth(l.slice(21)), l).toBe(false);
      });
      lines.slice(origin + 1, -2).forEach((l) => expect(l.length).toBeLessThanOrEqual(75));
    }
  });
});

describe.skipIf(!existsSync(PYTHON))('live oracle: Biopython reads random written records like our reader', () => {
  it('for 150 seeded random records', () => {
    const g = new Gen(rng(4321));
    const dir = mkdtempSync(join(tmpdir(), 'hhereditas-genbank-random-'));
    try {
      const written = Array.from({ length: 150 }, (_, k) => {
        // LOCUS names within the 16-character GenBank column: Biopython's fallback for longer
        // names drops the molecule type and topology of protein records.
        const record = randomRecord(g, DATE, 16);
        const path = join(dir, `r${k}.gb`);
        const text = writeGenbank(record, { date: DATE });
        writeFileSync(path, text);
        return { path, text };
      });
      const dumps = JSON.parse(
        execFileSync(PYTHON, [ORACLE_SCRIPT, '--dump', ...written.map((w) => w.path)], { encoding: 'utf8', maxBuffer: 256 << 20 }),
      ) as Record<string, OracleFile>;
      for (const w of written) {
        const dump = dumps[w.path];
        expect(dump.error, w.text).toBeNull();
        expect(dump.warnings, w.text).toEqual([]);
        const ours = canonicalFromOurs(parseGenbank(w.text).records[0]);
        expect(diffRecords(canonicalFromOracle(dump.records[0]), ours), w.text).toEqual([]);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it('for /translation values with escaped quotes at every wrapping position (review finding)', () => {
    // /translation is wrapped anywhere; a line must never end inside an escaped "" pair.
    const dir = mkdtempSync(join(tmpdir(), 'hhereditas-genbank-translation-'));
    try {
      const written: { path: string; text: string; value: string }[] = [];
      for (let at = 30; at < 130; at++) {
        for (const quotes of ['"', '""', '"""']) {
          const value = 'M'.repeat(at) + quotes + 'K'.repeat(20);
          const record = makeRecord({
            name: 't',
            seq: 'ACGT'.repeat(10),
            features: [makeFeature({ type: 'CDS', segments: [{ start: 0, end: 12 }], qualifiers: [{ key: 'translation', value }] })],
          });
          const path = join(dir, `t${written.length}.gb`);
          const text = writeGenbank(record, { date: DATE });
          writeFileSync(path, text);
          written.push({ path, text, value });
        }
      }
      const dumps = JSON.parse(
        execFileSync(PYTHON, [ORACLE_SCRIPT, '--dump', ...written.map((w) => w.path)], { encoding: 'utf8', maxBuffer: 256 << 20 }),
      ) as Record<string, OracleFile>;
      for (const w of written) {
        const dump = dumps[w.path];
        expect(dump.error, w.text).toBeNull();
        expect(dump.warnings, w.text).toEqual([]);
        expect(dump.records[0].features?.[0].qualifiers, w.text).toEqual([['translation', w.value]]);
        expect(diffRecords(canonicalFromOracle(dump.records[0]), canonicalFromOurs(parseGenbank(w.text).records[0])), w.text).toEqual([]);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
