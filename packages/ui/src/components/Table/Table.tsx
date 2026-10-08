import {
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type Ref,
} from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { cx } from '../../lib/cx';
import { mergeRefs } from '../../lib/mergeRefs';
import { getPlatform } from '../../lib/platform';
import { useControllableState } from '../../lib/useControllableState';
import { nextSelection, sortRows, type SelectionMode, type SortDirection } from './selection';
import styles from './Table.module.css';

export interface TableColumn<T> {
  key: string;
  header: ReactNode;
  /** Grid track: px number or any CSS track ("minmax(120px, 2fr)"). Default: minmax(0, 1fr). */
  width?: number | string;
  align?: 'start' | 'center' | 'end';
  sortable?: boolean;
  /** Cell content (default: String(row[key])). */
  render?: (row: T, index: number) => ReactNode;
  /** Value used by the built-in sort (default: row[key]). */
  sortValue?: (row: T) => string | number | null | undefined;
  /** Monospaced, tabular cells. */
  mono?: boolean;
}

export interface TableSort {
  key: string;
  direction: SortDirection;
}

export interface TableBodyRenderProps<T> {
  /** Rows in display (sorted) order. */
  rows: readonly T[];
  rowCount: number;
  rowHeight: number;
  headerHeight: number;
  /**
   * Renders the row at display index `index`. Pass `style` to position it, e.g.
   * { position: 'absolute', top: 0, transform: `translateY(${start}px)` }.
   */
  renderRow: (index: number, style?: CSSProperties) => ReactNode;
}

export interface TableProps<T> {
  columns: readonly TableColumn<T>[];
  rows: readonly T[];
  rowKey: (row: T, index: number) => string;
  'aria-label': string;
  /** Current sort (controlled); null = unsorted. */
  sort?: TableSort | null;
  defaultSort?: TableSort | null;
  onSortChange?: (sort: TableSort | null) => void;
  /** The parent sorts `rows` itself (the table only shows the indicator). */
  manualSorting?: boolean;
  /** Default 'single'. */
  selectionMode?: SelectionMode;
  selectedKeys?: readonly string[];
  defaultSelectedKeys?: readonly string[];
  onSelectionChange?: (keys: string[]) => void;
  /** Double-click or Return. */
  onRowActivate?: (row: T, index: number) => void;
  onRowContextMenu?: (row: T, index: number, event: MouseEvent) => void;
  /** Alternating row backgrounds (default true). */
  zebra?: boolean;
  /** Row height in px (default 24). */
  rowHeight?: number;
  /**
   * Custom body rendering, e.g. with @tanstack/react-virtual. Use `scrollRef` as the
   * virtualizer's scroll element and `onScrollToRow` so keyboard navigation can reveal rows.
   */
  renderBody?: (body: TableBodyRenderProps<T>) => ReactNode;
  /** Ref to the scrolling element (needed for external virtualization). */
  scrollRef?: Ref<HTMLDivElement>;
  /** Called when keyboard navigation needs row `index` to be visible (virtualized bodies). */
  onScrollToRow?: (index: number) => void;
  /** Shown when there are no rows. */
  emptyState?: ReactNode;
  className?: string;
  style?: CSSProperties;
}

const HEADER_HEIGHT = 26;

function track(width: number | string | undefined): string {
  if (width === undefined) return 'minmax(0, 1fr)';
  return typeof width === 'number' ? `${width}px` : width;
}

/**
 * Lightweight macOS table: sortable headers, row selection (click, ⌘/Ctrl-click, Shift-click,
 * keyboard), zebra striping, sticky header. Rows render directly, or through `renderBody`
 * for virtualization.
 */
export function Table<T>({
  columns,
  rows,
  rowKey,
  sort: sortProp,
  defaultSort = null,
  onSortChange,
  manualSorting = false,
  selectionMode = 'single',
  selectedKeys,
  defaultSelectedKeys,
  onSelectionChange,
  onRowActivate,
  onRowContextMenu,
  zebra = true,
  rowHeight = 24,
  renderBody,
  scrollRef,
  onScrollToRow,
  emptyState,
  className,
  style,
  'aria-label': ariaLabel,
}: TableProps<T>) {
  const baseId = useId();
  const innerRef = useRef<HTMLDivElement>(null);
  const setScrollRef = useMemo(() => mergeRefs(innerRef, scrollRef), [scrollRef]);
  const [sort, setSort] = useControllableState<TableSort | null>(sortProp, defaultSort, onSortChange);
  const [selected, setSelected] = useControllableState<readonly string[]>(
    selectedKeys,
    () => [...(defaultSelectedKeys ?? [])],
    onSelectionChange ? (keys) => onSelectionChange([...keys]) : undefined,
  );
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [hasFocus, setHasFocus] = useState(false);
  const anchor = useRef<number | null>(null);

  const displayRows = useMemo(() => {
    if (!sort || manualSorting) return rows;
    const col = columns.find((c) => c.key === sort.key);
    if (!col) return rows;
    const value = col.sortValue ?? ((row: T) => (row as Record<string, unknown>)[col.key]);
    return sortRows(rows, value, sort.direction);
  }, [rows, sort, manualSorting, columns]);

  const keys = useMemo(() => displayRows.map((r, i) => rowKey(r, i)), [displayRows, rowKey]);
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const template = columns.map((c) => track(c.width)).join(' ');
  const rowId = (index: number) => `${baseId}-row-${index}`;

  const toggleMod = (e: { metaKey: boolean; ctrlKey: boolean }) => (getPlatform() === 'mac' ? e.metaKey : e.ctrlKey);

  const select = (index: number, mods: { toggle: boolean; range: boolean }) => {
    if (selectionMode === 'none') return;
    const next = nextSelection(selectionMode, selected, keys, index, anchor.current, mods);
    if (!mods.range) anchor.current = index;
    setSelected(next);
  };

  const reveal = (index: number) => {
    if (onScrollToRow) {
      onScrollToRow(index);
      return;
    }
    const el = innerRef.current;
    if (!el) return;
    const top = HEADER_HEIGHT + index * rowHeight;
    const viewTop = el.scrollTop + HEADER_HEIGHT;
    const viewBottom = el.scrollTop + el.clientHeight;
    if (top < viewTop) el.scrollTop = top - HEADER_HEIGHT;
    else if (top + rowHeight > viewBottom) el.scrollTop = top + rowHeight - el.clientHeight;
  };

  const moveTo = (index: number, extend: boolean) => {
    if (displayRows.length === 0) return;
    const i = Math.max(0, Math.min(displayRows.length - 1, index));
    setActiveIndex(i);
    reveal(i);
    select(i, { toggle: false, range: extend && selectionMode === 'multiple' });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const n = displayRows.length;
    if (n === 0) return;
    const current = activeIndex ?? -1;
    const page = Math.max(1, Math.floor(((innerRef.current?.clientHeight ?? 300) - HEADER_HEIGHT) / rowHeight) - 1);
    switch (e.key) {
      case 'ArrowDown':
        moveTo(current + 1, e.shiftKey);
        break;
      case 'ArrowUp':
        moveTo(current < 0 ? n - 1 : current - 1, e.shiftKey);
        break;
      case 'PageDown':
        moveTo(current + page, e.shiftKey);
        break;
      case 'PageUp':
        moveTo(current - page, e.shiftKey);
        break;
      case 'Home':
        moveTo(0, e.shiftKey);
        break;
      case 'End':
        moveTo(n - 1, e.shiftKey);
        break;
      case 'Enter':
        if (activeIndex !== null && onRowActivate) onRowActivate(displayRows[activeIndex], activeIndex);
        break;
      case ' ':
        if (activeIndex !== null) select(activeIndex, { toggle: selectionMode === 'multiple', range: false });
        break;
      case 'a':
      case 'A':
        if (selectionMode === 'multiple' && toggleMod(e)) {
          setSelected([...keys]);
          break;
        }
        return;
      default:
        return;
    }
    e.preventDefault();
  };

  const renderRow = (index: number, rowStyle?: CSSProperties) => {
    const row = displayRows[index];
    if (row === undefined) return null;
    const key = keys[index];
    const isSelected = selectedSet.has(key);
    return (
      <div
        key={key}
        id={rowId(index)}
        role="row"
        aria-rowindex={index + 2}
        aria-selected={selectionMode === 'none' ? undefined : isSelected}
        data-odd={zebra && index % 2 === 1 ? '' : undefined}
        data-active={index === activeIndex ? '' : undefined}
        className={styles.row}
        style={{ gridTemplateColumns: template, height: rowHeight, ...rowStyle }}
        onMouseDown={(e) => {
          if (e.shiftKey) e.preventDefault(); // no text selection on shift-click
        }}
        onClick={(e) => {
          setActiveIndex(index);
          select(index, { toggle: toggleMod(e), range: e.shiftKey });
        }}
        onDoubleClick={() => onRowActivate?.(row, index)}
        onContextMenu={onRowContextMenu ? (e) => onRowContextMenu(row, index, e) : undefined}
      >
        {columns.map((col) => (
          <div
            key={col.key}
            role="gridcell"
            className={cx(styles.cell, col.mono && styles.mono, col.align && styles[col.align])}
          >
            {col.render ? col.render(row, index) : String((row as Record<string, unknown>)[col.key] ?? '')}
          </div>
        ))}
      </div>
    );
  };

  const activeDescendant = hasFocus && activeIndex !== null && activeIndex < displayRows.length ? rowId(activeIndex) : undefined;

  return (
    <div
      ref={setScrollRef}
      role="grid"
      aria-label={ariaLabel}
      aria-rowcount={displayRows.length + 1}
      aria-colcount={columns.length}
      aria-multiselectable={selectionMode === 'multiple' || undefined}
      aria-activedescendant={activeDescendant}
      tabIndex={0}
      className={cx(styles.table, className)}
      style={style}
      onKeyDown={onKeyDown}
      onFocus={() => setHasFocus(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setHasFocus(false);
      }}
    >
      <div role="rowgroup" className={styles.headerGroup}>
        <div role="row" aria-rowindex={1} className={styles.headerRow} style={{ gridTemplateColumns: template, height: HEADER_HEIGHT }}>
          {columns.map((col) => {
            const sorted = sort?.key === col.key ? sort.direction : undefined;
            const content = (
              <>
                <span className={styles.headerText}>{col.header}</span>
                {col.sortable ? (
                  <span className={cx(styles.sortIcon, sorted && styles.sortActive)} aria-hidden>
                    {sorted === 'descending' ? <ChevronDown /> : <ChevronUp />}
                  </span>
                ) : null}
              </>
            );
            return (
              <div
                key={col.key}
                role="columnheader"
                aria-sort={col.sortable ? (sorted ?? 'none') : undefined}
                className={cx(styles.headerCell, col.align && styles[col.align])}
              >
                {col.sortable ? (
                  <button
                    type="button"
                    tabIndex={-1}
                    className={styles.sortButton}
                    onClick={() =>
                      setSort({
                        key: col.key,
                        direction: sorted === 'ascending' ? 'descending' : 'ascending',
                      })
                    }
                  >
                    {content}
                  </button>
                ) : (
                  content
                )}
              </div>
            );
          })}
        </div>
      </div>
      <div role="rowgroup" className={styles.body}>
        {displayRows.length === 0 && emptyState ? (
          <div className={styles.empty}>{emptyState}</div>
        ) : renderBody ? (
          renderBody({ rows: displayRows, rowCount: displayRows.length, rowHeight, headerHeight: HEADER_HEIGHT, renderRow })
        ) : (
          displayRows.map((_, i) => renderRow(i))
        )}
      </div>
    </div>
  );
}
