/**
 * Lane packing for the linear map. Packing happens in bp space, once per record, so lanes are
 * stable while the user zooms and pans (nothing jumps between rows).
 *
 * Intervals follow the core conventions: normalized, and on circular records an interval that
 * crosses the origin has end > length. In the linear map such an interval is drawn as two
 * pieces ([start, L) and [0, end - L)) that must share one lane.
 */

export interface LaneInterval {
  start: number;
  end: number;
}

export interface PackResult {
  /** Lane of each input interval (0 = the lane closest to the backbone). */
  lanes: Int32Array;
  laneCount: number;
}

/**
 * Greedy first-fit packing in order of start position (optimal lane count for interval graphs).
 * Ties are broken longer-first so long features take the inner lanes. Intervals that wrap the
 * origin are placed first: each needs its own lane (they all contain the origin), and the rest
 * of that lane can hold intervals between their two pieces. Touching intervals (a.end ===
 * b.start) share a lane. When `maxLanes` is reached, remaining intervals go to the last lane.
 */
export function packLanes(intervals: readonly LaneInterval[], seqLength: number, maxLanes = Infinity): PackResult {
  const n = intervals.length;
  const lanes = new Int32Array(n);
  // Per lane: the end of the last interval placed by the sweep, and the start of a wrapping
  // interval's tail piece (nothing may extend past it), or +Infinity.
  const laneEnd: number[] = [];
  const laneLimit: number[] = [];

  const order: number[] = [];
  const wrapping: number[] = [];
  for (let i = 0; i < n; i++) {
    if (seqLength > 0 && intervals[i].end > seqLength) wrapping.push(i);
    else order.push(i);
  }
  wrapping.sort((a, b) => intervals[a].start - intervals[b].start);
  for (const i of wrapping) {
    const iv = intervals[i];
    if (laneEnd.length < maxLanes) {
      lanes[i] = laneEnd.length;
      laneEnd.push(iv.end - seqLength);
      laneLimit.push(iv.start);
    } else {
      lanes[i] = laneEnd.length - 1;
    }
  }

  order.sort((a, b) => {
    const A = intervals[a];
    const B = intervals[b];
    return A.start - B.start || B.end - B.start - (A.end - A.start) || a - b;
  });
  for (const i of order) {
    const iv = intervals[i];
    let lane = -1;
    for (let l = 0; l < laneEnd.length; l++) {
      if (laneEnd[l] <= iv.start && iv.end <= laneLimit[l]) {
        lane = l;
        break;
      }
    }
    if (lane < 0) {
      if (laneEnd.length < maxLanes) {
        lane = laneEnd.length;
        laneEnd.push(-Infinity);
        laneLimit.push(Infinity);
      } else {
        lane = laneEnd.length - 1;
      }
    }
    lanes[i] = lane;
    laneEnd[lane] = Math.max(laneEnd[lane], iv.end);
  }
  return { lanes, laneCount: laneEnd.length };
}

/**
 * One drawable piece of an interval inside [0, L]. `ref` points back to the input interval;
 * `piece` is 0 for a non-wrapping interval, 1 for the tail of a wrapping one ([start, L)) and
 * 2 for its head ([0, end - L)).
 */
export interface LaneItem {
  start: number;
  end: number;
  ref: number;
  piece: 0 | 1 | 2;
}

/** Items of one lane sorted by start, plus the running maximum of their ends (for culling). */
export interface Lane {
  items: LaneItem[];
  maxEnd: Float64Array;
}

/** Split intervals into lanes of drawable pieces. */
export function buildLanes(
  intervals: readonly LaneInterval[],
  packed: PackResult,
  seqLength: number,
): Lane[] {
  const buckets: LaneItem[][] = Array.from({ length: packed.laneCount }, () => []);
  for (let i = 0; i < intervals.length; i++) {
    const iv = intervals[i];
    const bucket = buckets[packed.lanes[i]];
    if (seqLength > 0 && iv.end > seqLength) {
      bucket.push({ start: iv.start, end: seqLength, ref: i, piece: 1 });
      bucket.push({ start: 0, end: iv.end - seqLength, ref: i, piece: 2 });
    } else {
      bucket.push({ start: iv.start, end: iv.end, ref: i, piece: 0 });
    }
  }
  return buckets.map((items) => {
    items.sort((a, b) => a.start - b.start || a.end - b.end);
    const maxEnd = new Float64Array(items.length);
    let m = -Infinity;
    for (let k = 0; k < items.length; k++) {
      m = Math.max(m, items[k].end);
      maxEnd[k] = m;
    }
    return { items, maxEnd };
  });
}

/**
 * Index range [i0, i1) of the items that may intersect [from, to): every item outside it is
 * certainly invisible (items inside it can still be invisible when a lane overflowed).
 */
export function visibleSpan(lane: Lane, from: number, to: number): [number, number] {
  const { items, maxEnd } = lane;
  // first index whose running max end exceeds `from`
  let lo = 0;
  let hi = items.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (maxEnd[mid] > from) hi = mid;
    else lo = mid + 1;
  }
  const i0 = lo;
  // first index whose start is >= `to`
  lo = i0;
  hi = items.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (items[mid].start < to) lo = mid + 1;
    else hi = mid;
  }
  return [i0, lo];
}
