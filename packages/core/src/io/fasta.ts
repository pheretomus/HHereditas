/**
 * FASTA reader and writer.
 *
 * Format (Pearson FASTA, as accepted by NCBI BLAST and Biopython's "fasta-pearson"): a record
 * starts with a '>' header line whose first word is the identifier and whose remainder is a
 * free-text description; the following lines hold the residues. Lines starting with ';' are
 * comments. NCBI's FASTA modifier `[topology=circular]` (NCBI "FASTA definition line
 * modifiers", https://www.ncbi.nlm.nih.gov/genbank/mods_fastadefline/) gives the topology.
 * Cross-checked against Biopython 1.88 `Bio.SeqIO` "fasta-pearson" (genbank-fasta tests).
 */
import type { MoleculeType, SeqRecord, Topology } from '../types';
import type { ParseResult, ParseWarning } from './types';
import { makeRecord } from '../seq/features';
import { cleanResidues, describeInvalid, detectMolecule } from './genbank-sequence';
import { splitTextLines } from './genbank-text';

/** Options of {@link writeFasta}. */
export interface FastaWriteOptions {
  /** Residues per line (default 70). 0, a negative number or Infinity writes each sequence on one line. */
  lineWidth?: number;
}

/**
 * `[topology=circular]` / `[topology=linear]` anywhere in a header (case-insensitive). The
 * pattern starts with the literal '[': a leading `\s*` would rescan every run of blanks from
 * each of its positions (quadratic time on long blank runs); the blanks before a modifier are
 * removed separately (see `removeTopologyModifiers`).
 */
const TOPOLOGY_MODIFIER = /\[\s*topology\s*=\s*(circular|linear)\s*\]/gi;
/** Alignment gap characters, removed from FASTA sequences (FASTA has no coordinates to keep). */
const GAPS = /[-.]/g;

interface RawFastaRecord {
  header: string;
  /** 1-based line number of the header. */
  line: number;
  /** Residue text of each sequence line (digits and white space removed) with its line number. */
  parts: string[];
  partLines: number[];
}

/**
 * Read every record of a FASTA file. Never throws.
 *
 * Header: name = first word after '>', description = the rest (trimmed). A
 * `[topology=circular]` or `[topology=linear]` modifier sets the topology and is removed from
 * the description (default linear). Sequence lines: white space and digits are ignored, case
 * is folded to upper; gap characters '-' and '.' are removed with a warning. The molecule type
 * is detected from the residues: letters that only occur in proteins (E F I J L O P Q Z) mean
 * protein, U without T means RNA, otherwise DNA (U converted to T). A nucleotide record's final
 * '*' terminator is dropped with a warning. Other invalid characters become N (protein: X) with
 * a warning, so the sequence length is preserved. ';' comment lines and blank lines are
 * ignored; records with no residues are allowed. Text before the first '>' line is ignored with
 * a warning; text without any '>' header gives `records: []` and a warning. Line endings may be
 * \n, \r\n or \r; byte-order marks are ignored at the start of any line (concatenated files).
 * Warnings carry 1-based line numbers and the record index.
 */
export function parseFasta(text: string): ParseResult {
  const lines = splitTextLines(text);
  const warnings: ParseWarning[] = [];
  const raws: RawFastaRecord[] = [];
  let stray = 0;
  let firstStray = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('>')) {
      raws.push({ header: line.slice(1).trim(), line: i + 1, parts: [], partLines: [] });
      continue;
    }
    if (line.startsWith(';')) continue;
    const residues = line.replace(/[\s\d]+/g, '');
    if (residues === '') continue;
    const current = raws[raws.length - 1];
    if (current === undefined) {
      if (stray === 0) firstStray = i + 1;
      stray++;
      continue;
    }
    current.parts.push(residues);
    current.partLines.push(i + 1);
  }

  if (raws.length === 0) {
    return { records: [], warnings: [{ message: "no FASTA header line ('>') found" }] };
  }
  if (stray > 0) {
    warnings.push({ message: `${stray} line(s) before the first '>' header were ignored`, line: firstStray });
  }
  const records = raws.map((raw, recordIndex) => {
    const warn = (message: string, line: number) => warnings.push({ message, line, recordIndex });
    return buildRecord(raw, warn);
  });
  return { records, warnings };
}

/**
 * The header without its NCBI `[topology=...]` modifiers (and the blanks just before each),
 * trimmed, and the topology they give (the last one wins; default linear). Linear time.
 */
function removeTopologyModifiers(header: string): { header: string; topology: Topology } {
  let topology: Topology = 'linear';
  let rest = '';
  let from = 0;
  for (const m of header.matchAll(TOPOLOGY_MODIFIER)) {
    rest += header.slice(from, m.index).trimEnd();
    topology = m[1].toLowerCase() as Topology;
    from = m.index + m[0].length;
  }
  return { header: (rest + header.slice(from)).trim(), topology };
}

function buildRecord(raw: RawFastaRecord, warn: (message: string, line: number) => void): SeqRecord {
  const { header, topology } = removeTopologyModifiers(raw.header);
  const space = header.search(/\s/);
  const name = space < 0 ? header : header.slice(0, space);
  const description = space < 0 ? '' : header.slice(space).trim();

  // Remove alignment gaps (and remember where the first one was).
  let gaps = 0;
  let gapLine = 0;
  const parts = raw.parts.map((p, k) => {
    const cleaned = p.replace(GAPS, '');
    if (cleaned.length !== p.length) {
      if (gaps === 0) gapLine = raw.partLines[k];
      gaps += p.length - cleaned.length;
    }
    return cleaned;
  });
  if (gaps > 0) warn(`${gaps} gap character(s) ('-' or '.') removed from the sequence`, gapLine);

  let residues = parts.join('');
  const molecule: MoleculeType = detectMolecule(residues);
  if (molecule !== 'protein' && residues.endsWith('*')) {
    residues = residues.slice(0, -1);
    warn("final '*' terminator removed from the nucleotide sequence", raw.partLines[raw.partLines.length - 1]);
  }
  const cleaned = cleanResidues(residues, molecule);
  if (cleaned.invalid.size > 0) {
    let offset = cleaned.firstInvalidIndex;
    let k = 0;
    while (k < parts.length - 1 && offset >= parts[k].length) offset -= parts[k++].length;
    warn(
      `invalid character(s) replaced by ${molecule === 'protein' ? 'X' : 'N'}: ${describeInvalid(cleaned.invalid)}`,
      raw.partLines[k] ?? raw.line,
    );
  }
  if (molecule === 'DNA' && /u/i.test(residues)) warn('U converted to T in a DNA sequence', raw.line);

  return makeRecord({
    name: name === '' ? undefined : name,
    description,
    seq: cleaned.seq,
    topology,
    molecule,
    meta: { sourceFormat: 'fasta' },
  });
}

/**
 * Write one or more records as FASTA ('\n' line endings, final newline; '' for no records).
 *
 * Header: `>name description`, white space in the name replaced by '_' (the name must be a
 * single word), line breaks in the description replaced by spaces; circular records get the NCBI
 * modifier ` [topology=circular]`. `[topology=...]` modifiers already present in the name or
 * description are removed: a reader (this one, NCBI tools) would take them for the topology, so
 * a linear record would be read back as circular. The sequence is written as stored (upper
 * case), wrapped at `lineWidth` residues per line (default 70). Features, primers and other
 * metadata cannot be represented in FASTA and are not written.
 */
export function writeFasta(records: SeqRecord | readonly SeqRecord[], options: FastaWriteOptions = {}): string {
  const list: readonly SeqRecord[] = 'seq' in records ? [records] : records;
  const requested = options.lineWidth ?? 70;
  const width = Number.isFinite(requested) && requested >= 1 ? Math.floor(requested) : 0;
  const out: string[] = [];
  for (const record of list) {
    let header = '>' + (removeTopologyModifiers(record.name).header.replace(/\s+/g, '_') || 'Untitled');
    const description = removeTopologyModifiers(record.description.replace(/[\r\n]+/g, ' ')).header;
    if (description !== '') header += ' ' + description;
    if (record.topology === 'circular') header += ' [topology=circular]';
    out.push(header);
    const seq = record.seq;
    if (width === 0) {
      if (seq !== '') out.push(seq);
    } else {
      for (let i = 0; i < seq.length; i += width) out.push(seq.slice(i, i + width));
    }
  }
  return out.length === 0 ? '' : out.join('\n') + '\n';
}
