/**
 * Text measurement for the gel layout (label gutters, header rotation, label truncation).
 * Uses a canvas with the design-system fonts; falls back to an estimate where no canvas exists
 * (tests, server rendering).
 */
import { useEffect, useState } from 'react';

/** Kinds of text the gel writes (each maps to a token font size and weight). */
export type GelTextRole = 'ladder' | 'ladderStrong' | 'lane' | 'size' | 'sizeStrong';

/** Returns the rendered width (px) of `text` in the font of `role`. */
export type GelTextMeasurer = (text: string, role: GelTextRole) => number;

/** Font size (px) and weight of each role; must match GelView.module.css. */
const ROLE_FONT: Readonly<Record<GelTextRole, { sizeVar: string; size: number; weightVar: string; weight: number }>> = {
  ladder: { sizeVar: '--hh-text-sm', size: 11, weightVar: '--hh-weight-regular', weight: 400 },
  ladderStrong: { sizeVar: '--hh-text-sm', size: 11, weightVar: '--hh-weight-semibold', weight: 600 },
  // Lane labels keep their weight when selected (selection is shown by colour only).
  lane: { sizeVar: '--hh-text-sm', size: 11, weightVar: '--hh-weight-medium', weight: 500 },
  size: { sizeVar: '--hh-text-xs', size: 10, weightVar: '--hh-weight-regular', weight: 400 },
  sizeStrong: { sizeVar: '--hh-text-xs', size: 10, weightVar: '--hh-weight-semibold', weight: 600 },
};

/** Width estimate without a canvas: average glyph widths of a UI sans-serif font. */
export function approximateGelTextWidth(text: string, role: GelTextRole): number {
  const f = ROLE_FONT[role];
  let em = 0;
  for (const ch of text) {
    if (ch === ' ') em += 0.28;
    else if ('il.,:;|!\'1'.includes(ch)) em += 0.3;
    else if ('mwMW'.includes(ch)) em += 0.85;
    else if (ch >= 'A' && ch <= 'Z') em += 0.66;
    else em += 0.56;
  }
  return em * f.size * (f.weight >= 600 ? 1.05 : 1);
}

function isJsdom(): boolean {
  return typeof navigator !== 'undefined' && /jsdom/i.test(navigator.userAgent);
}

/**
 * A measurer that uses the fonts of the design tokens (--hh-font-ui, --hh-text-*). Results are
 * cached; create a new one when web fonts finish loading (see {@link useGelFontsVersion}).
 */
export function createGelTextMeasurer(): GelTextMeasurer {
  if (typeof document === 'undefined' || isJsdom()) return approximateGelTextWidth;
  let ctx: CanvasRenderingContext2D | null = null;
  try {
    ctx = document.createElement('canvas').getContext('2d');
  } catch {
    ctx = null;
  }
  if (!ctx) return approximateGelTextWidth;
  const root = getComputedStyle(document.documentElement);
  const family = root.getPropertyValue('--hh-font-ui').trim() || 'system-ui, sans-serif';
  const num = (name: string, fallback: number) => {
    const v = parseFloat(root.getPropertyValue(name));
    return Number.isFinite(v) && v > 0 ? v : fallback;
  };
  const fonts = {} as Record<GelTextRole, string>;
  for (const role of Object.keys(ROLE_FONT) as GelTextRole[]) {
    const f = ROLE_FONT[role];
    fonts[role] = `${num(f.weightVar, f.weight)} ${num(f.sizeVar, f.size)}px ${family}`;
  }
  const cache = new Map<string, number>();
  const context = ctx;
  return (text, role) => {
    const key = `${role}\u0000${text}`;
    let width = cache.get(key);
    if (width === undefined) {
      context.font = fonts[role];
      // +4 %: SVG labels use tabular figures, which canvas does not apply.
      width = context.measureText(text).width * 1.04;
      cache.set(key, width);
    }
    return width;
  };
}

/** Increments when web fonts finish loading, so text measurements can be redone. */
export function useGelFontsVersion(): number {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const fonts = typeof document !== 'undefined' ? document.fonts : undefined;
    if (!fonts) return;
    let alive = true;
    const bump = () => {
      if (alive) setVersion((v) => v + 1);
    };
    if (fonts.status !== 'loaded') fonts.ready.then(bump, () => undefined);
    fonts.addEventListener?.('loadingdone', bump);
    return () => {
      alive = false;
      fonts.removeEventListener?.('loadingdone', bump);
    };
  }, []);
  return version;
}
