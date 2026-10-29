/**
 * <LinearMap />: horizontal map of a sequence record. The main view for linear records and an
 * alternative view of circular ones (drawn from the origin).
 *
 * Interaction model (macOS conventions):
 *  - ⌘/ctrl + wheel or a trackpad pinch zooms around the pointer; a horizontal swipe or
 *    shift + wheel pans; with the map focused, ← → pan, + − zoom, 0 zooms to fit, Home / End
 *    jump to the ends, Esc clears the selection;
 *  - drag anywhere to select bases (selections snap to the gaps between bases); click a feature,
 *    primer or ORF to select it, shift-click to extend; double-click a feature to zoom to it;
 *    click the backbone to place the caret, empty space to clear the selection, double-click
 *    empty space to zoom in;
 *  - hovering shows a card; the slim bar at the bottom pans while zoomed in.
 * The component is presentational: selection and viewport may be controlled (pass `selection`
 * / `viewport`) or left to the component.
 */
import type { EnzymeSite, Orf, PrimerBindingSite, Range, SeqRecord } from '@hhereditas/core';
import { normalizeRange } from '@hhereditas/core';
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  RefObject,
} from 'react';
import { useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react';
import { formatBp, formatInt } from '../common/format';
import { useElementSize } from '../common/useElementSize';
import type { SequenceSelection } from '../selection';
import { caretAt, selectBetween, selectRange } from '../selection';
import { buildCutMarkers } from './enzymeLabels';
import type { HitInput } from './hitTest';
import { featureEntryIndex, featureOnScreen, featureOutline, hitTest, positionsAt } from './hitTest';
import type { FeatureEntry, ViewInput, ViewModel } from './layout';
import {
  CUT_OVERSHOOT,
  METRICS,
  buildAlignmentTrack,
  buildFeatureTrack,
  buildOrfTrack,
  buildPrimerTrack,
  computeView,
  contentOffsetY,
  enzymeRowsToReserve,
  featureLabelRowsToReserve,
  primerLabelRowsToReserve,
} from './layout';
import styles from './LinearMap.module.css';
import { AlignmentLayer, HighlightLayer, MapContent, SelectionOverlay, SelectionUnderlay } from './LinearMapLayers';
import { targetKey, tooltipContent } from './LinearMapTooltip';
import { extendSelection, extendSelectionToRange } from './selectionGeometry';
import { vlinePath } from './shapes';
import type { TextMeasurer } from './textMeasure';
import { createCanvasMeasurer, estimateTextWidth } from './textMeasure';
import type { FeatureClickInfo, MapShowOptions, MapTarget } from './types';
import {
  clampViewport,
  fullViewport,
  interpolateViewport,
  isFullViewport,
  makeScale,
  panViewport,
  sameViewport,
  viewportForRange,
  zoomViewport,
} from './viewport';

export interface LinearMapProps {
  record: SeqRecord;
  /** Sites to draw, already filtered by the app: every one given is shown. */
  enzymeSites?: readonly EnzymeSite[];
  /** Primer binding sites; names come from record.primers (matched by primerId). */
  primerSites?: readonly PrimerBindingSite[];
  orfs?: readonly Orf[];
  /** Controlled selection (null = nothing selected). Leave undefined to let the map keep its own. */
  selection?: SequenceSelection | null;
  onSelectionChange?: (selection: SequenceSelection | null) => void;
  /** Feature to emphasise, e.g. the one hovered in the sidebar. */
  highlightedFeatureId?: string | null;
  /** Multiple features selected (e.g. via Ctrl+Click). */
  selectedFeatureIds?: readonly string[];
  onFeatureClick?: (featureId: string, info: FeatureClickInfo) => void;
  onFeatureHover?: (featureId: string | null) => void;
  onEnzymeClick?: (site: EnzymeSite) => void;
  onPrimerClick?: (primerId: string, info: FeatureClickInfo) => void;
  onContextMenu?: (target: MapTarget, event: ReactMouseEvent) => void;
  show?: MapShowOptions;
  /** Slide the aligned sequences in and out when they are shown or hidden (default true; off for a hidden map). */
  animateAlignments?: boolean;
  /**
   * The map's width is about to change in an animation: it is laid out once for the coming width (stretched to the
   * live width meanwhile) and its labels glide to their new places with the animation's timing.
   */
  widthChange?: MapWidthChange;
  className?: string;
  /**
   * Visible window in bp (fractional bounds allowed). Uncontrolled by default (the whole
   * record). When controlled, set it to fullViewport(length) to zoom to fit or to
   * viewportForRange(selection.range, …) to zoom to the selection; the map glides there.
   * Zoom buttons can pass zoomViewport(viewport, 2 or 0.5, centre, length, 0): the map clamps
   * whatever it receives to its own width and deepest zoom (and reports the clamped window).
   */
  viewport?: Range;
  onViewportChange?: (viewport: Range) => void;
}

/** Minimal shape of WebKit's GestureEvent (trackpad pinch in Safari / WKWebView). */
interface GestureLikeEvent extends Event {
  scale: number;
  clientX: number;
  clientY: number;
}

interface Press {
  pointerId: number;
  x: number;
  y: number;
  dragging: boolean;
  /** Gap where the drag started. */
  anchor: number;
  /** With shift: the selection being extended. */
  extendFrom: SequenceSelection | null;
}

const DRAG_THRESHOLD = 3;
const TOOLTIP_DELAY = 450;
const TOOLTIP_WARM = 600;
const ANIMATION_MS = 320;
const AUTOSCROLL_EDGE = 16;

function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/** Text measurer bound to the element's resolved UI font; re-created once web fonts load. */
function useTextMeasurer(ref: RefObject<HTMLElement | null>): TextMeasurer {
  const [family, setFamily] = useState<string | null>(null);
  const [fontsVersion, setFontsVersion] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && typeof getComputedStyle === 'function') setFamily(getComputedStyle(el).fontFamily || 'sans-serif');
  }, [ref]);
  useEffect(() => {
    const fonts = typeof document !== 'undefined' ? document.fonts : undefined;
    if (!fonts) return;
    let alive = true;
    const bump = () => {
      if (alive) setFontsVersion((v) => v + 1);
    };
    void fonts.ready.then(bump);
    fonts.addEventListener?.('loadingdone', bump);
    return () => {
      alive = false;
      fonts.removeEventListener?.('loadingdone', bump);
    };
  }, []);
  return useMemo(() => {
    void fontsVersion;
    return (family ? createCanvasMeasurer(family) : null) ?? estimateTextWidth;
  }, [family, fontsVersion]);
}

export function LinearMap(props: LinearMapProps) {
  const { record, enzymeSites, primerSites, orfs, show, className, animateAlignments = true } = props;
  const L = record.seq.length;
  const topology = record.topology;

  const rootRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  // The scroller's content box: the pane minus a vertical scrollbar, if one is shown.
  const size = useElementSize(scrollerRef);
  const measure = useTextMeasurer(rootRef);
  // While the map is being resized the layout of the last settled width is kept and stretched to the live width
  // (labels keep their places instead of jumping between placements at every pixel); it is laid out anew once the
  // width has stopped changing.
  const liveWidth = size.width;
  const settledWidth = useSettledWidth(liveWidth);
  // an announced width change (a side panel sliding) is laid out once, for the coming width
  const announced = useAnnouncedWidth(liveWidth, props.widthChange?.by ?? 0);
  const width = announced?.width ?? settledWidth;
  // That drawing is shown squeezed (or spread) over the plot to the pane's width, and lets go with the panel's
  // timing: the map then follows the panel exactly, with nothing laid out or drawn anew at any frame. Text keeps its
  // shape (counter-scaled, see .stretched in the stylesheet).
  const widthChangeRef = useRef(props.widthChange);
  widthChangeRef.current = props.widthChange;
  const announcedKey = announced?.key ?? 0;
  useLayoutEffect(() => {
    const svg = svgRef.current;
    const change = widthChangeRef.current;
    if (!svg || !announced || !change || typeof svg.animate !== 'function') return;
    for (const a of svg.getAnimations()) a.cancel();
    const pad = METRICS.padX;
    const s = (announced.from - 2 * pad) / Math.max(1, announced.width - 2 * pad);
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduced || Math.abs(s - 1) < 0.001) return;
    svg.animate(
      [
        { transform: `translateX(${pad * (1 - s)}px) scaleX(${s})`, '--hh-unstretch': String(1 / s) },
        { transform: 'none', '--hh-unstretch': '1' },
      ],
      { duration: change.duration, delay: change.delay, easing: change.easing, fill: 'backwards' },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per announced change
  }, [announcedKey]);
  const plotLeft = METRICS.padX;
  const plotWidth = Math.max(1, width - 2 * METRICS.padX);

  // ---- static tracks (zoom independent) ---------------------------------------------
  const showFeatures = show?.features !== false;
  const showEnzymes = show?.enzymes !== false;
  const showPrimers = show?.primers !== false;
  const showOrfs = show?.orfs !== false;
  const showAlignments = show?.alignments !== false;
  const showLengths = Boolean(show?.lengths);
  const showPrimerLocations = Boolean(show?.primerLocations);
  const featureTrack = useMemo(
    () => (showFeatures && record.features.length > 0 && L > 0 ? buildFeatureTrack(record.features, L, topology) : null),
    [showFeatures, record.features, L, topology],
  );
  const orfTrack = useMemo(
    () => (showOrfs && orfs && orfs.length > 0 && L > 0 ? buildOrfTrack(orfs, L, topology) : null),
    [showOrfs, orfs, L, topology],
  );
  const primerTrack = useMemo(
    () =>
      showPrimers && primerSites && primerSites.length > 0 && L > 0
        ? buildPrimerTrack(primerSites, record.primers, L, topology)
        : null,
    [showPrimers, primerSites, record.primers, L, topology],
  );
  // the aligned sequences are laid out at once; their band slides in and out (see the band section below)
  const alnPresent = showAlignments;
  const alignmentTrack = useMemo(
    () => (alnPresent && L > 0 ? buildAlignmentTrack(record.alignedSequences, L, topology) : null),
    [alnPresent, record.alignedSequences, L, topology],
  );
  const markers = useMemo(
    () => (showEnzymes && enzymeSites && enzymeSites.length > 0 && L > 0 ? buildCutMarkers(enzymeSites, L, topology) : null),
    [showEnzymes, enzymeSites, L, topology],
  );
  const enzymeRows = useMemo(
    () => (markers && width > 0 ? enzymeRowsToReserve(markers, L, plotLeft, plotWidth, width, measure) : 0),
    [markers, L, plotLeft, plotWidth, width, measure],
  );
  const primerLabelRows = useMemo(
    () =>
      primerTrack && width > 0
        ? primerLabelRowsToReserve(
            primerTrack,
            L,
            plotLeft,
            plotWidth,
            width,
            measure,
            Boolean(showPrimerLocations),
            Boolean(showLengths),
            new Map(record.primers.map((p) => [p.id, p.sequence.length] as const)),
          )
        : undefined,
    [primerTrack, L, plotLeft, plotWidth, width, measure, showPrimerLocations, showLengths, record.primers],
  );

  // ---- selection ----------------------------------------------------------------------
  const selectionControlled = props.selection !== undefined;
  const [internalSel, setInternalSel] = useState<{ id: string; sel: SequenceSelection | null } | null>(null);
  const selection: SequenceSelection | null = selectionControlled
    ? (props.selection ?? null)
    : internalSel && internalSel.id === record.id
      ? internalSel.sel
      : null;

  // ---- viewport ---------------------------------------------------------------------
  const controlled = props.viewport !== undefined;
  const [internalVp, setInternalVp] = useState<{ id: string; vp: Range } | null>(null);
  const target: Range = controlled
    ? (props.viewport as Range)
    : internalVp && internalVp.id === record.id
      ? internalVp.vp
      : fullViewport(L);
  const [animVp, setAnimVp] = useState<Range | null>(null);
  // Re-renders after a controlled change, so a parent that keeps its viewport snaps us back.
  const [, resync] = useReducer((n: number) => n + 1, 0);
  const shownRaw = clampViewport(animVp ?? target, L, plotWidth);
  const shownStart = shownRaw.start;
  const shownEnd = shownRaw.end;
  const shown = useMemo<Range>(() => ({ start: shownStart, end: shownEnd }), [shownStart, shownEnd]);
  const scale = useMemo(() => makeScale(shown, plotLeft, plotWidth), [shown, plotLeft, plotWidth]);

  // Labels of the highlighted feature and of a selected feature win when space runs out.
  const highlightId = props.highlightedFeatureId ?? null;
  const selectedIds = props.selectedFeatureIds;
  const selStart = selection?.range.start ?? -1;
  const selEnd = selection?.range.end ?? -1;
  const pinnedKey = useMemo(() => {
    const ids: string[] = [];
    if (highlightId) ids.push(highlightId);
    if (selectedIds) {
      for (const id of selectedIds) if (!ids.includes(id)) ids.push(id);
    }
    if (featureTrack && selEnd > selStart && L > 0) {
      const r = normalizeRange({ start: selStart, end: selEnd }, L, topology);
      for (const e of featureTrack.entries) {
        if (e.extent.start === r.start && e.extent.end === r.end && !ids.includes(e.feature.id)) ids.push(e.feature.id);
      }
    }
    return ids.join('\u0000');
  }, [highlightId, selectedIds, featureTrack, selStart, selEnd, L, topology]);

  // Rows of outside feature labels: what the whole-record view needs, so the map keeps its height while panning.
  const featureLabelRows = useMemo(() => {
    if (!featureTrack || width <= 0 || L <= 0) return undefined;
    const whole = makeScale(fullViewport(L), plotLeft, plotWidth);
    return featureLabelRowsToReserve({
      record,
      width,
      scale: whole,
      features: featureTrack,
      orfs: orfTrack,
      primers: primerTrack,
      alignments: alignmentTrack,
      markers,
      enzymeRows,
      primerLabelRows,
      measure,
      showLengths,
      showPrimerLocations,
    });
  }, [record, width, plotLeft, plotWidth, L, featureTrack, orfTrack, primerTrack, alignmentTrack, markers, enzymeRows, primerLabelRows, measure, showLengths, showPrimerLocations]);
  const baseInput = useMemo<ViewInput | null>(
    () =>
      width > 0 && L > 0
        ? {
            record,
            width,
            scale,
            features: featureTrack,
            orfs: orfTrack,
            primers: primerTrack,
            alignments: alignmentTrack,
            markers,
            enzymeRows,
            primerLabelRows,
            featureLabelRows,
            measure,
            showLengths,
            showPrimerLocations,
          }
        : null,
    [record, width, scale, featureTrack, orfTrack, primerTrack, alignmentTrack, markers, enzymeRows, primerLabelRows, featureLabelRows, measure, showLengths, showPrimerLocations, L],
  );
  const baseView = useMemo(() => (baseInput ? computeView(baseInput) : null), [baseInput]);
  const view = useMemo<ViewModel | null>(() => {
    if (!baseInput || !baseView || !pinnedKey || !featureTrack) return baseView;
    const pinned = new Set(pinnedKey.split('\u0000'));
    const labelled = new Set(baseView.features.labels.map((l) => l.entry));
    // A second pass (pinned labels placed first) only when a pinned feature on screen lost its label.
    const missing = [...pinned].some((id) => {
      const idx = featureEntryIndex(featureTrack, id);
      if (idx < 0 || labelled.has(idx)) return false;
      return featureOnScreen(baseView, featureTrack, idx);
    });
    return missing ? computeView({ ...baseInput, pinnedFeatureIds: pinned }) : baseView;
  }, [baseInput, baseView, pinnedKey, featureTrack]);
  // labels that change place as the map narrows or widens glide there; new ones rise in

  // ---- hover / tooltip ----------------------------------------------------------------
  const [hoverTarget, setHoverTarget] = useState<MapTarget | null>(null);
  const [tooltipOn, setTooltipOn] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [thumbActive, setThumbActive] = useState(false);

  // ---- latest values for event handlers, timers and animation frames -------------------
  const latest = useRef({
    props,
    L,
    topology,
    plotLeft,
    plotWidth,
    view,
    scale,
    selection,
    controlled,
    selectionControlled,
    featureTrack,
    orfTrack,
    primerTrack,
    markers,
  });
  useLayoutEffect(() => {
    latest.current = {
      props,
      L,
      topology,
      plotLeft,
      plotWidth,
      view,
      scale,
      selection,
      controlled,
      selectionControlled,
      featureTrack,
      orfTrack,
      primerTrack,
      markers,
    };
  });

  /** What is on screen (the current animation frame while gliding); pointer gestures build on it. */
  const liveVp = useRef<Range>(shown);
  /** The newest viewport requested (an animation's destination); keyboard steps build on it. */
  const goalVp = useRef<Range>(shown);
  const lastEmitted = useRef<Range | null>(null);
  const animFrame = useRef<number | null>(null);
  const prevTarget = useRef<{ id: string; vp: Range } | null>(null);
  const shownRef = useRef<Range>(shown);

  const stopAnimation = () => {
    if (animFrame.current !== null) {
      cancelAnimationFrame(animFrame.current);
      animFrame.current = null;
    }
  };

  const animateTo = (from: Range, to: Range, done: () => void) => {
    stopAnimation();
    const t0 = performance.now();
    setAnimVp(from);
    // Elapsed time from performance.now() on both ends, not the frame timestamp: hosts may give
    // requestAnimationFrame another clock (jsdom counts from window creation), which stalled the glide.
    const tick = () => {
      const t = Math.min(1, (performance.now() - t0) / ANIMATION_MS);
      if (t < 1) {
        const vp = interpolateViewport(from, to, easeInOutCubic(t));
        liveVp.current = vp;
        setAnimVp(vp);
        animFrame.current = requestAnimationFrame(tick);
      } else {
        animFrame.current = null;
        liveVp.current = to;
        done();
      }
    };
    animFrame.current = requestAnimationFrame(tick);
  };

  const commitViewport = (c: Range) => {
    const cur = latest.current;
    liveVp.current = c;
    goalVp.current = c;
    lastEmitted.current = c;
    if (!cur.controlled) setInternalVp({ id: cur.props.record.id, vp: c });
    else resync();
    cur.props.onViewportChange?.(c);
  };

  /** Change the viewport (clamped). Animated changes glide over ~300 ms. */
  const setViewport = (vp: Range, animate = false) => {
    const cur = latest.current;
    const c = clampViewport(vp, cur.L, cur.plotWidth);
    goalVp.current = c;
    if (animate && !prefersReducedMotion()) {
      animateTo(liveVp.current, c, () => {
        // committed and handed over in one render (state updates in a frame callback batch)
        commitViewport(c);
        setAnimVp(null);
      });
      return;
    }
    stopAnimation();
    setAnimVp(null);
    commitViewport(c);
  };

  // External viewport changes (controlled mode: zoom to fit / to selection from the app) glide
  // from what is on screen. Changes that echo our own onViewportChange are applied directly.
  useLayoutEffect(() => {
    const prev = prevTarget.current;
    prevTarget.current = { id: record.id, vp: target };
    if (!controlled || !prev || prev.id !== record.id || sameViewport(prev.vp, target)) return;
    if (sameViewport(target, lastEmitted.current)) return;
    if (prefersReducedMotion() || L <= 0) return;
    const to = clampViewport(target, L, plotWidth);
    if (sameViewport(to, shownRef.current)) return;
    goalVp.current = to;
    animateTo(shownRef.current, to, () => setAnimVp(null));
  }, [controlled, record.id, target.start, target.end]);

  useLayoutEffect(() => {
    shownRef.current = shown;
    if (animFrame.current === null) {
      liveVp.current = shown;
      goalVp.current = shown;
    }
  });

  // A controlled viewport is shown clamped (no deeper than MAX_PX_PER_BASE, inside the record,
  // tiny records centred). Tell the app once, so its state matches the screen: a zoom-out button
  // then acts on what is visible. Runs only when the numbers change, so a parent that ignores
  // the report is not asked again.
  const targetStart = target.start;
  const targetEnd = target.end;
  useEffect(() => {
    if (!controlled || width <= 0 || L <= 0) return;
    const asked = { start: targetStart, end: targetEnd };
    const c = clampViewport(asked, L, plotWidth);
    if (sameViewport(c, asked)) return;
    lastEmitted.current = c;
    latest.current.props.onViewportChange?.(c);
  }, [controlled, targetStart, targetEnd, L, plotWidth, width]);

  useEffect(() => () => stopAnimation(), []);

  // ---- selection helpers ----------------------------------------------------------------
  const emitSelection = (sel: SequenceSelection | null) => {
    const cur = latest.current;
    if (!cur.selectionControlled) setInternalSel({ id: cur.props.record.id, sel });
    cur.props.onSelectionChange?.(sel);
  };

  /** Select `range` (an item that was clicked), or grow the selection to cover it with shift. */
  const selectItem = (range: Range, shift: boolean) => {
    const { selection: sel, L: len, topology: topo } = latest.current;
    emitSelection(shift ? extendSelectionToRange(sel, range, len, topo) : selectRange(range, len, topo));
  };

  // ---- coordinates and hit testing ------------------------------------------------------
  // The map content is centred vertically (slightly above centre) when the pane is taller.
  const contentHeight = view?.height ?? 0;
  const offsetY = contentOffsetY(size.height, contentHeight);
  // ---- aligned sequences: shown and hidden with a slide --------------------------------
  // Showing them: the layout opens their band's space at once (the map glides there, see useMapGlide) and the band
  // slides in from the right once the space is open. Hiding them: the band, as last drawn, slides out to the right
  // while the layout (already without it) waits, then the map glides on.
  const prevShowRef = useRef(showAlignments);
  const bandFlip: 'on' | 'off' | null = prevShowRef.current === showAlignments ? null : showAlignments ? 'on' : 'off';
  useLayoutEffect(() => {
    prevShowRef.current = showAlignments;
  });
  const bandRef = useRef<SVGGElement>(null);
  const leavingRef = useRef<SVGGElement>(null);
  const lastBand = useRef<{ alignments: ViewModel['alignments']; offsetY: number; width: number } | null>(null);
  const [leaving, setLeaving] = useState<{ alignments: ViewModel['alignments']; offsetY: number; width: number; key: number } | null>(null);
  const bandAnimated = animateAlignments && !(typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
  const bandTiming: GlideTiming | null | undefined = !bandFlip
    ? undefined
    : !bandAnimated
      ? null
      : bandFlip === 'on'
        ? { delay: GLIDE_LEAD, duration: ALIGNMENT_REVEAL.open, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' }
        : { delay: ALIGNMENT_REVEAL.slideOut, duration: ALIGNMENT_REVEAL.close, easing: 'cubic-bezier(0.4, 0, 0.2, 1)' };
  useLayoutEffect(() => {
    if (!bandFlip || !bandAnimated) return;
    if (bandFlip === 'off') {
      const last = lastBand.current;
      if (last) setLeaving({ ...last, key: performance.now() });
      return;
    }
    setLeaving(null);
    const g = bandRef.current;
    if (!g || !view || typeof g.animate !== 'function') return;
    for (const a of g.getAnimations()) a.cancel();
    g.animate([{ translate: `${view.width}px 0px` }, { translate: '0px 0px' }], {
      delay: GLIDE_LEAD + ALIGNMENT_REVEAL.open,
      duration: ALIGNMENT_REVEAL.slideIn,
      easing: 'cubic-bezier(0.16, 1, 0.3, 1)',
      fill: 'backwards',
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- when the aligned sequences are shown or hidden
  }, [bandFlip]);
  useLayoutEffect(() => {
    if (view?.alignments.band) lastBand.current = { alignments: view.alignments, offsetY, width: view.width };
  });
  useLayoutEffect(() => {
    if (!leaving) return;
    const g = leavingRef.current;
    if (!g || typeof g.animate !== 'function') {
      setLeaving(null);
      return;
    }
    let live = true;
    const a = g.animate([{ translate: '0px 0px' }, { translate: `${leaving.width}px 0px` }], {
      duration: ALIGNMENT_REVEAL.slideOut,
      easing: 'cubic-bezier(0.4, 0, 1, 1)',
      fill: 'forwards',
    });
    const done = () => {
      if (live) setLeaving((cur) => (cur?.key === leaving.key ? null : cur));
    };
    a.finished.then(done, done);
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per band leaving
  }, [leaving?.key]);

  useMapGlide(svgRef, view, offsetY, [record, shown, featureTrack, orfTrack, primerTrack, markers, measure], props.widthChange, bandTiming);
  const stretched = !!view && !announced && liveWidth > 0 && Math.abs(liveWidth - view.width) >= 1;
  const offsetYRef = useRef(offsetY);
  useLayoutEffect(() => {
    offsetYRef.current = offsetY;
  });

  const toLocal = (clientX: number, clientY: number): { x: number; y: number } | null => {
    const svg = svgRef.current;
    if (!svg || !latest.current.view) return null;
    const rect = svg.getBoundingClientRect();
    // the drawing may be stretched to the live width while the layout keeps the settled one
    const sx = rect.width > 0 && svg.viewBox.baseVal.width > 0 ? svg.viewBox.baseVal.width / rect.width : 1;
    return { x: (clientX - rect.left) * sx, y: clientY - rect.top - offsetYRef.current };
  };

  const hitAt = (x: number, y: number): MapTarget => {
    const cur = latest.current;
    if (!cur.view) return { kind: 'background', position: 0 };
    const input: HitInput = {
      view: cur.view,
      features: cur.featureTrack,
      orfs: cur.orfTrack,
      primers: cur.primerTrack,
      markers: cur.markers,
    };
    return hitTest(input, x, y);
  };

  const gapAt = (x: number): number => {
    const cur = latest.current;
    return positionsAt(cur.scale, x, cur.L).gap;
  };

  // ---- hover card ---------------------------------------------------------------------------
  const tooltipTimer = useRef<number | null>(null);
  const tooltipWarmUntil = useRef(0);
  const hoverKey = useRef('');
  const hoveredFeature = useRef<string | null>(null);
  /** Pointer position relative to the root element, for the card. */
  const pointer = useRef<{ x: number; y: number } | null>(null);

  const positionTooltip = () => {
    const el = tooltipRef.current;
    const p = pointer.current;
    const root = rootRef.current;
    if (!el || !p || !root) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const W = root.clientWidth;
    const H = root.clientHeight;
    let x = p.x + 14;
    let y = p.y + 18;
    if (x + w > W - 6) x = Math.max(6, p.x - 14 - w);
    if (y + h > H - 6) y = Math.max(6, p.y - 12 - h);
    el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  };
  useLayoutEffect(positionTooltip);

  const clearTooltipTimer = () => {
    if (tooltipTimer.current !== null) {
      window.clearTimeout(tooltipTimer.current);
      tooltipTimer.current = null;
    }
  };

  const setHoveredFeature = (id: string | null) => {
    if (hoveredFeature.current === id) return;
    hoveredFeature.current = id;
    latest.current.props.onFeatureHover?.(id);
  };

  const updateHover = (clientX: number, clientY: number) => {
    const p = toLocal(clientX, clientY);
    const root = rootRef.current;
    if (!p || !root) return;
    const rr = root.getBoundingClientRect();
    pointer.current = { x: clientX - rr.left, y: clientY - rr.top };
    const t = hitAt(p.x, p.y);
    const interesting = t.kind === 'feature' || t.kind === 'enzyme' || t.kind === 'primer' || t.kind === 'orf';
    setHoveredFeature(t.kind === 'feature' ? t.id : null);
    const key = interesting ? targetKey(t) : '';
    if (key === hoverKey.current) {
      positionTooltip();
      return;
    }
    hoverKey.current = key;
    clearTooltipTimer();
    if (!key) {
      setTooltipOn(false);
      tooltipWarmUntil.current = performance.now() + TOOLTIP_WARM;
    } else if (performance.now() < tooltipWarmUntil.current) {
      setTooltipOn(true);
    } else {
      setTooltipOn(false);
      tooltipTimer.current = window.setTimeout(() => setTooltipOn(true), TOOLTIP_DELAY);
    }
    setHoverTarget(interesting ? t : null);
  };

  const clearHover = () => {
    clearTooltipTimer();
    if (hoverKey.current) tooltipWarmUntil.current = performance.now() + TOOLTIP_WARM;
    hoverKey.current = '';
    setTooltipOn(false);
    setHoverTarget(null);
    setHoveredFeature(null);
  };

  useEffect(() => () => clearTooltipTimer(), []);

  // ---- wheel, pinch and trackpad gestures (native listeners: they must be non-passive) ----
  const wheelAcc = useRef<{ zoom: number; anchorX: number; pan: number } | null>(null);
  const wheelFrame = useRef<number | null>(null);
  const gestureActive = useRef(false);

  const flushWheel = () => {
    wheelFrame.current = null;
    const acc = wheelAcc.current;
    wheelAcc.current = null;
    if (!acc) return;
    const cur = latest.current;
    let vp = liveVp.current;
    if (acc.zoom !== 1) {
      const s = makeScale(vp, cur.plotLeft, cur.plotWidth);
      vp = zoomViewport(vp, acc.zoom, s.bp(acc.anchorX), cur.L, cur.plotWidth);
    }
    if (acc.pan !== 0) {
      const s = makeScale(vp, cur.plotLeft, cur.plotWidth);
      vp = panViewport(vp, acc.pan / s.pxPerBp, cur.L, cur.plotWidth);
    }
    if (!sameViewport(vp, liveVp.current)) setViewport(vp);
  };

  const queueWheel = (zoom: number, anchorX: number, pan: number) => {
    const acc = wheelAcc.current ?? { zoom: 1, anchorX, pan: 0 };
    acc.zoom *= zoom;
    acc.anchorX = anchorX;
    acc.pan += pan;
    wheelAcc.current = acc;
    if (wheelFrame.current === null) wheelFrame.current = requestAnimationFrame(flushWheel);
  };

  const onWheel = (e: WheelEvent) => {
    const cur = latest.current;
    if (cur.L <= 0 || !cur.view) return;
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? (rootRef.current?.clientHeight ?? 600) : 1;
    const dx = e.deltaX * unit;
    const dy = e.deltaY * unit;
    const rect = svgRef.current?.getBoundingClientRect();
    const x = rect ? e.clientX - rect.left : cur.plotLeft + cur.plotWidth / 2;
    let zoom = 1;
    let pan = 0;
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      if (gestureActive.current || dy === 0) return;
      // Mouse wheels send large integral steps; pinch and smooth scrolling send small deltas.
      const notch = e.deltaMode !== 0 || (Math.abs(e.deltaY) >= 50 && Number.isInteger(e.deltaY));
      zoom = notch ? Math.pow(1.25, -Math.sign(dy)) : Math.exp(-dy * 0.01);
      zoom = Math.min(2, Math.max(0.5, zoom));
    } else if (e.shiftKey && dx === 0) {
      pan = dy;
    } else if (Math.abs(dx) > Math.abs(dy)) {
      pan = dx;
    } else {
      return; // vertical scrolling stays native (the map scrolls when taller than its pane)
    }
    e.preventDefault();
    clearHover();
    queueWheel(zoom, x, pan);
  };

  const onGesture = (factor: number, clientX: number) => {
    const rect = svgRef.current?.getBoundingClientRect();
    const cur = latest.current;
    queueWheel(factor, rect ? clientX - rect.left : cur.plotLeft + cur.plotWidth / 2, 0);
  };

  const wheelRef = useRef(onWheel);
  const gestureRef = useRef(onGesture);
  useLayoutEffect(() => {
    wheelRef.current = onWheel;
    gestureRef.current = onGesture;
  });

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => wheelRef.current(e);
    let lastScale = 1;
    const start = (e: Event) => {
      e.preventDefault();
      gestureActive.current = true;
      lastScale = 1;
    };
    const change = (e: Event) => {
      e.preventDefault();
      const g = e as GestureLikeEvent;
      if (!(g.scale > 0)) return;
      const factor = g.scale / lastScale;
      lastScale = g.scale;
      gestureRef.current(factor, g.clientX);
    };
    const end = (e: Event) => {
      e.preventDefault();
      gestureActive.current = false;
    };
    el.addEventListener('wheel', wheel, { passive: false });
    el.addEventListener('gesturestart', start);
    el.addEventListener('gesturechange', change);
    el.addEventListener('gestureend', end);
    return () => {
      el.removeEventListener('wheel', wheel);
      el.removeEventListener('gesturestart', start);
      el.removeEventListener('gesturechange', change);
      el.removeEventListener('gestureend', end);
      if (wheelFrame.current !== null) cancelAnimationFrame(wheelFrame.current);
    };
  }, []);

  // ---- pointer: click, drag-select, autoscroll ------------------------------------------
  const press = useRef<Press | null>(null);
  const suppressClick = useRef(false);
  const autoScroll = useRef<{ frame: number | null; x: number }>({ frame: null, x: 0 });

  const stopAutoScroll = () => {
    if (autoScroll.current.frame !== null) cancelAnimationFrame(autoScroll.current.frame);
    autoScroll.current.frame = null;
  };

  /** Selection while dragging from the press to gap `head`. */
  const dragSelection = (p: Press, head: number): SequenceSelection => {
    const { L: len, topology: topo } = latest.current;
    if (p.extendFrom) return extendSelection(p.extendFrom, head, len, topo);
    return selectBetween(p.anchor, head, len, topo, head >= p.anchor);
  };

  const autoScrollTick = () => {
    const a = autoScroll.current;
    a.frame = null;
    const p = press.current;
    const cur = latest.current;
    if (!p || !p.dragging || !cur.view) return;
    const w = cur.view.width;
    const over = a.x < AUTOSCROLL_EDGE ? a.x - AUTOSCROLL_EDGE : a.x > w - AUTOSCROLL_EDGE ? a.x - (w - AUTOSCROLL_EDGE) : 0;
    if (over === 0) return;
    const speedPx = Math.sign(over) * Math.min(48, 2 + Math.abs(over) * 0.35);
    const vp = liveVp.current;
    const s = makeScale(vp, cur.plotLeft, cur.plotWidth);
    const next = panViewport(vp, speedPx / s.pxPerBp, cur.L, cur.plotWidth);
    if (!sameViewport(next, vp)) setViewport(next);
    // extend the selection to the base now under the pointer (clamped to the visible area)
    const s2 = makeScale(next, cur.plotLeft, cur.plotWidth);
    const head = Math.max(0, Math.min(cur.L, Math.round(s2.bp(Math.max(0, Math.min(w, a.x))))));
    emitSelection(dragSelection(p, head));
    a.frame = requestAnimationFrame(autoScrollTick);
  };

  const onPointerDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (e.button !== 0 || !latest.current.view) return;
    // (the press focuses the map natively; a script focus() would show the keyboard focus ring)
    const p = toLocal(e.clientX, e.clientY);
    if (!p) return;
    const cur = latest.current;
    press.current = {
      pointerId: e.pointerId,
      x: p.x,
      y: p.y,
      dragging: false,
      anchor: gapAt(p.x),
      extendFrom: e.shiftKey ? cur.selection : null,
    };
    try {
      e.currentTarget.setPointerCapture?.(e.pointerId);
    } catch {
      // capture is best effort (fails for synthetic pointers)
    }
    clearHover();
  };

  const onPointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    const pr = press.current;
    if (pr && pr.pointerId === e.pointerId) {
      const p = toLocal(e.clientX, e.clientY);
      if (!p) return;
      if (!pr.dragging) {
        if (Math.hypot(p.x - pr.x, p.y - pr.y) < DRAG_THRESHOLD) return;
        pr.dragging = true;
        setDragging(true);
      }
      emitSelection(dragSelection(pr, gapAt(p.x)));
      autoScroll.current.x = p.x;
      const w = latest.current.view?.width ?? 0;
      if ((p.x < AUTOSCROLL_EDGE || p.x > w - AUTOSCROLL_EDGE) && autoScroll.current.frame === null) {
        autoScroll.current.frame = requestAnimationFrame(autoScrollTick);
      }
      return;
    }
    if (e.buttons === 0) updateHover(e.clientX, e.clientY);
  };

  const endPress = (e: ReactPointerEvent<SVGSVGElement>) => {
    const pr = press.current;
    if (!pr || pr.pointerId !== e.pointerId) return;
    if (pr.dragging) suppressClick.current = true;
    press.current = null;
    stopAutoScroll();
    setDragging(false);
    try {
      e.currentTarget.releasePointerCapture?.(e.pointerId);
    } catch {
      // already released
    }
  };

  const onClick = (e: ReactMouseEvent<SVGSVGElement>) => {
    if (suppressClick.current) {
      suppressClick.current = false;
      return;
    }
    const p = toLocal(e.clientX, e.clientY);
    const cur = latest.current;
    if (!p || !cur.view || cur.L <= 0) return;
    const t = hitAt(p.x, p.y);
    const clickCount = Math.max(1, e.detail || 1);
    const { props: pr, L: len, topology: topo } = cur;
    switch (t.kind) {
      case 'feature': {
        const idx = featureEntryIndex(cur.featureTrack, t.id);
        const entry: FeatureEntry | undefined = idx >= 0 ? cur.featureTrack?.entries[idx] : undefined;
        if (entry) {
          selectItem(entry.extent, e.shiftKey);
          if (clickCount === 2 && !e.shiftKey) setViewport(viewportForRange(entry.extent, len, topo, 0.08), true);
        }
        pr.onFeatureClick?.(t.id, { clickCount, shiftKey: e.shiftKey, metaKey: e.metaKey, ctrlKey: e.ctrlKey });
        return;
      }
      case 'enzyme':
        pr.onEnzymeClick?.(t.site);
        return;
      case 'primer': {
        const entry = cur.primerTrack?.entries.find((en) => en.site.primerId === t.id);
        if (entry) selectItem(entry.annealed, e.shiftKey);
        pr.onPrimerClick?.(t.id, { clickCount, shiftKey: e.shiftKey, metaKey: e.metaKey, ctrlKey: e.ctrlKey });
        return;
      }
      case 'orf':
        selectItem(t.orf.range, e.shiftKey);
        return;
      case 'sequence':
      case 'background': {
        const gap = gapAt(p.x);
        if (e.shiftKey && cur.selection) emitSelection(extendSelection(cur.selection, gap, len, topo));
        else if (t.kind === 'sequence') emitSelection(caretAt(gap));
        else if (cur.selection) emitSelection(null);
        if (clickCount === 2 && t.kind === 'background' && !e.shiftKey) {
          setViewport(zoomViewport(liveVp.current, 2, cur.scale.bp(p.x), len, cur.plotWidth), true);
        }
      }
    }
  };

  const onContextMenu = (e: ReactMouseEvent<SVGSVGElement>) => {
    const handler = latest.current.props.onContextMenu;
    if (!handler) return;
    const p = toLocal(e.clientX, e.clientY);
    if (!p) return;
    e.preventDefault();
    clearHover();
    handler(hitAt(p.x, p.y), e);
  };

  // ---- keyboard -----------------------------------------------------------------------------
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const cur = latest.current;
    if (cur.L <= 0) return;
    const vp = goalVp.current;
    const span = vp.end - vp.start;
    const center = (vp.start + vp.end) / 2;
    switch (e.key) {
      case 'ArrowLeft':
      case 'ArrowRight': {
        const dir = e.key === 'ArrowLeft' ? -1 : 1;
        setViewport(panViewport(vp, dir * span * (e.shiftKey ? 0.8 : 0.2), cur.L, cur.plotWidth), true);
        break;
      }
      case 'Home':
        setViewport({ start: 0, end: span }, true);
        break;
      case 'End':
        setViewport({ start: cur.L - span, end: cur.L }, true);
        break;
      case '+':
      case '=':
        setViewport(zoomViewport(vp, 2, center, cur.L, cur.plotWidth), true);
        break;
      case '-':
      case '_':
        setViewport(zoomViewport(vp, 0.5, center, cur.L, cur.plotWidth), true);
        break;
      case '0':
        setViewport(fullViewport(cur.L), true);
        break;
      case 'Escape':
        if (!cur.selection) return;
        emitSelection(null);
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  // ---- overview scrollbar ---------------------------------------------------------------------
  const thumbDrag = useRef<{ pointerId: number; clientX: number; vp: Range } | null>(null);
  const onThumbDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    thumbDrag.current = { pointerId: e.pointerId, clientX: e.clientX, vp: liveVp.current };
    setThumbActive(true);
    try {
      e.currentTarget.setPointerCapture?.(e.pointerId);
    } catch {
      // best effort
    }
  };
  const onThumbMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = thumbDrag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    const cur = latest.current;
    const deltaBp = ((e.clientX - d.clientX) / cur.plotWidth) * cur.L;
    setViewport(panViewport(d.vp, deltaBp, cur.L, cur.plotWidth));
  };
  const onThumbUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (thumbDrag.current?.pointerId !== e.pointerId) return;
    thumbDrag.current = null;
    setThumbActive(false);
  };
  const onTrackDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || e.target !== e.currentTarget) return;
    e.preventDefault();
    const cur = latest.current;
    const rect = e.currentTarget.getBoundingClientRect();
    const f = (e.clientX - rect.left) / Math.max(1, rect.width);
    const vp = goalVp.current;
    const span = vp.end - vp.start;
    const c = f * cur.L;
    setViewport({ start: c - span / 2, end: c + span / 2 }, true);
  };

  // ---- derived drawing state ------------------------------------------------------------------
  const svgHeight = Math.max(size.height, contentHeight);

  const hoveredFeatureId = hoverTarget?.kind === 'feature' ? hoverTarget.id : null;
  const ring = useMemo(() => {
    if (!view || !featureTrack) return '';
    const ids = new Set<string>();
    if (highlightId) ids.add(highlightId);
    if (selectedIds) for (const id of selectedIds) ids.add(id);
    if (ids.size === 0) return '';
    let out = '';
    for (const id of ids) {
      const idx = featureEntryIndex(featureTrack, id);
      if (idx >= 0) out += featureOutline(view, featureTrack, idx);
    }
    return out;
  }, [view, featureTrack, highlightId, selectedIds]);
  const hoverRing = useMemo(() => {
    if (!view || !featureTrack || !hoveredFeatureId || hoveredFeatureId === highlightId) return '';
    const idx = featureEntryIndex(featureTrack, hoveredFeatureId);
    return idx >= 0 ? featureOutline(view, featureTrack, idx) : '';
  }, [view, featureTrack, hoveredFeatureId, highlightId]);
  const hotEnzyme = useMemo(() => {
    if (!view || !markers || hoverTarget?.kind !== 'enzyme') return { label: null, cuts: '' };
    const site = hoverTarget.site;
    const label = view.enzymes.labels.find((l) => markers[l.marker].site === site) ?? null;
    // every visible cut of the same enzyme lights up
    let cuts = '';
    if (!view.letters) {
      for (const i of view.enzymes.visible) {
        if (markers[i].site.enzyme !== site.enzyme) continue;
        const x = Math.round(view.scale.x(markers[i].pos) * 2) / 2;
        cuts += vlinePath(x, view.v.topStrandY - CUT_OVERSHOOT, view.v.topStrandY);
      }
    }
    return { label, cuts };
  }, [view, markers, hoverTarget]);

  const tooltip =
    tooltipOn && hoverTarget && !dragging
      ? tooltipContent(hoverTarget, { record, features: featureTrack, orfs: orfTrack, primers: primerTrack, enzymeSites })
      : null;

  const zoomed = view !== null && !isFullViewport(shown, L);
  const ariaLabel = `${record.name || 'Sequence'}: linear map, ${formatBp(L)}, ${topology}${
    record.features.length ? `, ${formatInt(record.features.length)} features` : ''
  }`;

  const rootClass = [styles.root, className ?? ''].filter(Boolean).join(' ');

  return (
    <div
      ref={rootRef}
      className={rootClass}
      role="group"
      aria-roledescription="linear map"
      aria-label={ariaLabel}
      tabIndex={0}
      onKeyDown={onKeyDown}
      data-testid="linear-map"
    >
      <div ref={scrollerRef} className={styles.scroller}>
        {L <= 0 ? (
          <div className={styles.empty}>No sequence</div>
        ) : view ? (
          <svg
            ref={svgRef}
            className={[styles.svg, dragging ? styles.dragging : '', stretched || announced ? styles.stretched : ''].filter(Boolean).join(' ')}
            style={stretched ? ({ '--hh-unstretch': String(view.width / liveWidth) } as CSSProperties) : undefined}
            // stretched, the drawing follows the pane at once (the measured width only arrives a frame later)
            width={stretched ? '100%' : view.width}
            height={svgHeight}
            viewBox={`0 0 ${view.width} ${svgHeight}`}
            preserveAspectRatio={stretched ? 'none' : undefined}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endPress}
            onPointerCancel={endPress}
            onPointerLeave={() => {
              if (!press.current) clearHover();
            }}
            onClick={onClick}
            onContextMenu={onContextMenu}
            aria-hidden="true"
          >
            <g data-map-content transform={`translate(0 ${offsetY})`}>
              <SelectionUnderlay view={view} selection={selection} />
              <MapContent view={view} />
              {leaving ? (
                <g
                  ref={leavingRef}
                  transform={`translate(0 ${leaving.offsetY - offsetY}) translate(${METRICS.padX} 0) scale(${(view.width - 2 * METRICS.padX) / Math.max(1, leaving.width - 2 * METRICS.padX)} 1) translate(${-METRICS.padX} 0)`}
                >
                  <AlignmentLayer alignments={leaving.alignments} />
                </g>
              ) : null}
              <g ref={bandRef}>
                <AlignmentLayer alignments={view.alignments} />
              </g>
              <SelectionOverlay view={view} selection={selection} />
              <HighlightLayer ring={ring} hoverRing={hoverRing} enzyme={hotEnzyme.label} enzymeCuts={hotEnzyme.cuts} />
            </g>
          </svg>
        ) : null}
      </div>
      {zoomed && view ? (
        <div
          className={styles.scrollbar}
          style={{ left: plotLeft, width: plotWidth }}
          onPointerDown={onTrackDown}
          role="scrollbar"
          aria-orientation="horizontal"
          aria-valuemin={0}
          aria-valuemax={L}
          aria-valuenow={Math.round(shown.start)}
          aria-label="Visible region"
        >
          <div
            className={thumbActive ? `${styles.thumb} ${styles.thumbActive}` : styles.thumb}
            style={thumbStyle(shown, L, plotWidth)}
            onPointerDown={onThumbDown}
            onPointerMove={onThumbMove}
            onPointerUp={onThumbUp}
            onPointerCancel={onThumbUp}
          />
        </div>
      ) : null}
      {tooltip ? (
        <div ref={tooltipRef} className={styles.tooltip} role="tooltip">
          {tooltip}
        </div>
      ) : null}
    </div>
  );
}

function thumbStyle(vp: Range, L: number, plotWidth: number): { left: number; width: number } {
  const minW = 28;
  let left = Math.max(0, vp.start / L) * plotWidth;
  let w = Math.min(1, vp.end / L) * plotWidth - left;
  if (w < minW) {
    left += w / 2 - minW / 2;
    w = minW;
  }
  w = Math.min(w, plotWidth);
  left = Math.min(plotWidth - w, Math.max(0, left));
  return { left, width: w };
}

/** Durations (ms) of the aligned sequences' reveal: the band's space opens, then the band slides in; and back. */
export const ALIGNMENT_REVEAL = { open: 300, slideIn: 360, slideOut: 220, close: 280 } as const;

/** A width change of the map announced ahead of an animation (e.g. a side panel sliding open or closed). */
export interface MapWidthChange {
  /** By how much the width will change (px). */
  by: number;
  /** Timing of that change, as the animation that makes it: labels moving to their new places follow it. */
  delay: number;
  duration: number;
  easing: string;
}

type GlideTiming = Omit<MapWidthChange, 'by'>;
/** Timing of the glide to a new layout when nothing announced it (e.g. the window resized). */
const GLIDE: GlideTiming = { delay: 0, duration: 260, easing: 'cubic-bezier(0.2, 0, 0, 1)' };
/** Two frames: an animation starts after the heavy first render of what changed. */
const GLIDE_LEAD = 34;
/** How far below its place a new element starts rising (px). */
const GLIDE_RISE = 8;

/**
 * Between two layouts of the same window at different sizes (the map narrowing or widening with a side panel, the
 * aligned sequences' band opening or closing, the window resized) every element of the map (`data-k`: its vertical
 * reference in `data-y`, or its own x / y for text and rects) glides from where it was on screen to where it is;
 * new ones fade in rising from below; a leader (`data-lead`) goes along with its label, its far end staying on the
 * bar. The glide keeps the timing of what announced the change (the panel's, the band's), so everything arrives
 * together; nothing is laid out or drawn anew at any frame in between. `windowDeps` are what else the layout
 * depends on: when one changes (zoom, data) the map is simply redrawn. A `bandTiming` of null skips the glide.
 */
function useMapGlide(
  svgRef: RefObject<SVGSVGElement | null>,
  view: ViewModel | null,
  offsetY: number,
  windowDeps: readonly unknown[],
  change: MapWidthChange | undefined,
  bandTiming: GlideTiming | null | undefined,
): void {
  const state = useRef<{
    deps: readonly unknown[];
    width: number;
    height: number;
    offsetY: number;
    pos: Map<string, { x: number; y: number }>;
    leads: Map<string, string>;
    since: number;
  } | null>(null);
  const changeRef = useRef(change);
  changeRef.current = change;
  const bandRef = useRef(bandTiming);
  bandRef.current = bandTiming;
  useLayoutEffect(() => {
    const svg = svgRef.current;
    if (!svg || !view) {
      // a hidden map starts afresh when shown again
      state.current = null;
      return;
    }
    const prev = state.current;
    const now = performance.now();
    // only a new size of a map that has been on screen a moment glides: the first layouts of a map just shown (its
    // fonts measured, its pane settling) are simply drawn
    const same =
      !!prev &&
      now - prev.since > 400 &&
      (prev.width !== view.width || prev.height !== view.height) &&
      prev.deps.length === windowDeps.length &&
      prev.deps.every((d, i) => d === windowDeps[i]);
    const reduced = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const pos = new Map<string, { x: number; y: number }>();
    const els: SVGElement[] = [];
    for (const el of svg.querySelectorAll<SVGElement>('[data-k]')) {
      const boxed = el.tagName === 'text' || el.tagName === 'rect';
      const x = boxed ? parseFloat(el.getAttribute('x') ?? '') : NaN;
      const y = boxed ? Number(el.getAttribute('y')) : Number(el.dataset.y);
      pos.set(el.dataset.k as string, { x, y });
      els.push(el);
    }
    const leads = new Map<string, string>();
    const leadEls: SVGElement[] = [];
    for (const el of svg.querySelectorAll<SVGElement>('path[data-lead]')) {
      leads.set(el.dataset.lead as string, el.getAttribute('d') ?? '');
      leadEls.push(el);
    }
    state.current = { deps: windowDeps, width: view.width, height: view.height, offsetY, pos, leads, since: prev?.since ?? now };
    const band = bandRef.current;
    if (!same || reduced || band === null || typeof svg.animate !== 'function') return;

    const pad = METRICS.padX;
    // x scales with the plot (the drawing is squeezed or spread to the pane meanwhile, see LinearMap)
    const sx = (view.width - 2 * pad) / Math.max(1, prev.width - 2 * pad);
    const announced = changeRef.current && prev.width !== view.width ? changeRef.current : null;
    const timing = announced ?? band ?? GLIDE;
    const opts: KeyframeAnimationOptions = { duration: timing.duration, delay: timing.delay, easing: timing.easing, fill: 'backwards' };
    // the drawing's vertical offset in the pane (centred) changes with its height
    const dOff = prev.offsetY - offsetY;
    for (const el of els) {
      const k = el.dataset.k as string;
      const { x, y } = pos.get(k)!;
      const before = prev.pos.get(k);
      if (!before) {
        el.animate(
          [
            { opacity: 0, translate: `0px ${GLIDE_RISE}px` },
            { opacity: 1, translate: '0px 0px' },
          ],
          opts,
        );
        continue;
      }
      const dx = Number.isNaN(x) || Number.isNaN(before.x) ? 0 : pad + (before.x - pad) * sx - x;
      const dy = before.y + dOff - y;
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
      // from where it is shown now (a glide under way included)
      const [ox, oy] = currentTranslate(el);
      el.animate([{ translate: `${dx + ox}px ${dy + oy}px` }, { translate: '0px 0px' }], opts);
    }
    for (const el of leadEls) {
      const k = el.dataset.lead as string;
      const line = parseLine(leads.get(k));
      const old = parseLine(prev.leads.get(k));
      if (!line) continue;
      if (!old) {
        for (const a of el.getAnimations()) a.cancel();
        el.animate([{ opacity: 0 }, { opacity: 1 }], opts);
        continue;
      }
      // The old line (one on the move included), brought into the new drawing's frame, as a transform of the new
      // line about its top end: being relative, it follows the line wherever the layout puts it.
      const [ox, oy, os] = currentLineTransform(el);
      const fromX = pad + (old.x + ox - pad) * sx;
      const fromTop = Math.min(old.y0, old.y1) + oy + dOff;
      const fromLen = Math.abs(old.y1 - old.y0) * os;
      const top = Math.min(line.y0, line.y1);
      const len = Math.max(0.01, Math.abs(line.y1 - line.y0));
      const tx = fromX - line.x;
      const ty = fromTop - top;
      const sy = fromLen / len;
      if (Math.abs(tx) < 0.5 && Math.abs(ty) < 0.5 && Math.abs(sy - 1) < 0.01) continue;
      el.animate([{ transform: `translate(${tx}px, ${ty}px) scaleY(${sy})` }, { transform: 'none' }], opts);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs for every new layout; windowDeps are compared above
  }, [view]);
}

/** The translate (px) an element is shown with by an animation under way, that animation cancelled; 0 0 otherwise. */
function currentTranslate(el: Element): [number, number] {
  const running = el.getAnimations();
  if (running.length === 0) return [0, 0];
  const [x, y] = getComputedStyle(el).translate.split(' ').map((v) => parseFloat(v) || 0);
  for (const a of running) a.cancel();
  return [x ?? 0, y ?? 0];
}

/**
 * The translate (px) and vertical scale a leader is shown with by an animation under way, that animation cancelled;
 * 0 0 1 otherwise.
 */
function currentLineTransform(el: Element): [number, number, number] {
  const running = el.getAnimations();
  if (running.length === 0) return [0, 0, 1];
  const m = /^matrix\(([^)]*)\)$/.exec(getComputedStyle(el).transform);
  for (const a of running) a.cancel();
  if (!m) return [0, 0, 1];
  const [, , , d, e, f] = m[1].split(',').map((v) => parseFloat(v));
  return [e || 0, f || 0, d || 1];
}

/** A leader line (`M x y0 V y1`, see vlinePath) taken apart; null for anything else. */
function parseLine(d: string | undefined): { x: number; y0: number; y1: number } | null {
  // as written by vlinePath, or as a computed style gives it back (`M 1 2 V 3`)
  const m = d && /^M\s*(-?[\d.]+)[\s,]+(-?[\d.]+)\s*V\s*(-?[\d.]+)$/.exec(d.trim());
  return m ? { x: Number(m[1]), y0: Number(m[2]), y1: Number(m[3]) } : null;
}

/** Time of the last resize of the browser window (the settled layout below applies to those only). */
let lastWindowResize = -Infinity;
if (typeof window !== 'undefined') {
  window.addEventListener('resize', () => {
    lastWindowResize = performance.now();
  });
}

/**
 * `live`, but while the browser window is being resized only once it has stopped changing for `delay` ms. Other
 * width changes (a side panel sliding open, the first measurement) are taken at once: an animated panel would
 * otherwise keep the map stretched for the whole animation.
 */
function useSettledWidth(live: number, delay = 160): number {
  const [settled, setSettled] = useState(live);
  const windowResizing = live !== settled && performance.now() - lastWindowResize < 250;
  useEffect(() => {
    if (live === settled) return;
    if (settled <= 0 || live <= 0 || performance.now() - lastWindowResize >= 250) {
      setSettled(live);
      return;
    }
    const t = setTimeout(() => setSettled(live), delay);
    return () => clearTimeout(t);
  }, [live, settled, delay]);
  if (settled <= 0) return live;
  return windowResizing ? settled : live;
}

/**
 * The width to lay out at while an announced change is under way: the coming one, so the map is laid out once
 * (shown squeezed or spread to the pane meanwhile, see LinearMap) instead of at every frame; kept as long as the
 * live width is within a couple of pixels of it (the panel's border), or `null`. `from` is the width the change
 * started from, `key` tells one change from the next.
 */
function useAnnouncedWidth(live: number, by: number): { width: number; from: number; key: number } | null {
  const hold = useRef<{ by: number; width: number; from: number; key: number } | null>(null);
  if (by && live > 0) {
    if (hold.current?.by !== by) hold.current = { by, width: Math.max(1, live + by), from: live, key: (hold.current?.key ?? 0) + 1 };
  } else if (hold.current && (by || Math.abs(live - hold.current.width) > 2)) {
    hold.current = null;
  }
  return hold.current;
}
