/**
 * Geometry of the linear map, as pure functions (no DOM), so it can be unit tested and memoized.
 *
 * Two stages:
 *  1. Static tracks (per record and data set, independent of zoom): features, ORFs and primers
 *     are packed into lanes in bp space, so nothing jumps between rows while zooming or panning.
 *     Forward-strand items go above the backbone and reverse-strand ones below it, mirroring
 *     the two strands (strand-less features go above). The strand can then be read at a glance
 *     even where arrow heads are too small to see, and each side stacks only its own lanes.
 *  2. The view model (per frame): what is visible in the current viewport, in px. Everything
 *     is culled to the window; features narrower than a pixel or two either stay visible as
 *     slim solid bars (when they stand alone) or merge into a density band coloured by the
 *     dominant feature type (when crowded); labels go inside bars when they fit, else beside
 *     them, else just outside them (above for the top side, below for the bottom side), else
 *     truncated inside, else they are left to the hover card. A shared occupancy model keeps
 *     every label clear of bars and of other labels. Enzyme labels are staggered into rows.
 *
 * Vertical order, from the top: enzyme labels, primers, ORFs, features, BACKBONE (two strands)
 * and ruler, features, ORFs, primers. Features sit next to the backbone because they are the
 * hero; analysis overlays (ORFs, primers) sit outside them.
 */
import type { Feature, Orf, Primer, PrimerBindingSite, Range, SeqRecord, Topology } from '@hhereditas/core';
import { complement, featureExtent, normalizeRange, splitAtOrigin } from '@hhereditas/core';
import { featureFill } from '../common/colors';
import type { CutMarker, PlacedLabel } from './enzymeLabels';
import { placeEnzymeLabels, rowsUsed } from './enzymeLabels';
import { labelColorOnFill } from './labelColor';
import { LabelSpace } from './labelSpace';
import type { Lane, LaneInterval } from './lanes';
import { buildLanes, packLanes, visibleSpan } from './lanes';
import type { ArrowEnd } from './shapes';
import { barPath, hlinePath, orfPath, primerPath, rectPath, vlinePath } from './shapes';
import type { TextMeasurer } from './textMeasure';
import { truncateToWidth } from './textMeasure';
import type { RulerTicks } from './ticks';
import { formatTick, rulerTicks } from './ticks';
import type { LinearScale } from './viewport';
import { LETTER_PX_PER_BASE } from './viewport';

/** Sizes in px. Font sizes mirror the --hh-text-* tokens used by the stylesheet. */
export const METRICS = {
  padX: 24,
  padTop: 16,
  padBottom: 20,
  enzymeRowHeight: 15,
  enzymeLabelPad: 3,
  enzymeGap: 8,
  featureLaneHeight: 22,
  featureBarHeight: 16,
  featureHead: 7,
  featureRadius: 3.5,
  /** Free band beyond the outermost feature lane, where labels of its small features go. */
  featureLabelBand: 13,
  orfLaneHeight: 11,
  orfThickness: 3,
  orfHead: 7,
  orfHeadHalf: 4,
  primerLaneHeight: 16,
  primerShaft: 2,
  primerHead: 8,
  primerBarb: 4,
  primerFont: 10,
  primerWeight: 500,
  groupGap: 6,
  backboneGap: 9,
  strandGap: 4,
  letterBand: 30,
  /** Letter band of a single-stranded molecule (one row of letters above its line). */
  singleLetterBand: 18,
  rulerHeight: 24,
  labelFont: 11,
  labelWeight: 500,
  enzymeFont: 11,
  /** Weight of unique-cutter labels (matches .enzymeLabelUnique). */
  enzymeUniqueWeight: 600,
  tickFont: 10,
  maxEnzymeRows: 6,
  maxLanes: 24,
} as const;

/** Below this on-screen width (px) a feature is "tiny": a slim solid bar, or density when crowded. */
export const DENSITY_PX = 1.5;
/** Below this width (px) a feature is a plain rectangle (no arrow head, no label inside). */
export const SMALL_PX = 5;
/** Width (px) of a lone tiny feature. */
export const MIN_BAR_PX = 2;
/** Primers are drawn at least this wide (px) so their arrow head stays readable. */
export const PRIMER_MIN_PX = 10;
/** Tiny features closer than this (px) to another tiny feature are drawn as density. */
const ISOLATION_PX = 3;
/**
 * Lone tiny features get labels only while few tiny features are in view: on a plasmid they
 * are worth naming, at whole-genome zoom they are a random sample of thousands of genes.
 */
const MAX_LABELLED_TINY = 150;
/** Glyphs are clipped this far outside the visible area. */
const CLIP = 40;
/** Width (px) of density bins. */
const BIN_PX = 2;
/** Space between a label inside a bar and the bar's ends. */
const INSIDE_PAD = 5;
/** Space between a bar and its own label beside it. */
const BESIDE_GAP = 4;
/** Space between a label and anything that is not its own bar. */
const NEIGHBOUR_GAP = 10;
/** Space between a bar and its label outside it (above / below). */
const OUTWARD_GAP = 1.5;
/** Labels keep this far from the edges of the map. */
const EDGE = 6;
/** A bar needs at least this much of itself on screen (px) to be labelled. */
const MIN_VISIBLE_PX = 1;
/** A truncated label needs at least this much room (px), and keeps at least MIN_TRUNCATED_CHARS characters. */
const MIN_TRUNCATED_PX = 30;
const MIN_TRUNCATED_CHARS = 4;
/** How far cut marks reach beyond the strands (px); leaders stop there. */
export const CUT_OVERSHOOT = 3;
/**
 * With more cuts than this in view, labels would be a random sample of a solid band of cut
 * marks: only unique cutters compete for labels then (zooming in brings the others back).
 */
export const MAX_LABELLED_CUTS = 1500;
/** Density opacity levels (quantized coverage). */
const DENSITY_LEVELS = [0.5, 0.68, 0.84, 1] as const;

export type Side = 'above' | 'below';
const SIDES: readonly Side[] = ['above', 'below'];

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
  /** Normalized segments (multi-segment features are drawn as blocks joined by a line). */
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
   * The non-annealing 5' tail, drawn raised beside the annealed region: left of it for forward
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
  /** Top y of each lane, lane 0 = closest to the backbone. */
  above: number[];
  below: number[];
}

export interface VerticalLayout {
  height: number;
  enzymeRows: number;
  /** Top of the topmost enzyme row; row r (0 = lowest) spans enzymeRowTop(r) .. + rowHeight. */
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

/** Height of the lanes of a track kind. */
export function laneHeight(kind: 'features' | 'orfs' | 'primers'): number {
  return kind === 'features' ? METRICS.featureLaneHeight : kind === 'orfs' ? METRICS.orfLaneHeight : METRICS.primerLaneHeight;
}

/** Top y of the bar drawn in a feature lane. */
export function featureBarTop(v: VerticalLayout, side: Side, lane: number): number {
  return v.features[side][lane] + (METRICS.featureLaneHeight - METRICS.featureBarHeight) / 2;
}

/**
 * Distance between the strand lines for a zoom level: opens smoothly from 5 to 8 px per base to
 * make room for the letters. Single-stranded molecules (RNA, protein) have one line, drawn at
 * the bottom of the band, so their letters sit on it: their band opens from 0.
 */
export function strandGapFor(pxPerBp: number, singleStranded = false): number {
  const lo = LETTER_PX_PER_BASE - 3;
  const t = Math.min(1, Math.max(0, (pxPerBp - lo) / (LETTER_PX_PER_BASE - lo)));
  const s = t * t * (3 - 2 * t);
  const [closed, open] = singleStranded ? [0, METRICS.singleLetterBand] : [METRICS.strandGap, METRICS.letterBand];
  return closed + (open - closed) * s;
}

export function computeVerticalLayout(input: VerticalInput): VerticalLayout {
  const m = METRICS;
  let y = m.padTop;
  const enzymeTop = y;
  y += input.enzymeRows * m.enzymeRowHeight;
  const enzymeBottom = y;
  if (input.enzymeRows > 0) y += m.enzymeGap;
  const aboveStart = y;

  // Above the backbone, outermost group first. Lane 0 of each group is the one nearest the backbone.
  let pendingGap = false;
  const stackAbove = (count: number, h: number): number[] => {
    if (count === 0) return [];
    if (pendingGap) y += m.groupGap;
    const tops: number[] = [];
    for (let k = 0; k < count; k++) tops.push(y + (count - 1 - k) * h);
    y += count * h;
    pendingGap = true;
    return tops;
  };
  const primersAbove = stackAbove(input.primers.above, m.primerLaneHeight);
  const orfsAbove = stackAbove(input.orfs.above, m.orfLaneHeight);
  if (input.features.above > 0) {
    // the free band for labels of the outermost lane also separates features from the overlays
    y += m.featureLabelBand;
    pendingGap = false;
  }
  const featuresAbove = stackAbove(input.features.above, m.featureLaneHeight);
  const anyAbove = y > aboveStart;
  y += m.backboneGap;

  const topStrandY = y;
  y += input.strandGap;
  const bottomStrandY = y;
  y += m.rulerHeight;
  const rulerBottom = y;

  pendingGap = false;
  const stackBelow = (count: number, h: number): number[] => {
    if (count === 0) return [];
    if (pendingGap) y += m.groupGap;
    const tops: number[] = [];
    for (let k = 0; k < count; k++) tops.push(y + k * h);
    y += count * h;
    pendingGap = true;
    return tops;
  };
  const belowStart = y;
  const featuresBelow = stackBelow(input.features.below, m.featureLaneHeight);
  if (input.features.below > 0) {
    y += m.featureLabelBand;
    pendingGap = false;
  }
  const orfsBelow = stackBelow(input.orfs.below, m.orfLaneHeight);
  const primersBelow = stackBelow(input.primers.below, m.primerLaneHeight);
  const anyBelow = y > belowStart;
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
    bodyTop: anyAbove ? aboveStart - 2 : topStrandY - 10,
    bodyBottom,
  };
}

/** Vertical offset of the map content in a pane: centred, a little above the middle. */
export function contentOffsetY(paneHeight: number, contentHeight: number): number {
  return Math.max(0, Math.round((paneHeight - contentHeight) * 0.46));
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

/** 'inside' a bar, 'beside' it in its lane, or 'outside' it (above / below, away from the backbone). */
export type LabelPlacement = 'inside' | 'beside' | 'outside';

export interface FeatureLabel extends TextBox {
  entry: number;
  placement: LabelPlacement;
  /** Text colour of a label inside its bar (contrasting with the bar's fill); null outside. */
  onFill: string | null;
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
  /** Leader from the label to the backbone. */
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
  /** x extent of the top strand line (the only line of a single-stranded molecule), and its y. */
  top: [number, number] | null;
  topY: number;
  /** x extent of the bottom strand line (DNA only), and its y. */
  bottom: [number, number] | null;
  bottomY: number;
  /** Dashed continuations beyond the record ends of a circular record. */
  continuation: string | null;
  /** RNA / protein: one line, at the bottom of the letter band (letters sit on it). */
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
  /** Features whose labels are placed first (highlighted / selected ones). */
  pinnedFeatureIds?: ReadonlySet<string>;
}

export interface ViewModel {
  width: number;
  height: number;
  scale: LinearScale;
  v: VerticalLayout;
  seqLength: number;
  topology: Topology;
  /** bp range covered by the drawing (the visible window plus a margin; may extend beyond the record). */
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
    /** Cut marks across the backbone: labelled cuts, and cuts whose label did not fit. */
    ticks: string;
    ticksUnlabelled: string;
    /** Staggered cuts between the strands (letter zoom). */
    staggered: string;
    leaders: string;
    labels: EnzymeLabel[];
    /** Indices (into markers) of the visible markers, for hit-testing. */
    visible: number[];
  };
}

const labelWidthCache = new WeakMap<readonly CutMarker[], { measure: TextMeasurer; widths: Float64Array }>();

/** Width (px) of each marker's label box (padding included), measured once per marker set. */
function enzymeLabelWidths(markers: readonly CutMarker[], measure: TextMeasurer): Float64Array {
  const hit = labelWidthCache.get(markers);
  if (hit && hit.measure === measure) return hit.widths;
  const widths = new Float64Array(markers.length);
  for (let i = 0; i < markers.length; i++) {
    const mk = markers[i];
    widths[i] = METRICS.enzymeLabelPad + measure(mk.label, METRICS.enzymeFont, mk.unique ? METRICS.enzymeUniqueWeight : 400);
  }
  labelWidthCache.set(markers, { measure, widths });
  return widths;
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
  // so many cuts that zoomed-in views will need every row
  if (markers.length > MAX_LABELLED_CUTS) return maxRows;
  const k = plotWidth / seqLength;
  const widths = enzymeLabelWidths(markers, measure);
  const boxes = markers.map((mk, i) => ({ x: plotLeft + mk.pos * k, width: widths[i], priority: mk.unique ? 1 : 0 }));
  return Math.max(1, rowsUsed(placeEnzymeLabels(boxes, { maxRows, minX: EDGE, maxX: width - EDGE })));
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
 * where a label can go inside.
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
    // a piece that starts / ends inside an intron (the join continues across the origin)
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

/** Visible px width of [start, end). */
function visibleWidth(start: number, end: number, scale: LinearScale, width: number): number {
  return Math.max(0, Math.min(width, scale.x(end)) - Math.max(0, scale.x(start)));
}

/**
 * Whether a lane item carries the item's label. A range that wraps the origin is drawn as two
 * pieces; only the one with more visible width is labelled.
 */
function isLabelPiece(extent: Range, piece: 0 | 1 | 2, L: number, scale: LinearScale, width: number): boolean {
  if (piece === 0) return true;
  const tail = visibleWidth(extent.start, L, scale, width);
  const head = visibleWidth(0, extent.end - L, scale, width);
  return piece === 1 ? tail >= head : head > tail;
}

/** Occupancy row of a feature lane (`lane === count` is the free band beyond the outermost lane). */
function featureRowKey(side: Side, lane: number): string {
  return `f:${side}:${lane}`;
}

interface FeatureLabelCandidate {
  ref: number;
  piece: 0 | 1 | 2;
  side: Side;
  lane: number;
  /** Drawn bar extent (px). */
  x0: number;
  x1: number;
  /** Room for a label inside the bar (px, visible part); empty when bodyR <= bodyL. */
  bodyL: number;
  bodyR: number;
  barTop: number;
  priority: number;
}

function appendPath(map: Map<string, string>, key: string, d: string): void {
  map.set(key, (map.get(key) ?? '') + d);
}

/** Density level (index into DENSITY_LEVELS) of a coverage fraction. */
function densityLevel(coverage: number): number {
  return Math.min(DENSITY_LEVELS.length - 1, Math.max(0, Math.ceil(Math.min(1, coverage) * DENSITY_LEVELS.length) - 1));
}

function layoutFeatures(
  set: TrackSet<FeatureEntry>,
  v: VerticalLayout,
  ctx: LaneContext,
  out: ViewModel['features'],
  space: LabelSpace,
  pinned: ReadonlySet<string> | undefined,
): void {
  const { scale, width, bpFrom, bpTo, measure, seqLength: L } = ctx;
  const m = METRICS;
  const barH = m.featureBarHeight;
  const nBins = Math.max(1, Math.ceil(width / BIN_PX));
  const smallByFill = new Map<string, string>();
  const densityByKey = new Map<string, { fill: string; level: number; d: string }>();
  const fills: string[] = [];
  const fillIndex = new Map<string, number>();
  const indexOfFill = (fill: string): number => {
    let i = fillIndex.get(fill);
    if (i === undefined) {
      i = fills.length;
      fills.push(fill);
      fillIndex.set(fill, i);
    }
    return i;
  };
  const candidates: FeatureLabelCandidate[] = [];
  const tinyCandidates: FeatureLabelCandidate[] = [];
  let tinyCount = 0;

  for (const side of SIDES) {
    const lanes = set[side];
    for (let lane = 0; lane < lanes.length; lane++) {
      const { items } = lanes[lane];
      const [i0, i1] = visibleSpan(lanes[lane], bpFrom, bpTo);
      if (i0 >= i1) continue;
      const top = featureBarTop(v, side, lane);
      const row = space.row(featureRowKey(side, lane));
      const tiny: Array<{ x0: number; x1: number; ref: number; piece: 0 | 1 | 2 }> = [];

      for (let i = i0; i < i1; i++) {
        const it = items[i];
        if (it.end <= bpFrom || it.start >= bpTo) continue;
        const entry = set.entries[it.ref];
        const x0 = scale.x(it.start);
        const x1 = scale.x(it.end);
        const w = x1 - x0;
        if (w < DENSITY_PX) {
          tiny.push({ x0, x1, ref: it.ref, piece: it.piece });
          continue;
        }
        let bodyL = 0;
        let bodyR = 0;
        if (w < SMALL_PX) {
          appendPath(smallByFill, entry.fill, rectPath(x0, top, w, barH));
        } else {
          const shape = featurePieceShape(entry, it, top, ctx);
          out.glyphs.push({ key: `${entry.feature.id}:${it.piece}`, entry: it.ref, d: shape.d, connector: shape.connector, fill: entry.fill });
          bodyL = shape.bodyL;
          bodyR = shape.bodyR;
        }
        row.add(Math.max(-CLIP, x0), Math.min(width + CLIP, x1));
        // Only bars that are on screen get a label (bars in the off-screen margin are drawn
        // so panning reveals them seamlessly, but a label there would float detached at the edge).
        const vis = Math.min(width, x1) - Math.max(0, x0);
        if (vis >= MIN_VISIBLE_PX && isLabelPiece(entry.extent, it.piece, L, scale, width)) {
          candidates.push({
            ref: it.ref,
            piece: it.piece,
            side,
            lane,
            x0,
            x1,
            bodyL,
            bodyR,
            barTop: top,
            priority: (pinned?.has(entry.feature.id) ? 1e9 : 0) + vis,
          });
        }
      }

      if (tiny.length === 0) continue;
      tinyCount += tiny.length;
      // Lone tiny features stay visible as slim solid bars; crowded ones become density.
      let cov: Float32Array | null = null;
      let dom: Int32Array | null = null;
      let domAmount: Float32Array | null = null;
      let prevEnd = -Infinity;
      for (let k = 0; k < tiny.length; k++) {
        const t = tiny[k];
        const nextStart = k + 1 < tiny.length ? tiny[k + 1].x0 : Infinity;
        const isolated = t.x0 - prevEnd >= ISOLATION_PX && nextStart - t.x1 >= ISOLATION_PX;
        prevEnd = Math.max(prevEnd, t.x1);
        const entry = set.entries[t.ref];
        if (isolated) {
          const c = (t.x0 + t.x1) / 2;
          const a = c - MIN_BAR_PX / 2;
          appendPath(smallByFill, entry.fill, rectPath(a, top, MIN_BAR_PX, barH));
          row.add(a, a + MIN_BAR_PX);
          const onScreen = Math.min(width, a + MIN_BAR_PX) - Math.max(0, a) >= MIN_VISIBLE_PX;
          if (onScreen && isLabelPiece(entry.extent, t.piece, L, scale, width)) {
            tinyCandidates.push({
              ref: t.ref,
              piece: t.piece,
              side,
              lane,
              x0: a,
              x1: a + MIN_BAR_PX,
              bodyL: 0,
              bodyR: 0,
              barTop: top,
              priority: pinned?.has(entry.feature.id) ? 1e9 : 0,
            });
          }
          continue;
        }
        cov ??= new Float32Array(nBins);
        dom ??= new Int32Array(nBins).fill(-1);
        domAmount ??= new Float32Array(nBins);
        const a = Math.max(0, t.x0);
        const b = Math.min(width, Math.max(t.x1, t.x0 + 0.25));
        const fi = indexOfFill(entry.fill);
        for (let bin = Math.max(0, Math.floor(a / BIN_PX)); bin < nBins && bin * BIN_PX < b; bin++) {
          const overlap = Math.min(b, (bin + 1) * BIN_PX) - Math.max(a, bin * BIN_PX);
          if (overlap <= 0) continue;
          const f = overlap / BIN_PX;
          cov[bin] += f;
          if (f > domAmount[bin]) {
            domAmount[bin] = f;
            dom[bin] = fi;
          }
        }
        row.add(a, b);
        // A pinned (highlighted / selected) feature inside a density band still competes for a
        // label: the highlight ring shows where it is, the label says what it is.
        if (pinned?.has(entry.feature.id) && isLabelPiece(entry.extent, t.piece, L, scale, width)) {
          const c = (t.x0 + t.x1) / 2;
          if (Math.min(width, c + MIN_BAR_PX / 2) - Math.max(0, c - MIN_BAR_PX / 2) >= MIN_VISIBLE_PX) {
            tinyCandidates.push({
              ref: t.ref,
              piece: t.piece,
              side,
              lane,
              x0: c - MIN_BAR_PX / 2,
              x1: c + MIN_BAR_PX / 2,
              bodyL: 0,
              bodyR: 0,
              barTop: top,
              priority: 1e9,
            });
          }
        }
      }
      if (cov && dom) {
        let b = 0;
        while (b < nBins) {
          if (cov[b] <= 0.001 || dom[b] < 0) {
            b++;
            continue;
          }
          const level = densityLevel(cov[b]);
          const fi = dom[b];
          let e = b + 1;
          while (e < nBins && cov[e] > 0.001 && dom[e] === fi && densityLevel(cov[e]) === level) e++;
          const key = `${fi}:${level}`;
          const path = densityByKey.get(key) ?? { fill: fills[fi], level, d: '' };
          path.d += rectPath(b * BIN_PX, top, (e - b) * BIN_PX, barH);
          densityByKey.set(key, path);
          b = e;
        }
      }
    }
  }

  for (const [fill, d] of smallByFill) out.small.push({ key: `small:${fill}`, d, fill, opacity: 1 });
  for (const [key, p] of densityByKey) out.density.push({ key: `density:${key}`, d: p.d, fill: p.fill, opacity: DENSITY_LEVELS[p.level] });

  // Labels, most important first: pinned features, then the widest bars.
  for (const c of tinyCandidates) if (tinyCount <= MAX_LABELLED_TINY || c.priority > 0) candidates.push(c);
  candidates.sort((a, b) => b.priority - a.priority || a.x0 - b.x0);
  const font = m.labelFont;
  const weight = m.labelWeight;
  const widthOf = (s: string) => measure(s, font, weight);
  for (const c of candidates) {
    const entry = set.entries[c.ref];
    const name = entry.feature.name;
    if (!name) continue;
    const tw = widthOf(name);
    const cy = c.barTop + barH / 2;
    const key = `${entry.feature.id}:${c.piece}:label`;
    const push = (text: string, left: number, textW: number, y: number, placement: LabelPlacement) => {
      out.labels.push({
        key,
        entry: c.ref,
        text,
        x: left + textW / 2,
        y,
        anchor: 'middle',
        left,
        right: left + textW,
        top: y - font / 2 - 1,
        bottom: y + font / 2 + 1,
        placement,
        onFill: placement === 'inside' ? labelColorOnFill(entry.fill) : null,
      });
    };
    const room = c.bodyR - c.bodyL - 2 * INSIDE_PAD;
    if (tw <= room) {
      push(name, (c.bodyL + c.bodyR) / 2 - tw / 2, tw, cy, 'inside');
      continue;
    }
    const row = space.row(featureRowKey(c.side, c.lane));
    // beside, right of the bar, then left of it
    const rl = c.x1 + BESIDE_GAP;
    if (rl >= EDGE && rl + tw <= width - EDGE && row.isFree(rl, rl + tw + NEIGHBOUR_GAP)) {
      push(name, rl, tw, cy, 'beside');
      row.add(rl, rl + tw);
      continue;
    }
    const ll = c.x0 - BESIDE_GAP - tw;
    if (ll >= EDGE && ll + tw <= width - EDGE && row.isFree(ll - NEIGHBOUR_GAP, ll + tw)) {
      push(name, ll, tw, cy, 'beside');
      row.add(ll, ll + tw);
      continue;
    }
    // outside: above the bar (top side) or below it (bottom side), centred on its visible part;
    // kept over the bar so it never reads as the label of a neighbour
    const outer = space.row(featureRowKey(c.side, c.lane + 1));
    const visL = Math.max(0, c.x0);
    const visR = Math.min(width, c.x1);
    const ol = Math.min(width - EDGE - tw, Math.max(EDGE, (visL + visR) / 2 - tw / 2));
    const oy = c.side === 'above' ? c.barTop - OUTWARD_GAP - font / 2 - 1 : c.barTop + barH + OUTWARD_GAP + font / 2 + 1;
    const overBar = ol < visR && ol + tw > visL;
    if (ol >= EDGE && overBar && outer.isFree(ol - NEIGHBOUR_GAP, ol + tw + NEIGHBOUR_GAP)) {
      push(name, ol, tw, oy, 'outside');
      outer.add(ol, ol + tw);
      continue;
    }
    if (room >= MIN_TRUNCATED_PX) {
      const text = truncateToWidth(name, room, widthOf);
      // "fro…" says little: keep a truncated label only if enough of the name survives
      if (text && text.length - 1 >= Math.min(MIN_TRUNCATED_CHARS, name.length - 1)) {
        const w = widthOf(text);
        push(text, (c.bodyL + c.bodyR) / 2 - w / 2, w, cy, 'inside');
      }
    }
  }
}

function layoutOrfs(set: TrackSet<OrfEntry>, v: VerticalLayout, ctx: LaneContext, out: ViewModel['orfs']): void {
  const { scale, width, bpFrom, bpTo, seqLength: L } = ctx;
  const m = METRICS;
  let small = '';
  for (const side of SIDES) {
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
          const w = Math.max(1, x1 - x0);
          small += rectPath((x0 + x1) / 2 - w / 2, cy - m.orfThickness / 2, w, m.orfThickness);
          continue;
        }
        const dir = entry.orf.strand;
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

/** Drawn x extent of a primer piece: its annealed part widened to PRIMER_MIN_PX. */
export function primerGlyphExtent(x0: number, x1: number): [number, number] {
  if (x1 - x0 >= PRIMER_MIN_PX) return [x0, x1];
  const c = (x0 + x1) / 2;
  return [c - PRIMER_MIN_PX / 2, c + PRIMER_MIN_PX / 2];
}

function layoutPrimers(
  set: TrackSet<PrimerEntry>,
  v: VerticalLayout,
  ctx: LaneContext,
  out: ViewModel['primers'],
  space: LabelSpace,
): void {
  const { scale, width, bpFrom, bpTo, measure, seqLength: L } = ctx;
  const m = METRICS;
  const candidates: Array<{ ref: number; piece: 0 | 1 | 2; side: Side; lane: number; x0: number; x1: number; cy: number; dir: 1 | -1 }> = [];
  for (const side of SIDES) {
    const lanes = set[side];
    for (let lane = 0; lane < lanes.length; lane++) {
      const { items } = lanes[lane];
      const [i0, i1] = visibleSpan(lanes[lane], bpFrom, bpTo);
      // the shaft sits a little towards the backbone; the barb and tail rise away from it
      const cy = v.primers[side][lane] + m.primerLaneHeight / 2 + (side === 'above' ? 2 : -2);
      const row = space.row(`p:${side}:${lane}`);
      for (let i = i0; i < i1; i++) {
        const it = items[i];
        if (it.end <= bpFrom || it.start >= bpTo) continue;
        const entry = set.entries[it.ref];
        const dir = entry.site.strand;
        const ann = entry.annealed;
        // 3' end of the primer in [0, L]: right end of a forward primer, left end of a reverse one
        const end3 = dir === 1 ? (ann.end > L ? ann.end - L : ann.end) : ann.start;

        let d = '';
        let gx0 = Infinity;
        let gx1 = -Infinity;
        for (const ap of piecesOf(ann, L)) {
          const s = Math.max(ap.start, it.start);
          const e = Math.min(ap.end, it.end);
          if (e <= s) continue;
          const tip = dir === 1 ? e === end3 : s === end3;
          let [x0, x1] = [scale.x(s), scale.x(e)];
          // only the piece with the arrow head is widened (a cut-off piece is just a shaft)
          if (tip) [x0, x1] = primerGlyphExtent(x0, x1);
          else if (x1 - x0 < 1.5) [x0, x1] = [(x0 + x1) / 2 - 0.75, (x0 + x1) / 2 + 0.75];
          const showTip = tip && (dir === 1 ? x1 <= width + CLIP : x0 >= -CLIP);
          const cx0 = Math.max(-CLIP, x0);
          const cx1 = Math.min(width + CLIP, x1);
          if (cx1 <= cx0) continue;
          d += showTip
            ? primerPath(cx0, cx1, cy, dir, m.primerShaft, m.primerHead, m.primerBarb)
            : rectPath(cx0, cy - m.primerShaft / 2, cx1 - cx0, m.primerShaft);
          gx0 = Math.min(gx0, cx0);
          gx1 = Math.max(gx1, cx1);
        }

        let tail: string | null = null;
        if (entry.tail) {
          const s = Math.max(entry.tail.start, it.start);
          const e = Math.min(entry.tail.end, it.end);
          const x0 = Math.max(-CLIP, scale.x(s));
          const x1 = Math.min(width + CLIP, scale.x(e));
          if (e > s && x1 - x0 >= 3) {
            const ty = cy + (dir === 1 ? -3.5 : 3.5);
            // a short diagonal joins the raised tail to the shaft where annealing starts
            if (dir === 1) {
              const joined = e === entry.tail.end;
              const end = joined ? Math.min(x1, gx0 === Infinity ? x1 : gx0) : x1;
              tail = joined ? `M${fmt(x0)} ${fmt(ty)}H${fmt(Math.max(x0, end - 2.5))}L${fmt(end)} ${fmt(cy)}` : hlinePath(x0, x1, ty);
            } else {
              const joined = s === entry.tail.start;
              const start = joined ? Math.max(x0, gx1 === -Infinity ? x0 : gx1) : x0;
              tail = joined ? `M${fmt(x1)} ${fmt(ty)}H${fmt(Math.min(x1, start + 2.5))}L${fmt(start)} ${fmt(cy)}` : hlinePath(x0, x1, ty);
            }
            gx0 = Math.min(gx0, x0);
            gx1 = Math.max(gx1, x1);
          }
        }
        if (!d && !tail) continue;
        out.glyphs.push({ key: `primer:${it.ref}:${it.piece}`, entry: it.ref, d, tail, dir });
        row.add(gx0, gx1);
        // a primer that wraps the origin is labelled on the piece holding its 3' end
        if (it.piece === 0 || it.piece === (dir === 1 ? 2 : 1)) {
          candidates.push({ ref: it.ref, piece: it.piece, side, lane, x0: gx0, x1: gx1, cy, dir });
        }
      }
    }
  }

  candidates.sort((a, b) => a.x0 - b.x0);
  const font = m.primerFont;
  for (const c of candidates) {
    const entry = set.entries[c.ref];
    if (!entry.name) continue;
    const tw = measure(entry.name, font, m.primerWeight);
    const row = space.row(`p:${c.side}:${c.lane}`);
    const right = (): number | null => {
      const l = c.x1 + BESIDE_GAP;
      return l >= EDGE && l + tw <= width - EDGE && row.isFree(l, l + tw + NEIGHBOUR_GAP) ? l : null;
    };
    const left = (): number | null => {
      const l = c.x0 - BESIDE_GAP - tw;
      return l >= EDGE && l + tw <= width - EDGE && row.isFree(l - NEIGHBOUR_GAP, l + tw) ? l : null;
    };
    // the name goes on the 3' side first (right of a forward primer, left of a reverse one)
    const l = c.dir === 1 ? (right() ?? left()) : (left() ?? right());
    if (l === null) continue;
    row.add(l, l + tw);
    out.labels.push({
      key: `primer:${c.ref}:${c.piece}:label`,
      entry: c.ref,
      dir: c.dir,
      text: entry.name,
      x: l + tw / 2,
      y: c.cy,
      anchor: 'middle',
      left: l,
      right: l + tw,
      top: c.cy - font / 2 - 1,
      bottom: c.cy + font / 2 + 1,
    });
  }
}

/** Horizontal clearance (px) between a leader and a label it passes. */
const LEADER_CLEARANCE = 2;

/**
 * Vertical leader at x from y0 down to y1, interrupted where it would cross a label box
 * (with LEADER_CLEARANCE around it).
 */
export function leaderPath(x: number, y0: number, y1: number, obstacles: readonly TextBox[]): string {
  let skips: Array<[number, number]> | null = null;
  for (const b of obstacles) {
    if (x < b.left - LEADER_CLEARANCE || x > b.right + LEADER_CLEARANCE) continue;
    if (b.bottom + 1 <= y0 || b.top - 1 >= y1) continue;
    (skips ??= []).push([b.top - 1, b.bottom + 1]);
  }
  if (!skips) return vlinePath(x, y0, y1);
  skips.sort((a, b) => a[0] - b[0]);
  let d = '';
  let y = y0;
  for (const [a, b] of skips) {
    if (a > y) d += vlinePath(x, y, Math.min(a, y1));
    y = Math.max(y, b);
    if (y >= y1) break;
  }
  if (y < y1) d += vlinePath(x, y, y1);
  return d;
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

  const placed: Array<PlacedLabel | null> = visible.map(() => null);
  if (v.enzymeRows > 0) {
    const widths = enzymeLabelWidths(markers, measure);
    const dense = visible.length > MAX_LABELLED_CUTS;
    const candidates: number[] = [];
    for (let j = 0; j < visible.length; j++) if (!dense || markers[visible[j]].unique) candidates.push(j);
    const result = placeEnzymeLabels(
      candidates.map((j) => {
        const mk = markers[visible[j]];
        return { x: scale.x(mk.pos), width: widths[visible[j]], priority: mk.unique ? 1 : 0 };
      }),
      { maxRows: v.enzymeRows, minX: EDGE, maxX: width - EDGE },
    );
    candidates.forEach((j, k) => {
      placed[j] = result[k];
    });
  }

  // Cut marks across the backbone; at letter zoom the staggered cut between the strands.
  let ticks = '';
  let ticksUnlabelled = '';
  let staggered = '';
  const drawn = new Set<number>();
  const yTop = v.topStrandY - CUT_OVERSHOOT;
  const yBottom = v.bottomStrandY + CUT_OVERSHOOT;
  visible.forEach((i, j) => {
    const mk = markers[i];
    const x = Math.round(scale.x(mk.pos) * 2) / 2;
    if (letterZoom && mk.cuts) {
      const xb = Math.round(scale.x(mk.bottom) * 2) / 2;
      const yMid = (v.topStrandY + v.bottomStrandY) / 2;
      staggered += `M${fmt(x)} ${fmt(v.topStrandY - 3)}V${fmt(yMid)}H${fmt(xb)}V${fmt(v.bottomStrandY + 3)}`;
      return;
    }
    const key = Math.round(x * 2);
    if (placed[j]) ticks += vlinePath(x, yTop, yBottom);
    else if (!drawn.has(key)) ticksUnlabelled += vlinePath(x, yTop, yBottom);
    drawn.add(key);
  });
  view.enzymes.ticks = ticks;
  view.enzymes.ticksUnlabelled = ticksUnlabelled;
  view.enzymes.staggered = staggered;

  // Leaders run down to the backbone behind the feature lanes (bars cover them) and stop short
  // of the labels they pass, so labels need no halo and the selection band behind the map stays
  // one even colour.
  const obstacles: TextBox[] = [];
  for (const l of view.features.labels) if (l.placement !== 'inside') obstacles.push(l);
  for (const l of view.primers.labels) obstacles.push(l);
  let leaders = '';
  placed.forEach((p, j) => {
    if (!p) return;
    const i = visible[j];
    const mk = markers[i];
    const x = Math.round(p.x * 2) / 2;
    const rowTop = enzymeRowTop(v, p.row);
    const cy = rowTop + m.enzymeRowHeight / 2;
    const leader = leaderPath(x, cy + 2, v.topStrandY - CUT_OVERSHOOT, obstacles);
    leaders += leader;
    const textW = p.right - p.left - m.enzymeLabelPad;
    const textLeft = p.align === 'start' ? x + m.enzymeLabelPad : x - m.enzymeLabelPad - textW;
    view.enzymes.labels.push({
      key: `e${i}`,
      marker: i,
      unique: mk.unique,
      text: mk.label,
      x: textLeft,
      y: cy,
      anchor: 'start',
      left: p.left,
      right: p.right,
      top: rowTop + 1,
      bottom: rowTop + m.enzymeRowHeight - 1,
      leader,
    });
  });
  view.enzymes.leaders = leaders;
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
  // DNA reads as a double strand; RNA and protein as a single line.
  const isDna = record.molecule === 'DNA';
  const v = computeVerticalLayout({
    enzymeRows: input.markers && input.markers.length > 0 ? input.enzymeRows : 0,
    features: count(input.features),
    orfs: count(input.orfs),
    primers: count(input.primers),
    strandGap: strandGapFor(k, !isDna),
  });
  // A single-stranded molecule's line runs under its letters (at the bottom of the band).
  const lineY = isDna ? v.topStrandY : v.bottomStrandY;

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
    // A few short dashes beyond each end say "the molecule continues round".
    const ys = isDna ? [v.topStrandY, v.bottomStrandY] : [lineY];
    const xs = scale.x(0);
    const xe = scale.x(L);
    let c = '';
    for (const y of ys) {
      if (xs > 4) for (let d = 3; d <= 13; d += 5) c += hlinePath(xs - d - 2.5, xs - d, y);
      if (xe < width - 4) for (let d = 3; d <= 13; d += 5) c += hlinePath(xe + d, xe + d + 2.5, y);
    }
    continuation = c || null;
  }
  const backbone: BackboneModel = {
    top: strand(ext.top),
    topY: lineY,
    bottom: isDna ? strand(ext.bottom) : null,
    bottomY: v.bottomStrandY,
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
      // DNA: the two rows between the strand lines; otherwise one row centred in the band
      topY: v.topStrandY + (v.bottomStrandY - v.topStrandY) * (isDna ? 0.29 : 0.5),
      bottomY: v.topStrandY + (v.bottomStrandY - v.topStrandY) * 0.71,
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
    enzymes: { ticks: '', ticksUnlabelled: '', staggered: '', leaders: '', labels: [], visible: [] },
  };
  const space = new LabelSpace();
  if (input.features) layoutFeatures(input.features, v, ctx, view.features, space, input.pinnedFeatureIds);
  if (input.orfs) layoutOrfs(input.orfs, v, ctx, view.orfs);
  if (input.primers) layoutPrimers(input.primers, v, ctx, view.primers, space);
  if (input.markers && input.markers.length > 0) layoutEnzymes(input.markers, v, ctx, view, letters !== null);
  return view;
}
