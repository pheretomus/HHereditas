/**
 * Nucleotide alphabet: IUPAC codes, complements and normalisation.
 */

/** Each IUPAC nucleotide code and the set of bases it stands for. */
export const IUPAC_DNA: Readonly<Record<string, string>> = Object.freeze({
  A: 'A',
  C: 'C',
  G: 'G',
  T: 'T',
  R: 'AG',
  Y: 'CT',
  S: 'CG',
  W: 'AT',
  K: 'GT',
  M: 'AC',
  B: 'CGT',
  D: 'AGT',
  H: 'ACT',
  V: 'ACG',
  N: 'ACGT',
});

/** Complement of every IUPAC nucleotide code (upper and lower case). */
const COMPLEMENT_PAIRS: ReadonlyArray<[string, string]> = [
  ['A', 'T'],
  ['C', 'G'],
  ['R', 'Y'],
  ['S', 'S'],
  ['W', 'W'],
  ['K', 'M'],
  ['B', 'V'],
  ['D', 'H'],
  ['N', 'N'],
];

const COMPLEMENT_TABLE: Uint8Array = (() => {
  const t = new Uint8Array(128);
  for (let i = 0; i < 128; i++) t[i] = i; // unknown characters map to themselves
  const set = (a: string, b: string) => {
    t[a.charCodeAt(0)] = b.charCodeAt(0);
    t[b.charCodeAt(0)] = a.charCodeAt(0);
  };
  for (const [a, b] of COMPLEMENT_PAIRS) {
    set(a, b);
    set(a.toLowerCase(), b.toLowerCase());
  }
  // RNA uracil complements to A; A complements to T (DNA convention).
  t['U'.charCodeAt(0)] = 'A'.charCodeAt(0);
  t['u'.charCodeAt(0)] = 'a'.charCodeAt(0);
  return t;
})();

/** Complement of a single nucleotide character (IUPAC aware, case preserving). */
export function complementBase(ch: string): string {
  const c = ch.charCodeAt(0);
  return c < 128 ? String.fromCharCode(COMPLEMENT_TABLE[c]) : ch;
}

/** Complement of a sequence without reversing it. */
export function complement(seq: string): string {
  const out = new Array<string>(seq.length);
  for (let i = 0; i < seq.length; i++) {
    const c = seq.charCodeAt(i);
    out[i] = c < 128 ? String.fromCharCode(COMPLEMENT_TABLE[c]) : seq[i];
  }
  return out.join('');
}

/** Reverse complement of a sequence (IUPAC aware, case preserving). */
export function reverseComplement(seq: string): string {
  const n = seq.length;
  const out = new Array<string>(n);
  for (let i = 0; i < n; i++) {
    const c = seq.charCodeAt(n - 1 - i);
    out[i] = c < 128 ? String.fromCharCode(COMPLEMENT_TABLE[c]) : seq[n - 1 - i];
  }
  return out.join('');
}

/** Reverse a sequence (no complement). */
export function reverse(seq: string): string {
  let out = '';
  for (let i = seq.length - 1; i >= 0; i--) out += seq[i];
  return out;
}

const DNA_CHARS = /^[ACGTRYSWKMBDHVN]*$/;
const UNAMBIGUOUS_DNA_CHARS = /^[ACGT]*$/;

/** True if `seq` only contains uppercase IUPAC nucleotide codes (empty string is valid). */
export function isDna(seq: string): boolean {
  return DNA_CHARS.test(seq);
}

/** True if `seq` only contains A, C, G and T. */
export function isUnambiguousDna(seq: string): boolean {
  return UNAMBIGUOUS_DNA_CHARS.test(seq);
}

/**
 * Turn user input (pasted text, file content) into a clean DNA string:
 * strips whitespace, digits and common separators, upper-cases, converts U to T.
 * Returns the cleaned sequence plus the characters that were rejected (not IUPAC),
 * so callers can warn the user instead of silently dropping data.
 */
export function normalizeDna(input: string): { seq: string; invalid: string[] } {
  const out: string[] = [];
  const invalid = new Set<string>();
  for (const raw of input) {
    if (/[\s\d/\\|.\-*]/.test(raw)) continue;
    let ch = raw.toUpperCase();
    if (ch === 'U') ch = 'T';
    if (IUPAC_DNA[ch] !== undefined) out.push(ch);
    else invalid.add(raw);
  }
  return { seq: out.join(''), invalid: [...invalid] };
}

/** True if IUPAC code `pattern` (e.g. 'R') accepts base `base` (e.g. 'A'). Both must be uppercase. */
export function iupacMatches(pattern: string, base: string): boolean {
  if (pattern === base) return true;
  const set = IUPAC_DNA[pattern];
  if (set === undefined) return false;
  const bases = IUPAC_DNA[base];
  if (bases === undefined) return false;
  // An ambiguous base in the target matches only if every base it may be is accepted by the pattern.
  for (const b of bases) if (!set.includes(b)) return false;
  return true;
}

/**
 * Build a RegExp source matching a (possibly degenerate) IUPAC DNA pattern against an
 * UNAMBIGUOUS uppercase target. E.g. 'GGTNACC' -> 'GGT[ACGT]ACC'.
 */
export function iupacToRegexSource(pattern: string): string {
  let src = '';
  for (const ch of pattern.toUpperCase()) {
    const set = IUPAC_DNA[ch];
    if (set === undefined) throw new Error(`Not an IUPAC nucleotide code: '${ch}'`);
    src += set.length === 1 ? set : `[${set}]`;
  }
  return src;
}
