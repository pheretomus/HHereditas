/**
 * SequenceView: SnapGene-style annotated sequence text, the main editing surface.
 *
 * Rows of bases (top strand, optional bottom strand) with enzyme names and stepped cut marks
 * above, primers above / below, feature bars, CDS translations and ORFs below. Rows are
 * virtualized with exact heights from the row model (layout.ts), so multi-megabase records
 * scroll smoothly; only the visible rows exist in the DOM.
 *
 * Interaction: click places the caret at the nearest gap, drag selects (auto-scrolling past
 * the edges), shift+click extends, clicking an annotation selects it. Keyboard input goes
 * through a hidden textarea (focus, IME, clipboard; see editing.ts for the key map). The view
 * never edits the record itself: it reports SequenceEdit intents through onEdit.
 */
import type { EnzymeSite, Feature, Orf, PrimerBindingSite, SearchHit, SeqRecord, Topology } from '@hhereditas/core';
import { featureExtent, mod, normalizeRange } from '@hhereditas/core';
import {
  type ClipboardEvent as ReactClipboardEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { featureFill, featureStroke } from '../common/colors';
import { formatBp, formatInt } from '../common/format';
import { useElementSize } from '../common/useElementSize';
import type { SequenceSelection } from '../selection';
import { caretAt, hasSelectedBases, selectBetween, selectRange } from '../selection';
import type { CaretAffinity, EditingContext } from './editing';
import {
  caretGap,
  copyText,
  coverSelection,
  cutIntent,
  extendSelectionTo,
  keyIntent,
  textIntent,
} from './editing';
import type { LayoutFeature, LayoutPrimer, RowModel } from './layout';
import {
  DEFAULT_METRICS,
  autoBasesPerRow,
  bandAtY,
  baseAtPoint,
  bucketRangesByRow,
  buildRowModel,
  colCenter,
  gapAtPoint,
  gapX,
  rangeColsInRow,
  rowAtY,
  rowOfBase,
  rowOfGap,
} from './layout';
import { measureLabel, resetLabelMeasurements } from './measure';
import type { RowRenderContext } from './SequenceRow';
import { RowBackdrop, RowContent } from './SequenceRow';
import { translateFeatureLite } from './translate-lite';
import type { CodingInfo } from './translation';
import { buildCodingInfo, codonAtBase, codonRange } from './translation';
import type { FeatureClickInfo, MapTarget, SequenceEdit, SequenceViewShow } from './types';
import styles from './SequenceView.module.css';

export interface SequenceViewProps {
  record: SeqRecord;
  /** Already filtered by the app: every site given is shown. */
  enzymeSites?: readonly EnzymeSite[];
  /** Primer names come from record.primers (matched by primerId). */
  primerSites?: readonly PrimerBindingSite[];
  orfs?: readonly Orf[];
  /** Highlighted on the strand they were found on. */
  searchHits?: readonly SearchHit[];
  /** Controlled selection; leave undefined to let the view keep its own. */
  selection?: SequenceSelection | null;
  onSelectionChange?: (selection: SequenceSelection | null) => void;
  /** e.g. hovered in the sidebar. */
  highlightedFeatureId?: string | null;
  /** Also selects the feature's extent (onSelectionChange). */
  onFeatureClick?: (featureId: string, info: FeatureClickInfo) => void;
  onFeatureHover?: (featureId: string | null) => void;
  /** Also selects the recognition site. */
  onEnzymeClick?: (site: EnzymeSite) => void;
  /** Also selects the binding site. */
  onPrimerClick?: (primerId: string) => void;
  onContextMenu?: (target: MapTarget, event: ReactMouseEvent) => void;
  show?: SequenceViewShow;
  /** Default 'auto': as many groups of 10 bases as fit the width. */
  basesPerRow?: number | 'auto';
  /** Typing, Backspace/Delete, paste and cut produce onEdit intents (requires onEdit). */
  editable?: boolean;
  onEdit?: (edit: SequenceEdit) => void;
  /** Typed or pasted text that is not DNA (nothing is edited). */
  onInvalidInput?: (text: string) => void;
  /** Scroll so that base `position` is visible whenever `requestId` changes. */
  scrollTo?: { position: number; requestId: number };
  /** Translator for CDS rows (codingDna = whole codons from /codon_start). Default: translate-lite. */
  translate?: (codingDna: string, feature: Feature) => string;
  className?: string;
}

const EMPTY: readonly never[] = Object.freeze([]);
const FALLBACK_WIDTH = 960;
const FALLBACK_HEIGHT = 720;
/** Extra pixels of rows rendered above and below the viewport. */
const OVERSCAN = 480;
/** Browsers cap element heights (~33.5M px in Blink/WebKit); taller content is scroll-scaled. */
const MAX_SCROLL_HEIGHT = 15_000_000;
const AUTOSCROLL_EDGE = 28;
const AUTOSCROLL_MAX = 48;
const INPUT_PLACEHOLDER = ' ';

function isMacPlatform(): boolean {
  if (typeof document !== 'undefined' && document.documentElement.classList.contains('hh-platform-mac')) return true;
  if (typeof navigator === 'undefined') return false;
  return /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
}

/** Bring a (possibly stale) selection into the current sequence's coordinates. */
function sanitizeSelection(sel: SequenceSelection | null | undefined, L: number, topology: Topology): SequenceSelection | null {
  if (!sel) return null;
  if (topology === 'circular' && L > 0) {
    const range = normalizeRange(sel.range, L, 'circular');
    const caret = mod(sel.caret, L);
    return range.start === sel.range.start && range.end === sel.range.end && caret === sel.caret ? sel : { range, caret };
  }
  const range = normalizeRange(sel.range, L, 'linear');
  const caret = Math.max(0, Math.min(L, sel.caret));
  return range.start === sel.range.start && range.end === sel.range.end && caret === sel.caret ? sel : { range, caret };
}

function sameSelection(a: SequenceSelection | null, b: SequenceSelection | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.caret === b.caret && a.range.start === b.range.start && a.range.end === b.range.end;
}

interface Hit {
  kind: string;
  index: number;
}

function hitOf(target: EventTarget | null): Hit | null {
  if (!target || typeof (target as Element).closest !== 'function') return null;
  const el = (target as Element).closest('[data-kind]');
  if (!el) return null;
  const kind = el.getAttribute('data-kind');
  const index = Number(el.getAttribute('data-index'));
  return kind && Number.isInteger(index) ? { kind, index } : null;
}

function describeSelection(sel: SequenceSelection | null, L: number): string {
  if (!sel) return '';
  const len = sel.range.end - sel.range.start;
  if (len <= 0) return `Cursor at position ${formatInt(Math.min(sel.caret, L))} of ${formatInt(L)}`;
  const last = sel.range.end > L ? sel.range.end - L : sel.range.end;
  return `Selected ${formatInt(sel.range.start + 1)} to ${formatInt(last)}, ${formatBp(len)}`;
}

export function SequenceView(props: SequenceViewProps) {
  const {
    record,
    enzymeSites = EMPTY,
    primerSites = EMPTY,
    orfs = EMPTY,
    searchHits = EMPTY,
    selection: selectionProp,
    onSelectionChange,
    highlightedFeatureId = null,
    onFeatureClick,
    onFeatureHover,
    onEnzymeClick,
    onPrimerClick,
    onContextMenu,
    show,
    basesPerRow = 'auto',
    editable = false,
    onEdit,
    onInvalidInput,
    scrollTo,
    translate,
    className,
  } = props;

  const seq = record.seq;
  const L = seq.length;
  const topology = record.topology;
  const isProtein = record.molecule === 'protein';
  const showComplement = !isProtein && (show?.complement ?? true);
  const showFeatures = show?.features ?? true;
  const showEnzymes = !isProtein && (show?.enzymes ?? true);
  const showPrimers = show?.primers ?? true;
  const showTranslations = !isProtein && (show?.translations ?? true);
  const showOrfs = show?.orfs ?? true;
  const showNumbers = show?.numbering ?? true;
  const canEdit = editable && !!onEdit;

  const scrollerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const size = useElementSize(scrollerRef);
  const viewportWidth = size.width > 0 ? size.width : FALLBACK_WIDTH;
  const viewportHeight = size.height > 0 ? size.height : FALLBACK_HEIGHT;
  // the layout only depends on the width through N and the label limit: quantize to avoid
  // rebuilding the model on every pixel of a window resize
  const layoutWidth = Math.floor(viewportWidth / 8) * 8;

  // ---- fonts --------------------------------------------------------------------------------
  const [fontEpoch, setFontEpoch] = useState(0);
  useEffect(() => {
    const fonts = typeof document !== 'undefined' ? document.fonts : undefined;
    if (!fonts || fonts.status !== 'loading') return;
    let live = true;
    void fonts.ready.then(() => {
      if (!live) return;
      resetLabelMeasurements();
      setFontEpoch((e) => e + 1);
    });
    return () => {
      live = false;
    };
  }, []);

  // ---- layout inputs ----------------------------------------------------------------------------
  const numberColumnWidth = useMemo(() => {
    void fontEpoch;
    if (!showNumbers || L === 0) return 0;
    return Math.ceil(measureLabel(formatInt(L).replace(/\d/g, '0'), 'number')) + 2;
  }, [showNumbers, L, fontEpoch]);

  const N =
    basesPerRow === 'auto' || !(typeof basesPerRow === 'number' && basesPerRow > 0)
      ? autoBasesPerRow(layoutWidth, DEFAULT_METRICS, numberColumnWidth)
      : Math.floor(basesPerRow);

  const layoutFeatures = useMemo<LayoutFeature[]>(
    () =>
      showFeatures
        ? record.features
            .filter((f) => f.type !== 'source' && f.segments.length > 0)
            .map((f) => ({ feature: f, translated: showTranslations && f.type === 'CDS' }))
        : [],
    [record.features, showFeatures, showTranslations],
  );
  const featureFills = useMemo(() => layoutFeatures.map((lf) => featureFill(lf.feature)), [layoutFeatures]);
  const featureStrokes = useMemo(() => featureFills.map((f) => featureStroke(f)), [featureFills]);
  const enzymes = showEnzymes ? enzymeSites : EMPTY;
  const layoutPrimers = useMemo<LayoutPrimer[]>(() => {
    if (!showPrimers || primerSites.length === 0) return [];
    const names = new Map(record.primers.map((p) => [p.id, p.name]));
    return primerSites.map((site) => ({ site, name: names.get(site.primerId) ?? '' }));
  }, [showPrimers, primerSites, record.primers]);
  const primerAnnealed = useMemo(() => {
    const byId = new Map(record.primers.map((p) => [p.id, p.sequence]));
    return layoutPrimers.map(({ site }) => {
      const s = byId.get(site.primerId) ?? '';
      const n = site.range.end - site.range.start;
      return s.length >= n ? s.slice(s.length - n).toUpperCase() : '';
    });
  }, [layoutPrimers, record.primers]);
  const visibleOrfs = showOrfs ? orfs : EMPTY;

  const model: RowModel = useMemo(() => {
    void fontEpoch;
    return buildRowModel({
      length: L,
      topology,
      width: layoutWidth,
      basesPerRow: N,
      numberColumnWidth,
      showComplement,
      features: layoutFeatures,
      enzymes,
      primers: layoutPrimers,
      orfs: visibleOrfs,
      measure: measureLabel,
    });
  }, [L, topology, layoutWidth, N, numberColumnWidth, showComplement, layoutFeatures, enzymes, layoutPrimers, visibleOrfs, fontEpoch]);

  const translator = translate ?? translateFeatureLite;
  const coding = useMemo(() => {
    const cache = new Map<number, CodingInfo | null>();
    return (index: number): CodingInfo | null => {
      const hit = cache.get(index);
      if (hit !== undefined) return hit;
      const lf = layoutFeatures[index];
      const info = lf && lf.translated ? buildCodingInfo(lf.feature, seq, topology, translator, translateFeatureLite) : null;
      cache.set(index, info);
      return info;
    };
  }, [layoutFeatures, seq, topology, translator]);

  const glyphXs = useMemo(() => {
    const cache = new Map<number, string>();
    return (n: number): string => {
      let s = cache.get(n);
      if (s === undefined) {
        const xs = new Array<string>(n);
        for (let i = 0; i < n; i++) xs[i] = String(Math.round(colCenter(model.geometry, i) * 100) / 100);
        s = xs.join(' ');
        cache.set(n, s);
      }
      return s;
    };
  }, [model.geometry]);

  const renderCtx = useMemo<RowRenderContext>(
    () => ({
      model,
      seq,
      topology,
      features: layoutFeatures,
      featureFills,
      featureStrokes,
      enzymes,
      primers: layoutPrimers,
      primerAnnealed,
      orfs: visibleOrfs,
      ends: record.ends,
      showNumbers,
      coding,
      glyphXs,
    }),
    [model, seq, topology, layoutFeatures, featureFills, featureStrokes, enzymes, layoutPrimers, primerAnnealed, visibleOrfs, record.ends, showNumbers, coding, glyphXs],
  );

  const hitBuckets = useMemo(() => bucketRangesByRow(searchHits, N, L, topology), [searchHits, N, L, topology]);

  // ---- selection ------------------------------------------------------------------------------
  const [innerSelection, setInnerSelection] = useState<SequenceSelection | null>(null);
  const controlled = selectionProp !== undefined;
  const rawSelection = controlled ? selectionProp : innerSelection;
  const selection = useMemo(() => sanitizeSelection(rawSelection, L, topology), [rawSelection, L, topology]);
  const [affinityState, setAffinityState] = useState<{ caret: number; affinity: CaretAffinity }>({
    caret: -1,
    affinity: 'downstream',
  });
  const affinity: CaretAffinity = selection && affinityState.caret === selection.caret ? affinityState.affinity : 'downstream';
  const editCtx = useMemo<EditingContext>(
    () => ({ length: L, topology, basesPerRow: N, editable: canEdit }),
    [L, topology, N, canEdit],
  );

  const lastEmitted = useRef<SequenceSelection | null>(null);
  const commitSelection = useCallback(
    (next: SequenceSelection | null, aff: CaretAffinity = 'downstream') => {
      setAffinityState({ caret: next ? next.caret : -1, affinity: aff });
      if (sameSelection(next, lastEmitted.current) && sameSelection(next, latest.current.selection)) return;
      lastEmitted.current = next;
      if (!controlled) setInnerSelection(next);
      onSelectionChange?.(next);
    },
    [controlled, onSelectionChange],
  );

  // ---- focus ----------------------------------------------------------------------------------
  const [focused, setFocused] = useState(false);
  const [keyboardFocus, setKeyboardFocus] = useState(false);
  const pointerFocus = useRef(false);

  // ---- scrolling ------------------------------------------------------------------------------
  const [scrollTop, setScrollTop] = useState(0);
  const total = model.totalHeight;
  const spacerHeight = Math.min(total, MAX_SCROLL_HEIGHT);
  const ratio = total > spacerHeight && spacerHeight > viewportHeight ? (total - viewportHeight) / (spacerHeight - viewportHeight) : 1;
  const contentTop = scrollTop * ratio;
  const shift = contentTop - scrollTop;

  // latest values for window-level listeners and effects
  const latest = useRef({
    model,
    selection,
    affinity,
    ratio,
    editCtx,
    commitSelection,
    canEdit,
    seq,
  });
  latest.current = { model, selection, affinity, ratio, editCtx, commitSelection, canEdit, seq };

  const anchorRef = useRef<{ base: number; offset: number } | null>(null);
  const onScroll = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    setScrollTop(el.scrollTop);
    const { model: mdl, ratio: rt } = latest.current;
    const top = el.scrollTop * rt;
    const r = rowAtY(mdl, top);
    anchorRef.current = { base: mdl.rows[r].start, offset: top - mdl.offsets[r] };
  }, []);

  /** Scroll so that content range [top, bottom] is visible ('center' re-centres it when it is not). */
  const revealContent = useCallback((top: number, bottom: number, mode: 'nearest' | 'center') => {
    const el = scrollerRef.current;
    if (!el) return;
    const { model: mdl, ratio: rt } = latest.current;
    const viewH = el.clientHeight || FALLBACK_HEIGHT;
    const cur = el.scrollTop * rt;
    const margin = Math.min(48, viewH / 6);
    let target: number | null = null;
    if (top >= cur + 0 && bottom <= cur + viewH) return;
    if (mode === 'center') target = (top + bottom) / 2 - viewH / 2;
    else if (top < cur) target = top - margin;
    else if (bottom > cur + viewH) target = bottom - viewH + margin;
    if (target === null) return;
    target = Math.max(0, Math.min(mdl.totalHeight - viewH, target));
    el.scrollTop = target / rt;
    setScrollTop(el.scrollTop);
  }, []);

  const revealRow = useCallback(
    (r: number, mode: 'nearest' | 'center') => {
      const { model: mdl } = latest.current;
      const row = mdl.rows[r];
      if (!row) return;
      const rowTop = mdl.offsets[r];
      const el = scrollerRef.current;
      const viewH = el?.clientHeight || FALLBACK_HEIGHT;
      if (row.height <= viewH - 32) revealContent(rowTop, rowTop + row.height, mode);
      else {
        const m = mdl.metrics;
        const strandsBottom = (mdl.showComplement ? row.y.complement : row.y.strand) + m.strandHeight;
        revealContent(rowTop + row.y.strand - 24, rowTop + strandsBottom + 24, mode);
      }
    },
    [revealContent],
  );

  const pendingReveal = useRef(false);
  useLayoutEffect(() => {
    if (!pendingReveal.current) return;
    pendingReveal.current = false;
    if (!selection) return;
    const gap = caretGap(selection, editCtx, affinity);
    revealRow(rowOfGap(model, gap, affinity === 'upstream'), 'nearest');
  });

  // keep the first visible base in place when the rows reflow (window resize)
  const prevN = useRef(N);
  useLayoutEffect(() => {
    if (prevN.current === N) return;
    prevN.current = N;
    const a = anchorRef.current;
    const el = scrollerRef.current;
    if (!a || !el) return;
    const r = rowOfBase(model, a.base);
    const target = model.offsets[r] + Math.min(a.offset, model.rows[r].height);
    el.scrollTop = target / ratio;
    setScrollTop(el.scrollTop);
  }, [N, model, ratio]);

  const lastScrollRequest = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (!scrollTo || scrollTo.requestId === lastScrollRequest.current) return;
    lastScrollRequest.current = scrollTo.requestId;
    const pos = topology === 'circular' && L > 0 ? mod(scrollTo.position, L) : Math.max(0, Math.min(L - 1, scrollTo.position));
    revealRow(rowOfBase(model, pos), 'center');
  }, [scrollTo, model, topology, L, revealRow]);

  // ---- pointer --------------------------------------------------------------------------------
  const contentPoint = useCallback((clientX: number, clientY: number) => {
    const el = scrollerRef.current;
    if (!el) return { x: 0, y: 0 };
    const rect = el.getBoundingClientRect();
    return { x: clientX - rect.left, y: clientY - rect.top + el.scrollTop * latest.current.ratio };
  }, []);

  const drag = useRef<{
    anchor: number;
    base: SequenceSelection | null;
    extend: boolean;
    head: number;
    clientX: number;
    clientY: number;
    raf: number;
  } | null>(null);

  /** Drag selection with auto-scroll; window listeners read the latest state through refs. */
  const dragApi = useMemo(() => {
    const update = () => {
      const d = drag.current;
      if (!d) return;
      const { model: mdl, editCtx: ctx, commitSelection: commit } = latest.current;
      const pt = contentPoint(d.clientX, d.clientY);
      const hit = gapAtPoint(mdl, pt.x, pt.y);
      if (hit.gap === d.head) return;
      d.head = hit.gap;
      const next = d.extend ? extendSelectionTo(d.base, hit.gap, ctx) : selectBetween(d.anchor, hit.gap, ctx.length, ctx.topology);
      commit(next, hit.upstream ? 'upstream' : 'downstream');
    };
    const tick = () => {
      const d = drag.current;
      const el = scrollerRef.current;
      if (!d || !el) return;
      const rect = el.getBoundingClientRect();
      let dy = 0;
      if (d.clientY < rect.top + AUTOSCROLL_EDGE) dy = -Math.min(AUTOSCROLL_MAX, 2 + (rect.top + AUTOSCROLL_EDGE - d.clientY) * 0.4);
      else if (d.clientY > rect.bottom - AUTOSCROLL_EDGE) dy = Math.min(AUTOSCROLL_MAX, 2 + (d.clientY - rect.bottom + AUTOSCROLL_EDGE) * 0.4);
      if (dy !== 0) {
        const before = el.scrollTop;
        el.scrollTop = before + dy;
        if (el.scrollTop !== before) {
          setScrollTop(el.scrollTop);
          update();
        }
      }
      d.raf = requestAnimationFrame(tick);
    };
    const move = (ev: MouseEvent) => {
      const d = drag.current;
      if (!d) return;
      if (ev.buttons === 0) {
        end();
        return;
      }
      d.clientX = ev.clientX;
      d.clientY = ev.clientY;
      update();
    };
    const end = () => {
      const d = drag.current;
      if (d) cancelAnimationFrame(d.raf);
      drag.current = null;
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', end);
      window.removeEventListener('blur', end);
    };
    const start = (init: { anchor: number; base: SequenceSelection | null; extend: boolean; clientX: number; clientY: number }) => {
      end();
      drag.current = { ...init, head: init.anchor, raf: requestAnimationFrame(tick) };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', end);
      window.addEventListener('blur', end);
    };
    return { start, end };
  }, [contentPoint]);

  useEffect(() => dragApi.end, [dragApi]);

  const layoutFeaturesRef = useRef(layoutFeatures);
  layoutFeaturesRef.current = layoutFeatures;

  const selectAnnotation = useCallback(
    (hit: Hit, e: ReactMouseEvent): boolean => {
      const { editCtx: ctx, selection: sel, model: mdl } = latest.current;
      switch (hit.kind) {
        case 'feature': {
          const lf = layoutFeaturesRef.current[hit.index];
          if (!lf) return false;
          const f = lf.feature;
          const extent = normalizeRange(featureExtent(f, L, topology), L, topology);
          onFeatureClick?.(f.id, { clickCount: e.detail || 1, shiftKey: e.shiftKey, metaKey: e.metaKey, ctrlKey: e.ctrlKey });
          commitSelection(e.shiftKey ? coverSelection(sel, extent, ctx) : selectRange(extent, L, topology));
          return true;
        }
        case 'translation': {
          const info = coding(hit.index);
          const pt = contentPoint(e.clientX, e.clientY);
          const base = baseAtPoint(mdl, pt.x, pt.y);
          const k = info && base >= 0 ? codonAtBase(info, base) : -1;
          if (info && k >= 0) {
            const range = codonRange(info, k, L, topology);
            commitSelection(e.shiftKey ? coverSelection(sel, range, ctx) : selectRange(range, L, topology));
          }
          return true;
        }
        case 'enzyme': {
          const site = enzymes[hit.index];
          if (!site) return false;
          onEnzymeClick?.(site);
          commitSelection(selectRange(site.range, L, topology));
          return true;
        }
        case 'primer': {
          const lp = layoutPrimers[hit.index];
          if (!lp) return false;
          onPrimerClick?.(lp.site.primerId);
          commitSelection(selectRange(lp.site.range, L, topology));
          return true;
        }
        case 'orf': {
          const orf = visibleOrfs[hit.index];
          if (!orf) return false;
          commitSelection(selectRange(orf.range, L, topology));
          return true;
        }
        default:
          return false;
      }
    },
    [L, topology, coding, commitSelection, contentPoint, enzymes, layoutPrimers, visibleOrfs, onFeatureClick, onEnzymeClick, onPrimerClick],
  );

  const onMouseDown = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>) => {
      const el = scrollerRef.current;
      if (!el || e.button !== 0) return;
      const rect = el.getBoundingClientRect();
      if (e.clientX - rect.left >= el.clientWidth) return; // vertical scrollbar
      e.preventDefault();
      pointerFocus.current = true;
      setKeyboardFocus(false);
      inputRef.current?.focus({ preventScroll: true });
      const hit = hitOf(e.target);
      if (hit && selectAnnotation(hit, e)) return;
      const { model: mdl, editCtx: ctx, selection: sel } = latest.current;
      const pt = contentPoint(e.clientX, e.clientY);
      const at = gapAtPoint(mdl, pt.x, pt.y);
      const extend = e.shiftKey && !!sel;
      if (extend) commitSelection(extendSelectionTo(sel, at.gap, ctx), at.upstream ? 'upstream' : 'downstream');
      else commitSelection(caretAt(at.gap), at.upstream ? 'upstream' : 'downstream');
      dragApi.start({ anchor: at.gap, base: sel, extend, clientX: e.clientX, clientY: e.clientY });
    },
    [selectAnnotation, contentPoint, commitSelection, dragApi],
  );

  // hover: features (reported) and enzyme labels (highlighted locally)
  const hoverFeature = useRef<string | null>(null);
  const [hoveredSite, setHoveredSite] = useState(-1);
  const onMouseMove = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>) => {
      if (drag.current) return;
      const hit = hitOf(e.target);
      const fid =
        hit && (hit.kind === 'feature' || hit.kind === 'translation') ? (layoutFeatures[hit.index]?.feature.id ?? null) : null;
      if (fid !== hoverFeature.current) {
        hoverFeature.current = fid;
        onFeatureHover?.(fid);
      }
      const site = hit && hit.kind === 'enzyme' ? hit.index : -1;
      setHoveredSite((prev) => (prev === site ? prev : site));
    },
    [layoutFeatures, onFeatureHover],
  );
  const onMouseLeave = useCallback(() => {
    if (hoverFeature.current !== null) {
      hoverFeature.current = null;
      onFeatureHover?.(null);
    }
    setHoveredSite(-1);
  }, [onFeatureHover]);

  const onContextMenuEvent = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>) => {
      if (!onContextMenu) return;
      const hit = hitOf(e.target);
      let target: MapTarget | null = null;
      if (hit) {
        if (hit.kind === 'feature' || hit.kind === 'translation') {
          const lf = layoutFeatures[hit.index];
          if (lf) target = { kind: 'feature', id: lf.feature.id };
        } else if (hit.kind === 'enzyme' && enzymes[hit.index]) target = { kind: 'enzyme', site: enzymes[hit.index] };
        else if (hit.kind === 'primer' && layoutPrimers[hit.index]) target = { kind: 'primer', id: layoutPrimers[hit.index].site.primerId };
        else if (hit.kind === 'orf' && visibleOrfs[hit.index]) target = { kind: 'orf', orf: visibleOrfs[hit.index] };
      }
      if (!target) {
        const pt = contentPoint(e.clientX, e.clientY);
        const band = bandAtY(model, pt.y);
        const base = baseAtPoint(model, pt.x, pt.y);
        if ((band === 'strand' || band === 'complement') && base >= 0 && pt.y >= 0 && pt.y < model.totalHeight) {
          target = { kind: 'sequence', position: base };
        } else target = { kind: 'background', position: gapAtPoint(model, pt.x, pt.y).gap };
      }
      onContextMenu(target, e);
    },
    [onContextMenu, layoutFeatures, enzymes, layoutPrimers, visibleOrfs, contentPoint, model],
  );

  // ---- keyboard and text input ---------------------------------------------------------------
  const mac = useMemo(isMacPlatform, []);

  const applyEdit = useCallback(
    (edit: SequenceEdit, next: SequenceSelection, aff: CaretAffinity) => {
      onEdit?.(edit);
      pendingReveal.current = true;
      lastEmitted.current = null;
      commitSelection(next, aff);
    },
    [onEdit, commitSelection],
  );

  const handleText = useCallback(
    (text: string) => {
      const { selection: sel, editCtx: ctx, affinity: aff } = latest.current;
      const intent = textIntent(text, sel, ctx, aff);
      if (intent.type === 'invalid') onInvalidInput?.(intent.text);
      else if (intent.type === 'edit') applyEdit(intent.edit, intent.selection, intent.affinity);
    },
    [applyEdit, onInvalidInput],
  );

  const resetInput = useCallback(() => {
    const input = inputRef.current;
    if (!input) return;
    if (input.value !== INPUT_PLACEHOLDER) input.value = INPUT_PLACEHOLDER;
    if (document.activeElement === input) input.select();
  }, []);

  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
      if (e.nativeEvent.isComposing || e.keyCode === 229) return;
      const { selection: sel, editCtx: ctx, affinity: aff } = latest.current;
      const intent = keyIntent(
        { key: e.key, shiftKey: e.shiftKey, altKey: e.altKey, metaKey: e.metaKey, ctrlKey: e.ctrlKey },
        sel,
        ctx,
        aff,
        mac,
      );
      switch (intent.type) {
        case 'select':
          e.preventDefault();
          pendingReveal.current = true;
          commitSelection(intent.selection, intent.affinity);
          break;
        case 'edit':
          e.preventDefault();
          applyEdit(intent.edit, intent.selection, intent.affinity);
          break;
        case 'page': {
          e.preventDefault();
          const el = scrollerRef.current;
          if (el) el.scrollTop += intent.direction * Math.max(40, el.clientHeight - 48);
          break;
        }
        case 'handled':
          e.preventDefault();
          break;
        default:
          break;
      }
    },
    [mac, commitSelection, applyEdit],
  );

  // native listeners: beforeinput (typing), composition (IME), input (fallback)
  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    let composing = false;
    const onBeforeInput = (ev: InputEvent) => {
      if (ev.isComposing || composing) return;
      const type = ev.inputType;
      if (type === 'insertText' || type === 'insertReplacementText') {
        ev.preventDefault();
        if (ev.data) handleText(ev.data);
      } else if (type.startsWith('insert') || type.startsWith('delete') || type.startsWith('history') || type.startsWith('format')) {
        ev.preventDefault();
      }
    };
    const onCompositionStart = () => {
      composing = true;
    };
    const onCompositionEnd = (ev: CompositionEvent) => {
      composing = false;
      if (ev.data) handleText(ev.data);
      resetInput();
    };
    const onInput = () => {
      if (composing) return;
      const value = input.value;
      if (value !== INPUT_PLACEHOLDER) {
        const typed = value.startsWith(INPUT_PLACEHOLDER) ? value.slice(INPUT_PLACEHOLDER.length) : value;
        if (typed) handleText(typed);
      }
      resetInput();
    };
    input.addEventListener('beforeinput', onBeforeInput);
    input.addEventListener('compositionstart', onCompositionStart);
    input.addEventListener('compositionend', onCompositionEnd);
    input.addEventListener('input', onInput);
    return () => {
      input.removeEventListener('beforeinput', onBeforeInput);
      input.removeEventListener('compositionstart', onCompositionStart);
      input.removeEventListener('compositionend', onCompositionEnd);
      input.removeEventListener('input', onInput);
    };
  }, [handleText, resetInput]);

  const onCopy = useCallback((e: ReactClipboardEvent<HTMLTextAreaElement>) => {
    const { seq: s, selection: sel } = latest.current;
    e.preventDefault();
    const text = copyText(s, sel);
    if (text) e.clipboardData.setData('text/plain', text);
  }, []);

  const onCut = useCallback(
    (e: ReactClipboardEvent<HTMLTextAreaElement>) => {
      e.preventDefault();
      const { seq: s, selection: sel, editCtx: ctx } = latest.current;
      const cut = cutIntent(s, sel, ctx);
      if (!cut) return;
      e.clipboardData.setData('text/plain', cut.text);
      applyEdit(cut.intent.edit, cut.intent.selection, cut.intent.affinity);
    },
    [applyEdit],
  );

  const onPaste = useCallback(
    (e: ReactClipboardEvent<HTMLTextAreaElement>) => {
      e.preventDefault();
      if (!latest.current.canEdit) return;
      const text = e.clipboardData.getData('text/plain');
      if (text) handleText(text);
    },
    [handleText],
  );

  const onFocus = useCallback(() => {
    setFocused(true);
    setKeyboardFocus(!pointerFocus.current);
    pointerFocus.current = false;
    resetInput();
  }, [resetInput]);
  const onBlur = useCallback(() => {
    setFocused(false);
    setKeyboardFocus(false);
  }, []);

  // ---- render -------------------------------------------------------------------------------
  const geo = model.geometry;
  const m = model.metrics;
  const firstRow = rowAtY(model, contentTop - OVERSCAN);
  const lastRow = rowAtY(model, contentTop + viewportHeight + OVERSCAN);

  const selected = hasSelectedBases(selection);
  const caretAbs = selection ? caretGap(selection, editCtx, affinity) : -1;
  const caretRowIndex = selection && !selected ? rowOfGap(model, caretAbs, affinity === 'upstream') : -1;
  const caretInfo = (() => {
    if (!selection) return null;
    const r = rowOfGap(model, caretAbs, affinity === 'upstream');
    const row = model.rows[r];
    const x = gapX(geo, caretAbs - row.start, row.end - row.start);
    return { row: r, x, top: model.offsets[r] + row.y.strand };
  })();

  const highlightIndex = useMemo(
    () => (highlightedFeatureId ? layoutFeatures.findIndex((lf) => lf.feature.id === highlightedFeatureId) : -1),
    [highlightedFeatureId, layoutFeatures],
  );
  const highlightExtent = useMemo(() => {
    if (highlightIndex < 0) return null;
    return featureExtent(layoutFeatures[highlightIndex].feature, L, topology);
  }, [highlightIndex, layoutFeatures, L, topology]);
  const hoveredRange = hoveredSite >= 0 ? (enzymes[hoveredSite]?.range ?? null) : null;

  const rowsOut: ReactNode[] = [];
  for (let r = firstRow; r <= lastRow; r++) {
    const row = model.rows[r];
    const selCols = selected ? rangeColsInRow(selection.range, row.start, row.end, L, topology) : (EMPTY as never[]);
    const hits = hitBuckets.get(r);
    let hitsTop: Array<[number, number]> = EMPTY as never[];
    let hitsBottom: Array<[number, number]> = EMPTY as never[];
    if (hits) {
      hitsTop = [];
      hitsBottom = [];
      for (const h of hits) {
        const cols = rangeColsInRow(h.range, row.start, row.end, L, topology);
        if (h.strand === -1 && showComplement) hitsBottom.push(...cols);
        else hitsTop.push(...cols);
      }
    }
    let bands: Array<[number, number]> = EMPTY as never[];
    if (highlightExtent || hoveredRange) {
      bands = [];
      if (highlightExtent) bands.push(...rangeColsInRow(highlightExtent, row.start, row.end, L, topology));
      if (hoveredRange) bands.push(...rangeColsInRow(hoveredRange, row.start, row.end, L, topology));
    }
    const rowHighlight = highlightIndex >= 0 && row.features.some((p) => p.feature === highlightIndex) ? highlightIndex : -1;
    const rowHover = hoveredSite >= 0 && row.enzymeLabels.some((l) => l.site === hoveredSite) ? hoveredSite : -1;
    const caretHere = caretRowIndex === r && caretInfo;
    rowsOut.push(
      <div key={r} className={styles.row} style={{ top: model.offsets[r] - shift, height: row.height }} data-row={r}>
        <RowBackdrop
          row={row}
          model={model}
          selection={selCols}
          hitsTop={hitsTop}
          hitsBottom={hitsBottom}
          bands={bands}
          focused={focused}
        />
        <RowContent row={row} ctx={renderCtx} highlighted={rowHighlight} hoveredSite={rowHover} />
        {caretHere && (
          <div
            key={`caret-${caretAbs}-${affinity}`}
            className={focused ? `${styles.caret} ${styles.caretBlink}` : `${styles.caret} ${styles.caretInactive}`}
            style={{
              left: caretInfo.x - 1,
              top: row.y.strand - 2,
              height: (showComplement ? 2 : 1) * m.strandHeight + 4,
            }}
          />
        )}
        {L === 0 && r === 0 && (
          <div className={styles.emptyHint} style={{ left: geo.textLeft + 10, top: row.y.strand }}>
            {canEdit ? 'Empty sequence. Type or paste bases.' : 'Empty sequence'}
          </div>
        )}
      </div>,
    );
  }

  const rootClass = [styles.root, className].filter(Boolean).join(' ');
  return (
    <div
      className={rootClass}
      data-focused={focused ? 'true' : undefined}
      data-keyboard-focus={keyboardFocus ? 'true' : undefined}
    >
      <div
        ref={scrollerRef}
        className={styles.scroller}
        onScroll={onScroll}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseLeave={onMouseLeave}
        onContextMenu={onContextMenuEvent}
      >
        <div className={styles.canvas} style={{ height: spacerHeight }}>
          {rowsOut}
          <textarea
            ref={inputRef}
            className={styles.input}
            style={caretInfo ? { top: caretInfo.top - shift, left: caretInfo.x } : undefined}
            aria-label={`${record.name || 'Sequence'}: ${formatBp(L)} ${topology}${canEdit ? '' : ', read only'}`}
            aria-readonly={!canEdit}
            readOnly={!canEdit}
            defaultValue={INPUT_PLACEHOLDER}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            rows={1}
            onKeyDown={onKeyDown}
            onKeyUp={resetInput}
            onCopy={onCopy}
            onCut={onCut}
            onPaste={onPaste}
            onFocus={onFocus}
            onBlur={onBlur}
          />
        </div>
      </div>
      <div className={styles.srOnly} aria-live="polite">
        {focused ? describeSelection(selection, L) : ''}
      </div>
    </div>
  );
}
