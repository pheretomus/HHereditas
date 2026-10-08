/**
 * Sequence search: nucleotide motifs (IUPAC codes, mismatches, both strands, across the origin)
 * and peptides (six-frame translated search).
 */
import type { SearchHit, Topology } from '../types';
import { IUPAC_DNA, iupacMatches } from './alphabet';
import {
  NUCLEOTIDE_MASK,
  characterAt,
  codonKey,
  compileGeneticCode,
  encodeNucleotides,
  reverseComplementMasks,
} from './translate';
import type { CompiledGeneticCode } from './translate';

/** Options of {@link searchSequence}. */
export interface SearchOptions {
  /** Strands to search; default 'both'. */
  strands?: 'both' | 'top' | 'bottom';
  /** Maximum number of mismatching positions per hit, an integer 0..3; default 0. Substitutions only (no gaps). */
  maxMismatches?: number;
  /**
   * true (default): an IUPAC code in the query matches every base it stands for, and an ambiguous
   * base in the sequence matches only a query code that covers all its bases (`iupacMatches`: query N
   * matches anything, sequence N matches only query N). false: letters must be identical.
   */
  iupac?: boolean;
}

/** A hit of {@link searchProtein}: a {@link SearchHit} (DNA coordinates, `mismatches` always 0) plus its frame. */
export interface ProteinSearchHit extends SearchHit {
  /** Reading frame of the hit: start % 3 for strand 1; counted from the end of the sequence for strand -1. */
  frame: 0 | 1 | 2;
}

/** Options of {@link searchProtein}. */
export interface ProteinSearchOptions {
  /** NCBI genetic code used to translate the sequence; default 1. */
  table?: number;
}

/** IUPAC letter of each 4-bit base mask (see NUCLEOTIDE_MASK); '' for 0. */
const LETTER_OF_MASK: readonly string[] = (() => {
  const out = new Array<string>(16).fill('');
  for (const letter of Object.keys(IUPAC_DNA)) out[NUCLEOTIDE_MASK[letter.charCodeAt(0)]] = letter;
  return out;
})();

/** MATCHES[(queryMask << 4) | targetMask] = 1 when iupacMatches(query letter, target letter). */
const IUPAC_MATCHES: Uint8Array = (() => {
  const t = new Uint8Array(256);
  for (let q = 1; q < 16; q++) {
    for (let s = 1; s < 16; s++) t[(q << 4) | s] = iupacMatches(LETTER_OF_MASK[q], LETTER_OF_MASK[s]) ? 1 : 0;
  }
  return t;
})();

/** Encode a nucleotide query (case-insensitive, U = T); throws RangeError on other characters. */
function encodeQuery(query: string): Uint8Array {
  const out = new Uint8Array(query.length);
  for (let i = 0; i < query.length; i++) {
    const c = query.charCodeAt(i);
    const m = c < 128 ? NUCLEOTIDE_MASK[c] : 0;
    if (m === 0) {
      throw new RangeError(
        `Invalid character '${characterAt(query, i)}' at index ${i} of the query; expected an IUPAC code`,
      );
    }
    out[i] = m;
  }
  return out;
}

/** accept[(i << 4) | targetMask] = 1 when query position i accepts that target base. */
function acceptTable(pattern: Uint8Array, iupac: boolean): Uint8Array {
  const acc = new Uint8Array(pattern.length << 4);
  for (let i = 0; i < pattern.length; i++) {
    for (let t = 1; t < 16; t++) {
      acc[(i << 4) | t] = iupac ? IUPAC_MATCHES[(pattern[i] << 4) | t] : pattern[i] === t ? 1 : 0;
    }
  }
  return acc;
}

/** Sequence masks followed by its first `extra` masks again (circular windows that wrap the origin). */
function withWrap(masks: Uint8Array, extra: number): Uint8Array {
  if (extra <= 0) return masks;
  const out = new Uint8Array(masks.length + extra);
  out.set(masks);
  out.set(masks.subarray(0, extra), masks.length);
  return out;
}

/** Number of mismatches of the window at `p`, or any value > k as soon as it exceeds k. */
function mismatchesAt(target: Uint8Array, p: number, accept: Uint8Array, m: number, k: number): number {
  let mm = 0;
  for (let i = 0; i < m; i++) {
    if (accept[(i << 4) | target[p + i]] === 0 && ++mm > k) return mm;
  }
  return mm;
}

/**
 * Find a nucleotide query on one or both strands, allowing up to `maxMismatches` substitutions.
 *
 * A hit is a window of the top strand, `range` 0-based half-open in top-strand coordinates
 * (circular molecules: windows may cross the origin, end > L; a query longer than the molecule
 * never matches). strand 1: the query reads 5'->3' on the top strand; strand -1: it reads on the
 * bottom strand, i.e. the window equals the reverse complement of the query. Overlapping hits are
 * all reported. A query that is its own reverse complement (e.g. GAATTC) is reported once per
 * window, as strand 1, when both strands are searched. Case-insensitive; U is read as T; sequence
 * characters that are not IUPAC codes never match. Sorted by start, then strand (1 first).
 *
 * @throws RangeError when the query contains a non-IUPAC character or maxMismatches is not 0..3.
 */
export function searchSequence(
  seq: string,
  topology: Topology,
  query: string,
  options: SearchOptions = {},
): SearchHit[] {
  const strands = options.strands ?? 'both';
  if (strands !== 'both' && strands !== 'top' && strands !== 'bottom') {
    throw new RangeError(`strands must be 'both', 'top' or 'bottom'`);
  }
  const k = options.maxMismatches ?? 0;
  if (!Number.isInteger(k) || k < 0 || k > 3) throw new RangeError(`maxMismatches must be an integer 0..3, got ${k}`);
  const iupac = options.iupac ?? true;
  const q = encodeQuery(query);
  const m = q.length;
  const L = seq.length;
  if (m === 0 || m > L) return [];

  const rc = reverseComplementMasks(q);
  const palindrome = rc.every((v, i) => v === q[i]);
  const searchTop = strands !== 'bottom';
  const searchBottom = strands === 'bottom' || (strands === 'both' && !palindrome);
  const acceptTop = acceptTable(q, iupac);
  const acceptBottom = acceptTable(rc, iupac);

  const circular = topology === 'circular';
  const target = withWrap(encodeNucleotides(seq, false), circular ? m - 1 : 0);
  const positions = circular ? L : L - m + 1;
  const hits: SearchHit[] = [];
  for (let p = 0; p < positions; p++) {
    if (searchTop) {
      const mm = mismatchesAt(target, p, acceptTop, m, k);
      if (mm <= k) hits.push({ range: { start: p, end: p + m }, strand: 1, mismatches: mm });
    }
    if (searchBottom) {
      const mm = mismatchesAt(target, p, acceptBottom, m, k);
      if (mm <= k) hits.push({ range: { start: p, end: p + m }, strand: -1, mismatches: mm });
    }
  }
  return hits;
}

/**
 * Peptide letters accepted by {@link searchProtein} and the codon translations each one matches:
 * itself, or for an ambiguity letter the residues it stands for (IUPAC-IUB JCBN 1983) and the
 * ambiguity letter itself (a translated ambiguous codon). '*', U and O match no translation: '*'
 * matches stop codons and U / O one codon each (see {@link letterMatchesClass}).
 */
const PEPTIDE_MATCHES: Readonly<Record<string, string>> = (() => {
  const out: Record<string, string> = {};
  for (const aa of 'ACDEFGHIKLMNPQRSTVWY') out[aa] = aa;
  out.B = 'BDN'; // Asx: D or N
  out.Z = 'ZEQ'; // Glx: E or Q
  out.J = 'JIL'; // Xle: I or L
  out.X = 'ACDEFGHIKLMNPQRSTVWYBZJX'; // any amino acid, not a stop
  out['*'] = '';
  out.U = '';
  out.O = '';
  return out;
})();

/**
 * Peptide letters that stand for a stop codon recoded as an amino acid, and that codon:
 * selenocysteine (U) is inserted at UGA (TGA) codons by the SECIS machinery (Zinoni et al., PNAS
 * 83:4650-4654, 1986: the TGA of E. coli fdhF), pyrrolysine (O) at UAG (TAG) codons (Srinivasan et
 * al., Science 296:1459-1462, 2002; Hao et al., Science 296:1462-1466, 2002). Rare reassignments such
 * as UAG-encoded selenocysteine in Geodermatophilus (Mukai et al., Angew. Chem. Int. Ed.
 * 55:5337-5341, 2016) are not modelled.
 */
const RECODED_CODON: Readonly<Record<string, string>> = { U: 'TGA', O: 'TAG' };
const TGA_KEY = codonKey(8, 4, 1); // masks of T, G, A
const TAG_KEY = codonKey(8, 1, 4); // masks of T, A, G

/**
 * The codons of a genetic code grouped into classes that every peptide letter matches alike: same
 * translation, same stop status (in tables 27, 28 and 31 a context-dependent stop codon translates
 * to an amino acid but is still a stop codon), and TGA and TAG on their own (for U and O).
 */
interface CodonClasses {
  /** Class (0 .. count - 1) of every codon key whose three masks are non-zero. */
  readonly ofKey: Uint8Array;
  /** Per class: character code of the translation. */
  readonly residue: readonly number[];
  /** Per class: true when every codon its members may stand for is a stop codon of the table. */
  readonly stop: readonly boolean[];
  /** Per class: 'TGA' or 'TAG' for the class made of that codon alone, '' otherwise. */
  readonly codon: readonly string[];
}

const codonClassCache = new Map<number, CodonClasses>();

/** The codon classes of a genetic code, built on first use and cached (at most 28 for any NCBI table). */
function codonClassesOf(cc: CompiledGeneticCode): CodonClasses {
  const cached = codonClassCache.get(cc.code.id);
  if (cached !== undefined) return cached;
  const ofKey = new Uint8Array(4096);
  const residue: number[] = [];
  const stop: boolean[] = [];
  const codon: string[] = [];
  const bySignature = new Map<string, number>();
  for (let m1 = 1; m1 < 16; m1++) {
    for (let m2 = 1; m2 < 16; m2++) {
      for (let m3 = 1; m3 < 16; m3++) {
        const key = codonKey(m1, m2, m3);
        const recoded = key === TGA_KEY ? 'TGA' : key === TAG_KEY ? 'TAG' : '';
        const signature = `${cc.aa[key]} ${cc.stop[key]} ${recoded}`;
        let c = bySignature.get(signature);
        if (c === undefined) {
          c = residue.length;
          bySignature.set(signature, c);
          residue.push(cc.aa[key]);
          stop.push(cc.stop[key] === 1);
          codon.push(recoded);
        }
        ofKey[key] = c;
      }
    }
  }
  const classes: CodonClasses = { ofKey, residue, stop, codon };
  codonClassCache.set(cc.code.id, classes);
  return classes;
}

/**
 * Whether peptide letter `letter` (upper case, a key of PEPTIDE_MATCHES) matches the codons of class
 * `c`: U and O the recoded codon TGA / TAG whatever the table translates it to; '*' codons that are
 * stop codons of the table in every expansion; the other letters by translation.
 */
function letterMatchesClass(letter: string, classes: CodonClasses, c: number): boolean {
  const recoded = RECODED_CODON[letter];
  if (recoded !== undefined) return classes.codon[c] === recoded;
  if (letter === '*') return classes.stop[c];
  return PEPTIDE_MATCHES[letter].includes(String.fromCharCode(classes.residue[c]));
}

/** Upper-cased peptide letter at `i`: only ASCII a-z are folded (String#toUpperCase maps 'ı' to 'I'). */
function peptideLetter(peptide: string, i: number): string {
  const c = peptide.charCodeAt(i);
  return c >= 0x61 && c <= 0x7a ? String.fromCharCode(c - 0x20) : peptide[i];
}

/** accept[i * classes.residue.length + c] = 1 when peptide position i matches the codons of class c. */
function peptideAcceptTable(peptide: string, classes: CodonClasses): Uint8Array {
  const count = classes.residue.length;
  const acc = new Uint8Array(peptide.length * count);
  for (let i = 0; i < peptide.length; i++) {
    const letter = peptideLetter(peptide, i);
    if (PEPTIDE_MATCHES[letter] === undefined) {
      throw new RangeError(
        `Invalid character '${characterAt(peptide, i)}' at index ${i} of the peptide; ` +
          `expected an amino-acid letter or '*'`,
      );
    }
    for (let c = 0; c < count; c++) acc[i * count + c] = letterMatchesClass(letter, classes, c) ? 1 : 0;
  }
  return acc;
}

/**
 * Six-frame translated search: find where a peptide is encoded, on either strand and in any frame.
 *
 * Codons are translated with the genetic code exactly like {@link translate} (ambiguous codons give
 * X/B/Z/J or an amino acid, context-dependent stop codons give their amino acid). A window of 3n
 * bases (n = peptide length) matches when every peptide letter matches its codon:
 *   - an amino-acid letter matches codons translated to it; B = D/N, Z = E/Q, J = I/L (and the
 *     translated ambiguity letter itself); X = any amino acid, not a stop codon;
 *   - '*' matches a stop codon of the table (every codon an ambiguous triplet may stand for must be
 *     one), including the context-dependent stop codons of tables 27, 28 and 31, which also match
 *     their amino acid (TGA in table 27 matches both W and '*');
 *   - U (selenocysteine) matches the codon TGA and O (pyrrolysine) the codon TAG, the stop codons that
 *     recoding reads as these amino acids, whatever the table translates them to (so a selenoprotein
 *     sequence from UniProt finds its own mRNA); ambiguous codons such as TGR do not match them.
 * Peptide letters are case-insensitive (ASCII). Ranges are DNA top-strand coordinates of the coding
 * bases (circular molecules: windows may cross the origin, end > L). Sorted by start, then strand
 * (1 first), then end.
 *
 * @throws TranslationError when the sequence contains a non-IUPAC character.
 * @throws RangeError for an invalid peptide character (the message names it and its 0-based UTF-16
 *   index) or an unknown table.
 */
export function searchProtein(
  seq: string,
  topology: Topology,
  peptide: string,
  options: ProteinSearchOptions = {},
): ProteinSearchHit[] {
  const table = options.table ?? 1;
  if (!Number.isInteger(table)) throw new RangeError(`table must be an integer NCBI id, got ${table}`);
  const classes = codonClassesOf(compileGeneticCode(table));
  const classCount = classes.residue.length;
  const accept = peptideAcceptTable(peptide, classes);
  const n = peptide.length;
  const width = 3 * n;
  const L = seq.length;
  const circular = topology === 'circular';
  const top = encodeNucleotides(seq, true);
  if (n === 0 || width > L) return [];

  const hits: ProteinSearchHit[] = [];
  for (const strand of [1, -1] as const) {
    const s = withWrap(strand === 1 ? top : reverseComplementMasks(top), circular ? width - 1 : 0);
    for (let frame = 0; frame < 3; frame++) {
      const codons = Math.floor((s.length - frame) / 3);
      const codonClass = new Uint8Array(Math.max(0, codons));
      for (let c = 0; c < codons; c++) {
        const x = frame + 3 * c;
        codonClass[c] = classes.ofKey[(s[x] << 8) | (s[x + 1] << 4) | s[x + 2]];
      }
      for (let q = 0; q + n <= codons; q++) {
        const local = frame + 3 * q;
        if (local >= L) break; // circular: windows starting in the wrapped copy are duplicates
        let ok = true;
        for (let i = 0; i < n; i++) {
          if (accept[i * classCount + codonClass[q + i]] === 0) {
            ok = false;
            break;
          }
        }
        if (!ok) continue;
        let start = local;
        if (strand === -1) {
          start = L - local - width;
          if (start < 0) start += L;
        }
        hits.push({ range: { start, end: start + width }, strand, mismatches: 0, frame: (local % 3) as 0 | 1 | 2 });
      }
    }
  }
  hits.sort((a, b) => a.range.start - b.range.start || b.strand - a.strand || a.range.end - b.range.end);
  return hits;
}
