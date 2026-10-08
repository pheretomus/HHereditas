import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as tables from './thal-tables';

/** primer3_config directory of the oracle venv (any Python version), if installed. */
function findConfigDir(): string | undefined {
  const lib = new URL('../../../../tools/oracle/.venv/lib', import.meta.url).pathname;
  if (!existsSync(lib)) return undefined;
  for (const python of readdirSync(lib)) {
    const dir = join(lib, python, 'site-packages', 'primer3', 'src', 'libprimer3', 'primer3_config');
    if (existsSync(dir)) return dir;
  }
  return undefined;
}

const configDir = findConfigDir();

function readValues(name: string): number[] {
  return readFileSync(join(configDir!, name), 'ascii')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => (line.trim().startsWith('inf') ? Infinity : Number(line)));
}

function readLoops(name: string): number[][] {
  return readFileSync(join(configDir!, name), 'ascii')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => line.trim().split(/\s+/).slice(1).map((v) => (v === 'inf' ? Infinity : Number(v))));
}

function readSpecial(name: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const line of readFileSync(join(configDir!, name), 'ascii').split('\n')) {
    if (line.trim() === '') continue;
    const [seq, value] = line.trim().split(/\s+/);
    out[seq] = Number(value);
  }
  return out;
}

describe('thal-tables', () => {
  it('have the expected shapes', () => {
    for (const t of [tables.STACK_DS, tables.STACK_DH, tables.STACKMM_DS, tables.STACKMM_DH, tables.TSTACK_DH, tables.TSTACK_TM_INF_DS, tables.TSTACK2_DH, tables.TSTACK2_DS]) {
      expect(t).toHaveLength(256);
    }
    expect(tables.DANGLE_DS).toHaveLength(128);
    expect(tables.DANGLE_DH).toHaveLength(128);
    expect(tables.LOOPS_DS).toHaveLength(30);
    expect(tables.LOOPS_DH).toHaveLength(30);
    expect(Object.keys(tables.TRILOOP_DH)).toHaveLength(16);
    expect(Object.keys(tables.TETRALOOP_DH)).toHaveLength(77);
  });

  it('contain the SantaLucia & Hicks (2004) Watson–Crick stacks', () => {
    // AA/TT: index (A,A,T,T) = ((0*4+0)*4+3)*4+3 = 15; CG/GC: ((1*4+2)*4+2)*4+1 = 105
    expect(tables.STACK_DH[15]).toBe(-7900);
    expect(tables.STACK_DS[15]).toBe(-22.2);
    expect(tables.STACK_DH[105]).toBe(-10600);
    expect(tables.STACK_DS[105]).toBe(-27.2);
    expect(tables.STACK_DS.filter(Number.isFinite)).toHaveLength(16);
  });

  it.skipIf(configDir === undefined)("match primer3's primer3_config files exactly", () => {
    const pairs: [readonly number[], string][] = [
      [tables.STACK_DS, 'stack.ds'],
      [tables.STACK_DH, 'stack.dh'],
      [tables.STACKMM_DS, 'stackmm.ds'],
      [tables.STACKMM_DH, 'stackmm.dh'],
      [tables.TSTACK_TM_INF_DS, 'tstack_tm_inf.ds'],
      [tables.TSTACK_DH, 'tstack.dh'],
      [tables.TSTACK2_DS, 'tstack2.ds'],
      [tables.TSTACK2_DH, 'tstack2.dh'],
      [tables.DANGLE_DS, 'dangle.ds'],
      [tables.DANGLE_DH, 'dangle.dh'],
    ];
    for (const [table, file] of pairs) expect([...table], file).toEqual(readValues(file));
    expect(tables.LOOPS_DS.map((r) => [...r])).toEqual(readLoops('loops.ds'));
    expect(tables.LOOPS_DH.map((r) => [...r])).toEqual(readLoops('loops.dh'));
    expect({ ...tables.TRILOOP_DS }).toEqual(readSpecial('triloop.ds'));
    expect({ ...tables.TRILOOP_DH }).toEqual(readSpecial('triloop.dh'));
    expect({ ...tables.TETRALOOP_DS }).toEqual(readSpecial('tetraloop.ds'));
    expect({ ...tables.TETRALOOP_DH }).toEqual(readSpecial('tetraloop.dh'));
  });
});
