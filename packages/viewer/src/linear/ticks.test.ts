import { describe, expect, it } from 'vitest';
import { estimateTextWidth } from './textMeasure';
import { formatTick, niceStep, rulerTicks } from './ticks';
import { makeScale } from './viewport';

const measure = (t: string) => estimateTextWidth(t, 10);

describe('niceStep', () => {
  it('rounds up to 1, 2 or 5 × 10^k', () => {
    expect(niceStep(0.3)).toBe(1);
    expect(niceStep(1)).toBe(1);
    expect(niceStep(1.2)).toBe(2);
    expect(niceStep(3)).toBe(5);
    expect(niceStep(7)).toBe(10);
    expect(niceStep(120)).toBe(200);
    expect(niceStep(2000)).toBe(2000);
    expect(niceStep(450_000)).toBe(500_000);
  });
});

describe('formatTick', () => {
  it('uses one unit per ruler, chosen from the step', () => {
    expect(formatTick(1500, 500)).toBe('1,500');
    expect(formatTick(2000, 1000)).toBe('2 kb');
    expect(formatTick(1_250_000, 50_000)).toBe('1,250 kb');
    expect(formatTick(1_500_000, 500_000)).toBe('1.5 Mb');
    expect(formatTick(2_000_000, 1_000_000)).toBe('2 Mb');
  });
});

describe('rulerTicks', () => {
  const cases = [
    { L: 3938, vp: { start: 0, end: 3938 }, width: 1272 },
    { L: 3938, vp: { start: 0, end: 3938 }, width: 600 },
    { L: 4_641_652, vp: { start: 0, end: 4_641_652 }, width: 1272 },
    { L: 4_641_652, vp: { start: 1_200_000, end: 1_260_000 }, width: 1272 },
    { L: 8596, vp: { start: 22.4, end: 86.9 }, width: 1272 },
  ];

  it('spaces labelled ticks so their labels never collide', () => {
    for (const c of cases) {
      const scale = makeScale(c.vp, 24, c.width);
      const t = rulerTicks(scale, c.L, { measure, labelGap: 28 });
      expect(t.major.length).toBeGreaterThan(1);
      for (let i = 1; i < t.major.length; i++) {
        const a = formatTick(t.major[i - 1], t.step);
        const b = formatTick(t.major[i], t.step);
        const dx = scale.x(t.major[i]) - scale.x(t.major[i - 1]);
        expect(dx).toBeGreaterThanOrEqual((measure(a) + measure(b)) / 2 + 28 - 1e-6);
      }
    }
  });

  it('labels multiples of the step inside the visible window and the record', () => {
    for (const c of cases) {
      const scale = makeScale(c.vp, 24, c.width);
      const t = rulerTicks(scale, c.L, { measure });
      for (const n of t.major) {
        expect(n % t.step).toBe(0);
        expect(n).toBeGreaterThanOrEqual(1);
        expect(n).toBeLessThanOrEqual(c.L);
        expect(scale.x(n - 0.5)).toBeGreaterThanOrEqual(24 - 1e-6);
        expect(scale.x(n - 0.5)).toBeLessThanOrEqual(24 + c.width + 1e-6);
      }
      for (const n of t.minor) expect(n % t.step).not.toBe(0);
    }
  });

  it('goes down to single bases at letter zoom', () => {
    const scale = makeScale({ start: 100, end: 160 }, 0, 1200); // 20 px per base
    const t = rulerTicks(scale, 1000, { measure });
    expect(t.step).toBeLessThanOrEqual(10);
    expect(t.minorStep).toBe(1);
  });

  it('returns nothing for an empty record', () => {
    expect(rulerTicks(makeScale({ start: 0, end: 1 }, 0, 100), 0, { measure }).major).toEqual([]);
  });
});
