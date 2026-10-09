/**
 * The document canvas: the map (circular or linear by topology) and the editable sequence,
 * shown as Map / Sequence / Split, sharing one selection. Right-click opens a context menu
 * for the annotation under the pointer and the selection.
 */
import type { EnzymeSite, Orf, PrimerBindingSite, Range, SearchHit } from '@hhereditas/core';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@hhereditas/ui';
import {
  CircularMap,
  LinearMap,
  SequenceView,
  hasSelectedBases,
  viewportForRange,
  type FeatureClickInfo,
  type MapTarget,
} from '@hhereditas/viewer';
import { ArrowLeftToLine, ArrowRightToLine, Copy, Crosshair, FilePlus2, Scissors, Tag, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { MainArea } from '../../shell';
import type { DocumentState } from '../../state/documents';
import { useSettings } from '../../state/settings';
import { useApp } from '../../state/store';
import { deleteFeatureCommand, deletePrimerCommand, openSelectionAsDocument, copySelection } from '../../app/commands';
import styles from './DocumentView.module.css';

export interface DocumentViewProps {
  doc: DocumentState;
  enzymeSites: readonly EnzymeSite[];
  primerSites: readonly PrimerBindingSite[];
  orfs: readonly Orf[];
  searchHits: readonly SearchHit[] | null;
  banner?: ReactNode;
}

export function DocumentView({ doc, enzymeSites, primerSites, orfs, searchHits, banner }: DocumentViewProps) {
  const { record, selection, view } = doc;
  const n = record.seq.length;
  const app = useApp.getState();
  const splitRatio = useSettings((s) => s.splitRatio);
  const [hoveredFeature, setHoveredFeature] = useState<string | null>(null);
  const highlighted = hoveredFeature ?? (doc.selectedItem?.kind === 'feature' ? doc.selectedItem.id : null);

  // Linear map window: uncontrolled until something asks to zoom.
  const [viewport, setViewport] = useState<Range | undefined>(undefined);
  useEffect(() => setViewport(undefined), [doc.id]);
  const scrollRequest = doc.scrollRequest;
  useEffect(() => {
    if (scrollRequest?.zoomRange && record.topology === 'linear' && n > 0) {
      setViewport(viewportForRange(scrollRequest.zoomRange, n, record.topology));
    }
    // only when a new request arrives
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollRequest?.requestId]);

  const onFeatureClick = useCallback((id: string, info: FeatureClickInfo) => {
    useApp.getState().selectItem({ kind: 'feature', id }, null, { zoom: info.clickCount > 1 });
  }, []);
  const onEnzymeClick = useCallback((site: EnzymeSite) => {
    useApp.getState().selectItem({ kind: 'enzyme', id: site.enzyme }, site.range);
  }, []);
  const onPrimerClick = useCallback(
    (primerId: string) => {
      const site = primerSites.find((s) => s.primerId === primerId);
      useApp.getState().selectItem({ kind: 'primer', id: primerId }, site?.range ?? null);
    },
    [primerSites],
  );

  // Context menu: the views report the target before the event reaches the trigger.
  const menuHit = useRef<MapTarget | null>(null);
  const [menuTarget, setMenuTarget] = useState<MapTarget | null>(null);
  const onContextMenu = useCallback((target: MapTarget) => {
    menuHit.current = target;
  }, []);

  const scrollTo = useMemo(
    () => (scrollRequest ? { position: scrollRequest.position, requestId: scrollRequest.requestId } : undefined),
    [scrollRequest],
  );

  const map =
    record.topology === 'circular' ? (
      <CircularMap
        record={record}
        enzymeSites={enzymeSites}
        primerSites={primerSites}
        orfs={orfs}
        selection={selection}
        onSelectionChange={app.setSelection}
        highlightedFeatureId={highlighted}
        onFeatureClick={onFeatureClick}
        onFeatureHover={setHoveredFeature}
        onEnzymeClick={onEnzymeClick}
        onPrimerClick={onPrimerClick}
        onContextMenu={onContextMenu}
      />
    ) : (
      <LinearMap
        record={record}
        enzymeSites={enzymeSites}
        primerSites={primerSites}
        orfs={orfs}
        selection={selection}
        onSelectionChange={app.setSelection}
        highlightedFeatureId={highlighted}
        onFeatureClick={onFeatureClick}
        onFeatureHover={setHoveredFeature}
        onEnzymeClick={onEnzymeClick}
        onPrimerClick={onPrimerClick}
        onContextMenu={onContextMenu}
        viewport={viewport}
        onViewportChange={viewport ? setViewport : undefined}
      />
    );

  const sequence = (
    <div className={styles.sequence} data-hh-sequence="">
      <SequenceView
        record={record}
        enzymeSites={enzymeSites}
        primerSites={primerSites}
        orfs={orfs}
        searchHits={searchHits ?? undefined}
        selection={selection}
        onSelectionChange={app.setSelection}
        highlightedFeatureId={highlighted}
        onFeatureClick={onFeatureClick}
        onFeatureHover={setHoveredFeature}
        onEnzymeClick={onEnzymeClick}
        onPrimerClick={onPrimerClick}
        onContextMenu={onContextMenu}
        editable={record.molecule !== 'protein'}
        onEdit={app.applyEdit}
        onInvalidInput={(text) => useApp.getState().flash(`Not a DNA sequence: “${text.slice(0, 24)}${text.length > 24 ? '…' : ''}”`, 'error')}
        scrollTo={scrollTo}
      />
    </div>
  );

  const hasBases = hasSelectedBases(selection);
  const featureName = menuTarget?.kind === 'feature' ? record.features.find((f) => f.id === menuTarget.id)?.name : undefined;
  const primerName = menuTarget?.kind === 'primer' ? record.primers.find((p) => p.id === menuTarget.id)?.name : undefined;

  return (
    <ContextMenu
      modal={false}
      onOpenChange={(open) => {
        if (!open) setMenuTarget(null);
      }}
    >
      <ContextMenuTrigger
        asChild
        onContextMenu={() => {
          setMenuTarget(menuHit.current);
          menuHit.current = null;
        }}
      >
        <div className={styles.root}>
          <MainArea
            view={view}
            map={map}
            sequence={sequence}
            topology={record.topology}
            splitRatio={splitRatio}
            onSplitRatioChange={(r) => useSettings.getState().update({ splitRatio: r })}
            banner={banner}
          />
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        {menuTarget?.kind === 'feature' && featureName !== undefined ? (
          <>
            <ContextMenuLabel>{featureName || 'Feature'}</ContextMenuLabel>
            <ContextMenuItem icon={<Crosshair />} onSelect={() => app.selectItem({ kind: 'feature', id: menuTarget.id }, null, { zoom: true })}>
              Select Feature
            </ContextMenuItem>
            <ContextMenuItem icon={<Trash2 />} destructive onSelect={() => deleteFeatureCommand(menuTarget.id)}>
              Delete Feature
            </ContextMenuItem>
            <ContextMenuSeparator />
          </>
        ) : null}
        {menuTarget?.kind === 'primer' && primerName !== undefined ? (
          <>
            <ContextMenuLabel>{primerName}</ContextMenuLabel>
            <ContextMenuItem icon={<Trash2 />} destructive onSelect={() => deletePrimerCommand(menuTarget.id)}>
              Delete Primer
            </ContextMenuItem>
            <ContextMenuSeparator />
          </>
        ) : null}
        {menuTarget?.kind === 'enzyme' ? (
          <>
            <ContextMenuLabel>{menuTarget.site.enzyme}</ContextMenuLabel>
            <ContextMenuItem icon={<Scissors />} onSelect={() => app.openSheet('digest', { enzymes: [menuTarget.site.enzyme] })}>
              Digest with {menuTarget.site.enzyme}…
            </ContextMenuItem>
            <ContextMenuSeparator />
          </>
        ) : null}
        <ContextMenuItem icon={<Tag />} disabled={!hasBases} onSelect={() => app.openSheet('add-feature')}>
          Add Feature…
        </ContextMenuItem>
        <ContextMenuItem icon={<ArrowRightToLine />} disabled={!hasBases} onSelect={() => app.openSheet('add-primer', { direction: 1 })}>
          Add Forward Primer…
        </ContextMenuItem>
        <ContextMenuItem icon={<ArrowLeftToLine />} disabled={!hasBases} onSelect={() => app.openSheet('add-primer', { direction: -1 })}>
          Add Reverse Primer…
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem icon={<Copy />} disabled={!hasBases} onSelect={() => copySelection()}>
          Copy Sequence
        </ContextMenuItem>
        <ContextMenuItem icon={<FilePlus2 />} disabled={!hasBases} onSelect={() => openSelectionAsDocument()}>
          Open Selection as New Document
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem icon={<Scissors />} onSelect={() => app.openSheet('digest')}>
          Digest &amp; Gel…
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
