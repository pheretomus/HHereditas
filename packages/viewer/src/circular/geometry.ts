/**
 * Pure geometry for the circular map: position <-> angle mapping, polar coordinates,
 * SVG path builders for arcs, bands, arrows and wedges, and ruler tick spacing.
 *
 * Angles are in DEGREES, measured CLOCKWISE from 12 o'clock (screen coordinates, y down).
 * They are continuous: a range that wraps the origin of a circular molecule produces an end
 * angle above 360, which keeps arc arithmetic free of special cases.
 */
import type { Topology } from '@hhereditas/core';
import { mod } from '@hhereditas/core';

export const DEG = Math.PI / 180;

/** Default angular gap (degrees) left open at the origin of a LINEAR molecule. */
export const LINEAR_GAP_DEGREES = 7;

/** Maps sequence positions to angles for one molecule. */
export interface AngleScale {
  /** Sequence length in bp. */
  length: number;
  topology: Topology;
  /** Degrees added to every angle; 0 puts the origin at 12 o'clock, 90 at 3 o'clock. */
  rotation: number;
  /** Angular gap (degrees) at the origin: > 0 only for linear molecules. */
  gap: number;
}

export function createAngleScale(
  length: number,
  topology: Topology,
  rotation = 0,
  linearGap = LINEAR_GAP_DEGREES,
): AngleScale {
  return {
    length: Math.max(0, length),
    topology,
    rotation: Number.isFinite(rotation) ? rotation : 0,
    gap: topology === 'linear' ? Math.max(0, Math.min(90, linearGap)) : 0,
  };
}

/** Degrees covered by one base. */
export function degreesPerBase(s: AngleScale): number {
  return s.length > 0 ? (360 - s.gap) / s.length : 0;
}

/**
 * Angle of a gap position (or fractional position). Not normalized: positions beyond the
 * length (origin-wrapping range ends) give angles beyond `rotation + 360`.
 */
export function positionToAngle(s: AngleScale, position: number): number {
  return s.rotation + s.gap / 2 + position * degreesPerBase(s);
}

/**
 * Fractional sequence position under an angle.
 * Circular: in [0, L). Linear: in [0, L]; angles inside the origin gap snap to the nearest end.
 */
export function angleToPosition(s: AngleScale, angle: number): number {
  if (s.length <= 0) return 0;
  const rel = mod(angle - s.rotation, 360);
  if (s.topology === 'circular') {
    const p = (rel / 360) * s.length;
    return p >= s.length ? 0 : p;
  }
  const inner = rel - s.gap / 2;
  if (inner <= 0) return 0;
  if (inner >= 360 - s.gap) return s.length;
  return (inner / (360 - s.gap)) * s.length;
}

/** Nearest gap position (caret) for an angle: circular in [0, L), linear in [0, L]. */
export function angleToGap(s: AngleScale, angle: number): number {
  const p = Math.round(angleToPosition(s, angle));
  return s.topology === 'circular' && s.length > 0 ? mod(p, s.length) : p;
}

/** Base index (0-based) under an angle, or -1 for an empty molecule. */
export function angleToBase(s: AngleScale, angle: number): number {
  if (s.length <= 0) return -1;
  return Math.min(s.length - 1, Math.max(0, Math.floor(angleToPosition(s, angle))));
}

export interface Point {
  x: number;
  y: number;
}

export function polarToCartesian(cx: number, cy: number, r: number, angle: number): Point {
  const a = angle * DEG;
  return { x: cx + r * Math.sin(a), y: cy - r * Math.cos(a) };
}

/** Radius and angle (degrees in [0, 360), clockwise from 12 o'clock) of a point. */
export function cartesianToPolar(cx: number, cy: number, x: number, y: number): { r: number; angle: number } {
  const dx = x - cx;
  const dy = y - cy;
  const r = Math.hypot(dx, dy);
  const angle = r === 0 ? 0 : mod(Math.atan2(dx, -dy) / DEG, 360);
  return { r, angle };
}

/** Signed smallest rotation (degrees, in (-180, 180]) that turns `from` into `to`. */
export function angleDelta(from: number, to: number): number {
  const d = mod(to - from, 360);
  return d > 180 ? d - 360 : d;
}

/** True if `angle` lies on the clockwise arc from `a0` to `a1` (continuous angles, a1 >= a0). */
export function angleInArc(angle: number, a0: number, a1: number, tolerance = 0): boolean {
  const span = a1 - a0;
  if (span + 2 * tolerance >= 360) return true;
  return mod(angle - (a0 - tolerance), 360) <= span + 2 * tolerance;
}

/** Arc length in px of an angular span at radius r. */
export function arcLength(r: number, degrees: number): number {
  return Math.abs(degrees) * DEG * r;
}

/** Degrees spanned by an arc of `px` pixels at radius r. */
export function pxToDegrees(px: number, r: number): number {
  return r > 0 ? px / (r * DEG) : 0;
}

// ---------------------------------------------------------------------------
// SVG path builders. Numbers are rounded to 0.01 px to keep the markup compact.
// ---------------------------------------------------------------------------

function n(v: number): string {
  return String(Math.round(v * 100) / 100);
}

function pt(cx: number, cy: number, r: number, angle: number): string {
  const p = polarToCartesian(cx, cy, r, angle);
  return `${n(p.x)} ${n(p.y)}`;
}

/** Arc command(s) from the current point at angle a0 to angle a1 (either direction). */
function arcTo(cx: number, cy: number, r: number, a0: number, a1: number): string {
  const span = a1 - a0;
  if (Math.abs(span) >= 359.999) {
    // A single SVG arc cannot draw a full circle: go via the opposite point.
    const mid = a0 + span / 2;
    const sweep = span > 0 ? 1 : 0;
    return `A ${n(r)} ${n(r)} 0 0 ${sweep} ${pt(cx, cy, r, mid)} A ${n(r)} ${n(r)} 0 0 ${sweep} ${pt(cx, cy, r, a1)}`;
  }
  const large = Math.abs(span) > 180 ? 1 : 0;
  const sweep = span >= 0 ? 1 : 0;
  return `A ${n(r)} ${n(r)} 0 ${large} ${sweep} ${pt(cx, cy, r, a1)}`;
}

/** Open arc (for strokes) from a0 to a1. a1 < a0 draws counter-clockwise. */
export function arcPath(cx: number, cy: number, r: number, a0: number, a1: number): string {
  return `M ${pt(cx, cy, r, a0)} ${arcTo(cx, cy, r, a0, a1)}`;
}

/** Full circle as a path (two half arcs). */
export function circlePath(cx: number, cy: number, r: number): string {
  return `${arcPath(cx, cy, r, 0, 360)} Z`;
}

/** Closed annular sector between radii rIn..rOut and angles a0..a1 (a1 >= a0). */
export function bandPath(cx: number, cy: number, rIn: number, rOut: number, a0: number, a1: number): string {
  if (a1 - a0 >= 359.999) {
    // Full ring: two concentric circles (even-odd fill).
    return `${circlePath(cx, cy, rOut)} ${circlePath(cx, cy, rIn)}`;
  }
  return (
    `M ${pt(cx, cy, rOut, a0)} ${arcTo(cx, cy, rOut, a0, a1)} ` +
    `L ${pt(cx, cy, rIn, a1)} ${arcTo(cx, cy, rIn, a1, a0)} Z`
  );
}

/**
 * Arrow-shaped band. `direction` 1 puts the head at a1 (forward strand), -1 at a0 (reverse),
 * 0 draws a plain band. `headPx` is the head length measured along the middle radius; it is
 * shortened on short arcs so the arrow keeps a visible body (or becomes a pure head).
 */
export function arrowPath(
  cx: number,
  cy: number,
  rIn: number,
  rOut: number,
  a0: number,
  a1: number,
  direction: 1 | -1 | 0,
  headPx: number,
): string {
  const span = a1 - a0;
  const rMid = (rIn + rOut) / 2;
  if (direction === 0 || headPx <= 0 || span <= 0 || span >= 359.999) return bandPath(cx, cy, rIn, rOut, a0, a1);
  const spanPx = arcLength(rMid, span);
  if (spanPx < 1.5) return bandPath(cx, cy, rIn, rOut, a0, a1);
  // Keep at least ~40% of the arrow as body when it is short.
  const head = Math.min(pxToDegrees(headPx, rMid), span * (spanPx < headPx * 1.6 ? 0.6 : 1));
  if (direction === 1) {
    const b = a1 - head;
    if (b <= a0 + 1e-9) {
      return `M ${pt(cx, cy, rOut, a0)} L ${pt(cx, cy, rMid, a1)} L ${pt(cx, cy, rIn, a0)} Z`;
    }
    return (
      `M ${pt(cx, cy, rOut, a0)} ${arcTo(cx, cy, rOut, a0, b)} ` +
      `L ${pt(cx, cy, rMid, a1)} L ${pt(cx, cy, rIn, b)} ${arcTo(cx, cy, rIn, b, a0)} Z`
    );
  }
  const b = a0 + head;
  if (b >= a1 - 1e-9) {
    return `M ${pt(cx, cy, rMid, a0)} L ${pt(cx, cy, rOut, a1)} L ${pt(cx, cy, rIn, a1)} Z`;
  }
  return (
    `M ${pt(cx, cy, rMid, a0)} L ${pt(cx, cy, rOut, b)} ${arcTo(cx, cy, rOut, b, a1)} ` +
    `L ${pt(cx, cy, rIn, a1)} ${arcTo(cx, cy, rIn, a1, b)} Z`
  );
}

/**
 * Thin arrow along radius `rMid`: a shaft of `thickness` px and a head `headWidth` px wide and
 * `headLen` px long at a1 (direction 1) or a0 (direction -1). Used for primers and ORFs, where
 * the head must be wider than the shaft to stay readable.
 */
export function thinArrowPath(
  cx: number,
  cy: number,
  rMid: number,
  thickness: number,
  headWidth: number,
  headLen: number,
  a0: number,
  a1: number,
  direction: 1 | -1,
): string {
  const span = a1 - a0;
  const t = thickness / 2;
  const hw = headWidth / 2;
  if (span <= 0) return '';
  const spanPx = arcLength(rMid, span);
  const hl = Math.min(headLen, spanPx * 0.6);
  const head = pxToDegrees(hl, rMid);
  if (direction === 1) {
    const b = a1 - head;
    return (
      `M ${pt(cx, cy, rMid + t, a0)} ${arcTo(cx, cy, rMid + t, a0, b)} L ${pt(cx, cy, rMid + hw, b)} ` +
      `L ${pt(cx, cy, rMid, a1)} L ${pt(cx, cy, rMid - hw, b)} L ${pt(cx, cy, rMid - t, b)} ` +
      `${arcTo(cx, cy, rMid - t, b, a0)} Z`
    );
  }
  const b = a0 + head;
  return (
    `M ${pt(cx, cy, rMid, a0)} L ${pt(cx, cy, rMid + hw, b)} L ${pt(cx, cy, rMid + t, b)} ` +
    `${arcTo(cx, cy, rMid + t, b, a1)} L ${pt(cx, cy, rMid - t, a1)} ${arcTo(cx, cy, rMid - t, a1, b)} ` +
    `L ${pt(cx, cy, rMid - hw, b)} Z`
  );
}

/** Pie wedge from the centre to radius r over a0..a1 (full disc when the span is 360). */
export function wedgePath(cx: number, cy: number, r: number, a0: number, a1: number): string {
  if (a1 - a0 >= 359.999) return circlePath(cx, cy, r);
  return `M ${n(cx)} ${n(cy)} L ${pt(cx, cy, r, a0)} ${arcTo(cx, cy, r, a0, a1)} Z`;
}

/** Straight radial segment at `angle` from r0 to r1. */
export function radialLinePath(cx: number, cy: number, r0: number, r1: number, angle: number): string {
  return `M ${pt(cx, cy, r0, angle)} L ${pt(cx, cy, r1, angle)}`;
}

// ---------------------------------------------------------------------------
// Ruler
// ---------------------------------------------------------------------------

export interface RulerSpec {
  /** Distance between labelled ticks (bp). */
  step: number;
  /** Distance between unlabelled minor ticks (bp); equals `step` when there are none. */
  minorStep: number;
  /** Gap positions of the labelled ticks, origin excluded, ascending. */
  major: number[];
}

/** "Nice" tick spacing (1, 2, 2.5 or 5 x 10^k bp) giving close to `target` ticks around the molecule. */
export function niceTickStep(length: number, target = 10): number {
  if (!(length > 0)) return 1;
  const raw = length / target;
  const pow = 10 ** Math.floor(Math.log10(raw));
  let best = 0;
  let bestScore = Infinity;
  for (const m of [1, 2, 2.5, 5, 10]) {
    const step = m * pow;
    if (step < 1 || !Number.isInteger(step)) continue;
    const score = Math.abs(Math.log(length / step / target));
    if (score < bestScore) {
      best = step;
      bestScore = score;
    }
  }
  return best || 1;
}

/** Tick positions for a molecule of `length` bp. */
export function rulerSpec(length: number, target = 10): RulerSpec {
  const step = niceTickStep(length, target);
  const mantissa = step / 10 ** Math.floor(Math.log10(step));
  const minorDiv = mantissa === 2 ? 4 : 5;
  const minorStep = step % minorDiv === 0 ? step / minorDiv : step;
  const major: number[] = [];
  for (let p = step; p < length; p += step) {
    // Skip a tick crowding the origin (where the "1" mark sits).
    if (length - p < step * 0.3) continue;
    major.push(p);
  }
  return { step, minorStep, major };
}
