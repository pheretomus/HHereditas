/**
 * The document canvas: the map (circular or linear by topology) and the editable sequence,
 * shown as Map / Sequence / Split, sharing one selection. Right-click opens a context menu
 * for the annotation under the pointer and the selection.
 */
import type { EnzymeSite, Orf, PrimerBindingSite, Range, SearchHit } from '@hhereditas/core';
import { featureExtent, formatRange } from '@hhereditas/core';
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
  selectRange,
  viewportForRange,
  type FeatureClickInfo,
  type MapTarget,
  type MapWidthChange,
  type SequenceViewProps,
} from '@hhereditas/viewer';
import { ArrowLeftToLine, ArrowRightToLine, Combine, Copy, Crosshair, FilePlus2, Pencil, Scissors, Tag, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { MainArea } from '../../shell';
import { enzymeAliases } from '../../state/analysis';
import type { DocumentState } from '../../state/documents';
import { useSettings } from '../../state/settings';
import { getActiveDocument, useApp } from '../../state/store';
import { deleteFeatureCommand, deletePrimerCommand, openSelectionAsDocument, copySelection } from '../../app/commands';
import styles from './DocumentView.module.css';

export interface DocumentLayerShow {
  enzymes?: boolean;
  features?: boolean;
  primers?: boolean;
  orfs?: boolean;
  alignments?: boolean;
  translations?: boolean;
  complement?: boolean;
  numbering?: boolean;
  lengths?: boolean;
  primerLocations?: boolean;
}

export interface DocumentViewProps {
  doc: DocumentState;
  enzymeSites: readonly EnzymeSite[];
  primerSites: readonly PrimerBindingSite[];
  orfs: readonly Orf[];
  searchHits: readonly SearchHit[] | null;
  banner?: ReactNode;
  /** Override whether the Map pane draws a circular or linear map (like SnapGene's [◯] | [━] buttons). */
  mapMode?: 'circular' | 'linear';
  /** Which annotation layers are drawn on the map and sequence views. */
  layerShow?: DocumentLayerShow;
  /** Increment to reset linear map zoom to full sequence. */
  fitTrigger?: number;
  /** Layout of the sequence view (e.g. one long line that scrolls together with the trace panel). */
  sequenceLayout?: Pick<SequenceViewProps, 'basesPerRow' | 'metrics' | 'scrollLeft' | 'onScrollLeftChange' | 'onContentHeightChange'>;
  /** The linear map's width is about to change in an animation (see LinearMap's widthChange). */
  mapWidthChange?: MapWidthChange;
}

export function DocumentView({
  doc,
  enzymeSites,
  primerSites,
  orfs,
  searchHits,
  banner,
  mapMode,
  layerShow,
  fitTrigger,
  sequenceLayout,
  mapWidthChange,
}: DocumentViewProps) {
  const { record, selection, view } = doc;
  const n = record.seq.length;
  const app = useApp.getState();
  const splitRatio = useSettings((s) => s.splitRatio);
  const [hoveredFeature, setHoveredFeature] = useState<string | null>(null);
  const highlighted = hoveredFeature ?? (doc.selectedItem?.kind === 'feature' ? doc.selectedItem.id : null);
  const effectiveMapMode = mapMode ?? (record.topology === 'circular' ? 'circular' : 'linear');

  // Linear map window: uncontrolled until something asks to zoom.
  const [viewport, setViewport] = useState<Range | undefined>(undefined);
  useEffect(() => setViewport(undefined), [doc.id, fitTrigger]);
  const scrollRequest = doc.scrollRequest;
  useEffect(() => {
    if (scrollRequest?.zoomRange && effectiveMapMode === 'linear' && n > 0) {
      setViewport(viewportForRange(scrollRequest.zoomRange, n, record.topology));
    }
    // only when a new request arrives
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollRequest?.requestId]);

  const onFeatureClick = useCallback(
    (id: string, info: FeatureClickInfo) => {
      const currentDoc = getActiveDocument() ?? doc;
      const currentRecord = currentDoc.record;
      const len = currentRecord.seq.length;
      const appState = useApp.getState();

      if (info.shiftKey) {
        const anchorId =
          doc.selectedItem?.kind === 'feature' ? doc.selectedItem.id : (doc.selectedFeatureIds?.[0] ?? currentDoc.selectedFeatureIds?.[0]);
        if (anchorId && anchorId !== id) {
          const f1 = currentRecord.features.find((f) => f.id === anchorId);
          const f2 = currentRecord.features.find((f) => f.id === id);
          if (f1 && f2 && len > 0) {
            const ext1 = featureExtent(f1, len, currentRecord.topology);
            const ext2 = featureExtent(f2, len, currentRecord.topology);
            const start = Math.min(ext1.start, ext2.start);
            const end = Math.max(ext1.end, ext2.end);
            appState.setSelection(selectRange({ start, end }, len, currentRecord.topology));
            appState.setSelectedFeatureIds([anchorId, id]);
            appState.flash(`Selected ${f1.name} .. ${f2.name} (${end - start} bp)`);
            return;
          }
        }
      }

      if (info.ctrlKey || info.metaKey) {
        const current = doc.selectedFeatureIds?.length
          ? [...doc.selectedFeatureIds]
          : currentDoc.selectedFeatureIds?.length
            ? [...currentDoc.selectedFeatureIds]
            : doc.selectedItem?.kind === 'feature'
              ? [doc.selectedItem.id]
              : [];
        const next = current.includes(id) ? current.filter((x) => x !== id) : [...current, id];
        appState.setSelectedFeatureIds(next);
        if (next.length > 0) {
          const names = next.map((fid) => currentRecord.features.find((f) => f.id === fid)?.name ?? fid);
          appState.flash(`${next.length} features selected (${names.join(', ')}) — Right-click for Gibson Assembly Calculation`);
        } else {
          appState.flash('No features selected');
        }
        return;
      }

      appState.selectItem({ kind: 'feature', id }, null, {
        zoom: info.clickCount > 1,
      });
      if (info.clickCount > 1) {
        appState.openSheet('edit-feature', { featureId: id });
      }
    },
    [doc],
  );
  const onEnzymeClick = useCallback((site: EnzymeSite) => {
    useApp.getState().selectItem({ kind: 'enzyme', id: site.enzyme }, site.range);
  }, []);
  const onPrimerClick = useCallback(
    (primerId: string, info?: FeatureClickInfo) => {
      const currentDoc = getActiveDocument() ?? doc;
      const currentRecord = currentDoc.record;
      const len = currentRecord.seq.length;
      const appState = useApp.getState();
      const prevItem = doc.selectedItem?.kind === 'primer' ? doc.selectedItem : currentDoc.selectedItem;

      if (info && (info.ctrlKey || info.metaKey || info.shiftKey) && prevItem?.kind === 'primer' && prevItem.id !== primerId) {
        const s1 = primerSites.find((s) => s.primerId === prevItem.id);
        const s2 = primerSites.find((s) => s.primerId === primerId);
        if (s1 && s2 && len > 0) {
          const fwd = s1.strand === 1 && s2.strand === -1 ? s1 : s2.strand === 1 && s1.strand === -1 ? s2 : null;
          const rev = fwd === s1 ? s2 : fwd === s2 ? s1 : null;
          let spanRange: Range;
          if (fwd && rev) {
            if (rev.range.end >= fwd.range.start) {
              spanRange = { start: fwd.range.start, end: rev.range.end };
            } else if (currentRecord.topology === 'circular') {
              spanRange = { start: fwd.range.start, end: rev.range.end + len };
            } else {
              spanRange = {
                start: Math.min(s1.range.start, s2.range.start),
                end: Math.max(s1.range.end, s2.range.end),
              };
            }
          } else {
            spanRange = {
              start: Math.min(s1.range.start, s2.range.start),
              end: Math.max(s1.range.end, s2.range.end),
            };
          }
          const sel = selectRange(spanRange, len, currentRecord.topology);
          const bpLen = sel.range.end - sel.range.start;
          const p1Name = currentRecord.primers.find((p) => p.id === prevItem.id)?.name ?? prevItem.id;
          const p2Name = currentRecord.primers.find((p) => p.id === primerId)?.name ?? primerId;
          appState.setSelection(sel);
          appState.flash(`Selected ${p1Name} .. ${p2Name} (${formatRange(sel.range, len)}, ${bpLen.toLocaleString('en-US')} bp)`);
          return;
        }
      }

      const site = primerSites.find((s) => s.primerId === primerId);
      appState.selectItem({ kind: 'primer', id: primerId }, site?.range ?? null);
      if (info && info.clickCount > 1) {
        appState.openSheet('edit-primer', { primerId });
      }
    },
    [doc, primerSites],
  );

  // Context menu: the views report the target before the event reaches the trigger.
  const menuHit = useRef<MapTarget | null>(null);
  const [menuTarget, setMenuTarget] = useState<MapTarget | null>(null);
  const onContextMenu = useCallback((target: MapTarget) => {
    menuHit.current = target;
  }, []);

  const scrollTo = useMemo(
    () =>
      scrollRequest
        ? {
            position: scrollRequest.position,
            requestId: scrollRequest.requestId,
          }
        : undefined,
    [scrollRequest],
  );

  const mapShow = useMemo(
    () =>
      layerShow
        ? {
            enzymes: layerShow.enzymes ?? true,
            features: layerShow.features ?? true,
            primers: layerShow.primers ?? true,
            orfs: layerShow.orfs ?? true,
            alignments: layerShow.alignments ?? true,
            lengths: layerShow.lengths ?? false,
            primerLocations: layerShow.primerLocations ?? false,
          }
        : undefined,
    [layerShow],
  );

  const hasSequenceLayout = !!sequenceLayout;
  const seqShow = useMemo(
    () =>
      layerShow
        ? {
            enzymes: layerShow.enzymes ?? true,
            features: layerShow.features ?? true,
            primers: layerShow.primers ?? true,
            orfs: layerShow.orfs ?? true,
            // with a given layout (the align mode's one-line view) the reads are shown in the trace panel instead
            alignments: hasSequenceLayout ? false : (layerShow.alignments ?? true),
            translations: layerShow.translations ?? true,
            complement: layerShow.complement ?? true,
            numbering: layerShow.numbering ?? true,
          }
        : undefined,
    [layerShow, hasSequenceLayout],
  );

  const map =
    effectiveMapMode === 'circular' ? (
      <CircularMap
        record={record}
        enzymeSites={enzymeSites}
        enzymeAliases={enzymeAliases()}
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
        show={mapShow}
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
        show={mapShow}
        animateAlignments={view !== 'sequence'}
        widthChange={mapWidthChange}
      />
    );

  const sequenceView = (
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
      onInvalidInput={(text) =>
        useApp.getState().flash(`Not a DNA sequence: “${text.slice(0, 24)}${text.length > 24 ? '…' : ''}”`, 'error')
      }
      scrollTo={scrollTo}
      show={seqShow}
      {...sequenceLayout}
      centerVertically={!!sequenceLayout}
      hideHorizontalScrollbar={!!sequenceLayout}
    />
  );
  const sequence = (
    // a given layout (the one-line view of the align mode) brings its own left margin and sits in the vertical middle
    <div className={styles.sequence} data-hh-sequence="" style={sequenceLayout ? { paddingLeft: 0 } : undefined}>
      {sequenceView}
    </div>
  );

  // the sequence view stays mounted while only the map is shown: it is not redrawn then (each change, e.g. the align
  // mode toggling, would lay the whole record out again for nothing); it catches up when it is shown again
  const frozenSequence = useRef(sequence);
  if (view !== 'map') frozenSequence.current = sequence;
  const shownSequence = view === 'map' ? frozenSequence.current : sequence;

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
            sequence={shownSequence}
            topology={record.topology}
            splitRatio={splitRatio}
            onSplitRatioChange={(r) => useSettings.getState().update({ splitRatio: r })}
            banner={banner}
          />
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        {(doc.selectedFeatureIds?.length ?? 0) >= 2 ? (
          <>
            <ContextMenuItem
              icon={<Combine />}
              onSelect={() =>
                app.openSheet('clone-gibson', {
                  featureIds: [...(doc.selectedFeatureIds ?? [])],
                })
              }
            >
              Gibson Calculation ({doc.selectedFeatureIds!.length} selected features)…
            </ContextMenuItem>
            <ContextMenuSeparator />
          </>
        ) : null}
        {menuTarget?.kind === 'feature' && featureName !== undefined ? (
          <>
            <ContextMenuLabel>{featureName || 'Feature'}</ContextMenuLabel>
            <ContextMenuItem
              icon={<Crosshair />}
              onSelect={() =>
                app.selectItem({ kind: 'feature', id: menuTarget.id }, null, {
                  zoom: true,
                })
              }
            >
              Select Feature
            </ContextMenuItem>
            <ContextMenuItem icon={<Pencil />} onSelect={() => app.openSheet('edit-feature', { featureId: menuTarget.id })}>
              Edit Feature…
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
            <ContextMenuItem icon={<Pencil />} onSelect={() => app.openSheet('edit-primer', { primerId: menuTarget.id })}>
              Edit Primer…
            </ContextMenuItem>
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
