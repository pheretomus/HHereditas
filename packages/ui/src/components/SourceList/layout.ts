/**
 * Row layout for the virtualized SourceList: flattens sections into absolutely positioned
 * rows (section headers, items, "empty" placeholders) and finds the rows inside a viewport.
 * Pure functions, unit-tested.
 */

/** Minimal shape needed for layout (the component's sections satisfy it). */
export interface LayoutSection {
  id: string;
  title?: string;
  collapsible?: boolean;
  emptyText?: string;
  items: readonly { id: string }[];
}

export type SourceListRow =
  | { kind: 'header'; key: string; sectionIndex: number; top: number; height: number; gap: number; expanded: boolean }
  | { kind: 'item'; key: string; sectionIndex: number; itemIndex: number; top: number; height: number }
  | { kind: 'empty'; key: string; sectionIndex: number; top: number; height: number };

export interface SourceListMetrics {
  rowHeight: number;
  headerHeight: number;
  /** Extra space above every section header except the first. */
  sectionGap: number;
  paddingTop: number;
  paddingBottom: number;
}

export const DEFAULT_METRICS: SourceListMetrics = {
  rowHeight: 28,
  headerHeight: 28,
  sectionGap: 10,
  paddingTop: 4,
  paddingBottom: 12,
};

export const headerKey = (sectionId: string) => `h:${sectionId}`;
export const itemKey = (itemId: string) => `i:${itemId}`;

/** True when a section can be collapsed (it needs a visible header). */
export function isCollapsible(section: LayoutSection): boolean {
  return !!section.title && section.collapsible !== false;
}

export function buildSourceListRows(
  sections: readonly LayoutSection[],
  collapsed: ReadonlySet<string>,
  metrics: SourceListMetrics = DEFAULT_METRICS,
): { rows: SourceListRow[]; height: number } {
  const rows: SourceListRow[] = [];
  let y = metrics.paddingTop;
  sections.forEach((section, sectionIndex) => {
    const expanded = !(isCollapsible(section) && collapsed.has(section.id));
    if (section.title) {
      const gap = rows.length > 0 ? metrics.sectionGap : 0;
      const height = metrics.headerHeight + gap;
      rows.push({ kind: 'header', key: headerKey(section.id), sectionIndex, top: y, height, gap, expanded });
      y += height;
    } else if (rows.length > 0) {
      y += metrics.sectionGap;
    }
    if (!expanded) return;
    if (section.items.length === 0) {
      if (section.emptyText) {
        rows.push({ kind: 'empty', key: `e:${section.id}`, sectionIndex, top: y, height: metrics.rowHeight });
        y += metrics.rowHeight;
      }
      return;
    }
    section.items.forEach((item, itemIndex) => {
      rows.push({ kind: 'item', key: itemKey(item.id), sectionIndex, itemIndex, top: y, height: metrics.rowHeight });
      y += metrics.rowHeight;
    });
  });
  return { rows, height: y + metrics.paddingBottom };
}

/**
 * Index range [start, end) of the rows that intersect [scrollTop - overscan, scrollTop + viewport + overscan].
 * Rows must be sorted by `top` (as produced by buildSourceListRows).
 */
export function visibleRowRange(
  rows: readonly { top: number; height: number }[],
  scrollTop: number,
  viewport: number,
  overscan = 0,
): [number, number] {
  const from = scrollTop - overscan;
  const to = scrollTop + viewport + overscan;
  // first row whose bottom edge is below `from`
  let lo = 0;
  let hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (rows[mid].top + rows[mid].height <= from) lo = mid + 1;
    else hi = mid;
  }
  let end = lo;
  while (end < rows.length && rows[end].top < to) end++;
  return [lo, end];
}

/** New scrollTop that brings [top, top + height) fully into view (unchanged if already visible). */
export function scrollToReveal(scrollTop: number, viewport: number, top: number, height: number, margin = 4): number {
  if (top - margin < scrollTop) return Math.max(0, top - margin);
  if (top + height + margin > scrollTop + viewport) return top + height + margin - viewport;
  return scrollTop;
}
