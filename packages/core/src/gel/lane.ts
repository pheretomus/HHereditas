/**
 * Simulated gel lanes: where each fragment runs (see `migration.ts`), which fragments co-migrate
 * into one visible band, and how bright the bands are relative to each other.
 *
 * Positions use the convention of `migration.ts`: 0 = well, 1 = bottom of the gel after a standard
 * run. Intensities are relative: ethidium-type stains fluoresce in proportion to the number of base
 * pairs, so a band's brightness is taken proportional to its DNA mass (size x molar amount, or the
 * vendor's ng for ladders), normalised so that the brightest band of the lane is 1. Differences in
 * dye binding between conformations (supercoiled DNA binds less ethidium) are not modelled.
 *
 * BANDS are narrower than the resolution (see {@link LaneOptions.resolution}): co-migrating fragments
 * are merged closest pair first, and a band only ever holds fragments that run closer to each other
 * than the resolution. A dense series of fragments (a genomic digest) therefore becomes a run of
 * adjacent bands, i.e. a smear, never one band reported at the mean position of fragments that are
 * far apart.
 */
import type { Ladder, LadderBand } from './ladders';
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
  /** Text describing the fragment (e.g. 'PvuII-PvuII'); reported in {@link GelBand.fragments} and {@link GelBand.labels}. */
  label?: string;
}

/** Options of {@link simulateLane} and {@link ladderLane}. */
export interface LaneOptions extends GelConditions {
  /**
   * Band width as a fraction of the gel length (>= 0): fragments that run closer together than this
   * co-migrate into one band. Bands are formed like co-migrating DNA merges on a gel, closest first:
   * starting from the fragments (those at exactly the same position always share a band), the two
   * neighbouring bands whose union is narrowest are merged, as long as that union spans less than
   * `resolution` (complete linkage). So no band spans `resolution` or more, and no two neighbouring
   * bands could be merged without doing so; inside a dense run of fragments neighbouring bands may
   * lie closer than `resolution` (they then read as a smear). 0 merges only fragments at exactly the
   * same position. Default {@link DEFAULT_RESOLUTION}.
   */
  resolution?: number;
}

/**
 * Default band resolution: 0.01 of the gel length, about 0.8 mm on a standard 8 cm mini gel, i.e.
 * roughly one band width. Example: at 1 % TAE this merges NEB's 500/517 bp doublet (0.005 apart)
 * but separates 400 from 500 bp.
 */
export const DEFAULT_RESOLUTION = 0.01;

/** One fragment of a {@link GelBand}. */
export interface GelBandFragment {
  /**
   * Where the fragment comes from: its index in the `fragments` argument of {@link simulateLane}, or
   * the index of its row in `ladder.bands` for {@link ladderLane} (the fragments of a multi-fragment
   * row, e.g. NEB's 500/517 bp doublet, share the row's index).
   */
  index: number;
  /** Length (bp). */
  size: number;
  /** Conformation (ladder fragments are linear). */
  form: DnaForm;
  /** Where this fragment alone runs (0 = well .. 1 = bottom of the gel). */
  position: number;
  /**
   * Its label: {@link GelFragment.label} (absent when the fragment has none); for ladder fragments the
   * row's vendor label (`LadderBand.label`) or, without one, the row's size in bp.
   */
  label?: string;
}

/** A visible band of a simulated lane. */
export interface GelBand {
  /**
   * Size (bp) of the band: mass-weighted mean of the sizes of its fragments (for a single fragment,
   * exactly its size). Ladder bands follow the same rule, e.g. NEB's co-migrating 517 + 500 bp pair
   * is a 508.5 bp band in both the 1 kb (N3232) and the 1 kb Plus (N3200) ladder.
   */
  size: number;
  /** Centre of the band (0 = well .. 1 = bottom): mass-weighted mean position of its fragments. */
  position: number;
  /**
   * Relative brightness, proportional to the band's DNA mass; the brightest band of the lane is 1.
   * Never NaN; 0 only for a band lighter than ~1e-308 of the brightest one (below double precision).
   */
  intensity: number;
  /** Number of fragments merged into this band (= `fragments.length`). */
  count: number;
  /**
   * Labels of the band's fragments that have one, in the order of {@link GelBand.fragments} (largest
   * first). Every ladder fragment is labelled, so in ladder lanes, and in sample lanes whose fragments
   * all have labels, `labels[i]` belongs to `sizes[i]`; otherwise pair them through `fragments`.
   */
  labels: string[];
  /** Sizes (bp) of the band's fragments, largest first (the order of {@link GelBand.fragments}). */
  sizes: number[];
  /** The band's fragments, largest first (ties: top-most first, then input order). */
  fragments: GelBandFragment[];
  /** Ladder lanes with vendor masses only: total DNA (ng) in the band when the ladder's `loadNg` is loaded. */
  massNg?: number;
  /** Ladder lanes only: true when the band contains a fragment of a vendor reference band. */
  emphasized?: boolean;
}

/** A fragment placed on the gel, with its (relative) mass. */
interface LaneItem extends GelBandFragment {
  /** Mass relative to the heaviest item of the lane (0..1, the heaviest is exactly 1). */
  mass: number;
  /** Ladder lanes: the vendor's ng for this fragment (its share of the row). */
  massNg?: number;
  /** Ladder lanes: whether the fragment belongs to a vendor reference band. */
  emphasized?: boolean;
}

/** Smallest positive normal double (2^-1022); products below it have lost precision. */
const MIN_NORMAL = 2 ** -1022;

function checkResolution(resolution: number): void {
  if (!Number.isFinite(resolution) || resolution < 0) {
    throw new RangeError(`resolution must be a finite number >= 0, got ${resolution}`);
  }
}

function fragmentError(index: number, fragment: GelFragment, problem: string): RangeError {
  const label = fragment.label !== undefined ? ` ('${fragment.label}')` : '';
  return new RangeError(`fragments[${index}]${label}: ${problem}`);
}

function ladderError(ladder: Ladder, where: string, problem: string): RangeError {
  return new RangeError(`ladder '${ladder.id}' ${where}: ${problem}`);
}

/**
 * Masses size x amount relative to the largest one (the largest is exactly 1). Computed directly
 * when the products are normal doubles (the usual case, exact to rounding); otherwise, i.e. when a
 * product overflows to Infinity or underflows, in log space (relative error ~1e-13), so that valid
 * input never yields NaN.
 */
function relativeMasses(sizes: readonly number[], amounts: readonly number[]): number[] {
  const raw = sizes.map((size, i) => size * amounts[i]);
  let max = 0;
  let allNormal = true;
  for (const m of raw) {
    if (m > max) max = m;
    if (!(m >= MIN_NORMAL)) allNormal = false;
  }
  if (allNormal && Number.isFinite(max)) return raw.map((m) => m / max);
  const logs = sizes.map((size, i) => Math.log(size) + Math.log(amounts[i]));
  let top = Number.NEGATIVE_INFINITY;
  for (const l of logs) if (l > top) top = l;
  return logs.map((l) => Math.exp(l - top));
}

/**
 * Weighted mean of `values`, clamped to their range (rounding can never move it outside). Falls back
 * to the plain mean when all weights are 0, and rescales values that would overflow the sum.
 */
function weightedMean(values: readonly number[], weights: readonly number[]): number {
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  let total = 0;
  for (let i = 0; i < values.length; i++) {
    lo = Math.min(lo, values[i]);
    hi = Math.max(hi, values[i]);
    total += weights[i];
  }
  const w = total > 0 ? weights : values.map(() => 1);
  const wTotal = total > 0 ? total : values.length;
  let sum = 0;
  for (let i = 0; i < values.length; i++) sum += w[i] * values[i];
  let mean = sum / wTotal;
  if (!Number.isFinite(mean)) {
    // values near the largest double: average values / hi instead
    sum = 0;
    for (let i = 0; i < values.length; i++) sum += w[i] * (values[i] / hi);
    mean = (sum / wTotal) * hi;
  }
  return Math.min(hi, Math.max(lo, mean));
}

/** Top to bottom; level fragments largest first, then in input order. */
function byPosition(x: LaneItem, y: LaneItem): number {
  return x.position - y.position || y.size - x.size || x.index - y.index;
}

/** Largest first; equal sizes top-most first, then in input order. */
function bySize(x: LaneItem, y: LaneItem): number {
  return y.size - x.size || x.position - y.position || x.index - y.index;
}

function toFragment(it: LaneItem): GelBandFragment {
  return {
    index: it.index,
    size: it.size,
    form: it.form,
    position: it.position,
    ...(it.label !== undefined ? { label: it.label } : {}),
  };
}

/** One band from co-migrating items (sorted top to bottom); `intensity` is still the raw mass. */
function toBand(group: readonly LaneItem[]): GelBand {
  const members = [...group].sort(bySize);
  let mass = 0;
  let massNg: number | undefined;
  let emphasized: boolean | undefined;
  for (const it of members) {
    mass += it.mass;
    if (it.massNg !== undefined) massNg = (massNg ?? 0) + it.massNg;
    if (it.emphasized !== undefined) emphasized = (emphasized ?? false) || it.emphasized;
  }
  const weights = members.map((it) => it.mass);
  // a lone fragment keeps its exact size and position (no rounding through the weighted mean)
  const single = members.length === 1;
  const labels: string[] = [];
  for (const it of members) if (it.label !== undefined) labels.push(it.label);
  return {
    size: single ? members[0].size : weightedMean(members.map((it) => it.size), weights),
    position: single ? members[0].position : weightedMean(members.map((it) => it.position), weights),
    intensity: mass,
    count: members.length,
    labels,
    sizes: members.map((it) => it.size),
    fragments: members.map(toFragment),
    ...(massNg !== undefined ? { massNg } : {}),
    ...(emphasized !== undefined ? { emphasized } : {}),
  };
}

/** A candidate merge of the neighbouring runs starting at `left` and `right` (indices into the sorted items). */
interface Merge {
  /** Width of the merged band: position of its bottom-most minus its top-most item. */
  width: number;
  left: number;
  right: number;
}

/** Narrowest first; equal widths: top-most first. */
function mergeBefore(x: Merge, y: Merge): boolean {
  return x.width < y.width || (x.width === y.width && x.left < y.left);
}

/** Minimal binary heap of candidate merges (no dependency on a priority-queue package). */
class MergeHeap {
  private readonly heap: Merge[] = [];
  get size(): number {
    return this.heap.length;
  }
  push(m: Merge): void {
    const h = this.heap;
    h.push(m);
    let i = h.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!mergeBefore(h[i], h[parent])) break;
      [h[i], h[parent]] = [h[parent], h[i]];
      i = parent;
    }
  }
  pop(): Merge {
    const h = this.heap;
    const top = h[0];
    const last = h.pop() as Merge;
    if (h.length > 0) {
      h[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < h.length && mergeBefore(h[l], h[m])) m = l;
        if (r < h.length && mergeBefore(h[r], h[m])) m = r;
        if (m === i) break;
        [h[i], h[m]] = [h[m], h[i]];
        i = m;
      }
    }
    return top;
  }
}

/**
 * Group co-migrating items into bands by complete linkage on a line: bands are runs of the items
 * sorted top to bottom; starting from runs of items at exactly the same position, the two
 * neighbouring runs whose union is narrowest are merged (ties: top-most first) while that union spans
 * less than `resolution`. Every band therefore spans less than `resolution` (or 0), and no two
 * neighbouring bands can be merged without reaching it. O(n log n). Intensities are normalised to
 * the brightest band.
 */
function groupBands(items: readonly LaneItem[], resolution: number): GelBand[] {
  const order = [...items].sort(byPosition);
  const n = order.length;
  // runs as a doubly linked list over their first item: end[i] = last item of the run starting at i
  const end: number[] = [];
  const next: number[] = new Array<number>(n).fill(-1);
  const prev: number[] = new Array<number>(n).fill(-1);
  const alive: boolean[] = new Array<boolean>(n).fill(false);
  let last = -1;
  for (let i = 0; i < n; i++) {
    if (last >= 0 && order[i].position === order[last].position) {
      end[last] = i;
      continue;
    }
    end[i] = i;
    alive[i] = true;
    prev[i] = last;
    if (last >= 0) next[last] = i;
    last = i;
  }
  const heap = new MergeHeap();
  const widthOf = (left: number, right: number): number => order[end[right]].position - order[left].position;
  const offer = (left: number): void => {
    const right = next[left];
    if (right >= 0) heap.push({ width: widthOf(left, right), left, right });
  };
  for (let i = 0; i < n; i++) if (alive[i]) offer(i);
  while (heap.size > 0) {
    const m = heap.pop();
    // stale: one of the two runs has been merged since this candidate was offered
    if (!alive[m.left] || !alive[m.right] || next[m.left] !== m.right || m.width !== widthOf(m.left, m.right)) continue;
    if (!(m.width < resolution)) break; // every remaining candidate is at least as wide
    end[m.left] = end[m.right];
    alive[m.right] = false;
    next[m.left] = next[m.right];
    if (next[m.right] >= 0) prev[next[m.right]] = m.left;
    if (prev[m.left] >= 0) offer(prev[m.left]);
    offer(m.left);
  }
  const groups: LaneItem[][] = [];
  for (let i = 0; i < n; i++) if (alive[i]) groups.push(order.slice(i, end[i] + 1));
  const bands = groups.map(toBand);
  // every item mass is <= 1 and the heaviest item has mass 1, so the maximum is >= 1 (no 0/0)
  let max = 0;
  for (const b of bands) if (b.intensity > max) max = b.intensity;
  for (const b of bands) b.intensity /= max;
  return bands;
}

/**
 * Simulate one lane: each fragment's position from {@link migrate}'s model, co-migrating fragments
 * merged into bands no wider than {@link LaneOptions.resolution}, intensity proportional to
 * size x molarAmount and normalised to the brightest band. Bands are returned top to bottom; each
 * lists its fragments with their input index ({@link GelBand.fragments}). Fragments with a molar
 * amount of 0 are omitted; an empty input gives an empty lane. The input is not modified.
 *
 * @throws RangeError for a non-positive or non-finite size, a negative or non-finite molar amount
 *   or an unknown form (the message names the fragment: `fragments[i] ('label'): ...`), for invalid
 *   gel conditions, or for a negative or non-finite resolution
 */
export function simulateLane(fragments: readonly GelFragment[], options: LaneOptions = {}): GelBand[] {
  const g = gelParameters(options.agarosePercent ?? DEFAULT_AGAROSE_PERCENT, options.buffer ?? 'TAE');
  const resolution = options.resolution ?? DEFAULT_RESOLUTION;
  checkResolution(resolution);
  const items: LaneItem[] = [];
  const amounts: number[] = [];
  fragments.forEach((f, index) => {
    if (!Number.isFinite(f.size) || f.size <= 0) {
      throw fragmentError(index, f, `size must be a finite number > 0 bp, got ${f.size}`);
    }
    const amount = f.molarAmount ?? 1;
    if (!Number.isFinite(amount) || amount < 0) {
      throw fragmentError(index, f, `molar amount must be a finite number >= 0, got ${amount}`);
    }
    const form = f.form ?? 'linear';
    let factor: number;
    try {
      factor = formSizeFactor(form);
    } catch (e) {
      throw fragmentError(index, f, (e as Error).message);
    }
    if (amount === 0) return;
    items.push({
      index,
      size: f.size,
      form,
      position: positionOnGel(g, f.size * factor),
      mass: 0,
      ...(f.label !== undefined ? { label: f.label } : {}),
    });
    amounts.push(amount);
  });
  const masses = relativeMasses(
    items.map((it) => it.size),
    amounts,
  );
  items.forEach((it, i) => {
    it.mass = masses[i];
  });
  return groupBands(items, resolution);
}

/** Validate one ladder row; returns the sizes of its fragments. */
function ladderRowSizes(ladder: Ladder, row: LadderBand, i: number): readonly number[] {
  const where = `bands[${i}]`;
  if (!Number.isFinite(row.size) || row.size <= 0) {
    throw ladderError(ladder, where, `size must be a finite number > 0 bp, got ${row.size}`);
  }
  if (row.massNg !== undefined && (!Number.isFinite(row.massNg) || row.massNg < 0)) {
    throw ladderError(ladder, where, `mass must be a finite number >= 0 ng, got ${row.massNg}`);
  }
  const components = row.components;
  if (components === undefined || components.length === 0) return [row.size];
  for (let j = 0; j < components.length; j++) {
    const c = components[j];
    if (!Number.isFinite(c) || c <= 0) {
      throw ladderError(ladder, `${where}.components[${j}]`, `size must be a finite number > 0 bp, got ${c}`);
    }
  }
  return components;
}

/**
 * Simulate a lane of a DNA ladder. Band intensities come from the vendor's masses (`massNg`); when
 * the ladder lacks a mass for any band, every row is drawn with equal mass (the vendors that publish
 * no masses describe their bands as equally intense, apart from the reference bands, which are
 * flagged with `emphasized` instead of being given an invented mass). A multi-fragment row
 * (`components`, e.g. NEB's 500/517 bp doublet) contributes one fragment per component, each at its
 * own position with an equal share of the row's mass, so it merges (or, at high resolution,
 * separates) exactly like the same fragments listed as separate rows. Every fragment is labelled with
 * its row's vendor label or size. Bands are returned top to bottom; rows with zero mass are invisible.
 *
 * @throws RangeError for invalid gel conditions or resolution, and for ladder rows with a
 *   non-positive or non-finite size or component size, or a negative or non-finite mass (the message
 *   names the ladder and the row: `ladder 'id' bands[i]: ...`)
 */
export function ladderLane(ladder: Ladder, options: LaneOptions = {}): GelBand[] {
  const g = gelParameters(options.agarosePercent ?? DEFAULT_AGAROSE_PERCENT, options.buffer ?? 'TAE');
  const resolution = options.resolution ?? DEFAULT_RESOLUTION;
  checkResolution(resolution);
  const rows = ladder.bands;
  const rowSizes = rows.map((row, i) => ladderRowSizes(ladder, row, i));
  const withMass = rows.length > 0 && rows.every((row) => row.massNg !== undefined);
  let total = 0;
  if (withMass) for (const row of rows) total += row.massNg as number;
  if (!Number.isFinite(total)) throw ladderError(ladder, 'bands', `total mass must be finite, got ${total} ng`);
  const items: LaneItem[] = [];
  let maxMass = 0;
  rows.forEach((row, index) => {
    const rowMass = withMass ? (row.massNg as number) : 1;
    // a band without DNA is invisible
    if (!(rowMass > 0)) return;
    const sizes = rowSizes[index];
    const share = rowMass / sizes.length;
    maxMass = Math.max(maxMass, share);
    const label = row.label ?? String(row.size);
    for (const size of sizes) {
      items.push({
        index,
        size,
        form: 'linear',
        position: positionOnGel(g, size),
        label,
        mass: share,
        ...(withMass ? { massNg: share } : {}),
        emphasized: row.emphasized === true,
      });
    }
  });
  for (const it of items) it.mass /= maxMass;
  return groupBands(items, resolution);
}
