/**
 * Character handling shared by the primer tools.
 *
 * Oligos supplied by a user are validated BEFORE any case conversion, and only ASCII letters are
 * case-folded: `String.prototype.toUpperCase` maps a few non-ASCII letters to ASCII ones and can
 * change the length ('ß' → 'SS', 'ſ' → 'S', 'ﬅ'/'ﬆ' → 'ST'), which would silently turn malformed
 * input into extra bases and shift every reported position.
 *
 * Templates are read with U as T: RNA records keep U (`types.ts`, convention 6 converts U to T for
 * DNA records only), and a DNA primer anneals to an RNA template exactly as to its DNA form.
 * Positions in messages are UTF-16 indices into the string as given (0-based).
 */
import { IUPAC_DNA } from '../seq/alphabet';

/** CANONICAL[c]: char code of the upper-case IUPAC code for ASCII char code `c` (either case; U/u read as T), or 0. */
const CANONICAL: Uint8Array = (() => {
  const table = new Uint8Array(128);
  for (const code of Object.keys(IUPAC_DNA)) {
    table[code.charCodeAt(0)] = code.charCodeAt(0);
    table[code.toLowerCase().charCodeAt(0)] = code.charCodeAt(0);
  }
  table['U'.charCodeAt(0)] = 'T'.charCodeAt(0);
  table['u'.charCodeAt(0)] = 'T'.charCodeAt(0);
  return table;
})();

/** Already canonical: upper-case IUPAC DNA codes only. */
const UPPER_IUPAC = /^[ACGTRYSWKMBDHVN]*$/;
const ASCII_ONLY = /^[\x00-\x7f]*$/;

/** Offending characters listed in full in an error message; further ones are summarised. */
const LISTED_INVALID = 3;

/**
 * The character at UTF-16 index `index` of `text` for a message: `'c' (U+XXXX)`, or `U+XXXX` alone
 * for control characters. A surrogate pair is shown as the one character it encodes.
 */
export function describeCharacter(text: string, index: number): string {
  const cp = text.codePointAt(index) ?? 0;
  const hex = `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;
  const control = cp < 0x20 || (cp >= 0x7f && cp <= 0x9f);
  return control ? hex : `'${String.fromCodePoint(cp)}' (${hex})`;
}

function invalidCharactersMessage(seq: string, invalid: readonly number[], subject: string): string {
  if (invalid.length === 1) {
    return `${subject} has a non-IUPAC character at position ${invalid[0]}: ${describeCharacter(seq, invalid[0])}`;
  }
  const listed = invalid.slice(0, LISTED_INVALID).map((i) => `${i}: ${describeCharacter(seq, i)}`);
  const more = invalid.length > LISTED_INVALID ? `, and ${invalid.length - LISTED_INVALID} more` : '';
  return `${subject} has ${invalid.length} non-IUPAC characters, at positions ${listed.join(', ')}${more}`;
}

/**
 * Canonical form of an oligo supplied by a user: IUPAC nucleotide codes (ASCII, either case) with
 * U read as T, returned upper-case. The result has the same length as `seq`, so positions carry over.
 *
 * @param subject How the sequence is named in the error message, e.g. "Primer 'M13fwd'".
 * @throws RangeError when `seq` contains any other character; the message lists the first offending
 *   characters with their positions (UTF-16 indices into `seq`) and code points.
 */
export function canonicalOligo(seq: string, subject = 'Sequence'): string {
  if (UPPER_IUPAC.test(seq)) return seq;
  let out = '';
  const invalid: number[] = [];
  for (let i = 0; i < seq.length; i++) {
    const c = seq.charCodeAt(i);
    const k = c < 128 ? CANONICAL[c] : 0;
    if (k !== 0) {
      out += String.fromCharCode(k);
      continue;
    }
    invalid.push(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < seq.length) {
      const next = seq.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) i++; // one character (a surrogate pair), one entry
    }
  }
  if (invalid.length > 0) throw new RangeError(invalidCharactersMessage(seq, invalid, subject));
  return out;
}

/**
 * A template as read for matching: ASCII lower-case letters are upper-cased and U is read as T.
 * Every other character is kept as it is (it never matches a primer base), so the length and
 * therefore every coordinate are unchanged. Returns `template` itself when it is already
 * upper-case IUPAC DNA (the common case, checked in one scan).
 */
export function canonicalTemplate(template: string): string {
  if (UPPER_IUPAC.test(template)) return template;
  // For ASCII text toUpperCase only maps a-z to A-Z, so the length is preserved.
  if (ASCII_ONLY.test(template)) return template.toUpperCase().replace(/U/g, 'T');
  return template.replace(/[a-zU]/g, (ch) => (ch === 'U' || ch === 'u' ? 'T' : ch.toUpperCase()));
}
