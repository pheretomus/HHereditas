/**
 * SnapGene `.dna` files: reader and (experimental) writer.
 *
 * Format overview (reverse-engineered; see `snapgene-binary.ts` for sources): a sequence of
 * packets `[type][uint32 BE length][payload]`, starting with the cookie (0x09). HHereditas
 * reads the DNA packet (0x00: flags + bases), the features (0x0A), primers (0x05), notes (0x06)
 * and sequence properties (0x08, sticky ends) packets; everything else (history, enzyme
 * caches, alignments, traces, ...) is skipped silently.
 *
 * Coordinates follow types.ts: SnapGene's 1-based inclusive ranges become 0-based half-open
 * ranges; a range that wraps the origin of a circular sequence becomes one segment with
 * end > length. Strands: SnapGene directionality 1 -> 1, 2 -> -1, none/0/3 -> 0.
 *
 * Detailed field mappings: `snapgene-sequence.ts` (bases, flags, sticky ends),
 * `snapgene-features.ts`, `snapgene-primers.ts`, `snapgene-notes.ts`.
 *
 * Deliberate differences from Biopython's SnapGene reader (the test oracle):
 *  - an origin-wrapping range is one segment (Biopython: two location parts);
 *  - directionality absent/0/3 gives strand 0 (Biopython: +1);
 *  - HTML rich text is rendered (character references decoded, whitespace collapsed, block
 *    elements become spaces); plain values are kept verbatim even if they contain "<...>"
 *    (Biopython strips anything tag-like and decodes no references);
 *  - `<V text predef>` keeps the vocabulary prefix ("GI:238030067"; Biopython: "238030067");
 *  - /translation loses SnapGene's segment separators (",") and final "*", and SnapGene's "?" for
 *    a codon with ambiguous bases becomes the INSDC "X" (Biopython keeps all three);
 *  - repeated `<Q>` elements keep all values (Biopython keeps the last element);
 *    `<Q>` without `<V>` is a value-less qualifier and an empty `<V/>` an empty value;
 *  - SnapGene's readingFrame (the frame SnapGene translates a directional feature in) sets
 *    /codon_start: frames 2/3 add it, and a stale /codon_start that disagrees is replaced, with a
 *    warning (Biopython ignores readingFrame and keeps the qualifier);
 *  - the name becomes the first /label (Biopython adds /name when the labels differ);
 *  - description comes from Description (Biopython: Comments), division also from SequenceClass;
 *  - primers become `Primer` objects (Biopython: primer_bind features from binding sites).
 *
 * Robustness: the reader never throws on file data, and its processing is linear in the file
 * size (no quadratic rescans or merges; results are appended one by one, never spread into a
 * call, whose argument count engines cap; XML well-formedness is checked in linear time, see
 * `snapgene-markup.ts`); quoted file content in warnings is clipped (`snapgene-messages.ts`); XML
 * packets that are not valid UTF-8 are decoded with U+FFFD replacements and reported.
 *
 * Normalisations by the writer (what a write -> read round trip changes): ids are new; the
 * name comes from the file name; LastModified and primers' dateAdded are `now` (Created too,
 * unless the record keeps one from a SnapGene file);
 * features without colour get SnapGene's default colour for their type; qualifiers with the
 * same key are grouped; the first /label is made equal to the name; on directional features, a
 * /codon_start that is not one reading frame (1, 2 or 3) reads back as the written readingFrame
 * (with a warning); several comments become one; text loses blanks at either end and CR LF line
 * breaks become LF. Changed with one warning that lists the fields: line breaks in one-line fields
 * (names, descriptions, qualifier values) become spaces, and text stored as HTML (multi-line
 * comments, text that looks like markup) loses runs of spaces, tabs and indentation (see
 * `readsBackAsWritten` in `snapgene-markup.ts`). Dropped with a warning, which gives positions
 * 1-based: value-less qualifiers next to valued ones with the same key, fuzzy ends, reverse
 * colours, invalid or empty segments, sticky ends on circular records, the GenBank VERSION,
 * KEYWORDS, SOURCE and other header lines (REFERENCE, DBLINK, ...), the reference summary read
 * from a SnapGene file, and every other `meta.extras` field that no packet stores or whose name
 * cannot be stored (see `snapgene-notes.ts`).
 */
import { makeRecord } from '../seq/features';
import type { Feature, Primer, RecordMeta, SeqRecord } from '../types';
import type { ParseResult, ParseWarning } from './types';
import {
  COOKIE_PAYLOAD_LENGTH,
  SnapGenePacketType,
  SnapGeneSequenceType,
  decodeUtf8WithReplacements,
  encodeCookie,
  encodePackets,
  encodeUtf8,
  hasSnapGeneCookie,
  parseCookie,
  readPackets,
  type SnapGeneCookie,
  type SnapGenePacket,
} from './snapgene-binary';
import { buildFeaturesXml, parseFeatures } from './snapgene-features';
import { countXmlInvalidCharacters, parseXml, type XmlElement } from './snapgene-markup';
import { clip, listLabels } from './snapgene-messages';
import { buildNotesXml, parseNotes } from './snapgene-notes';
import { buildPrimersXml, parsePrimers } from './snapgene-primers';
import { buildSequencePropertiesXml, encodeDnaPacket, parseDnaPacket, parseSequenceProperties, type SequenceProperties } from './snapgene-sequence';
import { buildAlignedSequencePackets, parseSnapGeneAlignments } from './snapgene-alignments';

export { SnapGeneExtraKey } from './snapgene-sequence';
export { REFERENCES_EXTRA_KEY } from './snapgene-notes';

/** Options for {@link parseSnapGene}. */
export interface SnapGeneParseOptions {
  /**
   * Name (or path) of the file being read. SnapGene files do not store a sequence name, so
   * the record is named after the file: base name without extension ('Untitled' if absent).
   */
  fileName?: string;
}

/** Options for {@link writeSnapGene}. */
export interface SnapGeneWriteOptions {
  /**
   * Time stamp (written in UTC) used for LastModified, for primers' dateAdded and for Created
   * unless `meta.extras.Created` holds a SnapGene date; defaults to the current time.
   */
  now?: Date;
}

/** Result of {@link writeSnapGeneWithWarnings}. */
export interface SnapGeneWriteResult {
  /** The `.dna` file contents. */
  data: Uint8Array;
  /** Everything that could not be represented exactly in the SnapGene format. */
  warnings: ParseWarning[];
}

/**
 * Cookie written by {@link writeSnapGene}: DNA, export version 15, import version 19 - the
 * values in files written by SnapGene 6 to 8 (fixtures sample-f.dna, linebreak_in_qualifier_text.dna;
 * PlasmidPop reports the same cookie on all 203 files bundled with SnapGene 8.2).
 */
const WRITER_COOKIE: SnapGeneCookie = { sequenceType: SnapGeneSequenceType.Dna, exportVersion: 15, importVersion: 19 };

/** Constant packets present in every file written by recent SnapGene versions (fixtures). */
const ENZYME_VISIBILITIES_XML = '<?xml version="1.0"?><EnzymeVisibilities vals=""/>\n';
const CUSTOM_ENZYME_SETS_XML = '<?xml version="1.0"?><CustomEnzymeSets/>\n';

/**
 * True if `data` looks like a SnapGene file: it starts with the cookie packet (type 0x09 whose
 * payload begins with `SnapGene`). Only the first 13 bytes are inspected. SnapGene protein
 * (`.prot`) and RNA (`.rna`) files are recognised as well; {@link parseSnapGene} explains that
 * they cannot be opened.
 */
export function isSnapGeneFile(data: Uint8Array): boolean {
  return hasSnapGeneCookie(data);
}

/** Record name from a file name or path: base name without its last extension. */
function recordNameFromFile(fileName: string | undefined): string {
  if (fileName === undefined) return 'Untitled';
  const base = fileName.split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  const stem = (dot > 0 ? base.slice(0, dot) : base).trim();
  return stem !== '' ? stem : 'Untitled';
}

function hex(n: number): string {
  return `0x${n.toString(16).padStart(2, '0')}`;
}

/** Longest part of an XML parser error quoted in a warning (fast-xml-parser can quote the whole document). */
const MAX_PARSER_ERROR_LENGTH = 200;

/**
 * Decode (UTF-8) and parse an XML packet, checking its root element. Failures, and bytes that are
 * not valid UTF-8 (replaced by U+FFFD), become warnings.
 */
function readXmlPacket(packet: SnapGenePacket, rootName: string, what: string, warnings: ParseWarning[]): XmlElement | undefined {
  const where = `packet ${hex(packet.type)} at offset ${packet.offset}`;
  const { text, replacements } = decodeUtf8WithReplacements(packet.payload);
  if (replacements > 0) {
    warnings.push({ message: `The ${what} packet (${where}) is not valid UTF-8: ${replacements} invalid byte sequence(s) were replaced by U+FFFD.` });
  }
  const parsed = parseXml(text);
  if (!parsed.ok) {
    warnings.push({ message: `Could not read the ${what} of the SnapGene file (${where}: ${clip(parsed.error, MAX_PARSER_ERROR_LENGTH)}); they were not imported.` });
    return undefined;
  }
  if (parsed.root.name !== rootName) {
    warnings.push({ message: `Unexpected <${clip(parsed.root.name)}> element in the ${what} ${where} (expected <${rootName}>); not imported.` });
    return undefined;
  }
  return parsed.root;
}

function noRecord(warnings: readonly ParseWarning[], message: string): ParseResult {
  return { records: [], warnings: [...warnings, { message }] };
}

function readSnapGene(data: Uint8Array, options: SnapGeneParseOptions): ParseResult {
  if (!hasSnapGeneCookie(data)) return noRecord([], 'Not a SnapGene file: it does not start with the "SnapGene" cookie packet.');
  const scan = readPackets(data);
  const warnings: ParseWarning[] = [...scan.warnings];
  const first = scan.packets[0];
  const cookie = first?.type === SnapGenePacketType.Cookie ? parseCookie(first.payload) : undefined;
  if (first === undefined || cookie === undefined) return noRecord(warnings, 'The SnapGene file is truncated or damaged inside its cookie packet.');
  if (first.payload.length < COOKIE_PAYLOAD_LENGTH) {
    warnings.push({ message: `The SnapGene cookie packet is ${first.payload.length} bytes long instead of ${COOKIE_PAYLOAD_LENGTH}; its version fields are missing.` });
  }
  if (cookie.sequenceType === SnapGeneSequenceType.Protein) return noRecord(warnings, 'This is a SnapGene protein file (.prot); only SnapGene DNA files (.dna) can be read.');
  if (cookie.sequenceType === SnapGeneSequenceType.Rna) return noRecord(warnings, 'This is a SnapGene RNA file (.rna); only SnapGene DNA files (.dna) can be read.');

  const dnaPackets = scan.packets.filter((p) => p.type === SnapGenePacketType.Dna);
  if (dnaPackets.length === 0) {
    if (scan.truncated?.type === SnapGenePacketType.Dna) return noRecord(warnings, 'The SnapGene file ends inside its DNA sequence packet; the sequence is incomplete and was not read.');
    if (scan.packets.some((p) => p.type === SnapGenePacketType.CompressedDna)) {
      return noRecord(warnings, 'The SnapGene file stores its sequence in a compressed packet (0x01), which is not supported.');
    }
    return noRecord(warnings, 'The SnapGene file contains no DNA sequence packet.');
  }
  if (cookie.sequenceType !== SnapGeneSequenceType.Dna) {
    warnings.push({ message: `Unknown sequence type ${cookie.sequenceType} in the SnapGene cookie; the DNA packet was read anyway.` });
  }
  if (dnaPackets.length > 1) warnings.push({ message: `The SnapGene file contains ${dnaPackets.length} DNA sequence packets; only the first was read.` });
  const dna = parseDnaPacket(dnaPackets[0].payload, warnings);
  if (dna === undefined) return noRecord(warnings, 'The DNA sequence packet of the SnapGene file is empty (it lacks even its flags byte).');
  const seqLength = dna.seq.length;
  if (seqLength === 0) warnings.push({ message: 'The SnapGene file contains an empty DNA sequence.' });

  // Results are appended one by one (never `push(...list)`: a spread passes one argument per
  // element, and JavaScript engines cap the argument count - at 65 536 in JavaScriptCore).
  const features: Feature[] = [];
  const primers: Primer[] = [];
  const notesRoots: XmlElement[] = [];
  const alignableRoots: XmlElement[] = [];
  let properties: SequenceProperties | undefined;
  for (const packet of scan.packets) {
    if (packet.type === SnapGenePacketType.Features) {
      const root = readXmlPacket(packet, 'Features', 'features', warnings);
      if (root !== undefined) for (const feature of parseFeatures(root, seqLength, dna.topology, warnings)) features.push(feature);
    } else if (packet.type === SnapGenePacketType.Primers) {
      const root = readXmlPacket(packet, 'Primers', 'primers', warnings);
      if (root !== undefined) for (const primer of parsePrimers(root, warnings)) primers.push(primer);
    } else if (packet.type === SnapGenePacketType.Notes) {
      const root = readXmlPacket(packet, 'Notes', 'notes', warnings);
      if (root !== undefined) notesRoots.push(root);
    } else if (packet.type === SnapGenePacketType.SequenceProperties) {
      const root = readXmlPacket(packet, 'AdditionalSequenceProperties', 'sequence properties', warnings);
      if (root !== undefined) properties = parseSequenceProperties(root, seqLength, dna.topology, warnings);
    } else if (packet.type === SnapGenePacketType.AlignableSequences) {
      const root = readXmlPacket(packet, 'AlignableSequences', 'alignable sequences', warnings);
      if (root !== undefined) alignableRoots.push(root);
    }
  }

  const alignedSequences = parseSnapGeneAlignments(scan.packets, alignableRoots, dna.seq, dna.topology);

  const notes = parseNotes(notesRoots);
  const meta: RecordMeta = {
    ...notes.meta,
    sourceFormat: 'snapgene',
    extras: { ...notes.extras, ...dna.extras, ...(properties?.extras ?? {}) },
  };
  const record = makeRecord({
    name: recordNameFromFile(options.fileName),
    description: notes.description,
    seq: dna.seq,
    topology: dna.topology,
    molecule: 'DNA',
    features,
    primers,
    ...(alignedSequences.length > 0 ? { alignedSequences } : {}),
    ...(properties?.ends !== undefined ? { ends: properties.ends } : {}),
    meta,
  });
  return { records: [record], warnings };
}

/**
 * Read a SnapGene `.dna` file.
 *
 * Returns exactly one record, or no record plus a warning when the data is not a readable
 * SnapGene DNA file (not SnapGene at all, a protein/RNA file, no or truncated DNA packet).
 * Never throws: damaged packets, malformed XML and invalid coordinates are skipped with
 * warnings. The record follows types.ts: uppercase IUPAC sequence, 0-based half-open
 * ranges (origin-wrapping segments have end > length), strands 1/-1/0, `ends` set when the
 * file stores sticky ends, `meta.sourceFormat = 'snapgene'`; SnapGene-only properties
 * (strandedness, methylation, end modifications, notes fields) are kept in `meta.extras`.
 */
export function parseSnapGene(data: Uint8Array, options: SnapGeneParseOptions = {}): ParseResult {
  try {
    return readSnapGene(data, options);
  } catch (error) {
    // Defensive: no input should get here, but a reader must never throw on bad data.
    const detail = error instanceof Error ? error.message : String(error);
    return { records: [], warnings: [{ message: `Could not read the SnapGene file: unexpected error (${detail}).` }] };
  }
}

/** Total number of characters in the written text fields that XML 1.0 cannot represent. */
function countUnrepresentableCharacters(record: SeqRecord): number {
  let count = 0;
  const add = (text: string | null | undefined) => {
    if (text) count += countXmlInvalidCharacters(text);
  };
  add(record.description);
  add(record.meta.organism);
  add(record.meta.accession);
  for (const comment of record.meta.comments ?? []) add(comment);
  for (const [key, value] of Object.entries(record.meta.extras ?? {})) {
    add(key);
    add(value);
  }
  for (const f of record.features) {
    add(f.name);
    add(f.type);
    for (const q of f.qualifiers) {
      add(q.key);
      add(q.value);
    }
  }
  for (const p of record.primers) {
    add(p.name);
    add(p.description);
  }
  return count;
}

/**
 * EXPERIMENTAL. Write a DNA record as a SnapGene `.dna` file and report everything that could
 * not be represented exactly (see {@link writeSnapGene}).
 *
 * @throws Error if the record is not DNA, RangeError if `options.now` is an invalid date.
 */
export function writeSnapGeneWithWarnings(record: SeqRecord, options: SnapGeneWriteOptions = {}): SnapGeneWriteResult {
  if (record.molecule !== 'DNA') throw new Error(`writeSnapGene: only DNA records can be written as SnapGene .dna files (this record is ${record.molecule}).`);
  const now = options.now ?? new Date();
  if (Number.isNaN(now.getTime())) throw new RangeError('writeSnapGene: options.now is not a valid date.');
  const warnings: ParseWarning[] = [];
  const seqLength = record.seq.length;
  const text = (xml: string) => encodeUtf8(xml);

  // Text fields that will not read back as written (line breaks, spacing), for one warning at the end.
  const changedText: string[] = [];
  const dnaPayload = encodeDnaPacket(record.seq, record.topology, record.meta.extras, warnings);
  const propertiesXml = buildSequencePropertiesXml(record, warnings, changedText);
  const featuresXml = buildFeaturesXml(record.features, seqLength, record.topology, warnings, changedText);
  const primersXml = buildPrimersXml(record.primers, now, warnings, changedText);
  const notesXml = buildNotesXml(record, now, warnings, changedText);
  const unrepresentable = countUnrepresentableCharacters(record);
  if (unrepresentable > 0) {
    warnings.push({ message: `${unrepresentable} control character(s) that XML cannot represent were written as U+FFFD.` });
  }
  if (changedText.length > 0) {
    warnings.push({
      message:
        `${changedText.length} text value(s) lose line breaks or spacing in the SnapGene file: line breaks in one-line fields ` +
        `become spaces, and in text stored as HTML (multi-line comments, text that looks like markup) runs of spaces, tabs ` +
        `or non-breaking spaces become one space (${listLabels([...new Set(changedText)])}).`,
    });
  }

  // Packet order of files written by SnapGene (fixtures), without its enzyme caches (0x02, 0x03, 0x0D), which SnapGene rebuilds.
  const packets = [
    { type: SnapGenePacketType.Cookie, payload: encodeCookie(WRITER_COOKIE) },
    { type: SnapGenePacketType.Dna, payload: dnaPayload },
    ...buildAlignedSequencePackets(record.alignedSequences),
    { type: SnapGenePacketType.SequenceProperties, payload: text(propertiesXml) },
    ...(featuresXml !== undefined ? [{ type: SnapGenePacketType.Features, payload: text(featuresXml) }] : []),
    { type: SnapGenePacketType.Primers, payload: text(primersXml) },
    { type: SnapGenePacketType.Notes, payload: text(notesXml) },
    { type: SnapGenePacketType.EnzymeVisibilities, payload: text(ENZYME_VISIBILITIES_XML) },
    { type: SnapGenePacketType.CustomEnzymeSets, payload: text(CUSTOM_ENZYME_SETS_XML) },
  ];
  return { data: encodePackets(packets), warnings };
}

/**
 * EXPERIMENTAL. Write a DNA record as a SnapGene `.dna` file, mimicking the files SnapGene
 * itself writes (packet order, cookie, XML layout and attributes). Round trip:
 * `parseSnapGene(writeSnapGene(r))` gives back `r` up to regenerated ids, the record name
 * (SnapGene files store none; it comes from the file name), refreshed time stamps and the
 * normalisations listed in the module docs (e.g. a /label equal to each feature name, a
 * default colour for colourless features, qualifiers with the same key grouped together).
 *
 * Coordinates are expected in types.ts form; segments that are empty or out of range,
 * non-IUPAC bases (written as 'N'), sticky ends on circular records and other things SnapGene
 * cannot store are dropped or adjusted - use {@link writeSnapGeneWithWarnings} to get the list.
 *
 * @throws Error if the record is not DNA, RangeError if `options.now` is an invalid date.
 */
export function writeSnapGene(record: SeqRecord, options: SnapGeneWriteOptions = {}): Uint8Array {
  return writeSnapGeneWithWarnings(record, options).data;
}
