/**
 * The GenBank LOCUS line: token-based reading and standard-column writing.
 *
 * Layout source: NCBI GenBank release notes (gbrel.txt, release 273.0), section 3.4.4
 * "LOCUS Format". NCBI recommends token-based parsing (3.4.4.1) because long accessions and
 * lengths shift the historical columns:
 *
 *   columns (1-based)  contents
 *   01-05              LOCUS
 *   13-28              locus name, left-justified
 *   30-40              sequence length, right-justified
 *   42-43              'bp' (or 'aa' for protein records)
 *   45-47              strandedness: blank, ss-, ds- or ms-
 *   48-53              molecule type: NA, DNA, RNA, tRNA, rRNA, mRNA, uRNA, cRNA, ...
 *   56-63              'linear' or 'circular' (blank in old records = linear)
 *   65-67              division code (PRI, ROD, ..., SYN, ...)
 *   69-79              date, DD-MMM-YYYY
 */
import type { MoleculeType, RecordMeta, Topology } from '../types';

/** Fields found on a LOCUS line. Absent fields are undefined. */
export interface LocusFields {
  /** Locus name (tokens before the length, joined with single spaces when there are several). */
  name: string;
  /** Declared sequence length (bases or residues). */
  length?: number;
  /** Length unit: 'bp' (nucleotides), 'aa' (protein) or the obsolete 'rc'. */
  unit?: 'bp' | 'aa' | 'rc';
  /** Molecule token exactly as written, e.g. 'DNA', 'ds-DNA', 'mRNA', 'cRNA'. */
  moleculeToken?: string;
  topology?: Topology;
  /** Three-letter division code, e.g. 'SYN'. */
  division?: string;
  /** Date token as written, e.g. '07-AUG-2008'. */
  date?: string;
}

/** Division codes of GenBank release notes 3.4.4.2 plus 'UNK' (written by Biopython for "unknown"). */
export const GENBANK_DIVISIONS: readonly string[] = Object.freeze([
  'PRI', 'ROD', 'MAM', 'VRT', 'INV', 'PLN', 'BCT', 'VRL', 'PHG', 'SYN',
  'UNA', 'EST', 'PAT', 'STS', 'GSS', 'HTG', 'HTC', 'ENV', 'CON', 'TSA', 'UNK',
]);

/** EMBL division codes and their GenBank equivalents (as mapped by Biopython's GenBank writer). */
const EMBL_DIVISIONS: ReadonlyMap<string, string> = new Map([
  ['FUN', 'PLN'],
  ['HUM', 'PRI'],
  ['MUS', 'ROD'],
  ['PRO', 'BCT'],
  ['UNC', 'UNK'],
  ['XXX', 'UNK'],
]);

/** Division used for records without one: HHereditas documents are mostly synthetic constructs. */
const DEFAULT_DIVISION = 'SYN';

/**
 * Division code to write for a record: its own when it is a known GenBank code, the GenBank
 * equivalent of an EMBL code, else 'SYN'.
 */
export function locusDivision(meta: RecordMeta): string {
  const division = meta.division?.trim().toUpperCase() ?? '';
  if (GENBANK_DIVISIONS.includes(division)) return division;
  return EMBL_DIVISIONS.get(division) ?? DEFAULT_DIVISION;
}

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

const UNIT_RE = /^(bp|aa|rc)$/i;
const INTEGER_RE = /^\d+$/;
const TOPOLOGY_RE = /^(linear|circular)$/i;
const DATE_RE = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/;
const DIVISION_RE = /^[A-Z]{3}$/;
/** Molecule tokens: optional strandedness prefix, then a name ending in DNA/RNA, or plain NA. */
const MOLECULE_RE = /^(?:(?:ss|ds|ms)-)?(?:[A-Za-z]*(?:DNA|RNA)|NA)$/i;

/**
 * Molecule category of a LOCUS molecule token, following Biopython 1.88
 * (`Bio.GenBank._FeatureConsumer.record_end`): tokens containing DNA, and mRNA (GenBank stores
 * mRNA records as cDNA, with T not U), are 'DNA'; other RNA tokens (RNA, tRNA, rRNA, cRNA, ...)
 * are 'RNA'; 'NA' (unspecified nucleic acid) is 'DNA'. Returns undefined for unknown tokens.
 */
export function moleculeTypeOfToken(token: string): MoleculeType | undefined {
  const t = token.toUpperCase();
  if (t.includes('DNA') || t.includes('MRNA')) return 'DNA';
  if (t.includes('RNA')) return 'RNA';
  if (/^(?:(?:SS|DS|MS)-)?NA$/.test(t)) return 'DNA';
  if (t === 'PROTEIN' || t === 'AA') return 'protein';
  return undefined;
}

/**
 * Normalize a GenBank date to DD-MMM-YYYY (upper-case month, two-digit day).
 * Returns undefined when `date` is not a valid date in that format.
 */
export function normalizeGenbankDate(date: string): string | undefined {
  const m = DATE_RE.exec(date.trim());
  if (!m) return undefined;
  const day = Number(m[1]);
  const month = m[2].toUpperCase();
  if (day < 1 || day > 31 || !MONTHS.includes(month)) return undefined;
  return `${String(day).padStart(2, '0')}-${month}-${m[3]}`;
}

/** A calendar date (local time) as DD-MMM-YYYY. */
export function formatGenbankDate(d: Date): string {
  return `${String(d.getDate()).padStart(2, '0')}-${MONTHS[d.getMonth()]}-${d.getFullYear()}`;
}

/**
 * Read a LOCUS line by whitespace-separated tokens (old and new column layouts, long names
 * that break the columns, missing fields). Unknown tokens produce warnings.
 *
 * @param line the full LOCUS line (starting with 'LOCUS')
 */
export function parseLocusLine(line: string): { fields: LocusFields; warnings: string[] } {
  const warnings: string[] = [];
  const tokens = line.trim().split(/\s+/).slice(1); // drop the LOCUS keyword
  const fields: LocusFields = { name: '' };
  let rest: string[];

  let unitAt = -1;
  for (let k = 1; k < tokens.length; k++) {
    if (UNIT_RE.test(tokens[k]) && INTEGER_RE.test(tokens[k - 1])) {
      unitAt = k;
      break;
    }
  }
  if (unitAt >= 0) {
    fields.name = tokens.slice(0, unitAt - 1).join(' ');
    fields.length = Number(tokens[unitAt - 1]);
    fields.unit = tokens[unitAt].toLowerCase() as LocusFields['unit'];
    rest = tokens.slice(unitAt + 1);
  } else {
    fields.name = tokens[0] ?? '';
    rest = tokens.slice(1);
    const lengthAt = rest.findIndex((t) => INTEGER_RE.test(t));
    if (lengthAt >= 0) {
      fields.length = Number(rest[lengthAt]);
      rest.splice(lengthAt, 1);
    }
    warnings.push(
      fields.length === undefined
        ? 'LOCUS line has no sequence length'
        : "LOCUS line has no length unit ('bp' or 'aa')",
    );
  }
  if (fields.name === '') warnings.push('LOCUS line has no locus name');

  const unknown: string[] = [];
  for (const t of rest) {
    if (TOPOLOGY_RE.test(t)) fields.topology = t.toLowerCase() as Topology;
    else if (DATE_RE.test(t)) fields.date = t;
    else if (MOLECULE_RE.test(t)) fields.moleculeToken = t;
    else if (DIVISION_RE.test(t)) fields.division = t;
    else unknown.push(t);
  }
  if (unknown.length > 0) warnings.push(`unrecognised LOCUS field(s): ${unknown.join(' ')}`);
  return { fields, warnings };
}

/** Everything {@link formatLocusLine} needs, already resolved by the writer. */
export interface LocusLineInput {
  name: string;
  length: number;
  unit: 'bp' | 'aa';
  /** Molecule token, e.g. 'DNA', 'ds-DNA', 'mRNA'; '' for protein records. At most 7 characters after the prefix. */
  moleculeToken: string;
  topology: Topology;
  /** Three-letter division code. */
  division: string;
  /** DD-MMM-YYYY. */
  date: string;
}

/**
 * Write a LOCUS line in the standard column layout (79 characters for names up to 16
 * characters and lengths that fit). A name too long for its column is followed by one space and
 * the length, shifting the other fields right (gbrel.txt 3.4.4.1). Whitespace in the name
 * becomes '_'; an empty name becomes 'Untitled'.
 */
export function formatLocusLine(input: LocusLineInput): string {
  const name = input.name.trim().replace(/\s+/g, '_') || 'Untitled';
  const length = String(input.length);
  // Columns 13-40: name left-justified, length right-justified, at least one space between.
  const nameAndLength = name.length + 1 + length.length <= 28 ? name + length.padStart(28 - name.length) : `${name} ${length}`;
  let strandedness = '   ';
  let molecule = input.moleculeToken;
  const prefixed = /^(ss-|ds-|ms-)(.+)$/i.exec(molecule);
  if (prefixed) {
    strandedness = prefixed[1].toLowerCase();
    molecule = prefixed[2];
  }
  return (
    `LOCUS       ${nameAndLength} ${input.unit} ${strandedness}${molecule.padEnd(7)} ` +
    `${input.topology.padEnd(8)} ${input.division} ${input.date}`
  );
}
