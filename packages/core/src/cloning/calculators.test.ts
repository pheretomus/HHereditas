import { describe, expect, it } from 'vitest';
import { assemblyAmounts, dnaNg, dnaPmol, insertAmountForRatio } from './calculators';

describe('DNA amount calculators', () => {
  it('reproduces the NEBuilder protocol examples (650 Da/bp)', () => {
    // NEB E2621 protocol: 50 ng of 5000 bp dsDNA ≈ 0.015 pmol; 50 ng of 500 bp ≈ 0.15 pmol
    expect(dnaPmol(50, 5000)).toBeCloseTo(0.01538, 5);
    expect(dnaPmol(50, 500)).toBeCloseTo(0.1538, 4);
    expect(dnaNg(dnaPmol(123, 2686), 2686)).toBeCloseTo(123, 10);
    // 1 µg of a 1 kb fragment = 1.54 pmol (1e6 / 650000)
    expect(dnaPmol(1000, 1000)).toBeCloseTo(1.5385, 4);
    // ssDNA: 330 Da/nt -> 1 µg of a 20-mer = 151.5 pmol
    expect(dnaPmol(1000, 20, false)).toBeCloseTo(151.5, 1);
  });

  it('insert mass for a molar ratio (NEB ligation calculator example)', () => {
    // 50 ng of a 3 kb vector with a 1 kb insert at 3:1 -> 50 ng insert
    expect(insertAmountForRatio({ vectorNg: 50, vectorLengthBp: 3000, insertLengthBp: 1000, molarRatio: 3 })).toBeCloseTo(50, 10);
    expect(insertAmountForRatio({ vectorNg: 100, vectorLengthBp: 4000, insertLengthBp: 500, molarRatio: 1 })).toBeCloseTo(12.5, 10);
  });

  it('rejects invalid inputs with RangeError', () => {
    expect(() => dnaPmol(-1, 100)).toThrow(RangeError);
    expect(() => dnaPmol(10, 0)).toThrow(RangeError);
    expect(() => dnaNg(1, NaN)).toThrow(RangeError);
    expect(() => insertAmountForRatio({ vectorNg: 50, vectorLengthBp: 3000, insertLengthBp: 1000, molarRatio: 0 })).toThrow(RangeError);
  });

  it('plans a 2-insert NEBuilder assembly at 1:2 within 0.03-0.2 pmol', () => {
    const plan = assemblyAmounts({
      vector: { name: 'pUC19', lengthBp: 2686, concentrationNgPerUl: 50 },
      inserts: [{ lengthBp: 1000, concentrationNgPerUl: 20 }, { lengthBp: 150 }],
      vectorNg: 30,
    });
    expect(plan.rows[0].ng).toBeCloseTo(30, 10);
    expect(plan.rows[0].volumeUl).toBeCloseTo(0.6, 10);
    expect(plan.rows[1].ratio).toBe(2);
    expect(plan.rows[2].ratio).toBe(5); // < 200 bp
    expect(plan.rows[1].pmol).toBeCloseTo(2 * dnaPmol(30, 2686), 12);
    expect(plan.recommendedTotalPmol).toEqual({ min: 0.03, max: 0.2 });
    expect(plan.totalPmol).toBeCloseTo(8 * dnaPmol(30, 2686), 12);
    expect(plan.warnings).toEqual([]);
  });

  it('plans 4+ fragments equimolar at 0.05 pmol each and warns outside the range', () => {
    const plan = assemblyAmounts({ vector: { lengthBp: 5000 }, inserts: [{ lengthBp: 800 }, { lengthBp: 900 }, { lengthBp: 1000 }] });
    for (const r of plan.rows) expect(r.pmol).toBeCloseTo(0.05, 12);
    expect(plan.totalPmol).toBeCloseTo(0.2, 12);
    expect(plan.warnings).toEqual([]);
    const tooMuch = assemblyAmounts({ vector: { lengthBp: 3000, concentrationNgPerUl: 5 }, inserts: [{ lengthBp: 1000 }], vectorNg: 500 });
    expect(tooMuch.warnings.join(' ')).toMatch(/outside the recommended/);
    expect(tooMuch.warnings.join(' ')).toMatch(/exceeds 10 µl/);
  });
});
