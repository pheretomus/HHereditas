/**
 * Text shown by the gel: size labels, tooltips and accessible descriptions.
 */
import { formatBp, formatInt } from '../common/format';
import type { GelDnaForm, GelLane, GelLaneBand } from './types';

/**
 * Size of a band as text.
 *  - 'ladder':  marker legend; rounded only when nothing is lost: 500 → "500 bp", 1500 → "1.5 kb",
 *               48500 → "48.5 kb", but 1517 → "1,517 bp" and 23130 → "23,130 bp" (the vendor values).
 *  - 'band':    3 significant digits: 856 → "856 bp", 4361 → "4.36 kb", 12345 → "12.3 kb".
 *  - 'compact': 'band' without units (narrow lanes): 856 → "856", 4361 → "4.36k", 4641652 → "4.64M".
 *  - 'exact':   every base pair: 4361 → "4,361 bp".
 */
export function formatGelSize(size: number, style: 'ladder' | 'band' | 'compact' | 'exact' = 'band'): string {
  if (!Number.isFinite(size)) return '–';
  const bp = Math.round(Math.abs(size));
  if (style === 'exact') return formatBp(bp);
  if (style === 'ladder') {
    if (bp < 1000) return `${bp} bp`;
    // one decimal in Mb or kb when that is exact, otherwise every base pair
    if ((bp * 10) % 1_000_000 === 0) return `${formatDecimal(bp / 1_000_000)} Mb`;
    if ((bp * 10) % 1000 === 0) return `${formatDecimal(bp / 1000)} kb`;
    return formatBp(bp);
  }
  const unit = style === 'compact' ? ['', 'k', 'M'] : [' bp', ' kb', ' Mb'];
  if (bp < 1000) return `${bp}${unit[0]}`;
  if (bp >= 1_000_000) return `${trimZeros((bp / 1_000_000).toFixed(bp >= 10_000_000 ? 1 : 2))}${unit[2]}`;
  const kb = bp / 1000;
  return `${trimZeros(kb.toFixed(kb >= 100 ? 0 : kb >= 10 ? 1 : 2))}${unit[1]}`;
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

/** Text styles of size labels drawn on the gel (see {@link formatGelBandLabel}). */
export type GelLabelStyle = 'ladder' | 'band' | 'compact';

const FORM_MARK: Readonly<Record<GelDnaForm, string>> = { linear: '', supercoiled: 'SC', nicked: 'OC' };

/** "4.36 kb" → ["4.36", " kb"], "4.36k" → ["4.36", "k"], "512" → ["512", ""]. */
function splitUnit(text: string): [string, string] {
  const m = /^(.*?)( ?(?:bp|kb|Mb|k|M))?$/.exec(text);
  return m ? [m[1], m[2] ?? ''] : [text, ''];
}

/**
 * Text of a band's size label on the gel, consistent with its tooltip:
 *  - one fragment: its size ("4.36 kb");
 *  - two co-migrating fragments: both sizes ("517/506 bp"); the same size twice: "160 bp ×2";
 *    more: their mean and count ("≈165 bp ×6");
 *  - uncut plasmid forms are marked: "2.69 kb SC" (supercoiled), "2.69 kb OC" (open circular).
 */
export function formatGelBandLabel(band: GelLaneBand, style: GelLabelStyle = 'band'): string {
  const sizes = (band.sizes ?? []).filter((s) => Number.isFinite(s) && s > 0);
  const count = Math.max(Math.round(Number.isFinite(band.count) ? band.count! : 1), sizes.length, 1);
  const times = style === 'compact' ? '×' : ' ×';
  let text: string;
  if (count <= 1) {
    text = formatGelSize(band.size, style);
  } else {
    const parts = sizes.length === count ? sizes.map((s) => formatGelSize(s, style)) : [];
    const distinct = [...new Set(parts)];
    if (distinct.length === 1) {
      text = `${distinct[0]}${times}${count}`;
    } else if (count === 2 && distinct.length === 2) {
      const [a, aUnit] = splitUnit(distinct[0]);
      const [b, bUnit] = splitUnit(distinct[1]);
      text = aUnit === bUnit ? `${a}/${b}${bUnit}` : `${distinct[0]}/${distinct[1]}`;
    } else {
      text = `≈${formatGelSize(band.size, style === 'ladder' ? 'band' : style)}${times}${count}`;
    }
  }
  const mark = band.form ? FORM_MARK[band.form] : '';
  return mark ? `${text} ${mark}` : text;
}

/** Agarose caption: 1 → "1% agarose", 0.8 → "0.8% agarose". Undefined for missing/invalid values. */
export function formatAgarose(percent: number | undefined): string | undefined {
  if (percent === undefined || !Number.isFinite(percent) || percent <= 0) return undefined;
  return `${trimZeros(percent.toFixed(2))}% agarose`;
}

function trimZeros(s: string): string {
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
}

/** 1.5 → "1.5", 1125 → "1,125" (at most one decimal). */
function formatDecimal(v: number): string {
  const int = Math.trunc(v);
  const tenth = Math.round((v - int) * 10);
  return tenth === 0 ? formatInt(int) : `${formatInt(int)}.${tenth}`;
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

const FORM_NAME: Readonly<Record<GelDnaForm, string>> = {
  linear: 'Linear',
  supercoiled: 'Supercoiled (SC)',
  nicked: 'Open circular (OC)',
};

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
  if (band.form && band.form !== 'linear') details.push(FORM_NAME[band.form]);
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

/**
 * Description of several fragments under the pointer that the gel does not resolve: a slice of a
 * smear ('smear'), or bands drawn so close together that they overlap ('overlap').
 */
export function describeGelSmear(count: number, minSize: number, maxSize: number, kind: 'smear' | 'overlap' = 'smear'): GelBandDescription {
  return {
    title: `${formatInt(count)} fragments`,
    details: [formatGelSizeRange(minSize, maxSize), kind === 'smear' ? 'Unresolved smear' : 'Overlapping bands'],
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
 * Accessible name of a lane: "HinfI: 8 bands: 1.63 kb, 517/506 bp, …" / "1 kb ladder, ladder: …" /
 * "Uncut: no bands" / "Sau3AI: 18,059 fragments, 49 bp–2.64 kb, unresolved smear". `bands` are the
 * visible bands, top to bottom; `smear` describes a lane drawn as a smear.
 */
export function gelLaneAriaLabel(lane: GelLane, index: number, bands: readonly GelLaneBand[] = lane.bands, smear = false): string {
  const name = gelLaneName(lane, index) + (lane.kind === 'ladder' ? ', ladder' : '');
  if (bands.length === 0) return `${name}: no bands`;
  if (smear) {
    let count = 0;
    let min = Infinity;
    let max = 0;
    for (const b of bands) {
      count += Math.max(1, b.count ?? 1);
      min = Math.min(min, b.size);
      max = Math.max(max, b.size);
    }
    return `${name}: ${formatInt(count)} fragments, ${formatGelSizeRange(min, max)}, unresolved smear`;
  }
  const listed = bands.slice(0, MAX_ARIA_SIZES).map((b) => formatGelBandLabel(b, 'band'));
  const more = bands.length - listed.length;
  return `${name}: ${formatInt(bands.length)} band${bands.length === 1 ? '' : 's'}: ${listed.join(', ')}${more > 0 ? `, and ${formatInt(more)} more` : ''}`;
}
