/**
 * Layout of the circular map, in three memoizable stages:
 *
 *   1. buildMapModel   (record + annotations)      lane packing, unique cutters, label texts
 *   2. computeGeometry (model + size + rotation)   radii, SVG paths, inside labels, label candidates
 *   3. placeLabels     (geometry + pinned ids)     outside labels: sides, spreading, leaders, dropping
 *
 * Radial structure, from the outside in:
 *
 *   outside labels   (left / right of the circle, spread vertically, leader lines)
 *   primer arrows    (thin, just outside the backbone, stacked outwards)
 *   enzyme cut ticks (crossing the backbone)
 *   backbone         (radius R)
 *   feature lanes    (lane 0 hugs the backbone, further lanes stack inwards)
 *   ORF lanes        (thin arcs inside the features)
 *   ruler            (ticks + numbers, just inside the annotations)
 *   centre text      (record name + length)
 */
import type { EnzymeSite, Feature, Orf, PrimerBindingSite, Range, SeqRecord, Topology } from '@hhereditas/core';
import { featureExtent, featureLength, mod, normalizeRange } from '@hhereditas/core';
import { featureFill, featureStroke } from '../common/colors';
import { formatBp, formatCompactBp, formatInt } from '../common/format';
import {
  type AngleScale,
  DEG,
  arcLength,
  arcPath,
  arrowPath,
  circlePath,
  createAngleScale,
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
  /** Every top-strand cut of the site. */
  cuts: number[];
  /** "EcoRI (396)": 1-based position of the base 5' of the top-strand cut. */
  label: string;
  /** The enzyme cuts the record exactly once (among the given sites). */
  unique: boolean;
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

/** Clearance between neighbours on a lane, as a fraction of the molecule. */
const LANE_PADDING = 0;

/** 1-based number shown in an enzyme label for a top-strand cut at gap `p`. */
export function cutLabelPosition(p: number, length: number, topology: Topology): number {
  if (topology === 'circular' && length > 0) return mod(p - 1, length) + 1;
  return Math.max(1, p);
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
  const pad = length * LANE_PADDING;

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
      pad,
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
      return {
        site,
        cut,
        cuts,
        label: `${site.enzyme} (${formatInt(num)})`,
        unique: cutCount.get(site.enzyme) === 1,
      };
    });
  }

  if (layers.primers !== false && input.primerSites) {
    const names = new Map(record.primers.map((p) => [p.id, p.name] as const));
    const ranges = input.primerSites.map((s) => normalizeRange(s.range, length, topology));
    const lanes = assignLanes(ranges, length, topology, pad);
    model.primers = input.primerSites.map((site, i) => ({
      site,
      name: names.get(site.primerId)?.trim() || 'Primer',
      lane: lanes[i],
    }));
    model.primerLanes = laneCountOf(lanes);
  }

  if (layers.orfs !== false && input.orfs) {
    const ranges = input.orfs.map((o) => normalizeRange(o.range, length, topology));
    const lanes = assignLanes(ranges, length, topology, pad);
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
  /** Index into model.features. */
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
  /** Angles of each segment (for hit testing). */
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

/** Reference from a label to the shape it describes. */
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
  /** 1 named feature, 2 unnamed feature, 3 unique cutter, 4 other enzyme, 5 primer (0 = pinned). */
  priorityClass: number;
  /** Secondary priority within a class (larger first): feature / primer length. */
  weight: number;
  featureId?: string;
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
  features: FeatureShape[];
  /** Radii of each drawn feature lane. */
  lanes: Array<{ rIn: number; rOut: number }>;
  primers: PrimerShape[];
  orfs: OrfShape[];
  enzymes: EnzymeShape[];
  ruler: RulerShape | null;
  centre: CentreText;
  candidates: LabelCandidate[];
  /** Pointer radius range in which a press starts a drag selection. */
  dragInner: number;
  dragOuter: number;
  /** Radius available for the centre text. */
  centreRadius: number;
}

export interface GeometryOptions {
  width: number;
  height: number;
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
const LEADER = 18; // ring outer -> label circle (small maps use LEADER_SMALL)
const LEADER_SMALL = 13;
const INSIDE_PAD = 5; // inside label clearance at each end
const HEAD_PX = 9; // arrowhead length
export const LABEL_CHIP_GAP = 4; // colour chip -> label text

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

function planRadii(model: MapModel, R: number, rulerLabelWidth: number): RadialPlan {
  let { band, laneGap } = sizeBand(R);
  const wanted = model.featureLanes;
  const orfLaneCount = Math.min(model.orfLanes, MAX_ORF_LANES);
  const orfDepth = orfLaneCount ? ORF_OFFSET + orfLaneCount * ORF_STEP - (ORF_STEP - ORF_W) : 0;
  const rulerFont = R < 150 ? 9 : 10;
  let rulerLabels = R >= 115;
  const rulerSpace = () => RULER_GAP + MAJOR_TICK + (rulerLabels ? 3 + rulerLabelWidth + 3 : 2);
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
  const centreRadius = Math.max(
    12,
    rulerRadius - MAJOR_TICK - (rulerLabels ? 3 + rulerLabelWidth + 4 : 4),
  );
  return {
    band,
    laneGap,
    laneCount,
    insideFont: insideFontFor(band),
    orfLaneCount,
    rulerFont,
    rulerLabels,
    rulerRadius,
    centreRadius,
  };
}

function laneRadii(plan: RadialPlan, R: number, lane: number): { rIn: number; rOut: number } {
  const k = Math.min(lane, Math.max(0, plan.laneCount - 1));
  const rOut = R - GAP0 - k * (plan.band + plan.laneGap);
  return { rIn: rOut - plan.band, rOut };
}

function sinDeg(a: number): number {
  return Math.sin(a * DEG);
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

/**
 * Size-dependent geometry. Returns null until the container has a usable size.
 */
export function computeGeometry(model: MapModel, opts: GeometryOptions): MapGeometry | null {
  const { width: W, height: H, measure } = opts;
  if (!(W > 40 && H > 40)) return null;
  const L = model.length;
  const scale = createAngleScale(L, model.topology, opts.rotation ?? 0);
  const cx = W / 2;
  const cy = H / 2;
  const small = Math.min(W, H) < 520;
  const margin = small ? 8 : 14;
  const labelFontSize = small ? 10 : 11;
  const labelLineHeight = Math.round(labelFontSize * 1.3);
  const chipW = labelChipSize(labelFontSize) + LABEL_CHIP_GAP;

  // Space outside the backbone used by ring decorations.
  const primerLaneCount = Math.min(model.primerLanes, MAX_PRIMER_LANES);
  const primerOuter = primerLaneCount ? PRIMER_OFFSET + primerLaneCount * PRIMER_STEP - (PRIMER_STEP - PRIMER_W) : 0;
  const ringExtra = Math.max(model.enzymes.length ? TICK_OUT : 0, primerOuter, 1);

  // Label texts and widths (independent of R).
  const featureLabelWeight = 500;
  const featureTexts = model.features.map((f) => featureName(f.feature));
  const enzymeWeight = (e: EnzymeItem) => (e.unique ? 600 : 400);
  const allowanceCap = Math.max(64, Math.min(170, W * 0.16));
  const leaderGap = small ? LEADER_SMALL : LEADER;
  const rulerFontGuess = Math.min(W, H) < 340 ? 9 : 10;
  const rulerInfo = L > 0 ? rulerSpec(L) : null;
  const rulerLabelWidth = rulerInfo
    ? Math.max(
        0,
        ...rulerInfo.major.map((p) => measure(tickLabelText(p, L), rulerFontGuess, 400)),
      )
    : 0;

  const fixedWidths: number[] = [];
  for (const e of model.enzymes) fixedWidths.push(measure(e.label, labelFontSize, enzymeWeight(e)));
  for (const p of model.primers) fixedWidths.push(measure(p.name, labelFontSize, 500));
  const featureWidths = featureTexts.map((t) => measure(t, labelFontSize, featureLabelWeight) + chipW);

  const radiusFor = (allowance: number, hasLabels: boolean): number => {
    if (!hasLabels) return Math.min(W, H) / 2 - margin - ringExtra;
    const extra = ringExtra + leaderGap;
    const rh = W / 2 - margin - allowance - extra - 4;
    const rv = H / 2 - margin - labelLineHeight / 2 - extra;
    return Math.min(rh, rv);
  };

  // Does a feature's label fit inside its arc at radius R?
  const insideFits = (R: number, plan: RadialPlan, i: number): boolean => {
    if (!plan.insideFont) return false;
    const f = model.features[i];
    const lane = laneRadii(plan, R, f.lane);
    const rMid = (lane.rIn + lane.rOut) / 2;
    const span = longestSegmentDegrees(f, scale);
    const head = f.feature.strand !== 0 ? HEAD_PX : 0;
    const avail = arcLength(rMid, span) - head - 2 * INSIDE_PAD;
    if (avail <= 0) return false;
    return measure(featureTexts[i], plan.insideFont, 500) <= avail;
  };

  // Pass 1: room for every label; pass 2: only for labels that end up outside.
  const maxOf = (ws: number[]) => ws.reduce((m, w) => Math.max(m, w), 0);
  let allowance = Math.min(allowanceCap, Math.max(maxOf(fixedWidths), maxOf(featureWidths)));
  let hasLabels = fixedWidths.length + featureWidths.length > 0;
  let R = radiusFor(allowance, hasLabels);
  if (featureWidths.length && R > 20) {
    const plan0 = planRadii(model, R, rulerLabelWidth);
    const outsideWidths = featureWidths.filter((_, i) => !insideFits(R, plan0, i));
    allowance = Math.min(allowanceCap, Math.max(maxOf(fixedWidths), maxOf(outsideWidths)));
    hasLabels = fixedWidths.length + outsideWidths.length > 0;
    R = Math.max(R, radiusFor(allowance, hasLabels));
  }
  R = Math.max(20, Math.floor(R));
  const plan = planRadii(model, R, rulerLabelWidth);
  const ringOuter = R + ringExtra;
  const labelRadius = ringOuter + leaderGap;

  // ---- Backbone ----------------------------------------------------------
  let backbone: string;
  let backboneEnds = '';
  if (model.topology === 'linear' && L > 0) {
    const a0 = positionToAngle(scale, 0);
    const a1 = positionToAngle(scale, L);
    backbone = arcPath(cx, cy, R, a0, a1);
    backboneEnds = `${radialLinePath(cx, cy, R - 4, R + 4, a0)} ${radialLinePath(cx, cy, R - 4, R + 4, a1)}`;
  } else {
    backbone = circlePath(cx, cy, R);
  }

  // ---- Features ------------------------------------------------------------
  const features: FeatureShape[] = [];
  const candidates: LabelCandidate[] = [];
  const seenLabels = new Set<string>();
  const featureOrder = model.features.map((_, i) => i);
  // Draw outer lanes last so arrowheads of inner lanes never cover them; long features first within a lane.
  featureOrder.sort((a, b) => model.features[b].lane - model.features[a].lane || model.features[b].length - model.features[a].length);
  for (const i of featureOrder) {
    const item = model.features[i];
    const f = item.feature;
    const { rIn, rOut } = laneRadii(plan, R, item.lane);
    const rMid = (rIn + rOut) / 2;
    const ext = rangeAngles(scale, item.extent);
    const segs = f.segments.map((s) => {
      const r = normalizeRange(s, L, model.topology);
      const a = rangeAngles(scale, r);
      return widenToPx(a.a0, a.a1, rMid, 2);
    });
    // The 3' end: last segment for the top strand, first segment start for the bottom strand.
    const headSeg = f.strand === 1 ? segs.length - 1 : f.strand === -1 ? 0 : -1;
    const head = Math.min(HEAD_PX, plan.band * 0.85);
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
    const text = featureTexts[i];
    const shapeIndex = features.length;
    features.push(shape);
    if (insideFits(R, plan, i)) {
      shape.inside = insideLabel(shape, plan, cx, cy, text, measure(text, plan.insideFont, 500), `f${i}`);
    } else {
      // Two annotations with the same name and extent (gene + CDS) share one outside label.
      const dedupe = `${text}|${item.extent.start}|${item.extent.end}`;
      if (!seenLabels.has(dedupe)) {
        seenLabels.add(dedupe);
        const label = truncateToWidth(text, allowance - chipW, labelFontSize, featureLabelWeight, measure);
        if (label) {
          candidates.push({
            key: `f:${f.id}`,
            ref: { kind: 'feature', index: shapeIndex },
            text: label,
            width: measure(label, labelFontSize, featureLabelWeight) + chipW,
            chip: fill,
            fontWeight: featureLabelWeight,
            tone: 'feature',
            angle: mod((ext.a0 + ext.a1) / 2, 360),
            anchorRadius: rOut,
            priorityClass: item.named ? 1 : 2,
            weight: item.length,
            featureId: f.id,
          });
        }
      }
    }
  }

  // ---- ORFs ------------------------------------------------------------------
  const innermostFeature = R - GAP0 - (plan.laneCount > 0 ? plan.laneCount * (plan.band + plan.laneGap) - plan.laneGap : 0);
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
  primers.forEach((p) => {
    const label = truncateToWidth(p.item.name, allowance, labelFontSize, 500, measure);
    if (!label) return;
    candidates.push({
      key: `p:${p.index}`,
      ref: { kind: 'primer', index: p.index },
      text: label,
      width: measure(label, labelFontSize, 500),
      chip: null,
      fontWeight: 500,
      tone: p.item.site.strand === 1 ? 'primerFwd' : 'primerRev',
      angle: mod((p.a0 + p.a1) / 2, 360),
      anchorRadius: p.rOut,
      priorityClass: 5,
      weight: p.item.site.range.end - p.item.site.range.start,
    });
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
  enzymes.forEach((e) => {
    const weight = enzymeWeight(e.item);
    const label = truncateToWidth(e.item.label, allowance, labelFontSize, weight, measure);
    if (!label) return;
    candidates.push({
      key: `e:${e.index}`,
      ref: { kind: 'enzyme', index: e.index },
      text: label,
      width: measure(label, labelFontSize, weight),
      chip: null,
      fontWeight: weight,
      tone: e.item.unique ? 'enzymeUnique' : 'enzyme',
      angle: mod(e.angle, 360),
      anchorRadius: R + TICK_OUT,
      priorityClass: e.item.unique ? 3 : 4,
      weight: 0,
    });
  });

  // ---- Ruler ----------------------------------------------------------------------
  let ruler: RulerShape | null = null;
  if (rulerInfo && plan.rulerRadius > 16) {
    const rr = plan.rulerRadius;
    const dpb = 360 / Math.max(1, L);
    const pxPerMinor = arcLength(rr, rulerInfo.minorStep * dpb);
    let major = '';
    let minor = '';
    const labels: TextItem[] = [];
    for (const p of rulerInfo.major) {
      const a = positionToAngle(scale, p);
      major += `${radialLinePath(cx, cy, rr, rr - MAJOR_TICK, a)} `;
      if (plan.rulerLabels) {
        const text = tickLabelText(p, L);
        const w = measure(text, plan.rulerFont, 400);
        const ext = Math.abs(sinDeg(a)) * (w / 2) + Math.abs(Math.cos(a * DEG)) * plan.rulerFont * 0.55;
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
  const centreRadius = plan.centreRadius;
  const nameSize = Math.round(Math.max(12, Math.min(22, 9.5 + centreRadius * 0.04, centreRadius * 0.2)) * 2) / 2;
  const detailSize = Math.max(10, Math.round(nameSize * 0.72));
  const nameMax = Math.max(0, 2 * Math.sqrt(Math.max(0, centreRadius ** 2 - nameSize ** 2)) - 12);
  const name = truncateToWidth(model.record.name || 'Untitled', nameMax, nameSize, 600, measure);
  let detail = L > 0 ? formatBp(L) : '0 bp';
  if (model.topology === 'linear' && L > 0) detail += ' · linear';
  let note = '';
  if (L === 0) note = 'Empty sequence';
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
    width: W,
    height: H,
    cx,
    cy,
    scale,
    radius: R,
    ringOuter,
    labelRadius,
    labelFontSize,
    labelLineHeight,
    margin,
    band: plan.band,
    backbone,
    backboneEnds,
    features,
    lanes,
    primers,
    orfs,
    enzymes,
    ruler,
    centre,
    candidates,
    dragInner: Math.max(10, R * 0.2),
    dragOuter: ringOuter + 10,
    centreRadius,
  };
}

/** Angular span (degrees) of a feature's longest segment. */
function longestSegmentDegrees(f: FeatureItem, scale: AngleScale): number {
  let best = 0;
  const dpb = (360 - scale.gap) / Math.max(1, scale.length);
  for (const s of f.feature.segments) best = Math.max(best, (s.end - s.start) * dpb);
  return best;
}

/** Curved label inside a feature band, oriented so it never reads upside down. */
function insideLabel(
  shape: FeatureShape,
  plan: RadialPlan,
  cx: number,
  cy: number,
  text: string,
  textWidth: number,
  key: string,
): InsideLabel {
  const f = shape.item.feature;
  // Longest segment carries the label.
  let seg = shape.segments[0];
  for (const s of shape.segments) if (s.a1 - s.a0 > seg.a1 - seg.a0) seg = s;
  const rMid = (shape.rIn + shape.rOut) / 2;
  const segIndex = shape.segments.indexOf(seg);
  const headSeg = f.strand === 1 ? shape.segments.length - 1 : f.strand === -1 ? 0 : -1;
  const head = segIndex === headSeg ? pxToDegrees(Math.min(HEAD_PX, plan.band * 0.85), rMid) : 0;
  const b0 = seg.a0 + (f.strand === -1 && segIndex === headSeg ? head : 0);
  const b1 = seg.a1 - (f.strand === 1 && segIndex === headSeg ? head : 0);
  const centre = (b0 + b1) / 2;
  const c = mod(centre, 360);
  const flip = c > 90 && c < 270;
  const fs = plan.insideFont;
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
  /** 1 = right of the circle (text starts at x), -1 = left (text ends at x). */
  side: 1 | -1;
  x: number;
  /** Vertical centre of the label row. */
  y: number;
  /** Text baseline. */
  baseline: number;
  /** Text box (used for hit testing and overlap checks). */
  box: Box;
  /** Leader line path. */
  leader: string;
}

export interface LabelNote {
  x: number;
  y: number;
  text: string;
  anchor: 'start' | 'end';
}

export interface LabelPlacement {
  labels: PlacedLabel[];
  /** Number of labels that did not fit. */
  hidden: number;
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

function comparePriority(pinned: ReadonlySet<string>) {
  const cls = (c: LabelCandidate) => (c.featureId !== undefined && pinned.has(c.featureId) ? 0 : c.priorityClass);
  return (a: LabelCandidate, b: LabelCandidate) =>
    cls(a) - cls(b) || b.weight - a.weight || a.angle - b.angle || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
}

const NO_PINS: ReadonlySet<string> = new Set();

/** Angular window (degrees) around 12 and 6 o'clock where labels may switch sides. */
const POLE_ZONE = 24;

/**
 * Splits label candidates into the right (1) and left (-1) columns. Anchors right of the
 * vertical axis go right, the others left; near 12 and 6 o'clock the split point is moved so
 * a cluster there (typically a multiple cloning site next to the origin) is shared between
 * both columns instead of cascading far down one side.
 */
export function assignSides(candidates: readonly LabelCandidate[]): Map<LabelCandidate, 1 | -1> {
  const side = new Map<LabelCandidate, 1 | -1>();
  for (const c of candidates) side.set(c, sinDeg(c.angle) >= -1e-9 ? 1 : -1);
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

function clampInt(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Anchor angle unwrapped for a column, so the order along the column follows the circle:
 * right column in (-zone, 180 + zone], left column in [180 - zone, 360 + zone).
 */
function columnAngle(angle: number, side: 1 | -1): number {
  if (side === 1) return angle > 180 + POLE_ZONE ? angle - 360 : angle;
  return angle < 180 - POLE_ZONE ? angle + 360 : angle;
}

/**
 * Lays out outside labels SnapGene-style: each side of the circle is a column of rows,
 * ordered like their anchors, spread vertically (least displacement) and hugging the
 * circle, joined to their anchor by a straight leader line. When a side has more labels
 * than rows, the lowest-priority ones are dropped and a "+N more" note takes the last row.
 * `pinned` feature ids (selected / highlighted) get the highest priority.
 */
export function placeLabels(geom: MapGeometry, pinned: ReadonlySet<string> = NO_PINS): LabelPlacement {
  const { candidates, height: H, cx, cy, labelRadius: Rl, labelLineHeight: h, margin, labelFontSize } = geom;
  const result: LabelPlacement = { labels: [], hidden: 0, notes: [], byKey: new Map() };
  const sideOf = assignSides(candidates);
  const columns: Array<[1 | -1, LabelCandidate[]]> = [
    [1, candidates.filter((c) => sideOf.get(c) === 1)],
    [-1, candidates.filter((c) => sideOf.get(c) === -1)],
  ];
  const byPriority = comparePriority(pinned);

  for (const [side, list] of columns) {
    if (list.length === 0) continue;
    const top = margin + h / 2;
    let bottom = H - margin - h / 2;
    let kept = list;
    const capacity = Math.max(0, Math.floor((bottom - top) / h) + 1);
    const hugX = (y: number) => {
      const yTop = y - h / 2;
      const yBot = y + h / 2;
      const dyMin = yTop <= cy && yBot >= cy ? 0 : Math.min(Math.abs(yTop - cy), Math.abs(yBot - cy));
      const off = dyMin < Rl ? Math.sqrt(Rl * Rl - dyMin * dyMin) : 0;
      return cx + side * Math.max(off, 6);
    };
    if (list.length > capacity) {
      const noteY = bottom;
      bottom -= h; // the last row shows the "+N more" note
      const cap = Math.max(0, Math.floor((bottom - top) / h) + 1);
      kept = [...list].sort(byPriority).slice(0, cap);
      const dropped = list.length - kept.length;
      result.hidden += dropped;
      result.notes.push({
        x: hugX(noteY),
        y: noteY + labelFontSize * 0.35,
        text: `+${formatInt(dropped)} more`,
        anchor: side === 1 ? 'start' : 'end',
      });
    }
    // Order along the column = order around the circle (top to bottom).
    const order = kept
      .map((c) => ({ c, a: columnAngle(c.angle, side) }))
      .sort((p, q) => side * (p.a - q.a) || (p.c.key < q.c.key ? -1 : 1));
    const lo = side === 1 ? 0 : 180;
    const ideal = order.map(({ a }) => cy - Rl * Math.cos(Math.min(lo + 180, Math.max(lo, a)) * DEG));
    // Unwrapped pole labels can make ideals slightly non-monotonic: enforce the order.
    for (let i = 1; i < ideal.length; i++) if (ideal[i] < ideal[i - 1]) ideal[i] = ideal[i - 1];
    const ys = spreadPositions(ideal, h, top, bottom);
    order.forEach(({ c }, i) => {
      const y = ys[i];
      const x = hugX(y);
      const box: Box =
        side === 1
          ? { x0: x, y0: y - h / 2, x1: x + c.width, y1: y + h / 2 }
          : { x0: x - c.width, y0: y - h / 2, x1: x, y1: y + h / 2 };
      const leader = leaderPath(cx, cy, c.anchorRadius, geom.ringOuter, c.angle, x - side * 3, y);
      const placed: PlacedLabel = {
        candidate: c,
        side,
        x,
        y,
        baseline: y + labelFontSize * 0.35,
        box,
        leader,
      };
      result.labels.push(placed);
      result.byKey.set(c.key, placed);
    });
  }
  return result;
}

function r2(v: number): number {
  return Math.round(v * 100) / 100;
}

/**
 * Leader line: anchors inside the ring (features on inner lanes) first run radially out to
 * the ring's outer edge, then a straight line goes to the label. Straight chords from inside
 * the label circle to a point on it stay inside that circle, so they never cut through the
 * label column.
 */
function leaderPath(
  cx: number,
  cy: number,
  anchorR: number,
  ringOuter: number,
  angle: number,
  endX: number,
  endY: number,
): string {
  const a = polarToCartesian(cx, cy, anchorR, angle);
  if (anchorR >= ringOuter - 0.5) return `M ${r2(a.x)} ${r2(a.y)} L ${r2(endX)} ${r2(endY)}`;
  const e = polarToCartesian(cx, cy, ringOuter, angle);
  return `M ${r2(a.x)} ${r2(a.y)} L ${r2(e.x)} ${r2(e.y)} L ${r2(endX)} ${r2(endY)}`;
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
