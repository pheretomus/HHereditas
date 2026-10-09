/**
 * GenBank flat-file reader and writer.
 *
 * Format sources: NCBI GenBank release notes (gbrel.txt, release 273.0) section 3.4 and the
 * INSDC Feature Table Definition (https://www.insdc.org/submitting-standards/feature-table/).
 * Behaviour on malformed input is cross-checked against Biopython 1.88 (`Bio.SeqIO` "genbank"),
 * the oracle of the differential tests in `genbank-oracle.test.ts`.
 *
 * Coordinates: feature locations are converted to the 0-based half-open segments of
 * `types.ts` (see `location.ts`); origin-spanning features of circular records become one
 * segment with end > length.
 */
import type { Feature, MoleculeType, RecordMeta, SeqRecord, Topology } from '../types';
import type { ParseResult, ParseWarning } from './types';
import { featureLabel, makeRecord } from '../seq/features';
import { newId } from '../seq/id';
import { extractApeColors, formatFeature, indentation, readFeatureTable, type RawFeature, type WarnFn } from './genbank-features';
import { formatContig, formatHeader, GENBANK_EXTRA_KEYS, readHeader } from './genbank-header';
import {
  formatGenbankDate,
  formatLocusLine,
  locusDivision,
  moleculeTypeOfToken,
  normalizeGenbankDate,
  parseLocusLine,
  type LocusFields,
} from './genbank-locus';
import { cleanResidues, describeInvalid, detectMolecule, findUnlabelledSequenceBlock, formatOrigin } from './genbank-sequence';
import { appendAll, splitTextLines } from './genbank-text';
import { parseLocation } from './location';

export { GENBANK_EXTRA_KEYS } from './genbank-header';

/** Options of {@link writeGenbank}. */
export interface GenbankWriteOptions {
  /**
   * Write `Feature.color` / `Feature.reverseColor` as ApE qualifiers `/ApEinfo_fwdcolor` and
   * `/ApEinfo_revcolor` (read by ApE, SnapGene, Benchling, Geneious). Default true.
   * With false, no ApE colour qualifiers are written at all.
   */
  colorQualifiers?: boolean;
  /**
   * LOCUS date (DD-MMM-YYYY) used when the record has no valid `meta.date`.
   * Default: today's local date. Pass a fixed value for deterministic output.
   */
  date?: string;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** Leading tabs become spaces up to the next multiple of 8 (columns matter in GenBank files). */
function expandLeadingTabs(line: string): string {
  let column = 0;
  let i = 0;
  for (; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c === 32) column++;
    else if (c === 9) column = (Math.floor(column / 8) + 1) * 8;
    else break;
  }
  return ' '.repeat(column) + line.slice(i);
}

/**
 * Lines of the text: \n / \r\n / \r accepted, byte-order marks removed from the start of every
 * line (see `splitTextLines`), trailing blanks removed, leading tabs expanded.
 */
function splitLines(text: string): string[] {
  const lines = splitTextLines(text);
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].trimEnd();
    if (line.includes('\t')) line = expandLeadingTabs(line);
    lines[i] = line;
  }
  return lines;
}

const LOCUS_LINE = /^LOCUS(?:\s|$)/;
/** FEATURES belongs in column 1; up to 3 blanks are tolerated like for the header keywords. */
const FEATURES_LINE = /^ {0,3}FEATURES(?:\s|$)/;
const ORIGIN_LINE = /^ORIGIN(?:\s|$)/;
const CONTIG_LINE = /^CONTIG(?:\s|$)/;
/**
 * Lines that end the header: the feature table or one of the sections that follow it
 * (GenBank release notes 3.4.2 / 3.4.15; Biopython 1.88 `GenBankScanner.SEQUENCE_HEADERS`).
 */
const HEADER_END = /^(?: {0,3}FEATURES|ORIGIN|CONTIG|BASE COUNT|WGS|WGS_SCAFLD|TSA|TLS)(?:\s|$)/;
/**
 * Lines that end the feature table: the sections that follow it. Any other line belongs to
 * the table, even an unindented one (a stray line, or the rest of a value broken by a raw line
 * break): `readFeatureTable` deals with it, so that it cannot hide the features after it.
 */
const FEATURE_TABLE_END = /^(?:ORIGIN|CONTIG|BASE COUNT|WGS|WGS_SCAFLD|TSA|TLS)(?:\s|$)/;
/** Section lines after the feature table that carry no data we keep. */
const IGNORED_SECTION = /^(?:BASE COUNT|WGS|WGS_SCAFLD|TSA|TLS)(?:\s|$)/;
/** Lines that end an ORIGIN sequence block early. */
const SEQUENCE_END = /^(?:CONTIG|BASE COUNT|WGS|WGS_SCAFLD|TSA|TLS|ORIGIN|FEATURES)(?:\s|$)/;

/** End of a record: '//' in columns 1-2 (GenBank release notes 3.4.2; lines are already right-trimmed). */
const isTerminator = (line: string): boolean => line === '//';

/** True when one of `lines[start, end)` matches `pattern`. */
function hasLine(lines: readonly string[], start: number, end: number, pattern: RegExp): boolean {
  for (let k = start; k < end; k++) if (pattern.test(lines[k])) return true;
  return false;
}

/**
 * Text of the CONTIG section `lines[start, end)` (keyword line, then its continuation lines):
 * the data after the keyword, then the data of each continuation line from column 13, joined
 * without separators like Biopython 1.88 (`GenBankScanner._feed_misc_lines`).
 */
function readContig(lines: readonly string[], start: number, end: number): string {
  let text = lines[start].slice('CONTIG'.length).trim();
  for (let k = start + 1; k < end; k++) {
    const line = lines[k];
    if (line !== '') text += indentation(line) >= 12 ? line.slice(12) : line.trim();
  }
  return text;
}

/**
 * Largest N/X placeholder created for a record without sequence data (2^28 residues, more than
 * the longest human chromosome). Larger declared lengths (corrupt LOCUS lines) would exceed the
 * JavaScript string limit.
 */
const MAX_PLACEHOLDER_LENGTH = 2 ** 28;

/**
 * Read every record of a GenBank file. Never throws: malformed input gives best-effort
 * records plus warnings (1-based line numbers, record index). Text without any LOCUS line
 * gives `records: []` and one warning.
 *
 * Accepted: \n, \r\n and \r line endings, UTF-8 byte-order marks (also before later records, as
 * in concatenated files), tabs, trailing blanks, slightly wrong indentation, a missing '//'
 * terminator, a missing ORIGIN (the sequence becomes N, or X for proteins, with the LOCUS
 * length), CONTIG-only records (same placeholder, CONTIG text kept), multi-record files. Any
 * number of lines, features and warnings per record. Sequence lines whose ORIGIN keyword line is
 * missing are still read as the sequence (with a warning) when their numbering shows a complete
 * block (from base 1, each line continuing the previous one). Stray lines starting in column 1
 * inside the feature table are skipped with a warning (or read as the rest of a value broken by
 * a raw line break) and never hide the features after them; a feature key line that starts in
 * column 1 (a known INSDC key followed by its location, or the standard layout without its
 * indent) is read as a new feature, with a warning, so that its qualifiers are never attached
 * to the previous feature.
 *
 * Record fields: `name` = LOCUS name; `description` = DEFINITION without its final period;
 * `seq` upper-case (U -> T for DNA, U kept for RNA, 'aa' records are proteins); topology
 * 'linear' when the LOCUS line has none. `meta`: accession, version, keywords (without final
 * period), source, organism, date, division, comments (one entry per COMMENT block),
 * extraHeaderLines (REFERENCE, DBLINK, ... verbatim), extras (LOCUS molecule token, taxonomy
 * lineage and CONTIG text, see `GENBANK_EXTRA_KEYS`), sourceFormat 'genbank'.
 * Features: 0-based half-open segments in top-strand order; name = featureLabel(); ApE colour
 * qualifiers become `color` / `reverseColor`; protein features get strand 0.
 */
export function parseGenbank(text: string): ParseResult {
  const lines = splitLines(text);
  const warnings: ParseWarning[] = [];
  const records: SeqRecord[] = [];

  let i = 0;
  let ignored = 0;
  let firstIgnored = 0;
  const skipToLocus = () => {
    while (i < lines.length && !LOCUS_LINE.test(lines[i])) {
      if (lines[i] !== '' && !isTerminator(lines[i])) {
        if (ignored === 0) firstIgnored = i + 1;
        ignored++;
      }
      i++;
    }
    if (ignored > 0) {
      warnings.push({ message: `${ignored} line(s) outside any LOCUS ... // record were ignored`, line: firstIgnored });
      ignored = 0;
    }
  };

  skipToLocus();
  if (i >= lines.length) {
    return { records: [], warnings: [{ message: 'no LOCUS line found: this is not a GenBank file' }] };
  }
  while (i < lines.length) {
    const start = i;
    let end = i + 1;
    while (end < lines.length && !isTerminator(lines[end]) && !LOCUS_LINE.test(lines[end])) end++;
    const terminated = end < lines.length && isTerminator(lines[end]);
    const recordIndex = records.length;
    const recordWarnings: ParseWarning[] = [];
    const warn: WarnFn = (message, line) =>
      recordWarnings.push(line === undefined ? { message, recordIndex } : { message, line, recordIndex });
    if (!terminated) {
      let last = end - 1;
      while (last > start && lines[last] === '') last--;
      warn("record is not terminated by '//'", last + 1);
    }
    records.push(readRecord(lines, start, end, warn));
    // Features are resolved after the sequence is read: report everything in line order.
    recordWarnings.sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
    appendAll(warnings, recordWarnings);
    i = terminated ? end + 1 : end;
    skipToLocus();
  }
  return { records, warnings };
}

/** Molecule type from the LOCUS fields, falling back to the residues when the line says nothing. */
function moleculeOf(fields: LocusFields, residues: string, warn: WarnFn, line: number): MoleculeType {
  if (fields.unit === 'aa') return 'protein';
  if (fields.moleculeToken !== undefined) {
    const type = moleculeTypeOfToken(fields.moleculeToken);
    if (type !== undefined) return type;
    warn(`unknown molecule type '${fields.moleculeToken}' on the LOCUS line: read as DNA`, line);
    return 'DNA';
  }
  return fields.unit === undefined ? detectMolecule(residues) : 'DNA';
}

/** Parse the lines [start, end) of one record (LOCUS line first, '//' excluded). */
function readRecord(lines: readonly string[], start: number, end: number, warn: WarnFn): SeqRecord {
  const locus = parseLocusLine(lines[start]);
  for (const w of locus.warnings) warn(w, start + 1);
  const fields = locus.fields;

  // Sequence lines whose ORIGIN keyword line is missing (lost in editing or by a broken export)
  // are recognised by their numbering and read as the sequence. Otherwise they would be misread
  // line by line as header text or feature keys, and the sequence replaced by N.
  const unlabelled = hasLine(lines, start + 1, end, ORIGIN_LINE) ? undefined : findUnlabelledSequenceBlock(lines, start + 1, end);
  const bodyEnd = unlabelled?.start ?? end;

  // Header: up to FEATURES or a later section.
  let i = start + 1;
  while (i < bodyEnd && !HEADER_END.test(lines[i])) i++;
  const header = readHeader(lines, start + 1, i, warn);

  // Feature table: every line after FEATURES up to the next section (ORIGIN, CONTIG, ...).
  let rawFeatures: RawFeature[] = [];
  if (i < bodyEnd && FEATURES_LINE.test(lines[i])) {
    const tableStart = ++i;
    while (i < bodyEnd && !FEATURE_TABLE_END.test(lines[i])) i++;
    rawFeatures = readFeatureTable(lines, tableStart, i, warn);
  }

  // Sections after the feature table: ORIGIN (sequence), CONTIG, BASE COUNT, ...
  const residueParts: string[] = [];
  const residueLines: number[] = [];
  const readSequenceLine = (k: number) => {
    const residues = lines[k].replace(/[\s\d]+/g, '');
    if (residues !== '') {
      residueParts.push(residues);
      residueLines.push(k + 1);
    }
  };
  let sawOrigin = false;
  let sawContig = false;
  let contig: string | undefined;
  while (i < bodyEnd) {
    const line = lines[i];
    if (line === '') {
      i++;
    } else if (ORIGIN_LINE.test(line)) {
      sawOrigin = true;
      for (i++; i < bodyEnd && !SEQUENCE_END.test(lines[i]); i++) readSequenceLine(i);
    } else {
      // CONTIG (kept), BASE COUNT, WGS, ... or an unexpected section (skipped), with its
      // continuation lines.
      const sectionStart = i;
      i++;
      while (i < bodyEnd && (lines[i] === '' || lines[i].charCodeAt(0) === 32)) i++;
      if (CONTIG_LINE.test(line)) {
        sawContig = true;
        if (contig === undefined) contig = readContig(lines, sectionStart, i);
        else warn('repeated CONTIG section ignored', sectionStart + 1);
      } else if (!IGNORED_SECTION.test(line)) {
        warn(`unexpected line '${line.slice(0, 40)}' ignored`, sectionStart + 1);
      }
    }
  }
  if (unlabelled !== undefined) {
    sawOrigin = true;
    for (let k = unlabelled.start; k < unlabelled.end; k++) readSequenceLine(k);
    warn(
      `no ORIGIN line: the ${unlabelled.end - unlabelled.start} numbered sequence line(s) from line ` +
        `${unlabelled.start + 1} were read as the sequence`,
      unlabelled.start + 1,
    );
  }

  const raw = residueParts.join('');
  const molecule = moleculeOf(fields, raw, warn, start + 1);
  const unit = molecule === 'protein' ? 'aa' : 'bp';
  const placeholder = molecule === 'protein' ? 'X' : 'N';
  let seq: string;
  if (raw === '') {
    // No residues: keep the declared length so that the features still have a place (like
    // Biopython's undefined sequence of the LOCUS length).
    const declared = fields.length ?? 0;
    const n = declared <= MAX_PLACEHOLDER_LENGTH ? declared : 0;
    const why = sawContig
      ? 'CONTIG record: its sequence is assembled from other entries and is not in this file'
      : sawOrigin
        ? 'ORIGIN section without sequence data'
        : 'no ORIGIN sequence section';
    if (n > 0) warn(`${why}; the sequence was filled with ${n} ${placeholder} (LOCUS length)`, start + 1);
    else if (declared > 0) warn(`${why}; the LOCUS length ${declared} is too large for a placeholder: empty sequence`, start + 1);
    else if (!sawOrigin) warn(`${why}; the record has an empty sequence`, start + 1);
    seq = placeholder.repeat(n);
  } else {
    const cleaned = cleanResidues(raw, molecule);
    seq = cleaned.seq;
    if (cleaned.invalid.size > 0) {
      let offset = cleaned.firstInvalidIndex;
      let part = 0;
      while (offset >= residueParts[part].length) offset -= residueParts[part++].length;
      warn(
        `invalid ${molecule === 'protein' ? 'amino-acid' : 'nucleotide'} character(s) in the sequence replaced by ` +
          `${placeholder}: ${describeInvalid(cleaned.invalid)}`,
        residueLines[part],
      );
    }
    if (fields.length !== undefined && fields.length !== seq.length) {
      warn(`LOCUS declares ${fields.length} ${unit} but the sequence has ${seq.length}; the sequence is used`, start + 1);
    }
  }

  const topology: Topology = fields.topology ?? 'linear';
  const features: Feature[] = [];
  for (const rf of rawFeatures) {
    const feature = buildFeature(rf, seq.length, topology, molecule, warn);
    if (feature !== null) features.push(feature);
  }

  const meta: RecordMeta = {};
  if (header.accession !== undefined) meta.accession = header.accession;
  if (header.version !== undefined) meta.version = header.version;
  if (header.keywords !== undefined) meta.keywords = header.keywords;
  if (header.source !== undefined) meta.source = header.source;
  if (header.organism !== undefined) meta.organism = header.organism;
  if (fields.date !== undefined) meta.date = normalizeGenbankDate(fields.date) ?? fields.date;
  if (fields.division !== undefined) meta.division = fields.division;
  if (header.comments.length > 0) meta.comments = header.comments;
  if (header.extraHeaderLines.length > 0) meta.extraHeaderLines = header.extraHeaderLines;
  meta.sourceFormat = 'genbank';
  const extras: Record<string, string> = {};
  if (fields.moleculeToken !== undefined) extras[GENBANK_EXTRA_KEYS.moleculeType] = fields.moleculeToken;
  if (header.taxonomy !== undefined) extras[GENBANK_EXTRA_KEYS.taxonomy] = header.taxonomy;
  if (contig !== undefined && contig !== '') extras[GENBANK_EXTRA_KEYS.contig] = contig;
  if (Object.keys(extras).length > 0) meta.extras = extras;

  return makeRecord({
    name: fields.name === '' ? undefined : fields.name,
    description: header.description,
    seq,
    topology,
    molecule,
    features,
    meta,
  });
}

/** Resolve a raw feature against the sequence; null (with a warning) when it cannot be placed. */
function buildFeature(raw: RawFeature, seqLength: number, topology: Topology, molecule: MoleculeType, warn: WarnFn): Feature | null {
  const location = parseLocation(raw.locationText, seqLength, topology);
  if (!location.ok) {
    warn(`feature '${raw.key}' skipped: ${location.error}`, raw.line);
    return null;
  }
  for (const w of location.warnings) warn(`feature '${raw.key}': ${w}`, raw.line);
  let strand = location.strand;
  if (molecule === 'protein') {
    if (strand === -1) warn(`feature '${raw.key}': complement() ignored on a protein record`, raw.line);
    strand = 0;
  }
  const colors = extractApeColors(raw.qualifiers, warn, raw.line);
  const feature: Feature = {
    id: newId('f'),
    type: raw.key,
    name: featureLabel(raw.key, colors.qualifiers),
    strand,
    segments: location.segments,
    qualifiers: colors.qualifiers,
  };
  if (colors.color !== undefined) feature.color = colors.color;
  if (colors.reverseColor !== undefined) feature.reverseColor = colors.reverseColor;
  if (location.partialStart) feature.partialStart = true;
  if (location.partialEnd) feature.partialEnd = true;
  return feature;
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * True when the sequence consists only of the letter the reader uses as placeholder for a
 * record without sequence data (N for nucleotides, X for proteins), or is empty: writing the
 * CONTIG section instead of it loses nothing, since reading it back gives the same placeholder.
 */
function isPlaceholderSequence(record: SeqRecord): boolean {
  return (record.molecule === 'protein' ? /^X*$/ : /^N*$/).test(record.seq);
}

/** LOCUS molecule token: the original one when it still matches the record's molecule type. */
function locusMoleculeToken(record: SeqRecord): string {
  if (record.molecule === 'protein') return '';
  const token = record.meta.extras?.[GENBANK_EXTRA_KEYS.moleculeType];
  if (token !== undefined && /^(?:(?:ss|ds|ms)-)?[A-Za-z]{1,7}$/.test(token) && moleculeTypeOfToken(token) === record.molecule) {
    return token;
  }
  return record.molecule;
}

/**
 * Write one record as a GenBank flat file ('\n' line endings, ends with '//\n').
 *
 * LOCUS in the standard columns (spaces in the name become '_'; length; bp or aa; molecule;
 * topology; division: the record's, else 'SYN'; date: the record's, else `options.date`, else
 * today). DEFINITION (with its final period), ACCESSION, VERSION, KEYWORDS, SOURCE, ORGANISM
 * ('.' when absent), the verbatim extra header blocks at their usual places, COMMENT blocks,
 * then FEATURES: locations from `formatLocation` wrapped after commas, qualifiers wrapped at
 * column 79 without breaking words, a /label carrying `feature.name` when it differs from the
 * label derived from the qualifiers, ApE colour qualifiers (see {@link GenbankWriteOptions}).
 * ORIGIN: 60 lower-case residues per line in blocks of 10. A record read from a CONTIG entry
 * (`GENBANK_EXTRA_KEYS.contig`) gets its CONTIG section back, wrapped after commas, instead of
 * an ORIGIN section while its sequence is only the N (protein: X) placeholder, as Biopython
 * writes it; before the ORIGIN section otherwise. Sticky ends (`record.ends`) and primers cannot
 * be represented in GenBank and are not written; features without segments are skipped.
 */
export function writeGenbank(record: SeqRecord, options: GenbankWriteOptions = {}): string {
  const length = record.seq.length;
  const protein = record.molecule === 'protein';
  const date =
    normalizeGenbankDate(record.meta.date ?? '') ??
    normalizeGenbankDate(options.date ?? '') ??
    formatGenbankDate(new Date());
  const out: string[] = [
    formatLocusLine({
      name: record.name,
      length,
      unit: protein ? 'aa' : 'bp',
      moleculeToken: locusMoleculeToken(record),
      topology: record.topology,
      division: locusDivision(record.meta),
      date,
    }),
  ];
  appendAll(out, formatHeader(record));
  out.push('FEATURES             Location/Qualifiers');
  const featureOptions = { colorQualifiers: options.colorQualifiers !== false, protein };
  for (const feature of record.features) appendAll(out, formatFeature(feature, length, record.topology, featureOptions));
  const contig = record.meta.extras?.[GENBANK_EXTRA_KEYS.contig]?.trim();
  if (contig) appendAll(out, formatContig(contig));
  if (!contig || !isPlaceholderSequence(record)) appendAll(out, formatOrigin(record.seq));
  out.push('//');
  return out.join('\n') + '\n';
}
