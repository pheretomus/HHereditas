import { describe, expect, it } from 'vitest';
import {
  angleDelta,
  angleInArc,
  angleToBase,
  angleToGap,
  angleToPosition,
  arcPath,
  arrowPath,
  bandPath,
  cartesianToPolar,
  createAngleScale,
  degreesPerBase,
  distanceToSegment,
  niceTickStep,
  polarToCartesian,
  positionToAngle,
  rulerSpec,
  thinArrowPath,
  wedgePath,
} from './geometry';

const close = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) <= eps;

describe('position <-> angle', () => {
  it('puts the origin at 12 o’clock and runs clockwise', () => {
    const s = createAngleScale(4000, 'circular');
    expect(positionToAngle(s, 0)).toBe(0);
    expect(positionToAngle(s, 1000)).toBe(90);
    expect(positionToAngle(s, 2000)).toBe(180);
    expect(positionToAngle(s, 3000)).toBe(270);
    expect(degreesPerBase(s)).toBeCloseTo(0.09, 12);
  });

  it('keeps angles continuous for ranges that wrap the origin (end > length)', () => {
    const s = createAngleScale(4000, 'circular');
    expect(positionToAngle(s, 4200)).toBeCloseTo(378, 9);
    expect(positionToAngle(s, 4200) - positionToAngle(s, 3900)).toBeCloseTo(27, 9);
  });

  it('round-trips positions through angles, with and without rotation', () => {
    for (const rotation of [0, 37, 90, -45, 270, 725]) {
      const s = createAngleScale(3938, 'circular', rotation);
      for (const p of [0, 1, 17.5, 1969, 3000.25, 3937]) {
        expect(angleToPosition(s, positionToAngle(s, p))).toBeCloseTo(p, 6);
      }
    }
  });

  it('applies the rotation clockwise', () => {
    const s = createAngleScale(1000, 'circular', 90);
    expect(positionToAngle(s, 0)).toBe(90); // origin at 3 o'clock
    expect(angleToPosition(s, 90)).toBe(0);
    expect(angleToPosition(s, 180)).toBeCloseTo(250, 9);
    // angles just before the rotated origin map to the end of the molecule
    expect(angleToPosition(s, 89.64)).toBeCloseTo(999, 6);
  });

  it('normalizes any angle (negative, > 360) into [0, L) on circular molecules', () => {
    const s = createAngleScale(3600, 'circular');
    expect(angleToPosition(s, -10)).toBeCloseTo(3500, 9);
    expect(angleToPosition(s, 370)).toBeCloseTo(100, 9);
    expect(angleToPosition(s, 360)).toBe(0);
    expect(angleToGap(s, 359.99)).toBe(0); // rounds to L, which is the origin gap
    expect(angleToGap(s, 359.94)).toBe(3599);
  });

  it('gives the base under an angle', () => {
    const s = createAngleScale(360, 'circular');
    expect(angleToBase(s, 0.5)).toBe(0);
    expect(angleToBase(s, 359.5)).toBe(359);
    expect(angleToBase(createAngleScale(0, 'circular'), 10)).toBe(-1);
  });

  it('leaves a gap at the origin of linear molecules and snaps inside it to the nearest end', () => {
    const s = createAngleScale(1000, 'linear', 0, 8);
    expect(s.gap).toBe(8);
    expect(positionToAngle(s, 0)).toBe(4);
    expect(positionToAngle(s, 1000)).toBe(356);
    expect(angleToPosition(s, 2)).toBe(0);
    expect(angleToPosition(s, 358)).toBe(1000);
    expect(angleToPosition(s, 180)).toBeCloseTo(500, 9);
    expect(angleToGap(s, 357)).toBe(1000);
    expect(createAngleScale(1000, 'circular', 0, 8).gap).toBe(0);
  });

  it('converts between polar and cartesian coordinates (clockwise from 12 o’clock)', () => {
    const p = polarToCartesian(100, 100, 50, 90);
    expect(close(p.x, 150) && close(p.y, 100)).toBe(true);
    const q = polarToCartesian(100, 100, 50, 180);
    expect(close(q.x, 100) && close(q.y, 150)).toBe(true);
    expect(cartesianToPolar(100, 100, 100, 50)).toEqual({ r: 50, angle: 0 });
    expect(cartesianToPolar(100, 100, 50, 100).angle).toBeCloseTo(270, 9);
    for (const a of [0, 13, 90, 181, 359]) {
      const c = polarToCartesian(0, 0, 80, a);
      expect(cartesianToPolar(0, 0, c.x, c.y).angle).toBeCloseTo(a, 9);
    }
  });

  it('measures signed angle deltas and arc membership across 0°', () => {
    expect(angleDelta(350, 10)).toBe(20);
    expect(angleDelta(10, 350)).toBe(-20);
    expect(angleDelta(0, 180)).toBe(180);
    expect(angleInArc(5, 350, 370)).toBe(true); // arc wrapping 0°
    expect(angleInArc(355, 350, 370)).toBe(true);
    expect(angleInArc(20, 350, 370)).toBe(false);
    expect(angleInArc(10.5, 350, 370, 1)).toBe(true); // within the tolerance past the end (10°)
    expect(angleInArc(12, 350, 370, 1)).toBe(false);
    expect(angleInArc(123, 0, 360)).toBe(true);
  });
});

describe('SVG paths', () => {
  const finite = (d: string) => d.length > 0 && !/NaN|Infinity/.test(d);

  it('builds finite paths for regular, wrapping, tiny and full arcs', () => {
    for (const [a0, a1] of [
      [10, 80],
      [350, 380],
      [0, 0.01],
      [0, 360],
      [-20, 200],
    ]) {
      expect(finite(arcPath(0, 0, 100, a0, a1))).toBe(true);
      expect(finite(bandPath(0, 0, 90, 100, a0, a1))).toBe(true);
      expect(finite(wedgePath(0, 0, 100, a0, a1))).toBe(true);
      expect(finite(arrowPath(0, 0, 90, 100, a0, a1, 1, 9))).toBe(true);
      expect(finite(arrowPath(0, 0, 90, 100, a0, a1, -1, 9))).toBe(true);
      if (a1 > a0) expect(finite(thinArrowPath(0, 0, 95, 2, 6, 6, a0, a1, 1))).toBe(true);
    }
  });

  it('draws a full ring as two circles and a full wedge as a disc', () => {
    expect(bandPath(0, 0, 90, 100, 0, 360).match(/M/g)).toHaveLength(2);
    expect(wedgePath(0, 0, 100, 0, 360)).not.toContain('L');
  });

  it('puts the arrowhead at the 3′ end', () => {
    // forward: the tip (middle radius) is at a1; reverse: at a0
    const fwd = arrowPath(0, 0, 90, 100, 0, 90, 1, 9);
    const rev = arrowPath(0, 0, 90, 100, 0, 90, -1, 9);
    const tipFwd = polarToCartesian(0, 0, 95, 90);
    const tipRev = polarToCartesian(0, 0, 95, 0);
    expect(fwd).toContain(`${Math.round(tipFwd.x * 100) / 100} ${Math.round(tipFwd.y * 100) / 100}`);
    expect(rev).toContain(`${Math.round(tipRev.x * 100) / 100} ${Math.round(tipRev.y * 100) / 100}`);
    // strand 0: plain band (no point on the middle radius)
    expect(arrowPath(0, 0, 90, 100, 0, 90, 0, 9)).toBe(bandPath(0, 0, 90, 100, 0, 90));
  });
});

describe('ruler', () => {
  it('chooses nicely rounded steps', () => {
    for (const L of [50, 731, 2686, 3938, 4361, 4923, 8596, 12_000, 48_502, 168_903, 4_641_652]) {
      const step = niceTickStep(L);
      const mantissa = step / 10 ** Math.floor(Math.log10(step));
      expect([1, 2, 2.5, 5]).toContain(mantissa);
    }
  });

  it('gives about 8-12 labelled ticks (the origin counts as one)', () => {
    for (let L = 800; L < 6_000_000; L = Math.round(L * 1.37)) {
      const { major } = rulerSpec(L);
      expect(major.length + 1).toBeGreaterThanOrEqual(6);
      expect(major.length + 1).toBeLessThanOrEqual(14);
    }
    expect(rulerSpec(3938).major).toEqual([500, 1000, 1500, 2000, 2500, 3000, 3500]);
    expect(rulerSpec(4923).major).toEqual([500, 1000, 1500, 2000, 2500, 3000, 3500, 4000, 4500]);
  });

  it('skips a labelled tick that would crowd the origin', () => {
    expect(rulerSpec(4100).major).not.toContain(4000);
  });
});

describe('distanceToSegment', () => {
  it('measures to the closest point of the segment', () => {
    expect(distanceToSegment(0, 0, -10, 5, 10, 5)).toBe(5);
    expect(distanceToSegment(0, 0, 3, 4, 10, 4)).toBe(5); // closest is the end point
    expect(distanceToSegment(1, 1, 1, 1, 1, 1)).toBe(0);
  });
});
