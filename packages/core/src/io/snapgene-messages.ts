/**
 * Quoting file content in warning messages.
 *
 * Warnings quote values read from the file (names, ranges, attribute values, parser errors).
 * Those values are untrusted and can be arbitrarily long, so they are clipped: a damaged or
 * crafted file must not turn into megabytes of warning text for the UI to render.
 */

/** Default maximum number of UTF-16 code units of one quoted value. */
export const MAX_QUOTED_LENGTH = 80;

/** Maximum number of distinct characters listed by {@link listCharacters}. */
const MAX_LISTED_CHARACTERS = 10;

/**
 * `text` for quoting in a warning: unchanged if it has at most `max` UTF-16 code units, else its
 * first `max` code units (never splitting a surrogate pair) followed by "… (N characters)",
 * where N is the full length in code units.
 */
export function clip(text: string, max: number = MAX_QUOTED_LENGTH): string {
  if (text.length <= max) return text;
  const high = text.charCodeAt(max - 1);
  const cut = high >= 0xd800 && high <= 0xdbff ? max - 1 : max;
  return `${text.slice(0, cut)}… (${text.length} characters)`;
}

/**
 * Characters as a JSON-quoted, comma-separated list for a warning, e.g. `"-", "*", "x"`; only
 * the first ten are listed, followed by ", ..." when there are more.
 */
export function listCharacters(chars: Iterable<string>): string {
  const shown: string[] = [];
  let more = false;
  for (const c of chars) {
    if (shown.length === MAX_LISTED_CHARACTERS) {
      more = true;
      break;
    }
    shown.push(JSON.stringify(c));
  }
  return more ? `${shown.join(', ')}, ...` : shown.join(', ');
}
