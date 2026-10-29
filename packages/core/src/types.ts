/**
 * Core data model shared by every module of HHereditas.
 *
 * COORDINATE CONVENTIONS — every module and every UI component relies on these.
 *
 * 1. Positions are 0-based. A {@link Range} is half-open: [start, end).
 *    Its length is `end - start`.
 *
 * 2. Linear molecules of length L: 0 <= start <= end <= L.
 *
 * 3. Circular molecules of length L: a range that crosses the origin is written
 *    with `end > L`. Example: on a 5000 bp plasmid the 200 bp region made of
 *    bases 4900..4999 followed by 0..99 is `{ start: 4900, end: 5100 }`.
 *    Normalized form: 0 <= start < L and start <= end <= start + L.
 *    The whole circle is `{ start: 0, end: L }` (or any `{ start: s, end: s + L }`).
 *    Use the helpers in `seq/range.ts` instead of doing this arithmetic by hand.
 *
 * 4. A "gap position" (cut site, insertion point, caret) is an integer p in [0, L]
 *    meaning the boundary between base p-1 and base p. On circular molecules
 *    gap positions are taken modulo L (0 and L are the same gap).
 *
 * 5. Strand: 1 = top/forward, -1 = bottom/reverse, 0 = none/unknown.
 *
 * 6. Nucleotide sequences are stored as UPPERCASE IUPAC strings
 *    (A C G T, plus the ambiguity codes R Y S W K M B D H V N). Parsers
 *    upper-case on import. 'U' is converted to 'T' for DNA records.
 *    Protein sequences use the 20 standard one-letter codes plus '*' for stop
 *    and X for unknown.
 */

export type Strand = 1 | -1 | 0;
export type Topology = 'linear' | 'circular';
export type MoleculeType = 'DNA' | 'RNA' | 'protein';

/** Half-open, 0-based interval [start, end). See the coordinate conventions above. */
export interface Range {
  start: number;
  end: number;
}

/** One GenBank-style qualifier, e.g. `/label="AmpR"`. `value` is null for value-less qualifiers like `/pseudo`. */
export interface Qualifier {
  key: string;
  value: string | null;
}

/**
 * An annotated region of a sequence.
 *
 * `segments` lists the pieces of the feature in the order they are joined on the TOP strand
 * (exactly like the ranges inside a GenBank `join(...)` with any outer `complement(...)` removed).
 * The feature's own 5'->3' sequence is therefore:
 *   strand  1 (or 0): concat(top-strand sequence of each segment, in array order)
 *   strand -1:        reverseComplement(concat(top-strand sequence of each segment, in array order))
 * Most features have exactly one segment. Each segment is a valid {@link Range} for the parent
 * sequence (on circular sequences a segment may wrap the origin, i.e. end > length).
 */
export interface Feature {
  /** Unique within its record. Not persisted to GenBank; regenerated on import. */
  id: string;
  /** INSDC feature key: 'CDS', 'promoter', 'rep_origin', 'misc_feature', 'primer_bind', ... */
  type: string;
  /** Display label. Parsers derive it from /label, /gene, /product, /note, ... (see `featureLabel`). */
  name: string;
  strand: Strand;
  segments: Range[];
  /** All qualifiers in file order (including the one the name was derived from). */
  qualifiers: Qualifier[];
  /** Display colour as '#rrggbb'. Undefined means "use the default colour for this feature type". */
  color?: string;
  /** Optional per-direction colour override for the reverse strand (ApE files carry both). */
  reverseColor?: string;
  /**
   * Drawn with an arrow head at both ends (SnapGene's directionality 3). A marker for the eye only: the feature
   * has no strand of its own (`strand` is 0), so nothing is translated or read from it in one direction.
   */
  bidirectional?: boolean;
  /** True if the start / end of the feature is fuzzy in the source file (`<1..`, `..>100`). */
  partialStart?: boolean;
  partialEnd?: boolean;
}

/**
 * An oligonucleotide stored with a sequence document.
 * Binding sites are NOT stored — they are computed (see `primers/binding.ts`), because
 * they change whenever the sequence is edited.
 */
export interface Primer {
  id: string;
  name: string;
  /** 5'->3' oligo sequence, uppercase IUPAC. May contain a 5' tail that does not anneal. */
  sequence: string;
  description?: string;
  /** Not drawn on the maps or the sequence view (SnapGene `visible="0"`). Absent means shown. */
  hidden?: boolean;
}

/** Kind of single-stranded end of a linear double-stranded molecule. */
export type EndKind = 'blunt' | '5prime' | '3prime';

/**
 * One end of a linear double-stranded DNA molecule.
 * `length` is the number of unpaired bases (0 for blunt).
 */
export interface DnaEnd {
  kind: EndKind;
  length: number;
}

/**
 * Single-stranded ends of a linear double-stranded molecule.
 *
 * The record's `seq` always spans the FULL extent of the duplex (union of both strands),
 * written in top-strand orientation. Bases that exist on only one strand are written as
 * their top-strand equivalent (i.e. the complement of a bottom-only base).
 *
 *   left  '5prime' n : the first n bases of `seq` exist only on the TOP strand
 *                      (the top strand's 5' end protrudes).
 *   left  '3prime' n : the first n bases exist only on the BOTTOM strand
 *                      (the bottom strand's 3' end protrudes).
 *   right '5prime' n : the last n bases exist only on the BOTTOM strand
 *                      (the bottom strand's 5' end protrudes).
 *   right '3prime' n : the last n bases exist only on the TOP strand
 *                      (the top strand's 3' end protrudes).
 *
 * Example — EcoRI (G^AATTC) cutting ...xxGAATTCyy... gives a left product ending
 * "...xxGAATT" with right end {kind:'5prime', length:4} and a right product starting
 * "AATTCyy..." with left end {kind:'5prime', length:4}. Two ends are compatible for
 * ligation when they have the same kind and length and identical overhang text
 * (the `length` last bases of the left molecule == the `length` first bases of the right one).
 */
export interface FragmentEnds {
  left: DnaEnd;
  right: DnaEnd;
}

export type SourceFormat = 'genbank' | 'fasta' | 'snapgene' | 'raw' | 'embl' | 'unknown';

export interface RecordMeta {
  /** GenBank ACCESSION / VERSION / KEYWORDS, if any. */
  accession?: string;
  version?: string;
  keywords?: string;
  /** SOURCE line and ORGANISM. */
  source?: string;
  organism?: string;
  /** Date as written in the LOCUS line (e.g. '07-AUG-2008'). */
  date?: string;
  /** GenBank division (e.g. 'SYN', 'BCT'). */
  division?: string;
  /** COMMENT blocks / free-text notes. */
  comments?: string[];
  /**
   * Header lines that the GenBank parser does not model (REFERENCE blocks, DBLINK, ...),
   * kept verbatim so a GenBank -> GenBank round trip is lossless.
   */
  extraHeaderLines?: string[];
  /** Which file format this record was read from. */
  sourceFormat?: SourceFormat;
  /** Free-form extra key/value data from the source file (e.g. SnapGene notes fields). */
  extras?: Record<string, string>;
}

/**
 * A sequence or Sanger trace aligned to a reference DNA record
 * (reconstructed from SnapGene.exe 0x142485905..0x14248e8e6:
 * Packet 0x11 `<AlignableSequences>`, Packet 0x10 embedded sequence/trace,
 * and Packet 0x1B BGZF-compressed BAM alignment).
 */
export interface AlignedSequence {
  /** Unique ID within the document (matches `<Sequence ID="...">` and BAM read_name). */
  id: string;
  /** Display name (`<Sequence name="...">`). */
  name: string;
  /** Original 5'->3' query sequence (uppercase IUPAC). */
  sequence: string;
  /** True if imported from a chromatogram trace (.ab1 / .scf / .ztr, `isTrace="1"`). */
  isTrace?: boolean;
  /** Display order in the "Align with:" list (`sortOrder`). */
  sortOrder: number;
  /** Whether this sequence is checked / visible in the "Align with:" panel (`use="1"` / `use="0"`). */
  visible: boolean;
  /** Trimmed range on the query sequence (0-based half-open; in SnapGene XML 1-based `trimmedRange="a..b"`). */
  trimmedRange?: Range;
  /** True if `trimmedRange` was manually adjusted (`manuallyTrimmed="1"`). */
  manuallyTrimmed?: boolean;
  /** Whether the query aligned to the reference (`true` when `refRange` is valid). */
  aligned: boolean;
  /** 1 = forward strand, -1 = reverse strand (BAM flag 0x10). */
  strand: 1 | -1;
  /** Aligned footprint on the reference sequence (0-based half-open, may wrap origin on circular records). */
  refRange: Range;
  /** Unaligned 5'-most and 3'-most soft-clipped/trimmed tail lengths in bp (drawn as dotted extensions on the map). */
  leftTail: number;
  rightTail: number;
  /** CIGAR string (e.g. `"2S14M1I974M"`) in reference orientation. */
  cigar: string;
  /** 0-based reference positions where a mismatch, insertion, or deletion occurs (for map tick marks and sequence highlighting). */
  mismatches: number[];
  /** Base-by-base aligned string on the reference top strand across `refRange` (length = `refRange.end - refRange.start`, with `'-'` for deletions). */
  alignedBases: string;
  /** Match identity percentage (0..100). */
  identity: number;
  /** Phred quality per base of `sequence` (chromatogram reads). */
  quality?: number[];
  /** Chromatogram of a trace read, in the orientation of `sequence`. */
  trace?: ChromatogramTrace;
  /** Date the read was run (ISO `YYYY-MM-DD`), when the trace file records it. */
  runDate?: string;
}

/** Sanger chromatogram: four signal channels and the peak of every called base. */
export interface ChromatogramTrace {
  /** Signal per sample for A, C, G and T (all the same length). */
  a: number[];
  c: number[];
  g: number[];
  t: number[];
  /** Sample index of the peak of each called base (one per base of the read). */
  peaks: number[];
}

/** A sequence document: the central object the application edits and displays. */
export interface SeqRecord {
  /** Unique id for the open document (not persisted to GenBank). */
  id: string;
  /** Short name (GenBank LOCUS name, FASTA id, or file name). */
  name: string;
  /** One-line description (GenBank DEFINITION, FASTA description). */
  description: string;
  /** Nucleotide (or protein) sequence; see conventions at the top of this file. */
  seq: string;
  topology: Topology;
  molecule: MoleculeType;
  features: Feature[];
  primers: Primer[];
  /** Sequences or Sanger traces aligned to this reference molecule (`Align with:` panel & Packet 0x10/0x11/0x1B). */
  alignedSequences?: AlignedSequence[];
  /** Single-stranded ends; only meaningful for linear double-stranded DNA. Absent = both blunt. */
  ends?: FragmentEnds;
  meta: RecordMeta;
}

// ---------------------------------------------------------------------------
// Analysis results shared between the engine and the UI
// ---------------------------------------------------------------------------

/** A pair of cut positions produced by one cleavage event of a restriction enzyme. */
export interface CutPair {
  /** Gap position (see conventions) of the cut on the top strand, normalized into [0, L) for circular, [0, L] for linear. */
  top: number;
  /** Gap position of the cut on the bottom strand, expressed in TOP-strand coordinates, same normalization. */
  bottom: number;
}

/** One occurrence of an enzyme recognition sequence in a molecule. */
export interface EnzymeSite {
  enzyme: string;
  /** The recognition sequence's footprint on the molecule (may wrap the origin on circular molecules). */
  range: Range;
  /** 1 if the recognition sequence reads 5'->3' on the top strand, -1 if it was found on the bottom strand. */
  strand: 1 | -1;
  /**
   * Cleavage events for this occurrence (usually exactly one; two for enzymes such as BaeI that cut
   * on both sides of their site). Cuts that would fall outside a linear molecule are omitted, so this
   * can be empty: the site is recognised but not cleaved.
   */
  cuts: CutPair[];
}

/** Where (part of) a primer anneals to a template. */
export interface PrimerBindingSite {
  primerId: string;
  /** 1 = primer anneals to the bottom strand and extends rightwards (forward primer); -1 = reverse primer. */
  strand: 1 | -1;
  /** Region of the template (top-strand coordinates) covered by the annealing part of the primer. */
  range: Range;
  /** Number of primer bases (counted from the 3' end) that anneal, i.e. range length. */
  annealedLength: number;
  /** Number of mismatches inside the annealed region. */
  mismatches: number;
  /** Length of the 5' tail that does not anneal (primer.sequence.length - annealedLength). */
  tailLength: number;
  /** Melting temperature (°C) of the annealed part, if computed. */
  tm?: number;
}

/** An open reading frame. */
export interface Orf {
  /** Region from first base of start codon to last base of stop codon (inclusive), top-strand coordinates. */
  range: Range;
  strand: 1 | -1;
  /** Reading frame 0, 1 or 2 relative to the start of the sequence (for strand -1: relative to the end). */
  frame: 0 | 1 | 2;
  /** Length in amino acids, excluding the stop codon. */
  aaLength: number;
  /** True if the ORF ends with a stop codon (false when it runs off the end of a linear sequence). */
  hasStop: boolean;
}

/** One hit of a sequence search. */
export interface SearchHit {
  range: Range;
  strand: 1 | -1;
  mismatches: number;
}
