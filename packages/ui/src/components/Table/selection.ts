/** Row-selection and sorting rules for Table (pure, unit-tested). */

export type SelectionMode = 'none' | 'single' | 'multiple';

export interface ClickModifiers {
  /** Cmd on macOS, Ctrl elsewhere: toggle one row. */
  toggle: boolean;
  /** Shift: extend from the anchor. */
  range: boolean;
}

/**
 * New selection after clicking (or keyboard-selecting) the row at `index`.
 * `orderedKeys` lists all row keys in display order; `anchor` is the index the range starts from.
 */
export function nextSelection(
  mode: SelectionMode,
  current: readonly string[],
  orderedKeys: readonly string[],
  index: number,
  anchor: number | null,
  mods: ClickModifiers,
): string[] {
  const key = orderedKeys[index];
  if (mode === 'none' || key === undefined) return [...current];
  if (mode === 'single') return [key];
  if (mods.range && anchor !== null) {
    const [a, b] = anchor <= index ? [anchor, index] : [index, anchor];
    const range = orderedKeys.slice(a, b + 1);
    if (!mods.toggle) return range;
    const set = new Set(current);
    for (const k of range) set.add(k);
    return orderedKeys.filter((k) => set.has(k));
  }
  if (mods.toggle) {
    return current.includes(key) ? current.filter((k) => k !== key) : [...current, key];
  }
  return [key];
}

export type SortDirection = 'ascending' | 'descending';

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

/** Compare two cell values: numbers numerically, strings naturally ("pUC8" < "pUC19"), empties last. */
export function compareValues(a: unknown, b: unknown): number {
  const emptyA = a === null || a === undefined || a === '';
  const emptyB = b === null || b === undefined || b === '';
  if (emptyA || emptyB) return emptyA === emptyB ? 0 : emptyA ? 1 : -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return collator.compare(String(a), String(b));
}

/** Stable sort of `rows` by `value(row)`; descending keeps empties last. */
export function sortRows<T>(rows: readonly T[], value: (row: T) => unknown, direction: SortDirection): T[] {
  const indexed = rows.map((row, i) => ({ row, i, v: value(row) }));
  indexed.sort((x, y) => {
    const emptyX = x.v === null || x.v === undefined || x.v === '';
    const emptyY = y.v === null || y.v === undefined || y.v === '';
    if (emptyX !== emptyY) return emptyX ? 1 : -1;
    const c = compareValues(x.v, y.v);
    return (direction === 'ascending' ? c : -c) || x.i - y.i;
  });
  return indexed.map((x) => x.row);
}
