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
 * Vertical order, from the top: enzyme labels, primer labels (forward primers), features,
 * [alignments], primers, BACKBONE (two strands), primers, ruler, features, primer labels
 * (reverse primers). The forward primers lie right on the upper strand and the reverse ones right under the
 * lower one, then the ruler numbers and the features below. The ORFs lie over the space of the primers, at a fixed
 * distance from the DNA above and below it. Primer labels
 * stand at the far ends with a leader to the end where each primer starts.
 */
import type { AlignedSequence, Feature, Orf, Primer, PrimerBindingSite, Range, SeqRecord, Topology } from '@hhereditas/core';
import { complement, featureExtent, featureLength, normalizeRange, reverseComplement, splitAtOrigin } from '@hhereditas/core';
import { featureFill } from '../common/colors';
import { formatInt } from '../common/format';
import type { CutMarker, PlacedLabel } from './enzymeLabels';
import { placeEnzymeLabels, rowsUsed } from './enzymeLabels';
import { labelColorOnFill } from './labelColor';
import { LabelSpace } from './labelSpace';
import type { Lane, LaneInterval } from './lanes';
import { buildLanes, packLanes, visibleSpan } from './lanes';
import type { ArrowEnd } from './shapes';
import { barPath, hlinePath, orfPath, rectPath, vlinePath } from './shapes';
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
  featureLaneHeight: 31,
  featureBarHeight: 16,
  featureHead: 7,
  featureRadius: 3.5,
  /** Free band beyond the outermost feature lane, where labels of its small features go (2 staggered rows). */
  featureLabelBand: 31,
  /** Row height of the outside feature labels (rows with a leader line in the band beyond the outermost lane). */
  featureLabelRowHeight: 13,
  /** Most rows of outside feature labels reserved on each side. */
  maxFeatureLabelRows: 10,
  orfLaneHeight: 9,
  /** Distance from the DNA strand to the near edge of the first ORF lane (the same above and below). */
  orfNear: 5,
  /** Space the ORF lanes claim from the strand when the other tracks are laid out (they do not move with `orfNear`). */
  orfReserve: 11,
  orfThickness: 3,
  orfHead: 7,
  orfHeadHalf: 4,
  primerLaneHeight: 8,
  /** Gap between the primer lanes and the lanes next to them (smaller than groupGap: primers hug the DNA). */
  primerGap: 3,
  primerShaft: 2,
  primerHead: 8,
  primerBarb: 4,
  primerFont: 10,
  primerWeight: 500,
  /** Most rows of primer labels reserved above / below the primer lanes. */
  maxPrimerLabelRows: 6,
  alignmentLaneHeight: 15,
  alignmentBandPad: 4,
  groupGap: 6,
  backboneGap: 10,
  strandGap: 4,
  letterBand: 30,
  /** Letter band of a single-stranded molecule (one row of letters above its line). */
  singleLetterBand: 18,
  rulerHeight: 12,
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

export interface AlignmentEntry extends TrackEntryBase {
  alignedSeq: AlignedSequence;
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

export function buildAlignmentTrack(
  alignedSequences: readonly AlignedSequence[] | undefined,
  seqLength: number,
  topology: Topology,
  maxLanes = 6,
): TrackSet<AlignmentEntry> | null {
  if (!alignedSequences || alignedSequences.length === 0 || seqLength <= 0) return null;
  const entries: AlignmentEntry[] = [];
  for (const item of alignedSequences) {
    if (!item.aligned || !item.visible) continue;
    // the arrow covers the whole read: the aligned part plus the unaligned tails on both sides
    let start = item.refRange.start - item.leftTail;
    let end = item.refRange.end + item.rightTail;
    if (topology === 'circular') {
      if (start < 0) {
        start += seqLength;
        end += seqLength;
      }
      end = Math.min(end, start + seqLength);
    } else {
      start = Math.max(0, start);
      end = Math.min(seqLength, end);
    }
    const extent = cleanRange({ start, end }, seqLength, topology);
    if (!extent) continue;
    // All aligned sequences are packed above the backbone in the SnapGene warm-amber alignment band
    entries.push({ alignedSeq: item, extent, side: 'above', lane: 0 });
  }
  if (entries.length === 0) return null;
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
  /** Rows of outside feature labels (with leaders) above / below the outermost feature lane; 2 when not given. */
  featureLabelRows?: { above: number; below: number };
  /** Rows of primer labels reserved above the primer lanes (forward primers) and below them (reverse primers). */
  primerLabelRows?: { above: number; below: number };
  features: LaneCounts;
  orfs: LaneCounts;
  primers: LaneCounts;
  alignmentLanes?: number;
  /** Share (0..1) of the alignment band's height that is opened in the layout, for animating it in and out; 1 when
   *  not given. The band keeps its full height and position; only the space made for it shrinks. */
  alignmentSpace?: number;
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
  /** Rows of outside feature labels reserved above / below the outermost feature lane. */
  featureLabelRows: { above: number; below: number };
  /** Rows of primer labels: forward primers above their lanes, reverse ones below; row 0 is the one next to the lanes. */
  primerLabels: { above: PrimerLabelBand; below: PrimerLabelBand };
  features: BandTops;
  orfs: BandTops;
  primers: BandTops;
  alignmentBandTop: number;
  alignmentBandHeight: number;
  alignmentLanesTop: number[];
  topStrandY: number;
  bottomStrandY: number;
  /** Top of the ruler: right under the lower strand. */
  rulerTop: number;
  rulerBottom: number;
  /** Vertical extent of the selection band. */
  bodyTop: number;
  bodyBottom: number;
  /** Vertical extent of a selection band: the strands and the ruler numbers, with a band as tall as the numbers above the strands. */
  selectionTop: number;
  selectionBottom: number;
}

export interface PrimerLabelBand {
  top: number;
  bottom: number;
  rows: number;
}

/** Top y of a row of primer labels. */
export function primerLabelRowTop(v: VerticalLayout, side: Side, row: number): number {
  const band = v.primerLabels[side];
  return side === 'above' ? band.bottom - (row + 1) * METRICS.enzymeRowHeight : band.top + row * METRICS.enzymeRowHeight;
}

/** Height of the free band for `rows` rows of outside feature labels (31 px for the default two rows). */
export function featureLabelBandFor(rows: number): number {
  return 5 + rows * METRICS.featureLabelRowHeight;
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
  const featureLabelRows = input.featureLabelRows ?? { above: 2, below: 2 };
  let y: number = m.padTop;
  const enzymeTop = y;
  y += input.enzymeRows * m.enzymeRowHeight;
  const enzymeBottom = y;
  if (input.enzymeRows > 0) y += m.enzymeGap;
  const labelRowsAbove = input.primerLabelRows?.above ?? 0;
  const primerLabelsAboveTop = y;
  y += labelRowsAbove * m.enzymeRowHeight;
  const primerLabelsAboveBottom = y;
  if (labelRowsAbove > 0) y += m.enzymeGap;
  const aboveStart = y;

  // Above the backbone, outermost group first. Lane 0 of each group is the one nearest the backbone.
  let pendingGap = false;
  const stackAbove = (count: number, h: number, gap: number = m.groupGap): number[] => {
    if (count === 0) return [];
    if (pendingGap) y += gap;
    const tops: number[] = [];
    for (let k = 0; k < count; k++) tops.push(y + (count - 1 - k) * h);
    y += count * h;
    pendingGap = true;
    return tops;
  };
  if (input.features.above > 0) {
    // the free band for labels of the outermost lane also separates features from the overlays
    y += featureLabelBandFor(featureLabelRows.above);
    pendingGap = false;
  }
  const featuresAbove = stackAbove(input.features.above, m.featureLaneHeight);
  const alnLanes = input.alignmentLanes ?? 0;
  let alignmentBandTop = y;
  let alignmentBandHeight = 0;
  const alignmentLanesTop: number[] = [];
  const alnSpace = Math.max(0, Math.min(1, input.alignmentSpace ?? 1));
  if (alnLanes > 0 && alnSpace > 0) {
    // with the band the layout grows by its height and one group gap; a partly opened band grows it by that share
    const gapBefore = pendingGap ? m.groupGap : 0;
    alignmentBandTop = y + gapBefore;
    alignmentBandHeight = alnLanes * m.alignmentLaneHeight + 2 * m.alignmentBandPad;
    for (let k = 0; k < alnLanes; k++) {
      alignmentLanesTop.push(alignmentBandTop + m.alignmentBandPad + (alnLanes - 1 - k) * m.alignmentLaneHeight);
    }
    if (alnSpace >= 1) {
      y = alignmentBandTop + alignmentBandHeight;
      pendingGap = true;
    } else {
      y += alnSpace * (alignmentBandHeight + m.groupGap);
    }
  }
  // The ORFs are not stacked with the primers: they lie at a fixed distance from the DNA on both sides, over the
  // space of the primer lanes, so make sure the space above the strand is deep enough for them.
  const orfZoneAbove = input.orfs.above > 0 ? m.orfReserve + input.orfs.above * m.orfLaneHeight + 2 : 0;
  const abovePad = input.primers.above > 0 ? 1 : alnLanes > 0 ? 4 : m.backboneGap;
  const orfExtraAbove = orfZoneAbove - abovePad - input.primers.above * m.primerLaneHeight;
  if (orfExtraAbove > (pendingGap && input.primers.above > 0 ? m.primerGap : 0)) {
    y += orfExtraAbove;
    pendingGap = false;
  }
  const primersAbove = stackAbove(input.primers.above, m.primerLaneHeight, m.primerGap);
  const anyAbove = y > aboveStart;
  // forward primers sit right on the upper strand
  y += abovePad;

  const topStrandY = y;
  y += input.strandGap;
  const bottomStrandY = y;
  // lane 0 of the ORFs is the nearest the DNA
  const orfsAbove: number[] = [];
  for (let k = 0; k < input.orfs.above; k++) orfsAbove.push(topStrandY - m.orfNear - (k + 1) * m.orfLaneHeight);
  const orfsBelow: number[] = [];
  for (let k = 0; k < input.orfs.below; k++) orfsBelow.push(bottomStrandY + m.orfNear + k * m.orfLaneHeight);

  pendingGap = false;
  const stackBelow = (count: number, h: number, gap: number = m.groupGap): number[] => {
    if (count === 0) return [];
    if (pendingGap) y += gap;
    const tops: number[] = [];
    for (let k = 0; k < count; k++) tops.push(y + k * h);
    y += count * h;
    pendingGap = true;
    return tops;
  };
  // the reverse primers lie right against the lower strand, the ruler numbers (no tick lines) follow them and the
  // features below hang right from the numbers. The ORFs lie over the space of the primers, at a fixed distance from
  // the DNA, and push the numbers down only as far as they reach themselves.
  const primersBelow = stackBelow(input.primers.below, m.primerLaneHeight, 0);
  pendingGap = false;
  if (input.orfs.below > 0) y = Math.max(y, bottomStrandY + m.orfReserve + input.orfs.below * m.orfLaneHeight);
  const rulerTop = y;
  y += m.rulerHeight;
  const rulerBottom = y;
  const belowStart = y;
  const featuresBelow = stackBelow(input.features.below, m.featureLaneHeight);
  if (input.features.below > 0) {
    y += featureLabelBandFor(featureLabelRows.below);
    pendingGap = false;
  }
  const anyBelow = y > belowStart;
  const bodyBottom = anyBelow ? y + 2 : rulerBottom - 4;
  const labelRowsBelow = input.primerLabelRows?.below ?? 0;
  if (labelRowsBelow > 0) y += m.enzymeGap;
  const primerLabelsBelowTop = y;
  y += labelRowsBelow * m.enzymeRowHeight;
  const primerLabelsBelowBottom = y;
  y += m.padBottom;

  return {
    height: y,
    enzymeRows: input.enzymeRows,
    enzymeTop,
    enzymeBottom,
    featureLabelRows,
    primerLabels: {
      above: { top: primerLabelsAboveTop, bottom: primerLabelsAboveBottom, rows: labelRowsAbove },
      below: { top: primerLabelsBelowTop, bottom: primerLabelsBelowBottom, rows: labelRowsBelow },
    },
    features: { above: featuresAbove, below: featuresBelow },
    orfs: { above: orfsAbove, below: orfsBelow },
    primers: { above: primersAbove, below: primersBelow },
    alignmentBandTop,
    alignmentBandHeight,
    alignmentLanesTop,
    topStrandY,
    bottomStrandY,
    rulerTop,
    rulerBottom,
    bodyTop: anyAbove ? aboveStart - 2 : topStrandY - 10,
    bodyBottom,
    selectionTop: topStrandY - m.rulerHeight - 3,
    selectionBottom: rulerBottom + 3,
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
  /** Top of the bar (its lane): the element's vertical reference between layouts, see LinearMap's glide. */
  y: number;
  /** Line joining the segments of a multi-segment feature (introns), if any. */
  connector: string | null;
  fill: string;
}

/**
 * 3-Tier Feature Label Visualization (+ 'beside' fallback):
 * - 'inside': Tier 1 — label text inside the feature arrow/bar
 * - 'below':  Tier 2 — label text directly beneath/adjacent to the feature bar without a leader line
 * - 'outside': Tier 3 — label text placed outside with a leader line connecting to the feature bar
 */
export type LabelPlacement = 'inside' | 'below' | 'beside' | 'outside';

export interface FeatureLabel extends TextBox {
  entry: number;
  placement: LabelPlacement;
  /** Text colour of a label inside its bar (contrasting with the bar's fill); null outside. */
  onFill: string | null;
  /** SVG path of the leader line for Tier 3 ('outside') labels; null for 'inside' / 'below' / 'beside'. */
  leader?: string | null;
  /** 'outside' labels: the side of the backbone and the row (0 = nearest the bars) they stand in. */
  outsideSide?: Side;
  outsideRow?: number;
}

export interface FillPath {
  key: string;
  d: string;
  fill: string;
  opacity: number;
  /** Top of the bars (their lane), see FeatureGlyph.y. */
  y: number;
}

export interface OrfGlyph {
  key: string;
  entry: number;
  dir: 1 | -1;
  d: string;
  /** Centre line of the lane, see FeatureGlyph.y. */
  y: number;
}

/** The marks of the ORFs of one lane and direction too small for a glyph. */
export interface OrfMarks {
  key: string;
  dir: 1 | -1;
  d: string;
  /** Centre line of the lane, see FeatureGlyph.y. */
  y: number;
}

/**
 * An aligned read, drawn as in SnapGene: a hollow arrow over the whole read (pointing to its 3' end), filled red where
 * read bases match the reference; mismatches and deletions stay as gaps in the red, insertions are short ticks above.
 */
export interface AlignmentGlyph {
  key: string;
  id: string;
  name: string;
  strand: 1 | -1;
  /** Arrow outline over the whole read (aligned part and unaligned tails). */
  outline: string;
  /** Red fill over the aligned stretch. */
  fill: string | null;
  /** Mismatches and deletions, cut out of the fill (at least 1 px wide). */
  gaps: string | null;
  /** Insertions: short ticks above the arrow. */
  inserts: string | null;
}

export interface PrimerGlyph {
  key: string;
  entry: number;
  d: string;
  /** Dashed 5' tail (path), if any. */
  tail: string | null;
  dir: 1 | -1;
  /** Centre line of the lane, see FeatureGlyph.y. */
  y: number;
}

export interface PrimerLabel extends TextBox {
  entry: number;
  dir: 1 | -1;
  /** Leader from the label to the primer. */
  leader: string;
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
  alignments?: TrackSet<AlignmentEntry> | null;
  /** See VerticalInput.alignmentSpace. */
  alignmentSpace?: number;
  markers: readonly CutMarker[] | null;
  /** Enzyme label rows to use (reserved, see enzymeRowsToReserve). */
  enzymeRows: number;
  /** Outside feature label rows to use above / below the features (reserved, see featureLabelRowsToReserve). */
  featureLabelRows?: { above: number; below: number };
  /** Primer label rows to use above / below the primer lanes (reserved, see primerLabelRowsToReserve). */
  primerLabelRows?: { above: number; below: number };
  measure: TextMeasurer;
  /** Features whose labels are placed first (highlighted / selected ones). */
  pinnedFeatureIds?: ReadonlySet<string>;
  showLengths?: boolean;
  showPrimerLocations?: boolean;
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
  /** `small`: per lane and direction, the marks of the ORFs too small for a glyph. */
  orfs: { glyphs: OrfGlyph[]; small: OrfMarks[] };
  primers: { glyphs: PrimerGlyph[]; labels: PrimerLabel[] };
  alignments: {
    band: { x0: number; x1: number; y: number; height: number } | null;
    glyphs: AlignmentGlyph[];
  };
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

/**
 * Rows of outside feature labels to reserve above and below the features: what the whole-record view needs (where the
 * bars are narrowest, so most labels have to go outside), at least the default two. `input` must describe the
 * whole-record view. Stable while panning and zooming, like the enzyme rows.
 */
export function featureLabelRowsToReserve(input: ViewInput): { above: number; below: number } {
  const wide = computeView({ ...input, featureLabelRows: { above: METRICS.maxFeatureLabelRows, below: METRICS.maxFeatureLabelRows } });
  const out = { above: 2, below: 2 };
  for (const l of wide.features.labels) {
    if (l.placement !== 'outside' || l.outsideSide === undefined || l.outsideRow === undefined) continue;
    out[l.outsideSide] = Math.max(out[l.outsideSide], l.outsideRow + 1);
  }
  return out;
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
  topology: Topology;
  showLengths: boolean;
  showPrimerLocations: boolean;
  primerSeqLengths: ReadonlyMap<string, number>;
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
    if (entry.feature.bidirectional && strand === 0) {
      // a marker pointing both ways: a head wherever the feature itself starts or ends
      const atStart = sp.start === Math.min(entry.extent.start, L);
      const atEnd = sp.end === (entry.extent.end > L ? entry.extent.end - L : entry.extent.end);
      arrow = atStart && atEnd ? 'both' : atStart ? 'left' : atEnd ? 'right' : 'none';
    } else if (strand === 1 && sp.end === end3) arrow = 'right';
    else if (strand === -1 && sp.start === end3) arrow = 'left';
    // ends where the feature continues across the origin are square
    let squareLeft = piece.piece === 2 && sp.start === 0;
    let squareRight = piece.piece === 1 && sp.end === L;
    // clip far off-screen ends (they are never seen, and huge coordinates lose precision)
    if (x0 < -CLIP) {
      x0 = -CLIP;
      squareLeft = true;
      if (arrow === 'left') arrow = 'none';
      else if (arrow === 'both') arrow = 'right';
    }
    if (x1 > width + CLIP) {
      x1 = width + CLIP;
      squareRight = true;
      if (arrow === 'right') arrow = 'none';
      else if (arrow === 'both') arrow = 'left';
    }
    if (x1 <= x0) continue;
    d += barPath(x0, x1, top, h, {
      arrow,
      head: METRICS.featureHead,
      radius: METRICS.featureRadius,
      squareLeft,
      squareRight,
    });
    const head = arrow === 'none' ? 0 : Math.min(METRICS.featureHead, (x1 - x0) * (arrow === 'both' ? 0.3 : 0.6));
    const bl = Math.max(0, arrow === 'left' || arrow === 'both' ? x0 + head : x0);
    const br = Math.min(width, arrow === 'right' || arrow === 'both' ? x1 - head : x1);
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
  // slim bars and density per lane (and fill): a lane keeps its identity between layouts (see LinearMap's glide)
  const smallBars = new Map<string, { fill: string; y: number; d: string }>();
  const addSmall = (key: string, fill: string, y: number, d: string) => {
    const cur = smallBars.get(key);
    if (cur) cur.d += d;
    else smallBars.set(key, { fill, y, d });
  };
  const densityByKey = new Map<string, { fill: string; level: number; y: number; d: string }>();
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
          addSmall(`${side}:${lane}:${entry.fill}`, entry.fill, top, rectPath(x0, top, w, barH));
        } else {
          const shape = featurePieceShape(entry, it, top, ctx);
          out.glyphs.push({ key: `${entry.feature.id}:${it.piece}`, entry: it.ref, d: shape.d, connector: shape.connector, fill: entry.fill, y: top });
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
          addSmall(`${side}:${lane}:${entry.fill}`, entry.fill, top, rectPath(a, top, MIN_BAR_PX, barH));
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
          const key = `${side}:${lane}:${fi}:${level}`;
          const path = densityByKey.get(key) ?? { fill: fills[fi], level, y: top, d: '' };
          path.d += rectPath(b * BIN_PX, top, (e - b) * BIN_PX, barH);
          densityByKey.set(key, path);
          b = e;
        }
      }
    }
  }

  for (const [key, p] of smallBars) out.small.push({ key: `small:${key}`, d: p.d, fill: p.fill, y: p.y, opacity: 1 });
  for (const [key, p] of densityByKey) out.density.push({ key: `density:${key}`, d: p.d, fill: p.fill, y: p.y, opacity: DENSITY_LEVELS[p.level] });

  // Labels, most important first: pinned features, then the widest bars.
  for (const c of tinyCandidates) if (tinyCount <= MAX_LABELLED_TINY || c.priority > 0) candidates.push(c);
  candidates.sort((a, b) => b.priority - a.priority || a.x0 - b.x0);
  const font = m.labelFont;
  const weight = m.labelWeight;
  const widthOf = (s: string) => measure(s, font, weight);
  // the labels placed outside, with what their leader needs
  const outside: { label: FeatureLabel; side: Side; anchorX: number; barTop: number }[] = [];
  // other labels standing in the outside rows (below labels of the outermost lane share the first row below)
  const outsideBlocked: { side: Side; row: number; left: number; right: number }[] = [];
  // where an outside label in row `extRow` stands, and its leader down (or up) to its bar
  const outsideGeometry = (side: Side, extRow: number, anchorX: number, barTop: number) => {
    const outerBarTop = featureBarTop(v, side, Math.max(1, set[side].length) - 1);
    const offset = 4.5 + extRow * 13;
    const oy = side === 'above' ? outerBarTop - offset - font / 2 - 1 : outerBarTop + barH + offset + font / 2 + 1;
    const y0 = side === 'above' ? oy + font / 2 + 1 : barTop + barH;
    const y1 = side === 'above' ? barTop : oy - font / 2 - 1;
    const leader = y1 > y0 ? vlinePath(anchorX, y0, y1) : vlinePath(anchorX, Math.min(y0, y1), Math.max(y0, y1) + 2);
    return { oy, leader };
  };
  for (const c of candidates) {
    const entry = set.entries[c.ref];
    const rawName = entry.feature.name;
    if (!rawName) continue;
    const name = ctx.showLengths
      ? `${rawName} (${formatInt(featureLength(entry.feature))} bp)`
      : rawName;
    const tw = widthOf(name);
    const cy = c.barTop + barH / 2;
    const key = `${entry.feature.id}:${c.piece}:label`;
    const push = (
      text: string,
      left: number,
      textW: number,
      y: number,
      placement: LabelPlacement,
      leader: string | null = null,
    ) => {
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
        leader,
      });
    };
    // Tier 1 ('inside'): label fits comfortably inside the feature arrow/bar
    const room = c.bodyR - c.bodyL - 2 * INSIDE_PAD;
    const visL = Math.max(0, c.x0);
    const visR = Math.min(width, c.x1);
    const visW = visR - visL;
    const ol = Math.min(width - EDGE - tw, Math.max(EDGE, (visL + visR) / 2 - tw / 2));
    const overBar = ol < visR && ol + tw > visL;
    const maxLane = Math.max(1, set[c.side].length);
    const belowRow = space.row(`below:${c.side}:${c.lane}`);
    const sharesBottomOuter = c.side === 'below' && c.lane === maxLane - 1;
    const bottomOuterRow = sharesBottomOuter ? space.row(featureRowKey('below', maxLane)) : null;
    // a feature above the strand never takes a label under its bar (between it and the strand): its labels stay above
    const canPlaceBelow =
      c.side === 'below' &&
      visW >= 10 &&
      ol >= EDGE &&
      overBar &&
      belowRow.isFree(ol - NEIGHBOUR_GAP, ol + tw + NEIGHBOUR_GAP) &&
      (!bottomOuterRow || bottomOuterRow.isFree(ol - NEIGHBOUR_GAP, ol + tw + NEIGHBOUR_GAP));
    if (tw <= room && (room >= 56 || tw <= room * 0.78 || !canPlaceBelow)) {
      push(name, (c.bodyL + c.bodyR) / 2 - tw / 2, tw, cy, 'inside', null);
      continue;
    }
    const row = space.row(featureRowKey(c.side, c.lane));

    // Tier 2 ('below'): medium-sized feature with clear room directly below the feature bar (no leader line)
    if (canPlaceBelow) {
      const by = c.barTop + barH + OUTWARD_GAP + font / 2 + 1;
      push(name, ol, tw, by, 'below', null);
      belowRow.add(ol, ol + tw);
      bottomOuterRow?.add(ol, ol + tw);
      if (bottomOuterRow) outsideBlocked.push({ side: 'below', row: 0, left: ol, right: ol + tw });
      continue;
    }
    if (visW >= 10) {
      // Or beside the bar in the same lane (no leader line)
      const rl = c.x1 + BESIDE_GAP;
      if (rl >= EDGE && rl + tw <= width - EDGE && row.isFree(rl, rl + tw + NEIGHBOUR_GAP)) {
        push(name, rl, tw, cy, 'beside', null);
        row.add(rl, rl + tw);
        continue;
      }
      const ll = c.x0 - BESIDE_GAP - tw;
      if (ll >= EDGE && ll + tw <= width - EDGE && row.isFree(ll - NEIGHBOUR_GAP, ll + tw)) {
        push(name, ll, tw, cy, 'beside', null);
        row.add(ll, ll + tw);
        continue;
      }
    }

    // Tier 3 ('outside' with leader line): small/narrow features or crowded features routed to the external label band
    let placedOutside = false;
    if (ol >= EDGE && overBar) {
      for (let extRow = 0; extRow < v.featureLabelRows[c.side]; extRow++) {
        const outerRow = space.row(featureRowKey(c.side, maxLane + extRow));
        if (!outerRow.isFree(ol - NEIGHBOUR_GAP, ol + tw + NEIGHBOUR_GAP)) continue;
        const anchorX = Math.round(Math.max(visL + 0.5, Math.min(visR - 0.5, (visL + visR) / 2)) * 2) / 2;
        const { oy, leader } = outsideGeometry(c.side, extRow, anchorX, c.barTop);
        push(name, ol, tw, oy, 'outside', leader);
        const placed = out.labels[out.labels.length - 1];
        placed.outsideSide = c.side;
        placed.outsideRow = extRow;
        outerRow.add(ol, ol + tw);
        outside.push({ label: placed, side: c.side, anchorX, barTop: c.barTop });
        placedOutside = true;
        break;
      }
    }
    if (placedOutside) continue;

    // Fallback: beside in own lane for small features if outer rows were full
    const rl = c.x1 + BESIDE_GAP;
    if (rl >= EDGE && rl + tw <= width - EDGE && row.isFree(rl, rl + tw + NEIGHBOUR_GAP)) {
      push(name, rl, tw, cy, 'beside', null);
      row.add(rl, rl + tw);
      continue;
    }
    const ll = c.x0 - BESIDE_GAP - tw;
    if (ll >= EDGE && ll + tw <= width - EDGE && row.isFree(ll - NEIGHBOUR_GAP, ll + tw)) {
      push(name, ll, tw, cy, 'beside', null);
      row.add(ll, ll + tw);
      continue;
    }
    if (room >= MIN_TRUNCATED_PX) {
      const text = truncateToWidth(name, room, widthOf);
      // "fro…" says little: keep a truncated label only if enough of the name survives
      if (text && text.length - 1 >= Math.min(MIN_TRUNCATED_CHARS, name.length - 1)) {
        const w = widthOf(text);
        push(text, (c.bodyL + c.bodyR) / 2 - w / 2, w, cy, 'inside', null);
      }
    }
  }

  // Which labels go outside is settled above (most important first); their rows are then given again from left to
  // right, each above any neighbour it would run into, so neighbours keep their order (a staircase rising to the
  // right) at any width instead of swapping rows as the widths of their bars shift.
  for (const side of SIDES) {
    const items = outside.filter((o) => o.side === side).sort((a, b) => a.anchorX - b.anchorX || a.label.left - b.label.left);
    const rows: number[] = [];
    const runsInto = (a: { left: number; right: number }, b: { left: number; right: number }) =>
      a.left < b.right + NEIGHBOUR_GAP && a.right > b.left - NEIGHBOUR_GAP;
    for (let i = 0; i < items.length; i++) {
      const q = items[i].label;
      let row = 0;
      for (let j = 0; j < i; j++) if (runsInto(items[j].label, q)) row = Math.max(row, rows[j] + 1);
      while (outsideBlocked.some((b) => b.side === side && b.row === row && runsInto(b, q))) row++;
      rows.push(row);
    }
    // more rows than there are: the rows found above stay
    if (rows.some((r) => r >= v.featureLabelRows[side])) continue;
    items.forEach((o, i) => {
      const { oy, leader } = outsideGeometry(side, rows[i], o.anchorX, o.barTop);
      Object.assign(o.label, { y: oy, top: oy - font / 2 - 1, bottom: oy + font / 2 + 1, leader, outsideRow: rows[i] });
    });
  }
}

function layoutOrfs(set: TrackSet<OrfEntry>, v: VerticalLayout, ctx: LaneContext, out: ViewModel['orfs']): void {
  const { scale, width, bpFrom, bpTo, seqLength: L } = ctx;
  const m = METRICS;
  const marks = new Map<string, OrfMarks>();
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
          const mark = rectPath((x0 + x1) / 2 - w / 2, cy - m.orfThickness / 2, w, m.orfThickness);
          const key = `${side}:${lane}:${entry.orf.strand}`;
          const cur = marks.get(key);
          if (cur) cur.d += mark;
          else marks.set(key, { key, dir: entry.orf.strand, y: cy, d: mark });
          continue;
        }
        const dir = entry.orf.strand;
        // the arrow head goes on the piece holding the 3' end
        const end3 = dir === 1 ? (entry.extent.end > L ? entry.extent.end - L : entry.extent.end) : entry.extent.start;
        const hasHead = dir === 1 ? it.end === end3 && scale.x(it.end) <= width + CLIP : it.start === end3 && scale.x(it.start) >= -CLIP;
        const d = hasHead
          ? orfPath(x0, x1, cy, dir, m.orfThickness, m.orfHead, m.orfHeadHalf)
          : rectPath(x0, cy - m.orfThickness / 2, x1 - x0, m.orfThickness);
        out.glyphs.push({ key: `orf:${it.ref}:${it.piece}`, entry: it.ref, dir, d, y: cy });
      }
    }
  }
  out.small = [...marks.values()];
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
      // the shaft lies against the strand: at the bottom of a lane above the backbone, at the top of a lane below it;
      // the raised tail of the primer has the rest of the lane
      const laneTop = v.primers[side][lane];
      const cy = side === 'above' ? laneTop + m.primerLaneHeight - m.primerShaft / 2 - 0.5 : laneTop + m.primerShaft / 2 + 0.5;
      const row = space.row(`p:${side}:${lane}`);
      for (let i = i0; i < i1; i++) {
        const it = items[i];
        if (it.end <= bpFrom || it.start >= bpTo) continue;
        const entry = set.entries[it.ref];
        const dir = entry.site.strand;
        const ann = entry.annealed;

        let d = '';
        let gx0 = Infinity;
        let gx1 = -Infinity;
        for (const ap of piecesOf(ann, L)) {
          const s = Math.max(ap.start, it.start);
          const e = Math.min(ap.end, it.end);
          if (e <= s) continue;
          let [x0, x1] = [scale.x(s), scale.x(e)];
          // drawn to scale: a primer is as long as its annealed part (a speck of 1.5 px at least, so it stays visible)
          if (x1 - x0 < 1.5) [x0, x1] = [(x0 + x1) / 2 - 0.75, (x0 + x1) / 2 + 0.75];
          const cx0 = Math.max(-CLIP, x0);
          const cx1 = Math.min(width + CLIP, x1);
          if (cx1 <= cx0) continue;
          // a plain bar (no arrow head): forward primers are drawn above the backbone, reverse ones below it
          d += rectPath(cx0, cy - m.primerShaft / 2, cx1 - cx0, m.primerShaft);
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
        out.glyphs.push({ key: `primer:${it.ref}:${it.piece}`, entry: it.ref, d, tail, dir, y: cy });
        row.add(gx0, gx1);
        // a primer that wraps the origin is labelled on the piece holding its 3' end
        if (it.piece === 0 || it.piece === (dir === 1 ? 2 : 1)) {
          candidates.push({ ref: it.ref, piece: it.piece, side, lane, x0: gx0, x1: gx1, cy, dir });
        }
      }
    }
  }

  // Labels stand in rows above (forward primers) or below (reverse primers) the primer lanes, SnapGene-style: each has a
  // leader line to its primer, and sits left or right of that line so that the rows form a staircase.
  const font = m.primerFont;
  const pad = m.enzymeLabelPad;
  for (const side of SIDES) {
    const rows = v.primerLabels[side].rows;
    if (rows === 0) continue;
    const items = candidates
      .filter((c) => c.side === side && set.entries[c.ref].name)
      .sort((a, b) => a.x0 - b.x0)
      .map((c) => {
        const text = primerLabelText(set.entries[c.ref], L, ctx.showPrimerLocations, ctx.showLengths, ctx.primerSeqLengths);
        // the leader meets the primer at the end where it starts (5'): the left end of a forward primer, the right end of a reverse one
        const end5 = c.dir === 1 ? c.x0 : c.x1;
        return { c, text, tw: measure(text, font, m.primerWeight), x: Math.min(width - EDGE, Math.max(EDGE, end5)) };
      });
    const placed = placeEnzymeLabels(
      items.map((it) => ({ x: it.x, width: pad + it.tw, priority: 0 })),
      { maxRows: rows, minX: EDGE, maxX: width - EDGE },
    );
    items.forEach((it, k) => {
      const p = placed[k];
      if (!p) return;
      const x = Math.round(p.x * 2) / 2;
      const rowTop = primerLabelRowTop(v, side, p.row);
      const cy = rowTop + m.enzymeRowHeight / 2;
      const textLeft = p.align === 'start' ? x + pad : x - pad - it.tw;
      const edge = it.c.cy + (side === 'above' ? -m.primerShaft / 2 - 1 : m.primerShaft / 2 + 1);
      const leader = side === 'above' ? vlinePath(x, cy + 2, edge) : vlinePath(x, edge, cy - 2);
      out.labels.push({
        key: `primer:${it.c.ref}:${it.c.piece}:label`,
        entry: it.c.ref,
        dir: it.c.dir,
        text: it.text,
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
  }
}

/** Text of a primer label: the name, then its location and length when those options are on. */
export function primerLabelText(
  entry: PrimerEntry,
  seqLength: number,
  showLocations: boolean,
  showLengths: boolean,
  seqLengths: ReadonlyMap<string, number>,
): string {
  let text = entry.name;
  if (showLocations && seqLength > 0) {
    const start1 = entry.annealed.start + 1;
    const end1 = (((entry.annealed.end - 1) % seqLength) + seqLength) % seqLength + 1;
    text = `(${start1} .. ${end1}) ${text}`;
  }
  if (showLengths) {
    const bpLen = seqLengths.get(entry.site.primerId) || Math.max(0, entry.extent.end - entry.extent.start);
    text = `${text} (${formatInt(bpLen)} bp)`;
  }
  return text;
}

/**
 * Rows of primer labels to reserve above (forward primers) and below (reverse primers) the primer lanes: what the
 * whole-record view needs, capped. Stable while panning, like the enzyme rows.
 */
export function primerLabelRowsToReserve(
  set: TrackSet<PrimerEntry> | null,
  seqLength: number,
  plotLeft: number,
  plotWidth: number,
  width: number,
  measure: TextMeasurer,
  showLocations: boolean,
  showLengths: boolean,
  seqLengths: ReadonlyMap<string, number>,
  maxRows: number = METRICS.maxPrimerLabelRows,
): { above: number; below: number } {
  const out = { above: 0, below: 0 };
  if (!set || seqLength <= 0) return out;
  const k = plotWidth / seqLength;
  for (const side of SIDES) {
    const seen = new Set<number>();
    const boxes: Array<{ x: number; width: number; priority: number }> = [];
    for (const lane of set[side]) {
      for (const it of lane.items) {
        if (seen.has(it.ref)) continue;
        seen.add(it.ref);
        const entry = set.entries[it.ref];
        if (!entry.name) continue;
        const text = primerLabelText(entry, seqLength, showLocations, showLengths, seqLengths);
        const end5 = (entry.site.strand === 1 ? entry.annealed.start : entry.annealed.end) % seqLength;
        boxes.push({ x: plotLeft + end5 * k, width: METRICS.enzymeLabelPad + measure(text, METRICS.primerFont, METRICS.primerWeight), priority: 0 });
      }
    }
    if (boxes.length > 0) out[side] = Math.max(1, rowsUsed(placeEnzymeLabels(boxes, { maxRows, minX: EDGE, maxX: width - EDGE })));
  }
  return out;
}

/** Horizontal clearance (px) between a leader and a label it passes. */
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

  // Cut marks stand on the backbone: from above down to the upper strand, never through the DNA; at letter zoom the
  // staggered cut between the two strands.
  let ticks = '';
  let ticksUnlabelled = '';
  let staggered = '';
  const drawn = new Set<number>();
  const yTop = v.topStrandY - CUT_OVERSHOOT;
  const yBottom = v.topStrandY;
  visible.forEach((i, j) => {
    const mk = markers[i];
    const x = Math.round(scale.x(mk.pos) * 2) / 2;
    if (letterZoom && mk.cuts) {
      const xb = Math.round(scale.x(mk.bottom) * 2) / 2;
      const yMid = (v.topStrandY + v.bottomStrandY) / 2;
      staggered += `M${fmt(x)} ${fmt(v.topStrandY)}V${fmt(yMid)}H${fmt(xb)}V${fmt(v.bottomStrandY)}`;
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

  // Leaders run down to the backbone behind the feature lanes (bars cover them) and straight through the
  // labels they pass: the labels have a half-transparent backing, so the line stays faintly visible.
  let leaders = '';
  placed.forEach((p, j) => {
    if (!p) return;
    const i = visible[j];
    const mk = markers[i];
    const x = Math.round(p.x * 2) / 2;
    const rowTop = enzymeRowTop(v, p.row);
    const cy = rowTop + m.enzymeRowHeight / 2;
    const leader = vlinePath(x, cy + 2, v.topStrandY - CUT_OVERSHOOT);
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

/** Where a read matches the reference, in unwrapped reference coordinates from `refRange.start`. */
interface AlignmentDetail {
  start: number;
  end: number;
  /** Mismatched bases and deletions, as [start, end) runs. */
  gaps: Array<[number, number]>;
  /** Reference positions in front of which the read has extra bases. */
  inserts: number[];
}

const alignmentDetails = new WeakMap<AlignedSequence, AlignmentDetail>();

function alignmentDetail(aln: AlignedSequence, refSeq: string): AlignmentDetail {
  const cached = alignmentDetails.get(aln);
  if (cached && cached.start === aln.refRange.start) return cached;
  const L = refSeq.length;
  const read = (aln.strand === 1 ? aln.sequence : reverseComplement(aln.sequence)).toUpperCase();
  const gaps: Array<[number, number]> = [];
  const inserts: number[] = [];
  const gap = (s: number, e: number) => {
    const last = gaps[gaps.length - 1];
    if (last && last[1] === s) last[1] = e;
    else gaps.push([s, e]);
  };
  let qi = 0;
  let rp = aln.refRange.start;
  for (const m of aln.cigar.matchAll(/(\d+)([MIDNSHP=X])/g)) {
    const len = Number(m[1]);
    const op = m[2];
    if (op === 'S' || op === 'I') {
      if (op === 'I') inserts.push(rp);
      qi += len;
    } else if (op === 'D' || op === 'N') {
      gap(rp, rp + len);
      rp += len;
    } else if (op === 'M' || op === '=' || op === 'X') {
      for (let k = 0; k < len; k++) {
        const q = read[qi + k];
        if (!q || q !== refSeq[(rp + k) % L]?.toUpperCase()) gap(rp + k, rp + k + 1);
      }
      qi += len;
      rp += len;
    }
  }
  const detail = { start: aln.refRange.start, end: rp, gaps, inserts };
  alignmentDetails.set(aln, detail);
  return detail;
}

/** Arrow over [x0, x1], `h` high, with its head at the 3' end when `head`. */
function readArrowPath(x0: number, x1: number, cy: number, h: number, dir: 1 | -1, head: boolean): string {
  const t = cy - h / 2;
  const b = cy + h / 2;
  const hl = head ? Math.min(7, (x1 - x0) * 0.5) : 0;
  const r = (n: number) => Math.round(n * 100) / 100;
  if (hl <= 0) return `M${r(x0)} ${r(t)}H${r(x1)}V${r(b)}H${r(x0)}Z`;
  if (dir === 1) return `M${r(x0)} ${r(t)}H${r(x1 - hl)}L${r(x1)} ${r(cy)}L${r(x1 - hl)} ${r(b)}H${r(x0)}Z`;
  return `M${r(x1)} ${r(t)}H${r(x0 + hl)}L${r(x0)} ${r(cy)}L${r(x0 + hl)} ${r(b)}H${r(x1)}Z`;
}

function layoutAlignments(
  set: TrackSet<AlignmentEntry>,
  v: VerticalLayout,
  ctx: LaneContext,
  backboneTop: [number, number] | null,
  out: ViewModel['alignments'],
  refSeq: string,
): void {
  const { scale, width, bpFrom, bpTo, seqLength: L } = ctx;
  const m = METRICS;
  const lanes = set.above;
  if (lanes.length === 0 || v.alignmentBandHeight <= 0) return;

  if (backboneTop && backboneTop[1] > backboneTop[0]) {
    out.band = {
      x0: backboneTop[0],
      x1: backboneTop[1],
      y: v.alignmentBandTop,
      height: v.alignmentBandHeight,
    };
  }

  const H = 9; // arrow height
  const INSET = 1.5; // the red fill sits this far inside the outline
  const HEAD = 7;
  for (let lane = 0; lane < lanes.length; lane++) {
    const [i0, i1] = visibleSpan(lanes[lane], bpFrom, bpTo);
    const cy = (v.alignmentLanesTop[lane] ?? v.alignmentBandTop) + m.alignmentLaneHeight / 2;
    for (let i = i0; i < i1; i++) {
      const it = lanes[lane].items[i];
      if (it.end <= bpFrom || it.start >= bpTo) continue;
      const entry = set.entries[it.ref];
      const aln = entry.alignedSeq;
      const dir = aln.strand;
      const end3 = dir === 1 ? (entry.extent.end > L ? entry.extent.end - L : entry.extent.end) : entry.extent.start;

      const x0 = scale.x(it.start);
      const x1 = scale.x(it.end);
      const cx0 = Math.max(-CLIP, x0);
      const cx1 = Math.min(width + CLIP, x1);
      if (cx1 <= cx0) continue;
      const hasHead = dir === 1 ? it.end === end3 && x1 <= width + CLIP : it.start === end3 && x0 >= -CLIP;
      const outline = readArrowPath(cx0, cx1, cy, H, dir, hasHead && cx1 - cx0 >= 4);

      // this piece in unwrapped alignment coordinates (the second piece of a read over the origin is shifted by L)
      const shift = it.start < entry.extent.start ? L : 0;
      const u0 = it.start + shift;
      const u1 = it.end + shift;
      const det = alignmentDetail(aln, refSeq);
      const xu = (u: number) => scale.x(u - shift);
      // the fill stays out of the arrow head
      const lim0 = hasHead && dir === -1 ? cx0 + Math.min(HEAD, (cx1 - cx0) * 0.5) : cx0;
      const lim1 = hasHead && dir === 1 ? cx1 - Math.min(HEAD, (cx1 - cx0) * 0.5) : cx1;
      const f0 = Math.max(lim0, xu(Math.max(u0, det.start)));
      const f1 = Math.min(lim1, xu(Math.min(u1, det.end)));
      const fill = f1 > f0 ? rectPath(f0, cy - H / 2 + INSET, f1 - f0, H - 2 * INSET) : '';

      let gaps = '';
      if (fill) {
        let pendS = -Infinity;
        let pendE = -Infinity;
        const flush = () => {
          if (pendE > pendS) gaps += rectPath(pendS, cy - H / 2 + INSET, pendE - pendS, H - 2 * INSET);
        };
        for (const [gs, ge] of det.gaps) {
          if (ge <= u0 || gs >= u1) continue;
          let a = Math.max(f0, xu(Math.max(gs, u0)));
          let b = Math.min(f1, xu(Math.min(ge, u1)));
          if (b - a < 1) {
            const c = (a + b) / 2;
            a = c - 0.5;
            b = c + 0.5;
          }
          if (b <= f0 || a >= f1) continue;
          // gaps closer than a pixel merge into one cut
          if (a <= pendE + 0.5) pendE = Math.max(pendE, b);
          else {
            flush();
            pendS = a;
            pendE = b;
          }
        }
        flush();
      }

      let inserts = '';
      let lastX = -Infinity;
      for (const p of det.inserts) {
        if (p < u0 || p > u1) continue;
        const x = Math.round(xu(p) * 2) / 2;
        if (x < cx0 || x > cx1 || x - lastX < 1) continue;
        inserts += vlinePath(x, cy - H / 2 - 4, cy - H / 2);
        lastX = x;
      }

      out.glyphs.push({
        key: `aln:${aln.id}:${it.piece}`,
        id: aln.id,
        name: aln.name,
        strand: dir,
        outline,
        fill: fill || null,
        gaps: gaps || null,
        inserts: inserts || null,
      });
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
  // DNA reads as a double strand; RNA and protein as a single line.
  const isDna = record.molecule === 'DNA';
  const v = computeVerticalLayout({
    enzymeRows: input.markers && input.markers.length > 0 ? input.enzymeRows : 0,
    primerLabelRows: input.primers ? input.primerLabelRows : undefined,
    featureLabelRows: input.featureLabelRows,
    features: count(input.features),
    orfs: count(input.orfs),
    primers: count(input.primers),
    alignmentLanes: input.alignments ? input.alignments.above.length : 0,
    alignmentSpace: input.alignmentSpace,
    strandGap: strandGapFor(k, !isDna),
  });
  // A single-stranded molecule's line runs under its letters (at the bottom of the band).
  const lineY = isDna ? v.topStrandY : v.bottomStrandY;

  const ctx: LaneContext = {
    scale,
    width,
    bpFrom,
    bpTo,
    measure,
    seqLength: L,
    topology,
    showLengths: Boolean(input.showLengths),
    showPrimerLocations: Boolean(input.showPrimerLocations),
    primerSeqLengths: new Map(record.primers.map((p) => [p.id, p.sequence.length] as const)),
  };

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
  // The ruler is just the numbers, right under the lower strand: no tick lines.
  const major = '';
  const minor = '';
  const labels: TextBox[] = [];
  const labelY = v.rulerTop + 6;
  for (const n of tickInfo.major) {
    const x = Math.round(scale.x(n - 0.5) * 2) / 2;
    const text = formatTick(n, tickInfo.step);
    const tw = measure(text, METRICS.tickFont, 400);
    const cx = Math.min(width - 2 - tw / 2, Math.max(2 + tw / 2, x));
    labels.push({ key: `t${n}`, text, x: cx, y: labelY, anchor: 'middle', left: cx - tw / 2, right: cx + tw / 2, top: labelY - 6, bottom: labelY + 6 });
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
    orfs: { glyphs: [], small: [] },
    primers: { glyphs: [], labels: [] },
    alignments: { band: null, glyphs: [] },
    enzymes: { ticks: '', ticksUnlabelled: '', staggered: '', leaders: '', labels: [], visible: [] },
  };
  const space = new LabelSpace();
  if (input.features) layoutFeatures(input.features, v, ctx, view.features, space, input.pinnedFeatureIds);
  if (input.orfs) layoutOrfs(input.orfs, v, ctx, view.orfs);
  if (input.primers) {
    layoutPrimers(input.primers, v, ctx, view.primers, space);
  }
  if (input.alignments) layoutAlignments(input.alignments, v, ctx, backbone.top, view.alignments, record.seq);
  if (input.markers && input.markers.length > 0) layoutEnzymes(input.markers, v, ctx, view, letters !== null);
  return view;
}
