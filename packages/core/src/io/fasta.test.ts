import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MoleculeType, SeqRecord, Topology } from '../types';
import { makeRecord } from '../seq/features';
import { parseFasta, writeFasta } from './fasta';

const ROOT = join(__dirname, '../../../..');
const PYTHON = join(ROOT, 'tools/oracle/.venv/bin/python');
const ORACLE_SCRIPT = join(ROOT, 'tools/oracle/genbank_fasta_oracle.py');
const CASES = join(__dirname, '../../test/oracle/genbank/fasta_cases.json');

describe('parseFasta', () => {
  it('reads several records with names, descriptions and sequences', () => {
    const r = parseFasta('>seq1 first record\nACGT\nacgt\n>seq2\n\n>seq3   third   one  \nMKVL*\n');
    expect(r.warnings).toEqual([]);
    expect(r.records.map((x) => [x.name, x.description, x.seq, x.molecule, x.topology])).toEqual([
      ['seq1', 'first record', 'ACGTACGT', 'DNA', 'linear'],
      ['seq2', '', '', 'DNA', 'linear'],
      ['seq3', 'third   one', 'MKVL*', 'protein', 'linear'],
    ]);
    expect(r.records[0].meta).toEqual({ sourceFormat: 'fasta' });
    expect(r.records[0].features).toEqual([]);
    expect(r.records[0].id).not.toBe(r.records[1].id);
  });

  it('ignores ; comments, blank lines, digits and white space', () => {
    const r = parseFasta(';comment\n\n>s\n  1 acgtacgtac\tgtacg 15\n;inner\n\n 16 TTTT\n');
    expect(r.records[0].seq).toBe('ACGTACGTACGTACGTTTT');
    expect(r.warnings).toEqual([]);
  });

  it('accepts CRLF, CR and a BOM', () => {
    for (const text of ['>a x\r\nAC\r\nGT\r\n', '>a x\rAC\rGT\r', '﻿>a x\nAC\nGT\n']) {
      const r = parseFasta(text);
      expect(r.records.map((x) => [x.name, x.description, x.seq])).toEqual([['a', 'x', 'ACGT']]);
    }
  });

  it('keeps every record of concatenated files that each start with a BOM (review finding)', () => {
    // `cat a.fa b.fa` of BOM-prefixed files, decoded by TextDecoder (which strips only the first
    // BOM): the second header used to be read as residues, merging the records and turning the
    // DNA into a "protein" because of the header's letters.
    const bom = [0xef, 0xbb, 0xbf];
    const enc = new TextEncoder();
    const bytes = new Uint8Array([
      ...bom,
      ...enc.encode('>pUC19_fragment\nACGTACGTACGTACGTACGT\n'),
      ...bom,
      ...enc.encode('>pET28_fragment sequence\nGGGGCCCCAAAATTTT\n'),
    ]);
    const r = parseFasta(new TextDecoder().decode(bytes));
    expect(r.warnings).toEqual([]);
    expect(r.records.map((x) => [x.name, x.description, x.seq, x.molecule])).toEqual([
      ['pUC19_fragment', '', 'ACGTACGTACGTACGTACGT', 'DNA'],
      ['pET28_fragment', 'sequence', 'GGGGCCCCAAAATTTT', 'DNA'],
    ]);
    // a BOM before a comment or a sequence line is not data either
    const other = parseFasta('>a\n﻿;comment\n﻿ACGT\n');
    expect(other.warnings).toEqual([]);
    expect(other.records.map((x) => x.seq)).toEqual(['ACGT']);
  });

  it('reads a header with a very long run of blanks in linear time (review finding)', () => {
    // The topology-modifier pattern started with \s*, so every blank of a run not followed by
    // '[' rescanned the rest of the run: quadratic (2.4 s for 100 000 blanks).
    for (const blank of [' ', '\t']) {
      const run = blank.repeat(100_000);
      const t0 = performance.now();
      const r = parseFasta(`>seq1${run}note\nACGT\n>seq2 a${run}[topology=circular]${run}b\nAC\n>seq3${run}\nA\n`);
      expect(performance.now() - t0).toBeLessThan(500);
      expect(r.records.map((x) => [x.name, x.description, x.topology])).toEqual([
        ['seq1', 'note', 'linear'],
        ['seq2', `a${run}b`, 'circular'],
        ['seq3', '', 'linear'],
      ]);
    }
  });

  it('reads the NCBI [topology=...] modifier and removes it from the description', () => {
    const r = parseFasta('>p1 my plasmid [topology=circular] v2\nACGT\n>p2 [Topology = Linear]\nAC\n>p3[topology=circular]\nA\n');
    expect(r.records.map((x) => [x.name, x.description, x.topology])).toEqual([
      ['p1', 'my plasmid v2', 'circular'],
      ['p2', '', 'linear'],
      ['p3', '', 'circular'],
    ]);
  });

  it('detects protein, RNA and DNA', () => {
    const r = parseFasta('>d\nACGTN\n>r\nACGUU\n>p\nMEEKL\n>m\nACGTU\n>amb\nACDGH\n');
    expect(r.records.map((x) => [x.molecule, x.seq])).toEqual([
      ['DNA', 'ACGTN'],
      ['RNA', 'ACGUU'],
      ['protein', 'MEEKL'],
      ['DNA', 'ACGTT'],
      ['DNA', 'ACDGH'], // letters shared with IUPAC nucleotide codes: cannot be told apart
    ]);
    expect(r.warnings).toEqual([{ message: 'U converted to T in a DNA sequence', line: 7, recordIndex: 3 }]);
  });

  it('removes gaps and a nucleotide terminator, replaces invalid characters, with warnings', () => {
    const r = parseFasta('>a\nAC-GT..A\n>b\nACGT*\n>c\nACXGT\nAC#\n>d\nMKL#V\n');
    expect(r.records.map((x) => x.seq)).toEqual(['ACGTA', 'ACGT', 'ACNGTACN', 'MKLXV']);
    expect(r.warnings).toEqual([
      { message: "3 gap character(s) ('-' or '.') removed from the sequence", line: 2, recordIndex: 0 },
      { message: "final '*' terminator removed from the nucleotide sequence", line: 4, recordIndex: 1 },
      { message: 'invalid character(s) replaced by N: "X" (1), "#" (1)', line: 6, recordIndex: 2 },
      { message: 'invalid character(s) replaced by X: "#" (1)', line: 9, recordIndex: 3 },
    ]);
  });

  it('handles empty input, missing headers and empty headers', () => {
    expect(parseFasta('')).toEqual({ records: [], warnings: [{ message: "no FASTA header line ('>') found" }] });
    expect(parseFasta('ACGT\n').records).toEqual([]);
    const stray = parseFasta('ACGT\n>a\nGG\n');
    expect(stray.records.map((x) => x.seq)).toEqual(['GG']);
    expect(stray.warnings).toEqual([{ message: "1 line(s) before the first '>' header were ignored", line: 1 }]);
    const empty = parseFasta('>\nACGT\n');
    expect(empty.records[0].name).toBe('Untitled');
    expect(empty.records[0].description).toBe('');
  });
});

describe('writeFasta', () => {
  const rec = (seq: string, extra: Partial<SeqRecord> = {}) => makeRecord({ name: 'seq one', description: 'a  test\nrecord', seq, ...extra });

  it('writes headers and wraps at 70 columns by default', () => {
    const text = writeFasta(rec('A'.repeat(150)));
    expect(text).toBe(`>seq_one a  test record\n${'A'.repeat(70)}\n${'A'.repeat(70)}\n${'A'.repeat(10)}\n`);
    expect(parseFasta(text).records[0].description).toBe('a  test record');
  });

  it('accepts a list, a custom width, no wrapping and empty sequences', () => {
    const list = [rec('ACGTACGT', { name: 'x', description: '' }), rec('', { name: 'y', description: '' })];
    expect(writeFasta(list, { lineWidth: 3 })).toBe('>x\nACG\nTAC\nGT\n>y\n');
    expect(writeFasta(list, { lineWidth: 0 })).toBe('>x\nACGTACGT\n>y\n');
    expect(writeFasta(list, { lineWidth: Infinity })).toBe('>x\nACGTACGT\n>y\n');
    expect(writeFasta(list, { lineWidth: 2.7 })).toBe('>x\nAC\nGT\nAC\nGT\n>y\n');
    expect(writeFasta([])).toBe('');
  });

  it('marks circular records with [topology=circular]', () => {
    const text = writeFasta(rec('ACGT', { topology: 'circular', name: 'p', description: 'plasmid' }));
    expect(text).toBe('>p plasmid [topology=circular]\nACGT\n');
    expect(parseFasta(text).records[0].topology).toBe('circular');
  });
});

// ---------------------------------------------------------------------------
// Differential tests against Biopython 1.88 ("fasta-pearson")
// ---------------------------------------------------------------------------

interface FastaCase {
  text: string;
  records: { id: string; description: string; seq: string }[];
}

/** What our reader must return for one Biopython record (see genbank_fasta_oracle.py). */
function expectedFromBiopython(r: FastaCase['records'][number]) {
  let topology: Topology = 'linear';
  const title = r.description
    .replace(/\s*\[\s*topology\s*=\s*(circular|linear)\s*\]/gi, (_m, v: string) => {
      topology = v.toLowerCase() as Topology;
      return '';
    })
    .trim();
  const space = title.search(/\s/);
  const name = space < 0 ? title : title.slice(0, space);
  // Deliberate deviation: Biopython's fasta-pearson parser removes spaces but keeps TAB characters
  // inside sequences; white space is never a residue, so our reader removes all of it.
  const upper = r.seq.replace(/\s+/g, '').toUpperCase();
  const molecule: MoleculeType = /[EFIJLOPQZ]/.test(upper) ? 'protein' : /U/.test(upper) && !/T/.test(upper) ? 'RNA' : 'DNA';
  return {
    name: name || 'Untitled',
    description: space < 0 ? '' : title.slice(space).trim(),
    seq: molecule === 'DNA' ? upper.replaceAll('U', 'T') : upper,
    molecule,
    topology,
  };
}

const cases = (JSON.parse(readFileSync(CASES, 'utf8')) as { cases: FastaCase[] }).cases;

describe('parseFasta agrees with Biopython', () => {
  it(`on ${cases.length} seeded random FASTA texts`, () => {
    let records = 0;
    for (const c of cases) {
      const ours = parseFasta(c.text);
      expect(ours.warnings, c.text).toEqual([]);
      expect(ours.records.map((r) => ({ name: r.name, description: r.description, seq: r.seq, molecule: r.molecule, topology: r.topology }))).toEqual(
        c.records.map(expectedFromBiopython),
      );
      records += c.records.length;
    }
    expect(records).toBeGreaterThan(500);
  });

  it('round-trips every case through writeFasta', () => {
    for (const c of cases) {
      const first = parseFasta(c.text).records;
      const second = parseFasta(writeFasta(first)).records;
      const strip = (r: SeqRecord) => ({ ...r, id: '' });
      expect(second.map(strip)).toEqual(first.map(strip));
    }
  });
});

describe.skipIf(!existsSync(PYTHON))('live oracle: Biopython reads writeFasta output', () => {
  it('with the same identifiers, descriptions and sequences', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hhereditas-fasta-'));
    try {
      const paths: string[] = [];
      const written: SeqRecord[][] = [];
      cases.slice(0, 100).forEach((c, k) => {
        const records = parseFasta(c.text).records;
        const path = join(dir, `case${k}.fasta`);
        writeFileSync(path, writeFasta(records, { lineWidth: 1 + (k % 80) }));
        paths.push(path);
        written.push(records);
      });
      const out = JSON.parse(execFileSync(PYTHON, [ORACLE_SCRIPT, '--dump', ...paths], { encoding: 'utf8', maxBuffer: 64 << 20 }));
      paths.forEach((path, k) => {
        const bio = out[path] as FastaCase['records'];
        expect(bio.map(expectedFromBiopython)).toEqual(
          written[k].map((r) => ({ name: r.name, description: r.description, seq: r.seq, molecule: r.molecule, topology: r.topology })),
        );
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Property test
// ---------------------------------------------------------------------------

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

describe('property: parseFasta(writeFasta(records)) keeps every record', () => {
  it('for 500 seeded random records and line widths', () => {
    const next = rng(99);
    const pick = (s: string) => s[Math.floor(next() * s.length)];
    for (let iter = 0; iter < 500; iter++) {
      const molecule: MoleculeType = (['DNA', 'RNA', 'protein'] as const)[Math.floor(next() * 3)];
      const n = Math.floor(next() * 300);
      let seq = '';
      for (let k = 0; k < n; k++) seq += pick(molecule === 'DNA' ? 'ACGTRYSWKMBDHVN' : molecule === 'RNA' ? 'ACGU' : 'ACDEFGHIKLMNPQRSTVWY');
      if (molecule === 'protein') seq += 'L';
      const record = makeRecord({
        name: `r${iter}`,
        description: next() < 0.5 ? '' : `desc ${iter} [x]`,
        seq,
        molecule: molecule === 'RNA' && seq === '' ? 'DNA' : molecule,
        topology: next() < 0.5 ? 'circular' : 'linear',
      });
      const width = Math.floor(next() * 100);
      const back = parseFasta(writeFasta(record, { lineWidth: width }));
      expect(back.warnings).toEqual([]);
      expect({ ...back.records[0], id: '' }).toEqual({ ...record, id: '', meta: { sourceFormat: 'fasta' } });
    }
  });
});
