/**
 * Label widths for lane packing, measured with a canvas in the real fonts (cached). Falls back
 * to an estimate where no canvas exists (jsdom tests, SSR). Sizes and weights must match the
 * label classes in SequenceView.module.css.
 */
import type { LabelStyle } from './layout';
import { approximateMeasure } from './layout';

export type MeasureStyle = LabelStyle | 'number';

const FONTS: Readonly<Record<MeasureStyle, { size: number; weight: number }>> = {
  feature: { size: 11, weight: 600 },
  enzyme: { size: 11, weight: 400 },
  enzymeUnique: { size: 11, weight: 700 },
  primer: { size: 11, weight: 600 },
  number: { size: 11, weight: 400 },
};

const FALLBACK_FAMILY = "-apple-system, BlinkMacSystemFont, 'Inter Variable', 'Inter', system-ui, sans-serif";
const MAX_CACHE = 50_000;

let context: CanvasRenderingContext2D | null | undefined;
let family: string | null = null;
const cache = new Map<string, number>();

function canvasContext(): CanvasRenderingContext2D | null {
  if (context !== undefined) return context;
  context = null;
  if (typeof document === 'undefined') return context;
  if (typeof navigator !== 'undefined' && /jsdom/i.test(navigator.userAgent)) return context;
  try {
    context = document.createElement('canvas').getContext('2d');
  } catch {
    context = null;
  }
  return context;
}

function uiFamily(): string {
  if (family !== null) return family;
  let value = '';
  try {
    value = getComputedStyle(document.documentElement).getPropertyValue('--hh-font-ui').trim();
  } catch {
    value = '';
  }
  family = value || FALLBACK_FAMILY;
  return family;
}

/** Width (px) of `text` drawn in a label style of the sequence view. */
export function measureLabel(text: string, style: MeasureStyle): number {
  const key = `${style}\u0000${text}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const ctx = canvasContext();
  let width: number;
  if (ctx) {
    const f = FONTS[style];
    ctx.font = `${f.weight} ${f.size}px ${uiFamily()}`;
    width = ctx.measureText(text).width;
  } else {
    width = style === 'number' ? text.length * 6.4 : approximateMeasure(text, style);
  }
  if (cache.size >= MAX_CACHE) cache.clear();
  cache.set(key, width);
  return width;
}

/** Forget cached widths (call when web fonts finish loading or the theme fonts change). */
export function resetLabelMeasurements(): void {
  cache.clear();
  family = null;
}
