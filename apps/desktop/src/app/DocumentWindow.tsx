/**
 * The document window: the shell (toolbar, sidebar, canvas, inspector, status bar) wired to the
 * store, for the active document.
 */
import type { SearchHit } from '@hhereditas/core';
import { featureExtent } from '@hhereditas/core';
import { Banner, Button, MenuItem } from '@hhereditas/ui';
import { FilePlus, FolderOpen, Save, X } from 'lucide-react';
import { selectRange } from '@hhereditas/viewer';
import { useEffect, useMemo, useState, type RefObject } from 'react';
import { DocumentView } from '../features/document/DocumentView';
import { InspectorPane } from '../features/inspector/InspectorPane';
import { AppShell, Sidebar, StatusBar, ToolbarContent, formatDocumentSubtitle, useSelectionSummary, type DocumentSummary, type ShellAction, type SidebarItemRef } from '../shell';
import { ENZYME_DISPLAY_CHOICES, ENZYME_DISPLAY_NAMES, ORF_MIN_AA, useDisplayedSites, useOrfs, usePrimerSites, useSearchHits } from '../state/analysis';
import { isDirty } from '../state/documents';
import { useSettings } from '../state/settings';
import { useActiveDocument, useApp } from '../state/store';
import { requestClose } from './commands';
import { openWithDialog, saveDocument } from './files';
import { isMac } from './shortcuts';
import { SHORTCUTS } from './shortcuts';

export interface DocumentWindowProps {
  searchRef: RefObject<HTMLInputElement | null>;
  searchQuery: string;
  onSearchQueryChange: (q: string) => void;
}

/** Index of the hit to go to from the caret (next: first hit starting at/after it; previous: last before). */
export function nextHitIndex(hits: readonly SearchHit[], caret: number, current: number | null, direction: 'next' | 'previous'): number {
  if (hits.length === 0) return -1;
  if (current !== null && current >= 0 && current < hits.length) {
    return direction === 'next' ? (current + 1) % hits.length : (current - 1 + hits.length) % hits.length;
  }
  if (direction === 'next') {
    const i = hits.findIndex((h) => h.range.start >= caret);
    return i >= 0 ? i : 0;
  }
  for (let i = hits.length - 1; i >= 0; i--) if (hits[i].range.start < caret) return i;
  return hits.length - 1;
}

/** Below this window width the inspector starts hidden. */
export const NARROW_WINDOW = 1100;

function useNarrowWindow(): boolean {
  const [narrow, setNarrow] = useState(() => window.innerWidth < NARROW_WINDOW);
  useEffect(() => {
    const onResize = () => setNarrow(window.innerWidth < NARROW_WINDOW);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return narrow;
}

export function DocumentWindow({ searchRef, searchQuery, onSearchQueryChange }: DocumentWindowProps) {
  const doc = useActiveDocument();
  const documents = useApp((s) => s.documents);
  const status = useApp((s) => s.status);
  const app = useApp.getState();
  const settings = useSettings();

  const record = doc?.record ?? null;
  // 'source' features (organism / whole-molecule annotations) are kept in the file but not drawn, like SnapGene.
  const shown = useMemo(
    () => (record && record.features.some((f) => f.type === 'source') ? { ...record, features: record.features.filter((f) => f.type !== 'source') } : record),
    [record],
  );
  const enzymeSites = useDisplayedSites(record, settings.enzymeDisplay, settings.customEnzymes);
  const primerScan = usePrimerSites(record);
  const orfs = useOrfs(record, settings.showOrfs);
  const hits = useSearchHits(record, searchQuery);
  const summary = useSelectionSummary(record, doc?.selection ?? null);

  // Small windows hide the inspector so the canvas keeps its room (until it is shown explicitly).
  const narrow = useNarrowWindow();
  const [inspectorWhenNarrow, setInspectorWhenNarrow] = useState(false);
  const inspectorVisible = narrow ? inspectorWhenNarrow : settings.inspectorVisible;
  const setInspectorVisible = (v: boolean) => (narrow ? setInspectorWhenNarrow(v) : settings.update({ inspectorVisible: v }));

  // Current search hit ("3 of 12"): reset when the query or the sequence changes.
  const [hitIndex, setHitIndex] = useState<number | null>(null);
  useEffect(() => setHitIndex(null), [searchQuery, record?.seq, doc?.id]);

  const summaries: DocumentSummary[] = useMemo(
    () =>
      documents.map((d) => ({
        id: d.id,
        name: d.record.name,
        length: d.record.seq.length,
        topology: d.record.topology,
        molecule: d.record.molecule,
        edited: isDirty(d),
      })),
    [documents],
  );

  if (!doc || !record) return null;
  const n = record.seq.length;

  const selectSidebarItem = (item: SidebarItemRef, zoom = false) => {
    if (item.kind === 'feature') {
      const f = record.features.find((x) => x.id === item.id);
      app.selectItem(item, f ? featureExtent(f, n, record.topology) : null, { zoom });
    } else if (item.kind === 'primer') {
      app.selectItem(item, primerScan.sites.find((s) => s.primerId === item.id)?.range ?? null, { zoom });
    } else {
      app.selectItem(item, enzymeSites.find((s) => s.enzyme === item.id)?.range ?? null, { zoom });
    }
  };

  const goToHit = (direction: 'next' | 'previous') => {
    if (!hits || hits.length === 0) return;
    const i = nextHitIndex(hits, doc.selection?.caret ?? 0, hitIndex, direction);
    const hit = hits[i];
    setHitIndex(i);
    app.setSelection(selectRange(hit.range, n, record.topology));
    app.reveal(hit.range.start % n);
  };

  const onAction = (action: ShellAction) => {
    switch (action) {
      case 'digest':
        app.openSheet('digest');
        break;
      case 'primers':
        if (summary?.hasBases) app.openSheet('add-primer', { direction: 1 });
        else app.flash('Select the bases a primer should anneal to, then choose Add Primer.');
        break;
      case 'find-orfs': {
        const show = !settings.showOrfs;
        settings.update({ showOrfs: show });
        app.flash(show ? `Showing open reading frames of at least ${ORF_MIN_AA} codons` : 'Open reading frames hidden');
        break;
      }
      default:
        break;
    }
  };

  // Windows and Linux have no menu bar: the file commands live at the top of the Actions menu.
  const fileItems = (
    <>
      <MenuItem icon={<FilePlus />} shortcut="Mod+N" onSelect={() => app.openSheet('new-sequence')}>
        New Sequence…
      </MenuItem>
      <MenuItem icon={<FolderOpen />} shortcut="Mod+O" onSelect={() => void openWithDialog()}>
        Open…
      </MenuItem>
      <MenuItem icon={<Save />} shortcut="Mod+S" onSelect={() => void saveDocument()}>
        Save
      </MenuItem>
      <MenuItem shortcut="Shift+Mod+S" onSelect={() => void saveDocument(undefined, true)}>
        Save As…
      </MenuItem>
      <MenuItem icon={<X />} shortcut="Mod+W" onSelect={() => requestClose()}>
        Close
      </MenuItem>
    </>
  );

  const searchStatus =
    searchQuery.trim().length === 0 ? undefined : hits === null ? (searchQuery.replace(/\s/g, '').length < 3 ? undefined : 'Not DNA') : hits.length === 0 ? 'None' : hitIndex === null ? `${hits.length.toLocaleString('en-US')}` : `${hitIndex + 1} of ${hits.length.toLocaleString('en-US')}`;

  const banner = doc.warnings.length ? (
    <Banner
      tone="warning"
      title={`${doc.warnings.length} problem${doc.warnings.length > 1 ? 's' : ''} while reading ${doc.fileName ?? 'the file'}`}
      onDismiss={() => app.dismissWarnings(doc.id)}
      actions={
        doc.warnings.length > 1 ? (
          <Button size="sm" variant="plain" onClick={() => app.flash(doc.warnings.slice(0, 3).join(' · '))}>
            Details
          </Button>
        ) : undefined
      }
    >
      {doc.warnings[0]}
    </Banner>
  ) : undefined;

  return (
    <AppShell
      sidebarVisible={settings.sidebarVisible}
      onSidebarVisibleChange={(v) => settings.update({ sidebarVisible: v })}
      inspectorVisible={inspectorVisible}
      onInspectorVisibleChange={setInspectorVisible}
      {...(settings.sidebarWidth ? { sidebarWidth: settings.sidebarWidth } : {})}
      onSidebarWidthChange={(w) => settings.update({ sidebarWidth: w })}
      {...(settings.inspectorWidth ? { inspectorWidth: settings.inspectorWidth } : {})}
      onInspectorWidthChange={(w) => settings.update({ inspectorWidth: w })}
      toolbar={
        <ToolbarContent
          title={record.name}
          subtitle={formatDocumentSubtitle(n, record.topology, record.molecule)}
          edited={isDirty(doc)}
          sidebarVisible={settings.sidebarVisible}
          onToggleSidebar={() => settings.update({ sidebarVisible: !settings.sidebarVisible })}
          inspectorVisible={inspectorVisible}
          onToggleInspector={() => setInspectorVisible(!inspectorVisible)}
          view={doc.view}
          onViewChange={app.setView}
          enzymeDisplay={settings.enzymeDisplay}
          onEnzymeDisplayChange={(d) => settings.update({ enzymeDisplay: d })}
          enzymeDisplayOptions={ENZYME_DISPLAY_CHOICES}
          enzymeDisplayLabels={ENZYME_DISPLAY_NAMES}
          onChooseEnzymes={() => app.openSheet('choose-enzymes')}
          onAction={onAction}
          cloningAvailable={false}
          actionsMenuPrefix={isMac() ? undefined : fileItems}
          searchValue={searchQuery}
          onSearchChange={onSearchQueryChange}
          onSearchSubmit={(_v, direction) => goToHit(direction)}
          searchStatus={searchStatus}
          searchRef={searchRef}
          shortcuts={SHORTCUTS}
        />
      }
      sidebar={
        <Sidebar
          documents={summaries}
          activeDocumentId={doc.id}
          onActivateDocument={app.activate}
          onCloseDocument={(id) => requestClose(id)}
          record={shown}
          enzymeSites={enzymeSites}
          selectedItem={doc.selectedItem}
          onSelectItem={(item) => selectSidebarItem(item)}
          onActivateItem={(item) => selectSidebarItem(item, true)}
        />
      }
      inspector={<InspectorPane doc={doc} summary={summary} primerSites={primerScan.sites} primerFailures={primerScan.failures} />}
      statusBar={
        <StatusBar
          selection={summary}
          length={n}
          topology={record.topology}
          molecule={record.molecule}
          message={status ? <span data-tone={status.tone}>{status.text}</span> : undefined}
        />
      }
    >
      <DocumentView doc={shown && shown !== record ? { ...doc, record: shown } : doc} enzymeSites={enzymeSites} primerSites={primerScan.sites} orfs={orfs} searchHits={hits} banner={banner} />
    </AppShell>
  );
}

