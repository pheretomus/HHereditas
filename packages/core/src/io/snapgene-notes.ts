/**
 * SnapGene `<Notes>` XML (packet 0x06) <-> record description and metadata.
 *
 *   <Notes>
 *   <UUID>5ea05e55-2222-4f00-832b-9a9cbaa09de5</UUID>
 *   <Type>Natural</Type>
 *   <Description>&lt;html>&lt;body>Sample Sequence D&lt;/body>&lt;/html></Description>
 *   <Created UTC="12:1:19">2019.8.3</Created>
 *   <LastModified UTC="9:36:44">2021.7.7</LastModified>
 *   <SequenceClass>UNA</SequenceClass>
 *   ...
 *   </Notes>
 *
 * Mapping (several Notes packets are read as one, in file order; later fields win):
 * Description -> `record.description` (HTML removed, one line); Comments ->
 * `meta.comments` (line breaks kept, one entry per element); AccessionNumber -> `meta.accession`; Organism ->
 * `meta.organism`; every other element with plain content -> `meta.extras[element]`, and its
 * attributes -> `meta.extras['element.attribute']` (e.g. 'Created.UTC'); References -> a
 * readable summary in `meta.extras.References` (read only).
 * Derived: `meta.division` is 'SYN' for Type=Synthetic (as Biopython), else the SequenceClass
 * when it is a three-letter GenBank division code (SnapGene stores e.g. 'PHG' for phage T7);
 * `meta.date` is LastModified in GenBank form ('03-AUG-2019').
 * Writing is the reverse; `meta.division` decides Type and SequenceClass, and what a SnapGene file
 * cannot hold (GenBank VERSION / KEYWORDS / SOURCE and other header lines, the reference summary,
 * `meta.extras` fields without a place, field names the XML parser would alter) is reported.
 * Sources: fixtures; Biopython SnapGeneIO; autosnapgene NotesBlock (element names).
 */
import type { RecordMeta, SeqRecord } from '../types';
import type { ParseWarning } from './types';
import { childElements, escapeXmlText, plainToRichText, readsBackAsWritten, richTextToPlain, storeOneLine, textToHtmlDocument, xmlElement, type XmlElement } from './snapgene-markup';
import { clip, listQuoted } from './snapgene-messages';
import { SnapGeneExtraKey } from './snapgene-sequence';

/** What the Notes packets contribute to a record. */
export interface NotesContent {
  description: string;
  meta: Pick<RecordMeta, 'accession' | 'organism' | 'comments' | 'division' | 'date'>;
  extras: Record<string, string>;
}

/** `meta.extras` key of the readable reference summary (not written back). */
export const REFERENCES_EXTRA_KEY = 'References';

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

/** SnapGene date "2019.8.3" (year.month.day, no padding) as a GenBank date "03-AUG-2019"; undefined if malformed. */
export function snapGeneDateToGenBank(text: string): string | undefined {
  const match = /^\s*(\d{4})\.(\d{1,2})\.(\d{1,2})\s*$/.exec(text);
  if (match === null) return undefined;
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  return `${String(day).padStart(2, '0')}-${MONTHS[month - 1]}-${match[1]}`;
}

function withFinalPeriod(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

/** One line per `<Reference>`: "Authors. Title. Journal. PubMed n. doi:x". */
function summarizeReferences(element: XmlElement): string {
  const lines: string[] = [];
  for (const reference of childElements(element, 'Reference')) {
    const field = (name: string) => richTextToPlain(reference.attributes.get(name) ?? '', 'line');
    const parts = [field('authors'), field('title'), field('journal')].filter((p) => p !== '').map(withFinalPeriod);
    const pubMed = field('pubMedID');
    if (pubMed !== '') parts.push(`PubMed ${pubMed}.`);
    const doi = field('doi');
    if (doi !== '') parts.push(`doi:${doi}`);
    if (parts.length > 0) lines.push(parts.join(' '));
  }
  return lines.join('\n');
}

/**
 * Read the `<Notes>` elements of a file, in file order (see the file comment for the mapping).
 * A file with several Notes packets reads as if their fields were in one: a later field replaces
 * an earlier one with the same name (a Description, Organism, ... missing from a later packet
 * keeps the earlier value), comments accumulate, and division and date are derived from the
 * merged fields. Linear in the total number of fields.
 */
export function parseNotes(roots: readonly XmlElement[]): NotesContent {
  let description = '';
  const meta: NotesContent['meta'] = {};
  const comments: string[] = [];
  const extras: Record<string, string> = {};
  for (const root of roots) {
    for (const child of root.children) {
      switch (child.name) {
        case 'Description':
          description = richTextToPlain(child.text, 'line');
          break;
        case 'Comments': {
          const comment = richTextToPlain(child.text, 'block');
          if (comment !== '') comments.push(comment);
          break;
        }
        case 'AccessionNumber': {
          const accession = richTextToPlain(child.text, 'line');
          if (accession !== '') meta.accession = accession;
          break;
        }
        case 'Organism': {
          const organism = richTextToPlain(child.text, 'line');
          if (organism !== '') meta.organism = organism;
          break;
        }
        case REFERENCES_EXTRA_KEY: {
          const summary = summarizeReferences(child);
          if (summary !== '') extras[REFERENCES_EXTRA_KEY] = summary;
          break;
        }
        default: {
          if (child.children.length > 0) break; // structured element not modelled
          const value = richTextToPlain(child.text, 'line');
          if (value !== '') extras[child.name] = value;
          for (const [attribute, attributeValue] of child.attributes) extras[`${child.name}.${attribute}`] = attributeValue.trim();
        }
      }
    }
  }
  if (comments.length > 0) meta.comments = comments;
  if (extras.Type === 'Synthetic') meta.division = 'SYN';
  else if (extras.SequenceClass !== undefined && /^[A-Z]{3}$/.test(extras.SequenceClass)) meta.division = extras.SequenceClass;
  const date = extras.LastModified === undefined ? undefined : snapGeneDateToGenBank(extras.LastModified);
  if (date !== undefined) meta.date = date;
  return { description, meta, extras };
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

const UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const SNAPGENE_DATE = /^\d{4}\.\d{1,2}\.\d{1,2}$/;
const SNAPGENE_TIME = /^\d{1,2}:\d{1,2}:\d{1,2}$/;
const XML_NAME = /^[A-Za-z_][A-Za-z0-9_-]*$/;
/** A GenBank division code: three upper-case letters, e.g. SYN, BCT, PHG (NCBI GenBank release notes, gbrel.txt section 3.4.4.2). */
const DIVISION_CODE = /^[A-Z]{3}$/;

/**
 * Names that fast-xml-parser 5.11.2 (src/util.js) does not read back as written when they name an
 * element or an attribute: its `criticalProperties` make it reject the whole document ("[SECURITY]
 * Invalid name"), and its `DANGEROUS_PROPERTY_NAMES` are renamed to "__" + name by the default
 * `onDangerousProperty`. A test checks this list against the parser.
 */
const NAMES_THE_PARSER_ALTERS: ReadonlySet<string> = new Set([
  '__proto__', 'constructor', 'prototype',
  'hasOwnProperty', 'toString', 'valueOf', '__defineGetter__', '__defineSetter__', '__lookupGetter__', '__lookupSetter__',
]);

/**
 * True if `name` can be written as the name of a Notes element or attribute and reads back
 * unchanged: a simple XML name (ASCII letters, digits, '_' and '-'), not starting with "xml"
 * (reserved by XML 1.0) and not one that the XML parser rejects or renames.
 */
export function isStorableNotesName(name: string): boolean {
  return XML_NAME.test(name) && !/^xml/i.test(name) && !NAMES_THE_PARSER_ALTERS.has(name);
}

/** Notes elements written explicitly by {@link buildNotesXml}, in SnapGene's order (fixtures). */
const KNOWN_ELEMENTS: ReadonlySet<string> = new Set([
  'UUID', 'Type', 'ConfirmedExperimentally', 'CustomMapLabel', 'UseCustomMapLabel', 'Description', 'Created', 'LastModified',
  'AccessionNumber', 'CodeNumber', 'CreatedBy', 'Organism', 'SequenceClass', 'TransformedInto', 'Comments',
]);

/** `meta.extras` keys stored by the DNA and sequence-properties packets (see `snapgene-sequence.ts`). */
const OTHER_PACKET_KEYS: readonly string[] = Object.values(SnapGeneExtraKey);

/** 32-bit FNV-1a hash of a string's UTF-16 code units, with a seed mixed into the offset basis. */
function fnv1a(text: string, seed: number): number {
  let hash = (0x811c9dc5 ^ seed) >>> 0;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

/** A version-4-formatted UUID derived from `seed` (deterministic, so writes are reproducible). */
export function deterministicUuid(seed: string): string {
  const hex = [0x9e3779b9, 0x85ebca6b, 0xc2b2ae35, 0x27d4eb2f].map((s) => fnv1a(seed, s).toString(16).padStart(8, '0')).join('');
  const variant = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** SnapGene's date and time-of-day text for `now` in UTC: ["2019.8.3", "12:1:19"]. */
function snapGeneTimestamp(now: Date): [string, string] {
  return [
    `${now.getUTCFullYear()}.${now.getUTCMonth() + 1}.${now.getUTCDate()}`,
    `${now.getUTCHours()}:${now.getUTCMinutes()}:${now.getUTCSeconds()}`,
  ];
}

/**
 * A Notes element holding one-line text (see `storeOneLine`); `label` names the field in the
 * writer's warning about text that does not read back as written (collected in `changedText`).
 */
function textElement(
  name: string,
  value: string,
  label: string,
  changedText: string[],
  attributes: ReadonlyArray<readonly [string, string | undefined]> = [],
): string {
  return xmlElement(name, attributes, escapeXmlText(storeOneLine(value, label, changedText)));
}

function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.trim() !== '' ? value : undefined;
}

/**
 * A SnapGene field kept in `meta.extras`, trimmed, if it has the form SnapGene writes (`pattern`);
 * undefined when it is absent or blank, or - with a warning saying what was written `instead` - malformed.
 */
function wellFormedField(value: string | undefined, pattern: RegExp, name: string, instead: string, warnings: ParseWarning[]): string | undefined {
  const text = value?.trim();
  if (text === undefined || text === '') return undefined;
  if (pattern.test(text)) return text;
  warnings.push({ message: `The SnapGene field ${name} "${clip(text)}" (meta.extras) is malformed; ${instead}.` });
  return undefined;
}

/**
 * SnapGene's Type and SequenceClass for a record. The reader derives `meta.division` from them (Type
 * Synthetic gives SYN, else a three-letter SequenceClass is the division), so `meta.division` - what
 * the user sees and may have edited - wins over the values that `meta.extras` keeps from a SnapGene
 * file; those fill in the rest. A division that is not a three-letter code cannot be stored.
 */
function typeAndClass(division: string | undefined, storedType: string | undefined, storedClass: string | undefined, warnings: ParseWarning[]): { type: string; sequenceClass: string } {
  const code = division?.trim().toUpperCase() ?? '';
  if (code === '') return { type: storedType ?? 'Synthetic', sequenceClass: storedClass ?? 'UNA' };
  if (code === 'SYN') return { type: 'Synthetic', sequenceClass: storedClass ?? 'UNA' };
  if (DIVISION_CODE.test(code)) return { type: storedType !== undefined && storedType !== 'Synthetic' ? storedType : 'Natural', sequenceClass: code };
  warnings.push({ message: `The division "${clip(division?.trim() ?? '')}" is not a three-letter GenBank division code, so it was not written.` });
  return { type: storedType ?? 'Natural', sequenceClass: storedClass ?? 'UNA' };
}

/**
 * Build the `<Notes>` packet text for a record. `meta.division` gives Type and SequenceClass; Created
 * is kept from `meta.extras` when it is a valid SnapGene date (otherwise `now`); LastModified is
 * always `now` (UTC). Unknown `meta.extras` fields are written back only for records read from
 * SnapGene files. Everything of `record.meta` that the file cannot hold is reported in `warnings`:
 * GenBank-only header fields, `meta.extras` fields that no packet stores, the read-only reference
 * summary and malformed SnapGene fields (`meta.date` is not reported: LastModified is the save time).
 * Text fields whose line breaks or spacing will not read back (e.g. a multi-line comment with
 * indented lines, which is stored as HTML) are listed in `changedText`.
 */
export function buildNotesXml(record: SeqRecord, now: Date, warnings: ParseWarning[], changedText: string[] = []): string {
  const meta = record.meta;
  const extras = meta.extras ?? {};
  // The `meta.extras` keys written (or already reported); the others are reported at the end.
  const handled = new Set<string>(OTHER_PACKET_KEYS);
  const extra = (key: string): string | undefined => {
    if (!Object.hasOwn(extras, key)) return undefined;
    handled.add(key);
    return extras[key];
  };
  const [today, timeOfDay] = snapGeneTimestamp(now);
  const { type, sequenceClass } = typeAndClass(meta.division, nonEmpty(extra('Type'))?.trim(), nonEmpty(extra('SequenceClass'))?.trim(), warnings);
  const uuid =
    wellFormedField(extra('UUID'), UUID_PATTERN, 'UUID', 'a new UUID was written', warnings) ??
    deterministicUuid(`${record.seq.length}|${record.name}|${record.description}|${now.toISOString()}|${record.seq}`);
  const created = wellFormedField(extra('Created'), SNAPGENE_DATE, 'Created', 'the current date was written', warnings);
  const createdUtc = wellFormedField(extra('Created.UTC'), SNAPGENE_TIME, 'Created.UTC', created === undefined ? 'the current time was written' : 'it was not written', warnings);
  const createdTime = created === undefined ? timeOfDay : createdUtc;
  extra('LastModified'); // replaced by `now`, like LastModified.UTC
  extra('LastModified.UTC');
  const comments = (meta.comments ?? []).filter((c) => c.trim() !== '').join('\n');

  // One-line Notes fields; `label` names the field in the warning about text that does not read back as written.
  const field = (name: string, value: string, label = `meta.extras.${name}`, attributes: ReadonlyArray<readonly [string, string | undefined]> = []) =>
    textElement(name, value, label, changedText, attributes);
  const lines: string[] = [field('UUID', uuid), field('Type', type)];
  const confirmed = nonEmpty(extra('ConfirmedExperimentally')) ?? (type === 'Synthetic' ? '0' : undefined);
  if (confirmed !== undefined) lines.push(field('ConfirmedExperimentally', confirmed));
  for (const name of ['CustomMapLabel', 'UseCustomMapLabel']) {
    const value = nonEmpty(extra(name));
    if (value !== undefined) lines.push(field(name, value));
  }
  if (record.description.trim() !== '') lines.push(field('Description', record.description, 'the description'));
  lines.push(field('Created', created ?? today, undefined, [['UTC', createdTime]]));
  lines.push(field('LastModified', today, undefined, [['UTC', timeOfDay]]));
  const accession = nonEmpty(meta.accession);
  if (accession !== undefined) lines.push(field('AccessionNumber', accession, 'the accession number'));
  for (const name of ['CodeNumber', 'CreatedBy']) {
    const value = nonEmpty(extra(name));
    if (value !== undefined) lines.push(field(name, value));
  }
  const organism = nonEmpty(meta.organism);
  if (organism !== undefined) lines.push(field('Organism', organism, 'the organism'));
  lines.push(field('SequenceClass', sequenceClass));
  lines.push(field('TransformedInto', nonEmpty(extra('TransformedInto')) ?? 'unspecified'));
  if (comments !== '') {
    // Line breaks only survive in SnapGene rich text, so multi-line comments are written as HTML,
    // in which runs of blanks and indentation collapse (reported through `changedText`).
    const stored = comments.includes('\n') ? textToHtmlDocument(comments) : plainToRichText(comments);
    if (!readsBackAsWritten(comments, stored, 'block')) changedText.push('the comments');
    lines.push(xmlElement('Comments', [], escapeXmlText(stored)));
  }
  if (meta.sourceFormat === 'snapgene') for (const line of unknownNotesElements(extras, handled, warnings, changedText)) lines.push(line);
  reportUnwrittenMeta(meta, extras, handled, warnings);
  return `<Notes>\n${lines.join('\n')}\n</Notes>\n`;
}

/**
 * The simple Notes elements of a record read from a SnapGene file that {@link buildNotesXml} does not
 * write explicitly, with their attributes (stored by {@link parseNotes} as 'Element.attribute' keys).
 * Keys written are added to `handled`; fields whose names a SnapGene file cannot store (see
 * {@link isStorableNotesName}) are reported and added too. Attributes are grouped by element in one
 * pass, so the time is linear in the number of extras.
 */
function unknownNotesElements(extras: Readonly<Record<string, string>>, handled: Set<string>, warnings: ParseWarning[], changedText: string[]): string[] {
  const entries = Object.entries(extras);
  const attributes = new Map<string, Array<readonly [key: string, attribute: string, value: string]>>();
  for (const [key, value] of entries) {
    const dot = key.indexOf('.');
    if (dot <= 0) continue;
    const element = key.slice(0, dot);
    const entry = [key, key.slice(dot + 1), value] as const;
    const list = attributes.get(element);
    if (list === undefined) attributes.set(element, [entry]);
    else list.push(entry);
  }
  const unstorable: string[] = [];
  const out: string[] = [];
  for (const [key, value] of entries) {
    if (key.includes('.') || handled.has(key) || KNOWN_ELEMENTS.has(key) || key === REFERENCES_EXTRA_KEY) continue;
    handled.add(key);
    if (!isStorableNotesName(key)) {
      unstorable.push(key);
      continue;
    }
    const written: Array<readonly [string, string]> = [];
    for (const [attributeKey, attribute, attributeValue] of attributes.get(key) ?? []) {
      handled.add(attributeKey);
      if (isStorableNotesName(attribute)) written.push([attribute, attributeValue]);
      else unstorable.push(attributeKey);
    }
    out.push(textElement(key, value, `meta.extras.${clip(key)}`, changedText, written));
  }
  if (unstorable.length > 0) {
    warnings.push({ message: `${unstorable.length} SnapGene Notes field(s) of meta.extras were not written because a SnapGene file cannot store their names: ${listQuoted(unstorable)}.` });
  }
  return out;
}

/** The GenBank keyword that starts a header line ("REFERENCE", "DBLINK", ...); continuation lines start with blanks. */
const HEADER_KEYWORD = /^([A-Z][A-Z0-9_]*)(?=\s|$)/;

/**
 * Report what of `meta` no packet of the file holds: the GenBank VERSION, KEYWORDS and SOURCE, the
 * header lines kept verbatim from a GenBank file (REFERENCE, DBLINK, ...), the read-only reference
 * summary of a SnapGene file and every other `meta.extras` field not in `handled`.
 */
function reportUnwrittenMeta(meta: RecordMeta, extras: Readonly<Record<string, string>>, handled: ReadonlySet<string>, warnings: ParseWarning[]): void {
  const version = nonEmpty(meta.version)?.trim();
  if (version !== undefined) warnings.push({ message: `The sequence version "${clip(version)}" (GenBank VERSION) was not written: SnapGene files have no field for it.` });
  const keywords = nonEmpty(meta.keywords)?.trim();
  if (keywords !== undefined) warnings.push({ message: `The keywords "${clip(keywords)}" (GenBank KEYWORDS) were not written: SnapGene files have no field for them.` });
  const source = nonEmpty(meta.source)?.trim();
  if (source !== undefined) warnings.push({ message: `The source "${clip(source)}" (GenBank SOURCE) was not written: SnapGene files store only the organism.` });
  const headerLines = (meta.extraHeaderLines ?? []).filter((line) => line.trim() !== '');
  if (headerLines.length > 0) {
    const blocks = new Set<string>();
    for (const line of headerLines) {
      const keyword = HEADER_KEYWORD.exec(line)?.[1];
      if (keyword !== undefined) blocks.add(keyword);
    }
    const which = blocks.size > 0 ? ` (${listQuoted([...blocks])})` : '';
    warnings.push({ message: `${headerLines.length} GenBank header line(s)${which} were not written: SnapGene files cannot store them.` });
  }
  if (Object.hasOwn(extras, REFERENCES_EXTRA_KEY) && !handled.has(REFERENCES_EXTRA_KEY)) {
    warnings.push({ message: `The references (meta.extras.${REFERENCES_EXTRA_KEY}) were not written: only a text summary of them is kept, which a SnapGene file cannot store.` });
  }
  const unwritten = Object.keys(extras).filter((key) => !handled.has(key) && key !== REFERENCES_EXTRA_KEY);
  if (unwritten.length > 0) {
    warnings.push({ message: `${unwritten.length} field(s) of meta.extras were not written to the SnapGene file: ${listQuoted(unwritten)}.` });
  }
}
