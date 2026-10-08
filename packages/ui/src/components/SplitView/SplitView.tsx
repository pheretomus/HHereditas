import {
  Children,
  isValidElement,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import { cx } from '../../lib/cx';
import { dividerTarget, keyboardDelta, maxPaneSize, resolvePaneResize } from './layout';
import styles from './SplitView.module.css';

export interface SplitPaneProps {
  /** Stable id (unique within the SplitView). */
  id: string;
  children?: ReactNode;
  /**
   * Size in px along the split axis (controlled). Panes with `size` or `defaultSize` are
   * FIXED and user-resizable; panes with neither are FLEXIBLE and fill the remaining space.
   */
  size?: number;
  defaultSize?: number;
  /** Called while the user drags a divider or uses the arrow keys on it. */
  onSizeChange?: (size: number) => void;
  minSize?: number;
  maxSize?: number;
  /** The pane can be collapsed (dragged closed, double-click / Return on its divider). */
  collapsible?: boolean;
  collapsed?: boolean;
  defaultCollapsed?: boolean;
  onCollapsedChange?: (collapsed: boolean) => void;
  /** Keep children mounted (hidden) while collapsed. Default true. */
  keepMounted?: boolean;
  /** Name used for the divider ("Resize Sidebar"). */
  label?: string;
  className?: string;
  style?: CSSProperties;
}

/** Declares a pane of a SplitView. Must be a direct child of SplitView. */
export function SplitPane(_props: SplitPaneProps): null {
  return null;
}

export interface SplitViewProps {
  /** horizontal: panes side by side (vertical dividers); vertical: panes stacked. */
  orientation?: 'horizontal' | 'vertical';
  /** SplitPane elements. */
  children: ReactNode;
  /** Animate collapsing and expanding (default true). */
  animated?: boolean;
  className?: string;
  style?: CSSProperties;
}

interface ResolvedPane {
  props: SplitPaneProps;
  id: string;
  domId: string;
  fixed: boolean;
  size: number;
  min: number;
  max: number;
  collapsible: boolean;
  collapsed: boolean;
}

interface DragState {
  pointerId: number;
  targetIndex: number;
  sign: 1 | -1;
  startPos: number;
  startSize: number;
  maxAllowed: number;
}

/**
 * Resizable panes separated by hairline dividers: sidebar | content | inspector, or map
 * above sequence. Dividers are keyboard accessible (window-splitter pattern): arrow keys
 * resize (Shift = larger steps), Home/End go to min/max, Return toggles collapse.
 */
export function SplitView({ orientation = 'horizontal', children, animated = true, className, style }: SplitViewProps) {
  const horizontal = orientation === 'horizontal';
  const baseId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const [sizes, setSizes] = useState<Record<string, number>>({});
  const [collapsedState, setCollapsedState] = useState<Record<string, boolean>>({});
  const [dragging, setDragging] = useState<number | null>(null);
  const drag = useRef<DragState | null>(null);

  const elements = Children.toArray(children).filter(
    (c): c is ReactElement<SplitPaneProps> => isValidElement(c) && c.type === SplitPane,
  );
  const panes: ResolvedPane[] = elements.map((el) => {
    const p = el.props;
    const fixed = p.size !== undefined || p.defaultSize !== undefined;
    return {
      props: p,
      id: p.id,
      domId: `${baseId}-pane-${p.id}`,
      fixed,
      size: p.size ?? sizes[p.id] ?? p.defaultSize ?? 0,
      min: p.minSize ?? 0,
      max: p.maxSize ?? Infinity,
      collapsible: !!p.collapsible,
      collapsed: p.collapsed ?? collapsedState[p.id] ?? !!p.defaultCollapsed,
    };
  });

  const setPaneSize = (pane: ResolvedPane, size: number) => {
    if (size === pane.size) return;
    if (pane.props.size === undefined) setSizes((s) => ({ ...s, [pane.id]: size }));
    pane.props.onSizeChange?.(size);
  };
  const setPaneCollapsed = (pane: ResolvedPane, collapsed: boolean) => {
    if (collapsed === pane.collapsed) return;
    if (pane.props.collapsed === undefined) setCollapsedState((s) => ({ ...s, [pane.id]: collapsed }));
    pane.props.onCollapsedChange?.(collapsed);
  };

  const extent = (el: Element | null) => {
    if (!el) return 0;
    const r = el.getBoundingClientRect();
    return horizontal ? r.width : r.height;
  };
  const paneEl = (pane: ResolvedPane) => document.getElementById(pane.domId);

  /** Current max size for a target pane, from the live layout. */
  const maxFor = (targetIndex: number) => {
    const target = panes[targetIndex];
    const current = target.collapsed ? 0 : extent(paneEl(target));
    const flexible = panes
      .filter((p, i) => i !== targetIndex && !p.fixed && !p.collapsed)
      .map((p) => ({ size: extent(paneEl(p)), min: p.min }));
    return { current, max: maxPaneSize(current, flexible) };
  };

  const applyDesired = (targetIndex: number, desired: number, maxAllowed: number) => {
    const target = panes[targetIndex];
    const r = resolvePaneResize(desired, target, maxAllowed);
    if (r.collapsed) {
      setPaneCollapsed(target, true);
      return;
    }
    if (target.collapsed) setPaneCollapsed(target, false);
    if (r.size !== undefined) setPaneSize(target, r.size);
  };

  const targetOf = (dividerIndex: number): { index: number; sign: 1 | -1 } | null => {
    const before = panes[dividerIndex - 1];
    const after = panes[dividerIndex];
    const which = dividerTarget(before, after);
    if (which === 'before') return { index: dividerIndex - 1, sign: 1 };
    if (which === 'after') return { index: dividerIndex, sign: -1 };
    return null;
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>, dividerIndex: number) => {
    if (e.button !== 0) return;
    const t = targetOf(dividerIndex);
    if (!t) return;
    const { current, max } = maxFor(t.index);
    drag.current = {
      pointerId: e.pointerId,
      targetIndex: t.index,
      sign: t.sign,
      startPos: horizontal ? e.clientX : e.clientY,
      startSize: current,
      maxAllowed: max,
    };
    e.currentTarget.setPointerCapture?.(e.pointerId);
    document.documentElement.classList.add(horizontal ? 'hh-split-resizing-x' : 'hh-split-resizing-y');
    setDragging(dividerIndex);
    e.preventDefault();
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointerId) return;
    const pos = horizontal ? e.clientX : e.clientY;
    applyDesired(d.targetIndex, d.startSize + d.sign * (pos - d.startPos), d.maxAllowed);
  };

  const endDrag = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointerId) return;
    drag.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    document.documentElement.classList.remove('hh-split-resizing-x', 'hh-split-resizing-y');
    setDragging(null);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>, dividerIndex: number) => {
    const t = targetOf(dividerIndex);
    if (!t) return;
    const target = panes[t.index];
    if (e.key === 'Enter') {
      if (target.collapsible) setPaneCollapsed(target, !target.collapsed);
      e.preventDefault();
      return;
    }
    const { current, max } = maxFor(t.index);
    if (e.key === 'Home') {
      applyDesired(t.index, target.min, max);
      e.preventDefault();
      return;
    }
    if (e.key === 'End') {
      applyDesired(t.index, Math.min(target.max, max), max);
      e.preventDefault();
      return;
    }
    const delta = keyboardDelta(e.key, horizontal, e.shiftKey, t.sign);
    if (delta === null) return;
    // Arrow keys never collapse; they stop at the minimum size.
    const desired = Math.max(target.min, (target.collapsed ? 0 : current) + delta);
    applyDesired(t.index, desired, max);
    e.preventDefault();
  };

  const firstFlexible = panes.findIndex((p) => !p.fixed);
  const out: ReactNode[] = [];
  panes.forEach((pane, i) => {
    if (i > 0) {
      const t = targetOf(i);
      const target = t ? panes[t.index] : undefined;
      const interactive = !!target && !panes[i - 1].collapsed && !panes[i].collapsed;
      const isDragging = dragging === i;
      out.push(
        <div
          key={`divider-${pane.id}`}
          role="separator"
          aria-orientation={horizontal ? 'vertical' : 'horizontal'}
          aria-label={target ? `Resize ${target.props.label ?? target.id}` : undefined}
          aria-controls={target?.domId}
          aria-valuenow={target ? Math.round(target.collapsed ? 0 : target.size) : undefined}
          aria-valuemin={target ? Math.round(target.min) : undefined}
          aria-valuemax={target && Number.isFinite(target.max) ? Math.round(target.max) : undefined}
          tabIndex={interactive ? 0 : -1}
          data-inert={!interactive && !isDragging ? '' : undefined}
          data-static={!target ? '' : undefined}
          data-dragging={isDragging ? '' : undefined}
          className={styles.divider}
          onPointerDown={interactive ? (e) => onPointerDown(e, i) : undefined}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onLostPointerCapture={endDrag}
          onKeyDown={interactive ? (e) => onKeyDown(e, i) : undefined}
          onDoubleClick={
            interactive && target?.collapsible ? () => setPaneCollapsed(target, !target.collapsed) : undefined
          }
        />,
      );
    }
    const dimStyle: CSSProperties = pane.collapsed
      ? { flex: '0 0 0px' }
      : pane.fixed
        ? {
            flex: `0 1 ${pane.size}px`,
            [horizontal ? 'minWidth' : 'minHeight']: pane.min,
            [horizontal ? 'maxWidth' : 'maxHeight']: Number.isFinite(pane.max) ? pane.max : undefined,
          }
        : { flex: '1 1 0px', [horizontal ? 'minWidth' : 'minHeight']: pane.min };
    // Fixed panes keep their content at full size while animating closed (no reflow), and
    // slide towards the outer edge of the window.
    const innerStyle: CSSProperties | undefined = pane.fixed
      ? { [horizontal ? 'width' : 'height']: `max(100%, ${Math.max(pane.size, pane.min)}px)` }
      : undefined;
    const keep = pane.props.keepMounted ?? true;
    out.push(
      <div
        key={`pane-${pane.id}`}
        id={pane.domId}
        data-split-pane={pane.id}
        data-collapsed={pane.collapsed ? '' : undefined}
        data-leading={pane.fixed && firstFlexible >= 0 && i < firstFlexible ? '' : undefined}
        className={cx(styles.pane, pane.props.className)}
        style={{ ...dimStyle, ...pane.props.style }}
        aria-hidden={pane.collapsed || undefined}
      >
        <div className={styles.paneInner} style={innerStyle}>
          {pane.collapsed && !keep ? null : pane.props.children}
        </div>
      </div>,
    );
  });

  return (
    <div
      ref={rootRef}
      className={cx(styles.root, horizontal ? styles.horizontal : styles.vertical, className)}
      data-animated={animated && dragging === null ? '' : undefined}
      style={style}
    >
      {out}
    </div>
  );
}
