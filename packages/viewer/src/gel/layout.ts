/**
 * Geometry of the virtual agarose gel: where the slab, wells, bands and labels go for a given
 * size, plus hit-testing. Pure functions (no DOM), so the layout can be tested and memoized.
 *
 * Vertical scale: a band's `position` (0 = well .. 1 = bottom of the gel) maps linearly to y between
 * the centre of the wells and a margin above the bottom edge of the slab (see {@link gelPositionToY}).
 */
import { formatAgarose, formatGelSize } from './format';
import { approximateGelTextWidth, type GelTextMeasurer } from './measure';
import type { GelLane, GelLaneBand, GelSizeLabels } from './types';

/** Widest a lane gets (px): lanes share the available width up to this and are centred. */
export const GEL_MAX_LANE_WIDTH = 64;
/** Lanes with more bands than this are drawn as a continuous smear (e.g. genomic digests). */
export const GEL_SMEAR_THRESHOLD = 160;

const MIN_LANE_WIDTH = 10;
const BAND_FILL = 0.74; // band width / lane width (wells are as wide as the bands)
const LADDER_LINE = 14; // ladder label spacing (11 px text)
const SIZE_LINE = 12; // spacing of the size labels next to sample bands (10 px text)
const LANE_LINE = 15; // lane label line height
const TICK = 6; // ladder tick length
const KINK = 9; // horizontal run of a ladder label's leader when labels had to move
const LABEL_GAP = 4; // between a leader and its text
const TICK_GAP = 1; // between the slab edge and the ladder ticks
const HEADER_GAP = 7; // between the lane labels and the slab
const SIDE_LABEL_GAP = 4; // between a band and its size label
const MAX_SIDE_LABEL = 56;
const MIN_SLAB_WIDTH = 168;
const MIN_SLAB_LANES = 3; // the slab is at least this many lanes wide...
const SLAB_ASPECT = 0.3; // ...and at least this wide relative to its height (when space allows)
const LEADER_BEND = 2.5; // a ladder label moved less than this (px) keeps a straight tick
const EPS = 1e-6;

export interface GelRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Vertical scale: y (px) of position 0 (centre of the wells) and of position 1 (bottom of the run). */
export interface GelScale {
  top: number;
  bottom: number;
}

/** y (px) of a migration position. Negative positions are drawn in the well (0). */
export function gelPositionToY(position: number, scale: GelScale): number {
  const p = Number.isFinite(position) ? Math.max(0, position) : 0;
  return scale.top + p * (scale.bottom - scale.top);
}

/** Migration position at y (px): inverse of {@link gelPositionToY} (not clamped). */
export function gelYToPosition(y: number, scale: GelScale): number {
  const span = scale.bottom - scale.top;
  return span === 0 ? 0 : (y - scale.top) / span;
}

const RESPONSE_K = 3;
const RESPONSE_NORM = 1 - Math.exp(-RESPONSE_K);
const ALPHA_FLOOR = 0.16;

/**
 * Opacity of a band of the given relative intensity, like a camera exposure: faint bands stay
 * visible (floor), bright ones saturate (the response flattens towards 1).
 */
export function gelBandAlpha(intensity: number): number {
  if (!(intensity > 0)) return 0;
  const i = Math.min(1, intensity);
  return ALPHA_FLOOR + ((1 - ALPHA_FLOOR) * (1 - Math.exp(-RESPONSE_K * i))) / RESPONSE_NORM;
}

/** Opacity of a smear segment of relative intensity 0..1 (no visibility floor: smears fade out). */
export function gelSmearAlpha(intensity: number): number {
  if (!(intensity > 0)) return 0;
  const i = Math.min(1, intensity);
  return (1 - Math.exp(-RESPONSE_K * i)) / RESPONSE_NORM;
}

/** Opacity of the soft glow around bright bands (0 for bands below ~30 % intensity). */
export function gelBandGlow(intensity: number): number {
  const i = Math.min(1, Math.max(0, Number.isFinite(intensity) ? intensity : 0));
  return i <= 0.3 ? 0 : 0.42 * ((i - 0.3) / 0.7) ** 1.5;
}

/** Drawn thickness (px) of a band: brighter and merged bands look thicker, as on a real gel. */
export function gelBandThickness(base: number, intensity: number, count = 1): number {
  const i = Math.min(1, Math.max(0, Number.isFinite(intensity) ? intensity : 0));
  const merged = Math.min(Math.max(count, 1) - 1, 3) * 0.12;
  return base * (0.7 + 0.55 * Math.sqrt(i)) * (1 + merged);
}

// ---------------------------------------------------------------------------------------------
// Label placement
// ---------------------------------------------------------------------------------------------

/** A label that wants to sit at height `y` (usually the y of its band). */
export interface GelLabelTarget {
  y: number;
  /** Dropped only when every other candidate is protected too (ladder reference bands). */
  protected?: boolean;
  /** Tie-breaker when a label must be dropped: lighter labels go first (e.g. band intensity). */
  weight?: number;
  /**
   * Bounds of this label's centre (px), in addition to `maxShift`. Labels without a leader use the
   * midpoints to the neighbouring bands, so that a label always stays closest to its own band.
   */
  minY?: number;
  maxY?: number;
}

export interface GelLabelPlacementOptions {
  /** Minimum distance between the centres of two labels (px): their line height. */
  spacing: number;
  /** Bounds of the label centres (px). */
  minY: number;
  maxY: number;
  /** Largest distance a label may move away from its target (px). Default: `spacing`. */
  maxShift?: number;
}

/** A label that was kept: `index` into the targets, `y` its centre. */
export interface GelPlacedLabel {
  index: number;
  y: number;
}

/**
 * Positions labels on a vertical axis so that they never overlap: labels keep their order, are at
 * least `spacing` apart, stay inside [minY, maxY], and move as little as possible (least squares).
 * When a crowd of labels would have to move further than `maxShift` (or out of a label's own
 * bounds), labels are dropped, the most crowded first (which thins dense runs to every other
 * label), never protected ones while others remain. Returns the kept labels top to bottom.
 */
export function placeGelLabels(
  targets: readonly GelLabelTarget[],
  options: GelLabelPlacementOptions,
): GelPlacedLabel[] {
  const { spacing, minY, maxY } = options;
  const maxShift = options.maxShift ?? spacing;
  if (!(spacing > 0) || !(maxY >= minY)) return [];
  let active: ActiveLabel[] = targets
    .map((t, index) => ({
      index,
      y: t.y,
      protected: t.protected === true,
      weight: t.weight ?? 0,
      // the label may move within maxShift and its own bounds (which always contain its target)
      lo: Math.min(t.y, Math.max(t.y - maxShift, t.minY ?? -Infinity)),
      hi: Math.max(t.y, Math.min(t.y + maxShift, t.maxY ?? Infinity)),
    }))
    .filter((t) => Number.isFinite(t.y))
    .sort((a, b) => a.y - b.y || a.index - b.index);
  const capacity = Math.floor((maxY - minY) / spacing + EPS) + 1;
  // Very long inputs: keep the most important candidates so the thinning below stays cheap.
  if (active.length > capacity * 3) {
    const keep = new Set(
      [...active]
        .sort((a, b) => Number(b.protected) - Number(a.protected) || b.weight - a.weight || a.index - b.index)
        .slice(0, capacity * 3)
        .map((t) => t.index),
    );
    active = active.filter((t) => keep.has(t.index));
  }
  while (active.length > 0) {
    const placed = packLabels(
      active.map((t) => t.y),
      spacing,
      minY,
      maxY,
    );
    let lo = 0;
    let hi = active.length - 1;
    if (placed) {
      let worst = -1;
      let worstExcess = EPS;
      for (let i = 0; i < active.length; i++) {
        const excess = Math.max(active[i].lo - placed[i], placed[i] - active[i].hi);
        if (excess > worstExcess) {
          worstExcess = excess;
          worst = i;
        }
      }
      if (worst < 0) return active.map((t, i) => ({ index: t.index, y: placed[i] }));
      // the run of labels packed together with the worst one
      lo = worst;
      hi = worst;
      while (lo > 0 && placed[lo] - placed[lo - 1] <= spacing + EPS) lo--;
      while (hi < active.length - 1 && placed[hi + 1] - placed[hi] <= spacing + EPS) hi++;
    }
    active.splice(labelToDrop(active, lo, hi), 1);
  }
  return [];
}

/**
 * Least-squares packing: minimise Σ (p_i - y_i)² subject to p_{i+1} - p_i >= spacing and
 * minY <= p_i <= maxY. With z_i = p_i - i·spacing this is isotonic regression (pool adjacent
 * violators) clipped to constant bounds. Null when the labels cannot fit at all.
 */
function packLabels(ys: readonly number[], spacing: number, minY: number, maxY: number): number[] | null {
  const n = ys.length;
  const upper = maxY - (n - 1) * spacing;
  if (upper < minY - EPS) return null;
  const sums: number[] = [];
  const counts: number[] = [];
  for (let i = 0; i < n; i++) {
    let sum = ys[i] - i * spacing;
    let count = 1;
    while (sums.length > 0 && sums[sums.length - 1] / counts[counts.length - 1] > sum / count) {
      sum += sums.pop()!;
      count += counts.pop()!;
    }
    sums.push(sum);
    counts.push(count);
  }
  const out = new Array<number>(n);
  let i = 0;
  for (let b = 0; b < sums.length; b++) {
    const z = Math.min(Math.max(sums[b] / counts[b], minY), Math.max(upper, minY));
    for (let c = 0; c < counts[b]; c++, i++) out[i] = z + i * spacing;
  }
  return out;
}

interface ActiveLabel {
  index: number;
  y: number;
  protected: boolean;
  weight: number;
  /** Allowed range of the label centre. */
  lo: number;
  hi: number;
}

/** Index (into `active`) of the label to drop among active[lo..hi]: unprotected, most crowded, lightest. */
function labelToDrop(active: readonly ActiveLabel[], lo: number, hi: number): number {
  let best = lo;
  let bestKey: [number, number, number] | null = null;
  for (let i = lo; i <= hi; i++) {
    const t = active[i];
    const before = i > 0 ? t.y - active[i - 1].y : Infinity;
    const after = i < active.length - 1 ? active[i + 1].y - t.y : Infinity;
    const key: [number, number, number] = [t.protected ? 1 : 0, before + after, t.weight];
    if (
      bestKey === null ||
      key[0] < bestKey[0] ||
      (key[0] === bestKey[0] && (key[1] < bestKey[1] - EPS || (Math.abs(key[1] - bestKey[1]) <= EPS && key[2] < bestKey[2])))
    ) {
      best = i;
      bestKey = key;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------------------------

/** A band as drawn. */
export interface GelBandGeometry {
  /** The caller's band object. */
  band: GelLaneBand;
  /** Index of the band in `lane.bands`. */
  sourceIndex: number;
  /** Centre (px). */
  y: number;
  /** Thickness (px). */
  height: number;
  alpha: number;
  glow: number;
}

/** A horizontal slice of a smear lane. */
export interface GelSmearSegment {
  y: number;
  height: number;
  alpha: number;
}

/** Size written next to a sample band (showSizes 'all'). */
export interface GelSizeLabel {
  /** Index into the lane's `bands`. */
  bandIndex: number;
  text: string;
  /** Left end of the text (px). */
  x: number;
  /** Centre of the text (px). */
  y: number;
  /** Centre of the band (px); differs from y when the label had to move. */
  bandY: number;
  width: number;
  /** Reference band of a ladder (drawn bolder). */
  emphasized: boolean;
}

export interface GelLaneGeometry {
  lane: GelLane;
  index: number;
  /** Column of the lane (hit area, selection highlight). */
  x: number;
  width: number;
  /** Horizontal centre of the bands. */
  cx: number;
  bandLeft: number;
  bandWidth: number;
  well: GelRect;
  /** Visible bands, top to bottom. */
  bands: GelBandGeometry[];
  /** Set when the lane has too many bands to draw one by one: the lane is drawn as a smear. */
  smear: GelSmearSegment[] | null;
  sizeLabels: GelSizeLabel[];
  /** Bands below the bottom of the gel (not drawn). */
  ranOff: number;
}

/** Size label of a ladder band in a gutter beside the slab. */
export interface GelLadderLabel {
  side: 'left' | 'right';
  /** Index into the ladder lane's `bands`. */
  bandIndex: number;
  text: string;
  emphasized: boolean;
  /** Text anchor: right end of the text on the left side, left end on the right side (px). */
  x: number;
  /** Centre of the text (px). */
  y: number;
  /** Leader from the slab edge to the text: polyline points [x0, y0, x1, y1, x2, y2]. */
  leader: [number, number, number, number, number, number];
}

/** Short tick marking a ladder band without a label (dense ladders). */
export interface GelLadderTick {
  side: 'left' | 'right';
  y: number;
  x1: number;
  x2: number;
}

/**
 * How lane labels are written: horizontally (centred over the lane), at 45° or 90° when they do not
 * fit, or not at all when lanes are too narrow (the label is then only in tooltips and aria labels).
 */
export type GelHeaderMode = 'horizontal' | 'diagonal' | 'vertical' | 'hidden';

export interface GelHeaderLabel {
  laneIndex: number;
  text: string;
  /** 'horizontal': centre of the text; rotated: start of the text's centre line (px). */
  x: number;
  /** Bottom of the text box for 'horizontal'; anchor of the rotated text's centre line (px). */
  y: number;
  /** Longest allowed text length (px); longer text is truncated with an ellipsis. */
  maxWidth: number;
  truncated: boolean;
}

export interface GelHeaderLayout {
  mode: GelHeaderMode;
  /** Height reserved above the slab (px). */
  height: number;
  /** Line height of the labels (px). */
  lineHeight: number;
  labels: GelHeaderLabel[];
}

export interface GelLayout {
  /** Size of the drawing (px): at least the available size; larger when the lanes do not fit. */
  width: number;
  height: number;
  slab: GelRect;
  scale: GelScale;
  /** Distance between lane centres (px). */
  pitch: number;
  /** Width of the band area of a lane (px; at most {@link GEL_MAX_LANE_WIDTH}). */
  laneWidth: number;
  /** Thickness of a band of intensity 1 before brightness adjustments (px). */
  bandThickness: number;
  lanes: GelLaneGeometry[];
  /** Index of the ladder lane whose sizes are written at the left (-1 = none), and at the right. */
  ladderLeft: number;
  ladderRight: number;
  ladderLabels: GelLadderLabel[];
  ladderTicks: GelLadderTick[];
  header: GelHeaderLayout;
  /** "1% agarose", written in the bottom-right corner of the slab. */
  caption: { text: string; x: number; y: number } | null;
  /** Blur (px) giving bands their soft edges, horizontally and vertically, and of the glow. */
  blur: { x: number; y: number; glow: number };
  compact: boolean;
}

export interface GelLayoutOptions {
  /** Available size (px). */
  width: number;
  height: number;
  showSizes?: GelSizeLabels;
  agarosePercent?: number;
  /** Text measurement (default: a font-metrics estimate). */
  measure?: GelTextMeasurer;
  /** Thumbnail mode: no labels, no gutters, the slab fills the whole size. */
  compact?: boolean;
}

interface PreparedBand {
  band: GelLaneBand;
  sourceIndex: number;
  position: number;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}

function finite(v: number, fallback: number): number {
  return Number.isFinite(v) ? v : fallback;
}

/** Bands that can be drawn (finite numbers, some DNA), top to bottom. */
function prepareBands(lane: GelLane): PreparedBand[] {
  const out: PreparedBand[] = [];
  lane.bands.forEach((band, sourceIndex) => {
    if (!Number.isFinite(band.position) || !Number.isFinite(band.size) || !(band.intensity > 0)) return;
    out.push({ band, sourceIndex, position: Math.max(0, band.position) });
  });
  return out.sort((a, b) => a.position - b.position || a.sourceIndex - b.sourceIndex);
}

function sameBandSizes(a: readonly PreparedBand[], b: readonly PreparedBand[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((x, i) => Math.round(x.band.size) === Math.round(b[i].band.size));
}

/** Plan of the lane labels before the slab is placed. */
interface HeaderPlan {
  mode: GelHeaderMode;
  height: number;
  /** Text length allowed per lane (px). */
  allowed: number[];
  truncated: boolean[];
  /** Lane pitch: the natural one, or wider so that horizontal labels fit. */
  pitch: number;
}

/** Smallest gap between two horizontal lane labels (px). */
const LABEL_SPACING = 8;

/**
 * Chooses how lane labels are written. Horizontal when every label fits between its neighbours,
 * if necessary by spreading the lanes up to `maxPitch` apart (lanes keep their width; only the gaps
 * grow); otherwise rotated by 45° (or 90° for narrow lanes) and truncated at `capLen`; hidden when
 * the lanes are too narrow even for vertical text.
 */
function planHeader(
  texts: readonly string[],
  widths: readonly number[],
  pitch: number,
  maxPitch: number,
  singleMax: number,
  capLen: number,
): HeaderPlan {
  const n = texts.length;
  const none: HeaderPlan = { mode: 'hidden', height: 0, allowed: widths.map(() => 0), truncated: widths.map(() => false), pitch };
  if (n === 0 || widths.every((w) => w <= 0)) return none;
  const horizontalHeight = LANE_LINE + HEADER_GAP;
  if (n === 1) {
    const allowed = Math.min(widths[0], singleMax);
    return { mode: 'horizontal', height: horizontalHeight, allowed: [allowed], truncated: [widths[0] > singleMax + 0.5], pitch };
  }
  // pitch needed by consecutive labels (lanes without a label leave their space to the neighbours)
  let required = 0;
  let prev = -1;
  for (let i = 0; i < n; i++) {
    if (widths[i] <= 0) continue;
    if (prev >= 0) required = Math.max(required, ((widths[prev] + widths[i]) / 2 + LABEL_SPACING) / (i - prev));
    prev = i;
  }
  if (required <= pitch || required <= maxPitch) {
    return {
      mode: 'horizontal',
      height: horizontalHeight,
      allowed: [...widths],
      truncated: widths.map(() => false),
      pitch: Math.max(pitch, Math.ceil(required)),
    };
  }
  const rotated = (mode: 'diagonal' | 'vertical'): HeaderPlan => {
    const allowed = widths.map((w) => Math.min(w, capLen));
    const longest = Math.max(...allowed);
    const height =
      mode === 'diagonal' ? (longest + LANE_LINE * 0.5) * Math.SQRT1_2 + LANE_LINE * 0.5 + HEADER_GAP : longest + HEADER_GAP + 2;
    return { mode, height: Math.ceil(height), allowed, truncated: widths.map((w) => w > capLen + 0.5), pitch };
  };
  // Parallel 45° labels are pitch·sin 45° apart; vertical ones a full pitch.
  if (pitch * Math.SQRT1_2 >= LANE_LINE - 2) return rotated('diagonal');
  if (pitch >= LANE_LINE - 3) return rotated('vertical');
  return { ...none, height: 4 };
}

/**
 * Computes the whole gel drawing for an available size. Lanes share the width (at most
 * {@link GEL_MAX_LANE_WIDTH} each) and are centred; the slab fills the height.
 */
export function computeGelLayout(lanes: readonly GelLane[], options: GelLayoutOptions): GelLayout {
  const compact = options.compact === true;
  const showSizes: GelSizeLabels = compact ? 'none' : (options.showSizes ?? 'ladder');
  const measure = options.measure ?? approximateGelTextWidth;
  const W = Math.max(0, finite(options.width, 0));
  const H = Math.max(0, finite(options.height, 0));
  const n = lanes.length;
  const pad = compact ? 0 : clamp(Math.min(W, H) * 0.03, 12, 24);

  const prepared = lanes.map(prepareBands);
  const isSmear = prepared.map((p) => p.length > GEL_SMEAR_THRESHOLD);

  // Ladders whose sizes are written in the gutters: the first ladder at the left; the last lane at the
  // right when it is a different ladder (e.g. 1 kb on the left, 100 bp on the right).
  let ladderLeft = showSizes === 'none' ? -1 : lanes.findIndex((l) => l.kind === 'ladder');
  if (ladderLeft >= 0 && isSmear[ladderLeft]) ladderLeft = -1;
  const last = n - 1;
  const ladderRight =
    ladderLeft >= 0 && last > ladderLeft && lanes[last].kind === 'ladder' && !isSmear[last] && !sameBandSizes(prepared[ladderLeft], prepared[last])
      ? last
      : -1;
  const gutterWidth = (laneIndex: number): number => {
    if (laneIndex < 0 || prepared[laneIndex].length === 0) return 0;
    let widest = 0;
    for (const p of prepared[laneIndex]) {
      widest = Math.max(widest, measure(formatGelSize(p.band.size, 'ladder'), p.band.emphasized ? 'ladderStrong' : 'ladder'));
    }
    return Math.ceil(TICK_GAP + TICK + KINK + LABEL_GAP + widest + 2);
  };
  const gutterL = gutterWidth(ladderLeft);
  const gutterR = gutterWidth(ladderRight);

  // Size labels next to the bands of every other lane.
  const labelledLane = (i: number) => showSizes === 'all' && i !== ladderLeft && i !== ladderRight && !isSmear[i];
  let sideLabel = 0;
  if (showSizes === 'all') {
    prepared.forEach((bands, i) => {
      if (!labelledLane(i)) return;
      for (const p of bands) sideLabel = Math.max(sideLabel, measure(formatGelSize(p.band.size, 'band'), p.band.emphasized ? 'sizeStrong' : 'size'));
    });
    if (sideLabel > 0) sideLabel = Math.ceil(Math.min(sideLabel, MAX_SIDE_LABEL) + SIDE_LABEL_GAP + 2);
  }

  // Lane width: share the available width.
  const availW = Math.max(0, W - 2 * pad - gutterL - gutterR);
  const maxLane = compact ? Math.max(6, W * 0.17) : GEL_MAX_LANE_WIDTH;
  const minLane = compact ? 2 : MIN_LANE_WIDTH;
  const margin = (laneW: number) => (compact ? clamp(laneW * 0.35, 3, 10) : clamp(laneW * 0.4, 10, 24));
  const fitLane = (labelW: number): number => {
    if (n === 0) return 0;
    const first = availW / n - labelW;
    return clamp((availW - 2 * margin(clamp(first, minLane, maxLane))) / n - labelW, minLane, maxLane);
  };
  let laneWidth = fitLane(sideLabel);
  if (sideLabel > 0 && laneWidth < 24) {
    sideLabel = 0; // no room for size labels: tooltips only
    laneWidth = fitLane(0);
  }
  const sideMargin = n > 0 ? margin(laneWidth) : 0;

  // Lane labels (may spread the lanes a little so that the labels stay horizontal).
  const naturalPitch = laneWidth + sideLabel;
  const labelTexts = lanes.map((l) => l.label.trim());
  const labelWidths = labelTexts.map((t) => (t.length > 0 ? Math.ceil(measure(t, 'lane')) : 0));
  const capLen = clamp((H - 2 * pad) * 0.18 * Math.SQRT2, 56, 200);
  const maxPitch = n > 0 ? Math.min(naturalPitch * 1.6, (availW - 2 * sideMargin) / n) : 0;
  const headerPlan = compact
    ? planHeader([], [], naturalPitch, naturalPitch, 0, 0)
    : planHeader(labelTexts, labelWidths, naturalPitch, maxPitch, Math.max(W - 2 * pad, 40), capLen);
  const pitch = headerPlan.pitch;
  const bandArea = pitch - sideLabel; // bands are centred in this part of the lane column
  const lanesW = n * pitch;
  const neededSlabW = lanesW + 2 * sideMargin;

  // Slab.
  const slabTop = pad + headerPlan.height;
  const slabH = compact ? H : Math.max(140, H - slabTop - pad);
  // Text sticking out past the slab's sides (wide horizontal labels, rotated labels at the right).
  const overflowFor = (slabW: number): { left: number; right: number } => {
    if (headerPlan.mode === 'hidden' || n === 0) return { left: 0, right: 0 };
    const offset = (slabW - lanesW) / 2;
    let left = 0;
    let right = 0;
    for (let i = 0; i < n; i++) {
      const cx = offset + i * pitch + bandArea / 2;
      const len = headerPlan.allowed[i];
      if (len <= 0) continue;
      if (headerPlan.mode === 'horizontal') {
        left = Math.max(left, len / 2 - cx);
        right = Math.max(right, cx + len / 2 - slabW);
      } else if (headerPlan.mode === 'diagonal') {
        right = Math.max(right, cx + (len + LANE_LINE * 0.5) * Math.SQRT1_2 - slabW);
      } else {
        right = Math.max(right, cx + LANE_LINE / 2 - slabW);
      }
    }
    return { left: Math.ceil(left), right: Math.ceil(right) };
  };
  let slabW: number;
  if (compact) {
    slabW = W;
  } else {
    // The slab hugs the lanes (so that the ladder sizes stay close to the ladder), but one or two
    // lanes still get a gel-shaped slab rather than a sliver.
    const worst = overflowFor(neededSlabW);
    const room = W - 2 * pad - Math.max(gutterL, worst.left) - Math.max(gutterR, worst.right);
    const minLanes = n > 0 ? MIN_SLAB_LANES * pitch + 2 * sideMargin : MIN_SLAB_LANES * GEL_MAX_LANE_WIDTH + 2 * margin(GEL_MAX_LANE_WIDTH);
    const minW = Math.max(MIN_SLAB_WIDTH, minLanes, slabH * SLAB_ASPECT);
    slabW = Math.max(neededSlabW, Math.min(minW, room));
  }
  const overflow = overflowFor(slabW);
  const leftExtra = compact ? 0 : Math.max(gutterL, overflow.left);
  const rightExtra = compact ? 0 : Math.max(gutterR, overflow.right);
  let slabX = (W - slabW) / 2;
  if (!compact) {
    if (slabX < pad + leftExtra) slabX = pad + leftExtra;
    if (slabX + slabW + rightExtra + pad > W) slabX = Math.max(pad + leftExtra, W - pad - rightExtra - slabW);
  }
  slabX = Math.round(slabX);
  slabW = Math.round(slabW);
  const slab: GelRect = { x: slabX, y: Math.round(slabTop), width: slabW, height: Math.round(slabH) };
  const width = Math.max(W, Math.ceil(slab.x + slab.width + rightExtra + pad));
  const height = Math.max(H, Math.ceil(slab.y + slab.height + pad));

  // Vertical scale.
  const wellOffset = compact ? clamp(slab.height * 0.05, 4, 10) : clamp(slab.height * 0.04, 10, 22);
  const wellH = compact ? clamp(slab.height * 0.022, 2, 4) : clamp(slab.height * 0.016, 4, 8);
  const wellTop = slab.y + wellOffset;
  const bottomMargin = compact ? clamp(slab.height * 0.04, 4, 10) : clamp(slab.height * 0.04, 12, 26);
  const scale: GelScale = { top: wellTop + wellH / 2, bottom: slab.y + slab.height - bottomMargin };
  const run = scale.bottom - scale.top;
  const bandThickness = compact ? clamp(run * 0.016, 1.5, 3.5) : clamp(run * 0.0125, 3, 9);
  const slabBottom = slab.y + slab.height;

  // Lanes.
  const bandWidth = Math.max(compact ? 2 : 4, laneWidth * BAND_FILL);
  const lanesLeft = slab.x + (slab.width - lanesW) / 2;
  const laneGeoms: GelLaneGeometry[] = lanes.map((lane, index) => {
    const x = lanesLeft + index * pitch;
    const cx = x + bandArea / 2;
    const bandLeft = cx - bandWidth / 2;
    const bands: GelBandGeometry[] = [];
    let ranOff = 0;
    for (const p of prepared[index]) {
      const y = gelPositionToY(p.position, scale);
      const h = gelBandThickness(bandThickness, p.band.intensity, p.band.count ?? 1);
      if (y - h / 2 > slabBottom - 1) {
        ranOff++;
        continue;
      }
      bands.push({
        band: p.band,
        sourceIndex: p.sourceIndex,
        y,
        height: h,
        alpha: gelBandAlpha(p.band.intensity),
        glow: gelBandGlow(p.band.intensity),
      });
    }
    return {
      lane,
      index,
      x,
      width: pitch,
      cx,
      bandLeft,
      bandWidth,
      well: { x: bandLeft - 1, y: wellTop, width: bandWidth + 2, height: wellH },
      bands,
      smear: isSmear[index] ? buildSmear(bands, slab.y, slabBottom, compact ? 1 : 2) : null,
      sizeLabels: [],
      ranOff,
    };
  });

  // Ladder sizes in the gutters.
  const ladderLabels: GelLadderLabel[] = [];
  const ladderTicks: GelLadderTick[] = [];
  const gutter = (laneIndex: number, side: 'left' | 'right') => {
    const lane = laneGeoms[laneIndex];
    if (!lane || lane.bands.length === 0) return;
    const targets = lane.bands.map((g) => ({ y: g.y, protected: g.band.emphasized === true, weight: g.band.intensity }));
    const placed = placeGelLabels(targets, {
      spacing: LADDER_LINE,
      minY: slab.y + LADDER_LINE / 2,
      maxY: slabBottom - LADDER_LINE / 2,
      maxShift: LADDER_LINE * 0.7,
    });
    // labels that moved by a hair keep a straight tick; the leader bends only for real moves
    const moved = placed.some((p) => Math.abs(p.y - targets[p.index].y) > LEADER_BEND);
    const dir = side === 'left' ? -1 : 1;
    const edge = side === 'left' ? slab.x - TICK_GAP : slab.x + slab.width + TICK_GAP;
    const tickEnd = edge + dir * TICK;
    const kinkEnd = tickEnd + dir * (moved ? KINK : 0);
    const labelled = new Set<number>();
    for (const p of placed) {
      const g = lane.bands[p.index];
      labelled.add(p.index);
      ladderLabels.push({
        side,
        bandIndex: p.index,
        text: formatGelSize(g.band.size, 'ladder'),
        emphasized: g.band.emphasized === true,
        x: kinkEnd + dir * LABEL_GAP,
        y: p.y,
        leader: [edge, g.y, tickEnd, g.y, kinkEnd, Math.abs(p.y - g.y) > LEADER_BEND ? p.y : g.y],
      });
    }
    lane.bands.forEach((g, i) => {
      if (!labelled.has(i)) ladderTicks.push({ side, y: g.y, x1: edge, x2: edge + dir * TICK * 0.6 });
    });
  };
  if (!compact) {
    if (ladderLeft >= 0) gutter(ladderLeft, 'left');
    if (ladderRight >= 0) gutter(ladderRight, 'right');
  }

  // Sizes next to the other lanes' bands. Without leaders, a label must stay closer to its own band
  // than to any other band of the lane (bounds halfway to the neighbours); crowded labels are dropped.
  if (sideLabel > 0) {
    for (const lane of laneGeoms) {
      if (!labelledLane(lane.index) || lane.bands.length === 0) continue;
      const texts = lane.bands.map((g) => formatGelSize(g.band.size, 'band'));
      const bands = lane.bands;
      const placed = placeGelLabels(
        bands.map((g, i) => ({
          y: g.y,
          protected: g.band.emphasized === true,
          weight: g.band.intensity,
          minY: i > 0 ? (bands[i - 1].y + g.y) / 2 : undefined,
          maxY: i < bands.length - 1 ? (g.y + bands[i + 1].y) / 2 : undefined,
        })),
        { spacing: SIZE_LINE, minY: slab.y + SIZE_LINE / 2 + 2, maxY: slabBottom - SIZE_LINE / 2 - 2, maxShift: SIZE_LINE / 2 },
      );
      lane.sizeLabels = placed.map((p) => ({
        bandIndex: p.index,
        text: texts[p.index],
        x: lane.bandLeft + lane.bandWidth + SIDE_LABEL_GAP,
        y: p.y,
        bandY: lane.bands[p.index].y,
        width: Math.min(measure(texts[p.index], lane.bands[p.index].band.emphasized ? 'sizeStrong' : 'size'), MAX_SIDE_LABEL),
        emphasized: lane.bands[p.index].band.emphasized === true,
      }));
    }
  }

  // Lane labels.
  const headerLabels: GelHeaderLabel[] = [];
  if (headerPlan.mode !== 'hidden') {
    laneGeoms.forEach((lane, i) => {
      if (labelTexts[i].length === 0) return;
      headerLabels.push({
        laneIndex: i,
        text: labelTexts[i],
        x: lane.cx,
        y: slab.y - HEADER_GAP,
        maxWidth: headerPlan.allowed[i],
        truncated: headerPlan.truncated[i],
      });
    });
  }

  const captionText = compact ? undefined : formatAgarose(options.agarosePercent);
  const caption =
    captionText && slab.height >= 160 && slab.width >= 120
      ? { text: captionText, x: slab.x + slab.width - 10, y: slabBottom - 9 }
      : null;

  return {
    width,
    height,
    slab,
    scale,
    pitch,
    laneWidth,
    bandThickness,
    lanes: laneGeoms,
    ladderLeft,
    ladderRight,
    ladderLabels,
    ladderTicks,
    header: { mode: headerPlan.mode, height: headerPlan.height, lineHeight: LANE_LINE, labels: headerLabels },
    caption,
    blur: compact
      ? { x: 0.35, y: Math.max(0.35, bandThickness * 0.16), glow: 1.6 }
      : { x: 0.6, y: Math.max(0.6, bandThickness * 0.16), glow: clamp(bandThickness * 0.75, 2.5, 6) },
    compact,
  };
}

/**
 * Smear of a lane with very many bands: each band spreads its intensity over the rows it covers;
 * rows are normalised to the brightest one and runs of equal opacity are merged.
 */
function buildSmear(bands: readonly GelBandGeometry[], top: number, bottom: number, row: number): GelSmearSegment[] {
  const rows = Math.max(1, Math.ceil((bottom - top) / row));
  const acc = new Float64Array(rows);
  for (const g of bands) {
    const r0 = clamp(Math.floor((g.y - g.height / 2 - top) / row), 0, rows - 1);
    const r1 = clamp(Math.floor((g.y + g.height / 2 - top) / row), 0, rows - 1);
    const share = g.band.intensity / (r1 - r0 + 1);
    for (let r = r0; r <= r1; r++) acc[r] += share;
  }
  let max = 0;
  for (let r = 0; r < rows; r++) max = Math.max(max, acc[r]);
  const segments: GelSmearSegment[] = [];
  if (max <= 0) return segments;
  for (let r = 0; r < rows; r++) {
    const alpha = Math.round(gelSmearAlpha(acc[r] / max) * 64) / 64;
    if (alpha <= 0) continue;
    const y = top + r * row;
    const prev = segments[segments.length - 1];
    if (prev && prev.alpha === alpha && Math.abs(prev.y + prev.height - y) < EPS) prev.height += row;
    else segments.push({ y, height: row, alpha });
  }
  return segments;
}

// ---------------------------------------------------------------------------------------------
// Hit-testing
// ---------------------------------------------------------------------------------------------

/** What is under a point of the gel. */
export interface GelHit {
  laneIndex: number;
  /** Index into `layout.lanes[laneIndex].bands`, or -1 when the point is in the lane but not on a band. */
  bandIndex: number;
  /**
   * Smear lanes: the unresolved bands under the point, as a [start, end) range of `bands`
   * (present when more than one band is there; `bandIndex` is then the closest one).
   */
  range?: { start: number; end: number };
}

const HIT_SLOP_X = 6;

/** Index of the lane whose column contains x, or -1. */
export function gelLaneAt(layout: GelLayout, x: number): number {
  for (const lane of layout.lanes) if (x >= lane.x && x < lane.x + lane.width) return lane.index;
  return -1;
}

/** First index of `bands` whose y is >= y (bands are sorted by y). */
function lowerBound(bands: readonly GelBandGeometry[], y: number): number {
  let lo = 0;
  let hi = bands.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (bands[mid].y < y) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * The lane and band at (x, y) (drawing coordinates). A band is hit within its thickness plus a
 * little slop (at least ±4 px), or on its size label; overlapping hits go to the closest band
 * centre. Returns null outside the slab or between lanes.
 */
export function hitTestGel(layout: GelLayout, x: number, y: number): GelHit | null {
  const { slab } = layout;
  if (y < slab.y || y > slab.y + slab.height || x < slab.x || x > slab.x + slab.width) return null;
  const laneIndex = gelLaneAt(layout, x);
  if (laneIndex < 0) return null;
  const lane = layout.lanes[laneIndex];
  const onBands = x >= lane.bandLeft - HIT_SLOP_X && x <= lane.bandLeft + lane.bandWidth + HIT_SLOP_X;

  if (lane.smear) {
    if (!onBands) return { laneIndex, bandIndex: -1 };
    const r = Math.max(3, layout.bandThickness * 0.6);
    const start = lowerBound(lane.bands, y - r);
    const end = lowerBound(lane.bands, y + r + EPS);
    if (end <= start) return { laneIndex, bandIndex: -1 };
    let closest = start;
    for (let i = start + 1; i < end; i++) if (Math.abs(lane.bands[i].y - y) < Math.abs(lane.bands[closest].y - y)) closest = i;
    return end - start > 1 ? { laneIndex, bandIndex: closest, range: { start, end } } : { laneIndex, bandIndex: closest };
  }

  if (onBands) {
    let best = -1;
    let bestDist = Infinity;
    const at = lowerBound(lane.bands, y);
    // walk outwards from the insertion point while bands can still be within reach
    for (let i = at - 1; i >= 0; i--) {
      const g = lane.bands[i];
      const d = y - g.y;
      if (d > 12 + g.height) break;
      if (d <= Math.max(g.height / 2 + 2, 4) && d < bestDist) {
        best = i;
        bestDist = d;
      }
    }
    for (let i = at; i < lane.bands.length; i++) {
      const g = lane.bands[i];
      const d = g.y - y;
      if (d > 12 + g.height) break;
      if (d <= Math.max(g.height / 2 + 2, 4) && (d < bestDist || (d === bestDist && g.band.intensity > lane.bands[best].band.intensity))) {
        best = i;
        bestDist = d;
      }
    }
    if (best >= 0) return { laneIndex, bandIndex: best };
  }
  for (const label of lane.sizeLabels) {
    if (x >= label.x - 2 && x <= label.x + label.width + 2 && Math.abs(y - label.y) <= SIZE_LINE / 2) {
      return { laneIndex, bandIndex: label.bandIndex };
    }
  }
  return { laneIndex, bandIndex: -1 };
}
