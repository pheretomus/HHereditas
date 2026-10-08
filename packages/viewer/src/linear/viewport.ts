/**
 * Horizontal scale and viewport arithmetic for the linear map.
 *
 * The viewport is the visible window of the record in bp, as a `Range` whose bounds may be
 * fractional (smooth zooming needs sub-base precision). It always lies inside [0, length]
 * except for records shorter than the minimum span, which are centred in a wider window so
 * that bases never grow beyond MAX_PX_PER_BASE.
 */
import type { Range, Topology } from '@hhereditas/core';
import { normalizeRange, splitAtOrigin } from '@hhereditas/core';

/** Deepest zoom: pixels per base. */
export const MAX_PX_PER_BASE = 24;
/** Zoom at which base letters are drawn on the backbone (pixels per base). */
export const LETTER_PX_PER_BASE = 8;

/** Maps bp to px and back for one viewport. */
export interface LinearScale {
  /** Visible window in bp (fractional). */
  readonly start: number;
  readonly end: number;
  /** x (px) where bp `start` is drawn, and the width (px) that the window spans. */
  readonly plotLeft: number;
  readonly plotWidth: number;
  readonly pxPerBp: number;
  /** x (px) of a bp coordinate (gap position or fractional base coordinate). */
  x(bp: number): number;
  /** bp coordinate (fractional) under an x position (px). */
  bp(x: number): number;
}

export function makeScale(viewport: Range, plotLeft: number, plotWidth: number): LinearScale {
  const start = viewport.start;
  const span = Math.max(1e-9, viewport.end - viewport.start);
  const k = Math.max(1e-12, plotWidth) / span;
  return {
    start,
    end: viewport.end,
    plotLeft,
    plotWidth,
    pxPerBp: k,
    x: (bp: number) => plotLeft + (bp - start) * k,
    bp: (x: number) => start + (x - plotLeft) / k,
  };
}

/** Smallest viewport span (bp) for a plot width: the span at MAX_PX_PER_BASE. */
export function minViewportSpan(plotWidth: number, maxPxPerBase: number = MAX_PX_PER_BASE): number {
  return Math.max(1, plotWidth / maxPxPerBase);
}

/**
 * Bring a viewport into the allowed set: span between the minimum span and the record length,
 * window inside [0, length]. When the span must change it is resized around its centre.
 * Records shorter than the minimum span are centred.
 */
export function clampViewport(
  vp: Range,
  seqLength: number,
  plotWidth: number,
  maxPxPerBase: number = MAX_PX_PER_BASE,
): Range {
  const L = Math.max(0, seqLength);
  const minSpan = minViewportSpan(plotWidth, maxPxPerBase);
  const maxSpan = Math.max(L, minSpan);
  let span = vp.end - vp.start;
  const valid = Number.isFinite(vp.start) && Number.isFinite(vp.end) && span > 0;
  if (!valid) return clampViewport({ start: 0, end: maxSpan }, L, plotWidth, maxPxPerBase);
  const center = (vp.start + vp.end) / 2;
  span = Math.min(maxSpan, Math.max(minSpan, span));
  if (span >= L) {
    const start = (L - span) / 2;
    return { start, end: start + span };
  }
  const start = Math.min(L - span, Math.max(0, center - span / 2));
  return { start, end: start + span };
}

/**
 * Zoom by `factor` (> 1 zooms in) keeping `anchorBp` at the same screen position, then clamp.
 */
export function zoomViewport(
  vp: Range,
  factor: number,
  anchorBp: number,
  seqLength: number,
  plotWidth: number,
  maxPxPerBase: number = MAX_PX_PER_BASE,
): Range {
  const span = vp.end - vp.start;
  if (!(factor > 0) || !(span > 0)) return clampViewport(vp, seqLength, plotWidth, maxPxPerBase);
  const minSpan = minViewportSpan(plotWidth, maxPxPerBase);
  const maxSpan = Math.max(seqLength, minSpan);
  const newSpan = Math.min(maxSpan, Math.max(minSpan, span / factor));
  const t = (anchorBp - vp.start) / span;
  const start = anchorBp - t * newSpan;
  return clampViewport({ start, end: start + newSpan }, seqLength, plotWidth, maxPxPerBase);
}

/** Move the window by `deltaBp` (positive = towards the end of the record), then clamp. */
export function panViewport(
  vp: Range,
  deltaBp: number,
  seqLength: number,
  plotWidth: number,
  maxPxPerBase: number = MAX_PX_PER_BASE,
): Range {
  return clampViewport({ start: vp.start + deltaBp, end: vp.end + deltaBp }, seqLength, plotWidth, maxPxPerBase);
}

/** The whole record ("zoom to fit"). The map clamps it, so tiny records are centred. */
export function fullViewport(seqLength: number): Range {
  return { start: 0, end: Math.max(0, seqLength) };
}

/** True when the viewport shows the whole record. */
export function isFullViewport(vp: Range, seqLength: number): boolean {
  return vp.start <= 1e-6 && vp.end >= seqLength - 1e-6;
}

/** Value equality of two viewports (tolerant to floating-point noise). */
export function sameViewport(a: Range | null | undefined, b: Range | null | undefined, eps = 1e-6): boolean {
  if (!a || !b) return a === b;
  return Math.abs(a.start - b.start) <= eps && Math.abs(a.end - b.end) <= eps;
}

/**
 * Viewport that frames `range` with `margin` (fraction of its length) on each side, for
 * "zoom to selection" / "zoom to feature". A range that wraps the origin of a circular record
 * cannot be shown contiguously in the linear map, so its larger piece is framed. Empty ranges
 * (a caret) produce a tiny window that the map widens to its deepest zoom around the caret.
 */
export function viewportForRange(range: Range, seqLength: number, topology: Topology, margin = 0.1): Range {
  const r = normalizeRange(range, seqLength, topology);
  const pieces = topology === 'circular' ? splitAtOrigin(r, seqLength) : [r];
  let best = pieces[0];
  for (const p of pieces) if (p.end - p.start > best.end - best.start) best = p;
  const len = best.end - best.start;
  const pad = Math.max(len * margin, 1);
  return { start: best.start - pad, end: best.end + pad };
}

/**
 * Interpolate between two viewports for animations: the centre moves linearly and the span
 * geometrically, so zooming feels uniform (constant zoom speed) at every scale.
 */
export function interpolateViewport(from: Range, to: Range, t: number): Range {
  const c0 = (from.start + from.end) / 2;
  const c1 = (to.start + to.end) / 2;
  const s0 = Math.max(1e-9, from.end - from.start);
  const s1 = Math.max(1e-9, to.end - to.start);
  const span = s0 * Math.pow(s1 / s0, t);
  // Move the centre in proportion to how far the zoom has progressed (in log space), which
  // keeps the target in view throughout large zooms instead of letting it fly off-screen.
  // (Provably keeps the target centre inside the window when it starts inside it.)
  const zoomT = Math.abs(Math.log(s1 / s0)) < 1e-3 ? t : (s0 - span) / (s0 - s1);
  const ct = Number.isFinite(zoomT) ? Math.min(1, Math.max(0, zoomT)) : t;
  const c = c0 + (c1 - c0) * ct;
  return { start: c - span / 2, end: c + span / 2 };
}
