/**
 * The GenBank FEATURES table: reading feature blocks (key, location text, qualifiers) and
 * writing them back with INSDC wrapping rules.
 *
 * Layout (GenBank release notes 3.4.12; INSDC Feature Table Definition 4.3 "Data item positions"):
 * feature key in columns 6-20, location from column 22, qualifiers and continuation lines from
 * column 22; lines end at column 80 at most. This writer keeps lines within 79 columns.
 *
 * Qualifier reading follows Biopython 1.88 (`Bio.GenBank.Scanner.InsdcScanner.parse_feature`
 * and `_FeatureConsumer.feature_qualifier`), the oracle of the differential tests: lines are
 * stripped and joined with one space, except /translation whose whitespace is removed; a doubled
 * quote `""` inside a quoted value is an escaped `"`; a value-less qualifier (`/pseudo`) has the
 * value null; `/note=` (as written by ApE) is the empty string.
 */
import type { Feature, Qualifier, Strand, Topology } from '../types';
import { featureLabel } from '../seq/features';
import { normalizeColor } from './genbank-colors';
import { appendAll } from './genbank-text';
import { formatLocation } from './location';

/** Reports a problem at a 1-based line of the source text. */
export type WarnFn = (message: string, line?: number) => void;

/** A feature as read from the table, before its location is resolved against the sequence. */
export interface RawFeature {
  key: string;
  /** 1-based line number of the feature key line. */
  line: number;
  /** Location text with line breaks removed. */
  locationText: string;
  qualifiers: Qualifier[];
}

/** Column (0-based) where locations and qualifiers start. */
export const QUALIFIER_COLUMN = 21;
/** Longest line the writer produces in the feature table. */
export const FEATURE_LINE_WIDTH = 79;
const INDENT = ' '.repeat(QUALIFIER_COLUMN);
const TEXT_WIDTH = FEATURE_LINE_WIDTH - QUALIFIER_COLUMN;

/** Number of leading blanks of a line (leading tabs were expanded when the text was split). */
export function indentation(line: string): number {
  let n = 0;
  while (n < line.length && line.charCodeAt(n) === 32) n++;
  return n;
}

/** Feature key lines have their key in columns 6-20 (indentation 5); allow a little slack. */
const MAX_KEY_INDENT = 15;

/**
 * Read the feature table between `start` (first line after the FEATURES header) and `end`
 * (exclusive). Lines are already free of trailing blanks.
 */
export function readFeatureTable(lines: readonly string[], start: number, end: number, warn: WarnFn): RawFeature[] {
  const features: RawFeature[] = [];
  let key: string | null = null;
  let keyLine = 0;
  let body: BodyLine[] = [];
  const flush = () => {
    if (key !== null) features.push(buildRawFeature(key, keyLine, body, warn));
  };
  for (let i = start; i < end; i++) {
    const raw = lines[i];
    if (raw === '') continue;
    const indent = indentation(raw);
    const text = raw.slice(indent);
    if (indent > MAX_KEY_INDENT || text[0] === '/') {
      if (key === null) warn('text before the first feature key was ignored', i + 1);
      else body.push({ text, line: i + 1 });
      continue;
    }
    flush();
    const space = text.search(/\s/);
    key = space < 0 ? text : text.slice(0, space);
    keyLine = i + 1;
    const rest = space < 0 ? '' : text.slice(space).trim();
    body = rest === '' ? [] : [{ text: rest, line: i + 1 }];
  }
  flush();
  return features;
}

interface BodyLine {
  text: string;
  line: number;
}

/** Characters that can continue a location broken across lines (digits, range syntax). */
const LOCATION_CONTINUATION = /^[0-9<>.^,)(:]/;

/** Number of '(' minus number of ')'. */
function parenBalance(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 40) n++;
    else if (c === 41) n--;
  }
  return n;
}

function buildRawFeature(key: string, line: number, body: BodyLine[], warn: WarnFn): RawFeature {
  // The location continues while it is unfinished: empty, ending with a comma, unbalanced
  // parentheses, or followed by a line that can only be location text (a number broken
  // across lines, a closing parenthesis). Only the latest line is inspected and the lines are
  // joined once at the end: testing the growing concatenation after every line (`endsWith`)
  // flattens it each time, which made locations written over many lines quadratic to read.
  // Body lines are never empty and carry no trailing blanks, so the location ends with ','
  // exactly when its latest line does.
  let k = 0;
  const parts: string[] = [];
  let endsWithComma = false;
  let balance = 0;
  while (k < body.length && body[k].text[0] !== '/') {
    const next = body[k].text;
    const unfinished = parts.length === 0 || endsWithComma || balance > 0;
    if (!unfinished && !LOCATION_CONTINUATION.test(next)) break;
    parts.push(next);
    endsWithComma = next.endsWith(',');
    balance += parenBalance(next);
    k++;
  }
  const qualifierStart = k;
  while (k < body.length && body[k].text[0] !== '/') k++;
  if (k > qualifierStart) {
    warn(`unexpected text after the location of feature '${key}' was ignored`, body[qualifierStart].line);
  }
  return { key, line, locationText: parts.join('').replace(/\s+/g, ''), qualifiers: readQualifiers(body.slice(k), key, warn) };
}

interface RawQualifier {
  key: string;
  /** Lines of the value as written (first one starts after '='); null for value-less qualifiers. */
  parts: string[] | null;
  line: number;
}

function countQuotes(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 34) n++;
  return n;
}

/**
 * Assemble qualifiers from body lines that start at the first '/' line.
 * A quoted value continues until a line ends with a closing quote; an escaped quote `""` at a
 * line end does not close it (the total quote count must be even), except when the next line
 * starts a new qualifier (malformed escaping, read like Biopython). Lines that do not start
 * with '/' after a closed value are appended to it (Biopython's "unquoted continuation").
 */
function readQualifiers(lines: BodyLine[], featureKey: string, warn: WarnFn): Qualifier[] {
  const raws: RawQualifier[] = [];
  let i = 0;
  while (i < lines.length) {
    const { text, line } = lines[i];
    i++;
    if (text[0] !== '/') {
      const prev = raws[raws.length - 1];
      if (prev !== undefined && prev.parts !== null) prev.parts.push(text);
      else warn(`text '${text}' after a value-less qualifier of feature '${featureKey}' was ignored`, line);
      continue;
    }
    const eq = text.indexOf('=');
    if (eq < 0) {
      raws.push({ key: text.slice(1).trim(), parts: null, line });
      continue;
    }
    const key = text.slice(1, eq).trim();
    let value = text.slice(eq + 1);
    if (value.startsWith(' ') && value.trimStart().startsWith('"')) {
      warn(`white space after '=' in qualifier /${key}`, line);
      value = value.trimStart();
    }
    const parts = [value];
    if (value.startsWith('"')) {
      let quotes = countQuotes(value);
      for (;;) {
        const last = parts[parts.length - 1];
        const closed = last.endsWith('"') && quotes % 2 === 0 && !(parts.length === 1 && value === '"');
        if (closed) break;
        if (i >= lines.length) {
          if (!last.endsWith('"')) warn(`unterminated quoted value of qualifier /${key}`, line);
          break;
        }
        if (last.endsWith('"') && lines[i].text[0] === '/') break;
        parts.push(lines[i].text);
        quotes += countQuotes(lines[i].text);
        i++;
      }
    }
    raws.push({ key, parts, line });
  }
  return raws.map((r) => finishQualifier(r, warn));
}

/** Unquote and unescape one assembled qualifier (Biopython `feature_qualifier` semantics). */
function finishQualifier(raw: RawQualifier, warn: WarnFn): Qualifier {
  if (raw.parts === null) return { key: raw.key, value: null };
  let value = raw.parts.join(' ');
  if (value.length > 1 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
  if (/[^"]"[^"]|^"[^"]|[^"]"$/.test(value)) {
    warn(`double quote in /${raw.key} not escaped as "" (INSDC feature table 3.3.3)`, raw.line);
  }
  value = value.replaceAll('""', '"');
  if (raw.key === 'translation') value = value.replace(/\s+/g, '');
  return { key: raw.key, value };
}

// ---------------------------------------------------------------------------
// ApE colours
// ---------------------------------------------------------------------------

const APE_FWD = 'apeinfo_fwdcolor';
const APE_REV = 'apeinfo_revcolor';
const APE_FORMAT = 'apeinfo_graphicformat';

/** Feature colours read from ApE qualifiers, and the qualifiers that remain. */
export interface FeatureColors {
  qualifiers: Qualifier[];
  color?: string;
  reverseColor?: string;
}

/**
 * Consume `/ApEinfo_fwdcolor` and `/ApEinfo_revcolor` into `#rrggbb` colours and drop
 * `/ApEinfo_graphicformat` (ApE's arrow drawing style). Key matching ignores case. A colour that
 * cannot be understood stays in the qualifiers (with a warning) so nothing is lost. The reverse
 * colour is only kept when it differs from the forward colour (`Feature.reverseColor` is an override).
 */
export function extractApeColors(qualifiers: readonly Qualifier[], warn: WarnFn, line: number): FeatureColors {
  const kept: Qualifier[] = [];
  let color: string | undefined;
  let reverseColor: string | undefined;
  for (const q of qualifiers) {
    const key = q.key.toLowerCase();
    if (key === APE_FORMAT) continue;
    if (key === APE_FWD || key === APE_REV) {
      const c = q.value === null ? undefined : normalizeColor(q.value);
      if (c === undefined) {
        warn(`unrecognised colour in /${q.key}=${q.value ?? ''} kept as a qualifier`, line);
        kept.push(q);
      } else if (key === APE_FWD) color ??= c;
      else reverseColor ??= c;
      continue;
    }
    kept.push(q);
  }
  const out: FeatureColors = { qualifiers: kept };
  if (color !== undefined) out.color = color;
  if (reverseColor !== undefined && reverseColor !== color) out.reverseColor = reverseColor;
  return out;
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * Qualifiers written without quotes when their value is a single token: Biopython's
 * `_InsdcWriter.FTQUAL_NO_QUOTE` (value formats of INSDC Feature Table Definition Appendix III,
 * section 7.3: integers, enumerated values, citations, locations) plus ApE's colour qualifiers,
 * which ApE itself writes unquoted.
 */
const UNQUOTED_KEYS: ReadonlySet<string> = new Set([
  'anticodon',
  'citation',
  'codon_start',
  'compare',
  'direction',
  'estimated_length',
  'mod_base',
  'number',
  'rpt_type',
  'rpt_unit_range',
  'tag_peptide',
  'transl_except',
  'transl_table',
  'ApEinfo_fwdcolor',
  'ApEinfo_revcolor',
]);

/** Qualifiers whose continuation lines are joined without spaces by readers (Biopython: /translation). */
const JOINED_WITHOUT_SPACES: ReadonlySet<string> = new Set(['translation']);

/**
 * A space where a qualifier line may be broken. Readers strip each line and join lines with
 * exactly one space, so only a single space between two non-blank characters qualifies, and a
 * line must never start with '/' (it would read as a new qualifier). In `strict` mode the break
 * must also not touch a '"': Biopython and this reader handle such breaks correctly (escaped
 * pairs are never split), but simpler readers end a quoted value at the first line ending in '"'.
 */
function isBreakableSpace(s: string, j: number, strict: boolean): boolean {
  if (s.charCodeAt(j) !== 32 || j + 1 >= s.length) return false;
  const before = s[j - 1];
  const after = s[j + 1];
  if (!/\S/.test(before) || !/\S/.test(after) || after === '/') return false;
  return !strict || (before !== '"' && after !== '"');
}

/** Best break position for `rest`: a strict break within the width, a lenient one, or the first one after. */
function findBreak(rest: string, minimum: number): number {
  for (const strict of [true, false]) {
    for (let j = TEXT_WIDTH; j >= minimum; j--) if (isBreakableSpace(rest, j, strict)) return j;
  }
  // No space fits: overflow to the next usable space rather than split a word, because
  // readers would insert a space there and change the value.
  for (let j = TEXT_WIDTH + 1; j < rest.length; j++) if (isBreakableSpace(rest, j, false)) return j;
  return -1;
}

/**
 * Split `/key=value` text into lines of at most TEXT_WIDTH characters after the indent.
 * `prefix` is the length of `/key="` (no break right after the opening quote).
 */
function wrapQualifierText(text: string, prefix: number, breakAnywhere: boolean): string[] {
  const lines: string[] = [];
  let rest = text;
  let minimum = prefix + 1;
  while (rest.length > TEXT_WIDTH) {
    if (breakAnywhere) {
      lines.push(INDENT + rest.slice(0, TEXT_WIDTH));
      rest = rest.slice(TEXT_WIDTH);
      continue;
    }
    const cut = findBreak(rest, minimum);
    if (cut < 0) break;
    lines.push(INDENT + rest.slice(0, cut));
    rest = rest.slice(cut + 1);
    minimum = 1;
  }
  lines.push(INDENT + rest);
  return lines;
}

/**
 * Lines of one qualifier, indented to column 22 and wrapped within 79 columns.
 * Newlines inside the value become spaces (GenBank cannot represent them); inner double
 * quotes are escaped as `""`; null values give `/key`.
 */
export function formatQualifier(key: string, value: string | null): string[] {
  // INSDC qualifier names have no blanks; '=' would end the name early when read back.
  const k = key.trim().replace(/[\s=]+/g, '_');
  if (value === null) return [INDENT + '/' + k];
  const v = value.replace(/\r\n|\r|\n/g, ' ');
  if (UNQUOTED_KEYS.has(k) && /^[^\s"]+$/.test(v)) return wrapQualifierText(`/${k}=${v}`, k.length + 2, false);
  return wrapQualifierText(`/${k}="${v.replaceAll('"', '""')}"`, k.length + 3, JOINED_WITHOUT_SPACES.has(k));
}

/** Split a location after commas so that each line holds at most TEXT_WIDTH characters. */
export function wrapLocation(location: string): string[] {
  const lines: string[] = [];
  let rest = location;
  while (rest.length > TEXT_WIDTH) {
    let cut = rest.lastIndexOf(',', TEXT_WIDTH - 1);
    if (cut < 0) cut = rest.indexOf(','); // nothing fits: overflow up to the first comma
    if (cut < 0 || cut === rest.length - 1) break;
    lines.push(rest.slice(0, cut + 1));
    rest = rest.slice(cut + 1);
  }
  lines.push(rest);
  return lines;
}

/** Options of {@link formatFeature}. */
export interface FeatureWriteOptions {
  /** Write `color` / `reverseColor` as ApE qualifiers. */
  colorQualifiers: boolean;
  /** Protein records: locations are written without complement(). */
  protein: boolean;
}

/**
 * The qualifiers to write for a feature: its own qualifiers, a /label carrying `feature.name`
 * when the name would not otherwise be derived from them, and the ApE colour qualifiers.
 */
export function qualifiersForWrite(feature: Feature, colorQualifiers: boolean): Qualifier[] {
  const writeFwd = colorQualifiers && feature.color !== undefined;
  const revColor = feature.reverseColor ?? feature.color;
  const writeRev = colorQualifiers && revColor !== undefined;
  const qualifiers = feature.qualifiers.filter((q) => {
    const key = q.key.toLowerCase();
    if (!colorQualifiers) return key !== APE_FWD && key !== APE_REV && key !== APE_FORMAT;
    return !(key === APE_FWD && writeFwd) && !(key === APE_REV && writeRev);
  });
  const name = feature.name;
  if (name.trim() !== '' && name !== featureLabel(feature.type, qualifiers)) {
    const at = qualifiers.findIndex((q) => q.key === 'label');
    if (at >= 0) qualifiers[at] = { key: 'label', value: name };
    else qualifiers.unshift({ key: 'label', value: name });
  }
  if (colorQualifiers && feature.color !== undefined) qualifiers.push({ key: 'ApEinfo_fwdcolor', value: feature.color });
  if (colorQualifiers && revColor !== undefined) qualifiers.push({ key: 'ApEinfo_revcolor', value: revColor });
  return qualifiers;
}

/**
 * Feature-table lines for one feature (key line, location continuation lines, qualifiers).
 * Returns [] when the feature has no segments (nothing can be written).
 */
export function formatFeature(feature: Feature, seqLength: number, topology: Topology, options: FeatureWriteOptions): string[] {
  const strand: Strand = options.protein ? 0 : feature.strand;
  const location = formatLocation({ ...feature, strand }, seqLength, topology);
  if (location === '') return [];
  // A key must be one word and must not start with '/' (that would read as a qualifier line).
  const key = feature.type.trim().replace(/\s+/g, '_').replace(/^\/+/, '') || 'misc_feature';
  const locationLines = wrapLocation(location);
  const keyField = key.length < 16 ? `     ${key.padEnd(16)}` : `     ${key} `;
  const lines = [keyField + locationLines[0]];
  for (let k = 1; k < locationLines.length; k++) lines.push(INDENT + locationLines[k]);
  for (const q of qualifiersForWrite(feature, options.colorQualifiers)) appendAll(lines, formatQualifier(q.key, q.value));
  return lines;
}
