/**
 * <GelView />: a virtual agarose gel for digests and PCR products.
 *
 * Pure presentation: band positions (0 = well .. 1 = bottom) and intensities come from the gel
 * model in @hhereditas/core. The view lays the lanes out to fill its container (lanes share the
 * width up to 64 px each, centred; the slab fills the height), writes the ladder sizes at the left,
 * lane labels on top (rotated and truncated when long), and reports clicks on lanes and hovers on
 * bands. Pass a memoized `lanes` array: a new array re-runs the layout.
 *
 * Interaction: hover a band for its size(s) and fragment labels; hover a truncated lane label for
 * its full text (when lanes are too narrow for labels, hovering the lane names it). Keyboard: Tab to
 * the lanes, Left/Right/Home/End move between lanes, Up/Down (PageUp/PageDown) step through the bands
 * of the focused lane, Enter/Space click the lane, Escape hides the band tooltip.
 */
import {
  memo,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { useElementSize } from '../common/useElementSize';
import { GelBands, gelSvgId } from './GelBands';
import {
  describeGelBand,
  describeGelSmear,
  formatAgarose,
  gelDescriptionText,
  gelLaneAriaLabel,
  gelLaneName,
  type GelBandDescription,
} from './format';
import { computeGelLayout, hitTestGel, type GelHit, type GelLaneGeometry, type GelLayout, type GelRect } from './layout';
import { createGelTextMeasurer, useGelFontsVersion } from './measure';
import type { GelLane, GelLaneBand, GelSizeLabels } from './types';
import styles from './GelView.module.css';

export interface GelViewProps {
  /** Lanes from left to right. */
  lanes: readonly GelLane[];
  /** Agarose concentration (% w/v), written in a corner of the gel. */
  agarosePercent?: number;
  /** Lane drawn as selected (accent highlight). */
  selectedLaneId?: string | null;
  /** Called when a lane is clicked (or activated with Enter/Space). Makes the lanes selectable. */
  onLaneClick?: (laneId: string) => void;
  /**
   * Called when the band under the pointer (or the keyboard band cursor) changes; `band` is null when
   * it leaves the bands. For several unresolved bands of a smear, `band` summarises them (mean size,
   * total `count`).
   */
  onBandHover?: (laneId: string, band: GelLaneBand | null) => void;
  /** Size labels: 'ladder' (default) = ladder sizes at the left; 'all' = also next to sample bands; 'none'. */
  showSizes?: GelSizeLabels;
  className?: string;
}

/** Band under the pointer or the keyboard cursor. */
interface Inspection {
  laneId: string;
  laneIndex: number;
  bandIndex: number;
  range?: { start: number; end: number };
  source: 'pointer' | 'keyboard';
}

function cx(...names: Array<string | false | null | undefined>): string {
  return names.filter(Boolean).join(' ');
}

function rectStyle(r: GelRect): CSSProperties {
  return { left: r.x, top: r.y, width: r.width, height: r.height };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}

function sameInspection(a: Inspection | null, b: Inspection | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.laneId === b.laneId &&
    a.laneIndex === b.laneIndex &&
    a.bandIndex === b.bandIndex &&
    a.source === b.source &&
    a.range?.start === b.range?.start &&
    a.range?.end === b.range?.end
  );
}

/** The inspected lane geometry, if the inspection still matches the layout. */
function inspectedLane(layout: GelLayout | null, insp: Inspection | null): GelLaneGeometry | null {
  if (!layout || !insp) return null;
  const lane = layout.lanes[insp.laneIndex];
  if (!lane || lane.lane.id !== insp.laneId || insp.bandIndex < 0 || insp.bandIndex >= lane.bands.length) return null;
  if (insp.range && insp.range.end > lane.bands.length) return null;
  return lane;
}

/** Summary of several unresolved bands (smear lanes): a band with their mean size and total count. */
function aggregateBands(lane: GelLaneGeometry, start: number, end: number): { band: GelLaneBand; minSize: number; maxSize: number } {
  let mass = 0;
  let size = 0;
  let position = 0;
  let count = 0;
  let minSize = Infinity;
  let maxSize = 0;
  for (let i = start; i < end; i++) {
    const b = lane.bands[i].band;
    mass += b.intensity;
    size += b.intensity * b.size;
    position += b.intensity * b.position;
    count += Math.max(1, b.count ?? 1);
    minSize = Math.min(minSize, b.size);
    maxSize = Math.max(maxSize, b.size);
  }
  return {
    band: { size: size / mass, position: position / mass, intensity: Math.min(1, mass), count },
    minSize,
    maxSize,
  };
}

function describeInspection(lane: GelLaneGeometry, insp: Inspection): GelBandDescription {
  if (insp.range) {
    const agg = aggregateBands(lane, insp.range.start, insp.range.end);
    return describeGelSmear(agg.band.count ?? 1, agg.minSize, agg.maxSize);
  }
  return describeGelBand(lane.bands[insp.bandIndex].band);
}

export function GelView({
  lanes,
  agarosePercent,
  selectedLaneId = null,
  onLaneClick,
  onBandHover,
  showSizes = 'ladder',
  className,
}: GelViewProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const laneRefs = useRef<Array<HTMLDivElement | null>>([]);
  const reported = useRef<{ laneId: string; key: string } | null>(null);
  const aggregateCache = useRef<{ key: string; band: GelLaneBand } | null>(null);

  const { width, height } = useElementSize(rootRef);
  const fontsVersion = useGelFontsVersion();
  // a new measurer (empty cache) whenever web fonts finish loading
  const measure = useMemo(() => createGelTextMeasurer(), [fontsVersion]);
  const layout = useMemo(
    () => (width > 0 && height > 0 ? computeGelLayout(lanes, { width, height, showSizes, agarosePercent, measure }) : null),
    [lanes, width, height, showSizes, agarosePercent, measure],
  );

  // accessible names list the visible bands (genome digests have thousands: computed once per layout)
  const laneAriaLabels = useMemo(
    () => layout?.lanes.map((lane) => gelLaneAriaLabel(lane.lane, lane.index, lane.bands.map((b) => b.band))) ?? [],
    [layout],
  );

  const idBase = gelSvgId(useId());
  const tipId = `${idBase}-tip`;
  const [pointerLane, setPointerLane] = useState(-1);
  const [labelHover, setLabelHover] = useState(-1);
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const [focusIndex, setFocusIndex] = useState(-1);
  const [announcement, setAnnouncement] = useState('');

  const n = lanes.length;
  const clickable = onLaneClick !== undefined;
  const selectedIndex = selectedLaneId == null ? -1 : lanes.findIndex((l) => l.id === selectedLaneId);
  const tabStop = focusIndex >= 0 && focusIndex < n ? focusIndex : Math.max(0, selectedIndex);
  const activeLane = inspectedLane(layout, inspection);
  const active = activeLane && inspection ? inspection : null;

  /** The band object reported to onBandHover for an inspection. */
  const bandFor = (lane: GelLaneGeometry, insp: Inspection, key: string): GelLaneBand => {
    if (!insp.range) return lane.bands[insp.bandIndex].band;
    if (aggregateCache.current?.key !== key) {
      aggregateCache.current = { key, band: aggregateBands(lane, insp.range.start, insp.range.end).band };
    }
    return aggregateCache.current.band;
  };

  const inspect = (next: Inspection | null) => {
    if (!sameInspection(inspection, next)) setInspection(next);
    const lane = inspectedLane(layout, next);
    const key = lane && next ? `${next.laneId}#${next.range ? `${next.range.start}-${next.range.end}` : next.bandIndex}` : null;
    const prev = reported.current;
    if ((prev?.key ?? null) === key) return;
    if (lane && next && key) {
      reported.current = { laneId: next.laneId, key };
      onBandHover?.(next.laneId, bandFor(lane, next, key));
    } else if (prev) {
      reported.current = null;
      onBandHover?.(prev.laneId, null);
    }
  };

  const hitToInspection = (hit: GelHit | null, source: Inspection['source']): Inspection | null => {
    if (!layout || !hit || hit.bandIndex < 0) return null;
    const lane = layout.lanes[hit.laneIndex];
    return { laneId: lane.lane.id, laneIndex: hit.laneIndex, bandIndex: hit.bandIndex, range: hit.range, source };
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const canvas = canvasRef.current;
    if (!layout || !canvas) return;
    const r = canvas.getBoundingClientRect();
    const hit = hitTestGel(layout, e.clientX - r.left, e.clientY - r.top);
    setPointerLane(hit ? hit.laneIndex : -1);
    inspect(hitToInspection(hit, 'pointer'));
  };

  const onPointerLeave = () => {
    setPointerLane(-1);
    if (inspection?.source !== 'keyboard') inspect(null);
  };

  const focusLane = (index: number) => {
    const target = clamp(index, 0, n - 1);
    setFocusIndex(target);
    laneRefs.current[target]?.focus();
  };

  const stepBand = (laneIndex: number, delta: number) => {
    const lane = layout?.lanes[laneIndex];
    if (!lane || lane.bands.length === 0) {
      setAnnouncement(lane ? `${gelLaneName(lane.lane, laneIndex)}: no bands` : '');
      return;
    }
    const current = active && active.laneIndex === laneIndex && active.source === 'keyboard' ? active.bandIndex : -1;
    const next = current < 0 ? (delta > 0 ? 0 : lane.bands.length - 1) : clamp(current + delta, 0, lane.bands.length - 1);
    const insp: Inspection = { laneId: lane.lane.id, laneIndex, bandIndex: next, source: 'keyboard' };
    inspect(insp);
    setAnnouncement(gelDescriptionText(describeInspection(lane, insp)));
  };

  const onLaneKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>, index: number) => {
    let handled = true;
    switch (e.key) {
      case 'ArrowRight':
        focusLane(index + 1);
        break;
      case 'ArrowLeft':
        focusLane(index - 1);
        break;
      case 'Home':
        focusLane(0);
        break;
      case 'End':
        focusLane(n - 1);
        break;
      case 'ArrowDown':
        stepBand(index, 1);
        break;
      case 'ArrowUp':
        stepBand(index, -1);
        break;
      case 'PageDown':
        stepBand(index, 10);
        break;
      case 'PageUp':
        stepBand(index, -10);
        break;
      case 'Enter':
      case ' ':
        if (onLaneClick) onLaneClick(lanes[index].id);
        else handled = false;
        break;
      case 'Escape':
        if (inspection?.source === 'keyboard') inspect(null);
        else handled = false;
        break;
      default:
        handled = false;
    }
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  // Tooltip: a band (pointer or keyboard), a truncated lane label, or the lane under the pointer when
  // the lanes are too narrow for labels.
  const labelTip = layout && labelHover >= 0 ? layout.header.labels.find((l) => l.laneIndex === labelHover && l.truncated) : undefined;
  const tipContent = active && activeLane ? { lane: activeLane, description: describeInspection(activeLane, active) } : null;
  const laneTip =
    !tipContent && layout && layout.header.mode === 'hidden' && pointerLane >= 0 ? layout.lanes[pointerLane] : undefined;
  const showTip = tipContent !== null || labelTip !== undefined || laneTip !== undefined;

  useLayoutEffect(() => {
    const el = tipRef.current;
    if (!el || !layout) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    let left: number;
    let top: number;
    if (active && activeLane) {
      const first = activeLane.bands[active.range ? active.range.start : active.bandIndex];
      const lastBand = activeLane.bands[active.range ? active.range.end - 1 : active.bandIndex];
      const y = (first.y + lastBand.y) / 2;
      const labelEnd = activeLane.sizeLabels.reduce((m, l) => Math.max(m, l.x + l.width), activeLane.bandLeft + activeLane.bandWidth);
      left = labelEnd + 12;
      if (left + w > layout.width - 4) left = activeLane.bandLeft - 12 - w;
      left = clamp(left, 4, Math.max(4, layout.width - w - 4));
      top = clamp(y - h / 2, 4, Math.max(4, layout.height - h - 4));
    } else if (labelTip) {
      left = clamp(labelTip.x - w / 2, 4, Math.max(4, layout.width - w - 4));
      top = layout.slab.y + 6;
    } else if (laneTip) {
      left = clamp(laneTip.cx - w / 2, 4, Math.max(4, layout.width - w - 4));
      top = clamp(laneTip.well.y + laneTip.well.height + 6, 4, Math.max(4, layout.height - h - 4));
    } else {
      return;
    }
    el.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
    el.style.visibility = 'visible';
  });

  const figureLabel = [
    'Agarose gel',
    formatAgarose(agarosePercent),
    `${n} lane${n === 1 ? '' : 's'}`,
  ]
    .filter(Boolean)
    .join(', ');

  const overflowX = layout && layout.width > width + 0.5 ? 'auto' : 'hidden';
  const overflowY = layout && layout.height > height + 0.5 ? 'auto' : 'hidden';
  const slab = layout?.slab;
  // hover highlight only where a click does something
  const hoverLane = !clickable ? -1 : pointerLane >= 0 ? pointerLane : labelHover;

  return (
    <div ref={rootRef} className={cx(styles.root, className)} role="figure" aria-label={figureLabel} style={{ overflowX, overflowY }}>
      {layout && slab && (
        <div ref={canvasRef} className={styles.canvas} style={{ width: layout.width, height: layout.height }}>
          <div className={styles.slab} style={rectStyle(slab)} />
          <svg className={styles.layer} width={layout.width} height={layout.height} aria-hidden="true" focusable="false">
            {hoverLane >= 0 && hoverLane !== selectedIndex && layout.lanes[hoverLane] && (
              <LaneColumn className={styles.laneHover} lane={layout.lanes[hoverLane]} slab={slab} />
            )}
            {selectedIndex >= 0 && layout.lanes[selectedIndex] && (
              <LaneColumn className={styles.laneSelected} lane={layout.lanes[selectedIndex]} slab={slab} />
            )}
          </svg>
          <GelBands layout={layout} idBase={idBase} className={cx(styles.layer, styles.bandsLayer)} />
          <GelAnnotations
            layout={layout}
            activeLane={active ? active.laneIndex : -1}
            activeBand={active && !active.range ? active.bandIndex : -1}
          />
          {active && activeLane && <BandFocus lane={activeLane} inspection={active} layout={layout} />}
          {n === 0 && (
            <div className={styles.empty} style={rectStyle(slab)}>
              No lanes
            </div>
          )}
          {layout.header.labels.map((l) => {
            const mode = layout.header.mode;
            const lh = layout.header.lineHeight;
            const style: CSSProperties =
              mode === 'horizontal'
                ? { left: l.x, top: l.y - lh, maxWidth: l.maxWidth + (l.truncated ? 0 : 2) }
                : mode === 'diagonal'
                  ? { left: l.x + lh * 0.35, top: l.y - lh + lh * 0.35, maxWidth: l.maxWidth + (l.truncated ? 0 : 2) }
                  : { left: l.x + lh / 2, top: l.y - lh, maxWidth: l.maxWidth + (l.truncated ? 0 : 2) };
            return (
              <div
                key={l.laneIndex}
                aria-hidden="true"
                className={cx(
                  styles.laneLabel,
                  mode === 'horizontal' && styles.laneLabelCentered,
                  mode === 'diagonal' && styles.laneLabelDiagonal,
                  mode === 'vertical' && styles.laneLabelVertical,
                  hoverLane === l.laneIndex && styles.laneLabelHover,
                  selectedIndex === l.laneIndex && styles.laneLabelSelected,
                  clickable && styles.laneLabelClickable,
                )}
                style={style}
                onPointerEnter={() => setLabelHover(l.laneIndex)}
                onPointerLeave={() => setLabelHover(-1)}
                onClick={onLaneClick ? () => onLaneClick(lanes[l.laneIndex].id) : undefined}
              >
                {l.text}
              </div>
            );
          })}
          <div
            className={styles.surface}
            style={rectStyle(slab)}
            role={clickable ? 'listbox' : 'list'}
            aria-label="Lanes"
            aria-orientation={clickable ? 'horizontal' : undefined}
            onPointerMove={onPointerMove}
            onPointerDown={onPointerMove}
            onPointerLeave={onPointerLeave}
          >
            {layout.lanes.map((lane) => {
              const i = lane.index;
              const selected = i === selectedIndex;
              return (
                <div
                  key={lane.lane.id}
                  ref={(el) => {
                    laneRefs.current[i] = el;
                  }}
                  role={clickable ? 'option' : 'listitem'}
                  aria-selected={clickable ? selected : undefined}
                  aria-label={laneAriaLabels[i]}
                  aria-describedby={active && active.laneIndex === i && active.source === 'keyboard' ? tipId : undefined}
                  tabIndex={i === tabStop ? 0 : -1}
                  className={cx(styles.lane, clickable && styles.clickable)}
                  style={{ left: lane.x - slab.x, width: lane.width, height: slab.height }}
                  onClick={onLaneClick ? () => onLaneClick(lane.lane.id) : undefined}
                  onKeyDown={(e) => onLaneKeyDown(e, i)}
                  onFocus={() => setFocusIndex(i)}
                  onBlur={() => {
                    if (inspection?.source === 'keyboard') inspect(null);
                  }}
                />
              );
            })}
          </div>
          {showTip && (
            <div ref={tipRef} id={tipId} role="tooltip" className={styles.tooltip}>
              {tipContent ? (
                <TooltipBody laneName={gelLaneName(tipContent.lane.lane, tipContent.lane.index)} d={tipContent.description} />
              ) : labelTip ? (
                <div className={styles.tipText}>{labelTip.text}</div>
              ) : laneTip ? (
                <div className={styles.tipText}>{gelLaneName(laneTip.lane, laneTip.index)}</div>
              ) : null}
            </div>
          )}
        </div>
      )}
      <div className={styles.srOnly} aria-live="polite">
        {announcement}
      </div>
    </div>
  );
}

function LaneColumn({ lane, slab, className }: { lane: GelLaneGeometry; slab: GelRect; className: string }) {
  return (
    <rect
      className={className}
      x={lane.x + 2.5}
      y={slab.y + 3.5}
      width={Math.max(1, lane.width - 5)}
      height={Math.max(1, slab.height - 7)}
      rx={6}
    />
  );
}

/** Dashed guide across the gel at the inspected band plus a ring around it. */
function BandFocus({ lane, inspection, layout }: { lane: GelLaneGeometry; inspection: Inspection; layout: GelLayout }) {
  const first = lane.bands[inspection.range ? inspection.range.start : inspection.bandIndex];
  const last = lane.bands[inspection.range ? inspection.range.end - 1 : inspection.bandIndex];
  const top = first.y - first.height / 2 - 2.5;
  const bottom = last.y + last.height / 2 + 2.5;
  const y = Math.round((first.y + last.y) / 2) + 0.5;
  const { slab } = layout;
  // the guide resumes after the band's own size label, if it has one at that height
  const label = inspection.range ? undefined : lane.sizeLabels.find((l) => l.bandIndex === inspection.bandIndex && Math.abs(l.y - y) < 7);
  const rightStart = label ? label.x + label.width + 5 : lane.bandLeft + lane.bandWidth + 5;
  const rightEnd = slab.x + slab.width - 6;
  return (
    <svg className={styles.layer} width={layout.width} height={layout.height} aria-hidden="true" focusable="false">
      <line className={styles.guide} x1={slab.x + 6} x2={lane.bandLeft - 5} y1={y} y2={y} />
      {rightEnd > rightStart && <line className={styles.guide} x1={rightStart} x2={rightEnd} y1={y} y2={y} />}
      <rect
        className={styles.ring}
        x={lane.bandLeft - 2.5}
        y={top}
        width={lane.bandWidth + 5}
        height={Math.max(4, bottom - top)}
        rx={3}
      />
    </svg>
  );
}

/** Ladder sizes, ticks, size labels and the caption. Re-renders only with the layout or the active band. */
const GelAnnotations = memo(function GelAnnotations({
  layout,
  activeLane,
  activeBand,
}: {
  layout: GelLayout;
  activeLane: number;
  activeBand: number;
}) {
  const { ladderLabels, ladderTicks, caption } = layout;
  return (
    <svg className={styles.layer} width={layout.width} height={layout.height} aria-hidden="true" focusable="false">
      {ladderTicks.map((t, i) => (
        <line key={`t${i}`} className={styles.tick} x1={t.x1} x2={t.x2} y1={Math.round(t.y) + 0.5} y2={Math.round(t.y) + 0.5} />
      ))}
      {ladderLabels.map((l) => {
        const [x0, y0, x1, , x2, y2] = l.leader;
        const ladderLane = l.side === 'left' ? layout.ladderLeft : layout.ladderRight;
        const isActive = activeLane === ladderLane && activeBand === l.bandIndex;
        const ry0 = Math.round(y0) + 0.5;
        return (
          <g key={`${l.side}${l.bandIndex}`}>
            <polyline
              className={styles.leader}
              points={`${x0},${ry0} ${x1},${ry0} ${x2},${y2 === y0 ? ry0 : y2}`}
            />
            <text
              className={cx(styles.ladderLabel, l.emphasized && styles.ladderLabelStrong, isActive && styles.ladderLabelActive)}
              x={l.x}
              y={l.y}
              dy="0.35em"
              textAnchor={l.side === 'left' ? 'end' : 'start'}
            >
              {l.text}
            </text>
          </g>
        );
      })}
      {layout.lanes.map((lane) =>
        lane.sizeLabels.map((s) => {
          const isActive = activeLane === lane.index && activeBand === s.bandIndex;
          return (
            <text
              key={`${lane.index}:${s.bandIndex}`}
              className={cx(styles.sizeLabel, s.emphasized && styles.sizeLabelStrong, isActive && styles.sizeLabelActive)}
              x={s.x}
              y={s.y}
              dy="0.35em"
            >
              {s.text}
            </text>
          );
        }),
      )}
      {caption && (
        <text className={styles.caption} x={caption.x} y={caption.y} textAnchor="end">
          {caption.text}
        </text>
      )}
    </svg>
  );
});

function TooltipBody({ laneName, d }: { laneName: string; d: GelBandDescription }) {
  return (
    <>
      <div className={styles.tipLane}>{laneName}</div>
      <div className={styles.tipTitle}>{d.title}</div>
      {d.details.map((t) => (
        <div key={t} className={styles.tipDetail}>
          {t}
        </div>
      ))}
      {d.labels.length > 0 && (
        <ul className={styles.tipLabels}>
          {d.labels.map((l, i) => (
            <li key={`${i}:${l}`}>{l}</li>
          ))}
          {d.moreLabels > 0 && <li className={styles.tipMore}>+ {d.moreLabels} more</li>}
        </ul>
      )}
    </>
  );
}
