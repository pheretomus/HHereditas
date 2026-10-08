import { describe, expect, it } from 'vitest';
import {
  MAX_PX_PER_BASE,
  clampViewport,
  fullViewport,
  interpolateViewport,
  isFullViewport,
  makeScale,
  minViewportSpan,
  panViewport,
  sameViewport,
  viewportForRange,
  zoomViewport,
} from './viewport';

const W = 1000;

describe('makeScale', () => {
  it('maps bp to px and back', () => {
    const s = makeScale({ start: 100, end: 300 }, 24, 400);
    expect(s.pxPerBp).toBe(2);
    expect(s.x(100)).toBe(24);
    expect(s.x(300)).toBe(424);
    expect(s.bp(224)).toBe(200);
    for (const bp of [0, 37.5, 150, 1000]) expect(s.bp(s.x(bp))).toBeCloseTo(bp, 9);
  });

  it('handles fractional windows (smooth zoom)', () => {
    const s = makeScale({ start: 10.25, end: 20.25 }, 0, 100);
    expect(s.pxPerBp).toBe(10);
    expect(s.x(10.25)).toBe(0);
    expect(s.x(11)).toBeCloseTo(7.5, 9);
  });
});

describe('zoomViewport', () => {
  const L = 10_000;

  it('keeps the base under the pointer in place', () => {
    const vp = { start: 2000, end: 6000 };
    const anchorX = 250;
    const anchorBp = makeScale(vp, 0, W).bp(anchorX);
    const z = zoomViewport(vp, 4, anchorBp, L, W);
    expect(z.end - z.start).toBeCloseTo(1000, 6);
    expect(makeScale(z, 0, W).x(anchorBp)).toBeCloseTo(anchorX, 6);
  });

  it('zooming in then out by the same factor round-trips', () => {
    const vp = { start: 1234, end: 5678 };
    const a = 3000;
    const back = zoomViewport(zoomViewport(vp, 3, a, L, W), 1 / 3, a, L, W);
    expect(back.start).toBeCloseTo(vp.start, 6);
    expect(back.end).toBeCloseTo(vp.end, 6);
  });

  it('never zooms out beyond the whole record', () => {
    const z = zoomViewport({ start: 4000, end: 5000 }, 0.001, 4500, L, W);
    expect(z).toEqual({ start: 0, end: L });
  });

  it('stops at the deepest zoom (MAX_PX_PER_BASE)', () => {
    const z = zoomViewport({ start: 4000, end: 5000 }, 1e6, 4500, L, W);
    expect(z.end - z.start).toBeCloseTo(W / MAX_PX_PER_BASE, 6);
    expect(makeScale(z, 0, W).pxPerBp).toBeCloseTo(MAX_PX_PER_BASE, 6);
  });

  it('stays inside the record when zooming near an end', () => {
    const z = zoomViewport({ start: 0, end: 10_000 }, 2, 100, L, W);
    expect(z.start).toBeGreaterThanOrEqual(0);
    expect(z.end).toBeLessThanOrEqual(L);
    expect(z.end - z.start).toBeCloseTo(5000, 6);
  });

  it('ignores invalid factors', () => {
    expect(zoomViewport({ start: 10, end: 20 }, Number.NaN, 15, 100, 1000)).toEqual(clampViewport({ start: 10, end: 20 }, 100, 1000));
  });
});

describe('panViewport', () => {
  it('moves the window and stops at the ends', () => {
    const vp = { start: 1000, end: 2000 };
    expect(panViewport(vp, 500, 10_000, W)).toEqual({ start: 1500, end: 2500 });
    expect(panViewport(vp, -5000, 10_000, W)).toEqual({ start: 0, end: 1000 });
    expect(panViewport(vp, 50_000, 10_000, W)).toEqual({ start: 9000, end: 10_000 });
  });
});

describe('clampViewport', () => {
  it('replaces invalid windows by the whole record', () => {
    expect(clampViewport({ start: Number.NaN, end: 5 }, 500, W)).toEqual({ start: 0, end: 500 });
    expect(clampViewport({ start: 10, end: 10 }, 500, W)).toEqual({ start: 0, end: 500 });
    expect(clampViewport({ start: 20, end: 10 }, 500, W)).toEqual({ start: 0, end: 500 });
  });

  it('caps the span at the record length and keeps the window inside it', () => {
    expect(clampViewport({ start: -200, end: 900 }, 500, 100)).toEqual({ start: 0, end: 500 });
    expect(clampViewport({ start: -50, end: 50 }, 500, 100)).toEqual({ start: 0, end: 100 });
    expect(clampViewport({ start: 480, end: 580 }, 500, 100)).toEqual({ start: 400, end: 500 });
  });

  it('widens windows narrower than the deepest zoom around their centre', () => {
    const span = minViewportSpan(W);
    const c = clampViewport({ start: 5000, end: 5001 }, 10_000, W);
    expect(c.end - c.start).toBeCloseTo(span, 9);
    expect((c.start + c.end) / 2).toBeCloseTo(5000.5, 9);
  });

  it('centres records shorter than the deepest-zoom window', () => {
    // 20 bp in 1000 px would be 50 px per base: shown at MAX_PX_PER_BASE, centred
    const c = clampViewport({ start: 0, end: 20 }, 20, W);
    expect(c.end - c.start).toBeCloseTo(W / MAX_PX_PER_BASE, 9);
    expect((c.start + c.end) / 2).toBeCloseTo(10, 9);
    expect(c.start).toBeLessThan(0);
  });

  it('is idempotent', () => {
    for (const vp of [
      { start: -5, end: 7 },
      { start: 100.5, end: 101 },
      { start: 9000, end: 12_000 },
    ]) {
      const once = clampViewport(vp, 10_000, W);
      expect(clampViewport(once, 10_000, W)).toEqual(once);
    }
  });
});

describe('viewportForRange', () => {
  it('frames a range with a margin', () => {
    expect(viewportForRange({ start: 1000, end: 2000 }, 10_000, 'linear', 0.1)).toEqual({ start: 900, end: 2100 });
  });

  it('frames the larger piece of a range that wraps the origin', () => {
    // 3,800..4,000 + 0..600 on a 4,000 bp plasmid: the 600 bp piece is framed
    const vp = viewportForRange({ start: 3800, end: 4600 }, 4000, 'circular', 0);
    expect(vp.start).toBeCloseTo(-1, 9);
    expect(vp.end).toBeCloseTo(601, 9);
  });

  it('gives a caret a tiny window that clamping widens to the deepest zoom', () => {
    const vp = clampViewport(viewportForRange({ start: 500, end: 500 }, 10_000, 'linear'), 10_000, W);
    expect(makeScale(vp, 0, W).pxPerBp).toBeCloseTo(MAX_PX_PER_BASE, 6);
    expect((vp.start + vp.end) / 2).toBeCloseTo(500, 6);
  });
});

describe('interpolateViewport', () => {
  it('starts and ends on the given viewports', () => {
    const a = { start: 0, end: 10_000 };
    const b = { start: 4000, end: 4100 };
    expect(sameViewport(interpolateViewport(a, b, 0), a)).toBe(true);
    expect(sameViewport(interpolateViewport(a, b, 1), b, 1e-6)).toBe(true);
  });

  it('changes the span geometrically (uniform zoom speed)', () => {
    const mid = interpolateViewport({ start: 0, end: 10_000 }, { start: 0, end: 100 }, 0.5);
    expect(mid.end - mid.start).toBeCloseTo(1000, 6);
  });

  it('keeps the target in view while zooming in', () => {
    const from = { start: 0, end: 100_000 };
    const to = { start: 90_000, end: 90_100 };
    for (let t = 0; t <= 1; t += 0.05) {
      const vp = interpolateViewport(from, to, t);
      expect(vp.start).toBeLessThanOrEqual(90_050 + 1e-6);
      expect(vp.end).toBeGreaterThanOrEqual(90_050 - 1e-6);
    }
  });
});

describe('fullViewport / isFullViewport', () => {
  it('describe the whole record', () => {
    expect(fullViewport(4361)).toEqual({ start: 0, end: 4361 });
    expect(isFullViewport({ start: 0, end: 4361 }, 4361)).toBe(true);
    expect(isFullViewport({ start: 0, end: 4000 }, 4361)).toBe(false);
    // short records are shown centred in a wider window: still "everything"
    expect(isFullViewport({ start: -10, end: 50 }, 40)).toBe(true);
  });
});
