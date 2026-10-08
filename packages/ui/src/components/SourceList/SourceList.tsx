import {
  useCallback,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { ChevronRight } from 'lucide-react';
import { cx } from '../../lib/cx';
import { useControllableState } from '../../lib/useControllableState';
import {
  DEFAULT_METRICS,
  buildSourceListRows,
  headerKey,
  isCollapsible,
  itemKey,
  scrollToReveal,
  visibleRowRange,
  type SourceListRow,
} from './layout';
import styles from './SourceList.module.css';

export interface SourceListItem {
  /** Unique across ALL sections of the list (prefix ids if needed, e.g. "feature:f12"). */
  id: string;
  /** Row text; also used for type-ahead and the accessible name. */
  label: string;
  /** Accessible name when it should say more than the label (e.g. "pUC19, edited"). */
  accessibleLabel?: string;
  /** 16 px leading icon or glyph. Generic (currentColor) icons are tinted with the accent colour. */
  icon?: ReactNode;
  /** Dim, right-aligned detail text (e.g. "861 bp"). */
  secondary?: ReactNode;
  /** Trailing count, badge or accessory. */
  trailing?: ReactNode;
  /**
   * Small pointer controls (e.g. a close button) shown at the trailing edge while the row is
   * hovered; they replace `trailing` while visible. Clicks on them do not select the row.
   * Give them tabIndex={-1}: the list is one Tab stop, and keyboard users act on rows with
   * shortcuts or a context menu.
   */
  actions?: ReactNode;
  disabled?: boolean;
  /** Native tooltip, e.g. the full name when the label is truncated. */
  title?: string;
}

export interface SourceListSection {
  id: string;
  /** Section header text. Sections without a title have no header and cannot collapse. */
  title?: string;
  /** Shown at the end of the header (e.g. the number of items). */
  count?: ReactNode;
  items: readonly SourceListItem[];
  /** Default true for titled sections. */
  collapsible?: boolean;
  /** Placeholder row shown when the section has no items (e.g. "No primers"). */
  emptyText?: string;
  /**
   * Tint of generic (currentColor) row icons: 'accent' (default, like macOS sidebars) or
   * 'secondary' for long lists where blue icons would be noisy.
   */
  iconTone?: 'accent' | 'secondary';
}

export interface SourceListProps {
  sections: readonly SourceListSection[];
  /** Accessible name, e.g. "Sidebar". */
  'aria-label': string;
  /** Id of the selected item (single selection). */
  selectedId?: string | null;
  /** Click, or keyboard navigation (selection follows focus, as in macOS sidebars). */
  onSelect?: (item: SourceListItem, section: SourceListSection) => void;
  /** Double-click or Return on an item. */
  onActivate?: (item: SourceListItem, section: SourceListSection) => void;
  /** Collapsed section ids (controlled). */
  collapsedSections?: readonly string[];
  defaultCollapsedSections?: readonly string[];
  onCollapsedSectionsChange?: (sectionIds: string[]) => void;
  /**
   * Selection style. Default (undefined): emphasized (accent) while the list has keyboard
   * focus, neutral grey otherwise, like macOS. true/false force a style (e.g. false while
   * the window is inactive).
   */
  emphasized?: boolean;
  /** Right-click on an item (use it to show a ContextMenu for that item). */
  onItemContextMenu?: (item: SourceListItem, section: SourceListSection, event: MouseEvent) => void;
  /** Row height in px (default 28). */
  rowHeight?: number;
  /** Scroll the selected item into view when `selectedId` changes (default true). */
  revealSelection?: boolean;
  className?: string;
  style?: CSSProperties;
  id?: string;
}

const OVERSCAN_PX = 280;
/** Used before the first measurement (and in test environments without layout). */
const FALLBACK_VIEWPORT = 800;
const TYPEAHEAD_RESET_MS = 700;

/**
 * macOS source list (sidebar): titled, collapsible sections of rows with an icon, label,
 * secondary text and a trailing count. Virtualized, so sections may hold thousands of rows.
 *
 * Keyboard (tree pattern): ↑/↓ move (and select), ←/→ collapse/expand or jump between a
 * section and its rows, Home/End, Page Up/Down, Return activates, Space selects/toggles,
 * typing jumps to the next matching label.
 */
export function SourceList({
  sections,
  selectedId = null,
  onSelect,
  onActivate,
  collapsedSections,
  defaultCollapsedSections,
  onCollapsedSectionsChange,
  emphasized,
  onItemContextMenu,
  rowHeight = DEFAULT_METRICS.rowHeight,
  revealSelection = true,
  className,
  style,
  id,
  'aria-label': ariaLabel,
}: SourceListProps) {
  const [collapsedList, setCollapsedList] = useControllableState<readonly string[]>(
    collapsedSections,
    () => [...(defaultCollapsedSections ?? [])],
    onCollapsedSectionsChange ? (ids) => onCollapsedSectionsChange([...ids]) : undefined,
  );
  const collapsed = useMemo(() => new Set(collapsedList), [collapsedList]);
  const metrics = useMemo(() => ({ ...DEFAULT_METRICS, rowHeight }), [rowHeight]);
  const { rows, height } = useMemo(() => buildSourceListRows(sections, collapsed, metrics), [sections, collapsed, metrics]);
  const indexByKey = useMemo(() => {
    const m = new Map<string, number>();
    rows.forEach((r, i) => m.set(r.key, i));
    return m;
  }, [rows]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(0);
  /** Keyboard-focused row (aria-activedescendant); remembers its section for fallbacks. */
  const [active, setActive] = useState<{ key: string; sectionId: string } | null>(null);
  const [hasFocus, setHasFocus] = useState(false);
  const typeahead = useRef({ text: '', time: 0 });
  const pointerFocus = useRef(false);
  const baseId = useId();
  const rowId = (key: string) => `${baseId}-${key}`;

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    setViewport(el.clientHeight);
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setViewport(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const viewportHeight = viewport > 0 ? viewport : FALLBACK_VIEWPORT;

  const toggleSection = useCallback(
    (sectionId: string) => {
      const next = collapsed.has(sectionId)
        ? collapsedList.filter((x) => x !== sectionId)
        : [...collapsedList, sectionId];
      setCollapsedList(next);
    },
    [collapsed, collapsedList, setCollapsedList],
  );

  const reveal = useCallback(
    (row: SourceListRow) => {
      const el = scrollRef.current;
      if (!el) return;
      const top = row.kind === 'header' ? row.top + row.gap : row.top;
      const h = row.kind === 'header' ? row.height - row.gap : row.height;
      const next = scrollToReveal(el.scrollTop, el.clientHeight || viewportHeight, top, h);
      if (next !== el.scrollTop) {
        el.scrollTop = next;
        setScrollTop(el.scrollTop);
      }
    },
    [viewportHeight],
  );

  // Reveal the selected item when the selection changes from outside (e.g. clicking the map).
  const lastRevealed = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (!revealSelection || !selectedId || lastRevealed.current === selectedId) return;
    const idx = indexByKey.get(itemKey(selectedId));
    if (idx === undefined) return;
    lastRevealed.current = selectedId;
    reveal(rows[idx]);
  }, [selectedId, indexByKey, rows, reveal, revealSelection]);

  const navigable = useMemo(() => {
    const out: number[] = [];
    rows.forEach((r, i) => {
      if (r.kind === 'header') {
        if (isCollapsible(sections[r.sectionIndex])) out.push(i);
      } else if (r.kind === 'item') {
        if (!sections[r.sectionIndex].items[r.itemIndex].disabled) out.push(i);
      }
    });
    return out;
  }, [rows, sections]);

  // The active row stays valid when its section collapses (falls back to the header).
  const activeIndex =
    active === null ? undefined : (indexByKey.get(active.key) ?? indexByKey.get(headerKey(active.sectionId)));

  const itemOf = (row: SourceListRow) =>
    row.kind === 'item' ? sections[row.sectionIndex].items[row.itemIndex] : undefined;

  const activate = (row: SourceListRow) => setActive({ key: row.key, sectionId: sections[row.sectionIndex].id });

  const focusRow = (index: number, select: boolean) => {
    const row = rows[index];
    if (!row) return;
    activate(row);
    reveal(row);
    const item = itemOf(row);
    if (select && item && !item.disabled) onSelect?.(item, sections[row.sectionIndex]);
  };

  const moveBy = (delta: number) => {
    if (navigable.length === 0) return;
    let pos: number;
    if (activeIndex === undefined) pos = delta > 0 ? -1 : navigable.length;
    else {
      // position of the active row among navigable rows, or the gap where it would be
      let lo = 0;
      let hi = navigable.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (navigable[mid] < activeIndex) lo = mid + 1;
        else hi = mid;
      }
      pos = navigable[lo] === activeIndex ? lo : delta > 0 ? lo - 1 : lo;
    }
    focusRow(navigable[Math.max(0, Math.min(navigable.length - 1, pos + delta))], true);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const row = activeIndex !== undefined ? rows[activeIndex] : undefined;
    const section = row ? sections[row.sectionIndex] : undefined;
    const pageRows = Math.max(1, Math.floor(viewportHeight / rowHeight) - 1);
    switch (e.key) {
      case 'ArrowDown':
        moveBy(1);
        break;
      case 'ArrowUp':
        moveBy(-1);
        break;
      case 'PageDown':
        moveBy(pageRows);
        break;
      case 'PageUp':
        moveBy(-pageRows);
        break;
      case 'Home':
        if (navigable.length) focusRow(navigable[0], true);
        break;
      case 'End':
        if (navigable.length) focusRow(navigable[navigable.length - 1], true);
        break;
      case 'ArrowRight':
        if (row?.kind === 'header' && section) {
          if (!row.expanded) toggleSection(section.id);
          else moveBy(1);
        }
        break;
      case 'ArrowLeft':
        if (row?.kind === 'header' && section) {
          if (row.expanded && isCollapsible(section)) toggleSection(section.id);
        } else if (row && section && isCollapsible(section)) {
          const h = indexByKey.get(headerKey(section.id));
          if (h !== undefined) focusRow(h, false);
        }
        break;
      case 'Enter':
        if (row?.kind === 'header' && section) toggleSection(section.id);
        else if (row && section) {
          const item = itemOf(row);
          if (item && !item.disabled) onActivate?.(item, section);
        }
        break;
      case ' ':
        if (row?.kind === 'header' && section) toggleSection(section.id);
        else if (row && section) {
          const item = itemOf(row);
          if (item && !item.disabled) onSelect?.(item, section);
        }
        break;
      default: {
        if (e.key.length !== 1 || e.key === ' ') return;
        const now = performance.now();
        const t = typeahead.current;
        t.text = now - t.time > TYPEAHEAD_RESET_MS ? e.key.toLowerCase() : t.text + e.key.toLowerCase();
        t.time = now;
        const n = rows.length;
        const from = activeIndex === undefined ? 0 : t.text.length === 1 ? activeIndex + 1 : activeIndex;
        for (let k = 0; k < n; k++) {
          const i = (from + k) % n;
          const item = itemOf(rows[i]);
          if (item && !item.disabled && item.label.toLowerCase().startsWith(t.text)) {
            focusRow(i, true);
            break;
          }
        }
        break;
      }
    }
    e.preventDefault();
  };

  const onFocus = (e: FocusEvent<HTMLDivElement>) => {
    setHasFocus(true);
    // Focus from a click: the click itself picks the row; never scroll under the pointer.
    if (pointerFocus.current || e.target !== e.currentTarget) return;
    if (activeIndex !== undefined) return;
    const sel = selectedId ? indexByKey.get(itemKey(selectedId)) : undefined;
    const first = sel ?? navigable[0];
    if (first !== undefined) {
      activate(rows[first]);
      reveal(rows[first]);
    }
  };

  const [start, end] = visibleRowRange(rows, scrollTop, viewportHeight, OVERSCAN_PX);
  const rendered: number[] = [];
  for (let i = start; i < end; i++) rendered.push(i);
  // Keep the active row mounted so aria-activedescendant always points at an element.
  if (activeIndex !== undefined && (activeIndex < start || activeIndex >= end)) rendered.push(activeIndex);

  const emphasis = emphasized === undefined ? 'auto' : emphasized ? 'on' : 'off';
  const activeDescendant = hasFocus && activeIndex !== undefined ? rowId(rows[activeIndex].key) : undefined;

  return (
    <div
      ref={scrollRef}
      id={id}
      role="tree"
      aria-label={ariaLabel}
      aria-activedescendant={activeDescendant}
      tabIndex={0}
      data-emphasis={emphasis}
      className={cx(styles.root, className)}
      style={style}
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      onKeyDown={onKeyDown}
      onPointerDown={() => {
        pointerFocus.current = true;
      }}
      onPointerUp={() => {
        pointerFocus.current = false;
      }}
      onPointerCancel={() => {
        pointerFocus.current = false;
      }}
      onFocus={onFocus}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setHasFocus(false);
      }}
    >
      <div className={styles.canvas} style={{ height }} role="presentation">
        {rendered.map((index) => {
          const row = rows[index];
          const section = sections[row.sectionIndex];
          const active = index === activeIndex;
          if (row.kind === 'header') {
            const collapsible = isCollapsible(section);
            return (
              <div
                key={row.key}
                id={rowId(row.key)}
                role="treeitem"
                aria-level={1}
                aria-expanded={collapsible ? row.expanded : undefined}
                aria-label={section.title}
                data-active={active || undefined}
                className={cx(styles.header, collapsible && styles.headerCollapsible)}
                style={{ top: row.top + row.gap, height: row.height - row.gap }}
                onClick={() => {
                  activate(row);
                  if (collapsible) toggleSection(section.id);
                }}
              >
                <span className={styles.headerTitle}>{section.title}</span>
                {section.count != null ? <span className={styles.headerCount}>{section.count}</span> : null}
                <span className={styles.headerFill} />
                {collapsible ? <ChevronRight className={styles.chevron} aria-hidden /> : null}
              </div>
            );
          }
          if (row.kind === 'empty') {
            return (
              <div key={row.key} role="none" className={styles.empty} style={{ top: row.top, height: row.height }}>
                {section.emptyText}
              </div>
            );
          }
          const item = section.items[row.itemIndex];
          const selected = item.id === selectedId;
          return (
            <div
              key={row.key}
              id={rowId(row.key)}
              role="treeitem"
              aria-level={section.title ? 2 : 1}
              aria-selected={selected}
              aria-disabled={item.disabled || undefined}
              aria-setsize={section.items.length}
              aria-posinset={row.itemIndex + 1}
              aria-label={item.accessibleLabel ?? item.label}
              title={item.title}
              data-active={active || undefined}
              data-icon-tone={section.iconTone === 'secondary' ? 'secondary' : undefined}
              className={styles.item}
              style={{ top: row.top, height: row.height }}
              onClick={() => {
                activate(row);
                if (!item.disabled) onSelect?.(item, section);
              }}
              onDoubleClick={() => {
                if (!item.disabled) onActivate?.(item, section);
              }}
              onContextMenu={onItemContextMenu ? (e) => onItemContextMenu(item, section, e) : undefined}
            >
              {item.icon ? (
                <span className={styles.icon} aria-hidden>
                  {item.icon}
                </span>
              ) : null}
              <span className={styles.label}>{item.label}</span>
              {item.secondary != null ? <span className={styles.secondary}>{item.secondary}</span> : null}
              {item.trailing != null ? (
                <span className={cx(styles.trailing, item.actions != null && styles.hasActions)}>{item.trailing}</span>
              ) : null}
              {item.actions != null ? (
                <span
                  className={styles.actions}
                  onClick={(e) => e.stopPropagation()}
                  onDoubleClick={(e) => e.stopPropagation()}
                  onPointerDown={(e) => e.stopPropagation()}
                >
                  {item.actions}
                </span>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
