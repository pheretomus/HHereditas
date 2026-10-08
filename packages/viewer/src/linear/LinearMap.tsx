/**
 * <LinearMap />: horizontal map of a sequence record. The main view for linear records and an
 * alternative view of circular ones (drawn from the origin).
 *
 * Interaction model (macOS conventions):
 *  - ctrl/⌘ + wheel or trackpad pinch zooms around the pointer; horizontal wheel or
 *    shift + wheel pans; ←/→ pan, +/− zoom, 0 zooms to fit when the map has focus;
 *  - drag anywhere selects bases (the selection snaps to gaps); click a feature to select it,
 *    shift-click to extend; double-click a feature to zoom to it; double-click empty space to
 *    zoom in;
 *  - hover shows a tooltip; the slim bar at the bottom pans while zoomed in.
 * The component is presentational: selection and viewport may be controlled (pass `selection`
 * / `viewport`) or left to the component.
 */
import type { EnzymeSite, Orf, PrimerBindingSite, Range, SeqRecord } from '@hhereditas/core';
import type {
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  RefObject,
} from 'react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { formatBp, formatInt } from '../common/format';
import { useElementSize } from '../common/useElementSize';
import type { SequenceSelection } from '../selection';
import { caretAt, selectBetween, selectRange, selectionAnchor } from '../selection';
import { buildCutMarkers } from './enzymeLabels';
import type { FeatureEntry, HitInput, ViewModel } from './layout';
import {
  METRICS,
  buildFeatureTrack,
  buildOrfTrack,
  buildPrimerTrack,
  computeView,
  enzymeRowsToReserve,
  featureEntryIndex,
  featureOutline,
  hitTest,
  positionsAt,
} from './layout';
import styles from './LinearMap.module.css';
import { HighlightLayer, MapContent, SelectionLayer } from './LinearMapLayers';
import { targetKey, tooltipContent } from './LinearMapTooltip';
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
  onFeatureClick?: (featureId: string, info: FeatureClickInfo) => void;
  onFeatureHover?: (featureId: string | null) => void;
  onEnzymeClick?: (site: EnzymeSite) => void;
  onPrimerClick?: (primerId: string) => void;
  onContextMenu?: (target: MapTarget, event: ReactMouseEvent) => void;
  show?: MapShowOptions;
  className?: string;
  /**
   * Visible window in bp (fractional bounds allowed). Uncontrolled by default (the whole
   * record). When controlled, set it to fullViewport(length) to zoom to fit or to
   * viewportForRange(selection.range, …) to zoom to the selection; the map glides there.
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
  target: MapTarget;
  dragging: boolean;
  shift: boolean;
  anchor: number;
}

interface Hover {
  target: MapTarget;
  /** Pointer position relative to the root element. */
  x: number;
  y: number;
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
  const { record, enzymeSites, primerSites, orfs, show, className } = props;
  const L = record.seq.length;
  const topology = record.topology;

  const rootRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const size = useElementSize(rootRef);
  const measure = useTextMeasurer(rootRef);
  const width = size.width;
  const plotLeft = METRICS.padX;
  const plotWidth = Math.max(1, width - 2 * METRICS.padX);

  // ---- static tracks (zoom independent) ---------------------------------------------
  const showFeatures = show?.features !== false;
  const showEnzymes = show?.enzymes !== false;
  const showPrimers = show?.primers !== false;
  const showOrfs = show?.orfs !== false;
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
  const markers = useMemo(
    () => (showEnzymes && enzymeSites && enzymeSites.length > 0 && L > 0 ? buildCutMarkers(enzymeSites, L, topology) : null),
    [showEnzymes, enzymeSites, L, topology],
  );
  const enzymeRows = useMemo(
    () => (markers && width > 0 ? enzymeRowsToReserve(markers, L, plotLeft, plotWidth, width, measure) : 0),
    [markers, L, plotLeft, plotWidth, width, measure],
  );

  // ---- viewport ---------------------------------------------------------------------
  const controlled = props.viewport !== undefined;
  const [internalVp, setInternalVp] = useState<{ id: string; vp: Range } | null>(null);
  const target: Range = controlled
    ? (props.viewport as Range)
    : internalVp && internalVp.id === record.id
      ? internalVp.vp
      : fullViewport(L);
  const [animVp, setAnimVp] = useState<Range | null>(null);
  const shownRaw = clampViewport(animVp ?? target, L, plotWidth);
  const shownStart = shownRaw.start;
  const shownEnd = shownRaw.end;
  const shown = useMemo<Range>(() => ({ start: shownStart, end: shownEnd }), [shownStart, shownEnd]);
  const scale = useMemo(() => makeScale(shown, plotLeft, plotWidth), [shown, plotLeft, plotWidth]);

  const view = useMemo<ViewModel | null>(
    () =>
      width > 0 && L > 0
        ? computeView({
            record,
            width,
            scale,
            features: featureTrack,
            orfs: orfTrack,
            primers: primerTrack,
            markers,
            enzymeRows,
            measure,
          })
        : null,
    [record, width, scale, featureTrack, orfTrack, primerTrack, markers, enzymeRows, measure],
  );

  // ---- selection ----------------------------------------------------------------------
  const selectionControlled = props.selection !== undefined;
  const [internalSel, setInternalSel] = useState<{ id: string; sel: SequenceSelection | null } | null>(null);
  const selection: SequenceSelection | null = selectionControlled
    ? (props.selection ?? null)
    : internalSel && internalSel.id === record.id
      ? internalSel.sel
      : null;

  // ---- hover / tooltip ----------------------------------------------------------------
  const [hover, setHover] = useState<Hover | null>(null);
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

  /** The viewport interactions build on: what is on screen, or the newest one requested. */
  const liveVp = useRef<Range>(shown);
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
    const tick = (now: number) => {
      const t = Math.min(1, (now - t0) / ANIMATION_MS);
      const vp = t >= 1 ? to : interpolateViewport(from, to, easeInOutCubic(t));
      liveVp.current = vp;
      setAnimVp(vp);
      if (t < 1) {
        animFrame.current = requestAnimationFrame(tick);
      } else {
        animFrame.current = null;
        done();
      }
    };
    animFrame.current = requestAnimationFrame(tick);
  };

  const commitViewport = (c: Range) => {
    const cur = latest.current;
    liveVp.current = c;
    lastEmitted.current = c;
    if (!cur.controlled) setInternalVp({ id: cur.props.record.id, vp: c });
    cur.props.onViewportChange?.(c);
  };

  /** Change the viewport (clamped). Animated changes glide over ~300 ms. */
  const setViewport = (vp: Range, animate = false) => {
    const cur = latest.current;
    const c = clampViewport(vp, cur.L, cur.plotWidth);
    if (animate && !prefersReducedMotion()) {
      animateTo(liveVp.current, c, () => commitViewport(c));
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
    animateTo(shownRef.current, to, () => setAnimVp(null));
  }, [controlled, record.id, target.start, target.end]);

  // An animation that ended on a committed viewport hands over to it once the target matches.
  useLayoutEffect(() => {
    if (animVp && animFrame.current === null) {
      const eps = Math.max(1e-6, (shown.end - shown.start) * 1e-9);
      if (sameViewport(clampViewport(target, L, plotWidth), clampViewport(animVp, L, plotWidth), eps)) setAnimVp(null);
    }
  });

  useLayoutEffect(() => {
    shownRef.current = shown;
    if (animFrame.current === null) liveVp.current = shown;
  });

  useEffect(() => () => stopAnimation(), []);

  // ---- selection helpers ----------------------------------------------------------------
  const emitSelection = (sel: SequenceSelection | null) => {
    const cur = latest.current;
    if (!cur.selectionControlled) setInternalSel({ id: cur.props.record.id, sel });
    cur.props.onSelectionChange?.(sel);
  };

  /** Extend the current selection (anchor stays) so that it reaches `range`. */
  const extendTo = (range: Range) => {
    const { selection: sel, L: len, topology: topo } = latest.current;
    if (!sel) {
      emitSelection(selectRange(range, len, topo));
      return;
    }
    const anchor = selectionAnchor(sel, len, topo);
    const end = range.end > len ? range.end - len : range.end;
    const head = Math.abs(end - anchor) >= Math.abs(range.start - anchor) ? end : range.start;
    emitSelection(selectBetween(anchor, head, len, topo, head >= anchor));
  };

  // ---- coordinates and hit testing ------------------------------------------------------
  // The map content is centred vertically (slightly above centre) when the pane is taller.
  const contentHeight = view?.height ?? 0;
  const offsetY = Math.max(0, Math.round((size.height - contentHeight) * 0.46));
  const offsetYRef = useRef(offsetY);
  useLayoutEffect(() => {
    offsetYRef.current = offsetY;
  });

  const toLocal = (clientX: number, clientY: number): { x: number; y: number } | null => {
    const svg = svgRef.current;
    const view = latest.current.view;
    if (!svg || !view) return null;
    const rect = svg.getBoundingClientRect();
    return { x: clientX - rect.left, y: clientY - rect.top - offsetYRef.current };
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

  // ---- tooltip timing -------------------------------------------------------------------
  const tooltipTimer = useRef<number | null>(null);
  const tooltipWarmUntil = useRef(0);
  const hoverKey = useRef('');
  const hoveredFeature = useRef<string | null>(null);

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
    const t = hitAt(p.x, p.y);
    const interesting = t.kind === 'feature' || t.kind === 'enzyme' || t.kind === 'primer' || t.kind === 'orf';
    setHoveredFeature(t.kind === 'feature' ? t.id : null);
    const key = interesting ? targetKey(t) : '';
    const rr = root.getBoundingClientRect();
    if (key !== hoverKey.current) {
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
    }
    setHover(interesting ? { target: t, x: clientX - rr.left, y: clientY - rr.top } : null);
  };

  const clearHover = () => {
    clearTooltipTimer();
    if (hoverKey.current) tooltipWarmUntil.current = performance.now() + TOOLTIP_WARM;
    hoverKey.current = '';
    setTooltipOn(false);
    setHover(null);
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
    setViewport(vp);
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

  const dragTo = (x: number) => {
    const p = press.current;
    if (!p) return;
    const cur = latest.current;
    const head = gapAt(x);
    emitSelection(selectBetween(p.anchor, head, cur.L, cur.topology, head >= p.anchor));
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
    // extend the selection to the bp now under the pointer (clamped to the visible area)
    const s2 = makeScale(next, cur.plotLeft, cur.plotWidth);
    const head = Math.max(0, Math.min(cur.L, Math.round(s2.bp(Math.max(0, Math.min(w, a.x))))));
    emitSelection(selectBetween(p.anchor, head, cur.L, cur.topology, head >= p.anchor));
    a.frame = requestAnimationFrame(autoScrollTick);
  };

  const onPointerDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (e.button !== 0 || !latest.current.view) return;
    rootRef.current?.focus({ preventScroll: true });
    const p = toLocal(e.clientX, e.clientY);
    if (!p) return;
    const cur = latest.current;
    const anchor = e.shiftKey && cur.selection ? selectionAnchor(cur.selection, cur.L, cur.topology) : gapAt(p.x);
    press.current = { pointerId: e.pointerId, x: p.x, y: p.y, target: hitAt(p.x, p.y), dragging: false, shift: e.shiftKey, anchor };
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
      dragTo(p.x);
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
          if (e.shiftKey && cur.selection) extendTo(entry.extent);
          else emitSelection(selectRange(entry.extent, len, topo));
          if (clickCount === 2) setViewport(viewportForRange(entry.extent, len, topo, 0.08), true);
        }
        pr.onFeatureClick?.(t.id, { clickCount, shiftKey: e.shiftKey, metaKey: e.metaKey, ctrlKey: e.ctrlKey });
        return;
      }
      case 'enzyme':
        pr.onEnzymeClick?.(t.site);
        return;
      case 'primer': {
        const entry = cur.primerTrack?.entries.find((en) => en.site.primerId === t.id);
        if (entry) {
          if (e.shiftKey && cur.selection) extendTo(entry.annealed);
          else emitSelection(selectRange(entry.annealed, len, topo));
        }
        pr.onPrimerClick?.(t.id);
        return;
      }
      case 'orf':
        if (e.shiftKey && cur.selection) extendTo(t.orf.range);
        else emitSelection(selectRange(t.orf.range, len, topo));
        return;
      default: {
        const gap = gapAt(p.x);
        if (e.shiftKey && cur.selection) {
          const anchor = selectionAnchor(cur.selection, len, topo);
          emitSelection(selectBetween(anchor, gap, len, topo, gap >= anchor));
        } else {
          emitSelection(caretAt(gap));
        }
        if (clickCount === 2 && t.kind === 'background') {
          const vp = liveVp.current;
          setViewport(zoomViewport(vp, 2, cur.scale.bp(p.x), len, cur.plotWidth), true);
        }
      }
    }
  };

  const onContextMenu = (e: ReactMouseEvent<SVGSVGElement>) => {
    const handler = latest.current.props.onContextMenu;
    if (!handler) return;
    const p = toLocal(e.clientX, e.clientY);
    if (!p) return;
    handler(hitAt(p.x, p.y), e);
  };

  // ---- keyboard -----------------------------------------------------------------------------
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const cur = latest.current;
    if (cur.L <= 0) return;
    const vp = liveVp.current;
    const span = vp.end - vp.start;
    const center = (vp.start + vp.end) / 2;
    switch (e.key) {
      case 'ArrowLeft':
      case 'ArrowRight': {
        const dir = e.key === 'ArrowLeft' ? -1 : 1;
        setViewport(panViewport(vp, dir * span * (e.shiftKey ? 0.8 : 0.2), cur.L, cur.plotWidth), true);
        break;
      }
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
    const vp = liveVp.current;
    const span = vp.end - vp.start;
    const c = f * cur.L;
    setViewport({ start: c - span / 2, end: c + span / 2 }, true);
  };

  // ---- derived drawing state ------------------------------------------------------------------
  const svgHeight = Math.max(size.height, contentHeight);

  const highlightId = props.highlightedFeatureId ?? null;
  const hoveredFeatureId = hover?.target.kind === 'feature' ? hover.target.id : null;
  const ring = useMemo(() => {
    if (!view || !featureTrack || !highlightId) return '';
    const idx = featureEntryIndex(featureTrack, highlightId);
    return idx >= 0 ? featureOutline(view, featureTrack, idx) : '';
  }, [view, featureTrack, highlightId]);
  const hoverRing = useMemo(() => {
    if (!view || !featureTrack || !hoveredFeatureId || hoveredFeatureId === highlightId) return '';
    const idx = featureEntryIndex(featureTrack, hoveredFeatureId);
    return idx >= 0 ? featureOutline(view, featureTrack, idx) : '';
  }, [view, featureTrack, hoveredFeatureId, highlightId]);
  const hotEnzyme = useMemo(() => {
    if (!view || !markers || hover?.target.kind !== 'enzyme') return null;
    const site = hover.target.site;
    return view.enzymes.labels.find((l) => markers[l.marker].site === site) ?? null;
  }, [view, markers, hover]);

  const tooltip =
    tooltipOn && hover && !dragging
      ? tooltipContent(hover.target, { record, features: featureTrack, orfs: orfTrack, primers: primerTrack, enzymeSites })
      : null;

  const zoomed = view !== null && !isFullViewport(shown, L);
  const ariaLabel = `${record.name || 'Sequence'}: linear map, ${formatBp(L)}, ${topology}${
    record.features.length ? `, ${formatInt(record.features.length)} features` : ''
  }`;

  const rootClass = [styles.root, className ?? ''].filter(Boolean).join(' ');

  if (L <= 0) {
    return (
      <div ref={rootRef} className={rootClass} role="group" aria-roledescription="linear map" aria-label={ariaLabel} tabIndex={0}>
        <div className={styles.empty}>No sequence</div>
      </div>
    );
  }

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
      <div className={styles.scroller}>
        {view ? (
          <svg
            ref={svgRef}
            className={dragging ? `${styles.svg} ${styles.dragging}` : styles.svg}
            width={view.width}
            height={svgHeight}
            viewBox={`0 0 ${view.width} ${svgHeight}`}
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
            <g transform={`translate(0 ${offsetY})`}>
              <MapContent view={view} />
              <SelectionLayer view={view} selection={selection} />
              <HighlightLayer ring={ring} hoverRing={hoverRing} enzyme={hotEnzyme} />
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
      {tooltip && hover ? (
        <div className={styles.tooltip} role="tooltip" style={tooltipStyle(hover, size.width, size.height)}>
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

function tooltipStyle(h: Hover, width: number, height: number): { left: number; top: number; transform?: string } {
  const flipX = h.x > width - 280;
  const flipY = h.y > height - 90;
  return {
    left: flipX ? h.x - 12 : h.x + 14,
    top: flipY ? h.y - 12 : h.y + 18,
    transform: `${flipX ? 'translateX(-100%)' : ''} ${flipY ? 'translateY(-100%)' : ''}`.trim() || undefined,
  };
}
