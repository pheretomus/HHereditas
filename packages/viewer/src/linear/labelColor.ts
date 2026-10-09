/**
 * Text colour for a label drawn on a feature fill. Type colours (--hh-feature-* tokens) are
 * mid-tone in both themes and take the shared near-black FEATURE_LABEL_ON_FILL. Custom colours
 * come from files (Feature.color is '#rrggbb') and can be dark (navy, maroon...): those get
 * light text when it contrasts better (WCAG contrast ratio).
 */
import { FEATURE_LABEL_ON_FILL } from '../common/colors';

/** Light text on dark fills (white in both themes). */
export const LABEL_ON_DARK_FILL = 'var(--hh-accent-contrast)';

/** Relative luminance (WCAG 2) of a '#rgb' / '#rrggbb' colour, or null for anything else. */
export function hexLuminance(color: string): number | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (!m) return null;
  const hex = m[1].length === 3 ? [...m[1]].map((c) => c + c).join('') : m[1];
  const channel = (i: number) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
}

/** Fill for label text drawn on top of a feature filled with `fill`. */
export function labelColorOnFill(fill: string): string {
  const lum = hexLuminance(fill);
  if (lum === null) return FEATURE_LABEL_ON_FILL;
  // contrast with black text: (L + 0.05) / 0.05; with white text: 1.05 / (L + 0.05)
  return (lum + 0.05) / 0.05 >= 1.05 / (lum + 0.05) ? FEATURE_LABEL_ON_FILL : LABEL_ON_DARK_FILL;
}
