/**
 * Live oracle: files written by writeSnapGene are read back by Biopython and by the independent
 * expat/html.parser implementation of the HHereditas mapping (tools/oracle/snapgene_oracle.py
 * --dump). Skipped when the Python oracle environment (tools/oracle/.venv) is absent.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeFeature, makeRecord } from '../seq/features';
import type { SeqRecord } from '../types';
import { parseSnapGene, writeSnapGene } from './snapgene';
import {
  DOCUMENTED_DEVIATIONS,
  FIXTURE_DIR,
  ORACLE_PYTHON,
  ORACLE_SCRIPT,
  type OracleEntry,
  Rng,
  type Tally,
  comparableExpected,
  comparableRecord,
  compareFeatureWithBiopython,
  compareRecordWithBiopython,
  randomRecord,
} from '../../test/oracle/snapgene/testkit';

const available = existsSync(ORACLE_PYTHON) && existsSync(ORACLE_SCRIPT);
const NOW = new Date(Date.UTC(2026, 9, 8, 12, 30, 0));

/** Records written for the live check: special cases, fixture round trips and seeded random records. */
function recordsToWrite(): Array<{ file: string; record: SeqRecord }> {
  const out: Array<{ file: string; record: SeqRecord }> = [];
  const special = makeRecord({
    name: 'special',
    description: 'Special & <odd> "characters" α µ 🧬',
    seq: 'GAATTCGGATCCAAGCTTCTGCAGGTCGACTCTAGAGCATGCCTGCAGGCATGCAAGCTT',
    topology: 'circular',
    features: [
      makeFeature({ type: 'CDS', name: 'wrapping CDS', strand: 1, segments: [{ start: 50, end: 70 }], qualifiers: [{ key: 'label', value: 'wrapping CDS' }, { key: 'codon_start', value: '2' }], color: '#993366' }),
      makeFeature({ type: 'gene', name: 'reverse split', strand: -1, segments: [{ start: 5, end: 12 }, { start: 20, end: 31 }], qualifiers: [{ key: 'parts', value: '1:exon 2;2:exon 1' }, { key: 'note', value: '<b>bold</b> & "quoted" it\'s' }], color: '#ff7f50' }),
      makeFeature({ type: 'misc_feature', name: 'across origin', strand: 0, segments: [{ start: 55, end: 60 }, { start: 0, end: 8 }], color: '#a6acb3' }),
      makeFeature({ type: 'rep_origin', name: 'whole', strand: -1, segments: [{ start: 7, end: 67 }], qualifiers: [{ key: 'db_xref', value: 'GI:1234' }, { key: 'pseudo', value: null }] }),
    ],
    primers: [{ id: 'p', name: 'M13 <fwd>', sequence: 'GTAAAACGACGGCCAGT', description: 'α & β' }],
    meta: { comments: ['line one\nline <two> & three'], accession: 'X12345', organism: 'synthetic construct' },
  });
  out.push({ file: 'special.dna', record: special });
  out.push({ file: 'sticky.dna', record: makeRecord({ name: 'sticky', seq: 'AATTCGGATCCGGATCCAAGCTTCTGCAG', ends: { left: { kind: '5prime', length: 4 }, right: { kind: '3prime', length: 4 } } }) });
  for (const name of readdirSync(FIXTURE_DIR).filter((n) => n.endsWith('.dna'))) {
    out.push({ file: `fixture-${name}`, record: parseSnapGene(new Uint8Array(readFileSync(join(FIXTURE_DIR, name)))).records[0] });
  }
  const rng = new Rng(4242);
  for (let i = 0; i < 60; i++) out.push({ file: `random-${i}.dna`, record: randomRecord(rng, i) });
  return out;
}

describe.skipIf(!available)('SnapGene writer vs Biopython (live oracle)', () => {
  it('writes files that Biopython and an independent reader read as intended', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hhereditas-snapgene-'));
    try {
      const items = recordsToWrite().map(({ file, record }) => {
        const path = join(dir, file);
        writeFileSync(path, writeSnapGene(record, { now: NOW }));
        return { path, record };
      });
      const output = execFileSync(ORACLE_PYTHON, [ORACLE_SCRIPT, '--dump', ...items.map((i) => i.path)], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
      const dumps = JSON.parse(output) as Record<string, OracleEntry>;
      const tally: Tally = {};
      for (const { path, record } of items) {
        const entry = dumps[path];
        expect(entry, path).toBeDefined();
        expect(entry.biopython.error, path).toBeUndefined();
        const ours = parseSnapGene(new Uint8Array(readFileSync(path)), { fileName: path.split('/').pop() }).records[0];
        expect(entry.expected, path).not.toBeNull();
        if (entry.expected === null) continue;
        expect(comparableRecord(ours), path).toEqual(comparableExpected(entry.expected));
        const problems = compareRecordWithBiopython(ours, entry.biopython, tally);
        entry.expected.features.forEach((f, i) => problems.push(...compareFeatureWithBiopython(ours.features[i], f, ours.seq.length, tally)));
        expect(problems, path).toEqual([]);
        // What Biopython read is what was written.
        expect(ours.seq).toBe(record.seq);
        expect(ours.features.map((f) => [f.strand, f.segments])).toEqual(record.features.map((f) => [f.strand, f.segments]));
      }
      expect(tally['files compared']).toBe(items.length);
      expect(tally['location same']).toBe(tally['features compared']);
      for (const key of Object.keys(tally)) {
        if (['files compared', 'features compared', 'location same', 'same'].includes(key) || key.startsWith('comments same')) continue;
        expect(DOCUMENTED_DEVIATIONS, key).toHaveProperty(key);
      }
      console.info('SnapGene writer vs Biopython (live):', JSON.stringify(tally));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120000);
});
