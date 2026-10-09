import { useMemo, useState, type MouseEvent } from 'react';
import { Scissors, X } from 'lucide-react';
import type { EnzymeSite, SeqRecord } from '@hhereditas/core';
import { formatInt } from '@hhereditas/viewer';
import {
  EmptyState,
  SearchField,
  SourceList,
  buildSourceListRows,
  cx,
  useControllableState,
  type SourceListItem,
  type SourceListSection,
} from '@hhereditas/ui';
import { formatCompactLength, formatLength } from './format';
import { DocumentGlyph, FeatureGlyph, PrimerGlyph } from './glyphs';
import { enzymeRows, featureRows, matchesFilter, primerRows } from './sidebarModel';
import type { DocumentSummary, SidebarItemRef } from './types';
import styles from './Sidebar.module.css';

/** Collapsible annotation sections of the sidebar. */
export type SidebarSectionId = 'features' | 'primers' | 'enzymes';

export interface SidebarProps {
  /** Open documents, listed at the top. */
  documents: readonly DocumentSummary[];
  activeDocumentId?: string | null;
  /** A document row was clicked (or chosen with the keyboard). */
  onActivateDocument?: (id: string) => void;
  /** Shows a close button on hovered document rows. */
  onCloseDocument?: (id: string) => void;
  /** The active document, whose features and primers are listed. Null when none is open. */
  record?: Pick<SeqRecord, 'features' | 'primers' | 'seq' | 'topology'> | null;
  /** Restriction sites currently displayed; listed grouped by enzyme with site counts. */
  enzymeSites?: readonly EnzymeSite[];
  /** The selected annotation (highlighted row). */
  selectedItem?: SidebarItemRef | null;
  onSelectItem?: (item: SidebarItemRef) => void;
  /** Double-click or Return on an annotation (e.g. zoom to it). */
  onActivateItem?: (item: SidebarItemRef) => void;
  /**
   * Right-click on an annotation. Wrap the Sidebar in a ContextMenu (its trigger receives the
   * same event) and remember the item here to build the menu for it.
   */
  onItemContextMenu?: (item: SidebarItemRef, event: MouseEvent) => void;
  /** The annotation whose context menu is open (outlined); null once the menu closes. */
  contextMenuItem?: SidebarItemRef | null;
  /** Collapsed annotation sections (controlled). */
  collapsedSections?: readonly SidebarSectionId[];
  defaultCollapsedSections?: readonly SidebarSectionId[];
  onCollapsedSectionsChange?: (sections: SidebarSectionId[]) => void;
  /** Filter text for the annotation list (controlled); omit to keep it internal. */
  filter?: string;
  onFilterChange?: (filter: string) => void;
  /**
   * Selection style: undefined = accent while the list has focus (macOS default);
   * false while the window is inactive.
   */
  emphasized?: boolean;
  className?: string;
}

const DOCUMENTS_MAX_ROWS = 6;
const NO_SECTIONS: readonly string[] = [];

const refKey = (ref: SidebarItemRef) => `${ref.kind}:${ref.id}`;

function parseKey(key: string): SidebarItemRef | null {
  const i = key.indexOf(':');
  const kind = key.slice(0, i);
  if (kind !== 'feature' && kind !== 'primer' && kind !== 'enzyme') return null;
  return { kind, id: key.slice(i + 1) };
}

function cutsTitle(name: string, cuts: readonly number[], count: number): string {
  if (count === 1 && cuts.length > 0) return `${name} cuts once, at ${formatInt(cuts[0])}`;
  const shown = cuts.slice(0, 8).map(formatInt).join(', ');
  return `${name}: ${count} sites${shown ? ` (cuts at ${shown}${cuts.length > 8 ? ', …' : ''})` : ''}`;
}

/**
 * Source-list sidebar: the open documents, then the active document's Features, Primers
 * and Enzymes in collapsible sections with counts, and a filter field at the bottom.
 * Feature rows show a swatch shaped like the feature's arrow (colour + strand).
 */
export function Sidebar({
  documents,
  activeDocumentId = null,
  onActivateDocument,
  onCloseDocument,
  record,
  enzymeSites,
  selectedItem = null,
  onSelectItem,
  onActivateItem,
  onItemContextMenu,
  contextMenuItem = null,
  collapsedSections,
  defaultCollapsedSections,
  onCollapsedSectionsChange,
  filter,
  onFilterChange,
  emphasized,
  className,
}: SidebarProps) {
  const [query, setQuery] = useControllableState(filter, '', onFilterChange);
  const [docsCollapsed, setDocsCollapsed] = useState<string[]>([]);
  const [collapsed, setCollapsed] = useControllableState<readonly SidebarSectionId[]>(
    collapsedSections,
    () => [...(defaultCollapsedSections ?? [])],
    onCollapsedSectionsChange ? (ids) => onCollapsedSectionsChange([...ids]) : undefined,
  );
  const filtering = query.trim() !== '';

  // ---- documents -------------------------------------------------------------------------
  const documentSections = useMemo<SourceListSection[]>(
    () => [
      {
        id: 'documents',
        title: 'Documents',
        items: documents.map<SourceListItem>((doc) => ({
          id: doc.id,
          label: doc.name,
          accessibleLabel: doc.edited ? `${doc.name}, edited` : undefined,
          title: doc.name,
          icon: <DocumentGlyph topology={doc.topology} />,
          secondary: formatCompactLength(doc.length, doc.molecule),
          trailing: doc.edited ? <span className={styles.editedDot} title="Edited" /> : undefined,
          actions: onCloseDocument ? (
            // Pointer affordance only (not a Tab stop inside the list); keyboard users close
            // documents with the File menu shortcut.
            <button
              type="button"
              tabIndex={-1}
              className={styles.closeButton}
              aria-label={`Close ${doc.name}`}
              title="Close"
              onClick={() => onCloseDocument(doc.id)}
            >
              <X aria-hidden />
            </button>
          ) : undefined,
        })),
      },
    ],
    [documents, onCloseDocument],
  );
  const documentsHeight = useMemo(() => {
    const { rows, height } = buildSourceListRows(documentSections, new Set(docsCollapsed));
    const visibleRows = Math.min(rows.length, DOCUMENTS_MAX_ROWS + 1);
    const last = rows[visibleRows - 1];
    return rows.length <= DOCUMENTS_MAX_ROWS + 1 ? height : last.top + last.height + 4;
  }, [documentSections, docsCollapsed]);

  // ---- annotations -----------------------------------------------------------------------
  const features = useMemo(() => (record ? featureRows(record) : []), [record]);
  const primers = useMemo(() => (record ? primerRows(record.primers) : []), [record]);
  const enzymes = useMemo(() => enzymeRows(enzymeSites ?? []), [enzymeSites]);

  const featureItems = useMemo(
    () =>
      features.map<SourceListItem>((f) => ({
        id: `feature:${f.id}`,
        label: f.name,
        title: `${f.name} · ${f.type} · ${formatLength(f.length)}`,
        icon: <FeatureGlyph color={f.color} strand={f.strand} />,
        secondary: formatCompactLength(f.length),
      })),
    [features],
  );
  const primerItems = useMemo(
    () =>
      primers.map<SourceListItem>((p) => ({
        id: `primer:${p.id}`,
        label: p.name,
        title: p.name,
        icon: <PrimerGlyph />,
        secondary: `${p.length} nt`,
      })),
    [primers],
  );
  const enzymeItems = useMemo(
    () =>
      enzymes.map<SourceListItem>((e) => ({
        id: `enzyme:${e.name}`,
        label: e.name,
        title: cutsTitle(e.name, e.cuts, e.count),
        icon: <Scissors />,
        trailing: <span className={cx(styles.count, e.count === 1 && styles.unique)}>{e.count}</span>,
      })),
    [enzymes],
  );

  const annotationSections = useMemo<SourceListSection[]>(() => {
    const q = query.trim();
    const filtered = (items: SourceListItem[]) => (q ? items.filter((i) => matchesFilter(i.label, q)) : items);
    const f = filtered(featureItems);
    const p = filtered(primerItems);
    const e = filtered(enzymeItems);
    const count = (shown: number, all: number) => (q ? `${formatInt(shown)} of ${formatInt(all)}` : formatInt(all));
    return [
      { id: 'features', title: 'Features', count: count(f.length, featureItems.length), items: f, emptyText: q ? 'No matches' : 'No features' },
      { id: 'primers', title: 'Primers', count: count(p.length, primerItems.length), items: p, emptyText: q ? 'No matches' : 'No primers' },
      {
        id: 'enzymes',
        title: 'Enzymes',
        count: count(e.length, enzymeItems.length),
        items: e,
        emptyText: q ? 'No matches' : 'No sites shown',
        iconTone: 'secondary',
      },
    ];
  }, [featureItems, primerItems, enzymeItems, query]);

  const selectedKey = selectedItem ? refKey(selectedItem) : null;

  return (
    <div className={cx(styles.sidebar, className)}>
      {documents.length > 0 ? (
        <div className={styles.documents} style={{ height: documentsHeight }}>
          <SourceList
            aria-label="Open documents"
            sections={documentSections}
            selectedId={activeDocumentId}
            onSelect={(item) => onActivateDocument?.(item.id)}
            collapsedSections={docsCollapsed}
            onCollapsedSectionsChange={setDocsCollapsed}
            emphasized={emphasized}
          />
        </div>
      ) : null}
      <div className={styles.annotations}>
        {record ? (
          <SourceList
            aria-label="Annotations"
            sections={annotationSections}
            selectedId={selectedKey}
            contextMenuItemId={contextMenuItem ? refKey(contextMenuItem) : null}
            onSelect={(item) => {
              const ref = parseKey(item.id);
              if (ref) onSelectItem?.(ref);
            }}
            onActivate={(item) => {
              const ref = parseKey(item.id);
              if (ref) onActivateItem?.(ref);
            }}
            onItemContextMenu={
              onItemContextMenu
                ? (item, _section, event) => {
                    const ref = parseKey(item.id);
                    if (ref) onItemContextMenu(ref, event);
                  }
                : undefined
            }
            // While filtering, every section shows its matches (collapsing is suspended).
            collapsedSections={filtering ? NO_SECTIONS : collapsed}
            onCollapsedSectionsChange={(ids) => {
              if (!filtering) setCollapsed(ids as SidebarSectionId[]);
            }}
            emphasized={emphasized}
          />
        ) : (
          <EmptyState size="sm" title="No Document" message="Open a sequence to see its features." />
        )}
      </div>
      {record ? (
        <div className={styles.footer}>
          <SearchField size="sm" placeholder="Filter" aria-label="Filter annotations" value={query} onValueChange={setQuery} />
        </div>
      ) : null}
    </div>
  );
}
