import { describe, expect, it } from 'vitest';
import {
  AGAROSE_PERCENT_RANGE,
  BPB_POSITION,
  BPB_XC_SPEED_RATIO,
  DYE_COMIGRATION_BP,
  DYE_FRONT_POSITIONS,
  FORM_SIZE_FACTOR,
  RESOLVING_WINDOW_BP,
  SMALL_DNA_POSITION,
  SHAPE_EXPONENT,
  TBE_HIGH_SHAPE_EXPONENT,
  TBE_HIGH_SMALL_DNA_POSITION,
  TBE_SHAPE_RAMP_PERCENT,
  formSizeFactor,
  gelParameters,
  migrate,
  positionOnGel,
  resolvingWindow,
  sizeAtPosition,
} from './migration';
import type { DnaForm, GelBuffer } from './migration';

const BUFFERS: GelBuffer[] = ['TAE', 'TBE'];
const FORMS: DnaForm[] = ['linear', 'supercoiled', 'nicked'];
/** 0.5, 0.55, ..., 3.0 */
const PERCENTS = Array.from({ length: 51 }, (_, i) => Math.round((0.5 + 0.05 * i) * 100) / 100);
/** 1 bp .. 10 Mb, 20 points per decade */
const SIZES = Array.from({ length: 141 }, (_, i) => 10 ** (i / 20));

/** Seeded PRNG (mulberry32) for property tests. */
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

/** Slope of position vs log10(size) (negative), by central difference. */
function slope(size: number, pct: number, buffer: GelBuffer = 'TAE'): number {
  const h = 1e-4;
  const f = (s: number) => migrate(s, { agarosePercent: pct, buffer });
  return (f(size * 10 ** h) - f(size * 10 ** -h)) / (2 * h);
}

describe('migrate: basic behaviour', () => {
  it('defaults to linear DNA on a 1 % TAE gel', () => {
    const p = migrate(1000);
    expect(p).toBe(migrate(1000, { agarosePercent: 1, buffer: 'TAE', form: 'linear' }));
    expect(p).toBeGreaterThan(0.4);
    expect(p).toBeLessThan(0.7);
  });

  it('is strictly decreasing with size for linear DNA, for every gel', () => {
    for (const buffer of BUFFERS) {
      for (const agarosePercent of PERCENTS) {
        let previous = Number.POSITIVE_INFINITY;
        for (const s of SIZES) {
          const p = migrate(s, { agarosePercent, buffer });
          expect(p, `${buffer} ${agarosePercent}% ${s} bp`).toBeLessThan(previous);
          previous = p;
        }
      }
    }
  });

  it('stays strictly inside (top, bottom) ⊂ (0, 1), approaching the asymptotes at the extremes', () => {
    for (const buffer of BUFFERS) {
      for (const agarosePercent of PERCENTS) {
        const g = gelParameters(agarosePercent, buffer);
        expect(g.topPosition).toBeGreaterThan(0);
        // the bottom asymptote: SMALL_DNA_POSITION, or for TBE above 1 % its ramp (see 'TBE curve shape')
        if (buffer === 'TAE' || agarosePercent <= TBE_SHAPE_RAMP_PERCENT.from) expect(g.bottomPosition).toBe(SMALL_DNA_POSITION);
        expect(g.bottomPosition).toBeGreaterThanOrEqual(TBE_HIGH_SMALL_DNA_POSITION);
        expect(g.bottomPosition).toBeLessThanOrEqual(SMALL_DNA_POSITION);
        expect(g.bottomPosition).toBeLessThan(1);
        for (const s of SIZES) {
          const p = migrate(s, { agarosePercent, buffer });
          expect(p).toBeGreaterThan(g.topPosition);
          expect(p).toBeLessThan(g.bottomPosition);
        }
        expect(migrate(1e9, { agarosePercent, buffer }) - g.topPosition).toBeLessThan(1e-3);
        expect(g.bottomPosition - migrate(1, { agarosePercent, buffer })).toBeLessThan(0.01);
      }
    }
  });

  it('accepts non-integer sizes and extreme but valid sizes', () => {
    expect(migrate(1500.5)).toBeLessThan(migrate(1500));
    expect(Number.isFinite(migrate(1e-6))).toBe(true);
    expect(Number.isFinite(migrate(1e12))).toBe(true);
  });

  it('puts the dye-calibration sizes exactly at the dye fronts for every row of the table', () => {
    expect(DYE_FRONT_POSITIONS.bromophenolBlue).toBe(BPB_POSITION);
    expect(DYE_FRONT_POSITIONS.xyleneCyanolFF).toBeCloseTo(BPB_POSITION / BPB_XC_SPEED_RATIO, 15);
    for (const buffer of BUFFERS) {
      for (const [agarosePercent, bpb, xc] of DYE_COMIGRATION_BP[buffer]) {
        expect(migrate(bpb, { agarosePercent, buffer })).toBeCloseTo(DYE_FRONT_POSITIONS.bromophenolBlue, 12);
        expect(migrate(xc, { agarosePercent, buffer })).toBeCloseTo(DYE_FRONT_POSITIONS.xyleneCyanolFF, 12);
        const g = gelParameters(agarosePercent, buffer);
        expect(g.bromophenolBlueBp).toBeCloseTo(bpb, 9);
        expect(g.xyleneCyanolBp).toBeCloseTo(xc, 9);
      }
    }
  });

  it('places the curve midpoint halfway between top and bottom', () => {
    for (const buffer of BUFFERS) {
      for (const agarosePercent of [0.5, 0.8, 1, 1.3, 2, 3]) {
        const g = gelParameters(agarosePercent, buffer);
        expect(positionOnGel(g, g.midpointBp)).toBeCloseTo((g.topPosition + g.bottomPosition) / 2, 14);
        expect(migrate(g.midpointBp, { agarosePercent, buffer })).toBeCloseTo((g.topPosition + g.bottomPosition) / 2, 14);
      }
    }
  });

  it('moves every fragment towards the well as the agarose percentage increases', () => {
    for (const buffer of BUFFERS) {
      for (const s of [20, 100, 300, 1000, 3000, 10000, 50000]) {
        let previous = Number.POSITIVE_INFINITY;
        for (const agarosePercent of PERCENTS) {
          const p = migrate(s, { agarosePercent, buffer });
          expect(p, `${buffer} ${s} bp ${agarosePercent}%`).toBeLessThanOrEqual(previous);
          previous = p;
        }
      }
    }
  });

  it('is continuous in the agarose percentage across the table rows', () => {
    for (const buffer of BUFFERS) {
      for (const [pct] of DYE_COMIGRATION_BP[buffer].slice(1, -1)) {
        for (const s of [100, 1000, 10000]) {
          const below = migrate(s, { agarosePercent: pct - 1e-9, buffer });
          const at = migrate(s, { agarosePercent: pct, buffer });
          const above = migrate(s, { agarosePercent: pct + 1e-9, buffer });
          expect(Math.abs(below - at)).toBeLessThan(1e-7);
          expect(Math.abs(above - at)).toBeLessThan(1e-7);
        }
      }
    }
  });

  it('separates small fragments better in TBE than in TAE at the same agarose %', () => {
    for (const agarosePercent of [0.7, 1, 1.5, 2]) {
      const tae = gelParameters(agarosePercent, 'TAE');
      const tbe = gelParameters(agarosePercent, 'TBE');
      expect(tbe.midpointBp).toBeLessThan(tae.midpointBp);
      expect(tbe.bromophenolBlueBp).toBeLessThan(tae.bromophenolBlueBp);
    }
  });

  it('reproduces familiar landmarks of a standard 1 % TAE run', () => {
    // GeneRuler 1 kb Plus on 1% TAE (Thermo datasheet image): 20 kb ~0.24, 1 kb ~0.59, 75 bp ~0.86 of the gel
    expect(migrate(20000)).toBeGreaterThan(0.18);
    expect(migrate(20000)).toBeLessThan(0.3);
    expect(migrate(1000)).toBeGreaterThan(0.5);
    expect(migrate(1000)).toBeLessThan(0.65);
    expect(migrate(75)).toBeGreaterThan(0.82);
    expect(migrate(75)).toBeLessThan(0.9);
  });
});

describe('resolving window per agarose percentage (NEB / Green & Sambrook guideline)', () => {
  it('returns the published rows exactly and interpolates monotonically between them', () => {
    expect(resolvingWindow(0.7)).toEqual({ minBp: 800, maxBp: 12000 });
    expect(resolvingWindow(1)).toEqual({ minBp: 500, maxBp: 10000 });
    expect(resolvingWindow()).toEqual({ minBp: 500, maxBp: 10000 });
    expect(resolvingWindow(1.5)).toEqual({ minBp: 200, maxBp: 3000 });
    expect(resolvingWindow(2)).toEqual({ minBp: 100, maxBp: 2000 });
    for (const [pct, lo, hi] of RESOLVING_WINDOW_BP) {
      const w = resolvingWindow(pct);
      expect(w.minBp).toBeCloseTo(lo, 6);
      expect(w.maxBp).toBeCloseTo(hi, 6);
    }
    let prev = resolvingWindow(0.5);
    for (const pct of PERCENTS.slice(1)) {
      const w = resolvingWindow(pct);
      expect(w.minBp).toBeLessThanOrEqual(prev.minBp);
      expect(w.maxBp).toBeLessThanOrEqual(prev.maxBp);
      expect(w.maxBp / w.minBp).toBeGreaterThan(10);
      prev = w;
    }
  });

  it('maps every guideline window onto the steep, nearly semi-log central part of a TAE lane', () => {
    for (const [agarosePercent, minBp, maxBp] of RESOLVING_WINDOW_BP) {
      const g = gelParameters(agarosePercent, 'TAE');
      const top = migrate(maxBp, { agarosePercent });
      const bottom = migrate(minBp, { agarosePercent });
      const label = `${agarosePercent}%`;
      expect(top, label).toBeGreaterThan(0.15);
      expect(top, label).toBeLessThan(0.35);
      expect(bottom, label).toBeGreaterThan(0.7);
      expect(bottom, label).toBeLessThan(0.88);
      expect(bottom - top, label).toBeGreaterThan(0.4);
      // steepness inside the window: never below 20 % of the steepest point of the curve
      const steepest = Math.abs(slope(g.midpointBp, agarosePercent));
      const grid = Array.from({ length: 41 }, (_, i) => minBp * (maxBp / minBp) ** (i / 40));
      for (const s of grid) expect(Math.abs(slope(s, agarosePercent)) / steepest, `${label} ${s}`).toBeGreaterThan(0.2);
      // semi-log: position is close to linear in log10(size) across the window
      const xs = grid.map(Math.log10);
      const ys = grid.map((s) => migrate(s, { agarosePercent }));
      const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
      const my = ys.reduce((a, b) => a + b, 0) / ys.length;
      let sxy = 0;
      let sxx = 0;
      let syy = 0;
      for (let i = 0; i < xs.length; i++) {
        sxy += (xs[i] - mx) * (ys[i] - my);
        sxx += (xs[i] - mx) ** 2;
        syy += (ys[i] - my) ** 2;
      }
      expect((sxy * sxy) / (sxx * syy), label).toBeGreaterThan(0.97);
    }
  });

  it('compresses fragments above the window near the top and below it near the bottom', () => {
    for (const [agarosePercent, minBp, maxBp] of RESOLVING_WINDOW_BP) {
      const g = gelParameters(agarosePercent, 'TAE');
      const steepest = Math.abs(slope(g.midpointBp, agarosePercent));
      const label = `${agarosePercent}%`;
      // 4x beyond the window: within 0.05 of the asymptote and at most a quarter of the peak slope
      expect(migrate(4 * maxBp, { agarosePercent }) - g.topPosition, label).toBeLessThan(0.05);
      expect(g.bottomPosition - migrate(minBp / 4, { agarosePercent }), label).toBeLessThan(0.05);
      expect(Math.abs(slope(4 * maxBp, agarosePercent)) / steepest, label).toBeLessThan(0.25);
      expect(Math.abs(slope(minBp / 4, agarosePercent)) / steepest, label).toBeLessThan(0.25);
      // 10x beyond: practically on top of each other
      expect(migrate(10 * maxBp, { agarosePercent }) - migrate(100 * maxBp, { agarosePercent }), label).toBeLessThan(0.02);
      expect(migrate(minBp / 100, { agarosePercent }) - migrate(minBp / 10, { agarosePercent }), label).toBeLessThan(0.02);
    }
  });

  it('shifts the window: 1 kb runs in the middle of 1 % but high on a 2 % gel and low on a 0.7 % gel', () => {
    expect(migrate(1000, { agarosePercent: 0.7 })).toBeGreaterThan(migrate(1000, { agarosePercent: 1 }));
    expect(migrate(1000, { agarosePercent: 2 })).toBeLessThan(0.45);
    // 100 and 200 bp are well apart on 2 % but crowded at the bottom of 0.7 %
    const d2 = migrate(100, { agarosePercent: 2 }) - migrate(200, { agarosePercent: 2 });
    const d07 = migrate(100, { agarosePercent: 0.7 }) - migrate(200, { agarosePercent: 0.7 });
    expect(d2).toBeGreaterThan(2 * d07);
    // 10 and 20 kb are better separated on 0.5 % than on 2 %
    const l05 = migrate(10000, { agarosePercent: 0.5 }) - migrate(20000, { agarosePercent: 0.5 });
    const l2 = migrate(10000, { agarosePercent: 2 }) - migrate(20000, { agarosePercent: 2 });
    expect(l05).toBeGreaterThan(2 * l2);
  });
});

describe('DNA forms', () => {
  it('runs supercoiled DNA faster and nicked (open circular) DNA slower than linear DNA of the same size', () => {
    for (const buffer of BUFFERS) {
      for (const agarosePercent of [0.5, 0.8, 1, 1.5, 2, 3]) {
        for (const s of [1000, 2686, 4361, 10000]) {
          const opts = { agarosePercent, buffer };
          const lin = migrate(s, opts);
          const sc = migrate(s, { ...opts, form: 'supercoiled' });
          const oc = migrate(s, { ...opts, form: 'nicked' });
          expect(sc).toBeGreaterThan(lin);
          expect(oc).toBeLessThan(lin);
        }
      }
    }
  });

  it('places a circular form where linear DNA of FORM_SIZE_FACTOR x size runs', () => {
    expect(FORM_SIZE_FACTOR.linear).toBe(1);
    for (const form of FORMS) {
      for (const s of [500, 3000, 9000]) {
        expect(migrate(s, { form, agarosePercent: 0.8 })).toBe(migrate(s * FORM_SIZE_FACTOR[form], { agarosePercent: 0.8 }));
      }
    }
  });
});

describe('sizeAtPosition (inverse)', () => {
  it('inverts migrate for every form, gel and size (seeded random)', () => {
    const rand = rng(20261008);
    for (let i = 0; i < 2000; i++) {
      const size = 10 ** (1 + 4.5 * rand());
      const agarosePercent = 0.5 + 2.5 * rand();
      const buffer = BUFFERS[Math.floor(rand() * 2)];
      const form = FORMS[Math.floor(rand() * 3)];
      const opts = { agarosePercent, buffer, form };
      const back = sizeAtPosition(migrate(size, opts), opts);
      expect(back).toBeDefined();
      expect(Math.abs((back as number) / size - 1)).toBeLessThan(1e-6);
    }
  });

  it('is undefined at and beyond the asymptotes, and rejects non-finite positions', () => {
    const g = gelParameters(1, 'TAE');
    expect(sizeAtPosition(g.topPosition)).toBeUndefined();
    expect(sizeAtPosition(g.bottomPosition)).toBeUndefined();
    expect(sizeAtPosition(0)).toBeUndefined();
    expect(sizeAtPosition(1)).toBeUndefined();
    expect(sizeAtPosition(-0.5)).toBeUndefined();
    expect(sizeAtPosition((g.topPosition + g.bottomPosition) / 2)).toBeCloseTo(g.midpointBp, 6);
    expect(() => sizeAtPosition(Number.NaN)).toThrow(RangeError);
    expect(() => sizeAtPosition(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});

describe('input validation', () => {
  it('rejects non-positive and non-finite sizes', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() => migrate(bad)).toThrow(RangeError);
    }
  });

  it('rejects agarose percentages outside the calibrated range, and unknown buffers or forms', () => {
    expect(AGAROSE_PERCENT_RANGE).toEqual({ min: 0.5, max: 3 });
    expect(() => migrate(1000, { agarosePercent: 0.49 })).toThrow(RangeError);
    expect(() => migrate(1000, { agarosePercent: 3.01 })).toThrow(RangeError);
    expect(() => migrate(1000, { agarosePercent: Number.NaN })).toThrow(RangeError);
    expect(() => migrate(1000, { agarosePercent: 0 })).toThrow(RangeError);
    expect(() => resolvingWindow(5)).toThrow(RangeError);
    expect(() => gelParameters(1, 'MOPS' as GelBuffer)).toThrow(RangeError);
    expect(() => gelParameters(1, 'constructor' as GelBuffer)).toThrow(RangeError);
    expect(() => migrate(1000, { form: 'relaxed' as DnaForm })).toThrow(RangeError);
    // inherited object keys must not be mistaken for forms (would silently give NaN)
    expect(() => migrate(1000, { form: 'toString' as DnaForm })).toThrow(RangeError);
    expect(() => formSizeFactor('__proto__' as DnaForm)).toThrow(RangeError);
    expect(() => sizeAtPosition(0.5, { form: 'valueOf' as DnaForm })).toThrow(RangeError);
    expect(formSizeFactor('supercoiled')).toBe(0.7);
    // both ends of the range are accepted
    expect(Number.isFinite(migrate(1000, { agarosePercent: 0.5 }))).toBe(true);
    expect(Number.isFinite(migrate(1000, { agarosePercent: 3 }))).toBe(true);
  });

  it('does not modify the options object', () => {
    const opts = Object.freeze({ agarosePercent: 1.2, buffer: 'TBE' as GelBuffer, form: 'nicked' as DnaForm });
    expect(() => migrate(1234, opts)).not.toThrow();
    expect(opts).toEqual({ agarosePercent: 1.2, buffer: 'TBE', form: 'nicked' });
  });
});

describe('property tests (seeded random)', () => {
  it('orders any two linear fragments by size and keeps every position in (0, 1)', () => {
    const rand = rng(7);
    for (let i = 0; i < 5000; i++) {
      const a = 10 ** (6 * rand());
      const b = 10 ** (6 * rand());
      const agarosePercent = 0.5 + 2.5 * rand();
      const buffer = BUFFERS[Math.floor(rand() * 2)];
      const pa = migrate(a, { agarosePercent, buffer });
      const pb = migrate(b, { agarosePercent, buffer });
      expect(pa > 0 && pa < 1 && pb > 0 && pb < 1).toBe(true);
      if (a < b) expect(pa).toBeGreaterThan(pb);
      else if (a > b) expect(pa).toBeLessThan(pb);
      else expect(pa).toBe(pb);
    }
  });
});

describe('review: calibration tables are deeply frozen (F16)', () => {
  it('every row is frozen: a stray write throws and cannot change the model', () => {
    expect(Object.isFrozen(DYE_COMIGRATION_BP)).toBe(true);
    for (const buffer of BUFFERS) {
      expect(Object.isFrozen(DYE_COMIGRATION_BP[buffer])).toBe(true);
      for (const row of DYE_COMIGRATION_BP[buffer]) expect(Object.isFrozen(row), `${buffer} ${row[0]}`).toBe(true);
    }
    expect(Object.isFrozen(RESOLVING_WINDOW_BP)).toBe(true);
    for (const row of RESOLVING_WINDOW_BP) expect(Object.isFrozen(row), `${row[0]}`).toBe(true);

    const before = migrate(1000);
    const windowBefore = resolvingWindow(1);
    const dyeRow = DYE_COMIGRATION_BP.TAE[5] as unknown as number[]; // [1.0, 370, 4160]
    const windowRow = RESOLVING_WINDOW_BP[2] as unknown as number[]; // [1.0, 500, 10000]
    try {
      expect(() => {
        dyeRow[1] = 3700;
      }).toThrow(TypeError);
      expect(() => {
        windowRow[1] = 5;
      }).toThrow(TypeError);
      expect(migrate(1000)).toBe(before);
      expect(resolvingWindow(1)).toEqual(windowBefore);
    } finally {
      // keep later tests meaningful should the rows ever become writable again
      if (!Object.isFrozen(dyeRow)) dyeRow[1] = 370;
      if (!Object.isFrozen(windowRow)) windowRow[1] = 500;
    }
  });
});

describe('TBE curve shape (review findings F8/F18)', () => {
  it('is the shared shape up to 1 %, the high-% TBE shape from 2 %, linear in between; TAE is unaffected', () => {
    expect(TBE_SHAPE_RAMP_PERCENT).toEqual({ from: 1, to: 2 });
    for (const agarosePercent of PERCENTS) {
      const tae = gelParameters(agarosePercent, 'TAE');
      expect(tae.exponent).toBe(SHAPE_EXPONENT);
      expect(tae.bottomPosition).toBe(SMALL_DNA_POSITION);
      const tbe = gelParameters(agarosePercent, 'TBE');
      const t = Math.min(1, Math.max(0, (agarosePercent - 1) / (2 - 1)));
      expect(tbe.exponent, `${agarosePercent}%`).toBeCloseTo(SHAPE_EXPONENT + t * (TBE_HIGH_SHAPE_EXPONENT - SHAPE_EXPONENT), 14);
      expect(tbe.bottomPosition, `${agarosePercent}%`).toBeCloseTo(SMALL_DNA_POSITION + t * (TBE_HIGH_SMALL_DNA_POSITION - SMALL_DNA_POSITION), 14);
    }
    // the ends are exact
    expect(gelParameters(1, 'TBE').exponent).toBe(SHAPE_EXPONENT);
    expect(gelParameters(2, 'TBE').exponent).toBe(TBE_HIGH_SHAPE_EXPONENT);
    expect(gelParameters(3, 'TBE').bottomPosition).toBe(TBE_HIGH_SMALL_DNA_POSITION);
  });

  it('places large fragments of high-% TBE gels lower than before (3 % TBE, 700 bp; was 0.240, photo ~0.16)', () => {
    // standard run (bromophenol blue at 0.775): the GeneRuler Low Range photograph puts 700 bp at ~0.16
    expect(migrate(700, { agarosePercent: 3, buffer: 'TBE' })).toBeLessThan(0.2);
    // ... while long DNA still compresses below the well, never above it
    const g = gelParameters(3, 'TBE');
    expect(g.topPosition).toBeGreaterThan(0.005);
    expect(migrate(1e6, { agarosePercent: 3, buffer: 'TBE' })).toBeGreaterThan(0);
  });
});
