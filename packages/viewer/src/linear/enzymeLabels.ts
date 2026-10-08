/**
 * Restriction-enzyme cut markers and the placement of their labels in staggered rows.
 *
 * Labels sit in rows above the map; a thin vertical leader joins each label to its cut on the
 * backbone. The leader starts at the label's left edge (or right edge when the label is
 * flipped), so a label occupies [x, x + w] (or [x - w, x]). Placement guarantees:
 *   1. labels in the same row never overlap (with a gap);
 *   2. a leader never passes through a label of a lower row (rows nearer the backbone);
 *   3. a label never covers the leader of a label in a higher row.
 * Unique cutters are placed first. Within a priority class labels are placed right to left,
 * which turns clusters into a tidy staircase rising to the left. Labels that cannot be placed
 * within `maxRows` are dropped (the cut marker is still drawn and the tooltip names it).
 */
import type { EnzymeSite, Topology } from '@hhereditas/core';
import { formatInt } from '../common/format';

export interface CutMarker {
  /** Gap position of the top-strand cut, in [0, L] (the recognition site's centre if uncut). */
  pos: number;
  /** Gap position of the bottom-strand cut (top-strand coordinates), same as `pos` if uncut. */
  bottom: number;
  site: EnzymeSite;
  /** True if the enzyme cuts the record exactly once. */
  unique: boolean;
  /** False for a site that is recognised but not cleaved (e.g. too close to a linear end). */
  cuts: boolean;
  /** "EcoRI (396)": the number is the 1-based position of the base preceding the top-strand cut. */
  label: string;
}

/** 1-based number shown for a top-strand cut at gap `gap` (SnapGene convention). */
export function cutDisplayPosition(gap: number, seqLength: number, topology: Topology): number {
  if (gap <= 0) return topology === 'circular' ? seqLength : 0;
  return gap;
}

/** One marker per cut (sites with no cut get one uncut marker), sorted by position. */
export function buildCutMarkers(sites: readonly EnzymeSite[], seqLength: number, topology: Topology): CutMarker[] {
  const cutCount = new Map<string, number>();
  for (const s of sites) cutCount.set(s.enzyme, (cutCount.get(s.enzyme) ?? 0) + s.cuts.length);
  const out: CutMarker[] = [];
  const L = seqLength;
  const norm = (p: number) => (topology === 'circular' && L > 0 ? ((p % L) + L) % L : Math.max(0, Math.min(L, p)));
  for (const site of sites) {
    const unique = cutCount.get(site.enzyme) === 1;
    if (site.cuts.length === 0) {
      const mid = norm(Math.floor((site.range.start + site.range.end) / 2));
      out.push({ pos: mid, bottom: mid, site, unique: false, cuts: false, label: site.enzyme });
      continue;
    }
    for (const cut of site.cuts) {
      const pos = norm(cut.top);
      out.push({
        pos,
        bottom: norm(cut.bottom),
        site,
        unique,
        cuts: true,
        label: `${site.enzyme} (${formatInt(cutDisplayPosition(pos, L, topology))})`,
      });
    }
  }
  out.sort((a, b) => a.pos - b.pos || a.label.localeCompare(b.label));
  return out;
}

export interface LabelBox {
  /** x (px) of the leader (the cut). */
  x: number;
  /** Width (px) of the label box including the padding between leader and text. */
  width: number;
  /** Higher is placed first. */
  priority: number;
}

export interface PlacedLabel {
  row: number;
  left: number;
  right: number;
  /** 'start': text starts at the leader (box [x, x + w]); 'end': text ends at it. */
  align: 'start' | 'end';
}

export interface LabelPlacementOptions {
  maxRows: number;
  /** Minimum horizontal space between labels of one row. */
  gap?: number;
  /** Minimum distance between a leader and a label it passes. */
  clearance?: number;
  /** Labels must stay inside [minX, maxX]. */
  minX?: number;
  maxX?: number;
}

/** Interval list sorted by left edge, non-overlapping. */
type Row = Array<[number, number]>;

/** Index of the first interval whose right edge is >= x. */
function firstRightAtLeast(row: Row, x: number): number {
  let lo = 0;
  let hi = row.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (row[mid][1] >= x) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

function overlapsRow(row: Row, l: number, r: number): boolean {
  const i = firstRightAtLeast(row, l);
  return i < row.length && row[i][0] <= r;
}

function insertInterval(row: Row, l: number, r: number): void {
  const i = firstRightAtLeast(row, l);
  row.splice(i, 0, [l, r]);
}

function lowerBound(arr: number[], x: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Place labels; returns one placement (or null when dropped) per input box, in input order. */
export function placeEnzymeLabels(boxes: readonly LabelBox[], opts: LabelPlacementOptions): Array<PlacedLabel | null> {
  const maxRows = Math.max(0, Math.floor(opts.maxRows));
  const gap = opts.gap ?? 6;
  const clearance = opts.clearance ?? 3;
  const minX = opts.minX ?? -Infinity;
  const maxX = opts.maxX ?? Infinity;
  const result: Array<PlacedLabel | null> = new Array<PlacedLabel | null>(boxes.length).fill(null);
  if (maxRows === 0) return result;

  const rows: Row[] = Array.from({ length: maxRows }, () => []);
  // leadersThrough[r]: sorted x of leaders that cross row r (they belong to labels above it).
  const leadersThrough: number[][] = Array.from({ length: maxRows }, () => []);

  const order = boxes.map((_, i) => i);
  order.sort((a, b) => boxes[b].priority - boxes[a].priority || boxes[b].x - boxes[a].x || a - b);

  for (const i of order) {
    const { x, width } = boxes[i];
    if (!(x >= minX && x <= maxX)) continue;
    let placed: PlacedLabel | null = null;
    for (let row = 0; row < maxRows && !placed; row++) {
      // the leader of a label in `row` crosses every lower row: it must not hit their labels
      let leaderBlocked = false;
      for (let j = 0; j < row; j++) {
        if (overlapsRow(rows[j], x - clearance, x + clearance)) {
          leaderBlocked = true;
          break;
        }
      }
      if (leaderBlocked) break; // higher rows have even longer leaders through the same labels
      for (const align of ['start', 'end'] as const) {
        const left = align === 'start' ? x : x - width;
        const right = align === 'start' ? x + width : x;
        if (left < minX || right > maxX) continue;
        if (overlapsRow(rows[row], left - gap, right + gap)) continue;
        const through = leadersThrough[row];
        const k = lowerBound(through, left - clearance);
        if (k < through.length && through[k] <= right + clearance) continue;
        placed = { row, left, right, align };
        break;
      }
    }
    if (!placed) continue;
    insertInterval(rows[placed.row], placed.left, placed.right);
    for (let j = 0; j < placed.row; j++) {
      const through = leadersThrough[j];
      through.splice(lowerBound(through, x), 0, x);
    }
    result[i] = placed;
  }
  return result;
}

/** Number of rows actually used by a placement. */
export function rowsUsed(placements: ReadonlyArray<PlacedLabel | null>): number {
  let n = 0;
  for (const p of placements) if (p && p.row + 1 > n) n = p.row + 1;
  return n;
}
