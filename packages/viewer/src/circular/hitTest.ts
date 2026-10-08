/**
 * Geometric hit testing for the circular map. Works on layout numbers only (no DOM
 * geometry), so hover, click and context menus agree exactly with what is drawn and the
 * behaviour is testable without a browser layout engine.
 */
import { angleInArc, angleToPosition, cartesianToPolar, pxToDegrees } from './geometry';
import type { EnzymeShape, FeatureShape, LabelPlacement, MapGeometry, OrfShape, PrimerShape } from './layout';
import type { MapTarget } from './types';

export type HitResult =
  | { kind: 'feature'; shape: FeatureShape; via: 'shape' | 'label' }
  | { kind: 'enzyme'; shape: EnzymeShape; via: 'shape' | 'label' }
  | { kind: 'primer'; shape: PrimerShape; via: 'shape' | 'label' }
  | { kind: 'orf'; shape: OrfShape }
  /** The ring area: presses start caret placement / drag selection. Fractional position. */
  | { kind: 'ring'; position: number }
  /** Empty space (outside the ring or at the very centre). Fractional position. */
  | { kind: 'background'; position: number };

const LABEL_PAD = 2;

/** What is under the point (x, y) in SVG coordinates. */
export function hitTest(geom: MapGeometry, placement: LabelPlacement | null, x: number, y: number): HitResult {
  if (placement) {
    for (const l of placement.labels) {
      const b = l.box;
      if (x >= b.x0 - LABEL_PAD && x <= b.x1 + LABEL_PAD && y >= b.y0 && y <= b.y1) {
        const ref = l.candidate.ref;
        if (ref.kind === 'feature') return { kind: 'feature', shape: geom.features[ref.index], via: 'label' };
        if (ref.kind === 'enzyme') return { kind: 'enzyme', shape: geom.enzymes[ref.index], via: 'label' };
        return { kind: 'primer', shape: geom.primers[ref.index], via: 'label' };
      }
    }
  }
  const { r, angle } = cartesianToPolar(geom.cx, geom.cy, x, y);
  const position = angleToPosition(geom.scale, angle);
  const R = geom.radius;

  // Enzyme cut ticks (crossing the backbone).
  if (geom.enzymes.length && r >= R - 6 && r <= R + 8) {
    const tol = pxToDegrees(4, R);
    let best: EnzymeShape | null = null;
    let bestDist = Infinity;
    for (const e of geom.enzymes) {
      for (const a of e.cutAngles) {
        const d = Math.abs(((((angle - a) % 360) + 540) % 360) - 180);
        if (d <= tol && d < bestDist) {
          best = e;
          bestDist = d;
        }
      }
    }
    if (best) return { kind: 'enzyme', shape: best, via: 'shape' };
  }

  // Primer arrows.
  if (geom.primers.length && r > R + 1) {
    const hit = smallestContaining(geom.primers, r, angle, 1.5, 2);
    if (hit) return { kind: 'primer', shape: hit, via: 'shape' };
  }

  // Features (smallest wins where shapes overlap).
  if (geom.features.length && r < R) {
    let best: FeatureShape | null = null;
    let bestSpan = Infinity;
    for (const f of geom.features) {
      if (r < f.rIn - 1 || r > f.rOut + 1) continue;
      const tol = pxToDegrees(1, r);
      for (const s of f.segments) {
        if (angleInArc(angle, s.a0, s.a1, tol)) {
          const span = f.a1 - f.a0;
          if (span < bestSpan) {
            best = f;
            bestSpan = span;
          }
          break;
        }
      }
    }
    if (best) return { kind: 'feature', shape: best, via: 'shape' };
  }

  // ORFs.
  if (geom.orfs.length && r < R) {
    const hit = smallestContaining(geom.orfs, r, angle, 1, 1.5);
    if (hit) return { kind: 'orf', shape: hit };
  }

  if (r >= geom.dragInner && r <= geom.dragOuter) return { kind: 'ring', position };
  return { kind: 'background', position };
}

function smallestContaining<T extends { rIn: number; rOut: number; a0: number; a1: number }>(
  shapes: readonly T[],
  r: number,
  angle: number,
  radialTol: number,
  angularPx: number,
): T | null {
  let best: T | null = null;
  let bestSpan = Infinity;
  for (const s of shapes) {
    if (r < s.rIn - radialTol || r > s.rOut + radialTol) continue;
    if (!angleInArc(angle, s.a0, s.a1, pxToDegrees(angularPx, r))) continue;
    const span = s.a1 - s.a0;
    if (span < bestSpan) {
      best = s;
      bestSpan = span;
    }
  }
  return best;
}

/** The MapTarget reported to onContextMenu for a hit. */
export function hitToTarget(hit: HitResult, geom: MapGeometry): MapTarget {
  const L = geom.model.length;
  switch (hit.kind) {
    case 'feature':
      return { kind: 'feature', id: hit.shape.id };
    case 'enzyme':
      return { kind: 'enzyme', site: hit.shape.item.site };
    case 'primer':
      return { kind: 'primer', id: hit.shape.item.site.primerId };
    case 'orf':
      return { kind: 'orf', orf: hit.shape.item.orf };
    case 'ring':
      return { kind: 'sequence', position: L > 0 ? Math.min(L - 1, Math.max(0, Math.floor(hit.position))) : 0 };
    case 'background': {
      let gap = Math.round(hit.position);
      if (geom.model.topology === 'circular' && L > 0) gap %= L;
      return { kind: 'background', position: gap };
    }
  }
}

/** Stable identity of a hit for hover tracking ('' for ring / background). */
export function hitKey(hit: HitResult | null): string {
  if (!hit) return '';
  switch (hit.kind) {
    case 'feature':
      return `f:${hit.shape.id}`;
    case 'enzyme':
      return `e:${hit.shape.index}`;
    case 'primer':
      return `p:${hit.shape.index}`;
    case 'orf':
      return `o:${hit.shape.index}`;
    default:
      return '';
  }
}
