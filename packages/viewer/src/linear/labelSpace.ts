/**
 * Free-space bookkeeping for label placement. The map is cut into horizontal rows (one per
 * lane, plus the free bands beyond the outermost lanes); each row records which x intervals
 * are taken by bars and labels. A label is placed only where its row is free, so labels never
 * overlap bars or each other.
 */

/** Occupied x intervals of one row, kept merged and sorted. */
export class RowOccupancy {
  private readonly ls: number[] = [];
  private readonly rs: number[] = [];

  /** Index of the first interval ending at or after x. */
  private firstEndingAtOrAfter(x: number): number {
    let lo = 0;
    let hi = this.rs.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.rs[mid] >= x) hi = mid;
      else lo = mid + 1;
    }
    return lo;
  }

  /** True if nothing occupies any part of [l, r]. */
  isFree(l: number, r: number): boolean {
    const i = this.firstEndingAtOrAfter(l);
    return i >= this.ls.length || this.ls[i] > r;
  }

  /** Marks [l, r] as occupied. */
  add(l: number, r: number): void {
    if (!(r >= l)) return;
    const i0 = this.firstEndingAtOrAfter(l);
    let i1 = i0;
    let nl = l;
    let nr = r;
    while (i1 < this.ls.length && this.ls[i1] <= r) {
      nl = Math.min(nl, this.ls[i1]);
      nr = Math.max(nr, this.rs[i1]);
      i1++;
    }
    this.ls.splice(i0, i1 - i0, nl);
    this.rs.splice(i0, i1 - i0, nr);
  }

  /** The merged intervals, for tests and debugging. */
  intervals(): Array<[number, number]> {
    return this.ls.map((l, i) => [l, this.rs[i]]);
  }
}

/** Rows of occupancy addressed by key (e.g. 'f:above:0'). */
export class LabelSpace {
  private readonly rows = new Map<string, RowOccupancy>();

  row(key: string): RowOccupancy {
    let r = this.rows.get(key);
    if (!r) {
      r = new RowOccupancy();
      this.rows.set(key, r);
    }
    return r;
  }
}
