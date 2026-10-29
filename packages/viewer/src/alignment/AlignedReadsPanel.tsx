/**
 * Trace panel of the alignment mode (SnapGene's "Original Sequence" pane under the sequence view): the reference on
 * top, then for every aligned read an information column, its bases along the reference (differences highlighted,
 * insertions marked) and its chromatogram. Scrolls horizontally along the reference; only the visible columns are
 * drawn.
 */
import type { AlignedSequence, Range, SeqRecord } from '@hhereditas/core';
import type { MouseEvent as ReactMouseEvent, ReactNode } from 'react';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { formatInt } from '../common/format';
import { alignedReadSpan, buildReadModel, type ReadModel } from './readModel';
import styles from './AlignedReadsPanel.module.css';
import { ZoomSlider } from './ZoomSlider';

export interface AlignedReadsPanelProps {
  record: SeqRecord;
  /** The reads to show, in display order (only aligned ones are drawn). */
  reads: readonly AlignedSequence[];
  /** Reference position to bring into view; the panel scrolls whenever it changes. */
  centerPosition?: number | null;
  /** Shaded on every row (e.g. the selection of the sequence view). */
  highlight?: Range | null;
  /** A reference column was clicked (also used by the previous / next difference buttons). */
  onPositionClick?: (position: number) => void;
  /** Width of the information column (px); default TRACE_INFO_WIDTH. A view scrolled together with the panel
   *  starts its first column this far right of the panel's left edge. */
  infoWidth?: number;
  /** Horizontal scroll offset to apply (px), for scrolling together with another view. */
  scrollLeft?: number;
  /** The panel was scrolled horizontally (px). */
  onScrollLeftChange?: (left: number) => void;
  className?: string;
}

/** Width of one reference column (px); a view scrolled together with the panel must use the same. */
export const TRACE_COLUMN_WIDTH = 11;
/** Width of the information column left of the reads (px); the reference starts this far from the left edge. */
export const TRACE_INFO_WIDTH = 216;
/** Empty space after the last column (px), as the sequence view's right padding. */
export const TRACE_RIGHT_PADDING = 24;
const COL = TRACE_COLUMN_WIDTH;
const HEADER_H = 38;
const BASES_H = 20;
const TRACE_H = 60;
const RULER_H = 16;
const PAD = 4;
const OVERSCAN = 6;
/** Deletions longer than this are drawn as a line, without highlight or stretched trace. */
const LONG_DELETION = 10;
const TRACE_COLORS = { a: '#1fa51f', c: '#2b5ce6', g: '#222222', t: '#e0242b' } as const;

const models = new WeakMap<AlignedSequence, { ref: string; model: ReadModel }>();
function modelOf(read: AlignedSequence, refSeq: string): ReadModel {
  const hit = models.get(read);
  if (hit && hit.ref === refSeq) return hit.model;
  const model = buildReadModel(read, refSeq);
  models.set(read, { ref: refSeq, model });
  return model;
}

const runDates = new Map<string, string>();
/** The run date in the viewer's locale (cached: formatting dates is slow and the panel redraws with the selection). */
function formatRunDate(iso: string | undefined): string {
  if (!iso) return '';
  const hit = runDates.get(iso);
  if (hit !== undefined) return hit;
  const text = formatRunDateUncached(iso);
  runDates.set(iso, text);
  return text;
}

function formatRunDateUncached(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  try {
    return new Date(y, m - 1, d).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
  } catch {
    return iso;
  }
}

/** Shifts (multiples of the reference length) at which an unwrapped span [lo, hi) overlaps the window [c0, c1). */
function shiftsFor(lo: number, hi: number, c0: number, c1: number, L: number, circular: boolean): number[] {
  if (!circular || L === 0) return lo < c1 && hi > c0 ? [0] : [];
  const out: number[] = [];
  for (let k = Math.floor((c0 - hi) / L); k * L + lo < c1; k++) if (k * L + hi > c0) out.push(k * L);
  return out;
}

export function AlignedReadsPanel(props: AlignedReadsPanelProps) {
  const { record, reads, centerPosition, highlight, onPositionClick, scrollLeft, onScrollLeftChange, className } = props;
  const INFO_W = Math.max(0, Math.round(props.infoWidth ?? TRACE_INFO_WIDTH));
  const L = record.seq.length;
  const circular = record.topology === 'circular';
  const refLower = useMemo(() => record.seq.toLowerCase(), [record.seq]);
  const shown = useMemo(() => reads.filter((r) => r.aligned), [reads]);

  const scroller = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ left: 0, width: 800 });
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [zoom, setZoom] = useState<Readonly<Record<string, number>>>({});
  const [markDifferences, setMarkDifferences] = useState(true);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const update = () => {
      setView((v) => (v.left === el.scrollLeft && v.width === el.clientWidth ? v : { left: el.scrollLeft, width: el.clientWidth }));
      setVbarWidth(el.offsetWidth - el.clientWidth);
    };
    update();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // the horizontal scrollbar runs under the reads only, not under the info column: the scroller's own one is hidden
  // and this bar (as wide as the reads area) scrolls it
  const hbar = useRef<HTMLDivElement>(null);
  const [vbarWidth, setVbarWidth] = useState(0);
  const onHbarScroll = useCallback(() => {
    const el = scroller.current;
    const bar = hbar.current;
    if (el && bar && Math.abs(el.scrollLeft - bar.scrollLeft) >= 0.5) el.scrollLeft = bar.scrollLeft;
  }, []);
  // sideways wheel / trackpad movement over the reads (there is no scrollbar of their own to take it)
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const d = e.shiftKey && e.deltaX === 0 ? e.deltaY : e.deltaX;
      if (e.ctrlKey || d === 0 || (!e.shiftKey && Math.abs(e.deltaX) <= Math.abs(e.deltaY))) return;
      e.preventDefault();
      el.scrollLeft += e.deltaMode === 1 ? d * 16 : d;
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const frame = useRef(0);
  const onScrollLeftRef = useRef(onScrollLeftChange);
  onScrollLeftRef.current = onScrollLeftChange;
  const lastLeft = useRef(0);
  const onScroll = useCallback(() => {
    const el0 = scroller.current;
    if (el0 && el0.scrollLeft !== lastLeft.current) {
      lastLeft.current = el0.scrollLeft;
      onScrollLeftRef.current?.(el0.scrollLeft);
      const bar = hbar.current;
      if (bar && Math.abs(bar.scrollLeft - el0.scrollLeft) >= 0.5) bar.scrollLeft = el0.scrollLeft;
    }
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      const el = scroller.current;
      if (el) setView({ left: el.scrollLeft, width: el.clientWidth });
    });
  }, []);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  // an offset given from outside (the one-line sequence view above)
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || scrollLeft == null || Math.abs(el.scrollLeft - scrollLeft) < 0.5) return;
    el.scrollLeft = scrollLeft;
    lastLeft.current = el.scrollLeft;
    if (hbar.current) hbar.current.scrollLeft = el.scrollLeft;
    setView({ left: el.scrollLeft, width: el.clientWidth });
  }, [scrollLeft]);

  const scrollToColumn = useCallback(
    (pos: number, behavior: ScrollBehavior = 'auto') => {
      const el = scroller.current;
      if (!el) return;
      const dataW = Math.max(COL, el.clientWidth - INFO_W);
      el.scrollTo({ left: Math.max(0, (pos + 0.5) * COL - dataW / 2), behavior });
    },
    [INFO_W],
  );

  // with nothing to follow, open at the start of the first read
  const opened = useRef(false);
  useLayoutEffect(() => {
    if (opened.current || shown.length === 0) return;
    opened.current = true;
    if (centerPosition == null) scrollToColumn(shown[0].refRange.start + 40);
  }, [shown, centerPosition, scrollToColumn]);

  // follow the selection of the sequence view only when it leaves the columns on screen (a click or a drag inside the
  // view never moves it), and not when the panel itself set it
  const selfClick = useRef<number | null>(null);
  useEffect(() => {
    if (centerPosition == null) return;
    if (selfClick.current === centerPosition) {
      selfClick.current = null;
      return;
    }
    const el = scroller.current;
    if (!el) return;
    const first = el.scrollLeft / COL;
    const last = (el.scrollLeft + el.clientWidth - INFO_W) / COL;
    if (centerPosition >= first && centerPosition < last) return;
    scrollToColumn(centerPosition);
  }, [centerPosition, scrollToColumn, INFO_W]);

  const c0 = Math.max(0, Math.floor(view.left / COL) - OVERSCAN);
  const c1 = Math.min(L, Math.ceil((view.left + view.width - INFO_W) / COL) + OVERSCAN);
  const svgLeft = INFO_W + c0 * COL;

  // only the reads with bases in view get a row (as SnapGene does); the columns actually on screen decide
  const v0 = Math.floor(view.left / COL);
  const v1 = Math.ceil((view.left + view.width - INFO_W) / COL);
  const inView = shown.filter((r) => {
    const m = modelOf(r, record.seq);
    const n = m.oriented.length;
    return n > 0 && shiftsFor(m.x[0] - 0.5, m.x[n - 1] + 0.5, v0, v1, L, circular).length > 0;
  });
  const svgWidth = Math.max(0, (c1 - c0) * COL);

  const click = (e: ReactMouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const pos = Math.floor((e.clientX - rect.left) / COL) + c0;
    if (pos < 0 || pos >= L) return;
    selfClick.current = pos;
    onPositionClick?.(pos);
  };

  // positions of every difference of the expanded reads, for the previous / next buttons
  const differences = useMemo(() => {
    const set = new Set<number>();
    for (const r of shown) {
      if (collapsed.has(r.id)) continue;
      const m = modelOf(r, record.seq);
      for (const c of m.columns) if (c.kind !== 'match') set.add(((c.ref % L) + L) % L);
      for (const ins of m.insertions) set.add(((ins.ref % L) + L) % L);
    }
    return [...set].sort((a, b) => a - b);
  }, [shown, collapsed, record.seq, L]);

  const jump = (dir: 1 | -1) => {
    if (differences.length === 0) return;
    const center = Math.floor((view.left + Math.max(COL, view.width - INFO_W) / 2) / COL);
    let target: number | undefined;
    if (dir > 0) target = differences.find((p) => p > center) ?? differences[0];
    else target = [...differences].reverse().find((p) => p < center) ?? differences[differences.length - 1];
    scrollToColumn(target, 'smooth');
    selfClick.current = target;
    onPositionClick?.(target);
  };

  const highlightRect = (height: number) => {
    if (!highlight) return null;
    const len = highlight.end - highlight.start;
    const parts: Array<[number, number]> =
      len <= 0 ? [[highlight.start, highlight.start]] : highlight.end > L ? [[highlight.start, L], [0, highlight.end - L]] : [[highlight.start, highlight.end]];
    return parts.map(([s, e], i) =>
      e > s ? (
        e > c0 && s < c1 ? <rect key={i} className={styles.highlight} x={(Math.max(s, c0) - c0) * COL} y={0} width={(Math.min(e, c1) - Math.max(s, c0)) * COL} height={height} /> : null
      ) : s >= c0 && s <= c1 ? (
        <line key={i} className={styles.caret} x1={(s - c0) * COL} x2={(s - c0) * COL} y1={0} y2={height} />
      ) : null,
    );
  };

  // the reference letters and position numbers depend on the columns in view only, not on the selection
  const refLetters = useMemo(() => {
    const out: ReactNode[] = [];
    for (let p = c0; p < c1; p++) {
      if ((p + 1) % 10 === 0) {
        const xc = (p - c0 + 0.5) * COL;
        out.push(
          <g key={`n${p}`}>
            <text x={xc} y={11} className={styles.rulerNumber}>
              {formatInt(p + 1)}
            </text>
            <line className={styles.rulerTick} x1={xc} x2={xc} y1={13} y2={17} />
          </g>,
        );
      }
      out.push(
        <text key={p} x={(p - c0 + 0.5) * COL} y={HEADER_H - 8} className={styles.refBase}>
          {refLower[p]}
        </text>,
      );
    }
    return out;
  }, [c0, c1, refLower]);

  return (
    <div
      className={[styles.panel, className].filter(Boolean).join(' ')}
      // the info column's colour continues below the last read
      style={{ background: `linear-gradient(90deg, #fff1c4 ${INFO_W - 1}px, #e7d79a ${INFO_W - 1}px ${INFO_W}px, #ffffff ${INFO_W}px)` }}
      data-hh-trace-panel=""
    >
      <div ref={scroller} className={styles.scroller} onScroll={onScroll}>
        <div className={styles.content} style={{ width: INFO_W + L * COL + TRACE_RIGHT_PADDING }}>
          <div className={styles.header} style={{ height: HEADER_H }}>
            <div className={styles.corner} style={{ width: INFO_W }}>
              <span className={styles.cornerTitle}>Original Sequence</span>
              <button type="button" className={styles.navBtn} aria-label="Previous difference" onClick={() => jump(-1)}>
                ‹
              </button>
              <button
                type="button"
                className={[styles.markBtn, markDifferences ? styles.markBtnOn : ''].join(' ')}
                aria-label="Highlight differences"
                aria-pressed={markDifferences}
                onClick={() => setMarkDifferences((v) => !v)}
              />
              <button type="button" className={styles.navBtn} aria-label="Next difference" onClick={() => jump(1)}>
                ›
              </button>
            </div>
            <svg className={styles.strip} style={{ left: svgLeft }} width={svgWidth} height={HEADER_H} onMouseDown={click}>
              {highlightRect(HEADER_H)}
              {refLetters}
            </svg>
          </div>
          {inView.length === 0 ? (
            <div className={styles.row} style={{ height: BASES_H + TRACE_H + RULER_H + PAD, display: 'flex' }}>
              <div className={styles.info} style={{ width: INFO_W, flex: 'none' }} />
              <div className={styles.noReads} style={{ left: INFO_W }}>
                No aligned reads at this position. Use ‹ › to go to the next difference.
              </div>
            </div>
          ) : null}
          {inView.map((read) => {
            const model = modelOf(read, record.seq);
            const isCollapsed = collapsed.has(read.id);
            const height = isCollapsed ? BASES_H + 4 : BASES_H + TRACE_H + RULER_H + PAD;
            const span = alignedReadSpan(model);
            const toggle = () =>
              setCollapsed((prev) => {
                const next = new Set(prev);
                if (next.has(read.id)) next.delete(read.id);
                else next.add(read.id);
                return next;
              });
            return (
              <div key={read.id} className={styles.row} style={{ height }}>
                <div className={styles.info} style={{ width: INFO_W }}>
                  <div className={styles.infoTitle}>
                    <button type="button" className={styles.disclosure} aria-label={isCollapsed ? 'Expand' : 'Collapse'} aria-expanded={!isCollapsed} onClick={toggle}>
                      {isCollapsed ? '▶' : '▼'}
                    </button>
                    <span className={styles.readName} title={read.name}>
                      {read.name}
                    </span>
                    <svg className={styles.strandArrow} width={22} height={10} viewBox="0 0 22 10" aria-label={read.strand === 1 ? 'forward' : 'reverse'}>
                      <path d={read.strand === 1 ? 'M0 3.5h14V0l8 5-8 5V6.5H0z' : 'M22 3.5H8V0L0 5l8 5V6.5h14z'} />
                    </svg>
                  </div>
                  {isCollapsed ? null : (
                    <div className={styles.infoBody}>
                      <div className={styles.infoText}>
                        <div>{formatInt(read.sequence.length)} bases</div>
                        {read.runDate ? <div className={styles.ellipsis}>{formatRunDate(read.runDate)}</div> : null}
                        <div className={styles.infoGap}>
                          {formatInt(span.from)} .. {formatInt(span.to)} aligned
                        </div>
                        <div>
                          {formatInt(model.mismatches)} mismatch{model.mismatches === 1 ? '' : 'es'}
                        </div>
                        <div>{formatInt(model.gapBases)} gaps/insertions</div>
                      </div>
                      {model.trace ? (
                        <ZoomSlider
                          min={0.5}
                          max={6}
                          step={0.1}
                          value={zoom[read.id] ?? 1}
                          aria-label={`Trace height of ${read.name}`}
                          onChange={(v) => setZoom((z) => ({ ...z, [read.id]: v }))}
                        />
                      ) : null}
                    </div>
                  )}
                </div>
                <svg className={styles.strip} style={{ left: svgLeft }} width={svgWidth} height={height} onMouseDown={click}>
                  {highlightRect(height)}
                  <ReadStrip model={model} c0={c0} c1={c1} L={L} circular={circular} collapsed={isCollapsed} mark={markDifferences} zoom={zoom[read.id] ?? 1} />
                </svg>
              </div>
            );
          })}
        </div>
      </div>
      <div ref={hbar} className={styles.hbar} style={{ marginLeft: INFO_W, marginRight: vbarWidth }} onScroll={onHbarScroll}>
        <div style={{ width: L * COL + TRACE_RIGHT_PADDING, height: 1 }} />
      </div>
    </div>
  );
}

interface ReadStripProps {
  model: ReadModel;
  c0: number;
  c1: number;
  L: number;
  circular: boolean;
  collapsed: boolean;
  mark: boolean;
  zoom: number;
}

/** The visible part of one read: bases, differences, insertions, chromatogram and read positions. */
const ReadStrip = memo(function ReadStrip({ model, c0, c1, L, circular, collapsed, mark, zoom }: ReadStripProps) {
  const n = model.oriented.length;
  if (n === 0) return null;
  const lo = model.x[0] - 0.5;
  const hi = model.x[n - 1] + 0.5;
  const out: ReactNode[] = [];
  for (const shift of shiftsFor(lo, hi, c0, c1, L, circular)) {
    const px = (u: number) => (u + shift - c0) * COL;
    const inView = (u: number) => u + shift >= c0 - 1 && u + shift <= c1 + 1;
    const key = `s${shift}`;
    // differences
    if (mark) {
      for (const c of model.columns) {
        if (c.kind === 'match' || (c.run ?? 0) > LONG_DELETION || !inView(c.ref + 0.5)) continue;
        out.push(<rect key={`${key}d${c.ref}`} className={styles.diff} x={px(c.ref)} y={1} width={COL} height={BASES_H - 2} />);
      }
    }
    // bases (aligned ones in black, unaligned tails in grey); deletions as dashes
    for (let i = 0; i < n; i++) {
      const u = model.x[i];
      if (!inView(u)) continue;
      if (model.insertions.length && isInserted(model, i)) continue;
      const tail = i < model.alignedFrom || i >= model.alignedTo;
      out.push(
        <text key={`${key}b${i}`} x={px(u)} y={BASES_H - 6} className={tail ? styles.tailBase : styles.readBase}>
          {model.oriented[i]}
        </text>,
      );
    }
    for (const c of model.columns) {
      if (c.kind !== 'deletion' || !inView(c.ref + 0.5)) continue;
      if ((c.run ?? 0) > LONG_DELETION) {
        out.push(<line key={`${key}l${c.ref}`} className={styles.longDeletion} x1={px(c.ref)} x2={px(c.ref + 1)} y1={BASES_H / 2} y2={BASES_H / 2} />);
        continue;
      }
      out.push(
        <text key={`${key}g${c.ref}`} x={px(c.ref + 0.5)} y={BASES_H - 6} className={styles.readBase}>
          -
        </text>,
      );
    }
    for (const ins of model.insertions) {
      if (!inView(ins.ref)) continue;
      out.push(
        <line key={`${key}i${ins.ref}`} className={styles.insertion} x1={px(ins.ref)} x2={px(ins.ref)} y1={1} y2={BASES_H - 1}>
          <title>{`Insertion: ${model.oriented.slice(ins.qi, ins.qi + ins.length)}`}</title>
        </line>,
      );
    }
    if (collapsed) continue;
    // read positions every 10 bases, with dashed guides through the trace
    const top = BASES_H;
    const bottom = BASES_H + TRACE_H;
    for (let i = 0; i < n; i++) {
      const pos = model.readPosition(i);
      if (pos % 10 !== 0 || isInserted(model, i)) continue;
      const u = model.x[i];
      if (!inView(u)) continue;
      out.push(<line key={`${key}t${i}`} className={styles.guide} x1={px(u)} x2={px(u)} y1={top} y2={bottom} />);
      out.push(
        <text key={`${key}n${i}`} x={px(u)} y={bottom + RULER_H - 4} className={styles.rulerNumber}>
          {pos}
        </text>,
      );
    }
    out.push(<line key={`${key}base`} className={styles.baseline} x1={Math.max(0, px(lo))} x2={Math.min((c1 - c0) * COL, px(hi))} y1={bottom} y2={bottom} />);
    if (model.trace) out.push(<TracePaths key={`${key}tr`} model={model} shift={shift} c0={c0} c1={c1} top={top} height={TRACE_H} zoom={zoom} />);
  }
  return <>{out}</>;
});

function isInserted(model: ReadModel, i: number): boolean {
  for (const ins of model.insertions) if (i >= ins.qi && i < ins.qi + ins.length) return true;
  return false;
}

/** The four signal channels between the peaks of the visible bases, stretched so each peak sits on its base. */
function TracePaths(props: { model: ReadModel; shift: number; c0: number; c1: number; top: number; height: number; zoom: number }) {
  const { model, shift, c0, c1, top, height, zoom } = props;
  const trace = model.trace!;
  const n = model.oriented.length;
  const x = model.x;
  let i0 = 0;
  while (i0 < n - 1 && x[i0 + 1] + shift < c0 - 1) i0++;
  let i1 = n - 1;
  while (i1 > 0 && x[i1 - 1] + shift > c1 + 1) i1--;
  if (i1 <= i0) return null;
  const scale = (height - 4) * zoom / model.traceMax;
  const bottom = top + height;
  const channels = ['a', 'c', 'g', 't'] as const;
  // one segment per stretch of neighbouring bases: the trace is not stretched over a long deletion
  const segments: Array<{ d: Record<'a' | 'c' | 'g' | 't', string>; from: number; to: number }> = [];
  let seg: (typeof segments)[number] | null = null;
  for (let i = i0; i < i1; i++) {
    if (x[i + 1] - x[i] > LONG_DELETION) {
      seg = null;
      continue;
    }
    const p0 = trace.peaks[i];
    const p1 = trace.peaks[i + 1];
    const x0 = (x[i] + shift - c0) * COL;
    const x1 = (x[i + 1] + shift - c0) * COL;
    const fresh = !seg;
    if (!seg) {
      seg = { d: { a: '', c: '', g: '', t: '' }, from: x0, to: x0 };
      segments.push(seg);
    }
    seg.to = x1;
    const steps = Math.max(1, p1 - p0);
    for (let s = fresh ? 0 : 1; s <= steps; s++) {
      const sample = p0 + (p1 > p0 ? s : 0);
      const xx = x0 + ((x1 - x0) * s) / steps;
      for (const ch of channels) {
        const v = trace[ch][sample] ?? 0;
        const y = Math.max(top, bottom - v * scale);
        seg.d[ch] += `${seg.d[ch] ? 'L' : 'M'}${xx.toFixed(1)} ${y.toFixed(1)}`;
      }
    }
  }
  return (
    <g>
      {segments.map((sg, k) =>
        channels.map((ch) => (
          <g key={`${k}${ch}`}>
            <path d={`${sg.d[ch]}L${sg.to.toFixed(1)} ${bottom}L${sg.from.toFixed(1)} ${bottom}Z`} fill={TRACE_COLORS[ch]} className={styles.traceFill} />
            <path d={sg.d[ch]} stroke={TRACE_COLORS[ch]} className={styles.traceLine} />
          </g>
        )),
      )}
    </g>
  );
}
