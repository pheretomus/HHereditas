/**
 * Text measurement for label layout. The layout functions are pure and take a measurer;
 * the component supplies a canvas-backed one (exact, cached) and tests use the estimator.
 */

/** Width in px of `text` set in the UI font at `fontSize` px and `fontWeight`. */
export type TextMeasurer = (text: string, fontSize: number, fontWeight: number) => number;

/** Approximate advance widths (em) of the UI font (Inter / SF Pro metrics). */
function charEm(ch: string): number {
  if (ch === ' ') return 0.27;
  if ('il.,:;|!\'`'.includes(ch)) return 0.26;
  if ('fjrtI()[]{}/\\-'.includes(ch)) return 0.36;
  if ('mwMW'.includes(ch)) return 0.86;
  if (ch >= '0' && ch <= '9') return 0.58;
  if (ch >= 'A' && ch <= 'Z') return 0.66;
  return 0.54;
}

/** Deterministic width estimate (no DOM): used in tests and as a fallback. */
export const estimateTextWidth: TextMeasurer = (text, fontSize, fontWeight) => {
  let em = 0;
  for (const ch of text) em += charEm(ch);
  return em * fontSize * (fontWeight >= 600 ? 1.04 : fontWeight >= 500 ? 1.02 : 1);
};

/**
 * Canvas-based measurer for the given CSS font-family list (cached per text/size/weight).
 * Falls back to the estimator where canvas 2D is unavailable (jsdom, workers).
 */
export function createCanvasMeasurer(fontFamily: string): TextMeasurer {
  const isJsdom = typeof navigator !== 'undefined' && /jsdom/i.test(navigator.userAgent);
  if (typeof document === 'undefined' || isJsdom) return estimateTextWidth;
  let ctx: CanvasRenderingContext2D | null = null;
  try {
    ctx = document.createElement('canvas').getContext('2d');
  } catch {
    ctx = null;
  }
  if (!ctx) return estimateTextWidth;
  const context = ctx;
  const cache = new Map<string, number>();
  let currentFont = '';
  return (text, fontSize, fontWeight) => {
    const key = `${fontWeight}|${fontSize}|${text}`;
    let w = cache.get(key);
    if (w === undefined) {
      const font = `${fontWeight} ${fontSize}px ${fontFamily}`;
      if (font !== currentFont) {
        context.font = font;
        currentFont = font;
      }
      w = context.measureText(text).width;
      cache.set(key, w);
    }
    return w;
  };
}

/** Longest prefix of `text` (plus an ellipsis) that fits `maxWidth`; '' if nothing fits. */
export function truncateToWidth(
  text: string,
  maxWidth: number,
  fontSize: number,
  fontWeight: number,
  measure: TextMeasurer,
): string {
  if (measure(text, fontSize, fontWeight) <= maxWidth) return text;
  let lo = 0;
  let hi = text.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (measure(`${text.slice(0, mid).trimEnd()}…`, fontSize, fontWeight) <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return lo > 0 ? `${text.slice(0, lo).trimEnd()}…` : '';
}
