/**
 * Hit testing for the linear map: what lies under a point of the map (in map coordinates, y
 * measured from the top of the map content). Pure functions over the view model.
 */
import type { CutMarker } from './enzymeLabels';
import type { Lane } from './lanes';
import { visibleSpan } from './lanes';
import type { BandTops, FeatureEntry, OrfEntry, PrimerEntry, TextBox, TrackSet, ViewModel } from './layout';
import { METRICS, MIN_BAR_PX, PRIMER_MIN_PX, featureBarTop, featurePieceShape } from './layout';
import type { MapTarget } from './types';
import type { LinearScale } from './viewport';

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

/**
 * Index of the lane item at x (px) within `tol` px, preferring an item that contains x. Items
 * narrower than `minWidth` count as that wide around their centre (as they are drawn).
 */
function itemAt(lane: Lane, scale: LinearScale, x: number, tol: number, minWidth: number): number {
  const reach = tol + minWidth / 2;
  const [i0, i1] = visibleSpan(lane, scale.bp(x - reach), scale.bp(x + reach));
  let best = -1;
  let bestDist = Infinity;
  for (let i = i0; i < i1; i++) {
    const it = lane.items[i];
    let x0 = scale.x(it.start);
    let x1 = scale.x(it.end);
    if (x1 - x0 < minWidth) {
      const c = (x0 + x1) / 2;
      x0 = c - minWidth / 2;
      x1 = c + minWidth / 2;
    }
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

/** What lies at (x, y). */
export function hitTest(input: HitInput, x: number, y: number): MapTarget {
  const { view } = input;
  const { scale, v } = view;
  const L = view.seqLength;
  const { base, gap } = positionsAt(scale, x, L);

  // Labels first: outside labels sit in other lanes' space.
  if (input.markers) {
    for (const lab of view.enzymes.labels) {
      if (inBox(lab, x, y)) return { kind: 'enzyme', site: input.markers[lab.marker].site };
    }
  }
  if (input.features) {
    for (const lab of view.features.labels) {
      if (lab.placement !== 'inside' && inBox(lab, x, y, 1)) return { kind: 'feature', id: input.features.entries[lab.entry].feature.id };
    }
  }
  if (input.primers) {
    for (const lab of view.primers.labels) {
      if (inBox(lab, x, y, 1)) return { kind: 'primer', id: input.primers.entries[lab.entry].site.primerId };
    }
  }

  const laneHit = <E extends FeatureEntry | OrfEntry | PrimerEntry>(
    set: TrackSet<E> | null,
    tops: BandTops,
    h: number,
    tol: number,
    minWidth: number,
  ): E | null => {
    if (!set) return null;
    for (const side of ['above', 'below'] as const) {
      const lanes = set[side];
      for (let lane = 0; lane < lanes.length; lane++) {
        const top = tops[side][lane];
        if (y < top || y >= top + h) continue;
        const i = itemAt(lanes[lane], scale, x, tol, minWidth);
        return i >= 0 ? set.entries[lanes[lane].items[i].ref] : null;
      }
    }
    return null;
  };

  const f = laneHit(input.features, v.features, METRICS.featureLaneHeight, 2, MIN_BAR_PX);
  if (f) return { kind: 'feature', id: f.feature.id };
  const o = laneHit(input.orfs, v.orfs, METRICS.orfLaneHeight, 2, 1);
  if (o) return { kind: 'orf', orf: o.orf };
  const p = laneHit(input.primers, v.primers, METRICS.primerLaneHeight, 2, PRIMER_MIN_PX);
  if (p) return { kind: 'primer', id: p.site.primerId };

  // Backbone and ruler. Cut marks are thin, so they get a few px of slack.
  if (y >= v.topStrandY - 7 && y <= v.rulerBottom) {
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
    const bp = scale.bp(x);
    if (L > 0 && bp >= 0 && bp <= L) return { kind: 'sequence', position: base };
  }
  return { kind: 'background', position: gap };
}

/**
 * Outline of a feature at the current zoom (all its visible pieces), widened to at least
 * `minWidth` px, for the hover and highlight rings. Empty when the feature is not visible.
 */
export function featureOutline(view: ViewModel, set: TrackSet<FeatureEntry>, entryIndex: number, minWidth = 3): string {
  const entry = set.entries[entryIndex];
  if (!entry) return '';
  const lanes = view.v.features[entry.side];
  if (entry.lane >= lanes.length) return '';
  const L = view.seqLength;
  const top = featureBarTop(view.v, entry.side, entry.lane);
  const pieces: Array<{ start: number; end: number; piece: 0 | 1 | 2 }> =
    entry.extent.end > L
      ? [
          { start: entry.extent.start, end: L, piece: 1 },
          { start: 0, end: entry.extent.end - L, piece: 2 },
        ]
      : [{ start: entry.extent.start, end: entry.extent.end, piece: 0 }];
  let d = '';
  for (const p of pieces) {
    if (p.end <= view.bpFrom || p.start >= view.bpTo) continue;
    d += featurePieceShape(entry, p, top, { scale: view.scale, width: view.width, seqLength: L }, minWidth).d;
  }
  return d;
}

/**
 * True when at least `minPx` of the feature is on screen (narrow features count as drawn, at
 * least MIN_BAR_PX wide). Parts in the off-screen drawing margin do not count.
 */
export function featureOnScreen(view: ViewModel, set: TrackSet<FeatureEntry>, entryIndex: number, minPx = 1): boolean {
  const entry = set.entries[entryIndex];
  if (!entry) return false;
  const L = view.seqLength;
  const { scale, width } = view;
  const pieces =
    entry.extent.end > L
      ? [
          { start: entry.extent.start, end: L },
          { start: 0, end: entry.extent.end - L },
        ]
      : [entry.extent];
  return pieces.some((p) => {
    const c = (scale.x(p.start) + scale.x(p.end)) / 2;
    const half = Math.max(MIN_BAR_PX, scale.x(p.end) - scale.x(p.start)) / 2;
    return Math.min(width, c + half) - Math.max(0, c - half) >= minPx;
  });
}

/** Index (into the track entries) of the feature with this id, or -1. */
export function featureEntryIndex(set: TrackSet<FeatureEntry> | null, id: string | null | undefined): number {
  if (!set || !id) return -1;
  for (let i = 0; i < set.entries.length; i++) if (set.entries[i].feature.id === id) return i;
  return -1;
}
