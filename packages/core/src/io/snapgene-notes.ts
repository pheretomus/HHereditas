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
 * Sources: fixtures; Biopython SnapGeneIO; autosnapgene NotesBlock (element names).
 */
import type { RecordMeta, SeqRecord } from '../types';
import { childElements, escapeXmlText, plainToRichText, richTextToPlain, textToHtmlDocument, xmlElement, type XmlElement } from './snapgene-markup';
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

/** Notes elements written explicitly by {@link buildNotesXml}, in SnapGene's order (fixtures). */
const KNOWN_ELEMENTS: ReadonlySet<string> = new Set([
  'UUID', 'Type', 'ConfirmedExperimentally', 'CustomMapLabel', 'UseCustomMapLabel', 'Description', 'Created', 'LastModified',
  'AccessionNumber', 'CodeNumber', 'CreatedBy', 'Organism', 'SequenceClass', 'TransformedInto', 'Comments',
]);

/** `meta.extras` keys that belong to other packets or are read-only summaries. */
const NOT_NOTES: ReadonlySet<string> = new Set([...Object.values(SnapGeneExtraKey), REFERENCES_EXTRA_KEY]);

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

function textElement(name: string, value: string, attributes: ReadonlyArray<readonly [string, string | undefined]> = []): string {
  return xmlElement(name, attributes, escapeXmlText(plainToRichText(value)));
}

function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.trim() !== '' ? value : undefined;
}

/**
 * Build the `<Notes>` packet text for a record. Created is kept from `meta.extras` when it is a
 * valid SnapGene date (otherwise `now`); LastModified is always `now` (UTC). Unknown
 * `meta.extras` fields are written back only for records read from SnapGene files.
 */
export function buildNotesXml(record: SeqRecord, now: Date): string {
  const meta = record.meta;
  const extras = meta.extras ?? {};
  const [today, timeOfDay] = snapGeneTimestamp(now);
  const division = meta.division?.trim().toUpperCase();
  const type = nonEmpty(extras.Type) ?? (division === undefined || division === '' || division === 'SYN' ? 'Synthetic' : 'Natural');
  const uuid = extras.UUID !== undefined && UUID_PATTERN.test(extras.UUID.trim())
    ? extras.UUID.trim()
    : deterministicUuid(`${record.seq.length}|${record.name}|${record.description}|${now.toISOString()}|${record.seq}`);
  const created = extras.Created !== undefined && SNAPGENE_DATE.test(extras.Created.trim()) ? extras.Created.trim() : undefined;
  const createdTime = created === undefined ? timeOfDay : SNAPGENE_TIME.test(extras['Created.UTC']?.trim() ?? '') ? extras['Created.UTC'].trim() : undefined;
  const comments = (meta.comments ?? []).filter((c) => c.trim() !== '').join('\n');

  const lines: string[] = [textElement('UUID', uuid), textElement('Type', type)];
  const confirmed = nonEmpty(extras.ConfirmedExperimentally) ?? (type === 'Synthetic' ? '0' : undefined);
  if (confirmed !== undefined) lines.push(textElement('ConfirmedExperimentally', confirmed));
  for (const name of ['CustomMapLabel', 'UseCustomMapLabel']) {
    const value = nonEmpty(extras[name]);
    if (value !== undefined) lines.push(textElement(name, value));
  }
  if (record.description.trim() !== '') lines.push(textElement('Description', record.description));
  lines.push(textElement('Created', created ?? today, [['UTC', createdTime]]));
  lines.push(textElement('LastModified', today, [['UTC', timeOfDay]]));
  const accession = nonEmpty(meta.accession);
  if (accession !== undefined) lines.push(textElement('AccessionNumber', accession));
  for (const name of ['CodeNumber', 'CreatedBy']) {
    const value = nonEmpty(extras[name]);
    if (value !== undefined) lines.push(textElement(name, value));
  }
  const organism = nonEmpty(meta.organism);
  if (organism !== undefined) lines.push(textElement('Organism', organism));
  const sequenceClass = nonEmpty(extras.SequenceClass) ?? (division !== undefined && /^[A-Z]{3}$/.test(division) && division !== 'SYN' ? division : 'UNA');
  lines.push(textElement('SequenceClass', sequenceClass));
  lines.push(textElement('TransformedInto', nonEmpty(extras.TransformedInto) ?? 'unspecified'));
  if (comments !== '') {
    // Line breaks only survive in SnapGene rich text, so multi-line comments are written as HTML.
    lines.push(xmlElement('Comments', [], escapeXmlText(comments.includes('\n') ? textToHtmlDocument(comments) : plainToRichText(comments))));
  }
  if (meta.sourceFormat === 'snapgene') for (const line of unknownNotesElements(extras)) lines.push(line);
  return `<Notes>\n${lines.join('\n')}\n</Notes>\n`;
}

/**
 * Simple Notes elements read from a SnapGene file that {@link buildNotesXml} does not write
 * explicitly, with their attributes (stored by {@link parseNotes} as 'Element.attribute' keys).
 * Attributes are grouped by element in one pass, so the time is linear in the number of extras.
 */
function unknownNotesElements(extras: Readonly<Record<string, string>>): string[] {
  const entries = Object.entries(extras);
  const attributes = new Map<string, Array<[string, string]>>();
  for (const [key, value] of entries) {
    const dot = key.indexOf('.');
    if (dot <= 0) continue;
    const attribute = key.slice(dot + 1);
    if (!XML_NAME.test(attribute)) continue;
    const element = key.slice(0, dot);
    const list = attributes.get(element);
    if (list === undefined) attributes.set(element, [[attribute, value]]);
    else list.push([attribute, value]);
  }
  const out: string[] = [];
  for (const [key, value] of entries) {
    if (KNOWN_ELEMENTS.has(key) || NOT_NOTES.has(key) || !XML_NAME.test(key) || /^xml/i.test(key)) continue;
    out.push(textElement(key, value, attributes.get(key) ?? []));
  }
  return out;
}
