/**
 * SVG path builders for the linear map glyphs. Coordinates are rounded to 1/100 px to keep
 * path strings short without visible loss (HiDPI screens resolve 1/2 px at most).
 */

const r2 = (n: number): number => Math.round(n * 100) / 100;

/** Which end of a bar is pointed: its 3' end, or both for a bidirectional feature. */
export type ArrowEnd = 'right' | 'left' | 'both' | 'none';

export interface BarShapeOptions {
  /** Pointed end, if any. */
  arrow: ArrowEnd;
  /** Length of the arrow head (px); it is shortened for short bars. */
  head: number;
  /** Corner radius of the blunt end(s). */
  radius: number;
  /** Draw the left / right end square (used where a piece continues across the origin or off-screen). */
  squareLeft?: boolean;
  squareRight?: boolean;
}

/**
 * A feature bar from x0 to x1 (x0 < x1), top y, height h: a rounded rectangle whose 3' end is
 * pointed. The arrow head never takes more than 60% of the bar so short features still read
 * as bars with a direction.
 */
export function barPath(x0: number, x1: number, y: number, h: number, o: BarShapeOptions): string {
  const w = Math.max(0, x1 - x0);
  const pointL = o.arrow === 'left' || o.arrow === 'both';
  const pointR = o.arrow === 'right' || o.arrow === 'both';
  // two heads share the bar, so each takes at most 30% of it
  const head = o.arrow === 'none' ? 0 : Math.min(o.head, w * (o.arrow === 'both' ? 0.3 : 0.6));
  const mid = y + h / 2;
  const bottom = y + h;
  const bodyL = pointL ? x0 + head : x0;
  const bodyR = pointR ? x1 - head : x1;
  const radiusL = pointL || o.squareLeft ? 0 : Math.min(o.radius, h / 2, (bodyR - bodyL) / 2);
  const radiusR = pointR || o.squareRight ? 0 : Math.min(o.radius, h / 2, (bodyR - bodyL) / 2);

  let d = `M${r2(bodyL + radiusL)} ${r2(y)}`;
  // top edge to the right end
  d += `H${r2(bodyR - radiusR)}`;
  if (pointR) {
    d += `L${r2(x1)} ${r2(mid)}L${r2(bodyR)} ${r2(bottom)}`;
  } else if (radiusR > 0) {
    d += `Q${r2(bodyR)} ${r2(y)} ${r2(bodyR)} ${r2(y + radiusR)}V${r2(bottom - radiusR)}Q${r2(bodyR)} ${r2(bottom)} ${r2(bodyR - radiusR)} ${r2(bottom)}`;
  } else {
    d += `V${r2(bottom)}`;
  }
  // bottom edge back to the left end
  d += `H${r2(bodyL + radiusL)}`;
  if (pointL) {
    d += `L${r2(x0)} ${r2(mid)}L${r2(bodyL)} ${r2(y)}`;
  } else if (radiusL > 0) {
    d += `Q${r2(bodyL)} ${r2(bottom)} ${r2(bodyL)} ${r2(bottom - radiusL)}V${r2(y + radiusL)}Q${r2(bodyL)} ${r2(y)} ${r2(bodyL + radiusL)} ${r2(y)}`;
  } else {
    d += `V${r2(y)}`;
  }
  return `${d}Z`;
}

/** A plain rectangle as a sub-path (for batching many small glyphs into one <path>). */
export function rectPath(x: number, y: number, w: number, h: number): string {
  return `M${r2(x)} ${r2(y)}h${r2(w)}v${r2(h)}h${r2(-w)}Z`;
}

/** A vertical line segment as a sub-path. */
export function vlinePath(x: number, y0: number, y1: number): string {
  return `M${r2(x)} ${r2(y0)}V${r2(y1)}`;
}

/** A horizontal line segment as a sub-path. */
export function hlinePath(x0: number, x1: number, y: number): string {
  return `M${r2(x0)} ${r2(y)}H${r2(x1)}`;
}

/**
 * Primer glyph: a thin shaft with a half arrow head (harpoon) at the 3' end. Forward primers
 * point right with the barb up; reverse primers point left with the barb down, so the barb
 * always faces away from the backbone.
 */
export function primerPath(x0: number, x1: number, y: number, dir: 1 | -1, shaft: number, head: number, barb: number): string {
  const w = Math.max(0, x1 - x0);
  const hl = Math.min(head, w * 0.7);
  const half = shaft / 2;
  if (dir === 1) {
    // shaft from x0 to x1, barb rising before the tip
    return (
      `M${r2(x0)} ${r2(y - half)}H${r2(x1 - hl)}L${r2(x1 - hl)} ${r2(y - half - barb)}` +
      `L${r2(x1)} ${r2(y + half)}H${r2(x0)}Z`
    );
  }
  return (
    `M${r2(x1)} ${r2(y + half)}H${r2(x0 + hl)}L${r2(x0 + hl)} ${r2(y + half + barb)}` +
    `L${r2(x0)} ${r2(y - half)}H${r2(x1)}Z`
  );
}

/** ORF glyph: a thin bar with a full triangular head at the 3' end. */
export function orfPath(x0: number, x1: number, y: number, dir: 1 | -1, thickness: number, head: number, headHalf: number): string {
  const w = Math.max(0, x1 - x0);
  const hl = Math.min(head, w * 0.6);
  const t = thickness / 2;
  if (dir === 1) {
    return (
      `M${r2(x0)} ${r2(y - t)}H${r2(x1 - hl)}V${r2(y - headHalf)}L${r2(x1)} ${r2(y)}` +
      `L${r2(x1 - hl)} ${r2(y + headHalf)}V${r2(y + t)}H${r2(x0)}Z`
    );
  }
  return (
    `M${r2(x1)} ${r2(y - t)}H${r2(x0 + hl)}V${r2(y - headHalf)}L${r2(x0)} ${r2(y)}` +
    `L${r2(x0 + hl)} ${r2(y + headHalf)}V${r2(y + t)}H${r2(x1)}Z`
  );
}
