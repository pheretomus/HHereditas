/**
 * Fitting lane names into the header. Names are shortened at word boundaries (never inside a number
 * or a word), and a leading part that other lanes share is elided first, so that the part telling
 * lanes apart stays visible: "…clone 12 · EcoRI…" rather than "pUC19-mCherry clone 1…".
 */
import type { GelTextMeasurer, GelTextRole } from './measure';

const ELLIPSIS = '…';
/** A word without letters or digits only separates others ("·", "+", "–", "/"). */
const SEPARATOR = /^[^\p{L}\p{N}]+$/u;
/** Punctuation that may not end a shortened name before its ellipsis. */
const TRAILING_PUNCTUATION = /[\s,;:·•+\-–—/|&(]+$/u;

function words(text: string): string[] {
  return text.split(/\s+/).filter((w) => w.length > 0);
}

/**
 * For each label, the number of leading words it shares with at least one other label, leaving it
 * at least one word of its own (0 when it shares nothing).
 */
export function sharedLabelPrefixes(texts: readonly string[]): number[] {
  const tokens = texts.map(words);
  return tokens.map((t, i) => {
    let best = 0;
    tokens.forEach((u, j) => {
      if (j === i) return;
      let k = 0;
      while (k < t.length && k < u.length && t[k] === u[k]) k++;
      best = Math.max(best, k);
    });
    return Math.max(0, Math.min(best, t.length - 1));
  });
}

export interface FittedGelLabel {
  text: string;
  truncated: boolean;
}

/**
 * `text` shortened to at most `maxWidth` px. Long names keep whole leading words followed by "…".
 * When the name starts with `sharedPrefix` words that other lanes share (and they hold at least two
 * real words), those are elided first, keeping the last of them for context:
 * "pUC19-mCherry clone 12 · EcoRI + HindIII" → "…clone 12 · EcoRI…". Only a first word that is
 * too long on its own is cut inside, and never inside a run of digits.
 */
export function fitGelLabel(
  text: string,
  maxWidth: number,
  measure: GelTextMeasurer,
  role: GelTextRole,
  sharedPrefix = 0,
): FittedGelLabel {
  if (measure(text, role) <= maxWidth) return { text, truncated: false };
  const w = words(text);
  const prefix = w.slice(0, sharedPrefix);
  if (prefix.filter((t) => !SEPARATOR.test(t)).length >= 2) {
    let keep = sharedPrefix - 1;
    while (keep > 0 && SEPARATOR.test(w[keep])) keep--;
    const elided = fitWords(w.slice(keep), maxWidth, measure, role, true);
    if (elided) return { text: elided, truncated: true };
  }
  const plain = fitWords(w, maxWidth, measure, role, false);
  if (plain) return { text: plain, truncated: true };
  return { text: fitChars(w[0] ?? text, maxWidth, measure, role), truncated: true };
}

/** "…"? + the most whole leading words of `w` that fit with a trailing "…" (null if none fits). */
function fitWords(
  w: readonly string[],
  maxWidth: number,
  measure: GelTextMeasurer,
  role: GelTextRole,
  elided: boolean,
): string | null {
  const head = elided ? ELLIPSIS : '';
  if (elided) {
    const all = head + w.join(' ');
    if (measure(all, role) <= maxWidth) return all;
  }
  for (let n = w.length - 1; n >= 1; n--) {
    const kept = w.slice(0, n).join(' ').replace(TRAILING_PUNCTUATION, '');
    if (kept.length === 0 || SEPARATOR.test(kept)) continue;
    const candidate = head + kept + ELLIPSIS;
    if (measure(candidate, role) <= maxWidth) return candidate;
  }
  return null;
}

/** A single word cut to fit, never between two digits. */
function fitChars(word: string, maxWidth: number, measure: GelTextMeasurer, role: GelTextRole): string {
  const chars = [...word];
  const digit = (c: string | undefined) => c !== undefined && c >= '0' && c <= '9';
  for (let k = chars.length - 1; k >= 1; k--) {
    if (digit(chars[k - 1]) && digit(chars[k])) continue;
    const candidate = chars.slice(0, k).join('').replace(TRAILING_PUNCTUATION, '') + ELLIPSIS;
    if (candidate.length > 1 && measure(candidate, role) <= maxWidth) return candidate;
  }
  return ELLIPSIS;
}
