/**
 * Layout of the circular map, in three memoizable stages:
 *
 *   1. buildMapModel   (record + annotations)           lane packing, unique cutters, label texts
 *   2. computeGeometry (model + size + rotation + font) radius, radii, SVG paths, inside labels,
 *                                                        outside label candidates
 *   3. placeLabels     (geometry + pinned feature ids)   outside labels: columns, leaders, dropping
 *
 * Radial structure, from the outside in:
 *
 *   outside labels   (two columns hugging a circle around the map, with leader lines)
 *   primer arrows    (thin, just outside the backbone, stacked outwards)
 *   enzyme cut ticks (crossing the backbone)
 *   backbone         (radius R)
 *   feature lanes    (lane 0 hugs the backbone, further lanes stack inwards)
 *   ORF lanes        (thin arrows inside the features)
 *   ruler            (ticks + numbers, just inside the annotations)
 *   centre text      (record name + length)
 *
 * The radius is chosen by trying a few candidates and keeping the largest one whose outside
 * label layout loses (almost) no more labels than the best one: crowded maps get a slightly
 * smaller circle so the label stacks near 12 and 6 o'clock have room to grow outwards.
 */
import type { EnzymeSite, Feature, Orf, PrimerBindingSite, Range, SeqRecord, Topology } from '@hhereditas/core';
import { featureExtent, featureLength, mod, normalizeRange } from '@hhereditas/core';
import { featureFill, featureStroke } from '../common/colors';
import { formatBp, formatCompactBp, formatInt } from '../common/format';
import {
  type AngleScale,
  DEG,
  type RulerSpec,
  angleDelta,
  arcLength,
  arcPath,
  arrowPath,
  circlePath,
  createAngleScale,
  distanceToSegment,
  polarToCartesian,
  positionToAngle,
  pxToDegrees,
  radialLinePath,
  rulerSpec,
  thinArrowPath,
} from './geometry';
import { type TextMeasurer, truncateToWidth } from './measure';
import type { MapLayers } from './types';

// ---------------------------------------------------------------------------
// Lane packing
// ---------------------------------------------------------------------------

interface Interval {
  start: number;
  end: number;
}

/** Pieces of `r` (expanded by `pad` on both sides) inside [0, L). Zero-length ranges count as 1 bp. */
function lanePieces(r: Range, length: number, circular: boolean, pad: number): Interval[] {
  const s = r.start - pad;
  const e = Math.max(r.end, r.start + 1) + pad;
  if (!circular) return [{ start: Math.max(0, s), end: Math.min(length, e) }];
  if (e - s >= length) return [{ start: 0, end: length }];
  const start = mod(s, length);
  const end = start + (e - s);
  return end <= length ? [{ start, end }] : [{ start, end: length }, { start: 0, end: end - length }];
}

/** A lane: disjoint intervals sorted by start (hence also by end). */
type Lane = Interval[];

function laneOverlaps(lane: Lane, q: Interval): boolean {
  let lo = 0;
  let hi = lane.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (lane[mid].end > q.start) hi = mid;
    else lo = mid + 1;
  }
  return lo < lane.length && lane[lo].start < q.end;
}

function laneInsert(lane: Lane, piece: Interval): void {
  let lo = 0;
  let hi = lane.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (lane[mid].start < piece.start) lo = mid + 1;
    else hi = mid;
  }
  lane.splice(lo, 0, piece);
}

/**
 * Greedy lane assignment in circular coordinates: items are taken longest first and put
 * in the lowest lane where they overlap nothing, keeping `padding` bp of clearance.
 * Ranges follow the core conventions (origin-wrapping ranges have end > length).
 * Returns the lane index of every item (same order as `ranges`).
 */
export function assignLanes(
  ranges: readonly Range[],
  length: number,
  topology: Topology,
  padding = 0,
): number[] {
  const lanesOut = new Array<number>(ranges.length).fill(0);
  if (length <= 0) return lanesOut;
  const circular = topology === 'circular';
  const order = ranges.map((_, i) => i);
  const len = (r: Range) => r.end - r.start;
  order.sort((a, b) => len(ranges[b]) - len(ranges[a]) || ranges[a].start - ranges[b].start || a - b);
  const lanes: Lane[] = [];
  for (const i of order) {
    const r = ranges[i];
    const padded = lanePieces(r, length, circular, padding);
    const exact = lanePieces(r, length, circular, 0);
    let k = 0;
    while (k < lanes.length && padded.some((p) => laneOverlaps(lanes[k], p))) k++;
    if (k === lanes.length) lanes.push([]);
    for (const p of exact) laneInsert(lanes[k], p);
    lanesOut[i] = k;
  }
  return lanesOut;
}

/** Number of lanes used by an assignment. */
function laneCountOf(lanes: readonly number[]): number {
  let max = -1;
  for (const l of lanes) if (l > max) max = l;
  return max + 1;
}

// ---------------------------------------------------------------------------
// Stage 1: model (size independent)
// ---------------------------------------------------------------------------

export interface FeatureItem {
  feature: Feature;
  /** Overall extent, normalized (may wrap: end > length). */
  extent: Range;
  /** Bases covered (sum of segment lengths). */
  length: number;
  lane: number;
  /** False when the name is just the feature type (an unlabelled annotation). */
  named: boolean;
}

export interface EnzymeItem {
  site: EnzymeSite;
  /** Gap position (top strand) of the cut the label refers to. */
  cut: number;
  /** Every top-strand cut of the site (the recognition start when it does not cut). */
  cuts: number[];
  /** "EcoRI (396)": 1-based position of the base 5' of the top-strand cut. */
  label: string;
  /** The enzyme cuts the record exactly once (among the given sites). */
  unique: boolean;
  /** Number of cuts of this enzyme in the record (among the given sites). */
  cutCount: number;
}

export interface PrimerItem {
  site: PrimerBindingSite;
  name: string;
  lane: number;
}

export interface OrfItem {
  orf: Orf;
  lane: number;
}

export interface MapModel {
  record: SeqRecord;
  length: number;
  topology: Topology;
  features: FeatureItem[];
  featureLanes: number;
  enzymes: EnzymeItem[];
  primers: PrimerItem[];
  primerLanes: number;
  orfs: OrfItem[];
  orfLanes: number;
}

export interface MapModelInput {
  record: SeqRecord;
  enzymeSites?: readonly EnzymeSite[];
  primerSites?: readonly PrimerBindingSite[];
  orfs?: readonly Orf[];
  layers?: MapLayers;
}

/**
 * Number shown in an enzyme label for a top-strand cut at gap `p`: the 1-based position of
 * the base 5' of the cut (the cut at the origin of a circular molecule is after base L).
 * Same convention as the sequence view.
 */
export function cutLabelPosition(p: number, length: number, topology: Topology): number {
  if (p <= 0) return topology === 'circular' ? length : 0;
  return p;
}

export function buildMapModel(input: MapModelInput): MapModel {
  const { record } = input;
  const length = record.seq.length;
  const topology = record.topology;
  const layers = input.layers ?? {};
  const model: MapModel = {
    record,
    length,
    topology,
    features: [],
    featureLanes: 0,
    enzymes: [],
    primers: [],
    primerLanes: 0,
    orfs: [],
    orfLanes: 0,
  };
  if (length <= 0) return model;

  if (layers.features !== false) {
    const items: FeatureItem[] = [];
    for (const feature of record.features) {
      if (feature.segments.length === 0) continue;
      const extent = normalizeRange(featureExtent(feature, length, topology), length, topology);
      const name = feature.name.trim();
      items.push({
        feature,
        extent,
        length: featureLength(feature),
        lane: 0,
        named: name !== '' && name !== feature.type,
      });
    }
    const lanes = assignLanes(
      items.map((f) => f.extent),
      length,
      topology,
    );
    items.forEach((f, i) => (f.lane = lanes[i]));
    model.features = items;
    model.featureLanes = laneCountOf(lanes);
  }

  if (layers.enzymes !== false && input.enzymeSites) {
    const cutCount = new Map<string, number>();
    for (const s of input.enzymeSites) cutCount.set(s.enzyme, (cutCount.get(s.enzyme) ?? 0) + s.cuts.length);
    model.enzymes = input.enzymeSites.map((site) => {
      const cuts = site.cuts.length
        ? site.cuts.map((c) => (topology === 'circular' ? mod(c.top, length) : c.top))
        : [topology === 'circular' ? mod(site.range.start, length) : site.range.start];
      const cut = cuts[0];
      const num = site.cuts.length ? cutLabelPosition(cut, length, topology) : cut + 1;
      const count = cutCount.get(site.enzyme) ?? 0;
      return {
        site,
        cut,
        cuts,
        label: `${site.enzyme} (${formatInt(num)})`,
        unique: count === 1,
        cutCount: count,
      };
    });
  }

  if (layers.primers !== false && input.primerSites) {
    const names = new Map(record.primers.map((p) => [p.id, p.name] as const));
    const ranges = input.primerSites.map((s) => normalizeRange(s.range, length, topology));
    const lanes = assignLanes(ranges, length, topology);
    model.primers = input.primerSites.map((site, i) => ({
      site,
      name: names.get(site.primerId)?.trim() || 'Primer',
      lane: lanes[i],
    }));
    model.primerLanes = laneCountOf(lanes);
  }

  if (layers.orfs !== false && input.orfs) {
    const ranges = input.orfs.map((o) => normalizeRange(o.range, length, topology));
    const lanes = assignLanes(ranges, length, topology);
    model.orfs = input.orfs.map((orf, i) => ({ orf, lane: lanes[i] }));
    model.orfLanes = laneCountOf(lanes);
  }
  return model;
}

// ---------------------------------------------------------------------------
// Stage 2: geometry (size dependent)
// ---------------------------------------------------------------------------

export interface InsideLabel {
  /** Unique key (used to build the textPath id). */
  key: string;
  /** Baseline path for <textPath>. */
  d: string;
  text: string;
  fontSize: number;
}

export interface FeatureShape {
  /** Index into model.features (geometry.features is in model order). */
  index: number;
  id: string;
  item: FeatureItem;
  /** Lane actually drawn (lanes beyond the available depth share the last one). */
  lane: number;
  rIn: number;
  rOut: number;
  /** Angles of the overall extent (continuous: a1 may exceed 360). */
  a0: number;
  a1: number;
  /** Angles of each drawn segment (for hit testing). */
  segments: Array<{ a0: number; a1: number }>;
  /** Body path (all segments). */
  d: string;
  /** Thin arcs joining the segments of a multi-part feature ('' when none). */
  connectors: string;
  fill: string;
  stroke: string;
  inside: InsideLabel | null;
}

export interface PrimerShape {
  index: number;
  item: PrimerItem;
  rIn: number;
  rOut: number;
  a0: number;
  a1: number;
  d: string;
}

export interface OrfShape {
  index: number;
  item: OrfItem;
  rIn: number;
  rOut: number;
  a0: number;
  a1: number;
  d: string;
}

export interface EnzymeShape {
  index: number;
  item: EnzymeItem;
  /** Angle of the labelled cut. */
  angle: number;
  /** Angles of every cut of the site. */
  cutAngles: number[];
  /** Tick marks across the backbone. */
  d: string;
}

export interface TextItem {
  x: number;
  /** Baseline y. */
  y: number;
  text: string;
}

export interface RulerShape {
  /** Radius the ticks hang from. */
  radius: number;
  /** Thin circle the ticks hang from ('' when the ticks hang off the backbone itself). */
  circle: string;
  /** Labelled tick marks (one path). */
  major: string;
  /** Minor tick marks (one path, '' when too dense). */
  minor: string;
  /** Origin mark. */
  origin: string;
  labels: TextItem[];
  fontSize: number;
}

export interface CentreText {
  name: string;
  nameSize: number;
  nameY: number;
  detail: string;
  detailSize: number;
  detailY: number;
  /** Optional third line (empty states). */
  note: string;
  noteY: number;
}

export type LabelTone = 'feature' | 'enzyme' | 'enzymeUnique' | 'primerFwd' | 'primerRev';

/** Reference from a label to the item it describes (indices into the model arrays). */
export type LabelRef =
  | { kind: 'feature'; index: number }
  | { kind: 'enzyme'; index: number }
  | { kind: 'primer'; index: number };

export interface LabelCandidate {
  key: string;
  ref: LabelRef;
  /** Displayed text (truncated to the label allowance if needed). */
  text: string;
  /** Total width: text plus the colour chip, if any. */
  width: number;
  /** Feature labels: colour chip drawn before the text (CSS colour), else null. */
  chip: string | null;
  fontWeight: number;
  tone: LabelTone;
  /** Angle the leader points at, normalized to [0, 360). */
  angle: number;
  /** Radius where the leader starts. */
  anchorRadius: number;
  /**
   * 0 pinned, 1 named feature, 2 unnamed feature (name = type), 3 unique cutter, 4 other enzyme,
   * 5 primer, 6 unnamed feature on a small map.
   */
  priorityClass: number;
  /** Secondary priority within a class (larger first): feature / primer length. */
  weight: number;
  featureId?: string;
}

/** Everything the outside-label layout needs to know about the map. */
export interface LabelFrame {
  cx: number;
  cy: number;
  width: number;
  height: number;
  /** Highest and lowest label row centres. */
  top: number;
  bottom: number;
  lineHeight: number;
  fontSize: number;
  /** Circle the label rows hug. */
  labelRadius: number;
  /** Outer edge of the ring decorations: leaders never cut inside it. */
  ringOuter: number;
  /** Radius where leaders bend from radial to straight. */
  elbowRadius: number;
  /** Largest angle (degrees) between a label's anchor and the label itself. */
  maxDisplacement: number;
  /** Labels must stay within [left, right] (x). */
  left: number;
  right: number;
  /** Width of the colour chip plus its gap (feature labels). */
  chipWidth: number;
  /** Text measurement, for labels that must be shortened to fit their row. */
  measure: TextMeasurer;
}

export interface MapGeometry {
  model: MapModel;
  width: number;
  height: number;
  cx: number;
  cy: number;
  scale: AngleScale;
  /** Backbone radius. */
  radius: number;
  /** Outer edge of everything drawn on the ring (cut ticks, primers). */
  ringOuter: number;
  /** Circle the outside labels hug. */
  labelRadius: number;
  labelFontSize: number;
  labelLineHeight: number;
  margin: number;
  /** Feature band thickness. */
  band: number;
  backbone: string;
  /** Linear molecules: end caps at both ends of the backbone ('' otherwise). */
  backboneEnds: string;
  /** One shape per model feature, in model order. */
  features: FeatureShape[];
  /** Paint order of `features` (indices): long features first, short ones on top. */
  featureOrder: number[];
  /** Radii of each drawn feature lane. */
  lanes: Array<{ rIn: number; rOut: number }>;
  primers: PrimerShape[];
  orfs: OrfShape[];
  enzymes: EnzymeShape[];
  ruler: RulerShape | null;
  centre: CentreText;
  /** Outside label candidates (features whose name does not fit inside their arc, enzymes, primers). */
  candidates: LabelCandidate[];
  labelFrame: LabelFrame;
  /** Outside label layout without pinned labels (what placeLabels(geometry) returns). */
  basePlacement: LabelPlacement;
  /** Pointer radius range in which a press starts a drag selection. */
  dragInner: number;
  dragOuter: number;
  /** Radius available for the centre text. */
  centreRadius: number;
}

export interface GeometryOptions {
  width: number;
  height: number;
  /** Degrees, clockwise; 0 puts the origin at 12 o'clock. */
  rotation?: number;
  measure: TextMeasurer;
}

// Radial constants (px).
const GAP0 = 3; // backbone -> outer edge of feature lane 0
const PRIMER_OFFSET = 4; // backbone -> inner edge of primer lane 0
const PRIMER_W = 6; // arrow head width (the shaft is thinner)
const PRIMER_SHAFT = 2.5;
const PRIMER_STEP = 7.5;
const MAX_PRIMER_LANES = 4;
const TICK_IN = 3; // enzyme tick: inside the backbone
const TICK_OUT = 5; // enzyme tick: outside the backbone
const ORF_W = 6; // arrow head width
const ORF_SHAFT = 2;
const ORF_STEP = 7;
const ORF_OFFSET = 3;
const MAX_ORF_LANES = 6;
const RULER_GAP = 6; // innermost annotation -> ruler ticks
const MAJOR_TICK = 5;
const MINOR_TICK = 2.5;
const INSIDE_PAD = 5; // inside label clearance at each end
const HEAD_PX = 9; // arrowhead length
export const LABEL_CHIP_GAP = 4; // colour chip -> label text
const ATTACH_GAP = 3; // leader end -> label
const POLE_INSET = 6; // label columns keep this far from the vertical axis
/** Radius candidates, as fractions of the largest radius the labels allow. */
const RADIUS_TRIALS = [1, 0.94, 0.88, 0.82, 0.76];
/** Bare maps (no labels at all) keep this much breathing room. */
const BARE_FILL = 0.86;

/** Side of the square colour chip shown before outside feature labels. */
export function labelChipSize(fontSize: number): number {
  return Math.round(fontSize * 0.64);
}

interface RadialPlan {
  band: number;
  laneGap: number;
  laneCount: number;
  insideFont: number;
  orfLaneCount: number;
  rulerFont: number;
  rulerLabels: boolean;
  /** Ticks are drawn (false on tiny maps where an unnumbered ruler would only crowd the centre). */
  ruler: boolean;
  rulerRadius: number;
  centreRadius: number;
}

function sizeBand(R: number): { band: number; laneGap: number } {
  if (R < 110) return { band: 9, laneGap: 2 };
  if (R < 160) return { band: 10.5, laneGap: 2 };
  if (R < 280) return { band: 12, laneGap: 2.5 };
  return { band: 13, laneGap: 3 };
}

function insideFontFor(band: number): number {
  if (band >= 13) return 10.5;
  if (band >= 12) return 10;
  if (band >= 10.5) return 9.5;
  return 0; // too thin for text
}

function planRadii(model: MapModel, R: number, rulerLabelWidth: (fontSize: number) => number): RadialPlan {
  let { band, laneGap } = sizeBand(R);
  const wanted = model.featureLanes;
  const orfLaneCount = Math.min(model.orfLanes, MAX_ORF_LANES);
  const orfDepth = orfLaneCount ? ORF_OFFSET + orfLaneCount * ORF_STEP - (ORF_STEP - ORF_W) : 0;
  const rulerFont = R < 150 ? 9 : 10;
  const labelW = rulerLabelWidth(rulerFont);
  let rulerLabels = R >= 115;
  const rulerSpace = () => RULER_GAP + MAJOR_TICK + (rulerLabels ? 3 + labelW + 3 : 2);
  const minCentre = Math.max(24, Math.min(110, R * 0.3));
  let avail = R - GAP0 - orfDepth - rulerSpace() - minCentre;
  if (avail < band && rulerLabels) {
    rulerLabels = false;
    avail = R - GAP0 - orfDepth - rulerSpace() - minCentre;
  }
  let laneCount = wanted;
  if (wanted > 0 && wanted * (band + laneGap) - laneGap > avail) {
    laneGap = 1.5;
    band = Math.max(6, (avail + laneGap) / wanted - laneGap);
    if (wanted * (band + laneGap) - laneGap > avail) {
      laneCount = Math.max(1, Math.floor((avail + laneGap) / (band + laneGap)));
    }
  }
  band = Math.round(band * 2) / 2;
  const featureDepth = laneCount > 0 ? laneCount * (band + laneGap) - laneGap : 0;
  const innermost = R - GAP0 - featureDepth - orfDepth;
  // Nothing drawn inside the backbone: the ticks hang straight off the backbone.
  const bare = laneCount === 0 && orfLaneCount === 0;
  const rulerRadius = bare ? R : innermost - RULER_GAP;
  let centreRadius = Math.max(12, rulerRadius - MAJOR_TICK - (rulerLabels ? 3 + labelW + 4 : 4));
  // Without numbers the ruler is decoration: drop it rather than squeeze the record name.
  const ruler = rulerLabels || bare || centreRadius >= 44;
  if (!ruler) centreRadius = Math.max(12, innermost - 6);
  return {
    band,
    laneGap,
    laneCount,
    insideFont: insideFontFor(band),
    orfLaneCount,
    rulerFont,
    rulerLabels,
    ruler,
    rulerRadius,
    centreRadius,
  };
}

function laneRadii(plan: RadialPlan, R: number, lane: number): { rIn: number; rOut: number } {
  const k = Math.min(lane, Math.max(0, plan.laneCount - 1));
  const rOut = R - GAP0 - k * (plan.band + plan.laneGap);
  return { rIn: rOut - plan.band, rOut };
}

/** Angles of a (normalized) range. */
function rangeAngles(scale: AngleScale, r: Range): { a0: number; a1: number } {
  return { a0: positionToAngle(scale, r.start), a1: positionToAngle(scale, r.end) };
}

/** Make an arc at least `minPx` long (centred on the original). */
function widenToPx(a0: number, a1: number, r: number, minPx: number): { a0: number; a1: number } {
  const min = pxToDegrees(minPx, r);
  if (a1 - a0 >= min) return { a0, a1 };
  const mid = (a0 + a1) / 2;
  return { a0: mid - min / 2, a1: mid + min / 2 };
}

function featureName(f: Feature): string {
  const name = f.name.replace(/\s+/g, ' ').trim();
  return name || f.type;
}

function tickLabelText(p: number, length: number): string {
  return length >= 100_000 ? formatCompactBp(p) : formatInt(p);
}

/** Index of the longest segment (the one that carries the label). */
function longestSegment(f: Feature): number {
  let best = 0;
  for (let k = 1; k < f.segments.length; k++) {
    const s = f.segments[k];
    const b = f.segments[best];
    if (s.end - s.start > b.end - b.start) best = k;
  }
  return best;
}

/** Size-dependent facts shared by the radius trials and the final geometry. */
interface Context {
  model: MapModel;
  W: number;
  H: number;
  cx: number;
  cy: number;
  scale: AngleScale;
  measure: TextMeasurer;
  small: boolean;
  margin: number;
  fontSize: number;
  lineHeight: number;
  chipW: number;
  /** Space outside the backbone used by ring decorations (cut ticks, primer arrows). */
  ringExtra: number;
  labelGap: number;
  elbow: number;
  rulerInfo: RulerSpec | null;
  rulerLabelWidth: (fontSize: number) => number;
  /** Feature names (inside labels and outside label text). */
  featureNames: string[];
  /** Outside label widths: features include the colour chip. */
  featureWidth: number[];
  enzymeWidth: number[];
  primerWidth: number[];
  /** Arc span (degrees) of each feature's longest segment. */
  featureSpan: number[];
}

const FEATURE_WEIGHT = 500;
const PRIMER_WEIGHT = 500;
const enzymeWeight = (e: EnzymeItem) => (e.unique ? 600 : 400);

/** Does feature i's name fit inside its arc at radius R? */
function insideFits(ctx: Context, R: number, plan: RadialPlan, i: number): boolean {
  if (!plan.insideFont) return false;
  const f = ctx.model.features[i];
  const lane = laneRadii(plan, R, f.lane);
  const rMid = (lane.rIn + lane.rOut) / 2;
  const head = f.feature.strand !== 0 ? Math.min(HEAD_PX, plan.band * 0.85) : 0;
  const avail = arcLength(rMid, ctx.featureSpan[i]) - head - 2 * INSIDE_PAD;
  if (avail <= 0) return false;
  return ctx.measure(ctx.featureNames[i], plan.insideFont, FEATURE_WEIGHT) <= avail;
}

/** Largest backbone radius that leaves room for labels `allowance` px wide (or none). */
function radiusLimit(ctx: Context, allowance: number, hasLabels: boolean): number {
  const { W, H, margin, ringExtra } = ctx;
  if (!hasLabels) return (Math.min(W, H) / 2 - margin - ringExtra) * BARE_FILL;
  const extra = ringExtra + ctx.labelGap;
  const rh = W / 2 - margin - allowance - extra - ATTACH_GAP - 2;
  const rv = H / 2 - margin - ctx.lineHeight / 2 - extra;
  return Math.min(rh, rv);
}

function labelFrameFor(ctx: Context, R: number): LabelFrame {
  const ringOuter = R + ctx.ringExtra;
  return {
    cx: ctx.cx,
    cy: ctx.cy,
    width: ctx.W,
    height: ctx.H,
    top: ctx.margin + ctx.lineHeight / 2,
    bottom: ctx.H - ctx.margin - ctx.lineHeight / 2,
    lineHeight: ctx.lineHeight,
    fontSize: ctx.fontSize,
    labelRadius: ringOuter + ctx.labelGap,
    ringOuter,
    elbowRadius: ringOuter + ctx.elbow,
    maxDisplacement: ctx.small ? 46 : 40,
    left: ctx.margin,
    right: ctx.W - ctx.margin,
    chipWidth: ctx.chipW,
    measure: ctx.measure,
  };
}

/** Outside label candidates at backbone radius R. */
function labelCandidates(ctx: Context, R: number, plan: RadialPlan): LabelCandidate[] {
  const { model, scale } = ctx;
  const L = model.length;
  const out: LabelCandidate[] = [];
  const seen = new Set<string>();
  model.features.forEach((item, i) => {
    if (insideFits(ctx, R, plan, i)) return;
    const text = ctx.featureNames[i];
    // Two annotations with the same name and extent (gene + CDS) share one outside label.
    const dedupe = `${ctx.featureNames[i]}|${item.extent.start}|${item.extent.end}`;
    if (seen.has(dedupe)) return;
    seen.add(dedupe);
    const f = item.feature;
    const seg = normalizeRange(f.segments[longestSegment(f)], L, model.topology);
    const a = rangeAngles(scale, seg);
    out.push({
      key: `f:${f.id}`,
      ref: { kind: 'feature', index: i },
      text,
      width: ctx.featureWidth[i],
      chip: featureFill(f),
      fontWeight: FEATURE_WEIGHT,
      tone: 'feature',
      angle: mod((a.a0 + a.a1) / 2, 360),
      anchorRadius: laneRadii(plan, R, item.lane).rOut,
      // Unnamed annotations ("misc_binding") say little: on small maps they yield to everything.
      priorityClass: item.named ? 1 : ctx.small ? 6 : 2,
      weight: item.length,
      featureId: f.id,
    });
  });
  model.primers.forEach((item, i) => {
    const text = item.name;
    const k = Math.min(item.lane, MAX_PRIMER_LANES - 1);
    const a = rangeAngles(scale, normalizeRange(item.site.range, L, model.topology));
    out.push({
      key: `p:${i}`,
      ref: { kind: 'primer', index: i },
      text,
      width: ctx.primerWidth[i],
      chip: null,
      fontWeight: PRIMER_WEIGHT,
      tone: item.site.strand === 1 ? 'primerFwd' : 'primerRev',
      angle: mod((a.a0 + a.a1) / 2, 360),
      anchorRadius: R + PRIMER_OFFSET + k * PRIMER_STEP + PRIMER_W,
      priorityClass: 5,
      weight: item.site.range.end - item.site.range.start,
    });
  });
  model.enzymes.forEach((item, i) => {
    const text = item.label;
    out.push({
      key: `e:${i}`,
      ref: { kind: 'enzyme', index: i },
      text,
      width: ctx.enzymeWidth[i],
      chip: null,
      fontWeight: enzymeWeight(item),
      tone: item.unique ? 'enzymeUnique' : 'enzyme',
      angle: mod(positionToAngle(scale, item.cut), 360),
      anchorRadius: R + TICK_OUT,
      priorityClass: item.unique ? 3 : 4,
      weight: 0,
    });
  });
  return out;
}

/** How much losing a label of each priority class costs when comparing radii. */
const DROP_COST = [1, 1, 0.45, 0.8, 0.35, 0.3, 0.2];

function dropCost(p: LabelPlacement): number {
  return p.droppedCost;
}

/**
 * Size-dependent geometry. Returns null until the container has a usable size.
 */
export function computeGeometry(model: MapModel, opts: GeometryOptions): MapGeometry | null {
  const { width: W, height: H, measure } = opts;
  if (!(W > 40 && H > 40)) return null;
  const L = model.length;
  const scale = createAngleScale(L, model.topology, opts.rotation ?? 0);
  const small = Math.min(W, H) < 520;
  const fontSize = small ? 10 : 11;
  const lineHeight = Math.round(fontSize * 1.3);
  const chipW = labelChipSize(fontSize) + LABEL_CHIP_GAP;

  const primerLaneCount = Math.min(model.primerLanes, MAX_PRIMER_LANES);
  const primerOuter = primerLaneCount ? PRIMER_OFFSET + primerLaneCount * PRIMER_STEP - (PRIMER_STEP - PRIMER_W) : 0;
  const rulerInfo = L > 0 ? rulerSpec(L) : null;
  const rulerWidthCache = new Map<number, number>();
  const rulerLabelWidth = (fs: number): number => {
    let w = rulerWidthCache.get(fs);
    if (w === undefined) {
      w = 0;
      if (rulerInfo) for (const p of rulerInfo.major) w = Math.max(w, measure(tickLabelText(p, L), fs, 400));
      rulerWidthCache.set(fs, w);
    }
    return w;
  };

  const featureNames = model.features.map((f) => featureName(f.feature));
  const dpb = (360 - scale.gap) / Math.max(1, L);
  const ctx: Context = {
    model,
    W,
    H,
    cx: W / 2,
    cy: H / 2,
    scale,
    measure,
    small,
    margin: small ? 10 : 16,
    fontSize,
    lineHeight,
    chipW,
    ringExtra: Math.max(model.enzymes.length ? TICK_OUT : 0, primerOuter, 1),
    labelGap: small ? 15 : 22,
    elbow: small ? 5 : 7,
    rulerInfo,
    rulerLabelWidth,
    featureNames,
    featureWidth: featureNames.map((t) => measure(t, fontSize, FEATURE_WEIGHT) + chipW),
    enzymeWidth: model.enzymes.map((e) => measure(e.label, fontSize, enzymeWeight(e))),
    primerWidth: model.primers.map((p) => measure(p.name, fontSize, PRIMER_WEIGHT)),
    featureSpan: model.features.map((f) => {
      const s = f.feature.segments[longestSegment(f.feature)];
      return (s.end - s.start) * dpb;
    }),
  };
  const fullFeatureWidth = ctx.featureWidth;

  // ---- Label allowance: label width the radius makes room for beside the circle. Longer
  // labels are truncated where they meet the edge of the view (rows near 12 and 6 o'clock,
  // above and below the circle, have more room than the ones beside it).
  const cap = Math.max(80, Math.min(180, W * 0.15));
  const maxOf = (ws: readonly number[]) => ws.reduce((m, w) => Math.max(m, w), 0);
  const fixed = Math.max(Math.min(maxOf(ctx.enzymeWidth), cap * 1.2), Math.min(maxOf(ctx.primerWidth), cap));
  const anyLabels = fixed > 0 || fullFeatureWidth.length > 0;
  let allowance = Math.max(fixed, Math.min(cap, maxOf(fullFeatureWidth)));
  let Rmax = radiusLimit(ctx, allowance, anyLabels);
  if (fullFeatureWidth.length && Rmax > 20) {
    // Only the features whose names do not fit inside their arcs need room outside.
    const plan0 = planRadii(model, Rmax, rulerLabelWidth);
    const outside = fullFeatureWidth.filter((_, i) => !insideFits(ctx, Rmax, plan0, i));
    allowance = Math.max(fixed, Math.min(cap, maxOf(outside)));
    Rmax = Math.max(Rmax, radiusLimit(ctx, allowance, fixed > 0 || outside.length > 0));
  }
  // ---- Radius: the largest trial whose labels fit (almost) as well as the best one. ----
  Rmax = Math.max(20, Math.floor(Rmax));
  type Trial = { R: number; plan: RadialPlan; candidates: LabelCandidate[]; frame: LabelFrame; placement: LabelPlacement };
  const trials: Trial[] = [];
  if (L === 0) Rmax = Math.max(20, Math.floor(Rmax * 0.62)); // empty state: a quiet, smaller circle
  const minR = Math.min(Rmax, 60);
  for (const f of L > 0 && anyLabels ? RADIUS_TRIALS : [1]) {
    const R = Math.max(minR, Math.floor(Rmax * f));
    if (trials.length && trials[trials.length - 1].R === R) continue;
    const plan = planRadii(model, R, rulerLabelWidth);
    const candidates = labelCandidates(ctx, R, plan);
    const frame = labelFrameFor(ctx, R);
    const placement = layoutLabels(candidates, frame, NO_PINS);
    trials.push({ R, plan, candidates, frame, placement });
    if (placement.hidden === 0) break; // nothing lost: no smaller radius can do better
  }
  const best = trials.reduce((m, t) => Math.min(m, dropCost(t.placement)), Infinity);
  const tolerance = best * 0.02 + 0.25;
  const chosen = trials.find((t) => dropCost(t.placement) <= best + tolerance) ?? trials[0];
  return buildGeometry(ctx, chosen.R, chosen.plan, chosen.candidates, chosen.frame, chosen.placement);
}

function buildGeometry(
  ctx: Context,
  R: number,
  plan: RadialPlan,
  candidates: LabelCandidate[],
  labelFrame: LabelFrame,
  basePlacement: LabelPlacement,
): MapGeometry {
  const { model, scale, cx, cy, measure } = ctx;
  const L = model.length;
  const ringOuter = R + ctx.ringExtra;

  // ---- Backbone ----------------------------------------------------------
  let backbone: string;
  let backboneEnds = '';
  if (L <= 0) {
    backbone = circlePath(cx, cy, R);
  } else if (model.topology === 'linear') {
    const a0 = positionToAngle(scale, 0);
    const a1 = positionToAngle(scale, L);
    backbone = arcPath(cx, cy, R, a0, a1);
    backboneEnds = `${radialLinePath(cx, cy, R - 4, R + 4, a0)} ${radialLinePath(cx, cy, R - 4, R + 4, a1)}`;
  } else {
    backbone = circlePath(cx, cy, R);
  }

  // ---- Features ------------------------------------------------------------
  const head = Math.min(HEAD_PX, plan.band * 0.85);
  const features: FeatureShape[] = model.features.map((item, i) => {
    const f = item.feature;
    const { rIn, rOut } = laneRadii(plan, R, item.lane);
    const rMid = (rIn + rOut) / 2;
    const ext = rangeAngles(scale, item.extent);
    const segs = f.segments.map((s) => {
      const a = rangeAngles(scale, normalizeRange(s, L, model.topology));
      return widenToPx(a.a0, a.a1, rMid, 2);
    });
    // The 3' end: last segment for the top strand, first segment for the bottom strand.
    const headSeg = f.strand === 1 ? segs.length - 1 : f.strand === -1 ? 0 : -1;
    const d = segs
      .map((s, k) => arrowPath(cx, cy, rIn, rOut, s.a0, s.a1, k === headSeg ? (f.strand as 1 | -1) : 0, head))
      .join(' ');
    let connectors = '';
    for (let k = 0; k + 1 < segs.length; k++) {
      const from = segs[k].a1;
      let to = segs[k + 1].a0;
      if (model.topology === 'circular') {
        while (to < from) to += 360;
        if (to - from >= 360) to -= 360;
      }
      if (to - from > 0.05) connectors += `${arcPath(cx, cy, rMid, from, to)} `;
    }
    const fill = featureFill(f);
    const shape: FeatureShape = {
      index: i,
      id: f.id,
      item,
      lane: Math.min(item.lane, Math.max(0, plan.laneCount - 1)),
      rIn,
      rOut,
      a0: ext.a0,
      a1: ext.a1,
      segments: segs,
      d,
      connectors: connectors.trim(),
      fill,
      stroke: featureStroke(fill),
      inside: null,
    };
    if (insideFits(ctx, R, plan, i)) {
      const text = ctx.featureNames[i];
      shape.inside = insideLabel(shape, longestSegment(f), plan, head, cx, cy, text, measure(text, plan.insideFont, FEATURE_WEIGHT), `f${i}`);
    }
    return shape;
  });
  // Paint order: lanes beyond the available depth share the last lane, so draw long features
  // first and short ones on top.
  const featureOrder = features.map((_, i) => i);
  featureOrder.sort((a, b) => features[b].item.length - features[a].item.length || a - b);

  // ---- ORFs ------------------------------------------------------------------
  const innermostFeature =
    R - GAP0 - (plan.laneCount > 0 ? plan.laneCount * (plan.band + plan.laneGap) - plan.laneGap : 0);
  const orfs: OrfShape[] = model.orfs.map((item, index) => {
    const k = Math.min(item.lane, Math.max(0, plan.orfLaneCount - 1));
    const rOut = innermostFeature - ORF_OFFSET - k * ORF_STEP;
    const rIn = rOut - ORF_W;
    const ra = rangeAngles(scale, normalizeRange(item.orf.range, L, model.topology));
    const a = widenToPx(ra.a0, ra.a1, rOut, 3);
    return {
      index,
      item,
      rIn,
      rOut,
      a0: a.a0,
      a1: a.a1,
      d: thinArrowPath(cx, cy, (rIn + rOut) / 2, ORF_SHAFT, ORF_W, 6, a.a0, a.a1, item.orf.strand),
    };
  });

  // ---- Primers ----------------------------------------------------------------
  const primers: PrimerShape[] = model.primers.map((item, index) => {
    const k = Math.min(item.lane, MAX_PRIMER_LANES - 1);
    const rIn = R + PRIMER_OFFSET + k * PRIMER_STEP;
    const rOut = rIn + PRIMER_W;
    const ra = rangeAngles(scale, normalizeRange(item.site.range, L, model.topology));
    const a = widenToPx(ra.a0, ra.a1, rOut, 4);
    return {
      index,
      item,
      rIn,
      rOut,
      a0: a.a0,
      a1: a.a1,
      d: thinArrowPath(cx, cy, (rIn + rOut) / 2, PRIMER_SHAFT, PRIMER_W, 6, a.a0, a.a1, item.site.strand),
    };
  });

  // ---- Enzymes ----------------------------------------------------------------
  const enzymes: EnzymeShape[] = model.enzymes.map((item, index) => {
    const cutAngles = item.cuts.map((c) => positionToAngle(scale, c));
    return {
      index,
      item,
      angle: cutAngles[0],
      cutAngles,
      d: cutAngles.map((a) => radialLinePath(cx, cy, R - TICK_IN, R + TICK_OUT, a)).join(' '),
    };
  });

  // ---- Ruler ----------------------------------------------------------------------
  let ruler: RulerShape | null = null;
  const rulerInfo = ctx.rulerInfo;
  if (rulerInfo && plan.ruler && plan.rulerRadius > 16) {
    const rr = plan.rulerRadius;
    const pxPerMinor = arcLength(rr, rulerInfo.minorStep * ((360 - scale.gap) / Math.max(1, L)));
    let major = '';
    let minor = '';
    const labels: TextItem[] = [];
    for (const p of rulerInfo.major) {
      const a = positionToAngle(scale, p);
      major += `${radialLinePath(cx, cy, rr, rr - MAJOR_TICK, a)} `;
      if (plan.rulerLabels) {
        const text = tickLabelText(p, L);
        const w = measure(text, plan.rulerFont, 400);
        // Keep the text box clear of the tick: its extent along the radius depends on the angle.
        const ext = Math.abs(Math.sin(a * DEG)) * (w / 2) + Math.abs(Math.cos(a * DEG)) * plan.rulerFont * 0.55;
        const pt = polarToCartesian(cx, cy, rr - MAJOR_TICK - 3 - ext, a);
        labels.push({ x: pt.x, y: pt.y + plan.rulerFont * 0.35, text });
      }
    }
    if (rulerInfo.minorStep < rulerInfo.step && pxPerMinor >= 5) {
      for (let p = rulerInfo.minorStep; p < L; p += rulerInfo.minorStep) {
        if (p % rulerInfo.step === 0) continue;
        minor += `${radialLinePath(cx, cy, rr, rr - MINOR_TICK, positionToAngle(scale, p))} `;
      }
    }
    const a0 = positionToAngle(scale, 0);
    ruler = {
      radius: rr,
      circle:
        rr >= R - 0.5
          ? ''
          : model.topology === 'linear'
            ? arcPath(cx, cy, rr, positionToAngle(scale, 0), positionToAngle(scale, L))
            : circlePath(cx, cy, rr),
      major: major.trim(),
      minor: minor.trim(),
      origin: radialLinePath(cx, cy, rr + 1, rr - MAJOR_TICK - 1, a0),
      labels,
      fontSize: plan.rulerFont,
    };
  }

  // ---- Centre text --------------------------------------------------------------------
  const centreRadius = L > 0 ? plan.centreRadius : R;
  const rawName = model.record.name.trim() || 'Untitled';
  const nameRoom = (size: number) => Math.max(0, 2 * Math.sqrt(Math.max(0, centreRadius ** 2 - size ** 2)) - 8);
  let nameSize = Math.round(Math.max(11, Math.min(22, 9.5 + centreRadius * 0.04, centreRadius * 0.2)) * 2) / 2;
  // Long names first get a somewhat smaller font, then an ellipsis.
  const minNameSize = Math.max(10, Math.round(nameSize * 0.72 * 2) / 2);
  while (nameSize > minNameSize && measure(rawName, nameSize, 600) > nameRoom(nameSize)) nameSize -= 0.5;
  const detailSize = Math.max(10, Math.round(Math.max(nameSize, 12) * 0.72));
  const name = truncateToWidth(rawName, nameRoom(nameSize), nameSize, 600, measure);
  let detail = formatBp(L);
  if (model.topology === 'linear' && L > 0) detail += ' · linear';
  let note = '';
  if (L === 0) note = 'Empty sequence';
  else if (model.record.features.length === 0) note = 'No features';
  const lines = note ? 3 : 2;
  const blockH = nameSize * 1.25 + detailSize * 1.35 + (lines === 3 ? detailSize * 1.35 : 0);
  const top = cy - blockH / 2;
  const centre: CentreText = {
    name,
    nameSize,
    nameY: top + nameSize * 0.95,
    detail,
    detailSize,
    detailY: top + nameSize * 1.25 + detailSize * 1.05,
    note,
    noteY: top + nameSize * 1.25 + detailSize * 2.4,
  };

  const lanes = Array.from({ length: plan.laneCount }, (_, k) => laneRadii(plan, R, k));

  return {
    model,
    width: ctx.W,
    height: ctx.H,
    cx,
    cy,
    scale,
    radius: R,
    ringOuter,
    labelRadius: labelFrame.labelRadius,
    labelFontSize: ctx.fontSize,
    labelLineHeight: ctx.lineHeight,
    margin: ctx.margin,
    band: plan.band,
    backbone,
    backboneEnds,
    features,
    featureOrder,
    lanes,
    primers,
    orfs,
    enzymes,
    ruler,
    centre,
    candidates,
    labelFrame,
    basePlacement,
    dragInner: Math.max(10, Math.min(R * 0.2, centreRadius * 0.5)),
    dragOuter: ringOuter + 10,
    centreRadius,
  };
}

/** Curved label inside a feature band (on its longest segment), never upside down. */
function insideLabel(
  shape: FeatureShape,
  segIndex: number,
  plan: RadialPlan,
  headPx: number,
  cx: number,
  cy: number,
  text: string,
  textWidth: number,
  key: string,
): InsideLabel {
  const f = shape.item.feature;
  const seg = shape.segments[segIndex];
  const rMid = (shape.rIn + shape.rOut) / 2;
  const headSeg = f.strand === 1 ? shape.segments.length - 1 : f.strand === -1 ? 0 : -1;
  const head = segIndex === headSeg ? pxToDegrees(headPx, rMid) : 0;
  // Centre the text on the body of the arrow (the arc without its head).
  const b0 = seg.a0 + (f.strand === -1 ? head : 0);
  const b1 = seg.a1 - (f.strand === 1 ? head : 0);
  const centre = (b0 + b1) / 2;
  const c = mod(centre, 360);
  const flip = c > 90 && c < 270;
  const fs = plan.insideFont;
  // Baseline offset that centres lower-case-heavy labels optically in the band.
  const baseline = flip ? rMid + fs * 0.34 : rMid - fs * 0.34;
  const half = pxToDegrees(textWidth / 2 + 8, baseline);
  const d = flip
    ? arcPath(cx, cy, baseline, centre + half, centre - half)
    : arcPath(cx, cy, baseline, centre - half, centre + half);
  return { key, d, text, fontSize: fs };
}

// ---------------------------------------------------------------------------
// Stage 3: outside label placement
// ---------------------------------------------------------------------------

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface PlacedLabel {
  candidate: LabelCandidate;
  /** Text shown: the candidate's text, shortened with an ellipsis if its row is too narrow. */
  text: string;
  /** Width of the label (chip + text) as shown. */
  width: number;
  /** 1 = right of the circle (text starts at x), -1 = left (text ends at x). */
  side: 1 | -1;
  x: number;
  /** Vertical centre of the label row. */
  y: number;
  /** Text baseline. */
  baseline: number;
  /** Label box (chip + text): used for hit testing and overlap checks. */
  box: Box;
  /** Leader line path: radial stub from the anchor, then straight to the label. */
  leader: string;
}

export interface LabelNote {
  x: number;
  y: number;
  text: string;
  anchor: 'start' | 'middle' | 'end';
}

export interface LabelPlacement {
  labels: PlacedLabel[];
  /** Number of labels that did not fit. */
  hidden: number;
  /** Weighted cost of the hidden labels (see DROP_COST), used to compare radii. */
  droppedCost: number;
  notes: LabelNote[];
  byKey: Map<string, PlacedLabel>;
}

/**
 * Non-overlapping positions for rows of height `h` as close as possible (least squares) to
 * their `ideal` centres, keeping the input order and staying inside [lo, hi].
 * `ideal` must be sorted ascending. Pool-adjacent-violators on ideal[i] - i*h.
 */
export function spreadPositions(ideal: readonly number[], h: number, lo: number, hi: number): number[] {
  const n = ideal.length;
  if (n === 0) return [];
  const blocks: Array<{ sum: number; count: number }> = [];
  for (let i = 0; i < n; i++) {
    blocks.push({ sum: ideal[i] - i * h, count: 1 });
    while (blocks.length > 1) {
      const b = blocks[blocks.length - 1];
      const a = blocks[blocks.length - 2];
      if (a.sum / a.count <= b.sum / b.count) break;
      a.sum += b.sum;
      a.count += b.count;
      blocks.pop();
    }
  }
  const zHi = Math.max(lo, hi - (n - 1) * h);
  const out: number[] = [];
  let i = 0;
  for (const b of blocks) {
    const z = Math.min(zHi, Math.max(lo, b.sum / b.count));
    for (let k = 0; k < b.count; k++, i++) out.push(z + i * h);
  }
  return out;
}

type PinTest = (c: LabelCandidate) => boolean;

function comparePriority(isPinned: PinTest) {
  const cls = (c: LabelCandidate) => (isPinned(c) ? 0 : c.priorityClass);
  return (a: LabelCandidate, b: LabelCandidate) =>
    cls(a) - cls(b) || b.weight - a.weight || a.angle - b.angle || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
}

const NO_PINS: ReadonlySet<string> = new Set();

/** Angular window (degrees) around 12 and 6 o'clock where labels may switch sides. */
const POLE_ZONE = 24;

function clampInt(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Splits label candidates into the right (1) and left (-1) columns. Anchors right of the
 * vertical axis go right, the others left; near 12 and 6 o'clock the split point is moved so
 * a cluster there (typically a multiple cloning site next to the origin) is shared between
 * both columns instead of cascading far down one side.
 */
export function assignSides(candidates: readonly LabelCandidate[]): Map<LabelCandidate, 1 | -1> {
  const side = new Map<LabelCandidate, 1 | -1>();
  for (const c of candidates) side.set(c, c.angle < 180 ? 1 : -1);
  const quadrantLoad = (from: number, to: number) =>
    candidates.reduce((n, c) => n + (c.angle >= from && c.angle < to ? 1 : 0), 0);
  // Top: offsets from 0 deg in (-zone, zone]; the most counter-clockwise ones go left.
  {
    const near = candidates
      .map((c) => ({ c, d: c.angle > 180 ? c.angle - 360 : c.angle }))
      .filter((x) => Math.abs(x.d) <= POLE_ZONE)
      .sort((a, b) => a.d - b.d || (a.c.key < b.c.key ? -1 : 1));
    if (near.length > 1) {
      const leftLoad = quadrantLoad(270, 360 - POLE_ZONE);
      const rightLoad = quadrantLoad(POLE_ZONE, 90);
      const k = clampInt(Math.round((rightLoad - leftLoad + near.length) / 2), 0, near.length);
      near.forEach((x, i) => side.set(x.c, i < k ? -1 : 1));
    }
  }
  // Bottom: offsets from 180 deg; the most counter-clockwise ones (right of 6 o'clock) go right.
  {
    const near = candidates
      .map((c) => ({ c, d: c.angle - 180 }))
      .filter((x) => Math.abs(x.d) <= POLE_ZONE)
      .sort((a, b) => a.d - b.d || (a.c.key < b.c.key ? -1 : 1));
    if (near.length > 1) {
      const rightLoad = quadrantLoad(90, 180 - POLE_ZONE);
      const leftLoad = quadrantLoad(180 + POLE_ZONE, 270);
      const m = clampInt(Math.round((leftLoad - rightLoad + near.length) / 2), 0, near.length);
      near.forEach((x, i) => side.set(x.c, i < m ? 1 : -1));
    }
  }
  return side;
}

/**
 * Anchor angle unwrapped for a column, so the order along the column follows the circle:
 * right column in (-zone, 180 + zone], left column in [180 - zone, 360 + zone).
 */
function columnAngle(angle: number, side: 1 | -1): number {
  if (side === 1) return angle > 180 + POLE_ZONE ? angle - 360 : angle;
  return angle < 180 - POLE_ZONE ? angle + 360 : angle;
}

/** Row centre closest to the anchor: where the anchor's direction meets the label circle. */
function idealY(frame: LabelFrame, columnAngleDeg: number, side: 1 | -1): number {
  const lo = side === 1 ? 0 : 180;
  const a = Math.min(lo + 180, Math.max(lo, columnAngleDeg));
  return frame.cy - frame.labelRadius * Math.cos(a * DEG);
}

/** x of the near edge of a label row centred at y: rows hug the label circle. */
export function hugX(frame: LabelFrame, side: 1 | -1, y: number): number {
  const { cx, cy, labelRadius: Rl, lineHeight: h } = frame;
  const yTop = y - h / 2;
  const yBot = y + h / 2;
  const dyMin = yTop <= cy && yBot >= cy ? 0 : Math.min(Math.abs(yTop - cy), Math.abs(yBot - cy));
  const off = dyMin < Rl ? Math.sqrt(Rl * Rl - dyMin * dyMin) : 0;
  return cx + side * Math.max(off, POLE_INSET);
}

/**
 * Whether a label row at y is acceptable for a candidate: the label stays within
 * `maxDisplacement` of its anchor and the straight part of its leader stays outside the ring.
 */
function rowFits(frame: LabelFrame, c: LabelCandidate, side: 1 | -1, y: number): boolean {
  const ax = hugX(frame, side, y) - side * ATTACH_GAP;
  const labelAngle = Math.atan2(ax - frame.cx, frame.cy - y) / DEG;
  if (Math.abs(angleDelta(c.angle, labelAngle)) > frame.maxDisplacement) return false;
  const e = polarToCartesian(frame.cx, frame.cy, frame.elbowRadius, c.angle);
  return distanceToSegment(frame.cx, frame.cy, e.x, e.y, ax, y) >= frame.ringOuter + 0.5;
}

function leaderPath(frame: LabelFrame, c: LabelCandidate, endX: number, endY: number): string {
  const a = polarToCartesian(frame.cx, frame.cy, c.anchorRadius, c.angle);
  const e = polarToCartesian(frame.cx, frame.cy, frame.elbowRadius, c.angle);
  return `M ${r2(a.x)} ${r2(a.y)} L ${r2(e.x)} ${r2(e.y)} L ${r2(endX)} ${r2(endY)}`;
}

function r2(v: number): number {
  return Math.round(v * 100) / 100;
}

/**
 * Bounded variant of {@link spreadPositions}: row i must stay inside its window
 * [lo[i], hi[i]] (rows keep the input order and are at least `h` apart). Pool-adjacent-violators
 * with each pooled block clamped to the intersection of its members' windows. Returns null when
 * the rows cannot all fit their windows.
 */
export function spreadWithin(
  ideal: readonly number[],
  lo: readonly number[],
  hi: readonly number[],
  h: number,
): number[] | null {
  const n = ideal.length;
  const blocks: Array<{ sum: number; count: number; lo: number; hi: number; z: number }> = [];
  for (let i = 0; i < n; i++) {
    const b = { sum: ideal[i] - i * h, count: 1, lo: lo[i] - i * h, hi: hi[i] - i * h, z: 0 };
    if (b.lo > b.hi + 1e-9) return null;
    b.z = Math.min(b.hi, Math.max(b.lo, b.sum));
    blocks.push(b);
    while (blocks.length > 1) {
      const cur = blocks[blocks.length - 1];
      const prev = blocks[blocks.length - 2];
      if (prev.z <= cur.z + 1e-9) break;
      prev.sum += cur.sum;
      prev.count += cur.count;
      prev.lo = Math.max(prev.lo, cur.lo);
      prev.hi = Math.min(prev.hi, cur.hi);
      if (prev.lo > prev.hi + 1e-9) return null;
      prev.z = Math.min(prev.hi, Math.max(prev.lo, prev.sum / prev.count));
      blocks.pop();
    }
  }
  const out: number[] = [];
  let i = 0;
  for (const b of blocks) for (let k = 0; k < b.count; k++, i++) out.push(b.z + i * h);
  return out;
}

interface Window {
  ideal: number;
  lo: number;
  hi: number;
}

/**
 * Rows (centre y) where a label may sit in a column: an interval around its ideal row, as far
 * as {@link rowFits} holds (it degrades monotonically away from the ideal row). Rows beyond the
 * circle (above 12 / below 6 o'clock) stay close to a pole anchor's angle, so pole labels get
 * windows that reach into the free space outside the circle. Null when no row fits.
 */
function labelWindow(frame: LabelFrame, c: LabelCandidate, side: 1 | -1, top: number, bottom: number): Window | null {
  if (bottom < top) return null;
  const fits = (y: number) => rowFits(frame, c, side, y);
  let ideal = Math.min(bottom, Math.max(top, idealY(frame, columnAngle(c.angle, side), side)));
  if (!fits(ideal)) {
    // Clamped ideals (anchors near a pole of a crowded view) may not fit: try nearby rows.
    let found = Number.NaN;
    const step = frame.lineHeight / 2;
    for (let d = step; d <= 8 * frame.lineHeight && Number.isNaN(found); d += step) {
      if (ideal - d >= top && fits(ideal - d)) found = ideal - d;
      else if (ideal + d <= bottom && fits(ideal + d)) found = ideal + d;
    }
    if (Number.isNaN(found)) return null;
    ideal = found;
  }
  const edge = (to: number): number => {
    if (fits(to)) return to;
    let ok = ideal;
    let bad = to;
    while (Math.abs(bad - ok) > 0.5) {
      const mid = (ok + bad) / 2;
      if (fits(mid)) ok = mid;
      else bad = mid;
    }
    return ok;
  };
  return { ideal, lo: edge(top), hi: edge(bottom) };
}

interface ColumnEntry extends Window {
  c: LabelCandidate;
  /** Column angle (unwrapped) and key: the order along the column. */
  a: number;
}

interface Column {
  side: 1 | -1;
  kept: ColumnEntry[];
  ys: number[];
  capacity: number;
}

function columnOrder(side: 1 | -1) {
  return (p: ColumnEntry, q: ColumnEntry) => side * (p.a - q.a) || (p.c.key < q.c.key ? -1 : p.c.key > q.c.key ? 1 : 0);
}

const nearPole = (angle: number) => Math.min(angle, 360 - angle, Math.abs(angle - 180)) <= POLE_ZONE;

/** Try to add a label to a column; keeps the column unchanged when it does not fit. */
function tryInsert(col: Column, entry: ColumnEntry, h: number): boolean {
  const order = columnOrder(col.side);
  let lo = 0;
  let hi = col.kept.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (order(col.kept[mid], entry) < 0) lo = mid + 1;
    else hi = mid;
  }
  col.kept.splice(lo, 0, entry);
  const ys = spreadWithin(
    col.kept.map((e) => e.ideal),
    col.kept.map((e) => e.lo),
    col.kept.map((e) => e.hi),
    h,
  );
  if (ys) {
    col.ys = ys;
    return true;
  }
  col.kept.splice(lo, 1);
  return false;
}

/**
 * Admits labels in priority order. Each goes to its preferred column (labels near 12 and
 * 6 o'clock may fall back to the other one) if the column can still place every kept label
 * inside its window; otherwise it is dropped.
 */
function admitLabels(
  candidates: readonly LabelCandidate[],
  frame: LabelFrame,
  bottom: number,
  isPinned: PinTest,
  sideOf: ReadonlyMap<LabelCandidate, 1 | -1>,
): { columns: Column[]; dropped: number; droppedCost: number } {
  const h = frame.lineHeight;
  const top = frame.top;
  const capacity = bottom >= top ? Math.floor((bottom - top) / h + 1e-6) + 1 : 0;
  const right: Column = { side: 1, kept: [], ys: [], capacity };
  const left: Column = { side: -1, kept: [], ys: [], capacity };
  let dropped = 0;
  let droppedCost = 0;
  let rejected = 0;
  const rejectLimit = 4 * capacity + 16; // bounds the work on huge records
  for (const c of [...candidates].sort(comparePriority(isPinned))) {
    const pinned = isPinned(c);
    let ok = false;
    if (pinned || rejected < rejectLimit) {
      const preferred = sideOf.get(c) ?? 1;
      const sides: Array<1 | -1> = nearPole(c.angle) ? [preferred, preferred === 1 ? -1 : 1] : [preferred];
      for (const side of sides) {
        const col = side === 1 ? right : left;
        if (col.kept.length >= col.capacity) continue;
        const a = columnAngle(c.angle, side);
        const w = labelWindow(frame, c, side, top, bottom);
        if (w && tryInsert(col, { c, a, ...w }, h)) {
          ok = true;
          break;
        }
        if (pinned) {
          // Pinned labels are shown even if they have to sit further from their anchor.
          const ideal = Math.min(bottom, Math.max(top, idealY(frame, a, side)));
          if (tryInsert(col, { c, a, ideal, lo: top, hi: bottom }, h)) {
            ok = true;
            break;
          }
        }
      }
    }
    if (!ok) {
      dropped++;
      droppedCost += DROP_COST[c.priorityClass] ?? 0.3;
      rejected++;
    }
  }
  return { columns: [right, left], dropped, droppedCost };
}

/**
 * Lays out outside labels SnapGene-style: each side of the circle is a column of rows,
 * ordered like their anchors, spread vertically (least displacement) and hugging a circle
 * around the map, each joined to its anchor by a leader (a short radial stub, then a straight
 * line that never cuts into the ring). Labels are admitted by priority (pinned > named
 * features, longer first > unnamed features > unique cutters > other enzymes > primers);
 * those that cannot be placed near their anchor are dropped and a "+N more" note is shown.
 */
export function layoutLabels(
  candidates: readonly LabelCandidate[],
  frame: LabelFrame,
  pinned: ReadonlySet<string> = NO_PINS,
): LabelPlacement {
  const isPinned: PinTest = (c) => c.featureId !== undefined && pinned.has(c.featureId);
  const sideOf = assignSides(candidates);
  let run = admitLabels(candidates, frame, frame.bottom, isPinned, sideOf);
  const notes: LabelNote[] = [];
  if (run.dropped > 0 && frame.bottom - frame.lineHeight >= frame.top) {
    // The bottom row of both columns carries the "+N more" note.
    run = admitLabels(candidates, frame, frame.bottom - frame.lineHeight, isPinned, sideOf);
    // (Admission is greedy: with the row reserved everything may fit after all.)
    if (run.dropped > 0) notes.push({ x: frame.cx, y: frame.bottom + frame.fontSize * 0.35, text: '', anchor: 'middle' });
  }
  const result: LabelPlacement = {
    labels: [],
    hidden: run.dropped,
    droppedCost: run.droppedCost,
    notes,
    byKey: new Map(),
  };
  const h = frame.lineHeight;
  for (const { side, kept, ys } of run.columns) {
    kept.forEach(({ c }, i) => {
      const y = ys[i];
      const x = hugX(frame, side, y);
      let text = c.text;
      let width = c.width;
      const room = side === 1 ? frame.right - x : x - frame.left;
      if (width > room + 0.5) {
        const chip = c.chip ? frame.chipWidth : 0;
        text = truncateToWidth(c.text, room - chip, frame.fontSize, c.fontWeight, frame.measure);
        width = chip + (text ? frame.measure(text, frame.fontSize, c.fontWeight) : 0);
        if (!text) {
          result.hidden++;
          return;
        }
      }
      const box: Box =
        side === 1 ? { x0: x, y0: y - h / 2, x1: x + width, y1: y + h / 2 } : { x0: x - width, y0: y - h / 2, x1: x, y1: y + h / 2 };
      const placed: PlacedLabel = {
        candidate: c,
        text,
        width,
        side,
        x,
        y,
        baseline: y + frame.fontSize * 0.35,
        box,
        leader: leaderPath(frame, c, x - side * ATTACH_GAP, y),
      };
      result.labels.push(placed);
      result.byKey.set(c.key, placed);
    });
  }
  for (const n of notes) n.text = `+${formatInt(result.hidden)} more`;
  if (result.hidden === 0) result.notes = [];
  return result;
}

/**
 * Outside label layout for a geometry. Without pins this is `geometry.basePlacement`;
 * `pinned` feature ids (selected / highlighted) get the highest priority.
 */
export function placeLabels(geom: MapGeometry, pinned: ReadonlySet<string> = NO_PINS): LabelPlacement {
  if (pinned.size === 0) return geom.basePlacement;
  return layoutLabels(geom.candidates, geom.labelFrame, pinned);
}

/** True if any two placed label boxes overlap (used by tests and debug assertions). */
export function labelsOverlap(labels: readonly PlacedLabel[], epsilon = 0.01): boolean {
  for (let i = 0; i < labels.length; i++) {
    for (let j = i + 1; j < labels.length; j++) {
      const a = labels[i].box;
      const b = labels[j].box;
      if (a.x0 < b.x1 - epsilon && b.x0 < a.x1 - epsilon && a.y0 < b.y1 - epsilon && b.y0 < a.y1 - epsilon) return true;
    }
  }
  return false;
}
