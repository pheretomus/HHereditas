/**
 * Row model of the sequence view.
 *
 * The sequence is cut into rows of `basesPerRow` bases. Every row stacks, top to bottom:
 *
 *   enzyme label lanes      names staggered upwards, a leader drops to the cut
 *   forward primer lanes    primers that read like the top strand
 *   top strand              monospace, a small gap after every `groupSize` bases
 *   bottom strand           (optional)
 *   reverse primer lanes
 *   feature lanes           one lane per overlapping feature (+ a translation sub-row for CDS)
 *   ORF lanes
 *
 * `buildRowModel` precomputes every row's content and exact height plus prefix sums of the
 * heights, so the view can virtualize rows of different heights (binary search on `offsets`)
 * and hit-test without touching the DOM. Everything here is pure and DOM-free.
 *
 * Units: a "col" is a base index inside a row (0..n-1), a row "gap" is a gap position inside
 * a row (0..n), x / y are CSS pixels relative to the row's top-left corner (y) or the view's
 * left edge (x).
 */
import type { EnzymeSite, Feature, Orf, PrimerBindingSite, Range, Topology } from '@hhereditas/core';
import { featureExtent, mod, normalizeRange, splitAtOrigin } from '@hhereditas/core';
import { formatInt } from '../common/format';

// ---------------------------------------------------------------------------------------------
// Metrics and horizontal geometry
// ---------------------------------------------------------------------------------------------

/** Fixed sizes (CSS px) of the sequence view. The font sizes must match SequenceView.module.css. */
export interface SequenceMetrics {
  /** Font size of the bases. */
  readonly baseFontSize: number;
  /** Horizontal advance of one base (glyphs are centred in their cell). */
  readonly charWidth: number;
  /** Bases per group; a `groupGap` separates groups. */
  readonly groupSize: number;
  readonly groupGap: number;
  readonly paddingLeft: number;
  readonly paddingRight: number;
  /** Space between the row number column and the first base. */
  readonly numberGap: number;
  readonly rowPaddingTop: number;
  readonly rowPaddingBottom: number;
  readonly enzymeLaneHeight: number;
  /** Space between the lowest enzyme label lane and what is below it. */
  readonly enzymeClearance: number;
  readonly primerLaneHeight: number;
  /** Arrow tip length of a primer beyond its last base. */
  readonly primerTip: number;
  readonly strandHeight: number;
  /** Space between the strands and the first feature lane. */
  readonly featureGap: number;
  readonly featureBarHeight: number;
  readonly featureLaneGap: number;
  /** Arrow head length of a feature bar. */
  readonly featureArrow: number;
  readonly translationHeight: number;
  readonly orfGap: number;
  readonly orfLaneHeight: number;
  /** Minimum horizontal space between two items sharing a lane. */
  readonly laneSpacing: number;
  /** Space between a bar and a label drawn beside it. */
  readonly labelOffset: number;
  /** Horizontal padding inside a feature bar around its name. */
  readonly labelPadding: number;
}

export const DEFAULT_METRICS: SequenceMetrics = Object.freeze({
  baseFontSize: 13,
  charWidth: 8.6,
  groupSize: 10,
  groupGap: 7,
  paddingLeft: 16,
  paddingRight: 24,
  numberGap: 14,
  rowPaddingTop: 10,
  rowPaddingBottom: 16,
  enzymeLaneHeight: 14,
  enzymeClearance: 4,
  primerLaneHeight: 20,
  primerTip: 6,
  strandHeight: 17,
  featureGap: 6,
  featureBarHeight: 15,
  featureLaneGap: 4,
  featureArrow: 6,
  translationHeight: 16,
  orfGap: 3,
  orfLaneHeight: 9,
  laneSpacing: 3,
  labelOffset: 5,
  labelPadding: 4,
});

/**
 * Horizontal layout shared by every row of a model. It depends only on the metrics, the
 * row-number column and the number of bases per row (never on the view width), so resizing
 * the view only rebuilds the model when the number of bases per row changes.
 */
export interface RowGeometry {
  /** Width of the content: the text block plus its right padding (px). */
  readonly width: number;
  /** x of the left edge of the first base of every row. */
  readonly textLeft: number;
  /** x of the right edge of the last base of a full row. */
  readonly textRight: number;
  /** Rightmost x a label may reach. */
  readonly labelRight: number;
  readonly charWidth: number;
  readonly groupSize: number;
  readonly groupGap: number;
  readonly basesPerRow: number;
}

/** x of the first base when the row-number column is `numberColumnWidth` wide (0 = no numbers). */
export function textLeftFor(metrics: SequenceMetrics, numberColumnWidth: number): number {
  return metrics.paddingLeft + (numberColumnWidth > 0 ? numberColumnWidth + metrics.numberGap : 0);
}

/** Largest multiple of `groupSize` bases that fits the width ('auto' bases per row). At least one group. */
export function autoBasesPerRow(width: number, metrics: SequenceMetrics, numberColumnWidth: number): number {
  const available = width - textLeftFor(metrics, numberColumnWidth) - metrics.paddingRight;
  const groupWidth = metrics.groupSize * metrics.charWidth + metrics.groupGap;
  const groups = Math.floor((available + metrics.groupGap) / groupWidth);
  return Math.max(1, groups) * metrics.groupSize;
}

export function makeGeometry(metrics: SequenceMetrics, numberColumnWidth: number, basesPerRow: number): RowGeometry {
  const textLeft = textLeftFor(metrics, numberColumnWidth);
  const n = Math.max(1, Math.floor(basesPerRow));
  const g = Math.max(1, metrics.groupSize);
  const textRight = textLeft + n * metrics.charWidth + Math.floor((n - 1) / g) * metrics.groupGap;
  const width = Math.ceil(textRight + metrics.paddingRight);
  return {
    width,
    textLeft,
    textRight,
    labelRight: width - 4,
    charWidth: metrics.charWidth,
    groupSize: g,
    groupGap: metrics.groupGap,
    basesPerRow: n,
  };
}

/** Left edge of base `col` of a row. */
export function colLeft(geo: RowGeometry, col: number): number {
  return geo.textLeft + col * geo.charWidth + Math.floor(col / geo.groupSize) * geo.groupGap;
}

/** Right edge of base `col` of a row. */
export function colRight(geo: RowGeometry, col: number): number {
  return colLeft(geo, col) + geo.charWidth;
}

/** Centre of base `col` of a row (where its glyph is drawn). */
export function colCenter(geo: RowGeometry, col: number): number {
  return colLeft(geo, col) + geo.charWidth / 2;
}

/**
 * x of row gap `gap` (0..n) in a row of `n` bases: the boundary between two bases, the middle
 * of the group gap between two groups, the left edge of the first / right edge of the last base.
 */
export function gapX(geo: RowGeometry, gap: number, n: number): number {
  if (n <= 0 || gap <= 0) return geo.textLeft;
  if (gap >= n) return colRight(geo, n - 1);
  if (gap % geo.groupSize === 0) return colLeft(geo, gap) - geo.groupGap / 2;
  return colLeft(geo, gap);
}

/** Nearest row gap (0..n) to x in a row of `n` bases. */
export function xToGap(geo: RowGeometry, x: number, n: number): number {
  if (n <= 0) return 0;
  const rel = x - geo.textLeft;
  if (rel <= 0) return 0;
  const g = geo.groupSize;
  const groupWidth = g * geo.charWidth + geo.groupGap;
  const group = Math.floor(rel / groupWidth);
  const within = rel - group * groupWidth;
  let gap: number;
  if (within >= g * geo.charWidth) {
    gap = (group + 1) * g; // inside the gap after a group: its boundary is the nearest gap
  } else {
    const col = Math.floor(within / geo.charWidth);
    const frac = within / geo.charWidth - col;
    gap = group * g + col + (frac >= 0.5 ? 1 : 0);
  }
  return Math.max(0, Math.min(n, gap));
}

/** Base (col, 0..n-1) under x in a row of `n` bases (clamped; -1 for an empty row). */
export function xToCol(geo: RowGeometry, x: number, n: number): number {
  if (n <= 0) return -1;
  const rel = x - geo.textLeft;
  if (rel <= 0) return 0;
  const g = geo.groupSize;
  const groupWidth = g * geo.charWidth + geo.groupGap;
  const group = Math.floor(rel / groupWidth);
  const within = rel - group * groupWidth;
  let col: number;
  if (within >= g * geo.charWidth) {
    // in a group gap: the nearer of the bases on either side
    col = within - g * geo.charWidth < geo.groupGap / 2 ? group * g + g - 1 : (group + 1) * g;
  } else {
    col = group * g + Math.floor(within / geo.charWidth);
  }
  return Math.max(0, Math.min(n - 1, col));
}

// ---------------------------------------------------------------------------------------------
// Row model
// ---------------------------------------------------------------------------------------------

export type LabelStyle = 'feature' | 'enzyme' | 'enzymeUnique' | 'primer';
/** Width (px) of a label in a given style; see measure.ts. */
export type MeasureLabel = (text: string, style: LabelStyle) => number;

/** Rough label width when no measurement is available (tests, SSR). */
export const approximateMeasure: MeasureLabel = (text, style) =>
  text.length * (style === 'enzymeUnique' || style === 'feature' || style === 'primer' ? 6.6 : 6.2);

export interface LayoutFeature {
  readonly feature: Feature;
  /** Draw a translation sub-row under the feature (CDS with translations shown). */
  readonly translated: boolean;
}

export interface LayoutPrimer {
  readonly site: PrimerBindingSite;
  /** Display name (record.primers[].name). */
  readonly name: string;
}

export interface RowModelInput {
  readonly length: number;
  readonly topology: Topology;
  readonly basesPerRow: number;
  readonly metrics?: SequenceMetrics;
  /** Width of the row-number column (0 = no numbers). */
  readonly numberColumnWidth?: number;
  readonly showComplement?: boolean;
  readonly features?: readonly LayoutFeature[];
  readonly enzymes?: readonly EnzymeSite[];
  readonly primers?: readonly LayoutPrimer[];
  readonly orfs?: readonly Orf[];
  readonly measure?: MeasureLabel;
}

/** A name drawn on (inside) or beside a bar. */
export interface LabelPlacement {
  /** Left x of the text. */
  readonly x: number;
  readonly text: string;
  readonly width: number;
  readonly inside: boolean;
}

/** One drawn bar of a feature inside a row (a segment, cut at row and origin boundaries). */
export interface BarPiece {
  readonly startCol: number;
  readonly endCol: number;
  /** The bar continues in the previous / next row (square edge, no arrow). */
  readonly openStart: boolean;
  readonly openEnd: boolean;
  /** Arrow head at the left (3' end of a reverse feature) / right (3' end of a forward feature). */
  readonly arrowStart: boolean;
  readonly arrowEnd: boolean;
}

/** A feature's presence in one row. Multi-segment features draw a thin line between their bars. */
export interface FeaturePiece {
  /** Index into RowModelInput.features. */
  readonly feature: number;
  readonly lane: number;
  /** Covered part of the feature's extent in this row: [startCol, endCol). */
  readonly startCol: number;
  readonly endCol: number;
  readonly bars: readonly BarPiece[];
  readonly label: LabelPlacement | null;
  readonly translated: boolean;
}

export interface FeatureLane {
  /** y of the bar's top edge (row coordinates). */
  readonly top: number;
  /** The lane has a translation sub-row under its bars. */
  readonly translation: boolean;
}

export interface EnzymeLabel {
  /** Index into RowModelInput.enzymes. */
  readonly site: number;
  /** 0 = lowest lane, right above the sequence. */
  readonly lane: number;
  /** x of the leader (the top-strand cut). */
  readonly anchorX: number;
  /** Left x of the text (normally anchorX; moved left when the label would leave the view). */
  readonly x: number;
  readonly width: number;
  readonly text: string;
  readonly unique: boolean;
}

/**
 * The stepped cut line of one cleavage event inside one row: a tick through the top strand
 * at `top`, a step between the strands from `from` to `to`, a tick through the bottom strand
 * at `bottom` (all row gaps). A null tick is drawn in another row.
 */
export interface CutMark {
  readonly site: number;
  readonly top: number | null;
  readonly bottom: number | null;
  readonly from: number;
  readonly to: number;
}

export interface PrimerPiece {
  /** Index into RowModelInput.primers. */
  readonly primer: number;
  readonly strand: 1 | -1;
  /** Lane within the primer's side (forward lanes stack upwards, reverse lanes downwards). */
  readonly lane: number;
  readonly startCol: number;
  readonly endCol: number;
  readonly openStart: boolean;
  readonly openEnd: boolean;
  /** This piece holds the 3' end (arrow tip). */
  readonly tip: boolean;
  /** This piece holds the annealed 5' end (where a 5' tail leaves the template). */
  readonly fivePrime: boolean;
  readonly label: LabelPlacement | null;
}

export interface OrfPiece {
  /** Index into RowModelInput.orfs. */
  readonly orf: number;
  readonly lane: number;
  readonly startCol: number;
  readonly endCol: number;
  readonly openStart: boolean;
  readonly openEnd: boolean;
  /** This piece holds the ORF's 3' end (arrow head). */
  readonly tip: boolean;
}

/** Vertical anchors inside a row (px from the row's top). */
export interface RowY {
  readonly enzymes: number;
  readonly primersFwd: number;
  readonly strand: number;
  readonly complement: number;
  readonly primersRev: number;
  readonly features: number;
  readonly orfs: number;
}

export interface RowLayout {
  readonly index: number;
  /** Bases [start, end) of the row. */
  readonly start: number;
  readonly end: number;
  readonly height: number;
  readonly y: RowY;
  readonly enzymeLanes: number;
  readonly enzymeLabels: readonly EnzymeLabel[];
  readonly cutMarks: readonly CutMark[];
  readonly primerLanesFwd: number;
  readonly primerLanesRev: number;
  readonly primers: readonly PrimerPiece[];
  readonly featureLanes: readonly FeatureLane[];
  readonly features: readonly FeaturePiece[];
  readonly orfLanes: number;
  readonly orfs: readonly OrfPiece[];
}

export interface RowModel {
  readonly length: number;
  readonly topology: Topology;
  readonly metrics: SequenceMetrics;
  readonly geometry: RowGeometry;
  readonly basesPerRow: number;
  readonly showComplement: boolean;
  readonly rowCount: number;
  readonly rows: readonly RowLayout[];
  /** offsets[i] = top of row i; offsets[rowCount] = total height. */
  readonly offsets: Float64Array;
  readonly totalHeight: number;
}

// --- helpers ---------------------------------------------------------------------------------

const EMPTY: readonly never[] = Object.freeze([]);

/** Pieces of a range inside [0, L] (two for a range wrapping the origin of a circular molecule). */
export function linearSpans(r: Range, L: number, topology: Topology): Array<[number, number]> {
  if (L <= 0) return [];
  if (topology !== 'circular') {
    const s = Math.max(0, Math.min(L, Math.min(r.start, r.end)));
    const e = Math.max(0, Math.min(L, Math.max(r.start, r.end)));
    return e > s ? [[s, e]] : [];
  }
  if (r.end - r.start <= 0) return [];
  const n = normalizeRange(r, L, 'circular');
  if (n.end <= n.start) return [];
  const out: Array<[number, number]> = [];
  for (const p of splitAtOrigin(n, L)) if (p.end > p.start) out.push([p.start, p.end]);
  return out;
}

/** Call `visit(row, startCol, endCol)` for each row covered by bases [s, e). */
function forEachRowPiece(s: number, e: number, N: number, visit: (row: number, c0: number, c1: number) => void): void {
  const last = Math.floor((e - 1) / N);
  for (let r = Math.floor(s / N); r <= last; r++) {
    const rs = r * N;
    visit(r, Math.max(s, rs) - rs, Math.min(e, rs + N) - rs);
  }
}

function push<T>(buckets: (T[] | undefined)[], row: number, item: T): void {
  const b = buckets[row];
  if (b) b.push(item);
  else buckets[row] = [item];
}

/** Shorten `text` with an ellipsis so it fits `available` px; null if not even 2 letters fit. */
function truncateLabel(
  text: string,
  width: number,
  available: number,
  style: LabelStyle,
  measure: MeasureLabel,
): { text: string; width: number } | null {
  if (width <= available) return { text, width };
  if (text.length < 3 || available < 18) return null;
  let chars = Math.floor((text.length * available) / width) - 1;
  while (chars >= 2) {
    const t = `${text.slice(0, chars).trimEnd()}…`;
    const w = measure(t, style);
    if (w <= available) return { text: t, width: w };
    chars--;
  }
  return null;
}

/** First lane whose right edge (+spacing) is left of `left`; appends a lane if none. */
function firstFitLane(laneRight: number[], left: number, spacing: number): number {
  let lane = 0;
  while (lane < laneRight.length && laneRight[lane] + spacing > left) lane++;
  return lane;
}

// --- raw (pre-packing) items -----------------------------------------------------------------

interface RawFeaturePiece {
  feature: number;
  startCol: number;
  endCol: number;
  /** Bases of the extent before this piece (continuing pieces sort first, oldest first). */
  order: number;
  extentLength: number;
  bars: BarPiece[];
  widestBar: number;
  labelPiece: boolean;
}

interface RawEnzymeLabel {
  site: number;
  gap: number;
  text: string;
  unique: boolean;
}

interface RawPrimerPiece {
  primer: number;
  strand: 1 | -1;
  startCol: number;
  endCol: number;
  openStart: boolean;
  openEnd: boolean;
  tip: boolean;
  fivePrime: boolean;
  order: number;
}

interface RawOrfPiece {
  orf: number;
  startCol: number;
  endCol: number;
  openStart: boolean;
  openEnd: boolean;
  tip: boolean;
  order: number;
}

/** The 1-based number in an enzyme label: the base preceding the top-strand cut (SnapGene). */
export function cutLabelNumber(gap: number, length: number, topology: Topology): number {
  if (gap <= 0) return topology === 'circular' ? length : 0;
  return gap;
}

/** Number of cleavage events per enzyme name (unique cutter = exactly 1). */
export function cutCounts(sites: readonly EnzymeSite[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const s of sites) counts.set(s.enzyme, (counts.get(s.enzyme) ?? 0) + s.cuts.length);
  return counts;
}

/** "EcoRI (396)" for a cutting site, "Name (start+1)" for a recognised but uncut one. */
export function enzymeLabelText(site: EnzymeSite, length: number, topology: Topology): string {
  if (site.cuts.length === 0) return `${site.enzyme} (${formatInt(site.range.start + 1)})`;
  const top = topology === 'circular' && length > 0 ? mod(site.cuts[0].top, length) : site.cuts[0].top;
  return `${site.enzyme} (${formatInt(cutLabelNumber(top, length, topology))})`;
}

// --- the builder -----------------------------------------------------------------------------

export function buildRowModel(input: RowModelInput): RowModel {
  const metrics = input.metrics ?? DEFAULT_METRICS;
  const measure = input.measure ?? approximateMeasure;
  const L = Math.max(0, Math.floor(input.length));
  const topology = input.topology;
  const circular = topology === 'circular' && L > 0;
  const N = Math.max(1, Math.floor(input.basesPerRow));
  const rowCount = Math.max(1, Math.ceil(L / N));
  const geo = makeGeometry(metrics, input.numberColumnWidth ?? 0, N);
  const showComplement = input.showComplement ?? true;
  const features = input.features ?? EMPTY;
  const enzymes = input.enzymes ?? EMPTY;
  const primers = input.primers ?? EMPTY;
  const orfs = input.orfs ?? EMPTY;
  const rowLen = (r: number) => Math.max(0, Math.min(L, (r + 1) * N) - r * N);
  const lastRow = rowCount - 1;

  const featureBuckets: (RawFeaturePiece[] | undefined)[] = new Array(rowCount);
  const enzymeBuckets: (RawEnzymeLabel[] | undefined)[] = new Array(rowCount);
  const cutBuckets: (CutMark[] | undefined)[] = new Array(rowCount);
  const primerBuckets: (RawPrimerPiece[] | undefined)[] = new Array(rowCount);
  const orfBuckets: (RawOrfPiece[] | undefined)[] = new Array(rowCount);

  // ---- features -----------------------------------------------------------------------------
  for (let fi = 0; fi < features.length && L > 0; fi++) {
    const f = features[fi].feature;
    if (f.segments.length === 0) continue;
    const extent = featureExtent(f, L, topology);
    const extentSpans = linearSpans(extent, L, topology);
    if (extentSpans.length === 0) continue;
    let extentLength = 0;
    for (const [s, e] of extentSpans) extentLength += e - s;

    // drawn bars: segments split at the origin, with their arrow / open-edge candidates
    const barSpans: Array<{ s: number; e: number; segStart: boolean; segEnd: boolean; arrowStart: boolean; arrowEnd: boolean }> = [];
    const lastSeg = f.segments.length - 1;
    f.segments.forEach((seg, k) => {
      const spans = linearSpans(seg, L, topology);
      spans.forEach(([s, e], j) => {
        barSpans.push({
          s,
          e,
          segStart: j === 0,
          segEnd: j === spans.length - 1,
          arrowStart: f.strand === -1 && k === 0 && j === 0,
          arrowEnd: f.strand === 1 && k === lastSeg && j === spans.length - 1,
        });
      });
    });

    const best: { piece: RawFeaturePiece | null } = { piece: null };
    let before = 0;
    for (const [s, e] of extentSpans) {
      forEachRowPiece(s, e, N, (row, c0, c1) => {
        const rs = row * N;
        const a = rs + c0;
        const b = rs + c1;
        const bars: BarPiece[] = [];
        let widest = 0;
        for (const span of barSpans) {
          const bs = Math.max(span.s, a);
          const be = Math.min(span.e, b);
          if (be <= bs) continue;
          bars.push({
            startCol: bs - rs,
            endCol: be - rs,
            openStart: !(span.segStart && bs === span.s),
            openEnd: !(span.segEnd && be === span.e),
            arrowStart: span.arrowStart && bs === span.s,
            arrowEnd: span.arrowEnd && be === span.e,
          });
          widest = Math.max(widest, be - bs);
        }
        const piece: RawFeaturePiece = {
          feature: fi,
          startCol: c0,
          endCol: c1,
          order: before + (a - s),
          extentLength,
          bars,
          widestBar: widest,
          labelPiece: false,
        };
        push(featureBuckets, row, piece);
        if (!best.piece || widest > best.piece.widestBar) best.piece = piece;
      });
      before += e - s;
    }
    if (best.piece) best.piece.labelPiece = true;
  }

  // ---- enzymes ------------------------------------------------------------------------------
  /** Row and row-gap of a gap position; `upstream` puts a row-boundary gap at the end of the previous row. */
  const placeGap = (g: number, upstream: boolean): [number, number] => {
    if (L === 0) return [0, 0];
    let x = g;
    if (circular && x === 0 && upstream) x = L;
    if (x >= L) return [lastRow, x - lastRow * N];
    if (x > 0 && x % N === 0 && upstream) return [x / N - 1, N];
    const r = Math.min(lastRow, Math.floor(x / N));
    return [r, x - r * N];
  };
  const normGap = (g: number) => (circular ? mod(g, L) : Math.max(0, Math.min(L, g)));

  if (enzymes.length > 0 && L > 0) {
    const counts = cutCounts(enzymes);
    for (let si = 0; si < enzymes.length; si++) {
      const site = enzymes[si];
      const unique = counts.get(site.enzyme) === 1;
      const text = enzymeLabelText(site, L, topology);
      if (site.cuts.length === 0) {
        const [row, gap] = placeGap(normGap(site.range.start), false);
        push(enzymeBuckets, row, { site: si, gap, text, unique });
        continue;
      }
      site.cuts.forEach((cut, ci) => {
        const t = normGap(cut.top);
        const b = normGap(cut.bottom);
        let bu = b;
        if (circular) {
          if (bu - t > L / 2) bu -= L;
          else if (t - bu > L / 2) bu += L;
        }
        const [tRow, tGap] = placeGap(t, bu < t);
        const [bRow, bGap] = placeGap(b, bu > t);
        if (ci === 0) push(enzymeBuckets, tRow, { site: si, gap: tGap, text, unique });
        // marks per row: ticks + horizontal step (split at the origin when needed)
        const marks = new Map<number, { top: number | null; bottom: number | null; from: number; to: number }>();
        const mark = (row: number) => {
          let m = marks.get(row);
          if (!m) {
            m = { top: null, bottom: null, from: Infinity, to: -Infinity };
            marks.set(row, m);
          }
          return m;
        };
        const tm = mark(tRow);
        tm.top = tGap;
        tm.from = Math.min(tm.from, tGap);
        tm.to = Math.max(tm.to, tGap);
        const bm = mark(bRow);
        bm.bottom = bGap;
        bm.from = Math.min(bm.from, bGap);
        bm.to = Math.max(bm.to, bGap);
        const lo = Math.min(t, bu);
        const hi = Math.max(t, bu);
        if (hi > lo) {
          const pieces: Array<[number, number]> =
            lo < 0 ? [[lo + L, L], [0, hi]] : hi > L && circular ? [[lo, L], [0, hi - L]] : [[lo, hi]];
          for (const [a, c] of pieces) {
            if (c <= a) continue;
            const r0 = placeGap(a, false)[0];
            const r1 = placeGap(c, true)[0];
            for (let r = r0; r <= r1; r++) {
              const rs = r * N;
              const from = Math.max(a, rs) - rs;
              const to = Math.min(c, rs + rowLen(r)) - rs;
              if (to <= from) continue;
              const m = mark(r);
              m.from = Math.min(m.from, from);
              m.to = Math.max(m.to, to);
            }
          }
        }
        for (const [row, m] of marks) {
          push(cutBuckets, row, { site: si, top: m.top, bottom: m.bottom, from: m.from, to: m.to });
        }
      });
    }
  }

  // ---- primers ------------------------------------------------------------------------------
  for (let pi = 0; pi < primers.length && L > 0; pi++) {
    const site = primers[pi].site;
    const spans = linearSpans(site.range, L, topology);
    let before = 0;
    spans.forEach(([s, e], j) => {
      const first = j === 0;
      const last = j === spans.length - 1;
      forEachRowPiece(s, e, N, (row, c0, c1) => {
        const rs = row * N;
        const atStart = first && rs + c0 === s;
        const atEnd = last && rs + c1 === e;
        push(primerBuckets, row, {
          primer: pi,
          strand: site.strand,
          startCol: c0,
          endCol: c1,
          openStart: !atStart,
          openEnd: !atEnd,
          tip: site.strand === 1 ? atEnd : atStart,
          fivePrime: site.strand === 1 ? atStart : atEnd,
          order: before + (rs + c0 - s),
        });
      });
      before += e - s;
    });
  }

  // ---- ORFs ---------------------------------------------------------------------------------
  for (let oi = 0; oi < orfs.length && L > 0; oi++) {
    const orf = orfs[oi];
    const spans = linearSpans(orf.range, L, topology);
    let before = 0;
    spans.forEach(([s, e], j) => {
      const first = j === 0;
      const last = j === spans.length - 1;
      forEachRowPiece(s, e, N, (row, c0, c1) => {
        const rs = row * N;
        const atStart = first && rs + c0 === s;
        const atEnd = last && rs + c1 === e;
        push(orfBuckets, row, {
          orf: oi,
          startCol: c0,
          endCol: c1,
          openStart: !atStart,
          openEnd: !atEnd,
          tip: orf.strand === 1 ? atEnd : atStart,
          order: before + (rs + c0 - s),
        });
      });
      before += e - s;
    });
  }

  // ---- per-row packing ------------------------------------------------------------------------
  const rows: RowLayout[] = new Array(rowCount);
  const offsets = new Float64Array(rowCount + 1);
  const m = metrics;
  const arrow = m.featureArrow;

  for (let r = 0; r < rowCount; r++) {
    const start = r * N;
    const end = Math.min(L, start + N);

    // features
    let featurePieces: FeaturePiece[] = EMPTY as unknown as FeaturePiece[];
    const laneTranslation: boolean[] = [];
    const rawFeatures = featureBuckets[r];
    if (rawFeatures) {
      rawFeatures.sort(
        (a, b) =>
          a.startCol - b.startCol || b.order - a.order || b.extentLength - a.extentLength || a.feature - b.feature,
      );
      const laneRight: number[] = [];
      featurePieces = [];
      for (const p of rawFeatures) {
        const x0 = colLeft(geo, p.startCol);
        const x1 = colRight(geo, p.endCol - 1);
        let left = x0;
        let right = x1;
        let label: LabelPlacement | null = null;
        const name = features[p.feature].feature.name;
        if (name && p.bars.length > 0) {
          const w = measure(name, 'feature');
          let bar = p.bars[0];
          for (const b of p.bars) if (b.endCol - b.startCol > bar.endCol - bar.startCol) bar = b;
          const bx0 = colLeft(geo, bar.startCol) + (bar.arrowStart ? arrow : 0);
          const bx1 = colRight(geo, bar.endCol - 1) - (bar.arrowEnd ? arrow : 0);
          const available = bx1 - bx0 - 2 * m.labelPadding;
          if (w <= available) {
            label = { x: (bx0 + bx1) / 2 - w / 2, text: name, width: w, inside: true };
          } else if (p.labelPiece) {
            const rx = x1 + m.labelOffset;
            const lx = x0 - m.labelOffset - w;
            if (rx + w <= geo.labelRight) {
              label = { x: rx, text: name, width: w, inside: false };
              right = rx + w;
            } else if (lx >= geo.textLeft) {
              label = { x: lx, text: name, width: w, inside: false };
              left = lx;
            }
          }
          if (!label) {
            const t = truncateLabel(name, w, available, 'feature', measure);
            if (t) label = { x: (bx0 + bx1) / 2 - t.width / 2, text: t.text, width: t.width, inside: true };
          }
        }
        const lane = firstFitLane(laneRight, left, m.laneSpacing);
        laneRight[lane] = right;
        const translated = features[p.feature].translated;
        if (translated) laneTranslation[lane] = true;
        else if (laneTranslation[lane] === undefined) laneTranslation[lane] = false;
        featurePieces.push({
          feature: p.feature,
          lane,
          startCol: p.startCol,
          endCol: p.endCol,
          bars: p.bars,
          label,
          translated,
        });
      }
    }

    // enzyme labels: right to left, left-aligned at their cut, staggered upwards; a leader
    // occupies its x in every lower lane so later labels never cover it.
    let enzymeLabels: EnzymeLabel[] = EMPTY as unknown as EnzymeLabel[];
    let enzymeLanes = 0;
    const rawEnzymes = enzymeBuckets[r];
    if (rawEnzymes) {
      const n = end - start;
      rawEnzymes.sort((a, b) => b.gap - a.gap || a.text.localeCompare(b.text));
      const frontier: number[] = [];
      enzymeLabels = [];
      for (const raw of rawEnzymes) {
        const anchorX = gapX(geo, raw.gap, n);
        const width = measure(raw.text, raw.unique ? 'enzymeUnique' : 'enzyme');
        let x = anchorX;
        if (x + width > geo.labelRight) x = Math.max(geo.textLeft - 8, geo.labelRight - width);
        let lane = 0;
        while (lane < frontier.length && x + width + m.laneSpacing * 2 > frontier[lane]) lane++;
        frontier[lane] = x;
        for (let k = 0; k < lane; k++) frontier[k] = Math.min(frontier[k], anchorX - 2);
        enzymeLabels.push({ site: raw.site, lane, anchorX, x, width, text: raw.text, unique: raw.unique });
      }
      enzymeLanes = frontier.length;
    }

    // primers
    let primerPieces: PrimerPiece[] = EMPTY as unknown as PrimerPiece[];
    let fwdLanes = 0;
    let revLanes = 0;
    const rawPrimers = primerBuckets[r];
    if (rawPrimers) {
      rawPrimers.sort((a, b) => a.startCol - b.startCol || b.order - a.order || a.primer - b.primer);
      const fwdRight: number[] = [];
      const revRight: number[] = [];
      primerPieces = [];
      for (const p of rawPrimers) {
        const x0 = colLeft(geo, p.startCol);
        const x1 = colRight(geo, p.endCol - 1);
        let left = x0 - (p.strand === -1 && p.tip ? m.primerTip : 0);
        let right = x1 + (p.strand === 1 && p.tip ? m.primerTip : 0);
        let label: LabelPlacement | null = null;
        const name = primers[p.primer].name;
        if (name && p.fivePrime) {
          const w = measure(name, 'primer');
          const before = left - m.labelOffset - w;
          const after = right + m.labelOffset;
          // the name goes at the 5' end: left of a forward primer, right of a reverse one
          const preferLeft = p.strand === 1;
          const fitsLeft = before >= geo.textLeft - 4;
          const fitsRight = after + w <= geo.labelRight;
          if ((preferLeft && fitsLeft) || (!fitsRight && fitsLeft)) {
            label = { x: before, text: name, width: w, inside: false };
            left = before;
          } else if (fitsRight) {
            label = { x: after, text: name, width: w, inside: false };
            right = after + w;
          }
        }
        const lanes = p.strand === 1 ? fwdRight : revRight;
        const lane = firstFitLane(lanes, left, m.laneSpacing + 1);
        lanes[lane] = right;
        primerPieces.push({
          primer: p.primer,
          strand: p.strand,
          lane,
          startCol: p.startCol,
          endCol: p.endCol,
          openStart: p.openStart,
          openEnd: p.openEnd,
          tip: p.tip,
          fivePrime: p.fivePrime,
          label,
        });
      }
      fwdLanes = fwdRight.length;
      revLanes = revRight.length;
    }

    // ORFs
    let orfPieces: OrfPiece[] = EMPTY as unknown as OrfPiece[];
    let orfLanes = 0;
    const rawOrfs = orfBuckets[r];
    if (rawOrfs) {
      rawOrfs.sort((a, b) => a.startCol - b.startCol || b.order - a.order || a.orf - b.orf);
      const laneRight: number[] = [];
      orfPieces = [];
      for (const p of rawOrfs) {
        const tipLeft = p.tip && orfs[p.orf].strand === -1;
        const tipRight = p.tip && orfs[p.orf].strand === 1;
        const left = colLeft(geo, p.startCol) - (tipLeft ? 4 : 0);
        const right = colRight(geo, p.endCol - 1) + (tipRight ? 4 : 0);
        const lane = firstFitLane(laneRight, left, m.laneSpacing);
        laneRight[lane] = right;
        orfPieces.push({
          orf: p.orf,
          lane,
          startCol: p.startCol,
          endCol: p.endCol,
          openStart: p.openStart,
          openEnd: p.openEnd,
          tip: p.tip,
        });
      }
      orfLanes = laneRight.length;
    }

    // vertical layout
    let y = m.rowPaddingTop;
    const yEnzymes = y;
    y += enzymeLanes * m.enzymeLaneHeight;
    if (enzymeLanes > 0) y += m.enzymeClearance;
    const yPrimersFwd = y;
    y += fwdLanes * m.primerLaneHeight;
    const yStrand = y;
    y += m.strandHeight;
    const yComplement = y;
    if (showComplement) y += m.strandHeight;
    const yPrimersRev = y;
    y += revLanes * m.primerLaneHeight;
    let featureLanes: FeatureLane[] = EMPTY as unknown as FeatureLane[];
    const yFeatures = laneTranslation.length > 0 ? y + m.featureGap : y;
    if (laneTranslation.length > 0) {
      featureLanes = [];
      y = yFeatures;
      for (let k = 0; k < laneTranslation.length; k++) {
        const translation = laneTranslation[k] === true;
        featureLanes.push({ top: y, translation });
        y += m.featureBarHeight + (translation ? m.translationHeight : 0) + m.featureLaneGap;
      }
      y -= m.featureLaneGap;
    }
    const yOrfs = orfLanes > 0 ? y + m.orfGap : y;
    y = yOrfs + orfLanes * m.orfLaneHeight;
    y += m.rowPaddingBottom;

    rows[r] = {
      index: r,
      start,
      end,
      height: y,
      y: {
        enzymes: yEnzymes,
        primersFwd: yPrimersFwd,
        strand: yStrand,
        complement: yComplement,
        primersRev: yPrimersRev,
        features: yFeatures,
        orfs: yOrfs,
      },
      enzymeLanes,
      enzymeLabels,
      cutMarks: cutBuckets[r] ?? (EMPTY as unknown as CutMark[]),
      primerLanesFwd: fwdLanes,
      primerLanesRev: revLanes,
      primers: primerPieces,
      featureLanes,
      features: featurePieces,
      orfLanes,
      orfs: orfPieces,
    };
    offsets[r + 1] = offsets[r] + y;
  }

  return {
    length: L,
    topology,
    metrics,
    geometry: geo,
    basesPerRow: N,
    showComplement,
    rowCount,
    rows,
    offsets,
    totalHeight: offsets[rowCount],
  };
}

// ---------------------------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------------------------

/** Row whose vertical extent contains y (clamped to the first / last row). */
export function rowAtY(model: RowModel, y: number): number {
  const { offsets, rowCount } = model;
  if (y <= 0) return 0;
  if (y >= offsets[rowCount]) return rowCount - 1;
  let lo = 0;
  let hi = rowCount - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (offsets[mid] <= y) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Row holding base `index`. */
export function rowOfBase(model: RowModel, index: number): number {
  return Math.max(0, Math.min(model.rowCount - 1, Math.floor(index / model.basesPerRow)));
}

/**
 * Row in which a caret at gap `gap` (0..L) is drawn. A gap on a row boundary belongs to the
 * next row unless `upstream` (then it is drawn at the end of the previous row); the end of the
 * sequence is always drawn at the end of the last row.
 */
export function rowOfGap(model: RowModel, gap: number, upstream = false): number {
  const N = model.basesPerRow;
  if (gap >= model.length) return model.rowCount - 1;
  if (gap <= 0) return 0;
  if (upstream && gap % N === 0) return gap / N - 1;
  return Math.min(model.rowCount - 1, Math.floor(gap / N));
}

export interface PointHit {
  row: number;
  /** Gap position (0..L) nearest to the point. */
  gap: number;
  /** True when the gap is the end of `row` and also the start of the next row. */
  upstream: boolean;
}

/** Nearest gap to a point in content coordinates (y from the top of the first row). */
export function gapAtPoint(model: RowModel, x: number, y: number): PointHit {
  if (y < 0) return { row: 0, gap: 0, upstream: false };
  if (y >= model.totalHeight) return { row: model.rowCount - 1, gap: model.length, upstream: false };
  const row = rowAtY(model, y);
  const layout = model.rows[row];
  const n = layout.end - layout.start;
  const g = xToGap(model.geometry, x, n);
  return { row, gap: layout.start + g, upstream: g === n && n > 0 && layout.end < model.length };
}

/** Base index under a point in content coordinates (-1 for an empty sequence). */
export function baseAtPoint(model: RowModel, x: number, y: number): number {
  const row = rowAtY(model, y);
  const layout = model.rows[row];
  const col = xToCol(model.geometry, x, layout.end - layout.start);
  return col < 0 ? -1 : layout.start + col;
}

/** Where a point lies vertically inside its row. */
export type RowBand = 'enzymes' | 'primersFwd' | 'strand' | 'complement' | 'primersRev' | 'features' | 'other';

export function bandAtY(model: RowModel, y: number): RowBand {
  const row = model.rows[rowAtY(model, y)];
  const ry = y - model.offsets[row.index];
  const m = model.metrics;
  if (ry >= row.y.strand && ry < row.y.strand + m.strandHeight) return 'strand';
  if (model.showComplement && ry >= row.y.complement && ry < row.y.complement + m.strandHeight) return 'complement';
  if (ry >= row.y.enzymes && ry < row.y.primersFwd && row.enzymeLanes > 0) return 'enzymes';
  if (ry >= row.y.primersFwd && ry < row.y.strand) return 'primersFwd';
  if (ry >= row.y.primersRev && ry < row.y.primersRev + row.primerLanesRev * m.primerLaneHeight) return 'primersRev';
  if (row.featureLanes.length > 0 && ry >= row.y.features && ry < row.y.orfs) return 'features';
  return 'other';
}

/**
 * Columns [c0, c1) of the bases of `range` that fall into the row of bases [rowStart, rowEnd).
 * Wrapping ranges on circular molecules may give two pieces.
 */
export function rangeColsInRow(
  range: Range,
  rowStart: number,
  rowEnd: number,
  length: number,
  topology: Topology,
): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const [s, e] of linearSpans(range, length, topology)) {
    const a = Math.max(s, rowStart);
    const b = Math.min(e, rowEnd);
    if (b > a) out.push([a - rowStart, b - rowStart]);
  }
  return out;
}

/** Group ranges by the rows they touch (for overlays such as search hits). */
export function bucketRangesByRow<T extends { range: Range }>(
  items: readonly T[],
  basesPerRow: number,
  length: number,
  topology: Topology,
): Map<number, T[]> {
  const out = new Map<number, T[]>();
  const N = Math.max(1, basesPerRow);
  for (const item of items) {
    for (const [s, e] of linearSpans(item.range, length, topology)) {
      for (let r = Math.floor(s / N), last = Math.floor((e - 1) / N); r <= last; r++) {
        const list = out.get(r);
        if (list) {
          if (list[list.length - 1] !== item) list.push(item);
        } else out.set(r, [item]);
      }
    }
  }
  return out;
}
