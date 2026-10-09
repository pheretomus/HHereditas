/**
 * Translation of nucleotide sequences into protein with the NCBI genetic codes.
 *
 * Ambiguous IUPAC codons are translated exactly like Biopython's `Bio.Seq.translate` (the reference
 * implementation the tests compare against; Bio.Data.CodonTable.AmbiguousForwardTable):
 *   - every codon the triplet may stand for codes the same amino acid -> that amino acid (GCN -> A);
 *   - they code only for D or N -> B, only for E or Q -> Z, only for I or L -> J
 *     (IUPAC-IUB amino-acid ambiguity letters; J was adopted by the INSDC in 2006);
 *   - any other mixture of amino acids, or a mixture of amino acids and stop codons
 *     (TAN, NNN in the standard code) -> X;
 *   - every expansion is a stop codon (TAR, TRA in the standard code) -> '*'.
 * Context-dependent stop codons (tables 27, 28 and 31, see {@link GeneticCode.forwardTable}) are
 * read as amino acids, except as the last codon of a complete coding sequence (`cds`).
 */
import type { Feature, SeqRecord, Topology } from '../types';
import { IUPAC_DNA } from './alphabet';
import { GENETIC_CODES, getGeneticCode } from './codon-tables';
import type { GeneticCode } from './codon-tables';
import { featureLength, featureSequence } from './features';
import { mod, rangeContainsIndex } from './range';

/** Thrown when a nucleotide sequence or feature cannot be translated (invalid character, bad qualifier, ...). */
export class TranslationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TranslationError';
  }
}

// ---------------------------------------------------------------------------
// Nucleotide masks (shared with orf.ts and search.ts)
// ---------------------------------------------------------------------------

/** Bit of each unambiguous base inside a nucleotide mask. */
const BASE_BIT: Readonly<Record<string, number>> = { A: 1, C: 2, G: 4, T: 8 };
/** Base letter of bit number 0..3. */
const BIT_BASE = 'ACGT';

/**
 * @internal Set-of-bases mask of each character code below 128: A=1, C=2, G=4, T=8 and the
 * IUPAC ambiguity codes as unions (R=5, N=15), built from {@link IUPAC_DNA}. Lower case is folded
 * to upper case and U/u are read as T. 0 marks a character that is not a nucleotide code.
 */
export const NUCLEOTIDE_MASK: Uint8Array = (() => {
  const table = new Uint8Array(128);
  for (const [code, bases] of Object.entries(IUPAC_DNA)) {
    let mask = 0;
    for (const b of bases) mask |= BASE_BIT[b];
    table[code.charCodeAt(0)] = mask;
    table[code.toLowerCase().charCodeAt(0)] = mask;
  }
  table['U'.charCodeAt(0)] = BASE_BIT.T;
  table['u'.charCodeAt(0)] = BASE_BIT.T;
  return table;
})();

/** @internal Mask of the complementary base set (A<->T, C<->G), e.g. R (A|G) -> Y (C|T). */
export function complementMask(mask: number): number {
  return ((mask & 1) << 3) | ((mask & 8) >> 3) | ((mask & 2) << 1) | ((mask & 4) >> 1);
}

/** @internal Mask of the character at `i`, 0 if it is not a nucleotide code. */
export function maskAt(seq: string, i: number): number {
  const c = seq.charCodeAt(i);
  return c < 128 ? NUCLEOTIDE_MASK[c] : 0;
}

/**
 * @internal The whole character (code point) starting at UTF-16 index `i` of `s`, for error messages:
 * `s[i]` would be half of a surrogate pair for characters such as emoji.
 */
export function characterAt(s: string, i: number): string {
  const code = s.codePointAt(i);
  return code === undefined ? '' : String.fromCodePoint(code);
}

function invalidNucleotide(seq: string, i: number): TranslationError {
  return new TranslationError(
    `Invalid nucleotide '${characterAt(seq, i)}' at index ${i} (0-based); expected an IUPAC code`,
  );
}

/**
 * @internal Encode a nucleotide sequence as one mask per base (see {@link NUCLEOTIDE_MASK}).
 * strict = true throws a TranslationError on a character that is not an IUPAC nucleotide code;
 * strict = false stores 0 for it.
 */
export function encodeNucleotides(seq: string, strict: boolean): Uint8Array {
  const n = seq.length;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const m = maskAt(seq, i);
    if (m === 0 && strict) throw invalidNucleotide(seq, i);
    out[i] = m;
  }
  return out;
}

/** @internal Reverse complement of an encoded sequence (masks of 0 stay 0). */
export function reverseComplementMasks(masks: Uint8Array): Uint8Array {
  const n = masks.length;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = complementMask(masks[n - 1 - i]);
  return out;
}

/** @internal Lookup key of a codon given as three masks: (m1 << 8) | (m2 << 4) | m3, in [0, 4096). */
export function codonKey(m1: number, m2: number, m3: number): number {
  return (m1 << 8) | (m2 << 4) | m3;
}

// ---------------------------------------------------------------------------
// Compiled genetic codes
// ---------------------------------------------------------------------------

/**
 * @internal Lookup tables of one genetic code for every (possibly ambiguous) codon, indexed by
 * {@link codonKey}. Entries whose key contains a 0 mask are 0 in all four tables.
 */
export interface CompiledGeneticCode {
  readonly code: GeneticCode;
  /** Character code of the translation: amino acid, B/Z/J/X for ambiguous codons, '*' for stops. */
  readonly aa: Uint8Array;
  /**
   * Character code of the translation as the initiator codon of a complete coding sequence: each
   * codon the triplet may stand for reads as M when it is a start codon of the table and as its
   * amino acid (or stop) otherwise, and the readings are combined with the rules of `aa`. So M when
   * every expansion is a start codon (or the others are Met codons too, as ATR in table 21), the
   * internal translation when none is, and X when start and non-start codons mix (GTN in table 11:
   * M or V).
   */
  readonly initiator: Uint8Array;
  /** 1 when every codon the triplet may stand for is a start codon of the table. */
  readonly start: Uint8Array;
  /** 1 when every codon the triplet may stand for is in `stopCodons` (context-dependent stops included). */
  readonly stop: Uint8Array;
  /** True for tables with context-dependent stop codons (27, 28, 31). */
  readonly hasContextStops: boolean;
}

/**
 * Amino-acid ambiguity letters and the residues each stands for (IUPAC-IUB JCBN 1983; J from
 * INSDC 2006), as in Biopython's `IUPACData.extended_protein_values`. Biopython picks the smallest
 * covering letter; the three sets are disjoint so at most one can cover a mixture.
 */
const AMINO_ACID_AMBIGUITY: ReadonlyArray<readonly [string, string]> = [
  ['B', 'DN'],
  ['J', 'IL'],
  ['Z', 'EQ'],
];

/** Translation of a set of codons an ambiguous triplet may stand for (see the module comment). */
function resolveExpansion(aminoAcids: ReadonlySet<string>, nonCoding: number, total: number): string {
  if (nonCoding === total) return '*';
  if (nonCoding > 0) return 'X';
  if (aminoAcids.size === 1) return aminoAcids.values().next().value as string;
  for (const [letter, members] of AMINO_ACID_AMBIGUITY) {
    let covered = true;
    for (const aa of aminoAcids) if (!members.includes(aa)) covered = false;
    if (covered) return letter;
  }
  return 'X';
}

function basesOf(mask: number): string[] {
  const out: string[] = [];
  for (let bit = 0; bit < 4; bit++) if (mask & (1 << bit)) out.push(BIT_BASE[bit]);
  return out;
}

function compile(code: GeneticCode): CompiledGeneticCode {
  const aa = new Uint8Array(4096);
  const initiator = new Uint8Array(4096);
  const start = new Uint8Array(4096);
  const stop = new Uint8Array(4096);
  const starts = new Set(code.startCodons);
  const stops = new Set(code.stopCodons);
  for (let m1 = 1; m1 < 16; m1++) {
    for (let m2 = 1; m2 < 16; m2++) {
      for (let m3 = 1; m3 < 16; m3++) {
        const aminoAcids = new Set<string>();
        const initiatorReadings = new Set<string>(); // M for a start codon, else its amino acid
        let total = 0;
        let nonCoding = 0;
        let initiatorNonCoding = 0;
        let nStart = 0;
        let nStop = 0;
        for (const b1 of basesOf(m1)) {
          for (const b2 of basesOf(m2)) {
            for (const b3 of basesOf(m3)) {
              const codon = b1 + b2 + b3;
              total++;
              const residue = code.forwardTable[codon];
              if (residue === undefined) nonCoding++;
              else aminoAcids.add(residue);
              const initial = starts.has(codon) ? 'M' : residue;
              if (initial === undefined) initiatorNonCoding++;
              else initiatorReadings.add(initial);
              if (starts.has(codon)) nStart++;
              if (stops.has(codon)) nStop++;
            }
          }
        }
        const key = codonKey(m1, m2, m3);
        aa[key] = resolveExpansion(aminoAcids, nonCoding, total).charCodeAt(0);
        initiator[key] = resolveExpansion(initiatorReadings, initiatorNonCoding, total).charCodeAt(0);
        start[key] = nStart === total ? 1 : 0;
        stop[key] = nStop === total ? 1 : 0;
      }
    }
  }
  const hasContextStops = code.stopCodons.some((c) => code.forwardTable[c] !== undefined);
  return { code, aa, initiator, start, stop, hasContextStops };
}

const compiledCodes = new Map<number, CompiledGeneticCode>();

/**
 * @internal Lookup tables for NCBI genetic code `id`, built on first use and cached.
 * @throws RangeError for an unknown table id.
 */
export function compileGeneticCode(id: number): CompiledGeneticCode {
  let compiled = compiledCodes.get(id);
  if (compiled === undefined) {
    compiled = compile(getGeneticCode(id));
    compiledCodes.set(id, compiled);
  }
  return compiled;
}

// ---------------------------------------------------------------------------
// Translation
// ---------------------------------------------------------------------------

const CHAR_STOP = '*'.charCodeAt(0);
const CHAR_X = 'X'.charCodeAt(0);
/** Mask of N (any base), used to pad a trailing partial codon. */
const MASK_N = 15;

/** @internal Turn character codes into a string without building one string per character. */
export function charCodesToString(codes: Uint8Array, length: number): string {
  const CHUNK = 8192;
  let out = '';
  for (let i = 0; i < length; i += CHUNK) {
    out += String.fromCharCode(...codes.subarray(i, Math.min(length, i + CHUNK)));
  }
  return out;
}

/** How the codons of one reading frame are turned into amino acids. */
interface FrameRules {
  /** The first codon is an initiator: translated with {@link CompiledGeneticCode.initiator} (M for a start codon). */
  initiator: boolean;
  /** The last codon is a terminator: translated as '*' when it is a stop codon of the table. */
  terminator: boolean;
  /** Stop before the first '*'. */
  toStop: boolean;
  /**
   * Translate a trailing partial codon (1 or 2 bases) as NCBI translates coding regions: pad it with
   * N and keep the amino acid unless it is X. false: ignore it, as Biopython does.
   */
  padPartialCodon: boolean;
  /** Overrides (/transl_except) by codon index; index = number of complete codons for a trailing partial codon. */
  exceptions?: ReadonlyMap<number, string>;
}

/**
 * Residue (character code) of the trailing partial codon of length `tailLength` (1 or 2) at `i`,
 * padded with N as in the NCBI C++ Toolkit (CSeqTranslator::TranslateToProtein: the bases are
 * followed by N, and "if padding was needed, trim ambiguous last residue"): GC -> GCN -> A; GA -> GAN
 * (D or E) -> X -> undefined, i.e. no residue. `first` marks the initiator codon of a coding
 * sequence; as in TranslateToProtein, its internal residue decides whether it is dropped, and the
 * initiator residue is what is kept (GT in table 11: GTN = V, kept, as initiator X).
 */
function paddedCodonResidue(
  nt: string,
  i: number,
  tailLength: number,
  cc: CompiledGeneticCode,
  first: boolean,
): number | undefined {
  const m1 = maskAt(nt, i);
  const m2 = tailLength === 2 ? maskAt(nt, i + 1) : MASK_N;
  if (m1 === 0 || m2 === 0) throw invalidNucleotide(nt, m1 === 0 ? i : i + 1);
  const key = codonKey(m1, m2, MASK_N);
  if (cc.aa[key] === CHAR_X) return undefined;
  return first ? cc.initiator[key] : cc.aa[key];
}

/**
 * Translate the complete codons of `nt` that start at `offset`, `offset + 3`, ..., then the trailing
 * partial codon when `rules.padPartialCodon` is set or a /transl_except covers it.
 */
function translateCodons(nt: string, offset: number, cc: CompiledGeneticCode, rules: FrameRules): string {
  const nCodons = Math.max(0, Math.floor((nt.length - offset) / 3));
  const out = new Uint8Array(nCodons + 1);
  let n = 0;
  for (let k = 0; k < nCodons; k++) {
    const i = offset + 3 * k;
    const m1 = maskAt(nt, i);
    const m2 = maskAt(nt, i + 1);
    const m3 = maskAt(nt, i + 2);
    if (m1 === 0 || m2 === 0 || m3 === 0) throw invalidNucleotide(nt, m1 === 0 ? i : m2 === 0 ? i + 1 : i + 2);
    const key = codonKey(m1, m2, m3);
    let residue = cc.aa[key];
    const override = rules.exceptions?.get(k);
    if (override !== undefined) residue = override.charCodeAt(0);
    else if (k === 0 && rules.initiator) residue = cc.initiator[key];
    else if (k === nCodons - 1 && rules.terminator && cc.stop[key] === 1) residue = CHAR_STOP;
    if (residue === CHAR_STOP && rules.toStop) return charCodesToString(out, n);
    out[n++] = residue;
  }
  const tailStart = offset + 3 * nCodons;
  const tailLength = nt.length - tailStart; // 1 or 2 for a partial codon; <= 0 when there is none
  let tail: number | undefined;
  if (rules.padPartialCodon && tailLength > 0) {
    tail = paddedCodonResidue(nt, tailStart, tailLength, cc, nCodons === 0 && rules.initiator);
  }
  // A /transl_except replaces the residue of the partial codon, or supplies it: a stop codon
  // completed by polyadenylation (T or TA + poly(A) tail -> TAA) is written aa:TERM.
  const override = rules.exceptions?.get(nCodons);
  if (override !== undefined) tail = override.charCodeAt(0);
  if (tail !== undefined && !(tail === CHAR_STOP && rules.toStop)) out[n++] = tail;
  return charCodesToString(out, n);
}

/** Options of {@link translate}. */
export interface TranslateOptions {
  /** NCBI genetic code (translation table) id; default 1, the standard code. See {@link GENETIC_CODES}. */
  table?: number;
  /** Reading frame: the number of leading bases (0, 1 or 2) skipped before the first codon; default 0. */
  frame?: 0 | 1 | 2;
  /**
   * Stop before the first stop codon ('*' is not included); default false.
   * Not allowed together with a table that has context-dependent stop codons (27, 28, 31) unless
   * `cds` is set, because whether such a codon stops translation is then undefined (Biopython
   * raises in the same situation).
   */
  toStop?: boolean;
  /**
   * Treat the input (after skipping `frame` bases) as a complete coding sequence: the first codon
   * is read as an initiator, i.e. M when it is a start codon of the table, and, when the input is a
   * whole number of codons, the last codon is translated as '*' when it is a stop codon of the table
   * (matters only for context-dependent stop codons). An ambiguous initiator combines the readings of
   * the codons it may stand for (M for a start codon, else its amino acid) with the usual rules: M
   * when all are starts (NTG in table 11) or code for Met anyway (ATR in table 21: ATA is Met but not
   * a start), its amino acid when none is a start, X when start and non-start codons mix (GTN in
   * table 11 may be M or V). This is NCBI's start-residue consensus (C++ Toolkit
   * CTrans_table::x_InitFsaTransl, used for the first codon of 5'-complete coding regions), except
   * where NCBI's consensus of start/stop flags says less: NCBI gives X for ATR in table 21, no residue
   * ('-') for codons that are not start codons, and X for codons mixing a context-dependent stop
   * codon with non-stop codons (TGR in table 27); here these are M, the amino acid and the amino acid.
   * Unlike Biopython's `cds=True` this never throws and keeps the final '*'. A trailing partial codon
   * is still ignored (use {@link translateFeature} for NCBI's partial-codon rule). Default false.
   */
  cds?: boolean;
}

function checkTable(table: number | undefined): number {
  const id = table ?? 1;
  if (!Number.isInteger(id)) throw new RangeError(`Translation table must be an integer NCBI id, got ${id}`);
  return id;
}

function checkContextStops(cc: CompiledGeneticCode, toStop: boolean, cds: boolean): void {
  if (toStop && !cds && cc.hasContextStops) {
    throw new TranslationError(
      `toStop cannot be used with genetic code ${cc.code.id} (${cc.code.name}): its stop codons ` +
        `${cc.code.stopCodons.join(', ')} also code for amino acids, so where translation stops is undefined`,
    );
  }
}

/**
 * Translate a DNA or RNA sequence into a one-letter protein sequence ('*' for stop codons).
 *
 * Case-insensitive; U is read as T. Complete codons are read from index `frame` (0-based) on; a
 * trailing partial codon is ignored. Ambiguous IUPAC codons are translated as described in the
 * module comment (GCN -> A, RAY -> B, TAN -> X, TAR -> '*'), matching Biopython.
 *
 * @throws TranslationError when a translated codon contains a character that is not an IUPAC
 *   nucleotide code (X, '-', '.', digits, ... are rejected; Biopython accepts X as N in some cases),
 *   or for `toStop` with a context-dependent stop table (see {@link TranslateOptions.toStop}).
 * @throws RangeError for an unknown table or a frame other than 0, 1 or 2.
 */
export function translate(dna: string, options: TranslateOptions = {}): string {
  const cc = compileGeneticCode(checkTable(options.table));
  const frame = options.frame ?? 0;
  if (frame !== 0 && frame !== 1 && frame !== 2) throw new RangeError(`frame must be 0, 1 or 2, got ${String(frame)}`);
  const cds = options.cds ?? false;
  const toStop = options.toStop ?? false;
  checkContextStops(cc, toStop, cds);
  const coding = dna.length - frame;
  return translateCodons(dna, frame, cc, {
    initiator: cds,
    terminator: cds && coding >= 3 && coding % 3 === 0,
    toStop,
    padPartialCodon: false,
  });
}

// ---------------------------------------------------------------------------
// Feature translation
// ---------------------------------------------------------------------------

/** Options of {@link translateFeature}. */
export interface TranslateFeatureOptions {
  /** Genetic code used when the feature has no /transl_table qualifier (which wins, as in Biopython); default 1. */
  table?: number;
  /** Stop before the first stop codon ('*' is not included); default false. */
  toStop?: boolean;
  /**
   * Treat the feature as a coding sequence and translate it like NCBI (start codon, final stop codon,
   * trailing partial codon); default: true for features of type 'CDS'. See {@link translateFeature}.
   */
  cds?: boolean;
  /** Apply /transl_except qualifiers (selenocysteine, completed stop codons, ...); default true. */
  translExcept?: boolean;
}

/**
 * Throw unless every segment is a valid range of a sequence of length `L` (types.ts conventions):
 * linear 0 <= start <= end <= L; circular 0 <= start < L and start <= end <= start + L, plus the
 * empty range {L, L} at the end gap (so {0, 0} is the only valid range of an empty circular record).
 * Anything else would make sliceRange read whole extra turns of the sequence (or, for L = 0, never
 * return).
 */
function checkSegments(feature: Feature, L: number, topology: Topology): void {
  for (const s of feature.segments) {
    const valid =
      Number.isInteger(s.start) &&
      Number.isInteger(s.end) &&
      s.start >= 0 &&
      s.end >= s.start &&
      (topology === 'linear'
        ? s.end <= L
        : s.end - s.start <= L && (s.start < L || (s.start === L && s.end === L)));
    if (!valid) {
      throw new TranslationError(
        `Feature '${feature.name}' has segment [${s.start}, ${s.end}) outside the ${topology} sequence of length ${L}`,
      );
    }
  }
}

/**
 * The value of an integer qualifier of `feature` (/codon_start, /transl_table), or undefined when the
 * feature has none. The INSDC feature table writes both as plain decimal integers; surrounding white
 * space and leading zeros are accepted, anything else is rejected rather than guessed: '' and blanks
 * (which `Number` would read as 0), signs, fractions, exponents and hexadecimal ('0x0B' is 11 for
 * `Number`). A value-less occurrence (GenBank `/transl_table` without '=') and repeated occurrences
 * with different values are errors too; repeats of the same value are accepted.
 *
 * @throws TranslationError naming the feature, the qualifier and the offending value.
 */
function integerQualifier(
  feature: Feature,
  key: string,
  expected: string,
): { value: number; written: string } | undefined {
  let found: { value: number; written: string } | undefined;
  for (const q of feature.qualifiers) {
    if (q.key !== key) continue;
    if (q.value === null) {
      throw new TranslationError(`Feature '${feature.name}' has /${key} without a value; expected ${expected}`);
    }
    const text = q.value.trim();
    if (!/^[0-9]+$/.test(text)) {
      throw new TranslationError(`Feature '${feature.name}' has /${key}="${q.value}"; expected ${expected}`);
    }
    const value = Number(text);
    if (found !== undefined && value !== found.value) {
      throw new TranslationError(
        `Feature '${feature.name}' has conflicting /${key} values "${found.written}" and "${q.value}"`,
      );
    }
    found ??= { value, written: q.value };
  }
  return found;
}

/** 0-based offset of the first complete codon from the /codon_start qualifier (1, 2 or 3; default 1). */
function codonStartOffset(feature: Feature): number {
  const q = integerQualifier(feature, 'codon_start', '1, 2 or 3');
  if (q === undefined) return 0;
  if (q.value !== 1 && q.value !== 2 && q.value !== 3) {
    throw new TranslationError(`Feature '${feature.name}' has /codon_start="${q.written}"; expected 1, 2 or 3`);
  }
  return q.value - 1;
}

/**
 * Table id from the /transl_table qualifier, or undefined when absent. An id that is not an NCBI
 * genetic code (0 and unassigned ids such as 7, 8 and 17-20) is an error in the feature, so it throws
 * a TranslationError naming the feature, not the RangeError of {@link getGeneticCode}.
 */
function translTable(feature: Feature): number | undefined {
  const q = integerQualifier(feature, 'transl_table', 'an NCBI table id');
  if (q === undefined) return undefined;
  if (GENETIC_CODES.some((c) => c.id === q.value)) return q.value;
  const known = GENETIC_CODES.map((c) => c.id).join(', ');
  throw new TranslationError(
    `Feature '${feature.name}' has /transl_table="${q.written}": unknown NCBI genetic code; known tables: ${known}`,
  );
}

/**
 * One-letter code of the amino-acid abbreviations allowed in /transl_except (INSDC feature table
 * definition, qualifier transl_except: three-letter codes, Sec, Pyl, TERM and OTHER).
 */
const TRANSL_EXCEPT_AA: Readonly<Record<string, string>> = {
  ALA: 'A', ARG: 'R', ASN: 'N', ASP: 'D', CYS: 'C', GLN: 'Q', GLU: 'E', GLY: 'G', HIS: 'H', ILE: 'I',
  LEU: 'L', LYS: 'K', MET: 'M', PHE: 'F', PRO: 'P', SER: 'S', THR: 'T', TRP: 'W', TYR: 'Y', VAL: 'V',
  SEC: 'U', PYL: 'O', ASX: 'B', GLX: 'Z', XLE: 'J', XAA: 'X', OTHER: 'X', TERM: '*', TER: '*',
};

/**
 * 0-based parent indices covered by a /transl_except location (1-based INSDC syntax): "a..b", "a",
 * and "join(...)" / "complement(...)" combinations of those. The strand does not matter here: the
 * positions are mapped into the feature's own coordinates. Returns undefined for anything else
 * (e.g. a remote "X58595.1:189..191") or positions outside [1, L].
 */
function parseExceptLocation(location: string, L: number): number[] | undefined {
  const loc = location.replace(/\s+/g, '');
  const opened = loc.match(/\(/g)?.length ?? 0;
  const operators = loc.match(/(?:complement|join|order)\(/g)?.length ?? 0;
  if (opened !== operators || opened !== (loc.match(/\)/g)?.length ?? 0)) return undefined;
  const positions: number[] = [];
  for (const part of loc.replace(/(?:complement|join|order)\(|\)/g, '').split(',')) {
    const m = /^<?(\d+)(?:\.\.>?(\d+))?$/.exec(part);
    if (!m) return undefined;
    const first = Number(m[1]) - 1;
    const last = m[2] === undefined ? first : Number(m[2]) - 1;
    if (first < 0 || last < first || last >= L) return undefined;
    for (let p = first; p <= last; p++) positions.push(p);
  }
  return positions;
}

/**
 * Index of parent base `p` inside the feature's own 5'->3' sequence, or -1 if the feature does
 * not cover it. Segments are walked in join order (top strand), then flipped for strand -1.
 */
function featureLocalIndex(feature: Feature, p: number, L: number, topology: Topology, total: number): number {
  let before = 0;
  for (const s of feature.segments) {
    if (rangeContainsIndex(s, p, L, topology)) {
      const inSegment = topology === 'circular' ? mod(p - s.start, L) : p - s.start;
      const topIndex = before + inSegment;
      return feature.strand === -1 ? total - 1 - topIndex : topIndex;
    }
    before += s.end - s.start;
  }
  return -1;
}

/** Codon overrides from /transl_except, keyed by codon index (relative to the first complete codon). */
function translExceptions(feature: Feature, offset: number, L: number, topology: Topology): Map<number, string> {
  const out = new Map<number, string>();
  const total = featureLength(feature);
  for (const { key, value: raw } of feature.qualifiers) {
    if (key !== 'transl_except') continue;
    if (raw === null) {
      // getQualifiers would skip it; a value-less /transl_except is malformed, not absent
      throw new TranslationError(
        `Feature '${feature.name}' has /transl_except without a value; expected (pos:<location>,aa:<amino acid>)`,
      );
    }
    const fail = (why: string) =>
      new TranslationError(`Feature '${feature.name}': cannot apply /transl_except=${raw} (${why})`);
    const m = /^\(\s*pos:(.+),\s*aa:\s*([A-Za-z]+)\s*\)$/.exec(raw.trim());
    if (!m) throw fail('expected (pos:<location>,aa:<amino acid>)');
    const residue = TRANSL_EXCEPT_AA[m[2].toUpperCase()];
    if (residue === undefined) throw fail(`unknown amino acid '${m[2]}'`);
    const loc = parseExceptLocation(m[1], L);
    if (loc === undefined) throw fail('unsupported or out-of-range location');
    const local = loc.map((p) => featureLocalIndex(feature, p, L, topology, total));
    if (local.some((i) => i < 0)) throw fail('position outside the feature');
    local.sort((a, b) => a - b);
    for (let k = 1; k < local.length; k++) {
      if (local[k] !== local[k - 1] + 1) throw fail('positions are not contiguous in the feature');
    }
    const first = local[0] - offset;
    // A complete codon has 3 bases; only the trailing partial codon (a stop codon completed by
    // polyadenylation) may be shorter, and then it must cover exactly the bases that remain.
    const completeCodons = Math.floor((total - offset) / 3);
    const width = first / 3 < completeCodons ? 3 : (total - offset) % 3;
    if (first < 0 || first % 3 !== 0 || local.length !== width) throw fail('not a codon of the reading frame');
    out.set(first / 3, residue);
  }
  return out;
}

/**
 * Translate a feature of a nucleotide record (normally a CDS) into protein ('*' for stop codons).
 *
 * The feature's own 5'->3' sequence is built from its segments (joined in order, origin-wrapping
 * segments included, reverse-complemented for strand -1; strand 0 is read as +1). Then:
 *   - /codon_start (1, 2 or 3) gives the first complete codon;
 *   - /transl_table selects the genetic code (otherwise `options.table`, default 1). Both qualifiers
 *     are plain decimal integers (surrounding white space and leading zeros allowed); a repeated
 *     qualifier must repeat the same value;
 *   - /transl_except overrides single codons (e.g. TGA -> U for selenocysteine, a stop codon
 *     completed by polyadenylation -> '*') unless `options.translExcept` is false. On an incomplete
 *     last codon it replaces the padded residue, or supplies the residue when there is none; NCBI
 *     supplies one only for TERM, so a non-TERM exception there is the one case that differs;
 *   - coding features (`options.cds`, default `feature.type === 'CDS'`) are translated like NCBI
 *     translates coding regions (C++ Toolkit, src/objmgr/util/sequence.cpp, CSeqTranslator), so
 *     the result equals the GenBank /translation (plus a final '*' for a stop codon):
 *       - the first codon is read as an initiator (M when it is a start codon of the table; for an
 *         ambiguous codon see {@link TranslateOptions.cds}), but only when the feature is 5' complete
 *         (/codon_start=1 and no fuzzy 5' end): `check_start = is_5prime_complete && frame == 0`.
 *         Unlike Biopython, a 5'-partial CDS keeps the amino acid of its first codon;
 *       - the last codon of a 3'-complete feature is '*' when it is a (context-dependent) stop codon;
 *       - a trailing partial codon (1 or 2 bases, typically at the end of a 3'-partial CDS) is
 *         padded with N, and its amino acid is kept unless it is X ("if padding was needed, trim
 *         ambiguous last residue"): GC -> GCN -> A and CT -> L are kept; GA -> GAN (D or E) and a
 *         single base add nothing. Its bases must be IUPAC codes;
 *   - non-coding translation (`cds` false) ignores a trailing partial codon, like {@link translate}
 *     and Biopython's SeqFeature.translate.
 * The 5' end is `partialStart` for strand +1/0 and `partialEnd` for strand -1.
 *
 * @throws TranslationError for protein records; segments that are not valid ranges of the record
 *   (types.ts conventions; on a circular record an empty segment must start below L or be {L, L});
 *   invalid characters; /codon_start, /transl_table or /transl_except values that are missing
 *   (value-less qualifier), unparsable or conflicting, and a /transl_table that is not an NCBI genetic
 *   code. Every message names the feature, so a caller translating many features can report it.
 * @throws RangeError for an unknown `options.table` (the caller's setting, not feature data).
 */
export function translateFeature(rec: SeqRecord, feature: Feature, options: TranslateFeatureOptions = {}): string {
  if (rec.molecule === 'protein') {
    throw new TranslationError(`Cannot translate feature '${feature.name}' of a protein record`);
  }
  const L = rec.seq.length;
  checkSegments(feature, L, rec.topology);
  const nt = featureSequence(feature, rec.seq);

  const offset = codonStartOffset(feature);
  const cc = compileGeneticCode(translTable(feature) ?? checkTable(options.table));
  const cds = options.cds ?? feature.type === 'CDS';
  const toStop = options.toStop ?? false;
  checkContextStops(cc, toStop, cds);
  const fivePrimePartial = (feature.strand === -1 ? feature.partialEnd : feature.partialStart) === true;
  const threePrimePartial = (feature.strand === -1 ? feature.partialStart : feature.partialEnd) === true;
  const coding = nt.length - offset;
  const exceptions = options.translExcept === false ? undefined : translExceptions(feature, offset, L, rec.topology);
  return translateCodons(nt, offset, cc, {
    initiator: cds && offset === 0 && !fivePrimePartial,
    terminator: cds && !threePrimePartial && coding >= 3 && coding % 3 === 0,
    toStop,
    padPartialCodon: cds,
    ...(exceptions !== undefined && exceptions.size > 0 ? { exceptions } : {}),
  });
}
