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
 *
 * Pass stable (memoized) arrays and callbacks: the row model is rebuilt whenever the record,
 * the annotation arrays, `translate` or the number of bases per row change.
 */
import type { EnzymeSite, Feature, Orf, PrimerBindingSite, SearchHit, SeqRecord, Topology } from '@hhereditas/core';
import { featureExtent, mod, normalizeRange } from '@hhereditas/core';
import {
  type ClipboardEvent as ReactClipboardEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { featureFill, featureStroke } from '../common/colors';
import { formatBp, formatInt } from '../common/format';
import type { SequenceSelection } from '../selection';
import { caretAt, hasSelectedBases, selectBetween, selectRange } from '../selection';
import type { CaretAffinity, EditingContext } from './editing';
import { caretGap, copyText, coverSelection, cutIntent, extendSelectionTo, keyIntent, textIntent } from './editing';
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
  /** Also selects the feature's extent (onSelectionChange); shift+click extends the selection over it. */
  onFeatureClick?: (featureId: string, info: FeatureClickInfo) => void;
  onFeatureHover?: (featureId: string | null) => void;
  /** Also selects the recognition site. */
  onEnzymeClick?: (site: EnzymeSite) => void;
  /** Also selects the binding site. */
  onPrimerClick?: (primerId: string) => void;
  /** What is under the pointer; call event.preventDefault() to replace the native menu. The selection is unchanged. */
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
/** The hidden textarea always holds this one selected character so copy / cut events fire. */
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

/** The annotation under the pointer, from the data-kind / data-index attributes of the drawing. */
function hitOf(target: EventTarget | null): Hit | null {
  if (!target || typeof (target as Element).closest !== 'function') return null;
  const el = (target as Element).closest('[data-kind]');
  if (!el) return null;
  const kind = el.getAttribute('data-kind');
  const index = Number(el.getAttribute('data-index'));
  return kind && Number.isInteger(index) ? { kind, index } : null;
}

/** A length in the record's unit: "2,686 bp" or "263 aa". */
function formatLength(n: number, protein: boolean): string {
  return protein ? `${formatInt(n)} aa` : formatBp(n);
}

/** Screen-reader description of the selection (1-based positions). */
function describeSelection(sel: SequenceSelection | null, L: number, protein: boolean): string {
  if (!sel) return '';
  const len = sel.range.end - sel.range.start;
  const unit = protein ? 'residue' : 'base';
  if (len <= 0) {
    const gap = Math.min(sel.caret, L);
    return gap === 0 ? `Cursor before ${unit} 1 of ${formatInt(L)}` : `Cursor after ${unit} ${formatInt(gap)} of ${formatInt(L)}`;
  }
  const last = sel.range.end > L ? sel.range.end - L : sel.range.end;
  return `Selected ${formatInt(sel.range.start + 1)} to ${formatInt(last)}, ${formatLength(len, protein)}`;
}

/**
 * Client size of the scroller (excludes its scrollbar). `measured` turns true after the first
 * layout pass (before the first paint), even when the element has no size (jsdom, hidden tabs).
 */
function useClientSize(ref: RefObject<HTMLElement | null>): { width: number; height: number; measured: boolean } {
  const [size, setSize] = useState({ width: 0, height: 0, measured: false });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      const width = el.clientWidth;
      const height = el.clientHeight;
      setSize((prev) => (prev.measured && prev.width === width && prev.height === height ? prev : { width, height, measured: true }));
    };
    update();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return size;
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
  const size = useClientSize(scrollerRef);
  const measured = size.measured;
  const viewportWidth = size.width > 0 ? size.width : FALLBACK_WIDTH;
  const viewportHeight = size.height > 0 ? size.height : FALLBACK_HEIGHT;

  // ---- fonts --------------------------------------------------------------------------------
  // Label widths are measured in the real fonts: re-measure once web fonts have loaded.
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
    typeof basesPerRow === 'number' && basesPerRow >= 1
      ? Math.floor(basesPerRow)
      : autoBasesPerRow(viewportWidth, DEFAULT_METRICS, numberColumnWidth);

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
      const n = Math.max(0, Math.min(site.annealedLength, site.range.end - site.range.start));
      return s.length >= n ? s.slice(s.length - n).toUpperCase() : '';
    });
  }, [layoutPrimers, record.primers]);
  /** 5' tail of each primer in display order (left to right), lower case: it does not anneal. */
  const primerTails = useMemo(() => {
    const byId = new Map(record.primers.map((p) => [p.id, p.sequence]));
    return layoutPrimers.map(({ site }) => {
      const s = byId.get(site.primerId) ?? '';
      const tail = s.slice(0, Math.max(0, Math.min(site.tailLength, s.length))).toLowerCase();
      // a reverse primer is drawn 3'->5' (like the bottom strand): its tail continues to the right
      return site.strand === 1 ? tail : [...tail].reverse().join('');
    });
  }, [layoutPrimers, record.primers]);
  const visibleOrfs = showOrfs ? orfs : EMPTY;

  // Until the viewport has been measured (synchronously, before the first paint) the number of
  // bases per row is unknown: use an empty placeholder instead of laying out the record twice.
  const model: RowModel = useMemo(() => {
    void fontEpoch;
    if (!measured) return buildRowModel({ length: 0, topology, basesPerRow: N, numberColumnWidth, showComplement });
    return buildRowModel({
      length: L,
      topology,
      basesPerRow: N,
      numberColumnWidth,
      showComplement,
      features: layoutFeatures,
      enzymes,
      primers: layoutPrimers,
      orfs: visibleOrfs,
      measure: measureLabel,
    });
  }, [measured, L, topology, N, numberColumnWidth, showComplement, layoutFeatures, enzymes, layoutPrimers, visibleOrfs, fontEpoch]);

  const translator = translate ?? translateFeatureLite;
  /** Coding information of a translated feature, computed lazily (only for rows on screen). */
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

  /** x positions (glyph centres) of the bases of a row of n bases, as an SVG coordinate list. */
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
      primerTails,
      orfs: visibleOrfs,
      ends: record.ends,
      showNumbers,
      coding,
      glyphXs,
    }),
    [model, seq, topology, layoutFeatures, featureFills, featureStrokes, enzymes, layoutPrimers, primerAnnealed, primerTails, visibleOrfs, record.ends, showNumbers, coding, glyphXs],
  );

  const hitBuckets = useMemo(() => bucketRangesByRow(searchHits, N, L, topology), [searchHits, N, L, topology]);

  // ---- selection ------------------------------------------------------------------------------
  const [innerSelection, setInnerSelection] = useState<SequenceSelection | null>(null);
  const controlled = selectionProp !== undefined;
  const rawSelection = controlled ? selectionProp : innerSelection;
  const selection = useMemo(() => sanitizeSelection(rawSelection, L, topology), [rawSelection, L, topology]);
  // On circular records gap 0 and gap L are one place; the affinity says on which row the caret is drawn.
  const [affinityState, setAffinityState] = useState<{ caret: number; affinity: CaretAffinity }>({
    caret: -1,
    affinity: 'downstream',
  });
  const affinity: CaretAffinity = selection && affinityState.caret === selection.caret ? affinityState.affinity : 'downstream';
  const molecule = record.molecule;
  const editCtx = useMemo<EditingContext>(
    () => ({ length: L, topology, basesPerRow: N, editable: canEdit, molecule }),
    [L, topology, N, canEdit, molecule],
  );

  // ---- scrolling ------------------------------------------------------------------------------
  const [scrollTop, setScrollTop] = useState(0);
  const total = model.totalHeight;
  const spacerHeight = Math.min(total, MAX_SCROLL_HEIGHT);
  const ratio = total > spacerHeight && spacerHeight > viewportHeight ? (total - viewportHeight) / (spacerHeight - viewportHeight) : 1;
  const contentTop = scrollTop * ratio;
  const shift = contentTop - scrollTop;

  // Latest values for window-level listeners, effects and stable callbacks.
  const latest = useRef({ model, selection, affinity, ratio, editCtx, canEdit, seq, onSelectionChange, controlled });
  useLayoutEffect(() => {
    latest.current = { model, selection, affinity, ratio, editCtx, canEdit, seq, onSelectionChange, controlled };
  });

  const lastEmitted = useRef<SequenceSelection | null>(null);
  const commitSelection = useCallback((next: SequenceSelection | null, aff: CaretAffinity = 'downstream') => {
    setAffinityState({ caret: next ? next.caret : -1, affinity: aff });
    const cur = latest.current;
    if (sameSelection(next, lastEmitted.current) && sameSelection(next, cur.selection)) return;
    lastEmitted.current = next;
    if (!cur.controlled) setInnerSelection(next);
    cur.onSelectionChange?.(next);
  }, []);

  /**
   * Scroll anchor: a base of the row at the top of the viewport and the offset into that row.
   * Restored whenever the model changes (resize, edits, layers toggled) so the text under the
   * user's eyes stays put.
   *
   * The base is kept for as long as the top row contains it (only the offset follows the scroll
   * position). Re-anchoring to the start of the row on every scroll event would lose up to N-1
   * bases per change of the bases per row, because restoring the position fires a scroll event of
   * its own; repeated resizes would then make the text drift down the screen.
   */
  const anchorRef = useRef<{ base: number; offset: number }>({ base: 0, offset: 0 });
  const updateAnchor = useCallback((el: HTMLElement) => {
    const { model: mdl, ratio: rt } = latest.current;
    const top = el.scrollTop * rt;
    const r = rowAtY(mdl, top);
    const row = mdl.rows[r];
    const prev = anchorRef.current.base;
    const base = prev >= row.start && prev < Math.max(row.end, row.start + 1) ? prev : row.start;
    anchorRef.current = { base, offset: top - mdl.offsets[r] };
  }, []);

  /** Scroll the content (unscaled px) to `top`. */
  const scrollContentTo = useCallback(
    (top: number) => {
      const el = scrollerRef.current;
      if (!el) return;
      const { model: mdl, ratio: rt } = latest.current;
      const viewH = el.clientHeight || FALLBACK_HEIGHT;
      const clamped = Math.max(0, Math.min(Math.max(0, mdl.totalHeight - viewH), top));
      el.scrollTop = clamped / rt;
      setScrollTop(el.scrollTop);
      updateAnchor(el);
    },
    [updateAnchor],
  );

  /** scrollTop written by the anchor restore below; its scroll event must not move the anchor. */
  const restoreEcho = useRef<number | null>(null);

  const onScroll = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    setScrollTop(el.scrollTop);
    const echo = restoreEcho.current;
    restoreEcho.current = null;
    // The scroll event of our own restoring write: keep the anchor exactly as the user left it.
    // (A narrower layout may have clamped the offset to a shorter row; going back must not lose it.)
    if (echo !== null && Math.abs(el.scrollTop - echo) < 0.5) return;
    updateAnchor(el);
  }, [updateAnchor]);

  const prevModel = useRef(model);
  const prevRecordId = useRef(record.id);
  useLayoutEffect(() => {
    if (prevModel.current === model) return;
    prevModel.current = model;
    const el = scrollerRef.current;
    if (!el) return;
    // another document: start at its beginning instead of at the old document's position
    if (prevRecordId.current !== record.id) {
      prevRecordId.current = record.id;
      anchorRef.current = { base: 0, offset: 0 };
    }
    const a = anchorRef.current;
    const r = rowOfBase(model, a.base);
    // stay inside the anchor's row (so the scroll event that follows keeps the anchor base)
    const target = model.offsets[r] + Math.max(0, Math.min(a.offset, model.rows[r].height - 1));
    const next = target / ratio;
    const before = el.scrollTop;
    if (Math.abs(before - next) >= 1) {
      el.scrollTop = next;
      if (el.scrollTop !== before) restoreEcho.current = el.scrollTop;
      setScrollTop(el.scrollTop);
    }
  }, [model, ratio, record.id]);

  /** Scroll so that content range [top, bottom] is visible ('center' re-centres it when it is not). */
  const revealContent = useCallback(
    (top: number, bottom: number, mode: 'nearest' | 'center') => {
      const el = scrollerRef.current;
      if (!el) return;
      const viewH = el.clientHeight || FALLBACK_HEIGHT;
      const cur = el.scrollTop * latest.current.ratio;
      if (top >= cur && bottom <= cur + viewH) return;
      const margin = Math.min(48, viewH / 6);
      let target: number;
      if (mode === 'center') target = (top + bottom) / 2 - viewH / 2;
      else if (top < cur) target = top - margin;
      else target = bottom - viewH + margin;
      scrollContentTo(target);
    },
    [scrollContentTo],
  );

  /** Reveal a row (its strands when the row is taller than the viewport). */
  const revealRow = useCallback(
    (r: number, mode: 'nearest' | 'center') => {
      const { model: mdl } = latest.current;
      const row = mdl.rows[r];
      if (!row) return;
      const rowTop = mdl.offsets[r];
      const viewH = scrollerRef.current?.clientHeight || FALLBACK_HEIGHT;
      if (row.height <= viewH - 32) revealContent(rowTop, rowTop + row.height, mode);
      else {
        const m = mdl.metrics;
        const strandsBottom = (mdl.showComplement ? row.y.complement : row.y.strand) + m.strandHeight;
        revealContent(rowTop + row.y.strand - 24, rowTop + strandsBottom + 24, mode);
      }
    },
    [revealContent],
  );

  /**
   * Scroll horizontally so that content x is visible (a fixed number of bases per row can make the
   * rows wider than the view). Near the start of a row the row numbers are brought in too.
   */
  const revealX = useCallback((x: number) => {
    const el = scrollerRef.current;
    if (!el) return;
    const viewW = el.clientWidth;
    const maxLeft = Math.max(0, latest.current.model.geometry.width - viewW);
    if (viewW <= 0 || maxLeft <= 0) return;
    const left = el.scrollLeft;
    const margin = Math.min(48, viewW / 6);
    let target = left;
    if (x < left + margin) target = x - margin;
    else if (x > left + viewW - margin) target = x - viewW + margin;
    else return;
    if (target <= latest.current.model.geometry.textLeft) target = 0;
    el.scrollLeft = Math.max(0, Math.min(maxLeft, target));
  }, []);

  // Keyboard moves and edits scroll the caret into view once the new selection (and, after an
  // edit, the new layout) is committed. A controlled parent may apply the selection in a later
  // render than the one caused by the key press, so the reveal waits for its target.
  const pendingReveal = useRef<{ target: SequenceSelection; from: SequenceSelection | null } | null>(null);
  useLayoutEffect(() => {
    const pending = pendingReveal.current;
    if (!pending) return;
    if (!sameSelection(selection, pending.target)) {
      // not applied yet: keep waiting; replaced by another selection: drop the request
      if (!sameSelection(selection, pending.from)) pendingReveal.current = null;
      return;
    }
    pendingReveal.current = null;
    if (!selection) return;
    const gap = caretGap(selection, editCtx, affinity);
    const r = rowOfGap(model, gap, affinity === 'upstream');
    revealRow(r, 'nearest');
    const row = model.rows[r];
    if (row) revealX(gapX(model.geometry, gap - row.start, row.end - row.start));
  });

  // scroll requests wait until the viewport has been measured (the row model depends on its width)
  const lastScrollRequest = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (!scrollTo || scrollTo.requestId === lastScrollRequest.current || !measured) return;
    lastScrollRequest.current = scrollTo.requestId;
    if (L === 0) return;
    const pos = topology === 'circular' ? mod(Math.floor(scrollTo.position), L) : Math.max(0, Math.min(L - 1, Math.floor(scrollTo.position)));
    const r = rowOfBase(model, pos);
    revealRow(r, 'center');
    revealX(colCenter(model.geometry, pos - model.rows[r].start));
  }, [scrollTo, measured, model, topology, L, revealRow, revealX]);

  // ---- focus ----------------------------------------------------------------------------------
  const [focused, setFocused] = useState(false);
  const [keyboardFocus, setKeyboardFocus] = useState(false);
  const pointerFocus = useRef(false);

  // ---- pointer --------------------------------------------------------------------------------
  /** Pointer position in content coordinates (x from the view's left edge, y from the first row). */
  const contentPoint = useCallback((clientX: number, clientY: number) => {
    const el = scrollerRef.current;
    if (!el) return { x: 0, y: 0 };
    const rect = el.getBoundingClientRect();
    return { x: clientX - rect.left + el.scrollLeft, y: clientY - rect.top + el.scrollTop * latest.current.ratio };
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
      const { model: mdl, editCtx: ctx } = latest.current;
      const pt = contentPoint(d.clientX, d.clientY);
      const hit = gapAtPoint(mdl, pt.x, pt.y);
      if (hit.gap === d.head) return;
      d.head = hit.gap;
      const next = d.extend ? extendSelectionTo(d.base, hit.gap, ctx) : selectBetween(d.anchor, hit.gap, ctx.length, ctx.topology);
      commitSelection(next, hit.upstream ? 'upstream' : 'downstream');
    };
    const tick = () => {
      const d = drag.current;
      const el = scrollerRef.current;
      if (!d || !el) return;
      const rect = el.getBoundingClientRect();
      const speed = (overshoot: number) => Math.min(AUTOSCROLL_MAX, 2 + overshoot * 0.4);
      let dy = 0;
      if (d.clientY < rect.top + AUTOSCROLL_EDGE) dy = -speed(rect.top + AUTOSCROLL_EDGE - d.clientY);
      else if (d.clientY > rect.bottom - AUTOSCROLL_EDGE) dy = speed(d.clientY - rect.bottom + AUTOSCROLL_EDGE);
      if (dy !== 0) {
        const before = el.scrollTop;
        el.scrollTop = before + dy;
        if (el.scrollTop !== before) {
          setScrollTop(el.scrollTop);
          updateAnchor(el);
        }
      }
      // rows wider than the view (fixed bases per row) also scroll sideways at the left / right edge
      if (latest.current.model.geometry.width > el.clientWidth + 1) {
        const right = rect.left + (el.clientWidth || rect.width);
        let dx = 0;
        if (d.clientX < rect.left + AUTOSCROLL_EDGE) dx = -speed(rect.left + AUTOSCROLL_EDGE - d.clientX);
        else if (d.clientX > right - AUTOSCROLL_EDGE) dx = speed(d.clientX - right + AUTOSCROLL_EDGE);
        if (dx !== 0) el.scrollLeft += dx;
      }
      // every frame: the content under a still pointer changes while scrolling (auto-scroll, wheel)
      update();
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
  }, [contentPoint, commitSelection, updateAnchor]);

  useEffect(() => dragApi.end, [dragApi]);

  /** Click on an annotation: select it (and report it). Returns false when `hit` is not one. */
  const selectAnnotation = useCallback(
    (hit: Hit, e: ReactMouseEvent): boolean => {
      const { editCtx: ctx, selection: sel, model: mdl } = latest.current;
      switch (hit.kind) {
        case 'feature': {
          const lf = layoutFeatures[hit.index];
          if (!lf) return false;
          const f = lf.feature;
          const extent = normalizeRange(featureExtent(f, L, topology), L, topology);
          commitSelection(e.shiftKey ? coverSelection(sel, extent, ctx) : selectRange(extent, L, topology));
          onFeatureClick?.(f.id, { clickCount: e.detail || 1, shiftKey: e.shiftKey, metaKey: e.metaKey, ctrlKey: e.ctrlKey });
          return true;
        }
        case 'translation': {
          const info = coding(hit.index);
          const pt = contentPoint(e.clientX, e.clientY);
          const base = baseAtPoint(mdl, pt.x, pt.y);
          const k = info && base >= 0 ? codonAtBase(info, base) : -1;
          if (!info || k < 0) return false;
          const range = codonRange(info, k, L, topology);
          commitSelection(e.shiftKey ? coverSelection(sel, range, ctx) : selectRange(range, L, topology));
          return true;
        }
        case 'enzyme': {
          const site = enzymes[hit.index];
          if (!site) return false;
          commitSelection(selectRange(site.range, L, topology));
          onEnzymeClick?.(site);
          return true;
        }
        case 'primer': {
          const lp = layoutPrimers[hit.index];
          if (!lp) return false;
          commitSelection(selectRange(lp.site.range, L, topology));
          onPrimerClick?.(lp.site.primerId);
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
    [L, topology, layoutFeatures, coding, commitSelection, contentPoint, enzymes, layoutPrimers, visibleOrfs, onFeatureClick, onEnzymeClick, onPrimerClick],
  );

  const onMouseDown = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>) => {
      const el = scrollerRef.current;
      if (!el || e.button !== 0) return;
      const rect = el.getBoundingClientRect();
      // the scrollbars are not content
      if (el.clientWidth > 0 && e.clientX - rect.left >= el.clientWidth) return;
      if (el.clientHeight > 0 && e.clientY - rect.top >= el.clientHeight) return;
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
        const g = model.geometry;
        const overText = pt.x >= g.textLeft - 1 && pt.x <= g.textRight + 1;
        if ((band === 'strand' || band === 'complement') && overText && base >= 0 && pt.y >= 0 && pt.y < model.totalHeight) {
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
      pendingReveal.current = { target: next, from: latest.current.selection };
      onEdit?.(edit);
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

  /** Put the placeholder back into the textarea and select it (keeps copy / cut enabled). */
  const resetInput = useCallback(() => {
    const input = inputRef.current;
    if (!input) return;
    if (input.value !== INPUT_PLACEHOLDER) input.value = INPUT_PLACEHOLDER;
    if (typeof document !== 'undefined' && document.activeElement === input) input.select();
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
          pendingReveal.current = { target: intent.selection, from: latest.current.selection };
          commitSelection(intent.selection, intent.affinity);
          break;
        case 'edit':
          e.preventDefault();
          applyEdit(intent.edit, intent.selection, intent.affinity);
          break;
        case 'page': {
          e.preventDefault();
          const el = scrollerRef.current;
          if (el) scrollContentTo(el.scrollTop * latest.current.ratio + intent.direction * Math.max(40, el.clientHeight - 48));
          break;
        }
        case 'handled':
          e.preventDefault();
          break;
        default:
          break;
      }
    },
    [mac, commitSelection, applyEdit, scrollContentTo],
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
        // paste, cut, line breaks, undo: handled by their own events (or the app)
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
      if (cut) {
        e.clipboardData.setData('text/plain', cut.text);
        applyEdit(cut.intent.edit, cut.intent.selection, cut.intent.affinity);
      } else {
        // read-only: cut copies
        const text = copyText(s, sel);
        if (text) e.clipboardData.setData('text/plain', text);
      }
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
    const byKeyboard = !pointerFocus.current;
    setFocused(true);
    setKeyboardFocus(byKeyboard);
    pointerFocus.current = false;
    resetInput();
    // Tabbing into a view without a selection puts the caret at the start of the first row on
    // screen, so arrows and typing start where the user is looking.
    const { selection: sel, model: mdl, ratio: rt } = latest.current;
    const el = scrollerRef.current;
    if (byKeyboard && !sel && el && mdl.length > 0) {
      const top = el.scrollTop * rt;
      let r = rowAtY(mdl, top);
      if (mdl.offsets[r] + mdl.rows[r].y.strand < top && r + 1 < mdl.rowCount) r++;
      commitSelection(caretAt(mdl.rows[r].start));
    }
  }, [resetInput, commitSelection]);
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
  const caretRowIndex = selection ? rowOfGap(model, caretAbs, affinity === 'upstream') : -1;
  const caretRow = caretRowIndex >= 0 ? model.rows[caretRowIndex] : null;
  const caretX = caretRow ? gapX(geo, caretAbs - caretRow.start, caretRow.end - caretRow.start) : 0;

  const highlightIndex = useMemo(
    () => (highlightedFeatureId ? layoutFeatures.findIndex((lf) => lf.feature.id === highlightedFeatureId) : -1),
    [highlightedFeatureId, layoutFeatures],
  );
  const highlightExtent = useMemo(() => {
    if (highlightIndex < 0) return null;
    return featureExtent(layoutFeatures[highlightIndex].feature, L, topology);
  }, [highlightIndex, layoutFeatures, L, topology]);
  const hoveredRange = hoveredSite >= 0 ? (enzymes[hoveredSite]?.range ?? null) : null;

  // Enzyme sites whose recognition site is exactly the selection (e.g. after clicking a label).
  const selectedSites = useMemo<readonly number[]>(() => {
    if (!hasSelectedBases(selection) || enzymes.length === 0 || L === 0) return EMPTY;
    const r = normalizeRange(selection.range, L, topology);
    const len = r.end - r.start;
    const circ = topology === 'circular';
    const out: number[] = [];
    for (let i = 0; i < enzymes.length; i++) {
      const s = enzymes[i].range;
      if (s.end - s.start === len && (circ ? mod(s.start, L) : s.start) === r.start) out.push(i);
    }
    return out.length > 0 ? out : EMPTY;
  }, [selection, enzymes, L, topology]);
  // hovered and selected sites get their cut lines emphasised (sorted: compared by value per row)
  const activeSites = useMemo<readonly number[]>(() => {
    if (hoveredSite < 0 || selectedSites.includes(hoveredSite)) return selectedSites;
    return [...selectedSites, hoveredSite].sort((a, b) => a - b);
  }, [hoveredSite, selectedSites]);

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
    let rowActive: readonly number[] = EMPTY;
    if (activeSites.length > 0 && (row.enzymeLabels.length > 0 || row.cutMarks.length > 0)) {
      const here = activeSites.filter(
        (s) => row.enzymeLabels.some((l) => l.site === s) || row.cutMarks.some((c) => c.site === s),
      );
      if (here.length > 0) rowActive = here;
    }
    const trSelection = selCols.length > 0 && row.features.some((p) => p.translated) ? selCols : (EMPTY as never[]);
    const caretHere = !selected && caretRowIndex === r;
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
        <RowContent
          row={row}
          ctx={renderCtx}
          highlighted={rowHighlight}
          activeSites={rowActive}
          translationSelection={trSelection}
          selectionFocused={trSelection.length > 0 && focused}
        />
        {caretHere && (
          <div
            key={`caret-${caretAbs}-${affinity}`}
            className={focused ? `${styles.caret} ${styles.caretBlink}` : `${styles.caret} ${styles.caretInactive}`}
            style={{
              left: caretX - 1,
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

  // The hidden textarea follows the caret (IME candidate windows open there) while the caret's
  // row is rendered; otherwise it stays in view so focusing it never scrolls the view.
  const caretRendered = caretRow !== null && caretRowIndex >= firstRow && caretRowIndex <= lastRow;
  const inputStyle = caretRendered
    ? { top: model.offsets[caretRowIndex] + caretRow.y.strand - shift, left: caretX }
    : { top: scrollTop, left: geo.textLeft };

  const rootClass = [styles.root, className].filter(Boolean).join(' ');
  return (
    <div
      className={rootClass}
      data-focused={focused ? 'true' : undefined}
      data-keyboard-focus={keyboardFocus ? 'true' : undefined}
      data-enzyme-hover={hoveredSite >= 0 ? 'true' : undefined}
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
        <div className={styles.canvas} style={{ height: spacerHeight, minWidth: geo.width }}>
          {rowsOut}
          <textarea
            ref={inputRef}
            className={styles.input}
            style={inputStyle}
            aria-label={`${record.name || 'Sequence'}: ${formatLength(L, isProtein)} ${isProtein ? 'protein' : topology}${canEdit ? '' : ', read only'}`}
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
        {focused ? describeSelection(selection, L, isProtein) : ''}
      </div>
    </div>
  );
}
