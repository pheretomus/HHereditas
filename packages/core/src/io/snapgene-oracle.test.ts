/**
 * Differential tests of the SnapGene reader against the oracle data written by
 * tools/oracle/snapgene_oracle.py (see that script for how each view is produced):
 *
 *  - "expected": an independent implementation of the documented HHereditas mapping (expat/minidom,
 *    html.parser, Python's UTF-8 codec). Our record must equal it exactly (ids aside).
 *  - "biopython": Biopython 1.88's reading. Sequence, topology and every feature location must agree;
 *    every qualifier value must either be identical or differ for one of the documented reasons
 *    (DOCUMENTED_DEVIATIONS), which the oracle classifies from the raw XML.
 *
 * Inputs: the 8 fixture files, 30 handmade edge cases (test/oracle/snapgene/cases/*.dna) and a
 * seeded corpus of 120 random files (base64 in random.json).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseSnapGene } from './snapgene';
import {
  DOCUMENTED_DEVIATIONS,
  FIXTURE_DIR,
  ORACLE_DIR,
  type OracleEntry,
  type Tally,
  comparableExpected,
  comparableRecord,
  compareFeatureWithBiopython,
  compareRecordWithBiopython,
  fromBase64,
  loadOracle,
  recordProblems,
} from '../../test/oracle/snapgene/testkit';

const fixtures = loadOracle<Record<string, OracleEntry>>('fixtures.json');
const cases = loadOracle<Record<string, OracleEntry>>('cases.json');
const corpus = loadOracle<OracleEntry[]>('random.json');

/** Totals over all suites, checked (and printed) at the end. */
const totals: Tally = {};

function addTally(into: Tally, from: Tally): void {
  for (const [key, n] of Object.entries(from)) into[key] = (into[key] ?? 0) + n;
}

function checkAgainstOracle(data: Uint8Array, fileName: string, entry: OracleEntry): Tally {
  const tally: Tally = {};
  const result = parseSnapGene(data, { fileName });
  if (entry.expected === null) {
    expect(result.records, `${fileName}: no record expected`).toHaveLength(0);
    expect(result.warnings.length, `${fileName}: a warning explains why`).toBeGreaterThan(0);
    return tally;
  }
  expect(result.records, fileName).toHaveLength(1);
  const record = result.records[0];
  expect(recordProblems(record), fileName).toEqual([]);
  expect(comparableRecord(record), fileName).toEqual(comparableExpected(entry.expected));

  const problems = compareRecordWithBiopython(record, entry.biopython, tally);
  entry.expected.features.forEach((expectedFeature, i) => {
    problems.push(...compareFeatureWithBiopython(record.features[i], expectedFeature, record.seq.length, tally));
  });
  expect(problems, fileName).toEqual([]);
  return tally;
}

describe('SnapGene fixtures vs oracle', () => {
  it(`reads all ${Object.keys(fixtures.files).length} fixture files exactly as the independent mapping and consistently with Biopython ${fixtures.biopython}`, () => {
    const tally: Tally = {};
    for (const [name, entry] of Object.entries(fixtures.files)) {
      const data = new Uint8Array(readFileSync(join(FIXTURE_DIR, name)));
      addTally(tally, checkAgainstOracle(data, name, entry));
    }
    expect(tally['files compared']).toBe(8);
    expect(tally['features compared']).toBe(25);
    expect(tally['location same']).toBe(25);
    addTally(totals, tally);
  });

  it('matches Biopython on every fixture qualifier except the /translation clean-up and one /label', () => {
    const tally: Tally = {};
    for (const [name, entry] of Object.entries(fixtures.files)) {
      const record = parseSnapGene(new Uint8Array(readFileSync(join(FIXTURE_DIR, name))), { fileName: name }).records[0];
      entry.expected?.features.forEach((f, i) => compareFeatureWithBiopython(record.features[i], f, record.seq.length, tally));
    }
    const categories = Object.keys(tally).filter((k) => !['features compared', 'location same', 'strand-0'].includes(k));
    expect(categories.sort()).toEqual(['label-first', 'same', 'translation']);
    expect(tally['label-first']).toBe(1); // sample-d.dna FeatureD: name "FeatureD", /label "SampleFeatureD"
    console.info('SnapGene fixtures vs Biopython:', JSON.stringify(tally));
  });
});

describe('SnapGene handmade edge cases vs oracle', () => {
  for (const [name, entry] of Object.entries(cases.files)) {
    it(`${name}.dna`, () => {
      const data = new Uint8Array(readFileSync(join(ORACLE_DIR, 'cases', `${name}.dna`)));
      addTally(totals, checkAgainstOracle(data, `${name}.dna`, entry));
    });
  }
});

describe('SnapGene random corpus vs oracle', () => {
  it(`reads ${corpus.files.length} random files (seed ${String((corpus as unknown as { seed: number }).seed)}) like the independent mapping and Biopython`, () => {
    const tally: Tally = {};
    corpus.files.forEach((entry, i) => addTally(tally, checkAgainstOracle(fromBase64(entry.data ?? ''), `random-${i}.dna`, entry)));
    expect(tally['files compared']).toBe(corpus.files.length);
    expect(tally['features compared']).toBeGreaterThan(300);
    expect(tally['location same']).toBe(tally['features compared']);
    addTally(totals, tally);
  });
});

describe('SnapGene oracle summary', () => {
  it('explains every disagreement with Biopython by a documented deviation', () => {
    const categories = Object.keys(totals).filter((k) => !['features compared', 'location same', 'files compared', 'same'].includes(k) && !k.startsWith('file rejected') && !k.startsWith('feature-not-compared') && !k.startsWith('comments same'));
    for (const category of categories) expect(DOCUMENTED_DEVIATIONS, category).toHaveProperty(category);
    const qualifierValues = ['same', ...Object.keys(DOCUMENTED_DEVIATIONS).filter((k) => k !== 'strand-0')].reduce((n, k) => n + (totals[k] ?? 0), 0);
    expect(totals.same / qualifierValues).toBeGreaterThan(0.4);
    // Printed for the module report (vitest shows it with --reporter=verbose or on failure).
    console.info('SnapGene oracle agreement:', JSON.stringify({ qualifierValues, ...totals }, null, 1));
  });
});
