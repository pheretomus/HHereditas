import { describe, expect, it } from 'vitest';
import { LADDERS, bandMassAtLoad, getLadder } from './ladders';
import { ladderLane } from './lane';
import type { Ladder, LadderBand } from './ladders';

function ladder(id: string): Ladder {
  const l = getLadder(id);
  if (l === undefined) throw new Error(`missing ladder ${id}`);
  return l;
}

const sizes = (id: string): number[] => ladder(id).bands.map((b) => b.size);
const masses = (id: string): Array<number | undefined> => ladder(id).bands.map((b) => b.massNg);
const emphasized = (id: string): number[] => ladder(id).bands.filter((b) => b.emphasized).map((b) => b.size);

describe('ladder catalogue invariants', () => {
  it('has unique, well-formed ids and complete metadata', () => {
    const ids = LADDERS.map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const l of LADDERS) {
      expect(l.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(l.name.trim()).not.toBe('');
      expect(l.vendor.trim()).not.toBe('');
      expect(l.source).toMatch(/^https:\/\/[^\s]+$/);
      expect(l.bands.length).toBeGreaterThanOrEqual(6);
    }
  });

  it('lists bands largest first with strictly decreasing, positive integer sizes', () => {
    for (const l of LADDERS) {
      for (const b of l.bands) {
        expect(Number.isInteger(b.size), `${l.id} ${b.size}`).toBe(true);
        expect(b.size).toBeGreaterThan(0);
      }
      for (let i = 1; i < l.bands.length; i++) expect(l.bands[i].size, l.id).toBeLessThan(l.bands[i - 1].size);
    }
  });

  it('has masses for all bands or for none, with a reference load that matches their sum', () => {
    for (const l of LADDERS) {
      const withMass = l.bands.filter((b) => b.massNg !== undefined);
      expect([0, l.bands.length], l.id).toContain(withMass.length);
      if (withMass.length === 0) {
        expect(l.loadNg, l.id).toBeUndefined();
        continue;
      }
      expect(l.loadNg, l.id).toBeGreaterThan(0);
      let sum = 0;
      for (const b of withMass) {
        expect(Number.isFinite(b.massNg) && (b.massNg as number) > 0, `${l.id} ${b.size}`).toBe(true);
        sum += b.massNg as number;
      }
      // vendors' per-band masses are rounded; Enzynomics' printed values add up to 480-540 ng of a nominal 500 ng
      expect(Math.abs(sum - (l.loadNg as number)) / (l.loadNg as number), l.id).toBeLessThan(0.1);
    }
  });

  it('describes multi-fragment rows consistently', () => {
    let rows = 0;
    for (const l of LADDERS) {
      for (const b of l.bands) {
        if (b.components === undefined) continue;
        rows++;
        expect(b.components.length).toBeGreaterThanOrEqual(2);
        expect(b.components).toContain(b.size);
        expect([...b.components].sort((x, y) => y - x)).toEqual(b.components);
        expect(b.label).toBe([...b.components].sort((x, y) => x - y).join('/'));
      }
    }
    expect(rows).toBe(3); // NEB 1 kb Plus and 100 bp (500/517), Promega 1 kb (250/253)
  });

  it('is deeply frozen', () => {
    const l = LADDERS[0];
    expect(Object.isFrozen(LADDERS)).toBe(true);
    expect(Object.isFrozen(l)).toBe(true);
    expect(Object.isFrozen(l.bands)).toBe(true);
    expect(Object.isFrozen(l.bands[0])).toBe(true);
    expect(() => {
      (l.bands as Array<{ size: number }>)[0].size = 1;
    }).toThrow(TypeError);
    expect(() => (LADDERS as Ladder[]).push(l)).toThrow(TypeError);
  });
});

describe('required and regional ladders are present', () => {
  it('includes every ladder requested for the product, with catalogue numbers', () => {
    const expected: Array<[string, string, string]> = [
      ['neb-1kb', 'New England Biolabs', 'N3232S'],
      ['neb-1kb-plus', 'New England Biolabs', 'N3200S'],
      ['neb-100bp', 'New England Biolabs', 'N3231S'],
      ['neb-lambda-hindiii', 'New England Biolabs', 'N3012S'],
      ['thermo-generuler-1kb', 'Thermo Fisher Scientific', 'SM0311'],
      ['thermo-generuler-1kb-plus', 'Thermo Fisher Scientific', 'SM1331'],
      ['thermo-generuler-100bp-plus', 'Thermo Fisher Scientific', 'SM0321'],
      ['thermo-generuler-mix', 'Thermo Fisher Scientific', 'SM0331'],
      ['invitrogen-1kb-plus', 'Invitrogen (Thermo Fisher Scientific)', '10787018'],
      ['promega-1kb', 'Promega', 'G5711'],
      ['bioneer-1kb', 'Bioneer', 'D-1040'],
      ['bioneer-100bp', 'Bioneer', 'D-1030'],
      ['bioneer-100bp-plus', 'Bioneer', 'D-1035'],
      ['bioneer-25-100bp', 'Bioneer', 'D-1020'],
      ['enzynomics-1kb', 'Enzynomics', 'DM002'],
      ['enzynomics-1kb-plus', 'Enzynomics', 'DM003'],
      ['enzynomics-100bp', 'Enzynomics', 'DM001'],
      ['takara-100bp', 'Takara Bio', '3407A'],
    ];
    for (const [id, vendor, catalog] of expected) {
      expect(ladder(id).vendor, id).toBe(vendor);
      expect(ladder(id).catalog, id).toBe(catalog);
    }
    expect(LADDERS.length).toBe(expected.length);
  });

  it('getLadder returns undefined for an unknown id', () => {
    expect(getLadder('no-such-ladder')).toBeUndefined();
    expect(getLadder('')).toBeUndefined();
  });
});

describe('vendor data (transcribed values)', () => {
  it('NEB 1 kb DNA Ladder N3232', () => {
    expect(sizes('neb-1kb')).toEqual([10002, 8001, 6001, 5001, 4001, 3001, 2000, 1500, 1000, 517, 500]);
    expect(masses('neb-1kb')).toEqual([42, 42, 50, 42, 33, 125, 48, 36, 42, 21, 21]);
    expect(emphasized('neb-1kb')).toEqual([3001]);
    expect(ladder('neb-1kb').loadNg).toBe(500);
  });

  it('NEB 1 kb Plus DNA Ladder N3200', () => {
    expect(sizes('neb-1kb-plus')).toEqual([10002, 8001, 6001, 5001, 4001, 3001, 2017, 1517, 1200, 1000, 900, 800, 700,
      600, 500, 400, 300, 200, 100]);
    expect(masses('neb-1kb-plus')).toEqual([40, 40, 48, 40, 32, 120, 40, 57, 45, 122, 34, 31, 27, 23, 124, 49, 37, 32, 61]);
    expect(emphasized('neb-1kb-plus')).toEqual([3001, 1000, 500]);
    expect(ladder('neb-1kb-plus').loadNg).toBe(1000);
  });

  it('NEB 100 bp DNA Ladder N3231', () => {
    expect(sizes('neb-100bp')).toEqual([1517, 1200, 1000, 900, 800, 700, 600, 500, 400, 300, 200, 100]);
    expect(masses('neb-100bp')).toEqual([45, 35, 95, 27, 24, 21, 18, 97, 38, 29, 25, 48]);
    expect(emphasized('neb-100bp')).toEqual([1000, 500]);
  });

  it('NEB lambda DNA-HindIII digest: equimolar, sizes add up to the 48,502 bp genome', () => {
    const l = ladder('neb-lambda-hindiii');
    expect(sizes(l.id)).toEqual([23130, 9416, 6557, 4361, 2322, 2027, 564, 125]);
    expect(sizes(l.id).reduce((a, b) => a + b, 0)).toBe(48502);
    // mass of an equimolar digest is proportional to size: vendor ng = round(1000 ng * size / 48502)
    for (const b of l.bands) expect(Math.abs((b.massNg as number) - (1000 * b.size) / 48502)).toBeLessThan(0.6);
    expect(l.notes).toMatch(/60 °C/);
  });

  it('Thermo GeneRuler ladders', () => {
    expect(sizes('thermo-generuler-1kb')).toEqual([10000, 8000, 6000, 5000, 4000, 3500, 3000, 2500, 2000, 1500, 1000, 750,
      500, 250]);
    expect(masses('thermo-generuler-1kb')).toEqual([30, 30, 70, 30, 30, 30, 70, 25, 25, 25, 60, 25, 25, 25]);
    expect(emphasized('thermo-generuler-1kb')).toEqual([6000, 3000, 1000]);
    expect(sizes('thermo-generuler-1kb-plus')).toEqual([20000, 10000, 7000, 5000, 4000, 3000, 2000, 1500, 1000, 700, 500,
      400, 300, 200, 75]);
    expect(masses('thermo-generuler-1kb-plus')).toEqual([20, 20, 20, 75, 20, 20, 20, 80, 25, 25, 75, 25, 25, 25, 25]);
    expect(emphasized('thermo-generuler-1kb-plus')).toEqual([5000, 1500, 500]);
    expect(sizes('thermo-generuler-100bp-plus')).toEqual([3000, 2000, 1500, 1200, 1000, 900, 800, 700, 600, 500, 400, 300,
      200, 100]);
    expect(masses('thermo-generuler-100bp-plus')).toEqual([28, 28, 28, 28, 80, 27, 27, 27, 27, 80, 30, 30, 30, 30]);
    expect(emphasized('thermo-generuler-100bp-plus')).toEqual([1000, 500]);
    expect(sizes('thermo-generuler-mix')).toEqual([10000, 8000, 6000, 5000, 4000, 3500, 3000, 2500, 2000, 1500, 1200, 1000,
      900, 800, 700, 600, 500, 400, 300, 200, 100]);
    expect(masses('thermo-generuler-mix')).toEqual([18, 18, 18, 18, 18, 18, 60, 16, 16, 16, 16, 60, 17, 17, 17, 17, 60, 20,
      20, 20, 20]);
    expect(emphasized('thermo-generuler-mix')).toEqual([3000, 1000, 500]);
    for (const id of ['thermo-generuler-1kb', 'thermo-generuler-1kb-plus', 'thermo-generuler-100bp-plus', 'thermo-generuler-mix']) {
      expect(masses(id).reduce((a, b) => (a as number) + (b as number), 0), id).toBe(500);
    }
  });

  it('Invitrogen 1 Kb Plus (2017 formulation) and Promega 1 kb: sizes only', () => {
    expect(sizes('invitrogen-1kb-plus')).toEqual([15000, 10000, 8000, 7000, 6000, 5000, 4000, 3000, 2000, 1500, 1000, 850,
      650, 500, 400, 300, 200, 100]);
    expect(emphasized('invitrogen-1kb-plus')).toEqual([1500]);
    expect(masses('invitrogen-1kb-plus').every((m) => m === undefined)).toBe(true);
    expect(sizes('promega-1kb')).toEqual([10000, 8000, 6000, 5000, 4000, 3000, 2500, 2000, 1500, 1000, 750, 500, 250]);
    expect(ladder('promega-1kb').bands.at(-1)?.components).toEqual([253, 250]);
    expect(emphasized('promega-1kb')).toEqual([3000, 1000]);
  });

  it('Korean-market ladders (Bioneer, Enzynomics) and Takara', () => {
    // Bioneer PM-338 prints its masses per 4 µl (D-1040, D-1035, D-1020) or 5 µl (D-1030); massNg is for the
    // recommended load of 2 µl (D-1040, D-1030, D-1020) or 4 µl (D-1035), "Specifications" table.
    const printed: Array<[string, number, number[]]> = [
      ['bioneer-1kb', 4 / 2, [16, 16, 26, 20, 40, 60, 48, 54, 60, 60]],
      ['bioneer-100bp', 5 / 2, [87.5, 20, 15, 88.5, 28, 25, 31, 18.5, 88.5, 16.5, 26.5, 24, 31]],
      ['bioneer-100bp-plus', 4 / 4, [6, 6, 8, 8, 8, 8, 56.6, 13.4, 10, 40, 18, 16, 14, 12, 40, 10, 12, 12, 22]],
      ['bioneer-25-100bp', 4 / 2, [20, 40, 9, 8, 14, 6, 40, 12, 12, 10, 16, 136, 32, 41, 96, 64, 44]],
    ];
    for (const [id, tableOverLoad, vendor] of printed) {
      masses(id).forEach((m, i) => expect((m as number) * tableOverLoad, `${id} ${i}`).toBeCloseTo(vendor[i], 12));
    }
    expect(sizes('bioneer-1kb')).toEqual([10200, 8000, 5991, 5007, 4000, 2961, 2000, 1600, 1000, 500]);
    expect(masses('bioneer-1kb')).toEqual([8, 8, 13, 10, 20, 30, 24, 27, 30, 30]);
    expect(sizes('bioneer-100bp')).toEqual([2000, 1600, 1200, 1000, 900, 800, 700, 600, 500, 400, 300, 200, 100]);
    expect(masses('bioneer-100bp')).toEqual([35, 8, 6, 35.4, 11.2, 10, 12.4, 7.4, 35.4, 6.6, 10.6, 9.6, 12.4]);
    expect(sizes('bioneer-100bp-plus')).toEqual([10200, 8000, 5991, 5007, 4000, 2961, 2000, 1600, 1200, 1000, 900, 800,
      700, 600, 500, 400, 300, 200, 100]);
    expect(masses('bioneer-100bp-plus')).toEqual([6, 6, 8, 8, 8, 8, 56.6, 13.4, 10, 40, 18, 16, 14, 12, 40, 10, 12, 12, 22]);
    expect(sizes('bioneer-25-100bp')).toEqual([2000, 1000, 900, 800, 700, 600, 500, 400, 300, 200, 175, 150, 125, 100, 75,
      50, 25]);
    expect(masses('bioneer-25-100bp')).toEqual([10, 20, 4.5, 4, 7, 3, 20, 6, 6, 5, 8, 68, 16, 20.5, 48, 32, 22]);
    // Bioneer's masses add up exactly to the recommended load (volume x concentration)
    const recommended: Array<[string, number]> = [['bioneer-1kb', 2 * 100], ['bioneer-100bp', 2 * 100],
      ['bioneer-100bp-plus', 4 * 80], ['bioneer-25-100bp', 2 * 150]];
    for (const [id, loadNg] of recommended) {
      const sum = masses(id).reduce((a, b) => (a as number) + (b as number), 0) as number;
      expect(ladder(id).loadNg, id).toBe(loadNg);
      expect(sum, id).toBeCloseTo(loadNg, 9);
    }
    expect(sizes('enzynomics-1kb')).toEqual([10000, 8000, 6000, 5000, 4000, 3000, 2000, 1000, 500, 200]);
    expect(emphasized('enzynomics-1kb')).toEqual([5000, 1000]);
    expect(sizes('enzynomics-1kb-plus')).toEqual([10000, 8000, 6000, 5000, 4000, 3000, 2000, 1500, 1000, 800, 650, 500, 400,
      300, 200, 100]);
    expect(emphasized('enzynomics-1kb-plus')).toEqual([5000, 2000, 1000, 500]);
    expect(sizes('enzynomics-100bp')).toEqual([3000, 2000, 1500, 1000, 900, 800, 700, 600, 500, 400, 300, 200, 100]);
    expect(emphasized('enzynomics-100bp')).toEqual([2000, 1000, 500]);
    expect(sizes('takara-100bp')).toEqual([1500, 1000, 900, 800, 700, 600, 500, 400, 300, 200, 100]);
    expect(masses('takara-100bp')).toEqual([50, 50, 50, 50, 50, 50, 150, 50, 50, 50, 50]);
    expect(emphasized('takara-100bp')).toEqual([500]);
  });
});

describe('bandMassAtLoad', () => {
  it('scales the vendor mass linearly with the amount loaded', () => {
    const l = ladder('neb-1kb');
    const ref = l.bands.find((b) => b.size === 3001);
    if (ref === undefined) throw new Error('no 3001 bp band');
    expect(bandMassAtLoad(l, ref, 500)).toBe(125);
    expect(bandMassAtLoad(l, ref, 250)).toBe(62.5);
    expect(bandMassAtLoad(l, ref, 1000)).toBe(250);
    expect(bandMassAtLoad(l, ref, 0)).toBe(0);
  });

  it('is undefined without vendor masses and rejects invalid loads', () => {
    const inv = ladder('invitrogen-1kb-plus');
    expect(bandMassAtLoad(inv, inv.bands[0], 500)).toBeUndefined();
    const l = ladder('neb-1kb');
    expect(() => bandMassAtLoad(l, l.bands[0], -1)).toThrow(RangeError);
    expect(() => bandMassAtLoad(l, l.bands[0], Number.NaN)).toThrow(RangeError);
    expect(() => bandMassAtLoad(l, l.bands[0], Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});

// ------------------------------------------------------------------------------------------------
// Regression tests for review findings (reproductions kept as permanent tests)
// ------------------------------------------------------------------------------------------------

// Bioneer manual PM-338 (the ladders' own `source`), "Specifications": concentration 100/100/150 ng/µl and
// "Recommended Loading Volume 2 µl/5 mm lane" for D-1040 / D-1030 / D-1020; its band tables are "(ng/4 µl)",
// "(ng/5 µl)", "(ng/4 µl)". Spec: LadderBand.massNg = "ng in the vendor's recommended load".
describe('review: Bioneer massNg are the ng in the vendor-recommended load', () => {
  const recommendedNg: Array<[string, number]> = [['bioneer-1kb', 2 * 100], ['bioneer-100bp', 2 * 100], ['bioneer-25-100bp', 2 * 150]];
  for (const [id, loadNg] of recommendedNg) {
    it(id, () => {
      const l = ladder(id);
      const total = l.bands.reduce((s, b) => s + (b.massNg ?? 0), 0);
      expect(total).toBeCloseTo(loadNg, 6);
      // a UI quantifying against the 1,000 bp band of D-1040 loaded as recommended (2 µl) should read 30 ng
      if (id === 'bioneer-1kb') expect(ladderLane(l).find((b) => b.size === 1000)?.massNg).toBe(30);
    });
  }
});

describe('review: bandMassAtLoad never returns NaN', () => {
  it('NaN reference load or band mass is rejected instead of returned as NaN', () => {
    const l = ladder('neb-1kb');
    const result = (f: () => number | undefined): number | undefined | 'RangeError' => {
      try {
        return f();
      } catch (e) {
        if (e instanceof RangeError) return 'RangeError';
        throw e;
      }
    };
    expect(Number.isNaN(result(() => bandMassAtLoad({ ...l, loadNg: Number.NaN }, l.bands[0], 100)))).toBe(false);
    expect(Number.isNaN(result(() => bandMassAtLoad(l, { size: 100, massNg: Number.NaN }, 100)))).toBe(false);
  });
});

// The predecessor's version of this test asserted that `l.bands.reverse()` does NOT throw, which contradicts
// 'is deeply frozen' above (a frozen array cannot be reordered). The review's expectation is met the other
// way: the types are read-only, so the mutation is a compile error (checked by tsc through the
// expect-error directives below, which fail the typecheck when unused) and still throws at runtime.
describe('review: built-in ladders are typed read-only, as they are frozen at runtime', () => {
  it('in-place mutation of a built-in ladder is a type error (and throws TypeError at runtime)', () => {
    const l = ladder('neb-1kb');
    // @ts-expect-error -- Ladder.bands is a readonly array
    expect(() => l.bands.reverse()).toThrow(TypeError);
    // @ts-expect-error -- Ladder.bands is a readonly array
    expect(() => LADDERS[0].bands.sort((a: LadderBand, b: LadderBand) => a.size - b.size)).toThrow(TypeError);
    expect(() => {
      // @ts-expect-error -- LadderBand.size is readonly
      l.bands[0].size = 1;
    }).toThrow(TypeError);
    // copying first is the supported way
    expect([...l.bands].sort((a, b) => a.size - b.size)[0].size).toBe(500);
    expect(l.bands[0].size).toBe(10002);
  });

  it('accepts immutable (as const) custom ladders', () => {
    const MY_LADDER = {
      id: 'lab-ladder',
      name: 'Lab ladder',
      vendor: 'lab',
      source: 'https://example.org',
      bands: [{ size: 3000, massNg: 30 }, { size: 1000, massNg: 10, components: [1010, 1000] }, { size: 500, massNg: 10 }],
    } as const;
    const lane = ladderLane(MY_LADDER);
    expect(lane.map((b) => b.sizes)).toEqual([[3000], [1010, 1000], [500]]);
    expect(bandMassAtLoad(MY_LADDER, MY_LADDER.bands[0], 100)).toBeUndefined(); // no loadNg
  });
});

describe('review: bandMassAtLoad validates custom ladder data', () => {
  it('rejects a reference load that is not a finite number > 0 and an invalid band mass', () => {
    const l = ladder('neb-1kb');
    for (const loadNg of [0, -500, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => bandMassAtLoad({ ...l, loadNg }, l.bands[0], 100), String(loadNg)).toThrow(/neb-1kb.*loadNg/);
    }
    for (const massNg of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => bandMassAtLoad(l, { size: 100, massNg }, 100), String(massNg)).toThrow(/massNg/);
    }
    expect(bandMassAtLoad(l, { size: 100, massNg: 0 }, 100)).toBe(0);
    expect(bandMassAtLoad({ ...l, loadNg: 1e-300 }, { size: 100, massNg: 1e300 }, 1e10)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('review: Enzynomics notes state the sum of the printed band masses', () => {
  for (const [id, total] of [['enzynomics-1kb', 480], ['enzynomics-1kb-plus', 740], ['enzynomics-100bp', 540]] as const) {
    it(`${id}: "add up to ${total} ng"`, () => {
      const l = ladder(id);
      const sum = l.bands.reduce((s, b) => s + (b.massNg ?? 0), 0);
      expect(sum).toBe(total);
      expect(Number(/add up to (\d+) ng/.exec(l.notes ?? '')?.[1])).toBe(sum);
    });
  }
});
