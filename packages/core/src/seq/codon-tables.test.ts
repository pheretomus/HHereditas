import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  HAS_VENV,
  ORACLE_DIR,
  REPO_ROOT,
  VENV_PYTHON,
  loadOracle,
  parseGcPrt,
} from '../../test/oracle/seqtools/oracle';
import { GENETIC_CODES, NCBI_CODON_ORDER, getGeneticCode } from './codon-tables';

interface OracleTable {
  id: number;
  names: string[];
  forward: Record<string, string>;
  starts: string[];
  stops: string[];
}

const oracle = loadOracle<{ tables: OracleTable[] }>('tables.json');

describe('NCBI_CODON_ORDER', () => {
  it('lists the 64 codons in TCAG order', () => {
    expect(NCBI_CODON_ORDER).toHaveLength(64);
    expect(new Set(NCBI_CODON_ORDER).size).toBe(64);
    expect(NCBI_CODON_ORDER.slice(0, 5)).toEqual(['TTT', 'TTC', 'TTA', 'TTG', 'TCT']);
    expect(NCBI_CODON_ORDER[63]).toBe('GGG');
  });
});

describe('GENETIC_CODES vs Biopython (tables.json)', () => {
  it('has exactly the tables Biopython has, sorted by id', () => {
    expect(GENETIC_CODES.map((c) => c.id)).toEqual(oracle.tables.map((t) => t.id));
    expect(GENETIC_CODES.map((c) => c.id)).toEqual([
      1, 2, 3, 4, 5, 6, 9, 10, 11, 12, 13, 14, 15, 16, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33,
    ]);
  });

  for (const t of oracle.tables) {
    it(`table ${t.id} matches Biopython`, () => {
      const code = getGeneticCode(t.id);
      expect({ ...code.forwardTable }).toEqual(t.forward);
      expect([...code.startCodons]).toEqual(t.starts);
      expect([...code.stopCodons]).toEqual(t.stops);
      for (const n of t.names) expect(code.names).toContain(n);
      expect(code.names).toContain(code.name);
      // ncbieaa is consistent with the forward table
      NCBI_CODON_ORDER.forEach((codon, i) => expect(code.ncbieaa[i]).toBe(t.forward[codon] ?? '*'));
    });
  }
});

describe('GENETIC_CODES vs NCBI gc.prt 4.6 (independent primary source)', () => {
  const ncbi = parseGcPrt(readFileSync(path.join(ORACLE_DIR, 'ncbi_gc.prt'), 'ascii'));

  it('parses every NCBI table', () => {
    expect([...ncbi.keys()].sort((a, b) => a - b)).toEqual(GENETIC_CODES.map((c) => c.id));
  });

  for (const code of GENETIC_CODES) {
    it(`table ${code.id} (${code.name}) has NCBI's amino acids, starts and stops`, () => {
      const ref = ncbi.get(code.id);
      expect(ref).toBeDefined();
      if (!ref) return;
      expect(code.ncbieaa).toBe(ref.ncbieaa);
      const starts = NCBI_CODON_ORDER.filter((_, i) => ref.sncbieaa[i] === 'M');
      const stops = NCBI_CODON_ORDER.filter((_, i) => ref.sncbieaa[i] === '*' || ref.ncbieaa[i] === '*');
      expect([...code.startCodons].sort()).toEqual([...starts].sort());
      expect([...code.stopCodons].sort()).toEqual([...stops].sort());
      for (const n of ref.names) expect(code.names).toContain(n);
    });
  }
});

describe('getGeneticCode', () => {
  it('defaults to the standard code', () => {
    const std = getGeneticCode();
    expect(std.id).toBe(1);
    expect(std.name).toBe('Standard');
    expect(std.forwardTable.ATG).toBe('M');
    expect(std.forwardTable.TAA).toBeUndefined();
    expect(std.stopCodons).toEqual(['TAA', 'TAG', 'TGA']);
  });

  it('returns well-known alternative codes', () => {
    expect(getGeneticCode(2).forwardTable.TGA).toBe('W'); // vertebrate mitochondrial
    expect(getGeneticCode(2).stopCodons).toContain('AGA');
    expect(getGeneticCode(11).startCodons).toEqual(['TTG', 'CTG', 'ATT', 'ATC', 'ATA', 'ATG', 'GTG']);
    expect(getGeneticCode(11).name).toBe('Bacterial, Archaeal and Plant Plastid');
    expect(getGeneticCode(24).names).toContain('Rhabdopleuridae Mitochondrial');
  });

  it('marks context-dependent stop codons (tables 27, 28, 31) as both coding and stop', () => {
    for (const id of [27, 28, 31]) {
      const code = getGeneticCode(id);
      expect(Object.keys(code.forwardTable)).toHaveLength(64);
      for (const stop of code.stopCodons) expect(code.forwardTable[stop]).toBeDefined();
    }
    for (const code of GENETIC_CODES.filter((c) => ![27, 28, 31].includes(c.id))) {
      for (const stop of code.stopCodons) expect(code.forwardTable[stop]).toBeUndefined();
    }
  });

  it('every codon is translated or a stop, and no codon is both start and stop', () => {
    for (const code of GENETIC_CODES) {
      for (const codon of NCBI_CODON_ORDER) {
        expect(code.forwardTable[codon] !== undefined || code.stopCodons.includes(codon)).toBe(true);
      }
      for (const s of code.startCodons) expect(code.stopCodons).not.toContain(s);
    }
  });

  it('throws RangeError for unknown ids', () => {
    for (const id of [0, 7, 8, 17, 20, 34, -1, 1.5, Number.NaN]) {
      expect(() => getGeneticCode(id)).toThrow(RangeError);
    }
  });

  it('is immutable', () => {
    const code = getGeneticCode(1);
    expect(Object.isFrozen(code)).toBe(true);
    expect(Object.isFrozen(code.forwardTable)).toBe(true);
    expect(Object.isFrozen(code.startCodons)).toBe(true);
    expect(Object.isFrozen(GENETIC_CODES)).toBe(true);
    expect(() => {
      (code.forwardTable as Record<string, string>).ATG = 'X';
    }).toThrow(TypeError);
  });
});

describe.skipIf(!HAS_VENV)('codon-tables.ts is up to date (live oracle)', () => {
  it('equals the output of tools/oracle/seqtools_codons.py', () => {
    const script = path.join(REPO_ROOT, 'tools/oracle/seqtools_codons.py');
    const generated = execFileSync(VENV_PYTHON, ['-I', script, '--stdout'], { encoding: 'utf8' });
    const committed = readFileSync(path.join(import.meta.dirname, 'codon-tables.ts'), 'utf8');
    expect(committed).toBe(generated);
  });
});
