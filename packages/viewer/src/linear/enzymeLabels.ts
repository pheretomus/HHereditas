/**
 * Restriction-enzyme cut markers and the placement of their labels in staggered rows.
 *
 * Labels sit in rows above the map; a thin vertical leader joins each label to its cut on the
 * backbone. A label usually starts at its leader (text to the right of the cut) and may end at
 * it instead (text to the left) when that saves a row without blocking a neighbour.
 * Placement guarantees:
 *   1. labels in the same row never overlap (they keep a gap);
 *   2. a leader never passes through a label of a lower row (rows nearer the backbone);
 *   3. a label never covers the leader of a label in a higher row.
 * Cuts closer than a pixel or two share one leader, their labels stacked above each other.
 * Labels are placed right to left, which turns a cluster of cuts into a tidy staircase rising
 * to the left. If a unique cutter does not fit, labels of enzymes that cut more often make room
 * for it. Labels that still do not fit within `maxRows` are left out: the cut marker is still
 * drawn and the hover card names it, and zooming in brings the label back.
 */
import type { EnzymeSite, Topology } from '@hhereditas/core';
import { mod } from '@hhereditas/core';
import { formatInt } from '../common/format';

export interface CutMarker {
  /** Gap position of the top-strand cut, in [0, L] (the start of the site if it is not cut). */
  pos: number;
  /**
   * Gap position of the bottom-strand cut in top-strand coordinates, kept next to `pos` (it can
   * fall just outside [0, L] when a staggered cut straddles the origin of a circular record).
   */
  bottom: number;
  site: EnzymeSite;
  /** True if the enzyme cuts the record exactly once. */
  unique: boolean;
  /** False for a site that is recognised but not cleaved (e.g. too close to a linear end). */
  cuts: boolean;
  /** "EcoRI (396)": the number is the 1-based position of the base before the top-strand cut. */
  label: string;
}

/** 1-based number shown for a top-strand cut at gap `gap` (SnapGene convention). */
export function cutDisplayPosition(gap: number, seqLength: number, topology: Topology): number {
  if (topology === 'circular' && seqLength > 0) return mod(gap - 1, seqLength) + 1;
  return Math.max(1, gap);
}

/** One marker per cut (a site that is not cut gets one marker at its start), sorted by position. */
export function buildCutMarkers(sites: readonly EnzymeSite[], seqLength: number, topology: Topology): CutMarker[] {
  const L = seqLength;
  const circular = topology === 'circular' && L > 0;
  const cutCount = new Map<string, number>();
  for (const s of sites) cutCount.set(s.enzyme, (cutCount.get(s.enzyme) ?? 0) + s.cuts.length);
  const norm = (p: number) => (circular ? mod(p, L) : Math.max(0, Math.min(L, p)));
  const out: CutMarker[] = [];
  for (const site of sites) {
    if (site.cuts.length === 0) {
      const start = norm(site.range.start);
      out.push({ pos: start, bottom: start, site, unique: false, cuts: false, label: `${site.enzyme} (${formatInt(start + 1)})` });
      continue;
    }
    const unique = cutCount.get(site.enzyme) === 1;
    for (const cut of site.cuts) {
      const pos = norm(cut.top);
      let offset = cut.bottom - cut.top;
      if (circular) {
        if (offset > L / 2) offset -= L;
        else if (offset < -L / 2) offset += L;
      }
      out.push({
        pos,
        bottom: pos + offset,
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

// ---------------------------------------------------------------------------
// Label placement
// ---------------------------------------------------------------------------

export interface LabelBox {
  /** x (px) of the cut, where the leader is drawn. */
  x: number;
  /** Width (px) of the label box, including the padding between leader and text. */
  width: number;
  /** Higher wins when space runs out (unique cutters: 1, others: 0). */
  priority: number;
}

export interface PlacedLabel {
  row: number;
  /** x of the leader: the cut, or the shared position of cuts closer than a pixel or two. */
  x: number;
  left: number;
  right: number;
  /** 'start': the text starts at the leader (box [x, x + w]); 'end': it ends there. */
  align: 'start' | 'end';
}

export interface LabelPlacementOptions {
  maxRows: number;
  /** Minimum horizontal space between labels of one row (px). */
  gap?: number;
  /** Minimum distance between a leader and a label it passes (px). */
  clearance?: number;
  /** Labels must stay inside [minX, maxX]; cuts outside it get no label. */
  minX?: number;
  maxX?: number;
  /** Cuts closer than this (px) share one leader. */
  mergeDistance?: number;
}

interface Slot {
  left: number;
  right: number;
  /** Leader x of the owner. */
  lx: number;
  owner: number;
}

interface Leader {
  x: number;
  owner: number;
}

/** First index whose slot ends at or after x (slots of a row are disjoint and sorted). */
function firstSlotEndingAtOrAfter(row: readonly Slot[], x: number): number {
  let lo = 0;
  let hi = row.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (row[mid].right >= x) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

function firstLeaderAtOrAfter(list: readonly Leader[], x: number): number {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].x >= x) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** Leaders this close (px) count as the same leader: a shared leader may touch its labels. */
const SAME_LEADER = 0.5;

/** Place labels; returns one placement (or null when left out) per input box, in input order. */
export function placeEnzymeLabels(boxes: readonly LabelBox[], opts: LabelPlacementOptions): Array<PlacedLabel | null> {
  const n = boxes.length;
  const R = Math.max(0, Math.floor(opts.maxRows));
  const result = new Array<PlacedLabel | null>(n).fill(null);
  if (R === 0 || n === 0) return result;
  const gap = opts.gap ?? 6;
  const clear = opts.clearance ?? 3;
  const minX = opts.minX ?? -Infinity;
  const maxX = opts.maxX ?? Infinity;
  const mergeDistance = opts.mergeDistance ?? 1.5;

  // Leader x of every cut: cuts within `mergeDistance` of the first cut of a run share it.
  const byX = boxes.map((_, i) => i).sort((a, b) => boxes[a].x - boxes[b].x || a - b);
  const lx = new Float64Array(n);
  let runStart = -Infinity;
  for (const i of byX) {
    const x = boxes[i].x;
    if (x - runStart > mergeDistance) runStart = x;
    lx[i] = runStart;
  }
  const sortedLx = byX.map((i) => lx[i]);

  const rows: Slot[][] = Array.from({ length: R }, () => []);
  // through[r]: leaders of labels in rows above r (they cross row r), sorted by x.
  const through: Leader[][] = Array.from({ length: R }, () => []);
  const done = new Uint8Array(n);

  /** Owners of slots of `row` that intersect [l, r], skipping slots whose leader is `skipLx`. */
  const slotHits = (row: number, l: number, r: number, skipLx: number, out: number[] | null): boolean => {
    const list = rows[row];
    for (let k = firstSlotEndingAtOrAfter(list, l); k < list.length && list[k].left <= r; k++) {
      if (Math.abs(list[k].lx - skipLx) < SAME_LEADER) continue;
      if (!out) return true;
      out.push(list[k].owner);
    }
    return out ? out.length > 0 : false;
  };

  /** Owners of leaders crossing `row` inside [l, r], skipping leaders at `skipLx`. */
  const leaderHits = (row: number, l: number, r: number, skipLx: number, out: number[] | null): boolean => {
    const list = through[row];
    for (let k = firstLeaderAtOrAfter(list, l); k < list.length && list[k].x <= r; k++) {
      if (Math.abs(list[k].x - skipLx) < SAME_LEADER) continue;
      if (!out) return true;
      out.push(list[k].owner);
    }
    return out ? out.length > 0 : false;
  };

  /** True if a cut not yet processed lies in [l, r] (it would be cut off from every row). */
  const pendingWithin = (i: number, l: number, r: number): boolean => {
    let lo = 0;
    let hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sortedLx[mid] < l) lo = mid + 1;
      else hi = mid;
    }
    for (let k = lo; k < n && sortedLx[k] <= r; k++) {
      const j = byX[k];
      if (j !== i && !done[j]) return true;
    }
    return false;
  };

  const boxOf = (i: number, align: 'start' | 'end'): [number, number] => {
    const x = lx[i];
    return align === 'start' ? [x, x + boxes[i].width] : [x - boxes[i].width, x];
  };
  const inBounds = (l: number, r: number) => l >= minX && r <= maxX;

  const place = (i: number, row: number, align: 'start' | 'end') => {
    const [left, right] = boxOf(i, align);
    const x = lx[i];
    const list = rows[row];
    list.splice(firstSlotEndingAtOrAfter(list, left), 0, { left, right, lx: x, owner: i });
    for (let r = 0; r < row; r++) {
      const t = through[r];
      t.splice(firstLeaderAtOrAfter(t, x), 0, { x, owner: i });
    }
    result[i] = { row, x, left, right, align };
  };

  const remove = (i: number) => {
    const p = result[i];
    if (!p) return;
    const list = rows[p.row];
    const k = list.findIndex((s) => s.owner === i);
    if (k >= 0) list.splice(k, 1);
    for (let r = 0; r < p.row; r++) {
      const t = through[r];
      const m = t.findIndex((l) => l.owner === i);
      if (m >= 0) t.splice(m, 1);
    }
    result[i] = null;
  };

  const tryPlace = (i: number): boolean => {
    const x = lx[i];
    if (!(x >= minX && x <= maxX)) return false;
    const startFits = inBounds(...boxOf(i, 'start'));
    for (let row = 0; row < R; row++) {
      // The leader climbs through every lower row: once blocked, every higher row is too.
      if (row > 0 && slotHits(row - 1, x - clear, x + clear, x, null)) return false;
      for (const align of ['start', 'end'] as const) {
        const [left, right] = boxOf(i, align);
        if (!inBounds(left, right)) continue;
        if (slotHits(row, left - gap, right + gap, NaN, null)) continue;
        if (leaderHits(row, left - clear, right + clear, x, null)) continue;
        // Text left of the leader would cut off cuts still waiting there; allow it only when
        // nothing waits or when the label cannot go right of the leader at all.
        if (align === 'end' && startFits && pendingWithin(i, left - clear, x)) continue;
        place(i, row, align);
        return true;
      }
    }
    return false;
  };

  const order = boxes.map((_, i) => i);
  // Right to left; cuts sharing a leader go rightmost first, so the stack continues the staircase.
  order.sort((a, b) => lx[b] - lx[a] || boxes[b].x - boxes[a].x || boxes[b].priority - boxes[a].priority || a - b);
  for (const i of order) {
    tryPlace(i);
    done[i] = 1;
  }

  // Unique cutters that did not fit evict the fewest lower-priority labels that block them.
  let evicted = false;
  for (const i of order) {
    if (result[i] || boxes[i].priority <= 0) continue;
    const x = lx[i];
    if (!(x >= minX && x <= maxX)) continue;
    let best: { row: number; align: 'start' | 'end'; owners: number[] } | null = null;
    for (let row = 0; row < R; row++) {
      for (const align of ['start', 'end'] as const) {
        const [left, right] = boxOf(i, align);
        if (!inBounds(left, right)) continue;
        const owners: number[] = [];
        slotHits(row, left - gap, right + gap, NaN, owners);
        leaderHits(row, left - clear, right + clear, x, owners);
        for (let r = 0; r < row; r++) slotHits(r, x - clear, x + clear, x, owners);
        const distinct = [...new Set(owners)];
        if (distinct.some((j) => boxes[j].priority >= boxes[i].priority)) continue;
        if (!best || distinct.length < best.owners.length) best = { row, align, owners: distinct };
      }
    }
    if (!best) continue;
    for (const j of best.owners) remove(j);
    evicted ||= best.owners.length > 0;
    place(i, best.row, best.align);
  }
  // Evicted labels may still fit elsewhere.
  if (evicted) for (const i of order) if (!result[i]) tryPlace(i);
  return result;
}

/** Number of rows actually used by a placement. */
export function rowsUsed(placements: ReadonlyArray<PlacedLabel | null>): number {
  let n = 0;
  for (const p of placements) if (p && p.row + 1 > n) n = p.row + 1;
  return n;
}
