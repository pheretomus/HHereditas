/**
 * Pure sizing rules for SplitView (unit-tested).
 *
 * A pane is either FIXED (has a size in px, user-resizable) or FLEXIBLE (shares the space
 * left over). Dragging a divider resizes the fixed pane next to it; the flexible pane(s)
 * absorb the difference and never shrink below their minimum.
 */

export interface PaneConstraint {
  min: number;
  max: number;
  collapsible: boolean;
}

export interface PaneResize {
  /** New size in px; undefined when the pane collapses (its last size is kept for re-expanding). */
  size: number | undefined;
  collapsed: boolean;
}

/**
 * Where a drag or keyboard step wants the pane to be (`desired`, px) → the size it gets.
 * `maxAllowed` is the largest size the neighbours can make room for. Collapsible panes
 * snap closed once dragged below half of their minimum size (macOS behaviour).
 */
export function resolvePaneResize(desired: number, c: PaneConstraint, maxAllowed: number = Infinity): PaneResize {
  if (c.collapsible && desired < c.min / 2) return { size: undefined, collapsed: true };
  const upper = Math.max(c.min, Math.min(c.max, maxAllowed));
  return { size: Math.round(Math.max(c.min, Math.min(upper, desired))), collapsed: false };
}

/**
 * Which pane a divider resizes: the fixed pane before it (grows when the divider moves
 * towards the end), else the fixed pane after it (grows when the divider moves towards
 * the start). null when both neighbours are flexible.
 */
export function dividerTarget(before: { fixed: boolean }, after: { fixed: boolean }): 'before' | 'after' | null {
  if (before.fixed) return 'before';
  if (after.fixed) return 'after';
  return null;
}

/**
 * Largest size the target pane may take: its current size plus whatever the flexible panes
 * can give up without going below their minimum sizes.
 */
export function maxPaneSize(current: number, flexible: readonly { size: number; min: number }[]): number {
  let slack = 0;
  for (const f of flexible) slack += Math.max(0, f.size - f.min);
  return current + slack;
}

/** Size change for a keyboard step on a divider (sign: +1 when the pane is before the divider). */
export function keyboardDelta(key: string, horizontal: boolean, shift: boolean, sign: 1 | -1): number | null {
  const step = shift ? 50 : 10;
  const grow = horizontal ? key === 'ArrowRight' : key === 'ArrowDown';
  const shrink = horizontal ? key === 'ArrowLeft' : key === 'ArrowUp';
  if (grow) return step * sign;
  if (shrink) return -step * sign;
  return null;
}
