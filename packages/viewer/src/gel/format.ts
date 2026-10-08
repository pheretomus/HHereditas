/**
 * Text shown by the gel: size labels, tooltips and accessible descriptions.
 */
import { formatBp, formatInt } from '../common/format';
import type { GelLane, GelLaneBand } from './types';

/**
 * Size label of a band.
 *  - 'ladder': marker style, 1 decimal: 500 → "500 bp", 1517 → "1.5 kb", 10002 → "10 kb", 23130 → "23.1 kb".
 *  - 'band':   3 significant digits: 856 → "856 bp", 4361 → "4.36 kb", 12345 → "12.3 kb".
 *  - 'exact':  every base pair: 4361 → "4,361 bp".
 */
export function formatGelSize(size: number, style: 'ladder' | 'band' | 'exact' = 'band'): string {
  if (!Number.isFinite(size)) return '–';
  const bp = Math.round(Math.abs(size));
  if (style === 'exact') return formatBp(bp);
  if (bp < 1000) return `${bp} bp`;
  if (bp >= 1_000_000) return `${trimZeros((bp / 1_000_000).toFixed(bp >= 10_000_000 ? 1 : 2))} Mb`;
  const kb = bp / 1000;
  if (style === 'ladder') return `${trimZeros(kb.toFixed(kb >= 100 ? 0 : 1))} kb`;
  return `${trimZeros(kb.toFixed(kb >= 100 ? 0 : kb >= 10 ? 1 : 2))} kb`;
}

/** Range of sizes, e.g. "2.05–2.4 kb" or "850 bp–1.2 kb". */
export function formatGelSizeRange(min: number, max: number): string {
  if (Math.round(min) === Math.round(max)) return formatGelSize(min, 'band');
  const lo = formatGelSize(min, 'band');
  const hi = formatGelSize(max, 'band');
  const loUnit = lo.slice(lo.lastIndexOf(' '));
  const hiUnit = hi.slice(hi.lastIndexOf(' '));
  return loUnit === hiUnit ? `${lo.slice(0, -loUnit.length)}–${hi}` : `${lo}–${hi}`;
}

/** Agarose caption: 1 → "1% agarose", 0.8 → "0.8% agarose". Undefined for missing/invalid values. */
export function formatAgarose(percent: number | undefined): string | undefined {
  if (percent === undefined || !Number.isFinite(percent) || percent <= 0) return undefined;
  return `${trimZeros(percent.toFixed(2))}% agarose`;
}

function trimZeros(s: string): string {
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
}

/** Name of a lane for people: its label, or "Lane 3" when it has none. */
export function gelLaneName(lane: GelLane, index: number): string {
  const label = lane.label.trim();
  return label.length > 0 ? label : `Lane ${index + 1}`;
}

/** What a tooltip (or a screen reader) says about a band, or about several bands under the pointer. */
export interface GelBandDescription {
  /** Main line, e.g. "1,523 bp" or "312 fragments". */
  title: string;
  /** Secondary facts, e.g. "2 co-migrating fragments", "Reference band", "36 ng". */
  details: string[];
  /** Fragment labels (at most {@link MAX_TOOLTIP_LABELS}). */
  labels: string[];
  /** Number of labels left out. */
  moreLabels: number;
}

const MAX_TOOLTIP_LABELS = 5;
const MAX_LISTED_SIZES = 4;

/** Description of one band. */
export function describeGelBand(band: GelLaneBand): GelBandDescription {
  const sizes = (band.sizes ?? []).filter((s) => Number.isFinite(s) && s > 0);
  const count = Math.max(band.count ?? 1, sizes.length, 1);
  const details: string[] = [];
  let title = formatGelSize(band.size, 'exact');
  if (count > 1) {
    title = `≈ ${title}`;
    if (sizes.length > 1 && sizes.length <= MAX_LISTED_SIZES) {
      details.push(`${count} co-migrating fragments: ${sizes.map((s) => formatInt(Math.round(s))).join(' + ')} bp`);
    } else if (sizes.length > 1) {
      details.push(`${count} co-migrating fragments, ${formatGelSizeRange(Math.min(...sizes), Math.max(...sizes))}`);
    } else {
      details.push(`${count} co-migrating fragments`);
    }
  }
  if (band.emphasized) details.push('Reference band');
  if (band.massNg !== undefined && Number.isFinite(band.massNg)) details.push(`${trimZeros(band.massNg.toFixed(1))} ng`);
  const allLabels = (band.labels ?? []).filter((l) => l.trim().length > 0);
  return {
    title,
    details,
    labels: allLabels.slice(0, MAX_TOOLTIP_LABELS),
    moreLabels: Math.max(0, allLabels.length - MAX_TOOLTIP_LABELS),
  };
}

/** Description of many unresolved fragments (a smear) under the pointer. */
export function describeGelSmear(count: number, minSize: number, maxSize: number): GelBandDescription {
  return {
    title: `${formatInt(count)} fragments`,
    details: [formatGelSizeRange(minSize, maxSize), 'Unresolved smear'],
    labels: [],
    moreLabels: 0,
  };
}

/** One-line text version of a description (screen-reader announcements). */
export function gelDescriptionText(d: GelBandDescription): string {
  const parts = [d.title, ...d.details];
  if (d.labels.length > 0) parts.push(d.labels.join(', ') + (d.moreLabels > 0 ? `, and ${d.moreLabels} more` : ''));
  return parts.join('. ');
}

const MAX_ARIA_SIZES = 12;

/**
 * Accessible name of a lane: "HinfI: 8 bands: 1.63 kb, 517 bp, …" / "1 kb ladder, ladder: …" /
 * "Uncut: no bands". `bands` are the visible bands, top to bottom.
 */
export function gelLaneAriaLabel(lane: GelLane, index: number, bands: readonly GelLaneBand[] = lane.bands): string {
  const name = gelLaneName(lane, index) + (lane.kind === 'ladder' ? ', ladder' : '');
  if (bands.length === 0) return `${name}: no bands`;
  const listed = bands.slice(0, MAX_ARIA_SIZES).map((b) => formatGelSize(b.size, 'band'));
  const more = bands.length - listed.length;
  return `${name}: ${bands.length} band${bands.length === 1 ? '' : 's'}: ${listed.join(', ')}${more > 0 ? `, and ${more} more` : ''}`;
}
