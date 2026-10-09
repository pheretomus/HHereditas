/**
 * GenBank round trips on every fixture:
 *  - parse(write(parse(x))) equals parse(x) (ids ignored; LOCUS date/division/molecule token that
 *    the first write had to invent are checked separately);
 *  - write(parse(write(parse(x)))) is byte-identical to write(parse(x)) (the writer's output is a
 *    fixed point) and re-reading it produces no warning, except the placeholder warning of a
 *    CONTIG entry (its sequence is not in the file, and must stay recognisable as such);
 *  - live oracle (skipped without the Python venv): Biopython 1.88 reads every written file exactly
 *    like it reads the original fixture (apart from the documented deviations), and exactly like
 *    our own reader reads the written file.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SeqRecord } from '../types';
import type { ParseWarning } from './types';
import { GENBANK_EXTRA_KEYS, parseGenbank, writeGenbank } from './genbank';
import { locusDivision } from './genbank-locus';
import {
  canonicalFromOracle,
  canonicalFromOurs,
  diffRecords,
  type OracleFile,
} from '../../test/oracle/genbank/compare';
import { GENBANK_FEATURE_DEVIATIONS, GENBANK_RECORD_DEVIATIONS } from '../../test/oracle/genbank/deviations';

const ROOT = join(__dirname, '../../../..');
const FIXTURES = join(__dirname, '../../test/fixtures/genbank');
const ORACLE = join(__dirname, '../../test/oracle/genbank/biopython');
const PYTHON = join(ROOT, 'tools/oracle/.venv/bin/python');
const ORACLE_SCRIPT = join(ROOT, 'tools/oracle/genbank_oracle.py');
const DATE = '08-OCT-2026';

const files = readdirSync(FIXTURES).sort();

/** Deep copy without the regenerated ids (record and features). */
function withoutIds(r: SeqRecord): unknown {
  return { ...r, id: undefined, features: r.features.map((f) => ({ ...f, id: undefined })) };
}

/** What the writer adds to a record that lacks LOCUS fields: date, division, molecule token. */
function withWriterDefaults(r: SeqRecord): SeqRecord {
  const meta = { ...r.meta };
  meta.date ??= DATE;
  meta.division = locusDivision(meta);
  if (r.molecule !== 'protein' && meta.extras?.[GENBANK_EXTRA_KEYS.moleculeType] === undefined) {
    meta.extras = { ...meta.extras, [GENBANK_EXTRA_KEYS.moleculeType]: r.molecule };
  }
  return { ...r, meta };
}

/**
 * Warnings of re-reading a written record: none, except for a CONTIG entry whose sequence is
 * still the N placeholder. The writer keeps its CONTIG section instead of writing the placeholder
 * as an ORIGIN of 'n' (review finding: after one save the placeholder looked like real sequence),
 * so reading the output reports the placeholder again, like reading the original did.
 */
function rereadWarnings(r: SeqRecord): ParseWarning[] {
  if (r.meta.extras?.[GENBANK_EXTRA_KEYS.contig] === undefined || !/^N+$/.test(r.seq)) return [];
  const message =
    'CONTIG record: its sequence is assembled from other entries and is not in this file; ' +
    `the sequence was filled with ${r.seq.length} N (LOCUS length)`;
  return [{ message, line: 1, recordIndex: 0 }];
}

describe('GenBank round trip on every fixture', () => {
  it('covers CONTIG entries (DS830848.gb, bad_origin_wrap.gb, bad_origin_wrap_linear.gb)', () => {
    const contigs = files.filter((file) =>
      parseGenbank(readFileSync(join(FIXTURES, file), 'utf8')).records.some((r) => rereadWarnings(r).length > 0),
    );
    expect(contigs).toEqual(['DS830848.gb', 'bad_origin_wrap.gb', 'bad_origin_wrap_linear.gb']);
  });

  for (const file of files) {
    it(file, () => {
      const first = parseGenbank(readFileSync(join(FIXTURES, file), 'utf8'));
      expect(first.records.length).toBeGreaterThan(0);
      for (const record of first.records) {
        const written = writeGenbank(record, { date: DATE });
        const second = parseGenbank(written);
        expect(second.warnings).toEqual(rereadWarnings(record));
        expect(second.records).toHaveLength(1);
        expect(withoutIds(second.records[0])).toEqual(withoutIds(withWriterDefaults(record)));
        expect(writeGenbank(second.records[0], { date: DATE })).toBe(written);
      }
    });
  }

  it('a whole multi-record file round-trips record by record (cor6_6.gb)', () => {
    const first = parseGenbank(readFileSync(join(FIXTURES, 'cor6_6.gb'), 'utf8'));
    const text = first.records.map((r) => writeGenbank(r, { date: DATE })).join('');
    const second = parseGenbank(text);
    expect(second.warnings).toEqual([]);
    expect(second.records.map(withoutIds)).toEqual(first.records.map((r) => withoutIds(withWriterDefaults(r))));
  });
});

const haveVenv = existsSync(PYTHON);

describe.skipIf(!haveVenv)('live oracle: Biopython reads writeGenbank output', () => {
  it('like the original fixture and like our reader', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hhereditas-genbank-'));
    try {
      const written: { file: string; index: number; path: string; text: string }[] = [];
      for (const file of files) {
        const parsed = parseGenbank(readFileSync(join(FIXTURES, file), 'utf8'));
        parsed.records.forEach((record, index) => {
          const path = join(dir, `${file}.${index}.gb`);
          const text = writeGenbank(record, { date: DATE });
          writeFileSync(path, text);
          written.push({ file, index, path, text });
        });
      }
      const output = execFileSync(PYTHON, [ORACLE_SCRIPT, '--dump', ...written.map((w) => w.path)], {
        encoding: 'utf8',
        maxBuffer: 256 * 1024 * 1024,
      });
      const dumps = JSON.parse(output) as Record<string, OracleFile>;
      let compared = 0;
      for (const w of written) {
        const dump = dumps[w.path];
        expect(dump.error, w.path).toBeNull();
        expect(dump.warnings, w.path).toEqual([]);
        expect(dump.records).toHaveLength(1);
        const biopythonOfOutput = canonicalFromOracle(dump.records[0]);

        // 1. Biopython and our reader agree on the written text, without any deviation.
        const oursOfOutput = canonicalFromOurs(parseGenbank(w.text).records[0]);
        expect(diffRecords(biopythonOfOutput, oursOfOutput), `${w.file}#${w.index} vs our reader`).toEqual([]);

        // 2. Biopython reads the written file like the original (documented deviations apart).
        const original = JSON.parse(readFileSync(join(ORACLE, `${w.file}.json`), 'utf8')) as OracleFile;
        if (original.error !== null) continue; // Biopython cannot read the original (no_origin_no_end.gb)
        const expected = canonicalFromOracle(original.records[w.index]);
        // The writer fills LOCUS fields the original lacked.
        expected.date ??= DATE;
        expected.division ??= 'SYN';
        const deviations = GENBANK_FEATURE_DEVIATIONS.filter((d) => d.file === w.file && d.record === w.index);
        const tokenDeviation = GENBANK_RECORD_DEVIATIONS.some((d) => d.file === w.file && d.record === w.index);
        const diffs = diffRecords(expected, biopythonOfOutput, deviations, { compareMoleculeToken: !tokenDeviation });
        expect(diffs, `${w.file}#${w.index} vs original`).toEqual([]);
        // References are written verbatim: Biopython must see exactly the same citations.
        expect(dump.records[0].references, w.path).toEqual(original.records[w.index].references);
        expect(dump.records[0].dbxrefs, w.path).toEqual(original.records[w.index].dbxrefs);
        compared++;
      }
      expect(compared).toBe(written.length - 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
