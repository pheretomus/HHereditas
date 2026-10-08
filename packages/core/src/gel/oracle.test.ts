/**
 * Differential tests against the JSON written by tools/oracle/gel_oracle.py:
 *  - an independent Python implementation of the migration model (model_reference.json),
 *  - band positions measured on 17 vendor gel photographs (vendor_gels.json),
 *  - pydna 5.5.16 ladder definitions (pydna_ladders.json),
 *  - Biopython 1.88 restriction digests: lambda cI857 ind1 Sam7 / HindIII, pUC19 (digests.json).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LADDERS, getLadder } from './ladders';
import type { Ladder } from './ladders';
import {
  BPB_POSITION,
  BPB_XC_SPEED_RATIO,
  DYE_COMIGRATION_BP,
  FORM_SIZE_FACTOR,
  SHAPE_EXPONENT,
  SMALL_DNA_POSITION,
  gelParameters,
  migrate,
} from './migration';
import type { DnaForm, GelBuffer } from './migration';

const ORACLE_DIR = resolve(import.meta.dirname, '../../test/oracle/gel');
function readOracle<T>(name: string): T {
  return JSON.parse(readFileSync(resolve(ORACLE_DIR, name), 'utf8')) as T;
}

interface ModelReference {
  constants: {
    bpbPosition: number;
    bpbXcSpeedRatio: number;
    shapeExponent: number;
    smallDnaPosition: number;
    formSizeFactor: Record<DnaForm, number>;
    dyeComigration: Record<GelBuffer, Array<[number, number, number]>>;
  };
  sizes: number[];
  percents: number[];
  params: Record<string, { a: number; span: number; lc: number; k: number; bpb: number; xc: number }>;
  positions: Record<string, Record<DnaForm, number[]>>;
}

interface VendorGel {
  id: string;
  ladder: string | null;
  pct: number;
  buffer: GelBuffer;
  buffer_stated: boolean;
  conditions: string;
  origin: number | null;
  source: string;
  bands: Array<[number, number]>;
  agreement: { mode: 'absolute' | 'affine'; rms: number; maxAbs: number; residuals: number[] };
}
interface VendorGels {
  calibration: {
    fitted: { shapeExponent: number; smallDnaPosition: number; pooledRms: number };
    used: { shapeExponent: number; smallDnaPosition: number; pooledRms: number };
  };
  gels: VendorGel[];
}

const reference = readOracle<ModelReference>('model_reference.json');
const vendor = readOracle<VendorGels>('vendor_gels.json');

function ladder(id: string): Ladder {
  const l = getLadder(id);
  if (l === undefined) throw new Error(`missing ladder ${id}`);
  return l;
}

/** Same comparison as gel_oracle.agreement(): residuals of the model against one photograph. */
function agreement(gel: VendorGel): { residuals: number[]; rms: number; maxAbs: number } {
  const p = gel.bands.map(([size]) => migrate(size, { agarosePercent: gel.pct, buffer: gel.buffer }));
  const rows = gel.bands.map(([, row]) => row);
  let residuals: number[];
  if (gel.origin !== null) {
    const origin = gel.origin;
    const obs = rows.map((r) => r - origin);
    let num = 0;
    let den = 0;
    for (let i = 0; i < p.length; i++) {
      num += p[i] * obs[i];
      den += p[i] * p[i];
    }
    const s = num / den;
    residuals = p.map((x, i) => (s * x - obs[i]) / s);
  } else {
    // least squares rows = alpha * p + beta
    const n = p.length;
    const mp = p.reduce((a, b) => a + b, 0) / n;
    const mr = rows.reduce((a, b) => a + b, 0) / n;
    let sxy = 0;
    let sxx = 0;
    for (let i = 0; i < n; i++) {
      sxy += (p[i] - mp) * (rows[i] - mr);
      sxx += (p[i] - mp) ** 2;
    }
    const alpha = sxy / sxx;
    const beta = mr - alpha * mp;
    const span = Math.max(...rows) - Math.min(...rows);
    residuals = p.map((x, i) => (alpha * x + beta - rows[i]) / span);
  }
  const rms = Math.sqrt(residuals.reduce((a, r) => a + r * r, 0) / residuals.length);
  return { residuals, rms, maxAbs: Math.max(...residuals.map(Math.abs)) };
}

describe('model vs the independent Python implementation (model_reference.json)', () => {
  it('uses the same constants and calibration tables', () => {
    const c = reference.constants;
    expect(BPB_POSITION).toBe(c.bpbPosition);
    expect(BPB_XC_SPEED_RATIO).toBe(c.bpbXcSpeedRatio);
    expect(SHAPE_EXPONENT).toBe(c.shapeExponent);
    expect(SMALL_DNA_POSITION).toBe(c.smallDnaPosition);
    expect({ ...FORM_SIZE_FACTOR }).toEqual(c.formSizeFactor);
    for (const buffer of ['TAE', 'TBE'] as GelBuffer[]) {
      expect(DYE_COMIGRATION_BP[buffer].map((row) => [...row])).toEqual(c.dyeComigration[buffer]);
    }
  });

  it('derives the same curve parameters for every gel', () => {
    const keys = Object.keys(reference.params);
    expect(keys.length).toBe(2 * reference.percents.length);
    for (const key of keys) {
      const [buffer, pct] = key.split(':');
      const g = gelParameters(Number(pct), buffer as GelBuffer);
      const r = reference.params[key];
      expect(Math.abs(g.topPosition - r.a), key).toBeLessThan(1e-12);
      expect(Math.abs(g.bottomPosition - g.topPosition - r.span), key).toBeLessThan(1e-12);
      expect(Math.abs(g.midpointBp / r.lc - 1), key).toBeLessThan(1e-12);
      expect(Math.abs(g.bromophenolBlueBp / r.bpb - 1), key).toBeLessThan(1e-12);
      expect(Math.abs(g.xyleneCyanolBp / r.xc - 1), key).toBeLessThan(1e-12);
      expect(g.exponent).toBe(r.k);
    }
  });

  it('computes the same positions for every size, gel and DNA form', () => {
    let compared = 0;
    let worst = 0;
    for (const [key, byForm] of Object.entries(reference.positions)) {
      const [buffer, pct] = key.split(':');
      for (const form of Object.keys(byForm) as DnaForm[]) {
        reference.sizes.forEach((size, i) => {
          const p = migrate(size, { agarosePercent: Number(pct), buffer: buffer as GelBuffer, form });
          worst = Math.max(worst, Math.abs(p - byForm[form][i]));
          compared++;
        });
      }
    }
    expect(compared).toBe(2 * reference.percents.length * 3 * reference.sizes.length);
    expect(worst).toBeLessThan(1e-12);
  });
});

describe('model vs vendor gel photographs (vendor_gels.json)', () => {
  it('covers 17 photographs from five vendors and three buffers/conditions', () => {
    expect(vendor.gels).toHaveLength(17);
    const vendors = new Set(vendor.gels.map((g) => g.id.split('-')[0]));
    expect([...vendors].sort()).toEqual(['bioneer', 'enzynomics', 'neb', 'promega', 'thermo']);
    expect(new Set(vendor.gels.map((g) => g.pct)).size).toBeGreaterThanOrEqual(5);
    for (const g of vendor.gels) expect(g.source).toMatch(/^https:\/\//);
  });

  it('measured band sizes are those of the ladder in the photograph', () => {
    for (const g of vendor.gels) {
      if (g.ladder === null) continue;
      const l = ladder(g.ladder);
      const known = new Set(l.bands.flatMap((b) => [b.size, ...(b.components ?? [])]));
      for (const [size] of g.bands) {
        // merged doublets are entered at their mean size (500/517 -> 508)
        if (size === 508) expect(known.has(500) && known.has(517), g.id).toBe(true);
        else expect(known.has(size), `${g.id} ${size}`).toBe(true);
      }
    }
  });

  it('reproduces the Python agreement statistics exactly', () => {
    for (const g of vendor.gels) {
      const a = agreement(g);
      expect(Math.abs(a.rms - g.agreement.rms), g.id).toBeLessThan(1e-9);
      expect(Math.abs(a.maxAbs - g.agreement.maxAbs), g.id).toBeLessThan(1e-9);
    }
  });

  it('agrees with every photograph within 5 % of the gel (RMS), pooled RMS < 2 %', () => {
    const all: number[] = [];
    for (const g of vendor.gels) {
      const a = agreement(g);
      all.push(...a.residuals);
      expect(a.rms, g.id).toBeLessThan(0.05);
      expect(a.maxAbs, g.id).toBeLessThan(0.1);
      // photographs that show the wells, stated conditions: absolute positions within 2 %
      if (g.origin !== null && g.buffer_stated) expect(a.rms, g.id).toBeLessThan(0.02);
    }
    const pooled = Math.sqrt(all.reduce((s, r) => s + r * r, 0) / all.length);
    expect(pooled).toBeLessThan(0.02);
    expect(Math.abs(pooled - vendor.calibration.used.pooledRms)).toBeLessThan(1e-9);
  });

  it('uses rounded versions of the fitted constants that fit (almost) as well as the optimum', () => {
    const { fitted, used } = vendor.calibration;
    expect(used.shapeExponent).toBe(SHAPE_EXPONENT);
    expect(used.smallDnaPosition).toBe(SMALL_DNA_POSITION);
    expect(Math.abs(fitted.shapeExponent - SHAPE_EXPONENT)).toBeLessThan(0.005);
    expect(Math.abs(fitted.smallDnaPosition - SMALL_DNA_POSITION)).toBeLessThan(0.005);
    expect(used.pooledRms).toBeLessThan(1.02 * fitted.pooledRms);
  });
});

describe('ladders vs pydna 5.5.16 (pydna_ladders.json)', () => {
  const pydna = readOracle<{
    GeneRuler_1kb_plus: Array<{ size: number; fmol: number; rf: number }>;
    GeneRuler_1kb: Array<{ size: number }>;
  }>('pydna_ladders.json');

  it('has the same GeneRuler band sizes', () => {
    expect(ladder('thermo-generuler-1kb').bands.map((b) => b.size)).toEqual(pydna.GeneRuler_1kb.map((b) => b.size));
    expect(ladder('thermo-generuler-1kb-plus').bands.map((b) => b.size)).toEqual(pydna.GeneRuler_1kb_plus.map((b) => b.size));
  });

  it('has GeneRuler 1 kb Plus masses equal to pydna fmol x size x 650 g/mol/bp (0.5 % tolerance)', () => {
    const l = ladder('thermo-generuler-1kb-plus');
    l.bands.forEach((b, i) => {
      const ng = (pydna.GeneRuler_1kb_plus[i].fmol * b.size * 650) / 1e6;
      expect(Math.abs((b.massNg as number) / ng - 1), `${b.size}`).toBeLessThan(0.005);
    });
  });

  it('matches the relative mobilities pydna measured on the GeneRuler 1 kb Plus 1 % TAE image', () => {
    // pydna Rf: 0 at the 20 kb band, 1 at the 75 bp band
    const rows = pydna.GeneRuler_1kb_plus;
    const p = rows.map((r) => migrate(r.size, { agarosePercent: 1, buffer: 'TAE' }));
    const first = p[0];
    const last = p[p.length - 1];
    const norm = p.map((x) => (x - first) / (last - first));
    const res = norm.map((x, i) => x - rows[i].rf);
    const rms = Math.sqrt(res.reduce((s, r) => s + r * r, 0) / res.length);
    expect(rms).toBeLessThan(0.035);
    expect(Math.max(...res.map(Math.abs))).toBeLessThan(0.06);
  });
});

describe('ladders vs Biopython restriction digests (digests.json)', () => {
  const digests = readOracle<{
    lambda: { length: number; fragments: number[]; referenceFragments: number[]; sites1: number[]; mutations: unknown[] };
    puc19: { length: number; digests: Record<string, number[]> };
  }>('digests.json');

  it('lambda cI857 ind1 Sam7 / HindIII gives exactly the NEB marker bands', () => {
    expect(digests.lambda.length).toBe(48502);
    expect(digests.lambda.fragments).toEqual(ladder('neb-lambda-hindiii').bands.map((b) => b.size));
    expect(digests.lambda.sites1).toHaveLength(7);
  });

  it('the 125 bp band exists only because of the ind1 mutation (6,557 + 125 = 6,682 in wild-type lambda)', () => {
    expect(digests.lambda.referenceFragments).toHaveLength(7);
    expect(digests.lambda.referenceFragments).toContain(6682);
    expect(digests.lambda.referenceFragments).not.toContain(125);
  });

  it('pUC19 digests account for the whole 2,686 bp plasmid', () => {
    for (const [name, frags] of Object.entries(digests.puc19.digests)) {
      expect(frags.reduce((a, b) => a + b, 0), name).toBe(2686);
    }
    expect(digests.puc19.digests.PvuII).toEqual([2364, 322]);
  });

  it('every ladder band size sits inside the range of the model', () => {
    for (const l of LADDERS) for (const b of l.bands) expect(Number.isFinite(migrate(b.size))).toBe(true);
  });
});

// ------------------------------------------------------------------------------------------------
// Regression tests for review findings (reproductions kept as permanent tests)
// ------------------------------------------------------------------------------------------------

describe('review: high-% TBE gels', () => {
  it('Thermo GeneRuler Low Range photo (MAN0013037: 3% agarose, 1X TBE, 8 cm gel, wells visible) meets RMS < 0.02', () => {
    // Band rows measured by the reviewer on the embedded gel image of MAN0013037 p.2 (lane-profile peaks, same method
    // as tools/oracle/gel_measure_bands.py); well at row 16.63.
    const origin = 16.63;
    const bands: Array<[number, number]> = [[700, 103.14], [500, 136.25], [400, 160.98], [300, 195.5], [200, 245.27],
      [150, 281.78], [100, 328.43], [75, 360.65], [50, 403.13], [25, 459.8]];
    const p = bands.map(([s]) => migrate(s, { agarosePercent: 3, buffer: 'TBE' }));
    const obs = bands.map(([, r]) => r - origin);
    // same 'absolute' comparison as agreement(): one free run-length scale
    const scale = p.reduce((a, x, i) => a + x * obs[i], 0) / p.reduce((a, x) => a + x * x, 0);
    const res = p.map((x, i) => (scale * x - obs[i]) / scale);
    const rms = Math.sqrt(res.reduce((a, r) => a + r * r, 0) / res.length);
    expect(res[0]).toBeLessThan(0.05); // 700 bp
    expect(rms).toBeLessThan(0.02);
  });
});
