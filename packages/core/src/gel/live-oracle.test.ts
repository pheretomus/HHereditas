/**
 * Live differential test: random gel conditions generated here (seeded; override with the environment
 * variable HH_GEL_LIVE_SEED) are evaluated by the independent Python implementation of the migration
 * model (tools/oracle/gel_live.py -> gel_model.py) and compared with the TypeScript results.
 * Skipped when the oracle virtual environment is absent.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { gelParameters, migrate, sizeAtPosition } from './migration';
import type { DnaForm, GelBuffer } from './migration';

const TOOLS = resolve(import.meta.dirname, '../../../../tools/oracle');
const SCRIPT = resolve(TOOLS, 'gel_live.py');
const PYTHON = [resolve(TOOLS, '.venv/bin/python'), resolve(TOOLS, '.venv/Scripts/python.exe')].find((p) => existsSync(p));
const SEED = Number(process.env.HH_GEL_LIVE_SEED ?? '20261008');

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
  size: number;
  pct: number;
  buffer: GelBuffer;
  form: DnaForm;
}
interface Result {
  position: number;
  top: number;
  midpoint: number;
  sizeBack: number | null;
}

describe.skipIf(PYTHON === undefined)('live oracle: TypeScript model vs Python reference implementation', () => {
  it(`agrees on 3000 random cases (seed ${SEED})`, () => {
    const rand = rng(SEED);
    const forms: DnaForm[] = ['linear', 'supercoiled', 'nicked'];
    const cases: Case[] = [];
    for (let i = 0; i < 3000; i++) {
      cases.push({
        size: 10 ** (0.5 + 6.5 * rand()),
        pct: 0.5 + 2.5 * rand(),
        buffer: rand() < 0.5 ? 'TAE' : 'TBE',
        form: forms[Math.floor(rand() * 3)],
      });
    }
    // edge cases: table rows, range limits, tiny and huge sizes
    for (const pct of [0.5, 0.6, 1, 1.2, 1.5, 2, 3]) {
      for (const size of [1, 75, 500, 1000, 23130, 1e6]) cases.push({ size, pct, buffer: 'TAE', form: 'linear' });
    }
    const dir = mkdtempSync(join(tmpdir(), 'hh-gel-live-'));
    try {
      const input = join(dir, 'cases.json');
      writeFileSync(input, JSON.stringify(cases));
      const out = execFileSync(PYTHON as string, [SCRIPT, input], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      const results = JSON.parse(out) as Result[];
      expect(results).toHaveLength(cases.length);
      cases.forEach((c, i) => {
        const opts = { agarosePercent: c.pct, buffer: c.buffer, form: c.form };
        const r = results[i];
        const label = JSON.stringify(c);
        expect(Math.abs(migrate(c.size, opts) - r.position), label).toBeLessThan(1e-12);
        const g = gelParameters(c.pct, c.buffer);
        expect(Math.abs(g.topPosition - r.top), label).toBeLessThan(1e-12);
        expect(Math.abs(g.midpointBp / r.midpoint - 1), label).toBeLessThan(1e-12);
        const back = sizeAtPosition(r.position, opts);
        if (r.sizeBack === null) expect(back, label).toBeUndefined();
        else if (back !== undefined) expect(Math.abs(back / r.sizeBack - 1), label).toBeLessThan(1e-9);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
