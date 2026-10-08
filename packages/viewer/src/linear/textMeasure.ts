/**
 * Text measurement for label fitting. In the browser it measures with a canvas using the real
 * UI font, so "does this label fit inside the bar" matches what SVG then draws. Elsewhere
 * (tests, before fonts load) it falls back to a deterministic estimate.
 */

/** Width in px of `text` at `fontSize` px and CSS font weight `weight`. */
export type TextMeasurer = (text: string, fontSize: number, weight?: number) => number;

/** Average glyph advance of the UI font (Inter / SF Pro) in em, a little generous on purpose. */
const EM_REGULAR = 0.56;
const EM_BOLD = 0.6;

/** Deterministic estimate used in tests and as a fallback. */
export const estimateTextWidth: TextMeasurer = (text, fontSize, weight = 400) =>
  text.length * fontSize * (weight >= 600 ? EM_BOLD : EM_REGULAR);

/**
 * Canvas-based measurer for a CSS font-family list (e.g. the computed font-family of the map).
 * Returns null when no 2D canvas is available (jsdom, very old WebViews).
 */
export function createCanvasMeasurer(fontFamily: string): TextMeasurer | null {
  if (typeof document === 'undefined') return null;
  if (typeof navigator !== 'undefined' && /jsdom/i.test(navigator.userAgent)) return null;
  let ctx: CanvasRenderingContext2D | null = null;
  try {
    ctx = document.createElement('canvas').getContext('2d');
  } catch {
    ctx = null;
  }
  if (!ctx) return null;
  const context = ctx;
  const cache = new Map<string, number>();
  let currentFont = '';
  return (text, fontSize, weight = 400) => {
    const key = `${weight}|${fontSize}|${text}`;
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    const font = `${weight} ${fontSize}px ${fontFamily}`;
    if (font !== currentFont) {
      context.font = font;
      currentFont = font;
    }
    const w = context.measureText(text).width;
    if (cache.size > 20_000) cache.clear();
    cache.set(key, w);
    return w;
  };
}

/**
 * Longest prefix of `text` that fits in `maxWidth` px once an ellipsis is appended, or null if
 * not even one character fits. Returns `text` unchanged when it fits as is.
 */
export function truncateToWidth(text: string, maxWidth: number, width: (s: string) => number): string | null {
  if (width(text) <= maxWidth) return text;
  let lo = 0;
  let hi = text.length - 1;
  // largest n with width(text.slice(0, n) + '…') <= maxWidth
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (width(`${text.slice(0, mid).trimEnd()}…`) <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  if (lo < 1) return null;
  return `${text.slice(0, lo).trimEnd()}…`;
}
