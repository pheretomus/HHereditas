/**
 * Simulated gel lanes: where each fragment runs (see `migration.ts`), which fragments co-migrate
 * into one visible band, and how bright the bands are relative to each other.
 *
 * Positions use the convention of `migration.ts`: 0 = well, 1 = bottom of the gel after a standard
 * run. Intensities are relative: ethidium-type stains fluoresce in proportion to the number of base
 * pairs, so a band's brightness is taken proportional to its DNA mass (size x molar amount, or the
 * vendor's ng for ladders), normalised so that the brightest band of the lane is 1. Differences in
 * dye binding between conformations (supercoiled DNA binds less ethidium) are not modelled.
 */
import type { Ladder } from './ladders';
import { DEFAULT_AGAROSE_PERCENT, formSizeFactor, gelParameters, positionOnGel } from './migration';
import type { DnaForm, GelConditions } from './migration';

/** One DNA species loaded in a lane. */
export interface GelFragment {
  /** Length in bp (> 0). */
  size: number;
  /** Relative number of molecules (any consistent unit, e.g. pmol or copies). Default 1; 0 = not drawn. */
  molarAmount?: number;
  /** Conformation; default 'linear'. */
  form?: DnaForm;
  /** Text describing the fragment (e.g. 'PvuII-PvuII'); collected in {@link GelBand.labels}. */
  label?: string;
}

/** Options of {@link simulateLane} and {@link ladderLane}. */
export interface LaneOptions extends GelConditions {
  /**
   * Smallest distance (fraction of the gel length) at which two bands are told apart; fragments whose
   * positions differ by less merge into one band. Default {@link DEFAULT_RESOLUTION}.
   */
  resolution?: number;
}

/**
 * Default band resolution: 0.01 of the gel length, about 0.8 mm on a standard 8 cm mini gel, i.e.
 * roughly one band width. Example: at 1 % TAE this merges NEB's 500/517 bp doublet (0.005 apart)
 * but separates 400 from 500 bp.
 */
export const DEFAULT_RESOLUTION = 0.01;

/** A visible band of a simulated lane. */
export interface GelBand {
  /** Size (bp) of the band: mass-weighted mean of the sizes of its fragments. */
  size: number;
  /** Centre of the band (0 = well .. 1 = bottom): mass-weighted mean position of its fragments. */
  position: number;
  /** Relative brightness, proportional to the band's DNA mass; the brightest band of the lane is 1. */
  intensity: number;
  /** Number of co-migrating fragments merged into this band (a ladder doublet row counts its components). */
  count: number;
  /** Labels of the merged fragments, top to bottom (fragments without a label contribute none). */
  labels: string[];
  /** Sizes (bp) of the merged fragments, largest first. */
  sizes: number[];
  /** Ladder lanes with vendor masses only: total DNA (ng) in the band at the ladder's reference load. */
  massNg?: number;
  /** Ladder lanes only: true when the band contains a vendor reference band. */
  emphasized?: boolean;
}

interface LaneItem {
  position: number;
  mass: number;
  size: number;
  sizes: number[];
  labels: string[];
  count: number;
  massNg?: number;
  emphasized?: boolean;
}

function checkResolution(resolution: number): void {
  if (!Number.isFinite(resolution) || resolution < 0) {
    throw new RangeError(`resolution must be a finite number >= 0, got ${resolution}`);
  }
}

/**
 * Merge co-migrating items. Items are sorted top to bottom; consecutive items closer than
 * `resolution` (or at exactly the same position) join the same band (single linkage, so an unresolved
 * ladder of many close fragments becomes one wide band, like a smear on a real gel).
 */
function mergeItems(items: readonly LaneItem[], resolution: number): GelBand[] {
  const order = items
    .map((item, index) => ({ item, index }))
    .sort((x, y) => x.item.position - y.item.position || y.item.size - x.item.size || x.index - y.index)
    .map((x) => x.item);
  const groups: LaneItem[][] = [];
  let previous = Number.NaN;
  for (const item of order) {
    const gap = item.position - previous;
    if (groups.length > 0 && (gap < resolution || gap === 0)) groups[groups.length - 1].push(item);
    else groups.push([item]);
    previous = item.position;
  }
  const bands: GelBand[] = [];
  let maxMass = 0;
  for (const g of groups) {
    let mass = 0;
    let position = 0;
    let size = 0;
    let count = 0;
    let massNg: number | undefined;
    let emphasized: boolean | undefined;
    const labels: string[] = [];
    const sizes: number[] = [];
    for (const it of g) {
      mass += it.mass;
      position += it.mass * it.position;
      size += it.mass * it.size;
      count += it.count;
      labels.push(...it.labels);
      sizes.push(...it.sizes);
      if (it.massNg !== undefined) massNg = (massNg ?? 0) + it.massNg;
      if (it.emphasized !== undefined) emphasized = (emphasized ?? false) || it.emphasized;
    }
    sizes.sort((a, b) => b - a);
    maxMass = Math.max(maxMass, mass);
    // a lone fragment keeps its exact size and position (no rounding from the weighted mean)
    const single = g.length === 1;
    bands.push({
      size: single ? g[0].size : size / mass,
      position: single ? g[0].position : position / mass,
      intensity: mass,
      count,
      labels,
      sizes,
      ...(massNg !== undefined ? { massNg } : {}),
      ...(emphasized !== undefined ? { emphasized } : {}),
    });
  }
  for (const b of bands) b.intensity /= maxMass;
  return bands;
}

/**
 * Simulate one lane: each fragment's position from {@link migrate}'s model, co-migrating fragments
 * merged (see {@link LaneOptions.resolution}), intensity proportional to size x molarAmount and
 * normalised to the brightest band. Bands are returned top to bottom. Fragments with a molar amount
 * of 0 are omitted; an empty input gives an empty lane. The input is not modified.
 *
 * @throws RangeError for a non-positive or non-finite size, a negative or non-finite molar amount,
 *   an unknown form, invalid gel conditions or a negative resolution
 */
export function simulateLane(fragments: readonly GelFragment[], options: LaneOptions = {}): GelBand[] {
  const g = gelParameters(options.agarosePercent ?? DEFAULT_AGAROSE_PERCENT, options.buffer ?? 'TAE');
  const resolution = options.resolution ?? DEFAULT_RESOLUTION;
  checkResolution(resolution);
  const items: LaneItem[] = [];
  for (const f of fragments) {
    if (!Number.isFinite(f.size) || f.size <= 0) throw new RangeError(`fragment size must be a finite number > 0 bp, got ${f.size}`);
    const amount = f.molarAmount ?? 1;
    if (!Number.isFinite(amount) || amount < 0) throw new RangeError(`molar amount must be a finite number >= 0, got ${amount}`);
    const factor = formSizeFactor(f.form ?? 'linear');
    if (amount === 0) continue;
    items.push({
      position: positionOnGel(g, f.size * factor),
      mass: f.size * amount,
      size: f.size,
      sizes: [f.size],
      labels: f.label !== undefined ? [f.label] : [],
      count: 1,
    });
  }
  return mergeItems(items, resolution);
}

/**
 * Simulate a lane of a DNA ladder. Band intensities come from the vendor's masses (`massNg`); when
 * the ladder lacks a mass for any band, every band is drawn with equal mass (the vendors that publish
 * no masses describe their bands as equally intense, apart from the reference bands, which are
 * flagged with `emphasized` instead of being given an invented mass). Each band is labelled with
 * its vendor label or its size in bp; a multi-fragment row (`components`) counts as that many
 * fragments. Bands are returned top to bottom.
 *
 * @throws RangeError for invalid gel conditions or ladder bands with a non-positive size or a
 *   negative mass
 */
export function ladderLane(ladder: Ladder, options: LaneOptions = {}): GelBand[] {
  const g = gelParameters(options.agarosePercent ?? DEFAULT_AGAROSE_PERCENT, options.buffer ?? 'TAE');
  const resolution = options.resolution ?? DEFAULT_RESOLUTION;
  checkResolution(resolution);
  const withMass = ladder.bands.length > 0 && ladder.bands.every((b) => b.massNg !== undefined);
  const items: LaneItem[] = ladder.bands.map((b) => {
    if (!Number.isFinite(b.size) || b.size <= 0) throw new RangeError(`ladder band size must be > 0 bp, got ${b.size}`);
    const massNg = b.massNg;
    if (massNg !== undefined && (!Number.isFinite(massNg) || massNg < 0)) {
      throw new RangeError(`ladder band mass must be a finite number >= 0 ng, got ${massNg}`);
    }
    const sizes = b.components !== undefined && b.components.length > 0 ? [...b.components] : [b.size];
    return {
      position: positionOnGel(g, b.size),
      mass: withMass && massNg !== undefined ? massNg : 1,
      size: b.size,
      sizes,
      labels: [b.label ?? String(b.size)],
      count: sizes.length,
      ...(withMass && massNg !== undefined ? { massNg } : {}),
      emphasized: b.emphasized === true,
    };
  });
  // a band with zero mass is invisible
  return mergeItems(
    items.filter((it) => it.mass > 0),
    resolution,
  );
}
