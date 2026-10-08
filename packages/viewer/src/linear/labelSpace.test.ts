import { describe, expect, it } from 'vitest';
import { LabelSpace, RowOccupancy } from './labelSpace';

describe('RowOccupancy', () => {
  it('reports free and taken space', () => {
    const row = new RowOccupancy();
    expect(row.isFree(0, 100)).toBe(true);
    row.add(10, 20);
    expect(row.isFree(0, 9)).toBe(true);
    expect(row.isFree(21, 50)).toBe(true);
    expect(row.isFree(15, 16)).toBe(false);
    expect(row.isFree(0, 10)).toBe(false); // touching counts as taken
    expect(row.isFree(20, 30)).toBe(false);
    expect(row.isFree(5, 25)).toBe(false);
  });

  it('merges overlapping intervals', () => {
    const row = new RowOccupancy();
    row.add(0, 10);
    row.add(20, 30);
    row.add(40, 50);
    row.add(5, 25);
    expect(row.intervals()).toEqual([
      [0, 30],
      [40, 50],
    ]);
    row.add(-5, 100);
    expect(row.intervals()).toEqual([[-5, 100]]);
  });

  it('ignores empty intervals', () => {
    const row = new RowOccupancy();
    row.add(10, 5);
    row.add(Number.NaN, 3);
    expect(row.intervals()).toEqual([]);
  });

  it('agrees with a brute-force model', () => {
    let seed = 99;
    const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let trial = 0; trial < 50; trial++) {
      const row = new RowOccupancy();
      const taken: Array<[number, number]> = [];
      for (let k = 0; k < 40; k++) {
        const l = random() * 1000;
        const r = l + random() * 60;
        const ql = random() * 1000;
        const qr = ql + random() * 60;
        const brute = taken.every(([a, b]) => qr < a || ql > b);
        expect(row.isFree(ql, qr)).toBe(brute);
        row.add(l, r);
        taken.push([l, r]);
      }
    }
  });
});

describe('LabelSpace', () => {
  it('keeps one occupancy row per key', () => {
    const space = new LabelSpace();
    space.row('f:above:0').add(0, 10);
    expect(space.row('f:above:0').isFree(5, 6)).toBe(false);
    expect(space.row('f:above:1').isFree(5, 6)).toBe(true);
  });
});
