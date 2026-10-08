/**
 * Sequence characters read from flat files (GenBank ORIGIN blocks, FASTA bodies):
 * validation, case folding and the GenBank ORIGIN layout. Shared by the GenBank and FASTA readers.
 *
 * Invalid characters are REPLACED (by N for nucleotides, X for proteins) rather than dropped:
 * in a GenBank file every character is a numbered position that feature locations refer to,
 * so dropping one would silently shift every downstream annotation. Callers warn about them.
 */
import type { MoleculeType } from '../types';
import { IUPAC_DNA } from '../seq/alphabet';

/** Result of {@link cleanResidues}. */
export interface CleanedResidues {
  /** Upper-case sequence, same length as the input. */
  seq: string;
  /** Invalid characters (as found in the input) and how often each occurred. Empty when all were valid. */
  invalid: Map<string, number>;
  /** Index in the input of the first invalid character, or -1. */
  firstInvalidIndex: number;
}

/** Lookup table: input char code (0-127) -> output char code, 0 = invalid. */
function buildTable(valid: string, rewrite: Record<string, string> = {}): Uint8Array {
  const table = new Uint8Array(128);
  for (const ch of valid) {
    table[ch.charCodeAt(0)] = ch.charCodeAt(0);
    table[ch.toLowerCase().charCodeAt(0)] = ch.charCodeAt(0);
  }
  for (const [from, to] of Object.entries(rewrite)) {
    table[from.charCodeAt(0)] = to.charCodeAt(0);
    table[from.toLowerCase().charCodeAt(0)] = to.charCodeAt(0);
  }
  return table;
}

const IUPAC_CODES = Object.keys(IUPAC_DNA).join('');
/** DNA: the IUPAC nucleotide codes of `seq/alphabet.ts`; U is converted to T (types.ts convention 6). */
const DNA_TABLE = buildTable(IUPAC_CODES, { U: 'T' });
/** RNA: IUPAC codes plus U, kept as written (GenBank RNA records usually contain T: also kept). */
const RNA_TABLE = buildTable(IUPAC_CODES + 'U');
/**
 * Protein: all 26 letters are IUPAC-IUB amino-acid codes (20 standard + B, Z, J, U, O, X;
 * IUPAC-IUB JCBN 1983 nomenclature) and '*' is a stop / translation terminator.
 */
const PROTEIN_TABLE = buildTable('ABCDEFGHIJKLMNOPQRSTUVWXYZ*');

const VALID_DNA = /^[ACGTRYSWKMBDHVN]*$/;
const VALID_RNA = /^[ACGTURYSWKMBDHVN]*$/;
const VALID_PROTEIN = /^[A-Z*]*$/;

/**
 * Upper-case and validate residues. `raw` must already be free of whitespace and digits.
 * DNA converts U to T; RNA keeps U; protein accepts all letters and '*'. Every other character
 * is replaced by 'N' (DNA/RNA) or 'X' (protein) and reported in `invalid`. Output length equals
 * input length (for inputs made of UTF-16 code units, i.e. any JS string).
 */
export function cleanResidues(raw: string, molecule: MoleculeType): CleanedResidues {
  // Fast path (native string operations) for the overwhelmingly common valid input.
  let upper = raw.toUpperCase();
  if (molecule === 'DNA' && upper.includes('U')) upper = upper.replaceAll('U', 'T');
  const fast = molecule === 'DNA' ? VALID_DNA : molecule === 'RNA' ? VALID_RNA : VALID_PROTEIN;
  if (upper.length === raw.length && fast.test(upper)) {
    return { seq: upper, invalid: new Map(), firstInvalidIndex: -1 };
  }

  const table = molecule === 'DNA' ? DNA_TABLE : molecule === 'RNA' ? RNA_TABLE : PROTEIN_TABLE;
  const replacement = (molecule === 'protein' ? 'X' : 'N').charCodeAt(0);
  const codes = new Uint16Array(raw.length);
  const invalid = new Map<string, number>();
  let firstInvalidIndex = -1;
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    const out = c < 128 ? table[c] : 0;
    if (out !== 0) {
      codes[i] = out;
    } else {
      codes[i] = replacement;
      invalid.set(raw[i], (invalid.get(raw[i]) ?? 0) + 1);
      if (firstInvalidIndex < 0) firstInvalidIndex = i;
    }
  }
  return { seq: decodeCodes(codes), invalid, firstInvalidIndex };
}

/** String from UTF-16 codes without hitting argument-count limits on long sequences. */
function decodeCodes(codes: Uint16Array): string {
  const chunks: string[] = [];
  for (let i = 0; i < codes.length; i += 8192) {
    chunks.push(String.fromCharCode(...codes.subarray(i, i + 8192)));
  }
  return chunks.join('');
}

/** Human-readable list of invalid characters, e.g. `'X' (3), '-' (1)`. */
export function describeInvalid(invalid: ReadonlyMap<string, number>): string {
  return [...invalid.entries()].map(([ch, n]) => `${JSON.stringify(ch)} (${n})`).join(', ');
}

/** Letters that occur in protein sequences but are not IUPAC nucleotide codes. */
const PROTEIN_ONLY = /[EFIJLOPQZ]/i;

/**
 * Guess the molecule type of a bare sequence (FASTA, or a GenBank LOCUS line without any
 * molecule information): any letter that is an amino-acid code but not a nucleotide code
 * (E F I J L O P Q Z) means protein; otherwise U without T means RNA; otherwise DNA.
 * Short peptides made only of letters shared with the IUPAC nucleotide codes cannot be
 * distinguished and are reported as DNA.
 */
export function detectMolecule(residues: string): MoleculeType {
  if (PROTEIN_ONLY.test(residues)) return 'protein';
  if (/u/i.test(residues) && !/t/i.test(residues)) return 'RNA';
  return 'DNA';
}

/**
 * Most blanks accepted before the base number of a sequence line without its ORIGIN keyword:
 * the number is right-aligned in 9 columns (gbrel.txt 3.4.14), plus slack for writers that use
 * 10 (wrong_sequence_indent.gb). Header continuation lines start at column 13 and feature
 * qualifier lines at column 22, so neither can pass for a sequence line.
 */
const MAX_SEQUENCE_NUMBER_INDENT = 11;

/** Residue characters of a sequence line: letters (nucleotide or amino-acid codes) and '*'. */
function isResidueCode(c: number): boolean {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 42;
}

/**
 * First base number and residue count of a line in the ORIGIN layout (`       61 acgtacgtac
 * gtac`): at most 11 blanks, the 1-based number of its first residue, then blocks of residues
 * (letters or '*') each preceded by blanks; a line with the number alone has no residues.
 * Returns undefined for any other line. `line` must be free of tabs and trailing blanks.
 */
export function readNumberedSequenceLine(line: string): { firstBase: number; residues: number } | undefined {
  let i = 0;
  while (line.charCodeAt(i) === 32) i++;
  if (i > MAX_SEQUENCE_NUMBER_INDENT) return undefined;
  const digits = i;
  while (line.charCodeAt(i) >= 48 && line.charCodeAt(i) <= 57) i++;
  if (i === digits) return undefined;
  const firstBase = Number(line.slice(digits, i));
  let residues = 0;
  while (i < line.length) {
    const blanks = i;
    while (line.charCodeAt(i) === 32) i++;
    const block = i;
    while (isResidueCode(line.charCodeAt(i))) i++;
    if (block === blanks || i === block) return undefined;
    residues += i - block;
  }
  return { firstBase, residues };
}

/**
 * Sequence lines that lost their ORIGIN keyword line: the trailing run of numbered sequence
 * lines (see {@link readNumberedSequenceLine}) of `lines[start, end)`, blank lines after it
 * allowed, provided that it reads as a complete ORIGIN block: its first line starts at base 1,
 * every other line starts right after the previous line's last residue, and it holds at least
 * one residue. Header text and feature tables do not number their lines that way.
 *
 * @returns the line range [start, end) of the block, or undefined when there is none
 */
export function findUnlabelledSequenceBlock(
  lines: readonly string[],
  start: number,
  end: number,
): { start: number; end: number } | undefined {
  let blockEnd = end;
  while (blockEnd > start && lines[blockEnd - 1] === '') blockEnd--;
  let blockStart = blockEnd;
  let nextFirstBase = -1; // first base of the line below the one being read (-1: none yet)
  let residues = 0;
  while (blockStart > start) {
    const line = readNumberedSequenceLine(lines[blockStart - 1]);
    if (line === undefined || (nextFirstBase >= 0 && line.firstBase + line.residues !== nextFirstBase)) break;
    nextFirstBase = line.firstBase;
    residues += line.residues;
    blockStart--;
  }
  return nextFirstBase === 1 && residues > 0 ? { start: blockStart, end: blockEnd } : undefined;
}

/**
 * GenBank ORIGIN block: lower-case residues, 60 per line in blocks of 10 separated by one
 * space, each line starting with the 1-based position of its first residue right-aligned in
 * 9 columns (GenBank release notes, gbrel.txt section 3.4.14 "SEQUENCE Format"; identical to
 * Biopython's writer).
 * Returns the lines, starting with 'ORIGIN'.
 */
export function formatOrigin(seq: string): string[] {
  const lines = ['ORIGIN'];
  const lower = seq.toLowerCase();
  for (let i = 0; i < lower.length; i += 60) {
    const end = Math.min(i + 60, lower.length);
    let line = String(i + 1).padStart(9);
    for (let j = i; j < end; j += 10) line += ' ' + lower.slice(j, Math.min(j + 10, end));
    lines.push(line);
  }
  return lines;
}
