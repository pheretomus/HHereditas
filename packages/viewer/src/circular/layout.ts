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
 *   ORF lanes        (thin arrows between the backbone and the features)
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
import type { MapShowOptions } from './types';

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
  /**
   * The pieces the feature is drawn as (normalized): its segments, with consecutive segments
   * that continue each other merged (see {@link featurePieces}).
   */
  pieces: Range[];
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
  /** "EcoRI (396)": 1-based position of the base 5' of the top-strand cut. Enzymes that cut at the same place share the label: "BspQI - SapI (58)". */
  label: string;
  /** Every enzyme that cuts at this place, alphabetical; `site` is the first one met. */
  names: string[];
  /** The enzyme cuts the record exactly once (among the given sites). */
  unique: boolean;
  /** Number of cuts of this enzyme in the record (among the given sites). */
  cutCount: number;
}

export interface PrimerItem {
  site: PrimerBindingSite;
  name: string;
  lane: number;
  /**
   * Room reserved on the lane (normalized): the binding site, lengthened at its 5' end to at
   * least PRIMER_MIN_FRACTION of the molecule so short primers can be drawn as visible arrows.
   */
  extent: Range;
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
  showLengths?: boolean;
  showPrimerLocations?: boolean;
}

export interface MapModelInput {
  record: SeqRecord;
  enzymeSites?: readonly EnzymeSite[];
  /**
   * Enzymes that share a recognition site and cut (isoschizomers): enzyme name -> every name of its group. The app shows
   * one name per group in `enzymeSites`; the label lists the whole group ("BspQI - SapI").
   */
  enzymeAliases?: ReadonlyMap<string, readonly string[]>;
  primerSites?: readonly PrimerBindingSite[];
  orfs?: readonly Orf[];
  layers?: MapShowOptions;
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

/**
 * The pieces a feature is drawn as: its segments (normalized), with consecutive segments that
 * continue each other merged into one. A GenBank join split at the origin of a circular
 * molecule, e.g. join(4701..5000,1..200), is one continuous feature and is drawn without a seam.
 */
export function featurePieces(f: Feature, length: number, topology: Topology): Range[] {
  const out: Range[] = [];
  const circular = topology === 'circular' && length > 0;
  for (const seg of f.segments) {
    const r = normalizeRange(seg, length, topology);
    const prev = out[out.length - 1];
    if (prev && r.end > r.start && prev.end > prev.start) {
      const continues = circular ? mod(prev.end, length) === r.start : prev.end === r.start;
      const total = prev.end - prev.start + (r.end - r.start);
      if (continues && (!circular || total <= length)) {
        prev.end = prev.start + total;
        continue;
      }
    }
    out.push({ start: r.start, end: r.end });
  }
  return out;
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
    showLengths: Boolean(layers.lengths),
    showPrimerLocations: Boolean(layers.primerLocations),
  };
  if (length <= 0) return model;

  const activePrimerRanges =
    layers.primers !== false && input.primerSites && input.primerSites.length > 0
      ? new Set(
          input.primerSites.map((s) => {
            const r = normalizeRange(s.range, length, topology);
            return `${r.start}|${r.end}`;
          }),
        )
      : null;

  if (layers.features !== false) {
    const items: FeatureItem[] = [];
    for (const feature of record.features) {
      if (feature.segments.length === 0) continue;
      const extent = normalizeRange(featureExtent(feature, length, topology), length, topology);
      if (feature.type === 'primer_bind' && activePrimerRanges?.has(`${extent.start}|${extent.end}`)) continue;
      const name = feature.name.trim();
      items.push({
        feature,
        extent,
        length: featureLength(feature),
        pieces: featurePieces(feature, length, topology),
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
    const items: EnzymeItem[] = input.enzymeSites.map((site) => {
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
        names: [...(input.enzymeAliases?.get(site.enzyme) ?? [site.enzyme])],
        unique: count === 1,
        cutCount: count,
      };
    });
    // Enzymes cutting at the same place (isoschizomers, or sites that overlap there) are labelled once, SnapGene-style.
    const byCut = new Map<number, EnzymeItem>();
    for (const item of items) {
      const first = byCut.get(item.cut);
      if (!first) {
        byCut.set(item.cut, item);
        continue;
      }
      for (const name of item.names) if (!first.names.includes(name)) first.names.push(name);
      first.unique = first.unique || item.unique;
    }
    model.enzymes = [...byCut.values()].map((item) => {
      if (item.names.length < 2) return item;
      const names = [...item.names].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
      const num = item.site.cuts.length ? cutLabelPosition(item.cut, length, topology) : item.cut + 1;
      return { ...item, names, label: `${names.join(' - ')} (${formatInt(num)})` };
    });
  }

  if (layers.primers !== false && input.primerSites) {
    const names = new Map(record.primers.map((p) => [p.id, p.name] as const));
    const extents = input.primerSites.map((s) => normalizeRange(s.range, length, topology));
    const padBp = Math.max(1, Math.round(length * 0.002));
    const fwdIdx: number[] = [];
    const revIdx: number[] = [];
    input.primerSites.forEach((s, i) => (s.strand === 1 ? fwdIdx : revIdx).push(i));
    const fwdLanes = assignLanes(fwdIdx.map((i) => extents[i]), length, topology, padBp);
    const revLanes = assignLanes(revIdx.map((i) => extents[i]), length, topology, padBp);
    const lanes = new Array<number>(input.primerSites.length).fill(0);
    fwdIdx.forEach((idx, k) => (lanes[idx] = fwdLanes[k]));
    revIdx.forEach((idx, k) => (lanes[idx] = revLanes[k]));
    model.primers = input.primerSites.map((site, i) => ({
      site,
      name: names.get(site.primerId)?.trim() || 'Primer',
      lane: lanes[i],
      extent: extents[i],
    }));
    model.primerLanes = Math.max(laneCountOf(fwdLanes), laneCountOf(revLanes));
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
  /** Optional radial/angular bounds for hit-testing Tier 2 ('below') curved labels. */
  rIn?: number;
  rOut?: number;
  a0?: number;
  a1?: number;
  /** 'below' labels: radius of the text and shell (0 = just below the feature), and the leader line up to the feature. */
  rMid?: number;
  shell?: number;
  leader?: string | null;
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
  /** Angles of each drawn piece (item.pieces: contiguous segments merged), for hit testing. */
  segments: Array<{ a0: number; a1: number }>;
  /** Body path (all segments). */
  d: string;
  /** Thin arcs joining the segments of a multi-part feature ('' when none). */
  connectors: string;
  fill: string;
  stroke: string;
  /** Tier 1: Curved label inside the feature arc when the arc is wide enough. */
  inside: InsideLabel | null;
  /** Tier 2: Curved label directly below/inside the feature arc without a leader line when space permits. */
  below: InsideLabel | null;
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
  /** Optional SVG transform (tangential rotation along the outer backbone ring). */
  transform?: string;
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
  /**
   * Semi-axes of the (invisible) ellipse the label rows hug, around the map centre; both default to `labelRadius`
   * (a circle just outside the ring). A wide ellipse puts the labels far from a smaller ring, giving the rows room.
   */
  radiusX?: number;
  radiusY?: number;
  /** Outer edge of the ring decorations: leaders never cut inside it. */
  ringOuter: number;
  /** Radius where leaders bend from radial to straight. */
  elbowRadius: number;
  /** Largest angle (degrees) between a label's anchor and the label itself. */
  maxDisplacement: number;
  /**
   * Whether labels near 12 and 6 o'clock are shared between the two columns to even their load (default),
   * which can send a label across the vertical axis; false keeps every label in the column of its own side.
   */
  balancePoles?: boolean;
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
const BACKBONE_STRAND_GAP = 3; // outer strand (R) -> inner strand (R - 3) of double-line backbone
const PRIMER_OFFSET = 1.6; // tight clearance from outer/inner backbone strand to primer lane 0
const PRIMER_W = 1.4; // radial thickness of the orange primer line
const PRIMER_STEP = 2.6; // radial step between stacked primer lanes
const PRIMER_MIN_PX = 1.5; // minimum visible arc length (px) for actual primer span
const MAX_PRIMER_LANES = 4;
const REV_PRIMER_BASE_BAND = 5.5; // reserved band just inside inner DNA strand for reverse primers
const MAJOR_TICK = 7.5; // bp ruler tick length inside the reverse-primer band
const MINOR_TICK = 2.5;
const GAP0_NO_RULER = BACKBONE_STRAND_GAP + REV_PRIMER_BASE_BAND + 2; // backbone (R) -> outer edge of feature lane 0 when ruler is hidden
const TICK_OUT = 4; // invisible hit-test stub outside the outer backbone for enzyme cuts
const ORF_W = 6; // arrow head width
const ORF_SHAFT = 2;
const ORF_STEP = 7;
const ORF_OFFSET = 1;
const ORF_FEATURE_GAP = 3; // last ORF lane -> feature lane 0
const MAX_ORF_LANES = 6;
const INSIDE_PAD = 5; // inside label clearance at each end
const INSIDE_MIN_ARC_PX = 24; // least room along the arc (after the arrowhead and the padding) for an inside label
const HEAD_PX = 9; // arrowhead length
export const LABEL_CHIP_GAP = 4; // colour chip -> label text
/** Padding (px) on each side of the text of an outside feature label, which is drawn in a box tinted like the feature. */
export const LABEL_BOX_PAD = 5;
const ATTACH_GAP = 3; // leader end -> label
const POLE_INSET = 6; // label columns keep this far from the vertical axis
/** Radius candidates, as fractions of the largest radius the labels allow. */
const RADIUS_TRIALS = [1, 0.94, 0.88, 0.82, 0.76, 0.68, 0.6, 0.52];
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
  /** Ticks are drawn (false on tiny maps). */
  ruler: boolean;
  rulerRadius: number;
  /** Radial distance from inner backbone strand (rr) to where bp ruler labels begin (clears reverse primers). */
  revPrimerBand: number;
  /** Radial distance from outer backbone R to feature lane 0 rOut (the ORF lanes lie in between). */
  gap0: number;
  /** Radial distance from outer backbone R to where the ORF lanes begin. */
  orfGap0: number;
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

function planRadii(model: MapModel, R: number, _rulerLabelWidth: (fontSize: number) => number): RadialPlan {
  let { band, laneGap } = sizeBand(R);
  const wanted = model.featureLanes;
  const orfLaneCount = Math.min(model.orfLanes, MAX_ORF_LANES);
  // every ORF lane adds its own depth, plus a clear gap before the feature lanes
  const orfDepth = orfLaneCount ? ORF_OFFSET + orfLaneCount * ORF_STEP - (ORF_STEP - ORF_W) + ORF_FEATURE_GAP : 0;
  const rulerFont = R < 150 ? 8 : 9;
  const ruler = model.length > 0 && R >= 55;
  const rulerLabels = ruler && R >= 85;
  const rulerRadius = Math.max(1, R - BACKBONE_STRAND_GAP);
  let maxRevLane = -1;
  for (const p of model.primers) {
    if (p.site.strand === -1 && p.lane > maxRevLane) maxRevLane = p.lane;
  }
  const revLanes = Math.min(maxRevLane + 1, MAX_PRIMER_LANES);
  const revPrimerBand = Math.max(
    REV_PRIMER_BASE_BAND,
    revLanes > 0 ? PRIMER_OFFSET + revLanes * PRIMER_STEP + 1.5 : 0,
  );
  const gap0 = ruler
    ? BACKBONE_STRAND_GAP + revPrimerBand + MAJOR_TICK + 3
    : Math.max(GAP0_NO_RULER, BACKBONE_STRAND_GAP + revPrimerBand + 2);
  const minCentre = Math.max(24, Math.min(110, R * 0.3));
  const avail = R - gap0 - orfDepth - 6 - minCentre;
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
  const innermost = R - gap0 - featureDepth - orfDepth;
  const centreRadius = Math.max(12, innermost - 8);
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
    revPrimerBand,
    gap0: gap0 + orfDepth,
    orfGap0: gap0,
    centreRadius,
  };
}

function laneRadii(plan: RadialPlan, R: number, lane: number): { rIn: number; rOut: number } {
  const k = Math.min(lane, Math.max(0, plan.laneCount - 1));
  const rOut = R - plan.gap0 - k * (plan.band + plan.laneGap);
  return { rIn: rOut - plan.band, rOut };
}

/**
 * Radial band for a primer arc:
 * - Forward primers (strand === 1) sit OUTSIDE the outer strand (R) of the double-line backbone.
 * - Reverse primers (strand === -1) sit INSIDE the inner strand (R - BACKBONE_STRAND_GAP) of the double-line backbone.
 */
function primerRadii(R: number, strand: 1 | -1, lane: number): { rIn: number; rOut: number; rMid: number } {
  const k = Math.min(lane, MAX_PRIMER_LANES - 1);
  if (strand === 1) {
    const rIn = R + PRIMER_OFFSET + k * PRIMER_STEP;
    const rOut = rIn + PRIMER_W;
    return { rIn, rOut, rMid: (rIn + rOut) / 2 };
  }
  const rInnerBackbone = Math.max(1, R - BACKBONE_STRAND_GAP);
  const rOut = rInnerBackbone - PRIMER_OFFSET - k * PRIMER_STEP;
  const rIn = rOut - PRIMER_W;
  return { rIn, rOut, rMid: (rIn + rOut) / 2 };
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
  return length >= 100_000 ? formatCompactBp(p) : String(p);
}

/** Index of the longest piece (the one that carries the label). */
function longestPiece(pieces: readonly Range[]): number {
  let best = 0;
  for (let k = 1; k < pieces.length; k++) {
    if (pieces[k].end - pieces[k].start > pieces[best].end - pieces[best].start) best = k;
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
  /** Primer label texts (with optional location prefix and bp length suffix). */
  primerNames: string[];
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

/** Does feature i's name fit comfortably inside its arc at radius R (Tier 1 'inside')? */
function insideFits(ctx: Context, R: number, plan: RadialPlan, i: number): boolean {
  if (!plan.insideFont) return false;
  const f = ctx.model.features[i];
  const lane = laneRadii(plan, R, f.lane);
  const rMid = (lane.rIn + lane.rOut) / 2;
  const head = f.feature.strand !== 0 ? Math.min(HEAD_PX, plan.band * 0.85) : 0;
  const avail = arcLength(rMid, ctx.featureSpan[i]) - head - 2 * INSIDE_PAD;
  // The name must fill at most 78% of the room; an arc shorter than INSIDE_MIN_ARC_PX is too tight for any text, but a
  // short name such as "UGI" fits well in a short arc (a fixed, larger minimum used to push it out of its feature).
  if (avail < INSIDE_MIN_ARC_PX) return false;
  return ctx.measure(ctx.featureNames[i], plan.insideFont, FEATURE_WEIGHT) <= avail * 0.78;
}

/**
 * How wide a 'below' label may be compared with its feature: up to BELOW_TEXT_PER_ARC times the feature's arc, and
 * always up to BELOW_MIN_TEXT_PX. A long name on a short feature still reads well inside the map when the space around
 * it is free (the checks below keep it clear of other features, ORFs and labels); this used to be 3.6 times / 85 px,
 * which sent such names outside as soon as a smaller map made the arc shorter.
 */
const BELOW_TEXT_PER_ARC = 6;
/** Shortest feature arc (px) that still gets a 'below' label; smaller ones have no anchor worth labelling in place. */
const BELOW_MIN_FEATURE_ARC_PX = 2.5;
const BELOW_MIN_TEXT_PX = 130;

/** Number of concentric shells inside the map where Tier 2 ('below') labels can stand. */
const BELOW_SHELLS = 2;

/** Radial distance between two shells of 'below' labels for label font size `fs`. */
const belowShellStep = (fs: number): number => fs * 1.25 + 1;

/** Radius (centre of the text) of a 'below' label of a feature whose lane starts at `rIn`, in the given shell. */
const belowRadius = (rIn: number, fs: number, shell: number): number => rIn - (fs * 0.62 + 2.5) - shell * belowShellStep(fs);

/**
 * Tier 2 ('below') features: medium-sized features whose label does not fit inside their arc, yet have
 * sufficient arc span and clear angular/radial space inside the map to render curved below their arc
 * without a leader line. Value = shell (0 = directly below the arc, 1 = one shell further in): a label that
 * finds the first shell taken moves to the second one instead of going outside with a leader.
 */
function belowFeatureIndices(ctx: Context, R: number, plan: RadialPlan): Map<number, number> {
  const placed = new Map<number, number>();
  if (!plan.insideFont || plan.laneCount <= 0) return placed;
  const fs = Math.max(9, plan.insideFont - 0.5);
  const { model, scale, measure } = ctx;
  const order = model.features.map((_, i) => i);
  order.sort((a, b) => model.features[b].length - model.features[a].length || a - b);

  const occupied: Array<{ lane: number; shell: number; r: number; a0: number; a1: number }> = [];
  const arcsOverlap = (a0: number, a1: number, b0: number, b1: number, padDeg = 2): boolean => {
    const spanA = Math.min(360, Math.max(0.1, a1 - a0) + padDeg);
    const spanB = Math.min(360, Math.max(0.1, b1 - b0) + padDeg);
    const midA = (a0 + a1) / 2;
    const midB = (b0 + b1) / 2;
    const diff = Math.abs(((((midA - midB) % 360) + 540) % 360) - 180);
    return diff < (spanA + spanB) / 2;
  };

  for (const i of order) {
    const item = model.features[i];
    if (!item.named || insideFits(ctx, R, plan, i)) continue;
    const k = Math.min(item.lane, Math.max(0, plan.laneCount - 1));
    const { rIn } = laneRadii(plan, R, k);
    const spanDeg = ctx.featureSpan[i];
    const featArcPx = arcLength(rIn, spanDeg);
    // Medium-sized features with clear surrounding space get Tier 2 ('below');
    // tiny or crowded features get Tier 3 ('outside' with leader line)
    if (featArcPx < BELOW_MIN_FEATURE_ARC_PX) continue;
    const text = ctx.featureNames[i];
    const tw = measure(text, fs, FEATURE_WEIGHT);
    if (tw > Math.max(featArcPx * BELOW_TEXT_PER_ARC, BELOW_MIN_TEXT_PX)) continue;
    const seg = rangeAngles(scale, item.pieces[longestPiece(item.pieces)]);
    const mid = (seg.a0 + seg.a1) / 2;

    for (let shell = 0; shell < BELOW_SHELLS; shell++) {
      const rBelow = belowRadius(rIn, fs, shell);
      if (rBelow - fs * 0.6 < Math.min(plan.centreRadius * 0.55, 64)) break; // no room further in either
      const halfDeg = pxToDegrees(tw / 2 + 4, Math.max(12, rBelow));
      if (halfDeg * 2 > 110) continue;
      const lA0 = mid - halfDeg;
      const lA1 = mid + halfDeg;

      // Must not overlap any feature drawn in a deeper lane (lane > k)
      let blocked = false;
      for (let j = 0; j < model.features.length && !blocked; j++) {
        if (j === i) continue;
        const other = model.features[j];
        const ok = Math.min(other.lane, Math.max(0, plan.laneCount - 1));
        if (ok <= k) continue;
        const otherRadii = laneRadii(plan, R, ok);
        if (otherRadii.rOut < rBelow - fs * 0.7 || otherRadii.rIn > rIn) continue;
        for (const p of other.pieces) {
          const oa = rangeAngles(scale, p);
          if (arcsOverlap(lA0, lA1, oa.a0, oa.a1, 0)) {
            blocked = true;
            break;
          }
        }
      }
      if (blocked) continue;

      // Must not overlap an already placed 'below' label: the same or an adjacent lane in the first shell (as
      // before), or any label at about the same radius (a first-shell label of a deeper lane can sit there).
      for (const prev of occupied) {
        if (!arcsOverlap(lA0, lA1, prev.a0, prev.a1, 3)) continue;
        if ((shell === 0 && prev.shell === 0 && Math.abs(prev.lane - k) <= 1) || Math.abs(prev.r - rBelow) < fs * 1.25) {
          blocked = true;
          break;
        }
      }
      if (blocked) continue;

      placed.set(i, shell);
      occupied.push({ lane: k, shell, r: rBelow, a0: lA0, a1: lA1 });
      break;
    }
  }
  return placed;
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
  const belowSet = belowFeatureIndices(ctx, R, plan);
  model.features.forEach((item, i) => {
    if (insideFits(ctx, R, plan, i) || belowSet.has(i)) return;
    const text = ctx.featureNames[i];
    // Two annotations with the same name and extent (gene + CDS) share one outside label.
    const dedupe = `${ctx.featureNames[i]}|${item.extent.start}|${item.extent.end}`;
    if (seen.has(dedupe)) return;
    seen.add(dedupe);
    const f = item.feature;
    const a = rangeAngles(scale, item.pieces[longestPiece(item.pieces)]);
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
    const text = ctx.primerNames[i];
    const { rMid } = primerRadii(R, item.site.strand, item.lane);
    const ra = rangeAngles(scale, normalizeRange(item.site.range, L, model.topology));
    const a = widenToPx(ra.a0, ra.a1, rMid, PRIMER_MIN_PX);
    // Leader connects at the 5' end of the primer: a0 for Forward (strand === 1), a1 for Reverse (strand === -1)
    const fivePrimeAngle = item.site.strand === 1 ? a.a0 : a.a1;
    out.push({
      key: `p:${i}`,
      ref: { kind: 'primer', index: i },
      text,
      width: ctx.primerWidth[i],
      chip: null,
      fontWeight: PRIMER_WEIGHT,
      tone: item.site.strand === 1 ? 'primerFwd' : 'primerRev',
      angle: mod(fivePrimeAngle, 360),
      anchorRadius: rMid,
      // Place primers right after named features so their orange leader lines stay short and direct
      priorityClass: 2,
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
      // Connect the faint leader line directly to the outer strand (R) of the double-line backbone
      anchorRadius: R,
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

/** What one pair of crossing leader lines costs when comparing layouts (see DROP_COST for lost labels). */
const CROSSING_COST = 0.05;

/** Number of pairs of leader lines that cross each other. */
function leaderCrossings(labels: readonly PlacedLabel[]): number {
  const lines = labels.map((l) => {
    const n = (l.leader.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
    const pts: Pt[] = [];
    for (let i = 0; i + 1 < n.length; i += 2) pts.push({ x: n[i], y: n[i + 1] });
    return pts;
  });
  let count = 0;
  for (let i = 0; i < lines.length; i++) {
    for (let j = i + 1; j < lines.length; j++) {
      let hit = false;
      for (let a = 0; a + 1 < lines[i].length && !hit; a++) {
        for (let b = 0; b + 1 < lines[j].length && !hit; b++) {
          hit = segmentsCross(lines[i][a], lines[i][a + 1], lines[j][b], lines[j][b + 1]);
        }
      }
      if (hit) count++;
    }
  }
  return count;
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
  const chipW = 2 * LABEL_BOX_PAD; // width a feature label's box adds to its text

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

  const featureNames = model.features.map((f) => {
    const base = featureName(f.feature);
    return model.showLengths ? `${base} (${formatInt(f.length)} bp)` : base;
  });
  const primerSeqLengths = new Map(model.record.primers.map((p) => [p.id, p.sequence.length] as const));
  const primerNames = model.primers.map((p) => {
    let text = p.name;
    const norm = normalizeRange(p.site.range, L, model.topology);
    if (model.showPrimerLocations && L > 0) {
      const start1 = norm.start + 1;
      const end1 = mod(norm.end - 1, L) + 1;
      text = `(${start1} .. ${end1}) ${text}`;
    }
    if (model.showLengths) {
      const bpLen = primerSeqLengths.get(p.site.primerId) || Math.max(0, norm.end - norm.start);
      text = `${text} (${formatInt(bpLen)} bp)`;
    }
    return text;
  });
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
    labelGap: small ? 18 : 26,
    elbow: 2,
    rulerInfo,
    rulerLabelWidth,
    featureNames,
    primerNames,
    featureWidth: featureNames.map((t) => measure(t, fontSize, FEATURE_WEIGHT) + chipW),
    enzymeWidth: model.enzymes.map((e) => measure(e.label, fontSize, enzymeWeight(e))),
    primerWidth: primerNames.map((t) => measure(t, fontSize, PRIMER_WEIGHT)),
    featureSpan: model.features.map((f) => {
      const s = f.pieces[longestPiece(f.pieces)];
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
    // Only the features whose names do not fit inside or below their arcs need room outside.
    const plan0 = planRadii(model, Rmax, rulerLabelWidth);
    const below0 = belowFeatureIndices(ctx, Rmax, plan0);
    const outside = fullFeatureWidth.filter((_, i) => !insideFits(ctx, Rmax, plan0, i) && !below0.has(i));
    allowance = Math.max(fixed, Math.min(cap, maxOf(outside)));
    Rmax = Math.max(Rmax, radiusLimit(ctx, allowance, fixed > 0 || outside.length > 0));
  }
  // ---- Radius: the largest trial whose labels fit (almost) as well as the best one. ----
  Rmax = Math.max(20, Math.floor(Rmax));
  type Trial = {
    R: number;
    plan: RadialPlan;
    candidates: LabelCandidate[];
    frame: LabelFrame;
    placement: LabelPlacement;
    cost: number;
  };
  const trials: Trial[] = [];
  if (L === 0) Rmax = Math.max(20, Math.floor(Rmax * 0.62)); // empty state: a quiet, smaller circle
  const minR = Math.min(Rmax, 60);
  for (const f of L > 0 && anyLabels ? RADIUS_TRIALS : [1]) {
    const R = Math.max(minR, Math.floor(Rmax * f));
    if (trials.length && trials[trials.length - 1].R === R) continue;
    const plan = planRadii(model, R, rulerLabelWidth);
    const candidates = labelCandidates(ctx, R, plan);
    const base = labelFrameFor(ctx, R);
    const costOf = (p: LabelPlacement) => dropCost(p) + CROSSING_COST * leaderCrossings(p.labels);
    // Variants of the label layout, kept only when they beat the first one (so ties keep the simplest): rows hug a
    // circle just outside the ring, or a wide ellipse over the free space around a smaller ring. Labels always stay
    // in the column of their own side of the vertical axis (balancePoles: false).
    const wideX = ctx.W / 2 - ctx.margin - allowance;
    const wideY = ctx.H / 2 - ctx.margin - ctx.lineHeight / 2;
    const variants: LabelFrame[] = [{ ...base, balancePoles: false }];
    if (wideX > base.labelRadius + 4 || wideY > base.labelRadius + 4) {
      variants.push({ ...base, radiusX: Math.max(base.labelRadius, wideX), radiusY: Math.max(base.labelRadius, wideY), balancePoles: false });
    }
    let frame = variants[0];
    let placement = layoutLabels(candidates, frame, NO_PINS);
    let cost = costOf(placement);
    for (const variant of variants.slice(1)) {
      if (cost === 0) break; // nothing lost and no crossing: nothing to improve
      const alt = layoutLabels(candidates, variant, NO_PINS);
      const altCost = costOf(alt);
      if (altCost < cost - 1e-9) {
        frame = variant;
        placement = alt;
        cost = altCost;
      }
    }
    trials.push({ R, plan, candidates, frame, placement, cost });
    if (cost === 0) break; // nothing lost and no crossing: no smaller radius can do better
  }
  const best = trials.reduce((m, t) => Math.min(m, t.cost), Infinity);
  const tolerance = best * 0.02 + 0.25;
  const chosen = trials.find((t) => t.cost <= best + tolerance) ?? trials[0];
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

  // ---- Backbone (Double-line SnapGene-style ring) --------------------------
  const rInner = Math.max(1, R - BACKBONE_STRAND_GAP);
  let backbone: string;
  let backboneEnds = '';
  if (L <= 0) {
    backbone = `${circlePath(cx, cy, R)} ${circlePath(cx, cy, rInner)}`;
  } else if (model.topology === 'linear') {
    const a0 = positionToAngle(scale, 0);
    const a1 = positionToAngle(scale, L);
    backbone = `${arcPath(cx, cy, R, a0, a1)} ${arcPath(cx, cy, rInner, a0, a1)}`;
    backboneEnds = `${radialLinePath(cx, cy, rInner - 2, R + 2, a0)} ${radialLinePath(cx, cy, rInner - 2, R + 2, a1)}`;
  } else {
    backbone = `${circlePath(cx, cy, R)} ${circlePath(cx, cy, rInner)}`;
  }

  // ---- Features ------------------------------------------------------------
  const head = Math.min(HEAD_PX, plan.band * 0.85);
  const belowSet = belowFeatureIndices(ctx, R, plan);
  const features: FeatureShape[] = model.features.map((item, i) => {
    const f = item.feature;
    const { rIn, rOut } = laneRadii(plan, R, item.lane);
    const rMid = (rIn + rOut) / 2;
    const ext = rangeAngles(scale, item.extent);
    const segs = item.pieces.map((s) => {
      const a = rangeAngles(scale, s);
      return widenToPx(a.a0, a.a1, rMid, 2);
    });
    // The 3' end: last piece for the top strand, first piece for the bottom strand.
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
      below: null,
    };
    if (insideFits(ctx, R, plan, i)) {
      const text = ctx.featureNames[i];
      const piece = longestPiece(item.pieces);
      shape.inside = insideLabel(shape, piece, plan, head, cx, cy, text, measure(text, plan.insideFont, FEATURE_WEIGHT), `f${i}`);
    } else if (belowSet.has(i)) {
      const text = ctx.featureNames[i];
      const piece = longestPiece(item.pieces);
      const fs = Math.max(9, plan.insideFont - 0.5);
      shape.below = belowLabel(shape, piece, fs, cx, cy, text, measure(text, fs, FEATURE_WEIGHT), `fb${i}`, belowSet.get(i) ?? 0);
    }
    return shape;
  });
  // Leader lines from the labels below the features up to their features.
  const belowShapes = features.filter((f) => f.below);
  for (const f of belowShapes) {
    f.below!.leader = belowLeader(f, belowShapes, cx, cy, longestPiece(f.item.pieces));
  }
  // Paint order: lanes beyond the available depth share the last lane, so draw long features
  // first and short ones on top.
  const featureOrder = features.map((_, i) => i);
  featureOrder.sort((a, b) => features[b].item.length - features[a].item.length || a - b);

  // ---- ORFs ------------------------------------------------------------------
  const orfs: OrfShape[] = model.orfs.map((item, index) => {
    const k = Math.min(item.lane, Math.max(0, plan.orfLaneCount - 1));
    const rOut = R - plan.orfGap0 - ORF_OFFSET - k * ORF_STEP;
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

  // ---- Primers (Orange arc lines of actual primer length; Forward outside R, Reverse inside R - 3) ----
  const primers: PrimerShape[] = model.primers.map((item, index) => {
    const { rIn, rOut, rMid } = primerRadii(R, item.site.strand, item.lane);
    const ra = rangeAngles(scale, normalizeRange(item.site.range, L, model.topology));
    const a = widenToPx(ra.a0, ra.a1, rMid, PRIMER_MIN_PX);
    return {
      index,
      item,
      rIn,
      rOut,
      a0: a.a0,
      a1: a.a1,
      d: arcPath(cx, cy, rMid, a.a0, a.a1),
    };
  });

  // ---- Enzymes (No dark tick piercing the double-line ring; only outer stub for hit-testing) ----
  const enzymes: EnzymeShape[] = model.enzymes.map((item, index) => {
    const cutAngles = item.cuts.map((c) => positionToAngle(scale, c));
    return {
      index,
      item,
      angle: cutAngles[0],
      cutAngles,
      d: cutAngles.map((a) => radialLinePath(cx, cy, R, R + TICK_OUT, a)).join(' '),
    };
  });

  // ---- Ruler (SnapGene-style ticks & bp labels placed inward of reverse primer band) ----
  let ruler: RulerShape | null = null;
  const rulerInfo = ctx.rulerInfo;
  if (rulerInfo && plan.ruler && plan.rulerRadius > 20) {
    const rr = plan.rulerRadius;
    const tickInner = rr - plan.revPrimerBand - MAJOR_TICK;
    const minorInner = rr - MINOR_TICK;
    const dpb = (360 - scale.gap) / Math.max(1, L);
    const pxPerMinor = arcLength(rr, rulerInfo.minorStep * dpb);
    let major = '';
    let minor = '';
    const labels: TextItem[] = [];
    // Place bp coordinate text inside the reverse-primer band so it never collides with reverse primer lines
    const rLabel = rr - plan.revPrimerBand - MAJOR_TICK * 0.55;
    const labelClearanceDeg: Array<{ from: number; to: number }> = [];
    for (const p of rulerInfo.major) {
      const a = positionToAngle(scale, p);
      major += `${radialLinePath(cx, cy, rr, tickInner, a)} `;
      if (plan.rulerLabels) {
        const text = tickLabelText(p, L);
        const w = measure(text, plan.rulerFont, 400);
        const halfSpanDeg = pxToDegrees(w / 2 + 2.5, rLabel);
        const labelAngle = a - halfSpanDeg;
        labelClearanceDeg.push({ from: a - halfSpanDeg * 2 - 1, to: a + 1 });
        const pt = polarToCartesian(cx, cy, rLabel, labelAngle);
        const ang = mod(labelAngle, 360);
        const rot = ang > 90 && ang < 270 ? ang - 180 : ang > 180 ? ang - 360 : ang;
        const rx = Math.round(pt.x * 100) / 100;
        const ry = Math.round(pt.y * 100) / 100;
        const rRot = Math.round(rot * 100) / 100;
        labels.push({
          x: pt.x,
          y: pt.y + plan.rulerFont * 0.35,
          text,
          transform: `rotate(${rRot} ${rx} ${ry})`,
        });
      }
    }
    if (rulerInfo.minorStep < rulerInfo.step && pxPerMinor >= 6) {
      for (let p = rulerInfo.minorStep; p < L; p += rulerInfo.minorStep) {
        if (p % rulerInfo.step === 0) continue;
        const ma = positionToAngle(scale, p);
        if (labelClearanceDeg.some((c) => ma >= c.from && ma <= c.to)) continue;
        minor += `${radialLinePath(cx, cy, rr, minorInner, ma)} `;
      }
    }
    const a0 = positionToAngle(scale, 0);
    ruler = {
      radius: rr,
      circle: '',
      major: major.trim(),
      minor: minor.trim(),
      origin: radialLinePath(cx, cy, R, tickInner, a0),
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

/**
 * Thin radial line from a 'below' label up to its feature. It meets the label inside the label's span and the feature
 * inside the feature's arc, and picks the angle (middle, then near either end) where it does not run through the text
 * of another 'below' label that stands between them (a label in the second shell sits behind one in the first).
 * Null when the label touches the feature.
 */
function belowLeader(shape: FeatureShape, all: readonly FeatureShape[], cx: number, cy: number, piece: number): string | null {
  const label = shape.below;
  const seg = shape.segments[piece];
  if (!label || label.rMid === undefined || label.a0 === undefined || label.a1 === undefined || !seg) return null;
  const rEnd = label.rMid + label.fontSize * 0.55; // just outside the text
  const rStart = shape.rIn;
  if (rEnd >= rStart - 0.5) return null;
  const lo = Math.max(seg.a0, label.a0) + 0.4;
  const hi = Math.min(seg.a1, label.a1) - 0.4;
  const mid = (seg.a0 + seg.a1) / 2;
  const angles = lo <= hi ? [Math.min(hi, Math.max(lo, mid)), lo, hi] : [mid];
  const blocked = (angle: number) =>
    all.some((o) => {
      const t = o.below;
      if (o === shape || !t || t.rMid === undefined || t.a0 === undefined || t.a1 === undefined) return false;
      const reach = t.fontSize * 0.7;
      if (t.rMid + reach < rEnd || t.rMid - reach > rStart) return false; // not between the label and the feature
      const half = (t.a1 - t.a0) / 2;
      return Math.abs(angleDelta(angle, (t.a0 + t.a1) / 2)) <= half;
    });
  const angle = angles.find((a) => !blocked(a)) ?? angles[0];
  const a = polarToCartesian(cx, cy, rEnd, angle);
  const b = polarToCartesian(cx, cy, rStart, angle);
  return `M ${r2(a.x)} ${r2(a.y)} L ${r2(b.x)} ${r2(b.y)}`;
}

/** Tier 2 ('below') curved label placed below/inside a feature arc (in the given shell) without a leader line. */
function belowLabel(
  shape: FeatureShape,
  segIndex: number,
  fontSize: number,
  cx: number,
  cy: number,
  text: string,
  textWidth: number,
  key: string,
  shell: number,
): InsideLabel {
  const seg = shape.segments[segIndex];
  const centre = (seg.a0 + seg.a1) / 2;
  const c = mod(centre, 360);
  const flip = c > 90 && c < 270;
  const rBelow = belowRadius(shape.rIn, fontSize, shell);
  const baseline = flip ? rBelow + fontSize * 0.34 : rBelow - fontSize * 0.34;
  const half = pxToDegrees(textWidth / 2 + 8, Math.max(12, baseline));
  const d = flip
    ? arcPath(cx, cy, baseline, centre + half, centre - half)
    : arcPath(cx, cy, baseline, centre - half, centre + half);
  return {
    key,
    d,
    text,
    fontSize,
    rMid: rBelow,
    shell,
    rIn: rBelow - fontSize * 0.65,
    // First shell: the hit area reaches up to the feature; a label in a further shell only covers its own text.
    rOut: shell === 0 ? shape.rIn : rBelow + fontSize * 0.65,
    a0: centre - half,
    a1: centre + half,
  };
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
export function assignSides(candidates: readonly LabelCandidate[], balancePoles = true): Map<LabelCandidate, 1 | -1> {
  const side = new Map<LabelCandidate, 1 | -1>();
  for (const c of candidates) side.set(c, c.angle < 180 ? 1 : -1);
  if (!balancePoles) return side;
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

/** Row centre closest to the anchor: where the anchor's direction meets the label ellipse. */
function idealY(frame: LabelFrame, columnAngleDeg: number, side: 1 | -1): number {
  const lo = side === 1 ? 0 : 180;
  const a = Math.min(lo + 180, Math.max(lo, columnAngleDeg));
  const A = frame.radiusX ?? frame.labelRadius;
  const B = frame.radiusY ?? frame.labelRadius;
  // Distance from the centre to the ellipse along direction a (a circle: its radius).
  const t = 1 / Math.hypot(Math.sin(a * DEG) / A, Math.cos(a * DEG) / B);
  return frame.cy - t * Math.cos(a * DEG);
}

/** x of the near edge of a label row centred at y: rows hug the label ellipse. */
export function hugX(frame: LabelFrame, side: 1 | -1, y: number): number {
  const { cx, cy, lineHeight: h } = frame;
  const A = frame.radiusX ?? frame.labelRadius;
  const B = frame.radiusY ?? frame.labelRadius;
  const yTop = y - h / 2;
  const yBot = y + h / 2;
  const dyMin = yTop <= cy && yBot >= cy ? 0 : Math.min(Math.abs(yTop - cy), Math.abs(yBot - cy));
  const off = dyMin < B ? A * Math.sqrt(1 - (dyMin / B) * (dyMin / B)) : 0;
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
  // The leader always runs outwards, away from the vertical axis: a label on the left ends left of its anchor, a
  // label on the right ends right of it (never back across the anchor towards the middle).
  const anchor = polarToCartesian(frame.cx, frame.cy, c.anchorRadius, c.angle);
  if (side * (ax - anchor.x) < -0.5) return false;
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
    const dir = to >= ideal ? 1 : -1;
    const step = dir * (frame.lineHeight / 2);
    let ok = ideal;
    let bad = to;
    let hitBad = false;
    for (let y = ideal + step; dir > 0 ? y < to : y > to; y += step) {
      if (fits(y)) {
        ok = y;
      } else {
        bad = y;
        hitBad = true;
        break;
      }
    }
    if (!hitBad && fits(to)) return to;
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

/** Try to add a label to a column; keeps the column unchanged when it does not fit cleanly. */
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
 * Admits labels in priority order. Each goes to its preferred column if the column can still
 * place every kept label inside its window; otherwise it is dropped.
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

interface Pt {
  x: number;
  y: number;
}

/** Whether the open segments ab and cd cross (a shared endpoint or touching does not count). */
function segmentsCross(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  const side = (p: Pt, q: Pt, r: Pt) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  return side(c, d, a) * side(c, d, b) < 0 && side(a, b, c) * side(a, b, d) < 0;
}

/** Above this many labels in a column the leader untangling is skipped (it is quadratic). */
const UNCROSS_MAX_LABELS = 160;

/**
 * Row (centre y) of every label of a column after untangling the leaders. Labels start in the rows
 * {@link spreadWithin} gave them (ordered like their anchors), which makes the leaders of a crowded cluster
 * cross. When two leaders cross, the two labels swap rows if both rows are acceptable to them
 * ({@link rowFits}, inside their window) and that leaves fewer crossings among all leaders. Rows are never
 * added or moved, so labels cannot start to overlap.
 */
function uncrossRows(frame: LabelFrame, side: 1 | -1, kept: readonly ColumnEntry[], ys: readonly number[]): number[] {
  const n = kept.length;
  if (n < 2 || n > UNCROSS_MAX_LABELS) return [...ys];
  const anchor = kept.map(({ c }) => polarToCartesian(frame.cx, frame.cy, c.anchorRadius, c.angle));
  const elbow = kept.map(({ c }) => polarToCartesian(frame.cx, frame.cy, frame.elbowRadius, c.angle));
  const end = ys.map((y): Pt => ({ x: hugX(frame, side, y) - side * ATTACH_GAP, y }));
  const slotOf = kept.map((_, i) => i);
  const allowed = (i: number, slot: number) =>
    ys[slot] >= kept[i].lo - 0.5 && ys[slot] <= kept[i].hi + 0.5 && rowFits(frame, kept[i].c, side, ys[slot]);
  // The leader of a label: a radial stub (anchor -> elbow), then a straight line to its row.
  const cross = (i: number, si: number, j: number, sj: number) =>
    segmentsCross(anchor[i], elbow[i], elbow[j], end[sj]) ||
    segmentsCross(elbow[i], end[si], anchor[j], elbow[j]) ||
    segmentsCross(elbow[i], end[si], elbow[j], end[sj]);
  const crossingsOf = (i: number, si: number) => {
    let k = 0;
    for (let j = 0; j < n; j++) if (j !== i && cross(i, si, j, slotOf[j])) k++;
    return k;
  };
  for (let pass = 0; pass < 30; pass++) {
    let changed = false;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const si = slotOf[i];
        const sj = slotOf[j];
        if (!cross(i, si, j, sj) || !allowed(i, sj) || !allowed(j, si)) continue;
        const before = crossingsOf(i, si) + crossingsOf(j, sj) - 1; // the pair itself is counted twice
        slotOf[i] = sj;
        slotOf[j] = si;
        const after = crossingsOf(i, sj) + crossingsOf(j, si) - (cross(i, sj, j, si) ? 1 : 0);
        if (after < before) {
          changed = true;
        } else {
          slotOf[i] = si;
          slotOf[j] = sj;
        }
      }
    }
    if (!changed) break;
  }
  return kept.map((_, i) => ys[slotOf[i]]);
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
  const sideOf = assignSides(candidates, frame.balancePoles !== false);
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
    const rows = uncrossRows(frame, side, kept, ys);
    kept.forEach(({ c }, i) => {
      const y = rows[i];
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
