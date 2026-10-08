/**
 * CircularMap: the plasmid map, the signature view of HHereditas.
 *
 * Presentational: data and selection come in as props, user intent goes out through
 * callbacks. Works uncontrolled too (omit `selection` and it keeps its own).
 * Layout is memoized in three stages (see layout.ts) and the expensive layers are memoized
 * components, so hover and selection changes only re-render small overlays.
 */
import type { EnzymeSite, Orf, PrimerBindingSite, Range, SeqRecord, Topology } from '@hhereditas/core';
import { featureLength, mod, normalizeRange } from '@hhereditas/core';
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  memo,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { FEATURE_LABEL_ON_FILL } from '../common/colors';
import { formatBp, formatInt, formatPosition } from '../common/format';
import { useElementSize } from '../common/useElementSize';
import { type SequenceSelection, caretAt, hasSelectedBases, selectBetween, selectRange, selectionAnchor } from '../selection';
import styles from './CircularMap.module.css';
import {
  angleDelta,
  angleToGap,
  arcPath,
  cartesianToPolar,
  degreesPerBase,
  polarToCartesian,
  positionToAngle,
  radialLinePath,
  wedgePath,
} from './geometry';
import { type HitResult, hitKey, hitTest, hitToTarget } from './hitTest';
import {
  type LabelPlacement,
  type LabelTone,
  type MapGeometry,
  LABEL_CHIP_GAP,
  buildMapModel,
  labelChipSize,
  computeGeometry,
  placeLabels,
} from './layout';
import { type TextMeasurer, createCanvasMeasurer } from './measure';
import type { FeatureClickInfo, MapLayers, MapTarget } from './types';

export interface CircularMapProps {
  record: SeqRecord;
  /** Sites to draw (already filtered by the app): every one given is shown. */
  enzymeSites?: readonly EnzymeSite[];
  /** Primer binding sites; names come from record.primers (matched by primerId). */
  primerSites?: readonly PrimerBindingSite[];
  orfs?: readonly Orf[];
  /** Controlled selection. Omit (undefined) to let the map keep its own. */
  selection?: SequenceSelection | null;
  onSelectionChange?: (selection: SequenceSelection | null) => void;
  /** Feature to emphasise, e.g. hovered in the sidebar. */
  highlightedFeatureId?: string | null;
  onFeatureClick?: (featureId: string, info: FeatureClickInfo) => void;
  onFeatureHover?: (featureId: string | null) => void;
  onEnzymeClick?: (site: EnzymeSite) => void;
  onPrimerClick?: (primerId: string) => void;
  onContextMenu?: (target: MapTarget, event: ReactMouseEvent) => void;
  /** Layers to draw; each defaults to visible when its data is given. */
  show?: MapLayers;
  className?: string;
  /** Map rotation in degrees, clockwise; 0 puts the origin at 12 o'clock. */
  rotation?: number;
}

const EMPTY: readonly never[] = [];
const DRAG_THRESHOLD = 3;

function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

function resolveUiFont(): string {
  if (typeof document === 'undefined') return 'system-ui, sans-serif';
  const v = getComputedStyle(document.documentElement).getPropertyValue('--hh-font-ui').trim();
  return v || 'system-ui, sans-serif';
}

/** Re-measure text once web fonts have loaded (Inter is bundled but loads asynchronously). */
function useFontEpoch(): number {
  const [epoch, setEpoch] = useState(0);
  useEffect(() => {
    const fonts = typeof document !== 'undefined' ? document.fonts : undefined;
    if (!fonts) return;
    let alive = true;
    const bump = () => alive && setEpoch((e) => e + 1);
    void fonts.ready.then(bump);
    fonts.addEventListener?.('loadingdone', bump);
    return () => {
      alive = false;
      fonts.removeEventListener?.('loadingdone', bump);
    };
  }, []);
  return epoch;
}

/** 1-based inclusive display of a range: "1,234..2,345" (wrapping ranges: "3,901..120"). */
export function formatRangeText(r: Range, length: number): string {
  if (r.end <= r.start) return formatPosition(r.start);
  const last = length > 0 ? mod(r.end - 1, length) : r.end - 1;
  return `${formatPosition(r.start)}..${formatPosition(last)}`;
}

function strandText(strand: number): string {
  return strand === 1 ? 'Forward' : strand === -1 ? 'Reverse' : 'No strand';
}

/** Smallest arc (circular) or span (linear) covering two ranges. */
export function coverRanges(a: Range, b: Range, length: number, topology: Topology): Range {
  if (topology === 'linear' || length <= 0) {
    return { start: Math.min(a.start, b.start), end: Math.max(a.end, b.end) };
  }
  const arcs = [normalizeRange(a, length, topology), normalizeRange(b, length, topology)];
  const covered = (p: number) =>
    arcs.some((r) => {
      if (r.end - r.start >= length) return true;
      const x = mod(p - r.start, length);
      return x < r.end - r.start;
    });
  const points = [...new Set(arcs.flatMap((r) => [mod(r.start, length), mod(r.end, length)]))].sort((x, y) => x - y);
  let bestGap: { start: number; len: number } | null = null;
  for (let i = 0; i < points.length; i++) {
    const s = points[i];
    const e = i + 1 < points.length ? points[i + 1] : points[0] + length;
    const len = e - s;
    if (len <= 0) continue;
    if (!covered(s + len / 2) && (!bestGap || len > bestGap.len)) bestGap = { start: s, len };
  }
  if (!bestGap) return { start: arcs[0].start, end: arcs[0].start + length };
  const start = mod(bestGap.start + bestGap.len, length);
  return { start, end: start + (length - bestGap.len) };
}

interface DragState {
  pointerId: number;
  anchor: number;
  /** Signed travel from the anchor in bases (circular: cumulative, may cross the origin). */
  offset: number;
  /** Linear molecules: current head gap. */
  head: number;
  lastAngle: number;
  startX: number;
  startY: number;
  moved: boolean;
}

export function CircularMap(props: CircularMapProps) {
  const {
    record,
    enzymeSites = EMPTY,
    primerSites = EMPTY,
    orfs = EMPTY,
    selection,
    onSelectionChange,
    highlightedFeatureId = null,
    onFeatureClick,
    onFeatureHover,
    onEnzymeClick,
    onPrimerClick,
    onContextMenu,
    show,
    className,
    rotation = 0,
  } = props;

  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const { width, height } = useElementSize(containerRef);
  const idPrefix = `hhcm${useId().replace(/[^a-zA-Z0-9_-]/g, '')}-`;

  // Uncontrolled fallback.
  const [ownSelection, setOwnSelection] = useState<SequenceSelection | null>(null);
  const sel = selection !== undefined ? selection : ownSelection;
  const selRef = useRef(sel);
  selRef.current = sel;

  const fontEpoch = useFontEpoch();
  const measure = useMemo<TextMeasurer>(() => {
    void fontEpoch; // new measurer (empty cache) once fonts are ready
    return createCanvasMeasurer(resolveUiFont());
  }, [fontEpoch]);

  const showFeatures = show?.features !== false;
  const showEnzymes = show?.enzymes !== false;
  const showPrimers = show?.primers !== false;
  const showOrfs = show?.orfs !== false;

  const model = useMemo(
    () =>
      buildMapModel({
        record,
        enzymeSites,
        primerSites,
        orfs,
        layers: { features: showFeatures, enzymes: showEnzymes, primers: showPrimers, orfs: showOrfs },
      }),
    [record, enzymeSites, primerSites, orfs, showFeatures, showEnzymes, showPrimers, showOrfs],
  );

  const geom = useMemo(
    () => computeGeometry(model, { width, height, rotation, measure }),
    [model, width, height, rotation, measure],
  );

  // Labels of selected / highlighted features win when space runs out.
  const selStart = sel?.range.start ?? -1;
  const selEnd = sel?.range.end ?? -1;
  const pinnedKey = useMemo(() => {
    const ids: string[] = [];
    if (highlightedFeatureId) ids.push(highlightedFeatureId);
    if (selEnd > selStart && model.length > 0) {
      const r = normalizeRange({ start: selStart, end: selEnd }, model.length, model.topology);
      for (const f of model.features) {
        if (f.extent.start === r.start && f.extent.end === r.end) ids.push(f.feature.id);
      }
    }
    return ids.sort().join('\u0000');
  }, [model, selStart, selEnd, highlightedFeatureId]);

  const basePlacement = useMemo(() => (geom ? placeLabels(geom) : null), [geom]);
  const placement = useMemo(() => {
    if (!geom || !basePlacement || !pinnedKey) return basePlacement;
    const pinned = new Set(pinnedKey.split('\u0000'));
    const missing = geom.candidates.some(
      (c) => c.featureId !== undefined && pinned.has(c.featureId) && !basePlacement.byKey.has(c.key),
    );
    return missing ? placeLabels(geom, pinned) : basePlacement;
  }, [geom, basePlacement, pinnedKey]);

  // ---- Hover ---------------------------------------------------------------------
  const [hover, setHover] = useState<HitResult | null>(null);
  const hoverKeyRef = useRef('');
  const pointerRef = useRef<{ x: number; y: number } | null>(null);
  const onFeatureHoverRef = useRef(onFeatureHover);
  onFeatureHoverRef.current = onFeatureHover;

  const updateHover = (next: HitResult | null) => {
    const key = hitKey(next);
    if (key === hoverKeyRef.current) return;
    const prevFeature = hoverKeyRef.current.startsWith('f:') ? hoverKeyRef.current.slice(2) : null;
    const nextFeature = next?.kind === 'feature' ? next.shape.id : null;
    hoverKeyRef.current = key;
    setHover(next);
    if (prevFeature !== nextFeature) onFeatureHoverRef.current?.(nextFeature);
  };

  // Geometry changed under the pointer (resize, new record): drop a stale hover.
  useEffect(() => {
    if (hoverKeyRef.current) updateHover(null);
  }, [geom]);

  const positionTooltip = () => {
    const el = tooltipRef.current;
    const p = pointerRef.current;
    if (!el || !p) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    let x = p.x + 14;
    let y = p.y + 18;
    if (x + w > width - 6) x = Math.max(6, p.x - 14 - w);
    if (y + h > height - 6) y = Math.max(6, p.y - 12 - h);
    el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  };
  useLayoutEffect(positionTooltip);

  // ---- Selection plumbing ------------------------------------------------------------
  const emit = (next: SequenceSelection | null) => {
    selRef.current = next;
    if (selection === undefined) setOwnSelection(next);
    onSelectionChange?.(next);
  };

  const dragRef = useRef<DragState | null>(null);
  const suppressClickRef = useRef(false);

  const localPoint = (e: { clientX: number; clientY: number }) => {
    const rect = svgRef.current?.getBoundingClientRect();
    return { x: e.clientX - (rect?.left ?? 0), y: e.clientY - (rect?.top ?? 0) };
  };

  const dragSelection = (d: DragState, g: MapGeometry): SequenceSelection => {
    const L = g.model.length;
    if (g.model.topology === 'linear') return selectBetween(d.anchor, d.head, L, 'linear');
    const n = Math.round(d.offset);
    if (n === 0) return caretAt(d.anchor);
    if (Math.abs(n) >= L) return { range: { start: d.anchor, end: d.anchor + L }, caret: d.anchor };
    return selectBetween(d.anchor, mod(d.anchor + n, L), L, 'circular', n > 0);
  };

  const onPointerDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (e.button !== 0 || !geom) return;
    containerRef.current?.focus({ preventScroll: true });
    suppressClickRef.current = false;
    const p = localPoint(e);
    const hit = hitTest(geom, placement, p.x, p.y);
    if (hit.kind !== 'ring') return; // annotations and background act on click
    const L = geom.model.length;
    if (L <= 0) return;
    e.preventDefault();
    const { angle } = cartesianToPolar(geom.cx, geom.cy, p.x, p.y);
    const gap = angleToGap(geom.scale, angle);
    const current = selRef.current;
    let anchor = gap;
    let offset = 0;
    if (e.shiftKey && current) {
      anchor = selectionAnchor(current, L, geom.model.topology);
      if (geom.model.topology === 'circular') {
        offset = mod(gap - anchor, L);
        if (offset > L / 2) offset -= L;
      } else offset = gap - anchor;
    }
    const d: DragState = {
      pointerId: e.pointerId,
      anchor,
      offset,
      head: gap,
      lastAngle: angle,
      startX: p.x,
      startY: p.y,
      moved: false,
    };
    dragRef.current = d;
    try {
      svgRef.current?.setPointerCapture?.(e.pointerId);
    } catch {
      // capture is best effort (unsupported in some test environments)
    }
    if (e.shiftKey && current) emit(dragSelection(d, geom));
    updateHover(null);
  };

  const onPointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (!geom) return;
    const p = localPoint(e);
    pointerRef.current = p;
    const d = dragRef.current;
    if (d && d.pointerId === e.pointerId) {
      const L = geom.model.length;
      const { angle } = cartesianToPolar(geom.cx, geom.cy, p.x, p.y);
      if (!d.moved && Math.hypot(p.x - d.startX, p.y - d.startY) < DRAG_THRESHOLD) {
        d.lastAngle = angle;
        return;
      }
      d.moved = true;
      const gap = angleToGap(geom.scale, angle);
      if (geom.model.topology === 'circular') {
        // Track the cumulative angle so drags can cross the origin in either direction.
        const cumulative = d.offset + angleDelta(d.lastAngle, angle) / degreesPerBase(geom.scale);
        let off = gap - d.anchor;
        off += Math.round((cumulative - off) / L) * L;
        d.offset = Math.max(-L, Math.min(L, off));
      } else {
        // Linear: follow the pointer, but never jump across the gap at the origin.
        d.head = Math.abs(gap - d.head) > L / 2 ? (d.head < L / 2 ? 0 : L) : gap;
      }
      d.lastAngle = angle;
      emit(dragSelection(d, geom));
      return;
    }
    const hit = hitTest(geom, placement, p.x, p.y);
    const interactive = hit.kind === 'ring' || hit.kind === 'background' ? null : hit;
    updateHover(interactive);
    const svg = svgRef.current;
    if (svg) svg.style.cursor = interactive ? 'pointer' : 'default';
    positionTooltip();
  };

  const endDrag = (e: ReactPointerEvent<SVGSVGElement>, commit: boolean) => {
    const d = dragRef.current;
    if (!d || d.pointerId !== e.pointerId) return;
    dragRef.current = null;
    try {
      svgRef.current?.releasePointerCapture?.(e.pointerId);
    } catch {
      // ignore
    }
    suppressClickRef.current = true;
    if (!commit || !geom) return;
    if (!d.moved) {
      // A plain click on the ring places the caret; shift+click already extended on press.
      if (!(e.shiftKey && selRef.current)) emit(caretAt(d.anchor));
    } else {
      emit(dragSelection(d, geom));
    }
  };

  const onClick = (e: ReactMouseEvent<SVGSVGElement>) => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    if (!geom) return;
    const p = localPoint(e);
    const hit = hitTest(geom, placement, p.x, p.y);
    const L = geom.model.length;
    const topology = geom.model.topology;
    switch (hit.kind) {
      case 'feature': {
        const extent = hit.shape.item.extent;
        const current = selRef.current;
        const range =
          e.shiftKey && current && hasSelectedBases(current) ? coverRanges(current.range, extent, L, topology) : extent;
        emit(selectRange(range, L, topology));
        onFeatureClick?.(hit.shape.id, {
          clickCount: Math.max(1, e.detail),
          shiftKey: e.shiftKey,
          metaKey: e.metaKey,
          ctrlKey: e.ctrlKey,
        });
        break;
      }
      case 'enzyme':
        onEnzymeClick?.(hit.shape.item.site);
        break;
      case 'primer':
        onPrimerClick?.(hit.shape.item.site.primerId);
        break;
      case 'orf':
        emit(selectRange(hit.shape.item.orf.range, L, topology));
        break;
      case 'background':
        if (selRef.current) emit(null);
        break;
      default:
        break;
    }
  };

  const onContextMenuEvent = (e: ReactMouseEvent<SVGSVGElement>) => {
    if (!onContextMenu || !geom) return;
    e.preventDefault();
    const p = localPoint(e);
    onContextMenu(hitToTarget(hitTest(geom, placement, p.x, p.y), geom), e);
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape' && selRef.current) emit(null);
  };

  const L = model.length;
  const ariaLabel = `Circular map of ${record.name || 'Untitled'}, ${formatBp(L)}, ${record.features.length} feature${
    record.features.length === 1 ? '' : 's'
  }`;
  const hoverFeatureId = hover?.kind === 'feature' ? hover.shape.id : null;

  return (
    <div
      ref={containerRef}
      className={cn(styles.root, className)}
      tabIndex={0}
      role="group"
      aria-label={ariaLabel}
      onKeyDown={onKeyDown}
    >
      {geom && (
        <svg
          ref={svgRef}
          className={styles.svg}
          width={geom.width}
          height={geom.height}
          viewBox={`0 0 ${geom.width} ${geom.height}`}
          role="img"
          aria-label={ariaLabel}
          data-testid="circular-map-svg"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={(e) => endDrag(e, true)}
          onPointerCancel={(e) => endDrag(e, false)}
          onPointerLeave={() => {
            pointerRef.current = null;
            if (!dragRef.current) updateHover(null);
          }}
          onClick={onClick}
          onContextMenu={onContextMenuEvent}
        >
          <SelectionUnderlay geom={geom} selection={sel} idPrefix={idPrefix} />
          <LeaderLayer placement={placement} />
          <ShapeLayer geom={geom} idPrefix={idPrefix} />
          <LabelLayer geom={geom} placement={placement} />
          <SelectionOverlay geom={geom} selection={sel} />
          <HoverLayer
            geom={geom}
            placement={placement}
            hover={hover}
            highlightedFeatureId={highlightedFeatureId !== hoverFeatureId ? highlightedFeatureId : null}
          />
        </svg>
      )}
      {geom && hover && (
        <div ref={tooltipRef} className={styles.tooltip} role="tooltip">
          <TooltipContent hit={hover} geom={geom} />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Layers
// ---------------------------------------------------------------------------

function selectionAngles(geom: MapGeometry, sel: SequenceSelection) {
  const r = normalizeRange(sel.range, geom.model.length, geom.model.topology);
  return { a0: positionToAngle(geom.scale, r.start), a1: positionToAngle(geom.scale, r.end) };
}

function SelectionUnderlay({
  geom,
  selection,
  idPrefix,
}: {
  geom: MapGeometry;
  selection: SequenceSelection | null;
  idPrefix: string;
}) {
  if (!hasSelectedBases(selection) || geom.model.length <= 0) return null;
  const { a0, a1 } = selectionAngles(geom, selection);
  const id = `${idPrefix}selfill`;
  // The wedge fades towards the centre: emphasis stays on the selected arc and the
  // record name in the middle remains legible.
  return (
    <g pointerEvents="none">
      <defs>
        <radialGradient id={id} gradientUnits="userSpaceOnUse" cx={geom.cx} cy={geom.cy} r={geom.radius}>
          <stop offset="0" className={styles.selStopCentre} />
          <stop offset="0.6" className={styles.selStopMid} />
          <stop offset="1" className={styles.selStopEdge} />
        </radialGradient>
      </defs>
      <path
        className={styles.selWedge}
        style={{ fill: `url(#${id})` }}
        d={wedgePath(geom.cx, geom.cy, geom.radius, a0, a1)}
        data-testid="circular-selection"
      />
    </g>
  );
}

function SelectionOverlay({ geom, selection }: { geom: MapGeometry; selection: SequenceSelection | null }) {
  if (!selection || geom.model.length <= 0) return null;
  const { cx, cy, radius: R } = geom;
  if (selection.range.end > selection.range.start) {
    const { a0, a1 } = selectionAngles(geom, selection);
    const full = a1 - a0 >= 359.999;
    return (
      <g pointerEvents="none">
        {!full && (
          <path
            className={styles.selEdge}
            d={`${radialLinePath(cx, cy, geom.centreRadius, R, a0)} ${radialLinePath(cx, cy, geom.centreRadius, R, a1)}`}
          />
        )}
        <path className={styles.selArc} d={arcPath(cx, cy, R, a0, a1)} />
      </g>
    );
  }
  const angle = positionToAngle(geom.scale, selection.range.start);
  const outer = geom.ringOuter + 3;
  const knob = polarToCartesian(cx, cy, outer + 2, angle);
  const inner = geom.ruler ? Math.min(geom.ruler.radius, R - 12) : Math.max(geom.centreRadius, 8);
  return (
    <g pointerEvents="none" data-testid="circular-caret">
      <path className={styles.caret} d={radialLinePath(cx, cy, inner, outer, angle)} />
      <circle className={styles.caretKnob} cx={knob.x} cy={knob.y} r={2.5} />
    </g>
  );
}

const LeaderLayer = memo(function LeaderLayer({ placement }: { placement: LabelPlacement | null }) {
  if (!placement || placement.labels.length === 0) return null;
  return <path className={styles.leader} d={placement.labels.map((l) => l.leader).join(' ')} />;
});

const ShapeLayer = memo(function ShapeLayer({ geom, idPrefix }: { geom: MapGeometry; idPrefix: string }) {
  const { cx, ruler, centre } = geom;
  const empty = geom.model.length <= 0;
  const withInside = geom.features.filter((f) => f.inside);
  return (
    <g>
      {withInside.length > 0 && (
        <defs>
          {withInside.map((f) => (
            <path key={f.inside!.key} id={`${idPrefix}${f.inside!.key}`} d={f.inside!.d} />
          ))}
        </defs>
      )}
      {ruler && (
        <g>
          {ruler.circle && <path className={styles.rulerCircle} d={ruler.circle} />}
          {ruler.minor && <path className={styles.tickMinor} d={ruler.minor} />}
          {ruler.major && <path className={styles.tickMajor} d={ruler.major} />}
          <path className={styles.tickOrigin} d={ruler.origin} />
          {ruler.labels.map((t) => (
            <text key={t.text} className={styles.tickLabel} x={t.x} y={t.y} style={{ fontSize: ruler.fontSize }}>
              {t.text}
            </text>
          ))}
        </g>
      )}
      <path className={empty ? styles.backboneEmpty : styles.backbone} d={geom.backbone} />
      {geom.backboneEnds && <path className={styles.backboneEnds} d={geom.backboneEnds} />}
      {geom.orfs.length > 0 && (
        <g>
          {geom.orfs.map((o) => (
            <path key={o.index} className={styles.orf} d={o.d} />
          ))}
        </g>
      )}
      <g>
        {geom.features.map((f) => (
          <g key={f.id} data-feature-id={f.id}>
            {f.connectors && <path className={styles.connector} d={f.connectors} style={{ stroke: f.stroke }} />}
            <path className={styles.feature} d={f.d} style={{ fill: f.fill, stroke: f.stroke }} />
            {f.inside && (
              <text className={styles.insideLabel} style={{ fontSize: f.inside.fontSize, fill: FEATURE_LABEL_ON_FILL }}>
                <textPath href={`#${idPrefix}${f.inside.key}`} startOffset="50%">
                  {f.inside.text}
                </textPath>
              </text>
            )}
          </g>
        ))}
      </g>
      {geom.primers.length > 0 && (
        <g>
          {geom.primers.map((p) => (
            <path
              key={p.index}
              className={p.item.site.strand === 1 ? styles.primerFwd : styles.primerRev}
              d={p.d}
            />
          ))}
        </g>
      )}
      {geom.enzymes.length > 0 && (
        <g>
          {geom.enzymes.map((e) => (
            <path key={e.index} className={cn(styles.enzymeTick, e.item.unique && styles.enzymeTickUnique)} d={e.d} />
          ))}
        </g>
      )}
      <g pointerEvents="none">
        {centre.name && (
          <text className={styles.centreName} x={cx} y={centre.nameY} style={{ fontSize: centre.nameSize }}>
            {centre.name}
          </text>
        )}
        <text className={styles.centreDetail} x={cx} y={centre.detailY} style={{ fontSize: centre.detailSize }}>
          {centre.detail}
        </text>
        {centre.note && (
          <text className={styles.centreNote} x={cx} y={centre.noteY} style={{ fontSize: centre.detailSize }}>
            {centre.note}
          </text>
        )}
      </g>
    </g>
  );
});

const TONE_CLASS: Record<LabelTone, string> = {
  feature: styles.label,
  enzyme: styles.labelEnzyme,
  enzymeUnique: styles.labelEnzymeUnique,
  primerFwd: styles.labelPrimerFwd,
  primerRev: styles.labelPrimerRev,
};

const LabelLayer = memo(function LabelLayer({
  geom,
  placement,
}: {
  geom: MapGeometry;
  placement: LabelPlacement | null;
}) {
  if (!placement) return null;
  const chip = labelChipSize(geom.labelFontSize);
  const chipW = chip + LABEL_CHIP_GAP;
  return (
    <g style={{ fontSize: geom.labelFontSize }}>
      {placement.labels.map((l) => {
        const c = l.candidate;
        const textX = c.chip ? l.x + l.side * chipW : l.x;
        return (
          <g key={c.key}>
            {c.chip && (
              <rect
                className={styles.chip}
                x={l.side === 1 ? l.x : l.x - chip}
                y={l.y - chip / 2}
                width={chip}
                height={chip}
                rx={2}
                style={{ fill: c.chip }}
              />
            )}
            <text
              className={TONE_CLASS[c.tone]}
              x={textX}
              y={l.baseline}
              textAnchor={l.side === 1 ? 'start' : 'end'}
              style={{ fontWeight: c.fontWeight }}
              data-label-key={c.key}
            >
              {c.text}
            </text>
          </g>
        );
      })}
      {placement.notes.map((n) => (
        <text key={n.anchor} className={styles.note} x={n.x} y={n.y} textAnchor={n.anchor}>
          {n.text}
        </text>
      ))}
    </g>
  );
});

function HoverLayer({
  geom,
  placement,
  hover,
  highlightedFeatureId,
}: {
  geom: MapGeometry;
  placement: LabelPlacement | null;
  hover: HitResult | null;
  highlightedFeatureId: string | null;
}) {
  const parts: ReactNode[] = [];
  const labelPill = (key: string) => {
    const l = placement?.byKey.get(key);
    if (!l) return;
    const b = l.box;
    parts.push(<path key={`lead-${key}`} className={styles.hoverLeader} d={l.leader} />);
    parts.push(
      <rect
        key={`pill-${key}`}
        className={styles.hoverLabel}
        x={b.x0 - 3}
        y={b.y0 + 0.5}
        width={b.x1 - b.x0 + 6}
        height={b.y1 - b.y0 - 1}
        rx={4}
      />,
    );
  };
  const featureEmphasis = (id: string) => {
    const f = geom.features.find((s) => s.id === id);
    if (!f) return;
    parts.push(<path key={`f-${id}`} className={styles.hoverFeature} d={f.d} />);
    labelPill(`f:${id}`);
  };
  if (highlightedFeatureId) featureEmphasis(highlightedFeatureId);
  if (hover) {
    switch (hover.kind) {
      case 'feature':
        featureEmphasis(hover.shape.id);
        break;
      case 'enzyme':
        parts.push(<path key="tick" className={styles.hoverTick} d={hover.shape.d} />);
        labelPill(`e:${hover.shape.index}`);
        break;
      case 'primer':
        parts.push(<path key="primer" className={styles.hoverShape} d={hover.shape.d} />);
        labelPill(`p:${hover.shape.index}`);
        break;
      case 'orf':
        parts.push(<path key="orf" className={styles.hoverShape} d={hover.shape.d} />);
        break;
      default:
        break;
    }
  }
  if (parts.length === 0) return null;
  return <g pointerEvents="none">{parts}</g>;
}

// ---------------------------------------------------------------------------
// Tooltip
// ---------------------------------------------------------------------------

function TooltipContent({ hit, geom }: { hit: HitResult; geom: MapGeometry }) {
  const L = geom.model.length;
  switch (hit.kind) {
    case 'feature': {
      const f = hit.shape.item.feature;
      const parts = f.segments.length;
      return (
        <>
          <div className={styles.ttTitle}>
            <span className={styles.ttSwatch} style={{ background: hit.shape.fill }} />
            <span className={styles.ttTitleText}>{f.name || f.type}</span>
          </div>
          <div className={styles.ttMeta}>
            {f.type} · {strandText(f.strand)}
            {parts > 1 ? ` · ${parts} segments` : ''}
          </div>
          <div className={styles.ttRange}>
            {formatRangeText(hit.shape.item.extent, L)} · {formatBp(featureLength(f))}
          </div>
        </>
      );
    }
    case 'enzyme': {
      const { site, unique, cuts } = hit.shape.item;
      const count = geom.model.enzymes.reduce((n, e) => n + (e.site.enzyme === site.enzyme ? e.site.cuts.length : 0), 0);
      const label = hit.shape.item.label;
      const at = label.slice(label.lastIndexOf('(') + 1, -1);
      return (
        <>
          <div className={styles.ttTitle}>
            <span className={styles.ttTitleText}>{site.enzyme}</span>
          </div>
          <div className={styles.ttMeta}>
            {unique ? 'Unique cutter' : count === 0 ? 'Does not cut' : `Cuts ${formatInt(count)} times`}
            {cuts.length ? ` · cuts after ${at}` : ''}
          </div>
          <div className={styles.ttRange}>
            Site {formatRangeText(normalizeRange(site.range, L, geom.model.topology), L)} ·{' '}
            {site.strand === 1 ? 'top strand' : 'bottom strand'}
          </div>
        </>
      );
    }
    case 'primer': {
      const s = hit.shape.item.site;
      return (
        <>
          <div className={styles.ttTitle}>
            <span className={styles.ttTitleText}>{hit.shape.item.name}</span>
          </div>
          <div className={styles.ttMeta}>
            {s.strand === 1 ? 'Forward primer' : 'Reverse primer'}
            {s.tm !== undefined ? ` · Tm ${s.tm.toFixed(1)} °C` : ''}
            {s.mismatches > 0 ? ` · ${s.mismatches} mismatch${s.mismatches === 1 ? '' : 'es'}` : ''}
          </div>
          <div className={styles.ttRange}>
            {formatRangeText(normalizeRange(s.range, L, geom.model.topology), L)} · {formatBp(s.annealedLength)}
            {s.tailLength > 0 ? ` + ${formatInt(s.tailLength)} nt tail` : ''}
          </div>
        </>
      );
    }
    case 'orf': {
      const o = hit.shape.item.orf;
      return (
        <>
          <div className={styles.ttTitle}>
            <span className={styles.ttTitleText}>ORF · {formatInt(o.aaLength)} aa</span>
          </div>
          <div className={styles.ttMeta}>
            Frame {o.strand === 1 ? '+' : '−'}
            {o.frame + 1} · {strandText(o.strand)}
            {o.hasStop ? '' : ' · no stop codon'}
          </div>
          <div className={styles.ttRange}>
            {formatRangeText(normalizeRange(o.range, L, geom.model.topology), L)} ·{' '}
            {formatBp(o.range.end - o.range.start)}
          </div>
        </>
      );
    }
    default:
      return null;
  }
}
