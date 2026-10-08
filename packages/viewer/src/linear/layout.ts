/**
 * Geometry of the linear map, as pure functions (no DOM), so it can be unit tested and
 * memoized.
 *
 * Two stages:
 *  1. Static tracks (per record / data set, zoom independent): features, ORFs and primers are
 *     packed into lanes in bp space. Forward-strand items go above the backbone and reverse
 *     ones below; strand-less features go above.
 *  2. The view model (per frame): everything visible at the current viewport, in px, culled
 *     to the window. Sub-pixel features are aggregated into per-lane density, small ones are
 *     batched into one path per colour, labels are fitted (inside the bar, else beside it,
 *     else truncated, else dropped), enzyme labels are staggered into rows.
 *
 * Vertical order, from the top: enzyme labels, primers, ORFs, features, BACKBONE + ruler,
 * features, ORFs, primers. Features sit next to the backbone because they are the hero;
 * analysis overlays (ORFs, primers) sit outside them.
 */
import type {
  Feature,
  Orf,
  Primer,
  PrimerBindingSite,
  Range,
  SeqRecord,
  Topology,
} from '@hhereditas/core';
import { complement, featureExtent, mod, normalizeRange, splitAtOrigin } from '@hhereditas/core';
import { featureFill } from '../common/colors';
import type { CutMarker } from './enzymeLabels';
import { placeEnzymeLabels } from './enzymeLabels';
import type { Lane, LaneInterval } from './lanes';
import { buildLanes, packLanes, visibleSpan } from './lanes';
import type { ArrowEnd } from './shapes';
import { barPath, hlinePath, orfPath, primerPath, rectPath, vlinePath } from './shapes';
import type { TextMeasurer } from './textMeasure';
import { truncateToWidth } from './textMeasure';
import type { RulerTicks } from './ticks';
import { formatTick, rulerTicks } from './ticks';
import type { MapTarget } from './types';
import type { LinearScale } from './viewport';
import { LETTER_PX_PER_BASE } from './viewport';

/** Sizes in px. Font sizes mirror the --hh-text-* tokens used by the stylesheet. */
export const METRICS = {
  padX: 24,
  padTop: 18,
  padBottom: 22,
  enzymeRowHeight: 15,
  enzymeLabelPad: 3,
  enzymeGap: 10,
  featureLaneHeight: 22,
  featureBarHeight: 16,
  featureHead: 7,
  featureRadius: 3.5,
  orfLaneHeight: 11,
  orfThickness: 3,
  orfHead: 7,
  orfHeadHalf: 4,
  primerLaneHeight: 16,
  primerShaft: 2,
  primerHead: 8,
  primerBarb: 4,
  primerFont: 10,
  groupGap: 4,
  backboneGap: 9,
  strandGap: 4,
  letterBand: 30,
  rulerHeight: 24,
  labelFont: 11,
  labelWeight: 500,
  enzymeFont: 11,
  /** Weight of unique-cutter labels (matches .enzymeLabelUnique). */
  enzymeUniqueWeight: 600,
  tickFont: 10,
  maxEnzymeRows: 5,
  maxLanes: 24,
} as const;

/** Below this on-screen width (px) a feature is drawn as density. */
export const DENSITY_PX = 1.5;
/** Below this width (px) a feature is a plain rectangle (no arrow head, no inside label). */
export const SMALL_PX = 5;
/** Glyphs are clipped this far outside the visible area. */
const CLIP = 40;
/** Width (px) of density bins. */
const BIN_PX = 2;
/** Horizontal padding inside bars around a label, and between a bar and a label beside it. */
const INSIDE_PAD = 5;
const BESIDE_GAP = 4;
/** Density opacity levels (quantized coverage). */
const DENSITY_LEVELS = [0.35, 0.55, 0.75, 1] as const;
/** Fallback colour for density made of mixed feature types. */
const DENSITY_MIXED = 'var(--hh-feature-misc)';

export type Side = 'above' | 'below';

// ---------------------------------------------------------------------------
// Static tracks
// ---------------------------------------------------------------------------

interface TrackEntryBase {
  /** Normalized extent (may wrap the origin on circular records: end > length). */
  extent: Range;
  side: Side;
  lane: number;
}

export interface FeatureEntry extends TrackEntryBase {
  feature: Feature;
  /** Index in record.features. */
  index: number;
  fill: string;
  /** Normalized segments (multi-segment features are drawn as exons joined by a line). */
  segments: Range[];
}

export interface OrfEntry extends TrackEntryBase {
  orf: Orf;
}

export interface PrimerEntry extends TrackEntryBase {
  site: PrimerBindingSite;
  name: string;
  /** Normalized annealed region (may wrap the origin). */
  annealed: Range;
  /**
   * The non-annealing 5' tail, drawn raised beyond the annealed region: left of it for forward
   * primers, right of it for reverse ones. Clipped to [0, L] (it never wraps the origin).
   */
  tail: Range | null;
}

export interface TrackSet<E extends TrackEntryBase> {
  entries: E[];
  above: Lane[];
  below: Lane[];
}

function packSide<E extends TrackEntryBase>(entries: E[], side: Side, seqLength: number, maxLanes: number): Lane[] {
  const idx: number[] = [];
  for (let i = 0; i < entries.length; i++) if (entries[i].side === side) idx.push(i);
  const intervals: LaneInterval[] = idx.map((i) => entries[i].extent);
  const packed = packLanes(intervals, seqLength, maxLanes);
  for (let k = 0; k < idx.length; k++) entries[idx[k]].lane = packed.lanes[k];
  const lanes = buildLanes(intervals, packed, seqLength);
  for (const lane of lanes) for (const item of lane.items) item.ref = idx[item.ref];
  return lanes;
}

function makeTrackSet<E extends TrackEntryBase>(entries: E[], seqLength: number, maxLanes: number): TrackSet<E> {
  return {
    entries,
    above: packSide(entries, 'above', seqLength, maxLanes),
    below: packSide(entries, 'below', seqLength, maxLanes),
  };
}

/** Normalized range clamped to the record; null if empty. */
function cleanRange(r: Range, seqLength: number, topology: Topology): Range | null {
  if (seqLength <= 0) return null;
  const n = normalizeRange(r, seqLength, topology);
  return n.end > n.start ? n : null;
}

export function buildFeatureTrack(
  features: readonly Feature[],
  seqLength: number,
  topology: Topology,
  maxLanes: number = METRICS.maxLanes,
): TrackSet<FeatureEntry> {
  const entries: FeatureEntry[] = [];
  features.forEach((feature, index) => {
    if (feature.segments.length === 0) return;
    const extent = cleanRange(featureExtent(feature, seqLength, topology), seqLength, topology);
    if (!extent) return;
    const segments: Range[] = [];
    for (const s of feature.segments) {
      const r = cleanRange(s, seqLength, topology);
      if (r) segments.push(r);
    }
    if (segments.length === 0) return;
    entries.push({
      feature,
      index,
      extent,
      segments,
      side: feature.strand === -1 ? 'below' : 'above',
      lane: 0,
      fill: featureFill(feature),
    });
  });
  return makeTrackSet(entries, seqLength, maxLanes);
}

export function buildOrfTrack(
  orfs: readonly Orf[],
  seqLength: number,
  topology: Topology,
  maxLanes: number = METRICS.maxLanes,
): TrackSet<OrfEntry> {
  const entries: OrfEntry[] = [];
  for (const orf of orfs) {
    const extent = cleanRange(orf.range, seqLength, topology);
    if (extent) entries.push({ orf, extent, side: orf.strand === 1 ? 'above' : 'below', lane: 0 });
  }
  return makeTrackSet(entries, seqLength, maxLanes);
}

export function buildPrimerTrack(
  sites: readonly PrimerBindingSite[],
  primers: readonly Primer[],
  seqLength: number,
  topology: Topology,
  maxLanes: number = METRICS.maxLanes,
): TrackSet<PrimerEntry> {
  const names = new Map<string, string>();
  for (const p of primers) names.set(p.id, p.name);
  const entries: PrimerEntry[] = [];
  for (const site of sites) {
    const annealed = cleanRange(site.range, seqLength, topology);
    if (!annealed) continue;
    // The 5' tail hangs off the 5' end of the primer: left of the annealed part for forward
    // primers, right of it for reverse primers. It is clipped at the record ends (never wraps).
    let tail: Range | null = null;
    let extent = annealed;
    if (site.tailLength > 0) {
      if (site.strand === 1) {
        const s = Math.max(0, annealed.start - site.tailLength);
        if (s < annealed.start) {
          tail = { start: s, end: annealed.start };
          extent = { start: s, end: annealed.end };
        }
      } else {
        const e3 = annealed.end > seqLength ? annealed.end - seqLength : annealed.end;
        const e = Math.min(seqLength, e3 + site.tailLength);
        if (e > e3) {
          tail = { start: e3, end: e };
          extent = { start: annealed.start, end: annealed.end + (e - e3) };
        }
      }
    }
    entries.push({
      site,
      name: names.get(site.primerId) ?? site.primerId,
      annealed,
      tail,
      extent: normalizeRange(extent, seqLength, topology),
      side: site.strand === 1 ? 'above' : 'below',
      lane: 0,
    });
  }
  return makeTrackSet(entries, seqLength, maxLanes);
}

// ---------------------------------------------------------------------------
// Vertical layout
// ---------------------------------------------------------------------------

export interface LaneCounts {
  above: number;
  below: number;
}

export interface VerticalInput {
  enzymeRows: number;
  features: LaneCounts;
  orfs: LaneCounts;
  primers: LaneCounts;
  /** Distance between the two strand lines (grows with zoom to make room for letters). */
  strandGap: number;
}

export interface BandTops {
  /** Top y of each lane row, lane 0 = closest to the backbone. */
  above: number[];
  below: number[];
}

export interface VerticalLayout {
  height: number;
  enzymeRows: number;
  /** Top of the topmost enzyme row; row r (0 = lowest) spans enzymeRowTop(r) .. +rowHeight. */
  enzymeTop: number;
  enzymeBottom: number;
  features: BandTops;
  orfs: BandTops;
  primers: BandTops;
  topStrandY: number;
  bottomStrandY: number;
  rulerBottom: number;
  /** Vertical extent of the selection band. */
  bodyTop: number;
  bodyBottom: number;
}

export function enzymeRowTop(v: VerticalLayout, row: number): number {
  return v.enzymeBottom - (row + 1) * METRICS.enzymeRowHeight;
}

/** Height of the lanes of a band kind. */
export function laneHeight(kind: 'features' | 'orfs' | 'primers'): number {
  return kind === 'features' ? METRICS.featureLaneHeight : kind === 'orfs' ? METRICS.orfLaneHeight : METRICS.primerLaneHeight;
}

/** Distance between the strand lines for a zoom level: opens smoothly from 5 to 8 px/base. */
export function strandGapFor(pxPerBp: number): number {
  const lo = LETTER_PX_PER_BASE - 3;
  const t = Math.min(1, Math.max(0, (pxPerBp - lo) / (LETTER_PX_PER_BASE - lo)));
  const s = t * t * (3 - 2 * t);
  return METRICS.strandGap + (METRICS.letterBand - METRICS.strandGap) * s;
}

export function computeVerticalLayout(input: VerticalInput): VerticalLayout {
  const m = METRICS;
  let y = m.padTop;
  const enzymeTop = y;
  y += input.enzymeRows * m.enzymeRowHeight;
  const enzymeBottom = y;
  if (input.enzymeRows > 0) y += m.enzymeGap;

  const stackAbove = (count: number, h: number): number[] => {
    const tops: number[] = [];
    for (let k = 0; k < count; k++) tops.push(y + (count - 1 - k) * h);
    y += count * h;
    if (count > 0) y += m.groupGap;
    return tops;
  };
  const primersAbove = stackAbove(input.primers.above, m.primerLaneHeight);
  const orfsAbove = stackAbove(input.orfs.above, m.orfLaneHeight);
  const featuresAbove = stackAbove(input.features.above, m.featureLaneHeight);
  const anyAbove = input.primers.above + input.orfs.above + input.features.above > 0;
  const bodyTop = anyAbove ? enzymeBottom + (input.enzymeRows > 0 ? m.enzymeGap : 0) - 2 : y - 6;
  if (anyAbove) y -= m.groupGap;
  y += m.backboneGap;

  const topStrandY = y;
  y += input.strandGap;
  const bottomStrandY = y;
  y += m.rulerHeight;
  const rulerBottom = y;

  const stackBelow = (count: number, h: number): number[] => {
    const tops: number[] = [];
    for (let k = 0; k < count; k++) tops.push(y + k * h);
    y += count * h;
    if (count > 0) y += m.groupGap;
    return tops;
  };
  const featuresBelow = stackBelow(input.features.below, m.featureLaneHeight);
  const orfsBelow = stackBelow(input.orfs.below, m.orfLaneHeight);
  const primersBelow = stackBelow(input.primers.below, m.primerLaneHeight);
  const anyBelow = input.primers.below + input.orfs.below + input.features.below > 0;
  if (anyBelow) y -= m.groupGap;
  const bodyBottom = anyBelow ? y + 2 : rulerBottom - 4;
  y += m.padBottom;

  return {
    height: y,
    enzymeRows: input.enzymeRows,
    enzymeTop,
    enzymeBottom,
    features: { above: featuresAbove, below: featuresBelow },
    orfs: { above: orfsAbove, below: orfsBelow },
    primers: { above: primersAbove, below: primersBelow },
    topStrandY,
    bottomStrandY,
    rulerBottom,
    bodyTop,
    bodyBottom,
  };
}

// ---------------------------------------------------------------------------
// View model
// ---------------------------------------------------------------------------

export interface TextBox {
  key: string;
  text: string;
  /** Anchor point: x per `anchor`, y is the vertical centre of the text. */
  x: number;
  y: number;
  anchor: 'start' | 'middle' | 'end';
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface FeatureGlyph {
  key: string;
  entry: number;
  d: string;
  /** Line joining the segments of a multi-segment feature (introns), if any. */
  connector: string | null;
  fill: string;
}

export interface FeatureLabel extends TextBox {
  entry: number;
  inside: boolean;
}

export interface FillPath {
  key: string;
  d: string;
  fill: string;
  opacity: number;
}

export interface OrfGlyph {
  key: string;
  entry: number;
  d: string;
}

export interface PrimerGlyph {
  key: string;
  entry: number;
  d: string;
  /** Dashed 5' tail (path), if any. */
  tail: string | null;
  dir: 1 | -1;
}

export interface PrimerLabel extends TextBox {
  entry: number;
  dir: 1 | -1;
}

export interface EnzymeLabel extends TextBox {
  marker: number;
  unique: boolean;
  leader: string;
}

export interface LettersModel {
  fontSize: number;
  topY: number;
  bottomY: number;
  /** Text and per-glyph x positions (space separated) of each strand. */
  top: { text: string; xs: string } | null;
  bottom: { text: string; xs: string } | null;
}

export interface BackboneModel {
  top: [number, number] | null;
  bottom: [number, number] | null;
  /** Dashed continuations beyond the record ends of a circular record. */
  continuation: string | null;
  single: boolean;
}

export interface ViewInput {
  record: SeqRecord;
  width: number;
  scale: LinearScale;
  features: TrackSet<FeatureEntry> | null;
  orfs: TrackSet<OrfEntry> | null;
  primers: TrackSet<PrimerEntry> | null;
  markers: readonly CutMarker[] | null;
  /** Enzyme label rows to use (reserved, see enzymeRowsToReserve). */
  enzymeRows: number;
  measure: TextMeasurer;
}

export interface ViewModel {
  width: number;
  height: number;
  scale: LinearScale;
  v: VerticalLayout;
  seqLength: number;
  topology: Topology;
  /** bp range covered by the svg width (may extend beyond the record). */
  bpFrom: number;
  bpTo: number;
  letters: LettersModel | null;
  backbone: BackboneModel;
  ticks: { major: string; minor: string; labels: TextBox[]; info: RulerTicks };
  features: {
    glyphs: FeatureGlyph[];
    small: FillPath[];
    density: FillPath[];
    labels: FeatureLabel[];
  };
  orfs: { glyphs: OrfGlyph[]; small: string };
  primers: { glyphs: PrimerGlyph[]; labels: PrimerLabel[] };
  enzymes: {
    /** Cut ticks across the backbone (low zoom) or staggered cut paths (letter zoom). */
    ticks: string;
    staggered: string;
    leaders: string;
    labels: EnzymeLabel[];
    /** Indices (into markers) of the visible markers, for hit-testing. */
    visible: number[];
  };
}

/** Rows to reserve for enzyme labels: what the whole-record view needs, capped. Stable while panning. */
export function enzymeRowsToReserve(
  markers: readonly CutMarker[],
  seqLength: number,
  plotLeft: number,
  plotWidth: number,
  width: number,
  measure: TextMeasurer,
  maxRows: number = METRICS.maxEnzymeRows,
): number {
  if (markers.length === 0 || seqLength <= 0) return 0;
  const k = plotWidth / seqLength;
  const boxes = markers.map((m) => ({
    x: plotLeft + m.pos * k,
    width: METRICS.enzymeLabelPad + measure(m.label, METRICS.enzymeFont, m.unique ? METRICS.enzymeUniqueWeight : 400),
    priority: m.unique ? 1 : 0,
  }));
  const placed = placeEnzymeLabels(boxes, { maxRows, minX: 2, maxX: width - 2 });
  let rows = 1;
  for (const p of placed) if (p && p.row + 1 > rows) rows = p.row + 1;
  return rows;
}

/** [top strand extent, bottom strand extent] in bp, honouring single-stranded ends. */
export function strandExtents(record: SeqRecord): { top: [number, number]; bottom: [number, number] } {
  const L = record.seq.length;
  const top: [number, number] = [0, L];
  const bottom: [number, number] = [0, L];
  if (record.topology === 'linear' && record.ends) {
    const { left, right } = record.ends;
    const n = (len: number) => Math.max(0, Math.min(L, len));
    if (left.kind === '5prime') bottom[0] = n(left.length);
    if (left.kind === '3prime') top[0] = n(left.length);
    if (right.kind === '5prime') top[1] = L - n(right.length);
    if (right.kind === '3prime') bottom[1] = L - n(right.length);
  }
  return { top, bottom };
}

/** Letter size for a zoom level (mono font, px). */
export function letterFontSize(pxPerBp: number): number {
  return Math.min(14, Math.max(9, Math.round(pxPerBp * 1.1 * 2) / 2));
}

const fmt = (n: number): string => `${Math.round(n * 100) / 100}`;

interface LaneContext {
  scale: LinearScale;
  width: number;
  bpFrom: number;
  bpTo: number;
  measure: TextMeasurer;
  seqLength: number;
}

/** Pieces (in [0, L]) of a normalized range. */
function piecesOf(r: Range, seqLength: number): Range[] {
  return r.end > seqLength ? splitAtOrigin(r, seqLength) : [r];
}

/**
 * Shape of one lane item of a feature: the bar(s) and, for multi-segment features, the line
 * joining them. Also returns the widest visible body (the part of a bar without its arrow head)
 * where an inside label can go.
 */
export function featurePieceShape(
  entry: FeatureEntry,
  piece: { start: number; end: number; piece: 0 | 1 | 2 },
  top: number,
  ctx: Pick<LaneContext, 'scale' | 'width' | 'seqLength'>,
  minWidth = 0,
): { d: string; connector: string | null; bodyL: number; bodyR: number } {
  const { scale, width, seqLength: L } = ctx;
  const h = METRICS.featureBarHeight;
  const strand = entry.feature.strand;
  // 3' end of the feature, as a position in [0, L]
  const end3 = strand === -1 ? entry.extent.start : entry.extent.end > L ? entry.extent.end - L : entry.extent.end;

  const subPieces: Range[] = [];
  if (entry.segments.length === 1) {
    subPieces.push({ start: piece.start, end: piece.end });
  } else {
    for (const seg of entry.segments) {
      for (const p of piecesOf(seg, L)) {
        const s = Math.max(p.start, piece.start);
        const e = Math.min(p.end, piece.end);
        if (e > s) subPieces.push({ start: s, end: e });
      }
    }
    subPieces.sort((a, b) => a.start - b.start);
  }

  let d = '';
  let bestL = 0;
  let bestR = 0;
  for (const sp of subPieces) {
    let x0 = scale.x(sp.start);
    let x1 = scale.x(sp.end);
    if (x1 - x0 < minWidth) {
      const c = (x0 + x1) / 2;
      x0 = c - minWidth / 2;
      x1 = c + minWidth / 2;
    }
    let arrow: ArrowEnd = 'none';
    if (strand === 1 && sp.end === end3) arrow = 'right';
    else if (strand === -1 && sp.start === end3) arrow = 'left';
    // ends where the feature continues across the origin are square
    let squareLeft = piece.piece === 2 && sp.start === 0;
    let squareRight = piece.piece === 1 && sp.end === L;
    // clip far off-screen ends (they are never seen, and huge coordinates lose precision)
    if (x0 < -CLIP) {
      x0 = -CLIP;
      squareLeft = true;
      if (arrow === 'left') arrow = 'none';
    }
    if (x1 > width + CLIP) {
      x1 = width + CLIP;
      squareRight = true;
      if (arrow === 'right') arrow = 'none';
    }
    if (x1 <= x0) continue;
    d += barPath(x0, x1, top, h, {
      arrow,
      head: METRICS.featureHead,
      radius: METRICS.featureRadius,
      squareLeft,
      squareRight,
    });
    const head = arrow === 'none' ? 0 : Math.min(METRICS.featureHead, (x1 - x0) * 0.6);
    const bl = Math.max(0, arrow === 'left' ? x0 + head : x0);
    const br = Math.min(width, arrow === 'right' ? x1 - head : x1);
    if (br - bl > bestR - bestL) {
      bestL = bl;
      bestR = br;
    }
  }
  let connector: string | null = null;
  if (entry.segments.length > 1 && subPieces.length > 0) {
    const cy = top + h / 2;
    let c = '';
    for (let k = 1; k < subPieces.length; k++) {
      const a = Math.max(-CLIP, scale.x(subPieces[k - 1].end));
      const b = Math.min(width + CLIP, scale.x(subPieces[k].start));
      if (b > a) c += hlinePath(a, b, cy);
    }
    // a piece that starts/ends inside an intron (the join continues across the origin)
    const first = scale.x(subPieces[0].start);
    const pieceStart = scale.x(piece.start);
    if (first > pieceStart + 0.5) c += hlinePath(Math.max(-CLIP, pieceStart), Math.min(width + CLIP, first), cy);
    const last = scale.x(subPieces[subPieces.length - 1].end);
    const pieceEnd = scale.x(piece.end);
    if (pieceEnd > last + 0.5) c += hlinePath(Math.max(-CLIP, last), Math.min(width + CLIP, pieceEnd), cy);
    connector = c || null;
  }
  return { d, connector, bodyL: bestL, bodyR: bestR };
}

/** Visible px width of a feature piece. */
function visibleWidth(start: number, end: number, scale: LinearScale, width: number): number {
  return Math.max(0, Math.min(width, scale.x(end)) - Math.max(0, scale.x(start)));
}

function layoutFeatures(
  set: TrackSet<FeatureEntry>,
  v: VerticalLayout,
  ctx: LaneContext,
  out: ViewModel['features'],
): void {
  const { scale, width, bpFrom, bpTo, measure, seqLength: L } = ctx;
  const m = METRICS;
  const nBins = Math.max(1, Math.ceil(width / BIN_PX));
  const smallByFill = new Map<string, string>();

  for (const side of ['above', 'below'] as const) {
    const lanes = set[side];
    for (let lane = 0; lane < lanes.length; lane++) {
      const { items } = lanes[lane];
      const [i0, i1] = visibleSpan(lanes[lane], bpFrom, bpTo);
      if (i0 >= i1) continue;
      const rowTop = v.features[side][lane];
      const top = rowTop + (m.featureLaneHeight - m.featureBarHeight) / 2;
      const cy = top + m.featureBarHeight / 2;
      let occupied = -Infinity;
      let bins: Float32Array | null = null;
      let densityFill: string | null = null;

      for (let i = i0; i < i1; i++) {
        const it = items[i];
        if (it.end <= bpFrom || it.start >= bpTo) continue;
        const entry = set.entries[it.ref];
        const x0 = scale.x(it.start);
        const x1 = scale.x(it.end);
        const w = x1 - x0;

        if (w < DENSITY_PX) {
          bins ??= new Float32Array(nBins);
          const a = Math.max(0, x0);
          const b = Math.min(width, x1);
          for (let bin = Math.floor(a / BIN_PX); bin < nBins && bin * BIN_PX < b; bin++) {
            const overlap = Math.min(b, (bin + 1) * BIN_PX) - Math.max(a, bin * BIN_PX);
            if (overlap > 0) bins[bin] += overlap / BIN_PX;
          }
          densityFill = densityFill === null ? entry.fill : densityFill === entry.fill ? densityFill : DENSITY_MIXED;
          occupied = Math.max(occupied, x1);
          continue;
        }

        const next = i + 1 < items.length ? scale.x(items[i + 1].start) : Infinity;
        const name = entry.feature.name;
        const isLabelPiece =
          it.piece === 0 ||
          (() => {
            // label only the piece with the larger visible width
            const other = it.piece === 1 ? { start: 0, end: entry.extent.end - L } : { start: entry.extent.start, end: L };
            const mine = visibleWidth(it.start, it.end, scale, width);
            const theirs = visibleWidth(other.start, other.end, scale, width);
            return mine > theirs || (mine === theirs && it.piece === 1);
          })();

        let bodyL = Math.max(0, x0);
        let bodyR = Math.min(width, x1);
        if (w < SMALL_PX) {
          const xa = Math.max(-CLIP, x0);
          const xb = Math.min(width + CLIP, x1);
          smallByFill.set(entry.fill, (smallByFill.get(entry.fill) ?? '') + rectPath(xa, top, xb - xa, m.featureBarHeight));
          bodyR = bodyL; // no room inside
        } else {
          const shape = featurePieceShape(entry, it, top, ctx);
          out.glyphs.push({ key: `${entry.feature.id}:${it.piece}`, entry: it.ref, d: shape.d, connector: shape.connector, fill: entry.fill });
          bodyL = shape.bodyL;
          bodyR = shape.bodyR;
        }

        let labelRight = -Infinity;
        if (isLabelPiece && name) {
          const tw = measure(name, m.labelFont, m.labelWeight);
          const avail = bodyR - bodyL - 2 * INSIDE_PAD;
          const th = m.labelFont;
          const box = (text: string, x: number, anchor: TextBox['anchor'], textW: number, inside: boolean): FeatureLabel => {
            const left = anchor === 'start' ? x : anchor === 'end' ? x - textW : x - textW / 2;
            return {
              key: `${entry.feature.id}:${it.piece}:label`,
              entry: it.ref,
              text,
              x,
              y: cy,
              anchor,
              inside,
              left,
              right: left + textW,
              top: cy - th / 2 - 1,
              bottom: cy + th / 2 + 1,
            };
          };
          if (tw <= avail) {
            out.labels.push(box(name, (bodyL + bodyR) / 2, 'middle', tw, true));
          } else {
            const rx0 = x1 + BESIDE_GAP;
            const lx1 = x0 - BESIDE_GAP;
            if (x1 >= 0 && rx0 + tw + BESIDE_GAP <= next && rx0 + tw <= width - 2) {
              out.labels.push(box(name, rx0, 'start', tw, false));
              labelRight = rx0 + tw;
            } else if (x0 <= width && lx1 - tw >= occupied + BESIDE_GAP && lx1 - tw >= 2) {
              out.labels.push(box(name, lx1, 'end', tw, false));
            } else if (avail >= 22) {
              const text = truncateToWidth(name, avail, (s) => measure(s, m.labelFont, m.labelWeight));
              if (text) out.labels.push(box(text, (bodyL + bodyR) / 2, 'middle', measure(text, m.labelFont, m.labelWeight), true));
            }
          }
        }
        occupied = Math.max(occupied, x1, labelRight);
      }

      if (bins) {
        const fill = densityFill ?? DENSITY_MIXED;
        const paths = DENSITY_LEVELS.map(() => '');
        let b = 0;
        while (b < nBins) {
          const cov = bins[b];
          if (cov <= 0.001) {
            b++;
            continue;
          }
          const level = Math.min(DENSITY_LEVELS.length - 1, Math.max(0, Math.ceil(Math.min(1, cov) * DENSITY_LEVELS.length) - 1));
          let e = b + 1;
          while (e < nBins && bins[e] > 0.001) {
            const l2 = Math.min(DENSITY_LEVELS.length - 1, Math.max(0, Math.ceil(Math.min(1, bins[e]) * DENSITY_LEVELS.length) - 1));
            if (l2 !== level) break;
            e++;
          }
          paths[level] += rectPath(b * BIN_PX, top, (e - b) * BIN_PX, m.featureBarHeight);
          b = e;
        }
        paths.forEach((d, level) => {
          if (d) out.density.push({ key: `${side}:${lane}:${level}`, d, fill, opacity: DENSITY_LEVELS[level] });
        });
      }
    }
  }
  for (const [fill, d] of smallByFill) out.small.push({ key: `small:${fill}`, d, fill, opacity: 1 });
}

function layoutOrfs(set: TrackSet<OrfEntry>, v: VerticalLayout, ctx: LaneContext, out: ViewModel['orfs']): void {
  const { scale, width, bpFrom, bpTo } = ctx;
  const m = METRICS;
  let small = '';
  for (const side of ['above', 'below'] as const) {
    const lanes = set[side];
    for (let lane = 0; lane < lanes.length; lane++) {
      const [i0, i1] = visibleSpan(lanes[lane], bpFrom, bpTo);
      const cy = v.orfs[side][lane] + m.orfLaneHeight / 2;
      for (let i = i0; i < i1; i++) {
        const it = lanes[lane].items[i];
        if (it.end <= bpFrom || it.start >= bpTo) continue;
        const entry = set.entries[it.ref];
        const x0 = Math.max(-CLIP, scale.x(it.start));
        const x1 = Math.min(width + CLIP, scale.x(it.end));
        if (x1 - x0 < SMALL_PX) {
          small += rectPath(x0, cy - m.orfThickness / 2, Math.max(1, x1 - x0), m.orfThickness);
          continue;
        }
        const dir = entry.orf.strand;
        const L = ctx.seqLength;
        // the arrow head goes on the piece holding the 3' end
        const end3 = dir === 1 ? (entry.extent.end > L ? entry.extent.end - L : entry.extent.end) : entry.extent.start;
        const hasHead = dir === 1 ? it.end === end3 && scale.x(it.end) <= width + CLIP : it.start === end3 && scale.x(it.start) >= -CLIP;
        const d = hasHead
          ? orfPath(x0, x1, cy, dir, m.orfThickness, m.orfHead, m.orfHeadHalf)
          : rectPath(x0, cy - m.orfThickness / 2, x1 - x0, m.orfThickness);
        out.glyphs.push({ key: `orf:${it.ref}:${it.piece}`, entry: it.ref, d });
      }
    }
  }
  out.small = small;
}

function layoutPrimers(set: TrackSet<PrimerEntry>, v: VerticalLayout, ctx: LaneContext, out: ViewModel['primers']): void {
  const { scale, width, bpFrom, bpTo, measure, seqLength: L } = ctx;
  const m = METRICS;
  for (const side of ['above', 'below'] as const) {
    const lanes = set[side];
    for (let lane = 0; lane < lanes.length; lane++) {
      const { items } = lanes[lane];
      const [i0, i1] = visibleSpan(lanes[lane], bpFrom, bpTo);
      // the shaft sits a little towards the backbone; the barb and tail rise away from it
      const cy = v.primers[side][lane] + m.primerLaneHeight / 2 + (side === 'above' ? 2 : -2);
      let occupied = -Infinity;
      for (let i = i0; i < i1; i++) {
        const it = items[i];
        if (it.end <= bpFrom || it.start >= bpTo) continue;
        const entry = set.entries[it.ref];
        const dir = entry.site.strand;
        const ann = entry.annealed;
        // 3' end of the primer in [0, L]: right end of a forward primer, left end of a reverse one
        const end3 = dir === 1 ? (ann.end > L ? ann.end - L : ann.end) : ann.start;

        let d = '';
        for (const ap of piecesOf(ann, L)) {
          const s = Math.max(ap.start, it.start);
          const e = Math.min(ap.end, it.end);
          if (e <= s) continue;
          let x0 = scale.x(s);
          let x1 = scale.x(e);
          if (x1 - x0 < 1.5) {
            const c = (x0 + x1) / 2;
            x0 = c - 0.75;
            x1 = c + 0.75;
          }
          const tip = dir === 1 ? e === end3 && x1 <= width + CLIP : s === end3 && x0 >= -CLIP;
          const cx0 = Math.max(-CLIP, x0);
          const cx1 = Math.min(width + CLIP, x1);
          d += tip
            ? primerPath(cx0, cx1, cy, dir, m.primerShaft, m.primerHead, m.primerBarb)
            : rectPath(cx0, cy - m.primerShaft / 2, cx1 - cx0, m.primerShaft);
        }

        let tail: string | null = null;
        if (entry.tail) {
          const s = Math.max(entry.tail.start, it.start);
          const e = Math.min(entry.tail.end, it.end);
          if (e > s) {
            const ty = cy + (dir === 1 ? -3.5 : 3.5);
            const x0 = Math.max(-CLIP, scale.x(s));
            const x1 = Math.min(width + CLIP, scale.x(e));
            // a short diagonal joins the raised tail to the shaft where annealing starts
            if (dir === 1) {
              tail = e === entry.tail.end ? `M${fmt(x0)} ${fmt(ty)}H${fmt(Math.max(x0, x1 - 2.5))}L${fmt(x1)} ${fmt(cy)}` : hlinePath(x0, x1, ty);
            } else {
              tail = s === entry.tail.start ? `M${fmt(x1)} ${fmt(ty)}H${fmt(Math.min(x1, x0 + 2.5))}L${fmt(x0)} ${fmt(cy)}` : hlinePath(x0, x1, ty);
            }
          }
        }
        if (!d && !tail) continue;
        out.glyphs.push({ key: `primer:${it.ref}:${it.piece}`, entry: it.ref, d, tail, dir });

        // Name beside the primer, on its 3' side first. A primer that wraps the origin is
        // labelled on the piece that holds its 3' end.
        const x0 = scale.x(it.start);
        const x1 = scale.x(it.end);
        let labelRight = -Infinity;
        const isLabelPiece = it.piece === 0 || it.piece === (dir === 1 ? 2 : 1);
        if (isLabelPiece && entry.name) {
          const next = i + 1 < items.length ? scale.x(items[i + 1].start) : Infinity;
          const tw = measure(entry.name, m.primerFont, 500);
          const rightOk = x1 >= 0 && x1 + BESIDE_GAP + tw + BESIDE_GAP <= next && x1 + BESIDE_GAP + tw <= width - 2;
          const leftOk = x0 <= width && x0 - BESIDE_GAP - tw >= occupied + BESIDE_GAP && x0 - BESIDE_GAP - tw >= 2;
          const right = dir === 1 ? (rightOk ? true : leftOk ? false : null) : leftOk ? false : rightOk ? true : null;
          if (right !== null) {
            const x = right ? x1 + BESIDE_GAP : x0 - BESIDE_GAP;
            const left = right ? x : x - tw;
            out.labels.push({
              key: `primer:${it.ref}:${it.piece}:label`,
              entry: it.ref,
              dir,
              text: entry.name,
              x,
              y: cy,
              anchor: right ? 'start' : 'end',
              left,
              right: left + tw,
              top: cy - m.primerFont / 2 - 1,
              bottom: cy + m.primerFont / 2 + 1,
            });
            if (right) labelRight = x + tw;
          }
        }
        occupied = Math.max(occupied, x1, labelRight);
      }
    }
  }
}

/** Build the per-frame view model. */
export function computeView(input: ViewInput): ViewModel {
  const { record, width, scale, measure } = input;
  const L = record.seq.length;
  const topology = record.topology;
  const k = scale.pxPerBp;
  const bpFrom = scale.bp(-CLIP);
  const bpTo = scale.bp(width + CLIP);
  const count = (set: TrackSet<TrackEntryBase> | null): LaneCounts =>
    set ? { above: set.above.length, below: set.below.length } : { above: 0, below: 0 };
  const isDna = record.molecule === 'DNA';
  const v = computeVerticalLayout({
    enzymeRows: input.markers && input.markers.length > 0 ? input.enzymeRows : 0,
    features: count(input.features),
    orfs: count(input.orfs),
    primers: count(input.primers),
    strandGap: isDna ? strandGapFor(k) : 0,
  });

  const ctx: LaneContext = { scale, width, bpFrom, bpTo, measure, seqLength: L };

  // --- backbone -------------------------------------------------------------
  const ext = strandExtents(record);
  const clipX = (bp: number) => Math.min(width + 2, Math.max(-2, scale.x(bp)));
  const strand = (r: [number, number]): [number, number] | null => {
    if (r[1] <= r[0]) return null;
    const a = clipX(r[0]);
    const b = clipX(r[1]);
    return b > a ? [a, b] : null;
  };
  let continuation: string | null = null;
  if (topology === 'circular' && L > 0) {
    const ys = isDna ? [v.topStrandY, v.bottomStrandY] : [v.topStrandY];
    let c = '';
    for (const y of ys) {
      const xs = scale.x(0);
      const xe = scale.x(L);
      if (xs > 0) for (let d = 3; d <= 13; d += 5) c += hlinePath(xs - d - 2.5, xs - d, y);
      if (xe < width) for (let d = 3; d <= 13; d += 5) c += hlinePath(xe + d, xe + d + 2.5, y);
    }
    continuation = c || null;
  }
  const backbone: BackboneModel = {
    top: strand(ext.top),
    bottom: isDna ? strand(ext.bottom) : null,
    continuation,
    single: !isDna,
  };

  // --- letters ----------------------------------------------------------------
  let letters: LettersModel | null = null;
  if (k >= LETTER_PX_PER_BASE && L > 0) {
    const i0 = Math.max(0, Math.floor(scale.bp(0)) - 1);
    const i1 = Math.min(L, Math.ceil(scale.bp(width)) + 1);
    const row = (a: number, b: number, comp: boolean) => {
      const s = Math.max(i0, a);
      const e = Math.min(i1, b);
      if (e <= s) return null;
      const raw = record.seq.slice(s, e);
      const xs: string[] = [];
      for (let i = s; i < e; i++) xs.push(fmt(scale.x(i + 0.5)));
      return { text: comp ? complement(raw) : raw, xs: xs.join(' ') };
    };
    const fontSize = letterFontSize(k);
    letters = {
      fontSize,
      topY: isDna ? v.topStrandY + (v.bottomStrandY - v.topStrandY) * 0.28 : v.topStrandY - fontSize * 0.8,
      bottomY: v.topStrandY + (v.bottomStrandY - v.topStrandY) * 0.72,
      top: row(ext.top[0], ext.top[1], false),
      bottom: isDna ? row(ext.bottom[0], ext.bottom[1], true) : null,
    };
  }

  // --- ruler ------------------------------------------------------------------
  const tickInfo = rulerTicks(scale, L, {
    x0: 0,
    x1: width,
    measure: (t) => measure(t, METRICS.tickFont, 400),
  });
  const tickTop = v.bottomStrandY + 1.5;
  let major = '';
  let minor = '';
  const labels: TextBox[] = [];
  const labelY = v.bottomStrandY + 15;
  for (const n of tickInfo.major) {
    const x = Math.round(scale.x(n - 0.5) * 2) / 2;
    major += vlinePath(x, tickTop, tickTop + 4.5);
    const text = formatTick(n, tickInfo.step);
    const tw = measure(text, METRICS.tickFont, 400);
    const cx = Math.min(width - 2 - tw / 2, Math.max(2 + tw / 2, x));
    labels.push({ key: `t${n}`, text, x: cx, y: labelY, anchor: 'middle', left: cx - tw / 2, right: cx + tw / 2, top: labelY - 6, bottom: labelY + 6 });
  }
  for (const n of tickInfo.minor) {
    const x = Math.round(scale.x(n - 0.5) * 2) / 2;
    minor += vlinePath(x, tickTop, tickTop + 2.5);
  }

  // --- tracks ---------------------------------------------------------------
  const view: ViewModel = {
    width,
    height: v.height,
    scale,
    v,
    seqLength: L,
    topology,
    bpFrom,
    bpTo,
    letters,
    backbone,
    ticks: { major, minor, labels, info: tickInfo },
    features: { glyphs: [], small: [], density: [], labels: [] },
    orfs: { glyphs: [], small: '' },
    primers: { glyphs: [], labels: [] },
    enzymes: { ticks: '', staggered: '', leaders: '', labels: [], visible: [] },
  };
  if (input.features) layoutFeatures(input.features, v, ctx, view.features);
  if (input.orfs) layoutOrfs(input.orfs, v, ctx, view.orfs);
  if (input.primers) layoutPrimers(input.primers, v, ctx, view.primers);
  if (input.markers && input.markers.length > 0) layoutEnzymes(input.markers, v, ctx, view, letters !== null);
  return view;
}

/** Index of the first marker with pos >= bp. */
function firstMarkerAtLeast(markers: readonly CutMarker[], bp: number): number {
  let lo = 0;
  let hi = markers.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (markers[mid].pos < bp) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function layoutEnzymes(markers: readonly CutMarker[], v: VerticalLayout, ctx: LaneContext, view: ViewModel, letterZoom: boolean): void {
  const { scale, width, measure } = ctx;
  const m = METRICS;
  const a = firstMarkerAtLeast(markers, scale.bp(-2));
  const b = firstMarkerAtLeast(markers, scale.bp(width + 2) + 1e-9);
  const visible: number[] = [];
  for (let i = a; i < b; i++) visible.push(i);
  view.enzymes.visible = visible;

  // cut marks on the backbone; at letter zoom the staggered cut between the strands
  let ticks = '';
  let staggered = '';
  let lastX = NaN;
  const yTop = v.topStrandY - 3.5;
  const yBottom = v.bottomStrandY + 3.5;
  for (const i of visible) {
    const mk = markers[i];
    const x = Math.round(scale.x(mk.pos) * 2) / 2;
    if (letterZoom && mk.cuts) {
      const xb = Math.round(scale.x(mk.bottom) * 2) / 2;
      const yMid = (v.topStrandY + v.bottomStrandY) / 2;
      staggered += `M${fmt(x)} ${fmt(v.topStrandY - 3)}V${fmt(yMid)}H${fmt(xb)}V${fmt(v.bottomStrandY + 3)}`;
      continue;
    }
    if (x === lastX) continue;
    lastX = x;
    ticks += vlinePath(x, yTop, yBottom);
  }
  view.enzymes.ticks = ticks;
  view.enzymes.staggered = staggered;

  if (v.enzymeRows <= 0) return;
  const boxes = visible.map((i) => {
    const mk = markers[i];
    return {
      x: scale.x(mk.pos),
      width: m.enzymeLabelPad + measure(mk.label, m.enzymeFont, mk.unique ? m.enzymeUniqueWeight : 400),
      priority: mk.unique ? 1 : 0,
    };
  });
  const placed = placeEnzymeLabels(boxes, { maxRows: v.enzymeRows, minX: 2, maxX: width - 2 });
  let leaders = '';
  placed.forEach((p, j) => {
    if (!p) return;
    const i = visible[j];
    const mk = markers[i];
    const x = Math.round(boxes[j].x * 2) / 2;
    const rowTop = enzymeRowTop(v, p.row);
    const cy = rowTop + m.enzymeRowHeight / 2;
    const leader = vlinePath(x, cy + 3, v.topStrandY - 3.5);
    leaders += leader;
    const textX = p.align === 'start' ? x + m.enzymeLabelPad : x - m.enzymeLabelPad;
    view.enzymes.labels.push({
      key: `e${i}`,
      marker: i,
      unique: mk.unique,
      text: mk.label,
      x: textX,
      y: cy,
      anchor: p.align === 'start' ? 'start' : 'end',
      left: p.left,
      right: p.right,
      top: rowTop + 1,
      bottom: rowTop + m.enzymeRowHeight - 1,
      leader,
    });
  });
  view.enzymes.leaders = leaders;
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

export interface SelectionPiece {
  start: number;
  end: number;
  /** False where the piece is cut by the origin (the selection continues at the other end). */
  startEdge: boolean;
  endEdge: boolean;
}

/** Pieces of a selection in [0, L]: a range that wraps the origin of a circular record gives two. */
export function selectionPieces(range: Range, seqLength: number, topology: Topology): SelectionPiece[] {
  if (seqLength <= 0) return [];
  const r = normalizeRange(range, seqLength, topology);
  if (r.end <= r.start) return [];
  if (topology === 'circular' && r.end > seqLength) {
    if (r.end - r.start >= seqLength) return [{ start: 0, end: seqLength, startEdge: true, endEdge: true }];
    return [
      { start: r.start, end: seqLength, startEdge: true, endEdge: false },
      { start: 0, end: r.end - seqLength, startEdge: false, endEdge: true },
    ];
  }
  return [{ start: r.start, end: r.end, startEdge: true, endEdge: true }];
}

/** x positions at which to draw the caret for a gap (both ends for the origin of a circular record). */
export function caretPositions(gap: number, seqLength: number, topology: Topology): number[] {
  if (topology === 'circular' && seqLength > 0) {
    const g = mod(gap, seqLength);
    return g === 0 ? [0, seqLength] : [g];
  }
  return [Math.max(0, Math.min(seqLength, gap))];
}

// ---------------------------------------------------------------------------
// Hit testing
// ---------------------------------------------------------------------------

export interface HitInput {
  view: ViewModel;
  features: TrackSet<FeatureEntry> | null;
  orfs: TrackSet<OrfEntry> | null;
  primers: TrackSet<PrimerEntry> | null;
  markers: readonly CutMarker[] | null;
}

function inBox(b: TextBox, x: number, y: number, pad = 2): boolean {
  return x >= b.left - pad && x <= b.right + pad && y >= b.top - pad && y <= b.bottom + pad;
}

/** Lane item at x (px) within `tol` px, preferring an item that contains x. */
function itemAt(lane: Lane, scale: LinearScale, x: number, tol: number): number {
  const [i0, i1] = visibleSpan(lane, scale.bp(x - tol), scale.bp(x + tol));
  let best = -1;
  let bestDist = Infinity;
  for (let i = i0; i < i1; i++) {
    const it = lane.items[i];
    const x0 = scale.x(it.start);
    const x1 = scale.x(it.end);
    const dist = x < x0 ? x0 - x : x > x1 ? x - x1 : 0;
    if (dist <= tol && dist < bestDist) {
      best = i;
      bestDist = dist;
      if (dist === 0) break;
    }
  }
  return best;
}

/** Base index (0-based) and gap position under x. */
export function positionsAt(scale: LinearScale, x: number, seqLength: number): { base: number; gap: number } {
  const bp = scale.bp(x);
  return {
    base: Math.max(0, Math.min(seqLength - 1, Math.floor(bp))),
    gap: Math.max(0, Math.min(seqLength, Math.round(bp))),
  };
}

/** What lies at (x, y) in map coordinates (y measured from the top of the map content). */
export function hitTest(input: HitInput, x: number, y: number): MapTarget {
  const { view } = input;
  const { scale, v } = view;
  const L = view.seqLength;
  const { base, gap } = positionsAt(scale, x, L);

  if (input.markers) {
    for (const lab of view.enzymes.labels) {
      if (inBox(lab, x, y)) return { kind: 'enzyme', site: input.markers[lab.marker].site };
    }
  }
  if (input.features) {
    for (const lab of view.features.labels) {
      if (!lab.inside && inBox(lab, x, y, 1)) return { kind: 'feature', id: input.features.entries[lab.entry].feature.id };
    }
  }
  if (input.primers) {
    for (const lab of view.primers.labels) {
      if (inBox(lab, x, y, 1)) return { kind: 'primer', id: input.primers.entries[lab.entry].site.primerId };
    }
  }

  const laneHit = <E extends TrackEntryBase>(
    set: TrackSet<E> | null,
    tops: BandTops,
    h: number,
    tol: number,
  ): E | null => {
    if (!set) return null;
    for (const side of ['above', 'below'] as const) {
      const lanes = set[side];
      for (let lane = 0; lane < lanes.length; lane++) {
        const top = tops[side][lane];
        if (y < top || y >= top + h) continue;
        const i = itemAt(lanes[lane], scale, x, tol);
        return i >= 0 ? set.entries[lanes[lane].items[i].ref] : null;
      }
    }
    return null;
  };

  const f = laneHit(input.features, v.features, METRICS.featureLaneHeight, 2);
  if (f) return { kind: 'feature', id: f.feature.id };
  const o = laneHit(input.orfs, v.orfs, METRICS.orfLaneHeight, 2);
  if (o) return { kind: 'orf', orf: o.orf };
  const p = laneHit(input.primers, v.primers, METRICS.primerLaneHeight, 3);
  if (p) return { kind: 'primer', id: p.site.primerId };

  // backbone and ruler: cut marks first (they are thin, so allow a few px)
  if (y >= v.topStrandY - 7 && y <= v.rulerBottom - 4) {
    if (input.markers && y <= v.bottomStrandY + 7) {
      let best: number | null = null;
      let bestDist = 3.5;
      for (const i of view.enzymes.visible) {
        const d = Math.abs(scale.x(input.markers[i].pos) - x);
        if (d <= bestDist) {
          best = i;
          bestDist = d;
        }
      }
      if (best !== null) return { kind: 'enzyme', site: input.markers[best].site };
    }
    if (L > 0 && scale.bp(x) >= 0 && scale.bp(x) <= L) return { kind: 'sequence', position: base };
  }
  return { kind: 'background', position: gap };
}

/**
 * Outline path of a feature at the current zoom (all its visible pieces), widened to at least
 * `minWidth` px, used for the hover / highlight ring. Empty when the feature is not visible.
 */
export function featureOutline(view: ViewModel, set: TrackSet<FeatureEntry>, entryIndex: number, minWidth = 3): string {
  const entry = set.entries[entryIndex];
  if (!entry) return '';
  const L = view.seqLength;
  const top = view.v.features[entry.side][entry.lane] + (METRICS.featureLaneHeight - METRICS.featureBarHeight) / 2;
  if (top === undefined || Number.isNaN(top)) return '';
  let d = '';
  const pieces: Array<{ start: number; end: number; piece: 0 | 1 | 2 }> =
    entry.extent.end > L
      ? [
          { start: entry.extent.start, end: L, piece: 1 },
          { start: 0, end: entry.extent.end - L, piece: 2 },
        ]
      : [{ start: entry.extent.start, end: entry.extent.end, piece: 0 }];
  for (const p of pieces) {
    if (p.end <= view.bpFrom || p.start >= view.bpTo) continue;
    d += featurePieceShape(entry, p, top, { scale: view.scale, width: view.width, seqLength: L }, minWidth).d;
  }
  return d;
}

/** Index (into the track entries) of the feature with this id, or -1. */
export function featureEntryIndex(set: TrackSet<FeatureEntry> | null, id: string | null | undefined): number {
  if (!set || !id) return -1;
  for (let i = 0; i < set.entries.length; i++) if (set.entries[i].feature.id === id) return i;
  return -1;
}
